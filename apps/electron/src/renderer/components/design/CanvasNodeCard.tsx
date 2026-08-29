import * as React from 'react'
import type { CanvasNodeKind } from '@proma/shared'
import { Handle, Position } from '@xyflow/react'
import type { LucideIcon } from 'lucide-react'
import { Bot, CircleAlert, FileImage, FileText, LoaderCircle, Maximize2, MessageSquareQuote, Monitor, MoreHorizontal, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  NATIVE_CANVAS_NODE_TYPE_OPTIONS,
  NativeCanvasNodeTypePickerOption,
} from './NativeCanvasToolbar'

/** 折叠卡片只接收画布文档中的精确轻量展示字段和命令回调。 */
export interface CanvasNodeCardData {
  id: string
  kind: CanvasNodeKind
  title: string
  statusLabel: string
  summary: string
  /** 仅生图节点可携带的工作区授权缩略图 URL。 */
  previewUrl?: string
  /** 投影层根据已验证素材比例计算的节点总高度。 */
  nodeHeight?: number
  canOpenWorkbench: boolean
  onOpenWorkbench?: (nodeId: string) => void
  canCreateChild: boolean
  onCreateChild?: (sourceNodeId: string, kind: CanvasNodeKind) => void
  /** 把当前轻量节点身份交回 Workspace，由 Workspace 从权威 snapshot 构造引用。 */
  onReferenceNode?: (nodeId: string) => void
}

/** XYFlow 泛型要求的数据适配层；展示组件继续只公开精确字段。 */
export type CanvasNodeFlowData = CanvasNodeCardData & Record<string, unknown>

/** 通用折叠卡片输入包含 XYFlow 当前选中态。 */
export interface CanvasNodeCardProps extends CanvasNodeCardData {
  selected: boolean
}

/** 四类节点共享的中文名称与图标，不从内容文件派生展示。 */
const CANVAS_NODE_PRESENTATION: Record<CanvasNodeKind, { label: string; Icon: LucideIcon }> = {
  agent: { label: 'Agent', Icon: Bot },
  image: { label: '生图', Icon: FileImage },
  document: { label: '文档', Icon: FileText },
  webview: { label: '原型', Icon: Monitor },
}

/** 节点侧菜单单项的最小结构，兼容顶部菜单的禁用视频项。 */
export interface CanvasNodeChildTypeOption {
  kind: CanvasNodeKind | 'video'
  label: string
  enabled: boolean
}

/** 为可用目标类型创建精确扩展处理器，禁用项不触发回调。 */
export function createCanvasNodeChildTypeSelectHandler(
  option: CanvasNodeChildTypeOption,
  sourceNodeId: string,
  onCreateChild: (sourceNodeId: string, kind: CanvasNodeKind) => void,
): (() => void) | undefined {
  if (!option.enabled || option.kind === 'video') return undefined
  /** 捕获已收窄类型，避免回调执行时重新读取宽联合字段。 */
  const kind = option.kind
  return () => onCreateChild(sourceNodeId, kind)
}

/** Agent 折叠态保留既有运行与故障图标，其他类型无需额外状态图标。 */
function CanvasNodeStatusIcon({ kind, statusLabel }: Pick<CanvasNodeCardProps, 'kind' | 'statusLabel'>): React.ReactElement | null {
  if (kind !== 'agent') return null
  if (statusLabel === '运行中') return <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
  if (statusLabel === '会话不可用') return <CircleAlert className="size-3.5" aria-hidden="true" />
  return <Bot className="size-3.5" aria-hidden="true" />
}

/**
 * 渲染四类 Canvas 节点共用的固定尺寸折叠卡片。
 * @param props 轻量展示字段、选中态与可选命令回调。
 * @returns 不读取消息、Markdown、HTML 或图片历史的节点卡片。
 */
