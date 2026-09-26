/**
 * 接口工作台审批卡的结构化视图。
 *
 * 审批横幅原先只把 toolInput 序列化成 JSON，用户看不出「这次要写什么」「模型改动了哪条用例」。
 * 这里把 Host 已脱敏的审批快照投影成可读行，纯函数、无副作用，便于单独回归。
 */

/** 一条用例差异；字段由 Host 生成，渲染层只负责展示。 */
export interface ApiApprovalCaseDiff {
  caseId: string
  caseName: string
  source: 'user' | 'agent'
  change: 'added' | 'updated' | 'removed'
  assertionCount: number
}

/**
 * 一条待上传附件行。
 *
 * `path` 是 Host 用 `realpath` 解析后的真实路径（符号链接无法伪装成别的文件名），
 * 大小取自登记时的 stat；字节要到用户批准之后才会被读取。
 */
export interface ApiApprovalFileLine {
  /** 目标表单字段名。 */
  field: string
  /** realpath；只在本机界面上展示。 */
  path: string
  sizeBytes: number
  /** 成品展示文本，避免调用方再拼一遍格式。 */
  text: string
}

/** 审批卡要展示的接口视图；caseDiff 为空表示这次没有用例改动。 */
export interface ApiWorkbenchApprovalView {
  kind: 'api-send' | 'api-save' | 'api-scenario-run' | 'api-scenario-save' | 'api-environment-save' | 'api-request-updates' | 'api-base-url-extract' | 'api-crypto-profile' | 'api-variable-declare' | 'api-crypto-bind'
  title: string
  lines: string[]
  /** 本次要读取并上传的文件；为空表示没有附件（普通请求或保存审批）。 */
  files: ApiApprovalFileLine[]
  /** 流程审批的步骤清单：一次批准针对的就是这几行。 */
  steps: ApiApprovalScenarioStep[]
  /** Host 给出的提醒（production 环境、continue 策略等）。 */
  warnings: string[]
  caseDiff: ApiApprovalCaseDiff[]
}

/** 流程里的一步：序号 + 「名称 · 方法 URL」等展示文本。 */
export interface ApiApprovalScenarioStep {
  index: number
  text: string
}

/** 变更类型的中文说明，顺序固定为新增/修改/删除。 */
const CHANGE_LABEL: Record<ApiApprovalCaseDiff['change'], string> = { added: '新增', updated: '修改', removed: '删除' }

/** 读取普通对象字段，非字符串一律忽略。 */
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 读取可选对象，数组与原始值都不算快照。 */
function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 解析 Host 生成的用例差异；结构不符的项直接丢弃，避免渲染层展示半截事实。 */
function caseDiff(value: unknown): ApiApprovalCaseDiff[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const entry = record(item)
    const caseId = entry ? string(entry.caseId) : undefined
    const caseName = entry ? string(entry.caseName) : undefined
    const change = entry?.change
    if (!entry || !caseId || !caseName) return []
    if (change !== 'added' && change !== 'updated' && change !== 'removed') return []
    return [{
      caseId,
      caseName,
      source: entry.source === 'agent' ? 'agent' as const : 'user' as const,
      change,
      assertionCount: typeof entry.assertionCount === 'number' ? entry.assertionCount : 0,
    }]
  })
}

/** 解析 Host 生成的附件行；结构不符的项直接丢弃，避免展示半截事实。 */
function fileLines(value: unknown): ApiApprovalFileLine[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const entry = record(item)
    const field = entry ? string(entry.field) : undefined
    const path = entry ? string(entry.path) : undefined
    const sizeBytes = entry?.sizeBytes
    if (!entry || !field || !path) return []
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return []
    return [{ field, path, sizeBytes, text: `字段 ${field}：${path}（${sizeBytes} 字节）` }]
  })
}

