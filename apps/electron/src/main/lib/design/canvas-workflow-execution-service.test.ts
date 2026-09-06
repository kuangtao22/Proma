import { describe, expect, test } from 'bun:test'
import { createCanvasBoundEdge, createEmptyCanvasDocument } from '@proma/shared'
import type {
  CanvasImageCandidateBatch,
  CanvasImageModuleConfig,
  CanvasDocument,
  CanvasNode,
  CanvasRunNodesResult,
  CanvasRunWorkflowInput,
  CreateDesignJobInput,
  DesignJobRecord,
} from '@proma/shared'
import type { CanvasAgentExecutionResult } from './canvas-agent-execution-service'
import {
  createCanvasImageCandidateBatchService,
  type CanvasImageCandidateBatchService,
} from './canvas-image-candidate-batch-service'
import type {
  CanvasImageCandidateAdoptionIntent,
  CanvasImageCandidateBatchStore,
} from './canvas-image-candidate-batch-store'
import { createCanvasDependencyStateService } from './canvas-dependency-state-service'
import {
  createCanvasImageRunService,
  type CanvasImageRunService,
} from './canvas-image-run-service'
import type { DesignJobChangedListener } from './design-job-manager'
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

/** 创建真实候选批次服务与图片运行服务组合，持久层保持严格内存语义。 */
function createRealImageRunHarness(options: { completeOnStart?: boolean } = {}): {
  service: CanvasImageRunService
  batches: Map<string, CanvasImageCandidateBatch>
  jobs: Map<string, DesignJobRecord>
  startedJobIds: string[]
  cancelledJobIds: string[]
} {
  const batches = new Map<string, CanvasImageCandidateBatch>()
  const jobs = new Map<string, DesignJobRecord>()
  const jobListeners = new Set<DesignJobChangedListener>()
  const adoptionIntents = new Map<string, CanvasImageCandidateAdoptionIntent>()
  const startedJobIds: string[] = []
  const cancelledJobIds: string[] = []
  let timestamp = 10
  const store: CanvasImageCandidateBatchStore = {
    listActiveSummaries: async () => [],
    load: async (_target, batchId) => {
      const batch = batches.get(batchId)
      if (!batch) throw new Error('CANVAS_IMAGE_BATCH_NOT_FOUND')
      return structuredClone(batch)
    },
    save: async (batch) => {
      batches.set(batch.batchId, structuredClone(batch))
      return structuredClone(batch)
    },
    findByJobId: async (_target, jobId, candidateBatchId) => {
      if (candidateBatchId) {
        const batch = batches.get(candidateBatchId)
        return batch?.entries.some((entry) => entry.jobId === jobId) ? structuredClone(batch) : null
      }
      const batch = [...batches.values()].find((candidate) => (
        candidate.entries.some((entry) => entry.jobId === jobId)
      ))
      return batch ? structuredClone(batch) : null
    },
    scanAdoptionIntents: async () => [...adoptionIntents.values()].map((intent) => structuredClone(intent)),
    loadAdoptionIntent: async (_target, operationId) => {
      const intent = adoptionIntents.get(operationId)
      if (!intent) throw new Error('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_NOT_FOUND')
      return structuredClone(intent)
    },
    saveAdoptionIntent: async (intent) => {
      adoptionIntents.set(intent.operationId, structuredClone(intent))
      return structuredClone(intent)
    },
  }
  let candidateService: CanvasImageCandidateBatchService
  candidateService = createCanvasImageCandidateBatchService({
    store,
    dependencyState: createCanvasDependencyStateService(),
    runExclusive: async (_target, effect) => effect(),
    loadConfig: async () => { throw new Error('TEST_UNUSED_LOAD_CONFIG') },
    adoptAsset: async () => { throw new Error('TEST_UNUSED_ADOPT_ASSET') },
    loadCanvas: async (canvasTarget) => createEmptyCanvasDocument(canvasTarget.projectId, canvasTarget.canvasId, 1),
    applyCanvasProjection: async (canvasTarget, expectedRevision, nodes) => ({
      ...createEmptyCanvasDocument(canvasTarget.projectId, canvasTarget.canvasId, 1),
      revision: expectedRevision + 1,
      nodes: [...nodes],
    }),
    retryEntry: async () => { throw new Error('TEST_UNUSED_RETRY_ENTRY') },
    now: () => {
      timestamp += 1
      return timestamp
    },
  })
  const service = createCanvasImageRunService({
    serializer: { run: async (_target, effect) => effect() },
    guard: { runWorkspaceWrite: async (_projectId, effect) => effect() },
    imageModules: {
      load: async (imageTarget): Promise<CanvasImageModuleConfig> => ({
        schemaVersion: 2,
        kind: 'image',
        contentId: imageTarget.imageModuleId,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        prompt: `prompt-${imageTarget.nodeId}`,
        selectedModelProfileId: 'profile-1',
        aspectRatio: '1:1',
        imageSize: '1K',
        contextMode: 'none',
        adoptedAssetId: null,
      }),
    },
    imageJobs: {
      preflightCanvasImage: async () => undefined,
      createCanvasImageOnce: async (input: CreateDesignJobInput, jobId: string) => {
        const existing = jobs.get(jobId)
        if (existing) return { job: structuredClone(existing), created: false }
        if (input.target?.kind !== 'canvas-image') throw new Error('TEST_IMAGE_TARGET_REQUIRED')
        const job: DesignJobRecord = {
          id: jobId,
          projectId: input.projectId,
          creativeTaskId: `creative-${jobId}`,
          attemptNumber: 1,
          action: input.action,
          status: 'queued',
          prompt: input.prompt,
          originalRequest: input.prompt,
          contextMode: input.contextMode,
          target: input.target,
          canvasImageConfigRevision: input.canvasImageConfigRevision,
          candidateBatchId: input.candidateBatchId,
          imageModelSnapshot: {
            profileId: input.imageModelProfileId ?? 'profile-1',
            modelId: 'model-1',
            name: '测试模型',
            executor: 'nano-banana',
          },
          generationConstraints: input.generationConstraints,
          createdAt: 1,
          updatedAt: 1,
        }
        jobs.set(jobId, job)
        return { job: structuredClone(job), created: true }
      },
      rollbackCanvasImageOnce: async (_projectId, jobId) => jobs.delete(jobId),
      start: async (jobId) => {
        startedJobIds.push(jobId)
        const job = jobs.get(jobId)
        if (!job || job.target?.kind !== 'canvas-image' || !job.candidateBatchId) {
          throw new Error('TEST_JOB_NOT_FOUND')
        }
        if (options.completeOnStart === false) {
          jobs.set(jobId, { ...job, status: 'running', updatedAt: 2 })
          return
        }
        const completed: DesignJobRecord = {
          ...job,
          status: 'succeeded',
          outputAssetId: `asset-${job.target.nodeId}`,
          updatedAt: 2,
        }
        jobs.set(jobId, completed)
        await candidateService.recordJobTerminal({
          projectId: completed.projectId,
          canvasId: job.target.canvasId,
          jobId,
          candidateBatchId: job.candidateBatchId,
          status: 'succeeded',
          outputAssetId: completed.outputAssetId ?? null,
          error: null,
        })
      },
      cancel: async (_projectId, jobId) => {
        const job = jobs.get(jobId)
        if (!job) throw new Error('TEST_JOB_NOT_FOUND')
        cancelledJobIds.push(jobId)
        const cancelled = { ...job, status: 'cancelled' as const }
        jobs.set(jobId, cancelled)
        return cancelled
      },
      getProjectJob: (projectId, jobId) => {
        const job = jobs.get(jobId)
        return job?.projectId === projectId ? structuredClone(job) : undefined
      },
      onChanged: (listener) => {
        jobListeners.add(listener)
        return () => { jobListeners.delete(listener) }
      },
    },
    candidateBatches: candidateService,
    getProjectReadOnlyReason: () => undefined,
  })
  return { service, batches, jobs, startedJobIds, cancelledJobIds }
}

