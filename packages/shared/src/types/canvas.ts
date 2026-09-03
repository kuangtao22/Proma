import type {
  DesignAsset,
  DesignContextReference,
  DesignContextMode,
  DesignJobRecord,
  DesignPoint,
  DesignViewport,
  ImageGenerationModelSnapshot,
} from './design'
import type { AgentSessionMeta } from './agent'
import type { SDKMessage } from './agent'

/** 原生 Canvas 图文档使用的固定 IPC 通道。 */
export const CANVAS_IPC_CHANNELS = {
  LOAD: 'canvas:load',
  LOAD_WEBVIEW: 'canvas:load-webview',
  LOAD_WEBVIEW_PREVIEW: 'canvas:load-webview-preview',
  LOAD_TEXT_ARTIFACT: 'canvas:load-text-artifact',
  UPDATE_TEXT_ARTIFACT: 'canvas:update-text-artifact',
  LIST_ARTIFACT_REVISIONS: 'canvas:list-artifact-revisions',
  ADOPT_ARTIFACT_REVISION: 'canvas:adopt-artifact-revision',
  EXPORT_ARTIFACT: 'canvas:export-artifact',
  LOAD_IMAGE_MODULE: 'canvas:load-image-module',
  SAVE_IMAGE_MODULE: 'canvas:save-image-module',
  CREATE_IMAGE_JOB: 'canvas:create-image-job',
  CANCEL_IMAGE_JOB: 'canvas:cancel-image-job',
  RETRY_IMAGE_JOB: 'canvas:retry-image-job',
  ADOPT_IMAGE_ASSET: 'canvas:adopt-image-asset',
  GET_IMAGE_CANDIDATE_BATCH: 'canvas:get-image-candidate-batch',
  CONTINUE_IMAGE_CANDIDATE_BATCH: 'canvas:continue-image-candidate-batch',
  ADOPT_IMAGE_CANDIDATE_BATCH: 'canvas:adopt-image-candidate-batch',
  ABANDON_IMAGE_CANDIDATE_BATCH: 'canvas:abandon-image-candidate-batch',
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
  LIST_AGENT_BINDINGS: 'canvas:list-agent-bindings',
  LINK_AGENT_CANVAS: 'canvas:link-agent-canvas',
  UNLINK_AGENT_CANVAS: 'canvas:unlink-agent-canvas',
  SET_DEFAULT_AGENT_CANVAS: 'canvas:set-default-agent-canvas',
  CLEAR_AGENT_BINDINGS: 'canvas:clear-agent-bindings',
  AGENT_BINDINGS_CHANGED: 'canvas:agent-bindings-changed',
  CHANGED: 'canvas:changed',
} as const

/** 独立 Canvas 图文档的当前 schema 版本。 */
export const CANVAS_DOCUMENT_VERSION = 4

/** WebView 节点支持的设备视口预设。 */
export type CanvasWebviewDevicePreset = 'desktop' | 'mobile'

/**
 * 严格解析 WebView 设备预设。
 * @param value 待解析的跨进程或持久化值。
 * @returns 受支持的网页或手机预设。
 */
export function parseCanvasWebviewDevicePreset(value: unknown): CanvasWebviewDevicePreset {
  if (value !== 'desktop' && value !== 'mobile') {
    throw new Error('CANVAS_WEBVIEW_DEVICE_PRESET_INVALID')
  }
  return value
}

/** Canvas 支持的节点类别，每类节点只引用自身业务事实源。 */
export type CanvasNodeKind = 'agent' | 'image' | 'document' | 'webview'

/** 四类 Canvas 节点共享的瞬时活动状态，不写入持久化文档。 */
export type CanvasNodeActivityState = 'idle' | 'queued' | 'running' | 'waiting-approval'

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

/** Renderer 可见回收条目的共享字段，不包含任何磁盘路径。 */
interface CanvasTrashEntryBase {
  schemaVersion: 2
  trashId: string
  nodeId: string
  contentId: string
  title: string
  position: DesignPoint
  deletedRevision: number
  deletedAt: number
}

/** 图片回收条目保留删除时已经采用的素材身份。 */
export interface CanvasImageTrashEntry extends CanvasTrashEntryBase {
  kind: 'image'
  adoptedAssetId?: string
}

/** 文档回收条目保留删除时采用的正文修订。 */
export interface CanvasDocumentTrashEntry extends CanvasTrashEntryBase {
  kind: 'document'
  contentRevision: number
}

/** WebView 回收条目保留删除时采用的正文修订和设备预设。 */
export interface CanvasWebviewTrashEntry extends CanvasTrashEntryBase {
  kind: 'webview'
  contentRevision: number
  devicePreset: CanvasWebviewDevicePreset
}

/** Renderer 可见的严格回收条目判别联合。 */
export type CanvasTrashEntry =
  | CanvasImageTrashEntry
  | CanvasDocumentTrashEntry
  | CanvasWebviewTrashEntry

/** Canvas 内容稳定 ID 的共享边界，与 native helper 合同保持一致。 */
const CANVAS_CONTENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
/** 图片提示词上限，避免配置、IPC 与任务 journal 被无界文本放大。 */
export const CANVAS_IMAGE_PROMPT_MAX_LENGTH = 100_000
/** Canvas 可恢复命令使用的 UUID，避免 operationId 与稳定内容 ID 混用。 */
const CANVAS_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** Canvas 回收条目标题上限，避免无界数据进入 Renderer。 */
const CANVAS_TRASH_TITLE_MAX_LENGTH = 120
/** 文本产物正文最大 UTF-8 字节数，与受管文件写入边界保持一致。 */
export const CANVAS_TEXT_ARTIFACT_CONTENT_MAX_BYTES = 256 * 1024

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
  /** schema v1 历史条目只允许旧版完整字段集合。 */
  const legacyKeys = [
    'schemaVersion', 'trashId', 'nodeId', 'kind', 'contentId', 'title',
    'position', 'deletedRevision', 'deletedAt',
  ] as const
  /** schema v2 各分支共享的完整基础字段集合。 */
  const baseKeys = [
    'schemaVersion', 'trashId', 'nodeId', 'kind', 'contentId', 'title',
    'position', 'deletedRevision', 'deletedAt',
  ] as const
  /** 坐标对象允许的完整字段集合。 */
  const positionKeys = ['x', 'y'] as const
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CANVAS_TRASH_ENTRY_INVALID')
  }
  /** 收窄后的回收条目用于按版本和 kind 选择 exact-key 分支。 */
  const record = value as Record<string, unknown>
  /** v1 兼容读取必须严格拒绝新旧字段混用。 */
  const isLegacy = record.schemaVersion === 1 && hasExactCanvasKeys(record, legacyKeys)
  /** v2 图片允许 adoptedAssetId 缺省，另外两类必须包含各自完整状态。 */
  const hasV2Keys = record.schemaVersion === 2 && (
    (record.kind === 'image'
      && (hasExactCanvasKeys(record, baseKeys) || hasExactCanvasKeys(record, [...baseKeys, 'adoptedAssetId'])))
    || (record.kind === 'document'
      && hasExactCanvasKeys(record, [...baseKeys, 'contentRevision']))
    || (record.kind === 'webview'
      && hasExactCanvasKeys(record, [...baseKeys, 'contentRevision', 'devicePreset']))
  )
  if ((!isLegacy && !hasV2Keys)
    || typeof record.trashId !== 'string'
    || !CANVAS_CONTENT_ID_PATTERN.test(record.trashId)
    || typeof record.nodeId !== 'string'
    || !CANVAS_CONTENT_ID_PATTERN.test(record.nodeId)
    || !isCanvasContentKind(record.kind)
    || typeof record.contentId !== 'string'
    || !CANVAS_CONTENT_ID_PATTERN.test(record.contentId)
    || typeof record.title !== 'string'
    || record.title.length > CANVAS_TRASH_TITLE_MAX_LENGTH
    || !hasExactCanvasKeys(record.position, positionKeys)
    || typeof record.position.x !== 'number'
    || !Number.isFinite(record.position.x)
    || typeof record.position.y !== 'number'
    || !Number.isFinite(record.position.y)
    || !isCanvasNonNegativeInteger(record.deletedRevision)
    || !isCanvasNonNegativeInteger(record.deletedAt)) {
    throw new Error('CANVAS_TRASH_ENTRY_INVALID')
  }
  /** 已校验的共享字段用于构造 v2 规范化输出。 */
  const base = {
    schemaVersion: 2 as const,
    trashId: record.trashId,
    nodeId: record.nodeId,
    contentId: record.contentId,
    title: record.title,
    position: { x: record.position.x, y: record.position.y },
    deletedRevision: record.deletedRevision,
    deletedAt: record.deletedAt,
  }
  if (record.kind === 'image') {
    if (record.adoptedAssetId !== undefined && !isCanvasLifecycleId(record.adoptedAssetId)) {
      throw new Error('CANVAS_TRASH_ENTRY_INVALID')
    }
    return {
      ...base,
      kind: 'image',
      ...(record.adoptedAssetId === undefined ? {} : { adoptedAssetId: record.adoptedAssetId }),
    }
  }
  if (record.kind === 'document') {
    if (!isLegacy && !isCanvasNonNegativeInteger(record.contentRevision)) {
      throw new Error('CANVAS_TRASH_ENTRY_INVALID')
    }
    return { ...base, kind: 'document', contentRevision: isLegacy ? 0 : record.contentRevision as number }
  }
  if (record.kind === 'webview') {
    if (!isLegacy && (!isCanvasNonNegativeInteger(record.contentRevision)
      || (record.devicePreset !== 'desktop' && record.devicePreset !== 'mobile'))) {
      throw new Error('CANVAS_TRASH_ENTRY_INVALID')
    }
    return {
      ...base,
      kind: 'webview',
      contentRevision: isLegacy ? 0 : record.contentRevision as number,
      devicePreset: isLegacy ? 'desktop' : record.devicePreset as CanvasWebviewDevicePreset,
    }
  }
  throw new Error('CANVAS_TRASH_ENTRY_INVALID')
}

/** Canvas 节点共享的展示和布局字段。 */
export interface CanvasNodeUpstreamChange {
  /** 本次变化的直接上游节点，按稳定 ID 排序且去重。 */
  sourceNodeIds: string[]
  /** 采用事务提交该提示的时间。 */
  changedAt: number
}

