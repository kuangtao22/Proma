import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { TerminalCreateInput, TerminalState } from '@proma/shared'

/** 测试用终端端口，关闭后拒绝继续接收旧代次消息。 */
class FakeTerminalPort {
  /** 发往终端 runtime 的消息。 */
  readonly sent: unknown[] = []
  /** runtime 消息监听器。 */
  private listener?: (event: { data: unknown }) => void
  /** 端口关闭标记。 */
  private closed = false
  /** 控制 shutdown 发送同步失败。 */
  throwOnShutdown = false
  /** 控制 terminal.create 发送同步失败。 */
  throwOnCreate = false

  on(_event: 'message', listener: (event: { data: unknown }) => void): void {
    this.listener = listener
  }

  start(): void {}

  close(): void {
    this.closed = true
  }

  postMessage(message: unknown): void {
    if (
      this.throwOnCreate
      && !!message
      && typeof message === 'object'
      && (message as { type?: unknown }).type === 'terminal.create'
    ) throw new Error('create port closed')
    if (
      this.throwOnShutdown
      && !!message
      && typeof message === 'object'
      && (message as { type?: unknown }).type === 'terminal.shutdown'
    ) throw new Error('shutdown port closed')
    if (!this.closed) this.sent.push(message)
  }

  /** 模拟 utility runtime 的一条入站消息。 */
  emit(message: unknown): void {
    if (!this.closed) this.listener?.({ data: message })
  }
}

/** 测试用终端 utility process。 */
class FakeTerminalProcess extends EventEmitter {
  /** 当前子进程 PID；尚未 spawn 或已退出时为 undefined。 */
  pid: number | undefined = 303
  /** 进程是否收到 kill。 */
  killed = false
  /** 普通测试默认收到 kill 后立即退出；竞态测试可显式延迟。 */
  autoExitOnKill = true

  postMessage(): void {}

  /** 未 spawn 时模拟 Electron 拒绝终止；已启动后可显式控制 exit。 */
  kill(): boolean {
    this.killed = true
    if (this.pid === undefined) return false
    if (this.autoExitOnKill) this.emitExit(0)
    return true
  }

  /** 模拟操作系统在 fork 返回之后才完成进程创建。 */
  emitSpawn(pid: number): void {
    this.pid = pid
    this.emit('spawn')
  }

  /** 模拟旧进程延迟上报退出。 */
  emitExit(code: number): void {
    this.pid = undefined
    this.emit('exit', code)
  }
}

/** 下一次 fork 是否模拟尚无 PID 的启动窗口。 */
let delayNextSpawn = false

/** 每次启动创建的端口。 */
const ports: FakeTerminalPort[] = []
/** 每次启动创建的进程。 */
const processes: FakeTerminalProcess[] = []

mock.module('electron', () => ({
  MessageChannelMain: class {
    /** 传递给 utility 的端口身份。 */
    readonly port1 = {}
    /** 主进程使用的可控端口。 */
    readonly port2: FakeTerminalPort

    constructor() {
      this.port2 = new FakeTerminalPort()
      ports.push(this.port2)
    }
  },
  utilityProcess: {
    fork: () => {
      /** 当前启动对应的进程。 */
      const process = new FakeTerminalProcess()
      if (delayNextSpawn) {
        delayNextSpawn = false
        process.pid = undefined
        process.autoExitOnKill = false
      }
      processes.push(process)
      return process
    },
  },
}))

const { TerminalRuntimeClient } = await import('./terminal-runtime-client')

/** 创建终端所需的最小合法输入。 */
function createTerminalInput(terminalId: string): TerminalCreateInput {
  return { terminalId } as TerminalCreateInput
}

/** 构造 runtime 返回的终端状态。 */
function createTerminalState(terminalId: string): TerminalState {
  return { terminalId } as TerminalState
}

/** 等待客户端真正向 runtime 发出目标消息，确保测试跨过异步启动边界。 */
async function waitForTerminalMessage(port: FakeTerminalPort, type: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (port.sent.some((message) => (
      !!message
      && typeof message === 'object'
      && (message as { type?: unknown }).type === type
    ))) return
    await Promise.resolve()
  }
  throw new Error(`等待终端 runtime 消息超时：${type}`)
}

/** 等待异步启动创建指定代次端口。 */
async function waitForTerminalPort(index: number): Promise<FakeTerminalPort> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = ports[index]
    if (port) return port
    await Promise.resolve()
  }
  throw new Error(`等待终端 runtime 端口超时：${index}`)
}

