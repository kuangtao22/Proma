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

/** 审批卡要展示的接口视图；caseDiff 为空表示这次没有用例改动。 */
export interface ApiWorkbenchApprovalView {
  kind: 'api-send' | 'api-save'
  title: string
  lines: string[]
  caseDiff: ApiApprovalCaseDiff[]
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

/**
 * 把接口工作台的两个变更工具投影成审批卡视图。
 * @param toolName 工具名；非接口变更工具返回 null，调用方回落到原有 JSON 展示。
 * @param toolInput 宿主组装的审批快照（含脱敏 preview 与 save.send 摘要）。
 * @returns 结构化视图；快照缺少必要字段时返回 null。
 */
export function describeApiWorkbenchApproval(toolName: string, toolInput: Record<string, unknown>): ApiWorkbenchApprovalView | null {
  if (toolName !== 'api_send_request' && toolName !== 'api_save_request') return null
  const preview = record(toolInput.preview)
  if (!preview) return null
  const request = record(preview.request)
  const method = request ? string(request.method) ?? 'HTTP' : 'HTTP'
  const url = request ? string(request.url) ?? '（未解析）' : '（未解析）'
  const requestName = string(preview.requestName)
  const environmentId = string(preview.environmentId)
  const lines = [`${method} ${url}`]
  if (requestName) lines.push(`请求名称：${requestName}`)

  if (toolName === 'api_send_request') {
    const send = record(toolInput.send)
    const caseName = send ? string(send.caseName) : undefined
    const caseId = send ? string(send.caseId) : undefined
    const assertionCount = send && typeof send.assertionCount === 'number' ? send.assertionCount : 0
    lines.push(`环境：${environmentId ?? '未选择'}`)
    lines.push(caseName || caseId ? `用例：${caseName ?? caseId}（${assertionCount} 条断言）` : `断言：请求自身默认断言 ${assertionCount} 条`)
    return { kind: 'api-send', title: '发送接口请求', lines, caseDiff: [] }
  }

  const save = record(toolInput.save)
  const collectionId = save ? string(save.collectionId) : undefined
  lines.push(`保存到集合：${collectionId ?? '未知集合'}`)
  const diff = caseDiff(save?.caseDiff)
  if (diff.length === 0) lines.push('用例：本次没有改动')
  return { kind: 'api-save', title: '保存接口定义', lines, caseDiff: diff }
}

/** 用例差异的展示文本，删除项单独标红由调用方处理。 */
export function formatApiApprovalCaseDiff(entry: ApiApprovalCaseDiff): string {
  return `${CHANGE_LABEL[entry.change]}：${entry.caseName}（${entry.source === 'agent' ? 'Agent' : '人工'}，${entry.assertionCount} 条断言）`
}
