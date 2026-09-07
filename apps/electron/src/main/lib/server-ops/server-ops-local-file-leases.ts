import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  SERVER_OPS_TRANSFER_CHUNK_LIMIT_BYTES,
  SERVER_OPS_TRANSFER_FILE_LIMIT_BYTES,
} from '@proma/shared'
import type { ServerOpsTransferDirection } from '@proma/shared'
import type { ServerOpsLocalFileSelection } from '@proma/shared'
import type { ServerOpsLocalFileLease } from './server-ops-file-transfer-service'

/** 未领取系统文件 lease 的有效期。 */
const LOCAL_FILE_LEASE_TTL_MS = 300_000
/** 单进程允许等待领取的系统文件 lease 上限。 */
const LOCAL_FILE_LEASE_LIMIT = 64

/** 系统选择器返回给 Renderer 的公开 opaque 结果。 */
/** 本地 fd lease registry 的系统选择器与生命周期依赖。 */
export interface ServerOpsLocalFileLeaseRegistryDependencies {
  selectUpload(ownerId: number): Promise<string | null>
  selectDownload(ownerId: number, suggestedName: string): Promise<string | null>
  isOwnerAlive(ownerId: number): boolean
  uuid?: () => string
  now?: () => number
  leaseTtlMs?: number
  /** 测试可注入 fd 打开时序；生产使用 node:fs open。 */
  openFile?: (path: string, flags: number, mode?: number) => Promise<FileHandle>
  /** 测试可注入 temp 清理故障；生产使用 node:fs unlink。 */
  unlink?: (path: string) => Promise<void>
}

/** temp 创建时绑定的本地文件身份。 */
interface LocalFileIdentity { dev: number; ino: number }

/** 尚未被 TransferService 领取的 owner-bound fd。 */
interface PendingLocalLease {
  leaseId: string
  ownerId: number
  ownerKey: string
  direction: ServerOpsTransferDirection
  fileName: string
  size: number
  handle: FileHandle
  destinationPath?: string
  temporaryPath?: string
  temporaryIdentity?: LocalFileIdentity
  unlinkPath: (path: string) => Promise<void>
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

/** 管理系统选择器创建的真实 fd lease，Renderer 只能看到 opaque ID。 */
export class ServerOpsLocalFileLeaseRegistry {
  private readonly pending = new Map<string, PendingLocalLease>()
  private readonly cleanupByEntry = new WeakMap<PendingLocalLease, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly ownerOperations = new Map<string, Set<Promise<unknown>>>()
  private readonly ownerGenerations = new Map<string, number>()
  private readonly uuid: () => string
  private readonly now: () => number
  private readonly leaseTtlMs: number
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(private readonly dependencies: ServerOpsLocalFileLeaseRegistryDependencies) {
    this.uuid = dependencies.uuid ?? randomUUID
    this.now = dependencies.now ?? Date.now
    this.leaseTtlMs = dependencies.leaseTtlMs ?? LOCAL_FILE_LEASE_TTL_MS
  }

  /** 通过系统选择器打开普通上传文件，并返回不含路径的 opaque lease。 */
  async selectUpload(ownerId: number, ownerKey: string): Promise<ServerOpsLocalFileSelection | null> {
    this.assertOwner(ownerId, ownerKey)
    const generation = this.ownerGeneration(ownerId, ownerKey)
    this.assertCapacity()
    const selectedPath = await this.dependencies.selectUpload(ownerId)
    if (!selectedPath) return null
    this.assertOwner(ownerId, ownerKey, generation)
    return this.trackOwnerOperation(ownerIdentity(ownerId, ownerKey), async () => {
      let handle: FileHandle | undefined
      try {
        handle = await (this.dependencies.openFile ?? open)(selectedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > SERVER_OPS_TRANSFER_FILE_LIMIT_BYTES) throw new Error('SERVER_OPS_TRANSFER_LOCAL_FILE_INVALID')
        this.assertOwner(ownerId, ownerKey, generation)
        return this.register({ ownerId, ownerKey, direction: 'upload', fileName: basename(selectedPath), size: stat.size, handle, unlinkPath: this.dependencies.unlink ?? unlink })
      } catch (error) {
        if (handle) await ignoreClose(handle)
        throw stableLocalSelectionError(error)
      }
    })
  }

