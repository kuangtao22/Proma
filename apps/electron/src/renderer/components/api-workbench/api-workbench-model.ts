import type {
  ApiAssertion,
  ApiBodySlice,
  ApiCatalog,
  ApiCatalogSnapshot,
  ApiCaseReportMeta,
  ApiCaseReportRow,
  ApiField,
  ApiPreparedPreview,
  ApiRequestDraft,
  ApiRequestBody,
  ApiRun,
  ApiTestCase,
  ApiValue,
  ApiWorkbenchApi,
} from '@proma/shared'
import {
  createApiCaseReportRow,
  createApiRequestDraft,
  describeApiCatalogSnapshot,
  detectApiWorkbenchImportKind,
  parseApiCatalogSnapshot,
  parseCurlCommands,
} from '@proma/shared'
import { formatServerOpsJsonLosslessly } from '@/components/server-ops/server-ops-json-formatter'

/** 工作台单个请求标签保存的编辑和执行状态。 */
export interface ApiWorkbenchRequestTab {
  id: string
  requestId?: string
  baseRevision?: number
  draft: ApiRequestDraft
  savedDraft: ApiRequestDraft | null
  /** 当前选中编辑的用例；未选中时「断言」页编辑请求自身的默认断言。 */
  activeCaseId?: string
  dirty: boolean
  saving: boolean
  sending: boolean
  preparedId?: string
  run?: ApiRun
  error?: string
}

/** 一次「跑全部用例」的汇总状态：报告行与抬头一起冻结，便于复制与逐条打开。 */
export interface ApiWorkbenchCaseBatch {
  tabId: string
  running: boolean
  rows: ApiCaseReportRow[]
  meta: ApiCaseReportMeta
}

/** 大正文已读取的连续字符范围。 */
export interface ApiWorkbenchBodyPage {
  text: string
  startOffset: number
  nextOffset: number | null
  totalChars: number
  truncated: boolean
}

/** 工作台执行控制器向标签投递的局部状态。 */
export interface ApiWorkbenchExecutionPatch {
  preparedId?: string
  run?: ApiRun
  sending?: boolean
  error?: string
}

/** 目录读写所需的最小 IPC 能力。 */
interface ApiCatalogApi {
  getCatalog: ApiWorkbenchApi['getCatalog']
  saveCatalog: ApiWorkbenchApi['saveCatalog']
}

/** 导入预览：粘贴内容已识别并通过合同校验后的只读结果。 */
export type ApiWorkbenchImportPreview =
  | { kind: 'curl'; drafts: ApiRequestDraft[]; unsupported: string[]; warnings: string[] }
  | {
    kind: 'catalog'
    snapshot: ApiCatalogSnapshot
    counts: { collections: number; environments: number; requests: number }
    emptiedSecrets: string[]
  }
  | { kind: 'error'; message: string }

/** 请求执行所需的最小 IPC 能力。 */
interface ApiExecutionApi {
  prepare: ApiWorkbenchApi['prepare']
  send: ApiWorkbenchApi['send']
  cancel: ApiWorkbenchApi['cancel']
}

/** 深拷贝请求草稿，避免复制标签之间共享可变行数组。 */
export function cloneApiRequestDraft(draft: ApiRequestDraft): ApiRequestDraft {
  return structuredClone(draft)
}

/** 取出共享层错误里面向用户的原因；不认识的前缀一律退回兜底文案。 */
function readableImportError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = error.message.replace(/^API_(?:CURL|IMPORT|SNAPSHOT)_INVALID:\s*/, '')
    if (message !== error.message && message.trim() !== '') return message
  }
  return fallback
}

/**
 * 识别并校验粘贴内容，供导入对话框预览。
 * @param text 用户粘贴的 cURL 文本或集合快照 JSON。
 * @returns 可直接用于导入的预览结果，失败时返回可读原因。
 */
export function previewApiWorkbenchImport(text: string): ApiWorkbenchImportPreview {
  if (detectApiWorkbenchImportKind(text) === 'catalog' || text.trim().startsWith('{')) {
    try {
      /** 已通过严格校验的快照。 */
      const snapshot = parseApiCatalogSnapshot(text)
      /** 导入前展示的增量与重填提示。 */
      const summary = describeApiCatalogSnapshot(snapshot)
      return { kind: 'catalog', snapshot, counts: summary.counts, emptiedSecrets: summary.emptiedSecrets }
    } catch (error) {
      return { kind: 'error', message: readableImportError(error, '集合快照无法导入') }
    }
  }
  try {
    return { kind: 'curl', ...parseCurlCommands(text) }
  } catch (error) {
    return { kind: 'error', message: readableImportError(error, '未找到可解析的 curl 命令') }
  }
}

