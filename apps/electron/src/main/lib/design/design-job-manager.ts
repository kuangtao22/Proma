import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  AgentMessage,
  AgentSendInput,
  AgentSessionMeta,
  CanvasImageTarget,
  CreateDesignJobInput,
  DesignAsset,
  DesignCanvasDocument,
  DesignCanvasNode,
  DesignJobRecord,
  DesignJobTarget,
  DesignMutation,
  DesignPoint,
  DesignTaskDetails,
  ImageGenerationModelSnapshot,
  SDKAssistantMessage,
  SDKMessage,
  SDKToolResultBlock,
  SDKToolUseBlock,
  SDKUserMessage,
} from '@proma/shared'
import {
  IMAGE_GENERATION_MODEL_ID_MAX_LENGTH,
  IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH,
} from '@proma/shared'
import { removeFileAtomic, writeJsonFileAtomic } from '../safe-file'
import { getConversationAttachmentsDir, resolveAttachmentPath } from '../config-paths'
import type { AgentRunExtensions } from '../agent-service'
import type { ImageGenerationModelCatalog } from '../image-generation-model-catalog'
import { runSafeImageModelOperation } from '../image-generation-model-error'
import { resolveProjectInstructions } from '../project-instruction-resolver'
import type {
  DesignAssetImportBatch,
  DesignAssetImportSource,
  DesignAssetService,
} from './design-asset-service'
import type { DesignContextOrchestrator } from './design-context-orchestrator'
import { isSafeDesignStableId } from './design-paths'
import type { DesignStore } from './design-store'
import type { DesignTraceWriteResult } from './design-trace-store'
import type {
  CanvasImageJobTarget,
  CanvasImageJobTargetAdapter,
} from './canvas-image-job-target'
import {
  CANVAS_IMAGE_INPUT_MAX_MEDIA,
  CANVAS_IMAGE_INPUT_MAX_REFERENCES,
  CANVAS_IMAGE_INPUT_MAX_TEXT,
} from './canvas-image-input-resolver'
import type { CanvasImageInputResolver } from './canvas-image-input-resolver'

const DESIGN_IMAGE_TOOL = 'mcp__nano_banana__generate_image'
const DESIGN_JOB_MODEL_ERROR = '未配置可用的 Agent 渠道和模型'
const DESIGN_JOB_OUTPUT_ERROR = '任务完成但没有产生可验证图片'
const DESIGN_IMAGE_MODEL_VALIDATION_ERROR = '校验生图模型配置失败，请刷新后重试'
/** 已完成业务执行、可以进入 trace 与会话回收阶段的状态。 */
const TERMINAL_JOB_STATUSES = new Set<DesignJobRecord['status']>([
  'succeeded', 'failed', 'cancelled', 'interrupted',
])

/** Design Job 使用的最小设置字段。 */
interface DesignJobSettings {
  agentChannelId?: string
  agentModelId?: string
}

/** journal 额外保留重试、布局提交和恢复所需的内部字段。 */
interface StoredDesignJob extends Omit<DesignJobRecord, 'target'> {
  target: DesignJobTarget
  maskAnnotationId?: string
  /** queued journal 与占位节点两步提交的恢复标记。 */
  placementState?: 'pending' | 'ready'
  /** Store 终态提交结果不确定时保留的跨进程对账证据。 */
  terminalState?: { status: 'pending'; outputAssetId: string }
  /** retry 已创建的唯一替代任务，用于重复请求幂等返回。 */
  replacedByJobId?: string
  /** replacement 创建完成前持久化的 retry intent。 */
  retryState?: { status: 'pending' }
  /** 终态任务删除在画布与 journal 之间的可恢复意图。 */
  deletionState?: { status: 'pending' }
}

/** Manager 内部创建已使用独立可信 snapshot，不再依赖 Renderer profile ID。 */
type InternalCreateDesignJobInput = Omit<CreateDesignJobInput, 'imageModelProfileId'>

/** journal 允许出现的完整字段集合，未知字段一律拒绝。 */
const STORED_JOB_FIELDS = new Set([
  'id', 'creativeTaskId', 'attemptNumber', 'projectId', 'sessionId', 'action', 'status',
  'prompt', 'originalRequest', 'contextMode', 'sourceAgentMessageId', 'sourceSessionId',
  'sourceAssetId', 'parentAssetId', 'outputAssetId', 'error', 'createdAt', 'updatedAt',
  'traceState', 'executionSessionCleanupState', 'contextReferences', 'designSummary',
  'finalImagePrompt', 'rawThinkingAvailable', 'contextWarning', 'startedAt', 'completedAt',
  'imageModelSnapshot',
  'target', 'generationConstraints', 'canvasInputReferences', 'canvasImageConfigRevision',
  'maskAnnotationId', 'placementState', 'terminalState',
  'replacedByJobId', 'retryState', 'deletionState',
])
/** journal 中必须始终存在的基础字段。 */
const REQUIRED_STORED_JOB_FIELDS = [
  'id', 'creativeTaskId', 'attemptNumber', 'projectId', 'action', 'status', 'prompt',
  'originalRequest', 'contextMode', 'createdAt', 'updatedAt', 'target',
] as const
/** target 引入前的 journal 字段，存在 target 时绝不走兼容分支。 */
const LEGACY_STORED_JOB_FIELDS = new Set([
  'id', 'creativeTaskId', 'attemptNumber', 'projectId', 'sessionId', 'action', 'status',
  'prompt', 'originalRequest', 'contextMode', 'sourceAgentMessageId', 'sourceSessionId',
  'sourceAssetId', 'parentAssetId', 'outputAssetId', 'error', 'createdAt', 'updatedAt',
  'traceState', 'executionSessionCleanupState', 'contextReferences', 'designSummary',
  'finalImagePrompt', 'rawThinkingAvailable', 'contextWarning', 'startedAt', 'completedAt',
  'imageModelSnapshot', 'nodeId', 'position', 'maskAnnotationId', 'placementState',
  'terminalState', 'replacedByJobId', 'retryState', 'deletionState',
])

/** Headless Agent 回调的窄接口。 */
interface DesignHeadlessCallbacks {
  onError: (error: string) => void
  onComplete: (messages?: AgentMessage[]) => void
  onTitleUpdated: (title: string) => void
  source: 'design'
}

/** Design Job Manager 的可注入依赖。 */
export interface DesignJobManagerDependencies {
  pathResolver: { resolve: (projectId: string) => { jobsDir: string; projectRoot: string } }
  store: DesignStore
  assetService: Pick<DesignAssetService, 'resolveAssetPath' | 'importAuthorizedFiles'>
  /** Canvas 图片输出采用与节点投影修复边界；旧 Design 路径不依赖它。 */
  canvasImageTargetAdapter?: CanvasImageJobTargetAdapter
  /** 从直接入边读取已提交事实并固化任务输入。 */
  canvasImageInputResolver?: CanvasImageInputResolver
  /** 只暴露任务创建、预检和单次工具运行所需的模型路由能力。 */
  imageModels: Pick<
    ImageGenerationModelCatalog,
    'resolveAvailableSnapshot' | 'assertSnapshotAvailable' | 'resolveExecutionRoute'
  >
  /** 为每次 Design 运行创建隔离的只读上下文工具、预算与审计状态。 */
  contextOrchestrator: Pick<DesignContextOrchestrator, 'createRun'>
  getSettings: () => DesignJobSettings
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  /** 从内部会话 JSONL 读取完整 SDK 事实，用于终态 trace 转存。 */
  getSessionMessages: (sessionId: string) => SDKMessage[]
  createSession: (input: {
    title: string
    channelId: string
    projectId: string
    modelId: string
    sourceDesignJobId: string
  }) => AgentSessionMeta
  runHeadless: (
    input: AgentSendInput,
    callbacks: DesignHeadlessCallbacks,
    extensions: AgentRunExtensions,
  ) => Promise<void>
  stopAgent: (sessionId: string) => void | Promise<void>
  /** 保存并按需读取 Design trace，不向 Manager 暴露实际文件路径。 */
  traceStore: {
    writeFromMessages: (projectId: string, jobId: string, messages: SDKMessage[]) => DesignTraceWriteResult
    read: (projectId: string, jobId: string) => NonNullable<DesignTaskDetails['trace']>
    delete: (projectId: string, jobId: string) => void
  }
  /** trace ready 后回收内部执行会话。 */
  sessionLifecycle: {
    cleanup: (input: { sessionId: string; traceState: 'ready' }) => Promise<void>
  }
  /** 验证附件属于当前会话并返回可供素材服务读取的绝对路径。 */
  resolveOwnedOutputPath: (sessionId: string, localPath: string) => string | undefined
  listProjectIds: () => string[]
  /** 在项目迁移互斥边界内执行完整设计任务写入。 */
  runWorkspaceWrite: <T>(projectId: string, effect: () => T) => T
  /** 原子写入单个任务 journal；生产默认使用 safe-file，测试可注入 durability 故障。 */
  writeJobJournal?: (path: string, value: object) => void
  /** 读取 journal 目录项；测试注入用于验证目标索引不会重复全量扫描。 */
  readJobsDirectory?: (path: string) => string[]
  /** 单项目恢复失败时记录中文错误，默认输出到主进程错误日志。 */
  warn?: (message: string) => void
  /** 生图模型未知底层错误记录器，必须保留原始 Error 供主进程诊断。 */
  logImageModelError?: (message: string, error: unknown) => void
  createId?: () => string
  /** 为跨尝试创作任务生成独立稳定 ID。 */
  createCreativeTaskId?: () => string
  now?: () => number
}

/** Design Job 状态变化事件，同时携带画布权威 revision。 */
export interface DesignJobChangedEvent {
  job: DesignJobRecord
  revision: number
}

/** Design Job 状态变化监听器。 */
export type DesignJobChangedListener = (event: DesignJobChangedEvent) => void

/** 当前进程由 IPC 初始化的默认 Design Job Manager。 */
let defaultDesignJobManager: DesignJobManager | undefined

/** 注册供应用生命周期复用的默认 Manager。 */
export function setDefaultDesignJobManager(manager: DesignJobManager): void {
  defaultDesignJobManager = manager
}

/** 获取已初始化的默认 Manager；启动隔离模式下可能不存在。 */
export function getDefaultDesignJobManager(): DesignJobManager | undefined {
  return defaultDesignJobManager
}

/**
 * 验证 Nano Banana 附件精确属于当前 Design Job 会话。
 * @param sessionId 当前任务可见 Agent 会话 ID。
 * @param localPath tool_result 返回的附件相对路径。
 * @returns 归属有效的真实绝对路径，否则返回 undefined。
 */
