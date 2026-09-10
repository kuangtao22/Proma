import * as React from 'react'
import { createCanvasMediaInputConnectionInspector } from '@proma/shared'
import type {
  CanvasDocument,
  CanvasMediaModuleChangedEvent,
  CanvasMediaModuleSnapshot,
  CanvasMediaTarget,
  DesignJobRecord,
  MediaRunEvent,
  MediaRunPhase,
  MediaRunSnapshot,
} from '@proma/shared'

/** Renderer 对单个媒体运行的轻量展示投影，不包含 Canvas revision。 */
export interface MediaRunProgressProjection {
  phase: MediaRunPhase | 'pending'
  phaseLabel: string
  /** Comfy 只提供当前节点采样计数，不能解释为整体任务百分比。 */
  nodeProgressLabel?: string
  /** 折叠卡片仅汇总本地配置与连接事实，不宣称已完成运行前校验。 */
  preparation?: { workflowBound: boolean; inputsConnected: boolean; needsAttention: boolean }
}

/** 图片媒体进度只需要活动列表已有的轻量任务字段。 */
export interface MediaProgressJob {
  id: string
  projectId: string
  target?: DesignJobRecord['target']
  status: DesignJobRecord['status']
}

/** 媒体阶段对应的稳定用户文案。 */
const MEDIA_PHASE_LABELS: Readonly<Record<MediaRunPhase, string>> = {
  prepared: '等待执行',
  uploading: '正在上传素材',
  compiling: '正在编译工作流',
  submitting: '正在提交任务',
  'submission-unknown': '提交状态待确认',
  queued: '排队中',
  running: '运行中',
  collecting: '正在收集结果',
  'collection-failed': '结果收集待恢复',
  succeeded: '生成完成',
  failed: '生成失败',
  'cancel-requested': '正在取消',
  cancelled: '已取消',
}

/** 将运行快照转换为固定高度 UI 可消费的阶段和当前节点计数。 */
export function projectMediaRunProgress(run: MediaRunSnapshot | null): MediaRunProgressProjection {
  if (!run) return { phase: 'pending', phaseLabel: '运行状态待同步' }
  /** 当前节点采样计数使用原始 nodeId 和 value/max，不换算为百分比。 */
  const nodeProgressLabel = run.progress
    ? `当前节点 ${run.progress.nodeId} · ${run.progress.value}/${run.progress.max}`
    : undefined
  return {
    phase: run.phase,
    phaseLabel: MEDIA_PHASE_LABELS[run.phase],
    ...(nodeProgressLabel ? { nodeProgressLabel } : {}),
  }
}

/** 判断媒体运行是否仍处于可推进阶段。 */
function isActiveMediaRun(run: MediaRunSnapshot): boolean {
  return run.phase !== 'succeeded' && run.phase !== 'failed' && run.phase !== 'cancelled'
}

/** 从模块历史中选择卡片应展示的活跃或最近运行。 */
function selectCanvasMediaNodeRun(runs: readonly MediaRunSnapshot[]): MediaRunSnapshot | null {
  const ordered = [...runs].sort((left, right) => (
    right.updatedAt - left.updatedAt || right.revision - left.revision
  ))
  return ordered.find(isActiveMediaRun) ?? ordered[0] ?? null
}

/** 把媒体目标编码为控制器内部的精确模块身份。 */
function createCanvasMediaTargetKey(target: CanvasMediaTarget): string {
  return `${target.projectId}\u0000${target.canvasId}\u0000${target.nodeId}\u0000${target.mediaModuleId}\u0000${target.mediaKind}`
}

/** 初次加载限制并发，避免打开大画布时同时读取全部 AV 模块及项目素材。 */
const CANVAS_MEDIA_INITIAL_LOAD_CONCURRENCY = 4

