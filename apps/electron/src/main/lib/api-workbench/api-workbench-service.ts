import { randomUUID } from 'node:crypto'
import {
  API_LIMITS,
  parseApiCatalog,
  parseApiId,
  parseApiPreparedPreview,
  parseApiRequestDraft,
  parseApiRun,
} from '@proma/shared'
import type {
  ApiBodySlice,
  ApiCatalog,
  ApiExtractionOutcome,
  ApiField,
  ApiPreparedPreview,
  ApiResolvedRequest,
  ApiRun,
  ApiRunChanged,
  ApiRunStreamChanged,
  ApiSseEvent,
  ApiRuntimeVariable,
  ApiTransportResult,
} from '@proma/shared'
import { evaluateApiAssertions } from './api-assertions'
import { evaluateApiExtractions } from './api-extractions'
import { redactApiBody, redactApiRequest } from './api-redaction'
import { resolveApiRequest } from './api-request-resolver'
import type { ApiWorkbenchStore } from './api-workbench-store'
import { createEmptyApiBody } from './api-workbench-store'

const PREPARED_TTL_MS = 10 * 60 * 1000
const MAX_GLOBAL_ACTIVE = 4
const MAX_ORIGIN_ACTIVE = 2
const MAX_PREPARED_RECORDS = 256
const MAX_COMPLETED_IDENTITIES = 512
const COMPLETED_IDENTITY_TTL_MS = 24 * 60 * 60 * 1000
const PREPARED_REASON_TTL_MS = 60 * 60 * 1000
/** 运行时变量只活在本次会话：一小时过期，重启即失效，不落盘。 */
const RUNTIME_VARIABLE_TTL_MS = 60 * 60 * 1000
const MAX_RUNTIME_VARIABLES = 64

/** 主进程内存里的运行时变量；值只在这里保存，绝不写入记录。 */
interface StoredRuntimeVariable {
  name: string
  value: string
  secret: boolean
  source: string
  updatedAt: number
  expiresAt: number
}

/** 调用服务的可信身份由主进程从真实会话推导，不接受模型自报 workspace。 */
export interface ApiWorkbenchContext {
  workspaceId: string
  sessionId: string
  source: 'manual' | 'agent'
}

/** prepare 输入保留草稿，保存定义与发送权限由上层分别处理。 */
export interface ApiWorkbenchPrepareInput {
  request: Parameters<typeof parseApiRequestDraft>[0]
  requestId?: string
  environmentId?: string
  overrides?: ApiField[]
}

/** Utility/transport 的固定调用合同；原始正文产物只写入 Store 分配的目录。 */
export type ApiWorkbenchTransport = (
  request: ApiResolvedRequest,
  options: {
    signal?: AbortSignal
    artifacts?: { directory: string; keyBase64: string }
    /** 事件流增量按批回调；服务层按运行上限缓存并广播给界面。 */
    onEvent?: (events: ApiSseEvent[]) => void
  },
) => Promise<ApiTransportResult>

/** Service 构造依赖，时间与 ID 可替换以稳定测试。 */
export interface ApiWorkbenchServiceOptions {
  store: ApiWorkbenchStore
  transport: ApiWorkbenchTransport
  now?: () => number
  uuid?: () => string
  onChanged?: (event: ApiRunChanged) => void
  /** 流式事件只按增量广播，不重复正文。 */
  onStream?: (event: ApiRunStreamChanged) => void
}

interface PreparedRecord {
  context: ApiWorkbenchContext
  preview: ApiPreparedPreview
  rawRequest: ApiResolvedRequest
  assertions: ReturnType<typeof parseApiRequestDraft>['assertions']
  /** 发送前冻结的提取规则；执行结束前不再重新读目录。 */
  extractions: NonNullable<ReturnType<typeof parseApiRequestDraft>['extractions']>
  secretValues: string[]
  origin: string
  runId?: string
  requestId?: string
  artifacts?: { directory: string; keyBase64: string }
}

interface ScheduledTask {
  prepared: PreparedRecord
  controller: AbortController
  promise: Promise<ApiRun>
  resolve: (run: ApiRun) => void
  settled: boolean
  /** 事件流缓存：受条数与总字符上限约束，超出的只累计数量。 */
  sseEvents: ApiSseEvent[]
  sseChars: number
  sseDropped: number
  externalSignal?: AbortSignal
  externalAbort?: () => void
}

