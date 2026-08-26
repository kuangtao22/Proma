import * as React from 'react'
import { LoaderCircle, RotateCcw, Trash2, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** 坏 Agent 节点恢复面板输入，不接受 session 或消息数据。 */
export interface CanvasAgentRecoveryPanelProps {
  title: string
  rebuilding: boolean
  error: string | null
  onRebuild: () => void
  onDelete: () => void
  onClose: () => void
}

/** 坏节点局部恢复面板，禁止读取或伪造旧会话消息。 */
export function CanvasAgentRecoveryPanel({
  title,
  rebuilding,
  error,
  onRebuild,
  onDelete,
  onClose,
}: CanvasAgentRecoveryPanelProps): React.ReactElement {
  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[min(28rem,100%)] flex-col border-l border-border bg-background shadow-lg">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</h2>
        <TooltipProvider delayDuration={200} disableHoverableContent>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="icon-sm" variant="ghost" aria-label="关闭恢复面板" onClick={onClose}>
                <X aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>关闭</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <TriangleAlert className="size-5" aria-hidden="true" />
        </span>
        <h3 className="mt-4 text-sm font-medium text-foreground">此节点关联的 Agent 会话不可用。</h3>
        <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
          新会话将从空白对话开始，旧对话记录不会删除。
        </p>
        {error ? <p className="mt-3 text-xs text-destructive" role="alert">{error}</p> : null}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" size="sm" disabled={rebuilding} onClick={onRebuild}>
            {rebuilding ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw aria-hidden="true" />
            )}
            {rebuilding ? '正在重建' : '重建会话'}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={rebuilding} onClick={onDelete}>
            <Trash2 aria-hidden="true" />
            删除节点
          </Button>
        </div>
      </div>
    </aside>
  )
}
