import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Client, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'

export const SERVER_OPS_SFTP_PAGE_LIMIT = 200
export const SERVER_OPS_SFTP_TOTAL_ENTRY_LIMIT = 2_000
export const SERVER_OPS_SFTP_PAGE_BYTE_LIMIT = 262_144
export const SERVER_OPS_SFTP_SERVER_BATCH_ENTRY_LIMIT = 1_000
export const SERVER_OPS_SFTP_SERVER_BATCH_BYTE_LIMIT = 1_048_576
export const SERVER_OPS_SFTP_PREVIEW_LIMIT_BYTES = 1_048_576
export const SERVER_OPS_SFTP_CHUNK_LIMIT_BYTES = 65_536

export type ServerOpsSftpFileKind = 'file' | 'directory' | 'symlink' | 'other'
export interface ServerOpsSftpStat { size: number; mtime: number; mode: number; kind: ServerOpsSftpFileKind }
export interface ServerOpsSftpDirectoryEntry extends ServerOpsSftpStat { name: string; path: string }
export interface ServerOpsSftpAdapterDirectoryEntry extends ServerOpsSftpStat { name: string }
export interface ServerOpsSftpOperationIdentity { ownerKey: string; deadlineAt: number }
export interface ServerOpsSftpPathInput extends ServerOpsSftpOperationIdentity { path: string }
export interface ServerOpsSftpListInput extends ServerOpsSftpPathInput { cursorId?: string }
export interface ServerOpsSftpListResult {
  path: string
  entries: ServerOpsSftpDirectoryEntry[]
  cursorId?: string
  truncatedReason?: 'item-limit' | 'byte-limit' | 'server-batch-overflow'
}
export interface ServerOpsSftpEditFacts { path: string; size: number; mtime: number; mode: number; hash: string }
export type ServerOpsSftpPreviewResult =
  | { kind: 'text'; path: string; content: string; bytesRead: number; hash: string; stat: ServerOpsSftpStat; editFacts: ServerOpsSftpEditFacts }
  | { kind: 'binary'; path: string; bytesRead: number; hash: string; stat: ServerOpsSftpStat }
  | { kind: 'too-large'; path: string; bytesRead: 0; stat: ServerOpsSftpStat }
  | { kind: 'symlink'; path: string; bytesRead: 0; target: string; stat: ServerOpsSftpStat }
export interface ServerOpsSftpOpenReadResult { handleId: string; stat: ServerOpsSftpStat }
export interface ServerOpsSftpOpenWriteInput extends ServerOpsSftpPathInput { mode: 'no-clobber' | 'exclusive-temp' }
export interface ServerOpsSftpOpenWriteResult { handleId: string; temporaryPath?: string }
export interface ServerOpsSftpHandleInput extends ServerOpsSftpOperationIdentity { handleId: string }
export interface ServerOpsSftpReadInput extends ServerOpsSftpHandleInput { length: number }
export interface ServerOpsSftpReadResult { data: Uint8Array; position: number; eof: boolean }
export interface ServerOpsSftpWriteInput extends ServerOpsSftpHandleInput { data: Uint8Array; position: number }
export interface ServerOpsSftpTextWriteInput extends ServerOpsSftpPathInput { content: string }
export interface ServerOpsSftpControlledSaveInput extends ServerOpsSftpTextWriteInput { editFacts: ServerOpsSftpEditFacts }

/** 供 Main 区分安全失败与远端提交结果未知的稳定错误。 */
export class ServerOpsSftpRuntimeError extends Error {
  readonly code: string
  readonly outcome: 'not-committed' | 'unknown'
  constructor(code: string, outcome: 'not-committed' | 'unknown' = 'not-committed') {
    super(code)
    this.name = 'ServerOpsSftpRuntimeError'
    this.code = code
    this.outcome = outcome
  }
}

/** utility 与 Main 后续集成时使用的独立 SFTP 请求合同。 */
export type ServerOpsSftpRequest =
  | { type: 'list'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpListInput }
  | { type: 'preview'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpPathInput }
  | { type: 'stat'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpPathInput }
  | { type: 'open-read'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpPathInput }
  | { type: 'read'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpReadInput }
  | { type: 'open-write'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpOpenWriteInput }
  | { type: 'write'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpWriteInput }
  | { type: 'close' | 'cancel'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpHandleInput }
  | { type: 'mkdir' | 'unlink' | 'rmdir'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpPathInput }
  | { type: 'rename'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpOperationIdentity & { sourcePath: string; destinationPath: string } }
  | { type: 'save-as'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpTextWriteInput }
  | { type: 'save'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpControlledSaveInput }
  | { type: 'publish-temp'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpOperationIdentity & { temporaryPath: string; destinationPath: string } }
  | { type: 'close-owner'; requestId: string; hostId: string; connectionId: string; input: ServerOpsSftpOperationIdentity }

/** utility 对 Main 返回的独立 SFTP 结果合同。 */
export type ServerOpsSftpResult =
  | { type: 'list'; requestId: string; result: ServerOpsSftpListResult }
  | { type: 'preview'; requestId: string; result: ServerOpsSftpPreviewResult }
  | { type: 'stat'; requestId: string; result: ServerOpsSftpStat }
  | { type: 'open-read'; requestId: string; result: ServerOpsSftpOpenReadResult }
  | { type: 'read'; requestId: string; result: ServerOpsSftpReadResult }
  | { type: 'open-write'; requestId: string; result: ServerOpsSftpOpenWriteResult }
  | { type: 'save-as' | 'save'; requestId: string; result: ServerOpsSftpEditFacts }
  | { type: 'write' | 'close' | 'cancel' | 'mkdir' | 'rename' | 'unlink' | 'rmdir' | 'publish-temp' | 'close-owner'; requestId: string; result: { ok: true } }
  | { type: 'error'; requestId: string; code: string; outcome: 'not-committed' | 'unknown' }

/** 严格解析独立 runtime SFTP 请求，拒绝未知字段和超限数据。 */
export function parseServerOpsSftpRequest(value: unknown): ServerOpsSftpRequest {
  const parsed = protocolRecord(value, ['type', 'requestId', 'hostId', 'connectionId', 'input'])
  const base = { requestId: protocolId(parsed.requestId), hostId: protocolId(parsed.hostId), connectionId: protocolId(parsed.connectionId) }
  if (typeof parsed.type !== 'string') throw new Error('SERVER_OPS_SFTP_REQUEST_INVALID')
  if (parsed.type === 'list') return { type: 'list', ...base, input: parseListOperation(parsed.input) }
  if (parsed.type === 'preview' || parsed.type === 'stat' || parsed.type === 'open-read' || parsed.type === 'mkdir' || parsed.type === 'unlink' || parsed.type === 'rmdir') return { type: parsed.type, ...base, input: parsePathOperation(parsed.input) }
  if (parsed.type === 'open-write') {
    const input = protocolRecord(parsed.input, ['ownerKey', 'deadlineAt', 'path', 'mode'])
    if (input.mode !== 'no-clobber' && input.mode !== 'exclusive-temp') throw new Error('SERVER_OPS_SFTP_REQUEST_INVALID')
    return { type: 'open-write', ...base, input: { ...parseOperationIdentity(input), path: protocolPath(input.path), mode: input.mode } }
  }
  if (parsed.type === 'read') {
    const input = protocolRecord(parsed.input, ['ownerKey', 'deadlineAt', 'handleId', 'length'])
    const length = protocolInteger(input.length)
    validateChunkLength(length)
    return { type: 'read', ...base, input: { ...parseOperationIdentity(input), handleId: protocolId(input.handleId), length } }
  }
  if (parsed.type === 'write') {
    const input = protocolRecord(parsed.input, ['ownerKey', 'deadlineAt', 'handleId', 'position', 'data'])
    if (!(input.data instanceof Uint8Array) || input.data.byteLength < 1 || input.data.byteLength > SERVER_OPS_SFTP_CHUNK_LIMIT_BYTES) throw new Error('SERVER_OPS_SFTP_REQUEST_INVALID')
    return { type: 'write', ...base, input: { ...parseOperationIdentity(input), handleId: protocolId(input.handleId), position: protocolInteger(input.position), data: new Uint8Array(input.data) } }
  }
  if (parsed.type === 'close' || parsed.type === 'cancel') return { type: parsed.type, ...base, input: parseHandleOperation(parsed.input) }
  if (parsed.type === 'rename' || parsed.type === 'publish-temp') {
    const keys = parsed.type === 'rename' ? ['ownerKey', 'deadlineAt', 'sourcePath', 'destinationPath'] : ['ownerKey', 'deadlineAt', 'temporaryPath', 'destinationPath']
    const input = protocolRecord(parsed.input, keys)
    if (parsed.type === 'rename') return { type: 'rename', ...base, input: { ...parseOperationIdentity(input), sourcePath: protocolPath(input.sourcePath), destinationPath: protocolPath(input.destinationPath) } }
    return { type: 'publish-temp', ...base, input: { ...parseOperationIdentity(input), temporaryPath: protocolPath(input.temporaryPath), destinationPath: protocolPath(input.destinationPath) } }
  }
  if (parsed.type === 'save-as' || parsed.type === 'save') {
    const input = protocolRecord(parsed.input, parsed.type === 'save' ? ['ownerKey', 'deadlineAt', 'path', 'content', 'editFacts'] : ['ownerKey', 'deadlineAt', 'path', 'content'])
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > SERVER_OPS_SFTP_PREVIEW_LIMIT_BYTES) throw new Error('SERVER_OPS_SFTP_REQUEST_INVALID')
    const writeInput = { ...parseOperationIdentity(input), path: protocolPath(input.path), content: input.content }
    if (parsed.type === 'save-as') return { type: 'save-as', ...base, input: writeInput }
    return { type: 'save', ...base, input: { ...writeInput, editFacts: parseEditFacts(input.editFacts) } }
  }
  if (parsed.type === 'close-owner') {
    const input = protocolRecord(parsed.input, ['ownerKey', 'deadlineAt'])
    return { type: 'close-owner', ...base, input: parseOperationIdentity(input) }
  }
  throw new Error('SERVER_OPS_SFTP_REQUEST_INVALID')
}

