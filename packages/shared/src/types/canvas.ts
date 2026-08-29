import type {
  DesignAsset,
  DesignContextMode,
  DesignJobRecord,
  DesignPoint,
  DesignViewport,
} from './design'
import type { AgentSessionMeta } from './agent'
import type { SDKMessage } from './agent'

/** 原生 Canvas 图文档使用的固定 IPC 通道。 */
export const CANVAS_IPC_CHANNELS = {
  LOAD: 'canvas:load',
  LOAD_IMAGE_MODULE: 'canvas:load-image-module',
  SAVE_IMAGE_MODULE: 'canvas:save-image-module',
  CREATE_IMAGE_JOB: 'canvas:create-image-job',
  CANCEL_IMAGE_JOB: 'canvas:cancel-image-job',
  RETRY_IMAGE_JOB: 'canvas:retry-image-job',
  ADOPT_IMAGE_ASSET: 'canvas:adopt-image-asset',
  RELEASE_IMAGE_MEDIA: 'canvas:release-image-media',
  IMAGE_MODULE_CHANGED: 'canvas:image-module-changed',
  SAVE_MUTATIONS: 'canvas:save-mutations',
  CREATE_AGENT_NODE: 'canvas:create-agent-node',
  CREATE_CONTENT_NODE: 'canvas:create-content-node',
  DELETE_NODE: 'canvas:delete-node',
  LIST_TRASH: 'canvas:list-trash',
  RESTORE_NODE: 'canvas:restore-node',
  REBUILD_AGENT_NODE: 'canvas:rebuild-agent-node',
  LIST_ACTIVE_AGENT_RUNS: 'canvas:list-active-agent-runs',
  GET_AGENT_MESSAGES: 'canvas:get-agent-messages',
  SEND_AGENT_MESSAGE: 'canvas:send-agent-message',
  STOP_AGENT: 'canvas:stop-agent',
  CHANGED: 'canvas:changed',
} as const

/** 独立 Canvas 图文档的当前 schema 版本。 */
export const CANVAS_DOCUMENT_VERSION = 2

/** Canvas 支持的节点类别，每类节点只引用自身业务事实源。 */
export type CanvasNodeKind = 'agent' | 'image' | 'document' | 'webview'

/** 拥有独立受管内容目录的非 Agent 节点类别。 */
export type CanvasContentKind = Exclude<CanvasNodeKind, 'agent'>

/** 非 Agent 节点内容目录的最终身份提交标记。 */
export interface CanvasNodeContentMeta {
  schemaVersion: 1
  kind: CanvasContentKind
  contentId: string
  revision: number
  createdAt: number
  updatedAt: number
}

/** Renderer 可见的 Canvas 回收区条目，不包含任何磁盘路径。 */
export interface CanvasTrashEntry {
  schemaVersion: 1
  trashId: string
  nodeId: string
  kind: CanvasContentKind
  contentId: string
  title: string
  position: DesignPoint
  deletedRevision: number
  deletedAt: number
}

/** Canvas 内容稳定 ID 的共享边界，与 native helper 合同保持一致。 */
const CANVAS_CONTENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
/** 图片提示词上限，避免配置、IPC 与任务 journal 被无界文本放大。 */
export const CANVAS_IMAGE_PROMPT_MAX_LENGTH = 100_000
/** Canvas 可恢复命令使用的 UUID，避免 operationId 与稳定内容 ID 混用。 */
const CANVAS_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** Canvas 回收条目标题上限，避免无界数据进入 Renderer。 */
const CANVAS_TRASH_TITLE_MAX_LENGTH = 120

/** 判断未知值是否为无未知字段的普通记录。 */
function hasExactCanvasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  /** 实际字段排序后用于与固定合同逐项比较。 */
  const actualKeys = Object.keys(value).sort()
  /** 期望字段排序后避免调用方顺序影响判断。 */
  const expectedKeys = [...keys].sort()
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
}

/** 判断未知值是否为非负安全整数。 */
function isCanvasNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 判断未知值是否为受限的 Canvas 内容类别。 */
function isCanvasContentKind(value: unknown): value is CanvasContentKind {
  return value === 'image' || value === 'document' || value === 'webview'
}

/**
 * 严格解析非 Agent 节点内容身份。
 * @param value 待解析的未知磁盘或进程边界值。
 * @returns 无未知字段、数值有限且 ID 安全的内容元数据。
 */
