import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiResolvedRequest, ApiSseEvent, ApiTransportResult } from '@proma/shared'
import { API_LIMITS, createApiRequestDraft } from '@proma/shared'
import { ApiWorkbenchService } from './api-workbench-service'
import { ApiWorkbenchStore } from './api-workbench-store'

const completed: ApiTransportResult = {
  state: 'completed', hops: [],
  body: { rawBytes: 2, decodedBytes: 2, contentType: 'text/plain', encoding: 'utf-8', preview: 'ok', previewTruncated: false, complete: true, decoded: true },
}
const context = { workspaceId: 'workspace', sessionId: 'session', source: 'manual' as const }

/** 构造可复用的事件流条目。 */
function sseEvent(index: number, data = 'x'): ApiSseEvent {
  return { index, receivedMs: index, event: 'message', id: '', comment: '', data, raw: `data: ${data}\n`, truncated: false }
}

describe('接口工作台 Service', () => {
  test('Given 首个请求提取秘密变量 When 后续请求引用 Then 复用取值且任何记录都不含明文', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-service-extract-'))
    try {
      const store = new ApiWorkbenchStore(root)
      const seen: ApiResolvedRequest[] = []
      const service = new ApiWorkbenchService({
        store,
        transport: async (request) => {
          seen.push(request)
          return { ...completed, body: { ...completed.body, preview: '{"token":"tok_live_7"}' } }
        },
      })
      const login = {
        ...createApiRequestDraft(), url: 'https://example.test/login', method: 'POST' as const,
        extractions: [{ id: 'ex_1', name: 'token', from: 'json' as const, path: 'token', secret: true }],
      }
      const run = await service.send(context, (await service.prepare(context, { request: login })).preparedId)

      expect(run.extracted).toEqual([{ id: 'ex_1', name: 'token', from: 'json', found: true, secret: true }])
      expect(service.getRuntimeVariables('workspace')).toEqual([{ name: 'token', secret: true, source: '请求「新请求」', updatedAt: expect.any(Number) }])

      /** 第二个请求用 {{token}} 引用提取值，解析发生在主进程。 */
      const next = {
        ...createApiRequestDraft(), url: 'https://example.test/me',
        headers: [{ id: 'h', name: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
      }
      await service.send(context, (await service.prepare(context, { request: next })).preparedId)

      expect(seen[1]?.headers.find((header) => header.name === 'Authorization')?.value).toBe('Bearer tok_live_7')
      expect(JSON.stringify(store.getRun('workspace', run.id))).not.toContain('tok_live_7')
      expect(JSON.stringify(service.getRuntimeVariables('workspace'))).not.toContain('tok_live_7')
      expect(service.clearRuntimeVariables('workspace')).toBe(1)
      expect(service.getRuntimeVariables('workspace')).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 提取未命中或运行失败 When 完成 Then 不写入运行时变量并说明原因', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-service-extract-miss-'))
    try {
      const store = new ApiWorkbenchStore(root)
      let failing = false
      const service = new ApiWorkbenchService({
        store,
        transport: async () => failing
          ? { state: 'failed', hops: [], body: completed.body, error: { code: 'API_CONNECT_FAILED', phase: 'connect', message: '连接失败' } }
          : { ...completed, body: { ...completed.body, preview: '{}' } },
      })
      const rules = [{ id: 'ex_1', name: 'token', from: 'json' as const, path: 'missing', secret: false }]
      const missing = await service.send(context, (await service.prepare(context, { request: { ...createApiRequestDraft(), url: 'https://example.test/a', extractions: rules } })).preparedId)

      expect(missing.extracted?.[0]).toMatchObject({ found: false })
      expect(missing.extracted?.[0]?.message).toContain('没有该路径')
      expect(service.getRuntimeVariables('workspace')).toEqual([])

      failing = true
      const skipped = await service.send(context, (await service.prepare(context, { request: { ...createApiRequestDraft(), url: 'https://example.test/b', extractions: [{ ...rules[0]!, name: 'other' }] } })).preparedId)

      expect(skipped.extracted?.[0]).toMatchObject({ found: false, message: '运行未正常完成，已跳过提取' })
      expect(service.getRuntimeVariables('workspace')).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 事件流运行 When 收到增量 Then 广播脱敏事件并在终态保留明细', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-service-sse-'))
    try {
      const store = new ApiWorkbenchStore(root)
      const broadcast: ApiSseEvent[][] = []
      const service = new ApiWorkbenchService({
        store,
        onStream: (event) => broadcast.push(event.events),
        transport: async (_request, options) => {
          options.onEvent?.([sseEvent(0, 'alpha-secret')])
          options.onEvent?.([sseEvent(1, 'ok')])
          return { ...completed, sse: { totalEvents: 2, firstEventMs: 3, endedReason: 'completed' } }
        },
      })
      const request = { ...createApiRequestDraft(), url: 'https://example.test/stream', auth: { type: 'bearer' as const, value: { value: 'alpha-secret' } } }
      const run = await service.send(context, (await service.prepare(context, { request })).preparedId)

      expect(run.sse?.events.map((event) => event.data)).toEqual(['[REDACTED]', 'ok'])
      expect(run.sse).toMatchObject({ totalEvents: 2, firstEventMs: 3, droppedEvents: 0, endedReason: 'completed' })
      expect(broadcast.flat()).toHaveLength(2)
      expect(JSON.stringify(broadcast)).not.toContain('alpha-secret')
      expect(new ApiWorkbenchStore(root).getRun('workspace', run.id).sse?.events).toHaveLength(2)
      expect(store.listRuns('workspace').runs[0]?.sse?.events).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 事件超过运行上限 When 收到增量 Then 只保留上限内事件并记录丢弃数量', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-service-sse-limit-'))
    try {
      const store = new ApiWorkbenchStore(root)
      const broadcast: ApiSseEvent[][] = []
      const service = new ApiWorkbenchService({
        store,
        onStream: (event) => broadcast.push(event.events),
        transport: async (_request, options) => {
          options.onEvent?.(Array.from({ length: API_LIMITS.sseEvents + 5 }, (_, index) => sseEvent(index)))
          return { ...completed, sse: { totalEvents: API_LIMITS.sseEvents + 5, firstEventMs: 1, endedReason: 'completed' } }
        },
      })
      const request = { ...createApiRequestDraft(), url: 'https://example.test/stream' }
      const run = await service.send(context, (await service.prepare(context, { request })).preparedId)

      expect(run.sse?.events).toHaveLength(API_LIMITS.sseEvents)
      expect(run.sse).toMatchObject({ totalEvents: API_LIMITS.sseEvents + 5, droppedEvents: 5 })
      expect(broadcast.flat()).toHaveLength(API_LIMITS.sseEvents)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 同一 preparedId When 并发和完成后重复 send Then 仅出网一次并返回同一 run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-service-'))
    try {
      let calls = 0
      let release: (() => void) | undefined
      const transport = async (_request: ApiResolvedRequest): Promise<ApiTransportResult> => {
        calls += 1
        await new Promise<void>((resolve) => { release = resolve })
        return completed
      }
      const store = new ApiWorkbenchStore(root)
      const service = new ApiWorkbenchService({ store, transport, uuid: (() => { let id = 0; return () => `id_${++id}` })() })
      const request = { ...createApiRequestDraft(), url: 'https://example.test' }
      const prepared = await service.prepare(context, { request })
      expect((await service.getPrepared(context, prepared.preparedId)).preparedId).toBe(prepared.preparedId)
      const first = service.send(context, prepared.preparedId)
      const second = service.send(context, prepared.preparedId)
      expect(service.hasActiveRequests()).toBe(true)
      await Bun.sleep(0)
      release?.()
      const [a, b] = await Promise.all([first, second])
      const third = await service.send(context, prepared.preparedId)
      expect(calls).toBe(1)
      expect(a.id).toBe(b.id)
      expect(third.id).toBe(a.id)
      expect(service.hasActiveRequests()).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 排队和活动请求 When 取消 Then 不派发排队项且迟到结果不覆盖 cancelled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-service-'))
    try {
      const releases: Array<() => void> = []
      let calls = 0
      const transport = async (_request: ApiResolvedRequest, options: { signal?: AbortSignal }): Promise<ApiTransportResult> => {
        calls += 1
        await new Promise<void>((resolve) => { releases.push(resolve); options.signal?.addEventListener('abort', () => resolve(), { once: true }) })
        return completed
      }
      const service = new ApiWorkbenchService({ store: new ApiWorkbenchStore(root), transport })
      const request = { ...createApiRequestDraft(), url: 'https://same.test' }
      const prepared = await Promise.all([1, 2, 3].map(() => service.prepare(context, { request })))
      const sends = prepared.map((entry) => service.send(context, entry.preparedId))
      await Bun.sleep(0)
      await service.cancel(context, prepared[2]!.preparedId)
      await service.cancel(context, prepared[0]!.preparedId)
      releases.forEach((release) => release())
      const runs = await Promise.all(sends)
      expect(calls).toBe(2)
      expect(runs[0]?.state).toBe('cancelled')
      expect(runs[0]?.body.preview).toBe('ok')
      expect(runs[2]?.state).toBe('cancelled')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 已执行 prepared When TTL 和 catalog revision 已变化 Then 重复 send 仍返回原 run 且不出网', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-service-'))
    try {
      let now = 1
      let calls = 0
      const store = new ApiWorkbenchStore(root, { now: () => now })
      const service = new ApiWorkbenchService({ store, now: () => now, transport: async () => { calls += 1; return completed } })
      const request = { ...createApiRequestDraft(), url: 'https://example.test' }
      const prepared = await service.prepare(context, { request })
      const first = await service.send(context, prepared.preparedId)
      now = prepared.expiresAt + 1
      const current = await service.getCatalog(context.workspaceId)
      await service.saveCatalog(context.workspaceId, current.revision, current)
      const repeated = await service.send(context, prepared.preparedId)
      expect(repeated.id).toBe(first.id)
      expect(calls).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 同 workspace 不同 Agent session 历史 When listRuns Then 仅返回当前 session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-service-'))
    try {
      const service = new ApiWorkbenchService({ store: new ApiWorkbenchStore(root), transport: async () => completed })
      const request = { ...createApiRequestDraft(), url: 'https://example.test' }
      const firstContext = { ...context, source: 'agent' as const }
      const secondContext = { ...firstContext, sessionId: 'session_2' }
      await service.send(firstContext, (await service.prepare(firstContext, { request })).preparedId)
      await service.send(secondContext, (await service.prepare(secondContext, { request })).preparedId)
      const history = await service.listRuns(firstContext, { limit: 50 })
      expect(history.runs.map((run) => run.sessionId)).toEqual(['session'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given transport 在所有公开字段回显秘密 When 完成 Then hop/error/assertion 均脱敏', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-service-'))
    try {
      const leaked: ApiTransportResult = {
        state: 'failed',
        hops: [{
          url: 'https://example.test/path/alpha?echo=alpha', method: 'GET',
          requestHeaders: [{ name: 'X-Echo', value: 'alpha' }], requestHeadersSource: 'captured',
          status: 500, statusText: 'alpha', httpVersion: '1.1',
          responseHeaders: [{ name: 'X-Echo', value: 'alpha' }], trailers: [{ name: 'X-Trailer', value: 'alpha' }],
          timings: { dnsMs: null, connectMs: null, tlsMs: null, sendMs: null, ttfbMs: null, downloadMs: null, totalMs: 1 },
          connection: { reused: false },
        }],
        body: { rawBytes: 17, decodedBytes: 17, contentType: 'application/json', encoding: 'utf-8', preview: '{"value":"alpha"}', previewTruncated: false, complete: true, decoded: true },
        error: { code: 'REMOTE', phase: 'response', message: 'remote alpha' },
      }
      const service = new ApiWorkbenchService({ store: new ApiWorkbenchStore(root), transport: async () => leaked })
      const request = {
        ...createApiRequestDraft(),
        url: 'https://example.test',
        auth: { type: 'bearer' as const, value: { value: 'alpha' } },
        assertions: [{ id: 'secret-assertion', kind: 'json-value' as const, path: 'value', expected: 'alpha' }],
      }
      const run = await service.send(context, (await service.prepare(context, { request })).preparedId)
      expect(JSON.stringify(run)).not.toContain('alpha')
      expect(run.assertions[0]).toMatchObject({ expected: '[REDACTED]', actual: '[REDACTED]' })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
