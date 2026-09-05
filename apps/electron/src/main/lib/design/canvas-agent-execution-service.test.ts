import { describe, expect, test } from 'bun:test'
import { createCanvasBoundEdge, createEmptyCanvasDocument } from '@proma/shared'
import type { AgentSessionMeta, CanvasDocument, SkillMeta } from '@proma/shared'
import type { CanvasAgentConfig } from './canvas-agent-config-store'
import {
  createCanvasAgentExecutionService,
  type CanvasAgentExecutionServiceDependencies,
} from './canvas-agent-execution-service'

const target = { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-1' }

/** 创建统一执行服务的可观察测试夹具。 */
function createFixture(options: {
  reserveError?: Error
  runError?: string
  stopped?: boolean
  skills?: SkillMeta[]
  config?: Partial<CanvasAgentConfig>
  commitError?: Error
  runGate?: Promise<void>
  configError?: Error
  modelError?: Error
  rendererStatus?: 'completed' | 'errored' | 'cancelled'
  configGate?: Promise<void>
  afterConfig?: () => void
  prepareDocument?: CanvasDocument
  commitGate?: Promise<void>
} = {}) {
  const calls: string[] = []
  const document: CanvasDocument = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
  document.revision = 7
  document.nodes = [
    { id: 'input-1', kind: 'document', title: '产品资料', position: { x: 0, y: 0 }, documentId: 'doc-1', contentRevision: 2 },
    { id: target.nodeId, kind: 'agent', title: '视频导演', position: { x: 100, y: 0 }, agentSessionId: 'child-1' },
    { id: 'ignored-1', kind: 'document', title: '仅关联', position: { x: 0, y: 100 }, documentId: 'doc-2', contentRevision: 1 },
  ]
  document.edges = [
    createCanvasBoundEdge(document.nodes[0]!, document.nodes[1]!, {
      id: 'edge-1', sourceNodeId: 'input-1', targetNodeId: target.nodeId, relation: 'depends-on',
    }),
    { id: 'edge-2', sourceNodeId: 'ignored-1', sourcePort: 'unbound', targetNodeId: target.nodeId, targetPort: 'unbound', relation: 'association' },
  ]
  const session: AgentSessionMeta = {
    id: 'child-1', title: '视频导演', workspaceId: target.projectId,
    channelId: 'channel-live', modelId: 'model-live',
    sourceCanvasProjectId: target.projectId, sourceCanvasId: target.canvasId,
    sourceCanvasNodeId: target.nodeId, createdAt: 1, updatedAt: 2,
  }
  let stopListener: (() => void) | undefined
  let activeRun: { sessionId: string; startedAt: number } | undefined
  let commitCount = 0
  const dependencies: CanvasAgentExecutionServiceDependencies = {
    reconcile: async () => { calls.push('reconcile'); return { document, nodeIssues: [] } },
    getSession: (sessionId) => {
      calls.push('session')
      return sessionId === session.id ? session : undefined
    },
    configs: {
      load: async () => {
        calls.push('config')
        await options.configGate
        options.afterConfig?.()
        if (options.configError) throw options.configError
        return {
          schemaVersion: 1, ...target, revision: 2, instruction: '规划短视频', skillNames: ['专业策划'],
          channelId: null, modelId: null, updatedAt: 2, ...options.config,
        }
      },
    },
    prepareStart: async (_target, effect) => {
      calls.push('prepare')
      return effect({ document: options.prepareDocument ?? document, nodeIssues: [] })
    },
    getWorkspaceSkills: () => {
      calls.push('skills')
      return options.skills ?? [{ slug: 'pro-plan', name: '专业策划', enabled: true }]
    },
    assertModelAvailable: (channelId, modelId) => {
      calls.push(`model:${channelId}/${modelId}`)
      if (options.modelError) throw options.modelError
    },
    reserveStart: () => {
      calls.push('reserve')
      if (options.reserveError) throw options.reserveError
      return () => { calls.push('release') }
    },
    createCanvasRun: (context) => {
      calls.push(`tools:${context.explicitReferences.map((reference) => reference.nodeId).join(',')}`)
      return {
        systemPromptAppend: 'tools-prompt', piCustomTools: [],
        allowedToolNames: ['canvas_read', 'canvas_run_nodes'],
        allowedToolNamesMode: 'extend', singleApprovalToolNames: ['canvas_run_nodes'],
      }
    },
    runRenderer: async (input, _sender, extensions, observer) => {
      calls.push(`renderer:${input.channelId}/${input.modelId}:${input.mentionedSkills?.join(',')}`)
      expect(extensions.allowedToolNames).toContain('canvas_run_nodes')
      if (options.stopped) stopListener?.()
      observer({
        status: options.rendererStatus ?? 'completed',
        sessionId: input.sessionId,
        startedAt: input.startedAt!,
      })
    },
    runHeadless: async (input, callbacks, extensions) => {
      calls.push(`headless:${callbacks.source}:${callbacks.originSessionId}:${input.triggeredBy}`)
      activeRun = { sessionId: input.sessionId, startedAt: input.startedAt! }
      expect(extensions?.allowedToolNames).not.toContain('canvas_run_nodes')
      if (options.stopped) stopListener?.()
      if (options.runError) callbacks.onError(options.runError)
      await options.runGate
      callbacks.onComplete()
      activeRun = undefined
    },
    subscribeStopped: (_sessionId, _startedAt, listener) => {
      calls.push('listen')
      stopListener = listener
      return () => { calls.push('unlisten'); stopListener = undefined }
    },
    outputs: {
      commit: async (input) => {
        calls.push(`commit:${input.terminalStatus}:${input.runGeneration}`)
        commitCount += 1
        if (commitCount === 1) await options.commitGate
        if (options.commitError) throw options.commitError
        return { target, revision: 8, pointer: { messageUuid: 'reply-1', contentSha256: 'a'.repeat(64), completedAt: input.completedAt }, downstreamNodeIds: [] }
      },
      releaseGeneration: (input) => { calls.push(`release-generation:${input.agentSessionId}:${input.runGeneration}`) },
    },
    stopOwnedAgent: (identity) => {
      calls.push(`stop-check:${identity.sessionId}:${identity.startedAt}`)
      if (activeRun?.sessionId !== identity.sessionId || activeRun.startedAt !== identity.startedAt) return false
      calls.push('stop')
      return true
    },
    now: () => 100,
  }
  return { service: createCanvasAgentExecutionService(dependencies), calls }
}

describe('Canvas Agent 统一执行服务', () => {
  test('Given Renderer 手动运行 When 成功完成 Then 复用可信生命周期并提交正式输出', async () => {
    const fixture = createFixture()
    await fixture.service.execute({
      mode: 'renderer-manual', target, sender: { id: 1 } as unknown as import('electron').WebContents, message: '开始',
      userMessageUuid: 'anchor-1', startedAt: 50,
    })

    expect(fixture.calls).toEqual([
      'reconcile', 'session', 'config', 'skills', 'prepare', 'session', 'model:channel-live/model-live',
      'tools:input-1', 'reserve', 'listen', 'renderer:channel-live/model-live:pro-plan',
      'commit:completed:1', 'unlisten', 'release', 'release-generation:child-1:1',
    ])
  })

  test('Given Renderer 明确错误且锚点后已有旧正文 When 运行结束 Then 不调用输出提交', async () => {
    const fixture = createFixture({ rendererStatus: 'errored' })

    await expect(fixture.service.execute({
      mode: 'renderer-manual', target, sender: { id: 1 } as unknown as import('electron').WebContents, message: '重新生成',
      userMessageUuid: 'anchor-with-old-assistant', startedAt: 51,
    })).resolves.toEqual({ status: 'errored' })

    expect(fixture.calls.some((call) => call.startsWith('commit:'))).toBe(false)
  })

  test('Given 父 Agent 编排运行 When 成功完成 Then 无需 Renderer 且使用 design 来源和父会话路由', async () => {
    const fixture = createFixture()
    await fixture.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', instruction: '生成三幕分镜',
      skillNames: ['专业策划'], userMessageUuid: 'anchor-2', startedAt: 60,
    })

    expect(fixture.calls).toContain('headless:design:parent-1:external')
    expect(fixture.calls.filter((call) => call.startsWith('commit:'))).toEqual(['commit:completed:1'])
  })

  test.each([
    ['停止', { stopped: true }],
    ['错误', { runError: '运行失败' }],
  ])('Given %s终态 When 运行结束 Then 不提交指针且始终释放监听与启动槽', async (_name, options) => {
    const fixture = createFixture(options)
    await fixture.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', instruction: '执行',
      userMessageUuid: 'anchor-3', startedAt: 70,
    })

    expect(fixture.calls.some((call) => call.startsWith('commit:'))).toBe(false)
    expect(fixture.calls.slice(-3)).toEqual(['unlisten', 'release', 'release-generation:child-1:1'])
  })

  test('Given 会话 busy When 预留失败 Then Pi 不启动且不提交输出', async () => {
    const busy = Object.assign(new Error('busy'), { code: 'AGENT_SESSION_BUSY' })
    const fixture = createFixture({ reserveError: busy })

    await expect(fixture.service.execute({
      mode: 'renderer-manual', target, sender: { id: 1 } as unknown as import('electron').WebContents, message: '开始',
      userMessageUuid: 'anchor-4', startedAt: 80,
    })).rejects.toBe(busy)
    expect(fixture.calls).not.toContain('listen')
    expect(fixture.calls.some((call) => call.startsWith('renderer:'))).toBe(false)
  })

  test('Given Skill 已禁用或显式模型不完整 When 校验运行配置 Then 在预留前 fail closed', async () => {
    const disabled = createFixture({ skills: [{ slug: 'pro-plan', name: '专业策划', enabled: false }] })
    await expect(disabled.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', instruction: '执行',
      userMessageUuid: 'anchor-5', startedAt: 90,
    })).rejects.toThrow('CANVAS_AGENT_SKILL_UNAVAILABLE')
    expect(disabled.calls).not.toContain('reserve')

    const incompleteRoute = createFixture({ config: { channelId: 'channel-fixed', modelId: null } })
    await expect(incompleteRoute.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', instruction: '执行',
      userMessageUuid: 'anchor-6', startedAt: 91,
    })).rejects.toThrow('CANVAS_AGENT_MODEL_UNAVAILABLE')
    expect(incompleteRoute.calls).not.toContain('reserve')
  })

  test.each([
    ['配置冲突', { configError: new Error('CANVAS_AGENT_CONFIG_REVISION_CONFLICT') }],
    ['模型停用', { modelError: new Error('AGENT_MODEL_DISABLED') }],
  ])('Given %s When 运行时重新校验 Then 在预留前拒绝且不更新指针', async (_name, options) => {
    const fixture = createFixture(options)
    await expect(fixture.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', instruction: '执行',
      userMessageUuid: 'anchor-invalid-config', startedAt: 91,
    })).rejects.toThrow()
    expect(fixture.calls).not.toContain('reserve')
    expect(fixture.calls.some((call) => call.startsWith('commit:'))).toBe(false)
  })

  test('Given 正式输出为空 When success 回调完成 Then 返回错误终态且不产生指针', async () => {
    const fixture = createFixture({ commitError: new Error('CANVAS_AGENT_OUTPUT_MISSING') })
    const result = await fixture.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', instruction: '执行',
      userMessageUuid: 'anchor-empty', startedAt: 92,
    })

    expect(result).toEqual({ status: 'errored' })
    expect(fixture.calls).toContain('release-generation:child-1:1')
  })

  test('Given 父运行只拥有当前 child When 取消后 child 迟到完成 Then 精确停止且不提交指针', async () => {
    /** 让 headless run 在取消后继续持有迟到完成回调。 */
    let finishRun: (() => void) | undefined
    const runGate = new Promise<void>((resolve) => { finishRun = resolve })
    const controller = new AbortController()
    const fixture = createFixture({ runGate })
    const running = fixture.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', instruction: '执行',
      userMessageUuid: 'anchor-late', startedAt: 93, signal: controller.signal,
    })
    /** 等待 child 确实进入 headless runner 后再模拟父运行取消。 */
    while (!fixture.calls.some((call) => call.startsWith('headless:'))) await Bun.sleep(0)
    controller.abort()
    finishRun?.()

    await expect(running).resolves.toEqual({ status: 'cancelled' })
    expect(fixture.calls.filter((call) => call === 'stop')).toHaveLength(1)
    expect(fixture.calls.some((call) => call.startsWith('commit:'))).toBe(false)
  })

  test('Given 父运行在 child 启动前已取消 When 执行 Then 不启动也不误停其它运行', async () => {
    const controller = new AbortController()
    controller.abort()
    const fixture = createFixture()

    await expect(fixture.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', instruction: '执行',
      userMessageUuid: 'anchor-pre-abort', startedAt: 94, signal: controller.signal,
    })).resolves.toEqual({ status: 'cancelled' })
    expect(fixture.calls.some((call) => call.startsWith('headless:'))).toBe(false)
    expect(fixture.calls).not.toContain('stop')
  })

  test('Given child 已终态且正式输出提交阻塞 When 父取消 Then 不停止会话且紧邻新运行不被预停', async () => {
    let finishCommit: (() => void) | undefined
    const commitGate = new Promise<void>((resolve) => { finishCommit = resolve })
    const controller = new AbortController()
    const first = createFixture({ commitGate })
    const running = first.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', instruction: '执行',
      userMessageUuid: 'anchor-commit-gate', startedAt: 95, signal: controller.signal,
    })
    while (!first.calls.some((call) => call.startsWith('commit:'))) await Bun.sleep(0)

    controller.abort()
    finishCommit?.()
    await running

    expect(first.calls.some((call) => call.startsWith('stop-check:'))).toBe(false)
    await expect(first.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', instruction: '继续',
      userMessageUuid: 'anchor-next', startedAt: 96,
    })).resolves.toMatchObject({ status: 'completed' })
    expect(first.calls).not.toContain('stop')
  })

  test('Given 配置读取期间 Agent 节点删除或重建 When 最终启动校验 Then 旧会话零副作用', async () => {
    for (const replacementSessionId of [undefined, 'child-2']) {
      let finishConfig: (() => void) | undefined
      const configGate = new Promise<void>((resolve) => { finishConfig = resolve })
      const changedDocument = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
      changedDocument.revision = 8
      changedDocument.nodes = replacementSessionId
        ? [{ id: target.nodeId, kind: 'agent', title: '重建导演', position: { x: 100, y: 0 }, agentSessionId: replacementSessionId }]
        : []
      const fixture = createFixture({ configGate, prepareDocument: changedDocument })
      const running = fixture.service.execute({
        mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', instruction: '执行',
        userMessageUuid: `anchor-race-${replacementSessionId ?? 'deleted'}`, startedAt: 97,
      })
      while (!fixture.calls.includes('config')) await Bun.sleep(0)
      finishConfig?.()

      await expect(running).rejects.toThrow('Canvas Agent 归属无效')
      expect(fixture.calls).not.toContain('reserve')
      expect(fixture.calls.some((call) => call.startsWith('tools:'))).toBe(false)
      expect(fixture.calls.some((call) => call.startsWith('headless:'))).toBe(false)
    }
  })
})
