import { describe, expect, test } from 'bun:test'
import type { AgentSendInput, AgentSessionMeta, AgentStreamCompletePayload } from '@proma/shared'
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

    /** 主进程权威 Canvas session，包含所有不应跨 IPC 的路径和内部存储字段。 */
    const session = {
      id: 'canvas-session',
      title: 'Canvas Agent',
      workspaceId: 'project-1',
      sourceCanvasProjectId: 'project-1',
      sourceCanvasId: 'canvas-1',
      sourceCanvasNodeId: 'node-1',
      createdAt: 1,
      updatedAt: 1,
      piSessionFile: '/Users/example/.proma/agent-sessions/canvas-session.jsonl',
      piEntryBindings: { entry: 'message' },
      activeWorktree: {
        id: 'worktree-1',
        branch: 'feature/canvas-agent',
        path: '/Users/example/project-worktree',
        mainRepoRoot: '/Users/example/project',
        selectedAt: 1,
      },
      attachedDirectories: ['/Users/example/reference'],
      attachedFiles: ['/Users/example/secret.png'],
      forkSourceDir: '/Users/example/source-session',
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
    const serialized = JSON.stringify(selectSession('canvas-session', () => session))
    expect(serialized).not.toContain('piSessionFile')
    expect(serialized).not.toContain('piEntryBindings')
    expect(serialized).not.toContain('activeWorktree')
    expect(serialized).not.toContain('attachedDirectories')
    expect(serialized).not.toContain('attachedFiles')
    expect(serialized).not.toContain('forkSourceDir')
    expect(serialized).not.toContain('/Users/example')
    expect(requestedIds).toEqual(['canvas-session'])
    expect(selectSession('missing', () => undefined)).toBeUndefined()
  })

  test('Given headless 已开始后异常 When 构造 completion Then 普通会话仍携带权威轻量 metadata', () => {
    /** 待实现的统一权威 completion builder，所有 producer 都必须经过此入口。 */
    const buildPayload = (completionPayload as typeof completionPayload & {
      buildAuthoritativeAgentStreamCompletePayload?: (
        run: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'>>,
        getSession: (sessionId: string) => AgentSessionMeta | undefined,
        details: { messages: []; stoppedByUser: boolean; startedAt: number },
      ) => AgentStreamCompletePayload
    }).buildAuthoritativeAgentStreamCompletePayload
    expect(buildPayload).toBeFunction()
    if (!buildPayload) return

    /** 普通 external/headless 会话，不含 Canvas 内部归属。 */
    const ordinarySession = {
      id: 'ordinary-headless',
      title: '飞书任务',
      workspaceId: 'project-1',
      createdAt: 1,
      updatedAt: 2,
      piEntryBindings: { entry: 'message' },
    } as AgentSessionMeta
    const payload = buildPayload(
      { sessionId: ordinarySession.id, triggeredBy: 'user' },
      () => ordinarySession,
      { messages: [], stoppedByUser: false, startedAt: 10 },
    )

    expect(payload.session).toEqual({
      id: 'ordinary-headless',
      title: '飞书任务',
      workspaceId: 'project-1',
      createdAt: 1,
      updatedAt: 2,
    })
    expect(payload.messages).toEqual([])
    expect(payload.startedAt).toBe(10)
  })

  test('Given Canvas 流式错误 When 构造错误 payload Then 携带同一份安全归属且不泄露路径', () => {
    const session = {
      id: 'canvas-error', title: '失败任务', workspaceId: 'project-1',
      sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1',
      createdAt: 1, updatedAt: 2,
      piSessionFile: '/Users/example/private.jsonl',
      attachedFiles: ['/Users/example/secret.png'],
    } as AgentSessionMeta
    const payload = completionPayload.buildAuthoritativeAgentStreamErrorPayload(
      session.id,
      '模型失败',
      () => session,
      456,
    )

    expect(payload.session?.sourceCanvasNodeId).toBe('node-1')
    expect(payload.startedAt).toBe(456)
    expect(JSON.stringify(payload)).not.toContain('/Users/example')
  })
})
