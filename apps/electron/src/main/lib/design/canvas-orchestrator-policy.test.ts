import { describe, expect, test } from 'bun:test'
import { isCanvasAgentToolAllowed, type CanvasAgentToolMode } from './canvas-agent-tool-policy'

describe('画布编排角色能力', () => {
  test('Given Host 编排角色 When 构造工具 Then 可以维护计划和分派但不能重新委托或任意创建调度树', () => {
    /** 编排模式由 Host 注入，测试不依赖节点标题授予能力。 */
    const mode = 'canvas-orchestrator' as CanvasAgentToolMode
    expect(isCanvasAgentToolAllowed(mode, 'canvas_update_plan')).toBe(true)
    expect(isCanvasAgentToolAllowed(mode, 'canvas_dispatch')).toBe(true)
    expect(isCanvasAgentToolAllowed(mode, 'canvas_finish_orchestration')).toBe(true)
    expect(isCanvasAgentToolAllowed(mode, 'canvas_get_orchestration')).toBe(true)
    expect(isCanvasAgentToolAllowed(mode, 'canvas_create_agent')).toBe(false)
    expect(isCanvasAgentToolAllowed(mode, 'canvas_run_agent')).toBe(false)
    expect(isCanvasAgentToolAllowed(mode, 'canvas_delegate')).toBe(false)
  })

  test('Given 既有专业节点或手动节点 When 调用编排工具 Then 不继承编排能力', () => {
    for (const mode of ['parent-orchestrated', 'renderer-manual'] as const) {
      expect(isCanvasAgentToolAllowed(mode, 'canvas_dispatch')).toBe(false)
      expect(isCanvasAgentToolAllowed(mode, 'canvas_update_plan')).toBe(false)
      expect(isCanvasAgentToolAllowed(mode, 'canvas_delegate')).toBe(false)
    }
    expect(isCanvasAgentToolAllowed('parent-orchestrated', 'canvas_run_nodes')).toBe(false)
    expect(isCanvasAgentToolAllowed('renderer-manual', 'canvas_run_nodes')).toBe(true)
  })
})
