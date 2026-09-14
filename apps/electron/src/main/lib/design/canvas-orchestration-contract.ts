import type { CanvasOrchestrationRecord } from '@proma/shared'
import { createHash } from 'node:crypto'
import type { CanvasTaskRequirement, CanvasTaskState } from './canvas-task-contract'

/** 将委托的不可变交付映射到现有验收合同；专业计划不能降低最终交付类型。 */
export function canvasOrchestrationRequirements(record: CanvasOrchestrationRecord): CanvasTaskRequirement[] {
  /** 设计委托只准备媒体配置，实际生产须由 produce/revise 明确授权。 */
  const production = record.request.intent === 'produce' || record.request.intent === 'revise'
  return record.request.deliverables.flatMap((deliverable, index): CanvasTaskRequirement[] => {
    /** 使用稳定的合同 ID，兼容旧合同的 64 字符上限。 */
    /** 长标准保留完整摘要指纹与原委托索引，不能静默截掉尾部条件。 */
    const criteria = deliverable.criteria.join('\n')
    const description = `${deliverable.title}\n${criteria}`.length <= 1024
      ? `${deliverable.title}${criteria ? `\n${criteria}` : ''}`
      : `${deliverable.title}\n完整验收标准见原委托 deliverables[${index}]；sha256=${createHash('sha256').update(JSON.stringify(deliverable.criteria)).digest('hex')}`
    const base = { id: `deliverable-${index + 1}`, description,
      nodeKind: deliverable.kind, change: 'created' as const }
    if (deliverable.kind === 'document' || deliverable.kind === 'webview' || deliverable.kind === 'agent') {
      return [{ ...base, validation: 'content' }]
    }
    if (!production) return [{ ...base, validation: 'configuration' }]
    if (deliverable.kind === 'image') return [{ ...base, validation: 'adopted' },
      { ...base, id: `${base.id}-inspection`, validation: 'inspection' }]
    return [{ ...base, validation: 'adopted', mediaReview: { stage: 'final', contentCoverage: 'full' } }]
  })
}

/** 完成必须来自同一委托合同；模型可追加检查，但不能省略或改变 Host 的原始要求。 */
export function assertCanvasOrchestrationRequirements(record: CanvasOrchestrationRecord, requirements: CanvasTaskRequirement[]): void {
  for (const required of canvasOrchestrationRequirements(record)) {
    /** 精确比较受保护字段，nodeId/change 可由执行者进一步收紧。 */
    const actual = requirements.find(item => item.id === required.id)
    if (!actual || actual.description !== required.description || actual.nodeKind !== required.nodeKind
      || actual.validation !== required.validation
      || (required.mediaReview && (!actual.mediaReview
        || actual.mediaReview.stage !== required.mediaReview.stage
        || actual.mediaReview.contentCoverage !== required.mediaReview.contentCoverage))) {
      throw new Error('CANVAS_ORCHESTRATION_REQUIREMENTS_IMMUTABLE')
    }
  }
}

/** 持久交付记录必须与委托、画布和完整要求对应，不能复用上一任务的 completed。 */
export function isCanvasOrchestrationContractComplete(record: CanvasOrchestrationRecord, state: CanvasTaskState): boolean {
  if (state.taskId !== record.id || state.canvasId !== record.canvasId || state.phase !== 'completed') return false
  try { assertCanvasOrchestrationRequirements(record, state.requirements); return true } catch { return false }
}
