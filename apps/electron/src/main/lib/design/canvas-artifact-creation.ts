import { createHash } from 'node:crypto'
import type {
  CanvasBatchOperationEnvelope,
  CanvasChangeSource,
  CanvasDocument,
  CanvasEdgeRelation,
  CanvasMutation,
  CanvasNode,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
  CanvasWebviewDevicePreset,
  CanvasLayoutRect,
  CanvasLayoutSize,
  DesignPoint,
} from '@proma/shared'
import {
  createCanvasBoundEdge,
  createCanvasLayoutSpatialIndex,
  findCompactCanvasSlot,
  parseCanvasBatchOperationEnvelope,
} from '@proma/shared'
import type { CanvasBatchOperationResult } from './canvas-agent-batch-operation'
import type {
  CanvasNodeContentStore,
  PrepareCanvasArtifactContentInput,
} from './canvas-node-content-store'

/** 首版支持的 Agent 画布产物类型。 */
export type CanvasArtifactType = 'document' | 'webview' | 'image'

/** 原子创建一次画布产物所需的可信输入。 */
export interface CanvasArtifactCreationInput extends CanvasTarget {
  baseRevision: number
  artifactType: CanvasArtifactType
  title: string
  content: string
  /** 仅主进程已验证的图片导入服务可提供；普通 Agent 工具不接收素材 ID。 */
  adoptedAssetId?: string
  /** WebView 可由 Agent 显式选择设备；缺省网页，图片产物忽略该字段。 */
  devicePreset?: CanvasWebviewDevicePreset
  position?: DesignPoint
  sourceNodeId?: string
  relation?: CanvasEdgeRelation
  source: CanvasChangeSource
}

/** 普通 Agent 显式创建独立 Canvas Agent 节点的可信输入。 */
export interface CanvasAgentArtifactCreationInput extends CanvasTarget {
  baseRevision: number
  title: string
  position?: DesignPoint
  sourceNodeId?: string
  relation?: CanvasEdgeRelation
  source: CanvasChangeSource
}

/** Agent 与 Renderer 可消费的稳定产物事实。 */
export interface CanvasArtifactCreationResult {
  canvasId: string
  nodeId: string
  revision: number
  artifactType: CanvasArtifactType
  sourceToolCallId: string
}

/** Agent 节点创建只返回图事实，不向模型暴露内部会话身份。 */
export interface CanvasAgentArtifactCreationResult {
  canvasId: string
  nodeId: string
  revision: number
  sourceToolCallId: string
}

/** 产物创建服务只编排现有权威 Store、内容 Store 与 batch。 */
export interface CanvasArtifactCreationDependencies {
  documents: {
    load: (target: CanvasTarget) => CanvasWorkspaceSnapshot
  }
  content: Pick<CanvasNodeContentStore, 'prepareArtifactContent' | 'discardPreparedContent'>
  batch: {
    execute: (input: CanvasBatchOperationEnvelope) => Promise<CanvasBatchOperationResult>
  }
  resolveDefaultImageModelProfileId?: (projectId: string) => string | null
}

/** 原子产物创建服务的公开窄接口。 */
export interface CanvasArtifactCreationService {
  create: (input: CanvasArtifactCreationInput) => Promise<CanvasArtifactCreationResult>
  createAgent: (input: CanvasAgentArtifactCreationInput) => Promise<CanvasAgentArtifactCreationResult>
}

/** 自动创建节点之间保留的最小净间距。 */
const ARTIFACT_LAYOUT_GAP = 24
/** Agent 显式坐标允许超出当前图边界的最大距离。 */
const ARTIFACT_REQUESTED_POSITION_MARGIN = 1_600
/** 常规 Agent、文档和无预览图片节点的折叠尺寸。 */
const ARTIFACT_DEFAULT_SIZE: CanvasLayoutSize = { width: 288, height: 144 }
/** 桌面 WebView 折叠卡片的稳定预览尺寸。 */
const ARTIFACT_WEBVIEW_DESKTOP_SIZE: CanvasLayoutSize = { width: 384, height: 316 }
/** 手机 WebView 折叠卡片的稳定预览尺寸。 */
const ARTIFACT_WEBVIEW_MOBILE_SIZE: CanvasLayoutSize = { width: 232, height: 578 }

/** 判断 batch 抛出的错误是否允许权威重读后重试一次。 */
function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes('CANVAS_REVISION_CONFLICT')
    || error.message.includes('CANVAS_BATCH_INTENT_PLAN_CONFLICT')
  )
}

