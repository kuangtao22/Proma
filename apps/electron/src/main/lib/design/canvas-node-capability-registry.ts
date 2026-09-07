import type { CanvasNode } from '@proma/shared'

/** Agent 可发现的节点操作提示；它不是 Host 授权凭据。 */
export type CanvasNodeCapability =
  | 'read'
  | 'update-config'
  | 'update-content'
  | 'run'
  | 'review-required'

/** 单次读取时由 Host 权威事实派生的节点可用状态。 */
export interface CanvasNodeCapabilityState {
  availability: 'available' | 'unavailable' | 'corrupt'
}

/** 提供节点能力枚举与静态能力预检的纯派生注册表。 */
export interface CanvasNodeCapabilityRegistry {
  list: (node: CanvasNode, state: CanvasNodeCapabilityState) => CanvasNodeCapability[]
  assert: (node: CanvasNode, capability: CanvasNodeCapability) => void
}

/** 返回节点类别静态支持的能力，顺序同时作为公开展示顺序。 */
function listSupportedCapabilities(node: CanvasNode): CanvasNodeCapability[] {
  switch (node.kind) {
    case 'agent': return ['read', 'update-config', 'run']
    case 'image': return ['read', 'update-config', 'run', 'review-required']
    case 'audio':
    case 'video': return ['read', 'update-config', 'run', 'review-required']
    case 'document':
    case 'webview': return ['read', 'update-content']
  }
}

/** Canvas 能力仅从权威节点和本轮运行态派生，不写回节点或磁盘。 */
export const canvasNodeCapabilityRegistry: CanvasNodeCapabilityRegistry = {
  list: (node, state) => {
    const capabilities = listSupportedCapabilities(node)
    return state.availability === 'available'
      ? capabilities
      : capabilities.filter((capability) => capability !== 'run')
  },
  assert: (node, capability) => {
    if (!listSupportedCapabilities(node).includes(capability)) {
      throw new Error('CANVAS_NODE_CAPABILITY_UNSUPPORTED')
    }
  },
}
