import { describe, expect, mock, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type {
  CanvasAgentNodeCreationResult,
  CanvasChangeEvent,
  CanvasDocument,
  CanvasMutation,
  CanvasNodeKind,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
  CreateCanvasAgentNodeInput,
  RebuildCanvasAgentNodeResult,
} from '@proma/shared'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { NativeCanvasState } from '@/atoms/native-canvas-atoms'
import {
  createInitialNativeCanvasState,
  createNativeCanvasKey,
  canvasAgentRunningSessionIdsAtom,
  nativeCanvasStatesAtom,
} from '@/atoms/native-canvas-atoms'
import { CanvasPublicOperationError } from '@/lib/design-adapter'
import {
  NATIVE_CANVAS_COMMIT_UNCERTAIN_CODE,
  NATIVE_CANVAS_RECOVERY_REQUIRED_CODE,
  NATIVE_CANVAS_REVISION_CONFLICT_CODE,
  NATIVE_CANVAS_SAVE_DEBOUNCE_MS,
  NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
  NativeCanvasWorkspace,
  createCanvasAgentNodeCommandController,
  createCanvasAgentNodeRebuildController,
  createNativeCanvasAgentNodeSuccessUpdate,
  findNativeCanvasAgentNodeCreationPosition,
  createRebuiltNativeCanvasStateUpdate,
  createNativeCanvasWorkspaceController,
  getNativeCanvasConnectedEdgeCount,
  isPendingCanvasStopDeleteCurrent,
  runNativeCanvasToolbarAddNode,
} from './NativeCanvasWorkspace'
import type {
  CanvasAgentNodeCommandState,
  NativeCanvasScheduler,
  NativeCanvasWorkspaceController,
  NativeCanvasWorkspaceControllerDependencies,
} from './NativeCanvasWorkspace'
import type { CanvasAgentConversationProps } from './CanvasAgentConversation'
import type { NativeCanvasFlowProps } from './NativeCanvasGraph'

describe('原生 Canvas 顶部添加节点路由', () => {
  test('Given 选择 Agent When 路由顶部添加命令 Then 执行既有 Agent 创建', () => {
    const executeAgent = mock(() => undefined)

    runNativeCanvasToolbarAddNode('agent', executeAgent)

    expect(executeAgent).toHaveBeenCalledTimes(1)
  })

  test.each<CanvasNodeKind>(['image', 'document', 'webview'])(
    'Given 选择 %s When 内容创建尚未接线 Then 不误创建 Agent',
    (kind) => {
      const executeAgent = mock(() => undefined)

      runNativeCanvasToolbarAddNode(kind, executeAgent)

      expect(executeAgent).not.toHaveBeenCalled()
    },
  )
})

/** 可从测试精确控制完成时机的 Promise。 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 创建类型完整的可控异步结果。 */
function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined
  let rejectPromise: ((reason: unknown) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (reason) => rejectPromise?.(reason),
  }
}

/** 等待 Promise 微任务回调提交状态。 */
async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** 创建指定双身份与 revision 的测试快照。 */
function createSnapshot(
  revision: number,
  target: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-1' },
): CanvasWorkspaceSnapshot {
  const document = createEmptyCanvasDocument(target.projectId, target.canvasId, revision)
  document.revision = revision
  return { document, writable: true, nodeIssues: [] }
}

/** 手动推进的 trailing debounce 调度器。 */
class ManualScheduler implements NativeCanvasScheduler {
  private nextId = 1
  private tasks = new Map<number, { callback: () => void; delayMs: number }>()

  /** 登记待触发任务并返回稳定 ID。 */
  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId
    this.nextId += 1
    this.tasks.set(id, { callback, delayMs })
    return id
  }

  /** 取消尚未手动触发的任务。 */
  clearTimeout(timerId: number): void {
    this.tasks.delete(timerId)
  }

  /** 返回当前唯一任务的延迟，验证 400ms 合同。 */
  getDelay(): number | undefined {
    return [...this.tasks.values()][0]?.delayMs
  }

  /** 触发当前全部任务；回调可继续登记下一轮。 */
  runAll(): void {
    const tasks = [...this.tasks.values()]
    this.tasks.clear()
    for (const task of tasks) task.callback()
  }
}

/** controller 测试夹具，完整记录 load/save/事件与状态。 */
interface ControllerHarness {
  controller: NativeCanvasWorkspaceController
  scheduler: ManualScheduler
  getState: () => NativeCanvasState
  loads: Deferred<CanvasWorkspaceSnapshot>[]
  saves: Array<{
    expectedRevision: number
    mutations: CanvasMutation[]
    deferred: Deferred<CanvasDocument>
  }>
  emit: (event: CanvasChangeEvent) => void
  unsubscribeCount: () => number
}

/** 创建绑定指定 projectId:canvasId 的纯 controller 测试夹具。 */
function createHarness(
  initial?: Partial<NativeCanvasState>,
  target: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-1' },
): ControllerHarness {
  let state: NativeCanvasState = { ...createInitialNativeCanvasState(), ...initial }
  const scheduler = new ManualScheduler()
  const loads: Deferred<CanvasWorkspaceSnapshot>[] = []
  const saves: ControllerHarness['saves'] = []
  let listener: ((event: CanvasChangeEvent) => void) | undefined
  let releases = 0
  const dependencies: NativeCanvasWorkspaceControllerDependencies = {
    target,
    adapter: {
      loadCanvas: () => {
        const deferred = createDeferred<CanvasWorkspaceSnapshot>()
        loads.push(deferred)
        return deferred.promise
      },
      saveCanvas: (input) => {
        const deferred = createDeferred<CanvasDocument>()
        saves.push({
          expectedRevision: input.expectedRevision,
          mutations: input.mutations,
          deferred,
        })
        return deferred.promise
      },
      onCanvasChanged: (_target, nextListener) => {
        listener = nextListener
        return () => { releases += 1 }
      },
    },
    getState: () => state,
    updateState: (update) => {
      const patch = typeof update === 'function' ? update(state) : update
      state = { ...state, ...patch }
    },
    scheduler,
  }
  return {
    controller: createNativeCanvasWorkspaceController(dependencies),
    scheduler,
    getState: () => state,
    loads,
    saves,
    emit: (event) => listener?.(event),
    unsubscribeCount: () => releases,
  }
}

