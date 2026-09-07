import * as React from 'react'
import {
  ArrowUp,
  Download,
  File,
  FileCode,
  Folder,
  FolderPlus,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import type {
  ServerOpsFileCandidate,
  ServerOpsFileEntry,
  ServerOpsFileKind,
  ServerOpsFileMutationInput,
  ServerOpsFilePreviewResult,
} from '@proma/shared'
import type { ServerOpsFilesPreload } from '../../../preload/server-ops-files-preload'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

export interface ServerOpsFilesPanelProps {
  api: ServerOpsFilesPreload
  hostId: string
  hostLabel: string
  hostDescription?: string
  active: boolean
  connected: boolean
  onUpload?: (directoryPath: string) => void
  onDownload?: (entry: ServerOpsFileEntry) => void
}

interface FileMutationDraft {
  action: 'mkdir' | 'rename' | 'save-as'
  path: string
  value: string
  content?: string
}

/** 将文件大小显示为紧凑但可比较的单位。 */
function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`
  return `${(bytes / 1_048_576).toFixed(1)} MiB`
}

/** 将 POSIX mode 公开为四位八进制权限。 */
function formatMode(mode: number): string { return (mode & 0o7777).toString(8).padStart(4, '0') }

/** 从绝对 POSIX 路径读取父目录。 */
function parentPath(path: string): string {
  if (path === '/') return '/'
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return `/${parts.join('/')}`
}

/** 将目录与子名称拼成规范展示路径。 */
function childPath(path: string, name: string): string { return path === '/' ? `/${name}` : `${path}/${name}` }

/** 从未知错误中只显示稳定错误码。 */
function publicError(error: unknown): string {
  const message = error instanceof Error && error.message.startsWith('SERVER_OPS_') ? error.message : 'SERVER_OPS_FILE_ACTION_FAILED'
  const labels: Record<string, string> = {
    SERVER_OPS_CONNECTION_CHANGED: '服务器连接已变化，请重新进入文件页。',
    SERVER_OPS_SFTP_PERMISSION_DENIED: '当前 SSH 账户没有访问权限。',
    SERVER_OPS_SFTP_NOT_FOUND: '目标已不存在，请刷新目录。',
    SERVER_OPS_SFTP_ALREADY_EXISTS: '目标已存在，未覆盖原文件。',
    SERVER_OPS_FILE_TARGET_CHANGED: '目标在确认前已变化，操作已取消。',
    SERVER_OPS_FILE_RESULT_UNKNOWN: '连接中断，远程结果未知；请刷新确认后再操作。',
    SERVER_OPS_SFTP_ATOMIC_SAVE_UNSUPPORTED: '服务器不支持安全替换，当前文件只能另存。',
    SERVER_OPS_AUDIT_WRITE_FAILED: '审计记录无法写入，操作未执行。',
  }
  return labels[message] ?? '文件操作失败，请刷新后重试。'
}

/** 为预览请求生成独立代次，目录请求和连续选择互不共享接纳状态。 */
export function createServerOpsFilePreviewGuard(): {
  begin(): number
  invalidate(): void
  accepts(generation: number): boolean
} {
  let generation = 0
  return {
    begin: () => ++generation,
    invalidate: () => { generation += 1 },
    accepts: (candidate) => candidate === generation,
  }
}

/** 远程文件浏览、预览和受控变更面板。 */
export function ServerOpsFilesPanel({
  api,
  hostId,
  hostLabel,
  hostDescription,
  active,
  connected,
  onUpload,
  onDownload,
}: ServerOpsFilesPanelProps): React.ReactElement {
  const [path, setPath] = React.useState('/')
  const [pathInput, setPathInput] = React.useState('/')
  const [entries, setEntries] = React.useState<ServerOpsFileEntry[]>([])
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState<ServerOpsFileEntry | null>(null)
  const [preview, setPreview] = React.useState<ServerOpsFilePreviewResult | null>(null)
  const [previewStatus, setPreviewStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [draftContent, setDraftContent] = React.useState('')
  const [mutationDraft, setMutationDraft] = React.useState<FileMutationDraft | null>(null)
  const [candidate, setCandidate] = React.useState<ServerOpsFileCandidate | null>(null)
  const [confirmationName, setConfirmationName] = React.useState('')
  const [mutating, setMutating] = React.useState(false)
  const requestGeneration = React.useRef(0)
  const previewGuard = React.useRef(createServerOpsFilePreviewGuard())

  /** 读取或续读目录；旧请求不得覆盖新的主机/路径。 */
  const loadDirectory = React.useCallback(async (nextPath: string, nextCursor?: string, preservePreview = false): Promise<void> => {
    const generation = ++requestGeneration.current
    if (!nextCursor && !preservePreview) {
      previewGuard.current.invalidate()
      setSelected(null)
      setPreview(null)
      setPreviewStatus('idle')
      setDraftContent('')
    }
    setStatus('loading')
    setError(null)
    try {
      const result = await api.listServerOpsFiles({ hostId, path: nextPath, ...(nextCursor ? { cursor: nextCursor } : {}) })
      if (generation !== requestGeneration.current) return
      setPath(result.path)
      setPathInput(result.path)
      setEntries((current) => nextCursor ? [...current, ...result.entries] : result.entries)
      setCursor(result.cursor ?? null)
      setStatus('ready')
    } catch (loadError) {
      if (generation !== requestGeneration.current) return
      setStatus('error')
      setError(publicError(loadError))
    }
  }, [api, hostId])

  /** 选择文件后读取有界预览；目录由双击进入。 */
  const loadPreview = React.useCallback(async (entry: ServerOpsFileEntry): Promise<void> => {
    const generation = previewGuard.current.begin()
    setSelected(entry)
    setPreview(null)
    if (entry.kind !== 'file' && entry.kind !== 'symlink') { setPreviewStatus('idle'); return }
    setPreviewStatus('loading')
    try {
      const result = await api.previewServerOpsFile({ hostId, path: entry.path })
      if (!previewGuard.current.accepts(generation)) return
      setPreview(result)
      setDraftContent(result.kind === 'text' ? result.content : '')
      setPreviewStatus('ready')
    } catch (previewError) {
      if (!previewGuard.current.accepts(generation)) return
      setPreviewStatus('error')
      setError(publicError(previewError))
    }
  }, [api, hostId])

  React.useEffect(() => {
    requestGeneration.current += 1
    previewGuard.current.invalidate()
    setPath('/')
    setPathInput('/')
    setEntries([])
    setCursor(null)
    setSelected(null)
    setPreview(null)
    if (active && connected) void loadDirectory('/')
    else setStatus('idle')
    return () => {
      requestGeneration.current += 1
      previewGuard.current.invalidate()
      void api.closeServerOpsFilesOwner({ hostId }).catch(() => undefined)
    }
  }, [active, api, connected, hostId, loadDirectory])

  /** 将本地表单转为严格 mutation DTO，并请求 Main 签发候选。 */
  const prepareMutation = React.useCallback(async (mutation: ServerOpsFileMutationInput): Promise<void> => {
    setMutating(true)
    try {
      const prepared = await api.prepareServerOpsFileMutation(mutation)
      setCandidate(prepared)
      setConfirmationName('')
      setMutationDraft(null)
    } catch (mutationError) { toast.error(publicError(mutationError)) }
    finally { setMutating(false) }
  }, [api])

  /** 提交只携带 candidate 和手动确认名，正文与路径从 Main 候选读取。 */
  const commitMutation = React.useCallback(async (): Promise<void> => {
    if (!candidate || mutating) return
    setMutating(true)
    try {
      const result = await api.commitServerOpsFileMutation({ hostId, candidateId: candidate.candidateId, confirmationName })
      setCandidate(null)
      toast.success(result.warning ? '操作已完成，但审计结果写入失败。' : '文件操作已完成。')
      await loadDirectory(path)
      setSelected(null)
      setPreview(null)
    } catch (mutationError) {
      setCandidate(null)
      toast.error(publicError(mutationError))
      /** 提交失败时刷新目录事实，但保留用户草稿供修正或另存。 */
      await loadDirectory(path, undefined, true)
    }
    finally { setMutating(false) }
  }, [api, candidate, confirmationName, hostId, loadDirectory, mutating, path])

  /** 取消尚未提交的候选并清空确认框。 */
  const cancelCandidate = React.useCallback((): void => {
    if (candidate) void api.cancelServerOpsFileMutation({ hostId, candidateId: candidate.candidateId }).catch(() => undefined)
    setCandidate(null)
    setConfirmationName('')
  }, [api, candidate, hostId])

  const filteredEntries = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return normalized ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(normalized)) : entries
  }, [entries, query])

  if (!connected) return <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">连接服务器后浏览远程文件。</div>

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-server-ops-files-panel>
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <Button type="button" variant="ghost" size="icon" className="size-8" title="返回父目录" disabled={path === '/' || status === 'loading'} onClick={() => void loadDirectory(parentPath(path))}><ArrowUp className="size-4" /></Button>
        <Input aria-label="远程目录路径" className="h-8 min-w-48 flex-1 font-mono text-xs" value={pathInput} onChange={(event) => setPathInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void loadDirectory(pathInput) }} />
        <Button type="button" size="sm" variant="secondary" disabled={status === 'loading'} onClick={() => void loadDirectory(pathInput)}>前往</Button>
        <Button type="button" variant="ghost" size="icon" className="size-8" title="刷新目录" disabled={status === 'loading'} onClick={() => void loadDirectory(path)}><RefreshCw className={cn('size-4', status === 'loading' && 'animate-spin')} /></Button>
        <Button type="button" size="sm" variant="outline" disabled={!onUpload} onClick={() => onUpload?.(path)}><Upload className="size-4" />上传</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setMutationDraft({ action: 'mkdir', path, value: '' })}><FolderPlus className="size-4" />新建目录</Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col @container">
        <div className="grid min-h-0 flex-1 grid-cols-1 @min-[760px]:grid-cols-[minmax(340px,1fr)_minmax(300px,0.9fr)]">
          <section className="flex min-h-0 flex-col border-b border-border @min-[760px]:border-b-0 @min-[760px]:border-r" aria-label="远程目录">
            <div className="relative border-b border-border p-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="搜索已加载文件" className="h-8 pl-8 text-xs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前已加载列表" />
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {status === 'error' ? <div className="p-4 text-sm text-destructive">{error}</div>
                : status === 'loading' && entries.length === 0 ? <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取目录</div>
                : filteredEntries.length === 0 ? <div className="p-4 text-sm text-muted-foreground">当前目录没有可显示项目。</div>
                : <table className="w-full table-fixed text-left text-xs">
                    <thead className="sticky top-0 bg-background text-muted-foreground"><tr><th className="w-[48%] px-3 py-2 font-medium">名称</th><th className="w-20 px-2 py-2 font-medium">大小</th><th className="w-16 px-2 py-2 font-medium">权限</th><th className="px-2 py-2 font-medium">修改时间</th></tr></thead>
                    <tbody>{filteredEntries.map((entry) => <FileRow key={entry.path} entry={entry} selected={selected?.path === entry.path} onSelect={() => void loadPreview(entry)} onOpen={() => { if (entry.kind === 'directory') void loadDirectory(entry.path) }} />)}</tbody>
                  </table>}
            </div>
            {cursor ? <div className="border-t border-border p-2"><Button type="button" size="sm" variant="secondary" disabled={status === 'loading'} onClick={() => void loadDirectory(path, cursor)}>加载更多</Button><span className="ml-2 text-xs text-muted-foreground">已加载 {entries.length} 项</span></div> : null}
          </section>
          <section className="flex min-h-0 flex-col" aria-label="文件预览">
            <div className="flex h-11 items-center justify-between gap-2 border-b border-border px-3">
              <div className="min-w-0 truncate text-xs font-medium">{selected?.path ?? '选择文件以预览'}</div>
              {selected ? <div className="flex shrink-0 gap-1">
                {selected.kind === 'file' ? <Button type="button" variant="ghost" size="icon" className="size-8" title="下载" disabled={!onDownload} onClick={() => onDownload?.(selected)}><Download className="size-4" /></Button> : null}
                <Button type="button" variant="ghost" size="icon" className="size-8" title="重命名" onClick={() => setMutationDraft({ action: 'rename', path: selected.path, value: selected.name })}><FileCode className="size-4" /></Button>
                <Button type="button" variant="ghost" size="icon" className="size-8 text-destructive" title="删除" onClick={() => void prepareMutation({ hostId, action: 'delete', path: selected.path, targetKind: selected.kind === 'directory' ? 'directory' : selected.kind === 'symlink' ? 'symlink' : 'file' })}><Trash2 className="size-4" /></Button>
              </div> : null}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {previewStatus === 'loading' ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取预览</div>
                : preview?.kind === 'text' ? <Textarea aria-label="远程文本内容" className="min-h-[260px] resize-none font-mono text-xs" value={draftContent} onChange={(event) => setDraftContent(event.target.value)} />
                : preview?.kind === 'binary' ? <PreviewNotice icon={Download} title="二进制文件" detail={`已识别 ${formatBytes(preview.bytesRead)}，请使用下载。`} />
                : preview?.kind === 'too-large' ? <PreviewNotice icon={Download} title="文件超过预览上限" detail={`大小 ${formatBytes(preview.stat.size)}，请使用下载。`} />
                : preview?.kind === 'symlink' ? <PreviewNotice icon={File} title="符号链接不会自动跟随" detail={`目标：${preview.target}`} />
                : <PreviewNotice icon={File} title="未选择可预览文件" detail="" />}
            </div>
            {preview?.kind === 'text' ? <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-2">
              <span className="text-xs text-muted-foreground">{formatBytes(preview.bytesRead)} · UTF-8</span>
              <div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setMutationDraft({ action: 'save-as', path: preview.path, value: childPath(parentPath(preview.path), `${selected?.name ?? 'copy'}.copy`), content: draftContent })}>另存</Button><Button type="button" size="sm" disabled={draftContent === preview.content || mutating} onClick={() => void prepareMutation({ hostId, action: 'save', path: preview.path, content: draftContent, editToken: preview.editToken })}><Save className="size-4" />保存</Button></div>
            </div> : null}
          </section>
        </div>
      </div>

      <Dialog open={mutationDraft !== null} onOpenChange={(open) => { if (!open) setMutationDraft(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{mutationDraft?.action === 'mkdir' ? '新建远程目录' : mutationDraft?.action === 'rename' ? '重命名远程项目' : '另存远程文本'}</DialogTitle><DialogDescription>目标位于 {hostLabel}{hostDescription ? `（${hostDescription}）` : ''}。路径按远程 SSH 账户权限处理。</DialogDescription></DialogHeader>
          <Input autoFocus aria-label="文件动作目标" value={mutationDraft?.value ?? ''} onChange={(event) => setMutationDraft((current) => current ? { ...current, value: event.target.value } : null)} />
          <DialogFooter><Button type="button" variant="outline" onClick={() => setMutationDraft(null)}>取消</Button><Button type="button" disabled={!mutationDraft?.value.trim() || mutating} onClick={() => {
            if (!mutationDraft) return
            const target = mutationDraft.value.startsWith('/') ? mutationDraft.value : childPath(mutationDraft.path, mutationDraft.value)
            if (mutationDraft.action === 'mkdir') void prepareMutation({ hostId, action: 'mkdir', path: target })
            else if (mutationDraft.action === 'rename') void prepareMutation({ hostId, action: 'rename', path: mutationDraft.path, destinationPath: mutationDraft.value.startsWith('/') ? mutationDraft.value : childPath(parentPath(mutationDraft.path), mutationDraft.value) })
            else void prepareMutation({ hostId, action: 'save-as', path: target, content: mutationDraft.content ?? '' })
          }}>继续确认</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={candidate !== null} onOpenChange={(open) => { if (!open) cancelCandidate() }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>确认远程文件操作</AlertDialogTitle><AlertDialogDescription>服务器：{candidate?.hostName}<br />动作：{candidate ? mutationLabel(candidate.action) : ''}<br />目标：<span className="break-all font-mono">{candidate?.path}</span>{candidate?.destinationPath ? <><br />新路径：<span className="break-all font-mono">{candidate.destinationPath}</span></> : null}<br />检测到文件变化时会停止操作。多人同时编辑时，建议另存为新文件。</AlertDialogDescription></AlertDialogHeader>
          <Input aria-label="输入服务器名称确认" placeholder={`输入“${candidate?.hostName ?? ''}”确认`} value={confirmationName} onChange={(event) => setConfirmationName(event.target.value)} />
          <AlertDialogFooter><AlertDialogCancel disabled={mutating} onClick={cancelCandidate}>取消</AlertDialogCancel><AlertDialogAction disabled={mutating || confirmationName !== candidate?.hostName} onClick={(event) => { event.preventDefault(); void commitMutation() }}>{mutating ? <LoaderCircle className="size-4 animate-spin" /> : null}确认执行</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function FileRow({ entry, selected, onSelect, onOpen }: { entry: ServerOpsFileEntry; selected: boolean; onSelect(): void; onOpen(): void }): React.ReactElement {
  const Icon = entry.kind === 'directory' ? Folder : File
  return <tr className={cn('border-t border-border/60 hover:bg-muted/40', selected && 'bg-muted')}><td className="px-2 py-1"><button type="button" className="flex h-8 w-full items-center gap-2 overflow-hidden rounded-sm px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onSelect} onDoubleClick={onOpen}><Icon className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{entry.name}</span></button></td><td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{entry.kind === 'file' ? formatBytes(entry.size) : '—'}</td><td className="px-2 py-1 font-mono text-muted-foreground">{formatMode(entry.mode)}</td><td className="truncate px-2 py-1 text-muted-foreground">{new Date(entry.mtime * 1_000).toLocaleString()}</td></tr>
}

function PreviewNotice({ icon: Icon, title, detail }: { icon: React.ComponentType<{ className?: string }>; title: string; detail: string }): React.ReactElement { return <div className="flex min-h-40 flex-col items-center justify-center text-center"><Icon className="mb-3 size-8 text-muted-foreground" /><div className="text-sm font-medium">{title}</div><div className="mt-1 max-w-md break-all text-xs text-muted-foreground">{detail}</div></div> }
function mutationLabel(action: ServerOpsFileCandidate['action']): string { return ({ mkdir: '新建目录', rename: '重命名', delete: '删除', save: '替换保存', 'save-as': '另存新文件' })[action] }

/** 文件类型展示映射留给后续筛选与传输视图复用。 */
export const SERVER_OPS_FILE_KIND_LABELS: Record<ServerOpsFileKind, string> = { file: '文件', directory: '目录', symlink: '符号链接', other: '其他' }
