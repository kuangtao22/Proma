import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  CANVAS_WORKFLOW_RUN_DURATION_MS,
  CANVAS_WORKFLOW_MAX_DURATION_EXTENSION_MS,
  CANVAS_WORKFLOW_MAX_DURATION_MS,
  CANVAS_WORKFLOW_MAX_MEDIA_RUN_EXTENSION,
  CANVAS_WORKFLOW_MAX_MEDIA_RUNS,
  CANVAS_WORKFLOW_RESUME_AMENDMENT_LIMIT,
  CANVAS_WORKFLOW_RETRY_HISTORY_LIMIT,
  CANVAS_WORKFLOW_RUN_NODE_LIMIT,
  parseCanvasWorkflowRun,
} from '@proma/shared'
import type {
  CanvasTarget,
  CanvasWorkflowRun,
  CanvasWorkflowRunNode,
  CanvasWorkflowRunOwner,
  CanvasWorkflowResumeAmendment,
} from '@proma/shared'
import { ensureDirectoryDurable, writeJsonFileAtomicSecure } from '../safe-file'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readMediaJsonFile } from '../media/media-json-file'
import type { DesignPathResolver } from './design-paths'

/** 单个 workflow run journal 的最大字节数。 */
const MAX_WORKFLOW_RUN_BYTES = 512 * 1024
/** 单个 Canvas 最多枚举的历史 workflow run 数。 */
const MAX_WORKFLOW_RUN_FILES = 512
/** workflow run 正式文件名白名单。 */
const WORKFLOW_RUN_FILE_PATTERN = /^workflow-run-([a-f0-9]{48})\.json$/

/** 创建 workflow run 时已由 planner 固定的不可变事实。 */
export interface CreateCanvasWorkflowRunInput extends CanvasTarget {
  operationId: string
  owner: CanvasWorkflowRunOwner
  initialCanvasRevision: number
  rootNodeIds: string[]
  goal: string
  nodes: CanvasWorkflowRunNode[]
  maxMediaRuns: number
  consumedMediaRuns: number
  /** 新运行持久化的总执行时长；缺省保持十五分钟兼容值。 */
  maxDurationMs?: number
  autoResumeAfterAdoption: boolean
}

/** workflow run store 只管理持久运行事实，不读取或改写 Canvas 文档。 */
export interface CanvasWorkflowRunStore {
  create: (input: CreateCanvasWorkflowRunInput) => CanvasWorkflowRun
  get: (target: CanvasTarget, runId: string) => CanvasWorkflowRun
  findByOperation: (target: CanvasTarget, operationId: string) => CanvasWorkflowRun | null
  list: (target: CanvasTarget) => CanvasWorkflowRun[]
  save: (run: CanvasWorkflowRun, expectedRevision: number) => CanvasWorkflowRun
  /** 调度器保存执行进度，并只允许原 operation 的未知提交补齐权威远端标识。 */
  saveExecutionProgress: (run: CanvasWorkflowRun, expectedRevision: number) => CanvasWorkflowRun
  /** 只追加 Host 创建事务已点名且经 planner 验证的单个动态后继。 */
  saveDynamicSuccessorAmendment: (run: CanvasWorkflowRun, expectedRevision: number) => CanvasWorkflowRun
  /** 仅固化已完成 Agent 为直接上游的未执行媒体节点 handoff。 */
  savePreparedMediaAmendment: (run: CanvasWorkflowRun, expectedRevision: number) => CanvasWorkflowRun
  /** 原子追加恢复预算与失败重试；相同 operation 重放返回既有事实。 */
  amendForResume: (input: CanvasWorkflowResumeAmendmentInput) => CanvasWorkflowRun
}

/** Host 已校验主体后提交的恢复 amendment。 */
export interface CanvasWorkflowResumeAmendmentInput extends CanvasTarget {
  runId: string
  expectedRevision: number
  operationId: string
  addDurationMs: number
  addMediaRuns: number
  retryNodeIds: string[]
}

