import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { ServerOpsLocalFileLeaseRegistry } from './server-ops-local-file-leases'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 创建测试目录并登记自动清理。 */
async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'proma-local-lease-'))
  roots.push(root)
  return root
}

/** 创建可手动放行的异步测试闸门。 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** 创建只实现 registry 所需方法的测试文件句柄。 */
function createHandle(close: () => Promise<void> = async () => undefined): FileHandle {
  return {
    close,
    stat: async () => ({ isFile: () => true, size: 1, dev: 1, ino: 1 }),
  } as unknown as FileHandle
}

describe('服务器运维本地 fd lease', () => {
  test('上传选择后只返回 opaque lease，claim 必须匹配窗口 owner 且只能消费一次', async () => {
    const root = await createRoot()
    const source = join(root, 'source.bin')
    await writeFile(source, new Uint8Array([1, 2, 3]))
    const registry = new ServerOpsLocalFileLeaseRegistry({
      selectUpload: async () => source,
      selectDownload: async () => null,
      isOwnerAlive: () => true,
      uuid: () => 'lease-1',
    })
    const selected = await registry.selectUpload(7, 'window-7')
    expect(selected).toEqual({ leaseId: 'lease-1', fileName: 'source.bin', size: 3 })
    await expect(registry.claim('lease-1', 'upload', 8, 'window-7')).rejects.toThrow('SERVER_OPS_TRANSFER_LEASE_OWNER_MISMATCH')
    const lease = await registry.claim('lease-1', 'upload', 7, 'window-7')
    expect([...await lease.read(0, 65_536)]).toEqual([1, 2, 3])
    await expect(registry.claim('lease-1', 'upload', 7, 'window-7')).rejects.toThrow('SERVER_OPS_TRANSFER_LEASE_NOT_FOUND')
    await lease.close()
  })

  test('上传使用 O_NOFOLLOW，符号链接不会被打开', async () => {
    const root = await createRoot()
    const target = join(root, 'target.bin')
    const link = join(root, 'link.bin')
    await writeFile(target, 'secret')
    await symlink(target, link)
    const registry = new ServerOpsLocalFileLeaseRegistry({ selectUpload: async () => link, selectDownload: async () => null, isOwnerAlive: () => true })
    await expect(registry.selectUpload(1, 'window-1')).rejects.toThrow('SERVER_OPS_TRANSFER_LOCAL_FILE_INVALID')
  })

  test('下载写入独占 temp，fsync 后通过 hardlink no-clobber 发布', async () => {
    const root = await createRoot()
    const destination = join(root, 'download.bin')
    const registry = new ServerOpsLocalFileLeaseRegistry({ selectUpload: async () => null, selectDownload: async () => destination, isOwnerAlive: () => true, uuid: () => 'lease-download' })
    const selected = await registry.selectDownload(2, 'window-2', 'download.bin')
    expect(selected?.fileName).toBe('download.bin')
    const lease = await registry.claim('lease-download', 'download', 2, 'window-2')
    await lease.write(0, new Uint8Array([9, 8, 7]))
    await lease.fsync()
    await lease.publishNoClobber()
    await lease.close()
    expect([...await readFile(destination)]).toEqual([9, 8, 7])

    await writeFile(destination, 'existing')
    const second = new ServerOpsLocalFileLeaseRegistry({ selectUpload: async () => null, selectDownload: async () => destination, isOwnerAlive: () => true, uuid: () => 'lease-second' })
    await second.selectDownload(2, 'window-2', 'download.bin')
    const secondLease = await second.claim('lease-second', 'download', 2, 'window-2')
    await secondLease.write(0, new Uint8Array([1]))
    await secondLease.fsync()
    await expect(secondLease.publishNoClobber()).rejects.toThrow('SERVER_OPS_TRANSFER_DESTINATION_EXISTS')
    await secondLease.discard()
  })

  test('hardlink 已成功但 temp unlink 失败时返回已发布 warning', async () => {
    const root = await createRoot()
    const destination = join(root, 'published.bin')
    const registry = new ServerOpsLocalFileLeaseRegistry({
      selectUpload: async () => null, selectDownload: async () => destination, isOwnerAlive: () => true, uuid: () => 'lease-warning',
      unlink: async () => { throw Object.assign(new Error('unlink failed'), { code: 'EIO' }) },
    })
    await registry.selectDownload(2, 'window-2', 'published.bin')
    const lease = await registry.claim('lease-warning', 'download', 2, 'window-2')
    await lease.write(0, new Uint8Array([4, 5, 6]))
    await lease.fsync()
    expect(await lease.publishNoClobber()).toBe('SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED')
    expect([...await readFile(destination)]).toEqual([4, 5, 6])
  })

  test('temp 路径被替换后清理不会删除替换者文件', async () => {
    const root = await createRoot()
    const destination = join(root, 'replace.bin')
    const registry = new ServerOpsLocalFileLeaseRegistry({ selectUpload: async () => null, selectDownload: async () => destination, isOwnerAlive: () => true, uuid: () => 'lease-replace' })
    await registry.selectDownload(3, 'window-3', 'replace.bin')
    const tempName = (await readdir(root)).find((name) => name.endsWith('.proma-download'))
    expect(tempName).toBeTruthy()
    const tempPath = join(root, tempName!)
    await unlink(tempPath)
    await writeFile(tempPath, 'other-owner')
    await registry.release(3, 'window-3', 'lease-replace')
    expect(await readFile(tempPath, 'utf8')).toBe('other-owner')
  })

  test('关闭窗口清理未 claim 的 fd lease', async () => {
    const root = await createRoot()
    const source = join(root, 'source.bin')
    await writeFile(source, 'x')
    const registry = new ServerOpsLocalFileLeaseRegistry({ selectUpload: async () => source, selectDownload: async () => null, isOwnerAlive: () => true, uuid: () => 'lease-close' })
    await registry.selectUpload(3, 'window-3')
    await registry.closeOwner(3, 'window-3')
    await expect(registry.claim('lease-close', 'upload', 3, 'window-3')).rejects.toThrow('SERVER_OPS_TRANSFER_LEASE_NOT_FOUND')
  })

  test('确认前可释放单条选择且不影响同 owner 的其它 lease', async () => {
    const root = await createRoot()
    const source = join(root, 'source.bin')
    await writeFile(source, 'x')
    let id = 0
    const registry = new ServerOpsLocalFileLeaseRegistry({ selectUpload: async () => source, selectDownload: async () => null, isOwnerAlive: () => true, uuid: () => `lease-${++id}` })
    await registry.selectUpload(4, 'window-4')
    await registry.selectUpload(4, 'window-4')
    await registry.release(4, 'window-4', 'lease-1')
    await expect(registry.claim('lease-1', 'upload', 4, 'window-4')).rejects.toThrow('SERVER_OPS_TRANSFER_LEASE_NOT_FOUND')
    const remaining = await registry.claim('lease-2', 'upload', 4, 'window-4')
    await remaining.close()
  })

  test('系统对话框迟到返回时旧 owner generation 不签发 lease，新请求仍可复用 ownerKey', async () => {
    const root = await createRoot()
    const source = join(root, 'late.bin')
    await writeFile(source, 'late')
    let resolveSelection!: (path: string) => void
    const delayed = new Promise<string>((resolve) => { resolveSelection = resolve })
    let first = true
    const registry = new ServerOpsLocalFileLeaseRegistry({
      selectUpload: async () => { if (first) { first = false; return delayed }; return source },
      selectDownload: async () => null, isOwnerAlive: () => true,
    })
    const selecting = registry.selectUpload(5, 'window-5')
    await registry.closeOwner(5, 'window-5')
    resolveSelection(source)
    await expect(selecting).rejects.toThrow('SERVER_OPS_TRANSFER_OWNER_CLOSED')
    const next = await registry.selectUpload(5, 'window-5')
    expect(next?.fileName).toBe('late.bin')
    await registry.closeOwner(5, 'window-5')
  })

  test('closeOwner 与 dispose 都等待已经开始的 fd 关闭，重复 dispose 复用同一 Promise', async () => {
    const closeGate = createDeferred<void>()
    let closeCount = 0
    const registry = new ServerOpsLocalFileLeaseRegistry({
      selectUpload: async () => '/virtual/source.bin', selectDownload: async () => null, isOwnerAlive: () => true,
      uuid: () => 'lease-delayed-close',
      openFile: async () => createHandle(async () => { closeCount += 1; await closeGate.promise }),
    })
    await registry.selectUpload(6, 'window-6')

    const releasing = registry.release(6, 'window-6', 'lease-delayed-close')
    let ownerClosed = false
    const closingOwner = registry.closeOwner(6, 'window-6').then(() => { ownerClosed = true })
    const disposing = registry.dispose()
    expect(registry.dispose()).toBe(disposing)
    let disposed = false
    void disposing.then(() => { disposed = true })
    await Promise.resolve()
    expect(ownerClosed).toBe(false)
    expect(disposed).toBe(false)

    closeGate.resolve()
    await Promise.all([releasing, closingOwner, disposing])
    expect(closeCount).toBe(1)
    await expect(registry.claim('lease-delayed-close', 'upload', 6, 'window-6')).rejects.toThrow('SERVER_OPS_TRANSFER_OWNER_CLOSED')
  })

  test('closeOwner 与 dispose 都等待下载 temp unlink 完成', async () => {
    const root = await createRoot()
    const destination = join(root, 'delayed-unlink.bin')
    const unlinkGate = createDeferred<void>()
    let unlinkStarted = false
    const registry = new ServerOpsLocalFileLeaseRegistry({
      selectUpload: async () => null, selectDownload: async () => destination, isOwnerAlive: () => true,
      uuid: () => 'lease-delayed-unlink',
      unlink: async (path) => { unlinkStarted = true; await unlinkGate.promise; await unlink(path) },
    })
    await registry.selectDownload(7, 'window-7', 'delayed-unlink.bin')

    let ownerClosed = false
    const closingOwner = registry.closeOwner(7, 'window-7').then(() => { ownerClosed = true })
    while (!unlinkStarted) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const disposing = registry.dispose()
    let disposed = false
    void disposing.then(() => { disposed = true })
    await Promise.resolve()
    expect(ownerClosed).toBe(false)
    expect(disposed).toBe(false)

    unlinkGate.resolve()
    await Promise.all([closingOwner, disposing])
  })

  test('系统对话框返回后的在途 open 会被 closeOwner 等待并关闭', async () => {
    const openGate = createDeferred<FileHandle>()
    const closeGate = createDeferred<void>()
    let openStarted = false
    const registry = new ServerOpsLocalFileLeaseRegistry({
      selectUpload: async () => '/virtual/late-open.bin', selectDownload: async () => null, isOwnerAlive: () => true,
      openFile: async () => { openStarted = true; return openGate.promise },
    })
    const selecting = registry.selectUpload(8, 'window-8')
    while (!openStarted) await Promise.resolve()

    let ownerClosed = false
    const closingOwner = registry.closeOwner(8, 'window-8').then(() => { ownerClosed = true })
    openGate.resolve(createHandle(() => closeGate.promise))
    await Promise.resolve()
    expect(ownerClosed).toBe(false)
    closeGate.resolve()

    await closingOwner
    await expect(selecting).rejects.toThrow('SERVER_OPS_TRANSFER_OWNER_CLOSED')
  })

  test('dispose 不等待尚未返回的系统对话框，迟到结果不会再打开 fd', async () => {
    const selectionGate = createDeferred<string | null>()
    let openCount = 0
    const registry = new ServerOpsLocalFileLeaseRegistry({
      selectUpload: async () => selectionGate.promise, selectDownload: async () => null, isOwnerAlive: () => true,
      openFile: async () => { openCount += 1; return createHandle() },
    })
    const selecting = registry.selectUpload(9, 'window-9')
    await registry.dispose()
    selectionGate.resolve('/virtual/after-dispose.bin')

    await expect(selecting).rejects.toThrow('SERVER_OPS_TRANSFER_OWNER_CLOSED')
    expect(openCount).toBe(0)
  })
})
