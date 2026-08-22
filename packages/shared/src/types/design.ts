/** Design 画布文档的当前 schema 版本。 */
export const DESIGN_DOCUMENT_VERSION = 1

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

/** Renderer 可提交的受控画布变更。 */
export type DesignMutation =
  | { type: 'set-viewport'; viewport: DesignViewport }
  | { type: 'move-nodes'; positions: Array<{ nodeId: string; position: DesignPoint }> }
  | { type: 'upsert-nodes'; nodes: DesignCanvasNode[] }
  | { type: 'remove-nodes'; nodeIds: string[] }
  | { type: 'upsert-assets'; assets: DesignAsset[] }
  | { type: 'remove-assets'; assetIds: string[] }
  | { type: 'upsert-groups'; groups: DesignGroup[] }
  | { type: 'remove-groups'; groupIds: string[] }
  | { type: 'upsert-annotations'; annotations: DesignAnnotation[] }
  | { type: 'remove-annotations'; annotationIds: string[] }

/** 一次图片生成或编辑任务的可恢复记录。 */
export interface DesignJobRecord {
  id: string
  projectId: string
  sessionId?: string
  action: DesignJobAction
  status: DesignJobStatus
  prompt: string
  sourceSessionId?: string
  sourceAssetId?: string
  parentAssetId?: string
  outputAssetId?: string
  error?: string
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
  sourceSessionId?: string
  sourceAssetId?: string
  maskAnnotationId?: string
  position: DesignPoint
}

export interface DesignJobControlInput {
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
  LOAD: 'design:load',
  SAVE_MUTATIONS: 'design:save-mutations',
  IMPORT_ASSETS: 'design:import-assets',
  DELETE_ASSET: 'design:delete-asset',
  EXPORT_ASSET: 'design:export-asset',
  RELINK_ASSET: 'design:relink-asset',
  CREATE_JOB: 'design:create-job',
  CANCEL_JOB: 'design:cancel-job',
  RETRY_JOB: 'design:retry-job',
  LIST_JOBS: 'design:list-jobs',
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
