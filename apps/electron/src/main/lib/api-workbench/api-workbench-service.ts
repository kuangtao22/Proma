import { randomUUID } from 'node:crypto'
import {
  API_LIMITS,
  apiDraftFromDefinition,
  parseApiCatalog,
  parseApiId,
  parseApiPreparedPreview,
  parseApiRequestDraft,
  parseApiRun,
  parseApiScenarioPreparedPreview,
  parseApiScenarioRun,
} from '@proma/shared'
import type {
  ApiBodySlice,
  ApiCatalog,
  ApiCryptoOverrides,
  ApiCryptoProfile,
  ApiCryptoProfileDeleteInput,
  ApiCryptoProfileDeleteResult,
  ApiCryptoProfileSaveInput,
  ApiCryptoReferenceQuery,
  ApiCryptoReferences,
  ApiExtractionOutcome,
  ApiField,
  ApiFilePart,
  ApiMethod,
  ApiPreparedPreview,
  ApiResolvedRequest,
  ApiRun,
  ApiRunCrypto,
  ApiRunChanged,
  ApiRunStreamChanged,
  ApiScenarioFailurePolicy,
  ApiScenarioPreparedPreview,
  ApiScenarioRun,
  ApiScenarioStepOutcome,
  ApiSseEvent,
  ApiRuntimeVariable,
  ApiRequestDraft,
  ApiVariableRevealInput,
  ApiVariableRevealResult,
  ApiCookieJarEntry,
  ApiWorkspaceVariablesSaveInput,
  ApiWorkspaceVariablesSaveResult,
  ApiAttachmentSummary,
  ApiTransportResult,
} from '@proma/shared'
import { evaluateApiAssertions } from './api-assertions'
import { isCookieExpired, parseApiSetCookie, MAX_COOKIE_JAR_ENTRIES } from './api-cookies'
import type { ApiCookieJarRecord } from './api-cookies'
import { evaluateApiExtractions } from './api-extractions'
import { parseApiAgentDeclaredFiles } from './api-agent-files'
import type { ApiAgentDeclaredFile } from './api-agent-files'
import { ApiFileStore } from './api-file-store'
import type { ApiPickedFileMeta } from './api-file-store'
import { composeMultipartBody } from './api-multipart'
import type { ApiMultipartPlanPart } from './api-multipart'
import { redactApiBody, redactApiRequest } from './api-redaction'
import { resolveApiCryptoSecrets, resolveApiRequest } from './api-request-resolver'
import { applyRequestSteps, applyResponseSteps } from './api-crypto-plan'
import type { ApiCryptoRequestOutcome } from './api-crypto-plan'
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

/**
 * 落盘/公开前剥掉二进制正文。
 *
 * `bodyBase64` 只在主进程与 Utility 之间流转；记录里保留 body 摘要与 attachments，
 * 这样「发了什么」可核对，而文件字节不会被复制进应用数据根。
 * @param request 实际派发用的请求。
 * @returns 可写入运行记录的副本。
 */
function requestForRecord(request: ApiResolvedRequest): ApiResolvedRequest {
  if (!request.bodyBase64) return request
  const { bodyBase64: _ignored, ...rest } = request
  void _ignored
  return rest
}

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
  /** 指定测试用例：断言与变量覆盖都来自该用例。 */
  caseId?: string
  /**
   * **仅供场景展示阶段**：把「本流程稍后才会提取出来」的运行时变量先按字面值解析。
   *
   * 登录流程的第二步要带 `{{token}}`，而这个值要等第一步跑完才有；审批卡仍必须先把
   * 每一步的方法与 URL 列清楚，所以展示阶段允许对这类变量先放占位值。
   * 真正派发时**绝不带这个字段**（facade 与 IPC 都不会传），占位值不可能被发出去。
   */
  deferredRuntimeVariables?: Array<{ name: string; value: string }>
}

/** Agent 附件登记结果：请求定义用的引用 + 只给审批卡看的真实路径与大小。 */
export interface ApiAgentFileRegistration {
  /** 可直接放进请求定义的引用元数据（不含路径）。 */
  parts: ApiFilePart[]
  /** 审批快照里的文件行；`path` 是 realpath，符号链接无法伪装。 */
  approvals: Array<{ field: string; path: string; sizeBytes: number }>
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
  /** 待上传文件的引用仓库；默认用真实实现，测试可注入窄替身。 */
  files?: ApiFileStore
  now?: () => number
  uuid?: () => string
  onChanged?: (event: ApiRunChanged) => void
  /** 流式事件只按增量广播，不重复正文。 */
  onStream?: (event: ApiRunStreamChanged) => void
}

interface PreparedRecord {
  context: ApiWorkbenchContext
  preview: ApiPreparedPreview
  /** 冻结的编辑草稿：发送阶段重解析加密密钥时还要用到集合与环境归属。 */
  draft: ApiRequestDraft
  rawRequest: ApiResolvedRequest
  /**
   * multipart 的待发计划：文本字段已解析，文件部分只有引用与元数据。
   * 真字节在 send 阶段才按这份计划读取（准备阶段只做了 realpath + stat）。
   */
  multipart?: { boundary: string; parts: ApiMultipartPlanPart[] }
  assertions: ReturnType<typeof parseApiRequestDraft>['assertions']
  /** 本次运行绑定的测试用例身份；未按用例跑时缺省。 */
  caseId?: string
  /** 发送前冻结的提取规则；执行结束前不再重新读目录。 */
  extractions: NonNullable<ReturnType<typeof parseApiRequestDraft>['extractions']>
  /** 本次请求是否开启自动 Cookie：决定运行终态是否写入 jar。 */
  useCookieJar: boolean
  /**
   * 准备阶段冻结的加密方案：批准卡上列的步骤就是执行时用的那一版。
   * 密钥值**不在**这里——发送前才按作用域链重新解析，因此「批准后用户才填密钥」也能生效。
   */
  crypto?: FrozenCryptoPlan
  secretValues: string[]
  origin: string
  runId?: string
  requestId?: string
  artifacts?: { directory: string; keyBase64: string }
}