describe('原生 Canvas controller 加载与事件', () => {
  test('Given LOAD 异常含内部正文 When 加载失败 Then 状态只保留固定公开文案', async () => {
    const harness = createHarness()
    harness.controller.start()
    harness.loads[0]?.reject(new Error(
      'Error invoking remote method /Users/name 11111111-1111-4111-8111-111111111111',
    ))
    await flushPromises()

    expect(harness.getState()).toMatchObject({
      phase: 'error',
      error: '画布暂时无法加载。',
    })
  })

  test('Given 普通 graph 事件 When revision 未前进 Then 忽略；更高时才加载', async () => {
    const harness = createHarness()
    harness.controller.start()
    harness.loads[0]?.resolve(createSnapshot(3))
    await flushPromises()

    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 3, cause: 'graph' })
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 2, cause: 'graph' })
    expect(harness.loads).toHaveLength(1)
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 4, cause: 'graph' })
    expect(harness.loads).toHaveLength(2)
  })

  test('Given recovery 事件 revision 更低 When 到达 Then 无条件阻断并权威加载', async () => {
    const harness = createHarness()
    harness.controller.start()
    harness.loads[0]?.resolve(createSnapshot(8))
    await flushPromises()

    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' })

    expect(harness.loads).toHaveLength(2)
    expect(harness.getState()).toMatchObject({
      authoritativeRecoveryState: 'loading',
      saveState: 'failed',
    })
  })

  test('Given recovery LOAD 在途 When 收到多个更高 graph revision Then 恢复完成后只按最高目标对账一次', async () => {
    const harness = createHarness()
    harness.controller.start()
    harness.loads[0]?.resolve(createSnapshot(8))
    await flushPromises()

    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 4, cause: 'recovery' })
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 10, cause: 'graph' })
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 12, cause: 'graph' })
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 11, cause: 'graph' })

    expect(harness.loads).toHaveLength(2)
    expect(harness.getState().deferredGraphRevision).toBe(12)
    harness.loads[1]?.resolve(createSnapshot(4))
    await flushPromises()

    expect(harness.getState()).toMatchObject({ authoritativeRecoveryState: 'idle' })
    expect(harness.getState().deferredGraphRevision).toBeNull()
    expect(harness.loads).toHaveLength(3)
    harness.loads[2]?.resolve(createSnapshot(12))
    await flushPromises()
    expect(harness.getState().snapshot?.document.revision).toBe(12)
  })

  test('Given 两次 LOAD 乱序 When 旧请求最后返回 Then 旧结果无副作用', async () => {
    const harness = createHarness()
    harness.controller.start()
    harness.controller.retryLoad()
    harness.loads[1]?.resolve(createSnapshot(4))
    await flushPromises()
    harness.loads[0]?.resolve(createSnapshot(9))
    await flushPromises()

    expect(harness.getState().snapshot?.document.revision).toBe(4)
  })
})

describe('原生 Canvas controller 保存', () => {
  test('Given 连续交互 When 400ms 尾触发 Then 重排定时并压缩视口后单批保存', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(2) })
    harness.controller.enqueueMutation({ type: 'set-viewport', viewport: { x: 1, y: 1, zoom: 1 } })
    harness.controller.enqueueMutation({
      type: 'move-nodes', positions: [{ nodeId: 'node-1', position: { x: 2, y: 3 } }],
    })
    harness.controller.enqueueMutation({ type: 'set-viewport', viewport: { x: 8, y: 9, zoom: 2 } })

    expect(harness.scheduler.getDelay()).toBe(NATIVE_CANVAS_SAVE_DEBOUNCE_MS)
    harness.scheduler.runAll()

    expect(harness.saves).toHaveLength(1)
    expect(harness.saves[0]).toMatchObject({ expectedRevision: 2, mutations: [
      { type: 'move-nodes', positions: [{ nodeId: 'node-1', position: { x: 2, y: 3 } }] },
      { type: 'set-viewport', viewport: { x: 8, y: 9, zoom: 2 } },
    ] })
    expect(harness.getState()).toMatchObject({ pendingMutations: [], saveState: 'saving' })
    expect(harness.getState().inFlightMutations).toHaveLength(2)

    harness.saves[0]?.deferred.resolve({ ...createSnapshot(3).document })
    await flushPromises()
    expect(harness.getState()).toMatchObject({ inFlightMutations: [], saveState: 'saved' })
  })

  test('Given SAVE 失败且期间有新 mutation When 回调 Then 原批次在前归还并阻断自动重试', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(2) })
    const first: CanvasMutation = { type: 'set-viewport', viewport: { x: 1, y: 1, zoom: 1 } }
    const later: CanvasMutation = { type: 'set-viewport', viewport: { x: 2, y: 2, zoom: 1 } }
    harness.controller.enqueueMutation(first)
    harness.scheduler.runAll()
    harness.controller.enqueueMutation(later)
    harness.saves[0]?.deferred.reject(new Error('磁盘忙'))
    await flushPromises()

    expect(harness.getState()).toMatchObject({
      pendingMutations: [first, later],
      inFlightMutations: [],
      saveState: 'failed',
      error: '画布暂时无法保存。',
    })
    harness.scheduler.runAll()
    expect(harness.saves).toHaveLength(1)
    harness.controller.retrySave()
    harness.scheduler.runAll()
    expect(harness.saves).toHaveLength(2)
  })

  test('Given SAVE 在途 When dispose Then 同步归还旧 Canvas 且迟到回调无副作用', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(2) })
    harness.controller.start()
    const mutation: CanvasMutation = { type: 'set-viewport', viewport: { x: 3, y: 4, zoom: 1 } }
    harness.controller.enqueueMutation(mutation)
    harness.scheduler.runAll()
    harness.controller.dispose()

    expect(harness.getState()).toMatchObject({
      pendingMutations: [mutation], inFlightMutations: [], saveState: 'dirty',
    })
    expect(harness.unsubscribeCount()).toBe(1)
    harness.saves[0]?.deferred.resolve(createSnapshot(7).document)
    await flushPromises()
    expect(harness.getState().snapshot?.document.revision).toBe(2)
    expect(harness.getState().pendingMutations).toEqual([mutation])
  })

  for (const errorCode of [
    NATIVE_CANVAS_RECOVERY_REQUIRED_CODE,
    NATIVE_CANVAS_COMMIT_UNCERTAIN_CODE,
  ]) {
    test(`Given SAVE 返回 ${errorCode} When 权威 LOAD 完成 Then 归还批次并隔离迟到回调`, async () => {
      const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(6) })
      const mutation: CanvasMutation = { type: 'set-viewport', viewport: { x: 7, y: 8, zoom: 1.4 } }
      harness.controller.enqueueMutation(mutation)
      harness.scheduler.runAll()

      harness.saves[0]?.deferred.reject(new Error(`${errorCode}: reload required`))
      await flushPromises()

      expect(harness.loads).toHaveLength(1)
      expect(harness.getState()).toMatchObject({
        pendingMutations: [mutation], inFlightMutations: [], authoritativeRecoveryState: 'loading',
      })
      harness.loads[0]?.resolve(createSnapshot(2))
      await flushPromises()
      expect(harness.getState().snapshot?.document).toMatchObject({
        revision: 2, viewport: { x: 7, y: 8, zoom: 1.4 },
      })

      harness.saves[0]?.deferred.resolve(createSnapshot(99).document)
      await flushPromises()
      expect(harness.getState().snapshot?.document.revision).toBe(2)
    })
  }

  test('Given Electron 包装 recovery-required 错误 When SAVE 失败 Then 仍按稳定错误码权威加载', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(6) })
    harness.controller.enqueueMutation({ type: 'set-viewport', viewport: { x: 3, y: 4, zoom: 1.1 } })
    harness.scheduler.runAll()

    harness.saves[0]?.deferred.reject(new Error(
      `Error invoking remote method 'DESIGN_CANVAS_SAVE': Error: ${NATIVE_CANVAS_RECOVERY_REQUIRED_CODE}: reload required`,
    ))
    await flushPromises()

    expect(harness.loads).toHaveLength(1)
    expect(harness.getState().authoritativeRecoveryState).toBe('loading')
  })

  test('Given SAVE revision conflict 且仅有位置 mutation When 远端加载 Then 重放到远端并重新保存', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(3) })
    const mutation: CanvasMutation = { type: 'set-viewport', viewport: { x: 12, y: 13, zoom: 1.8 } }
    harness.controller.enqueueMutation(mutation)
    harness.scheduler.runAll()
    harness.saves[0]?.deferred.reject(new Error(`${NATIVE_CANVAS_REVISION_CONFLICT_CODE}: expected=3, current=4`))
    await flushPromises()

    expect(harness.loads).toHaveLength(1)
    harness.loads[0]?.resolve(createSnapshot(4))
    await flushPromises()

    expect(harness.getState()).toMatchObject({
      pendingMutations: [mutation], saveState: 'dirty', authoritativeRecoveryState: 'idle',
    })
    expect(harness.getState().snapshot?.document.viewport).toEqual(mutation.viewport)
    expect(harness.scheduler.getDelay()).toBe(NATIVE_CANVAS_SAVE_DEBOUNCE_MS)
  })

  test('Given SAVE revision conflict 且含结构 mutation When 远端加载 Then 保留权威结构并进入冲突', async () => {
    const structural: CanvasMutation = { type: 'remove-nodes', nodeIds: ['agent-1'] }
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(3) })
    harness.controller.enqueueMutation(structural)
    harness.scheduler.runAll()
    harness.saves[0]?.deferred.reject(new Error(`${NATIVE_CANVAS_REVISION_CONFLICT_CODE}: expected=3, current=4`))
    await flushPromises()

    const remote = createSnapshot(4)
    remote.document.nodes = [{
      id: 'remote-agent', kind: 'agent', title: '远端 Agent',
      agentSessionId: 'remote-session', position: { x: 1, y: 2 },
    }]
    harness.loads[0]?.resolve(remote)
    await flushPromises()

    expect(harness.getState()).toMatchObject({
      pendingMutations: [structural], saveState: 'conflict',
      error: NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
    })
    expect(harness.getState().snapshot?.document.nodes).toEqual(remote.document.nodes)
  })
})

