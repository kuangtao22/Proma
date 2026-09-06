/** Canvas 工作流持久运行允许的最大节点数。 */
export const CANVAS_WORKFLOW_RUN_NODE_LIMIT = 32
/** Canvas 工作流持久运行允许的最大起点数。 */
export const CANVAS_WORKFLOW_RUN_ROOT_LIMIT = 8
/** Canvas 工作流默认可消耗的实际执行时长。 */
export const CANVAS_WORKFLOW_RUN_DURATION_MS = 15 * 60_000

/** Canvas 工作流跨进程、跨重启共享的运行状态。 */
export type CanvasWorkflowRunStatus =
  | 'running' | 'waiting-review' | 'completed' | 'partial' | 'failed' | 'cancelled'

/** 持久计划中的节点推进状态。 */
export type CanvasWorkflowRunNodeStatus =
  | 'satisfied' | 'ready' | 'running' | 'completed' | 'waiting-adoption'
  | 'waiting-approval' | 'blocked' | 'failed' | 'cancelled'

/** Agent 子运行的稳定重放身份。 */
export interface CanvasWorkflowAgentExecution {
  kind: 'agent'
  operationId: string
}

/** 图片子运行及其精确候选批次事实。 */
export interface CanvasWorkflowImageExecution {
  kind: 'image'
  operationId: string
  batchId: string | null
  taskId: string | null
}

/** 音视频子运行事实，为 media 分支保留统一合同边界。 */
export interface CanvasWorkflowMediaExecution {
  kind: 'media'
  operationId: string
  mediaRunId: string | null
  outputKeys: string[]
}

/** 节点已取得所有权的外部执行事实。 */
export type CanvasWorkflowNodeExecution =
  | CanvasWorkflowAgentExecution | CanvasWorkflowImageExecution | CanvasWorkflowMediaExecution

/** DAG 单槽输入的内容身份；不复制正文或资产路径。 */
export interface CanvasWorkflowRunInputBinding {
  targetInputKey: string
  requiredKind: 'text' | 'number' | 'boolean' | 'image' | 'audio' | 'video'
  sourceNodeId: string | null
  sourceOutputKey: string | null
  sourceArtifactHash: string | null
  resolvedValueHash: string | null
}

/** 首次规划固定的节点身份、依赖与推进事实。 */
export interface CanvasWorkflowRunNode {
  nodeId: string
  kind: 'agent' | 'image' | 'audio' | 'video' | 'document' | 'webview'
  identityHash: string
  plannedArtifactHash: string | null
  /** 音视频模块配置 revision；当前图片/Agent 节点固定为 null。 */
  mediaConfigRevision: number | null
  inputBindings: CanvasWorkflowRunInputBinding[]
  dependencyNodeIds: string[]
  status: CanvasWorkflowRunNodeStatus
  errorCode: string | null
  execution: CanvasWorkflowNodeExecution | null
  completedArtifactHash: string | null
  completedAt: number | null
}

/** 工作流拥有者来自实际父 Agent 运行。 */
export interface CanvasWorkflowRunOwner {
  sessionId: string
  runStartedAt: number
}

/** 工作流媒体次数与实际执行时长预算。 */
export interface CanvasWorkflowRunBudget {
  maxMediaRuns: number
  consumedMediaRuns: number
  remainingMediaRuns: number
  maxDurationMs: number
  remainingDurationMs: number
  activeStartedAt: number | null
}

/** CanvasWorkflowRun 是跨节点推进的唯一持久事实。 */
export interface CanvasWorkflowRun {
  schemaVersion: 1
  id: string
  revision: number
  projectId: string
  canvasId: string
  operationId: string
  owner: CanvasWorkflowRunOwner
  status: CanvasWorkflowRunStatus
  initialCanvasRevision: number
  observedCanvasRevision: number
  rootNodeIds: string[]
  goal: string
  nodes: CanvasWorkflowRunNode[]
  budget: CanvasWorkflowRunBudget
  autoResumeAfterAdoption: boolean
  cancelRequestedAt: number | null
  cancelledAt: number | null
  createdAt: number
  updatedAt: number
}

/** 定位单个 Canvas 工作流运行的公开输入。 */
export interface CanvasWorkflowRunTarget {
  projectId: string
  canvasId: string
  sessionId: string
  runId: string
}

