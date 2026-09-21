import { describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'
import { connect as connectTcp, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { createServer as createMySqlServer } from 'mysql2'
import { createConnection as createMysqlClient } from 'mysql2/promise'
import { parseServerOpsDataSourceRowsResult } from '@proma/shared'
import type { ServerOpsDataRuntimeNonQueryInput } from './server-ops-data-runtime'
import {
  buildMySqlDatabaseTable,
  buildMySqlMetrics,
  buildMySqlProcessTable,
  buildMySqlReplicationMetric,
  buildMySqlStatementTable,
  buildMySqlStatusMap,
  buildRedisKeyspaceTable,
  buildRedisMetrics,
  buildRedisReplicationMetric,
  buildRedisSlowlogTable,
  classifyServerOpsDataError,
  parseRedisInfo,
  readMySqlWithConnection,
  resolveServerOpsMySqlHandshakeDatabase,
  runServerOpsDataRead,
} from './server-ops-data-runtime'

for (const engine of ['mysql', 'redis'] as const) {
  test(`Given ${engine} 通道回调尚未返回 When 撤销读取 Then 不等待回调且释放随后返回的通道`, async () => {
    /** 模拟尚未返回的 SSH 转发调用，验证撤销不依赖网络回调。 */
    const controller = new AbortController()
    /** 撤销之后才交付的通道。 */
    const channel = new PassThrough()
    /** 测试主动控制通道工厂何时返回。 */
    let deliverChannel!: (value: Duplex) => void
    /** 尚未完成的通道请求，随后交付时必须自行回收。 */
    const opening = new Promise<Duplex>((resolve) => { deliverChannel = resolve })
    /** 保留结果 Promise，以验证撤销先于通道返回完成。 */
    const reading = runServerOpsDataRead({
      mode: 'probe', engine, address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    }, () => opening, controller.signal)
    controller.abort()
    await expect(reading).rejects.toThrow('SERVER_OPS_DATA_CANCELLED')
    deliverChannel(channel)
    await Promise.resolve()
    await Promise.resolve()
    expect(channel.destroyed).toBe(true)
  })

  test(`Given ${engine} 请求已取消 When 开始连接 Then 不创建网络通道`, async () => {
    /** 预先撤销的读取不应消耗连接资源。 */
    const controller = new AbortController()
    controller.abort()
    /** 记录通道创建次数，防止取消后继续认证。 */
    let opened = 0
    await expect(runServerOpsDataRead({
      mode: 'probe', engine, address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    }, async () => {
      opened += 1
      throw new Error('CHANNEL_MUST_NOT_OPEN')
    }, controller.signal)).rejects.toThrow('SERVER_OPS_DATA_CANCELLED')
    expect(opened).toBe(0)
  })

  test(`Given ${engine} 正在等待通道 When 请求取消后通道迟到 Then 立即释放并终止读取`, async () => {
    /** 用可控的异步边界复现 SSH 转发回调晚于撤销的情况。 */
    const controller = new AbortController()
    /** 本次独占通道，在取消后返回时也必须被销毁。 */
    const channel = new PassThrough()
    /** 取消发生在创建通道的异步阶段，早于驱动发送认证。 */
    const reading = runServerOpsDataRead({
      mode: 'probe', engine, address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    }, async () => {
      controller.abort()
      return channel
    }, controller.signal)
    try {
      await expect(reading).rejects.toThrow('SERVER_OPS_DATA_CANCELLED')
      expect(channel.destroyed).toBe(true)
    } finally {
      channel.destroy()
    }
  })
}

test('Given SQLite 被误传入网络驱动 When 读取 Then 拒绝且不创建 Redis 通道', async () => {
  /** 模拟绕过 TypeScript 的非法内部调用，验证网络驱动仍会守住引擎边界。 */
  const input = { engine: 'sqlite', mode: 'probe', address: '127.0.0.1', port: 6379, tlsMode: 'disabled' } as unknown as ServerOpsDataRuntimeNonQueryInput
  let opened = false
  await expect(runServerOpsDataRead(input, async () => {
    opened = true
    throw new Error('TEST_CHANNEL_MUST_NOT_OPEN')
  })).rejects.toThrow('SERVER_OPS_DATA_QUERY_ENGINE_UNSUPPORTED')
  expect(opened).toBe(false)
})

/** 构造可按 SQL 返回 mysql2 `[rows, fields]` 的内存连接。 */
function createMySqlConnection(resolve: (sql: string, values: unknown[]) => unknown) {
  /** 记录实际执行的 SQL，验证诊断分区没有多发查询。 */
  const queries: Array<{ sql: string; values: unknown[] }> = []
  /** 单独记录服务端 prepared 调用，避免只检查 SQL 文本却漏掉 query 客户端插值。 */
  const executions: Array<{ sql: string; values: unknown[] }> = []
  return {
    queries,
    executions,
    connection: {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values })
        return resolve(sql, values)
      },
      execute: async (sql: string, values: unknown[] = []) => {
        executions.push({ sql, values })
        return resolve(sql, values)
      },
    },
  }
}

/** 行预览夹具模拟 TABLES LEFT JOIN COLUMNS 的真实字段、类型和估算回执。 */
function createPreviewColumns(table: string, names: string[], rowsEstimate: number | null = null, types: Record<string, string> = {}, primary: string[] = []): Record<string, unknown>[] {
  return names.map((name) => ({ table_name: table, name, data_type: types[name] ?? 'varchar', extra: '', rows_estimate: rowsEstimate,
    primary_seq: primary.includes(name) ? primary.indexOf(name) + 1 : null }))
}

/** 行 SQL 只识别已转义的目标表，不把 information_schema 元数据查询算作数据读取。 */
function isPreviewRowsSql(sql: string): boolean {
  return sql.startsWith('SELECT ') && sql.includes(' FROM `')
}

/** mysql2 实验性服务端连接在握手级回归中使用的窄接口。 */
interface MySqlFixtureConnection {
  sequenceId: number
  stream: Duplex
  on(event: 'query', listener: (sql: string) => void): void
  on(event: 'stmt_prepare', listener: (sql: string) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'close', listener: () => void): void
  serverHandshake(options: {
    protocolVersion: number
    serverVersion: string
    connectionId: number
    statusFlags: number
    characterSet: number
    capabilityFlags: number
    authPluginName: string
    authCallback: (auth: unknown, callback: (error?: Error, mysqlError?: { code: number; message: string }) => void) => void
  }): void
  writeColumns(columns: unknown[]): void
  writeTextRow(row: unknown[]): void
  writeEof(warnings?: number, statusFlags?: number): void
  writeError(error: { code: number; message: string }): void
}

