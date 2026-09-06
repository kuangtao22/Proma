import { describe, expect, test } from 'bun:test'
import { createServerOpsAgentAccessSessionGuard } from './server-ops-agent-access-session-guard'

describe('Server Ops Agent 会话切换撤权守卫', () => {
  test('Given 运维页未挂载 When 普通 Agent 会话切换或关闭 Then 撤销上一会话且不重复撤销当前会话', async () => {
    /** 记录常驻层发出的会话撤权请求。 */
    const revokedSessionIds: string[] = []
    const guard = createServerOpsAgentAccessSessionGuard({
      revokeSession: async (sessionId) => { revokedSessionIds.push(sessionId) },
      reportError: () => undefined,
    })

    guard.select('session-a')
    guard.select('session-a')
    guard.select('session-b')
    guard.select(null)
    await Promise.resolve()

    expect(revokedSessionIds).toEqual(['session-a', 'session-b'])
  })

  test('Given 上一次撤权失败 When 随后继续切换 Then 仍按最新会话继续收口并报告稳定错误', async () => {
    /** 撤权调用顺序用于证明失败不会冻结守卫。 */
    const revokedSessionIds: string[] = []
    /** 仅记录公开错误消息，不把异常对象扩散到 React 层。 */
    const errors: string[] = []
    const guard = createServerOpsAgentAccessSessionGuard({
      revokeSession: async (sessionId) => {
        revokedSessionIds.push(sessionId)
        if (sessionId === 'session-a') throw new Error('REVOKE_FAILED')
      },
      reportError: (message) => { errors.push(message) },
    })

    guard.select('session-a')
    guard.select('session-b')
    guard.select('session-c')
    await Promise.resolve()
    await Promise.resolve()

    expect(revokedSessionIds).toEqual(['session-a', 'session-b'])
    expect(errors).toEqual(['REVOKE_FAILED'])
  })
})