/** 查询当前 Canvas 工作流历史的公开分页输入。 */
export interface CanvasWorkflowRunListInput {
  projectId: string
  canvasId: string
  sessionId: string
  cursor?: string
  limit?: number
}

/** 工作流历史页，按更新时间从新到旧排列。 */
export interface CanvasWorkflowRunPage {
  runs: CanvasWorkflowRun[]
  nextCursor: string | null
}

/** 工作流运行关键事实变化后的轻量通知。 */
export interface CanvasWorkflowRunChangedEvent {
  projectId: string
  canvasId: string
  runId: string
  revision: number
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断对象是否严格包含指定字段。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

/** 判断值是否为非负安全整数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

/** 判断值是否为不会成为路径片段的稳定 ID。 */
function isStableId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
}

/** 判断值是否为工作流运行持久 ID。 */
function isRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{48}$/.test(value)
}

/** 判断值是否为工作流历史游标。 */
function isRunCursor(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d+)-([a-f0-9]{48})$/.exec(value)
  return Boolean(match && Number.isSafeInteger(Number(match[1])))
}

/** 判断值是否为 SHA-256 内容指纹或空值。 */
function isHashOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
}

/** 判断值是否为稳定错误码或空值。 */
function isErrorCode(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,119}$/.test(value))
}

/** 严格解析节点的外部执行身份。 */
function parseExecution(value: unknown): CanvasWorkflowNodeExecution | null {
  if (value === null) return null
  if (hasExactKeys(value, ['kind', 'operationId'])
    && value.kind === 'agent' && isStableId(value.operationId)) {
    return { kind: 'agent', operationId: value.operationId }
  }
  if (hasExactKeys(value, ['kind', 'operationId', 'batchId', 'taskId'])
    && value.kind === 'image' && isStableId(value.operationId)
    && (value.batchId === null || isStableId(value.batchId))
    && (value.taskId === null || isStableId(value.taskId))
    && ((value.batchId === null) === (value.taskId === null))) {
    return { kind: 'image', operationId: value.operationId, batchId: value.batchId, taskId: value.taskId }
  }
  if (hasExactKeys(value, ['kind', 'operationId', 'mediaRunId', 'outputKeys'])
    && value.kind === 'media' && isStableId(value.operationId)
    && (value.mediaRunId === null || isStableId(value.mediaRunId))
    && Array.isArray(value.outputKeys) && value.outputKeys.length <= 16
    && value.outputKeys.every(isStableId)
    && new Set(value.outputKeys).size === value.outputKeys.length) {
    return {
      kind: 'media', operationId: value.operationId, mediaRunId: value.mediaRunId,
      outputKeys: [...value.outputKeys],
    }
  }
  throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
}

/** 严格解析单个 DAG 输入槽指纹。 */
function parseInputBinding(value: unknown): CanvasWorkflowRunInputBinding {
  const keys = [
    'targetInputKey', 'requiredKind', 'sourceNodeId', 'sourceOutputKey',
    'sourceArtifactHash', 'resolvedValueHash',
  ] as const
  const kinds = ['text', 'number', 'boolean', 'image', 'audio', 'video'] as const
  if (!hasExactKeys(value, keys)
    || typeof value.targetInputKey !== 'string' || value.targetInputKey.length < 1
    || value.targetInputKey.length > 256
    || !kinds.includes(value.requiredKind as typeof kinds[number])
    || (value.sourceNodeId !== null && !isStableId(value.sourceNodeId))
    || (value.sourceOutputKey !== null && typeof value.sourceOutputKey !== 'string')
    || ((value.sourceNodeId === null) !== (value.sourceOutputKey === null))
    || !isHashOrNull(value.sourceArtifactHash) || !isHashOrNull(value.resolvedValueHash)) {
    throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
  }
  return {
    targetInputKey: value.targetInputKey,
    requiredKind: value.requiredKind as CanvasWorkflowRunInputBinding['requiredKind'],
    sourceNodeId: value.sourceNodeId,
    sourceOutputKey: value.sourceOutputKey,
    sourceArtifactHash: value.sourceArtifactHash,
    resolvedValueHash: value.resolvedValueHash,
  }
}

