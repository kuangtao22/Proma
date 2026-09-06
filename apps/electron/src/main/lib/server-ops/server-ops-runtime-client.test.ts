import { describe, expect, test } from 'bun:test'
import type {
  ServerOpsRuntimeMessage,
  ServerOpsRuntimeRequest,
} from '../../../utility/server-ops/server-ops-runtime-protocol'
import {
  ServerOpsRuntimeClient,
  type ServerOpsRuntimeClientDependencies,
  type ServerOpsRuntimePort,
  type ServerOpsRuntimeProcess,
} from './server-ops-runtime-client'

/** 可由测试主动投递 runtime 消息的内存端口。 */
class TestRuntimePort implements ServerOpsRuntimePort {
  readonly messages: ServerOpsRuntimeRequest[] = []
  private listener: ((event: { data: unknown }) => void) | undefined

  close(): void {}

  start(): void {}

  postMessage(message: ServerOpsRuntimeRequest): void {
    this.messages.push(message)
  }

  on(_event: 'message', listener: (event: { data: unknown }) => void): void {
    this.listener = listener
  }

  /** 模拟 utility runtime 向主进程返回结构化消息。 */
  emit(message: ServerOpsRuntimeMessage): void {
    this.listener?.({ data: message })
  }

  /** 模拟被篡改或版本不兼容的 utility runtime 原始消息。 */
  emitUnknown(message: unknown): void {
    this.listener?.({ data: message })
  }
}

/** 可由测试主动触发退出和错误事件的 utility process。 */
class TestRuntimeProcess implements ServerOpsRuntimeProcess {
  readonly bootMessages: unknown[] = []
  /** 测试观察到的 kill 调用次数。 */
  killCalls = 0
  /** 模拟 Electron kill 同步抛错。 */
  throwOnKill = false
  private readonly listeners = new Map<'error' | 'exit', Array<() => void>>()

  kill(): boolean {
    this.killCalls += 1
    if (this.throwOnKill) throw new Error('TEST_RUNTIME_KILL_FAILED')
    return true
  }

  postMessage(message: unknown): void {
    this.bootMessages.push(message)
  }

  on(event: 'error' | 'exit', listener: () => void): void {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
  }

  /** 模拟 utility process 生命周期事件。 */
  emit(event: 'error' | 'exit'): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
}

/** 创建可完全观察且不启动真实 Electron 子进程的 runtime client。 */
function createFixture(options: { logStartTimeoutMs?: number; maxUsedLogStreamIds?: number } = {}) {
  const port = new TestRuntimePort()
  const runtimeProcess = new TestRuntimeProcess()
  const requestIds = ['connect-1', 'exec-1', 'exec-2', 'exec-3', 'exec-4']
  let createProcessCalls = 0
  const dependencies: ServerOpsRuntimeClientDependencies = {
    createProcess: () => {
      createProcessCalls += 1
      return runtimeProcess
    },
    createChannel: () => ({ port1: {}, port2: port }),
    uuid: () => requestIds.shift() ?? 'request-fallback',
    ...options,
  }
  return {
    client: new ServerOpsRuntimeClient(dependencies),
    port,
    runtimeProcess,
    getCreateProcessCalls: () => createProcessCalls,
  }
}

/** 创建可重启 runtime 且保留旧 port/process 的代次 fixture。 */
function createRotatingFixture(options: { logStartTimeoutMs?: number; maxUsedLogStreamIds?: number } = {}) {
  /** 每次 runtime 启动生成的独立端口。 */
  const ports: TestRuntimePort[] = []
  /** 每次 runtime 启动生成的独立进程。 */
  const processes: TestRuntimeProcess[] = []
  /** 连接请求的稳定 ID 序列。 */
  let nextRequestId = 0
  const dependencies: ServerOpsRuntimeClientDependencies = {
    createProcess: () => {
      const runtimeProcess = new TestRuntimeProcess()
      processes.push(runtimeProcess)
      return runtimeProcess
    },
    createChannel: () => {
      const port = new TestRuntimePort()
      ports.push(port)
      return { port1: {}, port2: port }
    },
    uuid: () => `connect-${++nextRequestId}`,
    ...options,
  }
  return { client: new ServerOpsRuntimeClient(dependencies), ports, processes }
}

