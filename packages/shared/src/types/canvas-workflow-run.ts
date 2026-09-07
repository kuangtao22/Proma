/** Canvas 工作流持久运行允许的最大节点数。 */
export const CANVAS_WORKFLOW_RUN_NODE_LIMIT = 32
/** Canvas 工作流持久运行允许的最大起点数。 */
export const CANVAS_WORKFLOW_RUN_ROOT_LIMIT = 8
/** Canvas 工作流目标文本的最大长度。 */
export const CANVAS_WORKFLOW_RUN_GOAL_LIMIT = 8 * 1024
/** 单个媒体执行允许保存的最大输出角色数。 */
export const CANVAS_WORKFLOW_RUN_OUTPUT_KEY_LIMIT = 16
/** 单个媒体节点最多固化的输入槽数量。 */
export const CANVAS_WORKFLOW_RUN_INPUT_BINDING_LIMIT = 128
/** Canvas 工作流默认可消耗的实际执行时长。 */
export const CANVAS_WORKFLOW_RUN_DURATION_MS = 15 * 60_000
/** 单次恢复最多追加二十四小时，覆盖长视频生成但避免无界占用。 */
export const CANVAS_WORKFLOW_MAX_DURATION_EXTENSION_MS = 24 * 60 * 60_000
/** 单个持久工作流累计最多保留七天实际执行预算。 */
export const CANVAS_WORKFLOW_MAX_DURATION_MS = 7 * 24 * 60 * 60_000
/** 单次恢复最多追加的媒体运行额度。 */
export const CANVAS_WORKFLOW_MAX_MEDIA_RUN_EXTENSION = 16
/** 单个持久工作流累计最多消耗的媒体运行额度。 */
export const CANVAS_WORKFLOW_MAX_MEDIA_RUNS = 256
/** 单节点最多保留的历史执行身份。 */
export const CANVAS_WORKFLOW_RETRY_HISTORY_LIMIT = 16
/** 单个工作流最多保留的恢复 amendment，用于跨重放幂等。 */
export const CANVAS_WORKFLOW_RESUME_AMENDMENT_LIMIT = 128

/** Canvas 工作流跨进程、跨重启共享的运行状态。 */
export type CanvasWorkflowRunStatus =
  | 'running'
  | 'waiting-review'
  | 'waiting-budget'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'

/** 持久计划中的节点类别，与 Canvas 公共节点类别保持一致。 */
export type CanvasWorkflowRunNodeKind =
  | 'agent'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'webview'

/** 持久计划中的节点推进状态。 */
export type CanvasWorkflowRunNodeStatus =
  | 'satisfied'
  | 'ready'
  | 'running'
  | 'completed'
  | 'waiting-adoption'
  | 'waiting-approval'
  | 'blocked'
  | 'failed'
  | 'cancelled'

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

/** 音视频统一媒体子运行及其输出角色事实。 */
export interface CanvasWorkflowMediaExecution {
  kind: 'media'
  operationId: string
  mediaRunId: string | null
  outputKeys: string[]
}

/** 节点已取得所有权的外部执行事实。 */
export type CanvasWorkflowNodeExecution =
  | CanvasWorkflowAgentExecution
  | CanvasWorkflowImageExecution
  | CanvasWorkflowMediaExecution

/** 失败节点是否已取得允许付费重试的权威终态事实。 */
export type CanvasWorkflowRetryDisposition =
  | 'none'
  | 'terminal-failed'
  | 'submission-unknown'

/** 媒体节点从 typed DAG resolver 固化的单槽输入事实。 */
export interface CanvasWorkflowRunInputBinding {
  targetInputKey: string
  requiredKind: 'text' | 'number' | 'boolean' | 'image' | 'audio' | 'video'
  sourceNodeId: string | null
  sourceOutputKey: string | null
  sourceArtifactHash: string | null
  resolvedValueHash: string | null
}

