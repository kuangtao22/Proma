import { createHash, randomUUID } from 'node:crypto'
import type { CanvasNode } from '@proma/shared'
import { assertCanvasTaskMediaInspection } from './canvas-task-media-evidence'

/** 交付验证维度；配置保存、媒体采用和内容检查不能互相替代。 */
export type CanvasTaskValidation = 'response' | 'content' | 'configuration' | 'adopted' | 'inspection'

/** 音视频交付的用途级验收范围；它只声明要求，不代表已经完成检查。 */
export interface CanvasTaskMediaReview {
  stage: 'preview' | 'final'
  requireAudio?: boolean
  minDurationSeconds?: number
  maxDurationSeconds?: number
  width?: number
  height?: number
  contentCoverage: 'technical' | 'sampled' | 'full'
}

/** Host 对音视频资产生成的有界技术与内容检查证据。 */
export interface CanvasTaskMediaInspection {
  assetHash: string
  technicalStatus: 'passed' | 'failed' | 'unavailable'
  decoded: boolean
  coverage: 'none' | 'sampled' | 'full'
  sampledTimesMs: number[]
  verdict: 'unreviewed' | 'passed' | 'failed'
  notes: string
  width?: number
  height?: number
  durationMs?: number
  fps?: number
  hasAudio?: boolean
}

/** 模型依据用户语义登记的交付要求，开始后不能缩减。 */
export interface CanvasTaskRequirement {
  id: string
  description: string
  /** existing/updated 固定目标身份；created 可由可信回执绑定真实节点。 */
  nodeId?: string
  nodeKind?: CanvasNode['kind']
  validation: CanvasTaskValidation
  /** 缺省保持旧调用兼容，按 existing 处理。 */
  change?: 'existing' | 'updated' | 'created'
  /** 仅用于已采用的音视频；具体检查由 Host fresh-read 实现。 */
  mediaReview?: CanvasTaskMediaReview
}

/** Host 真实读取取得的版本证据，不接受模型直接提供 identity。 */
export interface CanvasTaskEvidence {
  canvasId: string
  nodeId: string
  nodeKind: CanvasNode['kind']
  validation: Exclude<CanvasTaskValidation, 'response'>
  identity: string
  /** 检查特定历史图像时保留任务身份，复验不得替换为当前默认图。 */
  jobId?: string
  /** 仅 audio/video adopted 可携带；字段来自 Host 检查边界。 */
  mediaInspection?: CanvasTaskMediaInspection
}

/** Host 已确认尚无正式产物的启动事实，不能提交为完成凭据。 */
export interface CanvasTaskAbsentArtifact extends Omit<CanvasTaskEvidence, 'identity'> {
  absent: true
}

/** 完成交付时引用 Host 签发的证据；纯文本响应直接提交正文。 */
export interface CanvasTaskSubmission { id: string; evidenceId?: string; text?: string }

/** 任务启动时由 Host 捕获的节点与产物基线。 */
export interface CanvasTaskBaseline {
  nodeIds: string[]
  evidence: Array<CanvasTaskEvidence | CanvasTaskAbsentArtifact>
}

/** Host 在图片任务成功建立批次后登记的本轮候选身份。 */
export interface CanvasTaskGeneratedJob { nodeId: string; jobId: string }

/** 工具副作用前先持久登记的操作意图。 */
export interface CanvasTaskPendingOperation {
  status: 'pending'
  operationId: string
  sourceToolCallId: string
  startedAt: number
  taskId: string
  canvasId: string
  kind: 'created' | 'updated'
  nodeId?: string
  nodeKind?: CanvasNode['kind']
  before?: CanvasTaskEvidence | CanvasTaskAbsentArtifact
}

/** 权威事务返回后提交的操作结果；不可变意图字段必须保持一致。 */
export interface CanvasTaskCompletedOperation extends Omit<CanvasTaskPendingOperation, 'status'> {
  status: 'completed'
  nodeId: string
  nodeKind: CanvasNode['kind']
  after: CanvasTaskEvidence
}

/** Host 在创建事务前确定拒绝的终态回执；不携带新节点或完成证据。 */
export interface CanvasTaskRejectedOperation extends Omit<CanvasTaskPendingOperation, 'status' | 'kind'> {
  status: 'rejected'
  kind: 'created'
  reasonCode: string
}

/** Host 工具边界记录的两阶段真实操作，不包含媒体正文。 */
export type CanvasTaskOperationReceipt = CanvasTaskPendingOperation | CanvasTaskCompletedOperation | CanvasTaskRejectedOperation

/** created 要求与真实后继节点之间的追加绑定。 */
export interface CanvasTaskRequirementBinding { requirementId: string; operationId: string; nodeId: string }

/** 持久状态中的证据引用与事实。 */
export interface CanvasTaskProofRecord { evidenceId: string; evidence: CanvasTaskEvidence }

