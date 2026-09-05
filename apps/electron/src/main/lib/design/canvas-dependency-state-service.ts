import {
  CANVAS_UPSTREAM_CHANGE_MAX_SOURCE_IDS,
  resolveCanvasEdgeBinding,
} from '@proma/shared'
import type { CanvasDocument, CanvasNode } from '@proma/shared'

/** 正式产物提交后消费 producer 提示并传播直接下游的输入。 */
export interface ConsumeAndPropagateCanvasDependencyStateInput {
  document: CanvasDocument
  producerNodeIds: string[]
  changedAt: number
}

/** 正式产物依赖提示的纯投影服务。 */
export interface CanvasDependencyStateService {
  consumeAndPropagate: (input: ConsumeAndPropagateCanvasDependencyStateInput) => {
    nodes: CanvasNode[]
    downstreamNodeIds: string[]
  }
}

/** 允许传播“上游已变化”提示的数据关系。 */
const PROPAGATING_RELATIONS = new Set(['reference', 'depends-on', 'derives'])

/** 返回移除当前待更新提示后的 producer 节点副本。 */
function consumeUpstreamChange(node: CanvasNode): CanvasNode {
  /** 可选字段必须真实移除，避免把 undefined 作为额外图事实传入 reducer。 */
  const { upstreamChange: _consumed, ...consumedNode } = node
  return consumedNode
}

/** 创建不执行 I/O、不持久化的依赖状态投影服务。 */
export function createCanvasDependencyStateService(): CanvasDependencyStateService {
  return {
    consumeAndPropagate: (input) => {
      /** producer 集合先去重，后续节点和边扫描均保持线性复杂度。 */
      const producerNodeIds = new Set(input.producerNodeIds)
      /** 权威节点索引用于拒绝 dangling 边并解析实际绑定状态。 */
      const nodesById = new Map(input.document.nodes.map((node) => [node.id, node]))
      /** 每个直接下游聚合本次变化的 producer，Set 保证重复边不重复来源。 */
      const changedSourcesByNodeId = new Map<string, Set<string>>()
      for (const edge of input.document.edges) {
        if (!producerNodeIds.has(edge.sourceNodeId)
          || !PROPAGATING_RELATIONS.has(edge.relation)) continue
        const source = nodesById.get(edge.sourceNodeId)
        const target = nodesById.get(edge.targetNodeId)
        if (!source || !target
          || resolveCanvasEdgeBinding(edge, source.kind, target.kind).state !== 'bound') continue
        /** 同批 producer 自身已经提交新正式输出，消费提示优先于本批内部传播。 */
        if (producerNodeIds.has(target.id)) continue
        const sources = changedSourcesByNodeId.get(target.id) ?? new Set<string>()
        sources.add(source.id)
        changedSourcesByNodeId.set(target.id, sources)
      }

      /** 只返回 producer 与实际变化的直接下游，顺序遵循权威文档并保持稳定。 */
      const nodes: CanvasNode[] = []
      for (const node of input.document.nodes) {
        if (producerNodeIds.has(node.id)) {
          nodes.push(consumeUpstreamChange(node))
          continue
        }
        const changedSources = changedSourcesByNodeId.get(node.id)
        if (!changedSources) continue
        /** 保留尚未消费的旧来源，并与本次来源去重后按稳定 ID 排序。 */
        const sourceNodeIds = [...new Set([
          ...(node.upstreamChange?.sourceNodeIds ?? []),
          ...changedSources,
        ])].sort()
        if (sourceNodeIds.length > CANVAS_UPSTREAM_CHANGE_MAX_SOURCE_IDS) {
          throw new Error('CANVAS_DEPENDENCY_SOURCE_LIMIT_EXCEEDED')
        }
        nodes.push({
          ...node,
          upstreamChange: {
            sourceNodeIds,
            changedAt: Math.max(node.upstreamChange?.changedAt ?? 0, input.changedAt),
          },
        })
      }
      return {
        nodes,
        downstreamNodeIds: [...changedSourcesByNodeId.keys()].sort(),
      }
    },
  }
}
