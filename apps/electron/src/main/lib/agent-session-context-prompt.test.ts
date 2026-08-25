import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'

/** 测试用会话索引，允许伪造 Renderer 提交的内部会话引用。 */
const sessions = new Map<string, AgentSessionMeta>()
/** 记录消息读取次数，证明可见性判断发生在内容读取之前。 */
let messageReadCount = 0

mock.module('./agent-session-manager', () => ({
  getAgentSessionMeta: (sessionId: string) => sessions.get(sessionId),
  getAgentSessionSDKMessages: () => {
    messageReadCount += 1
    return []
  },
}))

type ContextPromptModule = typeof import('./agent-session-context-prompt')
let contextPrompt: ContextPromptModule

beforeAll(async () => {
  contextPrompt = await import('./agent-session-context-prompt')
})

function session(overrides: Partial<AgentSessionMeta> & Pick<AgentSessionMeta, 'id'>): AgentSessionMeta {
  return {
    title: `标题-${overrides.id}`,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/** 避免测试依赖用户机器上的活动数据根定位文件。 */
const configRootResolver = { requireActiveRoot: () => '/tmp/proma-context-prompt-test' }

describe('被引用 Agent 会话的主进程可见性复核', () => {
  test('Given 普通会话引用 When 构建 prompt Then 保留引用信息', () => {
    sessions.clear()
    sessions.set('visible', session({ id: 'visible', title: '普通会话' }))

    const prompt = contextPrompt.buildReferencedSessionsPrompt('current', ['visible'], undefined, configRootResolver)

    expect(prompt).toContain('id="visible"')
    expect(prompt).toContain('title="普通会话"')
  })

  test.each([
    ['完整 Canvas', session({ id: 'canvas', sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1', workspaceId: 'project-1' })],
    ['半归属 Canvas', session({ id: 'partial-canvas', sourceCanvasProjectId: 'project-1' })],
    ['Design', session({ id: 'design', sourceDesignProjectId: 'project-1', sourceDesignJobId: 'job-1' })],
  ])('Given Renderer 伪造 %s 会话引用 When 构建 prompt Then 不泄露标题或历史路径', (_label, internalSession) => {
    sessions.clear()
    sessions.set(internalSession.id, internalSession)
    messageReadCount = 0

    const prompt = contextPrompt.buildReferencedSessionsPrompt('current', [internalSession.id], undefined, configRootResolver)

    expect(prompt).toBe('')
    expect(prompt).not.toContain(internalSession.title)
    expect(prompt).not.toContain(`${internalSession.id}.jsonl`)
    expect(messageReadCount).toBe(0)
  })
})
