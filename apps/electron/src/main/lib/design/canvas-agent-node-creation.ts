import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs'
import type { BigIntStats, Dirent } from 'node:fs'
import { join } from 'node:path'
import { randomUUID as createRandomUUID } from 'node:crypto'
import { createCanvasBoundEdge } from '@proma/shared'
import type {
  AgentSessionMeta,
  CanvasAgentNode,
  CanvasAgentNodeCreationResult,
  CanvasDocument,
  CanvasEdge,
  CanvasMutation,
  CanvasNodeIssue,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
  CreateCanvasAgentNodeInput,
  CreateCanvasAgentNodeRelationship,
  DesignPoint,
  RebuildCanvasAgentNodeInput,
  RebuildCanvasAgentNodeResult,
} from '@proma/shared'
import type { SecureAtomicJsonWriteOptions } from '../safe-file'
import type { CreateAgentSessionWithMetadataInput } from '../agent-session-manager'
import { hasValidCanvasAgentOwnership } from '../agent-session-visibility'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import type {
  StableDirectoryAuthorization,
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
  StableDirectoryNativeWriteOutcome,
} from '../stable-directory-native-host'
import type { CanvasDocumentStore } from './canvas-document-store'
import type { CanvasTrustedDirectoryCapability } from './canvas-document-store'
import { isSafeDesignStableId } from './design-paths'

/** 单个 Canvas 最多保留的 Agent 创建事务，阻断无界目录扫描。 */
const MAX_AGENT_NODE_INTENTS = 512
/** 单个 intent JSON 的最大字节数。 */
const MAX_AGENT_NODE_INTENT_BYTES = 64 * 1024
/** 节点与会话标题的最大长度。 */
const MAX_AGENT_NODE_TITLE_LENGTH = 120
/** 项目、Canvas 与节点稳定 ID 的统一输入长度上限。 */
const MAX_CANVAS_STABLE_ID_LENGTH = 120
/** 渠道和模型稳定标识的最大长度。 */
const MAX_AGENT_MODEL_ID_LENGTH = 256
/** UUID 形态用于 operationId 和主进程预分配 sessionId。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** Agent 创建事务文件固定命名合同。 */
const AGENT_NODE_INTENT_FILE_PATTERN = /^agent-node-([0-9a-f-]{36})\.json$/i
/** Agent 重建事务文件固定命名合同。 */
const AGENT_NODE_REBUILD_INTENT_FILE_PATTERN = /^agent-node-rebuild-([0-9a-f-]{36})\.json$/i

/** Canvas Agent 创建事务的持久化阶段。 */
export type CanvasAgentNodeCreationState =
  | 'prepared'
  | 'session-created'
  | 'committed'
  | 'detached'

/** 创建节点的可恢复事务 tombstone；不保存消息正文。 */
export interface CanvasAgentNodeCreationIntent {
  schemaVersion: 1
  operationId: string
  projectId: string
  canvasId: string
  nodeId: string
  sessionId: string
  title: string
  channelId: string
  modelId?: string
  position: DesignPoint
  relationship?: CreateCanvasAgentNodeRelationship
  state: CanvasAgentNodeCreationState
  createdAt: number
  updatedAt: number
}

/** Canvas Agent 重建事务的持久化阶段。 */
export type CanvasAgentNodeRebuildState = 'prepared' | 'session-created' | 'committed'

/** 重建节点会话的可恢复事务 tombstone；旧会话永不由该事务删除。 */
export interface CanvasAgentNodeRebuildIntent {
  schemaVersion: 1
  operationId: string
  projectId: string
  canvasId: string
  nodeId: string
  previousSessionId: string
  replacementSessionId: string
  title: string
  channelId: string
  modelId?: string
  state: CanvasAgentNodeRebuildState
  createdAt: number
  updatedAt: number
}

/** transactions 目录中两类可恢复 Agent 节点事务。 */
export type CanvasAgentNodeDurableIntent =
  | CanvasAgentNodeCreationIntent
  | CanvasAgentNodeRebuildIntent

/** 对账返回公开快照和是否产生必须发布的图事实。 */
export interface CanvasAgentNodeReconciliationResult {
  snapshot: CanvasWorkspaceSnapshot
  documentChanged: boolean
  /** 已确认发布事实后仍需向调用方传播的持久性错误。 */
  error?: unknown
}

/** 服务内部结果额外携带发布判断，IPC 不得向 Renderer 暴露该字段。 */
export interface CanvasAgentNodeCreationServiceResult extends CanvasAgentNodeCreationResult {
  documentChanged: boolean
}

/** 单次 CREATE 同时保留历史对账发布事实与当前操作结果。 */
export interface CanvasAgentNodeCreateReconciledOutcome {
  reconciliation: CanvasAgentNodeReconciliationResult
  operationOutcome:
    | { ok: true; value: CanvasAgentNodeCreationServiceResult }
    | { ok: false; error: unknown; publication?: CanvasDocument }
}

/** 服务内部对账结果额外携带同次目录 capability 和最终 intent 集合。 */
interface CanvasAgentNodeReconciledState extends CanvasAgentNodeReconciliationResult {
  directory: CanvasTrustedDirectoryCapability
  intents: CanvasAgentNodeCreationIntent[]
  rebuildIntents: CanvasAgentNodeRebuildIntent[]
}

/** 单次 transactions 扫描得到的两类 intent 集合。 */
interface CanvasAgentNodeIntentCollection {
  creation: CanvasAgentNodeCreationIntent[]
  rebuild: CanvasAgentNodeRebuildIntent[]
}

/** 文件名解析后确定的事务类别与 operation 身份。 */
interface CanvasAgentNodeIntentEntry {
  kind: 'creation' | 'rebuild'
  operationId: string
}

/** 服务内部重建结果额外携带发布判断。 */
export interface CanvasAgentNodeRebuildServiceResult extends RebuildCanvasAgentNodeResult {
  documentChanged: boolean
}

/** 默认配置只读取 Agent 当前渠道和模型。 */
interface CanvasAgentDefaultSettings {
  agentChannelId?: string
  agentModelId?: string
}

/** 创建服务的可替换边界，生产依赖均由主进程显式注入。 */
export interface CanvasAgentNodeCreationDependencies {
  store: Pick<CanvasDocumentStore, 'loadWithDirectoryCapability' | 'mutate'>
  getSettings: () => CanvasAgentDefaultSettings
  assertModelAvailable: (channelId: string, modelId?: string) => void
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  createSession: (input: CreateAgentSessionWithMetadataInput) => AgentSessionMeta
  /** 批量事务提交前失败时删除本轮预分配的内部会话。 */
  deleteSession?: (sessionId: string) => void
  now?: () => number
  randomUUID?: () => string
  readTransactionsDirectory?: (directoryPath: string) => Dirent[]
  afterIntentLstat?: (filePath: string) => void
  afterIntentRead?: (filePath: string) => void
  writeIntent?: (
    filePath: string,
    intent: CanvasAgentNodeDurableIntent,
    options?: SecureAtomicJsonWriteOptions,
  ) => void | StableDirectoryNativeWriteOutcome | Promise<void | StableDirectoryNativeWriteOutcome>
  /** 测试可替换 native helper，生产使用模块级受限 host。 */
  runStableDirectoryNative?: (
    request: StableDirectoryNativeRequest,
    authorize: StableDirectoryAuthorization,
  ) => Promise<StableDirectoryNativeResult>
}

/** 判断未知值是否为无自定义原型的 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  /** 自定义原型可能携带 getter，不能进入事务 schema。 */
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 已提交图需要发布后再向 IPC 传播的持久性错误。 */
class CanvasAgentNodePublishedError extends Error {
  constructor(readonly causeError: Error, readonly document: CanvasDocument) {
    super(causeError.message)
    this.name = 'CanvasAgentNodePublishedError'
    this.cause = causeError
  }
}

/** intent 写入完成后的可信确认结果。 */
interface CanvasIntentWriteConfirmation {
  durabilityError?: Error
}