/** 首次规划时固定的节点身份、依赖与推进事实。 */
export interface CanvasWorkflowRunNode {
  nodeId: string
  kind: CanvasWorkflowRunNodeKind
  identityHash: string
  /** 首次计划已采用输入的内容身份；待执行节点为 null。 */
  plannedArtifactHash: string | null
  /** 音视频模块配置 revision；其它节点固定为 null。 */
  mediaConfigRevision: number | null
  /** 只保存槽位与内容哈希，不复制正文或资产路径。 */
  inputBindings: CanvasWorkflowRunInputBinding[]
  dependencyNodeIds: string[]
  status: CanvasWorkflowRunNodeStatus
  errorCode: string | null
  execution: CanvasWorkflowNodeExecution | null
  /** 重试前的执行身份历史；旧 journal 缺省为空。 */
  executionHistory?: CanvasWorkflowNodeExecution[]
  /** 付费节点只有 terminal-failed 才能创建新 operation。 */
  retryDisposition?: CanvasWorkflowRetryDisposition
  /** 已完成节点的正式产物身份；不保存正文、路径或凭据。 */
  completedArtifactHash: string | null
  completedAt: number | null
}

/** 工作流拥有者来自实际父 Agent 运行，不接受调用参数伪造。 */
export interface CanvasWorkflowRunOwner {
  sessionId: string
  runStartedAt: number
}

/** 工作流自动生成预算，三类媒体共用同一计数。 */
export interface CanvasWorkflowRunBudget {
  maxMediaRuns: number
  consumedMediaRuns: number
  remainingMediaRuns: number
  /** 本次运行允许消耗的总执行时长。 */
  maxDurationMs: number
  /** 尚未消耗的实际执行时长；等待用户采用或审批不扣减。 */
  remainingDurationMs: number
  /** 当前执行段的持久起点；暂停计时后为 null。 */
  activeStartedAt: number | null
}

/** 一次恢复 amendment 的稳定输入，重复 operation 不得重复扩额。 */
export interface CanvasWorkflowResumeAmendment {
  operationId: string
  expectedRevision: number
  addDurationMs: number
  addMediaRuns: number
  retryNodeIds: string[]
}

/** CanvasWorkflowRun 是跨节点推进的唯一持久事实，不复制 Canvas 内容。 */
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
  /** 有界保存已提交恢复操作，作为跨进程幂等键。 */
  resumeAmendments?: CanvasWorkflowResumeAmendment[]
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

/** 工作流持久字段只接受安全稳定 ID，禁止路径片段。 */
function isStableId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** ComfyUI/Canvas binding key 可包含层级分隔符，但仍不能成为路径。 */
function isBindingKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
}

/** 判断对象是否只包含指定字段。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

/** 判断未知值是否为非负安全整数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

/** 判断未知值是否为稳定错误码。 */
function isErrorCode(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,119}$/.test(value))
}

/** 严格解析节点执行事实。 */
function parseExecution(value: unknown): CanvasWorkflowNodeExecution | null {
  if (value === null) return null
  if (hasExactKeys(value, ['kind', 'operationId'])
    && value.kind === 'agent'
    && isStableId(value.operationId)) {
    return { kind: 'agent', operationId: value.operationId }
  }
  if (hasExactKeys(value, ['kind', 'operationId', 'batchId', 'taskId'])
    && value.kind === 'image'
    && isStableId(value.operationId)
    && (value.batchId === null || isStableId(value.batchId))
    && (value.taskId === null || isStableId(value.taskId))
    && ((value.batchId === null) === (value.taskId === null))) {
    return {
      kind: 'image',
      operationId: value.operationId,
      batchId: value.batchId,
      taskId: value.taskId,
    }
  }
  if (hasExactKeys(value, ['kind', 'operationId', 'mediaRunId', 'outputKeys'])
    && value.kind === 'media'
    && isStableId(value.operationId)
    && (value.mediaRunId === null || isStableId(value.mediaRunId))
    && Array.isArray(value.outputKeys)
    && value.outputKeys.length <= CANVAS_WORKFLOW_RUN_OUTPUT_KEY_LIMIT
    && value.outputKeys.every(isBindingKey)
    && new Set(value.outputKeys).size === value.outputKeys.length) {
    return {
      kind: 'media',
      operationId: value.operationId,
      mediaRunId: value.mediaRunId,
      outputKeys: [...value.outputKeys],
    }
  }
  throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
}

