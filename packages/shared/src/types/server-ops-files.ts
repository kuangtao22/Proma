import { isServerOpsId } from './server-ops'

/** 文件领域 IPC 使用独立通道，owner 始终由 Main 从调用窗口派生。 */
export const SERVER_OPS_FILE_CHANNELS = {
  LIST: 'server-ops:files-list',
  PREVIEW: 'server-ops:files-preview',
  PREPARE: 'server-ops:files-prepare',
  COMMIT: 'server-ops:files-commit',
  CANCEL: 'server-ops:files-cancel',
  CLOSE_OWNER: 'server-ops:files-close-owner',
} as const

export const SERVER_OPS_FILE_PAGE_LIMIT = 200
export const SERVER_OPS_FILE_PREVIEW_LIMIT_BYTES = 1_048_576
export const SERVER_OPS_FILE_CHUNK_LIMIT_BYTES = 65_536

/** 共享 parser 使用浏览器和 Node 均可用的 UTF-8 编码器。 */
const utf8Encoder = new TextEncoder()

export type ServerOpsFileKind = 'file' | 'directory' | 'symlink' | 'other'
export type ServerOpsFileListTruncatedReason = 'item-limit' | 'byte-limit' | 'server-batch-overflow'

export interface ServerOpsFileStat { size: number; mtime: number; mode: number }
export interface ServerOpsFileEditToken extends ServerOpsFileStat { path: string; hash: string }
export interface ServerOpsFileEntry extends ServerOpsFileStat { name: string; path: string; kind: ServerOpsFileKind }
export interface ServerOpsFileListInput { hostId: string; path: string; cursor?: string }
export interface ServerOpsFileListResult {
  hostId: string
  path: string
  entries: ServerOpsFileEntry[]
  cursor?: string
  truncatedReason?: ServerOpsFileListTruncatedReason
}
export interface ServerOpsFilePreviewInput { hostId: string; path: string }
export interface ServerOpsFileTextPreview extends ServerOpsFilePreviewInput {
  kind: 'text'
  content: string
  bytesRead: number
  hash: string
  stat: ServerOpsFileStat
  editToken: ServerOpsFileEditToken
}
export interface ServerOpsFileBinaryPreview extends ServerOpsFilePreviewInput {
  kind: 'binary'
  bytesRead: number
  hash: string
  stat: ServerOpsFileStat
}
export interface ServerOpsFileTooLargePreview extends ServerOpsFilePreviewInput {
  kind: 'too-large'
  bytesRead: 0
  stat: ServerOpsFileStat
}
export interface ServerOpsFileSymlinkPreview extends ServerOpsFilePreviewInput {
  kind: 'symlink'
  bytesRead: 0
  target: string
  stat: ServerOpsFileStat
}
export type ServerOpsFilePreviewResult = ServerOpsFileTextPreview | ServerOpsFileBinaryPreview | ServerOpsFileTooLargePreview | ServerOpsFileSymlinkPreview

export type ServerOpsFileMutationInput =
  | { hostId: string; action: 'mkdir'; path: string }
  | { hostId: string; action: 'rename'; path: string; destinationPath: string }
  | { hostId: string; action: 'delete'; path: string; targetKind: 'file' | 'directory' | 'symlink' }
  | { hostId: string; action: 'save-as'; path: string; content: string }
  | { hostId: string; action: 'save'; path: string; content: string; editToken: ServerOpsFileEditToken }

export interface ServerOpsFileTransferChunk { handleId: string; position: number; data: Uint8Array }
export interface ServerOpsFileCandidate {
  candidateId: string
  hostId: string
  hostName: string
  action: ServerOpsFileMutationInput['action']
  path: string
  destinationPath?: string
  targetKind?: 'file' | 'directory' | 'symlink'
  expiresAt: number
}
export interface ServerOpsFileCommitInput { hostId: string; candidateId: string; confirmationName: string }
export interface ServerOpsFileCancelInput { hostId: string; candidateId: string }
export interface ServerOpsFileOwnerInput { hostId: string }
export interface ServerOpsFileMutationResult {
  hostId: string
  action: ServerOpsFileMutationInput['action']
  path: string
  outcome: 'success' | 'unknown'
  warning?: 'SERVER_OPS_AUDIT_WRITE_FAILED'
}