/** 解析 Host 生成的流程步骤清单；坏项丢弃，序号必须从 0 连续，避免展示成另一种顺序。 */
function scenarioSteps(value: unknown): ApiApprovalScenarioStep[] {
  if (!Array.isArray(value)) return []
  const steps = value.flatMap((item) => {
    const entry = record(item)
    const index = entry?.index
    const name = entry ? string(entry.name) : undefined
    const method = entry ? string(entry.method) : undefined
    const url = entry ? string(entry.url) : undefined
    if (!entry || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || !name || !method || !url) return []
    const environment = string(entry.environmentKind)
    const caseId = string(entry.caseId)
    return [{ index, text: `${index + 1}. ${name} · ${method} ${url}${caseId ? `（用例 ${caseId}）` : ''}${environment === 'production' ? ' ⚠ 生产环境' : ''}` }]
  }).sort((a, b) => a.index - b.index)
  if (steps.some((step, position) => step.index !== position)) return []
  return steps
}

/** 解析 Host 给出的提醒文本。 */
function warnings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => (typeof item === 'string' && item !== '' ? [item] : []))
}

/**
 * 把接口工作台的两个变更工具投影成审批卡视图。
 * @param toolName 工具名；非接口变更工具返回 null，调用方回落到原有 JSON 展示。
 * @param toolInput 宿主组装的审批快照（含脱敏 preview 与 save.send 摘要）。
 * @returns 结构化视图；快照缺少必要字段时返回 null。
 */
