import { useEffect, useCallback, useRef } from 'react'
import { useAtom, useSetAtom, useAtomValue } from 'jotai'
import {
  viewAtom, tokenAtom, connectedAtom, bridgeHostAtom, bridgePortAtom,
  conversationsAtom, workspacesAtom, activeConvAtom,
  currentWorkspaceIdAtom, type ConvItem,
  settingsModelIdAtom, settingsChannelBaseUrlAtom, settingsChannelIdAtom,
} from './atoms'
import { connect, onPush, onOpen, wsReq, close, WsClientError } from './lib/ws-client'
import {
  combineAuthoritativeLists,
  createGenerationTracker,
  createPriorityTaskCoordinator,
  isAuthenticationFailureCode,
  type TaskPriority,
} from './lib/recovery-guards'
import { AuthPage } from './components/layout/AuthPage'
import { AppShell } from './components/layout/AppShell'

interface ConvListResponse { conversations: ConvItem[] }
interface SessionListResponse { sessions: ConvItem[] }
interface WorkspaceListResponse { workspaces: Array<{ id: string; name: string; slug: string }> }
interface SettingsResponse { agentModelId?: string; channelBaseUrl?: string; agentChannelId?: string; agentWorkspaceId?: string }
interface RestoredSettings {
  modelId: string | null
  channelBaseUrl: string | null
  channelId: string | null
}

export interface LoadDataResult {
  conversationsUpdated: boolean
  conversations?: ConvItem[]
  stale: boolean
}

export interface LoadDataOptions {
  mode?: TaskPriority
}

/** 跨调用共享的 epoch，保证较旧的数据批次不能覆盖较新结果。 */
const loadDataGenerations = createGenerationTracker()
/** recovery 优先于普通刷新，避免普通调用抢占恢复 epoch。 */
const loadDataCoordinator = createPriorityTaskCoordinator<LoadDataResult>()

