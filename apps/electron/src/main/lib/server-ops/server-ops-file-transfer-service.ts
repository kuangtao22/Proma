import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  SERVER_OPS_TRANSFER_ACTIVE_LIMIT,
  SERVER_OPS_TRANSFER_CHUNK_LIMIT_BYTES,
  SERVER_OPS_TRANSFER_FILE_LIMIT_BYTES,
  SERVER_OPS_TRANSFER_QUEUE_LIMIT,
  parseServerOpsTransferCancelInput,
  parseServerOpsTransferListInput,
  parseServerOpsTransferSnapshot,
  parseServerOpsTransferSnapshots,
  parseServerOpsTransferStartInput,
} from '@proma/shared'
import type {
  ServerOpsAuditAppendInput,
  ServerOpsTransferDirection,
  ServerOpsTransferListInput,
  ServerOpsTransferSnapshot,
  ServerOpsTransferStartInput,
} from '@proma/shared'
import { ServerOpsSftpRuntimeError } from '../../../utility/server-ops/server-ops-sftp-runtime'
import type { ServerOpsSftpResult, ServerOpsSftpStat } from '../../../utility/server-ops/server-ops-sftp-runtime'
import type { ServerOpsActiveConnectionIdentity } from './server-ops-connection-service'
import type { ServerOpsSftpCall } from './server-ops-runtime-client'
import { readJsonFileSafe, removeFileAtomic, writeJsonFileAtomicSecure } from '../safe-file'

/** 单次传输操作允许的最长 SFTP deadline。 */
const TRANSFER_DEADLINE_MS = 120_000
/** 公开进度最多每 100ms 发布一次。 */
const TRANSFER_PROGRESS_INTERVAL_MS = 100
/** 恢复 JSON 最快每秒持久化一次。 */
const TRANSFER_RECOVERY_INTERVAL_MS = 1_000
/** 即使时间未到，每累计 1 MiB 也持久化一次恢复进度。 */
const TRANSFER_RECOVERY_BYTE_INTERVAL = 1_048_576
/** 内存中最多保留的终态与恢复快照数量。 */
const TRANSFER_HISTORY_LIMIT = 500

/** 本地 fd lease 暴露给传输服务的窄能力，不包含可重开的本地路径。 */
export interface ServerOpsLocalFileLease {
  direction: ServerOpsTransferDirection
  fileName: string
  /** 上传 lease 在选择器签发时绑定的文件大小。 */
  size: number
  read(position: number, length: number): Promise<Uint8Array>
  write(position: number, data: Uint8Array): Promise<void>
  fstat(): Promise<{ size: number }>
  fsync(): Promise<void>
  publishNoClobber(): Promise<'published' | 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED'>
  hash(): Promise<string>
  discard(): Promise<void>
  close(): Promise<void>
}

/** 崩溃后只供人工检查的最小恢复意图。 */
export interface ServerOpsTransferRecoveryIntent {
  version: 1
  transferId: string
  hostId: string
  direction: ServerOpsTransferDirection
  fileName: string
  remotePath: string
  totalBytes: number
  transferredBytes: number
  createdAt: number
  updatedAt: number
  state: 'active' | 'unknown'
  localHash?: string
  remoteHash?: string
}

/** 每条恢复意图独立持久化的存储边界。 */
export interface ServerOpsTransferRecoveryStore {
  load(): ServerOpsTransferRecoveryIntent[]
  save(intent: ServerOpsTransferRecoveryIntent): void
  remove(transferId: string): void
}

/** 使用 safe-file 为每条传输维护独立恢复 JSON。 */
export class ServerOpsSafeFileTransferRecoveryStore implements ServerOpsTransferRecoveryStore {
  private readonly directoryPath: string

  constructor(configDir: string) {
    this.directoryPath = join(configDir, 'server-ops', 'transfer-recovery')
    mkdirSync(this.directoryPath, { recursive: true, mode: 0o700 })
  }

  /** 读取全部严格恢复意图；损坏文件 fail closed，避免误判传输事实。 */
  load(): ServerOpsTransferRecoveryIntent[] {
    const intents: ServerOpsTransferRecoveryIntent[] = []
    for (const name of readdirSync(this.directoryPath).filter((entry) => entry.endsWith('.json')).sort()) {
      const filePath = join(this.directoryPath, name)
      const intent = readJsonFileSafe<ServerOpsTransferRecoveryIntent>(filePath, { validate: isRecoveryIntent })
      if (!intent) throw new Error('SERVER_OPS_TRANSFER_RECOVERY_READ_FAILED')
      intents.push(intent)
    }
    return intents
  }