/** 等待 async start/exec 越过一次真实事件循环边界。 */
async function flushRuntimeClient(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** 建立一个被 client 记录为 active 的测试连接。 */
async function connectFixture(fixture: ReturnType<typeof createFixture>): Promise<void> {
  const connecting = fixture.client.connect({
    hostId: 'host-1',
    connectionId: 'connection-1',
    address: '10.0.0.8',
    port: 22,
    username: 'deploy',
    authentication: { kind: 'ssh-agent', agent: '/tmp/agent.sock' },
    cols: 80,
    rows: 24,
  })
  fixture.port.emit({ type: 'server-ops.ready', pid: 100 })
  await flushRuntimeClient()
  fixture.port.emit({
    type: 'server-ops.connect-result',
    requestId: 'connect-1',
    hostId: 'host-1',
    connectionId: 'connection-1',
    result: {
      status: 'connected',
      hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' },
    },
  })
  await connecting
}

/** 在指定代次端口上建立测试连接。 */
async function connectRotatingFixture(
  fixture: ReturnType<typeof createRotatingFixture>,
  expectedPortIndex: number,
  requestId: string,
): Promise<TestRuntimePort> {
  const connecting = fixture.client.connect({
    hostId: 'host-1', connectionId: 'connection-1', address: '10.0.0.8', port: 22, username: 'deploy',
    authentication: { kind: 'ssh-agent', agent: '/tmp/agent.sock' }, cols: 80, rows: 24,
  })
  const port = fixture.ports[expectedPortIndex]
  if (!port) throw new Error('SERVER_OPS_TEST_PORT_MISSING')
  port.emit({ type: 'server-ops.ready', pid: 100 + expectedPortIndex })
  await flushRuntimeClient()
  port.emit({
    type: 'server-ops.connect-result', requestId, hostId: 'host-1', connectionId: 'connection-1',
    result: { status: 'connected', hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' } },
  })
  await connecting
  return port
}

describe('服务器运维 runtime client exec', () => {
  test('已连接后按 requestId 返回结构化 exec 结果', async () => {
    const fixture = createFixture()
    await connectFixture(fixture)

    const executing = fixture.client.exec('host-1', 'connection-1', 'uname -a', 1_000)
    await flushRuntimeClient()
    expect(fixture.port.messages.at(-1)).toEqual({
      type: 'server-ops.exec',
      input: {
        requestId: 'exec-1',
        hostId: 'host-1',
        connectionId: 'connection-1',
        command: 'uname -a',
        timeoutMs: 1_000,
      },
    })
    fixture.port.emit({
      type: 'server-ops.exec-result',
      requestId: 'exec-1',
      hostId: 'host-1',
      connectionId: 'connection-1',
      result: { stdout: 'Linux\n', stderr: '', exitCode: 0, truncated: false },
    })

    await expect(executing).resolves.toEqual({ stdout: 'Linux\n', stderr: '', exitCode: 0, truncated: false })
  })

  test('runtime 错误、主动断开和 terminal exit 都拒绝对应 pending exec', async () => {
    const fixture = createFixture()
    await connectFixture(fixture)

    const failed = fixture.client.exec('host-1', 'connection-1', 'false', 1_000)
    await flushRuntimeClient()
    fixture.port.emit({
      type: 'server-ops.error',
      requestId: 'exec-1',
      hostId: 'host-1',
      connectionId: 'connection-1',
      code: 'SERVER_OPS_EXEC_FAILED',
      message: '远程命令执行失败',
    })
    await expect(failed).rejects.toMatchObject({ code: 'SERVER_OPS_EXEC_FAILED' })

    const disconnected = fixture.client.exec('host-1', 'connection-1', 'uptime', 1_000)
    await flushRuntimeClient()
    fixture.client.disconnect('host-1', 'connection-1')
    await expect(disconnected).rejects.toMatchObject({ code: 'SERVER_OPS_CONNECTION_CLOSED' })

    await expect(fixture.client.exec('host-1', 'connection-1', 'uptime', 1_000))
      .rejects.toMatchObject({ code: 'SERVER_OPS_CONNECTION_NOT_ACTIVE' })
  })

  test('terminal exit 与 runtime exit 清理 pending，stale connection 不启动 runtime', async () => {
    const terminalFixture = createFixture()
    await connectFixture(terminalFixture)
    const terminalExit = terminalFixture.client.exec('host-1', 'connection-1', 'uptime', 1_000)
    await flushRuntimeClient()
    terminalFixture.port.emit({
      type: 'server-ops.terminal-exit',
      event: { hostId: 'host-1', connectionId: 'connection-1', message: '远程连接已关闭' },
    })
    await expect(terminalExit).rejects.toMatchObject({ code: 'SERVER_OPS_CONNECTION_CLOSED' })

    const runtimeFixture = createFixture()
    await connectFixture(runtimeFixture)
    const runtimeExit = runtimeFixture.client.exec('host-1', 'connection-1', 'uptime', 1_000)
    await flushRuntimeClient()
    runtimeFixture.runtimeProcess.emit('exit')
    await expect(runtimeExit).rejects.toMatchObject({ code: 'SERVER_OPS_RUNTIME_FAILED' })

    const staleFixture = createFixture()
    await expect(staleFixture.client.exec('host-1', 'missing', 'uptime', 1_000))
      .rejects.toMatchObject({ code: 'SERVER_OPS_CONNECTION_NOT_ACTIVE' })
    expect(staleFixture.getCreateProcessCalls()).toBe(0)
  })

  test('畸形或归属不匹配的结果不会完成错误 pending', async () => {
    const fixture = createFixture()
    const connecting = fixture.client.connect({
      hostId: 'host-1',
      connectionId: 'connection-1',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authentication: { kind: 'ssh-agent', agent: '/tmp/agent.sock' },
      cols: 80,
      rows: 24,
    })
    fixture.port.emit({ type: 'server-ops.ready', pid: 100 })
    await flushRuntimeClient()
    let connectSettled = false
    void connecting.finally(() => { connectSettled = true })
    fixture.port.emit({
      type: 'server-ops.connect-result',
      requestId: 'connect-1',
      hostId: 'host-attacker',
      connectionId: 'connection-1',
      result: { status: 'connected', hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' } },
    })
    await flushRuntimeClient()
    expect(connectSettled).toBe(false)

    fixture.port.emit({
      type: 'server-ops.connect-result',
      requestId: 'connect-1',
      hostId: 'host-1',
      connectionId: 'connection-1',
      result: { status: 'connected', hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' } },
    })
    await connecting

    const executing = fixture.client.exec('host-1', 'connection-1', 'uname -a', 1_000)
    await flushRuntimeClient()
    let execSettled = false
    void executing.finally(() => { execSettled = true })
    fixture.port.emitUnknown({
      type: 'server-ops.exec-result',
      requestId: 'exec-1',
      hostId: 'host-1',
      connectionId: 'connection-1',
      result: { stdout: 'forged', stderr: '', truncated: false, extra: true },
    })
    fixture.port.emit({
      type: 'server-ops.error',
      requestId: 'exec-1',
      hostId: 'host-attacker',
      connectionId: 'connection-1',
      code: 'SERVER_OPS_EXEC_FAILED',
      message: '伪造失败',
    })
    await flushRuntimeClient()
    expect(execSettled).toBe(false)

    fixture.port.emit({
      type: 'server-ops.exec-result',
      requestId: 'exec-1',
      hostId: 'host-1',
      connectionId: 'connection-1',
      result: { stdout: 'Linux\n', stderr: '', exitCode: 0, truncated: false },
    })
    await expect(executing).resolves.toMatchObject({ stdout: 'Linux\n' })
  })

  test('畸形或错误归属的流事件不会通知订阅者或污染连接表', async () => {
    const fixture = createFixture()
    await connectFixture(fixture)
    const outputs: string[] = []
    const exits: string[] = []
    fixture.client.onOutput((event) => outputs.push(event.data))
    fixture.client.onExit((event) => exits.push(event.hostId))

    fixture.port.emitUnknown({
      type: 'server-ops.terminal-output',
      event: { hostId: 'host-1', connectionId: 'connection-1', sequence: 1, data: 'forged', extra: true },
    })
    fixture.port.emit({
      type: 'server-ops.terminal-exit',
      event: { hostId: 'host-attacker', connectionId: 'connection-1', message: '伪造退出' },
    })
    await flushRuntimeClient()
    expect(outputs).toEqual([])
    expect(exits).toEqual([])

    const executing = fixture.client.exec('host-1', 'connection-1', 'pwd', 1_000)
    await flushRuntimeClient()
    expect(fixture.port.messages.at(-1)?.type).toBe('server-ops.exec')
    fixture.port.emit({
      type: 'server-ops.exec-result',
      requestId: 'exec-1',
      hostId: 'host-1',
      connectionId: 'connection-1',
      result: { stdout: '/srv\n', stderr: '', exitCode: 0, truncated: false },
    })
    await executing
  })
})

describe('服务器运维 runtime client 日志流', () => {
  test('Given 非法资源配置 When 创建 client Then 在启动 runtime 前稳定拒绝', () => {
    /** 构造 client 所需但不应实际执行的基础依赖。 */
    const dependencies: ServerOpsRuntimeClientDependencies = {
      createProcess: () => new TestRuntimeProcess(),
      createChannel: () => ({ port1: {}, port2: new TestRuntimePort() }),
      uuid: () => 'unused',
    }

    expect(() => new ServerOpsRuntimeClient({ ...dependencies, logStartTimeoutMs: 0 }))
      .toThrow('Server Ops runtime 配置无效')
    expect(() => new ServerOpsRuntimeClient({ ...dependencies, logStartTimeoutMs: 1.5 }))
      .toThrow('Server Ops runtime 配置无效')
    expect(() => new ServerOpsRuntimeClient({ ...dependencies, maxUsedLogStreamIds: 1_000_001 }))
      .toThrow('Server Ops runtime 配置无效')
  })

  test('Given 已连接 When 启动日志 Then 只在 utility 返回 started 后完成', async () => {
    const fixture = createFixture()
    await connectFixture(fixture)

    /** 保持在途的日志启动 Promise。 */
    const starting = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    let settled = false
    void starting.finally(() => { settled = true })
    await flushRuntimeClient()

    expect(fixture.port.messages.at(-1)).toEqual({
      type: 'server-ops.log-start',
      input: { hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1', command: 'journalctl --follow' },
    })
    expect(settled).toBe(false)

    fixture.port.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    await expect(starting).resolves.toBeUndefined()
  })

  test('Given pending 日志启动 When stop、disconnect 或 runtime failure Then 稳定拒绝并只退出一次', async () => {
    const stoppedFixture = createFixture()
    await connectFixture(stoppedFixture)
    const stopped = stoppedFixture.client.startLog('host-1', 'connection-1', 'stream-stop', 'journalctl --follow')
    stoppedFixture.client.stopLog('host-1', 'connection-1', 'stream-stop')
    await expect(stopped).rejects.toMatchObject({ code: 'SERVER_OPS_LOG_STOPPED' })

    const disconnectedFixture = createFixture()
    await connectFixture(disconnectedFixture)
    const disconnected = disconnectedFixture.client.startLog('host-1', 'connection-1', 'stream-disconnect', 'journalctl --follow')
    disconnectedFixture.client.disconnect('host-1', 'connection-1')
    await expect(disconnected).rejects.toMatchObject({ code: 'SERVER_OPS_CONNECTION_CLOSED' })

    const failedFixture = createFixture()
    await connectFixture(failedFixture)
    const failed = failedFixture.client.startLog('host-1', 'connection-1', 'stream-failed', 'journalctl --follow')
    failedFixture.runtimeProcess.emit('exit')
    await expect(failed).rejects.toMatchObject({ code: 'SERVER_OPS_RUNTIME_FAILED' })
  })

  test('Given active 日志流 When 连接被接管 Then stale chunk 不通知且 ACK 不下发', async () => {
    const fixture = createFixture()
    await connectFixture(fixture)
    const starting = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    fixture.port.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    await starting
    /** 订阅者收到的有效日志数据。 */
    const chunks: string[] = []
    fixture.client.onLogOutput((event) => chunks.push(event.data))

    fixture.client.disconnect('host-1', 'connection-1')
    fixture.port.emit({ type: 'server-ops.log-chunk', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1', sequence: 0, data: 'stale' })
    fixture.client.acknowledgeLog('host-1', 'connection-1', 'stream-1', 0)

    expect(chunks).toEqual([])
    expect(fixture.port.messages.some((message) => message.type === 'server-ops.log-ack')).toBe(false)
  })

  test('Given pending 日志流 When 伪造 host 停止 Then 不下发 stop 且真实 started 仍可完成', async () => {
    const fixture = createFixture()
    await connectFixture(fixture)
    const starting = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')

    fixture.client.stopLog('host-attacker', 'connection-1', 'stream-1')
    expect(fixture.port.messages.some((message) => message.type === 'server-ops.log-stop')).toBe(false)

    fixture.port.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    await expect(starting).resolves.toBeUndefined()
  })

  test('Given 合法 active connectionId When 错误 host 请求 disconnect Then 整次无副作用', async () => {
    const fixture = createFixture()
    await connectFixture(fixture)
    /** 伪造断开期间仍应保留的 pending 日志启动。 */
    const starting = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    /** 日志流成功后实际收到的输出。 */
    const outputs: string[] = []
    fixture.client.onLogOutput((event) => outputs.push(event.data))

    fixture.client.disconnect('host-attacker', 'connection-1')
    expect(fixture.port.messages.some((message) => message.type === 'server-ops.disconnect')).toBe(false)

    fixture.port.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    await starting
    fixture.port.emit({ type: 'server-ops.log-chunk', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1', sequence: 0, data: 'current' })
    fixture.client.acknowledgeLog('host-1', 'connection-1', 'stream-1', 0)

    expect(outputs).toEqual(['current'])
    expect(fixture.port.messages.at(-1)).toEqual({ type: 'server-ops.log-ack', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1', sequence: 0 })
  })

  test('Given connectionId 已被新 host 接管 When 旧流 exit 到达 Then 零通知', async () => {
    const fixture = createFixture()
    await connectFixture(fixture)
    const starting = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    fixture.port.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    await starting
    /** 旧日志流的公开退出通知。 */
    const exits: string[] = []
    fixture.client.onLogExit((event) => exits.push(event.reason))

    /** 模拟同 connectionId 被另一 host 的新连接接管。 */
    const takeover = fixture.client.connect({
      hostId: 'host-2', connectionId: 'connection-1', address: '10.0.0.9', port: 22, username: 'deploy',
      authentication: { kind: 'ssh-agent', agent: '/tmp/agent.sock' }, cols: 80, rows: 24,
    })
    await flushRuntimeClient()
    fixture.port.emit({
      type: 'server-ops.connect-result', requestId: 'exec-1', hostId: 'host-2', connectionId: 'connection-1',
      result: { status: 'connected', hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:takeover' } },
    })
    await takeover
    fixture.port.emit({ type: 'server-ops.log-exit', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1', reason: 'remote-exit' })

    expect(exits).toEqual([])
  })

  test('Given 已停止的 pending streamId When 同 ID 再启动 Then 拒绝复用避免迟到 started 接管', async () => {
    const fixture = createFixture()
    await connectFixture(fixture)
    const first = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    fixture.client.stopLog('host-1', 'connection-1', 'stream-1')
    await expect(first).rejects.toMatchObject({ code: 'SERVER_OPS_LOG_STOPPED' })

    const reused = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    fixture.port.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    await expect(reused).rejects.toMatchObject({ code: 'SERVER_OPS_LOG_STREAM_CONFLICT' })
  })

  test('Given 日志订阅者抛错 When chunk 与 exit 到达 Then 后续订阅者继续且 exit 只发一次', async () => {
    const fixture = createFixture()
    await connectFixture(fixture)
    const starting = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    fixture.port.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    await starting
    /** 后续订阅者观察到的事件。 */
    const observed: string[] = []
    fixture.client.onLogOutput(() => { throw new Error('listener-secret') })
    fixture.client.onLogOutput((event) => observed.push(event.data))
    fixture.client.onLogExit(() => { throw new Error('listener-secret') })
    fixture.client.onLogExit((event) => observed.push(event.reason))

    fixture.port.emit({ type: 'server-ops.log-chunk', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1', sequence: 0, data: '中文日志' })
    fixture.port.emit({ type: 'server-ops.log-exit', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1', reason: 'remote-exit' })
    fixture.port.emit({ type: 'server-ops.log-exit', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1', reason: 'remote-exit' })

    expect(observed).toEqual(['中文日志', 'remote-exit'])
  })

  test('Given utility 无启动回调 When pending 超时 Then 精确 stop 且迟到消息零副作用', async () => {
    const fixture = createFixture({ logStartTimeoutMs: 10 })
    await connectFixture(fixture)
    /** 超时后不应收到的输出与终态。 */
    const observed: string[] = []
    fixture.client.onLogOutput((event) => observed.push(event.data))
    fixture.client.onLogExit((event) => observed.push(event.reason))

    const starting = fixture.client.startLog('host-1', 'connection-1', 'stream-timeout', 'journalctl --follow')
    await expect(starting).rejects.toMatchObject({ code: 'SERVER_OPS_LOG_START_TIMEOUT' })
    expect(fixture.port.messages.at(-1)).toEqual({ type: 'server-ops.log-stop', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-timeout' })

    fixture.port.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-timeout' })
    fixture.port.emit({ type: 'server-ops.log-chunk', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-timeout', sequence: 0, data: 'late' })
    fixture.port.emit({ type: 'server-ops.log-exit', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-timeout', reason: 'stopped' })
    expect(observed).toEqual([])

    const stopped = fixture.client.startLog('host-1', 'connection-1', 'stream-stopped', 'journalctl --follow')
    fixture.client.stopLog('host-1', 'connection-1', 'stream-stopped')
    await expect(stopped).rejects.toMatchObject({ code: 'SERVER_OPS_LOG_STOPPED' })
    /** 停止后等过原 timer 截止时间，不应再发送第二次 stop。 */
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(fixture.port.messages.filter((message) => message.type === 'server-ops.log-stop' && message.streamId === 'stream-stopped')).toHaveLength(1)
  })

  test('Given 小容量 tombstone When 达到上限 Then 第三次启动在 post 前稳定拒绝', async () => {
    const fixture = createFixture({ maxUsedLogStreamIds: 2 })
    await connectFixture(fixture)
    for (const streamId of ['stream-1', 'stream-2']) {
      const starting = fixture.client.startLog('host-1', 'connection-1', streamId, 'journalctl --follow')
      fixture.port.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId })
      await starting
      fixture.port.emit({ type: 'server-ops.log-exit', hostId: 'host-1', connectionId: 'connection-1', streamId, reason: 'remote-exit' })
    }
    const postCount = fixture.port.messages.length
    await expect(fixture.client.startLog('host-1', 'connection-1', 'stream-3', 'journalctl --follow'))
      .rejects.toMatchObject({ code: 'SERVER_OPS_LOG_STREAM_CAPACITY_EXHAUSTED' })
    expect(fixture.port.messages).toHaveLength(postCount)
  })

  test('Given runtime stop 后启动新代次 When 复用 ID 且旧回调迟到 Then 只有新 port started 生效', async () => {
    const fixture = createRotatingFixture({ maxUsedLogStreamIds: 1 })
    const oldPort = await connectRotatingFixture(fixture, 0, 'connect-1')
    const oldStarting = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    fixture.client.stop()
    await expect(oldStarting).rejects.toMatchObject({ code: 'SERVER_OPS_RUNTIME_STOPPED' })
    expect(fixture.processes[0]?.killCalls).toBe(1)

    const newPort = await connectRotatingFixture(fixture, 1, 'connect-2')
    const newStarting = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    let settled = false
    void newStarting.then(() => { settled = true })
    oldPort.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    fixture.processes[0]?.emit('exit')
    await flushRuntimeClient()
    expect(settled).toBe(false)

    newPort.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    await expect(newStarting).resolves.toBeUndefined()
  })

  test('Given runtime failure 已清空 tombstone When 新代次复用 ID Then 可正常启动', async () => {
    const fixture = createRotatingFixture({ maxUsedLogStreamIds: 1 })
    const oldPort = await connectRotatingFixture(fixture, 0, 'connect-1')
    const oldStarting = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    oldPort.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    await oldStarting
    fixture.processes[0]?.emit('exit')

    const newPort = await connectRotatingFixture(fixture, 1, 'connect-2')
    const reused = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    newPort.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    await expect(reused).resolves.toBeUndefined()
  })

  test('Given 已 ready runtime 触发 error When 新代次复用 ID Then 旧代次完整失效', async () => {
    const fixture = createRotatingFixture({ maxUsedLogStreamIds: 1 })
    const oldPort = await connectRotatingFixture(fixture, 0, 'connect-1')
    const oldStarting = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    oldPort.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    await oldStarting

    fixture.processes[0]?.emit('error')
    expect(fixture.processes[0]?.killCalls).toBe(1)

    const newPort = await connectRotatingFixture(fixture, 1, 'connect-2')
    const reused = fixture.client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl --follow')
    let settled = false
    void reused.then(() => { settled = true })
    fixture.processes[0]?.emit('exit')
    await flushRuntimeClient()
    expect(settled).toBe(false)
    newPort.emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
    await expect(reused).resolves.toBeUndefined()
  })

  test('Given runtime 启动前失败 When error 到达 Then kill 当前 process 且拒绝启动', async () => {
    const fixture = createRotatingFixture()
    const connecting = fixture.client.connect({
      hostId: 'host-1', connectionId: 'connection-1', address: '10.0.0.8', port: 22, username: 'deploy',
      authentication: { kind: 'ssh-agent', agent: '/tmp/agent.sock' }, cols: 80, rows: 24,
    })
    fixture.processes[0]?.emit('error')

    await expect(connecting).rejects.toMatchObject({ code: 'SERVER_OPS_RUNTIME_FAILED' })
    expect(fixture.processes[0]?.killCalls).toBe(1)
  })

  test('Given runtime kill 抛错 When ready 后 process error Then 本地状态仍收口并可启动新代', async () => {
    const fixture = createRotatingFixture()
    await connectRotatingFixture(fixture, 0, 'connect-1')
    /** 当前进程模拟 kill API 同步异常。 */
    const oldProcess = fixture.processes[0]
    if (!oldProcess) throw new Error('SERVER_OPS_TEST_PROCESS_MISSING')
    oldProcess.throwOnKill = true

    expect(() => oldProcess.emit('error')).not.toThrow()
    expect(oldProcess.killCalls).toBe(1)
    await connectRotatingFixture(fixture, 1, 'connect-2')
  })
})