  /** 通过系统保存选择器创建独占下载 temp fd，目标直到 publish 前都不会被覆盖。 */
  async selectDownload(ownerId: number, ownerKey: string, suggestedName: string): Promise<ServerOpsLocalFileSelection | null> {
    this.assertOwner(ownerId, ownerKey)
    const generation = this.ownerGeneration(ownerId, ownerKey)
    if (!suggestedName || suggestedName !== basename(suggestedName) || suggestedName.length > 1_024) throw new Error('SERVER_OPS_TRANSFER_FILE_NAME_INVALID')
    this.assertCapacity()
    const destinationPath = await this.dependencies.selectDownload(ownerId, suggestedName)
    if (!destinationPath) return null
    this.assertOwner(ownerId, ownerKey, generation)
    const temporaryPath = join(dirname(destinationPath), `.${basename(destinationPath)}.${this.uuid()}.proma-download`)
    return this.trackOwnerOperation(ownerIdentity(ownerId, ownerKey), async () => {
      let handle: FileHandle | undefined
      try {
        handle = await (this.dependencies.openFile ?? open)(temporaryPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        const stat = await handle.stat()
        this.assertOwner(ownerId, ownerKey, generation)
        return this.register({ ownerId, ownerKey, direction: 'download', fileName: basename(destinationPath), size: 0, handle, destinationPath, temporaryPath,
          temporaryIdentity: { dev: stat.dev, ino: stat.ino }, unlinkPath: this.dependencies.unlink ?? unlink })
      } catch (error) {
        if (handle) await ignoreClose(handle)
        await ignoreUnlink(temporaryPath, this.dependencies.unlink ?? unlink)
        throw stableLocalSelectionError(error)
      }
    })
  }

  /** 以精确 owner 和方向领取 fd；成功后 leaseId 立即失效。 */
  async claim(leaseId: string, direction: ServerOpsTransferDirection, ownerId: number, ownerKey: string): Promise<ServerOpsLocalFileLease> {
    this.assertOwner(ownerId, ownerKey)
    const entry = this.pending.get(leaseId)
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) await this.removePending(entry)
      throw new Error('SERVER_OPS_TRANSFER_LEASE_NOT_FOUND')
    }
    if (entry.ownerId !== ownerId || entry.ownerKey !== ownerKey) throw new Error('SERVER_OPS_TRANSFER_LEASE_OWNER_MISMATCH')
    if (entry.direction !== direction) throw new Error('SERVER_OPS_TRANSFER_LEASE_DIRECTION_MISMATCH')
    this.pending.delete(leaseId)
    clearTimeout(entry.timer)
    return new OwnedLocalFileLease(entry)
  }

  /** 释放尚未 claim 的精确选择；不存在时保持幂等。 */
  async release(ownerId: number, ownerKey: string, leaseId: string): Promise<void> {
    this.assertOwner(ownerId, ownerKey)
    const entry = this.pending.get(leaseId)
    if (!entry) return
    if (entry.ownerId !== ownerId || entry.ownerKey !== ownerKey) throw new Error('SERVER_OPS_TRANSFER_LEASE_OWNER_MISMATCH')
    await this.removePending(entry)
  }

  /** 窗口关闭时释放其尚未领取的全部 fd 和下载 temp。 */
  async closeOwner(ownerId: number, ownerKey: string): Promise<void> {
    const identity = ownerIdentity(ownerId, ownerKey)
    this.ownerGenerations.set(identity, this.ownerGeneration(ownerId, ownerKey) + 1)
    const owned = [...this.pending.values()].filter((entry) => entry.ownerId === ownerId && entry.ownerKey === ownerKey)
    await Promise.all(owned.map((entry) => this.removePending(entry)))
    await this.waitForOwnerOperations(identity)
  }