/** 构造可观察 Agent、图片和 fresh-read 行为的调度夹具。 */
function createFixture(document: CanvasDocument, options: {
  busyNodeIds?: string[]
  failNodeIds?: string[]
  agentErrorByNodeId?: Record<string, Error>
  imageResult?: CanvasRunNodesResult
  imageTerminalStatus?: 'ready' | 'partial'
  imageTerminalEntries?: Array<{
    nodeId: string
    taskId: string
    status: 'candidate' | 'failed' | 'invalid'
  }>
  onAgentStart?: (nodeId: string, signal?: AbortSignal) => Promise<void>
  onLoad?: (callCount: number) => Promise<void>
  onValidateAccess?: (callCount: number) => Promise<void>
  imageRunService?: Pick<CanvasImageRunService, 'run' | 'awaitBatch'>
  onImageRun?: (signal: AbortSignal, deadlineAt: number) => Promise<void>
  onImageWait?: (signal: AbortSignal) => Promise<void>
  imageWaitError?: Error
  now?: () => number
} = {}) {
  let current = structuredClone(document)
  const agentStarts: string[] = []
  const imageRuns: string[][] = []
  const imageWaits: string[][] = []
  let activeAgents = 0
  let maxActiveAgents = 0
  let loadCalls = 0
  let validateAccessCalls = 0
  let deadlineCallback = (): void => undefined
  const imageNodesByBatchId = new Map<string, string[]>()
  const dependencies: CanvasWorkflowExecutionServiceDependencies = {
    load: async () => {
      loadCalls += 1
      await options.onLoad?.(loadCalls)
      return structuredClone(current)
    },
    validateAccess: async () => {
      validateAccessCalls += 1
      await options.onValidateAccess?.(validateAccessCalls)
    },
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
        const agentError = options.agentErrorByNodeId?.[request.target.nodeId]
        if (agentError) throw agentError
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
    imageRuns: options.imageRunService ?? {
      run: async (_context, _target, nodes, _operationId, runOptions) => {
        if (!runOptions) throw new Error('TEST_IMAGE_RUN_OPTIONS_REQUIRED')
        imageRuns.push(nodes.map((node) => node.id))
        const batchId = `batch-${imageRuns.length}`
        imageNodesByBatchId.set(batchId, nodes.map((node) => node.id))
        await options.onImageRun?.(runOptions.signal, runOptions.deadlineAt)
        if (runOptions.signal.aborted) throw new Error('CANVAS_IMAGE_RUN_ABORTED')
        return options.imageResult ?? {
          tasks: nodes.map((node, index) => ({ nodeId: node.id, status: 'started', taskId: `task-${index}` })),
          batch: {
            batchId, status: 'running', totalCount: nodes.length,
            candidateCount: 0, failedCount: 0, runningCount: nodes.length, requiresCanvasReview: true,
          },
        }
      },
      awaitBatch: async (input) => {
        imageWaits.push([...input.taskIds])
        await options.onImageWait?.(input.signal)
        if (options.imageWaitError) throw options.imageWaitError
        if (input.signal.aborted) throw new Error('CANVAS_IMAGE_BATCH_ABORTED')
        /** 单节点子批按自身节点筛选定制终态，避免并发等待互相串批。 */
        const entries = options.imageTerminalEntries?.filter((entry) => (
          imageNodesByBatchId.get(input.batchId)?.includes(entry.nodeId)
        )) ?? input.taskIds.map((taskId, index) => ({
          nodeId: imageNodesByBatchId.get(input.batchId)?.[index] ?? `image-${index}`,
          taskId,
          status: 'candidate' as const,
        }))
        return {
          batchId: input.batchId,
          status: options.imageTerminalStatus ?? 'ready',
          totalCount: entries.length,
          candidateCount: entries.filter((entry) => entry.status === 'candidate').length,
          failedCount: entries.filter((entry) => entry.status !== 'candidate').length,
          runningCount: 0,
          requiresCanvasReview: true,
          entries,
        }
      },
    },
    now: options.now ?? (() => 1_000),
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
    maxActiveAgents: () => maxActiveAgents,
    loadCalls: () => loadCalls,
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

  test('Given 原 satisfied 下游被 Agent 提交标记过期 When fresh plan Then 重建为可执行并运行', async () => {
    const root = createNode('root', 'agent')
    const downstream = createNode('downstream', 'agent')
    if (downstream.kind !== 'agent') throw new Error('TEST_AGENT_REQUIRED')
    downstream.outputPointer = {
      messageUuid: '11111111-1111-4111-8111-111111111111',
      contentSha256: 'a'.repeat(64),
      completedAt: 1,
    }
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture(createDocument([root, downstream], [[root, downstream]]), {
      onAgentStart: async (nodeId) => {
        if (nodeId !== 'root') return
        const staleDownstream = { ...downstream, upstreamChange: { sourceNodeIds: ['root'], changedAt: 2 } }
        const next = createDocument([root, staleDownstream], [[root, staleDownstream]])
        next.revision = 4
        fixture.setDocument(next)
      },
    })

    const result = await fixture.service.execute(context, fixture.input, 'tool-fresh-state')

    expect(fixture.agentStarts).toEqual(['root', 'downstream'])
    expect(result.nodes.find((node) => node.nodeId === 'downstream')?.status).toBe('completed')
  })

  test('Given 三个同层 Agent 的后一个在首批运行时断开 When 重规划 Then 不启动旧 ready 列表后项', async () => {
    const root = createNode('root', 'agent')
    const hub = createNode('hub', 'document')
    const agentA = createNode('agent-a', 'agent', true)
    const agentB = createNode('agent-b', 'agent', true)
    const agentC = createNode('agent-c', 'agent', true)
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture(createDocument(
      [root, hub, agentA, agentB, agentC],
      [[root, hub], [hub, agentA], [hub, agentB], [hub, agentC]],
    ), {
      onAgentStart: async (nodeId) => {
        if (nodeId !== 'agent-a') return
        const next = createDocument(
          [root, hub, agentA, agentB, agentC],
          [[root, hub], [hub, agentA], [hub, agentB]],
        )
        next.revision = 7
        fixture.setDocument(next)
      },
    })

    const result = await fixture.service.execute(context, fixture.input, 'tool-disconnect')

    expect(fixture.agentStarts).toEqual(['root', 'agent-a', 'agent-b'])
    expect(result.nodes.some((node) => node.nodeId === 'agent-c')).toBe(false)
  })

  test('Given 仅 association 边在 Agent 运行后变化 When 重规划 Then 不把展示关系视为执行图变化', async () => {
    const root = createNode('root', 'agent')
    const note = createNode('note', 'document')
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture(createDocument([root, note]), {
      onAgentStart: async () => {
        const association = {
          ...createCanvasBoundEdge(root, note, {
            id: 'association-edge', sourceNodeId: root.id, targetNodeId: note.id, relation: 'association',
          }),
          relation: 'association' as const,
        }
        const next = createDocument([root, note])
        next.revision = 4
        next.edges = [association]
        fixture.setDocument(next)
      },
    })

    const result = await fixture.service.execute(context, fixture.input, 'tool-association')

    expect(result.status).toBe('completed')
    expect(result.errorCode).toBeNull()
  })

  test('Given 初始可达图损坏 When 执行 Then 在 Agent 和图片副作用前拒绝', async () => {
    const root = createNode('root', 'agent')
    const document = createDocument([root])
    document.edges = [{
      id: 'dangling', sourceNodeId: root.id, sourcePort: 'output', targetNodeId: 'missing',
      targetPort: 'input', relation: 'depends-on',
    }]
    const fixture = createFixture(document)

    await expect(fixture.service.execute(context, fixture.input, 'tool-invalid')).rejects.toThrow(
      'CANVAS_WORKFLOW_EDGE_DANGLING',
    )
    expect(fixture.agentStarts).toEqual([])
    expect(fixture.imageRuns).toEqual([])
  })

  test('Given 已执行根被删除或 bound 边被改写 When fresh-read Then 返回稳定图变化且不扩张', async () => {
    const root = createNode('root', 'agent')
    const child = createNode('child', 'agent', true)
    let deletedFixture: ReturnType<typeof createFixture>
    deletedFixture = createFixture(createDocument([root, child], [[root, child]]), {
      onAgentStart: async () => {
        const next = createDocument([child])
        next.revision = 4
        deletedFixture.setDocument(next)
      },
    })
    const deleted = await deletedFixture.service.execute(context, deletedFixture.input, 'tool-root-deleted')
    expect(deleted.errorCode).toBe('CANVAS_WORKFLOW_GRAPH_CHANGED')

    let edgeFixture: ReturnType<typeof createFixture>
    edgeFixture = createFixture(createDocument([root, child], [[root, child]]), {
      onAgentStart: async () => {
        const next = createDocument([root, child], [[root, child]])
        next.revision = 4
        next.edges[0] = { ...next.edges[0]!, id: 'replacement-edge' }
        edgeFixture.setDocument(next)
      },
    })
    const changed = await edgeFixture.service.execute(context, edgeFixture.input, 'tool-edge-changed')
    expect(changed.errorCode).toBe('CANVAS_WORKFLOW_GRAPH_CHANGED')
    expect(edgeFixture.agentStarts).toEqual(['root'])
  })

  test('Given Agent 动态引入执行环 When fresh plan Then 稳定停止且不运行新节点', async () => {
    const root = createNode('root', 'agent')
    const added = createNode('added', 'agent', true)
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture(createDocument([root]), {
      onAgentStart: async () => {
        const next = createDocument([root, added], [[root, added], [added, root]])
        next.revision = 4
        fixture.setDocument(next)
      },
    })

    const result = await fixture.service.execute(context, fixture.input, 'tool-cycle')

    expect(result.errorCode).toBe('CANVAS_WORKFLOW_GRAPH_CHANGED')
    expect(fixture.agentStarts).toEqual(['root'])
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
    while (fixture.agentStarts.length === 0) await Promise.resolve()
    controller.abort()

    const result = await running

    expect(result.status).toBe('cancelled')
    expect(result.errorCode).toBe('CANVAS_WORKFLOW_CANCELLED')
    expect(result.nodes).toEqual([{ nodeId: 'root', status: 'cancelled', errorCode: null }])
  })

  test('Given 图片批次等待中父 Agent 取消 When 终止 Then awaitBatch 接管取消且调度器返回稳定结果', async () => {
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
    expect(result.errorCode).toBe('CANVAS_WORKFLOW_CANCELLED')
    expect(fixture.imageWaits).toEqual([['task-0']])
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

  test('Given 已许可图片在 fresh plan 前已占用预算 When 动态扩大图片范围 Then started 总数不超过上限', async () => {
    const root = createNode('root', 'agent')
    const imageB = createNode('image-b', 'image')
    const imageA = createNode('image-a', 'image')
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture(createDocument([root, imageB], [[root, imageB]]), {
      onImageWait: async () => {
        /** 保留既有 root -> image-b 边身份，只追加新的付费节点。 */
        const next = createDocument([root, imageA, imageB], [[root, imageB], [root, imageA]])
        next.revision = 5
        fixture.setDocument(next)
      },
    })
    fixture.input.maxImageRuns = 1

    const result = await fixture.service.execute(context, fixture.input, 'tool-paid-expansion')

    expect(fixture.imageRuns.flat()).toHaveLength(1)
    expect(result.nodes.filter((node) => node.status === 'waiting-review')).toHaveLength(1)
    expect(result.nodes.find((node) => node.nodeId === 'image-a')).toEqual({
      nodeId: 'image-a', status: 'waiting-approval', errorCode: null,
    })
  })

  test('Given 图片候选等待期间新增可达 Agent 和图片 When fresh plan Then 继续实际运行且不遗留 started', async () => {
    const root = createNode('root', 'agent')
    const firstImage = createNode('image-first', 'image')
    const addedAgent = createNode('agent-added', 'agent')
    const addedImage = createNode('image-added', 'image')
    let expanded = false
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture(createDocument([root, firstImage], [[root, firstImage]]), {
      onImageWait: async () => {
        if (expanded) return
        expanded = true
        /** 保留既有边身份，只在图片等待期间追加两个独立可达节点。 */
        const next = createDocument(
          [root, firstImage, addedAgent, addedImage],
          [[root, firstImage], [root, addedAgent], [root, addedImage]],
        )
        next.revision = 5
        fixture.setDocument(next)
      },
    })
    fixture.input.maxImageRuns = 2

    const result = await fixture.service.execute(context, fixture.input, 'tool-image-expansion')

    expect(fixture.agentStarts).toEqual(['root', 'agent-added'])
    expect(fixture.imageRuns).toEqual([['image-first'], ['image-added']])
    expect(result.nodes.some((node) => node.status === 'started')).toBe(false)
  })

  test('Given 真实图片服务首批等待期间动态新增第二图片 When 持续调度与重放 Then 子批身份互异且重放稳定', async () => {
    const root = createNode('root', 'agent')
    const firstImage = createNode('image-first', 'image')
    const addedImage = createNode('image-added', 'image')
    const realImages = createRealImageRunHarness()
    const operationIds: string[] = []
    let expanded = false
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture(createDocument([root, firstImage], [[root, firstImage]]), {
      now: Date.now,
      imageRunService: {
        run: (runContext, runTarget, nodes, operationId, runOptions) => {
          operationIds.push(operationId)
          return realImages.service.run(runContext, runTarget, nodes, operationId, runOptions)
        },
        awaitBatch: async (input) => {
          const terminal = await realImages.service.awaitBatch(input)
          if (!expanded) {
            expanded = true
            const next = createDocument(
              [root, firstImage, addedImage],
              [[root, firstImage], [root, addedImage]],
            )
            next.revision = 5
            fixture.setDocument(next)
          }
          return terminal
        },
      },
    })
    fixture.input.maxImageRuns = 2

    const result = await fixture.service.execute(context, fixture.input, 'tool-real-dynamic-batches')
    const savedBatches = [...realImages.batches.values()]

    expect(savedBatches).toHaveLength(2)
    expect(new Set(savedBatches.map((batch) => batch.batchId)).size).toBe(2)
    expect(savedBatches.map((batch) => batch.entries[0]?.nodeId).sort()).toEqual([
      'image-added', 'image-first',
    ])
    expect(savedBatches.every((batch) => batch.status === 'ready')).toBe(true)
    expect(result.nodes.filter((node) => node.status === 'waiting-review')).toHaveLength(2)

    const firstOperationIds = [...operationIds]
    const firstStartedJobIds = [...realImages.startedJobIds]
    /** 不回退动态扩图，直接按真实持久化图重放，验证分波变化不会改变付费身份。 */
    fixture.input.expectedRevision = 5
    const replay = await fixture.service.execute(context, fixture.input, 'tool-real-dynamic-batches')

    expect(operationIds.slice(firstOperationIds.length).sort()).toEqual([...firstOperationIds].sort())
    expect(new Set(firstOperationIds).size).toBe(2)
    expect(realImages.startedJobIds).toEqual(firstStartedJobIds)
    expect(realImages.jobs).toHaveLength(2)
    expect(realImages.batches).toHaveLength(2)
    expect(replay.nodes.filter((node) => node.status === 'waiting-review')).toHaveLength(2)
  })

  test('Given 两个图片节点同时 ready When 调度 Then 使用独立稳定子批并发启动', async () => {
    const root = createNode('root', 'agent')
    const imageA = createNode('image-a', 'image')
    const imageB = createNode('image-b', 'image')
    let activeRuns = 0
    let maxActiveRuns = 0
    let enteredRuns = 0
    let releaseRuns = (): void => undefined
    const runGate = new Promise<void>((resolve) => { releaseRuns = resolve })
    const operationIds: string[] = []
    const fixture = createFixture(createDocument(
      [root, imageA, imageB], [[root, imageA], [root, imageB]],
    ), {
      imageRunService: {
        run: async (_context, _target, nodes, operationId) => {
          operationIds.push(operationId)
          activeRuns += 1
          enteredRuns += 1
          maxActiveRuns = Math.max(maxActiveRuns, activeRuns)
          if (enteredRuns === 2) releaseRuns()
          await runGate
          activeRuns -= 1
          const node = nodes[0]!
          return {
            tasks: [{ nodeId: node.id, status: 'started', taskId: `task-${node.id}` }],
            batch: {
              batchId: `batch-${node.id}`, status: 'running', totalCount: 1,
              candidateCount: 0, failedCount: 0, runningCount: 1, requiresCanvasReview: true,
            },
          }
        },
        awaitBatch: async (input) => ({
          batchId: input.batchId, status: 'ready', totalCount: 1, candidateCount: 1,
          failedCount: 0, runningCount: 0, requiresCanvasReview: true,
          entries: [{
            nodeId: input.batchId.replace('batch-', ''), taskId: input.taskIds[0]!, status: 'candidate',
          }],
        }),
      },
    })

    const result = await fixture.service.execute(context, fixture.input, 'tool-concurrent-images')

    expect(maxActiveRuns).toBe(2)
    expect(new Set(operationIds).size).toBe(2)
    expect(result.imageSummary).toEqual({
      status: 'ready', totalCount: 2, candidateCount: 2, failedCount: 0, runningCount: 0,
    })
  })

  test('Given 真实图片 run 已返回 owned 批次后父级立即取消 When 交接 Then 仍由 awaitBatch 精确取消任务', async () => {
    const root = createNode('root', 'agent')
    const image = createNode('image', 'image')
    const controller = new AbortController()
    const realImages = createRealImageRunHarness({ completeOnStart: false })
    let awaitBatchCalls = 0
    const fixture = createFixture(createDocument([root, image], [[root, image]]), {
      now: Date.now,
      imageRunService: {
        run: async (runContext, runTarget, nodes, operationId, runOptions) => {
          const result = await realImages.service.run(runContext, runTarget, nodes, operationId, runOptions)
          controller.abort()
          return result
        },
        awaitBatch: async (input) => {
          awaitBatchCalls += 1
          return realImages.service.awaitBatch(input)
        },
      },
    })

    const result = await fixture.service.execute(
      context, fixture.input, 'tool-real-handoff-abort', controller.signal,
    )

    expect(awaitBatchCalls).toBe(1)
    expect(realImages.cancelledJobIds).toHaveLength(1)
    expect(result.status).toBe('cancelled')
    expect(result.errorCode).toBe('CANVAS_WORKFLOW_CANCELLED')
  })

  for (const scenario of [
    {
      name: '授权复核',
      options: {
        onValidateAccess: async (callCount: number) => {
          if (callCount === 5) throw new Error('CANVAS_REFRESH_ACCESS_FAILED')
        },
      },
      errorCode: 'CANVAS_REFRESH_ACCESS_FAILED',
    },
    {
      name: '权威读取',
      options: {
        onLoad: async (callCount: number) => {
          if (callCount === 3) throw new Error('CANVAS_REFRESH_LOAD_FAILED')
        },
      },
      errorCode: 'CANVAS_REFRESH_LOAD_FAILED',
    },
  ]) {
    test(`Given 图片候选已返回后 fresh ${scenario.name}失败 When 终止 Then 保留顶层错误而不改写为生图失败`, async () => {
      const root = createNode('root', 'agent')
      const image = createNode('image', 'image')
      const fixture = createFixture(createDocument([root, image], [[root, image]]), scenario.options)

      await expect(fixture.service.execute(context, fixture.input, `tool-refresh-${scenario.name}`))
        .rejects.toThrow(scenario.errorCode)
      expect(fixture.imageRuns).toEqual([['image']])
      expect(fixture.imageWaits).toEqual([['task-0']])
    })
  }

  test('Given 图片批次逐节点为候选、失败和无效 When 终态映射 Then 各分支使用真实结果', async () => {
    const root = createNode('root', 'agent')
    const candidate = createNode('candidate', 'image')
    const failed = createNode('failed', 'image')
    const invalid = createNode('invalid', 'image')
    const candidateChild = createNode('candidate-child', 'agent', true)
    const failedChild = createNode('failed-child', 'agent', true)
    const fixture = createFixture(createDocument(
      [root, candidate, failed, invalid, candidateChild, failedChild],
      [[root, candidate], [root, failed], [root, invalid], [candidate, candidateChild], [failed, failedChild]],
    ), {
      imageTerminalStatus: 'partial',
      imageTerminalEntries: [
        { nodeId: 'candidate', taskId: 'task-0', status: 'candidate' },
        { nodeId: 'failed', taskId: 'task-0', status: 'failed' },
        { nodeId: 'invalid', taskId: 'task-0', status: 'invalid' },
      ],
    })
    fixture.input.maxImageRuns = 3

    const result = await fixture.service.execute(context, fixture.input, 'tool-mixed-images')

    expect(result.nodes.find((node) => node.nodeId === 'candidate')?.status).toBe('waiting-review')
    expect(result.nodes.find((node) => node.nodeId === 'failed')).toEqual({
      nodeId: 'failed', status: 'failed', errorCode: 'CANVAS_IMAGE_RUN_FAILED',
    })
    expect(result.nodes.find((node) => node.nodeId === 'invalid')).toEqual({
      nodeId: 'invalid', status: 'failed', errorCode: 'CANVAS_IMAGE_RESULT_INVALID',
    })
    expect(result.nodes.find((node) => node.nodeId === 'candidate-child')).toEqual({
      nodeId: 'candidate-child', status: 'blocked', errorCode: 'WAITING_FOR_IMAGE_ADOPTION',
    })
    expect(result.nodes.find((node) => node.nodeId === 'failed-child')).toEqual({
      nodeId: 'failed-child', status: 'blocked', errorCode: 'UPSTREAM_FAILED',
    })
    expect(result.imageSummary).toEqual({
      status: 'partial', totalCount: 3, candidateCount: 1, failedCount: 2, runningCount: 0,
    })
  })

  test('Given deadline 发生在权威 load 等待中 When load 后台稍后完成 Then 立即终止且不启动副作用', async () => {
    const root = createNode('root', 'agent')
    let releaseLoad = (): void => undefined
    const loadBlocked = new Promise<void>((resolve) => { releaseLoad = resolve })
    const fixture = createFixture(createDocument([root]), {
      onLoad: async (callCount) => {
        if (callCount === 1) await loadBlocked
      },
    })
    let settled = false
    const running = fixture.service.execute(context, fixture.input, 'tool-load-deadline').then((result) => {
      settled = true
      return result
    })
    while (fixture.loadCalls() === 0) await Promise.resolve()
    fixture.triggerDeadline()
    /** 不释放底层 load 即可完成，证明 deadline gate 不等待迟到只读 I/O。 */
    const result = await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('TEST_DEADLINE_GATE_TIMEOUT')), 100)
      }),
    ])
    expect(settled).toBe(true)
    expect(fixture.agentStarts).toEqual([])
    releaseLoad()
    expect(result.errorCode).toBe('CANVAS_WORKFLOW_TIMEOUT')
  })

  test('Given Agent 完成后的 fresh-load 等待中 deadline 到达 When 终止 Then 返回稳定超时而不抛 gate 异常', async () => {
    const root = createNode('root', 'agent')
    let releaseLoad = (): void => undefined
    const loadBlocked = new Promise<void>((resolve) => { releaseLoad = resolve })
    const fixture = createFixture(createDocument([root]), {
      onLoad: async (callCount) => {
        if (callCount === 2) await loadBlocked
      },
    })
    const running = fixture.service.execute(context, fixture.input, 'tool-refresh-deadline')
    while (fixture.loadCalls() < 2) await Promise.resolve()

    fixture.triggerDeadline()
    const result = await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('TEST_REFRESH_DEADLINE_GATE_TIMEOUT')), 100)
      }),
    ])

    releaseLoad()
    expect(result.status).toBe('cancelled')
    expect(result.errorCode).toBe('CANVAS_WORKFLOW_TIMEOUT')
    expect(result.finalRevision).toBe(4)
  })

  test('Given Agent 已提交新 revision 后 fresh-load 等待中父级取消 When 终止 Then 返回已观察到的最新版本', async () => {
    const root = createNode('root', 'agent')
    const controller = new AbortController()
    let releaseLoad = (): void => undefined
    const loadBlocked = new Promise<void>((resolve) => { releaseLoad = resolve })
    const fixture = createFixture(createDocument([root]), {
      onLoad: async (callCount) => {
        if (callCount === 2) await loadBlocked
      },
    })
    const running = fixture.service.execute(
      context, fixture.input, 'tool-refresh-parent-abort', controller.signal,
    )
    while (fixture.loadCalls() < 2) await Promise.resolve()

    controller.abort()
    const result = await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('TEST_REFRESH_PARENT_ABORT_GATE_TIMEOUT')), 100)
      }),
    ])

    releaseLoad()
    expect(result.status).toBe('cancelled')
    expect(result.errorCode).toBe('CANVAS_WORKFLOW_CANCELLED')
    expect(result.finalRevision).toBe(4)
  })

  test('Given 图片启动阶段取消且底层清理失败 When 返回 Then 清理错误不覆盖取消主事实', async () => {
    const root = createNode('root', 'agent')
    const image = createNode('image', 'image')
    const controller = new AbortController()
    const fixture = createFixture(createDocument([root, image], [[root, image]]), {
      onImageRun: async (signal) => new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      }),
    })
    const running = fixture.service.execute(context, fixture.input, 'tool-image-start-cancel', controller.signal)
    while (fixture.imageRuns.length === 0) await Promise.resolve()
    controller.abort()

    const result = await running

    expect(result.status).toBe('cancelled')
    expect(result.errorCode).toBe('CANVAS_WORKFLOW_CANCELLED')
  })

  test('Given 内部 Agent 和图片错误包含路径 When 返回公开结果 Then 只保留稳定降级错误码', async () => {
    const agent = createNode('root', 'agent')
    const agentFixture = createFixture(createDocument([agent]), {
      agentErrorByNodeId: { root: new Error('/private/session.json credential=secret') },
    })
    const agentResult = await agentFixture.service.execute(context, agentFixture.input, 'tool-agent-redaction')
    expect(agentResult.nodes[0]).toEqual({
      nodeId: 'root', status: 'failed', errorCode: 'CANVAS_AGENT_RUN_FAILED',
    })

    const image = createNode('image', 'image')
    const imageFixture = createFixture(createDocument([agent, image], [[agent, image]]), {
      imageWaitError: new Error('/private/batch.json api_key=secret'),
    })
    const imageResult = await imageFixture.service.execute(context, imageFixture.input, 'tool-image-redaction')
    expect(imageResult.nodes.find((node) => node.nodeId === 'image')).toEqual({
      nodeId: 'image', status: 'failed', errorCode: 'CANVAS_IMAGE_RUN_FAILED',
    })
    expect(JSON.stringify(imageResult)).not.toContain('/private')
    expect(JSON.stringify(imageResult)).not.toContain('secret')
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