/**
 * 为每个导入草稿建立独立编辑标签。
 * @param drafts 解析得到的请求草稿。
 * @param createId 标签 ID 生成器，便于测试注入。
 * @returns 未绑定已保存请求的编辑标签。
 */
export function createImportedRequestTabs(
  drafts: readonly ApiRequestDraft[],
  createId: () => string,
): ApiWorkbenchRequestTab[] {
  return drafts.map((draft) => createRequestTab(createId(), draft))
}

/** 目录栏宽度（像素）的可拖动范围：太窄放不下请求名，太宽会把编辑器挤没。 */
export const API_WORKBENCH_CATALOG_WIDTH = { min: 160, max: 460, step: 16, initial: 224 } as const
/** 请求区占上下分割的百分比范围：两侧都要留出可用的可视高度。 */
export const API_WORKBENCH_EDITOR_SHARE = { min: 25, max: 80, step: 4, initial: 58 } as const
/** 把目录栏宽度收敛到可拖动范围；非法输入回落到初始值而不是让布局塌掉。 */
export function clampApiWorkbenchCatalogWidth(value: number): number {
  if (!Number.isFinite(value)) return API_WORKBENCH_CATALOG_WIDTH.initial
  return Math.min(API_WORKBENCH_CATALOG_WIDTH.max, Math.max(API_WORKBENCH_CATALOG_WIDTH.min, Math.round(value)))
}
/** 把「请求区占多少百分比」收敛到可拖动范围。 */
export function clampApiWorkbenchEditorShare(value: number): number {
  if (!Number.isFinite(value)) return API_WORKBENCH_EDITOR_SHARE.initial
  return Math.min(API_WORKBENCH_EDITOR_SHARE.max, Math.max(API_WORKBENCH_EDITOR_SHARE.min, Math.round(value)))
}

/**
 * 把一个已保存请求移动到目标集合与分组（文件夹）。
 *
 * 只改归属，不碰任何内容字段：URL、参数、断言、用例都原样保留。
 * 目标集合不存在时返回原目录（界面只会在合法选项里选，这里兜住脏输入）。
 * @param catalog 当前目录。
 * @param requestId 要移动的请求。
 * @param target 目标集合与分组；分组为空字符串表示集合根目录。
 * @returns 移动后的新目录。
 */
export function moveApiRequest(catalog: ApiCatalog, requestId: string, target: { collectionId: string; folder: string }): ApiCatalog {
  if (!catalog.collections.some((collection) => collection.id === target.collectionId)) return catalog
  if (!catalog.requests.some((request) => request.id === requestId)) return catalog
  return {
    ...catalog,
    requests: catalog.requests.map((request) => request.id === requestId
      ? { ...request, collectionId: target.collectionId, folder: target.folder.trim() }
      : request),
  }
}

/** 创建一个独立请求编辑标签；未绑定已保存请求时默认标记为未保存。 */
export function createRequestTab(
  id: string,
  draft: ApiRequestDraft,
  requestId?: string,
  baseRevision?: number,
): ApiWorkbenchRequestTab {
  /** 标签自己的草稿副本。 */
  const clonedDraft = cloneApiRequestDraft(draft)
  return {
    id,
    ...(requestId ? { requestId } : {}),
    ...(baseRevision ? { baseRevision } : {}),
    draft: clonedDraft,
    savedDraft: requestId ? cloneApiRequestDraft(draft) : null,
    dirty: !requestId,
    saving: false,
    sending: false,
  }
}

/** 比较当前草稿与最近保存快照。 */
export function isApiRequestDirty(tab: ApiWorkbenchRequestTab): boolean {
  return tab.savedDraft === null || JSON.stringify(tab.draft) !== JSON.stringify(tab.savedDraft)
}

/** 历史载入的结果：可编辑草稿 + 必须重新填写的位置。 */
export interface ApiRunDraftResult {
  draft: ApiRequestDraft
  /** 被遮罩而必须重填的位置，例如「Header Authorization」「URL」。 */
  redacted: string[]
}

/** 两次运行对比里的一个标量字段。 */
export interface ApiRunDiffRow {
  label: string
  baseline: string
  candidate: string
  changed: boolean
}