/** Canvas 节点共享的展示和布局字段。 */
export interface CanvasNodeBase {
  id: string
  kind: CanvasNodeKind
  title: string
  position: DesignPoint
  /** 数据依赖上游已变化，节点内容需要用户决定是否更新。 */
  upstreamChange?: CanvasNodeUpstreamChange
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
  devicePreset: CanvasWebviewDevicePreset
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

/** 拥有独立内容事实源的 Canvas 节点联合。 */
export type CanvasContentNode = CanvasImageNode | CanvasDocumentNode | CanvasWebviewNode

/** Canvas 边表达的长期语义关系。 */
export type CanvasEdgeRelation = 'association' | 'reference' | 'depends-on' | 'derives'

/** Canvas 节点可向下游提供的可信产物能力。 */
export type CanvasArtifactOutputCapability =
  | 'agent.text'
  | 'image.asset'
  | 'document.markdown'
  | 'webview.html'

/** Canvas 下游节点可接收的可信输入槽。 */
export type CanvasArtifactInputSlot =
  | 'context.text'
  | 'context.image'
  | 'image.reference'

/** Canvas 边经过节点类型校验后的执行绑定状态。 */
export type CanvasEdgeBindingResolution =
  | {
    state: 'bound'
    sourceCapability: CanvasArtifactOutputCapability
    targetSlot: CanvasArtifactInputSlot
  }
  | { state: 'none' }
  | { state: 'unresolved' }
  | { state: 'incompatible' }

/** 纯业务关联边使用的稳定空端口，不代表任何执行输入。 */
export const CANVAS_UNBOUND_PORT = 'unbound'

/** 各节点类型唯一公开的默认产物能力。 */
const CANVAS_NODE_OUTPUT_CAPABILITY: Readonly<Record<CanvasNodeKind, CanvasArtifactOutputCapability>> = {
  agent: 'agent.text',
  image: 'image.asset',
  document: 'document.markdown',
  webview: 'webview.html',
}

/** 判断未知值是否为受支持的 Canvas 输出能力。 */
function isCanvasArtifactOutputCapability(value: unknown): value is CanvasArtifactOutputCapability {
  return Object.values(CANVAS_NODE_OUTPUT_CAPABILITY).includes(value as CanvasArtifactOutputCapability)
}

/** 判断未知值是否为受支持的 Canvas 输入槽。 */
function isCanvasArtifactInputSlot(value: unknown): value is CanvasArtifactInputSlot {
  return value === 'context.text' || value === 'context.image' || value === 'image.reference'
}

/** 严格解析 Canvas 边语义。 */
export function parseCanvasEdgeRelation(value: unknown): CanvasEdgeRelation {
  if (value !== 'association' && value !== 'reference'
    && value !== 'depends-on' && value !== 'derives') {
    throw new Error('CANVAS_EDGE_RELATION_INVALID')
  }
  return value
}

/** 连接两个节点稳定端口的数据或任务边。 */
export interface CanvasEdge {
  id: string
  sourceNodeId: string
  sourcePort: string
  targetNodeId: string
  targetPort: string
  relation: CanvasEdgeRelation
}

/**
 * 根据两端节点类型创建 Host 可验证的执行边。
 * @param source 来源节点稳定身份与类型。
 * @param target 目标节点稳定身份与类型。
 * @param edge 不含端口的关系边事实。
 * @returns 写入类型化端口或空关联端口的完整边。
 */
export function createCanvasBoundEdge(
  source: Pick<CanvasNode, 'id' | 'kind'>,
  target: Pick<CanvasNode, 'id' | 'kind'>,
  edge: Omit<CanvasEdge, 'sourcePort' | 'targetPort'>,
): CanvasEdge {
  if (edge.relation === 'association') {
    return { ...edge, sourcePort: CANVAS_UNBOUND_PORT, targetPort: CANVAS_UNBOUND_PORT }
  }
  /** 来源能力由权威节点类型唯一决定。 */
  const sourcePort = CANVAS_NODE_OUTPUT_CAPABILITY[source.kind]
  /** 图片产物进入媒体槽，其它产物只进入文本上下文。 */
  const targetPort: CanvasArtifactInputSlot = sourcePort === 'image.asset'
    ? target.kind === 'image' ? 'image.reference' : 'context.image'
    : 'context.text'
  return { ...edge, sourcePort, targetPort }
}

/**
 * 判定持久化边是否形成可信执行绑定。
 * @param edge 待校验的持久化边。
 * @param sourceKind 来源节点权威类型。
 * @param targetKind 目标节点权威类型。
 * @returns 已绑定、无绑定、待确认或不兼容状态。
 */
export function resolveCanvasEdgeBinding(
  edge: CanvasEdge,
  sourceKind: CanvasNodeKind,
  targetKind: CanvasNodeKind,
): CanvasEdgeBindingResolution {
  if (edge.relation === 'association') return { state: 'none' }
  /** 用同一建边规则计算当前节点组合唯一允许的端口。 */
  const expected = createCanvasBoundEdge(
    { id: edge.sourceNodeId, kind: sourceKind },
    { id: edge.targetNodeId, kind: targetKind },
    {
      id: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      relation: edge.relation,
    },
  )
  if (edge.sourcePort === expected.sourcePort && edge.targetPort === expected.targetPort) {
    return {
      state: 'bound',
      sourceCapability: expected.sourcePort as CanvasArtifactOutputCapability,
      targetSlot: expected.targetPort as CanvasArtifactInputSlot,
    }
  }
  /** 任一已知端口出现在错误组合中时，必须判定为不兼容。 */
  if (isCanvasArtifactOutputCapability(edge.sourcePort) || isCanvasArtifactInputSlot(edge.targetPort)) {
    return { state: 'incompatible' }
  }
  return { state: 'unresolved' }
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

/** 切换单个 WebView 节点的设备视口，不修改位置或 HTML 内容。 */
export interface SetCanvasWebviewDevicePresetMutation {
  type: 'set-webview-device-preset'
  nodeId: string
  devicePreset: CanvasWebviewDevicePreset
}

/** Canvas reducer 可按顺序应用的完整 mutation 联合。 */
export type CanvasMutation =
  | SetCanvasViewportMutation
  | MoveCanvasNodesMutation
  | UpsertCanvasNodesMutation
  | RemoveCanvasNodesMutation
  | UpsertCanvasEdgesMutation
  | RemoveCanvasEdgesMutation
  | SetCanvasWebviewDevicePresetMutation

/** 原生 Canvas 文档的项目与会话双重身份。 */
export interface CanvasTarget {
  projectId: string
  canvasId: string
}

/** 支持不可变正文修订的 Canvas 产物类别。 */
export type CanvasTextArtifactKind = 'document' | 'webview'

/** 用户直接创建的产物修订作者。 */
export interface CanvasUserArtifactAuthor {
  type: 'user'
}

/** Agent 工具创建的产物修订作者。 */
export interface CanvasAgentArtifactAuthor {
  type: 'agent'
  sessionId: string
  toolCallId: string
}

/** 产物修订的可信作者联合。 */
export type CanvasArtifactAuthor = CanvasUserArtifactAuthor | CanvasAgentArtifactAuthor

/** 文本产物在单张 Canvas 中的稳定业务身份。 */
export interface CanvasTextArtifactIdentity extends CanvasTarget {
  nodeId: string
  kind: CanvasTextArtifactKind
  contentId: string
}

/** 文本产物读取绑定的精确内容修订。 */
export interface CanvasTextArtifactTarget extends CanvasTextArtifactIdentity {
  contentRevision: number
}

/** 不可变产物修订的公开摘要。 */
export interface CanvasArtifactRevisionSummary {
  kind: CanvasTextArtifactKind
  contentId: string
  revision: number
  parentRevision: number | null
  contentHash: string
  createdBy: CanvasArtifactAuthor
  createdAt: number
}

/** 文本产物正文及其完整修订身份。 */
export interface CanvasTextArtifactSnapshot {
  target: CanvasTextArtifactTarget
  revision: CanvasArtifactRevisionSummary
  content: string
}

/** 在图和正文双重基线上创建新文本修订的输入。 */
export interface UpdateCanvasTextArtifactInput extends CanvasTextArtifactIdentity {
  operationId: string
  expectedCanvasRevision: number
  expectedContentRevision: number
  content: string
}

/** 把历史文本修订重新设为节点当前修订的输入。 */
export interface AdoptCanvasTextArtifactRevisionInput extends CanvasTextArtifactIdentity {
  operationId: string
  expectedCanvasRevision: number
  expectedContentRevision: number
  revision: number
}

/** 导出指定文档或 WebView 修订的输入。 */
export interface ExportCanvasTextArtifactInput extends CanvasTextArtifactTarget {}

/** 导出已采用图片素材的完整身份。 */
export interface ExportCanvasImageArtifactInput extends CanvasImageTarget {
  kind: 'image'
  assetId: string
}

/** 三类可导出 Canvas 产物的严格输入联合。 */
export type ExportCanvasArtifactInput =
  | ExportCanvasTextArtifactInput
  | ExportCanvasImageArtifactInput

/** 加载单个 WebView 原型时绑定的完整节点与内容修订身份。 */
export interface CanvasWebviewTarget extends CanvasTarget {
  nodeId: string
  prototypeId: string
  contentRevision: number
}

/** Renderer 展开 WebView 节点后得到的受管 HTML 快照。 */
export interface CanvasWebviewSnapshot {
  target: CanvasWebviewTarget
  html: string
}

/** 生成 WebView 静态卡片预览时绑定的完整图与内容身份。 */
export interface CanvasWebviewPreviewTarget extends CanvasWebviewTarget {
  devicePreset: CanvasWebviewDevicePreset
}

/** Renderer 可见的受管 WebView 静态预览，不暴露本地文件路径。 */
export interface CanvasWebviewPreviewSnapshot {
  target: CanvasWebviewPreviewTarget
  previewUrl: string
  width: number
  height: number
}

/** 一个普通 Agent 会话在所属项目内关联的 Canvas 集合。 */
export interface AgentCanvasBinding {
  projectId: string
  sessionId: string
  defaultCanvasId?: string
  linkedCanvasIds: string[]
  lastActiveCanvasId?: string
  updatedAt: number
}

/** Agent-Canvas 关联变更的稳定公开原因。 */
export type AgentCanvasBindingChangeCause =
  | 'linked'
  | 'unlinked'
  | 'default-changed'
  | 'session-cleared'
  | 'canvas-cleared'

/** 主进程成功提交关联写入后广播的最小公开事件。 */
export interface AgentCanvasBindingChangeEvent {
  projectId: string
  sessionId: string
  cause: AgentCanvasBindingChangeCause
  binding: AgentCanvasBinding | null
}

/** 对话消息引用的 Canvas 节点稳定快照。 */
export interface CanvasNodeReference {
  projectId: string
  canvasId: string
  nodeId: string
  nodeType: CanvasNode['kind']
  nodeRevision: number
  title: string
}

/** Agent 工具在权威 revision 上提交的一批 Canvas 修改。 */
export interface CanvasBatchOperationInput extends CanvasTarget {
  baseRevision: number
  operations: CanvasMutation[]
  sourceSessionId: string
  sourceRunStartedAt: number
  sourceToolCallId: string
}

/** Canvas 批量命令外壳允许携带的 JSON 基元。 */
export type CanvasJsonPrimitive = null | string | boolean | number

/** Canvas 批量命令外壳允许携带的 JSON 对象。 */
export interface CanvasJsonObject {
  [key: string]: CanvasJsonValue
}

/** Canvas 批量命令外壳允许携带的递归 JSON 值。 */
export type CanvasJsonValue = CanvasJsonPrimitive | CanvasJsonObject | CanvasJsonValue[]

/** Task 8 权威验证 mutation 前使用的不可信 JSON 命令外壳。 */
export interface CanvasBatchOperationEnvelope extends CanvasTarget {
  baseRevision: number
  operations: CanvasJsonValue[]
  sourceSessionId: string
  sourceRunStartedAt: number
  sourceToolCallId: string
}

/** Agent 工具明确执行一组 Canvas 节点的输入。 */
export interface CanvasRunNodesInput extends CanvasTarget {
  nodeIds: string[]
  sourceSessionId: string
  sourceRunStartedAt: number
  sourceToolCallId: string
}

/** 单个 Canvas 节点执行后的有限审计结果，不包含图片素材身份。 */
export interface CanvasToolNodeRunResult {
  nodeId: string
  status: 'started' | 'queued' | 'idle' | 'unsupported' | 'failed' | 'blocked' | 'rolled-back'
  taskId?: string
  message?: string
  error?: string
}

/** 图片节点运行后交给 Agent 的候选批次摘要，明确要求在画布验收。 */
export interface CanvasRunNodesBatchSummary {
  batchId: string
  status: CanvasImageCandidateBatchStatus
  totalCount: number
  candidateCount: number
  failedCount: number
  runningCount: number
  requiresCanvasReview: true
}

/** 主进程运行边界返回任务审计和可选图片候选批次。 */
export interface CanvasRunNodesResult {
  tasks: CanvasToolNodeRunResult[]
  batch?: CanvasRunNodesBatchSummary
}

/** `canvas_run_nodes` 工具向 Agent 返回的完整结构化结果。 */
export interface CanvasRunNodesToolResult extends CanvasRunNodesResult {
  canvasId: string
  revision: number
}

/** 读取项目内全部 Agent-Canvas 关联的输入。 */
export interface ListAgentCanvasBindingsInput {
  projectId: string
}

/** 读取项目内全部 Agent-Canvas 关联的公开输出。 */
export type ListAgentCanvasBindingsResult = AgentCanvasBinding[]

/** 建立 Agent 与 Canvas 关联的输入。 */
export interface LinkAgentCanvasInput extends CanvasTarget {
  sessionId: string
  makeDefault: boolean
}

/** 建立关联后返回规范化的公开记录。 */
export type LinkAgentCanvasResult = AgentCanvasBinding

/** 解除 Agent 与 Canvas 关联的输入。 */
export interface UnlinkAgentCanvasInput extends CanvasTarget {
  sessionId: string
}

/** 解除关联后返回规范化的公开记录。 */
export type UnlinkAgentCanvasResult = AgentCanvasBinding | null

/** 设置 Agent 默认 Canvas 的输入。 */
export interface SetDefaultAgentCanvasInput extends CanvasTarget {
  sessionId: string
}

/** 设置默认 Canvas 后返回规范化的公开记录。 */
export type SetDefaultAgentCanvasResult = AgentCanvasBinding

/** 删除 Agent 时按会话清空全部 Canvas 关联。 */
export interface ClearAgentCanvasBindingsBySessionInput {
  projectId: string
  target: 'session'
  sessionId: string
  canvasId?: never
}

/** 删除 Canvas 时按画布清空全部 Agent 关联。 */
export interface ClearAgentCanvasBindingsByCanvasInput {
  projectId: string
  target: 'canvas'
  canvasId: string
  sessionId?: never
}

/** 清空关联的严格判别联合，目标会话与目标 Canvas 互斥。 */
export type ClearAgentCanvasBindingsInput =
  | ClearAgentCanvasBindingsBySessionInput
  | ClearAgentCanvasBindingsByCanvasInput

/** 清空关联不返回额外业务数据。 */
export type ClearAgentCanvasBindingsResult = void

/** Canvas 图片模块的完整业务身份，所有配置和任务操作必须逐项匹配。 */
export interface CanvasImageTarget extends CanvasTarget {
  nodeId: string
  imageModuleId: string
}

/** 释放图片模块媒体授权时绑定具体授权代次的输入。 */
export interface ReleaseCanvasImageMediaInput extends CanvasImageTarget {
  mediaLeaseId: string
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

/** 由主进程从成功任务与现存素材严格派生的图片版本事实。 */
export interface CanvasImageArtifactVersion {
  jobId: string
  assetId: string
  createdAt: number
}

/** Renderer 加载单个 Canvas 图片模块后得到的完整公开快照。 */
export interface CanvasImageModuleSnapshot {
  target: CanvasImageTarget
  mediaLeaseId: string
  config: CanvasImageModuleConfig
  jobs: DesignJobRecord[]
  assets: DesignAsset[]
  imageVersions: CanvasImageArtifactVersion[]
  assetBaseUrl: string
  thumbnailBaseUrl: string
}

/** 图片候选批次按事实推进的公开状态。 */
export type CanvasImageCandidateBatchStatus = 'running' | 'partial' | 'ready' | 'adopted' | 'abandoned'

/** 单个目标在候选批次中的有限状态。 */
export type CanvasImageCandidateEntryStatus =
  | 'queued' | 'running' | 'candidate' | 'failed' | 'invalid' | 'adopted' | 'kept'

/** 候选批次的创建入口。 */
export type CanvasImageCandidateBatchSource = 'single' | 'canvas-tool'

/** 候选批次中一个稳定图片节点的基线与输出事实。 */
export interface CanvasImageCandidateBatchEntry {
  nodeId: string
  imageModuleId: string
  initialAdoptedAssetId: string | null
  initialConfigRevision: number
  jobId: string
  candidateAssetId: string | null
  status: CanvasImageCandidateEntryStatus
  error: string | null
}

/** 用户明确采用后保存的结果摘要。 */
export interface CanvasImageCandidateBatchAdoption {
  mode: 'all' | 'succeeded'
  adoptedNodeIds: string[]
  keptNodeIds: string[]
  invalidatedDownstreamNodeIds: string[]
  committedAt: number
}

/** 主进程持久化的完整图片候选批次。 */
export interface CanvasImageCandidateBatch extends CanvasTarget {
  schemaVersion: 1
  batchId: string
  source: CanvasImageCandidateBatchSource
  sourceSessionId: string | null
  sourceToolCallId: string | null
  status: CanvasImageCandidateBatchStatus
  entries: CanvasImageCandidateBatchEntry[]
  adoption: CanvasImageCandidateBatchAdoption | null
  createdAt: number
  updatedAt: number
}

/** 初始 Canvas LOAD 使用的有界批次摘要。 */
export interface CanvasImageCandidateBatchSummary extends CanvasTarget {
  batchId: string
  status: CanvasImageCandidateBatchStatus
  /** 供画布按节点投影候选与运行状态的有界轻量事实。 */
  entries: CanvasImageCandidateBatchSummaryEntry[]
  totalCount: number
  candidateCount: number
  failedCount: number
  runningCount: number
  updatedAt: number
}

/** 初始 LOAD 中每个候选节点只公开定位与状态，不复制 Job、Asset 或错误正文。 */
export interface CanvasImageCandidateBatchSummaryEntry {
  nodeId: string
  status: CanvasImageCandidateEntryStatus
}

/** 按稳定身份读取一个候选批次。 */
export interface GetCanvasImageCandidateBatchInput extends CanvasTarget { batchId: string }

/** 明确选择整批或成功项采用。 */
export interface AdoptCanvasImageCandidateBatchInput extends GetCanvasImageCandidateBatchInput {
  mode: 'all' | 'succeeded'
}

/** 只补齐未成功条目的操作输入。 */
export interface ContinueCanvasImageCandidateBatchInput extends GetCanvasImageCandidateBatchInput {}

/** 放弃活跃批次但保留历史候选。 */
export interface AbandonCanvasImageCandidateBatchInput extends GetCanvasImageCandidateBatchInput {}

/** 候选批次公开条目上限，约束 IPC 与磁盘解析开销。 */
export const CANVAS_IMAGE_CANDIDATE_BATCH_ENTRY_LIMIT = 1000
/** 初始 LOAD 返回的活跃批次摘要上限。 */
export const CANVAS_IMAGE_CANDIDATE_BATCH_SUMMARY_LIMIT = 20

/** 解析候选批次使用的固定公开状态集合。 */
const CANVAS_IMAGE_CANDIDATE_BATCH_STATUSES: readonly CanvasImageCandidateBatchStatus[] = [
  'running', 'partial', 'ready', 'adopted', 'abandoned',
]
/** 解析候选条目使用的固定公开状态集合。 */
const CANVAS_IMAGE_CANDIDATE_ENTRY_STATUSES: readonly CanvasImageCandidateEntryStatus[] = [
  'queued', 'running', 'candidate', 'failed', 'invalid', 'adopted', 'kept',
]

/** 严格解析单个候选条目。 */
function parseCanvasImageCandidateBatchEntry(value: unknown): CanvasImageCandidateBatchEntry {
  const keys = [
    'nodeId', 'imageModuleId', 'initialAdoptedAssetId', 'initialConfigRevision',
    'jobId', 'candidateAssetId', 'status', 'error',
  ] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.nodeId)
    || !isCanvasLifecycleId(value.imageModuleId)
    || (value.initialAdoptedAssetId !== null && !isCanvasLifecycleId(value.initialAdoptedAssetId))
    || !isCanvasNonNegativeInteger(value.initialConfigRevision)
    || !isCanvasLifecycleId(value.jobId)
    || (value.candidateAssetId !== null && !isCanvasLifecycleId(value.candidateAssetId))
    || !CANVAS_IMAGE_CANDIDATE_ENTRY_STATUSES.includes(value.status as CanvasImageCandidateEntryStatus)
    || (value.error !== null && (typeof value.error !== 'string' || value.error.length > 1000))) {
    throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
  }
  return {
    nodeId: value.nodeId,
    imageModuleId: value.imageModuleId,
    initialAdoptedAssetId: value.initialAdoptedAssetId as string | null,
    initialConfigRevision: value.initialConfigRevision as number,
    jobId: value.jobId,
    candidateAssetId: value.candidateAssetId as string | null,
    status: value.status as CanvasImageCandidateEntryStatus,
    error: value.error as string | null,
  }
}

/** 严格解析采用结果并稳定排序所有公开 ID。 */
function parseCanvasImageCandidateBatchAdoption(value: unknown): CanvasImageCandidateBatchAdoption {
  const keys = ['mode', 'adoptedNodeIds', 'keptNodeIds', 'invalidatedDownstreamNodeIds', 'committedAt'] as const
  if (!hasExactCanvasKeys(value, keys)
    || (value.mode !== 'all' && value.mode !== 'succeeded')
    || !Array.isArray(value.adoptedNodeIds)
    || !Array.isArray(value.keptNodeIds)
    || !Array.isArray(value.invalidatedDownstreamNodeIds)
    || !isCanvasNonNegativeInteger(value.committedAt)) {
    throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
  }
  /** 采用结果列表均有限且不允许重复或非法身份。 */
  const parseIds = (values: unknown[]): string[] => {
    if (values.length > CANVAS_IMAGE_CANDIDATE_BATCH_ENTRY_LIMIT
      || values.some((item) => !isCanvasLifecycleId(item))) {
      throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    }
    const ids = values as string[]
    if (new Set(ids).size !== ids.length) throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    return [...ids].sort((left, right) => left.localeCompare(right))
  }
  return {
    mode: value.mode,
    adoptedNodeIds: parseIds(value.adoptedNodeIds),
    keptNodeIds: parseIds(value.keptNodeIds),
    invalidatedDownstreamNodeIds: parseIds(value.invalidatedDownstreamNodeIds),
    committedAt: value.committedAt as number,
  }
}

/** 严格解析完整候选批次并重建深隔离值。 */
export function parseCanvasImageCandidateBatch(value: unknown): CanvasImageCandidateBatch {
  try {
    const keys = [
      'schemaVersion', 'batchId', 'projectId', 'canvasId', 'source', 'sourceSessionId',
      'sourceToolCallId', 'status', 'entries', 'adoption', 'createdAt', 'updatedAt',
    ] as const
    if (!hasExactCanvasKeys(value, keys)
      || value.schemaVersion !== 1
      || !isCanvasLifecycleId(value.batchId)
      || !isCanvasLifecycleId(value.projectId)
      || !isCanvasLifecycleId(value.canvasId)
      || (value.source !== 'single' && value.source !== 'canvas-tool')
      || (value.sourceSessionId !== null && !isCanvasLifecycleId(value.sourceSessionId))
      || (value.sourceToolCallId !== null && !isCanvasLifecycleId(value.sourceToolCallId))
      || !CANVAS_IMAGE_CANDIDATE_BATCH_STATUSES.includes(value.status as CanvasImageCandidateBatchStatus)
      || !Array.isArray(value.entries)
      || value.entries.length < 1
      || value.entries.length > CANVAS_IMAGE_CANDIDATE_BATCH_ENTRY_LIMIT
      || !isCanvasNonNegativeInteger(value.createdAt)
      || !isCanvasNonNegativeInteger(value.updatedAt)
      || (value.updatedAt as number) < (value.createdAt as number)) {
      throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    }
    const entries = value.entries.map(parseCanvasImageCandidateBatchEntry)
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.jobId.localeCompare(right.jobId))
    if (new Set(entries.map((entry) => entry.nodeId)).size !== entries.length
      || new Set(entries.map((entry) => entry.jobId)).size !== entries.length) {
      throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    }
    const adoption = value.adoption === null ? null : parseCanvasImageCandidateBatchAdoption(value.adoption)
    if ((value.status === 'adopted') !== (adoption !== null)) {
      throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    }
    return {
      schemaVersion: 1,
      batchId: value.batchId,
      projectId: value.projectId,
      canvasId: value.canvasId,
      source: value.source,
      sourceSessionId: value.sourceSessionId as string | null,
      sourceToolCallId: value.sourceToolCallId as string | null,
      status: value.status as CanvasImageCandidateBatchStatus,
      entries,
      adoption,
      createdAt: value.createdAt as number,
      updatedAt: value.updatedAt as number,
    }
  } catch (error) {
    throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID', { cause: error })
  }
}

