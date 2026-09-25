/** 接口工作台的跨进程合同；所有数组都保留用户顺序与重复名称。 */
export const API_WORKBENCH_CHANNELS = { INVOKE: 'api-workbench:invoke', CHANGED: 'api-workbench:changed', STREAM: 'api-workbench:stream' } as const
/** 单次请求和模型读取的固定预算。 */
export const API_LIMITS = {
  requestBytes: 1024 * 1024, bodyBytes: 20 * 1024 * 1024, previewBytes: 256 * 1024, agentBytes: 32 * 1024,
  catalogBytes: 2 * 1024 * 1024, maxFields: 128, maxRequests: 256, maxRuns: 1000, historyBytes: 1024 * 1024 * 1024, historyDays: 7,
  /** 运行记录保留的 SSE 事件条数与单帧字符上限。 */
  sseEvents: 2_000, sseEventChars: 16 * 1024,
  /** 单条运行保留的事件总字符上限，避免记录超过落盘预算。 */
  sseTotalChars: 2 * 1024 * 1024,
  /** 单条流式通知的增量上限，避免一次广播过大。 */
  sseDeltaEvents: 64, sseDeltaChars: 32 * 1024,
  /** 单个请求可声明的提取规则数量，以及单个提取值的字符上限。 */
  maxExtractions: 16, extractionValueChars: 4096,
  /** 单个请求可声明的测试用例数量。 */
  maxCases: 16,
  /** 单次请求可携带的文件数量（multipart）。 */
  maxFileParts: 16,
  /** 单个 workspace 可保存的场景数量、单个场景的步骤数量，以及保留的场景运行条数。 */
  maxScenarios: 64, maxScenarioSteps: 20, maxScenarioRuns: 200,
  /** 一次场景运行的总时限：到点不再启动后续步骤，避免流程无限挂住。 */
  scenarioTotalMs: 10 * 60 * 1000,
} as const
/** 一条具名测试用例：同一接口的不同预期，可带用例级变量覆盖。 */
export interface ApiTestCase {
  id: string
  name: string
  /** 该用例的断言集合；为空表示只跑请求、不做校验。 */
  assertions: ApiAssertion[]
  /** 用例级变量覆盖，优先级高于运行时变量与环境；不写入环境定义。 */
  overrides?: ApiField[]
  /** 该用例默认使用的环境；环境被删除后按未指定处理。 */
  environmentId?: string
  /**
   * 用例来源，由 Host 盖章：'user' 表示人工在界面或导入中创建，'agent' 表示 Agent 声明。
   * 模型不能自行声明该字段；解析时缺省补 'user'（升级前保存的用例都来自人工编辑）。
   */
  source?: 'user' | 'agent'
}
/** 从响应里取值的声明式规则；只描述来源，不携带任何值。 */
export interface ApiExtraction {
  id: string
  /** 目标变量名，必须能直接写成 {{name}} 使用。 */
  name: string
  /** 取值来源：正文 JSON 路径、响应 Header，或事件流最后一个带数据的事件。 */
  from: 'json' | 'header' | 'sse-last-data'
  /** json/header 必填；sse-last-data 可留空表示整段 data，也可给内部 JSON 路径。 */
  path: string
  /** 命中后按秘密处理：不进模型可见结果，也不出现在运行记录里。 */
  secret: boolean
}
/** 运行记录里的提取结果：只保留结果事实与原因，绝不保留取值。 */
export interface ApiExtractionOutcome { id: string; name: string; from: ApiExtraction['from']; found: boolean; secret: boolean; message?: string }
/** 运行时变量只回传元数据，值只在主进程内部使用。 */
export interface ApiRuntimeVariable { name: string; secret: boolean; source: string; updatedAt: number }
/**
 * Cookie Jar 的公开元数据：界面只用来展示与清理，**不含取值**。
 * 作用域按 host-only 记录：domain 就是收到 Set-Cookie 的那个 host，不做跨域共享。
 */
