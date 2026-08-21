import { describe, expect, test } from 'bun:test'
import {
  consumeStoppedGeneration,
  isLatestRunGeneration,
  markStoppedGeneration,
  runAgentLifecycle,
} from './agent-run-lifecycle'
import { createWorkspaceOperationRegistry } from './workspace-operation-lock'
import { createWorkspaceOperationGuard } from './workspace-operation-guard'

/** 创建可控 Promise 及其完成函数。 */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  /** 完成当前异步边界的函数。 */
  let resolve = (): void => undefined
  /** 保持未决直到测试显式完成的 Promise。 */
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
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
})
