import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { Server, utils } from 'ssh2'
import type { Connection } from 'ssh2'
import type { ServerOpsHost } from '@proma/shared'
import { ServerOpsAuditStore } from '../src/main/lib/server-ops/server-ops-audit-store'
import { ServerOpsConnectionService } from '../src/main/lib/server-ops/server-ops-connection-service'
import { createServerOpsConfigTransaction } from '../src/main/lib/server-ops/server-ops-config-transaction'
import { ServerOpsCredentialStore } from '../src/main/lib/server-ops/server-ops-credential-store'
import { ServerOpsHostTrustStore } from '../src/main/lib/server-ops/server-ops-host-trust-store'
import { ServerOpsRuntimeClient } from '../src/main/lib/server-ops/server-ops-runtime-client'
import { ServerOpsTrustService } from '../src/main/lib/server-ops/server-ops-trust-service'

/** 独立临时数据根，任何 smoke 操作均不读取用户 ~/.proma。 */
const configDir = mkdtempSync(join(tmpdir(), 'proma-ops-electron-smoke-'))
/** 仅测试创建的 SSH 服务端及其资源。 */
interface FixtureServer {
  port: number
  attempts(): number
  close(): Promise<void>
}
/** 当前 fixture 资源用于任何异常路径的收口。 */
let fixtureServer: FixtureServer | undefined
let runtime: ServerOpsRuntimeClient | undefined
let connections: ServerOpsConnectionService | undefined
let trustService: ServerOpsTrustService | undefined