/** AV 节点进度控制器使用的最小公开依赖。 */
export interface CanvasMediaNodeProgressControllerDependencies {
  projectId: string
  canvasMediaLoad: (target: CanvasMediaTarget) => Promise<CanvasMediaModuleSnapshot>
  onCanvasMediaChanged: (listener: (event: CanvasMediaModuleChangedEvent) => void) => () => void
  onMediaRunChanged: (listener: (event: MediaRunEvent) => void) => () => void
  acquireProjectWatch: (projectId: string) => Promise<void>
  releaseProjectWatch: (projectId: string) => Promise<void>
  onChange: (progress: ReadonlyMap<string, MediaRunProgressProjection>) => void
}

/** AV 节点进度控制器；初次有界加载后仅靠模块与运行事件刷新。 */
export interface CanvasMediaNodeProgressController {
  start(): void
  setTargets(targets: readonly CanvasMediaTarget[], document?: CanvasDocument): void
  whenIdle(): Promise<void>
  dispose(): void
}

/** 创建按 nodeId 聚合的 AV 模块运行进度控制器。 */
export function createCanvasMediaNodeProgressController(
  dependencies: CanvasMediaNodeProgressControllerDependencies,
): CanvasMediaNodeProgressController {
  /** 当前画布内仍有效的 AV 模块目标。 */
  let targetsByNodeId = new Map<string, CanvasMediaTarget>()
  /** 每个节点保存完整公开运行列表，避免非最新运行事件被误归属。 */
  let runsByNodeId = new Map<string, MediaRunSnapshot[]>()
  /** 配置诊断独立于运行历史，即使尚未创建 run 也能在原卡片展示。 */
  const configurationByNodeId = new Map<string, CanvasMediaModuleSnapshot['config']>()
  /** 图变化只重算连接事实，不重复读取模块或素材。 */
  let currentDocument: CanvasDocument | undefined
  /** 同一代图共享索引，模块或运行事件不重复扫描全部节点与边。 */
  let inspectConnections: ReturnType<typeof createCanvasMediaInputConnectionInspector> | undefined
  /** 每个模块独立递增读取代次，拒绝乱序事件刷新。 */
  const requestGenerations = new Map<string, number>()
  /** 最近异步读取链供测试和卸载收口。 */
  let pending = Promise.resolve()
  /** 所有批次共享同一个初次加载队列，连续新增节点也不能突破并发上限。 */
  const initialLoadQueue: Array<{
    load: () => Promise<void>
    resolve: () => void
  }> = []
  /** 当前正在执行的初次模块读取数。 */
  let activeInitialLoads = 0
  /** dispose 后全部事件与迟到读取失效。 */
  let disposed = false
  /** start 只建立一组稳定监听器。 */
  let started = false
  /** 模块事件监听释放器。 */
  let releaseModule: (() => void) | null = null
  /** 运行事件监听释放器。 */
  let releaseRun: (() => void) | null = null
  /** watch 完成后才读取初始快照，确保读取与后续事件之间没有空窗。 */
  let watchReady = Promise.resolve()
  /** 仅有真实 AV 目标时申请项目 watch，空画布不向 Host 发送空项目 ID。 */
  let watchRequested = false

  /** 发布运行与配置的轻量投影，活跃任务优先，准备失败不会伪装成生成任务失败。 */
  const publish = (): void => {
    const progress = new Map<string, MediaRunProgressProjection>()
    for (const [nodeId, runs] of runsByNodeId) {
      const run = selectCanvasMediaNodeRun(runs)
      /** 配置摘要只来自已有模块 LOAD，不为卡片状态额外请求服务器。 */
      const configuration = configurationByNodeId.get(nodeId)
      if (run && isActiveMediaRun(run)) progress.set(nodeId, projectMediaRunProgress(run))
      else if (configuration?.preparation) progress.set(nodeId, {
        phase: 'pending', phaseLabel: '待配置',
        nodeProgressLabel: `${configuration.preparation.code} · ${configuration.preparation.message}`,
      })
      else if (run) progress.set(nodeId, projectMediaRunProgress(run))
      else progress.set(nodeId, { phase: 'pending', phaseLabel: configuration?.profile || configuration?.workflow ? '参数待检查' : '待配置' })
      if (configuration && inspectConnections) {
        /** 只有精确目标仍属于当前图，才向顶部汇总可恢复准备状态。 */
        const target = targetsByNodeId.get(nodeId)
        const projection = progress.get(nodeId)
        if (target && projection) {
          try {
            const connections = inspectConnections(target, configuration.inputs)
            const workflowBound = Boolean(configuration.profile || configuration.workflow)
            progress.set(nodeId, { ...projection,
              ...(!run && !connections.connected ? { phaseLabel: '输入待接通', nodeProgressLabel: connections.bindings.find((binding) => binding.errorCode)?.message } : {}),
              preparation: { workflowBound, inputsConnected: connections.connected,
                needsAttention: !workflowBound || !connections.connected || Boolean(configuration.preparation) },
            })
          } catch { /* 图和模块切换窗口内不发布过期的准备计数。 */ }
        }
      }
    }
    dependencies.onChange(progress)
  }

  /** 创建单个模块读取任务，并用精确目标和请求代次复验迟到响应。 */
  const createTargetLoad = (target: CanvasMediaTarget): (() => Promise<void>) => {
    const targetKey = createCanvasMediaTargetKey(target)
    const generation = (requestGenerations.get(targetKey) ?? 0) + 1
    requestGenerations.set(targetKey, generation)
    return async () => {
      try {
        await watchReady
        const currentBeforeLoad = targetsByNodeId.get(target.nodeId)
        if (disposed
          || requestGenerations.get(targetKey) !== generation
          || !currentBeforeLoad
          || createCanvasMediaTargetKey(currentBeforeLoad) !== targetKey) return
        const snapshot = await dependencies.canvasMediaLoad(target)
        const currentTarget = targetsByNodeId.get(target.nodeId)
        if (disposed
          || requestGenerations.get(targetKey) !== generation
          || !currentTarget
          || createCanvasMediaTargetKey(currentTarget) !== targetKey
          || createCanvasMediaTargetKey(snapshot.target) !== targetKey) return
        runsByNodeId.set(target.nodeId, snapshot.runs)
        configurationByNodeId.set(target.nodeId, snapshot.config)
        publish()
      } catch {
        /** 卡片进度属于增强信息；读取失败保留现有节点状态。 */
      }
    }
  }

  /** 把异步读取并入控制器收口链，供测试与卸载等待。 */
  const track = (request: Promise<void>): void => {
    pending = Promise.all([pending.catch(() => undefined), request]).then(() => undefined)
  }

  /** 读取单个事件目标；事件本身已按模块身份过滤，无需进入初次加载队列。 */
  const refreshTarget = (target: CanvasMediaTarget): void => {
    if (disposed) return
    track(createTargetLoad(target)())
  }

  /** 从共享队列补足空闲读取槽位。 */
  const drainInitialLoadQueue = (): void => {
    while (activeInitialLoads < CANVAS_MEDIA_INITIAL_LOAD_CONCURRENCY && initialLoadQueue.length > 0) {
      const task = initialLoadQueue.shift()
      if (!task) return
      activeInitialLoads += 1
      void task.load().finally(() => {
        activeInitialLoads -= 1
        task.resolve()
        drainInitialLoadQueue()
      })
    }
  }

  /** 首批目标最多并发读取四个模块，避免每次读取附带的项目素材列表形成 I/O 峰值。 */
  const loadInitialTargets = (targets: readonly CanvasMediaTarget[]): void => {
    if (disposed || targets.length === 0) return
    const request = Promise.all(targets.map((target) => new Promise<void>((resolve) => {
      initialLoadQueue.push({ load: createTargetLoad(target), resolve })
    }))).then(() => undefined)
    drainInitialLoadQueue()
    track(request)
  }

  /** listener 已建立且存在真实项目目标时，只申请一次项目 watch。 */
  const ensureProjectWatch = (): void => {
    if (!started || disposed || watchRequested || !dependencies.projectId || targetsByNodeId.size === 0) return
    watchRequested = true
    watchReady = dependencies.acquireProjectWatch(dependencies.projectId)
  }

  return {
    start: () => {
      if (started || disposed) return
      started = true
      releaseModule = dependencies.onCanvasMediaChanged((event) => {
        if (disposed) return
        const target = targetsByNodeId.get(event.target.nodeId)
        if (target && createCanvasMediaTargetKey(target) === createCanvasMediaTargetKey(event.target)) {
          refreshTarget(target)
        }
      })
      releaseRun = dependencies.onMediaRunChanged((event) => {
        if (disposed) return
        let changed = false
        for (const [nodeId, runs] of runsByNodeId) {
          const index = runs.findIndex((run) => run.id === event.run.id)
          if (index < 0 || event.run.projectId !== targetsByNodeId.get(nodeId)?.projectId) continue
          const current = runs[index]!
          if (event.run.revision <= current.revision) continue
          const nextRuns = [...runs]
          nextRuns[index] = event.run
          runsByNodeId.set(nodeId, nextRuns)
          changed = true
        }
        if (changed) publish()
      })
      ensureProjectWatch()
      loadInitialTargets([...targetsByNodeId.values()])
    },
    setTargets: (targets, document) => {
      if (document !== currentDocument) inspectConnections = document ? createCanvasMediaInputConnectionInspector(document) : undefined
      currentDocument = document
      const nextTargets = new Map(targets.map((target) => [target.nodeId, target]))
      /** 仅首次出现或模块身份变化的目标需要读取初始快照。 */
      const targetsToLoad: CanvasMediaTarget[] = []
      for (const [nodeId, next] of nextTargets) {
        const previous = targetsByNodeId.get(nodeId)
        if (!previous || createCanvasMediaTargetKey(next) !== createCanvasMediaTargetKey(previous)) {
          targetsToLoad.push(next)
        }
      }
      for (const [nodeId, previous] of targetsByNodeId) {
        const next = nextTargets.get(nodeId)
        if (!next || createCanvasMediaTargetKey(next) !== createCanvasMediaTargetKey(previous)) {
          runsByNodeId.delete(nodeId)
          configurationByNodeId.delete(nodeId)
          requestGenerations.set(createCanvasMediaTargetKey(previous), (
            requestGenerations.get(createCanvasMediaTargetKey(previous)) ?? 0
          ) + 1)
        }
      }
      targetsByNodeId = nextTargets
      publish()
      if (started) {
        ensureProjectWatch()
        loadInitialTargets(targetsToLoad)
      }
    },
    whenIdle: () => pending,
    dispose: () => {
      if (disposed) return
      disposed = true
      releaseModule?.()
      releaseRun?.()
      releaseModule = null
      releaseRun = null
      targetsByNodeId.clear()
      runsByNodeId.clear()
      configurationByNodeId.clear()
      publish()
      pending = Promise.all([
        pending.catch(() => undefined),
        watchRequested
          ? watchReady.catch(() => undefined).then(() => dependencies.releaseProjectWatch(dependencies.projectId).catch(() => undefined))
          : Promise.resolve(),
      ]).then(() => undefined)
    },
  }
}

