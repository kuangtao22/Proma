import { expect, test } from 'bun:test'
import type { CanvasOrchestrationRecord } from '@proma/shared'
import { authorizeCanvasMediaActor } from './canvas-orchestration-media-access'
import type { CanvasMediaActorAccessDependencies } from './canvas-orchestration-media-access'

/** 隔离来源授权，观察原会话及可信编排模式，不运行远端任务。 */
function fixture() {
  const record: CanvasOrchestrationRecord = { schemaVersion: 1, id: 'orchestration', revision: 1,
    projectId: 'project', canvasId: 'canvas', ownerSessionId: 'owner', coordinatorSessionId: 'coordinator',
    coordinatorNodeId: 'agent', status: 'waiting', steps: [], summary: '', runStartedAt: 10, createdAt: 1, updatedAt: 10,
    request: { requestId: 'request', goal: '视频', intent: 'produce', constraints: [], referenceNodeIds: [],
      deliverables: [{ id: 'video', title: '视频', kind: 'video', criteria: ['完整成片'] }] } }
  const calls: string[] = []
  const permissions = new Map<string, string>()
  const dependencies: CanvasMediaActorAccessDependencies = {
    getOrchestration: () => record,
    getPermissionMode: sessionId => permissions.get(sessionId),
    access: { authorizeRead: context => { calls.push(`read:${context.canvasAgentMode ?? 'project-agent'}`) },
      requireLinkedCanvas: context => { calls.push(`owner:${context.sessionId}`); return null as never },
      runWrite: (context, effect) => { calls.push(`write:${context.sessionId}`); return effect() } },
  }
  const origin = { actor: { mode: 'canvas-orchestrator' as const, sessionId: 'coordinator', runStartedAt: 10, canvasId: 'canvas', nodeId: 'agent' } }
  return { record, calls, permissions, dependencies, origin }
}

test('Given 编排回合已等待远端 When 后台执行 Then 保留真实模式并复核原委托者权限', () => {
  const harness = fixture()
  authorizeCanvasMediaActor(harness.dependencies, 'project', 'execute', harness.origin)
  expect(harness.calls).toEqual(['owner:owner', 'write:owner', 'read:canvas-orchestrator'])
})

test('Given 委托已取消或执行代次变化 When 后台尝试新提交 Then 拒绝执行但允许已提交产物收集', () => {
  const harness = fixture()
  harness.record.status = 'cancelled'
  expect(() => authorizeCanvasMediaActor(harness.dependencies, 'project', 'execute', harness.origin)).toThrow('MEDIA_EXECUTION_NOT_AUTHORIZED')
  authorizeCanvasMediaActor(harness.dependencies, 'project', 'collect', harness.origin)
  expect(harness.calls).toEqual([])
  harness.record.status = 'waiting'
  harness.record.runStartedAt = 11
  expect(() => authorizeCanvasMediaActor(harness.dependencies, 'project', 'execute', harness.origin)).toThrow('MEDIA_EXECUTION_NOT_AUTHORIZED')
})

test('Given 委托已取消且原用户权限不再允许生成 When 用户停止既有任务 Then 仍复核真实来源并允许取消', () => {
  const harness = fixture()
  harness.record.status = 'cancelled'
  harness.permissions.set('owner', 'plan')

  authorizeCanvasMediaActor(harness.dependencies, 'project', 'cancel', harness.origin)
  expect(harness.calls).toEqual(['owner:owner', 'write:owner', 'read:canvas-orchestrator'])

  /** 原委托继续到新一轮后，仍可停止它上一轮已经提交的远端运行。 */
  harness.record.runStartedAt = 11
  authorizeCanvasMediaActor(harness.dependencies, 'project', 'cancel', harness.origin)
  harness.origin.actor.nodeId = 'other-agent'
  expect(() => authorizeCanvasMediaActor(harness.dependencies, 'project', 'cancel', harness.origin)).toThrow('MEDIA_EXECUTION_NOT_AUTHORIZED')
})

test('Given 原委托者转为规划或节点来源伪造 When 准备或执行 Then 不能继承旧的媒体授权', () => {
  const harness = fixture()
  harness.permissions.set('owner', 'plan')
  expect(() => authorizeCanvasMediaActor(harness.dependencies, 'project', 'prepare', harness.origin)).toThrow('MEDIA_EXECUTION_NOT_AUTHORIZED')
  harness.permissions.clear()
  harness.origin.actor.nodeId = 'other-agent'
  expect(() => authorizeCanvasMediaActor(harness.dependencies, 'project', 'execute', harness.origin)).toThrow('MEDIA_EXECUTION_NOT_AUTHORIZED')
})

test('Given 旧专业分支和普通会话 When 沿原媒体路径执行 Then 专业禁止生成且普通会话保留原能力', () => {
  const harness = fixture()
  expect(() => authorizeCanvasMediaActor(harness.dependencies, 'project', 'execute', {
    actor: { ...harness.origin.actor, mode: 'parent-orchestrated' },
  })).toThrow('MEDIA_EXECUTION_NOT_AUTHORIZED')
  authorizeCanvasMediaActor(harness.dependencies, 'project', 'execute', {
    actor: { mode: 'project-agent', sessionId: 'owner', runStartedAt: 10 },
  })
  expect(harness.calls).toContain('read:project-agent')
})
