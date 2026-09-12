import type { DesignJobRecord, DesignJobStatus, DesignTraceEntry } from '@proma/shared'
import { isDeepStrictEqual } from 'node:util'
import type { CanvasImageCandidateBatchService } from './canvas-image-candidate-batch-service'
import { createImageJobId } from './canvas-image-run-service'
import type { CanvasWorkflowRunStore } from './canvas-workflow-run-store'
import type { DesignJobManager } from './design-job-manager'
import type { DesignTracePage, DesignTraceStore } from './design-trace-store'

/** 单次任务操作响应的最大 JSON 字节数。 */
const TASK_RESPONSE_MAX_BYTES = 64 * 1024
/** 单页最大尝试数量。 */
const TASK_ATTEMPT_PAGE_LIMIT = 50
/** 给完整详情字段预留空间后的日志读取预算。 */
const TASK_LOG_PAGE_MAX_BYTES = 48 * 1024
/** 日志页元数据、JSON 键名和游标的固定安全余量。 */
const TASK_LOG_RESPONSE_OVERHEAD_BYTES = 512
/** 旧版单图批次使用的 UUID 格式。 */
const SINGLE_IMAGE_BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** 已由外层授权、节点解析和 Canvas 锁确认的精确任务引用。 */
export interface CanvasTaskReference {
  projectId: string
  canvasId: string
  nodeId: string
  imageModuleId: string
  jobId: string
}

/** 详情页可选的尝试和日志游标。 */
export interface CanvasTaskDetailsInput extends CanvasTaskReference {
  attemptCursor?: string
  attemptLimit?: number
  logs?: { cursor?: string; limit?: number }
}

/** 对外仅公开非敏感的实际图片模型事实。 */
export interface CanvasTaskPublicModel {
  name: string
  modelId: string
  executor: 'nano-banana' | 'openai-images' | 'comfyui'
}

/** 任务详情中的单次尝试。 */
export interface CanvasTaskAttempt {
  jobId: string
  attemptNumber: number
  status: DesignJobStatus
  startedAt?: number
  completedAt?: number
  error?: string
}

/** 按需加载的有界日志页。 */
export interface CanvasTaskLogPage extends DesignTracePage {
  entries: DesignTraceEntry[]
}

/** Agent 与 UI 共用的主进程任务详情。 */
export interface CanvasTaskOperationDetails {
  jobId: string
  creativeTaskId: string
  /** 精确候选批次引用供 Agent 发现已有批次，不公开内部会话身份。 */
  batchId?: string
  attemptNumber: number
  status: DesignJobStatus
  traceState: DesignJobRecord['traceState'] | 'unavailable'
  error?: string
  model?: CanvasTaskPublicModel
  finalImagePrompt?: string
  designSummary?: string
  attempts: CanvasTaskAttempt[]
  attemptsNextCursor?: string
  attemptsTruncated: boolean
  logs?: CanvasTaskLogPage
}

/** 取消只确认本地任务状态，不把 stop 等同于供应商确认。 */
export interface CanvasTaskCancelResult {
  jobId: string
  status: DesignJobStatus
  stopRequested: boolean
  remoteCancellation: 'unconfirmed'
}

/** 稳定 operation 对应的重试结果。 */
export interface CanvasTaskRetryResult {
  operationId: string
  originalJobId: string
  replacementJobId: string
  /** 仅本次实际创建 replacement 时为 true，重放不得再次登记工作流回执。 */
  created: boolean
}

/** 任务领域服务只依赖现有权威 Job、候选批次和 trace 边界。 */
export interface CanvasTaskOperationServiceDependencies {
  jobs: Pick<DesignJobManager,
    'getProjectJob' | 'listCanvasImageJobs' | 'cancel' | 'retry' | 'run'>
  candidateBatches: Pick<CanvasImageCandidateBatchService, 'retryJobLocked'>
  traceStore: Pick<DesignTraceStore, 'readPage'>
  /** 低频独立重试检查持久工作流归属，禁止绕过其已消费的媒体预算。 */
  workflowRuns?: Pick<CanvasWorkflowRunStore, 'list'>
  /** 旧任务后台执行失败时写主进程诊断，不把内部错误透传给调用方。 */
  onBackgroundError?: (message: string, error: unknown) => void
}

