import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect as connectTcp, createServer as createTcpServer, type AddressInfo, type Server } from 'node:net'
import type { Duplex } from 'node:stream'
import { createServer as createMySqlServer } from 'mysql2'
import { runServerOpsDataRead } from './server-ops-data-runtime'
import { startRedisTlsFixture } from './server-ops-data-tls-fixture'
import type { ServerOpsDataRuntimeNonQueryInput } from './server-ops-data-runtime'

/** mysql2 测试服务端在 TLS 回退场景实际使用的最小连接接口。 */
interface MySqlNoTlsFixtureConnection {
  sequenceId: number
  stream: Duplex
  on(event: 'query', listener: (sql: string) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  serverHandshake(options: {
    protocolVersion: number
    serverVersion: string
    connectionId: number
    statusFlags: number
    characterSet: number
    capabilityFlags: number
    authPluginName: string
    authCallback: (auth: unknown, callback: (error?: Error) => void) => void
  }): void
  writeColumns(columns: unknown[]): void
  writeTextRow(row: unknown[]): void
  writeEof(warnings?: number, statusFlags?: number): void
}

/** mysql2 测试服务端对外暴露的监听地址与关闭接口。 */
interface MySqlNoTlsFixtureServer {
  listen(port: number, host: string, callback: () => void): void
  close(callback: () => void): void
  _server: { address: () => AddressInfo | string | null }
}

/** 等待异步 socket close 通知，避免把事件循环调度差异误判为资源泄漏。 */
async function waitForTestCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

/** 写入 `SELECT VERSION()` 所需的最小 MySQL 文本结果，供 probe 建连验证使用。 */
function writeVersionResult(connection: MySqlNoTlsFixtureConnection): void {
  connection.sequenceId = 1
  connection.writeColumns([{
    catalog: 'def', schema: '', table: '', orgTable: '', name: 'version', orgName: 'version',
    characterSet: 45, columnLength: 128, columnType: 253, flags: 0, decimals: 0,
  }])
  connection.writeTextRow(['8.0.36-no-tls'])
  connection.writeEof(0, 2)
  connection.sequenceId = 0
}

/** 以类型绕过构造尚未实现的 TLS mode，用于先锁定 runtime 的公开行为。 */
function tlsInput(tlsMode: 'preferred' | 'required'): ServerOpsDataRuntimeNonQueryInput {
  return {
    mode: 'probe', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode,
  } as unknown as ServerOpsDataRuntimeNonQueryInput
}

describe('数据服务 TLS 协商边界', () => {
  test('Given Electron 真实 MySQL TLS When 加密、校验、认证失败或取消 Then 状态准确且失败不降级', async () => {
    /** 测试子进程产物独占临时目录，结束后移除。 */
    const directory = mkdtempSync(join(tmpdir(), 'proma-tls-node-'))
    /** 使用桌面实际使用的 Electron Node，避免 Bun 对原地 TLS 升级的兼容差异掩盖缺陷。 */
    const electronExecutable: unknown = createRequire(import.meta.url)('electron')
    if (typeof electronExecutable !== 'string') throw new Error('TEST_ELECTRON_EXECUTABLE_MISSING')
    try {
      /** 全仓长进程会让 Bun 内嵌打包器把普通源文件误判为目录；独立进程保留相同构建参数。 */
      const buildOptions = {
        entrypoints: [resolve(import.meta.dir, 'server-ops-data-tls-node-fixture.ts')],
        target: 'node', format: 'cjs', external: ['mysql2', 'ioredis'],
        outdir: directory, naming: 'tls-fixture.cjs',
        define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve(import.meta.dir, 'server-ops-data-tls-fixture.ts')).href) },
      }
      /** 测试入口与项目代码仍由 Bun 构建；驱动继续使用项目已锁定版本。 */
      const buildCode = `const result = await Bun.build(${JSON.stringify(buildOptions)}); if (!result.success) { console.error(...result.logs); process.exit(1) }`
      const build = Bun.spawn([process.execPath, '-e', buildCode], { stdout: 'pipe', stderr: 'pipe' })
      /** 即使打包器卡住，也要终止测试子进程并释放临时目录。 */
      const buildTimer = setTimeout(() => build.kill(), 10_000)
      try {
        const [exitCode, , stderr] = await Promise.all([
          build.exited, new Response(build.stdout).text(), new Response(build.stderr).text(),
        ])
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
      } finally {
        clearTimeout(buildTimer)
        build.kill()
      }
      for (const trusted of [false, true]) {
        /** 只给受控测试子进程加载测试 CA，系统与用户数据库信任设置保持独立。 */
        const child = Bun.spawn([electronExecutable, join(directory, 'tls-fixture.cjs'), trusted ? 'trusted' : 'untrusted'], {
          env: {
            ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_TLS_REJECT_UNAUTHORIZED: '1',
            NODE_PATH: resolve(import.meta.dir, '../../../node_modules'),
            NODE_EXTRA_CA_CERTS: trusted ? resolve(import.meta.dir, 'fixtures/server-ops-tls-fixture-cert.pem') : '',
          },
          stdout: 'pipe', stderr: 'pipe',
        })
        /** 夹具本身发生回归时也不能遗留测试进程。 */
        const timer = setTimeout(() => child.kill(), 10_000)
        try {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
          ])
          expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
          expect(JSON.parse(stdout)).toMatchObject({ ok: true, trusted })
        } finally {
          clearTimeout(timer)
          child.kill()
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 25_000)

  test('Given preferred MySQL 遇到明确无 TLS 服务端 When probe Then 认证前关闭首次通道并仅以新通道明文执行一次查询', async () => {
    /** 第一次 TLS 探测不应通过认证；第二次明文连接才会出现一次认证。 */
    let authenticationCount = 0
    /** 每次 factory 调用必须对应全新的 TCP 通道，证明不会复用失败的 TLS stream。 */
    let openedChannels = 0
    /** 服务端只应收到 fallback 后的一条 version 查询，不能发生查询重放。 */
    let versionQueryCount = 0
    /** 首次 TLS 探测失败后应关闭旧通道，防止 SSH 转发和 socket 泄漏。 */
    let closedChannels = 0
    const server = createMySqlServer((connectionValue) => {
      const connection = connectionValue as unknown as MySqlNoTlsFixtureConnection
      connection.on('error', () => undefined)
      connection.stream.once('close', () => { closedChannels += 1 })
      connection.on('query', (sql) => {
        if (sql === 'SELECT VERSION() AS version') {
          versionQueryCount += 1
          writeVersionResult(connection)
        }
      })
      connection.serverHandshake({
        protocolVersion: 10,
        serverVersion: '8.0.36-no-tls',
        connectionId: openedChannels + 1,
        statusFlags: 2,
        characterSet: 45,
        /** 刻意不声明 CLIENT_SSL，让 mysql2 在发送认证材料前报 HANDSHAKE_NO_SSL_SUPPORT。 */
        capabilityFlags: 1 | 4 | 8 | 512 | 8_192 | 32_768 | 524_288,
        authPluginName: 'mysql_native_password',
        authCallback: (_auth, callback) => { authenticationCount += 1; callback(); connection.sequenceId = 0 },
      })
    }) as unknown as MySqlNoTlsFixtureServer
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server._server.address()
    if (address === null || typeof address === 'string') throw new Error('TEST_MYSQL_TLS_FIXTURE_ADDRESS_MISSING')
    /** 每次尝试建立独立 socket，模拟 production 每次 SSH 转发均为独立通道。 */
    const createChannel = async (): Promise<Duplex> => await new Promise<Duplex>((resolve, reject) => {
      openedChannels += 1
      const socket = connectTcp({ host: '127.0.0.1', port: address.port })
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
    try {
      const result = await runServerOpsDataRead(tlsInput('preferred'), createChannel)
      expect(openedChannels).toBe(2)
      expect(authenticationCount).toBe(1)
      expect(versionQueryCount).toBe(1)
      await waitForTestCondition(() => closedChannels >= 2, 'TEST_MYSQL_PREFERRED_CHANNELS_NOT_CLOSED')
      expect(closedChannels).toBeGreaterThanOrEqual(2)
      expect(result).toMatchObject({ capability: 'available', serverVersion: '8.0.36-no-tls', tlsStatus: 'plaintext' })
    } finally {
      await new Promise<void>((resolve) => server.close(resolve))
    }
  })

  test('Given required MySQL 遇到明确无 TLS 服务端 When probe Then 拒绝且绝不认证或明文回退', async () => {
    /** TLS required 在服务端不支持 TLS 时不得退回第二条明文连接。 */
    let authenticationCount = 0
    let openedChannels = 0
    const server = createMySqlServer((connectionValue) => {
      const connection = connectionValue as unknown as MySqlNoTlsFixtureConnection
      connection.on('error', () => undefined)
      connection.serverHandshake({
        protocolVersion: 10,
        serverVersion: '8.0.36-no-tls',
        connectionId: openedChannels + 1,
        statusFlags: 2,
        characterSet: 45,
        capabilityFlags: 1 | 4 | 8 | 512 | 8_192 | 32_768 | 524_288,
        authPluginName: 'mysql_native_password',
        authCallback: (_auth, callback) => { authenticationCount += 1; callback(); connection.sequenceId = 0 },
      })
    }) as unknown as MySqlNoTlsFixtureServer
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server._server.address()
    if (address === null || typeof address === 'string') throw new Error('TEST_MYSQL_TLS_FIXTURE_ADDRESS_MISSING')
    const createChannel = async (): Promise<Duplex> => await new Promise<Duplex>((resolve, reject) => {
      openedChannels += 1
      const socket = connectTcp({ host: '127.0.0.1', port: address.port })
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
    try {
      const result = await runServerOpsDataRead(tlsInput('required'), createChannel)
      expect(openedChannels).toBe(1)
      expect(authenticationCount).toBe(0)
      expect(result).toMatchObject({ capability: 'tls-failed' })
    } finally {
      await new Promise<void>((resolve) => server.close(resolve))
    }
  })

  test('Given preferred 的首次握手耗时 When 回退后的连接继续等待 Then 两次尝试共用 15 秒总预算', async () => {
    /** 首次服务端延迟宣告无 TLS，使第二次连接只能使用剩余总时限。 */
    let connectionOrdinal = 0
    let openedChannels = 0
    const server = createMySqlServer((connectionValue) => {
      const connection = connectionValue as unknown as MySqlNoTlsFixtureConnection
      connectionOrdinal += 1
      const ordinal = connectionOrdinal
      connection.on('error', () => undefined)
      if (ordinal === 2) {
        /** 第二次明文连接在剩余预算内完成认证，但故意不回 version 结果以等待总时限。 */
        connection.on('query', () => undefined)
        setTimeout(() => {
          connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36-stalled-query',
            connectionId: ordinal,
            statusFlags: 2,
            characterSet: 45,
            capabilityFlags: 1 | 4 | 8 | 512 | 8_192 | 32_768 | 524_288,
            authPluginName: 'mysql_native_password',
            authCallback: (_auth, callback) => callback(),
          })
        }, 4_000)
        return
      }
      if (ordinal !== 1) return
      setTimeout(() => {
        connection.serverHandshake({
          protocolVersion: 10,
          serverVersion: '8.0.36-delayed-no-tls',
          connectionId: ordinal,
          statusFlags: 2,
          characterSet: 45,
          capabilityFlags: 1 | 4 | 8 | 512 | 8_192 | 32_768 | 524_288,
          authPluginName: 'mysql_native_password',
          authCallback: (_auth, callback) => callback(),
        })
      }, 3_000)
    }) as unknown as MySqlNoTlsFixtureServer
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server._server.address()
    if (address === null || typeof address === 'string') throw new Error('TEST_MYSQL_TLS_FIXTURE_ADDRESS_MISSING')
    const createChannel = async (): Promise<Duplex> => await new Promise<Duplex>((resolve, reject) => {
      openedChannels += 1
      const socket = connectTcp({ host: '127.0.0.1', port: address.port })
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
    try {
      const startedAt = Date.now()
      const result = await runServerOpsDataRead(tlsInput('preferred'), createChannel)
      const elapsedMs = Date.now() - startedAt
      expect(result).toMatchObject({ capability: 'timeout' })
      expect(openedChannels).toBe(2)
      /** 总时限允许事件循环调度余量，但绝不允许首次 3 秒后再获得完整 15 秒。 */
      expect(elapsedMs).toBeGreaterThanOrEqual(14_000)
      expect(elapsedMs).toBeLessThan(17_000)
    } finally {
      await new Promise<void>((resolve) => server.close(resolve))
    }
  }, 20_000)

  test('Given Redis preferred When 读取 Then 在建立通道前拒绝不支持的协商模式', async () => {
    /** Redis 协议没有 STARTTLS 与 capability 协商，runtime 必须在副作用前拒绝该配置。 */
    let opened = false
    const input = {
      mode: 'probe', engine: 'redis', address: '127.0.0.1', port: 6379, tlsMode: 'preferred',
    } as unknown as ServerOpsDataRuntimeNonQueryInput
    await expect(runServerOpsDataRead(input, async () => {
      opened = true
      throw new Error('TEST_REDIS_CHANNEL_MUST_NOT_OPEN')
    })).rejects.toThrow('SERVER_OPS_DATA_TLS_MODE_UNSUPPORTED')
    expect(opened).toBe(false)
  })

  test('Given MySQL verify 使用 IP 作为证书主机名 When 读取 Then 在建立通道前拒绝', async () => {
    /** mysql2 不会对 IP 发送 SNI；认证后的补检会晚于密码发送，因此合同只接受证书 DNS 名。 */
    let opened = false
    await expect(runServerOpsDataRead({
      mode: 'probe', engine: 'mysql', address: '127.0.0.1', port: 3306,
      tlsMode: 'verify', tlsServerName: '127.0.0.1',
    }, async () => {
      opened = true
      throw new Error('TEST_MYSQL_IP_TLS_CHANNEL_MUST_NOT_OPEN')
    })).rejects.toThrow('SERVER_OPS_DATA_TLS_SERVER_NAME_REQUIRED')
    expect(opened).toBe(false)
  })

  test('Given 支持 TLS 的 Redis When required probe Then 实际 TLS stream 返回 encrypted', async () => {
    const fixture = await startRedisTlsFixture()
    /** Redis 连接器同样只获得当前读取独占的 TCP stream。 */
    const createChannel = async (): Promise<Duplex> => await new Promise<Duplex>((resolve, reject) => {
      const socket = connectTcp({ host: '127.0.0.1', port: fixture.port })
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
    try {
      const result = await runServerOpsDataRead({
        mode: 'probe', engine: 'redis', address: '127.0.0.1', port: fixture.port, tlsMode: 'required',
      }, createChannel)
      expect(result).toMatchObject({ capability: 'available', serverVersion: '7.2.4', tlsStatus: 'encrypted' })
      expect(fixture.infoCommandCount()).toBe(1)
    } finally {
      await fixture.close()
    }
  })

  test('Given 自签名 Redis TLS When verify probe Then 证书失败且不会报告 encrypted', async () => {
    const fixture = await startRedisTlsFixture()
    /** verify 必须校验证书链；required 的宽松身份策略不得复用到 verify。 */
    const createChannel = async (): Promise<Duplex> => await new Promise<Duplex>((resolve, reject) => {
      const socket = connectTcp({ host: '127.0.0.1', port: fixture.port })
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
    try {
      const result = await runServerOpsDataRead({
        mode: 'probe', engine: 'redis', address: '127.0.0.1', port: fixture.port,
        tlsMode: 'verify', tlsServerName: 'db.test',
      }, createChannel)
      expect(result).toMatchObject({ capability: 'tls-failed' })
      expect('tlsStatus' in result ? result.tlsStatus : undefined).toBeUndefined()
      expect(fixture.infoCommandCount()).toBe(0)
    } finally {
      await fixture.close()
    }
  })
})