describe('原生 Canvas controller 权威恢复', () => {
  test('Given 普通 LOAD 返回 recoveredFrom 且旧 SAVE 在途 When 应用恢复快照 Then 旧回调无副作用', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(5) })
    harness.controller.start()
    const mutation: CanvasMutation = { type: 'set-viewport', viewport: { x: 4, y: 5, zoom: 1.2 } }
    harness.controller.enqueueMutation(mutation)
    harness.scheduler.runAll()
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 6, cause: 'graph' })

    const recovered = { ...createSnapshot(1), recoveredFrom: 'backup' as const }
    harness.loads[1]?.resolve(recovered)
    await flushPromises()
    expect(harness.getState()).toMatchObject({
      pendingMutations: [mutation], inFlightMutations: [], saveState: 'dirty',
    })
    expect(harness.getState().snapshot?.document).toMatchObject({
      revision: 1, viewport: { x: 4, y: 5, zoom: 1.2 },
    })

    harness.saves[0]?.deferred.resolve(createSnapshot(88).document)
    await flushPromises()
    expect(harness.getState().snapshot?.document.revision).toBe(1)
    expect(harness.getState().pendingMutations).toEqual([mutation])
  })

  test('Given 在途与待保存均为位置类 When recovery 成功 Then 归还、重放并稍后自动保存', async () => {
    const base = createSnapshot(2)
    base.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent', agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const harness = createHarness({ phase: 'ready', snapshot: base })
    harness.controller.start()
    const move: CanvasMutation = {
      type: 'move-nodes', positions: [{ nodeId: 'agent-1', position: { x: 10, y: 20 } }],
    }
    harness.controller.enqueueMutation(move)
    harness.scheduler.runAll()
    const viewport: CanvasMutation = { type: 'set-viewport', viewport: { x: 5, y: 6, zoom: 1.5 } }
    harness.controller.enqueueMutation(viewport)

    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' })
    expect(harness.getState().pendingMutations).toEqual([move, viewport])
    expect(harness.getState().inFlightMutations).toEqual([])
    const recovered = createSnapshot(1)
    recovered.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: '权威 Agent', agentSessionId: 'session-1', position: { x: 1, y: 1 },
    }]
    harness.loads[1]?.resolve(recovered)
    await flushPromises()

    expect(harness.getState().snapshot?.document).toMatchObject({
      revision: 1,
      viewport: { x: 5, y: 6, zoom: 1.5 },
      nodes: [{ id: 'agent-1', title: '权威 Agent', position: { x: 10, y: 20 } }],
    })
    expect(harness.getState()).toMatchObject({
      pendingMutations: [move, viewport], saveState: 'dirty',
      authoritativeRecoveryState: 'idle', selectedNodeId: null, conversationNodeId: null,
    })
    expect(harness.scheduler.getDelay()).toBe(400)

    harness.saves[0]?.deferred.resolve(createSnapshot(99).document)
    await flushPromises()
    expect(harness.getState().snapshot?.document.revision).toBe(1)
    expect(harness.getState().pendingMutations).toEqual([move, viewport])
  })

  test('Given 远端已删除本地待移动节点 When recovery 接管 Then 保留 pending 冲突且采用远端后恢复可编辑', async () => {
    const base = createSnapshot(5)
    base.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: '本地 Agent',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const harness = createHarness({ phase: 'ready', snapshot: base })
    harness.controller.start()
    const move: CanvasMutation = {
      type: 'move-nodes', positions: [{ nodeId: 'agent-1', position: { x: 20, y: 30 } }],
    }
    harness.controller.enqueueMutation(move)
    harness.scheduler.runAll()

    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 6, cause: 'recovery' })
    const remote = createSnapshot(6)
    remote.document.nodes = []
    harness.loads[1]?.resolve(remote)
    await flushPromises()

    expect(harness.getState()).toMatchObject({
      snapshot: remote,
      pendingMutations: [move],
      inFlightMutations: [],
      saveState: 'conflict',
      error: NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
    })
    expect(harness.scheduler.getDelay()).toBeUndefined()
    expect(harness.saves).toHaveLength(1)

    harness.controller.acceptRemoteVersion()
    expect(harness.getState()).toMatchObject({
      snapshot: remote,
      pendingMutations: [],
      inFlightMutations: [],
      saveState: 'saved',
      error: null,
    })
    harness.controller.enqueueMutation({ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1.1 } })
    expect(harness.getState()).toMatchObject({ saveState: 'dirty' })
  })

  test('Given pending 含结构 mutation When recovery 成功 Then 接管权威结构并显式冲突', async () => {
    const structural: CanvasMutation = { type: 'remove-nodes', nodeIds: ['agent-1'] }
    const harness = createHarness({
      phase: 'ready', snapshot: createSnapshot(5), pendingMutations: [structural],
      saveState: 'dirty', selectedNodeId: 'agent-1', conversationNodeId: 'agent-1',
    })
    harness.controller.start()
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' })
    harness.loads[1]?.resolve(createSnapshot(1))
    await flushPromises()

    expect(harness.getState()).toMatchObject({
      pendingMutations: [structural], saveState: 'conflict',
      authoritativeRecoveryState: 'idle', selectedNodeId: null, conversationNodeId: null,
    })
    expect(harness.getState().error).toContain('结构')
    expect(harness.scheduler.getDelay()).toBeUndefined()
    harness.loads[0]?.resolve(createSnapshot(9))
    await flushPromises()
    expect(harness.getState().snapshot?.document.revision).toBe(1)
  })

  test('Given 已进入结构冲突 When 采用远端版本 Then 丢弃旧 mutation 并恢复可编辑状态', () => {
    const structural: CanvasMutation = { type: 'remove-nodes', nodeIds: ['agent-1'] }
    const remote = createSnapshot(7)
    const harness = createHarness({
      phase: 'ready', snapshot: remote, pendingMutations: [structural],
      inFlightMutations: [structural], saveState: 'conflict',
      error: NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
    })

    harness.controller.acceptRemoteVersion()

    expect(harness.getState()).toMatchObject({
      snapshot: remote, pendingMutations: [], inFlightMutations: [],
      saveState: 'saved', error: null,
    })
    expect(harness.scheduler.getDelay()).toBeUndefined()
  })

  test('Given 结构 pending 与 deferred graph When recovery 后对账 Then 始终展示权威结构且保留冲突', async () => {
    const structural: CanvasMutation = { type: 'remove-nodes', nodeIds: ['agent-1'] }
    const initial = createSnapshot(5)
    initial.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: '旧 Agent',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const harness = createHarness({
      phase: 'ready', snapshot: initial,
      pendingMutations: [structural], saveState: 'dirty',
    })
    harness.controller.start()
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' })
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 9, cause: 'graph' })
    const recovered = createSnapshot(1)
    recovered.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: '恢复权威 Agent',
      agentSessionId: 'session-1', position: { x: 10, y: 20 },
    }]
    harness.loads[1]?.resolve(recovered)
    await flushPromises()

    const reconciled = createSnapshot(9)
    reconciled.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: '最新权威 Agent',
      agentSessionId: 'session-1', position: { x: 30, y: 40 },
    }]
    harness.loads[2]?.resolve(reconciled)
    await flushPromises()

    expect(harness.getState().snapshot?.document.nodes).toEqual(reconciled.document.nodes)
    expect(harness.getState()).toMatchObject({
      pendingMutations: [structural],
      saveState: 'conflict',
      error: NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
    })
    expect(harness.saves).toHaveLength(0)
    expect(harness.scheduler.getDelay()).toBeUndefined()
  })

  test('Given recovery LOAD 失败 When 显式重试 Then 保持阻断直到新权威快照成功', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(5) })
    harness.controller.start()
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' })
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 7, cause: 'graph' })
    harness.loads[1]?.reject(new Error('恢复文件损坏'))
    await flushPromises()
    expect(harness.getState()).toMatchObject({
      authoritativeRecoveryState: 'failed', deferredGraphRevision: 7, saveState: 'failed',
    })

    harness.controller.retryRecovery()
    expect(harness.loads).toHaveLength(3)
    harness.loads[2]?.resolve(createSnapshot(1))
    await flushPromises()
    expect(harness.loads).toHaveLength(4)
    expect(harness.getState()).toMatchObject({
      authoritativeRecoveryState: 'idle', deferredGraphRevision: null, saveState: 'saved',
    })
    harness.loads[3]?.resolve(createSnapshot(7))
    await flushPromises()
    expect(harness.getState().snapshot?.document.revision).toBe(7)
  })

  test('Given A recovery 在途 When 切换 B 再返回 A Then A 继续权威恢复且 B 不继承队列', async () => {
    const targetA: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-a' }
    const targetB: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-b' }
    const snapshotA = createSnapshot(5, targetA)
    snapshotA.document.nodes = [{
      id: 'agent-a', kind: 'agent', title: 'Agent A',
      agentSessionId: 'session-a', position: { x: 0, y: 0 },
    }]
    const firstA = createHarness({ phase: 'ready', snapshot: snapshotA }, targetA)
    const moveA: CanvasMutation = {
      type: 'move-nodes', positions: [{ nodeId: 'agent-a', position: { x: 20, y: 30 } }],
    }
    firstA.controller.start()
    firstA.controller.enqueueMutation(moveA)
    firstA.scheduler.runAll()
    firstA.emit({ projectId: targetA.projectId, canvasId: targetA.canvasId, revision: 1, cause: 'recovery' })
    firstA.emit({ projectId: targetA.projectId, canvasId: targetA.canvasId, revision: 9, cause: 'graph' })
    firstA.controller.dispose()

    const persistedA = firstA.getState()
    expect(persistedA).toMatchObject({
      pendingMutations: [moveA], inFlightMutations: [], authoritativeRecoveryState: 'loading',
      deferredGraphRevision: 9,
    })

    const canvasB = createHarness(undefined, targetB)
    canvasB.controller.start()
    expect(canvasB.getState()).toMatchObject({
      pendingMutations: [], inFlightMutations: [], authoritativeRecoveryState: 'idle',
    })
    canvasB.loads[0]?.resolve(createSnapshot(2, targetB))
    await flushPromises()

    const secondA = createHarness(persistedA, targetA)
    secondA.controller.start()
    expect(secondA.loads).toHaveLength(1)
    const recoveredA = createSnapshot(1, targetA)
    recoveredA.document.nodes = [{
      id: 'agent-a', kind: 'agent', title: '恢复 Agent A',
      agentSessionId: 'session-a', position: { x: 1, y: 1 },
    }]
    secondA.loads[0]?.resolve(recoveredA)
    await flushPromises()

    expect(secondA.loads).toHaveLength(2)
    const reconciledA = createSnapshot(9, targetA)
    reconciledA.document.nodes = [{
      id: 'agent-a', kind: 'agent', title: '最新 Agent A',
      agentSessionId: 'session-a', position: { x: 2, y: 2 },
    }]
    secondA.loads[1]?.resolve(reconciledA)
    await flushPromises()

    expect(secondA.getState()).toMatchObject({
      phase: 'ready', pendingMutations: [moveA], authoritativeRecoveryState: 'idle',
      deferredGraphRevision: null, saveState: 'dirty',
    })
    expect(canvasB.getState().pendingMutations).toEqual([])
  })
})

