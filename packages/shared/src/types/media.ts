import type { MediaWorkflowDefinition } from './media-workflow'

/** 媒体产物类别，音乐归属 audio。 */
export type MediaKind = 'image' | 'video' | 'audio'

/** 主进程根据公开认证方式解析独立密文引用。 */
export type MediaConnectionAuth = { kind: 'none' } | { kind: 'bearer' } | { kind: 'header'; headerName: string }

/** 已启动的远程执行端点；云实例生命周期由独立 ComputeProvider 扩展。 */
export interface MediaConnection {
  id: string
  name: string
  driver: 'comfyui'
  baseUrl: string
  enabled: boolean
  /** 仅兼容旧文件；新连接全局共享，不参与项目授权。 */
  projectIds?: string[]
  /** ComfyUI 多用户身份，与 API 认证分开存储。 */
  comfyUser?: string
  /** 归档只影响新任务发现，历史运行保留连接身份。 */
  archivedAt?: number
  auth: MediaConnectionAuth
  credentialRef?: string
  revision: number
  instanceGeneration: string
  updatedAt: number
}

/** 不可变的 API 工作流版本，null 表示用户管理的公共模板。 */
export interface MediaWorkflowVersion {
  id: string
  name: string
  projectId: string | null
  revision: number
  hash: string
  definition: MediaWorkflowDefinition
  createdAt: number
}

/** 预设固定连接引用与工作流版本，不保存远端素材名或密钥。 */
export interface MediaProfile {
  id: string
  name: string
  revision: number
  connectionId: string
  workflowId: string
  workflowRevision: number
  mediaKind: MediaKind
  projectId: string
  enabled: boolean
  createdAt: number
}

/** 全局媒体目录公开快照，历史版本保留以支持恢复。 */
export interface MediaConfiguration {
  schemaVersion: 1 | 2
  revision: number
  connections: MediaConnection[]
  workflows: MediaWorkflowVersion[]
  profiles: MediaProfile[]
  /** 主进程保留旧实例及凭据版本，禁止向 Renderer 返回。 */
  connectionHistory?: MediaConnection[]
  /** 工作流归档不删除不可变版本。 */
  archivedWorkflowIds?: string[]
}

/** 项目和设置页的公开连接摘要，不提供凭据引用或其它项目授权清单。 */
export type MediaConnectionSummary = Pick<MediaConnection, 'id' | 'name' | 'driver' | 'enabled' | 'revision' | 'instanceGeneration'> & { credentialConfigured: boolean }

/** 项目作用域下可发现的媒体目录；发现不替代运行时 fresh 授权。 */
export interface MediaProjectCatalog {
  revision: number
  connections: MediaConnectionSummary[]
  workflows: Array<Omit<MediaWorkflowVersion, 'definition'>>
  profiles: MediaProfile[]
}

/** 用户显式保存连接时的一次性输入；credential 永不出现在读取响应。 */
export interface SaveMediaConnectionInput {
  id: string
  name: string
  driver: 'comfyui'
  baseUrl: string
  enabled: boolean
  /** 仅接受旧客户端兼容输入，新管理页面不提供项目范围。 */
  projectIds?: string[]
  comfyUser?: string
  auth: MediaConnectionAuth
  credential?: string
}

/** 保存工作流产生新版本，不原地修改历史图。 */
export interface SaveMediaWorkflowInput {
  id: string
  name: string
  projectId: string | null
  definition: MediaWorkflowDefinition
}

/** 保存预设产生新版本；projectId 控制可用范围。 */
export type SaveMediaProfileInput = Omit<MediaProfile, 'revision' | 'createdAt'>

/** 运行消费的不可变项目素材引用，不暴露本地路径或远端文件名。 */
export interface MediaAssetRef {
  assetId: string
  revision: number
  hash: string
  mediaKind: MediaKind
}

/** 不包含磁盘路径的统一媒体资产公共字段。 */
interface MediaAssetRecordBase {
  id: string
  revision: 1
  hash: string
  filename: string
  byteSize: number
  mediaType: string
  createdAt: number
  sourceMediaRunId?: string
  sourceMediaOutputKey?: string
  sourceSessionId?: string
}

/** 图片、音频与视频的已探测技术元数据；未知视频帧率保持 null。 */
export type MediaAssetRecord = MediaAssetRecordBase & (
  | { mediaKind: 'image'; metadata: { width: number; height: number } }
  | { mediaKind: 'audio'; metadata: { durationMs: number; sampleRate: number; channels: number; codec: string } }
  | { mediaKind: 'video'; metadata: { width: number; height: number; durationMs: number; fps: number | null; codec: string; hasAudio: boolean } }
)

