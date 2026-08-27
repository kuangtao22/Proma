import {
  parseCanvasTrashEntry,
  parseCreateCanvasContentNodeInput,
  parseDeleteCanvasNodeInput,
  parseRestoreCanvasNodeInput,
} from '@proma/shared'
import type {
  CanvasContentKind,
  CanvasDocument,
  CanvasMutation,
  CanvasNode,
  CanvasNodeLifecycleResult,
  CanvasTarget,
  CanvasTrashEntry,
  CanvasWorkspaceSnapshot,
  CreateCanvasContentNodeInput,
  CreateCanvasAgentNodeRelationship,
  DeleteCanvasNodeInput,
  RestoreCanvasNodeInput,
} from '@proma/shared'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import type { StableDirectoryNativeWriteOutcome } from '../stable-directory-native-host'
import type {
  CanvasDocumentMigrationCapability,
  CanvasDocumentStore,
  LegacyCanvasContentSeed,
} from './canvas-document-store'
import type { CanvasNodeContentStore } from './canvas-node-content-store'

/** 单个 Canvas 最多保留的所有合法 intent 数量。 */
const MAX_CONTENT_INTENTS = 512
/** content intent 正文硬上限。 */
const MAX_CONTENT_INTENT_BYTES = 64 * 1024
/** content intent 固定文件名合同。 */
const CONTENT_INTENT_NAME = /^content-node-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i
/** intent 内所有稳定业务 ID 使用的有限字符集。 */
const CONTENT_STABLE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** 内容节点事务类别。 */
export type CanvasContentNodeOperation = 'migrate' | 'create' | 'delete' | 'restore'
/** 所有操作共享的有限阶段集合，解析时仍按 operation 收窄。 */
export type CanvasContentNodeState = 'prepared' | 'content-created' | 'trashed' | 'restored' | 'committed'

/** 内容与节点生命周期的持久化 tombstone。 */
export interface CanvasContentNodeIntent {
  schemaVersion: 1
  operation: CanvasContentNodeOperation
  state: CanvasContentNodeState
  operationId: string
  projectId: string
  canvasId: string
  node: CanvasNode
  expectedRevision: number
  relationship?: CreateCanvasAgentNodeRelationship
  trashId?: string
  trashEntry?: CanvasTrashEntry
  legacyContentSeeds?: LegacyCanvasContentSeed[]
  migrationDocument?: CanvasDocument
  createdAt: number
  updatedAt: number
}

/** 已提交图必须先发布再传播的稳定错误。 */
export class CanvasNodeLifecyclePublishedError extends Error {
  /**
   * 构造包含公开图事实的错误。
   * @param causeError 原始持久性错误。
   * @param document 已经可见的权威图文档。
   */
  constructor(readonly causeError: Error, readonly document: CanvasDocument) {
    super(causeError.message, { cause: causeError })
    this.name = 'CanvasNodeLifecyclePublishedError'
  }
}

/** 服务返回的对账事实，Task 4 可区分历史发布与当前结果。 */
export interface CanvasContentNodeReconciliationResult {
  snapshot: CanvasWorkspaceSnapshot
  documentChanged: boolean
  publication?: CanvasDocument
  error?: unknown
}

/** 服务依赖只覆盖图、内容、intent 与 Agent 运行守卫。 */
export interface CanvasContentNodeLifecycleDependencies {
  store: Pick<CanvasDocumentStore, 'loadWithMigrationCapability' | 'mutate'>
  contentStore: CanvasNodeContentStore
  assertAgentNodeIdle: (nodeId: string, sessionId: string) => void
  now?: () => number
  randomUUID?: () => string
  scanIntents?: (target: CanvasTarget) => Promise<CanvasContentNodeIntent[]>
  writeIntent?: (intent: CanvasContentNodeIntent) => Promise<StableDirectoryNativeWriteOutcome>
}

/** 对外服务合同。 */
export interface CanvasContentNodeLifecycle {
  reconcile: (target: CanvasTarget) => Promise<CanvasContentNodeReconciliationResult>
  load: (target: CanvasTarget) => Promise<CanvasContentNodeReconciliationResult>
  create: (input: CreateCanvasContentNodeInput) => Promise<CanvasNodeLifecycleResult>
  delete: (input: DeleteCanvasNodeInput) => Promise<CanvasNodeLifecycleResult>
  restore: (input: RestoreCanvasNodeInput) => Promise<CanvasNodeLifecycleResult>
}

