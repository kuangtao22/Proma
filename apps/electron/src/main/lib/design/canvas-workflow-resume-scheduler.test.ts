import { describe, expect, test } from 'bun:test'
import type { CanvasWorkflowRun } from '@proma/shared'
import { createCanvasWorkflowResumeScheduler, shouldResumeCanvasWorkflow } from './canvas-workflow-resume-scheduler'

describe('Canvas 工作流持久期限调度', () => {
  test('Given 取消意图在终态前中断 When 启动筛选与调度 Then 立即恢复收敛且不受自动采用设置影响', async () => {
    const calls: string[] = []
    const timers: Array<{ fire(): void; delay: number }> = []
    const run = { projectId: 'project', canvasId: 'canvas', id: 'run', status: 'waiting-review',
      owner: { sessionId: 'owner', runStartedAt: 10 }, cancelRequestedAt: 500, autoResumeAfterAdoption: false } as CanvasWorkflowRun
    expect(shouldResumeCanvasWorkflow(run)).toBe(true)
    const scheduler = createCanvasWorkflowResumeScheduler({ now: () => 1000,
      resume: async (input) => { calls.push(input.workflowRunId) }, onError: () => {},
      setTimer: (fire, delay) => { timers.push({ fire, delay }); return { cancel: () => {} } } })
    scheduler.changed(run)
    expect(timers[0]!.delay).toBe(0)
    timers[0]!.fire()
    await Promise.resolve()
    expect(calls).toEqual(['run'])
    expect(shouldResumeCanvasWorkflow({ ...run, status: 'cancelled' })).toBe(false)
    expect(shouldResumeCanvasWorkflow({ ...run, status: 'completed' })).toBe(false)
    expect(shouldResumeCanvasWorkflow({ ...run, cancelRequestedAt: null })).toBe(false)
    expect(shouldResumeCanvasWorkflow({ ...run, cancelRequestedAt: null, status: 'running' })).toBe(true)
    scheduler.dispose()
  })
  test('Given deadline 恢复发生一次瞬时冲突 When 退避重试 Then 保留原绝对期限且清理后不再唤醒', async () => {
    const timers: Array<{ fire(): void; delay: number }> = []
    const deadlines: number[] = []
    const scheduler = createCanvasWorkflowResumeScheduler({ now: () => 2000, resume: async (input) => {
      deadlines.push(input.resumeAt)
      if (deadlines.length === 1) throw new Error('CANVAS_WORKFLOW_RUN_CONFLICT')
    }, onError: () => {}, setTimer: (fire, delay) => { timers.push({ fire, delay }); return { cancel: () => {} } } })
    scheduler.schedule({ projectId: 'project', canvasId: 'canvas', workflowRunId: 'run', ownerSessionId: 'owner', resumeAt: 1000 })
    timers[0]!.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(timers[1]!.delay).toBe(1000)
    timers[1]!.fire()
    await Promise.resolve()
    expect(deadlines).toEqual([1000, 1000])
    scheduler.dispose()
  })
  test('Given 远端运行静默且重复恢复 When 再次安排期限 Then 替换同一计时器并保持原截止', async () => {
    let now = 100
    let resumed = 0
    const timers: Array<{ fire(): void; delay: number; cancelled: boolean }> = []
    const scheduler = createCanvasWorkflowResumeScheduler({ now: () => now, resume: async () => { resumed += 1 }, onError: () => {},
      setTimer: (fire, delay) => { const timer = { fire, delay, cancelled: false }; timers.push(timer); return { cancel: () => { timer.cancelled = true } } } })
    const input = { projectId: 'project', canvasId: 'canvas', workflowRunId: 'run', ownerSessionId: 'owner', resumeAt: 1000 }
    scheduler.schedule(input)
    now = 300
    scheduler.schedule(input)
    expect(timers.map((timer) => [timer.delay, timer.cancelled])).toEqual([[900, true], [700, false]])
    timers[0]!.fire()
    timers[1]!.fire()
    await Promise.resolve()
    expect(resumed).toBe(1)
    scheduler.dispose()
  })
  test('Given 已进入候选评审 When 状态提交 Then 释放计时器且旧回调无副作用', () => {
    let fire = (): void => {}
    let cancelled = false
    const scheduler = createCanvasWorkflowResumeScheduler({ resume: async () => { throw new Error('不应恢复') }, onError: () => {},
      setTimer: (callback) => { fire = callback; return { cancel: () => { cancelled = true } } } })
    scheduler.schedule({ projectId: 'project', canvasId: 'canvas', workflowRunId: 'run', ownerSessionId: 'owner', resumeAt: 1000 })
    scheduler.changed({ projectId: 'project', canvasId: 'canvas', id: 'run', status: 'waiting-review', cancelRequestedAt: null } as CanvasWorkflowRun)
    expect(cancelled).toBe(true)
    fire()
    scheduler.dispose()
  })
  test('Given 执行预算到期 When 状态进入等待预算 Then 不再自动 deadline 恢复', () => {
    let cancelled = false
    const scheduler = createCanvasWorkflowResumeScheduler({ resume: async () => undefined, onError: () => {},
      setTimer: () => ({ cancel: () => { cancelled = true } }) })
    scheduler.schedule({ projectId: 'project', canvasId: 'canvas', workflowRunId: 'run', ownerSessionId: 'owner', resumeAt: 1000 })
    const run = { projectId: 'project', canvasId: 'canvas', id: 'run', status: 'waiting-budget',
      cancelRequestedAt: null, autoResumeAfterAdoption: true } as CanvasWorkflowRun

    scheduler.changed(run)

    expect(shouldResumeCanvasWorkflow(run)).toBe(false)
    expect(cancelled).toBe(true)
    scheduler.dispose()
  })
})
