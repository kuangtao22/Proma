import { useEffect, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  viewAtom, tokenAtom, connectedAtom, bridgeHostAtom, bridgePortAtom,
  conversationsAtom, workspacesAtom, activeConvAtom,
  currentWorkspaceIdAtom, type ConvItem,
  settingsModelIdAtom, settingsChannelBaseUrlAtom, settingsChannelIdAtom,
} from './atoms'
import { connect, onPush, onOpen, wsReq, close } from './lib/ws-client'
import {
  combineAuthoritativeLists,
  createGenerationTracker,
  createPriorityTaskCoordinator,
  type TaskPriority,
} from './lib/recovery-guards'
import { AuthPage } from './components/layout/AuthPage'
import { AppShell } from './components/layout/AppShell'
import {
  consumePairingLink,
} from './lib/pairing-link'
import {
  createPairingStartupCoordinator,
  startPairingConnection,
} from './lib/pairing-startup-coordinator'
import type { PairingConnectionTarget } from './lib/pairing-startup-coordinator'
import type { TrustedDeviceAuthentication } from './lib/pairing-startup-coordinator'
import type { WebSocketSourceProtocol } from './lib/ws-client'
import {
  clearTrustedDeviceAuthentication,
  createRandomDeviceId,
  getOrCreateDeviceId,
  readTrustedDeviceAuthentication,
  saveTrustedDeviceAuthentication,
} from './lib/device-credentials'
import { recoverTrustedDeviceAuth } from './lib/auth-recovery'

interface ConvListResponse { conversations: ConvItem[] }
interface SessionListResponse { sessions: ConvItem[] }
interface WorkspaceListResponse { workspaces: Array<{ id: string; name: string; slug: string }> }
interface SettingsResponse { agentModelId?: string; channelBaseUrl?: string; agentChannelId?: string; agentWorkspaceId?: string }
interface RestoredSettings {
  modelId: string | null
  channelBaseUrl: string | null
  channelId: string | null
}

/** 启动时立即清除 fragment，并在模块闭包中短暂持有一次性配对材料。 */
const startupPairingCoordinator = createPairingStartupCoordinator(consumePairingLink({
  getHref: () => window.location.href,
  replaceUrl: cleanUrl => window.history.replaceState(null, '', cleanUrl),
}))

