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
  GET_AGENT_ACCESS: 'server-ops:get-agent-access',
  SET_AGENT_ACCESS: 'server-ops:set-agent-access',
  REVOKE_AGENT_ACCESS_SESSION: 'server-ops:revoke-agent-access-session',
  AGENT_ACCESS_CHANGED: 'server-ops:agent-access-changed',
  LIST_AUDIT: 'server-ops:list-audit',
  GET_OVERVIEW: 'server-ops:get-overview',
  LIST_SERVICES: 'server-ops:list-services',
  GET_SERVICE_DETAIL: 'server-ops:get-service-detail',
  RUN_SERVICE_ACTION: 'server-ops:run-service-action',
  START_LOG_STREAM: 'server-ops:start-log-stream',
  STOP_LOG_STREAM: 'server-ops:stop-log-stream',
  ACK_LOG_OUTPUT: 'server-ops:ack-log-output',
  LOG_OUTPUT: 'server-ops:log-output',
  LOG_EXIT: 'server-ops:log-exit',
  EXPORT_LOG: 'server-ops:export-log',
} as const

/** 审计动作的发起主体。 */
export type ServerOpsAuditActor = 'agent' | 'user'

/** Agent 命令和用户 systemd 动作允许进入公开审计的操作。 */
export type ServerOpsAuditOperation =
  | 'connect'
  | 'exec'
  | 'disconnect'
  | 'service-start'
  | 'service-stop'
  | 'service-restart'
  | 'service-enable'
  | 'service-disable'

/** 审计记录处于远程动作开始或完成阶段。 */
export type ServerOpsAuditPhase = 'start' | 'result'

/** 审计阶段的公开结果，不携带远程错误正文。 */
export type ServerOpsAuditOutcome = 'success' | 'error'

/** 可跨 IPC 展示的有界审计记录。 */
export interface ServerOpsAuditRecord {
  id: string
  timestamp: number
  sessionId: string
  hostId: string
  actor: ServerOpsAuditActor
  operation: ServerOpsAuditOperation
  phase: ServerOpsAuditPhase
  outcome: ServerOpsAuditOutcome
  durationMs?: number
  unitId?: string
  command?: string
  commandTruncated?: boolean
  exitCode?: number
  signal?: string
  errorCode?: string
}

/** Store 追加记录时生成 ID 和时间前的公开字段。 */
export interface ServerOpsAuditAppendInput {
  sessionId: string
  hostId: string
  actor: ServerOpsAuditActor
  operation: ServerOpsAuditOperation
  phase: ServerOpsAuditPhase
  outcome: ServerOpsAuditOutcome
  durationMs?: number
  unitId?: string
  command?: string
  exitCode?: number
  signal?: string
  errorCode?: string
}

/** 审计页支持的严格有界筛选。 */
export interface ServerOpsAuditListInput {
  hostId?: string
  actor?: ServerOpsAuditActor
  operation?: ServerOpsAuditOperation
  limit?: number
}

/** 审计 IPC 的稳定公开响应。 */
export interface ServerOpsAuditListResult {
  records: ServerOpsAuditRecord[]
}

/** 概览采集可公开的局部缺失警告。 */
export type ServerOpsOverviewWarningCode =
  | 'SYSTEM_PARTIAL'
  | 'CPU_PARTIAL'
  | 'MEMORY_PARTIAL'
  | 'FILESYSTEM_PARTIAL'
  | 'NETWORK_PARTIAL'
  | 'PROCESS_PARTIAL'
  | 'OUTPUT_TRUNCATED'

/** 获取当前服务器概览的公开请求。 */
export interface ServerOpsOverviewInput { hostId: string }

/** Linux 系统身份与运行时间快照。 */
export interface ServerOpsOverviewSystem {
  hostname: string
  osName: string
  osVersion: string
  kernel: string
  arch: string
  uptimeSeconds: number
}

/** CPU 核心数、利用率和负载快照。 */
export interface ServerOpsOverviewCpu {
  cores: number
  usagePercent: number
  load1: number
  load5: number
  load15: number
}

/** 内存容量快照，单位均为字节。 */
export interface ServerOpsOverviewMemory {
  totalBytes: number
  usedBytes: number
  availableBytes: number
  cacheBytes: number
}

/** Swap 容量快照，单位均为字节。 */
export interface ServerOpsOverviewSwap { totalBytes: number; usedBytes: number }

/** 单个文件系统的容量与挂载信息。 */
export interface ServerOpsOverviewFilesystem {
  device: string
  mountPoint: string
  filesystem: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usagePercent: number
}

/** 采样窗口内的网络收发速率。 */
export interface ServerOpsOverviewNetwork {
  receiveBytesPerSecond: number
  transmitBytesPerSecond: number
}

/** 单个高资源进程的公开摘要。 */
export interface ServerOpsOverviewProcess {
  pid: number
  name: string
  cpuPercent: number
  memoryPercent: number
}

/** 可返回 Renderer 的有界服务器概览。 */
export interface ServerOpsOverviewResult {
  hostId: string
  capturedAt: number
  sampleWindowMs: number
  system?: ServerOpsOverviewSystem
  cpu?: ServerOpsOverviewCpu
  memory?: ServerOpsOverviewMemory
  swap?: ServerOpsOverviewSwap
  filesystems: ServerOpsOverviewFilesystem[]
  network?: ServerOpsOverviewNetwork
  processes: ServerOpsOverviewProcess[]
  warnings: ServerOpsOverviewWarningCode[]
}

/** 目标主机的 systemd 可用能力。 */
export type ServerOpsSystemdCapability = 'available' | 'unsupported' | 'permission-denied'

