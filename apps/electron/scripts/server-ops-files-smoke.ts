import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { ServerOpsHost } from '@proma/shared'
import { ServerOpsAuditStore } from '../src/main/lib/server-ops/server-ops-audit-store'
import { ServerOpsConnectionService } from '../src/main/lib/server-ops/server-ops-connection-service'
import { ServerOpsCredentialStore } from '../src/main/lib/server-ops/server-ops-credential-store'
import { ServerOpsFileService } from '../src/main/lib/server-ops/server-ops-file-service'
import { ServerOpsHostTrustStore } from '../src/main/lib/server-ops/server-ops-host-trust-store'
import type { ServerOpsConfigTransaction } from '../src/main/lib/server-ops/server-ops-config-transaction'
import { ServerOpsRuntimeClient } from '../src/main/lib/server-ops/server-ops-runtime-client'
import {
  startServerOpsSftpServerFixture,
  type ServerOpsSftpServerFixture,
} from '../src/utility/server-ops/server-ops-sftp-fixture'

/** 独立临时数据根确保 smoke 不读取或修改用户的 ~/.proma。 */
const configDir = mkdtempSync(join(tmpdir(), 'proma-ops-files-smoke-'))
/** smoke 仅有一个窗口 owner，文件和传输使用不同命名空间。 */
const ownerKey = 'window:7:files'
/** 临时进程内事务用于隔离 smoke，跨进程锁由正式集成测试覆盖。 */
const transaction: ServerOpsConfigTransaction = (callback) => callback()
/** 异常路径也需要释放的真实 runtime 与回环 fixture。 */
let fixture: ServerOpsSftpServerFixture | undefined
let runtime: ServerOpsRuntimeClient | undefined
let connections: ServerOpsConnectionService | undefined
let files: ServerOpsFileService | undefined

/** 等待 utility 处理无响应的 close-owner 消息，超时视为资源泄漏。 */
async function waitForOwnerRelease(): Promise<void> {
  const deadline = Date.now() + 2_000
  while (fixture && fixture.openHandleCount() !== 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(fixture?.openHandleCount(), 0)
}

/** 通过真实 Electron utility IPC 和 localhost ssh2 执行完整文件操作链。 */
async function runSmoke(): Promise<void> {
  fixture = await startServerOpsSftpServerFixture()
  const host: ServerOpsHost = {
    id: 'files-fixture',
    name: '文件冒烟机',
    address: '127.0.0.1',
    port: fixture.port,
    username: 'fixture',
    authMethod: 'password',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
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
    hosts: hostStore,
    credentials,
    trust,
    runtime,
    uuid: randomUUID,
    acquireMutationGuard: async () => () => undefined,
    resolveSshAgent: () => { throw new Error('fixture 不使用 SSH Agent') },
    readPrivateKey: () => { throw new Error('fixture 不读取私钥') },
  })
  files = new ServerOpsFileService({
    hosts: hostStore,
    connections: {
      getActiveIdentity: (hostId) => connections!.getActiveIdentity(hostId),
      sftp: (input) => connections!.sftp(input),
      closeSftpOwner: (key) => runtime!.closeSftpOwner(key),
    },
    audit: {
      append: audit.append.bind(audit),
      prepareForWrites: () => audit.prepareForWrites(async () => () => undefined),
    },
  })

  const initial = await connections.connect({
    hostId: host.id,
    cols: 80,
    rows: 24,
    credential: { kind: 'password', password: 'fixture-password', remember: false },
  })
  assert.equal(initial.phase, 'host-key-required')
  assert(initial.candidate)
  const connected = await connections.confirmHostKey({
    hostId: host.id,
    candidateId: initial.candidate.candidateId,
    cols: 80,
    rows: 24,
  })
  assert.equal(connected.phase, 'connected')

  const listing = await files.list(ownerKey, { hostId: host.id, path: '/root' })
  assert.equal(listing.entries.length, 200)
  assert(listing.cursor)
  const preview = await files.preview(ownerKey, { hostId: host.id, path: '/root/hello.txt' })
  assert.equal(preview.kind, 'text')
  if (preview.kind === 'text') assert.equal(preview.content, 'fixture 你好\n')

  const mkdirCandidate = await files.prepare(7, ownerKey, {
    hostId: host.id,
    action: 'mkdir',
    path: '/root/smoke-dir',
  })
  await files.commit(7, ownerKey, {
    hostId: host.id,
    candidateId: mkdirCandidate.candidateId,
    confirmationName: host.name,
  })
  assert.equal(fixture.hasPath('/root/smoke-dir'), true)

  const saveCandidate = await files.prepare(7, ownerKey, {
    hostId: host.id,
    action: 'save-as',
    path: '/root/smoke.txt',
    content: '真实 utility 文件冒烟\n',
  })
  await files.commit(7, ownerKey, {
    hostId: host.id,
    candidateId: saveCandidate.candidateId,
    confirmationName: host.name,
  })
  assert.equal(fixture.readText('/root/smoke.txt'), '真实 utility 文件冒烟\n')

  const deleteFileCandidate = await files.prepare(7, ownerKey, {
    hostId: host.id,
    action: 'delete',
    path: '/root/smoke.txt',
    targetKind: 'file',
  })
  await files.commit(7, ownerKey, {
    hostId: host.id,
    candidateId: deleteFileCandidate.candidateId,
    confirmationName: host.name,
  })
  const deleteDirectoryCandidate = await files.prepare(7, ownerKey, {
    hostId: host.id,
    action: 'delete',
    path: '/root/smoke-dir',
    targetKind: 'directory',
  })
  await files.commit(7, ownerKey, {
    hostId: host.id,
    candidateId: deleteDirectoryCandidate.candidateId,
    confirmationName: host.name,
  })
  assert.equal(fixture.hasPath('/root/smoke.txt'), false)
  assert.equal(fixture.hasPath('/root/smoke-dir'), false)

  files.closeOwner(7, ownerKey)
  await waitForOwnerRelease()
  console.log('[Server Ops files smoke] PASS: 真实 utility IPC 完成列表、UTF-8 预览、mkdir、save-as、删除与 owner 释放')
}

mkdirSync(join(configDir, 'electron-user-data'))
app.setPath('userData', join(configDir, 'electron-user-data'))
/** 有界 smoke 超时强制收口，避免失败时遗留 Electron 或 SSH 进程。 */
const timeout = setTimeout(() => {
  console.error('[Server Ops files smoke] timeout')
  app.exit(1)
}, 30_000)
void app.whenReady().then(runSmoke).then(() => finish(0), (error: unknown) => {
  console.error('[Server Ops files smoke] failed', error)
  return finish(1)
})

/** 统一释放文件候选、SSH runtime、回环服务和临时数据根。 */
async function finish(code: number): Promise<void> {
  clearTimeout(timeout)
  files?.dispose()
  connections?.dispose()
  runtime?.stop()
  await fixture?.close()
  rmSync(configDir, { recursive: true, force: true })
  app.exit(code)
}
