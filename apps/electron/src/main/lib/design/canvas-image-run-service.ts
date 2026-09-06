import { createHash } from 'node:crypto'
import type {
  CanvasImageCandidateBatch,
  CanvasImageModuleConfig,
  CanvasImageTarget,
  CanvasNode,
  CanvasRunNodesBatchEntrySummary,
  CanvasRunNodesBatchSummary,
  CanvasRunNodesBatchTerminalSummary,
  CanvasRunNodesResult,
  CanvasTarget,
  CanvasToolNodeRunResult,
  CreateDesignJobInput,
  DesignJobRecord,
} from '@proma/shared'
import type {
  CanvasImageCandidateBatchChangedListener,
  CanvasImageCandidateBatchService,
} from './canvas-image-candidate-batch-service'
import type { DesignJobChangedListener, DesignJobManager } from './design-job-manager'
import { reportCanvasImageDiagnostic } from './canvas-image-diagnostics'
import { isSafeDesignStableId } from './design-paths'
import type { CanvasToolRunContext } from './canvas-tool-provider'

const MAX_IMAGE_RUN_TASKS = 32
const ACTIVE_JOB_STATUSES = new Set<DesignJobRecord['status']>(['queued', 'running'])

/** 等待指定图片批次终态的主进程可信输入。 */
export interface CanvasImageBatchWaitInput extends CanvasTarget {
  batchId: string
  taskIds: readonly string[]
  signal: AbortSignal
  deadlineAt: number
}

/** 取消图片批次任务时必须携带的完整所有权身份。 */
export interface CanvasImageBatchCancelInput extends CanvasTarget {
  batchId: string
  taskIds: readonly string[]
}

/** 图片任务启动确认阶段的可中止边界。 */
export interface CanvasImageRunOptions {
  signal: AbortSignal
  deadlineAt: number
}

/** Canvas 图片运行服务的最小公开合同。 */
export interface CanvasImageRunService {
  run(
    context: CanvasToolRunContext,
    target: CanvasTarget,
    nodes: CanvasNode[],
    operationId: string,
    options?: CanvasImageRunOptions,
  ): Promise<CanvasRunNodesResult>
  awaitBatch(input: CanvasImageBatchWaitInput): Promise<CanvasRunNodesBatchTerminalSummary>
  cancelTasks(input: CanvasImageBatchCancelInput): Promise<void>
}

/** 图片运行服务复用的生产单例依赖。 */
export interface CanvasImageRunServiceDependencies {
  serializer: {
    run: <T>(target: CanvasTarget, effect: () => Promise<T>) => Promise<T>
  }
  guard: {
    runWorkspaceWrite: <T>(projectId: string, effect: () => Promise<T>) => Promise<T>
  }
  imageModules: {
    load: (target: CanvasImageTarget) => Promise<CanvasImageModuleConfig>
  }
  imageJobs: Pick<
    DesignJobManager,
    'preflightCanvasImage' | 'createCanvasImageOnce' | 'rollbackCanvasImageOnce'
    | 'start' | 'cancel' | 'getProjectJob' | 'onChanged'
  >
  candidateBatches: Pick<CanvasImageCandidateBatchService, 'createBatchLocked' | 'load' | 'onChanged'>
  getProjectReadOnlyReason: (projectId: string) => string | undefined
}

/** 比较 Job 是否精确属于目标图片模块。 */
function isOwnedImageJob(job: DesignJobRecord, target: CanvasImageTarget): boolean {
  return job.projectId === target.projectId
    && job.target?.kind === 'canvas-image'
    && job.target.canvasId === target.canvasId
    && job.target.nodeId === target.nodeId
    && job.target.imageModuleId === target.imageModuleId
}

/** 从父运行、工具调用和节点身份派生可重放任务 ID。 */
function createImageJobId(
  context: CanvasToolRunContext,
  operationId: string,
  canvasId: string,
  nodeId: string,
): string {
  /** JSON 数组编码避免不同字段组合发生拼接碰撞。 */
  const digest = createHash('sha256').update(JSON.stringify([
    context.sessionId,
    context.runStartedAt,
    operationId,
    canvasId,
    nodeId,
  ])).digest('hex')
  return `agent-canvas-${digest}`
}

