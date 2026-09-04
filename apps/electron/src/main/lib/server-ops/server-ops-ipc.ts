import {
  SERVER_OPS_IPC_CHANNELS,
  isServerOpsId,
  parseServerOpsConnectInput,
  parseServerOpsConfirmHostKeyInput,
  parseServerOpsHostInput,
} from '@proma/shared'
import type {
  ServerOpsConnectInput,
  ServerOpsConfirmHostKeyInput,
  ServerOpsConnectionState,
  ServerOpsHost,
  ServerOpsTerminalExitEvent,
  ServerOpsTerminalInput,
  ServerOpsTerminalIdentity,
  ServerOpsTerminalOutputAck,
  ServerOpsTerminalOutputEvent,
  ServerOpsTerminalResizeInput,
  ServerOpsUpsertHostInput,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'

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
  get?: (hostId: string) => ServerOpsHost | undefined
  upsert: (input: ServerOpsUpsertHostInput) => ServerOpsHost
  remove: (hostId: string) => boolean
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
}

/** 运维 IPC 注册所需可信依赖。 */
export interface ServerOpsIpcOptions {
  ipc: ServerOpsIpcRegistrar
  listAuthorizedWebContents: () => WebContents[]
  hosts: ServerOpsHostStoreContract
  connections: ServerOpsConnectionContract
  credentials?: { forgetHost: (hostId: string) => void }
}

/** 可用于测试和退出清理的注册结果。 */
export interface ServerOpsIpcRegistration {
  channels: string[]
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

/** 解析新增或编辑请求，并拒绝未知字段。 */
function parseUpsertInput(value: unknown): ServerOpsUpsertHostInput {
  if (!isRecord(value)) throw new Error('SERVER_OPS_HOST_INPUT_INVALID')
  /** Upsert 允许出现的唯一字段集合。 */
  const allowedKeys = new Set(['id', 'name', 'address', 'port', 'username', 'authMethod', 'tags'])
  if (!Object.keys(value).every((key) => allowedKeys.has(key))) {
    throw new Error('SERVER_OPS_HOST_INPUT_INVALID')
  }
  /** 复用共享合同解析得到的可编辑主机字段。 */
  const parsed = parseServerOpsHostInput({
    name: value.name,
    address: value.address,
    port: value.port,
    username: value.username,
    authMethod: value.authMethod,
    tags: value.tags,
  })
  if (value.id !== undefined && !isServerOpsId(value.id)) {
    throw new Error('SERVER_OPS_HOST_ID_INVALID')
  }
  return { ...parsed, ...(value.id === undefined ? {} : { id: value.id }) }
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
  ]

  options.ipc.handle(SERVER_OPS_IPC_CHANNELS.LIST_HOSTS, (event) => {
    assertAuthorizedSender(event, options)
    return options.hosts.list()
  })
  options.ipc.handle(SERVER_OPS_IPC_CHANNELS.UPSERT_HOST, (event, input) => {
    assertAuthorizedSender(event, options)
    /** 严格解析后的主机写入请求。 */
    const parsed = parseUpsertInput(input)
    /** 编辑前的认证方式用于清理已失效凭据。 */
    const previous = parsed.id ? options.hosts.get?.(parsed.id) : undefined
    /** 主机资产原子提交后的公开记录。 */
    const saved = options.hosts.upsert(parsed)
    if (previous && previous.authMethod !== saved.authMethod) options.credentials?.forgetHost(saved.id)
    return saved
  })
  options.ipc.handle(SERVER_OPS_IPC_CHANNELS.DELETE_HOST, (event, input) => {
    assertAuthorizedSender(event, options)
    if (!isServerOpsId(input)) throw new Error('SERVER_OPS_HOST_ID_INVALID')
    options.connections.disconnect(input)
    /** 只有主机资产实际删除后才清理其安全凭据。 */
    const removed = options.hosts.remove(input)
    if (removed) options.credentials?.forgetHost(input)
    return removed
  })
  options.ipc.handle(SERVER_OPS_IPC_CHANNELS.CONNECT, (event, input) => {
    assertAuthorizedSender(event, options)
    return options.connections.connect(parseServerOpsConnectInput(input))
  })
  options.ipc.handle(SERVER_OPS_IPC_CHANNELS.CONFIRM_HOST_KEY, (event, input) => {
    assertAuthorizedSender(event, options)
    return options.connections.confirmHostKey(parseServerOpsConfirmHostKeyInput(input))
  })
  options.ipc.handle(SERVER_OPS_IPC_CHANNELS.DISCONNECT, (event, input) => {
    assertAuthorizedSender(event, options)
    if (!isServerOpsId(input)) throw new Error('SERVER_OPS_HOST_ID_INVALID')
    return options.connections.disconnect(input)
  })
  options.ipc.handle(SERVER_OPS_IPC_CHANNELS.WRITE_TERMINAL, (event, input) => {
    assertAuthorizedSender(event, options)
    options.connections.writeTerminal(parseTerminalInput(input))
  })
  options.ipc.handle(SERVER_OPS_IPC_CHANNELS.RESIZE_TERMINAL, (event, input) => {
    assertAuthorizedSender(event, options)
    options.connections.resizeTerminal(parseTerminalResize(input))
  })
  options.ipc.handle(SERVER_OPS_IPC_CHANNELS.ACK_TERMINAL_OUTPUT, (event, input) => {
    assertAuthorizedSender(event, options)
    options.connections.acknowledgeOutput(parseTerminalOutputAck(input))
  })
  options.ipc.handle(SERVER_OPS_IPC_CHANNELS.TERMINAL_SNAPSHOT, (event, input) => {
    assertAuthorizedSender(event, options)
    return options.connections.getTerminalSnapshot(parseTerminalIdentity(input))
  })

  /** 向所有仍存活授权窗口广播不含秘密的公开事件。 */
  const broadcast = (channel: string, payload: unknown): void => {
    for (const contents of options.listAuthorizedWebContents()) {
      if (!contents.isDestroyed()) contents.send(channel, payload)
    }
  }
  /** 三类 runtime 事件的订阅清理器。 */
  const subscriptions = [
    options.connections.onState((state) => broadcast(SERVER_OPS_IPC_CHANNELS.CONNECTION_STATE, state)),
    options.connections.onOutput((output) => broadcast(SERVER_OPS_IPC_CHANNELS.TERMINAL_OUTPUT, output)),
    options.connections.onExit((exit) => broadcast(SERVER_OPS_IPC_CHANNELS.TERMINAL_EXIT, exit)),
  ]

  /** 防止 dispose 重复移除其它后续注册器。 */
  let disposed = false
  return {
    channels,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const unsubscribe of subscriptions) unsubscribe()
      for (const channel of channels) options.ipc.removeHandler(channel)
    },
  }
}
