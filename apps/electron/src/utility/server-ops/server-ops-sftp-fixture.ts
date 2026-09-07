import { constants } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { Client, Server, utils } from 'ssh2'
import type { Connection } from 'ssh2'

interface FixtureRecord { path: string; data: Buffer; mode: number }
interface FixtureHandle { kind: 'directory' | 'file'; path: string; listed?: boolean }

/** 可供单元测试和 Electron smoke 共用的回环 SFTP 服务。 */
export interface ServerOpsSftpServerFixture {
  port: number
  openHandleCount(): number
  hasPath(path: string): boolean
  readText(path: string): string | undefined
  close(): Promise<void>
}

/** fixture 只使用 SFTP v3 的固定状态码与只读打开标志。 */
const sftpConstants = {
  STATUS_CODE: { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 },
  OPEN_MODE: { READ: 1, WRITE: 2, CREAT: 8, TRUNC: 16, EXCL: 32 },
} as const

/** @types/ssh2 未公开服务端 SFTP stream，fixture 在本地声明实际使用的最小接口。 */
interface FixtureSftpStream {
  on(event: 'OPENDIR', listener: (requestId: number, path: string) => void): this
  on(event: 'READDIR', listener: (requestId: number, handle: Buffer) => void): this
  on(event: 'LSTAT', listener: (requestId: number, path: string) => void): this
  on(event: 'OPEN', listener: (requestId: number, path: string, flags: number) => void): this
  on(event: 'FSTAT', listener: (requestId: number, handle: Buffer) => void): this
  on(event: 'READ', listener: (requestId: number, handle: Buffer, offset: number, length: number) => void): this
  on(event: 'READLINK', listener: (requestId: number, path: string) => void): this
  on(event: 'CLOSE', listener: (requestId: number, handle: Buffer) => void): this
  on(event: 'WRITE', listener: (requestId: number, handle: Buffer, offset: number, data: Buffer) => void): this
  on(event: 'MKDIR', listener: (requestId: number, path: string) => void): this
  on(event: 'REMOVE', listener: (requestId: number, path: string) => void): this
  on(event: 'RMDIR', listener: (requestId: number, path: string) => void): this
  status(requestId: number, statusCode: number): void
  handle(requestId: number, handle: Buffer): void
  name(requestId: number, entries: Array<{ filename: string; longname: string; attrs: object }>): void
  attrs(requestId: number, attributes: FixtureAttributes): void
  data(requestId: number, data: Buffer): void
}

/** 只在测试中启动内存 SSH/SFTP 服务，不访问用户机器文件或真实服务器。 */
export async function startServerOpsSftpServerFixture(): Promise<ServerOpsSftpServerFixture> {
  const records = new Map<string, FixtureRecord>([
    ['/root/hello.txt', { path: '/root/hello.txt', data: Buffer.from('fixture 你好\n'), mode: constants.S_IFREG | 0o644 }],
    ['/root/link', { path: '/root/link', data: Buffer.from('/root/hello.txt'), mode: constants.S_IFLNK | 0o777 }],
  ])
  for (let index = 0; index < 203; index += 1) {
    const path = `/root/item-${index}.txt`
    records.set(path, { path, data: Buffer.from(`${index}`), mode: constants.S_IFREG | 0o644 })
  }
  const handles = new Map<number, FixtureHandle>()
  const clients = new Set<Connection>()
  let handleSequence = 0
  const hostKey = utils.generateKeyPairSync('ed25519')
  const server = new Server({ hostKeys: [hostKey.private] }, (connection) => {
    clients.add(connection)
    connection.on('error', () => undefined)
    connection.once('close', () => clients.delete(connection))
    connection.on('authentication', (context) => {
      if (context.method === 'password' && context.username === 'fixture' && context.password === 'fixture-password') context.accept()
      else context.reject()
    })
    connection.on('ready', () => { connection.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty())
      session.on('shell', (acceptShell) => { acceptShell() })
      session.on('sftp', (acceptSftp) => {
        configureSftpFixture(acceptSftp() as unknown as FixtureSftpStream, records, handles, () => ++handleSequence)
      })
    }) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: (server.address() as AddressInfo).port,
    openHandleCount: () => handles.size,
    hasPath: (path) => records.has(path),
    readText: (path) => records.get(path)?.data.toString('utf8'),
    close: () => new Promise<void>((resolve) => {
      for (const client of clients) client.end()
      server.close(() => resolve())
    }),
  }
}