export function resolveOwnedDesignJobOutputPath(sessionId: string, localPath: string): string | undefined {
  if (!localPath || isAbsolute(localPath)) return undefined
  const expectedRoot = getConversationAttachmentsDir(sessionId)
  const candidate = resolveAttachmentPath(localPath)
  const lexicalRelative = relative(expectedRoot, candidate)
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(lexicalRelative)) return undefined
  try {
    const actualRoot = realpathSync(expectedRoot)
    const actualPath = realpathSync(candidate)
    const actualRelative = relative(actualRoot, actualPath)
    if (actualRelative === '..' || actualRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(actualRelative)) return undefined
    const stats = lstatSync(actualPath)
    return stats.isFile() && !stats.isSymbolicLink() ? actualPath : undefined
  } catch {
    return undefined
  }
}

/** 可恢复的项目级图片生成与编辑任务协调器。 */
export class DesignJobManager {
  private readonly jobs = new Map<string, StoredDesignJob>()
  private readonly projectRevisions = new Map<string, number>()
  private readonly listeners = new Set<DesignJobChangedListener>()
  /** 已完成 Canvas 图片目标索引首轮 journal 扫描的项目。 */
  private readonly indexedCanvasImageProjects = new Set<string>()
  /** 完整 Canvas 图片目标到任务 ID 集合的进程内索引。 */
  private readonly canvasImageJobIdsByTarget = new Map<string, Set<string>>()
  /** 项目拥有的目标 key，用于 recover 时精确重建单项目索引。 */
  private readonly canvasImageTargetKeysByProject = new Map<string, Set<string>>()
  /** 任务当前所属目标 key，用于状态覆盖和删除时增量维护。 */
  private readonly canvasImageTargetKeyByJobId = new Map<string, string>()
  /** 尚未写入 journal 的 Canvas 图片目标预留，封闭并发 create/retry 的扫描窗口。 */
  private readonly canvasImageReservations = new Set<string>()
  private readonly createId: () => string
  private readonly createCreativeTaskId: () => string
  private readonly now: () => number
  private readonly warn: (message: string) => void
  private readonly logImageModelError: (message: string, error: unknown) => void

  constructor(private readonly dependencies: DesignJobManagerDependencies) {
    this.createId = dependencies.createId ?? randomUUID
    this.createCreativeTaskId = dependencies.createCreativeTaskId ?? randomUUID
    this.now = dependencies.now ?? Date.now
    this.warn = dependencies.warn ?? ((message) => { console.error(message) })
    this.logImageModelError = dependencies.logImageModelError
      ?? ((message, error) => { console.error(message, error) })
  }

  /** 创建 queued journal 和占位节点，不等待 Agent 运行。 */
  create(input: CreateDesignJobInput): DesignJobRecord {
    if (input.target?.kind === 'canvas-image') {
      throw new Error('Canvas 图片任务必须使用独立创建入口')
    }
    /** 可信模型校验必须早于 Store 读取、ID 生成、journal 和占位节点写入。 */
    const imageModelSnapshot = this.runImageModelValidation(
      () => this.dependencies.imageModels.resolveAvailableSnapshot(input.imageModelProfileId),
    )
    return this.createInternal(input, imageModelSnapshot)
  }