/** 已完成身份保留有界终态投影；磁盘失败时重复调用仍不会回到在途状态。 */
interface CompletedIdentity {
  context: ApiWorkbenchContext
  runId: string
  completedAt: number
  /** 去除正文和头的大字段，仅作终态与损坏文件的回退事实。 */
  terminal: ApiRun
}

/** 创建外部可等待、内部可确定完成的单次 promise。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: (value) => resolvePromise?.(value) }
}

/** 常见敏感响应头必须在公开逐跳记录中遮罩。 */
function redactTransportResult(result: ApiTransportResult, request: ApiResolvedRequest, secrets: readonly string[]): ApiTransportResult {
  const sensitiveRequestHeaders = new Set(request.sensitiveHeaderNames.map((name) => name.toLowerCase()))
  const commonSensitive = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|password|secret)$/i
  const redactText = (value: string): string => redactApiBody(value, secrets)
  return {
    ...result,
    hops: result.hops.map((hop) => ({
      ...hop,
      url: redactApiRequest({ ...request, url: hop.url, headers: [], body: '' }, secrets).url,
      statusText: redactText(hop.statusText),
      requestHeaders: hop.requestHeaders.map((header) => ({
        ...header,
        value: sensitiveRequestHeaders.has(header.name.toLowerCase()) || commonSensitive.test(header.name)
          ? '[REDACTED]'
          : redactText(header.value),
      })),
      responseHeaders: hop.responseHeaders.map((header) => ({
        ...header,
        value: commonSensitive.test(header.name) ? '[REDACTED]' : redactText(header.value),
      })),
      trailers: hop.trailers.map((header) => ({
        ...header,
        value: commonSensitive.test(header.name) ? '[REDACTED]' : redactText(header.value),
      })),
      connection: {
        ...hop.connection,
        ...(hop.connection.remoteAddress ? { remoteAddress: redactText(hop.connection.remoteAddress) } : {}),
        ...(hop.connection.localAddress ? { localAddress: redactText(hop.connection.localAddress) } : {}),
        ...(hop.connection.tls ? {
          tls: {
            ...hop.connection.tls,
            protocol: redactText(hop.connection.tls.protocol),
            cipher: redactText(hop.connection.tls.cipher),
            subject: redactText(hop.connection.tls.subject),
            issuer: redactText(hop.connection.tls.issuer),
            validFrom: redactText(hop.connection.tls.validFrom),
            validTo: redactText(hop.connection.tls.validTo),
            ...(hop.connection.tls.authorizationError ? { authorizationError: redactText(hop.connection.tls.authorizationError) } : {}),
          },
        } : {}),
      },
    })),
    body: { ...result.body, preview: redactText(result.body.preview) },
    ...(result.error ? { error: { ...result.error, message: redactText(result.error.message) } } : {}),
  }
}

/** 手动工作台与普通交互 Agent 共用的准备、发送、调度和历史服务。 */
export class ApiWorkbenchService {
  private readonly store: ApiWorkbenchStore
  private readonly transport: ApiWorkbenchTransport
  private readonly now: () => number
  private readonly uuid: () => string
  private readonly onChanged?: (event: ApiRunChanged) => void
  /** 流式事件只发给订阅的窗口；未配置时仍缓存并在终态落盘。 */
  private readonly onStream?: (event: ApiRunStreamChanged) => void
  /** 运行时变量按 workspace 隔离，只存在于当前主进程内存。 */
  private readonly runtimeVariables = new Map<string, Map<string, StoredRuntimeVariable>>()
  private readonly prepared = new Map<string, PreparedRecord>()
  private readonly tasks = new Map<string, ScheduledTask>()
  private readonly completed = new Map<string, CompletedIdentity>()
  private readonly queue: ScheduledTask[] = []
  private readonly activeByOrigin = new Map<string, number>()
  private activeCount = 0
  private shuttingDown = false

  constructor(options: ApiWorkbenchServiceOptions) {
    this.store = options.store
    this.transport = options.transport
    this.now = options.now ?? Date.now
    this.uuid = options.uuid ?? randomUUID
    this.onChanged = options.onChanged
    this.onStream = options.onStream
  }

  /** 返回 workspace 完整有界目录。 */
  async getCatalog(workspaceId: string): Promise<ApiCatalog> {
    return this.store.getCatalog(parseApiId(workspaceId))
  }

