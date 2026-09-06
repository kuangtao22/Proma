import { describe, expect, test } from 'bun:test'
import {
  parseCanvasWorkflowRun,
  parseCanvasWorkflowRunChangedEvent,
  parseCanvasWorkflowRunListInput,
  parseCanvasWorkflowRunPage,
  parseCanvasWorkflowRunTarget,
  type CanvasWorkflowRun,
} from './canvas-workflow-run'

/** 创建共享合同测试使用的最小持久运行。 */
function createRun(): CanvasWorkflowRun {
  return {
    schemaVersion: 1,
    id: 'a'.repeat(48),
    revision: 0,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    operationId: 'operation-1',
    owner: { sessionId: 'session-1', runStartedAt: 10 },
    status: 'running',
    initialCanvasRevision: 3,
    observedCanvasRevision: 3,
    rootNodeIds: ['agent-root'],
    goal: '完成画布生产',
    nodes: [{
      nodeId: 'agent-root', kind: 'agent', identityHash: 'b'.repeat(64),
      plannedArtifactHash: null, mediaConfigRevision: null, inputBindings: [], dependencyNodeIds: [],
      status: 'ready', errorCode: null, execution: null,
      completedArtifactHash: null, completedAt: null,
    }],
    budget: {
      maxMediaRuns: 2, consumedMediaRuns: 0, remainingMediaRuns: 2,
      maxDurationMs: 900_000, remainingDurationMs: 900_000, activeStartedAt: 10,
    },
    autoResumeAfterAdoption: false,
    cancelRequestedAt: null,
    cancelledAt: null,
    createdAt: 10,
    updatedAt: 10,
  }
}

describe('Canvas Workflow Run 共享合同', () => {
  test('Given 合法持久运行 When 跨进程解析 Then 深拷贝重建全部稳定事实', () => {
    const input = createRun()
    const parsed = parseCanvasWorkflowRun(input)

    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    expect(parsed.nodes).not.toBe(input.nodes)
  })

  test('Given 未知字段或循环依赖 When 解析 Then fail closed', () => {
    const input = createRun()
    expect(() => parseCanvasWorkflowRun({ ...input, privatePath: '/tmp/private' }))
      .toThrow('CANVAS_WORKFLOW_RUN_INVALID')

    const cyclic = {
      ...input,
      nodes: [{ ...input.nodes[0], dependencyNodeIds: ['agent-root'] }],
    }
    expect(() => parseCanvasWorkflowRun(cyclic)).toThrow('CANVAS_WORKFLOW_RUN_INVALID')
  })

  test('Given 取消运行仍有已完成产物 When 解析 Then 保留产物且拒绝复活状态', () => {
    const input = createRun()
    const cancelled: CanvasWorkflowRun = {
      ...input,
      status: 'cancelled',
      cancelRequestedAt: 11,
      cancelledAt: 12,
      nodes: [{
        ...input.nodes[0]!, status: 'completed',
        execution: { kind: 'agent', operationId: 'child-1' },
        completedArtifactHash: 'c'.repeat(64), completedAt: 11,
      }],
    }

    expect(parseCanvasWorkflowRun(cancelled).nodes[0]?.completedArtifactHash).toBe('c'.repeat(64))
    expect(() => parseCanvasWorkflowRun({ ...cancelled, cancelledAt: null }))
      .toThrow('CANVAS_WORKFLOW_RUN_INVALID')
  })

  test('Given 合法运行目标与分页请求 When 跨进程解析 Then 只重建公开有界字段', () => {
    const target = parseCanvasWorkflowRunTarget({
      projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'session-1', runId: 'd'.repeat(48),
    })
    const listInput = parseCanvasWorkflowRunListInput({
      projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'session-1',
      cursor: `${10}-${'e'.repeat(48)}`, limit: 20,
    })

    expect(target).toEqual({
      projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'session-1', runId: 'd'.repeat(48),
    })
    expect(listInput).toEqual({
      projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'session-1',
      cursor: `${10}-${'e'.repeat(48)}`, limit: 20,
    })
    expect(() => parseCanvasWorkflowRunTarget({ ...target, sessionId: 'bad/session' }))
      .toThrow('CANVAS_WORKFLOW_RUN_TARGET_INVALID')
    expect(() => parseCanvasWorkflowRunListInput({ ...listInput, limit: 257 }))
      .toThrow('CANVAS_WORKFLOW_RUN_LIST_INPUT_INVALID')
  })

  test('Given 运行历史页与变更事件 When 解析 Then 深重建并拒绝未知字段', () => {
    const run = createRun()
    const page = parseCanvasWorkflowRunPage({ runs: [run], nextCursor: `${run.updatedAt}-${run.id}` })
    const event = parseCanvasWorkflowRunChangedEvent({
      projectId: run.projectId, canvasId: run.canvasId, runId: run.id, revision: run.revision,
    })

    expect(page.runs).toEqual([run])
    expect(page.runs).not.toBe([run])
    expect(page.runs[0]).not.toBe(run)
    expect(event).toEqual({
      projectId: run.projectId, canvasId: run.canvasId, runId: run.id, revision: run.revision,
    })
    expect(() => parseCanvasWorkflowRunPage({ runs: [run], nextCursor: null, path: '/tmp/private' }))
      .toThrow('CANVAS_WORKFLOW_RUN_PAGE_INVALID')
    expect(() => parseCanvasWorkflowRunChangedEvent({ ...event, revision: -1 }))
      .toThrow('CANVAS_WORKFLOW_RUN_CHANGED_EVENT_INVALID')
  })
})
