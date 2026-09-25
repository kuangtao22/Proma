import { randomUUID } from 'node:crypto'
import { API_LIMITS, apiRecord, apiInteger, apiDraftFromDefinition, createApiRequestDraft, isOrdinaryTopLevelAgentSession, parseApiFields, parseApiId, parseApiRequestDraft, parseApiScenario } from '@proma/shared'
import type { AgentSessionMeta, ApiCatalog, ApiPreparedPreview, ApiRequestDraft, ApiRun, ApiScenario, ApiScenarioPreparedPreview, ApiScenarioRun } from '@proma/shared'
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
   * 本次要读取并上传的附件：字段名、`realpath` 与大小。
   *
   * 只用于审批卡展示（审批快照是路径允许存在的两处之一），不进请求定义、运行记录与模型上下文。
   */
  files?: Array<{ field: string; path: string; sizeBytes: number }>
  /** 发送审批的结构化摘要：这次跑的是哪一组断言。 */
  send?: { caseId?: string; caseName?: string; assertionCount: number }
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
  service: Pick<ApiWorkbenchService, 'getCatalog' | 'saveCatalog' | 'prepare' | 'getPrepared' | 'send' | 'getRun' | 'readBody' | 'registerAgentFiles' | 'releaseFiles' | 'prepareScenario' | 'getScenarioPrepared' | 'runScenario'>
  runSignal: AbortSignal
  assertRunActive(): void
  assertWorkspaceWritable?(workspaceId: string): void
  canMutate?(): boolean
  runWorkspaceWrite?<T>(workspaceId: string, effect: () => T): T
}
/** 会话聊天卡片只引用一次真实运行，不包含任意文件路径或执行入口。 */
export interface ApiAgentRunSummary {
  kind: 'api-workbench-run'; runId: string; sessionId: string; method: string; url: string
  state: ApiRun['state']; status: number | null; durationMs: number | null
  assertions: { passed: number; total: number }; recording: ApiRun['recording']; error?: ApiRun['error']
  /** 本次运行所跑的测试用例；未按用例跑时缺省。 */
  caseId?: string
}
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
    throw new Error('API_AGENT_UNKNOWN_MUTATION')
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
    return {
      tool, preparedId: args.preparedId, preview,
      /** 附件行逐条带上真实路径与大小：审批卡据此让用户看清到底要读哪个文件。 */
      ...(draft.files?.length ? { files: draft.files.map((file) => ({ ...file })) } : {}),
      send: { assertionCount: (preparedCase?.assertions ?? draft.request.assertions).length, ...(draft.caseId ? { caseId: draft.caseId } : {}), ...(preparedCase ? { caseName: preparedCase.name } : {}) },
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
      if (drafts.size >= 128) throw new Error('API_AGENT_PREPARE_LIMIT')
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
