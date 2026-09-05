import { describe, expect, test } from 'bun:test'
import { createCanvasBoundEdge, createEmptyCanvasDocument } from '@proma/shared'
import type {
  CanvasDocument,
  CanvasNode,
  CanvasRunNodesResult,
  CanvasRunWorkflowInput,
} from '@proma/shared'
import type { CanvasAgentExecutionResult } from './canvas-agent-execution-service'
import {
  createCanvasWorkflowExecutionService,
  type CanvasWorkflowExecutionServiceDependencies,
} from './canvas-workflow-execution-service'

const target = { projectId: 'project-1', canvasId: 'canvas-1' }

/** 创建调度测试使用的最小 Canvas 节点。 */
function createNode(id: string, kind: CanvasNode['kind'], stale = false): CanvasNode {
  const base = {
    id,
    title: id,
    position: { x: 0, y: 0 },
    ...(stale ? { upstreamChange: { sourceNodeIds: ['root'], changedAt: 2 } } : {}),
  }
  if (kind === 'agent') return { ...base, kind, agentSessionId: `session-${id}` }
  if (kind === 'image') return { ...base, kind, imageModuleId: `module-${id}` }
  if (kind === 'document') return { ...base, kind, documentId: `document-${id}`, contentRevision: 1 }
  return { ...base, kind, prototypeId: `prototype-${id}`, contentRevision: 1, devicePreset: 'desktop' }
}

/** 创建带确定性 bound 数据边的 Canvas 文档。 */
function createDocument(nodes: CanvasNode[], pairs: Array<[CanvasNode, CanvasNode]> = []): CanvasDocument {
  return {
    ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1),
    revision: 3,
    nodes,
    edges: pairs.map(([source, destination], index) => createCanvasBoundEdge(source, destination, {
      id: `edge-${index}`,
      sourceNodeId: source.id,
      targetNodeId: destination.id,
      relation: 'depends-on',
    })),
  }
}

