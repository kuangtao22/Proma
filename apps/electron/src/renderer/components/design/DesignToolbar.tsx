import * as React from 'react'
import {
  ArrowUpRight,
  Group,
  Hand,
  MousePointer2,
  Paintbrush,
  Redo2,
  Undo2,
  Ungroup,
  Upload,
} from 'lucide-react'
import type { DesignProjectState } from '@/atoms/design-atoms'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface DesignToolbarProps {
  /** 当前画布工具。 */
  activeTool: DesignProjectState['activeTool']
  /** 当前项目是否允许写入。 */
  writable: boolean
  /** 当前是否存在可撤销历史。 */
  canUndo: boolean
  /** 当前是否存在可重做历史。 */
  canRedo: boolean
  /** 切换选择或平移模式。 */
  onToolChange: (tool: DesignProjectState['activeTool']) => void
  /** Task 8 接入的撤销处理器。 */
  onUndo?: () => void
  /** Task 8 接入的重做处理器。 */
  onRedo?: () => void
  /** Task 8 接入的分组处理器。 */
  onGroup?: () => void
  /** Task 8 接入的取消分组处理器。 */
  onUngroup?: () => void
  /** Task 8 接入的箭头批注处理器。 */
  onArrowTool?: () => void
  /** Task 8 接入的画笔蒙版处理器。 */
  onMaskTool?: () => void
  /** 打开图片导入入口。 */
  onImportAssets?: () => void
}

interface ToolbarIconButtonProps {
  /** 命令对应的 Lucide 图标。 */
  icon: React.ElementType
  /** Tooltip 与无障碍名称共用的明确命令文本。 */
  label: string
  /** 是否禁用当前命令。 */
  disabled?: boolean
  /** 是否为当前激活模式。 */
  active?: boolean
  /** 点击命令时调用的处理器。 */
  onClick?: () => void
}

/** 渲染固定 32px 的图标命令按钮，并统一 Tooltip 和 aria-label。 */
function ToolbarIconButton({
  icon: Icon,
  label,
  disabled = false,
  active,
  onClick,
}: ToolbarIconButtonProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex"
          tabIndex={disabled ? 0 : undefined}
          aria-description={disabled ? `${label}不可用` : undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn('h-8 w-8', active && 'bg-accent text-accent-foreground')}
            aria-label={label}
            aria-pressed={active === undefined ? undefined : active}
            disabled={disabled}
            onClick={onClick}
          >
            <Icon className="size-4" aria-hidden="true" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/** 设计画布的紧凑模式切换与图标命令工具栏。 */
export function DesignToolbar({
  activeTool,
  writable,
  canUndo,
  canRedo,
  onToolChange,
  onUndo,
  onRedo,
  onGroup,
  onUngroup,
  onArrowTool,
  onMaskTool,
  onImportAssets,
}: DesignToolbarProps): React.ReactElement {
  return (
    <TooltipProvider delayDuration={200} disableHoverableContent>
      <div className="flex min-h-10 max-w-[calc(100vw-24px)] flex-wrap items-center gap-1 rounded-md border border-border bg-background/95 p-1 shadow-sm backdrop-blur-sm">
        <div className="flex items-center rounded-sm bg-muted p-0.5" role="group" aria-label="画布模式">
          <ToolbarIconButton
            icon={MousePointer2}
            label="选择"
            active={activeTool === 'select'}
            onClick={() => onToolChange('select')}
          />
          <ToolbarIconButton
            icon={Hand}
            label="平移"
            active={activeTool === 'pan'}
            onClick={() => onToolChange('pan')}
          />
        </div>
        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />
        <ToolbarIconButton icon={Undo2} label="撤销" disabled={!writable || !canUndo || !onUndo} onClick={onUndo} />
        <ToolbarIconButton icon={Redo2} label="重做" disabled={!writable || !canRedo || !onRedo} onClick={onRedo} />
        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />
        <ToolbarIconButton icon={Group} label="分组" disabled={!writable || !onGroup} onClick={onGroup} />
        <ToolbarIconButton icon={Ungroup} label="取消分组" disabled={!writable || !onUngroup} onClick={onUngroup} />
        <ToolbarIconButton
          icon={ArrowUpRight}
          label="箭头批注"
          active={activeTool === 'arrow'}
          disabled={!writable || !onArrowTool}
          onClick={onArrowTool}
        />
        <ToolbarIconButton
          icon={Paintbrush}
          label="画笔蒙版"
          active={activeTool === 'mask'}
          disabled={!writable || !onMaskTool}
          onClick={onMaskTool}
        />
        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />
        <ToolbarIconButton icon={Upload} label="导入图片" disabled={!writable || !onImportAssets} onClick={onImportAssets} />
      </div>
    </TooltipProvider>
  )
}
