import type {
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
  UpsertDesignContextDocumentInput,
  UpdateDesignContextEntryInput,
  UpdateDesignImageModelSelectionInput,
} from '@proma/shared'
import type { DesignPreloadApi } from '../../preload/design-preload'

/** 测试和非 Electron 环境可注入的 Design API 子集。 */
export type PartialDesignApi = Partial<DesignPreloadApi>

/** Renderer 组件唯一使用的 Design 适配器。 */
export interface DesignAdapter {
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

/** 创建只做类型收口和原样错误传播的 renderer adapter。 */
export function createDesignAdapter(api: PartialDesignApi): DesignAdapter {
  return {
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
