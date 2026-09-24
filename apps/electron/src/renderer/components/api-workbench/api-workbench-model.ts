import type {
  ApiAssertion,
  ApiBodySlice,
  ApiCatalog,
  ApiCatalogSnapshot,
  ApiCaseReportMeta,
  ApiCaseReportRow,
  ApiPreparedPreview,
  ApiRequestDraft,
  ApiRun,
  ApiTestCase,
  ApiValue,
  ApiWorkbenchApi,
} from '@proma/shared'
import {
  createApiCaseReportRow,
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

/** 创建一条用例；默认只跑请求、不做校验，用例身份由调用方生成。 */
export function createApiCase(id: string, name = '新用例'): ApiTestCase {
  return { id, name, assertions: [] }
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
