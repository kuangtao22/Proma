import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWorkspaceOperationGuard } from './workspace-operation-guard'

describe('Agent 工作区迁移准入', () => {
  test('Given 会话权威项目正在迁移 When 发送与重试消息 Then 完成固定拒绝且不进入任何运行副作用', () => {
    /** 记录锁检查、回调与模拟运行副作用的顺序。 */
    const calls: string[] = []
    /** 注入迁移锁状态的守卫实例。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: () => undefined,
      getWorkspaceIdBySlug: () => undefined,
      getWorkspaceOperationBlockReason: (workspaceId) => {
        calls.push(`lock:${workspaceId}`)
        return workspaceId === 'workspace-authoritative' ? '项目正在迁移，请等待完成后重试' : undefined
      },
    })
    /** 通过生产准入执行器提交完整后续副作用 closure。 */
    const result = guard.runAdmittedAgentRun({
      sessionWorkspaceId: 'workspace-authoritative',
      requestedWorkspaceId: 'workspace-renderer-other',
      onError: (error) => calls.push(`error:${error}`),
      onComplete: () => calls.push('complete'),
    }, () => {
      calls.push('active')
      calls.push('remove-retry-error')
      calls.push('persist-user-message')
      calls.push('adapter')
      return 'started'
    })

    expect(result).toBeUndefined()
    expect(calls).toEqual([
      'lock:workspace-authoritative',
      'error:项目正在迁移，请等待完成后重试',
      'complete',
    ])
  })

  test('Given 会话未记录项目 When 请求项目未锁定 When 准入 Then 使用请求项目且正常放行', () => {
    /** 记录实际被查询的工作区 ID。 */
    const checkedWorkspaceIds: string[] = []
    /** 无锁守卫实例。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: () => undefined,
      getWorkspaceIdBySlug: () => undefined,
      getWorkspaceOperationBlockReason: (workspaceId) => {
        checkedWorkspaceIds.push(workspaceId)
        return undefined
      },
    })

    expect(guard.admitAgentRun({
      sessionWorkspaceId: undefined,
      requestedWorkspaceId: 'workspace-requested',
      onError: () => undefined,
      onComplete: () => undefined,
    })).toEqual({ admitted: true, workspaceId: 'workspace-requested' })
    expect(checkedWorkspaceIds).toEqual(['workspace-requested'])
  })
})

describe('Agent sendMessage 准入顺序合同', () => {
  test('Given sendMessage 实现 When 检查迁移拒绝分支 Then 它早于 active、retry 删除、消息落盘和首次 await', () => {
    /** 读取实际 orchestrator 源码以约束不可注入的副作用顺序。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** 仅截取 sendMessage 函数体，避免其它方法同名 token 干扰。 */
    const sendStart = source.indexOf('  async sendMessage(')
    const sendEnd = source.indexOf('\n  /**\n   * 中止指定会话', sendStart)
    const body = source.slice(sendStart, sendEnd)
    /** 去除注释，避免文字中的 await 或副作用名称干扰顺序判断。 */
    const executableBody = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    /** 迁移准入调用位置。 */
    const admissionIndex = executableBody.indexOf('workspaceOperationGuard.runAdmittedAgentRun(')
    /** 同步 active 槽注册位置。 */
    const activeIndex = executableBody.indexOf('this.activeSessions.set(sessionId, runGeneration)')
    /** 重试错误删除副作用位置。 */
    const retryDeleteIndex = executableBody.indexOf('removeSDKErrorMessage(sessionId, retryOfErrorUuid)')
    /** 用户消息持久化副作用位置。 */
    const persistIndex = executableBody.indexOf('persistInitialUserMessage()')
    /** sendMessage 函数体内当前最早的实际异步让出位置。 */
    const firstAwaitIndex = executableBody.indexOf('await ')

    expect(admissionIndex).toBeGreaterThan(-1)
    expect(activeIndex).toBeGreaterThan(admissionIndex)
    expect(retryDeleteIndex).toBeGreaterThan(activeIndex)
    expect(persistIndex).toBeGreaterThan(activeIndex)
    expect(firstAwaitIndex).toBeGreaterThan(activeIndex)
  })

  test('Given MCP preflight 支持降级 When 检查 generation checkpoint Then checkpoint 位于降级 catch 之后且 adapter 之前', () => {
    /** 读取真实 orchestrator 源码约束停止信号不会被 MCP 降级 catch 吞掉。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** MCP preflight 局部区域。 */
    const sendMessageStart = source.indexOf('  async sendMessage(')
    const start = source.indexOf('if (Object.keys(mcpServers).length > 0)', sendMessageStart)
    const end = source.indexOf('// 11. 构建动态上下文', start)
    const body = source.slice(start, end)
    /** MCP 调用、catch 和 catch 后 checkpoint 的位置。 */
    const callIndex = body.indexOf('await buildPiMcpTools(mcpServers)')
    const catchIndex = body.indexOf('} catch (error)')
    const checkpointIndex = body.lastIndexOf('checkpoint()')

    expect(callIndex).toBeGreaterThan(-1)
    expect(catchIndex).toBeGreaterThan(callIndex)
    expect(checkpointIndex).toBeGreaterThan(catchIndex)
  })
})