  /** 按全目录 revision CAS 保存，并由 Store 维护 request 独立 revision。 */
  async saveCatalog(workspaceId: string, expectedRevision: number, catalog: ApiCatalog): Promise<ApiCatalog> {
    return this.store.saveCatalog(parseApiId(workspaceId), expectedRevision, parseApiCatalog(catalog))
  }

  /** 固定解析后的请求、环境、目录与秘密版本，返回脱敏审批预览。 */
  async prepare(context: ApiWorkbenchContext, input: ApiWorkbenchPrepareInput): Promise<ApiPreparedPreview> {
    this.assertContext(context)
    if (this.shuttingDown) throw new Error('API_WORKBENCH_SHUTTING_DOWN')
    this.pruneCaches()
    const catalog = this.store.getCatalog(context.workspaceId)
    const request = parseApiRequestDraft(input.request)
    const requestId = input.requestId === undefined ? undefined : parseApiId(input.requestId)
    const environmentId = input.environmentId === undefined ? undefined : parseApiId(input.environmentId)
    if (requestId && !catalog.requests.some((item) => item.id === requestId)) throw new Error('API_WORKBENCH_REQUEST_NOT_FOUND')
    const resolved = resolveApiRequest({
      catalog,
      request,
      ...(requestId ? { requestId } : {}),
      ...(environmentId ? { environmentId } : {}),
      ...(input.overrides ? { overrides: input.overrides } : {}),
      runtimeVariables: this.runtimeVariableFields(context.workspaceId),
      resolveSecret: ({ ref, owner }) => this.store.resolveSecret(context.workspaceId, ref, owner),
    })
    const createdAt = this.now()
    const preparedId = parseApiId(this.uuid())
    const preview = parseApiPreparedPreview({
      preparedId,
      request: redactApiRequest(resolved.request, resolved.secretValues),
      requestName: request.name,
      catalogRevision: catalog.revision,
      ...(environmentId ? { environmentId } : {}),
      ...(resolved.environmentKind ? { environmentKind: resolved.environmentKind } : {}),
      createdAt,
      expiresAt: createdAt + PREPARED_TTL_MS,
      warnings: resolved.environmentKind === 'production' ? ['目标环境标记为 production，执行前必须逐次复核'] : [],
    })
    let origin: string
    try { origin = new URL(resolved.request.url).origin } catch { throw new Error('API_WORKBENCH_URL_INVALID') }
    this.prepared.set(preparedId, {
      context: { ...context },
      ...(requestId ? { requestId } : {}),
      preview,
      rawRequest: resolved.request,
      assertions: request.assertions.map((assertion) => ({ ...assertion })),
      extractions: (request.extractions ?? []).map((rule) => ({ ...rule })),
      secretValues: [...resolved.secretValues],
      origin,
    })
    this.pruneCaches()
    return parseApiPreparedPreview(preview)
  }

  /** 审批展示和发送前复核共用同一 prepared 验证路径。 */
  async getPrepared(context: ApiWorkbenchContext, preparedId: string): Promise<ApiPreparedPreview> {
    return parseApiPreparedPreview(this.requirePrepared(context, preparedId).preview)
  }