  /** 创建只归属 Canvas 图片模块的 queued journal，不修改旧 Design 节点。 */
  async createCanvasImage(input: CreateDesignJobInput): Promise<DesignJobRecord> {
    if (input.target?.kind !== 'canvas-image') throw new Error('Canvas 图片任务目标无效')
    /** action 与来源素材的不变量必须先于预留、解析、ID 和持久化副作用。 */
    if (input.action === 'generate' && input.sourceAssetId !== undefined) {
      throw new Error('生成任务不得包含来源素材')
    }
    if (input.action === 'edit' && !input.sourceAssetId) throw new Error('编辑任务缺少来源素材')
    /** 局部常量保留跨异步调用和数组回调的 Canvas 目标收窄。 */
    const target = input.target
    /** 目标预留必须早于首个 await，保证同一事件循环内并发请求只能有一个进入。 */
    const releaseReservation = this.reserveCanvasImageTarget(input.projectId, target)
    try {
      const prompt = input.prompt.trim()
      if (!prompt) throw new Error('设计任务提示词不能为空')
      if (!input.generationConstraints || input.canvasImageConfigRevision === undefined) {
        throw new Error('Canvas 图片任务缺少生成快照')
      }
      const targetAdapter = this.dependencies.canvasImageTargetAdapter
      const inputResolver = this.dependencies.canvasImageInputResolver
      if (!targetAdapter || !inputResolver) throw new Error('Canvas 图片任务执行边界未初始化')
      /** 完整目标必须在模型、输入、ID 和 journal 副作用前验证。 */
      await targetAdapter.assertTarget(input.projectId, target)
      /** 来源素材必须先由当前项目权威 Store 证明，禁止跨项目或陈旧 ID 进入 journal。 */
      const current = this.dependencies.store.requireStableAuthoritativeDocument(input.projectId)
      if (input.sourceAssetId && !current.assets.some((asset) => asset.id === input.sourceAssetId)) {
        throw new Error(`素材不存在: ${input.sourceAssetId}`)
      }
      /** 可信模型校验必须早于 ID、journal 和事件副作用。 */
      const imageModelSnapshot = this.runImageModelValidation(
        () => this.dependencies.imageModels.resolveAvailableSnapshot(input.imageModelProfileId),
      )
      /** 连线输入独立于 contextMode，始终从权威直接入边重新解析。 */
      const canvasInputReferences = await inputResolver.resolve(toCanvasImageTarget(input.projectId, target))
      const id = this.createId()
      const creativeTaskId = this.createCreativeTaskId()
      if (!isSafeDesignStableId(id) || !isSafeDesignStableId(creativeTaskId) || id === creativeTaskId) {
        throw new Error('Design 创作任务 ID 非法')
      }
      const timestamp = this.now()
      const job: StoredDesignJob = {
        id,
        creativeTaskId,
        attemptNumber: 1,
        projectId: input.projectId,
        target: { ...target },
        action: input.action,
        status: 'queued',
        prompt,
        originalRequest: prompt,
        contextMode: input.contextMode,
        generationConstraints: { ...input.generationConstraints },
        canvasInputReferences: canvasInputReferences.map((reference) => ({ ...reference })),
        canvasImageConfigRevision: input.canvasImageConfigRevision,
        imageModelSnapshot: { ...imageModelSnapshot },
        ...(input.sourceAssetId
          ? { sourceAssetId: input.sourceAssetId, parentAssetId: input.sourceAssetId }
          : {}),
        traceState: 'pending',
        executionSessionCleanupState: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      this.writeJob(job)
      this.emit(job, current.revision)
      return job
    } finally {
      releaseReservation()
    }
  }

  /** 查询已加载或磁盘可发现的任务。 */
  get(jobId: string): DesignJobRecord | undefined {
    return this.findStoredJob(jobId)
  }

  /** 列出项目全部任务，并把磁盘 journal 载入内存索引。 */
  list(projectId: string): DesignJobRecord[] {
    const jobs = this.readProjectJobs(projectId)
    this.rebuildCanvasImageIndex(projectId, jobs)
    return jobs
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  /** 按完整 Canvas 图片目标查询，首次惰性扫描后只访问该目标任务集合。 */
  listCanvasImageJobs(target: CanvasImageTarget): DesignJobRecord[] {
    this.ensureCanvasImageIndex(target.projectId)
    const key = createCanvasImageTargetKey(target.projectId, target)
    const jobIds = this.canvasImageJobIdsByTarget.get(key) ?? new Set<string>()
    return [...jobIds]
      .map((jobId) => this.jobs.get(jobId))
      .filter((job): job is StoredDesignJob => Boolean(job))
      .sort(compareDesignJobs)
      .map(clonePublicDesignJob)
  }

  /** 在项目索引内按 ID 查询任务；首次建索引后存在与缺失查询均为 O(1)。 */
  getProjectJob(projectId: string, jobId: string): DesignJobRecord | undefined {
    if (!isSafeDesignStableId(projectId) || !isSafeDesignStableId(jobId)) return undefined
    this.ensureCanvasImageIndex(projectId)
    const job = this.jobs.get(jobId)
    return job?.projectId === projectId ? clonePublicDesignJob(job) : undefined
  }

  /**
   * 查询同一创作任务的尝试历史，并仅在显式请求时读取当前 trace。
   * @param projectId 当前 Design 项目 ID。
   * @param jobId 任一所属尝试 ID。
   * @param includeTrace 是否读取大体积 JSONL trace。
   * @returns 以 creativeTaskId 聚合的公开任务详情。
   */
  getTaskDetails(projectId: string, jobId: string, includeTrace = false): DesignTaskDetails {
    const current = this.requireProjectJob(projectId, jobId)
    const attempts = this.list(projectId)
      .filter((job) => job.creativeTaskId === current.creativeTaskId)
      .sort((left, right) => left.attemptNumber - right.attemptNumber)
      .map((job) => ({
        jobId: job.id,
        attemptNumber: job.attemptNumber,
        status: job.status,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        traceState: job.traceState,
        designSummary: job.designSummary,
        finalImagePrompt: job.finalImagePrompt,
        rawThinkingAvailable: job.rawThinkingAvailable,
      }))
    const traceState = current.traceState ?? 'unavailable'
    /** 详情对象保留 Canvas 固化输入，旧消费者可忽略新增运行时字段。 */
    const details = {
      creativeTaskId: current.creativeTaskId,
      currentJobId: current.id,
      attempts,
      traceState,
      ...(current.canvasInputReferences
        ? { canvasInputReferences: current.canvasInputReferences.map((reference) => ({ ...reference })) }
        : {}),
      ...(includeTrace && traceState === 'ready'
        ? { trace: this.dependencies.traceStore.read(projectId, current.id) }
        : {}),
    }
    return details
  }

  /** 订阅任意任务状态变化。 */
  onChanged(listener: DesignJobChangedListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 执行 queued 任务，并只接纳本轮 Nano Banana 的受归属图片。 */
  async run(jobId: string): Promise<void> {
    const queued = this.requireJob(jobId)
    if (queued.status !== 'queued') return
    try {
      /** journal 固化的公开模型快照，也是本轮复核的唯一输入。 */
      const imageModelSnapshot = queued.imageModelSnapshot
      if (!imageModelSnapshot) {
        this.updateStatus(queued, 'failed', { error: '旧任务未记录生图模型，请重新提交新任务' })
        return
      }
      /** 排队期间配置可能被删除、停用或修改，付费会话创建前必须再次复核。 */
      this.runImageModelValidation(
        () => this.dependencies.imageModels.assertSnapshotAvailable(imageModelSnapshot),
      )
      const model = this.resolveModel(queued)
      if (!model) {
        this.updateStatus(queued, 'failed', { error: DESIGN_JOB_MODEL_ERROR })
        return
      }
      /** 上下文预检和项目指令解析必须早于内部会话创建，避免失败时留下空会话。 */
      const contextRun = this.dependencies.contextOrchestrator.createRun({
        projectId: queued.projectId,
        mode: queued.contextMode,
        originalRequest: queued.originalRequest,
      })
      const userMessage = this.buildPrompt(queued)
      /** 图片工具执行前捕获的真实结构化参数，不从自然语言或 trace 反推。 */
      let imageCall: { designSummary: string; prompt: string } | undefined
      const session = this.dependencies.createSession({
        title: `设计任务：${queued.prompt.trim().slice(0, 24)}`,
        channelId: model.channelId,
        projectId: queued.projectId,
        modelId: model.modelId,
        sourceDesignJobId: queued.id,
      })
      const running = this.updateStatus(queued, 'running', { sessionId: session.id, error: undefined })
      let runError: string | undefined
      let messages: AgentMessage[] = []
      try {
        await this.dependencies.runHeadless({
          sessionId: session.id,
          userMessage,
          rawUserMessage: running.prompt,
          channelId: model.channelId,
          modelId: model.modelId,
          workspaceId: running.projectId,
          triggeredBy: 'user',
          permissionModeOverride: 'bypassPermissions',
        }, {
          source: 'design',
          onError: (error) => { runError ??= error },
          onComplete: (completedMessages) => { messages = completedMessages ?? [] },
          onTitleUpdated: () => undefined,
        }, {
          piCustomTools: contextRun.tools,
          allowedToolNames: [...contextRun.allowedToolNames, DESIGN_IMAGE_TOOL],
          toolCallLimits: { [DESIGN_IMAGE_TOOL]: 1 },
          beforeToolCall: (toolName) => {
            if (toolName === DESIGN_IMAGE_TOOL) contextRun.assertReadyForImageCall()
          },
          captureDesignImageCall: (value) => { imageCall = { ...value } },
          trustedImageRoute: running.imageModelSnapshot,
          resolveTrustedImageRoute: (route) => {
            try {
              return this.runImageModelValidation(
                () => this.dependencies.imageModels.resolveExecutionRoute(route),
              )
            } catch (error) {
              runError ??= error instanceof Error ? error.message : DESIGN_IMAGE_MODEL_VALIDATION_ERROR
              throw error
            }
          },
        })
      } finally {
        /** 即使 Agent 抛错或被取消，也保存本轮已经发生的上下文与图片调用事实。 */
        const latest = this.requireJob(jobId)
        this.updateStatus(latest, latest.status, {
          contextReferences: contextRun.getReferences(),
          contextWarning: contextRun.getWarnings().join('\n') || undefined,
          designSummary: imageCall?.designSummary,
          finalImagePrompt: imageCall?.prompt,
        })
      }
      const latest = this.requireJob(jobId)
      if (latest.status === 'cancelled' || latest.status === 'interrupted') return
      if (runError) {
        this.updateStatus(latest, 'failed', { error: runError })
        return
      }
      /** 完成回调兼容旧消息；当前 Pi 的结构化附件以持久化 SDK 消息为权威事实。 */
      const outputPath = this.findOwnedOutputPath(messages, session.id)
        ?? this.findOwnedOutputPath(this.dependencies.getSessionMessages(session.id), session.id)
      if (!outputPath) {
        this.updateStatus(latest, 'failed', { error: DESIGN_JOB_OUTPUT_ERROR })
        return
      }
      await this.commitOutput(latest, session.id, outputPath)
    } catch (error) {
      this.failUnlessStopped(jobId, error)
    } finally {
      await this.finalizeExecution(jobId)
    }
  }

  /** 取消 queued/running 任务；终态任务保持不变。 */
  async cancel(projectId: string, jobId: string): Promise<DesignJobRecord> {
    const job = this.requireProjectJob(projectId, jobId)
    if (job.terminalState?.status === 'pending') throw new Error('任务已进入结果提交阶段，无法取消')
    if (job.status !== 'queued' && job.status !== 'running') return job
    if (job.sessionId) await this.dependencies.stopAgent(job.sessionId)
    const latest = this.requireProjectJob(projectId, jobId)
    /** stopAgent 等待期间也可能跨过输出提交点，必须再次以最新 journal 判定。 */
    if (latest.terminalState?.status === 'pending') throw new Error('任务已进入结果提交阶段，无法取消')
    if (latest.status !== 'queued' && latest.status !== 'running') return latest
    const cancelled = this.updateStatus(latest, 'cancelled', { error: undefined })
    await this.finalizeExecution(cancelled.id)
    return this.requireProjectJob(projectId, cancelled.id)
  }

  /** 为失败、取消或中断任务创建新 journal，并让原占位节点指向新任务。 */
  retry(projectId: string, jobId: string): DesignJobRecord {
    return this.dependencies.runWorkspaceWrite(projectId, () => {
      let previous = this.requireProjectJob(projectId, jobId)
      if (!previous.imageModelSnapshot) throw new Error('旧任务未记录生图模型，请重新提交')
      if (previous.replacedByJobId) {
        return this.completeRetryIntent(previous)
      }
      if (!['failed', 'cancelled', 'interrupted'].includes(previous.status)) {
        throw new Error('当前设计任务不可重试')
      }
      /** Canvas retry 与新建共用同一目标预留，且忽略当前已终态的旧 attempt。 */
      const releaseReservation = previous.target.kind === 'canvas-image'
        ? this.reserveCanvasImageTarget(projectId, previous.target, new Set([previous.id]))
        : undefined
      try {
        if (previous.target.kind === 'design-canvas') {
          /** 旧 Design 重试继续要求占位节点由当前 attempt 独占。 */
          const current = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
          const ownsNode = current.nodes.some((node) => (
            node.id === requireDesignCanvasTarget(previous).nodeId
            && node.kind === 'job'
            && node.jobId === previous.id
          ))
          if (!ownsNode) throw new Error('设计任务节点已被其他任务接管')
        }
        const replacementId = this.createId()
        if (!isSafeDesignStableId(replacementId)) throw new Error('设计任务 ID 非法')
        const intent: StoredDesignJob = {
          ...previous,
          replacedByJobId: replacementId,
          retryState: { status: 'pending' },
          updatedAt: this.now(),
        }
        try {
          this.writeJob(intent)
          previous = intent
        } catch (error) {
          /** rename 后 durability 报错时以磁盘内容确认 intent 是否已经提交。 */
          const durableIntent = this.readJobJournal(projectId, previous.id)
          if (durableIntent?.replacedByJobId !== replacementId
            || durableIntent.retryState?.status !== 'pending') throw error
          previous = durableIntent
        }
        return this.completeRetryIntent(previous, true)
      } finally {
        releaseReservation?.()
      }
    })
  }

  /** 删除失败、取消或中断任务，并可恢复地同步移除占位节点与 journal。 */
  delete(projectId: string, jobId: string): DesignCanvasDocument {
    return this.dependencies.runWorkspaceWrite(projectId, () => {
      let job = this.requireProjectJob(projectId, jobId)
      if (!['failed', 'cancelled', 'interrupted'].includes(job.status)) {
        throw new Error('当前设计任务不可删除')
      }
      const current = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
      const ownedNode = current.nodes.find((node) => node.id === requireDesignCanvasTarget(job).nodeId)
      if (!ownedNode || ownedNode.kind !== 'job' || ownedNode.jobId !== job.id) {
        throw new Error('设计任务节点已被其他任务接管')
      }
      const pending: StoredDesignJob = {
        ...job,
        deletionState: { status: 'pending' },
        updatedAt: this.now(),
      }
      try {
        this.writeJob(pending)
        job = pending
      } catch (error) {
        /** rename 已完成但目录 durability 报错时，以磁盘内容决定是否继续事务。 */
        const durableIntent = this.readJobJournal(projectId, job.id)
        if (durableIntent?.deletionState?.status !== 'pending') throw error
        job = durableIntent
      }
      return this.completeDeletion(job)
    })
  }

  /**
   * 成功素材删除提交后，以来源 Job 为锚点回收整个创作任务的本地执行记录。
   * @param projectId 已提交素材删除的 Design 项目。
   * @param sourceJobId 被删除素材记录的可信来源 Job ID。
   */
  cleanupTaskAfterSuccessfulAssetDeletion(projectId: string, sourceJobId: string): void {
    this.dependencies.runWorkspaceWrite(projectId, () => {
      let source = this.requireProjectJob(projectId, sourceJobId)
      if (source.status !== 'succeeded') throw new Error('来源 Design Job 不是成功任务')
      const pending: StoredDesignJob = {
        ...source,
        deletionState: { status: 'pending' },
        updatedAt: this.now(),
      }
      try {
        this.writeJob(pending)
        source = pending
      } catch (error) {
        /** rename 已提交时以磁盘 pending 事实继续，避免素材已删但任务无法恢复。 */
        const durableIntent = this.readJobJournal(projectId, source.id)
        if (durableIntent?.deletionState?.status !== 'pending') throw error
        source = durableIntent
      }
      this.deleteTaskPersistence(source)
    })
  }

  /** 在权威画布恢复后，仅二次对账 terminal pending，不中断其它活动任务。 */
  async reconcilePendingTerminals(projectId: string): Promise<DesignJobRecord[]> {
    return this.dependencies.runWorkspaceWrite(projectId, async () => {
      const jobs = this.readProjectJobs(projectId)
      this.rebuildCanvasImageIndex(projectId, jobs)
      for (const job of jobs) {
        if (job.terminalState?.status === 'pending') await this.reconcileTerminalJob(job)
      }
      const reconciled = this.listCachedProjectJobs(projectId)
      await this.finalizeRecoveredTerminals(reconciled)
      return this.listCachedProjectJobs(projectId).map(clonePublicDesignJob)
    })
  }

  /** 恢复单项目 journal，把无法续跑的 running 任务标记为 interrupted。 */
  async recover(projectId: string): Promise<DesignJobRecord[]> {
    return this.dependencies.runWorkspaceWrite(projectId, async () => {
      const jobs = this.readProjectJobs(projectId)
      this.rebuildCanvasImageIndex(projectId, jobs)
      for (const stored of jobs) {
        let job = stored
        if (job.deletionState?.status === 'pending') {
          try {
            this.completeDeletion(job)
          } catch (error) {
            this.warn(`[Design Job 恢复] 项目 ${projectId} 的删除任务 ${job.id} 恢复失败: ${String(error)}`)
          }
          continue
        }
        if (job.placementState === 'pending') {
          const document = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
          const placeholderExists = document.nodes.some((node) => (
            node.id === requireDesignCanvasTarget(job).nodeId && node.kind === 'job' && node.jobId === job.id
          ))
          if (!placeholderExists) {
            this.deleteJobJournal(job)
            continue
          }
          job = { ...job, placementState: 'ready' }
          this.writeJob(job)
        }
        if (job.terminalState?.status === 'pending') {
          await this.reconcileTerminalJob(job)
          continue
        }
        if (job.retryState?.status === 'pending') {
          try {
            /** 本次恢复补建的替代任务，必须在返回用户前收敛为可显式重试的终态。 */
            const replacement = this.completeRetryIntent(job)
            if (replacement.status === 'queued' || replacement.status === 'running') {
              this.updateStatus(replacement, 'interrupted', {
                error: replacement.status === 'queued' ? '应用退出，排队任务已中断' : '应用退出，任务已中断',
              })
            }
          } catch (error) {
            /** retry intent 保留到下次显式重试或恢复继续完成，同时留下项目级诊断。 */
            this.warn(`[Design Job 恢复] 项目 ${projectId} 的重试任务 ${job.id} 恢复失败: ${String(error)}`)
          }
          continue
        }
        if (job.status === 'queued' || job.status === 'running') {
          this.updateStatus(job, 'interrupted', {
            error: job.status === 'queued' ? '应用退出，排队任务已中断' : '应用退出，任务已中断',
          })
        }
      }
      const recovered = this.listCachedProjectJobs(projectId)
      await this.finalizeRecoveredTerminals(recovered)
      return this.listCachedProjectJobs(projectId).map(clonePublicDesignJob)
    })
  }

  /** 启动时恢复全部已登记项目任务。 */
  async recoverAll(): Promise<DesignJobRecord[]> {
    const recovered: DesignJobRecord[] = []
    for (const projectId of this.dependencies.listProjectIds()) {
      try {
        recovered.push(...await this.recover(projectId))
      } catch (error) {
        this.warn(`[Design Job 恢复] 项目 ${projectId} 恢复失败，已继续处理其它项目: ${String(error)}`)
      }
    }
    return recovered
  }

  /** 退出前同步把 running journal 标记为 interrupted。 */
  markRunningInterrupted(): void {
    for (const projectId of this.dependencies.listProjectIds()) {
      try {
        for (const job of this.readProjectJobs(projectId)) {
          if (job.status === 'running') {
            const interrupted = this.updateStatus(job, 'interrupted', { error: '应用退出，任务已中断' })
            void this.finalizeExecution(interrupted.id)
          }
        }
      } catch (error) {
        this.warn(`[Design Job 退出] 项目 ${projectId} 中断写入失败，已继续处理其它项目: ${String(error)}`)
      }
    }
  }

  /** 创建新任务；retry 时复用原节点位置和 ID。 */
  private createInternal(
    input: InternalCreateDesignJobInput,
    imageModelSnapshot?: ImageGenerationModelSnapshot,
    replaced?: StoredDesignJob,
    reservedId?: string,
  ): StoredDesignJob {
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('设计任务提示词不能为空')
    if (input.action === 'edit' && !input.sourceAssetId) throw new Error('编辑任务缺少来源素材')
    const current = this.dependencies.store.requireStableAuthoritativeDocument(input.projectId)
    this.projectRevisions.set(input.projectId, current.revision)
    if (input.sourceAssetId && !current.assets.some((asset) => asset.id === input.sourceAssetId)) {
      throw new Error(`素材不存在: ${input.sourceAssetId}`)
    }
    if (input.maskAnnotationId && !current.annotations.some((item) => (
      item.id === input.maskAnnotationId && item.kind === 'mask'
    ))) throw new Error(`蒙版批注不存在: ${input.maskAnnotationId}`)
    const id = reservedId ?? this.createId()
    if (!isSafeDesignStableId(id)) throw new Error('设计任务 ID 非法')
    /** retry 沿用创作任务身份，首次尝试单独生成跨尝试 ID。 */
    const creativeTaskId = replaced?.creativeTaskId ?? this.createCreativeTaskId()
    if (!isSafeDesignStableId(creativeTaskId) || creativeTaskId === id) {
      throw new Error('Design 创作任务 ID 非法')
    }
    /** 旧 position 与新的 design-canvas 创建目标统一规范化为持久化 target。 */
    const designCanvasPosition = input.target?.kind === 'design-canvas'
      ? input.target.position
      : input.position
    if (!designCanvasPosition) throw new Error('Design 任务缺少画布位置')
    const now = this.now()
    const job: StoredDesignJob = {
      id,
      creativeTaskId,
      attemptNumber: replaced ? replaced.attemptNumber + 1 : 1,
      projectId: input.projectId,
      target: {
        kind: 'design-canvas',
        nodeId: replaced ? requireDesignCanvasTarget(replaced).nodeId : `design-job-${id}`,
        position: replaced ? requireDesignCanvasTarget(replaced).position : designCanvasPosition,
      },
      action: input.action,
      status: 'queued',
      prompt,
      originalRequest: replaced?.originalRequest ?? prompt,
      contextMode: replaced?.contextMode ?? input.contextMode,
      traceState: 'pending',
      executionSessionCleanupState: 'pending',
      ...(imageModelSnapshot ? { imageModelSnapshot: { ...imageModelSnapshot } } : {}),
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId, parentAssetId: input.sourceAssetId } : {}),
      ...(input.maskAnnotationId ? { maskAnnotationId: input.maskAnnotationId } : {}),
      placementState: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    this.writeJob(job)
    const node: DesignCanvasNode = {
      id: requireDesignCanvasTarget(job).nodeId,
      kind: 'job',
      jobId: job.id,
      position: requireDesignCanvasTarget(job).position,
      width: 320,
      height: 240,
      zIndex: replaced
        ? current.nodes.find((item) => item.id === requireDesignCanvasTarget(replaced).nodeId)?.zIndex ?? current.nodes.length
        : current.nodes.length,
    }
    let authoritativeRevision: number
    try {
      const updated = this.dependencies.store.mutate(
        input.projectId,
        current.revision,
        [{ type: 'upsert-nodes', nodes: [node] }],
      )
      authoritativeRevision = updated.revision
    } catch (error) {
      /** durability 报错后先读权威文档；若节点已落盘，则完成 journal 而不是制造孤立节点。 */
      const authoritative = this.dependencies.store.requireStableAuthoritativeDocument(input.projectId)
      const placeholderExists = authoritative.nodes.some((candidate) => (
        candidate.id === node.id && candidate.kind === 'job' && candidate.jobId === job.id
      ))
      if (!placeholderExists) {
        this.deleteJobJournal(job)
        throw error
      }
      authoritativeRevision = authoritative.revision
    }
    this.projectRevisions.set(input.projectId, authoritativeRevision)
    const ready = { ...job, placementState: 'ready' as const }
    this.writeJob(ready)
    this.emit(ready, authoritativeRevision)
    return ready
  }

  /** 按来源会话优先、全局设置兜底解析完整渠道和模型。 */
  private resolveModel(job: StoredDesignJob): { channelId: string; modelId: string } | undefined {
    const source = job.sourceSessionId ? this.dependencies.getSession(job.sourceSessionId) : undefined
    if (source?.workspaceId === job.projectId && source.channelId && source.modelId) {
      return { channelId: source.channelId, modelId: source.modelId }
    }
    const settings = this.dependencies.getSettings()
    return settings.agentChannelId && settings.agentModelId
      ? { channelId: settings.agentChannelId, modelId: settings.agentModelId }
      : undefined
  }

  /** 执行可信模型校验，并阻止未知底层路径进入公开错误或 journal。 */
  private runImageModelValidation<Result>(operation: () => Result): Result {
    return runSafeImageModelOperation(
      operation,
      DESIGN_IMAGE_MODEL_VALIDATION_ERROR,
      (error) => {
        this.logImageModelError('[Design Job 生图模型] 校验失败:', error)
      },
    )
  }

  /** 构建按任务选择上下文、且只允许单次可信图片调用的通用视觉提示。 */
  private buildPrompt(job: StoredDesignJob): string {
    /** 项目指令只从当前任务显式授权的项目根解析，不使用 Agent cwd 或祖先目录。 */
    const projectRoot = this.dependencies.pathResolver.resolve(job.projectId).projectRoot
    const instructionManifest = resolveProjectInstructions({ projectRoot })
    const projectInstructions = instructionManifest.sources.length > 0
      ? instructionManifest.sources.map((source) => [
          `--- ${source.relativePath} ---`,
          source.content,
        ].join('\n')).join('\n\n')
      : '（当前项目根没有可用的项目指令）'
    /** 所有视觉任务共享同一推理要求，避免按开发、平面或漫剧写死固定流程。 */
    const commonInstructions = [
      '你正在执行一个 Design 视觉任务。先理解视觉目标，再决定需要哪些信息。',
      '按当前任务从品牌、产品、代码、角色、故事、场景、连续性或参考资料中选择必要上下文；只读取完成任务所需的最少内容。',
      '调用图片工具时，designSummary 必须使用中文说明视觉判断，prompt 必须是图片模型可直接执行的精确提示词。',
      `只调用一次 ${DESIGN_IMAGE_TOOL}，并返回图片工具结果。`,
      `上下文模式：${job.contextMode}`,
      `项目指令（仅来自显式项目根）：\n${projectInstructions}`,
    ]
    if (job.target.kind === 'canvas-image') {
      /** 比例、尺寸和连线输入只从 journal 的结构化快照编码，不信任 Renderer 隐藏文本。 */
      commonInstructions.push(
        `结构化画面比例：${job.generationConstraints?.aspectRatio ?? '1:1'}`,
        `结构化输出尺寸：${job.generationConstraints?.imageSize ?? 'auto'}`,
        `Canvas 直接入边已提交快照：${JSON.stringify(job.canvasInputReferences ?? [])}`,
      )
    }
    if (job.action === 'generate') {
      return [...commonInstructions, `用户要求：${job.prompt}`].join('\n')
    }
    const sourcePath = this.dependencies.assetService.resolveAssetPath(job.projectId, job.sourceAssetId!)
    const document = this.dependencies.store.requireStableAuthoritativeDocument(job.projectId)
    const annotation = job.maskAnnotationId
      ? document.annotations.find((item) => item.id === job.maskAnnotationId)
      : undefined
    const maskText = annotation?.kind === 'mask'
      ? `\n蒙版 ${annotation.id} 点位：${JSON.stringify(annotation.points)}`
      : ''
    return [...commonInstructions,
      `referenceImagePaths: ${JSON.stringify([sourcePath])}`,
      `编辑要求：${job.prompt}${maskText}`,
    ].join('\n')
  }

  /** 从本轮消息中选择第一张成功且属于当前会话的 Nano Banana 图片。 */
  private findOwnedOutputPath(
    messages: Array<AgentMessage | SDKMessage>,
    sessionId: string,
  ): string | undefined {
    /** SDK 工具结果必须与同一有序消息序列中更早的真实图片工具调用精确关联。 */
    const sdkToolNames = new Map<string, string>()
    for (const message of messages) {
      if ('type' in message) {
        if (message.type === 'assistant') {
          const content = (message as SDKAssistantMessage).message?.content
          if (!Array.isArray(content)) continue
          for (const block of content) {
            if (block.type !== 'tool_use') continue
            const toolUse = block as SDKToolUseBlock
            sdkToolNames.set(toolUse.id, toolUse.name)
          }
          continue
        }
        if (message.type !== 'user') continue
        const content = (message as SDKUserMessage).message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          const result = block as SDKToolResultBlock
          if (sdkToolNames.get(result.tool_use_id) !== DESIGN_IMAGE_TOOL || result.is_error === true) continue
          for (const image of result.imageAttachments ?? []) {
            if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType)) continue
            const path = this.dependencies.resolveOwnedOutputPath(sessionId, image.localPath)
            if (path) return path
          }
        }
        continue
      }
      /** Pi 把工具结果建模为 user/tool_result；旧适配器也可能返回 tool 或 assistant 事件。 */
      if (message.role !== 'assistant' && message.role !== 'tool' && message.role !== 'user') continue
      for (const event of message.events ?? []) {
        if (event.type !== 'tool_result'
          || event.toolName !== DESIGN_IMAGE_TOOL
          || event.isError) continue
        for (const image of event.imageAttachments ?? []) {
          if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType)) continue
          const path = this.dependencies.resolveOwnedOutputPath(sessionId, image.localPath)
          if (path) return path
        }
      }
    }
    return undefined
  }

  /**
   * 在业务终态不变的前提下转存 trace，并在 trace ready 后回收内部会话。
   * 任一附属步骤失败只保留 pending 和诊断，绝不把 succeeded 反写为 failed。
   */
  private async finalizeExecution(jobId: string): Promise<void> {
    let job = this.findStoredJob(jobId)
    if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return
    if (!job.sessionId) {
      if (job.traceState !== 'unavailable' || job.executionSessionCleanupState !== 'completed') {
        this.updateStatus(job, job.status, {
          traceState: 'unavailable',
          executionSessionCleanupState: 'completed',
        })
      }
      return
    }
    /** 会话 ID 在后续异步 journal 更新期间保持为本次执行的固定身份。 */
    const sessionId = job.sessionId
    if (job.traceState !== 'ready') {
      try {
        const messages = this.dependencies.getSessionMessages(sessionId)
        const written = this.dependencies.traceStore.writeFromMessages(job.projectId, job.id, messages)
        job = this.updateStatus(job, job.status, {
          ...written.summary,
          contextReferences: job.contextReferences ?? written.summary.contextReferences,
          designSummary: job.designSummary ?? written.summary.designSummary,
          finalImagePrompt: job.finalImagePrompt ?? written.summary.finalImagePrompt,
          contextWarning: job.contextWarning ?? written.summary.contextWarning,
          traceState: 'ready',
          executionSessionCleanupState: 'pending',
        })
      } catch (error) {
        this.warn(`[Design Job trace] 任务 ${job.id} 转存失败，已保留内部会话: ${String(error)}`)
        return
      }
    }
    if (job.executionSessionCleanupState === 'completed') return
    try {
      await this.dependencies.sessionLifecycle.cleanup({
        sessionId,
        traceState: 'ready',
      })
      this.updateStatus(this.requireJob(job.id), job.status, {
        executionSessionCleanupState: 'completed',
      })
    } catch (error) {
      this.warn(`[Design Job 会话] 任务 ${job.id} 回收失败，已保留待恢复状态: ${String(error)}`)
    }
  }

  /** 等待恢复任务的 trace 转存与内部会话清理全部收束。 */
  private async finalizeRecoveredTerminals(jobs: DesignJobRecord[]): Promise<void> {
    for (const job of jobs) {
      if (TERMINAL_JOB_STATUSES.has(job.status)) await this.finalizeExecution(job.id)
    }
  }

  /** 完成已持久化的任务删除意图，允许重启后幂等续作。 */
  private completeDeletion(job: StoredDesignJob): DesignCanvasDocument {
    const current = this.dependencies.store.requireStableAuthoritativeDocument(job.projectId)
    const node = current.nodes.find((candidate) => candidate.id === requireDesignCanvasTarget(job).nodeId)
    if (!node) {
      this.deleteTaskPersistence(job)
      return current
    }
    if (node.kind !== 'job' || node.jobId !== job.id) {
      throw new Error('设计任务节点已被其他任务接管')
    }
    /** 历史异常分组也随任务节点一起清理，避免留下悬空成员引用。 */
    const affectedGroups = current.groups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => group.nodeIds.includes(node.id))
    const mutations: DesignMutation[] = [{ type: 'remove-nodes', nodeIds: [node.id] }]
    if (affectedGroups.length > 0) {
      mutations.push({
        type: 'patch-groups',
        removeIds: affectedGroups.map(({ group }) => group.id),
        upserts: affectedGroups.flatMap(({ group, index }) => {
          /** 删除后仍有成员的分组保留原索引；空分组直接移除。 */
          const remainingNodeIds = group.nodeIds.filter((nodeId) => nodeId !== node.id)
          return remainingNodeIds.length > 0
            ? [{ entity: { ...group, nodeIds: remainingNodeIds }, index }]
            : []
        }),
      })
    }
    let updated: DesignCanvasDocument
    try {
      updated = this.dependencies.store.mutate(job.projectId, current.revision, mutations)
    } catch (error) {
      /** Store 已提交但 durability 不确定时，按权威节点事实决定是否完成 journal 删除。 */
      const authoritative = this.dependencies.store.requireStableAuthoritativeDocument(job.projectId)
      if (authoritative.nodes.some((candidate) => candidate.id === node.id)) throw error
      updated = authoritative
    }
    this.projectRevisions.set(job.projectId, updated.revision)
    this.deleteTaskPersistence(job)
    return updated
  }

  /**
   * 按 creativeTaskId 幂等删除全部 attempt trace 与 journal。
   * 发起删除的 journal 最后移除，使中途失败仍保留可恢复意图。
   */
  private deleteTaskPersistence(anchor: StoredDesignJob): void {
    const attempts = this.readProjectJobs(anchor.projectId)
      .filter((candidate) => candidate.creativeTaskId === anchor.creativeTaskId)
    /** trace 先于 journal 删除，避免 journal 消失后失去 trace 定位事实。 */
    for (const attempt of attempts) {
      this.dependencies.traceStore.delete(anchor.projectId, attempt.id)
    }
    /** 删除锚点最后执行，任何前序失败都能由 deletionState 继续恢复。 */
    const ordered = [
      ...attempts.filter((attempt) => attempt.id !== anchor.id),
      ...attempts.filter((attempt) => attempt.id === anchor.id),
    ]
    for (const attempt of ordered) this.deleteJobJournal(attempt)
  }

  /** 导入已验证归属图片，并在同一 Store mutation 中替换占位节点。 */
  private async commitOutput(job: StoredDesignJob, sessionId: string, outputPath: string): Promise<void> {
    await this.dependencies.runWorkspaceWrite(job.projectId, async () => {
      const source: DesignAssetImportSource = {
        kind: 'job',
        sourceJobId: job.id,
        sourceSessionId: sessionId,
        ...(job.sourceAssetId ? { parentAssetId: job.sourceAssetId } : {}),
        prompt: job.prompt,
      }
      const batch = await this.dependencies.assetService.importAuthorizedFiles(job.projectId, [outputPath], source)
      const latest = this.requireJob(job.id)
      if (latest.status === 'cancelled' || latest.status === 'interrupted') {
        batch.rollback()
        return
      }
      const asset = batch[0]
      if (!asset) {
        batch.rollback()
        this.updateStatus(latest, 'failed', { error: DESIGN_JOB_OUTPUT_ERROR })
        return
      }
      if (job.target.kind === 'canvas-image') {
        await this.commitCanvasImageOutput(job, latest, asset, batch)
        return
      }
      const current = this.dependencies.store.requireStableAuthoritativeDocument(job.projectId)
      const placeholder = current.nodes.find((node) => node.id === requireDesignCanvasTarget(job).nodeId && node.jobId === job.id)
      if (!placeholder) {
        batch.rollback()
        this.updateStatus(latest, 'failed', { error: '设计任务占位节点不存在' })
        return
      }
      const assetNode: DesignCanvasNode = {
        ...placeholder,
        kind: 'asset',
        assetId: asset.id,
        jobId: undefined,
      }
      const pending = this.updateStatus(latest, latest.status, {
        terminalState: { status: 'pending', outputAssetId: asset.id },
      }, current.revision)
      try {
        const updatedDocument = this.dependencies.store.mutate(job.projectId, current.revision, [
          { type: 'upsert-assets', assets: [asset] },
          { type: 'upsert-nodes', nodes: [assetNode] },
        ])
        this.projectRevisions.set(job.projectId, updatedDocument.revision)
        batch.commit()
        this.updateStatus(pending, 'succeeded', {
          terminalState: undefined,
          outputAssetId: asset.id,
          parentAssetId: job.sourceAssetId,
          error: undefined,
        }, updatedDocument.revision)
      } catch (error) {
        let authoritative: DesignCanvasDocument
        try {
          authoritative = this.dependencies.store.requireStableAuthoritativeDocument(job.projectId)
        } catch {
          /** Store 是否已提交无法确认；保留 journal 与 batch，交给恢复流程按事实对账。 */
          return
        }
        if (this.isTerminalCommitPresent(authoritative, pending, asset.id)) {
          batch.commit()
          this.updateStatus(pending, 'succeeded', {
            terminalState: undefined,
            outputAssetId: asset.id,
            parentAssetId: job.sourceAssetId,
            error: undefined,
          }, authoritative.revision)
          return
        }
        batch.rollback()
        this.updateStatus(pending, 'failed', {
          terminalState: undefined,
          error: error instanceof Error ? error.message : String(error),
        }, authoritative.revision)
      }
    })
  }

  /** Canvas 图片输出只登记共享 Asset，再采用到独立模块，不创建旧 Design 节点。 */
  private async commitCanvasImageOutput(
    job: StoredDesignJob,
    latest: StoredDesignJob,
    asset: DesignAsset,
    batch: DesignAssetImportBatch,
  ): Promise<void> {
    const targetAdapter = this.dependencies.canvasImageTargetAdapter
    if (!targetAdapter || job.target.kind !== 'canvas-image') {
      batch.rollback()
      throw new Error('Canvas 图片任务执行边界未初始化')
    }
    /** 先持久化 terminal pending，后续每一步都能按 Asset 和模块事实对账。 */
    const current = this.dependencies.store.requireStableAuthoritativeDocument(job.projectId)
    const pending = this.updateStatus(latest, latest.status, {
      terminalState: { status: 'pending', outputAssetId: asset.id },
    }, current.revision)
    try {
      /** 旧 Design 只登记共享 Asset，节点数组保持完全不变。 */
      const updatedDocument = this.dependencies.store.mutate(job.projectId, current.revision, [
        { type: 'upsert-assets', assets: [asset] },
      ])
      this.projectRevisions.set(job.projectId, updatedDocument.revision)
      await targetAdapter.adoptOutput(job.projectId, job.target, asset.id)
      batch.commit()
      this.updateStatus(pending, 'succeeded', {
        terminalState: undefined,
        outputAssetId: asset.id,
        parentAssetId: job.sourceAssetId,
        error: undefined,
      }, updatedDocument.revision)
    } catch (error) {
      let authoritative: DesignCanvasDocument
      try {
        authoritative = this.dependencies.store.requireStableAuthoritativeDocument(job.projectId)
      } catch {
        /** Asset 是否提交无法确认时保留 batch 与 pending，等待恢复继续对账。 */
        return
      }
      const assetExists = authoritative.assets.some((candidate) => (
        candidate.id === asset.id && candidate.sourceJobId === job.id
      ))
      if (!assetExists) {
        batch.rollback()
        this.updateStatus(pending, 'failed', {
          terminalState: undefined,
          error: error instanceof Error ? error.message : String(error),
        }, authoritative.revision)
        return
      }
      /** Asset 已进入权威 Store 后必须保留文件；采用失败由 pending 恢复重放。 */
      batch.commit()
      try {
        if (await targetAdapter.isOutputAdopted(job.projectId, job.target, asset.id)) {
          this.updateStatus(pending, 'succeeded', {
            terminalState: undefined,
            outputAssetId: asset.id,
            parentAssetId: job.sourceAssetId,
            error: undefined,
          }, authoritative.revision)
        }
      } catch {
        /** 模块或 Canvas 暂不可读时继续保留 terminal pending。 */
      }
    }
  }

  /** 判断 Store 是否同时持有当前任务输出素材及其替换后的画布节点。 */
  private isTerminalCommitPresent(
    document: DesignCanvasDocument,
    job: StoredDesignJob,
    outputAssetId: string,
  ): boolean {
    const assetExists = document.assets.some((asset) => (
      asset.id === outputAssetId && asset.sourceJobId === job.id
    ))
    const nodeExists = document.nodes.some((node) => (
      node.id === requireDesignCanvasTarget(job).nodeId && node.kind === 'asset' && node.assetId === outputAssetId
    ))
    return assetExists && nodeExists
  }

  /** 按 Store 当前事实完成一次 terminal pending 对账。 */
  private async reconcileTerminalJob(job: StoredDesignJob): Promise<void> {
    if (job.target.kind === 'canvas-image') {
      await this.reconcileCanvasImageTerminalJob(job)
      return
    }
    try {
      const document = this.dependencies.store.requireStableAuthoritativeDocument(job.projectId)
      const outputAssetId = job.terminalState?.outputAssetId
      if (!outputAssetId) return
      if (this.isTerminalCommitPresent(document, job, outputAssetId)) {
        this.updateStatus(job, 'succeeded', {
          terminalState: undefined,
          outputAssetId,
          parentAssetId: job.sourceAssetId,
          error: undefined,
        }, document.revision)
      } else {
        this.updateStatus(job, 'failed', {
          terminalState: undefined,
          error: '设计任务终态提交未完成',
        }, document.revision)
      }
    } catch {
      /** 权威 Store 暂不可读时保留 pending，等待显式加载或下次恢复继续对账。 */
    }
  }

  /** 按共享 Asset 和模块采用事实异步收敛 Canvas terminal pending。 */
  private async reconcileCanvasImageTerminalJob(job: StoredDesignJob): Promise<void> {
    try {
      const outputAssetId = job.terminalState?.outputAssetId
      const targetAdapter = this.dependencies.canvasImageTargetAdapter
      if (!outputAssetId || !targetAdapter || job.target.kind !== 'canvas-image') return
      /** Design Store 只需持有该 Job 导入的共享 Asset。 */
      const document = this.dependencies.store.requireStableAuthoritativeDocument(job.projectId)
      const assetExists = document.assets.some((asset) => (
        asset.id === outputAssetId && asset.sourceJobId === job.id
      ))
      if (!assetExists) {
        this.updateStatus(job, 'failed', {
          terminalState: undefined,
          error: '设计任务终态提交未完成',
        }, document.revision)
        return
      }
      if (!await targetAdapter.isOutputAdopted(job.projectId, job.target, outputAssetId)) {
        await targetAdapter.adoptOutput(job.projectId, job.target, outputAssetId)
      }
      if (!await targetAdapter.isOutputAdopted(job.projectId, job.target, outputAssetId)) return
      this.updateStatus(job, 'succeeded', {
        terminalState: undefined,
        outputAssetId,
        parentAssetId: job.sourceAssetId,
        error: undefined,
      }, document.revision)
    } catch {
      /** 权威 Asset 或 Canvas 模块暂不可读时保留 pending，等待下次显式恢复。 */
    }
  }

  /** 按已持久化 replacement ID 幂等创建或返回替代任务。 */
  private completeRetryIntent(previous: StoredDesignJob, canvasReservationHeld = false): StoredDesignJob {
    if (!previous.imageModelSnapshot) throw new Error('旧任务未记录生图模型，请重新提交')
    const replacementId = previous.replacedByJobId
    if (!replacementId || previous.retryState?.status !== 'pending') {
      if (replacementId) return this.requireProjectJob(previous.projectId, replacementId)
      throw new Error('设计任务重试 intent 无效')
    }
    if (previous.target.kind === 'canvas-image') {
      /** 恢复 pending intent 时自行预留；显式 retry 已从 intent 写入前持有同一预留。 */
      const releaseReservation = !canvasReservationHeld && !this.findStoredJob(replacementId)
        ? this.reserveCanvasImageTarget(previous.projectId, previous.target, new Set([previous.id]))
        : undefined
      try {
        return this.completeCanvasImageRetryIntent(previous, replacementId)
      } finally {
        releaseReservation?.()
      }
    }
    const existing = this.findStoredJob(replacementId)
    if (existing) {
      if (existing.projectId !== previous.projectId) throw new Error('替代设计任务不属于当前项目')
      const current = this.dependencies.store.requireStableAuthoritativeDocument(previous.projectId)
      const replacementOwnsNode = current.nodes.some((node) => (
        node.id === requireDesignCanvasTarget(previous).nodeId && node.kind === 'job' && node.jobId === replacementId
      ))
      if (replacementOwnsNode) {
        const ready = existing.placementState === 'ready'
          ? existing
          : { ...existing, placementState: 'ready' as const, updatedAt: this.now() }
        if (ready !== existing) this.writeJob(ready)
        this.finalizeRetryIntent(previous)
        return ready
      }
      const previousOwnsNode = current.nodes.some((node) => (
        node.id === requireDesignCanvasTarget(previous).nodeId && node.kind === 'job' && node.jobId === previous.id
      ))
      if (!previousOwnsNode || existing.placementState !== 'pending') {
        throw new Error('设计任务节点已被其他任务接管')
      }
      /** replacement journal 已提交但 Store 尚未接管，删除孤立 pending 后用同一 ID 续建。 */
      this.deleteJobJournal(existing)
    }
    const current = this.dependencies.store.requireStableAuthoritativeDocument(previous.projectId)
    const ownsNode = current.nodes.some((node) => (
      node.id === requireDesignCanvasTarget(previous).nodeId && node.kind === 'job' && node.jobId === previous.id
    ))
    if (!ownsNode) throw new Error('设计任务节点已被其他任务接管')
    const replacement = this.createInternal({
      projectId: previous.projectId,
      action: previous.action,
      prompt: previous.prompt,
      contextMode: previous.contextMode,
      ...(previous.sourceSessionId ? { sourceSessionId: previous.sourceSessionId } : {}),
      ...(previous.sourceAssetId ? { sourceAssetId: previous.sourceAssetId } : {}),
      ...(previous.maskAnnotationId ? { maskAnnotationId: previous.maskAnnotationId } : {}),
      target: {
        kind: 'design-canvas',
        position: requireDesignCanvasTarget(previous).position,
      },
    }, previous.imageModelSnapshot, previous, replacementId)
    this.finalizeRetryIntent(previous)
    return replacement
  }

  /** 按固化 journal 幂等创建 Canvas 图片模块的替代 attempt。 */
  private completeCanvasImageRetryIntent(
    previous: StoredDesignJob,
    replacementId: string,
  ): StoredDesignJob {
    if (previous.target.kind !== 'canvas-image') throw new Error('Canvas 图片任务目标无效')
    /** 显式保存收窄后的原目标，供 existing 分支和 replacement 快照复用。 */
    const previousTarget = previous.target
    /** 已写 replacement 时直接复用，禁止重复任务与付费运行。 */
    const existing = this.findStoredJob(replacementId)
    if (existing) {
      if (existing.projectId !== previous.projectId
        || !isSameCanvasImageTarget(existing.target, previousTarget)) {
        throw new Error('替代 Canvas 图片任务归属异常')
      }
      this.finalizeRetryIntent(previous)
      return existing
    }
    /** Canvas retry 不读取当前可编辑配置，只复制原 attempt 的完整执行快照。 */
    const now = this.now()
    const replacement: StoredDesignJob = {
      ...previous,
      id: replacementId,
      attemptNumber: previous.attemptNumber + 1,
      status: 'queued',
      target: { ...previous.target },
      generationConstraints: previous.generationConstraints
        ? { ...previous.generationConstraints }
        : undefined,
      canvasInputReferences: previous.canvasInputReferences?.map((reference) => ({ ...reference })),
      imageModelSnapshot: previous.imageModelSnapshot ? { ...previous.imageModelSnapshot } : undefined,
      sessionId: undefined,
      outputAssetId: undefined,
      parentAssetId: previous.sourceAssetId,
      error: undefined,
      traceState: 'pending',
      executionSessionCleanupState: 'pending',
      contextReferences: undefined,
      contextWarning: undefined,
      designSummary: undefined,
      finalImagePrompt: undefined,
      rawThinkingAvailable: undefined,
      startedAt: undefined,
      completedAt: undefined,
      terminalState: undefined,
      replacedByJobId: undefined,
      retryState: undefined,
      deletionState: undefined,
      createdAt: now,
      updatedAt: now,
    }
    this.writeJob(replacement)
    this.emit(replacement)
    this.finalizeRetryIntent(previous)
    return replacement
  }

  /**
   * 原子预留一个 Canvas 图片模块创建槽位。
   * @param projectId 目标项目 ID。
   * @param target Canvas 图片任务目标。
   * @param ignoredJobIds 冲突扫描中忽略的终态或已知任务 ID。
   * @returns 释放当前预留的幂等函数。
   */
  private reserveCanvasImageTarget(
    projectId: string,
    target: CanvasImageJobTarget,
    ignoredJobIds = new Set<string>(),
  ): () => void {
    /** key 只包含模块业务身份，节点重建也不能绕过同一配置的互斥。 */
    const reservationKey = createCanvasImageReservationKey(projectId, target)
    if (this.canvasImageReservations.has(reservationKey)) throw new Error('图片模块已有进行中任务')
    this.ensureCanvasImageIndex(projectId)
    const conflicting = this.listCachedProjectJobs(projectId).find((job) => (
      !ignoredJobIds.has(job.id)
      && isSameCanvasImageModule(job.target, target)
      && (job.status === 'queued' || job.status === 'running' || job.terminalState?.status === 'pending')
    ))
    if (conflicting) throw new Error('图片模块已有进行中任务')
    this.canvasImageReservations.add(reservationKey)
    let released = false
    return () => {
      if (released) return
      released = true
      this.canvasImageReservations.delete(reservationKey)
    }
  }

  /** 尝试清除已完成 retry intent；失败时 pending intent 仍可幂等返回 replacement。 */
  private finalizeRetryIntent(previous: StoredDesignJob): void {
    try {
      this.writeJob({ ...previous, retryState: undefined, updatedAt: this.now() })
    } catch {
      /** replacement 与 pending intent 已持久化，清理失败不反报任务创建失败。 */
    }
  }

  /** 写入新状态并通知订阅者。 */
  private updateStatus(
    job: StoredDesignJob,
    status: StoredDesignJob['status'],
    updates: Partial<StoredDesignJob>,
    revision?: number,
  ): StoredDesignJob {
    /** 同一次状态写复用同一时间，避免 startedAt/completedAt 与 updatedAt 漂移。 */
    const now = this.now()
    const next: StoredDesignJob = {
      ...job,
      ...updates,
      status,
      ...(status === 'running' && job.startedAt === undefined ? { startedAt: now } : {}),
      ...(TERMINAL_JOB_STATUSES.has(status) && job.completedAt === undefined ? { completedAt: now } : {}),
      updatedAt: now,
    }
    this.writeJob(next)
    this.emit(next, revision)
    return next
  }

  /** 任意运行阶段异常都收敛到 failed；用户取消和退出中断保持已有终态。 */
  private failUnlessStopped(jobId: string, error: unknown): void {
    const latest = this.requireJob(jobId)
    if (latest.status === 'cancelled' || latest.status === 'interrupted' || latest.status === 'failed') return
    this.updateStatus(latest, 'failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  /** 原子持久化单个任务 journal。 */
  private writeJob(job: StoredDesignJob): void {
    if (!isStoredDesignJob(job)) throw new Error('拒绝写入无效设计任务 journal')
    /** 内存缓存与 JSON journal 使用完全相同的可选字段形状。 */
    const persistedJob = JSON.parse(JSON.stringify(job)) as StoredDesignJob
    const path = this.resolveJobJournalPath(job.projectId, job.id)
    const directoryPath = this.dependencies.pathResolver.resolve(job.projectId).jobsDir
    mkdirSync(directoryPath, { recursive: true })
    const writeJournal = this.dependencies.writeJobJournal
      ?? ((journalPath: string, value: object): void => { writeJsonFileAtomic(journalPath, value, true) })
    writeJournal(path, persistedJob)
    this.jobs.set(persistedJob.id, persistedJob)
    if (this.indexedCanvasImageProjects.has(persistedJob.projectId)) this.indexCanvasImageJob(persistedJob)
  }

  /** 删除未建立占位节点的 pending journal 与内存索引。 */
  private deleteJobJournal(job: StoredDesignJob): void {
    const path = this.resolveJobJournalPath(job.projectId, job.id)
    removeFileAtomic(path)
    this.jobs.delete(job.id)
    if (this.indexedCanvasImageProjects.has(job.projectId)) this.removeCanvasImageJobFromIndex(job)
  }

  /** 读取项目全部合法 journal。 */
  private readProjectJobs(projectId: string): StoredDesignJob[] {
    const directoryPath = this.dependencies.pathResolver.resolve(projectId).jobsDir
    if (!existsSync(directoryPath)) return []
    const jobs: StoredDesignJob[] = []
    const readDirectory = this.dependencies.readJobsDirectory ?? readdirSync
    for (const name of readDirectory(directoryPath)) {
      if (!name.endsWith('.json')) continue
      /** 文件 basename 是 journal ID 的第一份所有权事实。 */
      const fileJobId = name.slice(0, -'.json'.length)
      if (!isSafeDesignStableId(fileJobId)) continue
      const value = this.readJobJournal(projectId, fileJobId)
      if (value) jobs.push(value)
    }
    return jobs
  }

  /** 从确定路径严格读取单个 journal，并同步内存索引。 */
  private readJobJournal(projectId: string, jobId: string): StoredDesignJob | undefined {
    try {
      const path = this.resolveJobJournalPath(projectId, jobId)
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
      const normalized = normalizeStoredDesignJob(value)
      if (!normalized || normalized.projectId !== projectId || normalized.id !== jobId) return undefined
      this.jobs.set(normalized.id, normalized)
      if (this.indexedCanvasImageProjects.has(projectId)) this.indexCanvasImageJob(normalized)
      return normalized
    } catch {
      return undefined
    }
  }

  /** 从内存或已登记项目磁盘中查找任务。 */
  private findStoredJob(jobId: string): StoredDesignJob | undefined {
    if (!isSafeDesignStableId(jobId)) return undefined
    const cached = this.jobs.get(jobId)
    if (cached) return cached
    for (const projectId of this.dependencies.listProjectIds()) {
      const found = this.readProjectJobs(projectId).find((job) => job.id === jobId)
      if (found) return found
    }
    return undefined
  }

  /** 要求任务存在。 */
  private requireJob(jobId: string): StoredDesignJob {
    const job = this.findStoredJob(jobId)
    if (!job) throw new Error(`设计任务不存在: ${jobId}`)
    return job
  }

  /** 要求任务属于调用项目。 */
  private requireProjectJob(projectId: string, jobId: string): StoredDesignJob {
    const job = this.requireJob(jobId)
    if (job.projectId !== projectId) throw new Error('设计任务不属于当前项目')
    return job
  }

  /** 首次目标查询时扫描一次项目 journal 并建立完整四元目标索引。 */
  private ensureCanvasImageIndex(projectId: string): void {
    if (this.indexedCanvasImageProjects.has(projectId)) return
    const jobs = this.readProjectJobs(projectId)
    this.rebuildCanvasImageIndex(projectId, jobs)
  }

  /** 用一次权威 journal 扫描结果替换单项目 Canvas 图片目标索引。 */
  private rebuildCanvasImageIndex(projectId: string, jobs: StoredDesignJob[]): void {
    /** 项目级扫描是磁盘权威事实，必须同步淘汰已缺失或损坏的旧缓存。 */
    for (const [jobId, cached] of this.jobs) {
      if (cached.projectId === projectId) this.jobs.delete(jobId)
    }
    for (const job of jobs) this.jobs.set(job.id, job)
    const previousKeys = this.canvasImageTargetKeysByProject.get(projectId) ?? new Set<string>()
    for (const key of previousKeys) this.canvasImageJobIdsByTarget.delete(key)
    for (const [jobId, key] of this.canvasImageTargetKeyByJobId) {
      if (previousKeys.has(key)) this.canvasImageTargetKeyByJobId.delete(jobId)
    }
    this.canvasImageTargetKeysByProject.set(projectId, new Set())
    this.indexedCanvasImageProjects.add(projectId)
    for (const job of jobs) this.indexCanvasImageJob(job)
  }

  /** 写入或状态变化后把单条任务增量同步到目标索引。 */
  private indexCanvasImageJob(job: StoredDesignJob): void {
    this.removeCanvasImageJobFromIndex(job)
    if (job.target.kind !== 'canvas-image') return
    const key = createCanvasImageTargetKey(job.projectId, job.target)
    const jobIds = this.canvasImageJobIdsByTarget.get(key) ?? new Set<string>()
    jobIds.add(job.id)
    this.canvasImageJobIdsByTarget.set(key, jobIds)
    const projectKeys = this.canvasImageTargetKeysByProject.get(job.projectId) ?? new Set<string>()
    projectKeys.add(key)
    this.canvasImageTargetKeysByProject.set(job.projectId, projectKeys)
    this.canvasImageTargetKeyByJobId.set(job.id, key)
  }

  /** 删除任务或覆盖目标前移除旧索引项，不影响同目标其它 attempt。 */
  private removeCanvasImageJobFromIndex(job: Pick<StoredDesignJob, 'id' | 'projectId'>): void {
    const previousKey = this.canvasImageTargetKeyByJobId.get(job.id)
    if (!previousKey) return
    this.canvasImageTargetKeyByJobId.delete(job.id)
    const jobIds = this.canvasImageJobIdsByTarget.get(previousKey)
    jobIds?.delete(job.id)
    if (jobIds && jobIds.size > 0) return
    this.canvasImageJobIdsByTarget.delete(previousKey)
    this.canvasImageTargetKeysByProject.get(job.projectId)?.delete(previousKey)
  }

  /** 从本轮已扫描和增量维护的内存事实读取项目任务，避免 recover 重复扫盘。 */
  private listCachedProjectJobs(projectId: string): StoredDesignJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.projectId === projectId)
      .sort(compareDesignJobs)
  }

  /** 通知全部状态监听器。 */
  private emit(job: StoredDesignJob, revision?: number): void {
    /** 结构 mutation 直接传入返回 revision；纯状态事件复用最近权威值。 */
    const authoritativeRevision = revision
      ?? this.projectRevisions.get(job.projectId)
      ?? this.dependencies.store.requireStableAuthoritativeDocument(job.projectId).revision
    this.projectRevisions.set(job.projectId, authoritativeRevision)
    for (const listener of this.listeners) listener({ job, revision: authoritativeRevision })
  }

  /** 解析并复核 journal 最终路径始终位于当前项目 jobsDir 单层内。 */
  private resolveJobJournalPath(projectId: string, jobId: string): string {
    if (!isSafeDesignStableId(jobId)) throw new Error('设计任务 ID 非法')
    const directoryPath = this.dependencies.pathResolver.resolve(projectId).jobsDir
    if (!isAbsolute(directoryPath) || resolve(directoryPath) !== directoryPath) {
      throw new Error('设计任务 journal 目录无效')
    }
    const path = resolve(directoryPath, `${jobId}.json`)
    const contained = relative(directoryPath, path)
    if (!contained || contained === '..' || contained.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(contained)) throw new Error('设计任务 journal 路径越界')
    return path
  }
}

