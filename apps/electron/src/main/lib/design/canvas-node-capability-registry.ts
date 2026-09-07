import type { CanvasNode } from '@proma/shared'

/** Agent 可发现的节点操作提示；它不是 Host 授权凭据。 */
export type CanvasNodeCapability =
  | 'read'
  | 'preview'
  | 'update-config'
  | 'update-content'
  | 'run'
  | 'review-required'
  | 'task-status'
  | 'task-control'
  | 'versions'
  | 'adopt-version'
  | 'export'
  | 'rebuild'

/** 单次读取时由 Host 权威事实派生的节点可用状态。 */
export interface CanvasNodeCapabilityState {
  availability: 'available' | 'unavailable' | 'corrupt'
  /** 当前运行实际向模型开放的工具名；缺省时只做静态能力枚举。 */
  availableToolNames?: ReadonlySet<string>
  /** plan 运行只发现只读能力，Host 仍独立执法每次写入。 */
  permissionCeiling?: 'plan' | 'execute'
}

/** 提供节点能力枚举与静态能力预检的纯派生注册表。 */
export interface CanvasNodeCapabilityRegistry {
  list: (node: CanvasNode, state: CanvasNodeCapabilityState) => CanvasNodeCapability[]
  assert: (node: CanvasNode, capability: CanvasNodeCapability) => void
}

/** 返回节点类别静态支持的能力，顺序同时作为公开展示顺序。 */
function listSupportedCapabilities(node: CanvasNode): CanvasNodeCapability[] {
  switch (node.kind) {
    case 'agent': return ['read', 'update-config', 'run', 'rebuild']
    case 'image': return [
      'read', 'preview', 'update-config', 'run', 'review-required',
      'task-status', 'task-control', 'versions', 'adopt-version', 'export',
    ]
    case 'audio':
    case 'video': return ['read', 'update-config', 'run', 'review-required']
    case 'document':
    case 'webview': return ['read', 'update-content', 'versions', 'adopt-version', 'export']
  }
}

/** 会改变持久状态、外部文件或付费运行的能力在 plan 模式不应被发现。 */
const MUTATING_CAPABILITIES = new Set<CanvasNodeCapability>([
  'update-config', 'update-content', 'run', 'task-control', 'adopt-version', 'export', 'rebuild',
])

/** 判断能力是否由当前实际工具集合支持；同一能力可由兼容工具兜底。 */
function hasCapabilityTool(
  node: CanvasNode,
  capability: CanvasNodeCapability,
  availableToolNames: ReadonlySet<string>,
): boolean {
  switch (capability) {
    case 'read': return availableToolNames.has('canvas_read')
    case 'preview': return node.kind === 'audio' || node.kind === 'video'
      ? availableToolNames.has('canvas_inspect_media')
      : availableToolNames.has('canvas_inspect_images')
    case 'review-required': return true
    case 'run': return availableToolNames.has(node.kind === 'agent' ? 'canvas_run_agent' : 'canvas_run_nodes')
    case 'update-config': return node.kind === 'agent'
      ? availableToolNames.has('canvas_update_agent_config')
      : node.kind === 'audio' || node.kind === 'video'
        ? availableToolNames.has('canvas_update_media_config')
        : availableToolNames.has('canvas_update_image_config') || availableToolNames.has('canvas_update_artifact')
    case 'update-content': return availableToolNames.has('canvas_update_artifact')
    case 'task-status': return availableToolNames.has('canvas_get_task')
    case 'task-control': return availableToolNames.has('canvas_cancel_task')
      || availableToolNames.has('canvas_retry_task')
    case 'versions': return availableToolNames.has('canvas_list_versions')
      || availableToolNames.has('canvas_read_version')
    case 'adopt-version': return availableToolNames.has('canvas_adopt_version')
      || (node.kind === 'image' && availableToolNames.has('canvas_adopt_candidate_batch'))
    case 'export': return availableToolNames.has('canvas_export_artifact')
    case 'rebuild': return availableToolNames.has('canvas_rebuild_agent')
  }
}

/** Canvas 能力仅从权威节点和本轮运行态派生，不写回节点或磁盘。 */
export const canvasNodeCapabilityRegistry: CanvasNodeCapabilityRegistry = {
  list: (node, state) => {
    const capabilities = listSupportedCapabilities(node)
    return capabilities.filter((capability) => {
      if (state.availability !== 'available' && capability === 'run') return false
      if (state.permissionCeiling === 'plan' && MUTATING_CAPABILITIES.has(capability)) return false
      return state.availableToolNames
        ? hasCapabilityTool(node, capability, state.availableToolNames)
        : true
    })
  },
  assert: (node, capability) => {
    if (!listSupportedCapabilities(node).includes(capability)) {
      throw new Error('CANVAS_NODE_CAPABILITY_UNSUPPORTED')
    }
  },
}