/** 构造可观察 Agent、图片和 fresh-read 行为的调度夹具。 */
function createFixture(document: CanvasDocument, options: {
  busyNodeIds?: string[]
  failNodeIds?: string[]
  imageResult?: CanvasRunNodesResult
  imageTerminalStatus?: 'ready' | 'partial'
  onAgentStart?: (nodeId: string, signal?: AbortSignal) => Promise<void>
  onImageWait?: (signal: AbortSignal) => Promise<void>
} = {}) {
  let current = structuredClone(document)
  const agentStarts: string[] = []
  const imageRuns: string[][] = []
  const imageWaits: string[][] = []
  const imageCancels: string[][] = []
  let activeAgents = 0
  let maxActiveAgents = 0
  let deadlineCallback = (): void => undefined
  const dependencies: CanvasWorkflowExecutionServiceDependencies = {
    load: async () => structuredClone(current),
    validateAccess: () => undefined,
    isAgentBusy: (node) => options.busyNodeIds?.includes(node.id) ?? false,
    agentExecution: {
      execute: async (request): Promise<CanvasAgentExecutionResult> => {
        if (request.mode !== 'parent-orchestrated') throw new Error('TEST_PARENT_MODE_REQUIRED')
        agentStarts.push(request.target.nodeId)
        activeAgents += 1
        maxActiveAgents = Math.max(maxActiveAgents, activeAgents)
        await options.onAgentStart?.(request.target.nodeId, request.signal)
        activeAgents -= 1
        if (request.signal?.aborted) return { status: 'cancelled' }
        if (options.failNodeIds?.includes(request.target.nodeId)) return { status: 'errored' }
        current.revision += 1
        return {
          status: 'completed',
          output: {
            target: request.target,
            revision: current.revision,
            pointer: {
              messageUuid: '11111111-1111-4111-8111-111111111111',
              contentSha256: 'a'.repeat(64),
              completedAt: 4,
            },
            downstreamNodeIds: [],
          },
        }
      },
    },
    imageRuns: {
      run: async (_context, _target, nodes) => {
        imageRuns.push(nodes.map((node) => node.id))
        return options.imageResult ?? {
          tasks: nodes.map((node, index) => ({ nodeId: node.id, status: 'started', taskId: `task-${index}` })),
          batch: {
            batchId: 'batch-1', status: 'running', totalCount: nodes.length,
            candidateCount: 0, failedCount: 0, runningCount: nodes.length, requiresCanvasReview: true,
          },
        }
      },
      awaitBatch: async (input) => {
        imageWaits.push([...input.taskIds])
        await options.onImageWait?.(input.signal)
        if (input.signal.aborted) throw new Error('CANVAS_IMAGE_BATCH_ABORTED')
        return {
          batchId: input.batchId,
          status: options.imageTerminalStatus ?? 'ready',
          totalCount: input.taskIds.length,
          candidateCount: options.imageTerminalStatus === 'partial' ? 0 : input.taskIds.length,
          failedCount: options.imageTerminalStatus === 'partial' ? input.taskIds.length : 0,
          runningCount: 0,
          requiresCanvasReview: true,
        }
      },
      cancelTasks: async (input) => { imageCancels.push([...input.taskIds]) },
    },
    now: () => 1_000,
    setDeadline: (callback) => {
      deadlineCallback = callback
      return { cancel: () => undefined }
    },
  }
  const service = createCanvasWorkflowExecutionService(dependencies)
  const input: CanvasRunWorkflowInput = {
    canvasId: target.canvasId,
    expectedRevision: document.revision,
    startNodeIds: ['root'],
    goal: '完成可达工作流',
    maxImageRuns: 2,
  }
  return {
    service,
    input,
    agentStarts,
    imageRuns,
    imageWaits,
    imageCancels,
    maxActiveAgents: () => maxActiveAgents,
    triggerDeadline: () => deadlineCallback(),
    setDocument: (next: CanvasDocument) => { current = structuredClone(next) },
  }
}

const context = {
  projectId: target.projectId,
  sessionId: 'parent-session',
  runStartedAt: 10,
  explicitReferences: [],
  permissionCeiling: 'execute' as const,
}

