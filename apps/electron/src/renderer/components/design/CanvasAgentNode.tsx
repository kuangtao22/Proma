import * as React from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import { Bot, CircleAlert, LoaderCircle, Plus } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** Agent 节点当前可显示的本地运行状态。 */
export type CanvasAgentStatus = 'idle' | 'running' | 'unavailable'

/** Agent 节点只公开身份、标题和本地状态，不包含任何消息数据。 */
export interface CanvasAgentNodeData extends Record<string, unknown> {
  id: string
  title: string
  agentSessionId: string
  status: CanvasAgentStatus
  canExpand: boolean
  onExpand?: (nodeId: string) => void
}

/** 原生 Canvas 的 Agent XYFlow 节点类型。 */
export type CanvasAgentFlowNode = Node<CanvasAgentNodeData, 'canvasAgent'>

/** Agent 状态对应的简洁中文标签。 */
const AGENT_STATUS_LABELS: Record<CanvasAgentStatus, string> = {
  idle: '空闲',
  running: '运行中',
  unavailable: '会话不可用',
}

/** Agent 状态对应的主题色，保持明暗主题可读。 */
const AGENT_STATUS_CLASSES: Record<CanvasAgentStatus, string> = {
  idle: 'text-muted-foreground',
  running: 'text-primary',
  unavailable: 'text-muted-foreground',
}

/** 根据本地状态选择语义图标。 */
function AgentStatusIcon({ status }: { status: CanvasAgentStatus }): React.ReactElement {
  if (status === 'running') return <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
  if (status === 'unavailable') return <CircleAlert className="size-3.5" aria-hidden="true" />
  return <Bot className="size-3.5" aria-hidden="true" />
}

/**
 * 渲染固定尺寸的原生 Canvas Agent 卡片。
 * @param props XYFlow 注入的 Agent 数据、尺寸与选中态。
 * @returns 不读取会话消息的纯展示节点。
 */
export function CanvasAgentNode({ data, selected }: NodeProps<CanvasAgentFlowNode>): React.ReactElement {
  /** 当前状态的稳定中文文本同时用于视觉与可访问名称。 */
  const statusLabel = AGENT_STATUS_LABELS[data.status]
  return (
    <div className="group relative h-[144px] w-[288px]">
      <article
        className={cn(
          'flex h-[144px] w-[288px] flex-col overflow-hidden rounded-[8px] border bg-card text-card-foreground shadow-sm',
          selected ? 'border-primary ring-2 ring-primary/25' : 'border-border',
        )}
        aria-label={`Agent：${data.title}，${statusLabel}`}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Bot className="size-4" aria-hidden="true" />
          </span>
          <span className="text-xs font-medium text-muted-foreground">Agent</span>
        </header>
        <div className="flex min-h-0 flex-1 flex-col justify-between gap-2 px-4 py-3">
          <h3 className="line-clamp-2 overflow-hidden break-words text-sm font-medium leading-5">
            {data.title}
          </h3>
          <div className={cn('flex items-center gap-1.5 text-xs', AGENT_STATUS_CLASSES[data.status])}>
            <AgentStatusIcon status={data.status} />
            <span>{statusLabel}</span>
          </div>
        </div>
      </article>
      {data.canExpand && data.status !== 'unavailable' && data.onExpand ? (
        <TooltipProvider delayDuration={200} disableHoverableContent>
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
                  data.onExpand?.(data.id)
                }}
              >
                <Plus className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">从此节点扩展</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </div>
  )
}
