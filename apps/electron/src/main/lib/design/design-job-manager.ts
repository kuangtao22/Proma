import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  AgentMessage,
  AgentSendInput,
  AgentSessionMeta,
  CreateDesignJobInput,
  DesignCanvasDocument,
  DesignCanvasNode,
  DesignJobRecord,
  DesignPoint,
  ImageGenerationModelSnapshot,
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
import type { DesignAssetImportSource, DesignAssetService } from './design-asset-service'
import { isSafeDesignStableId } from './design-paths'
import type { DesignStore } from './design-store'

const DESIGN_IMAGE_TOOL = 'mcp__nano_banana__generate_image'
const DESIGN_JOB_MODEL_ERROR = '未配置可用的 Agent 渠道和模型'
const DESIGN_JOB_OUTPUT_ERROR = '任务完成但没有产生可验证图片'
const DESIGN_IMAGE_MODEL_VALIDATION_ERROR = '校验生图模型配置失败，请刷新后重试'

/** Design Job 使用的最小设置字段。 */
interface DesignJobSettings {
  agentChannelId?: string
  agentModelId?: string
}

/** journal 额外保留重试所需的节点与蒙版输入。 */
interface StoredDesignJob extends DesignJobRecord {
  nodeId: string
  position: DesignPoint
  maskAnnotationId?: string
  /** queued journal 与占位节点两步提交的恢复标记。 */
  placementState?: 'pending' | 'ready'
  /** Store 终态提交结果不确定时保留的跨进程对账证据。 */
  terminalState?: { status: 'pending'; outputAssetId: string }
  /** retry 已创建的唯一替代任务，用于重复请求幂等返回。 */
  replacedByJobId?: string
  /** replacement 创建完成前持久化的 retry intent。 */
  retryState?: { status: 'pending' }
}

/** Manager 内部创建已使用独立可信 snapshot，不再依赖 Renderer profile ID。 */
type InternalCreateDesignJobInput = Omit<CreateDesignJobInput, 'imageModelProfileId'>

/** journal 允许出现的完整字段集合，未知字段一律拒绝。 */
const STORED_JOB_FIELDS = new Set([
  'id', 'projectId', 'sessionId', 'action', 'status', 'prompt', 'sourceSessionId',
  'sourceAssetId', 'parentAssetId', 'outputAssetId', 'error', 'createdAt', 'updatedAt',
  'imageModelSnapshot',
  'nodeId', 'position', 'maskAnnotationId', 'placementState', 'terminalState',
  'replacedByJobId', 'retryState',
])
/** journal 中必须始终存在的基础字段。 */
const REQUIRED_STORED_JOB_FIELDS = [
  'id', 'projectId', 'action', 'status', 'prompt', 'createdAt', 'updatedAt', 'nodeId', 'position',
] as const

/** Headless Agent 回调的窄接口。 */
interface DesignHeadlessCallbacks {
  onError: (error: string) => void
  onComplete: (messages?: AgentMessage[]) => void
  onTitleUpdated: (title: string) => void
  source: 'design'
}