/** mysql2 实验性服务端在测试里需要的监听与底层地址接口。 */
interface MySqlFixtureServer {
  listen(port: number, host: string, callback: () => void): void
  close(callback: () => void): void
  _server: { address: () => AddressInfo | string | null }
}

/** 构造 mysql2 文本结果需要的最小列元数据。 */
function createMySqlFixtureColumn(name: string): Record<string, unknown> {
  return {
    catalog: 'def', schema: 'information_schema', table: '', orgTable: '', name, orgName: name,
    characterSet: 45, columnLength: 4_096, columnType: 253, flags: 0, decimals: 0,
  }
}

/** 写入一组文本结果，并显式重置实验性 server 的 command sequence。 */
function writeMySqlFixtureResult(connection: MySqlFixtureConnection, names: string[], rows: unknown[][]): void {
  connection.sequenceId = 1
  connection.writeColumns(names.map(createMySqlFixtureColumn))
  for (const row of rows) connection.writeTextRow(row)
  connection.writeEof(0, 2)
  connection.sequenceId = 0
}

/** 写入无结果集 OK，供事务与 session 设置语句使用。 */
function writeMySqlFixtureOk(connection: MySqlFixtureConnection): void {
  connection.sequenceId = 1
  ;(connection as unknown as { writeOk: (options: { affectedRows: number }) => void }).writeOk({ affectedRows: 0 })
  connection.sequenceId = 0
}

/** 关闭握手级 MySQL fixture。 */
async function closeMySqlFixture(server: MySqlFixtureServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(resolve))
}

/** Redis 7 风格 INFO 样本。 */
const redisInfoText = [
  '# Server',
  'redis_version:7.2.4',
  'uptime_in_seconds:3600',
  '',
  '# Clients',
  'connected_clients:12',
  '',
  '# Memory',
  'used_memory:134217728',
  'maxmemory:1073741824',
  'mem_fragmentation_ratio:1.24',
  '',
  '# Stats',
  'instantaneous_ops_per_sec:250',
  'keyspace_hits:900',
  'keyspace_misses:100',
  'evicted_keys:3',
  '',
  '# Replication',
  'role:master',
  'connected_slaves:1',
  '',
  '# Keyspace',
  'db0:keys=120,expires=10,avg_ttl=60000',
].join('\n')

