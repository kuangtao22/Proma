import { describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta, FeishuBotConfig, FeishuChatBinding, FeishuMessageContext } from '@proma/shared'
import { readFileSync } from 'node:fs'

/** 测试中模拟的全量 Agent 会话索引。 */
const sessions = new Map<string, AgentSessionMeta>()
/** Bridge 对外发送的消息。 */
const bridgeReplies: string[] = []
/** Bridge 触发的停止副作用。 */
const stoppedSessions: string[] = []
/** Bridge 触发的 Agent 运行副作用。 */
const startedSessions: string[] = []
/** 飞书对外发送的序列化消息内容。 */
const feishuReplies: string[] = []
/** Collaboration 创建的子会话数量。 */
let collaborationCreatedCount = 0

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

/** 判断测试会话是否属于普通用户入口。 */
function isVisible(session: AgentSessionMeta): boolean {
  return session.sourceDesignProjectId === undefined
    && session.sourceDesignJobId === undefined
    && session.sourceCanvasProjectId === undefined
    && session.sourceCanvasId === undefined
    && session.sourceCanvasNodeId === undefined
}

mock.module('./agent-session-manager', () => ({
  listAgentSessions: () => Array.from(sessions.values()),
  listVisibleAgentSessions: () => Array.from(sessions.values()).filter(isVisible),
  getAgentSessionMeta: (sessionId: string) => sessions.get(sessionId),
  createAgentSession: (_title: string, channelId: string, workspaceId?: string) => {
    collaborationCreatedCount += 1
    const created = createSession(`created-${collaborationCreatedCount}`, { channelId, workspaceId })
    sessions.set(created.id, created)
    return created
  },
  updateAgentSessionMeta: () => undefined,
  getAgentSessionMessages: () => [],
  getAgentSessionSDKMessages: () => [],
}))

mock.module('./agent-workspace-manager', () => ({
  listAgentWorkspacesByUpdatedAt: () => [{ id: 'project-1', name: '项目一', slug: 'project-1' }],
  getAgentWorkspace: (workspaceId: string) => workspaceId === 'project-1'
    ? { id: 'project-1', name: '项目一', slug: 'project-1' }
    : undefined,
  getProjectFilesPath: () => '/tmp/project-1',
  getWorkspaceCapabilities: () => ({ mcpServers: [], skills: [] }),
}))

mock.module('./settings-service', () => ({
  getSettings: () => ({
    agentChannelId: 'channel-1',
    agentModelId: 'model-1',
    agentWorkspaceId: 'project-1',
  }),
}))

mock.module('./main-window-store', () => ({ getMainWindow: () => null }))

mock.module('./agent-service', () => ({
  agentEventBus: { on: () => () => undefined },
  isAgentSessionActive: () => false,
  stopAgent: (sessionId: string) => stoppedSessions.push(sessionId),
  runAgentHeadless: async (input: { sessionId: string }) => {
    startedSessions.push(input.sessionId)
  },
}))

mock.module('./channel-manager', () => ({
  getChannelById: () => ({
    id: 'channel-1',
    name: '渠道',
    provider: 'openai',
    enabled: true,
    models: [{ id: 'model-1', name: '模型', enabled: true }],
  }),
  listChannels: () => [{
    id: 'channel-1',
    name: '渠道',
    provider: 'openai',
    enabled: true,
    models: [{ id: 'model-1', name: '模型', enabled: true }],
  }],
}))

/** 创建边界测试使用的最小会话。 */
function createSession(id: string, fields: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id,
    title: id,
    workspaceId: 'project-1',
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  }
}

