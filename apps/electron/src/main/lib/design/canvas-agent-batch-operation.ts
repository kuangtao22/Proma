import { randomUUID as createRandomUUID } from 'node:crypto'
import { applyCanvasMutations } from '@proma/shared'
import type {
  CanvasBatchOperationEnvelope,
  CanvasBatchOperationInput,
  CanvasDocument,
  CanvasMutation,
  CanvasNode,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
} from '@proma/shared'
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

export type CanvasBatchOperationState = 'prepared' | 'resources-created' | 'committed'
export type CanvasBatchPreparedResourceKind = 'agent-session' | 'content-directory'

/** 批量事务创建并负责回收的外部资源。 */
export interface CanvasBatchPreparedResource {
  nodeId: string
  kind: CanvasBatchPreparedResourceKind
  resourceId: string
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
    mutate: (
      target: CanvasTarget,
      expectedRevision: number,
      operations: CanvasMutation[],
    ) => CanvasDocument | Promise<CanvasDocument>
  }
  runWorkspaceWrite: <T>(projectId: string, effect: () => T) => T
  randomUUID?: () => string
  scanIntents?: (target: CanvasTarget) => Promise<CanvasBatchOperationIntent[]>
  writeIntent?: (intent: CanvasBatchOperationIntent) => Promise<StableDirectoryNativeWriteOutcome>
  contentLifecycle: Pick<CanvasContentNodeLifecycle, 'prepareBatchContent' | 'cleanupBatchContent' | 'assertBatchAgentNodeIdle'>
  agentNodeCreation: Pick<CanvasAgentNodeCreationService, 'prepareBatchSession' | 'cleanupBatchSession'>
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
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'operationId', 'target', 'baseRevision', 'source', 'state', 'preparedResources', 'operations'])
    || value.schemaVersion !== 1 || value.operationId !== operationId
    || !isRecord(value.target) || !hasExactKeys(value.target, ['projectId', 'canvasId'])
    || value.target.projectId !== target.projectId || value.target.canvasId !== target.canvasId
    || !Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0
    || !isRecord(value.source) || !hasExactKeys(value.source, ['sessionId', 'runStartedAt', 'toolCallId'])
    || typeof value.source.sessionId !== 'string' || value.source.sessionId.length === 0
    || typeof value.source.toolCallId !== 'string' || value.source.toolCallId.length === 0
    || !Number.isSafeInteger(value.source.runStartedAt) || (value.source.runStartedAt as number) < 0
    || (value.state !== 'prepared' && value.state !== 'resources-created' && value.state !== 'committed')
    || !Array.isArray(value.preparedResources) || !Array.isArray(value.operations)) {
    throw new Error('CANVAS_BATCH_INTENT_INVALID')
  }
  const resources: CanvasBatchPreparedResource[] = []
  const resourceKeys = new Set<string>()
  for (const resource of value.preparedResources) {
    if (!isRecord(resource) || !hasExactKeys(resource, ['nodeId', 'kind', 'resourceId'])
      || typeof resource.nodeId !== 'string' || resource.nodeId.length === 0
      || typeof resource.resourceId !== 'string' || resource.resourceId.length === 0
      || (resource.kind !== 'agent-session' && resource.kind !== 'content-directory')) {
      throw new Error('CANVAS_BATCH_INTENT_INVALID')
    }
    const key = JSON.stringify([resource.kind, resource.resourceId])
    if (resourceKeys.has(key)) throw new Error('CANVAS_BATCH_INTENT_INVALID')
    resourceKeys.add(key)
    resources.push({ nodeId: resource.nodeId, kind: resource.kind, resourceId: resource.resourceId })
  }
  return {
    schemaVersion: 1,
    operationId,
    target: { projectId: target.projectId, canvasId: target.canvasId },
    baseRevision: value.baseRevision as number,
    source: {
      sessionId: value.source.sessionId,
      runStartedAt: value.source.runStartedAt as number,
      toolCallId: value.source.toolCallId,
    },
    state: value.state,
    preparedResources: resources,
    operations: structuredClone(value.operations) as CanvasMutation[],
  }
}

export interface CanvasBatchOperationResult {
  document: CanvasDocument
  operationId: string
}

/** 图已提交但最终 intent 持久性未知时携带权威事实。 */
export class CanvasBatchOperationPublishedError extends Error {
  constructor(readonly causeError: Error, readonly document: CanvasDocument) {
    super(causeError.message, { cause: causeError })
    this.name = 'CanvasBatchOperationPublishedError'
  }
}

/** 从规范 mutation 单次收集需要预备的外部资源。 */
function collectResources(operations: CanvasMutation[]): CanvasBatchPreparedResource[] {
  const resources: CanvasBatchPreparedResource[] = []
  for (const operation of operations) {
    if (operation.type !== 'upsert-nodes') continue
    for (const node of operation.nodes) {
      if (node.kind === 'agent') resources.push({ nodeId: node.id, kind: 'agent-session', resourceId: node.agentSessionId })
      if (node.kind === 'image') resources.push({ nodeId: node.id, kind: 'content-directory', resourceId: node.imageModuleId })
      if (node.kind === 'document') resources.push({ nodeId: node.id, kind: 'content-directory', resourceId: node.documentId })
      if (node.kind === 'webview') resources.push({ nodeId: node.id, kind: 'content-directory', resourceId: node.prototypeId })
    }
  }
  return resources
}

