import type { CanvasOrchestrationRecord, CanvasTarget } from '@proma/shared'
import type { MediaRunOrigin, MediaRunServiceDependencies } from '../media/media-run-service'
import type { CanvasToolAccessFacade } from './canvas-tool-access-facade'
import type { CanvasToolRunContext } from './canvas-tool-provider'

/** 后台媒体执行消费持久身份与实时授权，不依赖编排模型仍在运行。 */
export interface CanvasMediaActorAccessDependencies {
  getOrchestration(target: CanvasTarget): CanvasOrchestrationRecord | null
  getPermissionMode(sessionId: string): string | undefined
  access: Pick<CanvasToolAccessFacade, 'authorizeRead' | 'requireLinkedCanvas' | 'runWrite'>
}

/** 复验媒体发起者；收集既有远端产物不再启动生成，保留原服务的收集边界。 */
export function authorizeCanvasMediaActor(
  dependencies: CanvasMediaActorAccessDependencies, projectId: string,
  operation: Parameters<MediaRunServiceDependencies['authorize']>[1], origin?: MediaRunOrigin,
): void {
  const actor = origin?.actor
  if (!actor || operation === 'collect') return
  const context: CanvasToolRunContext = { projectId, sessionId: actor.sessionId, runStartedAt: actor.runStartedAt,
    explicitReferences: [], permissionCeiling: 'execute',
    ...(actor.canvasId && actor.nodeId ? {
      canvasAgentTarget: { projectId, canvasId: actor.canvasId, nodeId: actor.nodeId },
      canvasAgentMode: actor.mode === 'project-agent' ? 'renderer-manual' : actor.mode,
    } : {}) }
  if (actor.mode === 'canvas-orchestrator') {
    if (!actor.canvasId || !actor.nodeId) throw new Error('MEDIA_EXECUTION_NOT_AUTHORIZED')
    const record = dependencies.getOrchestration({ projectId, canvasId: actor.canvasId })
    /** 取消只停止已提交任务，不要求原委托仍可生成；持久 actor 身份与 owner 写权限仍须成立。 */
    const requiresActiveExecution = operation !== 'cancel'
    if (!record || record.projectId !== projectId || record.canvasId !== actor.canvasId
      || record.coordinatorNodeId !== actor.nodeId || record.coordinatorSessionId !== actor.sessionId
      || (requiresActiveExecution && (record.runStartedAt !== actor.runStartedAt
        || record.status === 'cancelled' || record.status === 'completed'
        || dependencies.getPermissionMode(record.ownerSessionId) === 'plan'))) throw new Error('MEDIA_EXECUTION_NOT_AUTHORIZED')
    /** 异步运行仍沿原普通会话的画布关联和可写授权，解绑后不外发。 */
    const owner: CanvasToolRunContext = { projectId, sessionId: record.ownerSessionId, runStartedAt: actor.runStartedAt,
      explicitReferences: [], permissionCeiling: 'execute' }
    dependencies.access.requireLinkedCanvas(owner, actor.canvasId)
    dependencies.access.runWrite(owner, () => undefined)
    context.canvasOrchestrationId = record.id
  }
  dependencies.access.authorizeRead(context)
  if (operation === 'execute' && (actor.mode === 'parent-orchestrated'
    || dependencies.getPermissionMode(actor.sessionId) === 'plan')) throw new Error('MEDIA_EXECUTION_NOT_AUTHORIZED')
}