/** 当前浏览器安装持久化复用的稳定设备标识。 */
const mobileDeviceId = getOrCreateDeviceId(localStorage, createRandomDeviceId)

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
  const [host, setHost] = useAtom(bridgeHostAtom)
  const [port, setPort] = useAtom(bridgePortAtom)
  const setConvs = useSetAtom(conversationsAtom)
  const setWorkspaces = useSetAtom(workspacesAtom)
  const setActive = useSetAtom(activeConvAtom)
  const setCurrentWsId = useSetAtom(currentWorkspaceIdAtom)
  const setModelId = useSetAtom(settingsModelIdAtom)
  const setChannelBaseUrl = useSetAtom(settingsChannelBaseUrlAtom)
  const setChannelId = useSetAtom(settingsChannelIdAtom)
  const [pairingPending, setPairingPending] = useState(startupPairingCoordinator.hasPendingTicket())
  const [pairingError, setPairingError] = useState('')
  /** 扫码目标写入 atoms 前阻止连接 effect 使用旧持久化地址。 */
  const [startupTargetPending, setStartupTargetPending] = useState(
    startupPairingCoordinator.hasInitialTarget(),
  )
  /** 连接协议跟随扫码页面 scheme；普通手工连接沿用当前页面协议。 */
  const [connectionProtocol, setConnectionProtocol] = useState<WebSocketSourceProtocol>(
    window.location.protocol === 'https:' ? 'https:' : 'http:',
  )
  /** 每次连接 open 使用独立 generation，旧异步认证无法回写。 */
  const connectionGenerations = useRef(createGenerationTracker())
  /** 记录上一轮实际连接目标，用于识别来自任意 atom 更新源的地址切换。 */
  const previousConnectionTarget = useRef<PairingConnectionTarget | null>(null)
  /** 防止同一认证失效事件并发触发多次长期凭证续签。 */
  const authenticationRecoveryPending = useRef(false)

  /** 将扫码 origin 一次性同步进现有地址 atoms，之后完全由表单/atoms 驱动连接。 */
  useLayoutEffect(() => {
    /** 只可获取一次的扫码启动目标。 */
    const target = startupPairingCoordinator.takeInitialTarget()
    if (!target) return
    setHost(target.host)
    setPort(target.port)
    setConnectionProtocol(target.protocol)
    setStartupTargetPending(false)
  }, [setHost, setPort])

  /** 保存完整可信设备认证材料并进入聊天。 */
  const handleAuthSuccess = useCallback(async (authentication: TrustedDeviceAuthentication) => {
    saveTrustedDeviceAuthentication(localStorage, authentication)
    setToken(authentication.token); setConnected(true); setView('chat')
  }, [setToken, setConnected, setView])

  // 认证过期处理
  useEffect(() => {
    const handler = () => {
      if (authenticationRecoveryPending.current) return
      connectionGenerations.current.invalidate()
      /** 当前浏览器保存的长期设备认证材料。 */
      const saved = readTrustedDeviceAuthentication(localStorage)
      if (!saved.deviceCredential) {
        clearTrustedDeviceAuthentication(localStorage)
        setToken(null); setConnected(false); setView('auth')
        return
      }
      authenticationRecoveryPending.current = true
      void recoverTrustedDeviceAuth({
        token: null,
        deviceCredential: saved.deviceCredential,
      }, {
        verifyToken: async candidate => wsReq('auth.verify', { token: candidate }) as Promise<{
          valid: boolean
          errorCode?: string
        }>,
        refreshCredential: async credential => wsReq('auth.refresh', { credential }) as Promise<{
          token: string
        }>,
      }).then((result) => {
        if (result.status === 'authenticated') {
          localStorage.setItem('proma_mobile_token', result.token)
          setToken(result.token); setConnected(true); setView('chat')
          window.dispatchEvent(new CustomEvent('proma:ws-reconnected'))
          return
        }
        if (result.status === 'invalidated' || result.status === 'anonymous') {
          clearTrustedDeviceAuthentication(localStorage)
          setToken(null); setConnected(false); setView('auth')
          return
        }
        setConnected(false)
      }).finally(() => {
        authenticationRecoveryPending.current = false
      })
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
    /** 等扫码目标同步后再建立首个 socket，避免短暂连接旧 localStorage 地址。 */
    if (startupTargetPending) return
    let cancelled = false
    /** 当前 socket open 对应的 generation，供 connected capability 回调校验。 */
    let activeGeneration: number | null = null
    /** 等待 connected capability 的超时任务，完全无法连接时回退 PIN。 */
    let pairingCapabilityTimer: number | null = startupPairingCoordinator.hasPendingTicket()
      ? window.setTimeout(() => {
          if (cancelled || !startupPairingCoordinator.hasPendingTicket()) return
          startupPairingCoordinator.cancel()
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
      /** 每次连接建立后重新读取完整认证材料，避免使用首次渲染的陈旧状态。 */
      const savedAuthentication = readTrustedDeviceAuthentication(localStorage)
      if (startupPairingCoordinator.hasPendingTicket()) {
        if (!isCurrent()) return
        setToken(null); setConnected(false); setView('auth')
        setPairingPending(true); setPairingError('')
        return
      }
      authenticationRecoveryPending.current = true
      /** 短期令牌失效时自动使用长期设备凭证恢复。 */
      const recovery = await recoverTrustedDeviceAuth({
        token: savedAuthentication.token,
        deviceCredential: savedAuthentication.deviceCredential,
      }, {
        verifyToken: async candidate => wsReq('auth.verify', { token: candidate }) as Promise<{
          valid: boolean
          errorCode?: string
        }>,
        refreshCredential: async credential => wsReq('auth.refresh', { credential }) as Promise<{
          token: string
        }>,
      })
      authenticationRecoveryPending.current = false
      if (!isCurrent()) return
      if (recovery.status === 'invalidated' || recovery.status === 'anonymous') {
        clearTrustedDeviceAuthentication(localStorage)
        setToken(null); setConnected(false); setView('auth')
        return
      }
      if (recovery.status === 'unavailable') {
        setConnected(false)
        return
      }

      /** 当前连接最终可用的短期访问令牌。 */
      const currentToken = recovery.token
      if (recovery.refreshed) localStorage.setItem('proma_mobile_token', currentToken)
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
      if (message.type !== 'connected' || !startupPairingCoordinator.hasPendingTicket()) return
      /** capability push 必须属于当前有效连接。 */
      const generation = activeGeneration
      if (generation === null || cancelled || !connectionGenerations.current.isCurrent(generation)) return
      clearPairingCapabilityTimer()
      void startupPairingCoordinator.handleConnected(message.data, {
        requestPairTicket: async (ticket) => {
          /** 请求期间 ticket 只存在于调用栈，不写日志或持久化。 */
          const result = await wsReq('auth.pairTicket', {
            ticket,
            deviceName: 'Proma 手机端',
            deviceId: mobileDeviceId,
          })
          /** 未知协议响应在协调器中按无效结果回退 PIN。 */
          const issued = result as Record<string, unknown>
          return {
            token: typeof issued.token === 'string' ? issued.token : '',
            deviceId: typeof issued.deviceId === 'string' ? issued.deviceId : '',
            deviceCredential: typeof issued.deviceCredential === 'string' ? issued.deviceCredential : '',
          }
        },
        onAuthenticated: (authentication) => {
          if (cancelled || !connectionGenerations.current.isCurrent(generation)) return
          setPairingPending(false)
          /** 只保存本次 socket 实际使用的 atoms 快照，避免记录旧扫码端口。 */
          localStorage.setItem('proma_mobile_host', host)
          localStorage.setItem('proma_mobile_port', port)
          void handleAuthSuccess(authentication)
        },
        onFallback: (messageText) => {
          if (cancelled || !connectionGenerations.current.isCurrent(generation)) return
          setPairingPending(false)
          setPairingError(messageText)
        },
      })
    })

    /** 地址切换取消旧自动配对并解除 PIN 禁用，同地址 StrictMode 重建不会误取消。 */
    previousConnectionTarget.current = startPairingConnection(
      startupPairingCoordinator,
      previousConnectionTarget.current,
      { host, port, protocol: connectionProtocol },
      {
        connect,
        onPairingCancelled: () => setPairingPending(false),
      },
    )
    return () => {
      cancelled = true
      clearPairingCapabilityTimer()
      connectionGenerations.current.invalidate()
      unsubscribeOpen()
      unsubscribePairing()
      close()
    }
  }, [
    host, port, connectionProtocol, setActive, setChannelBaseUrl, setChannelId, setConnected,
    handleAuthSuccess, setConvs, setCurrentWsId, setModelId, setToken, setView, setWorkspaces,
    startupTargetPending,
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
        deviceId={mobileDeviceId}
        pairingPending={pairingPending}
        pairingError={pairingError}
        onManualAttempt={() => setPairingError('')}
      />
    )
  }
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