/** 判断未知值是否为有限二维坐标。 */
function isStoredPoint(value: unknown): value is DesignPoint {
  if (!isRecord(value)) return false
  return Object.keys(value).length === 2
    && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
}

/** 判断可选 journal ID 字段是否缺失或为安全稳定 ID。 */
function isOptionalStableId(value: unknown): value is string | undefined {
  return value === undefined || isSafeDesignStableId(value)
}

/** 严格校验 journal 中不含凭据的生图模型快照。 */
function isImageModelSnapshot(value: unknown): value is ImageGenerationModelSnapshot {
  if (!isRecord(value)) return false
  /** 两种 snapshot 共享的公开字段必须严格有效。 */
  const baseValid = typeof value.profileId === 'string'
    && value.profileId.length > 0
    && value.profileId === value.profileId.trim()
    && typeof value.name === 'string'
    && value.name.trim().length > 0
    && value.name.length <= IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH
    && typeof value.modelId === 'string'
    && value.modelId.length > 0
    && value.modelId.length <= IMAGE_GENERATION_MODEL_ID_MAX_LENGTH
    && value.modelId === value.modelId.trim()
  if (!baseValid) return false
  if (value.executor === 'nano-banana') return Object.keys(value).length === 4
  return value.executor === 'openai-images'
    && typeof value.channelId === 'string'
    && value.channelId.length > 0
    && value.channelId === value.channelId.trim()
    && Object.keys(value).length === 5
}