/** Store 生产依赖，路径和 workspace lease 均由 Host 注入。 */
export interface CanvasWorkflowRunStoreDependencies {
  pathResolver: Pick<DesignPathResolver, 'resolveCanvas'>
  runWorkspaceWrite: <T>(projectId: string, effect: () => T) => T
  /** journal 成功提交后的进程内通知；异常不得反转已落盘事实。 */
  onChanged?: (run: CanvasWorkflowRun) => void
  now?: () => number
}

/** 为同一 Canvas operation 派生稳定且不可枚举业务正文的 run ID。 */
export function createCanvasWorkflowRunId(
  projectId: string,
  canvasId: string,
  operationId: string,
): string {
  return createHash('sha256').update(JSON.stringify([
    'canvas-workflow-run', projectId, canvasId, operationId,
  ])).digest('hex').slice(0, 48)
}

/** 投影普通推进不得修改的授权与计划事实，可限制到首次计划节点前缀。 */
function immutableCreateFacts(run: CanvasWorkflowRun, nodeCount = run.nodes.length): object {
  return {
    projectId: run.projectId,
    canvasId: run.canvasId,
    operationId: run.operationId,
    owner: run.owner,
    initialCanvasRevision: run.initialCanvasRevision,
    rootNodeIds: run.rootNodeIds,
    goal: run.goal,
    nodes: run.nodes.slice(0, nodeCount).map((node) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      identityHash: node.identityHash,
      plannedArtifactHash: node.plannedArtifactHash,
      mediaConfigRevision: node.mediaConfigRevision,
      inputBindings: node.inputBindings.map((binding) => ({
        targetInputKey: binding.targetInputKey,
        requiredKind: binding.requiredKind,
        sourceNodeId: binding.sourceNodeId,
        sourceOutputKey: binding.sourceOutputKey,
      })),
      dependencyNodeIds: node.dependencyNodeIds,
    })),
    maxMediaRuns: run.budget.maxMediaRuns,
    maxDurationMs: run.budget.maxDurationMs,
    autoResumeAfterAdoption: run.autoResumeAfterAdoption,
  }
}

/** 动态后继专用保存只允许追加一个节点并推进已观察图 revision。 */
function assertDynamicSuccessorAmendment(current: CanvasWorkflowRun, next: CanvasWorkflowRun): void {
  if (next.nodes.length !== current.nodes.length + 1
    || next.observedCanvasRevision < current.observedCanvasRevision) {
    throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_AMENDMENT_INVALID')
  }
  for (let index = 0; index < current.nodes.length; index += 1) {
    if (JSON.stringify(next.nodes[index]) !== JSON.stringify(current.nodes[index])) {
      throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_AMENDMENT_INVALID')
    }
  }
  const appended = next.nodes.at(-1)!
  const currentNodeIds = new Set(current.nodes.map((node) => node.nodeId))
  if (currentNodeIds.has(appended.nodeId)
    || appended.dependencyNodeIds.some((nodeId) => !currentNodeIds.has(nodeId))) {
    throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_AMENDMENT_INVALID')
  }
  const normalized = structuredClone(next)
  normalized.nodes = structuredClone(current.nodes)
  normalized.observedCanvasRevision = current.observedCanvasRevision
  if (appended.status === 'blocked' && current.status === 'running' && next.status === 'partial') {
    normalized.status = current.status
  }
  if (JSON.stringify(normalized) !== JSON.stringify(current)) {
    throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_AMENDMENT_INVALID')
  }
}

