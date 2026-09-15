import { getCanvasOrchestrationPendingDecision } from '@proma/shared'
import type { CanvasOrchestrationRecord } from '@proma/shared'

/** 决策入口只依赖最新委托和普通聊天提交，不获得任何制作写权限。 */
export interface AgentCanvasDecisionDependencies {
  getRecord: (record: CanvasOrchestrationRecord) => Promise<CanvasOrchestrationRecord | null>
  isCurrent: (record: CanvasOrchestrationRecord) => boolean
  isDisabled: () => boolean
  send: (text: string) => Promise<boolean>
}

/** 调用者据发送结果展示等待、过期或可重试错误。 */
export type AgentCanvasDecisionOutcome = 'sent' | 'busy' | 'stale' | 'unavailable'

/** 以稳定委托和问题身份防止连续点击重复提交；每个会话视图持有一个实例。 */
export function createAgentCanvasDecisionSender(dependencies: AgentCanvasDecisionDependencies) {
  /** 同步占位覆盖 React 尚未重绘的点击间隙。 */
  let busy = false
  /** 有界记录已被聊天接管的答案，等待编排事件撤下原问题。 */
  const submitted = new Set<string>()
  /** 同一画布可产生新的委托与问题，三种身份必须同时匹配。 */
  const identity = (record: CanvasOrchestrationRecord): string => JSON.stringify([
    record.canvasId, record.id, getCanvasOrchestrationPendingDecision(record)?.id,
  ])
  return {
    hasSubmitted: (record: CanvasOrchestrationRecord): boolean => submitted.has(identity(record)),
    /** 验证用户看到的原问题仍有效，再把自然语言答复送入聊天。 */
    async choose(record: CanvasOrchestrationRecord, optionId: string, canvasTitle: string): Promise<AgentCanvasDecisionOutcome> {
      if (busy || dependencies.isDisabled() || submitted.has(identity(record))) return 'busy'
      /** 保留问题及选项完整快照，不能按选项下标回答更新后的问题。 */
      const decision = getCanvasOrchestrationPendingDecision(record)
      const option = decision?.options.find(candidate => candidate.id === optionId)
      if (!decision || !option || !dependencies.isCurrent(record)) return 'stale'
      busy = true
      try {
        const latest = await dependencies.getRecord(record)
        if (!latest || latest.projectId !== record.projectId || latest.canvasId !== record.canvasId
          || latest.id !== record.id || latest.ownerSessionId !== record.ownerSessionId
          || !dependencies.isCurrent(record)
          || JSON.stringify(getCanvasOrchestrationPendingDecision(latest)) !== JSON.stringify(decision)) return 'stale'
        if (dependencies.isDisabled()) return 'busy'
        // 内部 ID 留在工具协议中；用户消息保留画布、任务、原问题与明确选择。
        // 任务目标可能是长篇需求，只引用短标题；问题和用户选择保持完整，答复不超过 followUp 上限。
        const goalLabel = record.request.goal.length > 160 ? `${record.request.goal.slice(0, 160)}…` : record.request.goal
        const text = `关于画布“${canvasTitle.slice(0, 120)}”的任务“${goalLabel}”：针对“${decision.question}”，我选择“${option.label}”。请先核对当前委托与问题，再按此答复继续原任务。`
        if (!await dependencies.send(text)) return 'unavailable'
        submitted.add(identity(record))
        if (submitted.size > 32) submitted.delete(submitted.values().next().value!)
        return 'sent'
      } finally { busy = false }
    },
  }
}
