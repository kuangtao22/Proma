import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta, Automation, AutomationRun } from '@proma/shared'
import { acquireWorkspaceOperation } from './workspace-operation-lock'

/** 记录 Automation 运行历史写入。 */
const appendedRuns: Array<{ id: string; run: AutomationRun }> = []
/** 记录子会话创建次数。 */
let createdSessionCount = 0
/** 保存 headless Agent 回调，允许测试观察运行中状态。 */
let activeHeadlessCallbacks: { onComplete: () => void } | undefined
/** 注入运行历史持久化异常。 */
let appendRunError: Error | undefined
/** 记录运行历史持久化尝试次数。 */
let appendRunAttempts = 0
/** 注入 renderer 广播异常。 */
let broadcastSendError: Error | undefined
/** 记录 renderer 广播尝试次数。 */
let broadcastSendAttempts = 0
/** 注入失败退避更新异常。 */
let updateAutomationError: Error | undefined
/** 记录失败退避更新尝试次数。 */
let updateAutomationAttempts = 0
/** 返回给失败退避逻辑的最新 Automation。 */
let latestAutomation: Automation | undefined
/** 返回给复用边界的上次会话元数据。 */
let lastSessionMeta: AgentSessionMeta | undefined
/** 记录实际交给 headless Agent 的会话 ID。 */
let headlessSessionId: string | undefined

mock.module('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: {
        send: () => {
          broadcastSendAttempts += 1
          if (broadcastSendError) throw broadcastSendError
        },
      },
    }],
  },
}))

mock.module('./automation-manager', () => ({
  listAutomations: () => [],
  getAutomation: () => latestAutomation,
  appendRun: (id: string, run: AutomationRun) => {
    appendRunAttempts += 1
    if (appendRunError) throw appendRunError
    appendedRuns.push({ id, run })
  },
  updateAutomation: () => {
    updateAutomationAttempts += 1
    if (updateAutomationError) throw updateAutomationError
  },
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
  getAgentSessionMeta: () => lastSessionMeta,
}))

mock.module('./agent-session-usage', () => ({ getSessionContextUsageRatio: () => undefined }))