/** 从父运行和工具调用身份派生可重放候选批次 ID。 */
function createImageBatchId(
  context: CanvasToolRunContext,
  operationId: string,
  canvasId: string,
): string {
  /** 固定域分隔符防止批次身份与节点任务身份碰撞。 */
  const digest = createHash('sha256').update(JSON.stringify([
    context.sessionId,
    context.runStartedAt,
    operationId,
    canvasId,
    'candidate-batch',
  ])).digest('hex')
  return `agent-canvas-${digest}`
}

/** 把未知异常压缩为既有低层工具的稳定文本。 */
function canvasNodeRunError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 配置必须继续绑定请求模块，防止竞态跨模块返回。 */
function assertOwnedImageConfig(config: CanvasImageModuleConfig, target: CanvasImageTarget): void {
  if (config.contentId !== target.imageModuleId) throw new Error('CANVAS_IMAGE_IDENTITY_CONFLICT')
}

/** 把候选批次内部状态规范化为公开聚合状态。 */
function normalizeBatchEntryStatus(
  status: CanvasImageCandidateBatch['entries'][number]['status'],
): CanvasRunNodesBatchEntrySummary['status'] | 'running' {
  if (status === 'candidate' || status === 'adopted') return 'candidate'
  if (status === 'failed') return 'failed'
  if (status === 'queued' || status === 'running') return 'running'
  return 'invalid'
}

/** 从内部候选批次裁剪公开有界摘要。 */
function summarizeBatch(batch: CanvasImageCandidateBatch): CanvasRunNodesBatchSummary {
  const statuses = batch.entries.map((entry) => normalizeBatchEntryStatus(entry.status))
  return {
    batchId: batch.batchId,
    status: batch.status,
    totalCount: batch.entries.length,
    candidateCount: statuses.filter((status) => status === 'candidate').length,
    failedCount: statuses.filter((status) => status === 'failed' || status === 'invalid').length,
    runningCount: statuses.filter((status) => status === 'running').length,
    requiresCanvasReview: true,
  }
}

/** 从权威候选条目生成稳定排序且不含素材或错误正文的终态摘要。 */
function summarizeTerminalBatch(batch: CanvasImageCandidateBatch): CanvasRunNodesBatchTerminalSummary {
  /** 已采用等价于已有候选，明确保留等价于当前版本无新候选。 */
  const entries = batch.entries.map((entry) => ({
    nodeId: entry.nodeId,
    taskId: entry.jobId,
    status: normalizeBatchEntryStatus(entry.status) === 'running'
      ? 'invalid' as const
      : normalizeBatchEntryStatus(entry.status) as CanvasRunNodesBatchEntrySummary['status'],
  })).sort((left, right) => {
    if (left.taskId !== right.taskId) return left.taskId < right.taskId ? -1 : 1
    if (left.nodeId === right.nodeId) return 0
    return left.nodeId < right.nodeId ? -1 : 1
  })
  return { ...summarizeBatch(batch), entries }
}

/** 校验可选启动边界，避免无效 signal 或 deadline 进入任务副作用。 */
function assertRunOptions(options: CanvasImageRunOptions | undefined): void {
  if (options === undefined) return
  if (!(options.signal instanceof AbortSignal)
    || !Number.isSafeInteger(options.deadlineAt)
    || options.deadlineAt < 0) {
    throw new Error('CANVAS_IMAGE_RUN_INPUT_INVALID')
  }
}

/** 在调度器接管前等待异步步骤，同时只用单次 timer 响应中止或绝对期限。 */
async function awaitRunBoundary<T>(promise: Promise<T>, options: CanvasImageRunOptions | undefined): Promise<T> {
  if (!options) return promise
  if (options.signal.aborted) throw new Error('CANVAS_IMAGE_RUN_ABORTED')
  if (Date.now() >= options.deadlineAt) throw new Error('CANVAS_IMAGE_RUN_DEADLINE')
  /** 当前 AbortSignal 临时监听器只覆盖启动确认等待。 */
  let abortListener: (() => void) | undefined
  /** 绝对期限 timer 在任一分支完成后立即清理。 */
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new Error('CANVAS_IMAGE_RUN_ABORTED'))
        options.signal.addEventListener('abort', abortListener, { once: true })
        deadlineTimer = setTimeout(
          () => reject(new Error('CANVAS_IMAGE_RUN_DEADLINE')),
          Math.max(0, options.deadlineAt - Date.now()),
        )
      }),
    ])
  } finally {
    if (abortListener) options.signal.removeEventListener('abort', abortListener)
    if (deadlineTimer) clearTimeout(deadlineTimer)
  }
}

