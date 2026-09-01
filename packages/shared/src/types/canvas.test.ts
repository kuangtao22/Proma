import { describe, expect, test } from 'bun:test'
import {
  CANVAS_IPC_CHANNELS,
  CANVAS_DOCUMENT_VERSION,
  applyCanvasMutations,
  createEmptyCanvasDocument,
  parseCanvasWebviewDevicePreset,
  parseCanvasWebviewPreviewSnapshot,
  parseCanvasWebviewPreviewTarget,
  parseCanvasImageJobControlInput,
  parseCanvasWebviewTarget,
  parseCanvasImageModuleConfig,
  parseCanvasImageModuleSnapshot,
  parseCanvasImageCandidateBatch,
  parseCanvasImageCandidateBatchSummary,
  parseAdoptCanvasImageCandidateBatchInput,
  parseReleaseCanvasImageMediaInput,
  parseCreateCanvasContentNodeInput,
  parseDeleteCanvasNodeInput,
  parseRestoreCanvasNodeInput,
  parseCanvasNodeContentMeta,
  parseCanvasTrashEntry,
  parseCanvasTextArtifactTarget,
  parseUpdateCanvasTextArtifactInput,
  parseAdoptCanvasTextArtifactRevisionInput,
  parseExportCanvasArtifactInput,
  parseAgentCanvasBinding,
  parseAgentCanvasBindingChangeEvent,
  parseCanvasBatchOperationEnvelope,
  parseCanvasChangeEvent,
  parseCanvasWorkspaceSnapshot,
  parseCanvasNodeReference,
  parseCanvasRunNodesInput,
  parseClearAgentCanvasBindingsInput,
  parseClearAgentCanvasBindingsResult,
  parseLinkAgentCanvasInput,
  parseLinkAgentCanvasResult,
  parseListAgentCanvasBindingsInput,
  parseListAgentCanvasBindingsResult,
  parseSetDefaultAgentCanvasInput,
  parseUnlinkAgentCanvasInput,
  parseUnlinkAgentCanvasResult,
} from './canvas'
import type {
  AgentCanvasBinding,
  CanvasChangeEvent,
  CanvasAgentNode,
  CanvasInvokeResult,
  CanvasDocument,
  CanvasEdge,
  CanvasImageNode,
  CanvasImageModuleConfig,
  CanvasImageModuleSnapshot,
  CanvasDocumentNode,
  CanvasMutation,
  CanvasNode,
  CanvasNodeActivityState,
  CreateCanvasAgentNodeInput,
  RebuildCanvasAgentNodeResult,
  CanvasWebviewNode,
  CanvasWebviewSnapshot,
  CanvasWorkspaceSnapshot,
  LoadCanvasInput,
  SaveCanvasMutationsInput,
} from './canvas'

/** 测试使用的固定时间，避免文档合同依赖系统时钟。 */
const now = 100

/** 四类节点共享的结构化活动状态必须保持为固定有限集合。 */
const canvasNodeActivityStates: readonly CanvasNodeActivityState[] = [
  'idle', 'queued', 'running', 'waiting-approval',
]

test('Given Canvas 节点活动合同 When 枚举状态 Then 只包含四种结构化状态', () => {
  expect(canvasNodeActivityStates).toEqual(['idle', 'queued', 'running', 'waiting-approval'])
})

/** 创建共享层图片快照 parser 使用的完整合法样例。 */
function createCanvasImageSnapshotFixture(): CanvasImageModuleSnapshot {
  /** 图片模块完整目标同时约束任务归属与配置内容身份。 */
  const target = {
    projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'module-1',
  }
  return {
    target,
    mediaLeaseId: 'lease-1',
    config: {
      schemaVersion: 2, kind: 'image', contentId: target.imageModuleId, revision: 3,
      createdAt: 1, updatedAt: 2, prompt: '首页主视觉', selectedModelProfileId: 'profile-1',
      aspectRatio: '16:9', imageSize: '2K', contextMode: 'project', adoptedAssetId: 'asset-1',
    },
    jobs: [{
      id: 'job-1', creativeTaskId: 'creative-1', attemptNumber: 1, projectId: target.projectId,
      target: { kind: 'canvas-image', canvasId: target.canvasId, nodeId: target.nodeId, imageModuleId: target.imageModuleId },
      action: 'generate', status: 'succeeded', prompt: '首页主视觉', originalRequest: '首页主视觉',
      contextMode: 'project', candidateBatchId: 'batch-1', outputAssetId: 'asset-1', createdAt: 10, updatedAt: 20,
    }],
    assets: [{
      id: 'asset-1', filename: 'asset-1.png', relativePath: 'assets/asset-1.png',
      thumbnailRelativePath: 'thumbnails/asset-1.webp', mediaType: 'image/png',
      width: 1024, height: 1024, byteSize: 4096, sha256: 'a'.repeat(64),
      sourceJobId: 'job-1', createdAt: 20,
    }],
    imageVersions: [{ jobId: 'job-1', assetId: 'asset-1', createdAt: 20 }],
    assetBaseUrl: 'proma-file://asset-token',
    thumbnailBaseUrl: 'proma-file://thumbnail-token',
  }
}

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
  upstreamChange: { sourceNodeIds: ['node-image'], changedAt: 90 },
} satisfies CanvasDocumentNode

/** Webview 节点只引用独立原型内容与当前修订。 */
const webviewNode = {
  id: 'node-webview',
  kind: 'webview',
  title: '交互原型',
  position: { x: 600, y: 20 },
  prototypeId: 'prototype-1',
  contentRevision: 4,
  devicePreset: 'desktop',
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
        relation: 'association',
      },
      {
        id: 'edge-document-image',
        sourceNodeId: documentNode.id,
        sourcePort: 'content',
        targetNodeId: imageNode.id,
        targetPort: 'reference',
        relation: 'reference',
      },
    ],
  }
}