/** 严格解析单个持久节点并校验状态组合。 */
function parseNode(value: unknown): CanvasWorkflowRunNode {
  const keys = [
    'nodeId', 'kind', 'identityHash', 'plannedArtifactHash', 'mediaConfigRevision', 'inputBindings',
    'dependencyNodeIds', 'status', 'errorCode', 'execution',
    'completedArtifactHash', 'completedAt',
  ] as const
  const kinds: readonly CanvasWorkflowRunNode['kind'][] = [
    'agent', 'image', 'audio', 'video', 'document', 'webview',
  ]
  const statuses: readonly CanvasWorkflowRunNodeStatus[] = [
    'satisfied', 'ready', 'running', 'completed', 'waiting-adoption',
    'waiting-approval', 'blocked', 'failed', 'cancelled',
  ]
  if (!hasExactKeys(value, keys) || !isStableId(value.nodeId)
    || !kinds.includes(value.kind as CanvasWorkflowRunNode['kind'])
    || typeof value.identityHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.identityHash)
    || !isHashOrNull(value.plannedArtifactHash)
    || (value.mediaConfigRevision !== null && !isNonNegativeInteger(value.mediaConfigRevision))
    || !Array.isArray(value.inputBindings) || value.inputBindings.length > 128
    || !Array.isArray(value.dependencyNodeIds) || value.dependencyNodeIds.length > 32
    || !value.dependencyNodeIds.every(isStableId)
    || new Set(value.dependencyNodeIds).size !== value.dependencyNodeIds.length
    || !statuses.includes(value.status as CanvasWorkflowRunNodeStatus)
    || !isErrorCode(value.errorCode) || !isHashOrNull(value.completedArtifactHash)
    || (value.completedAt !== null && !isNonNegativeInteger(value.completedAt))) {
    throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
  }
  const execution = parseExecution(value.execution)
  const inputBindings = value.inputBindings.map(parseInputBinding)
  const status = value.status as CanvasWorkflowRunNodeStatus
  const kind = value.kind as CanvasWorkflowRunNode['kind']
  if ((status === 'blocked' || status === 'failed') !== (value.errorCode !== null)
    || (status === 'running' && execution === null)
    || (status === 'completed') !== (value.completedAt !== null)
    || ((value.completedAt === null) !== (value.completedArtifactHash === null))
    || (execution?.kind === 'agent' && kind !== 'agent')
    || (execution?.kind === 'image' && kind !== 'image')
    || (execution?.kind === 'media' && kind !== 'audio' && kind !== 'video')
    || ((kind !== 'audio' && kind !== 'video') && value.mediaConfigRevision !== null)
    || new Set(inputBindings.map((binding) => binding.targetInputKey)).size !== inputBindings.length) {
    throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
  }
  return {
    nodeId: value.nodeId, kind, identityHash: value.identityHash,
    plannedArtifactHash: value.plannedArtifactHash,
    mediaConfigRevision: value.mediaConfigRevision,
    inputBindings,
    dependencyNodeIds: [...value.dependencyNodeIds], status, errorCode: value.errorCode,
    execution, completedArtifactHash: value.completedArtifactHash, completedAt: value.completedAt,
  }
}

