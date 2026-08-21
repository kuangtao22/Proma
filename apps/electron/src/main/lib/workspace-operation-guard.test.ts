import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWorkspaceOperationGuard } from './workspace-operation-guard'

describe('工作区写操作守卫', () => {
  test('Given 会话或 slug 指向迁移中的项目 When 检查写操作 Then 在后续副作用前返回固定错误', () => {
    /** 记录守卫依赖与后续副作用的调用顺序。 */
    const calls: string[] = []
    /** 通过可注入依赖构造隔离的守卫实例。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: (sessionId) => {
        calls.push(`session:${sessionId}`)
        return sessionId === 'session-1' ? 'workspace-locked' : 'workspace-free'
      },
      getWorkspaceIdBySlug: (slug) => {
        calls.push(`slug:${slug}`)
        return slug === 'locked' ? 'workspace-locked' : 'workspace-free'
      },
      getWorkspaceOperationBlockReason: (workspaceId) => {
        calls.push(`lock:${workspaceId}`)
        return workspaceId === 'workspace-locked' ? '项目正在迁移，请等待完成后重试' : undefined
      },
    })

    expect(() => {
      guard.assertSessionWritable('session-1')
      calls.push('side-effect')
    }).toThrow('项目正在迁移，请等待完成后重试')
    expect(calls).toEqual(['session:session-1', 'lock:workspace-locked'])

    calls.length = 0
    expect(() => {
      guard.assertWorkspaceSlugWritable('locked')
      calls.push('realpath')
    }).toThrow('项目正在迁移，请等待完成后重试')
    expect(calls).toEqual(['slug:locked', 'lock:workspace-locked'])
  })

  test('Given 未锁定同项目与不同项目 When 检查写操作 Then 正常放行且互不影响', () => {
    /** 仅锁定 workspace-locked 的守卫实例。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: () => 'workspace-free',
      getWorkspaceIdBySlug: () => 'workspace-free',
      getWorkspaceOperationBlockReason: (workspaceId) => (
        workspaceId === 'workspace-locked' ? '项目正在迁移，请等待完成后重试' : undefined
      ),
    })

    expect(() => guard.assertWorkspaceWritable('workspace-free')).not.toThrow()
    expect(() => guard.assertSessionWritable('session-free')).not.toThrow()
    expect(() => guard.assertWorkspaceSlugWritable('free')).not.toThrow()
    expect(() => guard.assertWorkspaceWritable('workspace-locked'))
      .toThrow('项目正在迁移，请等待完成后重试')
  })

  test('Given 会话或 slug 不存在 When 检查写操作 Then 保留入口原有的明确错误', () => {
    /** 无法解析任何归属的守卫实例。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: () => undefined,
      getWorkspaceIdBySlug: () => undefined,
      getWorkspaceOperationBlockReason: () => undefined,
    })

    expect(() => guard.assertSessionWritable('missing-session')).toThrow('会话不存在: missing-session')
    expect(() => guard.assertWorkspaceSlugWritable('missing-workspace')).toThrow('项目不存在: missing-workspace')
  })

  test('Given 工作区正在迁移 When 执行受保护 effect closure Then closure 完全不调用', () => {
    /** 记录 manager、realpath、文件系统和 watcher 模拟副作用。 */
    const effects: string[] = []
    /** 仅锁定目标工作区的守卫实例。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: () => 'workspace-locked',
      getWorkspaceIdBySlug: () => 'workspace-locked',
      getWorkspaceOperationBlockReason: () => '项目正在迁移，请等待完成后重试',
    })
    /** 模拟真实 handler 内全部副作用的 closure。 */
    const effect = (): string => {
      effects.push('manager')
      effects.push('realpath')
      effects.push('fs')
      effects.push('watcher')
      return 'written'
    }

    expect(() => guard.runWorkspaceWrite('workspace-locked', effect)).toThrow('项目正在迁移，请等待完成后重试')
    expect(() => guard.runSessionWrite('session-1', effect)).toThrow('项目正在迁移，请等待完成后重试')
    expect(() => guard.runWorkspaceSlugWrite('locked', effect)).toThrow('项目正在迁移，请等待完成后重试')
    expect(effects).toEqual([])
  })
})

