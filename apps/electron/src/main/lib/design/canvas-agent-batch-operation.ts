import { randomUUID as createRandomUUID } from 'node:crypto'
import type {
  CanvasBatchOperationEnvelope,
  CanvasDocument,
  CanvasMutation,
  CanvasNode,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
  CanvasTrashEntry,
} from '@proma/shared'
import { parseCanvasTrashEntry } from '@proma/shared'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import type { StableDirectoryNativeWriteOutcome } from '../stable-directory-native-host'
import type { CanvasDocumentStore, CanvasTrustedDirectoryCapability } from './canvas-document-store'
import type { CanvasContentNodeLifecycle } from './canvas-content-node-lifecycle'
import type { CanvasAgentNodeCreationService } from './canvas-agent-node-creation'

const MAX_BATCH_OPERATIONS = 128
/** operations 预算为 48 KiB，为 64 KiB intent 协议保留元数据空间。 */
const MAX_BATCH_BYTES = 48 * 1024
const MAX_BATCH_INTENTS = 512
const BATCH_INTENT_PATTERN = /^canvas-batch-([0-9a-f-]{36})\.json$/i

export type CanvasBatchOperationState = 'prepared' | 'resources-created' | 'cleanup-pending' | 'rolled-back' | 'committed'
export type CanvasBatchPreparedResourceKind = 'agent-session' | 'content-directory' | 'content-trash'
export type CanvasBatchPreparedResourceState = 'pending' | 'preparing' | 'ready' | 'cleanup-pending' | 'cleaned'

/** 批量事务外部资源的逐项持久化归属与恢复状态。 */
export interface CanvasBatchPreparedResource {
  nodeId: string
  kind: CanvasBatchPreparedResourceKind
  resourceId: string
  state: CanvasBatchPreparedResourceState
  createdByOperation: boolean | null
  trashEntry: CanvasTrashEntry | null
}

/** 位于目标 Canvas transactions 目录的可恢复批量事务。 */
export interface CanvasBatchOperationIntent {
  schemaVersion: 1
  operationId: string
  target: CanvasTarget
  baseRevision: number
  source: { sessionId: string; runStartedAt: number; toolCallId: string }
  state: CanvasBatchOperationState
  preparedResources: CanvasBatchPreparedResource[]
  operations: CanvasMutation[]
}

export interface CanvasAgentBatchOperationDependencies {
  store: {
    load: (target: CanvasTarget) => CanvasWorkspaceSnapshot
    loadWithDirectoryCapability?: CanvasDocumentStore['loadWithDirectoryCapability']
    validateBatchOperations: CanvasDocumentStore['validateBatchOperations']
    mutate: (target: CanvasTarget, expectedRevision: number, operations: CanvasMutation[]) => CanvasDocument | Promise<CanvasDocument>
  }
  /** 由 IPC 注入的唯一按 Canvas 串行与 workspace write lease 边界。 */
  runExclusive: <T>(target: CanvasTarget, effect: () => Promise<T>) => Promise<T>
  randomUUID?: () => string
  now?: () => number
  scanIntents?: (target: CanvasTarget) => Promise<CanvasBatchOperationIntent[]>
  writeIntent?: (intent: CanvasBatchOperationIntent) => Promise<StableDirectoryNativeWriteOutcome>
  contentLifecycle: Pick<CanvasContentNodeLifecycle, 'inspectBatchContent' | 'prepareBatchContent' | 'cleanupBatchContent' | 'prepareBatchDeletion' | 'restoreBatchDeletion' | 'assertBatchAgentNodeIdle'>
  agentNodeCreation: Pick<CanvasAgentNodeCreationService, 'inspectBatchSession' | 'prepareBatchSession' | 'cleanupBatchSession'>
}

