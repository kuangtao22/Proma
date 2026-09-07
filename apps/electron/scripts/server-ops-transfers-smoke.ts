import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { Server, utils } from 'ssh2'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Connection } from 'ssh2'
import type { ServerOpsHost, ServerOpsTransferSnapshot } from '@proma/shared'
import { ServerOpsAuditStore } from '../src/main/lib/server-ops/server-ops-audit-store'
import { ServerOpsConnectionService } from '../src/main/lib/server-ops/server-ops-connection-service'
import { ServerOpsCredentialStore } from '../src/main/lib/server-ops/server-ops-credential-store'
import { ServerOpsFileTransferService, ServerOpsSafeFileTransferRecoveryStore } from '../src/main/lib/server-ops/server-ops-file-transfer-service'
import { ServerOpsHostTrustStore } from '../src/main/lib/server-ops/server-ops-host-trust-store'
import { ServerOpsLocalFileLeaseRegistry } from '../src/main/lib/server-ops/server-ops-local-file-leases'
import type { ServerOpsConfigTransaction } from '../src/main/lib/server-ops/server-ops-config-transaction'
import { ServerOpsRuntimeClient } from '../src/main/lib/server-ops/server-ops-runtime-client'

/** 冒烟验证只使用的临时配置、本地文件和远端文件根。 */
const smokeRoot = mkdtempSync(join(tmpdir(), 'proma-ops-transfers-smoke-'))
const configDir = join(smokeRoot, 'config')
const localDir = join(smokeRoot, 'local')
const remoteDir = join(smokeRoot, 'remote')
const ownerId = 7
const ownerKey = 'window:7:transfers'
/** 临时进程内事务避免 smoke 触碰生产配置锁。 */
const transaction: ServerOpsConfigTransaction = (callback) => callback()

interface FixtureServer {
  port: number
  close(): Promise<void>
}

let fixture: FixtureServer | undefined
let runtime: ServerOpsRuntimeClient | undefined
let connections: ServerOpsConnectionService | undefined
let transfers: ServerOpsFileTransferService | undefined
let leases: ServerOpsLocalFileLeaseRegistry | undefined
let selectedUploadPath: string | null = null
let selectedDownloadPath: string | null = null
let finishing = false

/** 启动只绑定 127.0.0.1 的 SSH 服务，并把 SFTP subsystem 转发到系统 sftp-server。 */
async function startFixture(): Promise<FixtureServer> {
  const key = utils.generateKeyPairSync('ed25519')
  const clients = new Set<Connection>()
  const children = new Set<ChildProcessWithoutNullStreams>()
  const server = new Server({ hostKeys: [key.private] }, (connection) => {
    clients.add(connection)
    connection.on('error', () => undefined)
    connection.once('close', () => clients.delete(connection))
    connection.on('authentication', (context) => {
      if (context.method === 'password' && context.username === 'fixture' && context.password === 'fixture-password') context.accept()
      else context.reject()
    })
    connection.on('ready', () => connection.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty())
      session.on('shell', (acceptShell) => { acceptShell() })
      session.on('subsystem', (acceptSubsystem, rejectSubsystem, info) => {
        if (info.name !== 'sftp') { rejectSubsystem(); return }
        const channel = acceptSubsystem()
        const child = spawn('/usr/libexec/sftp-server', ['-e', '-d', remoteDir], { stdio: ['pipe', 'pipe', 'pipe'] })
        children.add(child)
        child.once('exit', () => children.delete(child))
        channel.pipe(child.stdin)
        child.stdout.pipe(channel)
        channel.once('close', () => child.kill())
      })
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => {
      for (const client of clients) client.end()
      for (const child of children) child.kill()
      server.close(() => resolve())
    }),
  }
}

/** 返回指定远端路径最新的公开传输终态。 */
function latest(remotePath: string): ServerOpsTransferSnapshot {
  const snapshot = transfers?.list(ownerId, ownerKey, {}).filter((item) => item.remotePath === remotePath).at(-1)
  assert(snapshot)
  return snapshot
}