/** 在共享 128 字符 ID 上限内生成唯一重试身份。 */
function createRetryToolCallId(toolCallId: string): string {
  /** 固定后缀用于避免第二次 batch 命中首次失败的 intent。 */
  const suffix = '-retry'
  return `${toolCallId.slice(0, 128 - suffix.length)}${suffix}`
}

/** 从工具调用和目标身份派生稳定资源 ID，重放不会产生重复节点。 */
function createArtifactIdentity(input: Pick<CanvasArtifactCreationInput, 'projectId' | 'canvasId' | 'source'>): {
  nodeId: string
  contentId: string
  edgeId: string
  rollbackId: string
  agentSessionId: string
} {
  /** 长度前缀阻止字段拼接产生边界碰撞。 */
  const identity = [
    input.projectId,
    input.canvasId,
    input.source.sessionId,
    String(input.source.runStartedAt),
    input.source.toolCallId,
  ].map((value) => `${value.length}:${value}`).join('|')
  /** 单次哈希同时派生同一事务的图与内容资源。 */
  const digest = createHash('sha256').update(identity).digest('hex')
  /** 独立 Agent session 必须符合 UUID v4 形状，且同一工具调用重放保持稳定。 */
  const agentSessionId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  return {
    nodeId: `artifact-${digest}`,
    contentId: `artifact-content-${digest}`,
    edgeId: `artifact-edge-${digest}`,
    rollbackId: `artifact-rollback-${digest}`,
    agentSessionId,
  }
}

/** 根据节点类型解析主进程可证明的折叠卡片尺寸。 */
function resolveArtifactNodeSize(
  node: Pick<CanvasNode, 'kind'> & Partial<Pick<Extract<CanvasNode, { kind: 'webview' }>, 'devicePreset'>>,
): CanvasLayoutSize {
  if (node.kind !== 'webview') return ARTIFACT_DEFAULT_SIZE
  return node.devicePreset === 'mobile'
    ? ARTIFACT_WEBVIEW_MOBILE_SIZE
    : ARTIFACT_WEBVIEW_DESKTOP_SIZE
}

/** 将权威节点转换为共享空间索引使用的真实矩形。 */
function toArtifactLayoutRect(node: CanvasNode): CanvasLayoutRect {
  /** 节点类型决定可证明的当前折叠尺寸。 */
  const size = resolveArtifactNodeSize(node)
  return { id: node.id, ...node.position, ...size }
}

/** 根据待创建类型解析候选节点尺寸。 */
function resolveArtifactCandidateSize(input: CanvasArtifactCreationInput): CanvasLayoutSize {
  return resolveArtifactNodeSize({
    kind: input.artifactType,
    ...(input.artifactType === 'webview' ? { devicePreset: input.devicePreset ?? 'desktop' } : {}),
  })
}

/** 计算现有图的有限矩形边界；空图以原点作为可信范围。 */
function resolveArtifactDocumentBounds(rects: readonly CanvasLayoutRect[]): {
  left: number
  top: number
  right: number
  bottom: number
} {
  if (rects.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 }
  return rects.reduce((bounds, rect) => ({
    left: Math.min(bounds.left, rect.x),
    top: Math.min(bounds.top, rect.y),
    right: Math.max(bounds.right, rect.x + rect.width),
    bottom: Math.max(bounds.bottom, rect.y + rect.height),
  }), {
    left: rects[0]!.x,
    top: rects[0]!.y,
    right: rects[0]!.x + rects[0]!.width,
    bottom: rects[0]!.y + rects[0]!.height,
  })
}

/** 判断 Agent 显式坐标是否有限、不重叠且没有远离当前业务图。 */
function isSafeArtifactRequestedPosition(
  requested: DesignPoint,
  size: CanvasLayoutSize,
  rects: readonly CanvasLayoutRect[],
): boolean {
  if (!Number.isFinite(requested.x) || !Number.isFinite(requested.y)) return false
  /** 当前权威图空间索引用于拒绝覆盖已有节点。 */
  const index = createCanvasLayoutSpatialIndex(rects, ARTIFACT_LAYOUT_GAP)
  if (index.overlaps({ ...requested, ...size })) return false
  /** 可接受边界允许合理留白，但阻止模型制造数千像素外的孤立节点。 */
  const bounds = resolveArtifactDocumentBounds(rects)
  return requested.x >= bounds.left - ARTIFACT_REQUESTED_POSITION_MARGIN
    && requested.y >= bounds.top - ARTIFACT_REQUESTED_POSITION_MARGIN
    && requested.x + size.width <= bounds.right + ARTIFACT_REQUESTED_POSITION_MARGIN
    && requested.y + size.height <= bounds.bottom + ARTIFACT_REQUESTED_POSITION_MARGIN
}