/** 订阅当前画布 AV 节点的权威媒体运行投影。 */
export function useCanvasMediaNodeProgress(
  targets: readonly CanvasMediaTarget[],
  adapter: Pick<CanvasMediaNodeProgressControllerDependencies,
    'canvasMediaLoad' | 'onCanvasMediaChanged' | 'onMediaRunChanged'>
    & MediaProjectWatchApi | null,
  /** 已经加载的当前图用于连接阶段的同步投影。 */
  document?: CanvasDocument,
): ReadonlyMap<string, MediaRunProgressProjection> {
  /** 节点卡片只消费可展示的媒体运行事实。 */
  const [progress, setProgress] = React.useState<ReadonlyMap<string, MediaRunProgressProjection>>(() => new Map())
  /** 控制器随 Adapter 身份变化重建，目标列表单独增量同步。 */
  const controllerRef = React.useRef<CanvasMediaNodeProgressController | null>(null)

  React.useEffect(() => {
    setProgress(new Map())
    if (!adapter) return
    /** 同一 Adapter 的所有 AV 消费者共享引用计数，避免工作台关闭时提前 unwatch。 */
    const watchRegistry = getMediaProjectWatchLeaseRegistry(adapter)
    const controller = createCanvasMediaNodeProgressController({
      ...adapter,
      projectId: targets[0]?.projectId ?? '',
      acquireProjectWatch: (projectId) => watchRegistry.acquire(projectId),
      releaseProjectWatch: (projectId) => watchRegistry.release(projectId),
      onChange: (next) => setProgress(new Map(next)),
    })
    controllerRef.current = controller
    controller.start()
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null
      controller.dispose()
    }
  }, [adapter, targets[0]?.projectId])

  React.useEffect(() => {
    controllerRef.current?.setTargets(targets, document)
  }, [targets, document, adapter])

  return progress
}

