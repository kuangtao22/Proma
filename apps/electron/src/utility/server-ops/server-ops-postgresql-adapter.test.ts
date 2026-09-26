import { describe, expect, test } from 'bun:test'
import { Duplex, PassThrough } from 'node:stream'
import { Client } from 'pg'
import {
  closeServerOpsPostgresqlClient,
  configureServerOpsPostgresqlSession,
  createServerOpsPostgresqlClient,
  readServerOpsPostgresqlWithClient,
  sendServerOpsPostgresqlCancelRequest,
  SERVER_OPS_POSTGRESQL_STARTUP_STATEMENTS,
} from './server-ops-postgresql-adapter'

describe('PostgreSQL adapter 会话合同', () => {
  test('Given 未指定 database When 创建 client Then 使用 postgres 且 TLS verify 配置 hostname', () => {
    let received: Record<string, unknown> | undefined
    const client = createServerOpsPostgresqlClient({
      address: 'db.example.test', port: 5432, username: 'reader', password: 'secret',
      tlsMode: 'verify', tlsServerName: 'db.example.test', connectTimeoutMs: 15_000,
    }, (options) => {
      received = options
      return { query: async () => ({ rows: [] }), end: async () => undefined }
    })
    expect(client).toBeDefined()
    expect(received).toMatchObject({ database: 'postgres', port: 5432, user: 'reader', connectionTimeoutMillis: 15_000,
      ssl: { rejectUnauthorized: true, servername: 'db.example.test' } })
  })

  test('Given PG 环境变量已污染 When 构造真实 Client 参数 Then 显式配置不会继承环境', () => {
    const previous = {
      PGPASSWORD: process.env.PGPASSWORD,
      PGOPTIONS: process.env.PGOPTIONS,
      PGSSLNEGOTIATION: process.env.PGSSLNEGOTIATION,
      PGAPPNAME: process.env.PGAPPNAME,
      PGREPLICATION: process.env.PGREPLICATION,
    }
    process.env.PGPASSWORD = 'environment-secret'
    process.env.PGOPTIONS = '-c search_path=attacker'
    process.env.PGSSLNEGOTIATION = 'direct'
    process.env.PGAPPNAME = 'unexpected-app'
    process.env.PGREPLICATION = 'database'
    let realClient: Client | undefined
    try {
      createServerOpsPostgresqlClient({ address: '127.0.0.1', port: 5432, tlsMode: 'disabled', connectTimeoutMs: 15_000 }, (options) => {
        realClient = new Client(options)
        return { query: async () => ({ rows: [] }), end: async () => undefined }
      })
      const parameters = (realClient as unknown as { connectionParameters: Record<string, unknown> }).connectionParameters
      expect(typeof parameters.password).toBe('function')
      expect((parameters.password as () => string)()).toBe('')
      expect(parameters.options).toContain('default_transaction_read_only=on')
      expect(parameters.options).toContain('standard_conforming_strings=on')
      expect(parameters.sslnegotiation).toBe('postgres')
      expect(parameters.application_name).toBe('DutyDeck Server Ops')
      expect(parameters.client_encoding).toBe('UTF8')
      expect(parameters.replication).toBe('false')
      expect(parameters.ssl).toBe(false)
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test('Given 新建 client When 配置只读会话 Then 固定执行安全参数和 BEGIN READ ONLY', async () => {
    const statements: string[] = []
    await configureServerOpsPostgresqlSession({
      query: async (statement) => { statements.push(statement); return { rows: [] } },
      end: async () => undefined,
    })
    expect(statements).toEqual([...SERVER_OPS_POSTGRESQL_STARTUP_STATEMENTS])
    expect(statements).toContain('SET LOCAL standard_conforming_strings = on')
  })

  test('Given 读取完成 When 关闭 client Then rollback 失败也继续 end', async () => {
    const statements: string[] = []
    let ended = false
    await closeServerOpsPostgresqlClient({
      query: async (statement) => { statements.push(statement); if (statement === 'ROLLBACK') throw new Error('closed') ; return { rows: [] } },
      end: async () => { ended = true },
    })
    expect(statements).toEqual(['ROLLBACK'])
    expect(ended).toBe(true)
  })

  test('Given 已连接会话身份 When 发送取消 Then 写入标准 CancelRequest 并关闭独立通道', async () => {
    const channel = new PassThrough()
    const chunks: Buffer[] = []
    channel.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    await sendServerOpsPostgresqlCancelRequest(async () => channel, 1234, 5678)
    const packet = Buffer.concat(chunks)
    expect(packet.byteLength).toBe(16)
    expect(packet.readInt32BE(0)).toBe(16)
    expect(packet.readInt32BE(4)).toBe(80_877_102)
    expect(packet.readInt32BE(8)).toBe(1234)
    expect(packet.readInt32BE(12)).toBe(5678)
    expect(channel.destroyed).toBe(true)
  })

  test('Given 取消通道吞掉写回调 When 超过发送时限 Then 拒绝并销毁通道', async () => {
    const channel = new PassThrough({
      transform(_chunk, _encoding, _callback) {
        // 模拟 SSH 背压或半关闭：底层永远不确认本次写入。
      },
    })
    await expect(sendServerOpsPostgresqlCancelRequest(async () => channel, 1234, 5678, 10))
      .rejects.toThrow('SERVER_OPS_DATA_CANCEL_CHANNEL_TIMEOUT')
    expect(channel.destroyed).toBe(true)
  })

  test('Given SSH 通道在 end 后报告 destroyed When 取消发送完成 Then 仍显式调用协议关闭', async () => {
    let destroyCalls = 0
    /** 模拟 ssh2 Channel：end 后 destroyed=true，但仍需 destroy() 才发送 CHANNEL_CLOSE。 */
    const channel = {
      destroyed: true,
      once: () => channel,
      removeListener: () => channel,
      resume: () => channel,
      write: (_packet: Buffer, callback: (error?: Error | null) => void) => { callback() },
      end: (callback: () => void) => { callback() },
      destroy: () => { destroyCalls += 1; return channel },
    } as unknown as PassThrough
    await sendServerOpsPostgresqlCancelRequest(async () => channel, 1234, 5678, 10)
    expect(destroyCalls).toBe(1)
  })

  test('Given SSH 协议已关闭但可读 EOF 未消费 When 发送取消 Then 消费 EOF 并触发 close', async () => {
    /** 模拟 ssh2：协议 close 到达后，只有可读侧 end 已发出才对外发 close。 */
    class SshLikeCancelChannel extends Duplex {
      protocolDestroyCalls = 0

      override _read(): void {}

      override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        callback()
      }

      override destroy(): this {
        this.protocolDestroyCalls += 1
        queueMicrotask(() => {
          this.push(null)
          if (this.readableEnded) this.emit('close')
          else this.once('end', () => { this.emit('close') })
        })
        return this
      }
    }
    /** 捕获 close，验证 resume() 确实推进可读 EOF，而非只验证方法调用次数。 */
    const channel = new SshLikeCancelChannel()
    const closed = new Promise<void>((resolve) => { channel.once('close', resolve) })
    await sendServerOpsPostgresqlCancelRequest(async () => channel, 1234, 5678, 100)
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => { reject(new Error('TEST_SSH_CHANNEL_CLOSE_TIMEOUT')) }, 100).unref()
      }),
    ])
    expect(channel.readableEnded).toBe(true)
    expect(channel.protocolDestroyCalls).toBeGreaterThanOrEqual(1)
  })
})