  /** 原子写入单条恢复意图，不持久化本地 lease 或文件内容。 */
  save(intent: ServerOpsTransferRecoveryIntent): void {
    if (!isRecoveryIntent(intent)) throw new Error('SERVER_OPS_TRANSFER_RECOVERY_INVALID')
    writeJsonFileAtomicSecure(this.pathFor(intent.transferId), intent)
  }

  /** 通过 safe-file 原子删除已完成传输的恢复意图。 */
  remove(transferId: string): void {
    const filePath = this.pathFor(transferId)
    if (existsSync(filePath)) removeFileAtomic(filePath)
  }

  /** 将严格 ID 映射为固定目录内的 JSON 文件。 */
  private pathFor(transferId: string): string {
    const snapshot = parseServerOpsTransferSnapshot({ transferId, hostId: 'host', direction: 'upload', fileName: 'file', remotePath: '/', status: 'queued', transferredBytes: 0, totalBytes: 0, createdAt: 0, updatedAt: 0 })
    return join(this.directoryPath, `${snapshot.transferId}.json`)
  }
}

/** 文件传输服务的连接、fd lease、审计和恢复依赖。 */
export interface ServerOpsFileTransferServiceDependencies {
  connections: {
    getActiveIdentity(hostId: string): ServerOpsActiveConnectionIdentity
    sftp(input: ServerOpsSftpCall): Promise<ServerOpsSftpResult>
    closeSftpOwner(ownerKey: string): Promise<void>
  }
  leases: { claim(leaseId: string, direction: ServerOpsTransferDirection, ownerId: number, ownerKey: string): Promise<ServerOpsLocalFileLease> }
  /** await claim 前后验证窗口仍存活，阻止关闭窗口留下已领取 fd。 */
  isOwnerAlive?: (ownerId: number) => boolean
  audit: { prepareForWrites?: () => Promise<void>; append(input: ServerOpsAuditAppendInput): unknown }
  recovery: ServerOpsTransferRecoveryStore
  publish?: (ownerId: number, snapshot: ServerOpsTransferSnapshot) => void
  uuid?: () => string
  now?: () => number
}

/** 内存中的单条传输任务与精确资源 owner。 */
interface TransferTask {
  ownerId: number
  ownerKey: string
  ownerGeneration: number
  sftpOwnerKey: string
  identity: ServerOpsActiveConnectionIdentity
  lease: ServerOpsLocalFileLease
  snapshot: ServerOpsTransferSnapshot
  cancelled: boolean
  startedMutation: boolean
  lastProgressAt: number
  lastPersistAt: number
  lastPersistedBytes: number
  phase: 'queued' | 'preparing' | 'transferring' | 'verifying' | 'publishing' | 'published'
  done: Promise<void>
  resolveDone: () => void
  sftpCleanup?: Promise<boolean>
}

/** 维护全局 2 active / 20 queued 队列并执行有界文件传输。 */
export class ServerOpsFileTransferService {
  private readonly tasks = new Map<string, TransferTask>()
  private readonly recovered: ServerOpsTransferSnapshot[]
  private readonly queue: TransferTask[] = []
  private readonly active = new Set<string>()
  private readonly settling = new Set<string>()
  private readonly idleWaiters = new Set<() => void>()
  private readonly ownerGenerations = new Map<string, number>()
  private readonly uuid: () => string
  private readonly now: () => number
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(private readonly dependencies: ServerOpsFileTransferServiceDependencies) {
    this.uuid = dependencies.uuid ?? randomUUID
    this.now = dependencies.now ?? Date.now
    this.recovered = dependencies.recovery.load().slice(-TRANSFER_HISTORY_LIMIT).map((intent) => parseServerOpsTransferSnapshot({
      transferId: intent.transferId, hostId: intent.hostId, direction: intent.direction, fileName: intent.fileName,
      remotePath: intent.remotePath, status: 'pending-check', transferredBytes: intent.transferredBytes,
      totalBytes: intent.totalBytes, createdAt: intent.createdAt, updatedAt: intent.updatedAt,
      errorCode: 'SERVER_OPS_TRANSFER_RESULT_UNKNOWN',
    }))
  }