export function parseCanvasNodeContentMeta(value: unknown): CanvasNodeContentMeta {
  /** 内容元数据允许的完整字段集合。 */
  const keys = ['schemaVersion', 'kind', 'contentId', 'revision', 'createdAt', 'updatedAt'] as const
  if (!hasExactCanvasKeys(value, keys)
    || value.schemaVersion !== 1
    || !isCanvasContentKind(value.kind)
    || typeof value.contentId !== 'string'
    || !CANVAS_CONTENT_ID_PATTERN.test(value.contentId)
    || !isCanvasNonNegativeInteger(value.revision)
    || !isCanvasNonNegativeInteger(value.createdAt)
    || !isCanvasNonNegativeInteger(value.updatedAt)) {
    throw new Error('CANVAS_CONTENT_META_INVALID')
  }
  return {
    schemaVersion: 1,
    kind: value.kind,
    contentId: value.contentId,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

/**
 * 严格解析 Renderer 可见回收区条目。
 * @param value 待解析的未知磁盘或进程边界值。
 * @returns 不含路径、字段有界且坐标有限的回收条目。
 */
export function parseCanvasTrashEntry(value: unknown): CanvasTrashEntry {
  /** 回收条目允许的完整字段集合。 */
  const keys = [
    'schemaVersion', 'trashId', 'nodeId', 'kind', 'contentId', 'title',
    'position', 'deletedRevision', 'deletedAt',
  ] as const
  /** 坐标对象允许的完整字段集合。 */
  const positionKeys = ['x', 'y'] as const
  if (!hasExactCanvasKeys(value, keys)
    || value.schemaVersion !== 1
    || typeof value.trashId !== 'string'
    || !CANVAS_CONTENT_ID_PATTERN.test(value.trashId)
    || typeof value.nodeId !== 'string'
    || !CANVAS_CONTENT_ID_PATTERN.test(value.nodeId)
    || !isCanvasContentKind(value.kind)
    || typeof value.contentId !== 'string'
    || !CANVAS_CONTENT_ID_PATTERN.test(value.contentId)
    || typeof value.title !== 'string'
    || value.title.length > CANVAS_TRASH_TITLE_MAX_LENGTH
    || !hasExactCanvasKeys(value.position, positionKeys)
    || typeof value.position.x !== 'number'
    || !Number.isFinite(value.position.x)
    || typeof value.position.y !== 'number'
    || !Number.isFinite(value.position.y)
    || !isCanvasNonNegativeInteger(value.deletedRevision)
    || !isCanvasNonNegativeInteger(value.deletedAt)) {
    throw new Error('CANVAS_TRASH_ENTRY_INVALID')
  }
  return {
    schemaVersion: 1,
    trashId: value.trashId,
    nodeId: value.nodeId,
    kind: value.kind,
    contentId: value.contentId,
    title: value.title,
    position: { x: value.position.x, y: value.position.y },
    deletedRevision: value.deletedRevision,
    deletedAt: value.deletedAt,
  }
}

/** Canvas 节点共享的展示和布局字段。 */
export interface CanvasNodeBase {
  id: string
  kind: CanvasNodeKind
  title: string
  position: DesignPoint
}

/** 引用独立 Agent 会话的节点，不复制消息或执行状态。 */
export interface CanvasAgentNode extends CanvasNodeBase {
  kind: 'agent'
  agentSessionId: string
  imageModuleId?: never
  adoptedAssetId?: never
  documentId?: never
  prototypeId?: never
  contentRevision?: never
  messages?: never
}

/** 引用 Canvas 图片素材的节点。 */
export interface CanvasImageNode extends CanvasNodeBase {
  kind: 'image'
  imageModuleId: string
  adoptedAssetId?: string
  agentSessionId?: never
  documentId?: never
  prototypeId?: never
  contentRevision?: never
}

/** 引用独立内容文档及其当前修订的节点。 */
export interface CanvasDocumentNode extends CanvasNodeBase {
  kind: 'document'
  documentId: string
  contentRevision: number
  agentSessionId?: never
  imageModuleId?: never
  adoptedAssetId?: never
  prototypeId?: never
}

/** 引用独立原型内容及其当前修订的 Webview 节点。 */
export interface CanvasWebviewNode extends CanvasNodeBase {
  kind: 'webview'
  prototypeId: string
  contentRevision: number
  agentSessionId?: never
  imageModuleId?: never
  adoptedAssetId?: never
  documentId?: never
}

/** Canvas 中四类互斥业务引用节点。 */
export type CanvasNode =
  | CanvasAgentNode
  | CanvasImageNode
  | CanvasDocumentNode
  | CanvasWebviewNode

/** 连接两个节点稳定端口的数据或任务边。 */
export interface CanvasEdge {
  id: string
  sourceNodeId: string
  sourcePort: string
  targetNodeId: string
  targetPort: string
}

/** 一个项目中单个 Canvas 会话的独立图文档。 */
export interface CanvasDocument {
  schemaVersion: typeof CANVAS_DOCUMENT_VERSION
  projectId: string
  canvasId: string
  revision: number
  viewport: DesignViewport
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  createdAt: number
  updatedAt: number
}

/** 替换 Canvas 视口的 mutation。 */
export interface SetCanvasViewportMutation {
  type: 'set-viewport'
  viewport: DesignViewport
}

/** 单个节点的稳定 ID 与目标位置。 */
export interface CanvasNodePosition {
  nodeId: string
  position: DesignPoint
}

/** 批量移动已存在节点的 mutation。 */
export interface MoveCanvasNodesMutation {
  type: 'move-nodes'
  positions: CanvasNodePosition[]
}

/** 按稳定 ID 替换或追加节点的 mutation。 */
export interface UpsertCanvasNodesMutation {
  type: 'upsert-nodes'
  nodes: CanvasNode[]
}

/** 按稳定 ID 删除节点的 mutation；相连边由 reducer 同步删除。 */
export interface RemoveCanvasNodesMutation {
  type: 'remove-nodes'
  nodeIds: string[]
}

/** 按稳定 ID 替换或追加边的 mutation。 */
export interface UpsertCanvasEdgesMutation {
  type: 'upsert-edges'
  edges: CanvasEdge[]
}

/** 按稳定 ID 删除边的 mutation。 */
export interface RemoveCanvasEdgesMutation {
  type: 'remove-edges'
  edgeIds: string[]
}

/** Canvas reducer 可按顺序应用的完整 mutation 联合。 */
export type CanvasMutation =
  | SetCanvasViewportMutation
  | MoveCanvasNodesMutation
  | UpsertCanvasNodesMutation
  | RemoveCanvasNodesMutation
  | UpsertCanvasEdgesMutation
  | RemoveCanvasEdgesMutation

/** 原生 Canvas 文档的项目与会话双重身份。 */
export interface CanvasTarget {
  projectId: string
  canvasId: string
}

/** Canvas 图片模块的完整业务身份，所有配置和任务操作必须逐项匹配。 */
export interface CanvasImageTarget extends CanvasTarget {
  nodeId: string
  imageModuleId: string
}

/** 图片模块支持的固定画面比例。 */
export type CanvasImageAspectRatio = '1:1' | '16:9' | '4:3' | '9:16' | '3:4'

/** 图片模块支持的固定输出尺寸。 */
export type CanvasImageSize = 'auto' | '1K' | '2K' | '4K'

/** 图片模块 schema v2 的权威持久化配置。 */
export interface CanvasImageModuleConfig {
  schemaVersion: 2
  kind: 'image'
  contentId: string
  revision: number
  createdAt: number
  updatedAt: number
  prompt: string
  selectedModelProfileId: string | null
  aspectRatio: CanvasImageAspectRatio
  imageSize: CanvasImageSize
  contextMode: DesignContextMode
  adoptedAssetId: string | null
}

/** 保存图片模块可编辑配置时使用的 CAS 输入。 */
export interface SaveCanvasImageModuleInput extends CanvasImageTarget {
  expectedConfigRevision: number
  prompt: string
  selectedModelProfileId: string | null
  aspectRatio: CanvasImageAspectRatio
  imageSize: CanvasImageSize
  contextMode: DesignContextMode
}

/** 取消、重试和读取任务时绑定完整图片模块身份的输入。 */
export interface CanvasImageJobControlInput extends CanvasImageTarget {
  jobId: string
}

/** Renderer 加载单个 Canvas 图片模块后得到的完整公开快照。 */
export interface CanvasImageModuleSnapshot {
  target: CanvasImageTarget
  config: CanvasImageModuleConfig
  jobs: DesignJobRecord[]
  assets: DesignAsset[]
  assetBaseUrl: string
  thumbnailBaseUrl: string
}

/** Design Job 固化的结构化图片生成约束。 */
export interface DesignGenerationConstraints {
  aspectRatio: CanvasImageAspectRatio
  imageSize: CanvasImageSize
}

/** 图片任务从一条直接入边固化的已提交输入引用。 */
export interface CanvasImageInputReference {
  nodeId: string
  kind: CanvasNodeKind
  revision: number
  summary: string
  summaryHash: string
  assetId?: string
}

/** Canvas Agent 节点的项目、Canvas 与节点三重身份。 */
export interface CanvasAgentTarget extends CanvasTarget {
  nodeId: string
}

/** Canvas 节点可由用户执行的恢复动作。 */
export type CanvasNodeIssueAction = 'rebuild-agent-session' | 'remove-node'

/** 首批节点问题只公开用户可恢复的会话不可用状态。 */
export type CanvasNodeIssueCode = 'AGENT_SESSION_UNAVAILABLE'

/** 主进程派生的节点问题，不写入 CanvasDocument。 */
export interface CanvasNodeIssue {
  nodeId: string
  code: CanvasNodeIssueCode
  allowedActions: CanvasNodeIssueAction[]
}

/** Renderer 可见的 Canvas 业务错误码。 */
export type CanvasPublicErrorCode =
  | 'CANVAS_LOAD_FAILED'
  | 'CANVAS_SAVE_FAILED'
  | 'CANVAS_CREATE_FAILED'
  | 'CANVAS_CONTENT_INVALID'
  | 'CANVAS_DELETE_FAILED'
  | 'CANVAS_RESTORE_FAILED'
  | 'CANVAS_REVISION_CONFLICT'
  | 'AGENT_SESSION_BUSY'
  | 'AGENT_SESSION_REBUILD_FAILED'
  | 'CANVAS_AGENT_MESSAGES_FAILED'
  | 'CANVAS_AGENT_SEND_FAILED'
  | 'CANVAS_AGENT_STOP_FAILED'
  | 'CANVAS_IMAGE_LOAD_FAILED'
  | 'CANVAS_IMAGE_SAVE_FAILED'
  | 'CANVAS_IMAGE_JOB_FAILED'
  | 'CANVAS_IMAGE_REVISION_CONFLICT'

/** 不含内部路径、UUID、通道或堆栈的公开错误。 */
export interface CanvasPublicError {
  code: CanvasPublicErrorCode
  message: string
}

/** 所有原生 Canvas invoke 共用的安全结果信封。 */
export type CanvasInvokeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CanvasPublicError }

/** 按需读取单个 Canvas Agent 持久化消息的输入。 */
export interface GetCanvasAgentMessagesInput extends CanvasAgentTarget {}

/** 向单个 Canvas Agent 发送纯文本消息的输入。 */
export interface SendCanvasAgentMessageInput extends CanvasAgentTarget {
  message: string
  userMessageUuid: string
  startedAt: number
}

/** Renderer 可处理的 Canvas Agent 发送拒绝码。 */
export type CanvasAgentSendErrorCode = 'SESSION_BUSY'

/** Canvas Agent 发送准入结果；运行期错误仍通过 Agent 流事件发布。 */
export type SendCanvasAgentMessageResult =
  | { ok: true }
  | { ok: false; error: { code: CanvasAgentSendErrorCode; message: string } }

/** 中止单个 Canvas Agent 的输入。 */
export interface StopCanvasAgentInput extends CanvasAgentTarget {}

/** Renderer 可见的最小 Canvas Agent owner。 */
export interface CanvasAgentPublicOwner extends CanvasTarget {
  nodeId: string
  title: string
}

/** Renderer 重载时一次性恢复的运行中 Canvas Agent 安全快照。 */
export interface CanvasAgentActiveRunSnapshot {
  owners: Array<CanvasAgentPublicOwner & { sessionId: string; startedAt?: number }>
  internalInvalidRuns: Array<{ sessionId: string; startedAt: number; valid: false }>
}

/** 按需加载结果不暴露 JSONL 路径或存储类型。 */
export interface CanvasAgentMessagesResult {
  sessionId: string
  owner: CanvasAgentPublicOwner
  messages: SDKMessage[]
}

/** 加载单个原生 Canvas 文档的公开输入。 */
export interface LoadCanvasInput extends CanvasTarget {}

/** 在指定权威 revision 上保存一批 Canvas mutation。 */
export interface SaveCanvasMutationsInput extends CanvasTarget {
  expectedRevision: number
  mutations: CanvasMutation[]
}

/** 从源节点创建下游节点时使用的稳定关系身份。 */
export interface CreateCanvasAgentNodeRelationship {
  sourceNodeId: string
  edgeId: string
}

/** 幂等创建非 Agent 内容节点的严格输入。 */
export interface CreateCanvasContentNodeInput extends CanvasTarget {
  operationId: string
  nodeId: string
  kind: CanvasContentKind
  contentId: string
  title: string
  position: DesignPoint
  expectedRevision: number
  relationship?: CreateCanvasAgentNodeRelationship
}

/** 幂等删除任意 Canvas 节点的严格输入。 */
export interface DeleteCanvasNodeInput extends CanvasAgentTarget {
  operationId: string
  expectedRevision: number
}

/** 从回收区恢复内容节点的严格输入。 */
export interface RestoreCanvasNodeInput extends CanvasTarget {
  operationId: string
  trashId: string
  expectedRevision: number
  position: DesignPoint
}

/** 内容节点生命周期操作完成后的公开业务事实。 */
export interface CanvasNodeLifecycleResult {
  snapshot: CanvasWorkspaceSnapshot
  selectedNodeId?: string
  trashEntry?: CanvasTrashEntry
}

/** 判断未知坐标是否为 exact-key 有限二维点。 */
function isCanvasLifecyclePosition(value: unknown): value is DesignPoint {
  return hasExactCanvasKeys(value, ['x', 'y'])
    && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
}

/** 判断共享生命周期命令使用的稳定 ID。 */
function isCanvasLifecycleId(value: unknown): value is string {
  return typeof value === 'string' && CANVAS_CONTENT_ID_PATTERN.test(value)
}

/** 判断未知值是否为图片模块支持的画面比例。 */
function isCanvasImageAspectRatio(value: unknown): value is CanvasImageAspectRatio {
  return value === '1:1' || value === '16:9' || value === '4:3' || value === '9:16' || value === '3:4'
}

/** 判断未知值是否为图片模块支持的输出尺寸。 */
function isCanvasImageSize(value: unknown): value is CanvasImageSize {
  return value === 'auto' || value === '1K' || value === '2K' || value === '4K'
}

/** 判断未知值是否为 Design 支持的项目上下文模式。 */
function isCanvasImageContextMode(value: unknown): value is DesignContextMode {
  return value === 'auto' || value === 'project' || value === 'none'
}

/** 判断可选稳定 ID 是否为 null 或安全 ID。 */
function isOptionalCanvasImageId(value: unknown): value is string | null {
  return value === null || isCanvasLifecycleId(value)
}

/** 判断图片提示词是否为有界字符串。 */
function isCanvasImagePrompt(value: unknown): value is string {
  return typeof value === 'string' && value.length <= CANVAS_IMAGE_PROMPT_MAX_LENGTH
}

/**
 * 严格解析图片模块完整身份。
 * @param value 待解析的 IPC 或持久化边界值。
 * @returns 无未知字段且四级身份均为安全 ID 的目标。
 */
export function parseCanvasImageTarget(value: unknown): CanvasImageTarget {
  /** 图片目标允许的完整字段集合。 */
  const keys = ['projectId', 'canvasId', 'nodeId', 'imageModuleId'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasLifecycleId(value.nodeId)
    || !isCanvasLifecycleId(value.imageModuleId)) {
    throw new Error('CANVAS_IMAGE_TARGET_INVALID')
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    imageModuleId: value.imageModuleId,
  }
}

/**
 * 严格解析图片模块 schema v2 配置。
 * @param value 待解析的未知磁盘或进程边界值。
 * @returns 字段精确、枚举受限且文本有界的图片配置。
 */
export function parseCanvasImageModuleConfig(value: unknown): CanvasImageModuleConfig {
  /** v2 图片配置允许的完整字段集合。 */
  const keys = [
    'schemaVersion', 'kind', 'contentId', 'revision', 'createdAt', 'updatedAt',
    'prompt', 'selectedModelProfileId', 'aspectRatio', 'imageSize', 'contextMode',
    'adoptedAssetId',
  ] as const
  if (!hasExactCanvasKeys(value, keys)
    || value.schemaVersion !== 2
    || value.kind !== 'image'
    || !isCanvasLifecycleId(value.contentId)
    || !isCanvasNonNegativeInteger(value.revision)
    || !isCanvasNonNegativeInteger(value.createdAt)
    || !isCanvasNonNegativeInteger(value.updatedAt)
    || !isCanvasImagePrompt(value.prompt)
    || !isOptionalCanvasImageId(value.selectedModelProfileId)
    || !isCanvasImageAspectRatio(value.aspectRatio)
    || !isCanvasImageSize(value.imageSize)
    || !isCanvasImageContextMode(value.contextMode)
    || !isOptionalCanvasImageId(value.adoptedAssetId)) {
    throw new Error('CANVAS_IMAGE_CONFIG_INVALID')
  }
  return {
    schemaVersion: 2,
    kind: 'image',
    contentId: value.contentId,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    prompt: value.prompt,
    selectedModelProfileId: value.selectedModelProfileId,
    aspectRatio: value.aspectRatio,
    imageSize: value.imageSize,
    contextMode: value.contextMode,
    adoptedAssetId: value.adoptedAssetId,
  }
}

/**
 * 严格解析图片模块 CAS 保存输入。
 * @param value 待解析的 Renderer 输入。
 * @returns 身份、revision 和全部可编辑字段均已验证的保存命令。
 */
export function parseSaveCanvasImageModuleInput(value: unknown): SaveCanvasImageModuleInput {
  /** 图片保存命令允许的完整字段集合。 */
  const keys = [
    'projectId', 'canvasId', 'nodeId', 'imageModuleId', 'expectedConfigRevision',
    'prompt', 'selectedModelProfileId', 'aspectRatio', 'imageSize', 'contextMode',
  ] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasLifecycleId(value.nodeId)
    || !isCanvasLifecycleId(value.imageModuleId)
    || !isCanvasNonNegativeInteger(value.expectedConfigRevision)
    || !isCanvasImagePrompt(value.prompt)
    || !isOptionalCanvasImageId(value.selectedModelProfileId)
    || !isCanvasImageAspectRatio(value.aspectRatio)
    || !isCanvasImageSize(value.imageSize)
    || !isCanvasImageContextMode(value.contextMode)) {
    throw new Error('CANVAS_IMAGE_SAVE_INPUT_INVALID')
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    imageModuleId: value.imageModuleId,
    expectedConfigRevision: value.expectedConfigRevision,
    prompt: value.prompt,
    selectedModelProfileId: value.selectedModelProfileId,
    aspectRatio: value.aspectRatio,
    imageSize: value.imageSize,
    contextMode: value.contextMode,
  }
}

