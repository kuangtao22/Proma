import {
  CANVAS_IMAGE_CANDIDATE_BATCH_SUMMARY_LIMIT,
  parseCanvasImageCandidateBatch,
} from '@proma/shared'
import type {
  CanvasImageCandidateBatch,
  CanvasImageCandidateBatchSummary,
  CanvasTarget,
} from '@proma/shared'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import type { StableDirectoryNativeWriteOutcome } from '../stable-directory-native-host'
import type { CanvasDocumentStore } from './canvas-document-store'

/** 候选批次文件数量上限，阻止项目历史无界放大单次扫描。 */
const MAX_CANDIDATE_BATCH_FILES = 512
/** 候选批次固定文件名前缀与安全身份捕获。 */
const CANDIDATE_BATCH_FILE = /^image-candidate-batch-([A-Za-z0-9_-]{1,128})\.json$/
/** 整批采用恢复 intent 的固定文件名合同。 */
const ADOPTION_INTENT_FILE = /^image-candidate-adoption-([A-Za-z0-9_-]{1,128})\.json$/
/** Canvas 与模块持久化身份的有界安全格式。 */
const ADOPTION_ID = /^[A-Za-z0-9_-]{1,128}$/

/** 整批采用跨模块、图和批次的恢复阶段。 */
export type CanvasImageCandidateAdoptionState =
  | 'prepared'
  | 'modules-committing'
  | 'graph-committed'
  | 'batch-committed'

/** 单个图片模块在采用事务中的基线与提交证据。 */
export interface CanvasImageCandidateAdoptionEntry {
  nodeId: string
  imageModuleId: string
  oldAssetId: string | null
  candidateAssetId: string
  expectedConfigRevision: number
  committedConfigRevision: number | null
}

/** 位于目标 Canvas transactions 目录的可恢复整批采用 intent。 */
export interface CanvasImageCandidateAdoptionIntent extends CanvasTarget {
  schemaVersion: 1
  operationId: string
  batchId: string
  mode: 'all' | 'succeeded'
  baseCanvasRevision: number
  entries: CanvasImageCandidateAdoptionEntry[]
  expectedGraphSha256: string
  state: CanvasImageCandidateAdoptionState
  createdAt: number
  updatedAt: number
}

/** 候选批次持久化 Store 的公开窄接口。 */
export interface CanvasImageCandidateBatchStore {
  listActiveSummaries(target: CanvasTarget): Promise<CanvasImageCandidateBatchSummary[]>
  load(target: CanvasTarget, batchId: string): Promise<CanvasImageCandidateBatch>
  save(batch: CanvasImageCandidateBatch): Promise<CanvasImageCandidateBatch>
  findByJobId(
    target: CanvasTarget,
    jobId: string,
    candidateBatchId?: string,
  ): Promise<CanvasImageCandidateBatch | null>
  scanAdoptionIntents(target: CanvasTarget): Promise<CanvasImageCandidateAdoptionIntent[]>
  loadAdoptionIntent(target: CanvasTarget, operationId: string): Promise<CanvasImageCandidateAdoptionIntent>
  saveAdoptionIntent(intent: CanvasImageCandidateAdoptionIntent): Promise<CanvasImageCandidateAdoptionIntent>
}

/** Store 测试注入点与生产目录能力。 */
export interface CanvasImageCandidateBatchStoreDependencies {
  documents?: Pick<CanvasDocumentStore, 'loadWithDirectoryCapability'>
  scanBatches?: (target: CanvasTarget) => Promise<CanvasImageCandidateBatch[]>
  writeBatch?: (batch: CanvasImageCandidateBatch) => Promise<StableDirectoryNativeWriteOutcome>
  scanAdoptionIntents?: (target: CanvasTarget) => Promise<CanvasImageCandidateAdoptionIntent[]>
  writeAdoptionIntent?: (intent: CanvasImageCandidateAdoptionIntent) => Promise<StableDirectoryNativeWriteOutcome>
}

/** 判断未知值是否为无自定义原型的普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 判断记录只包含给定完整字段集合。 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** 判断值是非负安全整数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** 判断值是可选安全持久化身份。 */
function isNullableId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && ADOPTION_ID.test(value))
}

