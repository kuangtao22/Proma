import {
  parseCanvasArtifactRevisionSummary,
  parseCanvasImageCandidateBatch,
  parseCanvasImageModuleSnapshot,
  parseCanvasTextArtifactSnapshot,
  parseCanvasWorkspaceSnapshot,
} from '@proma/shared'
import type {
  AdoptCanvasTextArtifactRevisionInput,
  AgentCanvasBindingChangeEvent,
  CanvasArtifactRevisionSummary,
  ClearAgentCanvasBindingsInput,
  CanvasAgentMessagesResult,
  CanvasAgentNodeCreationResult,
  CanvasChangeEvent,
  CanvasDocument,
  CanvasImageJobControlInput,
  CanvasImageCandidateBatch,
  CanvasImageModuleConfig,
  CanvasImageModuleSnapshot,
  CanvasImageTarget,
  GetCanvasImageCandidateBatchInput,
  AdoptCanvasImageCandidateBatchInput,
  ReleaseCanvasImageMediaInput,
  CanvasInvokeResult,
  CanvasNodeLifecycleResult,
  CanvasPublicError,
  CanvasPublicErrorCode,
  CanvasTarget,
  CanvasTextArtifactIdentity,
  CanvasTextArtifactMutationResult,
  CanvasTextArtifactSnapshot,
  CanvasTextArtifactTarget,
  CanvasTrashEntry,
  CanvasSessionChangeEvent,
  CanvasWorkspaceSnapshot,
  CanvasWebviewSnapshot,
  CanvasWebviewTarget,
  CanvasWebviewPreviewSnapshot,
  CanvasWebviewPreviewTarget,
  LinkAgentCanvasInput,
  LinkAgentCanvasResult,
  ListAgentCanvasBindingsInput,
  ListAgentCanvasBindingsResult,
  CreateCanvasSessionInput,
  CreateCanvasAgentNodeInput,
  CreateCanvasContentNodeInput,
  DeleteCanvasNodeInput,
  DeleteCanvasSessionInput,
  GetCanvasAgentMessagesInput,
  CreateDesignJobInput,
  DeleteDesignAssetInput,
  DeleteDesignContextInput,
  DesignChangeEvent,
  DesignImageModelSelectionChangeEvent,
  DesignJobRecord,
  ExportDesignAssetInput,
  ExportCanvasArtifactInput,
  EnsureLegacyCanvasSessionInput,
  GetDesignTaskDetailsInput,
  ImportAgentImageInput,
  ImportDesignContextDocumentInput,
  ImportDesignAssetsInput,
  PrepareDesignAssetForSessionInput,
  RelinkDesignAssetInput,
  RegisterDesignContextAssetInput,
  SaveDesignMutationsInput,
  SaveImageGenerationModelProfilesInput,
  ListDesignContextInput,
  ListCanvasSessionsInput,
  LoadCanvasInput,
  RebuildCanvasAgentNodeInput,
  RebuildCanvasAgentNodeResult,
  RestoreCanvasNodeInput,
  SaveCanvasImageModuleInput,
  SaveCanvasMutationsInput,
  SendCanvasAgentMessageInput,
  SendCanvasAgentMessageResult,
  StopCanvasAgentInput,
  SetDefaultAgentCanvasInput,
  SetDefaultAgentCanvasResult,
  UnlinkAgentCanvasInput,
  UnlinkAgentCanvasResult,
  UpsertDesignContextDocumentInput,
  UpdateCanvasSessionInput,
  UpdateCanvasTextArtifactInput,
  UpdateDesignContextEntryInput,
  UpdateDesignImageModelSelectionInput,
} from '@proma/shared'
import type {
  AdoptCanvasImageAssetInput,
  CreateCanvasImageJobInput,
  DesignPreloadApi,
} from '../../preload/design-preload'

/** 测试和非 Electron 环境可注入的 Design API 子集。 */
export type PartialDesignApi = Partial<DesignPreloadApi>