/** 任务领域服务显式 locked 接口；外层负责授权、权威节点解析和 Canvas 串行锁。 */
export interface CanvasTaskOperationService {
  getTaskLocked(input: CanvasTaskDetailsInput): Promise<CanvasTaskOperationDetails>
  cancelTaskLocked(input: CanvasTaskReference): Promise<CanvasTaskCancelResult>
  retryTaskLocked(input: CanvasTaskReference & { operationId: string }): Promise<CanvasTaskRetryResult>
}

/** 判断任务是否仍可被本地停止。 */
function isActiveStatus(status: DesignJobStatus): boolean {
  return status === 'queued' || status === 'running'
}

/** 按 UTF-8 字节预算截断文本，并保留明确的用户可见标记。 */
function truncatePublicText(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.length <= maxBytes) return value
  const marker = '[已截断]'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  /** UTF-8 单字符最多四字节，向前收缩即可避免保留半个码点。 */
  let prefixBytes = encoded.subarray(0, Math.max(0, maxBytes - markerBytes))
  let prefix = prefixBytes.toString('utf8')
  while (prefix.endsWith('\uFFFD') && prefixBytes.length > 0) {
    prefixBytes = prefixBytes.subarray(0, prefixBytes.length - 1)
    prefix = prefixBytes.toString('utf8')
  }
  return `${prefix}${marker}`
}

/** 隐去可能混入错误、摘要或提示词的本机绝对路径和常见凭据形式。 */
function sanitizePublicText(value: string | undefined, maxBytes = 8 * 1024): string | undefined {
  if (value === undefined) return undefined
  const sanitized = value
    .replace(/\b(api[_-]?key|authorization|access[_-]?token|bearer)\s*[:=]\s*\S+/gi, '$1=[已隐藏]')
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp|var)\/)[^\s"']+/g, '[路径已隐藏]')
  return truncatePublicText(sanitized, maxBytes)
}

/** 解析非负十进制 attempts 游标。 */
function parseAttemptCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^\d+$/.test(cursor)) throw new Error('CANVAS_TASK_CURSOR_INVALID')
  const parsed = Number(cursor)
  if (!Number.isSafeInteger(parsed)) throw new Error('CANVAS_TASK_CURSOR_INVALID')
  return parsed
}

/** 严格解析尝试页大小，领域层不依赖外层 schema 的正确性。 */
function parseAttemptLimit(limit: number | undefined): number {
  if (limit === undefined) return TASK_ATTEMPT_PAGE_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TASK_ATTEMPT_PAGE_LIMIT) {
    throw new Error('CANVAS_TASK_ATTEMPT_LIMIT_INVALID')
  }
  return limit
}

/** 验证稳定 operation ID，避免无限长或控制字符进入日志和返回值。 */
function assertOperationId(operationId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) {
    throw new Error('CANVAS_TASK_OPERATION_ID_INVALID')
  }
}

/** 判断公开 Job 是否精确归属调用方已经解析出的 Canvas 图片目标。 */
function hasExactIdentity(job: DesignJobRecord, input: CanvasTaskReference): boolean {
  const target = job.target
  return job.projectId === input.projectId
    && job.id === input.jobId
    && target?.kind === 'canvas-image'
    && target.canvasId === input.canvasId
    && target.nodeId === input.nodeId
    && target.imageModuleId === input.imageModuleId
}

/** 对 trace 条目执行第二层文本脱敏，兼容旧版已落盘内容。 */
function sanitizeTraceEntry(entry: DesignTraceEntry): DesignTraceEntry {
  return {
    timestamp: entry.timestamp,
    type: entry.type,
    title: sanitizePublicText(entry.title, 2 * 1024) ?? '',
    ...(entry.content === undefined ? {} : { content: sanitizePublicText(entry.content) }),
    ...(entry.toolName === undefined ? {} : {
      toolName: sanitizePublicText(entry.toolName, 512) ?? '',
    }),
    ...(entry.isError === undefined ? {} : { isError: entry.isError }),
  }
}