/** 严格解析磁盘采用 intent，未知字段或身份漂移一律拒绝恢复。 */
export function parseCanvasImageCandidateAdoptionIntent(
  value: unknown,
  target: CanvasTarget,
  operationId: string,
): CanvasImageCandidateAdoptionIntent {
  /** intent 顶层允许的完整字段集合。 */
  const keys = [
    'schemaVersion', 'operationId', 'batchId', 'projectId', 'canvasId', 'mode',
    'baseCanvasRevision', 'entries', 'expectedGraphSha256', 'state', 'createdAt', 'updatedAt',
  ] as const
  /** 支持的有限状态集合。 */
  const states: CanvasImageCandidateAdoptionState[] = [
    'prepared', 'modules-committing', 'graph-committed', 'batch-committed',
  ]
  if (!isRecord(value)
    || !hasExactKeys(value, keys)
    || value.schemaVersion !== 1
    || value.operationId !== operationId
    || typeof value.operationId !== 'string' || !ADOPTION_ID.test(value.operationId)
    || typeof value.batchId !== 'string' || !ADOPTION_ID.test(value.batchId)
    || value.projectId !== target.projectId || value.canvasId !== target.canvasId
    || (value.mode !== 'all' && value.mode !== 'succeeded')
    || !isNonNegativeInteger(value.baseCanvasRevision)
    || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 128
    || typeof value.expectedGraphSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedGraphSha256)
    || !states.includes(value.state as CanvasImageCandidateAdoptionState)
    || !isNonNegativeInteger(value.createdAt) || !isNonNegativeInteger(value.updatedAt)
    || value.updatedAt < value.createdAt) {
    throw new Error('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
  }
  /** 重复模块或节点会破坏逐项恢复的唯一身份。 */
  const nodeIds = new Set<string>()
  /** 图片模块同样必须在单个 intent 内唯一。 */
  const moduleIds = new Set<string>()
  /** 深度重建后的受信任条目。 */
  const entries: CanvasImageCandidateAdoptionEntry[] = value.entries.map((rawEntry) => {
    const entryKeys = [
      'nodeId', 'imageModuleId', 'oldAssetId', 'candidateAssetId',
      'expectedConfigRevision', 'committedConfigRevision',
    ] as const
    if (!isRecord(rawEntry)
      || !hasExactKeys(rawEntry, entryKeys)
      || typeof rawEntry.nodeId !== 'string' || !ADOPTION_ID.test(rawEntry.nodeId)
      || typeof rawEntry.imageModuleId !== 'string' || !ADOPTION_ID.test(rawEntry.imageModuleId)
      || !isNullableId(rawEntry.oldAssetId)
      || typeof rawEntry.candidateAssetId !== 'string' || !ADOPTION_ID.test(rawEntry.candidateAssetId)
      || !isNonNegativeInteger(rawEntry.expectedConfigRevision)
      || (rawEntry.committedConfigRevision !== null
        && (!isNonNegativeInteger(rawEntry.committedConfigRevision)
          || rawEntry.committedConfigRevision !== rawEntry.expectedConfigRevision + 1))
      || nodeIds.has(rawEntry.nodeId)
      || moduleIds.has(rawEntry.imageModuleId)) {
      throw new Error('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
    }
    nodeIds.add(rawEntry.nodeId)
    moduleIds.add(rawEntry.imageModuleId)
    return {
      nodeId: rawEntry.nodeId,
      imageModuleId: rawEntry.imageModuleId,
      oldAssetId: rawEntry.oldAssetId,
      candidateAssetId: rawEntry.candidateAssetId,
      expectedConfigRevision: rawEntry.expectedConfigRevision,
      committedConfigRevision: rawEntry.committedConfigRevision,
    }
  })
  if (value.state === 'prepared' && entries.some((entry) => entry.committedConfigRevision !== null)) {
    throw new Error('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
  }
  if ((value.state === 'graph-committed' || value.state === 'batch-committed')
    && entries.some((entry) => entry.committedConfigRevision === null)) {
    throw new Error('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    batchId: value.batchId,
    projectId: target.projectId,
    canvasId: target.canvasId,
    mode: value.mode,
    baseCanvasRevision: value.baseCanvasRevision,
    entries,
    expectedGraphSha256: value.expectedGraphSha256,
    state: value.state as CanvasImageCandidateAdoptionState,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

/** 从完整批次派生不含条目的初始 LOAD 摘要。 */
function summarize(batch: CanvasImageCandidateBatch): CanvasImageCandidateBatchSummary {
  return {
    batchId: batch.batchId,
    projectId: batch.projectId,
    canvasId: batch.canvasId,
    status: batch.status,
    entries: batch.entries
      .map((entry) => ({ nodeId: entry.nodeId, status: entry.status }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    totalCount: batch.entries.length,
    candidateCount: batch.entries.filter((entry) => entry.status === 'candidate').length,
    failedCount: batch.entries.filter((entry) => entry.status === 'failed' || entry.status === 'invalid').length,
    runningCount: batch.entries.filter((entry) => entry.status === 'queued' || entry.status === 'running').length,
    updatedAt: batch.updatedAt,
  }
}

/** 创建受管目录候选批次 Store。 */
export function createCanvasImageCandidateBatchStore(
  dependencies: CanvasImageCandidateBatchStoreDependencies,
): CanvasImageCandidateBatchStore {
  /** 扫描并严格解析目标 Canvas 的所有批次文件。 */
  const scan = async (target: CanvasTarget): Promise<CanvasImageCandidateBatch[]> => {
    if (dependencies.scanBatches) {
      return (await dependencies.scanBatches(target)).map(parseCanvasImageCandidateBatch)
    }
    if (!dependencies.documents) throw new Error('CANVAS_IMAGE_BATCH_DIRECTORY_CAPABILITY_MISSING')
    const loaded = dependencies.documents.loadWithDirectoryCapability(target)
    const directory = loaded.openSingleChildDirectory('transactions')
    const result = await runStableDirectoryNative({
      mode: 'canvas-intent-scan', roots: [directory.rootPath], childName: 'transactions',
      maxDepth: 0, maxEntries: MAX_CANDIDATE_BATCH_FILES, maxOutputBytes: 40 * 1024 * 1024,
    }, directory.authorizeOpenedRoots)
    /** 单次扫描结果只接受候选批次固定前缀，其他事务由其所有者处理。 */
    const batches: CanvasImageCandidateBatch[] = []
    for (const entry of result.entries) {
      const match = CANDIDATE_BATCH_FILE.exec(entry.name)
      if (!match) continue
      if (entry.isDirectory || typeof entry.content !== 'string') {
        throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
      }
      const batch = parseCanvasImageCandidateBatch(JSON.parse(entry.content) as unknown)
      if (batch.batchId !== match[1]
        || batch.projectId !== target.projectId
        || batch.canvasId !== target.canvasId) {
        throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
      }
      batches.push(batch)
    }
    directory.assertValid()
    return batches
  }

  /** 扫描并严格解析目标 Canvas 的全部整批采用 intent。 */
  const scanAdoptionIntents = async (
    target: CanvasTarget,
  ): Promise<CanvasImageCandidateAdoptionIntent[]> => {
    if (dependencies.scanAdoptionIntents) {
      return (await dependencies.scanAdoptionIntents(target)).map((intent) => (
        parseCanvasImageCandidateAdoptionIntent(intent, target, intent.operationId)
      ))
    }
    if (!dependencies.documents) throw new Error('CANVAS_IMAGE_BATCH_DIRECTORY_CAPABILITY_MISSING')
    const loaded = dependencies.documents.loadWithDirectoryCapability(target)
    const directory = loaded.openSingleChildDirectory('transactions')
    const result = await runStableDirectoryNative({
      mode: 'canvas-intent-scan', roots: [directory.rootPath], childName: 'transactions',
      maxDepth: 0, maxEntries: MAX_CANDIDATE_BATCH_FILES, maxOutputBytes: 40 * 1024 * 1024,
    }, directory.authorizeOpenedRoots)
    /** 采用 intent 只接受固定文件名与正文身份精确一致的普通文件。 */
    const intents: CanvasImageCandidateAdoptionIntent[] = []
    for (const entry of result.entries) {
      const match = ADOPTION_INTENT_FILE.exec(entry.name)
      if (!match) continue
      if (entry.isDirectory || typeof entry.content !== 'string') {
        throw new Error('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
      }
      let value: unknown
      try {
        value = JSON.parse(entry.content) as unknown
      } catch {
        throw new Error('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
      }
      intents.push(parseCanvasImageCandidateAdoptionIntent(value, target, match[1]!))
    }
    directory.assertValid()
    return intents
  }

  /** 原子写入一个完整批次。 */
  const write = async (batch: CanvasImageCandidateBatch): Promise<StableDirectoryNativeWriteOutcome> => {
    if (dependencies.writeBatch) return dependencies.writeBatch(batch)
    if (!dependencies.documents) throw new Error('CANVAS_IMAGE_BATCH_DIRECTORY_CAPABILITY_MISSING')
    const loaded = dependencies.documents.loadWithDirectoryCapability(batch)
    const directory = loaded.openSingleChildDirectory('transactions')
    const result = await runStableDirectoryNative({
      mode: 'canvas-intent-write', roots: [directory.rootPath], childName: 'transactions',
      fileName: `image-candidate-batch-${batch.batchId}.json`,
      content: `${JSON.stringify(batch, null, 2)}\n`, maxEntries: MAX_CANDIDATE_BATCH_FILES,
    }, directory.authorizeOpenedRoots)
    directory.assertValid()
    if (!result.writeOutcome) throw new Error('CANVAS_IMAGE_BATCH_WRITE_FAILED')
    return result.writeOutcome
  }

  /** 原子写入一个完整整批采用 intent。 */
  const writeAdoptionIntent = async (
    intent: CanvasImageCandidateAdoptionIntent,
  ): Promise<StableDirectoryNativeWriteOutcome> => {
    if (dependencies.writeAdoptionIntent) return dependencies.writeAdoptionIntent(intent)
    if (!dependencies.documents) throw new Error('CANVAS_IMAGE_BATCH_DIRECTORY_CAPABILITY_MISSING')
    const loaded = dependencies.documents.loadWithDirectoryCapability(intent)
    const directory = loaded.openSingleChildDirectory('transactions')
    const result = await runStableDirectoryNative({
      mode: 'canvas-intent-write', roots: [directory.rootPath], childName: 'transactions',
      fileName: `image-candidate-adoption-${intent.operationId}.json`,
      content: `${JSON.stringify(intent, null, 2)}\n`, maxEntries: MAX_CANDIDATE_BATCH_FILES,
    }, directory.authorizeOpenedRoots)
    directory.assertValid()
    if (!result.writeOutcome) throw new Error('CANVAS_IMAGE_BATCH_WRITE_FAILED')
    return result.writeOutcome
  }

  return {
    listActiveSummaries: async (target) => (await scan(target))
      .filter((batch) => batch.status === 'running' || batch.status === 'partial' || batch.status === 'ready')
      .map(summarize)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.batchId.localeCompare(right.batchId))
      .slice(0, CANVAS_IMAGE_CANDIDATE_BATCH_SUMMARY_LIMIT),
    load: async (target, batchId) => {
      const batch = (await scan(target)).find((candidate) => candidate.batchId === batchId)
      if (!batch) throw new Error('CANVAS_IMAGE_BATCH_NOT_FOUND')
      return batch
    },
    save: async (rawBatch) => {
      const batch = parseCanvasImageCandidateBatch(rawBatch)
      const outcome = await write(batch)
      if (!outcome.commitVisible) throw new Error('CANVAS_IMAGE_BATCH_WRITE_FAILED')
      if (outcome.durabilityUncertain) {
        const visible = (await scan(batch)).find((candidate) => candidate.batchId === batch.batchId)
        if (!visible || JSON.stringify(visible) !== JSON.stringify(batch)) {
          throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
        }
      }
      return batch
    },
    findByJobId: async (target, jobId, candidateBatchId) => {
      /** 新 journal 直接指定批次；旧 journal 才兼容扫描定位。 */
      if (candidateBatchId) {
        const batch = (await scan(target)).find((value) => value.batchId === candidateBatchId)
        if (!batch || !batch.entries.some((entry) => entry.jobId === jobId)) return null
        return batch
      }
      return (await scan(target)).find((batch) => batch.entries.some((entry) => entry.jobId === jobId)) ?? null
    },
    scanAdoptionIntents,
    loadAdoptionIntent: async (target, operationId) => {
      if (!ADOPTION_ID.test(operationId)) throw new Error('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
      const intent = (await scanAdoptionIntents(target)).find((candidate) => candidate.operationId === operationId)
      if (!intent) throw new Error('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_NOT_FOUND')
      return intent
    },
    saveAdoptionIntent: async (rawIntent) => {
      const intent = parseCanvasImageCandidateAdoptionIntent(
        rawIntent,
        rawIntent,
        rawIntent.operationId,
      )
      const outcome = await writeAdoptionIntent(intent)
      if (!outcome.commitVisible) throw new Error('CANVAS_IMAGE_BATCH_WRITE_FAILED')
      if (outcome.durabilityUncertain) {
        const visible = (await scanAdoptionIntents(intent))
          .find((candidate) => candidate.operationId === intent.operationId)
        if (!visible || JSON.stringify(visible) !== JSON.stringify(intent)) {
          throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
        }
      }
      return intent
    },
  }
}