/** 响应头差异；重复头按名称合并后比较。 */
export interface ApiRunHeaderDiff {
  name: string
  change: 'added' | 'removed' | 'changed'
  baseline: string
  candidate: string
}

/** 断言结论差异；按断言 id 对齐。 */
export interface ApiRunAssertionDiff {
  id: string
  baseline: string
  candidate: string
  changed: boolean
}

/** 正文逐行差异；无法逐行比较时 compared 为 false 并给出原因。 */
export interface ApiRunBodyDiff {
  compared: boolean
  reason?: string
  /** 只保留变化行，不重复相同的上下文。 */
  lines: Array<{ kind: 'added' | 'removed'; text: string }>
  /** 变化行超出展示上限时置真，界面据此提示。 */
  truncated: boolean
}

/** 一次运行对比的完整结果。 */
export interface ApiRunDiff {
  rows: ApiRunDiffRow[]
  headers: ApiRunHeaderDiff[]
  assertions: ApiRunAssertionDiff[]
  body: ApiRunBodyDiff
  /** 结构化字段、响应头、断言与正文全部一致。 */
  identical: boolean
}

/** 逐行对比的行数上限：两侧都超过就不再逐行比较，避免大正文拖垮界面。 */
const MAX_DIFF_SOURCE_LINES = 400
/** 变化行的展示上限。 */
const MAX_DIFF_OUTPUT_LINES = 200

/** 对比展示文本；不可观测时用短横线而不是 0。 */
function diffText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return String(value)
}

/** 最终跳转的响应头按名称小写合并重复值，保留出现顺序。 */
function headerValues(run: ApiRun): Map<string, string> {
  const merged = new Map<string, string[]>()
  for (const header of run.hops.at(-1)?.responseHeaders ?? []) {
    const key = header.name.toLowerCase()
    const existing = merged.get(key)
    if (existing) existing.push(header.value)
    else merged.set(key, [header.value])
  }
  return new Map([...merged].map(([name, values]) => [name, values.join(', ')]))
}

/**
 * 逐行差异：先去掉共同前后缀，再对小规模中段做 LCS。
 * @param baseline 基线正文按行拆分的数组。
 * @param candidate 对比正文按行拆分的数组。
 * @returns 只含变化行的差异序列。
 */
function diffBodyLines(baseline: readonly string[], candidate: readonly string[]): Array<{ kind: 'added' | 'removed'; text: string }> {
  /** 共同前缀不参与差异。 */
  let start = 0
  while (start < baseline.length && start < candidate.length && baseline[start] === candidate[start]) start += 1
  /** 共同后缀同样跳过。 */
  let baselineEnd = baseline.length
  let candidateEnd = candidate.length
  while (baselineEnd > start && candidateEnd > start && baseline[baselineEnd - 1] === candidate[candidateEnd - 1]) {
    baselineEnd -= 1
    candidateEnd -= 1
  }
  const left = baseline.slice(start, baselineEnd)
  const right = candidate.slice(start, candidateEnd)
  if (left.length === 0) return right.map((text) => ({ kind: 'added' as const, text }))
  if (right.length === 0) return left.map((text) => ({ kind: 'removed' as const, text }))
  /** LCS 长度表；中段规模已由调用方限制，因此这里是 O(n*m) 的有界计算。 */
  const table: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0))
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let column = right.length - 1; column >= 0; column -= 1) {
      table[row]![column] = left[row] === right[column]
        ? table[row + 1]![column + 1]! + 1
        : Math.max(table[row + 1]![column]!, table[row]![column + 1]!)
    }
  }
  const lines: Array<{ kind: 'added' | 'removed'; text: string }> = []
  let row = 0
  let column = 0
  while (row < left.length && column < right.length) {
    if (left[row] === right[column]) { row += 1; column += 1; continue }
    if (table[row + 1]![column]! >= table[row]![column + 1]!) {
      lines.push({ kind: 'removed', text: left[row]! })
      row += 1
    } else {
      lines.push({ kind: 'added', text: right[column]! })
      column += 1
    }
  }
  while (row < left.length) { lines.push({ kind: 'removed', text: left[row]! }); row += 1 }
  while (column < right.length) { lines.push({ kind: 'added', text: right[column]! }); column += 1 }
  return lines
}