/** 冻结的加密方案：方案内容 + 执行时解析密钥所需的作用域信息。 */
interface FrozenCryptoPlan {
  profile: ApiCryptoProfile
  overrides?: ApiCryptoOverrides
  environmentId?: string
  /** 与请求解析同源的作用域输入：用例覆盖 + 单次覆盖。 */
  variableOverrides?: ApiField[]
  /** 展示阶段允许的占位运行时变量（流程后续步骤用），发送时同样传入以保持作用域一致。 */
  deferredRuntimeVariables?: ApiField[]
  /** 方案引用的密钥变量名（keyRef / ivRef 去重）。 */
  names: string[]
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

/**
 * 已准备场景：每一步在准备阶段就冻结成独立的 prepared 记录，批准后按顺序派发。
 *
 * 这样「一次批准」不会退化成「按当前目录重新解析一遍再发」——批准时列的 URL 就是执行时发的 URL。
 */
interface PreparedScenarioRecord {
  context: ApiWorkbenchContext
  preview: ApiScenarioPreparedPreview
  scenarioId: string
  scenarioName: string
  onFailure: ApiScenarioFailurePolicy
  /**
   * 执行用的步骤身份：保存**当时解析出来的定义事实**（方法 / URL / 环境）与执行参数。
   *
   * 执行时按这些参数逐步重新准备并发送，再把真正发出的方法与 URL 与这里核对；
   * 不在准备阶段冻结每一步的请求，因为后面的步骤往往依赖前面步骤提取出来的变量。
   */
  steps: Array<{
    stepId: string
    name: string
    requestId: string
    caseId?: string
    environmentId?: string
    overrides?: ApiField[]
    method: ApiMethod
    url: string
    environmentKind?: 'local' | 'test' | 'production'
    assertionCount: number
    onFailure: ApiScenarioFailurePolicy
  }>
  /** 已登记的场景运行身份；重复调用不再跑第二遍。 */
  scenarioRunId?: string
}

/** 在途场景：只用于取消与重复调用去重。 */
interface RunningScenario {
  context: ApiWorkbenchContext
  scenarioRunId: string
  promise: Promise<ApiScenarioRun>
}

/** 已完成的场景身份：重复调用返回同一份终态，不会第二次出网。 */
interface CompletedScenario {
  context: ApiWorkbenchContext
  scenarioRunId: string
  completedAt: number
  terminal: ApiScenarioRun
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

/** 终态投影去掉变形前明文：它可能是一整份请求正文，内存投影只需要算法与结论。 */
function stripRunCryptoHeavy(crypto: ApiRunCrypto): ApiRunCrypto {
  const { bodyBeforeTransform: _ignored, ...rest } = crypto
  void _ignored
  return rest
}

/** 请求侧事实转成运行记录字段；只搬运算法名、变量名与派生值。 */
function runCryptoFromRequest(profile: ApiCryptoProfile, outcome: ApiCryptoRequestOutcome): ApiRunCrypto {
  return {
    profileId: profile.id, profileName: profile.name, profileRevision: profile.revision,
    executed: outcome.executed, skipped: outcome.skipped,
    plaintextSent: outcome.plaintextSent,
    decrypted: false,
    ...(Object.keys(outcome.derived).length === 0 ? {} : { derived: outcome.derived }),
    ...(outcome.bodyBeforeTransform === undefined ? {} : { bodyBeforeTransform: outcome.bodyBeforeTransform }),
  }
}

/**
 * 把编排结果写回已解析请求。
 * 查询串只在真的变化时才重建 URL：否则重新编码会无谓改动原始地址（服务端可能校验原始编码）。
 */
function rebaseApiRequest(request: ApiResolvedRequest, original: URL, outcome: ApiCryptoRequestOutcome): ApiResolvedRequest {
  const originalQuery = [...original.searchParams.entries()]
  const queryChanged = outcome.query.length !== originalQuery.length
    || outcome.query.some((row, index) => row.name !== originalQuery[index]?.[0] || row.value !== originalQuery[index]?.[1])
  const headersUnchanged = outcome.headers.length === request.headers.length
    && outcome.headers.every((row, index) => row.name === request.headers[index]?.name && row.value === request.headers[index]?.value)
  /** 原有请求头的来源标记（用户 / 生成）要保留，否则界面会看不出哪些头是自动加的。 */
  const headers = headersUnchanged
    ? request.headers
    : outcome.headers.map((row) => request.headers.find((header) => header.name === row.name && header.value === row.value) ?? { name: row.name, value: row.value })
  let url = request.url
  if (queryChanged) {
    const next = new URL(request.url)
    next.search = outcome.query.length === 0 ? '' : '?' + outcome.query.map(({ name, value }) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')
    url = next.toString()
  }
  return { ...request, url, headers, body: outcome.body }
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
  /** 待上传文件的引用仓库：路径只在这里，只活在主进程内存。 */
  private readonly files: ApiFileStore
  private readonly now: () => number
  private readonly uuid: () => string
  private readonly onChanged?: (event: ApiRunChanged) => void
  /** 流式事件只发给订阅的窗口；未配置时仍缓存并在终态落盘。 */
  private readonly onStream?: (event: ApiRunStreamChanged) => void
  /** 运行时变量按 workspace 隔离，只存在于当前主进程内存。 */
  private readonly runtimeVariables = new Map<string, Map<string, StoredRuntimeVariable>>()
  /** Cookie Jar 同样按 workspace 隔离、只活在主进程内存；取值绝不落盘。 */
  private readonly cookieJar = new Map<string, Map<string, ApiCookieJarRecord>>()
  private readonly prepared = new Map<string, PreparedRecord>()
  private readonly tasks = new Map<string, ScheduledTask>()
  private readonly completed = new Map<string, CompletedIdentity>()
  /** 已准备场景 / 在途场景 / 已完成场景身份：与单次请求同一套「一份身份只跑一次」语义。 */
  private readonly scenarios = new Map<string, PreparedScenarioRecord>()
  private readonly scenarioTasks = new Map<string, RunningScenario>()
  private readonly scenarioControllers = new Map<string, AbortController>()
  private readonly completedScenarios = new Map<string, CompletedScenario>()
  private readonly queue: ScheduledTask[] = []
  private readonly activeByOrigin = new Map<string, number>()
  private activeCount = 0
  private shuttingDown = false

  constructor(options: ApiWorkbenchServiceOptions) {
    this.store = options.store
    this.transport = options.transport
    this.files = options.files ?? new ApiFileStore()
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

  /** 保存签名/加密方案（公共配置）；方案 revision 由 Store 维护。 */
  async saveCryptoProfile(workspaceId: string, profile: ApiCryptoProfile, expectedRevision: number | null): Promise<ApiCryptoProfile> {
    return this.store.saveCryptoProfile(parseApiId(workspaceId), profile, expectedRevision)
  }

  /** 删除方案；仍被请求引用时默认拒绝并返回引用条数。 */
  async deleteCryptoProfile(workspaceId: string, id: string, force: boolean): Promise<ApiCryptoProfileDeleteResult> {
    return this.store.deleteCryptoProfile(parseApiId(workspaceId), parseApiId(id), force)
  }

  /** 批量写工作区变量；返回值只含引用与名称，秘密明文不出主进程。 */
  async saveWorkspaceVariables(workspaceId: string, variables: ApiField[]): Promise<ApiWorkspaceVariablesSaveResult> {
    return { variables: this.store.saveWorkspaceVariables(parseApiId(workspaceId), variables) }
  }

  /** 变量/方案引用检查：删除确认与「改了会影响谁」共用。 */
  async getCryptoReferences(workspaceId: string, kind: 'variable' | 'profile', name: string): Promise<ApiCryptoReferences> {
    return this.store.inspectCryptoReferences(parseApiId(workspaceId), kind, name)
  }

  /**
   * 明文揭示一个变量字段（用户主动点 👁 的窄通道）。
   * 每次调用写一条主进程审计日志：只记变量名与作用域，不记值。
   */
  async revealVariable(workspaceId: string, input: ApiVariableRevealInput): Promise<ApiVariableRevealResult> {
    const revealed = this.store.revealVariable(parseApiId(workspaceId), { scope: input.scope, ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }), fieldId: input.fieldId })
    console.info(`[接口工作台] 明文显示密钥：${revealed.name}（作用域 ${input.scope}${input.scopeId ? `:${input.scopeId}` : ''}）`)
    return revealed
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
    /** 指定用例时必须存在于草稿里，避免静默按默认断言执行。 */
    const caseId = input.caseId === undefined ? undefined : parseApiId(input.caseId)
    const testCase = caseId === undefined ? undefined : (request.cases ?? []).find((item) => item.id === caseId)
    if (caseId !== undefined && !testCase) throw new Error('API_WORKBENCH_CASE_NOT_FOUND')
    /** 用例环境只在环境仍存在时生效；显式传入的环境优先级更高。 */
    const effectiveEnvironmentId = environmentId ?? (testCase?.environmentId && catalog.environments.some((item) => item.id === testCase.environmentId) ? testCase.environmentId : undefined)
    if (requestId && !catalog.requests.some((item) => item.id === requestId)) throw new Error('API_WORKBENCH_REQUEST_NOT_FOUND')
    /** 自动 Cookie 只在请求显式开启时读取；关闭时完全不碰 jar。 */
    const cookies = request.useCookieJar ? [...this.activeCookies(context.workspaceId).values()] : []
    const resolved = resolveApiRequest({
      catalog,
      request,
      ...(requestId ? { requestId } : {}),
      ...(effectiveEnvironmentId ? { environmentId: effectiveEnvironmentId } : {}),
      /** 用例覆盖低于显式单次覆盖、高于运行时变量与环境。 */
      ...((testCase?.overrides?.length || input.overrides?.length) ? { overrides: [...(testCase?.overrides ?? []), ...(input.overrides ?? [])] } : {}),
      /** 展示阶段允许对「稍后才提取出来」的变量放占位值；派发阶段永远没有这一项。 */
      runtimeVariables: [
        ...this.runtimeVariableFields(context.workspaceId),
        ...(input.deferredRuntimeVariables ?? []).map((item) => ({ id: `deferred_${item.name}`, name: item.name, value: item.value, enabled: true })),
      ],
      ...(cookies.length > 0 ? { cookieJar: cookies, now: this.now() } : {}),
      /** multipart 的文件引用只在这里解析；失效引用会在解析阶段直接拒绝。 */
      resolveFile: (ref) => this.files.metadata(context.workspaceId, ref),
      resolveSecret: ({ ref, owner }) => this.store.resolveSecret(context.workspaceId, ref, owner),
    })
    /**
     * multipart 只冻结待发计划：**准备阶段绝不读取文件字节**，
     * 字节与 sha256 摘要都留到真正派发（人点发送 / Agent 批准后）时才产生。
     */
    const multipart = resolved.multipart
    if (multipart) {
      /** 附件大小在 stat 阶段已知，先判上限，避免为一条发不出去的请求弹出确认框。 */
      const declaredBytes = multipart.parts.reduce((sum, part) => sum + (part.kind === 'file' ? part.sizeBytes : 0), 0)
      if (declaredBytes > API_LIMITS.bodyBytes) throw new Error('API_WORKBENCH_MULTIPART_TOO_LARGE: 附件合计超过单次请求正文上限')
    }
    const rawRequest = resolved.request
    const createdAt = this.now()
    const preparedId = parseApiId(this.uuid())
    const preview = parseApiPreparedPreview({
      preparedId,
      /** 预览基于待发请求再脱敏；附件字节与 sha256 摘要都不在这一步产生。 */
      request: redactApiRequest(rawRequest, resolved.secretValues),
      requestName: request.name,
      catalogRevision: catalog.revision,
      ...(effectiveEnvironmentId ? { environmentId: effectiveEnvironmentId } : {}),
      ...(resolved.environmentKind ? { environmentKind: resolved.environmentKind } : {}),
      createdAt,
      expiresAt: createdAt + PREPARED_TTL_MS,
      warnings: resolved.environmentKind === 'production' ? ['目标环境标记为 production，执行前必须逐次复核'] : [],
    })
    let origin: string
    try { origin = new URL(resolved.request.url).origin } catch { throw new Error('API_WORKBENCH_URL_INVALID') }
    /**
     * 加密方案在准备阶段冻结：批准卡上列的步骤与 revision 就是执行时用的那一版。
     * 密钥值不在这里读——留到真正派发时再解析，用户可以在批准之后才填密钥。
     */
    const crypto = this.freezeCryptoPlan(catalog, request, {
      ...(effectiveEnvironmentId ? { environmentId: effectiveEnvironmentId } : {}),
      ...((testCase?.overrides?.length || input.overrides?.length) ? { variableOverrides: [...(testCase?.overrides ?? []), ...(input.overrides ?? [])] } : {}),
      ...(input.deferredRuntimeVariables?.length
        ? { deferredRuntimeVariables: input.deferredRuntimeVariables.map((item) => ({ id: `deferred_${item.name}`, name: item.name, value: item.value, enabled: true })) }
        : {}),
      binaryBody: multipart !== undefined,
    })
    this.prepared.set(preparedId, {
      context: { ...context },
      ...(requestId ? { requestId } : {}),
      preview,
      draft: request,
      rawRequest,
      ...(crypto ? { crypto } : {}),
      ...(multipart ? { multipart } : {}),
      assertions: (testCase?.assertions ?? request.assertions).map((assertion) => ({ ...assertion })),
      ...(testCase ? { caseId: testCase.id } : {}),
      extractions: (request.extractions ?? []).map((rule) => ({ ...rule })),
      useCookieJar: request.useCookieJar === true,
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
    /**
     * 附件字节在这里才读：这条路径只在人点发送或 Agent 拿到批准后进入，
     * 因此「批准前不碰文件内容」是时序保证，而不是约定。
     */
    const dispatch = this.composeAttachments(prepared)
    /** 加密与签名在派发前才执行：时间戳贴近真实发送时刻，密钥也在这时才读取。 */
    const crypto = this.applyRequestCrypto(context, prepared, dispatch.request)
    prepared.rawRequest = crypto.request
    /**
     * 记录里保存的请求是**实际发出的形态**（含签名头与密文正文）的脱敏投影：
     * 否则记录会看起来像「发了一条未签名的明文请求」，与事实不符。
     * 变形前明文由 crypto.bodyBeforeTransform 保留，两者可对照。
     */
    /** 没有加密方案时沿用准备阶段的预览；有方案时才换成「实际发出的形态」，并先剥掉二进制正文。 */
    const sentProjection = prepared.crypto === undefined
      ? prepared.preview.request
      : redactApiRequest(requestForRecord(crypto.request), prepared.secretValues)
    const runId = parseApiId(this.uuid())
    const queued = parseApiRun({
      id: runId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      source: context.source,
      requestName: prepared.preview.requestName,
      ...(prepared.requestId ? { requestId: prepared.requestId } : {}),
      ...(prepared.caseId ? { caseId: prepared.caseId } : {}),
      ...(prepared.preview.environmentId ? { environmentId: prepared.preview.environmentId } : {}),
      catalogRevision: prepared.preview.catalogRevision,
      createdAt: this.now(),
      state: 'queued',
      /** 记录里的附件摘要（含 sha256）在这一刻才有，因此按派发结果补进公开投影。 */
      request: dispatch.attachments ? { ...sentProjection, attachments: dispatch.attachments } : sentProjection,
      hops: [],
      body: createEmptyApiBody(),
      assertions: [],
      recording: 'memory-only',
      pinned: false,
      /** 请求侧的加密事实随 queued 一并落盘；解密结论在响应回来后补写。 */
      ...(crypto.facts ? { crypto: crypto.facts } : {}),
    })
    /** 落盘的是脱敏可留存的投影：二进制正文（bodyBase64）不进记录。 */
    const created = this.store.createRun(queued, requestForRecord(prepared.rawRequest), prepared.secretValues)
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
    /** 在途流程先取消再等待：已完成的步骤保留证据，剩余步骤按跳过收尾。 */
    for (const controller of this.scenarioControllers.values()) controller.abort()
    await Promise.all([...this.scenarioTasks.values()].map((task) => task.promise.catch(() => undefined)))
    this.scenarios.clear()
    this.completedScenarios.clear()
    this.store.shutdown()
    this.prepared.clear()
    this.completed.clear()
    /** 运行时变量只活在本次会话，关闭时一并清除。 */
    this.runtimeVariables.clear()
    /** Cookie 同样只活在主进程内存：关闭服务即清空，重启不残留。 */
    this.cookieJar.clear()
    /** 文件引用同理：关闭服务即失效，下次必须重新选择文件。 */
    this.files.clear()
  }

  /**
   * 登记用户通过原生对话框显式选择的一批文件。
   *
   * 这是本进程内唯一接受**路径**的入口，调用方只有原生对话框回调（B12b 的 Agent 审批在批准后复用同一入口）。
   * @param workspaceId 归属工作区。
   * @param paths 用户选择的路径；逐个校验，任一条不合法即整批失败。
   * @returns 可放进请求定义的文件元数据（不含路径）。
   */
  registerPickedFiles(workspaceId: string, paths: readonly string[]): ApiPickedFileMeta[] {
    const id = parseApiId(workspaceId)
    return paths.map((path) => this.files.register(id, path))
  }

  /** 清空一个 workspace 的文件引用，返回被清掉的数量。 */
  clearFiles(workspaceId: string): number {
    return this.files.clear(parseApiId(workspaceId))
  }

  /**
   * 登记 Agent 显式声明的待上传文件（B12b）。
   *
   * 只做 realpath + stat：**不读文件字节**，字节与 sha256 都在批准后的 send 阶段才产生。
   * 路径因此只出现在返回的审批行与文件仓库里，不进请求定义、运行记录或模型上下文。
   * @param workspaceId 归属工作区。
   * @param files Agent 声明的文件（字段名 + 路径 + 可选 Content-Type）。
   * @returns 请求定义用的引用元数据，以及只给审批卡看的真实路径与大小。
   */
  registerAgentFiles(workspaceId: string, files: readonly ApiAgentDeclaredFile[]): ApiAgentFileRegistration {
    const id = parseApiId(workspaceId)
    /** 解析在此重跑一次：服务层不信任调用方已经校验过入参。 */
    const declared = parseApiAgentDeclaredFiles({ kind: 'multipart', text: '', fields: [], files: [...files] })
    const parts: ApiFilePart[] = []
    const approvals: ApiAgentFileRegistration['approvals'] = []
    try {
      for (const file of declared) {
        const meta = this.files.register(id, file.path)
        const located = this.files.locate(id, meta.ref)
        /** 刚登记完就查不到属于内部错误，必须直接拒绝而不是签发一条没有路径的审批行。 */
        if (!located) throw new Error('API_WORKBENCH_FILE_REF_NOT_FOUND: 文件引用登记失败')
        parts.push({ id: file.id, name: file.name, fileName: meta.fileName, sizeBytes: meta.sizeBytes, contentType: file.contentType ?? meta.contentType, ref: meta.ref })
        approvals.push({ field: file.name, path: located.path, sizeBytes: located.sizeBytes })
      }
    } catch (error) {
      /** 批量登记里任一条非法（目录、设备、超限）都整批作废，不留下半截引用。 */
      this.files.release(id, parts.map((part) => part.ref))
      throw error
    }
    return { parts, approvals }
  }

  /** 释放一批刚登记但没能进入请求定义的引用（准备失败时回滚）。 */
  releaseFiles(workspaceId: string, refs: readonly string[]): number {
    return this.files.release(parseApiId(workspaceId), refs)
  }

  /**
   * 准备一次场景（流程）运行：逐步校验引用，并把每一步冻结成独立快照。
   *
   * 准备阶段不出网、不读附件字节；批准的是一份「步骤清单」，执行时逐步核对真正发出去的请求。
   * @param context 可信身份。
   * @param input 场景身份、默认环境与本次变量覆盖。
   * @returns 审批卡与界面共用的步骤清单。
   */
  async prepareScenario(
    context: ApiWorkbenchContext,
    input: { scenarioId: string; environmentId?: string; overrides?: ApiField[] },
  ): Promise<ApiScenarioPreparedPreview> {
    this.assertContext(context)
    if (this.shuttingDown) throw new Error('API_WORKBENCH_SHUTTING_DOWN')
    this.pruneCaches()
    const catalog = this.store.getCatalog(context.workspaceId)
    const scenarioId = parseApiId(input.scenarioId)
    const scenario = (catalog.scenarios ?? []).find((item) => item.id === scenarioId)
    if (!scenario) throw new Error('API_WORKBENCH_SCENARIO_NOT_FOUND')
    if (scenario.steps.length === 0) throw new Error('API_WORKBENCH_SCENARIO_EMPTY: 场景至少需要一个步骤')
    const requestedEnvironmentId = input.environmentId === undefined ? undefined : parseApiId(input.environmentId)
    /**
     * 本流程稍后才会提取出来的变量名：展示阶段先按 `{{名字}}` 放占位值，避免「登录还没跑」
     * 就把审批卡卡住；真正派发时按当时的运行时变量重新解析。
     */
    const existingRuntimeNames = new Set(this.runtimeVariableFields(context.workspaceId).map((field) => field.name))
    const deferredRuntimeVariables = [...new Set(catalog.requests.flatMap((request) => (request.extractions ?? []).map((rule) => rule.name)))]
      .filter((name) => !existingRuntimeNames.has(name))
      .map((name) => ({ name, value: `{{${name}}}` }))
    const steps: PreparedScenarioRecord['steps'] = []
    for (const [index, step] of scenario.steps.entries()) {
      const definition = catalog.requests.find((item) => item.id === step.requestId)
      if (!definition) throw new Error(`API_WORKBENCH_SCENARIO_REQUEST_NOT_FOUND: 第 ${index + 1} 步引用的接口已不存在`)
      if (step.caseId && !(definition.cases ?? []).some((item) => item.id === step.caseId)) {
        throw new Error(`API_WORKBENCH_SCENARIO_CASE_NOT_FOUND: 第 ${index + 1} 步引用的用例已不存在`)
      }
      /**
       * 环境优先级：步骤 > 本次入参 > 场景 > 请求自身标记（仅当该环境仍然存在）。
       * 最后一级让「只标了目标环境的请求」放进流程后也能跑对目标。
       */
      const stepEnvironmentId = step.environmentId ?? requestedEnvironmentId ?? scenario.environmentId
        ?? (definition.targetEnvironmentId && catalog.environments.some((item) => item.id === definition.targetEnvironmentId) ? definition.targetEnvironmentId : undefined)
      /** 展示校验：解析一遍拿到最终方法/URL/环境，并提前撞出引用失效、模板未解析等错误。 */
      const preview = await this.prepare(context, {
        request: apiDraftFromDefinition(definition),
        requestId: definition.id,
        ...(stepEnvironmentId ? { environmentId: stepEnvironmentId } : {}),
        ...((step.overrides?.length ?? 0) + (input.overrides?.length ?? 0) > 0 ? { overrides: [...(step.overrides ?? []), ...(input.overrides ?? [])] } : {}),
        ...(step.caseId ? { caseId: step.caseId } : {}),
        ...(deferredRuntimeVariables.length > 0 ? { deferredRuntimeVariables } : {}),
      })
      /** 该步实际跑的断言集合：用例优先，其次请求自身的默认断言。 */
      const assertions = (step.caseId ? (definition.cases ?? []).find((item) => item.id === step.caseId)?.assertions : undefined) ?? definition.assertions
      steps.push({
        stepId: step.id,
        name: step.name || definition.name,
        requestId: definition.id,
        ...(step.caseId ? { caseId: step.caseId } : {}),
        ...(stepEnvironmentId ? { environmentId: stepEnvironmentId } : {}),
        ...((step.overrides?.length ?? 0) > 0 ? { overrides: step.overrides } : {}),
        method: preview.request.method,
        url: preview.request.url,
        ...(preview.environmentKind ? { environmentKind: preview.environmentKind } : {}),
        assertionCount: assertions.length,
        onFailure: step.onFailure ?? scenario.onFailure,
      })
    }
    const productionSteps = steps.filter((step) => step.environmentKind === 'production').length
    const preparedId = parseApiId(this.uuid())
    const createdAt = this.now()
    const environmentId = requestedEnvironmentId ?? scenario.environmentId
    const preview = parseApiScenarioPreparedPreview({
      preparedId,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      catalogRevision: catalog.revision,
      ...(environmentId ? { environmentId } : {}),
      onFailure: scenario.onFailure,
      createdAt,
      expiresAt: createdAt + PREPARED_TTL_MS,
      warnings: [
        ...(productionSteps > 0 ? [`流程中有 ${productionSteps} 个步骤指向 production 环境，运行前必须逐次复核`] : []),
        ...(scenario.onFailure === 'continue' ? ['失败策略为 continue：某一步失败后仍会继续执行后续步骤'] : []),
      ],
      steps: steps.map((step, index) => ({
        index,
        stepId: step.stepId,
        name: step.name,
        requestId: step.requestId,
        ...(step.caseId ? { caseId: step.caseId } : {}),
        method: step.method,
        url: step.url,
        ...(step.environmentKind ? { environmentKind: step.environmentKind } : {}),
        assertionCount: step.assertionCount,
      })),
    })
    this.scenarios.set(preparedId, { context: { ...context }, preview, scenarioId: scenario.id, scenarioName: scenario.name, onFailure: scenario.onFailure, steps })
    this.pruneCaches()
    return parseApiScenarioPreparedPreview(preview)
  }

  /** 审批展示与运行前复核共用同一份场景快照投影。 */
  async getScenarioPrepared(context: ApiWorkbenchContext, preparedId: string): Promise<ApiScenarioPreparedPreview> {
    return parseApiScenarioPreparedPreview(this.requireScenarioPrepared(context, preparedId).preview)
  }

  /**
   * 执行一次已批准的场景：串行跑完步骤，逐步留下证据。
   *
   * 每一步仍走既有 `send`（去重、调度、取消、落盘都不另起一套）；本层只负责顺序、
   * 失败策略、总时限，以及「发出去的必须就是批准时冻结的那一条」的核对。
   * @param context 可信身份。
   * @param preparedId 场景准备身份。
   * @param signal 外部取消信号（Agent 停止 / 界面取消）。
   * @returns 场景运行摘要。
   */
  async runScenario(context: ApiWorkbenchContext, preparedId: string, signal?: AbortSignal): Promise<ApiScenarioRun> {
    this.assertContext(context)
    const id = parseApiId(preparedId)
    this.pruneCaches()
    const completed = this.completedScenarios.get(id)
    if (completed) {
      this.assertSameContext(completed.context, context)
      try { return this.store.getScenarioRun(context.workspaceId, completed.scenarioRunId) } catch { return parseApiScenarioRun(completed.terminal) }
    }
    const active = this.scenarioTasks.get(id)
    if (active) {
      this.assertSameContext(active.context, context)
      return active.promise
    }
    const prepared = this.requireScenarioPrepared(context, id)
    if (prepared.scenarioRunId) return this.store.getScenarioRun(context.workspaceId, prepared.scenarioRunId)
    const startedAt = this.now()
    const running = this.store.createScenarioRun({
      id: parseApiId(this.uuid()),
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      source: context.source,
      scenarioId: prepared.scenarioId,
      scenarioName: prepared.scenarioName,
      catalogRevision: prepared.preview.catalogRevision,
      ...(prepared.preview.environmentId ? { environmentId: prepared.preview.environmentId } : {}),
      state: 'running',
      startedAt,
      steps: [],
      assertions: [],
    })
    prepared.scenarioRunId = running.id
    /** 取消只作用于当前在途步骤：每一步自身仍是既有的一次派发。 */
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const pending = deferred<ApiScenarioRun>()
    this.scenarioControllers.set(id, controller)
    this.scenarioTasks.set(id, { context: { ...context }, scenarioRunId: running.id, promise: pending.promise })
    void this.executeScenario(context, prepared, running, combined, pending.resolve, startedAt)
    return pending.promise
  }

  /** 取消场景：只中止当前在途步骤，已完成的步骤保留证据。 */
  async cancelScenario(context: ApiWorkbenchContext, preparedId: string): Promise<void> {
    this.assertContext(context)
    const id = parseApiId(preparedId)
    const completed = this.completedScenarios.get(id)
    if (completed) { this.assertSameContext(completed.context, context); return }
    const prepared = this.scenarios.get(id)
    if (!prepared || prepared.context.workspaceId !== context.workspaceId || prepared.context.sessionId !== context.sessionId || prepared.context.source !== context.source) {
      throw new Error('API_WORKBENCH_SCENARIO_PREPARED_NOT_FOUND')
    }
    this.scenarioControllers.get(id)?.abort()
  }

  /** 场景运行列表：界面看整个 workspace，Agent 只看自己会话。 */
  async listScenarioRuns(context: ApiWorkbenchContext, options: { cursor?: number; limit?: number } = {}): Promise<{ runs: ApiScenarioRun[]; nextCursor: number | null }> {
    this.assertContext(context)
    const cursor = Math.max(0, Math.trunc(options.cursor ?? 0))
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)))
    return this.store.listScenarioRuns(context.workspaceId, cursor, limit, context.source === 'agent' ? context.sessionId : undefined)
  }

