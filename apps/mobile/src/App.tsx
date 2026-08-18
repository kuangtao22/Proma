import { useEffect, useCallback } from 'react'
import { useAtom, useSetAtom, useAtomValue } from 'jotai'
import {
  viewAtom, tokenAtom, connectedAtom, bridgeHostAtom, bridgePortAtom,
  conversationsAtom, workspacesAtom, activeConvAtom, messagesAtom,
  currentWorkspaceIdAtom, type View, type ConvItem,
} from './atoms'
import { connect, onPush, onOpen, wsReq, close } from './lib/ws-client'
import { AuthPage } from './components/layout/AuthPage'
import { AppShell } from './components/layout/AppShell'

interface ConvListResponse { conversations: ConvItem[] }
interface SessionListResponse { sessions: ConvItem[] }
interface WorkspaceListResponse { workspaces: Array<{ id: string; name: string; slug: string }> }
interface SettingsResponse { agentModelId?: string; channelBaseUrl?: string; agentChannelId?: string; agentWorkspaceId?: string }

export function App() {
  const [view, setView] = useAtom(viewAtom)
  const [token, setToken] = useAtom(tokenAtom)
  const [connected, setConnected] = useAtom(connectedAtom)
  const host = useAtomValue(bridgeHostAtom)
  const port = useAtomValue(bridgePortAtom)
  const setConvs = useSetAtom(conversationsAtom)
  const setWorkspaces = useSetAtom(workspacesAtom)
  const setActive = useSetAtom(activeConvAtom)
  const setMessages = useSetAtom(messagesAtom)
  const setCurrentWsId = useSetAtom(currentWorkspaceIdAtom)

  // 认证过期处理
  useEffect(() => {
    const handler = () => { setToken(null); setConnected(false); setView('auth') }
    window.addEventListener('proma:auth-expired', handler)
    return () => window.removeEventListener('proma:auth-expired', handler)
  }, [setToken, setConnected, setView])

  // 页面加载时自动连接，并优先恢复已保存的认证 Token。
  useEffect(() => {
    const storedToken = localStorage.getItem('proma_mobile_token')
    const storedView = localStorage.getItem('proma_mobile_view') as View | null

    onOpen(async (_ws) => {
      // 优先用已保存的 token
      const currentToken = localStorage.getItem('proma_mobile_token')
      if (currentToken) {
        try {
          const r = await wsReq('auth.verify', { token: currentToken }) as { valid: boolean }
          if (r.valid) {
            setToken(currentToken); setConnected(true)
            setView('chat')
            restoreActiveConv()
            return
          }
        } catch { /* fall through */ }
      }

      setToken(null); setConnected(false); setView('auth')
    })

    connect(host, port)
    return () => close()
  }, [host, port])

  async function restoreActiveConv() {
    const saved = localStorage.getItem('proma_mobile_active_conv')
    if (saved) {
      try { setActive(JSON.parse(saved)); return } catch {}
    }
    const currentToken = localStorage.getItem('proma_mobile_token')
    if (!currentToken) return
    try {
      const results = await Promise.allSettled([
        wsReq('conversations.list', { token: currentToken }),
        wsReq('agent.sessions', { token: currentToken }),
      ])
      const convs: ConvItem[] = []
      if (results[0].status === 'fulfilled') {
        const d = results[0].value as ConvListResponse
        for (const c of (d.conversations ?? [])) convs.push({ ...c, type: 'chat' })
      }
      if (results[1].status === 'fulfilled') {
        const d = results[1].value as SessionListResponse
        for (const s of (d.sessions ?? [])) convs.push({ ...s, type: 'agent' })
      }
      convs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      setConvs(convs)
      if (convs.length > 0) {
        setActive(convs[0])
        localStorage.setItem('proma_mobile_active_conv', JSON.stringify(convs[0]))
      }
    } catch { /* 无对话则留空 */ }
  }

  // 全局推送处理
  useEffect(() => {
    const unsub = onPush((msg) => {
      switch (msg.type) {
        case 'connected': break
        case 'conversations.updated':
        case 'agent.sessions.updated':
          loadData(setConvs, setWorkspaces, token, setCurrentWsId)
          break
        default: break
      }
    })
    return unsub
  }, [token, setConvs, setWorkspaces])

  // 持久化 view 状态
  useEffect(() => {
    if (view !== 'auth') localStorage.setItem('proma_mobile_view', view)
  }, [view])

  const handleAuthSuccess = useCallback(async (newToken: string) => {
    localStorage.setItem('proma_mobile_token', newToken)
    setToken(newToken); setConnected(true); setView('chat')
  }, [setToken, setConnected, setView])

  if (view === 'auth') return <AuthPage onSuccess={handleAuthSuccess} />
  return <AppShell />
}

// 共享数据加载（供各组件复用）
export async function loadData(
  setConvs: (v: ConvItem[]) => void,
  setWorkspaces: (v: Array<{ id: string; name: string; slug: string }>) => void,
  token: string | null,
  setCurrentWsId?: (v: string | null) => void,
) {
  if (!token) return
  const results = await Promise.allSettled([
    wsReq('conversations.list', { token }),
    wsReq('agent.sessions', { token }),
    wsReq('workspaces.list', { token }),
    wsReq('settings.get', { token }),
  ])
  const convs: ConvItem[] = []
  if (results[0].status === 'fulfilled') {
    const d = results[0].value as ConvListResponse
    for (const c of (d.conversations ?? [])) convs.push({ ...c, type: 'chat' as const })
  }
  if (results[1].status === 'fulfilled') {
    const d = results[1].value as SessionListResponse
    for (const s of (d.sessions ?? [])) convs.push({ ...s, type: 'agent' as const })
  }
  convs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  setConvs(convs)
  if (results[2].status === 'fulfilled') {
    setWorkspaces((results[2].value as WorkspaceListResponse).workspaces ?? [])
  }
  if (results[3].status === 'fulfilled' && setCurrentWsId) {
    const settings = results[3].value as SettingsResponse
    const stored = localStorage.getItem('proma_mobile_workspace_id')
    if (stored === null && settings.agentWorkspaceId) {
      setCurrentWsId(settings.agentWorkspaceId)
    } else if (stored !== null && stored !== '') {
      setCurrentWsId(stored)
    }
  }
}
