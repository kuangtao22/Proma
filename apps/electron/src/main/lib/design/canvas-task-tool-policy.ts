/** 需要绑定交付任务的正式内容、采用及执行入口；停止操作始终可用。 */
const DELIVERY_TOOLS = new Set([
  'canvas_create_agent', 'canvas_import_image', 'canvas_create_artifact', 'canvas_create_media',
  'canvas_update_artifact', 'canvas_update_image_config', 'canvas_update_agent_config', 'canvas_update_media_config',
  'canvas_run_agent', 'canvas_run_nodes', 'canvas_run_workflow', 'canvas_resume_workflow', 'canvas_retry_task',
  'canvas_attach_media_assets', 'canvas_attach_media_run', 'canvas_adopt_media_candidate', 'canvas_adopt_version',
  'canvas_adopt_image_candidates', 'canvas_adopt_candidate_batch', 'canvas_restore_node', 'canvas_rebuild_agent',
  'media_import_local_file', 'media_import_assets', 'media_import_remote_asset', 'media_execute_run',
])

/** 判断工具是否修改正式交付；读取、布局和停止操作不依赖制作合同。 */
export function requiresCanvasTask(toolName: string, params: Record<string, unknown>): boolean {
  if (toolName !== 'canvas_apply_changes') return DELIVERY_TOOLS.has(toolName)
  if (!Array.isArray(params.operations)) return true
  return params.operations.some((operation: unknown) => {
    if (!operation || typeof operation !== 'object' || !('type' in operation)) return true
    return operation.type !== 'move-nodes' && operation.type !== 'set-viewport'
  })
}