export interface ApiCookieJarEntry {
  name: string
  domain: string
  path: string
  /** 仅 https 回送。 */
  secure: boolean
  /** 服务端标记 HttpOnly；界面据此提示「脚本不可见」，不影响本机回送。 */
  httpOnly: boolean
  /** 过期时间；会话 cookie 为 null。 */
  expiresAt: number | null
  updatedAt: number
}
/** 单个 SSE 事件：序号、到达时间与原始帧同时保留，便于逐帧核对。 */
export interface ApiSseEvent {
  index: number; receivedMs: number
  event: string; id: string; comment: string; data: string; retry?: number
  raw: string; truncated: boolean
}
/** 流式响应的计数事实；事件明细单独存放，历史摘要只保留本对象。 */
export interface ApiSseSummary { totalEvents: number; firstEventMs: number | null; endedReason: 'completed' | 'cancelled' | 'error' }
/** 运行记录里的事件流：明细受条数与字符上限约束，超出部分只记数量。 */
export interface ApiSseStream extends ApiSseSummary { events: ApiSseEvent[]; droppedEvents: number }
/** 流式事件通知只携带增量，不重复正文；会话用于跨会话过滤。 */
export interface ApiRunStreamChanged { sessionId: string; runId: string; events: ApiSseEvent[] }
/** 首批支持的方法；不开放代理隧道和升级协议。 */
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
/** 可编辑值：已保存秘密仅返回绑定所属对象的引用，不返回明文。 */
export interface ApiValue { value: string; secret?: boolean; secretRef?: string }
/** 参数、Header、变量和表单行，id 是编辑身份，name 允许重复。 */
export interface ApiField extends ApiValue { id: string; name: string; enabled: boolean }
/** 传输头保留原始大小写与同名项；来源说明是否由用户或执行器添加。 */
export interface ApiHeader { name: string; value: string; source?: 'user' | 'generated' }
/** 鉴权值为 token、password 或 API Key；无鉴权仍保留空 value 便于受控表单。 */
export interface ApiAuth { type: 'none' | 'bearer' | 'basic' | 'api-key'; value: ApiValue; username?: string; name?: string; in?: 'header' | 'query' }
/** 请求正文；urlencoded 使用 fields，json/text 使用 text。 */
export interface ApiRequestBody {
  kind: 'none' | 'json' | 'text' | 'urlencoded' | 'multipart'
  text: string
  fields: ApiField[]
  /**
   * multipart 的文件部分。**只存引用，不存路径**：真实路径留在主进程内存里，服务重启即失效。
   * 可选是为了兼容升级前保存的请求，解析时缺省补成空数组。
   */
  files?: ApiFilePart[]
}
/**
 * 一个待上传的文件：引用由主进程签发，界面与模型都拿不到真实路径。
 * 引用失效（重启/文件被移动）时必须在派发前拒绝，不能静默发出不带附件的请求。
 */
export interface ApiFilePart {
  id: string
  /** 表单字段名，例如 `file`。 */
  name: string
  /** 只用于展示与 Content-Disposition 的文件名。 */
  fileName: string
  sizeBytes: number
  contentType?: string
  ref: string
}
/** 运行记录与预览里的附件摘要：不含字节、不含路径。 */
export interface ApiAttachmentSummary {
  field: string
  fileName: string
  sizeBytes: number
  sha256: string
}
/** 用户通过原生对话框选择文件后回传的元数据；**不含路径**（路径只在主进程内存）。 */
export interface ApiPickedFile {
  ref: string
  fileName: string
  sizeBytes: number
  contentType: string
}
/**
 * 无脚本断言。JSON 路径使用简单点路径和数组下标；事件流断言只看有界事实：
 * sse-count/sse-first-event 复用 `<=10` 形式的比较，sse-ended 比较结束原因，
 * sse-last-data 的 expected 以 `=` 开头表示精确匹配，否则表示包含。
 */
export interface ApiAssertion {
  id: string
  kind: 'status' | 'header' | 'json-value' | 'json-exists' | 'json-type' | 'duration' | 'sse-count' | 'sse-first-event' | 'sse-ended' | 'sse-last-data'
  path: string
  expected: string
}
/** 可编辑请求；变量在 prepare 时解析，编辑不得改变在途快照。 */
export interface ApiRequestDraft {
  name: string; collectionId: string; folder: string; description: string
  method: ApiMethod; url: string; query: ApiField[]; headers: ApiField[]
  body: ApiRequestBody; auth: ApiAuth
  timeoutMs: number; followRedirects: boolean; maxRedirects: number; assertions: ApiAssertion[]
  /**
   * 运行结束后从响应里取出的值；这些值只写入本次会话的运行时变量。
   * 可选是为了兼容升级前保存的请求：解析时缺省补成空数组。
   */
  extractions?: ApiExtraction[]
  /**
   * 该接口绑定的目标环境；只是标记与默认选择，不授予任何执行权限。
   * 可选是为了兼容升级前保存的请求；环境被删除后这里会留下悬空引用，界面按「环境已删除」显示。
   */
  targetEnvironmentId?: string
  /**
   * 具名测试用例；可选是为了兼容升级前保存的请求，解析时缺省补成空数组。
   * 请求自身的 assertions 仍然有效，等价于「默认用例」。
   */
  cases?: ApiTestCase[]
  /**
   * 是否启用自动 Cookie：为真时本次请求读取并写入宿主内存里的 Cookie Jar，为假或缺省时完全不碰 cookie。
   * 默认关闭是为了避免「某条请求因为上次的 cookie 而悄悄成功」。
   */
  useCookieJar?: boolean
}
/** 已保存请求具有独立版本，更新采用 expected revision 比较。 */
export interface ApiRequestDefinition extends ApiRequestDraft { id: string; revision: number; updatedAt: number }
/** 集合包含默认变量；请求分组使用 folder 字符串路径。 */
export interface ApiCollection { id: string; name: string; description: string; variables: ApiField[] }
/** 环境用途是展示和执行策略事实，不根据方法推断生产副作用。 */
export interface ApiEnvironment { id: string; name: string; kind: 'local' | 'test' | 'production'; variables: ApiField[] }
/**
 * 场景里的一个步骤：只引用已保存的请求（含可选用例），不内联请求定义。
 *
 * 理由：内联会让同一条请求出现两份定义，跑出来的证据无法对人维护的那一份；
 * 步骤级覆盖只在本次运行生效，不写回请求定义。
 */
