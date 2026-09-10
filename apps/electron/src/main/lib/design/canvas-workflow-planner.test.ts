import { describe, expect, test } from 'bun:test'
import { createCanvasBoundEdge, createEmptyCanvasDocument, parseCanvasWorkflowRun } from '@proma/shared'
import type { CanvasDocument, CanvasNode, CanvasWorkflowRun } from '@proma/shared'
import {
  createCanvasWorkflowDynamicSuccessorAmendment,
  createCanvasWorkflowPlanSnapshot,
  prepareCanvasWorkflowMediaInputs,
  reconcileCanvasWorkflowRun,
} from './canvas-workflow-planner'

/** 创建 planner 测试使用的最小节点。 */
function createNode(id: string, kind: CanvasNode['kind']): CanvasNode {
  const base = { id, title: id, position: { x: 0, y: 0 } }
  switch (kind) {
    case 'agent': return { ...base, kind, agentSessionId: `session-${id}` }
    case 'image': return { ...base, kind, imageModuleId: `image-${id}` }
    case 'audio':
    case 'video': return { ...base, kind, mediaModuleId: `media-${id}` }
    case 'document': return { ...base, kind, documentId: `document-${id}`, contentRevision: 1 }
    case 'webview': return {
      ...base, kind, prototypeId: `webview-${id}`, contentRevision: 1, devicePreset: 'desktop',
    }
  }
}

/** 创建带稳定 bound 边的 Canvas 文档。 */
function createDocument(
  nodes: CanvasNode[],
  pairs: Array<[CanvasNode, CanvasNode]>,
  revision = 3,
): CanvasDocument {
  return {
    ...createEmptyCanvasDocument('project-1', 'canvas-1', 1),
    revision,
    nodes,
    edges: pairs.map(([source, target], index) => createCanvasBoundEdge(source, target, {
      id: `edge-${index}-${source.id}-${target.id}`,
      sourceNodeId: source.id,
      targetNodeId: target.id,
      relation: 'depends-on',
    })),
  }
}

/** 把首次计划包装为可恢复运行。 */
function createRun(document: CanvasDocument, startNodeIds: string[], maxMediaRuns = 2): CanvasWorkflowRun {
  const snapshot = createCanvasWorkflowPlanSnapshot(document, {
    startNodeIds,
    maxImageRuns: maxMediaRuns,
  })
  return {
    schemaVersion: 1,
    id: 'a'.repeat(48),
    revision: 0,
    projectId: document.projectId,
    canvasId: document.canvasId,
    operationId: 'workflow-operation',
    owner: { sessionId: 'owner-session', runStartedAt: 10 },
    status: 'running',
    initialCanvasRevision: document.revision,
    observedCanvasRevision: document.revision,
    rootNodeIds: snapshot.rootNodeIds,
    goal: '完成当前生产分支',
    nodes: snapshot.nodes,
    budget: {
      maxMediaRuns, consumedMediaRuns: 0, remainingMediaRuns: maxMediaRuns,
      maxDurationMs: 15 * 60_000, remainingDurationMs: 15 * 60_000, activeStartedAt: 10,
    },
    autoResumeAfterAdoption: false,
    cancelRequestedAt: null,
    cancelledAt: null,
    createdAt: 10,
    updatedAt: 10,
  }
}

const noAdoption = async () => ({ adopted: false, artifactHash: null, committedAt: null })

