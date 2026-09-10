import { createCanvasBoundEdge, resolveCanvasEdgeBinding } from './canvas'
import type { CanvasDocument, CanvasEdge, CanvasNode, CanvasNodeKind } from './canvas'
import type { CanvasMediaInputBinding, CanvasMediaTarget } from './canvas-media'

/** 单个输入的连接事实；连通不表示上游已有可消费产物。 */
export interface CanvasMediaInputConnection {
  inputKey: string
  sourceNodeId: string | null
  errorCode: string | null
  message: string
}

/** 缺边计划只描述精确端口，提交方分配 ID 并通过现有图 CAS 保存。 */
export interface CanvasMediaInputConnections {
  connected: boolean
  bindings: CanvasMediaInputConnection[]
  missingEdges: Omit<CanvasEdge, 'id'>[]
}

/** 将受控错误码翻译为可操作提示，不展示内部异常或路径。 */
export function getCanvasMediaInputErrorMessage(code: string): string {
  switch (code) {
    case 'CANVAS_MEDIA_SOURCE_EDGE_MISSING': return '尚未连接来源节点，请补齐输入连线。'
    case 'CANVAS_MEDIA_SOURCE_EDGE_INVALID': return '现有连线端口不匹配，请补齐正确的输入连线。'
    case 'CANVAS_MEDIA_SOURCE_NODE_MISSING': return '来源节点已失效，请重新选择当前画布中的节点。'
    case 'CANVAS_MEDIA_SOURCE_OUTPUT_KEY_INVALID': return '来源输出不匹配，请重新选择节点输出。'
    case 'CANVAS_MEDIA_SOURCE_KIND_MISMATCH': return '来源类型与输入不匹配，请选择兼容输出。'
    case 'CANVAS_MEDIA_SOURCE_SELF_REFERENCE': return '输入不能引用节点自身，请选择上游节点。'
    case 'CANVAS_MEDIA_IMAGE_OUTPUT_NOT_ADOPTED':
    case 'CANVAS_MEDIA_SOURCE_NOT_ADOPTED': return '来源还没有正式采用的产物，请先完成并采用上游输出。'
    case 'CANVAS_MEDIA_AGENT_OUTPUT_MISSING': return '来源 Agent 还没有正式输出。'
    case 'CANVAS_MEDIA_SOURCE_CHANGED':
    case 'CANVAS_MEDIA_DOCUMENT_OUTPUT_STALE':
    case 'CANVAS_MEDIA_AGENT_OUTPUT_STALE': return '来源输出已变化，请刷新后重新检查。'
    case 'CANVAS_MEDIA_LITERAL_ASSET_INVALID': return '所选素材已失效，请重新选择。'
    default: return '输入尚不可用，请检查来源及其正式输出。'
  }
}

/** 返回节点类型的固定输出能力；AV 的具体业务 output key 由模块合同另行检查。 */
export function getCanvasMediaSourcePort(kind: CanvasNodeKind): string {
  return kind === 'agent' ? 'agent.text' : kind === 'document' ? 'document.markdown'
    : kind === 'webview' ? 'webview.html' : `${kind}.asset`
}

/** 与运行时共用的精确直接边检查，AV 正式产物可提供实际媒体类型。 */
export function getCanvasMediaInputEdgeError(
  document: CanvasDocument,
  source: CanvasNode,
  target: CanvasNode,
  requiredKind: CanvasMediaInputBinding['kind'],
  outputMediaKind?: 'image' | 'audio' | 'video',
): string | null {
  /** 纯关联不构成媒体依赖；保留已有 reference/derives 语义。 */
  const edges = document.edges.filter((edge) => edge.sourceNodeId === source.id
    && edge.targetNodeId === target.id && edge.relation !== 'association')
  if (edges.length === 0) return 'CANVAS_MEDIA_SOURCE_EDGE_MISSING'
  /** AV 多输出的端口由当前正式输出实际类型确定。 */
  const kind = outputMediaKind ?? source.kind
  for (const edge of edges) {
    const binding = resolveCanvasEdgeBinding(edge, kind, target.kind)
    if (binding.state !== 'bound' || binding.sourceCapability !== getCanvasMediaSourcePort(kind)) continue
    if (requiredKind === 'text' && binding.targetSlot === 'context.text') return null
    if (requiredKind === 'image' && binding.targetSlot === 'context.image') return null
    if (requiredKind === 'audio' && (binding.targetSlot === 'audio.reference' || binding.targetSlot === 'context.audio')) return null
    if (requiredKind === 'video' && (binding.targetSlot === 'video.reference' || binding.targetSlot === 'context.video')) return null
  }
  return 'CANVAS_MEDIA_SOURCE_EDGE_INVALID'
}