/**
 * 比较两次运行，产出界面直接可用的差异事实。
 *
 * 两侧都应该是 `getRun` 的默认（脱敏）投影：被遮罩的秘密不会出现在差异里，也不需要 reveal。
 * @param baseline 作为参照的基线运行。
 * @param candidate 与基线对比的运行。
 * @returns 标量字段、响应头、断言与正文四部分差异。
 */
export function diffApiRuns(baseline: ApiRun, candidate: ApiRun): ApiRunDiff {
  /** 标量字段逐项比较；顺序固定，便于界面稳定阅读。 */
  const fields: Array<[string, string | number | null | undefined, string | number | null | undefined]> = [
    ['状态码', baseline.hops.at(-1)?.status ?? baseline.state, candidate.hops.at(-1)?.status ?? candidate.state],
    ['方法 URL', `${baseline.request.method} ${baseline.request.url}`, `${candidate.request.method} ${candidate.request.url}`],
    ['跳转数', baseline.hops.length, candidate.hops.length],
    ['内容类型', baseline.body.contentType, candidate.body.contentType],
    ['原始字节', baseline.body.rawBytes, candidate.body.rawBytes],
    ['解码字节', baseline.body.decodedBytes, candidate.body.decodedBytes],
    ['总耗时(ms)', baseline.hops.at(-1)?.timings.totalMs, candidate.hops.at(-1)?.timings.totalMs],
    ['事件数量', baseline.sse?.totalEvents, candidate.sse?.totalEvents],
    ['事件结束', baseline.sse?.endedReason, candidate.sse?.endedReason],
    ['用例', baseline.caseId, candidate.caseId],
    ['断言通过', `${baseline.assertions.filter((item) => item.passed).length}/${baseline.assertions.length}`, `${candidate.assertions.filter((item) => item.passed).length}/${candidate.assertions.length}`],
  ]
  const rows = fields.map(([label, before, after]) => ({
    label, baseline: diffText(before), candidate: diffText(after), changed: diffText(before) !== diffText(after),
  }))
  /** 响应头差异。 */
  const baselineHeaders = headerValues(baseline)
  const candidateHeaders = headerValues(candidate)
  const headers: ApiRunHeaderDiff[] = []
  for (const name of [...new Set([...baselineHeaders.keys(), ...candidateHeaders.keys()])].sort()) {
    const before = baselineHeaders.get(name)
    const after = candidateHeaders.get(name)
    if (before === after) continue
    headers.push({
      name,
      change: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
      baseline: before ?? '—',
      candidate: after ?? '—',
    })
  }
  /** 断言按 id 对齐；只保留结论变化的项。 */
  const baselineAssertions = new Map(baseline.assertions.map((item) => [item.id, item.passed]))
  const candidateAssertions = new Map(candidate.assertions.map((item) => [item.id, item.passed]))
  const text = (value: boolean | undefined): string => value === undefined ? '未执行' : value ? '通过' : '失败'
  const assertions: ApiRunAssertionDiff[] = []
  for (const id of [...new Set([...baselineAssertions.keys(), ...candidateAssertions.keys()])].sort()) {
    const before = baselineAssertions.get(id)
    const after = candidateAssertions.get(id)
    if (before === after) continue
    assertions.push({ id, baseline: text(before), candidate: text(after), changed: true })
  }
  /** 正文差异：行数超上限时明确说明无法逐行对比，不伪造结论。 */
  const baselineLines = baseline.body.preview === '' ? [] : baseline.body.preview.split('\n')
  const candidateLines = candidate.body.preview === '' ? [] : candidate.body.preview.split('\n')
  let body: ApiRunBodyDiff
  if (baseline.body.preview === candidate.body.preview) {
    body = { compared: true, lines: [], truncated: false }
  } else if (baselineLines.length > MAX_DIFF_SOURCE_LINES || candidateLines.length > MAX_DIFF_SOURCE_LINES) {
    body = { compared: false, reason: `正文超过逐行对比上限（${MAX_DIFF_SOURCE_LINES} 行），只显示结构化差异`, lines: [], truncated: false }
  } else {
    const lines = diffBodyLines(baselineLines, candidateLines)
    body = { compared: true, lines: lines.slice(0, MAX_DIFF_OUTPUT_LINES), truncated: lines.length > MAX_DIFF_OUTPUT_LINES }
  }
  return {
    rows,
    headers,
    assertions,
    body,
    identical: rows.every((row) => !row.changed) && headers.length === 0 && assertions.length === 0 && body.compared && body.lines.length === 0,
  }
}

