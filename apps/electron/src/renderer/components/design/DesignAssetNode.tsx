import * as React from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import { ImageOff, LoaderCircle, RotateCcw, Square, Trash2 } from 'lucide-react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  requestDesignRecoveryAtom,
  updateDesignProjectStateAtom,
} from '@/atoms/design-atoms'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { designAdapter } from '@/lib/design-adapter'
import { cn } from '@/lib/utils'

export type DesignAssetNodeStatus = 'success' | 'queued' | 'running' | 'failed' | 'cancelled' | 'interrupted' | 'missing'

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
  /** 任务所属项目 ID，仅任务节点存在。 */
  projectId?: string
  /** 当前项目是否允许提交任务控制命令。 */
  writable?: boolean
  /** 当前项目权威快照恢复状态。 */
  authoritativeRecoveryState?: 'idle' | 'loading' | 'failed'
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
  /** 任务创建时固化的生图配置名称和真实模型 ID。 */
  imageModelLabel?: string
}

/** Design 自定义 XYFlow 节点类型。 */
export type DesignAssetFlowNode = Node<DesignAssetNodeData, 'designAsset'>

export interface DesignAssetNodeProps extends NodeProps<DesignAssetFlowNode> {
  /** Task 8/10 接入的任务重试处理器；缺失时按钮保持禁用。 */
  onRetry?: (jobId: string) => void
  /** 测试或外部宿主注入的删除确认请求；生产默认写入项目确认意图。 */
  onDelete?: (jobId: string) => void
}

/** 每种节点状态对应的明确中文文本。 */
const STATUS_LABELS: Record<DesignAssetNodeStatus, string> = {
  success: '已完成',
  queued: '等待生成',
  running: '正在生成',
  failed: '生成失败',
  cancelled: '已取消',
  interrupted: '已中断',
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
  onDelete,
}: DesignAssetNodeProps): React.ReactElement {
  const updateProjectState = useSetAtom(updateDesignProjectStateAtom)
  const requestRecovery = useSetAtom(requestDesignRecoveryAtom)
  /** 取消请求提交后保持稳定反馈，直到主进程返回权威终态。 */
  const [cancelling, setCancelling] = React.useState(false)
  /** 持久化节点宽度缺失时使用首版标准宽度。 */
  const stableWidth = width ?? 320
  /** 持久化节点高度缺失时使用首版标准高度。 */
  const stableHeight = height ?? 240
  /** 失败、取消和进程中断的任务允许出现重试入口。 */
  const canRetry = data.kind === 'job'
    && (data.status === 'failed' || data.status === 'cancelled' || data.status === 'interrupted')
  /** 任务命令仅在权威可写基线稳定时开放。 */
  const commandsEnabled = data.writable === true && data.authoritativeRecoveryState === 'idle'
  /** 外部测试回调优先；生产节点可凭完整项目和任务 ID 直接重试。 */
  const retryEnabled = commandsEnabled && Boolean(onRetry || (data.projectId && data.jobId))
  /** 删除与重试共享终态范围，但通过独立 IPC 清理节点和 journal。 */
  const deleteEnabled = commandsEnabled && Boolean(onDelete || (data.projectId && data.jobId))
  /** 只有等待或运行中的真实任务允许取消。 */
  const canCancel = data.kind === 'job'
    && (data.status === 'queued' || data.status === 'running')
    && Boolean(data.projectId && data.jobId)
  /** 已完成且持有授权 URL 的素材才渲染图片。 */
  const showsPreview = data.status === 'success' && Boolean(data.previewUrl)
  /** 素材沿用状态与像素尺寸，任务有快照时改为展示实际生图模型。 */
  const footerLabel = data.imageModelLabel
    ?? `${STATUS_LABELS[data.status]}${data.pixelWidth && data.pixelHeight ? ` · ${data.pixelWidth} × ${data.pixelHeight}` : ''}`

  /** 通过主进程创建新的可追踪任务，旧 journal 继续保留审计。 */
  const handleRetry = (): void => {
    if (!commandsEnabled || !data.jobId) return
    if (onRetry) {
      onRetry(data.jobId)
      return
    }
    if (!data.projectId) return
    /** 闭包内收窄后的稳定项目 ID，供异步回调按项目更新 Jotai。 */
    const projectId = data.projectId
    void designAdapter.retryJob({ projectId, jobId: data.jobId }).then((job) => {
      updateProjectState({
        projectId,
        update: (current) => ({
          jobs: [...current.jobs.filter((candidate) => candidate.id !== job.id), job],
        }),
      })
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes('DESIGN_RECOVERY_REQUIRED')) {
        requestRecovery({ projectId })
      }
      toast.error(error instanceof Error ? error.message : '重试设计任务失败')
    })
  }

  /** 请求主进程停止对应 Pi generation，并采用其竞态判定后的 journal 终态。 */
  const handleCancel = (): void => {
    if (!commandsEnabled || cancelling || !data.projectId || !data.jobId) return
    /** 闭包内收窄后的稳定项目和任务 ID。 */
    const projectId = data.projectId
    const jobId = data.jobId
    setCancelling(true)
    void designAdapter.cancelJob({ projectId, jobId }).then((job) => {
      updateProjectState({
        projectId,
        update: (current) => ({
          jobs: [...current.jobs.filter((candidate) => candidate.id !== job.id), job],
        }),
      })
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes('DESIGN_RECOVERY_REQUIRED')) {
        requestRecovery({ projectId })
      }
      toast.error(error instanceof Error ? error.message : '取消设计任务失败')
    }).finally(() => {
      setCancelling(false)
    })
  }

  /** 删除按钮只登记确认意图，持久化删除由工作区唯一对话框执行。 */
  const handleDelete = (): void => {
    if (!commandsEnabled || !data.jobId) return
    if (onDelete) {
      onDelete(data.jobId)
      return
    }
    if (!data.projectId) return
    updateProjectState({
      projectId: data.projectId,
      update: { deleteJobIntentId: data.jobId },
    })
  }

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
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">{data.title}</p>
            {data.imageModelLabel ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <p
                    className={cn(
                      'nodrag nokey truncate text-[11px] text-muted-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                    )}
                    aria-label={`实际生图模型：${data.imageModelLabel}`}
                    tabIndex={0}
                  >
                    {footerLabel}
                  </p>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-64 break-all">
                  {data.imageModelLabel}
                </TooltipContent>
              </Tooltip>
            ) : (
              <p className="truncate text-[11px] text-muted-foreground">{footerLabel}</p>
            )}
          </div>
          {canRetry && (
            <div className="nodrag flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="删除任务"
                disabled={!deleteEnabled || !data.jobId}
                onClick={handleDelete}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                disabled={!retryEnabled || !data.jobId}
                onClick={handleRetry}
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                重试生成
              </Button>
            </div>
          )}
          {canCancel && (
            <TooltipProvider delayDuration={200} disableHoverableContent>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="nodrag shrink-0"
                    aria-description="供应商已收到请求时，费用不一定撤销"
                    disabled={!commandsEnabled || cancelling}
                    onClick={handleCancel}
                  >
                    {cancelling
                      ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                      : <Square className="size-3.5" aria-hidden="true" />}
                    {cancelling ? '取消中' : '取消生成'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">供应商已收到请求时，费用不一定撤销</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </footer>
      </div>
    </article>
  )
}
