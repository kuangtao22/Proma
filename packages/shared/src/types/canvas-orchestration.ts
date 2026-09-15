import type { CanvasNodeKind } from './canvas'

/** 普通 Agent 交给画布编排者的不可变原始需求。 */
export interface CanvasOrchestrationRequest {
  requestId: string
  goal: string
  intent: 'design' | 'produce' | 'review' | 'revise'
  constraints: string[]
  referenceNodeIds: string[]
  deliverables: { id: string; title: string; kind: CanvasNodeKind; criteria: string[] }[]
}

/** 画布编排者维护的一项专业工作及其真实节点范围。 */
export interface CanvasOrchestrationStep {
  id: string
  title: string
  role: string
  instruction: string
  dependsOn: string[]
  inputNodeIds: string[]
  outputNodeIds: string[]
  agentNodeId: string | null
  criteria: string[]
  status: 'planned' | 'running' | 'needs-review' | 'completed' | 'blocked'
  note: string
  inputVersions?: Array<{ nodeId: string; identity: string }>
  outputVersions?: Array<{ nodeId: string; identity: string }>
  execution?: { startedAt: number; userMessageUuid: string }
  attempts?: number
}

/** 普通会话在原委托内补充的有界校正，不修改原始目标与交付合同。 */
export interface CanvasOrchestrationFollowUp {
  id: string
  instruction: string
  supersedesId?: string
  decisionId?: string
  status: 'pending' | 'started' | 'delivered' | 'failed' | 'abandoned'
  createdAt: number
  startedAt?: number
  userMessageUuid?: string
}

/** 一次需求校正对当前专业步骤的影响说明。 */
export interface CanvasOrchestrationImpact {
  followUpId: string
  affectedStepIds: string[]
  retainedStepIds: string[]
  explanation: string
  additionalWork: string
  runningWork: string
}

/** 关键决策中的一个有界选项。 */
export interface CanvasOrchestrationDecisionOption {
  id: string
  label: string
  impact: string
}

/** 需要普通聊天 Agent 交给用户处理的一项关键决策。 */
export interface CanvasOrchestrationDecision {
  id: string
  question: string
  options: CanvasOrchestrationDecisionOption[]
  recommendedOptionId: string
  reason: string
}

/** 画布编排者提交给 Host 的业务报告。 */
export interface CanvasOrchestrationReportInput {
  summary: string
  nextStep: string
  impact?: CanvasOrchestrationImpact
  decision?: CanvasOrchestrationDecision
}

/** Host 补充版本与时间证据后的持久业务报告。 */
export interface CanvasOrchestrationReport extends CanvasOrchestrationReportInput {
  reportedAt: number
  basedOnRevision: number
  stale: boolean
}

/** 单个 Canvas 当前编排委托的可信持久记录。 */
export interface CanvasOrchestrationRecord {
  schemaVersion: 1
  id: string
  revision: number
  projectId: string
  canvasId: string
  ownerSessionId: string
  request: CanvasOrchestrationRequest
  coordinatorNodeId: string | null
  coordinatorSessionId: string | null
  status: 'planning' | 'running' | 'waiting' | 'blocked' | 'completed' | 'cancelled'
  steps: CanvasOrchestrationStep[]
  summary: string
  runStartedAt: number | null
  createdAt: number
  updatedAt: number
  budget?: {
    maxAgentRuns: number
    agentRunsUsed: number
    maxMediaRuns: number
    mediaRunsUsed: number
    mediaReservations?: Array<{ operationId: string; count: number }>
  }
  followUps?: CanvasOrchestrationFollowUp[]
  report?: CanvasOrchestrationReport
}

/** 面向聊天和画布界面的有界业务进度投影。 */
export interface CanvasOrchestrationProgress {
  stepCounts: {
    total: number
    planned: number
    running: number
    needsReview: number
    completed: number
    blocked: number
  }
  currentSteps: {
    items: Array<Pick<CanvasOrchestrationStep, 'id' | 'title' | 'status'>>
    total: number
    omitted: number
  }
  nextStep: string
  report: CanvasOrchestrationReport | null
  pendingDecision: CanvasOrchestrationDecision | null
}