/** 受控 handoff 只允许把未执行媒体节点的配置、输入与 ready 状态固化到原计划。 */
function assertPreparedMediaAmendment(current: CanvasWorkflowRun, next: CanvasWorkflowRun): void {
  const normalized = structuredClone(next)
  let amendedCount = 0
  for (let index = 0; index < current.nodes.length; index += 1) {
    const currentNode = current.nodes[index]!
    const nextNode = normalized.nodes[index]
    if (!nextNode || currentNode.nodeId !== nextNode.nodeId) throw new Error('CANVAS_WORKFLOW_MEDIA_AMENDMENT_INVALID')
    if (JSON.stringify(currentNode) === JSON.stringify(nextNode)) continue
    const normalizedNode = structuredClone(nextNode)
    normalizedNode.mediaConfigRevision = currentNode.mediaConfigRevision
    normalizedNode.inputBindings = structuredClone(currentNode.inputBindings)
    normalizedNode.status = currentNode.status
    normalizedNode.errorCode = currentNode.errorCode
    const completedAgentDependency = currentNode.dependencyNodeIds.some((nodeId) => {
      const dependency = current.nodes.find((node) => node.nodeId === nodeId)
      return dependency?.kind === 'agent' && dependency.status === 'completed'
    })
    if ((currentNode.kind !== 'audio' && currentNode.kind !== 'video')
      || nextNode.kind !== currentNode.kind || currentNode.execution !== null || nextNode.execution !== null
      || !['blocked', 'ready'].includes(currentNode.status) || nextNode.status !== 'ready' || nextNode.errorCode !== null
      || !Number.isSafeInteger(nextNode.mediaConfigRevision) || Number(nextNode.mediaConfigRevision) < 0
      || !completedAgentDependency
      || nextNode.inputBindings.some((binding) => binding.resolvedValueHash === null
        || (binding.sourceNodeId !== null && (!currentNode.dependencyNodeIds.includes(binding.sourceNodeId)
          || binding.sourceArtifactHash === null)))
      || JSON.stringify(normalizedNode) !== JSON.stringify(currentNode)) {
      throw new Error('CANVAS_WORKFLOW_MEDIA_AMENDMENT_INVALID')
    }
    normalized.nodes[index] = structuredClone(currentNode)
    amendedCount += 1
  }
  if (amendedCount === 0 || JSON.stringify(normalized) !== JSON.stringify(current)) {
    throw new Error('CANVAS_WORKFLOW_MEDIA_AMENDMENT_INVALID')
  }
}

/** 判断未知提交是否已由同一 operation 的权威远端标识完成对账。 */
function isResolvedUnknownSubmission(
  currentNode: CanvasWorkflowRunNode,
  nextNode: CanvasWorkflowRunNode,
): boolean {
  const currentExecution = currentNode.execution
  const nextExecution = nextNode.execution
  if (currentNode.retryDisposition !== 'submission-unknown'
    || (nextNode.retryDisposition !== 'none' && nextNode.retryDisposition !== 'terminal-failed')
    || !currentExecution || !nextExecution
    || currentExecution.kind !== nextExecution.kind
    || currentExecution.operationId !== nextExecution.operationId) return false
  const hasRemoteIdentity = nextExecution.kind === 'image'
    ? nextExecution.batchId !== null && nextExecution.taskId !== null
    : nextExecution.kind === 'media'
      ? nextExecution.mediaRunId !== null
      : false
  return hasRemoteIdentity && (nextNode.retryDisposition === 'terminal-failed') === (nextNode.status === 'failed')
}