describe('PostgreSQL 只读读取闭环', () => {
  test('Given 同库多 schema When 列表和预览 Then 返回 canonical 表身份并遮罩敏感列', async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = []
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values })
        if (text.includes('FROM pg_database')) return { rows: [{ name: 'app' }] }
        if (text.includes('JOIN pg_catalog.pg_attribute a')) {
          return { rows: [
            { name: 'id', column_type: 'bigint', nullable: false, primary_key: true, default_text: null, extra: '', comment: '' },
            { name: 'password_hash', column_type: 'text', nullable: false, primary_key: false, default_text: null, extra: '', comment: '' },
          ] }
        }
        if (text.includes('FROM pg_catalog.pg_namespace n') && text.includes('JOIN pg_catalog.pg_class c')) {
          return { rows: [{ schema_name: 'sales', table_name: 'orders', relation_kind: 'r', rows_estimate: '3', size_bytes: '2048', comment: '订单' }] }
        }
        if (text.includes('AS "__proma_digest_0"')) {
          return { rows: [
            { id: '1', __proma_digest_0: null, password_hash: 'secret' },
            { id: '2', __proma_digest_0: null, password_hash: 'secret2' },
          ], fields: [{ name: 'id' }, { name: '__proma_digest_0' }, { name: 'password_hash' }] }
        }
        return { rows: [] }
      },
      end: async () => undefined,
    }
    const listed = await readServerOpsPostgresqlWithClient(client, {
      mode: 'schema-tables', engine: 'postgresql', address: 'db', port: 5432, tlsMode: 'disabled', schemaDatabase: 'app',
    })
    expect(listed).toMatchObject({ database: 'app', databases: ['app'], tables: [{ name: '"sales"."orders"', type: 'table' }] })

    const rows = await readServerOpsPostgresqlWithClient(client, {
      mode: 'schema-rows', engine: 'postgresql', address: 'db', port: 5432, tlsMode: 'disabled', schemaDatabase: 'app',
      schemaTable: '"sales"."orders"', rowOffset: 0, rowLimit: 1,
    })
    expect(rows).toMatchObject({
      columns: ['id', 'password_hash'],
      rows: [['1', { kind: 'text', text: '[已遮罩]', truncated: true }]],
      hasMore: true,
      orderedByPrimaryKey: true,
    })
    expect(queries.some(({ text }) => text.includes('LIMIT 2 OFFSET 0'))).toBe(true)
  })

  test('Given emoji 预览与内部别名同名列 When 读取 Then UTF-16 合同仍有界且内部摘要不覆盖真实列', async () => {
    const digest = 'c'.repeat(64)
    const client = {
      query: async (text: string) => {
        if (text.includes('JOIN pg_catalog.pg_attribute a')) return { rows: [
          { name: '__proma_digest_0', column_type: 'text', nullable: false, primary_key: true, default_text: null, extra: '', comment: '', relation_kind: 'r' },
          { name: 'emoji', column_type: 'text', nullable: false, primary_key: false, default_text: null, extra: '', comment: '', relation_kind: 'r' },
        ] }
        if (text.startsWith('SELECT ') && text.includes('FROM "public"."messages"')) {
          const aliases = [...text.matchAll(/AS "(__proma_(?:digest|length)_\d+)"/gu)]
            .map((match) => match[1]!).filter((alias) => alias !== '__proma_digest_0')
          const row: Record<string, unknown> = { __proma_digest_0: 'real-value', emoji: '😀'.repeat(256) }
          for (const alias of aliases) row[alias] = alias.includes('length') ? '256' : digest
          return { rows: [row] }
        }
        return { rows: [] }
      },
      end: async () => undefined,
    }
    const result = await readServerOpsPostgresqlWithClient(client, {
      mode: 'schema-rows', engine: 'postgresql', address: 'db', port: 5432, tlsMode: 'disabled', schemaDatabase: 'app',
      schemaTable: '"public"."messages"', rowOffset: 0, rowLimit: 1,
    })
    expect(result).toMatchObject({ columns: ['__proma_digest_0', 'emoji'] })
    if (!('mode' in result) || result.mode !== 'schema-rows') throw new Error('TEST_RESULT_MODE_INVALID')
    expect(result.rows[0]?.[0]).toBe('real-value')
    expect(result.rows[0]?.[1]).toEqual({ kind: 'text', text: '😀'.repeat(128), truncated: true, sha256: digest })
  })

  test('Given SQL 流返回超大字段 When 消费首行 Then 立即拒绝且不累计原始值', async () => {
    let streamedSql = ''
    const client = {
      query: async (text: string) => text.includes('JOIN pg_catalog.pg_attribute a')
        ? { rows: [{ name: 'note', column_type: 'text', nullable: false, primary_key: false, default_text: null, extra: '', comment: '', relation_kind: 'r' }] }
        : text.includes('AS "__proma_metadata" LIMIT 0') ? { rows: [], fields: [{ name: 'note', dataTypeID: 25 }] } : { rows: [] },
      streamQuery: async (_text: string, onFields: (fields: readonly { name: string }[]) => void,
        onRow: (row: readonly unknown[]) => boolean) => {
        streamedSql = _text
        onFields([{ name: 'note' }])
        onRow([null, '1025'])
      },
      end: async () => undefined,
    }
    await expect(readServerOpsPostgresqlWithClient(client, {
      mode: 'sql-query', engine: 'postgresql', address: 'db', port: 5432, tlsMode: 'disabled', database: 'app',
      queryId: 'large-cell', sql: 'SELECT note FROM items', maxRows: 10,
    })).rejects.toThrow('SERVER_OPS_DATA_QUERY_COLUMN_TOO_LARGE')
    expect(streamedSql).toContain('CASE WHEN octet_length(convert_to(')
    expect(streamedSql).toContain('<= 1024')
  })

  test('Given statements 诊断 When 读取 Then 明确返回 unsupported 且不查询语句正文', async () => {
    const queries: string[] = []
    const result = await readServerOpsPostgresqlWithClient({
      query: async (text: string) => { queries.push(text); return { rows: [{ version: 'PostgreSQL 16.4' }] } },
      end: async () => undefined,
    }, {
      mode: 'diagnostics', engine: 'postgresql', address: 'db', port: 5432, tlsMode: 'disabled', diagnosticSection: 'statements',
    })
    expect(result).toMatchObject({ capability: 'unsupported', warnings: ['PostgreSQL 语句统计需要 pg_stat_statements，当前未自动启用'] })
    expect(queries.every((text) => !text.includes('pg_stat_statements'))).toBe(true)
  })
})