/** 读取权威图后计算安全、紧凑且可重放的新节点位置。 */
function resolveArtifactPosition(
  document: CanvasDocument,
  requested: DesignPoint | undefined,
  sourceNodeId: string | undefined,
  candidateSize: CanvasLayoutSize,
): DesignPoint {
  /** 当前节点矩形只构建一次，供显式位置校验和自动槽位搜索复用。 */
  const rects = document.nodes.map(toArtifactLayoutRect)
  if (requested && isSafeArtifactRequestedPosition(requested, candidateSize, rects)) {
    return { x: requested.x, y: requested.y }
  }
  /** 空间索引确保动态 WebView 与常规节点保留统一净间距。 */
  const index = createCanvasLayoutSpatialIndex(rects, ARTIFACT_LAYOUT_GAP)
  if (sourceNodeId) {
    /** 关联来源必须真实存在，不能让模型伪造悬空边。 */
    const sourceNode = document.nodes.find((node) => node.id === sourceNodeId)
    if (!sourceNode) throw new Error('CANVAS_ARTIFACT_SOURCE_NODE_NOT_FOUND')
    /** 来源真实尺寸决定第一个兄弟槽位的水平锚点。 */
    const sourceSize = resolveArtifactNodeSize(sourceNode)
    /** 同一来源已有出边数是稳定兄弟顺序，不要求 Agent 计算坐标。 */
    const siblingOrder = document.edges.filter((edge) => edge.sourceNodeId === sourceNodeId).length
    return findCompactCanvasSlot(index, {
      anchor: {
        x: sourceNode.position.x + sourceSize.width + ARTIFACT_LAYOUT_GAP,
        y: sourceNode.position.y,
      },
      size: candidateSize,
      order: siblingOrder,
      direction: 'right',
    })
  }
  /** 首个权威节点提供稳定锚点，后续新增不会让整个槽位坐标系继续漂移。 */
  const stableRootRect = rects[0]
  return findCompactCanvasSlot(index, {
    anchor: stableRootRect === undefined
      ? { x: 0, y: 0 }
      : {
          x: stableRootRect.x + stableRootRect.width + ARTIFACT_LAYOUT_GAP,
          y: stableRootRect.y,
        },
    size: candidateSize,
    order: document.nodes.length,
    direction: 'ring',
  })
}

/** 根据当前权威 revision 构造新节点和可选关联边。 */
function createArtifactOperations(
  input: CanvasArtifactCreationInput,
  document: CanvasDocument,
  identity: ReturnType<typeof createArtifactIdentity>,
): CanvasMutation[] {
  if (input.adoptedAssetId && input.artifactType !== 'image') {
    throw new Error('CANVAS_ARTIFACT_ADOPTED_ASSET_UNEXPECTED')
  }
  if (input.sourceNodeId && !input.relation) throw new Error('CANVAS_ARTIFACT_RELATION_REQUIRED')
  if (!input.sourceNodeId && input.relation) throw new Error('CANVAS_ARTIFACT_RELATION_UNEXPECTED')
  if (document.revision !== input.baseRevision) throw new Error('CANVAS_REVISION_CONFLICT')
  if (document.nodes.some((node) => node.id === identity.nodeId)) {
    throw new Error('CANVAS_ARTIFACT_NODE_IDENTITY_CONFLICT')
  }
  /** 候选真实尺寸参与显式坐标校验和自动避让。 */
  const candidateSize = resolveArtifactCandidateSize(input)
  /** 新节点位置基于本次权威图和稳定业务顺序计算。 */
  const position = resolveArtifactPosition(document, input.position, input.sourceNodeId, candidateSize)
  /** 节点只引用受管内容 ID，不暴露文件路径。 */
  const node: CanvasNode = input.artifactType === 'document'
    ? {
        id: identity.nodeId,
        kind: 'document',
        title: input.title,
        position,
        documentId: identity.contentId,
        contentRevision: 0,
      }
    : input.artifactType === 'webview'
    ? {
        id: identity.nodeId,
        kind: 'webview',
        title: input.title,
        position,
        prototypeId: identity.contentId,
        contentRevision: 0,
        devicePreset: input.devicePreset ?? 'desktop',
      }
    : {
        id: identity.nodeId,
        kind: 'image',
        title: input.title,
        position,
        imageModuleId: identity.contentId,
        ...(input.adoptedAssetId ? { adoptedAssetId: input.adoptedAssetId } : {}),
      }
  /** 节点提交和可选连线保持在同一个 batch。 */
  const operations: CanvasMutation[] = [{ type: 'upsert-nodes', nodes: [node] }]
  if (input.sourceNodeId) {
    /** 已由位置解析验证存在的来源节点决定产物输出能力。 */
    const sourceNode = document.nodes.find((candidate) => candidate.id === input.sourceNodeId)
    if (!sourceNode) throw new Error('CANVAS_ARTIFACT_SOURCE_NODE_NOT_FOUND')
    operations.push({
      type: 'upsert-edges',
      edges: [createCanvasBoundEdge(sourceNode, node, {
        id: identity.edgeId,
        sourceNodeId: input.sourceNodeId,
        targetNodeId: identity.nodeId,
        relation: input.relation!,
      })],
    })
  }
  return operations
}

