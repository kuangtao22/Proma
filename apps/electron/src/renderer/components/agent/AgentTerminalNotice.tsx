import { AlertTriangle, CircleX } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentTerminalNotice as AgentTerminalNoticeModel } from '@/lib/agent-terminal-result'

/** 在助手原文之后明确展示 Host 最终状态，避免成功表述掩盖真实失败。 */
export function AgentTerminalNotice({ notice }: { notice: AgentTerminalNoticeModel }): React.ReactElement {
  const blocked = notice.kind === 'blocked'
  const Icon = blocked ? AlertTriangle : CircleX

  return (
    <div
      data-agent-terminal-status={notice.kind}
      className={cn(
        'mt-3 flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-xs',
        blocked
          ? 'border-amber-500/25 bg-amber-500/5'
          : 'border-destructive/25 bg-destructive/5',
      )}
    >
      <Icon className={cn(
        'mt-0.5 size-3.5 shrink-0',
        blocked ? 'text-amber-500' : 'text-destructive',
      )} />
      <div className="min-w-0 space-y-1">
        <div className="font-medium text-foreground">{notice.title}</div>
        <p className="break-words text-muted-foreground">{notice.detail}</p>
      </div>
    </div>
  )
}
