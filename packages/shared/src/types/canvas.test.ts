import { describe, expect, test } from 'bun:test'
import {
  CANVAS_DOCUMENT_VERSION,
  applyCanvasMutations,
  createEmptyCanvasDocument,
} from './canvas'
import type {
  CanvasAgentNode,
  CanvasDocument,
  CanvasEdge,
  CanvasImageNode,
  CanvasMutation,
  CanvasNode,
  CanvasVisualDocumentNode,
  CanvasWebviewNode,
} from './canvas'

/** 测试使用的固定时间，避免文档合同依赖系统时钟。 */
const now = 100

/** Agent 节点只引用独立会话，并保存画布展示标题。 */
const agentNode = {
  id: 'node-agent',
  kind: 'agent',
  title: '设计 Agent',
  position: { x: 10, y: 20 },
  agentSessionId: 'session-1',
} satisfies CanvasAgentNode

/** 图片节点只引用 Canvas 管理的图片素材。 */
const imageNode = {
  id: 'node-image',
  kind: 'image',
  title: '首页主视觉',
  position: { x: 200, y: 20 },
  assetId: 'asset-1',
} satisfies CanvasImageNode

/** 视觉文档节点只引用独立视觉文档。 */
const visualDocumentNode = {
  id: 'node-document',
  kind: 'visual-document',
  title: '品牌规范',
  position: { x: 400, y: 20 },
  visualDocumentId: 'visual-document-1',
} satisfies CanvasVisualDocumentNode

/** Webview 节点只保存可恢复的页面引用。 */
const webviewNode = {
  id: 'node-webview',
  kind: 'webview',
  title: '交互原型',
  position: { x: 600, y: 20 },
  url: 'https://example.com/prototype',
} satisfies CanvasWebviewNode

/** 四类节点组成的联合类型样例，用于锁定 discriminant。 */
const nodeContracts = [agentNode, imageNode, visualDocumentNode, webviewNode] satisfies CanvasNode[]

/** Agent 节点禁止把消息历史复制进 Canvas 文档。 */
// @ts-expect-error messages 归 Agent 会话持久化所有，不属于 Canvas 节点合同。
const agentNodeWithMessages: CanvasAgentNode = { ...agentNode, messages: [] }

/** 节点引用字段必须互斥，避免一个节点同时拥有多个业务身份。 */
// @ts-expect-error Agent 节点不能同时引用图片素材。
const agentNodeWithAsset: CanvasNode = { ...agentNode, assetId: 'asset-1' }

/** 创建带节点和边的测试文档。
 * @returns revision 固定为 7 的独立 Canvas 文档。
 */
function createDocument(): CanvasDocument {
  return {
    ...createEmptyCanvasDocument('project-1', 'canvas-1', now),
    revision: 7,
    nodes: [agentNode, imageNode, visualDocumentNode],
    edges: [
      {
        id: 'edge-agent-image',
        sourceNodeId: agentNode.id,
        sourcePort: 'output',
        targetNodeId: imageNode.id,
        targetPort: 'prompt',
      },
      {
        id: 'edge-document-image',
        sourceNodeId: visualDocumentNode.id,
        sourcePort: 'content',
        targetNodeId: imageNode.id,
        targetPort: 'reference',
      },
    ],
  }
}