describe('原生 Canvas 冲突提示', () => {
  test('Given 结构冲突 When 渲染工作区 Then 明确提示并提供采用远端版本动作', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const store = createStore()
    store.set(nativeCanvasStatesAtom, new Map([[
      createNativeCanvasKey(target.projectId, target.canvasId),
      {
        ...createInitialNativeCanvasState(),
        phase: 'ready',
        snapshot: createSnapshot(7),
        pendingMutations: [{ type: 'remove-nodes', nodeIds: ['agent-1'] }],
        saveState: 'conflict',
        error: NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
      },
    ]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          target={target}
          title="冲突 Canvas"
          adapter={{
            loadCanvas: async () => createSnapshot(7),
            saveCanvas: async () => createSnapshot(8).document,
            onCanvasChanged: () => () => {},
          }}
          flowRenderer={() => <div />}
        />
      </Provider>,
    )

    expect(html).toContain(NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE)
    expect(html).toContain('采用远端版本')
  })
})

describe('原生 Canvas 添加 Agent 命令', () => {
  test('Given 空图和真实 surface When 独立新增 Then 只用 surface 中心换算世界坐标', () => {
    const document = createSnapshot(1).document
    document.viewport = { x: -100, y: 50, zoom: 2 }

    expect(findNativeCanvasAgentNodeCreationPosition(document, { width: 800, height: 600 }))
      .toEqual({ x: 106, y: 53 })
  })

  test('Given 非空图和不同 viewport When 独立新增 Then 全局落点完全不受平移缩放影响', () => {
    const first = createSnapshot(1).document
    first.nodes = [
      { id: 'first', kind: 'agent', title: '首节点', agentSessionId: 's-1', position: { x: -200, y: 40 } },
      { id: 'right', kind: 'agent', title: '右节点', agentSessionId: 's-2', position: { x: 500, y: 300 } },
    ]
    const second = structuredClone(first)
    first.viewport = { x: 0, y: 0, zoom: 1 }
    second.viewport = { x: 8_000, y: -6_000, zoom: 2.5 }

    expect(findNativeCanvasAgentNodeCreationPosition(first, { width: 300, height: 200 }))
      .toEqual(findNativeCanvasAgentNodeCreationPosition(second, { width: 1_400, height: 900 }))
  })

  test('Given 创建前已有 viewport mutation 与对话状态 When 创建成功 Then 只接管权威文档和选中新节点', () => {
    const current = createInitialNativeCanvasState()
    const viewportMutation: CanvasMutation = {
      type: 'set-viewport', viewport: { x: 12, y: 34, zoom: 1.5 },
    }
    current.phase = 'ready'
    current.snapshot = createSnapshot(2)
    current.snapshot.document.viewport = { x: 12, y: 34, zoom: 1.5 }
    current.pendingMutations = [viewportMutation]
    current.conversationNodeId = 'agent-existing'
    const createdDocument = createSnapshot(3).document
    createdDocument.viewport = { ...current.snapshot.document.viewport }
    const result: CanvasAgentNodeCreationResult = {
      document: createdDocument,
      session: { id: 'session-new' } as never,
    }

    const update = createNativeCanvasAgentNodeSuccessUpdate(current, 'node-new', result)

    expect({ ...current, ...update }).toMatchObject({
      snapshot: { document: result.document },
      selectedNodeId: 'node-new',
      conversationNodeId: 'agent-existing',
      pendingMutations: [viewportMutation],
    })
    expect(update.snapshot?.document.viewport).toEqual({ x: 12, y: 34, zoom: 1.5 })
    expect(update).not.toHaveProperty('conversationNodeId')
    expect(update).not.toHaveProperty('pendingMutations')
  })

  test('Given 创建期间发生缩放平移与节点拖动 When 旧 viewport 的创建结果返回 Then 按原顺序重放安全位置投影', () => {
    const current = createInitialNativeCanvasState()
    current.phase = 'ready'
    current.snapshot = createSnapshot(2)
    current.snapshot.document.nodes = [{
      id: 'agent-existing', kind: 'agent', title: '已有节点',
      agentSessionId: 'session-existing', position: { x: 360, y: 240 },
    }]
    const inFlightViewport: CanvasMutation = {
      type: 'set-viewport', viewport: { x: 20, y: 30, zoom: 1.2 },
    }
    const inFlightMove: CanvasMutation = {
      type: 'move-nodes', positions: [{ nodeId: 'agent-existing', position: { x: 120, y: 80 } }],
    }
    const structural: CanvasMutation = { type: 'remove-nodes', nodeIds: ['agent-other'] }
    const pendingViewport: CanvasMutation = {
      type: 'set-viewport', viewport: { x: 80, y: 90, zoom: 1.8 },
    }
    const pendingMove: CanvasMutation = {
      type: 'move-nodes', positions: [{ nodeId: 'agent-existing', position: { x: 360, y: 240 } }],
    }
    current.inFlightMutations = [inFlightViewport, inFlightMove]
    current.pendingMutations = [structural, pendingViewport, pendingMove]
    const createdDocument = createSnapshot(3).document
    createdDocument.nodes = [
      {
        id: 'agent-existing', kind: 'agent', title: '已有节点',
        agentSessionId: 'session-existing', position: { x: 0, y: 0 },
      },
      {
        id: 'node-new', kind: 'agent', title: '新 Agent',
        agentSessionId: 'session-new', position: { x: 312, y: 0 },
      },
      {
        id: 'agent-other', kind: 'agent', title: '其他节点',
        agentSessionId: 'session-other', position: { x: 624, y: 0 },
      },
    ]
    createdDocument.viewport = { x: 0, y: 0, zoom: 1 }
    const result: CanvasAgentNodeCreationResult = {
      document: createdDocument,
      session: { id: 'session-new' } as never,
    }

    const update = createNativeCanvasAgentNodeSuccessUpdate(current, 'node-new', result)
    const updated = { ...current, ...update }

    expect(updated.snapshot?.document.viewport).toEqual({ x: 80, y: 90, zoom: 1.8 })
    expect(updated.snapshot?.document.nodes.find((node) => node.id === 'agent-existing')?.position)
      .toEqual({ x: 360, y: 240 })
    expect(updated.snapshot?.document.nodes.map((node) => node.id))
      .toEqual(['agent-existing', 'node-new', 'agent-other'])
    expect(updated.inFlightMutations).toEqual([inFlightViewport, inFlightMove])
    expect(updated.pendingMutations).toEqual([structural, pendingViewport, pendingMove])
    expect(updated.conversationNodeId).toBeNull()
  })

  test('Given 当前 revision 更高且已含新节点 When 迟到创建结果返回 Then 保留当前文档并只选中新节点', () => {
    const current = createInitialNativeCanvasState()
    current.phase = 'ready'
    current.snapshot = createSnapshot(8)
    current.snapshot.document.viewport = { x: 90, y: 80, zoom: 1.6 }
    current.snapshot.document.nodes = [{
      id: 'node-new', kind: 'agent', title: '新 Agent',
      agentSessionId: 'session-new', position: { x: 400, y: 200 },
    }]
    current.selectedNodeId = 'agent-existing'
    current.conversationNodeId = 'agent-existing'
    const pendingViewport: CanvasMutation = {
      type: 'set-viewport', viewport: { x: 90, y: 80, zoom: 1.6 },
    }
    current.pendingMutations = [pendingViewport]
    const currentDocument = current.snapshot.document
    const staleDocument = createSnapshot(7).document
    staleDocument.viewport = { x: 0, y: 0, zoom: 1 }
    const result: CanvasAgentNodeCreationResult = {
      document: staleDocument,
      session: { id: 'session-new' } as never,
    }

    const update = createNativeCanvasAgentNodeSuccessUpdate(current, 'node-new', result)
    const updated = { ...current, ...update }

    expect(update).not.toHaveProperty('snapshot')
    expect(updated.snapshot?.document).toBe(currentDocument)
    expect(updated.snapshot?.document.viewport).toEqual({ x: 90, y: 80, zoom: 1.6 })
    expect(updated.selectedNodeId).toBe('node-new')
    expect(updated.conversationNodeId).toBe('agent-existing')
    expect(updated.pendingMutations).toEqual([pendingViewport])
  })

  test('Given 当前 revision 更高且不含新节点 When 迟到创建结果返回 Then 保留当前文档与原选区', () => {
    const current = createInitialNativeCanvasState()
    current.phase = 'ready'
    current.snapshot = createSnapshot(9)
    current.snapshot.document.nodes = [{
      id: 'agent-existing', kind: 'agent', title: '已有节点',
      agentSessionId: 'session-existing', position: { x: 40, y: 60 },
    }]
    current.selectedNodeId = 'agent-existing'
    const currentDocument = current.snapshot.document
    const result: CanvasAgentNodeCreationResult = {
      document: createSnapshot(8).document,
      session: { id: 'session-new' } as never,
    }

    const update = createNativeCanvasAgentNodeSuccessUpdate(current, 'node-new', result)
    const updated = { ...current, ...update }

    expect(update).not.toHaveProperty('snapshot')
    expect(updated.snapshot?.document).toBe(currentDocument)
    expect(updated.selectedNodeId).toBe('agent-existing')
  })

  test('Given 当前与创建结果 revision 相等 When 创建成功 Then 正常接管结果并重放位置 mutation', () => {
    const current = createInitialNativeCanvasState()
    current.phase = 'ready'
    current.snapshot = createSnapshot(5)
    const pendingViewport: CanvasMutation = {
      type: 'set-viewport', viewport: { x: 70, y: 50, zoom: 1.4 },
    }
    current.pendingMutations = [pendingViewport]
    const equalRevisionDocument = createSnapshot(5).document
    equalRevisionDocument.nodes = [{
      id: 'node-new', kind: 'agent', title: '新 Agent',
      agentSessionId: 'session-new', position: { x: 312, y: 0 },
    }]
    const result: CanvasAgentNodeCreationResult = {
      document: equalRevisionDocument,
      session: { id: 'session-new' } as never,
    }

    const update = createNativeCanvasAgentNodeSuccessUpdate(current, 'node-new', result)

    expect(update.snapshot?.document.revision).toBe(5)
    expect(update.snapshot?.document.nodes.map((node) => node.id)).toEqual(['node-new'])
    expect(update.snapshot?.document.viewport).toEqual({ x: 70, y: 50, zoom: 1.4 })
    expect(update.selectedNodeId).toBe('node-new')
  })

  test('Given CREATE 异常含内部正文 When 创建失败 Then 按钮状态只保留固定公开文案', async () => {
    const states: CanvasAgentNodeCommandState[] = []
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      createAgentNode: async () => {
        throw new Error(
          'Error invoking remote method /Users/name 11111111-1111-4111-8111-111111111111',
        )
      },
      createId: (() => {
        const ids = ['operation-1', 'node-1']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 0, y: 0 }),
      onStateChange: (state) => states.push(state),
      onSuccess: () => undefined,
    })

    await expect(controller.execute()).rejects.toThrow('Error invoking remote method')
    expect(states.at(-1)).toEqual({
      loading: false,
      error: '节点创建失败，请重试。',
    })
  })

  test('Given 健康源节点 When 扩展 Agent Then 预分配稳定边并使用源节点落点', async () => {
    const inputs: CreateCanvasAgentNodeInput[] = []
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      createAgentNode: async (input) => {
        inputs.push(input)
        return { document: createSnapshot(2).document, session: { id: 'session-2' } as never }
      },
      createId: (() => {
        const ids = ['operation-1', 'node-2', 'edge-1']
        return () => ids.shift()!
      })(),
      getPosition: (sourceNodeId) => sourceNodeId === 'agent-1'
        ? { x: 412, y: 268 }
        : { x: 0, y: 0 },
      onStateChange: () => undefined,
      onSuccess: () => undefined,
    })

    await controller.execute({ sourceNodeId: 'agent-1' })

    expect(inputs).toEqual([{
      projectId: 'project-1',
      canvasId: 'canvas-1',
      operationId: 'operation-1',
      nodeId: 'node-2',
      title: '新 Agent',
      position: { x: 412, y: 268 },
      relationship: { sourceNodeId: 'agent-1', edgeId: 'edge-1' },
    }])
  })

  test('Given 独立添加 When 创建 Agent Then 不生成 relationship', async () => {
    let input: CreateCanvasAgentNodeInput | undefined
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      createAgentNode: async (current) => {
        input = current
        return { document: createSnapshot(2).document, session: { id: 'session-2' } as never }
      },
      createId: (() => {
        const ids = ['operation-1', 'node-2']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 20, y: 40 }),
      onStateChange: () => undefined,
      onSuccess: () => undefined,
    })

    await controller.execute()

    expect(input?.position).toEqual({ x: 20, y: 40 })
    expect(input).not.toHaveProperty('relationship')
  })

  test('Given 节点有输入输出边 When 计算删除影响 Then 只统计一次每条关联边', () => {
    const document = createSnapshot(1).document
    document.nodes = [
      { id: 'agent-1', kind: 'agent', title: 'Agent 1', agentSessionId: 'session-1', position: { x: 0, y: 0 } },
      { id: 'agent-2', kind: 'agent', title: 'Agent 2', agentSessionId: 'session-2', position: { x: 320, y: 0 } },
    ]
    document.edges = [
      { id: 'edge-in', sourceNodeId: 'agent-2', sourcePort: 'output', targetNodeId: 'agent-1', targetPort: 'input' },
      { id: 'edge-out', sourceNodeId: 'agent-1', sourcePort: 'output', targetNodeId: 'agent-2', targetPort: 'input' },
    ]

    expect(getNativeCanvasConnectedEdgeCount(document, 'agent-1')).toBe(2)
  })

  test('Given 停止后删除请求 When Canvas 或 session 已切换 Then 旧请求不得提交删除', () => {
    const pending = {
      canvasKey: 'project-1:canvas-a',
      nodeId: 'agent-1',
      sessionId: 'session-old',
      stopAccepted: true,
    }
    const currentNode = {
      id: 'agent-1', kind: 'agent' as const, title: 'Agent 1',
      agentSessionId: 'session-old', position: { x: 0, y: 0 },
    }

    expect(isPendingCanvasStopDeleteCurrent(pending, 'project-1:canvas-a', currentNode)).toBe(true)
    expect(isPendingCanvasStopDeleteCurrent(pending, 'project-1:canvas-b', currentNode)).toBe(false)
    expect(isPendingCanvasStopDeleteCurrent(
      pending,
      'project-1:canvas-a',
      { ...currentNode, agentSessionId: 'session-new' },
    )).toBe(false)
  })

  test('Given 坏节点重建首次失败 When 显式重试 Then 复用完整 operation 并整体接管快照', async () => {
    const requests: Array<{ operationId: string; nodeId: string }> = []
    const states: CanvasAgentNodeCommandState[] = []
    const rebuiltSnapshot = createSnapshot(8)
    rebuiltSnapshot.nodeIssues = []
    const result: RebuildCanvasAgentNodeResult = {
      snapshot: rebuiltSnapshot,
      session: { id: 'session-new' } as never,
    }
    let attempts = 0
    let success: RebuildCanvasAgentNodeResult | undefined
    const controller = createCanvasAgentNodeRebuildController({
      target: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-1' },
      rebuildAgentNode: async (input) => {
        requests.push(input)
        attempts += 1
        if (attempts === 1) {
          throw new CanvasPublicOperationError(
            'AGENT_SESSION_REBUILD_FAILED',
            '重建失败，请重试。',
          )
        }
        return result
      },
      createId: () => 'operation-rebuild-1',
      onStateChange: (state) => states.push(state),
      onSuccess: (current) => { success = current },
    })

    await expect(controller.execute()).rejects.toThrow('重建失败，请重试。')
    await expect(controller.execute()).resolves.toBeUndefined()

    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(states).toContainEqual({ loading: false, error: '重建失败，请重试。' })
    expect(success).toBe(result)
    expect(createRebuiltNativeCanvasStateUpdate(result, 'agent-1')).toEqual({
      snapshot: rebuiltSnapshot,
      selectedNodeId: 'agent-1',
      conversationNodeId: 'agent-1',
      error: null,
    })
  })

  test('Given 坏 Agent 节点 When 渲染 Workspace Then 绕过对话并显示恢复面板', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const snapshot = createSnapshot(7, target)
    snapshot.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: '首页设计',
      agentSessionId: 'session-broken', position: { x: 0, y: 0 },
    }]
    snapshot.nodeIssues = [{
      nodeId: 'agent-1',
      code: 'AGENT_SESSION_UNAVAILABLE',
      allowedActions: ['rebuild-agent-session', 'remove-node'],
    }]
    const stateKey = createNativeCanvasKey(target.projectId, target.canvasId)
    const store = createStore()
    store.set(nativeCanvasStatesAtom, new Map([[stateKey, {
      ...createInitialNativeCanvasState(),
      phase: 'ready',
      snapshot,
      selectedNodeId: 'agent-1',
      conversationNodeId: 'agent-1',
    }]]))
    let conversationRenderCount = 0
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          target={target}
          title="首页 Canvas"
          adapter={{
            loadCanvas: async () => snapshot,
            saveCanvas: async () => snapshot.document,
            onCanvasChanged: () => () => {},
            getCanvasAgentMessages: async () => {
              throw new Error('坏节点禁止读取消息')
            },
            sendCanvasAgentMessage: async () => ({ ok: true }),
            stopCanvasAgent: async () => undefined,
          }}
          flowRenderer={() => <div />}
          conversationRenderer={() => {
            conversationRenderCount += 1
            return <div>不应渲染</div>
          }}
        />
      </Provider>,
    )

    expect(html).toContain('此节点关联的 Agent 会话不可用。')
    expect(html).toContain('重建会话')
    expect(conversationRenderCount).toBe(0)
  })

  test('Given Canvas 有工具状态、问题和运行节点 When 渲染 Graph Then 传入真实投影参数', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const snapshot = createSnapshot(3, target)
    snapshot.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent 1',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    snapshot.nodeIssues = [{
      nodeId: 'agent-1', code: 'AGENT_SESSION_UNAVAILABLE',
      allowedActions: ['rebuild-agent-session', 'remove-node'],
    }]
    const store = createStore()
    store.set(nativeCanvasStatesAtom, new Map([[
      createNativeCanvasKey(target.projectId, target.canvasId),
      { ...createInitialNativeCanvasState(), phase: 'ready', snapshot, activeTool: 'pan' },
    ]]))
    store.set(canvasAgentRunningSessionIdsAtom, new Set(['session-1']))
    let flowProps: NativeCanvasFlowProps | undefined

    renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          target={target}
          title="Canvas 1"
          adapter={{
            loadCanvas: async () => snapshot,
            saveCanvas: async () => snapshot.document,
            createCanvasAgentNode: async () => ({
              document: snapshot.document,
              session: { id: 'session-new' } as never,
            }),
            onCanvasChanged: () => () => {},
          }}
          flowRenderer={(props) => {
            flowProps = props
            return <div />
          }}
        />
      </Provider>,
    )

    expect(flowProps?.nodes[0]).toMatchObject({
      data: { status: 'unavailable', canExpand: false },
    })
    expect(flowProps?.nodesDraggable).toBe(false)
    expect(flowProps?.panOnDrag).toBe(true)
  })

  test('Given Agent 节点仍被选中 When 关闭对话 Then 同时清空选区避免立即重开', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const snapshot = createSnapshot(7, target)
    snapshot.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent 1',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const store = createStore()
    const stateKey = createNativeCanvasKey(target.projectId, target.canvasId)
    store.set(nativeCanvasStatesAtom, new Map([[stateKey, {
      ...createInitialNativeCanvasState(),
      phase: 'ready',
      snapshot,
      selectedNodeId: 'agent-1',
      conversationNodeId: 'agent-1',
    }]]))
    let conversationProps: CanvasAgentConversationProps | undefined
    let flowProps: NativeCanvasFlowProps | undefined
    renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          target={target}
          title="Canvas 1"
          adapter={{
            loadCanvas: async () => snapshot,
            saveCanvas: async () => snapshot.document,
            onCanvasChanged: () => () => {},
            getCanvasAgentMessages: async () => ({
              sessionId: 'session-1',
              owner: { ...target, nodeId: 'agent-1', title: 'Agent 1' },
              messages: [],
            }),
            sendCanvasAgentMessage: async () => ({ ok: true }),
            stopCanvasAgent: async () => undefined,
          }}
          flowRenderer={(props) => {
            flowProps = props
            return <div />
          }}
          conversationRenderer={(props) => {
            conversationProps = props
            return <div data-testid="canvas-agent-conversation" />
          }}
        />
      </Provider>,
    )

    expect(conversationProps?.target).toEqual({ ...target, nodeId: 'agent-1' })
    expect(conversationProps?.onClose).toBeFunction()
    conversationProps?.onClose()
    expect(store.get(nativeCanvasStatesAtom).get(stateKey)).toMatchObject({
      selectedNodeId: null,
      conversationNodeId: null,
    })

    /** close 后不再订阅 XYFlow 派生 selection，避免受控选区反写形成反馈循环。 */
    expect(flowProps?.onSelectionChange).toBeUndefined()
    expect(store.get(nativeCanvasStatesAtom).get(stateKey)).toMatchObject({
      selectedNodeId: null,
      conversationNodeId: null,
    })
  })

  test('Given Agent 对话面板已打开 When 渲染 Canvas Then 画布表面为右侧面板预留空间', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const snapshot = createSnapshot(7, target)
    snapshot.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent 1',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const store = createStore()
    const stateKey = createNativeCanvasKey(target.projectId, target.canvasId)
    store.set(nativeCanvasStatesAtom, new Map([[stateKey, {
      ...createInitialNativeCanvasState(),
      phase: 'ready',
      snapshot,
      selectedNodeId: 'agent-1',
      conversationNodeId: 'agent-1',
    }]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          target={target}
          title="Canvas 1"
          adapter={{
            loadCanvas: async () => snapshot,
            saveCanvas: async () => snapshot.document,
            onCanvasChanged: () => () => {},
            getCanvasAgentMessages: async () => ({
              sessionId: 'session-1',
              owner: { ...target, nodeId: 'agent-1', title: 'Agent 1' },
              messages: [],
            }),
            sendCanvasAgentMessage: async () => ({ ok: true }),
            stopCanvasAgent: async () => undefined,
          }}
          flowRenderer={() => <div />}
          conversationRenderer={() => <div data-testid="canvas-agent-conversation" />}
        />
      </Provider>,
    )

    expect(html).toMatch(/data-native-canvas-surface="true"[^>]*class="[^"]*mr-\[min\(28rem,100%\)\]/u)
    expect(html).toMatch(/data-native-canvas-surface="true"[^>]*class="[^"]*relative/u)
  })

  test('Given Canvas A 创建中切换到 B When A 延迟成功 Then 不更新 B 的状态或节点', async () => {
    const deferred = createDeferred<CanvasAgentNodeCreationResult>()
    const states: CanvasAgentNodeCommandState[] = []
    const successes: string[] = []
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-a' },
      createAgentNode: () => deferred.promise,
      createId: (() => {
        const ids = ['11111111-1111-4111-8111-111111111111', 'node-a']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 0, y: 0 }),
      onStateChange: (state) => states.push(state),
      onSuccess: (nodeId) => successes.push(nodeId),
    })

    const request = controller.execute()
    controller.cancel()
    deferred.resolve({
      document: createSnapshot(1).document,
      session: { id: 'session-a' } as never,
    })
    await request

    expect(states).toEqual([
      { loading: true, error: null },
      { loading: false, error: null },
    ])
    expect(successes).toEqual([])
  })

  test('Given Canvas A 创建中切换到 B When A 延迟失败 Then B 保持非 loading 且无旧错误', async () => {
    const deferred = createDeferred<CanvasAgentNodeCreationResult>()
    const states: CanvasAgentNodeCommandState[] = []
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-a' },
      createAgentNode: () => deferred.promise,
      createId: (() => {
        const ids = ['11111111-1111-4111-8111-111111111111', 'node-a']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 0, y: 0 }),
      onStateChange: (state) => states.push(state),
      onSuccess: () => undefined,
    })

    const request = controller.execute()
    controller.cancel()
    deferred.reject(new Error('Canvas A 创建失败'))
    await expect(request).rejects.toThrow('Canvas A 创建失败')

    expect(states).toEqual([
      { loading: true, error: null },
      { loading: false, error: null },
    ])
  })

  test('Given 用户连续点击 When 首次创建仍在途 Then 只发送一个 operation', async () => {
    const deferred = createDeferred<{
      document: CanvasDocument
      session: { id: string }
    }>()
    /** 主进程实际收到的创建请求。 */
    const inputs: unknown[] = []
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      createAgentNode: (input) => {
        inputs.push(input)
        return deferred.promise as never
      },
      createId: (() => {
        const ids = ['11111111-1111-4111-8111-111111111111', 'node-1']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 100, y: 80 }),
      onStateChange: () => undefined,
      onSuccess: () => undefined,
    })

    const first = controller.execute()
    const duplicate = controller.execute()

    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', position: { x: 100, y: 80 },
    })
    expect(duplicate).toBe(first)
    deferred.resolve({ document: createSnapshot(1).document, session: { id: 'session-1' } })
    await first
  })

  test('Given 首次失败 When 显式重试 Then 复用 operation 并回传权威创建结果', async () => {
    /** 两次请求及按钮状态变化。 */
    const inputs: Array<{ operationId: string; nodeId: string }> = []
    const states: Array<{ loading: boolean; error: string | null }> = []
    const successes: Array<{ nodeId: string; document: CanvasDocument }> = []
    let attempts = 0
    const document = createSnapshot(1).document
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      createAgentNode: async (input) => {
        inputs.push(input)
        attempts += 1
        if (attempts === 1) {
          throw new CanvasPublicOperationError('CANVAS_CREATE_FAILED', '创建失败，请重试')
        }
        return { document, session: { id: 'session-1' } as never }
      },
      createId: (() => {
        const ids = ['11111111-1111-4111-8111-111111111111', 'node-1']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 0, y: 0 }),
      onStateChange: (state) => states.push(state),
      onSuccess: (nodeId, result) => successes.push({ nodeId, document: result.document }),
    })

    await expect(controller.execute()).rejects.toThrow('创建失败，请重试')
    await expect(controller.execute()).resolves.toBeUndefined()

    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toEqual(inputs[0])
    expect(states).toContainEqual({ loading: false, error: '创建失败，请重试' })
    expect(successes).toEqual([{ nodeId: 'node-1', document }])
  })

  test('Given Canvas 已加载 When 渲染工具栏 Then 添加 Agent 按钮可达并有 tooltip', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const store = createStore()
    store.set(nativeCanvasStatesAtom, new Map([[
      createNativeCanvasKey(target.projectId, target.canvasId),
      { ...createInitialNativeCanvasState(), phase: 'ready', snapshot: createSnapshot(0) },
    ]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          target={target}
          title="页面 Canvas"
          adapter={{
            loadCanvas: async () => createSnapshot(0),
            saveCanvas: async () => createSnapshot(1).document,
            createCanvasAgentNode: async () => ({
              document: createSnapshot(1).document,
              session: { id: 'session-1' } as never,
            }),
            onCanvasChanged: () => () => {},
          }}
          flowRenderer={() => <div />}
        />
      </Provider>,
    )

    expect(html).toContain('aria-label="添加节点"')
    expect(html).toContain('aria-label="选择工具"')
  })
})
