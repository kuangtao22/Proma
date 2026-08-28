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

  test('Given save/job/detail 同 key 依次在途 When 旧回调迟到 Then 只有最新 generation 可写', async () => {
    const fixture = createFixture()
    const moduleTarget = target('generation')
    const controller = fixture.controller(moduleTarget)
    controller.start()
    fixture.loadQueue[0]?.resolve(snapshot(moduleTarget, 4))
    await flush()
    controller.updateDraft({ prompt: '本地草稿' })
    const staleSave = controller.commitDraft()
    const staleJob = controller.createJob()
    const latestDetails = controller.loadTaskDetails('job-latest')

    fixture.saveQueue[0]?.resolve(config(moduleTarget, 5, '旧保存'))
    fixture.jobQueue[0]?.reject(new Error('旧任务失败'))
    fixture.detailQueue[0]?.resolve({
      creativeTaskId: 'task-1', currentJobId: 'job-latest', attempts: [], traceState: 'ready',
    })
    await staleSave
    await expect(staleJob).rejects.toThrow('旧任务失败')
    await latestDetails
    await flush()

    expect(fixture.state(moduleTarget).snapshot?.config.revision).toBe(4)
    expect(fixture.state(moduleTarget).error).toBeNull()
    expect(fixture.state(moduleTarget).taskDetails.get('job-latest')?.details).toEqual({
      creativeTaskId: 'task-1', currentJobId: 'job-latest', attempts: [], traceState: 'ready',
    })
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
})