/** 严格解析初始 LOAD 使用的候选批次摘要。 */
export function parseCanvasImageCandidateBatchSummary(value: unknown): CanvasImageCandidateBatchSummary {
  const keys = [
    'batchId', 'projectId', 'canvasId', 'status', 'totalCount', 'candidateCount',
    'failedCount', 'runningCount', 'updatedAt', 'entries',
  ] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.batchId)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !CANVAS_IMAGE_CANDIDATE_BATCH_STATUSES.includes(value.status as CanvasImageCandidateBatchStatus)
    || !isCanvasNonNegativeInteger(value.totalCount)
    || !isCanvasNonNegativeInteger(value.candidateCount)
    || !isCanvasNonNegativeInteger(value.failedCount)
    || !isCanvasNonNegativeInteger(value.runningCount)
    || !Array.isArray(value.entries)
    || (value.totalCount as number) > CANVAS_IMAGE_CANDIDATE_BATCH_ENTRY_LIMIT
    || (value.candidateCount as number) + (value.failedCount as number) + (value.runningCount as number) > (value.totalCount as number)
    || !isCanvasNonNegativeInteger(value.updatedAt)) {
    throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
  }
  /** 摘要条目必须与总数闭合，且每个节点只出现一次。 */
  const entries = value.entries.map((entry): CanvasImageCandidateBatchSummaryEntry => {
    if (!hasExactCanvasKeys(entry, ['nodeId', 'status'])
      || !isCanvasLifecycleId(entry.nodeId)
      || !CANVAS_IMAGE_CANDIDATE_ENTRY_STATUSES.includes(entry.status as CanvasImageCandidateEntryStatus)) {
      throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    }
    return { nodeId: entry.nodeId, status: entry.status as CanvasImageCandidateEntryStatus }
  }).sort((left, right) => left.nodeId.localeCompare(right.nodeId))
  const candidateCount = entries.filter((entry) => entry.status === 'candidate').length
  const failedCount = entries.filter((entry) => entry.status === 'failed' || entry.status === 'invalid').length
  const runningCount = entries.filter((entry) => entry.status === 'queued' || entry.status === 'running').length
  if (entries.length !== value.totalCount
    || new Set(entries.map((entry) => entry.nodeId)).size !== entries.length
    || candidateCount !== value.candidateCount
    || failedCount !== value.failedCount
    || runningCount !== value.runningCount) {
    throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
  }
  return {
    batchId: value.batchId,
    projectId: value.projectId,
    canvasId: value.canvasId,
    status: value.status as CanvasImageCandidateBatchStatus,
    entries,
    totalCount: value.totalCount as number,
    candidateCount: value.candidateCount as number,
    failedCount: value.failedCount as number,
    runningCount: value.runningCount as number,
    updatedAt: value.updatedAt as number,
  }
}

/** 严格解析候选批次稳定身份。 */
export function parseGetCanvasImageCandidateBatchInput(value: unknown): GetCanvasImageCandidateBatchInput {
  if (!hasExactCanvasKeys(value, ['projectId', 'canvasId', 'batchId'])
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasLifecycleId(value.batchId)) {
    throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INPUT_INVALID')
  }
  return { projectId: value.projectId, canvasId: value.canvasId, batchId: value.batchId }
}

/** 严格解析候选批次采用模式。 */
export function parseAdoptCanvasImageCandidateBatchInput(value: unknown): AdoptCanvasImageCandidateBatchInput {
  if (!hasExactCanvasKeys(value, ['projectId', 'canvasId', 'batchId', 'mode'])
    || (value.mode !== 'all' && value.mode !== 'succeeded')) {
    throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INPUT_INVALID')
  }
  return { ...parseGetCanvasImageCandidateBatchInput({
    projectId: value.projectId, canvasId: value.canvasId, batchId: value.batchId,
  }), mode: value.mode }
}

/** 严格解析继续补齐输入。 */
export const parseContinueCanvasImageCandidateBatchInput = parseGetCanvasImageCandidateBatchInput
/** 严格解析放弃批次输入。 */
export const parseAbandonCanvasImageCandidateBatchInput = parseGetCanvasImageCandidateBatchInput

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
  sourcePort?: CanvasArtifactOutputCapability
  targetPort?: CanvasArtifactInputSlot
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
  | 'CANVAS_WEBVIEW_LOAD_FAILED'
  | 'CANVAS_WEBVIEW_PREVIEW_FAILED'
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
  | 'CANVAS_IMAGE_INPUT_CONFIRMATION_REQUIRED'
  | 'CANVAS_IMAGE_INPUT_MISSING'
  | 'CANVAS_IMAGE_INPUT_INVALID'
  | 'CANVAS_IMAGE_REVISION_CONFLICT'
  | 'CANVAS_IMAGE_BATCH_CONFLICT'
  | 'CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED'
  | 'CANVAS_IMAGE_BATCH_INVALID'
  | 'CANVAS_ARTIFACT_LOAD_FAILED'
  | 'CANVAS_ARTIFACT_SAVE_FAILED'
  | 'CANVAS_ARTIFACT_REVISION_CONFLICT'
  | 'CANVAS_ARTIFACT_EXPORT_FAILED'
  | 'CANVAS_BINDING_LIST_FAILED'
  | 'CANVAS_BINDING_FAILED'

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

