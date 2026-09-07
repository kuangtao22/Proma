import { createHash, randomUUID } from 'node:crypto'
import {
  parseAdoptCanvasImageCandidateBatchInput,
  parseGetCanvasImageCandidateBatchInput,
} from '@proma/shared'
import type {
  AdoptCanvasImageCandidateBatchInput,
  CanvasImageCandidateBatch,
  CanvasImageCandidateBatchEntry,
  CanvasImageCandidateBatchSource,
  CanvasImageCandidateBatchSummary,
  CanvasImageModuleConfig,
  CanvasImageTarget,
  CanvasDocument,
  CanvasNode,
  CanvasTarget,
} from '@proma/shared'
import type {
  CanvasImageCandidateAdoptionIntent,
  CanvasImageCandidateBatchStore,
} from './canvas-image-candidate-batch-store'
import type { CanvasDependencyStateService } from './canvas-dependency-state-service'
import { reportCanvasImageDiagnostic } from './canvas-image-diagnostics'
import { parseCanvasDocument } from './canvas-document-store'

/** 创建批次时每个节点已经固化的基线。 */
export interface CreateCanvasImageCandidateBatchEntry {
  nodeId: string
  imageModuleId: string
  initialAdoptedAssetId: string | null
  initialConfigRevision: number
  jobId: string
}

/** 创建单节点或 Agent 批量候选的输入。 */
export interface CreateCanvasImageCandidateBatchInput extends CanvasTarget {
  batchId: string
  source: CanvasImageCandidateBatchSource
  sourceSessionId: string | null
  sourceToolCallId: string | null
  entries: CreateCanvasImageCandidateBatchEntry[]
}

/** Job 终态登记只携带可公开的稳定事实。 */
export interface CanvasImageCandidateJobTerminalEvent extends CanvasTarget {
  jobId: string
  candidateBatchId?: string
  status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  outputAssetId: string | null
  error: string | null
  /** 仅旧版单节点批次文件丢失时使用的可信重建基线；多节点任务不得提供。 */
  singleBatchRecovery?: Omit<CreateCanvasImageCandidateBatchEntry, 'jobId'>
}

/** 候选批次权威状态完成写入后的有界变化事件。 */
export interface CanvasImageCandidateBatchChangedEvent extends CanvasTarget {
  batchId: string
  jobId: string
}

/** 候选批次变化监听器只接收稳定业务身份。 */
export type CanvasImageCandidateBatchChangedListener = (
  event: CanvasImageCandidateBatchChangedEvent,
) => void

/** 单条候选任务定向重试的完整身份。 */
export interface RetryCanvasImageCandidateJobInput extends CanvasImageTarget {
  batchId: string
  jobId: string
  /** 旧版单节点批次文件缺失时，从原 Job 固化事实恢复重试入口。 */
  singleBatchRecovery?: Omit<CreateCanvasImageCandidateBatchEntry, 'jobId'>
}

/** 已持有 Canvas 串行权时，把历史正式素材接入统一采用事务。 */
export interface AdoptExistingCanvasImageAssetInput extends CanvasImageTarget {
  jobId: string
  assetId: string
  currentAssetId: string | null
  currentConfigRevision: number
  batchId: string
}

/** 候选批次业务服务依赖。 */
export interface CanvasImageCandidateBatchServiceDependencies {
  store: CanvasImageCandidateBatchStore
  /** 正式采用时复用的纯依赖提示投影；候选创建和终态登记不得调用。 */
  dependencyState: CanvasDependencyStateService
  runExclusive: <T>(target: CanvasTarget, effect: () => Promise<T>) => Promise<T>
  loadConfig: (target: CanvasImageTarget) => Promise<CanvasImageModuleConfig>
  adoptAsset: (
    target: CanvasImageTarget,
    expectedConfigRevision: number,
    assetId: string,
  ) => Promise<CanvasImageModuleConfig>
  /** 读取采用事务使用的权威 Canvas 图基线。 */
  loadCanvas: (target: CanvasTarget) => CanvasDocument | Promise<CanvasDocument>
  /** 在精确 revision 上一次写入全部 adopted 与下游提示投影。 */
  applyCanvasProjection: (
    target: CanvasTarget,
    expectedRevision: number,
    nodes: readonly CanvasNode[],
  ) => Promise<CanvasDocument>
  /** 继续补齐时只启动目标失败项；调用方负责生成 replacement Job 身份。 */
  retryEntry: (
    batch: CanvasImageCandidateBatch,
    entry: CanvasImageCandidateBatchEntry,
  ) => Promise<{ jobId: string; start: () => void }>
  /** 定向重试前复核节点仍绑定目标图片模块，防止删除或换绑后的陈旧重试。 */
  assertRetryTarget?: (target: CanvasImageTarget) => Promise<void>
  /** 候选 Asset、Job 与血缘的额外权威验证。 */
  validateCandidate?: (batch: CanvasImageCandidateBatch, entry: CanvasImageCandidateBatchEntry) => Promise<void>
  now?: () => number
  randomUUID?: () => string
  /** 正式采用事务完成后的非阻塞通知，仅供原已授权工作流恢复。 */
  onAdopted?: (target: CanvasTarget) => void
}

