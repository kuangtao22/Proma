import { describe, expect, test } from 'bun:test'
import type { AgentCanvasBinding, AgentCanvasBindingChangeEvent, CanvasOrchestrationChangedEvent, CanvasOrchestrationRecord } from '@proma/shared'
import {
  createAgentCanvasOrchestrationController,
  type AgentCanvasOrchestrationControllerDependencies,
  type AgentCanvasOrchestrationControllerState,
} from './agent-canvas-orchestration-controller'

/** 创建可手动完成的异步请求，用于验证迟到结果和代次隔离。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** 创建指定画布和 owner 的最小编排记录。 */
function record(canvasId: string, ownerSessionId = 'session-1', revision = 1): CanvasOrchestrationRecord {
  return {
    schemaVersion: 1, id: `orchestration-${canvasId}`, revision, projectId: 'project-1', canvasId, ownerSessionId,
    request: { requestId: `request-${canvasId}`, goal: '继续制作', intent: 'produce', constraints: [], referenceNodeIds: [], deliverables: [] },
    coordinatorNodeId: null, coordinatorSessionId: null, status: 'waiting', steps: [], summary: '等待继续',
    runStartedAt: null, createdAt: 1, updatedAt: revision,
  }
}

/** 创建当前会话的全量画布关联。 */
function binding(linkedCanvasIds: string[]): AgentCanvasBinding {
  return { projectId: 'project-1', sessionId: 'session-1', linkedCanvasIds, defaultCanvasId: linkedCanvasIds.at(-1), updatedAt: 1 }
}

/** 创建可观测列表、记录读取与订阅释放的控制器边界。 */
function fixture() {
  let bindings: AgentCanvasBinding[] = [binding(['canvas-a'])]
  const records = new Map<string, CanvasOrchestrationRecord | null>([['canvas-a', record('canvas-a')]])
  const states: AgentCanvasOrchestrationControllerState[] = []
  const orchestrationListeners = new Map<string, (event: CanvasOrchestrationChangedEvent) => void>()
  let bindingListener: ((event: AgentCanvasBindingChangeEvent) => void) | undefined
  let listCalls = 0
  let recordCalls = 0
  const releasedCanvases: string[] = []
  let bindingReleases = 0
  const dependencies: AgentCanvasOrchestrationControllerDependencies = {
    projectId: 'project-1', sessionId: 'session-1',
    listBindings: async () => { listCalls += 1; return structuredClone(bindings) },
    onBindingChanged: (_target, listener) => { bindingListener = listener; return () => { bindingReleases += 1 } },
    getRecord: async (target) => { recordCalls += 1; return structuredClone(records.get(target.canvasId) ?? null) },
    onChanged: (target, listener) => {
      orchestrationListeners.set(target.canvasId, listener)
      return () => { releasedCanvases.push(target.canvasId); orchestrationListeners.delete(target.canvasId) }
    },
    onStateChange: state => states.push(state),
  }
  const controller = createAgentCanvasOrchestrationController(dependencies)
  return {
    controller, dependencies, records, states, orchestrationListeners, releasedCanvases,
    setBindings: (value: AgentCanvasBinding[]) => { bindings = value },
    emitBinding: (value: AgentCanvasBinding | null = bindings[0] ?? null) => bindingListener?.({
      projectId: 'project-1', sessionId: 'session-1', cause: value ? 'linked' : 'session-cleared', binding: value,
    }),
    /** 活动画布事件仅改变最近焦点，关联集合与专业报告保持原身份。 */
    emitActive: () => bindingListener?.({
      projectId: 'project-1', sessionId: 'session-1', cause: 'active-changed', binding: bindings[0] ?? null,
    }),
    listCalls: () => listCalls,
    recordCalls: () => recordCalls,
    bindingReleases: () => bindingReleases,
  }
}

