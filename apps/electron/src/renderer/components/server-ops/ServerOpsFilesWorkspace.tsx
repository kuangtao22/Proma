import * as React from 'react'
import { Upload, LoaderCircle } from 'lucide-react'
import type { ServerOpsFileEntry, ServerOpsLocalFileSelection, ServerOpsTransferSnapshot } from '@proma/shared'
import type { ServerOpsTransferPreload } from '../../../preload/server-ops-transfer-preload'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { ServerOpsFilesPanel } from './ServerOpsFilesPanel'
import type { ServerOpsFilesPanelProps } from './ServerOpsFilesPanel'
import { ServerOpsTransfersPanel, getTransferErrorMessage } from './ServerOpsTransfersPanel'

/** 文件浏览与当前窗口传输使用同一主机上下文。 */
export interface ServerOpsFilesWorkspaceProps extends ServerOpsFilesPanelProps {
  transferApi: ServerOpsTransferPreload
}

/** 同一毫秒内，终态不能被先发后到的启动快照覆盖。 */
function terminalTransfer(snapshot: ServerOpsTransferSnapshot): boolean {
  return !['queued', 'running', 'cancelling'].includes(snapshot.status)
}

/** 将初次快照与推送按传输 ID 合并，保留最新事实并限制本地历史。 */
export function mergeServerOpsTransferSnapshots(current: readonly ServerOpsTransferSnapshot[], incoming: readonly ServerOpsTransferSnapshot[]): ServerOpsTransferSnapshot[] {
  const snapshots = new Map(current.map((snapshot) => [snapshot.transferId, snapshot]))
  for (const snapshot of incoming) {
    const previous = snapshots.get(snapshot.transferId)
    if (!previous || snapshot.updatedAt > previous.updatedAt || (snapshot.updatedAt === previous.updatedAt && (!terminalTransfer(previous) || terminalTransfer(snapshot)))) {
      snapshots.set(snapshot.transferId, snapshot)
    }
  }
  return [...snapshots.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, 100)
}

