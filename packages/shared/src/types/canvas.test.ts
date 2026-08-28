import { describe, expect, test } from 'bun:test'
import {
  CANVAS_IPC_CHANNELS,
  CANVAS_DOCUMENT_VERSION,
  applyCanvasMutations,
  createEmptyCanvasDocument,
  parseCanvasImageJobControlInput,
  parseCanvasImageModuleConfig,
  parseCreateCanvasContentNodeInput,
  parseDeleteCanvasNodeInput,
  parseRestoreCanvasNodeInput,
  parseCanvasNodeContentMeta,
  parseCanvasTrashEntry,
} from './canvas'
import type {
  CanvasChangeEvent,
  CanvasAgentNode,
  CanvasInvokeResult,
  CanvasDocument,
  CanvasEdge,
  CanvasImageNode,
  CanvasImageModuleConfig,
  CanvasDocumentNode,
  CanvasMutation,
  CanvasNode,
  CreateCanvasAgentNodeInput,
  RebuildCanvasAgentNodeResult,
  CanvasWebviewNode,
  CanvasWorkspaceSnapshot,
  LoadCanvasInput,
  SaveCanvasMutationsInput,
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
  imageModuleId: 'image-module-1',
  adoptedAssetId: 'asset-1',
} satisfies CanvasImageNode

/** 文档节点只引用独立内容文档与当前修订。 */
const documentNode = {
  id: 'node-document',
  kind: 'document',
  title: '品牌规范',
  position: { x: 400, y: 20 },
  documentId: 'document-1',
  contentRevision: 3,
} satisfies CanvasDocumentNode

/** Webview 节点只引用独立原型内容与当前修订。 */
const webviewNode = {
  id: 'node-webview',
  kind: 'webview',
  title: '交互原型',
  position: { x: 600, y: 20 },
  prototypeId: 'prototype-1',
  contentRevision: 4,
} satisfies CanvasWebviewNode

/** 四类节点组成的联合类型样例，用于锁定 discriminant。 */
const nodeContracts = [agentNode, imageNode, documentNode, webviewNode] satisfies CanvasNode[]

/** Agent 节点禁止把消息历史复制进 Canvas 文档。 */
// @ts-expect-error messages 归 Agent 会话持久化所有，不属于 Canvas 节点合同。
const agentNodeWithMessages: CanvasAgentNode = { ...agentNode, messages: [] }

/** 节点引用字段必须互斥，避免一个节点同时拥有多个业务身份。 */
// @ts-expect-error Agent 节点不能同时引用图片素材。
const agentNodeWithImageModule: CanvasNode = { ...agentNode, imageModuleId: 'image-module-1' }

/** 创建带节点和边的测试文档。
 * @returns revision 固定为 7 的独立 Canvas 文档。
 */
function createDocument(): CanvasDocument {
  return {
    ...createEmptyCanvasDocument('project-1', 'canvas-1', now),
    revision: 7,
    nodes: [agentNode, imageNode, documentNode],
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
        sourceNodeId: documentNode.id,
        sourcePort: 'content',
        targetNodeId: imageNode.id,
        targetPort: 'reference',
      },
    ],
  }
}