  /** 应用退出时释放所有未领取 lease。 */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.disposePromise = this.disposeAll()
    return this.disposePromise
  }

  /** 登记已打开 fd 并安排过期清理。 */
  private register(input: Omit<PendingLocalLease, 'leaseId' | 'expiresAt' | 'timer'>): ServerOpsLocalFileSelection {
    this.assertCapacity()
    const leaseId = this.uuid()
    if (this.pending.has(leaseId)) throw new Error('SERVER_OPS_TRANSFER_LEASE_CONFLICT')
    const expiresAt = this.now() + this.leaseTtlMs
    const timer = setTimeout(() => { const entry = this.pending.get(leaseId); if (entry) void this.removePending(entry) }, this.leaseTtlMs)
    timer.unref?.()
    this.pending.set(leaseId, { ...input, leaseId, expiresAt, timer })
    return { leaseId, fileName: input.fileName, size: input.size }
  }

  /** 删除 pending 记录并关闭其 fd/temp。 */
  private removePending(entry: PendingLocalLease): Promise<void> {
    const existing = this.cleanupByEntry.get(entry)
    if (existing) return existing
    if (this.pending.get(entry.leaseId) !== entry) return Promise.resolve()
    this.pending.delete(entry.leaseId)
    clearTimeout(entry.timer)
    const cleanup = this.trackOwnerOperation(ownerIdentity(entry.ownerId, entry.ownerKey), async () => {
      await ignoreClose(entry.handle)
      if (entry.temporaryPath && entry.temporaryIdentity) await removeOwnedTemp(entry.temporaryPath, entry.temporaryIdentity, entry.unlinkPath)
    })
    this.cleanupByEntry.set(entry, cleanup)
    return cleanup
  }

  /** 释放当前 pending，并等待 dispose 前已经进入 fd 生命周期的操作。 */
  private async disposeAll(): Promise<void> {
    await Promise.all([...this.pending.values()].map((entry) => this.removePending(entry)))
    await this.waitForOperations()
  }

  /** 将取得 fd 后的打开或清理操作登记到全局与 owner 屏障。 */
  private trackOwnerOperation<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const ownerSet = this.ownerOperations.get(identity) ?? new Set<Promise<unknown>>()
    this.ownerOperations.set(identity, ownerSet)
    const tracked = operation().finally(() => {
      this.operations.delete(tracked)
      ownerSet.delete(tracked)
      if (ownerSet.size === 0) this.ownerOperations.delete(identity)
    })
    this.operations.add(tracked)
    ownerSet.add(tracked)
    return tracked
  }

  /** 等待 owner 当前已登记操作全部收口。 */
  private async waitForOwnerOperations(identity: string): Promise<void> {
    while (this.ownerOperations.has(identity)) await Promise.allSettled([...(this.ownerOperations.get(identity) ?? [])])
  }

  /** 等待全局当前已登记操作全部收口。 */
  private async waitForOperations(): Promise<void> {
    while (this.operations.size > 0) await Promise.allSettled([...this.operations])
  }

  /** 校验窗口与 ownerKey 当前仍有效。 */
  private assertOwner(ownerId: number, ownerKey: string, expectedGeneration?: number): void {
    if (this.disposed) throw new Error('SERVER_OPS_TRANSFER_OWNER_CLOSED')
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || !ownerKey || ownerKey.length > 256) throw new Error('SERVER_OPS_TRANSFER_OWNER_INVALID')
    if (!this.dependencies.isOwnerAlive(ownerId)) throw new Error('SERVER_OPS_TRANSFER_OWNER_CLOSED')
    if (expectedGeneration !== undefined && this.ownerGeneration(ownerId, ownerKey) !== expectedGeneration) throw new Error('SERVER_OPS_TRANSFER_OWNER_CLOSED')
  }

  /** 返回同窗口同命名空间当前页面代次。 */
  private ownerGeneration(ownerId: number, ownerKey: string): number { return this.ownerGenerations.get(ownerIdentity(ownerId, ownerKey)) ?? 0 }

  /** 阻止系统选择器积累无界打开 fd。 */
  private assertCapacity(): void { if (this.pending.size >= LOCAL_FILE_LEASE_LIMIT) throw new Error('SERVER_OPS_TRANSFER_LEASE_CAPACITY_EXCEEDED') }
}

/** 已由 TransferService 独占的本地 fd lease。 */
class OwnedLocalFileLease implements ServerOpsLocalFileLease {
  readonly direction: ServerOpsTransferDirection
  readonly fileName: string
  readonly size: number
  private closed = false
  private position = 0
  private synced = false
  private published = false

  constructor(private readonly entry: PendingLocalLease) {
    this.direction = entry.direction
    this.fileName = entry.fileName
    this.size = entry.size
  }

  /** 从上传 fd 的精确顺序位置读取一个有界 chunk。 */
  async read(position: number, length: number): Promise<Uint8Array> {
    this.assertDirection('upload')
    assertChunk(position, length, this.position)
    const buffer = Buffer.alloc(length)
    const result = await this.entry.handle.read(buffer, 0, length, position)
    this.position += result.bytesRead
    return new Uint8Array(buffer.subarray(0, result.bytesRead))
  }

  /** 向下载 temp fd 的精确顺序位置写一个有界 chunk。 */
  async write(position: number, data: Uint8Array): Promise<void> {
    this.assertDirection('download')
    assertChunk(position, data.byteLength, this.position)
    const result = await this.entry.handle.write(Buffer.from(data), 0, data.byteLength, position)
    if (result.bytesWritten !== data.byteLength) throw new Error('SERVER_OPS_TRANSFER_LOCAL_WRITE_FAILED')
    this.position += result.bytesWritten
    this.synced = false
  }

  /** 读取当前 fd 大小，上传可检测选择后的替换或截断。 */
  async fstat(): Promise<{ size: number }> { const stat = await this.entry.handle.stat(); return { size: stat.size } }

  /** 同步下载 temp fd 内容。 */
  async fsync(): Promise<void> { this.assertDirection('download'); await this.entry.handle.sync(); this.synced = true }