/** 媒体运行控制器的可测试依赖。 */
export interface MediaRunProgressControllerDependencies {
  projectId: string
  onMediaRunChanged: (listener: (event: MediaRunEvent) => void) => () => void
  acquireProjectWatch: (projectId: string) => Promise<void>
  releaseProjectWatch: (projectId: string) => Promise<void>
  getJobRun: (projectId: string, jobId: string) => Promise<MediaRunSnapshot | null>
  onChange: (runs: ReadonlyMap<string, MediaRunSnapshot | null>) => void
}

/** 项目级媒体运行控制器生命周期。 */
export interface MediaRunProgressController {
  start(): void
  setJobs(jobs: readonly MediaProgressJob[]): void
  whenIdle(): Promise<void>
  dispose(): void
}

/** 判断 Job 是否需要统一媒体运行投影。 */
function isActiveCanvasImageJob(job: MediaProgressJob): boolean {
  return job.target?.kind === 'canvas-image'
    && (job.status === 'queued' || job.status === 'running')
}

/** 创建单项目媒体运行投影控制器。 */
export function createMediaRunProgressController(
  dependencies: MediaRunProgressControllerDependencies,
): MediaRunProgressController {
  /** 当前仍需要投影的 Comfy Job ID。 */
  let desiredJobIds = new Set<string>()
  /** Job 到最近运行快照的内存映射；null 表示正在同步。 */
  let runs = new Map<string, MediaRunSnapshot | null>()
  /** 查询代次隔离 Job 列表变化和项目控制器释放。 */
  let requestGeneration = 0
  /** 控制器释放后拒绝全部迟到事件和请求。 */
  let disposed = false
  /** start 只允许建立一个事件监听与 watch lease。 */
  let started = false
  /** 当前事件监听释放器。 */
  let unsubscribe: (() => void) | null = null
  /** watch、初始查询与释放组成的最近异步链。 */
  let pending = Promise.resolve()
  /** 项目 watch 完成后才允许读取初始运行，保持 listener -> watch -> get 顺序。 */
  let watchReady = Promise.resolve()

  /** 发布防御性 Map，调用方不能修改控制器内部索引。 */
  const publish = (): void => dependencies.onChange(new Map(runs))

  /** 只有相同 Job 的更高 revision 才能替换当前运行事实。 */
  const accept = (jobId: string, next: MediaRunSnapshot | null): void => {
    if (disposed || !desiredJobIds.has(jobId)) return
    const current = runs.get(jobId)
    if (next && (next.projectId !== dependencies.projectId || (current && current.revision >= next.revision))) return
    runs.set(jobId, next)
    publish()
  }

  /** watch 建立后并行加载当前活跃 Job，单项失败保留 pending 投影。 */
  const refresh = (): Promise<void> => {
    if (!started || disposed) return Promise.resolve()
    requestGeneration += 1
    /** 本轮查询只拥有创建时的稳定 Job 集合。 */
    const generation = requestGeneration
    /** 查询列表按 ID 排序，使测试和错误行为保持确定。 */
    const jobIds = [...desiredJobIds].sort()
    pending = watchReady.catch(() => undefined).then(async () => {
      await Promise.all(jobIds.map(async (jobId) => {
        try {
          const next = await dependencies.getJobRun(dependencies.projectId, jobId)
          if (disposed || generation !== requestGeneration) return
          accept(jobId, next)
        } catch {
          /** 进度是增强信息；读取失败保留“待同步”，不污染图片 Job 状态。 */
        }
      }))
    })
    return pending
  }

  return {
    start: () => {
      if (started || disposed) return
      started = true
      /** listener 必须早于 watch 注册，避免启动恢复同步期间漏掉 revision。 */
      unsubscribe = dependencies.onMediaRunChanged((event) => {
        if (disposed || event.run.projectId !== dependencies.projectId) return
        /** 优先使用可信 Host 附带的 Job ID；兼容事件只按已知 run ID 回查。 */
        const jobId = event.designJobId ?? [...runs].find(([, current]) => current?.id === event.run.id)?.[0]
        if (!jobId) return
        accept(jobId, event.run)
      })
      watchReady = dependencies.acquireProjectWatch(dependencies.projectId)
      void refresh()
    },
    setJobs: (jobs) => {
      /** 只保留当前项目的活跃 Comfy Canvas 图片 Job。 */
      desiredJobIds = new Set(jobs.filter((job) => (
        job.projectId === dependencies.projectId && isActiveCanvasImageJob(job)
      )).map((job) => job.id))
      /** Job 终态或列表移除时立即清理旧运行投影。 */
      runs = new Map([...runs].filter(([jobId]) => desiredJobIds.has(jobId)))
      for (const jobId of desiredJobIds) {
        if (!runs.has(jobId)) runs.set(jobId, null)
      }
      publish()
      void refresh()
    },
    whenIdle: () => pending,
    dispose: () => {
      if (disposed) return
      disposed = true
      requestGeneration += 1
      unsubscribe?.()
      unsubscribe = null
      runs.clear()
      publish()
      pending = Promise.all([
        pending.catch(() => undefined),
        started ? dependencies.releaseProjectWatch(dependencies.projectId).catch(() => undefined) : Promise.resolve(),
      ]).then(() => undefined)
    },
  }
}

