import { describe, expect, test } from 'bun:test'
import { SERVER_OPS_DATA_CHANNELS, SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS } from '@proma/shared'
import { createServerOpsDataPreload } from './server-ops-data-preload'

describe('Server Ops 数据服务 preload 边界', () => {
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
