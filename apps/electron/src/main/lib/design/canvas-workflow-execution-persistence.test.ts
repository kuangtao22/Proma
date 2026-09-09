import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvasBoundEdge, createEmptyCanvasDocument } from '@proma/shared'
import type {
  CanvasDocument,
  CanvasImageCandidateBatch,
  CanvasImageModuleConfig,
  CanvasNode,
  CanvasTarget,
  CanvasWorkflowRunChangedEvent,
} from '@proma/shared'
import { createCanvasDependencyStateService } from './canvas-dependency-state-service'
import { createCanvasImageCandidateBatchService } from './canvas-image-candidate-batch-service'
import {
  createCanvasImageCandidateBatchStore,
  type CanvasImageCandidateAdoptionIntent,
} from './canvas-image-candidate-batch-store'
import { createCanvasWorkflowExecutionService } from './canvas-workflow-execution-service'
import { createCanvasWorkflowPlanSnapshot } from './canvas-workflow-planner'
import { createCanvasWorkflowRunStore } from './canvas-workflow-run-store'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建 Agent、图片、Agent 的最小固定生产链。 */
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

describe('Canvas Workflow Execution Persistence', () => {
  test('Given 图片候选暂停后重启恢复 When exact 候选采用 Then 不重跑已完成 Agent 与原图片任务', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-execution-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: (() => { let value = 100; return () => value += 1 })(),
    })
    const document = createDocument()
    const agentStarts: Array<{ nodeId: string; parentSessionId: string; startedAt: number }> = []
    let imageStarts = 0
    let adopted = false
    const service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document),
      validateAccess: () => undefined,
      isAgentBusy: () => false,
      agentExecution: {
        execute: async (request) => {
          if (request.mode !== 'parent-orchestrated') throw new Error('TEST_EXPECTED_PARENT_ORCHESTRATED')
          agentStarts.push({
            nodeId: request.target.nodeId,
            parentSessionId: request.parentSessionId,
            startedAt: request.startedAt,
          })
          return {
            status: 'completed',
            output: {
              target: request.target,
              revision: 4 + agentStarts.length,
              pointer: {
                messageUuid: agentStarts.length === 1
                  ? '11111111-1111-4111-8111-111111111111'
                  : '22222222-2222-4222-8222-222222222222',
                contentSha256: agentStarts.length === 1 ? 'a'.repeat(64) : 'b'.repeat(64),
                completedAt: 20 + agentStarts.length,
              },
              downstreamNodeIds: [],
            },
          }
        },
      },
      imageRuns: {
        run: async (_context, _target, nodes) => {
          imageStarts += 1
          return {
            tasks: [{ nodeId: nodes[0]!.id, status: 'started', taskId: 'task-1' }],
            batch: {
              batchId: 'batch-1', status: 'running', totalCount: 1,
              candidateCount: 0, failedCount: 0, runningCount: 1, requiresCanvasReview: true,
            },
          }
        },
        awaitBatch: async () => ({
          batchId: 'batch-1', status: 'ready', totalCount: 1,
          candidateCount: 1, failedCount: 0, runningCount: 0, requiresCanvasReview: true,
          entries: [{ nodeId: 'image', taskId: 'task-1', status: 'candidate' }],
        }),
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      isImageCandidateAdopted: async (query) => ({
        adopted: adopted && query.batchId === 'batch-1' && query.taskId === 'task-1',
        artifactHash: adopted ? 'c'.repeat(64) : null,
        committedAt: adopted ? 40 : null,
      }),
      now: () => 50,
      setDeadline: () => ({ cancel: () => undefined }),
    })
    const context = {
      projectId: 'project-1',
      sessionId: 'parent-session',
      runStartedAt: 10,
      explicitReferences: [],
      permissionCeiling: 'execute' as const,
    }

    const first = await service.execute(context, {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['root'],
      goal: '完成主视觉', maxImageRuns: 1,
    }, 'tool-call-1')
    const waitingRun = workflowRuns.list({ projectId: 'project-1', canvasId: 'canvas-1' })[0]!
    expect(first.status).toBe('waiting-review')
    expect(waitingRun.nodes.find((node) => node.nodeId === 'image')?.execution).toEqual({
      kind: 'image', operationId: expect.any(String), batchId: 'batch-1', taskId: 'task-1',
    })

    adopted = true
    const resumed = await service.resume({ ...context, runStartedAt: 999 }, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: waitingRun.id,
    })

    expect(resumed.status).toBe('completed')
    expect(agentStarts).toEqual([
      { nodeId: 'root', parentSessionId: 'parent-session', startedAt: 10 },
      { nodeId: 'finisher', parentSessionId: 'parent-session', startedAt: 10 },
    ])
    expect(imageStarts).toBe(1)
  })

  for (const scenario of [
    { name: '图与配置均匹配', graphMatches: true, configMatches: true, expectedStatus: 'completed' },
    { name: '仅图匹配', graphMatches: true, configMatches: false, expectedStatus: 'waiting-review' },
    { name: '仅配置匹配', graphMatches: false, configMatches: true, expectedStatus: 'waiting-review' },
  ] as const) {
    test(`Given 首次图片由真实候选服务自动选中且${scenario.name} When 重建服务后用户明确恢复 Then 仅双重匹配继续下游`, async () => {
      const temporaryRoot = mkdtempSync(join(tmpdir(), 'proma-workflow-real-adoption-'))
      temporaryRoots.push(temporaryRoot)
      const transactionsDir = join(temporaryRoot, 'transactions')
      mkdirSync(transactionsDir, { recursive: true })
      const workflowRuns = createCanvasWorkflowRunStore({
        pathResolver: { resolveCanvas: () => ({ transactionsDir }) as never },
        runWorkspaceWrite: (_projectId, effect) => effect(),
        now: (() => { let value = 100; return () => value += 1 })(),
      })
      const target: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-1' }
      let document = createDocument()
      let config: CanvasImageModuleConfig = {
        schemaVersion: 2,
        kind: 'image',
        contentId: 'image-module',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        prompt: '生成主视觉',
        selectedModelProfileId: 'model-1',
        aspectRatio: '1:1',
        imageSize: 'auto',
        contextMode: 'none',
        adoptedAssetId: null,
      }
      /** Map 只替代文件 I/O，批次和采用 intent 仍经过生产 Store 的严格 parser。 */
      const batches = new Map<string, CanvasImageCandidateBatch>()
      const intents = new Map<string, CanvasImageCandidateAdoptionIntent>()
      const candidateStore = createCanvasImageCandidateBatchStore({
        scanBatches: async () => [...batches.values()].map((batch) => structuredClone(batch)),
        writeBatch: async (batch) => {
          batches.set(batch.batchId, structuredClone(batch))
          return { commitVisible: true, durabilityUncertain: false }
        },
        scanAdoptionIntents: async () => [...intents.values()].map((intent) => structuredClone(intent)),
        writeAdoptionIntent: async (intent) => {
          intents.set(intent.operationId, structuredClone(intent))
          return { commitVisible: true, durabilityUncertain: false }
        },
      })
      const candidateService = createCanvasImageCandidateBatchService({
        store: candidateStore,
        dependencyState: createCanvasDependencyStateService(),
        runExclusive: async (_canvasTarget, effect) => effect(),
        loadConfig: async () => structuredClone(config),
        adoptAsset: async (_imageTarget, expectedConfigRevision, assetId) => {
          if (config.revision !== expectedConfigRevision) throw new Error('CANVAS_IMAGE_CONFIG_REVISION_CONFLICT')
          config = {
            ...config,
            revision: config.revision + 1,
            updatedAt: 40,
            adoptedAssetId: assetId,
          }
          return structuredClone(config)
        },
        loadCanvas: async () => structuredClone(document),
        applyCanvasProjection: async (_canvasTarget, expectedRevision, nodes) => {
          if (document.revision !== expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
          const replacements = new Map(nodes.map((node) => [node.id, node]))
          document = {
            ...document,
            revision: document.revision + 1,
            nodes: document.nodes.map((node) => replacements.get(node.id) ?? node),
            updatedAt: 40,
          }
          return structuredClone(document)
        },
        retryEntry: async () => { throw new Error('TEST_UNEXPECTED_RETRY') },
        now: () => 40,
      })
      const agentStarts: string[] = []
      let imageStarts = 0
      const dependencies = {
        load: () => structuredClone(document),
        validateAccess: () => undefined,
        isAgentBusy: () => false,
        agentExecution: {
          execute: async (request: { target: { nodeId: string } }) => {
            agentStarts.push(request.target.nodeId)
            const contentSha256 = request.target.nodeId === 'root' ? 'a'.repeat(64) : 'b'.repeat(64)
            const pointer = {
              messageUuid: request.target.nodeId === 'root'
                ? '11111111-1111-4111-8111-111111111111'
                : '22222222-2222-4222-8222-222222222222',
              contentSha256,
              completedAt: 20,
            }
            document = {
              ...document,
              revision: document.revision + 1,
              nodes: document.nodes.map((node) => node.id === request.target.nodeId && node.kind === 'agent'
                ? { ...node, outputPointer: pointer }
                : node),
            }
            return {
              status: 'completed' as const,
              output: {
                target: { ...target, nodeId: request.target.nodeId },
                revision: document.revision,
                pointer,
                downstreamNodeIds: [],
              },
            }
          },
        },
        imageRuns: {
          run: async () => {
            imageStarts += 1
            await candidateService.createBatch({
              ...target,
              batchId: 'batch-real-1',
              source: 'canvas-tool',
              sourceSessionId: 'parent-session',
              sourceToolCallId: 'tool-call-real-1',
              entries: [{
                nodeId: 'image',
                imageModuleId: 'image-module',
                initialAdoptedAssetId: null,
                initialConfigRevision: config.revision,
                jobId: 'task-real-1',
              }],
            })
            return {
              tasks: [{ nodeId: 'image', status: 'started' as const, taskId: 'task-real-1' }],
              batch: {
                batchId: 'batch-real-1', status: 'running' as const, totalCount: 1,
                candidateCount: 0, failedCount: 0, runningCount: 1, requiresCanvasReview: true as const,
              },
            }
          },
          awaitBatch: async () => {
            await candidateService.recordJobTerminal({
              ...target,
              candidateBatchId: 'batch-real-1',
              jobId: 'task-real-1',
              status: 'succeeded',
              outputAssetId: 'asset-first-1',
              error: null,
            })
            const batch = await candidateService.load({ ...target, batchId: 'batch-real-1' })
            return {
              batchId: batch.batchId,
              status: 'ready' as const,
              totalCount: 1,
              candidateCount: 1,
              failedCount: 0,
              runningCount: 0,
              requiresCanvasReview: true as const,
              entries: [{ nodeId: 'image', taskId: 'task-real-1', status: 'candidate' as const }],
            }
          },
          cancelTasks: async () => undefined,
        },
        workflowRuns,
        isImageCandidateAdopted: async (input: CanvasTarget & {
          nodeId: string
          batchId: string
          taskId: string
        }) => {
          const adoption = await candidateService.getCandidateAdoption({
            ...input,
            jobId: input.taskId,
          })
          return {
            adopted: adoption !== null,
            artifactHash: adoption
              ? createHash('sha256').update(JSON.stringify(['image-asset', adoption.assetId])).digest('hex')
              : null,
            committedAt: adoption?.committedAt ?? null,
          }
        },
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
      }, 'tool-call-real-1')
      const waitingRun = (await firstService.listPage(context, 'canvas-1')).runs[0]!
      expect(first.status).toBe('waiting-review')
      expect(config.adoptedAssetId).toBe('asset-first-1')
      expect(document.nodes.find((node) => node.id === 'image' && node.kind === 'image')?.adoptedAssetId)
        .toBe('asset-first-1')
      expect(agentStarts).toEqual(['root'])
      const persistedReceipt = await candidateService.getCandidateAdoption({
        ...target,
        batchId: 'batch-real-1',
        nodeId: 'image',
        jobId: 'task-real-1',
      })
      expect(persistedReceipt).toEqual({ assetId: 'asset-first-1', committedAt: 40 })
      /** 重新创建服务模拟重启；后台对账不能将真实首选 receipt 视为验收。 */
      const automaticService = createCanvasWorkflowExecutionService(dependencies)
      const automatic = await automaticService.resume(context, {
        ...target, runId: waitingRun.id,
      }, undefined, { automatic: true })
      expect(automatic.status).toBe('waiting-review')
      expect(agentStarts).toEqual(['root'])
      expect(imageStarts).toBe(1)

      /** 分别破坏图或配置的一侧，验证恢复不能把局部一致误判为正式采用。 */
      if (!scenario.graphMatches) {
        document = {
          ...document,
          nodes: document.nodes.map((node) => node.id === 'image' && node.kind === 'image'
            ? { ...node, adoptedAssetId: undefined }
            : node),
        }
      }
      if (!scenario.configMatches) config = { ...config, adoptedAssetId: null }

      const secondService = createCanvasWorkflowExecutionService(dependencies)
      const resumed = await secondService.resume({ ...context, runStartedAt: 99 }, {
        ...target,
        runId: waitingRun.id,
      })

      expect(resumed.status).toBe(scenario.expectedStatus)
      expect(imageStarts).toBe(1)
      expect(agentStarts).toEqual(scenario.expectedStatus === 'completed'
        ? ['root', 'finisher']
        : ['root'])
    })
  }

  test('Given 音频 typed input 与本次输出 When 执行并采用 Then 固定输入哈希且恢复不重投媒体 run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-media-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: (() => { let value = 200; return () => value += 1 })(),
    })
    const audio: CanvasNode = {
      id: 'audio', title: 'audio', position: { x: 0, y: 0 },
      kind: 'audio', mediaModuleId: 'audio-module',
    }
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1),
      revision: 3,
      nodes: [audio],
    }
    let mediaStarts = 0
    let adopted = false
    const service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document),
      validateAccess: () => undefined,
      isAgentBusy: () => false,
      agentExecution: { execute: async () => ({ status: 'errored' }) },
      imageRuns: {
        run: async () => ({ tasks: [] }),
        awaitBatch: async () => { throw new Error('TEST_UNEXPECTED_IMAGE_WAIT') },
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      mediaRuns: {
        resolveInputs: async () => ({
          configRevision: 2,
          ready: true,
          bindings: [{
            targetInputKey: 'script', requiredKind: 'text', sourceNodeId: null,
            sourceOutputKey: null, sourceArtifactHash: null,
            resolvedValue: { kind: 'scalar', value: '本次固定台词' }, errorCode: null,
          }],
        }),
        run: async (input) => {
          mediaStarts += 1
          expect(input.expectedInputHashes.script).toMatch(/^[a-f0-9]{64}$/)
          return {
            status: 'waiting-adoption', mediaRunId: 'media-run-1',
            outputKeys: ['primary'], errorCode: null,
          }
        },
        cancel: async () => undefined,
      },
      isMediaOutputAdopted: async (query) => ({
        adopted: adopted && query.mediaRunId === 'media-run-1' && query.outputKey === 'primary',
        artifactHash: adopted ? 'f'.repeat(64) : null,
        committedAt: adopted ? 60 : null,
      }),
      now: () => 70,
      setDeadline: () => ({ cancel: () => undefined }),
    })
    const context = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    const first = await service.execute(context, {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['audio'],
      goal: '生成配音', maxImageRuns: 1,
    }, 'tool-call-media')
    const waiting = workflowRuns.list({ projectId: 'project-1', canvasId: 'canvas-1' })[0]!
    expect(first.status).toBe('waiting-review')
    expect(waiting.nodes[0]?.inputBindings[0]?.resolvedValueHash).toMatch(/^[a-f0-9]{64}$/)

    adopted = true
    const resumed = await service.resume(context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: waiting.id,
    })

    expect(resumed.status).toBe('completed')
    expect(mediaStarts).toBe(1)
  })

  test('Given 图片任务正在等待 When owner 取消持久运行 Then 精确取消批次并让执行 promise 收口', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-cancel-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: (() => { let value = 300; return () => value += 1 })(),
    })
    const image: CanvasNode = {
      id: 'image', title: 'image', position: { x: 0, y: 0 }, kind: 'image', imageModuleId: 'image-module',
    }
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3, nodes: [image],
    }
    let notifyWaiting = (): void => undefined
    const waiting = new Promise<void>((resolve) => { notifyWaiting = resolve })
    const cancelledTasks: string[][] = []
    let intentPersistedBeforeCleanup = false
    const service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document),
      validateAccess: () => undefined,
      isAgentBusy: () => false,
      agentExecution: { execute: async () => ({ status: 'errored' }) },
      imageRuns: {
        run: async () => ({
          tasks: [{ nodeId: 'image', status: 'started', taskId: 'task-1' }],
          batch: {
            batchId: 'batch-1', status: 'running', totalCount: 1,
            candidateCount: 0, failedCount: 0, runningCount: 1, requiresCanvasReview: true,
          },
        }),
        awaitBatch: async (input) => {
          notifyWaiting()
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener('abort', () => reject(new Error('CANVAS_IMAGE_BATCH_WAIT_ABORTED')), {
              once: true,
            })
          })
          throw new Error('TEST_UNREACHABLE')
        },
        cancelTasks: async (input) => {
          intentPersistedBeforeCleanup = workflowRuns.get({
            projectId: 'project-1', canvasId: 'canvas-1',
          }, workflowRuns.list({ projectId: 'project-1', canvasId: 'canvas-1' })[0]!.id)
            .cancelRequestedAt !== null
          cancelledTasks.push([...input.taskIds])
          throw new Error('IMAGE_PRECISE_CANCEL_FAILED')
        },
      },
      workflowRuns,
      now: () => 500,
      setDeadline: () => ({ cancel: () => undefined }),
    })
    const context = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }
    const executing = service.execute(context, {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['image'],
      goal: '生成图片', maxImageRuns: 1,
    }, 'tool-call-cancel')
    await waiting
    const active = (await service.list(context, 'canvas-1'))[0]!

    const cancelled = await service.cancel(context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: active.id,
    })
    const result = await executing
    const loaded = await service.get(context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: active.id,
    })

    expect(cancelled.status).toBe('cancelled')
    expect(result.status).toBe('cancelled')
    expect(loaded.status).toBe('cancelled')
    expect(intentPersistedBeforeCleanup).toBe(true)
    expect(cancelledTasks).toContainEqual(['task-1'])
  })

  test('Given 生成后等待采用很久 When 恢复并继续 Agent Then 只扣实际执行段且 deadline 不刷新', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-duration-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    let clock = 100
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: () => clock,
    })
    const image: CanvasNode = {
      id: 'image', title: 'image', position: { x: 0, y: 0 }, kind: 'image', imageModuleId: 'image-module',
    }
    const agent: CanvasNode = {
      id: 'agent', title: 'agent', position: { x: 10, y: 0 }, kind: 'agent', agentSessionId: 'agent-session',
    }
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3,
      nodes: [image, agent],
      edges: [createCanvasBoundEdge(image, agent, {
        id: 'edge-image-agent', sourceNodeId: image.id, targetNodeId: agent.id, relation: 'depends-on',
      })],
    }
    let adopted = false
    const deadlineTimeouts: number[] = []
    const service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document),
      validateAccess: () => undefined,
      isAgentBusy: () => false,
      agentExecution: {
        execute: async (request) => {
          clock += 40
          return {
            status: 'completed',
            output: {
              target: request.target, revision: 5,
              pointer: {
                messageUuid: '11111111-1111-4111-8111-111111111111',
                contentSha256: 'a'.repeat(64), completedAt: clock,
              },
              downstreamNodeIds: [],
            },
          }
        },
      },
      imageRuns: {
        run: async () => ({
          tasks: [{ nodeId: 'image', status: 'started', taskId: 'task-1' }],
          batch: {
            batchId: 'batch-1', status: 'running', totalCount: 1,
            candidateCount: 0, failedCount: 0, runningCount: 1, requiresCanvasReview: true,
          },
        }),
        awaitBatch: async () => {
          clock += 60
          return {
            batchId: 'batch-1', status: 'ready', totalCount: 1,
            candidateCount: 1, failedCount: 0, runningCount: 0, requiresCanvasReview: true,
            entries: [{ nodeId: 'image', taskId: 'task-1', status: 'candidate' }],
          }
        },
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      isImageCandidateAdopted: async () => ({
        adopted, artifactHash: adopted ? 'b'.repeat(64) : null, committedAt: adopted ? clock : null,
      }),
      now: () => clock,
      setDeadline: (_callback, timeoutMs) => {
        deadlineTimeouts.push(timeoutMs)
        return { cancel: () => undefined }
      },
    })
    const context = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    await service.execute(context, {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['image'],
      goal: '生成后完成文案', maxImageRuns: 1,
    }, 'tool-duration')
    const waiting = workflowRuns.list({ projectId: 'project-1', canvasId: 'canvas-1' })[0]!
    expect(waiting.status).toBe('waiting-review')
    expect(waiting.budget.remainingDurationMs).toBe(15 * 60_000 - 60)
    expect(waiting.budget.activeStartedAt).toBeNull()

    clock = 100_000
    adopted = true
    await service.resume(context, { projectId: 'project-1', canvasId: 'canvas-1', runId: waiting.id })
    const completed = workflowRuns.get({ projectId: 'project-1', canvasId: 'canvas-1' }, waiting.id)
    expect(completed.status).toBe('completed')
    expect(completed.budget.remainingDurationMs).toBe(15 * 60_000 - 100)
    expect(completed.budget.activeStartedAt).toBeNull()
    expect(deadlineTimeouts).toEqual([15 * 60_000, 15 * 60_000 - 60])
  })

  test('Given Agent 输出已提交但 journal 仍为 running When 精确恢复 Then 完成原节点且不重投 Agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-agent-recovery-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    let clock = 100
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: () => clock,
    })
    const agent: CanvasNode = {
      id: 'agent', title: 'agent', position: { x: 0, y: 0 }, kind: 'agent', agentSessionId: 'child-session',
    }
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3, nodes: [agent],
    }
    const snapshot = createCanvasWorkflowPlanSnapshot(document, { startNodeIds: ['agent'], maxImageRuns: 0 })
    let run = workflowRuns.create({
      projectId: 'project-1', canvasId: 'canvas-1', operationId: 'tool-agent-recovery',
      owner: { sessionId: 'parent-session', runStartedAt: 10 }, initialCanvasRevision: 3,
      rootNodeIds: snapshot.rootNodeIds, goal: '恢复输出', nodes: snapshot.nodes,
      maxMediaRuns: 0, consumedMediaRuns: 0, autoResumeAfterAdoption: true,
    })
    run.nodes[0]!.status = 'running'
    run.nodes[0]!.execution = { kind: 'agent', operationId: 'owned-agent-operation' }
    run = workflowRuns.save(run, run.revision)
    let agentStarts = 0
    const recoveries: Array<{ operationId: string; userMessageUuid: string; startedAt: number }> = []
    const service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document), validateAccess: () => undefined, isAgentBusy: () => false,
      agentExecution: { execute: async () => { agentStarts += 1; return { status: 'errored' } } },
      recoverAgentExecution: async (input) => {
        recoveries.push({
          operationId: input.operationId,
          userMessageUuid: input.expectedUserMessageUuid,
          startedAt: input.expectedStartedAt,
        })
        return {
          status: 'completed',
          output: {
            target: { projectId: input.projectId, canvasId: input.canvasId, nodeId: input.nodeId },
            revision: 4,
            pointer: {
              messageUuid: '22222222-2222-4222-8222-222222222222',
              contentSha256: 'c'.repeat(64), completedAt: 30,
            },
            downstreamNodeIds: [],
          },
        }
      },
      imageRuns: {
        run: async () => ({ tasks: [] }), awaitBatch: async () => { throw new Error('UNEXPECTED') },
        cancelTasks: async () => undefined,
      },
      workflowRuns, now: () => clock,
      setDeadline: () => ({ cancel: () => undefined }),
    })
    const context = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    const result = await service.resume(context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: run.id,
    })

    expect(result.status).toBe('completed')
    expect(agentStarts).toBe(0)
    expect(recoveries).toEqual([{
      operationId: 'owned-agent-operation', userMessageUuid: 'tool-agent-recovery', startedAt: 10,
    }])
  })

  test('Given Agent 恢复查询返回其它节点输出 When resume Then 拒绝伪造完成事实且不重投 Agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-agent-recovery-invalid-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: () => 100,
    })
    const agent: CanvasNode = {
      id: 'agent', title: 'agent', position: { x: 0, y: 0 }, kind: 'agent', agentSessionId: 'child-session',
    }
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3, nodes: [agent],
    }
    const snapshot = createCanvasWorkflowPlanSnapshot(document, { startNodeIds: ['agent'], maxImageRuns: 0 })
    let run = workflowRuns.create({
      projectId: 'project-1', canvasId: 'canvas-1', operationId: 'tool-agent-recovery-invalid',
      owner: { sessionId: 'parent-session', runStartedAt: 10 }, initialCanvasRevision: 3,
      rootNodeIds: snapshot.rootNodeIds, goal: '拒绝伪造输出', nodes: snapshot.nodes,
      maxMediaRuns: 0, consumedMediaRuns: 0, autoResumeAfterAdoption: true,
    })
    run.nodes[0]!.status = 'running'
    run.nodes[0]!.execution = { kind: 'agent', operationId: 'owned-agent-operation' }
    run = workflowRuns.save(run, run.revision)
    let agentStarts = 0
    const service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document), validateAccess: () => undefined, isAgentBusy: () => false,
      agentExecution: { execute: async () => { agentStarts += 1; return { status: 'errored' } } },
      recoverAgentExecution: async () => ({
        status: 'completed',
        output: {
          target: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'other-agent' },
          revision: 4,
          pointer: {
            messageUuid: '33333333-3333-4333-8333-333333333333',
            contentSha256: 'd'.repeat(64), completedAt: 30,
          },
          downstreamNodeIds: [],
        },
      }),
      imageRuns: {
        run: async () => ({ tasks: [] }), awaitBatch: async () => { throw new Error('UNEXPECTED') },
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      now: () => 100,
      setDeadline: () => ({ cancel: () => undefined }),
    })
    const context = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    await expect(service.resume(context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: run.id,
    })).rejects.toThrow('CANVAS_AGENT_RECOVERY_OUTPUT_INVALID')
    expect(agentStarts).toBe(0)
  })

  test('Given 媒体任务已提交且收集待恢复 When resume Then 只 reconcile 原 mediaRunId 并保留已耗预算', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-media-recovery-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: () => 100,
    })
    const audio: CanvasNode = {
      id: 'audio', title: 'audio', position: { x: 0, y: 0 }, kind: 'audio', mediaModuleId: 'audio-module',
    }
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3, nodes: [audio],
    }
    const snapshot = createCanvasWorkflowPlanSnapshot(document, { startNodeIds: ['audio'], maxImageRuns: 1 })
    let run = workflowRuns.create({
      projectId: 'project-1', canvasId: 'canvas-1', operationId: 'tool-media-recovery',
      owner: { sessionId: 'parent-session', runStartedAt: 10 }, initialCanvasRevision: 3,
      rootNodeIds: snapshot.rootNodeIds, goal: '恢复下载', nodes: snapshot.nodes,
      maxMediaRuns: 1, consumedMediaRuns: 0, autoResumeAfterAdoption: true,
    })
    run.nodes[0]!.status = 'running'
    run.nodes[0]!.execution = {
      kind: 'media', operationId: 'owned-media-operation', mediaRunId: 'media-run-1', outputKeys: [],
    }
    run.budget.consumedMediaRuns = 1
    run.budget.remainingMediaRuns = 0
    run = workflowRuns.save(run, run.revision)
    let submissions = 0
    const reconciliationRunStartedAts: number[] = []
    const accessRunStartedAts: number[] = []
    const scheduledResumes: Array<{ workflowRunId: string; ownerSessionId: string; resumeAt: number }> = []
    let recoveryStatus: 'running' | 'waiting-adoption' = 'running'
    const service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document),
      validateAccess: (accessContext) => { accessRunStartedAts.push(accessContext.runStartedAt) },
      isAgentBusy: () => false,
      agentExecution: { execute: async () => ({ status: 'errored' }) },
      imageRuns: {
        run: async () => ({ tasks: [] }), awaitBatch: async () => { throw new Error('UNEXPECTED') },
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      mediaRuns: {
        resolveInputs: async () => ({ configRevision: 1, ready: true, bindings: [] }),
        run: async () => {
          submissions += 1
          return { status: 'failed', mediaRunId: 'new-run', outputKeys: [], errorCode: 'UNEXPECTED' }
        },
        reconcile: async (input) => {
          reconciliationRunStartedAts.push(input.context.runStartedAt)
          return {
            status: recoveryStatus, mediaRunId: input.mediaRunId,
            outputKeys: recoveryStatus === 'waiting-adoption' ? ['primary'] : [], errorCode: null,
          }
        },
        cancel: async () => undefined,
      },
      isMediaOutputAdopted: async () => ({ adopted: false, artifactHash: null, committedAt: null }),
      scheduleDurableResume: async (input) => {
        scheduledResumes.push({
          workflowRunId: input.workflowRunId,
          ownerSessionId: input.ownerSessionId,
          resumeAt: input.resumeAt,
        })
      },
      now: () => 100,
      setDeadline: () => ({ cancel: () => undefined }),
    })
    const context = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 999,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    await service.resume(context, { projectId: 'project-1', canvasId: 'canvas-1', runId: run.id })
    const stillRunning = workflowRuns.get({ projectId: 'project-1', canvasId: 'canvas-1' }, run.id)
    expect(stillRunning.nodes[0]?.status).toBe('running')
    expect(stillRunning.budget.remainingMediaRuns).toBe(0)
    expect(scheduledResumes).toEqual([{
      workflowRunId: run.id, ownerSessionId: 'parent-session', resumeAt: 15 * 60_000 + 100,
    }])
    recoveryStatus = 'waiting-adoption'
    const waiting = await service.resume(context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: run.id,
    })

    expect(waiting.status).toBe('waiting-review')
    expect(submissions).toBe(0)
    expect(reconciliationRunStartedAts).toEqual([10, 10])
    expect(accessRunStartedAts.length).toBeGreaterThan(0)
    expect(accessRunStartedAts.every((startedAt) => startedAt === 999)).toBe(true)
    expect(workflowRuns.get({ projectId: 'project-1', canvasId: 'canvas-1' }, run.id).nodes[0]?.execution)
      .toEqual({
        kind: 'media', operationId: 'owned-media-operation', mediaRunId: 'media-run-1', outputKeys: ['primary'],
      })
  })

  test('Given 媒体恢复跨过执行预算 When deadline 中止 Then 进入可续跑等待且保留原任务身份', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-media-deadline-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: () => 100,
    })
    const audio: CanvasNode = {
      id: 'audio', title: 'audio', position: { x: 0, y: 0 }, kind: 'audio', mediaModuleId: 'audio-module',
    }
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3, nodes: [audio],
    }
    const snapshot = createCanvasWorkflowPlanSnapshot(document, { startNodeIds: ['audio'], maxImageRuns: 1 })
    let run = workflowRuns.create({
      projectId: 'project-1', canvasId: 'canvas-1', operationId: 'tool-media-deadline',
      owner: { sessionId: 'parent-session', runStartedAt: 10 }, initialCanvasRevision: 3,
      rootNodeIds: snapshot.rootNodeIds, goal: '等待远端音频', nodes: snapshot.nodes,
      maxMediaRuns: 1, consumedMediaRuns: 1, autoResumeAfterAdoption: true,
    })
    run.nodes[0]!.status = 'running'
    run.nodes[0]!.execution = {
      kind: 'media', operationId: 'owned-media-operation', mediaRunId: 'media-run-1', outputKeys: [],
    }
    run = workflowRuns.save(run, run.revision)
    let triggerDeadline = (): void => undefined
    let notifyReconciling = (): void => undefined
    const reconciling = new Promise<void>((resolve) => { notifyReconciling = resolve })
    let submissions = 0
    const service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document), validateAccess: () => undefined, isAgentBusy: () => false,
      agentExecution: { execute: async () => ({ status: 'errored' }) },
      imageRuns: {
        run: async () => ({ tasks: [] }), awaitBatch: async () => { throw new Error('UNEXPECTED') },
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      mediaRuns: {
        resolveInputs: async () => ({ configRevision: 1, ready: true, bindings: [] }),
        run: async () => {
          submissions += 1
          return { status: 'failed', mediaRunId: 'new-run', outputKeys: [], errorCode: 'UNEXPECTED' }
        },
        reconcile: async (input) => {
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener('abort', () => {
              reject(new Error('MEDIA_PRECISE_CANCEL_UNSUPPORTED'))
            }, { once: true })
            notifyReconciling()
          })
          throw new Error('UNEXPECTED')
        },
        cancel: async () => undefined,
      },
      now: () => 1_000,
      setDeadline: (callback) => {
        triggerDeadline = callback
        return { cancel: () => undefined }
      },
    })
    const context = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    const resuming = service.resume(context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: run.id,
    })
    await reconciling
    triggerDeadline()
    const result = await resuming
    const loaded = workflowRuns.get({ projectId: 'project-1', canvasId: 'canvas-1' }, run.id)

    expect(result.status).toBe('partial')
    expect(result.errorCode).toBe('CANVAS_WORKFLOW_BUDGET_EXHAUSTED')
    expect(loaded.status).toBe('waiting-budget')
    expect(loaded.cancelRequestedAt).toBeNull()
    expect(loaded.cancelledAt).toBeNull()
    expect(loaded.budget.remainingDurationMs).toBe(0)
    expect(loaded.budget.activeStartedAt).toBeNull()
    expect(loaded.nodes[0]?.execution).toEqual({
      kind: 'media', operationId: 'owned-media-operation', mediaRunId: 'media-run-1', outputKeys: [],
    })
    expect(submissions).toBe(0)
  })

  test('Given 权威失败图片节点 When 显式扩额重试 Then 使用新 operation 且同一恢复请求不重复生成', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-retry-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: (() => { let value = 100; return () => value += 1 })(),
    })
    const image: CanvasNode = {
      id: 'image', title: 'image', position: { x: 0, y: 0 }, kind: 'image', imageModuleId: 'image-module',
    }
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3, nodes: [image],
    }
    const snapshot = createCanvasWorkflowPlanSnapshot(document, { startNodeIds: ['image'], maxImageRuns: 1 })
    let run = workflowRuns.create({
      projectId: 'project-1', canvasId: 'canvas-1', operationId: 'tool-retry-image',
      owner: { sessionId: 'parent-session', runStartedAt: 10 }, initialCanvasRevision: 3,
      rootNodeIds: snapshot.rootNodeIds, goal: '重试图片', nodes: snapshot.nodes,
      maxMediaRuns: 1, consumedMediaRuns: 1, autoResumeAfterAdoption: true,
    })
    run.nodes[0]!.status = 'failed'
    run.nodes[0]!.errorCode = 'CANVAS_IMAGE_RUN_FAILED'
    run.nodes[0]!.execution = {
      kind: 'image', operationId: 'old-image-operation', batchId: 'old-batch', taskId: 'old-task',
    }
    run.nodes[0]!.retryDisposition = 'terminal-failed'
    run = workflowRuns.save(run, run.revision)
    const operations: string[] = []
    const imageRunStartedAts: number[] = []
    const service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document), validateAccess: () => undefined, isAgentBusy: () => false,
      agentExecution: { execute: async () => ({ status: 'errored' }) },
      imageRuns: {
        run: async (runContext, _target, _nodes, operationId) => {
          imageRunStartedAts.push(runContext.runStartedAt)
          operations.push(operationId)
          return { tasks: [{ nodeId: 'image', status: 'started', taskId: 'new-task' }],
            batch: { batchId: 'new-batch', status: 'running', totalCount: 1, candidateCount: 0,
              failedCount: 0, runningCount: 1, requiresCanvasReview: true } }
        },
        awaitBatch: async () => ({ batchId: 'new-batch', status: 'ready', totalCount: 1, candidateCount: 1,
          failedCount: 0, runningCount: 0, requiresCanvasReview: true,
          entries: [{ nodeId: 'image', taskId: 'new-task', status: 'candidate' }] }),
        cancelTasks: async () => undefined,
      },
      workflowRuns, now: () => 200, setDeadline: () => ({ cancel: () => undefined }),
    })
    const context = { projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 999,
      explicitReferences: [], permissionCeiling: 'execute' as const }
    const resumeInput = { projectId: 'project-1', canvasId: 'canvas-1', runId: run.id,
      expectedRunRevision: run.revision, resumeOperationId: 'resume-retry-image',
      addMediaRuns: 1, retryNodeIds: ['image'] }

    await service.resume(context, resumeInput)
    await service.resume(context, resumeInput)
    const retried = workflowRuns.get(resumeInput, run.id)

    expect(operations).toHaveLength(1)
    expect(operations[0]).not.toBe('old-image-operation')
    expect(imageRunStartedAts).toEqual([10])
    expect(retried.nodes[0]?.executionHistory).toEqual([{
      kind: 'image', operationId: 'old-image-operation', batchId: 'old-batch', taskId: 'old-task',
    }])
    expect(retried.nodes[0]?.status).toBe('waiting-adoption')
  })

  test('Given 图片提交回执丢失 When 后续轮次恢复 Then 用原 operation 对账且不重复扣费', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-image-unknown-submit-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    let clock = 100
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: () => clock,
    })
    const image: CanvasNode = {
      id: 'image', title: 'image', position: { x: 0, y: 0 }, kind: 'image', imageModuleId: 'image-module',
    }
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3, nodes: [image],
    }
    const operations: string[] = []
    const runStartedAts: number[] = []
    const service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document), validateAccess: () => undefined, isAgentBusy: () => false,
      agentExecution: { execute: async () => ({ status: 'errored' }) },
      imageRuns: {
        run: async (runContext, _target, _nodes, operationId) => {
          operations.push(operationId)
          runStartedAts.push(runContext.runStartedAt)
          if (operations.length === 1) throw new Error('CANVAS_IMAGE_SUBMISSION_RESPONSE_LOST')
          return {
            tasks: [{ nodeId: 'image', status: 'started', taskId: 'task-recovered' }],
            batch: {
              batchId: 'batch-recovered', status: 'running', totalCount: 1,
              candidateCount: 0, failedCount: 0, runningCount: 1, requiresCanvasReview: true,
            },
          }
        },
        awaitBatch: async () => ({
          batchId: 'batch-recovered', status: 'ready', totalCount: 1,
          candidateCount: 1, failedCount: 0, runningCount: 0, requiresCanvasReview: true,
          entries: [{ nodeId: 'image', taskId: 'task-recovered', status: 'candidate' }],
        }),
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      now: () => clock,
      setDeadline: () => ({ cancel: () => undefined }),
    })
    const originalContext = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    const failed = await service.execute(originalContext, {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['image'],
      goal: '恢复图片提交', maxImageRuns: 1,
    }, 'tool-image-unknown-submit')
    const failedRun = workflowRuns.list({ projectId: 'project-1', canvasId: 'canvas-1' })[0]!
    expect(failed.status).toBe('partial')
    expect(failedRun.nodes[0]).toMatchObject({
      status: 'failed', retryDisposition: 'submission-unknown',
      execution: { kind: 'image', batchId: null, taskId: null },
    })

    clock = 200
    const resumed = await service.resume({ ...originalContext, runStartedAt: 999 }, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: failedRun.id,
    })
    const recovered = workflowRuns.get({ projectId: 'project-1', canvasId: 'canvas-1' }, failedRun.id)

    expect(resumed.status).toBe('waiting-review')
    expect(operations).toHaveLength(2)
    expect(operations[1]).toBe(operations[0])
    expect(runStartedAts).toEqual([10, 10])
    expect(recovered.budget.consumedMediaRuns).toBe(1)
    expect(recovered.nodes[0]).toMatchObject({
      status: 'waiting-adoption', retryDisposition: 'none',
      execution: { kind: 'image', batchId: 'batch-recovered', taskId: 'task-recovered' },
      executionHistory: [],
    })
  })

  test('Given 非 owner 或已中止请求携带恢复 amendment When resume Then 在扩额前拒绝且 journal 不变', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-resume-owner-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: { resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']> },
      runWorkspaceWrite: (_projectId, effect) => effect(), now: () => 100,
    })
    const agent: CanvasNode = { id: 'agent', title: 'agent', position: { x: 0, y: 0 }, kind: 'agent', agentSessionId: 'child' }
    const document: CanvasDocument = { ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3, nodes: [agent] }
    const snapshot = createCanvasWorkflowPlanSnapshot(document, { startNodeIds: ['agent'], maxImageRuns: 0 })
    const run = workflowRuns.create({ projectId: 'project-1', canvasId: 'canvas-1', operationId: 'owner-test',
      owner: { sessionId: 'owner', runStartedAt: 10 }, initialCanvasRevision: 3, rootNodeIds: snapshot.rootNodeIds,
      goal: '验证 owner', nodes: snapshot.nodes, maxMediaRuns: 0, consumedMediaRuns: 0, autoResumeAfterAdoption: false })
    const service = createCanvasWorkflowExecutionService({ load: () => document, validateAccess: () => undefined,
      isAgentBusy: () => false, agentExecution: { execute: async () => ({ status: 'errored' }) },
      imageRuns: { run: async () => ({ tasks: [] }), awaitBatch: async () => { throw new Error('UNEXPECTED') },
        cancelTasks: async () => undefined }, workflowRuns, now: () => 100,
      setDeadline: () => ({ cancel: () => undefined }) })
    const input = { projectId: 'project-1', canvasId: 'canvas-1', runId: run.id,
      expectedRunRevision: run.revision, resumeOperationId: 'resume-owner-test', addDurationMs: 1 }
    const intruder = { projectId: 'project-1', sessionId: 'intruder', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const }
    await expect(service.resume(intruder, input)).rejects.toThrow('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
    expect(workflowRuns.get(input, run.id).revision).toBe(run.revision)
    const controller = new AbortController()
    controller.abort('cancel')
    const owner = { ...intruder, sessionId: 'owner' }
    await expect(service.resume(owner, input, controller.signal)).rejects.toThrow('CANVAS_WORKFLOW_ABORTED')
    expect(workflowRuns.get(input, run.id).revision).toBe(run.revision)
  })

  test('Given 取消意图已落盘但进程退出 When 重启恢复 Then 不再推进并从意图时刻停止计时', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-cancel-recovery-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: () => 200,
    })
    const image: CanvasNode = {
      id: 'image', title: 'image', position: { x: 0, y: 0 }, kind: 'image', imageModuleId: 'image-module',
    }
    const document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3, nodes: [image],
    }
    const snapshot = createCanvasWorkflowPlanSnapshot(document, { startNodeIds: ['image'], maxImageRuns: 1 })
    let run = workflowRuns.create({
      projectId: 'project-1', canvasId: 'canvas-1', operationId: 'tool-cancel-recovery',
      owner: { sessionId: 'parent-session', runStartedAt: 10 }, initialCanvasRevision: 3,
      rootNodeIds: snapshot.rootNodeIds, goal: '恢复取消事实', nodes: snapshot.nodes,
      maxMediaRuns: 1, consumedMediaRuns: 0, autoResumeAfterAdoption: true,
    })
    run.nodes[0]!.status = 'failed'
    run.nodes[0]!.errorCode = 'CANVAS_IMAGE_SUBMISSION_RESPONSE_LOST'
    run.nodes[0]!.execution = {
      kind: 'image', operationId: 'unknown-image-operation', batchId: null, taskId: null,
    }
    run.nodes[0]!.retryDisposition = 'submission-unknown'
    run.cancelRequestedAt = 250
    run = workflowRuns.save(run, run.revision)
    let loads = 0
    const service = createCanvasWorkflowExecutionService({
      load: () => { loads += 1; return structuredClone(document) },
      validateAccess: () => undefined,
      isAgentBusy: () => false,
      agentExecution: { execute: async () => ({ status: 'errored' }) },
      imageRuns: {
        run: async () => ({ tasks: [] }), awaitBatch: async () => { throw new Error('UNEXPECTED') },
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      now: () => 1_000,
      setDeadline: () => { throw new Error('UNEXPECTED_DEADLINE') },
    })
    const context = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    const result = await service.resume(context, {
      projectId: 'project-1', canvasId: 'canvas-1', runId: run.id,
    })
    const loaded = workflowRuns.get({ projectId: 'project-1', canvasId: 'canvas-1' }, run.id)

    expect(result.status).toBe('cancelled')
    expect(loaded.budget.remainingDurationMs).toBe(15 * 60_000 - 50)
    expect(loaded.budget.activeStartedAt).toBeNull()
    expect(loads).toBe(0)
  })

  test('Given Host 创建事务点名当前专业分支后继 When 登记并重启 Then 只持久化确切新节点且重放幂等', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-dynamic-successor-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: (() => { let value = 100; return () => value += 1 })(),
    })
    const agent: CanvasNode = {
      id: 'agent-root', title: 'agent', position: { x: 0, y: 0 }, kind: 'agent', agentSessionId: 'agent-session',
    }
    const unrelated: CanvasNode = {
      id: 'existing-unrelated', title: 'old', position: { x: 10, y: 0 }, kind: 'agent', agentSessionId: 'old-session',
    }
    let document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3,
      nodes: [agent, unrelated], edges: [],
    }
    const snapshot = createCanvasWorkflowPlanSnapshot(document, { startNodeIds: [agent.id], maxImageRuns: 1 })
    let run = workflowRuns.create({
      projectId: 'project-1', canvasId: 'canvas-1', operationId: 'tool-dynamic-successor',
      owner: { sessionId: 'parent-session', runStartedAt: 10 }, initialCanvasRevision: 3,
      rootNodeIds: snapshot.rootNodeIds, goal: '创建后继文档', nodes: snapshot.nodes,
      maxMediaRuns: 1, consumedMediaRuns: 0, autoResumeAfterAdoption: true,
    })
    run.nodes[0]!.status = 'running'
    run.nodes[0]!.execution = { kind: 'agent', operationId: 'root-agent-operation' }
    run = workflowRuns.save(run, run.revision)
    const created: CanvasNode = {
      id: 'created-document', title: 'created', position: { x: 20, y: 0 },
      kind: 'document', documentId: 'created-content', contentRevision: 1,
    }
    document = {
      ...document,
      revision: 4,
      nodes: [...document.nodes, created],
      edges: [createCanvasBoundEdge(agent, created, {
        id: 'edge-agent-created', sourceNodeId: agent.id,
        targetNodeId: created.id, relation: 'depends-on',
      })],
    }
    const createService = () => createCanvasWorkflowExecutionService({
      load: () => structuredClone(document), validateAccess: () => undefined, isAgentBusy: () => false,
      agentExecution: { execute: async () => ({ status: 'errored' }) },
      imageRuns: {
        run: async () => ({ tasks: [] }), awaitBatch: async () => { throw new Error('UNEXPECTED') },
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      now: () => 500,
      setDeadline: () => ({ cancel: () => undefined }),
    })
    const childContext = {
      projectId: 'project-1', sessionId: 'agent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
      canvasAgentMode: 'parent-orchestrated' as const,
      canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: agent.id },
      parentWorkflow: { runId: run.id, parentSessionId: 'parent-session' },
    }

    const service = createService()
    const registered = await service.registerCreatedSuccessor(childContext, {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: created.id, sourceToolCallId: 'child-tool-create',
    })
    const replayed = await service.registerCreatedSuccessor(childContext, {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: created.id, sourceToolCallId: 'child-tool-create',
    })
    const persisted = workflowRuns.get({ projectId: 'project-1', canvasId: 'canvas-1' }, run.id)

    expect(registered.status).toBe('registered')
    expect(replayed.status).toBe('already-registered')
    expect(persisted.nodes.map((node) => node.nodeId)).toEqual(['agent-root', 'created-document'])
    expect(persisted.nodes[1]).toMatchObject({ status: 'satisfied', dependencyNodeIds: ['agent-root'] })
    await expect(service.registerCreatedSuccessor({ ...childContext, runStartedAt: 11 }, {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: created.id, sourceToolCallId: 'child-tool-create',
    })).rejects.toThrow('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
    await expect(service.registerCreatedSuccessor({ ...childContext, sessionId: 'stale-agent-session' }, {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: created.id, sourceToolCallId: 'child-tool-create',
    })).rejects.toThrow('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_BRANCH_INACTIVE')
  })

  test('Given 创建节点无法通过动态计划校验 When 登记失败 Then 精确节点跨重启阻断父流程且不纳入无关分支', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-dynamic-blocked-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: { resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']> },
      runWorkspaceWrite: (_projectId, effect) => effect(), now: () => 100,
    })
    const agent: CanvasNode = { id: 'agent-root', title: 'agent', position: { x: 0, y: 0 }, kind: 'agent', agentSessionId: 'agent-session' }
    const created: CanvasNode = { id: 'created-document', title: 'created', position: { x: 10, y: 0 }, kind: 'document', documentId: 'created-content', contentRevision: 1 }
    const unrelated: CanvasNode = { id: 'unrelated', title: 'unrelated', position: { x: 20, y: 0 }, kind: 'document', documentId: 'unrelated-content', contentRevision: 1 }
    const document: CanvasDocument = { ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 4,
      nodes: [agent, created, unrelated], edges: [] }
    const snapshot = createCanvasWorkflowPlanSnapshot({ ...document, revision: 3, nodes: [agent] }, { startNodeIds: [agent.id], maxImageRuns: 1 })
    let run = workflowRuns.create({ projectId: 'project-1', canvasId: 'canvas-1', operationId: 'tool-blocked-successor',
      owner: { sessionId: 'parent-session', runStartedAt: 10 }, initialCanvasRevision: 3,
      rootNodeIds: snapshot.rootNodeIds, goal: '创建后继', nodes: snapshot.nodes,
      maxMediaRuns: 1, consumedMediaRuns: 0, autoResumeAfterAdoption: true })
    run.nodes[0]!.status = 'running'
    run.nodes[0]!.execution = { kind: 'agent', operationId: 'root-agent-operation' }
    run = workflowRuns.save(run, run.revision)
    const service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document), validateAccess: () => undefined, isAgentBusy: () => false,
      agentExecution: { execute: async () => ({ status: 'errored' }) },
      imageRuns: { run: async () => ({ tasks: [] }), awaitBatch: async () => { throw new Error('UNEXPECTED') }, cancelTasks: async () => undefined },
      workflowRuns, now: () => 110, setDeadline: () => ({ cancel: () => undefined }),
    })
    const childContext = { projectId: 'project-1', sessionId: 'agent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const, canvasAgentMode: 'parent-orchestrated' as const,
      canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: agent.id },
      parentWorkflow: { runId: run.id, parentSessionId: 'parent-session' } }

    const blocked = await service.registerCreatedSuccessor(childContext, {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: created.id, sourceToolCallId: 'child-create-unbound',
    })
    const stored = workflowRuns.get(document, run.id)
    expect(blocked).toMatchObject({ status: 'blocked', reasonCode: 'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_NOT_BOUND' })
    expect(stored.status).toBe('partial')
    expect(stored.nodes.map((node) => node.nodeId)).toEqual(['agent-root', 'created-document'])
    expect(stored.nodes[1]).toMatchObject({ status: 'blocked', dependencyNodeIds: ['agent-root'],
      errorCode: 'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_NOT_BOUND' })

    const completed = structuredClone(stored)
    completed.nodes[0]!.status = 'completed'
    completed.nodes[0]!.errorCode = null
    completed.nodes[0]!.completedArtifactHash = 'a'.repeat(64)
    completed.nodes[0]!.completedAt = 120
    workflowRuns.save(completed, stored.revision)
    const restarted = workflowRuns.get(document, run.id)
    expect(restarted.status).toBe('partial')
    expect(restarted.nodes[1]).toMatchObject({ nodeId: created.id, status: 'blocked' })
    expect(restarted.nodes.some((node) => node.nodeId === unrelated.id)).toBe(false)
  })

  test('Given child 执行中登记后继提高 journal revision When child 返回 Then 父驱动 fresh-read 合并完成事实', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-dynamic-race-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: (() => { let value = 100; return () => value += 1 })(),
    })
    const agent: CanvasNode = {
      id: 'agent-root', title: 'agent', position: { x: 0, y: 0 }, kind: 'agent', agentSessionId: 'agent-session',
    }
    const unrelated: CanvasNode = {
      id: 'existing-unrelated', title: 'old', position: { x: 10, y: 0 }, kind: 'agent', agentSessionId: 'old-session',
    }
    const created: CanvasNode = {
      id: 'created-document', title: 'created', position: { x: 20, y: 0 },
      kind: 'document', documentId: 'created-content', contentRevision: 1,
    }
    let document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3,
      nodes: [agent, unrelated], edges: [],
    }
    let service: ReturnType<typeof createCanvasWorkflowExecutionService>
    service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document), validateAccess: () => undefined, isAgentBusy: () => false,
      agentExecution: {
        execute: async (request) => {
          if (request.mode !== 'parent-orchestrated') throw new Error('UNEXPECTED_AGENT_MODE')
          document = {
            ...document,
            revision: 4,
            nodes: [...document.nodes, created],
            edges: [
              createCanvasBoundEdge(agent, created, {
                id: 'edge-agent-created', sourceNodeId: agent.id,
                targetNodeId: created.id, relation: 'depends-on',
              }),
              createCanvasBoundEdge(agent, unrelated, {
                id: 'edge-agent-unrelated', sourceNodeId: agent.id,
                targetNodeId: unrelated.id, relation: 'depends-on',
              }),
            ],
          }
          const registration = await service.registerCreatedSuccessor({
            projectId: 'project-1', sessionId: 'agent-session', runStartedAt: 10,
            explicitReferences: [], permissionCeiling: 'execute',
            canvasAgentMode: 'parent-orchestrated',
            canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: agent.id },
            parentWorkflow: { runId: request.parentWorkflow!.runId, parentSessionId: 'parent-session' },
          }, {
            projectId: 'project-1', canvasId: 'canvas-1', nodeId: created.id,
            sourceToolCallId: 'child-create-during-run',
          })
          expect(registration.status).toBe('registered')
          return {
            status: 'completed' as const,
            output: {
              target: request.target,
              revision: 4,
              pointer: {
                messageUuid: '11111111-1111-4111-8111-111111111111',
                contentSha256: 'a'.repeat(64), completedAt: 20,
              },
              downstreamNodeIds: [created.id],
            },
          }
        },
      },
      imageRuns: {
        run: async () => ({ tasks: [] }), awaitBatch: async () => { throw new Error('UNEXPECTED') },
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      now: () => 10,
      setDeadline: () => ({ cancel: () => undefined }),
    })
    const parentContext = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    const result = await service.execute(parentContext, {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: [agent.id],
      goal: '创建动态后继', maxImageRuns: 1,
    }, 'tool-dynamic-race')
    const persisted = workflowRuns.list({ projectId: 'project-1', canvasId: 'canvas-1' })[0]!

    expect(result.status).toBe('completed')
    expect(persisted.nodes.map((node) => [node.nodeId, node.status])).toEqual([
      ['agent-root', 'completed'], ['created-document', 'satisfied'],
    ])
  })

  test('Given child 创建未配置 AV 后继并完成 handoff When 父驱动接管 Then 固化配置后只提交一次媒体运行', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-workflow-dynamic-media-'))
    temporaryRoots.push(root)
    const transactionsDir = join(root, 'canvas', 'transactions')
    mkdirSync(transactionsDir, { recursive: true })
    const workflowRuns = createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      now: (() => { let value = 100; return () => value += 1 })(),
    })
    const agent: CanvasNode = {
      id: 'agent-root', title: 'agent', position: { x: 0, y: 0 }, kind: 'agent', agentSessionId: 'agent-session',
    }
    const video: CanvasNode = {
      id: 'created-video', title: 'video', position: { x: 20, y: 0 }, kind: 'video', mediaModuleId: 'video-module',
    }
    let document: CanvasDocument = {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3, nodes: [agent], edges: [],
    }
    let handoffPrepared = false
    let mediaSubmissions = 0
    let service: ReturnType<typeof createCanvasWorkflowExecutionService>
    service = createCanvasWorkflowExecutionService({
      load: () => structuredClone(document), validateAccess: () => undefined, isAgentBusy: () => false,
      agentExecution: {
        execute: async (request) => {
          if (request.mode !== 'parent-orchestrated') throw new Error('UNEXPECTED_AGENT_MODE')
          document = {
            ...document,
            revision: 4,
            nodes: [...document.nodes, video],
            edges: [createCanvasBoundEdge(agent, video, {
              id: 'edge-agent-video', sourceNodeId: agent.id,
              targetNodeId: video.id, relation: 'depends-on',
            })],
          }
          const registration = await service.registerCreatedSuccessor({
            projectId: 'project-1', sessionId: 'agent-session', runStartedAt: 10,
            explicitReferences: [], permissionCeiling: 'execute',
            canvasAgentMode: 'parent-orchestrated',
            canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: agent.id },
            parentWorkflow: { runId: request.parentWorkflow!.runId, parentSessionId: 'parent-session' },
          }, {
            projectId: 'project-1', canvasId: 'canvas-1', nodeId: video.id,
            sourceToolCallId: 'child-create-video',
          })
          expect(registration.status).toBe('registered')
          handoffPrepared = true
          return {
            status: 'completed' as const,
            output: {
              target: request.target, revision: 4,
              pointer: {
                messageUuid: '22222222-2222-4222-8222-222222222222',
                contentSha256: 'b'.repeat(64), completedAt: 20,
              },
              downstreamNodeIds: [video.id],
            },
          }
        },
      },
      imageRuns: {
        run: async () => ({ tasks: [] }), awaitBatch: async () => { throw new Error('UNEXPECTED') },
        cancelTasks: async () => undefined,
      },
      workflowRuns,
      applyPreparedHandoffs: async (run) => {
        const next = structuredClone(run)
        const child = next.nodes.find((node) => node.nodeId === agent.id)
        const plannedVideo = next.nodes.find((node) => node.nodeId === video.id)
        if (handoffPrepared && child?.status === 'completed' && plannedVideo && !plannedVideo.execution
          && plannedVideo.mediaConfigRevision === null) {
          plannedVideo.mediaConfigRevision = 1
          plannedVideo.inputBindings = []
          plannedVideo.status = 'ready'
          plannedVideo.errorCode = null
        }
        return next
      },
      mediaRuns: {
        resolveInputs: async () => ({ configRevision: 1, ready: true, bindings: [] }),
        run: async () => {
          mediaSubmissions += 1
          return {
            status: 'waiting-adoption', mediaRunId: 'dynamic-media-run',
            outputKeys: ['video.main'], errorCode: null,
          }
        },
        reconcile: async (input) => ({
          status: 'waiting-adoption', mediaRunId: input.mediaRunId,
          outputKeys: ['video.main'], errorCode: null,
        }),
        cancel: async () => undefined,
      },
      isMediaOutputAdopted: async () => ({ adopted: false, artifactHash: null, committedAt: null }),
      now: () => 10,
      setDeadline: () => ({ cancel: () => undefined }),
    })
    const parentContext = {
      projectId: 'project-1', sessionId: 'parent-session', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
    }

    const result = await service.execute(parentContext, {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: [agent.id],
      goal: '创建动态视频', maxImageRuns: 1,
    }, 'tool-dynamic-media')
    const persisted = workflowRuns.list({ projectId: 'project-1', canvasId: 'canvas-1' })[0]!
    const persistedVideo = persisted.nodes.find((node) => node.nodeId === video.id)

    expect(result.status).toBe('waiting-review')
    expect(mediaSubmissions).toBe(1)
    expect(persistedVideo).toMatchObject({
      status: 'waiting-adoption', mediaConfigRevision: 1,
      execution: { kind: 'media', mediaRunId: 'dynamic-media-run', outputKeys: ['video.main'] },
    })
  })
})
