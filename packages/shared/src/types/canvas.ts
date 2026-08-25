import type { DesignPoint, DesignViewport } from './design'

/** 独立 Canvas 图文档的当前 schema 版本。 */
export const CANVAS_DOCUMENT_VERSION = 1

/** Canvas 支持的节点类别，每类节点只引用自身业务事实源。 */
export type CanvasNodeKind = 'agent' | 'image' | 'visual-document' | 'webview'

/** Canvas 节点共享的展示和布局字段。 */
export interface CanvasNodeBase {
  id: string
  kind: CanvasNodeKind
  title: string
  position: DesignPoint
}

/** 引用独立 Agent 会话的节点，不复制消息或执行状态。 */
export interface CanvasAgentNode extends CanvasNodeBase {
  kind: 'agent'
  agentSessionId: string
  assetId?: never
  visualDocumentId?: never
  url?: never
  messages?: never
}

/** 引用 Canvas 图片素材的节点。 */
export interface CanvasImageNode extends CanvasNodeBase {
  kind: 'image'
  assetId: string
  agentSessionId?: never
  visualDocumentId?: never
  url?: never
}

/** 引用独立视觉文档的节点。 */
export interface CanvasVisualDocumentNode extends CanvasNodeBase {
  kind: 'visual-document'
  visualDocumentId: string
  agentSessionId?: never
  assetId?: never
  url?: never
}

/** 引用可恢复页面地址的 Webview 节点。 */
export interface CanvasWebviewNode extends CanvasNodeBase {
  kind: 'webview'
  url: string
  agentSessionId?: never
  assetId?: never
  visualDocumentId?: never
}

/** Canvas 中四类互斥业务引用节点。 */
export type CanvasNode =
  | CanvasAgentNode
  | CanvasImageNode
  | CanvasVisualDocumentNode
  | CanvasWebviewNode

/** 连接两个节点稳定端口的数据或任务边。 */
export interface CanvasEdge {
  id: string
  sourceNodeId: string
  sourcePort: string
  targetNodeId: string
  targetPort: string
}

/** 一个项目中单个 Canvas 会话的独立图文档。 */
export interface CanvasDocument {
  schemaVersion: typeof CANVAS_DOCUMENT_VERSION
  projectId: string
  canvasId: string
  revision: number
  viewport: DesignViewport
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  createdAt: number
  updatedAt: number
}

/** 替换 Canvas 视口的 mutation。 */
export interface SetCanvasViewportMutation {
  type: 'set-viewport'
  viewport: DesignViewport
}

/** 单个节点的稳定 ID 与目标位置。 */
export interface CanvasNodePosition {
  nodeId: string
  position: DesignPoint
}

/** 批量移动已存在节点的 mutation。 */
export interface MoveCanvasNodesMutation {
  type: 'move-nodes'
  positions: CanvasNodePosition[]
}

/** 按稳定 ID 替换或追加节点的 mutation。 */
export interface UpsertCanvasNodesMutation {
  type: 'upsert-nodes'
  nodes: CanvasNode[]
}

/** 按稳定 ID 删除节点的 mutation；相连边由 reducer 同步删除。 */
export interface RemoveCanvasNodesMutation {
  type: 'remove-nodes'
  nodeIds: string[]
}

/** 按稳定 ID 替换或追加边的 mutation。 */
export interface UpsertCanvasEdgesMutation {
  type: 'upsert-edges'
  edges: CanvasEdge[]
}

/** 按稳定 ID 删除边的 mutation。 */
export interface RemoveCanvasEdgesMutation {
  type: 'remove-edges'
  edgeIds: string[]
}

/** Canvas reducer 可按顺序应用的完整 mutation 联合。 */
export type CanvasMutation =
  | SetCanvasViewportMutation
  | MoveCanvasNodesMutation
  | UpsertCanvasNodesMutation
  | RemoveCanvasNodesMutation
  | UpsertCanvasEdgesMutation
  | RemoveCanvasEdgesMutation

/**
 * 创建同时绑定项目和 Canvas 会话身份的空图文档。
 * @param projectId 文档所属项目的稳定 ID。
 * @param canvasId 文档所属 Canvas 会话的稳定 ID。
 * @param now 文档创建与更新时间戳。
 * @returns revision 为 0、默认视口且无节点和边的新文档。
 */
export function createEmptyCanvasDocument(
  projectId: string,
  canvasId: string,
  now: number = Date.now(),
): CanvasDocument {
  return {
    schemaVersion: CANVAS_DOCUMENT_VERSION,
    projectId,
    canvasId,
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 使用稳定 ID 合并实体数组，已有实体在原位置替换，新实体按输入顺序追加。
 * @param current 当前保持有序的实体数组。
 * @param updates 需要替换或追加的实体数组。
 * @returns 合并后的新数组；同一批重复 ID 由最后一个更新值覆盖。
 */
function upsertCanvasEntities<T extends { id: string }>(current: T[], updates: T[]): T[] {
  /** Map 保留首次插入顺序，同时允许相同 ID 原位覆盖。 */
  const entitiesById = new Map(current.map((entity) => [entity.id, entity]))
  for (const update of updates) entitiesById.set(update.id, update)
  return [...entitiesById.values()]
}

/**
 * 以纯函数方式依次应用 Canvas mutation，不承担 Store 的 schema 校验和 revision 提交。
 * @param document 当前不可直接修改的 Canvas 文档。
 * @param mutations 需要按数组顺序应用的变更集合。
 * @returns 保留原 revision、包含全部归约结果的新文档。
 */
export function applyCanvasMutations(
  document: CanvasDocument,
  mutations: CanvasMutation[],
): CanvasDocument {
  /** 单次深拷贝同时隔离文档基线与 mutation payload，阻断调用方后续反向改写快照。 */
  const isolatedInputs = structuredClone({ document, mutations })
  /** 从隔离后的文档开始归约，保证调用方持有的基线不被修改。 */
  let next = isolatedInputs.document

  for (const mutation of isolatedInputs.mutations) {
    switch (mutation.type) {
      case 'set-viewport':
        next.viewport = mutation.viewport
        break
      case 'move-nodes': {
        /** 本次批量移动中每个节点 ID 对应的最终位置。 */
        const positionsByNodeId = new Map(
          mutation.positions.map((item) => [item.nodeId, item.position]),
        )
        next.nodes = next.nodes.map((node) => {
          /** 当前节点在 mutation 中声明的新位置，缺失表示保持原位。 */
          const position = positionsByNodeId.get(node.id)
          return position === undefined ? node : { ...node, position }
        })
        break
      }
      case 'upsert-nodes':
        next.nodes = upsertCanvasEntities(next.nodes, mutation.nodes)
        break
      case 'remove-nodes': {
        /** 待删除节点集合，用于同时过滤节点和所有相连边。 */
        const removedNodeIds = new Set(mutation.nodeIds)
        next.nodes = next.nodes.filter((node) => !removedNodeIds.has(node.id))
        next.edges = next.edges.filter((edge) => (
          !removedNodeIds.has(edge.sourceNodeId) && !removedNodeIds.has(edge.targetNodeId)
        ))
        break
      }
      case 'upsert-edges':
        next.edges = upsertCanvasEntities(next.edges, mutation.edges)
        break
      case 'remove-edges': {
        /** 待删除边集合，未知 ID 会自然忽略。 */
        const removedEdgeIds = new Set(mutation.edgeIds)
        next.edges = next.edges.filter((edge) => !removedEdgeIds.has(edge.id))
        break
      }
    }
  }

  return next
}
