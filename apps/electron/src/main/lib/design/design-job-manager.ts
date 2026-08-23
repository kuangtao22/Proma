import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type {
  AgentMessage,
  AgentSendInput,
  AgentSessionMeta,
  CreateDesignJobInput,
  DesignCanvasNode,
  DesignJobRecord,
  DesignPoint,
} from '@proma/shared'
import { writeJsonFileAtomic } from '../safe-file'
import { getConversationAttachmentsDir, resolveAttachmentPath } from '../config-paths'
import type { AgentRunExtensions } from '../agent-service'
import type { DesignAssetImportSource, DesignAssetService } from './design-asset-service'
import type { DesignStore } from './design-store'

const DESIGN_IMAGE_TOOL = 'mcp__nano_banana__generate_image'
const DESIGN_JOB_MODEL_ERROR = '未配置可用的 Agent 渠道和模型'
const DESIGN_JOB_OUTPUT_ERROR = '任务完成但没有产生可验证图片'

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
}

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
  createId?: () => string
  now?: () => number
}

/** Design Job 状态变化监听器。 */
export type DesignJobChangedListener = (job: DesignJobRecord) => void

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
  private readonly listeners = new Set<DesignJobChangedListener>()
  private readonly createId: () => string
  private readonly now: () => number

  constructor(private readonly dependencies: DesignJobManagerDependencies) {
    this.createId = dependencies.createId ?? randomUUID
    this.now = dependencies.now ?? Date.now
  }

  /** 创建 queued journal 和占位节点，不等待 Agent 运行。 */
  create(input: CreateDesignJobInput): DesignJobRecord {
    return this.createInternal(input)
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
    try {
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
        onError: (error) => { runError = error },
        onComplete: (completedMessages) => { messages = completedMessages ?? [] },
        onTitleUpdated: () => undefined,
      }, {
        allowedToolNames: [DESIGN_IMAGE_TOOL],
      })
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error)
    }
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
    const previous = this.requireProjectJob(projectId, jobId)
    if (!['failed', 'cancelled', 'interrupted'].includes(previous.status)) {
      throw new Error('当前设计任务不可重试')
    }
    return this.createInternal({
      projectId,
      action: previous.action,
      prompt: previous.prompt,
      ...(previous.sourceSessionId ? { sourceSessionId: previous.sourceSessionId } : {}),
      ...(previous.sourceAssetId ? { sourceAssetId: previous.sourceAssetId } : {}),
      ...(previous.maskAnnotationId ? { maskAnnotationId: previous.maskAnnotationId } : {}),
      position: previous.position,
    }, previous)
  }

  /** 恢复单项目 journal，把无法续跑的 running 任务标记为 interrupted。 */
  recover(projectId: string): DesignJobRecord[] {
    const jobs = this.readProjectJobs(projectId)
    for (const job of jobs) {
      if (job.status === 'running') this.updateStatus(job, 'interrupted', { error: '应用退出，任务已中断' })
    }
    return this.list(projectId)
  }

  /** 启动时恢复全部已登记项目任务。 */
  recoverAll(): DesignJobRecord[] {
    return this.dependencies.listProjectIds().flatMap((projectId) => this.recover(projectId))
  }

  /** 退出前同步把 running journal 标记为 interrupted。 */
  markRunningInterrupted(): void {
    for (const projectId of this.dependencies.listProjectIds()) {
      for (const job of this.readProjectJobs(projectId)) {
        if (job.status === 'running') this.updateStatus(job, 'interrupted', { error: '应用退出，任务已中断' })
      }
    }
  }

  /** 创建新任务；retry 时复用原节点位置和 ID。 */
  private createInternal(input: CreateDesignJobInput, replaced?: StoredDesignJob): StoredDesignJob {
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('设计任务提示词不能为空')
    if (input.action === 'edit' && !input.sourceAssetId) throw new Error('编辑任务缺少来源素材')
    const current = this.dependencies.store.requireStableAuthoritativeDocument(input.projectId)
    if (input.sourceAssetId && !current.assets.some((asset) => asset.id === input.sourceAssetId)) {
      throw new Error(`素材不存在: ${input.sourceAssetId}`)
    }
    if (input.maskAnnotationId && !current.annotations.some((item) => (
      item.id === input.maskAnnotationId && item.kind === 'mask'
    ))) throw new Error(`蒙版批注不存在: ${input.maskAnnotationId}`)
    const id = this.createId()
    const now = this.now()
    const job: StoredDesignJob = {
      id,
      projectId: input.projectId,
      action: input.action,
      status: 'queued',
      prompt,
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId, parentAssetId: input.sourceAssetId } : {}),
      ...(input.maskAnnotationId ? { maskAnnotationId: input.maskAnnotationId } : {}),
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
    this.dependencies.store.mutate(input.projectId, current.revision, [{ type: 'upsert-nodes', nodes: [node] }])
    this.emit(job)
    return job
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
    const source: DesignAssetImportSource = {
      kind: 'job',
      sourceJobId: job.id,
      sourceSessionId: sessionId,
      ...(job.sourceAssetId ? { parentAssetId: job.sourceAssetId } : {}),
      prompt: job.prompt,
    }
    const batch = await this.dependencies.assetService.importAuthorizedFiles(job.projectId, [outputPath], source)
    try {
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
      if (!placeholder) throw new Error('设计任务占位节点不存在')
      const assetNode: DesignCanvasNode = {
        ...placeholder,
        kind: 'asset',
        assetId: asset.id,
        jobId: undefined,
      }
      this.dependencies.store.mutate(job.projectId, current.revision, [
        { type: 'upsert-assets', assets: [asset] },
        { type: 'upsert-nodes', nodes: [assetNode] },
      ])
      batch.commit()
      this.updateStatus(latest, 'succeeded', {
        outputAssetId: asset.id,
        parentAssetId: job.sourceAssetId,
        error: undefined,
      })
    } catch (error) {
      batch.rollback()
      const latest = this.requireJob(job.id)
      if (latest.status !== 'cancelled' && latest.status !== 'interrupted') {
        this.updateStatus(latest, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /** 写入新状态并通知订阅者。 */
  private updateStatus(
    job: StoredDesignJob,
    status: StoredDesignJob['status'],
    updates: Partial<StoredDesignJob>,
  ): StoredDesignJob {
    const next: StoredDesignJob = { ...job, ...updates, status, updatedAt: this.now() }
    this.writeJob(next)
    this.emit(next)
    return next
  }

  /** 原子持久化单个任务 journal。 */
  private writeJob(job: StoredDesignJob): void {
    const directoryPath = this.dependencies.pathResolver.resolve(job.projectId).jobsDir
    mkdirSync(directoryPath, { recursive: true })
    writeJsonFileAtomic(join(directoryPath, `${job.id}.json`), job, true)
    this.jobs.set(job.id, job)
  }

  /** 读取项目全部合法 journal。 */
  private readProjectJobs(projectId: string): StoredDesignJob[] {
    const directoryPath = this.dependencies.pathResolver.resolve(projectId).jobsDir
    if (!existsSync(directoryPath)) return []
    const jobs: StoredDesignJob[] = []
    for (const name of readdirSync(directoryPath)) {
      if (!name.endsWith('.json')) continue
      try {
        const value = JSON.parse(readFileSync(join(directoryPath, name), 'utf8')) as StoredDesignJob
        if (!value || value.projectId !== projectId || typeof value.id !== 'string'
          || typeof value.nodeId !== 'string' || typeof value.status !== 'string') continue
        this.jobs.set(value.id, value)
        jobs.push(value)
      } catch {
        // 单个损坏 journal 不阻断其它任务恢复。
      }
    }
    return jobs
  }

  /** 从内存或已登记项目磁盘中查找任务。 */
  private findStoredJob(jobId: string): StoredDesignJob | undefined {
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
  private emit(job: StoredDesignJob): void {
    for (const listener of this.listeners) listener(job)
  }
}