/** Renderer 组件唯一使用的 Design 适配器。 */
export interface DesignAdapter {
  /** 加载绑定精确正文 revision 的文本产物。 */
  loadCanvasTextArtifact: (input: CanvasTextArtifactTarget) => Promise<CanvasTextArtifactSnapshot>
  /** 提交新的文档或 WebView 正文修订。 */
  updateCanvasTextArtifact: (input: UpdateCanvasTextArtifactInput) => Promise<CanvasTextArtifactMutationResult>
  /** 列出文本产物历史修订摘要。 */
  listCanvasArtifactRevisions: (input: CanvasTextArtifactIdentity) => Promise<CanvasArtifactRevisionSummary[]>
  /** 把历史修订采用为当前文本产物版本。 */
  adoptCanvasArtifactRevision: (input: AdoptCanvasTextArtifactRevisionInput) => Promise<CanvasTextArtifactMutationResult>
  /** 通过主进程文件选择器导出产物。 */
  exportCanvasArtifact: (input: ExportCanvasArtifactInput) => Promise<void>
  /** 加载单个 Canvas 生图模块公开快照。 */
  loadCanvasImageModule: (input: CanvasImageTarget) => Promise<CanvasImageModuleSnapshot>
  /** 加载一个完整图片候选批次。 */
  getCanvasImageCandidateBatch: (input: GetCanvasImageCandidateBatchInput) => Promise<CanvasImageCandidateBatch>
  /** 补齐批次中未成功的候选任务。 */
  continueCanvasImageCandidateBatch: (input: GetCanvasImageCandidateBatchInput) => Promise<CanvasImageCandidateBatch>
  /** 采用整批或成功候选。 */
  adoptCanvasImageCandidateBatch: (input: AdoptCanvasImageCandidateBatchInput) => Promise<CanvasImageCandidateBatch>
  /** 放弃活跃候选批次。 */
  abandonCanvasImageCandidateBatch: (input: GetCanvasImageCandidateBatchInput) => Promise<CanvasImageCandidateBatch>
  /** 保存单个 Canvas 生图模块配置。 */
  saveCanvasImageModule: (input: SaveCanvasImageModuleInput) => Promise<CanvasImageModuleConfig>
  /** 从当前模块配置创建图片任务。 */
  createCanvasImageJob: (input: CreateCanvasImageJobInput) => Promise<DesignJobRecord>
  /** 取消目标图片任务。 */
  cancelCanvasImageJob: (input: CanvasImageJobControlInput) => Promise<DesignJobRecord>
  /** 重试目标图片任务。 */
  retryCanvasImageJob: (input: CanvasImageJobControlInput) => Promise<DesignJobRecord>
  /** 采用目标任务的指定输出素材。 */
  adoptCanvasImageAsset: (input: AdoptCanvasImageAssetInput) => Promise<CanvasImageModuleConfig>
  /** 释放当前图片模块的媒体访问授权。 */
  releaseCanvasImageMedia: (input: ReleaseCanvasImageMediaInput) => Promise<void>
  /** 只向监听器传递四元身份完整匹配的图片模块事件。 */
  onCanvasImageModuleChanged: (
    target: CanvasImageTarget,
    listener: (event: CanvasImageTarget) => void,
  ) => ReturnType<DesignPreloadApi['onCanvasImageModuleChanged']>
  /** 加载目标原生 Canvas，避免与 legacy Design load 混淆。 */
  loadCanvas: (input: LoadCanvasInput) => Promise<CanvasWorkspaceSnapshot>
  /** 加载单个 WebView 节点的受管 HTML 快照。 */
  loadCanvasWebview: (input: CanvasWebviewTarget) => Promise<CanvasWebviewSnapshot>
  /** 加载 WebView 折叠卡片使用的受管静态预览。 */
  loadCanvasWebviewPreview: (input: CanvasWebviewPreviewTarget) => Promise<CanvasWebviewPreviewSnapshot>
  /** 保存目标原生 Canvas，避免与 legacy Design save 混淆。 */
  saveCanvas: (input: SaveCanvasMutationsInput) => Promise<CanvasDocument>
  /** 在目标 Canvas 内创建 Agent 节点并等待主进程 committed。 */
  createCanvasAgentNode: (input: CreateCanvasAgentNodeInput) => Promise<CanvasAgentNodeCreationResult>
  /** 创建受管图片、文档或原型节点。 */
  createCanvasContentNode: (input: CreateCanvasContentNodeInput) => Promise<CanvasNodeLifecycleResult>
  /** 统一删除 Agent 或内容节点。 */
  deleteCanvasNode: (input: DeleteCanvasNodeInput) => Promise<CanvasNodeLifecycleResult>
  /** 获取可恢复的内容节点列表。 */
  listCanvasTrash: (input: CanvasTarget) => Promise<CanvasTrashEntry[]>
  /** 从回收区恢复内容节点。 */
  restoreCanvasNode: (input: RestoreCanvasNodeInput) => Promise<CanvasNodeLifecycleResult>
  /** 为坏 Agent 节点重建空白内部会话。 */
  rebuildCanvasAgentNode: (input: RebuildCanvasAgentNodeInput) => Promise<RebuildCanvasAgentNodeResult>
  /** 按需加载节点引用会话的持久化消息。 */
  getCanvasAgentMessages: (input: GetCanvasAgentMessagesInput) => Promise<CanvasAgentMessagesResult>
  /** 发送 Canvas Agent 纯文本消息。 */
  sendCanvasAgentMessage: (input: SendCanvasAgentMessageInput) => Promise<SendCanvasAgentMessageResult>
  /** 停止 Canvas Agent 当前运行。 */
  stopCanvasAgent: (input: StopCanvasAgentInput) => Promise<void>
  /** 只向监听器传递项目与 Canvas 身份均匹配的事件。 */
  onCanvasChanged: (
    target: CanvasTarget,
    listener: (event: CanvasChangeEvent) => void,
  ) => ReturnType<DesignPreloadApi['onCanvasChanged']>
  /** 使用单个底层 Renderer listener 分派同项目内的 Canvas 集合事件。 */
  onCanvasChanges: (
    projectId: string,
    canvasIds: ReadonlySet<string>,
    listener: (event: CanvasChangeEvent) => void,
  ) => ReturnType<DesignPreloadApi['onCanvasChanged']>
  /** 列出目标项目的普通 Agent-Canvas 关联。 */
  listAgentCanvasBindings: (input: ListAgentCanvasBindingsInput) => Promise<ListAgentCanvasBindingsResult>
  /** 建立普通 Agent 与 Canvas 关联。 */
  linkAgentCanvas: (input: LinkAgentCanvasInput) => Promise<LinkAgentCanvasResult>
  /** 解除普通 Agent 与 Canvas 关联。 */
  unlinkAgentCanvas: (input: UnlinkAgentCanvasInput) => Promise<UnlinkAgentCanvasResult>
  /** 设置普通 Agent 默认 Canvas。 */
  setDefaultAgentCanvas: (input: SetDefaultAgentCanvasInput) => Promise<SetDefaultAgentCanvasResult>
  /** 按会话或 Canvas 清空关联。 */
  clearAgentCanvasBindings: (input: ClearAgentCanvasBindingsInput) => Promise<void>
  /** 只向监听器传递项目与 Agent 身份均匹配的事件。 */
  onAgentCanvasBindingChanged: (
    target: Pick<AgentCanvasBindingChangeEvent, 'projectId' | 'sessionId'>,
    listener: (event: AgentCanvasBindingChangeEvent) => void,
  ) => ReturnType<DesignPreloadApi['onAgentCanvasBindingChanged']>
  listCanvasSessions: (input: ListCanvasSessionsInput) => ReturnType<DesignPreloadApi['listCanvasSessions']>
  /** 幂等初始化旧 Design 文档并返回固定 Canvas 会话投影。 */
  ensureLegacyCanvasSession: (input: EnsureLegacyCanvasSessionInput) => ReturnType<DesignPreloadApi['ensureLegacyCanvasSession']>
  createCanvasSession: (input: CreateCanvasSessionInput) => ReturnType<DesignPreloadApi['createCanvasSession']>
  updateCanvasSession: (input: UpdateCanvasSessionInput) => ReturnType<DesignPreloadApi['updateCanvasSession']>
  deleteCanvasSession: (input: DeleteCanvasSessionInput) => ReturnType<DesignPreloadApi['deleteCanvasSession']>
  onCanvasSessionChanged: (listener: (event: CanvasSessionChangeEvent) => void) => ReturnType<DesignPreloadApi['onCanvasSessionChanged']>
  listImageModelProfiles: () => ReturnType<DesignPreloadApi['listImageModelProfiles']>
  saveImageModelProfiles: (input: SaveImageGenerationModelProfilesInput) => ReturnType<DesignPreloadApi['saveImageModelProfiles']>
  getImageModelSelection: (projectId: string) => ReturnType<DesignPreloadApi['getImageModelSelection']>
  setImageModelSelection: (input: UpdateDesignImageModelSelectionInput) => ReturnType<DesignPreloadApi['setImageModelSelection']>
  onImageModelProfilesChanged: (listener: () => void) => ReturnType<DesignPreloadApi['onImageModelProfilesChanged']>
  onImageModelSelectionChanged: (listener: (event: DesignImageModelSelectionChangeEvent) => void) => ReturnType<DesignPreloadApi['onImageModelSelectionChanged']>
  load: (projectId: string) => ReturnType<DesignPreloadApi['loadDesignWorkspace']>
  save: (input: SaveDesignMutationsInput) => ReturnType<DesignPreloadApi['saveDesignMutations']>
  importAssets: (input: ImportDesignAssetsInput) => ReturnType<DesignPreloadApi['importDesignAssets']>
  deleteAsset: (input: DeleteDesignAssetInput) => ReturnType<DesignPreloadApi['deleteDesignAsset']>
  relinkAsset: (input: RelinkDesignAssetInput) => ReturnType<DesignPreloadApi['relinkDesignAsset']>
  exportAsset: (input: ExportDesignAssetInput) => ReturnType<DesignPreloadApi['exportDesignAsset']>
  createJob: (input: CreateDesignJobInput) => ReturnType<DesignPreloadApi['createDesignJob']>
  cancelJob: (input: Parameters<DesignPreloadApi['cancelDesignJob']>[0]) => ReturnType<DesignPreloadApi['cancelDesignJob']>
  retryJob: (input: Parameters<DesignPreloadApi['retryDesignJob']>[0]) => ReturnType<DesignPreloadApi['retryDesignJob']>
  deleteJob: (input: Parameters<DesignPreloadApi['deleteDesignJob']>[0]) => ReturnType<DesignPreloadApi['deleteDesignJob']>
  listJobs: (projectId: string) => ReturnType<DesignPreloadApi['listDesignJobs']>
  getTaskDetails: (input: GetDesignTaskDetailsInput) => ReturnType<DesignPreloadApi['getDesignTaskDetails']>
  getTaskTrace: (input: GetDesignTaskDetailsInput) => ReturnType<DesignPreloadApi['getDesignTaskTrace']>
  listContext: (input: ListDesignContextInput) => ReturnType<DesignPreloadApi['listDesignContext']>
  upsertContextDocument: (input: UpsertDesignContextDocumentInput) => ReturnType<DesignPreloadApi['upsertDesignContextDocument']>
  importContextDocument: (input: ImportDesignContextDocumentInput) => ReturnType<DesignPreloadApi['importDesignContextDocument']>
  updateContext: (input: UpdateDesignContextEntryInput) => ReturnType<DesignPreloadApi['updateDesignContext']>
  registerContextAsset: (input: RegisterDesignContextAssetInput) => ReturnType<DesignPreloadApi['registerDesignContextAsset']>
  deleteContext: (input: DeleteDesignContextInput) => ReturnType<DesignPreloadApi['deleteDesignContext']>
  prepareAssetForSession: (input: PrepareDesignAssetForSessionInput) => ReturnType<DesignPreloadApi['prepareDesignAssetForSession']>
  importAgentImage: (input: ImportAgentImageInput) => ReturnType<DesignPreloadApi['importAgentImageToDesign']>
  releaseMediaAccess: () => ReturnType<DesignPreloadApi['releaseDesignMediaAccess']>
  onChanged: (listener: (change: DesignChangeEvent) => void) => ReturnType<DesignPreloadApi['onDesignChanged']>
}