/** 通知 Renderer 按 revision 增量读取编排记录的轻量事件。 */
export interface CanvasOrchestrationChangedEvent {
  projectId: string
  canvasId: string
  revision: number
}

const orchestrationIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const orchestrationNodeKinds: readonly CanvasNodeKind[] = ['agent', 'image', 'audio', 'video', 'document', 'webview']
const orchestrationIntents: readonly CanvasOrchestrationRequest['intent'][] = ['design', 'produce', 'review', 'revise']
const orchestrationStepStatuses: readonly CanvasOrchestrationStep['status'][] = ['planned', 'running', 'needs-review', 'completed', 'blocked']
const orchestrationStatuses: readonly CanvasOrchestrationRecord['status'][] = ['planning', 'running', 'waiting', 'blocked', 'completed', 'cancelled']
const orchestrationFollowUpStatuses: readonly CanvasOrchestrationFollowUp['status'][] = ['pending', 'started', 'delivered', 'failed', 'abandoned']
const maximumRecordBytes = 512 * 1024

/** 检查对象只包含合同声明的固定字段。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key))
}

/** 检查对象包含全部必填字段且只额外包含声明的可选字段。 */
function hasContractKeys(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): value is Record<string, unknown> {
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys])
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && requiredKeys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowedKeys.has(key))
}

/** 检查跨进程身份可安全用于受管记录和作用域比较。 */
function isOrchestrationId(value: unknown): value is string {
  return typeof value === 'string' && orchestrationIdPattern.test(value)
}

/** 检查有界正文并拒绝只有空白的必填文本。 */
function isBoundedText(value: unknown, maximumLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximumLength && (allowEmpty || value.trim().length > 0)
}

/** 严格解析去重后的有界稳定 ID 列表。 */
function parseIdList(value: unknown, maximumItems: number, errorCode: string): string[] {
  if (!Array.isArray(value) || value.length > maximumItems
    || value.some((item) => !isOrchestrationId(item))
    || new Set(value).size !== value.length) throw new Error(errorCode)
  return [...value] as string[]
}

/** 严格解析去重后的有界正文列表。 */
function parseTextList(value: unknown, maximumItems: number, maximumLength: number, errorCode: string): string[] {
  if (!Array.isArray(value) || value.length > maximumItems
    || value.some((item) => !isBoundedText(item, maximumLength))
    || new Set(value).size !== value.length) throw new Error(errorCode)
  return [...value] as string[]
}

/** 严格解析 Host 冻结的节点版本证据，并限制在步骤声明的节点范围。 */
function parseNodeVersions(
  value: unknown,
  maximumItems: number,
): Array<{ nodeId: string; identity: string }> {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error('CANVAS_ORCHESTRATION_STEP_INVALID')
  const versions = value.map((item) => {
    if (!hasExactKeys(item, ['nodeId', 'identity']) || !isOrchestrationId(item.nodeId)
      || !isBoundedText(item.identity, 256)) {
      throw new Error('CANVAS_ORCHESTRATION_STEP_INVALID')
    }
    return { nodeId: item.nodeId, identity: item.identity }
  })
  if (new Set(versions.map((version) => version.nodeId)).size !== versions.length) {
    throw new Error('CANVAS_ORCHESTRATION_STEP_INVALID')
  }
  return versions
}

/** 严格解析一次影响评估，并拒绝重复或互相冲突的步骤引用。 */
function parseOrchestrationImpact(value: unknown): CanvasOrchestrationImpact {
  const fields = [
    'followUpId', 'affectedStepIds', 'retainedStepIds', 'explanation', 'additionalWork', 'runningWork',
  ] as const
  if (!hasExactKeys(value, fields) || !isOrchestrationId(value.followUpId)
    || !isBoundedText(value.explanation, 1_024)
    || !isBoundedText(value.additionalWork, 1_024)
    || !isBoundedText(value.runningWork, 1_024)) {
    throw new Error('CANVAS_ORCHESTRATION_REPORT_INVALID')
  }
  const affectedStepIds = parseIdList(value.affectedStepIds, 64, 'CANVAS_ORCHESTRATION_REPORT_INVALID')
  const retainedStepIds = parseIdList(value.retainedStepIds, 64, 'CANVAS_ORCHESTRATION_REPORT_INVALID')
  if (affectedStepIds.some(stepId => retainedStepIds.includes(stepId))) {
    throw new Error('CANVAS_ORCHESTRATION_REPORT_INVALID')
  }
  return {
    followUpId: value.followUpId,
    affectedStepIds,
    retainedStepIds,
    explanation: value.explanation,
    additionalWork: value.additionalWork,
    runningWork: value.runningWork,
  }
}

