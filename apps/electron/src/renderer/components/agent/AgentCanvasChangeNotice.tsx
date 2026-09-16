import * as React from 'react'
import { useAtomValue, useStore } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { toast } from 'sonner'
import { agentCanvasChangeNoticesAtom, openAgentCanvasChange } from '@/lib/agent-canvas-change-navigation'
import type { AgentCanvasChangeNotice as ChangeNotice } from '@/lib/agent-canvas-change-navigation'
import { nativeCanvasStatesAtom, createNativeCanvasKey } from '@/atoms/native-canvas-atoms'
import { Button } from '@/components/ui/button'

/** 修改摘要的宿主身份；名称来自已有目录，不为摘要额外读取画布。 */
interface AgentCanvasChangeNoticeProps {
  sessionId: string
  projectId: string
  canvasTitles: readonly { id: string; title: string }[]
}

/** 单张画布的摘要与节点入口；只订阅该图节点，LOAD 后自动补全可读标题。 */
function CanvasChangeRow({ notice, title, onOpen }: {
  notice: ChangeNotice
  title: string
  onOpen: (notice: ChangeNotice, nodeIds?: string[]) => Promise<void>
}): React.ReactElement {
  /** 图节点引用未变化时跳过进度和其它画布更新，摘要不读媒体。 */
  const nodesAtom = React.useMemo(() => selectAtom(nativeCanvasStatesAtom,
    states => states.get(createNativeCanvasKey(notice.projectId, notice.canvasId))?.snapshot?.document.nodes,
  ), [notice.projectId, notice.canvasId])
  const nodes = useAtomValue(nodesAtom)
  /** 名称索引一次构造，批量摘要不逐按钮扫描整张图。 */
  const nodeTitles = React.useMemo(() => new Map(nodes?.map(node => [node.id, node.title]) ?? []), [nodes])
  return <details className="py-1">
    <summary className="cursor-pointer text-muted-foreground">
      <span className="text-foreground">{title}</span> · 已更新 {notice.changes} 次
      {notice.deletedNodeIds?.length ? ` · 删除 ${notice.deletedNodeIds.length} 个节点` : ''}
    </summary>
    <div className="flex flex-wrap items-center gap-1 pt-1">
      <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => { void onOpen(notice) }}>查看位置</Button>
      {notice.nodeIds.map(nodeId => <Button key={nodeId} variant="ghost" size="sm" className="h-6 max-w-48 truncate text-xs"
        title={nodeId} onClick={() => { void onOpen(notice, [nodeId]) }}>
        {nodeTitles.get(nodeId) ?? nodeId}
      </Button>)}
      {!notice.nodeIds.length && <span className="text-muted-foreground">查看所属画布的变更</span>}
    </div>
  </details>
}

/** 当前聊天最近修改的画布及节点入口，连续回执合并且后台不抢焦点。 */
export function AgentCanvasChangeNotice({ sessionId, projectId, canvasTitles }: AgentCanvasChangeNoticeProps): React.ReactElement | null {
  const notices = useAtomValue(agentCanvasChangeNoticesAtom)
  const store = useStore()
  /** 只投影当前聊天最多 8 张最近画布，详细历史仍在节点原记录。 */
  const current = [...notices.values()].filter(notice => notice.sessionId === sessionId && notice.projectId === projectId).slice(-8)
  const [error, setError] = React.useState<string | null>(null)
  if (!current.length) return null
  /** 点击时重新验权；未保存草稿与撤销关联都不会被摘要绕过。 */
  const open = async (notice: ChangeNotice, nodeIds?: string[]): Promise<void> => {
    try {
      if (!await openAgentCanvasChange(store, notice, nodeIds)) {
        setError('暂时无法定位，请先保存节点详情；画布若已取消关联，请重新关联。')
        return
      }
      setError(null)
    } catch {
      toast.error('读取画布位置失败，请重试')
    }
  }
  return <div className="max-h-40 shrink-0 overflow-y-auto border-b border-border/60 px-4 py-2 text-xs" aria-label="画布修改记录">
    {current.map(notice => <CanvasChangeRow key={notice.canvasId} notice={notice}
      title={canvasTitles.find(canvas => canvas.id === notice.canvasId)?.title ?? '画布'} onOpen={open} />)}
    {error && <p role="status" className="pt-1 text-muted-foreground">{error}</p>}
  </div>
}