/** 服务列表预留的标准状态筛选。 */
export type ServerOpsServiceFilter = 'running' | 'failed' | 'stopped' | 'all'

/** 用户可执行的固定 systemd 服务动作。 */
export type ServerOpsServiceAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable'

/** 单个 systemd service 的公开摘要。 */
export interface ServerOpsServiceSummary {
  unitId: string
  description: string
  loadState: string
  activeState: string
  subState: string
  enabled: boolean | null
  mainPid?: number
  activeSince?: string
}

/** 获取 systemd 服务列表的请求。 */
export interface ServerOpsServiceListInput { hostId: string }

/** systemd 服务列表及能力发现结果。 */
export interface ServerOpsServiceListResult {
  hostId: string
  capability: ServerOpsSystemdCapability
  services: ServerOpsServiceSummary[]
  warnings: string[]
}

/** 获取单个 systemd 服务详情的请求。 */
export interface ServerOpsServiceDetailInput { hostId: string; unitId: string }

/** 单个 systemd 服务状态与近期日志。 */
export interface ServerOpsServiceDetailResult {
  hostId: string
  capability: ServerOpsSystemdCapability
  service?: ServerOpsServiceSummary
  statusLines: string[]
  recentLogLines: string[]
  warnings: string[]
}

/** 用户确认后执行固定 systemd 动作的请求。 */
export interface ServerOpsServiceActionInput {
  sessionId: string
  hostId: string
  unitId: string
  action: ServerOpsServiceAction
}

/** systemd 动作完成后的权威回读结果。 */
export interface ServerOpsServiceActionResult {
  hostId: string
  unitId: string
  action: ServerOpsServiceAction
  service?: ServerOpsServiceSummary
  warnings: string[]
}

/** journalctl 日志查询的固定时间范围。 */
export type ServerOpsLogSince = '15m' | '1h' | '6h' | '24h' | 'boot'

/** journalctl 日志查询的标准优先级。 */
export type ServerOpsLogPriority = 'emerg' | 'alert' | 'crit' | 'err' | 'warning' | 'notice' | 'info' | 'debug'

/** 日志来源只允许整个系统或一个严格校验的 service。 */
export type ServerOpsLogSource = { kind: 'system' } | { kind: 'unit'; unitId: string }

/** 启动实时日志流的有界查询。 */
export interface ServerOpsLogStartInput {
  hostId: string
  source: ServerOpsLogSource
  since: ServerOpsLogSince
  priority: ServerOpsLogPriority
  tailLines: number
}

/** 主进程成功创建日志流后的公开身份。 */
export interface ServerOpsLogStartResult { hostId: string; streamId: string }

/** 停止日志流时使用的公开身份。 */
export interface ServerOpsLogIdentity { hostId: string; streamId: string }

/** 一批等待 Renderer 确认的日志输出。 */
export interface ServerOpsLogOutputEvent extends ServerOpsLogIdentity { sequence: number; data: string }

/** Renderer 消费指定日志批次后的确认。 */
export interface ServerOpsLogOutputAck extends ServerOpsLogIdentity { sequence: number }

/** 日志流结束的稳定公开原因。 */
export interface ServerOpsLogExitEvent extends ServerOpsLogIdentity {
  reason: 'stopped' | 'connection-closed' | 'remote-exit' | 'error'
  errorCode?: string
}

/** 将当前 Renderer 中的有界日志内容导出到文件。 */
export interface ServerOpsLogExportInput { hostId: string; content: string }

/** 日志导出取消或成功的稳定结果。 */
export interface ServerOpsLogExportResult { saved: boolean }

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

/** Agent 对单台服务器的当前会话授权状态。 */
export interface ServerOpsAgentAccess {
  sessionId: string
  hostId: string
  granted: boolean
}

/** 查询 Agent 服务器授权时使用的精确目标。 */
export interface ServerOpsAgentAccessTarget {
  sessionId: string
  hostId: string
}

/** Agent 服务器授权变化广播的旧新权威状态。 */
export interface ServerOpsAgentAccessChanged {
  previous: ServerOpsAgentAccess | null
  current: ServerOpsAgentAccess | null
}

/** 新增时不含 ID，编辑时携带目标 ID。 */
export interface ServerOpsUpsertHostInput extends ServerOpsHostInput {
  id?: string
}

/** 保存服务器时持久化的密码凭据，不携带临时连接选项。 */
export interface ServerOpsSavedPasswordCredentialInput {
  kind: 'password'
  password: string
}

/** 保存服务器时持久化的私钥配置，私钥内容仍由主进程按路径读取。 */
export interface ServerOpsSavedPrivateKeyCredentialInput {
  kind: 'private-key'
  keyPath: string
  passphrase?: string
}

/** 允许进入服务器保存请求的持久化凭据。 */
export type ServerOpsSavedCredentialInput = ServerOpsSavedPasswordCredentialInput | ServerOpsSavedPrivateKeyCredentialInput

/** 编辑服务器时对安全凭据执行的显式变更。 */
export type ServerOpsCredentialUpdate =
  | { action: 'keep' }
  | { action: 'clear' }
  | { action: 'replace'; credential: ServerOpsSavedCredentialInput }

