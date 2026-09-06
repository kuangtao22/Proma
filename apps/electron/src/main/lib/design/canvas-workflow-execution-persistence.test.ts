import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvasBoundEdge, createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasDocument, CanvasNode, CanvasWorkflowRunChangedEvent } from '@proma/shared'
import { createCanvasWorkflowExecutionService } from './canvas-workflow-execution-service'
import { createCanvasWorkflowRunStore } from './canvas-workflow-run-store'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建 Agent、图片、Agent 的固定生产链。 */
function createDocument(): CanvasDocument {
  const root: CanvasNode = {
    id: 'root', title: 'root', position: { x: 0, y: 0 }, kind: 'agent', agentSessionId: 'agent-root',
  }
  const image: CanvasNode = {
    id: 'image', title: 'image', position: { x: 10, y: 0 }, kind: 'image', imageModuleId: 'image-module',
  }
  const finisher: CanvasNode = {
    id: 'finisher', title: 'finisher', position: { x: 20, y: 0 }, kind: 'agent', agentSessionId: 'agent-finisher',
  }
  return {
    ...createEmptyCanvasDocument('project-1', 'canvas-1', 1),
    revision: 3,
    nodes: [root, image, finisher],
    edges: [
      createCanvasBoundEdge(root, image, {
        id: 'edge-root-image', sourceNodeId: root.id, targetNodeId: image.id, relation: 'depends-on',
      }),
      createCanvasBoundEdge(image, finisher, {
        id: 'edge-image-finisher', sourceNodeId: image.id, targetNodeId: finisher.id, relation: 'depends-on',
      }),
    ],
  }
}

/** 为恢复回归构造 Agent 身份哈希，与生产执行身份算法保持一致。 */
function createAgentIdentityHash(sessionId: string): string {
  return createHash('sha256').update(JSON.stringify(`agent\0${sessionId}`)).digest('hex')
}

/** 创建一个根 Agent 已进入 running、下游 Agent 尚未启动的持久工作流。 */
function createAgentRecoveryFixture() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'proma-workflow-agent-recovery-'))
  temporaryRoots.push(temporaryRoot)
  const transactionsDir = join(temporaryRoot, 'transactions')
  mkdirSync(transactionsDir, { recursive: true })
  const workflowRuns = createCanvasWorkflowRunStore({
    pathResolver: { resolveCanvas: () => ({ transactionsDir }) as never },
    runWorkspaceWrite: (_projectId, effect) => effect(),
    now: () => 20,
  })
  const originalPointer = {
    messageUuid: '11111111-1111-4111-8111-111111111111',
    contentSha256: 'a'.repeat(64),
    completedAt: 15,
  }
  const root: Extract<CanvasNode, { kind: 'agent' }> = {
    id: 'root', title: 'root', position: { x: 0, y: 0 }, kind: 'agent',
    agentSessionId: 'agent-root', outputPointer: originalPointer,
  }
  const downstream: Extract<CanvasNode, { kind: 'agent' }> = {
    id: 'downstream', title: 'downstream', position: { x: 10, y: 0 }, kind: 'agent',
    agentSessionId: 'agent-downstream',
  }
  const edge = createCanvasBoundEdge(root, downstream, {
    id: 'edge-root-downstream', sourceNodeId: root.id, targetNodeId: downstream.id, relation: 'depends-on',
  })
  let document: CanvasDocument = {
    ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3,
    nodes: [root, downstream], edges: [edge],
  }
  const run = workflowRuns.create({
    projectId: 'project-1', canvasId: 'canvas-1', operationId: 'workflow-anchor',
    owner: { sessionId: 'parent-session', runStartedAt: 10 }, initialCanvasRevision: 3,
    rootNodeIds: ['root'], goal: '恢复后继续', maxMediaRuns: 0, consumedMediaRuns: 0,
    autoResumeAfterAdoption: false,
    nodes: [{
      nodeId: 'root', kind: 'agent', identityHash: createAgentIdentityHash(root.agentSessionId),
      plannedArtifactHash: null, mediaConfigRevision: null, inputBindings: [], dependencyNodeIds: [],
      status: 'running', errorCode: null,
      execution: { kind: 'agent', operationId: 'workflow-agent-root' },
      completedArtifactHash: null, completedAt: null,
    }, {
      nodeId: 'downstream', kind: 'agent', identityHash: createAgentIdentityHash(downstream.agentSessionId),
      plannedArtifactHash: null, mediaConfigRevision: null,
      inputBindings: [{
        targetInputKey: `${edge.targetPort}:${edge.id}`, requiredKind: 'text',
        sourceNodeId: root.id, sourceOutputKey: edge.sourcePort,
        sourceArtifactHash: null, resolvedValueHash: null,
      }],
      dependencyNodeIds: ['root'], status: 'ready', errorCode: null, execution: null,
      completedArtifactHash: null, completedAt: null,
    }],
  })
  const context = {
    projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 30,
    explicitReferences: [], permissionCeiling: 'execute' as const,
  }
  return {
    context,
    originalPointer,
    run,
    workflowRuns,
    getDocument: () => document,
    setDocument: (next: CanvasDocument) => { document = next },
  }
}

