import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanvasOrchestrationRecord, CanvasWorkflowRun } from '@proma/shared'
import { createCanvasExecutionOwnership } from './canvas-execution-ownership'
import type { CanvasExecutionOwnershipDependencies } from './canvas-execution-ownership'

/** 每例仅在临时 Canvas 根测试真实跨实例锁，不读取业务数据。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 使用最小状态投影模拟两个既有 Store，行为测试只关注准入与创建次数。 */
function fixture() {
  const canvasRoot = mkdtempSync(join(tmpdir(), 'proma-execution-ownership-'))
  roots.push(canvasRoot)
  const target = { projectId: 'project', canvasId: 'canvas' }
  let orchestrationStatus: CanvasOrchestrationRecord['status'] | null = null
  let workflowStatuses: CanvasWorkflowRun['status'][] = []
  const dependencies: CanvasExecutionOwnershipDependencies = {
    pathResolver: { resolveCanvas: () => ({ canvasRoot }) as ReturnType<CanvasExecutionOwnershipDependencies['pathResolver']['resolveCanvas']> },
    getOrchestration: () => orchestrationStatus ? { status: orchestrationStatus } as CanvasOrchestrationRecord : null,
    listWorkflows: () => workflowStatuses.map(status => ({ status }) as CanvasWorkflowRun),
    runWorkspaceWrite: (_projectId, effect) => effect(),
  }
  return { target, canvasRoot, dependencies, ownership: createCanvasExecutionOwnership(dependencies),
    setOrchestration: (status: typeof orchestrationStatus) => { orchestrationStatus = status },
    setWorkflows: (statuses: typeof workflowStatuses) => { workflowStatuses = statuses } }
}

describe('Canvas 新旧执行共同准入', () => {
  test.each(['running', 'waiting-review', 'waiting-budget', 'partial', 'failed'] as const)(
    'Given 旧工作流为%s When 创建新委托 Then 不登记也不接管', status => {
      const f = fixture()
      f.setWorkflows([status])
      let registrations = 0
      expect(() => f.ownership.run(f.target, 'orchestration', () => { registrations++ }))
        .toThrow('CANVAS_WORKFLOW_OWNS_EXECUTION')
      expect(registrations).toBe(0)
    },
  )
  test.each(['planning', 'running', 'waiting', 'blocked'] as const)(
    'Given 委托为%s When 旧工作流登记或恢复 Then 不运行旧调度器', status => {
      const f = fixture()
      f.setOrchestration(status)
      let starts = 0
      expect(() => f.ownership.run(f.target, 'workflow', () => { starts++ }))
        .toThrow('CANVAS_ORCHESTRATION_OWNS_EXECUTION')
      expect(starts).toBe(0)
    },
  )
  test('Given 双方旧记录均为终态 When 启动新工作 Then 保留历史且允许登记', () => {
    const f = fixture()
    f.setWorkflows(['completed', 'cancelled'])
    f.setOrchestration('completed')
    expect(f.ownership.run(f.target, 'workflow', () => 'old-start')).toBe('old-start')
    expect(f.ownership.run(f.target, 'orchestration', () => 'new-start')).toBe('new-start')
  })
  test('Given 一个实例正在检查后登记 When 第二实例竞争 Then 不进入另一套创建并在释放后读取最新持久事实', () => {
    const f = fixture()
    const second = createCanvasExecutionOwnership(f.dependencies)
    let secondRegistrations = 0
    f.ownership.run(f.target, 'workflow', () => {
      expect(() => second.run(f.target, 'orchestration', () => { secondRegistrations++ })).toThrow('CANVAS_EXECUTION_BUSY')
      f.setWorkflows(['running'])
    })
    expect(() => second.run(f.target, 'orchestration', () => { secondRegistrations++ })).toThrow('CANVAS_WORKFLOW_OWNS_EXECUTION')
    expect(secondRegistrations).toBe(0)
  })
  test('Given 登记失败 When 纠正后重试 Then 释放短锁且不创建永久占位', () => {
    const f = fixture()
    expect(() => f.ownership.run(f.target, 'workflow', () => { throw new Error('WRITE_FAILED') })).toThrow('WRITE_FAILED')
    expect(f.ownership.run(f.target, 'orchestration', () => 'registered')).toBe('registered')
  })
  test('Given Canvas 根被替换为符号链接 When 准入 Then 不创建锁或业务记录', () => {
    const f = fixture()
    const link = join(f.canvasRoot, 'linked')
    symlinkSync(f.canvasRoot, link)
    const ownership = createCanvasExecutionOwnership({ ...f.dependencies,
      pathResolver: { resolveCanvas: () => ({ canvasRoot: link }) as ReturnType<CanvasExecutionOwnershipDependencies['pathResolver']['resolveCanvas']> } })
    expect(() => ownership.run(f.target, 'workflow', () => 'invalid')).toThrow('CANVAS_EXECUTION_PATH_INVALID')
  })
})
