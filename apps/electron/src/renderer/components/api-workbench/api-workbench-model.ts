import type {
  ApiBodySlice,
  ApiCatalog,
  ApiCatalogSnapshot,
  ApiPreparedPreview,
  ApiRequestDraft,
  ApiRun,
  ApiValue,
  ApiWorkbenchApi,
} from '@proma/shared'
import {
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
  dirty: boolean
  saving: boolean
  sending: boolean
  preparedId?: string
  run?: ApiRun
  error?: string
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
  send: (tabId: string, request: ApiRequestDraft, requestId?: string, environmentId?: string) => Promise<ApiRun | null>
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
    send(tabId, request, requestId, environmentId) {
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
          const prepared = await api.prepare({ sessionId, request, ...(requestId ? { requestId } : {}), ...(environmentId ? { environmentId } : {}) })
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