/** 严格解析关键决策，并保证推荐项真实存在于选项中。 */
function parseOrchestrationDecision(value: unknown): CanvasOrchestrationDecision {
  const fields = ['id', 'question', 'options', 'recommendedOptionId', 'reason'] as const
  if (!hasExactKeys(value, fields) || !isOrchestrationId(value.id)
    || !isBoundedText(value.question, 1_024) || !isOrchestrationId(value.recommendedOptionId)
    || !isBoundedText(value.reason, 1_024)
    || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 4) {
    throw new Error('CANVAS_ORCHESTRATION_REPORT_INVALID')
  }
  const options = value.options.map((item): CanvasOrchestrationDecisionOption => {
    if (!hasExactKeys(item, ['id', 'label', 'impact']) || !isOrchestrationId(item.id)
      || !isBoundedText(item.label, 120) || !isBoundedText(item.impact, 1_024)) {
      throw new Error('CANVAS_ORCHESTRATION_REPORT_INVALID')
    }
    return { id: item.id, label: item.label, impact: item.impact }
  })
  if (new Set(options.map(option => option.id)).size !== options.length
    || !options.some(option => option.id === value.recommendedOptionId)) {
    throw new Error('CANVAS_ORCHESTRATION_REPORT_INVALID')
  }
  return {
    id: value.id,
    question: value.question,
    options,
    recommendedOptionId: value.recommendedOptionId,
    reason: value.reason,
  }
}

/** 严格解析画布编排者提交的有界业务报告。 */
export function parseCanvasOrchestrationReportInput(value: unknown): CanvasOrchestrationReportInput {
  if (!hasContractKeys(value, ['summary', 'nextStep'], ['impact', 'decision'])
    || !isBoundedText(value.summary, 1_024)
    || !isBoundedText(value.nextStep, 1_024)) {
    throw new Error('CANVAS_ORCHESTRATION_REPORT_INVALID')
  }
  const report: CanvasOrchestrationReportInput = { summary: value.summary, nextStep: value.nextStep }
  if (Object.hasOwn(value, 'impact')) report.impact = parseOrchestrationImpact(value.impact)
  if (Object.hasOwn(value, 'decision')) report.decision = parseOrchestrationDecision(value.decision)
  return report
}

/** 严格解析 Host 已补充持久证据的完整报告。 */
function parseOrchestrationReport(value: unknown): CanvasOrchestrationReport {
  const requiredFields = ['summary', 'nextStep', 'reportedAt', 'basedOnRevision', 'stale'] as const
  if (!hasContractKeys(value, requiredFields, ['impact', 'decision'])
    || !Number.isSafeInteger(value.reportedAt) || Number(value.reportedAt) < 0
    || !Number.isSafeInteger(value.basedOnRevision) || Number(value.basedOnRevision) < 1
    || typeof value.stale !== 'boolean') {
    throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
  }
  let input: CanvasOrchestrationReportInput
  try {
    input = parseCanvasOrchestrationReportInput({
      summary: value.summary,
      nextStep: value.nextStep,
      ...(Object.hasOwn(value, 'impact') ? { impact: value.impact } : {}),
      ...(Object.hasOwn(value, 'decision') ? { decision: value.decision } : {}),
    })
  } catch {
    throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
  }
  return {
    ...input,
    reportedAt: Number(value.reportedAt),
    basedOnRevision: Number(value.basedOnRevision),
    stale: value.stale,
  }
}

