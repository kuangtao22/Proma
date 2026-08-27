import { describe, expect, test } from 'bun:test'
import type {
  CanvasDocument,
  CanvasNodeLifecycleResult,
  CanvasTrashEntry,
  CanvasWorkspaceSnapshot,
} from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  NativeCanvasTrashEntries,
  createNativeCanvasTrashController,
  resolveNativeCanvasTrashRestorePosition,
  type NativeCanvasTrashState,
} from './NativeCanvasTrashDialog'

/** 创建文档回收条目，保持测试身份稳定。 */
function createTrashEntry(): CanvasTrashEntry {
  return {
    schemaVersion: 1,
    trashId: 'trash-1',
    nodeId: 'document-1',
    kind: 'document',
    contentId: 'content-1',
    title: '需求文档',
    position: { x: 40, y: 80 },
    deletedRevision: 3,
    deletedAt: Date.UTC(2026, 7, 28, 8, 0),
  }
}

/** 创建回收恢复后的权威快照。 */
function createTrashRestoreSnapshot(revision: number): CanvasWorkspaceSnapshot {
  return {
    document: {
      schemaVersion: 2, projectId: 'project-1', canvasId: 'canvas-1', revision,
      createdAt: 1, updatedAt: 2, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
    },
    writable: true,
    nodeIssues: [],
  }
}

/** 创建可手动完成的 Promise，验证乱序列表请求。 */
function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** 为 list 并发测试创建共享控制器和最近状态。 */
function createTrashListHarness(listTrash: () => Promise<CanvasTrashEntry[]>) {
  let state: NativeCanvasTrashState = {
    entries: [],
    loading: false,
    restoringTrashId: null,
    error: null,
  }
  const controller = createNativeCanvasTrashController({
    target: { projectId: 'project-1', canvasId: 'canvas-1' },
    listTrash,
    restoreNode: async () => ({
      snapshot: {
        document: {
          schemaVersion: 2, projectId: 'project-1', canvasId: 'canvas-1', revision: 5,
          createdAt: 1, updatedAt: 2, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
        },
        writable: true,
        nodeIssues: [],
      },
    }),
    createId: () => 'operation-1',
    getDocument: () => ({
      schemaVersion: 2, projectId: 'project-1', canvasId: 'canvas-1', revision: 4,
      createdAt: 1, updatedAt: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
    }),
    getEmptyCanvasCenter: () => ({ x: 0, y: 0 }),
    onStateChange: (nextState) => { state = nextState },
    onRestored: () => undefined,
  })
  return { controller, getState: () => state }
}