  /** 读取一条场景运行；Agent 不能读别的会话的流程。 */
  async getScenarioRun(context: ApiWorkbenchContext, scenarioRunId: string): Promise<ApiScenarioRun> {
    this.assertContext(context)
    const run = this.store.getScenarioRun(context.workspaceId, parseApiId(scenarioRunId))
    if (context.source === 'agent' && run.sessionId !== context.sessionId) throw new Error('API_WORKBENCH_SCENARIO_RUN_FORBIDDEN')
    return run
  }

  /** 场景执行主体：顺序、失败策略、总时限、逐步核对与逐步落盘。 */
  private async executeScenario(
    context: ApiWorkbenchContext,
    prepared: PreparedScenarioRecord,
    running: ApiScenarioRun,
    signal: AbortSignal,
    resolve: (run: ApiScenarioRun) => void,
    startedAt: number,
  ): Promise<void> {
    const preparedId = prepared.preview.preparedId
    const outcomes: ApiScenarioStepOutcome[] = []
    let stopped = false
    let stoppedMessage = ''
    let failure: ApiScenarioRun['error']
    try {
      for (const step of prepared.steps) {
        if (signal.aborted) {
          outcomes.push({ stepId: step.stepId, name: step.name, state: 'skipped', status: null, assertionPassed: 0, assertionTotal: 0, durationMs: null, message: '流程已取消' })
          continue
        }
        if (stopped) {
          outcomes.push({ stepId: step.stepId, name: step.name, state: 'skipped', status: null, assertionPassed: 0, assertionTotal: 0, durationMs: null, message: stoppedMessage })
          continue
        }
        /** 总时限：到点不再启动后续步骤，避免一条流程无限挂住。 */
        if (this.now() - startedAt > API_LIMITS.scenarioTotalMs) {
          stopped = true
          stoppedMessage = '流程总时限已到，未执行的步骤被跳过'
          failure = { code: 'API_WORKBENCH_SCENARIO_TIMEOUT', phase: 'scenario', message: stoppedMessage }
          outcomes.push({ stepId: step.stepId, name: step.name, state: 'skipped', status: null, assertionPassed: 0, assertionTotal: 0, durationMs: null, message: stoppedMessage })
          continue
        }
        try {
          /**
           * 按**当时**的运行时变量准备这一步：登录流程的后续步骤要用上一步提取出来的值，
           * 所以不能拿准备阶段（那时还没有 token）的解析结果去发请求。
           */
          const definition = this.store.getCatalog(context.workspaceId).requests.find((item) => item.id === step.requestId)
          if (!definition) throw new Error(`API_WORKBENCH_SCENARIO_REQUEST_NOT_FOUND: 步骤「${step.name}」引用的接口已不存在`)
          const preview = await this.prepare(context, {
            request: apiDraftFromDefinition(definition),
            requestId: definition.id,
            ...(step.environmentId ? { environmentId: step.environmentId } : {}),
            ...(step.overrides?.length ? { overrides: step.overrides } : {}),
            ...(step.caseId ? { caseId: step.caseId } : {}),
          })
          const run = await this.send(context, preview.preparedId, signal)
          /** 逐步核对：真正发出去的必须就是批准时冻结的那一条。 */
          if (run.request.method !== step.method || run.request.url !== step.url) {
            throw new Error(`API_WORKBENCH_SCENARIO_APPROVAL_STALE: 步骤「${step.name}」与批准快照不一致`)
          }
          const failedAssertion = run.assertions.find((item) => !item.passed)
          const passed = run.state === 'completed' && run.assertions.every((item) => item.passed)
          outcomes.push({
            stepId: step.stepId, name: step.name, state: passed ? 'passed' : 'failed', runId: run.id,
            status: run.hops.at(-1)?.status ?? null,
            assertionPassed: run.assertions.filter((item) => item.passed).length, assertionTotal: run.assertions.length,
            durationMs: run.finishedAt === undefined ? null : Math.max(0, run.finishedAt - run.createdAt),
            ...(passed ? {} : { message: run.error?.message ?? failedAssertion?.message ?? (run.state === 'cancelled' ? '步骤已取消' : '步骤未通过') }),
          })
          /** 取消或失败都不悄悄继续：剩下的步骤按跳过记录，绝不替人补发请求。 */
          if (run.state === 'cancelled') { stopped = true; stoppedMessage = '上一步已取消，后续步骤不再执行' }
          else if (!passed && step.onFailure === 'stop') { stopped = true; stoppedMessage = '上一步失败后按 stop 策略跳过后续步骤' }
        } catch (error) {
          outcomes.push({
            stepId: step.stepId, name: step.name, state: 'error', status: null, assertionPassed: 0, assertionTotal: 0, durationMs: null,
            message: error instanceof Error ? error.message.slice(0, 4096) : '步骤执行失败',
          })
          if (step.onFailure === 'stop') { stopped = true; stoppedMessage = '上一步失败后按 stop 策略跳过后续步骤' }
        }
        /** 逐步落盘：界面与人都能看到流程当前进度，而不是只在最后拿到结论。 */
        this.store.updateScenarioRun(context.workspaceId, running.id, ['running'], (current) => ({ ...current, steps: [...outcomes] }))
      }
      const cancelled = signal.aborted
      const failedStep = outcomes.find((step) => step.state === 'failed' || step.state === 'error')
      /** 超时或失败都会把流程判为失败：跳过不等于通过。 */
      const finalState: ApiScenarioRun['state'] = cancelled ? 'cancelled' : failedStep || failure ? 'failed' : 'completed'
      const final = this.store.updateScenarioRun(context.workspaceId, running.id, ['running'], (current) => ({
        ...current,
        state: finalState,
        finishedAt: this.now(),
        steps: outcomes,
        /** 流程结论由每步结论聚合：步骤全通过才算流程通过。 */
        assertions: outcomes.map((step) => ({
          id: step.stepId,
          passed: step.state === 'passed',
          expected: '步骤通过',
          actual: step.state,
          message: step.message ?? '步骤通过',
        })),
        ...(cancelled
          ? { error: { code: 'API_WORKBENCH_CANCELLED', phase: 'scenario', message: '流程已取消' } }
          : failure ? { error: failure }
            : failedStep ? { error: { code: 'API_WORKBENCH_SCENARIO_FAILED', phase: 'scenario', message: `步骤「${failedStep.name}」未通过` } } : {}),
      }))
      this.completedScenarios.set(preparedId, { context: { ...context }, scenarioRunId: final.id, completedAt: this.now(), terminal: final })
      this.scenarios.delete(preparedId)
      resolve(parseApiScenarioRun(final))
    } catch (error) {
      /** 执行体自身失败（例如落盘损坏）也要给出终态，不能留下永远 running 的流程。 */
      const failed = this.store.updateScenarioRun(context.workspaceId, running.id, ['running'], (current) => ({
        ...current,
        state: 'failed',
        finishedAt: this.now(),
        steps: outcomes,
        error: { code: 'API_WORKBENCH_SCENARIO_FAILED', phase: 'scenario', message: error instanceof Error ? error.message.slice(0, 4096) : '流程执行失败' },
      }))
      this.completedScenarios.set(preparedId, { context: { ...context }, scenarioRunId: failed.id, completedAt: this.now(), terminal: failed })
      this.scenarios.delete(preparedId)
      resolve(parseApiScenarioRun(failed))
    } finally {
      this.scenarioControllers.delete(preparedId)
      this.scenarioTasks.delete(preparedId)
    }
  }