/** 严格解析 Host 维护的 Agent 与媒体运行预算。 */
function parseBudget(value: unknown): NonNullable<CanvasOrchestrationRecord['budget']> {
  const requiredFields = ['maxAgentRuns', 'agentRunsUsed', 'maxMediaRuns', 'mediaRunsUsed'] as const
  if (!hasContractKeys(value, requiredFields, ['mediaReservations'])
    || !Number.isSafeInteger(value.maxAgentRuns) || Number(value.maxAgentRuns) < 1 || Number(value.maxAgentRuns) > 64
    || !Number.isSafeInteger(value.agentRunsUsed) || Number(value.agentRunsUsed) < 0
    || Number(value.agentRunsUsed) > Number(value.maxAgentRuns)
    || !Number.isSafeInteger(value.maxMediaRuns) || Number(value.maxMediaRuns) < 0 || Number(value.maxMediaRuns) > 64
    || !Number.isSafeInteger(value.mediaRunsUsed) || Number(value.mediaRunsUsed) < 0
    || Number(value.mediaRunsUsed) > Number(value.maxMediaRuns)) {
    throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
  }
  const budget: NonNullable<CanvasOrchestrationRecord['budget']> = {
    maxAgentRuns: Number(value.maxAgentRuns),
    agentRunsUsed: Number(value.agentRunsUsed),
    maxMediaRuns: Number(value.maxMediaRuns),
    mediaRunsUsed: Number(value.mediaRunsUsed),
  }
  if (Object.hasOwn(value, 'mediaReservations')) {
    if (!Array.isArray(value.mediaReservations) || value.mediaReservations.length > 64) {
      throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
    }
    const reservations = value.mediaReservations.map((item) => {
      if (!hasExactKeys(item, ['operationId', 'count']) || !isOrchestrationId(item.operationId)
        || !Number.isSafeInteger(item.count) || Number(item.count) < 1 || Number(item.count) > 64) {
        throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
      }
      return { operationId: item.operationId, count: Number(item.count) }
    })
    if (new Set(reservations.map(reservation => reservation.operationId)).size !== reservations.length
      || reservations.reduce((total, reservation) => total + reservation.count, 0) > budget.mediaRunsUsed) {
      throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
    }
    budget.mediaReservations = reservations
  }
  return budget
}

/** 严格解析普通会话追加的校正记录；执行锚点只能由 Host 在启动时成对写入。 */
function parseFollowUps(value: unknown, recordCreatedAt: number, recordUpdatedAt: number): CanvasOrchestrationFollowUp[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
  const followUps = value.map((item): CanvasOrchestrationFollowUp => {
    if (!hasContractKeys(item, ['id', 'instruction', 'status', 'createdAt'], ['supersedesId', 'decisionId', 'startedAt', 'userMessageUuid'])
      || !isOrchestrationId(item.id) || !isBoundedText(item.instruction, 4_096)
      || (Object.hasOwn(item, 'supersedesId') && !isOrchestrationId(item.supersedesId))
      || (Object.hasOwn(item, 'decisionId') && !isOrchestrationId(item.decisionId))
      || !orchestrationFollowUpStatuses.includes(item.status as CanvasOrchestrationFollowUp['status'])
      || !Number.isSafeInteger(item.createdAt) || Number(item.createdAt) < recordCreatedAt
      || Number(item.createdAt) > recordUpdatedAt) throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
    const hasStartedAt = Object.hasOwn(item, 'startedAt')
    const hasMessageUuid = Object.hasOwn(item, 'userMessageUuid')
    const supersedesId = typeof item.supersedesId === 'string' ? item.supersedesId : undefined
    const decisionId = typeof item.decisionId === 'string' ? item.decisionId : undefined
    if (item.status === 'pending') {
      if (hasStartedAt || hasMessageUuid) throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
      return { id: item.id, instruction: item.instruction, status: item.status as CanvasOrchestrationFollowUp['status'],
        createdAt: Number(item.createdAt), ...(supersedesId ? { supersedesId } : {}),
        ...(decisionId ? { decisionId } : {}) }
    }
    if (!hasStartedAt || !hasMessageUuid || !Number.isSafeInteger(item.startedAt)
      || Number(item.startedAt) < Number(item.createdAt) || Number(item.startedAt) > recordUpdatedAt
      || !isOrchestrationId(item.userMessageUuid)) throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
    return { id: item.id, instruction: item.instruction, status: item.status as CanvasOrchestrationFollowUp['status'],
      createdAt: Number(item.createdAt), ...(supersedesId ? { supersedesId } : {}),
      ...(decisionId ? { decisionId } : {}),
      startedAt: Number(item.startedAt), userMessageUuid: item.userMessageUuid }
  })
  if (new Set(followUps.map(item => item.id)).size !== followUps.length) {
    throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
  }
  const unfinished = followUps.filter(item => item.status === 'pending' || item.status === 'started')
  if (unfinished.length > 1 || (unfinished.length === 1 && followUps.at(-1)?.id !== unfinished[0]?.id)) {
    throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
  }
  /** 替代关系必须双向闭合：后继只指向更早的 abandoned，且每个 abandoned 恰有一个后继。 */
  const supersededCounts = new Map<string, number>()
  if (followUps.some((item, index) => {
    if (item.supersedesId === undefined) return false
    const superseded = followUps.slice(0, index).find(previous => previous.id === item.supersedesId)
    if (!superseded || superseded.status !== 'abandoned') return true
    supersededCounts.set(superseded.id, (supersededCounts.get(superseded.id) ?? 0) + 1)
    return false
  }) || followUps.some(item => item.status === 'abandoned' && supersededCounts.get(item.id) !== 1)) {
    throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
  }
  return followUps
}

