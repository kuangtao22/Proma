import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ServerOpsAgentReadFacade } from '../server-ops/server-ops-agent-read-facade'
import { buildServerOpsReadTools } from './pi-server-ops-read-tools'

/** 测试 SDK 直接保留工具定义，验证真实 execute 到 Facade 的适配链。 */
const sdk = { defineTool: (definition: ToolDefinition) => definition } as typeof import('@earendil-works/pi-coding-agent')

describe('Pi Server Ops 多资源只读工具', () => {
  test('Given 发现与日志工具 When 调用 Then 原参数与取消信号进入有授权的Facade', async () => {
    /** 专用入口不提供任何任意命令或直接日志流接口。 */
    const seen: Array<{ input: unknown; signal?: AbortSignal }> = []
    const facade = {
      serverDiscover: async (input: unknown, signal?: AbortSignal) => { seen.push({ input, signal }); return { partial: true } },
      serverLogs: async (input: unknown, signal?: AbortSignal) => { seen.push({ input, signal }); return { lines: [] } },
    } as unknown as ServerOpsAgentReadFacade
    const tools = buildServerOpsReadTools(sdk, facade)
    const signal = new AbortController().signal
    const requests = [{ name: 'ops_server_discover', input: { hostId: 'host-1' } },
      { name: 'ops_server_logs', input: { hostId: 'host-1', source: { kind: 'system' }, since: '15m', priority: 'warning', tailLines: 100 } }]
    for (const request of requests) {
      const execute = tools.find((tool) => tool.name === request.name)!.execute as unknown as (...args: unknown[]) => Promise<unknown>
      await execute('call-1', request.input, signal)
    }
    expect(seen).toEqual(requests.map((request) => ({ input: request.input, signal })))
  })

  test('Given Facade 已绑定真实会话 When 构建工具 Then 旧读取工具不扩参且 SQL 使用独立工具', () => {
    const tools = buildServerOpsReadTools(sdk, {} as ServerOpsAgentReadFacade)
    expect(tools.map((tool) => tool.name)).toEqual([
      'ops_resources', 'ops_server_overview', 'ops_server_services',
      'ops_server_discover', 'ops_server_logs',
      'ops_data_test', 'ops_data_diagnose', 'ops_database_tables', 'ops_database_describe', 'ops_database_rows', 'ops_database_query',
      'ops_database_change_context',
    ])
    expect(JSON.stringify(tools.map((tool) => tool.parameters))).not.toMatch(/sessionId|password|address|command|queryId/i)
    expect(JSON.stringify(tools.filter((tool) => tool.name !== 'ops_database_query').map((tool) => tool.parameters))).not.toMatch(/sql/i)
  })

  test('Given SQL 工具执行 When Agent 取消 Then 把本次真实 signal 交给 Facade', async () => {
    let received: AbortSignal | undefined
    const facade = { databaseQuery: async (_input: unknown, signal?: AbortSignal) => { received = signal; return { rows: [] } } } as unknown as ServerOpsAgentReadFacade
    const tool = buildServerOpsReadTools(sdk, facade).find((entry) => entry.name === 'ops_database_query')!
    const signal = new AbortController().signal
    const execute = tool.execute as unknown as (...args: unknown[]) => Promise<unknown>
    await execute('call-1', { sourceId: 'db-1', database: 'app', sql: 'SELECT id FROM users', maxRows: 50 }, signal)
    expect(received).toBe(signal)
  })

  test('Given Agent 调用数据库行读取 When 执行 Pi 工具 Then 原样走 Facade 且限制 limit 为 50', async () => {
    let received: unknown
    const facade = {
      databaseRows: async (input: unknown) => { received = input; return { rows: [] } },
    } as unknown as ServerOpsAgentReadFacade
    const tool = buildServerOpsReadTools(sdk, facade).find((entry) => entry.name === 'ops_database_rows')!
    const execute = tool.execute as unknown as (...args: unknown[]) => Promise<{ content: unknown }>
    const result = await execute('call-1', { sourceId: 'source-1', database: 'app', table: 'users', offset: 0, limit: 50 })
    expect(received).toEqual({ sourceId: 'source-1', database: 'app', table: 'users', offset: 0, limit: 50 })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ rows: [] }, null, 2) }])
    expect(JSON.stringify(tool.parameters)).toContain('maximum')
    expect(JSON.stringify(tool.parameters)).toContain('50')
  })
})
