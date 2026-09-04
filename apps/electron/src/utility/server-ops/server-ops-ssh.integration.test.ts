import { afterEach, describe, expect, test } from 'bun:test'
import { Client, Server, utils } from 'ssh2'
import type { AddressInfo } from 'node:net'
import { createHostKeyFingerprint } from './server-ops-runtime-core'

/** 当前测试启动的本地 SSH 服务端。 */
let server: Server | undefined

afterEach(async () => {
  /** 已监听服务端在用例结束后必须释放端口。 */
  const active = server
  server = undefined
  if (active?.listening) await new Promise<void>((resolve) => active.close(() => resolve()))
})

describe('服务器运维真实 SSH fixture', () => {
  test('首次拒绝 Host Key，确认后使用密码认证并交互 PTY', async () => {
    /** 临时 SSH 服务端使用的 ed25519 Host Key。 */
    const hostKey = utils.generateKeyPairSync('ed25519')
    /** 进入认证阶段的次数，用于证明未知指纹前不会发送密码。 */
    let passwordAttempts = 0
    server = new Server({ hostKeys: [hostKey.private] }, (client) => {
      client.on('authentication', (context) => {
        if (context.method === 'password') passwordAttempts += 1
        if (context.method === 'password' && context.username === 'deploy' && context.password === 'fixture-password') context.accept()
        else context.reject()
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          /** 当前客户端请求的 SSH session。 */
          const session = accept()
          session.on('pty', (acceptPty) => acceptPty())
          session.on('shell', (acceptShell) => {
            /** fixture 返回可交互回显的远程 shell channel。 */
            const stream = acceptShell()
            stream.write('fixture-ready\r\n')
            stream.on('data', (data: Buffer) => {
              stream.write(`echo:${data.toString()}`)
              if (data.toString().includes('exit')) stream.end()
            })
          })
        })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(0, '127.0.0.1', () => resolve())
    })
    /** 系统分配的本地 SSH fixture 端口。 */
    const port = (server.address() as AddressInfo).port
    /** 首次握手捕获的公开 Host Key。 */
    let observed = undefined as ReturnType<typeof createHostKeyFingerprint> | undefined

    await new Promise<void>((resolve) => {
      /** 第一次连接必须在 hostVerifier 阶段拒绝。 */
      const probe = new Client()
      probe.on('error', () => resolve())
      probe.on('close', () => resolve())
      probe.connect({
        host: '127.0.0.1',
        port,
        username: 'deploy',
        password: 'fixture-password',
        hostVerifier: (key: Buffer) => { observed = createHostKeyFingerprint(key); return false },
      })
    })
    expect(observed?.algorithm).toBe('ssh-ed25519')
    expect(passwordAttempts).toBe(0)

    /** 确认后的连接读取到的 PTY 输出。 */
    const output = await new Promise<string>((resolve, reject) => {
      /** 第二次连接使用已确认指纹和真实密码认证。 */
      const connection = new Client()
      let received = ''
      connection.on('ready', () => {
        connection.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (error, stream) => {
          if (error) { reject(error); return }
          stream.on('data', (data: Buffer) => {
            received += data.toString()
            if (received.includes('echo:uptime')) {
              stream.end('exit\r')
              connection.end()
              resolve(received)
            }
          })
          stream.write('uptime\r')
        })
      })
      connection.on('error', reject)
      connection.connect({
        host: '127.0.0.1',
        port,
        username: 'deploy',
        password: 'fixture-password',
        hostVerifier: (key: Buffer) => {
          /** 只有算法与指纹逐字段匹配才继续认证。 */
          const current = createHostKeyFingerprint(key)
          return current.algorithm === observed?.algorithm && current.fingerprint === observed.fingerprint
        },
      })
    })

    expect(passwordAttempts).toBe(1)
    expect(output).toContain('fixture-ready')
    expect(output).toContain('echo:uptime')
  }, 15_000)
})