/** 组合文件浏览、系统文件选择、上传确认和事件驱动的传输状态。 */
export function ServerOpsFilesWorkspace({ transferApi, ...files }: ServerOpsFilesWorkspaceProps): React.ReactElement {
  const [transfers, setTransfers] = React.useState<ServerOpsTransferSnapshot[]>([])
  const [uploadSelection, setUploadSelection] = React.useState<ServerOpsLocalFileSelection | null>(null)
  const [uploadPath, setUploadPath] = React.useState('')
  const [starting, setStarting] = React.useState(false)
  /** 组件重挂载/主机切换后，旧选择器结果不得启动新传输。 */
  const generation = React.useRef(0)
  const pendingLease = React.useRef<string | null>(null)

  React.useEffect(() => {
    const current = ++generation.current
    setTransfers([])
    const accept = (snapshots: ServerOpsTransferSnapshot[]): void => {
      if (generation.current !== current) return
      setTransfers((previous) => mergeServerOpsTransferSnapshots(previous, snapshots.filter((snapshot) => snapshot.hostId === files.hostId)))
    }
    const unsubscribe = transferApi.onServerOpsTransferProgress((snapshot) => accept([snapshot]))
    void transferApi.listServerOpsTransfers({ hostId: files.hostId }).then(accept).catch(() => {
      if (generation.current === current) toast.error('文件传输列表读取失败。')
    })
    return () => {
      generation.current += 1
      unsubscribe()
      if (pendingLease.current) void transferApi.releaseServerOpsFileSelection({ leaseId: pendingLease.current }).catch(() => undefined)
      pendingLease.current = null
    }
  }, [files.hostId, transferApi])

  /** 上传先取得系统 fd，再由用户确认精确远程目标。 */
  const selectUpload = async (directoryPath: string): Promise<void> => {
    if (starting) return
    const current = generation.current
    setStarting(true)
    try {
      const selection = await transferApi.selectServerOpsUploadFile({ hostId: files.hostId })
      if (!selection) return
      if (current !== generation.current) { await transferApi.releaseServerOpsFileSelection({ leaseId: selection.leaseId }); return }
      pendingLease.current = selection.leaseId
      setUploadSelection(selection)
      setUploadPath(`${directoryPath === '/' ? '' : directoryPath}/${selection.fileName}`)
    } catch { if (current === generation.current) toast.error('无法打开上传文件。') }
    finally { if (current === generation.current) setStarting(false) }
  }

  /** 取消尚未开始的上传，只释放本次文件选择。 */
  const dismissUpload = (): void => {
    if (starting) return
    if (pendingLease.current) void transferApi.releaseServerOpsFileSelection({ leaseId: pendingLease.current }).catch(() => undefined)
    pendingLease.current = null
    setUploadSelection(null)
  }

  /** 确认后领取一次性 lease 并加入有界上传队列。 */
  const startUpload = async (): Promise<void> => {
    if (!uploadSelection || starting) return
    const current = generation.current
    setStarting(true)
    try {
      const snapshot = await transferApi.startServerOpsTransfer({ hostId: files.hostId, direction: 'upload', leaseId: uploadSelection.leaseId, remotePath: uploadPath })
      pendingLease.current = null
      if (current !== generation.current) return
      setTransfers((previous) => mergeServerOpsTransferSnapshots(previous, [snapshot]))
      setUploadSelection(null)
    } catch { if (current === generation.current) toast.error('上传无法开始，请重新选择文件或检查连接。') }
    finally { if (current === generation.current) setStarting(false) }
  }

  /** 下载目标由系统保存对话框确认，已有文件不会被覆盖。 */
  const download = async (entry: ServerOpsFileEntry): Promise<void> => {
    if (starting) return
    const current = generation.current
    setStarting(true)
    let leaseId: string | undefined
    try {
      const selection = await transferApi.selectServerOpsDownloadFile({ hostId: files.hostId, fileName: entry.name })
      if (!selection) return
      leaseId = selection.leaseId
      if (current !== generation.current) return
      const snapshot = await transferApi.startServerOpsTransfer({ hostId: files.hostId, direction: 'download', leaseId, remotePath: entry.path })
      leaseId = undefined
      if (current === generation.current) setTransfers((previous) => mergeServerOpsTransferSnapshots(previous, [snapshot]))
    } catch { if (current === generation.current) toast.error('下载无法开始，请检查连接及本地保存位置。') }
    finally {
      if (leaseId) await transferApi.releaseServerOpsFileSelection({ leaseId }).catch(() => undefined)
      if (current === generation.current) setStarting(false)
    }
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <ServerOpsFilesPanel {...files} onUpload={(path) => { void selectUpload(path) }} onDownload={(entry) => { void download(entry) }} />
    {transfers.length > 0 && <div className="max-h-48 shrink-0 overflow-y-auto"><ServerOpsTransfersPanel transfers={transfers} onCancel={(transfer) => {
      void transferApi.cancelServerOpsTransfer({ hostId: transfer.hostId, transferId: transfer.transferId }).catch(() => toast.error(getTransferErrorMessage('SERVER_OPS_TRANSFER_CANCEL_FAILED')))
    }} /></div>}
    <Dialog open={uploadSelection !== null} onOpenChange={(open) => { if (!open) dismissUpload() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>上传文件</DialogTitle><DialogDescription>{files.hostLabel} · {uploadSelection?.fileName}。目标已存在时将停止上传。</DialogDescription></DialogHeader>
        <Input aria-label="上传远程目标路径" value={uploadPath} onChange={(event) => setUploadPath(event.target.value)} disabled={starting} />
        <DialogFooter><Button variant="outline" disabled={starting} onClick={dismissUpload}>取消</Button><Button disabled={starting || !uploadPath.startsWith('/')} onClick={() => { void startUpload() }}>{starting ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}上传</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