/**
 * 严格解析图片任务控制输入。
 * @param value 待解析的 Renderer 输入。
 * @returns 完整图片身份与安全任务 ID。
 */
export function parseCanvasImageJobControlInput(value: unknown): CanvasImageJobControlInput {
  /** 图片任务控制命令允许的完整字段集合。 */
  const keys = ['projectId', 'canvasId', 'nodeId', 'imageModuleId', 'jobId'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasLifecycleId(value.nodeId)
    || !isCanvasLifecycleId(value.imageModuleId)
    || !isCanvasLifecycleId(value.jobId)) {
    throw new Error('CANVAS_IMAGE_JOB_INPUT_INVALID')
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    imageModuleId: value.imageModuleId,
    jobId: value.jobId,
  }
}

/** 判断标题已规范化且长度有界。 */
function isCanvasLifecycleTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 120
}

/** 严格解析可选的右侧扩展关系。 */
function parseCanvasLifecycleRelationship(value: unknown): CreateCanvasAgentNodeRelationship | undefined {
  if (value === undefined) return undefined
  if (!hasExactCanvasKeys(value, ['sourceNodeId', 'edgeId'])
    || !isCanvasLifecycleId(value.sourceNodeId)
    || !isCanvasLifecycleId(value.edgeId)) {
    throw new Error('CANVAS_RELATIONSHIP_INVALID')
  }
  return { sourceNodeId: value.sourceNodeId, edgeId: value.edgeId }
}

