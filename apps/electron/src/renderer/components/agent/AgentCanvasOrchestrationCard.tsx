import * as React from 'react'
import type { CanvasOrchestrationProgress, CanvasOrchestrationRecord } from '@proma/shared'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

/** 阶段标签沿用画布业务状态，不把素材生成与专业评审混在一起。 */
const STATUS_LABELS = {
  planned: '待开始', running: '运行中', 'needs-review': '待评审', completed: '已完成', blocked: '已阻塞',
}
/** 编排终态使用业务语言，避免用户把取消或阻塞误认为仍在执行。 */
const RECORD_STATUS_LABELS: Record<CanvasOrchestrationRecord['status'], string> = {
  planning: '规划中', running: '进行中', waiting: '等待中', blocked: '已阻塞', completed: '已完成', cancelled: '已取消',
}

/** 卡片仅展示与回传选择，权限、最新问题及防重复检查由父级发送入口负责。 */
export interface AgentCanvasOrchestrationCardProps {
  record: CanvasOrchestrationRecord
  progress: CanvasOrchestrationProgress
  canvasTitle: string
  onDecision: (optionId: string) => void
  decisionBusy?: boolean
  decisionSent?: boolean
  error?: string | null
  onRetry?: () => void
}

/** 用有界折叠区展示完整专业进度和决策依据，保持聊天消息区可用。 */
export function AgentCanvasOrchestrationCard({ record, progress, canvasTitle, onDecision,
  decisionBusy = false, decisionSent = false, error, onRetry,
}: AgentCanvasOrchestrationCardProps): React.ReactElement {
  /** 展开是局部视图状态；业务记录仍由父级 Jotai 状态提供。 */
  const [open, setOpen] = React.useState(false)
  /** 有界投影与报告均来自同一委托。 */
  const { stepCounts: counts, pendingDecision: decision, report } = progress
  /** 过期报告中已删除的步骤也明确说明，内部身份不作为展示文案。 */
  const stepTitles = (ids: string[]): string => ids.length
    ? ids.map(id => record.steps.find(step => step.id === id)?.title ?? '已移除的阶段').join('、') : '无'
  return <aside className="rounded-lg border border-border/70 bg-muted/20 text-sm" aria-label={`${canvasTitle}制作进度`}>
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" className="h-auto w-full justify-start gap-2 whitespace-normal p-2.5 text-left">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs text-muted-foreground">{canvasTitle} · {RECORD_STATUS_LABELS[record.status]} · {counts.completed}/{counts.total} 个阶段已评审完成</span>
            <span className="line-clamp-1 min-w-0 break-words [overflow-wrap:anywhere]" title={record.request.goal}>{record.request.goal}</span>
            <span className="block text-xs text-primary">{decisionSent ? '答复已发送，等待处理' : decision ? '需要你的决定' : progress.nextStep}</span>
          </span>
          <ChevronDown className={`size-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      {error && <div className="flex items-center gap-2 px-2.5 pb-2 text-xs text-destructive" role="alert">
        <span className="min-w-0 flex-1">{error}</span>
        {onRetry && <Button type="button" variant="ghost" size="sm" onClick={onRetry}>重试读取</Button>}
      </div>}
      <CollapsibleContent className="max-h-[min(36vh,20rem)] space-y-2 overflow-y-auto border-t border-border/70 p-2.5 text-xs [overflow-wrap:anywhere]">
        <p className="text-muted-foreground">待开始 {counts.planned} · 进行中 {counts.running} · 待评审 {counts.needsReview} · 阻塞 {counts.blocked}</p>
        {progress.currentSteps.items.map(step => <div key={step.id} className="flex items-start gap-2">
          <span className="min-w-0 flex-1">{step.title}</span><span className="shrink-0 text-muted-foreground">{STATUS_LABELS[step.status]}</span>
        </div>)}
        {progress.currentSteps.omitted > 0 && <p className="text-muted-foreground">另有 {progress.currentSteps.omitted} 个阶段，可在画布查看</p>}
        {report && <div className="space-y-1 rounded-md bg-background/60 p-2">
          {report.stale && <p className="text-destructive">以下是历史评估，等待画布 Agent 更新</p>}
          <p>{report.summary}</p>
          {report.impact && <>
            <p>影响：{report.impact.explanation}</p>
            <p>需调整：{stepTitles(report.impact.affectedStepIds)}</p>
            <p>可保留：{stepTitles(report.impact.retainedStepIds)}</p>
            <p>额外工作：{report.impact.additionalWork}</p>
            <p>在途任务：{report.impact.runningWork}</p>
          </>}
        </div>}
        <p>下一步：{progress.nextStep}</p>
        {decision && <div className="space-y-2 rounded-md border border-primary/30 bg-primary/[.04] p-2">
          <p className="font-medium">{decision.question}</p>
          <p className="text-muted-foreground">建议依据：{decision.reason}</p>
          {decision.options.map(option => <div key={option.id} className="space-y-1">
            <Button type="button" size="sm" className="h-auto max-w-full whitespace-normal py-1.5 text-left"
              disabled={decisionBusy || decisionSent} variant={option.id === decision.recommendedOptionId ? 'default' : 'outline'}
              onClick={() => onDecision(option.id)}>
              {option.label}{option.id === decision.recommendedOptionId ? '（建议）' : ''}
            </Button>
            <p className="text-muted-foreground">{option.impact}</p>
          </div>)}
          <p className="text-muted-foreground">{decisionSent ? '答复已发送，等待处理。' : decisionBusy ? '请等待当前消息处理完成。' : '也可以在聊天中直接说明你的选择或补充条件。'}</p>
        </div>}
      </CollapsibleContent>
    </Collapsible>
  </aside>
}