/** 可跨 Provider 实例恢复的完整有界任务状态。 */
export interface CanvasTaskState {
  schemaVersion: 1
  taskId: string
  phase: 'unplanned' | 'working' | 'completed' | 'blocked' | 'needs-input'
  canvasId: string | null
  requirements: CanvasTaskRequirement[]
  baseline?: CanvasTaskBaseline
  proofs: CanvasTaskProofRecord[]
  generatedJobs: CanvasTaskGeneratedJob[]
  submissions: CanvasTaskSubmission[]
  operationReceipts: CanvasTaskOperationReceipt[]
  bindings: CanvasTaskRequirementBinding[]
  blockingReason?: string
}

/** 预留证据引用的稳定长度；只有 record 后该引用才可用于完成检查。 */
export function describeCanvasTaskEvidence(evidence: CanvasTaskEvidence) {
  return {
    evidenceId: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
    nodeId: evidence.nodeId,
    validation: evidence.validation,
  }
}

/** 可选任务结束检查的结构化决定。 */
export type CanvasTaskCompletionDecision =
  | { action: 'complete' }
  | { action: 'continue'; message: string }
  | { action: 'blocked'; message: string }

/** 合同运行依赖与可选持久恢复入口。 */
export interface CanvasTaskContractOptions {
  required: boolean
  taskId?: string
  initialState?: CanvasTaskState
  /** 同步提交完整下一状态；抛错时内存状态保持不变。 */
  onStateChange?: (state: CanvasTaskState) => void
  verify: (evidence: CanvasTaskEvidence, signal: AbortSignal) => Promise<boolean>
  verifyBatch?: (evidence: readonly CanvasTaskEvidence[], signal: AbortSignal) => Promise<boolean>
  validateScope?: (canvasId: string, signal: AbortSignal) => Promise<void>
}

const stableIdPattern = /^[A-Za-z0-9_-]{1,128}$/
const evidenceIdPattern = /^[a-f0-9]{64}$/
const nodeKinds = new Set<CanvasNode['kind']>(['agent', 'image', 'audio', 'video', 'document', 'webview'])

/** 读取严格普通对象并拒绝额外字段。 */
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).every((key) => keys.includes(key))) throw new Error('CANVAS_TASK_STATE_INVALID')
  return value as Record<string, unknown>
}

/** 校验有界非空文本。 */
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error('CANVAS_TASK_STATE_INVALID')
  return value
}

/** 校验稳定 ID，阻断路径字符与特殊对象属性。 */
function id(value: unknown): string {
  if (typeof value !== 'string' || !stableIdPattern.test(value)) throw new Error('CANVAS_TASK_STATE_INVALID')
  return value
}

/** 校验节点类别。 */
function kind(value: unknown): CanvasNode['kind'] {
  if (!nodeKinds.has(value as CanvasNode['kind'])) throw new Error('CANVAS_TASK_STATE_INVALID')
  return value as CanvasNode['kind']
}

/** 校验有限数组。 */
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('CANVAS_TASK_STATE_INVALID')
  return value
}

/** 返回节点类别支持的交付验证维度。 */
function supportsValidation(
  nodeKind: CanvasNode['kind'],
  validation: Exclude<CanvasTaskValidation, 'response'>,
): boolean {
  switch (nodeKind) {
    case 'agent': return validation === 'content' || validation === 'configuration'
    case 'image': return validation === 'configuration' || validation === 'adopted' || validation === 'inspection'
    case 'audio':
    case 'video': return validation === 'configuration' || validation === 'adopted'
    case 'document':
    case 'webview': return validation === 'content'
  }
}

/** 严格解析可选媒体验收要求。 */
function mediaReview(value: unknown, nodeKind: CanvasNode['kind'], validation: CanvasTaskValidation): CanvasTaskMediaReview {
  if ((nodeKind !== 'audio' && nodeKind !== 'video') || validation !== 'adopted') throw new Error('CANVAS_TASK_STATE_INVALID')
  const input = object(value, ['stage', 'requireAudio', 'minDurationSeconds', 'maxDurationSeconds', 'width', 'height', 'contentCoverage'])
  if ((input.stage !== 'preview' && input.stage !== 'final')
    || !['technical', 'sampled', 'full'].includes(String(input.contentCoverage))) throw new Error('CANVAS_TASK_STATE_INVALID')
  const optionalBoolean = (candidate: unknown): boolean | undefined => {
    if (candidate === undefined) return undefined
    if (typeof candidate !== 'boolean') throw new Error('CANVAS_TASK_STATE_INVALID')
    return candidate
  }
  const optionalNumber = (candidate: unknown, integer = false): number | undefined => {
    if (candidate === undefined) return undefined
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0 || candidate > 86_400
      || (integer && !Number.isSafeInteger(candidate))) throw new Error('CANVAS_TASK_STATE_INVALID')
    return candidate
  }
  const minDurationSeconds = optionalNumber(input.minDurationSeconds)
  const maxDurationSeconds = optionalNumber(input.maxDurationSeconds)
  const width = optionalNumber(input.width, true)
  const height = optionalNumber(input.height, true)
  if ((minDurationSeconds !== undefined && maxDurationSeconds !== undefined && minDurationSeconds > maxDurationSeconds)
    || (nodeKind === 'audio' && (input.requireAudio !== undefined || width !== undefined || height !== undefined))) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  const requireAudio = optionalBoolean(input.requireAudio)
  return {
    stage: input.stage as CanvasTaskMediaReview['stage'],
    contentCoverage: input.contentCoverage as CanvasTaskMediaReview['contentCoverage'],
    ...(requireAudio === undefined ? {} : { requireAudio }),
    ...(minDurationSeconds === undefined ? {} : { minDurationSeconds }),
    ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  }
}