/** 严格解析非 Agent 内容节点创建命令。 */
export function parseCreateCanvasContentNodeInput(value: unknown): CreateCanvasContentNodeInput {
  const required = [
    'projectId', 'canvasId', 'operationId', 'nodeId', 'kind', 'contentId',
    'title', 'position', 'expectedRevision',
  ] as const
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CANVAS_CREATE_INPUT_INVALID')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (!required.every((key) => Object.hasOwn(record, key))
    || keys.some((key) => !required.includes(key as typeof required[number]) && key !== 'relationship')
    || !isCanvasLifecycleId(record.projectId)
    || !isCanvasLifecycleId(record.canvasId)
    || typeof record.operationId !== 'string' || !CANVAS_OPERATION_ID_PATTERN.test(record.operationId)
    || !isCanvasLifecycleId(record.nodeId)
    || !isCanvasContentKind(record.kind)
    || !isCanvasLifecycleId(record.contentId)
    || !isCanvasLifecycleTitle(record.title)
    || !isCanvasLifecyclePosition(record.position)
    || !isCanvasNonNegativeInteger(record.expectedRevision)) {
    throw new Error('CANVAS_CREATE_INPUT_INVALID')
  }
  const relationship = parseCanvasLifecycleRelationship(record.relationship)
  if (relationship?.sourceNodeId === record.nodeId) throw new Error('CANVAS_RELATIONSHIP_INVALID')
  return {
    projectId: record.projectId, canvasId: record.canvasId, operationId: record.operationId,
    nodeId: record.nodeId, kind: record.kind, contentId: record.contentId, title: record.title,
    position: { x: record.position.x, y: record.position.y }, expectedRevision: record.expectedRevision,
    ...(relationship ? { relationship } : {}),
  }
}