/** 从批次中查找资源所属节点。 */
function findNode(operations: CanvasMutation[], nodeId: string): CanvasNode {
  for (const operation of operations) {
    if (operation.type !== 'upsert-nodes') continue
    const node = operation.nodes.find((candidate) => candidate.id === nodeId)
    if (node) return node
  }
  throw new Error('CANVAS_BATCH_OPERATION_INVALID')
}

/** 从内容节点构造现有内容生命周期的稳定准备输入。 */
function contentInput(node: CanvasNode) {
  if (node.kind === 'image') return { kind: node.kind, contentId: node.imageModuleId }
  if (node.kind === 'document') return { kind: node.kind, contentId: node.documentId }
  if (node.kind === 'webview') return { kind: node.kind, contentId: node.prototypeId }
  throw new Error('CANVAS_BATCH_OPERATION_INVALID')
}

/** 精确比较图事实，忽略 Store 自行推进的 revision 与 updatedAt。 */
function documentContainsCommittedFact(base: CanvasDocument, current: CanvasDocument, operations: CanvasMutation[]): boolean {
  const expected = applyCanvasMutations(base, operations)
  return JSON.stringify({ ...expected, revision: 0, updatedAt: 0 })
    === JSON.stringify({ ...current, revision: 0, updatedAt: 0 })
}

/** 判断批次声明的最终可观察事实已全部出现在单个 revision 中。 */
function documentReflectsOperations(document: CanvasDocument, operations: CanvasMutation[]): boolean {
  for (const operation of operations) {
    if (operation.type === 'set-viewport'
      && JSON.stringify(document.viewport) !== JSON.stringify(operation.viewport)) return false
    if (operation.type === 'move-nodes') {
      for (const moved of operation.positions) {
        const node = document.nodes.find((candidate) => candidate.id === moved.nodeId)
        if (!node || JSON.stringify(node.position) !== JSON.stringify(moved.position)) return false
      }
    }
    if (operation.type === 'upsert-nodes') {
      for (const node of operation.nodes) {
        if (!document.nodes.some((candidate) => JSON.stringify(candidate) === JSON.stringify(node))) return false
      }
    }
    if (operation.type === 'remove-nodes'
      && operation.nodeIds.some((nodeId) => document.nodes.some((node) => node.id === nodeId))) return false
    if (operation.type === 'upsert-edges') {
      for (const edge of operation.edges) {
        if (!document.edges.some((candidate) => JSON.stringify(candidate) === JSON.stringify(edge))) return false
      }
    }
    if (operation.type === 'remove-edges'
      && operation.edgeIds.some((edgeId) => document.edges.some((edge) => edge.id === edgeId))) return false
  }
  return true
}