  /** 领取系统 fd lease 并将传输加入全局有界队列。 */
  async start(ownerId: number, ownerKey: string, input: ServerOpsTransferStartInput): Promise<ServerOpsTransferSnapshot> {
    assertOwner(ownerId, ownerKey)
    if (this.disposed) throw new Error('SERVER_OPS_TRANSFER_OWNER_CLOSED')
    const ownerGeneration = this.ownerGeneration(ownerId, ownerKey)
    const parsed = parseServerOpsTransferStartInput(input)
    if (this.dependencies.isOwnerAlive && !this.dependencies.isOwnerAlive(ownerId)) throw new Error('SERVER_OPS_TRANSFER_OWNER_CLOSED')
    if (this.active.size + this.queue.length >= SERVER_OPS_TRANSFER_ACTIVE_LIMIT + SERVER_OPS_TRANSFER_QUEUE_LIMIT) throw new Error('SERVER_OPS_TRANSFER_CAPACITY_EXCEEDED')
    const identity = this.requireIdentity(parsed.hostId)
    const lease = await this.dependencies.leases.claim(parsed.leaseId, parsed.direction, ownerId, ownerKey)
    if (this.disposed || this.ownerGeneration(ownerId, ownerKey) !== ownerGeneration) { await lease.close(); throw new Error('SERVER_OPS_TRANSFER_OWNER_CLOSED') }
    if (this.dependencies.isOwnerAlive && !this.dependencies.isOwnerAlive(ownerId)) { await lease.close(); throw new Error('SERVER_OPS_TRANSFER_OWNER_CLOSED') }
    if (this.active.size + this.queue.length >= SERVER_OPS_TRANSFER_ACTIVE_LIMIT + SERVER_OPS_TRANSFER_QUEUE_LIMIT) { await lease.close(); throw new Error('SERVER_OPS_TRANSFER_CAPACITY_EXCEEDED') }
    if (lease.direction !== parsed.direction) { await lease.close(); throw new Error('SERVER_OPS_TRANSFER_LEASE_INVALID') }
    if (!Number.isSafeInteger(lease.size) || lease.size < 0 || lease.size > SERVER_OPS_TRANSFER_FILE_LIMIT_BYTES) { await lease.close(); throw new Error('SERVER_OPS_TRANSFER_FILE_TOO_LARGE') }
    const transferId = this.uuid()
    const createdAt = this.now()
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const task: TransferTask = {
      ownerId, ownerKey, ownerGeneration, sftpOwnerKey: `${ownerKey}:transfer:${transferId}`, identity, lease, cancelled: false,
      startedMutation: false, lastProgressAt: 0, lastPersistAt: 0, lastPersistedBytes: 0, phase: 'queued',
      done, resolveDone,
      snapshot: parseServerOpsTransferSnapshot({ transferId, hostId: parsed.hostId, direction: parsed.direction,
        fileName: lease.fileName, remotePath: parsed.remotePath, status: this.active.size < SERVER_OPS_TRANSFER_ACTIVE_LIMIT ? 'running' : 'queued',
        transferredBytes: 0, totalBytes: lease.size, createdAt, updatedAt: createdAt }),
    }
    this.tasks.set(transferId, task)
    if (task.snapshot.status === 'running') this.launch(task)
    else { this.queue.push(task); this.emit(task, true) }
    return parseServerOpsTransferSnapshot(task.snapshot)
  }

  /** 返回当前 owner 可见的任务和重启后待人工检查的恢复意图。 */
  list(ownerId: number, ownerKey: string, input: ServerOpsTransferListInput): ServerOpsTransferSnapshot[] {
    assertOwner(ownerId, ownerKey)
    const parsed = parseServerOpsTransferListInput(input)
    const current = [...this.tasks.values()].filter((task) => task.ownerId === ownerId && task.ownerKey === ownerKey).map((task) => task.snapshot)
    return parseServerOpsTransferSnapshots([...this.recovered, ...current].filter((item) => !parsed.hostId || item.hostId === parsed.hostId))
  }

  /** 取消精确 transfer；未知写结果不会重新入队。 */
  async cancel(ownerId: number, ownerKey: string, input: { hostId: string; transferId: string }): Promise<void> {
    assertOwner(ownerId, ownerKey)
    const parsed = parseServerOpsTransferCancelInput(input)
    const task = this.tasks.get(parsed.transferId)
    if (!task || task.ownerId !== ownerId || task.ownerKey !== ownerKey || task.snapshot.hostId !== parsed.hostId) throw new Error('SERVER_OPS_TRANSFER_NOT_FOUND')
    task.cancelled = true
    if (task.snapshot.status === 'queued') {
      this.setStatus(task, 'cancelling')
      this.settling.add(task.snapshot.transferId)
      const queueIndex = this.queue.indexOf(task)
      if (queueIndex >= 0) this.queue.splice(queueIndex, 1)
      try { await this.finishCancelled(task) } finally {
        this.settling.delete(task.snapshot.transferId)
        task.resolveDone()
        this.resolveIdleIfNeeded()
      }
      return
    }
    if (task.snapshot.status === 'running') {
      this.setStatus(task, 'cancelling')
      const cleanup = this.requestSftpCleanup(task)
      await task.done
      await cleanup
      return
    }
    if (task.snapshot.status === 'cancelling') await task.done
  }

