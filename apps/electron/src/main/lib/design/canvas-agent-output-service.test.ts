import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createCanvasBoundEdge, createEmptyCanvasDocument } from '@proma/shared'
import type { AgentSessionMeta, CanvasDocument, CanvasNode, SDKMessage } from '@proma/shared'
import { createCanvasDependencyStateService } from './canvas-dependency-state-service'
import {
  createCanvasAgentOutputService,
  inspectCanvasAgentOutputRecovery,
  type CanvasAgentCompletionInput,
  type CanvasAgentOutputServiceDependencies,
} from './canvas-agent-output-service'

const target = { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-1' }
const oldUuid = '123e4567-e89b-42d3-a456-426614174000'
const firstUuid = '123e4567-e89b-42d3-a456-426614174001'
const lastUuid = '123e4567-e89b-42d3-a456-426614174002'
const oldAnchorUuid = '123e4567-e89b-42d3-a456-426614174098'
const anchorUuid = '123e4567-e89b-42d3-a456-426614174099'
/** replacement session 使用独立锚点和回复，证明不会复用旧会话 run。 */
const replacementAnchorUuid = '123e4567-e89b-42d3-a456-426614174095'
const replacementMessageUuid = '123e4567-e89b-42d3-a456-426614174094'

test('Given 原运行工具结果和后续用户消息 When 恢复输出 Then 工具结果不切分运行且后续正式输出要求重规划', () => {
  /** 工具结果沿用 SDK 的 user envelope，但不是新用户请求。 */
  const toolResult = { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } } as unknown as SDKMessage
  const pointer = { messageUuid: firstUuid, completedAt: 30, contentSha256: createHash('sha256').update('原正文').digest('hex') }
  const messages = [user(anchorUuid), toolResult, assistant(firstUuid, [{ type: 'text', text: '原正文' }])]
  expect(inspectCanvasAgentOutputRecovery(messages, anchorUuid, 20, pointer)).toEqual({ status: 'completed', latestRun: true })
  messages.push(user(replacementAnchorUuid), assistant(lastUuid, [{ type: 'text', text: '新正文' }]))
  expect(inspectCanvasAgentOutputRecovery(messages, anchorUuid, 20, pointer)).toEqual({ status: 'completed', latestRun: false })
  expect(inspectCanvasAgentOutputRecovery(messages, anchorUuid, 20, {
    messageUuid: lastUuid, completedAt: 50, contentSha256: createHash('sha256').update('新正文').digest('hex'),
  })).toEqual({ status: 'changed', latestRun: false })
  expect(inspectCanvasAgentOutputRecovery(messages, anchorUuid, 20)).toEqual({ status: 'missing', latestRun: false })
  expect(() => inspectCanvasAgentOutputRecovery([...messages, user(anchorUuid)], anchorUuid, 20, pointer)).toThrow('CANVAS_AGENT_OUTPUT_INVALID')
})

/** 创建完整 Canvas 内部会话归属。 */
function createSession(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 'session-1', title: '研究 Agent', workspaceId: target.projectId,
    sourceCanvasProjectId: target.projectId, sourceCanvasId: target.canvasId,
    sourceCanvasNodeId: target.nodeId, createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

/** 创建覆盖正文、partial、replay 与错误状态的 assistant 消息。 */
function assistant(
  uuid: string | undefined,
  blocks: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: 'assistant', uuid, parent_tool_use_id: null,
    message: { content: blocks, stop_reason: 'end_turn' },
    ...overrides,
  } as unknown as SDKMessage
}

/** 创建落盘在本轮 assistant 之前的精确用户消息锚点。 */
function user(uuid: string): SDKMessage {
  return {
    type: 'user', uuid, parent_tool_use_id: null,
    message: { content: [{ type: 'text', text: '执行本轮任务' }] },
  } as unknown as SDKMessage
}

/** 构造由唯一用户消息锚定的当前 run 消息片段。 */
function currentRun(...messages: SDKMessage[]): SDKMessage[] {
  return [user(anchorUuid), ...messages]
}