/** 文本/参数无需上传；媒体输入必须引用已获授权的项目资产。 */
export type MediaInputValue = { kind: 'scalar'; value: string | number | boolean } | { kind: 'asset'; asset: MediaAssetRef }

/** 媒体任务阶段与候选采用状态彼此独立。 */
export type MediaRunPhase = 'prepared' | 'uploading' | 'compiling' | 'submitting' | 'submission-unknown' | 'queued' | 'running' | 'collecting' | 'collection-failed' | 'succeeded' | 'failed' | 'cancel-requested' | 'cancelled'

/** 固定输出角色与实际登记的资产版本。 */
export interface MediaRunOutput {
  outputKey: string
  index: number
  asset: MediaAssetRef
}

/** 媒体运行冻结的定义来源；项目草稿无需伪装成已发布预设。 */
export type MediaRunSourceReference =
  | { kind: 'profile-version'; profileId: string; profileRevision: number }
  | {
      kind: 'project-draft-revision'
      workflowId: string
      workflowRevision: number
      connectionId: string
      mediaKind: MediaKind
    }

/** UI 与 Agent 共用的轻量任务投影，不包含凭据或内部路径。 */
export interface MediaRunSnapshot {
  id: string
  projectId: string
  revision: number
  phase: MediaRunPhase
  sourceRef?: MediaRunSourceReference
  /** 旧调用方兼容字段；draft 运行不提供伪造的 profile。 */
  profileId?: string
  profileRevision?: number
  createdAt: number
  updatedAt: number
  outputs: MediaRunOutput[]
  error: string | null
  progress: { nodeId: string; value: number; max: number } | null
}

/** 按窗口订阅项目过滤的运行事件；Job 关联只用于已有画布任务投影。 */
export interface MediaRunEvent { run: MediaRunSnapshot; designJobId?: string }

/** 一次明确生成意图；operationId 用于本地幂等，不是远端幂等保证。 */
export interface PrepareMediaRunInput {
  projectId: string
  operationId: string
  profileId: string
  profileRevision: number
  inputs: Record<string, MediaInputValue>
}

/** 管理窗口可见的配置快照，秘密及密文引用都不返回 Renderer。 */
export interface MediaSettingsSnapshot extends Omit<MediaConfiguration, 'connections' | 'connectionHistory'> {
  connections: Array<Omit<MediaConnection, 'credentialRef'> & { credentialConfigured: boolean }>
}

/** 已配置服务的探测事实，节点和模型目录的可用性分别报告。 */
export interface MediaConnectionProbe {
  connectionId: string
  checkedAt: number
  nodeCount: number
  modelFolders: string[]
  modelListing: 'available' | 'unsupported' | 'failed' | 'unknown'
  workflowListing?: MediaRemoteCapability
  assetListing?: MediaRemoteCapability
}

/** 每种资源来源独立探测，未知不得当作支持。 */
export type MediaRemoteCapability = 'available' | 'unsupported' | 'disabled' | 'authentication-required' | 'failed' | 'unknown'
/** 远端资源的真实接口来源。 */
export type MediaResourceSource = 'object-info' | 'models-api' | 'loader-schema' | 'user-data' | 'assets-api'
/** 资源是否有本地执行适配，区别于远端可见性。 */
export type MediaResourceSupport = 'supported' | 'unsupported' | 'unknown'
/** 设置与 Agent 共用的资源类别。 */
export type MediaResourceKind = 'nodes' | 'models' | 'workflows' | 'assets'
/** 远端文件身份固定到实例与用户，不使用显示名称寻址。 */
export interface MediaRemoteDescriptor {
  connectionId: string
  instanceGeneration: string
  remoteUser: string
  source: 'user-data' | 'assets-api'
  id: string
  workflowPath?: string
  assetId?: string
  filename?: string
  subfolder?: string
  type?: 'input' | 'output' | 'temp'
  loaderPath?: string
  contentHash?: string
}
/** 一条按来源清洗后的资源摘要。 */
export interface MediaResourceItem {
  id: string
  name: string
  category: string
  supported: boolean
  support?: MediaResourceSupport
  source?: MediaResourceSource
  schema?: import('./media-workflow').ComfyNodeSchema
  descriptor?: MediaRemoteDescriptor
  metadata?: Record<string, import('./media-workflow').JsonValue>
}
/** 读取远端工作流并明确区分 UI 图与可执行 API 图。 */
export interface MediaRemoteWorkflow {
  descriptor: MediaRemoteDescriptor
  format: 'ui' | 'api' | 'unknown'
  definition: import('./media-workflow').JsonObject
}
/** 设置页删除采用归档，不破坏历史恢复。 */
export interface ArchiveMediaConfigurationInput { kind: 'connection' | 'workflow'; id: string }

