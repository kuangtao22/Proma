import {
  SERVER_OPS_IPC_CHANNELS,
  isServerOpsId,
  parseServerOpsConnectInput,
  parseServerOpsConfirmHostKeyInput,
  parseServerOpsSaveHostInput,
  parseServerOpsAgentAccessInput,
  parseServerOpsAgentAccessTarget,
  parseServerOpsAuditListInput,
  parseServerOpsAuditListResult,
  parseServerOpsLogExitEvent,
  parseServerOpsLogExportInput,
  parseServerOpsLogExportResult,
  parseServerOpsLogIdentity,
  parseServerOpsLogOutputAck,
  parseServerOpsLogOutputEvent,
  parseServerOpsLogStartInput,
  parseServerOpsLogStartResult,
  parseServerOpsOverviewInput,
  parseServerOpsOverviewResult,
  parseServerOpsServiceActionInput,
  parseServerOpsServiceActionResult,
  parseServerOpsServiceDetailInput,
  parseServerOpsServiceDetailResult,
  parseServerOpsServiceListInput,
  parseServerOpsServiceListResult,
} from '@proma/shared'
import type {
  AgentSessionMeta,
  ServerOpsConnectInput,
  ServerOpsConfirmHostKeyInput,
  ServerOpsConnectionState,
  ServerOpsAgentAccess,
  ServerOpsAgentAccessChanged,
  ServerOpsHost,
  ServerOpsSavedCredentialInput,
  ServerOpsSaveHostInput,
  ServerOpsTerminalExitEvent,
  ServerOpsTerminalInput,
  ServerOpsTerminalIdentity,
  ServerOpsTerminalOutputAck,
  ServerOpsTerminalOutputEvent,
  ServerOpsTerminalResizeInput,
  ServerOpsUpsertHostInput,
  ServerOpsAuditListInput,
  ServerOpsAuditListResult,
  ServerOpsLogExitEvent,
  ServerOpsLogIdentity,
  ServerOpsLogOutputAck,
  ServerOpsLogOutputEvent,
  ServerOpsLogStartInput,
  ServerOpsLogStartResult,
  ServerOpsOverviewInput,
  ServerOpsOverviewResult,
  ServerOpsServiceActionInput,
  ServerOpsServiceActionResult,
  ServerOpsServiceDetailInput,
  ServerOpsServiceDetailResult,
  ServerOpsServiceListInput,
  ServerOpsServiceListResult,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { requireOrdinaryTopLevelAgentSession } from '../agent-session-visibility'
import type { ServerOpsAgentAccessStore } from './server-ops-agent-access-store'

/** 运维 IPC handler 的最小签名。 */
type ServerOpsIpcHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 可注入且可清理的 Electron IPC 注册器。 */
export interface ServerOpsIpcRegistrar {
  handle: (channel: string, handler: ServerOpsIpcHandler) => void
  removeHandler: (channel: string) => void
}

/** 主机 Store 暴露给 IPC 层的窄接口。 */
export interface ServerOpsHostStoreContract {
  list: () => ServerOpsHost[]
  get: (hostId: string) => ServerOpsHost | undefined
  upsert: (input: ServerOpsUpsertHostInput) => ServerOpsHost
  setCredentialRef: (hostId: string, credentialRef?: string) => ServerOpsHost
  remove: (hostId: string) => boolean
}

/** 安全凭据 Store 暴露给 IPC 层的窄接口。 */
export interface ServerOpsCredentialStoreContract {
  remember: (hostId: string, credential: ServerOpsSavedCredentialInput) => string
  forgetHost: (hostId: string) => void
}

/** 真实 SSH 连接 Service 暴露给 IPC 的窄接口。 */
export interface ServerOpsConnectionContract {
  connect: (input: ServerOpsConnectInput) => Promise<ServerOpsConnectionState>
  confirmHostKey: (input: ServerOpsConfirmHostKeyInput) => Promise<ServerOpsConnectionState>
  disconnect: (hostId: string) => ServerOpsConnectionState
  writeTerminal: (input: ServerOpsTerminalInput) => void
  resizeTerminal: (input: ServerOpsTerminalResizeInput) => void
  acknowledgeOutput: (input: ServerOpsTerminalOutputAck) => void
  getTerminalSnapshot: (input: ServerOpsTerminalIdentity) => ServerOpsTerminalOutputEvent | undefined
  onState: (listener: (state: ServerOpsConnectionState) => void) => () => void
  onOutput: (listener: (event: ServerOpsTerminalOutputEvent) => void) => () => void
  onExit: (listener: (event: ServerOpsTerminalExitEvent) => void) => () => void
  getState: (hostId: string) => ServerOpsConnectionState
  exec: (hostId: string, connectionId: string, command: string, timeoutMs: number) => Promise<import('../../../utility/server-ops/server-ops-runtime-protocol').ServerOpsRuntimeExecResult>
  dispose?: () => void
}

/** IPC 可见的服务器概览服务窄接口。 */
export interface ServerOpsOverviewContract {
  getOverview(input: ServerOpsOverviewInput): Promise<ServerOpsOverviewResult | unknown>
}

/** IPC 可见的 systemd 服务窄接口。 */
export interface ServerOpsSystemdContract {
  listServices(input: ServerOpsServiceListInput): Promise<ServerOpsServiceListResult | unknown>
  getServiceDetail(input: ServerOpsServiceDetailInput): Promise<ServerOpsServiceDetailResult | unknown>
  runAction(input: ServerOpsServiceActionInput): Promise<ServerOpsServiceActionResult | unknown>
}

/** IPC 可见的日志服务窄接口。 */
export interface ServerOpsLogContract {
  start(ownerKey: string, input: ServerOpsLogStartInput): Promise<ServerOpsLogStartResult | unknown>
  stop(ownerKey: string, input: ServerOpsLogIdentity): void
  acknowledge(ownerKey: string, input: ServerOpsLogOutputAck): void
  disposeOwner(ownerKey: string): void
  onOutput(listener: (event: ServerOpsLogOutputEvent) => void): () => void
  onExit(listener: (event: ServerOpsLogExitEvent) => void): () => void
}

/** BrowserWindow 的日志 owner 与导出所需最小接口。 */
export interface ServerOpsOwnerWindow {
  id: number
  webContents: WebContents
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): unknown
  removeListener?(event: 'closed', listener: () => void): unknown
  off?(event: 'closed', listener: () => void): unknown
}