/** 严格解析 Canvas 工作流持久运行，供 journal、IPC 与测试共用。 */
export function parseCanvasWorkflowRun(value: unknown): CanvasWorkflowRun {
  try {
    const keys = [
      'schemaVersion', 'id', 'revision', 'projectId', 'canvasId', 'operationId', 'owner',
      'status', 'initialCanvasRevision', 'observedCanvasRevision', 'rootNodeIds', 'goal',
      'nodes', 'budget', 'autoResumeAfterAdoption', 'cancelRequestedAt', 'cancelledAt',
      'createdAt', 'updatedAt',
    ] as const
    const statuses: readonly CanvasWorkflowRunStatus[] = [
      'running', 'waiting-review', 'completed', 'partial', 'failed', 'cancelled',
    ]
    if (!hasExactKeys(value, keys) || value.schemaVersion !== 1
      || typeof value.id !== 'string' || !/^[a-f0-9]{48}$/.test(value.id)
      || !isNonNegativeInteger(value.revision) || !isStableId(value.projectId)
      || !isStableId(value.canvasId) || !isStableId(value.operationId)
      || !hasExactKeys(value.owner, ['sessionId', 'runStartedAt'])
      || !isStableId(value.owner.sessionId) || !isNonNegativeInteger(value.owner.runStartedAt)
      || !statuses.includes(value.status as CanvasWorkflowRunStatus)
      || !isNonNegativeInteger(value.initialCanvasRevision)
      || !isNonNegativeInteger(value.observedCanvasRevision)
      || value.observedCanvasRevision < value.initialCanvasRevision
      || !Array.isArray(value.rootNodeIds) || value.rootNodeIds.length < 1
      || value.rootNodeIds.length > CANVAS_WORKFLOW_RUN_ROOT_LIMIT
      || !value.rootNodeIds.every(isStableId) || new Set(value.rootNodeIds).size !== value.rootNodeIds.length
      || typeof value.goal !== 'string' || value.goal.trim().length < 1 || value.goal.length > 8192
      || !Array.isArray(value.nodes) || value.nodes.length < 1
      || value.nodes.length > CANVAS_WORKFLOW_RUN_NODE_LIMIT
      || !hasExactKeys(value.budget, [
        'maxMediaRuns', 'consumedMediaRuns', 'remainingMediaRuns',
        'maxDurationMs', 'remainingDurationMs', 'activeStartedAt',
      ])
      || !isNonNegativeInteger(value.budget.maxMediaRuns)
      || !isNonNegativeInteger(value.budget.consumedMediaRuns)
      || !isNonNegativeInteger(value.budget.remainingMediaRuns)
      || value.budget.consumedMediaRuns + value.budget.remainingMediaRuns !== value.budget.maxMediaRuns
      || !isNonNegativeInteger(value.budget.maxDurationMs) || value.budget.maxDurationMs < 1
      || !isNonNegativeInteger(value.budget.remainingDurationMs)
      || value.budget.remainingDurationMs > value.budget.maxDurationMs
      || (value.budget.activeStartedAt !== null && !isNonNegativeInteger(value.budget.activeStartedAt))
      || typeof value.autoResumeAfterAdoption !== 'boolean'
      || (value.cancelRequestedAt !== null && !isNonNegativeInteger(value.cancelRequestedAt))
      || (value.cancelledAt !== null && !isNonNegativeInteger(value.cancelledAt))
      || !isNonNegativeInteger(value.createdAt) || !isNonNegativeInteger(value.updatedAt)
      || value.updatedAt < value.createdAt) {
      throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
    }
    const nodes = value.nodes.map(parseNode)
    const nodeIds = new Set(nodes.map((node) => node.nodeId))
    if (nodeIds.size !== nodes.length || value.rootNodeIds.some((id) => !nodeIds.has(id))
      || nodes.some((node) => node.dependencyNodeIds.some((id) => !nodeIds.has(id)))) {
      throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
    }
    const indegree = new Map(nodes.map((node) => [node.nodeId, node.dependencyNodeIds.length]))
    const downstream = new Map<string, string[]>()
    for (const node of nodes) {
      for (const dependencyId of node.dependencyNodeIds) {
        downstream.set(dependencyId, [...(downstream.get(dependencyId) ?? []), node.nodeId])
      }
    }
    const ready = nodes.filter((node) => indegree.get(node.nodeId) === 0).map((node) => node.nodeId)
    let visited = 0
    while (ready.length > 0) {
      const nodeId = ready.pop()!
      visited += 1
      for (const childId of downstream.get(nodeId) ?? []) {
        const next = (indegree.get(childId) ?? 0) - 1
        indegree.set(childId, next)
        if (next === 0) ready.push(childId)
      }
    }
    if (visited !== nodes.length
      || (value.status === 'cancelled') !== (value.cancelledAt !== null)
      || (value.cancelledAt !== null && value.cancelRequestedAt === null)) {
      throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
    }
    return {
      schemaVersion: 1, id: value.id, revision: value.revision,
      projectId: value.projectId, canvasId: value.canvasId, operationId: value.operationId,
      owner: { sessionId: value.owner.sessionId, runStartedAt: value.owner.runStartedAt },
      status: value.status as CanvasWorkflowRunStatus,
      initialCanvasRevision: value.initialCanvasRevision,
      observedCanvasRevision: value.observedCanvasRevision,
      rootNodeIds: [...value.rootNodeIds], goal: value.goal, nodes,
      budget: {
        maxMediaRuns: value.budget.maxMediaRuns,
        consumedMediaRuns: value.budget.consumedMediaRuns,
        remainingMediaRuns: value.budget.remainingMediaRuns,
        maxDurationMs: value.budget.maxDurationMs,
        remainingDurationMs: value.budget.remainingDurationMs,
        activeStartedAt: value.budget.activeStartedAt,
      },
      autoResumeAfterAdoption: value.autoResumeAfterAdoption,
      cancelRequestedAt: value.cancelRequestedAt, cancelledAt: value.cancelledAt,
      createdAt: value.createdAt, updatedAt: value.updatedAt,
    }
  } catch (error) {
    throw new Error('CANVAS_WORKFLOW_RUN_INVALID', { cause: error })
  }
}