/** 保存服务器的四层 IPC 合同，公开资产与秘密变更保持分离。 */
export interface ServerOpsSaveHostInput {
  host: ServerOpsUpsertHostInput
  credentialUpdate: ServerOpsCredentialUpdate
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

/** 新增或编辑主机请求允许出现的公开字段。 */
const SERVER_OPS_UPSERT_HOST_KEYS = new Set([...SERVER_OPS_HOST_INPUT_KEYS, 'id'])

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

/** 审计记录允许出现的公开字段集合。 */
const SERVER_OPS_AUDIT_RECORD_KEYS = new Set([
  'id', 'timestamp', 'sessionId', 'hostId', 'actor', 'operation', 'phase', 'outcome',
  'durationMs', 'unitId', 'command', 'exitCode', 'signal', 'errorCode',
  'commandTruncated',
])

/** 判断未知值是否为允许审计的操作。 */
function isServerOpsAuditOperation(value: unknown): value is ServerOpsAuditOperation {
  return value === 'connect' || value === 'exec' || value === 'disconnect'
    || value === 'service-start' || value === 'service-stop' || value === 'service-restart'
    || value === 'service-enable' || value === 'service-disable'
}

/** 判断审计主体与操作是否符合权限矩阵。 */
function isServerOpsAuditActorOperation(actor: unknown, operation: unknown): actor is ServerOpsAuditActor {
  if (actor === 'agent') return operation === 'connect' || operation === 'exec' || operation === 'disconnect'
  if (actor === 'user') return typeof operation === 'string' && operation.startsWith('service-') && isServerOpsAuditOperation(operation)
  return false
}

/** 校验公开审计记录，拒绝未知字段和所有非有界字符串。 */
export function isServerOpsAuditRecord(value: unknown): value is ServerOpsAuditRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, SERVER_OPS_AUDIT_RECORD_KEYS)) return false
  if (!isServerOpsId(value.id) || !isServerOpsId(value.sessionId) || !isServerOpsId(value.hostId)) return false
  if (!Number.isSafeInteger(value.timestamp) || typeof value.timestamp !== 'number'
    || value.timestamp < 0 || value.timestamp > 8_640_000_000_000_000) return false
  if (!isServerOpsAuditOperation(value.operation)) return false
  if (!isServerOpsAuditActorOperation(value.actor, value.operation)) return false
  if (value.phase !== 'start' && value.phase !== 'result') return false
  if (value.outcome !== 'success' && value.outcome !== 'error') return false
  if (value.durationMs !== undefined
    && (typeof value.durationMs !== 'number' || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > 86_400_000)) return false
  /** 服务动作必须携带安全 unit；其它操作不得借 unit 字段扩展语义。 */
  const isServiceOperation = value.operation.startsWith('service-')
  if (isServiceOperation !== (value.unitId !== undefined)) return false
  if (value.unitId !== undefined && !isValidServerOpsSystemdUnitId(value.unitId)) return false
  if (value.command !== undefined && (typeof value.command !== 'string' || value.command.length > 512)) return false
  if (value.command === undefined) {
    if (value.commandTruncated !== undefined) return false
  } else {
    if (typeof value.commandTruncated !== 'boolean') return false
    if (value.command.length < 512 && value.commandTruncated) return false
  }
  if (value.exitCode !== undefined
    && (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 2_147_483_647)) return false
  if (value.signal !== undefined && (typeof value.signal !== 'string'
    || value.signal.length < 1 || value.signal.length > 64 || !/^[A-Za-z0-9_.:+-]+$/.test(value.signal))) return false
  if (value.errorCode !== undefined && (typeof value.errorCode !== 'string'
    || value.errorCode.length < 1 || value.errorCode.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(value.errorCode))) return false
  /** 只有 Agent exec 审计允许命令与远程进程退出字段。 */
  if (value.operation !== 'exec' && (value.command !== undefined || value.commandTruncated !== undefined
    || value.exitCode !== undefined || value.signal !== undefined)) return false
  /** 开始阶段没有终止结果；成功结果也不能携带失败语义。 */
  if (value.phase === 'start' && (value.exitCode !== undefined || value.signal !== undefined || value.errorCode !== undefined)) return false
  if (value.outcome === 'success' && (value.signal !== undefined || value.errorCode !== undefined
    || (value.exitCode !== undefined && value.exitCode !== 0))) return false
  return true
}

/** 严格解析审计列表筛选，禁止 Renderer 扩大读取合同。 */
export function parseServerOpsAuditListInput(value: unknown): ServerOpsAuditListInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'actor', 'operation', 'limit']))) {
    throw new Error('SERVER_OPS_AUDIT_LIST_INPUT_INVALID')
  }
  if (value.hostId !== undefined && !isServerOpsId(value.hostId)) throw new Error('SERVER_OPS_AUDIT_LIST_INPUT_INVALID')
  if (value.actor !== undefined && value.actor !== 'agent' && value.actor !== 'user') throw new Error('SERVER_OPS_AUDIT_LIST_INPUT_INVALID')
  if (value.operation !== undefined && !isServerOpsAuditOperation(value.operation)) throw new Error('SERVER_OPS_AUDIT_LIST_INPUT_INVALID')
  if (value.actor !== undefined && value.operation !== undefined
    && !isServerOpsAuditActorOperation(value.actor, value.operation)) throw new Error('SERVER_OPS_AUDIT_LIST_INPUT_INVALID')
  if (value.limit !== undefined
    && (typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 5_000)) {
    throw new Error('SERVER_OPS_AUDIT_LIST_INPUT_INVALID')
  }
  return {
    ...(typeof value.hostId === 'string' ? { hostId: value.hostId } : {}),
    ...(value.actor === 'agent' || value.actor === 'user' ? { actor: value.actor } : {}),
    ...(isServerOpsAuditOperation(value.operation) ? { operation: value.operation } : {}),
    ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
  }
}

