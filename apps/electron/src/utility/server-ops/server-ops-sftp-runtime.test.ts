import { describe, expect, test } from 'bun:test'
import {
  parseServerOpsSftpRequest,
  parseServerOpsSftpResult,
  ServerOpsSftpRuntime,
  ServerOpsSftpRuntimeError,
  type ServerOpsSftpAdapter,
  type ServerOpsSftpRequest,
} from './server-ops-sftp-runtime'
import { startServerOpsSftpFixture } from './server-ops-sftp-fixture'

describe('Server Ops SFTP runtime', () => {
  test('内部协议严格解析 operation、deadline 与二进制块', () => {
    const request: ServerOpsSftpRequest = { type: 'write', requestId: 'request-1', hostId: 'host-1', connectionId: 'connection-1', input: { ownerKey: 'window:1:page-1', deadlineAt: 2_000, handleId: 'handle-1', position: 0, data: new Uint8Array([1, 2]) } }
    expect(parseServerOpsSftpRequest(request)).toEqual(request)
    expect(parseServerOpsSftpResult({ type: 'write', requestId: 'request-1', result: { ok: true } })).toEqual({ type: 'write', requestId: 'request-1', result: { ok: true } })
    expect(() => parseServerOpsSftpRequest({ ...request, extra: true })).toThrow('SERVER_OPS_SFTP_PROTOCOL_INVALID')
    expect(() => parseServerOpsSftpRequest({ ...request, input: { ...request.input, data: new Uint8Array(65_537) } })).toThrow()
  })

  test('目录按 owner 隔离 cursor，并按 200 项分页而不使用 path 全量读取', async () => {
    const adapter = createMemoryAdapter(Array.from({ length: 205 }, (_, index) => ({ path: `/big/file-${index}`, data: Buffer.from(`${index}`) })))
    const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', adapter, createId: createIds() })
    const first = await runtime.listDirectory({ ownerKey: 'owner-1', path: '/big', deadlineAt: Date.now() + 2_000 })
    expect(first.entries).toHaveLength(200)
    expect(first.cursorId).toBeDefined()
    await expect(runtime.listDirectory({ ownerKey: 'owner-2', path: '/big', cursorId: first.cursorId, deadlineAt: Date.now() + 2_000 })).rejects.toThrow('SERVER_OPS_SFTP_OWNER_MISMATCH')
    const second = await runtime.listDirectory({ ownerKey: 'owner-1', path: '/big', cursorId: first.cursorId, deadlineAt: Date.now() + 2_000 })
    expect(second.entries).toHaveLength(5)
    expect(second.cursorId).toBeUndefined()
    expect(adapter.readdirPathCalls).toBe(0)
  })

  test('目录过滤保留名称，避免条目归一化到当前或父目录', async () => {
    const adapter = createMemoryAdapter([])
    let firstRead = true
    adapter.readDirectory = async () => {
      if (!firstRead) return []
      firstRead = false
      return [
        { name: '.', kind: 'directory', size: 0, mtime: 10, mode: 0o040755 },
        { name: '..', kind: 'directory', size: 0, mtime: 10, mode: 0o040755 },
        { name: 'safe', kind: 'file', size: 1, mtime: 10, mode: 0o100644 },
      ]
    }
    const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', adapter, createId: createIds() })
    const result = await runtime.listDirectory({ ownerKey: 'owner-1', path: '/root', deadlineAt: Date.now() + 2_000 })
    expect(result.entries.map((entry) => entry.path)).toEqual(['/root/safe'])
  })

  test('预览区分 UTF-8、二进制、超限和符号链接，并生成完整内容 hash', async () => {
    const adapter = createMemoryAdapter([
      { path: '/text', data: Buffer.from('你好\n') },
      { path: '/binary', data: Buffer.from([0, 1, 2]) },
      { path: '/huge', data: Buffer.alloc(1_048_577, 65) },
      { path: '/link', data: Buffer.alloc(0), kind: 'symlink' },
    ])
    const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', adapter, createId: createIds() })
    const text = await runtime.preview({ ownerKey: 'owner-1', path: '/text', deadlineAt: Date.now() + 2_000 })
    expect(text.kind).toBe('text')
    if (text.kind === 'text') expect(text.content).toBe('你好\n')
    expect((await runtime.preview({ ownerKey: 'owner-1', path: '/binary', deadlineAt: Date.now() + 2_000 })).kind).toBe('binary')
    expect((await runtime.preview({ ownerKey: 'owner-1', path: '/huge', deadlineAt: Date.now() + 2_000 })).kind).toBe('too-large')
    const link = await runtime.preview({ ownerKey: 'owner-1', path: '/link', deadlineAt: Date.now() + 2_000 })
    expect(link).toMatchObject({ kind: 'symlink', target: '/target' })
  })

  test('预览打开后路径被替换为符号链接时拒绝返回已读正文', async () => {
    const adapter = createMemoryAdapter([{ path: '/config', data: Buffer.from('secret') }])
    const originalLstat = adapter.lstat.bind(adapter)
    let lstatCalls = 0
    adapter.lstat = async (path) => {
      lstatCalls += 1
      if (lstatCalls === 2) return { kind: 'symlink', size: 7, mtime: 10, mode: 0o120777 }
      return await originalLstat(path)
    }
    const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', adapter, createId: createIds() })
    await expect(runtime.preview({ ownerKey: 'owner-1', path: '/config', deadlineAt: Date.now() + 2_000 }))
      .rejects.toThrow('SERVER_OPS_SFTP_FILE_CHANGED')
  })

  test('传输严格限制 64KiB、取消释放 handle，另存目标不覆盖', async () => {
    const adapter = createMemoryAdapter([{ path: '/source', data: Buffer.alloc(70_000, 7) }, { path: '/exists', data: Buffer.from('old') }])
    const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', adapter, createId: createIds() })
    const opened = await runtime.openRead({ ownerKey: 'owner-1', path: '/source', deadlineAt: Date.now() + 2_000 })
    const first = await runtime.readChunk({ ownerKey: 'owner-1', handleId: opened.handleId, length: 65_536, deadlineAt: Date.now() + 2_000 })
    expect(first.data).toHaveLength(65_536)
    await expect(runtime.readChunk({ ownerKey: 'owner-1', handleId: opened.handleId, length: 65_537, deadlineAt: Date.now() + 2_000 })).rejects.toThrow('SERVER_OPS_SFTP_CHUNK_INVALID')
    await runtime.cancel({ ownerKey: 'owner-1', handleId: opened.handleId, deadlineAt: Date.now() + 2_000 })
    await expect(runtime.readChunk({ ownerKey: 'owner-1', handleId: opened.handleId, length: 1, deadlineAt: Date.now() + 2_000 })).rejects.toThrow('SERVER_OPS_SFTP_HANDLE_NOT_FOUND')
    await expect(runtime.openWrite({ ownerKey: 'owner-1', path: '/exists', mode: 'no-clobber', deadlineAt: Date.now() + 2_000 })).rejects.toThrow('EEXIST')
    expect(adapter.readFile('/exists').toString()).toBe('old')
  })

  test('临时文件只允许创建它的 owner 发布且成功后清理临时路径', async () => {
    const adapter = createMemoryAdapter([])
    adapter.enableExtension('hardlink@openssh.com')
    const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', adapter, createId: createIds() })
    const opened = await runtime.openWrite({ ownerKey: 'owner-1', path: '/artifact', mode: 'exclusive-temp', deadlineAt: Date.now() + 2_000 })
    if (!opened.temporaryPath) throw new Error('SERVER_OPS_TEST_TEMPORARY_PATH_MISSING')
    await runtime.writeChunk({ ownerKey: 'owner-1', handleId: opened.handleId, position: 0, data: new Uint8Array([1, 2, 3]), deadlineAt: Date.now() + 2_000 })
    await runtime.close({ ownerKey: 'owner-1', handleId: opened.handleId, deadlineAt: Date.now() + 2_000 })
    await expect(runtime.publishTemporaryNoClobber({ ownerKey: 'owner-2', temporaryPath: opened.temporaryPath, destinationPath: '/artifact', deadlineAt: Date.now() + 2_000 }))
      .rejects.toThrow('SERVER_OPS_SFTP_TEMPORARY_OWNER_MISMATCH')
    expect(adapter.hasFile(opened.temporaryPath)).toBe(true)
    expect(adapter.hasFile('/artifact')).toBe(false)
    await runtime.publishTemporaryNoClobber({ ownerKey: 'owner-1', temporaryPath: opened.temporaryPath, destinationPath: '/artifact', deadlineAt: Date.now() + 2_000 })
    expect(adapter.readFile('/artifact')).toEqual(Buffer.from([1, 2, 3]))
    expect(adapter.hasFile(opened.temporaryPath)).toBe(false)
  })

  test('owner close 等待 handle 关闭并删除身份仍匹配的远端临时文件', async () => {
    const adapter = createMemoryAdapter([])
    const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', adapter, createId: createIds() })
    const opened = await runtime.openWrite({ ownerKey: 'owner-1', path: '/artifact', mode: 'exclusive-temp', deadlineAt: Date.now() + 2_000 })
    if (!opened.temporaryPath) throw new Error('SERVER_OPS_TEST_TEMPORARY_PATH_MISSING')
    await runtime.writeChunk({ ownerKey: 'owner-1', handleId: opened.handleId, position: 0, data: new Uint8Array([1, 2, 3]), deadlineAt: Date.now() + 2_000 })

    await expect(runtime.closeOwner('owner-1')).resolves.toBeUndefined()
    expect(adapter.openHandleCount()).toBe(0)
    expect(adapter.hasFile(opened.temporaryPath)).toBe(false)
  })

  test('owner close 遇到外部替换的临时路径时保留文件并返回 cleanup failure', async () => {
    const adapter = createMemoryAdapter([])
    const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', adapter, createId: createIds() })
    const ownerOne = await runtime.openWrite({ ownerKey: 'owner-1', path: '/artifact', mode: 'exclusive-temp', deadlineAt: Date.now() + 2_000 })
    const ownerTwo = await runtime.openWrite({ ownerKey: 'owner-2', path: '/other', mode: 'exclusive-temp', deadlineAt: Date.now() + 2_000 })
    if (!ownerOne.temporaryPath || !ownerTwo.temporaryPath) throw new Error('SERVER_OPS_TEST_TEMPORARY_PATH_MISSING')
    await runtime.close({ ownerKey: 'owner-1', handleId: ownerOne.handleId, deadlineAt: Date.now() + 2_000 })
    adapter.replaceFile(ownerOne.temporaryPath, Buffer.from('external replacement'))

    await expect(runtime.closeOwner('owner-1')).rejects.toThrow('SERVER_OPS_SFTP_TEMPORARY_CLEANUP_FAILED')
    expect(adapter.readFile(ownerOne.temporaryPath).toString()).toBe('external replacement')
    expect(adapter.hasFile(ownerTwo.temporaryPath)).toBe(true)
    await expect(runtime.closeOwner('owner-2')).resolves.toBeUndefined()
    expect(adapter.hasFile(ownerTwo.temporaryPath)).toBe(false)
  })

  test('断线和 owner close 释放所有资源，迟到 open 回调也会关闭', async () => {
    const adapter = createMemoryAdapter([{ path: '/source', data: Buffer.from('data') }])
    adapter.delayNextOpen = true
    const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', adapter, createId: createIds() })
    const pending = runtime.openRead({ ownerKey: 'owner-1', path: '/source', deadlineAt: Date.now() + 2_000 })
    runtime.closeOwner('owner-1')
    adapter.releaseDelayedOpen()
    await expect(pending).rejects.toThrow('SERVER_OPS_SFTP_OWNER_CLOSED')
    expect(adapter.openHandleCount()).toBe(0)
    runtime.dispose()
    await expect(runtime.openRead({ ownerKey: 'owner-1', path: '/source', deadlineAt: Date.now() + 2_000 })).rejects.toThrow('SERVER_OPS_SFTP_DISPOSED')
  })

  test('写请求超过 deadline 标记结果未知，权限拒绝保持服务端错误', async () => {
    const adapter = createMemoryAdapter([])
    adapter.delayNextWrite = true
    const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', adapter, createId: createIds() })
    const opened = await runtime.openWrite({ ownerKey: 'owner-1', path: '/new', mode: 'no-clobber', deadlineAt: Date.now() + 2_000 })
    const pending = runtime.writeChunk({ ownerKey: 'owner-1', handleId: opened.handleId, position: 0, data: new Uint8Array([1]), deadlineAt: Date.now() + 10 })
    let timeoutError: unknown
    try { await pending } catch (error) { timeoutError = error }
    expect(timeoutError).toBeInstanceOf(ServerOpsSftpRuntimeError)
    expect((timeoutError as ServerOpsSftpRuntimeError).outcome).toBe('unknown')
    adapter.releaseDelayedWrite()
    adapter.mkdirError = new Error('PERMISSION_DENIED')
    await expect(runtime.mkdir({ ownerKey: 'owner-1', path: '/denied', deadlineAt: Date.now() + 2_000 })).rejects.toThrow('PERMISSION_DENIED')
    let dispatchError: unknown
    try {
      await runtime.dispatch({ type: 'mkdir', requestId: 'request-1', hostId: 'host-1', connectionId: 'connection-1', input: { ownerKey: 'owner-1', path: '/denied', deadlineAt: Date.now() + 2_000 } })
    } catch (error) { dispatchError = error }
    expect(dispatchError).toBeInstanceOf(ServerOpsSftpRuntimeError)
    expect((dispatchError as ServerOpsSftpRuntimeError).code).toBe('SERVER_OPS_SFTP_FAILED')
  })

  test('另存使用 wx，受控保存核对编辑事实并要求真实扩展', async () => {
    const adapter = createMemoryAdapter([{ path: '/config', data: Buffer.from('before') }])
    const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', adapter, createId: createIds() })
    const saved = await runtime.saveTextAs({ ownerKey: 'owner-1', path: '/copy', content: 'copy', deadlineAt: Date.now() + 2_000 })
    expect(saved.hash).toMatch(/^sha256:/)
    expect(adapter.readFile('/copy').toString()).toBe('copy')
    await expect(runtime.saveTextAs({ ownerKey: 'owner-1', path: '/copy', content: 'overwrite', deadlineAt: Date.now() + 2_000 })).rejects.toThrow('EEXIST')

    const preview = await runtime.preview({ ownerKey: 'owner-1', path: '/config', deadlineAt: Date.now() + 2_000 })
    if (preview.kind !== 'text') throw new Error('SERVER_OPS_TEST_PREVIEW_INVALID')
    await expect(runtime.saveText({ ownerKey: 'owner-1', path: '/config', content: 'after', editFacts: preview.editFacts, deadlineAt: Date.now() + 2_000 })).rejects.toThrow('SERVER_OPS_SFTP_ATOMIC_SAVE_UNSUPPORTED')
    adapter.enableExtension('fsync@openssh.com')
    adapter.enableExtension('posix-rename@openssh.com')
    const result = await runtime.saveText({ ownerKey: 'owner-1', path: '/config', content: 'after', editFacts: preview.editFacts, deadlineAt: Date.now() + 2_000 })
    expect(adapter.readFile('/config').toString()).toBe('after')
    expect(result.hash).not.toBe(preview.hash)
  })

  test('审批后身份变化会拒绝受控保存并保留远端新内容', async () => {
    const adapter = createMemoryAdapter([{ path: '/config', data: Buffer.from('before') }])
    adapter.enableExtension('fsync@openssh.com')
    adapter.enableExtension('posix-rename@openssh.com')
    const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', adapter, createId: createIds() })
    const preview = await runtime.preview({ ownerKey: 'owner-1', path: '/config', deadlineAt: Date.now() + 2_000 })
    if (preview.kind !== 'text') throw new Error('SERVER_OPS_TEST_PREVIEW_INVALID')
    adapter.replaceFile('/config', Buffer.from('external'))
    await expect(runtime.saveText({ ownerKey: 'owner-1', path: '/config', content: 'draft', editFacts: preview.editFacts, deadlineAt: Date.now() + 2_000 })).rejects.toThrow('SERVER_OPS_SFTP_EDIT_CONFLICT')
    expect(adapter.readFile('/config').toString()).toBe('external')
  })

  test('真实 ssh2 Client.sftp 适配器使用目录 handle 分页', async () => {
    const fixture = await startServerOpsSftpFixture()
    try {
      const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', client: fixture.client, createId: createIds() })
      const page = await runtime.listDirectory({ ownerKey: 'owner-1', path: '/root', deadlineAt: Date.now() + 2_000 })
      expect(page.entries).toHaveLength(200)
      expect(page.cursorId).toBeDefined()
      expect(page.entries.some((entry) => entry.name === 'hello.txt')).toBe(true)
      runtime.dispose()
    } finally { await fixture.close() }
  }, 10_000)

  test('真实 ssh2 Client.sftp owner close 后远端临时文件与 handle 均消失', async () => {
    const fixture = await startServerOpsSftpFixture()
    try {
      const runtime = new ServerOpsSftpRuntime({ hostId: 'host-1', connectionId: 'connection-1', client: fixture.client, createId: createIds() })
      const opened = await runtime.openWrite({ ownerKey: 'owner-1', path: '/root/upload.bin', mode: 'exclusive-temp', deadlineAt: Date.now() + 2_000 })
      if (!opened.temporaryPath) throw new Error('SERVER_OPS_TEST_TEMPORARY_PATH_MISSING')
      await runtime.writeChunk({ ownerKey: 'owner-1', handleId: opened.handleId, position: 0, data: new Uint8Array([1, 2, 3]), deadlineAt: Date.now() + 2_000 })
      expect(fixture.server.hasPath(opened.temporaryPath)).toBe(true)

      await expect(runtime.closeOwner('owner-1')).resolves.toBeUndefined()
      expect(fixture.server.hasPath(opened.temporaryPath)).toBe(false)
      expect(fixture.server.openHandleCount()).toBe(0)
      runtime.dispose()
    } finally { await fixture.close() }
  }, 10_000)
})

