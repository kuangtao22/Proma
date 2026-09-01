import {
  CANVAS_IPC_CHANNELS,
  DESIGN_IPC_CHANNELS,
  parseAgentCanvasBindingChangeEvent,
  parseCanvasChangeEvent,
  parseCanvasImageCandidateBatch,
  parseCanvasImageModuleSnapshot,
} from '@proma/shared'
import type {
  AgentCanvasBindingChangeEvent,
  ClearAgentCanvasBindingsInput,
  ClearAgentCanvasBindingsResult,
  CanvasChangeEvent,
  CanvasArtifactRevisionSummary,
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
  CanvasPublicError,
  CanvasSessionChangeEvent,
  CanvasSessionMeta,
  CanvasWorkspaceSnapshot,
  CanvasTextArtifactIdentity,
  CanvasTextArtifactMutationResult,
  CanvasTextArtifactSnapshot,
  CanvasTextArtifactTarget,
  CanvasWebviewSnapshot,
  CanvasWebviewTarget,
  CanvasWebviewPreviewSnapshot,
  CanvasWebviewPreviewTarget,
  LinkAgentCanvasInput,
  LinkAgentCanvasResult,
  ListAgentCanvasBindingsInput,
  ListAgentCanvasBindingsResult,
  CanvasAgentNodeCreationResult,
  CanvasAgentMessagesResult,
  CanvasAgentActiveRunSnapshot,
  CanvasNodeLifecycleResult,
  CanvasTrashEntry,
  CreateCanvasSessionInput,
  DeleteCanvasSessionInput,
  CreateCanvasAgentNodeInput,
  CreateCanvasContentNodeInput,
  DeleteCanvasNodeInput,
  AdoptCanvasTextArtifactRevisionInput,
  GetCanvasAgentMessagesInput,
  CreateDesignJobInput,
  DeleteDesignAssetInput,
  DeleteDesignContextInput,
  DesignCanvasDocument,
  DesignChangeEvent,
  DesignContextEntry,
  DesignImageModelSelection,
  DesignImageModelSelectionChangeEvent,
  DesignJobControlInput,
  DesignJobRecord,
  DesignTaskDetails,
  DesignWorkspaceSnapshot,
  ExportDesignAssetInput,
  ExportCanvasArtifactInput,
  EnsureLegacyCanvasSessionInput,
  GetDesignTaskDetailsInput,
  ImportAgentImageInput,
  ImportDesignContextDocumentInput,
  ImportDesignAssetsInput,
  ImageGenerationModelCatalogResult,
  ListCanvasSessionsInput,
  LoadCanvasInput,
  RebuildCanvasAgentNodeInput,
  RebuildCanvasAgentNodeResult,
  RestoreCanvasNodeInput,
  PrepareDesignAssetForSessionInput,
  PreparedDesignAssetMention,
  RelinkDesignAssetInput,
  RegisterDesignContextAssetInput,
  SaveDesignMutationsInput,
  SaveCanvasMutationsInput,
  SaveCanvasImageModuleInput,
  SendCanvasAgentMessageInput,
  SendCanvasAgentMessageResult,
  StopCanvasAgentInput,
  SetDefaultAgentCanvasInput,
  SetDefaultAgentCanvasResult,
  UnlinkAgentCanvasInput,
  UnlinkAgentCanvasResult,
  SaveImageGenerationModelProfilesInput,
  ListDesignContextInput,
  UpsertDesignContextDocumentInput,
  UpdateCanvasSessionInput,
  UpdateCanvasTextArtifactInput,
  UpdateDesignContextEntryInput,
  UpdateDesignImageModelSelectionInput,
} from '@proma/shared'
import type { IpcRendererEvent } from 'electron'

/** 创建 Canvas 图片任务时绑定配置 revision 的公开输入。 */
export interface CreateCanvasImageJobInput extends CanvasImageTarget {
  expectedConfigRevision: number
}

/** 采用 Canvas 图片任务输出时使用的公开输入。 */
export interface AdoptCanvasImageAssetInput extends CanvasImageJobControlInput {
  assetId: string
  expectedConfigRevision: number
}