/** 判断未知值为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** 判断对象只包含允许字段并拥有全部必填字段。 */
function hasKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

/** 从节点严格提取受管内容身份。 */
function contentIdentity(node: CanvasNode): { kind: CanvasContentKind; contentId: string } | null {
  if (node.kind === 'image') return { kind: 'image', contentId: node.imageModuleId }
  if (node.kind === 'document') return { kind: 'document', contentId: node.documentId }
  if (node.kind === 'webview') return { kind: 'webview', contentId: node.prototypeId }
  return null
}

/** 要求 content intent 只能引用三类受管内容节点。 */
function requireContentIdentity(node: CanvasNode): { kind: CanvasContentKind; contentId: string } {
  const identity = contentIdentity(node)
  if (!identity) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
  return identity
}

/** 严格重建 intent 内节点，避免未知字段绕过图 Store。 */
function parseIntentNode(value: unknown): CanvasNode {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('CANVAS_CONTENT_INTENT_INVALID')
  const base = {
    id: value.id, kind: value.kind, title: value.title, position: value.position,
  }
  if (value.kind === 'agent') {
    const parsed = parseDeleteCanvasNodeInput({
      projectId: 'project', canvasId: 'canvas', nodeId: value.id,
      operationId: '11111111-1111-4111-8111-111111111111', expectedRevision: 0,
    })
    if (!hasKeys(value, ['id', 'kind', 'title', 'position', 'agentSessionId'])
      || typeof value.agentSessionId !== 'string' || !CONTENT_STABLE_ID.test(value.agentSessionId)
      || typeof value.title !== 'string' || value.title.trim() !== value.title || value.title.length === 0 || value.title.length > 120
      || !isRecord(value.position) || typeof value.position.x !== 'number' || !Number.isFinite(value.position.x)
      || typeof value.position.y !== 'number' || !Number.isFinite(value.position.y)) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
    return { id: parsed.nodeId, kind: 'agent', title: value.title, position: { x: value.position.x, y: value.position.y }, agentSessionId: value.agentSessionId }
  }
  const identityKey = value.kind === 'image' ? 'imageModuleId' : value.kind === 'document' ? 'documentId' : 'prototypeId'
  const parsed = parseCreateCanvasContentNodeInput({
    projectId: 'project', canvasId: 'canvas', operationId: '11111111-1111-4111-8111-111111111111',
    nodeId: value.id, kind: value.kind, contentId: value[identityKey], title: value.title,
    position: value.position, expectedRevision: 0,
  })
  if (parsed.kind === 'image' && hasKeys(value, ['id', 'kind', 'title', 'position', 'imageModuleId'], ['adoptedAssetId'])) {
    if (value.adoptedAssetId !== undefined && typeof value.adoptedAssetId !== 'string') throw new Error('CANVAS_CONTENT_INTENT_INVALID')
    return { id: parsed.nodeId, kind: 'image', title: parsed.title, position: parsed.position, imageModuleId: parsed.contentId, ...(value.adoptedAssetId === undefined ? {} : { adoptedAssetId: value.adoptedAssetId }) }
  }
  if (parsed.kind === 'document' && hasKeys(value, ['id', 'kind', 'title', 'position', 'documentId', 'contentRevision']) && value.contentRevision === 0) {
    return { id: parsed.nodeId, kind: 'document', title: parsed.title, position: parsed.position, documentId: parsed.contentId, contentRevision: 0 }
  }
  if (parsed.kind === 'webview' && hasKeys(value, ['id', 'kind', 'title', 'position', 'prototypeId', 'contentRevision']) && value.contentRevision === 0) {
    return { id: parsed.nodeId, kind: 'webview', title: parsed.title, position: parsed.position, prototypeId: parsed.contentId, contentRevision: 0 }
  }
  throw new Error('CANVAS_CONTENT_INTENT_INVALID')
}