/** 严格解析独立 runtime SFTP 返回，避免 utility 将内部字段带回 Main。 */
export function parseServerOpsSftpResult(value: unknown): ServerOpsSftpResult {
  const parsed = protocolRecord(value, ['type', 'requestId', 'result', 'code', 'outcome'])
  const requestId = protocolId(parsed.requestId)
  if (parsed.type === 'error') {
    if (typeof parsed.code !== 'string' || !/^[A-Z0-9_]{1,128}$/.test(parsed.code) || (parsed.outcome !== 'not-committed' && parsed.outcome !== 'unknown') || parsed.result !== undefined) throw new Error('SERVER_OPS_SFTP_RESULT_INVALID')
    return { type: 'error', requestId, code: parsed.code, outcome: parsed.outcome }
  }
  if (parsed.code !== undefined || parsed.outcome !== undefined) throw new Error('SERVER_OPS_SFTP_RESULT_INVALID')
  if (parsed.type === 'list') return { type: 'list', requestId, result: parseListResult(parsed.result) }
  if (parsed.type === 'preview') return { type: 'preview', requestId, result: parsePreviewResult(parsed.result) }
  if (parsed.type === 'stat') return { type: 'stat', requestId, result: parseRuntimeStat(parsed.result) }
  if (parsed.type === 'open-read') {
    const result = protocolRecord(parsed.result, ['handleId', 'stat'])
    return { type: 'open-read', requestId, result: { handleId: protocolId(result.handleId), stat: parseRuntimeStat(result.stat) } }
  }
  if (parsed.type === 'open-write') {
    const result = protocolRecord(parsed.result, ['handleId', 'temporaryPath'])
    return { type: 'open-write', requestId, result: { handleId: protocolId(result.handleId), ...(result.temporaryPath === undefined ? {} : { temporaryPath: protocolPath(result.temporaryPath) }) } }
  }
  if (parsed.type === 'read') {
    const result = protocolRecord(parsed.result, ['data', 'position', 'eof'])
    if (!(result.data instanceof Uint8Array) || result.data.byteLength > SERVER_OPS_SFTP_CHUNK_LIMIT_BYTES || typeof result.eof !== 'boolean') throw new Error('SERVER_OPS_SFTP_RESULT_INVALID')
    return { type: 'read', requestId, result: { data: new Uint8Array(result.data), position: protocolInteger(result.position), eof: result.eof } }
  }
  if (parsed.type === 'save-as' || parsed.type === 'save') return { type: parsed.type, requestId, result: parseEditFacts(parsed.result) }
  if (parsed.type === 'write' || parsed.type === 'close' || parsed.type === 'cancel' || parsed.type === 'mkdir' || parsed.type === 'rename' || parsed.type === 'unlink' || parsed.type === 'rmdir' || parsed.type === 'publish-temp' || parsed.type === 'close-owner') {
    const result = protocolRecord(parsed.result, ['ok'])
    if (result.ok !== true) throw new Error('SERVER_OPS_SFTP_RESULT_INVALID')
    return { type: parsed.type, requestId, result: { ok: true } }
  }
  throw new Error('SERVER_OPS_SFTP_RESULT_INVALID')
}

/** 与 ssh2 回调 API 解耦的最小适配面，便于资源边界测试。 */
export interface ServerOpsSftpAdapter {
  openDirectory(path: string): Promise<string>
  readDirectory(handle: string): Promise<ServerOpsSftpAdapterDirectoryEntry[]>
  lstat(path: string): Promise<ServerOpsSftpStat>
  fstat(handle: string): Promise<ServerOpsSftpStat>
  readlink(path: string): Promise<string>
  openFile(path: string, flags: 'r' | 'wx'): Promise<string>
  read(handle: string, position: number, length: number): Promise<Buffer>
  write(handle: string, position: number, data: Buffer): Promise<void>
  close(handle: string): Promise<void>
  mkdir(path: string): Promise<void>
  rename(sourcePath: string, destinationPath: string): Promise<void>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  fsync(handle: string): Promise<void>
  hardlink(sourcePath: string, destinationPath: string): Promise<void>
  posixRename?(sourcePath: string, destinationPath: string): Promise<void>
  supportsExtension?(name: 'fsync@openssh.com' | 'hardlink@openssh.com' | 'posix-rename@openssh.com'): boolean
  dispose?(): void
}

interface ServerOpsSftpRuntimeOptions {
  hostId: string
  connectionId: string
  client?: Pick<Client, 'sftp'>
  adapter?: ServerOpsSftpAdapter
  createId?: () => string
  now?: () => number
}

interface DirectoryCursor {
  cursorId: string
  ownerKey: string
  path: string
  adapterHandle: string
  pending: ServerOpsSftpDirectoryEntry[]
  delivered: number
  exhausted: boolean
  batchOverflow: boolean
  busy: boolean
}

interface FileHandle {
  handleId: string
  ownerKey: string
  adapterHandle: string
  path: string
  kind: 'read' | 'write'
  position: number
  busy: boolean
  temporary: boolean
  /** 临时文件创建后从已打开 handle 读取的稳定身份。 */
  temporaryIdentity?: ServerOpsSftpStat
}

interface TemporaryFileRecord {
  ownerKey: string
  identity: ServerOpsSftpStat
}

/** 在单个已验证 SSH 连接上管理 SFTP cursor 与文件 handle。 */
export class ServerOpsSftpRuntime {
  readonly hostId: string
  readonly connectionId: string
  private readonly adapter: ServerOpsSftpAdapter
  private readonly createId: () => string
  private readonly now: () => number
  private readonly cursors = new Map<string, DirectoryCursor>()
  private readonly handles = new Map<string, FileHandle>()
  private readonly ownerVersions = new Map<string, number>()
  private readonly temporaryFiles = new Map<string, TemporaryFileRecord>()
  /** owner 关闭时等待正在打开但尚未登记的远端资源落定。 */
  private readonly pendingOwnerAcquisitions = new Map<string, Set<Promise<void>>>()
  /** 重复 close-owner 复用同一清理屏障。 */
  private readonly closingOwners = new Map<string, Promise<void>>()
  private disposed = false

