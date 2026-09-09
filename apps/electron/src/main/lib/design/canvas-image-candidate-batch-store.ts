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
import {
  createNativeCanvasTransactionArchive,
  type CanvasTransactionArchive,
  type CanvasTransactionEntry,
} from './canvas-transaction-archive'

/** 候选批次文件数量上限，阻止项目历史无界放大单次扫描。 */
const MAX_CANDIDATE_BATCH_FILES = 512
/** 旧目录整理读取上界；新增事务容量继续保持 512。 */
const MAX_CANDIDATE_BATCH_SCAN_FILES = 4096
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
  /** 同一素材已由先前采用提交，本事务只核对版本、不重复写模块或传播下游。 */
  alreadyAdopted?: true
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
  /** 原生协议注入点；生产沿用进程级资源预算，测试可使用真实 helper。 */
  runStableDirectoryNative?: typeof runStableDirectoryNative
  scanBatches?: (target: CanvasTarget) => Promise<CanvasImageCandidateBatch[]>
  writeBatch?: (batch: CanvasImageCandidateBatch) => Promise<StableDirectoryNativeWriteOutcome>
  scanAdoptionIntents?: (target: CanvasTarget) => Promise<CanvasImageCandidateAdoptionIntent[]>
  writeAdoptionIntent?: (intent: CanvasImageCandidateAdoptionIntent) => Promise<StableDirectoryNativeWriteOutcome>
  /** 测试注入的归档器；生产按本次 Canvas 目录 capability 创建。 */
  archive?: CanvasTransactionArchive
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

/**
 * 严格解析目标 Canvas 的候选批次，阻止归档别名返回跨项目正文。
 * @param value 磁盘或测试依赖返回的未知批次正文。
 * @param target 调用方已授权的项目与 Canvas 身份。
 * @param expectedBatchId 精确读取时由文件别名声明的批次身份。
 * @returns 深度解析且归属与别名均匹配的候选批次。
 */