describe('工作区写 IPC 守卫合同', () => {
  test('Given 迁移期间必须阻断的写入口 When 检查 ipc handler 源码 Then 每个入口首个业务调用都是对应守卫', () => {
    /** 读取实际 IPC 注册源码，防止新增守卫后漏接某个 handler。 */
    const source = readFileSync(join(import.meta.dir, '..', 'ipc.ts'), 'utf8')
    /** IPC 通道、守卫调用与最早可能副作用 token 的合同。 */
    const contracts: Array<{ channel: string; guardCall: string; sideEffects: string[] }> = [
      { channel: 'RELINK_WORKSPACE_PROJECT_ROOT', guardCall: 'workspaceOperationGuard.runWorkspaceWrite(id, () =>', sideEffects: ['getAgentWorkspace(id)', 'relinkAgentWorkspaceProjectRoot(', 'releaseDirectoryWatcherIfUnreferenced(', 'watchAttachedDirectory('] },
      { channel: 'RESTORE_WORKSPACE_PROJECT_ROOT', guardCall: 'workspaceOperationGuard.runWorkspaceWrite(id, () =>', sideEffects: ['restoreAgentWorkspaceProjectRoot(', 'watchAttachedDirectory('] },
      { channel: 'DELETE_WORKSPACE', guardCall: 'workspaceOperationGuard.runWorkspaceWrite(id, () =>', sideEffects: ['getAgentWorkspace(id)', 'listAgentWorkspaces()', 'removeBindingsForDeletedWorkspace(', 'deleteAgentSession(', 'deleteAgentWorkspace('] },
      { channel: 'ATTACH_DIRECTORY', guardCall: 'workspaceOperationGuard.runSessionWrite(input.sessionId, () =>', sideEffects: ['getAgentSessionMeta(', 'updateAgentSessionMeta(', 'watchAttachedDirectory('] },
      { channel: 'DETACH_DIRECTORY', guardCall: 'workspaceOperationGuard.runSessionWrite(input.sessionId, () =>', sideEffects: ['getAgentSessionMeta(', 'updateAgentSessionMeta(', 'releaseDirectoryWatcherIfUnreferenced('] },
      { channel: 'ATTACH_FILE', guardCall: 'workspaceOperationGuard.runSessionWrite(input.sessionId, async () =>', sideEffects: ['getAgentSessionMeta(', "await import('node:fs')", 'realpathSync(', 'updateAgentSessionMeta(', 'watchAttachedDirectory('] },
      { channel: 'DETACH_FILE', guardCall: 'workspaceOperationGuard.runSessionWrite(input.sessionId, () =>', sideEffects: ['getAgentSessionMeta(', 'updateAgentSessionMeta(', 'releaseDirectoryWatcherIfUnreferenced('] },
      { channel: 'ATTACH_WORKSPACE_DIRECTORY', guardCall: 'workspaceOperationGuard.runWorkspaceSlugWrite(input.workspaceSlug, () =>', sideEffects: ['attachWorkspaceDirectory(', 'watchAttachedDirectory('] },
      { channel: 'DETACH_WORKSPACE_DIRECTORY', guardCall: 'workspaceOperationGuard.runWorkspaceSlugWrite(input.workspaceSlug, () =>', sideEffects: ['detachWorkspaceDirectory(', 'releaseDirectoryWatcherIfUnreferenced('] },
      { channel: 'ATTACH_WORKSPACE_FILE', guardCall: 'workspaceOperationGuard.runWorkspaceSlugWrite(input.workspaceSlug, async () =>', sideEffects: ["await import('node:fs')", 'realpathSync(', 'attachWorkspaceFile(', 'watchAttachedDirectory('] },
      { channel: 'DETACH_WORKSPACE_FILE', guardCall: 'workspaceOperationGuard.runWorkspaceSlugWrite(input.workspaceSlug, () =>', sideEffects: ['detachWorkspaceFile(', 'releaseDirectoryWatcherIfUnreferenced('] },
    ]

    for (const contract of contracts) {
      /** 当前通道 handler 到下一个 handler 之间的源码片段。 */
      const start = source.indexOf(`AGENT_IPC_CHANNELS.${contract.channel}`)
      const end = source.indexOf('ipcMain.handle(', start + 1)
      const handler = source.slice(start, end === -1 ? source.length : end)
      /** 守卫在当前 handler 内的位置。 */
      const guardIndex = handler.indexOf(contract.guardCall)
      expect(start).toBeGreaterThan(-1)
      expect(guardIndex).toBeGreaterThan(-1)
      for (const sideEffect of contract.sideEffects) {
        /** 当前副作用 token 在 handler 内的位置。 */
        const sideEffectIndex = handler.indexOf(sideEffect)
        expect(sideEffectIndex).toBeGreaterThan(guardIndex)
      }
    }
  })

  test('Given 只读附加项查询 When 检查 ipc handler 源码 Then 不接入写操作守卫', () => {
    /** 读取实际 IPC 注册源码，确认只读入口不被误阻断。 */
    const source = readFileSync(join(import.meta.dir, '..', 'ipc.ts'), 'utf8')
    /** 只读通道名称。 */
    const readOnlyChannels = ['GET_WORKSPACE_DIRECTORIES', 'GET_WORKSPACE_ATTACHED_FILES']

    for (const channel of readOnlyChannels) {
      /** 当前只读 handler 的源码片段。 */
      const start = source.indexOf(`AGENT_IPC_CHANNELS.${channel}`)
      const end = source.indexOf('ipcMain.handle(', start + 1)
      const handler = source.slice(start, end === -1 ? source.length : end)
      expect(handler).not.toContain('workspaceOperationGuard')
    }
  })
})