/** 根据权威图构造独立 Agent 节点和可选输入关系。 */
function createAgentOperations(
  input: CanvasAgentArtifactCreationInput,
  document: CanvasDocument,
  identity: ReturnType<typeof createArtifactIdentity>,
): CanvasMutation[] {
  if (input.sourceNodeId && !input.relation) throw new Error('CANVAS_ARTIFACT_RELATION_REQUIRED')
  if (!input.sourceNodeId && input.relation) throw new Error('CANVAS_ARTIFACT_RELATION_UNEXPECTED')
  if (document.revision !== input.baseRevision) throw new Error('CANVAS_REVISION_CONFLICT')
  if (document.nodes.some((node) => node.id === identity.nodeId)) {
    throw new Error('CANVAS_ARTIFACT_NODE_IDENTITY_CONFLICT')
  }
  /** Agent 折叠卡片使用标准尺寸，由 Host 计算紧凑安全位置。 */
  const position = resolveArtifactPosition(
    document,
    input.position,
    input.sourceNodeId,
    ARTIFACT_DEFAULT_SIZE,
  )
  const node: CanvasNode = {
    id: identity.nodeId,
    kind: 'agent',
    title: input.title,
    position,
    agentSessionId: identity.agentSessionId,
  }
  const operations: CanvasMutation[] = [{ type: 'upsert-nodes', nodes: [node] }]
  if (input.sourceNodeId) {
    const sourceNode = document.nodes.find((candidate) => candidate.id === input.sourceNodeId)
    if (!sourceNode) throw new Error('CANVAS_ARTIFACT_SOURCE_NODE_NOT_FOUND')
    operations.push({
      type: 'upsert-edges',
      edges: [createCanvasBoundEdge(sourceNode, node, {
        id: identity.edgeId,
        sourceNodeId: sourceNode.id,
        targetNodeId: node.id,
        relation: input.relation!,
      })],
    })
  }
  return operations
}

/** 判断权威节点是否确实引用当前工具准备的内容。 */
function isOwnedArtifactNode(
  node: CanvasNode,
  artifactType: CanvasArtifactType,
  contentId: string,
): boolean {
  if (artifactType === 'document') return node.kind === 'document' && node.documentId === contentId
  if (artifactType === 'webview') return node.kind === 'webview' && node.prototypeId === contentId
  return node.kind === 'image' && node.imageModuleId === contentId
}

/** 判断任意权威节点是否仍引用准备内容，避免补偿误删已提交资源。 */
function documentReferencesContent(document: CanvasDocument, contentId: string): boolean {
  return document.nodes.some((node) => (
    (node.kind === 'webview' && node.prototypeId === contentId)
    || (node.kind === 'image' && node.imageModuleId === contentId)
    || (node.kind === 'document' && node.documentId === contentId)
  ))
}