describe('外部 Bridge 会话边界', () => {
  test('Given 普通、Design、Canvas 与半归属会话 When Bridge 列表和按 ID 切换 Then 只允许普通会话', async () => {
    sessions.clear()
    bridgeReplies.length = 0
    sessions.set('visible-session', createSession('visible-session'))
    sessions.set('design-session', createSession('design-session', {
      sourceDesignProjectId: 'project-1', sourceDesignJobId: 'job-1',
    }))
    sessions.set('canvas-session', createSession('canvas-session', {
      sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1',
    }))
    sessions.set('partial-session', createSession('partial-session', { sourceCanvasId: 'canvas-1' }))
    const { BridgeCommandHandler } = await import('./bridge-command-handler')
    const handler = new BridgeCommandHandler({
      platformName: '测试',
      adapter: { sendText: async (_chatId, text) => { bridgeReplies.push(text) } },
    })

    await handler.handleIncomingMessage('chat-1', '/list')
    expect(bridgeReplies.at(-1)).toContain('visible-session')
    expect(bridgeReplies.at(-1)).not.toContain('design-session')
    expect(bridgeReplies.at(-1)).not.toContain('canvas-session')
    expect(bridgeReplies.at(-1)).not.toContain('partial-session')

    await handler.handleIncomingMessage('chat-1', '/switch canvas')
    expect(handler.getBinding('chat-1')).toBeUndefined()
    expect(bridgeReplies.at(-1)).toContain('未找到会话')
  })

  test('Given 持久化绑定恢复后会话变成半归属 Canvas When 停止或发送 Then 清除绑定且副作用为零', async () => {
    sessions.clear()
    bridgeReplies.length = 0
    stoppedSessions.length = 0
    startedSessions.length = 0
    sessions.set('changing-session', createSession('changing-session'))
    const saved = [{
      chatId: 'chat-1',
      sessionId: 'changing-session',
      workspaceId: 'project-1',
      channelId: 'channel-1',
    }]
    const { BridgeCommandHandler } = await import('./bridge-command-handler')
    const handler = new BridgeCommandHandler({
      platformName: '测试',
      adapter: { sendText: async (_chatId, text) => { bridgeReplies.push(text) } },
      bindingStore: { load: () => saved, save: () => undefined },
    })
    sessions.set('changing-session', createSession('changing-session', { sourceCanvasNodeId: 'node-1' }))

    await handler.handleIncomingMessage('chat-1', '/stop')
    await handler.handleIncomingMessage('chat-1', '继续执行')

    expect(handler.getBinding('chat-1')?.sessionId).not.toBe('changing-session')
    expect(stoppedSessions).toEqual([])
    expect(startedSessions).not.toContain('changing-session')

    const activeSessionId = startedSessions.at(-1)
    expect(activeSessionId).toBeDefined()
    if (activeSessionId) {
      sessions.set(activeSessionId, createSession(activeSessionId, { sourceDesignProjectId: 'project-1' }))
      const replyCount = bridgeReplies.length
      const exposed = handler as unknown as { handleSessionComplete: (sessionId: string) => void }
      exposed.handleSessionComplete(activeSessionId)
      expect(bridgeReplies).toHaveLength(replyCount)
    }
  })
})

describe('统一内部会话消费者合同', () => {
  test('Given 状态岛实时事件与最近会话投影 When 检查边界 Then 两条路径都复用统一 visibility', () => {
    const source = readFileSync(new URL('./agent-island-service.ts', import.meta.url), 'utf-8')

    expect(source).toContain('if (!isAgentSessionUserVisible(getAgentSessionMeta(sessionId) ?? {}))')
    expect(source).toContain('.filter(isAgentSessionUserVisible)')
  })

  test('Given 项目删除需要回收内部会话 When 检查删除链路 Then 仍使用全量索引', () => {
    const source = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf-8')
    const deletionBoundary = source.slice(source.indexOf('const affectedSessions = listAgentSessions()'))

    expect(deletionBoundary.slice(0, 800)).toContain('.filter((session) => session.workspaceId === id)')
  })
})