/** 严格校验新 journal 的双目标联合。 */
function isDesignJobTarget(value: unknown): value is DesignJobTarget {
  if (!isRecord(value)) return false
  if (value.kind === 'design-canvas') {
    return Object.keys(value).length === 3
      && isSafeDesignStableId(value.nodeId)
      && isStoredPoint(value.position)
  }
  return value.kind === 'canvas-image'
    && Object.keys(value).length === 4
    && isSafeDesignStableId(value.canvasId)
    && isSafeDesignStableId(value.nodeId)
    && isSafeDesignStableId(value.imageModuleId)
}

/** 判断两个任务目标是否指向同一 Canvas 图片模块。 */
function isSameCanvasImageTarget(
  left: DesignJobTarget,
  right: CanvasImageJobTarget,
): boolean {
  return left.kind === 'canvas-image'
    && left.canvasId === right.canvasId
    && left.nodeId === right.nodeId
    && left.imageModuleId === right.imageModuleId
}

/** 判断任务是否占用同一 Canvas 图片模块业务身份。 */
function isSameCanvasImageModule(
  left: DesignJobTarget,
  right: CanvasImageJobTarget,
): boolean {
  return left.kind === 'canvas-image'
    && left.canvasId === right.canvasId
    && left.imageModuleId === right.imageModuleId
}