/** 断言最终响应仍符合公共合同；禁止事后丢弃已有 cursor 覆盖的日志。 */
function assertResponseBudget(details: CanvasTaskOperationDetails): CanvasTaskOperationDetails {
  if (Buffer.byteLength(JSON.stringify(details), 'utf8') <= TASK_RESPONSE_MAX_BYTES) return details
  throw new Error('CANVAS_TASK_RESPONSE_TOO_LARGE')
}

/** 判断 replacement 是否完整复用原 attempt 的付费执行快照。 */
function hasSameRetrySnapshot(original: DesignJobRecord, replacement: DesignJobRecord): boolean {
  if (replacement.attemptNumber !== original.attemptNumber + 1) return false
  return isDeepStrictEqual({
    action: replacement.action,
    prompt: replacement.prompt,
    originalRequest: replacement.originalRequest,
    imagePromptContract: replacement.imagePromptContract,
    contextMode: replacement.contextMode,
    generationConstraints: replacement.generationConstraints,
    canvasInputReferences: replacement.canvasInputReferences,
    canvasImageConfigRevision: replacement.canvasImageConfigRevision,
    canvasImageInitialAdoptedAssetId: replacement.canvasImageInitialAdoptedAssetId,
    candidateBatchId: replacement.candidateBatchId,
    sourceAgentMessageId: replacement.sourceAgentMessageId,
    sourceSessionId: replacement.sourceSessionId,
    sourceAssetId: replacement.sourceAssetId,
    imageModelSnapshot: replacement.imageModelSnapshot,
  }, {
    action: original.action,
    prompt: original.prompt,
    originalRequest: original.originalRequest,
    imagePromptContract: original.imagePromptContract,
    contextMode: original.contextMode,
    generationConstraints: original.generationConstraints,
    canvasInputReferences: original.canvasInputReferences,
    canvasImageConfigRevision: original.canvasImageConfigRevision,
    canvasImageInitialAdoptedAssetId: original.canvasImageInitialAdoptedAssetId,
    candidateBatchId: original.candidateBatchId,
    sourceAgentMessageId: original.sourceAgentMessageId,
    sourceSessionId: original.sourceSessionId,
    sourceAssetId: original.sourceAssetId,
    imageModelSnapshot: original.imageModelSnapshot,
  })
}

/** 判断工作流执行身份是否已拥有当前图片任务或其完整创作 attempt 链。 */
function isWorkflowOwnedImageRetry(
  job: DesignJobRecord,
  targetJobs: readonly DesignJobRecord[],
  input: CanvasTaskReference,
  workflowRuns: Pick<CanvasWorkflowRunStore, 'list'> | undefined,
): boolean {
  if (!workflowRuns) return false
  /** 同创作链任务只需构建一次集合，避免每个 workflow execution 重复扫描目标任务。 */
  const creativeTaskJobIds = new Set(targetJobs
    .filter((candidate) => candidate.creativeTaskId === job.creativeTaskId)
    .map((candidate) => candidate.id))
  return workflowRuns.list({ projectId: input.projectId, canvasId: input.canvasId }).some((run) => (
    run.nodes.some((node) => {
      if (node.kind !== 'image' || node.nodeId !== input.nodeId) return false
      const executions = [node.execution, ...(node.executionHistory ?? [])]
      return executions.some((execution) => {
        if (!execution || execution.kind !== 'image') return false
        /** 提交回应丢失时仍可由原 owner 和 operation 精确复原预留 Job ID。 */
        const ownedJobId = execution.taskId ?? createImageJobId(
          run.owner,
          execution.operationId,
          run.canvasId,
          node.nodeId,
        )
        if (ownedJobId === job.id) return true
        /** 重试 replacement 改变 Job ID，但不得脱离原 workflow 的 creativeTask 链。 */
        return creativeTaskJobIds.has(ownedJobId)
      })
    })
  ))
}