export interface ApiScenarioStep {
  id: string
  /** 展示名；缺省用请求名。 */
  name: string
  requestId: string
  /** 按用例执行该步骤；缺省用请求自身的默认断言。 */
  caseId?: string
  /** 步骤级环境覆盖；缺省用场景环境，再缺省用请求自身标记。 */
  environmentId?: string
  /** 步骤级变量覆盖，优先级高于运行时变量与环境，不写入任何定义。 */
  overrides?: ApiField[]
  /** 该步失败后的走向；缺省沿用场景级策略。 */
  onFailure?: ApiScenarioFailurePolicy
}
/** 步骤失败后的走向：停止（后续标记跳过）或继续跑完。 */
export type ApiScenarioFailurePolicy = 'stop' | 'continue'
/** 一条可重复执行的接口流程：有序步骤 + 默认环境 + 默认失败策略。 */
export interface ApiScenario {
  id: string
  name: string
  description: string
  /** 归入某个集合（集合即端 / 产品线，文件夹即模块）。 */
  collectionId: string
  folder: string
  steps: ApiScenarioStep[]
  /** 场景默认环境；步骤可覆盖。 */
  environmentId?: string
  onFailure: ApiScenarioFailurePolicy
  revision: number
  updatedAt: number
}
/** 场景里单步的执行结论；runId 指向该步真实的运行记录。 */
export interface ApiScenarioStepOutcome {
  stepId: string
  name: string
  state: 'passed' | 'failed' | 'skipped' | 'error'
  /** 该步真实运行身份；被跳过或准备失败时缺省。 */
  runId?: string
  status: number | null
  assertionPassed: number
  assertionTotal: number
  durationMs: number | null
  message?: string
}
/** 一次场景运行：紧凑摘要，不携带任何正文与秘密；每步证据在各自 ApiRun 里。 */
export interface ApiScenarioRun {
  id: string
  workspaceId: string
  sessionId: string
  source: 'manual' | 'agent'
  scenarioId?: string
  scenarioName: string
  catalogRevision: number
  environmentId?: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt?: number
  steps: ApiScenarioStepOutcome[]
  /** 流程结论：所有已执行步骤的断言结论聚合。 */
  assertions: ApiAssertionResult[]
  error?: ApiFailure
}
/** 场景准备后的单步投影：审批卡与界面据此逐行核对「即将发出的请求」。 */
export interface ApiScenarioStepPreview {
  /** 执行顺序，从 0 开始。 */
  index: number
  stepId: string
  name: string
  requestId: string
  caseId?: string
  method: ApiMethod
  /** 解析后的最终 URL：批准的是这一串地址，执行时也必须是同一串。 */
  url: string
  environmentKind?: ApiEnvironment['kind']
  assertionCount: number
}
/** 场景准备结果：一次批准针对的就是这份步骤清单。 */
export interface ApiScenarioPreparedPreview {
  preparedId: string
  scenarioId: string
  scenarioName: string
  catalogRevision: number
  environmentId?: string
  onFailure: ApiScenarioFailurePolicy
  createdAt: number
  expiresAt: number
  /** 生产中环境等必须让用户先看到的提醒。 */
  warnings: string[]
  steps: ApiScenarioStepPreview[]
}
/** workspace 的有界目录；不包含运行正文和秘密明文。 */
export interface ApiCatalog { version: 1; revision: number; collections: ApiCollection[]; environments: ApiEnvironment[]; requests: ApiRequestDefinition[]; scenarios?: ApiScenario[] }
/** Host 准备完成的网络输入；此类型的原文只在可信执行边界流转。 */
export interface ApiResolvedRequest {
  method: ApiMethod; url: string; headers: ApiHeader[]; body: string
  timeoutMs: number; followRedirects: boolean; maxRedirects: number
  /** 敏感查询参数和头名称由 Host 标记，重定向与公开投影共用。 */
  sensitiveHeaderNames: string[]; sensitiveQueryNames: string[]
  /**
   * 含二进制附件时的待发正文（base64）：只在主进程与 Utility 之间流转，
   * **绝不进入预览、运行记录或模型上下文**；记录里只保留 body 的摘要与 attachments。
   */
  bodyBase64?: string
  /**
   * 附件摘要；**只在真正派发时才产生**（准备阶段只做 realpath + stat，不读字节），
   * 运行记录用它说明发了什么，而不是把文件内容复制进应用数据根。
   */
  attachments?: ApiAttachmentSummary[]
}
/** 发送前公开的固定快照，request 已脱敏。 */
export interface ApiPreparedPreview {
  preparedId: string; request: ApiResolvedRequest; requestName: string
  catalogRevision: number; environmentId?: string; environmentKind?: ApiEnvironment['kind']
  createdAt: number; expiresAt: number; warnings: string[]
}
/** 未发生或不可观测的连接阶段为 null，不能伪造 0。 */
export interface ApiTimings { dnsMs: number | null; connectMs: number | null; tlsMs: number | null; sendMs: number | null; ttfbMs: number | null; downloadMs: number | null; totalMs: number }
/** 仅展示可从当前 socket 观察到的连接/TLS 事实。 */
export interface ApiConnectionInfo {
  reused: boolean; remoteAddress?: string; remotePort?: number; localAddress?: string; localPort?: number
  tls?: { protocol: string; cipher: string; authorized: boolean; authorizationError?: string; subject: string; issuer: string; validFrom: string; validTo: string }
}
/** 一次 HTTP 往返；请求头说明来源，响应头为 rawHeaders 的顺序副本。 */
export interface ApiHttpHop {
  url: string; method: ApiMethod; requestHeaders: ApiHeader[]
  requestHeadersSource: 'configured' | 'captured' | 'unavailable'
  status: number; statusText: string; httpVersion: string; responseHeaders: ApiHeader[]; trailers: ApiHeader[]
  timings: ApiTimings; connection: ApiConnectionInfo
}
/** Body 预览与采集预算事实；大正文从受管产物按范围读取。 */
export interface ApiBodyInfo {
  rawBytes: number; decodedBytes: number; contentType: string; encoding: string
  preview: string; previewTruncated: boolean; complete: boolean; decoded: boolean
}
/** 故障只描述本次阶段，不把无响应错误伪装成 HTTP 状态。 */
export interface ApiFailure { code: string; phase: string; message: string }
/** 断言输出与 HTTP 成功分别表达。 */
export interface ApiAssertionResult { id: string; passed: boolean; expected: string; actual: string; message: string }
/** 网络执行终态，4xx/5xx 仍属于 completed。 */
export interface ApiTransportResult {
  state: 'completed' | 'failed' | 'cancelled'; hops: ApiHttpHop[]; body: ApiBodyInfo
  /** 流式响应的计数事实；事件明细由承载运行的服务层按上限保留。 */
  sse?: ApiSseSummary
  error?: ApiFailure
}
/** 运行记录；getRun 的默认返回是脱敏投影。 */
export interface ApiRun {
  id: string; workspaceId: string; sessionId: string; source: 'manual' | 'agent'
  requestName: string; requestId?: string; environmentId?: string; catalogRevision: number
  createdAt: number; finishedAt?: number; state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  request: ApiResolvedRequest; hops: ApiHttpHop[]; body: ApiBodyInfo; assertions: ApiAssertionResult[]; error?: ApiFailure
  recording: 'saved' | 'memory-only' | 'failed'; pinned: boolean
  /** 事件流明细仅在存在流式响应时出现，历史摘要会清空该数组。 */
  sse?: ApiSseStream
  /** 提取结果只记录命中与否，值保存在主进程的运行时变量里。 */
  extracted?: ApiExtractionOutcome[]
  /** 本次运行所跑的测试用例；未按用例跑时缺省。 */
  caseId?: string
}
/** 正文分页结果；offset 按字符计数，下一页通过 nextOffset 获取。 */
export interface ApiBodySlice { text: string; offset: number; nextOffset: number | null; totalChars: number; truncated: boolean }
/** IPC 只接收会话身份，由主进程解析 workspace。 */
export interface ApiTarget { sessionId: string }
/** 保存完整小目录；expectedRevision 防止多 Pane 丢失更新。 */
export interface ApiSaveCatalogInput extends ApiTarget { expectedRevision: number; catalog: ApiCatalog }
/** 从已保存请求或本地草稿生成一次发送身份；单次覆盖不写回环境。 */
export interface ApiPrepareInput extends ApiTarget { request: ApiRequestDraft; requestId?: string; environmentId?: string; overrides?: ApiField[]; caseId?: string }
/** 发送或取消仅使用 Host 签发的准备身份。 */
export interface ApiSendInput extends ApiTarget { preparedId: string }
/** 读取运行原文只能由本地 UI 显式使用 reveal，Agent facade 不暴露该参数。 */
export interface ApiRunInput extends ApiTarget { runId: string; reveal?: boolean }
/** 每页正文有固定上限，调用者不能自定文件路径。 */
export interface ApiReadBodyInput extends ApiRunInput { offset?: number; limit?: number }
/** 历史默认返回最新一页；cursor 为非负条目位置。 */
export interface ApiListRunsInput extends ApiTarget { cursor?: number; limit?: number }
/** 收藏保留同一个运行，不会再次发起请求。 */
export interface ApiPinRunInput extends ApiTarget { runId: string; pinned: boolean }
/** 事件只推送当前所属会话，正文通过专用读取按需获取。 */
export interface ApiRunChanged { sessionId: string; runId: string; state: ApiRun['state'] }
/** Renderer 可用的完整接口工作台能力。 */
export interface ApiWorkbenchApi {
  getCatalog(input: ApiTarget): Promise<ApiCatalog>
  saveCatalog(input: ApiSaveCatalogInput): Promise<ApiCatalog>
  prepare(input: ApiPrepareInput): Promise<ApiPreparedPreview>
  send(input: ApiSendInput): Promise<ApiRun>
  cancel(input: ApiSendInput): Promise<void>
  listRuns(input: ApiListRunsInput): Promise<{ runs: ApiRun[]; nextCursor: number | null }>
  getRun(input: ApiRunInput): Promise<ApiRun>
  readBody(input: ApiReadBodyInput): Promise<ApiBodySlice>
  pinRun(input: ApiPinRunInput): Promise<ApiRun>
  /** 运行时变量只回传元数据；值永不出主进程。 */
  getRuntimeVariables(input: ApiTarget): Promise<{ variables: ApiRuntimeVariable[] }>
  /** 清空当前 workspace 的运行时变量。 */
  clearRuntimeVariables(input: ApiTarget): Promise<{ cleared: number }>
  /** Cookie Jar 只回传元数据；取值永不出主进程。 */
  getCookieJar(input: ApiTarget): Promise<{ cookies: ApiCookieJarEntry[] }>
  /** 清空当前 workspace 的 Cookie Jar。 */
  clearCookieJar(input: ApiTarget): Promise<{ cleared: number }>
  /** 打开原生文件对话框选择待上传文件；返回元数据，渲染层永远拿不到路径。 */
  pickApiFiles(input: ApiTarget): Promise<{ files: ApiPickedFile[] }>
  onChanged(callback: (event: ApiRunChanged) => void): () => void
  onStream(callback: (event: ApiRunStreamChanged) => void): () => void
}
/** 创建不包含自动网络行为的新草稿。 */
export function createApiRequestDraft(collectionId = 'default'): ApiRequestDraft {
  return { name: '新请求', collectionId, folder: '', description: '', method: 'GET', url: '', query: [], headers: [], body: { kind: 'none', text: '', fields: [], files: [] }, auth: { type: 'none', value: { value: '' } }, timeoutMs: 30_000, followRedirects: false, maxRedirects: 5, assertions: [], extractions: [], cases: [], useCookieJar: false }
}
/** 稳定的合同错误，附带字段名但不回显字段值。 */
function invalid(path: string): never { throw new Error('API_WORKBENCH_INVALID: ' + path) }
/** 拒绝数组、原型对象及未知键。 */
export function apiRecord(value: unknown, keys: readonly string[], path = 'input'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid(path)
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key))) return invalid(path)
  return record
}
/** 有界文本字段；控制字符根据字段语义独立验证。 */
function text(value: unknown, path: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return invalid(path)
  return value
}
/** 验证不会越界到路径的稳定业务身份。 */
export function parseApiId(value: unknown): string {
  const id = text(value, 'id', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) return invalid('id')
  return id
}
/** 解析布尔开关，禁止以字符串隐式转换。 */
function flag(value: unknown, path: string): boolean { if (typeof value !== 'boolean') return invalid(path); return value }
/** 解析有界整数。 */
export function apiInteger(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid(path)
  return value
}
/** 严格解析枚举值。 */
function choice<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) return invalid(path)
  return value as T
}
/** 解析有界数组并阻断重复编辑身份。 */
function rows<T extends { id: string }>(value: unknown, parse: (item: unknown) => T, max: number, path: string): T[] {
  if (!Array.isArray(value) || value.length > max) return invalid(path)
  const result = value.map(parse)
  if (new Set(result.map((item) => item.id)).size !== result.length) return invalid(path + '.duplicateId')
  return result
}
/** 秘密引用只允许安全标识符，解析不授予解密权限。 */
export function parseApiValue(value: unknown): ApiValue {
  const record = apiRecord(value, ['value', 'secret', 'secretRef'], 'value')
  return { value: text(record.value, 'value', 131072), ...(record.secret === undefined ? {} : { secret: flag(record.secret, 'secret') }), ...(record.secretRef === undefined ? {} : { secretRef: parseApiId(record.secretRef) }) }
}
/** 行解析保留重复名称；Header 场景另验证协议字符。 */
export function parseApiField(value: unknown): ApiField {
  const record = apiRecord(value, ['id', 'name', 'value', 'enabled', 'secret', 'secretRef'], 'field')
  return { id: parseApiId(record.id), name: text(record.name, 'field.name', 256), enabled: flag(record.enabled, 'field.enabled'), ...parseApiValue({ value: record.value, ...(record.secret === undefined ? {} : { secret: record.secret }), ...(record.secretRef === undefined ? {} : { secretRef: record.secretRef }) }) }
}
/** 解析每层变量和参数列表。 */
export function parseApiFields(value: unknown): ApiField[] { return rows(value, parseApiField, API_LIMITS.maxFields, 'fields') }
/** 解析鉴权配置；实际秘密在 Store 按资源所有权解析。 */
function auth(value: unknown): ApiAuth {
  const record = apiRecord(value, ['type', 'value', 'username', 'name', 'in'], 'auth')
  return { type: choice(record.type, ['none', 'bearer', 'basic', 'api-key'], 'auth.type'), value: parseApiValue(record.value), ...(record.username === undefined ? {} : { username: text(record.username, 'auth.username') }), ...(record.name === undefined ? {} : { name: text(record.name, 'auth.name', 256) }), ...(record.in === undefined ? {} : { in: choice(record.in, ['header', 'query'] as const, 'auth.in') }) }
}
/** 解析单条声明式断言。 */
function assertion(value: unknown): ApiAssertion {
  const record = apiRecord(value, ['id', 'kind', 'path', 'expected'], 'assertion')
  return {
    id: parseApiId(record.id),
    kind: choice(record.kind, ['status', 'header', 'json-value', 'json-exists', 'json-type', 'duration', 'sse-count', 'sse-first-event', 'sse-ended', 'sse-last-data'], 'assertion.kind'),
    path: text(record.path, 'assertion.path', 512), expected: text(record.expected, 'assertion.expected', 4096),
  }
}
/** 草稿字段白名单，定义解析也复用此表。 */
const DRAFT_KEYS = ['name', 'collectionId', 'folder', 'description', 'method', 'url', 'query', 'headers', 'body', 'auth', 'timeoutMs', 'followRedirects', 'maxRedirects', 'assertions', 'extractions', 'targetEnvironmentId', 'cases', 'useCookieJar'] as const
/** 解析一个待上传文件的引用；路径不在合同里，只有引用与展示元数据。 */
function filePart(value: unknown): ApiFilePart {
  const record = apiRecord(value, ['id', 'name', 'fileName', 'sizeBytes', 'contentType', 'ref'], 'body.file')
  return {
    id: parseApiId(record.id),
    name: text(record.name, 'body.file.name', 256),
    fileName: text(record.fileName, 'body.file.fileName', 256),
    sizeBytes: apiInteger(record.sizeBytes, 0, API_LIMITS.bodyBytes, 'body.file.sizeBytes'),
    ...(record.contentType === undefined ? {} : { contentType: text(record.contentType, 'body.file.contentType', 256) }),
    ref: parseApiId(record.ref),
  }
}
/** 解析单条测试用例；用例名可有界重复，身份必须唯一。 */
function testCase(value: unknown): ApiTestCase {
  const record = apiRecord(value, ['id', 'name', 'assertions', 'overrides', 'environmentId', 'source'], 'case')
  return {
    id: parseApiId(record.id),
    name: text(record.name, 'case.name', 128),
    assertions: rows(record.assertions, assertion, 64, 'case.assertions'),
    ...(record.overrides === undefined ? {} : { overrides: parseApiFields(record.overrides) }),
    ...(record.environmentId === undefined ? {} : { environmentId: parseApiId(record.environmentId) }),
    /** 来源只允许 Host 认可的两种取值；升级前保存的用例缺省为人工创建。 */
    source: choice(record.source ?? 'user', ['user', 'agent'] as const, 'case.source'),
  }
}
/** 变量名必须能直接嵌入 {{name}} 模板。 */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/
/** 解析单条提取规则；来源是固定枚举，变量名必须可用于模板。 */
function extraction(value: unknown): ApiExtraction {
  const record = apiRecord(value, ['id', 'name', 'from', 'path', 'secret'], 'extraction')
  const name = text(record.name, 'extraction.name', 128)
  if (!VARIABLE_NAME.test(name)) return invalid('extraction.name')
  return {
    id: parseApiId(record.id), name,
    from: choice(record.from, ['json', 'header', 'sse-last-data'], 'extraction.from'),
    path: text(record.path, 'extraction.path', 512),
    secret: flag(record.secret, 'extraction.secret'),
  }
}
/** 解析请求草稿；空 URL 可保存，发送前必须解析为 http(s)。 */
export function parseApiRequestDraft(value: unknown): ApiRequestDraft {
  const record = apiRecord(value, DRAFT_KEYS, 'request')
  const url = text(record.url, 'request.url', 8192)
  if (url && !url.includes('{{') && !/^https?:\/\//i.test(url)) return invalid('request.url')
  const headers = parseApiFields(record.headers)
  for (const header of headers) {
    if (header.name && !/^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/.test(header.name)) return invalid('header.name')
    if (/[\r\n]/.test(header.value)) return invalid('header.value')
  }
  const body = apiRecord(record.body, ['kind', 'text', 'fields', 'files'], 'body')
  return {
    name: text(record.name, 'request.name', 128), collectionId: parseApiId(record.collectionId), folder: text(record.folder, 'request.folder', 256), description: text(record.description, 'request.description', 4096),
    method: choice(record.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], 'request.method'), url,
    query: parseApiFields(record.query), headers,
    body: {
      kind: choice(body.kind, ['none', 'json', 'text', 'urlencoded', 'multipart'], 'body.kind'),
      text: text(body.text, 'body.text', 131072),
      fields: parseApiFields(body.fields),
      /** 升级前保存的请求没有 files 字段，解析时补空数组而不是报错。 */
      files: rows(body.files ?? [], filePart, API_LIMITS.maxFileParts, 'body.files'),
    },
    auth: auth(record.auth), timeoutMs: apiInteger(record.timeoutMs, 100, 300000, 'timeoutMs'), followRedirects: flag(record.followRedirects, 'followRedirects'),
    maxRedirects: apiInteger(record.maxRedirects, 0, 10, 'maxRedirects'), assertions: rows(record.assertions, assertion, 64, 'assertions'),
    extractions: rows(record.extractions ?? [], extraction, API_LIMITS.maxExtractions, 'extractions'),
    ...(record.targetEnvironmentId === undefined ? {} : { targetEnvironmentId: parseApiId(record.targetEnvironmentId) }),
    cases: rows(record.cases ?? [], testCase, API_LIMITS.maxCases, 'cases'),
    /** 自动 Cookie 缺省关闭：升级前保存的请求不会突然开始读写 cookie。 */
    useCookieJar: record.useCookieJar === undefined ? false : flag(record.useCookieJar, 'useCookieJar'),
  }
}
/** 从定义提取编辑草稿，不把内部版本字段送入草稿解析器。 */
export function apiDraftFromDefinition(definition: ApiRequestDefinition): ApiRequestDraft {
  return parseApiRequestDraft(Object.fromEntries(DRAFT_KEYS.map((key) => [key, definition[key]])))
}
/** 解析持久请求定义。 */
export function parseApiRequestDefinition(value: unknown): ApiRequestDefinition {
  const record = apiRecord(value, [...DRAFT_KEYS, 'id', 'revision', 'updatedAt'], 'definition')
  return { ...parseApiRequestDraft(Object.fromEntries(DRAFT_KEYS.map((key) => [key, record[key]]))), id: parseApiId(record.id), revision: apiInteger(record.revision, 1, Number.MAX_SAFE_INTEGER, 'revision'), updatedAt: apiInteger(record.updatedAt, 0, Number.MAX_SAFE_INTEGER, 'updatedAt') }
}
/** 场景级与步骤级的失败策略；只允许两种取值，「静默继续」不能成为默认。 */
function scenarioFailurePolicy(value: unknown, path: string): ApiScenarioFailurePolicy {
  return choice(value, ['stop', 'continue'] as const, path)
}
/** 解析一个场景步骤；只接受已保存请求的身份，不接收内联定义。 */
function scenarioStep(value: unknown): ApiScenarioStep {
  const record = apiRecord(value, ['id', 'name', 'requestId', 'caseId', 'environmentId', 'overrides', 'onFailure'], 'scenario.step')
  return {
    id: parseApiId(record.id),
    name: text(record.name, 'scenario.step.name', 128),
    requestId: parseApiId(record.requestId),
    ...(record.caseId === undefined ? {} : { caseId: parseApiId(record.caseId) }),
    ...(record.environmentId === undefined ? {} : { environmentId: parseApiId(record.environmentId) }),
    ...(record.overrides === undefined ? {} : { overrides: parseApiFields(record.overrides) }),
    ...(record.onFailure === undefined ? {} : { onFailure: scenarioFailurePolicy(record.onFailure, 'scenario.step.onFailure') }),
  }
}
/** 解析一条场景定义；步骤身份必须唯一，数组顺序即执行顺序。 */
export function parseApiScenario(value: unknown): ApiScenario {
  const record = apiRecord(value, ['id', 'name', 'description', 'collectionId', 'folder', 'steps', 'environmentId', 'onFailure', 'revision', 'updatedAt'], 'scenario')
  return {
    id: parseApiId(record.id),
    name: text(record.name, 'scenario.name', 128),
    description: text(record.description, 'scenario.description', 4096),
    collectionId: parseApiId(record.collectionId),
    folder: text(record.folder, 'scenario.folder', 256),
    steps: rows(record.steps, scenarioStep, API_LIMITS.maxScenarioSteps, 'scenario.steps'),
    ...(record.environmentId === undefined ? {} : { environmentId: parseApiId(record.environmentId) }),
    onFailure: scenarioFailurePolicy(record.onFailure ?? 'stop', 'scenario.onFailure'),
    revision: apiInteger(record.revision, 1, Number.MAX_SAFE_INTEGER, 'scenario.revision'),
    updatedAt: apiInteger(record.updatedAt, 0, Number.MAX_SAFE_INTEGER, 'scenario.updatedAt'),
  }
}
/** 解析目录并验证关系，不允许孤儿集合引用。 */
export function parseApiCatalog(value: unknown): ApiCatalog {
  const record = apiRecord(value, ['version', 'revision', 'collections', 'environments', 'requests', 'scenarios'], 'catalog')
  if (record.version !== 1 || new TextEncoder().encode(JSON.stringify(value)).byteLength > API_LIMITS.catalogBytes) return invalid('catalog.versionOrSize')
  const collections = rows(record.collections, (item): ApiCollection => {
    const entry = apiRecord(item, ['id', 'name', 'description', 'variables'], 'collection')
    return { id: parseApiId(entry.id), name: text(entry.name, 'collection.name', 128), description: text(entry.description, 'collection.description'), variables: parseApiFields(entry.variables) }
  }, 64, 'collections')
  const environments = rows(record.environments, (item): ApiEnvironment => {
    const entry = apiRecord(item, ['id', 'name', 'kind', 'variables'], 'environment')
    return { id: parseApiId(entry.id), name: text(entry.name, 'environment.name', 128), kind: choice(entry.kind, ['local', 'test', 'production'], 'environment.kind'), variables: parseApiFields(entry.variables) }
  }, 64, 'environments')
  const requests = rows(record.requests, parseApiRequestDefinition, API_LIMITS.maxRequests, 'requests')
  if (requests.some((request) => !collections.some((collection) => collection.id === request.collectionId))) return invalid('request.collectionId')
  /** 升级前保存的目录没有 scenarios 字段，解析时补空数组而不是报错。 */
  const scenarios = rows(record.scenarios ?? [], parseApiScenario, API_LIMITS.maxScenarios, 'scenarios')
  if (scenarios.some((scenario) => !collections.some((collection) => collection.id === scenario.collectionId))) return invalid('scenario.collectionId')
  return { version: 1, revision: apiInteger(record.revision, 0, Number.MAX_SAFE_INTEGER, 'catalog.revision'), collections, environments, requests, scenarios }
}
/** 主进程从该会话推导 workspace；拒绝外部附带 workspaceId。 */
export function parseApiTarget(value: unknown): ApiTarget { const record = apiRecord(value, ['sessionId']); return { sessionId: parseApiId(record.sessionId) } }