/** 判断未知值是没有自定义原型的普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 判断记录字段与 schema 完全一致。 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** 严格解析磁盘批量 intent，损坏项不得进入恢复或幂等判断。 */
function parseIntent(value: unknown, target: CanvasTarget, operationId: string): CanvasBatchOperationIntent {
  const validStates: CanvasBatchOperationState[] = ['prepared', 'resources-created', 'cleanup-pending', 'rolled-back', 'committed']
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'operationId', 'target', 'baseRevision', 'source', 'state', 'preparedResources', 'operations'])
    || value.schemaVersion !== 1 || value.operationId !== operationId
    || !isRecord(value.target) || !hasExactKeys(value.target, ['projectId', 'canvasId'])
    || value.target.projectId !== target.projectId || value.target.canvasId !== target.canvasId
    || !Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0
    || !isRecord(value.source) || !hasExactKeys(value.source, ['sessionId', 'runStartedAt', 'toolCallId'])
    || typeof value.source.sessionId !== 'string' || value.source.sessionId.length === 0
    || typeof value.source.toolCallId !== 'string' || value.source.toolCallId.length === 0
    || !Number.isSafeInteger(value.source.runStartedAt) || (value.source.runStartedAt as number) < 0
    || !validStates.includes(value.state as CanvasBatchOperationState)
    || !Array.isArray(value.preparedResources) || !Array.isArray(value.operations)) {
    throw new Error('CANVAS_BATCH_INTENT_INVALID')
  }
  const validResourceStates: CanvasBatchPreparedResourceState[] = ['pending', 'preparing', 'ready', 'cleanup-pending', 'cleaned']
  const resourceKeys = new Set<string>()
  const resources: CanvasBatchPreparedResource[] = []
  for (const resource of value.preparedResources) {
    if (!isRecord(resource)
      || !hasExactKeys(resource, ['nodeId', 'kind', 'resourceId', 'state', 'createdByOperation', 'trashEntry'])
      || typeof resource.nodeId !== 'string' || resource.nodeId.length === 0
      || typeof resource.resourceId !== 'string' || resource.resourceId.length === 0
      || (resource.kind !== 'agent-session' && resource.kind !== 'content-directory' && resource.kind !== 'content-trash')
      || !validResourceStates.includes(resource.state as CanvasBatchPreparedResourceState)
      || (resource.createdByOperation !== null && typeof resource.createdByOperation !== 'boolean')
      || (resource.kind === 'content-trash' && resource.trashEntry === null)
      || (resource.kind !== 'content-trash' && resource.trashEntry !== null)) {
      throw new Error('CANVAS_BATCH_INTENT_INVALID')
    }
    const trashEntry = resource.trashEntry === null ? null : parseCanvasTrashEntry(resource.trashEntry)
    if (trashEntry && (trashEntry.nodeId !== resource.nodeId || trashEntry.contentId !== resource.resourceId)) {
      throw new Error('CANVAS_BATCH_INTENT_INVALID')
    }
    const key = JSON.stringify([resource.kind, resource.resourceId])
    if (resourceKeys.has(key)) throw new Error('CANVAS_BATCH_INTENT_INVALID')
    resourceKeys.add(key)
    resources.push({
      nodeId: resource.nodeId,
      kind: resource.kind,
      resourceId: resource.resourceId,
      state: resource.state as CanvasBatchPreparedResourceState,
      createdByOperation: resource.createdByOperation,
      trashEntry,
    })
  }
  return {
    schemaVersion: 1,
    operationId,
    target: { projectId: target.projectId, canvasId: target.canvasId },
    baseRevision: value.baseRevision as number,
    source: { sessionId: value.source.sessionId, runStartedAt: value.source.runStartedAt as number, toolCallId: value.source.toolCallId },
    state: value.state as CanvasBatchOperationState,
    preparedResources: resources,
    operations: structuredClone(value.operations) as CanvasMutation[],
  }
}

export interface CanvasBatchOperationResult {
  document: CanvasDocument
  operationId: string
}

