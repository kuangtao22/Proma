import { describe, expect, test } from 'bun:test'
import { SERVER_OPS_DATA_CHANNELS, SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS, SERVER_OPS_DATA_SCHEMA_CHANNELS } from '@proma/shared'
import type { ServerOpsDataSourceRowsInput } from '@proma/shared'
import { createServerOpsDataPreload } from './server-ops-data-preload'

describe('Server Ops 数据服务 preload 边界', () => {
  test('Given 本机凭据发现 When 通过 bridge 查找与取回 Then 走独立通道且两侧 fail closed', async () => {
    /** 记录真实桥接通道与输入，避免发现能力被接到其它数据源通道上。 */
    const calls: Array<{ channel: string; input: unknown }> = []
    const input = { address: '127.0.0.1', port: 13307, engine: 'mysql' as const }
    const candidate = {
      id: 'chebenben-local-mysql|root',
      label: '容器 chebenben-local-mysql 的 MYSQL_ROOT_PASSWORD',
      username: 'root',
      hasPassword: true,
      origin: 'container-env' as const,
      privilege: 'superuser' as const,
    }
    const preload = createServerOpsDataPreload(async (channel, request) => {
      calls.push({ channel, input: request })
      return channel === SERVER_OPS_DATA_CHANNELS.DISCOVER_SOURCE_CREDENTIALS
        ? { candidates: [candidate] }
        : { username: 'root', password: 'p@ss' }
    })
    await expect(preload.discoverServerOpsDataCredentials(input)).resolves.toEqual({ candidates: [candidate] })
    await expect(preload.applyServerOpsDiscoveredCredential({ ...input, candidateId: candidate.id }))
      .resolves.toEqual({ username: 'root', password: 'p@ss' })
    expect(calls).toEqual([
      { channel: SERVER_OPS_DATA_CHANNELS.DISCOVER_SOURCE_CREDENTIALS, input },
      { channel: SERVER_OPS_DATA_CHANNELS.APPLY_DISCOVERED_CREDENTIAL, input: { ...input, candidateId: candidate.id } },
    ])
    /** 输入侧：多字段、非法端口与非法候选标识都必须在发出请求之前被拒。 */
    await expect(preload.discoverServerOpsDataCredentials({ ...input, extra: true } as never)).rejects.toThrow()
    await expect(preload.discoverServerOpsDataCredentials({ ...input, port: 0 } as never)).rejects.toThrow()
    await expect(preload.applyServerOpsDiscoveredCredential({ ...input, candidateId: 'no-separator' } as never)).rejects.toThrow()
    expect(calls).toHaveLength(2)
    /** 回执侧：候选夹带口令、或口令为空都说明协议被破坏。 */
    const pollutedCandidates = createServerOpsDataPreload(async () => ({ candidates: [{ ...candidate, password: 'secret' }] }))
    await expect(pollutedCandidates.discoverServerOpsDataCredentials(input)).rejects.toThrow('SERVER_OPS_DATA_CREDENTIAL_DISCOVERY_RESULT_INVALID')
    const pollutedPassword = createServerOpsDataPreload(async () => ({ username: 'root', password: '' }))
    await expect(pollutedPassword.applyServerOpsDiscoveredCredential({ ...input, candidateId: candidate.id }))
      .rejects.toThrow('SERVER_OPS_DATA_CREDENTIAL_APPLY_RESULT_INVALID')
  })

  test('Given SQL 数据源快照 When 设置默认数据库 Then 使用独立通道并严格校验输入回执', async () => {
    const calls: Array<{ channel: string; input: unknown }> = []
    const source = {
      id: 'source-1', transport: 'direct' as const, engine: 'postgresql' as const, label: '分析库',
      address: 'db.internal', port: 5432, database: 'postgres', username: 'analyst', tlsMode: 'required' as const,
      hasPassword: true, createdAt: 1, updatedAt: 2,
    }
    const preload = createServerOpsDataPreload(async (channel, input) => {
      calls.push({ channel, input })
      return { source: { ...source, database: 'analytics', updatedAt: 3 } }
    })
    await expect(preload.setServerOpsDataSourceDefaultDatabase({ source, database: 'analytics' }))
      .resolves.toHaveProperty('source.database', 'analytics')
    expect(calls).toEqual([{
      channel: SERVER_OPS_DATA_CHANNELS.SET_DEFAULT_DATABASE,
      input: { source, database: 'analytics' },
    }])
    await expect(preload.setServerOpsDataSourceDefaultDatabase({ source, database: '', extra: true } as never))
      .rejects.toThrow('SERVER_OPS_DATA_SOURCE_SET_DEFAULT_DATABASE_INPUT_INVALID')
    expect(calls).toHaveLength(1)
    const polluted = createServerOpsDataPreload(async () => ({ source: { ...source, database: 'analytics' }, extra: true }))
    await expect(polluted.setServerOpsDataSourceDefaultDatabase({ source, database: 'analytics' }))
      .rejects.toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_RESULT_INVALID')
  })

  test('Given 单格全文 When bridge 读取 Then 严格校验定位且保留正文换行', async () => {
    /** 记录真实桥接参数，避免新通道被错误接到预览 parser。 */
    const calls: Array<{ channel: string; input: unknown }> = []
    const value = '{\n"payload":"' + 'x'.repeat(400) + '"\n}'
    const input = { sourceId: 'source-1', database: 'main', table: 'entries', offset: 53,
      columnIndex: 1, expectedColumn: 'payload', sha256: 'a'.repeat(64) }
    const preload = createServerOpsDataPreload(async (channel, request) => { calls.push({ channel, input: request }); return { value } })
    await expect(preload.readServerOpsDataSchemaCell(input)).resolves.toEqual({ value })
    expect(calls).toEqual([{ channel: SERVER_OPS_DATA_SCHEMA_CHANNELS.READ_CELL, input }])
    await expect(preload.readServerOpsDataSchemaCell({ ...input, sql: 'SELECT 1' } as never)).rejects.toThrow()
    expect(calls).toHaveLength(1)
    const polluted = createServerOpsDataPreload(async () => ({ value, truncated: true }))
    await expect(polluted.readServerOpsDataSchemaCell(input)).rejects.toThrow('SERVER_OPS_DATA_CELL_RESULT_INVALID')
  })
  test('Given 本地 SQLite When 通过现有 bridge 保存 Then 文件身份仅从主进程回执传回', async () => {
    /** 记录真实 bridge 校验后的输入，身份只能存在于返回的公开配置。 */
    const calls: Array<{ channel: string; input: unknown }> = []
    const draft = { transport: 'direct' as const, engine: 'sqlite' as const, label: '本地业务库', filePath: '/tmp/app.db', tlsMode: 'disabled' as const }
    const preload = createServerOpsDataPreload(async (channel, input) => {
      calls.push({ channel, input })
      return { source: { ...draft, id: 'local-db', localFileId: '1:42:1700000000000000000', hasPassword: false, createdAt: 1, updatedAt: 1 } }
    })
    await expect(preload.upsertServerOpsDataSource(draft)).resolves.toHaveProperty('source.localFileId', '1:42:1700000000000000000')
    expect(calls).toEqual([{ channel: SERVER_OPS_DATA_CHANNELS.UPSERT_SOURCE, input: { ...draft, database: 'main' } }])
    await expect(preload.upsertServerOpsDataSource({ ...draft, localFileId: '1:99:1' } as never)).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
  test('Given 表数据筛选 When preload 读取 Then 透传有界条件且拒绝原始 SQL 夹带', async () => {
    /** 记录真实 bridge 下发的结构，验证新增字段不会被旧映射丢弃。 */
    const calls: Array<{ channel: string; input: unknown }> = []
    const preload = createServerOpsDataPreload(async (channel, input) => {
      calls.push({ channel, input })
      return { columns: ['id'], rows: [['1']], offset: 0, limit: 50, truncated: false }
    })
    const input: ServerOpsDataSourceRowsInput = { sourceId: 'source-1', database: 'app', table: 'users', offset: 0, limit: 50,
      filters: { match: 'all', conditions: [{ column: 'id', operator: 'gt', value: '0' }] } }
    await expect(preload.readServerOpsDataSchemaRows(input)).resolves.toMatchObject({ rows: [['1']] })
    expect(calls).toEqual([{ channel: SERVER_OPS_DATA_SCHEMA_CHANNELS.READ_ROWS, input }])
    await expect(preload.readServerOpsDataSchemaRows({ ...input, filters: { ...input.filters, rawSql: '1=1' } } as never)).rejects.toThrow('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
    expect(calls).toHaveLength(1)
  })
  test('Given 查询历史 list/save When bridge 调用 Then 输入与回执均走 exact-key parser', async () => {
    /** 记录两个历史通道的严格输入，模拟主进程返回该 scope 的完整列表。 */
    const calls: Array<{ channel: string; input: unknown }> = []
    const preload = createServerOpsDataPreload(async (channel, input) => {
      calls.push({ channel, input })
      const record = input as { sourceId: string; database: string; sql?: string }
      return { entries: record.sql === undefined ? [] : [{
        id: 'history-1', sourceId: record.sourceId, database: record.database, sql: record.sql, createdAt: 1,
      }] }
    })

    await expect(preload.listServerOpsDatabaseQueryHistory({ sourceId: 'source-1', database: 'app' }))
      .resolves.toEqual({ entries: [] })
    await expect(preload.saveServerOpsDatabaseQueryHistory({ sourceId: 'source-1', database: 'app', sql: 'SELECT 1' }))
      .resolves.toMatchObject({ entries: [{ sql: 'SELECT 1' }] })
    expect(calls).toEqual([
      { channel: SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS.LIST, input: { sourceId: 'source-1', database: 'app' } },
      { channel: SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS.SAVE, input: { sourceId: 'source-1', database: 'app', sql: 'SELECT 1' } },
    ])

    await expect(preload.saveServerOpsDatabaseQueryHistory({ sourceId: 'source-1', database: 'app', sql: '', extra: true } as never))
      .rejects.toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RECORD_INVALID')
    const polluted = createServerOpsDataPreload(async () => ({ entries: [], extra: true }))
    await expect(polluted.listServerOpsDatabaseQueryHistory({ sourceId: 'source-1', database: 'app' }))
      .rejects.toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
    const crossedScope = createServerOpsDataPreload(async () => ({ entries: [{
      id: 'history-1', sourceId: 'source-2', database: 'app', sql: 'SELECT 1', createdAt: 1,
    }] }))
    await expect(crossedScope.listServerOpsDatabaseQueryHistory({ sourceId: 'source-1', database: 'app' }))
      .rejects.toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
  })

  test('Given SQL 查询与取消 When bridge 调用 Then 精确校验输入结果和取消空回执', async () => {
    /** 通过真实 preload 证明 SQL 与密码显示、旧表预览使用不同通道。 */
    const calls: string[] = []
    const preload = createServerOpsDataPreload(async (channel, input) => {
      calls.push(channel)
      if (channel.endsWith('cancel')) return undefined
      const query = input as { queryId: string; database: string }
      return { queryId: query.queryId, database: query.database, columns: ['id'], rows: [['1']], rowCount: 1, durationMs: 1, truncated: false, warnings: [] }
    })
    await expect(preload.queryServerOpsDatabase({ sourceId: 'db-1', queryId: 'query-1', database: 'app', sql: 'SELECT id FROM users', maxRows: 50 })).resolves.toMatchObject({ rows: [['1']] })
    await preload.cancelServerOpsDatabaseQuery({ sourceId: 'db-1', queryId: 'query-1' })
    expect(calls).toEqual(['server-ops:data-query', 'server-ops:data-query-cancel'])
    await expect(preload.queryServerOpsDatabase({ sourceId: 'db-1', queryId: 'query-1', database: 'app', sql: '', maxRows: 50 })).rejects.toThrow()
    const polluted = createServerOpsDataPreload(async () => ({ password: 'do-not-return' }))
    await expect(polluted.cancelServerOpsDatabaseQuery({ sourceId: 'db-1', queryId: 'query-1' })).rejects.toThrow()
  })
  test('Given 读取已保存密码 When 调用 Then 只在同一通道内取回明文并严格校验结果', async () => {
    /** 记录实际下发的通道与输入。 */
    const calls: Array<{ channel: string; input: unknown }> = []
    const preload = createServerOpsDataPreload(async (channel, input) => {
      calls.push({ channel, input })
      return { password: 'p@ss' }
    })

    await expect(preload.revealServerOpsDataSourcePassword({ sourceId: 'source-1' }))
      .resolves.toEqual({ password: 'p@ss' })
    expect(calls).toEqual([{ channel: SERVER_OPS_DATA_CHANNELS.REVEAL_SOURCE_PASSWORD, input: { sourceId: 'source-1' } }])
  })

  test('Given 输入或回执被污染 When 调用 Then 两侧都 fail closed', async () => {
    const preload = createServerOpsDataPreload(async () => ({ password: 'p@ss', hostId: 'host-1' }))
    await expect(preload.revealServerOpsDataSourcePassword({ sourceId: 'source-1' }))
      .rejects.toThrow('SERVER_OPS_DATA_SOURCE_PASSWORD_RESULT_INVALID')
    await expect(preload.revealServerOpsDataSourcePassword({ sourceId: 'source 1' }))
      .rejects.toThrow('SERVER_OPS_DATA_SOURCE_PASSWORD_INPUT_INVALID')
  })

  test('Given 按库诊断 When 调用 Then section 与 database 经严格解析后原样转发', async () => {
    /** 记录诊断调用，验证 preload 不会丢失分区语义。 */
    const calls: Array<{ channel: string; input: unknown }> = []
    const preload = createServerOpsDataPreload(async (channel, input) => {
      calls.push({ channel, input })
      return {
        sourceId: 'source-1', engine: 'mysql', capability: 'available', collectedAt: 1,
        metrics: [], tables: [], parameters: [{ name: 'autocommit', value: 'ON', scope: 'global' }],
        parametersTruncated: false, warnings: [],
      }
    })
    await expect(preload.diagnoseServerOpsDataSource({ sourceId: 'source-1', section: 'statements', database: ' app data ' }))
      .resolves.toMatchObject({ parameters: [{ name: 'autocommit', value: 'ON', scope: 'global' }] })
    expect(calls).toEqual([{ channel: SERVER_OPS_DATA_CHANNELS.DIAGNOSE_SOURCE,
      input: { sourceId: 'source-1', section: 'statements', database: ' app data ' } }])
  })
})