  /** 场景准备记录的共用校验：身份、有效期与目录 revision 三者都要对得上。 */
  private requireScenarioPrepared(context: ApiWorkbenchContext, preparedId: string): PreparedScenarioRecord {
    this.assertContext(context)
    const record = this.scenarios.get(parseApiId(preparedId))
    if (!record
      || record.context.workspaceId !== context.workspaceId
      || record.context.sessionId !== context.sessionId
      || record.context.source !== context.source) {
      throw new Error('API_WORKBENCH_SCENARIO_PREPARED_NOT_FOUND')
    }
    if (this.now() > record.preview.expiresAt) throw new Error('API_WORKBENCH_SCENARIO_PREPARED_EXPIRED')
    /** 目录被改动（含请求被编辑/删除）就拒绝：批准的是当时那一份流程。 */
    if (this.store.getCatalog(context.workspaceId).revision !== record.preview.catalogRevision) throw new Error('API_WORKBENCH_SCENARIO_PREPARED_STALE')
    return record
  }

  /**
   * 冻结请求选中的加密方案。
   * 方案缺失直接拒绝：用户既然显式选了安全方案，就不能因为方案被删而静默按明文发出。
   */
  private freezeCryptoPlan(catalog: ApiCatalog, request: ApiRequestDraft, options: {
    environmentId?: string
    variableOverrides?: ApiField[]
    deferredRuntimeVariables?: ApiField[]
    /** 该请求是 multipart（二进制正文）：P1 的加密步骤只支持文本正文。 */
    binaryBody: boolean
  }): FrozenCryptoPlan | undefined {
    if (request.selectedProfileId === undefined) return undefined
    const profile = (catalog.cryptoProfiles ?? []).find((item) => item.id === request.selectedProfileId)
    if (!profile) throw new Error('API_WORKBENCH_CRYPTO_PROFILE_NOT_FOUND')
    if (options.binaryBody && profile.requestSteps.some((step) => step.enabled && step.kind === 'encrypt')) {
      throw new Error('API_WORKBENCH_CRYPTO_BINARY_BODY_UNSUPPORTED: 加密步骤只支持文本正文，multipart 请求请改用签名')
    }
    /**
     * 要解析的密钥变量名：方案步骤引用的 + 接口级覆盖项替换后的名字。
     * 漏掉覆盖项会让「本接口改用另一把密钥」永远解析不到值，被误判成缺密钥。
     */
    const names = [...new Set([
      ...[...profile.requestSteps, ...profile.responseSteps].flatMap((step) => [step.keyRef, step.ivRef]),
      ...Object.values(request.cryptoOverrides?.keyRefs ?? {}),
    ].filter((name): name is string => name !== undefined))]
    return {
      profile,
      ...(request.cryptoOverrides ? { overrides: request.cryptoOverrides } : {}),
      ...(options.environmentId ? { environmentId: options.environmentId } : {}),
      ...(options.variableOverrides ? { variableOverrides: options.variableOverrides } : {}),
      ...(options.deferredRuntimeVariables ? { deferredRuntimeVariables: options.deferredRuntimeVariables } : {}),
      names,
    }
  }

