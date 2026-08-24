import { DESIGN_IPC_CHANNELS } from '@proma/shared'
import type {
  CreateDesignJobInput,
  DeleteDesignAssetInput,
  DesignCanvasDocument,
  DesignChangeEvent,
  DesignImageModelSelection,
  DesignImageModelSelectionChangeEvent,
  DesignJobControlInput,
  DesignJobRecord,
  DesignWorkspaceSnapshot,
  ExportDesignAssetInput,
  ImportAgentImageInput,
  ImportDesignAssetsInput,
  ImageGenerationModelCatalogResult,
  PrepareDesignAssetForSessionInput,
  PreparedDesignAssetMention,
  RelinkDesignAssetInput,
  SaveDesignMutationsInput,
  SaveImageGenerationModelProfilesInput,
  UpdateDesignImageModelSelectionInput,
} from '@proma/shared'
import type { IpcRendererEvent } from 'electron'

/** Renderer 获得的稳定 Design API。 */
export interface DesignPreloadApi {
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
  listDesignJobs: (projectId: string) => Promise<DesignJobRecord[]>
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

/** 创建不暴露 ipcRenderer 本体的 Design preload API。 */
export function createDesignPreloadApi(ipc: DesignPreloadIpc): DesignPreloadApi {
  return {
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
    listDesignJobs: (projectId) => ipc.invoke(DESIGN_IPC_CHANNELS.LIST_JOBS, { projectId }) as Promise<DesignJobRecord[]>,
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