/** Design Job Manager 的可注入依赖。 */
export interface DesignJobManagerDependencies {
  pathResolver: { resolve: (projectId: string) => { jobsDir: string } }
  store: DesignStore
  assetService: Pick<DesignAssetService, 'resolveAssetPath' | 'importAuthorizedFiles'>
  /** 只暴露任务创建与执行所需的公开模型校验，不允许 Job Manager 接触凭据。 */
  imageModels: Pick<ImageGenerationModelCatalog, 'resolveAvailableSnapshot' | 'assertSnapshotAvailable'>
  getSettings: () => DesignJobSettings
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  createSession: (
    title: string,
    channelId: string,
    projectId: string,
    modelId: string,
  ) => AgentSessionMeta
  updateSession: (
    sessionId: string,
    updates: { sourceDesignProjectId: string; sourceDesignJobId: string },
  ) => void
  runHeadless: (
    input: AgentSendInput,
    callbacks: DesignHeadlessCallbacks,
    extensions: AgentRunExtensions,
  ) => Promise<void>
  stopAgent: (sessionId: string) => void | Promise<void>
  /** 验证附件属于当前会话并返回可供素材服务读取的绝对路径。 */
  resolveOwnedOutputPath: (sessionId: string, localPath: string) => string | undefined
  listProjectIds: () => string[]
  /** 在项目迁移互斥边界内执行完整设计任务写入。 */
  runWorkspaceWrite: <T>(projectId: string, effect: () => T) => T
  /** 原子写入单个任务 journal；生产默认使用 safe-file，测试可注入 durability 故障。 */
  writeJobJournal?: (path: string, value: object) => void
  /** 单项目恢复失败时记录中文错误，默认输出到主进程错误日志。 */
  warn?: (message: string) => void
  /** 生图模型未知底层错误记录器，必须保留原始 Error 供主进程诊断。 */
  logImageModelError?: (message: string, error: unknown) => void
  createId?: () => string
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
  private readonly createId: () => string
  private readonly now: () => number
  private readonly warn: (message: string) => void
  private readonly logImageModelError: (message: string, error: unknown) => void

  constructor(private readonly dependencies: DesignJobManagerDependencies) {
    this.createId = dependencies.createId ?? randomUUID
    this.now = dependencies.now ?? Date.now
    this.warn = dependencies.warn ?? ((message) => { console.error(message) })
    this.logImageModelError = dependencies.logImageModelError
      ?? ((message, error) => { console.error(message, error) })
  }

  /** 创建 queued journal 和占位节点，不等待 Agent 运行。 */
  create(input: CreateDesignJobInput): DesignJobRecord {
    /** 可信模型校验必须早于 Store 读取、ID 生成、journal 和占位节点写入。 */
    const imageModelSnapshot = this.runImageModelValidation(
      () => this.dependencies.imageModels.resolveAvailableSnapshot(input.imageModelProfileId),
    )
    return this.createInternal(input, imageModelSnapshot)
  }

  /** 查询已加载或磁盘可发现的任务。 */
  get(jobId: string): DesignJobRecord | undefined {
    return this.findStoredJob(jobId)
  }

