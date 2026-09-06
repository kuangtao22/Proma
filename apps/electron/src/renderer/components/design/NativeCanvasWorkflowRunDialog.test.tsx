import { describe, expect, test } from 'bun:test'
import type { CanvasWorkflowRun } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  NativeCanvasWorkflowRunEntries,
  createNativeCanvasWorkflowRunController,
  type NativeCanvasWorkflowRunState,
} from './NativeCanvasWorkflowRunDialog'

/** 创建工作流历史测试使用的最小运行。 */
function createRun(id: string, status: CanvasWorkflowRun['status'] = 'running'): CanvasWorkflowRun {
  return {
    schemaVersion: 1, id, revision: 1, projectId: 'project-1', canvasId: 'canvas-1',
    operationId: `operation-${id.slice(0, 4)}`,
    owner: { sessionId: 'session-1', runStartedAt: 10 }, status,
    initialCanvasRevision: 1, observedCanvasRevision: 1, rootNodeIds: ['root'], goal: '完成主视觉',
    nodes: [{
      nodeId: 'root', kind: 'agent', identityHash: 'b'.repeat(64), plannedArtifactHash: null,
      mediaConfigRevision: null, inputBindings: [], dependencyNodeIds: [],
      status: status === 'completed' ? 'completed' : 'ready', errorCode: null, execution: null,
      completedArtifactHash: status === 'completed' ? 'c'.repeat(64) : null,
      completedAt: status === 'completed' ? 11 : null,
    }],
    budget: {
      maxMediaRuns: 0, consumedMediaRuns: 0, remainingMediaRuns: 0,
      maxDurationMs: 900_000, remainingDurationMs: 900_000, activeStartedAt: 10,
    },
    autoResumeAfterAdoption: false,
    cancelRequestedAt: status === 'cancelled' ? 11 : null,
    cancelledAt: status === 'cancelled' ? 11 : null,
    createdAt: 10, updatedAt: 11,
  }
}

/** 创建控制器测试夹具并暴露最近状态与事件入口。 */
function createHarness(pages: CanvasWorkflowRun[][]) {
  let state: NativeCanvasWorkflowRunState = {
    runs: [], nextCursor: null, loading: false, loadingMore: false, operationRunId: null, error: null,
  }
  let pageIndex = 0
  let listener: ((event: { projectId: string; canvasId: string; runId: string; revision: number }) => void) | undefined
  const inputs: unknown[] = []
  const controller = createNativeCanvasWorkflowRunController({
    sessionId: 'session-1',
    target: { projectId: 'project-1', canvasId: 'canvas-1' },
    listRuns: async (input) => {
      inputs.push(input)
      const runs = pages[pageIndex++] ?? []
      return { runs, nextCursor: pageIndex < pages.length ? `${10}-${'f'.repeat(48)}` : null }
    },
    getRun: async (input) => {
      inputs.push(input)
      return { ...pages.flat().find((run) => run.id === input.runId)!, revision: 3 }
    },
    resumeRun: async (input) => {
      inputs.push(input)
      return {
        runId: input.runId, status: 'partial', initialRevision: 1, finalRevision: 1,
        nodes: [], imageSummary: null, requiresReview: false, errorCode: null,
      }
    },
    cancelRun: async (input) => {
      inputs.push(input)
      const run = pages.flat().find((current) => current.id === input.runId)!
      return { ...run, status: 'cancelled', cancelRequestedAt: 12, cancelledAt: 12 }
    },
    onChanged: (_target, nextListener) => { listener = nextListener; return () => undefined },
    onStateChange: (nextState) => { state = nextState },
  })
  return { controller, inputs, getState: () => state, emit: (event: Parameters<NonNullable<typeof listener>>[0]) => listener?.(event) }
}

describe('原生 Canvas 工作流运行记录', () => {
  test('Given 弹窗打开与加载更多 When 分页读取 Then 每次携带当前 session 且去重追加', async () => {
    const first = createRun('a'.repeat(48))
    const second = createRun('b'.repeat(48), 'completed')
    const harness = createHarness([[first], [first, second]])

    await harness.controller.load()
    await harness.controller.loadMore()

    expect(harness.getState().runs.map((run) => run.id)).toEqual([first.id, second.id])
    expect(harness.inputs).toEqual([
      { projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'session-1', limit: 20 },
      { projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'session-1', cursor: `${10}-${'f'.repeat(48)}`, limit: 20 },
    ])
  })

  test('Given 已知运行收到更高 revision When 事件触发 Then 只 GET 并更新单条事实', async () => {
    const run = createRun('a'.repeat(48))
    const harness = createHarness([[run]])
    await harness.controller.load()

    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', runId: run.id, revision: 3 })
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.getState().runs[0]?.revision).toBe(3)
    expect(harness.inputs[1]).toEqual({
      projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'session-1', runId: run.id,
    })
  })

  test('Given 用户继续旧运行 When 操作完成 Then 先使用 session 绑定目标再读取最新运行', async () => {
    const run = createRun('a'.repeat(48), 'waiting-review')
    const harness = createHarness([[run]])
    await harness.controller.load()
    await harness.controller.resume(run)

    expect(harness.inputs.slice(1)).toEqual([
      { projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'session-1', runId: run.id },
      { projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'session-1', runId: run.id },
    ])
    expect(harness.getState().operationRunId).toBeNull()
  })

  test('Given 运行列表已加载 When 渲染 Then 展示目标、进度、继续与图标停止入口', () => {
    const run = createRun('a'.repeat(48), 'partial')
    const html = renderToStaticMarkup(
      <NativeCanvasWorkflowRunEntries
        state={{ runs: [run], nextCursor: 'cursor', loading: false, loadingMore: false, operationRunId: null, error: null }}
        onLoadMore={() => undefined}
        onResume={() => undefined}
        onCancel={() => undefined}
      />,
    )

    expect(html).toContain('部分完成')
    expect(html).toContain('完成主视觉')
    expect(html).toContain('0/1 个节点')
    expect(html).toContain('继续')
    expect(html).toContain('aria-label="停止 完成主视觉"')
    expect(html).toContain('加载更多')
  })
})