describe('Canvas Workflow Execution Persistence', () => {
  test('Given 图片候选暂停后服务重建 When 用户明确恢复且候选已采用 Then 不重跑已完成节点', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'proma-workflow-execution-'))
    temporaryRoots.push(temporaryRoot)
    const transactionsDir = join(temporaryRoot, 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: { resolveCanvas: () => ({ transactionsDir }) as never },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: (() => { let value = 100; return () => value += 1 })(),
    })
    let document = createDocument()
    const agentStarts: string[] = []
    let imageStarts = 0
    let adopted = false
    const changedEvents: Array<{ runId: string; revision: number }> = []
    const dependencies = {
      load: () => structuredClone(document),
      validateAccess: () => undefined,
      isAgentBusy: () => false,
      agentExecution: {
        execute: async (request: { target: { nodeId: string } }) => {
          agentStarts.push(request.target.nodeId)
          const contentSha256 = request.target.nodeId === 'root' ? 'a'.repeat(64) : 'b'.repeat(64)
          document = {
            ...document,
            revision: document.revision + 1,
            nodes: document.nodes.map((node) => node.id === request.target.nodeId && node.kind === 'agent'
              ? { ...node, outputPointer: {
                messageUuid: request.target.nodeId === 'root'
                  ? '11111111-1111-4111-8111-111111111111'
                  : '22222222-2222-4222-8222-222222222222',
                contentSha256, completedAt: 20,
              } }
              : node),
          }
          return {
            status: 'completed' as const,
            output: {
              target: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: request.target.nodeId },
              revision: document.revision,
              pointer: {
                messageUuid: request.target.nodeId === 'root'
                  ? '11111111-1111-4111-8111-111111111111'
                  : '22222222-2222-4222-8222-222222222222',
                contentSha256, completedAt: 20,
              },
              downstreamNodeIds: [],
            },
          }
        },
      },
      imageRuns: {
        run: async () => {
          imageStarts += 1
          return {
            tasks: [{ nodeId: 'image', status: 'started' as const, taskId: 'task-1' }],
            batch: {
              batchId: 'batch-1', status: 'running' as const, totalCount: 1,
              candidateCount: 0, failedCount: 0, runningCount: 1, requiresCanvasReview: true as const,
            },
          }
        },
        awaitBatch: async () => ({
          batchId: 'batch-1', status: 'ready' as const, totalCount: 1,
          candidateCount: 1, failedCount: 0, runningCount: 0, requiresCanvasReview: true as const,
          entries: [{ nodeId: 'image', taskId: 'task-1', status: 'candidate' as const }],
        }),
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      onRunChanged: (event: CanvasWorkflowRunChangedEvent) => {
        changedEvents.push({ runId: event.runId, revision: event.revision })
      },
      isImageCandidateAdopted: async () => ({
        adopted,
        artifactHash: adopted ? 'c'.repeat(64) : null,
        committedAt: adopted ? 40 : null,
      }),
      now: () => 50,
      setDeadline: () => ({ cancel: () => undefined }),
    }
    const context = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    const firstService = createCanvasWorkflowExecutionService(dependencies)
    const first = await firstService.execute(context, {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['root'],
      goal: '完成主视觉', maxImageRuns: 1,
    }, 'tool-call-1')
    const waitingRun = firstService.list
      ? (await firstService.list(context, 'canvas-1')).runs[0]!
      : null
    expect(first.status).toBe('waiting-review')
    expect(waitingRun?.nodes.find((node) => node.nodeId === 'image')?.execution).toEqual({
      kind: 'image', operationId: expect.any(String), batchId: 'batch-1', taskId: 'task-1',
    })

    /** 纯布局与 viewport revision 变化不改变固定业务节点和正式输入。 */
    document = {
      ...document,
      revision: document.revision + 1,
      viewport: { x: 200, y: 100, zoom: 0.8 },
      nodes: document.nodes.map((node) => ({
        ...node,
        position: { x: node.position.x + 100, y: node.position.y + 50 },
      })),
    }
    adopted = true
    const secondService = createCanvasWorkflowExecutionService(dependencies)
    const nextRunContext = { ...context, runStartedAt: 99 }
    const resumed = await secondService.resume!(nextRunContext, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: waitingRun!.id,
    })

    expect(resumed.status).toBe('completed')
    expect(resumed.runId).toBe(waitingRun!.id)
    expect((await secondService.get(nextRunContext, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: waitingRun!.id,
    })).owner).toEqual({ sessionId: 'parent-session', runStartedAt: 10 })
    expect(agentStarts).toEqual(['root', 'finisher'])
    expect(imageStarts).toBe(1)
    expect(changedEvents[0]).toEqual({ runId: waitingRun!.id, revision: 0 })
    expect(changedEvents.at(-1)).toEqual({
      runId: waitingRun!.id,
      revision: (await secondService.get(nextRunContext, {
        projectId: 'project-1', canvasId: 'canvas-1', runId: waitingRun!.id,
      })).revision,
    })
  })

  test('Given 其它普通 Agent When 读取或恢复旧工作流 Then 拒绝跨 session 访问', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'proma-workflow-owner-'))
    temporaryRoots.push(temporaryRoot)
    const transactionsDir = join(temporaryRoot, 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: { resolveCanvas: () => ({ transactionsDir }) as never },
      runWorkspaceWrite: (_projectId, effect) => effect(),
    })
    const run = workflowRuns.create({
      projectId: 'project-1', canvasId: 'canvas-1', operationId: 'owner-operation',
      owner: { sessionId: 'parent-session', runStartedAt: 10 }, initialCanvasRevision: 3,
      rootNodeIds: ['root'], goal: '执行', maxMediaRuns: 0, consumedMediaRuns: 0,
      autoResumeAfterAdoption: false,
      nodes: [{
        nodeId: 'root', kind: 'agent', identityHash: 'a'.repeat(64), plannedArtifactHash: null,
        mediaConfigRevision: null, inputBindings: [], dependencyNodeIds: [], status: 'ready',
        errorCode: null, execution: null, completedArtifactHash: null, completedAt: null,
      }],
    })
    const service = createCanvasWorkflowExecutionService({
      load: () => createEmptyCanvasDocument('project-1', 'canvas-1', 3),
      validateAccess: () => undefined,
      isAgentBusy: () => false,
      agentExecution: { execute: async () => ({ status: 'errored' as const }) },
      imageRuns: {
        run: async () => ({ tasks: [] }),
        awaitBatch: async () => { throw new Error('TEST_UNEXPECTED') },
      },
      workflowRuns,
    })
    const otherSession = {
      projectId: 'project-1', sessionId: 'other-session', runStartedAt: 99,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    const runTarget = { projectId: 'project-1', canvasId: 'canvas-1', runId: run.id }
    await expect(service.get(otherSession, runTarget))
      .rejects.toThrow('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
    await expect(service.resume(otherSession, runTarget))
      .rejects.toThrow('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
    expect((await service.list(otherSession, 'canvas-1')).runs).toEqual([])
  })

  test('Given 不同父运行复用相同 toolCallId When 分别执行 Then 各自创建独立 run', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'proma-workflow-owner-namespace-'))
    temporaryRoots.push(temporaryRoot)
    const transactionsDir = join(temporaryRoot, 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: { resolveCanvas: () => ({ transactionsDir }) as never },
      runWorkspaceWrite: (_projectId, effect) => effect(),
    })
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1),
      revision: 3,
      nodes: [{
        id: 'root', title: 'root', position: { x: 0, y: 0 }, kind: 'agent', agentSessionId: 'agent-root',
      }],
    }
    const service = createCanvasWorkflowExecutionService({
      load: () => document,
      validateAccess: () => undefined,
      isAgentBusy: () => false,
      agentExecution: { execute: async () => ({ status: 'errored' as const }) },
      imageRuns: {
        run: async () => ({ tasks: [] }),
        awaitBatch: async () => { throw new Error('TEST_UNEXPECTED') },
      },
      workflowRuns,
      setDeadline: () => ({ cancel: () => undefined }),
    })
    const firstContext = {
      projectId: 'project-1', sessionId: 'parent-session-1', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }
    const secondContext = {
      ...firstContext, runStartedAt: 20,
    }
    const input = {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['root'], goal: '执行', maxImageRuns: 0,
    }

    const first = await service.execute(firstContext, input, 'shared-tool-call')
    const second = await service.execute(secondContext, input, 'shared-tool-call')

    expect(second.runId).not.toBe(first.runId)
    expect((await service.get(firstContext, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: first.runId!,
    })).owner).toEqual({ sessionId: 'parent-session-1', runStartedAt: 10 })
    expect((await service.get(secondContext, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: second.runId!,
    })).owner).toEqual({ sessionId: 'parent-session-1', runStartedAt: 20 })
  })

  test('Given running journal 的原输出已被覆盖 When 恢复 Then 标记需重规划且不启动下游', async () => {
    const fixture = createAgentRecoveryFixture()
    let downstreamStarts = 0
    const service = createCanvasWorkflowExecutionService({
      load: fixture.getDocument,
      validateAccess: () => undefined,
      isAgentBusy: () => false,
      agentExecution: { execute: async () => {
        downstreamStarts += 1
        return { status: 'errored' as const }
      } },
      recoverAgentExecution: async () => ({ status: 'changed' as const }),
      imageRuns: {
        run: async () => ({ tasks: [] }),
        awaitBatch: async () => { throw new Error('TEST_UNEXPECTED') },
      },
      workflowRuns: fixture.workflowRuns,
      setDeadline: () => ({ cancel: () => undefined }),
    })

    await expect(service.resume(fixture.context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: fixture.run.id,
    })).rejects.toThrow('CANVAS_WORKFLOW_OUTPUT_CHANGED')

    const persisted = fixture.workflowRuns.get(fixture.run, fixture.run.id)
    expect(downstreamStarts).toBe(0)
    expect(persisted.status).toBe('partial')
    expect(persisted.nodes.find((node) => node.nodeId === 'root')).toMatchObject({
      status: 'failed', errorCode: 'CANVAS_WORKFLOW_OUTPUT_CHANGED',
      completedArtifactHash: null, completedAt: null,
    })
    const reviewable = await service.resume(fixture.context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: fixture.run.id,
    })
    expect(reviewable.status).toBe('partial')
    expect(reviewable.nodes.find((node) => node.nodeId === 'root')).toEqual({
      nodeId: 'root', status: 'failed', errorCode: 'CANVAS_WORKFLOW_OUTPUT_CHANGED',
    })
    expect(downstreamStarts).toBe(0)
  })

  test('Given recovery 回调返回后原输出才被覆盖 When fresh 校验 Then 标记需重规划且不启动下游', async () => {
    const fixture = createAgentRecoveryFixture()
    let downstreamStarts = 0
    const service = createCanvasWorkflowExecutionService({
      load: fixture.getDocument,
      validateAccess: () => undefined,
      isAgentBusy: () => false,
      agentExecution: { execute: async () => {
        downstreamStarts += 1
        return { status: 'errored' as const }
      } },
      recoverAgentExecution: async () => {
        const current = fixture.getDocument()
        fixture.setDocument({
          ...current,
          revision: current.revision + 1,
          nodes: current.nodes.map((node) => node.id === 'root' && node.kind === 'agent'
            ? { ...node, outputPointer: {
              messageUuid: '22222222-2222-4222-8222-222222222222',
              contentSha256: 'b'.repeat(64), completedAt: 25,
            } }
            : node),
        })
        return {
          status: 'completed' as const,
          output: {
            target: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'root' },
            revision: current.revision,
            pointer: fixture.originalPointer,
            downstreamNodeIds: [],
          },
        }
      },
      imageRuns: {
        run: async () => ({ tasks: [] }),
        awaitBatch: async () => { throw new Error('TEST_UNEXPECTED') },
      },
      workflowRuns: fixture.workflowRuns,
      setDeadline: () => ({ cancel: () => undefined }),
    })

    await expect(service.resume(fixture.context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: fixture.run.id,
    })).rejects.toThrow('CANVAS_WORKFLOW_OUTPUT_CHANGED')

    const persisted = fixture.workflowRuns.get(fixture.run, fixture.run.id)
    expect(downstreamStarts).toBe(0)
    expect(persisted.status).toBe('partial')
    expect(persisted.nodes.find((node) => node.nodeId === 'root')).toMatchObject({
      status: 'failed', errorCode: 'CANVAS_WORKFLOW_OUTPUT_CHANGED',
      completedArtifactHash: null, completedAt: null,
    })
  })

  test('Given 两个服务同时恢复同一 ready run When CAS 竞争 Then 子节点只启动一次', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'proma-workflow-cas-'))
    temporaryRoots.push(temporaryRoot)
    const transactionsDir = join(temporaryRoot, 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: { resolveCanvas: () => ({ transactionsDir }) as never },
      runWorkspaceWrite: (_projectId, effect) => effect(),
    })
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3,
      nodes: [{ id: 'root', title: 'root', position: { x: 0, y: 0 }, kind: 'agent', agentSessionId: 'agent-root' }],
    }
    let starts = 0
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const dependencies = {
      load: () => document,
      validateAccess: () => undefined,
      isAgentBusy: () => false,
      agentExecution: { execute: async () => {
        starts += 1
        await gate
        return { status: 'errored' as const }
      } },
      imageRuns: {
        run: async () => ({ tasks: [] }),
        awaitBatch: async () => { throw new Error('TEST_UNEXPECTED') },
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      now: () => 20,
      setDeadline: () => ({ cancel: () => undefined }),
    }
    const context = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }
    const serviceA = createCanvasWorkflowExecutionService(dependencies)
    const running = serviceA.execute(context, {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['root'], goal: '执行', maxImageRuns: 0,
    }, 'tool-call-cas')
    while (starts === 0) await Promise.resolve()
    const run = (await serviceA.list!(context, 'canvas-1')).runs[0]!
    const serviceB = createCanvasWorkflowExecutionService(dependencies)
    const duplicate = await serviceB.resume!(context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: run.id,
    })
    release()
    await running

    expect(starts).toBe(1)
    expect(duplicate.nodes.find((node) => node.nodeId === 'root')?.status).toBe('blocked')
  })

  test('Given 图片候选已经生成 When owner 取消且采用事实迟到 Then 保留批次但运行不复活', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'proma-workflow-cancelled-adoption-'))
    temporaryRoots.push(temporaryRoot)
    const transactionsDir = join(temporaryRoot, 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: { resolveCanvas: () => ({ transactionsDir }) as never },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: () => 20,
    })
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3,
      nodes: [{
        id: 'image', title: 'image', position: { x: 0, y: 0 }, kind: 'image', imageModuleId: 'image-module',
      }],
    }
    const created = workflowRuns.create({
      projectId: 'project-1', canvasId: 'canvas-1', operationId: 'tool-call-cancelled',
      owner: { sessionId: 'parent-session', runStartedAt: 10 }, initialCanvasRevision: 3,
      rootNodeIds: ['image'], goal: '生成图片', maxMediaRuns: 1, consumedMediaRuns: 1,
      autoResumeAfterAdoption: false,
      nodes: [{
        nodeId: 'image', kind: 'image',
        identityHash: '9ec11819192375b62473bb51e5afaf56ccf835b11ed1bb468701b8232f6b1760',
        plannedArtifactHash: null, mediaConfigRevision: null, inputBindings: [], dependencyNodeIds: [],
        status: 'waiting-adoption', errorCode: null,
        execution: { kind: 'image', operationId: 'image-operation', batchId: 'batch-1', taskId: 'task-1' },
        completedArtifactHash: null, completedAt: null,
      }],
    })
    let starts = 0
    const service = createCanvasWorkflowExecutionService({
      load: () => document,
      validateAccess: () => undefined,
      isAgentBusy: () => false,
      agentExecution: { execute: async () => { starts += 1; return { status: 'errored' as const } } },
      imageRuns: {
        run: async () => { starts += 1; return { tasks: [] } },
        awaitBatch: async () => { throw new Error('TEST_UNEXPECTED') },
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      isImageCandidateAdopted: async () => ({
        adopted: true, artifactHash: 'c'.repeat(64), committedAt: 30,
      }),
      now: () => 30,
      setDeadline: () => ({ cancel: () => undefined }),
    })
    const context = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    const cancelled = await service.cancel(context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: created.id,
    })
    const resumed = await service.resume(context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: created.id,
    })

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.nodes[0]?.execution).toMatchObject({ batchId: 'batch-1', taskId: 'task-1' })
    expect(resumed.status).toBe('cancelled')
    expect(starts).toBe(0)
  })
})