/** 判断依赖图是否包含循环；步骤上限为 64，线性拓扑检查开销固定有界。 */
function hasDependencyCycle(steps: readonly CanvasOrchestrationStep[]): boolean {
  const remainingDependencies = new Map(steps.map((step) => [step.id, step.dependsOn.length]))
  const downstream = new Map<string, string[]>()
  for (const step of steps) {
    for (const dependencyId of step.dependsOn) {
      const dependents = downstream.get(dependencyId) ?? []
      dependents.push(step.id)
      downstream.set(dependencyId, dependents)
    }
  }
  const ready = [...remainingDependencies].filter(([, count]) => count === 0).map(([id]) => id)
  let visited = 0
  while (ready.length > 0) {
    const stepId = ready.pop()!
    visited += 1
    for (const dependentId of downstream.get(stepId) ?? []) {
      const nextCount = (remainingDependencies.get(dependentId) ?? 0) - 1
      remainingDependencies.set(dependentId, nextCount)
      if (nextCount === 0) ready.push(dependentId)
    }
  }
  return visited !== steps.length
}

/** 严格解析普通 Agent 的原始委托。 */
export function parseCanvasOrchestrationRequest(value: unknown): CanvasOrchestrationRequest {
  const fields = ['requestId', 'goal', 'intent', 'constraints', 'referenceNodeIds', 'deliverables'] as const
  if (!hasExactKeys(value, fields) || !isOrchestrationId(value.requestId)
    || !isBoundedText(value.goal, 32_768)
    || !orchestrationIntents.includes(value.intent as CanvasOrchestrationRequest['intent'])) {
    throw new Error('CANVAS_ORCHESTRATION_REQUEST_INVALID')
  }
  const constraints = parseTextList(value.constraints, 64, 4_096, 'CANVAS_ORCHESTRATION_REQUEST_INVALID')
  const referenceNodeIds = parseIdList(value.referenceNodeIds, 32, 'CANVAS_ORCHESTRATION_REQUEST_INVALID')
  if (!Array.isArray(value.deliverables) || value.deliverables.length > 16) {
    throw new Error('CANVAS_ORCHESTRATION_REQUEST_INVALID')
  }
  const deliverables = value.deliverables.map((item) => {
    const deliverableFields = ['id', 'title', 'kind', 'criteria'] as const
    if (!hasExactKeys(item, deliverableFields) || !isOrchestrationId(item.id)
      || !isBoundedText(item.title, 256)
      || !orchestrationNodeKinds.includes(item.kind as CanvasNodeKind)) {
      throw new Error('CANVAS_ORCHESTRATION_REQUEST_INVALID')
    }
    return {
      id: item.id,
      title: item.title,
      kind: item.kind as CanvasNodeKind,
      criteria: parseTextList(item.criteria, 32, 4_096, 'CANVAS_ORCHESTRATION_REQUEST_INVALID'),
    }
  })
  if (new Set(deliverables.map((deliverable) => deliverable.id)).size !== deliverables.length) {
    throw new Error('CANVAS_ORCHESTRATION_REQUEST_INVALID')
  }
  return {
    requestId: value.requestId,
    goal: value.goal,
    intent: value.intent as CanvasOrchestrationRequest['intent'],
    constraints,
    referenceNodeIds,
    deliverables,
  }
}