/** 日志保存对话框只接受 main 构造的文件名。 */
export interface ServerOpsLogSaveDialogOptions {
  title: string
  defaultPath: string
  filters: Array<{ name: string; extensions: string[] }>
}

/** 运维 IPC 注册所需可信依赖。 */
export interface ServerOpsIpcOptions {
  ipc: ServerOpsIpcRegistrar
  listAuthorizedWebContents: () => WebContents[]
  hosts: ServerOpsHostStoreContract
  connections: ServerOpsConnectionContract
  credentials: ServerOpsCredentialStoreContract
  access: ServerOpsAgentAccessStore
  audit: { list: (input: ServerOpsAuditListInput) => ServerOpsAuditListResult }
  overview?: ServerOpsOverviewContract
  systemd?: ServerOpsSystemdContract
  logs?: ServerOpsLogContract
  resolveOwnerWindow?: (sender: WebContents) => ServerOpsOwnerWindow | null
  showLogSaveDialog?: (window: ServerOpsOwnerWindow, options: ServerOpsLogSaveDialogOptions) => Promise<{ canceled: boolean; filePath?: string }>
  writeTextFileAtomic?: (filePath: string, content: string) => unknown
  now?: () => Date
  requireUserVisibleSession: (sessionId: string) => AgentSessionMeta
}