/** 精确比较两个可选扩展关系。 */
function isSameRelationship(
  left: CreateCanvasAgentNodeRelationship | undefined,
  right: CreateCanvasAgentNodeRelationship | undefined,
): boolean {
  if (!left || !right) return left === right
  return left.sourceNodeId === right.sourceNodeId
    && left.edgeId === right.edgeId
    && left.relation === right.relation
}

/** 精确比较重扫后的 intent 与刚提交内容。 */
function isSameIntent(
  left: CanvasAgentNodeCreationIntent,
  right: CanvasAgentNodeCreationIntent,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.operationId === right.operationId
    && left.projectId === right.projectId
    && left.canvasId === right.canvasId
    && left.nodeId === right.nodeId
    && left.sessionId === right.sessionId
    && left.title === right.title
    && left.channelId === right.channelId
    && left.modelId === right.modelId
    && left.position.x === right.position.x
    && left.position.y === right.position.y
    && isSameRelationship(left.relationship, right.relationship)
    && left.state === right.state
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
}

/** 精确比较重扫后的 rebuild intent 与刚提交内容。 */
function isSameRebuildIntent(
  left: CanvasAgentNodeRebuildIntent,
  right: CanvasAgentNodeRebuildIntent,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.operationId === right.operationId
    && left.projectId === right.projectId
    && left.canvasId === right.canvasId
    && left.nodeId === right.nodeId
    && left.previousSessionId === right.previousSessionId
    && left.replacementSessionId === right.replacementSessionId
    && left.title === right.title
    && left.channelId === right.channelId
    && left.modelId === right.modelId
    && left.state === right.state
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
}

/** 判断对象是否只包含指定字段，并要求必填字段存在。 */
function hasIntentKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  /** allowed 同时用于未知字段拒绝。 */
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

/** 判断有限坐标，避免无界数值污染 Canvas 文档。 */
function isValidPosition(value: unknown): value is DesignPoint {
  return isRecord(value)
    && hasIntentKeys(value, ['x', 'y'])
    && typeof value.x === 'number'
    && Number.isFinite(value.x)
    && typeof value.y === 'number'
    && Number.isFinite(value.y)
}

/** 校验不进入路径的模型字段仍为有限规范字符串。 */
function isCanonicalLimitedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
}

/** 校验从源节点到新节点的稳定关系身份。 */
function isValidRelationship(value: unknown): value is CreateCanvasAgentNodeRelationship {
  return isRecord(value)
    && hasIntentKeys(value, ['sourceNodeId', 'edgeId', 'relation'])
    && isSafeDesignStableId(value.sourceNodeId)
    && value.sourceNodeId.length <= MAX_CANVAS_STABLE_ID_LENGTH
    && isSafeDesignStableId(value.edgeId)
    && value.edgeId.length <= MAX_CANVAS_STABLE_ID_LENGTH
    && (value.relation === 'association' || value.relation === 'reference'
      || value.relation === 'depends-on' || value.relation === 'derives')
}

/** 校验 Renderer 创建输入；IPC 和服务边界均调用以保持纵深防御。 */
export function assertCreateCanvasAgentNodeInput(
  input: CreateCanvasAgentNodeInput,
): void {
  if (!isSafeDesignStableId(input.projectId)
    || input.projectId.length > MAX_CANVAS_STABLE_ID_LENGTH
    || !isSafeDesignStableId(input.canvasId)
    || input.canvasId.length > MAX_CANVAS_STABLE_ID_LENGTH) {
    throw new Error('Canvas 项目或会话 ID 非法')
  }
  if (input.operationId.length !== 36 || !UUID_PATTERN.test(input.operationId)) {
    throw new Error('Canvas operationId 非法')
  }
  if (!isSafeDesignStableId(input.nodeId) || input.nodeId.length > MAX_CANVAS_STABLE_ID_LENGTH) {
    throw new Error('Canvas 节点 ID 非法')
  }
  if (!isCanonicalLimitedString(input.title, MAX_AGENT_NODE_TITLE_LENGTH)) {
    throw new Error('Canvas Agent 标题无效')
  }
  if (!isValidPosition(input.position)) throw new Error('Canvas Agent 位置无效')
  if (input.relationship !== undefined) {
    if (!isValidRelationship(input.relationship)) throw new Error('Canvas Agent 扩展关系无效')
    if (input.relationship.sourceNodeId === input.nodeId) {
      throw new Error('Canvas Agent 扩展源节点不能是目标节点')
    }
  }
}

/** 校验 Renderer 重建输入；IPC 和服务边界均调用以保持纵深防御。 */
export function assertRebuildCanvasAgentNodeInput(
  input: RebuildCanvasAgentNodeInput,
): void {
  if (!isSafeDesignStableId(input.projectId)
    || input.projectId.length > MAX_CANVAS_STABLE_ID_LENGTH
    || !isSafeDesignStableId(input.canvasId)
    || input.canvasId.length > MAX_CANVAS_STABLE_ID_LENGTH) {
    throw new Error('Canvas 项目或会话 ID 非法')
  }
  if (!isSafeDesignStableId(input.nodeId) || input.nodeId.length > MAX_CANVAS_STABLE_ID_LENGTH) {
    throw new Error('Canvas 节点 ID 非法')
  }
  if (input.operationId.length !== 36 || !UUID_PATTERN.test(input.operationId)) {
    throw new Error('Canvas operationId 非法')
  }
}

/** 将未知 JSON 解析为 exact-key 创建事务。 */
function parseIntent(
  value: unknown,
  target: CanvasTarget,
  expectedOperationId: string,
): CanvasAgentNodeCreationIntent {
  const required = [
    'schemaVersion', 'operationId', 'projectId', 'canvasId', 'nodeId', 'sessionId',
    'title', 'channelId', 'position', 'state', 'createdAt', 'updatedAt',
  ] as const
  if (!isRecord(value) || !hasIntentKeys(value, required, ['modelId', 'relationship'])) {
    throw new Error('Canvas Agent 创建事务损坏：schema 字段无效')
  }
  if (value.schemaVersion !== 1
    || value.operationId !== expectedOperationId
    || value.projectId !== target.projectId
    || value.canvasId !== target.canvasId
    || typeof value.operationId !== 'string'
    || value.operationId.length !== 36
    || !UUID_PATTERN.test(value.operationId)
    || !isSafeDesignStableId(value.nodeId)
    || value.nodeId.length > MAX_CANVAS_STABLE_ID_LENGTH
    || typeof value.sessionId !== 'string'
    || value.sessionId.length !== 36
    || !UUID_PATTERN.test(value.sessionId)
    || !isCanonicalLimitedString(value.title, MAX_AGENT_NODE_TITLE_LENGTH)
    || !isCanonicalLimitedString(value.channelId, MAX_AGENT_MODEL_ID_LENGTH)
    || (value.modelId !== undefined
      && !isCanonicalLimitedString(value.modelId, MAX_AGENT_MODEL_ID_LENGTH))
    || !isValidPosition(value.position)
    || (value.relationship !== undefined && !isValidRelationship(value.relationship))
    || (isValidRelationship(value.relationship) && value.relationship.sourceNodeId === value.nodeId)
    || !['prepared', 'session-created', 'committed', 'detached'].includes(String(value.state))
    || !Number.isSafeInteger(value.createdAt)
    || !Number.isSafeInteger(value.updatedAt)
    || (value.createdAt as number) < 0
    || (value.updatedAt as number) < (value.createdAt as number)) {
    throw new Error('Canvas Agent 创建事务损坏：字段值无效')
  }
  return value as unknown as CanvasAgentNodeCreationIntent
}

/** 解析 helper 内存返回或兼容 fd 读取的有限 JSON 正文。 */
function parseIntentJson(
  raw: string,
  target: CanvasTarget,
  operationId: string,
): CanvasAgentNodeCreationIntent {
  if (Buffer.byteLength(raw, 'utf8') > MAX_AGENT_NODE_INTENT_BYTES) {
    throw new Error('Canvas Agent 创建事务损坏：文件大小无效')
  }
  try {
    return parseIntent(JSON.parse(raw) as unknown, target, operationId)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Canvas Agent 创建事务损坏')) {
      throw error
    }
    throw new Error('Canvas Agent 创建事务损坏：JSON 无效', { cause: error })
  }
}