/** 创建按 Canvas 串行、跨 Canvas 并行的批量事务服务。 */
export function createCanvasAgentBatchOperationService(dependencies: CanvasAgentBatchOperationDependencies) {
  const randomUUID = dependencies.randomUUID ?? createRandomUUID
  const tails = new Map<string, Promise<void>>()

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

  /** 通过稳定目录原子写 intent；rename 后不确定时以同目录 LOAD 对账。 */
  const write = async (intent: CanvasBatchOperationIntent): Promise<Error | undefined> => {
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
    if (!outcome.durabilityUncertain) return undefined
    const visible = (await scan(intent.target)).some((candidate) => JSON.stringify(candidate) === JSON.stringify(intent))
    if (!visible) throw new Error('CANVAS_BATCH_INTENT_COMMIT_UNCONFIRMED')
    return new Error(`CANVAS_BATCH_INTENT_DURABILITY_UNCERTAIN: ${outcome.error ?? '目录持久性未确认'}`)
  }

  /** best-effort 逆序清理本轮资源，清理错误不得覆盖原始失败。 */
  const cleanup = async (
    target: CanvasTarget,
    operationId: string,
    operations: CanvasMutation[],
    resources: CanvasBatchPreparedResource[],
  ): Promise<void> => {
    for (const resource of [...resources].reverse()) {
      try {
        if (resource.kind === 'content-directory') {
          const resourceIndex = collectResources(operations).findIndex((candidate) => (
            candidate.kind === resource.kind && candidate.resourceId === resource.resourceId
          ))
          await dependencies.contentLifecycle.cleanupBatchContent(
            target,
            contentInput(findNode(operations, resource.nodeId)),
            `batch-${operationId.slice(0, 8)}-${resourceIndex}`,
          )
        } else {
          dependencies.agentNodeCreation.cleanupBatchSession({
            ...target,
            nodeId: resource.nodeId,
            sessionId: resource.resourceId,
          })
        }
      } catch { /* 原始事务错误是公开事实。 */ }
    }
  }

  /** 在已取得目标 Canvas 串行权后执行事务。 */
  const executeSerial = async (envelope: CanvasBatchOperationEnvelope): Promise<CanvasBatchOperationResult> => {
    if (envelope.operations.length === 0 || envelope.operations.length > MAX_BATCH_OPERATIONS
      || Buffer.byteLength(JSON.stringify(envelope.operations)) > MAX_BATCH_BYTES) {
      throw new Error('CANVAS_BATCH_OPERATION_LIMIT_EXCEEDED')
    }
    const target = { projectId: envelope.projectId, canvasId: envelope.canvasId }
    const existing = (await scan(target)).find((intent) => intent.source.toolCallId === envelope.sourceToolCallId)
    if (existing) {
      if (existing.source.sessionId !== envelope.sourceSessionId || existing.source.runStartedAt !== envelope.sourceRunStartedAt
        || existing.baseRevision !== envelope.baseRevision || JSON.stringify(existing.operations) !== JSON.stringify(envelope.operations)) {
        throw new Error('CANVAS_BATCH_OPERATION_CONFLICT')
      }
      const current = dependencies.store.load(target).document
      if (existing.state === 'committed') return { document: current, operationId: existing.operationId }
      /** 图提交已可见时旧 baseRevision 必然冲突，必须先以 LOAD 补齐发布屏障。 */
      if (existing.state === 'resources-created'
        && current.revision === existing.baseRevision + 1
        && documentReflectsOperations(current, existing.operations)) {
        const committed = { ...existing, state: 'committed' as const }
        const error = await write(committed)
        if (error) throw new CanvasBatchOperationPublishedError(error, current)
        return { document: current, operationId: existing.operationId }
      }
    }
    const operations = dependencies.store.validateBatchOperations(target, envelope.baseRevision, envelope.operations)
    const input: CanvasBatchOperationInput = { ...target, baseRevision: envelope.baseRevision, operations, sourceSessionId: envelope.sourceSessionId, sourceRunStartedAt: envelope.sourceRunStartedAt, sourceToolCallId: envelope.sourceToolCallId }
    const current = dependencies.store.load(target).document
    for (const operation of operations) {
      if (operation.type !== 'remove-nodes') continue
      for (const nodeId of operation.nodeIds) {
        const node = current.nodes.find((candidate) => candidate.id === nodeId)
        if (node?.kind === 'agent') dependencies.contentLifecycle.assertBatchAgentNodeIdle(node.id, node.agentSessionId)
      }
    }
    let intent: CanvasBatchOperationIntent = existing ?? {
      schemaVersion: 1,
      operationId: randomUUID(),
      target,
      baseRevision: input.baseRevision,
      source: { sessionId: input.sourceSessionId, runStartedAt: input.sourceRunStartedAt, toolCallId: input.sourceToolCallId },
      state: 'prepared',
      preparedResources: collectResources(operations),
      operations,
    }
    if (!existing) {
      const error = await write(intent)
      if (error) throw error
    }
    const created: CanvasBatchPreparedResource[] = []
    if (intent.state === 'prepared') {
      try {
        for (const resource of intent.preparedResources) {
          const node = findNode(intent.operations, resource.nodeId)
          let wasCreated = false
          if (resource.kind === 'content-directory') {
            wasCreated = (await dependencies.contentLifecycle.prepareBatchContent(
              target,
              contentInput(node),
            )).created
          } else {
            wasCreated = dependencies.agentNodeCreation.prepareBatchSession({
              ...target,
              sessionId: resource.resourceId,
              nodeId: resource.nodeId,
              title: node.title,
            }).created
          }
          if (wasCreated) created.push(resource)
        }
        intent = { ...intent, state: 'resources-created' }
        const error = await write(intent)
        if (error) throw error
      } catch (error) {
        await cleanup(target, intent.operationId, intent.operations, created)
        throw error
      }
    }
    let document = dependencies.store.load(target).document
    if (intent.state === 'resources-created') {
      if (!documentContainsCommittedFact(current, document, operations)) {
        try {
          document = await dependencies.store.mutate(target, intent.baseRevision, intent.operations)
        } catch (error) {
          const reloaded = dependencies.store.load(target).document
          if (!documentContainsCommittedFact(current, reloaded, operations)) {
            await cleanup(target, intent.operationId, intent.operations, created)
            throw error
          }
          document = reloaded
        }
      }
      intent = { ...intent, state: 'committed' }
      const error = await write(intent)
      if (error) throw new CanvasBatchOperationPublishedError(error, document)
    }
    return { document, operationId: intent.operationId }
  }

  return {
    execute: (envelope: CanvasBatchOperationEnvelope): Promise<CanvasBatchOperationResult> => {
      const key = JSON.stringify([envelope.projectId, envelope.canvasId])
      const previous = tails.get(key) ?? Promise.resolve()
      const result = previous.catch(() => undefined).then(() => dependencies.runWorkspaceWrite(
        envelope.projectId,
        () => executeSerial(envelope),
      ))
      const tail = result.then(() => undefined, () => undefined)
      tails.set(key, tail)
      void tail.finally(() => { if (tails.get(key) === tail) tails.delete(key) })
      return result
    },
  }
}