/** 严格解析节点删除命令。 */
export function parseDeleteCanvasNodeInput(value: unknown): DeleteCanvasNodeInput {
  const keys = ['projectId', 'canvasId', 'nodeId', 'operationId', 'expectedRevision'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId) || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasLifecycleId(value.nodeId)
    || typeof value.operationId !== 'string' || !CANVAS_OPERATION_ID_PATTERN.test(value.operationId)
    || !isCanvasNonNegativeInteger(value.expectedRevision)) throw new Error('CANVAS_DELETE_INPUT_INVALID')
  return { projectId: value.projectId, canvasId: value.canvasId, nodeId: value.nodeId, operationId: value.operationId, expectedRevision: value.expectedRevision }
}

/** 严格解析回收区恢复命令。 */
export function parseRestoreCanvasNodeInput(value: unknown): RestoreCanvasNodeInput {
  const keys = ['projectId', 'canvasId', 'operationId', 'trashId', 'expectedRevision', 'position'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId) || !isCanvasLifecycleId(value.canvasId)
    || typeof value.operationId !== 'string' || !CANVAS_OPERATION_ID_PATTERN.test(value.operationId)
    || !isCanvasLifecycleId(value.trashId)
    || !isCanvasNonNegativeInteger(value.expectedRevision)
    || !isCanvasLifecyclePosition(value.position)) throw new Error('CANVAS_RESTORE_INPUT_INVALID')
  return { projectId: value.projectId, canvasId: value.canvasId, operationId: value.operationId, trashId: value.trashId, expectedRevision: value.expectedRevision, position: { x: value.position.x, y: value.position.y } }
}