/** 严格解析 WebView 节点完整身份，拒绝额外字段和过期修订格式。 */
export function parseCanvasWebviewTarget(value: unknown): CanvasWebviewTarget {
  /** WebView 读取只接受用于复核节点与受管内容的完整字段集合。 */
  const keys = ['projectId', 'canvasId', 'nodeId', 'prototypeId', 'contentRevision'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasLifecycleId(value.nodeId)
    || !isCanvasLifecycleId(value.prototypeId)
    || !isCanvasNonNegativeInteger(value.contentRevision)) {
    throw new Error('CANVAS_WEBVIEW_TARGET_INVALID')
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    prototypeId: value.prototypeId,
    contentRevision: value.contentRevision,
  }
}

/** 严格解析 WebView 静态预览的完整目标身份。 */
export function parseCanvasWebviewPreviewTarget(value: unknown): CanvasWebviewPreviewTarget {
  const keys = [
    'projectId', 'canvasId', 'nodeId', 'prototypeId', 'contentRevision', 'devicePreset',
  ] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasLifecycleId(value.nodeId)
    || !isCanvasLifecycleId(value.prototypeId)
    || !isCanvasNonNegativeInteger(value.contentRevision)
    || (value.devicePreset !== 'desktop' && value.devicePreset !== 'mobile')) {
    throw new Error('CANVAS_WEBVIEW_PREVIEW_TARGET_INVALID')
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    prototypeId: value.prototypeId,
    contentRevision: value.contentRevision,
    devicePreset: value.devicePreset,
  }
}

/** 严格解析 Renderer 可见的 WebView 静态预览快照。 */
export function parseCanvasWebviewPreviewSnapshot(value: unknown): CanvasWebviewPreviewSnapshot {
  const keys = ['target', 'previewUrl', 'width', 'height'] as const
  if (!hasExactCanvasKeys(value, keys)
    || typeof value.previewUrl !== 'string'
    || value.previewUrl.length === 0
    || !Number.isSafeInteger(value.width)
    || (value.width as number) <= 0
    || !Number.isSafeInteger(value.height)
    || (value.height as number) <= 0) {
    throw new Error('CANVAS_WEBVIEW_PREVIEW_SNAPSHOT_INVALID')
  }
  try {
    return {
      target: parseCanvasWebviewPreviewTarget(value.target),
      previewUrl: value.previewUrl,
      width: value.width as number,
      height: value.height as number,
    }
  } catch (error) {
    throw new Error('CANVAS_WEBVIEW_PREVIEW_SNAPSHOT_INVALID', { cause: error })
  }
}

/** 在指定权威 revision 上保存一批 Canvas mutation。 */
export interface SaveCanvasMutationsInput extends CanvasTarget {
  expectedRevision: number
  mutations: CanvasMutation[]
}

/** 判断未知值是否为文本产物类别。 */
function isCanvasTextArtifactKind(value: unknown): value is CanvasTextArtifactKind {
  return value === 'document' || value === 'webview'
}

/** 判断文本正文是否位于 UTF-8 256 KiB 边界内。 */
function isCanvasTextArtifactContent(value: unknown): value is string {
  return typeof value === 'string'
    && new TextEncoder().encode(value).byteLength <= CANVAS_TEXT_ARTIFACT_CONTENT_MAX_BYTES
}

/** 按指定错误码严格解析文本产物稳定身份。 */
function parseCanvasTextArtifactIdentityWithError(
  value: unknown,
  errorCode: string,
): CanvasTextArtifactIdentity {
  /** 文本产物身份允许的完整字段集合。 */
  const keys = ['projectId', 'canvasId', 'nodeId', 'kind', 'contentId'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasLifecycleId(value.nodeId)
    || !isCanvasTextArtifactKind(value.kind)
    || !isCanvasLifecycleId(value.contentId)) {
    throw new Error(errorCode)
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    kind: value.kind,
    contentId: value.contentId,
  }
}

/** 严格解析文本产物稳定身份。 */
export function parseCanvasTextArtifactIdentity(value: unknown): CanvasTextArtifactIdentity {
  return parseCanvasTextArtifactIdentityWithError(value, 'CANVAS_TEXT_ARTIFACT_IDENTITY_INVALID')
}

/** 严格解析文本产物精确修订目标。 */
export function parseCanvasTextArtifactTarget(value: unknown): CanvasTextArtifactTarget {
  /** 精确目标在稳定身份之外必须携带内容修订。 */
  const keys = ['projectId', 'canvasId', 'nodeId', 'kind', 'contentId', 'contentRevision'] as const
  if (!hasExactCanvasKeys(value, keys) || !isCanvasNonNegativeInteger(value.contentRevision)) {
    throw new Error('CANVAS_TEXT_ARTIFACT_TARGET_INVALID')
  }
  /** 去除修订后复用唯一的稳定身份校验。 */
  const identity = parseCanvasTextArtifactIdentityWithError({
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    kind: value.kind,
    contentId: value.contentId,
  }, 'CANVAS_TEXT_ARTIFACT_TARGET_INVALID')
  return { ...identity, contentRevision: value.contentRevision }
}

/** 严格解析产物修订作者。 */
export function parseCanvasArtifactAuthor(value: unknown): CanvasArtifactAuthor {
  if (hasExactCanvasKeys(value, ['type']) && value.type === 'user') return { type: 'user' }
  if (hasExactCanvasKeys(value, ['type', 'sessionId', 'toolCallId'])
    && value.type === 'agent'
    && isCanvasLifecycleId(value.sessionId)
    && isCanvasLifecycleId(value.toolCallId)) {
    return { type: 'agent', sessionId: value.sessionId, toolCallId: value.toolCallId }
  }
  throw new Error('CANVAS_ARTIFACT_AUTHOR_INVALID')
}

/** 严格解析不可变产物修订摘要。 */
export function parseCanvasArtifactRevisionSummary(value: unknown): CanvasArtifactRevisionSummary {
  /** 修订摘要只允许公开的版本事实字段。 */
  const keys = [
    'kind', 'contentId', 'revision', 'parentRevision', 'contentHash', 'createdBy', 'createdAt',
  ] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasTextArtifactKind(value.kind)
    || !isCanvasLifecycleId(value.contentId)
    || !isCanvasNonNegativeInteger(value.revision)
    || !(value.parentRevision === null || isCanvasNonNegativeInteger(value.parentRevision))
    || typeof value.contentHash !== 'string'
    || !/^[0-9a-f]{64}$/i.test(value.contentHash)
    || !isCanvasNonNegativeInteger(value.createdAt)) {
    throw new Error('CANVAS_ARTIFACT_REVISION_SUMMARY_INVALID')
  }
  try {
    return {
      kind: value.kind,
      contentId: value.contentId,
      revision: value.revision,
      parentRevision: value.parentRevision,
      contentHash: value.contentHash,
      createdBy: parseCanvasArtifactAuthor(value.createdBy),
      createdAt: value.createdAt,
    }
  } catch (error) {
    throw new Error('CANVAS_ARTIFACT_REVISION_SUMMARY_INVALID', { cause: error })
  }
}

/** 严格解析文本产物正文快照。 */
export function parseCanvasTextArtifactSnapshot(value: unknown): CanvasTextArtifactSnapshot {
  if (!hasExactCanvasKeys(value, ['target', 'revision', 'content'])
    || !isCanvasTextArtifactContent(value.content)) {
    throw new Error('CANVAS_TEXT_ARTIFACT_SNAPSHOT_INVALID')
  }
  try {
    /** 快照目标与修订摘要必须描述同一内容及采用修订。 */
    const target = parseCanvasTextArtifactTarget(value.target)
    /** 公开修订摘要按自身 exact-key 合同重建。 */
    const revision = parseCanvasArtifactRevisionSummary(value.revision)
    if (target.kind !== revision.kind
      || target.contentId !== revision.contentId
      || target.contentRevision !== revision.revision) {
      throw new Error('CANVAS_TEXT_ARTIFACT_SNAPSHOT_INVALID')
    }
    return { target, revision, content: value.content }
  } catch (error) {
    throw new Error('CANVAS_TEXT_ARTIFACT_SNAPSHOT_INVALID', { cause: error })
  }
}

/** 严格解析文本产物更新输入。 */
export function parseUpdateCanvasTextArtifactInput(value: unknown): UpdateCanvasTextArtifactInput {
  /** 更新输入必须同时绑定图 revision、正文 revision 和幂等 UUID。 */
  const keys = [
    'projectId', 'canvasId', 'nodeId', 'kind', 'contentId', 'operationId',
    'expectedCanvasRevision', 'expectedContentRevision', 'content',
  ] as const
  if (!hasExactCanvasKeys(value, keys)
    || typeof value.operationId !== 'string'
    || !CANVAS_OPERATION_ID_PATTERN.test(value.operationId)
    || !isCanvasNonNegativeInteger(value.expectedCanvasRevision)
    || !isCanvasNonNegativeInteger(value.expectedContentRevision)
    || !isCanvasTextArtifactContent(value.content)) {
    throw new Error('CANVAS_TEXT_ARTIFACT_UPDATE_INPUT_INVALID')
  }
  /** 复用稳定身份规则，禁止更新命令漂移出安全 ID 边界。 */
  const identity = parseCanvasTextArtifactIdentityWithError({
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    kind: value.kind,
    contentId: value.contentId,
  }, 'CANVAS_TEXT_ARTIFACT_UPDATE_INPUT_INVALID')
  return {
    ...identity,
    operationId: value.operationId,
    expectedCanvasRevision: value.expectedCanvasRevision,
    expectedContentRevision: value.expectedContentRevision,
    content: value.content,
  }
}

/** 严格解析文本产物历史修订采用输入。 */
export function parseAdoptCanvasTextArtifactRevisionInput(
  value: unknown,
): AdoptCanvasTextArtifactRevisionInput {
  /** 采用命令必须显式声明当前双重基线和目标修订。 */
  const keys = [
    'projectId', 'canvasId', 'nodeId', 'kind', 'contentId', 'operationId',
    'expectedCanvasRevision', 'expectedContentRevision', 'revision',
  ] as const
  if (!hasExactCanvasKeys(value, keys)
    || typeof value.operationId !== 'string'
    || !CANVAS_OPERATION_ID_PATTERN.test(value.operationId)
    || !isCanvasNonNegativeInteger(value.expectedCanvasRevision)
    || !isCanvasNonNegativeInteger(value.expectedContentRevision)
    || !isCanvasNonNegativeInteger(value.revision)) {
    throw new Error('CANVAS_TEXT_ARTIFACT_ADOPT_INPUT_INVALID')
  }
  /** 复用稳定身份规则，避免采用命令和读取目标的 ID 规则分叉。 */
  const identity = parseCanvasTextArtifactIdentityWithError({
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    kind: value.kind,
    contentId: value.contentId,
  }, 'CANVAS_TEXT_ARTIFACT_ADOPT_INPUT_INVALID')
  return {
    ...identity,
    operationId: value.operationId,
    expectedCanvasRevision: value.expectedCanvasRevision,
    expectedContentRevision: value.expectedContentRevision,
    revision: value.revision,
  }
}

/** 严格解析文档、WebView 或图片导出输入。 */
export function parseExportCanvasArtifactInput(value: unknown): ExportCanvasArtifactInput {
  if (hasExactCanvasKeys(value, [
    'projectId', 'canvasId', 'nodeId', 'kind', 'contentId', 'contentRevision',
  ]) && isCanvasTextArtifactKind(value.kind)) {
    return parseCanvasTextArtifactTarget(value)
  }
  if (hasExactCanvasKeys(value, [
    'projectId', 'canvasId', 'nodeId', 'kind', 'imageModuleId', 'assetId',
  ])
    && value.kind === 'image'
    && isCanvasLifecycleId(value.projectId)
    && isCanvasLifecycleId(value.canvasId)
    && isCanvasLifecycleId(value.nodeId)
    && isCanvasLifecycleId(value.imageModuleId)
    && isCanvasLifecycleId(value.assetId)) {
    return {
      projectId: value.projectId,
      canvasId: value.canvasId,
      nodeId: value.nodeId,
      kind: 'image',
      imageModuleId: value.imageModuleId,
      assetId: value.assetId,
    }
  }
  throw new Error('CANVAS_ARTIFACT_EXPORT_INPUT_INVALID')
}

