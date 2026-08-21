import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWorkspaceOperationGuard } from './workspace-operation-guard'

describe('Agent service 迁移准入', () => {
  test('Given 会话权威工作区正在迁移 When 准备 service 运行副作用 Then 抛固定原因且不执行副作用', () => {
    /** 记录 service 在准入后才允许执行的副作用。 */
    const effects: string[] = []
    /** 锁定会话权威工作区的守卫。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: () => undefined,
      getWorkspaceIdBySlug: () => undefined,
      getWorkspaceOperationBlockReason: (workspaceId) => (
        workspaceId === 'workspace-authoritative' ? '项目正在迁移，请等待完成后重试' : undefined
      ),
    })

    expect(() => guard.runAgentServiceEffects({
      sessionWorkspaceId: 'workspace-authoritative',
      requestedWorkspaceId: 'workspace-renderer-other',
    }, () => {
      effects.push('register-web-contents')
      effects.push('update-completed-meta')
      effects.push('graduate-automation')
      effects.push('emit')
    })).toThrow('项目正在迁移，请等待完成后重试')

    expect(effects).toEqual([])
  })

  test('Given 未锁定工作区 When 准备 service 运行副作用 Then 保持原行为执行一次', () => {
    /** 记录未锁定流程的副作用。 */
    const effects: string[] = []
    /** 无锁守卫。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: () => undefined,
      getWorkspaceIdBySlug: () => undefined,
      getWorkspaceOperationBlockReason: () => undefined,
    })

    expect(() => guard.runAgentServiceEffects({
      sessionWorkspaceId: 'workspace-free',
      requestedWorkspaceId: 'workspace-free',
    }, () => { effects.push('effects') })).not.toThrow()
    expect(effects).toEqual(['effects'])
  })

  test('Given runAgent 实现 When 检查 service 副作用 Then 全部位于生产 guard closure 内', () => {
    /** 读取真实 agent-service 源码约束实际接入。 */
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    /** 截取 renderer runAgent 入口。 */
    const start = source.indexOf('export async function runAgent(')
    const end = source.indexOf('\n/**', start + 1)
    const body = source.slice(start, end)
    /** 生产 guard closure 起始位置。 */
    const guardIndex = body.indexOf('workspaceOperationGuard.runAgentServiceEffects(')
    /** 真正准入后的运行开始回调位置。 */
    const onRunStartedIndex = body.indexOf('onRunStarted:')

    expect(guardIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeGreaterThan(onRunStartedIndex)
    for (const sideEffect of ['registerWebContents(', 'updateAgentSessionMeta(', 'eventBus.emit(']) {
      /** 当前 service 副作用的位置。 */
      const effectIndex = body.indexOf(sideEffect)
      expect(effectIndex).toBeGreaterThan(guardIndex)
    }
  })

  test('Given headless 与 queued 入口 When 检查源码 Then headless 延后注册且 queued 在注册和入队前守卫', () => {
    /** 读取真实 agent-service 源码审计其它 Agent 入口。 */
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    /** 截取 headless 新运行入口。 */
    const headlessStart = source.indexOf('export async function runAgentHeadless(')
    const headlessEnd = source.indexOf('\n/**', headlessStart + 1)
    const headlessBody = source.slice(headlessStart, headlessEnd)
    /** 截取队列写入口。 */
    const queueStart = source.indexOf('export function enqueueAgentQueuedMessage(')
    const queueEnd = source.indexOf('\n}', queueStart) + 2
    const queueBody = source.slice(queueStart, queueEnd)

    expect(headlessBody.indexOf('registerWebContents(')).toBeGreaterThan(headlessBody.indexOf('onRunStarted:'))
    expect(queueBody.indexOf('workspaceOperationGuard.runSessionWrite(')).toBeGreaterThan(-1)
    expect(queueBody.indexOf('registerWebContents(')).toBeGreaterThan(queueBody.indexOf('workspaceOperationGuard.runSessionWrite('))
    expect(queueBody.indexOf('agentQueueCoordinator.enqueue(')).toBeGreaterThan(queueBody.indexOf('workspaceOperationGuard.runSessionWrite('))
  })

  test('Given service 正常完成或 catch When 检查终态路径 Then renderer 与 headless 都隔离外部通知后推进内部收尾', () => {
    /** 读取真实 agent-service 源码约束四条终态路径。 */
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    /** 终态 effect 安全边界的生产调用次数。 */
    const boundaryCalls = source.match(/runAgentServiceTerminalEffects\(/g)?.length ?? 0

    expect(source).toContain("from './agent-run-lifecycle'")
    expect(boundaryCalls).toBeGreaterThanOrEqual(4)
    expect(source).toContain("name: 'queue-cleanup'")
    expect(source).toContain("name: 'external-on-complete'")
    expect(source).toContain("name: 'renderer-complete'")
  })
})