  constructor(options: ServerOpsSftpRuntimeOptions) {
    if ((!options.client && !options.adapter) || (options.client && options.adapter)) throw new Error('SERVER_OPS_SFTP_SOURCE_INVALID')
    this.hostId = options.hostId
    this.connectionId = options.connectionId
    this.adapter = options.adapter ?? new Ssh2SftpAdapter(options.client!)
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
  }

  /** 将已严格解析的独立 runtime 请求分派到当前绑定连接。 */
  async dispatch(request: ServerOpsSftpRequest): Promise<ServerOpsSftpResult> {
    if (request.hostId !== this.hostId || request.connectionId !== this.connectionId) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_CONNECTION_MISMATCH')
    try {
    if (request.type === 'list') return { type: 'list', requestId: request.requestId, result: await this.listDirectory(request.input) }
    if (request.type === 'preview') return { type: 'preview', requestId: request.requestId, result: await this.preview(request.input) }
    if (request.type === 'stat') return { type: 'stat', requestId: request.requestId, result: await this.stat(request.input) }
    if (request.type === 'open-read') return { type: 'open-read', requestId: request.requestId, result: await this.openRead(request.input) }
    if (request.type === 'read') return { type: 'read', requestId: request.requestId, result: await this.readChunk(request.input) }
    if (request.type === 'open-write') return { type: 'open-write', requestId: request.requestId, result: await this.openWrite(request.input) }
    if (request.type === 'write') { await this.writeChunk(request.input); return { type: 'write', requestId: request.requestId, result: { ok: true } } }
    if (request.type === 'close') { await this.close(request.input); return { type: 'close', requestId: request.requestId, result: { ok: true } } }
    if (request.type === 'cancel') { await this.cancel(request.input); return { type: 'cancel', requestId: request.requestId, result: { ok: true } } }
    if (request.type === 'mkdir') { await this.mkdir(request.input); return { type: 'mkdir', requestId: request.requestId, result: { ok: true } } }
    if (request.type === 'rename') { await this.rename(request.input); return { type: 'rename', requestId: request.requestId, result: { ok: true } } }
    if (request.type === 'unlink') { await this.unlink(request.input); return { type: 'unlink', requestId: request.requestId, result: { ok: true } } }
    if (request.type === 'rmdir') { await this.rmdir(request.input); return { type: 'rmdir', requestId: request.requestId, result: { ok: true } } }
    if (request.type === 'save-as') return { type: 'save-as', requestId: request.requestId, result: await this.saveTextAs(request.input) }
    if (request.type === 'save') return { type: 'save', requestId: request.requestId, result: await this.saveText(request.input) }
    if (request.type === 'publish-temp') { await this.publishTemporaryNoClobber(request.input); return { type: 'publish-temp', requestId: request.requestId, result: { ok: true } } }
    await this.closeOwner(request.input.ownerKey)
    return { type: 'close-owner', requestId: request.requestId, result: { ok: true } }
    } catch (error) {
      throw classifyServerOpsSftpError(error, isMutationRequest(request.type))
    }
  }

  /** 返回 lstat 事实，符号链接不会被跟随。 */
  async stat(input: ServerOpsSftpPathInput): Promise<ServerOpsSftpStat> { const version = this.begin(input); return await this.awaitChecked(input, version, this.adapter.lstat(normalizeRemotePath(input.path))) }

  /** 从真实 `readdir(handle)` 流中取一页，游标只允许创建它的 owner 使用。 */
  async listDirectory(input: ServerOpsSftpListInput): Promise<ServerOpsSftpListResult> {
    const version = this.begin(input)
    const normalizedPath = normalizeRemotePath(input.path)
    let cursor = input.cursorId ? this.requireCursor(input.cursorId, input.ownerKey, normalizedPath) : undefined
    if (!cursor) {
      cursor = await this.withOwnerAcquisition(input.ownerKey, async () => {
        const adapterHandle = await this.openResource(input, version, () => this.adapter.openDirectory(normalizedPath))
        const opened = { cursorId: this.createId(), ownerKey: input.ownerKey, path: normalizedPath, adapterHandle, pending: [], delivered: 0, exhausted: false, batchOverflow: false, busy: false }
        this.cursors.set(opened.cursorId, opened)
        return opened
      })
    }
    if (cursor.busy) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_CURSOR_BUSY')
    cursor.busy = true
    try {
      while (cursor.pending.length < SERVER_OPS_SFTP_PAGE_LIMIT && !cursor.exhausted && !cursor.batchOverflow) {
        const rawBatch = await this.awaitChecked(input, version, this.adapter.readDirectory(cursor.adapterHandle))
        const validBatch = rawBatch.filter(isSafeDirectoryEntry)
        const batch = validBatch.map((entry) => ({ ...entry, path: posix.join(normalizedPath, entry.name) }))
        const batchBytes = estimateEntriesBytes(batch)
        if (validBatch.length !== rawBatch.length || batch.length > SERVER_OPS_SFTP_SERVER_BATCH_ENTRY_LIMIT || batchBytes > SERVER_OPS_SFTP_SERVER_BATCH_BYTE_LIMIT) {
          cursor.batchOverflow = true
          cursor.pending.push(...takeBoundedEntries(batch, SERVER_OPS_SFTP_PAGE_LIMIT, SERVER_OPS_SFTP_PAGE_BYTE_LIMIT))
          break
        }
        if (batch.length === 0) { cursor.exhausted = true; break }
        cursor.pending.push(...batch)
      }
      const remainingTotal = Math.max(0, SERVER_OPS_SFTP_TOTAL_ENTRY_LIMIT - cursor.delivered)
      const entries = takeBoundedEntries(cursor.pending, Math.min(SERVER_OPS_SFTP_PAGE_LIMIT, remainingTotal), SERVER_OPS_SFTP_PAGE_BYTE_LIMIT)
      cursor.pending.splice(0, entries.length)
      cursor.delivered += entries.length
      let truncatedReason: ServerOpsSftpListResult['truncatedReason']
      if (cursor.batchOverflow) truncatedReason = 'server-batch-overflow'
      else if (cursor.delivered >= SERVER_OPS_SFTP_TOTAL_ENTRY_LIMIT && (cursor.pending.length > 0 || !cursor.exhausted)) truncatedReason = 'item-limit'
      else if (entries.length < SERVER_OPS_SFTP_PAGE_LIMIT && cursor.pending.length > 0) truncatedReason = 'byte-limit'
      const shouldClose = Boolean(truncatedReason && truncatedReason !== 'byte-limit') || (cursor.exhausted && cursor.pending.length === 0)
      if (shouldClose) await this.closeCursor(cursor)
      return {
        path: normalizedPath, entries,
        ...(!shouldClose ? { cursorId: cursor.cursorId } : {}),
        ...(truncatedReason ? { truncatedReason } : {}),
      }
    } finally {
      cursor.busy = false
    }
  }

  /** 读取至多 1 MiB 的普通文件，返回文本/二进制/超限/符号链接明确分类。 */
  async preview(input: ServerOpsSftpPathInput): Promise<ServerOpsSftpPreviewResult> {
    const version = this.begin(input)
    const path = normalizeRemotePath(input.path)
    const before = await this.awaitChecked(input, version, this.adapter.lstat(path))
    if (before.kind === 'symlink') {
      const target = await this.awaitChecked(input, version, this.adapter.readlink(path))
      return { kind: 'symlink', path, bytesRead: 0, target, stat: before }
    }
    if (before.kind !== 'file') throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_NOT_FILE')
    if (before.size > SERVER_OPS_SFTP_PREVIEW_LIMIT_BYTES) return { kind: 'too-large', path, bytesRead: 0, stat: before }
    const adapterHandle = await this.openResource(input, version, () => this.adapter.openFile(path, 'r'))
    try {
      const chunks: Buffer[] = []
      let position = 0
      while (position <= SERVER_OPS_SFTP_PREVIEW_LIMIT_BYTES) {
        const length = Math.min(SERVER_OPS_SFTP_CHUNK_LIMIT_BYTES, SERVER_OPS_SFTP_PREVIEW_LIMIT_BYTES + 1 - position)
        const chunk = await this.awaitChecked(input, version, this.adapter.read(adapterHandle, position, length))
        if (chunk.length === 0) break
        chunks.push(chunk)
        position += chunk.length
        if (chunk.length < length) break
      }
      const after = await this.awaitChecked(input, version, this.adapter.fstat(adapterHandle))
      /** SFTP v3 没有通用 O_NOFOLLOW，返回正文前重新 lstat 路径以拒绝打开后的符号链接替换。 */
      const pathAfter = await this.awaitChecked(input, version, this.adapter.lstat(path))
      if (!sameStat(before, after) || !sameStat(before, pathAfter)) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_FILE_CHANGED')
      if (position > SERVER_OPS_SFTP_PREVIEW_LIMIT_BYTES) return { kind: 'too-large', path, bytesRead: 0, stat: after }
      const data = Buffer.concat(chunks, position)
      const hash = `sha256:${createHash('sha256').update(data).digest('hex')}`
      let content: string
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { return { kind: 'binary', path, bytesRead: data.length, hash, stat: after } }
      if (content.includes('\0')) return { kind: 'binary', path, bytesRead: data.length, hash, stat: after }
      const editFacts = { path, size: after.size, mtime: after.mtime, mode: after.mode, hash }
      return { kind: 'text', path, content, bytesRead: data.length, hash, stat: after, editFacts }
    } finally {
      await ignoreCloseError(this.adapter.close(adapterHandle))
    }
  }