/** 启动随机 Host Key 的回环 SSH fixture；密码只是测试常量，不使用用户凭据。 */
async function startFixture(port = 0): Promise<FixtureServer> {
  const key = utils.generateKeyPairSync('ed25519')
  const clients = new Set<Connection>()
  let passwordAttempts = 0
  const server = new Server({ hostKeys: [key.private] }, (client) => {
    clients.add(client)
    client.on('error', () => undefined)
    client.once('close', () => clients.delete(client))
    client.on('authentication', (authentication) => {
      if (authentication.method === 'password') passwordAttempts++
      if (authentication.method === 'password' && authentication.username === 'fixture' && authentication.password === 'fixture-password') authentication.accept()
      else authentication.reject()
    })
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty())
      session.on('shell', (acceptShell) => { acceptShell() })
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { port: (server.address() as AddressInfo).port, attempts: () => passwordAttempts,
    close: () => new Promise<void>((resolve) => {
      for (const client of clients) client.end()
      server.close(() => resolve())
    }),
  }
}

/** 用真实 Electron runtime、N-API 锁及磁盘 Store 验证完整信任操作链。 */
async function runSmoke(): Promise<void> {
  fixtureServer = await startFixture()
  /** 两个资产别名共享同一 endpoint，验证作用范围不会漏掉其中一项。 */
  const hosts: ServerOpsHost[] = ['fixture-one', 'fixture-two'].map((id) => ({
    id, name: id, address: '127.0.0.1', port: fixtureServer!.port, username: 'fixture',
    authMethod: 'password', tags: [], createdAt: 1, updatedAt: 1,
  }))
  const hostStore = { list: () => hosts, get: (hostId: string) => hosts.find((host) => host.id === hostId),
    setCredentialRef: () => { throw new Error('fixture does not persist secrets') },
  }
  const credentials = new ServerOpsCredentialStore(configDir)
  const trust = new ServerOpsHostTrustStore(configDir)
  const audit = new ServerOpsAuditStore(configDir)
  const revoked: string[] = []
  runtime = new ServerOpsRuntimeClient()
  connections = new ServerOpsConnectionService({ hosts: hostStore, credentials, trust, runtime,
    uuid: randomUUID, resolveSshAgent: () => { throw new Error('fixture never uses an SSH agent') },
    readPrivateKey: () => { throw new Error('fixture never reads private keys') },
  })
  trustService = new ServerOpsTrustService({ hosts: hostStore, trust, audit, connections,
    revokeHostAccess: (hostId) => { revoked.push(hostId) },
    transaction: createServerOpsConfigTransaction(join(configDir, 'server-ops')),
    acquireMutationGuard: async () => () => undefined,
  })
  /** 首次握手只有公开密钥，用户尚未批准时不会发送密码。 */
  const first = await connections.connect({ hostId: hosts[0]!.id, cols: 80, rows: 24,
    credential: { kind: 'password', password: 'fixture-password', remember: false },
  })
  assert.equal(first.phase, 'host-key-required')
  assert.equal(fixtureServer.attempts(), 0)
  assert(first.candidate)
  const confirmed = await connections.confirmHostKey({ hostId: hosts[0]!.id, candidateId: first.candidate.candidateId, cols: 80, rows: 24 })
  assert.equal(confirmed.phase, 'connected')
  const oldKey = trust.get(hosts[0]!)
  assert(oldKey)
  assert.equal(fixtureServer.attempts(), 1)
  connections.disconnect(hosts[0]!.id)
  /** 关闭 A 后在同一地址/端口启动 B，制造真实换钥场景。 */
  const port = fixtureServer.port
  await fixtureServer.close()
  fixtureServer = await startFixture(port)
  const changed = await connections.connect({ hostId: hosts[0]!.id, cols: 80, rows: 24 })
  assert.equal(changed.phase, 'blocked')
  assert.equal(fixtureServer.attempts(), 0)
  assert.deepEqual(trust.get(hosts[0]!), oldKey)
  const cancelled = trustService.prepare(7, { hostId: hosts[0]!.id, action: 'replace' })
  trustService.cancel(7, { hostId: hosts[0]!.id, candidateId: cancelled.candidateId })
  assert.equal(fixtureServer.attempts(), 0)
  await assert.rejects(trustService.commit(7, { hostId: hosts[0]!.id, candidateId: cancelled.candidateId, confirmationName: hosts[0]!.name }))
  const candidate = trustService.prepare(7, { hostId: hosts[0]!.id, action: 'replace' })
  const result = await trustService.commit(7, { hostId: hosts[0]!.id, candidateId: candidate.candidateId, confirmationName: hosts[0]!.name })
  assert.equal(result.warning, undefined)
  assert.deepEqual(new Set(revoked), new Set(hosts.map((host) => host.id)))
  assert.equal(fixtureServer.attempts(), 0)
  assert.equal(connections.getState(hosts[0]!.id).phase, 'disconnected')
  assert.equal((await connections.connect({ hostId: hosts[0]!.id, cols: 80, rows: 24 })).phase, 'connected')
  assert.equal(fixtureServer.attempts(), 1)
  const revoke = trustService.prepare(7, { hostId: hosts[0]!.id, action: 'revoke' })
  await trustService.commit(7, { hostId: hosts[0]!.id, candidateId: revoke.candidateId, confirmationName: hosts[0]!.name })
  assert.equal(trust.get(hosts[0]!), undefined)
  assert.equal((await connections.connect({ hostId: hosts[0]!.id, cols: 80, rows: 24 })).phase, 'host-key-required')
  assert.equal(fixtureServer.attempts(), 1)
  console.log('[Server Ops smoke] PASS: 真实换钥阻断、取消零认证、双别名撤权、替换后显式重连、撤销后重新确认')
}

mkdirSync(join(configDir, 'electron-user-data'))
app.setPath('userData', join(configDir, 'electron-user-data'))
/** 有界 smoke 超时强制收口，避免测试失败遗留进程。 */
const timeout = setTimeout(() => { console.error('[Server Ops smoke] timeout'); app.exit(1) }, 30_000)
void app.whenReady().then(runSmoke).then(() => finish(0), (error: unknown) => {
  console.error('[Server Ops smoke] failed', error)
  return finish(1)
})

/** 统一释放测试 SSH、utility、候选与临时文件，不影响用户应用实例。 */
async function finish(code: number): Promise<void> {
  clearTimeout(timeout)
  trustService?.dispose()
  connections?.dispose()
  runtime?.stop()
  await fixtureServer?.close()
  rmSync(configDir, { recursive: true, force: true })
  app.exit(code)
}