interface MemoryFile { path: string; data: Buffer; kind?: 'file' | 'symlink' }

function createIds(): () => string {
  let value = 0
  return () => `opaque-${++value}`
}

function createMemoryAdapter(files: MemoryFile[]): ServerOpsSftpAdapter & {
  readdirPathCalls: number
  delayNextOpen: boolean
  delayNextWrite: boolean
  releaseDelayedOpen(): void
  releaseDelayedWrite(): void
  mkdirError?: Error
  openHandleCount(): number
  hasFile(path: string): boolean
  readFile(path: string): Buffer
  replaceFile(path: string, data: Buffer): void
  enableExtension(name: 'fsync@openssh.com' | 'hardlink@openssh.com' | 'posix-rename@openssh.com'): void
} {
  const records = new Map(files.map((file) => [file.path, { ...file, data: Buffer.from(file.data) }]))
  const handles = new Map<string, { path: string; position: number; kind: 'file' | 'directory' }>()
  let sequence = 0
  let delayedOpen: (() => void) | undefined
  let delayedWrite: (() => void) | undefined
  const extensions = new Set<string>()
  const stat = (file: MemoryFile) => ({ size: file.data.length, mtime: 10, mode: file.kind === 'symlink' ? 0o120777 : 0o100644, kind: file.kind ?? 'file' as const })
  return {
    readdirPathCalls: 0,
    delayNextOpen: false,
    delayNextWrite: false,
    releaseDelayedOpen: () => { delayedOpen?.(); delayedOpen = undefined },
    releaseDelayedWrite: () => { delayedWrite?.(); delayedWrite = undefined },
    openHandleCount: () => handles.size,
    hasFile: (path) => records.has(path),
    readFile: (path) => Buffer.from(records.get(path)?.data ?? Buffer.alloc(0)),
    replaceFile: (path, data) => { records.set(path, { path, data: Buffer.from(data) }) },
    enableExtension: (name) => { extensions.add(name) },
    supportsExtension: (name) => extensions.has(name),
    async openDirectory(path) { const id = `dir-${++sequence}`; handles.set(id, { path, position: 0, kind: 'directory' }); return id },
    async readDirectory(handle) {
      const state = handles.get(handle)
      if (!state || state.kind !== 'directory') throw new Error('EBADF')
      const entries = [...records.values()].filter((file) => file.path.startsWith(`${state.path}/`) && !file.path.slice(state.path.length + 1).includes('/'))
      if (state.position >= entries.length) return []
      const batch = entries.slice(state.position, state.position + 205)
      state.position += batch.length
      return batch.map((file) => ({ name: file.path.slice(state.path.length + 1), ...stat(file) }))
    },
    async lstat(path) { const file = records.get(path); if (!file) throw new Error('ENOENT'); return stat(file) },
    async fstat(handle) { const state = handles.get(handle); const file = state && records.get(state.path); if (!file) throw new Error('EBADF'); return stat(file) },
    async readlink(path) { if (records.get(path)?.kind !== 'symlink') throw new Error('EINVAL'); return '/target' },
    async openFile(path, flags) {
      const finish = () => {
        if (flags.includes('x') && records.has(path)) throw new Error('EEXIST')
        if (!records.has(path)) records.set(path, { path, data: Buffer.alloc(0) })
        const id = `file-${++sequence}`; handles.set(id, { path, position: 0, kind: 'file' }); return id
      }
      if (this.delayNextOpen) {
        this.delayNextOpen = false
        return await new Promise<string>((resolve, reject) => { delayedOpen = () => { try { resolve(finish()) } catch (error) { reject(error) } } })
      }
      return finish()
    },
    async read(handle, position, length) { const state = handles.get(handle); const file = state && records.get(state.path); if (!file) throw new Error('EBADF'); return Buffer.from(file.data.subarray(position, position + length)) },
    async write(handle, position, data) {
      const finish = () => { const state = handles.get(handle); const file = state && records.get(state.path); if (!file) throw new Error('EBADF'); const next = Buffer.alloc(Math.max(file.data.length, position + data.length)); file.data.copy(next); data.copy(next, position); file.data = next }
      if (this.delayNextWrite) { this.delayNextWrite = false; await new Promise<void>((resolve) => { delayedWrite = () => { finish(); resolve() } }); return }
      finish()
    },
    async close(handle) { handles.delete(handle) },
    async mkdir() { if (this.mkdirError) throw this.mkdirError },
    async rename(sourcePath, destinationPath) { const file = records.get(sourcePath); if (!file) throw new Error('ENOENT'); records.set(destinationPath, { ...file, path: destinationPath }); records.delete(sourcePath) },
    async posixRename(sourcePath, destinationPath) { const file = records.get(sourcePath); if (!file) throw new Error('ENOENT'); records.set(destinationPath, { ...file, path: destinationPath }); records.delete(sourcePath) },
    async unlink(path) { if (!records.delete(path)) throw new Error('ENOENT') }, async rmdir() {}, async fsync() {},
    async hardlink(sourcePath, destinationPath) { if (records.has(destinationPath)) throw new Error('EEXIST'); const file = records.get(sourcePath); if (!file) throw new Error('ENOENT'); records.set(destinationPath, { ...file, path: destinationPath }) },
  }
}
