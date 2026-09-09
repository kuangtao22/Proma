import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { ServerOpsHost } from '@proma/shared'
import { ServerOpsAuditStore } from '../src/main/lib/server-ops/server-ops-audit-store'
import { ServerOpsConnectionService } from '../src/main/lib/server-ops/server-ops-connection-service'
import { ServerOpsCredentialStore } from '../src/main/lib/server-ops/server-ops-credential-store'
import { ServerOpsFileService } from '../src/main/lib/server-ops/server-ops-file-service'
import { ServerOpsHostTrustStore } from '../src/main/lib/server-ops/server-ops-host-trust-store'
import type { ServerOpsConfigTransaction } from '../src/main/lib/server-ops/server-ops-config-transaction'
import { ServerOpsRuntimeClient } from '../src/main/lib/server-ops/server-ops-runtime-client'
import { ServerOpsAgentAccessStore } from '../src/main/lib/server-ops/server-ops-agent-access-store'
import { registerServerOpsIpcHandlers } from '../src/main/lib/server-ops/server-ops-ipc'
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

  /** 在真实 Renderer/preload/IPC 中重现文件页 cleanup 后立即重新挂载的调用顺序。 */
  const window = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } })
  const registration = registerServerOpsIpcHandlers({
    ipc: ipcMain,
    listAuthorizedWebContents: () => [window.webContents],
    resolveOwnerWindow: (sender) => BrowserWindow.fromWebContents(sender),
    hosts: {
      ...hostStore,
      list: () => [host],
      upsert: () => { throw new Error('fixture 不编辑主机') },
      remove: () => { throw new Error('fixture 不删除主机') },
    },
    credentials,
    connections,
    access: new ServerOpsAgentAccessStore(),
    audit,
    files,
    requireUserVisibleSession: () => { throw new Error('fixture 不访问 Agent 会话') },
  })
  try {
    await window.loadURL('data:text/html,<html><head><title>SFTP lifecycle smoke</title></head><body></body></html>')
    /** 页面只访问 localhost 内存夹具，循环三次验证清理 ACK 与再次打开不会相互取消。 */
    const lifecycle = await window.webContents.executeJavaScript(`(async () => {
      const api = window.electronAPI;
      const input = { hostId: 'files-fixture', path: '/root' };
      const pages = [];
      await api.listServerOpsFiles(input);
      for (let index = 0; index < 3; index += 1) {
        const closing = api.closeServerOpsFilesOwner({ hostId: input.hostId });
        const reloading = api.listServerOpsFiles(input);
        const [, page] = await Promise.all([closing, reloading]);
        pages.push(page.entries.length);
      }
      await api.closeServerOpsFilesOwner({ hostId: input.hostId });
      return pages;
    })()`)
    assert.deepEqual(lifecycle, [200, 200, 200])
    assert.equal(fixture.openHandleCount(), 0)
    console.log('[Server Ops files smoke] PASS: 真实 Renderer/preload/IPC 连续三次关闭并立即重读成功，清理 ACK 后远端 handle 为零')
  } finally {
    registration.dispose()
    window.destroy()
  }

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

  await files.closeOwner(7, ownerKey)
  assert.equal(fixture.openHandleCount(), 0)
  console.log('[Server Ops files smoke] PASS: 真实 utility IPC 完成列表、UTF-8 预览、mkdir、save-as、删除与 owner 释放')
}

mkdirSync(join(configDir, 'electron-user-data'))
app.setPath('userData', join(configDir, 'electron-user-data'))
/** IPC 验证窗口关闭后继续执行文件服务验证，由统一 finish 负责结束隔离进程。 */
app.on('window-all-closed', () => undefined)
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