export function describeApiWorkbenchApproval(toolName: string, toolInput: Record<string, unknown>): ApiWorkbenchApprovalView | null {
  /** 一次批准跑完整条流程：卡片逐行列出将要发出的每一步。 */
  if (toolName === 'api_run_scenario') {
    const scenario = record(toolInput.scenario)
    if (!scenario) return null
    const name = string(scenario.scenarioName) ?? '未命名流程'
    const environmentId = string(scenario.environmentId)
    const onFailure = scenario.onFailure === 'continue' ? 'continue（失败后继续执行后续步骤）' : 'stop（失败后跳过后续步骤）'
    const steps = scenarioSteps(scenario.steps)
    return {
      kind: 'api-scenario-run',
      title: '运行接口流程（一次批准整条流程）',
      lines: [`流程：${name}`, `环境：${environmentId ?? '未选择'}`, `失败策略：${onFailure}`, `步骤：${steps.length} 步，严格按顺序执行`],
      files: [],
      steps,
      warnings: warnings(scenario.warnings),
      caseDiff: [],
    }
  }
  /** 保存流程只落定义，不解析 URL：这里列出步骤与它们引用的接口身份。 */
  if (toolName === 'api_save_scenario') {
    const save = record(toolInput.scenarioSave)
    const scenario = save ? record(save.scenario) : undefined
    if (!save || !scenario) return null
    const name = string(scenario.name) ?? '未命名流程'
    const collectionId = string(scenario.collectionId)
    const folder = string(scenario.folder)
    const environmentId = string(scenario.environmentId)
    const declared = Array.isArray(scenario.steps) ? scenario.steps : []
    const steps = declared.flatMap((item, index) => {
      const entry = record(item)
      const stepName = entry ? string(entry.name) : undefined
      const requestId = entry ? string(entry.requestId) : undefined
      if (!stepName || !requestId) return []
      const caseId = string(entry?.caseId)
      return [{ index, text: `${index + 1}. ${stepName} → ${requestId}${caseId ? `（用例 ${caseId}）` : ''}` }]
    })
    return {
      kind: 'api-scenario-save',
      title: '保存接口流程',
      lines: [
        `流程：${name}`,
        `保存到集合：${collectionId ?? '未知集合'}`,
        `模块（文件夹）：${folder && folder !== '' ? folder : '（未分组）'}`,
        `环境：${environmentId ?? '未选择'}`,
        `步骤：${steps.length} 步`,
      ],
      files: [],
      steps,
      warnings: [],
      caseDiff: [],
    }
  }
  /** 保存环境：只列变量名与个数（取值已被 Host 遮罩），生产环境单独提醒。 */
  if (toolName === 'api_save_environment') {
    const save = record(toolInput.environmentSave)
    const environment = save ? record(save.environment) : undefined
    if (!save || !environment) return null
    const name = string(environment.name) ?? '未命名环境'
    const kind = string(environment.kind) ?? 'test'
    const variables = Array.isArray(environment.variables) ? environment.variables : []
    const names = variables.flatMap((item) => {
      const entry = record(item)
      const variableName = entry ? string(entry.name) : undefined
      return variableName ? [variableName] : []
    })
    return {
      kind: 'api-environment-save',
      title: '保存环境变量',
      lines: [
        `环境：${name}（${kind === 'production' ? '生产' : kind === 'local' ? '开发' : '测试'}）`,
        `变量：${names.length > 0 ? `${names.join('、')}（${names.length} 个）` : '（本次不写变量）'}`,
        '保存后请求 URL 里可以写 {{变量名}}，例如 {{baseUrl}}/admin/v1/...',
      ],
      files: [],
      steps: [],
      warnings: warnings(save.warnings),
      caseDiff: [],
    }
  }
  /** 批量整理接口：逐条列出「从什么改成什么」，这是用户批准的唯一依据。 */
  if (toolName === 'api_update_requests') {
    const pending = record(toolInput.requestUpdates)
    if (!pending) return null
    const updates = Array.isArray(pending.updates) ? pending.updates : []
    const steps = updates.flatMap((item, index) => {
      const entry = record(item)
      const before = entry ? record(entry.before) : undefined
      const after = entry ? record(entry.after) : undefined
      if (!entry || !before || !after) return []
      const requestId = string(entry.requestId) ?? '（未知接口）'
      const changes: string[] = []
      if (string(before.name) !== string(after.name)) changes.push(`改名：${string(before.name) ?? '（空）'} → ${string(after.name) ?? '（空）'}`)
      if ((string(before.folder) ?? '') !== (string(after.folder) ?? '')) changes.push(`分组：${string(before.folder) || '根目录'} → ${string(after.folder) || '根目录'}`)
      if ((string(before.collectionId) ?? '') !== (string(after.collectionId) ?? '')) changes.push(`集合：${string(before.collectionId) ?? '（未知）'} → ${string(after.collectionId) ?? '（未知）'}`)
      const beforeEnvironment = string(before.targetEnvironmentId)
      const afterEnvironment = string(after.targetEnvironmentId)
      if (beforeEnvironment !== afterEnvironment) changes.push(`环境：${beforeEnvironment ?? '未绑定'} → ${afterEnvironment ?? '解除绑定'}`)
      return [{ index, text: `${index + 1}. ${requestId}｜${changes.length > 0 ? changes.join('；') : '无变化（仅提升版本）'}` }]
    })
    return {
      kind: 'api-request-updates',
      title: `批量整理接口（一次批准 ${steps.length} 条）`,
      lines: ['只修改名字 / 分组 / 集合 / 环境绑定；URL 与请求参数不在本次改动范围内'],
      files: [],
      steps,
      warnings: warnings(pending.warnings),
      caseDiff: [],
    }
  }
  /** 剥离测试环境地址：显示抽哪个主机、写到哪一层、改多少条。 */
  if (toolName === 'api_extract_base_url') {
    const pending = record(toolInput.baseUrlExtract)
    if (!pending) return null
    const origin = string(pending.origin) ?? '（未知主机）'
    const variableName = string(pending.variableName) ?? 'baseUrl'
    const environmentName = string(pending.environmentName)
    const scope = environmentName ? `环境「${environmentName}」` : '集合'
    return {
      kind: 'api-base-url-extract',
      title: '剥离测试环境地址',
      lines: [
        `把 ${origin} 抽成${scope}的变量 {{${variableName}}}`,
        `将改写 ${typeof pending.updated === 'number' ? pending.updated : 0} 条请求：URL 变成 {{${variableName}}}/...`,
        environmentName ? '这些请求会同时绑定到该环境（换环境只改一处）' : '变量写在集合里，所有绑定该集合的请求都能用',
      ],
      files: [],
      steps: [],
      warnings: [],
      caseDiff: [],
    }
  }
  /** 声明变量：只声明名字与类型，卡上明确写「值由人填」。 */
  if (toolName === 'api_declare_variables') {
    const pending = record(toolInput.variableDeclare)
    if (!pending) return null
    const variables = Array.isArray(pending.variables) ? pending.variables.flatMap((item) => {
      const entry = record(item)
      const name = entry ? string(entry.name) : undefined
      return entry && name ? [{ name, secret: entry.secret === true, existing: entry.existing === true }] : []
    }) : []
    const scopeLabel = pending.scope === 'collection'
      ? `集合「${string(pending.collectionName) ?? string(pending.collectionId) ?? '未知'}」`
      : '工作区（跨集合共用）'
    return {
      kind: 'api-variable-declare',
      title: '声明接口变量（值由你填写）',
      lines: [
        `作用域：${scopeLabel}`,
        `数量：${variables.length} 个`,
        ...variables.map((item) => `${item.name}${item.secret ? '（秘密）' : ''}${item.existing ? ' · 已存在，值保持不动' : ' · 待你填值'}`),
        '读密钥：否 · 写密钥：否（Agent 只能声明名字与类型，密钥值只能由人填写）',
      ],
      files: [],
      steps: [],
      warnings: warnings(pending.warnings),
      caseDiff: [],
    }
  }
  /** 方案保存：卡上列出每一步的算法与密钥变量名（只有名字，没有值）。 */
  if (toolName === 'api_save_crypto_profile') {
    const pending = record(toolInput.cryptoProfileSave)
    if (!pending) return null
    const steps = Array.isArray(pending.steps) ? pending.steps.flatMap((item) => {
      const entry = record(item)
      if (!entry) return []
      const index = typeof entry.index === 'number' ? entry.index : 0
      const side = entry.side === 'response' ? '收到后' : '发送前'
      const keyRef = string(entry.keyRef)
      const ivRef = string(entry.ivRef)
      const target = string(entry.target)
      return [`${side} · ${index + 1} · ${string(entry.kind) ?? '步骤'} ${string(entry.algo) ?? ''}${keyRef ? ` · 密钥 🔒${keyRef}` : ''}${ivRef ? ` · IV 🔒${ivRef}` : ''}${target ? ` · 写入 ${target}` : ''}`]
    }) : []
    const keyRefs = Array.isArray(pending.keyRefs) ? pending.keyRefs.filter((item): item is string => typeof item === 'string') : []
    const appliesTo = pending.appliesTo === 'production' ? '仅生产环境' : pending.appliesTo === 'test' ? '仅测试环境' : '所有环境'
    return {
      kind: 'api-crypto-profile',
      title: '保存签名/加密方案',
      lines: [
        `方案：${string(pending.profileName) ?? '未命名'}（${appliesTo}）`,
        `步骤：${steps.length} 步，按数组顺序执行`,
        ...steps,
        `将读取的密钥变量名：${keyRefs.length > 0 ? keyRefs.map((name) => `🔒${name}`).join('、') : '无'}`,
        '读密钥：否 · 写密钥：否（密钥值只在主进程内使用，界面与记录都不出现）',
      ],
      files: [],
      steps: [],
      warnings: warnings(pending.warnings),
      caseDiff: [],
    }
  }
  /** 方案绑定：逐行列出「哪条接口从什么方案改成什么方案」。 */
  if (toolName === 'api_bind_crypto_profile') {
    const pending = record(toolInput.cryptoBind)
    if (!pending) return null
    const bindings = Array.isArray(pending.bindings) ? pending.bindings.flatMap((item) => {
      const entry = record(item)
      const requestName = entry ? string(entry.requestName) : undefined
      const profileName = entry ? string(entry.profileName) : undefined
      if (!entry || !requestName || !profileName) return []
      const before = string(entry.before)
      return [`${requestName}：${before ? `${before} → ` : '未绑定 → '}${profileName}`]
    }) : []
    return {
      kind: 'api-crypto-bind',
      title: '给接口绑定加密方案',
      lines: [
        `数量：${bindings.length} 条（只改选方案，不改 URL、正文与断言）`,
        ...bindings,
        '发送加密请求时需要另一次审批，那次才会读取密钥',
      ],
      files: [],
      steps: [],
      warnings: warnings(pending.warnings),
      caseDiff: [],
    }
  }
  if (toolName !== 'api_send_request' && toolName !== 'api_save_request') return null
  const preview = record(toolInput.preview)
  if (!preview) return null
  const request = record(preview.request)
  const method = request ? string(request.method) ?? 'HTTP' : 'HTTP'
  const url = request ? string(request.url) ?? '（未解析）' : '（未解析）'
  const requestName = string(preview.requestName)
  const environmentId = string(preview.environmentId)
  /** 附件行只在发送审批上有意义：保存写的是引用，重启后本来就要重新选文件。 */
  const files = fileLines(toolInput.files)
  const lines = [`${method} ${url}`]
  if (requestName) lines.push(`请求名称：${requestName}`)

  if (toolName === 'api_send_request') {
    const send = record(toolInput.send)
    const caseName = send ? string(send.caseName) : undefined
    const caseId = send ? string(send.caseId) : undefined
    const assertionCount = send && typeof send.assertionCount === 'number' ? send.assertionCount : 0
    lines.push(`环境：${environmentId ?? '未选择'}`)
    lines.push(caseName || caseId ? `用例：${caseName ?? caseId}（${assertionCount} 条断言）` : `断言：请求自身默认断言 ${assertionCount} 条`)
    /** 发送形态：用哪套方案、缺哪些密钥，缺了会明文发出——这一行不能省。 */
    const shape = record(toolInput.sendShape)
    if (shape) {
      const profileName = string(shape.profileName) ?? '（未知方案）'
      const shapeSteps = Array.isArray(shape.steps) ? shape.steps.filter((item): item is string => typeof item === 'string') : []
      const missing = Array.isArray(shape.missing) ? shape.missing.filter((item): item is string => typeof item === 'string') : []
      lines.push(`发送形态：${shapeSteps.length > 0 ? shapeSteps.join(' → ') : '无步骤'} · 方案「${profileName}」`)
      if (missing.length > 0) lines.push(`⚠ 缺少密钥变量：${missing.join('、')} —— 对应步骤会被跳过，本次按明文发出`)
    } else {
      lines.push('发送形态：不签名不加密（原始内容直接发出）')
    }
    return { kind: 'api-send', title: '发送接口请求', lines, files, steps: [], warnings: warnings(preview.warnings), caseDiff: [] }
  }

  const save = record(toolInput.save)
  const collectionId = save ? string(save.collectionId) : undefined
  lines.push(`保存到集合：${collectionId ?? '未知集合'}`)
  const diff = caseDiff(save?.caseDiff)
  if (diff.length === 0) lines.push('用例：本次没有改动')
  /** 保存审批要带上「好不好用」的提醒（名字、硬编码主机、空参数）。 */
  return { kind: 'api-save', title: '保存接口定义', lines, files: [], steps: [], warnings: warnings(save?.warnings), caseDiff: diff }
}

/** 用例差异的展示文本，删除项单独标红由调用方处理。 */
export function formatApiApprovalCaseDiff(entry: ApiApprovalCaseDiff): string {
  return `${CHANGE_LABEL[entry.change]}：${entry.caseName}（${entry.source === 'agent' ? 'Agent' : '人工'}，${entry.assertionCount} 条断言）`
}
