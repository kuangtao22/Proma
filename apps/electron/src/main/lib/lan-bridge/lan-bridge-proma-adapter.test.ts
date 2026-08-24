import { describe, expect, test } from 'bun:test'
import {
  createLanBridgePromaAdapter,
  type LanBridgePromaDependencies,
} from './lan-bridge-proma-adapter-core'

/** 创建包含额外内部字段的最小官方依赖，验证适配层只输出 LAN 白名单字段。 */
function createDependencies(): LanBridgePromaDependencies {
  return {
    listConversations: () => [
      {
        id: 'conversation-1',
        title: '对话',
        pinned: true,
        archived: true,
        createdAt: 1,
        updatedAt: 2,
        internalPath: '/private/conversations/1.jsonl',
        providerOptions: { temperature: 0.5 },
      },
      {
        id: 'conversation-2',
        title: '缺省状态对话',
        createdAt: 3,
        updatedAt: 4,
      },
    ],
    getConversationMessages: () => [],
    searchConversationMessages: async () => [{
      conversationId: 'conversation-1',
      conversationTitle: '对话',
      snippet: '命中正文',
      internalPath: '/private/conversations/1.jsonl',
    }],
    listAgentSessions: () => [
      {
        id: 'agent-1',
        title: 'Agent',
        workspaceId: 'workspace-1',
        pinned: true,
        archived: true,
        manualWorking: true,
        starred: true,
        createdAt: 3,
        updatedAt: 4,
        internalPath: '/private/agents/1.jsonl',
      },
      {
        id: 'agent-2',
        title: '无工作区 Agent',
        createdAt: 5,
        updatedAt: 6,
        providerOptions: { reasoning: 'high' },
      },
      {
        id: 'design-agent',
        title: '内部设计任务',
        workspaceId: 'workspace-1',
        sourceDesignProjectId: 'workspace-1',
        sourceDesignJobId: 'job-1',
        createdAt: 7,
        updatedAt: 8,
      },
    ],
    getAgentSessionMessages: () => [],
    searchAgentSessionMessages: async () => [{
      sessionId: 'agent-1',
      sessionTitle: 'Agent',
      snippet: 'Agent 命中正文',
      providerOptions: { reasoning: 'high' },
    }],
    listAgentWorkspaces: () => [{
      id: 'workspace-1',
      name: '项目',
      slug: 'project',
      createdAt: 7,
      internalPath: '/private/workspaces/project',
    }],
    createAgentSession: (title, _channelId, workspaceId) => ({
      id: 'created-agent',
      title: title ?? '新 Agent 会话',
      workspaceId,
      createdAt: 8,
      updatedAt: 8,
    }),
    isAgentSessionActive: () => false,
    getAgentSessionRuntimeStatus: (sessionId) => sessionId === 'agent-1' ? 'blocked' : 'idle',
    updateAgentSessionStarred: (sessionId) => ({
      id: sessionId,
      title: 'Agent',
      workspaceId: 'workspace-1',
      starred: false,
      createdAt: 3,
      updatedAt: 9,
    }),
    markAgentSessionViewed: () => true,
    runAgentHeadless: async () => {},
    stopAgent: () => {},
    getSettings: () => ({
      agentChannelId: 'channel-1',
      agentModelId: 'model-1',
      agentWorkspaceId: 'workspace-1',
      apiKey: 'secret',
      providerOptions: { baseUrl: 'https://internal.example' },
    }),
    listChannels: () => [
      {
        id: 'channel-1',
        name: '渠道',
        provider: 'openai',
        enabled: true,
        baseUrl: 'https://api.example',
        models: [
          {
            id: 'model-1',
            name: '模型',
            enabled: true,
            source: 'manual',
            providerOptions: { reasoning: 'high' },
          },
          { id: 'model-disabled', name: '禁用模型', enabled: false },
        ],
        apiKey: 'encrypted-secret',
        providerOptions: { organization: 'internal' },
      },
      {
        id: 'channel-disabled',
        name: '禁用渠道',
        provider: 'anthropic',
        enabled: false,
        baseUrl: 'https://disabled.example',
        models: [{ id: 'disabled-channel-model', name: '不可见模型', enabled: true }],
        apiKey: 'another-secret',
      },
    ],
    sendConversationMessage: async () => {},
    stopConversation: () => {},
    getPrimaryWebContents: () => null,
    notifyAgentTitleUpdated: () => {},
  }
}