  /** 从当前 fd 分块重读并计算实际内容 hash。 */
  async hash(): Promise<string> {
    if (this.closed) throw new Error('SERVER_OPS_TRANSFER_LEASE_CLOSED')
    const hash = createHash('sha256')
    let position = 0
    while (true) {
      const buffer = Buffer.alloc(SERVER_OPS_TRANSFER_CHUNK_LIMIT_BYTES)
      const result = await this.entry.handle.read(buffer, 0, buffer.byteLength, position)
      if (result.bytesRead === 0) break
      hash.update(buffer.subarray(0, result.bytesRead))
      position += result.bytesRead
    }
    return `sha256:${hash.digest('hex')}`
  }

  /** 关闭 temp fd 后通过 hardlink 发布，目标存在时绝不覆盖。 */
  async publishNoClobber(): Promise<'published' | 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED'> {
    this.assertDirection('download')
    if (!this.synced || !this.entry.temporaryPath || !this.entry.temporaryIdentity || !this.entry.destinationPath) throw new Error('SERVER_OPS_TRANSFER_LOCAL_SYNC_REQUIRED')
    await this.close()
    await assertPathIdentity(this.entry.temporaryPath, this.entry.temporaryIdentity)
    try { await link(this.entry.temporaryPath, this.entry.destinationPath) } catch (error) {
      if (systemCode(error) === 'EEXIST') throw new Error('SERVER_OPS_TRANSFER_DESTINATION_EXISTS')
      throw new Error('SERVER_OPS_TRANSFER_LOCAL_PUBLISH_FAILED')
    }
    this.published = true
    const removed = await removeOwnedTemp(this.entry.temporaryPath, this.entry.temporaryIdentity, this.entry.unlinkPath)
    return removed ? 'published' : 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED'
  }

  /** 丢弃下载 temp；上传 lease 只需关闭 fd。 */
  async discard(): Promise<void> {
    await this.close()
    if (this.entry.temporaryPath && this.entry.temporaryIdentity && !this.published) {
      await removeOwnedTemp(this.entry.temporaryPath, this.entry.temporaryIdentity, this.entry.unlinkPath)
    }
  }

  /** 幂等关闭本地 fd。 */
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.entry.handle.close() }

  /** 阻止错误方向或已关闭 lease 使用 fd。 */
  private assertDirection(expected: ServerOpsTransferDirection): void {
    if (this.closed) throw new Error('SERVER_OPS_TRANSFER_LEASE_CLOSED')
    if (this.direction !== expected) throw new Error('SERVER_OPS_TRANSFER_LEASE_DIRECTION_MISMATCH')
  }
}

/** 校验 chunk 上限与顺序位置。 */
function assertChunk(position: number, length: number, expectedPosition: number): void {
  if (!Number.isSafeInteger(position) || position !== expectedPosition || !Number.isSafeInteger(length) || length < 1 || length > SERVER_OPS_TRANSFER_CHUNK_LIMIT_BYTES) throw new Error('SERVER_OPS_TRANSFER_CHUNK_INVALID')
}

/** 生成窗口与页面命名空间的内部代次键。 */
function ownerIdentity(ownerId: number, ownerKey: string): string { return `${ownerId}\0${ownerKey}` }

/** 将系统选择与打开失败收敛为稳定错误码。 */
function stableLocalSelectionError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith('SERVER_OPS_')) return error
  return new Error('SERVER_OPS_TRANSFER_LOCAL_FILE_INVALID')
}

/** 提取 Node 系统错误码。 */
function systemCode(error: unknown): string | undefined { return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined }

/** 清理 fd 时忽略重复关闭等次要错误。 */
async function ignoreClose(handle: FileHandle): Promise<void> { try { await handle.close() } catch { /* 清理路径保持幂等。 */ } }
/** 清理本服务创建的独占 temp 时忽略缺失。 */
async function ignoreUnlink(path: string, unlinkPath: (path: string) => Promise<void>): Promise<void> { try { await unlinkPath(path) } catch { /* temp 可能从未创建或已发布。 */ } }

/** 复核路径仍指向本服务创建的 inode。 */
async function assertPathIdentity(path: string, expected: LocalFileIdentity): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>
  try { stat = await lstat(path) } catch { throw new Error('SERVER_OPS_TRANSFER_TEMP_CHANGED') }
  if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error('SERVER_OPS_TRANSFER_TEMP_CHANGED')
}

/** 只删除身份仍匹配的 temp；清理失败返回 false，不误删替换者。 */
async function removeOwnedTemp(path: string, expected: LocalFileIdentity, unlinkPath: (path: string) => Promise<void>): Promise<boolean> {
  try { await assertPathIdentity(path, expected) } catch { return false }
  try { await unlinkPath(path); return true } catch { return false }
}
