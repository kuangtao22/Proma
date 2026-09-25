import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_LIMITS, createApiRequestDraft } from '@proma/shared'
import type { ApiCatalog, ApiResolvedRequest, ApiTransportResult } from '@proma/shared'
import { ApiWorkbenchService } from './api-workbench-service'
import type { ApiWorkbenchTransport } from './api-workbench-service'
import { ApiWorkbenchStore } from './api-workbench-store'

const context = { workspaceId: 'workspace', sessionId: 'session', source: 'manual' as const }

/** 合成一次成功响应；状态码由调用方决定，用于制造断言失败。 */
function ok(preview: string, status = 200): ApiTransportResult {
  return {
    state: 'completed',
    hops: [{
      url: 'https://example.test/', method: 'GET', requestHeaders: [], requestHeadersSource: 'configured', status, statusText: 'OK', httpVersion: '1.1',
      responseHeaders: [], trailers: [], timings: { dnsMs: null, connectMs: null, tlsMs: null, sendMs: null, ttfbMs: null, downloadMs: null, totalMs: 5 },
      connection: { reused: false },
    }],
    body: { rawBytes: preview.length, decodedBytes: preview.length, contentType: 'application/json', encoding: 'utf-8', preview, previewTruncated: false, complete: true, decoded: true },
  }
}

/** 取消的终态：与真实传输层一致，没有逐跳事实。 */
function cancelled(): ApiTransportResult {
  return {
    state: 'cancelled', hops: [],
    body: { rawBytes: 0, decodedBytes: 0, contentType: '', encoding: '', preview: '', previewTruncated: false, complete: false, decoded: false },
  }
}