/** 从源节点创建下游节点时使用的稳定关系身份。 */
export interface CreateCanvasAgentNodeRelationship {
  sourceNodeId: string
  edgeId: string
  relation: CanvasEdgeRelation
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
 * 严格解析图片模块媒体授权释放输入。
 * @param value 待解析的 Renderer 输入。
 * @returns 完整图片身份与不可复用的媒体授权身份。
 */
export function parseReleaseCanvasImageMediaInput(value: unknown): ReleaseCanvasImageMediaInput {
  /** 媒体释放命令只允许完整目标和授权身份。 */
  const keys = ['projectId', 'canvasId', 'nodeId', 'imageModuleId', 'mediaLeaseId'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasLifecycleId(value.nodeId)
    || !isCanvasLifecycleId(value.imageModuleId)
    || !isCanvasLifecycleId(value.mediaLeaseId)) {
    throw new Error('CANVAS_IMAGE_MEDIA_RELEASE_INPUT_INVALID')
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    imageModuleId: value.imageModuleId,
    mediaLeaseId: value.mediaLeaseId,
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

/** 判断未知文本是否可安全进入图片公开快照。 */
function isCanvasImageSnapshotText(value: unknown, maxLength = CANVAS_IMAGE_PROMPT_MAX_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

/** 判断持久化相对路径不会泄漏绝对路径或越出受管目录。 */
function isCanvasImagePublicRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_024
    || value.startsWith('/') || value.includes('\\')) return false
  /** 相对路径逐段拒绝空段、当前目录和父目录。 */
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** 判断媒体授权根是有界的非 file URL，不接受本地绝对路径。 */
function isCanvasImageMediaBaseUrl(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 2_048
    && /^[a-z][a-z0-9+.-]*:\/\/[^\s/\\]+(?:\/[^\s\\]*)?$/iu.test(value)
    && !value.toLowerCase().startsWith('file://')
}

/** 严格重建图片快照中的公开素材元数据。 */
function parseCanvasImageSnapshotAsset(value: unknown): DesignAsset {
  /** 素材可选字段只在真实存在时加入 exact-key 合同。 */
  const optionalKeys = [
    'sourceSessionId', 'sourceJobId', 'prompt', 'parentAssetId',
  ].filter((key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key))
  const keys = [
    'id', 'filename', 'relativePath', 'thumbnailRelativePath', 'mediaType',
    'width', 'height', 'byteSize', 'sha256', 'createdAt', ...optionalKeys,
  ]
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.id)
    || !isCanvasImagePublicRelativePath(value.filename) || value.filename.includes('/')
    || !isCanvasImagePublicRelativePath(value.relativePath)
    || !isCanvasImagePublicRelativePath(value.thumbnailRelativePath)
    || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(value.mediaType))
    || !Number.isSafeInteger(value.width) || (value.width as number) < 1
    || !Number.isSafeInteger(value.height) || (value.height as number) < 1
    || !Number.isSafeInteger(value.byteSize) || (value.byteSize as number) < 0
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(value.sha256)
    || !isCanvasNonNegativeInteger(value.createdAt)
    || (Object.hasOwn(value, 'sourceSessionId') && !isCanvasLifecycleId(value.sourceSessionId))
    || (Object.hasOwn(value, 'sourceJobId') && !isCanvasLifecycleId(value.sourceJobId))
    || (Object.hasOwn(value, 'prompt') && !isCanvasImageSnapshotText(value.prompt))
    || (Object.hasOwn(value, 'parentAssetId') && !isCanvasLifecycleId(value.parentAssetId))) {
    throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  }
  return {
    id: value.id,
    filename: value.filename,
    relativePath: value.relativePath,
    thumbnailRelativePath: value.thumbnailRelativePath,
    mediaType: value.mediaType as DesignAsset['mediaType'],
    width: value.width as number,
    height: value.height as number,
    byteSize: value.byteSize as number,
    sha256: value.sha256,
    createdAt: value.createdAt,
    ...(Object.hasOwn(value, 'sourceSessionId') ? { sourceSessionId: value.sourceSessionId as string } : {}),
    ...(Object.hasOwn(value, 'sourceJobId') ? { sourceJobId: value.sourceJobId as string } : {}),
    ...(Object.hasOwn(value, 'prompt') ? { prompt: value.prompt as string } : {}),
    ...(Object.hasOwn(value, 'parentAssetId') ? { parentAssetId: value.parentAssetId as string } : {}),
  }
}

/** 严格重建图片任务固化的生图模型公开快照。 */
function parseCanvasImageModelSnapshot(value: unknown): ImageGenerationModelSnapshot {
  if (hasExactCanvasKeys(value, ['profileId', 'name', 'modelId', 'executor'])
    && isCanvasLifecycleId(value.profileId)
    && isCanvasImageSnapshotText(value.name, 128)
    && isCanvasImageSnapshotText(value.modelId, 256)
    && value.executor === 'nano-banana') {
    return { profileId: value.profileId, name: value.name, modelId: value.modelId, executor: 'nano-banana' }
  }
  if (hasExactCanvasKeys(value, ['profileId', 'name', 'modelId', 'executor', 'channelId'])
    && isCanvasLifecycleId(value.profileId)
    && isCanvasImageSnapshotText(value.name, 128)
    && isCanvasImageSnapshotText(value.modelId, 256)
    && value.executor === 'openai-images'
    && isCanvasLifecycleId(value.channelId)) {
    return {
      profileId: value.profileId, name: value.name, modelId: value.modelId,
      executor: 'openai-images', channelId: value.channelId,
    }
  }
  throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
}

/** 严格重建图片任务实际读取的单条创作上下文引用。 */
function parseCanvasImageContextReference(value: unknown): DesignContextReference {
  /** 上下文引用的两类可选定位字段按存在性纳入 exact-key。 */
  const optionalKeys = ['relativePath', 'assetId']
    .filter((key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key))
  const keys = ['id', 'category', 'sourceKind', 'label', 'purpose', 'readAt', ...optionalKeys]
  const categories = ['brand', 'product', 'code', 'character', 'story', 'scene', 'continuity', 'reference']
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.id)
    || !categories.includes(String(value.category))
    || !['project-file', 'context-document', 'design-asset'].includes(String(value.sourceKind))
    || !isCanvasImageSnapshotText(value.label, 1_024)
    || !isCanvasImageSnapshotText(value.purpose, 4_096)
    || !isCanvasNonNegativeInteger(value.readAt)
    || (Object.hasOwn(value, 'relativePath') && !isCanvasImagePublicRelativePath(value.relativePath))
    || (Object.hasOwn(value, 'assetId') && !isCanvasLifecycleId(value.assetId))) {
    throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  }
  return {
    id: value.id,
    category: value.category as DesignContextReference['category'],
    sourceKind: value.sourceKind as DesignContextReference['sourceKind'],
    label: value.label,
    purpose: value.purpose,
    readAt: value.readAt,
    ...(Object.hasOwn(value, 'relativePath') ? { relativePath: value.relativePath as string } : {}),
    ...(Object.hasOwn(value, 'assetId') ? { assetId: value.assetId as string } : {}),
  }
}

/** 严格重建图片任务的一条直接上游引用。 */
function parseCanvasImageSnapshotInputReference(value: unknown): CanvasImageInputReference {
  /** 新任务端口必须成对存在；旧任务允许两端同时缺失。 */
  const hasSourcePort = value !== null && typeof value === 'object' && Object.hasOwn(value, 'sourcePort')
  /** 目标端口存在性与来源端口必须完全一致。 */
  const hasTargetPort = value !== null && typeof value === 'object' && Object.hasOwn(value, 'targetPort')
  /** 只有图片上游允许额外携带 adopted 素材身份。 */
  const optionalKeys = [
    ...(value !== null && typeof value === 'object' && Object.hasOwn(value, 'assetId') ? ['assetId'] : []),
    ...(hasSourcePort ? ['sourcePort', 'targetPort'] : []),
  ]
  /** exact-key 合同按真实存在的可选字段构造。 */
  const keys = ['nodeId', 'kind', 'revision', 'summary', 'summaryHash', ...optionalKeys]
  if (!hasExactCanvasKeys(value, keys)
    || hasSourcePort !== hasTargetPort
    || !isCanvasLifecycleId(value.nodeId)
    || !['agent', 'image', 'document', 'webview'].includes(String(value.kind))
    || !isCanvasNonNegativeInteger(value.revision)
    || !isCanvasImageSnapshotText(value.summary, 8_192)
    || typeof value.summaryHash !== 'string' || !/^[0-9a-f]{64}$/iu.test(value.summaryHash)
    || (Object.hasOwn(value, 'assetId') && !isCanvasLifecycleId(value.assetId))
    || (hasSourcePort && !isCanvasArtifactOutputCapability(value.sourcePort))
    || (hasTargetPort && !isCanvasArtifactInputSlot(value.targetPort))) {
    throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  }
  return {
    nodeId: value.nodeId,
    kind: value.kind as CanvasNodeKind,
    revision: value.revision,
    summary: value.summary,
    summaryHash: value.summaryHash,
    ...(Object.hasOwn(value, 'assetId') ? { assetId: value.assetId as string } : {}),
    ...(hasSourcePort ? {
      sourcePort: value.sourcePort as CanvasArtifactOutputCapability,
      targetPort: value.targetPort as CanvasArtifactInputSlot,
    } : {}),
  }
}

/** 严格重建单个 Canvas 图片任务公开记录。 */
function parseCanvasImageSnapshotJob(value: unknown, target: CanvasImageTarget): DesignJobRecord {
  const optionalKeys = [
    'sessionId', 'generationConstraints', 'canvasInputReferences', 'canvasImageConfigRevision',
    'candidateBatchId',
    'sourceAgentMessageId', 'imageModelSnapshot', 'sourceSessionId', 'sourceAssetId',
    'parentAssetId', 'outputAssetId', 'error', 'traceState', 'executionSessionCleanupState',
    'startedAt', 'completedAt', 'contextReferences', 'designSummary', 'finalImagePrompt',
    'rawThinkingAvailable', 'contextWarning',
  ].filter((key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key))
  const keys = [
    'id', 'creativeTaskId', 'attemptNumber', 'projectId', 'target', 'action', 'status',
    'prompt', 'originalRequest', 'contextMode', 'createdAt', 'updatedAt', ...optionalKeys,
  ]
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.id)
    || !isCanvasLifecycleId(value.creativeTaskId)
    || !Number.isSafeInteger(value.attemptNumber) || (value.attemptNumber as number) < 1
    || value.projectId !== target.projectId
    || !hasExactCanvasKeys(value.target, ['kind', 'canvasId', 'nodeId', 'imageModuleId'])
    || value.target.kind !== 'canvas-image'
    || value.target.canvasId !== target.canvasId
    || value.target.nodeId !== target.nodeId
    || value.target.imageModuleId !== target.imageModuleId
    || !['generate', 'edit'].includes(String(value.action))
    || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(value.status))
    || !isCanvasImageSnapshotText(value.prompt)
    || !isCanvasImageSnapshotText(value.originalRequest)
    || !isCanvasImageContextMode(value.contextMode)
    || !isCanvasNonNegativeInteger(value.createdAt)
    || !isCanvasNonNegativeInteger(value.updatedAt)) {
    throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  }
  /** 可选 ID 字段统一使用稳定身份边界。 */
  for (const key of [
    'sessionId', 'sourceAgentMessageId', 'sourceSessionId', 'sourceAssetId',
    'parentAssetId', 'outputAssetId', 'candidateBatchId',
  ]) {
    if (Object.hasOwn(value, key) && !isCanvasLifecycleId(value[key])) {
      throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    }
  }
  if (Object.hasOwn(value, 'generationConstraints')
    && (!hasExactCanvasKeys(value.generationConstraints, ['aspectRatio', 'imageSize'])
      || !isCanvasImageAspectRatio(value.generationConstraints.aspectRatio)
      || !isCanvasImageSize(value.generationConstraints.imageSize))) {
    throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  }
  if (Object.hasOwn(value, 'canvasInputReferences')
    && (!Array.isArray(value.canvasInputReferences) || value.canvasInputReferences.length > 32)) {
    throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  }
  /** 上游引用逐项严格重建。 */
  const canvasInputReferences = Object.hasOwn(value, 'canvasInputReferences')
    ? (value.canvasInputReferences as unknown[]).map(parseCanvasImageSnapshotInputReference)
    : undefined
  if (Object.hasOwn(value, 'canvasImageConfigRevision')
    && !isCanvasNonNegativeInteger(value.canvasImageConfigRevision)) {
    throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  }
  /** 固化模型只在字段存在时解析。 */
  const imageModelSnapshot = Object.hasOwn(value, 'imageModelSnapshot')
    ? parseCanvasImageModelSnapshot(value.imageModelSnapshot)
    : undefined
  if ((Object.hasOwn(value, 'error') && !isCanvasImageSnapshotText(value.error))
    || (Object.hasOwn(value, 'traceState') && !['pending', 'ready', 'unavailable'].includes(String(value.traceState)))
    || (Object.hasOwn(value, 'executionSessionCleanupState') && !['pending', 'completed'].includes(String(value.executionSessionCleanupState)))
    || (Object.hasOwn(value, 'startedAt') && !isCanvasNonNegativeInteger(value.startedAt))
    || (Object.hasOwn(value, 'completedAt') && !isCanvasNonNegativeInteger(value.completedAt))
    || (Object.hasOwn(value, 'designSummary') && !isCanvasImageSnapshotText(value.designSummary))
    || (Object.hasOwn(value, 'finalImagePrompt') && !isCanvasImageSnapshotText(value.finalImagePrompt))
    || (Object.hasOwn(value, 'rawThinkingAvailable') && typeof value.rawThinkingAvailable !== 'boolean')
    || (Object.hasOwn(value, 'contextWarning') && !isCanvasImageSnapshotText(value.contextWarning))) {
    throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  }
  if (Object.hasOwn(value, 'contextReferences')
    && (!Array.isArray(value.contextReferences) || value.contextReferences.length > 256)) {
    throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  }
  /** 创作上下文逐项严格重建。 */
  const contextReferences = Object.hasOwn(value, 'contextReferences')
    ? (value.contextReferences as unknown[]).map(parseCanvasImageContextReference)
    : undefined
  return {
    id: value.id,
    creativeTaskId: value.creativeTaskId,
    attemptNumber: value.attemptNumber as number,
    projectId: value.projectId,
    target: { kind: 'canvas-image', canvasId: target.canvasId, nodeId: target.nodeId, imageModuleId: target.imageModuleId },
    action: value.action as DesignJobRecord['action'],
    status: value.status as DesignJobRecord['status'],
    prompt: value.prompt,
    originalRequest: value.originalRequest,
    contextMode: value.contextMode,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(Object.hasOwn(value, 'sessionId') ? { sessionId: value.sessionId as string } : {}),
    ...(Object.hasOwn(value, 'generationConstraints') ? { generationConstraints: {
      aspectRatio: (value.generationConstraints as Record<string, unknown>).aspectRatio as CanvasImageAspectRatio,
      imageSize: (value.generationConstraints as Record<string, unknown>).imageSize as CanvasImageSize,
    } } : {}),
    ...(canvasInputReferences === undefined ? {} : { canvasInputReferences }),
    ...(Object.hasOwn(value, 'canvasImageConfigRevision') ? { canvasImageConfigRevision: value.canvasImageConfigRevision as number } : {}),
    ...(Object.hasOwn(value, 'candidateBatchId') ? { candidateBatchId: value.candidateBatchId as string } : {}),
    ...(Object.hasOwn(value, 'sourceAgentMessageId') ? { sourceAgentMessageId: value.sourceAgentMessageId as string } : {}),
    ...(imageModelSnapshot === undefined ? {} : { imageModelSnapshot }),
    ...(Object.hasOwn(value, 'sourceSessionId') ? { sourceSessionId: value.sourceSessionId as string } : {}),
    ...(Object.hasOwn(value, 'sourceAssetId') ? { sourceAssetId: value.sourceAssetId as string } : {}),
    ...(Object.hasOwn(value, 'parentAssetId') ? { parentAssetId: value.parentAssetId as string } : {}),
    ...(Object.hasOwn(value, 'outputAssetId') ? { outputAssetId: value.outputAssetId as string } : {}),
    ...(Object.hasOwn(value, 'error') ? { error: value.error as string } : {}),
    ...(Object.hasOwn(value, 'traceState') ? { traceState: value.traceState as DesignJobRecord['traceState'] } : {}),
    ...(Object.hasOwn(value, 'executionSessionCleanupState') ? { executionSessionCleanupState: value.executionSessionCleanupState as DesignJobRecord['executionSessionCleanupState'] } : {}),
    ...(Object.hasOwn(value, 'startedAt') ? { startedAt: value.startedAt as number } : {}),
    ...(Object.hasOwn(value, 'completedAt') ? { completedAt: value.completedAt as number } : {}),
    ...(contextReferences === undefined ? {} : { contextReferences }),
    ...(Object.hasOwn(value, 'designSummary') ? { designSummary: value.designSummary as string } : {}),
    ...(Object.hasOwn(value, 'finalImagePrompt') ? { finalImagePrompt: value.finalImagePrompt as string } : {}),
    ...(Object.hasOwn(value, 'rawThinkingAvailable') ? { rawThinkingAvailable: value.rawThinkingAvailable as boolean } : {}),
    ...(Object.hasOwn(value, 'contextWarning') ? { contextWarning: value.contextWarning as string } : {}),
  }
}

