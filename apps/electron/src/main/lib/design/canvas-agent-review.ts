import type { CanvasDocument, CanvasEdge, CanvasNode } from '@proma/shared'

/** 父 Agent 明确选择本轮审核范围；canvas仅用于整张画布属于同一任务时。 */
export interface CanvasAgentReviewScope {
  mode: 'canvas' | 'nodes'
  nodeIds?: string[]
}

/** 在最终启动快照上解析的范围，不改变直接输入或执行依赖。 */
export interface CanvasAgentReviewContext {
  canvasId: string
  revision: number
  mode: CanvasAgentReviewScope['mode']
  nodeIds: string[]
  edges: CanvasEdge[]
}

/** 本轮数据送达覆盖；数量精确，诊断ID仅提供最多32项样本。 */
export interface CanvasAgentReviewCoverage {
  canvasId: string
  scopeRevision: number
  totalNodes: number
  readNodes: number
  unreadNodes: number
  failedNodes: number
  incompleteNodes: number
  unreadNodeIds: string[]
  failedNodeIds: string[]
  incompleteNodeIds: string[]
  totalEdges: number
  readEdges: number
  missingEdges: number
  missingEdgeSamples: Array<Pick<CanvasEdge, 'id' | 'sourceNodeId' | 'targetNodeId'>>
  complete: boolean
  qualityVerdict: 'not-assessed'
}

/** 只消费canvas_read预算裁剪后的当前正文/配置；不读取图片字节或历史目录。 */
interface CanvasAgentReviewReadResult {
  canvasId: string
  revision: number
  nodes: Array<{
    node: Pick<CanvasNode, 'id' | 'kind' | 'title'> & { position?: CanvasNode['position'] }
    content: string
    contentLength: number
    artifact?: Record<string, unknown>
    readError?: unknown
    issue?: unknown
  }>
  edges: CanvasEdge[]
}

/** 单次审核仅在内存内累计已送达事实，生命周期随Agent运行结束。 */
export interface CanvasAgentReviewTracker {
  record: (result: CanvasAgentReviewReadResult) => void
  status: () => CanvasAgentReviewCoverage
}

/** 校验显式范围并从权威快照提取目标和所有关联边；不凭连通性遗漏孤立节点。 */
export function resolveCanvasAgentReviewContext(
  document: CanvasDocument,
  agentNodeId: string,
  scope: CanvasAgentReviewScope,
): CanvasAgentReviewContext {
  /** 运行目标必须是本图的真实Agent。 */
  const agent = document.nodes.find(node => node.id === agentNodeId)
  if (agent?.kind !== 'agent') throw new Error('CANVAS_AGENT_NODE_REQUIRED')
  if (scope.mode !== 'canvas' && scope.mode !== 'nodes') throw new Error('CANVAS_REVIEW_SCOPE_INVALID')
  if (scope.mode === 'canvas' && scope.nodeIds !== undefined) throw new Error('CANVAS_REVIEW_SCOPE_INVALID')
  if (scope.mode === 'nodes' && (!Array.isArray(scope.nodeIds) || scope.nodeIds.length === 0
    || scope.nodeIds.length > 128 || scope.nodeIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 128))) {
    throw new Error('CANVAS_REVIEW_SCOPE_INVALID')
  }
  /** ID索引用于线性验证范围，显式局部复核不隐式扩大任务。 */
  const availableIds = new Set(document.nodes.map(node => node.id))
  if (scope.nodeIds?.some(id => !availableIds.has(id))) throw new Error('CANVAS_REVIEW_NODE_NOT_FOUND')
  /** 自身输出会在结束时提交，不是本轮需要先读取的生产输入。 */
  const nodeIds = [...new Set(scope.mode === 'canvas' ? document.nodes.map(node => node.id) : scope.nodeIds!)]
    .filter(id => id !== agentNodeId)
  if (scope.mode === 'nodes' && nodeIds.length === 0) throw new Error('CANVAS_REVIEW_SCOPE_INVALID')
  /** 保留跨范围关系供补读，不能用局部诱导子图冒充全部入出边。 */
  const selected = new Set(nodeIds)
  return {
    canvasId: document.canvasId, revision: document.revision, mode: scope.mode, nodeIds,
    edges: document.edges.filter(edge => selected.has(edge.sourceNodeId) || selected.has(edge.targetNodeId))
      .map(edge => ({ ...edge })),
  }
}

