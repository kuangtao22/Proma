import { createHash } from 'node:crypto'
import type {
  CanvasBatchOperationEnvelope,
  CanvasChangeSource,
  CanvasDocument,
  CanvasMutation,
  CanvasNode,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
  DesignPoint,
} from '@proma/shared'
import { parseCanvasBatchOperationEnvelope } from '@proma/shared'
import type { CanvasBatchOperationResult } from './canvas-agent-batch-operation'
import type {
  CanvasNodeContentStore,
  PrepareCanvasArtifactContentInput,
} from './canvas-node-content-store'

/** 首版支持的 Agent 画布产物类型。 */
export type CanvasArtifactType = 'webview' | 'image'

/** 原子创建一次画布产物所需的可信输入。 */
export interface CanvasArtifactCreationInput extends CanvasTarget {
  baseRevision: number
  artifactType: CanvasArtifactType
  title: string
  content: string
  position?: DesignPoint
  sourceNodeId?: string
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
}

/** 产物固定放在来源节点右侧的水平间距。 */
const ARTIFACT_HORIZONTAL_GAP = 360

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
function createArtifactIdentity(input: CanvasArtifactCreationInput): {
  nodeId: string
  contentId: string
  edgeId: string
  rollbackId: string
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
  return {
    nodeId: `artifact-${digest}`,
    contentId: `artifact-content-${digest}`,
    edgeId: `artifact-edge-${digest}`,
    rollbackId: `artifact-rollback-${digest}`,
  }
}

/** 读取权威图后计算用户未指定位置时的新节点位置。 */
function resolveArtifactPosition(
  document: CanvasDocument,
  requested: DesignPoint | undefined,
  sourceNodeId: string | undefined,
): DesignPoint {
  if (requested) return { x: requested.x, y: requested.y }
  if (sourceNodeId) {
    /** 关联来源必须真实存在，不能让模型伪造悬空边。 */
    const sourceNode = document.nodes.find((node) => node.id === sourceNodeId)
    if (!sourceNode) throw new Error('CANVAS_ARTIFACT_SOURCE_NODE_NOT_FOUND')
    return {
      x: sourceNode.position.x + ARTIFACT_HORIZONTAL_GAP,
      y: sourceNode.position.y,
    }
  }
  /** 无来源时追加到当前最右节点之后，空画布从原点开始。 */
  const rightmostX = document.nodes.reduce<number | null>((maximum, node) => (
    maximum === null ? node.position.x : Math.max(maximum, node.position.x)
  ), null)
  return { x: rightmostX === null ? 0 : rightmostX + ARTIFACT_HORIZONTAL_GAP, y: 0 }
}

/** 根据当前权威 revision 构造新节点和可选关联边。 */
function createArtifactOperations(
  input: CanvasArtifactCreationInput,
  document: CanvasDocument,
  identity: ReturnType<typeof createArtifactIdentity>,
): CanvasMutation[] {
  if (document.revision !== input.baseRevision) throw new Error('CANVAS_REVISION_CONFLICT')
  if (document.nodes.some((node) => node.id === identity.nodeId)) {
    throw new Error('CANVAS_ARTIFACT_NODE_IDENTITY_CONFLICT')
  }
  /** 新节点位置基于本次权威图计算。 */
  const position = resolveArtifactPosition(document, input.position, input.sourceNodeId)
  /** 节点只引用受管内容 ID，不暴露文件路径。 */
  const node: CanvasNode = input.artifactType === 'webview'
    ? {
        id: identity.nodeId,
        kind: 'webview',
        title: input.title,
        position,
        prototypeId: identity.contentId,
        contentRevision: 0,
      }
    : {
        id: identity.nodeId,
        kind: 'image',
        title: input.title,
        position,
        imageModuleId: identity.contentId,
      }
  /** 节点提交和可选连线保持在同一个 batch。 */
  const operations: CanvasMutation[] = [{ type: 'upsert-nodes', nodes: [node] }]
  if (input.sourceNodeId) {
    operations.push({
      type: 'upsert-edges',
      edges: [{
        id: identity.edgeId,
        sourceNodeId: input.sourceNodeId,
        sourcePort: 'output',
        targetNodeId: identity.nodeId,
        targetPort: 'input',
      }],
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
  return artifactType === 'webview'
    ? node.kind === 'webview' && node.prototypeId === contentId
    : node.kind === 'image' && node.imageModuleId === contentId
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
          }
        : { kind: 'webview', contentId: identity.contentId, content: input.content }
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
  }
}