describe('数据服务 runtime 解析与指标构造', () => {
  test('Given SQL 查询 When 建立 MySQL 连接 Then 握手绑定明确授权的当前库', () => {
    expect(resolveServerOpsMySqlHandshakeDatabase({ mode: 'sql-query', database: 'app' })).toBe('app')
    expect(resolveServerOpsMySqlHandshakeDatabase({ mode: 'probe', database: 'configured' })).toBe('configured')
    expect(resolveServerOpsMySqlHandshakeDatabase({ mode: 'diagnostics', database: 'stale' })).toBeUndefined()
    expect(resolveServerOpsMySqlHandshakeDatabase({ mode: 'schema-tables', database: 'stale' })).toBeUndefined()
  })

  test('Given Redis INFO 文本 When 解析 Then 忽略分区标题并保留键值', () => {
    const info = parseRedisInfo(redisInfoText)
    expect(info.redis_version).toBe('7.2.4')
    expect(info.connected_clients).toBe('12')
    expect(Object.keys(info).some((key) => key.startsWith('#'))).toBe(false)
    expect(parseRedisInfo('')).toEqual({})
  })

  test('Given Redis INFO When 构造指标 Then 输出稳定标识与占比', () => {
    const info = parseRedisInfo(redisInfoText)
    const metrics = buildRedisMetrics(info)
    const memory = metrics.find((entry) => entry.id === 'used-memory')!
    expect(memory.value).toBe('128.0 MiB / 1.0 GiB')
    expect(memory.ratio).toBeCloseTo(0.125, 5)
    expect(metrics.find((entry) => entry.id === 'hit-rate')!.value).toBe('90.0%')
    expect(metrics.find((entry) => entry.id === 'replication')!.value).toBe('主节点')
    expect(metrics.find((entry) => entry.id === 'uptime')!.value).toBe('1 小时 0 分')
  })

  test('Given 未配置 maxmemory When 构造指标 Then 不虚构使用率', () => {
    const metrics = buildRedisMetrics({ used_memory: '1024' })
    const memory = metrics.find((entry) => entry.id === 'used-memory')!
    expect(memory.hint).toBe('未配置 maxmemory')
    expect(memory.ratio).toBeUndefined()
  })

  test('Given 从节点 INFO When 构造复制指标 Then 展示链路与偏移', () => {
    const metric = buildRedisReplicationMetric({
      role: 'slave', master_link_status: 'up', master_last_io_seconds_ago: '2', master_repl_offset: '1024',
    })!
    expect(metric.value).toBe('从节点')
    expect(metric.hint).toContain('链路 正常')
    expect(metric.hint).toContain('1,024')
    expect(buildRedisReplicationMetric({})).toBeUndefined()
  })

  test('Given keyspace 与慢日志 When 构造表格 Then 行宽一致且识别 Redis 7 客户端字段', () => {
    const info = parseRedisInfo(redisInfoText)
    const keyspace = buildRedisKeyspaceTable(info)
    expect(keyspace.rows).toEqual([['db0', '120', '10', '1 分 0 秒']])
    const slowlog = buildRedisSlowlogTable([
      [1, 1_700_000_000, 15_000, ['GET', 'user:1']],
      [2, 1_700_000_100, 2_000, ['SET', 'user:1', 'value'], '10.0.0.1:5000', 'app'],
      'not-a-row',
    ])
    expect(slowlog.columns).toHaveLength(5)
    expect(slowlog.rows).toHaveLength(3)
    expect(slowlog.rows.every((row) => row.length === slowlog.columns.length)).toBe(true)
    expect(slowlog.rows[0]![3]).toBe('GET user:1')
    expect(slowlog.rows[1]![4]).toBe('10.0.0.1:5000')
    expect(buildRedisSlowlogTable(Array.from({ length: 25 }, () => [1, 1, 1, ['GET']])).truncated).toBe(true)
  })

  test('Given MySQL 全局状态 When 构造指标 Then 只使用真实字段', () => {
    const status = buildMySqlStatusMap([
      { Variable_name: 'Uptime', Value: '7200' },
      { Variable_name: 'Threads_connected', Value: '42' },
      { Variable_name: 'Threads_running', Value: '3' },
      { Variable_name: 'Questions', Value: '72000' },
      { Variable_name: 'Slow_queries', Value: '7' },
      { Variable_name: 'Bytes_received', Value: '1048576' },
      { Variable_name: 'Bytes_sent', Value: '2097152' },
      { Variable_name: 'Aborted_connects', Value: '1' },
      'invalid-row',
    ])
    expect(status.Uptime).toBe('7200')
    const metrics = buildMySqlMetrics(status, 200)
    expect(metrics.find((entry) => entry.id === 'threads-connected')!.value).toBe('42 / 200')
    expect(metrics.find((entry) => entry.id === 'threads-connected')!.hint).toBe('运行中 3')
    expect(metrics.find((entry) => entry.id === 'query-rate')!.value).toBe('10.0 / 秒')
    expect(metrics.find((entry) => entry.id === 'network-traffic')!.hint).toBe('接收 1.0 MiB · 发送 2.0 MiB')
    expect(metrics.find((entry) => entry.id === 'uptime')!.value).toBe('2 小时 0 分')
  })

  test('Given 空状态 When 构造 MySQL 指标 Then 不输出任何指标卡', () => {
    expect(buildMySqlMetrics({})).toEqual([])
  })

  test('Given 复制状态两代字段名 When 构造指标 Then 都能识别', () => {
    const modern = buildMySqlReplicationMetric({ Replica_IO_Running: 'Yes', Replica_SQL_Running: 'Yes', Seconds_Behind_Source: 3 })!
    expect(modern.value).toBe('正常')
    expect(modern.hint).toBe('延迟 3 秒')
    const legacy = buildMySqlReplicationMetric({ Slave_IO_Running: 'No', Slave_SQL_Running: 'Yes', Seconds_Behind_Master: 12 })!
    expect(legacy.value).toBe('异常')
    expect(buildMySqlReplicationMetric(undefined)).toBeUndefined()
  })

  test('Given 元数据行集 When 构造表格 Then 单元格去除控制字符并保持有界', () => {
    const databases = buildMySqlDatabaseTable([{ schema_name: 'app\u0000', table_count: 3, size_bytes: 1048576 }])
    expect(databases.rows).toEqual([['app ', '3', '1.0 MiB']])
    const processes = buildMySqlProcessTable([{ id: 7, user: 'app', host: '10.0.0.1:5000', db: 'app', command: 'Query', time: 2, state: 'Sending data' }])
    expect(processes.rows[0]![0]).toBe('7')
    expect(processes.columns.map((column) => column.id)).toEqual(['id', 'user', 'host', 'db', 'command', 'time', 'state'])
    const statements = buildMySqlStatementTable([
      { schema_name: 'app', digest_text: 'SELECT * FROM t WHERE id = ?', exec_count: 4, avg_ms: 12.5, avg_rows: 1 },
      { schema_name: null, digest_text: 'SELECT 1', exec_count: 1, avg_ms: 1, avg_rows: 0 },
    ])
    expect(statements.columns[0]).toMatchObject({ id: 'database', label: '数据库' })
    expect(statements.rows[0]![0]).toBe('app')
    expect(statements.rows[0]![3]).toBe('12.5 ms')
    expect(statements.rows[1]![0]).toBe('未归属')
  })

  test('Given 超长文本 When 构造表格 Then 按共享合同上限裁剪', () => {
    const table = buildMySqlStatementTable([{ digest_text: 'x'.repeat(900), exec_count: 1, avg_ms: 1, avg_rows: 1 }])
    expect(table.rows[0]![0]!.length).toBeLessThanOrEqual(512)
  })

  test('Given 驱动错误 When 分类 Then 输出稳定能力状态', () => {
    expect(classifyServerOpsDataError({ code: 'ECONNREFUSED' }, 'redis').capability).toBe('unreachable')
    expect(classifyServerOpsDataError({ code: 'WRONGPASS' }, 'redis').capability).toBe('auth-failed')
    expect(classifyServerOpsDataError({ code: 'ER_ACCESS_DENIED_ERROR' }, 'mysql').capability).toBe('auth-failed')
    expect(classifyServerOpsDataError({ code: 'ER_TABLEACCESS_DENIED_ERROR' }, 'mysql').capability).toBe('permission-denied')
    expect(classifyServerOpsDataError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'mysql').capability).toBe('tls-failed')
    expect(classifyServerOpsDataError({ code: 'ETIMEDOUT' }, 'redis').capability).toBe('timeout')
    expect(classifyServerOpsDataError({ code: 'ER_NOT_SUPPORTED_AUTH_MODE' }, 'mysql').capability).toBe('unsupported')
    expect(classifyServerOpsDataError(new Error('something odd'), 'redis').capability).toBe('unreachable')
  })

  test('Given 隧道通道建立失败 When 读取 Then 返回不可用而不是抛出', async () => {
    const failingChannel = async (): Promise<never> => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' })
    }
    const redisResult = await runServerOpsDataRead({
      mode: 'probe', engine: 'redis', address: '127.0.0.1', port: 6379, tlsMode: 'disabled',
    }, failingChannel)
    expect(redisResult.capability).toBe('unreachable')
    /** 连接测试与诊断共享同一种结果形状：失败时只有能力状态与原因。 */
    expect('metrics' in redisResult ? redisResult.metrics : undefined).toEqual([])
    expect('tables' in redisResult ? redisResult.tables : undefined).toEqual([])
    expect(redisResult.warnings.length).toBeGreaterThan(0)
    const mysqlResult = await runServerOpsDataRead({
      mode: 'probe', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    }, failingChannel)
    expect(mysqlResult.capability).toBe('unreachable')
    expect('serverVersion' in mysqlResult ? mysqlResult.serverVersion : undefined).toBeUndefined()
  })

  test('Given 配置默认库已失效 When 真实 MySQL 握手 Then schema 与 diagnostics 不绑定库但 probe 保留完整配置', async () => {
    /** 每次握手实际携带的默认库；空串表示没有请求绑定库。 */
    const handshakeDatabases: string[] = []
    /** fixture 收到的查询，用于证明非 probe 模式完成握手并进入 information_schema。 */
    const queries: string[] = []
    /** mysql2 实验性服务端，用真实握手包验证 CONNECT_WITH_DB 语义。 */
    const server = createMySqlServer((connectionValue) => {
      /** 测试仅使用 mysql2 服务端的窄接口。 */
      const connection = connectionValue as unknown as MySqlFixtureConnection
      connection.on('error', () => undefined)
      connection.on('query', (sql) => {
        queries.push(sql)
        if (sql === 'SELECT VERSION() AS version') {
          writeMySqlFixtureResult(connection, ['version'], [['8.0.36-wire']])
          return
        }
        if (sql.includes('information_schema.SCHEMATA')) {
          writeMySqlFixtureResult(connection, ['name'], [['app']])
          return
        }
        if (sql === 'SHOW GLOBAL VARIABLES') {
          writeMySqlFixtureResult(connection, ['Variable_name', 'Value'], [['autocommit', 'ON']])
          return
        }
        connection.sequenceId = 1
        connection.writeError({ code: 1_064, message: `UNEXPECTED_QUERY:${sql}` })
        connection.sequenceId = 0
      })
      connection.serverHandshake({
        protocolVersion: 10,
        serverVersion: '8.0.36-wire',
        connectionId: handshakeDatabases.length + 1,
        statusFlags: 2,
        characterSet: 45,
        capabilityFlags: 1 | 4 | 8 | 512 | 8_192 | 32_768 | 524_288,
        authPluginName: 'mysql_native_password',
        authCallback: (auth, callback) => {
          /** mysql2 服务端解析出的握手默认库。 */
          const database = typeof auth === 'object' && auth !== null && 'database' in auth && typeof auth.database === 'string'
            ? auth.database
            : ''
          handshakeDatabases.push(database)
          if (database === 'deleted_default') {
            callback(undefined, { code: 1_049, message: 'Unknown database' })
            return
          }
          if (database === 'denied_app') {
            callback(undefined, { code: 1_044, message: 'Private access details' })
            return
          }
          callback()
        },
      })
    }) as unknown as MySqlFixtureServer
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    /** fixture 实际监听地址。 */
    const address = server._server.address()
    if (address === null || typeof address === 'string') throw new Error('TEST_MYSQL_FIXTURE_ADDRESS_MISSING')
    /** 每次读取建立一条真实 TCP stream 交给 mysql2 客户端。 */
    const createChannel = async (): Promise<Duplex> => await new Promise<Duplex>((resolve, reject) => {
      /** 当前真实 TCP socket。 */
      const socket = connectTcp({ host: '127.0.0.1', port: address.port })
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
    try {
      const schemaResult = await runServerOpsDataRead({
        mode: 'schema-tables', engine: 'mysql', address: '127.0.0.1', port: address.port,
        database: 'deleted_default', tlsMode: 'disabled',
      }, createChannel)
      expect(schemaResult).toMatchObject({ capability: 'available', mode: 'schema-tables', databases: ['app'] })

      const diagnosticsResult = await runServerOpsDataRead({
        mode: 'diagnostics', diagnosticSection: 'parameters', engine: 'mysql', address: '127.0.0.1', port: address.port,
        database: 'deleted_default', tlsMode: 'disabled',
      }, createChannel)
      expect(diagnosticsResult).toMatchObject({ capability: 'available', parameters: [{ name: 'autocommit', value: 'ON' }] })

      /** SQL 查询的权限错误可能发生在 execute 调用前的握手阶段，也必须使用同一稳定分类。 */
      const queryCountBeforeDeniedHandshake = queries.length
      await expect(runServerOpsDataRead({
        mode: 'sql-query', engine: 'mysql', address: '127.0.0.1', port: address.port,
        database: 'denied_app', username: 'reader', tlsMode: 'disabled',
        queryId: 'query-denied-handshake', sql: 'SELECT id FROM users', maxRows: 2,
      }, createChannel)).rejects.toThrow('SERVER_OPS_DATA_QUERY_PERMISSION_DENIED')
      expect(queries).toHaveLength(queryCountBeforeDeniedHandshake)

      const probeResult = await runServerOpsDataRead({
        mode: 'probe', engine: 'mysql', address: '127.0.0.1', port: address.port,
        database: 'deleted_default', tlsMode: 'disabled',
      }, createChannel)
      expect(probeResult.capability).toBe('unreachable')
      expect(handshakeDatabases).toEqual(['', '', 'denied_app', 'deleted_default'])
      expect(queries.filter((sql) => sql.includes('information_schema.SCHEMATA'))).toHaveLength(1)
      expect(queries).toContain('SHOW GLOBAL VARIABLES')
    } finally {
      await closeMySqlFixture(server)
    }
  })

  test('Given 真实 mysql2 core 查询 When 成功与取消 Then 握手库、流事件和 socket 销毁均生效', async () => {
    const handshakeDatabases: string[] = []
    /** 服务端真实收到的 SQL，用于证明 parser 拒绝早于第一次查询。 */
    const serverQueries: string[] = []
    const fixtureStreams = new Set<Duplex>()
    let connectionOrdinal = 0
    let resolveBlockedQuery!: () => void
    const blockedQueryStarted = new Promise<void>((resolve) => { resolveBlockedQuery = resolve })
    let resolveCancelledSocketClosed!: () => void
    const cancelledSocketClosed = new Promise<void>((resolve) => { resolveCancelledSocketClosed = resolve })
    let resolveProductionMetadata!: () => void
    const productionMetadataStarted = new Promise<void>((resolve) => { resolveProductionMetadata = resolve })
    let resolveProductionSocketClosed!: () => void
    const productionSocketClosed = new Promise<void>((resolve) => { resolveProductionSocketClosed = resolve })
    const server = createMySqlServer((connectionValue) => {
      const connection = connectionValue as unknown as MySqlFixtureConnection
      fixtureStreams.add(connection.stream)
      connectionOrdinal += 1
      const currentOrdinal = connectionOrdinal
      connection.on('error', () => undefined)
      connection.stream.once('close', () => {
        fixtureStreams.delete(connection.stream)
        if (currentOrdinal === 2) resolveCancelledSocketClosed()
        if (currentOrdinal === 4) resolveProductionSocketClosed()
      })
      connection.on('query', (sql) => {
        serverQueries.push(sql)
        if (sql === 'SELECT id FROM users' && currentOrdinal === 1) {
          writeMySqlFixtureResult(connection, ['id'], [[1], [2]])
          return
        }
        if (sql === 'SELECT id FROM users' && currentOrdinal === 2) resolveBlockedQuery()
        if (currentOrdinal >= 3 && sql === 'SELECT VERSION() AS version') {
          writeMySqlFixtureResult(connection, ['version'], [['8.0.36-wire']])
          return
        }
        if (currentOrdinal >= 3 && sql.includes('information_schema.TABLES')) {
          writeMySqlFixtureResult(connection, ['name', 'type'], [['users', 'BASE TABLE']])
          return
        }
        if (currentOrdinal === 4 && sql.includes('information_schema.COLUMNS')) {
          resolveProductionMetadata()
          return
        }
        if (currentOrdinal === 3 && sql.includes('information_schema.COLUMNS')) {
          writeMySqlFixtureResult(connection, ['name'], [['id']])
          return
        }
        if (currentOrdinal === 3 && (sql.startsWith('SET SESSION ') || sql === 'START TRANSACTION READ ONLY' || sql === 'ROLLBACK')) {
          writeMySqlFixtureOk(connection)
          return
        }
        if (currentOrdinal === 3 && sql.includes('SELECT `id` FROM `users`')) {
          connection.sequenceId = 1
          connection.writeColumns([
            { ...createMySqlFixtureColumn('id'), schema: 'app', table: 'users', orgTable: 'users', orgName: 'id', columnLength: 11 },
          ])
          connection.writeTextRow([1])
          connection.writeEof()
          connection.sequenceId = 0
        }
      })
      connection.on('stmt_prepare', (sql) => {
        if (currentOrdinal === 3 && sql.startsWith('SET SESSION ')) {
          writeMySqlFixtureOk(connection)
          return
        }
        connection.sequenceId = 1
        connection.writeError({ code: 1_064, message: 'UNEXPECTED_PREPARE' })
        connection.sequenceId = 0
      })
      connection.serverHandshake({
        protocolVersion: 10,
        serverVersion: '8.0.36-wire',
        connectionId: currentOrdinal,
        statusFlags: 2,
        characterSet: 45,
        capabilityFlags: 1 | 4 | 8 | 512 | 8_192 | 32_768 | 524_288,
        authPluginName: 'mysql_native_password',
        authCallback: (auth, callback) => {
          const database = typeof auth === 'object' && auth !== null && 'database' in auth && typeof auth.database === 'string'
            ? auth.database
            : ''
          handshakeDatabases.push(database)
          callback()
          /** mysql2 实验性 server 在 CONNECT_WITH_DB 成功后不会自动重置 command sequence。 */
          connection.sequenceId = 0
        },
      })
    }) as unknown as MySqlFixtureServer
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server._server.address()
    if (address === null || typeof address === 'string') throw new Error('TEST_MYSQL_FIXTURE_ADDRESS_MISSING')
    const createChannel = async (): Promise<Duplex> => await new Promise<Duplex>((resolve, reject) => {
      const socket = connectTcp({ host: '127.0.0.1', port: address.port })
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
    try {
      const successClient = await createMysqlClient({
        user: 'reader', database: 'app', stream: await createChannel(), connectTimeout: 2_000,
      })
      const successCore = successClient as unknown as {
        connection: { query: (options: unknown) => { on: (event: string, listener: (...values: unknown[]) => void) => unknown } }
      }
      const eventOrder: string[] = []
      const rows: unknown[] = []
      await new Promise<void>((resolve, reject) => {
        const command = successCore.connection.query({ sql: 'SELECT id FROM users', rowsAsArray: true })
        command.on('fields', () => { eventOrder.push('fields') })
        command.on('result', (row) => { eventOrder.push('result'); rows.push(row) })
        command.on('error', reject)
        command.on('end', () => { eventOrder.push('end'); resolve() })
      })
      successClient.destroy()
      expect(rows).toEqual([['1'], ['2']])
      expect(eventOrder).toEqual(['fields', 'result', 'result', 'end'])

      const cancelledClient = await createMysqlClient({
        user: 'reader', database: 'app', stream: await createChannel(), connectTimeout: 2_000,
      })
      const cancelledCore = cancelledClient as unknown as {
        connection: { query: (options: unknown) => { on: (event: string, listener: (...values: unknown[]) => void) => unknown } }
      }
      cancelledCore.connection.query({ sql: 'SELECT id FROM users', rowsAsArray: true })
        .on('error', () => undefined)
      await blockedQueryStarted
      cancelledClient.destroy()
      await cancelledSocketClosed

      const productionInput = {
        mode: 'sql-query' as const, engine: 'mysql' as const, address: '127.0.0.1', port: address.port,
        database: 'app', username: 'reader', tlsMode: 'disabled' as const,
        queryId: 'query-production', sql: 'SELECT id FROM users', maxRows: 2,
      }
      const productionResult = await runServerOpsDataRead(productionInput, createChannel)
      expect(productionResult).toMatchObject({ queryId: 'query-production', database: 'app', columns: ['id'], rows: [['1']] })

      const controller = new AbortController()
      const cancelledProduction = runServerOpsDataRead({ ...productionInput, queryId: 'query-production-cancel' }, createChannel, controller.signal)
      await productionMetadataStarted
      controller.abort()
      await expect(cancelledProduction).rejects.toThrow('SERVER_OPS_DATA_CANCELLED')
      await productionSocketClosed
      expect(handshakeDatabases).toEqual(['app', 'app', 'app', 'app'])

      /** parser 拒绝必须穿过 data runtime 保留具体稳定码，且不会向数据库发送首条查询。 */
      const queriesBeforeInvalidSql = serverQueries.length
      await expect(runServerOpsDataRead({
        ...productionInput,
        queryId: 'query-production-invalid',
        sql: 'DELETE FROM users',
      }, createChannel)).rejects.toThrow('SERVER_OPS_SQL_EXPECTED_SELECT')
      expect(serverQueries).toHaveLength(queriesBeforeInvalidSql)
      expect(handshakeDatabases.at(-1)).toBe('app')
    } finally {
      for (const stream of fixtureStreams) stream.destroy()
      await closeMySqlFixture(server)
    }
  })

  test('Given MySQL 分区诊断 When 请求不同 section Then 只执行该页查询', async () => {
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('VERSION()')) return [[{ version: '5.7.44' }], []]
      if (sql === 'SHOW GLOBAL VARIABLES') return [[{ Variable_name: 'autocommit', Value: 'ON' }], []]
      return [[], []]
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'diagnostics', diagnosticSection: 'parameters', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(fixture.queries.map((entry) => entry.sql)).toEqual(['SELECT VERSION() AS version', 'SHOW GLOBAL VARIABLES'])
    expect(result).toMatchObject({ parameters: [{ name: 'autocommit', value: 'ON', scope: 'global' }], parametersTruncated: false })

    for (const [section, expectedQuery] of [
      ['sessions', 'information_schema.PROCESSLIST'],
      ['statements', 'performance_schema.events_statements_summary_by_digest'],
    ] as const) {
      const sectionFixture = createMySqlConnection((sql) => sql.includes('VERSION()') ? [[{ version: '5.7.44' }], []] : [[], []])
      await readMySqlWithConnection(sectionFixture.connection, {
        mode: 'diagnostics', diagnosticSection: section, engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
      })
      expect(sectionFixture.queries).toHaveLength(2)
      expect(sectionFixture.queries[1]!.sql).toContain(expectedQuery)
    }

    const overviewFixture = createMySqlConnection((sql) => sql.includes('VERSION()') ? [[{ version: '5.7.44' }], []] : [[], []])
    await readMySqlWithConnection(overviewFixture.connection, {
      mode: 'diagnostics', diagnosticSection: 'overview', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    const overviewSql = overviewFixture.queries.map((entry) => entry.sql).join('\n')
    expect(overviewSql).toContain('SHOW GLOBAL STATUS')
    expect(overviewSql).toContain('information_schema.tables')
    expect(overviewSql).not.toContain('PROCESSLIST')
    expect(overviewSql).not.toContain('events_statements_summary_by_digest')
    expect(overviewSql).not.toContain('SHOW GLOBAL VARIABLES\n')
  })

  test('Given MySQL 会话与慢语句指定数据库 When 诊断 Then 在排序和上限前参数化筛选', async () => {
    for (const [section, expectedColumn] of [
      ['sessions', 'DB = ?'],
      ['statements', 'SCHEMA_NAME = ?'],
    ] as const) {
      const fixture = createMySqlConnection((sql) => sql.includes('VERSION()') ? [[{ version: '8.0.36' }], []] : [[], []])
      await readMySqlWithConnection(fixture.connection, {
        mode: 'diagnostics', diagnosticSection: section, diagnosticDatabase: ' app data ',
        engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
      })
      const query = fixture.queries[1]!
      expect(query.sql).toContain(expectedColumn)
      expect(query.sql.indexOf(expectedColumn)).toBeLessThan(query.sql.indexOf('ORDER BY'))
      expect(query.values).toEqual([' app data '])
    }

    const unfiltered = createMySqlConnection((sql) => sql.includes('VERSION()') ? [[{ version: '8.0.36' }], []] : [[], []])
    await readMySqlWithConnection(unfiltered.connection, {
      mode: 'diagnostics', diagnosticSection: 'sessions', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(unfiltered.queries[1]!.sql).not.toContain('DB = ?')
    expect(unfiltered.queries[1]!.values).toEqual([])
  })

  test('Given 当前诊断页权限不足 When 查询失败 Then 只在该页返回 warning', async () => {
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('VERSION()')) return [[{ version: '5.7.44' }], []]
      throw Object.assign(new Error('denied'), { code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR' })
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'diagnostics', diagnosticSection: 'parameters', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(result).toMatchObject({ capability: 'available', parameters: [], warnings: ['无法读取全局参数'] })
    expect(fixture.queries).toHaveLength(2)
  })

  test('Given 参数结果越界 When 构造诊断 Then 同时限制数量、单值和总字节预算', async () => {
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('VERSION()')) return [[{ version: '5.7.44' }], []]
      return [Array.from({ length: 1_100 }, (_, index) => ({ Variable_name: `p_${index}`, Value: '界'.repeat(2_000) })), []]
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'diagnostics', diagnosticSection: 'parameters', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    if (!('parameters' in result) || result.parameters === undefined) throw new Error('TEST_PARAMETERS_MISSING')
    expect(result.parameters.length).toBeLessThanOrEqual(1_000)
    expect(result.parameters.every((entry) => entry.value.length <= 1_024)).toBe(true)
    expect(result.parametersTruncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result.parameters), 'utf8')).toBeLessThanOrEqual(262_144)
  })

  test('Given 未指定库或默认库不可见 When 列目录 Then 只返回可见库且不擅选', async () => {
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('VERSION()')) return [[{ version: '8.0.36' }], []]
      if (sql.includes('information_schema.SCHEMATA')) return [[{ name: 'app' }], []]
      throw new Error(`UNEXPECTED_QUERY:${sql}`)
    })
    const noDatabase = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-tables', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(noDatabase).toMatchObject({ mode: 'schema-tables', databases: ['app'], tables: [] })

    const invisible = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-tables', schemaDatabase: 'secret', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(invisible).toMatchObject({ mode: 'schema-tables', databases: ['app'], tables: [], capability: 'available' })
    expect(invisible.warnings[0]).toContain('不可见')
  })

  test('Given 库表超过公开上限 When 列目录 Then limit 加一探测并返回截断标记', async () => {
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('VERSION()')) return [[{ version: '8.0.36' }], []]
      if (sql.includes('information_schema.SCHEMATA')) return [Array.from({ length: 201 }, (_, index) => ({ name: index === 0 ? 'app' : `db_${index}` })), []]
      if (sql.includes('information_schema.TABLES')) return [Array.from({ length: 501 }, (_, index) => ({
        name: `table_${index}`, table_type: index === 0 ? 'VIEW' : 'BASE TABLE',
      })), []]
      return [[], []]
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-tables', schemaDatabase: 'app', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(result).toMatchObject({ databasesTruncated: true, tablesTruncated: true })
    if (!('databases' in result) || !('tables' in result)) throw new Error('TEST_SCHEMA_TABLES_MISSING')
    expect(result.databases).toHaveLength(200)
    expect(result.tables).toHaveLength(500)
    expect(result.tables[0]).toMatchObject({ name: 'table_0', type: 'view' })
    expect(fixture.queries.some((entry) => entry.sql.endsWith('LIMIT 201'))).toBe(true)
    expect(fixture.queries.some((entry) => entry.sql.endsWith('LIMIT 501'))).toBe(true)
  })

  test('Given 目标库位于截断目录之外 When 列目录 Then 独立验证可见性并保留目标库', async () => {
    /** 前 201 个目录项不含目标库，模拟目标库排在公开窗口之后。 */
    const directoryRows = Array.from({ length: 201 }, (_, index) => ({ name: `db_${index}` }))
    const fixture = createMySqlConnection((sql, values) => {
      if (sql.includes('VERSION()')) return [[{ version: '8.0.36' }], []]
      if (sql.includes('SCHEMA_NAME = ?')) {
        expect(values).toEqual(['target_db'])
        return [[{ name: 'target_db' }], []]
      }
      if (sql.includes('information_schema.SCHEMATA')) return [directoryRows, []]
      if (sql.includes('ORDER BY TABLE_NAME LIMIT 501')) return [[{ name: 'users', table_type: 'BASE TABLE' }], []]
      throw new Error(`UNEXPECTED_QUERY:${sql}`)
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-tables', schemaDatabase: 'target_db', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(result).toMatchObject({ database: 'target_db', databasesTruncated: true, tables: [{ name: 'users' }] })
    if (!('databases' in result)) throw new Error('TEST_SCHEMA_TABLES_MISSING')
    expect(result.databases).toHaveLength(200)
    expect(result.databases.at(-1)).toBe('target_db')
  })

  test('Given 截断目录外目标库不可见 When 列目录 Then 精确查询不得伪装为可见', async () => {
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('VERSION()')) return [[{ version: '8.0.36' }], []]
      if (sql.includes('SCHEMA_NAME = ?')) return [[], []]
      if (sql.includes('information_schema.SCHEMATA')) {
        return [Array.from({ length: 201 }, (_, index) => ({ name: `db_${index}` })), []]
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`)
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-tables', schemaDatabase: 'hidden_db', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(result).toMatchObject({ databasesTruncated: true, tables: [], capability: 'available' })
    expect('database' in result).toBe(false)
    expect(result.warnings[0]).toContain('不可见')
  })

  test('Given 空表与混合单元格 When 读取分页 Then fields 保留列头并精确区分值类型', async () => {
    const fixture = createMySqlConnection((sql, values) => {
      if (sql.includes('information_schema.TABLES AS t')) return [createPreviewColumns('odd`table', ['id`part', 'empty', 'nullable', 'payload', 'note'], null, { 'id`part': 'int', payload: 'blob' }, ['id`part']), []]
      if (isPreviewRowsSql(sql)) {
        expect(sql).toContain('OCTET_LENGTH(`payload`) AS `payload`')
        expect(sql).toContain('LEFT(`note`, 257) AS `note`')
        expect(sql).toContain('`db``name`.`odd``table` ORDER BY `id``part`')
        expect(sql).toContain('LIMIT 3 OFFSET 0')
        expect(values).toEqual([])
        return [[
          { 'id`part': 1, empty: '', nullable: null, payload: 2, note: 'x'.repeat(257) },
          { 'id`part': 2, empty: '', nullable: null, payload: 0, note: 'ok' },
          { 'id`part': 3, empty: '', nullable: null, payload: 1, note: 'more' },
        ], [{ name: 'id`part' }, { name: 'empty' }, { name: 'nullable' }, { name: 'payload' }, { name: 'note' }]]
      }
      return [[], []]
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-rows', schemaDatabase: 'db`name', schemaTable: 'odd`table', rowOffset: 0, rowLimit: 2,
      engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(result).toMatchObject({
      columns: ['id`part', 'empty', 'nullable', 'payload', 'note'],
      rows: [[
        '1', '', null, { kind: 'binary', bytes: 2 }, { kind: 'text', text: 'x'.repeat(256), truncated: true },
      ], ['2', '', null, { kind: 'binary', bytes: 0 }, 'ok']],
      hasMore: true,
      orderedByPrimaryKey: true,
      truncated: true,
    })
    expect('totalEstimate' in result).toBe(false)
  })

  test('Given 多条件与字面通配符 When MySQL 预览 Then 实时列白名单、参数绑定且不查询全表估算', async () => {
    const fixture = createMySqlConnection((sql, values) => {
      if (sql.includes('information_schema.TABLES AS t')) return [createPreviewColumns('orders', ['id', 'label', 'price'], 120, { id: 'int', price: 'decimal' }, ['id']), []]
      if (isPreviewRowsSql(sql)) {
        expect(sql).toContain("WHERE (`label` LIKE ? ESCAPE '!' AND `price` >= ?) ORDER BY `id` LIMIT 2 OFFSET 1")
        expect(values).toEqual(["%a!%!_!!' OR 1=1%", '20'])
        return [[{ id: 2, label: "a%_!' OR 1=1", price: 20 }, { id: 3, label: 'next', price: 40 }],
          [{ name: 'id' }, { name: 'label' }, { name: 'price' }]]
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`)
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-rows', schemaDatabase: 'app', schemaTable: 'orders', rowOffset: 1, rowLimit: 1,
      rowFilters: { match: 'all', conditions: [
        { column: 'label', operator: 'contains', value: "a%_!' OR 1=1" },
        { column: 'price', operator: 'gte', value: '20' },
      ] },
      engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(result).toMatchObject({ rows: [['2', "a%_!' OR 1=1", '20']], hasMore: true, orderedByPrimaryKey: true })
    expect('totalEstimate' in result).toBe(false)
    expect(fixture.queries).toEqual([])
    expect(fixture.executions).toEqual([
      expect.objectContaining({ sql: expect.stringContaining('information_schema.TABLES AS t'), values: ['app', 'orders'] }),
      expect.objectContaining({ sql: expect.stringContaining(' FROM `app`.`orders`'), values: ["%a!%!_!!' OR 1=1%", '20'] }),
    ])
  })

  test('Given 字段不在真实表或属于敏感列 When MySQL 筛选 Then 查询前拒绝', async () => {
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('information_schema.TABLES AS t')) return [createPreviewColumns('users', ['id', 'authorization']), []]
      throw new Error(`UNEXPECTED_QUERY:${sql}`)
    })
    for (const column of ['unknown', 'authorization']) {
      await expect(readMySqlWithConnection(fixture.connection, {
        mode: 'schema-rows', schemaDatabase: 'app', schemaTable: 'users', rowOffset: 0, rowLimit: 10,
        rowFilters: { match: 'all', conditions: [{ column, operator: 'eq', value: 'secret' }] },
        engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
      })).rejects.toThrow('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
    }
    expect(fixture.queries).toEqual([])
    expect(fixture.executions.some((item) => isPreviewRowsSql(item.sql))).toBe(false)
  })

  test('Given MySQL 驱动缺少 execute When 请求筛选 Then 不退回 query 的客户端插值', async () => {
    /** mock 只实现 query，记录筛选请求绝不以用户值访问它。 */
    const queries: Array<{ sql: string; values: unknown[] }> = []
    await expect(readMySqlWithConnection({ query: async (sql, values = []) => {
      queries.push({ sql, values })
      return [[{ version: '8.0.36' }], []]
    } }, {
      mode: 'schema-rows', schemaDatabase: "app' OR 1=1", schemaTable: 'users', rowOffset: 0, rowLimit: 10,
      rowFilters: { match: 'all', conditions: [{ column: 'name', operator: 'eq', value: "' OR 1=1 --" }] },
      engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })).rejects.toThrow('SERVER_OPS_DATA_SCHEMA_FILTERS_UNAVAILABLE')
    expect(queries).toEqual([])
  })

  test('Given 空表 When 读取分页 Then mysql2 fields 仍返回列头', async () => {
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('information_schema.TABLES AS t')) return [createPreviewColumns('empty_table', ['id', 'note'], 0), []]
      if (isPreviewRowsSql(sql)) return [[], [{ name: 'id' }, { name: 'note' }]]
      return [[], []]
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-rows', schemaDatabase: 'app', schemaTable: 'empty_table', rowOffset: 0, rowLimit: 50,
      engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(result).toMatchObject({ columns: ['id', 'note'], rows: [], hasMore: false, orderedByPrimaryKey: false })
  })

  test('Given 九列复合主键 When 读取分页 Then 使用完整主键排序并声明稳定顺序', async () => {
    /** 九列用于覆盖旧实现只取前八列的非唯一排序缺口。 */
    const primary = Array.from({ length: 9 }, (_, index) => `key_${index + 1}`)
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('information_schema.TABLES AS t')) return [createPreviewColumns('compound', primary, 1, {}, primary), []]
      if (isPreviewRowsSql(sql)) {
        expect(sql).toContain('ORDER BY `key_1`, `key_2`, `key_3`, `key_4`, `key_5`, `key_6`, `key_7`, `key_8`, `key_9`')
        return [[Object.fromEntries(primary.map((name, index) => [name, index + 1]))], primary.map((name) => ({ name }))]
      }
      return [[], []]
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-rows', schemaDatabase: 'app', schemaTable: 'compound', rowOffset: 0, rowLimit: 20,
      engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(result).toMatchObject({ orderedByPrimaryKey: true })
  })

  test('Given 主键列超过安全上限 When 读取分页 Then 不使用不完整排序也不声明稳定顺序', async () => {
    /** 十七列超过公开索引合同的 16 列上限，必须整体放弃主键排序。 */
    const primary = Array.from({ length: 17 }, (_, index) => `key_${index + 1}`)
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('information_schema.TABLES AS t')) return [createPreviewColumns('compound', primary, 1, {}, primary), []]
      if (isPreviewRowsSql(sql)) {
        expect(sql).not.toContain('ORDER BY')
        return [[Object.fromEntries(primary.map((name, index) => [name, index + 1]))], primary.map((name) => ({ name }))]
      }
      return [[], []]
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-rows', schemaDatabase: 'app', schemaTable: 'compound', rowOffset: 0, rowLimit: 20,
      engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(result).toMatchObject({ orderedByPrimaryKey: false })
  })

  test('Given 列默认值为空串 When 读取结构 Then 保留空串而不是当成缺失', async () => {
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('VERSION()')) return [[{ version: '8.0.36' }], []]
      if (sql.includes('TABLE_NAME AS name') && sql.includes('LIMIT 1')) return [[{ name: 'settings' }], []]
      if (sql.includes('information_schema.COLUMNS')) return [[{
        name: 'value', column_type: 'varchar(64)', nullable: 'NO', column_key: '', default_text: '', extra: '', comment: '',
      }], []]
      if (sql.includes('information_schema.STATISTICS')) return [[], []]
      return [[], []]
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-table', schemaDatabase: 'app', schemaTable: 'settings',
      engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    expect(result).toMatchObject({ columns: [{ name: 'value', defaultText: '' }] })
  })

  test('Given 行预览命中总字节预算 When 裁剪 Then 保留全部页内行且显式标记文本截断', async () => {
    const fields = Array.from({ length: 64 }, (_, index) => ({ name: `column_${index}` }))
    const sourceRows = Array.from({ length: 201 }, (_, rowIndex) => Object.fromEntries(
      fields.map((field) => [field.name, `第${rowIndex}行`.repeat(100).slice(0, 257)]),
    ))
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('information_schema.TABLES AS t')) return [createPreviewColumns('wide_table', fields.map((field) => field.name)), []]
      if (isPreviewRowsSql(sql)) return [sourceRows, fields]
      return [[], []]
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-rows', schemaDatabase: 'app', schemaTable: 'wide_table', rowOffset: 0, rowLimit: 200,
      engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    if (!('rows' in result)) throw new Error('TEST_SCHEMA_ROWS_MISSING')
    expect(result.rows).toHaveLength(200)
    expect(result.hasMore).toBe(true)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result.rows), 'utf8')).toBeLessThanOrEqual(1_048_576)
    expect(result.rows[199]?.every((cell) => typeof cell === 'object' && cell !== null && cell.kind === 'text')).toBe(true)
  })

  test('Given 反斜杠引号与多字节文本放大 JSON When 裁剪 Then 最终序列化仍不越过预算', async () => {
    const fields = Array.from({ length: 64 }, (_, index) => ({ name: `column_${index}` }))
    /** 混合字符同时覆盖 JSON 转义膨胀和 UTF-8 多字节计量。 */
    const sourceRows = Array.from({ length: 200 }, () => Object.fromEntries(
      fields.map((field) => [field.name, '\\\"界'.repeat(100).slice(0, 257)]),
    ))
    const fixture = createMySqlConnection((sql) => {
      if (sql.includes('information_schema.TABLES AS t')) return [createPreviewColumns('escaped_table', fields.map((field) => field.name), 200), []]
      if (isPreviewRowsSql(sql)) return [sourceRows, fields]
      return [[], []]
    })
    const result = await readMySqlWithConnection(fixture.connection, {
      mode: 'schema-rows', schemaDatabase: 'app', schemaTable: 'escaped_table', rowOffset: 0, rowLimit: 200,
      engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    })
    if (!('rows' in result)) throw new Error('TEST_SCHEMA_ROWS_MISSING')
    expect(result.rows).toHaveLength(200)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result.rows), 'utf8')).toBeLessThanOrEqual(1_048_576)
    /** 协议层会把内部 mode/capability/warnings 剥离后交给公开 rows parser。 */
    expect(() => parseServerOpsDataSourceRowsResult({
      columns: result.columns,
      rows: result.rows,
      offset: result.offset,
      limit: result.limit,
      truncated: result.truncated,
      ...(result.totalEstimate === undefined ? {} : { totalEstimate: result.totalEstimate }),
      ...(result.hasMore === undefined ? {} : { hasMore: result.hasMore }),
      ...(result.orderedByPrimaryKey === undefined ? {} : { orderedByPrimaryKey: result.orderedByPrimaryKey }),
    })).not.toThrow()
  })
})
