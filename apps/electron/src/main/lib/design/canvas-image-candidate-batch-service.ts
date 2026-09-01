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
}

/** 候选批次业务服务依赖。 */
export interface CanvasImageCandidateBatchServiceDependencies {
  store: CanvasImageCandidateBatchStore
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
  /** 候选 Asset、Job 与血缘的额外权威验证。 */
  validateCandidate?: (batch: CanvasImageCandidateBatch, entry: CanvasImageCandidateBatchEntry) => Promise<void>
  now?: () => number
  randomUUID?: () => string
}

/** 候选批次业务服务公开窄接口。 */
export interface CanvasImageCandidateBatchService {
  createBatch(input: CreateCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
  /** 调用方已持有同一 Canvas 串行权时创建，避免重复获取非重入锁。 */
  createBatchLocked(input: CreateCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
  listActiveSummaries(input: CanvasTarget): Promise<CanvasImageCandidateBatchSummary[]>
  recordJobTerminal(event: CanvasImageCandidateJobTerminalEvent): Promise<void>
  load(input: CanvasTarget & { batchId: string }): Promise<CanvasImageCandidateBatch>
  continueBatch(input: CanvasTarget & { batchId: string }): Promise<CanvasImageCandidateBatch>
  adopt(input: AdoptCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
  abandon(input: CanvasTarget & { batchId: string }): Promise<CanvasImageCandidateBatch>
  /** 恢复目标 Canvas 中所有未完成整批采用 intent。 */
  reconcile(input: CanvasTarget): Promise<void>
}

/** 按条目事实派生活跃批次状态。 */
function deriveStatus(entries: readonly CanvasImageCandidateBatchEntry[]): CanvasImageCandidateBatch['status'] {
  if (entries.some((entry) => entry.status === 'queued' || entry.status === 'running')) return 'running'
  if (entries.every((entry) => entry.status === 'candidate')) return 'ready'
  return 'partial'
}

/** 计算不含 revision 与时间字段的精确 Canvas 图事实。 */
function createGraphSha256(document: CanvasDocument): string {
  return createHash('sha256').update(JSON.stringify({
    viewport: document.viewport,
    nodes: document.nodes,
    edges: document.edges,
  })).digest('hex')
}

/** 允许传播“上游已变化”提示的数据关系。 */
const UPSTREAM_CHANGE_RELATIONS = new Set(['reference', 'depends-on', 'derives'])

/** 从图关系派生本批需要提示更新的直接下游节点。 */
function getInvalidatedDownstreamNodeIds(
  document: CanvasDocument,
  intent: CanvasImageCandidateAdoptionIntent,
): string[] {
  /** 本批正式采用的源节点集合。 */
  const sourceNodeIds = new Set(intent.entries.map((entry) => entry.nodeId))
  return [...new Set(document.edges
    .filter((edge) => sourceNodeIds.has(edge.sourceNodeId) && UPSTREAM_CHANGE_RELATIONS.has(edge.relation))
    .map((edge) => edge.targetNodeId))].sort()
}

/** 从基线图构造整批采用后的单次节点投影。 */
function createAdoptionProjection(
  document: CanvasDocument,
  intent: CanvasImageCandidateAdoptionIntent,
): { nodes: CanvasNode[]; invalidatedDownstreamNodeIds: string[]; expectedDocument: CanvasDocument } {
  /** 按节点定位本批采用条目。 */
  const entryByNodeId = new Map(intent.entries.map((entry) => [entry.nodeId, entry]))
  /** 每个下游节点聚合本次变化的直接上游。 */
  const changedSourcesByNodeId = new Map<string, Set<string>>()
  for (const edge of document.edges) {
    if (!entryByNodeId.has(edge.sourceNodeId) || !UPSTREAM_CHANGE_RELATIONS.has(edge.relation)) continue
    /** 同一下游可同时受本批多个图片节点影响。 */
    const sources = changedSourcesByNodeId.get(edge.targetNodeId) ?? new Set<string>()
    sources.add(edge.sourceNodeId)
    changedSourcesByNodeId.set(edge.targetNodeId, sources)
  }
  /** 只提交发生变化的图片节点和直接数据下游。 */
  const nodes: CanvasNode[] = []
  /** 权威图中的节点 ID 用于拒绝悬空关系。 */
  const existingNodeIds = new Set(document.nodes.map((node) => node.id))
  for (const node of document.nodes) {
    const entry = entryByNodeId.get(node.id)
    const changedSources = changedSourcesByNodeId.get(node.id)
    if (entry) {
      if (node.kind !== 'image'
        || node.imageModuleId !== entry.imageModuleId
        || (node.adoptedAssetId ?? null) !== entry.oldAssetId) {
        throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
      }
      nodes.push({ ...node, adoptedAssetId: entry.candidateAssetId })
      continue
    }
    if (!changedSources) continue
    /** 保留旧提示并合并本次来源，避免覆盖尚未处理的上游变化。 */
    const sourceNodeIds = [...new Set([
      ...(node.upstreamChange?.sourceNodeIds ?? []),
      ...changedSources,
    ])].sort()
    nodes.push({ ...node, upstreamChange: { sourceNodeIds, changedAt: intent.createdAt } })
  }
  if (nodes.filter((node) => entryByNodeId.has(node.id)).length !== intent.entries.length
    || [...changedSourcesByNodeId.keys()].some((nodeId) => !existingNodeIds.has(nodeId))) {
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
    invalidatedDownstreamNodeIds: [...changedSourcesByNodeId.keys()].sort(),
    expectedDocument,
  }
}

/** 创建图片候选批次业务服务。 */
export function createCanvasImageCandidateBatchService(
  dependencies: CanvasImageCandidateBatchServiceDependencies,
): CanvasImageCandidateBatchService {
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
      const projection = createAdoptionProjection(document, intent)
      try {
        document = await dependencies.applyCanvasProjection(
          intent,
          intent.baseCanvasRevision,
          projection.nodes,
        )
      } catch (error) {
        const reloaded = await dependencies.loadCanvas(intent)
        if (reloaded.revision !== intent.baseCanvasRevision + 1
          || createGraphSha256(reloaded) !== intent.expectedGraphSha256) {
          throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED', { cause: error })
        }
        document = reloaded
      }
    }
    if (document.revision !== intent.baseCanvasRevision + 1
      || createGraphSha256(document) !== intent.expectedGraphSha256) {
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
    const invalidatedDownstreamNodeIds = getInvalidatedDownstreamNodeIds(document, intent)
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

  return {
    createBatch: async (input) => dependencies.runExclusive(input, () => createBatchLocked(input)),
    createBatchLocked,
    listActiveSummaries: async (input) => dependencies.store.listActiveSummaries(input),
    recordJobTerminal: async (event) => dependencies.runExclusive(event, async () => {
      const batch = await dependencies.store.findByJobId(event, event.jobId, event.candidateBatchId)
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
      await dependencies.store.save({
        ...batch,
        entries,
        status: batch.status === 'abandoned' ? 'abandoned' : deriveStatus(entries),
        updatedAt: now(),
      })
    }),
    load: async (rawInput) => {
      const input = parseGetCanvasImageCandidateBatchInput(rawInput)
      return dependencies.store.load(input, input.batchId)
    },
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
    adopt: async (rawInput) => {
      const input = parseAdoptCanvasImageCandidateBatchInput(rawInput)
      return dependencies.runExclusive(input, async () => {
        await reconcileLocked(input)
        const batch = await dependencies.store.load(input, input.batchId)
        if (batch.status === 'adopted' || batch.status === 'abandoned') {
          throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
        }
        const candidates = batch.entries.filter((entry) => entry.status === 'candidate' && entry.candidateAssetId)
        if (candidates.length === 0 || (input.mode === 'all' && candidates.length !== batch.entries.length)) {
          throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
        }
        /** 全量预检必须先于 prepared intent，保证普通基线冲突是零副作用。 */
        for (const entry of candidates) {
          const config = await dependencies.loadConfig({ ...input, nodeId: entry.nodeId, imageModuleId: entry.imageModuleId })
          if (config.revision !== entry.initialConfigRevision
            || config.adoptedAssetId !== entry.initialAdoptedAssetId) {
            throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
          }
          await dependencies.validateCandidate?.(batch, entry)
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
        const projection = createAdoptionProjection(document, draftIntent)
        const intent = await dependencies.store.saveAdoptionIntent({
          ...draftIntent,
          expectedGraphSha256: createGraphSha256(projection.expectedDocument),
        })
        return reconcileIntentLocked(intent)
      })
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