/** 候选批次业务服务公开窄接口。 */
export interface CanvasImageCandidateBatchService {
  createBatch(input: CreateCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
  /** 调用方已持有同一 Canvas 串行权时创建，避免重复获取非重入锁。 */
  createBatchLocked(input: CreateCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
  listActiveSummaries(input: CanvasTarget): Promise<CanvasImageCandidateBatchSummary[]>
  recordJobTerminal(event: CanvasImageCandidateJobTerminalEvent): Promise<void>
  onChanged(listener: CanvasImageCandidateBatchChangedListener): () => void
  load(input: CanvasTarget & { batchId: string }): Promise<CanvasImageCandidateBatch>
  continueBatch(input: CanvasTarget & { batchId: string }): Promise<CanvasImageCandidateBatch>
  retryJob(input: RetryCanvasImageCandidateJobInput): Promise<string>
  /** 调用方已持有同一 Canvas 串行权时定向重试，避免重复获取非重入锁。 */
  retryJobLocked(input: RetryCanvasImageCandidateJobInput): Promise<string>
  /** 调用方已持有同一 Canvas 串行权时采用历史素材，避免重新获取非重入锁。 */
  adoptExistingAssetLocked(input: AdoptExistingCanvasImageAssetInput): Promise<CanvasImageCandidateBatch>
  adopt(input: AdoptCanvasImageCandidateBatchInput, expectedCandidateHash?: string, validateAccess?: () => void): Promise<CanvasImageCandidateBatch>
  abandon(input: CanvasTarget & { batchId: string }): Promise<CanvasImageCandidateBatch>
  /** 恢复目标 Canvas 中所有未完成整批采用 intent。 */
  reconcile(input: CanvasTarget): Promise<void>
}

/** 生成候选选择指纹；只绑定真实版本身份，采用状态变化不使同一请求失去幂等性。 */
export function createCanvasImageCandidateHash(batch: CanvasImageCandidateBatch): string {
  return createHash('sha256').update(JSON.stringify([
    'canvas-image-candidates', batch.projectId, batch.canvasId, batch.batchId,
    batch.entries.map((entry) => [entry.nodeId, entry.imageModuleId, entry.jobId,
      entry.candidateAssetId, entry.initialConfigRevision, entry.initialAdoptedAssetId]),
  ])).digest('hex')
}

/** 按条目事实派生活跃批次状态。 */
function deriveStatus(entries: readonly CanvasImageCandidateBatchEntry[]): CanvasImageCandidateBatch['status'] {
  if (entries.some((entry) => entry.status === 'queued' || entry.status === 'running')) return 'running'
  if (entries.every((entry) => entry.status === 'candidate')) return 'ready'
  return 'partial'
}

/** 图哈希复用 Store 规范化；原字段顺序只用于证明历史 intent。 */
function createGraphSha256(document: CanvasDocument, normalize = true): string {
  const canonical = normalize ? parseCanvasDocument(document, document).document : document
  return createHash('sha256').update(JSON.stringify({
    viewport: canonical.viewport,
    nodes: canonical.nodes,
    edges: canonical.edges,
  })).digest('hex')
}

/** 仅重建本批新增下游提示的旧字段位置，始终以完整图哈希证明提交。 */
function matchesGraphSha256(
  document: CanvasDocument,
  intent: CanvasImageCandidateAdoptionIntent,
  dependencyState: CanvasDependencyStateService,
): boolean {
  if (createGraphSha256(document) === intent.expectedGraphSha256
    || createGraphSha256(document, false) === intent.expectedGraphSha256) return true
  const downstreamIds = new Set(getInvalidatedDownstreamNodeIds(document, intent, dependencyState))
  const producerIds = new Set(intent.entries.map((entry) => entry.nodeId))
  const legacyNodes = document.nodes.map((node) => {
    if (!downstreamIds.has(node.id) || node.upstreamChange?.changedAt !== intent.createdAt
      || !node.upstreamChange.sourceNodeIds.every((id) => producerIds.has(id))) return node
    const { upstreamChange, ...withoutChange } = node
    return { ...withoutChange, upstreamChange }
  })
  return createGraphSha256({ ...document, nodes: legacyNodes }, false) === intent.expectedGraphSha256
}

/** 从图关系派生本批需要提示更新的直接下游节点。 */
function getInvalidatedDownstreamNodeIds(
  document: CanvasDocument,
  intent: CanvasImageCandidateAdoptionIntent,
  dependencyState: CanvasDependencyStateService,
): string[] {
  return dependencyState.consumeAndPropagate({
    document,
    producerNodeIds: intent.entries.map((entry) => entry.nodeId),
    changedAt: intent.createdAt,
  }).downstreamNodeIds
}

/** 从基线图构造整批采用后的单次节点投影。 */
function createAdoptionProjection(
  document: CanvasDocument,
  intent: CanvasImageCandidateAdoptionIntent,
  dependencyState: CanvasDependencyStateService,
): { nodes: CanvasNode[]; invalidatedDownstreamNodeIds: string[]; expectedDocument: CanvasDocument } {
  /** 按节点定位本批采用条目。 */
  const entryByNodeId = new Map(intent.entries.map((entry) => [entry.nodeId, entry]))
  /** 统一纯服务同时消费 producer 自身提示并聚合直接下游。 */
  const dependencyProjection = dependencyState.consumeAndPropagate({
    document,
    producerNodeIds: intent.entries.map((entry) => entry.nodeId),
    changedAt: intent.createdAt,
  })
  /** 在同一节点投影内叠加正式采用素材，保证只发生一次图 mutation。 */
  const nodes = dependencyProjection.nodes.map((node): CanvasNode => {
    const entry = entryByNodeId.get(node.id)
    if (!entry) return node
    if (node.kind !== 'image'
      || node.imageModuleId !== entry.imageModuleId
      || (node.adoptedAssetId ?? null) !== entry.oldAssetId) {
      throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
    }
    return { ...node, adoptedAssetId: entry.candidateAssetId }
  })
  if (nodes.filter((node) => entryByNodeId.has(node.id)).length !== intent.entries.length) {
    throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
  }
  /** 用 reducer 等价的 upsert 结果计算崩溃后可证明的最终图哈希。 */
  const projectedByNodeId = new Map(nodes.map((node) => [node.id, node]))
  const expectedDocument: CanvasDocument = {
    ...document,
    revision: document.revision + 1,
    nodes: document.nodes.map((node) => projectedByNodeId.get(node.id) ?? node),
    updatedAt: intent.createdAt,
  }
  return {
    nodes,
    invalidatedDownstreamNodeIds: dependencyProjection.downstreamNodeIds,
    expectedDocument,
  }
}

/** 创建图片候选批次业务服务。 */
export function createCanvasImageCandidateBatchService(
  dependencies: CanvasImageCandidateBatchServiceDependencies,
): CanvasImageCandidateBatchService {
  /** 仅保存进程内订阅者，事件载荷不携带候选素材或本地路径。 */
  const listeners = new Set<CanvasImageCandidateBatchChangedListener>()
  /** 时间源只允许非负安全整数。 */
  const now = (): number => {
    const value = (dependencies.now ?? Date.now)()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('CANVAS_IMAGE_BATCH_TIME_INVALID')
    return value
  }

  /** 写入批次初始事实；调用方负责确保同 Canvas 串行。 */
  const createBatchLocked = async (
    input: CreateCanvasImageCandidateBatchInput,
  ): Promise<CanvasImageCandidateBatch> => {
    try {
      const existing = await dependencies.store.load(input, input.batchId)
      const expectedEntries = [...input.entries].sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      const sameIdentity = existing.source === input.source
        && existing.sourceSessionId === input.sourceSessionId
        && existing.sourceToolCallId === input.sourceToolCallId
        && existing.entries.length === expectedEntries.length
        && existing.entries.every((entry, index) => {
          const expected = expectedEntries[index]
          return expected
            && entry.nodeId === expected.nodeId
            && entry.imageModuleId === expected.imageModuleId
            && entry.initialAdoptedAssetId === expected.initialAdoptedAssetId
            && entry.initialConfigRevision === expected.initialConfigRevision
            && entry.jobId === expected.jobId
        })
      if (!sameIdentity) throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
      return existing
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'CANVAS_IMAGE_BATCH_NOT_FOUND') throw error
    }
    const timestamp = now()
    const batch: CanvasImageCandidateBatch = {
      schemaVersion: 1,
      batchId: input.batchId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      source: input.source,
      sourceSessionId: input.sourceSessionId,
      sourceToolCallId: input.sourceToolCallId,
      status: 'running',
      entries: input.entries.map((entry) => ({
        ...entry, candidateAssetId: null, status: 'queued', error: null,
      })),
      adoption: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    return dependencies.store.save(batch)
  }

  /** 判断权威批次已经精确提交当前 intent 的采用结果。 */
  const isBatchCommitted = (
    batch: CanvasImageCandidateBatch,
    intent: CanvasImageCandidateAdoptionIntent,
    invalidatedDownstreamNodeIds: readonly string[],
  ): boolean => {
    if (batch.status !== 'adopted' || batch.adoption?.mode !== intent.mode) return false
    /** intent 中正式采用的节点集合。 */
    const adoptedNodeIds = intent.entries.map((entry) => entry.nodeId).sort()
    /** 未采用条目必须明确保留原正式版本。 */
    const keptNodeIds = batch.entries
      .filter((entry) => !adoptedNodeIds.includes(entry.nodeId))
      .map((entry) => entry.nodeId)
      .sort()
    return JSON.stringify([...batch.adoption.adoptedNodeIds].sort()) === JSON.stringify(adoptedNodeIds)
      && JSON.stringify([...batch.adoption.keptNodeIds].sort()) === JSON.stringify(keptNodeIds)
      && JSON.stringify([...batch.adoption.invalidatedDownstreamNodeIds].sort())
        === JSON.stringify([...invalidatedDownstreamNodeIds].sort())
      && batch.entries.every((entry) => (
        adoptedNodeIds.includes(entry.nodeId) ? entry.status === 'adopted' : entry.status === 'kept'
      ))
  }

  /** 把单个持久化 intent 幂等推进到模块、图和批次全部提交。 */
  const reconcileIntentLocked = async (
    original: CanvasImageCandidateAdoptionIntent,
  ): Promise<CanvasImageCandidateBatch> => {
    let intent = original
    /** 模块配置逐项提交，并在每项后固化精确新 revision。 */
    for (let index = 0; index < intent.entries.length; index += 1) {
      let entry = intent.entries[index]!
      const imageTarget: CanvasImageTarget = {
        projectId: intent.projectId,
        canvasId: intent.canvasId,
        nodeId: entry.nodeId,
        imageModuleId: entry.imageModuleId,
      }
      let config = await dependencies.loadConfig(imageTarget)
      if (entry.committedConfigRevision === null) {
        if (config.revision === entry.expectedConfigRevision
          && config.adoptedAssetId === entry.oldAssetId) {
          try {
            config = await dependencies.adoptAsset(
              imageTarget,
              entry.expectedConfigRevision,
              entry.candidateAssetId,
            )
          } catch (error) {
            /** 写调用抛错后必须重读权威配置，只有精确新事实可证明已提交。 */
            const reloaded = await dependencies.loadConfig(imageTarget)
            if (reloaded.revision !== entry.expectedConfigRevision + 1
              || reloaded.adoptedAssetId !== entry.candidateAssetId) {
              throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED', { cause: error })
            }
            config = reloaded
          }
        } else if (config.revision !== entry.expectedConfigRevision + 1
          || config.adoptedAssetId !== entry.candidateAssetId) {
          throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
        }
        if (config.revision !== entry.expectedConfigRevision + 1
          || config.adoptedAssetId !== entry.candidateAssetId) {
          throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
        }
        entry = { ...entry, committedConfigRevision: config.revision }
        /** 每次只推进当前条目，重启不会重复增加已完成模块 revision。 */
        const entries = intent.entries.map((candidate, candidateIndex) => (
          candidateIndex === index ? entry : candidate
        ))
        intent = await dependencies.store.saveAdoptionIntent({
          ...intent,
          entries,
          state: 'modules-committing',
          updatedAt: now(),
        })
      } else if (config.revision !== entry.committedConfigRevision
        || config.adoptedAssetId !== entry.candidateAssetId) {
        throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
      }
    }

    /** 图提交只允许从原基线推进一次，或由 revision+哈希精确证明已完成。 */
    let document = await dependencies.loadCanvas(intent)
    if (document.revision === intent.baseCanvasRevision) {
      const projection = createAdoptionProjection(document, intent, dependencies.dependencyState)
      try {
        document = await dependencies.applyCanvasProjection(
          intent,
          intent.baseCanvasRevision,
          projection.nodes,
        )
      } catch (error) {
        const reloaded = await dependencies.loadCanvas(intent)
        if (reloaded.revision !== intent.baseCanvasRevision + 1
          || !matchesGraphSha256(reloaded, intent, dependencies.dependencyState)) {
          throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED', { cause: error })
        }
        document = reloaded
      }
    }
    if (document.revision !== intent.baseCanvasRevision + 1
      || !matchesGraphSha256(document, intent, dependencies.dependencyState)) {
      throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
    }
    if (intent.state === 'prepared' || intent.state === 'modules-committing') {
      intent = await dependencies.store.saveAdoptionIntent({
        ...intent,
        state: 'graph-committed',
        updatedAt: now(),
      })
    }

    /** 批次终态只保存采用/保留集合和下游提示，不触发任何新任务。 */
    const invalidatedDownstreamNodeIds = getInvalidatedDownstreamNodeIds(
      document,
      intent,
      dependencies.dependencyState,
    )
    let batch = await dependencies.store.load(intent, intent.batchId)
    if (!isBatchCommitted(batch, intent, invalidatedDownstreamNodeIds)) {
      if (batch.status === 'adopted' || batch.status === 'abandoned') {
        throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
      }
      /** 本 intent 正式采用的稳定节点集合。 */
      const adoptedNodeIds = intent.entries.map((entry) => entry.nodeId).sort()
      /** 部分采用时其余条目明确保持旧正式版本。 */
      const keptNodeIds = batch.entries
        .filter((entry) => !adoptedNodeIds.includes(entry.nodeId))
        .map((entry) => entry.nodeId)
        .sort()
      /** 要提交的批次终态在重扫证明时复用同一对象合同。 */
      const committedBatch: CanvasImageCandidateBatch = {
        ...batch,
        status: 'adopted',
        entries: batch.entries.map((entry) => ({
          ...entry,
          status: adoptedNodeIds.includes(entry.nodeId) ? 'adopted' : 'kept',
        })),
        adoption: {
          mode: intent.mode,
          adoptedNodeIds,
          keptNodeIds,
          invalidatedDownstreamNodeIds,
          committedAt: intent.createdAt,
        },
        updatedAt: now(),
      }
      try {
        batch = await dependencies.store.save(committedBatch)
      } catch (error) {
        const reloaded = await dependencies.store.load(intent, intent.batchId)
        if (!isBatchCommitted(reloaded, intent, invalidatedDownstreamNodeIds)) {
          throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED', { cause: error })
        }
        batch = reloaded
      }
    }
    if (intent.state !== 'batch-committed') {
      await dependencies.store.saveAdoptionIntent({
        ...intent,
        state: 'batch-committed',
        updatedAt: now(),
      })
    }
    try { dependencies.onAdopted?.({ projectId: batch.projectId, canvasId: batch.canvasId }) }
    catch { reportCanvasImageDiagnostic('CANVAS_IMAGE_BATCH_LISTENER_FAILED') }
    return batch
  }

  /** 在同一 Canvas 串行边界内恢复全部未完成采用事务。 */
  const reconcileLocked = async (target: CanvasTarget): Promise<void> => {
    const intents = (await dependencies.store.scanAdoptionIntents(target))
      .sort((left, right) => left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId))
    for (const intent of intents) {
      if (intent.state === 'batch-committed') continue
      await reconcileIntentLocked(intent)
    }
  }

  /** 校验既有单节点批次与 Job 固化的恢复基线完全一致。 */
  const assertRecoverableSingleBatch = (
    batch: CanvasImageCandidateBatch,
    recovery: Omit<CreateCanvasImageCandidateBatchEntry, 'jobId'>,
  ): CanvasImageCandidateBatchEntry => {
    const entry = batch.entries[0]
    if (batch.source !== 'single'
      || batch.entries.length !== 1
      || batch.adoption !== null
      || batch.status === 'adopted'
      || batch.status === 'abandoned'
      || !entry
      || entry.nodeId !== recovery.nodeId
      || entry.imageModuleId !== recovery.imageModuleId
      || entry.initialAdoptedAssetId !== recovery.initialAdoptedAssetId
      || entry.initialConfigRevision !== recovery.initialConfigRevision) {
      throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
    }
    return entry
  }

  /** 读取历史单节点批次；文件缺失时从可信 Job 基线创建失败条目供重试。 */
  const loadOrCreateRetryBatch = async (
    input: RetryCanvasImageCandidateJobInput,
  ): Promise<CanvasImageCandidateBatch> => {
    try {
      return await dependencies.store.load(input, input.batchId)
    } catch (error) {
      if (!(error instanceof Error)
        || error.message !== 'CANVAS_IMAGE_BATCH_NOT_FOUND'
        || !input.singleBatchRecovery) throw error
    }
    const created = await createBatchLocked({
      ...input,
      source: 'single',
      sourceSessionId: null,
      sourceToolCallId: null,
      entries: [{ ...input.singleBatchRecovery, jobId: input.jobId }],
    })
    /** 原 Job 已由 Manager 证明可重试，恢复后的条目明确进入失败态。 */
    return dependencies.store.save({
      ...created,
      status: 'partial',
      entries: created.entries.map((entry) => ({
        ...entry, status: 'failed', error: '历史任务待重试',
      })),
      updatedAt: now(),
    })
  }

  /** 只替换精确条目的 Job 身份，并保证新任务在批次写入后启动。 */
  const retryJobLocked = async (input: RetryCanvasImageCandidateJobInput): Promise<string> => {
    await dependencies.assertRetryTarget?.(input)
    const batch = await loadOrCreateRetryBatch(input)
    if (batch.status === 'adopted' || batch.status === 'abandoned') {
      throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
    }
    const entry = batch.entries.find((candidate) => candidate.jobId === input.jobId)
    if (!entry
      || entry.nodeId !== input.nodeId
      || entry.imageModuleId !== input.imageModuleId
      || (entry.status !== 'failed' && entry.status !== 'invalid')) {
      throw new Error('CANVAS_IMAGE_BATCH_JOB_NOT_FOUND')
    }
    const replacement = await dependencies.retryEntry(batch, entry)
    /** replacement 身份必须先成为权威批次事实，快速终态才可反向定位。 */
    await dependencies.store.save({
      ...batch,
      entries: batch.entries.map((candidate) => candidate.jobId === input.jobId
        ? {
            ...candidate,
            jobId: replacement.jobId,
            candidateAssetId: null,
            status: 'queued',
            error: null,
          }
        : candidate),
      status: 'running',
      updatedAt: now(),
    })
    replacement.start()
    return replacement.jobId
  }

  /** 在已持锁边界内采用一个已验证候选批次。 */
  const adoptBatchLocked = async (
    input: AdoptCanvasImageCandidateBatchInput,
    expectedCandidateHash?: string,
    validateAccess?: () => void,
  ): Promise<CanvasImageCandidateBatch> => {
    validateAccess?.()
    await reconcileLocked(input)
    const batch = await dependencies.store.load(input, input.batchId)
    validateAccess?.()
    if (expectedCandidateHash !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(expectedCandidateHash)
        || createCanvasImageCandidateHash(batch) !== expectedCandidateHash) {
        throw new Error('CANVAS_IMAGE_CANDIDATES_CHANGED')
      }
      if (batch.status === 'adopted' && batch.adoption?.mode === input.mode) return batch
    }
    if (batch.status === 'adopted' || batch.status === 'abandoned') {
      throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
    }
    const candidates = batch.entries.filter((entry) => entry.status === 'candidate' && entry.candidateAssetId)
    if (candidates.length === 0 || (input.mode === 'all' && candidates.length !== batch.entries.length)) {
      throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
    }
    /** 全量预检必须先于 prepared intent，保证普通基线冲突是零副作用。 */
    for (const entry of candidates) {
      const config = await dependencies.loadConfig({
        ...input,
        nodeId: entry.nodeId,
        imageModuleId: entry.imageModuleId,
      })
      if (config.revision !== entry.initialConfigRevision
        || config.adoptedAssetId !== entry.initialAdoptedAssetId) {
        throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
      }
      await dependencies.validateCandidate?.(batch, entry)
      validateAccess?.()
    }
    /** 图基线与目标节点身份同样在任何模块写入前固化。 */
    const document = await dependencies.loadCanvas(input)
    const timestamp = now()
    const operationId = (dependencies.randomUUID ?? randomUUID)()
    /** 先构造不含真实哈希的草稿，以复用唯一投影算法。 */
    const draftIntent: CanvasImageCandidateAdoptionIntent = {
      schemaVersion: 1,
      operationId,
      batchId: input.batchId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      mode: input.mode,
      baseCanvasRevision: document.revision,
      entries: candidates.map((entry) => ({
        nodeId: entry.nodeId,
        imageModuleId: entry.imageModuleId,
        oldAssetId: entry.initialAdoptedAssetId,
        candidateAssetId: entry.candidateAssetId!,
        expectedConfigRevision: entry.initialConfigRevision,
        committedConfigRevision: null,
      })),
      expectedGraphSha256: '0'.repeat(64),
      state: 'prepared',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    /** 最终哈希在 intent 首次可见前完成，恢复无需重新猜测目标图。 */
    const projection = createAdoptionProjection(document, draftIntent, dependencies.dependencyState)
    /** 锁等待或异步预检期间撤权时，不创建新的采用事务。 */
    validateAccess?.()
    const intent = await dependencies.store.saveAdoptionIntent({
      ...draftIntent,
      expectedGraphSha256: createGraphSha256(projection.expectedDocument),
    })
    return reconcileIntentLocked(intent)
  }

  /** 把历史素材登记为单条候选，再沿与新生成结果相同的采用事务提交。 */
  const adoptExistingAssetLocked = async (
    input: AdoptExistingCanvasImageAssetInput,
  ): Promise<CanvasImageCandidateBatch> => {
    await reconcileLocked(input)
    const config = await dependencies.loadConfig(input)
    if (config.revision !== input.currentConfigRevision
      || (config.adoptedAssetId ?? null) !== input.currentAssetId) {
      throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
    }
    const created = await createBatchLocked({
      projectId: input.projectId,
      canvasId: input.canvasId,
      batchId: input.batchId,
      source: 'single',
      sourceSessionId: null,
      sourceToolCallId: null,
      entries: [{
        nodeId: input.nodeId,
        imageModuleId: input.imageModuleId,
        initialAdoptedAssetId: input.currentAssetId,
        initialConfigRevision: input.currentConfigRevision,
        jobId: input.jobId,
      }],
    })
    const entry = created.entries[0]
    if (!entry || entry.status !== 'queued' || entry.candidateAssetId !== null) {
      throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
    }
    await dependencies.store.save({
      ...created,
      status: 'ready',
      entries: [{ ...entry, candidateAssetId: input.assetId, status: 'candidate', error: null }],
      updatedAt: now(),
    })
    return adoptBatchLocked({
      projectId: input.projectId,
      canvasId: input.canvasId,
      batchId: input.batchId,
      mode: 'all',
    })
  }

  return {
    createBatch: async (input) => dependencies.runExclusive(input, () => createBatchLocked(input)),
    createBatchLocked,
    listActiveSummaries: async (input) => dependencies.store.listActiveSummaries(input),
    recordJobTerminal: async (event) => {
      /** 先完成权威批次写入并释放同 Canvas 串行锁，再通知等待方重读。 */
      const changed = await dependencies.runExclusive(event, async (): Promise<CanvasImageCandidateBatchChangedEvent> => {
        let batch = await dependencies.store.findByJobId(event, event.jobId, event.candidateBatchId)
        if (!batch
          && event.status === 'succeeded'
          && event.candidateBatchId
          && event.singleBatchRecovery) {
          /** 成功 replacement 可修复仍指向旧 attempt 的单节点批次；失败旧任务无恢复资格。 */
          try {
            const existing = await dependencies.store.load(event, event.candidateBatchId)
            const entry = assertRecoverableSingleBatch(existing, event.singleBatchRecovery)
            batch = await dependencies.store.save({
              ...existing,
              status: 'running',
              entries: [{
                ...entry, jobId: event.jobId, candidateAssetId: null, status: 'queued', error: null,
              }],
              updatedAt: now(),
            })
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'CANVAS_IMAGE_BATCH_NOT_FOUND') throw error
            batch = await createBatchLocked({
              ...event,
              batchId: event.candidateBatchId,
              source: 'single',
              sourceSessionId: null,
              sourceToolCallId: null,
              entries: [{ ...event.singleBatchRecovery, jobId: event.jobId }],
            })
          }
        }
        if (!batch) throw new Error('CANVAS_IMAGE_BATCH_JOB_NOT_FOUND')
        const entries = batch.entries.map((entry): CanvasImageCandidateBatchEntry => {
          if (entry.jobId !== event.jobId) return entry
          if (event.status === 'succeeded') {
            if (!event.outputAssetId) throw new Error('CANVAS_IMAGE_BATCH_OUTPUT_INVALID')
            return { ...entry, candidateAssetId: event.outputAssetId, status: 'candidate', error: null }
          }
          return {
            ...entry, candidateAssetId: null, status: 'failed',
            error: (event.error ?? `任务${event.status}`).slice(0, 1000),
          }
        })
        /** abandoned 只追加历史候选事实，不恢复为待验收状态。 */
        const saved = await dependencies.store.save({
          ...batch,
          entries,
          status: batch.status === 'abandoned' ? 'abandoned' : deriveStatus(entries),
          updatedAt: now(),
        })
        return {
          projectId: saved.projectId,
          canvasId: saved.canvasId,
          batchId: saved.batchId,
          jobId: event.jobId,
        }
      })
      for (const listener of listeners) {
        try {
          listener(changed)
        } catch {
          /** 单个观察者失败不得中断后续通知，也不得把已提交终态误报为登记失败。 */
          reportCanvasImageDiagnostic('CANVAS_IMAGE_BATCH_LISTENER_FAILED')
        }
      }
    },
    onChanged: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    load: async (rawInput) => {
      const input = parseGetCanvasImageCandidateBatchInput(rawInput)
      return dependencies.store.load(input, input.batchId)
    },
    retryJob: async (input) => dependencies.runExclusive(input, () => retryJobLocked(input)),
    retryJobLocked,
    adoptExistingAssetLocked,
    continueBatch: async (rawInput) => {
      const input = parseGetCanvasImageCandidateBatchInput(rawInput)
      return dependencies.runExclusive(input, async () => {
        const batch = await dependencies.store.load(input, input.batchId)
        if (batch.status === 'adopted' || batch.status === 'abandoned') {
          throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
        }
        const retryable = batch.entries.filter((entry) => entry.status === 'failed' || entry.status === 'invalid')
        /** replacement Job ID 必须写回条目，否则新终态无法按 jobId 定位原批次。 */
        const replacements = new Map<string, { jobId: string; start: () => void }>()
        for (const entry of retryable) {
          replacements.set(entry.nodeId, await dependencies.retryEntry(batch, entry))
        }
        const saved = await dependencies.store.save({
          ...batch,
          entries: batch.entries.map((entry) => replacements.has(entry.nodeId)
            ? {
                ...entry,
                jobId: replacements.get(entry.nodeId)!.jobId,
                candidateAssetId: null,
                status: 'queued',
                error: null,
              }
            : entry),
          status: retryable.length > 0 ? 'running' : batch.status,
          updatedAt: now(),
        })
        /** 批次先持久化 replacement 身份，再启动任务，避免快速终态无法定位。 */
        for (const replacement of replacements.values()) replacement.start()
        return saved
      })
    },
    adopt: async (rawInput, expectedCandidateHash, validateAccess) => {
      const input = parseAdoptCanvasImageCandidateBatchInput(rawInput)
      return dependencies.runExclusive(input, () => adoptBatchLocked(input, expectedCandidateHash, validateAccess))
    },
    abandon: async (rawInput) => {
      const input = parseGetCanvasImageCandidateBatchInput(rawInput)
      return dependencies.runExclusive(input, async () => {
        const batch = await dependencies.store.load(input, input.batchId)
        if (batch.status === 'adopted') throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
        if (batch.status === 'abandoned') return batch
        return dependencies.store.save({ ...batch, status: 'abandoned', updatedAt: now() })
      })
    },
    reconcile: async (input) => dependencies.runExclusive(input, () => reconcileLocked(input)),
  }
}