  /** 每个 preparedId 只登记一次 run intent；重复调用复用同一 Promise 或终态。 */
  async send(context: ApiWorkbenchContext, preparedId: string, signal?: AbortSignal): Promise<ApiRun> {
    this.assertContext(context)
    const id = parseApiId(preparedId)
    this.pruneCaches()
    const completed = this.completed.get(id)
    if (completed) {
      this.assertSameContext(completed.context, context)
      let persisted: ApiRun
      try { persisted = this.store.getRun(context.workspaceId, completed.runId, false) }
      catch { return parseApiRun(completed.terminal) }
      return parseApiRun({ ...persisted, state: completed.terminal.state, recording: completed.terminal.recording,
        finishedAt: completed.terminal.finishedAt, error: completed.terminal.error })
    }
    const activeTask = this.tasks.get(id)
    if (activeTask) {
      this.assertSameContext(activeTask.prepared.context, context)
      return activeTask.promise
    }
    const prepared = this.requirePrepared(context, id)
    if (prepared.runId) {
      return this.store.getRun(context.workspaceId, prepared.runId, false)
    }
    if (signal?.aborted) throw new Error('API_WORKBENCH_CANCELLED')
    const runId = parseApiId(this.uuid())
    const queued = parseApiRun({
      id: runId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      source: context.source,
      requestName: prepared.preview.requestName,
      ...(prepared.requestId ? { requestId: prepared.requestId } : {}),
      ...(prepared.preview.environmentId ? { environmentId: prepared.preview.environmentId } : {}),
      catalogRevision: prepared.preview.catalogRevision,
      createdAt: this.now(),
      state: 'queued',
      request: prepared.preview.request,
      hops: [],
      body: createEmptyApiBody(),
      assertions: [],
      recording: 'memory-only',
      pinned: false,
    })
    const created = this.store.createRun(queued, prepared.rawRequest, prepared.secretValues)
    prepared.runId = runId
    prepared.artifacts = created.artifacts
    const pending = deferred<ApiRun>()
    const task: ScheduledTask = {
      prepared,
      controller: new AbortController(),
      promise: pending.promise,
      resolve: pending.resolve,
      settled: false,
      sseEvents: [],
      sseChars: 0,
      sseDropped: 0,
      ...(signal ? { externalSignal: signal } : {}),
    }
    if (signal) {
      task.externalAbort = () => { void this.cancel(context, id).catch(() => undefined) }
      signal.addEventListener('abort', task.externalAbort, { once: true })
    }
    this.tasks.set(id, task)
    this.queue.push(task)
    this.emit(created.run)
    this.drain()
    return task.promise
  }

