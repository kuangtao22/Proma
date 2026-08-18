import { useAtom, useAtomValue, useSetAtom } from 'jotai'
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
    <nav className="w-72 max-w-[80vw] bg-[#141416] border-r border-border h-full z-50 flex flex-col shadow-xl">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <h2 className="text-sm font-semibold text-foreground">Proma</h2>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>

      {/* Tab 切换 */}
      <div className="px-3 py-2 border-b border-border flex-shrink-0">
        <div className="flex rounded-lg bg-muted p-0.5">
          {(['agent', 'chat'] as TabType[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === t ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
            >{t === 'agent' ? 'Agent' : 'Chat'}</button>
          ))}
        </div>
      </div>

      {/* 工作区选择器 */}
      {tab === 'agent' && workspaces.length > 1 && (
        <div className="px-3 py-1.5 border-b border-border flex-shrink-0 flex gap-1 overflow-x-auto">
          <button onClick={() => setWsId(null)}
            className={`px-2 py-1 text-[10px] rounded-md whitespace-nowrap transition-colors ${!wsId ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>
            全部
          </button>
          {workspaces.map(ws => (
            <button key={ws.id} onClick={() => setWsId(ws.id)}
              className={`px-2 py-1 text-[10px] rounded-md whitespace-nowrap transition-colors ${wsId === ws.id ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>
              {ws.name}
            </button>
          ))}
        </div>
      )}

      {/* 列表内容 */}
      <div className="flex-1 overflow-y-auto min-w-0">
        {tab === 'agent' ? (
          <div className="py-1">
            <button onClick={() => handleCreate(wsId ?? undefined)}
              className="w-full text-left px-4 py-2.5 text-sm text-primary hover:bg-accent/30 transition-colors flex items-center gap-2">
              <span className="text-base">+</span> 新建对话
            </button>

            {agentGroups.map(g => (
              <div key={g.key}>
                <div className="px-4 py-1.5 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">
                  {g.label}
                </div>
                {g.convs.map(c => (
                  <button key={c.id} onClick={() => handleOpen(c)}
                    className={`w-full text-left px-4 py-2 text-sm transition-colors flex items-center gap-2 ${active?.id === c.id ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent/20'}`}>
                    <span className="truncate flex-1">
                      {c.pinned && <span className="text-yellow-400 mr-1">📌</span>}
                      {c.manualWorking && <span className="text-blue-400 mr-1">●</span>}
                      {c.title || '新对话'}
                    </span>
                    {c.updatedAt ? (
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatRelativeTime(c.updatedAt)}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}

            {agentGroups.length === 0 && (
              <p className="text-center text-muted-foreground text-xs py-6">暂无 Agent 对话</p>
            )}
          </div>
        ) : (
          <div className="py-1">
            {chatConvs.map(c => (
              <button key={c.id} onClick={() => handleOpen(c)}
                className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center gap-2 border-b border-border/30 ${active?.id === c.id ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent/20'}`}>
                <span className="truncate flex-1">{c.title || '新对话'}</span>
                {c.updatedAt ? (
                  <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatRelativeTime(c.updatedAt)}</span>
                ) : null}
              </button>
            ))}
            {chatConvs.length === 0 && (
              <p className="text-center text-muted-foreground text-xs py-6">暂无 Chat 对话</p>
            )}
          </div>
        )}
      </div>

      {/* 底部操作 */}
      <div className="border-t border-border px-3 py-2 flex gap-2 flex-shrink-0">
        <button onClick={handleRefresh}
          className="flex-1 text-xs text-center py-1.5 rounded-lg bg-muted text-muted-foreground hover:bg-accent/20 transition-colors">
          刷新
        </button>
        <button onClick={handleDisconnect}
          className="flex-1 text-xs text-center py-1.5 rounded-lg text-red-400 hover:bg-red-400/10 transition-colors">
          断开
        </button>
      </div>
    </nav>
  )
}