/** 严格解析审计 IPC 响应，确保 Renderer 永远不接收内部字段。 */
export function parseServerOpsAuditListResult(value: unknown): ServerOpsAuditListResult {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['records']))
    || !Array.isArray(value.records) || value.records.length > 5_000
    || !value.records.every(isServerOpsAuditRecord)) {
    throw new Error('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
  }
  return { records: value.records.map((record) => ({ ...record })) }
}

/** 复用单个 UTF-8 编码器执行跨平台字节上限校验。 */
const SERVER_OPS_TEXT_ENCODER = new TextEncoder()

/** 判断字符串编码后的 UTF-8 字节数是否未超过上限。 */
function hasBoundedUtf8Bytes(value: string, maxBytes: number): boolean {
  // UTF-8 字节数不会小于 UTF-16 code unit 数，先拒绝可避免为明显超限输入分配同量 Uint8Array。
  if (value.length > maxBytes) return false
  return SERVER_OPS_TEXT_ENCODER.encode(value).byteLength <= maxBytes
}

/** 解析有界文本，可按调用方要求接受空字符串或禁止换行。 */
function parseBoundedText(
  value: unknown,
  maxLength: number,
  errorCode: string,
  options: { allowEmpty?: boolean; singleLine?: boolean } = {},
): string {
  if (typeof value !== 'string' || value.length > maxLength || /\0/.test(value)) throw new Error(errorCode)
  if (!options.allowEmpty && value.length === 0) throw new Error(errorCode)
  if (options.singleLine && /[\r\n]/.test(value)) throw new Error(errorCode)
  return value
}

/** 解析指定范围内的有限数值。 */
function parseBoundedNumber(value: unknown, minimum: number, maximum: number, errorCode: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(errorCode)
  return value
}

/** 解析指定范围内的安全整数。 */
function parseBoundedInteger(value: unknown, minimum: number, maximum: number, errorCode: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(errorCode)
  return value
}

/** 判断 systemd unit 是否满足 service 后缀、字符集、转义和 UTF-8 上限。 */
function isValidServerOpsSystemdUnitId(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('.service') || !hasBoundedUtf8Bytes(value, 256)) return false
  for (let index = 0; index < value.length; index += 1) {
    /** 当前待校验的 unit 字符。 */
    const character = value.charAt(index)
    if (character === '\\') {
      if (value[index + 1] !== 'x' || !/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 2, index + 4))) return false
      index += 3
      continue
    }
    if (!/[A-Za-z0-9:_.@-]/.test(character)) return false
  }
  return true
}

/** 严格解析可安全传给 systemctl 或 journalctl 的 service unit。 */
export function parseServerOpsSystemdUnitId(value: unknown): string {
  if (!isValidServerOpsSystemdUnitId(value)) throw new Error('SERVER_OPS_SYSTEMD_UNIT_INVALID')
  return value
}

/** 解析只携带公开 hostId 的概览请求。 */
export function parseServerOpsOverviewInput(value: unknown): ServerOpsOverviewInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId'])) || !isServerOpsId(value.hostId)) {
    throw new Error('SERVER_OPS_OVERVIEW_INPUT_INVALID')
  }
  return { hostId: value.hostId }
}

/** 解析概览中的完整系统信息。 */
function parseServerOpsOverviewSystem(value: unknown): ServerOpsOverviewSystem {
  const errorCode = 'SERVER_OPS_OVERVIEW_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostname', 'osName', 'osVersion', 'kernel', 'arch', 'uptimeSeconds']))) throw new Error(errorCode)
  return {
    hostname: parseBoundedText(value.hostname, 255, errorCode, { singleLine: true }),
    osName: parseBoundedText(value.osName, 256, errorCode, { singleLine: true }),
    osVersion: parseBoundedText(value.osVersion, 256, errorCode, { singleLine: true }),
    kernel: parseBoundedText(value.kernel, 256, errorCode, { singleLine: true }),
    arch: parseBoundedText(value.arch, 64, errorCode, { singleLine: true }),
    uptimeSeconds: parseBoundedInteger(value.uptimeSeconds, 0, Number.MAX_SAFE_INTEGER, errorCode),
  }
}

/** 解析概览中的完整 CPU 信息。 */
function parseServerOpsOverviewCpu(value: unknown): ServerOpsOverviewCpu {
  const errorCode = 'SERVER_OPS_OVERVIEW_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['cores', 'usagePercent', 'load1', 'load5', 'load15']))) throw new Error(errorCode)
  return {
    cores: parseBoundedInteger(value.cores, 1, 65_536, errorCode),
    usagePercent: parseBoundedNumber(value.usagePercent, 0, 100, errorCode),
    load1: parseBoundedNumber(value.load1, 0, Number.MAX_SAFE_INTEGER, errorCode),
    load5: parseBoundedNumber(value.load5, 0, Number.MAX_SAFE_INTEGER, errorCode),
    load15: parseBoundedNumber(value.load15, 0, Number.MAX_SAFE_INTEGER, errorCode),
  }
}

/** 解析概览中的内存字节字段。 */
function parseServerOpsOverviewMemory(value: unknown): ServerOpsOverviewMemory {
  const errorCode = 'SERVER_OPS_OVERVIEW_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['totalBytes', 'usedBytes', 'availableBytes', 'cacheBytes']))) throw new Error(errorCode)
  return {
    totalBytes: parseBoundedInteger(value.totalBytes, 0, Number.MAX_SAFE_INTEGER, errorCode),
    usedBytes: parseBoundedInteger(value.usedBytes, 0, Number.MAX_SAFE_INTEGER, errorCode),
    availableBytes: parseBoundedInteger(value.availableBytes, 0, Number.MAX_SAFE_INTEGER, errorCode),
    cacheBytes: parseBoundedInteger(value.cacheBytes, 0, Number.MAX_SAFE_INTEGER, errorCode),
  }
}