describe('Canvas Workflow Execution Service', () => {
  test('Given stale revision、busy root 或同 Canvas active When 执行 Then 所有节点保持零副作用', async () => {
    const root = createNode('root', 'agent')
    const stale = createFixture(createDocument([root]))
    stale.input.expectedRevision = 2
    await expect(stale.service.execute(context, stale.input, 'tool-1')).rejects.toThrow('CANVAS_REVISION_CONFLICT')
    expect(stale.agentStarts).toEqual([])

    const busy = createFixture(createDocument([root]), { busyNodeIds: ['root'] })
    await expect(busy.service.execute(context, busy.input, 'tool-2')).rejects.toThrow('SESSION_BUSY')
    expect(busy.agentStarts).toEqual([])

    const active = createFixture(createDocument([root]), { onAgentStart: () => new Promise(() => undefined) })
    void active.service.execute(context, active.input, 'tool-3')
    await Promise.resolve()
    await expect(active.service.execute(context, active.input, 'tool-4')).rejects.toThrow('CANVAS_WORKFLOW_ACTIVE')
  })

  test('Given 多上游、稳定产物和三个 ready Agent When 调度 Then 等齐依赖且 Agent 并发最多两个', async () => {
    const root = createNode('root', 'agent')
    const second = createNode('second', 'agent')
    const third = createNode('third', 'agent')
    const documentNode = createNode('document', 'document')
    const downstream = createNode('downstream', 'agent', true)
    const fixture = createFixture(createDocument(
      [root, second, third, documentNode, downstream],
      [[root, documentNode], [root, downstream], [documentNode, downstream]],
    ), { onAgentStart: async () => { await Promise.resolve() } })
    fixture.input.startNodeIds = ['root', 'second', 'third']

    const result = await fixture.service.execute(context, fixture.input, 'tool-1')

    expect(result.status).toBe('completed')
    expect(fixture.maxActiveAgents()).toBe(2)
    expect(fixture.agentStarts.slice(0, 3).sort()).toEqual(['root', 'second', 'third'])
    expect(fixture.agentStarts.at(-1)).toBe('downstream')
    expect(result.nodes.find((node) => node.nodeId === 'document')?.status).toBe('satisfied')
  })

  test('Given 一条 Agent 分支失败 When 调度 Then 只阻断后继并继续独立分支', async () => {
    const root = createNode('root', 'agent')
    const independent = createNode('independent', 'agent')
    const blocked = createNode('blocked', 'agent', true)
    const fixture = createFixture(createDocument([root, independent, blocked], [[root, blocked]]), {
      failNodeIds: ['root'],
    })
    fixture.input.startNodeIds = ['root', 'independent']

    const result = await fixture.service.execute(context, fixture.input, 'tool-1')

    expect(fixture.agentStarts).toContain('independent')
    expect(result.nodes.find((node) => node.nodeId === 'blocked')).toEqual({
      nodeId: 'blocked', status: 'blocked', errorCode: 'UPSTREAM_FAILED',
    })
    expect(result.status).toBe('partial')
  })

  test('Given ready 图片 When 调度 Then 单批运行并等待候选，且后继等待用户采用', async () => {
    const root = createNode('root', 'agent')
    const image = createNode('image', 'image')
    const downstream = createNode('downstream', 'agent', true)
    const fixture = createFixture(createDocument([root, image, downstream], [[root, image], [image, downstream]]))

    const result = await fixture.service.execute(context, fixture.input, 'tool-1')

    expect(fixture.imageRuns).toEqual([['image']])
    expect(fixture.imageWaits).toEqual([['task-0']])
    expect(fixture.agentStarts).toEqual(['root'])
    expect(result.status).toBe('waiting-review')
    expect(result.nodes.find((node) => node.nodeId === 'downstream')).toEqual({
      nodeId: 'downstream', status: 'blocked', errorCode: 'WAITING_FOR_IMAGE_ADOPTION',
    })
  })

  test('Given 图片预算为零 When 调度 Then 图片等待审批且不调用模型', async () => {
    const root = createNode('root', 'agent')
    const image = createNode('image', 'image')
    const fixture = createFixture(createDocument([root, image], [[root, image]]))
    fixture.input.maxImageRuns = 0

    const result = await fixture.service.execute(context, fixture.input, 'tool-1')

    expect(fixture.imageRuns).toEqual([])
    expect(result.nodes.find((node) => node.nodeId === 'image')?.status).toBe('waiting-approval')
    expect(result.status).toBe('partial')
  })

  test('Given Agent 新建合法可达节点 When 当前批次完成 Then fresh-read 原根并继续新增节点', async () => {
    const root = createNode('root', 'agent')
    const added = createNode('added', 'agent')
    const initial = createDocument([root])
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture(initial, {
      onAgentStart: async (nodeId) => {
        if (nodeId !== 'root') return
        const next = createDocument([root, added], [[root, added]])
        next.revision = 4
        fixture.setDocument(next)
      },
    })

    const result = await fixture.service.execute(context, fixture.input, 'tool-1')

    expect(fixture.agentStarts).toEqual(['root', 'added'])
    expect(result.nodes.map((node) => node.nodeId)).toEqual(['root', 'added'])
  })

  test('Given 父 Agent 在子 Agent 运行中取消 When 终止 Then 只取消本次待执行节点并释放锁', async () => {
    const root = createNode('root', 'agent')
    const controller = new AbortController()
    const fixture = createFixture(createDocument([root]), {
      onAgentStart: async (_nodeId, signal) => new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true })
      }),
    })
    const running = fixture.service.execute(context, fixture.input, 'tool-1', controller.signal)
    await Promise.resolve()
    controller.abort()

    const result = await running

    expect(result.status).toBe('cancelled')
    expect(result.errorCode).toBe('CANVAS_WORKFLOW_CANCELLED')
    expect(result.nodes).toEqual([{ nodeId: 'root', status: 'cancelled', errorCode: null }])
  })

  test('Given 图片批次等待中父 Agent 取消 When 终止 Then 只取消本工作流返回的任务身份', async () => {
    const root = createNode('root', 'agent')
    const image = createNode('image', 'image')
    const controller = new AbortController()
    const fixture = createFixture(createDocument([root, image], [[root, image]]), {
      onImageWait: async (signal) => new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      }),
    })
    const running = fixture.service.execute(context, fixture.input, 'tool-1', controller.signal)
    while (fixture.imageWaits.length === 0) await Promise.resolve()
    controller.abort()

    const result = await running

    expect(result.status).toBe('cancelled')
    expect(fixture.imageCancels).toEqual([['task-0']])
  })

  test('Given 十五分钟 deadline 在子 Agent 运行中到达 When 终止 Then 返回超时且停止后续节点', async () => {
    const root = createNode('root', 'agent')
    const fixture = createFixture(createDocument([root]), {
      onAgentStart: async (_nodeId, signal) => new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true })
      }),
    })
    const running = fixture.service.execute(context, fixture.input, 'tool-1')
    while (fixture.agentStarts.length === 0) await Promise.resolve()
    fixture.triggerDeadline()

    const result = await running

    expect(result.status).toBe('cancelled')
    expect(result.errorCode).toBe('CANVAS_WORKFLOW_TIMEOUT')
  })

  test('Given Agent 动态新增图片超过本次授权 When 重算 Then 超额节点等待审批且只运行许可数量', async () => {
    const root = createNode('root', 'agent')
    const imageA = createNode('image-a', 'image')
    const imageB = createNode('image-b', 'image')
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture(createDocument([root]), {
      onAgentStart: async () => {
        const next = createDocument([root, imageA, imageB], [[root, imageA], [root, imageB]])
        next.revision = 4
        fixture.setDocument(next)
      },
    })
    fixture.input.maxImageRuns = 1

    const result = await fixture.service.execute(context, fixture.input, 'tool-1')

    expect(fixture.imageRuns).toEqual([['image-a']])
    expect(result.nodes.find((node) => node.nodeId === 'image-b')?.status).toBe('waiting-approval')
    expect(result.status).toBe('partial')
    expect(result.requiresReview).toBe(true)
  })

  test('Given 运行中替换已执行根身份 When fresh-read Then 停止扩张并返回稳定图变化', async () => {
    const root = createNode('root', 'agent')
    if (root.kind !== 'agent') throw new Error('TEST_AGENT_REQUIRED')
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture(createDocument([root]), {
      onAgentStart: async () => {
        const replacement = { ...root, agentSessionId: 'replacement-session' }
        const next = createDocument([replacement])
        next.revision = 4
        fixture.setDocument(next)
      },
    })

    const result = await fixture.service.execute(context, fixture.input, 'tool-1')

    expect(result.status).toBe('partial')
    expect(result.errorCode).toBe('CANVAS_WORKFLOW_GRAPH_CHANGED')
    expect(fixture.agentStarts).toEqual(['root'])
  })

  test('Given 首次运行失败释放 active lock When 再次运行 Then 同 Canvas 可重新执行', async () => {
    const root = createNode('root', 'agent')
    const fixture = createFixture(createDocument([root]), { busyNodeIds: ['root'] })
    await expect(fixture.service.execute(context, fixture.input, 'tool-1')).rejects.toThrow('SESSION_BUSY')
    await expect(fixture.service.execute(context, fixture.input, 'tool-2')).rejects.toThrow('SESSION_BUSY')
  })
})