  /** 打开普通文件用于顺序分块读取。 */
  async openRead(input: ServerOpsSftpPathInput): Promise<ServerOpsSftpOpenReadResult> {
    const version = this.begin(input)
    const path = normalizeRemotePath(input.path)
    const stat = await this.awaitChecked(input, version, this.adapter.lstat(path))
    if (stat.kind === 'symlink') throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_SYMLINK_REFUSED')
    if (stat.kind !== 'file') throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_NOT_FILE')
    return await this.withOwnerAcquisition(input.ownerKey, async () => {
      const adapterHandle = await this.openResource(input, version, () => this.adapter.openFile(path, 'r'))
      const handleId = this.createId()
      this.handles.set(handleId, { handleId, ownerKey: input.ownerKey, adapterHandle, path, kind: 'read', position: 0, busy: false, temporary: false })
      return { handleId, stat }
    })
  }

  /** 打开独占目标或 owner 独占临时文件用于分块写入。 */
  async openWrite(input: ServerOpsSftpOpenWriteInput): Promise<ServerOpsSftpOpenWriteResult> {
    const version = this.begin(input)
    const destinationPath = normalizeRemotePath(input.path)
    const path = normalizeRemotePath(input.mode === 'exclusive-temp' ? `${destinationPath}.proma-${this.createId()}.tmp` : destinationPath)
    return await this.withOwnerAcquisition(input.ownerKey, async () => {
      const adapterHandle = await this.openResource(input, version, () => this.adapter.openFile(path, 'wx'))
      let temporaryIdentity: ServerOpsSftpStat | undefined
      try {
        if (input.mode === 'exclusive-temp') {
          temporaryIdentity = await withDeadline(this.adapter.fstat(adapterHandle), input.deadlineAt, this.now)
          this.temporaryFiles.set(path, { ownerKey: input.ownerKey, identity: temporaryIdentity })
        }
        this.check(input, version)
      } catch (error) {
        await ignoreCloseError(this.adapter.close(adapterHandle))
        if (temporaryIdentity) await this.cleanupTemporaryFile(path, input.ownerKey, temporaryIdentity)
        throw error
      }
      const handleId = this.createId()
      this.handles.set(handleId, { handleId, ownerKey: input.ownerKey, adapterHandle, path, kind: 'write', position: 0, busy: false, temporary: input.mode === 'exclusive-temp', ...(temporaryIdentity ? { temporaryIdentity } : {}) })
      return { handleId, ...(input.mode === 'exclusive-temp' ? { temporaryPath: path } : {}) }
    })
  }

  /** 从读取 handle 获取一个不超过 64 KiB 的块。 */
  async readChunk(input: ServerOpsSftpReadInput): Promise<ServerOpsSftpReadResult> {
    validateChunkLength(input.length)
    const version = this.begin(input)
    const handle = this.requireHandle(input.handleId, input.ownerKey, 'read')
    return await this.withHandle(handle, async () => {
      const position = handle.position
      const data = await this.awaitChecked(input, version, this.adapter.read(handle.adapterHandle, position, input.length))
      handle.position += data.length
      return { data: new Uint8Array(data), position, eof: data.length < input.length }
    })
  }

  /** 向写入 handle 的精确位置提交一个不超过 64 KiB 的块。 */
  async writeChunk(input: ServerOpsSftpWriteInput): Promise<void> {
    if (!(input.data instanceof Uint8Array) || input.data.byteLength < 1 || input.data.byteLength > SERVER_OPS_SFTP_CHUNK_LIMIT_BYTES || input.position < 0 || !Number.isSafeInteger(input.position)) {
      throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_CHUNK_INVALID')
    }
    const version = this.begin(input)
    const handle = this.requireHandle(input.handleId, input.ownerKey, 'write')
    await this.withHandle(handle, async () => {
      if (input.position !== handle.position) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_POSITION_MISMATCH')
      await this.awaitMutation(input, version, this.adapter.write(handle.adapterHandle, input.position, Buffer.from(input.data)))
      handle.position += input.data.byteLength
    })
  }

  /** 正常关闭 handle；写 handle 在真实扩展可用时同步远端数据。 */
  async close(input: ServerOpsSftpHandleInput): Promise<void> {
    const version = this.begin(input)
    const handle = this.requireHandle(input.handleId, input.ownerKey)
    if (handle.busy) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_HANDLE_BUSY')
    this.handles.delete(handle.handleId)
    let syncError: unknown
    let temporaryIdentity = handle.temporaryIdentity
    try {
      if (handle.kind === 'write' && this.adapter.supportsExtension?.('fsync@openssh.com')) {
        await this.awaitMutation(input, version, this.adapter.fsync(handle.adapterHandle))
      }
      if (handle.temporary) temporaryIdentity = await this.awaitChecked(input, version, this.adapter.fstat(handle.adapterHandle))
    } catch (error) { syncError = error }
    try { await this.awaitChecked(input, version, this.adapter.close(handle.adapterHandle)) } catch (error) { if (!syncError) syncError = error }
    if (!syncError && handle.temporary && temporaryIdentity) {
      this.temporaryFiles.set(handle.path, { ownerKey: handle.ownerKey, identity: temporaryIdentity })
    }
    if (syncError) throw syncError
  }

  /** 取消只释放本操作拥有的远程 handle，不删除无法证明归属的路径。 */
  async cancel(input: ServerOpsSftpHandleInput): Promise<void> {
    this.begin(input)
    const handle = this.requireHandle(input.handleId, input.ownerKey)
    this.handles.delete(handle.handleId)
    await ignoreCloseError(this.adapter.close(handle.adapterHandle))
  }

  /** 使用服务端真实声明并成功执行的 hardlink 扩展完成原子 no-clobber 发布。 */
  async publishTemporaryNoClobber(input: ServerOpsSftpOperationIdentity & { temporaryPath: string; destinationPath: string }): Promise<void> {
    const version = this.begin(input)
    if (!this.adapter.supportsExtension?.('hardlink@openssh.com')) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_NO_CLOBBER_UNSUPPORTED')
    const temporaryPath = normalizeRemotePath(input.temporaryPath)
    const destinationPath = normalizeRemotePath(input.destinationPath)
    const temporary = this.temporaryFiles.get(temporaryPath)
    if (!temporary || temporary.ownerKey !== input.ownerKey) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_TEMPORARY_OWNER_MISMATCH')
    const current = await this.awaitChecked(input, version, this.adapter.lstat(temporaryPath))
    if (!sameStat(current, temporary.identity)) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_TEMPORARY_IDENTITY_MISMATCH')
    await this.awaitMutation(input, version, this.adapter.hardlink(temporaryPath, destinationPath))
    await this.awaitMutation(input, version, this.adapter.unlink(temporaryPath))
    this.temporaryFiles.delete(temporaryPath)
  }