/** 解析概览中的 Swap 字节字段。 */
function parseServerOpsOverviewSwap(value: unknown): ServerOpsOverviewSwap {
  const errorCode = 'SERVER_OPS_OVERVIEW_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['totalBytes', 'usedBytes']))) throw new Error(errorCode)
  return {
    totalBytes: parseBoundedInteger(value.totalBytes, 0, Number.MAX_SAFE_INTEGER, errorCode),
    usedBytes: parseBoundedInteger(value.usedBytes, 0, Number.MAX_SAFE_INTEGER, errorCode),
  }
}

/** 解析一个有界文件系统快照。 */
function parseServerOpsOverviewFilesystem(value: unknown): ServerOpsOverviewFilesystem {
  const errorCode = 'SERVER_OPS_OVERVIEW_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['device', 'mountPoint', 'filesystem', 'totalBytes', 'usedBytes', 'availableBytes', 'usagePercent']))) throw new Error(errorCode)
  return {
    device: parseBoundedText(value.device, 1_024, errorCode, { singleLine: true }),
    mountPoint: parseBoundedText(value.mountPoint, 1_024, errorCode, { singleLine: true }),
    filesystem: parseBoundedText(value.filesystem, 128, errorCode, { singleLine: true }),
    totalBytes: parseBoundedInteger(value.totalBytes, 0, Number.MAX_SAFE_INTEGER, errorCode),
    usedBytes: parseBoundedInteger(value.usedBytes, 0, Number.MAX_SAFE_INTEGER, errorCode),
    availableBytes: parseBoundedInteger(value.availableBytes, 0, Number.MAX_SAFE_INTEGER, errorCode),
    usagePercent: parseBoundedNumber(value.usagePercent, 0, 100, errorCode),
  }
}

/** 解析概览中的网络字节速率。 */
function parseServerOpsOverviewNetwork(value: unknown): ServerOpsOverviewNetwork {
  const errorCode = 'SERVER_OPS_OVERVIEW_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['receiveBytesPerSecond', 'transmitBytesPerSecond']))) throw new Error(errorCode)
  return {
    receiveBytesPerSecond: parseBoundedInteger(value.receiveBytesPerSecond, 0, Number.MAX_SAFE_INTEGER, errorCode),
    transmitBytesPerSecond: parseBoundedInteger(value.transmitBytesPerSecond, 0, Number.MAX_SAFE_INTEGER, errorCode),
  }
}

/** 解析一个高资源进程摘要。 */
function parseServerOpsOverviewProcess(value: unknown): ServerOpsOverviewProcess {
  const errorCode = 'SERVER_OPS_OVERVIEW_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['pid', 'name', 'cpuPercent', 'memoryPercent']))) throw new Error(errorCode)
  return {
    pid: parseBoundedInteger(value.pid, 1, 2_147_483_647, errorCode),
    name: parseBoundedText(value.name, 256, errorCode, { singleLine: true }),
    cpuPercent: parseBoundedNumber(value.cpuPercent, 0, 6_553_600, errorCode),
    memoryPercent: parseBoundedNumber(value.memoryPercent, 0, 100, errorCode),
  }
}

/** 判断未知值是否为稳定概览警告码。 */
function isServerOpsOverviewWarningCode(value: unknown): value is ServerOpsOverviewWarningCode {
  return value === 'SYSTEM_PARTIAL' || value === 'CPU_PARTIAL' || value === 'MEMORY_PARTIAL'
    || value === 'FILESYSTEM_PARTIAL' || value === 'NETWORK_PARTIAL' || value === 'PROCESS_PARTIAL'
    || value === 'OUTPUT_TRUNCATED'
}

/** 严格解析概览响应并创建与输入完全解耦的快照。 */
export function parseServerOpsOverviewResult(value: unknown): ServerOpsOverviewResult {
  const errorCode = 'SERVER_OPS_OVERVIEW_RESULT_INVALID'
  const allowedKeys = new Set(['hostId', 'capturedAt', 'sampleWindowMs', 'system', 'cpu', 'memory', 'swap', 'filesystems', 'network', 'processes', 'warnings'])
  if (!isRecord(value) || !hasOnlyKeys(value, allowedKeys) || !isServerOpsId(value.hostId)
    || !Array.isArray(value.filesystems) || value.filesystems.length > 128
    || !Array.isArray(value.processes) || value.processes.length > 10
    || !Array.isArray(value.warnings) || value.warnings.length > 7
    || !value.warnings.every(isServerOpsOverviewWarningCode)) throw new Error(errorCode)
  /** 去重后保持原始顺序的概览警告。 */
  const warnings = [...new Set(value.warnings)]
  return {
    hostId: value.hostId,
    capturedAt: parseBoundedInteger(value.capturedAt, 0, 8_640_000_000_000_000, errorCode),
    sampleWindowMs: parseBoundedInteger(value.sampleWindowMs, 1, 60_000, errorCode),
    ...(value.system === undefined ? {} : { system: parseServerOpsOverviewSystem(value.system) }),
    ...(value.cpu === undefined ? {} : { cpu: parseServerOpsOverviewCpu(value.cpu) }),
    ...(value.memory === undefined ? {} : { memory: parseServerOpsOverviewMemory(value.memory) }),
    ...(value.swap === undefined ? {} : { swap: parseServerOpsOverviewSwap(value.swap) }),
    filesystems: value.filesystems.map(parseServerOpsOverviewFilesystem),
    ...(value.network === undefined ? {} : { network: parseServerOpsOverviewNetwork(value.network) }),
    processes: value.processes.map(parseServerOpsOverviewProcess),
    warnings,
  }
}

