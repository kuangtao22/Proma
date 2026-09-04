/** 服务器运维 IPC 使用的独立命名空间。 */
export const SERVER_OPS_IPC_CHANNELS = {
  LIST_HOSTS: 'server-ops:list-hosts',
  UPSERT_HOST: 'server-ops:upsert-host',
  DELETE_HOST: 'server-ops:delete-host',
  CONNECT: 'server-ops:connect',
  CONFIRM_HOST_KEY: 'server-ops:confirm-host-key',
  DISCONNECT: 'server-ops:disconnect',
  WRITE_TERMINAL: 'server-ops:write-terminal',
  RESIZE_TERMINAL: 'server-ops:resize-terminal',
  ACK_TERMINAL_OUTPUT: 'server-ops:ack-terminal-output',
  TERMINAL_SNAPSHOT: 'server-ops:terminal-snapshot',
  CONNECTION_STATE: 'server-ops:connection-state',
  TERMINAL_OUTPUT: 'server-ops:terminal-output',
  TERMINAL_EXIT: 'server-ops:terminal-exit',
} as const

/** 首版支持的 SSH 认证方式。 */
export type ServerOpsAuthMethod = 'password' | 'ssh-agent' | 'private-key'

/** 用户可编辑且不含凭据的 Linux SSH 主机字段。 */
export interface ServerOpsHostInput {
  name: string
  address: string
  port: number
  username: string
  authMethod: ServerOpsAuthMethod
  tags: string[]
}

/** 已持久化并可返回 Renderer 的服务器资产。 */
export interface ServerOpsHost extends ServerOpsHostInput {
  id: string
  credentialRef?: string
  createdAt: number
  updatedAt: number
}

/** 新增时不含 ID，编辑时携带目标 ID。 */
export interface ServerOpsUpsertHostInput extends ServerOpsHostInput {
  id?: string
}

/** 一次连接使用的密码凭据。 */
export interface ServerOpsPasswordCredentialInput {
  kind: 'password'
  password: string
  remember: boolean
}

/** 一次连接使用的私钥凭据；路径只允许进入专用凭据通道。 */
export interface ServerOpsPrivateKeyCredentialInput {
  kind: 'private-key'
  keyPath: string
  passphrase?: string
  remember: boolean
}

/** SSH Agent 认证不携带秘密。 */
export interface ServerOpsAgentCredentialInput {
  kind: 'ssh-agent'
}

/** Renderer 仅在连接请求中提交的一次性凭据。 */
export type ServerOpsCredentialInput = ServerOpsPasswordCredentialInput | ServerOpsPrivateKeyCredentialInput | ServerOpsAgentCredentialInput

/** 创建真实 SSH 连接与远程 PTY 的请求。 */
export interface ServerOpsConnectInput {
  hostId: string
  cols: number
  rows: number
  credential?: ServerOpsCredentialInput
}

/** 用户确认首次观测 Host Key 后发起 fresh reconnect 的请求。 */
export interface ServerOpsConfirmHostKeyInput {
  hostId: string
  candidateId: string
  cols: number
  rows: number
}

/** Host Key 的公开算法与 OpenSSH SHA-256 指纹。 */
export interface ServerOpsHostKey {
  algorithm: string
  fingerprint: string
}

/** 等待用户确认的首次 Host Key 候选。 */
export interface ServerOpsHostKeyCandidate extends ServerOpsHostKey {
  candidateId: string
}

/** 运维连接生命周期阶段。 */
export type ServerOpsConnectionPhase = 'disconnected' | 'connecting' | 'host-key-required' | 'connected' | 'disconnecting' | 'blocked' | 'error'

/** Renderer 可观察的公开 SSH 连接状态。 */
export interface ServerOpsConnectionState {
  hostId: string
  phase: ServerOpsConnectionPhase
  connectionId?: string
  hostKey?: ServerOpsHostKey
  candidate?: ServerOpsHostKeyCandidate
  previousHostKey?: ServerOpsHostKey
  errorCode?: string
  message?: string
}

/** 发送给远程 PTY 的用户输入。 */
export interface ServerOpsTerminalInput {
  hostId: string
  connectionId: string
  data: string
}