  /** 列出项目全部任务，并把磁盘 journal 载入内存索引。 */
  list(projectId: string): DesignJobRecord[] {
    return this.readProjectJobs(projectId)
      .sort((left, right) => left.createdAt - right.createdAt)
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
      const session = this.dependencies.createSession(
        `设计任务：${queued.prompt.trim().slice(0, 24)}`,
        model.channelId,
        queued.projectId,
        model.modelId,
      )
      this.dependencies.updateSession(session.id, {
        sourceDesignProjectId: queued.projectId,
        sourceDesignJobId: queued.id,
      })
      const running = this.updateStatus(queued, 'running', { sessionId: session.id, error: undefined })
      let runError: string | undefined
      let messages: AgentMessage[] = []
      await this.dependencies.runHeadless({
        sessionId: session.id,
        userMessage: this.buildPrompt(running),
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
        allowedToolNames: [DESIGN_IMAGE_TOOL],
        toolCallLimits: { [DESIGN_IMAGE_TOOL]: 1 },
        trustedImageRoute: running.imageModelSnapshot,
        assertTrustedImageRouteAvailable: (route) => {
          try {
            this.runImageModelValidation(
              () => this.dependencies.imageModels.assertSnapshotAvailable(route),
            )
          } catch (error) {
            runError ??= error instanceof Error ? error.message : DESIGN_IMAGE_MODEL_VALIDATION_ERROR
            throw error
          }
        },
      })
      const latest = this.requireJob(jobId)
      if (latest.status === 'cancelled' || latest.status === 'interrupted') return
      if (runError) {
        this.updateStatus(latest, 'failed', { error: runError })
        return
      }
      const outputPath = this.findOwnedOutputPath(messages, session.id)
      if (!outputPath) {
        this.updateStatus(latest, 'failed', { error: DESIGN_JOB_OUTPUT_ERROR })
        return
      }
      await this.commitOutput(latest, session.id, outputPath)
    } catch (error) {
      this.failUnlessStopped(jobId, error)
    }
  }

  /** 取消 queued/running 任务；终态任务保持不变。 */
  async cancel(projectId: string, jobId: string): Promise<DesignJobRecord> {
    const job = this.requireProjectJob(projectId, jobId)
    if (job.status !== 'queued' && job.status !== 'running') return job
    if (job.sessionId) await this.dependencies.stopAgent(job.sessionId)
    const latest = this.requireProjectJob(projectId, jobId)
    if (latest.status !== 'queued' && latest.status !== 'running') return latest
    return this.updateStatus(latest, 'cancelled', { error: undefined })
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
      const current = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
      const ownsNode = current.nodes.some((node) => (
        node.id === previous.nodeId && node.kind === 'job' && node.jobId === previous.id
      ))
      if (!ownsNode) throw new Error('设计任务节点已被其他任务接管')
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
      return this.completeRetryIntent(previous)
    })
  }

  /** 在权威画布恢复后，仅二次对账 terminal pending，不中断其它活动任务。 */
  reconcilePendingTerminals(projectId: string): DesignJobRecord[] {
    return this.dependencies.runWorkspaceWrite(projectId, () => {
      for (const job of this.readProjectJobs(projectId)) {
        if (job.terminalState?.status === 'pending') this.reconcileTerminalJob(job)
      }
      return this.list(projectId)
    })
  }

  /** 恢复单项目 journal，把无法续跑的 running 任务标记为 interrupted。 */
  recover(projectId: string): DesignJobRecord[] {
    const jobs = this.readProjectJobs(projectId)
    for (const stored of jobs) {
      let job = stored
      if (job.placementState === 'pending') {
        const document = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
        const placeholderExists = document.nodes.some((node) => (
          node.id === job.nodeId && node.kind === 'job' && node.jobId === job.id
        ))
        if (!placeholderExists) {
          this.deleteJobJournal(job)
          continue
        }
        job = { ...job, placementState: 'ready' }
        this.writeJob(job)
      }
      if (job.terminalState?.status === 'pending') {
        this.reconcileTerminalJob(job)
        continue
      }
      if (job.retryState?.status === 'pending') {
        try {
          this.dependencies.runWorkspaceWrite(projectId, () => {
            /** 本次恢复补建的替代任务，必须在返回用户前收敛为可显式重试的终态。 */
            const replacement = this.completeRetryIntent(job)
            if (replacement.status === 'queued' || replacement.status === 'running') {
              this.updateStatus(replacement, 'interrupted', {
                error: replacement.status === 'queued' ? '应用退出，排队任务已中断' : '应用退出，任务已中断',
              })
            }
          })
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
    return this.list(projectId)
  }

  /** 启动时恢复全部已登记项目任务。 */
  recoverAll(): DesignJobRecord[] {
    const recovered: DesignJobRecord[] = []
    for (const projectId of this.dependencies.listProjectIds()) {
      try {
        recovered.push(...this.recover(projectId))
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
          if (job.status === 'running') this.updateStatus(job, 'interrupted', { error: '应用退出，任务已中断' })
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
    const now = this.now()
    const job: StoredDesignJob = {
      id,
      projectId: input.projectId,
      action: input.action,
      status: 'queued',
      prompt,
      ...(imageModelSnapshot ? { imageModelSnapshot: { ...imageModelSnapshot } } : {}),
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId, parentAssetId: input.sourceAssetId } : {}),
      ...(input.maskAnnotationId ? { maskAnnotationId: input.maskAnnotationId } : {}),
      placementState: 'pending',
      nodeId: replaced?.nodeId ?? `design-job-${id}`,
      position: replaced?.position ?? input.position,
      createdAt: now,
      updatedAt: now,
    }
    this.writeJob(job)
    const node: DesignCanvasNode = {
      id: job.nodeId,
      kind: 'job',
      jobId: job.id,
      position: job.position,
      width: 320,
      height: 240,
      zIndex: replaced
        ? current.nodes.find((item) => item.id === replaced.nodeId)?.zIndex ?? current.nodes.length
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

  /** 构建只允许单次 Nano Banana 调用的生成或编辑提示。 */
  private buildPrompt(job: StoredDesignJob): string {
    if (job.action === 'generate') {
      return `只调用一次 ${DESIGN_IMAGE_TOOL} 生成图片并返回结果。\n用户要求：${job.prompt}`
    }
    const sourcePath = this.dependencies.assetService.resolveAssetPath(job.projectId, job.sourceAssetId!)
    const document = this.dependencies.store.requireStableAuthoritativeDocument(job.projectId)
    const annotation = job.maskAnnotationId
      ? document.annotations.find((item) => item.id === job.maskAnnotationId)
      : undefined
    const maskText = annotation?.kind === 'mask'
      ? `\n蒙版 ${annotation.id} 点位：${JSON.stringify(annotation.points)}`
      : ''
    return [
      `只调用一次 ${DESIGN_IMAGE_TOOL} 编辑参考图片并返回结果。`,
      `referenceImagePaths: ${JSON.stringify([sourcePath])}`,
      `编辑要求：${job.prompt}${maskText}`,
    ].join('\n')
  }

  /** 从本轮消息中选择第一张成功且属于当前会话的 Nano Banana 图片。 */
  private findOwnedOutputPath(messages: AgentMessage[], sessionId: string): string | undefined {
    for (const message of messages) {
      if (message.role !== 'assistant' && message.role !== 'tool') continue
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
      const current = this.dependencies.store.requireStableAuthoritativeDocument(job.projectId)
      const placeholder = current.nodes.find((node) => node.id === job.nodeId && node.jobId === job.id)
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
      node.id === job.nodeId && node.kind === 'asset' && node.assetId === outputAssetId
    ))
    return assetExists && nodeExists
  }

  /** 按 Store 当前事实完成一次 terminal pending 对账。 */
  private reconcileTerminalJob(job: StoredDesignJob): void {
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

  /** 按已持久化 replacement ID 幂等创建或返回替代任务。 */
  private completeRetryIntent(previous: StoredDesignJob): StoredDesignJob {
    if (!previous.imageModelSnapshot) throw new Error('旧任务未记录生图模型，请重新提交')
    const replacementId = previous.replacedByJobId
    if (!replacementId || previous.retryState?.status !== 'pending') {
      if (replacementId) return this.requireProjectJob(previous.projectId, replacementId)
      throw new Error('设计任务重试 intent 无效')
    }
    const existing = this.findStoredJob(replacementId)
    if (existing) {
      if (existing.projectId !== previous.projectId) throw new Error('替代设计任务不属于当前项目')
      const current = this.dependencies.store.requireStableAuthoritativeDocument(previous.projectId)
      const replacementOwnsNode = current.nodes.some((node) => (
        node.id === previous.nodeId && node.kind === 'job' && node.jobId === replacementId
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
        node.id === previous.nodeId && node.kind === 'job' && node.jobId === previous.id
      ))
      if (!previousOwnsNode || existing.placementState !== 'pending') {
        throw new Error('设计任务节点已被其他任务接管')
      }
      /** replacement journal 已提交但 Store 尚未接管，删除孤立 pending 后用同一 ID 续建。 */
      this.deleteJobJournal(existing)
    }
    const current = this.dependencies.store.requireStableAuthoritativeDocument(previous.projectId)
    const ownsNode = current.nodes.some((node) => (
      node.id === previous.nodeId && node.kind === 'job' && node.jobId === previous.id
    ))
    if (!ownsNode) throw new Error('设计任务节点已被其他任务接管')
    const replacement = this.createInternal({
      projectId: previous.projectId,
      action: previous.action,
      prompt: previous.prompt,
      ...(previous.sourceSessionId ? { sourceSessionId: previous.sourceSessionId } : {}),
      ...(previous.sourceAssetId ? { sourceAssetId: previous.sourceAssetId } : {}),
      ...(previous.maskAnnotationId ? { maskAnnotationId: previous.maskAnnotationId } : {}),
      position: previous.position,
    }, previous.imageModelSnapshot, previous, replacementId)
    this.finalizeRetryIntent(previous)
    return replacement
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
    const next: StoredDesignJob = { ...job, ...updates, status, updatedAt: this.now() }
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
    const path = this.resolveJobJournalPath(job.projectId, job.id)
    const directoryPath = this.dependencies.pathResolver.resolve(job.projectId).jobsDir
    mkdirSync(directoryPath, { recursive: true })
    const writeJournal = this.dependencies.writeJobJournal
      ?? ((journalPath: string, value: object): void => { writeJsonFileAtomic(journalPath, value, true) })
    writeJournal(path, job)
    this.jobs.set(job.id, job)
  }

  /** 删除未建立占位节点的 pending journal 与内存索引。 */
  private deleteJobJournal(job: StoredDesignJob): void {
    const path = this.resolveJobJournalPath(job.projectId, job.id)
    removeFileAtomic(path)
    this.jobs.delete(job.id)
  }

  /** 读取项目全部合法 journal。 */
  private readProjectJobs(projectId: string): StoredDesignJob[] {
    const directoryPath = this.dependencies.pathResolver.resolve(projectId).jobsDir
    if (!existsSync(directoryPath)) return []
    const jobs: StoredDesignJob[] = []
    for (const name of readdirSync(directoryPath)) {
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
      if (!isStoredDesignJob(value) || value.projectId !== projectId || value.id !== jobId) return undefined
      this.jobs.set(value.id, value)
      return value
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
  /** snapshot 只能包含任务执行所需的四个公开字段。 */
  const keys = Object.keys(value)
  if (keys.length !== 4
    || !['profileId', 'name', 'executor', 'modelId'].every((key) => keys.includes(key))) return false
  return typeof value.profileId === 'string'
    && value.profileId.length > 0
    && value.profileId === value.profileId.trim()
    && typeof value.name === 'string'
    && value.name.trim().length > 0
    && value.name.length <= IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH
    && value.executor === 'nano-banana'
    && typeof value.modelId === 'string'
    && value.modelId.length > 0
    && value.modelId.length <= IMAGE_GENERATION_MODEL_ID_MAX_LENGTH
    && value.modelId === value.modelId.trim()
}

/** 严格解析完整 Design Job journal schema。 */
function isStoredDesignJob(value: unknown): value is StoredDesignJob {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((field) => !STORED_JOB_FIELDS.has(field))) return false
  if (REQUIRED_STORED_JOB_FIELDS.some((field) => !Object.hasOwn(value, field))) return false
  if (!isSafeDesignStableId(value.id) || !isSafeDesignStableId(value.projectId)) return false
  if (!['generate', 'edit'].includes(String(value.action))) return false
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(value.status))) return false
  if (typeof value.prompt !== 'string' || value.prompt.trim().length === 0) return false
  if (!isSafeDesignStableId(value.nodeId) || !isStoredPoint(value.position)) return false
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
  if (value.action === 'edit' && !isSafeDesignStableId(value.sourceAssetId)) return false
  if (value.status === 'succeeded' && !isSafeDesignStableId(value.outputAssetId)) return false
  return true
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