/**
 * 从当前图与已保存/编辑中的输入派生连接事实，不读取素材且不修改文档。
 * @param document 当前画布权威图。
 * @param target 精确媒体目标。
 * @param inputs 待检查的类型化输入。
 * @returns 逐槽诊断和去重后的增量补边计划，正式产物仍由运行前解析器校验。
 */
export function inspectCanvasMediaInputConnections(
  document: CanvasDocument,
  target: CanvasMediaTarget,
  inputs: readonly CanvasMediaInputBinding[],
): CanvasMediaInputConnections {
  return createCanvasMediaInputConnectionInspector(document)(target, inputs)
}

/** 同一图的多张折叠卡片共用一次节点/入边索引，避免逐卡重复扫描整图。 */
export function createCanvasMediaInputConnectionInspector(document: CanvasDocument): (
  target: CanvasMediaTarget, inputs: readonly CanvasMediaInputBinding[],
) => CanvasMediaInputConnections {
  /** 索引只属于调用方固定的这一代图，不跨可变对象缓存。 */
  const nodes = new Map(document.nodes.map((node) => [node.id, node]))
  const incomingEdges = new Map<string, CanvasEdge[]>()
  for (const edge of document.edges) {
    const incoming = incomingEdges.get(edge.targetNodeId) ?? []
    incoming.push(edge)
    incomingEdges.set(edge.targetNodeId, incoming)
  }
  return (target, inputs) => inspectIndexedConnections(document, nodes, incomingEdges.get(target.nodeId) ?? [], target, inputs)
}

/** 使用固定节点索引与目标入边，逐槽规划可安全新增的连接。 */
function inspectIndexedConnections(
  document: CanvasDocument,
  nodes: ReadonlyMap<string, CanvasNode>,
  incomingEdges: CanvasEdge[],
  target: CanvasMediaTarget,
  inputs: readonly CanvasMediaInputBinding[],
): CanvasMediaInputConnections {
  const targetNode = nodes.get(target.nodeId)
  if (document.canvasId !== target.canvasId || document.projectId !== target.projectId
    || !targetNode || targetNode.kind !== target.mediaKind || targetNode.mediaModuleId !== target.mediaModuleId) {
    throw new Error('CANVAS_MEDIA_TARGET_INVALID')
  }
  /** 同来源的首尾帧槽位可共用一条类型化依赖。 */
  const planned = new Map<string, Omit<CanvasEdge, 'id'>>()
  const bindings = inputs.map((input): CanvasMediaInputConnection => {
    if (input.source.type === 'literal') return { inputKey: input.key, sourceNodeId: null, errorCode: null, message: '' }
    const source = nodes.get(input.source.nodeId)
    const isAv = source?.kind === 'audio' || source?.kind === 'video'
    let errorCode: string | null = !source ? 'CANVAS_MEDIA_SOURCE_NODE_MISSING'
      : source.id === targetNode.id ? 'CANVAS_MEDIA_SOURCE_SELF_REFERENCE'
      : !isAv && input.source.outputKey !== getCanvasMediaSourcePort(source.kind) ? 'CANVAS_MEDIA_SOURCE_OUTPUT_KEY_INVALID'
      : input.kind === 'text' ? (source.kind === 'agent' || source.kind === 'document' ? null : 'CANVAS_MEDIA_SOURCE_KIND_MISMATCH')
      : source.kind !== input.kind ? 'CANVAS_MEDIA_SOURCE_KIND_MISMATCH' : null
    if (!errorCode && source) {
      errorCode = getCanvasMediaInputEdgeError({ ...document, edges: incomingEdges }, source, targetNode, input.kind)
      if (errorCode) {
        /** 建边复用共享规则；仅新增，不覆盖原端口或删除其它用途的边。 */
        const { id: _id, ...edge } = createCanvasBoundEdge(source, targetNode, {
          id: 'pending', sourceNodeId: source.id, targetNodeId: targetNode.id, relation: 'depends-on',
        })
        planned.set(JSON.stringify([edge.sourceNodeId, edge.sourcePort, edge.targetNodeId, edge.targetPort]), edge)
      }
    }
    return { inputKey: input.key, sourceNodeId: input.source.nodeId, errorCode,
      message: errorCode ? getCanvasMediaInputErrorMessage(errorCode) : '' }
  })
  return { connected: bindings.every((binding) => binding.errorCode === null), bindings, missingEdges: [...planned.values()] }
}