/** 将未知值收窄为只含允许字段的普通对象。 */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).every((key) => keys.includes(key))) {
    throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  }
  return value as Record<string, unknown>
}

/** 解析沿用 Server Ops 稳定标识规则的公开 ID。 */
function id(value: unknown): string {
  if (!isServerOpsId(value)) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  return value
}

/** 解析不含 NUL 的绝对 POSIX 远程路径。 */
function path(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4_096 || value.includes('\0')) {
    throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  }
  return value
}

/** 解析服务端文件名；远程名称可含换行等合法字符，但不能含路径分隔符。 */
function name(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1_024 || value.includes('\0') || value.includes('/')) {
    throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  }
  return value
}

/** 解析非负安全整数。 */
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  return value
}

/** 解析有界哈希标识，不限定底层采用 hex 或 base64 展示。 */
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[A-Za-z0-9+/=_-]{1,128}$/.test(value)) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  return value
}

/** 严格解析远程文件 stat 事实。 */
function stat(value: unknown): ServerOpsFileStat {
  const parsed = record(value, ['size', 'mtime', 'mode'])
  return { size: integer(parsed.size), mtime: integer(parsed.mtime), mode: integer(parsed.mode) }
}

/** 严格解析文本预览绑定的编辑事实。 */
function editToken(value: unknown): ServerOpsFileEditToken {
  const parsed = record(value, ['path', 'size', 'mtime', 'mode', 'hash'])
  return { path: path(parsed.path), size: integer(parsed.size), mtime: integer(parsed.mtime), mode: integer(parsed.mode), hash: hash(parsed.hash) }
}

/** 解析目录分页请求。 */
export function parseServerOpsFileListInput(value: unknown): ServerOpsFileListInput {
  const parsed = record(value, ['hostId', 'path', 'cursor'])
  return { hostId: id(parsed.hostId), path: path(parsed.path), ...(parsed.cursor === undefined ? {} : { cursor: id(parsed.cursor) }) }
}

/** 解析目录分页公开结果，并约束单页数量。 */
export function parseServerOpsFileListResult(value: unknown): ServerOpsFileListResult {
  const parsed = record(value, ['hostId', 'path', 'entries', 'cursor', 'truncatedReason'])
  if (!Array.isArray(parsed.entries) || parsed.entries.length > SERVER_OPS_FILE_PAGE_LIMIT) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  const entries = parsed.entries.map((entry) => {
    const item = record(entry, ['name', 'path', 'kind', 'size', 'mtime', 'mode'])
    if (item.kind !== 'file' && item.kind !== 'directory' && item.kind !== 'symlink' && item.kind !== 'other') throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
    const kind: ServerOpsFileKind = item.kind
    return { name: name(item.name), path: path(item.path), kind, size: integer(item.size), mtime: integer(item.mtime), mode: integer(item.mode) }
  })
  if (utf8Encoder.encode(JSON.stringify(entries)).byteLength > 262_144) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  const truncatedReason = parsed.truncatedReason
  if (truncatedReason !== undefined && truncatedReason !== 'item-limit' && truncatedReason !== 'byte-limit' && truncatedReason !== 'server-batch-overflow') {
    throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  }
  return {
    hostId: id(parsed.hostId), path: path(parsed.path), entries,
    ...(parsed.cursor === undefined ? {} : { cursor: id(parsed.cursor) }),
    ...(truncatedReason === undefined ? {} : { truncatedReason }),
  }
}

/** 解析文件预览请求。 */
export function parseServerOpsFilePreviewInput(value: unknown): ServerOpsFilePreviewInput {
  const parsed = record(value, ['hostId', 'path'])
  return { hostId: id(parsed.hostId), path: path(parsed.path) }
}

