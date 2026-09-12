import { describe, expect, test } from 'bun:test'
import { CANVAS_MEDIA_REVIEW_TOOL_NAMES } from './canvas-media-review-tools'
import {
  CANVAS_READ_ONLY_TOOL_NAMES,
  filterCanvasAgentToolNamesForMode,
  isCanvasAgentToolAllowed,
} from './canvas-agent-tool-policy'

describe('Canvas 音视频评审工具策略', () => {
  test('Given 音视频检查与评审工具 When Canvas Agent运行 Then 手动与父编排模式均显式放行', () => {
    for (const toolName of CANVAS_MEDIA_REVIEW_TOOL_NAMES) {
      expect(CANVAS_READ_ONLY_TOOL_NAMES.has(toolName)).toBe(true)
      expect(isCanvasAgentToolAllowed('renderer-manual', toolName)).toBe(true)
      expect(isCanvasAgentToolAllowed('parent-orchestrated', toolName)).toBe(true)
    }
  })

  test('Given 白名单过滤包含新工具和相似伪造名称 When 过滤 Then 只保留固定工具名', () => {
    expect(filterCanvasAgentToolNamesForMode([
      'canvas_inspect_media_content', 'canvas_review_media', 'canvas_review_media_admin',
    ], 'parent-orchestrated')).toEqual(['canvas_inspect_media_content', 'canvas_review_media'])
  })
})