/** 可用于测试和退出清理的注册结果。 */
export interface ServerOpsIpcRegistration {
  channels: string[]
  revokeSession: (sessionId: string) => void
  dispose: () => void
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验调用方来自仍存活的授权主窗口。 */
function assertAuthorizedSender(event: IpcMainInvokeEvent, options: ServerOpsIpcOptions): void {
  /** 与当前事件 sender ID 精确匹配的授权窗口。 */
  const authorized = options.listAuthorizedWebContents().some((contents) => (
    !contents.isDestroyed() && contents.id === event.sender.id
  ))
  if (!authorized) throw new Error('SERVER_OPS_ACCESS_DENIED')
}

/** 判断主机 ID 是否满足跨进程稳定标识约束。 */
function parseTerminalInput(value: unknown): ServerOpsTerminalInput {
  if (!isRecord(value) || !Object.keys(value).every((key) => ['hostId', 'connectionId', 'data'].includes(key))) {
    throw new Error('SERVER_OPS_TERMINAL_INPUT_INVALID')
  }
  if (!isServerOpsId(value.hostId) || !isServerOpsId(value.connectionId)
    || typeof value.data !== 'string' || value.data.length < 1 || value.data.length > 65_536) {
    throw new Error('SERVER_OPS_TERMINAL_INPUT_INVALID')
  }
  return { hostId: value.hostId, connectionId: value.connectionId, data: value.data }
}

/** 严格解析远程 PTY resize。 */
function parseTerminalResize(value: unknown): ServerOpsTerminalResizeInput {
  if (!isRecord(value) || !Object.keys(value).every((key) => ['hostId', 'connectionId', 'cols', 'rows'].includes(key))) {
    throw new Error('SERVER_OPS_TERMINAL_SIZE_INVALID')
  }
  if (!isServerOpsId(value.hostId) || !isServerOpsId(value.connectionId)) throw new Error('SERVER_OPS_TERMINAL_SIZE_INVALID')
  /** 复用 connect parser 的统一终端尺寸边界。 */
  const parsed = parseServerOpsConnectInput({ hostId: value.hostId, cols: value.cols, rows: value.rows })
  return { hostId: value.hostId, connectionId: value.connectionId, cols: parsed.cols, rows: parsed.rows }
}

/** 严格解析远程输出 ACK。 */
function parseTerminalOutputAck(value: unknown): ServerOpsTerminalOutputAck {
  if (!isRecord(value) || !Object.keys(value).every((key) => ['hostId', 'connectionId', 'sequence'].includes(key))) {
    throw new Error('SERVER_OPS_TERMINAL_ACK_INVALID')
  }
  if (!isServerOpsId(value.hostId) || !isServerOpsId(value.connectionId)
    || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error('SERVER_OPS_TERMINAL_ACK_INVALID')
  }
  return { hostId: value.hostId, connectionId: value.connectionId, sequence: value.sequence }
}

/** 严格解析远程终端身份。 */
function parseTerminalIdentity(value: unknown): ServerOpsTerminalIdentity {
  if (!isRecord(value) || !Object.keys(value).every((key) => ['hostId', 'connectionId'].includes(key))
    || !isServerOpsId(value.hostId) || !isServerOpsId(value.connectionId)) {
    throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
  }
  return { hostId: value.hostId, connectionId: value.connectionId }
}

/** 注册服务器运维主机资产 IPC。 */
export function registerServerOpsIpcHandlers(options: ServerOpsIpcOptions): ServerOpsIpcRegistration {
  /** 本注册器拥有的全部 IPC 通道。 */
  const channels = [
    SERVER_OPS_IPC_CHANNELS.LIST_HOSTS,
    SERVER_OPS_IPC_CHANNELS.UPSERT_HOST,
    SERVER_OPS_IPC_CHANNELS.DELETE_HOST,
    SERVER_OPS_IPC_CHANNELS.CONNECT,
    SERVER_OPS_IPC_CHANNELS.CONFIRM_HOST_KEY,
    SERVER_OPS_IPC_CHANNELS.DISCONNECT,
    SERVER_OPS_IPC_CHANNELS.WRITE_TERMINAL,
    SERVER_OPS_IPC_CHANNELS.RESIZE_TERMINAL,
    SERVER_OPS_IPC_CHANNELS.ACK_TERMINAL_OUTPUT,
    SERVER_OPS_IPC_CHANNELS.TERMINAL_SNAPSHOT,
    SERVER_OPS_IPC_CHANNELS.GET_AGENT_ACCESS,
    SERVER_OPS_IPC_CHANNELS.SET_AGENT_ACCESS,
    SERVER_OPS_IPC_CHANNELS.REVOKE_AGENT_ACCESS_SESSION,
    SERVER_OPS_IPC_CHANNELS.LIST_AUDIT,
    SERVER_OPS_IPC_CHANNELS.GET_OVERVIEW,
    SERVER_OPS_IPC_CHANNELS.LIST_SERVICES,
    SERVER_OPS_IPC_CHANNELS.GET_SERVICE_DETAIL,
    SERVER_OPS_IPC_CHANNELS.RUN_SERVICE_ACTION,
    SERVER_OPS_IPC_CHANNELS.START_LOG_STREAM,
    SERVER_OPS_IPC_CHANNELS.STOP_LOG_STREAM,
    SERVER_OPS_IPC_CHANNELS.ACK_LOG_OUTPUT,
    SERVER_OPS_IPC_CHANNELS.EXPORT_LOG,
  ]

  /** 当前注册器已见过的窗口 owner。 */
  const owners = new Map<string, ServerOpsOwnerWindow>()
  /** 日志公开 stream 到窗口 owner 的定向路由。 */
  const ownersByStream = new Map<string, string>()
  /** 成功安装的 handler；注册失败时只回滚本次实际拥有的通道。 */
  const installedChannels: string[] = []
  /** 成功安装的领域订阅清理器。 */
  const subscriptions: Array<() => void> = []
  /** 每个 owner 精确绑定的 closed listener。 */
  const closedListeners = new Map<string, { window: ServerOpsOwnerWindow; listener: () => void }>()

  /** 安装一个 handler，并在失败时完整回滚此前注册资源。 */
  const installHandler = (channel: string, handler: ServerOpsIpcHandler): void => {
    try {
      options.ipc.handle(channel, handler)
      installedChannels.push(channel)
    } catch (error) {
      rollbackRegistration()
      throw error
    }
  }

  /** 安装一个领域订阅，并在失败时逆序回滚全部既有资源。 */
  const installSubscription = (subscribe: () => () => void): void => {
    try {
      subscriptions.push(subscribe())
    } catch (error) {
      rollbackRegistration()
      throw error
    }
  }

  /** 从可信 Electron sender 推导并登记稳定 owner。 */
  const requireOwner = (event: IpcMainInvokeEvent): { ownerKey: string; window: ServerOpsOwnerWindow } => {
    const window = options.resolveOwnerWindow?.(event.sender)
    if (!window || window.isDestroyed() || window.webContents.id !== event.sender.id) throw new Error('SERVER_OPS_ACCESS_DENIED')
    const ownerKey = `window:${window.id}`
    if (!owners.has(ownerKey)) {
      /** listener 引用必须保留，registration dispose 才能精确解绑。 */
      const listener = (): void => {
        closedListeners.delete(ownerKey)
        try { options.logs?.disposeOwner(ownerKey) } catch { /* 窗口终态清理不能反向击穿 Electron。 */ }
        owners.delete(ownerKey)
        for (const [streamId, routedOwner] of ownersByStream) {
          if (routedOwner === ownerKey) ownersByStream.delete(streamId)
        }
      }
      window.once('closed', listener)
      closedListeners.set(ownerKey, { window, listener })
      owners.set(ownerKey, window)
    }
    return { ownerKey, window }
  }

  installHandler(SERVER_OPS_IPC_CHANNELS.LIST_HOSTS, (event) => {
    assertAuthorizedSender(event, options)
    return options.hosts.list()
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.LIST_AUDIT, (event, input) => {
    assertAuthorizedSender(event, options)
    return parseServerOpsAuditListResult(options.audit.list(parseServerOpsAuditListInput(input)))
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.UPSERT_HOST, (event, input) => {
    assertAuthorizedSender(event, options)
    /** 严格解析后的主机与凭据组合保存请求。 */
    const parsed: ServerOpsSaveHostInput = parseServerOpsSaveHostInput(input)
    /** 编辑前的公开主机用于验证凭据保留语义。 */
    const previous = parsed.host.id ? options.hosts.get(parsed.host.id) : undefined
    if (parsed.host.id && !previous) throw new Error('SERVER_OPS_HOST_NOT_FOUND')
    if (parsed.credentialUpdate.action === 'keep') {
      if (!previous?.credentialRef) throw new Error('SERVER_OPS_CREDENTIAL_REQUIRED')
      if (previous.authMethod !== parsed.host.authMethod) throw new Error('SERVER_OPS_CREDENTIAL_METHOD_MISMATCH')
    }
    /** 主机资产原子提交后的公开记录。 */
    const saved = options.hosts.upsert(parsed.host)
    if (parsed.credentialUpdate.action === 'keep') return saved
    if (parsed.credentialUpdate.action === 'replace') {
      /** safeStorage 持久化后供公开主机绑定的非敏感引用。 */
      const credentialRef = options.credentials.remember(saved.id, parsed.credentialUpdate.credential)
      return options.hosts.setCredentialRef(saved.id, credentialRef)
    }
    if (previous?.credentialRef) options.credentials.forgetHost(saved.id)
    return previous?.credentialRef || saved.credentialRef
      ? options.hosts.setCredentialRef(saved.id)
      : saved
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.DELETE_HOST, (event, input) => {
    assertAuthorizedSender(event, options)
    if (!isServerOpsId(input)) throw new Error('SERVER_OPS_HOST_ID_INVALID')
    options.connections.disconnect(input)
    /** 只有主机资产实际删除后才清理其安全凭据。 */
    const removed = options.hosts.remove(input)
    if (removed) {
      revokeHostAccess(input)
      options.credentials.forgetHost(input)
    }
    return removed
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.CONNECT, (event, input) => {
    assertAuthorizedSender(event, options)
    return options.connections.connect(parseServerOpsConnectInput(input))
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.CONFIRM_HOST_KEY, (event, input) => {
    assertAuthorizedSender(event, options)
    return options.connections.confirmHostKey(parseServerOpsConfirmHostKeyInput(input))
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.DISCONNECT, (event, input) => {
    assertAuthorizedSender(event, options)
    if (!isServerOpsId(input)) throw new Error('SERVER_OPS_HOST_ID_INVALID')
    /** 仅在连接正常断开后撤销该服务器可能持有的 Agent 授权。 */
    const state = options.connections.disconnect(input)
    revokeHostAccess(input)
    return state
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.WRITE_TERMINAL, (event, input) => {
    assertAuthorizedSender(event, options)
    options.connections.writeTerminal(parseTerminalInput(input))
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.RESIZE_TERMINAL, (event, input) => {
    assertAuthorizedSender(event, options)
    options.connections.resizeTerminal(parseTerminalResize(input))
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.ACK_TERMINAL_OUTPUT, (event, input) => {
    assertAuthorizedSender(event, options)
    options.connections.acknowledgeOutput(parseTerminalOutputAck(input))
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.TERMINAL_SNAPSHOT, (event, input) => {
    assertAuthorizedSender(event, options)
    return options.connections.getTerminalSnapshot(parseTerminalIdentity(input))
  })

  installHandler(SERVER_OPS_IPC_CHANNELS.GET_AGENT_ACCESS, (event, input) => {
    assertAuthorizedSender(event, options)
    const target = parseServerOpsAgentAccessTarget(input)
    requireOrdinaryTopLevelAgentSession(options.requireUserVisibleSession(target.sessionId))
    if (!options.hosts.get(target.hostId)) throw new Error('SERVER_OPS_HOST_NOT_FOUND')
    return options.access.get(target.sessionId, target.hostId) ?? null
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.SET_AGENT_ACCESS, (event, input) => {
    assertAuthorizedSender(event, options)
    const access = parseServerOpsAgentAccessInput(input)
    requireOrdinaryTopLevelAgentSession(options.requireUserVisibleSession(access.sessionId))
    if (!options.hosts.get(access.hostId)) throw new Error('SERVER_OPS_HOST_NOT_FOUND')
    const previous = options.access.getCurrent() ?? null
    if (access.granted) options.access.grant(access)
    else options.access.revoke(access.sessionId, access.hostId)
    const current = options.access.getCurrent() ?? null
    const changed = { previous, current } satisfies ServerOpsAgentAccessChanged
    broadcast(SERVER_OPS_IPC_CHANNELS.AGENT_ACCESS_CHANGED, changed)
    return current
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.REVOKE_AGENT_ACCESS_SESSION, (event, input) => {
    assertAuthorizedSender(event, options)
    if (!isServerOpsId(input)) throw new Error('SERVER_OPS_AGENT_SESSION_ID_INVALID')
    /** 撤权只缩小权限，不依赖会话仍可见或服务器资产仍存在。 */
    revokeSession(input)
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.GET_OVERVIEW, async (event, input) => {
    assertAuthorizedSender(event, options)
    const parsed = parseServerOpsOverviewInput(input)
    if (!options.overview) throw new Error('SERVER_OPS_OVERVIEW_UNAVAILABLE')
    return parseServerOpsOverviewResult(await options.overview.getOverview(parsed))
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.LIST_SERVICES, async (event, input) => {
    assertAuthorizedSender(event, options)
    const parsed = parseServerOpsServiceListInput(input)
    if (!options.systemd) throw new Error('SERVER_OPS_SYSTEMD_UNAVAILABLE')
    return parseServerOpsServiceListResult(await options.systemd.listServices(parsed))
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.GET_SERVICE_DETAIL, async (event, input) => {
    assertAuthorizedSender(event, options)
    const parsed = parseServerOpsServiceDetailInput(input)
    if (!options.systemd) throw new Error('SERVER_OPS_SYSTEMD_UNAVAILABLE')
    return parseServerOpsServiceDetailResult(await options.systemd.getServiceDetail(parsed))
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.RUN_SERVICE_ACTION, async (event, input) => {
    assertAuthorizedSender(event, options)
    /** 动作必须在领域调用前再次重建 DTO 并证明审计会话是普通可见顶层 Agent。 */
    const parsed = parseServerOpsServiceActionInput(input)
    if (!options.systemd) throw new Error('SERVER_OPS_SYSTEMD_UNAVAILABLE')
    requireOrdinaryTopLevelAgentSession(options.requireUserVisibleSession(parsed.sessionId))
    return parseServerOpsServiceActionResult(await options.systemd.runAction(parseServerOpsServiceActionInput(parsed)))
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.START_LOG_STREAM, async (event, input) => {
    assertAuthorizedSender(event, options)
    const parsed = parseServerOpsLogStartInput(input)
    if (!options.logs) throw new Error('SERVER_OPS_LOG_UNAVAILABLE')
    const { ownerKey } = requireOwner(event)
    /** 领域启动结果必须先通过公开合同，失败时只停止本次可证明的远端流。 */
    const rawResult = await options.logs.start(ownerKey, parsed)
    let result: ServerOpsLogStartResult
    try {
      result = parseServerOpsLogStartResult(rawResult)
    } catch (error) {
      const streamId = readServerOpsLogStreamId(rawResult)
      if (streamId) {
        try { options.logs.stop(ownerKey, { hostId: parsed.hostId, streamId }) } catch (stopError) {
          console.error('[Server Ops] 污染日志启动结果回滚失败:', stopError)
        }
      }
      throw error
    }
    /** 每个 owner 只有一个领域流，替换时同步移除旧公开路由。 */
    for (const [streamId, routedOwner] of ownersByStream) {
      if (routedOwner === ownerKey) ownersByStream.delete(streamId)
    }
    ownersByStream.set(result.streamId, ownerKey)
    return parseServerOpsLogStartResult(result)
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.STOP_LOG_STREAM, (event, input) => {
    assertAuthorizedSender(event, options)
    const parsed = parseServerOpsLogIdentity(input)
    if (!options.logs) throw new Error('SERVER_OPS_LOG_UNAVAILABLE')
    const { ownerKey } = requireOwner(event)
    options.logs.stop(ownerKey, parsed)
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.ACK_LOG_OUTPUT, (event, input) => {
    assertAuthorizedSender(event, options)
    const parsed = parseServerOpsLogOutputAck(input)
    if (!options.logs) throw new Error('SERVER_OPS_LOG_UNAVAILABLE')
    const { ownerKey } = requireOwner(event)
    options.logs.acknowledge(ownerKey, parsed)
  })
  installHandler(SERVER_OPS_IPC_CHANNELS.EXPORT_LOG, async (event, input) => {
    assertAuthorizedSender(event, options)
    const parsed = parseServerOpsLogExportInput(input)
    const { window } = requireOwner(event)
    const host = options.hosts.get(parsed.hostId)
    if (!host) throw new Error('SERVER_OPS_HOST_NOT_FOUND')
    if (!options.showLogSaveDialog || !options.writeTextFileAtomic) throw new Error('SERVER_OPS_LOG_EXPORT_FAILED')
    /** 默认文件名只使用公开主机名和 main 当前时间，且移除路径分隔与穿越片段。 */
    const safeHostName = host.name.normalize('NFKC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/\.{2,}/gu, '-')
      .replace(/^\.+|\.+$/gu, '') || 'server'
    const timestamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')
    let dialogResult: { canceled: boolean; filePath?: string }
    try {
      dialogResult = await options.showLogSaveDialog(window, {
        title: '导出服务器日志',
        defaultPath: `${safeHostName}-${timestamp}.log`,
        filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
      })
    } catch {
      throw new Error('SERVER_OPS_LOG_EXPORT_FAILED')
    }
    if (dialogResult.canceled || !dialogResult.filePath) return parseServerOpsLogExportResult({ saved: false })
    try {
      options.writeTextFileAtomic(dialogResult.filePath, parsed.content)
    } catch {
      throw new Error('SERVER_OPS_LOG_EXPORT_FAILED')
    }
    return parseServerOpsLogExportResult({ saved: true })
  })

  /** 向所有仍存活授权窗口广播不含秘密的公开事件。 */
  const broadcast = (channel: string, payload: unknown): void => {
    for (const contents of options.listAuthorizedWebContents()) {
      if (!contents.isDestroyed()) contents.send(channel, payload)
    }
  }
  /** 撤销指定服务器授权，并广播严格公开的旧新状态。 */
  const revokeHostAccess = (hostId: string): void => {
    /** 撤销前快照用于 Renderer 精确同步。 */
    const previous = options.access.getCurrent() ?? null
    if (!previous || !options.access.revokeHost(hostId)) return
    broadcast(SERVER_OPS_IPC_CHANNELS.AGENT_ACCESS_CHANGED, {
      previous,
      current: null,
    } satisfies ServerOpsAgentAccessChanged)
  }
  /** 撤销指定普通 Agent 会话授权，并广播严格公开的旧新状态。 */
  const revokeSession = (sessionId: string): void => {
    /** 撤销前快照用于 Renderer 精确同步。 */
    const previous = options.access.getCurrent() ?? null
    if (!previous || !options.access.revokeSession(sessionId)) return
    broadcast(SERVER_OPS_IPC_CHANNELS.AGENT_ACCESS_CHANGED, {
      previous,
      current: null,
    } satisfies ServerOpsAgentAccessChanged)
  }
  /** 逐项安装 runtime 与日志订阅，使中途失败可精确逆序回滚。 */
  installSubscription(() => options.connections.onState((state) => broadcast(SERVER_OPS_IPC_CHANNELS.CONNECTION_STATE, state)))
  installSubscription(() => options.connections.onOutput((output) => broadcast(SERVER_OPS_IPC_CHANNELS.TERMINAL_OUTPUT, output)))
  installSubscription(() => options.connections.onExit((exit) => {
      /** 非预期远端断线和 runtime 退出都必须收口该主机的 Agent 授权。 */
      revokeHostAccess(exit.hostId)
      broadcast(SERVER_OPS_IPC_CHANNELS.TERMINAL_EXIT, exit)
    }))
  if (options.logs) {
    installSubscription(() => options.logs!.onOutput((event) => {
        try { sendLogEvent(SERVER_OPS_IPC_CHANNELS.LOG_OUTPUT, parseServerOpsLogOutputEvent(event)) } catch { /* 污染领域事件 fail closed。 */ }
      }))
    installSubscription(() => options.logs!.onExit((event) => {
        try {
          const parsed = parseServerOpsLogExitEvent(event)
          sendLogEvent(SERVER_OPS_IPC_CHANNELS.LOG_EXIT, parsed)
          ownersByStream.delete(parsed.streamId)
        } catch {
          /** 污染终态不转发，但仍清理可独立证明的公开 stream 身份。 */
          const streamId = readServerOpsLogStreamId(event)
          if (streamId) ownersByStream.delete(streamId)
        }
      }))
  }

  /** 仅向 stream 所属且仍存活的 BrowserWindow 定向发送日志事件。 */
  function sendLogEvent(channel: string, event: ServerOpsLogOutputEvent | ServerOpsLogExitEvent): void {
    const ownerKey = ownersByStream.get(event.streamId)
    const window = ownerKey ? owners.get(ownerKey) : undefined
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    try { window.webContents.send(channel, event) } catch { /* 单窗口发送失败不能阻断其它领域订阅。 */ }
  }

  /** 精确解绑一个窗口 listener，兼容 Electron EventEmitter 两种接口。 */
  function removeClosedListener(window: ServerOpsOwnerWindow, listener: () => void): void {
    if (window.removeListener) window.removeListener('closed', listener)
    else window.off?.('closed', listener)
  }

  /** 注册失败时逆序、best-effort 回滚所有已安装资源。 */
  function rollbackRegistration(): void {
    for (const unsubscribe of [...subscriptions].reverse()) {
      try { unsubscribe() } catch { /* 保留原注册错误，继续回滚。 */ }
    }
    subscriptions.length = 0
    for (const { window, listener } of [...closedListeners.values()].reverse()) {
      try { removeClosedListener(window, listener) } catch { /* 继续回滚其它 listener。 */ }
    }
    closedListeners.clear()
    for (const ownerKey of [...owners.keys()].reverse()) {
      try { options.logs?.disposeOwner(ownerKey) } catch { /* 继续回滚其它 owner。 */ }
    }
    owners.clear()
    ownersByStream.clear()
    for (const channel of [...installedChannels].reverse()) {
      try { options.ipc.removeHandler(channel) } catch { /* 继续回滚其它 handler。 */ }
    }
    installedChannels.length = 0
  }

  /** 防止 dispose 重复移除其它后续注册器。 */
  let disposed = false
  return {
    channels,
    revokeSession,
    dispose: () => {
      if (disposed) return
      disposed = true
      /** 释放错误延迟到全部资源收口后再抛出。 */
      let firstError: unknown
      for (const unsubscribe of subscriptions) {
        try { unsubscribe() } catch (error) { firstError ??= error }
      }
      subscriptions.length = 0
      for (const { window, listener } of closedListeners.values()) {
        try { removeClosedListener(window, listener) } catch (error) { firstError ??= error }
      }
      closedListeners.clear()
      for (const ownerKey of owners.keys()) {
        try { options.logs?.disposeOwner(ownerKey) } catch (error) { firstError ??= error }
      }
      owners.clear()
      ownersByStream.clear()
      for (const channel of installedChannels) {
        try { options.ipc.removeHandler(channel) } catch (error) { firstError ??= error }
      }
      installedChannels.length = 0
      if (firstError !== undefined) throw firstError
    },
  }
}

/** 从未知领域载荷中只提取可独立证明的公开日志 stream 身份。 */
function readServerOpsLogStreamId(value: unknown): string | null {
  return isRecord(value) && isServerOpsId(value.streamId) ? value.streamId : null
}
