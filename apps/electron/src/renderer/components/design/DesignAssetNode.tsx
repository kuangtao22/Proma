import * as React from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import { ImageOff, LoaderCircle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type DesignAssetNodeStatus = 'success' | 'queued' | 'running' | 'failed' | 'cancelled' | 'missing'

/** XYFlow 节点允许公开的安全展示数据。 */
export interface DesignAssetNodeData extends Record<string, unknown> {
  /** 节点引用的业务实体类型。 */
  kind: 'asset' | 'job'
  /** 素材或任务当前的可展示状态。 */
  status: DesignAssetNodeStatus
  /** 素材稳定 ID，仅素材节点存在。 */
  assetId?: string
  /** 任务稳定 ID，仅任务节点存在。 */
  jobId?: string
  /** 节点主标题，不包含本地路径。 */
  title: string
  /** 经过媒体授权协议保护的缩略图 URL。 */
  previewUrl?: string
  /** 原始素材像素宽度，仅用于展示。 */
  pixelWidth?: number
  /** 原始素材像素高度，仅用于展示。 */
  pixelHeight?: number
  /** 任务失败的用户可见原因。 */
  error?: string
}

/** Design 自定义 XYFlow 节点类型。 */
export type DesignAssetFlowNode = Node<DesignAssetNodeData, 'designAsset'>

export interface DesignAssetNodeProps extends NodeProps<DesignAssetFlowNode> {
  /** Task 8/10 接入的任务重试处理器；缺失时按钮保持禁用。 */
  onRetry?: (jobId: string) => void
}

/** 每种节点状态对应的明确中文文本。 */
const STATUS_LABELS: Record<DesignAssetNodeStatus, string> = {
  success: '已完成',
  queued: '等待生成',
  running: '正在生成',
  failed: '生成失败',
  cancelled: '已取消',
  missing: '素材缺失',
}

/**
 * 渲染固定尺寸的图片素材或任务占位节点。
 * @param props XYFlow 节点属性与可选任务重试回调。
 * @returns 不会因加载态或状态文本改变尺寸的节点内容。
 */
export function DesignAssetNode({
  data,
  width,
  height,
  selected,
  onRetry,
}: DesignAssetNodeProps): React.ReactElement {
  /** 持久化节点宽度缺失时使用首版标准宽度。 */
  const stableWidth = width ?? 320
  /** 持久化节点高度缺失时使用首版标准高度。 */
  const stableHeight = height ?? 240
  /** 只有失败和取消的任务允许出现重试入口。 */
  const canRetry = data.kind === 'job'
    && (data.status === 'failed' || data.status === 'cancelled')
  /** 已完成且持有授权 URL 的素材才渲染图片。 */
  const showsPreview = data.status === 'success' && Boolean(data.previewUrl)

  return (
    <article
      className={cn(
        'relative overflow-hidden rounded-md border bg-card text-card-foreground shadow-sm',
        'transition-[border-color,box-shadow] duration-150',
        selected && 'border-ring shadow-md ring-2 ring-ring/30',
      )}
      style={{ width: stableWidth, height: stableHeight }}
      aria-label={`${data.title}，${STATUS_LABELS[data.status]}`}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="relative min-h-0 flex-1 bg-muted/50">
          {showsPreview ? (
            <img
              className="h-full w-full select-none object-contain"
              src={data.previewUrl}
              alt={data.title}
              draggable={false}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
              {data.status === 'queued' || data.status === 'running'
                ? <LoaderCircle className="size-6 animate-spin" aria-hidden="true" />
                : <ImageOff className="size-6" aria-hidden="true" />}
              <span className="text-xs font-medium text-foreground">{STATUS_LABELS[data.status]}</span>
              {data.error && <span className="line-clamp-2 text-xs">{data.error}</span>}
            </div>
          )}
        </div>
        <footer className="flex h-12 shrink-0 items-center justify-between gap-2 border-t border-border bg-card px-3">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{data.title}</p>
            <p className="text-[11px] text-muted-foreground">
              {STATUS_LABELS[data.status]}
              {data.pixelWidth && data.pixelHeight ? ` · ${data.pixelWidth} × ${data.pixelHeight}` : ''}
            </p>
          </div>
          {canRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="nodrag shrink-0"
              disabled={!onRetry || !data.jobId}
              onClick={() => data.jobId && onRetry?.(data.jobId)}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              重试生成
            </Button>
          )}
        </footer>
      </div>
    </article>
  )
}