/** 判断 systemd 能力是否属于稳定公开枚举。 */
function isServerOpsSystemdCapability(value: unknown): value is ServerOpsSystemdCapability {
  return value === 'available' || value === 'unsupported' || value === 'permission-denied'
}

/** 判断服务动作是否属于固定允许集合。 */
function isServerOpsServiceAction(value: unknown): value is ServerOpsServiceAction {
  return value === 'start' || value === 'stop' || value === 'restart' || value === 'enable' || value === 'disable'
}

/** 解析单个服务摘要，所有错误映射到所属响应合同。 */
function parseServerOpsServiceSummary(value: unknown, errorCode: string): ServerOpsServiceSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['unitId', 'description', 'loadState', 'activeState', 'subState', 'enabled', 'mainPid', 'activeSince']))
    || !isValidServerOpsSystemdUnitId(value.unitId)
    || (value.enabled !== null && typeof value.enabled !== 'boolean')) throw new Error(errorCode)
  return {
    unitId: value.unitId,
    description: parseBoundedText(value.description, 512, errorCode, { singleLine: true }),
    loadState: parseBoundedText(value.loadState, 64, errorCode, { singleLine: true }),
    activeState: parseBoundedText(value.activeState, 64, errorCode, { singleLine: true }),
    subState: parseBoundedText(value.subState, 64, errorCode, { singleLine: true }),
    enabled: value.enabled,
    ...(value.mainPid === undefined ? {} : { mainPid: parseBoundedInteger(value.mainPid, 0, 2_147_483_647, errorCode) }),
    ...(value.activeSince === undefined ? {} : { activeSince: parseBoundedText(value.activeSince, 256, errorCode, { singleLine: true }) }),
  }
}

/** 解析有界单行字符串数组并复制每个元素。 */
function parseServerOpsLineArray(value: unknown, maxItems: number, maxLineLength: number, errorCode: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(errorCode)
  return value.map((line) => parseBoundedText(line, maxLineLength, errorCode, { allowEmpty: true, singleLine: true }))
}

/** 严格解析服务列表请求。 */
export function parseServerOpsServiceListInput(value: unknown): ServerOpsServiceListInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId'])) || !isServerOpsId(value.hostId)) {
    throw new Error('SERVER_OPS_SERVICE_LIST_INPUT_INVALID')
  }
  return { hostId: value.hostId }
}

/** 严格解析最多一千项的服务列表响应。 */
export function parseServerOpsServiceListResult(value: unknown): ServerOpsServiceListResult {
  const errorCode = 'SERVER_OPS_SERVICE_LIST_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'capability', 'services', 'warnings']))
    || !isServerOpsId(value.hostId) || !isServerOpsSystemdCapability(value.capability)
    || !Array.isArray(value.services) || value.services.length > 1_000) throw new Error(errorCode)
  return {
    hostId: value.hostId,
    capability: value.capability,
    services: value.services.map((service) => parseServerOpsServiceSummary(service, errorCode)),
    warnings: parseServerOpsLineArray(value.warnings, 100, 512, errorCode),
  }
}

/** 严格解析单个服务详情请求。 */
export function parseServerOpsServiceDetailInput(value: unknown): ServerOpsServiceDetailInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'unitId'])) || !isServerOpsId(value.hostId)) {
    throw new Error('SERVER_OPS_SERVICE_DETAIL_INPUT_INVALID')
  }
  return { hostId: value.hostId, unitId: parseServerOpsSystemdUnitId(value.unitId) }
}

/** 严格解析服务详情、状态行与近期日志。 */
export function parseServerOpsServiceDetailResult(value: unknown): ServerOpsServiceDetailResult {
  const errorCode = 'SERVER_OPS_SERVICE_DETAIL_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'capability', 'service', 'statusLines', 'recentLogLines', 'warnings']))
    || !isServerOpsId(value.hostId) || !isServerOpsSystemdCapability(value.capability)) throw new Error(errorCode)
  return {
    hostId: value.hostId,
    capability: value.capability,
    ...(value.service === undefined ? {} : { service: parseServerOpsServiceSummary(value.service, errorCode) }),
    statusLines: parseServerOpsLineArray(value.statusLines, 200, 8_192, errorCode),
    recentLogLines: parseServerOpsLineArray(value.recentLogLines, 200, 8_192, errorCode),
    warnings: parseServerOpsLineArray(value.warnings, 100, 512, errorCode),
  }
}

/** 严格解析一次用户 systemd 服务动作。 */
export function parseServerOpsServiceActionInput(value: unknown): ServerOpsServiceActionInput {
  const errorCode = 'SERVER_OPS_SERVICE_ACTION_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sessionId', 'hostId', 'unitId', 'action']))
    || !isServerOpsId(value.sessionId) || !isServerOpsId(value.hostId) || !isServerOpsServiceAction(value.action)) throw new Error(errorCode)
  return { sessionId: value.sessionId, hostId: value.hostId, unitId: parseServerOpsSystemdUnitId(value.unitId), action: value.action }
}

