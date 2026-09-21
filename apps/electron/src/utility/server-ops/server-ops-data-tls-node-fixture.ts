import assert from 'node:assert/strict'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { runServerOpsDataRead } from './server-ops-data-runtime'
import { startMySqlTlsFixture } from './server-ops-data-tls-fixture'

/** 在 Electron 的 Node 环境验证真实 MySQL STARTTLS；Bun 只负责构建和启动此隔离夹具。 */
async function main(): Promise<void> {
  /** 根证书只在显式测试子进程中加载，不改变用户或系统信任设置。 */
  const trusted = process.argv[2] === 'trusted'
  /** 每种故障独占服务器，避免 TLS 会话缓存与旧连接干扰测试结论。 */
  const scenarios = trusted ? ['normal', 'broken-tls', 'auth-failed', 'stall'] as const : ['normal'] as const
  for (const scenario of scenarios) {
    /** 回环 MySQL 服务端仅实现认证和版本查询，不接触业务数据。 */
    const fixture = await startMySqlTlsFixture(scenario)
    /** 每个读取独占通道；计数能发现错误降级和隐式重试。 */
    let opened = 0
    /** TLS 升级直接发生在传入的 TCP 通道上，与 utility 的真实连接方式一致。 */
    const createChannel = (): Promise<Duplex> => new Promise((resolve, reject) => {
      opened += 1
      const socket = connect({ host: '127.0.0.1', port: fixture.port })
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
    /** 所有场景共用的无秘密参数。 */
    const input = { mode: 'probe' as const, engine: 'mysql' as const, address: '127.0.0.1', port: fixture.port }
    try {
      if (scenario === 'normal' && trusted) {
        for (const tlsMode of ['preferred', 'required', 'verify'] as const) {
          const result = await runServerOpsDataRead({ ...input, tlsMode, tlsServerName: 'db.test' }, createChannel)
          assert.equal(result.capability, 'available', JSON.stringify(result))
          assert.equal('tlsStatus' in result ? result.tlsStatus : undefined, tlsMode === 'verify' ? 'verified' : 'encrypted')
        }
        assert.equal(opened, 3)
        assert.equal(fixture.authenticatedCount(), 3)
        assert.equal(fixture.versionQueryCount(), 3)
        /** 证书链可信但 DNS 名不匹配：必须在任何认证材料发送前拒绝。 */
        const wrongName = await runServerOpsDataRead({ ...input, tlsMode: 'verify', tlsServerName: 'wrong.test' }, createChannel)
        assert.equal(wrongName.capability, 'tls-failed')
        assert.equal(fixture.authenticatedCount(), 3)
        assert.equal(opened, 4)
      } else if (scenario === 'normal') {
        /** 同一自签证书在非校验模式可加密连接，在 verify 模式必须失败。 */
        for (const tlsMode of ['preferred', 'required'] as const) {
          const result = await runServerOpsDataRead({ ...input, tlsMode }, createChannel)
          assert.equal(result.capability, 'available', JSON.stringify(result))
          assert.equal('tlsStatus' in result ? result.tlsStatus : undefined, 'encrypted')
        }
        const untrusted = await runServerOpsDataRead({ ...input, tlsMode: 'verify', tlsServerName: 'db.test' }, createChannel)
        assert.equal(untrusted.capability, 'tls-failed')
        assert.equal('tlsStatus' in untrusted ? untrusted.tlsStatus : undefined, undefined)
        assert.equal(fixture.authenticatedCount(), 2)
        assert.equal(fixture.versionQueryCount(), 2)
        assert.equal(opened, 3)
      } else if (scenario === 'stall') {
        /** 在 TLS 握手停滞时撤销，必须立即终止且不能再开明文通道。 */
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 100)
        const startedAt = performance.now()
        try {
          await assert.rejects(runServerOpsDataRead({ ...input, tlsMode: 'preferred' }, createChannel, controller.signal), /SERVER_OPS_DATA_CANCELLED/u)
          assert.ok(performance.now() - startedAt < 1_000)
          assert.equal(opened, 1)
          assert.equal(fixture.authenticatedCount(), 0)
        } finally { clearTimeout(timer) }
      } else {
        /** TLS/认证错误必须原路失败，不允许用新明文连接重试。 */
        const result = await runServerOpsDataRead({ ...input, tlsMode: 'preferred' }, createChannel)
        assert.equal(result.capability, scenario === 'broken-tls' ? 'tls-failed' : 'auth-failed', JSON.stringify(result))
        assert.equal(opened, 1)
        assert.equal(fixture.versionQueryCount(), 0)
      }
    } finally {
      await fixture.close()
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, trusted, scenarios }) + '\n')
}

void main().catch((error: unknown) => {
  process.stderr.write(String(error) + '\n')
  process.exitCode = 1
})