/** 创建进程内目标预留键，数组编码避免分隔符碰撞。 */
function createCanvasImageReservationKey(projectId: string, target: CanvasImageJobTarget): string {
  return JSON.stringify([projectId, target.canvasId, target.imageModuleId])
}

/** 创建包含节点绑定的完整 Canvas 图片目标索引键。 */
function createCanvasImageTargetKey(
  projectId: string,
  target: Pick<CanvasImageTarget, 'canvasId' | 'nodeId' | 'imageModuleId'>,
): string {
  return JSON.stringify([projectId, target.canvasId, target.nodeId, target.imageModuleId])
}

/** 任务目标查询使用创建时间和稳定 ID 确保跨平台顺序一致。 */
function compareDesignJobs(left: StoredDesignJob, right: StoredDesignJob): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

/** 通过 JSON 公开边界复制任务，并删除未定义的可选内部字段。 */
function clonePublicDesignJob(job: StoredDesignJob): DesignJobRecord {
  return JSON.parse(JSON.stringify(job)) as DesignJobRecord
}

/** 把 journal 目标补全为 Canvas Store 使用的四重身份。 */
function toCanvasImageTarget(
  projectId: string,
  target: CanvasImageJobTarget,
): CanvasImageTarget {
  return {
    projectId,
    canvasId: target.canvasId,
    nodeId: target.nodeId,
    imageModuleId: target.imageModuleId,
  }
}

