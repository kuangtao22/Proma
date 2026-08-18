import { useEffect, useCallback, useRef, useState } from 'react'
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
import {
  consumePairingLink,
  getPairingFailureMessage,
  supportsPairingTicket,
} from './lib/pairing-link'

interface ConvListResponse { conversations: ConvItem[] }
interface SessionListResponse { sessions: ConvItem[] }
interface WorkspaceListResponse { workspaces: Array<{ id: string; name: string; slug: string }> }
interface SettingsResponse { agentModelId?: string; channelBaseUrl?: string; agentChannelId?: string; agentWorkspaceId?: string }
interface RestoredSettings {
  modelId: string | null
  channelBaseUrl: string | null
  channelId: string | null
}

/** 启动时立即读取并清除 fragment；票据绝不进入 React 状态或持久化。 */
let startupPairingLink = consumePairingLink({
  getHref: () => window.location.href,
  replaceUrl: cleanUrl => window.history.replaceState(null, '', cleanUrl),
})
/** 等待服务端能力声明的一次性票据，完成任一终态后立即清空。 */
let pendingPairingTicket = startupPairingLink?.ticket ?? null
/** 扫码链接声明的真实连接目标，避免旧 localStorage 地址覆盖二维码地址。 */
const startupPairingTarget = startupPairingLink
  ? readPairingTarget(startupPairingLink.cleanUrl)
  : null
// host/port 提取完成后释放原始对象，避免已清空的 ticket 仍被间接长期引用。
startupPairingLink = null

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
  const [pairingPending, setPairingPending] = useState(pendingPairingTicket !== null)
  const [pairingError, setPairingError] = useState('')
  /** 每次连接 open 使用独立 generation，旧异步认证无法回写。 */
  const connectionGenerations = useRef(createGenerationTracker())

  /** 保存认证 Token 并进入聊天；凭据只沿用既有 Token 存储语义。 */
  const handleAuthSuccess = useCallback(async (newToken: string) => {
    localStorage.setItem('proma_mobile_token', newToken)
    setToken(newToken); setConnected(true); setView('chat')
  }, [setToken, setConnected, setView])

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
    /** 当前 socket open 对应的 generation，供 connected capability 回调校验。 */
    let activeGeneration: number | null = null
    /** 防止同一连接的重复 connected push 并发消费一次性票据。 */
    let pairingRequestInFlight = false
    /** 等待 connected capability 的超时任务，完全无法连接时回退 PIN。 */
    let pairingCapabilityTimer: number | null = pendingPairingTicket
      ? window.setTimeout(() => {
          if (cancelled || !pendingPairingTicket) return
          pendingPairingTicket = null
          setPairingPending(false)
          setPairingError('连接超时，请检查电脑与手机是否在同一局域网')
        }, 15_000)
      : null
    /** 清理当前 capability 等待任务。 */
    const clearPairingCapabilityTimer = (): void => {
      if (pairingCapabilityTimer === null) return
      window.clearTimeout(pairingCapabilityTimer)
      pairingCapabilityTimer = null
    }
    const unsubscribeOpen = onOpen(async (_ws, isReconnect) => {
      const generation = connectionGenerations.current.begin()
      activeGeneration = generation
      /** 旧连接 effect 或旧 open 回调均不能继续提交状态。 */
      const isCurrent = () => !cancelled && connectionGenerations.current.isCurrent(generation)
      /** 每次连接建立后重新读取 Token，避免使用首次渲染的陈旧状态。 */
      const currentToken = localStorage.getItem('proma_mobile_token')
      if (pendingPairingTicket) {
        if (!isCurrent()) return
        setToken(null); setConnected(false); setView('auth')
        setPairingPending(true); setPairingError('')
        return
      }
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

    const unsubscribePairing = onPush((message) => {
      if (message.type !== 'connected' || !pendingPairingTicket || pairingRequestInFlight) return
      /** capability push 必须属于当前有效连接。 */
      const generation = activeGeneration
      if (generation === null || cancelled || !connectionGenerations.current.isCurrent(generation)) return
      clearPairingCapabilityTimer()
      if (!supportsPairingTicket(message.data)) {
        pendingPairingTicket = null
        setPairingPending(false)
        setPairingError('当前电脑端不支持扫码配对，请使用 PIN 码连接')
        return
      }

      pairingRequestInFlight = true
      /** 请求期间只在局部变量保留票据，不写日志或长期状态。 */
      const ticket = pendingPairingTicket
      void wsReq('auth.pairTicket', { ticket, deviceName: 'Proma 手机端' })
        .then(async (result) => {
          if (cancelled || !connectionGenerations.current.isCurrent(generation)) return
          /** 票据成功消费后立即从内存清除。 */
          pendingPairingTicket = null
          pairingRequestInFlight = false
          setPairingPending(false)
          const issued = result as { token?: unknown }
          if (typeof issued.token !== 'string' || !issued.token) {
            setPairingError('扫码配对响应无效，请使用 PIN 码连接')
            return
          }
          if (startupPairingTarget) {
            localStorage.setItem('proma_mobile_host', startupPairingTarget.host)
            localStorage.setItem('proma_mobile_port', startupPairingTarget.port)
          }
          await handleAuthSuccess(issued.token)
        })
        .catch((error: unknown) => {
          if (cancelled || !connectionGenerations.current.isCurrent(generation)) return
          /** 失败票据不重放，保留 PIN 表单作为确定性回退。 */
          pendingPairingTicket = null
          pairingRequestInFlight = false
          setPairingPending(false)
          setPairingError(getPairingFailureMessage(error))
        })
    })

    /** 二维码当前地址优先于旧设备保存的连接目标。 */
    connect(startupPairingTarget?.host ?? host, startupPairingTarget?.port ?? port)
    return () => {
      cancelled = true
      clearPairingCapabilityTimer()
      connectionGenerations.current.invalidate()
      unsubscribeOpen()
      unsubscribePairing()
      close()
    }
  }, [
    host, port, setActive, setChannelBaseUrl, setChannelId, setConnected,
    handleAuthSuccess, setConvs, setCurrentWsId, setModelId, setToken, setView, setWorkspaces,
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

  if (view === 'auth') {
    return (
      <AuthPage
        onSuccess={handleAuthSuccess}
        pairingPending={pairingPending}
        pairingError={pairingError}
        onManualAttempt={() => setPairingError('')}
      />
    )
  }
  return <AppShell />
}

/** 从已经清理凭据的地址提取 WebSocket 连接目标。 */
function readPairingTarget(cleanUrl: string): { host: string; port: string } | null {
  try {
    /** 清理后的 URL 不再包含 ticket，可安全用于连接目标解析。 */
    const url = new URL(cleanUrl)
    return {
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
    }
  } catch {
    return null
  }
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
