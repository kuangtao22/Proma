import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ServerOpsSftpCall } from './server-ops-runtime-client'
import { ServerOpsSftpRuntimeError } from '../../../utility/server-ops/server-ops-sftp-runtime'
import type { ServerOpsSftpResult } from '../../../utility/server-ops/server-ops-sftp-runtime'
import {
  ServerOpsFileTransferService,
  ServerOpsSafeFileTransferRecoveryStore,
  type ServerOpsFileTransferServiceDependencies,
  type ServerOpsLocalFileLease,
  type ServerOpsTransferRecoveryIntent,
} from './server-ops-file-transfer-service'

/** 等待服务将后台队列处理到稳定状态。 */
async function settle(service: ServerOpsFileTransferService): Promise<void> {
  await service.whenIdle()
}

/** 创建可观察的本地 fd lease，数据始终只经分块接口流动。 */
function createLease(direction: 'upload' | 'download', initial = new Uint8Array()): ServerOpsLocalFileLease & { output: number[]; calls: string[] } {
  const calls: string[] = []
  const output: number[] = []
  return {
    direction, fileName: '公开文件.bin', size: initial.byteLength, output, calls,
    read: async (position, length) => { calls.push(`read:${position}:${length}`); return initial.slice(position, position + length) },
    write: async (position, data) => { calls.push(`write:${position}:${data.byteLength}`); output.splice(position, data.byteLength, ...Array.from(data)) },
    fstat: async () => ({ size: direction === 'upload' ? initial.byteLength : output.length }),
    fsync: async () => { calls.push('fsync') },
    hash: async () => `sha256:${createHash('sha256').update(direction === 'upload' ? initial : new Uint8Array(output)).digest('hex')}`,
    publishNoClobber: async () => { calls.push('publish'); return 'published' },
    discard: async () => { calls.push('discard') },
    close: async () => { calls.push('close') },
  }
}

/** 创建可手动放行的异步测试闸门。 */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** 创建内存依赖并记录 SFTP、审计、恢复与 owner 清理顺序。 */
function createFixture(options: { upload?: Uint8Array; remote?: Uint8Array; gate?: Promise<void>; recovered?: ServerOpsTransferRecoveryIntent[] } = {}) {
  const upload = options.upload ?? new Uint8Array([1, 2, 3])
  const remote = options.remote ?? upload
  const uploadLease = createLease('upload', new Uint8Array(upload))
  const downloadLease = createLease('download')
  const calls: string[] = []
  const intents = new Map<string, ServerOpsTransferRecoveryIntent>()
  for (const intent of options.recovered ?? []) intents.set(intent.transferId, intent)
  let readPosition = 0
  const dependencies: ServerOpsFileTransferServiceDependencies = {
    connections: {
      getActiveIdentity: (hostId) => ({ hostId, connectionId: 'connection-1', generation: 1 }),
      sftp: async (input: ServerOpsSftpCall): Promise<ServerOpsSftpResult> => {
        calls.push(input.type)
        if (options.gate && (input.type === 'open-write' || input.type === 'open-read')) await options.gate
        if (input.type === 'open-write') return { type: 'open-write', requestId: 'r', result: { handleId: 'write-1', temporaryPath: '/srv/file.bin.tmp' } }
        if (input.type === 'write' || input.type === 'close' || input.type === 'publish-temp') return { type: input.type, requestId: 'r', result: { ok: true } }
        if (input.type === 'open-read') { readPosition = 0; return { type: 'open-read', requestId: 'r', result: { handleId: 'read-1', stat: { kind: 'file', size: remote.byteLength, mtime: 1, mode: 0o100600 } } } }
        if (input.type === 'read') {
          const data = remote.slice(readPosition, readPosition + input.input.length)
          const position = readPosition
          readPosition += data.byteLength
          return { type: 'read', requestId: 'r', result: { data, position, eof: readPosition >= remote.byteLength } }
        }
        if (input.type === 'stat') return { type: 'stat', requestId: 'r', result: { kind: 'file', size: remote.byteLength, mtime: 1, mode: 0o100600 } }
        throw new Error(`unexpected:${input.type}`)
      },
      closeSftpOwner: async (ownerKey) => { calls.push(`close-owner:${ownerKey}`) },
    },
    leases: { claim: async (_leaseId, direction, _ownerId, _ownerKey) => direction === 'upload' ? uploadLease : downloadLease },
    isOwnerAlive: () => true,
    audit: {
      prepareForWrites: async () => { calls.push('audit-prepare') },
      append: (input) => { calls.push(`audit:${input.operation}:${input.phase}:${input.outcome}`) },
    },
    recovery: {
      load: () => [...intents.values()],
      save: (intent) => { intents.set(intent.transferId, intent) },
      remove: (transferId) => { intents.delete(transferId) },
    },
    publish: (_ownerId, snapshot) => { calls.push(`progress:${snapshot.status}:${snapshot.transferredBytes}`) },
    uuid: (() => { let id = 0; return () => `transfer-${++id}` })(),
    now: (() => { let now = 100; return () => now += 100 })(),
  }
  return { service: new ServerOpsFileTransferService(dependencies), dependencies, calls, intents, uploadLease, downloadLease }
}