describe('LAN Bridge Proma Adapter', () => {
  test('外部 sessionId 为 traversal 或不存在实体时拒绝读取消息', () => {
    let readCount = 0
    const dependencies: LanBridgePromaDependencies = {
      ...createDependencies(),
      getAgentSessionMessages: () => {
        readCount += 1
        return []
      },
    }
    const adapter = createLanBridgePromaAdapter(dependencies)

    expect(() => adapter.getAgentMessages('../agent-1')).toThrow('无效的会话 ID')
    expect(() => adapter.getAgentMessages('missing-agent')).toThrow('会话不存在')
    expect(() => adapter.getAgentMessages('design-agent')).toThrow('会话不存在')
    expect(readCount).toBe(0)
  })

  test('外部 sessionId 为 traversal 或不存在实体时拒绝发送 Agent 消息', async () => {
    let sendCount = 0
    const dependencies: LanBridgePromaDependencies = {
      ...createDependencies(),
      runAgentHeadless: async () => { sendCount += 1 },
    }
    const adapter = createLanBridgePromaAdapter(dependencies)

    await expect(adapter.sendAgent({ sessionId: '../agent-1', userMessage: '越界' }, {}))
      .rejects.toThrow('无效的会话 ID')
    await expect(adapter.sendAgent({ sessionId: 'missing-agent', userMessage: '不存在' }, {}))
      .rejects.toThrow('会话不存在')
    expect(sendCount).toBe(0)
  })

  test('外部 conversationId 为 traversal 或不存在实体时拒绝读取与发送', async () => {
    let readCount = 0
    let sendCount = 0
    const dependencies: LanBridgePromaDependencies = {
      ...createDependencies(),
      getConversationMessages: () => {
        readCount += 1
        return []
      },
      sendConversationMessage: async () => { sendCount += 1 },
    }
    const adapter = createLanBridgePromaAdapter(dependencies)

    expect(() => adapter.getConversationMessages('../conversation-1')).toThrow('无效的会话 ID')
    expect(() => adapter.getConversationMessages('missing-conversation')).toThrow('会话不存在')
    await expect(adapter.sendConversation({
      conversationId: '../conversation-1', userMessage: '越界',
    }, {})).rejects.toThrow('无效的会话 ID')
    await expect(adapter.sendConversation({
      conversationId: 'missing-conversation', userMessage: '不存在',
    }, {})).rejects.toThrow('会话不存在')
    expect({ readCount, sendCount }).toEqual({ readCount: 0, sendCount: 0 })
  })

  test('会话和工作区列表只返回 LAN 稳定字段，并保留缺失的可选工作区', () => {
    /** 被测适配器使用纯依赖注入，避免读取真实用户配置。 */
    const adapter = createLanBridgePromaAdapter(createDependencies())

    expect(adapter.listConversations()).toEqual([
      {
        id: 'conversation-1',
        title: '对话',
        pinned: true,
        archived: true,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: 'conversation-2',
        title: '缺省状态对话',
        createdAt: 3,
        updatedAt: 4,
      },
    ])
    expect(adapter.listAgentSessions()).toEqual([
      {
        id: 'agent-1',
        title: 'Agent',
        workspaceId: 'workspace-1',
        pinned: true,
        archived: true,
        manualWorking: true,
        starred: true,
        runtimeStatus: 'blocked',
        createdAt: 3,
        updatedAt: 4,
      },
      {
        id: 'agent-2',
        title: '无工作区 Agent',
        runtimeStatus: 'idle',
        createdAt: 5,
        updatedAt: 6,
      },
    ])
    expect(adapter.listWorkspaces()).toEqual([{
      id: 'workspace-1',
      name: '项目',
      slug: 'project',
      createdAt: 7,
    }])
  })

  test('星标切换与完成状态确认均通过稳定 Adapter 返回', () => {
    /** 被测 Adapter 使用可观察依赖，验证 handler 无需接触上游会话结构。 */
    const adapter = createLanBridgePromaAdapter(createDependencies())

    expect(adapter.toggleAgentSessionStar('agent-1')).toEqual({
      id: 'agent-1',
      title: 'Agent',
      workspaceId: 'workspace-1',
      starred: false,
      runtimeStatus: 'blocked',
      createdAt: 3,
      updatedAt: 9,
    })
    expect(adapter.markAgentSessionViewed('agent-1')).toEqual({
      changed: true,
      runtimeStatus: 'blocked',
    })
  })

  test('搜索、设置和渠道逐字段映射且不泄漏内部配置', async () => {
    /** 固定时间戳用于验证两类搜索结果的稳定 LAN 结构。 */
    const matchedAt = 100
    /** 被测适配器复用同一组含敏感额外字段的依赖。 */
    const adapter = createLanBridgePromaAdapter(createDependencies())

    expect(await adapter.searchConversations('正文', matchedAt)).toEqual([{
      id: 'conversation-1',
      title: '对话',
      snippet: '命中正文',
      type: 'chat',
      matchedAt,
    }])
    expect(await adapter.searchAgentSessions('正文', matchedAt)).toEqual([{
      id: 'agent-1',
      title: 'Agent',
      snippet: 'Agent 命中正文',
      type: 'agent',
      matchedAt,
    }])
    expect(adapter.getSettings()).toEqual({
      agentChannelId: 'channel-1',
      agentModelId: 'model-1',
      agentWorkspaceId: 'workspace-1',
    })
    expect(adapter.listChannels()).toEqual([{
      id: 'channel-1', name: '渠道', provider: 'openai', enabled: true,
    }, {
      id: 'channel-disabled', name: '禁用渠道', provider: 'anthropic', enabled: false,
    }])
    expect(adapter.listEnabledChannelOptions()).toEqual([{
      id: 'channel-1',
      name: '渠道',
      provider: 'openai',
      baseUrl: 'https://api.example',
      models: [{ id: 'model-1', name: '模型', enabled: true, source: 'manual' }],
    }])
  })

  test('空集合保持为空，不制造占位数据', async () => {
    /** 空集合依赖覆盖主要边界，其他行为沿用默认测试依赖。 */
    const dependencies: LanBridgePromaDependencies = {
      ...createDependencies(),
      listConversations: () => [],
      listAgentSessions: () => [],
      listAgentWorkspaces: () => [],
      searchConversationMessages: async () => [],
      searchAgentSessionMessages: async () => [],
      listChannels: () => [],
    }
    /** 被测适配器不会为缺失上游数据补造默认记录。 */
    const adapter = createLanBridgePromaAdapter(dependencies)

    expect(adapter.listConversations()).toEqual([])
    expect(adapter.listAgentSessions()).toEqual([])
    expect(adapter.listWorkspaces()).toEqual([])
    expect(await adapter.searchConversations('正文')).toEqual([])
    expect(await adapter.searchAgentSessions('正文')).toEqual([])
    expect(adapter.listChannels()).toEqual([])
  })

  test('对话发送缺少可选渠道和模型时使用设置默认值', async () => {
    /** 捕获 Adapter 交给官方 Chat 服务的最小输入。 */
    let capturedSelection: { channelId: string; modelId: string } | undefined
    /** 覆盖发送依赖以观察可选字段的默认值解析。 */
    const dependencies: LanBridgePromaDependencies = {
      ...createDependencies(),
      sendConversationMessage: async (input) => {
        capturedSelection = { channelId: input.channelId, modelId: input.modelId }
      },
    }
    /** 被测适配器应独立兑现命令接口的可选字段语义。 */
    const adapter = createLanBridgePromaAdapter(dependencies)

    await adapter.sendConversation({
      conversationId: 'conversation-1',
      userMessage: '继续',
    }, {})

    expect(capturedSelection).toEqual({
      channelId: 'channel-1',
      modelId: 'model-1',
    })
  })

  test('Agent 发送使用默认渠道，并让空模型和工作区回退设置值', async () => {
    /** 捕获 Adapter 交给官方 Agent 服务的默认选择与权限模式。 */
    let capturedSelection: {
      channelId: string
      modelId?: string
      workspaceId?: string
      permissionModeOverride?: 'bypassPermissions' | 'plan'
    } | undefined
    /** 覆盖 Agent 执行依赖以观察旧 handler 的默认值语义。 */
    const dependencies: LanBridgePromaDependencies = {
      ...createDependencies(),
      runAgentHeadless: async (input) => {
        capturedSelection = {
          channelId: input.channelId,
          modelId: input.modelId,
          workspaceId: input.workspaceId,
          permissionModeOverride: input.permissionModeOverride,
        }
      },
    }
    /** 被测适配器负责把 LAN 命令转换为官方 Agent 输入。 */
    const adapter = createLanBridgePromaAdapter(dependencies)

    await adapter.sendAgent({
      sessionId: 'agent-1',
      userMessage: '继续',
      modelId: '',
      workspaceId: '',
    }, {})

    expect(capturedSelection).toEqual({
      channelId: 'channel-1',
      modelId: 'model-1',
      workspaceId: 'workspace-1',
      permissionModeOverride: 'bypassPermissions',
    })
  })

  test('Given 官方先错误后完成 When 映射终止回调 Then 只转发错误终止链', async () => {
    /** 记录 LAN 层实际收到的错误，验证错误只转发一次。 */
    const errors: string[] = []
    /** 记录 LAN 层独立完成回调次数，错误后的官方完成必须被抑制。 */
    let completeCount = 0
    /** 模拟官方异常路径依次触发 onError 和 onComplete。 */
    const dependencies: LanBridgePromaDependencies = {
      ...createDependencies(),
      runAgentHeadless: async (_input, callbacks) => {
        callbacks.onError('运行失败')
        callbacks.onComplete()
      },
    }
    /** 被测适配器负责把两个官方终止信号合并成一次 LAN 终止链。 */
    const adapter = createLanBridgePromaAdapter(dependencies)

    await adapter.sendAgent({ sessionId: 'agent-1', userMessage: '继续' }, {
      onError: ({ error }) => errors.push(error),
      onComplete: () => { completeCount += 1 },
    })

    expect(errors).toEqual(['运行失败'])
    expect(completeCount).toBe(0)
  })

  test('Given 官方先完成后迟到错误 When 映射终止回调 Then 不重复终止', async () => {
    /** 记录 LAN 层错误，完成后的迟到错误必须被忽略。 */
    const errors: string[] = []
    /** 记录 LAN 层完成次数，正常完成只允许转发一次。 */
    let completeCount = 0
    /** 模拟官方先完成、后错误的异常时序。 */
    const dependencies: LanBridgePromaDependencies = {
      ...createDependencies(),
      runAgentHeadless: async (_input, callbacks) => {
        callbacks.onComplete()
        callbacks.onError('迟到错误')
      },
    }
    /** 被测适配器负责拒绝首个终止信号之后的迟到事件。 */
    const adapter = createLanBridgePromaAdapter(dependencies)

    await adapter.sendAgent({ sessionId: 'agent-1', userMessage: '继续' }, {
      onError: ({ error }) => errors.push(error),
      onComplete: () => { completeCount += 1 },
    })

    expect(completeCount).toBe(1)
    expect(errors).toEqual([])
  })
})