/** 调整远程 PTY 行列的请求。 */
export interface ServerOpsTerminalResizeInput {
  hostId: string
  connectionId: string
  cols: number
  rows: number
}

/** 远程 PTY 的一批有序输出。 */
export interface ServerOpsTerminalOutputEvent {
  hostId: string
  connectionId: string
  sequence: number
  data: string
}

/** Renderer 完成一批远程输出渲染后的确认。 */
export interface ServerOpsTerminalOutputAck {
  hostId: string
  connectionId: string
  sequence: number
}

/** 查询当前未确认输出所需的终端身份。 */
export interface ServerOpsTerminalIdentity {
  hostId: string
  connectionId: string
}

/** 远程 PTY 或底层 SSH 连接退出事件。 */
export interface ServerOpsTerminalExitEvent {
  hostId: string
  connectionId: string
  exitCode?: number
  signal?: string
  message: string
}

/** 主机输入允许出现的字段，避免凭据或拼写错误静默进入持久化文件。 */
const SERVER_OPS_HOST_INPUT_KEYS = new Set(['name', 'address', 'port', 'username', 'authMethod', 'tags'])

/** 主机持久化记录允许出现的完整字段。 */
const SERVER_OPS_HOST_KEYS = new Set([...SERVER_OPS_HOST_INPUT_KEYS, 'id', 'credentialRef', 'createdAt', 'updatedAt'])

/** 判断未知值是否为可枚举的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验对象只包含允许字段。 */
function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

/** 解析有长度上限的必填文本。 */
function parseRequiredText(value: unknown, maxLength: number, errorCode: string, trim = true): string {
  if (typeof value !== 'string') throw new Error(errorCode)
  /** 是否保留原始两侧空白由秘密字段决定。 */
  const normalized = trim ? value.trim() : value
  if (!normalized || normalized.length > maxLength || /[\0]/.test(normalized)) throw new Error(errorCode)
  if (trim && /[\r\n]/.test(normalized)) throw new Error(errorCode)
  return normalized
}

/** 解析并去重主机标签。 */
function parseTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('SERVER_OPS_HOST_TAGS_INVALID')
  /** 规范化并去重后的标签。 */
  const tags: string[] = []
  /** 用于常数时间判重的标签集合。 */
  const seen = new Set<string>()
  for (const item of value) {
    /** 当前标签去除两侧空白后的值。 */
    const tag = parseRequiredText(item, 32, 'SERVER_OPS_HOST_TAGS_INVALID')
    if (!seen.has(tag)) {
      seen.add(tag)
      tags.push(tag)
    }
  }
  return tags
}

/** 判断跨进程稳定 ID 是否可安全用作 Map key。 */
export function isServerOpsId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)
}

/** 解析远程 PTY 的有限行列。 */
function parseTerminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 1 || cols > 1_000
    || typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 || rows > 1_000) {
    throw new Error('SERVER_OPS_TERMINAL_SIZE_INVALID')
  }
  return { cols, rows }
}

/** 解析 Renderer 或持久化来源的主机输入。 */
export function parseServerOpsHostInput(value: unknown): ServerOpsHostInput {
  if (!isRecord(value) || !hasOnlyKeys(value, SERVER_OPS_HOST_INPUT_KEYS)) throw new Error('SERVER_OPS_HOST_INPUT_INVALID')
  if (!Number.isInteger(value.port) || typeof value.port !== 'number' || value.port < 1 || value.port > 65_535) {
    throw new Error('SERVER_OPS_HOST_PORT_INVALID')
  }
  if (value.authMethod !== 'password' && value.authMethod !== 'ssh-agent' && value.authMethod !== 'private-key') {
    throw new Error('SERVER_OPS_HOST_AUTH_METHOD_INVALID')
  }
  /** 主机地址禁止空白和 Shell 风格控制字符。 */
  const address = parseRequiredText(value.address, 255, 'SERVER_OPS_HOST_ADDRESS_INVALID')
  if (/\s/.test(address)) throw new Error('SERVER_OPS_HOST_ADDRESS_INVALID')
  /** SSH 登录用户名。 */
  const username = parseRequiredText(value.username, 64, 'SERVER_OPS_HOST_USERNAME_INVALID')
  if (/\s/.test(username)) throw new Error('SERVER_OPS_HOST_USERNAME_INVALID')
  return {
    name: parseRequiredText(value.name, 100, 'SERVER_OPS_HOST_NAME_INVALID'),
    address,
    port: value.port,
    username,
    authMethod: value.authMethod,
    tags: parseTags(value.tags),
  }
}