/** 解析文件预览判别结果，验证正文、哈希和编辑事实彼此一致。 */
export function parseServerOpsFilePreviewResult(value: unknown): ServerOpsFilePreviewResult {
  const parsed = record(value, ['hostId', 'path', 'kind', 'content', 'bytesRead', 'hash', 'stat', 'editToken', 'target'])
  const base = { hostId: id(parsed.hostId), path: path(parsed.path) }
  const parsedStat = stat(parsed.stat)
  if (parsed.kind === 'too-large') {
    if (parsed.bytesRead !== 0 || parsedStat.size <= SERVER_OPS_FILE_PREVIEW_LIMIT_BYTES || parsed.content !== undefined || parsed.hash !== undefined || parsed.editToken !== undefined || parsed.target !== undefined) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
    return { ...base, kind: 'too-large', bytesRead: 0, stat: parsedStat }
  }
  if (parsed.kind === 'symlink') {
    if (parsed.bytesRead !== 0 || typeof parsed.target !== 'string' || parsed.target.length > 4_096 || parsed.target.includes('\0') || parsed.content !== undefined || parsed.hash !== undefined || parsed.editToken !== undefined) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
    return { ...base, kind: 'symlink', bytesRead: 0, target: parsed.target, stat: parsedStat }
  }
  const bytesRead = integer(parsed.bytesRead)
  const parsedHash = hash(parsed.hash)
  if (bytesRead > SERVER_OPS_FILE_PREVIEW_LIMIT_BYTES || parsed.target !== undefined) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  if (parsed.kind === 'binary') {
    if (parsed.content !== undefined || parsed.editToken !== undefined) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
    return { ...base, kind: 'binary', bytesRead, hash: parsedHash, stat: parsedStat }
  }
  if (parsed.kind !== 'text' || typeof parsed.content !== 'string' || utf8Encoder.encode(parsed.content).byteLength !== bytesRead || parsedStat.size !== bytesRead) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  const token = editToken(parsed.editToken)
  if (token.path !== base.path || token.size !== parsedStat.size || token.mtime !== parsedStat.mtime || token.mode !== parsedStat.mode || token.hash !== parsedHash) {
    throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  }
  return { ...base, kind: 'text', content: parsed.content, bytesRead, hash: parsedHash, stat: parsedStat, editToken: token }
}

/** 解析文件变更意图；合同不提供递归删除、权限修改或本地路径。 */
export function parseServerOpsFileMutationInput(value: unknown): ServerOpsFileMutationInput {
  const parsed = record(value, ['hostId', 'action', 'path', 'destinationPath', 'targetKind', 'content', 'editToken'])
  const base = { hostId: id(parsed.hostId), path: path(parsed.path) }
  if (parsed.action === 'mkdir' && parsed.destinationPath === undefined && parsed.targetKind === undefined
    && parsed.content === undefined && parsed.editToken === undefined) return { ...base, action: 'mkdir' }
  if (parsed.action === 'rename' && parsed.targetKind === undefined && parsed.content === undefined
    && parsed.editToken === undefined) return { ...base, action: 'rename', destinationPath: path(parsed.destinationPath) }
  if (parsed.action === 'delete' && parsed.destinationPath === undefined && parsed.content === undefined
    && parsed.editToken === undefined && (parsed.targetKind === 'file' || parsed.targetKind === 'directory' || parsed.targetKind === 'symlink')) {
    return { ...base, action: 'delete', targetKind: parsed.targetKind }
  }
  if (parsed.action === 'save-as' && typeof parsed.content === 'string' && utf8Encoder.encode(parsed.content).byteLength <= SERVER_OPS_FILE_PREVIEW_LIMIT_BYTES) {
    if (parsed.destinationPath !== undefined || parsed.targetKind !== undefined || parsed.editToken !== undefined) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
    return { ...base, action: 'save-as', content: parsed.content }
  }
  if (parsed.action === 'save' && typeof parsed.content === 'string' && utf8Encoder.encode(parsed.content).byteLength <= SERVER_OPS_FILE_PREVIEW_LIMIT_BYTES) {
    if (parsed.destinationPath !== undefined || parsed.targetKind !== undefined) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
    const token = editToken(parsed.editToken)
    if (token.path !== base.path) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
    return { ...base, action: 'save', content: parsed.content, editToken: token }
  }
  throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
}