/** 严格解析服务动作完成后的权威回读。 */
export function parseServerOpsServiceActionResult(value: unknown): ServerOpsServiceActionResult {
  const errorCode = 'SERVER_OPS_SERVICE_ACTION_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'unitId', 'action', 'service', 'warnings']))
    || !isServerOpsId(value.hostId) || !isValidServerOpsSystemdUnitId(value.unitId) || !isServerOpsServiceAction(value.action)) throw new Error(errorCode)
  /** 动作后的权威服务回读，不允许借嵌套对象替换目标 unit。 */
  const service = value.service === undefined ? undefined : parseServerOpsServiceSummary(value.service, errorCode)
  if (service !== undefined && service.unitId !== value.unitId) throw new Error(errorCode)
  return {
    hostId: value.hostId,
    unitId: value.unitId,
    action: value.action,
    ...(service === undefined ? {} : { service }),
    warnings: parseServerOpsLineArray(value.warnings, 100, 512, errorCode),
  }
}

/** 判断日志查询时间范围是否属于固定枚举。 */
function isServerOpsLogSince(value: unknown): value is ServerOpsLogSince {
  return value === '15m' || value === '1h' || value === '6h' || value === '24h' || value === 'boot'
}

/** 判断日志优先级是否属于 syslog 标准枚举。 */
function isServerOpsLogPriority(value: unknown): value is ServerOpsLogPriority {
  return value === 'emerg' || value === 'alert' || value === 'crit' || value === 'err'
    || value === 'warning' || value === 'notice' || value === 'info' || value === 'debug'
}

/** 严格解析日志来源并复制判别联合。 */
function parseServerOpsLogSource(value: unknown): ServerOpsLogSource {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('SERVER_OPS_LOG_START_INPUT_INVALID')
  if (value.kind === 'system' && hasOnlyKeys(value, new Set(['kind']))) return { kind: 'system' }
  if (value.kind === 'unit' && hasOnlyKeys(value, new Set(['kind', 'unitId']))) {
    return { kind: 'unit', unitId: parseServerOpsSystemdUnitId(value.unitId) }
  }
  throw new Error('SERVER_OPS_LOG_START_INPUT_INVALID')
}

/** 严格解析日志流启动请求和初始行数上限。 */
export function parseServerOpsLogStartInput(value: unknown): ServerOpsLogStartInput {
  const errorCode = 'SERVER_OPS_LOG_START_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'source', 'since', 'priority', 'tailLines']))
    || !isServerOpsId(value.hostId) || !isServerOpsLogSince(value.since) || !isServerOpsLogPriority(value.priority)) throw new Error(errorCode)
  return {
    hostId: value.hostId,
    source: parseServerOpsLogSource(value.source),
    since: value.since,
    priority: value.priority,
    tailLines: parseBoundedInteger(value.tailLines, 1, 2_000, errorCode),
  }
}

/** 严格解析日志流创建结果。 */
export function parseServerOpsLogStartResult(value: unknown): ServerOpsLogStartResult {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'streamId']))
    || !isServerOpsId(value.hostId) || !isServerOpsId(value.streamId)) throw new Error('SERVER_OPS_LOG_START_RESULT_INVALID')
  return { hostId: value.hostId, streamId: value.streamId }
}

/** 严格解析停止日志流所需的公开身份。 */
export function parseServerOpsLogIdentity(value: unknown): ServerOpsLogIdentity {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'streamId']))
    || !isServerOpsId(value.hostId) || !isServerOpsId(value.streamId)) throw new Error('SERVER_OPS_LOG_IDENTITY_INVALID')
  return { hostId: value.hostId, streamId: value.streamId }
}

/** 严格解析不超过 32 KiB 的有序日志输出批次。 */
export function parseServerOpsLogOutputEvent(value: unknown): ServerOpsLogOutputEvent {
  const errorCode = 'SERVER_OPS_LOG_OUTPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'streamId', 'sequence', 'data']))
    || !isServerOpsId(value.hostId) || !isServerOpsId(value.streamId)
    || typeof value.data !== 'string' || !hasBoundedUtf8Bytes(value.data, 32 * 1_024)) throw new Error(errorCode)
  return {
    hostId: value.hostId,
    streamId: value.streamId,
    sequence: parseBoundedInteger(value.sequence, 0, Number.MAX_SAFE_INTEGER, errorCode),
    data: value.data,
  }
}

/** 严格解析 Renderer 对日志批次的背压确认。 */
export function parseServerOpsLogOutputAck(value: unknown): ServerOpsLogOutputAck {
  const errorCode = 'SERVER_OPS_LOG_ACK_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'streamId', 'sequence']))
    || !isServerOpsId(value.hostId) || !isServerOpsId(value.streamId)) throw new Error(errorCode)
  return { hostId: value.hostId, streamId: value.streamId, sequence: parseBoundedInteger(value.sequence, 0, Number.MAX_SAFE_INTEGER, errorCode) }
}

/** 严格解析日志流的公开终态事件。 */
export function parseServerOpsLogExitEvent(value: unknown): ServerOpsLogExitEvent {
  const errorCode = 'SERVER_OPS_LOG_EXIT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'streamId', 'reason', 'errorCode']))
    || !isServerOpsId(value.hostId) || !isServerOpsId(value.streamId)
    || (value.reason !== 'stopped' && value.reason !== 'connection-closed' && value.reason !== 'remote-exit' && value.reason !== 'error')) throw new Error(errorCode)
  /** 仅错误终态可选携带稳定错误码。 */
  const parsedErrorCode = value.errorCode === undefined
    ? undefined
    : parseBoundedText(value.errorCode, 128, errorCode, { singleLine: true })
  if (parsedErrorCode !== undefined && (value.reason !== 'error' || !/^[A-Za-z0-9_.:-]+$/.test(parsedErrorCode))) throw new Error(errorCode)
  return { hostId: value.hostId, streamId: value.streamId, reason: value.reason, ...(parsedErrorCode === undefined ? {} : { errorCode: parsedErrorCode }) }
}

