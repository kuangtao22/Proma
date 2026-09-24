import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiRequestDraft } from '@proma/shared'
import type { ApiRun } from '@proma/shared'
import { ApiWorkbenchStore } from './api-workbench-store'
import { ApiWorkbenchService } from './api-workbench-service'

/** 合成系统保护替身，仅处理测试值。 */
const secure = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'unknown' as const, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() }
/** 最小公开记录；测试文件不访问真实 API。 */
function run(id = 'run'): ApiRun {
  return { id, workspaceId: 'workspace', sessionId: 'session', source: 'manual', requestName: id, catalogRevision: 0, createdAt: Date.now(), state: 'queued', request: { method: 'GET', url: 'https://example.test', headers: [], body: '', timeoutMs: 1000, followRedirects: false, maxRedirects: 0, sensitiveHeaderNames: [], sensitiveQueryNames: [] }, hops: [], body: { rawBytes: 0, decodedBytes: 0, contentType: '', encoding: '', preview: '', previewTruncated: false, complete: true, decoded: true }, assertions: [], recording: 'saved', pinned: false }
}

describe('接口持久化与容量边界', () => {
  test('Given 修改秘密后 catalog 提交失败 When 重读旧定义 Then 旧凭据仍生效', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-atomic-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage: secure })
      const catalog = store.getCatalog('workspace')
      const request = { ...createApiRequestDraft(), id: 'req', revision: 1, updatedAt: 1, auth: { type: 'bearer' as const, value: { value: 'old-secret' } } }
      const first = store.saveCatalog('workspace', 0, { ...catalog, requests: [request] })
      const priorRef = first.requests[0]!.auth.value.secretRef!
      const writer = store as unknown as { writeJson(path: string, value: object, prior?: object): void }
      const original = writer.writeJson.bind(store)
      writer.writeJson = (path, value, prior) => { if (path.endsWith('catalog.json')) throw new Error('synthetic disk failure'); original(path, value, prior) }
      expect(() => store.saveCatalog('workspace', first.revision, { ...first, requests: [{ ...first.requests[0]!, auth: { type: 'bearer', value: { value: 'new-secret' } } }] })).toThrow('synthetic disk failure')
      expect(store.getCatalog('workspace').revision).toBe(first.revision)
      expect(store.resolveSecret('workspace', priorRef, 'request:req:auth:value')?.value).toBe('old-secret')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('Given 原始响应头已保存 When 同进程 reveal Then 返回原头且持久终态不缓存明文', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-reveal-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage: secure })
      const input = run()
      store.createRun(input, input.request)
      const hop = { url: input.request.url, method: input.request.method, requestHeaders: [], requestHeadersSource: 'configured' as const, status: 200, statusText: 'OK', httpVersion: '1.1', responseHeaders: [{ name: 'Set-Cookie', value: 'session=original' }], trailers: [], timings: { dnsMs: null, connectMs: null, tlsMs: null, sendMs: null, ttfbMs: null, downloadMs: null, totalMs: 1 }, connection: { reused: false } }
      store.saveRawDetails('workspace', input.id, input.request, [hop])
      store.updateRun('workspace', input.id, ['queued'], (current) => ({ ...current, state: 'completed', hops: [{ ...hop, responseHeaders: [{ name: 'Set-Cookie', value: '[REDACTED]' }] }] }))
      expect(store.getRun('workspace', input.id, true).hops[0]?.responseHeaders[0]?.value).toBe('session=original')
      expect((store as unknown as { volatileRuns: Map<string, unknown> }).volatileRuns.size).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('Given 收藏已用满条数预算 When 创建新运行 Then 明确拒绝而非删除刚完成记录', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-capacity-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage: secure, historyCount: 1 })
      const first = run('first')
      store.createRun(first, first.request)
      store.updateRun('workspace', 'first', ['queued'], (current) => ({ ...current, state: 'completed', pinned: true }))
      expect(() => store.createRun(run('second'), first.request)).toThrow('CAPACITY_LIMIT')
      expect(store.getRun('workspace', 'first').pinned).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('Given 历史文件损坏 When 查看历史 Then 明确失败而非静默消失', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-history-'))
    try {
      const store = new ApiWorkbenchStore(root)
      const first = run()
      store.createRun(first, first.request)
      const folder = join(root, 'api-workbench/workspaces/workspace/runs/run')
      for (const name of ['record.json', 'record.json.bak', 'summary.json', 'summary.json.bak']) writeFileSync(join(folder, name), '{broken')
      expect(() => store.listRuns('workspace')).toThrow()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('Given 网络成功而原始详情写入失败 When 完成 Then recording失败且不重发', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-recording-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage: secure })
      store.saveRawDetails = () => { throw new Error('synthetic') }
      let calls = 0
      const service = new ApiWorkbenchService({ store, transport: async () => { calls++; return { state: 'completed', hops: [], body: run().body } } })
      const context = { workspaceId: 'workspace', sessionId: 'session', source: 'manual' as const }
      const prepared = await service.prepare(context, { request: { ...createApiRequestDraft(), url: 'https://example.test' } })
      const result = await service.send(context, prepared.preparedId)
      expect(result.state).toBe('completed')
      expect(result.recording).toBe('failed')
      await service.send(context, prepared.preparedId)
      expect(calls).toBe(1)
      expect(readFileSync(join(root, 'api-workbench/workspaces/workspace/runs', result.id, 'record.json'), 'utf8')).toContain('"recording": "failed"')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('Given 无系统安全存储 When 保存并 reveal 原始头 Then 内存原文可用', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-memory-'))
    try {
      const store = new ApiWorkbenchStore(root)
      const input = run()
      store.createRun(input, input.request)
      const hop = { url: input.request.url, method: input.request.method, requestHeaders: [], requestHeadersSource: 'configured' as const, status: 200, statusText: 'OK', httpVersion: '1.1', responseHeaders: [{ name: 'Set-Cookie', value: 'original-cookie' }], trailers: [], timings: { dnsMs: null, connectMs: null, tlsMs: null, sendMs: null, ttfbMs: null, downloadMs: null, totalMs: 1 }, connection: { reused: false } }
      store.saveRawDetails('workspace', input.id, input.request, [hop])
      store.updateRun('workspace', input.id, ['queued'], (current) => ({ ...current, state: 'completed', hops: [{ ...hop, responseHeaders: [{ name: 'Set-Cookie', value: '[REDACTED]' }] }] }))
      expect(store.getRun('workspace', input.id, true).hops[0]?.responseHeaders[0]?.value).toBe('original-cookie')
      expect(store.getRun('workspace', input.id).recording).toBe('memory-only')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('Given 普通历史可删但受保护记录仍占满预算 When 拒绝新运行 Then 普通历史保持完整', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-capacity-preserve-'))
    try {
      const store = new ApiWorkbenchStore(root, { historyCount: 3 })
      for (const id of ['ordinary', 'pinned', 'active']) {
        const input = run(id)
        store.createRun(input, input.request)
        if (id !== 'active') store.updateRun('workspace', id, ['queued'], (current) => ({ ...current, state: 'completed', pinned: id === 'pinned' }))
      }
      /** 模拟预算缩小后仍有收藏与在途记录，删除 ordinary 也无法满足新运行。 */
      ;(store as unknown as { dependencies: { historyCount: number } }).dependencies.historyCount = 2
      expect(() => store.createRun(run('next'), run().request)).toThrow('CAPACITY_LIMIT')
      expect(store.listRuns('workspace').runs.map((entry) => entry.id).sort()).toEqual(['active', 'ordinary', 'pinned'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test.each(['summary.json', 'private.json'])('Given 初始化 %s 写失败 When createRun Then 清理未派发目录与密钥', (filename) => {
    const root = mkdtempSync(join(tmpdir(), 'api-create-rollback-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage: secure })
      const writer = store as unknown as { writeJson(path: string, value: object, prior?: object): void; volatileRuns: Map<string, unknown> }
      const original = writer.writeJson.bind(store)
      writer.writeJson = (path, value, prior) => { if (path.endsWith(filename)) throw new Error('synthetic disk failure'); original(path, value, prior) }
      expect(() => store.createRun(run(), run().request)).toThrow('synthetic disk failure')
      expect(existsSync(join(root, 'api-workbench/workspaces/workspace/runs/run'))).toBe(false)
      expect(writer.volatileRuns.size).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('Given record 已提交而 summary 写失败 When 更新终态 Then 仍释放明文与密钥', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-summary-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage: secure })
      store.createRun(run(), run().request)
      const writer = store as unknown as { writeJson(path: string, value: object, prior?: object): void; volatileRuns: Map<string, { key?: Buffer }> }
      const key = [...writer.volatileRuns.values()][0]!.key!
      const original = writer.writeJson.bind(store)
      writer.writeJson = (path, value, prior) => { if (path.endsWith('summary.json')) throw new Error('synthetic'); original(path, value, prior) }
      expect(() => store.updateRun('workspace', 'run', ['queued'], (current) => ({ ...current, state: 'completed' }))).toThrow('synthetic')
      expect(store.getRun('workspace', 'run').state).toBe('completed')
      expect(writer.volatileRuns.size).toBe(0)
      expect(key.every((byte) => byte === 0)).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('Given 请求已执行而终态写入持续失败 When 重复 send Then 返回相同失败终态且网络只发一次', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-terminal-failure-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage: secure })
      let calls = 0
      const service = new ApiWorkbenchService({ store, transport: async () => {
        calls++
        store.updateRun = () => { throw new Error('synthetic full disk') }
        return { state: 'completed', hops: [], body: run().body }
      } })
      const context = { workspaceId: 'workspace', sessionId: 'session', source: 'manual' as const }
      const prepared = await service.prepare(context, { request: { ...createApiRequestDraft(), url: 'https://example.test' } })
      const first = await service.send(context, prepared.preparedId)
      const repeat = await service.send(context, prepared.preparedId)
      expect(first.state).toBe('failed')
      expect(repeat.id).toBe(first.id)
      expect(repeat.state).toBe(first.state)
      expect(repeat.recording).toBe('failed')
      expect(repeat.error).toEqual(first.error)
      expect(calls).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 磁盘不可写 When 取消在途请求 Then 仍立即中止网络且不会重发', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-cancel-disk-'))
    try {
      const store = new ApiWorkbenchStore(root)
      let aborted = false
      const service = new ApiWorkbenchService({ store, transport: async (_request, options) => {
        await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
        return { state: 'cancelled', hops: [], body: run().body }
      } })
      const context = { workspaceId: 'workspace', sessionId: 'session', source: 'manual' as const }
      const prepared = await service.prepare(context, { request: { ...createApiRequestDraft(), url: 'https://example.test' } })
      const pending = service.send(context, prepared.preparedId)
      store.updateRun = () => { throw new Error('synthetic full disk') }
      await expect(service.cancel(context, prepared.preparedId)).rejects.toThrow('synthetic full disk')
      expect(aborted).toBe(true)
      expect((await pending).state).toBe('cancelled')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

})
