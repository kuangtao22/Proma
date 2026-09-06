import { describe, expect, test } from 'bun:test'
import { createCanvasBoundEdge, createEmptyCanvasDocument } from '@proma/shared'
import type { AgentSessionMeta, CanvasDocument, SkillMeta } from '@proma/shared'
import type { AgentRunExtensions } from '../agent-run-extensions'
import type { CanvasAgentConfig } from './canvas-agent-config-store'
import type { CanvasToolRun, CanvasToolRunContext } from './canvas-tool-provider'
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
  headlessResultSubtype?: string
  canvasRun?: CanvasToolRun
  inspectHeadlessExtensions?: (extensions: AgentRunExtensions | undefined) => void
  parentAccessError?: Error
  inspectRunOutsidePrepare?: (prepareHeld: boolean) => void
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
  let prepareHeld = false
  /** 记录每轮工具上下文，验证交互窗口身份不会泄漏到后台运行。 */
  const runContexts: CanvasToolRunContext[] = []
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
      prepareHeld = true
      try {
        return effect({ document: options.prepareDocument ?? document, nodeIssues: [] })
      } finally {
        prepareHeld = false
      }
    },
    validateParentAccess: () => {
      calls.push('parent-access')
      if (options.parentAccessError) throw options.parentAccessError
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
      runContexts.push(context)
      calls.push(`tools:${context.canvasAgentMode}:${context.explicitReferences.map((reference) => reference.nodeId).join(',')}`)
      return options.canvasRun ?? {
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
      options.inspectRunOutsidePrepare?.(prepareHeld)
      activeRun = { sessionId: input.sessionId, startedAt: input.startedAt! }
      options.inspectHeadlessExtensions?.(extensions)
      expect(extensions?.allowedToolNames).not.toContain('canvas_run_nodes')
      if (options.runError) callbacks.onError(options.runError)
      await options.runGate
      callbacks.onComplete(undefined, {
        status: options.stopped ? 'cancelled' : options.runError || options.headlessResultSubtype !== undefined ? 'errored' : 'completed',
        stoppedByUser: options.stopped === true,
        startedAt: input.startedAt!,
        runGeneration: 3,
        ...(options.headlessResultSubtype !== undefined ? { resultSubtype: options.headlessResultSubtype } : {}),
      })
      /** 复现生产顺序：headless onComplete 先于 run_stopped 事件。 */
      if (options.stopped) stopListener?.()
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
  return { service: createCanvasAgentExecutionService(dependencies), calls, runContexts }
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
      'tools:renderer-manual:input-1', 'reserve', 'listen', 'renderer:channel-live/model-live:pro-plan',
      'commit:completed:1', 'unlisten', 'release', 'release-generation:child-1:1',
    ])
    expect(fixture.runContexts[0]?.dialogOwnerWebContentsId).toBe(1)
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
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7, instruction: '生成三幕分镜',
      skillNames: ['专业策划'], userMessageUuid: 'anchor-2', startedAt: 60,
    })

    expect(fixture.calls).toContain('headless:design:parent-1:external')
    expect(fixture.calls).toContain('tools:parent-orchestrated:input-1')
    expect(fixture.calls.filter((call) => call.startsWith('commit:'))).toEqual(['commit:completed:1'])
    expect(fixture.runContexts[0]?.dialogOwnerWebContentsId).toBeUndefined()
  })

  test('Given 父 Agent 初检后图 revision 已变化 When 最终启动 Then 在 reserve 前拒绝且不运行模型', async () => {
    const changedDocument = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
    changedDocument.revision = 8
    changedDocument.nodes = [{
      id: target.nodeId, kind: 'agent', title: '视频导演', position: { x: 100, y: 0 },
      agentSessionId: 'child-1',
    }]
    const fixture = createFixture({ prepareDocument: changedDocument })

    await expect(fixture.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7,
      instruction: '执行', userMessageUuid: 'anchor-revision-race', startedAt: 60,
    })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
    expect(fixture.calls).not.toContain('reserve')
    expect(fixture.calls.some((call) => call.startsWith('headless:'))).toBe(false)
  })

  test('Given 父 Agent 初检后已解绑 When 最终启动 Then 临界区复核父权限且模型运行不持锁', async () => {
    const denied = createFixture({ parentAccessError: new Error('CANVAS_ACCESS_DENIED') })
    await expect(denied.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7,
      instruction: '执行', userMessageUuid: 'anchor-binding-race', startedAt: 60,
    })).rejects.toThrow('CANVAS_ACCESS_DENIED')
    expect(denied.calls).not.toContain('reserve')
    expect(denied.calls.some((call) => call.startsWith('headless:'))).toBe(false)

    let observedPrepareHeld = true
    const allowed = createFixture({
      inspectRunOutsidePrepare: (prepareHeld) => { observedPrepareHeld = prepareHeld },
    })
    await allowed.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7,
      instruction: '执行', userMessageUuid: 'anchor-no-long-lock', startedAt: 61,
    })
    expect(observedPrepareHeld).toBe(false)
  })

  test('Given Provider 新增未知 Canvas 工具 When 父 Agent 编排运行 Then 三个工具入口默认拒绝未知项', async () => {
    /** 当前父编排明确允许的已知工具。 */
    const knownTool = { name: 'canvas_update_artifact' } as unknown as CanvasToolRun['piCustomTools'][number]
    /** 模拟 Provider 未来新增但尚未进入父编排许可合同的工具。 */
    const unknownTool = { name: 'canvas_future_tool' } as unknown as CanvasToolRun['piCustomTools'][number]
    /** 证明测试实际观察到传入 headless runner 的最终扩展。 */
    let inspected = false
    const fixture = createFixture({
      canvasRun: {
        systemPromptAppend: 'tools-prompt',
        piCustomTools: [knownTool, unknownTool],
        allowedToolNames: [knownTool.name, unknownTool.name],
        allowedToolNamesMode: 'extend',
        singleApprovalToolNames: [knownTool.name, unknownTool.name],
      },
      inspectHeadlessExtensions: (extensions) => {
        inspected = true
        expect(extensions?.allowedToolNames).toContain(knownTool.name)
        expect(extensions?.allowedToolNames).not.toContain(unknownTool.name)
        expect(extensions?.piCustomTools?.map((tool) => tool.name)).toEqual([knownTool.name])
        expect(extensions?.singleApprovalToolNames).toEqual([knownTool.name])
      },
    })

    await fixture.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7, instruction: '生成方案',
      userMessageUuid: 'anchor-future-tool', startedAt: 61,
    })

    expect(inspected).toBe(true)
  })

  test.each([
    ['停止', { stopped: true }],
    ['错误', { runError: '运行失败' }],
  ])('Given %s终态 When 运行结束 Then 不提交指针且始终释放监听与启动槽', async (_name, options) => {
    const fixture = createFixture(options)
    await fixture.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7, instruction: '执行',
      userMessageUuid: 'anchor-3', startedAt: 70,
    })

    expect(fixture.calls.some((call) => call.startsWith('commit:'))).toBe(false)
    expect(fixture.calls.slice(-3)).toEqual(['unlisten', 'release', 'release-generation:child-1:1'])
  })

  test('Given Headless 非 success subtype 且锚点后已有正文 When onComplete Then 不提交旧或部分输出', async () => {
    const fixture = createFixture({ headlessResultSubtype: 'error_during_execution' })

    await expect(fixture.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7, instruction: '执行',
      userMessageUuid: 'anchor-partial', startedAt: 71,
    })).resolves.toEqual({ status: 'errored' })
    expect(fixture.calls.some((call) => call.startsWith('commit:'))).toBe(false)
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
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7, instruction: '执行',
      userMessageUuid: 'anchor-5', startedAt: 90,
    })).rejects.toThrow('CANVAS_AGENT_SKILL_UNAVAILABLE')
    expect(disabled.calls).not.toContain('reserve')

    const incompleteRoute = createFixture({ config: { channelId: 'channel-fixed', modelId: null } })
    await expect(incompleteRoute.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7, instruction: '执行',
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
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7, instruction: '执行',
      userMessageUuid: 'anchor-invalid-config', startedAt: 91,
    })).rejects.toThrow()
    expect(fixture.calls).not.toContain('reserve')
    expect(fixture.calls.some((call) => call.startsWith('commit:'))).toBe(false)
  })

  test('Given 正式输出为空 When success 回调完成 Then 返回错误终态且不产生指针', async () => {
    const fixture = createFixture({ commitError: new Error('CANVAS_AGENT_OUTPUT_MISSING') })
    const result = await fixture.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7, instruction: '执行',
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
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7, instruction: '执行',
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
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7, instruction: '执行',
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
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7, instruction: '执行',
      userMessageUuid: 'anchor-commit-gate', startedAt: 95, signal: controller.signal,
    })
    while (!first.calls.some((call) => call.startsWith('commit:'))) await Bun.sleep(0)

    controller.abort()
    finishCommit?.()
    await running

    expect(first.calls.some((call) => call.startsWith('stop-check:'))).toBe(false)
    await expect(first.service.execute({
      mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 7, instruction: '继续',
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
        mode: 'parent-orchestrated', target, parentSessionId: 'parent-1', expectedGraphRevision: 8, instruction: '执行',
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