/** 严格解析一个专业编排步骤。 */
export function parseCanvasOrchestrationStep(value: unknown): CanvasOrchestrationStep {
  const requiredFields = [
    'id', 'title', 'role', 'instruction', 'dependsOn', 'inputNodeIds', 'outputNodeIds',
    'agentNodeId', 'criteria', 'status', 'note',
  ] as const
  const optionalFields = ['inputVersions', 'outputVersions', 'execution', 'attempts'] as const
  if (!hasContractKeys(value, requiredFields, optionalFields) || !isOrchestrationId(value.id)
    || !isBoundedText(value.title, 256) || !isBoundedText(value.role, 256)
    || !isBoundedText(value.instruction, 32_768)
    || (value.agentNodeId !== null && !isOrchestrationId(value.agentNodeId))
    || !orchestrationStepStatuses.includes(value.status as CanvasOrchestrationStep['status'])
    || !isBoundedText(value.note, 16_384, true)
    || (Object.hasOwn(value, 'attempts')
      && (!Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0 || Number(value.attempts) > 8))) {
    throw new Error('CANVAS_ORCHESTRATION_STEP_INVALID')
  }
  const dependsOn = parseIdList(value.dependsOn, 64, 'CANVAS_ORCHESTRATION_STEP_INVALID')
  const inputNodeIds = parseIdList(value.inputNodeIds, 32, 'CANVAS_ORCHESTRATION_STEP_INVALID')
  const outputNodeIds = parseIdList(value.outputNodeIds, 32, 'CANVAS_ORCHESTRATION_STEP_INVALID')
  if (new Set([...inputNodeIds, ...outputNodeIds]).size > 32) {
    throw new Error('CANVAS_ORCHESTRATION_STEP_INVALID')
  }
  const step: CanvasOrchestrationStep = {
    id: value.id,
    title: value.title,
    role: value.role,
    instruction: value.instruction,
    dependsOn,
    inputNodeIds,
    outputNodeIds,
    agentNodeId: value.agentNodeId,
    criteria: parseTextList(value.criteria, 32, 4_096, 'CANVAS_ORCHESTRATION_STEP_INVALID'),
    status: value.status as CanvasOrchestrationStep['status'],
    note: value.note,
  }
  if (Object.hasOwn(value, 'inputVersions')) {
    step.inputVersions = parseNodeVersions(value.inputVersions, 128)
  }
  if (Object.hasOwn(value, 'outputVersions')) {
    step.outputVersions = parseNodeVersions(value.outputVersions, 32)
  }
  if (Object.hasOwn(value, 'execution')) {
    if (!hasExactKeys(value.execution, ['startedAt', 'userMessageUuid'])
      || !Number.isSafeInteger(value.execution.startedAt) || Number(value.execution.startedAt) < 1
      || !isOrchestrationId(value.execution.userMessageUuid)) {
      throw new Error('CANVAS_ORCHESTRATION_STEP_INVALID')
    }
    step.execution = {
      startedAt: Number(value.execution.startedAt),
      userMessageUuid: value.execution.userMessageUuid,
    }
  }
  if (Object.hasOwn(value, 'attempts')) step.attempts = Number(value.attempts)
  return step
}