/** 获取必需 preload 方法；缺失时给出稳定的集成错误。 */
function requireMethod<K extends keyof DesignPreloadApi>(api: PartialDesignApi, key: K): DesignPreloadApi[K] {
  const method = api[key]
  if (!method) throw new Error(`Design API 未接通: ${key}`)
  return method
}

/** Renderer 内只携带共享公开错误，不接受 Electron rejection 正文。 */
export class CanvasPublicOperationError extends Error {
  /**
   * 创建 Renderer 可安全展示和判别的 Canvas 错误。
   * @param code 共享公开错误码。
   * @param message 共享公开中文文案。
   */
  constructor(
    readonly code: CanvasPublicErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CanvasPublicOperationError'
  }
}

/** Adapter 无法调用 Preload 时使用的固定 Canvas 公开失败。 */
const CANVAS_ADAPTER_FALLBACKS = {
  artifactLoad: { code: 'CANVAS_ARTIFACT_LOAD_FAILED', message: '产物暂时无法加载。' },
  artifactSave: { code: 'CANVAS_ARTIFACT_SAVE_FAILED', message: '产物保存失败，请重试。' },
  artifactExport: { code: 'CANVAS_ARTIFACT_EXPORT_FAILED', message: '产物导出失败，请重试。' },
  imageLoad: { code: 'CANVAS_IMAGE_LOAD_FAILED', message: '生图节点暂时无法加载。' },
  imageSave: { code: 'CANVAS_IMAGE_SAVE_FAILED', message: '生图配置保存失败，请重试。' },
  imageJob: { code: 'CANVAS_IMAGE_JOB_FAILED', message: '图片任务操作失败，请重试。' },
  imageBatch: { code: 'CANVAS_IMAGE_BATCH_INVALID', message: '图片候选批次暂时无法处理。' },
  load: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
  webviewLoad: { code: 'CANVAS_WEBVIEW_LOAD_FAILED', message: '原型暂时无法加载。' },
  webviewPreview: { code: 'CANVAS_WEBVIEW_PREVIEW_FAILED', message: '原型预览生成失败，请重试。' },
  save: { code: 'CANVAS_SAVE_FAILED', message: '画布暂时无法保存。' },
  create: { code: 'CANVAS_CREATE_FAILED', message: '节点创建失败，请重试。' },
  delete: { code: 'CANVAS_DELETE_FAILED', message: '节点删除失败，请重试。' },
  listTrash: { code: 'CANVAS_CONTENT_INVALID', message: '回收区暂时无法加载。' },
  restore: { code: 'CANVAS_RESTORE_FAILED', message: '节点恢复失败，请重试。' },
  rebuild: { code: 'AGENT_SESSION_REBUILD_FAILED', message: '重建失败，请重试。' },
  messages: { code: 'CANVAS_AGENT_MESSAGES_FAILED', message: '会话消息暂时无法加载。' },
  send: { code: 'CANVAS_AGENT_SEND_FAILED', message: '消息发送失败，请重试。' },
  stop: { code: 'CANVAS_AGENT_STOP_FAILED', message: '停止 Agent 失败，请重试。' },
  bindingList: { code: 'CANVAS_BINDING_LIST_FAILED', message: '画布关联列表暂时无法加载。' },
  binding: { code: 'CANVAS_BINDING_FAILED', message: '画布关联失败，请重试。' },
} as const satisfies Record<string, CanvasPublicError>

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断对象是否只包含指定字段。 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** 比较两个文本产物稳定身份。 */
function matchesTextArtifactIdentity(
  actual: CanvasTextArtifactIdentity,
  expected: CanvasTextArtifactIdentity,
): boolean {
  return actual.projectId === expected.projectId
    && actual.canvasId === expected.canvasId
    && actual.nodeId === expected.nodeId
    && actual.kind === expected.kind
    && actual.contentId === expected.contentId
}