/** 严格重建主进程公开的图片版本投影。 */
function parseCanvasImageArtifactVersion(value: unknown): CanvasImageArtifactVersion {
  if (!hasExactCanvasKeys(value, ['jobId', 'assetId', 'createdAt'])
    || !isCanvasLifecycleId(value.jobId)
    || !isCanvasLifecycleId(value.assetId)
    || !isCanvasNonNegativeInteger(value.createdAt)) {
    throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  }
  return { jobId: value.jobId, assetId: value.assetId, createdAt: value.createdAt }
}

/**
 * 严格解析 Renderer 可见的单图片模块完整快照。
 * @param value 主进程或 Preload 返回的未知值。
 * @returns exact-key、深隔离且版本关系完整的公开快照。
 */
export function parseCanvasImageModuleSnapshot(value: unknown): CanvasImageModuleSnapshot {
  try {
    const keys = [
      'target', 'mediaLeaseId', 'config', 'jobs', 'assets', 'imageVersions',
      'assetBaseUrl', 'thumbnailBaseUrl',
    ] as const
    if (!hasExactCanvasKeys(value, keys)
      || !isCanvasLifecycleId(value.mediaLeaseId)
      || !Array.isArray(value.jobs)
      || !Array.isArray(value.assets)
      || !Array.isArray(value.imageVersions)
      || value.imageVersions.length > 100
      || !isCanvasImageMediaBaseUrl(value.assetBaseUrl)
      || !isCanvasImageMediaBaseUrl(value.thumbnailBaseUrl)) {
      throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    }
    /** 图片目标与配置先严格重建，再作为任务和 adopted 关系的基线。 */
    const target = parseCanvasImageTarget(value.target)
    const config = parseCanvasImageModuleConfig(value.config)
    if (config.contentId !== target.imageModuleId) throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    /** 任务、素材和版本均逐项重建，拒绝保留输入对象引用。 */
    const jobs = value.jobs.map((job) => parseCanvasImageSnapshotJob(job, target))
    const assets = value.assets.map(parseCanvasImageSnapshotAsset)
    const imageVersions = value.imageVersions.map(parseCanvasImageArtifactVersion)
    /** 同轮公开事实内任务和素材身份必须各自唯一。 */
    const jobsById = new Map(jobs.map((job) => [job.id, job]))
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
    if (jobsById.size !== jobs.length || assetsById.size !== assets.length) {
      throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    }
    /** 每个输出素材只能由一个目标任务声明，并进入公开资产闭包。 */
    const ownerByAssetId = new Map<string, DesignJobRecord>()
    const visibleAssetIds = new Set<string>()
    for (const job of jobs) {
      /** generate 无父链；edit 必须从同一现存父素材派生。 */
      if (job.action === 'generate') {
        if (job.sourceAssetId !== undefined || job.parentAssetId !== undefined) {
          throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
        }
      } else if (!job.sourceAssetId
        || job.parentAssetId !== job.sourceAssetId
        || !assetsById.has(job.sourceAssetId)) {
        throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
      }
      if (!job.outputAssetId) continue
      if (ownerByAssetId.has(job.outputAssetId)) {
        throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
      }
      ownerByAssetId.set(job.outputAssetId, job)
      visibleAssetIds.add(job.outputAssetId)
    }
    /** 任务声明输出时必须与素材 sourceJobId 和 parentAssetId 双向一致。 */
    for (const [outputAssetId, job] of ownerByAssetId) {
      const asset = assetsById.get(outputAssetId)
      if (!asset
        || asset.sourceJobId !== job.id
        || asset.parentAssetId !== job.parentAssetId) {
        throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
      }
    }
    /** adopted 素材是第二个可信根，其完整祖先链必须存在、无环且有界。 */
    if (config.adoptedAssetId !== null) {
      const lineageVisited = new Set<string>()
      let currentAssetId: string | undefined = config.adoptedAssetId
      let lineageDepth = 0
      while (currentAssetId !== undefined) {
        if (lineageDepth >= 256 || lineageVisited.has(currentAssetId)) {
          throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
        }
        const asset = assetsById.get(currentAssetId)
        if (!asset) throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
        lineageVisited.add(currentAssetId)
        visibleAssetIds.add(currentAssetId)
        currentAssetId = asset.parentAssetId
        lineageDepth += 1
      }
    }
    /** 快照不得夹带目标任务输出或 adopted 祖先闭包之外的孤儿素材。 */
    if (assets.some((asset) => !visibleAssetIds.has(asset.id))) {
      throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    }
    /** 版本内 jobId 和 assetId 分别唯一，避免歧义历史项。 */
    const versionJobIds = new Set(imageVersions.map((version) => version.jobId))
    const versionAssetIds = new Set(imageVersions.map((version) => version.assetId))
    if (versionJobIds.size !== imageVersions.length || versionAssetIds.size !== imageVersions.length) {
      throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    }
    for (const version of imageVersions) {
      const job = jobsById.get(version.jobId)
      const asset = assetsById.get(version.assetId)
      if (!job || job.status !== 'succeeded' || job.outputAssetId !== version.assetId
        || !asset || asset.sourceJobId !== version.jobId || asset.createdAt !== version.createdAt) {
        throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
      }
    }
    /** 主进程稳定排序为时间倒序，平局按 assetId、jobId 升序。 */
    for (let index = 1; index < imageVersions.length; index += 1) {
      const previous = imageVersions[index - 1]!
      const current = imageVersions[index]!
      const order = previous.createdAt === current.createdAt
        ? previous.assetId.localeCompare(current.assetId) || previous.jobId.localeCompare(current.jobId)
        : current.createdAt - previous.createdAt
      if (order > 0) throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    }
    return {
      target,
      mediaLeaseId: value.mediaLeaseId,
      config,
      jobs,
      assets,
      imageVersions,
      assetBaseUrl: value.assetBaseUrl,
      thumbnailBaseUrl: value.thumbnailBaseUrl,
    }
  } catch (error) {
    throw new Error('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID', { cause: error })
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

/** 判断未知值是否为 Canvas 支持的节点类别。 */
function isCanvasNodeKind(value: unknown): value is CanvasNodeKind {
  return value === 'agent' || value === 'image' || value === 'document' || value === 'webview'
}

/**
 * 严格解析 Agent-Canvas 关联记录并规范化重复画布 ID。
 * @param value 待解析的持久化或 IPC 输出值。
 * @returns 画布 ID 去重且默认/最近画布均属于关联集合的记录。
 */
export function parseAgentCanvasBinding(value: unknown): AgentCanvasBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AGENT_CANVAS_BINDING_INVALID')
  }
  /** 关联记录通过普通字段集合支持两个可选画布身份。 */
  const binding = value as Record<string, unknown>
  /** 关联记录允许的完整字段集合。 */
  const allowedKeys = [
    'projectId', 'sessionId', 'defaultCanvasId', 'linkedCanvasIds', 'lastActiveCanvasId', 'updatedAt',
  ] as const
  /** 关联记录实际字段用于拒绝未知字段并检查必填项。 */
  const actualKeys = Object.keys(binding)
  if (!actualKeys.every((key) => allowedKeys.includes(key as typeof allowedKeys[number]))
    || !Object.hasOwn(binding, 'projectId')
    || !Object.hasOwn(binding, 'sessionId')
    || !Object.hasOwn(binding, 'linkedCanvasIds')
    || !Object.hasOwn(binding, 'updatedAt')
    || !isCanvasLifecycleId(binding.projectId)
    || !isCanvasLifecycleId(binding.sessionId)
    || !Array.isArray(binding.linkedCanvasIds)
    || !binding.linkedCanvasIds.every(isCanvasLifecycleId)
    || !isCanvasNonNegativeInteger(binding.updatedAt)
    || (binding.defaultCanvasId !== undefined && !isCanvasLifecycleId(binding.defaultCanvasId))
    || (binding.lastActiveCanvasId !== undefined && !isCanvasLifecycleId(binding.lastActiveCanvasId))) {
    throw new Error('AGENT_CANVAS_BINDING_INVALID')
  }
  /** 关联画布按首现顺序去重，保持 UI 稳定排序。 */
  const linkedCanvasIds = [...new Set(binding.linkedCanvasIds)]
  if ((binding.defaultCanvasId !== undefined && !linkedCanvasIds.includes(binding.defaultCanvasId))
    || (binding.lastActiveCanvasId !== undefined && !linkedCanvasIds.includes(binding.lastActiveCanvasId))) {
    throw new Error('AGENT_CANVAS_BINDING_INVALID')
  }
  return {
    projectId: binding.projectId,
    sessionId: binding.sessionId,
    ...(binding.defaultCanvasId === undefined ? {} : { defaultCanvasId: binding.defaultCanvasId }),
    linkedCanvasIds,
    ...(binding.lastActiveCanvasId === undefined ? {} : { lastActiveCanvasId: binding.lastActiveCanvasId }),
    updatedAt: binding.updatedAt,
  }
}

/** 严格解析关联记录数组，供 LIST IPC 输出边界复用。 */
export function parseAgentCanvasBindings(value: unknown): AgentCanvasBinding[] {
  if (!Array.isArray(value)) throw new Error('AGENT_CANVAS_BINDINGS_INVALID')
  return value.map(parseAgentCanvasBinding)
}

/** 严格解析 Agent-Canvas 关联变化事件，拒绝额外字段和内部信息。 */
export function parseAgentCanvasBindingChangeEvent(value: unknown): AgentCanvasBindingChangeEvent {
  const keys = ['projectId', 'sessionId', 'cause', 'binding'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.sessionId)
    || !isAgentCanvasBindingChangeCause(value.cause)) {
    throw new Error('AGENT_CANVAS_BINDING_CHANGE_EVENT_INVALID')
  }
  const binding = value.binding === null ? null : parseAgentCanvasBinding(value.binding)
  if (binding && (binding.projectId !== value.projectId || binding.sessionId !== value.sessionId)) {
    throw new Error('AGENT_CANVAS_BINDING_CHANGE_EVENT_INVALID')
  }
  return {
    projectId: value.projectId,
    sessionId: value.sessionId,
    cause: value.cause,
    binding,
  }
}

/** 判断值是否为允许跨 IPC 广播的关联变更原因。 */
function isAgentCanvasBindingChangeCause(value: unknown): value is AgentCanvasBindingChangeCause {
  return value === 'linked'
    || value === 'unlinked'
    || value === 'default-changed'
    || value === 'session-cleared'
    || value === 'canvas-cleared'
}

/** 严格解析一条对话持有的 Canvas 节点引用。 */
export function parseCanvasNodeReference(value: unknown): CanvasNodeReference {
  /** 节点引用允许的完整字段集合。 */
  const keys = ['projectId', 'canvasId', 'nodeId', 'nodeType', 'nodeRevision', 'title'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasLifecycleId(value.nodeId)
    || !isCanvasNodeKind(value.nodeType)
    || !isCanvasNonNegativeInteger(value.nodeRevision)
    || !isCanvasLifecycleTitle(value.title)) {
    throw new Error('CANVAS_NODE_REFERENCE_INVALID')
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    nodeType: value.nodeType,
    nodeRevision: value.nodeRevision,
    title: value.title,
  }
}