/** 严格解析最多 2 MiB 的 UTF-8 日志导出内容。 */
export function parseServerOpsLogExportInput(value: unknown): ServerOpsLogExportInput {
  const errorCode = 'SERVER_OPS_LOG_EXPORT_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'content'])) || !isServerOpsId(value.hostId)
    || typeof value.content !== 'string' || !hasBoundedUtf8Bytes(value.content, 2 * 1_024 * 1_024)) throw new Error(errorCode)
  return { hostId: value.hostId, content: value.content }
}

/** 严格解析日志导出对话框的保存结果。 */
export function parseServerOpsLogExportResult(value: unknown): ServerOpsLogExportResult {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['saved'])) || typeof value.saved !== 'boolean') {
    throw new Error('SERVER_OPS_LOG_EXPORT_RESULT_INVALID')
  }
  return { saved: value.saved }
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

/** 严格解析 Agent 服务器授权请求，拒绝未知字段和不安全 ID。 */
export function parseServerOpsAgentAccessInput(value: unknown): ServerOpsAgentAccess {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sessionId', 'hostId', 'granted']))
    || !isServerOpsId(value.sessionId) || !isServerOpsId(value.hostId) || typeof value.granted !== 'boolean') {
    throw new Error('SERVER_OPS_AGENT_ACCESS_INPUT_INVALID')
  }
  return { sessionId: value.sessionId, hostId: value.hostId, granted: value.granted }
}

/** 严格解析 Agent 服务器授权查询目标，拒绝未知字段和不安全 ID。 */
export function parseServerOpsAgentAccessTarget(value: unknown): ServerOpsAgentAccessTarget {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sessionId', 'hostId']))
    || !isServerOpsId(value.sessionId) || !isServerOpsId(value.hostId)) {
    throw new Error('SERVER_OPS_AGENT_ACCESS_TARGET_INVALID')
  }
  return { sessionId: value.sessionId, hostId: value.hostId }
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

/** 严格解析需要安全持久化的密码或私钥配置。 */
function parseSavedCredentialInput(value: unknown): ServerOpsSavedCredentialInput {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
  if (value.kind === 'password') {
    if (!hasOnlyKeys(value, new Set(['kind', 'password']))) throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
    return {
      kind: 'password',
      password: parseRequiredText(value.password, 8_192, 'SERVER_OPS_CREDENTIAL_INPUT_INVALID', false),
    }
  }
  if (value.kind === 'private-key') {
    if (!hasOnlyKeys(value, new Set(['kind', 'keyPath', 'passphrase']))) throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
    /** 空私钥口令与未提供口令使用同一内部表示。 */
    const passphrase = value.passphrase === undefined || value.passphrase === ''
      ? undefined
      : parseRequiredText(value.passphrase, 8_192, 'SERVER_OPS_CREDENTIAL_INPUT_INVALID', false)
    return {
      kind: 'private-key',
      keyPath: parseRequiredText(value.keyPath, 1_024, 'SERVER_OPS_CREDENTIAL_INPUT_INVALID'),
      ...(passphrase === undefined ? {} : { passphrase }),
    }
  }
  throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
}

/** 严格解析服务器资产与凭据变更组成的一次保存请求。 */
export function parseServerOpsSaveHostInput(value: unknown): ServerOpsSaveHostInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['host', 'credentialUpdate']))
    || !isRecord(value.host) || !hasOnlyKeys(value.host, SERVER_OPS_UPSERT_HOST_KEYS)
    || !isRecord(value.credentialUpdate)) {
    throw new Error('SERVER_OPS_HOST_INPUT_INVALID')
  }
  /** 严格解析后的公开主机字段。 */
  const parsedHost = parseServerOpsHostInput({
    name: value.host.name,
    address: value.host.address,
    port: value.host.port,
    username: value.host.username,
    authMethod: value.host.authMethod,
    tags: value.host.tags,
  })
  if (value.host.id !== undefined && !isServerOpsId(value.host.id)) throw new Error('SERVER_OPS_HOST_ID_INVALID')
  /** 编辑请求中经过稳定 ID 校验的目标主机。 */
  const host: ServerOpsUpsertHostInput = {
    ...parsedHost,
    ...(typeof value.host.id === 'string' ? { id: value.host.id } : {}),
  }
  /** 待执行的凭据变更对象。 */
  const update = value.credentialUpdate

  if (update.action === 'keep') {
    if (!hasOnlyKeys(update, new Set(['action']))) throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
    if (!host.id) throw new Error('SERVER_OPS_CREDENTIAL_REQUIRED')
    if (host.authMethod === 'ssh-agent') throw new Error('SERVER_OPS_CREDENTIAL_METHOD_MISMATCH')
    return { host, credentialUpdate: { action: 'keep' } }
  }
  if (update.action === 'clear') {
    if (!hasOnlyKeys(update, new Set(['action']))) throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
    if (!host.id && host.authMethod !== 'ssh-agent') throw new Error('SERVER_OPS_CREDENTIAL_REQUIRED')
    return { host, credentialUpdate: { action: 'clear' } }
  }
  if (update.action === 'replace') {
    if (!hasOnlyKeys(update, new Set(['action', 'credential']))) throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
    /** 经长度与未知字段校验的待保存凭据。 */
    const credential = parseSavedCredentialInput(update.credential)
    if (host.authMethod === 'ssh-agent' || credential.kind !== host.authMethod) {
      throw new Error('SERVER_OPS_CREDENTIAL_METHOD_MISMATCH')
    }
    return { host, credentialUpdate: { action: 'replace', credential } }
  }
  throw new Error('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
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
