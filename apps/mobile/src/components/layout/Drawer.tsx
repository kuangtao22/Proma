import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { CircleDot, LogOut, Pin, Plus, RefreshCw, X } from 'lucide-react'
import {
  viewAtom, tokenAtom, connectedAtom, activeConvAtom,
  conversationsAtom, agentSessionGroupsAtom, chatConvsAtom,
  type ConvItem, activeTabAtom, type TabType, currentWorkspaceIdAtom,
} from '../../atoms'
import { close as closeWS } from '../../lib/ws-client'
import { loadData } from '../../App'
import { formatRelativeTime } from '../../utils/format'
import { createAgentConversation, saveActiveConv } from '../../utils/session'
import { STORAGE_KEYS, removeStorage } from '../../utils/storage'

interface Props { onClose: () => void }

export function Drawer({ onClose }: Props) {
  const setView = useSetAtom(viewAtom)
  const [token, setToken] = useAtom(tokenAtom)
  const setConnected = useSetAtom(connectedAtom)
  const [active, setActive] = useAtom(activeConvAtom)
  const setConvs = useSetAtom(conversationsAtom)
  const [tab, setTab] = useAtom(activeTabAtom)

  const { groups: agentGroups, workspaces } = useAtomValue(agentSessionGroupsAtom)
  const chatConvs = useAtomValue(chatConvsAtom)
  const [wsId, setWsId] = useAtom(currentWorkspaceIdAtom)

  const handleOpen = (conv: ConvItem) => {
    setActive(conv)
    saveActiveConv(conv)
    setView('chat')
    onClose()
  }

  const handleCreate = async (workspaceId?: string) => {
    if (!token) return
    try {
      const newConv = await createAgentConversation(token, workspaceId)
      setActive(newConv)
      saveActiveConv(newConv)
      setView('chat')
      onClose()
      loadData(setConvs, () => {}, token)
    } catch { /* TODO: toast */ }
  }

  const handleDisconnect = () => {
    /** 先通知 App 失效所有恢复 generation，再执行幂等本地清理。 */
    window.dispatchEvent(new CustomEvent('proma:auth-invalidated'))
    removeStorage(STORAGE_KEYS.token)
    setToken(null); setConnected(false); setView('auth')
    closeWS()
    onClose()
  }

  const handleRefresh = async () => {
    if (!token) return
    await loadData(setConvs, () => {}, token, setWsId)
  }

  return (
    <nav aria-label="会话抽屉" className="z-50 flex h-full w-72 max-w-[84vw] flex-col border-r border-border bg-sidebar text-foreground shadow-xl">
      {/* 头部 */}
      <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border px-3">
        <h2 className="text-sm font-semibold text-foreground">Proma</h2>
        <button
          aria-label="关闭会话抽屉"
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-control hover:text-foreground"
        >
          <X aria-hidden="true" className="h-[18px] w-[18px]" />
        </button>
      </div>

      {/* Tab 切换 */}
      <div className="flex-shrink-0 border-b border-border px-3 py-2.5">
        <div className="flex rounded-md bg-sidebar-control p-1">
          {(['agent', 'chat'] as TabType[]).map(t => (
            <button
              key={t}
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
              className={`min-h-8 flex-1 rounded-[4px] px-2 text-xs font-medium transition-colors ${tab === t ? 'bg-content text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >{t === 'agent' ? 'Agent' : 'Chat'}</button>
          ))}
        </div>
      </div>

      {/* 工作区选择器 */}
      {tab === 'agent' && workspaces.length > 1 && (
        <div className="flex flex-shrink-0 gap-1.5 overflow-x-auto border-b border-border px-3 py-2">
          <button
            aria-pressed={!wsId}
            onClick={() => setWsId(null)}
            className={`min-h-8 whitespace-nowrap rounded-md px-2.5 text-[11px] transition-colors ${!wsId ? 'bg-primary text-primary-foreground' : 'bg-sidebar-control text-muted-foreground hover:bg-sidebar-control-hover'}`}
          >
            全部
          </button>
          {workspaces.map(ws => (
            <button
              key={ws.id}
              aria-pressed={wsId === ws.id}
              onClick={() => setWsId(ws.id)}
              className={`min-h-8 whitespace-nowrap rounded-md px-2.5 text-[11px] transition-colors ${wsId === ws.id ? 'bg-primary text-primary-foreground' : 'bg-sidebar-control text-muted-foreground hover:bg-sidebar-control-hover'}`}
            >
              {ws.name}
            </button>
          ))}
        </div>
      )}

      {/* 列表内容 */}
      <div className="flex-1 overflow-y-auto min-w-0">
        {tab === 'agent' ? (
          <div className="py-1.5">
            <button
              onClick={() => handleCreate(wsId ?? undefined)}
              className="flex min-h-10 w-full items-center gap-2 px-3.5 py-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-sidebar-control"
            >
              <Plus aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
              新建对话
            </button>

            {agentGroups.map(g => (
              <div key={g.key}>
                <div className="px-3.5 pb-1 pt-3 text-[10px] font-medium uppercase text-muted-foreground">
                  {g.label}
                </div>
                {g.convs.map(c => (
                  <button
                    key={c.id}
                    onClick={() => handleOpen(c)}
                    className={`flex min-h-10 w-full items-center gap-2 px-3.5 py-2 text-left text-sm transition-colors ${active?.id === c.id ? 'bg-sidebar-control text-foreground' : 'text-foreground hover:bg-sidebar-control/70'}`}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      {c.pinned && <Pin aria-label="置顶" className="h-3 w-3 shrink-0 text-muted-foreground" />}
                      {c.manualWorking && <CircleDot aria-label="工作中" className="h-3 w-3 shrink-0 text-foreground" />}
                      <span className="truncate">
                      {c.title || '新对话'}
                      </span>
                    </span>
                    {c.updatedAt ? (
                      <span className="flex-shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(c.updatedAt)}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}

            {agentGroups.length === 0 && (
              <p className="px-4 py-8 text-center text-xs text-muted-foreground">暂无 Agent 对话</p>
            )}
          </div>
        ) : (
          <div className="py-1.5">
            {chatConvs.map(c => (
              <button
                key={c.id}
                onClick={() => handleOpen(c)}
                className={`flex min-h-10 w-full items-center gap-2 px-3.5 py-2 text-left text-sm transition-colors ${active?.id === c.id ? 'bg-sidebar-control text-foreground' : 'text-foreground hover:bg-sidebar-control/70'}`}
              >
                <span className="min-w-0 flex-1 truncate">{c.title || '新对话'}</span>
                {c.updatedAt ? (
                  <span className="flex-shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(c.updatedAt)}</span>
                ) : null}
              </button>
            ))}
            {chatConvs.length === 0 && (
              <p className="px-4 py-8 text-center text-xs text-muted-foreground">暂无 Chat 对话</p>
            )}
          </div>
        )}
      </div>

      {/* 底部操作 */}
      <div className="flex flex-shrink-0 gap-2 border-t border-border px-3 py-2.5">
        <button
          onClick={handleRefresh}
          className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md bg-sidebar-control px-2 text-xs text-muted-foreground transition-colors hover:bg-sidebar-control-hover hover:text-foreground"
        >
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
          刷新
        </button>
        <button
          onClick={handleDisconnect}
          className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-destructive transition-colors hover:bg-destructive/10"
        >
          <LogOut aria-hidden="true" className="h-3.5 w-3.5" />
          断开
        </button>
      </div>
    </nav>
  )
}
