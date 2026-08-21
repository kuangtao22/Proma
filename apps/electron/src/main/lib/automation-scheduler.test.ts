import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Automation, AutomationRun } from '@proma/shared'
import { acquireWorkspaceOperation } from './workspace-operation-lock'

/** 记录 Automation 运行历史写入。 */
const appendedRuns: Array<{ id: string; run: AutomationRun }> = []
/** 记录子会话创建次数。 */
let createdSessionCount = 0
/** 保存 headless Agent 回调，允许测试观察运行中状态。 */
let activeHeadlessCallbacks: { onComplete: () => void } | undefined

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}))

mock.module('./automation-manager', () => ({
  listAutomations: () => [],
  getAutomation: () => undefined,
  appendRun: (id: string, run: AutomationRun) => appendedRuns.push({ id, run }),
  updateAutomation: () => undefined,
  setNextRunAt: () => undefined,
  setLastSessionId: () => undefined,
  computeNextRunAt: () => Date.now() + 60_000,
}))

mock.module('./agent-session-manager', () => ({
  createAgentSession: () => {
    createdSessionCount += 1
    return { id: `session-${createdSessionCount}` }
  },
  updateAgentSessionMeta: () => undefined,
  getAgentSessionMeta: () => undefined,
}))

mock.module('./agent-session-usage', () => ({ getSessionContextUsageRatio: () => undefined }))

mock.module('./agent-service', () => ({
  runAgentHeadless: async (_input: unknown, callbacks: { onComplete: () => void }) => {
    activeHeadlessCallbacks = callbacks
  },
  isAgentSessionActive: () => false,
}))

mock.module('./automation-notification-service', () => ({
  notifyAutomationRunFinished: async () => undefined,
}))

/** 被测调度器导出。 */
let scheduler: typeof import('./automation-scheduler')

beforeAll(async () => {
  scheduler = await import('./automation-scheduler')
})

beforeEach(() => {
  appendedRuns.length = 0
  createdSessionCount = 0
  activeHeadlessCallbacks = undefined
})

/** 创建指定工作区的最小 Automation。 */
function createAutomation(id: string, workspaceId: string): Automation {
  return {
    id,
    name: id,
    prompt: '执行任务',
    active: true,
    scheduleType: 'interval',
    intervalMinutes: 60,
    channelId: 'channel-1',
    workspaceId,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 1,
    runHistory: [],
  }
}

describe('Automation 工作区迁移准入', () => {
  test('Given Automation 所属项目正在迁移 When 触发运行 Then 记录 skipped 且不创建会话或启动 Agent', async () => {
    /** 持有目标工作区迁移锁。 */
    const release = acquireWorkspaceOperation('workspace-locked', 'relocation')
    try {
      /** 启动调用；旧实现会误入 headless，因此测试主动完成它以避免超时掩盖断言。 */
      const running = scheduler.runAutomation(createAutomation('automation-locked', 'workspace-locked'))
      await Promise.resolve()
      activeHeadlessCallbacks?.onComplete()
      await running
    } finally {
      release()
    }

    expect(appendedRuns).toHaveLength(1)
    expect(appendedRuns[0]?.run).toMatchObject({
      sessionId: '',
      status: 'skipped',
      skipReason: '项目正在迁移，请等待完成后重试',
    })
    expect(createdSessionCount).toBe(0)
    expect(activeHeadlessCallbacks).toBeUndefined()
    expect(scheduler.hasRunningAutomationForWorkspace('workspace-locked')).toBe(false)
  })

  test('Given 不同项目 Automation 正在真实运行 When 查询运行态 Then 只报告其权威项目且完成后释放', async () => {
    /** 持有另一工作区迁移锁，验证锁不会串扰当前任务。 */
    const releaseOther = acquireWorkspaceOperation('workspace-other', 'relocation')
    try {
      /** 启动未锁定项目的 Automation 并保持回调未完成。 */
      const running = scheduler.runAutomation(createAutomation('automation-free', 'workspace-free'))
      await Promise.resolve()

      expect(scheduler.hasRunningAutomations()).toBe(true)
      expect(scheduler.hasRunningAutomationForWorkspace('workspace-free')).toBe(true)
      expect(scheduler.hasRunningAutomationForWorkspace('workspace-other')).toBe(false)

      activeHeadlessCallbacks?.onComplete()
      await running
      expect(scheduler.hasRunningAutomationForWorkspace('workspace-free')).toBe(false)
    } finally {
      releaseOther()
    }
  })
})