export function App() {
  const [view, setView] = useAtom(viewAtom)
  const [token, setToken] = useAtom(tokenAtom)
  const [connected, setConnected] = useAtom(connectedAtom)
  const host = useAtomValue(bridgeHostAtom)
  const port = useAtomValue(bridgePortAtom)
  const setConvs = useSetAtom(conversationsAtom)
  const setWorkspaces = useSetAtom(workspacesAtom)
  const setActive = useSetAtom(activeConvAtom)
  const setCurrentWsId = useSetAtom(currentWorkspaceIdAtom)
  const setModelId = useSetAtom(settingsModelIdAtom)
  const setChannelBaseUrl = useSetAtom(settingsChannelBaseUrlAtom)
  const setChannelId = useSetAtom(settingsChannelIdAtom)
  /** 每次连接 open 使用独立 generation，旧异步认证无法回写。 */
  const connectionGenerations = useRef(createGenerationTracker())

  // 认证过期处理
  useEffect(() => {
    const handler = () => {
      connectionGenerations.current.invalidate()
      localStorage.removeItem('proma_mobile_token')
      setToken(null); setConnected(false); setView('auth')
    }
    window.addEventListener('proma:auth-expired', handler)
    window.addEventListener('proma:auth-invalidated', handler)
    return () => {
      window.removeEventListener('proma:auth-expired', handler)
      window.removeEventListener('proma:auth-invalidated', handler)
    }
  }, [setToken, setConnected, setView])

  // 页面加载时自动连接，并优先恢复已保存的认证 Token。
  useEffect(() => {
    let cancelled = false
    const unsubscribeOpen = onOpen(async (_ws, isReconnect) => {
      const generation = connectionGenerations.current.begin()
      /** 旧连接 effect 或旧 open 回调均不能继续提交状态。 */
      const isCurrent = () => !cancelled && connectionGenerations.current.isCurrent(generation)
      /** 每次连接建立后重新读取 Token，避免使用首次渲染的陈旧状态。 */
      const currentToken = localStorage.getItem('proma_mobile_token')
      if (!currentToken) {
        if (!isCurrent()) return
        setToken(null); setConnected(false); setView('auth')
        return
      }

      let verification: { valid: boolean }
      try {
        verification = await wsReq('auth.verify', { token: currentToken }) as { valid: boolean }
      } catch (error) {
        if (!isCurrent()) return
        if (error instanceof WsClientError && isAuthenticationFailureCode(error.code)) {
          localStorage.removeItem('proma_mobile_token')
          setToken(null); setConnected(false); setView('auth')
        } else {
          /** 传输错误保留 Token，等待 ws-client 自动重连后再次验证。 */
          setConnected(false)
        }
        return
      }
      if (!isCurrent()) return
      if (verification.valid !== true) {
        if (verification.valid === false) {
          localStorage.removeItem('proma_mobile_token')
          setToken(null); setConnected(false); setView('auth')
        } else {
          setConnected(false)
        }
        return
      }

      setToken(currentToken); setConnected(true)
      const loadResult = await loadData(
        setConvs,
        setWorkspaces,
        currentToken,
        setCurrentWsId,
        settings => {
          setModelId(settings.modelId)
          setChannelBaseUrl(settings.channelBaseUrl)
          setChannelId(settings.channelId)
        },
        isCurrent,
        { mode: 'recovery' },
      )
      if (!isCurrent() || loadResult.stale) return
      if (loadResult.conversationsUpdated && loadResult.conversations) {
        /** 仅权威列表成功后校验保存项，部分失败时保留现有 active。 */
        const conversations = loadResult.conversations
        const savedConversation = readSavedConversation()
        const activeConversation = conversations.find(conversation => (
          conversation.id === savedConversation?.id && conversation.type === savedConversation.type
        )) ?? conversations[0] ?? null
        setActive(activeConversation)
        if (activeConversation) {
          localStorage.setItem('proma_mobile_active_conv', JSON.stringify(activeConversation))
        } else {
          localStorage.removeItem('proma_mobile_active_conv')
        }
      }
      setView('chat')
      if (isReconnect) {
        window.dispatchEvent(new CustomEvent('proma:ws-reconnected'))
      }
    })

    connect(host, port)
    return () => {
      cancelled = true
      connectionGenerations.current.invalidate()
      unsubscribeOpen()
      close()
    }
  }, [
    host, port, setActive, setChannelBaseUrl, setChannelId, setConnected,
    setConvs, setCurrentWsId, setModelId, setToken, setView, setWorkspaces,
  ])

  // 全局推送处理
  useEffect(() => {
    const unsub = onPush((msg) => {
      switch (msg.type) {
        case 'connected': break
        case 'conversations.updated':
        case 'agent.sessions.updated':
          void loadData(setConvs, setWorkspaces, token, setCurrentWsId)
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

/** 安全读取保存的会话；损坏数据按不存在处理。 */
function readSavedConversation(): ConvItem | null {
  const saved = localStorage.getItem('proma_mobile_active_conv')
  if (!saved) return null
  try {
    const parsed = JSON.parse(saved) as Partial<ConvItem>
    if (typeof parsed.id === 'string' && (parsed.type === 'chat' || parsed.type === 'agent')) {
      return parsed as ConvItem
    }
  } catch { /* 损坏的本地状态由最新列表替代 */ }
  return null
}

// 共享数据加载（供各组件复用）
export function loadData(
  setConvs: (v: ConvItem[]) => void,
  setWorkspaces: (v: Array<{ id: string; name: string; slug: string }>) => void,
  token: string | null,
  setCurrentWsId?: (v: string | null) => void,
  setSettings?: (settings: RestoredSettings) => void,
  isCallerCurrent: () => boolean = () => true,
  options: LoadDataOptions = {},
): Promise<LoadDataResult> {
  return loadDataCoordinator.run(options.mode ?? 'normal', () => executeLoadData(
    setConvs,
    setWorkspaces,
    token,
    setCurrentWsId,
    setSettings,
    isCallerCurrent,
  ))
}

/** 执行单个数据批次；只有真正启动的任务才创建新 epoch。 */
async function executeLoadData(
  setConvs: (v: ConvItem[]) => void,
  setWorkspaces: (v: Array<{ id: string; name: string; slug: string }>) => void,
  token: string | null,
  setCurrentWsId: ((v: string | null) => void) | undefined,
  setSettings: ((settings: RestoredSettings) => void) | undefined,
  isCallerCurrent: () => boolean,
): Promise<LoadDataResult> {
  const generation = loadDataGenerations.begin()
  /** setter 提交前同时校验最新数据批次和调用方生命周期。 */
  const isCurrent = () => loadDataGenerations.isCurrent(generation) && isCallerCurrent()
  if (!token) return { conversationsUpdated: false, stale: !isCurrent() }
  const results = await Promise.allSettled([
    wsReq('conversations.list', { token }),
    wsReq('agent.sessions', { token }),
    wsReq('workspaces.list', { token }),
    wsReq('settings.get', { token }),
  ])
  if (!isCurrent()) return { conversationsUpdated: false, stale: true }
  const chatResult: PromiseSettledResult<ConvItem[]> = results[0].status === 'fulfilled'
    ? { status: 'fulfilled', value: ((results[0].value as ConvListResponse).conversations ?? []).map(c => ({ ...c, type: 'chat' })) }
    : results[0]
  const sessionResult: PromiseSettledResult<ConvItem[]> = results[1].status === 'fulfilled'
    ? { status: 'fulfilled', value: ((results[1].value as SessionListResponse).sessions ?? []).map(s => ({ ...s, type: 'agent' })) }
    : results[1]
  const conversations = combineAuthoritativeLists(
    chatResult,
    sessionResult,
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
  )
  if (conversations.updated) setConvs(conversations.items)
  if (results[2].status === 'fulfilled' && isCurrent()) {
    setWorkspaces((results[2].value as WorkspaceListResponse).workspaces ?? [])
  }
  if (results[3].status === 'fulfilled' && setCurrentWsId && isCurrent()) {
    const settings = results[3].value as SettingsResponse
    const stored = localStorage.getItem('proma_mobile_workspace_id')
    if (stored === null && settings.agentWorkspaceId) {
      setCurrentWsId(settings.agentWorkspaceId)
    } else if (stored !== null && stored !== '') {
      setCurrentWsId(stored)
    }
  }
  if (results[3].status === 'fulfilled' && setSettings && isCurrent()) {
    const settings = results[3].value as SettingsResponse
    setSettings({
      modelId: settings.agentModelId || null,
      channelBaseUrl: settings.channelBaseUrl || null,
      channelId: settings.agentChannelId || null,
    })
  }
  if (!isCurrent()) return { conversationsUpdated: false, stale: true }
  return conversations.updated
    ? { conversationsUpdated: true, conversations: conversations.items, stale: false }
    : { conversationsUpdated: false, stale: false }
}