/** 创建只负责内容准备、batch 提交和失败对账的服务。 */
export function createCanvasArtifactCreationService(
  dependencies: CanvasArtifactCreationDependencies,
): CanvasArtifactCreationService {
  return {
    create: async (input) => {
      /** 目标 Canvas 身份贯穿所有权威读取和写入。 */
      const target: CanvasTarget = { projectId: input.projectId, canvasId: input.canvasId }
      /** 稳定身份保证同一工具调用可安全重放。 */
      const identity = createArtifactIdentity(input)
      /** 写内容前先验证初始 revision、来源节点和默认位置。 */
      const initialDocument = dependencies.documents.load(target).document
      createArtifactOperations(input, initialDocument, identity)
      /** 图片沿用项目当前默认模型；WebView 不携带图片配置。 */
      const preparedInput: PrepareCanvasArtifactContentInput = input.artifactType === 'image'
        ? {
            kind: 'image',
            contentId: identity.contentId,
            content: input.content,
            selectedModelProfileId: dependencies.resolveDefaultImageModelProfileId?.(input.projectId) ?? null,
            ...(input.adoptedAssetId ? { adoptedAssetId: input.adoptedAssetId } : {}),
          }
        : { kind: input.artifactType, contentId: identity.contentId, content: input.content }
      await dependencies.content.prepareArtifactContent(target, preparedInput)

      /** 以指定 revision 和 source ID 执行一次可恢复 batch。 */
      const execute = async (
        baseRevision: number,
        sourceToolCallId: string,
      ): Promise<CanvasArtifactCreationResult> => {
        /** 重试时基于最新权威图重新计算默认位置与来源关系。 */
        const currentDocument = dependencies.documents.load(target).document
        const retryInput = { ...input, baseRevision }
        const operations = createArtifactOperations(retryInput, currentDocument, identity)
        const envelope = parseCanvasBatchOperationEnvelope({
          ...target,
          baseRevision,
          operations,
          sourceSessionId: input.source.sessionId,
          sourceRunStartedAt: input.source.runStartedAt,
          sourceToolCallId,
        })
        const result = await dependencies.batch.execute(envelope)
        return {
          canvasId: input.canvasId,
          nodeId: identity.nodeId,
          revision: result.document.revision,
          artifactType: input.artifactType,
          sourceToolCallId,
        }
      }

      try {
        try {
          return await execute(input.baseRevision, input.source.toolCallId)
        } catch (error) {
          if (!isRevisionConflict(error)) throw error
          /** 首次冲突只允许权威重读后重试一次。 */
          const retryRevision = dependencies.documents.load(target).document.revision
          return await execute(retryRevision, createRetryToolCallId(input.source.toolCallId))
        }
      } catch (error) {
        /** batch 结果不确定时，以权威图判断是否已经提交成功。 */
        const authoritative = dependencies.documents.load(target).document
        const existingNode = authoritative.nodes.find((node) => node.id === identity.nodeId)
        if (existingNode && isOwnedArtifactNode(existingNode, input.artifactType, identity.contentId)) {
          return {
            canvasId: input.canvasId,
            nodeId: identity.nodeId,
            revision: authoritative.revision,
            artifactType: input.artifactType,
            sourceToolCallId: input.source.toolCallId,
          }
        }
        if (existingNode || documentReferencesContent(authoritative, identity.contentId)) throw error
        /** 只有权威图完全未引用内容时才执行精确补偿。 */
        await dependencies.content.discardPreparedContent(
          target,
          { kind: preparedInput.kind, contentId: preparedInput.contentId },
          identity.rollbackId,
        )
        throw error
      }
    },
    createAgent: async (input) => {
      const target: CanvasTarget = { projectId: input.projectId, canvasId: input.canvasId }
      const identity = createArtifactIdentity(input)
      /** 同一工具调用只允许一次权威重读重试，节点和会话身份始终不变。 */
      const execute = async (baseRevision: number, sourceToolCallId: string): Promise<CanvasAgentArtifactCreationResult> => {
        const document = dependencies.documents.load(target).document
        const operations = createAgentOperations({ ...input, baseRevision }, document, identity)
        const result = await dependencies.batch.execute(parseCanvasBatchOperationEnvelope({
          ...target,
          baseRevision,
          operations,
          sourceSessionId: input.source.sessionId,
          sourceRunStartedAt: input.source.runStartedAt,
          sourceToolCallId,
        }))
        return {
          canvasId: input.canvasId,
          nodeId: identity.nodeId,
          revision: result.document.revision,
          sourceToolCallId,
        }
      }
      try {
        try {
          return await execute(input.baseRevision, input.source.toolCallId)
        } catch (error) {
          if (!isRevisionConflict(error)) throw error
          const revision = dependencies.documents.load(target).document.revision
          return await execute(revision, createRetryToolCallId(input.source.toolCallId))
        }
      } catch (error) {
        /** 批处理可能已提交但返回不确定；只接受完全匹配的权威节点。 */
        const authoritative = dependencies.documents.load(target).document
        const existing = authoritative.nodes.find((node) => node.id === identity.nodeId)
        if (existing?.kind === 'agent' && existing.agentSessionId === identity.agentSessionId) {
          return {
            canvasId: input.canvasId,
            nodeId: identity.nodeId,
            revision: authoritative.revision,
            sourceToolCallId: input.source.toolCallId,
          }
        }
        throw error
      }
    },
  }
}