/** 单条 Agent 消息允许携带的 Canvas 节点引用数量上限。 */
export const CANVAS_NODE_REFERENCE_MAX_COUNT = 32

/** 严格解析 Canvas 节点引用数组。 */
export function parseCanvasNodeReferences(value: unknown): CanvasNodeReference[] {
  if (!Array.isArray(value) || value.length > CANVAS_NODE_REFERENCE_MAX_COUNT) {
    throw new Error('CANVAS_NODE_REFERENCES_INVALID')
  }
  return value.map(parseCanvasNodeReference)
}

/**
 * 递归重建 Canvas 命令外壳中的 plain JSON 值。
 * @param value 待隔离的未知 operation 值。
 * @param active 当前递归路径中的对象，用于拒绝循环引用。
 * @returns 与调用方引用完全隔离的 JSON 值。
 */
function cloneCanvasJsonValue(value: unknown, active: Set<object>): CanvasJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CANVAS_BATCH_OPERATION_ENVELOPE_INVALID')
    return value
  }
  if (typeof value !== 'object') throw new Error('CANVAS_BATCH_OPERATION_ENVELOPE_INVALID')
  if (active.has(value)) throw new Error('CANVAS_BATCH_OPERATION_ENVELOPE_INVALID')
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error('CANVAS_BATCH_OPERATION_ENVELOPE_INVALID')
    }
    /** 数组描述符用于拒绝空洞、accessor 与额外字符串属性。 */
    const descriptors = Object.getOwnPropertyDescriptors(value)
    /** 数组只允许 length 与从 0 连续到末尾的索引。 */
    const allowedKeys = new Set([
      'length',
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ])
    if (Object.keys(descriptors).some((key) => !allowedKeys.has(key))) {
      throw new Error('CANVAS_BATCH_OPERATION_ENVELOPE_INVALID')
    }
    active.add(value)
    try {
      /** 隔离后的数组按索引顺序重建。 */
      const clone: CanvasJsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        /** 当前索引必须是可枚举的数据字段。 */
        const descriptor = descriptors[String(index)]
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('CANVAS_BATCH_OPERATION_ENVELOPE_INVALID')
        }
        clone.push(cloneCanvasJsonValue(descriptor.value, active))
      }
      return clone
    } finally {
      active.delete(value)
    }
  }
  /** 自定义类、Date 与其它原型对象不属于 plain JSON。 */
  const prototype = Object.getPrototypeOf(value)
  if ((prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('CANVAS_BATCH_OPERATION_ENVELOPE_INVALID')
  }
  /** 对象描述符用于拒绝 accessor 与不可枚举隐藏状态。 */
  const descriptors = Object.getOwnPropertyDescriptors(value)
  /** 重建对象通过数据属性写入，避免 __proto__ 键触发原型 setter。 */
  const clone: CanvasJsonObject = {}
  active.add(value)
  try {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('CANVAS_BATCH_OPERATION_ENVELOPE_INVALID')
      }
      Object.defineProperty(clone, key, {
        value: cloneCanvasJsonValue(descriptor.value, active),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return clone
  } finally {
    active.delete(value)
  }
}

/** 严格解析 Agent 工具批量修改的 JSON 外壳，不声称 mutation 已验证。 */
export function parseCanvasBatchOperationEnvelope(value: unknown): CanvasBatchOperationEnvelope {
  /** 批量修改命令允许的完整字段集合。 */
  const keys = [
    'projectId', 'canvasId', 'baseRevision', 'operations',
    'sourceSessionId', 'sourceRunStartedAt', 'sourceToolCallId',
  ] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasNonNegativeInteger(value.baseRevision)
    || !Array.isArray(value.operations)
    || !isCanvasLifecycleId(value.sourceSessionId)
    || !isCanvasNonNegativeInteger(value.sourceRunStartedAt)
    || !isCanvasLifecycleId(value.sourceToolCallId)) {
    throw new Error('CANVAS_BATCH_OPERATION_ENVELOPE_INVALID')
  }
  /**
   * operation 在进入 Task 8 前只作为隔离后的 JSON；CanvasDocumentStore 必须权威校验
   * 完整 mutation schema、重复 ID 与图引用语义，再构造 CanvasBatchOperationInput。
   */
  const operations = value.operations.map((operation) => cloneCanvasJsonValue(operation, new Set()))
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    baseRevision: value.baseRevision,
    operations,
    sourceSessionId: value.sourceSessionId,
    sourceRunStartedAt: value.sourceRunStartedAt,
    sourceToolCallId: value.sourceToolCallId,
  }
}

/** 严格解析 Agent 工具执行 Canvas 节点的输入。 */
export function parseCanvasRunNodesInput(value: unknown): CanvasRunNodesInput {
  /** 节点执行命令允许的完整字段集合。 */
  const keys = [
    'projectId', 'canvasId', 'nodeIds', 'sourceSessionId', 'sourceRunStartedAt', 'sourceToolCallId',
  ] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !Array.isArray(value.nodeIds)
    || !value.nodeIds.every(isCanvasLifecycleId)
    || !isCanvasLifecycleId(value.sourceSessionId)
    || !isCanvasNonNegativeInteger(value.sourceRunStartedAt)
    || !isCanvasLifecycleId(value.sourceToolCallId)) {
    throw new Error('CANVAS_RUN_NODES_INPUT_INVALID')
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeIds: [...value.nodeIds],
    sourceSessionId: value.sourceSessionId,
    sourceRunStartedAt: value.sourceRunStartedAt,
    sourceToolCallId: value.sourceToolCallId,
  }
}

/** 严格解析项目关联列表输入。 */
export function parseListAgentCanvasBindingsInput(value: unknown): ListAgentCanvasBindingsInput {
  if (!hasExactCanvasKeys(value, ['projectId']) || !isCanvasLifecycleId(value.projectId)) {
    throw new Error('LIST_AGENT_CANVAS_BINDINGS_INPUT_INVALID')
  }
  return { projectId: value.projectId }
}

/** 严格解析项目关联列表输出。 */
export function parseListAgentCanvasBindingsResult(value: unknown): ListAgentCanvasBindingsResult {
  return parseAgentCanvasBindings(value)
}

/** 严格解析包含项目、会话与 Canvas 身份的关联命令。 */
function parseAgentCanvasTarget(value: unknown, errorCode: string): UnlinkAgentCanvasInput {
  /** 关联命令允许的完整字段集合。 */
  const keys = ['projectId', 'sessionId', 'canvasId'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.sessionId)
    || !isCanvasLifecycleId(value.canvasId)) {
    throw new Error(errorCode)
  }
  return { projectId: value.projectId, sessionId: value.sessionId, canvasId: value.canvasId }
}

/** 严格解析建立 Agent-Canvas 关联的输入。 */
export function parseLinkAgentCanvasInput(value: unknown): LinkAgentCanvasInput {
  /** 建立关联必须显式声明是否设为默认画布。 */
  const keys = ['projectId', 'sessionId', 'canvasId', 'makeDefault'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.sessionId)
    || !isCanvasLifecycleId(value.canvasId)
    || typeof value.makeDefault !== 'boolean') {
    throw new Error('LINK_AGENT_CANVAS_INPUT_INVALID')
  }
  return {
    projectId: value.projectId,
    sessionId: value.sessionId,
    canvasId: value.canvasId,
    makeDefault: value.makeDefault,
  }
}

/** 严格解析建立 Agent-Canvas 关联的输出。 */
export function parseLinkAgentCanvasResult(value: unknown): LinkAgentCanvasResult {
  return parseAgentCanvasBinding(value)
}

/** 严格解析解除 Agent-Canvas 关联的输入。 */
export function parseUnlinkAgentCanvasInput(value: unknown): UnlinkAgentCanvasInput {
  return parseAgentCanvasTarget(value, 'UNLINK_AGENT_CANVAS_INPUT_INVALID')
}

/** 严格解析解除 Agent-Canvas 关联的输出。 */
export function parseUnlinkAgentCanvasResult(value: unknown): UnlinkAgentCanvasResult {
  return value === null ? null : parseAgentCanvasBinding(value)
}

/** 严格解析设置默认 Agent Canvas 的输入。 */
export function parseSetDefaultAgentCanvasInput(value: unknown): SetDefaultAgentCanvasInput {
  return parseAgentCanvasTarget(value, 'SET_DEFAULT_AGENT_CANVAS_INPUT_INVALID')
}

/** 严格解析设置默认 Agent Canvas 的输出。 */
export function parseSetDefaultAgentCanvasResult(value: unknown): SetDefaultAgentCanvasResult {
  return parseAgentCanvasBinding(value)
}

/** 严格解析按会话或 Canvas 清空关联的判别输入。 */
export function parseClearAgentCanvasBindingsInput(value: unknown): ClearAgentCanvasBindingsInput {
  if (hasExactCanvasKeys(value, ['projectId', 'target', 'sessionId'])
    && isCanvasLifecycleId(value.projectId)
    && value.target === 'session'
    && isCanvasLifecycleId(value.sessionId)) {
    return { projectId: value.projectId, target: 'session', sessionId: value.sessionId }
  }
  if (hasExactCanvasKeys(value, ['projectId', 'target', 'canvasId'])
    && isCanvasLifecycleId(value.projectId)
    && value.target === 'canvas'
    && isCanvasLifecycleId(value.canvasId)) {
    return { projectId: value.projectId, target: 'canvas', canvasId: value.canvasId }
  }
  throw new Error('CLEAR_AGENT_CANVAS_BINDINGS_INPUT_INVALID')
}

/** 严格解析无业务数据的清空关联输出。 */
export function parseClearAgentCanvasBindingsResult(value: unknown): ClearAgentCanvasBindingsResult {
  if (value !== undefined) throw new Error('CLEAR_AGENT_CANVAS_BINDINGS_RESULT_INVALID')
}

/** 严格解析可选的右侧扩展关系。 */
function parseCanvasLifecycleRelationship(value: unknown): CreateCanvasAgentNodeRelationship | undefined {
  if (value === undefined) return undefined
  if (!hasExactCanvasKeys(value, ['sourceNodeId', 'edgeId', 'relation'])
    || !isCanvasLifecycleId(value.sourceNodeId)
    || !isCanvasLifecycleId(value.edgeId)) {
    throw new Error('CANVAS_RELATIONSHIP_INVALID')
  }
  try {
    return {
      sourceNodeId: value.sourceNodeId,
      edgeId: value.edgeId,
      relation: parseCanvasEdgeRelation(value.relation),
    }
  } catch (error) {
    throw new Error('CANVAS_RELATIONSHIP_INVALID', { cause: error })
  }
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
  /** 已验证素材的原始像素宽度，用于 Renderer 稳定计算预览比例。 */
  width: number
  /** 已验证素材的原始像素高度，用于 Renderer 稳定计算预览比例。 */
  height: number
}

/** Renderer 可见的原生 Canvas 工作区快照，不暴露路径或存储实现。 */
export interface CanvasWorkspaceSnapshot {
  document: CanvasDocument
  writable: true
  nodeIssues: CanvasNodeIssue[]
  /** LOAD 提供当前 Canvas 已采用素材的共享缩略图；生命周期旧结果可暂不携带。 */
  imagePreviews?: CanvasImagePreview[]
  /** 仅包含有限活跃摘要；完整条目由独立 IPC 按需读取。 */
  activeImageCandidateBatches?: CanvasImageCandidateBatchSummary[]
  recoveredFrom?: 'tmp' | 'backup'
}

/** 严格重建节点的有限上游变化提示。 */
function parseCanvasNodeUpstreamChange(value: unknown): CanvasNodeUpstreamChange | undefined {
  if (value === undefined) return undefined
  if (!hasExactCanvasKeys(value, ['sourceNodeIds', 'changedAt'])
    || !Array.isArray(value.sourceNodeIds)
    || value.sourceNodeIds.length < 1
    || value.sourceNodeIds.length > 128
    || !value.sourceNodeIds.every(isCanvasLifecycleId)
    || new Set(value.sourceNodeIds).size !== value.sourceNodeIds.length
    || !isCanvasNonNegativeInteger(value.changedAt)) {
    throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
  }
  /** 规范化后的上游 ID 必须已经按稳定次序持久化。 */
  const sourceNodeIds = [...value.sourceNodeIds] as string[]
  if (sourceNodeIds.some((nodeId, index) => index > 0 && sourceNodeIds[index - 1]!.localeCompare(nodeId) >= 0)) {
    throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
  }
  return { sourceNodeIds, changedAt: value.changedAt }
}