/** 创建可观察原子图提交与发布顺序的输出服务 fixture。 */
function createFixture(options: {
  messages?: SDKMessage[]
  publishError?: Error
  mutateReturnsUncertain?: boolean
  afterUncertainWrite?: (document: CanvasDocument) => CanvasDocument
} = {}) {
  const oldPointer = {
    messageUuid: oldUuid,
    contentSha256: createHash('sha256').update('旧正文', 'utf8').digest('hex'),
    completedAt: 10,
  }
  let document: CanvasDocument = {
    ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1),
    revision: 4,
    nodes: [
      {
        id: target.nodeId, kind: 'agent', title: '研究 Agent', position: { x: 0, y: 0 },
        agentSessionId: 'session-1', outputPointer: oldPointer,
        upstreamChange: { sourceNodeIds: ['input-1'], changedAt: 8 },
      },
      { id: 'doc-1', kind: 'document', title: '文档', position: { x: 100, y: 0 }, documentId: 'doc-content', contentRevision: 1 },
      { id: 'image-1', kind: 'image', title: '图片', position: { x: 200, y: 0 }, imageModuleId: 'image-content' },
      { id: 'ignored-1', kind: 'document', title: '忽略', position: { x: 300, y: 0 }, documentId: 'ignored-content', contentRevision: 1 },
    ],
    edges: [],
  }
  const producer = document.nodes[0]!
  document.edges = [
    createCanvasBoundEdge(producer, document.nodes[1]!, {
      id: 'edge-doc', sourceNodeId: target.nodeId, targetNodeId: 'doc-1', relation: 'depends-on',
    }),
    createCanvasBoundEdge(producer, document.nodes[2]!, {
      id: 'edge-image', sourceNodeId: target.nodeId, targetNodeId: 'image-1', relation: 'reference',
    }),
    createCanvasBoundEdge(producer, document.nodes[3]!, {
      id: 'edge-ignored', sourceNodeId: target.nodeId, targetNodeId: 'ignored-1', relation: 'association',
    }),
  ]
  let messages = options.messages ?? []
  let session = createSession()
  let mutateCalls = 0
  let leaseHeld = false
  const publishStates: boolean[] = []
  const dependencies: CanvasAgentOutputServiceDependencies = {
    documents: {
      load: () => ({ document: structuredClone(document), writable: true, nodeIssues: [] }),
      mutate: (_target, expectedRevision, operations) => {
        expect(leaseHeld).toBe(true)
        if (expectedRevision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT')
        mutateCalls += 1
        const replacements = operations.flatMap((operation) => (
          operation.type === 'upsert-nodes' ? operation.nodes : []
        ))
        const replacementsById = new Map(replacements.map((node) => [node.id, node]))
        const committedDocument: CanvasDocument = {
          ...document,
          revision: document.revision + 1,
          nodes: document.nodes.map((node) => replacementsById.get(node.id) ?? node),
        }
        document = options.afterUncertainWrite?.(committedDocument) ?? committedDocument
        if (options.mutateReturnsUncertain) {
          throw new Error('CANVAS_COMMIT_UNCERTAIN: main durability requires reload')
        }
        return structuredClone(document)
      },
    },
    runExclusive: async (_target, effect) => {
      leaseHeld = true
      try { return await effect() } finally { leaseHeld = false }
    },
    dependencyState: createCanvasDependencyStateService(),
    getSession: () => session,
    getMessages: () => structuredClone(messages),
    publish: async () => {
      publishStates.push(leaseHeld)
      if (options.publishError) throw options.publishError
    },
  }
  return {
    service: createCanvasAgentOutputService(dependencies), oldPointer,
    getDocument: () => structuredClone(document),
    getMutateCalls: () => mutateCalls,
    getPublishStates: () => [...publishStates],
    setMessages: (next: SDKMessage[]) => { messages = next },
    setSession: (next: AgentSessionMeta) => { session = next },
    /** 模拟后续运行推进节点当前正式指针。 */
    setOutputPointer: (pointer: Extract<CanvasNode, { kind: 'agent' }>['outputPointer']) => {
      document = {
        ...document,
        revision: document.revision + 1,
        nodes: document.nodes.map((node) => node.id === target.nodeId && node.kind === 'agent'
          ? { ...node, outputPointer: pointer }
          : node),
      }
    },
    /** 模拟同一节点重建：owner 换绑新 session，并清除旧正式输出指针。 */
    replaceAgentOwner: (nextSessionId: string, nextMessages: SDKMessage[]) => {
      session = createSession({ id: nextSessionId })
      messages = nextMessages
      document = {
        ...document,
        revision: document.revision + 1,
        nodes: document.nodes.map((node) => {
          if (node.id !== target.nodeId || node.kind !== 'agent') return node
          const replacement = { ...node, agentSessionId: nextSessionId }
          delete replacement.outputPointer
          return replacement
        }),
      }
    },
  }
}