/** 校验普通执行推进；恢复专用入口只额外接受原 operation 的未知提交对账。 */
function assertExecutionProgress(
  current: CanvasWorkflowRun,
  next: CanvasWorkflowRun,
  allowResolvedUnknownSubmission: boolean,
): void {
  if (JSON.stringify(immutableCreateFacts(current)) !== JSON.stringify(immutableCreateFacts(next))) {
    throw new Error('CANVAS_WORKFLOW_RUN_IMMUTABLE')
  }
  if (JSON.stringify(current.resumeAmendments ?? []) !== JSON.stringify(next.resumeAmendments ?? [])) {
    throw new Error('CANVAS_WORKFLOW_RUN_RESUME_HISTORY_IMMUTABLE')
  }
  if (next.budget.consumedMediaRuns < current.budget.consumedMediaRuns
    || next.budget.remainingMediaRuns > current.budget.remainingMediaRuns
    || next.budget.remainingDurationMs > current.budget.remainingDurationMs) {
    throw new Error('CANVAS_WORKFLOW_RUN_BUDGET_IMMUTABLE')
  }
  const currentActiveAt = current.budget.activeStartedAt
  const nextActiveAt = next.budget.activeStartedAt
  /** 起点向后移动时必须同步扣除完整间隔；向前校时只会更保守地消耗预算。 */
  const movedActiveClockForwardWithoutDebit = currentActiveAt !== null
    && nextActiveAt !== null
    && nextActiveAt > currentActiveAt
    && next.budget.remainingDurationMs > Math.max(
      0,
      current.budget.remainingDurationMs - (nextActiveAt - currentActiveAt),
    )
  if (movedActiveClockForwardWithoutDebit
    || (currentActiveAt === null && nextActiveAt !== null && next.status !== 'running')) {
    throw new Error('CANVAS_WORKFLOW_RUN_BUDGET_CLOCK_INVALID')
  }
  for (const currentNode of current.nodes) {
    const nextNode = next.nodes.find((node) => node.nodeId === currentNode.nodeId)!
    if (JSON.stringify(currentNode.executionHistory ?? [])
      !== JSON.stringify(nextNode.executionHistory ?? [])) {
      throw new Error('CANVAS_WORKFLOW_RUN_EXECUTION_HISTORY_IMMUTABLE')
    }
    if (currentNode.retryDisposition !== 'none'
      && currentNode.retryDisposition !== nextNode.retryDisposition
      && !(allowResolvedUnknownSubmission && isResolvedUnknownSubmission(currentNode, nextNode))) {
      throw new Error('CANVAS_WORKFLOW_RUN_RETRY_FACT_IMMUTABLE')
    }
    for (const currentBinding of currentNode.inputBindings) {
      const nextBinding = nextNode.inputBindings.find((binding) => (
        binding.targetInputKey === currentBinding.targetInputKey
      ))!
      if ((currentBinding.sourceArtifactHash !== null
          && currentBinding.sourceArtifactHash !== nextBinding.sourceArtifactHash)
        || (currentBinding.resolvedValueHash !== null
          && currentBinding.resolvedValueHash !== nextBinding.resolvedValueHash)) {
        throw new Error('CANVAS_WORKFLOW_RUN_INPUT_IMMUTABLE')
      }
    }
  }
}