describe('Canvas 图共享合同', () => {
  test('Given 完整公开工作区快照 When 严格解析 Then 重建四类节点、关系边与深隔离副本', () => {
    const document = structuredClone(createDocument())
    document.nodes.push(structuredClone(webviewNode))
    document.edges.push({
      id: 'edge-image-webview',
      sourceNodeId: imageNode.id,
      sourcePort: 'asset',
      targetNodeId: webviewNode.id,
      targetPort: 'visual',
      relation: 'derives',
    })
    const snapshot: CanvasWorkspaceSnapshot & {
      imagePreviews: NonNullable<CanvasWorkspaceSnapshot['imagePreviews']>
    } = {
      document,
      writable: true as const,
      nodeIssues: [{
        nodeId: agentNode.id,
        code: 'AGENT_SESSION_UNAVAILABLE' as const,
        allowedActions: ['rebuild-agent-session', 'remove-node'],
      }],
      imagePreviews: [{ assetId: 'asset-1', previewUrl: 'proma-media://preview-1', width: 1200, height: 800 }],
      recoveredFrom: 'backup' as const,
    }

    const parsed = parseCanvasWorkspaceSnapshot(snapshot)

    expect(parsed).toEqual(snapshot)
    expect(parsed).not.toBe(snapshot)
    expect(parsed.document).not.toBe(snapshot.document)
    expect(parsed.document.nodes[0]).not.toBe(snapshot.document.nodes[0])
    expect(parsed.document.nodes[0]?.position).not.toBe(snapshot.document.nodes[0]?.position)
    expect(parsed.nodeIssues[0]).not.toBe(snapshot.nodeIssues[0])
    expect(parsed.nodeIssues[0]?.allowedActions).not.toBe(snapshot.nodeIssues[0]?.allowedActions)
    expect(parsed.imagePreviews?.[0]).not.toBe(snapshot.imagePreviews[0])

    snapshot.document.nodes[0]!.position.x = 999
    snapshot.imagePreviews[0]!.width = 1
    expect(parsed.document.nodes[0]?.position.x).toBe(10)
    expect(parsed.imagePreviews?.[0]?.width).toBe(1200)
  })

  test('Given 快照含额外字段、畸形图或公开派生数据 When 严格解析 Then 全部拒绝', () => {
    /** 为每个非法分支创建独立快照，避免前一项 mutation 污染后一项。 */
    const createSnapshot = () => {
      const document = structuredClone(createDocument())
      document.nodes.push(structuredClone(webviewNode))
      return {
        document,
        writable: true as const,
        nodeIssues: [{
          nodeId: agentNode.id,
          code: 'AGENT_SESSION_UNAVAILABLE' as const,
          allowedActions: ['rebuild-agent-session', 'remove-node'],
        }],
        imagePreviews: [{ assetId: 'asset-1', previewUrl: 'proma-media://preview-1', width: 1200, height: 800 }],
      }
    }
    /** 把已知测试对象收窄为可注入非法字段的记录。 */
    const asRecord = (value: object): Record<string, unknown> => value as Record<string, unknown>
    /** 收集必须被共享边界拒绝的独立非法快照。 */
    const invalidSnapshots: unknown[] = []

    const privateSnapshot = createSnapshot()
    asRecord(privateSnapshot).privatePath = '/private/canvas.json'
    invalidSnapshots.push(privateSnapshot)

    const privateDocument = createSnapshot()
    asRecord(privateDocument.document).privatePath = '/private/canvas.json'
    invalidSnapshots.push(privateDocument)

    const extraNode = createSnapshot()
    asRecord(extraNode.document.nodes[0]!).imageModuleId = 'image-module-1'
    invalidSnapshots.push(extraNode)

    const extraEdge = createSnapshot()
    asRecord(extraEdge.document.edges[0]!).privatePath = '/private/edge.json'
    invalidSnapshots.push(extraEdge)

    const danglingEdge = createSnapshot()
    danglingEdge.document.edges[0]!.targetNodeId = 'missing-node'
    invalidSnapshots.push(danglingEdge)

    const invalidRelation = createSnapshot()
    asRecord(invalidRelation.document.edges[0]!).relation = 'sequence'
    invalidSnapshots.push(invalidRelation)

    const extraViewport = createSnapshot()
    asRecord(extraViewport.document.viewport).privatePath = '/private/viewport.json'
    invalidSnapshots.push(extraViewport)

    const nanViewport = createSnapshot()
    nanViewport.document.viewport.x = Number.NaN
    invalidSnapshots.push(nanViewport)

    const invalidZoom = createSnapshot()
    invalidZoom.document.viewport.zoom = 0
    invalidSnapshots.push(invalidZoom)

    const duplicateNode = createSnapshot()
    duplicateNode.document.nodes.push({ ...documentNode, position: { ...documentNode.position } })
    invalidSnapshots.push(duplicateNode)

    const duplicateEdge = createSnapshot()
    duplicateEdge.document.edges.push({ ...duplicateEdge.document.edges[0]! })
    invalidSnapshots.push(duplicateEdge)

    const issueForContentNode = createSnapshot()
    issueForContentNode.nodeIssues[0]!.nodeId = imageNode.id
    invalidSnapshots.push(issueForContentNode)

    const duplicateIssueAction = createSnapshot()
    duplicateIssueAction.nodeIssues[0]!.allowedActions = ['remove-node', 'remove-node']
    invalidSnapshots.push(duplicateIssueAction)

    const malformedPreview = createSnapshot()
    malformedPreview.imagePreviews[0]!.width = 0
    invalidSnapshots.push(malformedPreview)

    const undefinedPreview = createSnapshot()
    asRecord(undefinedPreview).imagePreviews = undefined
    invalidSnapshots.push(undefinedPreview)

    const undefinedRecovery = createSnapshot()
    asRecord(undefinedRecovery).recoveredFrom = undefined
    invalidSnapshots.push(undefinedRecovery)

    const duplicatePreview = createSnapshot()
    duplicatePreview.imagePreviews.push({ ...duplicatePreview.imagePreviews[0]! })
    invalidSnapshots.push(duplicatePreview)

    for (const value of invalidSnapshots) {
      expect(() => parseCanvasWorkspaceSnapshot(value)).toThrow('CANVAS_WORKSPACE_SNAPSHOT_INVALID')
    }
  })

  test('Given 合法关联变化事件 When 解析 Then 返回隔离副本并保留 null 删除语义', () => {
    const binding: AgentCanvasBinding = {
      projectId: 'project-1',
      sessionId: 'session-1',
      defaultCanvasId: 'canvas-1',
      linkedCanvasIds: ['canvas-1'],
      lastActiveCanvasId: 'canvas-1',
      updatedAt: 10,
    }
    const value = {
      projectId: 'project-1',
      sessionId: 'session-1',
      cause: 'linked' as const,
      binding,
    }

    const parsed = parseAgentCanvasBindingChangeEvent(value)

    expect(parsed).toEqual(value)
    expect(parsed).not.toBe(value)
    expect(parsed.binding).not.toBe(binding)
    expect(parseAgentCanvasBindingChangeEvent({
      projectId: 'project-1',
      sessionId: 'session-1',
      cause: 'session-cleared',
      binding: null,
    }).binding).toBeNull()
  })

  test('Given 关联变化事件含未知字段或非法 cause When 解析 Then 严格拒绝', () => {
    expect(() => parseAgentCanvasBindingChangeEvent({
      projectId: 'project-1',
      sessionId: 'session-1',
      cause: 'linked',
      binding: null,
      internalPath: '/private/secret',
    })).toThrow('AGENT_CANVAS_BINDING_CHANGE_EVENT_INVALID')
    expect(() => parseAgentCanvasBindingChangeEvent({
      projectId: 'project-1',
      sessionId: 'session-1',
      cause: 'unknown',
      binding: null,
    })).toThrow('AGENT_CANVAS_BINDING_CHANGE_EVENT_INVALID')
  })
  test('Given Agent 关联包含重复画布 When 严格解析 Then 去重并保持首现顺序', () => {
    /** 持久化边界返回的关联记录，重复项应被规范化。 */
    const binding = parseAgentCanvasBinding({
      projectId: 'project-1',
      sessionId: 'session-1',
      defaultCanvasId: 'canvas-1',
      linkedCanvasIds: ['canvas-1', 'canvas-2', 'canvas-1'],
      lastActiveCanvasId: 'canvas-2',
      updatedAt: 10,
    }) satisfies AgentCanvasBinding

    expect(binding.linkedCanvasIds).toEqual(['canvas-1', 'canvas-2'])
  })

  test('Given 默认或最近画布未关联 When 严格解析 Then 拒绝不一致记录与未知字段', () => {
    /** 合法关联基线用于只改变单一非法字段。 */
    const binding = {
      projectId: 'project-1', sessionId: 'session-1',
      linkedCanvasIds: ['canvas-1'], updatedAt: 10,
    }

    expect(() => parseAgentCanvasBinding({ ...binding, defaultCanvasId: 'canvas-2' })).toThrow()
    expect(() => parseAgentCanvasBinding({ ...binding, lastActiveCanvasId: 'canvas-2' })).toThrow()
    expect(() => parseAgentCanvasBinding({ ...binding, storagePath: '/private/bindings.json' })).toThrow()
  })

  test('Given 关联 IPC 输入 When 严格解析 Then 只接受安全身份与精确字段', () => {
    expect(parseListAgentCanvasBindingsInput({ projectId: 'project-1' })).toEqual({ projectId: 'project-1' })
    expect(parseLinkAgentCanvasInput({
      projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1', makeDefault: true,
    })).toEqual({
      projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1', makeDefault: true,
    })
    expect(parseLinkAgentCanvasInput({
      projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1', makeDefault: false,
    }).makeDefault).toBe(false)
    expect(parseUnlinkAgentCanvasInput({ projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1' }))
      .toEqual({ projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1' })
    expect(parseSetDefaultAgentCanvasInput({ projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1' }))
      .toEqual({ projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1' })
    expect(parseClearAgentCanvasBindingsInput({
      projectId: 'project-1', target: 'session', sessionId: 'session-1',
    })).toEqual({ projectId: 'project-1', target: 'session', sessionId: 'session-1' })
    expect(parseClearAgentCanvasBindingsInput({
      projectId: 'project-1', target: 'canvas', canvasId: 'canvas-1',
    })).toEqual({ projectId: 'project-1', target: 'canvas', canvasId: 'canvas-1' })
    expect(() => parseLinkAgentCanvasInput({
      projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1', makeDefault: 'yes',
    })).toThrow()
    expect(() => parseLinkAgentCanvasInput({
      projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1',
      makeDefault: false, extra: true,
    })).toThrow()
    expect(() => parseClearAgentCanvasBindingsInput({
      projectId: 'project-1', target: 'session', sessionId: 'session-1', canvasId: 'canvas-1',
    })).toThrow()
    expect(() => parseClearAgentCanvasBindingsInput({
      projectId: 'project-1', target: 'canvas', canvasId: 'canvas-1', extra: true,
    })).toThrow()
    expect(() => parseListAgentCanvasBindingsInput({ projectId: 'project-1', extra: true })).toThrow()
  })

  test('Given 关联 IPC 输出 When 严格解析 Then 只返回公开绑定或 void', () => {
    /** 关联命令公开输出只包含规范化绑定。 */
    const binding = {
      projectId: 'project-1', sessionId: 'session-1',
      linkedCanvasIds: ['canvas-1', 'canvas-1'], updatedAt: 10,
    }

    expect(parseLinkAgentCanvasResult(binding).linkedCanvasIds).toEqual(['canvas-1'])
    expect(parseUnlinkAgentCanvasResult(null)).toBeNull()
    expect(parseListAgentCanvasBindingsResult([binding])).toEqual([{
      ...binding,
      linkedCanvasIds: ['canvas-1'],
    }])
    expect(parseClearAgentCanvasBindingsResult(undefined)).toBeUndefined()
    expect(() => parseListAgentCanvasBindingsResult([{ ...binding, internalPath: '/private/binding.json' }]))
      .toThrow()
    expect(() => parseClearAgentCanvasBindingsResult({ cleared: true })).toThrow()
  })

  test('Given Canvas 节点引用 When 严格解析 Then 校验节点类型、revision 与未知字段', () => {
    /** 合法引用不复用附件或 mention 字段。 */
    const reference = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      nodeType: 'document', nodeRevision: 3, title: '需求文档',
    } satisfies import('./canvas').CanvasNodeReference

    expect(parseCanvasNodeReference(reference)).toEqual(reference)
    expect(() => parseCanvasNodeReference({ ...reference, nodeRevision: -1 })).toThrow()
    expect(() => parseCanvasNodeReference({ ...reference, nodeRevision: 1.5 })).toThrow()
    expect(() => parseCanvasNodeReference({ ...reference, nodeType: 'video' })).toThrow()
    expect(() => parseCanvasNodeReference({ ...reference, localPath: '/private/node.json' })).toThrow()
  })

  test('Given Agent 批量修改外壳 When 严格解析 Then 保留 JSON 操作与来源身份', () => {
    /** 未验证 operation 只属于 JSON 外壳，不能伪装成 CanvasMutation。 */
    const operation = {
      type: 'future-task-8-validation',
      payload: { nodeIds: ['node-1'] },
    }
    /** 批量操作外壳在 Task 8 权威验证前只承诺 JSON 值。 */
    const batch = {
      projectId: 'project-1', canvasId: 'canvas-1', baseRevision: 2,
      operations: [operation],
      sourceSessionId: 'session-1', sourceRunStartedAt: 100, sourceToolCallId: 'tool-1',
    }
    /** 节点执行只提交稳定节点 ID 与来源代次。 */
    const run = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeIds: ['node-1', 'node-2'],
      sourceSessionId: 'session-1', sourceRunStartedAt: 100, sourceToolCallId: 'tool-1',
    }

    expect(parseCanvasBatchOperationEnvelope(batch)).toEqual(batch)
    expect(parseCanvasRunNodesInput(run)).toEqual(run)
    expect(() => parseCanvasBatchOperationEnvelope({ ...batch, baseRevision: -1 })).toThrow()
    expect(() => parseCanvasBatchOperationEnvelope({ ...batch, internal: true })).toThrow()
    expect(() => parseCanvasRunNodesInput({ ...run, nodeIds: ['node-1', '../escape'] })).toThrow()
    expect(() => parseCanvasRunNodesInput({ ...run, extra: true })).toThrow()
  })

  test('Given 外壳解析后修改原 operation When 读取结果 Then 嵌套 JSON 保持隔离', () => {
    /** 原始 operation 包含对象与数组两层可变引用。 */
    const operation = {
      type: 'remove-nodes',
      payload: { nodeIds: ['node-1'] },
    }
    /** 解析后的可信 JSON 副本。 */
    const parsed = parseCanvasBatchOperationEnvelope({
      projectId: 'project-1', canvasId: 'canvas-1', baseRevision: 2,
      operations: [operation],
      sourceSessionId: 'session-1', sourceRunStartedAt: 100, sourceToolCallId: 'tool-1',
    })

    operation.type = 'changed'
    operation.payload.nodeIds.push('node-2')

    expect(parsed.operations).toEqual([{
      type: 'remove-nodes',
      payload: { nodeIds: ['node-1'] },
    }])
  })

  test('Given operation 不是有限 plain JSON When 解析外壳 Then fail closed', () => {
    /** 构造带循环引用的 plain object。 */
    const circular: Record<string, unknown> = {}
    circular.self = circular
    /** 构造带自定义原型的非 plain object。 */
    const customPrototype = Object.create({ inherited: true }) as unknown
    /** 构造 JSON 不允许的稀疏数组。 */
    const sparseArray = new Array(1)
    /** 所有非法 JSON 值分别进入单个 operation。 */
    const invalidOperations: unknown[] = [
      undefined,
      () => undefined,
      Symbol('operation'),
      1n,
      Number.NaN,
      new Date(),
      customPrototype,
      circular,
      sparseArray,
    ]

    for (const operation of invalidOperations) {
      expect(() => parseCanvasBatchOperationEnvelope({
        projectId: 'project-1', canvasId: 'canvas-1', baseRevision: 2,
        operations: [operation],
        sourceSessionId: 'session-1', sourceRunStartedAt: 100, sourceToolCallId: 'tool-1',
      })).toThrow()
    }
  })

  test('Given Task 8 已验证 mutation When 构造内部命令 Then operations 保持强类型', () => {
    /** 内部强类型命令只能携带 CanvasMutation，不由外壳 parser 声称产出。 */
    const input: import('./canvas').CanvasBatchOperationInput = {
      projectId: 'project-1', canvasId: 'canvas-1', baseRevision: 2,
      operations: [{ type: 'remove-nodes', nodeIds: ['node-1'] }],
      sourceSessionId: 'session-1', sourceRunStartedAt: 100, sourceToolCallId: 'tool-1',
    }

    expect(input.operations[0]?.type).toBe('remove-nodes')
  })

  test('Given 图片媒体释放输入 When 严格解析 Then 保留完整目标与授权身份并拒绝多余字段', () => {
    const input = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-image',
      imageModuleId: 'module-1', mediaLeaseId: 'lease-1',
    }

    expect(parseReleaseCanvasImageMediaInput(input)).toEqual(input)
    expect(() => parseReleaseCanvasImageMediaInput({ ...input, internalPath: '/private/image.png' }))
      .toThrow('CANVAS_IMAGE_MEDIA_RELEASE_INPUT_INVALID')
  })

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

  test('Given 合法图片模块快照 When 严格解析 Then 完整重建并与输入深隔离', () => {
    const input = createCanvasImageSnapshotFixture()
    const parsed = parseCanvasImageModuleSnapshot(input)

    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    expect(parsed.target).not.toBe(input.target)
    expect(parsed.jobs[0]).not.toBe(input.jobs[0])
    expect(parsed.assets[0]).not.toBe(input.assets[0])
    expect(parsed.imageVersions[0]).not.toBe(input.imageVersions[0])
  })

  test('Given 图片快照夹带未知字段、私有路径或错误版本关系 When 严格解析 Then fail closed', () => {
    const input = createCanvasImageSnapshotFixture()

    expect(() => parseCanvasImageModuleSnapshot({ ...input, internalPath: '/private/module.json' }))
      .toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    expect(() => parseCanvasImageModuleSnapshot({
      ...input,
      jobs: [{ ...input.jobs[0], privatePath: '/private/job.json' }],
    })).toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    expect(() => parseCanvasImageModuleSnapshot({
      ...input,
      assets: [{ ...input.assets[0], absolutePath: '/private/asset.png' }],
    })).toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    expect(() => parseCanvasImageModuleSnapshot({
      ...input,
      imageVersions: [input.imageVersions[0], { ...input.imageVersions[0] }],
    })).toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    expect(() => parseCanvasImageModuleSnapshot({
      ...input,
      assets: [{ ...input.assets[0], sourceJobId: 'job-other' }],
    })).toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  })

  test('Given 图片快照含目标任务输出与 adopted 祖先链之外的素材 When 严格解析 Then 拒绝孤儿素材', () => {
    const input = createCanvasImageSnapshotFixture()
    /** 孤儿素材既不是目标任务输出，也不在 adopted 素材祖先链中。 */
    const orphanAsset = {
      ...input.assets[0]!,
      id: 'asset-orphan',
      filename: 'asset-orphan.png',
      relativePath: 'assets/asset-orphan.png',
      thumbnailRelativePath: 'thumbnails/asset-orphan.webp',
      sourceJobId: 'job-orphan',
    }

    expect(() => parseCanvasImageModuleSnapshot({
      ...input,
      assets: [...input.assets, orphanAsset],
    })).toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  })

  test('Given adopted 素材祖先链断裂或循环 When 严格解析 Then fail closed', () => {
    const input = createCanvasImageSnapshotFixture()
    const brokenLineage = {
      ...input.assets[0]!,
      parentAssetId: 'asset-missing',
    }
    /** 第二个素材与 adopted 素材互相指向，构成最小循环。 */
    const cyclicAncestor = {
      ...input.assets[0]!,
      id: 'asset-2',
      filename: 'asset-2.png',
      relativePath: 'assets/asset-2.png',
      thumbnailRelativePath: 'thumbnails/asset-2.webp',
      sourceJobId: 'job-2',
      parentAssetId: 'asset-1',
    }
    const cyclicAdoptedAsset = {
      ...input.assets[0]!,
      parentAssetId: cyclicAncestor.id,
    }

    expect(() => parseCanvasImageModuleSnapshot({
      ...input,
      assets: [brokenLineage],
    })).toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    expect(() => parseCanvasImageModuleSnapshot({
      ...input,
      assets: [cyclicAdoptedAsset, cyclicAncestor],
    })).toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  })

  test('Given generate 任务声明 source 或 parent 素材 When 严格解析 Then fail closed', () => {
    const input = createCanvasImageSnapshotFixture()

    for (const invalidJob of [
      { ...input.jobs[0]!, sourceAssetId: 'asset-1' },
      { ...input.jobs[0]!, parentAssetId: 'asset-1' },
    ]) {
      expect(() => parseCanvasImageModuleSnapshot({ ...input, jobs: [invalidJob] }))
        .toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    }
  })

  test('Given edit 任务来源、父级或输出素材父级不一致 When 严格解析 Then fail closed', () => {
    const input = createCanvasImageSnapshotFixture()
    /** edit 来源素材进入 adopted 祖先闭包，输出素材必须回指同一父级。 */
    const sourceAsset = {
      ...input.assets[0]!,
      id: 'asset-source',
      filename: 'asset-source.png',
      relativePath: 'assets/asset-source.png',
      thumbnailRelativePath: 'thumbnails/asset-source.webp',
      sourceJobId: undefined,
    }
    delete sourceAsset.sourceJobId
    const editJob = {
      ...input.jobs[0]!,
      action: 'edit' as const,
      sourceAssetId: sourceAsset.id,
      parentAssetId: sourceAsset.id,
    }
    const editOutput = {
      ...input.assets[0]!,
      parentAssetId: sourceAsset.id,
    }
    const validEditSnapshot = {
      ...input,
      config: { ...input.config, adoptedAssetId: editOutput.id },
      jobs: [editJob],
      assets: [editOutput, sourceAsset],
    }

    expect(parseCanvasImageModuleSnapshot(validEditSnapshot)).toEqual(validEditSnapshot)
    expect(() => parseCanvasImageModuleSnapshot({
      ...validEditSnapshot,
      jobs: [{ ...editJob, sourceAssetId: 'asset-missing' }],
    })).toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    expect(() => parseCanvasImageModuleSnapshot({
      ...validEditSnapshot,
      jobs: [{ ...editJob, parentAssetId: 'asset-missing' }],
    })).toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
    expect(() => parseCanvasImageModuleSnapshot({
      ...validEditSnapshot,
      assets: [{ ...editOutput, parentAssetId: 'asset-missing' }, sourceAsset],
    })).toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
  })

  test('Given 图片版本超限或顺序不符合主进程合同 When 严格解析 Then fail closed', () => {
    const input = createCanvasImageSnapshotFixture()
    /** 101 组唯一合法事实用于证明上限在关系正确时仍生效。 */
    const jobs = Array.from({ length: 101 }, (_, index) => ({
      ...input.jobs[0]!, id: `job-${index}`, outputAssetId: `asset-${index}`,
    }))
    const assets = Array.from({ length: 101 }, (_, index) => ({
      ...input.assets[0]!, id: `asset-${index}`, filename: `asset-${index}.png`,
      relativePath: `assets/asset-${index}.png`, thumbnailRelativePath: `thumbnails/asset-${index}.webp`,
      sourceJobId: `job-${index}`, createdAt: 200 - index,
    }))
    const imageVersions = Array.from({ length: 101 }, (_, index) => ({
      jobId: `job-${index}`, assetId: `asset-${index}`, createdAt: 200 - index,
    }))
    expect(() => parseCanvasImageModuleSnapshot({ ...input, jobs, assets, imageVersions }))
      .toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')

    const secondJob = { ...input.jobs[0]!, id: 'job-2', outputAssetId: 'asset-2' }
    const secondAsset = {
      ...input.assets[0]!, id: 'asset-2', filename: 'asset-2.png', relativePath: 'assets/asset-2.png',
      thumbnailRelativePath: 'thumbnails/asset-2.webp', sourceJobId: 'job-2', createdAt: 30,
    }
    expect(() => parseCanvasImageModuleSnapshot({
      ...input,
      jobs: [input.jobs[0]!, secondJob],
      assets: [input.assets[0]!, secondAsset],
      imageVersions: [input.imageVersions[0]!, { jobId: 'job-2', assetId: 'asset-2', createdAt: 30 }],
    })).toThrow('CANVAS_IMAGE_MODULE_SNAPSHOT_INVALID')
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
      relationship: { sourceNodeId: 'source-1', edgeId: 'edge-1', relation: 'depends-on' },
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
  test('Given 三类 v2 回收条目 When 严格解析 Then 保留各自完整节点状态且不暴露路径', () => {
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
      schemaVersion: 2,
      trashId: 'trash-1',
      nodeId: 'node-1',
      kind: 'document',
      contentId: 'content-1',
      title: '首页说明',
      position: { x: 10, y: 20 },
      deletedRevision: 3,
      deletedAt: 200,
      contentRevision: 4,
    })
    /** 图片条目只允许保留可选的已采用素材。 */
    const imageEntry = parseCanvasTrashEntry({
      schemaVersion: 2,
      trashId: 'trash-image', nodeId: 'node-image', kind: 'image', contentId: 'image-1',
      title: '主视觉', position: { x: 30, y: 40 }, deletedRevision: 5, deletedAt: 201,
      adoptedAssetId: 'asset-1',
    })
    /** WebView 条目必须保留内容修订和设备预设。 */
    const webviewEntry = parseCanvasTrashEntry({
      schemaVersion: 2,
      trashId: 'trash-web', nodeId: 'node-web', kind: 'webview', contentId: 'web-1',
      title: '移动首页', position: { x: 50, y: 60 }, deletedRevision: 6, deletedAt: 202,
      contentRevision: 7, devicePreset: 'mobile',
    })

    expect(meta.kind).toBe('document')
    expect(entry).toMatchObject({ kind: 'document', contentRevision: 4, position: { x: 10, y: 20 } })
    expect(imageEntry).toMatchObject({ kind: 'image', adoptedAssetId: 'asset-1' })
    expect(webviewEntry).toMatchObject({ kind: 'webview', contentRevision: 7, devicePreset: 'mobile' })
    expect('path' in entry).toBe(false)
  })

  test('Given schema v1 回收条目 When 解析 Then 确定性迁移为 v2 默认状态', () => {
    /** 历史条目没有内容修订和设备信息，迁移值沿用旧恢复链原先的默认。 */
    const legacy = {
      schemaVersion: 1,
      trashId: 'trash-legacy', nodeId: 'node-web', kind: 'webview' as const, contentId: 'web-1',
      title: '旧原型', position: { x: 1, y: 2 }, deletedRevision: 3, deletedAt: 100,
    }

    expect(parseCanvasTrashEntry(legacy)).toEqual({
      ...legacy,
      schemaVersion: 2,
      contentRevision: 0,
      devicePreset: 'desktop',
    })
  })

  test('Given 越界或未知内容合同 When 严格解析 Then fail closed', () => {
    /** 合法元数据基线。 */
    const meta = {
      schemaVersion: 2,
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
      adoptedAssetId: 'asset-1',
    }

    expect(() => parseCanvasNodeContentMeta({ ...meta, contentId: 'x'.repeat(129) })).toThrow()
    expect(() => parseCanvasNodeContentMeta({ ...meta, contentId: '../escape' })).toThrow()
    expect(() => parseCanvasNodeContentMeta({ ...meta, revision: -1 })).toThrow()
    expect(() => parseCanvasNodeContentMeta({ ...meta, createdAt: Number.NaN })).toThrow()
    expect(() => parseCanvasNodeContentMeta({ ...meta, extra: true })).toThrow()
    expect(() => parseCanvasTrashEntry({ ...entry, position: { x: Infinity, y: 0 } })).toThrow()
    expect(() => parseCanvasTrashEntry({ ...entry, title: 'x'.repeat(121) })).toThrow()
    expect(() => parseCanvasTrashEntry({ ...entry, unknown: true })).toThrow()
    expect(() => parseCanvasTrashEntry({ ...entry, kind: 'document' })).toThrow()
    expect(() => parseCanvasTrashEntry({ ...entry, kind: 'webview', contentRevision: 1 })).toThrow()
  })

  test('Given 文本产物命令 When 严格解析 Then exact-key、UUID 和 UTF-8 正文上限生效', () => {
    /** 合法文档身份贯穿读取、更新与采用命令。 */
    const identity = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-document',
      kind: 'document' as const, contentId: 'document-1',
    }
    const update = {
      ...identity,
      operationId: '11111111-1111-4111-8111-111111111111',
      expectedCanvasRevision: 3,
      expectedContentRevision: 2,
      content: '# 新版本',
    }
    const adopt = {
      ...identity,
      operationId: '22222222-2222-4222-8222-222222222222',
      expectedCanvasRevision: 4,
      expectedContentRevision: 3,
      revision: 1,
    }

    expect(parseCanvasTextArtifactTarget({ ...identity, contentRevision: 2 })).toEqual({
      ...identity, contentRevision: 2,
    })
    expect(parseUpdateCanvasTextArtifactInput(update)).toEqual(update)
    expect(parseAdoptCanvasTextArtifactRevisionInput(adopt)).toEqual(adopt)
    expect(parseExportCanvasArtifactInput({ ...identity, contentRevision: 2 })).toEqual({
      ...identity, contentRevision: 2,
    })
    expect(parseExportCanvasArtifactInput({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-image',
      kind: 'image', imageModuleId: 'image-1', assetId: 'asset-1',
    })).toMatchObject({ kind: 'image', assetId: 'asset-1' })
    expect(() => parseUpdateCanvasTextArtifactInput({ ...update, extra: true })).toThrow()
    expect(() => parseCanvasTextArtifactTarget({ ...identity, contentRevision: 2, path: '/private/content.md' }))
      .toThrow('CANVAS_TEXT_ARTIFACT_TARGET_INVALID')
    expect(() => parseUpdateCanvasTextArtifactInput({ ...update, operationId: 'not-a-uuid' })).toThrow()
    expect(() => parseUpdateCanvasTextArtifactInput({
      ...update,
      content: '文'.repeat(87_382),
    })).toThrow('CANVAS_TEXT_ARTIFACT_UPDATE_INPUT_INVALID')
  })

  test('Given 文本产物四层合同 When 读取通道 Then 使用固定且互不复用的 IPC 名称', () => {
    expect(CANVAS_IPC_CHANNELS).toMatchObject({
      LOAD_TEXT_ARTIFACT: 'canvas:load-text-artifact',
      UPDATE_TEXT_ARTIFACT: 'canvas:update-text-artifact',
      LIST_ARTIFACT_REVISIONS: 'canvas:list-artifact-revisions',
      ADOPT_ARTIFACT_REVISION: 'canvas:adopt-artifact-revision',
      EXPORT_ARTIFACT: 'canvas:export-artifact',
    })
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
      source: {
        sessionId: 'session-1',
        runStartedAt: 100,
        toolCallId: 'tool-1',
      },
    }

    expect(parseCanvasChangeEvent(change)).toEqual(change)
    expect(parseCanvasChangeEvent({
      projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'graph',
    })).toEqual({ projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'graph' })
    expect(() => parseCanvasChangeEvent({ ...change, source: { ...change.source, prompt: 'private' } })).toThrow('CANVAS_CHANGE_EVENT_INVALID')
    expect(() => parseCanvasChangeEvent({ ...change, source: { sessionId: 'session-1' } })).toThrow('CANVAS_CHANGE_EVENT_INVALID')
    expect(() => parseCanvasChangeEvent({ ...change, source: { ...change.source, runStartedAt: -1 } })).toThrow('CANVAS_CHANGE_EVENT_INVALID')
    expect(() => parseCanvasChangeEvent({ ...change, extra: true })).toThrow('CANVAS_CHANGE_EVENT_INVALID')

    expect(CANVAS_IPC_CHANNELS).toEqual({
      LOAD: 'canvas:load',
      LOAD_TEXT_ARTIFACT: 'canvas:load-text-artifact',
      UPDATE_TEXT_ARTIFACT: 'canvas:update-text-artifact',
      LIST_ARTIFACT_REVISIONS: 'canvas:list-artifact-revisions',
      ADOPT_ARTIFACT_REVISION: 'canvas:adopt-artifact-revision',
      EXPORT_ARTIFACT: 'canvas:export-artifact',
      LOAD_WEBVIEW: 'canvas:load-webview',
      LOAD_WEBVIEW_PREVIEW: 'canvas:load-webview-preview',
      LOAD_IMAGE_MODULE: 'canvas:load-image-module',
      SAVE_IMAGE_MODULE: 'canvas:save-image-module',
      CREATE_IMAGE_JOB: 'canvas:create-image-job',
      CANCEL_IMAGE_JOB: 'canvas:cancel-image-job',
      RETRY_IMAGE_JOB: 'canvas:retry-image-job',
      ADOPT_IMAGE_ASSET: 'canvas:adopt-image-asset',
      GET_IMAGE_CANDIDATE_BATCH: 'canvas:get-image-candidate-batch',
      CONTINUE_IMAGE_CANDIDATE_BATCH: 'canvas:continue-image-candidate-batch',
      ADOPT_IMAGE_CANDIDATE_BATCH: 'canvas:adopt-image-candidate-batch',
      ABANDON_IMAGE_CANDIDATE_BATCH: 'canvas:abandon-image-candidate-batch',
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
      LIST_AGENT_BINDINGS: 'canvas:list-agent-bindings',
      LINK_AGENT_CANVAS: 'canvas:link-agent-canvas',
      UNLINK_AGENT_CANVAS: 'canvas:unlink-agent-canvas',
      SET_DEFAULT_AGENT_CANVAS: 'canvas:set-default-agent-canvas',
      CLEAR_AGENT_BINDINGS: 'canvas:clear-agent-bindings',
      AGENT_BINDINGS_CHANGED: 'canvas:agent-bindings-changed',
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
      source: {
        sessionId: 'session-1',
        runStartedAt: 100,
        toolCallId: 'tool-1',
      },
    })
    expect('path' in snapshot).toBe(false)
    expect('storageKind' in snapshot).toBe(false)
  })

  test('Given WebView 节点目标 When 跨进程解析 Then 保留完整身份并拒绝额外字段', () => {
    /** WebView 预览必须绑定图节点、内容目录与内容 revision。 */
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-webview',
      prototypeId: 'prototype-1', contentRevision: 4,
    }
    /** HTML 快照只公开业务身份和正文，不暴露磁盘路径。 */
    const snapshot: CanvasWebviewSnapshot = { target, html: '<main>首页</main>' }

    expect(parseCanvasWebviewTarget(target)).toEqual(target)
    expect(() => parseCanvasWebviewTarget({ ...target, contentRevision: -1 })).toThrow('CANVAS_WEBVIEW_TARGET_INVALID')
    expect(() => parseCanvasWebviewTarget({ ...target, path: '/private/index.html' })).toThrow('CANVAS_WEBVIEW_TARGET_INVALID')
    expect(snapshot.html).toContain('首页')
    expect('path' in snapshot).toBe(false)
  })

  test('Given WebView 设备与预览合同 When 跨进程解析 Then 只接受完整严格身份', () => {
    expect(parseCanvasWebviewDevicePreset('desktop')).toBe('desktop')
    expect(parseCanvasWebviewDevicePreset('mobile')).toBe('mobile')
    expect(() => parseCanvasWebviewDevicePreset('tablet')).toThrow('CANVAS_WEBVIEW_DEVICE_PRESET_INVALID')

    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-webview',
      prototypeId: 'prototype-1', contentRevision: 4, devicePreset: 'mobile' as const,
    }
    const snapshot = {
      target,
      previewUrl: 'proma-media://canvas-webview-preview/token',
      width: 390,
      height: 844,
    }

    expect(parseCanvasWebviewPreviewTarget(target)).toEqual(target)
    expect(parseCanvasWebviewPreviewSnapshot(snapshot)).toEqual(snapshot)
    expect(() => parseCanvasWebviewPreviewTarget({ ...target, devicePreset: 'tablet' }))
      .toThrow('CANVAS_WEBVIEW_PREVIEW_TARGET_INVALID')
    expect(() => parseCanvasWebviewPreviewSnapshot({ ...snapshot, localPath: '/private/preview.webp' }))
      .toThrow('CANVAS_WEBVIEW_PREVIEW_SNAPSHOT_INVALID')
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
        relation: 'derives',
      },
    }

    expect(input.relationship).toEqual({
      sourceNodeId: 'source-1',
      edgeId: '33333333-3333-4333-8333-333333333333',
      relation: 'derives',
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

    expect(CANVAS_DOCUMENT_VERSION).toBe(4)
    expect(document).toEqual({
      schemaVersion: 4,
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
      relation: 'association',
    }

    expect(edge).toEqual({
      id: 'edge-1',
      sourceNodeId: 'node-agent',
      sourcePort: 'output',
      targetNodeId: 'node-image',
      targetPort: 'prompt',
      relation: 'association',
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

  test('Given WebView 设备切换 mutation When 归约 Then 只修改目标节点并保持位置', () => {
    const document = createDocument()
    document.nodes.push(webviewNode)

    const result = applyCanvasMutations(document, [{
      type: 'set-webview-device-preset',
      nodeId: webviewNode.id,
      devicePreset: 'mobile',
    }])

    expect(result.nodes.at(-1)).toEqual({ ...webviewNode, devicePreset: 'mobile' })
    expect(result.nodes.at(-1)?.position).toEqual(webviewNode.position)
    expect(result.nodes.slice(0, -1)).toEqual(document.nodes.slice(0, -1))
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
      relation: 'reference',
    }
    /** 新增的稳定边。 */
    const appendedEdge: CanvasEdge = {
      id: 'edge-image-webview',
      sourceNodeId: imageNode.id,
      sourcePort: 'image',
      targetNodeId: webviewNode.id,
      targetPort: 'preview',
      relation: 'derives',
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
      relation: 'depends-on',
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

describe('Canvas 图片候选批次合同', () => {
  /** 创建可复用的严格候选批次样例。 */
  const createBatch = () => ({
    schemaVersion: 1 as const,
    batchId: 'batch-1',
    projectId: 'project-1',
    canvasId: 'canvas-1',
    source: 'canvas-tool' as const,
    sourceSessionId: 'session-1',
    sourceToolCallId: 'tool-1',
    status: 'partial' as const,
    entries: [
      {
        nodeId: 'node-b', imageModuleId: 'module-b', initialAdoptedAssetId: 'asset-old-b',
        initialConfigRevision: 2, jobId: 'job-b', candidateAssetId: null,
        status: 'failed' as const, error: '生成失败',
      },
      {
        nodeId: 'node-a', imageModuleId: 'module-a', initialAdoptedAssetId: 'asset-old-a',
        initialConfigRevision: 3, jobId: 'job-a', candidateAssetId: 'asset-new-a',
        status: 'candidate' as const, error: null,
      },
    ],
    adoption: null,
    createdAt: 10,
    updatedAt: 20,
  })

  test('Given exact-key 批次 When 解析 Then 深拷贝并按节点稳定排序', () => {
    const raw = createBatch()
    const parsed = parseCanvasImageCandidateBatch(raw)
    expect(parsed.entries.map((entry) => entry.nodeId)).toEqual(['node-a', 'node-b'])
    raw.entries[0]!.error = '外部修改'
    expect(parsed.entries.find((entry) => entry.nodeId === 'node-b')?.error).toBe('生成失败')
  })

  test('Given 未知字段或重复节点 When 解析 Then fail closed', () => {
    expect(() => parseCanvasImageCandidateBatch({ ...createBatch(), unknown: true }))
      .toThrow('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    const duplicate = createBatch()
    duplicate.entries[1]!.nodeId = duplicate.entries[0]!.nodeId
    expect(() => parseCanvasImageCandidateBatch(duplicate))
      .toThrow('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
  })

  test('Given 活跃摘要与采用输入 When 解析 Then 严格重建公开值', () => {
    expect(parseCanvasImageCandidateBatchSummary({
      batchId: 'batch-1', projectId: 'project-1', canvasId: 'canvas-1', status: 'ready',
      totalCount: 2, candidateCount: 2, failedCount: 0, runningCount: 0, updatedAt: 20,
      entries: [{ nodeId: 'node-b', status: 'candidate' }, { nodeId: 'node-a', status: 'candidate' }],
    })).toEqual({
      batchId: 'batch-1', projectId: 'project-1', canvasId: 'canvas-1', status: 'ready',
      totalCount: 2, candidateCount: 2, failedCount: 0, runningCount: 0, updatedAt: 20,
      entries: [{ nodeId: 'node-a', status: 'candidate' }, { nodeId: 'node-b', status: 'candidate' }],
    })
    expect(parseAdoptCanvasImageCandidateBatchInput({
      projectId: 'project-1', canvasId: 'canvas-1', batchId: 'batch-1', mode: 'succeeded',
    }).mode).toBe('succeeded')
  })

  test('Given 摘要节点重复或数量不闭合 When 解析 Then fail closed', () => {
    const base = {
      batchId: 'batch-1', projectId: 'project-1', canvasId: 'canvas-1', status: 'partial',
      totalCount: 2, candidateCount: 1, failedCount: 1, runningCount: 0, updatedAt: 20,
    }
    expect(() => parseCanvasImageCandidateBatchSummary({
      ...base,
      entries: [{ nodeId: 'node-a', status: 'candidate' }, { nodeId: 'node-a', status: 'failed' }],
    })).toThrow('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    expect(() => parseCanvasImageCandidateBatchSummary({
      ...base,
      entries: [{ nodeId: 'node-a', status: 'candidate' }],
    })).toThrow('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
  })
})