/** 严格解析一份完整编排记录。 */
export function parseCanvasOrchestrationRecord(value: unknown): CanvasOrchestrationRecord {
  const requiredFields = [
    'schemaVersion', 'id', 'revision', 'projectId', 'canvasId', 'ownerSessionId', 'request',
    'coordinatorNodeId', 'coordinatorSessionId', 'status', 'steps', 'summary', 'runStartedAt',
    'createdAt', 'updatedAt',
  ] as const
  if (!hasContractKeys(value, requiredFields, ['budget', 'followUps', 'report']) || value.schemaVersion !== 1
    || !isOrchestrationId(value.id) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !isOrchestrationId(value.projectId) || !isOrchestrationId(value.canvasId)
    || !isOrchestrationId(value.ownerSessionId)
    || (value.coordinatorNodeId !== null && !isOrchestrationId(value.coordinatorNodeId))
    || (value.coordinatorSessionId !== null && !isOrchestrationId(value.coordinatorSessionId))
    || !orchestrationStatuses.includes(value.status as CanvasOrchestrationRecord['status'])
    || !Array.isArray(value.steps) || value.steps.length > 64
    || !isBoundedText(value.summary, 32_768, true)
    || (value.runStartedAt !== null && (!Number.isSafeInteger(value.runStartedAt) || Number(value.runStartedAt) < 0))
    || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
    || !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < Number(value.createdAt)
    || (value.runStartedAt !== null && (Number(value.runStartedAt) < Number(value.createdAt)
      || Number(value.runStartedAt) > Number(value.updatedAt)))) {
    throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
  }
  let request: CanvasOrchestrationRequest
  let steps: CanvasOrchestrationStep[]
  let report: CanvasOrchestrationReport | undefined
  try {
    request = parseCanvasOrchestrationRequest(value.request)
    steps = value.steps.map(parseCanvasOrchestrationStep)
    if (Object.hasOwn(value, 'report')) report = parseOrchestrationReport(value.report)
  } catch {
    throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
  }
  const stepIds = new Set(steps.map((step) => step.id))
  const stepsById = new Map(steps.map(step => [step.id, step]))
  const outputNodeIds = steps.flatMap(step => step.outputNodeIds)
  const agentNodeIds = steps.flatMap(step => step.agentNodeId ? [step.agentNodeId] : [])
  if (stepIds.size !== steps.length
    || new Set(outputNodeIds).size !== outputNodeIds.length
    || new Set(agentNodeIds).size !== agentNodeIds.length
    || steps.some((step) => step.dependsOn.includes(step.id)
      || step.dependsOn.some((dependencyId) => !stepIds.has(dependencyId)))
    || steps.some(step => step.execution
      && (step.execution.startedAt < Number(value.createdAt) || step.execution.startedAt > Number(value.updatedAt)))
    || steps.some(step => {
      const validInputIds = new Set([
        ...step.inputNodeIds,
        ...step.dependsOn.flatMap(dependencyId => stepsById.get(dependencyId)?.outputNodeIds ?? []),
      ])
      return validInputIds.size > 128
        || step.inputVersions?.some(version => !validInputIds.has(version.nodeId))
        || step.outputVersions?.some(version => !step.outputNodeIds.includes(version.nodeId))
    })
    || hasDependencyCycle(steps)
    || (report !== undefined && (report.reportedAt < Number(value.createdAt)
      || report.reportedAt > Number(value.updatedAt) || report.basedOnRevision > Number(value.revision)))) {
    throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
  }
  const record: CanvasOrchestrationRecord = {
    schemaVersion: 1,
    id: value.id,
    revision: Number(value.revision),
    projectId: value.projectId,
    canvasId: value.canvasId,
    ownerSessionId: value.ownerSessionId,
    request,
    coordinatorNodeId: value.coordinatorNodeId,
    coordinatorSessionId: value.coordinatorSessionId,
    status: value.status as CanvasOrchestrationRecord['status'],
    steps,
    summary: value.summary,
    runStartedAt: value.runStartedAt === null ? null : Number(value.runStartedAt),
    createdAt: Number(value.createdAt),
    updatedAt: Number(value.updatedAt),
  }
  if (Object.hasOwn(value, 'budget')) record.budget = parseBudget(value.budget)
  if (Object.hasOwn(value, 'followUps')) {
    record.followUps = parseFollowUps(value.followUps, record.createdAt, record.updatedAt)
  }
  if (report !== undefined) {
    if (!report.stale && report.impact !== undefined) {
      const latestFollowUpId = record.followUps?.at(-1)?.id
      const referencedStepIds = [...report.impact.affectedStepIds, ...report.impact.retainedStepIds]
      if (report.impact.followUpId !== latestFollowUpId || referencedStepIds.some(stepId => !stepIds.has(stepId))) {
        throw new Error('CANVAS_ORCHESTRATION_RECORD_INVALID')
      }
    }
    record.report = report
  }
  if (new TextEncoder().encode(JSON.stringify(record, null, 2)).byteLength > maximumRecordBytes) {
    throw new Error('CANVAS_ORCHESTRATION_RECORD_SIZE_LIMIT')
  }
  return record
}

