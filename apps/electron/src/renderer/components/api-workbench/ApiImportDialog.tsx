import * as React from 'react'
import type { ApiCatalogSnapshot, ApiRequestDraft } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { previewApiWorkbenchImport } from './api-workbench-model'
import type { ApiWorkbenchImportPreview } from './api-workbench-model'

/** 导入对话框属性：只负责预览与确认，真实写入由调用方决定。 */
export interface ApiImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 导入 cURL 草稿：新增编辑标签，不自动保存。 */
  onImportDrafts: (drafts: ApiRequestDraft[]) => void
  /** 导入集合快照：作为新增资产写入目录。 */
  onImportSnapshot: (snapshot: ApiCatalogSnapshot) => Promise<void>
}

/** 接口导入对话框：粘贴 cURL 或集合快照，先预览再导入。 */
export function ApiImportDialog({ open, onOpenChange, onImportDrafts, onImportSnapshot }: ApiImportDialogProps): React.ReactElement {
  /** 当前粘贴内容。 */
  const [text, setText] = React.useState('')
  /** 解析预览；空输入时为 null。 */
  const [preview, setPreview] = React.useState<ApiWorkbenchImportPreview | null>(null)
  /** 快照写入进行中标记。 */
  const [importing, setImporting] = React.useState(false)

  /** 关闭后清空，避免下次打开残留上一次粘贴的内容。 */
  React.useEffect(() => {
    if (open) return
    setText('')
    setPreview(null)
    setImporting(false)
  }, [open])

  /** 更新粘贴内容并重新生成预览；空白内容直接清空预览。 */
  const analyze = (value: string): void => {
    setText(value)
    setPreview(value.trim() === '' ? null : previewApiWorkbenchImport(value))
  }

  /** 确认导入：cURL 打开草稿标签，快照追加到目录。 */
  const confirm = async (): Promise<void> => {
    if (!preview) return
    if (preview.kind === 'curl') {
      onImportDrafts(preview.drafts)
      onOpenChange(false)
      return
    }
    if (preview.kind !== 'catalog') return
    setImporting(true)
    try {
      await onImportSnapshot(preview.snapshot)
      onOpenChange(false)
    } finally {
      setImporting(false)
    }
  }

  /** 当前预览是否具备可执行的导入动作。 */
  const canImport = preview !== null && preview.kind !== 'error'
    && (preview.kind === 'curl' ? preview.drafts.length > 0 : true)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>导入接口</DialogTitle>
          <DialogDescription>粘贴浏览器「Copy as cURL」内容或 DutyDeck 集合快照 JSON。不会执行 shell 命令，也不会读取本机文件。</DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          aria-label="粘贴 cURL 或集合快照"
          onChange={(event) => analyze(event.target.value)}
          placeholder="curl 'https://api.example.com/users' -H 'Authorization: Bearer ...'"
          className="min-h-[160px] font-mono text-xs"
        />
        {preview === null && <p className="text-xs text-muted-foreground">粘贴内容后这里会显示识别结果。</p>}
        {preview?.kind === 'error' && <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{preview.message}</p>}
        {preview?.kind === 'curl' && (
          <div className="space-y-1 text-xs">
            <p>识别到 {preview.drafts.length} 条请求：{preview.drafts.map((draft) => `${draft.method} ${draft.url}`).join('；')}</p>
            {preview.unsupported.length > 0 && (
              <div className="rounded-md bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-400">未支持：{preview.unsupported.join('；')}</div>
            )}
            {preview.warnings.length > 0 && <div className="text-muted-foreground">{preview.warnings.join('；')}</div>}
            <p className="text-muted-foreground">导入后先作为草稿打开，确认无误再保存到集合。</p>
          </div>
        )}
        {preview?.kind === 'catalog' && (
          <div className="space-y-1 text-xs">
            <p>快照包含 {preview.counts.collections} 个集合、{preview.counts.environments} 个环境、{preview.counts.requests} 条请求，全部作为新增内容导入，不覆盖现有资产。</p>
            {preview.emptiedSecrets.length > 0 && (
              <div className="rounded-md bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-400">
                需要重新填写 {preview.emptiedSecrets.length} 处秘密：{preview.emptiedSecrets.join('；')}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" disabled={!canImport || importing} onClick={() => void confirm()}>{importing ? '导入中…' : '确认导入'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
