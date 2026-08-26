import type {
  CanvasAgentMessagesResult,
  CanvasAgentNodeCreationResult,
  CanvasChangeEvent,
  CanvasDocument,
  CanvasInvokeResult,
  CanvasPublicError,
  CanvasPublicErrorCode,
  CanvasTarget,
  CanvasSessionChangeEvent,
  CanvasWorkspaceSnapshot,
  CreateCanvasSessionInput,
  CreateCanvasAgentNodeInput,
  GetCanvasAgentMessagesInput,
  CreateDesignJobInput,
  DeleteDesignAssetInput,
  DeleteDesignContextInput,
  DesignChangeEvent,
  DesignImageModelSelectionChangeEvent,
  ExportDesignAssetInput,
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
  SaveCanvasMutationsInput,
  SendCanvasAgentMessageInput,
  SendCanvasAgentMessageResult,
  StopCanvasAgentInput,
  UpsertDesignContextDocumentInput,
  UpdateCanvasSessionInput,
  UpdateDesignContextEntryInput,
  UpdateDesignImageModelSelectionInput,
} from '@proma/shared'
import type { DesignPreloadApi } from '../../preload/design-preload'

/** 测试和非 Electron 环境可注入的 Design API 子集。 */
export type PartialDesignApi = Partial<DesignPreloadApi>

/** Renderer 组件唯一使用的 Design 适配器。 */
export interface DesignAdapter {
  /** 加载目标原生 Canvas，避免与 legacy Design load 混淆。 */
  loadCanvas: (input: LoadCanvasInput) => Promise<CanvasWorkspaceSnapshot>
  /** 保存目标原生 Canvas，避免与 legacy Design save 混淆。 */
  saveCanvas: (input: SaveCanvasMutationsInput) => Promise<CanvasDocument>
  /** 在目标 Canvas 内创建 Agent 节点并等待主进程 committed。 */
  createCanvasAgentNode: (input: CreateCanvasAgentNodeInput) => Promise<CanvasAgentNodeCreationResult>
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
  listCanvasSessions: (input: ListCanvasSessionsInput) => ReturnType<DesignPreloadApi['listCanvasSessions']>
  createCanvasSession: (input: CreateCanvasSessionInput) => ReturnType<DesignPreloadApi['createCanvasSession']>
  updateCanvasSession: (input: UpdateCanvasSessionInput) => ReturnType<DesignPreloadApi['updateCanvasSession']>
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
  load: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
  save: { code: 'CANVAS_SAVE_FAILED', message: '画布暂时无法保存。' },
  create: { code: 'CANVAS_CREATE_FAILED', message: '节点创建失败，请重试。' },
  rebuild: { code: 'AGENT_SESSION_REBUILD_FAILED', message: '重建失败，请重试。' },
  messages: { code: 'CANVAS_AGENT_MESSAGES_FAILED', message: '会话消息暂时无法加载。' },
  send: { code: 'CANVAS_AGENT_SEND_FAILED', message: '消息发送失败，请重试。' },
  stop: { code: 'CANVAS_AGENT_STOP_FAILED', message: '停止 Agent 失败，请重试。' },
} as const satisfies Record<string, CanvasPublicError>

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

/** 创建负责 Canvas 安全解包与 legacy Design 原样适配的 renderer adapter。 */
export function createDesignAdapter(api: PartialDesignApi): DesignAdapter {
  return {
    loadCanvas: (input) => callCanvasApi(
      () => requireMethod(api, 'loadCanvasWorkspace')(input),
      CANVAS_ADAPTER_FALLBACKS.load,
    ),
    saveCanvas: (input) => callCanvasApi(
      () => requireMethod(api, 'saveCanvasMutations')(input),
      CANVAS_ADAPTER_FALLBACKS.save,
    ),
    createCanvasAgentNode: (input) => callCanvasApi(
      () => requireMethod(api, 'createCanvasAgentNode')(input),
      CANVAS_ADAPTER_FALLBACKS.create,
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
    onCanvasChanged: (target, listener) => requireMethod(api, 'onCanvasChanged')((event) => {
      /** adapter 只隔离双重身份，revision 与 recovery 策略留给工作区 controller。 */
      if (event.projectId === target.projectId && event.canvasId === target.canvasId) listener(event)
    }),
    listCanvasSessions: (input) => requireMethod(api, 'listCanvasSessions')(input),
    createCanvasSession: (input) => requireMethod(api, 'createCanvasSession')(input),
    updateCanvasSession: (input) => requireMethod(api, 'updateCanvasSession')(input),
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
