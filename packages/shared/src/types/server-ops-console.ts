/** Docker Console 独立 IPC 通道，禁止复用主机终端输入。 */
export const SERVER_OPS_CONSOLE_IPC_CHANNELS = {
  START: 'server-ops:console-start',
  CLOSE: 'server-ops:console-close',
  WRITE: 'server-ops:console-write',
  RESIZE: 'server-ops:console-resize',
  ACK_OUTPUT: 'server-ops:console-ack-output',
  SNAPSHOT: 'server-ops:console-snapshot',
  OUTPUT: 'server-ops:console-output',
  EXIT: 'server-ops:console-exit',
} as const

export interface ServerOpsConsoleStartInput { hostId: string; containerId: string; cols: number; rows: number }
export interface ServerOpsConsoleIdentity { consoleId: string; hostId: string; connectionId: string; containerId: string }
export interface ServerOpsConsoleInput extends ServerOpsConsoleIdentity { data: string }
export interface ServerOpsConsoleResizeInput extends ServerOpsConsoleIdentity { cols: number; rows: number }
export interface ServerOpsConsoleAck extends ServerOpsConsoleIdentity { sequence: number }
export interface ServerOpsConsoleOutputEvent extends ServerOpsConsoleIdentity { sequence: number; data: string }
export interface ServerOpsConsoleExitEvent extends ServerOpsConsoleIdentity { exitCode?: number; signal?: string; message: string }

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验对象字段与合同完全一致。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** 校验可安全作为 Map key 的公开 ID。 */
function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value)
}

/** Console 只接受 Docker 完整容器 ID，避免名称或短 ID 在重建后指向其他容器。 */
function isContainerId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

/** 校验 PTY 行列边界。 */
function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000
}

/** 严格重建 Console 完整身份。 */
export function parseServerOpsConsoleIdentity(value: unknown): ServerOpsConsoleIdentity {
  if (!hasExactKeys(value, ['consoleId', 'hostId', 'connectionId', 'containerId'])
    || !isId(value.consoleId) || !isId(value.hostId) || !isId(value.connectionId) || !isContainerId(value.containerId)) {
    throw new Error('SERVER_OPS_CONSOLE_IDENTITY_INVALID')
  }
  return { consoleId: value.consoleId, hostId: value.hostId, connectionId: value.connectionId, containerId: value.containerId }
}

export function parseServerOpsConsoleStartInput(value: unknown): ServerOpsConsoleStartInput {
  if (!hasExactKeys(value, ['hostId', 'containerId', 'cols', 'rows'])
    || !isId(value.hostId) || !isContainerId(value.containerId) || !isDimension(value.cols) || !isDimension(value.rows)) {
    throw new Error('SERVER_OPS_CONSOLE_START_INPUT_INVALID')
  }
  return { hostId: value.hostId, containerId: value.containerId, cols: value.cols, rows: value.rows }
}

export function parseServerOpsConsoleInput(value: unknown): ServerOpsConsoleInput {
  if (!hasExactKeys(value, ['consoleId', 'hostId', 'connectionId', 'containerId', 'data'])
    || typeof value.data !== 'string' || value.data.length < 1 || value.data.length > 65_536) {
    throw new Error('SERVER_OPS_CONSOLE_INPUT_INVALID')
  }
  return { ...parseServerOpsConsoleIdentity({ consoleId: value.consoleId, hostId: value.hostId,
    connectionId: value.connectionId, containerId: value.containerId }), data: value.data }
}

export function parseServerOpsConsoleResizeInput(value: unknown): ServerOpsConsoleResizeInput {
  if (!hasExactKeys(value, ['consoleId', 'hostId', 'connectionId', 'containerId', 'cols', 'rows'])
    || !isDimension(value.cols) || !isDimension(value.rows)) throw new Error('SERVER_OPS_CONSOLE_RESIZE_INPUT_INVALID')
  return { ...parseServerOpsConsoleIdentity({ consoleId: value.consoleId, hostId: value.hostId,
    connectionId: value.connectionId, containerId: value.containerId }), cols: value.cols, rows: value.rows }
}

export function parseServerOpsConsoleAck(value: unknown): ServerOpsConsoleAck {
  if (!hasExactKeys(value, ['consoleId', 'hostId', 'connectionId', 'containerId', 'sequence'])
    || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error('SERVER_OPS_CONSOLE_ACK_INVALID')
  }
  return { ...parseServerOpsConsoleIdentity({ consoleId: value.consoleId, hostId: value.hostId,
    connectionId: value.connectionId, containerId: value.containerId }), sequence: value.sequence }
}

export function parseServerOpsConsoleOutputEvent(value: unknown): ServerOpsConsoleOutputEvent {
  if (!hasExactKeys(value, ['consoleId', 'hostId', 'connectionId', 'containerId', 'sequence', 'data'])
    || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || typeof value.data !== 'string' || value.data.length > 1_048_832) throw new Error('SERVER_OPS_CONSOLE_OUTPUT_INVALID')
  return { ...parseServerOpsConsoleIdentity({ consoleId: value.consoleId, hostId: value.hostId,
    connectionId: value.connectionId, containerId: value.containerId }), sequence: value.sequence, data: value.data }
}

export function parseServerOpsConsoleExitEvent(value: unknown): ServerOpsConsoleExitEvent {
  const keys = ['consoleId', 'hostId', 'connectionId', 'containerId', 'message']
  if (!hasExactKeys(value, isRecord(value)
    ? [...keys, ...(value.exitCode === undefined ? [] : ['exitCode']), ...(value.signal === undefined ? [] : ['signal'])] : keys)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 256
    || (value.exitCode !== undefined && (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode)))
    || (value.signal !== undefined && (typeof value.signal !== 'string' || value.signal.length < 1 || value.signal.length > 64))) {
    throw new Error('SERVER_OPS_CONSOLE_EXIT_INVALID')
  }
  return { ...parseServerOpsConsoleIdentity({ consoleId: value.consoleId, hostId: value.hostId,
    connectionId: value.connectionId, containerId: value.containerId }),
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
    ...(typeof value.signal === 'string' ? { signal: value.signal } : {}), message: value.message }
}