export function CanvasNodeCard({
  id,
  kind,
  title,
  statusLabel,
  summary,
  previewUrl,
  nodeHeight,
  selected,
  canOpenWorkbench,
  onOpenWorkbench,
  canCreateChild,
  onCreateChild,
  onReferenceNode,
}: CanvasNodeCardProps): React.ReactElement {
  /** 当前节点类型的稳定中文名称和 Lucide 图标。 */
  const { label, Icon } = CANVAS_NODE_PRESENTATION[kind]
  /** 当前 URL 加载失败后隐藏图片，避免浏览器持续显示破图图标。 */
  const [previewFailed, setPreviewFailed] = React.useState(false)
  /** URL 切换代表新的素材版本，应允许重新尝试加载。 */
  React.useEffect(() => setPreviewFailed(false), [previewUrl])
  /** 只有生图节点的有效 URL 且未失败时显示缩略图。 */
  const showPreview = kind === 'image' && Boolean(previewUrl) && !previewFailed
  /** 只有有效图片预览使用投影动态高度，文字和失败状态继续保持默认卡片。 */
  const dynamicHeight = showPreview && nodeHeight && nodeHeight !== 144 ? nodeHeight : undefined
  return (
    <TooltipProvider delayDuration={200} disableHoverableContent>
      <div
        className={cn('group relative w-[288px]', dynamicHeight ? undefined : 'h-[144px]')}
        style={dynamicHeight ? { height: dynamicHeight } : undefined}
      >
        <Handle
          id="input"
          type="target"
          position={Position.Left}
          isConnectable={false}
          isConnectableStart={false}
          isConnectableEnd={false}
          className="!size-2 !border-2 !border-background !bg-muted-foreground"
        />
        <article
          className={cn(
            'flex w-[288px] flex-col overflow-hidden rounded-[8px] border bg-card text-card-foreground shadow-sm',
            dynamicHeight ? 'h-full' : 'h-[144px]',
            selected ? 'border-primary ring-2 ring-primary/25' : 'border-border',
          )}
          aria-label={`${label}：${title}，${statusLabel}`}
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">{label}</span>
            {onReferenceNode ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="节点操作"
                    title="引用到对话"
                    className="nodrag nopan flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="end"
                  className="w-44 p-1"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9 w-full justify-start gap-2 px-2"
                    onClick={() => onReferenceNode(id)}
                  >
                    <MessageSquareQuote aria-hidden="true" />
                    引用到对话
                  </Button>
                </PopoverContent>
              </Popover>
            ) : null}
            {canOpenWorkbench && onOpenWorkbench ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`展开${label}工作台`}
                    className="nodrag nopan flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpenWorkbench(id)
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <Maximize2 className="size-4" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>展开{label}工作台</TooltipContent>
              </Tooltip>
            ) : null}
          </header>
          {showPreview ? (
            <div className="relative min-h-0 flex-1 bg-muted">
              <img
                src={previewUrl}
                alt={`${title}缩略图`}
                className="h-full w-full object-contain"
                draggable={false}
                onError={() => setPreviewFailed(true)}
              />
              <div className="absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-2 bg-background/90 px-3 py-1.5 text-xs backdrop-blur-sm">
                <p className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</p>
                <span className="shrink-0 text-muted-foreground" role="status">{statusLabel}</span>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
              <h3 className="line-clamp-2 overflow-hidden break-words text-sm font-medium leading-5">
                {title}
              </h3>
              <div className="mt-auto flex min-w-0 items-center gap-2 text-xs">
                <p className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</p>
                <span className="flex shrink-0 items-center gap-1 font-medium text-foreground" role="status">
                  <CanvasNodeStatusIcon kind={kind} statusLabel={statusLabel} />
                  {statusLabel}
                </span>
              </div>
            </div>
          )}
        </article>
        <Handle
          id="output"
          type="source"
          position={Position.Right}
          isConnectable={false}
          isConnectableStart={false}
          isConnectableEnd={false}
          className="!size-2 !border-2 !border-background !bg-muted-foreground"
        />
        {canCreateChild && onCreateChild ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="从此节点扩展"
                title="从此节点扩展"
                className={cn(
                  'nodrag nopan absolute -right-9 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm transition-opacity hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                )}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <Plus className="size-4" aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="right"
              align="center"
              sideOffset={8}
              className="w-48 max-w-[calc(100vw-1rem)] p-1"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              {NATIVE_CANVAS_NODE_TYPE_OPTIONS.map((option) => (
                <NativeCanvasNodeTypePickerOption
                  key={option.kind}
                  option={option}
                  onAddNode={(childKind) => onCreateChild(id, childKind)}
                />
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </TooltipProvider>
  )
}