/** 将未知 JSON 解析为 exact-key 重建事务。 */
function parseRebuildIntent(
  value: unknown,
  target: CanvasTarget,
  expectedOperationId: string,
): CanvasAgentNodeRebuildIntent {
  const required = [
    'schemaVersion', 'operationId', 'projectId', 'canvasId', 'nodeId',
    'previousSessionId', 'replacementSessionId', 'title', 'channelId',
    'state', 'createdAt', 'updatedAt',
  ] as const
  if (!isRecord(value) || !hasIntentKeys(value, required, ['modelId'])) {
    throw new Error('Canvas Agent 重建事务损坏：schema 字段无效')
  }
  if (value.schemaVersion !== 1
    || value.operationId !== expectedOperationId
    || value.projectId !== target.projectId
    || value.canvasId !== target.canvasId
    || typeof value.operationId !== 'string'
    || value.operationId.length !== 36
    || !UUID_PATTERN.test(value.operationId)
    || !isSafeDesignStableId(value.nodeId)
    || value.nodeId.length > MAX_CANVAS_STABLE_ID_LENGTH
    || typeof value.previousSessionId !== 'string'
    || value.previousSessionId.length !== 36
    || !UUID_PATTERN.test(value.previousSessionId)
    || typeof value.replacementSessionId !== 'string'
    || value.replacementSessionId.length !== 36
    || !UUID_PATTERN.test(value.replacementSessionId)
    || value.previousSessionId === value.replacementSessionId
    || !isCanonicalLimitedString(value.title, MAX_AGENT_NODE_TITLE_LENGTH)
    || !isCanonicalLimitedString(value.channelId, MAX_AGENT_MODEL_ID_LENGTH)
    || (value.modelId !== undefined
      && !isCanonicalLimitedString(value.modelId, MAX_AGENT_MODEL_ID_LENGTH))
    || !['prepared', 'session-created', 'committed'].includes(String(value.state))
    || !Number.isSafeInteger(value.createdAt)
    || !Number.isSafeInteger(value.updatedAt)
    || (value.createdAt as number) < 0
    || (value.updatedAt as number) < (value.createdAt as number)) {
    throw new Error('Canvas Agent 重建事务损坏：字段值无效')
  }
  return value as unknown as CanvasAgentNodeRebuildIntent
}

/** 解析有限 rebuild intent JSON 正文。 */
function parseRebuildIntentJson(
  raw: string,
  target: CanvasTarget,
  operationId: string,
): CanvasAgentNodeRebuildIntent {
  if (Buffer.byteLength(raw, 'utf8') > MAX_AGENT_NODE_INTENT_BYTES) {
    throw new Error('Canvas Agent 重建事务损坏：文件大小无效')
  }
  try {
    return parseRebuildIntent(JSON.parse(raw) as unknown, target, operationId)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Canvas Agent 重建事务损坏')) {
      throw error
    }
    throw new Error('Canvas Agent 重建事务损坏：JSON 无效', { cause: error })
  }
}

