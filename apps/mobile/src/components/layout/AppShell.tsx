import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ChevronDown, Menu } from 'lucide-react'
import { useCallback, useEffect } from 'react'
import {
  viewAtom, drawerOpenAtom, activeConvAtom, convDropdownOpenAtom,
  tokenAtom, conversationsAtom, workspacesAtom, currentWorkspaceIdAtom,
  settingsModelIdAtom, settingsChannelBaseUrlAtom, settingsChannelIdAtom, channelsAtom,
  type ChannelInfo,
} from '../../atoms'
import { Drawer } from './Drawer'
import { ChatView } from '../conversation/ChatView'
import { ConvDropdown } from '../conversation/ConvDropdown'
import { wsReq } from '../../lib/ws-client'
import { loadData } from '../../App'

interface SettingsResponse { agentModelId?: string; channelBaseUrl?: string; agentChannelId?: string }
interface ChannelsResponse { channels: ChannelInfo[] }

export function AppShell() {
  const [view] = useAtom(viewAtom)
  const [drawerOpen, setDrawerOpen] = useAtom(drawerOpenAtom)
  const [active] = useAtom(activeConvAtom)
  const [dropdownOpen, setDropdownOpen] = useAtom(convDropdownOpenAtom)
  const token = useAtomValue(tokenAtom)
  const setConvs = useSetAtom(conversationsAtom)
  const setWorkspaces = useSetAtom(workspacesAtom)
  const setCurrentWsId = useSetAtom(currentWorkspaceIdAtom)
  const [modelId, setModelId] = useAtom(settingsModelIdAtom)
  const [channelBaseUrl, setChannelBaseUrl] = useAtom(settingsChannelBaseUrlAtom)
  const setChannelId = useSetAtom(settingsChannelIdAtom)
  const setChannels = useSetAtom(channelsAtom)

  useEffect(() => {
    if (!token || view !== 'chat') return
    wsReq('settings.get', { token }).then(d => {
      const s = d as SettingsResponse
      setModelId(s.agentModelId || null)
      setChannelBaseUrl(s.channelBaseUrl || null)
      setChannelId(s.agentChannelId || null)
    }).catch(() => {})
    wsReq('settings.channels', { token }).then(d => {
      setChannels((d as ChannelsResponse).channels ?? [])
    }).catch(() => {})
  }, [token, view])

  const isInChat = view === 'chat' && active

  const refreshData = useCallback(() => {
    if (token) loadData(setConvs, setWorkspaces, token, setCurrentWsId)
  }, [token, setConvs, setWorkspaces, setCurrentWsId])

  const handleOpenDrawer = () => {
    setDrawerOpen(true)
    refreshData()
  }

  const handleToggleDropdown = () => {
    const next = !dropdownOpen
    setDropdownOpen(next)
    if (next) refreshData()
  }

  return (
    <div className="flex h-full flex-col bg-content" style={{ paddingTop: 'var(--safe-t)', paddingBottom: 'var(--safe-b)' }}>
      {/* 全局顶部栏 */}
      <header className="relative flex h-12 flex-shrink-0 items-center gap-1 border-b border-border bg-sidebar px-1.5">
        {/* 汉堡菜单 — 始终可见 */}
        <button
          aria-label="打开会话抽屉"
          onClick={handleOpenDrawer}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-control hover:text-foreground"
        >
          <Menu aria-hidden="true" className="h-[18px] w-[18px]" />
        </button>

        {isInChat ? (
          <>
            {/* 可点击标题 → 下拉切换同工作区对话 */}
            <button
              aria-label="切换当前会话"
              onClick={handleToggleDropdown}
              className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-sidebar-control"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium leading-4 text-foreground">{active.title || '新对话'}</span>
                <span className="block text-center text-[10px] leading-3 text-muted-foreground">已连接</span>
              </span>
              <ChevronDown
                aria-hidden="true"
                className={`h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-200 ${dropdownOpen ? 'rotate-180' : ''}`}
              />
            </button>
            {dropdownOpen && <ConvDropdown onClose={() => setDropdownOpen(false)} />}
          </>
        ) : (
          <div className="mx-2 min-w-0 flex-1 text-center">
            <h1 className="truncate text-sm font-medium leading-4 text-foreground">Proma</h1>
            <p className="text-[10px] leading-3 text-muted-foreground">已连接</p>
          </div>
        )}
        <div className="h-10 w-10 flex-shrink-0" aria-hidden="true" />
      </header>

      {/* 侧边栏遮罩 + 抽屉 */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 flex"
          style={{ top: 'var(--safe-t)', bottom: 'var(--safe-b)' }}
        >
          <div className="absolute inset-0 bg-black/45 backdrop-blur-[1px]" onClick={() => setDrawerOpen(false)} />
          <div className="translate-x-0">
            <Drawer onClose={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      {/* 主内容 */}
      <main className="flex-1 overflow-hidden min-w-0">
        {view === 'chat' && <ChatView />}
      </main>
    </div>
  )
}