/** 比较两个文本产物精确读取目标。 */
function matchesTextArtifactTarget(
  actual: CanvasTextArtifactTarget,
  expected: CanvasTextArtifactTarget,
): boolean {
  return matchesTextArtifactIdentity(actual, expected)
    && actual.contentRevision === expected.contentRevision
}

/** 文本事务返回 revision 的操作语义约束。 */
interface TextArtifactRevisionExpectation {
  mode: 'greater-than' | 'exact'
  revision: number
}

/** 校验返回 snapshot 中同一文本节点已采用正文快照声明的 revision。 */
function snapshotAdoptsArtifactRevision(
  document: unknown,
  artifact: CanvasTextArtifactSnapshot,
): boolean {
  if (!isRecord(document) || !Array.isArray(document.nodes)) return false
  const node = document.nodes.find((candidate) => (
    isRecord(candidate)
    && candidate.id === artifact.target.nodeId
    && candidate.kind === artifact.target.kind
  ))
  if (!isRecord(node) || node.contentRevision !== artifact.target.contentRevision) return false
  return artifact.target.kind === 'document'
    ? node.documentId === artifact.target.contentId
    : node.prototypeId === artifact.target.contentId
}

/** 严格验证文本产物事务返回的图与正文身份。 */
function parseTextArtifactMutationResult(
  value: unknown,
  expected: CanvasTextArtifactIdentity,
  revisionExpectation: TextArtifactRevisionExpectation,
  expectedCanvasRevision: number,
): CanvasTextArtifactMutationResult {
  if (!isRecord(value)
    || !hasExactKeys(value, ['snapshot', 'artifact'])) {
    throw new Error('CANVAS_TEXT_ARTIFACT_MUTATION_RESULT_INVALID')
  }
  /** Shared parser 逐层重建公开 snapshot，避免 Renderer 重复一份浅校验合同。 */
  const snapshot = parseCanvasWorkspaceSnapshot(value.snapshot)
  const artifact = parseCanvasTextArtifactSnapshot(value.artifact)
  const document = snapshot.document
  /** update 允许跨越历史 max，adopt 则必须精确命中用户选择的修订。 */
  const revisionMatches = revisionExpectation.mode === 'greater-than'
    ? artifact.target.contentRevision > revisionExpectation.revision
    : artifact.target.contentRevision === revisionExpectation.revision
  if (!matchesTextArtifactIdentity(artifact.target, expected)
    || document.projectId !== expected.projectId
    || document.canvasId !== expected.canvasId
    || document.revision <= expectedCanvasRevision
    || !revisionMatches
    || !snapshotAdoptsArtifactRevision(document, artifact)) {
    throw new Error('CANVAS_TEXT_ARTIFACT_MUTATION_RESULT_INVALID')
  }
  return { snapshot, artifact }
}