/** 从有界本地资源索引读取一页，避免把全量 schema 放进上下文。 */
export interface MediaResourceQuery {
  connectionId: string
  projectId?: string
  kind: MediaResourceKind
  query?: string
  folder?: string
  offset?: number
  limit?: number
  refresh?: boolean
}

/** 可追溯到实例 schema/模型目录的一页资源事实。 */
export interface MediaResourcePage {
  connectionId: string
  snapshotId: string
  checkedAt: number
  total: number
  nextOffset: number | null
  instanceGeneration?: string
  remoteUser?: string
  source?: MediaResourceSource
  capability?: MediaRemoteCapability
  /** 当前数据来自已保存快照，还是本次首次拉取/显式同步。 */
  snapshotOrigin?: 'local' | 'remote'
  /** 同步失败时保留上一份快照，并单独返回本次失败分类。 */
  syncError?: MediaRemoteCapability
  /** 模型快照中的完整目录，用于本地切换目录而无需测试连接。 */
  modelFolders?: string[]
  items: MediaResourceItem[]
}

/** 媒体管理与运行通道，主进程和 preload 共用常量。 */
export const MEDIA_IPC_CHANNELS = {
  GET_SETTINGS: 'media:get-settings', SAVE_CONNECTION: 'media:save-connection', SAVE_WORKFLOW: 'media:save-workflow', SAVE_PROFILE: 'media:save-profile',
  PROBE_CONNECTION: 'media:probe-connection', LIST_RESOURCES: 'media:list-resources', GET_RUN: 'media:get-run',
  GET_JOB_RUN: 'media:get-job-run', WATCH_PROJECT: 'media:watch-project', UNWATCH_PROJECT: 'media:unwatch-project', RUN_CHANGED: 'media:run-changed',
  ARCHIVE_CONFIGURATION: 'media:archive-configuration', READ_REMOTE_WORKFLOW: 'media:read-remote-workflow',
  READ_REMOTE_ASSET: 'media:read-remote-asset', IMPORT_LOCAL_ASSET: 'media:import-local-asset',
  LIST_ASSETS: 'media:list-assets',
} as const

/** 四层 IPC 的公开接口；运行写入口由 Canvas/Agent 授权 Host 接线。 */
export interface MediaPreloadApi {
  mediaGetSettings(): Promise<MediaSettingsSnapshot>
  mediaSaveConnection(input: SaveMediaConnectionInput, expectedRevision: number): Promise<MediaSettingsSnapshot>
  mediaSaveWorkflow(input: SaveMediaWorkflowInput, expectedRevision: number): Promise<MediaSettingsSnapshot>
  mediaSaveProfile(input: SaveMediaProfileInput, expectedRevision: number): Promise<MediaSettingsSnapshot>
  mediaProbeConnection(connectionId: string, projectId?: string): Promise<MediaConnectionProbe>
  mediaListResources(input: MediaResourceQuery): Promise<MediaResourcePage>
  mediaArchiveConfiguration(input: ArchiveMediaConfigurationInput, expectedRevision: number): Promise<MediaSettingsSnapshot>
  mediaReadRemoteWorkflow(descriptor: MediaRemoteDescriptor): Promise<MediaRemoteWorkflow>
  /** 仅显式预览时读取最多 16 MiB 的媒体字节，不暴露远端认证信息。 */
  mediaReadRemoteAsset(descriptor: MediaRemoteDescriptor): Promise<{ bytes: Uint8Array; contentType: string }>
  /** 主进程文件选择器授权一个媒体素材，取消返回 null。 */
  mediaImportLocalAsset(projectId: string, mediaKind: MediaKind): Promise<MediaAssetRecord | null>
  /** 只列出当前项目权威媒体素材的元信息，不读取文件正文。 */
  mediaListAssets(projectId: string): Promise<MediaAssetRecord[]>
  mediaGetRun(projectId: string, runId: string): Promise<MediaRunSnapshot>
  mediaGetJobRun(projectId: string, jobId: string): Promise<MediaRunSnapshot | null>
  mediaWatchProject(projectId: string): Promise<void>
  mediaUnwatchProject(projectId: string): Promise<void>
  onMediaRunChanged(callback: (event: MediaRunEvent) => void): () => void
}
