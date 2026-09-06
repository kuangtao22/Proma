import { afterEach, describe, expect, test } from 'bun:test'
import { Client, Server, utils } from 'ssh2'
import type { AddressInfo } from 'node:net'
import type { ServerOpsRuntimeMessage } from './server-ops-runtime-protocol'
import {
  createHostKeyFingerprint,
  createRuntimeLogStreamController,
  type ServerOpsRuntimeManagedLogStream,
} from './server-ops-runtime-core'

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

  test('journal 日志经 ACK 放行第二批，stop 后关闭 channel 且无第三批', async () => {
    /** 本地 fixture 只接受的固定 journalctl 命令。 */
    const journalCommand = "LC_ALL=C journalctl --no-pager --output=short-iso-precise --priority=info --lines=100 --boot --follow"
    /** 首批精确达到 32 KiB，促使 runtime 立即 flush。 */
    const firstPrefix = '第一批中文日志\n'
    const firstBatch = firstPrefix + 'x'.repeat(32 * 1_024 - Buffer.byteLength(firstPrefix, 'utf8'))
    /** ACK 后才能发出的第二批。 */
    const secondBatch = '第二批中文日志\n'
    /** 观察 stop 是否主动关闭真实 client channel。 */
    let channelClosed = false
    /** 临时 SSH 服务端使用的 Host Key。 */
    const hostKey = utils.generateKeyPairSync('ed25519')
    server = new Server({ hostKeys: [hostKey.private] }, (client) => {
      client.on('authentication', (context) => {
        if (context.method === 'password' && context.username === 'deploy' && context.password === 'fixture-password') context.accept()
        else context.reject()
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('exec', (acceptExec, rejectExec, info) => {
            if (info.command !== journalCommand) { rejectExec(); return }
            /** 模拟 journalctl --follow 的长生命 channel。 */
            const stream = acceptExec()
            stream.write(firstBatch)
            setTimeout(() => stream.write(secondBatch), 20)
            setTimeout(() => {
              if (stream.destroyed || !stream.writable) return
              stream.write('第三批不应可见\n')
            }, 200)
          })
        })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    /** runtime 控制器对外发布的协议消息。 */
    const messages: ServerOpsRuntimeMessage[] = []
    /** 真实 SSH client 连接。 */
    const connection = new Client()
    await new Promise<void>((resolve, reject) => {
      connection.once('ready', resolve)
      connection.once('error', reject)
      connection.connect({ host: '127.0.0.1', port, username: 'deploy', password: 'fixture-password', hostVerifier: () => true })
    })
    /** 真实 ssh2 exec channel 上的日志流 Map。 */
    const streams = new Map<string, ServerOpsRuntimeManagedLogStream<ReturnType<typeof setTimeout>>>()
    const controller = createRuntimeLogStreamController<ReturnType<typeof setTimeout>>({
      hostId: 'host-1',
      connectionId: 'connection-1',
      streams,
      execute: (command, callback) => {
        connection.exec(command, (error, channel) => {
          if (error) { callback(error); return }
          callback(undefined, {
            onData: (listener) => { channel.on('data', listener) },
            onStderrData: (listener) => { channel.stderr.on('data', listener) },
            onceError: (listener) => { channel.once('error', listener) },
            onceClose: (listener) => { channel.once('close', listener) },
            close: () => { channel.close(); channelClosed = true },
          })
        })
      },
      post: (message) => { messages.push(message) },
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (timer) => clearTimeout(timer),
    })
    /** 测试日志流的完整内部身份。 */
    const identity = { hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' }
    controller.start({ ...identity, command: journalCommand })
    await waitForRuntimeMessage(messages, (message) => message.type === 'server-ops.log-started')
    const firstChunk = await waitForRuntimeMessage(messages, (message) => message.type === 'server-ops.log-chunk')
    if (firstChunk.type !== 'server-ops.log-chunk') throw new Error('SERVER_OPS_TEST_MESSAGE_INVALID')
    expect(firstChunk.data).toContain('第一批中文日志')

    await new Promise<void>((resolve) => setTimeout(resolve, 40))
    expect(messages.filter((message) => message.type === 'server-ops.log-chunk')).toHaveLength(1)
    expect(controller.ack({ ...identity, sequence: firstChunk.sequence })).toBe(true)
    const secondChunk = await waitForRuntimeMessage(messages, (message) => message.type === 'server-ops.log-chunk' && message.sequence !== firstChunk.sequence)
    if (secondChunk.type !== 'server-ops.log-chunk') throw new Error('SERVER_OPS_TEST_MESSAGE_INVALID')
    expect(secondChunk.data).toContain('第二批中文日志')

    controller.stop(identity)
    await waitForRuntimeMessage(messages, (message) => message.type === 'server-ops.log-exit' && message.reason === 'stopped')
    await new Promise<void>((resolve) => setTimeout(resolve, 240))
    expect(channelClosed).toBe(true)
    expect(messages.filter((message) => message.type === 'server-ops.log-chunk')).toHaveLength(2)
    connection.end()
  }, 15_000)
})

/** 等待真实 SSH 异步流发布符合条件的协议消息。 */
async function waitForRuntimeMessage(
  messages: ServerOpsRuntimeMessage[],
  predicate: (message: ServerOpsRuntimeMessage) => boolean,
): Promise<ServerOpsRuntimeMessage> {
  /** 回环 fixture 的最长等待截止时间。 */
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const message = messages.find(predicate)
    if (message) return message
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('SERVER_OPS_TEST_MESSAGE_TIMEOUT')
}