/** 严格解析单个 content intent，Agent intent 由扫描分类提前忽略。 */
export function parseCanvasContentNodeIntent(value: unknown, target: CanvasTarget, operationId: string): CanvasContentNodeIntent {
  const required = ['schemaVersion', 'operation', 'state', 'operationId', 'projectId', 'canvasId', 'node', 'expectedRevision', 'createdAt', 'updatedAt'] as const
  if (!isRecord(value) || !hasKeys(value, required, ['trashId', 'trashEntry', 'relationship', 'legacyContentSeeds', 'migrationDocument'])) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
  const validStates: Record<CanvasContentNodeOperation, readonly CanvasContentNodeState[]> = {
    migrate: ['prepared', 'content-created', 'committed'], create: ['prepared', 'content-created', 'committed'],
    delete: ['prepared', 'trashed', 'committed'], restore: ['prepared', 'restored', 'committed'],
  }
  if ((value.operation !== 'migrate' && value.operation !== 'create' && value.operation !== 'delete' && value.operation !== 'restore')
    || value.schemaVersion !== 1 || value.operationId !== operationId || value.projectId !== target.projectId || value.canvasId !== target.canvasId
    || !validStates[value.operation].includes(value.state as CanvasContentNodeState)
    || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)
    || (value.createdAt as number) < 0 || (value.updatedAt as number) < (value.createdAt as number)) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
  const node = parseIntentNode(value.node)
  const trashEntry = value.trashEntry === undefined ? undefined : parseCanvasTrashEntry(value.trashEntry)
  /** 迁移种子逐项拒绝未知字段、非法类别和身份。 */
  const legacyContentSeeds = value.legacyContentSeeds === undefined ? undefined : (() => {
    if (value.operation !== 'migrate' || !Array.isArray(value.legacyContentSeeds)) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
    return value.legacyContentSeeds.map((seed): LegacyCanvasContentSeed => {
      if (!isRecord(seed)
        || (seed.kind !== 'image' && seed.kind !== 'document' && seed.kind !== 'webview')
        || typeof seed.contentId !== 'string' || !CONTENT_STABLE_ID.test(seed.contentId)) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
      const allowed = seed.kind === 'image' ? ['kind', 'contentId', 'adoptedAssetId']
        : seed.kind === 'webview' ? ['kind', 'contentId', 'legacySourceUrl'] : ['kind', 'contentId']
      if (Object.keys(seed).some((key) => !allowed.includes(key))
        || (seed.adoptedAssetId !== undefined && (typeof seed.adoptedAssetId !== 'string' || !CONTENT_STABLE_ID.test(seed.adoptedAssetId)))
        || (seed.legacySourceUrl !== undefined && (typeof seed.legacySourceUrl !== 'string' || seed.legacySourceUrl.length > 2_048))) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
      return { kind: seed.kind, contentId: seed.contentId, ...(typeof seed.adoptedAssetId === 'string' ? { adoptedAssetId: seed.adoptedAssetId } : {}), ...(typeof seed.legacySourceUrl === 'string' ? { legacySourceUrl: seed.legacySourceUrl } : {}) }
    })
  })()
  /** 创建关系复用共享创建 parser，保证 exact-key 与稳定 ID 边界一致。 */
  const relationship = value.relationship === undefined ? undefined : (() => {
    const identity = contentIdentity(node)
    if (value.operation !== 'create' || !identity) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
    return parseCreateCanvasContentNodeInput({
      projectId: target.projectId, canvasId: target.canvasId, operationId,
      nodeId: node.id, kind: identity.kind, contentId: identity.contentId,
      title: node.title, position: node.position, expectedRevision: value.expectedRevision,
      relationship: value.relationship,
    }).relationship
  })()
  const nodeIdentity = contentIdentity(node)
  if (!nodeIdentity) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
  if (value.operation === 'migrate' && (!legacyContentSeeds || !isRecord(value.migrationDocument))) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
  if (value.operation !== 'migrate' && (legacyContentSeeds !== undefined || value.migrationDocument !== undefined)) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
  if ((value.operation === 'migrate' || value.operation === 'create') && (value.trashId !== undefined || trashEntry !== undefined)) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
  if (value.operation === 'restore' && (typeof value.trashId !== 'string' || !trashEntry)) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
  if (value.operation === 'delete' && (typeof value.trashId !== 'string' || !trashEntry)) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
  if (trashEntry) {
    const identityMatches = trashEntry.trashId === value.trashId
      && trashEntry.nodeId === node.id
      && trashEntry.kind === nodeIdentity.kind
      && trashEntry.contentId === nodeIdentity.contentId
      && trashEntry.title === node.title
    if (!identityMatches) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
    if (value.operation === 'delete'
      && (trashEntry.position.x !== node.position.x
        || trashEntry.position.y !== node.position.y
        || trashEntry.deletedRevision !== value.expectedRevision
        || trashEntry.deletedAt !== value.createdAt)) {
      throw new Error('CANVAS_CONTENT_INTENT_INVALID')
    }
    if (value.operation === 'restore'
      && (trashEntry.deletedRevision > (value.expectedRevision as number)
        || trashEntry.deletedAt > (value.createdAt as number))) {
      throw new Error('CANVAS_CONTENT_INTENT_INVALID')
    }
  }
  return {
    schemaVersion: 1, operation: value.operation, state: value.state as CanvasContentNodeState,
    operationId, projectId: target.projectId, canvasId: target.canvasId, node,
    expectedRevision: value.expectedRevision as number,
    ...(relationship ? { relationship } : {}),
    ...(typeof value.trashId === 'string' ? { trashId: value.trashId } : {}),
    ...(trashEntry ? { trashEntry } : {}),
    ...(legacyContentSeeds ? { legacyContentSeeds } : {}),
    ...(isRecord(value.migrationDocument) ? { migrationDocument: structuredClone(value.migrationDocument) as unknown as CanvasDocument } : {}),
    createdAt: value.createdAt as number, updatedAt: value.updatedAt as number,
  }
}