/** 通过真实 utility、localhost SFTP 和真实 fd lease 完成传输链。 */
async function runSmoke(): Promise<void> {
  console.log('[Server Ops transfers smoke] 启动 localhost OpenSSH SFTP fixture')
  fixture = await startFixture()
  const host: ServerOpsHost = {
    id: 'transfers-fixture', name: '传输冒烟机', address: '127.0.0.1', port: fixture.port,
    username: 'fixture', authMethod: 'password', tags: [], createdAt: 1, updatedAt: 1,
  }
  const hostStore = {
    get: (hostId: string) => hostId === host.id ? host : undefined,
    setCredentialRef: () => { throw new Error('smoke 不持久化凭据') },
  }
  const credentials = new ServerOpsCredentialStore(configDir, { transaction })
  const trust = new ServerOpsHostTrustStore(configDir, { transaction })
  const audit = new ServerOpsAuditStore(configDir, { transaction })
  runtime = new ServerOpsRuntimeClient()
  connections = new ServerOpsConnectionService({
    hosts: hostStore, credentials, trust, runtime, uuid: randomUUID,
    acquireMutationGuard: async () => () => undefined,
    resolveSshAgent: () => { throw new Error('fixture 不使用 SSH Agent') },
    readPrivateKey: () => { throw new Error('fixture 不读取私钥') },
  })
  leases = new ServerOpsLocalFileLeaseRegistry({
    selectUpload: async () => selectedUploadPath,
    selectDownload: async () => selectedDownloadPath,
    isOwnerAlive: () => true,
  })
  transfers = new ServerOpsFileTransferService({
    connections: {
      getActiveIdentity: (hostId) => connections!.getActiveIdentity(hostId),
      sftp: (input) => connections!.sftp(input),
      closeSftpOwner: (key) => runtime!.closeSftpOwner(key),
    },
    leases,
    isOwnerAlive: () => true,
    audit: {
      append: audit.append.bind(audit),
      prepareForWrites: () => audit.prepareForWrites(async () => () => undefined),
    },
    recovery: new ServerOpsSafeFileTransferRecoveryStore(configDir),
  })
  const initial = await connections.connect({ hostId: host.id, cols: 80, rows: 24,
    credential: { kind: 'password', password: 'fixture-password', remember: false } })
  assert.equal(initial.phase, 'host-key-required')
  assert(initial.candidate)
  assert.equal((await connections.confirmHostKey({ hostId: host.id, candidateId: initial.candidate.candidateId, cols: 80, rows: 24 })).phase, 'connected')
  console.log('[Server Ops transfers smoke] Electron utility 已连接 localhost fixture')

  /** 65 KiB + 1 强制经过两个 chunk，并包含 NUL/高位字节。 */
  const binary = Buffer.alloc(65_537)
  for (let index = 0; index < binary.length; index += 1) binary[index] = index % 251
  const uploadSource = join(localDir, 'binary-upload.bin')
  const remoteUpload = join(remoteDir, 'binary-upload.bin')
  writeFileSync(uploadSource, binary)
  selectedUploadPath = uploadSource
  const uploadSelection = await leases.selectUpload(ownerId, ownerKey)
  assert(uploadSelection)
  await transfers.start(ownerId, ownerKey, { direction: 'upload', hostId: host.id, remotePath: remoteUpload, leaseId: uploadSelection.leaseId })
  await transfers.whenIdle()
  assert.equal(latest(remoteUpload).status, 'succeeded')
  assert.equal(createHash('sha256').update(readFileSync(remoteUpload)).digest('hex'), createHash('sha256').update(binary).digest('hex'))
  console.log('[Server Ops transfers smoke] 二进制上传与远端读回 hash 通过')

  const downloadTarget = join(localDir, 'binary-download.bin')
  selectedDownloadPath = downloadTarget
  const downloadSelection = await leases.selectDownload(ownerId, ownerKey, 'binary-download.bin')
  assert(downloadSelection)
  await transfers.start(ownerId, ownerKey, { direction: 'download', hostId: host.id, remotePath: remoteUpload, leaseId: downloadSelection.leaseId })
  await transfers.whenIdle()
  assert.equal(latest(remoteUpload).status, 'succeeded')
  assert.deepEqual(readFileSync(downloadTarget), binary)
  console.log('[Server Ops transfers smoke] 二进制下载与本地 fd hash 通过')

  const existingRemote = join(remoteDir, 'existing-remote.bin')
  writeFileSync(existingRemote, 'remote-original')
  selectedUploadPath = uploadSource
  const remoteConflictSelection = await leases.selectUpload(ownerId, ownerKey)
  assert(remoteConflictSelection)
  await transfers.start(ownerId, ownerKey, { direction: 'upload', hostId: host.id, remotePath: existingRemote, leaseId: remoteConflictSelection.leaseId })
  await transfers.whenIdle()
  assert.notEqual(latest(existingRemote).status, 'succeeded')
  assert.equal(readFileSync(existingRemote, 'utf8'), 'remote-original')

  const existingLocal = join(localDir, 'existing-local.bin')
  writeFileSync(existingLocal, 'local-original')
  selectedDownloadPath = existingLocal
  const localConflictSelection = await leases.selectDownload(ownerId, ownerKey, 'existing-local.bin')
  assert(localConflictSelection)
  await transfers.start(ownerId, ownerKey, { direction: 'download', hostId: host.id, remotePath: remoteUpload, leaseId: localConflictSelection.leaseId })
  await transfers.whenIdle()
  assert.equal(latest(remoteUpload).status, 'failed')
  assert.equal(readFileSync(existingLocal, 'utf8'), 'local-original')
  console.log('[Server Ops transfers smoke] 远端和本地已有目标均未覆盖')

  const cancelSource = join(localDir, 'cancel.bin')
  const cancelRemote = join(remoteDir, 'cancel.bin')
  writeFileSync(cancelSource, Buffer.alloc(8 * 1_048_576, 7))
  selectedUploadPath = cancelSource
  const cancelSelection = await leases.selectUpload(ownerId, ownerKey)
  assert(cancelSelection)
  const cancelling = await transfers.start(ownerId, ownerKey, { direction: 'upload', hostId: host.id, remotePath: cancelRemote, leaseId: cancelSelection.leaseId })
  await transfers.cancel(ownerId, ownerKey, { hostId: host.id, transferId: cancelling.transferId })
  assert.equal(latest(cancelRemote).errorCode, 'SERVER_OPS_TRANSFER_CANCELLED')
  assert.equal(readFileIfExists(cancelRemote), undefined)

  console.log('[Server Ops transfers smoke] PASS: 真实 utility/SFTP/fd 完成二进制上传下载 hash、双向 no-clobber 与取消释放')
}

/** 读取可能不存在的取消目标，不把 ENOENT 当作 smoke 故障。 */
function readFileIfExists(path: string): Buffer | undefined { try { return readFileSync(path) } catch { return undefined } }

mkdirSync(configDir, { recursive: true })
mkdirSync(localDir, { recursive: true })
mkdirSync(remoteDir, { recursive: true })
mkdirSync(join(configDir, 'electron-user-data'))
app.setPath('userData', join(configDir, 'electron-user-data'))
/** 有界 smoke 超时强制收口。 */
const timeout = setTimeout(() => { console.error('[Server Ops transfers smoke] timeout'); void finish(1) }, 45_000)
void app.whenReady().then(runSmoke).then(() => finish(0), (error: unknown) => {
  console.error('[Server Ops transfers smoke] failed', error)
  return finish(1)
})

/** 统一释放传输、lease、runtime、回环 SSH 与临时目录。 */
async function finish(code: number): Promise<void> {
  if (finishing) return
  finishing = true
  clearTimeout(timeout)
  await transfers?.dispose()
  await leases?.dispose()
  connections?.dispose()
  runtime?.stop()
  await fixture?.close()
  rmSync(smokeRoot, { recursive: true, force: true })
  app.exit(code)
}
