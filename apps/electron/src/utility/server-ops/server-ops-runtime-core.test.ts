import { describe, expect, test } from 'bun:test'
import {
  acknowledgeRuntimeOutput,
  acknowledgeRuntimeLogOutput,
  appendRuntimeLogOutput,
  createRuntimeLogStreamController,
  createHostKeyFingerprint,
  createRuntimeLogOutputState,
  createRuntimeOutputState,
  appendExecOutput,
  createExecOutputCollector,
  formatExecOutput,
  enqueueRuntimeOutput,
  resolveSshAgent,
  takeRuntimeOutput,
  takeRuntimeLogOutput,
  type RuntimeLogChannel,
  type RuntimeLogStreamExecCallback,
  type ServerOpsRuntimeManagedLogStream,
} from './server-ops-runtime-core'
import type { ServerOpsRuntimeMessage } from './server-ops-runtime-protocol'

/** 可控 timer 记录，用于无等待验证 50ms 合批与清理。 */
interface FakeTimer {
  callback: () => void
  delayMs: number
  cancelled: boolean
}

/** 模拟日志 channel，保留生产控制器注册的真实监听函数。 */
class FakeLogChannel implements RuntimeLogChannel {
  /** stdout 数据监听器。 */
  private dataListener?: (data: Buffer | string) => void
  /** stderr 数据监听器。 */
  private stderrListener?: (data: Buffer | string) => void
  /** channel error 监听器。 */
  private errorListener?: () => void
  /** channel close 监听器。 */
  private closeListener?: () => void
  /** channel close 的幂等调用次数。 */
  closeCalls = 0
  /** 已完成绑定的生产事件数量。 */
  boundListenerCount = 0

  /** 绑定 stdout 输出。 */
  onData(listener: (data: Buffer | string) => void): void { this.dataListener = listener; this.boundListenerCount += 1 }
  /** 绑定 stderr 输出。 */
  onStderrData(listener: (data: Buffer | string) => void): void { this.stderrListener = listener; this.boundListenerCount += 1 }
  /** 绑定单次错误终态。 */
  onceError(listener: () => void): void { this.errorListener = listener; this.boundListenerCount += 1 }
  /** 绑定单次关闭终态。 */
  onceClose(listener: () => void): void { this.closeListener = listener; this.boundListenerCount += 1 }
  /** 关闭底层 channel。 */
  close(): void { this.closeCalls += 1; this.closeListener?.() }
  /** 主动产生 stdout 数据。 */
  emitData(data: Buffer | string): void { this.dataListener?.(data) }
  /** 主动产生 stderr 数据。 */
  emitStderr(data: Buffer | string): void { this.stderrListener?.(data) }
  /** 主动产生 channel error。 */
  emitError(): void { this.errorListener?.() }
  /** 主动产生自然 close。 */
  emitClose(): void { this.closeListener?.() }
}

/** 日志控制器测试夹具，所有副作用均可同步观察。 */
interface RuntimeLogControllerFixture {
  controller: ReturnType<typeof createRuntimeLogStreamController<FakeTimer>>
  streams: Map<string, ServerOpsRuntimeManagedLogStream<FakeTimer>>
  callbacks: RuntimeLogStreamExecCallback[]
  messages: ServerOpsRuntimeMessage[]
  timers: FakeTimer[]
}

