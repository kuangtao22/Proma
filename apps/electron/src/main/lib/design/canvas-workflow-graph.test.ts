import { describe, expect, test } from 'bun:test'
import { createCanvasBoundEdge } from '@proma/shared'
import type { CanvasDocument, CanvasEdge, CanvasNode } from '@proma/shared'
import {
  CanvasWorkflowGraphError,
  createCanvasWorkflowGraphPlan,
} from './canvas-workflow-graph'

/** 创建工作流图测试使用的四类最小节点。 */
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

/** 创建无 I/O 的 Canvas 文档夹具。 */
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

/** 创建经过共享端口规则验证的正向执行边。 */
function connect(source: CanvasNode, target: CanvasNode, id: string, relation: 'reference' | 'depends-on' | 'derives' = 'depends-on'): CanvasEdge {
  return createCanvasBoundEdge(source, target, {
    id, sourceNodeId: source.id, targetNodeId: target.id, relation,
  })
}

describe('Canvas Workflow Graph', () => {
  test('Given Agent 根与多级图 When 规划 Then 只沿 bound 正向边收集可达后继且根总执行一次', () => {
    const upstream = createNode('upstream', 'document')
    const root = createNode('root', 'agent', {
      outputPointer: {
        messageUuid: '11111111-1111-4111-8111-111111111111',
        contentSha256: 'a'.repeat(64),
        completedAt: 10,
      },
    })
    const documentNode = createNode('document', 'document')
    const image = createNode('image', 'image')
    const association = createNode('association', 'agent')
    const canvas = createDocument([image, association, upstream, root, documentNode], [
      connect(upstream, root, 'edge-upstream'),
      connect(root, documentNode, 'edge-document'),
      connect(documentNode, image, 'edge-image'),
      createCanvasBoundEdge(root, association, {
        id: 'edge-association', sourceNodeId: root.id,
        targetNodeId: association.id, relation: 'association',
      }),
    ])

    const plan = createCanvasWorkflowGraphPlan({ document: canvas, startNodeIds: ['root'], maxImageRuns: 1 })

    expect(plan.rootNodeIds).toEqual(['root'])
    expect(plan.reachableNodeIds).toEqual(['root', 'document', 'image'])
    expect(plan.executableNodeIds).toEqual(['root', 'image'])
    expect(plan.initialStates.get('root')).toBe('started')
    expect(plan.dependenciesByNodeId.get('root')).toEqual([])
    expect(plan.downstreamByNodeId.get('document')).toEqual(['image'])
  })

  test('Given 下游各类正式或待更新产物 When 规划 Then 只运行 stale Agent/Image 且图片仅认 adoptedAssetId', () => {
    const root = createNode('root', 'agent')
    const agentCurrent = createNode('agent-current', 'agent', {
      outputPointer: {
        messageUuid: '22222222-2222-4222-8222-222222222222',
        contentSha256: 'b'.repeat(64),
        completedAt: 10,
      },
    })
    const agentStale = createNode('agent-stale', 'agent', {
      outputPointer: {
        messageUuid: '33333333-3333-4333-8333-333333333333',
        contentSha256: 'c'.repeat(64),
        completedAt: 10,
      },
      upstreamChange: { sourceNodeIds: ['root'], changedAt: 11 },
    })
    const imageCurrent = createNode('image-current', 'image', { adoptedAssetId: 'asset-1' })
    const imageCandidateOnly = createNode('image-candidate-only', 'image')
    const documentNode = createNode('document', 'document')
    const webview = createNode('webview', 'webview')
    const nodes = [root, agentCurrent, agentStale, imageCurrent, imageCandidateOnly, documentNode, webview]
    const canvas = createDocument(nodes, nodes.slice(1).map((target, index) => (
      connect(root, target, `edge-${index}`)
    )))

    const plan = createCanvasWorkflowGraphPlan({ document: canvas, startNodeIds: ['root'], maxImageRuns: 1 })

    expect(plan.initialStates.get('agent-current')).toBe('satisfied')
    expect(plan.initialStates.get('agent-stale')).toBe('started')
    expect(plan.initialStates.get('image-current')).toBe('satisfied')
    expect(plan.initialStates.get('image-candidate-only')).toBe('started')
    expect(plan.initialStates.get('document')).toBe('satisfied')
    expect(plan.initialStates.get('webview')).toBe('satisfied')
    expect(plan.executableNodeIds).toEqual(['root', 'agent-stale', 'image-candidate-only'])
  })

  test('Given 相同图置换 nodes、edges 与 roots When 规划 Then 完整计划和图片预算选择完全一致', () => {
    const rootA = createNode('root-a', 'agent')
    const rootZ = createNode('root-z', 'agent')
    const imageA = createNode('image-a', 'image')
    const imageZ = createNode('image-z', 'image')
    const edges = [connect(rootZ, imageZ, 'edge-z'), connect(rootA, imageA, 'edge-a')]
    const first = createDocument([imageZ, rootZ, imageA, rootA], edges)
    const second = createDocument([rootA, imageA, rootZ, imageZ], [...edges].reverse())

    const firstPlan = createCanvasWorkflowGraphPlan({
      document: first, startNodeIds: ['root-z', 'root-a'], maxImageRuns: 1,
    })
    const secondPlan = createCanvasWorkflowGraphPlan({
      document: second, startNodeIds: ['root-a', 'root-z'], maxImageRuns: 1,
    })

    expect(firstPlan).toEqual(secondPlan)
    expect(firstPlan.executableNodeIds).toEqual(['root-a', 'root-z', 'image-a'])
    expect(firstPlan.initialStates.get('image-z')).toBe('waiting-approval')
  })

  test('Given reachable scope 含 dangling、unresolved 或 incompatible 边 When 规划 Then 预检稳定失败', () => {
    const root = createNode('root', 'agent')
    const target = createNode('target', 'agent')
    const cases: Array<[string, CanvasEdge, string]> = [
      ['dangling', {
        id: 'edge-dangling', sourceNodeId: root.id, sourcePort: 'agent.text',
        targetNodeId: 'missing', targetPort: 'context.text', relation: 'reference',
      }, 'CANVAS_WORKFLOW_EDGE_DANGLING'],
      ['unresolved', {
        id: 'edge-unresolved', sourceNodeId: root.id, sourcePort: 'legacy-output',
        targetNodeId: target.id, targetPort: 'legacy-input', relation: 'reference',
      }, 'CANVAS_WORKFLOW_EDGE_UNRESOLVED'],
      ['incompatible', {
        id: 'edge-incompatible', sourceNodeId: root.id, sourcePort: 'agent.text',
        targetNodeId: target.id, targetPort: 'context.image', relation: 'reference',
      }, 'CANVAS_WORKFLOW_EDGE_INCOMPATIBLE'],
    ]

    for (const [_label, edge, errorCode] of cases) {
      expect(() => createCanvasWorkflowGraphPlan({
        document: createDocument([root, target], [edge]), startNodeIds: ['root'], maxImageRuns: 0,
      })).toThrow(errorCode)
    }
  })

  test('Given duplicate executable edge 顺序置换 When 规划 Then 都以 canonical edge 事实稳定拒绝', () => {
    const root = createNode('root', 'agent')
    const target = createNode('target', 'agent')
    const edgeA = connect(root, target, 'edge-a')
    const edgeZ = connect(root, target, 'edge-z', 'reference')

    const diagnostics = [[edgeZ, edgeA], [edgeA, edgeZ]].map((edges) => {
      try {
        createCanvasWorkflowGraphPlan({
          document: createDocument([target, root], edges), startNodeIds: ['root'], maxImageRuns: 0,
        })
      } catch (error) {
        expect(error).toBeInstanceOf(CanvasWorkflowGraphError)
        return (error as CanvasWorkflowGraphError).diagnostics
      }
      throw new Error('测试预期重复边预检失败')
    })

    expect(diagnostics[0]).toEqual(diagnostics[1])
    expect(diagnostics[0]?.[0]?.edgeId).toBe('edge-z')
  })

  test('Given 多条 reachable 坏边顺序置换 When 预检失败 Then 错误携带同一 canonical 完整边诊断', () => {
    const root = createNode('root', 'agent')
    const target = createNode('target', 'agent')
    const edgeZ: CanvasEdge = {
      id: 'edge-z', sourceNodeId: root.id, sourcePort: 'legacy-z',
      targetNodeId: target.id, targetPort: 'legacy-z', relation: 'reference',
    }
    const edgeA: CanvasEdge = {
      id: 'edge-a', sourceNodeId: root.id, sourcePort: 'legacy-a',
      targetNodeId: target.id, targetPort: 'legacy-a', relation: 'depends-on',
    }
    const diagnostics = [[edgeZ, edgeA], [edgeA, edgeZ]].map((edges) => {
      try {
        createCanvasWorkflowGraphPlan({
          document: createDocument([target, root], edges), startNodeIds: ['root'], maxImageRuns: 0,
        })
      } catch (error) {
        expect(error).toBeInstanceOf(CanvasWorkflowGraphError)
        return (error as CanvasWorkflowGraphError).diagnostics
      }
      throw new Error('测试预期工作流图预检失败')
    })

    expect(diagnostics[0]).toEqual(diagnostics[1])
    expect(diagnostics[0]).toEqual([{
      code: 'CANVAS_WORKFLOW_EDGE_UNRESOLVED',
      edgeId: 'edge-a',
      sourceNodeId: 'root',
      sourcePort: 'legacy-a',
      targetNodeId: 'target',
      targetPort: 'legacy-a',
      relation: 'depends-on',
    }])
  })

  test('Given 多 Agent 根共享后继 When 规划 Then 根去重执行且后继只出现一次', () => {
    const rootA = createNode('root-a', 'agent')
    const rootB = createNode('root-b', 'agent')
    const shared = createNode('shared', 'document')
    const canvas = createDocument([shared, rootB, rootA], [
      connect(rootB, shared, 'edge-b'),
      connect(rootA, shared, 'edge-a'),
    ])

    const plan = createCanvasWorkflowGraphPlan({
      document: canvas, startNodeIds: ['root-b', 'root-a'], maxImageRuns: 0,
    })

    expect(plan.rootNodeIds).toEqual(['root-a', 'root-b'])
    expect(plan.reachableNodeIds).toEqual(['root-a', 'root-b', 'shared'])
    expect(plan.executableNodeIds).toEqual(['root-a', 'root-b'])
    expect(plan.dependenciesByNodeId.get('shared')).toEqual(['root-a', 'root-b'])
  })

  test('Given 可达闭包恰好 32 或 33 节点 When 规划 Then 接受边界并拒绝超限图', () => {
    const root = createNode('root', 'agent')
    const descendants = Array.from(
      { length: 32 },
      (_, index) => createNode(`document-${index.toString().padStart(2, '0')}`, 'document'),
    )
    const withinNodes = [root, ...descendants.slice(0, 31)]
    const withinEdges = descendants.slice(0, 31).map((node, index) => connect(root, node, `edge-${index}`))
    const overNodes = [root, ...descendants]
    const overEdges = descendants.map((node, index) => connect(root, node, `edge-${index}`))

    expect(createCanvasWorkflowGraphPlan({
      document: createDocument(withinNodes, withinEdges), startNodeIds: ['root'], maxImageRuns: 0,
    }).reachableNodeIds).toHaveLength(32)
    expect(() => createCanvasWorkflowGraphPlan({
      document: createDocument(overNodes, overEdges), startNodeIds: ['root'], maxImageRuns: 0,
    })).toThrow('CANVAS_WORKFLOW_NODE_LIMIT_EXCEEDED')
  })

  test('Given 范围外存在坏边 When 规划合法根 Then 无关分支不污染当前执行图', () => {
    const root = createNode('root', 'agent')
    const outsideSource = createNode('outside-source', 'document')
    const outsideTarget = createNode('outside-target', 'agent')
    const canvas = createDocument([outsideTarget, root, outsideSource], [{
      id: 'outside-invalid', sourceNodeId: outsideSource.id, sourcePort: 'document.markdown',
      targetNodeId: outsideTarget.id, targetPort: 'context.image', relation: 'reference',
    }, {
      id: 'outside-dangling', sourceNodeId: 'missing', sourcePort: 'document.markdown',
      targetNodeId: outsideTarget.id, targetPort: 'context.text', relation: 'reference',
    }])

    const plan = createCanvasWorkflowGraphPlan({ document: canvas, startNodeIds: ['root'], maxImageRuns: 0 })

    expect(plan.reachableNodeIds).toEqual(['root'])
    expect(plan.executableNodeIds).toEqual(['root'])
  })

  test('Given 环、深度或 Agent 数量超过固定上限 When 规划 Then 在产生执行计划前拒绝', () => {
    const cycleA = createNode('cycle-a', 'agent')
    const cycleB = createNode('cycle-b', 'agent')
    expect(() => createCanvasWorkflowGraphPlan({
      document: createDocument([cycleA, cycleB], [
        connect(cycleA, cycleB, 'cycle-a-b'), connect(cycleB, cycleA, 'cycle-b-a'),
      ]),
      startNodeIds: ['cycle-a'],
      maxImageRuns: 0,
    })).toThrow('CANVAS_WORKFLOW_CYCLE')

    const deepNodes = [createNode('depth-root', 'agent'), ...Array.from(
      { length: 9 }, (_, index) => createNode(`depth-${index}`, 'document'),
    )]
    const deepEdges = deepNodes.slice(1).map((node, index) => connect(deepNodes[index]!, node, `depth-edge-${index}`))
    expect(() => createCanvasWorkflowGraphPlan({
      document: createDocument(deepNodes, deepEdges), startNodeIds: ['depth-root'], maxImageRuns: 0,
    })).toThrow('CANVAS_WORKFLOW_DEPTH_LIMIT_EXCEEDED')

    const agents = Array.from({ length: 9 }, (_, index) => createNode(`agent-${index}`, 'agent'))
    const agentEdges = agents.slice(1).map((node, index) => connect(agents[index]!, node, `agent-edge-${index}`))
    expect(() => createCanvasWorkflowGraphPlan({
      document: createDocument(agents, agentEdges), startNodeIds: ['agent-0'], maxImageRuns: 0,
    })).toThrow('CANVAS_WORKFLOW_AGENT_LIMIT_EXCEEDED')
  })

  test('Given 非 Agent 根、重复根或非法图片预算 When 规划 Then 严格拒绝输入', () => {
    const root = createNode('root', 'agent')
    const documentNode = createNode('document', 'document')
    const canvas = createDocument([root, documentNode])

    expect(() => createCanvasWorkflowGraphPlan({
      document: canvas, startNodeIds: ['document'], maxImageRuns: 0,
    })).toThrow('CANVAS_WORKFLOW_START_NODE_INVALID')
    expect(() => createCanvasWorkflowGraphPlan({
      document: canvas, startNodeIds: ['root', 'root'], maxImageRuns: 0,
    })).toThrow('CANVAS_WORKFLOW_START_NODE_INVALID')
    expect(() => createCanvasWorkflowGraphPlan({
      document: canvas, startNodeIds: ['root'], maxImageRuns: 17,
    })).toThrow('CANVAS_WORKFLOW_IMAGE_RUN_LIMIT_INVALID')
  })

  test('Given 权威文档节点或边数量超过输入上限 When 规划 Then 建立索引前拒绝', () => {
    const root = createNode('root', 'agent')
    const tooManyNodes = [root, ...Array.from(
      { length: 1_024 }, (_, index) => createNode(`outside-${index}`, 'document'),
    )]
    expect(() => createCanvasWorkflowGraphPlan({
      document: createDocument(tooManyNodes), startNodeIds: ['root'], maxImageRuns: 0,
    })).toThrow('CANVAS_WORKFLOW_GRAPH_NODE_LIMIT_EXCEEDED')

    const associationEdges = Array.from({ length: 4_097 }, (_, index): CanvasEdge => ({
      id: `edge-${index}`,
      sourceNodeId: root.id,
      sourcePort: 'unbound',
      targetNodeId: root.id,
      targetPort: 'unbound',
      relation: 'association',
    }))
    expect(() => createCanvasWorkflowGraphPlan({
      document: createDocument([root], associationEdges), startNodeIds: ['root'], maxImageRuns: 0,
    })).toThrow('CANVAS_WORKFLOW_EDGE_LIMIT_EXCEEDED')
  })
})