  /** 窗口关闭时只收口其拥有的传输与句柄。 */
  async closeOwner(ownerId: number, ownerKey: string): Promise<void> {
    assertOwner(ownerId, ownerKey)
    this.ownerGenerations.set(ownerIdentity(ownerId, ownerKey), this.ownerGeneration(ownerId, ownerKey) + 1)
    const owned = [...this.tasks.values()].filter((task) => task.ownerId === ownerId && task.ownerKey === ownerKey && !isTerminal(task.snapshot.status))
    await Promise.all(owned.map((task) => this.cancel(ownerId, ownerKey, { hostId: task.snapshot.hostId, transferId: task.snapshot.transferId })))
  }

  /** 测试和服务关闭使用的队列空闲屏障。 */
  async whenIdle(): Promise<void> {
    if (this.active.size === 0 && this.queue.length === 0 && this.settling.size === 0) return
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  /** 停止服务并收口所有活动任务。 */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.disposePromise = this.disposeAll()
    return this.disposePromise
  }

  /** 取消全部任务并等待活动和 queued 清理链完成。 */
  private async disposeAll(): Promise<void> {
    const owners = new Map<string, { ownerId: number; ownerKey: string }>()
    for (const task of this.tasks.values()) {
      if (!isTerminal(task.snapshot.status)) owners.set(ownerIdentity(task.ownerId, task.ownerKey), { ownerId: task.ownerId, ownerKey: task.ownerKey })
    }
    await Promise.all([...owners.values()].map((owner) => this.closeOwner(owner.ownerId, owner.ownerKey)))
    await this.whenIdle()
  }

  /** 启动单条任务，完成后自动让出 active slot。 */
  private launch(task: TransferTask): void {
    this.active.add(task.snapshot.transferId)
    this.setStatus(task, 'running')
    void this.run(task).finally(() => {
      this.active.delete(task.snapshot.transferId)
      this.drain()
      task.resolveDone()
      this.resolveIdleIfNeeded()
    })
  }

