import { isServerOpsId } from './server-ops'

/** 文件传输 IPC 使用的独立通道。 */
export const SERVER_OPS_TRANSFER_CHANNELS = {
  SELECT_UPLOAD: 'server-ops:transfers-select-upload',
  SELECT_DOWNLOAD: 'server-ops:transfers-select-download',
  RELEASE_SELECTION: 'server-ops:transfers-release-selection',
  START: 'server-ops:transfers-start',
  LIST: 'server-ops:transfers-list',
  CANCEL: 'server-ops:transfers-cancel',
  CLOSE_OWNER: 'server-ops:transfers-close-owner',
  PROGRESS: 'server-ops:transfers-progress',
} as const

/** 单文件允许传输的最大字节数。 */
export const SERVER_OPS_TRANSFER_FILE_LIMIT_BYTES = 1_073_741_824
/** Main 与 SFTP runtime 间单次在途 chunk 上限。 */
export const SERVER_OPS_TRANSFER_CHUNK_LIMIT_BYTES = 65_536
/** 全局同时执行的传输数量。 */
export const SERVER_OPS_TRANSFER_ACTIVE_LIMIT = 2
/** 全局等待队列容量。 */
export const SERVER_OPS_TRANSFER_QUEUE_LIMIT = 20

export type ServerOpsTransferDirection = 'upload' | 'download'
export type ServerOpsTransferStatus = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'unknown' | 'pending-check'

export interface ServerOpsTransferStartInput {
  direction: ServerOpsTransferDirection
  hostId: string
  remotePath: string
  /** 系统选择器签发的 opaque lease；Renderer 不得提供本地路径。 */
  leaseId: string
}

export interface ServerOpsTransferUploadSelectionInput { hostId: string }
export interface ServerOpsTransferDownloadSelectionInput { hostId: string; fileName: string }
export interface ServerOpsLocalFileSelection { leaseId: string; fileName: string; size: number }
export interface ServerOpsTransferReleaseSelectionInput { leaseId: string }

export interface ServerOpsTransferListInput { hostId?: string }
export interface ServerOpsTransferCancelInput { hostId: string; transferId: string }
export interface ServerOpsTransferOwnerInput { hostId?: string }

export interface ServerOpsTransferSnapshot {
  transferId: string
  hostId: string
  direction: ServerOpsTransferDirection
  fileName: string
  remotePath: string
  status: ServerOpsTransferStatus
  transferredBytes: number
  totalBytes: number
  createdAt: number
  updatedAt: number
  errorCode?: string
  warning?: 'SERVER_OPS_AUDIT_WRITE_FAILED' | 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED'
}

/** 将未知值收窄为只含允许字段的普通对象。 */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).every((key) => keys.includes(key))) {
    throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  }
  return value as Record<string, unknown>
}

/** 解析共享稳定 ID。 */
function id(value: unknown): string {
  if (!isServerOpsId(value)) throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  return value
}

/** 解析绝对 POSIX 远程路径。 */
function remotePath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4_096 || value.includes('\0')) throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  return value
}

/** 解析不含路径分隔符的公开文件名。 */
function fileName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1_024 || value.includes('\0') || value.includes('/') || value.includes('\\')) throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  return value
}

/** 解析不超过单文件上限的非负字节数。 */
function bytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > SERVER_OPS_TRANSFER_FILE_LIMIT_BYTES) throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  return value
}

/** 解析公开时间戳。 */
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  return value
}

/** 解析稳定错误码，阻断路径和任意底层错误文本。 */
function errorCode(value: unknown): string {
  if (typeof value !== 'string' || !/^SERVER_OPS_[A-Z0-9_]{1,96}$/.test(value)) throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  return value
}

/** 解析上传或下载启动请求。 */
export function parseServerOpsTransferStartInput(value: unknown): ServerOpsTransferStartInput {
  const parsed = record(value, ['direction', 'hostId', 'remotePath', 'leaseId'])
  if (parsed.direction !== 'upload' && parsed.direction !== 'download') throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  return { direction: parsed.direction, hostId: id(parsed.hostId), remotePath: remotePath(parsed.remotePath), leaseId: id(parsed.leaseId) }
}

/** 解析上传系统选择请求。 */
export function parseServerOpsTransferUploadSelectionInput(value: unknown): ServerOpsTransferUploadSelectionInput {
  const parsed = record(value, ['hostId'])
  return { hostId: id(parsed.hostId) }
}