/** 判断记录状态是否已经停止后续编排。 */
export function isCanvasOrchestrationTerminal(status: CanvasOrchestrationRecord['status']): boolean {
  return status === 'completed' || status === 'cancelled'
}

/** 派生当前尚未回答的关键决策；失败或放弃的回答仍视为已经登记。 */
export function getCanvasOrchestrationPendingDecision(
  record: CanvasOrchestrationRecord,
): CanvasOrchestrationDecision | null {
  if (isCanvasOrchestrationTerminal(record.status) || !record.report?.decision) return null
  const decision = record.report.decision
  return record.followUps?.some(followUp => followUp.decisionId === decision.id) ? null : decision
}

/** 将完整步骤压缩为可稳定展示的有界业务进度，不读取画布或外部状态。 */
export function getCanvasOrchestrationProgress(record: CanvasOrchestrationRecord): CanvasOrchestrationProgress {
  const stepCounts: CanvasOrchestrationProgress['stepCounts'] = {
    total: record.steps.length,
    planned: record.steps.filter(step => step.status === 'planned').length,
    running: record.steps.filter(step => step.status === 'running').length,
    needsReview: record.steps.filter(step => step.status === 'needs-review').length,
    completed: record.steps.filter(step => step.status === 'completed').length,
    blocked: record.steps.filter(step => step.status === 'blocked').length,
  }
  const activeStatuses: CanvasOrchestrationStep['status'][] = ['blocked', 'running', 'needs-review', 'planned']
  const activeSteps = activeStatuses.flatMap(status => record.steps.filter(step => step.status === status))
  const visibleCandidates = activeSteps.length > 0
    ? activeSteps
    : record.steps.filter(step => step.status === 'completed')
  const items = visibleCandidates.slice(0, 8).map(({ id, title, status }) => ({ id, title, status }))
  const pendingDecision = getCanvasOrchestrationPendingDecision(record)
  let nextStep = record.report?.nextStep ?? ''
  if (record.status === 'completed') {
    nextStep = '编排已完成。'
  } else if (record.status === 'cancelled') {
    nextStep = '编排已取消。'
  } else if (pendingDecision) {
    nextStep = '等待用户决策。'
  } else if (record.report?.stale) {
    nextStep = '编排报告已过期，需要画布 Agent 更新影响评估。'
  } else if (!record.report) {
    const firstCurrentStep = visibleCandidates[0]
    if (firstCurrentStep?.status === 'blocked') nextStep = `处理阻塞步骤：${firstCurrentStep.title}`
    else if (firstCurrentStep?.status === 'running') nextStep = `继续执行：${firstCurrentStep.title}`
    else if (firstCurrentStep?.status === 'needs-review') nextStep = `等待评审：${firstCurrentStep.title}`
    else if (firstCurrentStep?.status === 'planned') nextStep = `下一步：${firstCurrentStep.title}`
  }
  return {
    stepCounts,
    currentSteps: {
      items,
      total: visibleCandidates.length,
      omitted: visibleCandidates.length - items.length,
    },
    nextStep,
    report: record.report ?? null,
    pendingDecision,
  }
}

/** 严格解析编排记录变化事件。 */
export function parseCanvasOrchestrationChangedEvent(value: unknown): CanvasOrchestrationChangedEvent {
  const fields = ['projectId', 'canvasId', 'revision'] as const
  if (!hasExactKeys(value, fields) || !isOrchestrationId(value.projectId) || !isOrchestrationId(value.canvasId)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
    throw new Error('CANVAS_ORCHESTRATION_CHANGED_EVENT_INVALID')
  }
  return { projectId: value.projectId, canvasId: value.canvasId, revision: Number(value.revision) }
}