/** 严格解析媒体节点的 typed DAG 输入槽事实。 */
function parseInputBinding(value: unknown): CanvasWorkflowRunInputBinding {
  const keys = [
    'targetInputKey', 'requiredKind', 'sourceNodeId', 'sourceOutputKey',
    'sourceArtifactHash', 'resolvedValueHash',
  ] as const
  const kinds = ['text', 'number', 'boolean', 'image', 'audio', 'video'] as const
  if (!hasExactKeys(value, keys)
    || !isBindingKey(value.targetInputKey)
    || !kinds.includes(value.requiredKind as typeof kinds[number])
    || (value.sourceNodeId !== null && !isStableId(value.sourceNodeId))
    || (value.sourceOutputKey !== null && !isBindingKey(value.sourceOutputKey))
    || ((value.sourceNodeId === null) !== (value.sourceOutputKey === null))
    || (value.sourceArtifactHash !== null
      && (typeof value.sourceArtifactHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceArtifactHash)))
    || (value.resolvedValueHash !== null
      && (typeof value.resolvedValueHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.resolvedValueHash)))
    || ((value.sourceArtifactHash === null) !== (value.resolvedValueHash === null)
      && value.sourceNodeId !== null)) {
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

/** 严格解析持久节点并重建数组，拒绝未知字段。 */
function parseNode(value: unknown): CanvasWorkflowRunNode {
  const legacyKeys = [
    'nodeId', 'kind', 'identityHash', 'plannedArtifactHash', 'mediaConfigRevision', 'inputBindings',
    'dependencyNodeIds', 'status', 'errorCode', 'execution',
    'completedArtifactHash', 'completedAt',
  ] as const
  const keys = [...legacyKeys, 'executionHistory', 'retryDisposition'] as const
  const kinds: readonly CanvasWorkflowRunNodeKind[] = [
    'agent', 'image', 'audio', 'video', 'document', 'webview',
  ]
  const statuses: readonly CanvasWorkflowRunNodeStatus[] = [
    'satisfied', 'ready', 'running', 'completed', 'waiting-adoption',
    'waiting-approval', 'blocked', 'failed', 'cancelled',
  ]
  if ((!hasExactKeys(value, legacyKeys) && !hasExactKeys(value, keys))
    || !isStableId(value.nodeId)
    || !kinds.includes(value.kind as CanvasWorkflowRunNodeKind)
    || typeof value.identityHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.identityHash)
    || (value.plannedArtifactHash !== null
      && (typeof value.plannedArtifactHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.plannedArtifactHash)))
    || (value.mediaConfigRevision !== null && !isNonNegativeInteger(value.mediaConfigRevision))
    || !Array.isArray(value.inputBindings)
    || value.inputBindings.length > CANVAS_WORKFLOW_RUN_INPUT_BINDING_LIMIT
    || !Array.isArray(value.dependencyNodeIds)
    || value.dependencyNodeIds.length > CANVAS_WORKFLOW_RUN_NODE_LIMIT
    || !value.dependencyNodeIds.every(isStableId)
    || new Set(value.dependencyNodeIds).size !== value.dependencyNodeIds.length
    || !statuses.includes(value.status as CanvasWorkflowRunNodeStatus)
    || !isErrorCode(value.errorCode)
    || (value.completedArtifactHash !== null
      && (typeof value.completedArtifactHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.completedArtifactHash)))
    || (value.completedAt !== null && !isNonNegativeInteger(value.completedAt))) {
    throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
  }
  const execution = parseExecution(value.execution)
  const status = value.status as CanvasWorkflowRunNodeStatus
  const executionHistory = 'executionHistory' in value
    ? Array.isArray(value.executionHistory) ? value.executionHistory.map(parseExecution) : null
    : []
  const retryDisposition = 'retryDisposition' in value
    ? value.retryDisposition
    : status === 'failed' && execution !== null ? 'submission-unknown' : 'none'
  const inputBindings = value.inputBindings.map(parseInputBinding)
  const kind = value.kind as CanvasWorkflowRunNodeKind
  if (executionHistory === null
    || executionHistory.length > CANVAS_WORKFLOW_RETRY_HISTORY_LIMIT
    || executionHistory.some((candidate) => candidate === null)
    || !['none', 'terminal-failed', 'submission-unknown'].includes(String(retryDisposition))
    || (retryDisposition === 'terminal-failed' && status !== 'failed')
    || (retryDisposition === 'submission-unknown'
      && status !== 'failed' && status !== 'ready' && status !== 'running')
    || (retryDisposition !== 'none' && execution === null)
    || (status === 'blocked' || status === 'failed') !== (value.errorCode !== null)
    || (execution?.kind === 'agent' && kind !== 'agent')
    || (execution?.kind === 'image' && kind !== 'image')
    || (execution?.kind === 'media' && kind !== 'audio' && kind !== 'video')
    || ((kind !== 'audio' && kind !== 'video') && value.mediaConfigRevision !== null)
    || ((kind !== 'audio' && kind !== 'video' && kind !== 'image') && inputBindings.length !== 0)
    || (kind === 'image' && inputBindings.some((binding) => binding.requiredKind !== 'image'
      || binding.sourceNodeId === null || binding.sourceOutputKey === null))
    || ((kind === 'audio' || kind === 'video')
      && value.mediaConfigRevision === null && inputBindings.length !== 0)
    || new Set(inputBindings.map((binding) => binding.targetInputKey)).size !== inputBindings.length
    || (status === 'running' && execution === null)
    || (status === 'waiting-adoption' && (
      execution === null
      || (execution.kind === 'image' && execution.batchId === null)
      || (execution.kind === 'media' && execution.mediaRunId === null)
      || (execution.kind === 'media' && execution.outputKeys.length === 0)
      || execution.kind === 'agent'
    ))
    || (status === 'completed') !== (value.completedAt !== null)
    || ((value.completedAt === null) !== (value.completedArtifactHash === null))) {
    throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
  }
  return {
    nodeId: value.nodeId,
    kind,
    identityHash: value.identityHash,
    plannedArtifactHash: value.plannedArtifactHash,
    mediaConfigRevision: value.mediaConfigRevision,
    inputBindings,
    dependencyNodeIds: [...value.dependencyNodeIds],
    status,
    errorCode: value.errorCode,
    execution,
    executionHistory: executionHistory as CanvasWorkflowNodeExecution[],
    retryDisposition: retryDisposition as CanvasWorkflowRetryDisposition,
    completedArtifactHash: value.completedArtifactHash,
    completedAt: value.completedAt,
  }
}

