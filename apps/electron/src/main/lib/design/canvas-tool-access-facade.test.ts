import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, CanvasSessionMeta } from '@proma/shared'
import { createEmptyCanvasDocument } from '@proma/shared'
import { createCanvasToolAccessFacade } from './canvas-tool-access-facade'
import type { CanvasToolRunContext } from './canvas-tool-provider'

const context: CanvasToolRunContext = {
  projectId: 'project-1', sessionId: 'agent-1', runStartedAt: 10,
  explicitReferences: [], permissionCeiling: 'execute',
}

/** 创建仍属于目标项目的普通顶层 Agent。 */
function createAgent(): AgentSessionMeta {
  return {
    id: 'agent-1', title: 'Agent', workspaceId: 'project-1', archived: false,
    createdAt: 1, updatedAt: 1,
  }
}

/** 创建完整归属于固定 Canvas 节点的内部 Agent。 */
function createCanvasAgent(): AgentSessionMeta {
  return {
    id: 'canvas-agent-1', title: '分镜 Agent', workspaceId: 'project-1', archived: false,
    sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1',
    createdAt: 1, updatedAt: 2,
  }
}

describe('Canvas Tool 唯一授权 facade', () => {
  test('Given Canvas Agent 拥有完整节点归属 When 访问工具 facade Then 仅可读写自身画布且不能管理关联', () => {
    const session: CanvasSessionMeta = {
      id: 'canvas-1', projectId: 'project-1', title: '画布', archived: false,
      createdAt: 1, updatedAt: 1,
    }
    let guardCalls = 0
    const canvasAgentContext = {
      projectId: 'project-1', sessionId: 'canvas-agent-1', runStartedAt: 10,
      explicitReferences: [], permissionCeiling: 'execute' as const,
      canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1' },
    }
    const facade = createCanvasToolAccessFacade({
      getAgentSession: () => createCanvasAgent(),
      assertProjectAuthorized: () => undefined,
      getProjectReadOnlyReason: () => undefined,
      runProjectMutation: (_projectId, effect) => { guardCalls += 1; return effect() },
      sessions: {
        list: () => [session],
        requireNative: (_projectId, canvasId) => {
          if (canvasId !== session.id) throw new Error('CANVAS_NOT_FOUND')
          return session
        },
        createWithIdOnce: () => { throw new Error('STORE_MUST_NOT_WRITE') },
      },
      bindings: {
        get: () => { throw new Error('CANVAS_AGENT_MUST_NOT_READ_BINDINGS') },
        linkWithChange: () => { throw new Error('STORE_MUST_NOT_WRITE') },
        unlinkWithChange: () => { throw new Error('STORE_MUST_NOT_WRITE') },
        setDefaultWithChange: () => { throw new Error('STORE_MUST_NOT_WRITE') },
      },
      loadCanvas: (target) => ({ document: createEmptyCanvasDocument(target.projectId, target.canvasId, 1), writable: true, nodeIssues: [] }),
      broadcastSession: () => undefined,
      broadcastBinding: () => undefined,
    })

    expect(facade.getBinding(canvasAgentContext)).toEqual({
      projectId: 'project-1', sessionId: 'canvas-agent-1', linkedCanvasIds: ['canvas-1'],
      defaultCanvasId: 'canvas-1', lastActiveCanvasId: 'canvas-1', updatedAt: 2,
    })
    expect(facade.requireLinkedCanvas(canvasAgentContext, 'canvas-1')).toMatchObject({
      linkedCanvasIds: ['canvas-1'],
    })
    expect(() => facade.requireLinkedCanvas(canvasAgentContext, 'canvas-2')).toThrow('CANVAS_ACCESS_DENIED')
    expect(facade.runWrite(canvasAgentContext, () => 'written')).toBe('written')
    expect(guardCalls).toBe(1)
    expect(() => facade.createAndLink(canvasAgentContext, {
      canvasId: 'canvas-2', makeDefault: true,
    })).toThrow('CANVAS_AGENT_CANVAS_SCOPE_FIXED')
  })

  test('Given 项目只读或 Agent 撤权 When 读写 facade Then 读保持可用且写与撤权均在 Store 前拒绝', () => {
    const session: CanvasSessionMeta = {
      id: 'canvas-1', projectId: 'project-1', title: '画布', archived: false,
      createdAt: 1, updatedAt: 1,
    }
    let agent: AgentSessionMeta | undefined = createAgent()
    let bindingReads = 0
    let guardCalls = 0
    const binding = {
      projectId: 'project-1', sessionId: 'agent-1', linkedCanvasIds: ['canvas-1'],
      defaultCanvasId: 'canvas-1', lastActiveCanvasId: 'canvas-1', updatedAt: 1,
    }
    const facade = createCanvasToolAccessFacade({
      getAgentSession: () => agent,
      assertProjectAuthorized: () => undefined,
      getProjectReadOnlyReason: () => '项目只读',
      runProjectMutation: (_projectId, effect) => { guardCalls += 1; return effect() },
      sessions: {
        list: () => [session],
        requireNative: () => session,
        createWithIdOnce: () => ({ session, created: false }),
      },
      bindings: {
        get: () => { bindingReads += 1; return binding },
        linkWithChange: () => { throw new Error('STORE_MUST_NOT_WRITE') },
        unlinkWithChange: () => { throw new Error('STORE_MUST_NOT_WRITE') },
        setDefaultWithChange: () => { throw new Error('STORE_MUST_NOT_WRITE') },
      },
      loadCanvas: (target) => ({ document: createEmptyCanvasDocument(target.projectId, target.canvasId, 1), writable: true, nodeIssues: [] }),
      broadcastSession: () => undefined,
      broadcastBinding: () => undefined,
    })

    expect(facade.getBinding(context)).toEqual(binding)
    expect(facade.requireLinkedCanvas(context, 'canvas-1')).toEqual(binding)
    expect(() => facade.runWrite(context, () => undefined)).toThrow('项目只读')
    expect(guardCalls).toBe(0)

    agent = undefined
    expect(() => facade.getBinding(context)).toThrow('CANVAS_AGENT_ACCESS_DENIED')
    expect(bindingReads).toBe(2)
  })

  test('Given 普通 Agent 同时关联原生与 legacy 画布 When 发送原生节点引用 Then legacy 只参与标题摘要且不阻断发送', () => {
    /** 被引用的原生画布允许加载节点文档。 */
    const nativeSession: CanvasSessionMeta = {
      id: 'canvas-1', projectId: 'project-1', title: '原生画布', archived: false,
      createdAt: 1, updatedAt: 2,
    }
    /** legacy 画布只提供已登记的公开元数据，不能冒充原生文档。 */
    const legacySession: CanvasSessionMeta = {
      id: 'legacy-design', projectId: 'project-1', title: '默认设计画布', archived: false,
      createdAt: 1, updatedAt: 1,
    }
    /** 当前普通 Agent 的完整混合关联。 */
    const binding = {
      projectId: 'project-1', sessionId: 'agent-1',
      linkedCanvasIds: ['canvas-1', 'legacy-design'],
      defaultCanvasId: 'canvas-1', lastActiveCanvasId: 'canvas-1', updatedAt: 3,
    }
    let nativeRequireCalls = 0
    const facade = createCanvasToolAccessFacade({
      getAgentSession: () => createAgent(),
      assertProjectAuthorized: () => undefined,
      getProjectReadOnlyReason: () => undefined,
      runProjectMutation: (_projectId, effect) => effect(),
      sessions: {
        list: () => [nativeSession, legacySession],
        requireNative: (_projectId, canvasId) => {
          nativeRequireCalls += 1
          if (canvasId !== nativeSession.id) throw new Error('Canvas 会话不存在')
          return nativeSession
        },
        createWithIdOnce: () => { throw new Error('STORE_MUST_NOT_WRITE') },
      },
      bindings: {
        get: () => binding,
        linkWithChange: () => { throw new Error('STORE_MUST_NOT_WRITE') },
        unlinkWithChange: () => { throw new Error('STORE_MUST_NOT_WRITE') },
        setDefaultWithChange: () => { throw new Error('STORE_MUST_NOT_WRITE') },
      },
      loadCanvas: (target) => ({
        document: {
          ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1),
          revision: 4,
          nodes: [{
            id: 'node-1', kind: 'document', title: '分镜文档', position: { x: 0, y: 0 },
            documentId: 'document-1', contentRevision: 2,
          }],
        },
        writable: true,
        nodeIssues: [],
      }),
      broadcastSession: () => undefined,
      broadcastBinding: () => undefined,
    })

    const result = facade.referenceResolver.resolveForSend({
      sessionId: 'agent-1',
      mode: 'latest',
      references: [{
        projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
        nodeType: 'document', nodeRevision: 3, title: '旧标题',
      }],
    })

    expect(result.references[0]).toMatchObject({ nodeId: 'node-1', nodeRevision: 4 })
    expect(JSON.parse(result.promptSummary).linkedCanvases).toEqual(['原生画布', '默认设计画布'])
    expect(nativeRequireCalls).toBe(0)
  })

  test('Given 同一确定性 Canvas 创建重放 When 经唯一 Store 与 guard Then 事件只按 session->binding 发布一次', () => {
    const events: string[] = []
    const linkedCanvasIds: string[] = []
    let created = false
    const session: CanvasSessionMeta = {
      id: 'agent-canvas-1', projectId: 'project-1', title: 'Agent 画布', archived: false,
      createdAt: 1, updatedAt: 1,
    }
    const facade = createCanvasToolAccessFacade({
      getAgentSession: () => createAgent(),
      assertProjectAuthorized: () => undefined,
      getProjectReadOnlyReason: () => undefined,
      runProjectMutation: (_projectId, effect) => { events.push('guard'); return effect() },
      sessions: {
        list: () => [session],
        requireNative: () => session,
        createWithIdOnce: () => {
          const result = { session, created: !created }
          created = true
          return result
        },
      },
      bindings: {
        get: () => linkedCanvasIds.length === 0 ? null : ({
          projectId: 'project-1', sessionId: 'agent-1', linkedCanvasIds: [...linkedCanvasIds],
          defaultCanvasId: 'agent-canvas-1', lastActiveCanvasId: 'agent-canvas-1', updatedAt: 1,
        }),
        linkWithChange: () => {
          const changed = linkedCanvasIds.length === 0
          if (changed) linkedCanvasIds.push('agent-canvas-1')
          const after = {
            projectId: 'project-1', sessionId: 'agent-1', linkedCanvasIds: [...linkedCanvasIds],
            defaultCanvasId: 'agent-canvas-1', lastActiveCanvasId: 'agent-canvas-1', updatedAt: 1,
          }
          return { before: null, after, changed }
        },
        unlinkWithChange: () => ({ before: null, after: null, changed: false }),
        setDefaultWithChange: () => { throw new Error('unused') },
      },
      loadCanvas: (target) => ({ document: createEmptyCanvasDocument(target.projectId, target.canvasId, 1), writable: true, nodeIssues: [] }),
      broadcastSession: () => { events.push('session-created') },
      broadcastBinding: () => { events.push('binding-linked') },
    })

    facade.createAndLink(context, { canvasId: session.id, title: session.title, makeDefault: true })
    facade.createAndLink(context, { canvasId: session.id, title: session.title, makeDefault: true })

    expect(events).toEqual([
      'guard', 'session-created', 'binding-linked',
      'guard',
    ])
  })
})