  /** 以 `wx` 创建新文本文件，目标已存在时绝不覆盖。 */
  async saveTextAs(input: ServerOpsSftpTextWriteInput): Promise<ServerOpsSftpEditFacts> {
    const version = this.begin(input)
    const path = normalizeRemotePath(input.path)
    const data = encodeText(input.content)
    const handle = await this.openResource(input, version, () => this.adapter.openFile(path, 'wx'))
    try { await this.writeCompleteText(input, version, handle, data, this.adapter.supportsExtension?.('fsync@openssh.com') === true) } catch (error) {
      if (error instanceof ServerOpsSftpRuntimeError && error.outcome === 'unknown') throw error
      throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_SAVE_AS_RESULT_UNKNOWN', 'unknown')
    }
    const stat = await this.awaitChecked(input, version, this.adapter.lstat(path))
    return { path, size: stat.size, mtime: stat.mtime, mode: stat.mode, hash: hashBuffer(data) }
  }

  /** 双重回查编辑事实后通过真实 fsync + posix-rename 扩展替换文本。 */
  async saveText(input: ServerOpsSftpControlledSaveInput): Promise<ServerOpsSftpEditFacts> {
    const version = this.begin(input)
    const path = normalizeRemotePath(input.path)
    if (input.editFacts.path !== path) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_EDIT_CONFLICT')
    await this.assertEditFacts(input, input.editFacts)
    if (!this.adapter.supportsExtension?.('fsync@openssh.com') || !this.adapter.supportsExtension?.('posix-rename@openssh.com') || !this.adapter.posixRename) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_ATOMIC_SAVE_UNSUPPORTED')
    const data = encodeText(input.content)
    const temporaryPath = normalizeRemotePath(`${path}.proma-${this.createId()}.tmp`)
    const handle = await this.openResource(input, version, () => this.adapter.openFile(temporaryPath, 'wx'))
    let readyToPublish = false
    try {
      await this.writeCompleteText(input, version, handle, data, true)
      readyToPublish = true
      await this.assertEditFacts(input, input.editFacts)
      await this.awaitMutation(input, version, this.adapter.posixRename(temporaryPath, path))
    } catch (error) {
      if (!readyToPublish || !(error instanceof ServerOpsSftpRuntimeError && error.outcome === 'unknown')) await ignoreCloseError(this.adapter.unlink(temporaryPath))
      throw error
    }
    const stat = await this.awaitChecked(input, version, this.adapter.lstat(path))
    return { path, size: stat.size, mtime: stat.mtime, mode: stat.mode, hash: hashBuffer(data) }
  }

  /** 新建目录；权限与已存在错误原样映射给上层。 */
  async mkdir(input: ServerOpsSftpPathInput): Promise<void> { const version = this.begin(input); await this.awaitMutation(input, version, this.adapter.mkdir(normalizeRemotePath(input.path))) }
  /** 普通 rename 不承诺 no-clobber，仅供已审批的明确移动动作。 */
  async rename(input: ServerOpsSftpOperationIdentity & { sourcePath: string; destinationPath: string }): Promise<void> { const version = this.begin(input); await this.awaitMutation(input, version, this.adapter.rename(normalizeRemotePath(input.sourcePath), normalizeRemotePath(input.destinationPath))) }
  /** 删除单文件或符号链接。 */
  async unlink(input: ServerOpsSftpPathInput): Promise<void> { const version = this.begin(input); await this.awaitMutation(input, version, this.adapter.unlink(normalizeRemotePath(input.path))) }
  /** 删除空目录，非空由服务端拒绝。 */
  async rmdir(input: ServerOpsSftpPathInput): Promise<void> { const version = this.begin(input); await this.awaitMutation(input, version, this.adapter.rmdir(normalizeRemotePath(input.path))) }

  /** 关闭指定 owner 的所有 cursor/handle，并使在途回调返回后立即释放资源。 */
  async closeOwner(ownerKey: string): Promise<void> {
    const existing = this.closingOwners.get(ownerKey)
    if (existing) return await existing
    this.ownerVersions.set(ownerKey, (this.ownerVersions.get(ownerKey) ?? 0) + 1)
    const closing = (async () => {
      const acquisitions = [...(this.pendingOwnerAcquisitions.get(ownerKey) ?? [])]
      await Promise.allSettled(acquisitions)
      const closes: Promise<void>[] = []
      for (const cursor of [...this.cursors.values()]) if (cursor.ownerKey === ownerKey) {
        this.cursors.delete(cursor.cursorId)
        closes.push(this.adapter.close(cursor.adapterHandle))
      }
      for (const handle of [...this.handles.values()]) if (handle.ownerKey === ownerKey) {
        this.handles.delete(handle.handleId)
        closes.push((async () => {
          if (handle.temporary) {
            try {
              const identity = await this.adapter.fstat(handle.adapterHandle)
              this.temporaryFiles.set(handle.path, { ownerKey: handle.ownerKey, identity })
            } catch { /* 无法更新身份时保留创建身份，后续路径复核会 fail closed。 */ }
          }
          await this.adapter.close(handle.adapterHandle)
        })())
      }
      const closeResults = await Promise.allSettled(closes)
      const closeFailed = closeResults.some((result) => result.status === 'rejected')
      const cleanupFailures: unknown[] = []
      for (const [path, temporary] of [...this.temporaryFiles]) {
        if (temporary.ownerKey !== ownerKey) continue
        try { await this.cleanupTemporaryFile(path, ownerKey, temporary.identity) } catch (error) { cleanupFailures.push(error) }
      }
      if (closeFailed) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_OWNER_CLEANUP_FAILED')
      if (cleanupFailures.length > 0) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_TEMPORARY_CLEANUP_FAILED')
    })()
    this.closingOwners.set(ownerKey, closing)
    try { await closing } finally { if (this.closingOwners.get(ownerKey) === closing) this.closingOwners.delete(ownerKey) }
  }

  /** 断线或 runtime 退出时释放本连接创建的全部 SFTP 资源。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const cursor of [...this.cursors.values()]) void this.closeCursor(cursor)
    for (const handle of [...this.handles.values()]) { this.handles.delete(handle.handleId); void ignoreCloseError(this.adapter.close(handle.adapterHandle)) }
    this.adapter.dispose?.()
  }

  /** 在操作开始时验证 deadline 并捕获 owner 代次。 */
  private begin(input: ServerOpsSftpOperationIdentity): number {
    if (this.disposed) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_DISPOSED')
    if (!input.ownerKey || input.ownerKey.length > 256) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_OWNER_INVALID')
    if (this.closingOwners.has(input.ownerKey)) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_OWNER_CLOSED')
    if (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= this.now()) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_DEADLINE_EXCEEDED')
    return this.ownerVersions.get(input.ownerKey) ?? 0
  }

  /** 每个异步边界后重新验证 owner、runtime 和 deadline。 */
  private check(input: ServerOpsSftpOperationIdentity, version: number): void {
    if (this.disposed) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_DISPOSED')
    if ((this.ownerVersions.get(input.ownerKey) ?? 0) !== version) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_OWNER_CLOSED')
    if (input.deadlineAt <= this.now()) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_DEADLINE_EXCEEDED')
  }

  /** 等待普通适配器调用并在返回后执行所有权检查。 */
  private async awaitChecked<T>(input: ServerOpsSftpOperationIdentity, version: number, promise: Promise<T>): Promise<T> {
    const value = await withDeadline(promise, input.deadlineAt, this.now)
    this.check(input, version)
    return value
  }

  /** 写请求发出后的 deadline/断线只能标记结果未知，禁止上层自动重放。 */
  private async awaitMutation(input: ServerOpsSftpOperationIdentity, version: number, promise: Promise<void>): Promise<void> {
    try { await this.awaitChecked(input, version, promise) } catch (error) {
      if (error instanceof ServerOpsSftpRuntimeError && (error.code === 'SERVER_OPS_SFTP_DEADLINE_EXCEEDED' || error.code === 'SERVER_OPS_SFTP_OWNER_CLOSED' || error.code === 'SERVER_OPS_SFTP_DISPOSED')) {
        throw new ServerOpsSftpRuntimeError(error.code, 'unknown')
      }
      throw error
    }
  }

