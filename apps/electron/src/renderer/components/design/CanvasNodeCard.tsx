import * as React from 'react'
import type { CanvasNodeKind } from '@proma/shared'
import { Handle, Position } from '@xyflow/react'
import type { LucideIcon } from 'lucide-react'
import { Bot, CircleAlert, FileImage, FileText, LoaderCircle, Maximize2, Monitor, Plus } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** 折叠卡片只接收画布文档中的精确轻量展示字段和命令回调。 */
export interface CanvasNodeCardData {
  id: string
  kind: CanvasNodeKind
  title: string
  statusLabel: string
  summary: string
  canExpand: boolean
  onExpand?: (nodeId: string) => void
  onCreateChild?: (sourceNodeId: string) => void
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
  selected,
  canExpand,
  onExpand,
  onCreateChild,
}: CanvasNodeCardProps): React.ReactElement {
  /** 当前节点类型的稳定中文名称和 Lucide 图标。 */
  const { label, Icon } = CANVAS_NODE_PRESENTATION[kind]
  return (
    <TooltipProvider delayDuration={200} disableHoverableContent>
      <div className="group relative h-[144px] w-[288px]">
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
            'flex h-[144px] w-[288px] flex-col overflow-hidden rounded-[8px] border bg-card text-card-foreground shadow-sm',
            selected ? 'border-primary ring-2 ring-primary/25' : 'border-border',
          )}
          aria-label={`${label}：${title}，${statusLabel}`}
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">{label}</span>
            {canExpand && onExpand ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`展开${label}工作台`}
                    className="nodrag nopan flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={(event) => {
                      event.stopPropagation()
                      onExpand(id)
                    }}
                  >
                    <Maximize2 className="size-4" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>展开{label}工作台</TooltipContent>
              </Tooltip>
            ) : null}
          </header>
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
        {onCreateChild ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="从此节点扩展"
                className={cn(
                  'nodrag nopan absolute -right-9 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm transition-opacity hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                )}
                onClick={(event) => {
                  event.stopPropagation()
                  onCreateChild(id)
                }}
              >
                <Plus className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">从此节点扩展</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </TooltipProvider>
  )
}