/** 解析 Main 签发的有限期文件动作候选。 */
export function parseServerOpsFileCandidate(value: unknown): ServerOpsFileCandidate {
  const parsed = record(value, ['candidateId', 'hostId', 'hostName', 'action', 'path', 'destinationPath', 'targetKind', 'expiresAt'])
  if (parsed.action !== 'mkdir' && parsed.action !== 'rename' && parsed.action !== 'delete' && parsed.action !== 'save-as' && parsed.action !== 'save') throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  if (typeof parsed.hostName !== 'string' || !parsed.hostName.trim() || parsed.hostName.length > 128 || /[\u0000-\u001f\u007f]/.test(parsed.hostName)) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  if (parsed.destinationPath !== undefined && parsed.action !== 'rename') throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  if (parsed.targetKind !== undefined && parsed.action !== 'delete') throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  if (parsed.action === 'rename' && parsed.destinationPath === undefined) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  if (parsed.action === 'delete' && parsed.targetKind !== 'file' && parsed.targetKind !== 'directory' && parsed.targetKind !== 'symlink') throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  /** 删除目标类型在前置条件中完成收窄，单独保存以避免对象展开丢失判别信息。 */
  const targetKind = parsed.targetKind === 'file' || parsed.targetKind === 'directory' || parsed.targetKind === 'symlink'
    ? parsed.targetKind
    : undefined
  return {
    candidateId: id(parsed.candidateId), hostId: id(parsed.hostId), hostName: parsed.hostName,
    action: parsed.action, path: path(parsed.path),
    ...(parsed.destinationPath === undefined ? {} : { destinationPath: path(parsed.destinationPath) }),
    ...(targetKind === undefined ? {} : { targetKind }),
    expiresAt: integer(parsed.expiresAt),
  }
}

/** 解析文件动作提交输入，动作正文只从 Main 候选读取。 */
export function parseServerOpsFileCommitInput(value: unknown): ServerOpsFileCommitInput {
  const parsed = record(value, ['hostId', 'candidateId', 'confirmationName'])
  if (typeof parsed.confirmationName !== 'string' || !parsed.confirmationName.trim() || parsed.confirmationName.length > 128 || /[\u0000-\u001f\u007f]/.test(parsed.confirmationName)) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  return { hostId: id(parsed.hostId), candidateId: id(parsed.candidateId), confirmationName: parsed.confirmationName }
}

/** 解析文件动作取消输入。 */
export function parseServerOpsFileCancelInput(value: unknown): ServerOpsFileCancelInput {
  const parsed = record(value, ['hostId', 'candidateId'])
  return { hostId: id(parsed.hostId), candidateId: id(parsed.candidateId) }
}

/** 解析页面 owner 清理请求，真实 owner 由 Main 根据窗口与页面生命周期解析。 */
export function parseServerOpsFileOwnerInput(value: unknown): ServerOpsFileOwnerInput {
  const parsed = record(value, ['hostId'])
  return { hostId: id(parsed.hostId) }
}

/** 解析文件动作完成结果，不暴露 connection、owner 或远程错误正文。 */
export function parseServerOpsFileMutationResult(value: unknown): ServerOpsFileMutationResult {
  const parsed = record(value, ['hostId', 'action', 'path', 'outcome', 'warning'])
  if ((parsed.action !== 'mkdir' && parsed.action !== 'rename' && parsed.action !== 'delete' && parsed.action !== 'save-as' && parsed.action !== 'save')
    || (parsed.outcome !== 'success' && parsed.outcome !== 'unknown')
    || (parsed.warning !== undefined && parsed.warning !== 'SERVER_OPS_AUDIT_WRITE_FAILED')) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  return { hostId: id(parsed.hostId), action: parsed.action, path: path(parsed.path), outcome: parsed.outcome,
    ...(parsed.warning === undefined ? {} : { warning: parsed.warning }) }
}

/** 解析单个二进制传输块，禁止超过 64 KiB。 */
export function parseServerOpsFileTransferChunk(value: unknown): ServerOpsFileTransferChunk {
  const parsed = record(value, ['handleId', 'position', 'data'])
  if (!(parsed.data instanceof Uint8Array) || parsed.data.byteLength > SERVER_OPS_FILE_CHUNK_LIMIT_BYTES) throw new Error('SERVER_OPS_FILES_INPUT_INVALID')
  return { handleId: id(parsed.handleId), position: integer(parsed.position), data: new Uint8Array(parsed.data) }
}
