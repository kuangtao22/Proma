/** Design 画布文档的当前 schema 版本。 */
export const DESIGN_DOCUMENT_VERSION = 1

/** 生图配置名称保留充足展示空间，同时阻断无界粘贴放大配置、IPC 与任务 journal。 */
export const IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH = 128

/** 模型 ID 兼容供应商长路径格式，同时限制进入执行与历史记录的字符串规模。 */
export const IMAGE_GENERATION_MODEL_ID_MAX_LENGTH = 256

/** 画布上的二维坐标。 */
export interface DesignPoint {
  x: number
  y: number
}

/** 画布视口位置与缩放比例。 */
export interface DesignViewport extends DesignPoint {
  zoom: number
}

export type DesignNodeKind = 'asset' | 'job'
export type DesignJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type DesignJobAction = 'generate' | 'edit'
export type ImageGenerationExecutor = 'nano-banana' | 'openai-images'
export type DesignContextMode = 'auto' | 'project' | 'none'
export type DesignContextCategory =
  | 'brand'
  | 'product'
  | 'code'
  | 'character'
  | 'story'
  | 'scene'
  | 'continuity'
  | 'reference'
export type DesignTraceState = 'pending' | 'ready' | 'unavailable'
export type DesignExecutionSessionCleanupState = 'pending' | 'completed'