  /** 按同一条作用域链解析方案引用的密钥；只读被显式点名的变量。 */
  private cryptoSecrets(context: ApiWorkbenchContext, plan: FrozenCryptoPlan, draft: ApiRequestDraft): Record<string, string> {
    return resolveApiCryptoSecrets({
      catalog: this.store.getCatalog(context.workspaceId),
      collectionId: draft.collectionId,
      ...(plan.environmentId ? { environmentId: plan.environmentId } : {}),
      ...(plan.variableOverrides ? { overrides: plan.variableOverrides } : {}),
      runtimeVariables: [...this.runtimeVariableFields(context.workspaceId), ...(plan.deferredRuntimeVariables ?? [])],
      names: plan.names,
      resolveSecret: ({ ref, owner }) => this.store.resolveSecret(context.workspaceId, ref, owner),
    })
  }

  /**
   * 执行请求侧的签名与加密。
   * 只在派发路径调用：时间戳/nonce 必须贴近真实发送时刻，密钥也在这一刻才被读取。
   */
  private applyRequestCrypto(context: ApiWorkbenchContext, prepared: PreparedRecord, request: ApiResolvedRequest): { request: ApiResolvedRequest; facts?: ApiRunCrypto } {
    const plan = prepared.crypto
    if (!plan) return { request }
    if (request.bodyBase64 !== undefined && plan.profile.requestSteps.some((step) => step.enabled && step.kind === 'encrypt')) {
      throw new Error('API_WORKBENCH_CRYPTO_BINARY_BODY_UNSUPPORTED: 加密步骤只支持文本正文，multipart 请求请改用签名')
    }
    const url = new URL(request.url)
    const outcome = applyRequestSteps({
      profile: plan.profile,
      secrets: this.cryptoSecrets(context, plan, prepared.draft),
      ...(plan.overrides ? { overrides: plan.overrides } : {}),
      request: {
        method: request.method,
        path: url.pathname,
        query: [...url.searchParams.entries()].map(([name, value]) => ({ name, value })),
        headers: request.headers.map(({ name, value }) => ({ name, value })),
        body: request.body,
      },
    })
    return { request: rebaseApiRequest(request, url, outcome), facts: runCryptoFromRequest(plan.profile, outcome) }
  }