/** 脱敏遮罩：Header/Query/正文里的取值，以及 URL 里的百分号编码形态。 */
const REDACTED_TEXT = '[REDACTED]'
const REDACTED_URL = '%5BREDACTED%5D'
/**
 * URL 里被遮罩的秘密用变量占位符还原：这个名字不可能是已声明变量，
 * 因此 prepare 会在解析阶段直接拒绝（fail closed），而不是把假值发出去。
 */
const REDACTED_PLACEHOLDER = '{{REDACTED_SECRET}}'

/**
 * 把一次运行的真实请求还原成未保存草稿。
 *
 * 运行记录里保存的是**已解析并脱敏**的请求，因此这里只做「还原可见事实 + 标出必须重填的位置」：
 * 被遮罩的取值一律不写回草稿（Header/Query 行留空并取消勾选，URL 与正文用无法解析的占位符提示），
 * 绝不把字面量 `[REDACTED]` 当成真值。用例、目标环境标记与自动 Cookie 属于原定义，不随快照复制。
 * @param run 历史运行（来自运行记录，秘密已被遮罩）。
 * @param catalog 当前目录，用于沿用原请求的集合归属。
 * @param createId 字段身份生成器，便于测试注入。
 * @returns 可直接打开为新标签的草稿，以及需要重新填写的位置列表。
 */
export function draftFromRun(run: ApiRun, catalog: ApiCatalog | null, createId: () => string): ApiRunDraftResult {
  /** 目录里仍在的原定义；只用来沿用集合归属，不复制它的用例与秘密。 */
  const definition = run.requestId ? catalog?.requests.find((item) => item.id === run.requestId) : undefined
  const collectionId = definition?.collectionId ?? catalog?.collections[0]?.id ?? 'default'
  /** 待重填位置，按出现顺序去重。 */
  const redacted: string[] = []
  const mark = (label: string): void => { if (!redacted.includes(label)) redacted.push(label) }
  /** 逐条还原 Header：被遮罩的取值留空并取消勾选，避免发出空值或假值。 */
  const headers: ApiField[] = run.request.headers.map((header) => {
    if (header.value !== REDACTED_TEXT) return { id: createId(), name: header.name, value: header.value, enabled: true }
    mark(`Header ${header.name}`)
    return { id: createId(), name: header.name, value: '', enabled: false }
  })
  /** Query 已经体现在解析后的 URL 上，拆回列表便于编辑。 */
  const query: ApiField[] = []
  let url = run.request.url
  try {
    const parsed = new URL(run.request.url)
    for (const [name, value] of parsed.searchParams) {
      if (value !== REDACTED_TEXT) { query.push({ id: createId(), name, value, enabled: true }); continue }
      mark(`Query ${name}`)
      query.push({ id: createId(), name, value: '', enabled: false })
    }
    /** 查询串已经拆成行，URL 只保留 origin + path + hash。 */
    const hash = parsed.hash
    parsed.search = ''
    parsed.hash = ''
    url = `${parsed.toString()}${hash}`
  } catch {
    mark('URL')
  }
  if (url.includes(REDACTED_TEXT) || url.includes(REDACTED_URL)) {
    mark('URL')
    url = url.replaceAll(REDACTED_TEXT, REDACTED_PLACEHOLDER).replaceAll(REDACTED_URL, REDACTED_PLACEHOLDER)
  }
  /** 正文同样只还原可见内容；被遮罩的片段用占位符标出。 */
  const contentType = run.request.headers.find((header) => header.name.toLowerCase() === 'content-type')?.value.toLowerCase() ?? ''
  let bodyText = run.request.body
  if (bodyText.includes(REDACTED_TEXT)) {
    mark('正文')
    bodyText = bodyText.replaceAll(REDACTED_TEXT, REDACTED_PLACEHOLDER)
  }
  const body: ApiRequestBody = bodyText === ''
    ? { kind: 'none', text: '', fields: [] }
    : contentType.includes('json')
      ? { kind: 'json', text: bodyText, fields: [] }
      : { kind: 'text', text: bodyText, fields: [] }
  return {
    draft: {
      ...createApiRequestDraft(collectionId),
      /** 名字必须能看出这是历史还原出来的草稿，避免被误当成已保存定义。 */
      name: `${run.requestName} · 历史还原`.slice(0, 128),
      method: run.request.method,
      url,
      query,
      headers,
      body,
      /** 鉴权已经体现在那次请求的 Header 里，这里不再重复配置。 */
      auth: { type: 'none', value: { value: '' } },
      timeoutMs: run.request.timeoutMs,
      followRedirects: run.request.followRedirects,
      maxRedirects: run.request.maxRedirects,
      assertions: [],
      extractions: [],
      cases: [],
      useCookieJar: false,
    },
    redacted,
  }
}

