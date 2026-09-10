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
  | 'adopt-candidate'
  | 'attach-assets'
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

/** Agent 可直接调用的一项节点动作及其本轮可用工具。 */
export interface CanvasNodeAction {
  capability: CanvasNodeCapability
  toolNames: string[]
}

/** 节点能力及其兼容工具声明；空工具只用于表达非动作状态。 */
interface CanvasNodeCapabilityDefinition {
  capability: CanvasNodeCapability
  toolNames: readonly string[]
}

/** 构造单项能力声明，保持类别映射紧凑且顺序明确。 */
function defineCapability(
  capability: CanvasNodeCapability,
  ...toolNames: string[]
): CanvasNodeCapabilityDefinition {
  return { capability, toolNames }
}

/** 返回节点类别静态支持的能力与工具映射，顺序同时作为公开展示顺序。 */
function listSupportedCapabilityDefinitions(node: CanvasNode): CanvasNodeCapabilityDefinition[] {
  switch (node.kind) {
    case 'agent': return [
      defineCapability('read', 'canvas_read'),
      defineCapability('update-config', 'canvas_update_agent_config'),
      defineCapability('run', 'canvas_run_agent'),
      defineCapability('rebuild', 'canvas_rebuild_agent'),
    ]
    case 'image': return [
      defineCapability('read', 'canvas_read'),
      defineCapability('preview', 'canvas_inspect_images'),
      defineCapability('update-config', 'canvas_update_image_config', 'canvas_update_artifact'),
      defineCapability('run', 'canvas_run_nodes'),
      defineCapability('review-required'),
      defineCapability('task-status', 'canvas_get_task'),
      defineCapability('task-control', 'canvas_cancel_task', 'canvas_retry_task'),
      defineCapability('versions', 'canvas_list_versions', 'canvas_read_version'),
      defineCapability('adopt-version', 'canvas_adopt_version', 'canvas_adopt_candidate_batch'),
      defineCapability('export', 'canvas_export_artifact'),
    ]
    case 'audio':
    case 'video': return [
      defineCapability('read', 'canvas_read'),
      defineCapability('update-config', 'canvas_update_media_config'),
      defineCapability('run', 'canvas_run_nodes'),
      defineCapability('review-required'),
      defineCapability('task-status', 'canvas_inspect_media'),
      defineCapability('task-control', 'canvas_cancel_media_run'),
      defineCapability('adopt-candidate', 'canvas_adopt_media_candidate'),
      defineCapability('attach-assets', 'canvas_attach_media_assets'),
    ]
    case 'document':
    case 'webview': return [
      defineCapability('read', 'canvas_read'),
      defineCapability('update-content', 'canvas_update_artifact'),
      defineCapability('versions', 'canvas_list_versions', 'canvas_read_version'),
      defineCapability('adopt-version', 'canvas_adopt_version'),
      defineCapability('export', 'canvas_export_artifact'),
    ]
  }
}

/** 会改变持久状态、外部文件或付费运行的能力在 plan 模式不应被发现。 */
const MUTATING_CAPABILITIES = new Set<CanvasNodeCapability>([
  'update-config', 'update-content', 'run', 'task-control', 'adopt-version',
  'adopt-candidate', 'attach-assets', 'export', 'rebuild',
])

/** 判断能力声明是否满足节点状态、权限上限和本轮工具集合。 */
function isCapabilityDiscoverable(
  definition: CanvasNodeCapabilityDefinition,
  state: CanvasNodeCapabilityState,
): boolean {
  if (state.availability !== 'available' && definition.capability === 'run') return false
  if (state.permissionCeiling === 'plan' && MUTATING_CAPABILITIES.has(definition.capability)) return false
  if (!state.availableToolNames || definition.toolNames.length === 0) return true
  return definition.toolNames.some((toolName) => state.availableToolNames?.has(toolName))
}

/** 返回声明中当前实际可用的兼容工具；缺省工具集合时返回完整静态映射。 */
function listAvailableToolNames(
  definition: CanvasNodeCapabilityDefinition,
  availableToolNames?: ReadonlySet<string>,
): string[] {
  return availableToolNames
    ? definition.toolNames.filter((toolName) => availableToolNames.has(toolName))
    : [...definition.toolNames]
}

/**
 * 返回节点本轮可直接执行的结构化动作。
 * @param node 权威 Canvas 节点。
 * @param state 当前可用性、权限上限和实际工具集合。
 * @returns 按稳定能力顺序排列的动作；不包含纯审核状态标记。
 */
export function listCanvasNodeActions(
  node: CanvasNode,
  state: CanvasNodeCapabilityState,
): CanvasNodeAction[] {
  return listSupportedCapabilityDefinitions(node)
    .filter((definition) => definition.capability !== 'review-required')
    .filter((definition) => isCapabilityDiscoverable(definition, state))
    .map((definition) => ({
      capability: definition.capability,
      toolNames: listAvailableToolNames(definition, state.availableToolNames),
    }))
}

/** Canvas 能力仅从权威节点和本轮运行态派生，不写回节点或磁盘。 */
export const canvasNodeCapabilityRegistry: CanvasNodeCapabilityRegistry = {
  list: (node, state) => {
    return listSupportedCapabilityDefinitions(node)
      .filter((definition) => isCapabilityDiscoverable(definition, state))
      .map((definition) => definition.capability)
  },
  assert: (node, capability) => {
    if (!listSupportedCapabilityDefinitions(node)
      .some((definition) => definition.capability === capability)) {
      throw new Error('CANVAS_NODE_CAPABILITY_UNSUPPORTED')
    }
  },
}
