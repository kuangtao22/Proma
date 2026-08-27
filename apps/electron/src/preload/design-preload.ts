import { CANVAS_IPC_CHANNELS, DESIGN_IPC_CHANNELS } from '@proma/shared'
import type {
  CanvasChangeEvent,
  CanvasDocument,
  CanvasInvokeResult,
  CanvasPublicError,
  CanvasSessionChangeEvent,
  CanvasSessionMeta,
  CanvasWorkspaceSnapshot,
  CanvasAgentNodeCreationResult,
  CanvasAgentMessagesResult,
  CanvasAgentActiveRunSnapshot,
  CanvasNodeLifecycleResult,
  CanvasTrashEntry,
  CreateCanvasSessionInput,
  CreateCanvasAgentNodeInput,
  CreateCanvasContentNodeInput,
  DeleteCanvasNodeInput,
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
  SendCanvasAgentMessageInput,
  SendCanvasAgentMessageResult,
  StopCanvasAgentInput,
  SaveImageGenerationModelProfilesInput,
  ListDesignContextInput,
  UpsertDesignContextDocumentInput,
  UpdateCanvasSessionInput,
  UpdateDesignContextEntryInput,
  UpdateDesignImageModelSelectionInput,
} from '@proma/shared'
import type { IpcRendererEvent } from 'electron'

/** Renderer 获得的稳定 Design API。 */
export interface DesignPreloadApi {
  /** 加载项目中指定原生 Canvas 的公开工作区快照。 */
  loadCanvasWorkspace: (input: LoadCanvasInput) => Promise<CanvasInvokeResult<CanvasWorkspaceSnapshot>>
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
  listCanvasSessions: (input: ListCanvasSessionsInput) => Promise<CanvasSessionMeta[]>
  createCanvasSession: (input: CreateCanvasSessionInput) => Promise<CanvasSessionMeta>
  updateCanvasSession: (input: UpdateCanvasSessionInput) => Promise<CanvasSessionMeta>
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
  load: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
  save: { code: 'CANVAS_SAVE_FAILED', message: '画布暂时无法保存。' },
  create: { code: 'CANVAS_CREATE_FAILED', message: '节点创建失败，请重试。' },
  delete: { code: 'CANVAS_DELETE_FAILED', message: '节点删除失败，请重试。' },
  listTrash: { code: 'CANVAS_CONTENT_INVALID', message: '回收区暂时无法加载。' },
  restore: { code: 'CANVAS_RESTORE_FAILED', message: '节点恢复失败，请重试。' },
  rebuild: { code: 'AGENT_SESSION_REBUILD_FAILED', message: '重建失败，请重试。' },
  messages: { code: 'CANVAS_AGENT_MESSAGES_FAILED', message: '会话消息暂时无法加载。' },
  send: { code: 'CANVAS_AGENT_SEND_FAILED', message: '消息发送失败，请重试。' },
  stop: { code: 'CANVAS_AGENT_STOP_FAILED', message: '停止 Agent 失败，请重试。' },
} as const satisfies Record<string, CanvasPublicError>

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

/** 创建不暴露 ipcRenderer 本体的 Design preload API。 */
export function createDesignPreloadApi(ipc: DesignPreloadIpc): DesignPreloadApi {
  return {
    loadCanvasWorkspace: (input) => invokeCanvasSafely(
      ipc,
      CANVAS_IPC_CHANNELS.LOAD,
      input,
      CANVAS_PRELOAD_FALLBACKS.load,
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
      const handler = (_event: IpcRendererEvent, value: unknown): void => (
        listener(value as CanvasChangeEvent)
      )
      ipc.on(CANVAS_IPC_CHANNELS.CHANGED, handler)
      return () => ipc.removeListener(CANVAS_IPC_CHANNELS.CHANGED, handler)
    },
    listCanvasSessions: (input) => ipc.invoke(
      DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS,
      input,
    ) as Promise<CanvasSessionMeta[]>,
    createCanvasSession: (input) => ipc.invoke(
      DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION,
      input,
    ) as Promise<CanvasSessionMeta>,
    updateCanvasSession: (input) => ipc.invoke(
      DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION,
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