describe('普通聊天与多画布编排同步', () => {
  test('Given 已加载协作卡 When 连续切换活动画布 Then 不重复读关联索引或专业报告', async () => {
    /** 独立控制器统计真实读取调用，不连接实际项目。 */
    const f = fixture()
    await f.controller.load()
    /** 切换前的最小读取基线。 */
    const listCalls = f.listCalls()
    const recordCalls = f.recordCalls()
    for (let index = 0; index < 20; index += 1) f.emitActive()
    await f.controller.whenIdle()
    expect(f.listCalls()).toBe(listCalls)
    expect(f.recordCalls()).toBe(recordCalls)
    expect(f.controller.getSnapshot().canvases.map(item => item.canvasId)).toEqual(['canvas-a'])
    f.controller.dispose()
  })

  test('Given 会话关联多个画布 When 加载 Then 保留全部关联且只展示当前owner记录', async () => {
    const f = fixture()
    f.setBindings([binding(['canvas-a', 'canvas-b', 'canvas-c'])])
    f.records.set('canvas-b', record('canvas-b', 'other-session'))
    f.records.set('canvas-c', null)

    await f.controller.load()

    expect(f.controller.getSnapshot().canvases.map(item => item.canvasId)).toEqual(['canvas-a', 'canvas-b', 'canvas-c'])
    expect(f.controller.getSnapshot().canvases.map(item => item.state.record?.canvasId ?? null)).toEqual(['canvas-a', null, null])
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'ready', error: null })
    f.controller.dispose()
  })

  test('Given 已加载多画布 When 记录变为空或其他owner Then 清除旧内容且不重读关联列表', async () => {
    const f = fixture()
    f.setBindings([binding(['canvas-a', 'canvas-b'])])
    f.records.set('canvas-b', record('canvas-b'))
    await f.controller.load()
    const listCalls = f.listCalls()
    f.records.set('canvas-a', null)
    f.records.set('canvas-b', record('canvas-b', 'other-session', 2))

    f.orchestrationListeners.get('canvas-a')?.({ projectId: 'project-1', canvasId: 'canvas-a', revision: 2 })
    f.orchestrationListeners.get('canvas-b')?.({ projectId: 'project-1', canvasId: 'canvas-b', revision: 2 })
    await f.controller.whenIdle()

    expect(f.controller.getSnapshot().canvases.map(item => item.state.record)).toEqual([null, null])
    expect(f.listCalls()).toBe(listCalls)
    f.controller.dispose()
  })

  test('Given 关联集合变化 When 重建差异 Then 复用保留画布并释放所有移除目标', async () => {
    const f = fixture()
    f.setBindings([binding(['canvas-a', 'canvas-b'])])
    f.records.set('canvas-b', record('canvas-b'))
    f.records.set('canvas-c', record('canvas-c'))
    await f.controller.load()
    const canvasBListener = f.orchestrationListeners.get('canvas-b')
    f.setBindings([binding(['canvas-b', 'canvas-c'])])

    f.emitBinding()
    await f.controller.whenIdle()

    expect(f.controller.getSnapshot().canvases.map(item => item.canvasId)).toEqual(['canvas-b', 'canvas-c'])
    expect(f.releasedCanvases).toEqual(['canvas-a'])
    expect(f.orchestrationListeners.get('canvas-b')).toBe(canvasBListener)
    expect(f.listCalls()).toBe(2)
    f.controller.dispose()
    expect(f.releasedCanvases.sort()).toEqual(['canvas-a', 'canvas-b', 'canvas-c'])
  })

  test('Given 旧关联请求未返回 When 变化事件启动新请求 Then 迟到旧结果不覆盖新集合', async () => {
    const f = fixture()
    const first = deferred<AgentCanvasBinding[]>()
    const second = deferred<AgentCanvasBinding[]>()
    let calls = 0
    f.dependencies.listBindings = () => { calls += 1; return calls === 1 ? first.promise : second.promise }
    f.records.set('canvas-b', record('canvas-b'))

    const loading = f.controller.load()
    f.emitBinding(binding(['canvas-b']))
    second.resolve([binding(['canvas-b'])])
    await f.controller.whenIdle()
    first.resolve([binding(['canvas-a'])])
    await loading

    expect(f.controller.getSnapshot().canvases.map(item => item.canvasId)).toEqual(['canvas-b'])
    f.controller.dispose()
  })

  test('Given 关联或记录GET失败 When 重试 Then 保留可见错误并只重读必要层级', async () => {
    const f = fixture()
    let listFails = true
    f.dependencies.listBindings = async () => {
      if (listFails) throw new Error('内部路径不得泄漏')
      return [binding(['canvas-a'])]
    }
    await f.controller.load()
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'error', error: '画布关联暂时无法加载。' })
    listFails = false
    await f.controller.retry()
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'ready', error: null })
    f.controller.dispose()

    const recordFixture = fixture()
    let recordFails = true
    recordFixture.dependencies.getRecord = async target => {
      if (recordFails) throw new Error('读取失败')
      return record(target.canvasId)
    }
    await recordFixture.controller.load()
    const listCalls = recordFixture.listCalls()
    expect(recordFixture.controller.getSnapshot().canvases[0]?.state.error).toBe('制作流程暂时无法加载。')
    recordFails = false
    await recordFixture.controller.retry()
    expect(recordFixture.controller.getSnapshot().canvases[0]?.state.record?.canvasId).toBe('canvas-a')
    expect(recordFixture.listCalls()).toBe(listCalls)
    recordFixture.controller.dispose()
  })

  test('Given 画布记录GET未返回 When 关联先移除该画布 Then 迟到owner记录不恢复已卸载目标', async () => {
    const f = fixture()
    const recordRequest = deferred<CanvasOrchestrationRecord | null>()
    f.dependencies.getRecord = () => recordRequest.promise
    const loading = f.controller.load()
    await Promise.resolve()
    f.setBindings([])

    f.emitBinding(null)
    await f.controller.whenIdle()
    recordRequest.resolve(record('canvas-a'))
    await loading

    expect(f.controller.getSnapshot().canvases).toEqual([])
    expect(f.releasedCanvases).toEqual(['canvas-a'])
    f.controller.dispose()
  })

  test('Given 重复revision事件或会话卸载 When 异步结果到达 Then 不额外列关联且全部订阅只释放一次', async () => {
    const f = fixture()
    await f.controller.load()
    const reads = f.recordCalls()
    f.orchestrationListeners.get('canvas-a')?.({ projectId: 'project-1', canvasId: 'canvas-a', revision: 1 })
    await f.controller.whenIdle()
    expect(f.recordCalls()).toBe(reads)
    expect(f.listCalls()).toBe(1)
    f.controller.dispose()
    f.controller.dispose()
    expect(f.bindingReleases()).toBe(1)
    expect(f.releasedCanvases).toEqual(['canvas-a'])

    const late = fixture()
    const request = deferred<AgentCanvasBinding[]>()
    late.dependencies.listBindings = () => request.promise
    const loading = late.controller.load()
    late.controller.dispose()
    request.resolve([binding(['canvas-a'])])
    await loading
    expect(late.states.at(-1)).toMatchObject({ phase: 'loading' })
    expect(late.controller.getSnapshot().canvases).toEqual([])
  })
})