/** 建立不会与其它节点或修订冲突的文本产物在途读取键。 */
function textArtifactKey(input: CanvasTextArtifactIdentity, revision?: number): string {
  return [
    input.projectId,
    input.canvasId,
    input.nodeId,
    input.kind,
    input.contentId,
    revision === undefined ? '' : String(revision),
  ].join('\0')
}

/**
 * 把订阅释放函数包装为重复调用安全的边界。
 * @param release Preload 返回的底层解绑函数。
 * @returns 最多执行一次底层解绑的释放函数。
 */
function makeIdempotentAdapterRelease(release: () => void): () => void {
  /** 标记该 adapter 订阅是否已释放。 */
  let released = false
  return () => {
    if (released) return
    released = true
    release()
  }
}

/**
 * 解包 Preload 安全结果，失败时只抛稳定公开错误。
 * @param result 主进程或 Preload 返回的安全结果信封。
 * @returns 成功信封中的业务值。
 */
function unwrapCanvasResult<T>(result: CanvasInvokeResult<T>): T {
  if (result.ok) return result.value
  throw new CanvasPublicOperationError(result.error.code, result.error.message)
}

/**
 * 执行一次 Canvas Preload 调用，并屏蔽缺失接线或意外 rejection 正文。
 * @param call 延迟执行的 Preload 方法调用。
 * @param fallback 当前操作的固定公开失败。
 * @returns 解包后的 Canvas 业务值。
 */
async function callCanvasApi<T>(
  call: () => Promise<CanvasInvokeResult<T>>,
  fallback: CanvasPublicError,
): Promise<T> {
  try {
    return unwrapCanvasResult(await call())
  } catch (error) {
    if (error instanceof CanvasPublicOperationError) throw error
    throw new CanvasPublicOperationError(fallback.code, fallback.message)
  }
}

/** 调用候选批次 API，并在 Renderer 边界再次严格重建返回值。 */
async function loadCanvasImageCandidateBatch(
  api: PartialDesignApi,
  method: 'getCanvasImageCandidateBatch'
    | 'continueCanvasImageCandidateBatch'
    | 'adoptCanvasImageCandidateBatch'
    | 'abandonCanvasImageCandidateBatch',
  input: GetCanvasImageCandidateBatchInput | AdoptCanvasImageCandidateBatchInput,
): Promise<CanvasImageCandidateBatch> {
  try {
    return parseCanvasImageCandidateBatch(await callCanvasApi(
      () => requireMethod(api, method)(input as never),
      CANVAS_ADAPTER_FALLBACKS.imageBatch,
    ))
  } catch (error) {
    if (error instanceof CanvasPublicOperationError) throw error
    throw new CanvasPublicOperationError(
      CANVAS_ADAPTER_FALLBACKS.imageBatch.code,
      CANVAS_ADAPTER_FALLBACKS.imageBatch.message,
    )
  }
}