/** 在已有原生 Canvas 中幂等创建一个内部 Agent 节点。 */
export interface CreateCanvasAgentNodeInput extends CanvasTarget {
  /** Renderer 为单次用户操作生成的稳定 UUID，失败重试必须复用。 */
  operationId: string
  /** 本次操作预分配的稳定节点 ID，不允许由主进程替换。 */
  nodeId: string
  /** 节点与内部会话共享的展示标题。 */
  title: string
  /** 节点在当前 Canvas 世界坐标中的初始位置。 */
  position: DesignPoint
  /** 存在时创建源节点指向新节点的稳定连线。 */
  relationship?: CreateCanvasAgentNodeRelationship
}

/** Agent 节点事务 committed 后向 Renderer 发布的公开结果。 */
export interface CanvasAgentNodeCreationResult {
  document: CanvasDocument
  session: AgentSessionMeta
}

/** 显式把坏 Agent 节点换绑到新空白会话的输入。 */
export interface RebuildCanvasAgentNodeInput extends CanvasAgentTarget {
  /** Renderer 为重建操作生成的稳定 UUID，失败重试必须复用。 */
  operationId: string
}

/** 重建完成后返回的权威快照与新空白会话。 */
export interface RebuildCanvasAgentNodeResult {
  snapshot: CanvasWorkspaceSnapshot
  session: AgentSessionMeta
}