/** 在隔离副本上应用有界恢复操作，未知付费提交一律拒绝创建新 operation。 */
function applyResumeAmendment(
  current: CanvasWorkflowRun,
  input: CanvasWorkflowResumeAmendmentInput,
): CanvasWorkflowRun {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(input.operationId)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || !Number.isSafeInteger(input.addDurationMs) || input.addDurationMs < 0
    || input.addDurationMs > CANVAS_WORKFLOW_MAX_DURATION_EXTENSION_MS
    || !Number.isSafeInteger(input.addMediaRuns) || input.addMediaRuns < 0
    || input.addMediaRuns > CANVAS_WORKFLOW_MAX_MEDIA_RUN_EXTENSION
    || !Array.isArray(input.retryNodeIds)
    || input.retryNodeIds.length > CANVAS_WORKFLOW_RUN_NODE_LIMIT
    || !input.retryNodeIds.every((nodeId) => /^[A-Za-z0-9_-]{1,160}$/.test(nodeId))
    || new Set(input.retryNodeIds).size !== input.retryNodeIds.length
    || (input.addDurationMs === 0 && input.addMediaRuns === 0 && input.retryNodeIds.length === 0)) {
    throw new Error('CANVAS_WORKFLOW_RESUME_AMENDMENT_INVALID')
  }
  if (current.status === 'completed' || current.status === 'cancelled'
    || current.cancelRequestedAt !== null) {
    throw new Error('CANVAS_WORKFLOW_RUN_CLOSED')
  }
  const next = structuredClone(current)
  const amendments = next.resumeAmendments ?? []
  if (amendments.length >= CANVAS_WORKFLOW_RESUME_AMENDMENT_LIMIT) {
    throw new Error('CANVAS_WORKFLOW_RESUME_LIMIT_EXCEEDED')
  }
  if (next.budget.maxDurationMs + input.addDurationMs > CANVAS_WORKFLOW_MAX_DURATION_MS
    || next.budget.maxMediaRuns + input.addMediaRuns > CANVAS_WORKFLOW_MAX_MEDIA_RUNS) {
    throw new Error('CANVAS_WORKFLOW_BUDGET_LIMIT_EXCEEDED')
  }
  next.budget.maxDurationMs += input.addDurationMs
  next.budget.remainingDurationMs += input.addDurationMs
  next.budget.maxMediaRuns += input.addMediaRuns
  next.budget.remainingMediaRuns += input.addMediaRuns
  if (input.addMediaRuns > 0) {
    for (const node of next.nodes) {
      if (node.status === 'waiting-approval') node.status = 'ready'
    }
  }
  for (const nodeId of input.retryNodeIds) {
    const node = next.nodes.find((candidate) => candidate.nodeId === nodeId)
    if (!node || node.status !== 'failed') throw new Error('CANVAS_WORKFLOW_RETRY_NODE_INVALID')
    const history = node.executionHistory ?? []
    if (history.length >= CANVAS_WORKFLOW_RETRY_HISTORY_LIMIT) {
      throw new Error('CANVAS_WORKFLOW_RETRY_LIMIT_EXCEEDED')
    }
    if ((node.kind === 'image' || node.kind === 'audio' || node.kind === 'video')
      && node.execution !== null && node.retryDisposition !== 'terminal-failed') {
      throw new Error('CANVAS_WORKFLOW_RETRY_SUBMISSION_UNKNOWN')
    }
    if ((node.execution?.kind === 'image'
        && (node.execution.batchId === null || node.execution.taskId === null))
      || (node.execution?.kind === 'media' && node.execution.mediaRunId === null)) {
      throw new Error('CANVAS_WORKFLOW_RETRY_SUBMISSION_UNKNOWN')
    }
    if (node.execution) history.push(structuredClone(node.execution))
    node.executionHistory = history
    node.execution = null
    node.retryDisposition = 'none'
    node.status = 'ready'
    node.errorCode = null
    node.completedArtifactHash = null
    node.completedAt = null
  }
  const amendment: CanvasWorkflowResumeAmendment = {
    operationId: input.operationId,
    expectedRevision: input.expectedRevision,
    addDurationMs: input.addDurationMs,
    addMediaRuns: input.addMediaRuns,
    retryNodeIds: [...input.retryNodeIds],
  }
  next.resumeAmendments = [...amendments, amendment]
  if (next.status === 'waiting-budget' || input.retryNodeIds.length > 0 || input.addMediaRuns > 0) {
    next.status = 'running'
  }
  return next
}