/** 创建 UI 与 Agent 共用的纯主进程任务领域服务。 */
export function createCanvasTaskOperationService(
  dependencies: CanvasTaskOperationServiceDependencies,
): CanvasTaskOperationService {
  /** 读取并再次通过目标索引证明任务身份，禁止仅凭跨项目 jobId 操作。 */
  const requireExactJob = (input: CanvasTaskReference): {
    job: DesignJobRecord
    targetJobs: DesignJobRecord[]
  } => {
    const job = dependencies.jobs.getProjectJob(input.projectId, input.jobId)
    if (!job || !hasExactIdentity(job, input)) throw new Error('CANVAS_TASK_IDENTITY_MISMATCH')
    const targetJobs = dependencies.jobs.listCanvasImageJobs(input)
    if (!targetJobs.some((candidate) => candidate.id === job.id && hasExactIdentity(candidate, input))) {
      throw new Error('CANVAS_TASK_IDENTITY_MISMATCH')
    }
    return { job, targetJobs }
  }

  return {
    getTaskLocked: async (input) => {
      const { job, targetJobs } = requireExactJob(input)
      /** 尝试链只从精确目标索引派生，并按 attemptNumber 稳定排序。 */
      const allAttempts = targetJobs
        .filter((candidate) => candidate.creativeTaskId === job.creativeTaskId)
        .sort((left, right) => left.attemptNumber - right.attemptNumber || left.createdAt - right.createdAt)
      const attemptOffset = parseAttemptCursor(input.attemptCursor)
      if (attemptOffset > allAttempts.length) throw new Error('CANVAS_TASK_CURSOR_INVALID')
      const attemptLimit = parseAttemptLimit(input.attemptLimit)
      const attemptPage = allAttempts.slice(attemptOffset, attemptOffset + attemptLimit)
      const attemptsNextOffset = attemptOffset + attemptPage.length
      const details: CanvasTaskOperationDetails = {
        jobId: job.id,
        creativeTaskId: job.creativeTaskId,
        ...(job.candidateBatchId ? { batchId: job.candidateBatchId } : {}),
        attemptNumber: job.attemptNumber,
        status: job.status,
        traceState: job.traceState ?? 'unavailable',
        error: sanitizePublicText(job.error, 4 * 1024),
        ...(job.imageModelSnapshot ? {
          model: {
            name: job.imageModelSnapshot.name,
            modelId: job.imageModelSnapshot.modelId,
            executor: job.imageModelSnapshot.executor,
          },
        } : {}),
        finalImagePrompt: sanitizePublicText(job.finalImagePrompt),
        designSummary: sanitizePublicText(job.designSummary),
        attempts: attemptPage.map((attempt) => ({
          jobId: attempt.id,
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          startedAt: attempt.startedAt,
          completedAt: attempt.completedAt,
          error: sanitizePublicText(attempt.error, 512),
        })),
        ...(attemptsNextOffset < allAttempts.length ? { attemptsNextCursor: String(attemptsNextOffset) } : {}),
        attemptsTruncated: attemptsNextOffset < allAttempts.length,
      }
      /** trace 读取预算由固定详情剩余空间决定，Store 为最终公开条目生成精确 cursor。 */
      if (input.logs && job.traceState === 'ready') {
        const fixedBytes = Buffer.byteLength(JSON.stringify(details), 'utf8')
        const logMaxBytes = Math.min(
          TASK_LOG_PAGE_MAX_BYTES,
          Math.max(256, TASK_RESPONSE_MAX_BYTES - fixedBytes - TASK_LOG_RESPONSE_OVERHEAD_BYTES),
        )
        details.logs = dependencies.traceStore.readPage(input.projectId, input.jobId, {
          cursor: input.logs.cursor,
          limit: Number.isFinite(input.logs.limit)
            ? Math.max(1, Math.min(50, Math.floor(input.logs.limit ?? 50)))
            : 50,
          maxBytes: logMaxBytes,
          transformEntry: sanitizeTraceEntry,
        })
      }
      return assertResponseBudget(details)
    },

    cancelTaskLocked: async (input) => {
      const { job } = requireExactJob(input)
      const stopRequested = isActiveStatus(job.status)
      const result = await dependencies.jobs.cancel(input.projectId, input.jobId)
      if (!hasExactIdentity(result, input)) throw new Error('CANVAS_TASK_IDENTITY_MISMATCH')
      return {
        jobId: result.id,
        status: result.status,
        stopRequested,
        remoteCancellation: 'unconfirmed',
      }
    },

    retryTaskLocked: async (input) => {
      assertOperationId(input.operationId)
      const { job, targetJobs } = requireExactJob(input)
      if (isWorkflowOwnedImageRetry(job, targetJobs, input, dependencies.workflowRuns)) {
        throw new Error('CANVAS_WORKFLOW_TASK_RETRY_REQUIRES_RESUME')
      }
      if (!job.imageModelSnapshot) throw new Error('CANVAS_TASK_RETRY_SNAPSHOT_UNAVAILABLE')
      /** 原 job journal 的 replacedBy 事实会表现为同创作任务的下一 attempt，先查它可恢复响应丢失。 */
      const existingReplacement = targetJobs
        .filter((candidate) => candidate.creativeTaskId === job.creativeTaskId
          && candidate.attemptNumber > job.attemptNumber)
        .sort((left, right) => left.attemptNumber - right.attemptNumber)[0]
      if (existingReplacement && !hasSameRetrySnapshot(job, existingReplacement)) {
        throw new Error('CANVAS_TASK_RETRY_SNAPSHOT_MISMATCH')
      }
      if (existingReplacement && !job.candidateBatchId) {
        /** legacy 响应丢失时再次启动同一 replacement；Manager.run 自身按 Job ID 合并执行。 */
        void dependencies.jobs.run(existingReplacement.id).catch((error: unknown) => {
          dependencies.onBackgroundError?.('[Canvas 任务] 旧任务重试后台执行失败', error)
        })
        return {
          operationId: input.operationId,
          originalJobId: job.id,
          replacementJobId: existingReplacement.id,
          created: false,
        }
      }

      let replacementJobId: string
      if (job.candidateBatchId) {
        /** UUID 单图旧批次缺失时可从原 journal 的固化事实重建失败条目。 */
        const singleBatchRecovery = SINGLE_IMAGE_BATCH_ID.test(job.candidateBatchId)
          && job.canvasImageConfigRevision !== undefined
          ? {
              nodeId: input.nodeId,
              imageModuleId: input.imageModuleId,
              initialAdoptedAssetId: job.canvasImageInitialAdoptedAssetId !== undefined
                ? job.canvasImageInitialAdoptedAssetId : job.sourceAssetId ?? null,
              initialConfigRevision: job.canvasImageConfigRevision,
            }
          : undefined
        try {
          replacementJobId = await dependencies.candidateBatches.retryJobLocked({
            projectId: input.projectId,
            canvasId: input.canvasId,
            nodeId: input.nodeId,
            imageModuleId: input.imageModuleId,
            batchId: job.candidateBatchId,
            jobId: job.id,
            ...(singleBatchRecovery ? { singleBatchRecovery } : {}),
          })
        } catch (error) {
          /** 批次已先提交但响应丢失时，旧 entry 消失；持久化下一 attempt 是唯一可接受结果。 */
          if (!(error instanceof Error)
            || error.message !== 'CANVAS_IMAGE_BATCH_JOB_NOT_FOUND'
            || !existingReplacement) throw error
          replacementJobId = existingReplacement.id
        }
      } else {
        /** candidateBatchId 引入前的旧任务沿用 Manager 原快照重试，并在后台启动。 */
        const replacement = dependencies.jobs.retry(input.projectId, input.jobId)
        replacementJobId = replacement.id
        void dependencies.jobs.run(replacement.id).catch((error: unknown) => {
          dependencies.onBackgroundError?.('[Canvas 任务] 旧任务重试后台执行失败', error)
        })
      }
      return {
        operationId: input.operationId,
        originalJobId: job.id,
        replacementJobId,
        created: existingReplacement === undefined,
      }
    },
  }
}