mock.module('./agent-service', () => ({
  runAgentHeadless: async (input: { sessionId: string }, callbacks: { onComplete: () => void }) => {
    headlessSessionId = input.sessionId
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
  appendRunError = undefined
  appendRunAttempts = 0
  broadcastSendError = undefined
  broadcastSendAttempts = 0
  updateAutomationError = undefined
  updateAutomationAttempts = 0
  latestAutomation = undefined
  lastSessionMeta = undefined
  headlessSessionId = undefined
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

  test('Given appendRun 抛错 When headless 完成 Then runAutomation 仍 settle 并释放工作区运行归属', async () => {
    /** 当前被测 Automation。 */
    const automation = createAutomation('automation-append-error', 'workspace-append-error')
    appendRunError = new Error('append failed')
    const running = scheduler.runAutomation(automation)
    await Promise.resolve()

    activeHeadlessCallbacks?.onComplete()
    activeHeadlessCallbacks?.onComplete()
    const result = await Promise.race([
      running.then(() => 'settled' as const),
      Bun.sleep(100).then(() => 'timeout' as const),
    ])

    expect(result).toBe('settled')
    expect(appendRunAttempts).toBe(1)
    expect(broadcastSendAttempts).toBe(1)
    expect(scheduler.hasRunningAutomationForWorkspace('workspace-append-error')).toBe(false)
  })

  test('Given 广播抛错 When headless 完成 Then 后续暂停更新仍执行且运行归属释放', async () => {
    /** 当前被测 Automation。 */
    const automation = createAutomation('automation-broadcast-error', 'workspace-broadcast-error')
    latestAutomation = { ...automation, consecutiveFailures: 5 }
    broadcastSendError = new Error('broadcast failed')
    const running = scheduler.runAutomation(automation)
    await Promise.resolve()

    activeHeadlessCallbacks?.onComplete()
    await running

    expect(appendedRuns).toHaveLength(1)
    expect(updateAutomationAttempts).toBe(1)
    expect(scheduler.hasRunningAutomationForWorkspace('workspace-broadcast-error')).toBe(false)
  })

  test('Given 自动暂停更新抛错 When headless 完成 Then runAutomation 仍 settle 且 finish 只尝试一次', async () => {
    /** 当前被测 Automation。 */
    const automation = createAutomation('automation-update-error', 'workspace-update-error')
    latestAutomation = { ...automation, consecutiveFailures: 5 }
    updateAutomationError = new Error('update failed')
    const running = scheduler.runAutomation(automation)
    await Promise.resolve()

    activeHeadlessCallbacks?.onComplete()
    activeHeadlessCallbacks?.onComplete()
    await running

    expect(appendedRuns).toHaveLength(1)
    expect(updateAutomationAttempts).toBe(1)
    expect(scheduler.hasRunningAutomationForWorkspace('workspace-update-error')).toBe(false)
  })
})

describe('Automation 会话复用归属', () => {
  test('Given lastSessionId 指向其他 Automation When reuse 运行 Then 新建本任务专属会话', async () => {
    const automation = {
      ...createAutomation('automation-owner', 'workspace-owner'),
      sessionMode: 'reuse' as const,
      lastSessionId: 'polluted-session',
    }
    lastSessionMeta = {
      id: 'polluted-session',
      title: '其他任务会话',
      workspaceId: 'workspace-owner',
      sourceAutomationId: 'automation-other',
      createdAt: 1,
      updatedAt: 1,
    }

    const running = scheduler.runAutomation(automation)
    await Promise.resolve()
    activeHeadlessCallbacks?.onComplete()
    await running

    expect(createdSessionCount).toBe(1)
    expect(headlessSessionId).toBe('session-1')
  })

  test('Given lastSessionId 被 Canvas 来源污染 When reuse 运行 Then 即使 Automation ID 匹配也不复用', async () => {
    const automation = {
      ...createAutomation('automation-canvas', 'workspace-canvas'),
      sessionMode: 'reuse' as const,
      lastSessionId: 'canvas-session',
    }
    lastSessionMeta = {
      id: 'canvas-session',
      title: 'Canvas 内部会话',
      workspaceId: 'workspace-canvas',
      sourceAutomationId: 'automation-canvas',
      sourceCanvasProjectId: 'workspace-canvas',
      sourceCanvasId: 'canvas-1',
      sourceCanvasNodeId: 'node-1',
      createdAt: 1,
      updatedAt: 1,
    }

    const running = scheduler.runAutomation(automation)
    await Promise.resolve()
    activeHeadlessCallbacks?.onComplete()
    await running

    expect(createdSessionCount).toBe(1)
    expect(headlessSessionId).toBe('session-1')
  })

  test('Given lastSessionId 被半归属 Design 来源污染 When reuse 运行 Then 即使 Automation ID 匹配也不复用', async () => {
    const automation = {
      ...createAutomation('automation-design', 'workspace-design'),
      sessionMode: 'reuse' as const,
      lastSessionId: 'design-session',
    }
    lastSessionMeta = {
      id: 'design-session',
      title: 'Design 半归属会话',
      workspaceId: 'workspace-design',
      sourceAutomationId: 'automation-design',
      sourceDesignProjectId: 'workspace-design',
      createdAt: 1,
      updatedAt: 1,
    }

    const running = scheduler.runAutomation(automation)
    await Promise.resolve()
    activeHeadlessCallbacks?.onComplete()
    await running

    expect(createdSessionCount).toBe(1)
    expect(headlessSessionId).toBe('session-1')
  })

  test.each([
    ['完整 delegation', {
      parentSessionId: 'automation-parent',
      rootSessionId: 'automation-parent',
      sourceDelegationId: 'delegation-1',
      delegationRole: 'implement' as const,
      delegationStatus: 'completed' as const,
      delegationDepth: 1,
      delegationGoal: '完成子任务',
    }],
    ['半归属 delegation', { sourceDelegationId: '' }],
  ])('Given lastSessionId 指向同 Automation 的%s When reuse 运行 Then 新建直接会话', async (_name, fields) => {
    const automation = {
      ...createAutomation('automation-delegation', 'workspace-delegation'),
      sessionMode: 'reuse' as const,
      lastSessionId: 'delegation-session',
    }
    lastSessionMeta = {
      id: 'delegation-session',
      title: 'Automation 协作子会话',
      workspaceId: 'workspace-delegation',
      sourceAutomationId: 'automation-delegation',
      createdAt: 1,
      updatedAt: 1,
      ...fields,
    }

    const running = scheduler.runAutomation(automation)
    await Promise.resolve()
    activeHeadlessCallbacks?.onComplete()
    await running

    expect(createdSessionCount).toBe(1)
    expect(headlessSessionId).toBe('session-1')
  })

  test('Given lastSessionId 完整归属于当前 Automation When reuse 运行 Then 保持合法复用', async () => {
    const automation = {
      ...createAutomation('automation-valid', 'workspace-valid'),
      sessionMode: 'reuse' as const,
      lastSessionId: 'automation-session',
    }
    lastSessionMeta = {
      id: 'automation-session',
      title: '本任务会话',
      workspaceId: 'workspace-valid',
      sourceAutomationId: 'automation-valid',
      createdAt: 1,
      updatedAt: 1,
    }

    const running = scheduler.runAutomation(automation)
    await Promise.resolve()
    activeHeadlessCallbacks?.onComplete()
    await running

    expect(createdSessionCount).toBe(0)
    expect(headlessSessionId).toBe('automation-session')
  })
})
