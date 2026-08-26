import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import * as completionPayload from './agent-completion-payload'

describe('Agent completion payload', () => {
  test('Given Canvas run 在准入早期失败 When 读取 completion metadata Then 只信任主进程 session getter', () => {
    /** 待实现的权威轻量 metadata 选择器。 */
    const selectSession = (completionPayload as typeof completionPayload & {
      selectAgentCompletionSessionMeta?: (
        sessionId: string,
        getSession: (sessionId: string) => AgentSessionMeta | undefined,
      ) => AgentSessionMeta | undefined
    }).selectAgentCompletionSessionMeta
    expect(selectSession).toBeFunction()
    if (!selectSession) return

    /** 主进程权威 Canvas session，包含不应跨 IPC 的 Pi 内部映射。 */
    const session = {
      id: 'canvas-session',
      title: 'Canvas Agent',
      workspaceId: 'project-1',
      sourceCanvasProjectId: 'project-1',
      sourceCanvasId: 'canvas-1',
      sourceCanvasNodeId: 'node-1',
      createdAt: 1,
      updatedAt: 1,
      piEntryBindings: { entry: 'message' },
    } as AgentSessionMeta
    /** 记录选择器确实只按目标 sessionId 查询一次。 */
    const requestedIds: string[] = []
    expect(selectSession('canvas-session', (sessionId) => {
      requestedIds.push(sessionId)
      return session
    })).toEqual({
      id: 'canvas-session',
      title: 'Canvas Agent',
      workspaceId: 'project-1',
      sourceCanvasProjectId: 'project-1',
      sourceCanvasId: 'canvas-1',
      sourceCanvasNodeId: 'node-1',
      createdAt: 1,
      updatedAt: 1,
    })
    expect(requestedIds).toEqual(['canvas-session'])
    expect(selectSession('missing', () => undefined)).toBeUndefined()
  })
})