/** 同项目多个 Canvas 工作区共享的 watch 引用计数。 */
interface MediaProjectWatchEntry {
  count: number
  operation: Promise<void>
  watched: boolean
}

/** 模块级 watch 表只保存项目身份与异步生命周期，不保存运行或 Canvas 数据。 */
export interface MediaProjectWatchLeaseRegistry {
  acquire(projectId: string): Promise<void>
  release(projectId: string): Promise<void>
}

/** 公开媒体 Adapter 的项目 watch 能力。 */
export interface MediaProjectWatchApi {
  mediaWatchProject(projectId: string): Promise<void>
  mediaUnwatchProject(projectId: string): Promise<void>
}

/** 创建可复用的项目 watch 引用计数器，并串行化 StrictMode 重挂载竞态。 */
export function createMediaProjectWatchLeaseRegistry(
  watch: (projectId: string) => Promise<void>,
  unwatch: (projectId: string) => Promise<void>,
): MediaProjectWatchLeaseRegistry {
  /** 每个项目独立维护真实 watch 状态和串行操作。 */
  const entries = new Map<string, MediaProjectWatchEntry>()
  return {
    acquire: async (projectId) => {
      /** 当前项目已有的串行生命周期。 */
      const existing = entries.get(projectId)
      if (existing) {
        const wasUnused = existing.count === 0
        existing.count += 1
        if (wasUnused) existing.operation = existing.operation.catch(() => undefined).then(async () => {
          if (existing.watched) return
          await watch(projectId)
          existing.watched = true
        })
        return existing.operation
      }
      /** 首个消费者创建唯一 watch 操作。 */
      const entry: MediaProjectWatchEntry = { count: 1, watched: false, operation: Promise.resolve() }
      entry.operation = watch(projectId).then(() => { entry.watched = true })
      entries.set(projectId, entry)
      return entry.operation
    },
    release: async (projectId) => {
      /** 不匹配的重复释放不产生额外 unwatch。 */
      const entry = entries.get(projectId)
      if (!entry || entry.count === 0) return
      entry.count -= 1
      if (entry.count > 0) return
      entry.operation = entry.operation.catch(() => undefined).then(async () => {
        if (entry.count > 0 || !entry.watched) return
        await unwatch(projectId)
        entry.watched = false
      })
      await entry.operation
      if (entry.count === 0 && entries.get(projectId) === entry) entries.delete(projectId)
    },
  }
}