/** 按类别建立仅引用 contentId 的 v2 节点。 */
function createContentNode(input: CreateCanvasContentNodeInput): CanvasNode {
  const base = { id: input.nodeId, title: input.title, position: input.position }
  if (input.kind === 'image') return { ...base, kind: 'image', imageModuleId: input.contentId }
  if (input.kind === 'document') return { ...base, kind: 'document', documentId: input.contentId, contentRevision: 0 }
  return { ...base, kind: 'webview', prototypeId: input.contentId, contentRevision: 0 }
}

/** 比较已有 operation 与当前输入固化的业务事实。 */
function sameCreate(intent: CanvasContentNodeIntent, input: CreateCanvasContentNodeInput): boolean {
  const identity = contentIdentity(intent.node)
  return intent.operation === 'create' && intent.node.id === input.nodeId && intent.node.title === input.title
    && intent.node.position.x === input.position.x && intent.node.position.y === input.position.y
    && identity?.kind === input.kind && identity.contentId === input.contentId && intent.expectedRevision === input.expectedRevision
    && JSON.stringify(intent.relationship) === JSON.stringify(input.relationship)
}

/** 建立状态单调前进的新 tombstone。 */
function transition(intent: CanvasContentNodeIntent, state: CanvasContentNodeState, now: () => number): CanvasContentNodeIntent {
  return { ...intent, state, updatedAt: Math.max(now(), intent.updatedAt + 1) }
}

/** 把文档包装为最小工作区快照。 */
function snapshot(document: CanvasDocument): CanvasWorkspaceSnapshot {
  return { document, writable: true, nodeIssues: [] }
}