/** 为 runtime 单元测试建立一个真实 ssh2 Client.sftp 连接。 */
export async function startServerOpsSftpFixture(): Promise<{ client: Client; server: ServerOpsSftpServerFixture; close(): Promise<void> }> {
  const fixture = await startServerOpsSftpServerFixture()
  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', reject)
    client.connect({ host: '127.0.0.1', port: fixture.port, username: 'fixture', password: 'fixture-password', hostVerifier: () => true })
  })
  return {
    client,
    server: fixture,
    async close(): Promise<void> {
      client.destroy()
      await Promise.race([
        fixture.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ])
    },
  }
}

/** 配置 fixture 支持分页目录、lstat、readlink 与有界读取所需的最小 SFTP 指令。 */
function configureSftpFixture(
  sftp: FixtureSftpStream,
  records: Map<string, FixtureRecord>,
  handles: Map<number, FixtureHandle>,
  nextHandle: () => number,
): void {
  sftp.on('OPENDIR', (requestId, path) => {
    if (path !== '/root') { sftp.status(requestId, sftpConstants.STATUS_CODE.NO_SUCH_FILE); return }
    const handleId = nextHandle()
    handles.set(handleId, { kind: 'directory', path })
    sftp.handle(requestId, encodeHandle(handleId))
  })
  sftp.on('READDIR', (requestId, rawHandle) => {
    const handle = decodeHandle(rawHandle, handles)
    if (!handle || handle.kind !== 'directory') { sftp.status(requestId, sftpConstants.STATUS_CODE.FAILURE); return }
    if (handle.listed) { sftp.name(requestId, []); return }
    handle.listed = true
    const entries = [...records.values()].map((record) => ({ filename: record.path.slice('/root/'.length), longname: record.path, attrs: attributes(record) }))
    sftp.name(requestId, entries)
  })
  sftp.on('LSTAT', (requestId, path) => {
    const record = records.get(path)
    if (!record) { sftp.status(requestId, sftpConstants.STATUS_CODE.NO_SUCH_FILE); return }
    sftp.attrs(requestId, attributes(record))
  })
  sftp.on('OPEN', (requestId, path, flags) => {
    let record = records.get(path)
    const wantsRead = (flags & sftpConstants.OPEN_MODE.READ) !== 0
    const wantsWrite = (flags & sftpConstants.OPEN_MODE.WRITE) !== 0
    if (wantsRead && !record) { sftp.status(requestId, sftpConstants.STATUS_CODE.NO_SUCH_FILE); return }
    if (wantsWrite && (flags & sftpConstants.OPEN_MODE.EXCL) !== 0 && record) { sftp.status(requestId, sftpConstants.STATUS_CODE.FAILURE); return }
    if (wantsWrite && !record && (flags & sftpConstants.OPEN_MODE.CREAT) !== 0) {
      record = { path, data: Buffer.alloc(0), mode: constants.S_IFREG | 0o644 }
      records.set(path, record)
    }
    if (!record || (!wantsRead && !wantsWrite) || (record.mode & constants.S_IFMT) !== constants.S_IFREG) {
      sftp.status(requestId, sftpConstants.STATUS_CODE.PERMISSION_DENIED)
      return
    }
    if (wantsWrite && (flags & sftpConstants.OPEN_MODE.TRUNC) !== 0) record.data = Buffer.alloc(0)
    const handleId = nextHandle()
    handles.set(handleId, { kind: 'file', path })
    sftp.handle(requestId, encodeHandle(handleId))
  })
  sftp.on('FSTAT', (requestId, rawHandle) => {
    const handle = decodeHandle(rawHandle, handles)
    const record = handle?.kind === 'file' ? records.get(handle.path) : undefined
    if (!record) { sftp.status(requestId, sftpConstants.STATUS_CODE.FAILURE); return }
    sftp.attrs(requestId, attributes(record))
  })
  sftp.on('READ', (requestId, rawHandle, offset, length) => {
    const handle = decodeHandle(rawHandle, handles)
    const record = handle?.kind === 'file' ? records.get(handle.path) : undefined
    if (!record) { sftp.status(requestId, sftpConstants.STATUS_CODE.FAILURE); return }
    const data = record.data.subarray(offset, offset + length)
    if (data.length === 0) { sftp.status(requestId, sftpConstants.STATUS_CODE.EOF); return }
    sftp.data(requestId, data)
  })
  sftp.on('WRITE', (requestId, rawHandle, offset, data) => {
    const handle = decodeHandle(rawHandle, handles)
    const record = handle?.kind === 'file' ? records.get(handle.path) : undefined
    if (!record) { sftp.status(requestId, sftpConstants.STATUS_CODE.FAILURE); return }
    const requiredLength = offset + data.length
    if (record.data.length < requiredLength) {
      const expanded = Buffer.alloc(requiredLength)
      record.data.copy(expanded)
      record.data = expanded
    }
    data.copy(record.data, offset)
    sftp.status(requestId, sftpConstants.STATUS_CODE.OK)
  })
  sftp.on('MKDIR', (requestId, path) => {
    if (records.has(path)) { sftp.status(requestId, sftpConstants.STATUS_CODE.FAILURE); return }
    records.set(path, { path, data: Buffer.alloc(0), mode: constants.S_IFDIR | 0o755 })
    sftp.status(requestId, sftpConstants.STATUS_CODE.OK)
  })
  sftp.on('REMOVE', (requestId, path) => {
    const record = records.get(path)
    if (!record || (record.mode & constants.S_IFMT) === constants.S_IFDIR) { sftp.status(requestId, sftpConstants.STATUS_CODE.FAILURE); return }
    records.delete(path)
    sftp.status(requestId, sftpConstants.STATUS_CODE.OK)
  })
  sftp.on('RMDIR', (requestId, path) => {
    const record = records.get(path)
    const hasChild = [...records.keys()].some((entry) => entry.startsWith(`${path}/`))
    if (!record || (record.mode & constants.S_IFMT) !== constants.S_IFDIR || hasChild) { sftp.status(requestId, sftpConstants.STATUS_CODE.FAILURE); return }
    records.delete(path)
    sftp.status(requestId, sftpConstants.STATUS_CODE.OK)
  })
  sftp.on('READLINK', (requestId, path) => {
    const record = records.get(path)
    if (!record || (record.mode & constants.S_IFMT) !== constants.S_IFLNK) { sftp.status(requestId, sftpConstants.STATUS_CODE.FAILURE); return }
    sftp.name(requestId, [{ filename: record.data.toString(), longname: record.data.toString(), attrs: {} }])
  })
  sftp.on('CLOSE', (requestId, rawHandle) => {
    const handleId = rawHandle.length === 4 ? rawHandle.readUInt32BE(0) : -1
    if (!handles.delete(handleId)) { sftp.status(requestId, sftpConstants.STATUS_CODE.FAILURE); return }
    sftp.status(requestId, sftpConstants.STATUS_CODE.OK)
  })
}

/** 生成 ssh2 SFTP 可识别的文件属性。 */
interface FixtureAttributes { mode: number; uid: number; gid: number; size: number; atime: number; mtime: number }

/** 从内存记录生成 SFTP v3 属性。 */
function attributes(record: FixtureRecord): FixtureAttributes {
  return { mode: record.mode, uid: 1_000, gid: 1_000, size: record.data.length, atime: 1_700_000_000, mtime: 1_700_000_000 }
}
/** 将 fixture handle ID 编码为 SFTP Buffer。 */
function encodeHandle(handleId: number): Buffer { const handle = Buffer.alloc(4); handle.writeUInt32BE(handleId); return handle }
/** 验证并读取 fixture handle。 */
function decodeHandle(rawHandle: Buffer, handles: Map<number, FixtureHandle>): FixtureHandle | undefined { return rawHandle.length === 4 ? handles.get(rawHandle.readUInt32BE(0)) : undefined }