/** 创建负责 Canvas 安全解包与 legacy Design 原样适配的 renderer adapter。 */
export function createDesignAdapter(api: PartialDesignApi): DesignAdapter {
  /** 只合并相同精确目标的在途正文读取，settle 后立即清理。 */
  const textArtifactLoads = new Map<string, Promise<CanvasTextArtifactSnapshot>>()
  /** 只合并相同稳定身份的在途修订列表读取，settle 后立即清理。 */
  const textArtifactRevisionLists = new Map<string, Promise<CanvasArtifactRevisionSummary[]>>()

  /** 加载并严格验证目标身份，避免旧节点响应覆盖当前工作台。 */
  const loadCanvasTextArtifact = (input: CanvasTextArtifactTarget): Promise<CanvasTextArtifactSnapshot> => {
    const key = textArtifactKey(input, input.contentRevision)
    const existing = textArtifactLoads.get(key)
    if (existing) return existing
    const pending = callCanvasApi(
      () => requireMethod(api, 'loadCanvasTextArtifact')(input),
      CANVAS_ADAPTER_FALLBACKS.artifactLoad,
    ).then((value) => {
      const parsed = parseCanvasTextArtifactSnapshot(value)
      if (!matchesTextArtifactTarget(parsed.target, input)) {
        throw new CanvasPublicOperationError(
          CANVAS_ADAPTER_FALLBACKS.artifactLoad.code,
          CANVAS_ADAPTER_FALLBACKS.artifactLoad.message,
        )
      }
      return parsed
    }).catch((error: unknown) => {
      if (error instanceof CanvasPublicOperationError) throw error
      throw new CanvasPublicOperationError(
        CANVAS_ADAPTER_FALLBACKS.artifactLoad.code,
        CANVAS_ADAPTER_FALLBACKS.artifactLoad.message,
      )
    }).finally(() => {
      if (textArtifactLoads.get(key) === pending) textArtifactLoads.delete(key)
    })
    textArtifactLoads.set(key, pending)
    return pending
  }

  /** 加载并严格验证同一产物的修订摘要列表。 */
  const listCanvasArtifactRevisions = (
    input: CanvasTextArtifactIdentity,
  ): Promise<CanvasArtifactRevisionSummary[]> => {
    const key = textArtifactKey(input)
    const existing = textArtifactRevisionLists.get(key)
    if (existing) return existing
    const pending = callCanvasApi(
      () => requireMethod(api, 'listCanvasArtifactRevisions')(input),
      CANVAS_ADAPTER_FALLBACKS.artifactLoad,
    ).then((values) => values.map((value) => {
      const parsed = parseCanvasArtifactRevisionSummary(value)
      if (parsed.kind !== input.kind || parsed.contentId !== input.contentId) {
        throw new Error('CANVAS_ARTIFACT_REVISION_IDENTITY_INVALID')
      }
      return parsed
    })).catch((error: unknown) => {
      if (error instanceof CanvasPublicOperationError) throw error
      throw new CanvasPublicOperationError(
        CANVAS_ADAPTER_FALLBACKS.artifactLoad.code,
        CANVAS_ADAPTER_FALLBACKS.artifactLoad.message,
      )
    }).finally(() => {
      if (textArtifactRevisionLists.get(key) === pending) textArtifactRevisionLists.delete(key)
    })
    textArtifactRevisionLists.set(key, pending)
    return pending
  }
  interface CanvasChangeSubscriber {
    projectId: string
    canvasIds: ReadonlySet<string>
    listener: (event: CanvasChangeEvent) => void
  }
  /** 同一 Renderer adapter 的全部 Canvas 消费者共享一个 Preload listener。 */
  const canvasChangeSubscribers = new Set<CanvasChangeSubscriber>()
  let releaseCanvasChangeSource: (() => void) | null = null

  /** 首个消费者挂载时建立底层监听，最后一个释放时由订阅释放函数关闭。 */
  const subscribeCanvasChanges = (
    projectId: string,
    canvasIds: ReadonlySet<string>,
    listener: (event: CanvasChangeEvent) => void,
  ): (() => void) => {
    const subscriber = { projectId, canvasIds: new Set(canvasIds), listener }
    canvasChangeSubscribers.add(subscriber)
    try {
      if (!releaseCanvasChangeSource) {
        releaseCanvasChangeSource = makeIdempotentAdapterRelease(requireMethod(api, 'onCanvasChanged')((event) => {
          for (const current of canvasChangeSubscribers) {
            if (current.projectId === event.projectId && current.canvasIds.has(event.canvasId)) current.listener(event)
          }
        }))
      }
    } catch (cause) {
      canvasChangeSubscribers.delete(subscriber)
      throw cause
    }
    return makeIdempotentAdapterRelease(() => {
      canvasChangeSubscribers.delete(subscriber)
      if (canvasChangeSubscribers.size > 0) return
      releaseCanvasChangeSource?.()
      releaseCanvasChangeSource = null
    })
  }

  return {
    loadCanvasTextArtifact,
    updateCanvasTextArtifact: async (input) => {
      try {
        return parseTextArtifactMutationResult(await callCanvasApi(
          () => requireMethod(api, 'updateCanvasTextArtifact')(input),
          CANVAS_ADAPTER_FALLBACKS.artifactSave,
        ), input, { mode: 'greater-than', revision: input.expectedContentRevision }, input.expectedCanvasRevision)
      } catch (error) {
        if (error instanceof CanvasPublicOperationError) throw error
        throw new CanvasPublicOperationError(
          CANVAS_ADAPTER_FALLBACKS.artifactSave.code,
          CANVAS_ADAPTER_FALLBACKS.artifactSave.message,
        )
      }
    },
    listCanvasArtifactRevisions,
    adoptCanvasArtifactRevision: async (input) => {
      try {
        return parseTextArtifactMutationResult(await callCanvasApi(
          () => requireMethod(api, 'adoptCanvasArtifactRevision')(input),
          CANVAS_ADAPTER_FALLBACKS.artifactSave,
        ), input, { mode: 'exact', revision: input.revision }, input.expectedCanvasRevision)
      } catch (error) {
        if (error instanceof CanvasPublicOperationError) throw error
        throw new CanvasPublicOperationError(
          CANVAS_ADAPTER_FALLBACKS.artifactSave.code,
          CANVAS_ADAPTER_FALLBACKS.artifactSave.message,
        )
      }
    },
    exportCanvasArtifact: (input) => callCanvasApi(
      () => requireMethod(api, 'exportCanvasArtifact')(input),
      CANVAS_ADAPTER_FALLBACKS.artifactExport,
    ),
    loadCanvasImageModule: async (input) => {
      try {
        /** Renderer 再次重建完整快照，避免测试注入或旧 Preload 绕过边界。 */
        return parseCanvasImageModuleSnapshot(await callCanvasApi(
          () => requireMethod(api, 'loadCanvasImageModule')(input),
          CANVAS_ADAPTER_FALLBACKS.imageLoad,
        ))
      } catch (error) {
        if (error instanceof CanvasPublicOperationError) throw error
        throw new CanvasPublicOperationError(
          CANVAS_ADAPTER_FALLBACKS.imageLoad.code,
          CANVAS_ADAPTER_FALLBACKS.imageLoad.message,
        )
      }
    },
    getCanvasImageCandidateBatch: (input) => loadCanvasImageCandidateBatch(
      api, 'getCanvasImageCandidateBatch', input,
    ),
    continueCanvasImageCandidateBatch: (input) => loadCanvasImageCandidateBatch(
      api, 'continueCanvasImageCandidateBatch', input,
    ),
    adoptCanvasImageCandidateBatch: (input) => loadCanvasImageCandidateBatch(
      api, 'adoptCanvasImageCandidateBatch', input,
    ),
    abandonCanvasImageCandidateBatch: (input) => loadCanvasImageCandidateBatch(
      api, 'abandonCanvasImageCandidateBatch', input,
    ),
    saveCanvasImageModule: (input) => callCanvasApi(
      () => requireMethod(api, 'saveCanvasImageModule')(input),
      CANVAS_ADAPTER_FALLBACKS.imageSave,
    ),
    createCanvasImageJob: (input) => callCanvasApi(
      () => requireMethod(api, 'createCanvasImageJob')(input),
      CANVAS_ADAPTER_FALLBACKS.imageJob,
    ),
    cancelCanvasImageJob: (input) => callCanvasApi(
      () => requireMethod(api, 'cancelCanvasImageJob')(input),
      CANVAS_ADAPTER_FALLBACKS.imageJob,
    ),
    retryCanvasImageJob: (input) => callCanvasApi(
      () => requireMethod(api, 'retryCanvasImageJob')(input),
      CANVAS_ADAPTER_FALLBACKS.imageJob,
    ),
    adoptCanvasImageAsset: (input) => callCanvasApi(
      () => requireMethod(api, 'adoptCanvasImageAsset')(input),
      CANVAS_ADAPTER_FALLBACKS.imageJob,
    ),
    releaseCanvasImageMedia: (input) => callCanvasApi(
      () => requireMethod(api, 'releaseCanvasImageMedia')(input),
      CANVAS_ADAPTER_FALLBACKS.imageLoad,
    ),
    onCanvasImageModuleChanged: (target, listener) => {
      /** 订阅完整图片目标，任一身份不符都不能触发当前工作台刷新。 */
      const release = requireMethod(api, 'onCanvasImageModuleChanged')((event) => {
        if (event.projectId === target.projectId
          && event.canvasId === target.canvasId
          && event.nodeId === target.nodeId
          && event.imageModuleId === target.imageModuleId) listener(event)
      })
      return makeIdempotentAdapterRelease(release)
    },
    loadCanvas: (input) => callCanvasApi(
      () => requireMethod(api, 'loadCanvasWorkspace')(input),
      CANVAS_ADAPTER_FALLBACKS.load,
    ),
    loadCanvasWebview: (input) => callCanvasApi(
      () => requireMethod(api, 'loadCanvasWebview')(input),
      CANVAS_ADAPTER_FALLBACKS.webviewLoad,
    ),
    loadCanvasWebviewPreview: (input) => callCanvasApi(
      () => requireMethod(api, 'loadCanvasWebviewPreview')(input),
      CANVAS_ADAPTER_FALLBACKS.webviewPreview,
    ),
    saveCanvas: (input) => callCanvasApi(
      () => requireMethod(api, 'saveCanvasMutations')(input),
      CANVAS_ADAPTER_FALLBACKS.save,
    ),
    createCanvasAgentNode: (input) => callCanvasApi(
      () => requireMethod(api, 'createCanvasAgentNode')(input),
      CANVAS_ADAPTER_FALLBACKS.create,
    ),
    createCanvasContentNode: (input) => callCanvasApi(
      () => requireMethod(api, 'createCanvasContentNode')(input),
      CANVAS_ADAPTER_FALLBACKS.create,
    ),
    deleteCanvasNode: (input) => callCanvasApi(
      () => requireMethod(api, 'deleteCanvasNode')(input),
      CANVAS_ADAPTER_FALLBACKS.delete,
    ),
    listCanvasTrash: (input) => callCanvasApi(
      () => requireMethod(api, 'listCanvasTrash')(input),
      CANVAS_ADAPTER_FALLBACKS.listTrash,
    ),
    restoreCanvasNode: (input) => callCanvasApi(
      () => requireMethod(api, 'restoreCanvasNode')(input),
      CANVAS_ADAPTER_FALLBACKS.restore,
    ),
    rebuildCanvasAgentNode: (input) => callCanvasApi(
      () => requireMethod(api, 'rebuildCanvasAgentNode')(input),
      CANVAS_ADAPTER_FALLBACKS.rebuild,
    ),
    getCanvasAgentMessages: (input) => callCanvasApi(
      () => requireMethod(api, 'getCanvasAgentMessages')(input),
      CANVAS_ADAPTER_FALLBACKS.messages,
    ),
    sendCanvasAgentMessage: (input) => callCanvasApi(
      () => requireMethod(api, 'sendCanvasAgentMessage')(input),
      CANVAS_ADAPTER_FALLBACKS.send,
    ),
    stopCanvasAgent: (input) => callCanvasApi(
      () => requireMethod(api, 'stopCanvasAgent')(input),
      CANVAS_ADAPTER_FALLBACKS.stop,
    ),
    onCanvasChanged: (target, listener) => subscribeCanvasChanges(
      target.projectId,
      new Set([target.canvasId]),
      listener,
    ),
    onCanvasChanges: subscribeCanvasChanges,
    listAgentCanvasBindings: (input) => callCanvasApi(
      () => requireMethod(api, 'listAgentCanvasBindings')(input),
      CANVAS_ADAPTER_FALLBACKS.bindingList,
    ),
    linkAgentCanvas: (input) => callCanvasApi(
      () => requireMethod(api, 'linkAgentCanvas')(input),
      CANVAS_ADAPTER_FALLBACKS.binding,
    ),
    unlinkAgentCanvas: (input) => callCanvasApi(
      () => requireMethod(api, 'unlinkAgentCanvas')(input),
      CANVAS_ADAPTER_FALLBACKS.binding,
    ),
    setDefaultAgentCanvas: (input) => callCanvasApi(
      () => requireMethod(api, 'setDefaultAgentCanvas')(input),
      CANVAS_ADAPTER_FALLBACKS.binding,
    ),
    clearAgentCanvasBindings: (input) => callCanvasApi(
      () => requireMethod(api, 'clearAgentCanvasBindings')(input),
      CANVAS_ADAPTER_FALLBACKS.binding,
    ),
    onAgentCanvasBindingChanged: (target, listener) => {
      const release = requireMethod(api, 'onAgentCanvasBindingChanged')((event) => {
        if (event.projectId === target.projectId && event.sessionId === target.sessionId) listener(event)
      })
      return makeIdempotentAdapterRelease(release)
    },
    listCanvasSessions: (input) => requireMethod(api, 'listCanvasSessions')(input),
    ensureLegacyCanvasSession: (input) => requireMethod(api, 'ensureLegacyCanvasSession')(input),
    createCanvasSession: (input) => requireMethod(api, 'createCanvasSession')(input),
    updateCanvasSession: (input) => requireMethod(api, 'updateCanvasSession')(input),
    deleteCanvasSession: (input) => requireMethod(api, 'deleteCanvasSession')(input),
    onCanvasSessionChanged: (listener) => requireMethod(api, 'onCanvasSessionChanged')(listener),
    listImageModelProfiles: () => requireMethod(api, 'listImageModelProfiles')(),
    saveImageModelProfiles: (input) => requireMethod(api, 'saveImageModelProfiles')(input),
    getImageModelSelection: (projectId) => requireMethod(api, 'getImageModelSelection')(projectId),
    setImageModelSelection: (input) => requireMethod(api, 'setImageModelSelection')(input),
    onImageModelProfilesChanged: (listener) => requireMethod(api, 'onImageModelProfilesChanged')(listener),
    onImageModelSelectionChanged: (listener) => requireMethod(api, 'onImageModelSelectionChanged')(listener),
    load: (projectId) => requireMethod(api, 'loadDesignWorkspace')(projectId),
    save: (input) => requireMethod(api, 'saveDesignMutations')(input),
    importAssets: (input) => requireMethod(api, 'importDesignAssets')(input),
    deleteAsset: (input) => requireMethod(api, 'deleteDesignAsset')(input),
    relinkAsset: (input) => requireMethod(api, 'relinkDesignAsset')(input),
    exportAsset: (input) => requireMethod(api, 'exportDesignAsset')(input),
    createJob: (input) => requireMethod(api, 'createDesignJob')(input),
    cancelJob: (input) => requireMethod(api, 'cancelDesignJob')(input),
    retryJob: (input) => requireMethod(api, 'retryDesignJob')(input),
    deleteJob: (input) => requireMethod(api, 'deleteDesignJob')(input),
    listJobs: (projectId) => requireMethod(api, 'listDesignJobs')(projectId),
    getTaskDetails: (input) => requireMethod(api, 'getDesignTaskDetails')(input),
    getTaskTrace: (input) => requireMethod(api, 'getDesignTaskTrace')(input),
    listContext: (input) => requireMethod(api, 'listDesignContext')(input),
    upsertContextDocument: (input) => requireMethod(api, 'upsertDesignContextDocument')(input),
    importContextDocument: (input) => requireMethod(api, 'importDesignContextDocument')(input),
    updateContext: (input) => requireMethod(api, 'updateDesignContext')(input),
    registerContextAsset: (input) => requireMethod(api, 'registerDesignContextAsset')(input),
    deleteContext: (input) => requireMethod(api, 'deleteDesignContext')(input),
    prepareAssetForSession: (input) => requireMethod(api, 'prepareDesignAssetForSession')(input),
    importAgentImage: (input) => requireMethod(api, 'importAgentImageToDesign')(input),
    releaseMediaAccess: () => requireMethod(api, 'releaseDesignMediaAccess')(),
    onChanged: (listener) => requireMethod(api, 'onDesignChanged')(listener),
  }
}

/** 浏览器运行时的默认 Design adapter，测试通过工厂注入替身。 */
export const designAdapter: DesignAdapter = createDesignAdapter(
  typeof window === 'undefined' ? {} : window.electronAPI,
)