/** 原生 Canvas 折叠生图节点使用的轻量图片预览，不暴露本地素材路径。 */
export interface CanvasImagePreview {
  assetId: string
  previewUrl: string
}

/** Renderer 可见的原生 Canvas 工作区快照，不暴露路径或存储实现。 */
export interface CanvasWorkspaceSnapshot {
  document: CanvasDocument
  writable: true
  nodeIssues: CanvasNodeIssue[]
  /** LOAD 提供当前 Canvas 已采用素材的共享缩略图；生命周期旧结果可暂不携带。 */
  imagePreviews?: CanvasImagePreview[]
  recoveredFrom?: 'tmp' | 'backup'
}

/** 原生 Canvas 文档变化事件，始终携带项目和 Canvas 双重身份。 */
export interface CanvasChangeEvent extends CanvasTarget {
  revision: number
  cause: 'graph' | 'recovery'
}

/**
 * 创建同时绑定项目和 Canvas 会话身份的空图文档。
 * @param projectId 文档所属项目的稳定 ID。
 * @param canvasId 文档所属 Canvas 会话的稳定 ID。
 * @param now 文档创建与更新时间戳。
 * @returns revision 为 0、默认视口且无节点和边的新文档。
 */
export function createEmptyCanvasDocument(
  projectId: string,
  canvasId: string,
  now: number = Date.now(),
): CanvasDocument {
  return {
    schemaVersion: CANVAS_DOCUMENT_VERSION,
    projectId,
    canvasId,
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 使用稳定 ID 合并实体数组，已有实体在原位置替换，新实体按输入顺序追加。
 * @param current 当前保持有序的实体数组。
 * @param updates 需要替换或追加的实体数组。
 * @returns 合并后的新数组；同一批重复 ID 由最后一个更新值覆盖。
 */
function upsertCanvasEntities<T extends { id: string }>(current: T[], updates: T[]): T[] {
  /** Map 保留首次插入顺序，同时允许相同 ID 原位覆盖。 */
  const entitiesById = new Map(current.map((entity) => [entity.id, entity]))
  for (const update of updates) entitiesById.set(update.id, update)
  return [...entitiesById.values()]
}

/**
 * 以纯函数方式依次应用 Canvas mutation，不承担 Store 的 schema 校验和 revision 提交。
 * @param document 当前不可直接修改的 Canvas 文档。
 * @param mutations 需要按数组顺序应用的变更集合。
 * @returns 保留原 revision、包含全部归约结果的新文档。
 */
export function applyCanvasMutations(
  document: CanvasDocument,
  mutations: CanvasMutation[],
): CanvasDocument {
  /** 单次深拷贝同时隔离文档基线与 mutation payload，阻断调用方后续反向改写快照。 */
  const isolatedInputs = structuredClone({ document, mutations })
  /** 从隔离后的文档开始归约，保证调用方持有的基线不被修改。 */
  let next = isolatedInputs.document

  for (const mutation of isolatedInputs.mutations) {
    switch (mutation.type) {
      case 'set-viewport':
        next.viewport = mutation.viewport
        break
      case 'move-nodes': {
        /** 本次批量移动中每个节点 ID 对应的最终位置。 */
        const positionsByNodeId = new Map(
          mutation.positions.map((item) => [item.nodeId, item.position]),
        )
        next.nodes = next.nodes.map((node) => {
          /** 当前节点在 mutation 中声明的新位置，缺失表示保持原位。 */
          const position = positionsByNodeId.get(node.id)
          return position === undefined ? node : { ...node, position }
        })
        break
      }
      case 'upsert-nodes':
        next.nodes = upsertCanvasEntities(next.nodes, mutation.nodes)
        break
      case 'remove-nodes': {
        /** 待删除节点集合，用于同时过滤节点和所有相连边。 */
        const removedNodeIds = new Set(mutation.nodeIds)
        next.nodes = next.nodes.filter((node) => !removedNodeIds.has(node.id))
        next.edges = next.edges.filter((edge) => (
          !removedNodeIds.has(edge.sourceNodeId) && !removedNodeIds.has(edge.targetNodeId)
        ))
        break
      }
      case 'upsert-edges':
        next.edges = upsertCanvasEntities(next.edges, mutation.edges)
        break
      case 'remove-edges': {
        /** 待删除边集合，未知 ID 会自然忽略。 */
        const removedEdgeIds = new Set(mutation.edgeIds)
        next.edges = next.edges.filter((edge) => !removedEdgeIds.has(edge.id))
        break
      }
    }
  }

  return next
}