/** LOAD/SAVE 对账期间新提交的图事实，必须在 workspace lease 释放后发布。 */
export interface CanvasBatchReconciliationResult extends CanvasBatchOperationResult {
  publications: CanvasDocument[]
}

/** 图已提交但最终 intent 持久性未知时携带权威事实。 */
export class CanvasBatchOperationPublishedError extends Error {
  constructor(readonly causeError: Error, readonly document: CanvasDocument) {
    super(causeError.message, { cause: causeError })
    this.name = 'CanvasBatchOperationPublishedError'
  }
}

/** intent 已可见但目录耐久性未知，调用方必须通过 LOAD 恢复。 */
export class CanvasBatchRecoveryRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`CANVAS_BATCH_RECOVERY_REQUIRED: ${message}`, options)
    this.name = 'CanvasBatchRecoveryRequiredError'
  }
}

/** 从规范 mutation 单次收集需要预备的外部资源。 */
function collectResources(
  operations: CanvasMutation[],
  document: CanvasDocument,
  randomUUID: () => string,
  now: () => number,
): CanvasBatchPreparedResource[] {
  const resources: CanvasBatchPreparedResource[] = []
  const existingNodes = new Map(document.nodes.map((node) => [node.id, node]))
  const deletionNodeIds = new Set<string>()
  for (const operation of operations) {
    if (operation.type !== 'upsert-nodes') continue
    for (const node of operation.nodes) {
      const base = { nodeId: node.id, state: 'pending' as const, createdByOperation: null, trashEntry: null }
      if (node.kind === 'agent') resources.push({ ...base, kind: 'agent-session', resourceId: node.agentSessionId })
      if (node.kind === 'image') resources.push({ ...base, kind: 'content-directory', resourceId: node.imageModuleId })
      if (node.kind === 'document') resources.push({ ...base, kind: 'content-directory', resourceId: node.documentId })
      if (node.kind === 'webview') resources.push({ ...base, kind: 'content-directory', resourceId: node.prototypeId })
    }
  }
  for (const operation of operations) {
    if (operation.type !== 'remove-nodes') continue
    for (const nodeId of operation.nodeIds) {
      if (deletionNodeIds.has(nodeId)) continue
      deletionNodeIds.add(nodeId)
      const node = existingNodes.get(nodeId)
      if (!node || node.kind === 'agent') continue
      const contentId = node.kind === 'image' ? node.imageModuleId
        : node.kind === 'document' ? node.documentId : node.prototypeId
      const entry = parseCanvasTrashEntry({
        schemaVersion: 1,
        trashId: randomUUID(),
        nodeId: node.id,
        kind: node.kind,
        contentId,
        title: node.title,
        position: node.position,
        deletedRevision: document.revision,
        deletedAt: now(),
      })
      resources.push({
        nodeId: node.id,
        kind: 'content-trash',
        resourceId: contentId,
        state: 'pending',
        createdByOperation: null,
        trashEntry: entry,
      })
    }
  }
  return resources
}

/** 一次构建批次节点索引，资源准备和清理均保持 O(n)。 */
function indexNodes(operations: CanvasMutation[]): Map<string, CanvasNode> {
  const nodes = new Map<string, CanvasNode>()
  for (const operation of operations) {
    if (operation.type !== 'upsert-nodes') continue
    for (const node of operation.nodes) nodes.set(node.id, node)
  }
  return nodes
}

/** 从内容节点构造现有内容生命周期的稳定准备输入。 */
function contentInput(node: CanvasNode) {
  if (node.kind === 'image') return { kind: node.kind, contentId: node.imageModuleId }
  if (node.kind === 'document') return { kind: node.kind, contentId: node.documentId }
  if (node.kind === 'webview') return { kind: node.kind, contentId: node.prototypeId }
  throw new Error('CANVAS_BATCH_OPERATION_INVALID')
}

