import * as React from 'react'
import type {
  AdoptCanvasImageCandidateBatchInput,
  CanvasImageCandidateBatchEntry,
  CanvasImageCandidateBatchSummary,
} from '@proma/shared'
import { Check, CircleAlert, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { cn } from '@/lib/utils'
import type { CanvasImageCandidateBatchViewState } from './use-canvas-image-candidate-batches'

/** 批次面板动作只接收命令，不直接调用 IPC。 */
export interface CanvasImageCandidateBatchPanelProps {
  summary: CanvasImageCandidateBatchSummary
  state: CanvasImageCandidateBatchViewState
  writable: boolean
  focusNodeId?: string
  nodeTitles?: ReadonlyMap<string, string>
  onLoad: () => void
  onContinue: () => void
  onAdopt: (mode: AdoptCanvasImageCandidateBatchInput['mode']) => void
  onAbandon: () => void
  onPreviewAsset?: (assetId: string) => void
}

/** 部分采用入口必须先确认；全量采用可直接提交。 */
export function createCandidateBatchAdoptRequest(
  mode: AdoptCanvasImageCandidateBatchInput['mode'],
  actions: { onConfirmPartial: () => void; onAdopt: (mode: AdoptCanvasImageCandidateBatchInput['mode']) => void },
): () => void {
  return mode === 'succeeded'
    ? actions.onConfirmPartial
    : () => actions.onAdopt('all')
}

/** 候选条目状态的稳定中文文案。 */
const ENTRY_STATUS_LABELS: Record<CanvasImageCandidateBatchEntry['status'], string> = {
  queued: '等待生成',
  running: '正在生成',
  candidate: '候选已就绪',
  failed: '生成失败',
  invalid: '候选已失效',
  adopted: '已采用',
  kept: '保留旧版',
}

/** 批次操作状态对应的进度提示。 */
const OPERATION_LABELS = {
  continuing: '正在补齐失败项',
  adopting: '正在采用候选',
  abandoning: '正在放弃批次',
} as const

/** 详情加载前的轻量批次摘要，不读取条目或候选图片。 */
function CandidateBatchSummary({
  summary,
  state,
  onLoad,
}: Pick<CanvasImageCandidateBatchPanelProps, 'summary' | 'state' | 'onLoad'>): React.ReactElement {
  return (
    <section className="space-y-2 rounded-sm border border-border bg-muted/25 p-3" aria-label="图片候选批次">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">候选批次</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {summary.candidateCount} / {summary.totalCount} 个候选已完成
          </p>
        </div>
        {summary.failedCount > 0 && <Badge variant="secondary" className="rounded-sm">部分完成</Badge>}
      </div>
      {summary.runningCount > 0 && <p className="text-xs text-muted-foreground">仍有 {summary.runningCount} 个节点正在运行</p>}
      {state.error && <p className="break-words text-xs text-destructive" role="alert">{state.error}</p>}
      <Button type="button" size="sm" variant="outline" disabled={state.phase === 'loading'} onClick={onLoad}>
        {state.phase === 'loading'
          ? <><LoaderCircle className="animate-spin" aria-hidden="true" />正在加载批次</>
          : '查看候选批次'}
      </Button>
    </section>
  )
}

/** Canvas 图片候选批次的按需验收面板。 */
export function CanvasImageCandidateBatchPanel({
  summary,
  state,
  writable,
  focusNodeId,
  nodeTitles,
  onLoad,
  onContinue,
  onAdopt,
  onAbandon,
  onPreviewAsset,
}: CanvasImageCandidateBatchPanelProps): React.ReactElement {
  const [confirmPartial, setConfirmPartial] = React.useState(false)
  if (!state.batch) return <CandidateBatchSummary summary={summary} state={state} onLoad={onLoad} />

  const batch = state.batch
  const focusedEntry = focusNodeId ? batch.entries.find((entry) => entry.nodeId === focusNodeId) : undefined
  const candidateCount = batch.entries.filter((entry) => entry.status === 'candidate').length
  const failedCount = batch.entries.filter((entry) => entry.status === 'failed' || entry.status === 'invalid').length
  const runningCount = batch.entries.filter((entry) => entry.status === 'queued' || entry.status === 'running').length
  const operating = state.operation !== 'idle'
  const canAdoptAll = batch.status === 'ready' && candidateCount === batch.entries.length
  const canAdoptSucceeded = candidateCount > 0 && failedCount > 0 && runningCount === 0

  return (
    <section className="space-y-3 border-y border-border bg-muted/20 px-3 py-3" aria-label="图片候选批次">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold">候选批次</h4>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {candidateCount} / {batch.entries.length} 个候选已完成
          </p>
        </div>
        <Badge variant={failedCount > 0 ? 'secondary' : 'outline'} className="rounded-sm">
          {failedCount > 0 ? '部分完成' : runningCount > 0 ? '生成中' : '可验收'}
        </Badge>
      </div>

      {focusedEntry && (
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="当前与候选版本">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!focusedEntry.initialAdoptedAssetId || !onPreviewAsset}
            onClick={() => {
              if (focusedEntry.initialAdoptedAssetId) onPreviewAsset?.(focusedEntry.initialAdoptedAssetId)
            }}
          >
            当前版本
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!focusedEntry.candidateAssetId || !onPreviewAsset}
            onClick={() => {
              if (focusedEntry.candidateAssetId) onPreviewAsset?.(focusedEntry.candidateAssetId)
            }}
          >
            候选版本
          </Button>
        </div>
      )}

      <ul className="max-h-44 space-y-1 overflow-y-auto" aria-label="候选批次节点">
        {batch.entries.map((entry) => (
          <li key={entry.nodeId} className="flex min-w-0 items-start justify-between gap-3 border-b border-border/60 py-1.5 text-xs last:border-b-0">
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{nodeTitles?.get(entry.nodeId) ?? entry.nodeId}</p>
              {entry.error && <p className="mt-0.5 line-clamp-2 break-words text-destructive">{entry.error}</p>}
            </div>
            <span className={cn('shrink-0 text-[11px]', entry.status === 'failed' || entry.status === 'invalid' ? 'text-destructive' : 'text-muted-foreground')}>
              {ENTRY_STATUS_LABELS[entry.status]}
            </span>
          </li>
        ))}
      </ul>

      {failedCount > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          仍有 {failedCount} 个节点保留旧版；采用成功项会形成新旧混合版本。
        </p>
      )}
      {state.error && <p className="break-words text-xs text-destructive" role="alert">{state.error}</p>}
      {operating && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
          {OPERATION_LABELS[state.operation as Exclude<typeof state.operation, 'idle'>]}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!writable || operating || !canAdoptAll} onClick={createCandidateBatchAdoptRequest('all', { onConfirmPartial: () => undefined, onAdopt })}>
          <Check aria-hidden="true" />全部采用
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!writable || operating || failedCount === 0} onClick={onContinue}>
          <RefreshCw aria-hidden="true" />继续补齐
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!writable || operating || !canAdoptSucceeded} onClick={createCandidateBatchAdoptRequest('succeeded', { onConfirmPartial: () => setConfirmPartial(true), onAdopt })}>
          采用成功项
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={!writable || operating} onClick={onAbandon}>
          <X aria-hidden="true" />放弃本批次
        </Button>
      </div>

      <ConfirmDialog
        open={confirmPartial}
        onOpenChange={setConfirmPartial}
        title="确认采用已成功项"
        description={`采用后仍有 ${failedCount} 个节点保留旧版，画布将暂时包含新旧混合版本。`}
        confirmLabel="确认采用成功项"
        variant="default"
        onConfirm={() => {
          setConfirmPartial(false)
          onAdopt('succeeded')
        }}
      />
    </section>
  )
}
