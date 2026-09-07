import * as React from 'react'
import { AlertTriangle, CheckCircle2, Clock3, Download, LoaderCircle, Upload, X } from 'lucide-react'
import type { ServerOpsTransferSnapshot } from '@proma/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export interface ServerOpsTransfersPanelProps {
  transfers: readonly ServerOpsTransferSnapshot[]
  onCancel(transfer: ServerOpsTransferSnapshot): void
}

/** 显示当前窗口的有界文件传输队列与明确终态。 */
export function ServerOpsTransfersPanel({ transfers, onCancel }: ServerOpsTransfersPanelProps): React.ReactElement {
  if (transfers.length === 0) {
    return <div className="flex min-h-32 items-center justify-center border-t text-sm text-muted-foreground">暂无文件传输</div>
  }
  return (
    <TooltipProvider>
      <div className="divide-y border-t" aria-label="文件传输列表">
        {transfers.map((transfer) => <TransferRow key={transfer.transferId} transfer={transfer} onCancel={onCancel} />)}
      </div>
    </TooltipProvider>
  )
}

/** 渲染单条传输，固定进度轨道避免状态变化引发布局跳动。 */
function TransferRow({ transfer, onCancel }: { transfer: ServerOpsTransferSnapshot; onCancel(transfer: ServerOpsTransferSnapshot): void }): React.ReactElement {
  const progress = transfer.totalBytes === 0 ? 0 : Math.min(100, Math.floor(transfer.transferredBytes / transfer.totalBytes * 100))
  const cancellable = transfer.status === 'queued' || transfer.status === 'running'
  const DirectionIcon = transfer.direction === 'upload' ? Upload : Download
  return (
    <div className="grid min-h-24 grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2.5">
      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <DirectionIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate text-sm font-medium" title={transfer.fileName}>{transfer.fileName}</span>
          <StatusBadge status={transfer.status} />
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={transfer.remotePath}>{transfer.remotePath}</div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="h-1.5 overflow-hidden rounded-sm bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="h-full bg-primary transition-[width] duration-150" style={{ width: `${progress}%` }} />
          </div>
          <span className="w-10 text-right text-[11px] tabular-nums text-muted-foreground">{progress}%</span>
        </div>
        <div className="text-[11px] text-muted-foreground">{formatBytes(transfer.transferredBytes)} / {formatBytes(transfer.totalBytes)}</div>
        {transfer.errorCode && <div className="text-xs text-destructive">{getTransferErrorMessage(transfer.errorCode)}</div>}
        {transfer.warning && (
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span>{transfer.warning === 'SERVER_OPS_AUDIT_WRITE_FAILED'
              ? '结果审计未保存，传输状态保持不变。'
              : '临时文件清理失败，请检查传输目标。'}</span>
          </div>
        )}
      </div>
      <div className="flex h-8 items-center">
        {cancellable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`取消传输 ${transfer.fileName}`} onClick={() => onCancel(transfer)}><X className="size-4" aria-hidden="true" /></Button>
            </TooltipTrigger>
            <TooltipContent>取消传输</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

/** 将内部状态转换为紧凑可扫描的中文标签。 */
function StatusBadge({ status }: { status: ServerOpsTransferSnapshot['status'] }): React.ReactElement {
  const meta = statusMeta(status)
  const Icon = meta.icon
  return <Badge variant={meta.variant} className="shrink-0 gap-1"><Icon className={status === 'running' || status === 'cancelling' ? 'size-3 animate-spin' : 'size-3'} aria-hidden="true" />{meta.label}</Badge>
}

/** 返回传输状态的图标、标签和 Badge 语义。 */
function statusMeta(status: ServerOpsTransferSnapshot['status']): { label: string; icon: typeof Clock3; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  if (status === 'running') return { label: '传输中', icon: LoaderCircle, variant: 'default' }
  if (status === 'queued') return { label: '排队中', icon: Clock3, variant: 'secondary' }
  if (status === 'cancelling') return { label: '取消中', icon: LoaderCircle, variant: 'secondary' }
  if (status === 'succeeded') return { label: '已完成', icon: CheckCircle2, variant: 'outline' }
  if (status === 'pending-check') return { label: '待检查', icon: AlertTriangle, variant: 'destructive' }
  if (status === 'unknown') return { label: '结果未知', icon: AlertTriangle, variant: 'destructive' }
  return { label: '失败', icon: AlertTriangle, variant: 'destructive' }
}

/** 只把稳定错误码映射为用户可理解的文案。 */
export function getTransferErrorMessage(code: string): string {
  if (code === 'SERVER_OPS_TRANSFER_RESULT_UNKNOWN') return '传输结果未知，请检查源文件和目标文件。'
  if (code === 'SERVER_OPS_TRANSFER_CANCELLED') return '传输已取消。'
  if (code === 'SERVER_OPS_TRANSFER_DESTINATION_EXISTS') return '目标文件已存在。'
  if (code === 'SERVER_OPS_TRANSFER_FILE_TOO_LARGE') return '文件超过 1 GiB 限制。'
  if (code === 'SERVER_OPS_TRANSFER_HASH_MISMATCH') return '文件完整性校验失败。'
  return '文件传输失败。'
}

/** 以稳定单位显示公开字节数。 */
function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`
  return `${(bytes / 1_073_741_824).toFixed(1)} GiB`
}
