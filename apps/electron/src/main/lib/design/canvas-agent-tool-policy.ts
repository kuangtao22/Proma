import { MEDIA_TOOL_NAMES } from '../media/media-tool-provider'
import { CANVAS_IMAGE_CANDIDATE_TOOL_NAMES } from './canvas-image-candidate-tools'

/** Host 可信注入的 Canvas Agent 运行模式。 */
export type CanvasAgentToolMode = 'renderer-manual' | 'parent-orchestrated'

/** 计划模式可使用的画布查询与内存任务协议，未知工具不能按名称前缀自动放行。 */
export const CANVAS_READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'canvas_task', 'canvas_get_context', 'canvas_list_nodes', 'canvas_read', 'canvas_inspect_images',
  'canvas_inspect_media', 'canvas_get_task', 'canvas_list_versions', 'canvas_read_version',
  'canvas_list_trash', 'canvas_list_workflows', 'canvas_get_workflow',
  'canvas_get_workflow_run', 'canvas_list_workflow_runs',
])

/** Renderer 手动运行保留完整的 Canvas Agent 交互能力。 */
const RENDERER_MANUAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...CANVAS_IMAGE_CANDIDATE_TOOL_NAMES,
  ...MEDIA_TOOL_NAMES,
  'media_list_sources',
  'media_import_assets',
  'media_import_local_file',
  'media_get_asset_file',
  'canvas_attach_media_assets',
  'canvas_get_context',
  'canvas_task',
  'canvas_list_nodes',
  'canvas_inspect_images',
  'canvas_read',
  'canvas_apply_changes',
  'canvas_import_image',
  'canvas_create_artifact',
  'canvas_create_media',
  'canvas_update_artifact',
  'canvas_update_image_config',
  'canvas_update_media_config',
  'canvas_inspect_media',
  'canvas_adopt_media_candidate',
  'canvas_get_workflow_run',
  'canvas_list_workflow_runs',
  'canvas_resume_workflow',
  'canvas_cancel_workflow',
  'canvas_cancel_media_run',
  'canvas_run_nodes',
  'canvas_get_task',
  'canvas_cancel_task',
  'canvas_retry_task',
  'canvas_list_versions',
  'canvas_read_version',
  'canvas_adopt_version',
  'canvas_export_artifact',
  'canvas_list_trash',
  'canvas_restore_node',
])

/** 父编排允许检查与准备产物，但不能递归启动或控制高影响运行。 */
const PARENT_ORCHESTRATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...CANVAS_IMAGE_CANDIDATE_TOOL_NAMES,
  ...MEDIA_TOOL_NAMES.filter((name) => !['media_execute_run', 'media_cancel_run', 'media_save_profile'].includes(name)),
  'media_list_sources',
  'media_import_assets',
  'canvas_get_context',
  'canvas_task',
  'canvas_list_nodes',
  'canvas_inspect_images',
  'canvas_read',
  'canvas_apply_changes',
  'canvas_import_image',
  'canvas_create_artifact',
  'canvas_create_media',
  'canvas_update_artifact',
  'canvas_update_image_config',
  'canvas_get_task',
  'canvas_list_versions',
  'canvas_read_version',
  'canvas_update_media_config',
  'canvas_inspect_media',
  'canvas_adopt_media_candidate',
  'canvas_get_workflow_run',
  'canvas_list_workflow_runs',
])

/** 返回可信模式对应的固定正向集合，未知工具默认拒绝。 */
function getAllowedToolNames(mode: CanvasAgentToolMode): ReadonlySet<string> {
  return mode === 'parent-orchestrated'
    ? PARENT_ORCHESTRATED_TOOL_NAMES
    : RENDERER_MANUAL_TOOL_NAMES
}

/** 判断指定工具是否属于当前 Canvas Agent 模式的能力边界。 */
export function isCanvasAgentToolAllowed(mode: CanvasAgentToolMode, toolName: string): boolean {
  return getAllowedToolNames(mode).has(toolName)
}

/** 按输入顺序过滤工具名，供 Provider 与执行前二次复核共享。 */
export function filterCanvasAgentToolNamesForMode(
  toolNames: readonly string[],
  mode: CanvasAgentToolMode,
): string[] {
  const allowedToolNames = getAllowedToolNames(mode)
  return toolNames.filter((toolName) => allowedToolNames.has(toolName))
}
