import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta } from '@proma/shared'
import { createApiRequestDraft } from '@proma/shared'
import { ApiWorkbenchStore } from './api-workbench-store'
import { ApiWorkbenchService } from './api-workbench-service'
import { createApiAgentFacade } from './api-agent-facade'

/** 建立不访问真实网络、不读用户配置的 Agent 场景。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'api-agent-'))
  let session = { id: 'session', workspaceId: 'workspace' } as AgentSessionMeta
  let sends = 0
  const abort = new AbortController()
  const service = new ApiWorkbenchService({ store: new ApiWorkbenchStore(root), transport: async () => {
    sends += 1
    return { state: 'completed', hops: [], body: { rawBytes: 2, decodedBytes: 2, contentType: 'text/plain', encoding: '', preview: 'ok', previewTruncated: false, complete: true, decoded: true } }
  } })
  const options = { sessionId: 'session', toolMode: 'standard', getSession: () => session, service, runSignal: abort.signal, assertRunActive: () => { if (abort.signal.aborted) throw new Error('stopped') } }
  const facade = createApiAgentFacade(options)!
  return { facade, options, service, abort, sends: () => sends, change: (next: Partial<AgentSessionMeta>) => { session = { ...session, ...next } }, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('Agent 接口工作台授权边界', () => {
  test('Given 后台、委派或无项目会话 When 构建工具 Then 不授予接口能力', () => {
    const f = fixture()
    try {
      expect(createApiAgentFacade({ ...f.options, triggeredBy: 'automation' })).toBeUndefined()
      expect(createApiAgentFacade({ ...f.options, toolMode: 'server-ops-read' })).toBeUndefined()
      f.change({ parentSessionId: 'parent' })
      expect(createApiAgentFacade(f.options)).toBeUndefined()
    } finally { f.cleanup() }
  })
  test('Given 已准备请求 When 未授权直接发送 Then 无网络调用；批准后重复调用仍只发送一次', async () => {
    const f = fixture()
    try {
      const prepared = await f.facade.prepare({ request: { url: 'https://example.test', method: 'POST' } })
      const args = { preparedId: prepared.preparedId }
      await expect(f.facade.send(args)).rejects.toThrow('APPROVAL_REQUIRED')
      const snapshot = await f.facade.approval('api_send_request', args)
      expect(snapshot.preview.request.url).toBe('https://example.test/')
      await f.facade.authorize('api_send_request', args, snapshot)
      const first = await f.facade.send(args)
      const second = await f.facade.send(args)
      expect(first.runId).toBe(second.runId)
      expect(f.sends()).toBe(1)
      await expect(f.facade.save({ ...args, expectedRevision: 0 })).rejects.toThrow('APPROVAL_REQUIRED')
    } finally { f.cleanup() }
  })
  test('Given 审批等待中目录变化 When 批准旧快照 Then 拒绝并且不出网', async () => {
    const f = fixture()
    try {
      const prepared = await f.facade.prepare({ request: { url: 'https://example.test' } })
      const args = { preparedId: prepared.preparedId }
      const snapshot = await f.facade.approval('api_send_request', args)
      const catalog = await f.service.getCatalog('workspace')
      await f.service.saveCatalog('workspace', catalog.revision, catalog)
      await expect(f.facade.authorize('api_send_request', args, snapshot)).rejects.toThrow('STALE')
      expect(f.sends()).toBe(0)
    } finally { f.cleanup() }
  })
  test('Given 会话移到另一项目或运行停止 When 再次调用 Then 旧 facade 失效', async () => {
    const f = fixture()
    try {
      f.change({ workspaceId: 'other' })
      await expect(f.facade.list({})).rejects.toThrow('SCOPE')
      f.change({ workspaceId: 'workspace' })
      f.abort.abort()
      await expect(f.facade.list({})).rejects.toThrow()
    } finally { f.cleanup() }
  })
})

test('Given 请求测试完成 When 另行批准保存 Then 仍可保存原草稿且不重发', async () => {
  const f = fixture()
  try {
    const prepared = await f.facade.prepare({ request: { name: '已测请求', url: 'https://example.test' } })
    const args = { preparedId: prepared.preparedId }
    await f.facade.authorize('api_send_request', args, await f.facade.approval('api_send_request', args))
    await f.facade.send(args)
    const saving = { ...args, expectedRevision: prepared.catalogRevision }
    await f.facade.authorize('api_save_request', saving, await f.facade.approval('api_save_request', saving))
    const saved = await f.facade.save(saving)
    expect(saved.saved).toBe(true)
    expect((await f.service.getCatalog('workspace')).requests[0]?.name).toBe('已测请求')
    expect(f.sends()).toBe(1)
  } finally { f.cleanup() }
})

/** 直接经 IPC 保存路径写入一条人工创建的用例，模拟人在界面上的操作。 */
async function saveHumanCaseRequest(f: ReturnType<typeof fixture>): Promise<string> {
  const catalog = await f.service.getCatalog('workspace')
  const draft = {
    ...createApiRequestDraft(catalog.collections[0]?.id ?? 'default'),
    name: '人工维护的登录',
    url: 'https://example.test/login',
    assertions: [{ id: 'default_status', kind: 'status' as const, path: '', expected: '200' }],
    cases: [{
      id: 'case_human',
      name: '人工写的越权',
      assertions: [{ id: 'case_a', kind: 'status' as const, path: '', expected: '403' }],
    }],
  }
  const saved = await f.service.saveCatalog('workspace', catalog.revision, { ...catalog, requests: [{ ...draft, id: 'request_human', revision: 1, updatedAt: 1 }] })
  return saved.requests[0]!.id
}

