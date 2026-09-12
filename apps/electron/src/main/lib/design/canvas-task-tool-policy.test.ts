import { describe, expect, test } from 'bun:test'
import { requiresCanvasTask } from './canvas-task-tool-policy'

describe('画布交付操作前置登记', () => {
  test('Given 未登记任务 When 请求导入、修改或生成正式成果 Then 必须先登记', () => {
    for (const tool of ['canvas_import_image', 'canvas_create_artifact', 'canvas_update_artifact',
      'canvas_run_nodes', 'canvas_run_workflow', 'canvas_resume_workflow', 'canvas_retry_task',
      'canvas_attach_media_assets', 'canvas_attach_media_run', 'canvas_adopt_media_candidate',
      'media_import_remote_asset', 'media_execute_run', 'media_import_local_file']) {
      expect(requiresCanvasTask(tool, {})).toBe(true)
    }
  })

  test('Given 只读、停止或创建空画布 When 调用工具 Then 不因缺任务阻止安全操作', () => {
    for (const tool of ['canvas_read', 'canvas_get_context', 'canvas_inspect_images',
      'canvas_inspect_media', 'canvas_cancel_task', 'canvas_cancel_media_run', 'canvas_cancel_workflow',
      'canvas_manage', 'Bash']) expect(requiresCanvasTask(tool, {})).toBe(false)
  })

  test('Given 结构事务 When 仅移动视图 Then 无需登记而混入业务修改时需要', () => {
    expect(requiresCanvasTask('canvas_apply_changes', { operations: [{ type: 'move-nodes', positions: [] }] })).toBe(false)
    expect(requiresCanvasTask('canvas_apply_changes', { operations: [{ type: 'set-viewport' }] })).toBe(false)
    expect(requiresCanvasTask('canvas_apply_changes', { operations: [
      { type: 'move-nodes', positions: [] }, { type: 'remove-nodes', nodeIds: ['source'] },
    ] })).toBe(true)
    expect(requiresCanvasTask('canvas_apply_changes', { operations: [{ type: 'upsert-edges', edges: [] }] })).toBe(true)
  })
})