  /** 打开远端资源；owner 关闭或 dispose 后到达的 handle 会被立即关闭。 */
  private async openResource(input: ServerOpsSftpOperationIdentity, version: number, open: () => Promise<string>): Promise<string> {
    const opened = open()
    let adapterHandle: string
    try { adapterHandle = await withDeadline(opened, input.deadlineAt, this.now) } catch (error) {
      void opened.then((lateHandle) => ignoreCloseError(this.adapter.close(lateHandle)), () => undefined)
      throw error
    }
    try { this.check(input, version); return adapterHandle } catch (error) { await ignoreCloseError(this.adapter.close(adapterHandle)); throw error }
  }

  /** 将打开与资源登记纳入 owner 关闭屏障，避免 ACK 早于迟到 handle 收口。 */
  private async withOwnerAcquisition<T>(ownerKey: string, action: () => Promise<T>): Promise<T> {
    let finish!: () => void
    const settled = new Promise<void>((resolve) => { finish = resolve })
    const pending = this.pendingOwnerAcquisitions.get(ownerKey) ?? new Set<Promise<void>>()
    pending.add(settled)
    this.pendingOwnerAcquisitions.set(ownerKey, pending)
    try { return await action() } finally {
      finish()
      pending.delete(settled)
      if (pending.size === 0) this.pendingOwnerAcquisitions.delete(ownerKey)
    }
  }

  /** 只有路径仍指向 owner 创建时的稳定身份才删除远端临时文件。 */
  private async cleanupTemporaryFile(path: string, ownerKey: string, identity: ServerOpsSftpStat): Promise<void> {
    const tracked = this.temporaryFiles.get(path)
    if (!tracked || tracked.ownerKey !== ownerKey || !sameStat(tracked.identity, identity)) {
      throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_TEMPORARY_CLEANUP_FAILED')
    }
    let current: ServerOpsSftpStat
    try { current = await this.adapter.lstat(path) } catch {
      throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_TEMPORARY_CLEANUP_FAILED')
    }
    if (!sameStat(current, identity)) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_TEMPORARY_CLEANUP_FAILED')
    try { await this.adapter.unlink(path) } catch { throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_TEMPORARY_CLEANUP_FAILED') }
    this.temporaryFiles.delete(path)
  }

  /** 校验 cursor 的 owner、路径和空闲状态。 */
  private requireCursor(cursorId: string, ownerKey: string, path: string): DirectoryCursor {
    const cursor = this.cursors.get(cursorId)
    if (!cursor) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_CURSOR_NOT_FOUND')
    if (cursor.ownerKey !== ownerKey) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_OWNER_MISMATCH')
    if (cursor.path !== path) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_CURSOR_PATH_MISMATCH')
    return cursor
  }

  /** 校验文件 handle 的 owner 和用途。 */
  private requireHandle(handleId: string, ownerKey: string, kind?: FileHandle['kind']): FileHandle {
    const handle = this.handles.get(handleId)
    if (!handle) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_HANDLE_NOT_FOUND')
    if (handle.ownerKey !== ownerKey) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_OWNER_MISMATCH')
    if (kind && handle.kind !== kind) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_HANDLE_KIND_MISMATCH')
    return handle
  }

  /** 串行化同一 handle 的读写，避免 position 竞争。 */
  private async withHandle<T>(handle: FileHandle, action: () => Promise<T>): Promise<T> {
    if (handle.busy) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_HANDLE_BUSY')
    handle.busy = true
    try {
      const result = await action()
      if (this.handles.get(handle.handleId) !== handle) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_HANDLE_CLOSED')
      return result
    } finally { handle.busy = false }
  }

  /** 幂等关闭目录 cursor。 */
  private async closeCursor(cursor: DirectoryCursor): Promise<void> {
    if (this.cursors.get(cursor.cursorId) !== cursor) return
    this.cursors.delete(cursor.cursorId)
    await ignoreCloseError(this.adapter.close(cursor.adapterHandle))
  }

  /** 将文本按 64 KiB 顺序写完并始终关闭底层 handle。 */
  private async writeCompleteText(input: ServerOpsSftpOperationIdentity, version: number, handle: string, data: Buffer, fsync = false): Promise<void> {
    let position = 0
    let primaryError: unknown
    try {
      while (position < data.length) {
        const chunk = data.subarray(position, Math.min(position + SERVER_OPS_SFTP_CHUNK_LIMIT_BYTES, data.length))
        await this.awaitMutation(input, version, this.adapter.write(handle, position, chunk))
        position += chunk.length
      }
      if (fsync) await this.awaitMutation(input, version, this.adapter.fsync(handle))
    } catch (error) { primaryError = error }
    try { await this.awaitChecked(input, version, this.adapter.close(handle)) } catch (error) { if (!primaryError) primaryError = error }
    if (primaryError) throw primaryError
  }

  /** 重新读取文件并核对完整内容 hash 与 stat 编辑事实。 */
  private async assertEditFacts(input: ServerOpsSftpOperationIdentity, expected: ServerOpsSftpEditFacts): Promise<void> {
    const preview = await this.preview({ ownerKey: input.ownerKey, deadlineAt: input.deadlineAt, path: expected.path })
    if (preview.kind !== 'text' || preview.hash !== expected.hash || preview.stat.size !== expected.size || preview.stat.mtime !== expected.mtime || preview.stat.mode !== expected.mode) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_EDIT_CONFLICT')
  }
}

/** 将真实 ssh2 Client 的单个 SFTP channel 适配为 Promise API。 */
class Ssh2SftpAdapter implements ServerOpsSftpAdapter {
  private readonly client: Pick<Client, 'sftp'>
  private sftpPromise?: Promise<SFTPWrapper>
  private readonly handles = new Map<string, Buffer>()
  private handleSequence = 0
  private resolvedSftp?: SFTPWrapper

  constructor(client: Pick<Client, 'sftp'>) { this.client = client }

  async openDirectory(path: string): Promise<string> { return await this.openHandle((sftp, callback) => sftp.opendir(path, callback)) }
  async readDirectory(handle: string): Promise<ServerOpsSftpAdapterDirectoryEntry[]> {
    const sftp = await this.sftp()
    const rawHandle = this.rawHandle(handle)
    let entries: FileEntryWithStats[]
    try { entries = await callbackResult<FileEntryWithStats[]>((callback) => sftp.readdir(rawHandle, callback)) } catch (error) {
      if (isSftpEof(error)) return []
      throw error
    }
    return entries.map((entry) => ({ name: entry.filename, ...toStat(entry.attrs) }))
  }
  async lstat(path: string): Promise<ServerOpsSftpStat> { const sftp = await this.sftp(); return toStat(await callbackResult<Stats>((callback) => sftp.lstat(path, callback))) }
  async fstat(handle: string): Promise<ServerOpsSftpStat> { const sftp = await this.sftp(); return toStat(await callbackResult<Stats>((callback) => sftp.fstat(this.rawHandle(handle), callback))) }
  async readlink(path: string): Promise<string> { const sftp = await this.sftp(); return await callbackResult<string>((callback) => sftp.readlink(path, callback)) }
  async openFile(path: string, flags: 'r' | 'wx'): Promise<string> { return await this.openHandle((sftp, callback) => sftp.open(path, flags, callback)) }
  async read(handle: string, position: number, length: number): Promise<Buffer> {
    const sftp = await this.sftp()
    const buffer = Buffer.allocUnsafe(length)
    return await new Promise<Buffer>((resolve, reject) => sftp.read(this.rawHandle(handle), buffer, 0, length, position, (error, bytesRead) => error ? reject(error) : resolve(Buffer.from(buffer.subarray(0, bytesRead)))))
  }
  async write(handle: string, position: number, data: Buffer): Promise<void> { const sftp = await this.sftp(); await callbackVoid((callback) => sftp.write(this.rawHandle(handle), data, 0, data.length, position, callback)) }
  async close(handle: string): Promise<void> { const rawHandle = this.handles.get(handle); if (!rawHandle) return; this.handles.delete(handle); const sftp = await this.sftp(); await callbackVoid((callback) => sftp.close(rawHandle, callback)) }
  async mkdir(path: string): Promise<void> { const sftp = await this.sftp(); await callbackVoid((callback) => sftp.mkdir(path, callback)) }
  async rename(sourcePath: string, destinationPath: string): Promise<void> { const sftp = await this.sftp(); await callbackVoid((callback) => sftp.rename(sourcePath, destinationPath, callback)) }
  async unlink(path: string): Promise<void> { const sftp = await this.sftp(); await callbackVoid((callback) => sftp.unlink(path, callback)) }
  async rmdir(path: string): Promise<void> { const sftp = await this.sftp(); await callbackVoid((callback) => sftp.rmdir(path, callback)) }
  async fsync(handle: string): Promise<void> { const sftp = await this.sftp(); await callbackVoid((callback) => sftp.ext_openssh_fsync(this.rawHandle(handle), callback)) }
  async hardlink(sourcePath: string, destinationPath: string): Promise<void> { const sftp = await this.sftp(); await callbackVoid((callback) => sftp.ext_openssh_hardlink(sourcePath, destinationPath, callback)) }
  async posixRename(sourcePath: string, destinationPath: string): Promise<void> { const sftp = await this.sftp(); await callbackVoid((callback) => sftp.ext_openssh_rename(sourcePath, destinationPath, callback)) }
  supportsExtension(name: 'fsync@openssh.com' | 'hardlink@openssh.com' | 'posix-rename@openssh.com'): boolean {
    if (!this.resolvedSftp) return false
    const extensions = (this.resolvedSftp as SFTPWrapper & { _extensions?: Record<string, string> })._extensions
    return typeof extensions?.[name] === 'string'
  }
  dispose(): void { void this.sftpPromise?.then((sftp) => { try { sftp.end() } catch { /* 已关闭 channel 无需重复上报。 */ } }, () => undefined); this.handles.clear() }