/** 严格解析 Host 媒体检查证据并限制所有数组与数值。 */
function mediaInspection(value: unknown): CanvasTaskMediaInspection {
  const input = object(value, [
    'assetHash', 'technicalStatus', 'decoded', 'coverage', 'sampledTimesMs', 'verdict', 'notes',
    'width', 'height', 'durationMs', 'fps', 'hasAudio',
  ])
  if (typeof input.assetHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.assetHash)
    || !['passed', 'failed', 'unavailable'].includes(String(input.technicalStatus))
    || typeof input.decoded !== 'boolean' || !['none', 'sampled', 'full'].includes(String(input.coverage))
    || !['unreviewed', 'passed', 'failed'].includes(String(input.verdict))
    || typeof input.notes !== 'string' || input.notes.length > 2048
    || !Array.isArray(input.sampledTimesMs) || input.sampledTimesMs.length > 12
    || input.sampledTimesMs.some((time) => !Number.isSafeInteger(time) || time < 0 || time > 86_400_000)) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  const optionalNumber = (candidate: unknown, maximum: number, integer = false): number | undefined => {
    if (candidate === undefined) return undefined
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0 || candidate > maximum
      || (integer && !Number.isSafeInteger(candidate))) throw new Error('CANVAS_TASK_STATE_INVALID')
    return candidate
  }
  const width = optionalNumber(input.width, 32_768, true)
  const height = optionalNumber(input.height, 32_768, true)
  const durationMs = optionalNumber(input.durationMs, 86_400_000, true)
  const fps = optionalNumber(input.fps, 1_000)
  if (input.hasAudio !== undefined && typeof input.hasAudio !== 'boolean') throw new Error('CANVAS_TASK_STATE_INVALID')
  return {
    assetHash: input.assetHash,
    technicalStatus: input.technicalStatus as CanvasTaskMediaInspection['technicalStatus'],
    decoded: input.decoded,
    coverage: input.coverage as CanvasTaskMediaInspection['coverage'],
    sampledTimesMs: [...input.sampledTimesMs],
    verdict: input.verdict as CanvasTaskMediaInspection['verdict'],
    notes: input.notes,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(fps === undefined ? {} : { fps }),
    ...(input.hasAudio === undefined ? {} : { hasAudio: input.hasAudio }),
  }
}

/** 严格解析单项交付要求。 */
function requirement(value: unknown): CanvasTaskRequirement {
  const input = object(value, ['id', 'description', 'nodeId', 'nodeKind', 'validation', 'change', 'mediaReview'])
  const requirementId = id(input.id)
  const description = text(input.description, 1024)
  if (!['response', 'content', 'configuration', 'adopted', 'inspection'].includes(String(input.validation))) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  const validation = input.validation as CanvasTaskValidation
  if (validation === 'response') {
    if (input.nodeId !== undefined || input.nodeKind !== undefined || input.change !== undefined || input.mediaReview !== undefined) {
      throw new Error('CANVAS_TASK_STATE_INVALID')
    }
    return { id: requirementId, description, validation }
  }
  const nodeKind = kind(input.nodeKind)
  if (input.change !== undefined && !['existing', 'updated', 'created'].includes(String(input.change))) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  const change = input.change as CanvasTaskRequirement['change']
  const nodeId = input.nodeId === undefined ? undefined : id(input.nodeId)
  if (!supportsValidation(nodeKind, validation) || ((change ?? 'existing') !== 'created' && !nodeId)) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  return {
    id: requirementId, description, nodeKind, validation,
    ...(nodeId ? { nodeId } : {}), ...(change ? { change } : {}),
    ...(input.mediaReview === undefined ? {} : { mediaReview: mediaReview(input.mediaReview, nodeKind, validation) }),
  }
}

/** 严格解析 Host 证据。 */
function evidence(value: unknown): CanvasTaskEvidence {
  const input = object(value, ['canvasId', 'nodeId', 'nodeKind', 'validation', 'identity', 'jobId', 'mediaInspection'])
  if (!['content', 'configuration', 'adopted', 'inspection'].includes(String(input.validation))) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  const nodeKind = kind(input.nodeKind)
  const validation = input.validation as Exclude<CanvasTaskValidation, 'response'>
  if (input.mediaInspection !== undefined && ((nodeKind !== 'audio' && nodeKind !== 'video') || validation !== 'adopted')) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  return {
    canvasId: id(input.canvasId), nodeId: id(input.nodeId), nodeKind,
    validation,
    identity: text(input.identity, 4096),
    ...(input.jobId === undefined ? {} : { jobId: id(input.jobId) }),
    ...(input.mediaInspection === undefined ? {} : { mediaInspection: mediaInspection(input.mediaInspection) }),
  }
}