describe('飞书 Bridge 会话边界', () => {
  test('Given 普通与内部会话 When 飞书列表、按 ID 切换和设置页绑定 Then 只允许普通会话', async () => {
    sessions.clear()
    stoppedSessions.length = 0
    feishuReplies.length = 0
    sessions.set('visible-session', createSession('visible-session'))
    sessions.set('design-session', createSession('design-session', { sourceDesignJobId: 'job-1' }))
    sessions.set('canvas-session', createSession('canvas-session', {
      sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1',
    }))
    const { FeishuBridge } = await import('./feishu-bridge')
    const bridge = new FeishuBridge({
      id: 'bot-boundary',
      name: '边界测试',
      enabled: true,
      appId: 'app-id',
      appSecret: 'encrypted',
    } as FeishuBotConfig)
    const exposed = bridge as unknown as {
      client: {
        im: {
          message: {
            create: (input: { data: { content: string } }) => Promise<{ data: { message_id: string } }>
            reply: (input: { data: { content: string } }) => Promise<{ data: { message_id: string } }>
          }
        }
      }
      chatBindings: Map<string, FeishuChatBinding>
      sessionToChat: Map<string, string>
      saveBindings: () => void
      handleCommand: (context: FeishuMessageContext, text: string) => Promise<void>
    }
    const captureReply = async (input: { data: { content: string } }): Promise<{ data: { message_id: string } }> => {
      feishuReplies.push(input.data.content)
      return { data: { message_id: `reply-${feishuReplies.length}` } }
    }
    exposed.client = { im: { message: { create: captureReply, reply: captureReply } } }
    exposed.saveBindings = () => undefined
    const context: FeishuMessageContext = {
      chatId: 'chat-feishu',
      senderOpenId: 'user-1',
      messageId: 'message-1',
      chatType: 'p2p',
    }

    await exposed.handleCommand(context, '/list')
    expect(feishuReplies.at(-1)).toContain('visible-session')
    expect(feishuReplies.at(-1)).not.toContain('design-session')
    expect(feishuReplies.at(-1)).not.toContain('canvas-session')

    await exposed.handleCommand(context, '/switch canvas')
    expect(feishuReplies.at(-1)).toContain('未找到会话')
    expect(bridge.listBindings()).toEqual([])

    const visibleBinding: FeishuChatBinding = {
      chatId: 'chat-feishu',
      botId: 'bot-boundary',
      userId: 'user-1',
      sessionId: 'visible-session',
      workspaceId: 'project-1',
      channelId: 'channel-1',
      source: 'feishu',
      chatType: 'p2p',
      createdAt: 1,
      lastUsedAt: 1,
    }
    exposed.chatBindings.set(visibleBinding.chatId, visibleBinding)
    exposed.sessionToChat.set(visibleBinding.sessionId, visibleBinding.chatId)
    expect(bridge.updateBinding({ chatId: 'chat-feishu', sessionId: 'canvas-session' })).toBeNull()
    expect(bridge.listBindings()[0]?.sessionId).toBe('visible-session')

    sessions.set('visible-session', createSession('visible-session', { sourceCanvasProjectId: 'project-1' }))
    await exposed.handleCommand(context, '/stop')
    expect(stoppedSessions).toEqual([])
    expect(bridge.listBindings()).toEqual([])
  })
})

describe('Canvas Agent Collaboration 边界', () => {
  test.each([
    ['完整 Canvas', {
      sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1',
    }],
    ['半归属 Canvas', { sourceCanvasId: 'canvas-1' }],
  ])('Given %s 会话 When 调用 delegate_agent Then 明确拒绝且不创建子会话', async (_name, fields) => {
    sessions.clear()
    collaborationCreatedCount = 0
    sessions.set('parent-session', createSession('parent-session', fields))
    const { buildPiCollaborationTools } = await import('./agent-collaboration-tools')
    const fakeSdk = {
      defineTool: <T extends { name: string }>(definition: T): T => definition,
    }
    const tools = buildPiCollaborationTools(
      fakeSdk as unknown as typeof import('@earendil-works/pi-coding-agent'),
      {
        sessionId: 'parent-session',
        channelId: 'channel-1',
        modelId: 'model-1',
        workspaceId: 'project-1',
        permissionMode: 'plan',
      },
    ) as Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }>
    const delegate = tools.find((tool) => tool.name === 'mcp__collaboration__delegate_agent')
    const list = tools.find((tool) => tool.name === 'mcp__collaboration__list_delegations')

    await expect(delegate?.execute('call-1', { task: '分析任务' })).rejects.toThrow('Canvas Agent 不允许使用协作工具')
    await expect(list?.execute('call-2', {})).rejects.toThrow('Canvas Agent 不允许使用协作工具')
    expect(collaborationCreatedCount).toBe(0)
  })

  test('Given 普通 Agent 会话 When 列出历史委派 Then 保持原有 Collaboration 恢复入口可用', async () => {
    sessions.clear()
    sessions.set('ordinary-parent', createSession('ordinary-parent'))
    const { buildPiCollaborationTools } = await import('./agent-collaboration-tools')
    const fakeSdk = {
      defineTool: <T extends { name: string }>(definition: T): T => definition,
    }
    const tools = buildPiCollaborationTools(
      fakeSdk as unknown as typeof import('@earendil-works/pi-coding-agent'),
      {
        sessionId: 'ordinary-parent',
        channelId: 'channel-1',
        workspaceId: 'project-1',
        permissionMode: 'plan',
      },
    ) as Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<{ details: unknown }> }>
    const list = tools.find((tool) => tool.name === 'mcp__collaboration__list_delegations')

    await expect(list?.execute('call-list', {})).resolves.toMatchObject({
      details: { runningCount: 0, delegations: [] },
    })
  })
})
