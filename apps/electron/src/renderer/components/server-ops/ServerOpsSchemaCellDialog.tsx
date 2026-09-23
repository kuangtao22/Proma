import * as React from 'react'
import { atom, useAtom } from 'jotai'
import { Copy, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { JsonCodeEditor } from '@/components/ui/json-code-editor'
import { cn } from '@/lib/utils'
import type { ServerOpsSchemaCellDetail } from './server-ops-schema-controller'
import { formatServerOpsJsonLosslessly } from './server-ops-json-formatter'

/** 单元格文本展示模式。 */
type ServerOpsSchemaCellTextMode = 'raw' | 'json'

/** 单元格详情弹窗属性。 */
export interface ServerOpsSchemaCellDialogProps {
  detail: ServerOpsSchemaCellDetail
  onClose: () => void
}

/** 将完整详情值转成可复制文本；二进制只提供事实摘要。 */
function getCellDetailText(detail: ServerOpsSchemaCellDetail): string | null {
  if (detail.status !== 'ready' || detail.value === undefined) return null
  if (detail.value === null) return 'NULL'
  if (typeof detail.value === 'string') return detail.value
  return `二进制 · ${detail.value.bytes} B`
}

/** 可独立验证的详情正文；单元格正文仅存在于当前组件内存。 */
export function ServerOpsSchemaCellDialogContent({ detail }: Pick<ServerOpsSchemaCellDialogProps, 'detail'>): React.ReactElement {
  /** 临时 Dialog 状态不进入全局 Store，也不持久化正文。 */
  const [uiAtom] = React.useState(() => atom<{ mode: ServerOpsSchemaCellTextMode; copied: boolean; copyError: string | null }>({ mode: 'raw', copied: false, copyError: null }))
  /** 当前展示模式与复制反馈。 */
  const [ui, setUi] = useAtom(uiAtom)
  /** 完整字符串的无损 JSON 格式化结果。 */
  const json = React.useMemo(() => detail.status === 'ready' && typeof detail.value === 'string'
    ? formatServerOpsJsonLosslessly(detail.value) : null, [detail])
  /** 当前实际展示与复制的文本。 */
  const currentText = React.useMemo(() => {
    /** 完整原文或二进制/NULL 摘要。 */
    const raw = getCellDetailText(detail)
    return ui.mode === 'json' && json?.valid ? json.formatted : raw
  }, [detail, json, ui.mode])

  React.useEffect(() => { setUi({ mode: 'raw', copied: false, copyError: null }) }, [detail, setUi])

  /** 复制当前可见内容，失败时保留按钮供重试。 */
  const copyCurrent = async (): Promise<void> => {
    if (currentText === null) return
    try { await navigator.clipboard.writeText(currentText); setUi((previous) => ({ ...previous, copied: true, copyError: null })) } catch {
      setUi((previous) => ({ ...previous, copied: false, copyError: '复制失败，请检查系统剪贴板权限后重试' }))
    }
  }

  /** 切换展示模式时清除不再对应当前内容的复制反馈。 */
  const selectMode = (mode: ServerOpsSchemaCellTextMode): void => setUi({ mode, copied: false, copyError: null })

  /** 旧预览缺少摘要时只能明确展示有损预览。 */
  const unavailablePreview = detail.status === 'unavailable' && detail.preview !== null
    && typeof detail.preview === 'object' && detail.preview.kind === 'text'
    ? detail.preview.text : null
  /** 格式化预算限制与语法错误分开说明。 */
  const jsonLimitation = json?.limitation === 'too-deep' ? 'JSON 嵌套过深，已保留原文'
    : json?.limitation === 'too-large' ? 'JSON 格式化结果过大，已保留原文' : null

  return <>
      <DialogHeader className="shrink-0 border-b border-border/50 px-5 py-4 pr-12">
        <DialogTitle className="truncate text-base" title={detail.column}>{detail.column} · 第 {detail.absoluteOffset + 1} 行</DialogTitle>
        <DialogDescription>查看完整内容，支持原文与 JSON 格式化。</DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-5">
        {detail.status === 'loading' ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取完整内容…</div> : null}
        {detail.status === 'error' || detail.status === 'unavailable' ? <div role="alert" className="rounded-md bg-destructive/5 px-3 py-2 text-xs text-destructive">{detail.error ?? '单元格读取失败'}</div> : null}
        {detail.status === 'unavailable' ? <p className="text-xs text-muted-foreground">当前仅显示截断预览，不能视为完整内容。</p> : null}
        {detail.status === 'ready' && typeof detail.value === 'string' ? <>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            <Button type="button" size="sm" variant={ui.mode === 'raw' ? 'secondary' : 'ghost'} onClick={() => selectMode('raw')}>原文</Button>
            {json?.valid && json.limitation === undefined ? <Button type="button" size="sm" variant={ui.mode === 'json' ? 'secondary' : 'ghost'} onClick={() => selectMode('json')}>JSON 格式化</Button> : <span className="min-w-0 basis-full text-xs text-muted-foreground sm:ml-2 sm:basis-auto">{jsonLimitation ?? '内容不是有效 JSON，仅显示原文'}</span>}
            <Button type="button" size="sm" variant="outline" className="ml-auto" aria-label="复制当前内容" onClick={() => { void copyCurrent() }}><Copy className="size-3.5" />{ui.copied ? '已复制' : '复制当前内容'}</Button>
          </div>
          {ui.copyError ? <p role="alert" className="text-xs text-destructive">{ui.copyError}</p> : null}
          <JsonCodeEditor value={currentText ?? ''} ariaLabel={ui.mode === 'json' ? '格式化后的单元格 JSON' : '单元格原文'} className="min-h-0 flex-1" />
        </> : null}
        {detail.status === 'ready' && detail.value !== undefined && typeof detail.value !== 'string' ? <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap justify-end gap-2"><Button type="button" size="sm" variant="outline" aria-label="复制当前内容" onClick={() => { void copyCurrent() }}><Copy className="size-3.5" />{ui.copied ? '已复制' : '复制当前内容'}</Button></div>
          {ui.copyError ? <p role="alert" className="text-xs text-destructive">{ui.copyError}</p> : null}
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-4 font-mono text-sm">{currentText}</pre>
        </div> : null}
        {unavailablePreview !== null ? <JsonCodeEditor value={unavailablePreview} ariaLabel="单元格截断预览" className={cn('min-h-0 flex-1', detail.status !== 'unavailable' && 'hidden')} /> : null}
      </div>
  </>
}

/** 单元格详情仅保留在当前 Dialog 生命周期，不持久化正文。 */
export function ServerOpsSchemaCellDialog({ detail, onClose }: ServerOpsSchemaCellDialogProps): React.ReactElement {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="z-[260] flex h-[min(78vh,44rem)] max-w-3xl flex-col gap-3 overflow-hidden p-0" overlayClassName="z-[250]">
      <ServerOpsSchemaCellDialogContent detail={detail} />
    </DialogContent>
  </Dialog>
}
