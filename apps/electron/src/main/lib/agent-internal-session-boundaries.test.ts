import { describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta, FeishuBotConfig, FeishuChatBinding, FeishuMessageContext } from '@proma/shared'
import { readFileSync } from 'node:fs'
import { agentSessionManagerTestMock } from './agent-session-manager.test-mock'

/** 测试中模拟的全量 Agent 会话索引。 */
const sessions = agentSessionManagerTestMock.sessions
/** Bridge 对外发送的消息。 */
const bridgeReplies: string[] = []
/** Bridge 触发的停止副作用。 */
const stoppedSessions: string[] = []
/** Bridge 触发的 Agent 运行副作用。 */
const startedSessions: string[] = []
/** 测试捕获的无头 Agent 终态回调。 */
const headlessCallbacks = new Map<string, { onError: (error: string) => void }>()
/** 飞书对外发送的序列化消息内容。 */
const feishuReplies: string[] = []

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
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
  runAgentHeadless: async (
    input: { sessionId: string },
    callbacks: { onError: (error: string) => void },
  ) => {
    startedSessions.push(input.sessionId)
    headlessCallbacks.set(input.sessionId, callbacks)
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
    agentSessionManagerTestMock.reset()
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
    agentSessionManagerTestMock.reset()
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

  test.each([
    ['Canvas', { sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1' }],
    ['Design', { sourceDesignProjectId: 'project-1', sourceDesignJobId: 'job-1' }],
    ['半归属', { sourceCanvasId: 'canvas-1' }],
    ['另一项目', { workspaceId: 'project-2' }],
  ])('Given Common Bridge 运行中会话变为%s When terminal onError Then 不外发内部错误并清理缓冲', async (_name, fields) => {
    agentSessionManagerTestMock.reset()
    bridgeReplies.length = 0
    startedSessions.length = 0
    headlessCallbacks.clear()
    sessions.set('terminal-race', createSession('terminal-race'))
    const { BridgeCommandHandler } = await import('./bridge-command-handler')
    const handler = new BridgeCommandHandler({
      platformName: '测试',
      adapter: { sendText: async (_chatId, reply) => { bridgeReplies.push(reply) } },
    })

    await handler.handleIncomingMessage('chat-terminal', '/switch terminal')
    await handler.handleIncomingMessage('chat-terminal', '继续执行')
    const replyCount = bridgeReplies.length
    sessions.set('terminal-race', createSession('terminal-race', fields))

    headlessCallbacks.get('terminal-race')?.onError('内部路径 /private/secret 不应外发')

    const exposed = handler as unknown as { sessionBuffers: Map<string, unknown> }
    expect(bridgeReplies).toHaveLength(replyCount)
    expect(exposed.sessionBuffers.size).toBe(0)
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
    agentSessionManagerTestMock.reset()
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

  test.each([
    ['Canvas', {
      sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1',
    }],
    ['Design 半归属', { sourceDesignProjectId: 'project-1' }],
  ])('Given 发送处理中会话变为%s When 即将启动 Agent Then 再次验证并阻止运行', async (_name, fields) => {
    agentSessionManagerTestMock.reset()
    startedSessions.length = 0
    feishuReplies.length = 0
    sessions.set('racing-session', createSession('racing-session'))
    const { FeishuBridge } = await import('./feishu-bridge')
    const bridge = new FeishuBridge({
      id: 'bot-race',
      name: '竞态测试',
      enabled: true,
      appId: 'app-id',
      appSecret: 'encrypted',
    } as FeishuBotConfig)
    const exposed = bridge as unknown as {
      client: unknown
      chatBindings: Map<string, FeishuChatBinding>
      sessionToChat: Map<string, string>
      saveBindings: () => void
      handleUserMessage: (context: FeishuMessageContext, text: string) => Promise<void>
    }
    const binding: FeishuChatBinding = {
      chatId: 'chat-race',
      botId: 'bot-race',
      userId: 'user-1',
      sessionId: 'racing-session',
      workspaceId: 'project-1',
      channelId: 'channel-1',
      source: 'feishu',
      chatType: 'p2p',
      createdAt: 1,
      lastUsedAt: 1,
    }
    exposed.chatBindings.set(binding.chatId, binding)
    exposed.sessionToChat.set(binding.sessionId, binding.chatId)
    exposed.saveBindings = () => undefined
    exposed.client = {
      cardkit: { v1: { card: {
        create: async () => {
          sessions.set('racing-session', createSession('racing-session', fields))
          return { data: { card_id: 'card-race' } }
        },
        update: async () => undefined,
      } } },
      im: { message: {
        create: async (input: { data: { content: string } }) => {
          feishuReplies.push(input.data.content)
          return { data: { message_id: 'message-race' } }
        },
        reply: async () => ({ data: { message_id: 'reply-race' } }),
      } },
    }

    await exposed.handleUserMessage({
      chatId: 'chat-race',
      senderOpenId: 'user-1',
      messageId: 'incoming-race',
      chatType: 'p2p',
    }, '继续执行')

    expect(startedSessions).toEqual([])
  })

  test('Given 发送处理中会话迁移到另一项目 When 即将启动 Agent Then 拒绝混用旧附件上下文与新项目', async () => {
    agentSessionManagerTestMock.reset()
    startedSessions.length = 0
    sessions.set('workspace-race', createSession('workspace-race'))
    const { FeishuBridge } = await import('./feishu-bridge')
    const bridge = new FeishuBridge({
      id: 'bot-workspace-race', name: '项目竞态', enabled: true, appId: 'app-id', appSecret: 'encrypted',
    } as FeishuBotConfig)
    const exposed = bridge as unknown as {
      client: unknown
      chatBindings: Map<string, FeishuChatBinding>
      sessionToChat: Map<string, string>
      saveBindings: () => void
      handleUserMessage: (context: FeishuMessageContext, text: string) => Promise<void>
    }
    const binding: FeishuChatBinding = {
      chatId: 'chat-workspace-race', botId: 'bot-workspace-race', userId: 'user-1',
      sessionId: 'workspace-race', workspaceId: 'project-1', channelId: 'channel-1',
      source: 'feishu', chatType: 'p2p', createdAt: 1, lastUsedAt: 1,
    }
    exposed.chatBindings.set(binding.chatId, binding)
    exposed.sessionToChat.set(binding.sessionId, binding.chatId)
    exposed.saveBindings = () => undefined
    exposed.client = {
      cardkit: { v1: { card: {
        create: async () => {
          sessions.set('workspace-race', createSession('workspace-race', { workspaceId: 'project-2' }))
          return { data: { card_id: 'card-workspace-race' } }
        },
        update: async () => undefined,
      } } },
      im: { message: {
        create: async () => ({ data: { message_id: 'message-workspace-race' } }),
        reply: async () => ({ data: { message_id: 'reply-workspace-race' } }),
      } },
    }

    await exposed.handleUserMessage({
      chatId: binding.chatId, senderOpenId: 'user-1', messageId: 'incoming-workspace-race', chatType: 'p2p',
    }, '继续执行')

    expect(startedSessions).toEqual([])
  })

  test('Given 流式卡创建失败且会话同时转为内部会话 When 启动前拒绝 Then 所有本次运行状态均清空', async () => {
    agentSessionManagerTestMock.reset()
    startedSessions.length = 0
    sessions.set('no-card-race', createSession('no-card-race'))
    const { FeishuBridge } = await import('./feishu-bridge')
    const bridge = new FeishuBridge({
      id: 'bot-no-card', name: '无卡竞态', enabled: true, appId: 'app-id', appSecret: 'encrypted',
    } as FeishuBotConfig)
    const exposed = bridge as unknown as {
      client: unknown
      chatBindings: Map<string, FeishuChatBinding>
      sessionToChat: Map<string, string>
      sessionBuffers: Map<string, unknown>
      streamingRunStates: Map<string, unknown>
      streamingCards: Map<string, unknown>
      streamingCardsUsedSessions: Set<string>
      saveBindings: () => void
      handleUserMessage: (context: FeishuMessageContext, text: string) => Promise<void>
    }
    const binding: FeishuChatBinding = {
      chatId: 'chat-no-card', botId: 'bot-no-card', userId: 'user-1', sessionId: 'no-card-race',
      workspaceId: 'project-1', channelId: 'channel-1', source: 'feishu', chatType: 'p2p',
      createdAt: 1, lastUsedAt: 1,
    }
    exposed.chatBindings.set(binding.chatId, binding)
    exposed.sessionToChat.set(binding.sessionId, binding.chatId)
    exposed.saveBindings = () => undefined
    exposed.client = {
      cardkit: { v1: { card: {
        create: async () => {
          sessions.set('no-card-race', createSession('no-card-race', { sourceCanvasNodeId: 'node-1' }))
          throw new Error('card open failed')
        },
      } } },
      im: { message: {
        create: async () => ({ data: { message_id: 'message-no-card' } }),
        reply: async () => ({ data: { message_id: 'reply-no-card' } }),
      } },
    }

    await exposed.handleUserMessage({
      chatId: binding.chatId, senderOpenId: 'user-1', messageId: 'incoming-no-card', chatType: 'p2p',
    }, '继续执行')

    expect(startedSessions).toEqual([])
    expect(exposed.sessionBuffers.size).toBe(0)
    expect(exposed.streamingRunStates.size).toBe(0)
    expect(exposed.streamingCards.size).toBe(0)
    expect(exposed.streamingCardsUsedSessions.size).toBe(0)
  })

  test('Given 飞书流式卡运行中身份失效且 close 抛错 When terminal onError Then 不外发错误且所有状态仍清空', async () => {
    agentSessionManagerTestMock.reset()
    startedSessions.length = 0
    headlessCallbacks.clear()
    feishuReplies.length = 0
    sessions.set('feishu-terminal-card', createSession('feishu-terminal-card'))
    const { FeishuBridge } = await import('./feishu-bridge')
    const bridge = new FeishuBridge({
      id: 'bot-terminal-card', name: '终态卡片', enabled: true, appId: 'app-id', appSecret: 'encrypted',
    } as FeishuBotConfig)
    const exposed = bridge as unknown as {
      client: unknown
      chatBindings: Map<string, FeishuChatBinding>
      sessionToChat: Map<string, string>
      sessionBuffers: Map<string, unknown>
      streamingRunStates: Map<string, unknown>
      streamingCards: Map<string, { close: () => Promise<void> }>
      streamingCardsUsedSessions: Set<string>
      streamingTerminalHandledSessions: Map<string, number>
      saveBindings: () => void
      handleUserMessage: (context: FeishuMessageContext, text: string) => Promise<void>
    }
    const binding: FeishuChatBinding = {
      chatId: 'chat-terminal-card', botId: 'bot-terminal-card', userId: 'user-1',
      sessionId: 'feishu-terminal-card', workspaceId: 'project-1', channelId: 'channel-1',
      source: 'feishu', chatType: 'p2p', createdAt: 1, lastUsedAt: 1,
    }
    exposed.chatBindings.set(binding.chatId, binding)
    exposed.sessionToChat.set(binding.sessionId, binding.chatId)
    exposed.saveBindings = () => undefined
    exposed.client = {
      cardkit: { v1: { card: {
        create: async () => ({ data: { card_id: 'card-terminal' } }),
        update: async () => undefined,
      } } },
      im: { message: {
        create: async (input: { data: { content: string } }) => {
          feishuReplies.push(input.data.content)
          return { data: { message_id: 'message-terminal' } }
        },
        reply: async () => ({ data: { message_id: 'reply-terminal' } }),
      } },
    }

    await exposed.handleUserMessage({
      chatId: binding.chatId, senderOpenId: 'user-1', messageId: 'incoming-terminal', chatType: 'p2p',
    }, '继续执行')
    const card = exposed.streamingCards.get(binding.sessionId)
    let closeAttempts = 0
    if (card) {
      card.close = async () => {
        closeAttempts += 1
        throw new Error('close failed')
      }
    }
    exposed.streamingTerminalHandledSessions.set(binding.sessionId, 1)
    const replyCount = feishuReplies.length
    sessions.set(binding.sessionId, createSession(binding.sessionId, { sourceCanvasNodeId: 'node-1' }))

    headlessCallbacks.get(binding.sessionId)?.onError('内部飞书错误正文不应外发')

    expect(feishuReplies).toHaveLength(replyCount)
    expect(closeAttempts).toBe(1)
    expect(exposed.sessionBuffers.size).toBe(0)
    expect(exposed.streamingRunStates.size).toBe(0)
    expect(exposed.streamingCards.size).toBe(0)
    expect(exposed.streamingCardsUsedSessions.size).toBe(0)
    expect(exposed.streamingTerminalHandledSessions.size).toBe(0)
  })

  test('Given 飞书流式卡创建失败后运行中身份失效 When terminal onError Then 不新增错误卡并清空无卡状态', async () => {
    agentSessionManagerTestMock.reset()
    startedSessions.length = 0
    headlessCallbacks.clear()
    feishuReplies.length = 0
    sessions.set('feishu-terminal-no-card', createSession('feishu-terminal-no-card'))
    const { FeishuBridge } = await import('./feishu-bridge')
    const bridge = new FeishuBridge({
      id: 'bot-terminal-no-card', name: '终态无卡', enabled: true, appId: 'app-id', appSecret: 'encrypted',
    } as FeishuBotConfig)
    const exposed = bridge as unknown as {
      client: unknown
      chatBindings: Map<string, FeishuChatBinding>
      sessionToChat: Map<string, string>
      sessionBuffers: Map<string, unknown>
      streamingRunStates: Map<string, unknown>
      streamingCards: Map<string, unknown>
      streamingCardsUsedSessions: Set<string>
      streamingTerminalHandledSessions: Map<string, number>
      saveBindings: () => void
      handleUserMessage: (context: FeishuMessageContext, text: string) => Promise<void>
    }
    const binding: FeishuChatBinding = {
      chatId: 'chat-terminal-no-card', botId: 'bot-terminal-no-card', userId: 'user-1',
      sessionId: 'feishu-terminal-no-card', workspaceId: 'project-1', channelId: 'channel-1',
      source: 'feishu', chatType: 'p2p', createdAt: 1, lastUsedAt: 1,
    }
    exposed.chatBindings.set(binding.chatId, binding)
    exposed.sessionToChat.set(binding.sessionId, binding.chatId)
    exposed.saveBindings = () => undefined
    exposed.client = {
      cardkit: { v1: { card: { create: async () => { throw new Error('card open failed') } } } },
      im: { message: {
        create: async (input: { data: { content: string } }) => {
          feishuReplies.push(input.data.content)
          return { data: { message_id: `message-${feishuReplies.length}` } }
        },
        reply: async () => ({ data: { message_id: 'reply-terminal-no-card' } }),
      } },
    }

    await exposed.handleUserMessage({
      chatId: binding.chatId, senderOpenId: 'user-1', messageId: 'incoming-terminal-no-card', chatType: 'p2p',
    }, '继续执行')
    exposed.streamingTerminalHandledSessions.set(binding.sessionId, 1)
    const replyCount = feishuReplies.length
    sessions.set(binding.sessionId, createSession(binding.sessionId, { workspaceId: 'project-2' }))

    headlessCallbacks.get(binding.sessionId)?.onError('内部无卡错误正文不应外发')

    expect(feishuReplies).toHaveLength(replyCount)
    expect(exposed.sessionBuffers.size).toBe(0)
    expect(exposed.streamingRunStates.size).toBe(0)
    expect(exposed.streamingCards.size).toBe(0)
    expect(exposed.streamingCardsUsedSessions.size).toBe(0)
    expect(exposed.streamingTerminalHandledSessions.size).toBe(0)
  })

  test('Given 飞书会话在流式事件前迁移项目 When handleAgentPayload Then 关闭卡片并统一清空失效状态', async () => {
    agentSessionManagerTestMock.reset()
    sessions.set('feishu-payload-race', createSession('feishu-payload-race', { workspaceId: 'project-2' }))
    const { FeishuBridge } = await import('./feishu-bridge')
    const bridge = new FeishuBridge({
      id: 'bot-payload-race', name: '事件竞态', enabled: true, appId: 'app-id', appSecret: 'encrypted',
    } as FeishuBotConfig)
    let closeAttempts = 0
    const exposed = bridge as unknown as {
      chatBindings: Map<string, FeishuChatBinding>
      sessionToChat: Map<string, string>
      sessionBuffers: Map<string, unknown>
      streamingRunStates: Map<string, unknown>
      streamingCards: Map<string, { close: () => Promise<void> }>
      streamingCardsUsedSessions: Set<string>
      streamingTerminalHandledSessions: Map<string, number>
      saveBindings: () => void
      handleAgentPayload: (sessionId: string, payload: unknown) => void
    }
    const binding: FeishuChatBinding = {
      chatId: 'chat-payload-race', botId: 'bot-payload-race', userId: 'user-1',
      sessionId: 'feishu-payload-race', workspaceId: 'project-1', channelId: 'channel-1',
      source: 'feishu', chatType: 'p2p', createdAt: 1, lastUsedAt: 1,
    }
    exposed.chatBindings.set(binding.chatId, binding)
    exposed.sessionToChat.set(binding.sessionId, binding.chatId)
    exposed.sessionBuffers.set(binding.sessionId, { text: '', toolSummaries: new Map(), startedAt: 1 })
    exposed.streamingCards.set(binding.sessionId, {
      close: async () => { closeAttempts += 1 },
    })
    exposed.streamingCardsUsedSessions.add(binding.sessionId)
    exposed.streamingTerminalHandledSessions.set(binding.sessionId, 1)
    exposed.saveBindings = () => undefined

    exposed.handleAgentPayload(binding.sessionId, {
      kind: 'sdk_message',
      message: { type: 'assistant', message: { content: [] } },
    })

    expect(closeAttempts).toBe(1)
    expect(exposed.chatBindings.size).toBe(0)
    expect(exposed.sessionToChat.size).toBe(0)
    expect(exposed.sessionBuffers.size).toBe(0)
    expect(exposed.streamingRunStates.size).toBe(0)
    expect(exposed.streamingCards.size).toBe(0)
    expect(exposed.streamingCardsUsedSessions.size).toBe(0)
    expect(exposed.streamingTerminalHandledSessions.size).toBe(0)
  })
})

describe('Canvas Agent Collaboration 边界', () => {
  test.each([
    ['完整 Canvas', {
      sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1',
    }],
    ['半归属 Canvas', { sourceCanvasId: 'canvas-1' }],
  ])('Given %s 会话 When 调用 delegate_agent Then 明确拒绝且不创建子会话', async (_name, fields) => {
    agentSessionManagerTestMock.reset()
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
    expect(agentSessionManagerTestMock.createdSessionIds).toEqual([])
  })

  test('Given 普通 Agent 会话 When 列出历史委派 Then 保持原有 Collaboration 恢复入口可用', async () => {
    agentSessionManagerTestMock.reset()
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