/** 严格解析 Host 缺失事实。 */
function absent(value: unknown): CanvasTaskAbsentArtifact {
  const input = object(value, ['canvasId', 'nodeId', 'nodeKind', 'validation', 'jobId', 'absent'])
  if (input.absent !== true || !['content', 'configuration', 'adopted', 'inspection'].includes(String(input.validation))) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  return {
    canvasId: id(input.canvasId), nodeId: id(input.nodeId), nodeKind: kind(input.nodeKind),
    validation: input.validation as Exclude<CanvasTaskValidation, 'response'>, absent: true,
    ...(input.jobId === undefined ? {} : { jobId: id(input.jobId) }),
  }
}

/** 按字段形状解析存在或缺失证据。 */
function fact(value: unknown): CanvasTaskEvidence | CanvasTaskAbsentArtifact {
  const input = object(value, ['canvasId', 'nodeId', 'nodeKind', 'validation', 'identity', 'jobId', 'absent', 'mediaInspection'])
  return input.absent === true ? absent(value) : evidence(value)
}

/** 严格解析操作记录，确保完成与事务前拒绝不会混用证据。 */
function operation(value: unknown): CanvasTaskOperationReceipt {
  const input = object(value, [
    'status', 'operationId', 'sourceToolCallId', 'startedAt', 'taskId', 'canvasId', 'kind',
    'nodeId', 'nodeKind', 'before', 'after', 'reasonCode',
  ])
  if ((input.status !== 'pending' && input.status !== 'completed' && input.status !== 'rejected')
    || (input.kind !== 'created' && input.kind !== 'updated')
    || typeof input.startedAt !== 'number' || !Number.isSafeInteger(input.startedAt) || input.startedAt < 0) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  const base: Omit<CanvasTaskPendingOperation, 'status'> = {
    operationId: id(input.operationId), sourceToolCallId: id(input.sourceToolCallId), startedAt: input.startedAt,
    taskId: id(input.taskId), canvasId: id(input.canvasId), kind: input.kind as CanvasTaskPendingOperation['kind'],
    ...(input.nodeId === undefined ? {} : { nodeId: id(input.nodeId) }),
    ...(input.nodeKind === undefined ? {} : { nodeKind: kind(input.nodeKind) }),
    ...(input.before === undefined ? {} : { before: fact(input.before) }),
  }
  if (base.kind === 'updated' && (!base.nodeId || !base.nodeKind || !base.before || 'absent' in base.before)) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  if (base.kind === 'created' && base.before && !('absent' in base.before)) throw new Error('CANVAS_TASK_STATE_INVALID')
  if (input.status === 'pending') {
    if (input.after !== undefined || input.reasonCode !== undefined) throw new Error('CANVAS_TASK_STATE_INVALID')
    return { status: 'pending', ...base }
  }
  if (input.status === 'rejected') {
    if (base.kind !== 'created' || input.after !== undefined) throw new Error('CANVAS_TASK_STATE_INVALID')
    return { status: 'rejected', ...base, kind: 'created', reasonCode: id(input.reasonCode) }
  }
  if (input.reasonCode !== undefined) throw new Error('CANVAS_TASK_STATE_INVALID')
  if (!base.nodeId || !base.nodeKind || input.after === undefined) throw new Error('CANVAS_TASK_STATE_INVALID')
  const after = evidence(input.after)
  if (after.canvasId !== base.canvasId || after.nodeId !== base.nodeId || after.nodeKind !== base.nodeKind
    || (base.before && (base.before.canvasId !== base.canvasId || base.before.nodeId !== base.nodeId
      || base.before.nodeKind !== base.nodeKind || base.before.validation !== after.validation))
    || (base.kind === 'updated' && base.before && !('absent' in base.before) && base.before.identity === after.identity)) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  return { status: 'completed', ...base, nodeId: base.nodeId, nodeKind: base.nodeKind, after }
}