describe('Canvas Workflow Planner', () => {
  test('Given 视频同时输出封面与成片 When 只采用封面 Then 图片后继按固定角色放行且角色改写被拒绝', async () => {
    const video = createNode('video-root', 'video')
    const image = createNode('image-result', 'image')
    const document = createDocument([video, image], [])
    document.edges = [{ id: 'poster-edge', sourceNodeId: video.id, sourcePort: 'image.asset', sourceOutputKey: 'poster.main',
      targetNodeId: image.id, targetPort: 'image.reference', relation: 'reference' }]
    const run = createRun(document, [video.id])
    run.nodes[0]!.status = 'waiting-adoption'
    run.nodes[0]!.execution = { kind: 'media', operationId: 'video-operation', mediaRunId: 'media-run', outputKeys: ['poster.main', 'video.main'] }
    expect(() => parseCanvasWorkflowRun(run)).not.toThrow()
    const facts = { isImageCandidateAdopted: noAdoption,
      isMediaOutputAdopted: async (query: { outputKey: string }) => ({ adopted: query.outputKey === 'poster.main', artifactHash: 'd'.repeat(64), committedAt: 30 }) }
    const result = await reconcileCanvasWorkflowRun(run, document, facts)
    expect(result.readyNodeIds).toEqual(['image-result'])
    expect(result.run.nodes[0]?.status).toBe('waiting-adoption')
    const changed = structuredClone(document)
    changed.edges[0]!.sourceOutputKey = 'poster.other'
    await expect(reconcileCanvasWorkflowRun(run, changed, facts)).rejects.toThrow('CANVAS_WORKFLOW_INPUT_CHANGED')
  })
  test('Given 正式文档或媒体作为起点 When 首次规划 Then 文档满足输入且媒体可进入生成', () => {
    const document = createNode('document-root', 'document')
    const agent = createNode('agent-result', 'agent')
    const audio = createNode('audio-root', 'audio')
    const documentPlan = createCanvasWorkflowPlanSnapshot(
      createDocument([document, agent], [[document, agent]]),
      { startNodeIds: [document.id], maxImageRuns: 1 },
    )
    const audioPlan = createCanvasWorkflowPlanSnapshot(
      createDocument([audio], []),
      { startNodeIds: [audio.id], maxImageRuns: 1 },
    )

    expect(documentPlan.nodes.map((node) => [node.nodeId, node.status])).toEqual([
      ['document-root', 'satisfied'],
      ['agent-result', 'ready'],
    ])
    expect(audioPlan.nodes[0]?.status).toBe('ready')
  })

  test('Given 空内容节点位于 Agent 链路中间 When 上游完成并对账 Then 文档与 WebView 均不释放下游', async () => {
    const cases = ['document', 'webview'] as const

    for (const kind of cases) {
      const root = createNode(`${kind}-root`, 'agent')
      const emptyContent = {
        ...createNode(`${kind}-empty`, kind),
        contentRevision: 0,
      } as CanvasNode
      const target = createNode(`${kind}-target`, 'agent')
      const document = createDocument(
        [root, emptyContent, target],
        [[root, emptyContent], [emptyContent, target]],
      )
      const run = createRun(document, [root.id])
      const rootState = run.nodes.find((node) => node.nodeId === root.id)!
      rootState.status = 'completed'
      rootState.execution = { kind: 'agent', operationId: `${kind}-root-operation` }
      rootState.completedArtifactHash = 'c'.repeat(64)
      rootState.completedAt = 20

      const reconciled = await reconcileCanvasWorkflowRun(run, document, {
        isImageCandidateAdopted: noAdoption,
      })

      expect(reconciled.readyNodeIds).toEqual([])
      expect(reconciled.run.nodes.find((node) => node.nodeId === emptyContent.id)).toMatchObject({
        status: 'blocked', errorCode: 'CANVAS_WORKFLOW_NODE_UNSUPPORTED',
      })
      expect(reconciled.run.nodes.find((node) => node.nodeId === target.id)?.status).toBe('ready')
      expect(reconciled.run.status).toBe('partial')
    }
  })

  test('Given 恢复期间新增范围外后继 When 对账 Then 不扩大首次计划范围', async () => {
    const root = createNode('root', 'agent')
    const image = createNode('image', 'image')
    const original = createDocument([root, image], [[root, image]])
    const run = createRun(original, [root.id])
    const rootState = run.nodes.find((node) => node.nodeId === root.id)!
    rootState.status = 'completed'
    rootState.execution = { kind: 'agent', operationId: 'agent-operation' }
    rootState.completedArtifactHash = 'c'.repeat(64)
    rootState.completedAt = 20
    const added = createNode('new-successor', 'agent')
    const current = createDocument([root, image, added], [[root, image], [root, added]], 4)

    const reconciled = await reconcileCanvasWorkflowRun(run, current, {
      isImageCandidateAdopted: noAdoption,
    })

    expect(reconciled.run.nodes.map((node) => node.nodeId)).toEqual(['root', 'image'])
    expect(reconciled.readyNodeIds).toEqual(['image'])
  })

  test('Given 受管专业 Agent 创建确切 bound 后继 When 登记计划 Then 只追加该节点且排除无关既有节点', () => {
    const root = createNode('root', 'agent')
    const unrelated = createNode('unrelated', 'agent')
    const run = createRun(createDocument([root, unrelated], []), [root.id])
    const created = createNode('created-document', 'document')
    const current = createDocument(
      [root, unrelated, created],
      [[root, created], [root, unrelated]],
      4,
    )

    const amended = createCanvasWorkflowDynamicSuccessorAmendment(run, current, root.id, created.id)

    expect(amended.nodes.map((node) => node.nodeId)).toEqual(['root', 'created-document'])
    expect(amended.nodes[0]).toEqual(run.nodes[0])
    expect(amended.nodes[1]).toMatchObject({
      nodeId: 'created-document', dependencyNodeIds: ['root'], status: 'satisfied',
    })
    expect(amended.observedCanvasRevision).toBe(4)
  })

  test('Given Host 点名未连线节点或依赖范围外旧节点 When 登记动态后继 Then 拒绝扩大原计划', () => {
    const root = createNode('root', 'agent')
    const external = createNode('external', 'document')
    const created = createNode('created-image', 'image')
    const run = createRun(createDocument([root, external], []), [root.id])

    expect(() => createCanvasWorkflowDynamicSuccessorAmendment(
      run,
      createDocument([root, external, created], [], 4),
      root.id,
      created.id,
    )).toThrow('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_NOT_BOUND')
    expect(() => createCanvasWorkflowDynamicSuccessorAmendment(
      run,
      createDocument([root, external, created], [[root, created], [external, created]], 5),
      root.id,
      created.id,
    )).toThrow('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_SCOPE_INVALID')
  })

  test('Given 动态媒体后继但剩余预算为零或运行已取消 When 登记 Then 等待审批且取消后禁止扩展', () => {
    const root = createNode('root', 'agent')
    const created = createNode('created-video', 'video')
    const current = createDocument([root, created], [[root, created]], 4)
    const run = createRun(createDocument([root], []), [root.id], 1)
    run.budget.consumedMediaRuns = 1
    run.budget.remainingMediaRuns = 0

    const amended = createCanvasWorkflowDynamicSuccessorAmendment(run, current, root.id, created.id)
    expect(amended.nodes[1]?.status).toBe('waiting-approval')

    run.cancelRequestedAt = 20
    expect(() => createCanvasWorkflowDynamicSuccessorAmendment(run, current, root.id, created.id))
      .toThrow('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_RUN_CLOSED')
  })

  test('Given 动态后继反向连接已计划根形成环路 When 登记 Then 在计划修订前拒绝', () => {
    const root = createNode('root', 'agent')
    const created = createNode('created-document', 'document')
    const run = createRun(createDocument([root], []), [root.id])
    const cyclic = createDocument([root, created], [[root, created], [created, root]], 4)

    expect(() => createCanvasWorkflowDynamicSuccessorAmendment(run, cyclic, root.id, created.id))
      .toThrow('CANVAS_WORKFLOW_GRAPH_CHANGED')
  })

  test('Given 已完成 Agent When 恢复 Then 不再次进入 ready', async () => {
    const root = createNode('root', 'agent')
    const run = createRun(createDocument([root], []), [root.id])
    run.nodes[0]!.status = 'completed'
    run.nodes[0]!.execution = { kind: 'agent', operationId: 'agent-operation' }
    run.nodes[0]!.completedArtifactHash = 'c'.repeat(64)
    run.nodes[0]!.completedAt = 20

    const reconciled = await reconcileCanvasWorkflowRun(run, createDocument([root], [], 4), {
      isImageCandidateAdopted: noAdoption,
    })

    expect(reconciled.readyNodeIds).toEqual([])
    expect(reconciled.run.status).toBe('completed')
  })

  test('Given 上游失败导致后继阻塞 When 上游显式重试后完成 Then 仅恢复依赖阻塞节点', async () => {
    const root = createNode('root', 'agent')
    const child = createNode('child', 'agent')
    const document = createDocument([root, child], [[root, child]])
    const run = createRun(document, [root.id])
    run.nodes[0]!.status = 'completed'
    run.nodes[0]!.execution = { kind: 'agent', operationId: 'retried-agent-operation' }
    run.nodes[0]!.completedArtifactHash = 'c'.repeat(64)
    run.nodes[0]!.completedAt = 20
    run.nodes[1]!.status = 'blocked'
    run.nodes[1]!.errorCode = 'UPSTREAM_FAILED'

    const reconciled = await reconcileCanvasWorkflowRun(run, document, {
      isImageCandidateAdopted: noAdoption,
    })

    expect(reconciled.readyNodeIds).toEqual(['child'])
    expect(reconciled.run.nodes[1]).toMatchObject({ status: 'ready', errorCode: null })
  })

  test('Given 图片候选等待采用 When exact batch/task 未采用或已采用 Then 只在精确采用后放行后继', async () => {
    const image = createNode('image-root', 'image')
    const agent = createNode('agent-result', 'agent')
    const document = createDocument([image, agent], [[image, agent]])
    const run = createRun(document, [image.id])
    const imageState = run.nodes.find((node) => node.nodeId === image.id)!
    imageState.status = 'waiting-adoption'
    imageState.execution = {
      kind: 'image', operationId: 'image-operation', batchId: 'batch-1', taskId: 'task-1',
    }

    const waiting = await reconcileCanvasWorkflowRun(run, document, {
      isImageCandidateAdopted: noAdoption,
    })
    expect(waiting.readyNodeIds).toEqual([])
    expect(waiting.run.status).toBe('waiting-review')

    const adopted = await reconcileCanvasWorkflowRun(run, document, {
      isImageCandidateAdopted: async (query) => ({
        adopted: query.batchId === 'batch-1' && query.taskId === 'task-1',
        artifactHash: 'd'.repeat(64),
        committedAt: 30,
      }),
    })
    expect(adopted.readyNodeIds).toEqual(['agent-result'])
    expect(adopted.run.nodes.find((node) => node.nodeId === image.id)?.status).toBe('completed')
  })

  test('Given 媒体预算为零 When 规划 Then 生成节点保持等待审批', () => {
    const root = createNode('root', 'agent')
    const image = createNode('image', 'image')
    const run = createRun(createDocument([root, image], [[root, image]]), [root.id], 0)

    expect(run.nodes.find((node) => node.nodeId === image.id)?.status).toBe('waiting-approval')
  })

  test('Given 媒体预算已耗尽但节点持有原 operation When 恢复 Then 允许幂等重放而不再次申请预算', async () => {
    const image = createNode('image', 'image')
    const document = createDocument([image], [])
    const run = createRun(document, [image.id], 1)
    run.budget.consumedMediaRuns = 1
    run.budget.remainingMediaRuns = 0
    run.nodes[0]!.execution = {
      kind: 'image', operationId: 'owned-image-operation', batchId: null, taskId: null,
    }

    const reconciled = await reconcileCanvasWorkflowRun(run, document, {
      isImageCandidateAdopted: noAdoption,
    })

    expect(reconciled.readyNodeIds).toEqual(['image'])
    expect(reconciled.run.nodes[0]?.status).toBe('ready')
    expect(reconciled.run.budget.remainingMediaRuns).toBe(0)
  })

  test('Given 旧 journal 没有时长字段 When 解析 Then 归一化为兼容预算且不丢运行时钟', () => {
    const agent = createNode('agent', 'agent')
    const legacy = structuredClone(createRun(createDocument([agent], []), [agent.id])) as unknown as {
      budget: Record<string, unknown>
      updatedAt: number
    }
    delete legacy.budget.maxDurationMs
    delete legacy.budget.remainingDurationMs
    delete legacy.budget.activeStartedAt

    const parsed = parseCanvasWorkflowRun(legacy)

    expect(parsed.budget.maxDurationMs).toBe(15 * 60_000)
    expect(parsed.budget.remainingDurationMs).toBe(15 * 60_000)
    expect(parsed.budget.activeStartedAt).toBe(legacy.updatedAt)
  })

  test('Given 固定节点新增前置依赖或正式输入版本变化 When 恢复 Then 拒绝使用漂移输入', async () => {
    const document = createNode('document-root', 'document')
    const agent = createNode('agent-result', 'agent')
    const original = createDocument([document, agent], [[document, agent]])
    const run = createRun(original, [document.id])
    const changedDocument: Extract<CanvasNode, { kind: 'document' }> = {
      ...(document as Extract<CanvasNode, { kind: 'document' }>),
      contentRevision: 2,
    }

    await expect(reconcileCanvasWorkflowRun(
      run,
      createDocument([changedDocument, agent], [[changedDocument, agent]], 4),
      { isImageCandidateAdopted: noAdoption },
    )).rejects.toThrow('CANVAS_WORKFLOW_INPUT_CHANGED')
  })

  test('Given 媒体 typed DAG 输入 When 提交前解析 Then 固定配置、来源角色与确切值哈希', () => {
    const audio = createNode('audio-source', 'audio')
    const video = createNode('video-target', 'video')
    const run = createRun(createDocument([audio, video], [[audio, video]]), [audio.id])
    const prepared = prepareCanvasWorkflowMediaInputs(run, video.id, {
      configRevision: 3,
      ready: true,
      bindings: [{
        targetInputKey: 'voice_track',
        requiredKind: 'audio',
        sourceNodeId: audio.id,
        sourceOutputKey: 'voice',
        sourceArtifactHash: 'd'.repeat(64),
        resolvedValue: {
          kind: 'asset',
          asset: { assetId: 'asset-1', revision: 1, hash: 'e'.repeat(64), mediaKind: 'audio' },
        },
        errorCode: null,
      }],
    })

    expect(prepared.node.mediaConfigRevision).toBe(3)
    expect(prepared.node.inputBindings[0]).toEqual({
      targetInputKey: 'voice_track',
      requiredKind: 'audio',
      sourceNodeId: 'audio-source',
      sourceOutputKey: 'voice',
      sourceArtifactHash: 'd'.repeat(64),
      resolvedValueHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  test('Given 媒体节点本次 run 仅采用 voice 输出 When 后继只绑定 voice Then 释放该后继但源节点仍待其它输出采用', async () => {
    const audio = createNode('audio-source', 'audio')
    const video = createNode('video-target', 'video')
    const document = createDocument([audio, video], [[audio, video]])
    const run = createRun(document, [audio.id])
    const source = run.nodes.find((node) => node.nodeId === audio.id)!
    source.status = 'waiting-adoption'
    source.execution = {
      kind: 'media', operationId: 'audio-operation', mediaRunId: 'media-run-1',
      outputKeys: ['voice', 'preview'],
    }
    const target = run.nodes.find((node) => node.nodeId === video.id)!
    target.mediaConfigRevision = 1
    target.inputBindings = [{
      targetInputKey: 'voice_track', requiredKind: 'audio', sourceNodeId: audio.id,
      sourceOutputKey: 'voice', sourceArtifactHash: null, resolvedValueHash: null,
    }]

    const reconciled = await reconcileCanvasWorkflowRun(run, document, {
      isImageCandidateAdopted: noAdoption,
      isMediaOutputAdopted: async (query) => ({
        adopted: query.mediaRunId === 'media-run-1' && query.outputKey === 'voice',
        artifactHash: query.outputKey === 'voice' ? 'f'.repeat(64) : null,
        committedAt: query.outputKey === 'voice' ? 50 : null,
      }),
    })

    expect(reconciled.run.nodes.find((node) => node.nodeId === audio.id)?.status).toBe('waiting-adoption')
    expect(reconciled.readyNodeIds).toEqual(['video-target'])
  })
})
