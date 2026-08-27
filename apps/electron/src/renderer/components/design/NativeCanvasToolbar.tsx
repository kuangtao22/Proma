import * as React from 'react'
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** 顶部添加菜单当前公开的节点类型合同。 */
export const NATIVE_CANVAS_NODE_TYPE_OPTIONS = [
  { kind: 'agent', label: 'Agent', enabled: true },
  { kind: 'image', label: '生图', enabled: false },
  { kind: 'visual-document', label: '视觉文档', enabled: false },
  { kind: 'webview', label: '原型', enabled: false },
] as const

/** 当前只有一个可用类型时直接执行，未来多类型启用后自动恢复选择菜单。 */
const ENABLED_NATIVE_CANVAS_NODE_TYPE_OPTIONS = NATIVE_CANVAS_NODE_TYPE_OPTIONS.filter((option) => option.enabled)

/** 原生 Canvas 顶部工具栏输入。 */
export interface NativeCanvasToolbarProps {
  activeTool: 'select' | 'pan'
  writable: boolean
  /** 保存或创建在途时可单独禁用添加，不影响其它工具。 */
  canAdd?: boolean
  canDelete: boolean
  issueCount: number
  onToolChange: (tool: 'select' | 'pan') => void
  onAddAgent: () => void
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
  if (kind === 'visual-document') return <FileText aria-hidden="true" />
  return <Monitor aria-hidden="true" />
}

/** 渲染单个添加菜单项，并为未来能力提供可悬停的禁用说明。 */
function NativeCanvasNodeTypeMenuItem({
  option,
  onAddAgent,
}: {
  option: typeof NATIVE_CANVAS_NODE_TYPE_OPTIONS[number]
  onAddAgent: () => void
}): React.ReactElement {
  /** 菜单项本体保持真实 menuitem 语义。 */
  const item = (
    <DropdownMenuItem
      disabled={!option.enabled}
      aria-disabled={!option.enabled}
      onSelect={option.enabled ? onAddAgent : undefined}
    >
      <NativeCanvasNodeTypeIcon kind={option.kind} />
      <span>{option.label}</span>
      {!option.enabled ? (
        <span className="ml-auto text-[11px] text-muted-foreground">即将支持</span>
      ) : null}
    </DropdownMenuItem>
  )
  if (option.enabled) return item
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="rounded-md">{item}</div>
      </TooltipTrigger>
      <TooltipContent side="right">即将支持</TooltipContent>
    </Tooltip>
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
  onAddAgent,
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

        {ENABLED_NATIVE_CANVAS_NODE_TYPE_OPTIONS.length === 1 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="size-8"
                aria-label="添加节点"
                disabled={!writable || !canAdd}
                onClick={onAddAgent}
              >
                <Plus aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">添加 Agent</TooltipContent>
          </Tooltip>
        ) : (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="size-8"
                    aria-label="添加节点"
                    disabled={!writable || !canAdd}
                  >
                    <Plus aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">添加节点</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="center" side="bottom" className="w-48">
              {NATIVE_CANVAS_NODE_TYPE_OPTIONS.map((option, index) => (
                <React.Fragment key={option.kind}>
                  {index === 1 ? <DropdownMenuSeparator /> : null}
                  <NativeCanvasNodeTypeMenuItem option={option} onAddAgent={onAddAgent} />
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

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
