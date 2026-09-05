import { describe, expect, test } from 'bun:test'
import { createCanvasBoundEdge } from '@proma/shared'
import type { CanvasDocument, CanvasEdge, CanvasNode } from '@proma/shared'
import {
  CANVAS_WORKFLOW_EDGE_LIMIT,
  CANVAS_WORKFLOW_GRAPH_NODE_LIMIT,
  createCanvasWorkflowPlan,
} from './canvas-workflow-planner'

/** 创建规划测试使用的最小节点，并允许覆盖各类型正式产物状态。 */
function createNode(id: string, kind: CanvasNode['kind'], overrides: Partial<CanvasNode> = {}): CanvasNode {
  const base = { id, title: id, position: { x: 0, y: 0 }, ...overrides }
  switch (kind) {
    case 'agent': return { ...base, kind, agentSessionId: `session-${id}` } as CanvasNode
    case 'image': return { ...base, kind, imageModuleId: `module-${id}` } as CanvasNode
    case 'document': return { ...base, kind, documentId: `document-${id}`, contentRevision: 1 } as CanvasNode
    case 'webview': return {
      ...base, kind, prototypeId: `prototype-${id}`, contentRevision: 1, devicePreset: 'desktop',
    } as CanvasNode
  }
}

/** 创建不经过 I/O 的权威 Canvas 文档测试夹具。 */
function createDocument(nodes: CanvasNode[], edges: CanvasEdge[] = []): CanvasDocument {
  return {
    schemaVersion: 4,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    revision: 7,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    edges,
    createdAt: 1,
    updatedAt: 1,
  }
}

/** 创建两个节点之间经过共享绑定规则验证的执行边。 */
function connect(source: CanvasNode, target: CanvasNode, id: string, relation: 'reference' | 'depends-on' | 'derives' = 'depends-on'): CanvasEdge {
  return createCanvasBoundEdge(source, target, {
    id, sourceNodeId: source.id, targetNodeId: target.id, relation,
  })
}

