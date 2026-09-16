import type { CanvasToolAccessFacade } from './canvas-tool-access-facade'
import type { CanvasToolRunContext } from './canvas-tool-provider'

/**
 * 在运行准备阶段固定本轮隐式画布上下文，之后界面跳转不能重新选择目标。
 * @param access 主进程唯一授权 facade，读取失败只取消隐式目标，不放宽后续工具权限。
 * @param context 已解析引用和运行身份，内部 Agent 自身目标优先。
 * @returns 带 Host 初始目标的运行上下文；多画布歧义或无权限时目标为 null。
 */
export function captureCanvasToolInitialContext(
  access: Pick<CanvasToolAccessFacade, 'authorizeRead' | 'getBinding' | 'requireLinkedCanvas'>,
  context: CanvasToolRunContext,
): CanvasToolRunContext {
  if (context.initialCanvasId !== undefined) return context
  try {
    access.authorizeRead(context)
    if (context.canvasAgentTarget) return { ...context, initialCanvasId: context.canvasAgentTarget.canvasId }
    const binding = access.getBinding(context)
    /** 同一画布多个节点引用仍只有一个明确目标，多图引用不能偷偷任选一个。 */
    const referencedCanvasIds = [...new Set(context.explicitReferences.map(reference => reference.canvasId))]
    const canvasId = referencedCanvasIds.length > 1 ? null
      : referencedCanvasIds[0] ?? binding?.lastActiveCanvasId ?? binding?.defaultCanvasId ?? null
    if (!canvasId || !binding?.linkedCanvasIds.includes(canvasId)) return { ...context, initialCanvasId: null }
    access.requireLinkedCanvas(context, canvasId)
    return { ...context, initialCanvasId: canvasId }
  } catch {
    /** 普通聊天不因画布上下文不可用而中断；任何后续工具仍须重新授权和明确目标。 */
    return { ...context, initialCanvasId: null }
  }
}
