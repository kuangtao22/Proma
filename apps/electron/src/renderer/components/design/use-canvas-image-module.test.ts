import { describe, expect, test } from 'bun:test'
import type {
  CanvasImageModuleConfig,
  CanvasImageModuleSnapshot,
  CanvasImageTarget,
  DesignJobRecord,
  DesignTaskDetails,
} from '@proma/shared'
import {
  createCanvasImageModuleController,
  createCanvasImageModuleLifecycleCoordinator,
} from './use-canvas-image-module'
import {
  createCanvasImageModuleKey,
  createInitialCanvasImageModuleState,
  type CanvasImageModuleStateUpdate,
  type CanvasImageModuleViewState,
} from '@/atoms/native-canvas-atoms'
import type { DesignAdapter } from '@/lib/design-adapter'
import { CanvasPublicOperationError } from '@/lib/design-adapter'

/** 创建可手动完成的 Promise，用于稳定制造迟到回调。 */
function deferred<T>() {
  let resolveValue: ((value: T) => void) | undefined
  let rejectValue: ((error: Error) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve
    rejectValue = reject
  })
  return {
    promise,
    resolve: (value: T) => resolveValue?.(value),
    reject: (error: Error) => rejectValue?.(error),
  }
}

/** 刷新 Promise 回调队列。 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** 创建完整图片模块身份。 */
function target(suffix: string): CanvasImageTarget {
  return {
    projectId: 'project-a', canvasId: 'canvas-a', nodeId: `node-${suffix}`, imageModuleId: `module-${suffix}`,
  }
}

/** 创建指定 revision 的权威图片配置。 */
function config(moduleTarget: CanvasImageTarget, revision: number, prompt = `prompt-${revision}`): CanvasImageModuleConfig {
  return {
    schemaVersion: 2, kind: 'image', contentId: moduleTarget.imageModuleId,
    revision, createdAt: 1, updatedAt: revision + 1, prompt,
    selectedModelProfileId: null, aspectRatio: '1:1', imageSize: 'auto',
    contextMode: 'none', adoptedAssetId: null,
  }
}

/** 创建图片模块权威快照。 */
function snapshot(moduleTarget: CanvasImageTarget, revision: number, prompt?: string): CanvasImageModuleSnapshot {
  return {
    target: structuredClone(moduleTarget), config: config(moduleTarget, revision, prompt),
    jobs: [], assets: [], assetBaseUrl: 'proma://asset', thumbnailBaseUrl: 'proma://thumbnail',
  }
}

/** 创建测试所需的最小权威任务记录。 */
function jobRecord(moduleTarget: CanvasImageTarget, jobId: string): DesignJobRecord {
  return {
    id: jobId,
    creativeTaskId: `task-${jobId}`,
    attemptNumber: 1,
    projectId: moduleTarget.projectId,
    target: {
      kind: 'canvas-image', canvasId: moduleTarget.canvasId,
      nodeId: moduleTarget.nodeId, imageModuleId: moduleTarget.imageModuleId,
    },
    action: 'generate',
    status: 'succeeded',
    prompt: '测试任务',
    originalRequest: '测试任务',
    contextMode: 'none',
    createdAt: 1,
    updatedAt: 1,
  }
}

/** 创建带指定 adopted 素材的权威快照。 */
function adoptedSnapshot(
  moduleTarget: CanvasImageTarget,
  revision: number,
  adoptedAssetId: string,
): CanvasImageModuleSnapshot {
  const current = snapshot(moduleTarget, revision)
  return { ...current, config: { ...current.config, adoptedAssetId } }
}

/** 创建带指定任务集合的权威快照。 */
function jobsSnapshot(
  moduleTarget: CanvasImageTarget,
  revision: number,
  jobIds: string[],
): CanvasImageModuleSnapshot {
  return { ...snapshot(moduleTarget, revision), jobs: jobIds.map((jobId) => jobRecord(moduleTarget, jobId)) }
}

