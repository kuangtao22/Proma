import * as React from 'react'
import type { AgentWorkspace } from '@proma/shared'
import { useAtomValue } from 'jotai'
import { Palette } from 'lucide-react'
import { interfaceVariantAtom } from '@/atoms/theme'
import { cn } from '@/lib/utils'

export interface DesignProjectTabProps {
  /** 当前设计工作区绑定的项目。 */
  workspace: AgentWorkspace
  /** 标签是否对应当前主视图。 */
  active: boolean
  /** 激活当前项目设计工作区。 */
  onActivate: () => void
}

/** 渲染不可关闭、不可拖拽的项目级设计入口。 */
export function DesignProjectTab({
  workspace,
  active,
  onActivate,
}: DesignProjectTabProps): React.ReactElement {
  /** 当前界面样式决定标签圆角和背景规则。 */
  const isClassic = useAtomValue(interfaceVariantAtom) === 'classic'

  return (
    <div className="relative min-w-[148px] max-w-[260px] flex-[1_0_148px] titlebar-no-drag">
      <button
        type="button"
        role="tab"
        aria-selected={active}
        data-active={active}
        className={cn(
          'group relative flex h-[34px] w-full items-center gap-1.5 border border-b-0 border-transparent px-3',
          isClassic ? 'rounded-t-lg' : 'rounded-none',
          'cursor-pointer select-none text-xs transition-colors',
          active
            ? isClassic
              ? 'bg-content-area text-foreground border-border/50'
              : 'app-tab-active text-foreground border-border/80'
            : isClassic
              ? 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              : 'app-tab-inactive text-muted-foreground hover:text-foreground',
        )}
        onClick={onActivate}
      >
        <Palette className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">设计 · {workspace.name}</span>
      </button>
    </div>
  )
}