/** 解析下载系统选择请求和建议文件名。 */
export function parseServerOpsTransferDownloadSelectionInput(value: unknown): ServerOpsTransferDownloadSelectionInput {
  const parsed = record(value, ['hostId', 'fileName'])
  return { hostId: id(parsed.hostId), fileName: fileName(parsed.fileName) }
}

/** 解析系统选择器返回的 opaque lease；取消选择返回 null。 */
export function parseServerOpsLocalFileSelection(value: unknown): ServerOpsLocalFileSelection | null {
  if (value === null) return null
  const parsed = record(value, ['leaseId', 'fileName', 'size'])
  return { leaseId: id(parsed.leaseId), fileName: fileName(parsed.fileName), size: bytes(parsed.size) }
}

/** 解析尚未启动传输的单条 lease 释放请求。 */
export function parseServerOpsTransferReleaseSelectionInput(value: unknown): ServerOpsTransferReleaseSelectionInput {
  const parsed = record(value, ['leaseId'])
  return { leaseId: id(parsed.leaseId) }
}

/** 解析可选按主机过滤的传输列表请求。 */
export function parseServerOpsTransferListInput(value: unknown): ServerOpsTransferListInput {
  const parsed = record(value, ['hostId'])
  return parsed.hostId === undefined ? {} : { hostId: id(parsed.hostId) }
}

/** 解析精确取消请求。 */
export function parseServerOpsTransferCancelInput(value: unknown): ServerOpsTransferCancelInput {
  const parsed = record(value, ['hostId', 'transferId'])
  return { hostId: id(parsed.hostId), transferId: id(parsed.transferId) }
}

/** 解析窗口传输 owner 清理请求。 */
export function parseServerOpsTransferOwnerInput(value: unknown): ServerOpsTransferOwnerInput {
  const parsed = record(value, ['hostId'])
  return parsed.hostId === undefined ? {} : { hostId: id(parsed.hostId) }
}

/** 解析单条公开传输快照。 */
export function parseServerOpsTransferSnapshot(value: unknown): ServerOpsTransferSnapshot {
  const parsed = record(value, ['transferId', 'hostId', 'direction', 'fileName', 'remotePath', 'status', 'transferredBytes', 'totalBytes', 'createdAt', 'updatedAt', 'errorCode', 'warning'])
  if (parsed.direction !== 'upload' && parsed.direction !== 'download') throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  if (parsed.status !== 'queued' && parsed.status !== 'running' && parsed.status !== 'cancelling' && parsed.status !== 'succeeded' && parsed.status !== 'failed' && parsed.status !== 'unknown' && parsed.status !== 'pending-check') throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  const totalBytes = bytes(parsed.totalBytes)
  const transferredBytes = bytes(parsed.transferredBytes)
  if (transferredBytes > totalBytes) throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  if (parsed.errorCode !== undefined && parsed.status !== 'failed' && parsed.status !== 'unknown' && parsed.status !== 'pending-check') throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  if (parsed.warning !== undefined && parsed.warning !== 'SERVER_OPS_AUDIT_WRITE_FAILED' && parsed.warning !== 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED') throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  return {
    transferId: id(parsed.transferId), hostId: id(parsed.hostId), direction: parsed.direction,
    fileName: fileName(parsed.fileName), remotePath: remotePath(parsed.remotePath), status: parsed.status,
    transferredBytes, totalBytes, createdAt: timestamp(parsed.createdAt), updatedAt: timestamp(parsed.updatedAt),
    ...(parsed.errorCode === undefined ? {} : { errorCode: errorCode(parsed.errorCode) }),
    ...(parsed.warning === undefined ? {} : { warning: parsed.warning }),
  }
}

/** 解析有界传输快照列表。 */
export function parseServerOpsTransferSnapshots(value: unknown): ServerOpsTransferSnapshot[] {
  if (!Array.isArray(value) || value.length > SERVER_OPS_TRANSFER_ACTIVE_LIMIT + SERVER_OPS_TRANSFER_QUEUE_LIMIT + 1_000) throw new Error('SERVER_OPS_TRANSFER_INPUT_INVALID')
  return value.map(parseServerOpsTransferSnapshot)
}