/** 生图模型 profile 共享的非敏感字段。 */
interface ImageGenerationModelProfileBase {
  id: string
  name: string
  modelId: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** 继续读取 Chat 工具凭据的 Nano Banana 兼容 profile。 */
export interface NanoBananaImageGenerationModelProfile extends ImageGenerationModelProfileBase {
  executor: 'nano-banana'
}

/** 引用现有渠道凭据的 OpenAI Images profile。 */
export interface OpenAIImagesGenerationModelProfile extends ImageGenerationModelProfileBase {
  executor: 'openai-images'
  channelId: string
}

/** 用户可配置的生图模型 profile。 */
export type ImageGenerationModelProfile =
  | NanoBananaImageGenerationModelProfile
  | OpenAIImagesGenerationModelProfile

/** Design 任务创建时固化的生图模型信息。 */
interface ImageGenerationModelSnapshotBase {
  profileId: string
  name: string
  modelId: string
}

/** Design 任务创建时固化的非敏感生图路由。 */
export type ImageGenerationModelSnapshot =
  | ImageGenerationModelSnapshotBase & {
      executor: 'nano-banana'
    }
  | ImageGenerationModelSnapshotBase & {
      executor: 'openai-images'
      channelId: string
    }

/** 项目选择器展示的生图模型及其当前可用性。 */
export type ImageGenerationModelOption =
  | Extract<ImageGenerationModelSnapshot, { executor: 'nano-banana' }> & {
      available: boolean
      unavailableReason?: string
    }
  | Extract<ImageGenerationModelSnapshot, { executor: 'openai-images' }> & {
      available: boolean
      unavailableReason?: string
    }

/** Renderer 可使用的清洗渠道选项，不包含 Base URL 或加密凭据。 */
export interface ImageGenerationChannelOption {
  channelId: string
  name: string
  available: boolean
  unavailableReason?: string
  models: Array<{ id: string; name: string }>
}

/** 生图模型配置目录及旧配置继承状态。 */
export interface ImageGenerationModelCatalogResult {
  profiles: ImageGenerationModelProfile[]
  channelOptions: ImageGenerationChannelOption[]
  inheritedFromLegacyConfig: boolean
  credentialsConfigured: boolean
}

/** 保存完整生图模型 profile 列表的输入。 */
export interface SaveImageGenerationModelProfilesInput {
  profiles: ImageGenerationModelProfile[]
}

/** 项目可选择的生图模型及当前选择状态。 */
export interface DesignImageModelSelection {
  projectId: string
  options: ImageGenerationModelOption[]
  selectedProfileId?: string
  invalidSelectedProfileId?: string
}

/** 更新项目生图模型选择的输入。 */
export interface UpdateDesignImageModelSelectionInput {
  projectId: string
  imageModelProfileId: string
}

/** 项目生图模型选择变化事件。 */
export interface DesignImageModelSelectionChangeEvent {
  projectId: string
}

/** 画布节点的持久化布局信息。 */
export interface DesignCanvasNode {
  id: string
  kind: DesignNodeKind
  position: DesignPoint
  width: number
  height: number
  zIndex: number
  assetId?: string
  jobId?: string
  groupId?: string
}

/** 项目中受管图片素材的元数据。 */
export interface DesignAsset {
  id: string
  filename: string
  relativePath: string
  thumbnailRelativePath: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  width: number
  height: number
  byteSize: number
  sha256: string
  createdAt: number
  sourceSessionId?: string
  sourceJobId?: string
  prompt?: string
  parentAssetId?: string
}

/** 一组关联画布节点。 */
export interface DesignGroup {
  id: string
  name: string
  nodeIds: string[]
}

/** 画布上的箭头或画笔蒙版批注。 */
export type DesignAnnotation =
  | {
      id: string
      kind: 'arrow'
      from: DesignPoint
      to: DesignPoint
      color: string
      width: number
      createdAt: number
    }
  | {
      id: string
      kind: 'mask'
      points: DesignPoint[]
      color: string
      width: number
      createdAt: number
    }

/** 单个项目完整的 Design 画布文档。 */
export interface DesignCanvasDocument {
  schemaVersion: typeof DESIGN_DOCUMENT_VERSION
  projectId: string
  revision: number
  viewport: DesignViewport
  nodes: DesignCanvasNode[]
  assets: DesignAsset[]
  groups: DesignGroup[]
  annotations: DesignAnnotation[]
  createdAt: number
  updatedAt: number
}

/** 局部有序 patch 中待写入实体及其目标数组索引。 */
export interface DesignIndexedEntity<T extends { id: string }> {
  entity: T
  index: number
}

/**
 * 先移除受影响 ID，再按目标索引插入局部实体。
 * @param current 当前有序实体数组。
 * @param removeIds 本次显式删除或替换的实体 ID。
 * @param upserts 携带目标绝对索引的新增或替换实体。
 * @returns 保持未受影响实体相对顺序的新数组。
 */
export function applyDesignEntityPatch<T extends { id: string }>(
  current: T[],
  removeIds: string[],
  upserts: Array<DesignIndexedEntity<T>>,
): T[] {
  /** upsert 同 ID 也先从基线移除，确保替换不会生成重复实体。 */
  const replacedIds = new Set([...removeIds, ...upserts.map((item) => item.entity.id)])
  /** 未受影响实体保持原始相对顺序。 */
  const next = current.filter((item) => !replacedIds.has(item.id))
  /** 同索引时保持 mutation 内顺序，确保应用结果确定。 */
  const orderedUpserts = upserts
    .map((item, order) => ({ ...item, order }))
    .sort((left, right) => left.index - right.index || left.order - right.order)
  for (const item of orderedUpserts) {
    /** 越界索引收敛到当前数组边界，运行时校验仍拒绝负数。 */
    const targetIndex = Math.min(item.index, next.length)
    next.splice(targetIndex, 0, item.entity)
  }
  return next
}

/** Renderer 可提交的受控画布变更。 */
export type DesignMutation =
  | { type: 'set-viewport'; viewport: DesignViewport }
  | { type: 'move-nodes'; positions: Array<{ nodeId: string; position: DesignPoint }> }
  | { type: 'upsert-nodes'; nodes: DesignCanvasNode[] }
  | { type: 'remove-nodes'; nodeIds: string[] }
  | { type: 'patch-nodes'; removeIds: string[]; upserts: Array<DesignIndexedEntity<DesignCanvasNode>> }
  | { type: 'upsert-assets'; assets: DesignAsset[] }
  | { type: 'remove-assets'; assetIds: string[] }
  | { type: 'upsert-groups'; groups: DesignGroup[] }
  | { type: 'remove-groups'; groupIds: string[] }
  | { type: 'patch-groups'; removeIds: string[]; upserts: Array<DesignIndexedEntity<DesignGroup>> }
  | { type: 'upsert-annotations'; annotations: DesignAnnotation[] }
  | { type: 'remove-annotations'; annotationIds: string[] }
  | { type: 'patch-annotations'; removeIds: string[]; upserts: Array<DesignIndexedEntity<DesignAnnotation>> }

/** 单次 Design 执行实际读取的创作上下文引用。 */
export interface DesignContextReference {
  id: string
  category: DesignContextCategory
  sourceKind: 'project-file' | 'context-document' | 'design-asset'
  label: string
  relativePath?: string
  assetId?: string
  purpose: string
  readAt: number
}

/** Design Job 列表可直接展示的轻量追踪摘要。 */
export interface DesignJobTraceSummary {
  contextReferences?: DesignContextReference[]
  designSummary?: string
  finalImagePrompt?: string
  rawThinkingAvailable?: boolean
  contextWarning?: string
}

/** 延迟读取的单条 Design 执行追踪。 */
export interface DesignTraceEntry {
  timestamp: number
  type: 'thinking' | 'context' | 'tool' | 'image' | 'validation' | 'status' | 'error'
  title: string
  content?: string
  toolName?: string
  isError?: boolean
}

/** 任务详情中单次执行尝试的公开信息。 */
export interface DesignTaskAttemptDetails {
  jobId: string
  attemptNumber: number
  status: DesignJobStatus
  startedAt?: number
  completedAt?: number
  error?: string
  traceState?: DesignTraceState
  designSummary?: string
  finalImagePrompt?: string
  rawThinkingAvailable?: boolean
}

/** Renderer 按需读取的 Design 创作任务详情。 */
export interface DesignTaskDetails {
  creativeTaskId: string
  currentJobId: string
  attempts: DesignTaskAttemptDetails[]
  traceState: DesignTraceState
  trace?: DesignTraceEntry[]
}

/** 一次图片生成或编辑任务的可恢复记录。 */
export interface DesignJobRecord extends DesignJobTraceSummary {
  id: string
  creativeTaskId: string
  attemptNumber: number
  projectId: string
  sessionId?: string
  action: DesignJobAction
  status: DesignJobStatus
  prompt: string
  originalRequest: string
  contextMode: DesignContextMode
  sourceAgentMessageId?: string
  imageModelSnapshot?: ImageGenerationModelSnapshot
  sourceSessionId?: string
  sourceAssetId?: string
  parentAssetId?: string
  outputAssetId?: string
  error?: string
  traceState?: DesignTraceState
  executionSessionCleanupState?: DesignExecutionSessionCleanupState
  startedAt?: number
  completedAt?: number
  createdAt: number
  updatedAt: number
}

/** Renderer 加载 Design 工作区后得到的完整快照。 */
export interface DesignWorkspaceSnapshot {
  document: DesignCanvasDocument
  writable: boolean
  readOnlyReason?: string
  assetBaseUrl?: string
  thumbnailBaseUrl?: string
  recoveredFrom?: 'tmp' | 'backup'
}

export interface SaveDesignMutationsInput {
  projectId: string
  expectedRevision: number
  mutations: DesignMutation[]
}

export interface ImportDesignAssetsInput {
  projectId: string
  expectedRevision: number
  viewportCenter: DesignPoint
}

export interface DeleteDesignAssetInput {
  projectId: string
  assetId: string
  expectedRevision: number
}

export interface ExportDesignAssetInput {
  projectId: string
  assetId: string
}

export interface RelinkDesignAssetInput {
  projectId: string
  assetId: string
  expectedRevision: number
}

export interface CreateDesignJobInput {
  projectId: string
  action: DesignJobAction
  prompt: string
  imageModelProfileId: string
  sourceSessionId?: string
  sourceAssetId?: string
  maskAnnotationId?: string
  position: DesignPoint
}

export interface DesignJobControlInput {
  projectId: string
  jobId: string
}

/** 按项目和执行尝试读取 Design 创作任务详情的输入。 */
export interface GetDesignTaskDetailsInput {
  projectId: string
  jobId: string
}

export interface PrepareDesignAssetForSessionInput {
  projectId: string
  assetId: string
  sessionId: string
}

export interface PreparedDesignAssetMention {
  sessionId: string
  path: string
  name: string
  isDirectory: false
  scope: 'project'
}

export interface ImportAgentImageInput {
  projectId: string
  sessionId: string
  localPath: string
  position: DesignPoint
}

export type DesignChangeEvent = {
  projectId: string
  revision: number
  cause: 'canvas' | 'asset' | 'job' | 'recovery'
}

/** Design 专用 IPC 通道，避免与会话和文件预览通道混用。 */
export const DESIGN_IPC_CHANNELS = {
  LIST_IMAGE_MODEL_PROFILES: 'design:list-image-model-profiles',
  SAVE_IMAGE_MODEL_PROFILES: 'design:save-image-model-profiles',
  GET_IMAGE_MODEL_SELECTION: 'design:get-image-model-selection',
  SET_IMAGE_MODEL_SELECTION: 'design:set-image-model-selection',
  IMAGE_MODEL_PROFILES_CHANGED: 'design:image-model-profiles-changed',
  IMAGE_MODEL_SELECTION_CHANGED: 'design:image-model-selection-changed',
  LOAD: 'design:load',
  SAVE_MUTATIONS: 'design:save-mutations',
  IMPORT_ASSETS: 'design:import-assets',
  DELETE_ASSET: 'design:delete-asset',
  EXPORT_ASSET: 'design:export-asset',
  RELINK_ASSET: 'design:relink-asset',
  CREATE_JOB: 'design:create-job',
  CANCEL_JOB: 'design:cancel-job',
  RETRY_JOB: 'design:retry-job',
  DELETE_JOB: 'design:delete-job',
  LIST_JOBS: 'design:list-jobs',
  GET_TASK_DETAILS: 'design:get-task-details',
  GET_TASK_TRACE: 'design:get-task-trace',
  PREPARE_ASSET_FOR_SESSION: 'design:prepare-asset-for-session',
  IMPORT_AGENT_IMAGE: 'design:import-agent-image',
  RELEASE_MEDIA_ACCESS: 'design:release-media-access',
  CHANGED: 'design:changed',
} as const

/**
 * 为项目创建尚未落盘的空画布。
 * @param projectId 项目的稳定 ID。
 * @param now 创建时间，测试可传入固定值。
 * @returns revision 为 0 的初始画布文档。
 */
export function createEmptyDesignDocument(
  projectId: string,
  now = Date.now(),
): DesignCanvasDocument {
  return {
    schemaVersion: DESIGN_DOCUMENT_VERSION,
    projectId,
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    assets: [],
    groups: [],
    annotations: [],
    createdAt: now,
    updatedAt: now,
  }
}