  /** 按方向执行传输并记录不覆盖真实事实的审计结果。 */
  private async run(task: TransferTask): Promise<void> {
    const operationId = this.uuid()
    const startedAt = this.now()
    const auditBase = { actor: 'user' as const, operationId, windowId: task.ownerId, hostId: task.identity.hostId,
      operation: task.snapshot.direction === 'upload' ? 'file-upload' as const : 'file-download' as const,
      resourceType: 'remote-file' as const, resourceId: hashRemotePath(task.snapshot.remotePath) }
    let auditStarted = false
    try {
      task.phase = 'preparing'
      if (this.dependencies.audit.prepareForWrites) await this.dependencies.audit.prepareForWrites()
      this.assertRunnable(task)
      this.dependencies.audit.append({ ...auditBase, phase: 'start', outcome: 'pending' })
      auditStarted = true
      this.persist(task, 'active')
      this.assertRunnable(task)
      if (task.snapshot.direction === 'upload') await this.upload(task)
      else await this.download(task)
      this.assertNotCancelled(task)
      this.safeRecoveryRemove(task.snapshot.transferId)
      this.setStatus(task, 'succeeded')
      if (!await this.appendResultAudit(auditBase, startedAt, 'success')) this.setWarning(task, 'SERVER_OPS_AUDIT_WRITE_FAILED')
    } catch (error) {
      if (task.phase === 'published') {
        this.safeRecoveryRemove(task.snapshot.transferId)
        this.setStatus(task, 'succeeded')
        if (auditStarted && !await this.appendResultAudit(auditBase, startedAt, 'success')) this.setWarning(task, 'SERVER_OPS_AUDIT_WRITE_FAILED')
        return
      }
      if (task.cancelled && task.phase !== 'publishing') {
        await this.finishCancelled(task)
        if (auditStarted && !await this.appendResultAudit(auditBase, startedAt, 'error', 'SERVER_OPS_TRANSFER_CANCELLED')) this.setWarning(task, 'SERVER_OPS_AUDIT_WRITE_FAILED')
        return
      }
      const unknown = task.startedMutation && (isUnknownOutcome(error) || task.cancelled && task.phase === 'publishing')
      const code = unknown ? 'SERVER_OPS_TRANSFER_RESULT_UNKNOWN' : stableTransferError(error)
      const localCleaned = await this.discardLease(task)
      if (unknown || !localCleaned) this.safePersist(task, 'unknown')
      else this.safeRecoveryRemove(task.snapshot.transferId)
      this.setStatus(task, unknown ? 'unknown' : 'failed', code)
      if (!localCleaned) this.setWarning(task, 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED')
      if (auditStarted && !await this.appendResultAudit(auditBase, startedAt, unknown ? 'unknown' : 'error', code)) this.setWarning(task, 'SERVER_OPS_AUDIT_WRITE_FAILED')
    } finally {
      let localClosed = true
      try { await task.lease.close() } catch { localClosed = false }
      const remoteCleaned = await this.requestSftpCleanup(task)
      if (!localClosed || !remoteCleaned) {
        this.safePersist(task, 'unknown')
        this.setWarning(task, 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED')
      }
    }
  }

  /** 上传本地 fd 内容并读回远端 temp 计算 hash，验证后才发布。 */
  private async upload(task: TransferTask): Promise<void> {
    const totalBytes = task.lease.size
    task.phase = 'transferring'
    task.startedMutation = true
    const open = await this.call(task, { type: 'open-write', input: { ...this.common(task), path: task.snapshot.remotePath, mode: 'exclusive-temp' } })
    if (open.type !== 'open-write' || !open.result.temporaryPath) throw new Error('SERVER_OPS_TRANSFER_RESULT_INVALID')
    const localHash = createHash('sha256')
    let position = 0
    while (position < totalBytes) {
      this.assertNotCancelled(task)
      const chunk = await task.lease.read(position, Math.min(SERVER_OPS_TRANSFER_CHUNK_LIMIT_BYTES, totalBytes - position))
      if (chunk.byteLength < 1 || chunk.byteLength > SERVER_OPS_TRANSFER_CHUNK_LIMIT_BYTES) throw new Error('SERVER_OPS_TRANSFER_LOCAL_FILE_CHANGED')
      localHash.update(chunk)
      const written = await this.call(task, { type: 'write', input: { ...this.common(task), handleId: open.result.handleId, position, data: chunk } })
      if (written.type !== 'write') throw new Error('SERVER_OPS_TRANSFER_RESULT_INVALID')
      position += chunk.byteLength
      this.progress(task, position, totalBytes)
    }
    const localStat = await task.lease.fstat()
    if (localStat.size !== totalBytes) throw new Error('SERVER_OPS_TRANSFER_LOCAL_FILE_CHANGED')
    await this.closeRemoteHandle(task, open.result.handleId)
    task.phase = 'verifying'
    const remoteHash = await this.hashRemoteFile(task, open.result.temporaryPath, totalBytes)
    const localDigest = `sha256:${localHash.digest('hex')}`
    if (remoteHash !== localDigest) throw new Error('SERVER_OPS_TRANSFER_HASH_MISMATCH')
    this.persist(task, 'active', localDigest, remoteHash)
    task.phase = 'publishing'
    await this.publishRemoteTemp(task, open.result.temporaryPath)
    task.phase = 'published'
  }

  /** 下载远端普通文件到本地独占 temp fd，校验后同步并 no-clobber 发布。 */
  private async download(task: TransferTask): Promise<void> {
    const opened = await this.call(task, { type: 'open-read', input: { ...this.common(task), path: task.snapshot.remotePath } })
    if (opened.type !== 'open-read') throw new Error('SERVER_OPS_TRANSFER_RESULT_INVALID')
    const initial = opened.result.stat
    if (initial.size > SERVER_OPS_TRANSFER_FILE_LIMIT_BYTES) throw new Error('SERVER_OPS_TRANSFER_FILE_TOO_LARGE')
    task.snapshot = parseServerOpsTransferSnapshot({ ...task.snapshot, totalBytes: initial.size, updatedAt: this.now() })
    task.startedMutation = true
    task.phase = 'transferring'
    const receivedHash = createHash('sha256')
    let position = 0
    while (position < initial.size) {
      this.assertNotCancelled(task)
      const result = await this.call(task, { type: 'read', input: { ...this.common(task), handleId: opened.result.handleId, length: Math.min(SERVER_OPS_TRANSFER_CHUNK_LIMIT_BYTES, initial.size - position) } })
      if (result.type !== 'read' || result.result.position !== position || result.result.data.byteLength < 1) throw new Error('SERVER_OPS_TRANSFER_RESULT_INVALID')
      await task.lease.write(position, result.result.data)
      receivedHash.update(result.result.data)
      position += result.result.data.byteLength
      this.progress(task, position, initial.size)
    }
    await this.closeRemoteHandle(task, opened.result.handleId)
    const after = await this.call(task, { type: 'stat', input: { ...this.common(task), path: task.snapshot.remotePath } })
    if (after.type !== 'stat' || !sameStat(initial, after.result)) throw new Error('SERVER_OPS_TRANSFER_REMOTE_FILE_CHANGED')
    const localStat = await task.lease.fstat()
    if (localStat.size !== initial.size) throw new Error('SERVER_OPS_TRANSFER_LOCAL_WRITE_FAILED')
    await task.lease.fsync()
    task.phase = 'verifying'
    if (await task.lease.hash() !== `sha256:${receivedHash.digest('hex')}`) throw new Error('SERVER_OPS_TRANSFER_HASH_MISMATCH')
    task.phase = 'publishing'
    const publishResult = await task.lease.publishNoClobber()
    task.phase = 'published'
    if (publishResult === 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED') this.setWarning(task, publishResult)
  }

  /** 顺序读取远端文件并计算实际二进制 hash。 */
  private async hashRemoteFile(task: TransferTask, path: string, expectedSize: number): Promise<string> {
    const opened = await this.call(task, { type: 'open-read', input: { ...this.common(task), path } })
    if (opened.type !== 'open-read' || opened.result.stat.size !== expectedSize) throw new Error('SERVER_OPS_TRANSFER_HASH_MISMATCH')
    const hash = createHash('sha256')
    let position = 0
    while (position < expectedSize) {
      const result = await this.call(task, { type: 'read', input: { ...this.common(task), handleId: opened.result.handleId, length: Math.min(SERVER_OPS_TRANSFER_CHUNK_LIMIT_BYTES, expectedSize - position) } })
      if (result.type !== 'read' || result.result.position !== position || result.result.data.byteLength < 1) throw new Error('SERVER_OPS_TRANSFER_HASH_MISMATCH')
      hash.update(result.result.data)
      position += result.result.data.byteLength
    }
    await this.closeRemoteHandle(task, opened.result.handleId)
    return `sha256:${hash.digest('hex')}`
  }

  /** 正常关闭精确远端 handle，并验证判别结果。 */
  private async closeRemoteHandle(task: TransferTask, handleId: string): Promise<void> {
    const result = await this.call(task, { type: 'close', input: { ...this.common(task), handleId } })
    if (result.type !== 'close') throw new Error('SERVER_OPS_TRANSFER_RESULT_INVALID')
  }

  /** 将已校验的远端 temp 通过 no-clobber 原语发布。 */
  private async publishRemoteTemp(task: TransferTask, temporaryPath: string): Promise<void> {
    const result = await this.call(task, { type: 'publish-temp', input: { ...this.common(task), temporaryPath, destinationPath: task.snapshot.remotePath } })
    if (result.type !== 'publish-temp') throw new Error('SERVER_OPS_TRANSFER_RESULT_INVALID')
  }

  /** 调用当前连接并在 await 后复核 generation。 */
  private async call(task: TransferTask, operation: Omit<ServerOpsSftpCall, 'hostId' | 'connectionId'>): Promise<ServerOpsSftpResult> {
    this.assertRunnable(task)
    const result = await this.dependencies.connections.sftp({ ...operation, hostId: task.identity.hostId, connectionId: task.identity.connectionId } as ServerOpsSftpCall)
    const current = this.requireIdentity(task.identity.hostId)
    if (current.connectionId !== task.identity.connectionId || current.generation !== task.identity.generation) throw new Error('SERVER_OPS_CONNECTION_CHANGED')
    return result
  }

  /** 生成单次 SFTP 操作的 owner 与 deadline。 */
  private common(task: TransferTask): { ownerKey: string; deadlineAt: number } { return { ownerKey: task.sftpOwnerKey, deadlineAt: this.now() + TRANSFER_DEADLINE_MS } }

  /** 节流发布进度并同步最小恢复意图。 */
  private progress(task: TransferTask, transferredBytes: number, totalBytes: number): void {
    task.snapshot = parseServerOpsTransferSnapshot({ ...task.snapshot, transferredBytes, totalBytes, updatedAt: this.now() })
    if (task.snapshot.updatedAt - task.lastPersistAt >= TRANSFER_RECOVERY_INTERVAL_MS
      || transferredBytes - task.lastPersistedBytes >= TRANSFER_RECOVERY_BYTE_INTERVAL
      || transferredBytes === totalBytes) this.persist(task, 'active')
    if (task.snapshot.updatedAt - task.lastProgressAt >= TRANSFER_PROGRESS_INTERVAL_MS || transferredBytes === totalBytes) this.emit(task, true)
  }

  /** 持久化不含 lease、fd、本地路径或文件内容的恢复意图。 */
  private persist(task: TransferTask, state: 'active' | 'unknown', localHash?: string, remoteHash?: string): void {
    this.dependencies.recovery.save({ version: 1, transferId: task.snapshot.transferId, hostId: task.snapshot.hostId,
      direction: task.snapshot.direction, fileName: task.snapshot.fileName, remotePath: task.snapshot.remotePath,
      totalBytes: task.snapshot.totalBytes, transferredBytes: task.snapshot.transferredBytes,
      createdAt: task.snapshot.createdAt, updatedAt: task.snapshot.updatedAt, state,
      ...(localHash ? { localHash } : {}), ...(remoteHash ? { remoteHash } : {}) })
    task.lastPersistAt = task.snapshot.updatedAt
    task.lastPersistedBytes = task.snapshot.transferredBytes
  }

  /** 更新终态或运行态并立即发布。 */
  private setStatus(task: TransferTask, status: ServerOpsTransferSnapshot['status'], errorCode?: string): void {
    task.snapshot = parseServerOpsTransferSnapshot({ ...task.snapshot, status, updatedAt: this.now(), ...(errorCode ? { errorCode } : {}) })
    this.emit(task, true)
    if (isTerminal(status)) this.pruneHistory()
  }

  /** 发布快照并维护节流时间。 */
  private emit(task: TransferTask, force = false): void {
    const now = task.snapshot.updatedAt
    if (!force && now - task.lastProgressAt < TRANSFER_PROGRESS_INTERVAL_MS) return
    task.lastProgressAt = now
    this.dependencies.publish?.(task.ownerId, parseServerOpsTransferSnapshot(task.snapshot))
  }

  /** 取消时清理精确本地 temp 与恢复意图。 */
  private async finishCancelled(task: TransferTask): Promise<void> {
    const cleaned = await this.discardLease(task)
    if (cleaned) this.safeRecoveryRemove(task.snapshot.transferId)
    else this.safePersist(task, 'unknown')
    this.setStatus(task, 'failed', 'SERVER_OPS_TRANSFER_CANCELLED')
    if (!cleaned) this.setWarning(task, 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED')
  }

  /** active slot 释放后按 FIFO 启动等待任务。 */
  private drain(): void {
    while (this.active.size < SERVER_OPS_TRANSFER_ACTIVE_LIMIT && this.queue.length > 0) {
      const next = this.queue.shift()
      if (next) this.launch(next)
    }
  }

  /** 队列完全空闲时释放测试和关闭屏障。 */
  private resolveIdleIfNeeded(): void {
    if (this.active.size > 0 || this.queue.length > 0 || this.settling.size > 0) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  /** 获取当前可信连接身份并收敛底层错误。 */
  private requireIdentity(hostId: string): ServerOpsActiveConnectionIdentity {
    try { return this.dependencies.connections.getActiveIdentity(hostId) } catch { throw new Error('SERVER_OPS_CONNECTION_CHANGED') }
  }

  /** 在每个 await 边界阻止已取消任务继续产生副作用。 */
  private assertNotCancelled(task: TransferTask): void { if (task.cancelled) throw new Error('SERVER_OPS_TRANSFER_CANCELLED') }

  /** 同时验证取消、窗口存活与连接身份。 */
  private assertRunnable(task: TransferTask): void {
    this.assertNotCancelled(task)
    if (this.dependencies.isOwnerAlive && !this.dependencies.isOwnerAlive(task.ownerId)) throw new Error('SERVER_OPS_TRANSFER_OWNER_CLOSED')
    if (this.ownerGeneration(task.ownerId, task.ownerKey) !== task.ownerGeneration) throw new Error('SERVER_OPS_TRANSFER_OWNER_CLOSED')
    const current = this.requireIdentity(task.identity.hostId)
    if (current.connectionId !== task.identity.connectionId || current.generation !== task.identity.generation) throw new Error('SERVER_OPS_CONNECTION_CHANGED')
  }

  /** 返回窗口与页面命名空间当前代次。 */
  private ownerGeneration(ownerId: number, ownerKey: string): number { return this.ownerGenerations.get(ownerIdentity(ownerId, ownerKey)) ?? 0 }

  /** 首次调用立即关闭精确 SFTP owner，并复用已挂拒绝处理的 ACK Promise。 */
  private requestSftpCleanup(task: TransferTask): Promise<boolean> {
    if (task.sftpCleanup) return task.sftpCleanup
    let requested: Promise<void>
    try { requested = this.dependencies.connections.closeSftpOwner(task.sftpOwnerKey) } catch { requested = Promise.reject(new Error('SERVER_OPS_SFTP_OWNER_CLOSE_FAILED')) }
    task.sftpCleanup = requested.then(() => true, () => false)
    return task.sftpCleanup
  }

  /** 丢弃本地 lease，并以布尔值保留清理是否已确认。 */
  private async discardLease(task: TransferTask): Promise<boolean> {
    try { await task.lease.discard(); return true } catch { return false }
  }

  /** 追加结果审计；失败只转为公开 warning，不覆盖传输结果。 */
  private async appendResultAudit(base: Omit<ServerOpsAuditAppendInput, 'phase' | 'outcome'>, startedAt: number, outcome: 'success' | 'error' | 'unknown', errorCode?: string): Promise<boolean> {
    try { this.dependencies.audit.append({ ...base, phase: 'result', outcome, durationMs: Math.max(0, this.now() - startedAt), ...(errorCode ? { errorCode } : {}) }); return true } catch { return false }
  }

  /** 给真实终态附加审计写失败 warning。 */
  private setWarning(task: TransferTask, warning: NonNullable<ServerOpsTransferSnapshot['warning']>): void {
    task.snapshot = parseServerOpsTransferSnapshot({ ...task.snapshot, warning, updatedAt: this.now() })
    this.emit(task, true)
  }

  /** 恢复删除失败不能使后台任务产生未处理拒绝。 */
  private safeRecoveryRemove(transferId: string): void { try { this.dependencies.recovery.remove(transferId) } catch { /* 恢复清理失败不覆盖传输事实。 */ } }

  /** unknown 恢复落盘失败不能使状态机再次抛错。 */
  private safePersist(task: TransferTask, state: 'active' | 'unknown'): void { try { this.persist(task, state) } catch { /* 公开 unknown 仍保留在内存。 */ } }

  /** 终态历史保持有界，活动和排队任务永不被清除。 */
  private pruneHistory(): void {
    const terminal = [...this.tasks.values()].filter((task) => isTerminal(task.snapshot.status)).sort((left, right) => left.snapshot.updatedAt - right.snapshot.updatedAt)
    for (const task of terminal.slice(0, Math.max(0, terminal.length - TRANSFER_HISTORY_LIMIT))) this.tasks.delete(task.snapshot.transferId)
  }
}

/** 校验窗口 owner，避免空 owner 共享远程句柄。 */
function assertOwner(ownerId: number, ownerKey: string): void {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1 || !ownerKey || ownerKey.length > 256) throw new Error('SERVER_OPS_TRANSFER_OWNER_INVALID')
}

/** 判断传输状态是否已经终结。 */
function isTerminal(status: ServerOpsTransferSnapshot['status']): boolean { return status === 'succeeded' || status === 'failed' || status === 'unknown' || status === 'pending-check' }

/** 比较远端读取前后的稳定 stat 事实。 */
function sameStat(left: ServerOpsSftpStat, right: ServerOpsSftpStat): boolean { return left.kind === right.kind && left.size === right.size && left.mtime === right.mtime && left.mode === right.mode }

/** 远程路径只以 hash 进入审计 resourceId。 */
function hashRemotePath(path: string): string { return `sha256:${createHash('sha256').update(path).digest('hex')}` }

/** 判断错误是否表示写入结果未知，禁止自动重放。 */
function isUnknownOutcome(error: unknown): boolean {
  return error instanceof ServerOpsSftpRuntimeError && error.outcome === 'unknown'
    || error instanceof Error && error.message === 'SERVER_OPS_CONNECTION_CHANGED'
}

/** 将底层异常收敛为不含本地路径的稳定错误码。 */
function stableTransferError(error: unknown): string {
  if (error instanceof ServerOpsSftpRuntimeError && /^SERVER_OPS_[A-Z0-9_]+$/.test(error.code)) return error.code
  if (error instanceof Error && /^SERVER_OPS_[A-Z0-9_]+$/.test(error.message)) return error.message
  return 'SERVER_OPS_TRANSFER_FAILED'
}

/** 生成窗口与页面命名空间的内部代次键。 */
function ownerIdentity(ownerId: number, ownerKey: string): string { return `${ownerId}\0${ownerKey}` }

/** 校验磁盘恢复意图的精确 schema，并复用公开快照约束。 */
function isRecoveryIntent(value: unknown): value is ServerOpsTransferRecoveryIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = new Set(['version', 'transferId', 'hostId', 'direction', 'fileName', 'remotePath', 'totalBytes', 'transferredBytes', 'createdAt', 'updatedAt', 'state', 'localHash', 'remoteHash'])
  if (!Object.keys(record).every((key) => keys.has(key)) || record.version !== 1 || (record.state !== 'active' && record.state !== 'unknown')) return false
  const validHash = (hash: unknown): boolean => hash === undefined || typeof hash === 'string' && /^sha256:[a-f0-9]{1,64}$/.test(hash)
  if (!validHash(record.localHash) || !validHash(record.remoteHash)) return false
  try {
    parseServerOpsTransferSnapshot({
      transferId: record.transferId, hostId: record.hostId, direction: record.direction,
      fileName: record.fileName, remotePath: record.remotePath, status: 'pending-check',
      transferredBytes: record.transferredBytes, totalBytes: record.totalBytes,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
      errorCode: 'SERVER_OPS_TRANSFER_RESULT_UNKNOWN',
    })
    return true
  } catch { return false }
}
