import * as React from 'react'
import type { CanvasNodeKind } from '@proma/shared'
import {
  Bot,
  FileImage,
  FileText,
  Hand,
  Monitor,
  MousePointer2,
  Plus,
  Trash2,
  TriangleAlert,
  Video,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** 顶部添加悬浮菜单当前公开的节点类型合同。 */
export const NATIVE_CANVAS_NODE_TYPE_OPTIONS = [
  { kind: 'agent', label: 'Agent', enabled: true },
  { kind: 'image', label: '生图', enabled: true },
  { kind: 'document', label: '文档', enabled: true },
  { kind: 'webview', label: '原型', enabled: true },
  { kind: 'video', label: '视频', enabled: false },
] as const

/** 顶部悬浮菜单单项的稳定联合类型。 */
type NativeCanvasNodeTypeOption = typeof NATIVE_CANVAS_NODE_TYPE_OPTIONS[number]

/** 为可用节点类型创建精确选择处理器；禁用项不绑定任何回调。 */
export function createNativeCanvasNodeTypeSelectHandler(
  option: NativeCanvasNodeTypeOption,
  onAddNode: (kind: CanvasNodeKind) => void,
): (() => void) | undefined {
  if (!option.enabled) return undefined
  return () => onAddNode(option.kind)
}

/** 原生 Canvas 顶部工具栏输入。 */
export interface NativeCanvasToolbarProps {
  activeTool: 'select' | 'pan'
  writable: boolean
  /** 保存或创建在途时可单独禁用添加，不影响其它工具。 */
  canAdd?: boolean
  canDelete: boolean
  issueCount: number
  onToolChange: (tool: 'select' | 'pan') => void
  onAddNode: (kind: CanvasNodeKind) => void
  onDelete: () => void
  onFocusFirstIssue: () => void
}

/** 根据节点类型返回稳定图标，避免菜单标签承担全部识别负担。 */
function NativeCanvasNodeTypeIcon({
  kind,
}: {
  kind: typeof NATIVE_CANVAS_NODE_TYPE_OPTIONS[number]['kind']
}): React.ReactElement {
  if (kind === 'agent') return <Bot aria-hidden="true" />
  if (kind === 'image') return <FileImage aria-hidden="true" />
  if (kind === 'document') return <FileText aria-hidden="true" />
  if (kind === 'webview') return <Monitor aria-hidden="true" />
  return <Video aria-hidden="true" />
}

/** 渲染单个节点类型选项；可用项选择后关闭悬浮菜单并创建节点。 */
export function NativeCanvasNodeTypePickerOption({
  option,
  onAddNode,
}: {
  option: NativeCanvasNodeTypeOption
  onAddNode: (kind: CanvasNodeKind) => void
}): React.ReactElement {
  /** 仅可用类型获得选择回调，视频保持纯禁用选项。 */
  const onClick = createNativeCanvasNodeTypeSelectHandler(option, onAddNode)
  const optionButton = (
    <Button
      type="button"
      variant="ghost"
      className="h-9 w-full min-w-0 justify-start gap-2 px-2"
      disabled={!option.enabled}
      aria-disabled={!option.enabled}
      aria-label={option.enabled ? `添加${option.label}节点` : `${option.label}，即将支持`}
      onClick={onClick}
    >
      <NativeCanvasNodeTypeIcon kind={option.kind} />
      <span className="min-w-0 truncate">{option.label}</span>
      {!option.enabled ? (
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">即将支持</span>
      ) : null}
    </Button>
  )
  if (!option.enabled) return optionButton
  return (
    <PopoverClose asChild data-canvas-node-picker-close="selection">
      {optionButton}
    </PopoverClose>
  )
}

/** 原生 Canvas 顶部悬浮命令条。 */
export function NativeCanvasToolbar({
  activeTool,
  writable,
  canAdd = writable,
  canDelete,
  issueCount,
  onToolChange,
  onAddNode,
  onDelete,
  onFocusFirstIssue,
}: NativeCanvasToolbarProps): React.ReactElement {
  return (
    <TooltipProvider delayDuration={200} disableHoverableContent>
      <nav
        aria-label="Canvas 工具栏"
        className="absolute left-1/2 top-3 z-10 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1 rounded-[8px] border border-border/70 bg-background/95 p-1 shadow-md backdrop-blur"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant={activeTool === 'select' ? 'secondary' : 'ghost'}
              className="size-8"
              aria-label="选择工具"
              aria-pressed={activeTool === 'select'}
              onClick={() => onToolChange('select')}
            >
              <MousePointer2 aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">选择</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant={activeTool === 'pan' ? 'secondary' : 'ghost'}
              className="size-8"
              aria-label="平移工具"
              aria-pressed={activeTool === 'pan'}
              onClick={() => onToolChange('pan')}
            >
              <Hand aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">平移</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="mx-0.5 h-5" />

        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="size-8"
              aria-label="添加节点"
              title="添加节点"
              disabled={!writable || !canAdd}
            >
              <Plus aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="center"
            sideOffset={6}
            className="w-48 max-w-[calc(100vw-1rem)] p-1"
            data-canvas-node-picker="popover"
            data-canvas-node-picker-width="compact"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="flex flex-col gap-0.5" aria-label="选择节点类型">
              {NATIVE_CANVAS_NODE_TYPE_OPTIONS.map((option) => (
                <NativeCanvasNodeTypePickerOption key={option.kind} option={option} onAddNode={onAddNode} />
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="size-8"
              aria-label="删除节点"
              disabled={!writable || !canDelete}
              onClick={onDelete}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">删除节点</TooltipContent>
        </Tooltip>

        {issueCount > 0 ? (
          <>
            <Separator orientation="vertical" className="mx-0.5 h-5" />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 min-w-0 gap-1.5 px-2 text-xs"
              aria-label="聚焦首个问题节点"
              onClick={onFocusFirstIssue}
            >
              <TriangleAlert className="shrink-0 text-destructive" aria-hidden="true" />
              <span className="max-w-36 truncate">{issueCount} 个节点需要处理</span>
            </Button>
          </>
        ) : null}
      </nav>
    </TooltipProvider>
  )
}