  /** 取消只允许 prepared 所属 session；排队项绝不进入 transport。 */
  async cancel(context: ApiWorkbenchContext, preparedId: string): Promise<void> {
    this.assertContext(context)
    const id = parseApiId(preparedId)
    const completed = this.completed.get(id)
    if (completed) { this.assertSameContext(completed.context, context); return }
    const prepared = this.prepared.get(id)
    if (!prepared || prepared.context.workspaceId !== context.workspaceId || prepared.context.sessionId !== context.sessionId || prepared.context.source !== context.source) {
      throw new Error('API_WORKBENCH_PREPARED_NOT_FOUND')
    }
    if (!prepared.runId) return
    const task = this.tasks.get(id)
    /** 先停止实际传输；磁盘不可写或历史损坏不能阻断取消网络。 */
    task?.controller.abort()
    const current = this.store.getRun(context.workspaceId, prepared.runId, false)
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state)) return
    const cancelled = this.store.updateRun(context.workspaceId, prepared.runId, ['queued', 'running'], (run) => ({
      ...run,
      state: 'cancelled',
      finishedAt: this.now(),
      error: { code: 'API_WORKBENCH_CANCELLED', phase: 'cancel', message: '请求已取消' },
    }))
    this.emit(cancelled)
    if (!task) {
      this.completed.set(id, { context: { ...context }, runId: prepared.runId, completedAt: this.now(), terminal: this.terminalProjection(cancelled) })
      this.prepared.delete(id)
      this.pruneCaches()
      return
    }
    const queueIndex = this.queue.indexOf(task)
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1)
      this.settleTask(id, task, cancelled)
      return
    }
  }

  /** workspace 历史可供 UI 跨 session 查看；Agent 仍由 getRun/readBody 限制到所属 session。 */
  async listRuns(context: ApiWorkbenchContext, options: { cursor?: number; limit?: number } = {}): Promise<{ runs: ApiRun[]; nextCursor: number | null }> {
    this.assertContext(context)
    const cursor = Math.max(0, Math.trunc(options.cursor ?? 0))
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)))
    return this.store.listRuns(context.workspaceId, cursor, limit, context.source === 'agent' ? context.sessionId : undefined)
  }

  /** UI 可查看同 workspace 历史；Agent 只能查看自己的 session 且不能 reveal。 */
  async getRun(context: ApiWorkbenchContext, runId: string, reveal = false): Promise<ApiRun> {
    this.assertContext(context)
    if (reveal && context.source !== 'manual') throw new Error('API_WORKBENCH_REVEAL_FORBIDDEN')
    const run = this.store.getRun(context.workspaceId, parseApiId(runId), reveal)
    this.assertRunAccess(context, run)
    return run
  }

  /** 正文按字符分页；Agent 固定脱敏且每次最多 32 KiB。 */
  async readBody(
    context: ApiWorkbenchContext,
    runId: string,
    options: { offset?: number; limit?: number; reveal?: boolean } = {},
  ): Promise<ApiBodySlice> {
    const run = await this.getRun(context, runId, false)
    const reveal = options.reveal === true
    if (reveal && context.source !== 'manual') throw new Error('API_WORKBENCH_REVEAL_FORBIDDEN')
    const requestedLimit = options.limit ?? (context.source === 'agent' ? API_LIMITS.agentBytes : API_LIMITS.previewBytes)
    const limit = Math.min(requestedLimit, context.source === 'agent' ? API_LIMITS.agentBytes : API_LIMITS.previewBytes)
    const prepared = [...this.prepared.values()].find((item) => item.runId === run.id)
    return this.store.readBody(context.workspaceId, run.id, {
      offset: options.offset ?? 0,
      limit,
      reveal,
      secrets: prepared?.secretValues ?? [],
    })
  }

  /** 收藏沿用原运行身份，Agent 不能修改其他 session 的运行。 */
  async pinRun(context: ApiWorkbenchContext, runId: string, pinned: boolean): Promise<ApiRun> {
    const run = await this.getRun(context, runId, false)
    return this.store.pinRun(context.workspaceId, run.id, pinned)
  }

  /** 数据根迁移预检使用；在网络与记录终态完成前保留活动标记。 */
  hasActiveRequests(): boolean { return this.tasks.size > 0 }

  /** 有界关闭：立即取消排队/活动项，不等待网络重试或轮询。 */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    const contexts = [...this.tasks.entries()].map(([preparedId, task]) => ({ preparedId, context: task.prepared.context }))
    await Promise.all(contexts.map(({ preparedId, context }) => this.cancel(context, preparedId).catch(() => undefined)))
    await Promise.all([...this.tasks.values()].map((task) => task.promise.catch(() => undefined)))
    this.store.shutdown()
    this.prepared.clear()
    this.completed.clear()
    /** 运行时变量只活在本次会话，关闭时一并清除。 */
    this.runtimeVariables.clear()
  }

  /** 从队列填充全局/来源槽位；不使用定时轮询。 */
  private drain(): void {
    if (this.shuttingDown) return
    for (let index = 0; index < this.queue.length && this.activeCount < MAX_GLOBAL_ACTIVE;) {
      const task = this.queue[index]!
      const originActive = this.activeByOrigin.get(task.prepared.origin) ?? 0
      if (originActive >= MAX_ORIGIN_ACTIVE) { index += 1; continue }
      this.queue.splice(index, 1)
      this.activeCount += 1
      this.activeByOrigin.set(task.prepared.origin, originActive + 1)
      void this.execute(task)
    }
  }

  /** 单次派发，任何保存失败或异常都只结束当前 run，绝不再次调用 transport。 */
  private async execute(task: ScheduledTask): Promise<void> {
    const preparedId = task.prepared.preview.preparedId
    const runId = task.prepared.runId!
    let running: ApiRun
    try {
      this.requirePrepared(task.prepared.context, preparedId)
      running = this.store.updateRun(task.prepared.context.workspaceId, runId, ['queued'], (run) => ({ ...run, state: 'running' }))
      if (running.state !== 'running') {
        this.settleTask(preparedId, task, running)
        return
      }
      this.emit(running)
      const result = await this.transport(task.prepared.rawRequest, {
        signal: task.controller.signal,
        ...(task.prepared.artifacts ? { artifacts: task.prepared.artifacts } : {}),
        onEvent: (events) => this.appendStreamEvents(task, this.redactStreamEvents(events, task.prepared.secretValues)),
      })
      let recordingFailed = result.error?.code === 'API_ARTIFACT_UNAVAILABLE'
      try { this.store.saveRawDetails(task.prepared.context.workspaceId, runId, task.prepared.rawRequest, result.hops) }
      catch { recordingFailed = true }
      const publicResult = redactTransportResult(result, task.prepared.rawRequest, task.prepared.secretValues)
      const state = result.state
      const assertionResults = evaluateApiAssertions(task.prepared.assertions, result, {
        events: task.sseEvents, droppedEvents: task.sseDropped,
      }).map((assertion) => ({
        ...assertion,
        expected: redactApiBody(assertion.expected, task.prepared.secretValues),
        actual: redactApiBody(assertion.actual, task.prepared.secretValues),
        message: redactApiBody(assertion.message, task.prepared.secretValues),
      }))
      const final = this.store.updateRun(task.prepared.context.workspaceId, runId, ['running', 'cancelled'], (run) => parseApiRun({
        ...run,
        state: run.state === 'cancelled' ? 'cancelled' : state,
        recording: recordingFailed ? 'failed' : run.recording,
        finishedAt: this.now(),
        hops: publicResult.hops,
        body: publicResult.body,
        assertions: assertionResults,
        /** 提取必须读原始响应：公开投影里的敏感 JSON 字段已经被遮罩成 [REDACTED]。 */
        extracted: this.recordExtractions(task, result, result.state === 'completed'),
        ...(publicResult.sse
          ? { sse: { ...publicResult.sse, events: task.sseEvents, droppedEvents: task.sseDropped } }
          : {}),
        ...(run.state === 'cancelled' && run.error ? { error: run.error } : publicResult.error ? { error: publicResult.error } : {}),
      }))
      this.emit(final)
      this.settleTask(preparedId, task, final)
    } catch (error) {
      let failed: ApiRun
      try {
        const current = this.store.getRun(task.prepared.context.workspaceId, runId, false)
        failed = this.store.updateRun(task.prepared.context.workspaceId, runId, ['queued', 'running'], (run) => ({
          ...run,
          state: task.controller.signal.aborted ? 'cancelled' : 'failed',
          finishedAt: this.now(),
          recording: run.recording === 'saved' ? 'failed' : run.recording,
          /** 异常中断也要保留已经收到的事件，便于核对断流位置。 */
          ...(task.sseEvents.length > 0
            ? {
              sse: {
                events: task.sseEvents,
                totalEvents: task.sseEvents.length + task.sseDropped,
                firstEventMs: task.sseEvents[0]?.receivedMs ?? null,
                droppedEvents: task.sseDropped,
                endedReason: task.controller.signal.aborted ? 'cancelled' as const : 'error' as const,
              },
            }
            : {}),
          error: {
            code: task.controller.signal.aborted ? 'API_WORKBENCH_CANCELLED' : 'API_WORKBENCH_EXECUTION_FAILED',
            phase: 'service',
            message: error instanceof Error ? error.message.slice(0, 4096) : '接口执行失败',
          },
        }))
        if (['cancelled', 'completed', 'failed', 'interrupted'].includes(current.state)) failed = current
      } catch {
        failed = parseApiRun({
          id: runId,
          workspaceId: task.prepared.context.workspaceId,
          sessionId: task.prepared.context.sessionId,
          source: task.prepared.context.source,
          requestName: task.prepared.preview.requestName,
          catalogRevision: task.prepared.preview.catalogRevision,
          createdAt: task.prepared.preview.createdAt,
          finishedAt: this.now(),
          state: task.controller.signal.aborted ? 'cancelled' : 'failed',
          request: task.prepared.preview.request,
          hops: [],
          body: createEmptyApiBody(),
          assertions: [],
          error: { code: 'API_WORKBENCH_RECORDING_FAILED', phase: 'storage', message: '运行记录保存失败，未自动重发' },
          recording: 'failed',
          pinned: false,
        })
      }
      this.emit(failed)
      this.settleTask(preparedId, task, failed)
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1)
      const originCount = this.activeByOrigin.get(task.prepared.origin) ?? 1
      if (originCount <= 1) this.activeByOrigin.delete(task.prepared.origin)
      else this.activeByOrigin.set(task.prepared.origin, originCount - 1)
      this.drain()
    }
  }

  /** 终结单次任务并移除 AbortSignal 监听；重复终结无副作用。 */
  private settleTask(preparedId: string, task: ScheduledTask, run: ApiRun): void {
    if (task.settled) return
    task.settled = true
    if (task.externalSignal && task.externalAbort) task.externalSignal.removeEventListener('abort', task.externalAbort)
    this.tasks.delete(preparedId)
    this.completed.set(preparedId, {
      context: { ...task.prepared.context },
      runId: run.id,
      completedAt: this.now(),
      terminal: this.terminalProjection(run),
    })
    this.prepared.delete(preparedId)
    this.pruneCaches()
    task.resolve(parseApiRun(run))
  }

  /** 返回不含正文、头与断言大字段的终态；512 条/24 小时身份缓存有确定上界。 */
  private terminalProjection(run: ApiRun): ApiRun {
    return parseApiRun({ ...run, request: { ...run.request, headers: [], body: '' },
      hops: run.hops.length ? [{ ...run.hops.at(-1)!, requestHeaders: [], responseHeaders: [], trailers: [] }] : [],
      body: { ...run.body, preview: '', previewTruncated: run.body.preview.length > 0 || run.body.previewTruncated }, assertions: [],
      /** 常驻内存的终态投影只保留事件计数，明细仍按需从 Store 读取。 */
      ...(run.sse ? { sse: { ...run.sse, events: [] } } : {}) })
  }

  /** 读取未过期的运行时变量；只返回元数据，值不离开主进程。 */
  getRuntimeVariables(workspaceId: string): ApiRuntimeVariable[] {
    return [...this.pruneRuntimeVariables(parseApiId(workspaceId)).values()].map((item) => ({
      name: item.name, secret: item.secret, source: item.source, updatedAt: item.updatedAt,
    }))
  }

  /** 清空一个 workspace 的运行时变量，返回被清掉的数量。 */
  clearRuntimeVariables(workspaceId: string): number {
    const id = parseApiId(workspaceId)
    const removed = this.runtimeVariables.get(id)?.size ?? 0
    this.runtimeVariables.delete(id)
    return removed
  }

  /** 修剪过期变量，并按上限淘汰最早更新的条目。 */
  private pruneRuntimeVariables(workspaceId: string): Map<string, StoredRuntimeVariable> {
    const existing = this.runtimeVariables.get(workspaceId)
    if (!existing) return new Map()
    const now = this.now()
    for (const [name, item] of existing) {
      if (item.expiresAt <= now) existing.delete(name)
    }
    while (existing.size > MAX_RUNTIME_VARIABLES) {
      const oldest = [...existing.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
      if (!oldest) break
      existing.delete(oldest[0])
    }
    return existing
  }

  /** 把运行时变量投影为解析器使用的字段；id 只用于稳定身份。 */
  private runtimeVariableFields(workspaceId: string): ApiField[] {
    return [...this.pruneRuntimeVariables(workspaceId).values()].map((item, index) => ({
      id: `runtime_${index}`, name: item.name, value: item.value, enabled: true,
      ...(item.secret ? { secret: true } : {}),
    }))
  }

  /**
   * 评估提取规则并把命中值写入运行时变量。
   * @param task 当前运行任务，提供冻结的规则与事件流缓存。
   * @param result 传输结果。
   * @param completedNormally 是否收到完整响应；否则一律跳过提取。
   * @returns 只含结果事实的提取结果，可安全写入运行记录。
   */
  private recordExtractions(task: ScheduledTask, result: ApiTransportResult, completedNormally: boolean): ApiExtractionOutcome[] {
    const rules = task.prepared.extractions
    if (rules.length === 0) return []
    if (!completedNormally) {
      return rules.map((rule) => ({
        id: rule.id, name: rule.name, from: rule.from, found: false, secret: rule.secret,
        message: '运行未正常完成，已跳过提取',
      }))
    }
    const evaluations = evaluateApiExtractions(rules, result, { events: task.sseEvents, droppedEvents: task.sseDropped })
    const workspaceId = task.prepared.context.workspaceId
    const updatedAt = this.now()
    const target = this.runtimeVariables.get(workspaceId) ?? new Map<string, StoredRuntimeVariable>()
    for (const evaluation of evaluations) {
      if (!evaluation.outcome.found || evaluation.value === undefined) continue
      target.set(evaluation.outcome.name, {
        name: evaluation.outcome.name, value: evaluation.value, secret: evaluation.outcome.secret,
        source: `请求「${task.prepared.preview.requestName}」`,
        updatedAt, expiresAt: updatedAt + RUNTIME_VARIABLE_TTL_MS,
      })
    }
    if (target.size > 0) this.runtimeVariables.set(workspaceId, target)
    this.pruneRuntimeVariables(workspaceId)
    return evaluations.map((evaluation) => evaluation.outcome)
  }

  /** 事件流同样只暴露脱敏事实；原始帧留在加密产物与本地原文视图中。 */
  private redactStreamEvents(events: readonly ApiSseEvent[], secrets: readonly string[]): ApiSseEvent[] {
    if (secrets.length === 0) return [...events]
    return events.map((event) => ({
      ...event,
      data: redactApiBody(event.data, secrets),
      comment: redactApiBody(event.comment, secrets),
      raw: redactApiBody(event.raw, secrets),
    }))
  }

  /** 缓存并按上限广播事件增量；超出上限只累计数量，不静默丢帧。 */
  private appendStreamEvents(task: ScheduledTask, events: readonly ApiSseEvent[]): void {
    const runId = task.prepared.runId
    if (!runId) return
    /** 本次真正进入缓存、可以广播给界面的事件。 */
    const accepted: ApiSseEvent[] = []
    for (const event of events) {
      const size = event.raw.length
      if (task.sseEvents.length >= API_LIMITS.sseEvents || task.sseChars + size > API_LIMITS.sseTotalChars) {
        task.sseDropped += 1
        continue
      }
      task.sseEvents.push(event)
      task.sseChars += size
      accepted.push(event)
    }
    if (accepted.length === 0) return
    this.onStream?.({
      sessionId: task.prepared.context.sessionId,
      runId,
      events: accepted,
    })
  }

  /** 复核 prepared 归属、有效期和目录 revision；失效原因稳定且不静默换输入。 */
  private requirePrepared(context: ApiWorkbenchContext, preparedId: string): PreparedRecord {
    this.assertContext(context)
    const record = this.prepared.get(parseApiId(preparedId))
    if (!record
      || record.context.workspaceId !== context.workspaceId
      || record.context.sessionId !== context.sessionId
      || record.context.source !== context.source) {
      throw new Error('API_WORKBENCH_PREPARED_NOT_FOUND')
    }
    if (this.now() > record.preview.expiresAt) throw new Error('API_WORKBENCH_PREPARED_EXPIRED')
    const catalog = this.store.getCatalog(context.workspaceId)
    if (catalog.revision !== record.preview.catalogRevision) throw new Error('API_WORKBENCH_PREPARED_STALE')
    return record
  }

  /** 校验所有可信 context 字段均是路径安全业务 ID。 */
  private assertContext(context: ApiWorkbenchContext): void {
    parseApiId(context.workspaceId)
    parseApiId(context.sessionId)
    if (context.source !== 'manual' && context.source !== 'agent') throw new Error('API_WORKBENCH_CONTEXT_INVALID')
  }

  /** 比较完整可信身份，避免 completed/task 索引被其他来源复用。 */
  private assertSameContext(expected: ApiWorkbenchContext, actual: ApiWorkbenchContext): void {
    if (expected.workspaceId !== actual.workspaceId
      || expected.sessionId !== actual.sessionId
      || expected.source !== actual.source) {
      throw new Error('API_WORKBENCH_PREPARED_NOT_FOUND')
    }
  }

  /** 清理过期准备和完成身份，避免请求正文及结果在主进程内无界增长。 */
  private pruneCaches(): void {
    const now = this.now()
    for (const [id, record] of this.prepared) {
      if (record.preview.expiresAt + PREPARED_REASON_TTL_MS < now && !this.tasks.has(id)) this.prepared.delete(id)
    }
    while (this.prepared.size > MAX_PREPARED_RECORDS) {
      const removable = [...this.prepared.entries()]
        .filter(([id]) => !this.tasks.has(id))
        .sort((a, b) => a[1].preview.createdAt - b[1].preview.createdAt)[0]
      if (!removable) break
      this.prepared.delete(removable[0])
    }
    for (const [id, record] of this.completed) {
      if (record.completedAt + COMPLETED_IDENTITY_TTL_MS < now) this.completed.delete(id)
    }
    while (this.completed.size > MAX_COMPLETED_IDENTITIES) {
      const oldest = [...this.completed.entries()].sort((a, b) => a[1].completedAt - b[1].completedAt)[0]
      if (!oldest) break
      this.completed.delete(oldest[0])
    }
  }

  /** Agent 只能读取与修改自己 session 创建的 run。 */
  private assertRunAccess(context: ApiWorkbenchContext, run: ApiRun): void {
    if (run.workspaceId !== context.workspaceId) throw new Error('API_WORKBENCH_RUN_NOT_FOUND')
    if (context.source === 'agent' && run.sessionId !== context.sessionId) throw new Error('API_WORKBENCH_RUN_NOT_FOUND')
  }

  /** 推送轻量状态事件，不让监听器异常影响权威运行状态。 */
  private emit(run: ApiRun): void {
    try { this.onChanged?.({ sessionId: run.sessionId, runId: run.id, state: run.state }) } catch { /* 事件消费者不参与事务。 */ }
  }
}
