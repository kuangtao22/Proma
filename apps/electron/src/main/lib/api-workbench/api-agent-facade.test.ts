import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta } from '@proma/shared'
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
