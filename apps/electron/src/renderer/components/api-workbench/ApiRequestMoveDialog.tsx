/**
 * 「移动到其他分组 / 集合」对话框。
 *
 * 只让人改归属：集合（端 / 产品线）与分组（模块文件夹）。
 * 分组给「集合根目录 / 已有分组 / 新建分组」三种选择，避免人凭空猜已有名字。
 */

import * as React from 'react'
import { FolderInput } from 'lucide-react'
import type { ApiCatalog, ApiRequestDefinition } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** 新建分组在下拉里的固定值；与真实分组名冲突的概率由 UI 保证（真名不允许等于它）。 */
const NEW_FOLDER = '__new_folder__'
/** 集合根目录的固定值。 */
const ROOT_FOLDER = '__root_folder__'

export interface ApiRequestMoveDialogProps {
  open: boolean
  /** 待移动的请求；为空时对话框不渲染内容。 */
  request: ApiRequestDefinition | null
  catalog: ApiCatalog
  onOpenChange: (open: boolean) => void
  onMove: (target: { collectionId: string; folder: string }) => void
}

export function ApiRequestMoveDialog({ open, request, catalog, onOpenChange, onMove }: ApiRequestMoveDialogProps): React.ReactElement {
  /** 目标集合默认沿用当前归属。 */
  const [collectionId, setCollectionId] = React.useState(request?.collectionId ?? '')
  /** 分组选择：根目录 / 已有分组 / 新建。 */
  const [folderChoice, setFolderChoice] = React.useState(ROOT_FOLDER)
  const [newFolder, setNewFolder] = React.useState('')
  /** 每次打开都按当前请求重置，避免沿用上一条的输入。 */
  React.useEffect(() => {
    if (!open || !request) return
    setCollectionId(request.collectionId)
    setFolderChoice(request.folder ? request.folder : ROOT_FOLDER)
    setNewFolder('')
  }, [open, request])
  /** 目标集合下已有的分组（去重排序），来自目录本身而不是手输。 */
  const folders = React.useMemo(() => [...new Set(
    catalog.requests
      .filter((item) => item.collectionId === collectionId && item.folder)
      .map((item) => item.folder),
  )].sort(), [catalog.requests, collectionId])
  const targetCollection = catalog.collections.find((item) => item.id === collectionId)
  const folder = folderChoice === NEW_FOLDER ? newFolder.trim() : folderChoice === ROOT_FOLDER ? '' : folderChoice
  /** 原地不动时禁用确认，避免无意义的写入。 */
  const unchanged = Boolean(request) && request!.collectionId === collectionId && request!.folder === folder
  const canSubmit = Boolean(targetCollection) && !unchanged
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>移动到其他分组 / 集合</DialogTitle>
          <DialogDescription>{request ? `把「${request.name}」挪到别处；接口内容不变。` : '选择一个请求后再移动。'}</DialogDescription>
        </DialogHeader>
        <div className="my-4 space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">目标集合（端 / 产品线）</span>
            <Select value={collectionId} onValueChange={(value) => { setCollectionId(value); setFolderChoice(ROOT_FOLDER) }}>
              <SelectTrigger aria-label="目标集合"><SelectValue placeholder="选择集合" /></SelectTrigger>
              <SelectContent>
                {catalog.collections.map((collection) => <SelectItem key={collection.id} value={collection.id}>{collection.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">目标分组（模块文件夹）</span>
            <Select value={folderChoice} onValueChange={setFolderChoice}>
              <SelectTrigger aria-label="目标分组"><SelectValue placeholder="选择分组" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ROOT_FOLDER}>（集合根目录）</SelectItem>
                {folders.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                <SelectItem value={NEW_FOLDER}>新建分组…</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {folderChoice === NEW_FOLDER && (
            <Input autoFocus value={newFolder} onChange={(event) => setNewFolder(event.target.value)} placeholder="新分组名称，例如 用户模块" aria-label="新建分组名称" />
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" disabled={!canSubmit} onClick={() => { if (request && canSubmit) onMove({ collectionId, folder }) }}>
            <FolderInput className="size-3.5" />移动
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
