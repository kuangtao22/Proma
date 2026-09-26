import { randomUUID } from 'node:crypto'
import { API_LIMITS, apiRecord, apiInteger, apiDraftFromDefinition, createApiRequestDraft, extractApiBaseUrlVariable, isOrdinaryTopLevelAgentSession, parseApiCryptoStep, parseApiFields, parseApiId, parseApiRequestDraft, parseApiScenario } from '@proma/shared'
import type { AgentSessionMeta, ApiCatalog, ApiCryptoProfile, ApiCryptoStep, ApiEnvironment, ApiField, ApiPreparedPreview, ApiRequestDraft, ApiRun, ApiScenario, ApiScenarioPreparedPreview, ApiScenarioRun } from '@proma/shared'
import type { ApiWorkbenchService } from './api-workbench-service'
import { stampApiAgentCases } from './api-agent-case-ownership'
import type { ApiAgentCaseChange } from './api-agent-case-ownership'
import { parseApiAgentDeclaredFiles } from './api-agent-files'
import { redactApiBody } from './api-redaction'

/** 只有宿主授权服务可以调用 authorize；模型工具只能消费已签发的精确快照。 */
export interface ApiAgentApproval {
  tool: string
  /** 授权身份：运行/发送是 preparedId，保存场景是「场景 + 目录版本」的稳定标识。 */
  preparedId: string
  /** 单次请求的准备预览；场景类工具没有它。 */
  preview?: ApiPreparedPreview
  /** 场景运行快照：逐行步骤清单，一次批准授权整条流程。 */
  scenario?: ApiScenarioPreparedPreview
  /** 场景保存快照：规范化后的定义与目录版本。 */
  scenarioSave?: { expectedRevision: number; scenario: ApiScenario; scenarioId?: string }
  /**
   * 环境保存快照：规范化后的环境定义与目录版本。
   * 变量值在这里一律遮罩（密钥类变量由 Store 转 safeStorage 密文），审批卡只展示名字与条数。
   */
  environmentSave?: { expectedRevision: number; environment: ApiEnvironment; environmentId?: string; warnings: string[] }
  /** 批量配置变更快照：逐条列出「改哪条接口、从什么改成什么」。 */
  requestUpdates?: {
    expectedRevision: number
    updates: ApiAgentRequestUpdate[]
    warnings: string[]
  }
  /** 剥离测试环境地址：把硬编码主机抽成集合/环境变量，并绑定命中请求。 */
  baseUrlExtract?: { expectedRevision: number; collectionId: string; environmentId?: string; variableName: string; origin: string; updated: number; environmentName?: string }
  /**
   * 加密方案保存快照：只有算法、模板与密钥**变量名**，没有任何密钥值。
   * 审批卡据此说明「将执行什么、会读哪些变量名、影响几个接口」。
   */
  cryptoProfileSave?: {
    expectedRevision: number
    profileId: string
    profileName: string
    appliesTo: ApiCryptoProfile['appliesTo']
    steps: Array<{ index: number; side: 'request' | 'response'; kind: string; algo: string; keyRef?: string; ivRef?: string; target?: string }>
    /** 方案引用的密钥变量名（去重）；卡上只列名字，值永远不到渲染层。 */
    keyRefs: string[]
    warnings: string[]
  }
  /** 变量声明快照：只声明名字与类型，值由人填写；已存在的变量不会被覆盖。 */
  variableDeclare?: {
    /** 批准时对应的目录版本：写入用同一个版本做 CAS。 */
    expectedRevision: number
    scope: 'workspace' | 'collection'
    collectionId?: string
    collectionName?: string
    variables: Array<{ name: string; secret: boolean; enabled: boolean; /** 已存在：值保持不动。 */ existing: boolean }>
    warnings: string[]
  }
  /** 方案绑定快照：逐行列出「哪条接口从什么方案改成什么方案」。 */
  cryptoBind?: {
    expectedRevision: number
    bindings: Array<{ requestId: string; requestName: string; before?: string; after: string; profileName: string }>
    warnings: string[]
  }
  /**
   * 本次要读取并上传的附件：字段名、`realpath` 与大小。
   *
   * 只用于审批卡展示（审批快照是路径允许存在的两处之一），不进请求定义、运行记录与模型上下文。
   */
  files?: Array<{ field: string; path: string; sizeBytes: number }>
  /** 发送审批的结构化摘要：这次跑的是哪一组断言。 */
  send?: { caseId?: string; caseName?: string; assertionCount: number }
  /**
   * 发送审批上的「本次发送形态」：用哪套方案、哪些密钥还没配。
   * 缺密钥不会阻断发送，但必须在这一步就说清楚「会按明文发出」。
   */
  sendShape?: { profileName: string; steps: string[]; missing: string[] }
  save?: {
    expectedRevision: number
    requestName: string
    collectionId: string
    definition: ApiRequestDraft
    caseDiff: ApiAgentCaseChange[]
    /** 请求质量提醒（名字/硬编码主机/空参数）：让人在批准前看见，也让模型有机会自己改。 */
    warnings?: string[]
  }
}
/** 一次普通 Agent 运行的真实身份与能力依赖。 */
export interface ApiAgentFacadeOptions {
  sessionId: string
  toolMode: string
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'external'
  getSession(sessionId: string): AgentSessionMeta | undefined
  service: Pick<ApiWorkbenchService, 'getCatalog' | 'saveCatalog' | 'saveCryptoProfile' | 'saveWorkspaceVariables' | 'prepare' | 'getPrepared' | 'send' | 'getRun' | 'readBody' | 'registerAgentFiles' | 'releaseFiles' | 'prepareScenario' | 'getScenarioPrepared' | 'runScenario'>
  runSignal: AbortSignal
  assertRunActive(): void
  assertWorkspaceWritable?(workspaceId: string): void
  canMutate?(): boolean
  runWorkspaceWrite?<T>(workspaceId: string, effect: () => T): T
  /** 同时可用的准备草稿上限；默认 {@link MAX_AGENT_DRAFTS}，测试可注入更小值。 */
  maxDrafts?: number
}
/** 会话聊天卡片只引用一次真实运行，不包含任意文件路径或执行入口。 */
export interface ApiAgentRunSummary {
  kind: 'api-workbench-run'; runId: string; sessionId: string; method: string; url: string
  state: ApiRun['state']; status: number | null; durationMs: number | null
  assertions: { passed: number; total: number }; recording: ApiRun['recording']; error?: ApiRun['error']
  /** 本次运行所跑的测试用例；未按用例跑时缺省。 */
  caseId?: string
}
/** 一条批量配置变更：只含「能批量改」的字段，URL 与正文各自走专用路径。 */
export interface ApiAgentRequestUpdate {
  requestId: string
  name: string
  before: { name: string; folder: string; collectionId: string; targetEnvironmentId?: string }
  after: { name: string; folder: string; collectionId: string; targetEnvironmentId?: string }
}
/** 有界文本：拒绝非字符串、超长与控制字符（与共享解析器同一套规则）。 */
function agentText(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`API_WORKBENCH_INVALID: ${path}`)
  return value
}
/** 同时可用的准备草稿上限：批量整理上百条接口时不必反复等待。 */
const MAX_AGENT_DRAFTS = 256
/** 模型输出按实际 UTF-8 字节限额；过大只返回标记清晰的文本预览。 */
export function boundApiAgentResult(value: unknown): unknown {
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') <= API_LIMITS.agentBytes) return value
  return { truncated: true, preview: serialized.slice(0, 6000), message: '结果超过模型单次读取预算；请缩小分页或在接口工作台查看完整记录。' }
}
/** 创建只对当前普通用户运行有效的 API 能力，后台来源默认没有能力。 */
export function createApiAgentFacade(options: ApiAgentFacadeOptions) {
  const initial = options.getSession(options.sessionId)
  if (options.toolMode !== 'standard' || (options.triggeredBy && options.triggeredBy !== 'user')
    || !isOrdinaryTopLevelAgentSession(initial) || initial.archived || initial.explorationParentSessionId !== undefined || !initial.workspaceId) return undefined
  const context = { workspaceId: initial.workspaceId, sessionId: options.sessionId, source: 'agent' as const }
  /**
   * 只保留本次 Agent 运行生成的草稿，秘密引用仍交给 Store 验证所有权。
   * `files` 是本次待上传附件的审批行（字段名 + realpath + 大小），是路径允许存在的两处之一。
   */
  const drafts = new Map<string, { request: ApiRequestDraft; preview: ApiPreparedPreview; files?: Array<{ field: string; path: string; sizeBytes: number }>; requestId?: string; caseId?: string }>()
  /** 本次 Agent 运行生成的场景准备记录：批准与执行都只认这份步骤清单。 */
  const scenarioDrafts = new Map<string, ApiScenarioPreparedPreview>()
  /** 已跑过的场景身份：重复调用返回同一次结论，绝不第二次出网。 */
  const scenarioRuns = new Map<string, ApiScenarioRun>()
  /** 精确授权与已完成执行分开记录；保存批准不能变成出网批准。 */
  const grants = new Map<string, string>()
  const sent = new Map<string, ApiAgentRunSummary>()
  /** 每次异步边界后复验 session、workspace 和 Agent 运行代次。 */
  function current(): void {
    options.assertRunActive()
    const session = options.getSession(options.sessionId)
    if (options.runSignal.aborted || !isOrdinaryTopLevelAgentSession(session) || session.archived
      || session.explorationParentSessionId !== undefined || session.workspaceId !== context.workspaceId) throw new Error('API_AGENT_SCOPE_CHANGED')
  }
  /** 变更入口额外复用项目迁移写锁。 */
  function writable(): void { current(); if (options.canMutate?.() === false) throw new Error('API_AGENT_MUTATION_DENIED'); options.assertWorkspaceWritable?.(context.workspaceId) }
  /**
   * 回收「已经发送过、且已经保存过」的草稿，给后续 prepare 腾出名额。
   *
   * 只回收已完成发送的：`sent` 仍然保留去重身份，所以重复调用 send 依旧不会再次出网；
   * 未发送的草稿一律保留（可能马上要批准执行）。
   */
  function reclaimSentDrafts(): void {
    for (const [preparedId] of drafts) {
      if (!sent.has(preparedId)) continue
      drafts.delete(preparedId)
    }
  }
  /** 持有当前项目写租约直到真实网络与记录完成，迁移不能穿过异步间隙。 */
  function write<T>(effect: () => T): T { writable(); return options.runWorkspaceWrite ? options.runWorkspaceWrite(context.workspaceId, effect) : effect() }
  /** 解析发送或保存参数，模型无法传入 reveal、workspace 或私有执行路径。 */
  /**
   * 解析各变更工具的调用身份。
   *
   * 保存类工具没有 preparedId，就用「场景身份 + 目录版本」当授权身份：同一份输入只能对应同一次批准，
   * 而快照内容本身还会在 requireGrant 里被逐字比较，所以换定义就会失效。
   */
  function mutation(tool: string, input: unknown): { preparedId: string; expectedRevision?: number } {
    if (tool === 'api_send_request' || tool === 'api_run_scenario') {
      const args = apiRecord(input, ['preparedId'])
      return { preparedId: parseApiId(args.preparedId) }
    }
    if (tool === 'api_save_request') {
      const args = apiRecord(input, ['preparedId', 'expectedRevision'])
      return { preparedId: parseApiId(args.preparedId), expectedRevision: apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision') }
    }
    if (tool === 'api_save_scenario') {
      const args = apiRecord(input, ['scenarioId', 'scenario', 'expectedRevision'])
      const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
      const scenarioId = args.scenarioId === undefined ? 'new' : parseApiId(args.scenarioId)
      return { preparedId: `${scenarioId}_${expectedRevision}`, expectedRevision }
    }
    if (tool === 'api_save_environment') {
      const args = apiRecord(input, ['environmentId', 'environment', 'expectedRevision'])
      const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
      const environmentId = args.environmentId === undefined ? 'new' : parseApiId(args.environmentId)
      return { preparedId: `${environmentId}_${expectedRevision}`, expectedRevision }
    }
    /** 批量类工具的身份只绑「工具 + 目录版本」，内容绑定交给快照的逐字比较。 */
    if (tool === 'api_update_requests') {
      const args = apiRecord(input, ['updates', 'expectedRevision'])
      return { preparedId: `${tool}_${apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')}`, expectedRevision: apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision') }
    }
    if (tool === 'api_extract_base_url') {
      const args = apiRecord(input, ['collectionId', 'environmentId', 'variableName', 'expectedRevision'])
      const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
      return { preparedId: `${tool}_${expectedRevision}`, expectedRevision }
    }
    if (tool === 'api_save_crypto_profile') {
      const args = apiRecord(input, ['profileId', 'profile', 'expectedRevision'])
      const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
      return { preparedId: `${args.profileId === undefined ? 'new' : parseApiId(args.profileId)}_${expectedRevision}`, expectedRevision }
    }
    if (tool === 'api_declare_variables') {
      const args = apiRecord(input, ['scope', 'collectionId', 'variables', 'expectedRevision'])
      const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
      return { preparedId: `${tool}_${expectedRevision}`, expectedRevision }
    }
    if (tool === 'api_bind_crypto_profile') {
      const args = apiRecord(input, ['bindings', 'expectedRevision'])
      const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
      return { preparedId: `${tool}_${expectedRevision}`, expectedRevision }
    }
    throw new Error('API_AGENT_UNKNOWN_MUTATION')
  }
  /**
   * 解析环境保存入参。
   *
   * 变量的秘密值走与人有界面同一条 Store 处理（明文 → safeStorage 密文引用），
   * 因此模型可以声明 `baseUrl` 这类公共变量，也可以声明密钥类变量，但取值永远不会回给模型。
   * @param input 工具入参。
   * @param catalog 当前目录，用于校验被修改的环境确实存在。
   * @returns 目录版本、目标环境身份与规范化定义。
   */
  function parseEnvironmentMutation(input: unknown, catalog: ApiCatalog): { expectedRevision: number; environmentId?: string; environment: ApiEnvironment } {
    const args = apiRecord(input, ['environmentId', 'environment', 'expectedRevision'])
    const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
    const environmentId = args.environmentId === undefined ? undefined : parseApiId(args.environmentId)
    const existing = environmentId ? catalog.environments.find((item) => item.id === environmentId) : undefined
    if (environmentId && !existing) throw new Error('API_WORKBENCH_ENVIRONMENT_NOT_FOUND')
    /** 只接受定义字段；id 由 Host 盖章，变量行沿用共享解析器（含秘密引用白名单）。 */
    const draft = apiRecord(args.environment, ['name', 'kind', 'variables'], 'environment')
    /** 名称与类型都必须明确给出：猜一个「测试环境」比拒绝更危险。 */
    const name = typeof draft.name === 'string' ? draft.name.trim() : ''
    if (!name) throw new Error('API_WORKBENCH_INVALID: environment.name')
    const kind = draft.kind
    if (kind !== 'local' && kind !== 'test' && kind !== 'production') throw new Error('API_WORKBENCH_INVALID: environment.kind')
    const environment: ApiEnvironment = {
      id: existing?.id ?? 'env_agent_new',
      name,
      kind,
      variables: parseApiFields(draft.variables ?? []),
    }
    return { expectedRevision, ...(environmentId ? { environmentId } : {}), environment }
  }
  /** 审批卡只展示变量名与「已设置」状态，秘密值不回到渲染层。 */
  function redactEnvironment(environment: ApiEnvironment): ApiEnvironment {
    return {
      ...environment,
      variables: environment.variables.map((field) => ({
        ...field,
        value: field.secret || field.secretRef || /authorization|cookie|api[-_]?key|token|password|passwd|secret/i.test(field.name) ? '[REDACTED]' : field.value,
      })),
    }
  }

  /** 收集方案引用的密钥变量名（去重）；审批卡与变量缺失提醒共用。 */
  function cryptoKeyRefs(profile: Pick<ApiCryptoProfile, 'requestSteps' | 'responseSteps'>): string[] {
    return [...new Set([...profile.requestSteps, ...profile.responseSteps]
      .flatMap((step) => [step.keyRef, step.ivRef])
      .filter((name): name is string => name !== undefined))]
  }
  /** 变量名必须能直接嵌入 {{name}} 模板，否则声明出来也没法引用。 */
  const AGENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/

  /**
   * 解析加密方案保存入参。
   *
   * 步骤 id 由 Host 盖章：模型每次都可以传同一份定义，不必自己保证 id 稳定；
   * 算法、编码与目标位置沿用共享解析器白名单，非法值在弹审批卡之前就被拒绝。
   * @returns 目录版本、目标方案身份与规范化定义。
   */
  function parseCryptoProfileMutation(input: unknown, catalog: ApiCatalog): { expectedRevision: number; profileId?: string; collectionId?: string; profile: ApiCryptoProfile } {
    const args = apiRecord(input, ['profileId', 'collectionId', 'profile', 'expectedRevision'])
    const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
    const profileId = args.profileId === undefined ? undefined : parseApiId(args.profileId)
    const existing = profileId ? (catalog.cryptoProfiles ?? []).find((item) => item.id === profileId) : undefined
    if (profileId && !existing) throw new Error('API_WORKBENCH_CRYPTO_PROFILE_NOT_FOUND')
    const collectionId = args.collectionId === undefined ? undefined : parseApiId(args.collectionId)
    if (collectionId && !catalog.collections.some((item) => item.id === collectionId)) throw new Error('API_WORKBENCH_COLLECTION_NOT_FOUND')
    const draft = apiRecord(args.profile, ['name', 'description', 'appliesTo', 'requestSteps', 'responseSteps'], 'crypto.profile')
    const name = agentText(draft.name, 'crypto.profile.name', 128).trim()
    if (!name) throw new Error('API_WORKBENCH_INVALID: crypto.profile.name')
    const side = (value: unknown, prefix: string): ApiCryptoStep[] => {
      if (!Array.isArray(value) || value.length > API_LIMITS.maxCryptoSteps) throw new Error(`API_WORKBENCH_INVALID: crypto.profile.${prefix}`)
      /** 缺省启用：模型只说「这一步是什么」，不必每次写 enabled。 */
      return value.map((item, index) => parseApiCryptoStep({ enabled: true, ...(item as Record<string, unknown>), id: (item as { id?: unknown }).id ?? `${prefix}_${index + 1}` }))
    }
    const appliesTo = draft.appliesTo === undefined ? 'all' : draft.appliesTo
    if (appliesTo !== 'all' && appliesTo !== 'test' && appliesTo !== 'production') throw new Error('API_WORKBENCH_INVALID: crypto.profile.appliesTo')
    const profile: ApiCryptoProfile = {
      id: existing?.id ?? 'profile_agent_new',
      name,
      description: draft.description === undefined ? '' : agentText(draft.description, 'crypto.profile.description', 4096),
      scope: collectionId === undefined ? 'workspace' : { collectionId },
      appliesTo,
      requestSteps: side(draft.requestSteps, 'req'),
      responseSteps: side(draft.responseSteps, 'res'),
      revision: existing?.revision ?? 0,
      updatedAt: existing?.updatedAt ?? 0,
    }
    return { expectedRevision, ...(profileId ? { profileId } : {}), ...(collectionId ? { collectionId } : {}), profile }
  }
  /** 方案保存的提醒：不完整或会被跳过的步骤先说清楚，别让人批准一个跑不起来的方案。 */
  function cryptoProfileWarnings(profile: ApiCryptoProfile, catalog: ApiCatalog): string[] {
    const declared = new Set([...(catalog.workspaceVariables ?? []), ...catalog.collections.flatMap((item) => item.variables), ...catalog.environments.flatMap((item) => item.variables)]
      .filter((field) => field.enabled && field.name)
      .map((field) => field.name))
    const undeclared = cryptoKeyRefs(profile).filter((name) => !declared.has(name))
    const incomplete = [...profile.requestSteps, ...profile.responseSteps].filter((step) => step.enabled && (
      (step.kind === 'sign' && (!step.template || !step.target)) || (step.kind !== 'sign' && (step.kind === 'encrypt' || step.kind === 'decrypt') && !step.ivRef)
    )).length
    const gcm = [...profile.requestSteps, ...profile.responseSteps].filter((step) => step.algo.includes('GCM')).length
    return [
      ...(undeclared.length > 0 ? [`方案引用的密钥变量还没声明：${undeclared.join('、')}（用 api_declare_variables 声明名字，值由人填写）`] : []),
      ...(incomplete > 0 ? [`有 ${incomplete} 个步骤缺模板 / 输出位置 / IV：执行时会被跳过，并标记「明文发出」`] : []),
      ...(gcm > 0 ? [`有 ${gcm} 个认证加密（GCM）步骤：标签落点留到 P2，当前执行时会被跳过`] : []),
      ...(profile.appliesTo === 'production' ? ['这套方案只面向生产环境，请确认密钥与地址都是生产口径'] : []),
    ]
  }

  /**
   * 解析变量声明入参。
   *
   * **模型只能声明名字与类型**：传 `value` 会直接被拒绝，而不是被静默丢弃——
   * 静默丢弃会让模型以为「密钥已经配好了」，而事实恰恰相反。
   */
  function parseVariableDeclaration(input: unknown, catalog: ApiCatalog): { expectedRevision: number; scope: 'workspace' | 'collection'; collectionId?: string; declarations: Array<{ name: string; secret: boolean; enabled: boolean }> } {
    const args = apiRecord(input, ['scope', 'collectionId', 'variables', 'expectedRevision'])
    const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
    if (args.scope !== 'workspace' && args.scope !== 'collection') throw new Error('API_WORKBENCH_INVALID: scope')
    const collectionId = args.scope === 'collection' ? parseApiId(args.collectionId) : undefined
    if (collectionId && !catalog.collections.some((item) => item.id === collectionId)) throw new Error('API_WORKBENCH_COLLECTION_NOT_FOUND')
    if (!Array.isArray(args.variables) || args.variables.length === 0 || args.variables.length > API_LIMITS.maxFields) throw new Error('API_WORKBENCH_INVALID: variables')
    const declarations = args.variables.map((item) => {
      const entry = apiRecord(item, ['name', 'secret', 'enabled'], 'variable')
      const name = agentText(entry.name, 'variable.name', 128).trim()
      if (!AGENT_VARIABLE_NAME.test(name)) throw new Error('API_WORKBENCH_INVALID: variable.name')
      if (entry.secret !== undefined && typeof entry.secret !== 'boolean') throw new Error('API_WORKBENCH_INVALID: variable.secret')
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error('API_WORKBENCH_INVALID: variable.enabled')
      return { name, secret: entry.secret === true, enabled: entry.enabled !== false }
    })
    return { expectedRevision, scope: args.scope === 'collection' ? 'collection' : 'workspace', ...(collectionId ? { collectionId } : {}), declarations }
  }

  /** 解析方案绑定入参：只改「选哪套方案」，不碰 URL、正文与断言。 */
  function parseCryptoBinding(input: unknown, catalog: ApiCatalog): { expectedRevision: number; bindings: Array<{ requestId: string; requestName: string; before?: string; after: string; profileName: string }> } {
    const args = apiRecord(input, ['bindings', 'expectedRevision'])
    const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
    if (!Array.isArray(args.bindings) || args.bindings.length === 0 || args.bindings.length > API_LIMITS.maxRequestUpdates) throw new Error('API_WORKBENCH_INVALID: bindings')
    const bindings = args.bindings.map((item) => {
      const entry = apiRecord(item, ['requestId', 'profileId'], 'binding')
      const requestId = parseApiId(entry.requestId)
      const profileId = parseApiId(entry.profileId)
      const request = catalog.requests.find((candidate) => candidate.id === requestId)
      if (!request) throw new Error('API_WORKBENCH_REQUEST_NOT_FOUND')
      const profile = (catalog.cryptoProfiles ?? []).find((candidate) => candidate.id === profileId)
      if (!profile) throw new Error('API_WORKBENCH_CRYPTO_PROFILE_NOT_FOUND')
      const before = request.selectedProfileId === undefined
        ? undefined
        : (catalog.cryptoProfiles ?? []).find((candidate) => candidate.id === request.selectedProfileId)?.name ?? '已删除的方案'
      return { requestId, requestName: request.name, ...(before === undefined ? {} : { before }), after: profileId, profileName: profile.name }
    })
    return { expectedRevision, bindings }
  }

  /**
   * 审批卡上的「本次发送形态」。
   *
   * 只读目录事实（变量是否声明、秘密值是否已经填过），**不解密任何值**：
   * 缺密钥不阻断发送，但必须让人在这一步就看见「这次会按明文发出」。
   * @param catalog 当前目录。
   * @param request 冻结的请求草稿。
   * @param environmentId 本次使用的环境（决定环境级变量是否算已配置）。
   * @returns 方案摘要；未选方案时返回 undefined。
   */
  function describeSendShape(catalog: ApiCatalog, request: ApiRequestDraft, environmentId?: string): { profileName: string; steps: string[]; missing: string[] } | undefined {
    if (request.selectedProfileId === undefined) return undefined
    const profile = (catalog.cryptoProfiles ?? []).find((item) => item.id === request.selectedProfileId)
    if (!profile) return { profileName: '（引用的方案已被删除，发送会被拒绝）', steps: [], missing: [] }
    const collection = catalog.collections.find((item) => item.id === request.collectionId)
    const environment = environmentId ? catalog.environments.find((item) => item.id === environmentId) : undefined
    /** 已配置 = 变量存在且已填值（秘密值有引用即视为已填，不看值本身）。 */
    const configured = new Set([
      ...(catalog.workspaceVariables ?? []),
      ...(collection?.variables ?? []),
      ...(environment?.variables ?? []),
    ].filter((field) => field.enabled && field.name && (field.value !== '' || field.secretRef !== undefined)).map((field) => field.name))
    const missing = cryptoKeyRefs(profile).filter((name) => !configured.has(name))
    const steps = [...profile.requestSteps, ...profile.responseSteps].map((step) => `${step.kind === 'decrypt' ? '解密' : step.kind === 'derive' ? '派生' : step.kind === 'sign' ? '签名' : '加密'} ${step.algo}`)
    return { profileName: profile.name, steps, missing }
  }

  /** 解析批量配置变更：只允许改名字、文件夹、集合与环境绑定，不碰 URL 与正文。 */
  function parseRequestUpdates(catalog: ApiCatalog, input: unknown): { expectedRevision: number; updates: ApiAgentRequestUpdate[] } {
    const args = apiRecord(input, ['updates', 'expectedRevision'])
    const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
    if (!Array.isArray(args.updates) || args.updates.length === 0 || args.updates.length > API_LIMITS.maxRequestUpdates) {
      throw new Error(`API_WORKBENCH_INVALID: updates（一次最多 ${API_LIMITS.maxRequestUpdates} 条）`)
    }
    const updates = args.updates.map((item, index) => {
      const entry = apiRecord(item, ['requestId', 'name', 'folder', 'collectionId', 'targetEnvironmentId'], `updates[${index}]`)
      const requestId = parseApiId(entry.requestId)
      const request = catalog.requests.find((candidate) => candidate.id === requestId)
      if (!request) throw new Error(`API_WORKBENCH_REQUEST_NOT_FOUND: ${requestId}`)
      const name = entry.name === undefined ? request.name : agentText(entry.name, `updates[${index}].name`, 128)
      if (!name.trim()) throw new Error(`API_WORKBENCH_INVALID: updates[${index}].name`)
      const folder = entry.folder === undefined ? request.folder : agentText(entry.folder, `updates[${index}].folder`, 256)
      const collectionId = entry.collectionId === undefined ? request.collectionId : parseApiId(entry.collectionId)
      if (!catalog.collections.some((collection) => collection.id === collectionId)) throw new Error(`API_WORKBENCH_COLLECTION_NOT_FOUND: ${collectionId}`)
      const targetEnvironmentId = entry.targetEnvironmentId === null ? undefined
        : entry.targetEnvironmentId === undefined ? request.targetEnvironmentId : parseApiId(entry.targetEnvironmentId)
      if (targetEnvironmentId && !catalog.environments.some((environment) => environment.id === targetEnvironmentId)) {
        throw new Error(`API_WORKBENCH_ENVIRONMENT_NOT_FOUND: ${targetEnvironmentId}`)
      }
      return {
        requestId,
        name,
        before: { name: request.name, folder: request.folder, collectionId: request.collectionId, ...(request.targetEnvironmentId ? { targetEnvironmentId: request.targetEnvironmentId } : {}) },
        after: { name, folder, collectionId, ...(targetEnvironmentId ? { targetEnvironmentId } : {}) },
      }
    })
    return { expectedRevision, updates }
  }
  /**
   * 请求草稿的「好不好用」提醒（不是拒绝）。
   *
   * 批量导入最容易留下的三种劣化：名字只是「方法 + 路径」（侧栏一截断全一样）、
   * 每个请求都硬编码同一个主机（换环境要改 N 处）、JSON 正文是空对象 `{}`（参数其实没填）。
   * 这些既回给模型让它自己纠正，也放进保存审批卡让人在批准前看见。
   * @param catalog 当前目录，用于判断同一主机是否被多条请求重复硬编码。
   * @param definition 待保存的请求草稿（已脱敏版本同样适用）。
   * @returns 面向用户的中文提醒；没有明显问题时返回空数组。
   */
  function requestQualityWarnings(catalog: ApiCatalog, definition: ApiRequestDraft): string[] {
    const warnings: string[] = []
    /** 名字只剩「[端] 方法 /路径」时提醒业务化命名；带业务后缀（如「— 管理员登录」）不提醒。 */
    if (/^(?:\[[^\]]+\]\s*)?(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+$/.test(definition.name.trim())) {
      warnings.push(`「${definition.name}」这个名字是「方法 + 路径」生成的，建议改成业务可读名（例如「管理员登录」），否则侧栏截断后多条请求看起来一样`)
    }
    /** 主机被硬编码：同一 origin 在本集合里出现 ≥2 次就值得抽成变量。 */
    const literalOrigin = /^(https?:\/\/[^/]+)\//i.exec(definition.url.trim())?.[1]?.toLowerCase()
    if (literalOrigin) {
      const sameOrigin = catalog.requests.filter((item) => item.collectionId === definition.collectionId && item.url.trim().toLowerCase().startsWith(`${literalOrigin}/`)).length + 1
      if (sameOrigin >= 2) {
        warnings.push(`有 ${sameOrigin} 条请求都把 ${literalOrigin} 写进 URL：建议在集合或环境里声明一个变量（例如 baseUrl），请求写成 {{baseUrl}}/... ，换环境时只改一处`)
      }
    }
    /** JSON 正文是空对象：多半是「参数没填」而不是「真的不需要参数」。 */
    if (definition.body.kind === 'json' && definition.body.text.replace(/\s/g, '') === '{}') {
      warnings.push('JSON 正文是空对象 {}：确认是否需要补上请求参数，否则这条请求只能验证「有没有权限访问」')
    }
    return warnings
  }
  /** 场景定义的关系校验：越界引用在弹审批卡之前就拒绝，不展示一份已经越界的确认框。 */
  function validateScenario(catalog: ApiCatalog, scenario: ApiScenario): void {
    if (scenario.steps.length === 0) throw new Error('API_WORKBENCH_SCENARIO_EMPTY: 流程至少需要一个步骤')
    if (!catalog.collections.some((item) => item.id === scenario.collectionId)) throw new Error('API_WORKBENCH_COLLECTION_NOT_FOUND')
    if (scenario.environmentId && !catalog.environments.some((item) => item.id === scenario.environmentId)) throw new Error('API_WORKBENCH_SCENARIO_ENVIRONMENT_NOT_FOUND: 流程默认环境不存在')
    for (const [index, step] of scenario.steps.entries()) {
      const request = catalog.requests.find((item) => item.id === step.requestId)
      if (!request) throw new Error(`API_WORKBENCH_SCENARIO_REQUEST_NOT_FOUND: 第 ${index + 1} 步引用的接口不存在`)
      if (step.caseId && !(request.cases ?? []).some((item) => item.id === step.caseId)) throw new Error(`API_WORKBENCH_SCENARIO_CASE_NOT_FOUND: 第 ${index + 1} 步引用的用例不存在`)
      if (step.environmentId && !catalog.environments.some((item) => item.id === step.environmentId)) throw new Error(`API_WORKBENCH_SCENARIO_ENVIRONMENT_NOT_FOUND: 第 ${index + 1} 步的环境不存在`)
    }
  }
  /** 生成审批快照前从权威 service 复查有效期与所有版本，预览全部已脱敏。 */
  async function approval(tool: string, input: unknown): Promise<ApiAgentApproval> {
    current()
    /** 场景运行：快照就是那份步骤清单，批准一次授权整条流程。 */
    if (tool === 'api_run_scenario') {
      const args = mutation(tool, input)
      if (!scenarioDrafts.has(args.preparedId)) throw new Error('API_AGENT_SCENARIO_NOT_PREPARED')
      const scenario = await options.service.getScenarioPrepared(context, args.preparedId)
      current()
      return { tool, preparedId: args.preparedId, scenario }
    }
    /** 场景保存：快照带规范化后的定义与目录版本，越界引用在此之前已被拒绝。 */
    if (tool === 'api_save_scenario') {
      const args = apiRecord(input, ['scenarioId', 'scenario', 'expectedRevision'])
      const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
      const catalog = await options.service.getCatalog(context.workspaceId)
      current()
      if (catalog.revision !== expectedRevision) throw new Error('API_WORKBENCH_PREPARED_STALE')
      const scenarioId = args.scenarioId === undefined ? undefined : parseApiId(args.scenarioId)
      const existing = scenarioId ? (catalog.scenarios ?? []).find((item) => item.id === scenarioId) : undefined
      if (scenarioId && !existing) throw new Error('API_WORKBENCH_SCENARIO_NOT_FOUND')
      /** 只接受定义字段；id / revision / updatedAt 一律由 Host 盖章。 */
      const draft = apiRecord(args.scenario, ['name', 'description', 'collectionId', 'folder', 'steps', 'environmentId', 'onFailure'], 'scenario')
      const scenario = parseApiScenario({
        ...draft,
        description: draft.description ?? '',
        folder: draft.folder ?? '',
        id: existing?.id ?? 'scenario_agent_new',
        revision: existing?.revision ?? 1,
        updatedAt: existing?.updatedAt ?? 0,
      })
      validateScenario(catalog, scenario)
      return { tool, preparedId: `${scenarioId ?? 'new'}_${expectedRevision}`, scenarioSave: { expectedRevision, scenario: { ...scenario, id: existing?.id ?? scenario.id }, ...(scenarioId ? { scenarioId } : {}) } }
    }
    /** 环境保存：变量取值在快照里遮罩，生产环境单独点名提醒。 */
    if (tool === 'api_save_environment') {
      const catalog = await options.service.getCatalog(context.workspaceId)
      current()
      const pending = parseEnvironmentMutation(input, catalog)
      /** 目录版本在解析之后复核，保证审批期间有人改动目录时批准立即失效。 */
      if (catalog.revision !== pending.expectedRevision) throw new Error('API_WORKBENCH_PREPARED_STALE')
      const redacted = redactEnvironment(pending.environment)
      return {
        tool,
        preparedId: `${pending.environmentId ?? 'new'}_${pending.expectedRevision}`,
        environmentSave: {
          expectedRevision: pending.expectedRevision,
          environment: redacted,
          ...(pending.environmentId ? { environmentId: pending.environmentId } : {}),
          warnings: [
            ...(pending.environment.kind === 'production' ? ['这是生产环境：请求会指向真实线上地址，请确认这些变量值来自生产'] : []),
            ...(pending.environment.variables.some((field) => field.name.trim() === '') ? ['有变量没有名字：没有名字的变量不会被任何请求引用'] : []),
          ],
        },
      }
    }
    /** 批量配置变更：一次批准改一批（分组 / 取名 / 绑定环境），卡上逐条列出改动。 */
    if (tool === 'api_update_requests') {
      const catalog = await options.service.getCatalog(context.workspaceId)
      current()
      const pending = parseRequestUpdates(catalog, input)
      if (catalog.revision !== pending.expectedRevision) throw new Error('API_WORKBENCH_PREPARED_STALE')
      const stillGeneric = pending.updates.filter((update) => /^(?:\[[^\]]+\]\s*)?(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+$/.test(update.after.name.trim())).length
      return {
        tool,
        preparedId: `${tool}_${pending.expectedRevision}`,
        requestUpdates: {
          expectedRevision: pending.expectedRevision,
          updates: pending.updates,
          warnings: pending.updates.length === 0 ? [] : [
            ...(stillGeneric > 0 ? [`其中 ${stillGeneric} 条的「新名字」仍然是「方法 + 路径」生成的，建议改成业务可读名`] : []),
            ...(pending.updates.length > 20 ? [`本次一次改动 ${pending.updates.length} 条接口，请抽查几条确认分组与命名符合预期`] : []),
          ],
        },
      }
    }
    /** 剥离测试环境地址：交给共享纯函数算，模型不能自己改写 URL。 */
    if (tool === 'api_extract_base_url') {
      const args = apiRecord(input, ['collectionId', 'environmentId', 'variableName', 'expectedRevision'])
      const expectedRevision = apiInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
      const collectionId = parseApiId(args.collectionId)
      const environmentId = args.environmentId === undefined ? undefined : parseApiId(args.environmentId)
      const variableName = args.variableName === undefined ? 'baseUrl' : agentText(args.variableName, 'variableName', 128)
      const catalog = await options.service.getCatalog(context.workspaceId)
      current()
      if (catalog.revision !== expectedRevision) throw new Error('API_WORKBENCH_PREPARED_STALE')
      const extraction = extractApiBaseUrlVariable(catalog, collectionId, { ...(environmentId ? { environmentId } : {}), variableName })
      if (!extraction.variableName || extraction.updated === 0) throw new Error(`API_WORKBENCH_BASE_URL_NOTHING_TO_EXTRACT: ${extraction.message ?? '这个集合里没有硬编码主机的请求'}`)
      return {
        tool,
        preparedId: `${tool}_${expectedRevision}`,
        baseUrlExtract: {
          expectedRevision, collectionId, variableName, origin: extraction.origin!, updated: extraction.updated,
          ...(environmentId ? { environmentId } : {}),
          ...(extraction.environmentName ? { environmentName: extraction.environmentName } : {}),
        },
      }
    }
    /** 方案保存：卡上只有算法、模板与密钥变量名，没有任何密钥值。 */
    if (tool === 'api_save_crypto_profile') {
      const catalog = await options.service.getCatalog(context.workspaceId)
      current()
      const pending = parseCryptoProfileMutation(input, catalog)
      if (catalog.revision !== pending.expectedRevision) throw new Error('API_WORKBENCH_PREPARED_STALE')
      return {
        tool,
        preparedId: `${pending.profileId ?? 'new'}_${pending.expectedRevision}`,
        cryptoProfileSave: {
          expectedRevision: pending.expectedRevision,
          profileId: pending.profile.id,
          profileName: pending.profile.name,
          appliesTo: pending.profile.appliesTo,
          steps: [
            ...pending.profile.requestSteps.map((step, index) => ({ index, side: 'request' as const, step })),
            ...pending.profile.responseSteps.map((step, index) => ({ index, side: 'response' as const, step })),
          ].map(({ index, side, step }) => ({
            index, side, kind: step.kind, algo: step.algo,
            ...(step.keyRef ? { keyRef: step.keyRef } : {}),
            ...(step.ivRef ? { ivRef: step.ivRef } : {}),
            ...(step.target ? { target: `${step.target.in}:${step.target.name}` } : {}),
          })),
          keyRefs: cryptoKeyRefs(pending.profile),
          warnings: cryptoProfileWarnings(pending.profile, catalog),
        },
      }
    }
    /** 变量声明：只声明名字与类型；同名变量保持原值不动，避免模型把密钥值清掉。 */
    if (tool === 'api_declare_variables') {
      const catalog = await options.service.getCatalog(context.workspaceId)
      current()
      const pending = parseVariableDeclaration(input, catalog)
      if (catalog.revision !== pending.expectedRevision) throw new Error('API_WORKBENCH_PREPARED_STALE')
      const target = pending.scope === 'workspace'
        ? (catalog.workspaceVariables ?? [])
        : (catalog.collections.find((item) => item.id === pending.collectionId)?.variables ?? [])
      const existingNames = new Set(target.map((field) => field.name))
      return {
        tool,
        preparedId: `${tool}_${pending.expectedRevision}`,
        variableDeclare: {
          expectedRevision: pending.expectedRevision,
          scope: pending.scope,
          ...(pending.collectionId ? { collectionId: pending.collectionId } : {}),
            ...(pending.scope === 'collection' ? { collectionName: catalog.collections.find((item) => item.id === pending.collectionId)?.name ?? '' } : {}),
          variables: pending.declarations.map((declaration) => ({ ...declaration, existing: existingNames.has(declaration.name) })),
          warnings: [
            ...(pending.declarations.some((item) => item.secret) ? ['秘密变量的值不会被 Agent 写入：声明完成后请由人在公共配置里填写'] : []),
            ...(pending.declarations.some((item) => existingNames.has(item.name)) ? ['有同名变量已经存在：本次不改动它们（改密钥请由人在公共配置里操作）'] : []),
          ],
        },
      }
    }
    /** 方案绑定：卡上逐条列出「哪条接口从什么方案改成什么方案」。 */
    if (tool === 'api_bind_crypto_profile') {
      const catalog = await options.service.getCatalog(context.workspaceId)
      current()
      const pending = parseCryptoBinding(input, catalog)
      if (catalog.revision !== pending.expectedRevision) throw new Error('API_WORKBENCH_PREPARED_STALE')
      const unchanged = pending.bindings.filter((binding) => binding.before === binding.profileName).length
      const switched = pending.bindings.filter((binding) => binding.before !== undefined && binding.before !== binding.profileName).length
      return {
        tool,
        preparedId: `${tool}_${pending.expectedRevision}`,
        cryptoBind: {
          expectedRevision: pending.expectedRevision,
          bindings: pending.bindings,
          warnings: [
            ...(unchanged > 0 ? [`其中 ${unchanged} 条接口已经用着这套方案，绑定不会改变它们的行为`] : []),
            ...(switched > 0 ? [`有 ${switched} 条接口原本用着别的方案：绑定后下一次发送立即按新方案执行`] : []),
          ],
        },
      }
    }
    if (tool !== 'api_send_request' && tool !== 'api_save_request') throw new Error('API_AGENT_UNKNOWN_MUTATION')
    const args = mutation(tool, input)
    const draft = drafts.get(args.preparedId)
    if (!draft) throw new Error('API_AGENT_PREPARED_NOT_FOUND')
    /** 保存使用原始草稿和当前目录 CAS；已完成网络快照被清理不影响保存。 */
    if (tool === 'api_save_request') {
      const catalog = await options.service.getCatalog(context.workspaceId)
      current()
      if (catalog.revision !== args.expectedRevision) throw new Error('API_WORKBENCH_PREPARED_STALE')
      /** 来源盖章与人写用例保护在审批之前完成：违规直接拒绝，不会弹出一个已经越界的确认框。 */
      const ownership = stampApiAgentCases(
        draft.requestId ? catalog.requests.find((item) => item.id === draft.requestId)?.cases : undefined,
        draft.request.cases ?? [],
      )
      const fields = (rows: ApiRequestDraft['headers']) => rows.map((field) => ({ ...field, value: field.secret || field.secretRef || /authorization|cookie|api[-_]?key|token|password|secret/i.test(field.name) ? '[REDACTED]' : field.value }))
      const definition: ApiRequestDraft = { ...draft.request, cases: ownership.cases, headers: fields(draft.request.headers), query: fields(draft.request.query), body: { ...draft.request.body, text: redactApiBody(draft.request.body.text), fields: fields(draft.request.body.fields) }, auth: { ...draft.request.auth, value: { value: draft.request.auth.type === 'none' ? '' : '[REDACTED]' } } }
      return {
        tool, preparedId: args.preparedId, preview: draft.preview,
        save: {
          expectedRevision: args.expectedRevision!, requestName: draft.request.name, collectionId: draft.request.collectionId, definition, caseDiff: ownership.diff,
          /** 批量导入最容易留下的三处劣化，先在审批卡上说清楚再让人批准。 */
          warnings: requestQualityWarnings(catalog, definition),
        },
      }
    }
    const preview = await options.service.getPrepared(context, args.preparedId)
    current()
    /** 用例身份由准备时固定；断言条数让审批卡能说清跑的是哪一组断言。 */
    const preparedCase = draft.caseId ? (draft.request.cases ?? []).find((item) => item.id === draft.caseId) : undefined
    /** 发送形态从目录读，不从密钥值读：这里不触发任何解密。 */
    const catalogForShape = await options.service.getCatalog(context.workspaceId)
    current()
    const shape = describeSendShape(catalogForShape, draft.request, preview.environmentId)
    return {
      tool, preparedId: args.preparedId, preview,
      /** 附件行逐条带上真实路径与大小：审批卡据此让用户看清到底要读哪个文件。 */
      ...(draft.files?.length ? { files: draft.files.map((file) => ({ ...file })) } : {}),
      send: { assertionCount: (preparedCase?.assertions ?? draft.request.assertions).length, ...(draft.caseId ? { caseId: draft.caseId } : {}), ...(preparedCase ? { caseName: preparedCase.name } : {}) },
      ...(shape === undefined ? {} : { sendShape: shape }),
    }
  }
  /** 宿主在 UI 批准后再次比较完整快照；异步审批期间变更使批准失效。 */
  async function authorize(tool: string, input: unknown, snapshot: ApiAgentApproval): Promise<void> {
    writable()
    const refreshed = await approval(tool, input)
    if (JSON.stringify(refreshed) !== JSON.stringify(snapshot)) throw new Error('API_AGENT_APPROVAL_STALE')
    grants.set(tool + ':' + refreshed.preparedId, JSON.stringify(refreshed))
  }
  /** 消费前再次复验快照，没有能力即拒绝网络或保存。 */
  async function requireGrant(tool: string, input: unknown): Promise<ApiAgentApproval> {
    writable()
    const args = mutation(tool, input)
    const granted = grants.get(tool + ':' + args.preparedId)
    if (!granted) throw new Error('API_AGENT_APPROVAL_REQUIRED')
    const snapshot = await approval(tool, input)
    if (JSON.stringify(snapshot) !== granted) throw new Error('API_AGENT_APPROVAL_STALE')
    return snapshot
  }
  return {
    approval, authorize,
    /** 已完成发送属于查询，可跳过新一轮审批；仍复验当前运行身份。 */
    hasCompletedSend(input: unknown): boolean { current(); return sent.has(mutation('api_send_request', input).preparedId) },
    /** 列出当前工作区接口摘要与环境，不读取任何 secret 原文。 */
    async list(input: unknown) {
      current()
      const args = apiRecord(input, ['cursor', 'limit'])
      const cursor = args.cursor === undefined ? 0 : apiInteger(args.cursor, 0, API_LIMITS.maxRequests, 'cursor')
      const limit = args.limit === undefined ? 20 : apiInteger(args.limit, 1, 30, 'limit')
      const catalog = await options.service.getCatalog(context.workspaceId)
      current()
      return {
        revision: catalog.revision,
        collections: catalog.collections.map(({ id, name }) => ({ id, name })),
        environments: catalog.environments.map(({ id, name, kind }) => ({ id, name, kind })),
        requests: catalog.requests.slice(cursor, cursor + limit).map(({ id, name, method, folder, collectionId, revision }) => ({ id, name, method, folder, collectionId, revision })),
        /** 场景摘要：只列身份与步骤数，步骤细节用 api_prepare_scenario 拿。 */
        scenarios: (catalog.scenarios ?? []).map(({ id, name, collectionId, folder, steps, revision }) => ({ id, name, collectionId, folder, stepCount: steps.length, revision })),
        nextCursor: cursor + limit < catalog.requests.length ? cursor + limit : null,
      }
    },
    /** 返回已保存且脱敏的定义；大定义由统一模型预算投影。 */
    async get(input: unknown) {
      current()
      const args = apiRecord(input, ['requestId'])
      const id = parseApiId(args.requestId)
      const catalog = await options.service.getCatalog(context.workspaceId)
      current()
      const request = catalog.requests.find((item) => item.id === id)
      if (!request) throw new Error('API_WORKBENCH_REQUEST_NOT_FOUND')
      return { catalogRevision: catalog.revision, request }
    },
    /** 仅准备请求；允许局部草稿覆盖，绝不在 prepare 时出网或修改环境。 */
    async prepare(input: unknown): Promise<ApiPreparedPreview & { draftWarnings?: string[] }> {
      current()
      /**
       * 准备配额是「同时可用的草稿数」，不是「本次运行最多准备几次」。
       *
       * 批量导入一次要改上百条接口，若已完成的草稿一直占着名额，Agent 会把配额烧光并
       * 拿到 `API_AGENT_PREPARE_LIMIT`（现场案例：126 条补参数时被限流，改名因此没做）。
       * 这里的策略：先回收**已经发过**的草稿（它的运行记录已经落盘，`sent` 仍保留去重身份），
       * 实在没有可回收的才拒绝。
       */
      const draftLimit = options.maxDrafts ?? MAX_AGENT_DRAFTS
      if (drafts.size >= draftLimit) reclaimSentDrafts()
      if (drafts.size >= draftLimit) throw new Error('API_AGENT_PREPARE_LIMIT: 同时可用的准备草稿已达上限；请先保存或改用批量整理工具（api_update_requests）')
      const args = apiRecord(input, ['request', 'requestId', 'environmentId', 'overrides', 'caseId'])
      const requestId = args.requestId === undefined ? undefined : parseApiId(args.requestId)
      const catalog = await options.service.getCatalog(context.workspaceId)
      current()
      const saved = requestId ? catalog.requests.find((item) => item.id === requestId) : undefined
      if (requestId && !saved) throw new Error('API_WORKBENCH_REQUEST_NOT_FOUND')
      const base = saved ? apiDraftFromDefinition(saved) : createApiRequestDraft(catalog.collections[0]?.id ?? 'default')
      const overrides = args.request === undefined ? {} : apiRecord(args.request, Object.keys(base))
      /**
       * Agent 声明的文件路径只在这里出现一次：先登记成引用（realpath + stat，不读字节），
       * 再把请求定义里的 `path` 换成引用；路径只留在审批快照与文件仓库两处。
       */
      const declared = parseApiAgentDeclaredFiles(overrides.body)
      if (declared.length > 0 && (overrides.body as { kind?: unknown }).kind !== 'multipart') throw new Error('API_WORKBENCH_INVALID: body.files.multipartOnly')
      const registration = declared.length > 0 ? options.service.registerAgentFiles(context.workspaceId, declared) : undefined
      let request: ApiRequestDraft
      let preview: ApiPreparedPreview
      try {
        request = parseApiRequestDraft({ ...base, ...overrides, ...(registration ? { body: { ...(overrides.body as Record<string, unknown>), files: registration.parts } } : {}) })
        preview = await options.service.prepare(context, { request, ...(requestId ? { requestId } : {}), ...(args.environmentId === undefined ? {} : { environmentId: parseApiId(args.environmentId) }), ...(args.overrides === undefined ? {} : { overrides: parseApiFields(args.overrides) }), ...(args.caseId === undefined ? {} : { caseId: parseApiId(args.caseId) }) })
        current()
      } catch (error) {
        /** 准备失败要回滚刚登记的引用，避免失败的准备长期占满文件槽位。 */
        if (registration) options.service.releaseFiles(context.workspaceId, registration.parts.map((part) => part.ref))
        throw error
      }
      drafts.set(preview.preparedId, {
        request, preview,
        ...(registration?.approvals.length ? { files: registration.approvals } : {}),
        ...(requestId ? { requestId } : {}),
        ...(args.caseId === undefined ? {} : { caseId: parseApiId(args.caseId) }),
      })
      /** 顺手把「好不好用」的提醒回给模型：它可以在保存前自己改名字、抽主机变量、补参数。 */
      const draftWarnings = requestQualityWarnings(catalog, request)
      return draftWarnings.length > 0 ? { ...preview, draftWarnings } : preview
    },
    /** 仅准备一条流程：返回逐步清单与 preparedId，绝不出网。 */
    async prepareScenario(input: unknown): Promise<ApiScenarioPreparedPreview> {
      current()
      if (scenarioDrafts.size >= 64) throw new Error('API_AGENT_PREPARE_LIMIT')
      const args = apiRecord(input, ['scenarioId', 'environmentId', 'overrides'])
      const preview = await options.service.prepareScenario(context, {
        scenarioId: parseApiId(args.scenarioId),
        ...(args.environmentId === undefined ? {} : { environmentId: parseApiId(args.environmentId) }),
        ...(args.overrides === undefined ? {} : { overrides: parseApiFields(args.overrides) }),
      })
      current()
      scenarioDrafts.set(preview.preparedId, preview)
      return preview
    },
    /** 已完成运行属于查询：重复调用返回同一次结论，不再出网。 */
    hasCompletedScenarioRun(input: unknown): boolean { current(); return scenarioRuns.has(mutation('api_run_scenario', input).preparedId) },
    /** 用一次精确批准跑完整条流程；停止 Agent 会同步取消当前在途步骤。 */
    async runScenario(input: unknown, signal?: AbortSignal): Promise<ApiScenarioRun> {
      current()
      const args = mutation('api_run_scenario', input)
      const prior = scenarioRuns.get(args.preparedId)
      if (prior) return prior
      await requireGrant('api_run_scenario', input)
      const run = await write(() => options.service.runScenario(context, args.preparedId, signal ? AbortSignal.any([signal, options.runSignal]) : options.runSignal))
      current()
      scenarioRuns.set(args.preparedId, run)
      return run
    },
    /** 保存场景定义：独立批准的配置变更，expectedRevision 防止覆盖他人的编辑。 */
    async saveScenario(input: unknown) {
      const snapshot = await requireGrant('api_save_scenario', input)
      const pending = snapshot.scenarioSave!
      const catalog = await options.service.getCatalog(context.workspaceId)
      writable()
      const existing = pending.scenarioId ? (catalog.scenarios ?? []).find((item) => item.id === pending.scenarioId) : undefined
      const definition: ApiScenario = { ...pending.scenario, id: existing?.id ?? randomUUID(), revision: existing?.revision ?? 1, updatedAt: Date.now() }
      const scenarios = existing
        ? (catalog.scenarios ?? []).map((item) => item.id === existing.id ? definition : item)
        : [...(catalog.scenarios ?? []), definition]
      const saved = await write(() => options.service.saveCatalog(context.workspaceId, pending.expectedRevision, { ...catalog, scenarios }))
      current()
      grants.delete('api_save_scenario:' + snapshot.preparedId)
      return { scenarioId: definition.id, catalogRevision: saved.revision, saved: true }
    },
    /**
     * 保存环境（含公共变量，例如 `baseUrl`）：独立批准的配置变更。
     *
     * 这条补上「测试环境 http://127.0.0.1:18080 这种公共地址」的最后一环：
     * Agent 可以用它建环境、写变量，之后请求的 URL 就能写成 `{{baseUrl}}/...`。
     * @param input 工具入参（环境定义 + 目录版本）。
     * @returns 落库后的环境身份与目录版本。
     */
    async saveEnvironment(input: unknown) {
      const snapshot = await requireGrant('api_save_environment', input)
      const pending = snapshot.environmentSave!
      const catalog = await options.service.getCatalog(context.workspaceId)
      writable()
      /** 写入的是**未遮罩**的原始定义（秘密值由 Store 转密文），快照只用于展示。 */
      const parsed = parseEnvironmentMutation(input, catalog)
      const existing = pending.environmentId ? catalog.environments.find((item) => item.id === pending.environmentId) : undefined
      const definition: ApiEnvironment = { ...parsed.environment, id: existing?.id ?? randomUUID() }
      const environments = existing
        ? catalog.environments.map((item) => item.id === existing.id ? definition : item)
        : [...catalog.environments, definition]
      const saved = await write(() => options.service.saveCatalog(context.workspaceId, pending.expectedRevision, { ...catalog, environments }))
      current()
      grants.delete('api_save_environment:' + snapshot.preparedId)
      return { environmentId: definition.id, catalogRevision: saved.revision, saved: true }
    },
    /**
     * 保存签名/加密方案：独立批准的配置变更。
     *
     * Agent 负责「按文档把算法与模板配好、把密钥变量名声明好」，密钥值永远不由它写入。
     * @param input 工具入参（方案定义 + 目录版本）。
     * @returns 落库后的方案身份与版本。
     */
    async saveCryptoProfile(input: unknown) {
      const snapshot = await requireGrant('api_save_crypto_profile', input)
      const pending = snapshot.cryptoProfileSave!
      const catalog = await options.service.getCatalog(context.workspaceId)
      writable()
      /** 用同一份入参重新解析：审批期间内容被改过会在 requireGrant 处就失效。 */
      const reparsed = parseCryptoProfileMutation(input, catalog)
      const existing = pending.profileId === 'profile_agent_new' ? undefined : (catalog.cryptoProfiles ?? []).find((item) => item.id === pending.profileId)
      /** 新方案的 id 由 Host 生成：模型不负责稳定身份。 */
      const definition: ApiCryptoProfile = { ...reparsed.profile, id: existing?.id ?? randomUUID() }
      const saved = await write(() => options.service.saveCryptoProfile(context.workspaceId, definition, existing?.revision ?? null))
      current()
      grants.delete('api_save_crypto_profile:' + snapshot.preparedId)
      return { profileId: saved.id, profileName: saved.name, revision: saved.revision, steps: saved.requestSteps.length + saved.responseSteps.length, saved: true }
    },
    /**
     * 声明变量名（工作区级或集合级）：独立批准的配置变更。
     *
     * 只写名字与类型，值一律留空——密钥值只能由人在公共配置里填写；
     * 同名变量保持原值不动，避免「Agent 声明一遍把已有密钥清掉」。
     * @param input 工具入参（作用域 + 变量声明 + 目录版本）。
     * @returns 新增条数与被跳过的同名条数。
     */
    async declareVariables(input: unknown) {
      const snapshot = await requireGrant('api_declare_variables', input)
      const pending = snapshot.variableDeclare!
      const catalog = await options.service.getCatalog(context.workspaceId)
      writable()
      const reparsed = parseVariableDeclaration(input, catalog)
      const existingFields = reparsed.scope === 'workspace'
        ? (catalog.workspaceVariables ?? [])
        : (catalog.collections.find((item) => item.id === reparsed.collectionId)?.variables ?? [])
      const existingNames = new Set(existingFields.map((field) => field.name))
      const declared: ApiField[] = reparsed.declarations
        .filter((declaration) => !existingNames.has(declaration.name))
        .map((declaration) => ({
          id: `var_${randomUUID().slice(0, 8)}`,
          name: declaration.name,
          /** 值永远是空字符串：Agent 不能写密钥值，等人来填。 */
          value: '',
          enabled: declaration.enabled,
          ...(declaration.secret ? { secret: true } : {}),
        }))
      const skipped = reparsed.declarations.length - declared.length
      if (declared.length > 0) {
        if (reparsed.scope === 'workspace') {
          await write(() => options.service.saveWorkspaceVariables(context.workspaceId, [...existingFields, ...declared]))
        } else {
          const collectionId = reparsed.collectionId as string
          await write(() => options.service.saveCatalog(context.workspaceId, pending.expectedRevision, {
            ...catalog,
            collections: catalog.collections.map((item) => (item.id === collectionId ? { ...item, variables: [...item.variables, ...declared] } : item)),
          }))
        }
      }
      current()
      grants.delete('api_declare_variables:' + snapshot.preparedId)
      const latest = await options.service.getCatalog(context.workspaceId)
      return { declared: declared.length, names: declared.map((field) => field.name), skippedExisting: skipped, catalogRevision: latest.revision }
    },
    /**
     * 绑定方案到接口：独立批准的配置变更，只改「选哪套方案」，不碰 URL、正文与断言。
     * @param input 工具入参（绑定列表 + 目录版本）。
     * @returns 绑定条数与新目录版本。
     */
    async bindCryptoProfile(input: unknown) {
      const snapshot = await requireGrant('api_bind_crypto_profile', input)
      const pending = snapshot.cryptoBind!
      const catalog = await options.service.getCatalog(context.workspaceId)
      writable()
      const reparsed = parseCryptoBinding(input, catalog)
      const byRequest = new Map(reparsed.bindings.map((binding) => [binding.requestId, binding.after]))
      const saved = await write(() => options.service.saveCatalog(context.workspaceId, pending.expectedRevision, {
        ...catalog,
        requests: catalog.requests.map((request) => {
          const profileId = byRequest.get(request.id)
          return profileId === undefined ? request : { ...request, selectedProfileId: profileId }
        }),
      }))
      current()
      grants.delete('api_bind_crypto_profile:' + snapshot.preparedId)
      return { bound: reparsed.bindings.length, catalogRevision: saved.revision }
    },
    /**
     * 批量配置变更：一次批准改一批接口（分组 / 取名 / 绑定环境），一次原子落库。
     *
     * 这是「让 Agent 把之前建的接口整理一遍」的入口：126 条不再需要 126 次审批，
     * 但仍逐条校验身份与目标集合/环境，且快照里会列出「从什么改成什么」。
     * @param input 工具入参（updates + 目录版本）。
     * @returns 改动条数与新目录版本。
     */
    async updateRequests(input: unknown) {
      const snapshot = await requireGrant('api_update_requests', input)
      const pending = snapshot.requestUpdates!
      const catalog = await options.service.getCatalog(context.workspaceId)
      writable()
      /** 用同一份入参重新解析：审批期间内容被改过会在 requireGrant 处就失效。 */
      const reparsed = parseRequestUpdates(catalog, input)
      const byId = new Map(reparsed.updates.map((update) => [update.requestId, update]))
      const requests = catalog.requests.map((request) => {
        const update = byId.get(request.id)
        if (!update) return request
        return {
          ...request,
          name: update.after.name,
          folder: update.after.folder,
          collectionId: update.after.collectionId,
          /** 显式清掉环境绑定时也要落成「没有绑定」，不能沿用旧值。 */
          targetEnvironmentId: update.after.targetEnvironmentId,
          /** revision 与 updatedAt 由 Store 按「内容是否变化」统一维护，这里不能自己加。 */
        }
      })
      const saved = await write(() => options.service.saveCatalog(context.workspaceId, pending.expectedRevision, { ...catalog, requests }))
      current()
      grants.delete('api_update_requests:' + snapshot.preparedId)
      return { updated: reparsed.updates.length, catalogRevision: saved.revision }
    },
    /**
     * 剥离测试环境地址：把硬编码主机抽成集合/环境变量，并把命中请求绑定到目标环境。
     *
     * 改写由共享纯函数执行（模型不能自己拼 URL），所以这次批准既安全又可复算。
     * @param input 工具入参（集合、可选环境与变量名、目录版本）。
     * @returns 改写条数、变量名与主机。
     */
    async extractBaseUrl(input: unknown) {
      const snapshot = await requireGrant('api_extract_base_url', input)
      const pending = snapshot.baseUrlExtract!
      const catalog = await options.service.getCatalog(context.workspaceId)
      writable()
      const extraction = extractApiBaseUrlVariable(catalog, pending.collectionId, { ...(pending.environmentId ? { environmentId: pending.environmentId } : {}), variableName: pending.variableName })
      const saved = await write(() => options.service.saveCatalog(context.workspaceId, pending.expectedRevision, extraction.catalog))
      current()
      grants.delete('api_extract_base_url:' + snapshot.preparedId)
      return { updated: extraction.updated, variableName: extraction.variableName, origin: extraction.origin, catalogRevision: saved.revision }
    },
    /** 使用精确批准派发一次请求；停止 Agent 会同步取消对应网络任务。 */
    async send(input: unknown, signal?: AbortSignal): Promise<ApiAgentRunSummary> {
      current()
      const args = mutation('api_send_request', input)
      const prior = sent.get(args.preparedId)
      if (prior) return prior
      await requireGrant('api_send_request', input)
      const run = await write(() => options.service.send(context, args.preparedId, signal ? AbortSignal.any([signal, options.runSignal]) : options.runSignal))
      current()
      const summary: ApiAgentRunSummary = { kind: 'api-workbench-run', runId: run.id, sessionId: context.sessionId, method: run.request.method, url: run.request.url, state: run.state, status: run.hops.at(-1)?.status ?? null, durationMs: run.finishedAt === undefined ? null : Math.max(0, run.finishedAt - run.createdAt), assertions: { passed: run.assertions.filter((item) => item.passed).length, total: run.assertions.length }, recording: run.recording, ...(run.caseId ? { caseId: run.caseId } : {}), ...(run.error ? { error: run.error } : {}) }
      sent.set(args.preparedId, summary)
      return summary
    },
    /** 保存是独立批准的配置变更，expectedRevision 防止覆盖他人的编辑。 */
    async save(input: unknown) {
      const snapshot = await requireGrant('api_save_request', input)
      const draft = drafts.get(snapshot.preparedId)!
      const catalog = await options.service.getCatalog(context.workspaceId)
      writable()
      const old = catalog.requests.find((item) => item.id === draft.requestId)
      /** 与审批时同一份纯逻辑再算一次：来源章与保护不会因审批期间的时间差而漂移。 */
      const ownership = stampApiAgentCases(old?.cases, draft.request.cases ?? [])
      const definition = { ...draft.request, cases: ownership.cases, id: old?.id ?? randomUUID(), revision: old?.revision ?? 1, updatedAt: Date.now() }
      const requests = old ? catalog.requests.map((item) => item.id === old.id ? definition : item) : [...catalog.requests, definition]
      const saved = await write(() => options.service.saveCatalog(context.workspaceId, snapshot.save!.expectedRevision, { ...catalog, requests }))
      current()
      grants.delete('api_save_request:' + snapshot.preparedId)
      /** 保存成功后释放草稿名额：批量整理上百条时不再被「同时可用的准备数」卡住。 */
      drafts.delete(snapshot.preparedId)
      return { requestId: definition.id, catalogRevision: saved.revision, saved: true }
    },
    /** 只读查询自己会话的同一次 run；正文、头和断言按页读，不能 reveal。 */
    async inspect(input: unknown) {
      current()
      const args = apiRecord(input, ['runId', 'section', 'hop', 'offset', 'limit'])
      const runId = parseApiId(args.runId)
      const offset = args.offset === undefined ? 0 : apiInteger(args.offset, 0, API_LIMITS.bodyBytes, 'offset')
      const section = args.section ?? 'summary'
      if (section === 'body') {
        const limit = args.limit === undefined ? 4000 : apiInteger(args.limit, 1, 4000, 'limit')
        const result = await options.service.readBody(context, runId, { offset, limit })
        current(); return result
      }
      const run = await options.service.getRun(context, runId, false)
      current()
      const hopIndex = args.hop === undefined ? run.hops.length - 1 : apiInteger(args.hop, 0, 10, 'hop')
      const hop = run.hops[hopIndex]
      const limit = args.limit === undefined ? 20 : apiInteger(args.limit, 1, 30, 'limit')
      if (section === 'request') return { ...run.request, body: run.request.body.slice(offset, offset + 4000), bodyOffset: offset, bodyChars: run.request.body.length }
      if (section === 'timings') return { hops: run.hops.map(({ timings, connection, status, url }) => ({ timings, connection, status, url })) }
      if (section === 'headers') {
        const rows = [...(hop?.requestHeaders ?? []).map((item) => ({ ...item, direction: 'request' })), ...(hop?.responseHeaders ?? []).map((item) => ({ ...item, direction: 'response' })), ...(hop?.trailers ?? []).map((item) => ({ ...item, direction: 'trailer' }))]
        return { hop: hopIndex, requestHeadersSource: hop?.requestHeadersSource, rows: rows.slice(offset, offset + limit), nextOffset: offset + limit < rows.length ? offset + limit : null }
      }
      if (section === 'assertions') return { assertions: run.assertions.slice(offset, offset + limit), total: run.assertions.length }
      if (section === 'sse') {
        /** 事件页同时受条数与字符预算约束，保证模型拿到的一定是可用的 JSON。 */
        const events = run.sse?.events ?? []
        const page: typeof events = []
        let used = 0
        for (const event of events.slice(offset, offset + limit)) {
          const bounded = {
            ...event,
            comment: event.comment.slice(0, 1_000),
            data: event.data.slice(0, 2_000),
            raw: event.raw.slice(0, 2_000),
          }
          const size = bounded.comment.length + bounded.data.length + bounded.raw.length + 128
          if (page.length > 0 && used + size > 20 * 1024) break
          page.push(bounded)
          used += size
        }
        return {
          stream: run.sse
            ? { totalEvents: run.sse.totalEvents, firstEventMs: run.sse.firstEventMs, droppedEvents: run.sse.droppedEvents, endedReason: run.sse.endedReason }
            : null,
          events: page,
          nextOffset: offset + page.length < events.length ? offset + page.length : null,
        }
      }
      if (section !== 'summary') throw new Error('API_AGENT_SECTION_INVALID')
      return { runId, state: run.state, status: hop?.status ?? null, recording: run.recording, body: { ...run.body, preview: run.body.preview.slice(0, 4000) }, error: run.error }
    },
  }
}
/** 已绑定真实运行身份的能力对象，不能从模型参数构造。 */
export type ApiAgentFacade = NonNullable<ReturnType<typeof createApiAgentFacade>>