/** 创建只允许采纳精确用户消息锚点之后消息的成功完成输入。 */
function completion(overrides: Partial<CanvasAgentCompletionInput> = {}): CanvasAgentCompletionInput {
  return {
    target, runGeneration: 1, completedAt: 100, terminalStatus: 'completed',
    userMessageUuid: anchorUuid, startedAt: 50,
    ...overrides,
  }
}

describe('Canvas Agent 正式输出服务', () => {
  test('Given 当前 run 多条完整回复 When 解析完成输出 Then 选择最后一条并只顺序拼接 text 后计算精确 UTF-8 SHA-256', () => {
    const fixture = createFixture({ messages: [
      assistant(oldUuid, [{ type: 'text', text: '旧回复' }]),
      user(anchorUuid),
      assistant(firstUuid, [{ type: 'text', text: '第一条' }]),
      assistant(lastUuid, [
        { type: 'thinking', thinking: '不要进入正文' },
        { type: 'text', text: '你好，' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
        { type: 'text', text: '世界\n' },
        { type: 'title', text: '不要进入正文' },
      ]),
    ] })

    const result = fixture.service.resolveCompletedOutput(completion())

    expect(result).toEqual({
      content: '你好，世界\n',
      pointer: {
        messageUuid: lastUuid,
        contentSha256: createHash('sha256').update('你好，世界\n', 'utf8').digest('hex'),
        completedAt: 100,
      },
      runGeneration: 1,
    })
  })

  test.each([
    ['partial', assistant(lastUuid, [{ type: 'text', text: 'partial' }], { _partial: true })],
    ['errored', assistant(lastUuid, [{ type: 'text', text: 'error text' }], { error: { message: '失败' } })],
    ['without UUID', assistant(undefined, [{ type: 'text', text: 'no uuid' }])],
    ['replayed', assistant(lastUuid, [{ type: 'text', text: 'replay' }], { isReplay: true })],
    ['empty text', assistant(lastUuid, [{ type: 'thinking', thinking: 'only thinking' }, { type: 'text', text: '' }])],
    ['blank text', assistant(lastUuid, [{ type: 'text', text: '  \n' }])],
  ])('Given %s assistant When 解析正式输出 Then 返回稳定 missing 且不替换旧 pointer', async (_name, message) => {
    const fixture = createFixture({ messages: currentRun(message) })

    expect(() => fixture.service.resolveCompletedOutput(completion())).toThrow('CANVAS_AGENT_OUTPUT_MISSING')
    await expect(fixture.service.commit(completion())).rejects.toThrow('CANVAS_AGENT_OUTPUT_MISSING')
    expect(fixture.getMutateCalls()).toBe(0)
    expect((fixture.getDocument().nodes[0] as CanvasNode & { outputPointer?: object }).outputPointer)
      .toEqual(fixture.oldPointer)
  })

  test.each([
    ['顶层为 null', [null as unknown as SDKMessage]],
    ['顶层为数组', [[] as unknown as SDKMessage]],
    ['assistant 缺少 message', [user(anchorUuid), {
      type: 'assistant', uuid: lastUuid, parent_tool_use_id: null,
    } as unknown as SDKMessage]],
    ['assistant content 非数组', [user(anchorUuid), {
      type: 'assistant', uuid: lastUuid, parent_tool_use_id: null,
      message: { content: '损坏正文' },
    } as unknown as SDKMessage]],
    ['assistant text block 的 text 非字符串', currentRun(assistant(lastUuid, [
      { type: 'text', text: 42 },
    ]))],
    ['user content 非数组', [{
      type: 'user', uuid: anchorUuid, parent_tool_use_id: null,
      message: { content: { type: 'text', text: '损坏锚点' } },
    } as unknown as SDKMessage, assistant(lastUuid, [{ type: 'text', text: '正文' }])]],
  ])('Given SDK JSONL %s When 解析正式输出 Then 稳定返回 invalid 而非运行时 TypeError', (_name, messages) => {
    const fixture = createFixture({ messages })

    expect(() => fixture.service.resolveCompletedOutput(completion()))
      .toThrow('CANVAS_AGENT_OUTPUT_INVALID')
  })

  test('Given 当前锚点后没有完成回复 When 解析 Then 不得采纳锚点前的旧消息', () => {
    const fixture = createFixture({ messages: [
      user(oldAnchorUuid), assistant(oldUuid, [{ type: 'text', text: '旧回复' }]), user(anchorUuid),
    ] })

    expect(() => fixture.service.resolveCompletedOutput(completion())).toThrow('CANVAS_AGENT_OUTPUT_MISSING')
  })

  test.each(['partial', 'errored'] as const)('Given run 终态为 %s When 解析 Then 即使有正文也拒绝固化', (terminalStatus) => {
    const fixture = createFixture({ messages: currentRun(assistant(lastUuid, [{ type: 'text', text: '未完成正文' }])) })

    expect(() => fixture.service.resolveCompletedOutput(completion({ terminalStatus })))
      .toThrow('CANVAS_AGENT_OUTPUT_MISSING')
  })

  test('Given 当前 run 后已有下一条用户消息 When 解析旧 run Then 只检查两个用户锚点之间的 assistant', () => {
    const nextAnchor = '123e4567-e89b-42d3-a456-426614174096'
    const fixture = createFixture({ messages: [
      user(anchorUuid), assistant(firstUuid, [{ type: 'text', text: '本轮正文' }]),
      user(nextAnchor), assistant(lastUuid, [{ type: 'text', text: '下一轮正文' }]),
    ] })

    expect(fixture.service.resolveCompletedOutput(completion()).content).toBe('本轮正文')
  })

  test.each([
    ['缺少指针', undefined, createSession(), [assistant(lastUuid, [{ type: 'text', text: '正文' }])]],
    ['owner mismatch', { messageUuid: lastUuid, contentSha256: 'a'.repeat(64), completedAt: 10 }, createSession({ sourceCanvasNodeId: 'other' }), [assistant(lastUuid, [{ type: 'text', text: '正文' }])]],
    ['hash mismatch', { messageUuid: lastUuid, contentSha256: 'a'.repeat(64), completedAt: 10 }, createSession(), [assistant(lastUuid, [{ type: 'text', text: '正文' }])]],
    ['UUID 不存在', { messageUuid: lastUuid, contentSha256: createHash('sha256').update('正文', 'utf8').digest('hex'), completedAt: 10 }, createSession(), [assistant(firstUuid, [{ type: 'text', text: '正文' }])]],
  ])('Given %s When 读取正式输出 Then 统一返回稳定 invalid', async (_name, pointer, session, messages) => {
    const fixture = createFixture({ messages })
    const document = fixture.getDocument()
    const agent = document.nodes[0]
    if (!agent || agent.kind !== 'agent') throw new Error('测试 Agent 节点缺失')
    Object.assign(agent, { outputPointer: pointer })
    fixture.setSession(session)
    if (pointer === undefined) delete agent.outputPointer
    fixture.setMessages(messages)
    const isolated = createCanvasAgentOutputService({
      documents: {
        load: () => ({ document, writable: true, nodeIssues: [] }),
        mutate: () => { throw new Error('unexpected mutate') },
      },
      runExclusive: async (_target, effect) => effect(),
      dependencyState: createCanvasDependencyStateService(),
      getSession: () => session,
      getMessages: () => messages,
      publish: () => undefined,
    })

    await expect(isolated.read(target)).rejects.toThrow('CANVAS_AGENT_OUTPUT_INVALID')
  })

  test('Given 精确 UUID 指向唯一完整 assistant When 读取 Then 重建纯 text 正文并校验 hash', async () => {
    const content = '精确\n正文'
    const fixture = createFixture({ messages: currentRun(assistant(lastUuid, [
      { type: 'text', text: '精确\n' }, { type: 'thinking', thinking: '忽略' }, { type: 'text', text: '正文' },
    ])) })
    await fixture.service.commit(completion())

    expect(await fixture.service.read(target)).toBe(content)
  })

  test('Given 节点当前指针已被下一轮推进 When 按本次旧指针读取 Then 仍返回旧正文而不漂移', async () => {
    const oldContent = '本次正式正文'
    const nextContent = '下一轮正文'
    const fixture = createFixture({ messages: currentRun(
      assistant(firstUuid, [{ type: 'text', text: oldContent }]),
      user(replacementAnchorUuid),
      assistant(lastUuid, [{ type: 'text', text: nextContent }]),
    ) })
    const oldPointer = {
      messageUuid: firstUuid,
      contentSha256: createHash('sha256').update(oldContent, 'utf8').digest('hex'),
      completedAt: 100,
    }
    fixture.setOutputPointer({
      messageUuid: lastUuid,
      contentSha256: createHash('sha256').update(nextContent, 'utf8').digest('hex'),
      completedAt: 120,
    })

    expect(await fixture.service.readAtPointer(target, oldPointer)).toBe(oldContent)
  })

  test('Given 本次指针提交后节点 owner 已换绑 When 按旧指针读取 Then fail closed', async () => {
    const fixture = createFixture({ messages: currentRun(
      assistant(lastUuid, [{ type: 'text', text: '旧 owner 正文' }]),
    ) })
    const committed = await fixture.service.commit(completion())
    fixture.replaceAgentOwner('session-2', [
      user(replacementAnchorUuid),
      assistant(replacementMessageUuid, [{ type: 'text', text: '新 owner 正文' }]),
    ])

    await expect(fixture.service.readAtPointer(target, committed.pointer))
      .rejects.toThrow('CANVAS_AGENT_OUTPUT_INVALID')
  })

  test('Given fresh owner 与完成输出 When commit Then 同一次 CAS 更新 pointer、消费自身提示并只标记有效直接下游，发布在锁释放后', async () => {
    const fixture = createFixture({ messages: currentRun(assistant(lastUuid, [{ type: 'text', text: '正式正文' }])) })

    const result = await fixture.service.commit(completion())
    const document = fixture.getDocument()

    expect(result).toMatchObject({ revision: 5, downstreamNodeIds: ['doc-1', 'image-1'] })
    expect(fixture.getMutateCalls()).toBe(1)
    expect(document.nodes[0]).toMatchObject({ outputPointer: result.pointer })
    expect(document.nodes[0]).not.toHaveProperty('upstreamChange')
    expect(document.nodes.find((node) => node.id === 'doc-1')?.upstreamChange).toEqual({ sourceNodeIds: ['agent-1'], changedAt: 100 })
    expect(document.nodes.find((node) => node.id === 'image-1')?.upstreamChange).toEqual({ sourceNodeIds: ['agent-1'], changedAt: 100 })
    expect(document.nodes.find((node) => node.id === 'ignored-1')).not.toHaveProperty('upstreamChange')
    expect(fixture.getPublishStates()).toEqual([false])
  })

  test('Given mutate 已写入完整投影后返回 uncertain When commit Then fresh 对账确认并推进代次阻止旧回调', async () => {
    const generationTwoAnchor = '123e4567-e89b-42d3-a456-426614174092'
    const fixture = createFixture({
      messages: [user(generationTwoAnchor), assistant(lastUuid, [{ type: 'text', text: '第二代正式正文' }])],
      mutateReturnsUncertain: true,
    })

    const result = await fixture.service.commit(completion({
      userMessageUuid: generationTwoAnchor, runGeneration: 2, completedAt: 80,
    }))
    const committed = fixture.getDocument()
    fixture.setMessages([
      user(anchorUuid), assistant(firstUuid, [{ type: 'text', text: '第一代迟到' }]),
      user(generationTwoAnchor), assistant(lastUuid, [{ type: 'text', text: '第二代正式正文' }]),
    ])

    expect(result.revision).toBe(committed.revision)
    expect(result.downstreamNodeIds).toEqual(['doc-1', 'image-1'])
    await expect(fixture.service.commit(completion({
      runGeneration: 1, completedAt: 150,
    }))).rejects.toThrow('CANVAS_AGENT_OUTPUT_STALE')
    expect(fixture.getMutateCalls()).toBe(1)
    expect(fixture.getPublishStates()).toEqual([false])
  })

  test('Given mutate uncertain 后权威下游投影不一致 When commit Then 不误确认且不重写', async () => {
    const fixture = createFixture({
      messages: currentRun(assistant(lastUuid, [{ type: 'text', text: '正式正文' }])),
      mutateReturnsUncertain: true,
      afterUncertainWrite: (document) => ({
        ...document,
        nodes: document.nodes.map((node) => node.id === 'doc-1'
          ? { ...node, upstreamChange: { sourceNodeIds: ['other-agent'], changedAt: 100 } }
          : node),
      }),
    })

    await expect(fixture.service.commit(completion()))
      .rejects.toThrow('CANVAS_COMMIT_UNCERTAIN')
    expect(fixture.getMutateCalls()).toBe(1)
    expect(fixture.getPublishStates()).toEqual([])
  })

  test('Given mutate uncertain 后权威 revision 超过本次单次提交 When commit Then 不凭节点同值误确认', async () => {
    const fixture = createFixture({
      messages: currentRun(assistant(lastUuid, [{ type: 'text', text: '正式正文' }])),
      mutateReturnsUncertain: true,
      afterUncertainWrite: (document) => ({ ...document, revision: document.revision + 1 }),
    })

    await expect(fixture.service.commit(completion()))
      .rejects.toThrow('CANVAS_COMMIT_UNCERTAIN')
    expect(fixture.getMutateCalls()).toBe(1)
    expect(fixture.getPublishStates()).toEqual([])
  })

  test.each([
    ['owner', (document: CanvasDocument) => ({
      ...document,
      nodes: document.nodes.map((node) => node.id === target.nodeId && node.kind === 'agent'
        ? { ...node, agentSessionId: 'session-other' }
        : node),
    })],
    ['pointer', (document: CanvasDocument) => ({
      ...document,
      nodes: document.nodes.map((node) => node.id === target.nodeId && node.kind === 'agent'
        ? { ...node, outputPointer: { ...node.outputPointer!, contentSha256: 'f'.repeat(64) } }
        : node),
    })],
    ['producer pending', (document: CanvasDocument) => ({
      ...document,
      nodes: document.nodes.map((node) => node.id === target.nodeId
        ? { ...node, upstreamChange: { sourceNodeIds: ['stale-input'], changedAt: 100 } }
        : node),
    })],
  ])('Given mutate uncertain 后 %s 独立不一致 When commit Then 不误确认提交', async (_case, mutateDocument) => {
    const fixture = createFixture({
      messages: currentRun(assistant(lastUuid, [{ type: 'text', text: '正式正文' }])),
      mutateReturnsUncertain: true,
      afterUncertainWrite: mutateDocument,
    })

    await expect(fixture.service.commit(completion())).rejects.toThrow('CANVAS_COMMIT_UNCERTAIN')
    expect(fixture.getMutateCalls()).toBe(1)
    expect(fixture.getPublishStates()).toEqual([])
  })

  test('Given 广播失败 When commit Then 已提交图事实仍返回成功且不回滚', async () => {
    const fixture = createFixture({
      messages: currentRun(assistant(lastUuid, [{ type: 'text', text: '正式正文' }])),
      publishError: new Error('窗口已销毁'),
    })

    const result = await fixture.service.commit(completion())

    expect(fixture.getDocument().nodes[0]).toMatchObject({ outputPointer: result.pointer })
    expect(fixture.getMutateCalls()).toBe(1)
    expect(fixture.getPublishStates()).toEqual([false])
  })

  test('Given generation 2 已提交 When generation 1 迟到 Then 不能覆盖较新 pointer或产生部分图事实', async () => {
    const generationTwoAnchor = '123e4567-e89b-42d3-a456-426614174097'
    const fixture = createFixture({ messages: [user(generationTwoAnchor), assistant(lastUuid, [{ type: 'text', text: '第二代' }])] })
    await fixture.service.commit(completion({ userMessageUuid: generationTwoAnchor, runGeneration: 2, completedAt: 80 }))
    const committed = fixture.getDocument()
    fixture.setMessages([
      user(anchorUuid), assistant(firstUuid, [{ type: 'text', text: '第一代迟到' }]),
      user(generationTwoAnchor), assistant(lastUuid, [{ type: 'text', text: '第二代' }]),
    ])

    await expect(fixture.service.commit(completion({
      runGeneration: 1, completedAt: 150,
    }))).rejects.toThrow('CANVAS_AGENT_OUTPUT_STALE')
    expect(fixture.getDocument()).toEqual(committed)
    expect(fixture.getMutateCalls()).toBe(1)
  })

  test('Given 已提交代次 When 精确释放 owner 与 generation Then 只释放完全匹配的保护项', async () => {
    const generationTwoAnchor = '123e4567-e89b-42d3-a456-426614174091'
    const fixture = createFixture({ messages: [
      user(anchorUuid), assistant(firstUuid, [{ type: 'text', text: '第一代' }]),
      user(generationTwoAnchor), assistant(lastUuid, [{ type: 'text', text: '第二代' }]),
    ] })
    await fixture.service.commit(completion({
      userMessageUuid: generationTwoAnchor, runGeneration: 2, completedAt: 80,
    }))

    fixture.service.releaseGeneration({ ...target, agentSessionId: 'session-1', runGeneration: 1 })
    await expect(fixture.service.commit(completion({ runGeneration: 1, completedAt: 150 })))
      .rejects.toThrow('CANVAS_AGENT_OUTPUT_STALE')

    fixture.service.releaseGeneration({ ...target, agentSessionId: 'session-1', runGeneration: 2 })
    await expect(fixture.service.commit(completion({ runGeneration: 1, completedAt: 150 }))).resolves.toMatchObject({
      pointer: { messageUuid: firstUuid },
    })
  })

  test('Given 旧 session 高代次已提交且同节点重建 When 新 session generation 1 完成且旧回调迟到 Then 新输出可提交且旧输出 fail closed', async () => {
    const generationTwoAnchor = '123e4567-e89b-42d3-a456-426614174093'
    const fixture = createFixture({
      messages: [user(generationTwoAnchor), assistant(lastUuid, [{ type: 'text', text: '旧会话第二代' }])],
    })
    await fixture.service.commit(completion({
      userMessageUuid: generationTwoAnchor, runGeneration: 2, completedAt: 80,
    }))
    fixture.replaceAgentOwner('session-2', [
      user(replacementAnchorUuid),
      assistant(replacementMessageUuid, [{ type: 'text', text: '新会话第一代' }]),
    ])

    const replacement = await fixture.service.commit(completion({
      userMessageUuid: replacementAnchorUuid, runGeneration: 1, completedAt: 120,
    }))
    const committedReplacement = fixture.getDocument()

    expect(replacement.pointer.messageUuid).toBe(replacementMessageUuid)
    expect(committedReplacement.nodes[0]).toMatchObject({
      agentSessionId: 'session-2', outputPointer: replacement.pointer,
    })
    await expect(fixture.service.commit(completion({
      userMessageUuid: generationTwoAnchor, runGeneration: 3, completedAt: 150,
    }))).rejects.toThrow('CANVAS_AGENT_OUTPUT_INVALID')
    expect(fixture.getDocument()).toEqual(committedReplacement)
    expect(fixture.getMutateCalls()).toBe(2)
  })
})