/** 严格解析 Canvas 工作流持久运行，供 journal、IPC 与测试共用。 */
export function parseCanvasWorkflowRun(value: unknown): CanvasWorkflowRun {
  try {
    const legacyKeys = [
      'schemaVersion', 'id', 'revision', 'projectId', 'canvasId', 'operationId', 'owner',
      'status', 'initialCanvasRevision', 'observedCanvasRevision', 'rootNodeIds', 'goal',
      'nodes', 'budget', 'autoResumeAfterAdoption', 'cancelRequestedAt', 'cancelledAt',
      'createdAt', 'updatedAt',
    ] as const
    const keys = [...legacyKeys, 'resumeAmendments'] as const
    const runStatuses: readonly CanvasWorkflowRunStatus[] = [
      'running', 'waiting-review', 'waiting-budget', 'completed', 'partial', 'failed', 'cancelled',
    ]
    if ((!hasExactKeys(value, legacyKeys) && !hasExactKeys(value, keys))
      || value.schemaVersion !== 1
      || typeof value.id !== 'string'
      || !/^[a-f0-9]{48}$/.test(value.id)
      || !isNonNegativeInteger(value.revision)
      || !isStableId(value.projectId)
      || !isStableId(value.canvasId)
      || !isStableId(value.operationId)
      || !hasExactKeys(value.owner, ['sessionId', 'runStartedAt'])
      || !isStableId(value.owner.sessionId)
      || !isNonNegativeInteger(value.owner.runStartedAt)
      || !runStatuses.includes(value.status as CanvasWorkflowRunStatus)
      || !isNonNegativeInteger(value.initialCanvasRevision)
      || !isNonNegativeInteger(value.observedCanvasRevision)
      || value.observedCanvasRevision < value.initialCanvasRevision
      || !Array.isArray(value.rootNodeIds)
      || value.rootNodeIds.length < 1
      || value.rootNodeIds.length > CANVAS_WORKFLOW_RUN_ROOT_LIMIT
      || !value.rootNodeIds.every(isStableId)
      || new Set(value.rootNodeIds).size !== value.rootNodeIds.length
      || typeof value.goal !== 'string'
      || value.goal.trim().length < 1
      || value.goal.length > CANVAS_WORKFLOW_RUN_GOAL_LIMIT
      || !Array.isArray(value.nodes)
      || value.nodes.length < 1
      || value.nodes.length > CANVAS_WORKFLOW_RUN_NODE_LIMIT
      || (!hasExactKeys(value.budget, ['maxMediaRuns', 'consumedMediaRuns', 'remainingMediaRuns'])
        && !hasExactKeys(value.budget, [
          'maxMediaRuns', 'consumedMediaRuns', 'remainingMediaRuns',
          'maxDurationMs', 'remainingDurationMs', 'activeStartedAt',
        ]))
      || !isNonNegativeInteger(value.budget.maxMediaRuns)
      || value.budget.maxMediaRuns > CANVAS_WORKFLOW_MAX_MEDIA_RUNS
      || !isNonNegativeInteger(value.budget.consumedMediaRuns)
      || !isNonNegativeInteger(value.budget.remainingMediaRuns)
      || value.budget.consumedMediaRuns + value.budget.remainingMediaRuns !== value.budget.maxMediaRuns
      || ('maxDurationMs' in value.budget && (
        !isNonNegativeInteger(value.budget.maxDurationMs)
        || value.budget.maxDurationMs < 1
        || value.budget.maxDurationMs > CANVAS_WORKFLOW_MAX_DURATION_MS
        || !isNonNegativeInteger(value.budget.remainingDurationMs)
        || value.budget.remainingDurationMs > value.budget.maxDurationMs
        || (value.budget.activeStartedAt !== null && !isNonNegativeInteger(value.budget.activeStartedAt))
      ))
      || typeof value.autoResumeAfterAdoption !== 'boolean'
      || (value.cancelRequestedAt !== null && !isNonNegativeInteger(value.cancelRequestedAt))
      || (value.cancelledAt !== null && !isNonNegativeInteger(value.cancelledAt))
      || !isNonNegativeInteger(value.createdAt)
      || !isNonNegativeInteger(value.updatedAt)
      || value.updatedAt < value.createdAt) {
      throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
    }
    const resumeAmendments = 'resumeAmendments' in value && Array.isArray(value.resumeAmendments)
      ? value.resumeAmendments.map((amendment) => {
          if (!hasExactKeys(amendment, [
            'operationId', 'expectedRevision', 'addDurationMs', 'addMediaRuns', 'retryNodeIds',
          ])
            || !isStableId(amendment.operationId)
            || !isNonNegativeInteger(amendment.expectedRevision)
            || !isNonNegativeInteger(amendment.addDurationMs)
            || amendment.addDurationMs > CANVAS_WORKFLOW_MAX_DURATION_EXTENSION_MS
            || !isNonNegativeInteger(amendment.addMediaRuns)
            || amendment.addMediaRuns > CANVAS_WORKFLOW_MAX_MEDIA_RUN_EXTENSION
            || !Array.isArray(amendment.retryNodeIds)
            || amendment.retryNodeIds.length > CANVAS_WORKFLOW_RUN_NODE_LIMIT
            || !amendment.retryNodeIds.every(isStableId)
            || new Set(amendment.retryNodeIds).size !== amendment.retryNodeIds.length) {
            throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
          }
          return {
            operationId: amendment.operationId,
            expectedRevision: amendment.expectedRevision,
            addDurationMs: amendment.addDurationMs,
            addMediaRuns: amendment.addMediaRuns,
            retryNodeIds: [...amendment.retryNodeIds],
          }
        })
      : []
    if (resumeAmendments.length > CANVAS_WORKFLOW_RESUME_AMENDMENT_LIMIT
      || new Set(resumeAmendments.map((amendment) => amendment.operationId)).size !== resumeAmendments.length) {
      throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
    }
    const nodes = value.nodes.map(parseNode)
    const nodeIds = new Set(nodes.map((node) => node.nodeId))
    if (nodeIds.size !== nodes.length
      || value.rootNodeIds.some((nodeId) => !nodeIds.has(nodeId))
      || nodes.some((node) => node.dependencyNodeIds.some((nodeId) => !nodeIds.has(nodeId)))) {
      throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
    }
    /** Kahn 扫描证明持久依赖仍为 DAG，恢复时无需相信磁盘顺序。 */
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
      for (const downstreamId of downstream.get(nodeId) ?? []) {
        const next = (indegree.get(downstreamId) ?? 0) - 1
        indegree.set(downstreamId, next)
        if (next === 0) ready.push(downstreamId)
      }
    }
    if (visited !== nodes.length
      || (value.status === 'cancelled') !== (value.cancelledAt !== null)
      || (value.cancelledAt !== null && value.cancelRequestedAt === null)
      || (value.cancelRequestedAt !== null && value.cancelRequestedAt < value.createdAt)
      || (value.cancelledAt !== null && value.cancelledAt < value.cancelRequestedAt!)) {
      throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
    }
    return {
      schemaVersion: 1,
      id: value.id,
      revision: value.revision,
      projectId: value.projectId,
      canvasId: value.canvasId,
      operationId: value.operationId,
      owner: { sessionId: value.owner.sessionId, runStartedAt: value.owner.runStartedAt },
      status: value.status as CanvasWorkflowRunStatus,
      initialCanvasRevision: value.initialCanvasRevision,
      observedCanvasRevision: value.observedCanvasRevision,
      rootNodeIds: [...value.rootNodeIds],
      goal: value.goal,
      nodes,
      budget: {
        maxMediaRuns: value.budget.maxMediaRuns,
        consumedMediaRuns: value.budget.consumedMediaRuns,
        remainingMediaRuns: value.budget.remainingMediaRuns,
        maxDurationMs: 'maxDurationMs' in value.budget
          ? value.budget.maxDurationMs as number
          : CANVAS_WORKFLOW_RUN_DURATION_MS,
        remainingDurationMs: 'remainingDurationMs' in value.budget
          ? value.budget.remainingDurationMs as number
          : CANVAS_WORKFLOW_RUN_DURATION_MS,
        activeStartedAt: 'activeStartedAt' in value.budget
          ? value.budget.activeStartedAt as number | null
          : value.status === 'running' ? value.updatedAt as number : null,
      },
      resumeAmendments,
      autoResumeAfterAdoption: value.autoResumeAfterAdoption,
      cancelRequestedAt: value.cancelRequestedAt,
      cancelledAt: value.cancelledAt,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
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
    projectId: value.projectId,
    canvasId: value.canvasId,
    sessionId: value.sessionId,
    runId: value.runId,
  }
}

/** 严格解析工作流历史分页输入。 */
export function parseCanvasWorkflowRunListInput(value: unknown): CanvasWorkflowRunListInput {
  const keys = Object.keys(isRecord(value) ? value : {})
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
    projectId: value.projectId,
    canvasId: value.canvasId,
    runId: value.runId,
    revision: value.revision,
  }
}
