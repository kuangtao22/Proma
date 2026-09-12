import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  createCanvasOperationTools,
  paginateCanvasOperationRecords,
  type CanvasOperationToolHandlers,
} from './canvas-operation-tools'
import type { CanvasToolRunContext } from './canvas-tool-provider'

/** 操作工具测试使用的固定可信运行上下文。 */
const context: CanvasToolRunContext = {
  projectId: 'project-1',
  sessionId: 'session-1',
  runStartedAt: 10,
  explicitReferences: [],
  permissionCeiling: 'execute',
}

test('Given 持久工作流需要定向修复 When 使用生产恢复工具 Then 完整透传原revision预算与幂等身份', async () => {
  const received: unknown[] = []
  const input = { canvasId: 'canvas-1', runId: 'workflow-1', intent: 'explicit', expectedRunRevision: 4,
    resumeOperationId: 'repair_1', retryNodeIds: ['image-1'], addMediaRuns: 2, addDurationMs: 5000 }
  const tools = createCanvasOperationTools({ resumeWorkflow: async (value) => {
    received.push(value)
    return { status: 'waiting-review' }
  } }, context, { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never) }, () => 'operation-1')
  await executeOperation(tools, 'canvas_resume_workflow', input)
  expect(received).toEqual([{ ...input, projectId: 'project-1' }])
  for (const invalid of [{ addMediaRuns: -1 }, { retryNodeIds: ['image-1', 'image-1'] }, { addDurationMs: 0.1 }]) {
    await expect(executeOperation(tools, 'canvas_resume_workflow', { ...input, ...invalid })).rejects.toThrow('CANVAS_OPERATION_INPUT_INVALID')
  }
  expect(received).toHaveLength(1)
})

test('Given 单任务重试新建或重放 When 返回可信回执 Then 只有新建replacement登记为当前合同生成', async () => {
  const received: unknown[] = []
  let created = true
  const tools = createCanvasOperationTools({ retryTask: async () => ({ created, replacementJobId: 'replacement-1' }) },
    context, { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never) }, () => 'operation-1',
    () => ({ ...context, onImageJobsCreated: (canvasId, jobs) => { received.push({ canvasId, jobs }) } }))
  const input = { canvasId: 'canvas-1', nodeId: 'image-1', jobId: 'failed-job', intent: 'explicit' }
  await executeOperation(tools, 'canvas_retry_task', input)
  created = false
  await executeOperation(tools, 'canvas_retry_task', input)
  expect(received).toEqual([{ canvasId: 'canvas-1', jobs: [{ nodeId: 'image-1', jobId: 'replacement-1' }] }])
})

/** 调用指定操作工具并保留真实取消信号。 */
async function executeOperation(
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool.execute('tool-call-1', input as never, signal as never, undefined as never, undefined as never)
}

/** 为十五个操作工具装配无副作用处理器。 */
function createAllHandlers(effect: () => Record<string, unknown> = () => ({ ok: true })): CanvasOperationToolHandlers {
  return {
    getTask: async () => effect(),
    cancelTask: async () => effect(),
    retryTask: async () => effect(),
    listVersions: async () => effect(),
    readVersion: async () => effect(),
    adoptVersion: async () => effect(),
    adoptCandidateBatch: async () => effect(),
    exportArtifact: async () => effect(),
    listTrash: async () => effect(),
    restoreNode: async () => effect(),
    rebuildAgent: async () => effect(),
    listWorkflows: async () => effect(),
    getWorkflow: async () => effect(),
    resumeWorkflow: async () => effect(),
    cancelWorkflow: async () => effect(),
  }
}

/** 返回十五个工具各自通过 schema 的最小输入。 */
function createValidInputs(): Record<string, Record<string, unknown>> {
  const node = { canvasId: 'canvas-1', nodeId: 'node-1' }
  const task = { ...node, jobId: 'job-1' }
  const workflow = { canvasId: 'canvas-1', runId: 'run-1' }
  return {
    canvas_get_task: task,
    canvas_cancel_task: { ...task, intent: 'explicit' },
    canvas_retry_task: { ...task, intent: 'explicit' },
    canvas_list_versions: node,
    canvas_read_version: { ...node, version: { kind: 'document', revision: 1 } },
    canvas_adopt_version: {
      ...node, version: { kind: 'document', revision: 1 }, intent: 'explicit',
      expectedCanvasRevision: 2, expectedVersion: 3,
    },
    canvas_adopt_candidate_batch: {
      canvasId: 'canvas-1', batchId: 'batch-1', mode: 'succeeded', intent: 'explicit',
    },
    canvas_export_artifact: { ...node, version: { kind: 'document', revision: 1 }, intent: 'explicit' },
    canvas_list_trash: { canvasId: 'canvas-1' },
    canvas_restore_node: {
      canvasId: 'canvas-1', trashId: 'trash-1', expectedRevision: 2,
      position: { x: 0, y: 0 }, intent: 'explicit',
    },
    canvas_rebuild_agent: { ...node, expectedRevision: 2, intent: 'explicit' },
    canvas_list_workflows: { canvasId: 'canvas-1' },
    canvas_get_workflow: workflow,
    canvas_resume_workflow: { ...workflow, intent: 'explicit' },
    canvas_cancel_workflow: { ...workflow, intent: 'explicit' },
  }
}