/** 创建只使用本任务窄合同的可控测试夹具。 */
function createFixture() {
  const states = new Map<string, CanvasImageModuleViewState>()
  const loadCalls: CanvasImageTarget[] = []
  const saveCalls: Parameters<DesignAdapter['saveCanvasImageModule']>[0][] = []
  const createCalls: Parameters<DesignAdapter['createCanvasImageJob']>[0][] = []
  const releaseCalls: CanvasImageTarget[] = []
  const listeners = new Map<string, Set<(event: CanvasImageTarget) => void>>()
  const loadQueue: Array<ReturnType<typeof deferred<CanvasImageModuleSnapshot>>> = []
  const saveQueue: Array<ReturnType<typeof deferred<CanvasImageModuleConfig>>> = []
  const jobQueue: Array<ReturnType<typeof deferred<DesignJobRecord>>> = []
  const detailQueue: Array<ReturnType<typeof deferred<DesignTaskDetails>>> = []
  const traceQueue: Array<ReturnType<typeof deferred<DesignTaskDetails>>> = []
  const microtasks: Array<() => void> = []
  const lifecycle = createCanvasImageModuleLifecycleCoordinator((task) => microtasks.push(task))
  const adapter: Pick<DesignAdapter,
    'loadCanvasImageModule' | 'saveCanvasImageModule' | 'createCanvasImageJob'
    | 'cancelCanvasImageJob' | 'retryCanvasImageJob' | 'adoptCanvasImageAsset'
    | 'releaseCanvasImageMedia' | 'onCanvasImageModuleChanged' | 'getTaskDetails' | 'getTaskTrace'> = {
    loadCanvasImageModule: (input) => {
      loadCalls.push(structuredClone(input))
      const request = deferred<CanvasImageModuleSnapshot>()
      loadQueue.push(request)
      return request.promise
    },
    saveCanvasImageModule: (input) => {
      saveCalls.push(structuredClone(input))
      const request = deferred<CanvasImageModuleConfig>()
      saveQueue.push(request)
      return request.promise
    },
    createCanvasImageJob: (input) => {
      createCalls.push(structuredClone(input))
      const request = deferred<DesignJobRecord>()
      jobQueue.push(request)
      return request.promise
    },
    cancelCanvasImageJob: () => {
      const request = deferred<DesignJobRecord>()
      jobQueue.push(request)
      return request.promise
    },
    retryCanvasImageJob: () => {
      const request = deferred<DesignJobRecord>()
      jobQueue.push(request)
      return request.promise
    },
    adoptCanvasImageAsset: () => {
      const request = deferred<CanvasImageModuleConfig>()
      saveQueue.push(request)
      return request.promise
    },
    releaseCanvasImageMedia: async (input) => { releaseCalls.push(structuredClone(input)) },
    onCanvasImageModuleChanged: (moduleTarget, listener) => {
      const key = createCanvasImageModuleKey(moduleTarget)
      const entries = listeners.get(key) ?? new Set()
      listeners.set(key, entries)
      entries.add(listener)
      return () => { entries.delete(listener) }
    },
    getTaskDetails: () => {
      const request = deferred<DesignTaskDetails>()
      detailQueue.push(request)
      return request.promise
    },
    getTaskTrace: () => {
      const request = deferred<DesignTaskDetails>()
      traceQueue.push(request)
      return request.promise
    },
  }
  const state = (moduleTarget: CanvasImageTarget): CanvasImageModuleViewState => (
    states.get(createCanvasImageModuleKey(moduleTarget)) ?? createInitialCanvasImageModuleState()
  )
  const controller = (moduleTarget: CanvasImageTarget) => createCanvasImageModuleController({
    target: moduleTarget,
    adapter,
    lifecycle,
    getState: (key) => states.get(key),
    updateState: (key, update: CanvasImageModuleStateUpdate) => {
      const current = states.get(key) ?? createInitialCanvasImageModuleState()
      states.set(key, { ...current, ...(typeof update === 'function' ? update(current) : update) })
    },
    removeState: (key) => { states.delete(key) },
  })
  return {
    states, state, controller, loadCalls, saveCalls, createCalls, releaseCalls,
    loadQueue, saveQueue, jobQueue, detailQueue, traceQueue,
    emit: (moduleTarget: CanvasImageTarget) => {
      for (const listener of listeners.get(createCanvasImageModuleKey(moduleTarget)) ?? []) listener(moduleTarget)
    },
    runMicrotasks: () => { for (const task of microtasks.splice(0)) task() },
  }
}

