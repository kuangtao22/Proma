import { describe, expect, test } from 'bun:test'
import type {
  CanvasMediaModuleChangedEvent,
  CanvasMediaModuleSnapshot,
  CanvasMediaTarget,
  DesignJobRecord,
  MediaRunEvent,
  MediaRunSnapshot,
} from '@proma/shared'
import {
  createCanvasMediaNodeProgressController,
  createMediaRunProgressController,
  createMediaProjectWatchLeaseRegistry,
  projectMediaRunProgress,
  type MediaProgressJob,
} from './use-media-run-progress'

/** 创建 AV 节点目标，moduleId 与 nodeId 可用于模拟布局刷新和模块切换。 */
const mediaTarget = (mediaModuleId = 'media-1', nodeId = 'video-1'): CanvasMediaTarget => ({
  projectId: 'project-a', canvasId: 'canvas-a', nodeId, mediaModuleId, mediaKind: 'video',
})

/** 创建只包含运行事实的最小媒体模块快照。 */
const mediaSnapshot = (
  target: CanvasMediaTarget,
  runs: MediaRunSnapshot[],
): CanvasMediaModuleSnapshot => ({
  target,
  config: {
    schemaVersion: 1,
    contentId: target.mediaModuleId,
    mediaKind: target.mediaKind,
    revision: 1,
    profile: null,
    inputs: [],
    outputs: [],
    adoptedOutputs: [],
    createdAt: 1,
    updatedAt: 1,
  },
  candidates: [],
  runs,
  assets: [],
})

const job = (id: string): DesignJobRecord => ({
  id, creativeTaskId: `task-${id}`, attemptNumber: 1, projectId: 'project-a',
  target: { kind: 'canvas-image', canvasId: 'canvas-a', nodeId: `node-${id}`, imageModuleId: `module-${id}` },
  action: 'generate', status: 'running', prompt: '生成图片', originalRequest: '生成图片', contextMode: 'none',
  imageModelSnapshot: {
    profileId: 'media:preset:1', name: 'Comfy', modelId: 'workflow', executor: 'comfyui',
    mediaProfileId: 'preset', mediaProfileRevision: 1, connectionId: 'connection',
    workflowId: 'workflow', workflowRevision: 1, workflowHash: 'a'.repeat(64),
  },
  createdAt: 1,
  updatedAt: 1,
})

const run = (revision: number, overrides: Partial<MediaRunSnapshot> = {}): MediaRunSnapshot => ({
  id: 'run-1', projectId: 'project-a', revision, phase: 'running', profileId: 'preset', profileRevision: 1,
  createdAt: 1, updatedAt: revision, outputs: [], error: null, progress: null, ...overrides,
})