describe('Terminal runtime 生命周期隔离', () => {
  test('Given ready 握手仍等待 When stop Then 在途启动立即拒绝而不是等待超时', async () => {
    ports.length = 0
    processes.length = 0
    /** 被测终端客户端。 */
    const client = new TerminalRuntimeClient()
    /** 尚未收到 terminal.ready 的创建请求。 */
    const creating = client.create(createTerminalInput('terminal-starting'))
    await waitForTerminalPort(0)

    await client.stop()

    expect(await Promise.race([
      creating.then(() => 'resolved' as const, () => 'rejected' as const),
      Bun.sleep(20).then(() => 'pending' as const),
    ])).toBe('rejected')
    expect(processes[0]?.killed).toBe(true)
  })

  test('Given shutdown 端口已关闭 When stop Then 仍杀进程并拒绝 pending create', async () => {
    ports.length = 0
    processes.length = 0
    /** 被测终端客户端。 */
    const client = new TerminalRuntimeClient()
    /** 已通过 ready 且等待 created 的请求。 */
    const creating = client.create(createTerminalInput('terminal-shutdown-throw'))
    /** 本轮终端 runtime 端口。 */
    const port = await waitForTerminalPort(0)
    port.emit({ type: 'terminal.ready', pid: 303 })
    await waitForTerminalMessage(port, 'terminal.create')
    port.throwOnShutdown = true
    /** 先观察预期拒绝，再等待异步 stop，避免测试夹具造成未处理拒绝。 */
    const rejectedCreate = creating.catch((error: unknown) => error)

    await expect(client.stop()).resolves.toBeUndefined()
    expect(await rejectedCreate).toEqual(new Error('终端运行时已停止'))
    expect(processes[0]?.killed).toBe(true)
  })

  test('Given ready 已完成且 create 仍等待 When 当前 runtime 退出 Then 拒绝 pending create', async () => {
    ports.length = 0
    processes.length = 0
    /** 已通过 ready 且等待 created 的请求。 */
    const client = new TerminalRuntimeClient()
    /** 当前代次的终端创建请求。 */
    const creating = client.create(createTerminalInput('terminal-runtime-exit'))
    /** 当前代次 runtime 端口。 */
    const port = await waitForTerminalPort(0)
    port.emit({ type: 'terminal.ready', pid: 404 })
    await waitForTerminalMessage(port, 'terminal.create')

    processes[0]!.emitExit(9)

    await expect(Promise.race([
      creating.then(() => 'resolved' as const, () => 'rejected' as const),
      Bun.sleep(20).then(() => 'pending' as const),
    ])).resolves.toBe('rejected')
    expect(processes[0]?.pid).toBeUndefined()
  })

  test('Given ready 已返回但 create 尚未登记 When stop Then create 立即拒绝', async () => {
    ports.length = 0
    processes.length = 0
    /** 被测终端客户端。 */
    const client = new TerminalRuntimeClient()
    /** 正在跨过 ready 异步边界的创建请求。 */
    const creating = client.create(createTerminalInput('terminal-ready-stop-race'))
    /** 当前代次 runtime 端口。 */
    const port = await waitForTerminalPort(0)

    port.emit({ type: 'terminal.ready', pid: 505 })
    await client.stop()

    await expect(Promise.race([
      creating.then(() => 'resolved' as const, () => 'rejected' as const),
      Bun.sleep(20).then(() => 'pending' as const),
    ])).resolves.toBe('rejected')
    expect(port.sent.some((message) => (
      !!message
      && typeof message === 'object'
      && (message as { type?: unknown }).type === 'terminal.create'
    ))).toBe(false)
  })

  test('Given terminal.create 同步发送失败 When 同 ID 重试 Then 不复用遗留 pending', async () => {
    ports.length = 0
    processes.length = 0
    /** 被测终端客户端。 */
    const client = new TerminalRuntimeClient()
    /** 首次创建请求。 */
    const firstCreate = client.create(createTerminalInput('terminal-send-retry'))
    /** 当前代次 runtime 端口。 */
    const port = await waitForTerminalPort(0)
    port.throwOnCreate = true
    port.emit({ type: 'terminal.ready', pid: 606 })

    await expect(firstCreate).rejects.toThrow('create port closed')

    port.throwOnCreate = false
    /** 发送恢复后的同 ID 重试。 */
    const retryCreate = client.create(createTerminalInput('terminal-send-retry'))
    await waitForTerminalMessage(port, 'terminal.create')
    port.emit({ type: 'terminal.created', state: createTerminalState('terminal-send-retry') })

    await expect(retryCreate).resolves.toEqual(createTerminalState('terminal-send-retry'))
    await client.stop()
  })

  test('Given 旧 runtime 已停止且新 runtime 已启动 When 旧进程迟到退出 Then 不会关闭新端口', async () => {
    ports.length = 0
    processes.length = 0
    /** 被测终端客户端。 */
    const client = new TerminalRuntimeClient()
    /** 第一代终端创建。 */
    const oldCreate = client.create(createTerminalInput('terminal-old'))
    /** 第一代 runtime 端口。 */
    const oldPort = await waitForTerminalPort(0)
    oldPort.emit({ type: 'terminal.ready', pid: 101 })
    await waitForTerminalMessage(oldPort, 'terminal.create')
    await client.stop()
    await expect(oldCreate).rejects.toThrow('终端运行时已停止')

    /** 第二代终端创建。 */
    const currentCreate = client.create(createTerminalInput('terminal-current'))
    /** 第二代 runtime 端口。 */
    const currentPort = await waitForTerminalPort(1)
    currentPort.emit({ type: 'terminal.ready', pid: 202 })
    await waitForTerminalMessage(currentPort, 'terminal.create')
    processes[0]!.emitExit(0)
    currentPort.emit({ type: 'terminal.created', state: createTerminalState('terminal-current') })

    await expect(Promise.race([
      currentCreate.then(() => 'resolved' as const, () => 'rejected' as const),
      Bun.sleep(20).then(() => 'pending' as const),
    ])).resolves.toBe('resolved')
    await client.stop()
  })
})