describe('Canvas 图共享合同', () => {
  test('Given v2 图片配置 When 严格解析 Then 保留结构化生成选项', () => {
    /** 图片模块磁盘配置的完整合法样例。 */
    const config = parseCanvasImageModuleConfig({
      schemaVersion: 2,
      kind: 'image',
      contentId: 'module-1',
      revision: 3,
      createdAt: 10,
      updatedAt: 20,
      prompt: '首页主视觉',
      selectedModelProfileId: 'profile-1',
      aspectRatio: '16:9',
      imageSize: '2K',
      contextMode: 'project',
      adoptedAssetId: 'asset-1',
    }) satisfies CanvasImageModuleConfig

    expect(config).toMatchObject({
      aspectRatio: '16:9',
      imageSize: '2K',
      contextMode: 'project',
    })
  })

  test('Given 图片配置含未知字段或超长提示词 When 严格解析 Then fail closed', () => {
    /** 合法配置基线用于只改变单一非法字段。 */
    const config = {
      schemaVersion: 2,
      kind: 'image',
      contentId: 'module-1',
      revision: 0,
      createdAt: 10,
      updatedAt: 10,
      prompt: '首页主视觉',
      selectedModelProfileId: null,
      aspectRatio: '1:1',
      imageSize: 'auto',
      contextMode: 'auto',
      adoptedAssetId: null,
    }

    expect(() => parseCanvasImageModuleConfig({ ...config, extra: true })).toThrow()
    expect(() => parseCanvasImageModuleConfig({ ...config, prompt: 'x'.repeat(100_001) })).toThrow()
    expect(() => parseCanvasImageModuleConfig({ ...config, aspectRatio: '2:1' })).toThrow()
  })

  test('Given 图片任务控制输入 When 严格解析 Then 绑定完整模块身份并拒绝未知字段', () => {
    /** 合法任务控制输入必须携带完整图片模块身份。 */
    const input = {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      nodeId: 'node-1',
      imageModuleId: 'module-1',
      jobId: 'job-1',
    }

    expect(parseCanvasImageJobControlInput(input)).toEqual(input)
    expect(() => parseCanvasImageJobControlInput({ ...input, extra: true })).toThrow()
    expect(() => parseCanvasImageJobControlInput({ ...input, imageModuleId: '../escape' })).toThrow()
  })

  test('Given 内容节点创建命令 When 严格解析 Then 保留有限关系且拒绝未知字段', () => {
    const input = parseCreateCanvasContentNodeInput({
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', kind: 'document', contentId: 'content-1', title: '首页说明',
      position: { x: 10, y: 20 }, expectedRevision: 3,
      relationship: { sourceNodeId: 'source-1', edgeId: 'edge-1' },
    })
    expect(input.kind).toBe('document')
    expect(() => parseCreateCanvasContentNodeInput({ ...input, extra: true })).toThrow()
  })

  test('Given 删除与恢复命令 When 严格解析 Then 拒绝负 revision 与未知字段', () => {
    expect(parseDeleteCanvasNodeInput({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      operationId: '22222222-2222-4222-8222-222222222222', expectedRevision: 4,
    }).nodeId).toBe('node-1')
    expect(parseRestoreCanvasNodeInput({
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '33333333-3333-4333-8333-333333333333', trashId: 'trash-1',
      expectedRevision: 5, position: { x: 1, y: 2 },
    }).trashId).toBe('trash-1')
    expect(() => parseRestoreCanvasNodeInput({
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '33333333-3333-4333-8333-333333333333', trashId: 'trash-1',
      expectedRevision: -1, position: { x: 1, y: 2 },
    })).toThrow()
  })
  test('Given 合法内容元数据和回收条目 When 严格解析 Then 保留公开字段且不暴露路径', () => {
    /** 内容目录最终提交标记。 */
    const meta = parseCanvasNodeContentMeta({
      schemaVersion: 1,
      kind: 'document',
      contentId: 'content-1',
      revision: 0,
      createdAt: 100,
      updatedAt: 100,
    })
    /** Renderer 可见的回收区条目。 */
    const entry = parseCanvasTrashEntry({
      schemaVersion: 1,
      trashId: 'trash-1',
      nodeId: 'node-1',
      kind: 'document',
      contentId: 'content-1',
      title: '首页说明',
      position: { x: 10, y: 20 },
      deletedRevision: 3,
      deletedAt: 200,
    })

    expect(meta.kind).toBe('document')
    expect(entry.position).toEqual({ x: 10, y: 20 })
    expect('path' in entry).toBe(false)
  })

  test('Given 越界或未知内容合同 When 严格解析 Then fail closed', () => {
    /** 合法元数据基线。 */
    const meta = {
      schemaVersion: 1,
      kind: 'image',
      contentId: 'content-1',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    /** 合法回收条目基线。 */
    const entry = {
      schemaVersion: 1,
      trashId: 'trash-1',
      nodeId: 'node-1',
      kind: 'image',
      contentId: 'content-1',
      title: '图片',
      position: { x: 0, y: 0 },
      deletedRevision: 1,
      deletedAt: 1,
    }

    expect(() => parseCanvasNodeContentMeta({ ...meta, contentId: 'x'.repeat(129) })).toThrow()
    expect(() => parseCanvasNodeContentMeta({ ...meta, contentId: '../escape' })).toThrow()
    expect(() => parseCanvasNodeContentMeta({ ...meta, revision: -1 })).toThrow()
    expect(() => parseCanvasNodeContentMeta({ ...meta, createdAt: Number.NaN })).toThrow()
    expect(() => parseCanvasNodeContentMeta({ ...meta, extra: true })).toThrow()
    expect(() => parseCanvasTrashEntry({ ...entry, position: { x: Infinity, y: 0 } })).toThrow()
    expect(() => parseCanvasTrashEntry({ ...entry, title: 'x'.repeat(121) })).toThrow()
    expect(() => parseCanvasTrashEntry({ ...entry, unknown: true })).toThrow()
  })

  test('Given 原生 Canvas IPC When 构造公开合同 Then 只暴露双重身份、revision 与恢复来源', () => {
    /** 加载请求必须同时绑定项目与 Canvas。 */
    const loadInput: LoadCanvasInput = { projectId: 'project-1', canvasId: 'canvas-1' }
    /** 保存请求只携带权威 revision 与 mutation，不包含存储路径。 */
    const saveInput: SaveCanvasMutationsInput = {
      ...loadInput,
      expectedRevision: 0,
      mutations: [],
    }
    /** Renderer 可见的恢复快照不暴露 storageKind 或路径。 */
    const snapshot: CanvasWorkspaceSnapshot = {
      document: createEmptyCanvasDocument('project-1', 'canvas-1', now),
      writable: true,
      nodeIssues: [],
      recoveredFrom: 'backup',
    }
    /** 恢复事件允许使用低 revision，消费者据 cause 决定无条件失效。 */
    const change: CanvasChangeEvent = {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      revision: 0,
      cause: 'recovery',
    }

    expect(CANVAS_IPC_CHANNELS).toEqual({
      LOAD: 'canvas:load',
      LOAD_IMAGE_MODULE: 'canvas:load-image-module',
      SAVE_IMAGE_MODULE: 'canvas:save-image-module',
      CREATE_IMAGE_JOB: 'canvas:create-image-job',
      CANCEL_IMAGE_JOB: 'canvas:cancel-image-job',
      RETRY_IMAGE_JOB: 'canvas:retry-image-job',
      ADOPT_IMAGE_ASSET: 'canvas:adopt-image-asset',
      RELEASE_IMAGE_MEDIA: 'canvas:release-image-media',
      IMAGE_MODULE_CHANGED: 'canvas:image-module-changed',
      SAVE_MUTATIONS: 'canvas:save-mutations',
      CREATE_AGENT_NODE: 'canvas:create-agent-node',
      CREATE_CONTENT_NODE: 'canvas:create-content-node',
      DELETE_NODE: 'canvas:delete-node',
      LIST_TRASH: 'canvas:list-trash',
      RESTORE_NODE: 'canvas:restore-node',
      REBUILD_AGENT_NODE: 'canvas:rebuild-agent-node',
      LIST_ACTIVE_AGENT_RUNS: 'canvas:list-active-agent-runs',
      GET_AGENT_MESSAGES: 'canvas:get-agent-messages',
      SEND_AGENT_MESSAGE: 'canvas:send-agent-message',
      STOP_AGENT: 'canvas:stop-agent',
      CHANGED: 'canvas:changed',
    })
    expect(loadInput).toEqual({ projectId: 'project-1', canvasId: 'canvas-1' })
    expect(saveInput.mutations).toEqual([])
    expect(snapshot.recoveredFrom).toBe('backup')
    expect(change).toEqual({
      projectId: 'project-1',
      canvasId: 'canvas-1',
      revision: 0,
      cause: 'recovery',
    })
    expect('path' in snapshot).toBe(false)
    expect('storageKind' in snapshot).toBe(false)
  })

  test('Given 节点会话不可用 When 构造工作区快照 Then 问题只存在于运行时快照', () => {
    /** 运行时节点问题不得污染持久化 Canvas 文档。 */
    const snapshot: CanvasWorkspaceSnapshot = {
      document: createEmptyCanvasDocument('project-1', 'canvas-1', now),
      writable: true,
      nodeIssues: [{
        nodeId: 'node-1',
        code: 'AGENT_SESSION_UNAVAILABLE',
        allowedActions: ['rebuild-agent-session', 'remove-node'],
      }],
    }

    expect(snapshot.nodeIssues).toHaveLength(1)
    expect('nodeIssues' in snapshot.document).toBe(false)
  })

  test('Given 扩展创建输入 When 读取关系 Then 保留源节点和稳定边 ID', () => {
    /** 扩展操作预分配节点与边身份，失败重试必须复用。 */
    const input: CreateCanvasAgentNodeInput = {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: '22222222-2222-4222-8222-222222222222',
      title: '下游 Agent',
      position: { x: 480, y: 120 },
      relationship: {
        sourceNodeId: 'source-1',
        edgeId: '33333333-3333-4333-8333-333333333333',
      },
    }

    expect(input.relationship).toEqual({
      sourceNodeId: 'source-1',
      edgeId: '33333333-3333-4333-8333-333333333333',
    })
  })

  test('Given 重建公开失败 When 判别结果 Then 只能读取安全错误', () => {
    /** 失败联合只携带稳定码和用户可见文案。 */
    const result: CanvasInvokeResult<RebuildCanvasAgentNodeResult> = {
      ok: false,
      error: { code: 'AGENT_SESSION_REBUILD_FAILED', message: '重建失败，请重试。' },
    }

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toEqual({
        code: 'AGENT_SESSION_REBUILD_FAILED',
        message: '重建失败，请重试。',
      })
    }
  })

  test('Given 项目与 Canvas 身份 When 创建空文档 Then 同时固化两级身份和初始状态', () => {
    /** 新 Canvas 的空文档。 */
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', now)

    expect(CANVAS_DOCUMENT_VERSION).toBe(2)
    expect(document).toEqual({
      schemaVersion: 2,
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
    const referenceFields = [
      'agentSessionId',
      'imageModuleId',
      'adoptedAssetId',
      'documentId',
      'prototypeId',
      'contentRevision',
    ]
    /** 各节点实际携带的业务引用字段。 */
    const actualReferences = nodeContracts.map((node) => referenceFields.filter((field) => field in node))

    expect(nodeContracts.map((node) => node.kind)).toEqual([
      'agent',
      'image',
      'document',
      'webview',
    ])
    expect(actualReferences).toEqual([
      ['agentSessionId'],
      ['imageModuleId', 'adoptedAssetId'],
      ['documentId', 'contentRevision'],
      ['prototypeId', 'contentRevision'],
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
      [documentNode.id, documentNode.position],
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
      sourceNodeId: documentNode.id,
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
      documentNode.id,
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

    expect(result.nodes.map((node) => node.id)).toEqual([agentNode.id, documentNode.id])
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
      documentNode.id,
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
      targetNodeId: documentNode.id,
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
void agentNodeWithImageModule