/** 严格解析单个工作流运行目标。 */
export function parseCanvasWorkflowRunTarget(value: unknown): CanvasWorkflowRunTarget {
  if (!hasExactKeys(value, ['projectId', 'canvasId', 'sessionId', 'runId'])
    || !isStableId(value.projectId) || !isStableId(value.canvasId)
    || !isStableId(value.sessionId) || !isRunId(value.runId)) {
    throw new Error('CANVAS_WORKFLOW_RUN_TARGET_INVALID')
  }
  return {
    projectId: value.projectId, canvasId: value.canvasId,
    sessionId: value.sessionId, runId: value.runId,
  }
}

/** 严格解析工作流历史分页输入。 */
export function parseCanvasWorkflowRunListInput(value: unknown): CanvasWorkflowRunListInput {
  const keys = Object.keys(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
  const allowedKeys = ['projectId', 'canvasId', 'sessionId', 'cursor', 'limit'] as const
  if (!isRecord(value) || keys.some((key) => !allowedKeys.includes(key as typeof allowedKeys[number]))
    || !keys.includes('projectId') || !keys.includes('canvasId') || !keys.includes('sessionId')
    || !isStableId(value.projectId) || !isStableId(value.canvasId) || !isStableId(value.sessionId)
    || (value.cursor !== undefined && !isRunCursor(value.cursor))
    || (value.limit !== undefined
      && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 256))) {
    throw new Error('CANVAS_WORKFLOW_RUN_LIST_INPUT_INVALID')
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    sessionId: value.sessionId,
    ...(value.cursor !== undefined ? { cursor: value.cursor as string } : {}),
    ...(value.limit !== undefined ? { limit: Number(value.limit) } : {}),
  }
}

/** 严格解析工作流历史页并深重建每条运行。 */
export function parseCanvasWorkflowRunPage(value: unknown): CanvasWorkflowRunPage {
  try {
    if (!hasExactKeys(value, ['runs', 'nextCursor']) || !Array.isArray(value.runs)
      || value.runs.length > 256
      || (value.nextCursor !== null && !isRunCursor(value.nextCursor))) {
      throw new Error('CANVAS_WORKFLOW_RUN_PAGE_INVALID')
    }
    return {
      runs: value.runs.map(parseCanvasWorkflowRun),
      nextCursor: value.nextCursor,
    }
  } catch (error) {
    throw new Error('CANVAS_WORKFLOW_RUN_PAGE_INVALID', { cause: error })
  }
}

/** 严格解析工作流运行变化事件。 */
export function parseCanvasWorkflowRunChangedEvent(value: unknown): CanvasWorkflowRunChangedEvent {
  if (!hasExactKeys(value, ['projectId', 'canvasId', 'runId', 'revision'])
    || !isStableId(value.projectId) || !isStableId(value.canvasId) || !isRunId(value.runId)
    || !isNonNegativeInteger(value.revision)) {
    throw new Error('CANVAS_WORKFLOW_RUN_CHANGED_EVENT_INVALID')
  }
  return {
    projectId: value.projectId, canvasId: value.canvasId,
    runId: value.runId, revision: value.revision,
  }
}