/** 严格重建工作区快照中的单个 Canvas 节点。 */
function parseCanvasWorkspaceNode(value: unknown): CanvasNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
  }
  /** 节点记录用于按互斥 kind 选择唯一 exact-key 合同。 */
  const record = value as Record<string, unknown>
  /** 四类节点共享的展示与布局字段。 */
  const baseKeys = Object.hasOwn(record, 'upstreamChange')
    ? ['id', 'kind', 'title', 'position', 'upstreamChange'] as const
    : ['id', 'kind', 'title', 'position'] as const
  if (!isCanvasLifecycleId(record.id)
    || !isCanvasLifecycleTitle(record.title)
    || !isCanvasLifecyclePosition(record.position)) {
    throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
  }
  /** 已深拷贝的共享节点字段，避免 Renderer 保留 IPC 输入引用。 */
  /** 可选变化提示在所有节点类别使用同一严格合同。 */
  const upstreamChange = parseCanvasNodeUpstreamChange(record.upstreamChange)
  const base = {
    id: record.id,
    title: record.title,
    position: { x: record.position.x, y: record.position.y },
    ...(upstreamChange ? { upstreamChange } : {}),
  }
  if (record.kind === 'agent'
    && hasExactCanvasKeys(record, [...baseKeys, 'agentSessionId'])
    && isCanvasLifecycleId(record.agentSessionId)) {
    return { ...base, kind: 'agent', agentSessionId: record.agentSessionId }
  }
  if (record.kind === 'image') {
    /** 图片节点仅允许可选 adoptedAssetId，不接受其它内容身份字段。 */
    const imageKeys = Object.hasOwn(record, 'adoptedAssetId')
      ? [...baseKeys, 'imageModuleId', 'adoptedAssetId']
      : [...baseKeys, 'imageModuleId']
    if (hasExactCanvasKeys(record, imageKeys)
      && isCanvasLifecycleId(record.imageModuleId)
      && (record.adoptedAssetId === undefined || isCanvasLifecycleId(record.adoptedAssetId))) {
      return {
        ...base,
        kind: 'image',
        imageModuleId: record.imageModuleId,
        ...(record.adoptedAssetId === undefined ? {} : { adoptedAssetId: record.adoptedAssetId }),
      }
    }
  }
  if (record.kind === 'document'
    && hasExactCanvasKeys(record, [...baseKeys, 'documentId', 'contentRevision'])
    && isCanvasLifecycleId(record.documentId)
    && isCanvasNonNegativeInteger(record.contentRevision)) {
    return {
      ...base,
      kind: 'document',
      documentId: record.documentId,
      contentRevision: record.contentRevision,
    }
  }
  if (record.kind === 'webview'
    && hasExactCanvasKeys(record, [...baseKeys, 'prototypeId', 'contentRevision', 'devicePreset'])
    && isCanvasLifecycleId(record.prototypeId)
    && isCanvasNonNegativeInteger(record.contentRevision)
    && (record.devicePreset === 'desktop' || record.devicePreset === 'mobile')) {
    return {
      ...base,
      kind: 'webview',
      prototypeId: record.prototypeId,
      contentRevision: record.contentRevision,
      devicePreset: record.devicePreset,
    }
  }
  throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
}

/** 严格重建工作区快照中的单条 Canvas 关系边。 */
function parseCanvasWorkspaceEdge(value: unknown, nodeIds: ReadonlySet<string>): CanvasEdge {
  /** 关系边允许的完整公开字段集合。 */
  const keys = ['id', 'sourceNodeId', 'sourcePort', 'targetNodeId', 'targetPort', 'relation'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.id)
    || !isCanvasLifecycleId(value.sourceNodeId)
    || !isCanvasLifecycleId(value.sourcePort)
    || !isCanvasLifecycleId(value.targetNodeId)
    || !isCanvasLifecycleId(value.targetPort)
    || !nodeIds.has(value.sourceNodeId)
    || !nodeIds.has(value.targetNodeId)) {
    throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
  }
  return {
    id: value.id,
    sourceNodeId: value.sourceNodeId,
    sourcePort: value.sourcePort,
    targetNodeId: value.targetNodeId,
    targetPort: value.targetPort,
    relation: parseCanvasEdgeRelation(value.relation),
  }
}

/** 严格重建工作区快照中的公开节点问题。 */
function parseCanvasWorkspaceNodeIssue(
  value: unknown,
  agentNodeIds: ReadonlySet<string>,
): CanvasNodeIssue {
  /** 节点问题只允许稳定节点身份、固定错误码和恢复动作。 */
  const keys = ['nodeId', 'code', 'allowedActions'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.nodeId)
    || !agentNodeIds.has(value.nodeId)
    || value.code !== 'AGENT_SESSION_UNAVAILABLE'
    || !Array.isArray(value.allowedActions)
    || value.allowedActions.some((action) => (
      action !== 'rebuild-agent-session' && action !== 'remove-node'
    ))
    || new Set(value.allowedActions).size !== value.allowedActions.length) {
    throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
  }
  return {
    nodeId: value.nodeId,
    code: 'AGENT_SESSION_UNAVAILABLE',
    allowedActions: value.allowedActions.map((action) => action as CanvasNodeIssueAction),
  }
}

/** 严格重建工作区快照中的公开图片预览。 */
function parseCanvasWorkspaceImagePreview(value: unknown): CanvasImagePreview {
  /** 图片预览禁止携带本地路径，仅允许媒体 URL 和正像素尺寸。 */
  const keys = ['assetId', 'previewUrl', 'width', 'height'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.assetId)
    || typeof value.previewUrl !== 'string'
    || !Number.isSafeInteger(value.width) || (value.width as number) <= 0
    || !Number.isSafeInteger(value.height) || (value.height as number) <= 0) {
    throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
  }
  return {
    assetId: value.assetId,
    previewUrl: value.previewUrl,
    width: value.width as number,
    height: value.height as number,
  }
}

/** 严格重建工作区快照中的 schema v4 Canvas 文档。 */
function parseCanvasWorkspaceDocument(value: unknown): CanvasDocument {
  /** Canvas 文档只允许当前 v4 的完整公开字段集合。 */
  const keys = [
    'schemaVersion', 'projectId', 'canvasId', 'revision', 'viewport',
    'nodes', 'edges', 'createdAt', 'updatedAt',
  ] as const
  if (!hasExactCanvasKeys(value, keys)
    || value.schemaVersion !== CANVAS_DOCUMENT_VERSION
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasNonNegativeInteger(value.revision)
    || !hasExactCanvasKeys(value.viewport, ['x', 'y', 'zoom'])
    || typeof value.viewport.x !== 'number' || !Number.isFinite(value.viewport.x)
    || typeof value.viewport.y !== 'number' || !Number.isFinite(value.viewport.y)
    || typeof value.viewport.zoom !== 'number' || !Number.isFinite(value.viewport.zoom)
    || value.viewport.zoom <= 0
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
    || !isCanvasNonNegativeInteger(value.createdAt)
    || !isCanvasNonNegativeInteger(value.updatedAt)) {
    throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
  }
  /** 节点逐项严格重建，并在解析边前建立唯一身份集合。 */
  const nodes = value.nodes.map(parseCanvasWorkspaceNode)
  /** 图内节点 ID 必须唯一。 */
  const nodeIds = new Set(nodes.map((node) => node.id))
  if (nodeIds.size !== nodes.length) throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
  /** 边在重建时同时校验两端节点引用。 */
  const edges = value.edges.map((edge) => parseCanvasWorkspaceEdge(edge, nodeIds))
  /** 图内边 ID 必须唯一。 */
  const edgeIds = new Set(edges.map((edge) => edge.id))
  if (edgeIds.size !== edges.length) throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
  return {
    schemaVersion: CANVAS_DOCUMENT_VERSION,
    projectId: value.projectId,
    canvasId: value.canvasId,
    revision: value.revision,
    viewport: { x: value.viewport.x, y: value.viewport.y, zoom: value.viewport.zoom },
    nodes,
    edges,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

/**
 * 严格解析 Renderer 可见的 Canvas 工作区快照。
 * @param value 待解析的主进程或 Preload 返回值。
 * @returns 逐字段重建、不含私有字段且与输入深隔离的公开快照。
 */
export function parseCanvasWorkspaceSnapshot(value: unknown): CanvasWorkspaceSnapshot {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
    }
    /** 根记录按两个可选字段的实际存在性生成唯一 exact-key 合同。 */
    const record = value as Record<string, unknown>
    /** 标记图片预览字段是否真实存在，存在时不允许用 undefined 伪装缺省。 */
    const hasImagePreviews = Object.hasOwn(record, 'imagePreviews')
    /** 标记恢复来源字段是否真实存在，存在时必须命中公开枚举。 */
    const hasRecoveredFrom = Object.hasOwn(record, 'recoveredFrom')
    /** 活跃候选摘要存在时必须是有界数组。 */
    const hasActiveImageCandidateBatches = Object.hasOwn(record, 'activeImageCandidateBatches')
    /** 工作区快照的必填公开字段。 */
    const keys = ['document', 'writable', 'nodeIssues']
    if (hasImagePreviews) keys.push('imagePreviews')
    if (hasActiveImageCandidateBatches) keys.push('activeImageCandidateBatches')
    if (hasRecoveredFrom) keys.push('recoveredFrom')
    if (!hasExactCanvasKeys(record, keys)
      || record.writable !== true
      || !Array.isArray(record.nodeIssues)
      || (hasRecoveredFrom && record.recoveredFrom !== 'tmp' && record.recoveredFrom !== 'backup')
      || (hasActiveImageCandidateBatches && !Array.isArray(record.activeImageCandidateBatches))
      || (hasImagePreviews && !Array.isArray(record.imagePreviews))) {
      throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
    }
    /** 权威文档先重建，派生问题随后才能校验其 Agent 节点归属。 */
    const document = parseCanvasWorkspaceDocument(record.document)
    /** 仅 Agent 节点允许挂载会话不可用问题。 */
    const agentNodeIds = new Set(
      document.nodes.filter((node) => node.kind === 'agent').map((node) => node.id),
    )
    /** 节点问题逐项重建并保证同一节点最多出现一次。 */
    const nodeIssues = record.nodeIssues.map((issue) => parseCanvasWorkspaceNodeIssue(issue, agentNodeIds))
    /** 已出现问题的节点身份集合用于拒绝重复派生状态。 */
    const issueNodeIds = new Set(nodeIssues.map((issue) => issue.nodeId))
    if (issueNodeIds.size !== nodeIssues.length) throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
    /** 图片预览可选存在，存在时逐项重建并拒绝重复素材。 */
    const imagePreviews = !hasImagePreviews
      ? undefined
      : (record.imagePreviews as unknown[]).map(parseCanvasWorkspaceImagePreview)
    if (imagePreviews) {
      /** 已出现预览的素材身份集合用于拒绝歧义映射。 */
      const previewAssetIds = new Set(imagePreviews.map((preview) => preview.assetId))
      if (previewAssetIds.size !== imagePreviews.length) throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
    }
    const activeImageCandidateBatches = !hasActiveImageCandidateBatches
      ? undefined
      : (record.activeImageCandidateBatches as unknown[])
        .map(parseCanvasImageCandidateBatchSummary)
        .sort((left, right) => right.updatedAt - left.updatedAt || left.batchId.localeCompare(right.batchId))
    if (activeImageCandidateBatches
      && (activeImageCandidateBatches.length > CANVAS_IMAGE_CANDIDATE_BATCH_SUMMARY_LIMIT
        || new Set(activeImageCandidateBatches.map((batch) => batch.batchId)).size !== activeImageCandidateBatches.length
        || activeImageCandidateBatches.some((batch) => (
          batch.projectId !== document.projectId
          || batch.canvasId !== document.canvasId
          || batch.status === 'adopted'
          || batch.status === 'abandoned'
        )))) {
      throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
    }
    return {
      document,
      writable: true,
      nodeIssues,
      ...(imagePreviews === undefined ? {} : { imagePreviews }),
      ...(activeImageCandidateBatches === undefined ? {} : { activeImageCandidateBatches }),
      ...(hasRecoveredFrom ? { recoveredFrom: record.recoveredFrom as 'tmp' | 'backup' } : {}),
    }
  } catch (error) {
    throw new Error('CANVAS_WORKSPACE_SNAPSHOT_INVALID', { cause: error })
  }
}

/** 文本产物写入或采用成功后的权威图与正文快照。 */
export interface CanvasTextArtifactMutationResult {
  snapshot: CanvasWorkspaceSnapshot
  artifact: CanvasTextArtifactSnapshot
}

/** Agent 工具触发 Canvas 变化时允许公开的最小来源身份。 */
export interface CanvasChangeSource {
  sessionId: string
  runStartedAt: number
  toolCallId: string
}

/** 原生 Canvas 文档变化事件，始终携带项目和 Canvas 双重身份。 */
export interface CanvasChangeEvent extends CanvasTarget {
  revision: number
  cause: 'graph' | 'recovery'
  /** 人工编辑和旧生图可无来源；存在时禁止携带 prompt 等私有内容。 */
  source?: CanvasChangeSource
}

/** 严格解析 Renderer 可见的 Canvas 变化事件。 */
export function parseCanvasChangeEvent(value: unknown): CanvasChangeEvent {
  const record = value as Record<string, unknown>
  const keys = record?.source === undefined
    ? ['projectId', 'canvasId', 'revision', 'cause']
    : ['projectId', 'canvasId', 'revision', 'cause', 'source']
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(record.projectId)
    || !isCanvasLifecycleId(record.canvasId)
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0
    || (record.cause !== 'graph' && record.cause !== 'recovery')) {
    throw new Error('CANVAS_CHANGE_EVENT_INVALID')
  }
  let source: CanvasChangeSource | undefined
  if (record.source !== undefined) {
    if (!hasExactCanvasKeys(record.source, ['sessionId', 'runStartedAt', 'toolCallId'])
      || !isCanvasLifecycleId(record.source.sessionId)
      || !Number.isSafeInteger(record.source.runStartedAt) || (record.source.runStartedAt as number) < 0
      || !isCanvasLifecycleId(record.source.toolCallId)) {
      throw new Error('CANVAS_CHANGE_EVENT_INVALID')
    }
    source = {
      sessionId: record.source.sessionId,
      runStartedAt: record.source.runStartedAt as number,
      toolCallId: record.source.toolCallId,
    }
  }
  return {
    projectId: record.projectId as string,
    canvasId: record.canvasId as string,
    revision: record.revision as number,
    cause: record.cause as CanvasChangeEvent['cause'],
    ...(source ? { source } : {}),
  }
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
      case 'set-webview-device-preset':
        next.nodes = next.nodes.map((node) => (
          node.id === mutation.nodeId && node.kind === 'webview'
            ? { ...node, devicePreset: mutation.devicePreset }
            : node
        ))
        break
    }
  }

  return next
}