/** 严格解析一次 SSH 连接请求及其短生命周期秘密。 */
export function parseServerOpsConnectInput(value: unknown): ServerOpsConnectInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'cols', 'rows', 'credential']))) {
    throw new Error('SERVER_OPS_CONNECT_INPUT_INVALID')
  }
  if (!isServerOpsId(value.hostId)) throw new Error('SERVER_OPS_HOST_ID_INVALID')
  /** 经上限校验的终端初始尺寸。 */
  const size = parseTerminalSize(value.cols, value.rows)
  if (value.credential === undefined) return { hostId: value.hostId, ...size }
  return { hostId: value.hostId, ...size, credential: parseCredentialInput(value.credential) }
}

/** 解析首次 Host Key 确认请求。 */
export function parseServerOpsConfirmHostKeyInput(value: unknown): ServerOpsConfirmHostKeyInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'candidateId', 'cols', 'rows']))) {
    throw new Error('SERVER_OPS_HOST_KEY_CONFIRM_INVALID')
  }
  if (!isServerOpsId(value.hostId) || !isServerOpsId(value.candidateId)) throw new Error('SERVER_OPS_HOST_KEY_CONFIRM_INVALID')
  return { hostId: value.hostId, candidateId: value.candidateId, ...parseTerminalSize(value.cols, value.rows) }
}

/** 严格解析一次性密码、私钥或 SSH Agent 凭据。 */
function parseCredentialInput(value: unknown): ServerOpsCredentialInput {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
  if (value.kind === 'ssh-agent') {
    if (!hasOnlyKeys(value, new Set(['kind']))) throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
    return { kind: 'ssh-agent' }
  }
  if (value.kind === 'password') {
    if (!hasOnlyKeys(value, new Set(['kind', 'password', 'remember'])) || typeof value.remember !== 'boolean') {
      throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
    }
    return { kind: 'password', password: parseRequiredText(value.password, 8_192, 'SERVER_OPS_CREDENTIAL_INPUT_INVALID', false), remember: value.remember }
  }
  if (value.kind === 'private-key') {
    if (!hasOnlyKeys(value, new Set(['kind', 'keyPath', 'passphrase', 'remember'])) || typeof value.remember !== 'boolean') {
      throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
    }
    /** 私钥 passphrase 保留原始空白；空字符串等同于未提供。 */
    const passphrase = value.passphrase === undefined || value.passphrase === '' ? undefined : parseRequiredText(value.passphrase, 8_192, 'SERVER_OPS_CREDENTIAL_INPUT_INVALID', false)
    return {
      kind: 'private-key',
      keyPath: parseRequiredText(value.keyPath, 1_024, 'SERVER_OPS_CREDENTIAL_INPUT_INVALID'),
      ...(passphrase === undefined ? {} : { passphrase }),
      remember: value.remember,
    }
  }
  throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
}

/** 判断持久化值是否为完整公开主机列表。 */
export function isServerOpsHostList(value: unknown): value is ServerOpsHost[] {
  if (!Array.isArray(value)) return false
  return value.every((item) => {
    if (!isRecord(item) || !hasOnlyKeys(item, SERVER_OPS_HOST_KEYS)) return false
    if (!isServerOpsId(item.id)) return false
    if (item.credentialRef !== undefined && !isServerOpsId(item.credentialRef)) return false
    if (!Number.isSafeInteger(item.createdAt) || typeof item.createdAt !== 'number' || item.createdAt < 0) return false
    if (!Number.isSafeInteger(item.updatedAt) || typeof item.updatedAt !== 'number' || item.updatedAt < item.createdAt) return false
    try {
      parseServerOpsHostInput({ name: item.name, address: item.address, port: item.port, username: item.username, authMethod: item.authMethod, tags: item.tags })
      return true
    } catch {
      return false
    }
  })
}