describe('Canvas Workflow Planner', () => {
  test('Given 请求末端节点 When 规划 Then 只包含请求节点和必要 bound 上游并按拓扑顺序排列', () => {
    const source = createNode('source', 'document')
    const agent = createNode('agent', 'agent')
    const target = createNode('target', 'image')
    const unrelated = createNode('unrelated', 'agent')
    const downstream = createNode('downstream', 'agent')
    const document = createDocument([target, unrelated, source, downstream, agent], [
      connect(source, agent, 'edge-source'),
      connect(agent, target, 'edge-target'),
      connect(target, downstream, 'edge-downstream'),
    ])

    const plan = createCanvasWorkflowPlan({ document, requestedNodeIds: ['target'], maxImageRuns: 1 })

    expect(plan.orderedNodeIds).toEqual(['source', 'agent', 'target'])
    expect(plan.executableNodeIds).toEqual(['agent', 'target'])
    expect(plan.dependenciesByNodeId.get('target')).toEqual(['agent'])
    expect(plan.diagnostics).toEqual([])
  })

  test('Given 仅 association 和非请求待更新节点 When 规划 Then 不扩大执行范围', () => {
    const source = createNode('source', 'agent', { upstreamChange: { sourceNodeIds: ['older'], changedAt: 3 } })
    const target = createNode('target', 'image')
    const document = createDocument([source, target], [createCanvasBoundEdge(source, target, {
      id: 'association', sourceNodeId: source.id, targetNodeId: target.id, relation: 'association',
    })])

    const emptyPlan = createCanvasWorkflowPlan({ document, requestedNodeIds: [], maxImageRuns: 1 })
    const targetPlan = createCanvasWorkflowPlan({ document, requestedNodeIds: ['target'], maxImageRuns: 1 })

    expect(emptyPlan.orderedNodeIds).toEqual([])
    expect(emptyPlan.executableNodeIds).toEqual([])
    expect(targetPlan.orderedNodeIds).toEqual(['target'])
    expect(targetPlan.executableNodeIds).toEqual(['target'])
  })

  test('Given 已有正式产物且无待更新 When 规划 Then Agent 与采用图片满足依赖且候选图片不可替代 adoptedAssetId', () => {
    const completedAgent = createNode('completed-agent', 'agent', {
      outputPointer: {
        messageUuid: '11111111-1111-4111-8111-111111111111',
        contentSha256: 'a'.repeat(64),
        completedAt: 10,
      },
    })
    const adoptedImage = createNode('adopted-image', 'image', { adoptedAssetId: 'asset-1' })
    const candidateOnlyImage = createNode('candidate-only', 'image')
    const document = createDocument([completedAgent, adoptedImage, candidateOnlyImage])

    const plan = createCanvasWorkflowPlan({
      document,
      requestedNodeIds: ['completed-agent', 'adopted-image', 'candidate-only'],
      maxImageRuns: 1,
    })

    expect(plan.initialStates.get('completed-agent')).toBe('satisfied')
    expect(plan.initialStates.get('adopted-image')).toBe('satisfied')
    expect(plan.initialStates.get('candidate-only')).toBe('started')
    expect(plan.executableNodeIds).toEqual(['candidate-only'])
  })

  test('Given Document 与 WebView 待更新 When 规划 Then 不运行模型并阻断依赖它们的目标', () => {
    const documentNode = createNode('document', 'document', {
      upstreamChange: { sourceNodeIds: ['source'], changedAt: 5 },
    })
    const webview = createNode('webview', 'webview')
    const target = createNode('target', 'agent')
    const canvas = createDocument([documentNode, webview, target], [
      connect(documentNode, target, 'edge-document'),
      connect(webview, target, 'edge-webview'),
    ])

    const plan = createCanvasWorkflowPlan({ document: canvas, requestedNodeIds: ['target'], maxImageRuns: 0 })

    expect(plan.executableNodeIds).toEqual([])
    expect(plan.initialStates.get('document')).toBe('blocked')
    expect(plan.initialStates.get('webview')).toBe('satisfied')
    expect(plan.initialStates.get('target')).toBe('blocked')
    expect(plan.diagnostics).toContainEqual({
      code: 'CANVAS_WORKFLOW_NON_RUNNABLE_INPUT_STALE', nodeId: 'document', edgeId: null,
    })
  })

  test('Given 悬空边与非法绑定进入请求范围 When 规划 Then 产生诊断并阻止相应节点运行', () => {
    const source = createNode('source', 'document')
    const invalidTarget = createNode('invalid-target', 'agent')
    const danglingTarget = createNode('dangling-target', 'image')
    const canvas = createDocument([source, invalidTarget, danglingTarget], [
      {
        id: 'invalid-edge', sourceNodeId: source.id, sourcePort: 'document.markdown',
        targetNodeId: invalidTarget.id, targetPort: 'context.image', relation: 'reference',
      },
      {
        id: 'dangling-edge', sourceNodeId: 'missing', sourcePort: 'image.asset',
        targetNodeId: danglingTarget.id, targetPort: 'image.reference', relation: 'reference',
      },
    ])

    const plan = createCanvasWorkflowPlan({
      document: canvas,
      requestedNodeIds: ['invalid-target', 'dangling-target'],
      maxImageRuns: 1,
    })

    expect(plan.executableNodeIds).toEqual([])
    expect(plan.initialStates.get('invalid-target')).toBe('blocked')
    expect(plan.initialStates.get('dangling-target')).toBe('blocked')
    expect(plan.diagnostics).toEqual([
      { code: 'CANVAS_WORKFLOW_EDGE_INCOMPATIBLE', nodeId: 'invalid-target', edgeId: 'invalid-edge' },
      { code: 'CANVAS_WORKFLOW_EDGE_DANGLING', nodeId: 'dangling-target', edgeId: 'dangling-edge' },
    ])
  })

  test('Given 请求范围包含环 When 规划 Then 有界发现环并只阻断环及其依赖节点', () => {
    const first = createNode('first', 'agent')
    const second = createNode('second', 'agent')
    const independent = createNode('independent', 'agent')
    const canvas = createDocument([first, second, independent], [
      connect(first, second, 'edge-first'),
      connect(second, first, 'edge-second'),
    ])

    const plan = createCanvasWorkflowPlan({
      document: canvas,
      requestedNodeIds: ['second', 'independent'],
      maxImageRuns: 0,
    })

    expect(plan.executableNodeIds).toEqual(['independent'])
    expect(plan.initialStates.get('first')).toBe('blocked')
    expect(plan.initialStates.get('second')).toBe('blocked')
    expect(plan.diagnostics).toContainEqual({
      code: 'CANVAS_WORKFLOW_CYCLE', nodeId: 'first', edgeId: null,
    })
  })

  test('Given 图片运行数超过本次授权 When 规划 Then 稳定保留前 N 个并将其余标记等待审批', () => {
    const first = createNode('image-a', 'image')
    const second = createNode('image-b', 'image')
    const canvas = createDocument([first, second])

    const plan = createCanvasWorkflowPlan({
      document: canvas,
      requestedNodeIds: ['image-a', 'image-b'],
      maxImageRuns: 1,
    })

    expect(plan.executableNodeIds).toEqual(['image-a'])
    expect(plan.initialStates.get('image-a')).toBe('started')
    expect(plan.initialStates.get('image-b')).toBe('waiting-approval')
  })

  test('Given 超出节点、边、Agent 或深度上限 When 规划 Then 在任何执行许可产生前稳定拒绝', () => {
    const tooManyNodes = Array.from(
      { length: CANVAS_WORKFLOW_GRAPH_NODE_LIMIT + 1 },
      (_, index) => createNode(`node-${index}`, 'document'),
    )
    expect(() => createCanvasWorkflowPlan({
      document: createDocument(tooManyNodes), requestedNodeIds: [], maxImageRuns: 0,
    })).toThrow('CANVAS_WORKFLOW_GRAPH_NODE_LIMIT_EXCEEDED')

    const edgeSource = createNode('edge-source', 'document')
    const edgeTarget = createNode('edge-target', 'agent')
    const tooManyEdges = Array.from(
      { length: CANVAS_WORKFLOW_EDGE_LIMIT + 1 },
      (_, index) => connect(edgeSource, edgeTarget, `edge-${index}`),
    )
    expect(() => createCanvasWorkflowPlan({
      document: createDocument([edgeSource, edgeTarget], tooManyEdges),
      requestedNodeIds: ['edge-target'], maxImageRuns: 0,
    })).toThrow('CANVAS_WORKFLOW_EDGE_LIMIT_EXCEEDED')

    const agents = Array.from({ length: 9 }, (_, index) => createNode(`agent-${index}`, 'agent'))
    const agentEdges = agents.slice(1).map((target, index) => connect(agents[index]!, target, `agent-edge-${index}`))
    expect(() => createCanvasWorkflowPlan({
      document: createDocument(agents, agentEdges), requestedNodeIds: ['agent-8'], maxImageRuns: 0,
    })).toThrow('CANVAS_WORKFLOW_AGENT_LIMIT_EXCEEDED')

    const deepNodes = Array.from({ length: 10 }, (_, index) => createNode(`depth-${index}`, 'document'))
    const deepEdges = deepNodes.slice(1).map((target, index) => connect(deepNodes[index]!, target, `depth-edge-${index}`))
    expect(() => createCanvasWorkflowPlan({
      document: createDocument(deepNodes, deepEdges), requestedNodeIds: ['depth-9'], maxImageRuns: 0,
    })).toThrow('CANVAS_WORKFLOW_DEPTH_LIMIT_EXCEEDED')
  })

  test('Given 重复请求、未知节点和非法图片预算 When 规划 Then 严格拒绝歧义输入', () => {
    const node = createNode('node', 'agent')
    const document = createDocument([node])

    expect(() => createCanvasWorkflowPlan({ document, requestedNodeIds: ['node', 'node'], maxImageRuns: 0 }))
      .toThrow('CANVAS_WORKFLOW_REQUEST_INVALID')
    expect(() => createCanvasWorkflowPlan({ document, requestedNodeIds: ['missing'], maxImageRuns: 0 }))
      .toThrow('CANVAS_WORKFLOW_REQUEST_NODE_NOT_FOUND')
    expect(() => createCanvasWorkflowPlan({ document, requestedNodeIds: ['node'], maxImageRuns: 17 }))
      .toThrow('CANVAS_WORKFLOW_IMAGE_RUN_LIMIT_INVALID')
  })
})