describe('媒体运行进度控制器', () => {
  test('Given 同项目多消费者与 StrictMode 重挂载, When 获取释放 lease, Then watch/unwatch 始终成对且不重复', async () => {
    let watches = 0
    let unwatches = 0
    const registry = createMediaProjectWatchLeaseRegistry(
      async () => { watches += 1 },
      async () => { unwatches += 1 },
    )
    await Promise.all([registry.acquire('project-a'), registry.acquire('project-a')])
    await registry.release('project-a')
    expect({ watches, unwatches }).toEqual({ watches: 1, unwatches: 0 })

    /** 释放与同项目重挂载并发时，仍在 watch 的项目无需重复订阅。 */
    const releasing = registry.release('project-a')
    const reacquiring = registry.acquire('project-a')
    await Promise.all([releasing, reacquiring])
    expect({ watches, unwatches }).toEqual({ watches: 1, unwatches: 0 })
    await registry.release('project-a')
    expect({ watches, unwatches }).toEqual({ watches: 1, unwatches: 1 })
  })

  test('Given 活跃 Comfy Job, When 启动, Then 先监听再 watch 并加载运行快照', async () => {
    /** 调用顺序用于证明不会漏掉 watch 启动期间的事件。 */
    const order: string[] = []
    /** 对象属性避免 TypeScript 把异步注册赋值收窄为不可达。 */
    const listenerRef: { current?: (event: MediaRunEvent) => void } = {}
    const snapshots: Array<ReadonlyMap<string, MediaRunSnapshot | null>> = []
    const controller = createMediaRunProgressController({
      projectId: 'project-a',
      onMediaRunChanged: (callback) => { order.push('listen'); listenerRef.current = callback; return () => order.push('unlisten') },
      acquireProjectWatch: async () => { order.push('watch') },
      releaseProjectWatch: async () => { order.push('unwatch') },
      getJobRun: async (_projectId, jobId) => { order.push(`get:${jobId}`); return run(1) },
      onChange: (next) => snapshots.push(new Map(next)),
    })
    controller.setJobs([job('job-1')])
    controller.start()
    await controller.whenIdle()

    expect(order.slice(0, 3)).toEqual(['listen', 'watch', 'get:job-1'])
    expect(snapshots.at(-1)?.get('job-1')?.revision).toBe(1)
    expect(listenerRef.current).toBeDefined()
  })

  test('Given Canvas 仅提供轻量活动任务 When 加载进度 Then 不依赖完整模型快照', async () => {
    const requestedJobs: string[] = []
    const activity: MediaProgressJob = {
      id: 'job-light', projectId: 'project-a', status: 'running',
      target: { kind: 'canvas-image', canvasId: 'canvas-a', nodeId: 'node-light', imageModuleId: 'module-light' },
    }
    const controller = createMediaRunProgressController({
      projectId: 'project-a',
      onMediaRunChanged: () => () => undefined,
      acquireProjectWatch: async () => undefined,
      releaseProjectWatch: async () => undefined,
      getJobRun: async (_projectId, jobId) => { requestedJobs.push(jobId); return run(1) },
      onChange: () => undefined,
    })

    controller.setJobs([activity])
    controller.start()
    await controller.whenIdle()
    controller.dispose()
    await controller.whenIdle()

    expect(requestedJobs).toEqual(['job-light'])
  })

  test('Given 新 revision 已到达, When 旧事件和旧请求迟到, Then 不覆盖当前项目事实', async () => {
    /** 事件与请求完成器通过可变 holder 模拟独立异步来源。 */
    const listenerRef: { current?: (event: MediaRunEvent) => void } = {}
    const loadRef: { current?: (value: MediaRunSnapshot | null) => void } = {}
    const snapshots: Array<ReadonlyMap<string, MediaRunSnapshot | null>> = []
    const controller = createMediaRunProgressController({
      projectId: 'project-a',
      onMediaRunChanged: (callback) => { listenerRef.current = callback; return () => undefined },
      acquireProjectWatch: async () => undefined,
      releaseProjectWatch: async () => undefined,
      getJobRun: async () => await new Promise((resolve) => { loadRef.current = resolve }),
      onChange: (next) => snapshots.push(new Map(next)),
    })
    controller.setJobs([job('job-1')])
    controller.start()
    while (!loadRef.current) await Promise.resolve()
    listenerRef.current?.({ designJobId: 'job-1', run: run(3, { progress: { nodeId: 'sampler', value: 4, max: 20 } }) })
    listenerRef.current?.({ designJobId: 'job-1', run: run(2) })
    listenerRef.current?.({ designJobId: 'job-1', run: run(9, { projectId: 'project-b' }) })
    loadRef.current(run(1))
    await controller.whenIdle()

    expect(snapshots.at(-1)?.get('job-1')?.revision).toBe(3)
    expect(snapshots.at(-1)?.get('job-1')?.progress).toEqual({ nodeId: 'sampler', value: 4, max: 20 })
  })

  test('Given 项目控制器已释放, When 请求迟到, Then 清空投影并成对 unwatch', async () => {
    /** 请求完成器用于模拟项目切换后的迟到响应。 */
    const loadRef: { current?: (value: MediaRunSnapshot | null) => void } = {}
    let releases = 0
    const snapshots: Array<ReadonlyMap<string, MediaRunSnapshot | null>> = []
    const controller = createMediaRunProgressController({
      projectId: 'project-a',
      onMediaRunChanged: () => () => undefined,
      acquireProjectWatch: async () => undefined,
      releaseProjectWatch: async () => { releases += 1 },
      getJobRun: async () => await new Promise((resolve) => { loadRef.current = resolve }),
      onChange: (next) => snapshots.push(new Map(next)),
    })
    controller.setJobs([job('job-1')])
    controller.start()
    while (!loadRef.current) await Promise.resolve()
    controller.dispose()
    loadRef.current(run(1))
    await controller.whenIdle()

    expect(releases).toBe(1)
    expect(snapshots.at(-1)?.size).toBe(0)
  })
})