/** 用预建索引判断当前图是否反映批次的最终事实。 */
function documentReflectsOperations(document: CanvasDocument, operations: CanvasMutation[]): boolean {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]))
  const edges = new Map(document.edges.map((edge) => [edge.id, edge]))
  for (const operation of operations) {
    if (operation.type === 'set-viewport' && JSON.stringify(document.viewport) !== JSON.stringify(operation.viewport)) return false
    if (operation.type === 'move-nodes') {
      for (const moved of operation.positions) {
        if (JSON.stringify(nodes.get(moved.nodeId)?.position) !== JSON.stringify(moved.position)) return false
      }
    }
    if (operation.type === 'upsert-nodes') {
      for (const node of operation.nodes) if (JSON.stringify(nodes.get(node.id)) !== JSON.stringify(node)) return false
    }
    if (operation.type === 'remove-nodes') {
      for (const nodeId of operation.nodeIds) if (nodes.has(nodeId)) return false
    }
    if (operation.type === 'upsert-edges') {
      for (const edge of operation.edges) if (JSON.stringify(edges.get(edge.id)) !== JSON.stringify(edge)) return false
    }
    if (operation.type === 'remove-edges') {
      for (const edgeId of operation.edgeIds) if (edges.has(edgeId)) return false
    }
  }
  return true
}