/** 创建本地优先、带跨进程 CAS 的 workflow run store。 */
export function createCanvasWorkflowRunStore(
  dependencies: CanvasWorkflowRunStoreDependencies,
): CanvasWorkflowRunStore {
  const now = dependencies.now ?? Date.now

  /** 文件锁与 workspace lease 释放后，以隔离副本发送 best-effort 状态通知。 */
  const notifyChanged = (run: CanvasWorkflowRun): void => {
    try {
      dependencies.onChanged?.(structuredClone(run))
    } catch {
      /** 观察者只负责唤醒协调，不得影响权威 journal 的提交结果。 */
    }
  }

  /** 返回并按需创建实际 workflow run 目录，拒绝 symlink。 */
  const directory = (target: CanvasTarget, create = false): string => {
    const transactionsDir = dependencies.pathResolver.resolveCanvas(
      target.projectId, target.canvasId,
    ).transactionsDir
    if (!existsSync(transactionsDir)) {
      if (!create) return join(transactionsDir, 'workflow-runs')
      ensureDirectoryDurable(transactionsDir)
    }
    if (!lstatSync(transactionsDir).isDirectory()) {
      throw new Error('CANVAS_WORKFLOW_RUN_PATH_INVALID')
    }
    const result = join(transactionsDir, 'workflow-runs')
    if (!existsSync(result)) {
      if (!create) return result
      ensureDirectoryDurable(result)
    }
    if (!lstatSync(result).isDirectory()) throw new Error('CANVAS_WORKFLOW_RUN_PATH_INVALID')
    return result
  }

  /** 从安全普通文件读取并复核目标归属。 */
  const load = (target: CanvasTarget, runId: string): CanvasWorkflowRun => {
    if (!/^[a-f0-9]{48}$/.test(runId)) throw new Error('CANVAS_WORKFLOW_RUN_ID_INVALID')
    const value = parseCanvasWorkflowRun(readMediaJsonFile(
      join(directory(target), `workflow-run-${runId}.json`),
      MAX_WORKFLOW_RUN_BYTES,
    ))
    if (value.id !== runId
      || value.projectId !== target.projectId
      || value.canvasId !== target.canvasId) {
      throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
    }
    return value
  }

  const store: CanvasWorkflowRunStore = {
    create(input) {
      const result = dependencies.runWorkspaceWrite(input.projectId, () => {
        const runId = createCanvasWorkflowRunId(input.projectId, input.canvasId, input.operationId)
        const runDirectory = directory(input, true)
        const release = acquireMediaFileLock(join(runDirectory, `workflow-run-${runId}.lock`))
        try {
          const path = join(runDirectory, `workflow-run-${runId}.json`)
          if (existsSync(path)) {
            const existing = load(input, runId)
            const proposedFacts = {
              projectId: input.projectId,
              canvasId: input.canvasId,
              operationId: input.operationId,
              owner: input.owner,
              initialCanvasRevision: input.initialCanvasRevision,
              rootNodeIds: input.rootNodeIds,
              goal: input.goal,
              nodes: input.nodes.map((node) => ({
                nodeId: node.nodeId,
                kind: node.kind,
                identityHash: node.identityHash,
                plannedArtifactHash: node.plannedArtifactHash,
                mediaConfigRevision: node.mediaConfigRevision,
                inputBindings: node.inputBindings.map((binding) => ({
                  targetInputKey: binding.targetInputKey,
                  requiredKind: binding.requiredKind,
                  sourceNodeId: binding.sourceNodeId,
                  sourceOutputKey: binding.sourceOutputKey,
                })),
                dependencyNodeIds: node.dependencyNodeIds,
              })),
              maxMediaRuns: input.maxMediaRuns,
              maxDurationMs: input.maxDurationMs ?? CANVAS_WORKFLOW_RUN_DURATION_MS,
              autoResumeAfterAdoption: input.autoResumeAfterAdoption,
            }
            if (existing.nodes.length < input.nodes.length
              || JSON.stringify(immutableCreateFacts(existing, input.nodes.length)) !== JSON.stringify(proposedFacts)) {
              throw new Error('CANVAS_WORKFLOW_OPERATION_CONFLICT')
            }
            return existing
          }
          const timestamp = now()
          const run = parseCanvasWorkflowRun({
            schemaVersion: 1,
            id: runId,
            revision: 0,
            projectId: input.projectId,
            canvasId: input.canvasId,
            operationId: input.operationId,
            owner: input.owner,
            status: 'running',
            initialCanvasRevision: input.initialCanvasRevision,
            observedCanvasRevision: input.initialCanvasRevision,
            rootNodeIds: input.rootNodeIds,
            goal: input.goal,
            nodes: input.nodes,
            budget: {
              maxMediaRuns: input.maxMediaRuns,
              consumedMediaRuns: input.consumedMediaRuns,
              remainingMediaRuns: input.maxMediaRuns - input.consumedMediaRuns,
              maxDurationMs: input.maxDurationMs ?? CANVAS_WORKFLOW_RUN_DURATION_MS,
              remainingDurationMs: input.maxDurationMs ?? CANVAS_WORKFLOW_RUN_DURATION_MS,
              activeStartedAt: timestamp,
            },
            resumeAmendments: [],
            autoResumeAfterAdoption: input.autoResumeAfterAdoption,
            cancelRequestedAt: null,
            cancelledAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          writeJsonFileAtomicSecure(path, run)
          return structuredClone(run)
        } finally {
          release()
        }
      })
      notifyChanged(result)
      return result
    },

    get(target, runId) {
      try {
        return structuredClone(load(target, runId))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('CANVAS_WORKFLOW_RUN_NOT_FOUND')
        }
        throw error
      }
    },

    findByOperation(target, operationId) {
      const runId = createCanvasWorkflowRunId(target.projectId, target.canvasId, operationId)
      try {
        return store.get(target, runId)
      } catch (error) {
        if (error instanceof Error && error.message === 'CANVAS_WORKFLOW_RUN_NOT_FOUND') return null
        throw error
      }
    },

    list(target) {
      const runDirectory = directory(target)
      if (!existsSync(runDirectory)) return []
      const fileNames = readdirSync(runDirectory)
        .filter((fileName) => WORKFLOW_RUN_FILE_PATTERN.test(fileName))
      if (fileNames.length > MAX_WORKFLOW_RUN_FILES) {
        throw new Error('CANVAS_WORKFLOW_RUN_LIST_LIMIT_EXCEEDED')
      }
      return fileNames.map((fileName) => {
        const runId = WORKFLOW_RUN_FILE_PATTERN.exec(fileName)?.[1]
        if (!runId) throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
        return load(target, runId)
      }).sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
        .map((run) => structuredClone(run))
    },

    save(run, expectedRevision) {
      const result = dependencies.runWorkspaceWrite(run.projectId, () => {
        const target = { projectId: run.projectId, canvasId: run.canvasId }
        const runDirectory = directory(target, true)
        const release = acquireMediaFileLock(join(runDirectory, `workflow-run-${run.id}.lock`))
        try {
          const current = load(target, run.id)
          const timestamp = now()
          if (current.revision !== expectedRevision || run.revision !== expectedRevision) {
            throw new Error('CANVAS_WORKFLOW_RUN_CONFLICT')
          }
          assertExecutionProgress(current, run, false)
          const saved = parseCanvasWorkflowRun({
            ...run,
            revision: expectedRevision + 1,
            updatedAt: Math.max(timestamp, current.updatedAt),
          })
          writeJsonFileAtomicSecure(
            join(runDirectory, `workflow-run-${run.id}.json`),
            saved,
          )
          return structuredClone(saved)
        } finally {
          release()
        }
      })
      notifyChanged(result)
      return result
    },

    saveExecutionProgress(run, expectedRevision) {
      const result = dependencies.runWorkspaceWrite(run.projectId, () => {
        const target = { projectId: run.projectId, canvasId: run.canvasId }
        const runDirectory = directory(target, true)
        const release = acquireMediaFileLock(join(runDirectory, `workflow-run-${run.id}.lock`))
        try {
          const current = load(target, run.id)
          if (current.revision !== expectedRevision || run.revision !== expectedRevision) {
            throw new Error('CANVAS_WORKFLOW_RUN_CONFLICT')
          }
          assertExecutionProgress(current, run, true)
          const saved = parseCanvasWorkflowRun({
            ...run,
            revision: expectedRevision + 1,
            updatedAt: Math.max(now(), current.updatedAt),
          })
          writeJsonFileAtomicSecure(join(runDirectory, `workflow-run-${run.id}.json`), saved)
          return structuredClone(saved)
        } finally {
          release()
        }
      })
      notifyChanged(result)
      return result
    },

    saveDynamicSuccessorAmendment(run, expectedRevision) {
      const result = dependencies.runWorkspaceWrite(run.projectId, () => {
        const target = { projectId: run.projectId, canvasId: run.canvasId }
        const runDirectory = directory(target, true)
        const release = acquireMediaFileLock(join(runDirectory, `workflow-run-${run.id}.lock`))
        try {
          const current = load(target, run.id)
          if (current.revision !== expectedRevision || run.revision !== expectedRevision) {
            throw new Error('CANVAS_WORKFLOW_RUN_CONFLICT')
          }
          assertDynamicSuccessorAmendment(current, run)
          const saved = parseCanvasWorkflowRun({
            ...run,
            revision: expectedRevision + 1,
            updatedAt: Math.max(now(), current.updatedAt),
          })
          writeJsonFileAtomicSecure(join(runDirectory, `workflow-run-${run.id}.json`), saved)
          return structuredClone(saved)
        } finally {
          release()
        }
      })
      notifyChanged(result)
      return result
    },

    savePreparedMediaAmendment(run, expectedRevision) {
      const result = dependencies.runWorkspaceWrite(run.projectId, () => {
        const target = { projectId: run.projectId, canvasId: run.canvasId }
        const runDirectory = directory(target, true)
        const release = acquireMediaFileLock(join(runDirectory, `workflow-run-${run.id}.lock`))
        try {
          const current = load(target, run.id)
          if (current.revision !== expectedRevision || run.revision !== expectedRevision) {
            throw new Error('CANVAS_WORKFLOW_RUN_CONFLICT')
          }
          assertPreparedMediaAmendment(current, run)
          const saved = parseCanvasWorkflowRun({
            ...run,
            revision: expectedRevision + 1,
            updatedAt: Math.max(now(), current.updatedAt),
          })
          writeJsonFileAtomicSecure(join(runDirectory, `workflow-run-${run.id}.json`), saved)
          return structuredClone(saved)
        } finally {
          release()
        }
      })
      notifyChanged(result)
      return result
    },

    amendForResume(input) {
      const outcome = dependencies.runWorkspaceWrite(input.projectId, () => {
        const target = { projectId: input.projectId, canvasId: input.canvasId }
        const runDirectory = directory(target, true)
        const release = acquireMediaFileLock(join(runDirectory, `workflow-run-${input.runId}.lock`))
        try {
          const current = load(target, input.runId)
          const existing = (current.resumeAmendments ?? []).find((candidate) => (
            candidate.operationId === input.operationId
          ))
          if (existing) {
            const replay = {
              operationId: input.operationId,
              expectedRevision: input.expectedRevision,
              addDurationMs: input.addDurationMs,
              addMediaRuns: input.addMediaRuns,
              retryNodeIds: input.retryNodeIds,
            }
            if (JSON.stringify(existing) !== JSON.stringify(replay)) {
              throw new Error('CANVAS_WORKFLOW_RESUME_OPERATION_CONFLICT')
            }
            return { run: structuredClone(current), changed: false }
          }
          if (current.revision !== input.expectedRevision) {
            throw new Error('CANVAS_WORKFLOW_RUN_CONFLICT')
          }
          const amended = applyResumeAmendment(current, input)
          const saved = parseCanvasWorkflowRun({
            ...amended,
            revision: current.revision + 1,
            updatedAt: Math.max(now(), current.updatedAt),
          })
          writeJsonFileAtomicSecure(join(runDirectory, `workflow-run-${input.runId}.json`), saved)
          return { run: structuredClone(saved), changed: true }
        } finally {
          release()
        }
      })
      if (outcome.changed) notifyChanged(outcome.run)
      return outcome.run
    },
  }
  return store
}
