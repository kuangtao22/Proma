import * as React from 'react'
import type { CanvasSessionMeta } from '@proma/shared'
import { Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface CanvasSessionTabProps {
  /** 当前顶部入口对应的 Canvas 轻量元数据。 */
  session: CanvasSessionMeta
  /** 当前主视图是否正在展示该 Canvas。 */
  active: boolean
  /** 激活当前 Canvas 主视图。 */
  onActivate: () => void
}

/** 渲染不可关闭、不可拖拽的当前 Canvas 顶部入口。 */
export function CanvasSessionTab({
  session,
  active,
  onActivate,
}: CanvasSessionTabProps): React.ReactElement {
  return (
    <div className="relative min-w-[148px] max-w-[260px] flex-[1_0_148px] titlebar-no-drag">
      <button
        type="button"
        role="tab"
        aria-selected={active}
        data-active={active}
        className={cn(
          'group relative flex h-[34px] w-full items-center gap-1.5 rounded-none border border-b-0 border-transparent px-3',
          'cursor-pointer select-none text-xs transition-colors',
          active
            ? 'app-tab-active text-foreground border-border/80'
            : 'app-tab-inactive text-muted-foreground hover:text-foreground',
        )}
        onClick={onActivate}
      >
        <Workflow className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">{session.title}</span>
      </button>
    </div>
  )
}