describe('原生 Canvas 回收区', () => {
  test('Given 弹窗关闭 When 创建控制器 Then 不加载回收列表', () => {
    let calls = 0
    createNativeCanvasTrashController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      listTrash: async () => { calls += 1; return [] },
      restoreNode: async () => { throw new Error('not called') },
      createId: () => 'operation-1',
      getDocument: () => ({
        schemaVersion: 2, projectId: 'project-1', canvasId: 'canvas-1', revision: 1,
        createdAt: 1, updatedAt: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
      }),
      getEmptyCanvasCenter: () => ({ x: 0, y: 0 }),
      onStateChange: () => undefined,
      onRestored: () => undefined,
    })
    expect(calls).toBe(0)
  })

  test('Given 原位置被占用 When 恢复 Then 显式使用全局最右追加位置', () => {
    const entry = createTrashEntry()
    const document: CanvasDocument = {
      schemaVersion: 2,
      projectId: 'project-1',
      canvasId: 'canvas-1',
      revision: 4,
      createdAt: 1,
      updatedAt: 2,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{
        id: 'agent-1', kind: 'agent', title: 'Agent', agentSessionId: 'session-1',
        position: { ...entry.position },
      }],
      edges: [],
    }
    expect(resolveNativeCanvasTrashRestorePosition(entry, document, { x: 0, y: 0 }))
      .not.toEqual(entry.position)
  })

  test('Given 回收列表已加载 When 渲染 Then 展示类型、标题和删除时间', () => {
    const html = renderToStaticMarkup(
      <NativeCanvasTrashEntries
        entries={[createTrashEntry()]}
        loading={false}
        restoringTrashId={null}
        error={null}
        onRestore={() => undefined}
      />,
    )
    expect(html).toContain('文档')
    expect(html).toContain('需求文档')
    expect(html).toContain('2026')
  })

  test('Given 单项恢复失败 When 展示错误 Then 保留条目和恢复入口以便重试', () => {
    const html = renderToStaticMarkup(
      <NativeCanvasTrashEntries
        entries={[createTrashEntry()]}
        loading={false}
        restoringTrashId={null}
        error="节点恢复失败，请重试。"
        onRestore={() => undefined}
      />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('需求文档')
    expect(html).toContain('aria-label="恢复 需求文档"')
  })

  test('Given 恢复首次失败 When 重试 Then 完整复用操作身份并只选择恢复节点', async () => {
    const entry = createTrashEntry()
    const inputs: unknown[] = []
    const restored: string[] = []
    let attempt = 0
    const controller = createNativeCanvasTrashController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      listTrash: async () => [entry],
      restoreNode: async (input) => {
        inputs.push(input)
        attempt += 1
        if (attempt === 1) throw new Error('restore failed')
        return {
          snapshot: {
            document: {
              schemaVersion: 2, projectId: 'project-1', canvasId: 'canvas-1', revision: 5,
              createdAt: 1, updatedAt: 2, viewport: { x: 10, y: 20, zoom: 1.2 }, nodes: [], edges: [],
            },
            writable: true,
            nodeIssues: [],
          },
          selectedNodeId: entry.nodeId,
        }
      },
      createId: () => 'operation-1',
      getDocument: () => ({
        schemaVersion: 2, projectId: 'project-1', canvasId: 'canvas-1', revision: 4,
        createdAt: 1, updatedAt: 1, viewport: { x: 10, y: 20, zoom: 1.2 }, nodes: [], edges: [],
      }),
      getEmptyCanvasCenter: () => ({ x: 0, y: 0 }),
      onStateChange: () => undefined,
      onRestored: (_result, nodeId) => restored.push(nodeId),
    })

    await controller.load()
    await controller.restore(entry)
    await controller.restore(entry)

    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toEqual(inputs[0])
    expect(inputs[0]).toMatchObject({
      trashId: 'trash-1', expectedRevision: 4, position: entry.position,
    })
    expect(restored).toEqual(['document-1'])
  })

  test('Given load1 晚于 load2 When 两次列表乱序完成 Then 旧结果不覆盖新列表', async () => {
    const first = createDeferred<CanvasTrashEntry[]>()
    const second = createDeferred<CanvasTrashEntry[]>()
    let calls = 0
    const harness = createTrashListHarness(() => (calls += 1) === 1 ? first.promise : second.promise)
    const load1 = harness.controller.load()
    const load2 = harness.controller.load()
    const newest = { ...createTrashEntry(), trashId: 'trash-new', title: '新列表' }
    second.resolve([newest])
    await load2
    first.resolve([createTrashEntry()])
    await load1
    expect(harness.getState().entries).toEqual([newest])
  })

  test('Given list 在途 When 恢复成功 Then 旧 list 晚回不能复活已恢复条目', async () => {
    const entry = createTrashEntry()
    const initial = Promise.resolve([entry])
    const stale = createDeferred<CanvasTrashEntry[]>()
    let calls = 0
    const harness = createTrashListHarness(() => (calls += 1) === 1 ? initial : stale.promise)
    await harness.controller.load()
    const staleLoad = harness.controller.load()
    await harness.controller.restore(entry)
    stale.resolve([entry])
    await staleLoad
    expect(harness.getState().entries).toEqual([])
  })

  test('Given 关闭后重开 list 在途 When 关闭前 restore 晚成功 Then 收口 loading 且旧 list 不复活条目', async () => {
    const entry = createTrashEntry()
    const restore = createDeferred<CanvasNodeLifecycleResult>()
    const reopenedList = createDeferred<CanvasTrashEntry[]>()
    let state: NativeCanvasTrashState = {
      entries: [entry], loading: false, restoringTrashId: null, error: null,
    }
    const controller = createNativeCanvasTrashController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      listTrash: () => reopenedList.promise,
      restoreNode: () => restore.promise,
      createId: () => 'operation-1',
      getDocument: () => ({
        schemaVersion: 2, projectId: 'project-1', canvasId: 'canvas-1', revision: 4,
        createdAt: 1, updatedAt: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
      }),
      getEmptyCanvasCenter: () => ({ x: 0, y: 0 }),
      onStateChange: (nextState) => { state = nextState },
      onRestored: () => undefined,
    })
    const restoring = controller.restore(entry)
    controller.close()
    const loading = controller.load()

    restore.resolve({ snapshot: createTrashRestoreSnapshot(5), selectedNodeId: entry.nodeId })
    await restoring
    reopenedList.resolve([entry])
    await loading

    expect(state).toEqual({ entries: [], loading: false, restoringTrashId: null, error: null })
  })

  test('Given 旧 load reject 晚于新 load success When settle Then 不覆盖新成功状态', async () => {
    const first = createDeferred<CanvasTrashEntry[]>()
    const second = createDeferred<CanvasTrashEntry[]>()
    let calls = 0
    const harness = createTrashListHarness(() => (calls += 1) === 1 ? first.promise : second.promise)
    const load1 = harness.controller.load()
    const load2 = harness.controller.load()
    second.resolve([createTrashEntry()])
    await load2
    first.reject(new Error('old load failed'))
    await load1
    expect(harness.getState()).toMatchObject({
      entries: [createTrashEntry()], loading: false, error: null,
    })
  })

  test('Given 回收区关闭 When 旧 load resolve 或 reject Then 均不再更新界面状态', async () => {
    const resolved = createDeferred<CanvasTrashEntry[]>()
    const resolvedHarness = createTrashListHarness(() => resolved.promise)
    const resolvedLoad = resolvedHarness.controller.load()
    resolvedHarness.controller.close()
    resolved.resolve([createTrashEntry()])
    await resolvedLoad
    expect(resolvedHarness.getState()).toMatchObject({ entries: [], loading: false, error: null })

    const rejected = createDeferred<CanvasTrashEntry[]>()
    const rejectedHarness = createTrashListHarness(() => rejected.promise)
    const rejectedLoad = rejectedHarness.controller.load()
    rejectedHarness.controller.close()
    rejected.reject(new Error('late failure'))
    await rejectedLoad
    expect(rejectedHarness.getState()).toMatchObject({ entries: [], loading: false, error: null })
  })
})
