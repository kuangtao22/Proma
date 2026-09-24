import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, AgentToolMode } from '@proma/shared'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createServerOpsConnectionDraftAgent } from './server-ops-connection-draft-agent'
import { ServerOpsConnectionDraftStore } from './server-ops-connection-draft-store'
import { buildServerOpsConnectionTools } from '../adapters/pi-server-ops-connection-tools'

/** 固定的非敏感连接资料，不提供任何远程凭据。 */
const draftInput = { kind: 'ssh', name: '测试服务器', address: 'example.test', port: 22, username: 'deploy' }

/** 将生产会话门禁、内存 Store 与真实工具适配组合到可控依赖中。 */
function fixture() {
  /** 会话元数据可变，测试归档后的旧工具闭包。 */
  let session = { id: 'session-1', title: '测试', createdAt: 1, updatedAt: 1 } as AgentSessionMeta
  /** 真实取消控制器与代次用于模拟停止/重发。 */
  const run = new AbortController()
  let active = true
  /** 每个测试独占 Store，杜绝污染应用的内存草稿。 */
  const store = new ServerOpsConnectionDraftStore()
  const options = { sessionId: 'session-1', toolMode: 'standard' as AgentToolMode, getSession: () => session, runSignal: run.signal,
    assertRunActive: () => { if (!active) throw new Error('RUN_STALE') },
    prepare: (sessionId: string, input: unknown) => store.prepare(sessionId, input) }
  return { options, store, run, archive: () => { session = { ...session, archived: true } }, expireRun: () => { active = false } }
}

describe('Agent 连接草稿会话边界', () => {
  test('Given 普通会话 When 通过真实Pi工具准备连接 Then 仅生成可恢复待审阅草稿', async () => {
    /** 用 SDK 恒等适配运行生产 execute，保存仍不在依赖中。 */
    const state = fixture()
    const sdk = { defineTool: (definition: ToolDefinition) => definition } as typeof import('@earendil-works/pi-coding-agent')
    const agent = createServerOpsConnectionDraftAgent(state.options)!
    const tool = buildServerOpsConnectionTools(sdk, agent)[0]!
    const execute = tool.execute as unknown as (id: string, input: unknown, signal?: AbortSignal) => Promise<{ details: { status: string; draftId: string } }>
    const result = await execute('call-1', draftInput)
    expect(result.details.status).toBe('pending-review')
    expect(state.store.list('session-1')[0]?.id).toBe(result.details.draftId)
    expect(state.store.list('other-session')).toEqual([])
    expect(JSON.stringify(result)).not.toContain('session-1')
    expect(state.store.list('session-1')).toHaveLength(1)
  })

  test('Given PostgreSQL 连接建议 When 通过真实 Pi 工具准备 Then 保留 database 且拒绝 preferred TLS', async () => {
    const state = fixture()
    const sdk = { defineTool: (definition: ToolDefinition) => definition } as typeof import('@earendil-works/pi-coding-agent')
    const agent = createServerOpsConnectionDraftAgent(state.options)!
    const tool = buildServerOpsConnectionTools(sdk, agent)[0]!
    const execute = tool.execute as unknown as (id: string, input: unknown) => Promise<{ details: { kind: string } }>
    await expect(execute('call-pg', { kind: 'postgresql', label: '订单库', address: 'db.example.com', port: 5432,
      transport: 'direct', username: 'reader', database: 'appdb', tlsMode: 'required' })).resolves.toMatchObject({ details: { kind: 'postgresql' } })
    expect(state.store.list('session-1')[0]?.input).toMatchObject({ kind: 'postgresql', database: 'appdb', tlsMode: 'required' })
    await expect(execute('call-pg-unsafe', { kind: 'postgresql', label: '订单库', address: 'db.example.com', port: 5432,
      transport: 'direct', database: 'appdb', tlsMode: 'preferred' })).rejects.toThrow('SERVER_OPS_CONNECTION_DRAFT_INVALID')
  })


  test('Given 只读模式与后台来源 When 构建草稿能力 Then 不创建闭包', () => {
    /** 只读、自动化、委派、外部入口均不能创建配置草稿。 */
    const state = fixture()
    expect(createServerOpsConnectionDraftAgent({ ...state.options, toolMode: 'server-ops-read' })).toBeNull()
    for (const triggeredBy of ['automation', 'delegation', 'external'] as const) {
      expect(createServerOpsConnectionDraftAgent({ ...state.options, triggeredBy })).toBeNull()
    }
    expect(createServerOpsConnectionDraftAgent({ ...state.options, getSession: () => undefined })).toBeNull()
    expect(createServerOpsConnectionDraftAgent({ ...state.options, getSession: () => ({ ...state.options.getSession(), parentSessionId: 'parent' }) })).toBeNull()
  })

  test('Given 工具已构建后归档、停止或代次过期 When 调用 Then 无草稿副作用', () => {
    for (const cause of ['archive', 'abort', 'stale', 'tool-abort'] as const) {
      /** 每个失效原因独立验证调用前的门禁。 */
      const state = fixture()
      const agent = createServerOpsConnectionDraftAgent(state.options)!
      const toolAbort = new AbortController()
      if (cause === 'archive') state.archive()
      if (cause === 'abort') state.run.abort()
      if (cause === 'stale') state.expireRun()
      if (cause === 'tool-abort') toolAbort.abort()
      expect(() => agent.prepare(draftInput, toolAbort.signal)).toThrow()
      expect(state.store.list('session-1')).toEqual([])
    }
  })

  test('Given 伪造会话或夹带凭据 When 通过工具闭包提交 Then 被主进程严格解析拒绝', () => {
    /** 不依赖模型遵守 schema，宿主再次检查每项输入。 */
    const state = fixture()
    const agent = createServerOpsConnectionDraftAgent(state.options)!
    for (const extra of [{ sessionId: 'other' }, { password: 'secret' }, { privateKey: 'secret' }, { keyPath: '/tmp/key' }]) {
      expect(() => agent.prepare({ ...draftInput, ...extra })).toThrow('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    }
    expect(state.store.list('session-1')).toEqual([])
  })
})