/** 编辑普通值或秘密值；空秘密输入保留已有 secretRef。 */
export function editApiValue(current: ApiValue, value: string, secret: boolean): ApiValue {
  if (!secret) return { value, secret: false }
  if (!value && current.secretRef) return { value: '', secret: true, secretRef: current.secretRef }
  return { value, secret: true }
}

/** 用户显式清除秘密后移除 secretRef，避免空输入被误当成轮换。 */
export function clearApiValue(_current: ApiValue): ApiValue {
  return { value: '', secret: false }
}

/** 用例来源的展示标签：界面徽标、审批卡与报告共用同一套说法。 */
export const API_CASE_SOURCE_LABEL: Record<'user' | 'agent', string> = { user: '人工', agent: 'Agent' }

/**
 * Cookie 过期时间的展示文本。
 * @param expiresAt 过期时间戳；会话 cookie 为 null。
 * @param now 当前时间，便于测试固定时间。
 * @returns 「会话 cookie」「已过期」或本地时间文本。
 */
export function formatCookieExpiry(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return '会话 cookie'
  if (expiresAt <= now) return '已过期'
  return new Date(expiresAt).toLocaleString()
}

/** 创建一条用例；默认只跑请求、不做校验，身份由调用方生成，来源固定为人工创建。 */
export function createApiCase(id: string, name = '新用例'): ApiTestCase {
  return { id, name, assertions: [], source: 'user' }
}

/** 判断用例是否由 Agent 声明；缺省视为人工创建，与解析器的默认值一致。 */
export function isAgentApiCase(testCase: Pick<ApiTestCase, 'source'>): boolean {
  return testCase.source === 'agent'
}

/** 读取当前编辑目标：选中用例时是用例的断言，未选中时是请求自身的默认断言。 */
export function draftAssertions(draft: ApiRequestDraft, caseId?: string): ApiAssertion[] {
  if (!caseId) return draft.assertions
  return (draft.cases ?? []).find((item) => item.id === caseId)?.assertions ?? draft.assertions
}

/**
 * 写回当前编辑目标的断言。
 * @param draft 当前草稿。
 * @param caseId 目标用例；为空表示请求自身的默认断言。
 * @param assertions 新的断言集合。
 * @returns 新草稿；用例已被删除时原样返回，避免把断言写到错误的位置。
 */
export function withDraftAssertions(draft: ApiRequestDraft, caseId: string | undefined, assertions: ApiAssertion[]): ApiRequestDraft {
  if (!caseId) return { ...draft, assertions }
  /** 目录中的全部用例，保持用户顺序。 */
  const cases = draft.cases ?? []
  if (!cases.some((item) => item.id === caseId)) return draft
  return { ...draft, cases: cases.map((item) => item.id === caseId ? { ...item, assertions } : item) }
}

/** 重命名用例；名称允许重复，身份保持稳定。 */
export function renameApiCase(draft: ApiRequestDraft, caseId: string, name: string): ApiRequestDraft {
  return { ...draft, cases: (draft.cases ?? []).map((item) => item.id === caseId ? { ...item, name } : item) }
}

/** 删除用例；用例级断言一并删除，其余用例顺序不变。 */
export function removeApiCase(draft: ApiRequestDraft, caseId: string): ApiRequestDraft {
  return { ...draft, cases: (draft.cases ?? []).filter((item) => item.id !== caseId) }
}

/**
 * 解析运行所属用例名，用于响应头部与历史列表。
 * @param run 运行记录。
 * @param draft 当前编辑草稿，未保存请求的用例只存在于这里。
 * @param catalog 已保存目录，历史运行按 requestId 回查。
 * @returns 用例名；运行不属于任何用例时返回 null；用例已删除时返回可读说明。
 */
export function resolveApiCaseName(run: ApiRun, draft: ApiRequestDraft | null, catalog: ApiCatalog | null): string | null {
  if (!run.caseId) return null
  /** 当前标签的草稿优先：未保存请求没有目录副本。 */
  const fromDraft = draft?.cases?.find((item) => item.id === run.caseId)
  if (fromDraft) return fromDraft.name
  /** 已保存请求按运行自身携带的 requestId 回查，不用当前标签猜测。 */
  const definition = run.requestId ? catalog?.requests.find((item) => item.id === run.requestId) : undefined
  return definition?.cases?.find((item) => item.id === run.caseId)?.name ?? '已删除的用例'
}