  /** 懒创建并复用唯一 SFTP channel。 */
  private sftp(): Promise<SFTPWrapper> {
    this.sftpPromise ??= new Promise<SFTPWrapper>((resolve, reject) => this.client.sftp((error, sftp) => {
      if (error) { reject(error); return }
      this.resolvedSftp = sftp
      resolve(sftp)
    }))
    return this.sftpPromise
  }
  /** 登记 ssh2 原始 Buffer handle，并只向领域层返回不透明 ID。 */
  private async openHandle(open: (sftp: SFTPWrapper, callback: (error: Error | undefined, handle: Buffer) => void) => void): Promise<string> {
    const sftp = await this.sftp()
    const rawHandle = await callbackResult<Buffer>((callback) => open(sftp, callback))
    const handle = `sftp-${++this.handleSequence}`
    this.handles.set(handle, rawHandle)
    return handle
  }
  /** 将不透明适配器 ID 解析为 ssh2 原始 handle。 */
  private rawHandle(handle: string): Buffer { const rawHandle = this.handles.get(handle); if (!rawHandle) throw new Error('SERVER_OPS_SFTP_ADAPTER_HANDLE_INVALID'); return rawHandle }
}

/** 验证并规范远程绝对 POSIX 路径，不将其描述为权限沙箱。 */
function normalizeRemotePath(path: string): string {
  if (!path.startsWith('/') || path.includes('\0') || path.length > 4_096) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_PATH_INVALID')
  const normalized = posix.normalize(path)
  if (!normalized.startsWith('/')) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_PATH_INVALID')
  return normalized
}

/** 验证单次读取块大小。 */
function validateChunkLength(length: number): void { if (!Number.isSafeInteger(length) || length < 1 || length > SERVER_OPS_SFTP_CHUNK_LIMIT_BYTES) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_CHUNK_INVALID') }
/** 过滤无法安全进入有界公开 DTO 的恶意或异常目录项。 */
function isSafeDirectoryEntry(entry: ServerOpsSftpAdapterDirectoryEntry): boolean { return Boolean(entry.name) && entry.name !== '.' && entry.name !== '..' && entry.name.length <= 1_024 && !entry.name.includes('/') && !entry.name.includes('\0') && Number.isSafeInteger(entry.size) && entry.size >= 0 && Number.isSafeInteger(entry.mtime) && entry.mtime >= 0 && Number.isSafeInteger(entry.mode) && entry.mode >= 0 }
/** 比较编辑与预览需要的稳定 stat 事实。 */
function sameStat(left: ServerOpsSftpStat, right: ServerOpsSftpStat): boolean { return left.kind === right.kind && left.size === right.size && left.mtime === right.mtime && left.mode === right.mode }
/** 估算目录结果序列化后的 UTF-8 字节数。 */
function estimateEntriesBytes(entries: ServerOpsSftpDirectoryEntry[]): number { return entries.reduce((total, entry) => total + Buffer.byteLength(entry.name) + Buffer.byteLength(entry.path) + 96, 0) }
/** 从待发条目中取满足数量与字节预算的前缀。 */
function takeBoundedEntries(entries: ServerOpsSftpDirectoryEntry[], countLimit: number, byteLimit: number): ServerOpsSftpDirectoryEntry[] {
  const result: ServerOpsSftpDirectoryEntry[] = []
  let bytes = 0
  for (const entry of entries) {
    const normalized = { ...entry, path: entry.path || '' }
    const entryBytes = estimateEntriesBytes([normalized])
    if (result.length >= countLimit || bytes + entryBytes > byteLimit) break
    result.push(normalized)
    bytes += entryBytes
  }
  return result
}
/** 将 ssh2 Stats 转为稳定领域事实。 */
function toStat(stat: Stats): ServerOpsSftpStat { return { size: stat.size, mtime: stat.mtime, mode: stat.mode, kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other' } }
/** 将单结果 ssh2 回调转换为 Promise。 */
function callbackResult<T>(invoke: (callback: (error: Error | undefined, value: T) => void) => void): Promise<T> { return new Promise<T>((resolve, reject) => invoke((error, value) => error ? reject(error) : resolve(value))) }
/** 将无结果 ssh2 回调转换为 Promise。 */
function callbackVoid(invoke: (callback: (error?: Error | null) => void) => void): Promise<void> { return new Promise<void>((resolve, reject) => invoke((error) => error ? reject(error) : resolve())) }
/** 关闭清理使用 best-effort，避免覆盖主要操作错误。 */
async function ignoreCloseError(close: Promise<void>): Promise<void> { try { await close } catch { /* 清理错误由连接级回收兜底。 */ } }
/** 为适配器调用施加真实截止时间，超时不会等待迟到回调。 */
async function withDeadline<T>(promise: Promise<T>, deadlineAt: number, now: () => number): Promise<T> {
  const remaining = deadlineAt - now()
  if (remaining <= 0) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_DEADLINE_EXCEEDED')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_DEADLINE_EXCEEDED')), remaining) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}
/** 识别 ssh2 在目录流末尾返回的 SFTP EOF 状态。 */
function isSftpEof(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 1) }