describe('服务器运维文件传输服务', () => {
  test('safe-file 恢复 store 每个 transfer 独立落盘且不保存本地能力', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'proma-transfer-recovery-'))
    try {
      const store = new ServerOpsSafeFileTransferRecoveryStore(configDir)
      const intent: ServerOpsTransferRecoveryIntent = {
        version: 1, transferId: 'transfer-safe', hostId: 'host-1', direction: 'upload', fileName: 'safe.bin', remotePath: '/srv/safe.bin',
        totalBytes: 3, transferredBytes: 1, createdAt: 1, updatedAt: 2, state: 'active', localHash: 'sha256:abc',
      }
      store.save(intent)
      const files = await readdir(join(configDir, 'server-ops', 'transfer-recovery'))
      expect(files).toEqual(['transfer-safe.json'])
      const raw = await readFile(join(configDir, 'server-ops', 'transfer-recovery', files[0]!), 'utf8')
      expect(raw).not.toContain('leaseId')
      expect(raw).not.toContain('localPath')
      expect(store.load()).toEqual([intent])
      store.remove(intent.transferId)
      expect(store.load()).toEqual([])
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('上传通过独占远端 temp 分块写入、读回 hash 后 no-clobber 发布', async () => {
    const data = new Uint8Array(65_537).fill(7)
    const fixture = createFixture({ upload: data, remote: data })
    const started = await fixture.service.start(7, 'window-7', { direction: 'upload', hostId: 'host-1', remotePath: '/srv/file.bin', leaseId: 'lease-1' })
    expect(started.status).toBe('running')
    await settle(fixture.service)
    expect(fixture.calls.filter((call) => call === 'write')).toHaveLength(2)
    expect(fixture.calls).toContain('publish-temp')
    expect(fixture.calls.indexOf('audit-prepare')).toBeLessThan(fixture.calls.indexOf('open-write'))
    expect(fixture.intents.size).toBe(0)
    expect(fixture.service.list(7, 'window-7', { hostId: 'host-1' })[0]?.status).toBe('succeeded')
  })

  test('下载校验远端身份和本地 fstat，fsync 后 no-clobber 发布', async () => {
    const data = new Uint8Array([9, 8, 7, 6])
    const fixture = createFixture({ remote: data })
    await fixture.service.start(8, 'window-8', { direction: 'download', hostId: 'host-1', remotePath: '/srv/下载.bin', leaseId: 'lease-2' })
    await settle(fixture.service)
    expect(fixture.downloadLease.output).toEqual([...data])
    expect(fixture.downloadLease.calls).toEqual(['write:0:4', 'fsync', 'publish', 'close'])
    expect(fixture.calls.filter((call) => call === 'stat')).toHaveLength(1)
    expect(fixture.service.list(8, 'window-8', {})[0]?.status).toBe('succeeded')
  })

  test('下载落盘 fd hash 不匹配时拒绝发布', async () => {
    const fixture = createFixture({ remote: new Uint8Array([1, 2, 3]) })
    fixture.downloadLease.hash = async () => 'sha256:deadbeef'
    await fixture.service.start(8, 'window-8', { direction: 'download', hostId: 'host-1', remotePath: '/srv/bad.bin', leaseId: 'lease-bad' })
    await settle(fixture.service)
    expect(fixture.downloadLease.calls).not.toContain('publish')
    expect(fixture.service.list(8, 'window-8', {})[0]).toMatchObject({ status: 'failed', errorCode: 'SERVER_OPS_TRANSFER_HASH_MISMATCH' })
  })

  test('下载本地 no-clobber 冲突是已知失败而非 unknown', async () => {
    const fixture = createFixture({ remote: new Uint8Array([1]) })
    fixture.downloadLease.publishNoClobber = async () => { throw new Error('SERVER_OPS_TRANSFER_DESTINATION_EXISTS') }
    await fixture.service.start(8, 'window-8', { direction: 'download', hostId: 'host-1', remotePath: '/srv/existing.bin', leaseId: 'lease-existing' })
    await settle(fixture.service)
    expect(fixture.service.list(8, 'window-8', {})[0]).toMatchObject({ status: 'failed', errorCode: 'SERVER_OPS_TRANSFER_DESTINATION_EXISTS' })
  })

  test('结果审计失败保留成功事实并附加 warning', async () => {
    const fixture = createFixture()
    fixture.dependencies.audit.append = (input) => {
      if (input.phase === 'result') throw new Error('disk full')
      fixture.calls.push(`audit:${input.phase}`)
    }
    await fixture.service.start(8, 'window-8', { direction: 'upload', hostId: 'host-1', remotePath: '/srv/a.bin', leaseId: 'lease-audit' })
    await settle(fixture.service)
    expect(fixture.service.list(8, 'window-8', {})[0]).toMatchObject({ status: 'succeeded', warning: 'SERVER_OPS_AUDIT_WRITE_FAILED' })
  })

  test('下载已发布但 temp 清理失败时保留成功并公开 cleanup warning', async () => {
    const fixture = createFixture({ remote: new Uint8Array([1]) })
    fixture.downloadLease.publishNoClobber = async () => 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED'
    await fixture.service.start(8, 'window-8', { direction: 'download', hostId: 'host-1', remotePath: '/srv/warning.bin', leaseId: 'lease-warning' })
    await settle(fixture.service)
    expect(fixture.service.list(8, 'window-8', {})[0]).toMatchObject({ status: 'succeeded', warning: 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED' })
  })

  test('远端 open-write 结果未知时不重放并保留恢复意图', async () => {
    const fixture = createFixture()
    fixture.dependencies.connections.sftp = async () => { throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_WRITE_FAILED', 'unknown') }
    await fixture.service.start(8, 'window-8', { direction: 'upload', hostId: 'host-1', remotePath: '/srv/a.bin', leaseId: 'lease-unknown' })
    await settle(fixture.service)
    expect(fixture.service.list(8, 'window-8', {})[0]).toMatchObject({ status: 'unknown', errorCode: 'SERVER_OPS_TRANSFER_RESULT_UNKNOWN' })
    expect(fixture.intents.get('transfer-1')?.state).toBe('unknown')
  })

  test('全局只运行两项且队列最多二十项，第 23 项稳定拒绝', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fixture = createFixture({ gate })
    for (let index = 0; index < 22; index += 1) {
      await fixture.service.start(9, 'window-9', { direction: 'upload', hostId: 'host-1', remotePath: `/srv/${index}.bin`, leaseId: `lease-${index}` })
    }
    expect(fixture.service.list(9, 'window-9', {}).filter((item) => item.status === 'running')).toHaveLength(2)
    expect(fixture.service.list(9, 'window-9', {}).filter((item) => item.status === 'queued')).toHaveLength(20)
    await expect(fixture.service.start(9, 'window-9', { direction: 'upload', hostId: 'host-1', remotePath: '/srv/overflow.bin', leaseId: 'lease-overflow' })).rejects.toThrow('SERVER_OPS_TRANSFER_CAPACITY_EXCEEDED')
    release()
    await settle(fixture.service)
  })

  test('窗口关闭等待 active SFTP 被精确 owner 中断并清理本地 lease', async () => {
    const lease = createLease('upload', new Uint8Array([1]))
    let rejectOpen!: (error: Error) => void
    const blocked = new Promise<ServerOpsSftpResult>((_resolve, reject) => { rejectOpen = reject })
    const closedOwners: string[] = []
    const service = new ServerOpsFileTransferService({
      connections: {
        getActiveIdentity: (hostId) => ({ hostId, connectionId: 'connection-1', generation: 1 }),
        sftp: async () => blocked,
        closeSftpOwner: async (ownerKey) => { closedOwners.push(ownerKey); rejectOpen(new Error('SERVER_OPS_SFTP_OWNER_CLOSED')) },
      },
      leases: { claim: async () => lease }, isOwnerAlive: () => true,
      audit: { append: () => undefined }, recovery: { load: () => [], save: () => undefined, remove: () => undefined },
      uuid: (() => { let id = 0; return () => `cancel-${++id}` })(), now: Date.now,
    })
    await service.start(11, 'window-11', { direction: 'upload', hostId: 'host-1', remotePath: '/srv/a.bin', leaseId: 'lease-1' })
    await service.closeOwner(11, 'window-11')
    expect(service.list(11, 'window-11', {})[0]?.status).toBe('failed')
    expect(lease.calls).toContain('discard')
    expect(closedOwners).toContain('window-11:transfer:cancel-1')
  })

  test('queued 重复取消等待同一清理且不会误删后续任务，whenIdle 等待清理完成', async () => {
    const transferGate = createDeferred()
    const discardGate = createDeferred()
    const fixture = createFixture({ gate: transferGate.promise })
    const leases = Array.from({ length: 4 }, () => createLease('upload', new Uint8Array([1, 2, 3])))
    leases[2]!.discard = async () => { leases[2]!.calls.push('discard'); await discardGate.promise }
    fixture.dependencies.leases.claim = async (leaseId) => leases[Number(leaseId.slice('lease-'.length))]!
    for (let index = 0; index < 4; index += 1) {
      await fixture.service.start(13, 'window-13', { direction: 'upload', hostId: 'host-1', remotePath: `/srv/${index}.bin`, leaseId: `lease-${index}` })
    }
    const queued = fixture.service.list(13, 'window-13', {}).filter((task) => task.status === 'queued')
    const cancelledId = queued[0]!.transferId
    const remainingId = queued[1]!.transferId

    const firstCancel = fixture.service.cancel(13, 'window-13', { hostId: 'host-1', transferId: cancelledId })
    const secondCancel = fixture.service.cancel(13, 'window-13', { hostId: 'host-1', transferId: cancelledId })
    transferGate.resolve()
    const idle = fixture.service.whenIdle()
    let idleResolved = false
    void idle.then(() => { idleResolved = true })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(idleResolved).toBe(false)

    discardGate.resolve()
    await Promise.all([firstCancel, secondCancel, idle])
    expect(leases[2]!.calls.filter((call) => call === 'discard')).toHaveLength(1)
    expect(fixture.service.list(13, 'window-13', {}).find((task) => task.transferId === remainingId)?.status).toBe('succeeded')
  })

  test('dispose 复用同一完成 Promise', async () => {
    const fixture = createFixture()
    await fixture.service.whenIdle()
    const disposing = fixture.service.dispose()
    expect(fixture.service.dispose()).toBe(disposing)
    await disposing
  })

  test('远端 owner 清理 ACK 失败时保留原结果、恢复意图和清理 warning', async () => {
    const fixture = createFixture()
    let closeCount = 0
    fixture.dependencies.connections.closeSftpOwner = async () => { closeCount += 1; throw new Error('close ack failed') }
    await fixture.service.start(14, 'window-14', { direction: 'upload', hostId: 'host-1', remotePath: '/srv/cleanup.bin', leaseId: 'lease-cleanup' })
    await fixture.service.whenIdle()

    expect(fixture.service.list(14, 'window-14', {})[0]).toMatchObject({
      status: 'succeeded', warning: 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED',
    })
    expect(fixture.intents.get('transfer-1')?.state).toBe('unknown')
    expect(closeCount).toBe(1)
  })

  test('claim 迟到时旧 owner generation 关闭 lease 且不入队', async () => {
    const lease = createLease('upload', new Uint8Array([1]))
    let resolveClaim!: (lease: ServerOpsLocalFileLease) => void
    const claim = new Promise<ServerOpsLocalFileLease>((resolve) => { resolveClaim = resolve })
    const fixture = createFixture()
    fixture.dependencies.leases.claim = async () => claim
    const starting = fixture.service.start(12, 'window-12', { direction: 'upload', hostId: 'host-1', remotePath: '/srv/late.bin', leaseId: 'lease-late' })
    await fixture.service.closeOwner(12, 'window-12')
    resolveClaim(lease)
    await expect(starting).rejects.toThrow('SERVER_OPS_TRANSFER_OWNER_CLOSED')
    expect(lease.calls).toContain('close')
    expect(fixture.service.list(12, 'window-12', {})).toEqual([])
  })

  test('重启只公开待检查意图，窗口清理只关闭精确 transfer owner', async () => {
    const recovered: ServerOpsTransferRecoveryIntent = {
      version: 1, transferId: 'old-transfer', hostId: 'host-1', direction: 'upload', fileName: 'safe.bin', remotePath: '/srv/safe.bin',
      totalBytes: 10, transferredBytes: 5, createdAt: 1, updatedAt: 2, state: 'unknown',
    }
    const fixture = createFixture({ recovered: [recovered] })
    const restored = fixture.service.list(10, 'window-10', {})
    expect(restored).toEqual([{
      transferId: recovered.transferId, hostId: recovered.hostId, direction: recovered.direction,
      fileName: recovered.fileName, remotePath: recovered.remotePath, totalBytes: recovered.totalBytes,
      transferredBytes: recovered.transferredBytes, createdAt: recovered.createdAt, updatedAt: recovered.updatedAt,
      status: 'pending-check', errorCode: 'SERVER_OPS_TRANSFER_RESULT_UNKNOWN',
    }])
    expect(JSON.stringify(restored)).not.toContain('/Users/')
  })
})