/** 创建只负责持久事务逻辑、由外部共享串行器调度的批量服务。 */
export function createCanvasAgentBatchOperationService(dependencies: CanvasAgentBatchOperationDependencies) {
  const randomUUID = dependencies.randomUUID ?? createRandomUUID
  const now = dependencies.now ?? Date.now

  /** 使用稳定目录 helper 扫描批量 intent，测试可注入内存实现。 */
  const scan = async (target: CanvasTarget): Promise<CanvasBatchOperationIntent[]> => {
    if (dependencies.scanIntents) return dependencies.scanIntents(target)
    const loaded = dependencies.store.loadWithDirectoryCapability?.(target)
    if (!loaded) throw new Error('CANVAS_BATCH_DIRECTORY_CAPABILITY_MISSING')
    const directory = loaded.openSingleChildDirectory('transactions')
    const result = await runStableDirectoryNative({ mode: 'canvas-intent-scan', roots: [directory.rootPath], childName: 'transactions', maxDepth: 0, maxEntries: MAX_BATCH_INTENTS, maxOutputBytes: 40 * 1024 * 1024 }, directory.authorizeOpenedRoots)
    const intents: CanvasBatchOperationIntent[] = []
    for (const entry of result.entries) {
      const match = BATCH_INTENT_PATTERN.exec(entry.name)
      if (!match) continue
      if (entry.isDirectory || typeof entry.content !== 'string') throw new Error('CANVAS_BATCH_INTENT_INVALID')
      intents.push(parseIntent(JSON.parse(entry.content), target, match[1]!))
    }
    directory.assertValid()
    return intents
  }

  /** 通过稳定目录原子写 intent；rename 可见但不确定时只允许后续恢复。 */
  const write = async (intent: CanvasBatchOperationIntent): Promise<void> => {
    let outcome: StableDirectoryNativeWriteOutcome
    if (dependencies.writeIntent) {
      outcome = await dependencies.writeIntent(intent)
    } else {
      const loaded = dependencies.store.loadWithDirectoryCapability?.(intent.target)
      if (!loaded) throw new Error('CANVAS_BATCH_DIRECTORY_CAPABILITY_MISSING')
      const directory: CanvasTrustedDirectoryCapability = loaded.openSingleChildDirectory('transactions')
      const result = await runStableDirectoryNative({ mode: 'canvas-intent-write', roots: [directory.rootPath], childName: 'transactions', fileName: `canvas-batch-${intent.operationId}.json`, content: `${JSON.stringify(intent, null, 2)}\n`, maxEntries: MAX_BATCH_INTENTS }, directory.authorizeOpenedRoots)
      if (!result.writeOutcome) throw new Error('CANVAS_BATCH_INTENT_WRITE_FAILED')
      outcome = result.writeOutcome
    }
    if (!outcome.commitVisible) throw new Error(`CANVAS_BATCH_INTENT_WRITE_FAILED: ${outcome.error ?? 'intent 未提交'}`)
    if (!outcome.durabilityUncertain) return
    const visible = (await scan(intent.target)).some((candidate) => JSON.stringify(candidate) === JSON.stringify(intent))
    if (!visible) throw new Error('CANVAS_BATCH_INTENT_COMMIT_UNCONFIRMED')
    throw new CanvasBatchRecoveryRequiredError(`CANVAS_BATCH_INTENT_DURABILITY_UNCERTAIN: ${outcome.error ?? '目录持久性未确认'}`)
  }

  /** 把单项资源状态写回 intent，保证下一项副作用前已有崩溃恢复依据。 */
  const updateResource = async (intent: CanvasBatchOperationIntent, index: number, resource: CanvasBatchPreparedResource, state = intent.state): Promise<CanvasBatchOperationIntent> => {
    const next = {
      ...intent,
      state,
      preparedResources: intent.preparedResources.map((candidate, candidateIndex) => candidateIndex === index ? resource : candidate),
    }
    await write(next)
    return next
  }

  /** 返回资源对应节点；损坏 intent 必须 fail closed。 */
  const requireResourceNode = (nodes: Map<string, CanvasNode>, resource: CanvasBatchPreparedResource): CanvasNode => {
    const node = nodes.get(resource.nodeId)
    if (!node) throw new Error('CANVAS_BATCH_OPERATION_INVALID')
    return node
  }

  /** 逆序回收本事务拥有的资源，并逐项持久化 cleanup-pending/cleaned。 */
  const cleanup = async (original: CanvasBatchOperationIntent): Promise<CanvasBatchOperationIntent> => {
    let intent = original.state === 'cleanup-pending' ? original : { ...original, state: 'cleanup-pending' as const }
    if (intent !== original) await write(intent)
    const nodes = indexNodes(intent.operations)
    for (let index = intent.preparedResources.length - 1; index >= 0; index -= 1) {
      let resource = intent.preparedResources[index]!
      if (resource.createdByOperation !== true || resource.state === 'cleaned') continue
      if (resource.state !== 'cleanup-pending') {
        resource = { ...resource, state: 'cleanup-pending' }
        intent = await updateResource(intent, index, resource, 'cleanup-pending')
      }
      try {
        if (resource.kind === 'content-trash') {
          if (!resource.trashEntry) throw new Error('CANVAS_BATCH_INTENT_INVALID')
          await dependencies.contentLifecycle.restoreBatchDeletion(intent.target, resource.trashEntry)
        } else if (resource.kind === 'content-directory') {
          await dependencies.contentLifecycle.cleanupBatchContent(intent.target, contentInput(requireResourceNode(nodes, resource)), `batch-${intent.operationId.slice(0, 8)}-${index}`)
        } else {
          dependencies.agentNodeCreation.cleanupBatchSession({ ...intent.target, nodeId: resource.nodeId, sessionId: resource.resourceId })
        }
      } catch (cleanupError) {
        console.error('[CanvasBatch] 批量资源清理失败，已保留恢复证据:', cleanupError)
        throw new CanvasBatchRecoveryRequiredError('CANVAS_BATCH_CLEANUP_FAILED', { cause: cleanupError })
      }
      resource = { ...resource, state: 'cleaned' }
      intent = await updateResource(intent, index, resource, 'cleanup-pending')
    }
    const rolledBack = { ...intent, state: 'rolled-back' as const }
    await write(rolledBack)
    return rolledBack
  }

  /** 逐项准备资源；每项创建前先持久化归属，创建后再持久化 ready。 */
  const prepareResources = async (original: CanvasBatchOperationIntent): Promise<CanvasBatchOperationIntent> => {
    let intent = original
    const nodes = indexNodes(intent.operations)
    try {
      for (let index = 0; index < intent.preparedResources.length; index += 1) {
        let resource = intent.preparedResources[index]!
        if (resource.state === 'ready') continue
        if (resource.state !== 'pending' && resource.state !== 'preparing') throw new Error('CANVAS_BATCH_INTENT_INVALID')
        const node = resource.kind === 'content-trash' ? null : requireResourceNode(nodes, resource)
        if (resource.state === 'pending') {
          let inspection: { exists: boolean }
          if (resource.kind === 'content-trash') {
            inspection = { exists: false }
          } else {
            if (!node) throw new Error('CANVAS_BATCH_OPERATION_INVALID')
            inspection = resource.kind === 'content-directory'
              ? await dependencies.contentLifecycle.inspectBatchContent(intent.target, contentInput(node))
              : dependencies.agentNodeCreation.inspectBatchSession({ ...intent.target, nodeId: resource.nodeId, sessionId: resource.resourceId, title: node.title })
          }
          resource = { ...resource, state: 'preparing', createdByOperation: !inspection.exists }
          intent = await updateResource(intent, index, resource)
        }
        let prepared: { created: boolean }
        if (resource.kind === 'content-trash') {
          if (!resource.trashEntry) throw new Error('CANVAS_BATCH_INTENT_INVALID')
          await dependencies.contentLifecycle.prepareBatchDeletion(intent.target, resource.trashEntry)
          prepared = { created: true }
        } else {
          if (!node) throw new Error('CANVAS_BATCH_OPERATION_INVALID')
          prepared = resource.kind === 'content-directory'
            ? await dependencies.contentLifecycle.prepareBatchContent(intent.target, contentInput(node))
            : dependencies.agentNodeCreation.prepareBatchSession({ ...intent.target, nodeId: resource.nodeId, sessionId: resource.resourceId, title: node.title })
        }
        if (resource.createdByOperation === false && prepared.created) throw new Error('CANVAS_BATCH_RESOURCE_OWNERSHIP_CONFLICT')
        resource = { ...resource, state: 'ready' }
        intent = await updateResource(intent, index, resource)
      }
      const resourcesCreated = { ...intent, state: 'resources-created' as const }
      await write(resourcesCreated)
      return resourcesCreated
    } catch (error) {
      /** rename 已可见但耐久不确定时 intent 本身就是恢复依据，禁止回滚。 */
      if (error instanceof CanvasBatchRecoveryRequiredError) throw error
      await cleanup(intent)
      throw error
    }
  }

  /** 校验 Agent 删除运行守卫；内容节点由同批 trash 资源状态机处理。 */
  const assertRemovalsAllowed = (document: CanvasDocument, operations: CanvasMutation[]): void => {
    const nodes = new Map(document.nodes.map((node) => [node.id, node]))
    for (const operation of operations) {
      if (operation.type !== 'remove-nodes') continue
      for (const nodeId of operation.nodeIds) {
        const node = nodes.get(nodeId)
        if (!node) continue
        if (node.kind === 'agent') dependencies.contentLifecycle.assertBatchAgentNodeIdle(node.id, node.agentSessionId)
      }
    }
  }

  /** 从 resources-created 推进单次图提交，并处理提交已可见的不确定结果。 */
  const commit = async (intent: CanvasBatchOperationIntent): Promise<CanvasBatchOperationResult> => {
    let document = dependencies.store.load(intent.target).document
    if (document.revision === intent.baseRevision) {
      try {
        document = await dependencies.store.mutate(intent.target, intent.baseRevision, intent.operations)
      } catch (error) {
        const reloaded = dependencies.store.load(intent.target).document
        if (reloaded.revision !== intent.baseRevision + 1 || !documentReflectsOperations(reloaded, intent.operations)) {
          await cleanup(intent)
          throw error
        }
        document = reloaded
      }
    } else if (document.revision !== intent.baseRevision + 1 || !documentReflectsOperations(document, intent.operations)) {
      throw new CanvasBatchRecoveryRequiredError('CANVAS_BATCH_GRAPH_FACT_CONFLICT')
    }
    try {
      await write({ ...intent, state: 'committed' })
    } catch (error) {
      throw new CanvasBatchOperationPublishedError(error instanceof Error ? error : new Error(String(error)), document)
    }
    return { document, operationId: intent.operationId }
  }

  /** 在调用方已经持有共享 Canvas 串行权与 workspace lease 时恢复全部 intent。 */
  const reconcileLocked = async (target: CanvasTarget): Promise<CanvasBatchReconciliationResult> => {
    let operationId = ''
    const publications: CanvasDocument[] = []
    for (const original of await scan(target)) {
      operationId = original.operationId
      if (original.state === 'committed' || original.state === 'rolled-back') continue
      if (original.state === 'cleanup-pending') {
        await cleanup(original)
        continue
      }
      let intent = original
      if (intent.state === 'prepared') {
        intent = await prepareResources(intent)
      }
      const beforeRevision = dependencies.store.load(target).document.revision
      const result = await commit(intent)
      if (result.document.revision > beforeRevision) publications.push(result.document)
    }
    return { document: dependencies.store.load(target).document, operationId, publications }
  }

  /** 在已取得共享 Canvas 串行权与 workspace lease 时执行新批次。 */
  const executeLocked = async (envelope: CanvasBatchOperationEnvelope): Promise<CanvasBatchOperationResult> => {
    if (envelope.operations.length === 0 || envelope.operations.length > MAX_BATCH_OPERATIONS || Buffer.byteLength(JSON.stringify(envelope.operations)) > MAX_BATCH_BYTES) {
      throw new Error('CANVAS_BATCH_OPERATION_LIMIT_EXCEEDED')
    }
    const target = { projectId: envelope.projectId, canvasId: envelope.canvasId }
    const existing = (await scan(target)).find((intent) => intent.source.toolCallId === envelope.sourceToolCallId)
    if (existing) {
      if (existing.source.sessionId !== envelope.sourceSessionId || existing.source.runStartedAt !== envelope.sourceRunStartedAt
        || existing.baseRevision !== envelope.baseRevision || JSON.stringify(existing.operations) !== JSON.stringify(envelope.operations)) {
        throw new Error('CANVAS_BATCH_OPERATION_CONFLICT')
      }
      if (existing.state === 'rolled-back') throw new Error('CANVAS_BATCH_OPERATION_ROLLED_BACK')
      await reconcileLocked(target)
      return { document: dependencies.store.load(target).document, operationId: existing.operationId }
    }
    const operations = dependencies.store.validateBatchOperations(target, envelope.baseRevision, envelope.operations)
    const document = dependencies.store.load(target).document
    assertRemovalsAllowed(document, operations)
    let intent: CanvasBatchOperationIntent = {
      schemaVersion: 1,
      operationId: randomUUID(),
      target,
      baseRevision: envelope.baseRevision,
      source: { sessionId: envelope.sourceSessionId, runStartedAt: envelope.sourceRunStartedAt, toolCallId: envelope.sourceToolCallId },
      state: 'prepared',
      preparedResources: collectResources(operations, document, randomUUID, now),
      operations,
    }
    await write(intent)
    intent = await prepareResources(intent)
    return commit(intent)
  }

  return {
    executeLocked,
    reconcileLocked,
    execute: (envelope: CanvasBatchOperationEnvelope): Promise<CanvasBatchOperationResult> => dependencies.runExclusive({ projectId: envelope.projectId, canvasId: envelope.canvasId }, () => executeLocked(envelope)),
    reconcile: (target: CanvasTarget): Promise<CanvasBatchOperationResult> => dependencies.runExclusive(target, () => reconcileLocked(target)),
  }
}