describe('Terminal runtime 停止必须等待实际退出', () => {
  test('Given fork 尚未产生 PID When stop Then 等待 spawn 后终止且 exit 前不完成', async () => {
    ports.length = 0
    processes.length = 0
    delayNextSpawn = true
    /** 本测试独占的终端客户端。 */
    const client = new TerminalRuntimeClient()
    /** 立即接住启动取消，避免测试故意延迟 exit 时产生未处理拒绝。 */
    const creating = client.create(createTerminalInput('terminal-before-spawn')).catch((error: unknown) => error)
    /** fork 已返回但操作系统尚未创建进程的受控句柄。 */
    const child = processes[0]!
    /** stop 必须持有该未完成启动直到实际 exit。 */
    const stopping = client.stop()
    try {
      expect(await Promise.race([stopping.then(() => 'stopped'), Bun.sleep(10).then(() => 'pending')])).toBe('pending')
      child.emitSpawn(707)
      await Bun.sleep(1)
      expect(child.killed).toBe(true)
      expect(await Promise.race([stopping.then(() => 'stopped'), Bun.sleep(10).then(() => 'pending')])).toBe('pending')
      child.emitExit(0)
      await stopping
      expect(await creating).toBeInstanceOf(Error)
    } finally {
      child.emitExit(0)
      await stopping.catch(() => {})
    }
  })

  test('Given 已启动进程延迟退出 When stop Then 退出前拒绝重新创建且退出后允许重启', async () => {
    ports.length = 0
    processes.length = 0
    /** 独占一个正常启动但延迟退出的 runtime。 */
    const client = new TerminalRuntimeClient()
    /** 等待 ready 的第一次创建请求。 */
    const creating = client.create(createTerminalInput('terminal-delayed-exit')).catch((error: unknown) => error)
    await waitForTerminalPort(0)
    /** 操作系统延迟收尾的进程。 */
    const child = processes[0]!
    child.autoExitOnKill = false
    /** 等待真实退出的停止请求。 */
    const stopping = client.stop()
    try {
      expect(await Promise.race([stopping.then(() => 'stopped'), Bun.sleep(10).then(() => 'pending')])).toBe('pending')
      await expect(client.create(createTerminalInput('terminal-too-early'))).rejects.toThrow()
      expect(processes).toHaveLength(1)
      child.emitExit(0)
      await stopping
      expect(await creating).toBeInstanceOf(Error)
      /** 旧进程已经退出，新的终端可以正常完成创建。 */
      const restarted = client.create(createTerminalInput('terminal-after-exit'))
      /** 新一代协议端口。 */
      const nextPort = await waitForTerminalPort(1)
      nextPort.emit({ type: 'terminal.ready', pid: 808 })
      await waitForTerminalMessage(nextPort, 'terminal.create')
      nextPort.emit({ type: 'terminal.created', state: createTerminalState('terminal-after-exit') })
      await expect(restarted).resolves.toEqual(createTerminalState('terminal-after-exit'))
    } finally {
      child.emitExit(0)
      await stopping.catch(() => {})
      await client.stop()
    }
  })
})