/** 创建按固定revision累计的当前数据覆盖记录；complete不表示视觉或语义审核通过。 */
export function createCanvasAgentReviewTracker(context: CanvasAgentReviewContext): CanvasAgentReviewTracker {
  /** 每个目标只保存读取状态，不持有正文、配置或媒体字节。 */
  const states = new Map(context.nodeIds.map(id => [id, 'unread' as 'unread' | 'read' | 'failed' | 'incomplete']))
  /** 关系必须是本轮基线中的同一条真实边，支持分批补读。 */
  const expectedEdges = new Map(context.edges.map(edge => [edge.id, JSON.stringify(edge)]))
  /** 已返回关系仅保存ID以避免重复复制图。 */
  const readEdgeIds = new Set<string>()
  return {
    record: result => {
      if (result.canvasId !== context.canvasId || result.revision !== context.revision) return
      for (const entry of result.nodes) {
        if (!states.has(entry.node.id)) continue
        if (entry.readError || entry.issue) {
          states.set(entry.node.id, 'failed')
          continue
        }
        /** 图片正文在config.prompt中；其它类型沿用content，媒体配置裁剪单独检查。 */
        const config = entry.artifact?.config
        /** 仅提取已送达的字符串长度，不保存正文。 */
        const prompt = config && typeof config === 'object' && 'prompt' in config ? config.prompt : undefined
        /** 无正式输出的合法空草稿可以完成数据盘点，仍须由导演判断缺少产物。 */
        const length = entry.node.kind === 'image' ? (typeof prompt === 'string' ? prompt.length : -1) : entry.content.length
        /** 即使历史列表被限流，当前节点/正文/配置完整时仍可记录当前输入覆盖。 */
        const complete = entry.node.position !== undefined && length === entry.contentLength
          && entry.artifact?.configOmitted !== true
        if (complete) states.set(entry.node.id, 'read')
        else states.set(entry.node.id, 'incomplete')
      }
      for (const edge of result.edges) {
        if (expectedEdges.get(edge.id) === JSON.stringify(edge)) readEdgeIds.add(edge.id)
      }
    },
    status: () => {
      /** 每类诊断计数与有界样本一次遍历产生，不复制节点内容。 */
      const groups = { unread: { count: 0, ids: [] as string[] }, read: { count: 0, ids: [] as string[] },
        failed: { count: 0, ids: [] as string[] }, incomplete: { count: 0, ids: [] as string[] } }
      for (const [id, state] of states) {
        groups[state].count += 1
        if (groups[state].ids.length < 32) groups[state].ids.push(id)
      }
      /** 缺边样本附带端点，便于以成对节点补读，不把样本误称全量列表。 */
      const missingEdgeSamples = context.edges.filter(edge => !readEdgeIds.has(edge.id)).slice(0, 32)
        .map(edge => ({ id: edge.id, sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId }))
      return {
        canvasId: context.canvasId, scopeRevision: context.revision,
        totalNodes: states.size, readNodes: groups.read.count, unreadNodes: groups.unread.count,
        failedNodes: groups.failed.count, incompleteNodes: groups.incomplete.count,
        unreadNodeIds: groups.unread.ids, failedNodeIds: groups.failed.ids, incompleteNodeIds: groups.incomplete.ids,
        totalEdges: expectedEdges.size, readEdges: readEdgeIds.size, missingEdges: expectedEdges.size - readEdgeIds.size,
        missingEdgeSamples, complete: groups.read.count === states.size && readEdgeIds.size === expectedEdges.size,
        qualityVerdict: 'not-assessed',
      }
    },
  }
}