/** 顺序跑全部用例所需的注入点，便于对批量语义做纯函数回归。 */
export interface ApiCaseBatchOptions {
  /** 每个用例开始前与结束后询问是否已取消。 */
  isCancelled: () => boolean
  /** 没有产生运行记录时取可读原因（例如派发失败的错误码）。 */
  describeError: (caseId: string) => string | undefined
  /** 每次用例结束后回调最新的全部报告行。 */
  onProgress?: (rows: ApiCaseReportRow[]) => void
}

/**
 * 顺序执行请求上的全部用例，失败与未执行都留在报告里，便于一次看全。
 * @param cases 用例声明，顺序即执行顺序。
 * @param sendCase 执行单个用例并返回运行记录；取消或失败时返回 null。
 * @param options 取消判定、错误说明与进度回调。
 * @returns 全部用例的报告行；取消后不再发起后续请求，剩余用例标为已取消。
 */
export async function runAllApiCases(
  cases: readonly ApiTestCase[],
  sendCase: (caseId: string) => Promise<ApiRun | null>,
  options: ApiCaseBatchOptions,
): Promise<ApiCaseReportRow[]> {
  /** 已产出的报告行，顺序与用例顺序一致。 */
  const rows: ApiCaseReportRow[] = []
  for (const testCase of cases) {
    if (options.isCancelled()) {
      rows.push(createApiCaseReportRow(testCase, null, '已取消，未执行'))
      options.onProgress?.([...rows])
      continue
    }
    /** 该用例的运行记录；取消或失败时为 null。 */
    const run = await sendCase(testCase.id)
    rows.push(createApiCaseReportRow(testCase, run, run ? undefined : options.isCancelled() ? '已取消' : options.describeError(testCase.id)))
    options.onProgress?.([...rows])
  }
  return rows
}

/** 每次写目录前重新读取最新 revision，保留其它 Pane 的并发内容。 */
export async function saveCatalogWithLatestRevision(
  api: ApiCatalogApi,
  sessionId: string,
  update: (catalog: ApiCatalog) => ApiCatalog,
): Promise<ApiCatalog> {
  /** 保存开始时的最新目录。 */
  const latest = await api.getCatalog({ sessionId })
  /** 基于最新目录生成的下一版完整目录。 */
  const catalog = update(latest)
  return api.saveCatalog({ sessionId, expectedRevision: latest.revision, catalog })
}

/** 新增或替换请求；已有请求必须携带 Store 当前 revision，由 Host 决定是否递增。 */
export function upsertCatalogRequest(
  catalog: ApiCatalog,
  requestId: string,
  draft: ApiRequestDraft,
  now: number,
  expectedRequestRevision?: number,
): ApiCatalog {
  /** 目录中的并发最新版本。 */
  const existing = catalog.requests.find((request) => request.id === requestId)
  if (existing && expectedRequestRevision !== undefined && existing.revision !== expectedRequestRevision) {
    throw new Error('API_WORKBENCH_REQUEST_REVISION_CONFLICT')
  }
  /** 提交给 Store 的请求定义。 */
  const definition = {
    ...cloneApiRequestDraft(draft),
    id: requestId,
    revision: existing?.revision ?? 1,
    updatedAt: existing?.updatedAt ?? now,
  }
  return {
    ...catalog,
    requests: existing
      ? catalog.requests.map((request) => request.id === requestId ? definition : request)
      : [...catalog.requests, definition],
  }
}

/** 重命名一个集合下的精确文件夹，保持请求 revision 交由 Host 递增。 */
export function renameCatalogFolder(
  catalog: ApiCatalog,
  collectionId: string,
  folder: string,
  nextFolder: string,
  _now: number,
): ApiCatalog {
  return {
    ...catalog,
    requests: catalog.requests.map((request) => request.collectionId === collectionId && request.folder === folder
      ? { ...request, folder: nextFolder }
      : request),
  }
}