/**
 * 单测环境没有系统安全存储：注入可用替身，让 secret 提取与加密产物都能正常落盘。
 * 值只在临时数据根里，测试结束即随目录删除。
 */
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: (): 'basic_text' => 'basic_text',
  encryptString: (value: string) => Buffer.from(`enc:${value}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ''),
}

/** 登录 → 用户详情 → 创建订单 的三步流程；每步都引用已保存请求。 */
function catalog(): ApiCatalog {
  const base = createApiRequestDraft('default')
  return {
    version: 1, revision: 7,
    collections: [{ id: 'default', name: '后台', description: '', variables: [] }],
    environments: [{ id: 'env_test', name: '测试环境', kind: 'test', variables: [] }],
    requests: [
      {
        ...base, id: 'request_login', revision: 1, updatedAt: 1, name: '登录', method: 'POST', url: 'https://example.test/login',
        extractions: [{ id: 'ex_token', name: 'token', from: 'json', path: 'token', secret: true }],
        assertions: [{ id: 'a_login', kind: 'status', path: '', expected: '200' }],
      },
      {
        ...base, id: 'request_profile', revision: 1, updatedAt: 1, name: '用户详情', method: 'GET', url: 'https://example.test/profile',
        headers: [{ id: 'h_auth', name: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
        assertions: [{ id: 'a_profile', kind: 'status', path: '', expected: '200' }],
      },
      {
        ...base, id: 'request_orders', revision: 1, updatedAt: 1, name: '创建订单', method: 'POST', url: 'https://example.test/orders',
        assertions: [{ id: 'a_order', kind: 'status', path: '', expected: '200' }],
      },
    ],
    scenarios: [{
      id: 'scenario_order_flow', name: '下单主流程', description: '', collectionId: 'default', folder: '订单模块',
      steps: [
        { id: 'step_login', name: '登录', requestId: 'request_login' },
        { id: 'step_profile', name: '用户详情', requestId: 'request_profile' },
        { id: 'step_order', name: '创建订单', requestId: 'request_orders' },
      ],
      environmentId: 'env_test', onFailure: 'stop', revision: 1, updatedAt: 1,
    }],
  }
}

/** 建立不访问真实网络的服务：按 URL 返回合成响应，并记录真正发出的请求。 */
function fixture(options: { transport?: ApiWorkbenchTransport; now?: () => number } = {}) {
  /** macOS 的 /tmp 经 /var→/private/var realpath 会变一层，先固定根目录让断言稳定。 */
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'api-scenario-')))
  const sent: ApiResolvedRequest[] = []
  const transport = options.transport ?? (async (request: ApiResolvedRequest) => {
    sent.push(request)
    if (request.url.includes('/login')) return ok('{"token":"fixture-token-1"}')
    if (request.url.includes('/profile')) return ok('{"id":90071992547409931234}')
    return ok('{"created":true}')
  })
  const service = new ApiWorkbenchService({ store: new ApiWorkbenchStore(root, { safeStorage }), transport, ...(options.now ? { now: options.now } : {}) })
  return { root, service, sent, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 保存流程目录，返回服务与夹具。 */
async function fixtureWithCatalog(options: { transport?: ApiWorkbenchTransport; now?: () => number } = {}) {
  const f = fixture(options)
  const saved = await f.service.saveCatalog('workspace', 0, catalog())
  return { ...f, saved }
}

describe('场景（流程）执行', () => {
  test('Given 三步流程 When 跑一次 Then 顺序出网、第二步带上第一步提取的 token', async () => {
    const f = await fixtureWithCatalog()
    try {
      const preview = await f.service.prepareScenario(context, { scenarioId: 'scenario_order_flow' })

      expect(preview.steps.map((step) => `${step.index}:${step.method}:${step.url}`)).toEqual([
        '0:POST:https://example.test/login',
        '1:GET:https://example.test/profile',
        '2:POST:https://example.test/orders',
      ])
      expect(preview.steps.map((step) => step.assertionCount)).toEqual([1, 1, 1])
      expect(preview.warnings).toEqual([])

      const run = await f.service.runScenario(context, preview.preparedId)

      expect(run.state).toBe('completed')
      expect(run.steps.map((step) => `${step.name}:${step.state}`)).toEqual(['登录:passed', '用户详情:passed', '创建订单:passed'])
      /** 每一步都有真实运行记录身份，流程结论可以逐条回溯。 */
      expect(run.steps.every((step) => step.runId !== undefined)).toBe(true)
      /** 顺序即声明顺序，且第二步真的带上了第一步提取出来的 token。 */
      expect(f.sent.map((request) => request.url)).toEqual(['https://example.test/login', 'https://example.test/profile', 'https://example.test/orders'])
      expect(f.sent[1]?.headers.find((header) => header.name === 'Authorization')?.value).toBe('Bearer fixture-token-1')
      /** 流程结论按步骤聚合，且摘要里只有结论，没有正文与大整数原文。 */
      expect(run.assertions.map((item) => item.passed)).toEqual([true, true, true])
      expect(JSON.stringify(run)).not.toContain('90071992547409931234')
      expect(JSON.stringify(run)).not.toContain('fixture-token-1')
    } finally { f.cleanup() }
  })

  test('Given 某步断言失败 When 跑流程 Then 默认 stop 且后续步骤标为跳过', async () => {
    const f = await fixtureWithCatalog({
      transport: async (request: ApiResolvedRequest) => {
        f.sent.push(request)
        if (request.url.includes('/login')) return ok('{"token":"fixture-token-1"}')
        /** 第二步返回 500：用例断言期望 200 → 该步失败。 */
        if (request.url.includes('/profile')) return ok('{"error":true}', 500)
        return ok('{"created":true}')
      },
    })
    try {
      const preview = await f.service.prepareScenario(context, { scenarioId: 'scenario_order_flow' })
      const run = await f.service.runScenario(context, preview.preparedId)

      expect(run.state).toBe('failed')
      expect(run.steps.map((step) => step.state)).toEqual(['passed', 'failed', 'skipped'])
      expect(run.steps[1]?.status).toBe(500)
      expect(run.steps[2]?.message).toContain('stop 策略')
      /** 第三步绝不能被发出：失败之后不替人补请求。 */
      expect(f.sent).toHaveLength(2)
      expect(run.error?.code).toBe('API_WORKBENCH_SCENARIO_FAILED')
    } finally { f.cleanup() }
  })

  test('Given 失败策略为 continue When 某步失败 Then 后续步骤照跑但流程结论仍是失败', async () => {
    const f = await fixtureWithCatalog({
      transport: async (request: ApiResolvedRequest) => {
        f.sent.push(request)
        if (request.url.includes('/login')) return ok('{"token":"fixture-token-1"}')
        if (request.url.includes('/profile')) return ok('{"error":true}', 500)
        return ok('{"created":true}')
      },
    })
    try {
      const saved = await f.service.getCatalog('workspace')
      /** 把失败策略改成 continue：某步失败不影响后续步骤执行。 */
      await f.service.saveCatalog('workspace', saved.revision, { ...saved, scenarios: [{ ...saved.scenarios![0]!, onFailure: 'continue' }] })

      const preview = await f.service.prepareScenario(context, { scenarioId: 'scenario_order_flow' })

      expect(preview.warnings).toEqual(['失败策略为 continue：某一步失败后仍会继续执行后续步骤'])
      const run = await f.service.runScenario(context, preview.preparedId)

      expect(run.steps.map((step) => step.state)).toEqual(['passed', 'failed', 'passed'])
      expect(run.state).toBe('failed')
      expect(f.sent).toHaveLength(3)
    } finally { f.cleanup() }
  })

  test('Given 流程引用的接口已被删除 When 准备 Then 给出可行动错误且不出网', async () => {
    const f = await fixtureWithCatalog()
    try {
      const saved = await f.service.getCatalog('workspace')
      await f.service.saveCatalog('workspace', saved.revision, { ...saved, requests: saved.requests.filter((item) => item.id !== 'request_profile') })

      await expect(f.service.prepareScenario(context, { scenarioId: 'scenario_order_flow' }))
        .rejects.toThrow('API_WORKBENCH_SCENARIO_REQUEST_NOT_FOUND: 第 2 步引用的接口已不存在')
      expect(f.sent).toHaveLength(0)
    } finally { f.cleanup() }
  })

  test('Given 准备后被编辑过目录 When 运行 Then 整流程拒绝（批准的是当时那一份）', async () => {
    const f = await fixtureWithCatalog()
    try {
      const preview = await f.service.prepareScenario(context, { scenarioId: 'scenario_order_flow' })
      const saved = await f.service.getCatalog('workspace')
      await f.service.saveCatalog('workspace', saved.revision, saved)

      await expect(f.service.runScenario(context, preview.preparedId)).rejects.toThrow('API_WORKBENCH_SCENARIO_PREPARED_STALE')
      expect(f.sent).toHaveLength(0)
    } finally { f.cleanup() }
  })

  test('Given 同一个场景身份 When 重复调用运行 Then 只跑一遍且拿到同一份结论', async () => {
    const f = await fixtureWithCatalog()
    try {
      const preview = await f.service.prepareScenario(context, { scenarioId: 'scenario_order_flow' })
      const first = await f.service.runScenario(context, preview.preparedId)
      const second = await f.service.runScenario(context, preview.preparedId)

      expect(second.id).toBe(first.id)
      expect(f.sent).toHaveLength(3)
    } finally { f.cleanup() }
  })

  test('Given 流程总时限已到 When 跑流程 Then 未执行的步骤跳过并给出超时原因', async () => {
    /** 时钟在第一步之后跳过一个总时限：模拟慢步骤把预算耗尽。 */
    let clock = 1_000_000
    const f = await fixtureWithCatalog({
      now: () => clock,
      transport: async (request: ApiResolvedRequest) => {
        f.sent.push(request)
        clock += API_LIMITS.scenarioTotalMs + 1
        return ok('{"token":"fixture-token-1"}')
      },
    })
    try {
      const preview = await f.service.prepareScenario(context, { scenarioId: 'scenario_order_flow' })
      const run = await f.service.runScenario(context, preview.preparedId)

      expect(run.steps.map((step) => step.state)).toEqual(['passed', 'skipped', 'skipped'])
      expect(run.state).toBe('failed')
      expect(run.error?.code).toBe('API_WORKBENCH_SCENARIO_TIMEOUT')
      expect(f.sent).toHaveLength(1)
    } finally { f.cleanup() }
  })

  test('Given 流程正在跑 When 取消 Then 当前步骤取消、后续跳过且结论为 cancelled', async () => {
    const abort = new AbortController()
    const f = await fixtureWithCatalog({
      transport: async (request: ApiResolvedRequest, transportOptions) => {
        f.sent.push(request)
        if (request.url.includes('/login')) return ok('{"token":"fixture-token-1"}')
        /** 第二步在途时取消（AbortSignal 不重放事件，必须等监听注册后再触发），模拟人点了「取消流程」。 */
        setTimeout(() => abort.abort(), 0)
        return new Promise<ApiTransportResult>((resolve) => {
          if (transportOptions.signal?.aborted) { resolve(cancelled()); return }
          transportOptions.signal?.addEventListener('abort', () => resolve(cancelled()), { once: true })
        })
      },
    })
    try {
      const preview = await f.service.prepareScenario(context, { scenarioId: 'scenario_order_flow' })
      const run = await f.service.runScenario(context, preview.preparedId, abort.signal)

      expect(run.state).toBe('cancelled')
      expect(run.steps[0]?.state).toBe('passed')
      expect(run.steps[2]?.state).toBe('skipped')
      expect(f.sent).toHaveLength(2)
    } finally { f.cleanup() }
  })

  test('Given 跑过一次流程 When 重开数据根 Then 摘要仍在且只含步骤身份与结论', async () => {
    const f = await fixtureWithCatalog()
    try {
      const preview = await f.service.prepareScenario(context, { scenarioId: 'scenario_order_flow' })
      const run = await f.service.runScenario(context, preview.preparedId)

      /** 新实例读同一数据根：场景摘要与每步运行都留下来了。 */
      const reopened = new ApiWorkbenchStore(f.root, { safeStorage })
      const listed = reopened.listScenarioRuns('workspace')

      expect(listed.runs.map((item) => item.id)).toEqual([run.id])
      expect(listed.runs[0]?.steps.map((step) => step.stepId)).toEqual(['step_login', 'step_profile', 'step_order'])
      expect(JSON.stringify(listed)).not.toContain('fixture-token-1')
      expect(reopened.getRun('workspace', run.steps[0]!.runId!).hops[0]?.status).toBe(200)
      /** 每步的完整证据仍在各自运行记录里，场景摘要不是唯一事实来源。 */
      expect(reopened.getRun('workspace', run.steps[2]!.runId!).request.url).toBe('https://example.test/orders')
    } finally { f.cleanup() }
  })
})