/** 从同一 no-follow fd 读取有限 intent，并复核路径和目录身份。 */
function readIntentFile<TIntent extends CanvasAgentNodeDurableIntent>(
  filePath: string,
  target: CanvasTarget,
  operationId: string,
  directoryIdentity: CanvasTrustedDirectoryCapability,
  parse: (raw: string, target: CanvasTarget, operationId: string) => TIntent,
  afterIntentLstat?: (filePath: string) => void,
  afterIntentRead?: (filePath: string) => void,
): TIntent {
  /** O_NOFOLLOW 在不支持的平台退化为 0，随后 lstat 仍拒绝链接。 */
  const noFollow = constants.O_NOFOLLOW ?? 0
  let descriptor: number | null = null
  try {
    directoryIdentity.assertValid()
    const pathStats = lstatSync(filePath, { bigint: true })
    if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
      throw new Error('Canvas Agent 创建事务损坏：文件类型无效')
    }
    /** 初始路径状态必须与随后打开的 fd 完整绑定。 */
    const initialState = toIntentFileState(pathStats)
    afterIntentLstat?.(filePath)
    descriptor = openSync(filePath, constants.O_RDONLY | noFollow)
    const openedStats = fstatSync(descriptor, { bigint: true })
    if (!openedStats.isFile() || !isSameIntentFileState(initialState, toIntentFileState(openedStats))) {
      throw new Error('Canvas Agent 创建事务损坏：读取前文件已变化')
    }
    if (openedStats.size > BigInt(MAX_AGENT_NODE_INTENT_BYTES)) {
      throw new Error('Canvas Agent 创建事务损坏：文件大小无效')
    }
    /** JSON 只从已授权 fd 读取，禁止按路径二次打开。 */
    const raw = readFileSync(descriptor, 'utf8')
    afterIntentRead?.(filePath)
    const finalStats = fstatSync(descriptor, { bigint: true })
    const finalPathStats = lstatSync(filePath, { bigint: true })
    if (!finalStats.isFile()
      || finalPathStats.isSymbolicLink()
      || !finalPathStats.isFile()
      || !isSameIntentFileState(initialState, toIntentFileState(finalStats))
      || !isSameIntentFileState(initialState, toIntentFileState(finalPathStats))) {
      throw new Error('Canvas Agent 创建事务损坏：读取期间文件变化')
    }
    directoryIdentity.assertValid()
    return parse(raw, target, operationId)
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

/** intent 文件读取期间必须保持一致的纳秒级内容状态。 */
interface IntentFileState {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

/** 从 bigint stats 提取稳定身份、大小和纳秒时间戳。 */
function toIntentFileState(stats: BigIntStats): IntentFileState {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  }
}

/** 比较 intent 文件读取前后的完整可观察内容状态。 */
function isSameIntentFileState(left: IntentFileState, right: IntentFileState): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

/** 判断已有 Agent session 是否完整属于当前 intent。 */
function sessionMatchesIntent(
  session: AgentSessionMeta | undefined,
  intent: CanvasAgentNodeCreationIntent,
): session is AgentSessionMeta {
  return Boolean(session
    && hasValidCanvasAgentOwnership(session)
    && session.id === intent.sessionId
    && session.title === intent.title
    && session.channelId === intent.channelId
    && session.modelId === intent.modelId
    && session.workspaceId === intent.projectId
    && session.sourceCanvasProjectId === intent.projectId
    && session.sourceCanvasId === intent.canvasId
    && session.sourceCanvasNodeId === intent.nodeId)
}

/** 验证未完成事务中的 Agent session 完整属于当前 intent。 */
function assertSessionMatchesIntent(
  session: AgentSessionMeta | undefined,
  intent: CanvasAgentNodeCreationIntent,
): asserts session is AgentSessionMeta {
  if (!sessionMatchesIntent(session, intent)) {
    throw new Error(`Canvas Agent session 归属损坏: ${intent.sessionId}`)
  }
}

/** 为 committed 坏会话节点生成不含内部身份的公开问题。 */
function createUnavailableSessionIssue(nodeId: string): CanvasNodeIssue {
  return {
    nodeId,
    code: 'AGENT_SESSION_UNAVAILABLE',
    allowedActions: ['rebuild-agent-session', 'remove-node'],
  }
}

/** 判断 replacement session 是否完整匹配 rebuild intent。 */
function sessionMatchesRebuildIntent(
  session: AgentSessionMeta | undefined,
  intent: CanvasAgentNodeRebuildIntent,
): session is AgentSessionMeta {
  return Boolean(session
    && hasValidCanvasAgentOwnership(session)
    && session.id === intent.replacementSessionId
    && session.title === intent.title
    && session.channelId === intent.channelId
    && session.modelId === intent.modelId
    && session.workspaceId === intent.projectId
    && session.sourceCanvasProjectId === intent.projectId
    && session.sourceCanvasId === intent.canvasId
    && session.sourceCanvasNodeId === intent.nodeId)
}

/** 验证未完成重建事务中的 replacement session 归属。 */
function assertSessionMatchesRebuildIntent(
  session: AgentSessionMeta | undefined,
  intent: CanvasAgentNodeRebuildIntent,
): asserts session is AgentSessionMeta {
  if (!sessionMatchesRebuildIntent(session, intent)) {
    throw new Error(`Canvas Agent 重建 session 归属损坏: ${intent.replacementSessionId}`)
  }
}

/** 验证文档中的同 ID 节点没有被另一事务占用。 */
function assertNodeMatchesIntent(
  node: CanvasDocument['nodes'][number],
  intent: CanvasAgentNodeCreationIntent,
): asserts node is CanvasAgentNode {
  if (node.kind !== 'agent'
    || node.agentSessionId !== intent.sessionId
    || node.title !== intent.title
    || node.position.x !== intent.position.x
    || node.position.y !== intent.position.y) {
    throw new Error(`Canvas Agent 节点归属损坏: ${intent.nodeId}`)
  }
}

/** committed 后位置允许用户编辑，只继续验证原 session 与稳定展示身份。 */
function assertCommittedNodeMatchesIntent(
  node: CanvasDocument['nodes'][number],
  intent: CanvasAgentNodeCreationIntent,
): asserts node is CanvasAgentNode {
  if (node.kind !== 'agent'
    || node.agentSessionId !== intent.sessionId
    || node.title !== intent.title) {
    throw new Error(`Canvas Agent 节点归属损坏: ${intent.nodeId}`)
  }
}

/** 重建后 session 已换绑，只验证原创建 intent 拥有的稳定展示身份。 */
function assertCommittedNodeDisplayMatchesIntent(
  node: CanvasDocument['nodes'][number],
  intent: CanvasAgentNodeCreationIntent,
): asserts node is CanvasAgentNode {
  if (node.kind !== 'agent'
    || node.title !== intent.title) {
    throw new Error(`Canvas Agent 节点布局归属损坏: ${intent.nodeId}`)
  }
}

/** 验证节点已经换绑到 rebuild intent 的 replacement session。 */
function assertNodeMatchesRebuildIntent(
  node: CanvasDocument['nodes'][number],
  intent: CanvasAgentNodeRebuildIntent,
): asserts node is CanvasAgentNode {
  if (node.kind !== 'agent'
    || node.agentSessionId !== intent.replacementSessionId
    || node.title !== intent.title) {
    throw new Error(`Canvas Agent 重建节点归属损坏: ${intent.nodeId}`)
  }
}

/** 从创建 intent 生成固定兼容端口连线。 */
function createRelationshipEdge(
  intent: CanvasAgentNodeCreationIntent,
  sourceNode: CanvasDocument['nodes'][number],
  targetNode: CanvasAgentNode,
): CanvasEdge | undefined {
  if (!intent.relationship) return undefined
  return createCanvasBoundEdge(sourceNode, targetNode, {
    id: intent.relationship.edgeId,
    sourceNodeId: intent.relationship.sourceNodeId,
    targetNodeId: intent.nodeId,
    relation: intent.relationship.relation,
  })
}

/** 验证已提交扩展边没有被另一关系占用或部分丢失。 */
function assertRelationshipMatchesIntent(
  document: CanvasDocument,
  intent: CanvasAgentNodeCreationIntent,
): void {
  if (!intent.relationship) return
  /** 已提交文档中的来源节点决定边的输出能力。 */
  const sourceNode = document.nodes.find((candidate) => candidate.id === intent.relationship?.sourceNodeId)
  /** 已提交 Agent 节点决定边的目标输入槽。 */
  const targetNode = document.nodes.find((candidate): candidate is CanvasAgentNode => (
    candidate.id === intent.nodeId && candidate.kind === 'agent'
  ))
  if (!sourceNode || !targetNode) {
    throw new Error(`Canvas Agent 扩展边归属损坏: ${intent.relationship.edgeId}`)
  }
  const expected = createRelationshipEdge(intent, sourceNode, targetNode)!
  const edge = document.edges.find((candidate) => candidate.id === expected.id)
  if (!edge
    || edge.sourceNodeId !== expected.sourceNodeId
    || edge.sourcePort !== expected.sourcePort
    || edge.targetNodeId !== expected.targetNodeId
    || edge.targetPort !== expected.targetPort
    || edge.relation !== expected.relation) {
    throw new Error(`Canvas Agent 扩展边归属损坏: ${expected.id}`)
  }
}

/** 在调用方已持有 workspace write lease 时执行事务对账和创建。 */
export class CanvasAgentNodeCreationService {
  private readonly now: () => number
  private readonly randomUUID: () => string
  private readonly readTransactionsDirectory?: (directoryPath: string) => Dirent[]
  private readonly writeIntentFile?: NonNullable<CanvasAgentNodeCreationDependencies['writeIntent']>
  private readonly runNative: NonNullable<CanvasAgentNodeCreationDependencies['runStableDirectoryNative']>

  constructor(private readonly dependencies: CanvasAgentNodeCreationDependencies) {
    this.now = dependencies.now ?? Date.now
    this.randomUUID = dependencies.randomUUID ?? createRandomUUID
    this.readTransactionsDirectory = dependencies.readTransactionsDirectory
    this.writeIntentFile = dependencies.writeIntent
    this.runNative = dependencies.runStableDirectoryNative ?? runStableDirectoryNative
  }

  /** 在批量事务持久化 ownership 前只检查会话是否存在并验证已有归属。 */
  inspectBatchSession(input: {
    projectId: string
    canvasId: string
    nodeId: string
    sessionId: string
    title: string
  }): { exists: boolean } {
    const existing = this.dependencies.getSession(input.sessionId)
    if (!existing) return { exists: false }
    if (!hasValidCanvasAgentOwnership(existing)
      || existing.id !== input.sessionId
      || existing.title !== input.title
      || existing.workspaceId !== input.projectId
      || existing.sourceCanvasProjectId !== input.projectId
      || existing.sourceCanvasId !== input.canvasId
      || existing.sourceCanvasNodeId !== input.nodeId) {
      throw new Error('CANVAS_AGENT_SESSION_OWNERSHIP_CONFLICT')
    }
    return { exists: true }
  }

  /** 为批量事务预备一个独占 Canvas Agent session，不提交图 mutation。 */
  prepareBatchSession(input: {
    projectId: string
    canvasId: string
    nodeId: string
    sessionId: string
    title: string
  }): { session: AgentSessionMeta; created: boolean } {
    /** 批量 intent 不复制渠道配置；重放只验证不可伪造的独占 Canvas 归属。 */
    const matchesOwnership = (session: AgentSessionMeta): boolean => (
      hasValidCanvasAgentOwnership(session)
      && session.id === input.sessionId
      && session.title === input.title
      && session.workspaceId === input.projectId
      && session.sourceCanvasProjectId === input.projectId
      && session.sourceCanvasId === input.canvasId
      && session.sourceCanvasNodeId === input.nodeId
    )
    const existing = this.dependencies.getSession(input.sessionId)
    if (existing) {
      if (!matchesOwnership(existing)) {
        throw new Error('CANVAS_AGENT_SESSION_OWNERSHIP_CONFLICT')
      }
      return { session: existing, created: false }
    }
    const settings = this.dependencies.getSettings()
    const channelId = settings.agentChannelId?.trim()
    const modelId = settings.agentModelId?.trim() || undefined
    if (!channelId) throw new Error('Canvas Agent 需要先配置默认渠道')
    this.dependencies.assertModelAvailable(channelId, modelId)
    const session = this.dependencies.createSession({
      trustedSessionId: input.sessionId,
      title: input.title,
      channelId,
      modelId,
      workspaceId: input.projectId,
      sourceCanvasProjectId: input.projectId,
      sourceCanvasId: input.canvasId,
      sourceCanvasNodeId: input.nodeId,
    })
    if (!matchesOwnership(session)) {
      throw new Error('CANVAS_AGENT_SESSION_OWNERSHIP_CONFLICT')
    }
    return { session, created: true }
  }

  /** 只删除仍精确归属于本批节点的预分配会话。 */
  cleanupBatchSession(input: {
    projectId: string
    canvasId: string
    nodeId: string
    sessionId: string
  }): void {
    const session = this.dependencies.getSession(input.sessionId)
    /** cleaned intent 持久性不确定时恢复会重放清理，缺失即已完成。 */
    if (!session) return
    if (session.workspaceId !== input.projectId
      || session.sourceCanvasProjectId !== input.projectId
      || session.sourceCanvasId !== input.canvasId
      || session.sourceCanvasNodeId !== input.nodeId) {
      throw new Error('CANVAS_AGENT_SESSION_OWNERSHIP_CONFLICT')
    }
    if (!this.dependencies.deleteSession) throw new Error('CANVAS_AGENT_SESSION_CLEANUP_UNAVAILABLE')
    this.dependencies.deleteSession(input.sessionId)
  }

  /** 校验并解析一条已排序的 creation 或 rebuild intent 文件名。 */
  private parseIntentEntryName(name: string): CanvasAgentNodeIntentEntry | null {
    const rebuildMatch = AGENT_NODE_REBUILD_INTENT_FILE_PATTERN.exec(name)
    if (rebuildMatch) {
      const operationId = rebuildMatch[1]!
      if (!UUID_PATTERN.test(operationId)) {
        throw new Error('Canvas Agent 重建事务损坏：文件名无效')
      }
      return { kind: 'rebuild', operationId }
    }
    const creationMatch = AGENT_NODE_INTENT_FILE_PATTERN.exec(name)
    if (creationMatch) {
      const operationId = creationMatch[1]!
      if (!UUID_PATTERN.test(operationId)) {
        throw new Error('Canvas Agent 创建事务损坏：文件名无效')
      }
      return { kind: 'creation', operationId }
    }
    if (name.startsWith('agent-node-rebuild-') && name.endsWith('.json')) {
      throw new Error('Canvas Agent 重建事务损坏：文件名无效')
    }
    if (name.startsWith('agent-node-') && name.endsWith('.json')) {
      throw new Error('Canvas Agent 创建事务损坏：文件名无效')
    }
    return null
  }

  /** 单次扫描目标 Canvas 的有限 transactions 目录并分类两种 intent。 */
  private async readIntents(
    target: CanvasTarget,
    directoryIdentity: CanvasTrustedDirectoryCapability,
  ): Promise<CanvasAgentNodeIntentCollection> {
    directoryIdentity.assertValid()
    /** 当前扫描内解析出的创建和重建事务。 */
    const intents: CanvasAgentNodeIntentCollection = { creation: [], rebuild: [] }
    if (!this.readTransactionsDirectory) {
      const result = await this.runNative({
        mode: 'canvas-intent-scan',
        roots: [directoryIdentity.rootPath],
        childName: 'transactions',
        maxDepth: 0,
        maxEntries: MAX_AGENT_NODE_INTENTS,
        maxOutputBytes: 40 * 1024 * 1024,
      }, directoryIdentity.authorizeOpenedRoots)
      if (result.entries.length > MAX_AGENT_NODE_INTENTS) {
        throw new Error('Canvas Agent 创建事务过多，已停止对账')
      }
      for (const entry of result.entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const parsedEntry = this.parseIntentEntryName(entry.name)
        if (!parsedEntry) continue
        if (entry.isDirectory || typeof entry.content !== 'string') {
          throw new Error('Canvas Agent 节点事务损坏：目录项类型无效')
        }
        if (parsedEntry.kind === 'creation') {
          intents.creation.push(parseIntentJson(entry.content, target, parsedEntry.operationId))
        } else {
          intents.rebuild.push(parseRebuildIntentJson(entry.content, target, parsedEntry.operationId))
        }
      }
      directoryIdentity.assertValid()
      return intents
    }
    /** 测试兼容边界仍从 no-follow fd 读取，以覆盖 Node 状态绑定回归。 */
    const entries = this.readTransactionsDirectory(directoryIdentity.path)
    if (entries.length > MAX_AGENT_NODE_INTENTS) {
      throw new Error('Canvas Agent 创建事务过多，已停止对账')
    }
    /** 文件名排序保证相同事实下的扫描结果稳定。 */
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const parsedEntry = this.parseIntentEntryName(entry.name)
      if (!parsedEntry) continue
      if (!entry.isFile()) throw new Error('Canvas Agent 节点事务损坏：目录项类型无效')
      const filePath = join(directoryIdentity.path, entry.name)
      if (parsedEntry.kind === 'creation') {
        intents.creation.push(readIntentFile(
          filePath,
          target,
          parsedEntry.operationId,
          directoryIdentity,
          parseIntentJson,
          this.dependencies.afterIntentLstat,
          this.dependencies.afterIntentRead,
        ))
      } else {
        intents.rebuild.push(readIntentFile(
          filePath,
          target,
          parsedEntry.operationId,
          directoryIdentity,
          parseRebuildIntentJson,
          this.dependencies.afterIntentLstat,
          this.dependencies.afterIntentRead,
        ))
      }
    }
    directoryIdentity.assertValid()
    return intents
  }

  /** 通过 helper 在已授权 Canvas root HANDLE 下原子写下一阶段。 */
  private async writeIntent(
    identity: CanvasTrustedDirectoryCapability,
    intent: CanvasAgentNodeDurableIntent,
  ): Promise<CanvasIntentWriteConfirmation> {
    const rebuild = 'replacementSessionId' in intent
    const fileName = rebuild
      ? `agent-node-rebuild-${intent.operationId}.json`
      : `agent-node-${intent.operationId}.json`
    const filePattern = rebuild
      ? AGENT_NODE_REBUILD_INTENT_FILE_PATTERN
      : AGENT_NODE_INTENT_FILE_PATTERN
    if (!filePattern.test(fileName)) throw new Error('Canvas Agent intent 路径无效')
    if (this.writeIntentFile) {
      const filePath = join(identity.path, fileName)
      identity.assertValid()
      const outcome = await this.writeIntentFile(
        filePath,
        intent,
        { beforeRename: identity.assertValid },
      )
      return this.confirmIntentWrite(identity, intent, outcome ?? {
        commitVisible: true,
        durabilityUncertain: false,
      })
    }
    const result = await this.runNative({
      mode: 'canvas-intent-write',
      roots: [identity.rootPath],
      childName: 'transactions',
      fileName,
      content: `${JSON.stringify(intent, null, 2)}\n`,
      maxEntries: MAX_AGENT_NODE_INTENTS,
    }, identity.authorizeOpenedRoots)
    if (!result.writeOutcome) throw new Error('Canvas Agent intent helper 未返回写入结果')
    return this.confirmIntentWrite(identity, intent, result.writeOutcome)
  }

  /** 对结构化写结果执行失败传播或 rename 后可见性重扫。 */
  private async confirmIntentWrite(
    identity: CanvasTrustedDirectoryCapability,
    intent: CanvasAgentNodeDurableIntent,
    outcome: StableDirectoryNativeWriteOutcome,
  ): Promise<CanvasIntentWriteConfirmation> {
    if (!outcome.commitVisible) {
      throw new Error(`CANVAS_INTENT_WRITE_FAILED: ${outcome.error ?? 'intent 未提交'}`)
    }
    if (!outcome.durabilityUncertain) return {}
    /** rename 已发生时只信任同一稳定目录 capability 的重新扫描结果。 */
    const rescanned = await this.readIntents({
      projectId: intent.projectId,
      canvasId: intent.canvasId,
    }, identity)
    const rebuild = 'replacementSessionId' in intent
    const candidates = rebuild ? rescanned.rebuild : rescanned.creation
    const committed = candidates.find((candidate) => candidate.operationId === intent.operationId)
    const sameIntent = committed !== undefined && (rebuild
      ? isSameRebuildIntent(
          committed as CanvasAgentNodeRebuildIntent,
          intent as CanvasAgentNodeRebuildIntent,
        )
      : isSameIntent(
          committed as CanvasAgentNodeCreationIntent,
          intent as CanvasAgentNodeCreationIntent,
        ))
    if (!sameIntent) {
      throw new Error('CANVAS_INTENT_COMMIT_UNCONFIRMED: rename 后未找到精确 intent')
    }
    return {
      durabilityError: new Error(
        `CANVAS_INTENT_DURABILITY_UNCERTAIN: ${outcome.error ?? '目录持久性未确认'}`,
      ),
    }
  }

  /** 返回更新时间单调前进的新阶段 intent。 */
  private transitionIntent(
    intent: CanvasAgentNodeCreationIntent,
    state: CanvasAgentNodeCreationState,
  ): CanvasAgentNodeCreationIntent {
    /** 系统时钟回拨时仍保持 tombstone 更新时间单调。 */
    const updatedAt = Math.max(this.now(), intent.updatedAt + 1)
    return { ...intent, state, updatedAt }
  }

  /** 返回更新时间单调前进的新重建阶段 intent。 */
  private transitionRebuildIntent(
    intent: CanvasAgentNodeRebuildIntent,
    state: CanvasAgentNodeRebuildState,
  ): CanvasAgentNodeRebuildIntent {
    /** 系统时钟回拨时仍保持重建 tombstone 更新时间单调。 */
    const updatedAt = Math.max(this.now(), intent.updatedAt + 1)
    return { ...intent, state, updatedAt }
  }

  /** 在最新文档上把 prepared/session-created 推进到 committed。 */
  private async advanceIntent(
    originalIntent: CanvasAgentNodeCreationIntent,
    initialDocument: CanvasDocument,
    identity: CanvasTrustedDirectoryCapability,
  ): Promise<{
    intent: CanvasAgentNodeCreationIntent
    document: CanvasDocument
    publishRequired: boolean
    error?: Error
  }> {
    let intent = originalIntent
    let document = initialDocument
    /** 只有 committed 成功越过发布屏障后，既有 revision 才允许对外发布。 */
    let publishRequired = false
    this.dependencies.assertModelAvailable(intent.channelId, intent.modelId)

    if (intent.state === 'prepared') {
      let session = this.dependencies.getSession(intent.sessionId)
      if (session) {
        assertSessionMatchesIntent(session, intent)
      } else {
        session = this.dependencies.createSession({
          trustedSessionId: intent.sessionId,
          title: intent.title,
          channelId: intent.channelId,
          modelId: intent.modelId,
          workspaceId: intent.projectId,
          sourceCanvasProjectId: intent.projectId,
          sourceCanvasId: intent.canvasId,
          sourceCanvasNodeId: intent.nodeId,
        })
        assertSessionMatchesIntent(session, intent)
      }
      intent = this.transitionIntent(intent, 'session-created')
      const confirmation = await this.writeIntent(identity, intent)
      if (confirmation.durabilityError) {
        return { intent, document, publishRequired, error: confirmation.durabilityError }
      }
    }

    if (intent.state === 'session-created') {
      assertSessionMatchesIntent(this.dependencies.getSession(intent.sessionId), intent)
      const existingNode = document.nodes.find((node) => node.id === intent.nodeId)
      if (existingNode) {
        assertNodeMatchesIntent(existingNode, intent)
        assertRelationshipMatchesIntent(document, intent)
      } else {
        /** 节点只引用 session，不复制消息或运行状态。 */
        const node: CanvasAgentNode = {
          id: intent.nodeId,
          kind: 'agent',
          title: intent.title,
          position: intent.position,
          agentSessionId: intent.sessionId,
        }
        /** 节点与可选边必须通过同一 Store 批次共享 revision。 */
        const mutations: CanvasMutation[] = [{ type: 'upsert-nodes', nodes: [node] }]
        if (intent.relationship) {
          /** 权威来源节点决定新边可公开的产物能力。 */
          const sourceNode = document.nodes.find((candidate) => (
            candidate.id === intent.relationship?.sourceNodeId
          ))
          if (!sourceNode) throw new Error('Canvas 扩展源节点不存在')
          /** 本次新建 Agent 是类型化边的目标节点。 */
          const relationshipEdge = createRelationshipEdge(intent, sourceNode, node)!
          if (document.edges.some((edge) => edge.id === relationshipEdge.id)) {
            throw new Error('Canvas 扩展边 ID 已被占用')
          }
          mutations.push({ type: 'upsert-edges', edges: [relationshipEdge] })
        }
        document = this.dependencies.store.mutate(
          { projectId: intent.projectId, canvasId: intent.canvasId },
          document.revision,
          mutations,
        )
      }
      /** committed 是唯一发布屏障；写失败时调用方不得广播或返回 document。 */
      intent = this.transitionIntent(intent, 'committed')
      const confirmation = await this.writeIntent(identity, intent)
      publishRequired = true
      if (confirmation.durabilityError) {
        return { intent, document, publishRequired, error: confirmation.durabilityError }
      }
    }
    return { intent, document, publishRequired }
  }

  /** 在最新文档上把 prepared/session-created 重建推进到 committed。 */
  private async advanceRebuildIntent(
    originalIntent: CanvasAgentNodeRebuildIntent,
    initialDocument: CanvasDocument,
    identity: CanvasTrustedDirectoryCapability,
  ): Promise<{
    intent: CanvasAgentNodeRebuildIntent
    document: CanvasDocument
    publishRequired: boolean
    error?: Error
  }> {
    let intent = originalIntent
    let document = initialDocument
    /** 节点引用换绑后必须越过 committed 屏障才能对外发布。 */
    let publishRequired = false
    this.dependencies.assertModelAvailable(intent.channelId, intent.modelId)

    if (intent.state === 'prepared') {
      let session = this.dependencies.getSession(intent.replacementSessionId)
      if (session) {
        assertSessionMatchesRebuildIntent(session, intent)
      } else {
        session = this.dependencies.createSession({
          trustedSessionId: intent.replacementSessionId,
          title: intent.title,
          channelId: intent.channelId,
          modelId: intent.modelId,
          workspaceId: intent.projectId,
          sourceCanvasProjectId: intent.projectId,
          sourceCanvasId: intent.canvasId,
          sourceCanvasNodeId: intent.nodeId,
        })
        assertSessionMatchesRebuildIntent(session, intent)
      }
      intent = this.transitionRebuildIntent(intent, 'session-created')
      const confirmation = await this.writeIntent(identity, intent)
      if (confirmation.durabilityError) {
        return { intent, document, publishRequired, error: confirmation.durabilityError }
      }
    }

    if (intent.state === 'session-created') {
      assertSessionMatchesRebuildIntent(
        this.dependencies.getSession(intent.replacementSessionId),
        intent,
      )
      const node = document.nodes.find((candidate) => candidate.id === intent.nodeId)
      if (!node || node.kind !== 'agent' || node.title !== intent.title) {
        throw new Error(`Canvas Agent 重建节点归属损坏: ${intent.nodeId}`)
      }
      if (node.agentSessionId === intent.previousSessionId) {
        /** 只替换 session 引用，节点身份、布局、标题和全部边保持不变。 */
        document = this.dependencies.store.mutate(
          { projectId: intent.projectId, canvasId: intent.canvasId },
          document.revision,
          [{
            type: 'upsert-nodes',
            nodes: [{ ...node, agentSessionId: intent.replacementSessionId }],
          }],
        )
      } else if (node.agentSessionId !== intent.replacementSessionId) {
        throw new Error(`Canvas Agent 重建节点归属损坏: ${intent.nodeId}`)
      }
      /** 已观察到 replacement 引用，重试 committed 写时仍需发布该 revision。 */
      publishRequired = true
      intent = this.transitionRebuildIntent(intent, 'committed')
      const confirmation = await this.writeIntent(identity, intent)
      if (confirmation.durabilityError) {
        return { intent, document, publishRequired, error: confirmation.durabilityError }
      }
    }
    return { intent, document, publishRequired }
  }

  /** 在同一次 Store LOAD capability 上完成目标 Canvas 对账。 */
  private async reconcileWithDirectory(target: CanvasTarget): Promise<CanvasAgentNodeReconciledState> {
    if (!isSafeDesignStableId(target.projectId)
      || target.projectId.length > MAX_CANVAS_STABLE_ID_LENGTH
      || !isSafeDesignStableId(target.canvasId)
      || target.canvasId.length > MAX_CANVAS_STABLE_ID_LENGTH) {
      throw new Error('Canvas 项目或会话 ID 非法')
    }
    const loaded = this.dependencies.store.loadWithDirectoryCapability(target)
    const snapshot = loaded.snapshot
    const identity = loaded.openSingleChildDirectory('transactions')
    let document = snapshot.document
    let documentChanged = false
    let reconciliationError: Error | undefined
    /** 保留每个事务对账后的最终阶段，供同次 CREATE 直接复用。 */
    const intents: CanvasAgentNodeCreationIntent[] = []
    /** committed 会话异常只派生当前 LOAD 的节点问题，不写入文档。 */
    const nodeIssues: CanvasNodeIssue[] = []
    /** 一次目录扫描同时提供创建与重建事务。 */
    const scannedIntents = await this.readIntents(target, identity)
    /** 重建数组保留全部历史 operation，最新节点事务会被对账后值替换。 */
    const rebuildIntents = [...scannedIntents.rebuild]
    /** 每个节点只由 createdAt 最新的 rebuild intent 约束当前 session。 */
    const latestRebuildByNodeId = new Map<string, CanvasAgentNodeRebuildIntent>()
    for (const intent of rebuildIntents) {
      const current = latestRebuildByNodeId.get(intent.nodeId)
      if (!current
        || intent.createdAt > current.createdAt
        || (intent.createdAt === current.createdAt && intent.operationId > current.operationId)) {
        latestRebuildByNodeId.set(intent.nodeId, intent)
      }
    }

    /** 重建必须先完成，随后创建 intent 才能按最新 session 事实对账。 */
    const latestRebuildIntents = [...latestRebuildByNodeId.values()]
      .sort((left, right) => left.createdAt - right.createdAt
        || left.operationId.localeCompare(right.operationId))
    for (const originalIntent of latestRebuildIntents) {
      let intent = originalIntent
      if (intent.state === 'prepared' || intent.state === 'session-created') {
        const advanced = await this.advanceRebuildIntent(intent, document, identity)
        intent = advanced.intent
        document = advanced.document
        documentChanged ||= advanced.publishRequired
        const index = rebuildIntents.findIndex((candidate) => (
          candidate.operationId === intent.operationId
        ))
        if (index >= 0) rebuildIntents[index] = intent
        latestRebuildByNodeId.set(intent.nodeId, intent)
        if (advanced.error) {
          reconciliationError = advanced.error
          break
        }
      }
      if (intent.state === 'committed') {
        const node = document.nodes.find((candidate) => candidate.id === intent.nodeId)
        if (node) {
          assertNodeMatchesRebuildIntent(node, intent)
          if (!sessionMatchesRebuildIntent(
            this.dependencies.getSession(intent.replacementSessionId),
            intent,
          )) {
            nodeIssues.push(createUnavailableSessionIssue(node.id))
          }
        }
      }
    }

    for (const originalIntent of reconciliationError ? [] : scannedIntents.creation) {
      let intent = originalIntent
      if (intent.state === 'prepared' || intent.state === 'session-created') {
        const advanced = await this.advanceIntent(intent, document, identity)
        intent = advanced.intent
        document = advanced.document
        documentChanged ||= advanced.publishRequired
        if (advanced.error) {
          reconciliationError = advanced.error
          intents.push(intent)
          break
        }
      }
      if (intent.state === 'committed') {
        const node = document.nodes.find((candidate) => candidate.id === intent.nodeId)
        if (!node) {
          /** committed 后节点缺失代表用户删除引用，必须永久 detached。 */
          intent = this.transitionIntent(intent, 'detached')
          const confirmation = await this.writeIntent(identity, intent)
          if (confirmation.durabilityError) {
            reconciliationError = confirmation.durabilityError
            intents.push(intent)
            break
          }
        } else {
          const rebuildIntent = latestRebuildByNodeId.get(intent.nodeId)
          if (rebuildIntent) {
            assertCommittedNodeDisplayMatchesIntent(node, intent)
          } else {
            assertCommittedNodeMatchesIntent(node, intent)
          }
          /** committed 后连线属于可编辑图状态；删线或删除源节点时下游 Agent 合法转为独立节点。 */
          if (!rebuildIntent
            && !sessionMatchesIntent(this.dependencies.getSession(intent.sessionId), intent)) {
            nodeIssues.push(createUnavailableSessionIssue(node.id))
          }
        }
      }
      intents.push(intent)
    }
    return {
      snapshot: { ...snapshot, document, nodeIssues },
      documentChanged,
      ...(reconciliationError ? { error: reconciliationError } : {}),
      directory: identity,
      intents,
      rebuildIntents,
    }
  }

  /** 惰性对账目标 Canvas，调用方必须已持有唯一 workspace write lease。 */
  async reconcile(target: CanvasTarget): Promise<CanvasAgentNodeReconciliationResult> {
    const {
      directory: _directory,
      intents: _intents,
      rebuildIntents: _rebuildIntents,
      ...result
    } = await this.reconcileWithDirectory(target)
    return result
  }

  /** 基于同次对账结果首次准备或幂等重放会话重建 operation。 */
  private async rebuildAfterReconciliation(
    input: RebuildCanvasAgentNodeInput,
    reconciled: CanvasAgentNodeReconciledState,
  ): Promise<CanvasAgentNodeRebuildServiceResult> {
    const existing = reconciled.rebuildIntents.find((intent) => (
      intent.operationId === input.operationId
    ))
    if (existing) {
      if (existing.nodeId !== input.nodeId) {
        throw new Error('Canvas operationId 已被不同重建请求占用')
      }
      if (existing.state !== 'committed') {
        throw new Error('Canvas Agent 重建事务未完成对账')
      }
      const latestForNode = reconciled.rebuildIntents
        .filter((intent) => intent.nodeId === existing.nodeId)
        .sort((left, right) => right.createdAt - left.createdAt
          || right.operationId.localeCompare(left.operationId))[0]
      if (latestForNode?.operationId !== existing.operationId) {
        throw new Error('Canvas Agent 重建操作已被后续会话替代')
      }
      const session = this.dependencies.getSession(existing.replacementSessionId)
      assertSessionMatchesRebuildIntent(session, existing)
      return {
        snapshot: reconciled.snapshot,
        session,
        documentChanged: reconciled.documentChanged,
      }
    }

    const node = reconciled.snapshot.document.nodes.find((candidate) => candidate.id === input.nodeId)
    if (!node || node.kind !== 'agent') throw new Error('Canvas Agent 节点不存在')
    if (!reconciled.snapshot.nodeIssues.some((issue) => issue.nodeId === node.id)) {
      throw new Error('Canvas Agent 节点无需重建')
    }
    const settings = this.dependencies.getSettings()
    const channelId = settings.agentChannelId?.trim()
    const modelId = settings.agentModelId?.trim() || undefined
    if (!channelId) throw new Error('Canvas Agent 需要先配置默认渠道')
    this.dependencies.assertModelAvailable(channelId, modelId)
    const replacementSessionId = this.randomUUID()
    if (replacementSessionId.length !== 36
      || !UUID_PATTERN.test(replacementSessionId)
      || replacementSessionId === node.agentSessionId) {
      throw new Error('Canvas Agent 重建 sessionId 非法')
    }
    const latestForNode = reconciled.rebuildIntents
      .filter((intent) => intent.nodeId === node.id)
      .sort((left, right) => right.updatedAt - left.updatedAt
        || right.operationId.localeCompare(left.operationId))[0]
    /** 同一节点多次重建时让 createdAt 严格晚于前序事务。 */
    const createdAt = Math.max(this.now(), (latestForNode?.updatedAt ?? -1) + 1)
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new Error('Canvas Agent 重建时间戳无效')
    }
    /** prepared 固化旧引用、新 session ID 与模型快照。 */
    const prepared: CanvasAgentNodeRebuildIntent = {
      schemaVersion: 1,
      operationId: input.operationId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      previousSessionId: node.agentSessionId,
      replacementSessionId,
      title: node.title,
      channelId,
      ...(modelId ? { modelId } : {}),
      state: 'prepared',
      createdAt,
      updatedAt: createdAt,
    }
    const preparedConfirmation = await this.writeIntent(reconciled.directory, prepared)
    if (preparedConfirmation.durabilityError) throw preparedConfirmation.durabilityError
    const advanced = await this.advanceRebuildIntent(
      prepared,
      reconciled.snapshot.document,
      reconciled.directory,
    )
    if (advanced.error) {
      if (advanced.publishRequired) {
        throw new CanvasAgentNodePublishedError(advanced.error, advanced.document)
      }
      throw advanced.error
    }
    const session = this.dependencies.getSession(advanced.intent.replacementSessionId)
    assertSessionMatchesRebuildIntent(session, advanced.intent)
    return {
      snapshot: {
        ...reconciled.snapshot,
        document: advanced.document,
        nodeIssues: reconciled.snapshot.nodeIssues.filter((issue) => issue.nodeId !== input.nodeId),
      },
      session,
      documentChanged: reconciled.documentChanged || advanced.publishRequired,
    }
  }

  /** 显式把坏节点换绑到新的空白 Canvas Agent session。 */
  async rebuildReconciled(
    input: RebuildCanvasAgentNodeInput,
  ): Promise<CanvasAgentNodeRebuildServiceResult> {
    assertRebuildCanvasAgentNodeInput(input)
    const reconciled = await this.reconcileWithDirectory({
      projectId: input.projectId,
      canvasId: input.canvasId,
    })
    if (reconciled.error) throw reconciled.error
    return this.rebuildAfterReconciliation(input, reconciled)
  }

  /** 基于同次对账结果首次准备或幂等重放用户创建 operation。 */
  private async createAfterReconciliation(
    input: CreateCanvasAgentNodeInput,
    reconciled: CanvasAgentNodeReconciledState,
  ): Promise<CanvasAgentNodeCreationServiceResult> {
    const identity = reconciled.directory
    const existing = reconciled.intents.find((intent) => intent.operationId === input.operationId)
    if (existing) {
      if (existing.nodeId !== input.nodeId
        || existing.title !== input.title
        || existing.position.x !== input.position.x
        || existing.position.y !== input.position.y
        || !isSameRelationship(existing.relationship, input.relationship)) {
        throw new Error('Canvas operationId 已被不同创建请求占用')
      }
      if (existing.state === 'detached') throw new Error('Canvas Agent 创建操作已与节点解除关联')
      if (existing.state !== 'committed') {
        throw new Error('Canvas Agent 创建事务未完成对账')
      }
      if (reconciled.rebuildIntents.some((intent) => intent.nodeId === existing.nodeId)) {
        throw new Error('Canvas Agent 创建操作已被重建会话替代')
      }
      const session = this.dependencies.getSession(existing.sessionId)
      assertSessionMatchesIntent(session, existing)
      return { document: reconciled.snapshot.document, session, documentChanged: false }
    }

    if (input.relationship) {
      const sourceNode = reconciled.snapshot.document.nodes.find((candidate) => (
        candidate.id === input.relationship?.sourceNodeId
      ))
      if (!sourceNode) throw new Error('Canvas 扩展源节点不存在')
      if (reconciled.snapshot.nodeIssues.some((issue) => issue.nodeId === sourceNode.id)) {
        throw new Error('Canvas 扩展源节点会话不可用')
      }
    }

    const settings = this.dependencies.getSettings()
    const channelId = settings.agentChannelId?.trim()
    const modelId = settings.agentModelId?.trim() || undefined
    if (!channelId) throw new Error('Canvas Agent 需要先配置默认渠道')
    this.dependencies.assertModelAvailable(channelId, modelId)
    const sessionId = this.randomUUID()
    if (sessionId.length !== 36 || !UUID_PATTERN.test(sessionId)) {
      throw new Error('Canvas Agent 预分配 sessionId 非法')
    }
    const createdAt = this.now()
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('Canvas Agent 时间戳无效')
    /** prepared 固化默认渠道和模型，恢复不得重新采样设置。 */
    const prepared: CanvasAgentNodeCreationIntent = {
      schemaVersion: 1,
      operationId: input.operationId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      sessionId,
      title: input.title,
      channelId,
      ...(modelId ? { modelId } : {}),
      position: { ...input.position },
      ...(input.relationship
        ? { relationship: { ...input.relationship } }
        : {}),
      state: 'prepared',
      createdAt,
      updatedAt: createdAt,
    }
    const preparedConfirmation = await this.writeIntent(identity, prepared)
    if (preparedConfirmation.durabilityError) throw preparedConfirmation.durabilityError
    const advanced = await this.advanceIntent(prepared, reconciled.snapshot.document, identity)
    if (advanced.error) {
      if (advanced.publishRequired) {
        throw new CanvasAgentNodePublishedError(advanced.error, advanced.document)
      }
      throw advanced.error
    }
    const session = this.dependencies.getSession(advanced.intent.sessionId)
    assertSessionMatchesIntent(session, advanced.intent)
    return {
      document: advanced.document,
      session,
      documentChanged: advanced.publishRequired,
    }
  }

  /**
   * 在一次目录扫描内完成历史对账和当前创建，并保留对账后的操作错误。
   * @param input 已由 IPC 重建的公开创建请求。
   * @returns 可独立发布历史 revision 的对账结果与当前操作结果。
   */
  async createReconciled(input: CreateCanvasAgentNodeInput): Promise<CanvasAgentNodeCreateReconciledOutcome> {
    assertCreateCanvasAgentNodeInput(input)
    /** 对账失败尚无可确认发布事实，继续按原错误直接抛出。 */
    const reconciled = await this.reconcileWithDirectory({
      projectId: input.projectId,
      canvasId: input.canvasId,
    })
    /** 公开对账结果不得泄露目录 capability 或 intent。 */
    const reconciliation: CanvasAgentNodeReconciliationResult = {
      snapshot: reconciled.snapshot,
      documentChanged: reconciled.documentChanged,
      ...(reconciled.error ? { error: reconciled.error } : {}),
    }
    if (reconciliation.error) {
      return {
        reconciliation,
        operationOutcome: { ok: false, error: reconciliation.error },
      }
    }
    try {
      return {
        reconciliation,
        operationOutcome: {
          ok: true,
          value: await this.createAfterReconciliation(input, reconciled),
        },
      }
    } catch (error) {
      if (error instanceof CanvasAgentNodePublishedError) {
        return {
          reconciliation,
          operationOutcome: {
            ok: false,
            error: error.causeError,
            publication: error.document,
          },
        }
      }
      return { reconciliation, operationOutcome: { ok: false, error } }
    }
  }

  /** 兼容服务内直接调用；生产 IPC 应使用 createReconciled 保留发布事实。 */
  async create(input: CreateCanvasAgentNodeInput): Promise<CanvasAgentNodeCreationServiceResult> {
    /** 兼容结果继续合并历史对账与当前操作的文档变化标记。 */
    const outcome = await this.createReconciled(input)
    if (!outcome.operationOutcome.ok) throw outcome.operationOutcome.error
    return {
      ...outcome.operationOutcome.value,
      documentChanged: outcome.reconciliation.documentChanged
        || outcome.operationOutcome.value.documentChanged,
    }
  }
}