/** 追加一页正文，仅接受与当前范围连续的分页结果。 */
export function appendBodySlice(
  current: ApiWorkbenchBodyPage | null,
  slice: ApiBodySlice,
): ApiWorkbenchBodyPage {
  if (current && slice.offset !== current.nextOffset) return current
  return {
    text: `${current?.text ?? ''}${slice.text}`,
    startOffset: current?.startOffset ?? slice.offset,
    nextOffset: slice.nextOffset,
    totalChars: slice.totalChars,
    truncated: slice.truncated,
  }
}

/** 响应正文格式化结果；JSON 只重排空白，不重序列化值。 */
export interface ApiResponseFormatResult {
  formatted: string
  valid: boolean
  limitation?: 'too-deep' | 'too-large'
}

/** 按 Content-Type 保真格式化响应正文。 */
export function formatApiResponseBody(source: string, contentType: string): ApiResponseFormatResult {
  if (!contentType.toLowerCase().includes('json')) return { formatted: source, valid: true }
  return formatServerOpsJsonLosslessly(source)
}

/** 创建 prepare/send/cancel 控制器，所有回写都携带原请求标签身份。 */
export function createApiWorkbenchController(
  api: ApiExecutionApi,
  sessionId: string,
  publish: (tabId: string, patch: ApiWorkbenchExecutionPatch) => void,
): {
  /** caseId 指定要跑测试用例；未指定时按请求自身的默认断言发送。 */
  send: (tabId: string, request: ApiRequestDraft, requestId?: string, environmentId?: string, caseId?: string) => Promise<ApiRun | null>
  cancel: (tabId: string) => Promise<void>
} {
  /** 单个标签当前 prepare/send 的完整生命周期。 */
  interface ActiveExecution {
    token: symbol
    prepared?: ApiPreparedPreview
    cancelRequested: boolean
    promise: Promise<ApiRun | null>
  }
  /** 每个标签从 prepare 开始即持有的单飞任务。 */
  const activeByTab = new Map<string, ActiveExecution>()
  return {
    /** 先固定请求快照，再发送同一个 preparedId。 */
    send(tabId, request, requestId, environmentId, caseId) {
      /** 双击与连续快捷键复用同一 prepare/send，不产生第二次副作用。 */
      const existing = activeByTab.get(tabId)
      if (existing) return existing.promise
      /** 当前发送代次只允许自己回写标签。 */
      const token = Symbol(tabId)
      publish(tabId, { sending: true, error: undefined })
      /** 当前单飞记录；prepare 迟到时仍可读取用户已经发出的取消意图。 */
      const active: ActiveExecution = { token, cancelRequested: false, promise: Promise.resolve<ApiRun | null>(null) }
      /** 完整单飞任务覆盖 prepare 到 send 终态。 */
      const promise = (async (): Promise<ApiRun | null> => {
        try {
          /** Host 生成的固定执行快照。 */
          const prepared = await api.prepare({ sessionId, request, ...(requestId ? { requestId } : {}), ...(environmentId ? { environmentId } : {}), ...(caseId ? { caseId } : {}) })
          if (active.cancelRequested) {
            /** prepare 尚未完成时的取消在取得合法身份后清理，且绝不进入 send。 */
            await api.cancel({ sessionId, preparedId: prepared.preparedId }).catch(() => undefined)
            return null
          }
          if (activeByTab.get(tabId)?.token !== token) return null
          active.prepared = prepared
          publish(tabId, { preparedId: prepared.preparedId, sending: true })
          /** 本次运行结果只投递给发起标签。 */
          const run = await api.send({ sessionId, preparedId: prepared.preparedId })
          if (activeByTab.get(tabId)?.token !== token) return null
          activeByTab.delete(tabId)
          publish(tabId, { run, preparedId: undefined, sending: false })
          return run
        } catch (error) {
          if (activeByTab.get(tabId)?.token !== token) return null
          activeByTab.delete(tabId)
          /** 对用户只暴露稳定错误文案。 */
          const message = error instanceof Error ? error.message : '请求执行失败'
          publish(tabId, { preparedId: undefined, sending: false, error: message })
          return null
        }
      })()
      active.promise = promise
      activeByTab.set(tabId, active)
      return promise
    },
    /** 取消当前标签的 prepare/send 单飞任务。 */
    async cancel(tabId) {
      /** 当前标签对应的 Host 准备身份。 */
      const active = activeByTab.get(tabId)
      if (!active) return
      active.cancelRequested = true
      activeByTab.delete(tabId)
      publish(tabId, { preparedId: undefined, sending: false })
      if (!active.prepared) return
      await api.cancel({ sessionId, preparedId: active.prepared.preparedId })
    },
  }
}
