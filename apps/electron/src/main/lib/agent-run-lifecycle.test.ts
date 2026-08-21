import { describe, expect, test } from 'bun:test'
import {
  consumeStoppedGeneration,
  createAgentRunTerminalNotifier,
  hasInFlightGeneration,
  hasStoppedGeneration,
  isLatestRunGeneration,
  markInFlightGeneration,
  markStoppedGeneration,
  releaseInFlightGeneration,
  runAgentServiceTerminalEffects,
  runAgentLifecycle,
} from './agent-run-lifecycle'
import { createWorkspaceOperationRegistry } from './workspace-operation-lock'
import { createWorkspaceOperationGuard } from './workspace-operation-guard'

/** 创建可控 Promise 及其完成、拒绝函数。 */
function createDeferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  /** 完成当前异步边界的函数。 */
  let resolve = (): void => undefined
  /** 拒绝当前异步边界的函数。 */
  let reject = (_error: Error): void => undefined
  /** 保持未决直到测试显式完成的 Promise。 */
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('Agent 运行生命周期', () => {
  test('Given OAuth 未决且当前 generation 被停止 When OAuth 返回 Then 不启动 adapter 且不删除后来 generation', async () => {
    /** 模拟 activeSessions 中当前会话的运行代际。 */
    let activeGeneration: number | undefined = 1
    /** 模拟 OAuth 异步边界。 */
    const oauth = createDeferred()
    /** 记录 adapter 启动次数。 */
    let adapterStarts = 0
    /** 记录停止早退回调次数。 */
    let stoppedCompletions = 0
    /** 由 lifecycle 完整包裹 OAuth preflight 与 adapter 启动。 */
    const running = runAgentLifecycle({
      isCurrent: () => activeGeneration === 1,
      isStopped: () => false,
      release: () => {
        if (activeGeneration === 1) activeGeneration = undefined
      },
      onStopped: () => { stoppedCompletions += 1 },
    }, async (checkpoint) => {
      await oauth.promise
      checkpoint()
      adapterStarts += 1
    })

    expect(activeGeneration).toBe(1)
    activeGeneration = undefined
    /** 使用真实工作区锁注册表证明 stop 后迁移预检可以立即取得锁。 */
    const workspaceRegistry = createWorkspaceOperationRegistry()
    /** 迁移锁释放函数。 */
    const releaseWorkspace = workspaceRegistry.acquireWorkspaceOperation('workspace-1', 'relocation')
    expect(workspaceRegistry.getWorkspaceOperationBlockReason('workspace-1'))
      .toBe('项目正在迁移，请等待完成后重试')
    releaseWorkspace()
    /** 模拟停止后同会话立即启动的新 generation。 */
    activeGeneration = 2
    oauth.resolve()
    await running

    expect(adapterStarts).toBe(0)
    expect(stoppedCompletions).toBe(1)
    expect(activeGeneration).toBe(2)
  })

  test('Given proxy preflight reject When lifecycle 结束 Then 释放自己持有的 active generation', async () => {
    /** 模拟 activeSessions 中当前会话的运行代际。 */
    let activeGeneration: number | undefined = 1
    /** 模拟 proxy 解析错误。 */
    const proxyError = new Error('proxy failed')
    /** 运行会抛错的异步 preflight。 */
    const running = runAgentLifecycle({
      isCurrent: () => activeGeneration === 1,
      isStopped: () => false,
      release: () => {
        if (activeGeneration === 1) activeGeneration = undefined
      },
      onStopped: () => undefined,
    }, async () => {
      throw proxyError
    })

    await expect(running).rejects.toBe(proxyError)
    expect(activeGeneration).toBeUndefined()
  })

  test('Given stop marker 已设置且异步 preflight reject When lifecycle 捕获 Then 完成 stopped 且不启动 adapter', async () => {
    /** 模拟 activeSessions 中当前会话的运行代际。 */
    let activeGeneration: number | undefined = 1
    /** 模拟 stop 后才 reject 的异步 preflight。 */
    const preflight = createDeferred()
    /** 当前尚未被旧 run 消费的停止代际。 */
    const stoppedGenerations = new Map<string, Set<number>>()
    /** 记录 adapter 是否被错误启动。 */
    let adapterStarts = 0
    /** 记录 stopped 完成回调次数。 */
    let stoppedCompletions = 0
    /** 记录 lifecycle release 次数。 */
    let releases = 0
    /** 包含新 isStopped 查询的 lifecycle 依赖。 */
    const dependencies = {
      isCurrent: () => activeGeneration === 1,
      isStopped: () => hasStoppedGeneration(stoppedGenerations, 'session-1', 1),
      release: () => {
        releases += 1
        if (activeGeneration === 1) activeGeneration = undefined
      },
      onStopped: () => {
        stoppedCompletions += 1
        consumeStoppedGeneration(stoppedGenerations, 'session-1', 1)
      },
    }
    /** lifecycle 正在等待异步 preflight。 */
    const running = runAgentLifecycle(dependencies, async () => {
      await preflight.promise
      adapterStarts += 1
    })

    activeGeneration = undefined
    markStoppedGeneration(stoppedGenerations, 'session-1', 1)
    preflight.reject(new Error('proxy failed after stop'))

    await expect(running).resolves.toBeUndefined()
    expect(adapterStarts).toBe(0)
    expect(stoppedCompletions).toBe(1)
    expect(releases).toBe(1)
    expect(stoppedGenerations.has('session-1')).toBe(false)
  })

  test('Given 正常 complete 已释放 active 且无 stop marker When callback 抛错 Then 不误判 stopped 或双回调', async () => {
    /** 模拟 activeSessions 中当前会话的运行代际。 */
    let activeGeneration: number | undefined = 1
    /** 模拟正常 complete callback 抛出的异常。 */
    const callbackError = new Error('complete callback failed')
    /** 记录正常完成回调尝试次数。 */
    let completionAttempts = 0
    /** 记录 stopped 回调次数。 */
    let stoppedCompletions = 0
    /** 包含无 stop marker 查询的 lifecycle 依赖。 */
    const dependencies = {
      isCurrent: () => activeGeneration === 1,
      isStopped: () => false,
      release: () => {
        if (activeGeneration === 1) activeGeneration = undefined
      },
      onStopped: () => { stoppedCompletions += 1 },
    }
    /** 模拟 completeRun 先释放 active，再执行可能抛错的 callback。 */
    const running = runAgentLifecycle(dependencies, async () => {
      activeGeneration = undefined
      completionAttempts += 1
      throw callbackError
    })

    await expect(running).rejects.toBe(callbackError)
    expect(completionAttempts).toBe(1)
    expect(stoppedCompletions).toBe(0)
  })

  test('Given onRunStarted 时项目进入迁移 When service guard 抛错 Then 不启动 adapter 且释放 active generation', async () => {
    /** 模拟 activeSessions 中当前会话的运行代际。 */
    let activeGeneration: number | undefined = 1
    /** 记录 adapter closure 是否被错误启动。 */
    let adapterStarts = 0
    /** 模拟 service onRunStarted 使用的真实守卫。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: () => 'workspace-locked',
      getWorkspaceIdBySlug: () => undefined,
      getWorkspaceOperationBlockReason: () => '项目正在迁移，请等待完成后重试',
    })

    const running = runAgentLifecycle({
      isCurrent: () => activeGeneration === 1,
      isStopped: () => false,
      release: () => {
        if (activeGeneration === 1) activeGeneration = undefined
      },
      onStopped: () => undefined,
    }, async () => {
      guard.runAgentServiceEffects({
        sessionWorkspaceId: 'workspace-locked',
        requestedWorkspaceId: 'workspace-locked',
      }, () => undefined)
      adapterStarts += 1
    })

    await expect(running).rejects.toThrow('项目正在迁移，请等待完成后重试')
    expect(adapterStarts).toBe(0)
    expect(activeGeneration).toBeUndefined()
  })

  test('Given 同会话连续停止两个 generation When 分别消费 Then 两个停止标记互不覆盖', () => {
    /** 同一会话可同时保留多个尚未收尾的停止代际。 */
    const stoppedGenerations = new Map<string, Set<number>>()
    markStoppedGeneration(stoppedGenerations, 'session-1', 1)
    markStoppedGeneration(stoppedGenerations, 'session-1', 2)

    expect(consumeStoppedGeneration(stoppedGenerations, 'session-1', 1)).toBe(true)
    expect(stoppedGenerations.get('session-1')).toEqual(new Set([2]))
    expect(consumeStoppedGeneration(stoppedGenerations, 'session-1', 2)).toBe(true)
    expect(stoppedGenerations.has('session-1')).toBe(false)
  })

  test('Given generation2 已启动 When generation1 在其运行中或完成后迟到 Then generation1 始终无权写 session meta', () => {
    /** 最新代际记录在 generation2 完成释放 active 后仍保留。 */
    const latestGenerations = new Map([['session-1', 2]])
    /** 模拟 generation2 尚在运行的 active 槽。 */
    const activeGenerations = new Map([['session-1', 2]])
    expect(isLatestRunGeneration(latestGenerations, 'session-1', 1)).toBe(false)
    activeGenerations.delete('session-1')
    expect(activeGenerations.has('session-1')).toBe(false)
    expect(isLatestRunGeneration(latestGenerations, 'session-1', 1)).toBe(false)
    expect(isLatestRunGeneration(latestGenerations, 'session-1', 2)).toBe(true)
  })

  test('Given generation1 stop 后 adapter 延迟退出 When generation2 启动 Then 迁移保持阻断且旧代际不再写消息或发事件', async () => {
    /** 模拟当前可接收前台操作的运行代际。 */
    let activeGeneration: number | undefined = 1
    /** 模拟尚未完全退出的 adapter 代际集合。 */
    const inFlightGenerations = new Map<string, Set<number>>()
    /** 模拟每个会话最新启动的运行代际。 */
    const latestGenerations = new Map<string, number>([['session-1', 1]])
    /** 模拟 stop 后仍未 settle 的 adapter iterator。 */
    const adapter = createDeferred()
    /** 记录旧代际在恢复执行后尝试写消息的次数。 */
    let oldGenerationWrites = 0
    /** 记录旧代际在恢复执行后尝试发送事件的次数。 */
    let oldGenerationEvents = 0
    markInFlightGeneration(inFlightGenerations, 'session-1', 1)
    /** generation1 正在等待 adapter settle。 */
    const running = runAgentLifecycle({
      isCurrent: () => activeGeneration === 1,
      isStopped: () => true,
      release: () => {
        if (activeGeneration === 1) activeGeneration = undefined
        releaseInFlightGeneration(inFlightGenerations, latestGenerations, 'session-1', 1)
      },
      onStopped: () => undefined,
    }, async () => {
      await adapter.promise
      if (isLatestRunGeneration(latestGenerations, 'session-1', 1)) {
        oldGenerationWrites += 1
        oldGenerationEvents += 1
      }
    })

    // stop 只释放前台 active 槽；迁移必须继续看到尚未退出的 adapter。
    activeGeneration = undefined
    expect(hasInFlightGeneration(inFlightGenerations, 'session-1')).toBe(true)

    // 新运行可立即接管前台 UI，但旧代际从此失去 session-wide 副作用权限。
    activeGeneration = 2
    markInFlightGeneration(inFlightGenerations, 'session-1', 2)
    latestGenerations.set('session-1', 2)
    adapter.resolve()
    await running

    expect(oldGenerationWrites).toBe(0)
    expect(oldGenerationEvents).toBe(0)
    expect(inFlightGenerations.get('session-1')).toEqual(new Set([2]))
    expect(latestGenerations.get('session-1')).toBe(2)

    releaseInFlightGeneration(inFlightGenerations, latestGenerations, 'session-1', 2)
    expect(hasInFlightGeneration(inFlightGenerations, 'session-1')).toBe(false)
    expect(latestGenerations.has('session-1')).toBe(false)
  })
})