/** Renderer 获得的稳定 Design API。 */
export interface DesignPreloadApi {
  /** 加载绑定精确正文 revision 的文档或 WebView 产物。 */
  loadCanvasTextArtifact: (input: CanvasTextArtifactTarget) => Promise<CanvasInvokeResult<CanvasTextArtifactSnapshot>>
  /** 在图与正文双重基线上提交新的文本产物修订。 */
  updateCanvasTextArtifact: (input: UpdateCanvasTextArtifactInput) => Promise<CanvasInvokeResult<CanvasTextArtifactMutationResult>>
  /** 列出文本产物的不可变修订摘要。 */
  listCanvasArtifactRevisions: (input: CanvasTextArtifactIdentity) => Promise<CanvasInvokeResult<CanvasArtifactRevisionSummary[]>>
  /** 把历史文本修订采用为节点当前版本。 */
  adoptCanvasArtifactRevision: (input: AdoptCanvasTextArtifactRevisionInput) => Promise<CanvasInvokeResult<CanvasTextArtifactMutationResult>>
  /** 通过主进程文件选择器导出文本或图片产物。 */
  exportCanvasArtifact: (input: ExportCanvasArtifactInput) => Promise<CanvasInvokeResult<void>>
  /** 加载单个 Canvas 生图模块及其媒体授权快照。 */
  loadCanvasImageModule: (input: CanvasImageTarget) => Promise<CanvasInvokeResult<CanvasImageModuleSnapshot>>
  /** 按批次稳定身份加载完整候选事实。 */
  getCanvasImageCandidateBatch: (input: GetCanvasImageCandidateBatchInput) => Promise<CanvasInvokeResult<CanvasImageCandidateBatch>>
  /** 重新运行批次中尚未成功的图片任务。 */
  continueCanvasImageCandidateBatch: (input: GetCanvasImageCandidateBatchInput) => Promise<CanvasInvokeResult<CanvasImageCandidateBatch>>
  /** 明确采用整批或成功候选。 */
  adoptCanvasImageCandidateBatch: (input: AdoptCanvasImageCandidateBatchInput) => Promise<CanvasInvokeResult<CanvasImageCandidateBatch>>
  /** 放弃活跃候选批次，但保留历史事实。 */
  abandonCanvasImageCandidateBatch: (input: GetCanvasImageCandidateBatchInput) => Promise<CanvasInvokeResult<CanvasImageCandidateBatch>>
  /** 使用配置 revision 保存单个 Canvas 生图模块。 */
  saveCanvasImageModule: (input: SaveCanvasImageModuleInput) => Promise<CanvasInvokeResult<CanvasImageModuleConfig>>
  /** 从当前固化配置创建 Canvas 图片任务。 */
  createCanvasImageJob: (input: CreateCanvasImageJobInput) => Promise<CanvasInvokeResult<DesignJobRecord>>
  /** 取消完整目标身份下的 Canvas 图片任务。 */
  cancelCanvasImageJob: (input: CanvasImageJobControlInput) => Promise<CanvasInvokeResult<DesignJobRecord>>
  /** 重试完整目标身份下的 Canvas 图片任务。 */
  retryCanvasImageJob: (input: CanvasImageJobControlInput) => Promise<CanvasInvokeResult<DesignJobRecord>>
  /** 将指定图片任务输出采用为模块当前素材。 */
  adoptCanvasImageAsset: (input: AdoptCanvasImageAssetInput) => Promise<CanvasInvokeResult<CanvasImageModuleConfig>>
  /** 释放当前窗口为指定图片模块持有的媒体授权。 */
  releaseCanvasImageMedia: (input: ReleaseCanvasImageMediaInput) => Promise<CanvasInvokeResult<void>>
  /** 订阅全部图片模块变化，只公开完整目标身份。 */
  onCanvasImageModuleChanged: (listener: (target: CanvasImageTarget) => void) => () => void
  /** 加载项目中指定原生 Canvas 的公开工作区快照。 */
  loadCanvasWorkspace: (input: LoadCanvasInput) => Promise<CanvasInvokeResult<CanvasWorkspaceSnapshot>>
  /** 加载单个 WebView 节点的受管 HTML 快照。 */
  loadCanvasWebview: (input: CanvasWebviewTarget) => Promise<CanvasInvokeResult<CanvasWebviewSnapshot>>
  /** 加载单个 WebView 节点的静态卡片预览。 */
  loadCanvasWebviewPreview: (input: CanvasWebviewPreviewTarget) => Promise<CanvasInvokeResult<CanvasWebviewPreviewSnapshot>>
  /** 在权威 revision 上保存指定原生 Canvas mutation。 */
  saveCanvasMutations: (input: SaveCanvasMutationsInput) => Promise<CanvasInvokeResult<CanvasDocument>>
  /** 在目标 Canvas 内幂等创建内部 Agent 节点。 */
  createCanvasAgentNode: (input: CreateCanvasAgentNodeInput) => Promise<CanvasInvokeResult<CanvasAgentNodeCreationResult>>
  /** 幂等创建一个受管内容节点。 */
  createCanvasContentNode: (input: CreateCanvasContentNodeInput) => Promise<CanvasInvokeResult<CanvasNodeLifecycleResult>>
  /** 通过通用生命周期入口删除任意节点。 */
  deleteCanvasNode: (input: DeleteCanvasNodeInput) => Promise<CanvasInvokeResult<CanvasNodeLifecycleResult>>
  /** 列出目标 Canvas 的可恢复内容节点。 */
  listCanvasTrash: (input: LoadCanvasInput) => Promise<CanvasInvokeResult<CanvasTrashEntry[]>>
  /** 从回收区恢复一个内容节点。 */
  restoreCanvasNode: (input: RestoreCanvasNodeInput) => Promise<CanvasInvokeResult<CanvasNodeLifecycleResult>>
  /** 为坏 Agent 节点重建空白内部会话。 */
  rebuildCanvasAgentNode: (input: RebuildCanvasAgentNodeInput) => Promise<CanvasInvokeResult<RebuildCanvasAgentNodeResult>>
  /** 仅在用户打开节点对话时读取该会话 JSONL。 */
  getCanvasAgentMessages: (input: GetCanvasAgentMessagesInput) => Promise<CanvasInvokeResult<CanvasAgentMessagesResult>>
  /** Renderer reload 时一次性恢复仍在运行的 Canvas Agent 归属。 */
  listActiveCanvasAgentRuns: () => Promise<CanvasAgentActiveRunSnapshot>
  /** 通过 Canvas 唯一入口发送纯文本消息。 */
  sendCanvasAgentMessage: (input: SendCanvasAgentMessageInput) => Promise<CanvasInvokeResult<SendCanvasAgentMessageResult>>
  /** 通过 Canvas 唯一入口停止节点运行。 */
  stopCanvasAgent: (input: StopCanvasAgentInput) => Promise<CanvasInvokeResult<void>>
  /** 订阅所有原生 Canvas 变化，双身份过滤由 Renderer adapter 执行。 */
  onCanvasChanged: (listener: (event: CanvasChangeEvent) => void) => () => void
  /** 列出当前项目内全部普通 Agent-Canvas 关联。 */
  listAgentCanvasBindings: (input: ListAgentCanvasBindingsInput) => Promise<CanvasInvokeResult<ListAgentCanvasBindingsResult>>
  /** 建立普通 Agent 与项目 Canvas 的关联。 */
  linkAgentCanvas: (input: LinkAgentCanvasInput) => Promise<CanvasInvokeResult<LinkAgentCanvasResult>>
  /** 解除普通 Agent 与项目 Canvas 的关联。 */
  unlinkAgentCanvas: (input: UnlinkAgentCanvasInput) => Promise<CanvasInvokeResult<UnlinkAgentCanvasResult>>
  /** 切换普通 Agent 的默认 Canvas。 */
  setDefaultAgentCanvas: (input: SetDefaultAgentCanvasInput) => Promise<CanvasInvokeResult<SetDefaultAgentCanvasResult>>
  /** 按普通 Agent 或 Canvas 清空关联。 */
  clearAgentCanvasBindings: (input: ClearAgentCanvasBindingsInput) => Promise<CanvasInvokeResult<ClearAgentCanvasBindingsResult>>
  /** 订阅严格解析后的 Agent-Canvas 关联变化。 */
  onAgentCanvasBindingChanged: (listener: (event: AgentCanvasBindingChangeEvent) => void) => () => void
  listCanvasSessions: (input: ListCanvasSessionsInput) => Promise<CanvasSessionMeta[]>
  ensureLegacyCanvasSession: (input: EnsureLegacyCanvasSessionInput) => Promise<CanvasSessionMeta>
  createCanvasSession: (input: CreateCanvasSessionInput) => Promise<CanvasSessionMeta>
  updateCanvasSession: (input: UpdateCanvasSessionInput) => Promise<CanvasSessionMeta>
  deleteCanvasSession: (input: DeleteCanvasSessionInput) => Promise<CanvasSessionMeta>
  onCanvasSessionChanged: (listener: (event: CanvasSessionChangeEvent) => void) => () => void
  listImageModelProfiles: () => Promise<ImageGenerationModelCatalogResult>
  saveImageModelProfiles: (input: SaveImageGenerationModelProfilesInput) => Promise<ImageGenerationModelCatalogResult>
  getImageModelSelection: (projectId: string) => Promise<DesignImageModelSelection>
  setImageModelSelection: (input: UpdateDesignImageModelSelectionInput) => Promise<DesignImageModelSelection>
  onImageModelProfilesChanged: (listener: () => void) => () => void
  onImageModelSelectionChanged: (listener: (event: DesignImageModelSelectionChangeEvent) => void) => () => void
  loadDesignWorkspace: (projectId: string) => Promise<DesignWorkspaceSnapshot>
  saveDesignMutations: (input: SaveDesignMutationsInput) => Promise<DesignCanvasDocument>
  importDesignAssets: (input: ImportDesignAssetsInput) => Promise<DesignWorkspaceSnapshot>
  deleteDesignAsset: (input: DeleteDesignAssetInput) => Promise<DesignCanvasDocument>
  relinkDesignAsset: (input: RelinkDesignAssetInput) => Promise<DesignCanvasDocument>
  exportDesignAsset: (input: ExportDesignAssetInput) => Promise<void>
  createDesignJob: (input: CreateDesignJobInput) => Promise<DesignJobRecord>
  cancelDesignJob: (input: DesignJobControlInput) => Promise<DesignJobRecord>
  retryDesignJob: (input: DesignJobControlInput) => Promise<DesignJobRecord>
  deleteDesignJob: (input: DesignJobControlInput) => Promise<DesignCanvasDocument>
  listDesignJobs: (projectId: string) => Promise<DesignJobRecord[]>
  getDesignTaskDetails: (input: GetDesignTaskDetailsInput) => Promise<DesignTaskDetails>
  getDesignTaskTrace: (input: GetDesignTaskDetailsInput) => Promise<DesignTaskDetails>
  listDesignContext: (input: ListDesignContextInput) => Promise<DesignContextEntry[]>
  upsertDesignContextDocument: (input: UpsertDesignContextDocumentInput) => Promise<DesignContextEntry>
  importDesignContextDocument: (input: ImportDesignContextDocumentInput) => Promise<DesignContextEntry | undefined>
  updateDesignContext: (input: UpdateDesignContextEntryInput) => Promise<DesignContextEntry>
  registerDesignContextAsset: (input: RegisterDesignContextAssetInput) => Promise<DesignContextEntry>
  deleteDesignContext: (input: DeleteDesignContextInput) => Promise<void>
  prepareDesignAssetForSession: (input: PrepareDesignAssetForSessionInput) => Promise<PreparedDesignAssetMention>
  importAgentImageToDesign: (input: ImportAgentImageInput) => Promise<DesignWorkspaceSnapshot>
  releaseDesignMediaAccess: () => Promise<void>
  onDesignChanged: (listener: (change: DesignChangeEvent) => void) => () => void
}