/** runtime 子协议 exact-key 对象解析。 */
function protocolRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).every((key) => keys.includes(key))) throw new Error('SERVER_OPS_SFTP_PROTOCOL_INVALID')
  return value as Record<string, unknown>
}
/** runtime 子协议稳定 ID 解析。 */
function protocolId(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('SERVER_OPS_SFTP_PROTOCOL_INVALID'); return value }
/** runtime 子协议非负安全整数解析。 */
function protocolInteger(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('SERVER_OPS_SFTP_PROTOCOL_INVALID'); return value }
/** runtime 子协议绝对远程路径解析。 */
function protocolPath(value: unknown): string { if (typeof value !== 'string') throw new Error('SERVER_OPS_SFTP_PROTOCOL_INVALID'); try { return normalizeRemotePath(value) } catch { throw new Error('SERVER_OPS_SFTP_PROTOCOL_INVALID') } }
/** runtime 子协议 owner/deadline 解析。 */
function parseOperationIdentity(value: Record<string, unknown>): ServerOpsSftpOperationIdentity {
  if (typeof value.ownerKey !== 'string' || !value.ownerKey || value.ownerKey.length > 256 || typeof value.deadlineAt !== 'number' || !Number.isSafeInteger(value.deadlineAt) || value.deadlineAt < 0) throw new Error('SERVER_OPS_SFTP_PROTOCOL_INVALID')
  return { ownerKey: value.ownerKey, deadlineAt: value.deadlineAt }
}
/** runtime 子协议路径操作解析。 */
function parsePathOperation(value: unknown): ServerOpsSftpPathInput { const parsed = protocolRecord(value, ['ownerKey', 'deadlineAt', 'path']); return { ...parseOperationIdentity(parsed), path: protocolPath(parsed.path) } }
/** runtime 子协议目录操作解析。 */
function parseListOperation(value: unknown): ServerOpsSftpListInput { const parsed = protocolRecord(value, ['ownerKey', 'deadlineAt', 'path', 'cursorId']); return { ...parseOperationIdentity(parsed), path: protocolPath(parsed.path), ...(parsed.cursorId === undefined ? {} : { cursorId: protocolId(parsed.cursorId) }) } }
/** runtime 子协议 handle 操作解析。 */
function parseHandleOperation(value: unknown): ServerOpsSftpHandleInput { const parsed = protocolRecord(value, ['ownerKey', 'deadlineAt', 'handleId']); return { ...parseOperationIdentity(parsed), handleId: protocolId(parsed.handleId) } }
/** runtime 子协议 stat 结果解析。 */
function parseRuntimeStat(value: unknown): ServerOpsSftpStat {
  const parsed = protocolRecord(value, ['size', 'mtime', 'mode', 'kind'])
  if (parsed.kind !== 'file' && parsed.kind !== 'directory' && parsed.kind !== 'symlink' && parsed.kind !== 'other') throw new Error('SERVER_OPS_SFTP_PROTOCOL_INVALID')
  return { size: protocolInteger(parsed.size), mtime: protocolInteger(parsed.mtime), mode: protocolInteger(parsed.mode), kind: parsed.kind }
}
/** runtime 子协议目录结果解析。 */
function parseListResult(value: unknown): ServerOpsSftpListResult {
  const parsed = protocolRecord(value, ['path', 'entries', 'cursorId', 'truncatedReason'])
  if (!Array.isArray(parsed.entries) || parsed.entries.length > SERVER_OPS_SFTP_PAGE_LIMIT) throw new Error('SERVER_OPS_SFTP_RESULT_INVALID')
  const path = protocolPath(parsed.path)
  const entries = parsed.entries.map((value) => {
    const entry = protocolRecord(value, ['name', 'path', 'size', 'mtime', 'mode', 'kind'])
    const stat = parseRuntimeStat({ size: entry.size, mtime: entry.mtime, mode: entry.mode, kind: entry.kind })
    if (typeof entry.name !== 'string' || !isSafeDirectoryEntry({ name: entry.name, ...stat })) throw new Error('SERVER_OPS_SFTP_RESULT_INVALID')
    return { name: entry.name, path: protocolPath(entry.path), ...stat }
  })
  if (estimateEntriesBytes(entries) > SERVER_OPS_SFTP_PAGE_BYTE_LIMIT) throw new Error('SERVER_OPS_SFTP_RESULT_INVALID')
  const reason = parsed.truncatedReason
  if (reason !== undefined && reason !== 'item-limit' && reason !== 'byte-limit' && reason !== 'server-batch-overflow') throw new Error('SERVER_OPS_SFTP_RESULT_INVALID')
  return { path, entries, ...(parsed.cursorId === undefined ? {} : { cursorId: protocolId(parsed.cursorId) }), ...(reason === undefined ? {} : { truncatedReason: reason }) }
}
/** runtime 子协议预览结果解析。 */
function parsePreviewResult(value: unknown): ServerOpsSftpPreviewResult {
  const parsed = protocolRecord(value, ['kind', 'path', 'content', 'bytesRead', 'hash', 'stat', 'editFacts', 'target'])
  const path = protocolPath(parsed.path)
  const stat = parseRuntimeStat(parsed.stat)
  if (parsed.kind === 'too-large' && parsed.bytesRead === 0 && stat.kind === 'file' && stat.size > SERVER_OPS_SFTP_PREVIEW_LIMIT_BYTES && parsed.content === undefined && parsed.hash === undefined && parsed.editFacts === undefined && parsed.target === undefined) return { kind: 'too-large', path, bytesRead: 0, stat }
  if (parsed.kind === 'symlink' && parsed.bytesRead === 0 && stat.kind === 'symlink' && typeof parsed.target === 'string' && parsed.target.length <= 4_096 && !parsed.target.includes('\0') && parsed.content === undefined && parsed.hash === undefined && parsed.editFacts === undefined) return { kind: 'symlink', path, bytesRead: 0, target: parsed.target, stat }
  const bytesRead = protocolInteger(parsed.bytesRead)
  if (bytesRead > SERVER_OPS_SFTP_PREVIEW_LIMIT_BYTES || typeof parsed.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(parsed.hash)) throw new Error('SERVER_OPS_SFTP_RESULT_INVALID')
  if (parsed.kind === 'binary' && stat.kind === 'file' && parsed.content === undefined && parsed.editFacts === undefined && parsed.target === undefined) return { kind: 'binary', path, bytesRead, hash: parsed.hash, stat }
  if (parsed.kind !== 'text' || stat.kind !== 'file' || typeof parsed.content !== 'string' || Buffer.byteLength(parsed.content) !== bytesRead || stat.size !== bytesRead || parsed.target !== undefined) throw new Error('SERVER_OPS_SFTP_RESULT_INVALID')
  const facts = protocolRecord(parsed.editFacts, ['path', 'size', 'mtime', 'mode', 'hash'])
  if (protocolPath(facts.path) !== path || facts.hash !== parsed.hash || protocolInteger(facts.size) !== stat.size || protocolInteger(facts.mtime) !== stat.mtime || protocolInteger(facts.mode) !== stat.mode) throw new Error('SERVER_OPS_SFTP_RESULT_INVALID')
  return { kind: 'text', path, content: parsed.content, bytesRead, hash: parsed.hash, stat, editFacts: { path, size: stat.size, mtime: stat.mtime, mode: stat.mode, hash: parsed.hash } }
}
/** runtime 子协议编辑事实解析。 */
function parseEditFacts(value: unknown): ServerOpsSftpEditFacts {
  const parsed = protocolRecord(value, ['path', 'size', 'mtime', 'mode', 'hash'])
  if (typeof parsed.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(parsed.hash)) throw new Error('SERVER_OPS_SFTP_PROTOCOL_INVALID')
  return { path: protocolPath(parsed.path), size: protocolInteger(parsed.size), mtime: protocolInteger(parsed.mtime), mode: protocolInteger(parsed.mode), hash: parsed.hash }
}
/** 编码并限制受控文本保存正文。 */
function encodeText(content: string): Buffer {
  const data = Buffer.from(content, 'utf8')
  if (data.length > SERVER_OPS_SFTP_PREVIEW_LIMIT_BYTES) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_TEXT_TOO_LARGE')
  return data
}
/** 生成稳定 SHA-256 编辑事实。 */
function hashBuffer(data: Buffer): string { return `sha256:${createHash('sha256').update(data).digest('hex')}` }

/** 判断请求是否可能在响应丢失前修改远端状态。 */
function isMutationRequest(type: ServerOpsSftpRequest['type']): boolean {
  return type === 'write' || type === 'mkdir' || type === 'rename' || type === 'unlink' || type === 'rmdir'
    || type === 'save-as' || type === 'save' || type === 'publish-temp'
}

/** 将 ssh2/适配器错误收敛为不泄露路径与服务端正文的稳定错误。 */
export function classifyServerOpsSftpError(error: unknown, mutationDispatched: boolean): ServerOpsSftpRuntimeError {
  if (error instanceof ServerOpsSftpRuntimeError) return error
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
  if (code === 2 || code === 'ENOENT') return new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_NOT_FOUND')
  if (code === 3 || code === 'EACCES' || code === 'EPERM') return new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_PERMISSION_DENIED')
  if (code === 8) return new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_UNSUPPORTED')
  if (code === 'EEXIST') return new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_ALREADY_EXISTS')
  if (code === 6 || code === 7 || code === 'ECONNRESET' || code === 'EPIPE') return new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_CONNECTION_LOST', mutationDispatched ? 'unknown' : 'not-committed')
  return new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_FAILED', mutationDispatched ? 'unknown' : 'not-committed')
}
