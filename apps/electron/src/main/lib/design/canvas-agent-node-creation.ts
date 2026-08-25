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
import type {
  AgentSessionMeta,
  CanvasAgentNode,
  CanvasAgentNodeCreationResult,
  CanvasDocument,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
  CreateCanvasAgentNodeInput,
  DesignPoint,
} from '@proma/shared'
import type { SecureAtomicJsonWriteOptions } from '../safe-file'
import type { CreateAgentSessionWithMetadataInput } from '../agent-session-manager'
import { hasValidCanvasAgentOwnership } from '../agent-session-visibility'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import type {
  StableDirectoryAuthorization,
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
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
  state: CanvasAgentNodeCreationState
  createdAt: number
  updatedAt: number
}

/** 对账返回公开快照和是否产生新的图 revision。 */
export interface CanvasAgentNodeReconciliationResult {
  snapshot: CanvasWorkspaceSnapshot
  documentChanged: boolean
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
    | { ok: false; error: unknown }
}

/** 服务内部对账结果额外携带同次目录 capability 和最终 intent 集合。 */
interface CanvasAgentNodeReconciledState extends CanvasAgentNodeReconciliationResult {
  directory: CanvasTrustedDirectoryCapability
  intents: CanvasAgentNodeCreationIntent[]
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
  now?: () => number
  randomUUID?: () => string
  readTransactionsDirectory?: (directoryPath: string) => Dirent[]
  afterIntentLstat?: (filePath: string) => void
  afterIntentRead?: (filePath: string) => void
  writeIntent?: (
    filePath: string,
    intent: CanvasAgentNodeCreationIntent,
    options?: SecureAtomicJsonWriteOptions,
  ) => unknown | Promise<unknown>
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
  if (!isRecord(value) || !hasIntentKeys(value, required, ['modelId'])) {
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

/** 从同一 no-follow fd 读取有限 intent，并复核路径和目录身份。 */
function readIntentFile(
  filePath: string,
  target: CanvasTarget,
  operationId: string,
  directoryIdentity: CanvasTrustedDirectoryCapability,
  afterIntentLstat?: (filePath: string) => void,
  afterIntentRead?: (filePath: string) => void,
): CanvasAgentNodeCreationIntent {
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
    return parseIntentJson(raw, target, operationId)
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

/** 验证已有 Agent session 完整属于当前 intent。 */
function assertSessionMatchesIntent(
  session: AgentSessionMeta | undefined,
  intent: CanvasAgentNodeCreationIntent,
): asserts session is AgentSessionMeta {
  if (!session
    || !hasValidCanvasAgentOwnership(session)
    || session.id !== intent.sessionId
    || session.title !== intent.title
    || session.channelId !== intent.channelId
    || session.modelId !== intent.modelId
    || session.workspaceId !== intent.projectId
    || session.sourceCanvasProjectId !== intent.projectId
    || session.sourceCanvasId !== intent.canvasId
    || session.sourceCanvasNodeId !== intent.nodeId) {
    throw new Error(`Canvas Agent session 归属损坏: ${intent.sessionId}`)
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

  /** 校验并解析一条已排序的 intent 文件名。 */
  private parseIntentEntryName(name: string): string | null {
    const match = AGENT_NODE_INTENT_FILE_PATTERN.exec(name)
    if (!match) {
      if (name.startsWith('agent-node-') && name.endsWith('.json')) {
        throw new Error('Canvas Agent 创建事务损坏：文件名无效')
      }
      return null
    }
    const operationId = match[1]!
    if (!UUID_PATTERN.test(operationId)) {
      throw new Error('Canvas Agent 创建事务损坏：文件名无效')
    }
    return operationId
  }

  /** 只扫描目标 Canvas 的有限 transactions 目录，生产正文由 helper 在句柄内读取。 */
  private async readIntents(
    target: CanvasTarget,
    directoryIdentity: CanvasTrustedDirectoryCapability,
  ): Promise<CanvasAgentNodeCreationIntent[]> {
    directoryIdentity.assertValid()
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
      const intents: CanvasAgentNodeCreationIntent[] = []
      for (const entry of result.entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const operationId = this.parseIntentEntryName(entry.name)
        if (!operationId) continue
        if (entry.isDirectory || typeof entry.content !== 'string') {
          throw new Error('Canvas Agent 创建事务损坏：目录项类型无效')
        }
        intents.push(parseIntentJson(entry.content, target, operationId))
      }
      directoryIdentity.assertValid()
      return intents
    }
    /** 测试兼容边界仍从 no-follow fd 读取，以覆盖 Node 状态绑定回归。 */
    const entries = this.readTransactionsDirectory(directoryIdentity.path)
    if (entries.length > MAX_AGENT_NODE_INTENTS) {
      throw new Error('Canvas Agent 创建事务过多，已停止对账')
    }
    /** 文件名排序保证崩溃恢复顺序稳定。 */
    const intents: CanvasAgentNodeCreationIntent[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const operationId = this.parseIntentEntryName(entry.name)
      if (!operationId) continue
      if (!entry.isFile()) throw new Error('Canvas Agent 创建事务损坏：目录项类型无效')
      intents.push(readIntentFile(
        join(directoryIdentity.path, entry.name),
        target,
        operationId,
        directoryIdentity,
        this.dependencies.afterIntentLstat,
        this.dependencies.afterIntentRead,
      ))
    }
    directoryIdentity.assertValid()
    return intents
  }

  /** 通过 helper 在已授权 Canvas root HANDLE 下原子写下一阶段。 */
  private async writeIntent(
    identity: CanvasTrustedDirectoryCapability,
    intent: CanvasAgentNodeCreationIntent,
  ): Promise<void> {
    const fileName = `agent-node-${intent.operationId}.json`
    if (!AGENT_NODE_INTENT_FILE_PATTERN.test(fileName)) throw new Error('Canvas Agent intent 路径无效')
    if (this.writeIntentFile) {
      const filePath = join(identity.path, fileName)
      identity.assertValid()
      await this.writeIntentFile(filePath, intent, { beforeRename: identity.assertValid })
      return
    }
    await this.runNative({
      mode: 'canvas-intent-write',
      roots: [identity.rootPath],
      childName: 'transactions',
      fileName,
      content: `${JSON.stringify(intent, null, 2)}\n`,
      maxEntries: MAX_AGENT_NODE_INTENTS,
    }, identity.authorizeOpenedRoots)
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

  /** 在最新文档上把 prepared/session-created 推进到 committed。 */
  private async advanceIntent(
    originalIntent: CanvasAgentNodeCreationIntent,
    initialDocument: CanvasDocument,
    identity: CanvasTrustedDirectoryCapability,
  ): Promise<{ intent: CanvasAgentNodeCreationIntent; document: CanvasDocument; documentChanged: boolean }> {
    let intent = originalIntent
    let document = initialDocument
    let documentChanged = false
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
      await this.writeIntent(identity, intent)
    }

    if (intent.state === 'session-created') {
      assertSessionMatchesIntent(this.dependencies.getSession(intent.sessionId), intent)
      const existingNode = document.nodes.find((node) => node.id === intent.nodeId)
      if (existingNode) {
        assertNodeMatchesIntent(existingNode, intent)
      } else {
        /** 节点只引用 session，不复制消息或运行状态。 */
        const node: CanvasAgentNode = {
          id: intent.nodeId,
          kind: 'agent',
          title: intent.title,
          position: intent.position,
          agentSessionId: intent.sessionId,
        }
        document = this.dependencies.store.mutate(
          { projectId: intent.projectId, canvasId: intent.canvasId },
          document.revision,
          [{ type: 'upsert-nodes', nodes: [node] }],
        )
        documentChanged = true
      }
      /** committed 是唯一发布屏障；写失败时调用方不得广播或返回 document。 */
      intent = this.transitionIntent(intent, 'committed')
      await this.writeIntent(identity, intent)
    }
    return { intent, document, documentChanged }
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
    /** 保留每个事务对账后的最终阶段，供同次 CREATE 直接复用。 */
    const intents: CanvasAgentNodeCreationIntent[] = []

    for (const originalIntent of await this.readIntents(target, identity)) {
      let intent = originalIntent
      if (intent.state === 'prepared' || intent.state === 'session-created') {
        const advanced = await this.advanceIntent(intent, document, identity)
        intent = advanced.intent
        document = advanced.document
        documentChanged ||= advanced.documentChanged
      }
      if (intent.state === 'committed') {
        assertSessionMatchesIntent(this.dependencies.getSession(intent.sessionId), intent)
        const node = document.nodes.find((candidate) => candidate.id === intent.nodeId)
        if (!node) {
          /** committed 后节点缺失代表用户删除引用，必须永久 detached。 */
          intent = this.transitionIntent(intent, 'detached')
          await this.writeIntent(identity, intent)
        } else {
          assertNodeMatchesIntent(node, intent)
        }
      }
      intents.push(intent)
    }
    return {
      snapshot: { ...snapshot, document },
      documentChanged,
      directory: identity,
      intents,
    }
  }

  /** 惰性对账目标 Canvas，调用方必须已持有唯一 workspace write lease。 */
  async reconcile(target: CanvasTarget): Promise<CanvasAgentNodeReconciliationResult> {
    const { directory: _directory, intents: _intents, ...result } = await this.reconcileWithDirectory(target)
    return result
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
        || existing.position.y !== input.position.y) {
        throw new Error('Canvas operationId 已被不同创建请求占用')
      }
      if (existing.state === 'detached') throw new Error('Canvas Agent 创建操作已与节点解除关联')
      if (existing.state !== 'committed') {
        throw new Error('Canvas Agent 创建事务未完成对账')
      }
      const session = this.dependencies.getSession(existing.sessionId)
      assertSessionMatchesIntent(session, existing)
      return { document: reconciled.snapshot.document, session, documentChanged: false }
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
      state: 'prepared',
      createdAt,
      updatedAt: createdAt,
    }
    await this.writeIntent(identity, prepared)
    const advanced = await this.advanceIntent(prepared, reconciled.snapshot.document, identity)
    const session = this.dependencies.getSession(advanced.intent.sessionId)
    assertSessionMatchesIntent(session, advanced.intent)
    return {
      document: advanced.document,
      session,
      documentChanged: advanced.documentChanged,
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