/** Design preload 工厂需要的最小 ipcRenderer 能力。 */
export interface DesignPreloadIpc {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, listener: (event: IpcRendererEvent, value: unknown) => void) => void
  removeListener: (channel: string, listener: (event: IpcRendererEvent, value: unknown) => void) => void
}

/** Preload 无法调用主进程时使用的固定 Canvas 公开失败。 */
const CANVAS_PRELOAD_FALLBACKS = {
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

/** 从 Renderer 输入中只拣选文本产物稳定身份。 */
function selectCanvasTextArtifactIdentity(input: CanvasTextArtifactIdentity): CanvasTextArtifactIdentity {
  return {
    projectId: input.projectId,
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    kind: input.kind,
    contentId: input.contentId,
  }
}

/** 从 Renderer 输入中只拣选文本产物精确读取目标。 */
function selectCanvasTextArtifactTarget(input: CanvasTextArtifactTarget): CanvasTextArtifactTarget {
  return { ...selectCanvasTextArtifactIdentity(input), contentRevision: input.contentRevision }
}

/** 从 Renderer 输入中只拣选文本产物更新字段。 */
function selectUpdateCanvasTextArtifactInput(input: UpdateCanvasTextArtifactInput): UpdateCanvasTextArtifactInput {
  return {
    ...selectCanvasTextArtifactIdentity(input),
    operationId: input.operationId,
    expectedCanvasRevision: input.expectedCanvasRevision,
    expectedContentRevision: input.expectedContentRevision,
    content: input.content,
  }
}

/** 从 Renderer 输入中只拣选历史修订采用字段。 */
function selectAdoptCanvasTextArtifactRevisionInput(
  input: AdoptCanvasTextArtifactRevisionInput,
): AdoptCanvasTextArtifactRevisionInput {
  return {
    ...selectCanvasTextArtifactIdentity(input),
    operationId: input.operationId,
    expectedCanvasRevision: input.expectedCanvasRevision,
    expectedContentRevision: input.expectedContentRevision,
    revision: input.revision,
  }
}

/** 从 Renderer 输入中只拣选无文件路径的公开导出身份。 */
function selectExportCanvasArtifactInput(input: ExportCanvasArtifactInput): ExportCanvasArtifactInput {
  return input.kind === 'image'
    ? {
        projectId: input.projectId,
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        kind: 'image',
        imageModuleId: input.imageModuleId,
        assetId: input.assetId,
      }
    : selectCanvasTextArtifactTarget(input)
}

/**
 * 从调用输入中只拣选 Canvas 图片模块公开目标字段。
 * @param input Renderer 提供的图片模块目标。
 * @returns 不含额外字段的四元公开目标。
 */
function selectCanvasImageTarget(input: CanvasImageTarget): CanvasImageTarget {
  return {
    projectId: input.projectId,
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    imageModuleId: input.imageModuleId,
  }
}

/** 从 Renderer 输入中只拣选图片候选批次稳定身份。 */
function selectCanvasImageCandidateBatchInput(
  input: GetCanvasImageCandidateBatchInput,
): GetCanvasImageCandidateBatchInput {
  return { projectId: input.projectId, canvasId: input.canvasId, batchId: input.batchId }
}

/** 调用候选批次 IPC，并在 Preload 边界严格重建成功值。 */
async function invokeCanvasImageCandidateBatchSafely(
  ipc: DesignPreloadIpc,
  channel: string,
  input: GetCanvasImageCandidateBatchInput | AdoptCanvasImageCandidateBatchInput,
): Promise<CanvasInvokeResult<CanvasImageCandidateBatch>> {
  const selected = 'mode' in input
    ? { ...selectCanvasImageCandidateBatchInput(input), mode: input.mode }
    : selectCanvasImageCandidateBatchInput(input)
  const result = await invokeCanvasSafely<CanvasImageCandidateBatch>(
    ipc,
    channel,
    selected,
    CANVAS_PRELOAD_FALLBACKS.imageBatch,
  )
  if (!result.ok) return result
  try {
    return { ok: true, value: parseCanvasImageCandidateBatch(result.value) }
  } catch {
    return { ok: false, error: { ...CANVAS_PRELOAD_FALLBACKS.imageBatch } }
  }
}

/** 从 Renderer 输入中只拣选 WebView 预览的公开完整身份。 */
function selectCanvasWebviewTarget(input: CanvasWebviewTarget): CanvasWebviewTarget {
  return {
    projectId: input.projectId,
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    prototypeId: input.prototypeId,
    contentRevision: input.contentRevision,
  }
}

/** 从 Renderer 输入中只拣选 WebView 静态预览公开身份。 */
function selectCanvasWebviewPreviewTarget(
  input: CanvasWebviewPreviewTarget,
): CanvasWebviewPreviewTarget {
  return {
    ...selectCanvasWebviewTarget(input),
    devicePreset: input.devicePreset,
  }
}

/**
 * 将未知图片变化 payload 映射为公开四元目标。
 * @param value Electron 事件携带的未知值。
 * @returns 字段完整时的公开目标，否则返回 null。
 */
function mapCanvasImageChange(value: unknown): CanvasImageTarget | null {
  /** 事件候选只读取公开字段，不向 Renderer 传递原对象。 */
  const candidate = value as Partial<CanvasImageTarget> | null
  if (!candidate
    || typeof candidate.projectId !== 'string'
    || typeof candidate.canvasId !== 'string'
    || typeof candidate.nodeId !== 'string'
    || typeof candidate.imageModuleId !== 'string') return null
  return selectCanvasImageTarget(candidate as CanvasImageTarget)
}

/**
 * 把底层释放函数包装为重复调用安全的取消函数。
 * @param release 只应执行一次的底层解绑操作。
 * @returns 可重复调用且最多解绑一次的函数。
 */
function makeIdempotentRelease(release: () => void): () => void {
  /** 记录当前订阅是否已完成解绑。 */
  let released = false
  return () => {
    if (released) return
    released = true
    release()
  }
}

/**
 * 捕获 Electron invoke rejection，并丢弃其路径、通道和堆栈正文。
 * @param ipc preload 可用的最小 ipcRenderer 能力。
 * @param channel 当前 Canvas invoke 通道。
 * @param input 已由 Renderer 构造的公开请求对象。
 * @param fallback 当前操作固定公开失败。
 * @returns 主进程安全结果，或 Preload 自行生成的固定失败。
 */
async function invokeCanvasSafely<T>(
  ipc: DesignPreloadIpc,
  channel: string,
  input: unknown,
  fallback: CanvasPublicError,
): Promise<CanvasInvokeResult<T>> {
  try {
    return await ipc.invoke(channel, input) as CanvasInvokeResult<T>
  } catch {
    return { ok: false, error: { ...fallback } }
  }
}

/** 在 Preload 跨进程入口严格重建图片模块成功快照。 */
async function invokeCanvasImageSnapshotSafely(
  ipc: DesignPreloadIpc,
  input: CanvasImageTarget,
): Promise<CanvasInvokeResult<CanvasImageModuleSnapshot>> {
  /** 先复用统一 rejection 清洗，再只解析成功业务值。 */
  const result = await invokeCanvasSafely<CanvasImageModuleSnapshot>(
    ipc,
    CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
    selectCanvasImageTarget(input),
    CANVAS_PRELOAD_FALLBACKS.imageLoad,
  )
  if (!result.ok) return result
  try {
    return { ok: true, value: parseCanvasImageModuleSnapshot(result.value) }
  } catch {
    return { ok: false, error: { ...CANVAS_PRELOAD_FALLBACKS.imageLoad } }
  }
}

/** 创建不暴露 ipcRenderer 本体的 Design preload API。 */
export function createDesignPreloadApi(ipc: DesignPreloadIpc): DesignPreloadApi {
  return {
    loadCanvasTextArtifact: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.LOAD_TEXT_ARTIFACT,
      selectCanvasTextArtifactTarget(input),
      CANVAS_PRELOAD_FALLBACKS.artifactLoad,
    ),
    updateCanvasTextArtifact: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.UPDATE_TEXT_ARTIFACT,
      selectUpdateCanvasTextArtifactInput(input),
      CANVAS_PRELOAD_FALLBACKS.artifactSave,
    ),
    listCanvasArtifactRevisions: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.LIST_ARTIFACT_REVISIONS,
      selectCanvasTextArtifactIdentity(input),
      CANVAS_PRELOAD_FALLBACKS.artifactLoad,
    ),
    adoptCanvasArtifactRevision: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.ADOPT_ARTIFACT_REVISION,
      selectAdoptCanvasTextArtifactRevisionInput(input),
      CANVAS_PRELOAD_FALLBACKS.artifactSave,
    ),
    exportCanvasArtifact: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.EXPORT_ARTIFACT,
      selectExportCanvasArtifactInput(input),
      CANVAS_PRELOAD_FALLBACKS.artifactExport,
    ),
    loadCanvasImageModule: (input) => invokeCanvasImageSnapshotSafely(ipc, input),
    getCanvasImageCandidateBatch: (input) => invokeCanvasImageCandidateBatchSafely(
      ipc, CANVAS_IPC_CHANNELS.GET_IMAGE_CANDIDATE_BATCH, input,
    ),
    continueCanvasImageCandidateBatch: (input) => invokeCanvasImageCandidateBatchSafely(
      ipc, CANVAS_IPC_CHANNELS.CONTINUE_IMAGE_CANDIDATE_BATCH, input,
    ),
    adoptCanvasImageCandidateBatch: (input) => invokeCanvasImageCandidateBatchSafely(
      ipc, CANVAS_IPC_CHANNELS.ADOPT_IMAGE_CANDIDATE_BATCH, input,
    ),
    abandonCanvasImageCandidateBatch: (input) => invokeCanvasImageCandidateBatchSafely(
      ipc, CANVAS_IPC_CHANNELS.ABANDON_IMAGE_CANDIDATE_BATCH, input,
    ),
    saveCanvasImageModule: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.SAVE_IMAGE_MODULE,
      {
        ...selectCanvasImageTarget(input),
        expectedConfigRevision: input.expectedConfigRevision,
        prompt: input.prompt,
        selectedModelProfileId: input.selectedModelProfileId,
        aspectRatio: input.aspectRatio,
        imageSize: input.imageSize,
        contextMode: input.contextMode,
      },
      CANVAS_PRELOAD_FALLBACKS.imageSave,
    ),
    createCanvasImageJob: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.CREATE_IMAGE_JOB,
      { ...selectCanvasImageTarget(input), expectedConfigRevision: input.expectedConfigRevision },
      CANVAS_PRELOAD_FALLBACKS.imageJob,
    ),
    cancelCanvasImageJob: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.CANCEL_IMAGE_JOB,
      { ...selectCanvasImageTarget(input), jobId: input.jobId },
      CANVAS_PRELOAD_FALLBACKS.imageJob,
    ),
    retryCanvasImageJob: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.RETRY_IMAGE_JOB,
      { ...selectCanvasImageTarget(input), jobId: input.jobId },
      CANVAS_PRELOAD_FALLBACKS.imageJob,
    ),
    adoptCanvasImageAsset: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.ADOPT_IMAGE_ASSET,
      {
        ...selectCanvasImageTarget(input),
        jobId: input.jobId,
        assetId: input.assetId,
        expectedConfigRevision: input.expectedConfigRevision,
      },
      CANVAS_PRELOAD_FALLBACKS.imageJob,
    ),
    releaseCanvasImageMedia: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.RELEASE_IMAGE_MEDIA,
      { ...selectCanvasImageTarget(input), mediaLeaseId: input.mediaLeaseId },
      CANVAS_PRELOAD_FALLBACKS.imageLoad,
    ),
    onCanvasImageModuleChanged: (listener) => {
      /** Electron event 被丢弃，只把映射后的完整公开目标交给 Renderer。 */
      const handler = (_event: IpcRendererEvent, value: unknown): void => {
        /** 公开目标映射失败时忽略该事件，避免半身份刷新错误模块。 */
        const target = mapCanvasImageChange(value)
        if (target) listener(target)
      }
      ipc.on(CANVAS_IPC_CHANNELS.IMAGE_MODULE_CHANGED, handler)
      return makeIdempotentRelease(() => {
        ipc.removeListener(CANVAS_IPC_CHANNELS.IMAGE_MODULE_CHANGED, handler)
      })
    },
    loadCanvasWorkspace: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.LOAD,
      input,
      CANVAS_PRELOAD_FALLBACKS.load,
    ),
    loadCanvasWebview: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.LOAD_WEBVIEW,
      selectCanvasWebviewTarget(input),
      CANVAS_PRELOAD_FALLBACKS.webviewLoad,
    ),
    loadCanvasWebviewPreview: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.LOAD_WEBVIEW_PREVIEW,
      selectCanvasWebviewPreviewTarget(input),
      CANVAS_PRELOAD_FALLBACKS.webviewPreview,
    ),
    saveCanvasMutations: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.SAVE_MUTATIONS,
      input,
      CANVAS_PRELOAD_FALLBACKS.save,
    ),
    createCanvasAgentNode: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
      input,
      CANVAS_PRELOAD_FALLBACKS.create,
    ),
    createCanvasContentNode: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE,
      input,
      CANVAS_PRELOAD_FALLBACKS.create,
    ),
    deleteCanvasNode: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.DELETE_NODE,
      input,
      CANVAS_PRELOAD_FALLBACKS.delete,
    ),
    listCanvasTrash: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.LIST_TRASH,
      input,
      CANVAS_PRELOAD_FALLBACKS.listTrash,
    ),
    restoreCanvasNode: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.RESTORE_NODE,
      input,
      CANVAS_PRELOAD_FALLBACKS.restore,
    ),
    rebuildCanvasAgentNode: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.REBUILD_AGENT_NODE,
      input,
      CANVAS_PRELOAD_FALLBACKS.rebuild,
    ),
    listActiveCanvasAgentRuns: () => ipc.invoke(
      CANVAS_IPC_CHANNELS.LIST_ACTIVE_AGENT_RUNS,
    ) as Promise<CanvasAgentActiveRunSnapshot>,
    getCanvasAgentMessages: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.GET_AGENT_MESSAGES,
      input,
      CANVAS_PRELOAD_FALLBACKS.messages,
    ),
    sendCanvasAgentMessage: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.SEND_AGENT_MESSAGE,
      input,
      CANVAS_PRELOAD_FALLBACKS.send,
    ),
    stopCanvasAgent: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.STOP_AGENT,
      input,
      CANVAS_PRELOAD_FALLBACKS.stop,
    ),
    onCanvasChanged: (listener) => {
      /** Electron event 对 Renderer 隐藏，只传原生 Canvas 业务变化。 */
      const handler = (_event: IpcRendererEvent, value: unknown): void => {
        let event: CanvasChangeEvent
        try {
          event = parseCanvasChangeEvent(value)
        } catch {
          /** 非法或过度暴露的来源事件不得进入 Renderer。 */
          return
        }
        listener(event)
      }
      ipc.on(CANVAS_IPC_CHANNELS.CHANGED, handler)
      return () => ipc.removeListener(CANVAS_IPC_CHANNELS.CHANGED, handler)
    },
    listAgentCanvasBindings: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.LIST_AGENT_BINDINGS,
      { projectId: input.projectId },
      CANVAS_PRELOAD_FALLBACKS.bindingList,
    ),
    linkAgentCanvas: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS,
      {
        projectId: input.projectId,
        sessionId: input.sessionId,
        canvasId: input.canvasId,
        makeDefault: input.makeDefault,
      },
      CANVAS_PRELOAD_FALLBACKS.binding,
    ),
    unlinkAgentCanvas: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.UNLINK_AGENT_CANVAS,
      { projectId: input.projectId, sessionId: input.sessionId, canvasId: input.canvasId },
      CANVAS_PRELOAD_FALLBACKS.binding,
    ),
    setDefaultAgentCanvas: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.SET_DEFAULT_AGENT_CANVAS,
      { projectId: input.projectId, sessionId: input.sessionId, canvasId: input.canvasId },
      CANVAS_PRELOAD_FALLBACKS.binding,
    ),
    clearAgentCanvasBindings: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.CLEAR_AGENT_BINDINGS,
      input.target === 'session'
        ? { projectId: input.projectId, target: input.target, sessionId: input.sessionId }
        : { projectId: input.projectId, target: input.target, canvasId: input.canvasId },
      CANVAS_PRELOAD_FALLBACKS.binding,
    ),
    onAgentCanvasBindingChanged: (listener) => {
      /** 未知事件先经过 shared exact-key parser，非法 payload 静默丢弃。 */
      const handler = (_event: IpcRendererEvent, value: unknown): void => {
        let parsed: AgentCanvasBindingChangeEvent
        try {
          parsed = parseAgentCanvasBindingChangeEvent(value)
        } catch {
          return
        }
        listener(parsed)
      }
      ipc.on(CANVAS_IPC_CHANNELS.AGENT_BINDINGS_CHANGED, handler)
      return makeIdempotentRelease(() => {
        ipc.removeListener(CANVAS_IPC_CHANNELS.AGENT_BINDINGS_CHANGED, handler)
      })
    },
    listCanvasSessions: (input) => ipc.invoke(
      DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS,
      input,
    ) as Promise<CanvasSessionMeta[]>,
    ensureLegacyCanvasSession: (input) => ipc.invoke(
      DESIGN_IPC_CHANNELS.ENSURE_LEGACY_CANVAS_SESSION,
      { projectId: input.projectId },
    ) as Promise<CanvasSessionMeta>,
    createCanvasSession: (input) => ipc.invoke(
      DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION,
      input,
    ) as Promise<CanvasSessionMeta>,
    updateCanvasSession: (input) => ipc.invoke(
      DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION,
      input,
    ) as Promise<CanvasSessionMeta>,
    deleteCanvasSession: (input) => ipc.invoke(
      DESIGN_IPC_CHANNELS.DELETE_CANVAS_SESSION,
      input,
    ) as Promise<CanvasSessionMeta>,
    onCanvasSessionChanged: (listener) => {
      /** Electron event 对 Renderer 隐藏，只传 Canvas 会话业务变化。 */
      const handler = (_event: IpcRendererEvent, value: unknown): void => (
        listener(value as CanvasSessionChangeEvent)
      )
      ipc.on(DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED, handler)
      return () => ipc.removeListener(DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED, handler)
    },
    listImageModelProfiles: () => ipc.invoke(DESIGN_IPC_CHANNELS.LIST_IMAGE_MODEL_PROFILES) as Promise<ImageGenerationModelCatalogResult>,
    saveImageModelProfiles: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.SAVE_IMAGE_MODEL_PROFILES, input) as Promise<ImageGenerationModelCatalogResult>,
    getImageModelSelection: (projectId) => ipc.invoke(DESIGN_IPC_CHANNELS.GET_IMAGE_MODEL_SELECTION, { projectId }) as Promise<DesignImageModelSelection>,
    setImageModelSelection: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.SET_IMAGE_MODEL_SELECTION, input) as Promise<DesignImageModelSelection>,
    onImageModelProfilesChanged: (listener) => {
      /** Electron event 和空 payload 都不向 Renderer 业务监听器暴露。 */
      const handler = (_event: IpcRendererEvent): void => listener()
      ipc.on(DESIGN_IPC_CHANNELS.IMAGE_MODEL_PROFILES_CHANGED, handler)
      return () => ipc.removeListener(DESIGN_IPC_CHANNELS.IMAGE_MODEL_PROFILES_CHANGED, handler)
    },
    onImageModelSelectionChanged: (listener) => {
      /** Electron event 对 Renderer 隐藏，只传项目选择变化。 */
      const handler = (_event: IpcRendererEvent, value: unknown): void => (
        listener(value as DesignImageModelSelectionChangeEvent)
      )
      ipc.on(DESIGN_IPC_CHANNELS.IMAGE_MODEL_SELECTION_CHANGED, handler)
      return () => ipc.removeListener(DESIGN_IPC_CHANNELS.IMAGE_MODEL_SELECTION_CHANGED, handler)
    },
    loadDesignWorkspace: (projectId) => ipc.invoke(DESIGN_IPC_CHANNELS.LOAD, { projectId }) as Promise<DesignWorkspaceSnapshot>,
    saveDesignMutations: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, input) as Promise<DesignCanvasDocument>,
    importDesignAssets: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.IMPORT_ASSETS, input) as Promise<DesignWorkspaceSnapshot>,
    deleteDesignAsset: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.DELETE_ASSET, input) as Promise<DesignCanvasDocument>,
    relinkDesignAsset: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.RELINK_ASSET, input) as Promise<DesignCanvasDocument>,
    exportDesignAsset: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.EXPORT_ASSET, input) as Promise<void>,
    createDesignJob: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.CREATE_JOB, input) as Promise<DesignJobRecord>,
    cancelDesignJob: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.CANCEL_JOB, input) as Promise<DesignJobRecord>,
    retryDesignJob: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.RETRY_JOB, input) as Promise<DesignJobRecord>,
    deleteDesignJob: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.DELETE_JOB, input) as Promise<DesignCanvasDocument>,
    listDesignJobs: (projectId) => ipc.invoke(DESIGN_IPC_CHANNELS.LIST_JOBS, { projectId }) as Promise<DesignJobRecord[]>,
    getDesignTaskDetails: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.GET_TASK_DETAILS, input) as Promise<DesignTaskDetails>,
    getDesignTaskTrace: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.GET_TASK_TRACE, input) as Promise<DesignTaskDetails>,
    listDesignContext: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.LIST_CONTEXT, input) as Promise<DesignContextEntry[]>,
    upsertDesignContextDocument: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.UPSERT_CONTEXT_DOCUMENT, input) as Promise<DesignContextEntry>,
    importDesignContextDocument: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.IMPORT_CONTEXT_DOCUMENT, input) as Promise<DesignContextEntry | undefined>,
    updateDesignContext: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.UPDATE_CONTEXT, input) as Promise<DesignContextEntry>,
    registerDesignContextAsset: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.REGISTER_CONTEXT_ASSET, input) as Promise<DesignContextEntry>,
    deleteDesignContext: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.DELETE_CONTEXT, input) as Promise<void>,
    prepareDesignAssetForSession: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.PREPARE_ASSET_FOR_SESSION, input) as Promise<PreparedDesignAssetMention>,
    importAgentImageToDesign: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.IMPORT_AGENT_IMAGE, input) as Promise<DesignWorkspaceSnapshot>,
    releaseDesignMediaAccess: () => ipc.invoke(DESIGN_IPC_CHANNELS.RELEASE_MEDIA_ACCESS) as Promise<void>,
    onDesignChanged: (listener) => {
      /** Electron event 对 renderer 隐藏，只传业务 change。 */
      const handler = (_event: IpcRendererEvent, value: unknown): void => listener(value as DesignChangeEvent)
      ipc.on(DESIGN_IPC_CHANNELS.CHANGED, handler)
      return () => ipc.removeListener(DESIGN_IPC_CHANNELS.CHANGED, handler)
    },
  }
}