describe('Canvas AV 节点进度控制器', () => {
  test('Given 画布没有 AV 目标 When 控制器启动和释放 Then 不申请空项目 watch', async () => {
    const calls: string[] = []
    const controller = createCanvasMediaNodeProgressController({
      projectId: '',
      canvasMediaLoad: async (target) => mediaSnapshot(target, []),
      onCanvasMediaChanged: () => () => undefined,
      onMediaRunChanged: () => () => undefined,
      acquireProjectWatch: async (projectId) => { calls.push(`watch:${projectId}`) },
      releaseProjectWatch: async (projectId) => { calls.push(`unwatch:${projectId}`) },
      onChange: () => undefined,
    })
    controller.setTargets([])
    controller.start()
    controller.dispose()
    await controller.whenIdle()

    expect(calls).toEqual([])
  })

  test('Given 项目 watch 尚未建立 When AV 控制器启动后立即释放 Then 不读取模块且迟到 acquire 后准确 unwatch', async () => {
    /** 手动完成 watch，模拟 Host 尚未登记当前 webContents 的窗口。 */
    let resolveWatch!: () => void
    const calls: string[] = []
    const target = mediaTarget()
    const controller = createCanvasMediaNodeProgressController({
      projectId: target.projectId,
      canvasMediaLoad: async () => { calls.push('load'); return mediaSnapshot(target, [run(1)]) },
      onCanvasMediaChanged: () => { calls.push('listen:module'); return () => calls.push('unlisten:module') },
      onMediaRunChanged: () => { calls.push('listen:run'); return () => calls.push('unlisten:run') },
      acquireProjectWatch: () => new Promise((resolve) => { resolveWatch = resolve }),
      releaseProjectWatch: async () => { calls.push('unwatch') },
      onChange: () => undefined,
    })
    controller.setTargets([target])
    controller.start()
    await Promise.resolve()
    expect(calls).toEqual(['listen:module', 'listen:run'])
    controller.dispose()
    resolveWatch()
    await controller.whenIdle()

    expect(calls).not.toContain('load')
    expect(calls.slice(-3)).toEqual(['unlisten:module', 'unlisten:run', 'unwatch'])
  })

  test('Given AV 模块已有运行 When 初次加载并收到新 revision Then 卡片投影只展示后端事实', async () => {
    const moduleListener: { current?: (event: CanvasMediaModuleChangedEvent) => void } = {}
    const runListener: { current?: (event: MediaRunEvent) => void } = {}
    const projections: Array<ReadonlyMap<string, ReturnType<typeof projectMediaRunProgress>>> = []
    const target = mediaTarget()
    const watchOrder: string[] = []
    const controller = createCanvasMediaNodeProgressController({
      projectId: target.projectId,
      canvasMediaLoad: async () => { watchOrder.push('load'); return mediaSnapshot(target, [run(1)]) },
      onCanvasMediaChanged: (listener) => { moduleListener.current = listener; return () => undefined },
      onMediaRunChanged: (listener) => { runListener.current = listener; return () => undefined },
      acquireProjectWatch: async () => { watchOrder.push('watch') },
      releaseProjectWatch: async () => { watchOrder.push('unwatch') },
      onChange: (progress) => projections.push(new Map(progress)),
    })
    controller.setTargets([target])
    controller.start()
    await controller.whenIdle()
    runListener.current?.({ run: run(2, { progress: { nodeId: 'sampler', value: 6, max: 20 } }) })

    expect(projections.at(-1)?.get('video-1')).toEqual({
      phase: 'running', phaseLabel: '运行中', nodeProgressLabel: '当前节点 sampler · 6/20',
    })
    expect(watchOrder.slice(0, 2)).toEqual(['watch', 'load'])
    expect(moduleListener.current).toBeDefined()
    controller.dispose()
    await controller.whenIdle()
    expect(watchOrder.at(-1)).toBe('unwatch')
  })

  test('Given 旧媒体目标 LOAD 在途 When 同节点切换到新模块 Then 迟到响应不能覆盖新目标', async () => {
    let resolveOld!: (snapshot: CanvasMediaModuleSnapshot) => void
    const oldTarget = mediaTarget('media-old')
    const newTarget = mediaTarget('media-new')
    const projections: Array<ReadonlyMap<string, ReturnType<typeof projectMediaRunProgress>>> = []
    const controller = createCanvasMediaNodeProgressController({
      projectId: oldTarget.projectId,
      canvasMediaLoad: (target) => target.mediaModuleId === 'media-old'
        ? new Promise((resolve) => { resolveOld = resolve })
        : Promise.resolve(mediaSnapshot(newTarget, [run(2, { phase: 'queued' })])),
      onCanvasMediaChanged: () => () => undefined,
      onMediaRunChanged: () => () => undefined,
      acquireProjectWatch: async () => undefined,
      releaseProjectWatch: async () => undefined,
      onChange: (progress) => projections.push(new Map(progress)),
    })
    controller.setTargets([oldTarget])
    controller.start()
    while (!resolveOld) await Promise.resolve()
    controller.setTargets([newTarget])
    resolveOld(mediaSnapshot(oldTarget, [run(9, { phase: 'failed' })]))
    await controller.whenIdle()

    expect(projections.at(-1)?.get('video-1')).toMatchObject({ phase: 'queued', phaseLabel: '排队中' })
  })

  test('Given 媒体目标 LOAD 在途 When 节点被删除 Then 迟到响应不能恢复旧投影', async () => {
    let resolveLoad!: (snapshot: CanvasMediaModuleSnapshot) => void
    const target = mediaTarget()
    const projections: Array<ReadonlyMap<string, ReturnType<typeof projectMediaRunProgress>>> = []
    const controller = createCanvasMediaNodeProgressController({
      projectId: target.projectId,
      canvasMediaLoad: async () => await new Promise((resolve) => { resolveLoad = resolve }),
      onCanvasMediaChanged: () => () => undefined,
      onMediaRunChanged: () => () => undefined,
      acquireProjectWatch: async () => undefined,
      releaseProjectWatch: async () => undefined,
      onChange: (progress) => projections.push(new Map(progress)),
    })
    controller.setTargets([target])
    controller.start()
    while (!resolveLoad) await Promise.resolve()
    controller.setTargets([])
    resolveLoad(mediaSnapshot(target, [run(9, { phase: 'failed' })]))
    await controller.whenIdle()

    expect(projections.at(-1)?.size).toBe(0)
  })

  test('Given 相同模块目标已加载 When 仅布局 revision 生成新目标数组 Then 不重复读取模块', async () => {
    const target = mediaTarget()
    let loads = 0
    const controller = createCanvasMediaNodeProgressController({
      projectId: target.projectId,
      canvasMediaLoad: async (current) => { loads += 1; return mediaSnapshot(current, [run(1)]) },
      onCanvasMediaChanged: () => () => undefined,
      onMediaRunChanged: () => () => undefined,
      acquireProjectWatch: async () => undefined,
      releaseProjectWatch: async () => undefined,
      onChange: () => undefined,
    })
    controller.setTargets([target])
    controller.start()
    await controller.whenIdle()
    controller.setTargets([{ ...target }])
    await controller.whenIdle()

    expect(loads).toBe(1)
  })

  test('Given 多个新增 AV 目标 When 初次加载 Then 同时读取不超过四个模块', async () => {
    const targets = Array.from({ length: 9 }, (_, index) => mediaTarget(`media-${index}`, `video-${index}`))
    let activeLoads = 0
    let startedLoads = 0
    let maximumActiveLoads = 0
    const resolvers: Array<() => void> = []
    const controller = createCanvasMediaNodeProgressController({
      projectId: 'project-a',
      canvasMediaLoad: async (target) => {
        activeLoads += 1
        startedLoads += 1
        maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads)
        await new Promise<void>((resolve) => { resolvers.push(resolve) })
        activeLoads -= 1
        return mediaSnapshot(target, [])
      },
      onCanvasMediaChanged: () => () => undefined,
      onMediaRunChanged: () => () => undefined,
      acquireProjectWatch: async () => undefined,
      releaseProjectWatch: async () => undefined,
      onChange: () => undefined,
    })
    controller.setTargets(targets.slice(0, 4))
    controller.start()
    while (resolvers.length < 4) await Promise.resolve()
    expect({ activeLoads, maximumActiveLoads }).toEqual({ activeLoads: 4, maximumActiveLoads: 4 })
    /** 首批仍在途时追加目标，新增批次也必须复用同一个并发预算。 */
    controller.setTargets(targets)
    await Promise.resolve()
    expect({ activeLoads, maximumActiveLoads }).toEqual({ activeLoads: 4, maximumActiveLoads: 4 })
    while (startedLoads < targets.length) {
      const previousStartedLoads = startedLoads
      resolvers.splice(0).forEach((resolve) => resolve())
      while (startedLoads === previousStartedLoads) await Promise.resolve()
    }
    resolvers.splice(0).forEach((resolve) => resolve())
    await controller.whenIdle()

    expect(maximumActiveLoads).toBe(4)
  })
})

describe('媒体运行展示投影', () => {
  test('Given 排队、阶段处理与节点采样, When 投影, Then 不把采样值描述为整体百分比', () => {
    expect(projectMediaRunProgress(run(1, { phase: 'queued' }))).toMatchObject({ phaseLabel: '排队中' })
    expect(projectMediaRunProgress(run(2, { phase: 'uploading' }))).toMatchObject({ phaseLabel: '正在上传素材' })
    expect(projectMediaRunProgress(run(3, { phase: 'submission-unknown' }))).toMatchObject({ phaseLabel: '提交状态待确认' })
    expect(projectMediaRunProgress(run(4, { phase: 'collecting' }))).toMatchObject({ phaseLabel: '正在收集结果' })
    expect(projectMediaRunProgress(run(5, { progress: { nodeId: 'sampler', value: 4, max: 20 } }))).toEqual({
      phase: 'running', phaseLabel: '运行中', nodeProgressLabel: '当前节点 sampler · 4/20',
    })
  })
})