/** 创建 Canvas 内容节点可恢复生命周期服务。 */
export function createCanvasContentNodeLifecycle(dependencies: CanvasContentNodeLifecycleDependencies): CanvasContentNodeLifecycle {
  const now = dependencies.now ?? Date.now
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID

  /** 读取全部 content intent；生产路径只解析固定前缀并忽略 Agent 文件。 */
  const scan = async (target: CanvasTarget, capability: CanvasDocumentMigrationCapability): Promise<CanvasContentNodeIntent[]> => {
    if (dependencies.scanIntents) return dependencies.scanIntents(target)
    const directory = capability.openSingleChildDirectory('transactions')
    const result = await runStableDirectoryNative({ mode: 'canvas-intent-scan', roots: [directory.rootPath], childName: 'transactions', maxDepth: 0, maxEntries: MAX_CONTENT_INTENTS, maxOutputBytes: 40 * 1024 * 1024 }, directory.authorizeOpenedRoots)
    const intents: CanvasContentNodeIntent[] = []
    for (const entry of result.entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const match = CONTENT_INTENT_NAME.exec(entry.name)
      if (!match) continue
      if (entry.isDirectory || typeof entry.content !== 'string' || Buffer.byteLength(entry.content) > MAX_CONTENT_INTENT_BYTES) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
      intents.push(parseCanvasContentNodeIntent(JSON.parse(entry.content) as unknown, target, match[1]!))
    }
    directory.assertValid()
    return intents
  }

  /** 写入一阶段 intent，并对耐久性未确认执行同目录精确重扫。 */
  const write = async (intent: CanvasContentNodeIntent, capability: CanvasDocumentMigrationCapability): Promise<Error | undefined> => {
    const outcome = dependencies.writeIntent
      ? await dependencies.writeIntent(intent)
      : await (async () => {
          const directory = capability.openSingleChildDirectory('transactions')
          const result = await runStableDirectoryNative({ mode: 'canvas-intent-write', roots: [directory.rootPath], childName: 'transactions', fileName: `content-node-${intent.operationId}.json`, content: `${JSON.stringify(intent, null, 2)}\n`, maxEntries: MAX_CONTENT_INTENTS }, directory.authorizeOpenedRoots)
          if (!result.writeOutcome) throw new Error('CANVAS_CONTENT_INTENT_WRITE_FAILED')
          return result.writeOutcome
        })()
    if (!outcome.commitVisible) throw new Error(`CANVAS_CONTENT_INTENT_WRITE_FAILED: ${outcome.error}`)
    if (!outcome.durabilityUncertain) return undefined
    const rescanned = await scan({ projectId: intent.projectId, canvasId: intent.canvasId }, capability)
    const visible = rescanned.some((candidate) => JSON.stringify(candidate) === JSON.stringify(intent))
    if (!visible) throw new Error('CANVAS_CONTENT_INTENT_COMMIT_UNCONFIRMED')
    return new Error(`CANVAS_CONTENT_INTENT_DURABILITY_UNCERTAIN: ${outcome.error}`)
  }

  /** 推进一个未完成 intent，所有阶段均可安全重放。 */
  const advance = async (original: CanvasContentNodeIntent, initial: CanvasDocument, capability: CanvasDocumentMigrationCapability): Promise<{ intent: CanvasContentNodeIntent; document: CanvasDocument; changed: boolean; publishRequired: boolean; error?: Error }> => {
    /** 即使测试注入或未来内部调用绕过扫描，也在副作用前重新执行完整严格解析。 */
    let intent = parseCanvasContentNodeIntent(
      original,
      { projectId: original.projectId, canvasId: original.canvasId },
      original.operationId,
    )
    let document = initial
    let changed = false
    let publishRequired = false
    const target = { projectId: intent.projectId, canvasId: intent.canvasId }
    /** 注入测试或未来调用方绕过 parser 时仍在副作用前拒绝 Agent 节点。 */
    const intentIdentity = requireContentIdentity(intent.node)
    /** 图已提交后，持久化 committed；失败也必须携带待发布图事实。 */
    const persistCommitted = async (): Promise<Error | undefined> => {
      intent = transition(intent, 'committed', now)
      publishRequired = true
      try {
        return await write(intent, capability)
      } catch (error) {
        if (error instanceof Error) return error
        throw error
      }
    }
    if (intent.operation === 'migrate') {
      const migrationDocumentMatches = intent.migrationDocument
        && JSON.stringify(intent.migrationDocument) === JSON.stringify(capability.snapshot.document)
      if (!migrationDocumentMatches) {
        throw new Error('CANVAS_MIGRATION_IDENTITY_CONFLICT')
      }
      if (capability.migratedFrom === 1
        && JSON.stringify(intent.legacyContentSeeds ?? []) !== JSON.stringify(capability.legacyContentSeeds)) {
        throw new Error('CANVAS_MIGRATION_IDENTITY_CONFLICT')
      }
      if (capability.migratedFrom !== 1 && intent.state !== 'content-created') {
        throw new Error('CANVAS_MIGRATION_IDENTITY_CONFLICT')
      }
      if (intent.state === 'prepared') {
        for (const seed of intent.legacyContentSeeds ?? []) {
          try { await dependencies.contentStore.prepareMigratedContent(target, seed) } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('CANVAS_CONTENT_COMMIT_UNCONFIRMED')) throw error
            await dependencies.contentStore.assertContent(target, seed)
          }
        }
        intent = transition(intent, 'content-created', now)
        const error = await write(intent, capability)
        if (error) return { intent, document, changed, publishRequired, error }
      }
      if (intent.state === 'content-created') {
        if (capability.migratedFrom === 1) {
          document = capability.commitMigration()
          changed = true
        }
        const error = await persistCommitted()
        if (error) return { intent, document, changed, publishRequired, error }
      }
      return { intent, document, changed, publishRequired }
    }
    if (intent.operation === 'create') {
      const identity = intentIdentity
      if (intent.state === 'prepared') {
        try { await dependencies.contentStore.prepareEmptyContent(target, identity) } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('CANVAS_CONTENT_COMMIT_UNCONFIRMED')) throw error
          await dependencies.contentStore.assertContent(target, identity)
        }
        intent = transition(intent, 'content-created', now)
        const error = await write(intent, capability)
        if (error) return { intent, document, changed, publishRequired, error }
      }
      if (intent.state === 'content-created') {
        const existing = document.nodes.find((node) => node.id === intent.node.id)
        if (existing && JSON.stringify(existing) !== JSON.stringify(intent.node)) throw new Error('CANVAS_NODE_IDENTITY_CONFLICT')
        if (!existing) {
          const mutations: CanvasMutation[] = [{ type: 'upsert-nodes', nodes: [intent.node] }]
          const relationship = intent.relationship
          if (relationship) {
            if (!document.nodes.some((node) => node.id === relationship.sourceNodeId)) throw new Error('CANVAS_RELATIONSHIP_SOURCE_MISSING')
            mutations.push({ type: 'upsert-edges', edges: [{ id: relationship.edgeId, sourceNodeId: relationship.sourceNodeId, sourcePort: 'output', targetNodeId: intent.node.id, targetPort: 'input' }] })
          }
          document = dependencies.store.mutate(target, document.revision, mutations)
          changed = true
        }
        const error = await persistCommitted()
        if (error) return { intent, document, changed, publishRequired, error }
      }
      return { intent, document, changed, publishRequired }
    }
    if (intent.operation === 'delete') {
      if (!intent.trashEntry) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
      if (intent.state === 'prepared') {
        try { await dependencies.contentStore.moveToTrash(target, intent.trashEntry) } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('CANVAS_CONTENT_COMMIT_UNCONFIRMED')) throw error
          const entries = await dependencies.contentStore.listTrash(target)
          if (!entries.some((entry) => entry.trashId === intent.trashId)) throw error
        }
        intent = transition(intent, 'trashed', now)
        const error = await write(intent, capability)
        if (error) return { intent, document, changed, publishRequired, error }
      }
      if (intent.state === 'trashed') {
        if (document.nodes.some((node) => node.id === intent.node.id)) {
          document = dependencies.store.mutate(target, document.revision, [{ type: 'remove-nodes', nodeIds: [intent.node.id] }])
          changed = true
        }
        const error = await persistCommitted()
        if (error) return { intent, document, changed, publishRequired, error }
      }
      return { intent, document, changed, publishRequired }
    }
    if (!intent.trashEntry) throw new Error('CANVAS_CONTENT_INTENT_INVALID')
    if (intent.state === 'prepared') {
      const restored = await dependencies.contentStore.restoreFromTrash(target, intent.trashId!)
      if (JSON.stringify(restored) !== JSON.stringify(intent.trashEntry)) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      intent = transition(intent, 'restored', now)
      const error = await write(intent, capability)
      if (error) return { intent, document, changed, publishRequired, error }
    }
    if (intent.state === 'restored') {
      const existing = document.nodes.find((node) => node.id === intent.node.id)
      if (existing && JSON.stringify(existing) !== JSON.stringify(intent.node)) throw new Error('CANVAS_NODE_IDENTITY_CONFLICT')
      if (!existing) {
        document = dependencies.store.mutate(target, document.revision, [{ type: 'upsert-nodes', nodes: [intent.node] }])
        changed = true
      }
      const error = await persistCommitted()
      if (error) return { intent, document, changed, publishRequired, error }
    }
    return { intent, document, changed, publishRequired }
  }

  /** 单次扫描并按 operationId 确定性推进全部历史事务。 */
  const reconcileInternal = async (target: CanvasTarget): Promise<{ result: CanvasContentNodeReconciliationResult; capability: CanvasDocumentMigrationCapability; intents: CanvasContentNodeIntent[] }> => {
    const capability = dependencies.store.loadWithMigrationCapability(target)
    const intents = await scan(target, capability)
    let document = capability.snapshot.document
    let changed = false
    let publishRequired = false
    let error: unknown
    for (const original of [...intents].sort((left, right) => left.operationId.localeCompare(right.operationId))) {
      if (original.state === 'committed') continue
      const advanced = await advance(original, document, capability)
      document = advanced.document
      changed ||= advanced.changed
      publishRequired ||= advanced.publishRequired
      if (advanced.error) { error = advanced.error; break }
    }
    return { result: { snapshot: snapshot(document), documentChanged: publishRequired, ...(publishRequired ? { publication: document } : {}), ...(error ? { error } : {}) }, capability, intents }
  }

  /** 在公开操作前对账，并拒绝历史持久性错误被当前操作覆盖。 */
  const requireReconciled = async (target: CanvasTarget) => {
    const reconciled = await reconcileInternal(target)
    if (reconciled.result.error) {
      if (reconciled.result.publication) {
        const error = reconciled.result.error instanceof Error
          ? reconciled.result.error : new Error(String(reconciled.result.error))
        throw new CanvasNodeLifecyclePublishedError(error, reconciled.result.publication)
      }
      throw reconciled.result.error
    }
    return reconciled
  }

  return {
    reconcile: async (target) => (await reconcileInternal(target)).result,
    load: async (target) => {
      const reconciled = await reconcileInternal(target)
      if (reconciled.result.error) return reconciled.result
      if (reconciled.capability.migratedFrom !== 1) return reconciled.result
      const operationId = randomUUID()
      const document = reconciled.capability.snapshot.document
      const representative = document.nodes.find((node) => node.kind !== 'agent')
      if (!representative) {
        /** 空 v1 图没有内容副作用，直接由同次 CAS capability 完成纯 schema 提升。 */
        const migrated = reconciled.capability.commitMigration()
        return { snapshot: snapshot(migrated), documentChanged: true, publication: migrated }
      }
      const timestamp = now()
      const intent: CanvasContentNodeIntent = { schemaVersion: 1, operation: 'migrate', state: 'prepared', operationId, ...target, node: representative, expectedRevision: document.revision, legacyContentSeeds: reconciled.capability.legacyContentSeeds.map((seed) => ({ ...seed })), migrationDocument: structuredClone(document), createdAt: timestamp, updatedAt: timestamp }
      const writeError = await write(intent, reconciled.capability)
      if (writeError) return { ...reconciled.result, error: writeError }
      const advanced = await advance(intent, document, reconciled.capability)
      return { snapshot: snapshot(advanced.document), documentChanged: advanced.publishRequired, ...(advanced.publishRequired ? { publication: advanced.document } : {}), ...(advanced.error ? { error: advanced.error } : {}) }
    },
    create: async (rawInput) => {
      const input = parseCreateCanvasContentNodeInput(rawInput)
      const reconciled = await requireReconciled(input)
      const existing = reconciled.intents.find((intent) => intent.operationId === input.operationId)
      if (existing) {
        if (!sameCreate(existing, input)) throw new Error('CANVAS_OPERATION_CONFLICT')
        return { snapshot: reconciled.result.snapshot, selectedNodeId: existing.node.id }
      }
      const timestamp = now()
      const intent: CanvasContentNodeIntent = { schemaVersion: 1, operation: 'create', state: 'prepared', operationId: input.operationId, projectId: input.projectId, canvasId: input.canvasId, node: createContentNode(input), expectedRevision: input.expectedRevision, ...(input.relationship ? { relationship: input.relationship } : {}), createdAt: timestamp, updatedAt: timestamp }
      if (reconciled.result.snapshot.document.revision !== input.expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
      const error = await write(intent, reconciled.capability)
      if (error) throw error
      const advanced = await advance(intent, reconciled.result.snapshot.document, reconciled.capability)
      if (advanced.error) {
        if (advanced.publishRequired) throw new CanvasNodeLifecyclePublishedError(advanced.error, advanced.document)
        throw advanced.error
      }
      return { snapshot: snapshot(advanced.document), selectedNodeId: input.nodeId }
    },
    delete: async (rawInput) => {
      const input = parseDeleteCanvasNodeInput(rawInput)
      const reconciled = await requireReconciled(input)
      const existing = reconciled.intents.find((intent) => intent.operationId === input.operationId)
      if (existing) {
        if (existing.operation !== 'delete' || existing.node.id !== input.nodeId || existing.expectedRevision !== input.expectedRevision) throw new Error('CANVAS_OPERATION_CONFLICT')
        return { snapshot: reconciled.result.snapshot, ...(existing.trashEntry ? { trashEntry: existing.trashEntry } : {}) }
      }
      const document = reconciled.result.snapshot.document
      if (document.revision !== input.expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
      const node = document.nodes.find((candidate) => candidate.id === input.nodeId)
      if (!node) throw new Error('CANVAS_NODE_NOT_FOUND')
      if (node.kind === 'agent') {
        dependencies.assertAgentNodeIdle(node.id, node.agentSessionId)
        const deleted = dependencies.store.mutate(
          targetFrom(input),
          document.revision,
          [{ type: 'remove-nodes', nodeIds: [node.id] }],
        )
        return { snapshot: snapshot(deleted) }
      }
      const identity = contentIdentity(node)
      const timestamp = now()
      const trashId = identity ? randomUUID() : undefined
      const trashEntry = identity ? parseCanvasTrashEntry({ schemaVersion: 1, trashId, nodeId: node.id, kind: identity.kind, contentId: identity.contentId, title: node.title, position: node.position, deletedRevision: document.revision, deletedAt: timestamp }) : undefined
      const intent: CanvasContentNodeIntent = { schemaVersion: 1, operation: 'delete', state: 'prepared', operationId: input.operationId, ...targetFrom(input), node, expectedRevision: input.expectedRevision, ...(trashId ? { trashId } : {}), ...(trashEntry ? { trashEntry } : {}), createdAt: timestamp, updatedAt: timestamp }
      const error = await write(intent, reconciled.capability)
      if (error) throw error
      const advanced = await advance(intent, document, reconciled.capability)
      if (advanced.error) {
        if (advanced.publishRequired) throw new CanvasNodeLifecyclePublishedError(advanced.error, advanced.document)
        throw advanced.error
      }
      return { snapshot: snapshot(advanced.document), ...(trashEntry ? { trashEntry } : {}) }
    },
    restore: async (rawInput) => {
      const input = parseRestoreCanvasNodeInput(rawInput)
      const reconciled = await requireReconciled(input)
      const existing = reconciled.intents.find((intent) => intent.operationId === input.operationId)
      if (existing) {
        if (existing.operation !== 'restore' || existing.trashId !== input.trashId || existing.expectedRevision !== input.expectedRevision || existing.node.position.x !== input.position.x || existing.node.position.y !== input.position.y) throw new Error('CANVAS_OPERATION_CONFLICT')
        return { snapshot: reconciled.result.snapshot, selectedNodeId: existing.node.id, trashEntry: existing.trashEntry }
      }
      const document = reconciled.result.snapshot.document
      if (document.revision !== input.expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
      const entry = (await dependencies.contentStore.listTrash(input)).find((candidate) => candidate.trashId === input.trashId)
      if (!entry) throw new Error('CANVAS_TRASH_ENTRY_NOT_FOUND')
      const base = { id: entry.nodeId, title: entry.title, position: input.position }
      const node: CanvasNode = entry.kind === 'image' ? { ...base, kind: 'image', imageModuleId: entry.contentId }
        : entry.kind === 'document' ? { ...base, kind: 'document', documentId: entry.contentId, contentRevision: 0 }
          : { ...base, kind: 'webview', prototypeId: entry.contentId, contentRevision: 0 }
      if (document.nodes.some((candidate) => candidate.id === node.id)) throw new Error('CANVAS_NODE_IDENTITY_CONFLICT')
      const timestamp = now()
      const intent: CanvasContentNodeIntent = { schemaVersion: 1, operation: 'restore', state: 'prepared', operationId: input.operationId, ...targetFrom(input), node, expectedRevision: input.expectedRevision, trashId: input.trashId, trashEntry: entry, createdAt: timestamp, updatedAt: timestamp }
      const error = await write(intent, reconciled.capability)
      if (error) throw error
      const advanced = await advance(intent, document, reconciled.capability)
      if (advanced.error) {
        if (advanced.publishRequired) throw new CanvasNodeLifecyclePublishedError(advanced.error, advanced.document)
        throw advanced.error
      }
      return { snapshot: snapshot(advanced.document), selectedNodeId: node.id, trashEntry: entry }
    },
  }
}

/** 从带额外字段的共享命令提取 Canvas 双重身份。 */
function targetFrom(input: CanvasTarget): CanvasTarget {
  return { projectId: input.projectId, canvasId: input.canvasId }
}
