import type {
  AgentCanvasBinding,
  AgentCanvasBindingChangeEvent,
  AgentSessionMeta,
  CanvasSessionChangeEvent,
  CanvasSessionMeta,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
} from '@proma/shared'
import { isEligibleProjectAgent } from '../agent-session-visibility'
import type { AgentCanvasBindingMutationResult } from './agent-canvas-binding-store'
import {
  createCanvasNodeReferenceResolver,
  type CanvasNodeReferenceResolver,
} from './canvas-node-reference-resolver'
import type { CreateCanvasSessionWithIdResult } from './canvas-session-store'
import type { CanvasToolRunContext } from './canvas-tool-provider'

/** Canvas 工具与引用解析共同消费的唯一生产授权 facade。 */
export interface CanvasToolAccessFacade {
  referenceResolver: CanvasNodeReferenceResolver
  authorizeRead: (context: CanvasToolRunContext) => void
  getBinding: (context: CanvasToolRunContext) => AgentCanvasBinding | null
  requireLinkedCanvas: (context: CanvasToolRunContext, canvasId: string) => AgentCanvasBinding
  runWrite: <T>(context: CanvasToolRunContext, effect: () => T) => T
  createAndLink: (
    context: CanvasToolRunContext,
    input: { canvasId: string; title?: string; makeDefault: boolean },
  ) => { session: CanvasSessionMeta; binding: AgentCanvasBinding }
  link: (context: CanvasToolRunContext, canvasId: string, makeDefault: boolean) => AgentCanvasBinding
  unlink: (context: CanvasToolRunContext, canvasId: string) => AgentCanvasBinding | null
  setDefault: (context: CanvasToolRunContext, canvasId: string) => AgentCanvasBinding
}

/** Facade 只持有 main/ipc.ts 注入的唯一 Store、守卫与广播边界。 */
export interface CanvasToolAccessFacadeDependencies {
  getAgentSession: (sessionId: string) => AgentSessionMeta | null | undefined
  assertProjectAuthorized: (projectId: string) => void
  getProjectReadOnlyReason: (projectId: string) => string | undefined
  runProjectMutation: <T>(projectId: string, effect: () => T) => T
  sessions: {
    list: (input: { projectId: string; archived?: boolean }) => CanvasSessionMeta[]
    requireNative: (projectId: string, canvasId: string) => CanvasSessionMeta
    createWithIdOnce: (input: {
      projectId: string
      canvasId: string
      title?: string
    }) => CreateCanvasSessionWithIdResult
  }
  bindings: {
    get: (projectId: string, sessionId: string) => AgentCanvasBinding | null
    linkWithChange: (input: {
      projectId: string
      sessionId: string
      canvasId: string
      makeDefault: boolean
    }) => AgentCanvasBindingMutationResult
    unlinkWithChange: (input: {
      projectId: string
      sessionId: string
      canvasId: string
    }) => AgentCanvasBindingMutationResult
    setDefaultWithChange: (input: {
      projectId: string
      sessionId: string
      canvasId: string
    }) => AgentCanvasBindingMutationResult
  }
  loadCanvas: (target: CanvasTarget) => CanvasWorkspaceSnapshot
  broadcastSession: (event: CanvasSessionChangeEvent) => void
  broadcastBinding: (event: AgentCanvasBindingChangeEvent) => void
}

/** 要求当前会话仍是目标项目的普通顶层 Agent，并复核项目授权。 */
function requireAuthorizedAgent(
  dependencies: CanvasToolAccessFacadeDependencies,
  context: CanvasToolRunContext,
): AgentSessionMeta {
  /** 每次执行都 fresh-read，撤权或身份漂移立即 fail closed。 */
  const session = dependencies.getAgentSession(context.sessionId)
  if (!session
    || session.workspaceId !== context.projectId
    || !isEligibleProjectAgent(session, context.projectId)) {
    throw new Error('CANVAS_AGENT_ACCESS_DENIED')
  }
  dependencies.assertProjectAuthorized(context.projectId)
  return session
}