describe('Agent 出题边界', () => {
  test('Given Agent 自己声明用例 When 批准并保存 Then 用例入库且来源盖章为 agent', async () => {
    const f = fixture()
    try {
      const prepared = await f.facade.prepare({ request: {
        name: 'Agent 建的接口', url: 'https://example.test/orders', method: 'POST',
        cases: [{ id: 'case_agent_ok', name: '下单成功', assertions: [{ id: 'case_a', kind: 'status', path: '', expected: '201' }] }],
      } })
      const saving = { preparedId: prepared.preparedId, expectedRevision: prepared.catalogRevision }
      const snapshot = await f.facade.approval('api_save_request', saving)

      expect(snapshot.save?.caseDiff).toEqual([{ caseId: 'case_agent_ok', caseName: '下单成功', source: 'agent', change: 'added', assertionCount: 1 }])
      expect(snapshot.save?.definition.cases?.[0]?.source).toBe('agent')

      await f.facade.authorize('api_save_request', saving, snapshot)
      await f.facade.save(saving)
      /** 落库的用例带来源，报告与界面据此区分谁出的题。 */
      const stored = (await f.service.getCatalog('workspace')).requests[0]
      expect(stored?.cases?.[0]?.source).toBe('agent')
      expect(stored?.cases?.[0]?.name).toBe('下单成功')
    } finally { f.cleanup() }
  })

  test('Given 人工写的用例 When Agent 改断言或删除 Then 审批前就拒绝且目录不变', async () => {
    const f = fixture()
    try {
      const requestId = await saveHumanCaseRequest(f)
      const before = (await f.service.getCatalog('workspace')).requests[0]!
      const modified = await f.facade.prepare({ requestId, request: { cases: [{ id: 'case_human', name: '人工写的越权', assertions: [{ id: 'case_a', kind: 'status', path: '', expected: '200' }] }] } })
      const removed = await f.facade.prepare({ requestId, request: { cases: [] } })

      await expect(f.facade.approval('api_save_request', { preparedId: modified.preparedId, expectedRevision: before.revision }))
        .rejects.toThrow('API_WORKBENCH_USER_CASE_PROTECTED')
      await expect(f.facade.approval('api_save_request', { preparedId: removed.preparedId, expectedRevision: before.revision }))
        .rejects.toThrow('API_WORKBENCH_USER_CASE_PROTECTED')
      expect((await f.service.getCatalog('workspace')).requests[0]?.cases).toEqual(before.cases)
    } finally { f.cleanup() }
  })

  test('Given 人工用例原样保留 When Agent 追加自己的用例 Then 保存成功且两个来源各自不变', async () => {
    const f = fixture()
    try {
      const requestId = await saveHumanCaseRequest(f)
      const before = (await f.service.getCatalog('workspace')).requests[0]!
      const humanCase = before.cases![0]!
      const prepared = await f.facade.prepare({ requestId, request: { cases: [
        humanCase,
        { id: 'case_agent_extra', name: 'Agent 补的缺参数', assertions: [{ id: 'case_b', kind: 'status', path: '', expected: '400' }] },
      ] } })
      const saving = { preparedId: prepared.preparedId, expectedRevision: before.revision }
      const snapshot = await f.facade.approval('api_save_request', saving)

      expect(snapshot.save?.caseDiff).toEqual([{ caseId: 'case_agent_extra', caseName: 'Agent 补的缺参数', source: 'agent', change: 'added', assertionCount: 1 }])

      await f.facade.authorize('api_save_request', saving, snapshot)
      await f.facade.save(saving)
      const stored = (await f.service.getCatalog('workspace')).requests[0]!
      expect(stored.cases?.map((item) => `${item.id}:${item.source}`)).toEqual(['case_human:user', 'case_agent_extra:agent'])
      expect(stored.cases?.[0]?.assertions[0]?.expected).toBe('403')
    } finally { f.cleanup() }
  })

  test('Given 按用例准备 When 读取发送审批快照 Then 带上用例身份与断言条数', async () => {
    const f = fixture()
    try {
      const requestId = await saveHumanCaseRequest(f)
      const prepared = await f.facade.prepare({ requestId, caseId: 'case_human' })

      const snapshot = await f.facade.approval('api_send_request', { preparedId: prepared.preparedId })

      expect(snapshot.send).toEqual({ caseId: 'case_human', caseName: '人工写的越权', assertionCount: 1 })
      await f.facade.authorize('api_send_request', { preparedId: prepared.preparedId }, snapshot)
      expect((await f.facade.send({ preparedId: prepared.preparedId })).caseId).toBe('case_human')
    } finally { f.cleanup() }
  })
})