/** 校验主进程等待输入的有界稳定身份。 */
function assertWaitInput(input: CanvasImageBatchWaitInput): void {
  if (!isSafeDesignStableId(input.projectId)
    || !isSafeDesignStableId(input.canvasId)
    || !isSafeDesignStableId(input.batchId)
    || !Array.isArray(input.taskIds)
    || input.taskIds.length === 0
    || input.taskIds.length > MAX_IMAGE_RUN_TASKS
    || new Set(input.taskIds).size !== input.taskIds.length
    || input.taskIds.some((taskId) => !isSafeDesignStableId(taskId))
    || !(input.signal instanceof AbortSignal)
    || !Number.isSafeInteger(input.deadlineAt)
    || input.deadlineAt < 0) {
    throw new Error('CANVAS_IMAGE_BATCH_WAIT_INPUT_INVALID')
  }
}

/** 创建复用唯一 Job Manager、Store 与 Canvas 串行器的图片运行服务。 */
export function createCanvasImageRunService(
  dependencies: CanvasImageRunServiceDependencies,
): CanvasImageRunService {
  /** 读取批次并逐项复核持久化 Job 仍属于同一 Canvas 与批次。 */
  const loadOwnedBatch = async (
    input: Pick<CanvasImageBatchWaitInput, 'projectId' | 'canvasId' | 'batchId' | 'taskIds'>,
  ): Promise<CanvasImageCandidateBatch> => {
    /** 候选服务只返回目标项目与 Canvas 下的指定批次。 */
    const batch = await dependencies.candidateBatches.load({
      projectId: input.projectId,
      canvasId: input.canvasId,
      batchId: input.batchId,
    })
    if (batch.projectId !== input.projectId
      || batch.canvasId !== input.canvasId
      || batch.batchId !== input.batchId
      || batch.entries.length > MAX_IMAGE_RUN_TASKS
      || batch.entries.length !== input.taskIds.length) {
      throw new Error('CANVAS_IMAGE_BATCH_WAIT_OWNERSHIP_INVALID')
    }
    /** 调用方只能等待本次 run 返回的任务；批次不得悄悄扩入其它任务。 */
    const requestedTaskIds = new Set(input.taskIds)
    for (const entry of batch.entries) {
      if (!requestedTaskIds.has(entry.jobId)) throw new Error('CANVAS_IMAGE_BATCH_WAIT_OWNERSHIP_INVALID')
      const job = dependencies.imageJobs.getProjectJob(input.projectId, entry.jobId)
      const imageTarget: CanvasImageTarget = {
        projectId: input.projectId,
        canvasId: input.canvasId,
        nodeId: entry.nodeId,
        imageModuleId: entry.imageModuleId,
      }
      if (!job || job.candidateBatchId !== input.batchId || !isOwnedImageJob(job, imageTarget)) {
        throw new Error('CANVAS_IMAGE_BATCH_WAIT_OWNERSHIP_INVALID')
      }
    }
    return batch
  }

  /** 取消调用方明确持有且仍属于目标 Canvas 候选批次的活跃图片任务。 */
  const cancelTasks = async (input: CanvasImageBatchCancelInput): Promise<void> => {
    if (!isSafeDesignStableId(input.projectId)
      || !isSafeDesignStableId(input.canvasId)
      || !isSafeDesignStableId(input.batchId)
      || !Array.isArray(input.taskIds)
      || input.taskIds.length === 0
      || input.taskIds.length > MAX_IMAGE_RUN_TASKS
      || new Set(input.taskIds).size !== input.taskIds.length
      || input.taskIds.some((taskId) => !isSafeDesignStableId(taskId))) {
      throw new Error('CANVAS_IMAGE_TASK_CANCEL_INPUT_INVALID')
    }
    const batch = await loadOwnedBatch(input)
    /** 先对全批完成 fresh ownership 与 active 快照，验证失败时保持零取消。 */
    const activeTaskIds: string[] = []
    for (const entry of batch.entries) {
      const job = dependencies.imageJobs.getProjectJob(input.projectId, entry.jobId)
      const imageTarget: CanvasImageTarget = {
        projectId: input.projectId,
        canvasId: input.canvasId,
        nodeId: entry.nodeId,
        imageModuleId: entry.imageModuleId,
      }
      if (!job
        || job.candidateBatchId !== input.batchId
        || !isOwnedImageJob(job, imageTarget)) {
        throw new Error('CANVAS_IMAGE_BATCH_WAIT_OWNERSHIP_INVALID')
      }
      if (ACTIVE_JOB_STATUSES.has(job.status)) activeTaskIds.push(entry.jobId)
    }
    /** 单项失败不得短路其它 owned active 任务，全部尝试后只返回稳定汇总错误。 */
    const results = await Promise.allSettled(activeTaskIds.map((taskId) => (
      dependencies.imageJobs.cancel(input.projectId, taskId)
    )))
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('CANVAS_IMAGE_TASK_CANCEL_FAILED')
    }
  }

  /** 运行图片节点，并保持原低层工具的幂等与回滚行为。 */
  const run = async (
    context: CanvasToolRunContext,
    target: CanvasTarget,
    nodes: CanvasNode[],
    operationId: string,
    options?: CanvasImageRunOptions,
  ): Promise<CanvasRunNodesResult> => {
    assertRunOptions(options)
    /** 非图片节点先记录既有 idle 结果，不进入付费执行器。 */
    const taskByNodeId = new Map<string, CanvasToolNodeRunResult>()
    for (const node of nodes) {
      if (node.kind !== 'image') taskByNodeId.set(node.id, { nodeId: node.id, status: 'idle' })
    }
    /** 图片目标保持调用方顺序，公开结果也按原节点顺序返回。 */
    const imageNodes = nodes.filter((node): node is Extract<CanvasNode, { kind: 'image' }> => node.kind === 'image')
    if (imageNodes.length === 0) return { tasks: nodes.map((node) => taskByNodeId.get(node.id)!) }
    /** 同一 Agent 工具调用下的图片任务共享稳定候选批次身份。 */
    const candidateBatchId = createImageBatchId(context, operationId, target.canvasId)
    /** 第一张图片只提供 Canvas 串行目标，锁实际按 projectId + canvasId 生效。 */
    const serializedTarget: CanvasImageTarget = {
      ...target,
      nodeId: imageNodes[0]!.id,
      imageModuleId: imageNodes[0]!.imageModuleId,
    }
    /** 全量预检、journal 和候选批次注册位于同一 Canvas 写边界。 */
    const creationOutcome = await dependencies.serializer.run(serializedTarget, () => (
      dependencies.guard.runWorkspaceWrite(target.projectId, async () => {
        /** 只读原因在任何目录或 journal 副作用前重新计算。 */
        const readOnlyReason = dependencies.getProjectReadOnlyReason(target.projectId)
        if (readOnlyReason) throw new Error(readOnlyReason)
        /** 全量预检固化的创建输入，禁止边预检边创建 journal。 */
        const prepared: Array<{
          node: Extract<CanvasNode, { kind: 'image' }>
          imageTarget: CanvasImageTarget
          config: CanvasImageModuleConfig
          jobId: string
          input: CreateDesignJobInput
        }> = []
        for (const node of imageNodes) {
          /** 当前图片节点的完整可信目标。 */
          const imageTarget: CanvasImageTarget = {
            ...target,
            nodeId: node.id,
            imageModuleId: node.imageModuleId,
          }
          try {
            /** 配置与预检使用相同快照，避免固化输入漂移。 */
            const config = await dependencies.imageModules.load(imageTarget)
            assertOwnedImageConfig(config, imageTarget)
            if (!config.selectedModelProfileId) throw new Error('CANVAS_IMAGE_MODEL_REQUIRED')
            /** 后续幂等创建复用此处完成预检的输入。 */
            const input: CreateDesignJobInput = {
              projectId: target.projectId,
              target: {
                kind: 'canvas-image',
                canvasId: target.canvasId,
                nodeId: node.id,
                imageModuleId: node.imageModuleId,
              },
              action: config.adoptedAssetId ? 'edit' : 'generate',
              prompt: config.prompt,
              contextMode: config.contextMode,
              imageModelProfileId: config.selectedModelProfileId,
              generationConstraints: { aspectRatio: config.aspectRatio, imageSize: config.imageSize },
              canvasImageConfigRevision: config.revision,
              candidateBatchId,
              ...(config.adoptedAssetId ? { sourceAssetId: config.adoptedAssetId } : {}),
            }
            await dependencies.imageJobs.preflightCanvasImage(input)
            prepared.push({
              node,
              imageTarget,
              config,
              input,
              jobId: createImageJobId(context, operationId, target.canvasId, node.id),
            })
          } catch (error) {
            for (const candidate of imageNodes) {
              taskByNodeId.set(candidate.id, candidate.id === node.id
                ? { nodeId: candidate.id, status: 'failed', error: canvasNodeRunError(error) }
                : { nodeId: candidate.id, status: 'blocked', error: 'CANVAS_BATCH_PREFLIGHT_BLOCKED' })
            }
            return { ready: false as const, jobs: [] }
          }
        }

        /** 已建立 journal 的任务及其本轮创建归属。 */
        const jobs: Array<{
          node: Extract<CanvasNode, { kind: 'image' }>
          imageTarget: CanvasImageTarget
          job: DesignJobRecord
          created: boolean
        }> = []
        for (let index = 0; index < prepared.length; index += 1) {
          /** 当前待建立 journal 的预检项。 */
          const item = prepared[index]!
          try {
            /** 幂等创建可返回此前相同调用留下的既有 journal。 */
            const result = await dependencies.imageJobs.createCanvasImageOnce(item.input, item.jobId)
            if (!isOwnedImageJob(result.job, item.imageTarget)) throw new Error('CANVAS_IMAGE_JOB_TARGET_CONFLICT')
            jobs.push({ node: item.node, imageTarget: item.imageTarget, ...result })
          } catch (error) {
            /** 只有本轮新建项属于当前失败事务的回滚范围。 */
            const createdJobs = jobs.filter((entry) => entry.created)
            /** 每个回滚结果独立记录，单项失败不阻断其它清理。 */
            const rollbackResults = await Promise.allSettled(createdJobs.map((entry) => (
              dependencies.imageJobs.rollbackCanvasImageOnce(
                target.projectId,
                entry.job.id,
                entry.job.target as Extract<NonNullable<DesignJobRecord['target']>, { kind: 'canvas-image' }>,
              )
            )))
            for (let rollbackIndex = 0; rollbackIndex < createdJobs.length; rollbackIndex += 1) {
              /** 当前已尝试回滚的新建 journal。 */
              const entry = createdJobs[rollbackIndex]!
              /** 当前回滚的独立结果。 */
              const rollback = rollbackResults[rollbackIndex]!
              /** 只有明确返回 true 才声称 journal 已回滚。 */
              const rolledBack = rollback.status === 'fulfilled' && rollback.value
              taskByNodeId.set(entry.node.id, {
                nodeId: entry.node.id,
                status: rolledBack ? 'rolled-back' : 'queued',
                taskId: entry.job.id,
                ...(!rolledBack ? {
                  error: rollback.status === 'rejected'
                    ? canvasNodeRunError(rollback.reason)
                    : 'CANVAS_BATCH_ROLLBACK_FAILED',
                } : {}),
              })
            }
            for (const entry of jobs.filter((candidate) => !candidate.created)) {
              taskByNodeId.set(entry.node.id, { nodeId: entry.node.id, status: 'queued', taskId: entry.job.id })
            }
            taskByNodeId.set(item.node.id, { nodeId: item.node.id, status: 'failed', error: canvasNodeRunError(error) })
            for (const blocked of prepared.slice(index + 1)) {
              taskByNodeId.set(blocked.node.id, {
                nodeId: blocked.node.id,
                status: 'blocked',
                error: 'CANVAS_BATCH_JOB_CREATION_BLOCKED',
              })
            }
            return { ready: false as const, jobs: [] }
          }
        }

        try {
          await dependencies.candidateBatches.createBatchLocked({
            ...target,
            batchId: candidateBatchId,
            source: 'canvas-tool',
            sourceSessionId: context.sessionId,
            sourceToolCallId: operationId,
            entries: prepared.map((item) => ({
              nodeId: item.node.id,
              imageModuleId: item.node.imageModuleId,
              initialAdoptedAssetId: item.config.adoptedAssetId,
              initialConfigRevision: item.config.revision,
              jobId: item.jobId,
            })),
          })
        } catch (error) {
          /** 候选批次登记失败时同样只回滚本轮新建 journal。 */
          const createdJobs = jobs.filter((entry) => entry.created)
          await Promise.allSettled(createdJobs.map((entry) => dependencies.imageJobs.rollbackCanvasImageOnce(
            target.projectId,
            entry.job.id,
            entry.job.target as Extract<NonNullable<DesignJobRecord['target']>, { kind: 'canvas-image' }>,
          )))
          for (const item of prepared) {
            taskByNodeId.set(item.node.id, {
              nodeId: item.node.id,
              status: 'failed',
              error: canvasNodeRunError(error),
            })
          }
          return { ready: false as const, jobs: [] }
        }
        return { ready: true as const, jobs }
      })
    ))
    if (!creationOutcome.ready) return { tasks: nodes.map((node) => taskByNodeId.get(node.id)!) }

    /** 返回调度器前，本服务独占本批次所有 active Job 的取消职责。 */
    const ownedTaskIds = creationOutcome.jobs.map((entry) => entry.job.id)
    try {
      /** creation 期间可能已中止；必须在调用任何付费 start 前先复核。 */
      await awaitRunBoundary(Promise.resolve(), options)
      /** 只有本轮新建 journal 才需要锁外启动，既有 journal 不产生重复费用。 */
      const createdJobs = creationOutcome.jobs.filter((entry) => entry.created)
      /** Manager 的 start 只等待 running ack，完整生成由 Manager 自己持有并收口。 */
      const runResults = await awaitRunBoundary(Promise.allSettled(
        createdJobs.map((entry) => dependencies.imageJobs.start(entry.job.id)),
      ), options)
      for (let index = 0; index < createdJobs.length; index += 1) {
        /** 当前本轮新建任务。 */
        const entry = createdJobs[index]!
        /** 当前任务的锁外启动结果。 */
        const result = runResults[index]!
        taskByNodeId.set(entry.node.id, result.status === 'fulfilled'
          ? { nodeId: entry.node.id, status: 'started', taskId: entry.job.id }
          : { nodeId: entry.node.id, status: 'failed', taskId: entry.job.id, error: canvasNodeRunError(result.reason) })
      }
      for (const entry of creationOutcome.jobs.filter((candidate) => !candidate.created)) {
        taskByNodeId.set(entry.node.id, entry.job.status === 'failed'
          ? { nodeId: entry.node.id, status: 'failed', taskId: entry.job.id, error: entry.job.error ?? 'CANVAS_IMAGE_JOB_FAILED' }
          : {
              nodeId: entry.node.id,
              status: entry.job.status === 'queued' ? 'queued' : 'started',
              taskId: entry.job.id,
            })
      }
      /** 批次摘要加载也属于交接前窗口，中止时必须由本服务精确取消。 */
      const candidateBatch = await awaitRunBoundary(
        dependencies.candidateBatches.load({ ...target, batchId: candidateBatchId }),
        options,
      )
      /** load 完成与公开结果交接之间再做一次同步复核，封闭迟到取消。 */
      await awaitRunBoundary(Promise.resolve(), options)
      return {
        tasks: nodes.map((node) => taskByNodeId.get(node.id)!),
        batch: summarizeBatch(candidateBatch),
      }
    } catch (error) {
      if (error instanceof Error
        && (error.message === 'CANVAS_IMAGE_RUN_ABORTED' || error.message === 'CANVAS_IMAGE_RUN_DEADLINE')) {
        try {
          await cancelTasks({
            ...target,
            batchId: candidateBatchId,
            taskIds: ownedTaskIds,
          })
        } catch {
          reportCanvasImageDiagnostic('CANVAS_IMAGE_RUN_CANCEL_CLEANUP_FAILED')
        }
      }
      throw error
    }
  }

  /** 通过相关 Job change 事件等待候选批次终态，不轮询磁盘。 */
  const awaitBatch = async (input: CanvasImageBatchWaitInput): Promise<CanvasRunNodesBatchTerminalSummary> => {
    assertWaitInput(input)
    /** 相关事件单调代次用于封闭读取与挂起之间的 lost wakeup。 */
    let changeVersion = 0
    /** 当前事件等待器；每轮读取后按需替换。 */
    let wakeListener: (() => void) | null = null
    /** 当前 deadline timer；相关事件先到时立即清除。 */
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null
    /** 当前 AbortSignal 临时监听器；任一唤醒路径都必须显式移除。 */
    let abortListener: (() => void) | null = null
    /** 只接纳同项目、同 Canvas、同候选批次的 Job 变化。 */
    const onChanged: DesignJobChangedListener = ({ job }) => {
      if (job.projectId !== input.projectId
        || job.candidateBatchId !== input.batchId
        || job.target?.kind !== 'canvas-image'
        || job.target.canvasId !== input.canvasId) return
      changeVersion += 1
      wakeListener?.()
    }
    /** 候选 ack 只在权威批次状态保存完成后发出，不依赖事件循环时序猜测。 */
    const onBatchChanged: CanvasImageCandidateBatchChangedListener = (event) => {
      if (event.projectId !== input.projectId
        || event.canvasId !== input.canvasId
        || event.batchId !== input.batchId
        || !input.taskIds.includes(event.jobId)) return
      changeVersion += 1
      wakeListener?.()
    }
    /** 两类临时监听只覆盖当前 await 调用，并在所有终态路径退订。 */
    const unsubscribeJob = dependencies.imageJobs.onChanged(onChanged)
    const unsubscribeBatch = dependencies.candidateBatches.onChanged(onBatchChanged)
    try {
      while (true) {
        if (input.signal.aborted) throw new Error('CANVAS_IMAGE_BATCH_WAIT_ABORTED')
        if (Date.now() >= input.deadlineAt) throw new Error('CANVAS_IMAGE_BATCH_WAIT_DEADLINE')
        /** 读取前记录事件代次，读取期间变化会触发立即重读。 */
        const observedVersion = changeVersion
        /** 每次重读都重新验证 Batch、Job 与调用任务集合的归属。 */
        const batch = await loadOwnedBatch(input)
        /** 只有无活跃条目才返回公开终态摘要。 */
        const summary = summarizeBatch(batch)
        if (summary.runningCount === 0) return summarizeTerminalBatch(batch)
        if (input.signal.aborted) throw new Error('CANVAS_IMAGE_BATCH_WAIT_ABORTED')
        if (Date.now() >= input.deadlineAt) throw new Error('CANVAS_IMAGE_BATCH_WAIT_DEADLINE')
        if (changeVersion !== observedVersion) continue
        /** 单次事件等待同时响应 AbortSignal 与绝对截止时间。 */
        const wakeReason = await new Promise<'changed' | 'aborted' | 'deadline'>((resolve) => {
          /** 事件回调只解析本轮 Promise，不执行磁盘读取。 */
          wakeListener = () => resolve('changed')
          /** 中止回调只解析稳定原因，取消动作在统一异常路径执行。 */
          abortListener = () => resolve('aborted')
          input.signal.addEventListener('abort', abortListener, { once: true })
          /** 绝对截止只使用单次 timer，不构成轮询。 */
          deadlineTimer = setTimeout(() => resolve('deadline'), Math.max(0, input.deadlineAt - Date.now()))
          /** lost wakeup 检查必须位于监听器与 timer 安装之后。 */
          if (changeVersion !== observedVersion) resolve('changed')
          /** Promise 收口时由下一微任务清理本轮临时资源。 */
          queueMicrotask(() => {
            if (changeVersion !== observedVersion) resolve('changed')
          })
        })
        /** 任意唤醒均立即移除本轮 AbortSignal 监听器。 */
        if (abortListener) input.signal.removeEventListener('abort', abortListener)
        abortListener = null
        wakeListener = null
        if (deadlineTimer) {
          clearTimeout(deadlineTimer)
          deadlineTimer = null
        }
        if (wakeReason === 'aborted') throw new Error('CANVAS_IMAGE_BATCH_WAIT_ABORTED')
        if (wakeReason === 'deadline') throw new Error('CANVAS_IMAGE_BATCH_WAIT_DEADLINE')
      }
    } catch (error) {
      if (error instanceof Error
        && (error.message === 'CANVAS_IMAGE_BATCH_WAIT_ABORTED'
          || error.message === 'CANVAS_IMAGE_BATCH_WAIT_DEADLINE')) {
        /** 只取消输入任务中仍属于当前批次与 Canvas 的活跃 Job。 */
        try {
          await cancelTasks(input)
        } catch {
          /** 清理异常只进入内部诊断，不能覆盖调用方可依赖的等待主错误。 */
          reportCanvasImageDiagnostic('CANVAS_IMAGE_BATCH_CANCEL_CLEANUP_FAILED')
        }
      }
      throw error
    } finally {
      wakeListener = null
      if (abortListener) input.signal.removeEventListener('abort', abortListener)
      if (deadlineTimer) clearTimeout(deadlineTimer)
      unsubscribeBatch()
      unsubscribeJob()
    }
  }

  return { run, awaitBatch, cancelTasks }
}
