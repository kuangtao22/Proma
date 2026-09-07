import * as React from 'react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

/** 切换主机、关闭运维标签和收起工作区共用传输退出确认。 */
export function useServerOpsTransferLeave(scopeKey: string | null): { requestLeave(action: () => void): void; dialog: React.ReactNode } {
  const [count, setCount] = React.useState(0)
  const [closing, setClosing] = React.useState(false)
  /** 待确认动作仅存在本组件内存，卸载后不会导航到陈旧目标。 */
  const pendingAction = React.useRef<(() => void) | null>(null)
  const checking = React.useRef(false)
  const generation = React.useRef(0)

  React.useEffect(() => {
    generation.current += 1
    pendingAction.current = null
    checking.current = false
    setCount(0)
    setClosing(false)
    return () => { generation.current += 1; pendingAction.current = null }
  }, [scopeKey])

  /** 资源收口成功之后才提交导航，失败保留当前界面。 */
  const finish = async (action: () => void, current: number): Promise<void> => {
    setClosing(true)
    try {
      await window.electronAPI.closeServerOpsTransferOwner({})
      if (generation.current !== current) return
      pendingAction.current = null
      setCount(0)
      action()
    } catch { if (generation.current === current) toast.error('传输尚未完成清理，请稍后重试。') }
    finally { if (generation.current === current) { setClosing(false); checking.current = false } }
  }

  /** 从 Main 读取真实活动数，不依赖可能滞后的页面进度。 */
  const requestLeave = (action: () => void): void => {
    if (checking.current || pendingAction.current) return
    checking.current = true
    const current = generation.current
    void window.electronAPI.listServerOpsTransfers({}).then(async (snapshots) => {
      if (generation.current !== current) return
      const active = snapshots.filter((snapshot) => ['queued', 'running', 'cancelling'].includes(snapshot.status))
      if (active.length === 0) { await finish(action, current); return }
      pendingAction.current = action
      setCount(active.length)
      checking.current = false
    }).catch(() => {
      if (generation.current !== current) return
      checking.current = false
      toast.error('无法确认文件传输状态，请稍后重试。')
    })
  }

  return { requestLeave, dialog: <AlertDialog open={count > 0} onOpenChange={(open) => {
    if (!open && !closing) { pendingAction.current = null; setCount(0) }
  }}>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>仍有 {count} 项文件传输</AlertDialogTitle><AlertDialogDescription>离开会取消这些传输。已经开始提交的文件可能需要检查最终结果。</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel disabled={closing}>继续传输</AlertDialogCancel><AlertDialogAction disabled={closing} onClick={(event) => {
        event.preventDefault()
        const action = pendingAction.current
        if (action) void finish(action, generation.current)
      }}>{closing ? '正在取消...' : '取消传输并离开'}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog> }
}