function parseCandidateBatchForTarget(
  value: unknown,
  target: CanvasTarget,
  expectedBatchId?: string,
): CanvasImageCandidateBatch {
  if (expectedBatchId !== undefined && !ADOPTION_ID.test(expectedBatchId)) {
    throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
  }
  const batch = parseCanvasImageCandidateBatch(value)
  if (batch.projectId !== target.projectId
    || batch.canvasId !== target.canvasId
    || (expectedBatchId !== undefined && batch.batchId !== expectedBatchId)) {
    throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
  }
  return batch
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
      || !hasExactKeys(rawEntry, Object.hasOwn(rawEntry, 'alreadyAdopted') ? [...entryKeys, 'alreadyAdopted'] : entryKeys)
      || (Object.hasOwn(rawEntry, 'alreadyAdopted')
        && (rawEntry.alreadyAdopted !== true || rawEntry.oldAssetId !== rawEntry.candidateAssetId))
      || typeof rawEntry.nodeId !== 'string' || !ADOPTION_ID.test(rawEntry.nodeId)
      || typeof rawEntry.imageModuleId !== 'string' || !ADOPTION_ID.test(rawEntry.imageModuleId)
      || !isNullableId(rawEntry.oldAssetId)
      || typeof rawEntry.candidateAssetId !== 'string' || !ADOPTION_ID.test(rawEntry.candidateAssetId)
      || !isNonNegativeInteger(rawEntry.expectedConfigRevision)
      || (rawEntry.committedConfigRevision !== null
        && (!isNonNegativeInteger(rawEntry.committedConfigRevision)
          || rawEntry.committedConfigRevision !== rawEntry.expectedConfigRevision + (rawEntry.alreadyAdopted ? 0 : 1)))
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
      ...(rawEntry.alreadyAdopted ? { alreadyAdopted: true as const } : {}),
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
  /** 所有活动区和归档读写共用同一原生 host 与资源预算。 */
  const runNative = dependencies.runStableDirectoryNative ?? runStableDirectoryNative
  /** 从当前 Canvas capability 或测试注入取得精确归档访问。 */
  const archiveFor = (target: CanvasTarget): CanvasTransactionArchive | null => {
    if (dependencies.archive) return dependencies.archive
    if (!dependencies.documents) return null
    const loaded = dependencies.documents.loadWithDirectoryCapability(target)
    return createNativeCanvasTransactionArchive(loaded.openSingleChildDirectory('transactions'), { run: runNative })
  }

  /** 按已校验文件名精确读取，只有 active 明确缺失才回退同一目录能力的归档。 */
  const readTransaction = async (target: CanvasTarget, fileName: string): Promise<string | null> => {
    if (!dependencies.documents) throw new Error('CANVAS_IMAGE_BATCH_DIRECTORY_CAPABILITY_MISSING')
    const directory = dependencies.documents.loadWithDirectoryCapability(target)
      .openSingleChildDirectory('transactions')
    directory.assertValid()
    const result = await runNative({
      mode: 'canvas-intent-read', roots: [directory.rootPath], childName: 'transactions', fileName,
    }, directory.authorizeOpenedRoots)
    directory.assertValid()
    if (!result.readOutcome || result.readOutcome.status === 'corrupt') {
      throw new Error(fileName.startsWith('image-candidate-adoption-')
        ? 'CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID'
        : 'CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    }
    if (result.readOutcome.status === 'ok') return result.readOutcome.content
    return (dependencies.archive ?? createNativeCanvasTransactionArchive(directory, { run: runNative })).load(fileName)
  }

  /** 扫描并严格解析目标 Canvas 的所有批次文件。 */
  const scan = async (target: CanvasTarget): Promise<CanvasImageCandidateBatch[]> => {
    if (dependencies.scanBatches) {
      const batches = (await dependencies.scanBatches(target))
        .map((batch) => parseCandidateBatchForTarget(batch, target))
      await dependencies.archive?.archiveEntries(batches.map((batch) => ({
        name: `image-candidate-batch-${batch.batchId}.json`,
        content: `${JSON.stringify(batch, null, 2)}\n`,
      })))
      return batches
    }
    if (!dependencies.documents) throw new Error('CANVAS_IMAGE_BATCH_DIRECTORY_CAPABILITY_MISSING')
    const loaded = dependencies.documents.loadWithDirectoryCapability(target)
    const directory = loaded.openSingleChildDirectory('transactions')
    const result = await runNative({
      mode: 'canvas-intent-scan', roots: [directory.rootPath], childName: 'transactions',
      maxDepth: 0, maxEntries: MAX_CANDIDATE_BATCH_SCAN_FILES, maxOutputBytes: 40 * 1024 * 1024,
    }, directory.authorizeOpenedRoots)
    /** 单次扫描结果只接受候选批次固定前缀，其他事务由其所有者处理。 */
    const batches: CanvasImageCandidateBatch[] = []
    const archiveEntries: CanvasTransactionEntry[] = []
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
      archiveEntries.push({ name: entry.name, content: entry.content })
    }
    directory.assertValid()
    await createNativeCanvasTransactionArchive(directory, { run: runNative }).archiveEntries(archiveEntries)
    return batches
  }

  /** 扫描并严格解析目标 Canvas 的全部整批采用 intent。 */
  const scanAdoptionIntents = async (
    target: CanvasTarget,
  ): Promise<CanvasImageCandidateAdoptionIntent[]> => {
    if (dependencies.scanAdoptionIntents) {
      const intents = (await dependencies.scanAdoptionIntents(target)).map((intent) => (
        parseCanvasImageCandidateAdoptionIntent(intent, target, intent.operationId)
      ))
      await dependencies.archive?.archiveEntries(intents.map((intent) => ({
        name: `image-candidate-adoption-${intent.operationId}.json`,
        content: `${JSON.stringify(intent, null, 2)}\n`,
      })))
      return intents
    }
    if (!dependencies.documents) throw new Error('CANVAS_IMAGE_BATCH_DIRECTORY_CAPABILITY_MISSING')
    const loaded = dependencies.documents.loadWithDirectoryCapability(target)
    const directory = loaded.openSingleChildDirectory('transactions')
    const result = await runNative({
      mode: 'canvas-intent-scan', roots: [directory.rootPath], childName: 'transactions',
      maxDepth: 0, maxEntries: MAX_CANDIDATE_BATCH_SCAN_FILES, maxOutputBytes: 40 * 1024 * 1024,
    }, directory.authorizeOpenedRoots)
    /** 采用 intent 只接受固定文件名与正文身份精确一致的普通文件。 */
    const intents: CanvasImageCandidateAdoptionIntent[] = []
    const archiveEntries: CanvasTransactionEntry[] = []
    for (const entry of result.entries) {
      /** 精确读取不再整理目录，因此沿既有恢复扫描同时归档本 Store 的终态批次。 */
      const batchMatch = CANDIDATE_BATCH_FILE.exec(entry.name)
      if (batchMatch) {
        if (entry.isDirectory || typeof entry.content !== 'string') {
          throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
        }
        parseCandidateBatchForTarget(JSON.parse(entry.content) as unknown, target, batchMatch[1])
        archiveEntries.push({ name: entry.name, content: entry.content })
        continue
      }
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
      archiveEntries.push({ name: entry.name, content: entry.content })
    }
    directory.assertValid()
    await createNativeCanvasTransactionArchive(directory, { run: runNative }).archiveEntries(archiveEntries)
    return intents
  }

  /** 原子写入一个完整批次。 */
  const write = async (batch: CanvasImageCandidateBatch): Promise<StableDirectoryNativeWriteOutcome> => {
    if (dependencies.writeBatch) return dependencies.writeBatch(batch)
    if (!dependencies.documents) throw new Error('CANVAS_IMAGE_BATCH_DIRECTORY_CAPABILITY_MISSING')
    const loaded = dependencies.documents.loadWithDirectoryCapability(batch)
    const directory = loaded.openSingleChildDirectory('transactions')
    const result = await runNative({
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
    const result = await runNative({
      mode: 'canvas-intent-write', roots: [directory.rootPath], childName: 'transactions',
      fileName: `image-candidate-adoption-${intent.operationId}.json`,
      content: `${JSON.stringify(intent, null, 2)}\n`, maxEntries: MAX_CANDIDATE_BATCH_FILES,
    }, directory.authorizeOpenedRoots)
    directory.assertValid()
    if (!result.writeOutcome) throw new Error('CANVAS_IMAGE_BATCH_WRITE_FAILED')
    return result.writeOutcome
  }

  /** 精确读取候选批次；保留旧扫描注入合同供内存恢复测试使用。 */
  const loadBatch = async (target: CanvasTarget, batchId: string): Promise<CanvasImageCandidateBatch | null> => {
    if (!ADOPTION_ID.test(batchId)) throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    const fileName = `image-candidate-batch-${batchId}.json`
    let content: string | null | undefined
    if (dependencies.scanBatches) {
      const batch = (await scan(target)).find((candidate) => candidate.batchId === batchId)
      if (batch) return batch
      content = await archiveFor(target)?.load(fileName)
    } else {
      content = await readTransaction(target, fileName)
    }
    return content == null ? null : parseCandidateBatchForTarget(JSON.parse(content) as unknown, target, batchId)
  }

  /** 精确读取采用凭据；文件身份和正文身份始终同时校验。 */
  const loadIntent = async (
    target: CanvasTarget,
    operationId: string,
  ): Promise<CanvasImageCandidateAdoptionIntent | null> => {
    if (!ADOPTION_ID.test(operationId)) throw new Error('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
    const fileName = `image-candidate-adoption-${operationId}.json`
    let content: string | null | undefined
    if (dependencies.scanAdoptionIntents) {
      const intent = (await scanAdoptionIntents(target)).find((candidate) => candidate.operationId === operationId)
      if (intent) return intent
      content = await archiveFor(target)?.load(fileName)
    } else {
      content = await readTransaction(target, fileName)
    }
    return content == null ? null : parseCanvasImageCandidateAdoptionIntent(JSON.parse(content) as unknown, target, operationId)
  }

  return {
    listActiveSummaries: async (target) => (await scan(target))
      .filter((batch) => batch.status === 'running' || batch.status === 'partial' || batch.status === 'ready')
      .map(summarize)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.batchId.localeCompare(right.batchId))
      .slice(0, CANVAS_IMAGE_CANDIDATE_BATCH_SUMMARY_LIMIT),
    load: async (target, batchId) => {
      const batch = await loadBatch(target, batchId)
      if (!batch) throw new Error('CANVAS_IMAGE_BATCH_NOT_FOUND')
      return batch
    },
    save: async (rawBatch) => {
      const batch = parseCanvasImageCandidateBatch(rawBatch)
      const outcome = await write(batch)
      if (!outcome.commitVisible) throw new Error('CANVAS_IMAGE_BATCH_WRITE_FAILED')
      if (outcome.durabilityUncertain) {
        const visible = await loadBatch(batch, batch.batchId)
        if (!visible || JSON.stringify(visible) !== JSON.stringify(batch)) {
          throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
        }
      }
      return batch
    },
    findByJobId: async (target, jobId, candidateBatchId) => {
      /** 新 journal 直接指定批次；旧 journal 才兼容扫描定位。 */
      if (candidateBatchId) {
        const batch = await loadBatch(target, candidateBatchId)
        if (!batch || !batch.entries.some((entry) => entry.jobId === jobId)) return null
        return batch
      }
      return (await scan(target)).find((batch) => batch.entries.some((entry) => entry.jobId === jobId)) ?? null
    },
    scanAdoptionIntents,
    loadAdoptionIntent: async (target, operationId) => {
      const intent = await loadIntent(target, operationId)
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
        const visible = await loadIntent(intent, intent.operationId)
        if (!visible || JSON.stringify(visible) !== JSON.stringify(intent)) {
          throw new Error('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
        }
      }
      return intent
    },
  }
}
