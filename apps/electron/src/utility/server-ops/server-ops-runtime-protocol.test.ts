import { describe, expect, test } from 'bun:test'
import type { ServerOpsDataRowFilters } from '@proma/shared'
import {
  parseServerOpsRuntimeMessage,
  parseServerOpsRuntimeRequest,
} from './server-ops-runtime-protocol'

/** 构造完整且可通过协议边界的连接请求。 */
function createConnectRequest(): unknown {
  return {
    type: 'server-ops.connect',
    input: {
      requestId: 'request-1',
      hostId: 'host-1',
      connectionId: 'connection-1',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      expectedHostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' },
      authentication: { kind: 'private-key', privateKey: new Uint8Array([1, 2, 3]), passphrase: 'secret' },
      cols: 80,
      rows: 24,
    },
  }
}

describe('Server Ops utility runtime 请求协议', () => {
  test('Given 本地 SQLite 文件 When 进入 utility Then 需要可信文件身份且禁止网络引擎夹带', () => {
    /** 完整本地文件请求：沿用直连临时身份，但没有网络端点。 */
    const input = { requestId: 'local-sqlite', hostId: 'server-ops-local-direct', connectionId: 'local-1', transport: 'direct', mode: 'probe', engine: 'sqlite', filePath: 'C:\\数据\\app.db', localFileId: '1:42:1700000000000000000', database: 'main', tlsMode: 'disabled', timeoutMs: 15_000 } as const
    expect(parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input })).toEqual({ type: 'server-ops.data-read', input })
    for (const extra of [{ localFileId: undefined }, { localFileId: 'invalid' }, { transport: 'ssh', filePath: '/srv/app.db' }, { engine: 'mysql', address: '127.0.0.1', port: 3306, filePath: undefined }]) {
      expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: { ...input, ...extra } })).toThrow()
    }
  })
  test('Given 指定库目录搜索 When 解析协议 Then 只允许 schema-tables 携带有界搜索词', () => {
    const base = { requestId: 'search-1', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', timeoutMs: 15_000 } as const
    const input = { ...base, mode: 'schema-tables', schemaDatabase: 'app', schemaTableSearch: "table_%'" }
    expect(parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input })).toMatchObject({ input })
    for (const invalid of [{ ...input, schemaDatabase: undefined }, { ...input, schemaTableSearch: '' }, { ...input, schemaTableSearch: 'x'.repeat(129) }, { ...input, mode: 'schema-rows', schemaTable: 'users', rowOffset: 0, rowLimit: 10 }]) {
      expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: invalid })).toThrow()
    }
  })
  test('Given Agent 仅物理表标记 When 解析 Then 只接受结构与行模式的布尔值', () => {
    const base = { requestId: 'base-table-1', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', timeoutMs: 15_000 } as const
    for (const mode of ['schema-table', 'schema-rows'] as const) {
      const input = { ...base, mode, schemaDatabase: 'app', schemaTable: 'public_view', baseTablesOnly: true,
        ...(mode === 'schema-rows' ? { rowOffset: 0, rowLimit: 50 } : {}) }
      expect(parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input })).toEqual({ type: 'server-ops.data-read', input })
      expect(parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: { ...input, baseTablesOnly: false } })).toMatchObject({ input: { baseTablesOnly: false } })
      expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: { ...input, baseTablesOnly: 'true' } })).toThrow()
    }
    for (const mode of ['probe', 'diagnostics', 'schema-tables', 'sql-query']) {
      expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: { ...base, mode, baseTablesOnly: true } })).toThrow()
    }
  })
  test('Given 行筛选 When 进入 utility Then 重建有界条件且禁止其它模式夹带筛选', () => {
    /** 不含 schema 参数的有效连接，便于逐模式检测夹带条件。 */
    const connection = { requestId: 'filtered-rows', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', timeoutMs: 15_000 } as const
    const rowFilters: ServerOpsDataRowFilters = { match: 'all', conditions: [{ column: 'name', operator: 'contains', value: "a%' OR 1=1 --" }] }
    const input = { ...connection, mode: 'schema-rows' as const, schemaDatabase: 'app', schemaTable: 'users', rowOffset: 0, rowLimit: 50, rowFilters }
    expect(parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input })).toEqual({ type: 'server-ops.data-read', input })
    for (const mode of ['probe', 'diagnostics', 'schema-tables']) {
      expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: { ...connection, mode, rowFilters } })).toThrow('SERVER_OPS_RUNTIME_REQUEST_INVALID')
    }
    for (const invalid of [{ ...rowFilters, rawSql: '1=1' }, { match: 'all', conditions: [] }, { match: 'all', conditions: [{ column: 'id', operator: 'raw', value: '1' }] }]) {
      expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: { ...input, rowFilters: invalid } })).toThrow('SERVER_OPS_RUNTIME_REQUEST_INVALID')
    }
    expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: { ...input, engine: 'redis' } })).toThrow('SERVER_OPS_RUNTIME_REQUEST_INVALID')
  })
  test('Given 截断单元格详情请求 When 进入 utility Then 只接受绝对偏移、列身份与小写摘要', () => {
    const input = { requestId: 'cell-1', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', engine: 'mysql',
      address: '127.0.0.1', port: 3306, tlsMode: 'disabled', timeoutMs: 10_000, mode: 'schema-cell', schemaDatabase: 'app',
      schemaTable: 'events', rowOffset: 1_000_199, cellColumnIndex: 63, cellExpectedColumn: 'payload', cellSha256: 'a'.repeat(64) } as const
    expect(parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input })).toEqual({ type: 'server-ops.data-read', input })
    for (const invalid of [
      { rowOffset: 1_000_200 }, { rowLimit: 1 }, { cellColumnIndex: 64 }, { cellExpectedColumn: '' },
      { cellSha256: 'A'.repeat(64) }, { cellSha256: 'short' },
    ]) {
      expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: { ...input, ...invalid } })).toThrow()
    }
  })
  test('Given TLS 协商请求 When MySQL 与 Redis 进入 utility Then 只放行支持协商的引擎', () => {
    const input = { requestId: 'tls-1', hostId: 'host-1', connectionId: 'connection-1',
      transport: 'direct', mode: 'probe', engine: 'mysql', address: 'db.example.com', port: 3306,
      tlsMode: 'preferred', timeoutMs: 15_000 } as const
    expect(parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input })).toEqual({ type: 'server-ops.data-read', input })
    expect(parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: { ...input, tlsMode: 'required' } }))
      .toMatchObject({ input: { tlsMode: 'required' } })
    expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: {
      ...input, engine: 'redis', tlsMode: 'preferred', port: 6379,
    } })).toThrow('SERVER_OPS_RUNTIME_REQUEST_INVALID')
  })
  test('Given MySQL verify 请求 When hostname 是 IP 或带端口 Then utility 在开通道前拒绝', () => {
    const input = { requestId: 'tls-verify', hostId: 'host-1', connectionId: 'connection-1',
      transport: 'direct', mode: 'probe', engine: 'mysql', address: '127.0.0.1', port: 3306,
      tlsMode: 'verify', tlsServerName: 'db.example.com', timeoutMs: 15_000 } as const
    expect(parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input })).toEqual({ type: 'server-ops.data-read', input })
    for (const name of ['127.0.0.1', '::1', '[::1]', 'db.example.com:3306']) {
      expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: {
        ...input, tlsServerName: name,
      } })).toThrow('SERVER_OPS_RUNTIME_REQUEST_INVALID')
    }
  })
  test('Given SSH SQLite 文件 When 读取与查询 Then 传递文件路径并拒绝网络参数或附加库', () => {
    /** 不含网络端点的 SQLite 请求。 */
    const input = { requestId: 'sqlite-1', hostId: 'host-1', connectionId: 'connection-1', transport: 'ssh', mode: 'schema-tables', engine: 'sqlite', filePath: "/srv/业务 data/app's.db", database: 'main', tlsMode: 'disabled', timeoutMs: 15_000 } as const
    expect(parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input })).toEqual({ type: 'server-ops.data-read', input })
    /** SQL 请求仍复用既有取消身份和结果预算。 */
    const query = { ...input, mode: 'sql-query', queryId: 'query-1', sql: 'SELECT id FROM users', maxRows: 50 } as const
    expect(parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: query })).toEqual({ type: 'server-ops.data-read', input: query })
    for (const patch of [{ transport: 'direct' }, { filePath: ':memory:' }, { address: '127.0.0.1', port: 3306 }, { username: 'root' }, { password: 'secret' }, { database: 'temp' }, { schemaDatabase: 'other' }]) {
      expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: { ...input, ...patch } })).toThrow('SERVER_OPS_RUNTIME_REQUEST_INVALID')
    }
  })
  test('严格重建所有合法请求分支', () => {
    const consoleIdentity = { consoleId: 'console-1', hostId: 'host-1', connectionId: 'connection-1', containerId: 'a'.repeat(64) }
    const requests: unknown[] = [
      createConnectRequest(),
      { type: 'server-ops.exec', input: { requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', command: 'uname -a', timeoutMs: 1_000 } },
      { type: 'server-ops.exec-cancel', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1' },
      { type: 'server-ops.disconnect', hostId: 'host-1', connectionId: 'connection-1' },
      { type: 'server-ops.terminal-input', hostId: 'host-1', connectionId: 'connection-1', data: 'pwd\n' },
      { type: 'server-ops.terminal-resize', hostId: 'host-1', connectionId: 'connection-1', cols: 80, rows: 24 },
      { type: 'server-ops.terminal-ack', input: { hostId: 'host-1', connectionId: 'connection-1', sequence: 1 } },
      { type: 'server-ops.console-start', input: { ...consoleIdentity, cols: 80, rows: 24 } },
      { type: 'server-ops.console-stop', input: consoleIdentity },
      { type: 'server-ops.console-input', input: { ...consoleIdentity, data: 'pwd\n' } },
      { type: 'server-ops.console-resize', input: { ...consoleIdentity, cols: 100, rows: 30 } },
      { type: 'server-ops.console-ack', input: { ...consoleIdentity, sequence: 1 } },
      { type: 'server-ops.log-start', input: { streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', command: 'journalctl -f' } },
      { type: 'server-ops.log-stop', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1' },
      { type: 'server-ops.log-ack', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 0 },
      { type: 'server-ops.data-read', input: { requestId: 'data-1', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', mode: 'diagnostics', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', timeoutMs: 15_000, diagnosticSection: 'parameters' } },
      { type: 'server-ops.data-read', input: { requestId: 'data-2', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', mode: 'diagnostics', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', timeoutMs: 15_000, diagnosticSection: 'sessions', diagnosticDatabase: ' app data ' } },
      { type: 'server-ops.data-read', input: { requestId: 'data-3', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', mode: 'sql-query', engine: 'mysql', address: '127.0.0.1', port: 3306, database: 'app', tlsMode: 'disabled', timeoutMs: 15_000, queryId: 'query-1', sql: 'SELECT id FROM users', maxRows: 50 } },
      { type: 'server-ops.data-cancel', requestId: 'data-3', hostId: 'host-1', connectionId: 'connection-1' },
      { type: 'server-ops.shutdown' },
    ]

    for (const request of requests) {
      expect(parseServerOpsRuntimeRequest(request)).toEqual(request as ReturnType<typeof parseServerOpsRuntimeRequest>)
    }
  })

  test('拒绝未知字段、非规范身份与越界请求数据', () => {
    const invalidRequests: unknown[] = [
      { type: 'server-ops.shutdown', extra: true },
      { type: 'server-ops.disconnect', hostId: '../host', connectionId: 'connection-1' },
      { type: 'server-ops.terminal-resize', hostId: 'host-1', connectionId: 'connection-1', cols: 0, rows: 24 },
      { type: 'server-ops.terminal-input', hostId: 'host-1', connectionId: 'connection-1', data: 'x'.repeat(65_537) },
      { type: 'server-ops.console-start', input: { consoleId: 'console-1', hostId: 'host-1', connectionId: 'connection-1', containerId: 'short', cols: 80, rows: 24 } },
      { type: 'server-ops.console-input', input: { consoleId: 'console-1', hostId: 'host-1', connectionId: 'connection-1', containerId: 'a'.repeat(64), data: 'id\n', extra: true } },
      { type: 'server-ops.exec', input: { requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', command: '', timeoutMs: 1_000 } },
      { type: 'server-ops.exec', input: { requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', command: 'x'.repeat(8_193), timeoutMs: 1_000 } },
      { type: 'server-ops.log-start', input: { streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', command: '' } },
      { type: 'server-ops.log-start', input: { streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', command: 'x'.repeat(8_193) } },
      { type: 'server-ops.log-start', input: { streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', command: 'echo\0secret' } },
      { type: 'server-ops.log-start', input: { streamId: '../stream', hostId: 'host-1', connectionId: 'connection-1', command: 'journalctl -f' } },
      { type: 'server-ops.log-stop', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', extra: true },
      { type: 'server-ops.log-ack', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: -1 },
      { type: 'server-ops.log-ack', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: Number.MAX_SAFE_INTEGER + 1 },
      { type: 'server-ops.exec', input: { requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', command: 'pwd', timeoutMs: 999 } },
      { type: 'server-ops.exec', input: { requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', command: 'pwd', timeoutMs: 120_001 } },
      { ...createConnectRequest() as object, extra: true },
      { type: 'server-ops.data-read', input: { requestId: 'data-1', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', mode: 'diagnostics', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', timeoutMs: 15_000, diagnosticSection: 'unknown' } },
      { type: 'server-ops.data-read', input: { requestId: 'data-1', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', mode: 'diagnostics', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', timeoutMs: 15_000, diagnosticSection: 'overview', diagnosticDatabase: 'app' } },
      { type: 'server-ops.data-read', input: { requestId: 'data-1', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', mode: 'diagnostics', engine: 'redis', address: '127.0.0.1', port: 6379, tlsMode: 'disabled', timeoutMs: 15_000, diagnosticSection: 'sessions', diagnosticDatabase: '0' } },
      { type: 'server-ops.data-read', input: { requestId: 'data-1', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', mode: 'probe', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', timeoutMs: 15_000, diagnosticDatabase: 'app' } },
      { type: 'server-ops.data-read', input: { requestId: 'data-1', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', mode: 'diagnostics', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', timeoutMs: 15_000, diagnosticSection: 'sessions', diagnosticDatabase: ' \n ' } },
      { type: 'server-ops.data-read', input: { requestId: 'data-1', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', mode: 'diagnostics', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', timeoutMs: 15_000, diagnosticSection: 'statements', diagnosticDatabase: 'x'.repeat(65) } },
      { type: 'server-ops.data-read', input: { requestId: 'data-3', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', mode: 'sql-query', engine: 'redis', address: '127.0.0.1', port: 6379, database: '0', tlsMode: 'disabled', timeoutMs: 15_000, queryId: 'query-1', sql: 'SELECT 1', maxRows: 50 } },
      { type: 'server-ops.data-read', input: { requestId: 'data-3', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct', mode: 'sql-query', engine: 'mysql', address: '127.0.0.1', port: 3306, database: 'app', tlsMode: 'disabled', timeoutMs: 15_000, queryId: 'query-1', sql: 'SELECT 1', maxRows: 50, rowLimit: 50 } },
      { type: 'server-ops.data-cancel', requestId: 'data-3', hostId: 'host-1', connectionId: 'connection-1', extra: true },
      { type: 'server-ops.exec-cancel', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', extra: true },
      { type: 'server-ops.connect', input: { ...(createConnectRequest() as { input: object }).input, address: 'bad host' } },
      { type: 'server-ops.connect', input: { ...(createConnectRequest() as { input: object }).input, port: 65_536 } },
      { type: 'server-ops.connect', input: { ...(createConnectRequest() as { input: object }).input, username: '' } },
      { type: 'server-ops.connect', input: { ...(createConnectRequest() as { input: object }).input, authentication: { kind: 'private-key', privateKey: [1, 2, 3] } } },
    ]

    for (const request of invalidRequests) {
      expect(() => parseServerOpsRuntimeRequest(request)).toThrow('SERVER_OPS_RUNTIME_REQUEST_INVALID')
    }
  })
})

describe('Server Ops utility runtime 返回协议', () => {
  test('Given runtime 回执包含实际 TLS 状态 When 解析 Then 成功保留，失败拒绝状态', () => {
    const message = { type: 'server-ops.data-read-result' as const, requestId: 'tls-1', hostId: 'host-1',
      connectionId: 'connection-1', result: { capability: 'available' as const, serverVersion: '8.0.36',
        tlsStatus: 'encrypted' as const, metrics: [], tables: [], warnings: [] } }
    expect(parseServerOpsRuntimeMessage(message)).toEqual(message)
    expect(() => parseServerOpsRuntimeMessage({ ...message, result: {
      ...message.result, capability: 'tls-failed', serverVersion: undefined,
    } })).toThrow('SERVER_OPS_RUNTIME_MESSAGE_INVALID')
    expect(() => parseServerOpsRuntimeMessage({ ...message, result: {
      ...message.result, tlsStatus: 'unknown',
    } })).toThrow('SERVER_OPS_RUNTIME_MESSAGE_INVALID')
  })
  test('严格重建所有合法消息分支', () => {
    const consoleIdentity = { consoleId: 'console-1', hostId: 'host-1', connectionId: 'connection-1', containerId: 'a'.repeat(64) }
    const messages: unknown[] = [
      { type: 'server-ops.ready', pid: 100 },
      { type: 'server-ops.connect-result', requestId: 'request-1', hostId: 'host-1', connectionId: 'connection-1', result: { status: 'connected', hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' } } },
      { type: 'server-ops.connect-result', requestId: 'request-1', hostId: 'host-1', connectionId: 'connection-1', result: { status: 'host-key-rejected', observedHostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' } } },
      { type: 'server-ops.exec-result', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', result: { stdout: 'Linux\n', stderr: '', exitCode: 0, truncated: false } },
      { type: 'server-ops.exec-cancelled', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1' },
      { type: 'server-ops.error', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', code: 'SERVER_OPS_EXEC_FAILED', message: '远程命令执行失败' },
      { type: 'server-ops.error', hostId: 'host-1', connectionId: 'connection-1', code: 'SERVER_OPS_CONNECTION_CLOSED', message: 'SSH 连接已关闭' },
      { type: 'server-ops.terminal-output', event: { hostId: 'host-1', connectionId: 'connection-1', sequence: 1, data: 'hello' } },
      { type: 'server-ops.terminal-exit', event: { hostId: 'host-1', connectionId: 'connection-1', exitCode: 0, message: '远程终端已退出' } },
      { type: 'server-ops.console-started', session: consoleIdentity },
      { type: 'server-ops.console-output', event: { ...consoleIdentity, sequence: 1, data: 'hello' } },
      { type: 'server-ops.console-exit', event: { ...consoleIdentity, exitCode: 0, message: '容器终端已退出' } },
      { type: 'server-ops.log-started', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1' },
      { type: 'server-ops.log-chunk', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 0, data: '服务\n' },
      { type: 'server-ops.log-exit', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', reason: 'stopped' },
      { type: 'server-ops.log-exit', streamId: 'stream-2', hostId: 'host-1', connectionId: 'connection-1', reason: 'error', errorCode: 'SERVER_OPS_LOG_STREAM_FAILED' },
      { type: 'server-ops.data-read-result', requestId: 'data-1', hostId: 'host-1', connectionId: 'connection-1', result: { capability: 'available', serverVersion: '8.0.36', metrics: [], tables: [], parameters: [{ name: 'autocommit', value: 'ON', scope: 'global' }], parametersTruncated: false, warnings: [] } },
      { type: 'server-ops.data-read-result', requestId: 'data-2', hostId: 'host-1', connectionId: 'connection-1', result: { mode: 'schema-tables', capability: 'available', database: 'app', databases: ['app'], tables: [{ name: 'users', type: 'table' }], databasesTruncated: true, tablesTruncated: false, warnings: [] } },
      { type: 'server-ops.data-read-result', requestId: 'data-3', hostId: 'host-1', connectionId: 'connection-1', result: { mode: 'schema-rows', capability: 'available', columns: ['payload'], rows: [[{ kind: 'binary', bytes: 8 }]], offset: 0, limit: 50, truncated: false, hasMore: false, orderedByPrimaryKey: true, warnings: [] } },
      { type: 'server-ops.data-read-result', requestId: 'data-4', hostId: 'host-1', connectionId: 'connection-1', result: { queryId: 'query-1', database: 'app', columns: ['id'], rows: [['1']], rowCount: 1, durationMs: 12, truncated: false, warnings: [] } },
      { type: 'server-ops.data-read-cancelled', requestId: 'data-4', hostId: 'host-1', connectionId: 'connection-1' },
      { type: 'server-ops.stopped' },
    ]

    for (const message of messages) {
      expect(parseServerOpsRuntimeMessage(message)).toEqual(message as ReturnType<typeof parseServerOpsRuntimeMessage>)
    }
  })

  test('拒绝未知字段、非法 union 与越界输出', () => {
    const invalidMessages: unknown[] = [
      { type: 'server-ops.ready', pid: 100, extra: true },
      { type: 'server-ops.connect-result', requestId: 'request-1', hostId: 'host-1', connectionId: 'connection-1', result: { status: 'connected', observedHostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' } } },
      { type: 'server-ops.exec-result', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', result: { stdout: '', stderr: '', truncated: false, secret: 'leak' } },
      { type: 'server-ops.exec-cancelled', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', extra: true },
      { type: 'server-ops.exec-result', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', result: { stdout: 'x'.repeat(1_048_577), stderr: '', truncated: true } },
      { type: 'server-ops.exec-result', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', result: { stdout: '界'.repeat(349_526), stderr: '', truncated: true } },
      { type: 'server-ops.error', requestId: '', hostId: 'host-1', connectionId: 'connection-1', code: 'SERVER_OPS_EXEC_FAILED', message: '失败' },
      { type: 'server-ops.terminal-output', event: { hostId: 'host-1', connectionId: 'connection-1', sequence: 0, data: 'hello' } },
      { type: 'server-ops.terminal-output', event: { hostId: 'host-1', connectionId: 'connection-1', sequence: 1, data: 'x'.repeat(1_048_833) } },
      { type: 'server-ops.terminal-exit', event: { hostId: 'host-1', connectionId: 'connection-1', signal: {}, message: '退出' } },
      { type: 'server-ops.console-output', event: { consoleId: 'console-1', hostId: 'host-1', connectionId: 'connection-1', containerId: 'a'.repeat(64), sequence: 0, data: 'hello' } },
      { type: 'server-ops.console-exit', event: { consoleId: 'console-1', hostId: 'host-1', connectionId: 'connection-1', containerId: 'short', message: '退出' } },
      { type: 'server-ops.log-started', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', extra: true },
      { type: 'server-ops.log-chunk', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: -1, data: '日志' },
      { type: 'server-ops.log-chunk', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: Number.MAX_SAFE_INTEGER + 1, data: '日志' },
      { type: 'server-ops.log-chunk', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 0, data: '你'.repeat(10_923) },
      { type: 'server-ops.log-exit', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', reason: 'stopped', errorCode: 'SERVER_OPS_LOG_STREAM_FAILED' },
      { type: 'server-ops.log-exit', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', reason: 'unknown' },
      { type: 'server-ops.data-read-result', requestId: 'data-1', hostId: 'host-1', connectionId: 'connection-1', result: { mode: 'schema-rows', capability: 'available', columns: ['payload'], rows: [[{ kind: 'binary', bytes: -1 }]], offset: 0, limit: 50, truncated: false, warnings: [] } },
      { type: 'server-ops.data-read-cancelled', requestId: '', hostId: 'host-1', connectionId: 'connection-1' },
    ]

    for (const message of invalidMessages) {
      expect(() => parseServerOpsRuntimeMessage(message)).toThrow('SERVER_OPS_RUNTIME_MESSAGE_INVALID')
    }
  })
})