/** 严格校验 journal 内单条 Canvas 直接入边快照。 */
function isCanvasImageInputReference(value: unknown): boolean {
  if (!isRecord(value)) return false
  const allowedFields = new Set(['nodeId', 'kind', 'revision', 'summary', 'summaryHash', 'assetId'])
  if (Object.keys(value).some((field) => !allowedFields.has(field))) return false
  if (!isSafeDesignStableId(value.nodeId)
    || !['agent', 'image', 'document', 'webview'].includes(String(value.kind))
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || typeof value.summary !== 'string'
    || value.summary.length === 0
    || value.summary.length > CANVAS_IMAGE_INPUT_MAX_TEXT
    || typeof value.summaryHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.summaryHash)) return false
  return value.assetId === undefined || isSafeDesignStableId(value.assetId)
}

/** Design 专属操作必须显式取得旧画布目标，禁止 Canvas 任务误入布局逻辑。 */
function requireDesignCanvasTarget(
  job: StoredDesignJob,
): Extract<DesignJobTarget, { kind: 'design-canvas' }> {
  if (job.target.kind !== 'design-canvas') throw new Error('Canvas 图片任务不属于旧 Design 画布')
  return job.target
}

/** 严格解析完整 Design Job journal schema。 */
function isStoredDesignJob(value: unknown): value is StoredDesignJob {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((field) => !STORED_JOB_FIELDS.has(field))) return false
  if (REQUIRED_STORED_JOB_FIELDS.some((field) => !Object.hasOwn(value, field))) return false
  if (!isSafeDesignStableId(value.creativeTaskId)
    || typeof value.attemptNumber !== 'number'
    || !Number.isSafeInteger(value.attemptNumber)
    || value.attemptNumber < 1
    || typeof value.originalRequest !== 'string'
    || value.originalRequest.trim().length === 0
    || !['auto', 'project', 'none'].includes(String(value.contextMode))) return false
  if (value.traceState !== undefined && !['pending', 'ready', 'unavailable'].includes(String(value.traceState))) {
    return false
  }
  if (value.executionSessionCleanupState !== undefined
    && value.executionSessionCleanupState !== 'pending'
    && value.executionSessionCleanupState !== 'completed') return false
  for (const field of ['designSummary', 'finalImagePrompt', 'contextWarning'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return false
  }
  if (value.rawThinkingAvailable !== undefined && typeof value.rawThinkingAvailable !== 'boolean') return false
  if (value.startedAt !== undefined && (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt))) return false
  if (value.completedAt !== undefined && (typeof value.completedAt !== 'number' || !Number.isFinite(value.completedAt))) return false
  if (value.contextReferences !== undefined && !Array.isArray(value.contextReferences)) return false
  if (!isSafeDesignStableId(value.id) || !isSafeDesignStableId(value.projectId)) return false
  if (!['generate', 'edit'].includes(String(value.action))) return false
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(value.status))) return false
  if (typeof value.prompt !== 'string' || value.prompt.trim().length === 0) return false
  if (!isDesignJobTarget(value.target)) return false
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return false
  for (const field of [
    'sessionId', 'sourceSessionId', 'sourceAssetId', 'parentAssetId', 'outputAssetId',
    'maskAnnotationId', 'replacedByJobId',
  ] as const) {
    if (!isOptionalStableId(value[field])) return false
  }
  if (value.error !== undefined && typeof value.error !== 'string') return false
  if (value.imageModelSnapshot !== undefined && !isImageModelSnapshot(value.imageModelSnapshot)) return false
  if (value.generationConstraints !== undefined) {
    if (!isRecord(value.generationConstraints)
      || Object.keys(value.generationConstraints).length !== 2
      || !['1:1', '16:9', '4:3', '9:16', '3:4'].includes(String(value.generationConstraints.aspectRatio))
      || !['auto', '1K', '2K', '4K'].includes(String(value.generationConstraints.imageSize))) return false
  }
  if (value.canvasImageConfigRevision !== undefined
    && (!Number.isSafeInteger(value.canvasImageConfigRevision)
      || (value.canvasImageConfigRevision as number) < 0)) return false
  if (value.canvasInputReferences !== undefined) {
    if (!Array.isArray(value.canvasInputReferences)
      || value.canvasInputReferences.length > CANVAS_IMAGE_INPUT_MAX_REFERENCES
      || !value.canvasInputReferences.every(isCanvasImageInputReference)) return false
    /** journal 读取也执行解析器的总文本与媒体硬上限，拒绝手工膨胀输入。 */
    const totalText = value.canvasInputReferences.reduce((sum, reference) => (
      sum + (reference as { summary: string }).summary.length
    ), 0)
    const mediaCount = value.canvasInputReferences.filter((reference) => (
      (reference as { assetId?: string }).assetId !== undefined
    )).length
    if (totalText > CANVAS_IMAGE_INPUT_MAX_TEXT || mediaCount > CANVAS_IMAGE_INPUT_MAX_MEDIA) return false
  }
  if (value.placementState !== undefined && value.placementState !== 'pending' && value.placementState !== 'ready') return false
  if (value.terminalState !== undefined) {
    if (!isRecord(value.terminalState)
      || Object.keys(value.terminalState).length !== 2
      || value.terminalState.status !== 'pending'
      || !isSafeDesignStableId(value.terminalState.outputAssetId)) return false
  }
  if (value.retryState !== undefined) {
    if (!isRecord(value.retryState)
      || Object.keys(value.retryState).length !== 1
      || value.retryState.status !== 'pending'
      || !isSafeDesignStableId(value.replacedByJobId)) return false
  }
  if (value.deletionState !== undefined) {
    if (!isRecord(value.deletionState)
      || Object.keys(value.deletionState).length !== 1
      || value.deletionState.status !== 'pending'
      || !TERMINAL_JOB_STATUSES.has(value.status as DesignJobRecord['status'])) return false
  }
  if (value.action === 'edit' && !isSafeDesignStableId(value.sourceAssetId)) return false
  if (value.status === 'succeeded' && !isSafeDesignStableId(value.outputAssetId)) return false
  return true
}