/** 创建复用生产唯一 Store、守卫、序列化器和广播边界的 Canvas 工具 facade。 */
export function createCanvasToolAccessFacade(
  dependencies: CanvasToolAccessFacadeDependencies,
): CanvasToolAccessFacade {
  /** 引用解析与工具共享同一组 fresh 授权事实，禁止再构造独立 Store。 */
  const referenceResolver = createCanvasNodeReferenceResolver({
    getSession: (sessionId) => {
      /** 引用发送没有预构造 context，仍按会话当前项目复核授权。 */
      const session = dependencies.getAgentSession(sessionId) ?? undefined
      if (session?.workspaceId) dependencies.assertProjectAuthorized(session.workspaceId)
      return session
    },
    getBinding: (projectId, sessionId) => dependencies.bindings.get(projectId, sessionId),
    requireCanvas: (projectId, canvasId) => dependencies.sessions.requireNative(projectId, canvasId),
    loadCanvas: dependencies.loadCanvas,
  })

  /** 写操作在进入守卫前和守卫内各做一次 fresh 准入复核。 */
  const runWrite = <T>(
    context: CanvasToolRunContext,
    effect: () => T,
  ): T => {
    requireAuthorizedAgent(dependencies, context)
    const reason = dependencies.getProjectReadOnlyReason(context.projectId)
    if (reason) throw new Error(reason)
    return dependencies.runProjectMutation(context.projectId, () => {
      requireAuthorizedAgent(dependencies, context)
      const guardedReason = dependencies.getProjectReadOnlyReason(context.projectId)
      if (guardedReason) throw new Error(guardedReason)
      return effect()
    })
  }

  /** 广播单次已提交的关联变化，no-op 重放保持零事件。 */
  const publishBinding = (
    context: CanvasToolRunContext,
    cause: AgentCanvasBindingChangeEvent['cause'],
    mutation: AgentCanvasBindingMutationResult,
  ): void => {
    if (!mutation.changed) return
    dependencies.broadcastBinding({
      projectId: context.projectId,
      sessionId: context.sessionId,
      cause,
      binding: mutation.after,
    })
  }

  return {
    referenceResolver,
    authorizeRead: (context) => { requireAuthorizedAgent(dependencies, context) },
    getBinding: (context) => {
      requireAuthorizedAgent(dependencies, context)
      return dependencies.bindings.get(context.projectId, context.sessionId)
    },
    requireLinkedCanvas: (context, canvasId) => {
      requireAuthorizedAgent(dependencies, context)
      const binding = dependencies.bindings.get(context.projectId, context.sessionId)
      if (!binding?.linkedCanvasIds.includes(canvasId)) throw new Error('CANVAS_ACCESS_DENIED')
      dependencies.sessions.requireNative(context.projectId, canvasId)
      return binding
    },
    runWrite,
    createAndLink: (context, input) => runWrite(context, () => {
      const created = dependencies.sessions.createWithIdOnce({
        projectId: context.projectId,
        canvasId: input.canvasId,
        ...(input.title === undefined ? {} : { title: input.title }),
      })
      if (created.created) {
        dependencies.broadcastSession({
          projectId: context.projectId,
          canvasId: created.session.id,
          cause: 'created',
        })
      }
      const mutation = dependencies.bindings.linkWithChange({
        projectId: context.projectId,
        sessionId: context.sessionId,
        canvasId: created.session.id,
        makeDefault: input.makeDefault,
      })
      publishBinding(context, 'linked', mutation)
      if (!mutation.after) throw new Error('CANVAS_BINDING_CREATE_FAILED')
      return { session: created.session, binding: mutation.after }
    }),
    link: (context, canvasId, makeDefault) => runWrite(context, () => {
      dependencies.sessions.requireNative(context.projectId, canvasId)
      const mutation = dependencies.bindings.linkWithChange({
        projectId: context.projectId,
        sessionId: context.sessionId,
        canvasId,
        makeDefault,
      })
      publishBinding(context, 'linked', mutation)
      if (!mutation.after) throw new Error('CANVAS_BINDING_CREATE_FAILED')
      return mutation.after
    }),
    unlink: (context, canvasId) => runWrite(context, () => {
      dependencies.sessions.requireNative(context.projectId, canvasId)
      const mutation = dependencies.bindings.unlinkWithChange({
        projectId: context.projectId,
        sessionId: context.sessionId,
        canvasId,
      })
      publishBinding(context, 'unlinked', mutation)
      return mutation.after
    }),
    setDefault: (context, canvasId) => runWrite(context, () => {
      dependencies.sessions.requireNative(context.projectId, canvasId)
      const mutation = dependencies.bindings.setDefaultWithChange({
        projectId: context.projectId,
        sessionId: context.sessionId,
        canvasId,
      })
      publishBinding(context, 'default-changed', mutation)
      if (!mutation.after) throw new Error('CANVAS_BINDING_NOT_FOUND')
      return mutation.after
    }),
  }
}