/** 每个 Adapter 身份共享一个项目 watch 引用计数器。 */
const mediaProjectWatchRegistries = new WeakMap<object, MediaProjectWatchLeaseRegistry>()

/** 获取 Adapter 级共享 watch 注册表，供 AV 卡片和展开工作台复用。 */
export function getMediaProjectWatchLeaseRegistry(
  adapter: MediaProjectWatchApi,
): MediaProjectWatchLeaseRegistry {
  const existing = mediaProjectWatchRegistries.get(adapter)
  if (existing) return existing
  const registry = createMediaProjectWatchLeaseRegistry(
    (projectId) => adapter.mediaWatchProject(projectId),
    (projectId) => adapter.mediaUnwatchProject(projectId),
  )
  mediaProjectWatchRegistries.set(adapter, registry)
  return registry
}

/** 正式 Renderer 的项目 watch 注册表，所有 Canvas 工作区共享。 */
const mediaProjectWatchRegistry = createMediaProjectWatchLeaseRegistry(
  (projectId) => window.electronAPI.mediaWatchProject(projectId),
  (projectId) => window.electronAPI.mediaUnwatchProject(projectId),
)

/** 订阅当前项目活跃 Comfy Job 的运行投影。 */
export function useMediaRunProgress(
  projectId: string,
  jobs: readonly MediaProgressJob[],
): ReadonlyMap<string, MediaRunProgressProjection> {
  /** 当前项目的轻量展示投影。 */
  const [progress, setProgress] = React.useState<ReadonlyMap<string, MediaRunProgressProjection>>(() => new Map())
  /** 最近控制器供 Job 列表 effect 增量同步。 */
  const controllerRef = React.useRef<MediaRunProgressController | null>(null)

  React.useEffect(() => {
    setProgress(new Map())
    /** 控制器固定绑定单个 projectId，项目切换通过 cleanup 完整释放。 */
    const controller = createMediaRunProgressController({
      projectId,
      onMediaRunChanged: (listener) => window.electronAPI.onMediaRunChanged(listener),
      acquireProjectWatch: (currentProjectId) => mediaProjectWatchRegistry.acquire(currentProjectId),
      releaseProjectWatch: (currentProjectId) => mediaProjectWatchRegistry.release(currentProjectId),
      getJobRun: (currentProjectId, jobId) => window.electronAPI.mediaGetJobRun(currentProjectId, jobId),
      onChange: (runs) => setProgress(new Map(
        [...runs].flatMap(([jobId, run]) => run
          ? [[jobId, projectMediaRunProgress(run)] as const]
          : []),
      )),
    })
    controllerRef.current = controller
    controller.start()
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null
      controller.dispose()
    }
  }, [projectId])

  React.useEffect(() => {
    controllerRef.current?.setJobs(jobs)
  }, [jobs, projectId])

  return progress
}