describe('Canvas 生图模块 controller', () => {
  test('Given A 与 B 已加载 When A 事件到达 Then 只刷新 A', async () => {
    const fixture = createFixture()
    const targetA = target('a')
    const targetB = target('b')
    const controllerA = fixture.controller(targetA)
    const controllerB = fixture.controller(targetB)
    controllerA.start()
    controllerB.start()
    fixture.loadQueue[0]?.resolve(snapshot(targetA, 1))
    fixture.loadQueue[1]?.resolve(snapshot(targetB, 1))
    await flush()

    fixture.emit(targetA)
    expect(fixture.loadCalls).toEqual([targetA, targetB, targetA])
    fixture.loadQueue[2]?.resolve(snapshot(targetA, 2))
    await flush()

    expect(fixture.state(targetA).snapshot?.config.revision).toBe(2)
    expect(fixture.state(targetB).snapshot?.config.revision).toBe(1)
  })

  test('Given A LOAD 在途 When 切换 B 后 A 返回 Then A 迟到结果零副作用并释放媒体', async () => {
    const fixture = createFixture()
    const targetA = target('a')
    const targetB = target('b')
    const controllerA = fixture.controller(targetA)
    controllerA.start()
    controllerA.dispose()
    const controllerB = fixture.controller(targetB)
    controllerB.start()
    fixture.loadQueue[0]?.resolve(snapshot(targetA, 1))
    fixture.loadQueue[1]?.resolve(snapshot(targetB, 2))
    fixture.runMicrotasks()
    await flush()

    expect(fixture.state(targetA).snapshot).toBeNull()
    expect(fixture.states.has(createCanvasImageModuleKey(targetA))).toBe(false)
    expect(fixture.state(targetB).snapshot?.target).toEqual(targetB)
    expect(fixture.releaseCalls).toEqual([targetA])
  })

  test.each(['recovery', 'delete'] as const)(
    'Given 模块已加载 When %s 使目标失效 Then generation、状态和媒体均幂等释放',
    async (reason) => {
      const fixture = createFixture()
      const moduleTarget = target(reason)
      const controller = fixture.controller(moduleTarget)
      controller.start()
      fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 1))
      await flush()

      controller.invalidate(reason)
      controller.invalidate(reason)
      fixture.emit(moduleTarget)
      await flush()

      expect(fixture.states.has(createCanvasImageModuleKey(moduleTarget))).toBe(false)
      expect(fixture.releaseCalls).toEqual([moduleTarget])
      expect(fixture.loadCalls).toHaveLength(1)
    },
  )

  test('Given StrictMode 同 key 清理后重挂 When 微任务执行 Then 不释放新实例媒体', async () => {
    const fixture = createFixture()
    const moduleTarget = target('strict')
    const first = fixture.controller(moduleTarget)
    first.start()
    first.dispose()
    const second = fixture.controller(moduleTarget)
    second.start()
    fixture.runMicrotasks()
    await flush()
    expect(fixture.releaseCalls).toEqual([])

    second.dispose()
    fixture.runMicrotasks()
    await flush()
    expect(fixture.releaseCalls).toEqual([moduleTarget])
  })

  test('Given 草稿未 dirty When commitDraft Then 不调用保存', async () => {
    const fixture = createFixture()
    const moduleTarget = target('clean')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 7))
    await flush()

    await controller.commitDraft()
    expect(fixture.saveCalls).toEqual([])
  })

  test('Given dirty 草稿 When 保存成功 Then 使用权威 revision 并接管服务端 config', async () => {
    const fixture = createFixture()
    const moduleTarget = target('save')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 7))
    await flush()
    controller.updateDraft({ prompt: '本地新提示词' })

    const pendingCommit = controller.commitDraft()
    expect(fixture.saveCalls[0]).toMatchObject({ expectedConfigRevision: 7, prompt: '本地新提示词' })
    fixture.saveQueue[0]?.resolve(config(moduleTarget, 8, '服务端规范提示词'))
    await pendingCommit

    expect(fixture.state(moduleTarget)).toMatchObject({ saveState: 'saved', error: null })
    expect(fixture.state(moduleTarget).snapshot?.config).toEqual(config(moduleTarget, 8, '服务端规范提示词'))
    expect(fixture.state(moduleTarget).draft).toMatchObject({ prompt: '服务端规范提示词', dirty: false })
  })

  test('Given dirty 草稿 When revision conflict Then 保留本地草稿和错误且不写入新目标', async () => {
    const fixture = createFixture()
    const targetA = target('conflict-a')
    const controllerA = fixture.controller(targetA)
    controllerA.start()
    fixture.loadQueue[0]?.resolve(snapshot(targetA, 3))
    await flush()
    controllerA.updateDraft({ prompt: '必须保留的本地草稿' })
    const commit = controllerA.commitDraft()
    fixture.saveQueue[0]?.reject(new CanvasPublicOperationError('CANVAS_IMAGE_REVISION_CONFLICT', '配置已在其他窗口更新'))
    await expect(commit).rejects.toThrow('配置已在其他窗口更新')

    expect(fixture.state(targetA)).toMatchObject({
      saveState: 'conflict', error: '配置已在其他窗口更新',
      draft: { prompt: '必须保留的本地草稿', dirty: true },
    })
  })

  test('Given SAVE 在途 When 图片事件 LOAD 先返回更高 revision Then SAVE 成功收口且不回退权威配置', async () => {
    const fixture = createFixture()
    const moduleTarget = target('save-load')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 4))
    await flush()
    controller.updateDraft({ prompt: '本地草稿' })
    const pendingSave = controller.commitDraft()

    fixture.emit(moduleTarget)
    fixture.loadQueue[1]?.resolve(snapshot(moduleTarget, 6, '更高权威配置'))
    await flush()
    expect(fixture.state(moduleTarget)).toMatchObject({ saveState: 'saving' })
    expect(fixture.state(moduleTarget).snapshot?.config.revision).toBe(6)

    fixture.saveQueue[0]?.resolve(config(moduleTarget, 5, '较旧保存结果'))
    await pendingSave

    expect(fixture.state(moduleTarget).snapshot?.config).toEqual(config(moduleTarget, 6, '更高权威配置'))
    expect(fixture.state(moduleTarget)).toMatchObject({
      saveState: 'saved', error: null, draft: { prompt: '更高权威配置', dirty: false },
    })
  })

  test('Given SAVE 在途 When 启动 job 和 detail Then SAVE 返回仍接管服务端配置并结束 saving', async () => {
    const fixture = createFixture()
    const moduleTarget = target('save-job-detail')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 4))
    await flush()
    controller.updateDraft({ prompt: '本地草稿' })
    const pendingSave = controller.commitDraft()
    const pendingJob = controller.createJob()
    const pendingDetails = controller.loadTaskDetails('job-detail')

    fixture.saveQueue[0]?.resolve(config(moduleTarget, 5, '服务端保存结果'))
    await pendingSave

    expect(fixture.state(moduleTarget)).toMatchObject({
      saveState: 'saved', error: null, draft: { prompt: '服务端保存结果', dirty: false },
    })
    expect(fixture.state(moduleTarget).snapshot?.config.revision).toBe(5)

    fixture.jobQueue[0]?.reject(new Error('任务测试收口'))
    fixture.detailQueue[0]?.resolve({
      creativeTaskId: 'task-detail', currentJobId: 'job-detail', attempts: [], traceState: 'ready',
    })
    await expect(pendingJob).rejects.toThrow('任务测试收口')
    await pendingDetails
  })

  test('Given 两个不同 job 详情并发 When 后发先回 Then 两个 job 各自保存结果', async () => {
    const fixture = createFixture()
    const moduleTarget = target('details-parallel')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 1))
    await flush()

    const jobA = controller.loadTaskDetails('job-a')
    const jobB = controller.loadTaskDetails('job-b')
    fixture.detailQueue[1]?.resolve({
      creativeTaskId: 'task-b', currentJobId: 'job-b', attempts: [], traceState: 'ready',
    })
    await flush()
    fixture.detailQueue[0]?.resolve({
      creativeTaskId: 'task-a', currentJobId: 'job-a', attempts: [], traceState: 'ready',
    })
    await Promise.all([jobA, jobB])

    expect(fixture.state(moduleTarget).taskDetails.get('job-a')?.details?.creativeTaskId).toBe('task-a')
    expect(fixture.state(moduleTarget).taskDetails.get('job-b')?.details?.creativeTaskId).toBe('task-b')
  })

  test('Given 同一 job 详情连续请求 When 旧请求最后返回 Then 只保留该 job 最新结果', async () => {
    const fixture = createFixture()
    const moduleTarget = target('details-latest')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 1))
    await flush()

    const older = controller.loadTaskDetails('job-same')
    const newer = controller.loadTaskDetails('job-same')
    fixture.detailQueue[1]?.resolve({
      creativeTaskId: 'task-new', currentJobId: 'job-same', attempts: [], traceState: 'ready',
    })
    await flush()
    fixture.detailQueue[0]?.resolve({
      creativeTaskId: 'task-old', currentJobId: 'job-same', attempts: [], traceState: 'ready',
    })
    await Promise.all([older, newer])

    expect(fixture.state(moduleTarget).taskDetails.get('job-same')?.details?.creativeTaskId).toBe('task-new')
  })

  test('Given adopt 回调在途 When 模块删除 Then 返回结果不复活状态', async () => {
    const fixture = createFixture()
    const moduleTarget = target('adopt')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 1))
    await flush()
    void controller.adoptAsset('job-a', 'asset-a')
    controller.invalidate('delete')
    fixture.saveQueue[0]?.resolve({ ...config(moduleTarget, 2), adoptedAssetId: 'asset-a' })
    await flush()

    expect(fixture.states.has(createCanvasImageModuleKey(moduleTarget))).toBe(false)
  })

  test('Given 用户展开 Thinking When 加载任务详情 Then 按需接管 trace 且不触发第二次详情状态域', async () => {
    const fixture = createFixture()
    const moduleTarget = target('trace')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 1))
    await flush()

    const loading = controller.loadTaskDetails('job-trace', true)
    fixture.traceQueue[0]?.resolve({
      creativeTaskId: 'task-trace', currentJobId: 'job-trace', attempts: [], traceState: 'ready', trace: [],
    })
    await loading

    expect(fixture.state(moduleTarget).taskDetails.get('job-trace')?.details).toMatchObject({
      traceState: 'ready', trace: [],
    })
  })

  test('Given preview 跟随 adopted When 任务自动采用新素材 Then null 语义派生最新 adopted', async () => {
    const fixture = createFixture()
    const moduleTarget = target('preview-follow')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(adoptedSnapshot(moduleTarget, 1, 'asset-a'))
    await flush()

    expect(fixture.state(moduleTarget).previewAssetId).toBeNull()
    expect(fixture.state(moduleTarget).previewAssetId
      ?? fixture.state(moduleTarget).snapshot?.config.adoptedAssetId).toBe('asset-a')

    fixture.emit(moduleTarget)
    fixture.loadQueue[1]?.resolve(adoptedSnapshot(moduleTarget, 2, 'asset-b'))
    await flush()

    expect(fixture.state(moduleTarget).previewAssetId).toBeNull()
    expect(fixture.state(moduleTarget).previewAssetId
      ?? fixture.state(moduleTarget).snapshot?.config.adoptedAssetId).toBe('asset-b')
  })

  test('Given 用户显式预览历史素材 When 事件更新 adopted Then 保留预览；显式采用成功后恢复跟随', async () => {
    const fixture = createFixture()
    const moduleTarget = target('preview-explicit')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(adoptedSnapshot(moduleTarget, 1, 'asset-a'))
    await flush()
    controller.previewAsset('asset-history')

    fixture.emit(moduleTarget)
    fixture.loadQueue[1]?.resolve(adoptedSnapshot(moduleTarget, 2, 'asset-b'))
    await flush()
    expect(fixture.state(moduleTarget).previewAssetId).toBe('asset-history')

    const adopting = controller.adoptAsset('job-history', 'asset-history')
    fixture.saveQueue[0]?.resolve({
      ...config(moduleTarget, 3), adoptedAssetId: 'asset-history',
    })
    await adopting

    expect(fixture.state(moduleTarget).previewAssetId).toBeNull()
    expect(fixture.state(moduleTarget).previewAssetId
      ?? fixture.state(moduleTarget).snapshot?.config.adoptedAssetId).toBe('asset-history')
  })

  test('Given 较早 LOAD 在途 When SAVE conflict 先到 Then LOAD 成功不得清除 SAVE error', async () => {
    const fixture = createFixture()
    const moduleTarget = target('error-save-load')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 1))
    await flush()
    fixture.emit(moduleTarget)
    controller.updateDraft({ prompt: '冲突草稿' })
    const saving = controller.commitDraft()
    fixture.saveQueue[0]?.reject(new CanvasPublicOperationError(
      'CANVAS_IMAGE_REVISION_CONFLICT', '配置已在其他窗口更新',
    ))
    await expect(saving).rejects.toThrow('配置已在其他窗口更新')

    fixture.loadQueue[1]?.resolve(snapshot(moduleTarget, 2))
    await flush()
    expect(fixture.state(moduleTarget)).toMatchObject({
      saveState: 'conflict', error: '配置已在其他窗口更新',
    })
  })

  test('Given SAVE conflict 已显示 When 无关 JOB 开始并失败 Then 不能提前清除 SAVE error', async () => {
    const fixture = createFixture()
    const moduleTarget = target('error-save-job')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 1))
    await flush()
    controller.updateDraft({ prompt: '冲突草稿' })
    const saving = controller.commitDraft()
    fixture.saveQueue[0]?.reject(new CanvasPublicOperationError(
      'CANVAS_IMAGE_REVISION_CONFLICT', '配置已在其他窗口更新',
    ))
    await expect(saving).rejects.toThrow()

    const job = controller.createJob()
    expect(fixture.state(moduleTarget).error).toBe('配置已在其他窗口更新')
    fixture.jobQueue[0]?.reject(new Error('任务失败'))
    await expect(job).rejects.toThrow('任务失败')
    expect(fixture.state(moduleTarget).error).toBe('任务失败')
  })

  test('Given LOAD error 已显示 When SAVE 成功 Then 无关 SAVE 不得清除 LOAD error', async () => {
    const fixture = createFixture()
    const moduleTarget = target('error-load-save')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 1))
    await flush()
    fixture.emit(moduleTarget)
    fixture.loadQueue[1]?.reject(new Error('LOAD 失败'))
    await flush()
    controller.updateDraft({ prompt: '仍可保存的草稿' })

    const saving = controller.commitDraft()
    expect(fixture.state(moduleTarget).error).toBe('LOAD 失败')
    fixture.saveQueue[0]?.resolve(config(moduleTarget, 2, '服务端保存'))
    await saving
    expect(fixture.state(moduleTarget).error).toBe('LOAD 失败')
  })

  test('Given 超过详情缓存上限的 trace When 依次加载 Then 只保留最近 20 个并淘汰 generation', async () => {
    const fixture = createFixture()
    const moduleTarget = target('details-limit')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 1))
    await flush()

    for (let index = 0; index < 21; index += 1) {
      const jobId = `job-${index}`
      const loading = controller.loadTaskDetails(jobId, true)
      fixture.traceQueue[index]?.resolve({
        creativeTaskId: `task-${index}`, currentJobId: jobId,
        attempts: [], traceState: 'ready', trace: [],
      })
      await loading
    }

    expect(fixture.state(moduleTarget).taskDetails.size).toBe(20)
    expect(fixture.state(moduleTarget).taskDetails.has('job-0')).toBe(false)
    expect(fixture.state(moduleTarget).taskDetails.has('job-20')).toBe(true)
  })

  test('Given job A 详情在途且被 LRU 淘汰 When 再请求 A 先成功且旧请求后失败 Then 旧回调不得覆盖新状态', async () => {
    const fixture = createFixture()
    const moduleTarget = target('details-lru-generation')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 1))
    await flush()

    /** 首次 A 请求保持在途，等待其 generation 被 LRU 清理。 */
    const older = controller.loadTaskDetails('job-a')
    for (let index = 0; index < 20; index += 1) {
      /** 依次访问 20 个其它任务，使最旧的 A 详情退出缓存。 */
      const filler = controller.loadTaskDetails(`job-filler-${index}`)
      fixture.detailQueue[index + 1]?.resolve({
        creativeTaskId: `task-filler-${index}`,
        currentJobId: `job-filler-${index}`,
        attempts: [],
        traceState: 'ready',
      })
      await filler
    }
    expect(fixture.state(moduleTarget).taskDetails.has('job-a')).toBe(false)

    /** 第二次 A 请求必须取得不同于旧请求的全局单调 token。 */
    const newer = controller.loadTaskDetails('job-a')
    fixture.detailQueue[21]?.resolve({
      creativeTaskId: 'task-new', currentJobId: 'job-a', attempts: [], traceState: 'ready',
    })
    await newer

    fixture.detailQueue[0]?.reject(new Error('旧请求迟到失败'))
    await expect(older).rejects.toThrow('任务详情暂时无法加载。')
    expect(fixture.state(moduleTarget).taskDetails.get('job-a')).toMatchObject({
      phase: 'ready',
      details: { creativeTaskId: 'task-new' },
      error: null,
    })
  })

  test('Given 权威 LOAD 不再包含旧 job When 事件刷新 Then 删除旧详情并保留仍存在 job', async () => {
    const fixture = createFixture()
    const moduleTarget = target('details-authority')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(jobsSnapshot(moduleTarget, 1, ['job-a', 'job-b']))
    await flush()
    const jobA = controller.loadTaskDetails('job-a')
    const jobB = controller.loadTaskDetails('job-b')
    fixture.detailQueue[0]?.resolve({
      creativeTaskId: 'task-a', currentJobId: 'job-a', attempts: [], traceState: 'ready',
    })
    fixture.detailQueue[1]?.resolve({
      creativeTaskId: 'task-b', currentJobId: 'job-b', attempts: [], traceState: 'ready',
    })
    await Promise.all([jobA, jobB])

    fixture.emit(moduleTarget)
    fixture.loadQueue[1]?.resolve(jobsSnapshot(moduleTarget, 2, ['job-b']))
    await flush()

    expect(fixture.state(moduleTarget).taskDetails.has('job-a')).toBe(false)
    expect(fixture.state(moduleTarget).taskDetails.get('job-b')?.details?.creativeTaskId).toBe('task-b')
  })

  test('Given legacy 详情异常包含路径 UUID 和堆栈 When 加载失败 Then state 与 rejection 只保留固定中文', async () => {
    const fixture = createFixture()
    const moduleTarget = target('details-safe-error')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 1))
    await flush()
    const loading = controller.loadTaskDetails('job-secret')
    fixture.detailQueue[0]?.reject(new Error(
      '/Users/secret/design.json 123e4567-e89b-12d3-a456-426614174000\n at internal()',
    ))

    await expect(loading).rejects.toThrow('任务详情暂时无法加载。')
    expect(fixture.state(moduleTarget).taskDetails.get('job-secret')).toMatchObject({
      phase: 'failed', error: '任务详情暂时无法加载。',
    })
    expect(JSON.stringify(fixture.state(moduleTarget).taskDetails.get('job-secret'))).not.toContain('/Users/secret')
  })
})