/** 严格解析完整持久任务状态，并重新构造所有字段。 */
export function parseCanvasTaskState(value: unknown): CanvasTaskState {
  const input = object(value, [
    'schemaVersion', 'taskId', 'phase', 'canvasId', 'requirements', 'baseline', 'proofs', 'generatedJobs',
    'submissions', 'operationReceipts', 'bindings', 'blockingReason',
  ])
  if (input.schemaVersion !== 1 || !['unplanned', 'working', 'completed', 'blocked', 'needs-input'].includes(String(input.phase))) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  const taskId = id(input.taskId)
  const phase = input.phase as CanvasTaskState['phase']
  const canvasId = input.canvasId === null ? null : id(input.canvasId)
  const requirements = array(input.requirements, 32).map(requirement)
  if (new Set(requirements.map((item) => item.id)).size !== requirements.length) throw new Error('CANVAS_TASK_STATE_INVALID')
  let baseline: CanvasTaskBaseline | undefined
  if (input.baseline !== undefined) {
    const baselineInput = object(input.baseline, ['nodeIds', 'evidence'])
    const nodeIds = array(baselineInput.nodeIds, 4096).map(id)
    const baselineEvidence = array(baselineInput.evidence, 256).map(fact)
    if (!canvasId || new Set(nodeIds).size !== nodeIds.length
      || baselineEvidence.some((proof) => proof.canvasId !== canvasId || !nodeIds.includes(proof.nodeId))) {
      throw new Error('CANVAS_TASK_STATE_INVALID')
    }
    baseline = { nodeIds, evidence: baselineEvidence }
  }
  const proofs = array(input.proofs, 256).map((value): CanvasTaskProofRecord => {
    const parsed = object(value, ['evidenceId', 'evidence'])
    const parsedEvidence = evidence(parsed.evidence)
    if (typeof parsed.evidenceId !== 'string' || !evidenceIdPattern.test(parsed.evidenceId)
      || describeCanvasTaskEvidence(parsedEvidence).evidenceId !== parsed.evidenceId) throw new Error('CANVAS_TASK_STATE_INVALID')
    return { evidenceId: parsed.evidenceId, evidence: parsedEvidence }
  })
  if (new Set(proofs.map((proof) => proof.evidenceId)).size !== proofs.length) throw new Error('CANVAS_TASK_STATE_INVALID')
  const generatedJobs = array(input.generatedJobs, 256).map((value): CanvasTaskGeneratedJob => {
    const parsed = object(value, ['nodeId', 'jobId'])
    return { nodeId: id(parsed.nodeId), jobId: id(parsed.jobId) }
  })
  const submissions = array(input.submissions, 32).map((value): CanvasTaskSubmission => {
    const parsed = object(value, ['id', 'evidenceId', 'text'])
    return {
      id: id(parsed.id),
      ...(parsed.evidenceId === undefined ? {} : { evidenceId: text(parsed.evidenceId, 128) }),
      ...(parsed.text === undefined ? {} : { text: text(parsed.text, 16_384) }),
    }
  })
  const operationReceipts = array(input.operationReceipts, 256).map(operation)
  if (new Set(operationReceipts.map((receipt) => receipt.operationId)).size !== operationReceipts.length
    || operationReceipts.some((receipt) => receipt.taskId !== taskId || receipt.canvasId !== canvasId)) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  const bindings = array(input.bindings, 256).map((value): CanvasTaskRequirementBinding => {
    const parsed = object(value, ['requirementId', 'operationId', 'nodeId'])
    return { requirementId: id(parsed.requirementId), operationId: id(parsed.operationId), nodeId: id(parsed.nodeId) }
  })
  const blockingReason = input.blockingReason === undefined ? undefined : text(input.blockingReason, 2048)
  if (phase === 'unplanned' && (canvasId !== null || requirements.length > 0 || baseline !== undefined)) throw new Error('CANVAS_TASK_STATE_INVALID')
  if (phase !== 'unplanned' && phase !== 'blocked' && phase !== 'needs-input' && (!canvasId || requirements.length < 1)) {
    throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  if ((phase === 'blocked' || phase === 'needs-input') !== (blockingReason !== undefined)) throw new Error('CANVAS_TASK_STATE_INVALID')
  for (const item of requirements) {
    const change = item.change ?? 'existing'
    if ((change === 'updated' || change === 'created') && !baseline) throw new Error('CANVAS_TASK_STATE_INVALID')
    if (change === 'updated' && !baseline?.evidence.some((proof) => proof.nodeId === item.nodeId
      && proof.nodeKind === item.nodeKind && proof.validation === item.validation)) throw new Error('CANVAS_TASK_STATE_INVALID')
    if (change === 'created' && item.nodeId && baseline?.nodeIds.includes(item.nodeId)) throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  for (const binding of bindings) {
    const item = requirements.find((candidate) => candidate.id === binding.requirementId)
    const receipt = operationReceipts.find((candidate) => candidate.operationId === binding.operationId)
    if (!item || (item.change ?? 'existing') !== 'created' || !receipt || receipt.status !== 'completed'
      || receipt.kind !== 'created' || receipt.nodeId !== binding.nodeId || receipt.nodeKind !== item.nodeKind
      || baseline?.nodeIds.includes(binding.nodeId)) throw new Error('CANVAS_TASK_STATE_INVALID')
  }
  return {
    schemaVersion: 1, taskId, phase, canvasId, requirements,
    ...(baseline ? { baseline } : {}), proofs, generatedJobs, submissions, operationReceipts, bindings,
    ...(blockingReason ? { blockingReason } : {}),
  }
}

/** 创建新的空任务状态。 */
function initialState(taskId: string): CanvasTaskState {
  return {
    schemaVersion: 1, taskId, phase: 'unplanned', canvasId: null, requirements: [], proofs: [],
    generatedJobs: [], submissions: [], operationReceipts: [], bindings: [],
  }
}

/** 将内部持久状态投影为模型可见的有界状态，不暴露证据、提交正文或生成历史。 */
export function projectCanvasTaskStatus(state: CanvasTaskState) {
  return {
    taskId: state.taskId,
    phase: state.phase,
    canvasId: state.canvasId,
    requirements: structuredClone(state.requirements),
    bindings: structuredClone(state.bindings),
    operationReceipts: state.operationReceipts.map((receipt) => ({
      operationId: receipt.operationId,
      status: receipt.status,
      kind: receipt.kind,
      ...(receipt.nodeKind ? { nodeKind: receipt.nodeKind } : {}),
      ...(receipt.nodeId ? { nodeId: receipt.nodeId } : {}),
      ...(receipt.status === 'rejected' ? { reasonCode: receipt.reasonCode } : {}),
    })),
    operationCount: state.operationReceipts.length,
    pendingOperationIds: state.operationReceipts.filter((receipt) => receipt.status === 'pending').map((receipt) => receipt.operationId),
    recoverableSteps: state.phase === 'unplanned' ? ['start']
      : state.phase === 'completed' ? []
        : state.phase === 'blocked' || state.phase === 'needs-input'
          ? ['status', 'resume', 'rebind', 'recover', 'complete']
          : ['status', 'resume', 'rebind', 'complete', 'block'],
    ...(state.blockingReason ? { blockingReason: state.blockingReason } : {}),
  }
}

/** 创建有界交付合同；持久化由同步提交钩子负责。 */
export function createCanvasTaskContract(options: CanvasTaskContractOptions) {
  /** 运行期唯一可变状态；提交前总是先构造完整副本。 */
  let state = parseCanvasTaskState(options.initialState ?? initialState(options.taskId ?? randomUUID()))
  if (options.taskId && options.taskId !== state.taskId) throw new Error('CANVAS_TASK_ID_MISMATCH')

  /** 先持久化下一状态，再替换内存引用。 */
  const commit = (candidate: CanvasTaskState): void => {
    const next = parseCanvasTaskState(candidate)
    options.onStateChange?.(structuredClone(next))
    state = next
  }

  /** 返回供模型展示的最小状态，不暴露 proof identity。 */
  const status = () => projectCanvasTaskStatus(state)

  /** 用固定绑定解析 created 的真实目标。 */
  const targetNodeId = (item: CanvasTaskRequirement): string | undefined => {
    for (let index = state.bindings.length - 1; index >= 0; index -= 1) {
      if (state.bindings[index]!.requirementId === item.id) return state.bindings[index]!.nodeId
    }
    return item.nodeId
  }

  /** 逐项 fresh-read，确认已登记交付仍然成立。 */
  const verifySubmissions = async (values: readonly CanvasTaskSubmission[], signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    if (values.length !== state.requirements.length || new Set(values.map((value) => value.id)).size !== values.length) {
      throw new Error('CANVAS_TASK_DELIVERABLES_INCOMPLETE')
    }
    const evidenceIds = values.flatMap((value) => value.evidenceId ? [value.evidenceId] : [])
    if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error('CANVAS_TASK_EVIDENCE_REUSED')
    const verifiedProofs: CanvasTaskEvidence[] = []
    for (const item of state.requirements) {
      const value = values.find((candidate) => candidate.id === item.id)
      if (!value) throw new Error('CANVAS_TASK_DELIVERABLES_INCOMPLETE')
      if (item.validation === 'response') {
        if (!value.text?.trim() || value.text.length > 16_384 || value.evidenceId) throw new Error('CANVAS_TASK_RESPONSE_REQUIRED')
        continue
      }
      const proof = value.evidenceId
        ? state.proofs.find((candidate) => candidate.evidenceId === value.evidenceId)?.evidence
        : undefined
      if (!proof || value.text) throw new Error('CANVAS_TASK_EVIDENCE_REQUIRED')
      if (proof.canvasId !== state.canvasId || proof.validation !== item.validation || proof.nodeKind !== item.nodeKind
        || (targetNodeId(item) && proof.nodeId !== targetNodeId(item))) throw new Error('CANVAS_TASK_EVIDENCE_MISMATCH')
      assertCanvasTaskMediaInspection(item, proof)
      const change = item.change ?? 'existing'
      if (change === 'created' && state.baseline?.nodeIds.includes(proof.nodeId)) throw new Error('CANVAS_TASK_CREATED_TARGET_EXISTS')
      if (change === 'updated') {
        const original = state.baseline?.evidence.find((candidate) => candidate.nodeId === proof.nodeId
          && candidate.nodeKind === proof.nodeKind && candidate.validation === proof.validation)
        if (!original) throw new Error('CANVAS_TASK_BASELINE_REQUIRED')
        if (!('absent' in original) && original.identity === proof.identity) throw new Error('CANVAS_TASK_EVIDENCE_UNCHANGED')
      }
      if (change === 'updated' && proof.validation === 'inspection') {
        if (!proof.jobId) throw new Error('CANVAS_TASK_CANDIDATE_ID_REQUIRED')
        if (!state.generatedJobs.some((job) => job.nodeId === proof.nodeId && job.jobId === proof.jobId)) {
          throw new Error('CANVAS_TASK_CANDIDATE_NOT_GENERATED')
        }
      }
      verifiedProofs.push(proof)
    }
    if (options.verifyBatch) {
      if (!await options.verifyBatch(verifiedProofs, signal)) throw new Error('CANVAS_TASK_EVIDENCE_STALE')
      signal.throwIfAborted()
      return
    }
    for (const proof of verifiedProofs) {
      if (!await options.verify(proof, signal)) throw new Error('CANVAS_TASK_EVIDENCE_STALE')
      signal.throwIfAborted()
    }
  }

  /** 一次解析并提交同一工具调用取得的多份 Host 证据。 */
  const recordMany = (values: readonly CanvasTaskEvidence[]) => {
    if (values.length === 0) return []
    if (values.length > 256) throw new Error('CANVAS_TASK_EVIDENCE_BATCH_INVALID')
    const parsed = values.map(evidence)
    const proofs = [...state.proofs]
    const references = parsed.map((proof) => {
      const reference = describeCanvasTaskEvidence(proof)
      const previous = proofs.findIndex((candidate) => candidate.evidenceId === reference.evidenceId)
      if (previous >= 0) proofs.splice(previous, 1)
      proofs.push({ evidenceId: reference.evidenceId, evidence: proof })
      if (proofs.length > 256) proofs.shift()
      return reference
    })
    commit({ ...state, proofs })
    return references
  }

  return {
    status,
    /** 导出不含媒体正文的完整状态，供 Host 原子保存。 */
    exportState: (): CanvasTaskState => structuredClone(state),
    /** 登记不可缩减的交付要求；同参数重放不重复创建任务。 */
    start(targetCanvasId: string, expected: CanvasTaskRequirement[], baseline?: CanvasTaskBaseline) {
      let candidate: CanvasTaskState
      try {
        candidate = parseCanvasTaskState({
          ...initialState(state.taskId), phase: 'working', canvasId: targetCanvasId,
          requirements: expected,
          ...(baseline ? { baseline } : {}),
        })
      } catch (error) {
        if (error instanceof Error && baseline === undefined
          && expected.some((item) => item.change === 'updated' || item.change === 'created')) {
          throw new Error('CANVAS_TASK_BASELINE_REQUIRED')
        }
        throw new Error('CANVAS_TASK_REQUIREMENTS_INVALID')
      }
      if (state.canvasId !== null) {
        if (state.canvasId !== candidate.canvasId || JSON.stringify(state.requirements) !== JSON.stringify(candidate.requirements)
          || JSON.stringify(state.baseline) !== JSON.stringify(candidate.baseline)) throw new Error('CANVAS_TASK_ALREADY_STARTED')
        return status()
      }
      commit(candidate)
      return status()
    },
    /** 仅由 Host 生产回执调用，登记本合同启动后的目标图片任务。 */
    recordGeneratedJobs(canvasId: string, jobs: readonly CanvasTaskGeneratedJob[]) {
      if (state.phase !== 'working' || state.canvasId !== canvasId) throw new Error('CANVAS_TASK_NOT_STARTED')
      let parsed: CanvasTaskGeneratedJob[]
      try { parsed = jobs.map((job) => ({ nodeId: id(job.nodeId), jobId: id(job.jobId) })) } catch {
        throw new Error('CANVAS_TASK_GENERATED_JOB_INVALID')
      }
      if (parsed.length > 256) throw new Error('CANVAS_TASK_GENERATED_JOB_INVALID')
      const generatedJobs = [...state.generatedJobs]
      for (const job of parsed) {
        const previous = generatedJobs.findIndex((candidate) => candidate.nodeId === job.nodeId && candidate.jobId === job.jobId)
        if (previous >= 0) generatedJobs.splice(previous, 1)
        generatedJobs.push(job)
        if (generatedJobs.length > 256) generatedJobs.shift()
      }
      commit({ ...state, generatedJobs })
    },
    /** 先登记 pending，再用同一不可变意图推进 completed 或 rejected；终态重放不会新增操作。 */
    recordOperation(receipt: CanvasTaskOperationReceipt) {
      if (!state.canvasId || state.phase === 'completed') throw new Error('CANVAS_TASK_NOT_STARTED')
      if (receipt.taskId !== state.taskId) throw new Error('CANVAS_TASK_OPERATION_TASK_MISMATCH')
      let parsed: CanvasTaskOperationReceipt
      try { parsed = operation(receipt) } catch { throw new Error('CANVAS_TASK_OPERATION_INVALID') }
      if (parsed.canvasId !== state.canvasId) throw new Error('CANVAS_TASK_OPERATION_INVALID')
      const existingIndex = state.operationReceipts.findIndex((candidate) => candidate.operationId === parsed.operationId)
      const operationReceipts = [...state.operationReceipts]
      if (existingIndex >= 0) {
        const existing = operationReceipts[existingIndex]!
        if (JSON.stringify(existing) === JSON.stringify(parsed)) return status()
        const immutable = (value: CanvasTaskOperationReceipt) => ({
          operationId: value.operationId, sourceToolCallId: value.sourceToolCallId, startedAt: value.startedAt,
          taskId: value.taskId, canvasId: value.canvasId, kind: value.kind,
          ...(value.kind === 'updated' ? { nodeId: value.nodeId, nodeKind: value.nodeKind, before: value.before } : {}),
        })
        const createdIntentChanged = existing.kind === 'created' && (
          (existing.nodeId !== undefined && existing.nodeId !== parsed.nodeId)
          || (existing.nodeKind !== undefined && existing.nodeKind !== parsed.nodeKind)
          || (existing.before !== undefined && JSON.stringify(existing.before) !== JSON.stringify(parsed.before))
        )
        /** 拒绝发生在事务前，不能像 completed 一样补入权威返回的新节点身份。 */
        const rejectedIntentChanged = parsed.status === 'rejected' && (
          existing.nodeId !== parsed.nodeId || existing.nodeKind !== parsed.nodeKind
          || JSON.stringify(existing.before) !== JSON.stringify(parsed.before)
        )
        if (existing.status !== 'pending' || (parsed.status !== 'completed' && parsed.status !== 'rejected')
          || createdIntentChanged || rejectedIntentChanged
          || JSON.stringify(immutable(existing)) !== JSON.stringify(immutable(parsed))) {
          throw new Error('CANVAS_TASK_OPERATION_CONFLICT')
        }
        operationReceipts[existingIndex] = parsed
      } else {
        if (parsed.status !== 'pending') throw new Error('CANVAS_TASK_OPERATION_PENDING_REQUIRED')
        operationReceipts.push(parsed)
        if (operationReceipts.length > 256) operationReceipts.shift()
      }
      commit({ ...state, operationReceipts })
      return status()
    },
    /** 仅用同任务可信 completed created 回执修正 created 要求的节点绑定。 */
    rebind(input: { requirementId: string; operationId: string }) {
      const item = state.requirements.find((candidate) => candidate.id === input.requirementId)
      if (!item) throw new Error('CANVAS_TASK_REQUIREMENT_NOT_FOUND')
      if ((item.change ?? 'existing') !== 'created') throw new Error('CANVAS_TASK_REBIND_NOT_ALLOWED')
      const receipt = state.operationReceipts.find((candidate) => candidate.operationId === input.operationId)
      if (!receipt) throw new Error('CANVAS_TASK_OPERATION_NOT_FOUND')
      if (receipt.status !== 'completed' || receipt.kind !== 'created' || receipt.nodeKind !== item.nodeKind
        || state.baseline?.nodeIds.includes(receipt.nodeId)) throw new Error('CANVAS_TASK_REBIND_NOT_ALLOWED')
      const amendment = { requirementId: item.id, operationId: receipt.operationId, nodeId: receipt.nodeId }
      const existing = state.bindings.find((binding) => JSON.stringify(binding) === JSON.stringify(amendment))
      if (existing) return status()
      if (state.bindings.length >= 256) throw new Error('CANVAS_TASK_BINDING_LIMIT')
      const bindings = [...state.bindings, amendment]
      commit({ ...state, bindings })
      return status()
    },
    /** 只有 Provider 真实读取成功后才能签发证据。 */
    record: (proof: CanvasTaskEvidence) => recordMany([proof])[0]!,
    /** 批量登记同一工具调用的 Host 证据，只触发一次原子状态提交。 */
    recordMany,
    /** 完成要求与当前事实核验；被阻断任务在事实满足后也可完成。 */
    async complete(values: CanvasTaskSubmission[], signal: AbortSignal) {
      if (!state.canvasId) throw new Error('CANVAS_TASK_NOT_STARTED')
      await options.validateScope?.(state.canvasId, signal)
      signal.throwIfAborted()
      await verifySubmissions(values, signal)
      commit({ ...state, submissions: structuredClone(values), phase: 'completed', blockingReason: undefined })
      return status()
    },
    /** 将无法在当前授权或输入内解决的原因交还调用方。 */
    block(phase: 'blocked' | 'needs-input', reason: string) {
      if (!reason.trim() || reason.length > 2048) throw new Error('CANVAS_TASK_BLOCK_REASON_REQUIRED')
      commit({ ...state, phase, blockingReason: reason })
      return status()
    },
    /** 重新确认 Canvas 作用域后续行原任务，不替换要求、基线或来源。 */
    async recover(signal: AbortSignal) {
      if (!state.canvasId || (state.phase !== 'blocked' && state.phase !== 'needs-input')) {
        throw new Error('CANVAS_TASK_RECOVERY_NOT_AVAILABLE')
      }
      if (state.operationReceipts.some((receipt) => receipt.status === 'pending')) {
        throw new Error('CANVAS_TASK_OPERATION_RECONCILIATION_REQUIRED')
      }
      await options.validateScope?.(state.canvasId, signal)
      signal.throwIfAborted()
      commit({ ...state, phase: 'working', blockingReason: undefined })
      return status()
    },
    /** 结束前重新检查真实交付状态。 */
    async evaluate(signal: AbortSignal): Promise<CanvasTaskCompletionDecision> {
      signal.throwIfAborted()
      if (state.canvasId) {
        await options.validateScope?.(state.canvasId, signal)
        signal.throwIfAborted()
      }
      if (state.phase === 'blocked' || state.phase === 'needs-input') return { action: 'blocked', message: state.blockingReason! }
      if (state.phase === 'unplanned' && !options.required) return { action: 'complete' }
      if (state.phase === 'completed') {
        try {
          await verifySubmissions(state.submissions, signal)
          return { action: 'complete' }
        } catch (error) {
          signal.throwIfAborted()
          if (!(error instanceof Error) || !error.message.startsWith('CANVAS_TASK_')) throw error
          commit({ ...state, phase: 'working', blockingReason: undefined })
        }
      }
      return {
        action: 'continue',
        message: `当前 Canvas 执行任务尚未交付。沿 taskId=${state.taskId} 恢复原要求和基线；读取真实结果取得证据后 complete。缺少必要输入或能力时用 block 报告具体原因。当前状态：${JSON.stringify(status())}`,
      }
    },
  }
}