/** 创建绑定固定连接身份的生产日志控制器。 */
function createLogControllerFixture(): RuntimeLogControllerFixture {
  /** 当前连接拥有的日志流 Map。 */
  const streams = new Map<string, ServerOpsRuntimeManagedLogStream<FakeTimer>>()
  /** 尚未由测试完成的 exec callbacks。 */
  const callbacks: RuntimeLogStreamExecCallback[] = []
  /** 控制器实际发布的 runtime 消息。 */
  const messages: ServerOpsRuntimeMessage[] = []
  /** 控制器实际注册的 timer。 */
  const timers: FakeTimer[] = []
  /** 使用可控依赖创建的生产控制器。 */
  const controller = createRuntimeLogStreamController<FakeTimer>({
    hostId: 'host-1',
    connectionId: 'connection-1',
    streams,
    execute: (_command, callback) => { callbacks.push(callback) },
    post: (message) => { messages.push(message) },
    setTimer: (callback, delayMs) => {
      /** 本次创建的可控 timer。 */
      const timer = { callback, delayMs, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { timer.cancelled = true },
  })
  return { controller, streams, callbacks, messages, timers }
}

/** 构造固定身份与命令的日志启动请求。 */
function createLogStartInput(streamId = 'stream-1') {
  return { streamId, hostId: 'host-1', connectionId: 'connection-1', command: 'journalctl -f' }
}

/** 构造 SSH wire-format 的 Host Key 测试数据。 */
function createHostKeyBuffer(algorithm: string, payload: string): Buffer {
  /** Host Key 算法名称的 UTF-8 字节。 */
  const algorithmBytes = Buffer.from(algorithm)
  /** SSH string 前置的四字节大端长度。 */
  const length = Buffer.alloc(4)
  length.writeUInt32BE(algorithmBytes.length)
  return Buffer.concat([length, algorithmBytes, Buffer.from(payload)])
}

describe('服务器运维 SSH runtime 核心', () => {
  test('生成带算法的 OpenSSH SHA-256 Host Key 指纹', () => {
    /** 固定的 wire-format Host Key。 */
    const key = createHostKeyBuffer('ssh-ed25519', 'public-key-canary')
    expect(createHostKeyFingerprint(key)).toEqual({
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:8ZplK++wLzHOhnBsLeWpPWbDySOJPMQA5qhgGPC50O4',
    })
  })

  test('SSH Agent 在 Unix 使用 socket，在 Windows 支持 pipe 与 Pageant', () => {
    expect(resolveSshAgent('darwin', { SSH_AUTH_SOCK: '/tmp/agent.sock' })).toBe('/tmp/agent.sock')
    expect(resolveSshAgent('win32', { SSH_AUTH_SOCK: '\\\\.\\pipe\\openssh-ssh-agent' })).toBe('\\\\.\\pipe\\openssh-ssh-agent')
    expect(resolveSshAgent('win32', {})).toBe('pageant')
    expect(() => resolveSshAgent('linux', {})).toThrow('SERVER_OPS_SSH_AGENT_UNAVAILABLE')
  })

  test('ACK 前只保留一个在途输出并对超限数据给出截断标记', () => {
    /** 使用 5 字符上限验证背压的输出状态。 */
    const state = createRuntimeOutputState(5)
    enqueueRuntimeOutput(state, 'abc')
    expect(takeRuntimeOutput(state, 'host-1', 'connection-1')).toMatchObject({ sequence: 1, data: 'abc' })

    enqueueRuntimeOutput(state, 'defghijk')
    expect(takeRuntimeOutput(state, 'host-1', 'connection-1')).toBeUndefined()
    expect(acknowledgeRuntimeOutput(state, 1)).toBe(true)
    expect(takeRuntimeOutput(state, 'host-1', 'connection-1')).toMatchObject({
      sequence: 2,
      data: expect.stringContaining('已丢弃 3 个字符'),
    })
  })

  test('exec collector 保留 ASCII 和完整中文，并在字节边界截断', () => {
    const collector = createExecOutputCollector()
    appendExecOutput(collector, 'stdout', 'ok 中文')
    appendExecOutput(collector, 'stderr', 'warn')
    expect(formatExecOutput(collector)).toEqual({ stdout: 'ok 中文', stderr: 'warn', truncated: false })

    const bounded = createExecOutputCollector()
    appendExecOutput(bounded, 'stdout', Buffer.alloc(1_048_575, 0x61))
    appendExecOutput(bounded, 'stdout', '中')
    const result = formatExecOutput(bounded)
    expect(result.truncated).toBe(true)
    expect(result.stdout.endsWith('a')).toBe(true)
    expect(result.stdout.includes('\ufffd')).toBe(false)
  })

  test('日志增量解码跨 Buffer 保留完整中文且不产生替换字符', () => {
    /** 使用真实 UTF-8 字节模拟 ssh2 在多字节字符中间拆包。 */
    const bytes = Buffer.from('服务\n')
    /** 日志输出状态独立于 PTY 的字符计数状态。 */
    const state = createRuntimeLogOutputState()
    appendRuntimeLogOutput(state, bytes.subarray(0, 2))
    appendRuntimeLogOutput(state, bytes.subarray(2, 5))
    appendRuntimeLogOutput(state, bytes.subarray(5))

    /** 第一批日志应按原文输出。 */
    const output = takeRuntimeLogOutput(state)
    expect(output).toEqual({ sequence: 0, data: '服务\n' })
    expect(output?.data.includes('\ufffd')).toBe(false)
  })

  test('stdout 与 stderr 各自增量解码后再按完整字符合并', () => {
    /** stdout 中被拆分的完整中文日志。 */
    const stdoutBytes = Buffer.from('服务\n')
    /** 两路输出共享背压队列但必须使用独立 decoder。 */
    const state = createRuntimeLogOutputState()
    appendRuntimeLogOutput(state, stdoutBytes.subarray(0, 2), 'stdout')
    appendRuntimeLogOutput(state, Buffer.from('错误\n'), 'stderr')
    appendRuntimeLogOutput(state, stdoutBytes.subarray(2), 'stdout')

    /** stderr 完整字符先入队，stdout 尾字节只能补全自身字符。 */
    const output = takeRuntimeLogOutput(state)
    expect(output).toEqual({ sequence: 0, data: '错误\n服务\n' })
    expect(output?.data.includes('\ufffd')).toBe(false)
  })

  test('日志 ACK 背压只保留一个在途批次与 32 KiB pending', () => {
    /** 日志状态使用生产 32 KiB 字节上限。 */
    const state = createRuntimeLogOutputState()
    appendRuntimeLogOutput(state, Buffer.alloc(32 * 1_024, 0x61))
    /** 第一个完整批次成为唯一在途数据。 */
    const first = takeRuntimeLogOutput(state)
    expect(first).toEqual({ sequence: 0, data: 'a'.repeat(32 * 1_024) })

    appendRuntimeLogOutput(state, Buffer.alloc(32 * 1_024, 0x62))
    appendRuntimeLogOutput(state, Buffer.from('中文'.repeat(8_000)))
    expect(state.pendingBytes).toBe(32 * 1_024)
    expect(state.droppedBytes).toBe(Buffer.byteLength('中文'.repeat(8_000)))
    expect(takeRuntimeLogOutput(state)).toBeUndefined()

    /** 旧 ACK 与未来 ACK 均不得释放当前在途批次。 */
    expect(acknowledgeRuntimeLogOutput(state, -1)).toBe(false)
    expect(acknowledgeRuntimeLogOutput(state, 1)).toBe(false)
    expect(state.inFlight?.sequence).toBe(0)
    expect(acknowledgeRuntimeLogOutput(state, 0)).toBe(true)

    /** 下一批必须携带固定丢弃标记并保持 UTF-8 字节边界。 */
    const second = takeRuntimeLogOutput(state)
    expect(second?.sequence).toBe(1)
    expect(second?.data).toContain('[Proma：日志输出过快，已丢弃 ')
    expect(Buffer.byteLength(second?.data ?? '')).toBeLessThanOrEqual(32 * 1_024)
    expect(second?.data.includes('\ufffd')).toBe(false)
    expect(state.pendingBytes).toBe(0)
    expect(state.droppedBytes).toBe(0)
  })

  test('最大安全序号发送后拒绝生成越界日志批次', () => {
    /** 从最大合法序号开始验证耗尽边界。 */
    const state = createRuntimeLogOutputState()
    state.nextSequence = Number.MAX_SAFE_INTEGER
    appendRuntimeLogOutput(state, 'last')
    expect(takeRuntimeLogOutput(state)).toEqual({ sequence: Number.MAX_SAFE_INTEGER, data: 'last' })
    expect(acknowledgeRuntimeLogOutput(state, Number.MAX_SAFE_INTEGER)).toBe(true)
    appendRuntimeLogOutput(state, 'overflow')

    expect(() => takeRuntimeLogOutput(state)).toThrow('SERVER_OPS_LOG_SEQUENCE_EXHAUSTED')
    expect(state.nextSequence).toBe(Number.MAX_SAFE_INTEGER)
    expect(state.sequenceExhausted).toBe(true)
  })
})

describe('服务器运维日志流生产控制器', () => {
  test('exec callback 成功并绑定全部 listeners 后才发布 started', () => {
    /** 可控生产控制器夹具。 */
    const fixture = createLogControllerFixture()
    fixture.controller.start(createLogStartInput())
    expect(fixture.messages).toEqual([])
    expect(fixture.streams.size).toBe(1)

    /** exec 成功返回的日志 channel。 */
    const channel = new FakeLogChannel()
    fixture.callbacks[0]?.(undefined, channel)
    expect(channel.boundListenerCount).toBe(4)
    expect(fixture.messages).toEqual([{ type: 'server-ops.log-started', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1' }])
  })

  test('pending start 被 stop 后迟到 callback 只关闭 channel', () => {
    /** 可控生产控制器夹具。 */
    const fixture = createLogControllerFixture()
    fixture.controller.start(createLogStartInput())
    fixture.controller.stop({ streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1' })
    fixture.controller.stop({ streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1' })

    /** stop 后迟到返回的 channel。 */
    const channel = new FakeLogChannel()
    fixture.callbacks[0]?.(undefined, channel)
    channel.emitClose()
    expect(channel.closeCalls).toBe(1)
    expect(fixture.streams.size).toBe(0)
    expect(fixture.messages).toEqual([{ type: 'server-ops.log-exit', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', reason: 'stopped' }])
  })

  test('自然 close 与 error 后 close 各自只发布一个终态', () => {
    /** 自然退出与错误退出共用同一控制器。 */
    const fixture = createLogControllerFixture()
    fixture.controller.start(createLogStartInput('stream-natural'))
    fixture.controller.start(createLogStartInput('stream-error'))
    /** 两条成功启动的独立 channel。 */
    const naturalChannel = new FakeLogChannel()
    const errorChannel = new FakeLogChannel()
    fixture.callbacks[0]?.(undefined, naturalChannel)
    fixture.callbacks[1]?.(undefined, errorChannel)
    naturalChannel.emitClose()
    naturalChannel.emitClose()
    errorChannel.emitError()
    errorChannel.emitClose()

    /** 过滤 started 后的最终 exit 消息。 */
    const exits = fixture.messages.filter((message) => message.type === 'server-ops.log-exit')
    expect(exits).toEqual([
      { type: 'server-ops.log-exit', streamId: 'stream-natural', hostId: 'host-1', connectionId: 'connection-1', reason: 'remote-exit' },
      { type: 'server-ops.log-exit', streamId: 'stream-error', hostId: 'host-1', connectionId: 'connection-1', reason: 'error', errorCode: 'SERVER_OPS_LOG_STREAM_FAILED' },
    ])
    expect(fixture.streams.size).toBe(0)
  })

  test('50ms 前自然 close 先发送最后日志并在 ACK 后退出', () => {
    /** 可控生产控制器夹具。 */
    const fixture = createLogControllerFixture()
    fixture.controller.start(createLogStartInput())
    /** 已成功启动并即将自然关闭的 channel。 */
    const channel = new FakeLogChannel()
    fixture.callbacks[0]?.(undefined, channel)
    channel.emitData('tail')
    channel.emitClose()

    expect(fixture.timers[0]?.cancelled).toBe(true)
    expect(fixture.messages.slice(1)).toEqual([
      { type: 'server-ops.log-chunk', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 0, data: 'tail' },
    ])
    expect(fixture.streams.size).toBe(1)
    expect(fixture.controller.ack({ streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 0 })).toBe(true)
    expect(fixture.messages.at(-1)).toEqual({ type: 'server-ops.log-exit', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', reason: 'remote-exit' })
  })

  test('自然 close 后按 ACK 顺序排空 inFlight 与 pending 且迟到事件无副作用', () => {
    /** 可控生产控制器夹具。 */
    const fixture = createLogControllerFixture()
    fixture.controller.start(createLogStartInput())
    /** 已成功启动并产生两批数据的 channel。 */
    const channel = new FakeLogChannel()
    fixture.callbacks[0]?.(undefined, channel)
    channel.emitData(Buffer.alloc(32 * 1_024, 0x61))
    channel.emitData('pending')
    channel.emitClose()

    expect(fixture.messages.filter((message) => message.type === 'server-ops.log-chunk')).toHaveLength(1)
    expect(fixture.messages.some((message) => message.type === 'server-ops.log-exit')).toBe(false)
    expect(fixture.controller.ack({ streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 0 })).toBe(true)
    expect(fixture.messages.filter((message) => message.type === 'server-ops.log-chunk')).toHaveLength(2)
    expect(fixture.messages.some((message) => message.type === 'server-ops.log-exit')).toBe(false)
    expect(fixture.controller.ack({ streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 1 })).toBe(true)
    expect(fixture.messages.at(-1)).toEqual({ type: 'server-ops.log-exit', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', reason: 'remote-exit' })

    /** close 后迟到的 data/error/close 不能追加输出或覆盖终态。 */
    const messageCount = fixture.messages.length
    channel.emitData('late')
    channel.emitError()
    channel.emitClose()
    expect(fixture.messages).toHaveLength(messageCount)
  })

  test('channel error 先排空 pending 再只发布一次 error 终态', () => {
    /** 可控生产控制器夹具。 */
    const fixture = createLogControllerFixture()
    fixture.controller.start(createLogStartInput())
    /** 产生尾部输出后报错的 channel。 */
    const channel = new FakeLogChannel()
    fixture.callbacks[0]?.(undefined, channel)
    channel.emitStderr('error-tail')
    channel.emitError()
    channel.emitClose()

    expect(fixture.messages.filter((message) => message.type === 'server-ops.log-chunk')).toHaveLength(1)
    expect(fixture.messages.some((message) => message.type === 'server-ops.log-exit')).toBe(false)
    expect(fixture.controller.ack({ streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 0 })).toBe(true)
    expect(fixture.messages.filter((message) => message.type === 'server-ops.log-exit')).toEqual([
      { type: 'server-ops.log-exit', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', reason: 'error', errorCode: 'SERVER_OPS_LOG_STREAM_FAILED' },
    ])
  })

  test('finishAll 同步释放所有未 ACK 流且重复调用幂等', () => {
    /** 可控生产控制器夹具。 */
    const fixture = createLogControllerFixture()
    fixture.controller.start(createLogStartInput('stream-1'))
    fixture.controller.start(createLogStartInput('stream-2'))
    /** 两条已绑定并产生未确认输出的 channel。 */
    const firstChannel = new FakeLogChannel()
    const secondChannel = new FakeLogChannel()
    fixture.callbacks[0]?.(undefined, firstChannel)
    fixture.callbacks[1]?.(undefined, secondChannel)
    firstChannel.emitData(Buffer.alloc(32 * 1_024, 0x61))
    firstChannel.emitData('pending')
    secondChannel.emitData('timer-pending')
    /** 清理前保留引用，以验证 Map 摘除后的内部状态。 */
    const firstStream = fixture.streams.get('stream-1')
    const secondStream = fixture.streams.get('stream-2')

    fixture.controller.finishAll('connection-closed')
    fixture.controller.finishAll('connection-closed')
    expect(fixture.streams.size).toBe(0)
    expect(firstChannel.closeCalls).toBe(1)
    expect(secondChannel.closeCalls).toBe(1)
    expect(firstStream?.output.inFlight).toBeUndefined()
    expect(firstStream?.output.pendingBytes).toBe(0)
    expect(secondStream?.output.pendingBytes).toBe(0)
    expect(firstStream?.output.closed).toBe(true)
    expect(secondStream?.output.closed).toBe(true)
    expect(fixture.timers.every((timer) => timer.cancelled)).toBe(true)
    expect(fixture.messages.filter((message) => message.type === 'server-ops.log-exit')).toEqual([
      { type: 'server-ops.log-exit', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', reason: 'connection-closed' },
      { type: 'server-ops.log-exit', streamId: 'stream-2', hostId: 'host-1', connectionId: 'connection-1', reason: 'connection-closed' },
    ])
  })

  test('仅精确 ACK 触发下一批且 50ms 与 32KiB 都会 flush', () => {
    /** 可控生产控制器夹具。 */
    const fixture = createLogControllerFixture()
    fixture.controller.start(createLogStartInput())
    /** 已成功启动的日志 channel。 */
    const channel = new FakeLogChannel()
    fixture.callbacks[0]?.(undefined, channel)
    channel.emitData('timer')
    expect(fixture.timers[0]?.delayMs).toBe(50)
    fixture.timers[0]?.callback()
    channel.emitData('pending')

    expect(fixture.controller.ack({ streamId: 'stream-1', hostId: 'wrong-host', connectionId: 'connection-1', sequence: 0 })).toBe(false)
    expect(fixture.controller.ack({ streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 1 })).toBe(false)
    expect(fixture.messages.filter((message) => message.type === 'server-ops.log-chunk')).toHaveLength(1)
    expect(fixture.controller.ack({ streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 0 })).toBe(true)
    expect(fixture.messages.filter((message) => message.type === 'server-ops.log-chunk')).toHaveLength(2)

    expect(fixture.controller.ack({ streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 1 })).toBe(true)
    channel.emitData(Buffer.alloc(32 * 1_024, 0x62))
    expect(fixture.messages.filter((message) => message.type === 'server-ops.log-chunk')).toHaveLength(3)
  })

  test('序号耗尽转为单次稳定 error 终态且不发布非法 chunk', () => {
    /** 可控生产控制器夹具。 */
    const fixture = createLogControllerFixture()
    fixture.controller.start(createLogStartInput())
    /** 已成功启动的日志 channel。 */
    const channel = new FakeLogChannel()
    fixture.callbacks[0]?.(undefined, channel)
    /** 当前生产流直接定位到最大合法序号。 */
    const stream = fixture.streams.get('stream-1')
    if (!stream) throw new Error('测试日志流未创建')
    stream.output.nextSequence = Number.MAX_SAFE_INTEGER
    channel.emitData('last')
    fixture.timers[0]?.callback()
    expect(fixture.controller.ack({ streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: Number.MAX_SAFE_INTEGER })).toBe(true)
    channel.emitData(Buffer.alloc(32 * 1_024, 0x63))
    channel.emitClose()

    expect(fixture.messages.filter((message) => message.type === 'server-ops.log-chunk')).toEqual([
      { type: 'server-ops.log-chunk', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: Number.MAX_SAFE_INTEGER, data: 'last' },
    ])
    expect(fixture.messages.filter((message) => message.type === 'server-ops.log-exit')).toEqual([
      { type: 'server-ops.log-exit', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', reason: 'error', errorCode: 'SERVER_OPS_LOG_SEQUENCE_EXHAUSTED' },
    ])
  })
})
