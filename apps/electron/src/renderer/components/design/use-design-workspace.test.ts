import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type {
  DesignCanvasDocument,
  DesignChangeEvent,
  DesignMutation,
  DesignWorkspaceSnapshot,
  SaveDesignMutationsInput,
} from '@proma/shared'
import { createInitialDesignProjectState } from '@/atoms/design-atoms'
import type { DesignProjectState } from '@/atoms/design-atoms'
import {
  DESIGN_SAVE_DEBOUNCE_MS,
  applyDesignMutationsToDocument,
  createDesignWorkspaceController,
  mergeSavedDesignDocument,
  prepareFailedSaveRetry,
  restoreFailedMutationBatch,
  shouldApplyLoadedDesignSnapshot,
  shouldRefreshDesignSnapshot,
} from './use-design-workspace'
import type {
  DesignProjectStateUpdate,
  DesignWorkspaceControllerDependencies,
  DesignWorkspaceScheduler,
} from './use-design-workspace'

/** 可由测试精确控制完成时机的 Promise。 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
}

/**
 * 创建 deferred Promise。
 * @returns 暴露 resolve/reject 的 Promise 控制器。
 */
function createDeferred<T>(): Deferred<T> {
  /** Promise 的成功回调，由构造器同步赋值。 */
  let resolve!: (value: T) => void
  /** Promise 的失败回调，由构造器同步赋值。 */
  let reject!: (reason: Error) => void
  /** 测试等待的异步结果。 */
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

/** 手动调度器额外暴露测试观测与执行入口。 */
interface ManualScheduler extends DesignWorkspaceScheduler {
  /** 当前未执行任务的等待时间。 */
  getDelays: () => number[]
  /** 执行最早安排的一项任务。 */
  runNext: () => void
}

/**
 * 创建无需真实等待的保存调度器。
 * @returns 可检查 delay 并手动执行回调的 scheduler。
 */
function createManualScheduler(): ManualScheduler {
  /** 递增的定时器 ID。 */
  let nextTimerId = 1
  /** 尚未执行或取消的定时任务。 */
  const tasks = new Map<number, { callback: () => void; delayMs: number }>()
  return {
    setTimeout: (callback, delayMs) => {
      /** 本次任务的稳定 ID。 */
      const timerId = nextTimerId
      nextTimerId += 1
      tasks.set(timerId, { callback, delayMs })
      return timerId
    },
    clearTimeout: (timerId) => {
      tasks.delete(timerId)
    },
    getDelays: () => [...tasks.values()].map((task) => task.delayMs),
    runNext: () => {
      /** Map 按插入顺序返回的首个任务。 */
      const nextTask = tasks.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined
      if (!nextTask) throw new Error('测试调度器没有待执行任务')
      tasks.delete(nextTask[0])
      nextTask[1].callback()
    },
  }
}

/** Controller 测试所需的状态、请求与清理观测。 */
interface ControllerHarness {
  controller: ReturnType<typeof createDesignWorkspaceController>
  scheduler: ManualScheduler
  loadRequests: Deferred<DesignWorkspaceSnapshot>[]
  saveRequests: Array<{ input: SaveDesignMutationsInput; deferred: Deferred<DesignCanvasDocument> }>
  getState: () => DesignProjectState
  setState: (update: DesignProjectStateUpdate) => void
  emitChange: (change: DesignChangeEvent) => void
  getUnsubscribeCount: () => number
  getReleaseCount: () => number
  setReleaseError: (error: Error) => void
  reportedReleaseErrors: unknown[]
}

/** 多个 controller 可共享的项目状态容器，用于复现卸载与挂载交错。 */
interface SharedControllerState {
  /** 模拟 Jotai 中当前项目的最新状态。 */
  state: DesignProjectState
}

/**
 * 创建带 deferred adapter 和同步内存 store 的 controller 测试环境。
 * @param initialState 初始项目状态。
 * @param sharedState 可选的跨 controller 共享状态容器。
 * @returns 可驱动完整生命周期并读取副作用的测试环境。
 */
function createControllerHarness(
  initialState: DesignProjectState,
  sharedState: SharedControllerState = { state: initialState },
): ControllerHarness {
  /** adapter.load 产生的待完成请求。 */
  const loadRequests: Deferred<DesignWorkspaceSnapshot>[] = []
  /** adapter.save 产生的待完成请求及其入参。 */
  const saveRequests: Array<{ input: SaveDesignMutationsInput; deferred: Deferred<DesignCanvasDocument> }> = []
  /** 当前订阅的远端变化回调。 */
  let changeListener: ((change: DesignChangeEvent) => void) | null = null
  /** 已执行的取消订阅次数。 */
  let unsubscribeCount = 0
  /** 已执行的媒体访问释放次数。 */
  let releaseCount = 0
  /** dispose 时由 adapter.releaseMediaAccess 拒绝的可选错误。 */
  let releaseError: Error | null = null
  /** controller 通过 onReleaseError 上报的错误。 */
  const reportedReleaseErrors: unknown[] = []
  /** 手动保存调度器。 */
  const scheduler = createManualScheduler()
  /** 同步应用局部状态，行为与项目 atom 更新入口一致。 */
  const setState = (update: DesignProjectStateUpdate): void => {
    /** 基于最新状态求得的局部字段。 */
    const partial = typeof update === 'function' ? update(sharedState.state) : update
    sharedState.state = { ...sharedState.state, ...partial }
  }
  /** 仅实现 controller 生命周期需要的 adapter 方法。 */
  const adapter: DesignWorkspaceControllerDependencies['adapter'] = {
    load: () => {
      /** 当前 load 的 deferred 结果。 */
      const deferred = createDeferred<DesignWorkspaceSnapshot>()
      loadRequests.push(deferred)
      return deferred.promise
    },
    save: (input) => {
      /** 当前 save 的 deferred 结果。 */
      const deferred = createDeferred<DesignCanvasDocument>()
      saveRequests.push({ input, deferred })
      return deferred.promise
    },
    onChanged: (listener) => {
      changeListener = listener
      return () => {
        unsubscribeCount += 1
        changeListener = null
      }
    },
    releaseMediaAccess: () => {
      releaseCount += 1
      return releaseError ? Promise.reject(releaseError) : Promise.resolve()
    },
  }
  /** 被测生命周期 controller。 */
  const controller = createDesignWorkspaceController({
    projectId: 'project-1',
    adapter,
    getState: () => sharedState.state,
    updateState: setState,
    scheduler,
    onReleaseError: (error) => reportedReleaseErrors.push(error),
  })
  return {
    controller,
    scheduler,
    loadRequests,
    saveRequests,
    getState: () => sharedState.state,
    setState,
    emitChange: (change) => changeListener?.(change),
    getUnsubscribeCount: () => unsubscribeCount,
    getReleaseCount: () => releaseCount,
    setReleaseError: (error) => {
      releaseError = error
    },
    reportedReleaseErrors,
  }
}

/** 等待连续 Promise 回调完成，不依赖真实计时器。 */
async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Design 工作区同步规则', () => {
  test('Given 无缓存项目 When controller 启动并完成 load Then 进入 ready 且订阅后续 revision', async () => {
    /** 从 idle 开始的项目生命周期环境。 */
    const harness = createControllerHarness(createInitialDesignProjectState())
    harness.controller.start()

    expect(harness.getState().phase).toBe('loading')
    expect(harness.loadRequests).toHaveLength(1)

    /** 首次加载成功返回的可写快照。 */
    const snapshot: DesignWorkspaceSnapshot = {
      document: createEmptyDesignDocument('project-1', 10),
      writable: true,
    }
    harness.loadRequests[0]!.resolve(snapshot)
    await flushPromises()
    expect(harness.getState().phase).toBe('ready')
    expect(harness.getState().snapshot).toBe(snapshot)

    harness.emitChange({ projectId: 'project-1', revision: 1, cause: 'canvas' })
    expect(harness.loadRequests).toHaveLength(2)
  })

  test('Given 多窗口远端 revision 替换本地快照 When load 完成 Then 清空旧 history 和 future', async () => {
    /** 初始稳定快照先完成 controller 启动。 */
    const initialSnapshot: DesignWorkspaceSnapshot = {
      document: { ...createEmptyDesignDocument('project-1', 10), revision: 1 },
      writable: true,
    }
    const harness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: initialSnapshot,
    })
    harness.controller.start()
    harness.loadRequests[0]!.resolve(initialSnapshot)
    await flushPromises()
    /** 模拟用户在远端事件到达前已有可撤销历史。 */
    const historyEntry = {
      forward: [{ type: 'set-viewport' as const, viewport: { x: 1, y: 1, zoom: 1 } }],
      inverse: [{ type: 'set-viewport' as const, viewport: { x: 0, y: 0, zoom: 1 } }],
    }
    harness.setState({ history: [historyEntry], future: [historyEntry] })

    harness.emitChange({ projectId: 'project-1', revision: 2, cause: 'canvas' })
    /** 另一窗口提交后的权威 revision。 */
    const remoteSnapshot: DesignWorkspaceSnapshot = {
      document: { ...createEmptyDesignDocument('project-1', 20), revision: 2 },
      writable: true,
    }
    harness.loadRequests[1]!.resolve(remoteSnapshot)
    await flushPromises()

    expect(harness.getState().snapshot).toBe(remoteSnapshot)
    expect(harness.getState().history).toEqual([])
    expect(harness.getState().future).toEqual([])
  })

  test('Given 已保存历史的项目重新 mount When 加载相同 revision 与相同文档 Then 保留 history 和 future', async () => {
    /** 两次 controller 生命周期共享同一项目 Jotai 状态。 */
    const snapshot: DesignWorkspaceSnapshot = {
      document: { ...createEmptyDesignDocument('project-1', 10), revision: 3 },
      writable: true,
    }
    const historyEntry = {
      forward: [{ type: 'set-viewport' as const, viewport: { x: 1, y: 1, zoom: 1 } }],
      inverse: [{ type: 'set-viewport' as const, viewport: { x: 0, y: 0, zoom: 1 } }],
    }
    const sharedState: SharedControllerState = {
      state: {
        ...createInitialDesignProjectState(),
        phase: 'ready',
        snapshot,
        history: [historyEntry],
        future: [historyEntry],
      },
    }
    /** 旧项目视图卸载后释放 controller。 */
    const oldHarness = createControllerHarness(sharedState.state, sharedState)
    oldHarness.controller.dispose()
    /** 重新进入项目后 adapter 返回内容相同的新对象。 */
    const remountedHarness = createControllerHarness(sharedState.state, sharedState)
    remountedHarness.controller.start()
    remountedHarness.loadRequests[0]!.resolve(structuredClone(snapshot))
    await flushPromises()

    expect(sharedState.state.history).toEqual([historyEntry])
    expect(sharedState.state.future).toEqual([historyEntry])
  })

  test('Given revision 相同但权威文档不同或来自恢复 When load 完成 Then 清空旧历史', async () => {
    /** 旧 revision 上的历史项。 */
    const historyEntry = {
      forward: [{ type: 'set-viewport' as const, viewport: { x: 1, y: 1, zoom: 1 } }],
      inverse: [{ type: 'set-viewport' as const, viewport: { x: 0, y: 0, zoom: 1 } }],
    }
    /** 相同 revision 但内容变化必须按权威替换处理。 */
    const differentHarness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: {
        document: { ...createEmptyDesignDocument('project-1', 10), revision: 3 },
        writable: true,
      },
      history: [historyEntry],
      future: [historyEntry],
    })
    differentHarness.controller.start()
    differentHarness.loadRequests[0]!.resolve({
      document: {
        ...createEmptyDesignDocument('project-1', 10),
        revision: 3,
        viewport: { x: 99, y: 99, zoom: 2 },
      },
      writable: true,
    })
    await flushPromises()
    expect(differentHarness.getState().history).toEqual([])
    expect(differentHarness.getState().future).toEqual([])

    /** recovery 标志即使文档内容相同也表示磁盘基线被恢复替换。 */
    const recoveredDocument = { ...createEmptyDesignDocument('project-1', 20), revision: 4 }
    const recoveredHarness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: { document: recoveredDocument, writable: true },
      history: [historyEntry],
      future: [historyEntry],
    })
    recoveredHarness.controller.start()
    recoveredHarness.loadRequests[0]!.resolve({
      document: structuredClone(recoveredDocument),
      writable: true,
      recoveredFrom: 'backup',
    })
    await flushPromises()
    expect(recoveredHarness.getState().history).toEqual([])
    expect(recoveredHarness.getState().future).toEqual([])
  })

  test('Given revision 冲突时仍有旧历史 When 远端 rebase 完成 Then undo 不再保留旧 inverse', async () => {
    /** 旧 revision 上的 mutation 与历史不能跨 rebase 使用。 */
    const mutation: DesignMutation = {
      type: 'set-viewport',
      viewport: { x: 30, y: 40, zoom: 1.2 },
    }
    const historyEntry = {
      forward: [mutation],
      inverse: [{ type: 'set-viewport' as const, viewport: { x: 0, y: 0, zoom: 1 } }],
    }
    const harness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: {
        document: { ...createEmptyDesignDocument('project-1', 10), revision: 1 },
        writable: true,
      },
      history: [historyEntry],
      future: [historyEntry],
      pendingMutations: [mutation],
      saveState: 'dirty',
    })
    harness.controller.sync()
    harness.scheduler.runNext()
    harness.saveRequests[0]!.deferred.reject(new Error('DESIGN_REVISION_CONFLICT: expected=1, current=2'))
    await flushPromises()
    /** 冲突恢复返回权威 revision 并重放 pending。 */
    harness.loadRequests[0]!.resolve({
      document: { ...createEmptyDesignDocument('project-1', 20), revision: 2 },
      writable: true,
    })
    await flushPromises()

    expect(harness.getState().snapshot?.document.revision).toBe(2)
    expect(harness.getState().history).toEqual([])
    expect(harness.getState().future).toEqual([])
  })

  test('Given 本地分组基于位置 0 且远端已移动到 100 When 结构保存冲突 Then 保留远端位置且不自动重放或重试保存', async () => {
    /** 本地结构 patch 携带冲突前位置，不能覆盖远端已提交的新位置。 */
    const localNode = {
      id: 'node-1',
      kind: 'asset' as const,
      assetId: 'asset-1',
      position: { x: 0, y: 0 },
      width: 100,
      height: 80,
      zIndex: 0,
      groupId: 'group-local',
    }
    /** 分组命令产生的两条结构 mutation。 */
    const structuralMutations: DesignMutation[] = [
      { type: 'patch-nodes', removeIds: ['node-1'], upserts: [{ entity: localNode, index: 0 }] },
      {
        type: 'patch-groups',
        removeIds: ['group-local'],
        upserts: [{ entity: { id: 'group-local', name: '本地组', nodeIds: ['node-1'] }, index: 0 }],
      },
    ]
    /** 保存前的乐观文档已包含本地分组。 */
    const localDocument = {
      ...createEmptyDesignDocument('project-1', 10),
      nodes: [localNode],
      groups: [{ id: 'group-local', name: '本地组', nodeIds: ['node-1'] }],
      revision: 1,
    }
    const harness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: { document: localDocument, writable: true },
      pendingMutations: structuralMutations,
      saveState: 'dirty',
    })
    harness.controller.sync()
    harness.scheduler.runNext()
    harness.saveRequests[0]!.deferred.reject(new Error('DESIGN_REVISION_CONFLICT: expected=1, current=2'))
    await flushPromises()

    /** 远端节点已由另一窗口移动，且没有本地尚未提交的分组。 */
    const remoteDocument = {
      ...createEmptyDesignDocument('project-1', 20),
      nodes: [{ ...localNode, position: { x: 100, y: 100 }, groupId: undefined }],
      groups: [],
      revision: 2,
    }
    harness.loadRequests[0]!.resolve({ document: remoteDocument, writable: true })
    await flushPromises()

    expect(harness.getState().snapshot?.document).toEqual(remoteDocument)
    expect(harness.getState().snapshot?.document.nodes[0]?.position).toEqual({ x: 100, y: 100 })
    expect(harness.getState().snapshot?.document.groups).toEqual([])
    expect(harness.getState().pendingMutations).toEqual(structuralMutations)
    expect(harness.getState().conflictRecoveryPending).toBe(true)
    expect(harness.getState().saveState).toBe('failed')

    harness.controller.retrySave()
    expect(harness.scheduler.getDelays()).toEqual([])
    expect(harness.saveRequests).toHaveLength(1)

    harness.controller.acceptRemoteVersion()
    expect(harness.getState().snapshot?.document).toEqual(remoteDocument)
    expect(harness.getState().pendingMutations).toEqual([])
    expect(harness.getState().history).toEqual([])
    expect(harness.getState().future).toEqual([])
    expect(harness.getState().conflictRecoveryPending).toBe(false)
    expect(harness.getState().saveState).toBe('saved')
    expect(harness.getState().error).toBeNull()

    /** 采用远端后，新移动必须以远端 revision 正常进入保存链路。 */
    const newMove: DesignMutation = {
      type: 'move-nodes',
      positions: [{ nodeId: 'node-1', position: { x: 150, y: 150 } }],
    }
    const movedDocument = applyDesignMutationsToDocument(remoteDocument, [newMove])
    harness.setState({
      snapshot: { document: movedDocument, writable: true },
      pendingMutations: [newMove],
      saveState: 'dirty',
    })
    harness.controller.sync()
    harness.scheduler.runNext()
    expect(harness.saveRequests[1]!.input).toEqual({
      projectId: 'project-1',
      expectedRevision: 2,
      mutations: [newMove],
    })
    harness.saveRequests[1]!.deferred.resolve({ ...movedDocument, revision: 3, updatedAt: 30 })
    await flushPromises()
    expect(harness.getState().snapshot?.document.nodes[0]?.position).toEqual({ x: 150, y: 150 })
    expect(harness.getState().saveState).toBe('saved')
  })

  test('Given 已有 dirty 缓存 When 后台 load 失败 Then 保留画布与 pending 且不进入 error', async () => {
    /** 已乐观编辑且等待保存的缓存快照。 */
    const snapshot: DesignWorkspaceSnapshot = {
      document: createEmptyDesignDocument('project-1', 10),
      writable: true,
    }
    /** 尚未提交的本地 mutation。 */
    const pendingMutations: DesignMutation[] = [{
      type: 'set-viewport',
      viewport: { x: 9, y: 9, zoom: 1 },
    }]
    /** 带缓存和本地修改的 controller 环境。 */
    const harness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot,
      pendingMutations,
      saveState: 'dirty',
    })
    harness.controller.start()
    harness.loadRequests[0]!.reject(new Error('后台读取失败'))
    await flushPromises()

    expect(harness.getState().phase).toBe('ready')
    expect(harness.getState().snapshot).toBe(snapshot)
    expect(harness.getState().pendingMutations).toBe(pendingMutations)
    expect(harness.getState().saveState).toBe('dirty')
  })

  test('Given dirty 缓存使用旧媒体 URL When mount load 成功 Then 只接管新 snapshot 元数据', async () => {
    /** 必须保留 document 与 revision 的本地乐观快照。 */
    const localDocument = {
      ...createEmptyDesignDocument('project-1', 10),
      viewport: { x: 15, y: 16, zoom: 1.2 },
      revision: 5,
    }
    /** 尚未保存且必须保留引用的本地 mutation。 */
    const pendingMutations: DesignMutation[] = [{
      type: 'set-viewport',
      viewport: localDocument.viewport,
    }]
    /** 使用即将被 release 的旧媒体 URL 的缓存状态。 */
    const harness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: {
        document: localDocument,
        writable: true,
        assetBaseUrl: 'proma-file://old/assets/',
        thumbnailBaseUrl: 'proma-file://old/thumbnails/',
      },
      pendingMutations,
      saveState: 'dirty',
    })
    harness.controller.start()

    /** load 返回的 document 更新，但本轮只允许接管媒体与只读元数据。 */
    const loadedSnapshot: DesignWorkspaceSnapshot = {
      document: {
        ...createEmptyDesignDocument('project-1', 20),
        nodes: [{ id: 'node-remote', kind: 'asset', position: { x: 1, y: 2 }, width: 80, height: 60, zIndex: 1 }],
        revision: 9,
      },
      writable: false,
      readOnlyReason: '项目目录当前只读',
      assetBaseUrl: 'proma-file://new/assets/',
      thumbnailBaseUrl: 'proma-file://new/thumbnails/',
      recoveredFrom: 'backup',
    }
    harness.loadRequests[0]!.resolve(loadedSnapshot)
    await flushPromises()

    expect(harness.getState().snapshot?.document).toBe(localDocument)
    expect(harness.getState().snapshot?.document.revision).toBe(5)
    expect(harness.getState().snapshot?.assetBaseUrl).toBe('proma-file://new/assets/')
    expect(harness.getState().snapshot?.thumbnailBaseUrl).toBe('proma-file://new/thumbnails/')
    expect(harness.getState().snapshot?.writable).toBe(false)
    expect(harness.getState().snapshot?.readOnlyReason).toBe('项目目录当前只读')
    expect(harness.getState().snapshot?.recoveredFrom).toBe('backup')
    expect(harness.getState().pendingMutations).toBe(pendingMutations)
    expect(harness.getState().saveState).toBe('dirty')
  })

  test('Given A 等待保存且提交期间新增 B When A 成功 Then 400ms 提交 A 并基于远端结果重放再提交 B', async () => {
    /** 第一批已乐观应用到本地 viewport 的 mutation A。 */
    const mutationA: DesignMutation = {
      type: 'set-viewport',
      viewport: { x: 10, y: 20, zoom: 1.2 },
    }
    /** A 保存期间新产生的节点 mutation B。 */
    const mutationB: DesignMutation = {
      type: 'upsert-nodes',
      nodes: [{ id: 'node-b', kind: 'asset', position: { x: 30, y: 40 }, width: 100, height: 80, zIndex: 2 }],
    }
    /** 保存前已包含 A 乐观结果的快照。 */
    const initialSnapshot: DesignWorkspaceSnapshot = {
      document: { ...createEmptyDesignDocument('project-1', 10), viewport: mutationA.viewport },
      writable: true,
    }
    /** 初始 dirty 状态的 controller 环境。 */
    const harness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: initialSnapshot,
      pendingMutations: [mutationA],
      saveState: 'dirty',
    })
    harness.controller.start()
    harness.controller.sync()

    expect(harness.scheduler.getDelays()).toEqual([400])
    expect(harness.saveRequests).toHaveLength(0)
    harness.scheduler.runNext()
    expect(harness.saveRequests).toHaveLength(1)
    expect(harness.saveRequests[0]!.input).toEqual({
      projectId: 'project-1',
      expectedRevision: 0,
      mutations: [mutationA],
    })
    expect(harness.getState().saveState).toBe('saving')
    expect(harness.getState().pendingMutations).toEqual([])

    /** B 的乐观本地文档，故意不含稍后由服务端返回的 remote 节点。 */
    const optimisticDocument = applyDesignMutationsToDocument(initialSnapshot.document, [mutationB])
    harness.setState({
      snapshot: { ...initialSnapshot, document: optimisticDocument },
      pendingMutations: [mutationB],
    })
    harness.controller.sync()
    expect(harness.scheduler.getDelays()).toEqual([])

    /** A 保存结果包含并发远端 rebase 出的节点。 */
    const savedDocument = {
      ...createEmptyDesignDocument('project-1', 10),
      viewport: mutationA.viewport,
      nodes: [{ id: 'node-remote', kind: 'asset' as const, position: { x: 5, y: 5 }, width: 90, height: 70, zIndex: 1 }],
      revision: 1,
      updatedAt: 30,
    }
    harness.saveRequests[0]!.deferred.resolve(savedDocument)
    await flushPromises()

    expect(harness.getState().snapshot?.document.nodes.map((node) => node.id)).toEqual(['node-remote', 'node-b'])
    expect(harness.getState().saveState).toBe('dirty')
    expect(harness.getState().pendingMutations).toEqual([mutationB])
    expect(harness.scheduler.getDelays()).toEqual([400])

    harness.scheduler.runNext()
    expect(harness.saveRequests[1]!.input).toEqual({
      projectId: 'project-1',
      expectedRevision: 1,
      mutations: [mutationB],
    })
  })

  test('Given 保存失败且 pending 已恢复 When retrySave Then 转为 dirty 并在 400ms 后再次保存', async () => {
    /** 失败后等待用户重试的 mutation。 */
    const mutation: DesignMutation = {
      type: 'set-viewport',
      viewport: { x: 11, y: 12, zoom: 1 },
    }
    /** 保存失败状态的 controller 环境。 */
    const harness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: { document: createEmptyDesignDocument('project-1', 10), writable: true },
      pendingMutations: [mutation],
      saveState: 'failed',
      error: '磁盘暂时不可写',
    })
    harness.controller.retrySave()

    expect(harness.getState().saveState).toBe('dirty')
    expect(harness.getState().error).toBeNull()
    expect(harness.getState().pendingMutations).toEqual([mutation])
    expect(harness.scheduler.getDelays()).toEqual([400])

    harness.scheduler.runNext()
    expect(harness.saveRequests).toHaveLength(1)
    /** 重试成功后的服务端文档。 */
    const savedDocument = {
      ...createEmptyDesignDocument('project-1', 10),
      viewport: mutation.viewport,
      revision: 1,
      updatedAt: 30,
    }
    harness.saveRequests[0]!.deferred.resolve(savedDocument)
    await flushPromises()
    expect(harness.getState().saveState).toBe('saved')
    expect(harness.getState().pendingMutations).toEqual([])
  })

  test('Given 位置 A 保存冲突且期间新增结构 B When reload 最新快照 Then 保留远端基线并阻断整批重试', async () => {
    /** 冲突保存中已发出的 mutation A。 */
    const mutationA: DesignMutation = {
      type: 'set-viewport',
      viewport: { x: 21, y: 22, zoom: 1.1 },
    }
    /** A 保存期间新增的结构 mutation B 使整批不再允许自动 rebase。 */
    const mutationB: DesignMutation = {
      type: 'upsert-nodes',
      nodes: [{ id: 'node-b', kind: 'asset', position: { x: 40, y: 50 }, width: 100, height: 80, zIndex: 2 }],
    }
    /** 基于 revision 1 的本地快照。 */
    const initialSnapshot: DesignWorkspaceSnapshot = {
      document: { ...createEmptyDesignDocument('project-1', 10), revision: 1 },
      writable: true,
      assetBaseUrl: 'proma-file://old/assets/',
    }
    /** 等待保存 A 的 controller 环境。 */
    const harness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: initialSnapshot,
      pendingMutations: [mutationA],
      saveState: 'dirty',
    })
    harness.controller.sync()
    harness.scheduler.runNext()
    harness.setState({ pendingMutations: [mutationB] })
    harness.saveRequests[0]!.deferred.reject(new Error('DESIGN_REVISION_CONFLICT: expected=1, current=2'))
    await flushPromises()

    expect(harness.getState().saveState).toBe('failed')
    expect(harness.getState().pendingMutations).toEqual([mutationA, mutationB])
    expect(harness.getState().error).toContain('冲突')
    expect(harness.loadRequests).toHaveLength(1)

    /** revision 2 的远端结构与新媒体 URL。 */
    const remoteSnapshot: DesignWorkspaceSnapshot = {
      document: {
        ...createEmptyDesignDocument('project-1', 20),
        nodes: [{ id: 'node-remote', kind: 'asset', position: { x: 5, y: 6 }, width: 90, height: 70, zIndex: 1 }],
        revision: 2,
      },
      writable: true,
      assetBaseUrl: 'proma-file://new/assets/',
    }
    harness.loadRequests[0]!.resolve(remoteSnapshot)
    await flushPromises()

    expect(harness.getState().snapshot?.document.revision).toBe(2)
    expect(harness.getState().snapshot?.document.viewport).toEqual(remoteSnapshot.document.viewport)
    expect(harness.getState().snapshot?.document.nodes.map((node) => node.id)).toEqual(['node-remote'])
    expect(harness.getState().snapshot?.assetBaseUrl).toBe('proma-file://new/assets/')
    expect(harness.getState().saveState).toBe('failed')
    expect(harness.getState().conflictRecoveryPending).toBe(true)
    expect(harness.getState().pendingMutations).toEqual([mutationA, mutationB])
    expect(harness.scheduler.getDelays()).toEqual([])

    harness.controller.retrySave()
    expect(harness.scheduler.getDelays()).toEqual([])
    expect(harness.saveRequests).toHaveLength(1)
  })

  test('Given 保存发出后 controller 已 dispose When 冲突返回并重新 mount Then 旧实例不加载且新实例恢复 pending', async () => {
    /** dispose 后仍须恢复并跨 controller 保存的 mutation。 */
    const mutation: DesignMutation = {
      type: 'set-viewport',
      viewport: { x: 31, y: 32, zoom: 1.25 },
    }
    /** 基于旧 revision 1 的项目状态。 */
    const firstHarness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: {
        document: { ...createEmptyDesignDocument('project-1', 10), revision: 1 },
        writable: true,
      },
      pendingMutations: [mutation],
      saveState: 'dirty',
    })
    firstHarness.controller.sync()
    firstHarness.scheduler.runNext()
    firstHarness.controller.dispose()
    firstHarness.saveRequests[0]!.deferred.reject(new Error('DESIGN_REVISION_CONFLICT: expected=1, current=2'))
    await flushPromises()

    expect(firstHarness.getState().conflictRecoveryPending).toBe(true)
    expect(firstHarness.getState().pendingMutations).toEqual([mutation])
    expect(firstHarness.getState().saveState).toBe('failed')
    expect(firstHarness.loadRequests).toHaveLength(0)

    /** 复用同一项目持久状态的新 controller。 */
    const remountedHarness = createControllerHarness(firstHarness.getState())
    remountedHarness.controller.start()
    expect(remountedHarness.loadRequests).toHaveLength(1)
    expect(remountedHarness.scheduler.getDelays()).toEqual([])

    /** 新 controller 获取的 revision 2 远端基线。 */
    const remoteSnapshot: DesignWorkspaceSnapshot = {
      document: {
        ...createEmptyDesignDocument('project-1', 20),
        nodes: [{ id: 'node-remote', kind: 'asset', position: { x: 2, y: 3 }, width: 80, height: 60, zIndex: 1 }],
        revision: 2,
      },
      writable: true,
    }
    remountedHarness.loadRequests[0]!.resolve(remoteSnapshot)
    await flushPromises()

    expect(remountedHarness.getState().conflictRecoveryPending).toBe(false)
    expect(remountedHarness.getState().snapshot?.document.revision).toBe(2)
    expect(remountedHarness.getState().snapshot?.document.viewport).toEqual(mutation.viewport)
    expect(remountedHarness.getState().snapshot?.document.nodes.map((node) => node.id)).toEqual(['node-remote'])
    expect(remountedHarness.getState().saveState).toBe('failed')
  })

  test('Given 新 controller 普通 load 在途 When 旧 controller 写入冲突标记并触发 sync Then 自动冲突重载且旧 load 不覆盖', async () => {
    /** 冲突后需要基于最新服务端 revision 重放的本地修改。 */
    const mutation: DesignMutation = {
      type: 'set-viewport',
      viewport: { x: 51, y: 52, zoom: 1.4 },
    }
    /** 模拟 Jotai 中由新旧 controller 共同读写的项目状态。 */
    const sharedState: SharedControllerState = {
      state: {
        ...createInitialDesignProjectState(),
        phase: 'ready',
        snapshot: {
          document: { ...createEmptyDesignDocument('project-1', 10), revision: 1 },
          writable: true,
        },
        pendingMutations: [mutation],
        saveState: 'dirty',
      },
    }
    /** 已发出保存、随后被卸载的旧 controller。 */
    const oldHarness = createControllerHarness(sharedState.state, sharedState)
    oldHarness.controller.sync()
    oldHarness.scheduler.runNext()

    /** 在冲突标记产生前已启动普通 load 的新 controller。 */
    const newHarness = createControllerHarness(sharedState.state, sharedState)
    newHarness.controller.start()
    expect(newHarness.loadRequests).toHaveLength(1)

    oldHarness.controller.dispose()
    oldHarness.saveRequests[0]!.deferred.reject(new Error('DESIGN_REVISION_CONFLICT: expected=1, current=2'))
    await flushPromises()
    expect(sharedState.state.conflictRecoveryPending).toBe(true)

    newHarness.controller.sync()
    expect(newHarness.loadRequests).toHaveLength(2)
    expect(newHarness.scheduler.getDelays()).toEqual([])

    /** 冲突恢复请求返回 revision 2 并重放本地 mutation。 */
    const recoveredSnapshot: DesignWorkspaceSnapshot = {
      document: { ...createEmptyDesignDocument('project-1', 20), revision: 2 },
      writable: true,
    }
    newHarness.loadRequests[1]!.resolve(recoveredSnapshot)
    await flushPromises()
    expect(sharedState.state.conflictRecoveryPending).toBe(false)
    expect(sharedState.state.snapshot?.document.revision).toBe(2)
    expect(sharedState.state.snapshot?.document.viewport).toEqual(mutation.viewport)

    /** 更早发出的普通 load 即使晚到且 revision 更高，也不得覆盖恢复结果。 */
    const staleGenericSnapshot: DesignWorkspaceSnapshot = {
      document: { ...createEmptyDesignDocument('project-1', 30), revision: 99 },
      writable: true,
    }
    newHarness.loadRequests[0]!.resolve(staleGenericSnapshot)
    await flushPromises()
    expect(sharedState.state.snapshot?.document.revision).toBe(2)
    expect(sharedState.state.snapshot?.document.viewport).toEqual(mutation.viewport)
  })

  test('Given 冲突恢复 load 未完成或失败 When retrySave Then 不保存旧 revision 且只重试恢复 load', async () => {
    /** 等待基于新 revision 重放的冲突 mutation。 */
    const mutation: DesignMutation = {
      type: 'set-viewport',
      viewport: { x: 41, y: 42, zoom: 1.3 },
    }
    /** 从持久 conflictRecoveryPending 状态重新启动的环境。 */
    const harness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: {
        document: { ...createEmptyDesignDocument('project-1', 10), revision: 1 },
        writable: true,
      },
      pendingMutations: [mutation],
      saveState: 'failed',
      conflictRecoveryPending: true,
      error: '保存冲突：等待同步最新版本',
    })
    harness.controller.start()
    expect(harness.loadRequests).toHaveLength(1)

    harness.controller.retrySave()
    expect(harness.loadRequests).toHaveLength(1)
    expect(harness.saveRequests).toHaveLength(0)
    expect(harness.scheduler.getDelays()).toEqual([])
    expect(harness.getState().saveState).toBe('failed')

    harness.loadRequests[0]!.reject(new Error('冲突恢复加载失败'))
    await flushPromises()
    expect(harness.getState().conflictRecoveryPending).toBe(true)

    harness.controller.retrySave()
    expect(harness.loadRequests).toHaveLength(2)
    expect(harness.saveRequests).toHaveLength(0)
    expect(harness.scheduler.getDelays()).toEqual([])
  })

  test('Given load 与保存 timer 均未完成 When dispose Then 释放资源并保留 Jotai pending', async () => {
    /** dispose 前必须原样保留的 pending mutation。 */
    const pendingMutations: DesignMutation[] = [{
      type: 'set-viewport',
      viewport: { x: 13, y: 14, zoom: 1 },
    }]
    /** 同时存在缓存、后台 load 和待保存 timer 的环境。 */
    const harness = createControllerHarness({
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: { document: createEmptyDesignDocument('project-1', 10), writable: true },
      pendingMutations,
      saveState: 'dirty',
    })
    harness.controller.start()
    harness.controller.sync()
    expect(harness.scheduler.getDelays()).toEqual([400])

    harness.controller.dispose()
    expect(harness.getUnsubscribeCount()).toBe(1)
    expect(harness.getReleaseCount()).toBe(1)
    expect(harness.scheduler.getDelays()).toEqual([])
    expect(harness.getState().pendingMutations).toBe(pendingMutations)
    expect(harness.getState().saveState).toBe('dirty')

    /** dispose 后返回的 load 结果不得覆盖已保留的缓存。 */
    const lateSnapshot: DesignWorkspaceSnapshot = {
      document: { ...createEmptyDesignDocument('project-1', 20), revision: 2 },
      writable: true,
    }
    harness.loadRequests[0]!.resolve(lateSnapshot)
    await flushPromises()
    expect(harness.getState().snapshot).not.toBe(lateSnapshot)
    expect(harness.saveRequests).toHaveLength(0)
  })

  test('Given releaseMediaAccess 拒绝 When dispose Then 通过依赖回调上报原始错误', async () => {
    /** 用于验证不被静默吞掉的释放错误。 */
    const releaseError = new Error('媒体授权释放失败')
    /** 无需加载即可验证 dispose 的 controller 环境。 */
    const harness = createControllerHarness(createInitialDesignProjectState())
    harness.setReleaseError(releaseError)

    harness.controller.dispose()
    await flushPromises()

    expect(harness.reportedReleaseErrors).toEqual([releaseError])
  })

  test('Given 首次 load 失败 When retryLoad 成功 Then 从 error 恢复为 ready', async () => {
    /** 无缓存项目的 controller 环境。 */
    const harness = createControllerHarness(createInitialDesignProjectState())
    harness.controller.start()
    harness.loadRequests[0]!.reject(new Error('项目目录不可访问'))
    await flushPromises()
    expect(harness.getState().phase).toBe('error')

    harness.controller.retryLoad()
    expect(harness.getState().phase).toBe('loading')
    expect(harness.loadRequests).toHaveLength(2)

    /** 重试成功返回的快照。 */
    const snapshot: DesignWorkspaceSnapshot = {
      document: createEmptyDesignDocument('project-1', 20),
      writable: true,
    }
    harness.loadRequests[1]!.resolve(snapshot)
    await flushPromises()
    expect(harness.getState().phase).toBe('ready')
    expect(harness.getState().snapshot).toBe(snapshot)
  })

  test('Given 保存重试复用自动提交 When 读取防抖合同 Then 等待 400ms', () => {
    expect(DESIGN_SAVE_DEBOUNCE_MS).toBe(400)
  })

  test('Given 加载返回时本地状态不稳定或结果已过期 When 判断准入 Then 拒绝覆盖当前快照', () => {
    /** 当前 revision 较高的稳定快照，用于识别过期服务端结果。 */
    const currentSnapshot = {
      document: { ...createEmptyDesignDocument('project-1', 10), revision: 3 },
      writable: true,
    }
    /** 本次返回的服务端快照 revision 低于当前本地快照。 */
    const staleSnapshot = {
      document: { ...createEmptyDesignDocument('project-1', 20), revision: 2 },
      writable: true,
    }
    const stableState = {
      ...createInitialDesignProjectState(),
      phase: 'ready' as const,
      snapshot: currentSnapshot,
    }
    const pendingState = {
      ...stableState,
      pendingMutations: [{ type: 'set-viewport' as const, viewport: { x: 1, y: 1, zoom: 1 } }],
      saveState: 'dirty' as const,
    }

    expect(shouldApplyLoadedDesignSnapshot(pendingState, currentSnapshot, 2, 2)).toBe(false)
    expect(shouldApplyLoadedDesignSnapshot({ ...stableState, saveState: 'dirty' }, currentSnapshot, 2, 2)).toBe(false)
    expect(shouldApplyLoadedDesignSnapshot({ ...stableState, saveState: 'saving' }, currentSnapshot, 2, 2)).toBe(false)
    expect(shouldApplyLoadedDesignSnapshot({ ...stableState, saveState: 'failed' }, currentSnapshot, 2, 2)).toBe(false)
    expect(shouldApplyLoadedDesignSnapshot(stableState, staleSnapshot, 2, 2)).toBe(false)
    expect(shouldApplyLoadedDesignSnapshot(stableState, currentSnapshot, 1, 2)).toBe(false)
    expect(shouldApplyLoadedDesignSnapshot(stableState, currentSnapshot, 2, 2)).toBe(true)
  })

  test('Given 服务端已 rebase A 且保存期间新增完整 B When A 返回成功 Then 以服务端为基线重放 B', () => {
    /** 服务端结果包含其他写入合并出的 remote 节点，必须作为权威基线保留。 */
    const savedDocument = {
      ...createEmptyDesignDocument('project-1', 10),
      viewport: { x: 5, y: 6, zoom: 1 },
      nodes: [
        { id: 'node-keep', kind: 'asset' as const, position: { x: 1, y: 1 }, width: 100, height: 80, zIndex: 1 },
        { id: 'node-remove', kind: 'asset' as const, position: { x: 2, y: 2 }, width: 100, height: 80, zIndex: 2 },
        { id: 'node-remote', kind: 'asset' as const, position: { x: 3, y: 3 }, width: 100, height: 80, zIndex: 3 },
      ],
      assets: [
        { id: 'asset-remove', filename: 'remove.png', relativePath: 'assets/remove.png', thumbnailRelativePath: 'thumbnails/remove.png', mediaType: 'image/png' as const, width: 10, height: 10, byteSize: 10, sha256: 'remove', createdAt: 10 },
      ],
      groups: [{ id: 'group-remove', name: '删除组', nodeIds: [] }],
      annotations: [{ id: 'annotation-remove', kind: 'arrow' as const, from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: '#000000', width: 1, createdAt: 10 }],
      revision: 1,
      updatedAt: 30,
    }
    /** 保存期间产生的 B 覆盖全部 mutation 类型，确保 renderer 重放逻辑完整。 */
    const pendingMutations: DesignMutation[] = [
      { type: 'set-viewport', viewport: { x: 20, y: 30, zoom: 1.5 } },
      { type: 'move-nodes', positions: [{ nodeId: 'node-keep', position: { x: 8, y: 9 } }] },
      { type: 'upsert-nodes', nodes: [{ id: 'node-new', kind: 'asset', position: { x: 4, y: 4 }, width: 120, height: 90, zIndex: 4 }] },
      { type: 'remove-nodes', nodeIds: ['node-remove'] },
      { type: 'upsert-assets', assets: [{ id: 'asset-new', filename: 'new.png', relativePath: 'assets/new.png', thumbnailRelativePath: 'thumbnails/new.png', mediaType: 'image/png', width: 20, height: 20, byteSize: 20, sha256: 'new', createdAt: 20 }] },
      { type: 'remove-assets', assetIds: ['asset-remove'] },
      { type: 'upsert-groups', groups: [{ id: 'group-new', name: '新组', nodeIds: [] }] },
      { type: 'remove-groups', groupIds: ['group-remove'] },
      { type: 'upsert-annotations', annotations: [{ id: 'annotation-new', kind: 'mask', points: [{ x: 2, y: 2 }], color: '#ffffff', width: 2, createdAt: 20 }] },
      { type: 'remove-annotations', annotationIds: ['annotation-remove'] },
    ]

    const mergedDocument = mergeSavedDesignDocument(savedDocument, pendingMutations)
    expect(mergedDocument.viewport).toEqual({ x: 20, y: 30, zoom: 1.5 })
    expect(mergedDocument.revision).toBe(1)
    expect(mergedDocument.updatedAt).toBe(30)
    expect(mergedDocument.nodes.map((node) => node.id)).toEqual(['node-keep', 'node-remote', 'node-new'])
    expect(mergedDocument.nodes.find((node) => node.id === 'node-keep')?.position).toEqual({ x: 8, y: 9 })
    expect(mergedDocument.assets.map((asset) => asset.id)).toEqual(['asset-new'])
    expect(mergedDocument.groups.map((group) => group.id)).toEqual(['group-new'])
    expect(mergedDocument.annotations.map((annotation) => annotation.id)).toEqual(['annotation-new'])
  })

  test('Given 保存失败且 mutation 已恢复 When 重试保存 Then 转为 dirty 并等待 400ms 自动提交', () => {
    /** 失败后恢复到队列中的 mutation 必须原样保留。 */
    const pendingMutations: DesignMutation[] = [{
      type: 'set-viewport',
      viewport: { x: 7, y: 8, zoom: 1 },
    }]
    const failedState = {
      ...createInitialDesignProjectState(),
      pendingMutations,
      saveState: 'failed' as const,
      error: '磁盘不可写',
    }

    expect(prepareFailedSaveRetry(failedState)).toEqual({ saveState: 'dirty', error: null })
    expect(failedState.pendingMutations).toBe(pendingMutations)
    expect(prepareFailedSaveRetry({ ...failedState, saveState: 'saving' })).toEqual({})
  })

  test('Given 同项目更高 revision 且无本地待保存 When 收到事件 Then 允许刷新', () => {
    const state = {
      ...createInitialDesignProjectState(),
      phase: 'ready' as const,
      snapshot: { document: { ...createEmptyDesignDocument('project-1', 10), revision: 2 }, writable: true },
    }
    /** 远端同项目的新版本事件。 */
    const change: DesignChangeEvent = { projectId: 'project-1', revision: 3, cause: 'canvas' }

    expect(shouldRefreshDesignSnapshot('project-1', state, change)).toBe(true)
    expect(shouldRefreshDesignSnapshot('project-2', state, change)).toBe(false)
    expect(shouldRefreshDesignSnapshot('project-1', state, { ...change, revision: 2 })).toBe(false)
  })

  test('Given 本地 mutation 尚未保存 When 收到远端事件 Then 不覆盖本地内存文档', () => {
    const state = {
      ...createInitialDesignProjectState(),
      phase: 'ready' as const,
      snapshot: { document: createEmptyDesignDocument('project-1', 10), writable: true },
      pendingMutations: [{ type: 'set-viewport' as const, viewport: { x: 8, y: 4, zoom: 1 } }],
    }
    /** revision 更高但不能覆盖本地待保存状态。 */
    const change: DesignChangeEvent = { projectId: 'project-1', revision: 1, cause: 'canvas' }
    expect(shouldRefreshDesignSnapshot('project-1', state, change)).toBe(false)
  })

  test('Given 本地保存状态未稳定 When 收到远端事件 Then 不触发可能覆盖乐观文档的加载', () => {
    /** 模拟 mutation 已移入保存批次，pending 队列暂时为空的三个不稳定阶段。 */
    const unstableSaveStates = ['dirty', 'saving', 'failed'] as const
    /** 远端 revision 更高，但本地文档仍可能包含尚未确认的乐观编辑。 */
    const change: DesignChangeEvent = { projectId: 'project-1', revision: 2, cause: 'canvas' }

    for (const saveState of unstableSaveStates) {
      const state = {
        ...createInitialDesignProjectState(),
        phase: 'ready' as const,
        snapshot: { document: createEmptyDesignDocument('project-1', 10), writable: true },
        saveState,
      }
      expect(shouldRefreshDesignSnapshot('project-1', state, change)).toBe(false)
    }
  })

  test('Given 保存批次失败且期间产生新编辑 When 恢复队列 Then 失败批次回到队首', () => {
    /** 已发往主进程但失败的旧批次。 */
    const failedBatch: DesignMutation[] = [{
      type: 'set-viewport',
      viewport: { x: 1, y: 2, zoom: 1 },
    }]
    /** 保存期间新产生的编辑。 */
    const newMutations: DesignMutation[] = [{
      type: 'move-nodes',
      positions: [{ nodeId: 'node-1', position: { x: 10, y: 20 } }],
    }]

    expect(restoreFailedMutationBatch(failedBatch, newMutations)).toEqual([
      { type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } },
      { type: 'move-nodes', positions: [{ nodeId: 'node-1', position: { x: 10, y: 20 } }] },
    ])
  })
})
