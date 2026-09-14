import { describe, expect, it } from 'bun:test'
import { canvasOrchestrationBranch, createCanvasOrchestrationGuard } from './canvas-orchestration-guard'
import type { CanvasOrchestrationService } from './canvas-orchestration-service'
import type { CanvasToolRunContext } from './canvas-tool-provider'

/** 有界守卫替身只提供当前任务及可信运行验证，记录属于固定画布。 */
function fixture(mode?: CanvasToolRunContext['canvasAgentMode']) {
  const record = { id: 'delegation', projectId: 'project', canvasId: 'canvas', status: 'running',
    request: { intent: 'produce', referenceNodeIds: ['reference'] },
    steps: [{ id: 'script', status: 'running', agentNodeId: 'agent', inputNodeIds: ['reference'], outputNodeIds: ['output'], dependsOn: [] }] }
  const context: CanvasToolRunContext = { projectId: 'project', sessionId: mode ? 'child' : 'owner',
    runStartedAt: 10, explicitReferences: [], permissionCeiling: 'execute',
    ...(mode ? { canvasAgentMode: mode, canvasAgentTarget: { projectId: 'project', canvasId: 'canvas', nodeId: 'agent' },
      canvasOrchestrationId: 'delegation', canvasOrchestrationStepId: mode === 'parent-orchestrated' ? 'script' : undefined,
      canvasOrchestrationParentSessionId: 'coordinator', canvasOrchestrationUserMessageUuid: 'specialist-anchor' } : {}) }
  const service = { get: () => record, assertActor: () => record, assertBranch: () => ({ record, step: record.steps[0] }) } as unknown as CanvasOrchestrationService
  return { record, context, guard: createCanvasOrchestrationGuard(service, context) }
}

describe('画布编排单一写入者与专业范围', () => {
  it('Given 已委托任务 When 普通会话继续生产 Then 拒绝双重调度但允许查询和取消委托', () => {
    const { guard } = fixture()
    expect(() => guard('canvas_create_artifact', { canvasId: 'canvas' })).toThrow('CANVAS_ORCHESTRATION_OWNS_WRITES')
    expect(() => guard('canvas_read', { canvasId: 'canvas' })).not.toThrow()
    expect(() => guard('canvas_cancel_orchestration', { canvasId: 'canvas' })).not.toThrow()
    /** 原会话必须能取消遗留竞争任务，底层仍负责严格核对运行所有者。 */
    expect(() => guard('canvas_cancel_workflow', { canvasId: 'canvas' })).not.toThrow()
    expect(() => guard('canvas_resume_workflow', { canvasId: 'canvas' })).toThrow('CANVAS_ORCHESTRATION_OWNS_WRITES')
  })
  it('Given 专业分支 When 修改本职产物或其它节点 Then 只准已分配输出', () => {
    const { guard, context } = fixture('parent-orchestrated')
    expect(canvasOrchestrationBranch(context).userMessageUuid).toBe('specialist-anchor')
    expect(() => guard('canvas_update_artifact', { canvasId: 'canvas', nodeId: 'output' })).not.toThrow()
    expect(() => guard('canvas_update_artifact', { canvasId: 'canvas', nodeId: 'reference' })).toThrow('CANVAS_ORCHESTRATION_NODE_SCOPE')
    expect(() => guard('canvas_apply_changes', { canvasId: 'canvas', operations: [{ type: 'remove-nodes', nodeIds: ['reference'] }] })).toThrow()
    expect(() => guard('canvas_run_nodes', { canvasId: 'canvas', nodeIds: ['output'] })).toThrow()
  })
  it('Given 已取消的旧专业上下文 When 再执行读取 Then 仍复验身份', () => {
    const { context } = fixture('parent-orchestrated')
    const service = { assertBranch: () => { throw new Error('cancelled') } } as unknown as CanvasOrchestrationService
    expect(() => createCanvasOrchestrationGuard(service, context)('canvas_read', { canvasId: 'canvas' })).toThrow('cancelled')
  })
  it('Given 编排运行 When 使用旧整图调度或独立媒体旁路 Then 拒绝绕过步骤与预算', () => {
    const { guard } = fixture('canvas-orchestrator')
    expect(() => guard('canvas_run_workflow', { canvasId: 'canvas' })).toThrow()
    expect(() => guard('media_execute_run', {})).toThrow()
  })
})