  /**
   * 执行响应侧解密，返回解密后的正文与事实。
   * 解密必须在断言与提取之前完成：它们读的是解密后的原始正文，而不是密文。
   */
  private applyResponseCrypto(task: ScheduledTask, result: ApiTransportResult): ReturnType<typeof applyResponseSteps> | undefined {
    const plan = task.prepared.crypto
    if (!plan) return undefined
    /** 正文不完整时直接判失败：截断的密文解出来只会是噪声，还会把原因误报成「密钥不对」。 */
    if (!result.body.complete || result.body.previewTruncated) {
      return {
        body: result.body.preview, decrypted: false, executed: [], skipped: [],
        failure: { code: 'API_CRYPTO_DECRYPT_FAILED', message: '正文不完整或超出预览范围，无法解密' },
      }
    }
    return applyResponseSteps({
      profile: plan.profile,
      secrets: this.cryptoSecrets(task.prepared.context, plan, task.prepared.draft),
      ...(plan.overrides ? { overrides: plan.overrides } : {}),
      responseBody: result.body.preview,
    })
  }

  /**
   * 按待发计划读取附件并合成待发正文。
   *
   * 只有真正派发时才会调用：读取前由文件仓库复核 inode 与时间戳，文件被换掉即拒绝。
   * @param prepared 已准备记录。
   * @returns 待发请求与可留存的附件摘要；没有附件时原样返回。
   */
  private composeAttachments(prepared: PreparedRecord): { request: ApiResolvedRequest; attachments?: ApiAttachmentSummary[] } {
    const plan = prepared.multipart
    if (!plan) return { request: prepared.rawRequest }
    /** 字段名按引用对应，读取时一起产出可留存的附件摘要。 */
    const fieldByRef = new Map(plan.parts.flatMap((part) => part.kind === 'file' ? [[part.ref, part.name] as const] : []))
    const attachments: ApiAttachmentSummary[] = []
    const composed = composeMultipartBody(plan.boundary, plan.parts, (ref) => {
      const file = this.files.read(prepared.context.workspaceId, ref)
      attachments.push({ field: fieldByRef.get(ref) ?? '', fileName: file.summary.fileName, sizeBytes: file.summary.sizeBytes, sha256: file.summary.sha256 })
      return file.bytes
    })
    if (composed.byteLength > API_LIMITS.bodyBytes) throw new Error('API_WORKBENCH_MULTIPART_TOO_LARGE: 附件与字段合计超过单次请求正文上限')
    return { request: { ...prepared.rawRequest, bodyBase64: composed.toString('base64'), attachments }, attachments }
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
      /**
       * 响应先解密，再交给断言与提取：它们必须读解密后的原始正文。
       * 记录里保存的也是解密后的正文预览；解密失败时保留密文原文并附上可分类原因。
       */
      const cryptoResponse = this.applyResponseCrypto(task, result)
      const effectiveResult = cryptoResponse === undefined ? result : { ...result, body: { ...result.body, preview: cryptoResponse.body } }
      /** 只有开启自动 Cookie 的请求才写 jar：关闭的请求不产生任何 cookie 副作用。 */
      this.recordCookies(task, result)
      let recordingFailed = result.error?.code === 'API_ARTIFACT_UNAVAILABLE'
      try { this.store.saveRawDetails(task.prepared.context.workspaceId, runId, requestForRecord(task.prepared.rawRequest), result.hops) }
      catch { recordingFailed = true }
      const publicResult = redactTransportResult(effectiveResult, task.prepared.rawRequest, task.prepared.secretValues)
      const state = result.state
      const assertionResults = evaluateApiAssertions(task.prepared.assertions, effectiveResult, {
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
        extracted: this.recordExtractions(task, effectiveResult, result.state === 'completed'),
        /** 解密结论与失败原因补写进同一个 crypto 字段。 */
        ...(run.crypto === undefined || cryptoResponse === undefined ? {} : {
          crypto: {
            ...run.crypto,
            /** 响应侧事实并入记录：解密步骤跑了什么、跳过了什么同样要能看到。 */
            executed: [...run.crypto.executed, ...cryptoResponse.executed],
            skipped: [...run.crypto.skipped, ...cryptoResponse.skipped],
            decrypted: cryptoResponse.decrypted,
            ...(cryptoResponse.failure ? { failure: cryptoResponse.failure } : {}),
          },
        }),
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
      /** 终态投影同样丢掉变形前明文，避免常驻内存里留一份请求正文。 */
      ...(run.crypto ? { crypto: stripRunCryptoHeavy(run.crypto) } : {}),
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

  /** 读取未过期的 cookie 元数据；取值不离开主进程。 */
  getCookieJar(workspaceId: string): ApiCookieJarEntry[] {
    return [...this.activeCookies(parseApiId(workspaceId)).values()].map((cookie) => ({
      name: cookie.name, domain: cookie.domain, path: cookie.path,
      secure: cookie.secure, httpOnly: cookie.httpOnly,
      expiresAt: cookie.expiresAt, updatedAt: cookie.updatedAt,
    }))
  }

  /** 清空一个 workspace 的 Cookie Jar，返回被清掉的数量。 */
  clearCookieJar(workspaceId: string): number {
    const id = parseApiId(workspaceId)
    const removed = this.cookieJar.get(id)?.size ?? 0
    this.cookieJar.delete(id)
    return removed
  }

  /** 取出未过期的 cookie，顺带清掉已过期的条目（服务端删 cookie 也走这里）。 */
  private activeCookies(workspaceId: string): Map<string, ApiCookieJarRecord> {
    const existing = this.cookieJar.get(workspaceId)
    if (!existing) return new Map()
    const now = this.now()
    for (const [key, cookie] of existing) {
      if (isCookieExpired(cookie, now)) existing.delete(key)
    }
    return existing
  }

  /**
   * 采集本次运行所有跳转的 Set-Cookie。
   * @param task 当前任务，提供 workspace 与「是否开启自动 Cookie」的冻结事实。
   * @param result 传输结果，逐跳读取响应头里的原始 Set-Cookie。
   */
  private recordCookies(task: ScheduledTask, result: ApiTransportResult): void {
    /** 关闭自动 Cookie 的请求完全不写 jar，保证「没开就不会悄悄产生状态」。 */
    if (!task.prepared.useCookieJar || result.state !== 'completed') return
    const workspaceId = task.prepared.context.workspaceId
    const now = this.now()
    const target = this.cookieJar.get(workspaceId) ?? new Map<string, ApiCookieJarRecord>()
    for (const hop of result.hops) {
      let url: URL
      try { url = new URL(hop.url) } catch { continue }
      for (const header of hop.responseHeaders) {
        const parsed = parseApiSetCookie(header, url, now)
        if (!parsed) continue
        /** 过期即删除：Max-Age=0 或已过 Expires 的响应就是服务端在清 cookie。 */
        if (isCookieExpired(parsed.record, now)) target.delete(parsed.key)
        else target.set(parsed.key, parsed.record)
      }
    }
    /** 条目有上限，超出时按最久未更新淘汰，避免一次恶意响应把内存顶满。 */
    while (target.size > MAX_COOKIE_JAR_ENTRIES) {
      const oldest = [...target.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0]
      if (!oldest) break
      target.delete(oldest[0])
    }
    if (target.size > 0) this.cookieJar.set(workspaceId, target)
    else this.cookieJar.delete(workspaceId)
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
    /** 场景准备记录沿用单次请求的过期与条数上限；在途流程不清理。 */
    for (const [id, record] of this.scenarios) {
      if (record.preview.expiresAt + PREPARED_REASON_TTL_MS < now && !this.scenarioTasks.has(id)) this.scenarios.delete(id)
    }
    while (this.scenarios.size > MAX_PREPARED_RECORDS) {
      const removable = [...this.scenarios.entries()]
        .filter(([id]) => !this.scenarioTasks.has(id))
        .sort((a, b) => a[1].preview.createdAt - b[1].preview.createdAt)[0]
      if (!removable) break
      this.scenarios.delete(removable[0])
    }
    for (const [id, record] of this.completedScenarios) {
      if (record.completedAt + COMPLETED_IDENTITY_TTL_MS < now) this.completedScenarios.delete(id)
    }
    while (this.completedScenarios.size > MAX_COMPLETED_IDENTITIES) {
      const oldest = [...this.completedScenarios.entries()].sort((a, b) => a[1].completedAt - b[1].completedAt)[0]
      if (!oldest) break
      this.completedScenarios.delete(oldest[0])
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