/**
 * 把严格合法的旧 journal 投影为新内存合同；读取本身不回写磁盘。
 * @param value 从单个任务 journal 解析出的未知值。
 * @returns 新 schema 记录、兼容投影，或 undefined。
 */
function normalizeStoredDesignJob(value: unknown): StoredDesignJob | undefined {
  if (isStoredDesignJob(value)) return value
  if (!isRecord(value)
    || Object.hasOwn(value, 'target')
    || Object.keys(value).some((field) => !LEGACY_STORED_JOB_FIELDS.has(field))
    || !isSafeDesignStableId(value.nodeId)
    || !isStoredPoint(value.position)) return undefined
  /** 旧布局字段只用于构造内存 target，不原样保留进新 journal。 */
  const { nodeId, position, ...legacy } = value
  /** 缺少创作任务字段的最旧记录补入稳定兼容默认值。 */
  const candidate = {
    ...legacy,
    target: { kind: 'design-canvas' as const, nodeId, position },
    creativeTaskId: legacy.creativeTaskId ?? legacy.id,
    attemptNumber: legacy.attemptNumber ?? 1,
    originalRequest: legacy.originalRequest ?? legacy.prompt,
    contextMode: legacy.contextMode ?? 'none',
    traceState: legacy.traceState ?? (legacy.sessionId ? 'unavailable' : undefined),
    executionSessionCleanupState: legacy.executionSessionCleanupState
      ?? (legacy.sessionId ? 'completed' : undefined),
  }
  return isStoredDesignJob(candidate) ? candidate : undefined
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