describe('Canvas 图共享合同', () => {
  test('Given 项目与 Canvas 身份 When 创建空文档 Then 同时固化两级身份和初始状态', () => {
    /** 新 Canvas 的空文档。 */
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', now)

    expect(document).toEqual({
      schemaVersion: CANVAS_DOCUMENT_VERSION,
      projectId: 'project-1',
      canvasId: 'canvas-1',
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      createdAt: now,
      updatedAt: now,
    })
  })

  test('Given 四类节点 When 读取联合类型 Then discriminant 与唯一引用字段保持对应', () => {
    /** 所有业务引用字段，用于验证每类节点只携带自身引用。 */
    const referenceFields = ['agentSessionId', 'assetId', 'visualDocumentId', 'url']
    /** 各节点实际携带的业务引用字段。 */
    const actualReferences = nodeContracts.map((node) => referenceFields.filter((field) => field in node))

    expect(nodeContracts.map((node) => node.kind)).toEqual([
      'agent',
      'image',
      'visual-document',
      'webview',
    ])
    expect(actualReferences).toEqual([
      ['agentSessionId'],
      ['assetId'],
      ['visualDocumentId'],
      ['url'],
    ])
    expect('messages' in agentNode).toBe(false)
  })

  test('Given 稳定端口边 When 构造合同 Then 保留边 ID、节点 ID 与两端端口', () => {
    /** 连接 Agent 输出与图片提示词输入的稳定边。 */
    const edge: CanvasEdge = {
      id: 'edge-1',
      sourceNodeId: 'node-agent',
      sourcePort: 'output',
      targetNodeId: 'node-image',
      targetPort: 'prompt',
    }

    expect(edge).toEqual({
      id: 'edge-1',
      sourceNodeId: 'node-agent',
      sourcePort: 'output',
      targetNodeId: 'node-image',
      targetPort: 'prompt',
    })
  })

  test('Given 一组位置和视口 mutation When 归约 Then 更新已存在节点并忽略缺失节点', () => {
    /** mutation 前的权威文档。 */
    const document = createDocument()
    /** 应用视口和批量移动后的文档。 */
    const result = applyCanvasMutations(document, [
      { type: 'set-viewport', viewport: { x: 50, y: 60, zoom: 1.5 } },
      {
        type: 'move-nodes',
        positions: [
          { nodeId: imageNode.id, position: { x: 250, y: 80 } },
          { nodeId: 'node-missing', position: { x: 999, y: 999 } },
        ],
      },
    ])

    expect(result.viewport).toEqual({ x: 50, y: 60, zoom: 1.5 })
    expect(result.nodes.map((node) => [node.id, node.position])).toEqual([
      [agentNode.id, agentNode.position],
      [imageNode.id, { x: 250, y: 80 }],
      [visualDocumentNode.id, visualDocumentNode.position],
    ])
    expect(result.revision).toBe(7)
    expect(document.nodes[1]).toEqual(imageNode)
  })

  test('Given 已有和新增实体 When upsert Then 已有实体就地替换且新增实体追加', () => {
    /** 替换已有图片节点后的新值。 */
    const updatedImageNode: CanvasImageNode = {
      ...imageNode,
      title: '更新后的主视觉',
      position: { x: 220, y: 40 },
    }
    /** 替换已有边后的新值。 */
    const updatedEdge: CanvasEdge = {
      id: 'edge-document-image',
      sourceNodeId: visualDocumentNode.id,
      sourcePort: 'summary',
      targetNodeId: imageNode.id,
      targetPort: 'reference',
    }
    /** 新增的稳定边。 */
    const appendedEdge: CanvasEdge = {
      id: 'edge-image-webview',
      sourceNodeId: imageNode.id,
      sourcePort: 'image',
      targetNodeId: webviewNode.id,
      targetPort: 'preview',
    }
    /** 应用节点和边 upsert 后的文档。 */
    const result = applyCanvasMutations(createDocument(), [
      { type: 'upsert-nodes', nodes: [updatedImageNode, webviewNode] },
      { type: 'upsert-edges', edges: [updatedEdge, appendedEdge] },
    ])

    expect(result.nodes.map((node) => node.id)).toEqual([
      agentNode.id,
      imageNode.id,
      visualDocumentNode.id,
      webviewNode.id,
    ])
    expect(result.nodes[1]).toEqual(updatedImageNode)
    expect(result.edges.map((edge) => edge.id)).toEqual([
      'edge-agent-image',
      'edge-document-image',
      'edge-image-webview',
    ])
    expect(result.edges[1]).toEqual(updatedEdge)
  })

  test('Given 节点存在相连边 When 删除节点 Then 同步删除入边和出边', () => {
    /** 删除图片节点后的文档。 */
    const result = applyCanvasMutations(createDocument(), [
      { type: 'remove-nodes', nodeIds: [imageNode.id] },
    ])

    expect(result.nodes.map((node) => node.id)).toEqual([agentNode.id, visualDocumentNode.id])
    expect(result.edges).toEqual([])
    expect(result.revision).toBe(7)
  })

  test('Given 未知 ID 和指定边 When 删除 Then 忽略未知项并只移除命中的边', () => {
    /** 删除未知节点和一条已知边后的文档。 */
    const result = applyCanvasMutations(createDocument(), [
      { type: 'remove-nodes', nodeIds: ['node-missing'] },
      { type: 'remove-edges', edgeIds: ['edge-missing', 'edge-agent-image'] },
    ])

    expect(result.nodes.map((node) => node.id)).toEqual([
      agentNode.id,
      imageNode.id,
      visualDocumentNode.id,
    ])
    expect(result.edges.map((edge) => edge.id)).toEqual(['edge-document-image'])
    expect(result.revision).toBe(7)
    expect(result.updatedAt).toBe(now)
  })

  test('Given 重复 ID 的 upsert When 归约 Then reducer 不承担 Store 的 schema 校验', () => {
    /** 同一 mutation 内重复的节点更新，最后一个值应成为结果。 */
    const duplicateUpdates: CanvasImageNode[] = [
      { ...imageNode, title: '第一版' },
      { ...imageNode, title: '第二版' },
    ]
    /** reducer 按顺序应用重复 ID 更新后的文档。 */
    const result = applyCanvasMutations(createDocument(), [
      { type: 'upsert-nodes', nodes: duplicateUpdates },
    ])

    expect(result.nodes).toHaveLength(3)
    expect(result.nodes[1]?.title).toBe('第二版')
  })

  test('Given 可变 mutation payload When 归约后继续修改输入 Then 结果快照不受影响', () => {
    /** set-viewport 持有的可变视口对象。 */
    const viewport = { x: 50, y: 60, zoom: 1.5 }
    /** move-nodes 持有的可变位置对象。 */
    const position = { x: 250, y: 80 }
    /** upsert-nodes 持有的可变节点对象。 */
    const upsertedNode: CanvasImageNode = {
      ...imageNode,
      title: '隔离后的图片节点',
      position: { x: 220, y: 40 },
    }
    /** upsert-edges 持有的可变边对象。 */
    const upsertedEdge: CanvasEdge = {
      id: 'edge-agent-document',
      sourceNodeId: agentNode.id,
      sourcePort: 'output',
      targetNodeId: visualDocumentNode.id,
      targetPort: 'input',
    }
    /** 覆盖四条对象引用写入路径的 mutation 批次。 */
    const mutations: CanvasMutation[] = [
      { type: 'set-viewport', viewport },
      { type: 'move-nodes', positions: [{ nodeId: agentNode.id, position }] },
      { type: 'upsert-nodes', nodes: [upsertedNode] },
      { type: 'upsert-edges', edges: [upsertedEdge] },
    ]
    /** mutation 原始值归约形成的结果快照。 */
    const result = applyCanvasMutations(createDocument(), mutations)

    viewport.x = 999
    position.x = 999
    upsertedNode.title = '被外部修改的标题'
    upsertedNode.position.x = 999
    upsertedEdge.sourcePort = 'changed-output'

    expect(result.viewport).toEqual({ x: 50, y: 60, zoom: 1.5 })
    expect(result.nodes.find((node) => node.id === agentNode.id)?.position).toEqual({ x: 250, y: 80 })
    expect(result.nodes.find((node) => node.id === imageNode.id)).toEqual({
      ...imageNode,
      title: '隔离后的图片节点',
      position: { x: 220, y: 40 },
    })
    expect(result.edges.find((edge) => edge.id === upsertedEdge.id)?.sourcePort).toBe('output')
  })
})

void agentNodeWithMessages
void agentNodeWithAsset