describe('Agent 终端通知边界', () => {
  test('Given 正常完成 callback 抛错 When 后续再次完成或报错 Then 不外溢且 complete exactly-once', () => {
    /** 记录外部完成 callback 调用次数。 */
    let completeCalls = 0
    /** 记录外部错误 callback 调用次数。 */
    let errorCalls = 0
    /** 记录 callback 异常日志。 */
    const callbackErrors: Array<{ kind: 'error' | 'complete'; error: unknown }> = []
    /** 使用生产 factory 创建终端通知器。 */
    const notifier = createAgentRunTerminalNotifier<string[], { stoppedByUser?: boolean }>({
      onError: () => { errorCalls += 1 },
      onComplete: () => {
        completeCalls += 1
        throw new Error('complete callback failed')
      },
      onCallbackError: (kind, error) => { callbackErrors.push({ kind, error }) },
    })

    expect(() => notifier.onComplete(['done'])).not.toThrow()
    notifier.onComplete(['duplicate'])
    notifier.onError('late error')

    expect(completeCalls).toBe(1)
    expect(errorCalls).toBe(0)
    expect(callbackErrors).toHaveLength(1)
    expect(callbackErrors[0]?.kind).toBe('complete')
  })

  test('Given onError callback 抛错 When fail 路径继续完成 Then error 与 complete 各尝试一次', () => {
    /** 记录终端通知的调用顺序。 */
    const calls: string[] = []
    /** 记录 callback 异常类型。 */
    const callbackErrorKinds: string[] = []
    /** 使用生产 factory 创建终端通知器。 */
    const notifier = createAgentRunTerminalNotifier<string[], { stoppedByUser?: boolean }>({
      onError: () => {
        calls.push('error')
        throw new Error('error callback failed')
      },
      onComplete: () => { calls.push('complete') },
      onCallbackError: (kind) => { callbackErrorKinds.push(kind) },
    })

    expect(() => {
      notifier.onError('failed')
      notifier.onComplete([], { stoppedByUser: false })
    }).not.toThrow()
    expect(calls).toEqual(['error', 'complete'])
    expect(callbackErrorKinds).toEqual(['error'])
  })

  test('Given 外部完成 callback 与 renderer send 抛错 When 执行 service 收尾 Then publish、Promise 与 queue cleanup 各完成一次', async () => {
    /** 记录每个内部与外部 effect 的调用次数。 */
    const calls = new Map<string, number>()
    /** 记录被隔离的外部异常。 */
    const errors: string[] = []
    /** Automation 完成 Promise 的 resolve 函数。 */
    let resolveAutomation = (): void => undefined
    /** 模拟等待 headless onComplete 的 Automation Promise。 */
    const automationCompleted = new Promise<void>((resolve) => {
      resolveAutomation = resolve
    })
    /** 记录并可选择抛错的 effect。 */
    const effect = (name: string, shouldThrow = false): (() => void) => () => {
      calls.set(name, (calls.get(name) ?? 0) + 1)
      if (shouldThrow) throw new Error(`${name} failed`)
    }

    runAgentServiceTerminalEffects([
      { name: 'external-complete', run: effect('external-complete', true) },
      { name: 'publish', run: effect('publish') },
      { name: 'renderer-send', run: effect('renderer-send', true) },
      {
        name: 'automation-resolve',
        run: () => {
          calls.set('automation-resolve', (calls.get('automation-resolve') ?? 0) + 1)
          resolveAutomation()
        },
      },
      { name: 'queue-cleanup', run: effect('queue-cleanup') },
    ], (name) => { errors.push(name) })

    await automationCompleted
    expect(calls).toEqual(new Map([
      ['external-complete', 1],
      ['publish', 1],
      ['renderer-send', 1],
      ['automation-resolve', 1],
      ['queue-cleanup', 1],
    ]))
    expect(errors).toEqual(['external-complete', 'renderer-send'])
  })
})