describe('Canvas 操作工具', () => {
  test('Given 批量导出精确版本 When 校验工具输入 Then 接受十六项并拒绝超限批次', async () => {
    const tools = createCanvasOperationTools(createAllHandlers(), {
      projectId: 'project-1', sessionId: 'session-1', runStartedAt: 1,
      explicitReferences: [], permissionCeiling: 'execute',
    }, { authorizeRead: () => undefined, requireLinkedCanvas: () => ({ projectId: 'project-1', canvasId: 'canvas-1' }) as never }, () => 'operation-1')
    const item = { nodeId: 'node-1', version: { kind: 'document', revision: 1 } }
    await expect(executeOperation(tools, 'canvas_export_artifact', {
      canvasId: 'canvas-1', items: Array.from({ length: 16 }, (_, index) => ({ ...item, nodeId: `node-${index}` })),
      destination: { kind: 'project', relativeDirectory: 'exports' }, intent: 'explicit',
    })).resolves.toBeDefined()
    await expect(executeOperation(tools, 'canvas_export_artifact', {
      canvasId: 'canvas-1', items: Array.from({ length: 17 }, (_, index) => ({ ...item, nodeId: `node-${index}` })),
      intent: 'explicit',
    })).rejects.toThrow('CANVAS_OPERATION_INPUT_INVALID')
  })

  test('Given 明确候选批次采用 When 校验工具输入 Then 复用 shared 合同且拒绝任意节点子集', async () => {
    /** 记录 handler 实际收到的 exact-key shared 输入。 */
    const received: unknown[] = []
    const tools = createCanvasOperationTools(
      { adoptCandidateBatch: async (input) => { received.push(input); return { status: 'adopted' } } },
      context,
      { authorizeRead: () => undefined, requireLinkedCanvas: () => ({}) as never },
      () => 'operation-1',
    )

    await executeOperation(tools, 'canvas_adopt_candidate_batch', {
      canvasId: 'canvas-1', batchId: 'batch-1', mode: 'all', intent: 'explicit',
    })
    expect(received).toEqual([{
      projectId: 'project-1', canvasId: 'canvas-1', batchId: 'batch-1', mode: 'all',
    }])
    await expect(executeOperation(tools, 'canvas_adopt_candidate_batch', {
      canvasId: 'canvas-1', batchId: 'batch-1', mode: 'selected',
      selectedNodeIds: ['node-1'], intent: 'explicit',
    })).rejects.toThrow('CANVAS_OPERATION_INPUT_INVALID')
    expect(received).toHaveLength(1)
  })

  test('Given 分页游标已绑定列表作用域和内容 When 跨节点复用或历史变化 Then 明确失效', () => {
    const first = paginateCanvasOperationRecords([{ id: 'a' }, { id: 'b' }], 'project-1/canvas-1/node-1/versions', { limit: 1 })
    expect(first.entries).toEqual([{ id: 'a' }])
    expect(first.nextCursor).toBeString()

    expect(() => paginateCanvasOperationRecords(
      [{ id: 'a' }, { id: 'b' }],
      'project-1/canvas-1/node-2/versions',
      { cursor: first.nextCursor ?? undefined },
    )).toThrow('CANVAS_OPERATION_CURSOR_INVALID')
    expect(() => paginateCanvasOperationRecords(
      [{ id: 'a' }, { id: 'changed' }],
      'project-1/canvas-1/node-1/versions',
      { cursor: first.nextCursor ?? undefined },
    )).toThrow('CANVAS_OPERATION_CURSOR_INVALID')
  })

  test('Given 业务处理器返回超过 64KiB When 工具准备模型响应 Then 拒绝发送超预算正文', async () => {
    const tools = createCanvasOperationTools(
      { getTask: async () => ({ content: 'x'.repeat(64 * 1024) }) },
      context,
      { authorizeRead: () => undefined, requireLinkedCanvas: () => ({}) as never },
      () => 'operation-1',
    )

    await expect(executeOperation(tools, 'canvas_get_task', createValidInputs().canvas_get_task!))
      .rejects.toThrow('CANVAS_OPERATION_RESPONSE_TOO_LARGE')
  })

  test('Given 图片任务查询带等待时间 When 校验输入 Then 只接受 0 到 60000 毫秒整数', async () => {
    const received: unknown[] = []
    const tools = createCanvasOperationTools(
      { getTask: async (input) => { received.push(input); return { status: 'running' } } },
      context,
      { authorizeRead: () => undefined, requireLinkedCanvas: () => ({}) as never },
      () => 'operation-1',
    )

    await executeOperation(tools, 'canvas_get_task', { ...createValidInputs().canvas_get_task!, waitMs: 60_000 })
    expect(received).toEqual([{ ...createValidInputs().canvas_get_task!, waitMs: 60_000, projectId: 'project-1' }])
    for (const waitMs of [-1, 60_001, 1.5]) {
      await expect(executeOperation(tools, 'canvas_get_task', {
        ...createValidInputs().canvas_get_task!, waitMs,
      })).rejects.toThrow('CANVAS_OPERATION_INPUT_INVALID')
    }
  })

  test('Given 重试和查询工具 When 读取描述 Then 明确要求沿 replacementJobId 等待真实终态', () => {
    const tools = createCanvasOperationTools(
      createAllHandlers(), context,
      { authorizeRead: () => undefined, requireLinkedCanvas: () => ({}) as never },
      () => 'operation-1',
    )
    const descriptions = Object.fromEntries(tools.map((tool) => [tool.name, tool.description]))

    expect(descriptions.canvas_retry_task).toContain('replacementJobId')
    expect(descriptions.canvas_retry_task).toContain('canvas_get_task')
    expect(descriptions.canvas_get_task).toContain('waitMs')
    expect(descriptions.canvas_get_task).toContain('同一 job')
    expect(descriptions.canvas_get_task).toContain('失败')
  })

  test('Given 异步读取期间收到取消或权限撤销 When 处理器完成 Then 响应前 fresh 校验并拒绝过期结果', async () => {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let authorized = true
    const tools = createCanvasOperationTools(
      {
        getTask: async () => {
          entered.resolve()
          await gate.promise
          return { status: 'ready' }
        },
      },
      context,
      {
        authorizeRead: () => {
          if (!authorized) throw new Error('CANVAS_ACCESS_DENIED')
        },
        requireLinkedCanvas: () => ({}) as never,
      },
      () => 'operation-1',
    )
    const controller = new AbortController()
    const cancelled = executeOperation(tools, 'canvas_get_task', createValidInputs().canvas_get_task!, controller.signal)
    await entered.promise
    controller.abort()
    gate.resolve()
    await expect(cancelled).rejects.toThrow('CANVAS_OPERATION_CANCELLED')

    const secondGate = Promise.withResolvers<void>()
    const secondEntered = Promise.withResolvers<void>()
    const revocableTools = createCanvasOperationTools(
      {
        getTask: async () => {
          secondEntered.resolve()
          await secondGate.promise
          return { status: 'ready' }
        },
      },
      context,
      {
        authorizeRead: () => {
          if (!authorized) throw new Error('CANVAS_ACCESS_DENIED')
        },
        requireLinkedCanvas: () => ({}) as never,
      },
      () => 'operation-2',
    )
    authorized = true
    const revoked = executeOperation(revocableTools, 'canvas_get_task', createValidInputs().canvas_get_task!)
    await secondEntered.promise
    authorized = false
    secondGate.resolve()
    await expect(revoked).rejects.toThrow('CANVAS_ACCESS_DENIED')
  })

  test('Given plan 权限上限 When 调用十五个操作工具 Then 六个读取可用且九个写入零执行', async () => {
    let effects = 0
    const planContext: CanvasToolRunContext = { ...context, permissionCeiling: 'plan' }
    const tools = createCanvasOperationTools(
      createAllHandlers(() => { effects += 1; return { ok: true } }),
      planContext,
      { authorizeRead: () => undefined, requireLinkedCanvas: () => ({}) as never },
      () => 'operation-1',
    )
    const inputs = createValidInputs()
    const readNames = [
      'canvas_get_task', 'canvas_list_versions', 'canvas_read_version',
      'canvas_list_trash', 'canvas_list_workflows', 'canvas_get_workflow',
    ]
    const writeNames = [
      'canvas_cancel_task', 'canvas_retry_task', 'canvas_adopt_version', 'canvas_adopt_candidate_batch',
      'canvas_export_artifact',
      'canvas_restore_node', 'canvas_rebuild_agent', 'canvas_resume_workflow', 'canvas_cancel_workflow',
    ]

    for (const name of readNames) await executeOperation(tools, name, inputs[name]!)
    for (const name of writeNames) {
      await expect(executeOperation(tools, name, inputs[name]!)).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    }
    expect(effects).toBe(readNames.length)
  })
})
