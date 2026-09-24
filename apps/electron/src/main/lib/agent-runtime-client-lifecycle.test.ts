import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  AGENT_RUNTIME_BOOTSTRAP_ID,
  AGENT_RUNTIME_METHODS,
  AGENT_RUNTIME_PROTOCOL_VERSION,
  createAgentRuntimeRequest,
  createAgentRuntimeResponse,
  type AgentRuntimeRequest,
  type AgentRuntimeState,
} from '@proma/shared'
import { UTILITY_PROCESS_EXIT_TIMEOUT_CODE } from './utility-process-lifecycle'

/** Bun 测试中的可控 MessagePort，保留真实消息监听和关闭语义。 */
class FakeRuntimePort {
  /** 发送到该端口的协议消息。 */
  readonly sent: unknown[] = []
  /** 当前消息监听器。 */
  private listener?: (event: { data: unknown }) => void
  /** 端口是否已关闭。 */
  private closed = false

  on(_event: 'message', listener: (event: { data: unknown }) => void): void {
    this.listener = listener
  }

  start(): void {}

  close(): void {
    this.closed = true
  }

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('port is closed')
    this.sent.push(message)
  }

  /** 模拟 runtime 向主进程端口发送完整协议消息。 */
  emit(message: unknown): void {
    if (!this.closed) this.listener?.({ data: message })
  }
}

/** Bun 测试中的可控 utility process。 */
class FakeUtilityProcess extends EventEmitter {
  /** spawn 成功后可见的 PID。 */
  pid: number | undefined
  /** 进程是否收到 kill。 */
  killed = false
  /** kill 后是否自动发出 exit。 */
  exitOnKill = true
  constructor(pid?: number) {
    super()
    this.pid = pid
  }

  postMessage(): void {}

  kill(): boolean {
    this.killed = true
    if (this.exitOnKill) queueMicrotask(() => this.emitExit(0))
    return true
  }

  /** 模拟底层 utility process 完成 spawn。 */
  emitSpawn(pid: number): void {
    this.pid = pid
    this.emit('spawn')
  }

  /** 模拟底层 utility process 完成退出。 */
  emitExit(code: number): void {
    this.pid = undefined
    this.emit('exit', code)
  }
}

/** 每次创建 MessageChannel 时生成的主进程端口。 */
const createdPorts: FakeRuntimePort[] = []
/** 每次 fork 生成的 utility process。 */
const createdProcesses: FakeUtilityProcess[] = []
/** 控制下一次 fork 是否已处于 spawned 状态。 */
let forkCreatesSpawnedProcess = true
/** 控制下一次 fork 的进程是否响应 kill。 */
let forkProcessExitsOnKill = true

mock.module('electron', () => ({
  MessageChannelMain: class {
    /** 传递给 utility process 的另一端，仅需保持身份。 */
    readonly port1 = {}
    /** 主进程实际使用的可控端口。 */
    readonly port2: FakeRuntimePort

    constructor() {
      this.port2 = new FakeRuntimePort()
      createdPorts.push(this.port2)
    }
  },
  utilityProcess: {
    fork: () => {
      /** 本次启动对应的可控进程。 */
      const process = new FakeUtilityProcess(forkCreatesSpawnedProcess ? 900 + createdProcesses.length : undefined)
      process.exitOnKill = forkProcessExitsOnKill
      createdProcesses.push(process)
      return process
    },
  },
}))

const { AgentRuntimeClient } = await import('./agent-runtime-client')

/** 暴露测试所需的内部生命周期字段，不向生产类加入测试 API。 */
interface AgentRuntimeClientHarness {
  port?: FakeRuntimePort
  runtimeProcess?: object
  generation: number
  bootId: string
  requestHandler?: (request: AgentRuntimeRequest) => Promise<unknown>
  handleIncomingRequest(request: AgentRuntimeRequest): Promise<void>
}

/** 创建可控 Promise，复现迟到 capability 响应。 */
function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  /** 完成 Promise 的函数。 */
  let resolve = (_value: T): void => undefined
  /** 测试显式控制的 Promise。 */
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

/** 等待协议消息进入端口，避免绑定固定微任务次数。 */
async function waitForMessage(port: FakeRuntimePort, method: string): Promise<AgentRuntimeRequest> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = port.sent.find((candidate) => (
      !!candidate
      && typeof candidate === 'object'
      && (candidate as { method?: unknown }).method === method
    ))
    if (message) return message as AgentRuntimeRequest
    await Promise.resolve()
  }
  throw new Error(`等待 runtime 消息超时：${method}`)
}

/** 等待异步启动创建端口，适配启动 helper 引入的微任务边界。 */
async function waitForCreatedPort(index: number): Promise<FakeRuntimePort> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = createdPorts[index]
    if (port) return port
    await Promise.resolve()
  }
  throw new Error(`等待 Agent runtime 端口超时：${index}`)
}

describe('Agent runtime 生命周期隔离', () => {
  test('Given 旧 runtime capability 仍等待 When 新 runtime 已替换端口 Then 迟到响应不会进入新端口', async () => {
    /** 被测客户端。 */
    const client = new AgentRuntimeClient({ sessionId: 'session-late-capability' })
    /** 仅在测试中操控代次所需的内部视图。 */
    const harness = client as unknown as AgentRuntimeClientHarness
    /** 旧 runtime 使用的端口。 */
    const oldPort = new FakeRuntimePort()
    /** 替换 runtime 使用的新端口。 */
    const replacementPort = new FakeRuntimePort()
    /** 旧 runtime 进程身份。 */
    const oldProcess = {}
    /** 新 runtime 进程身份。 */
    const replacementProcess = {}
    /** 模拟仍在等待用户/Host 的 capability。 */
    const capability = createDeferred<{ accepted: boolean }>()
    harness.port = oldPort
    harness.runtimeProcess = oldProcess
    harness.generation = 1
    harness.bootId = 'boot-old'
    harness.requestHandler = async () => capability.promise
    /** 旧 runtime 发出的 capability 请求。 */
    const request = createAgentRuntimeRequest(
      AGENT_RUNTIME_METHODS.CAPABILITY_EVALUATE_COMPLETION,
      { queryId: 'query-old' },
      { sessionId: 'session-late-capability', queryId: 'query-old' },
      'boot-old',
    )

    /** 仍等待 Host 回调的旧 runtime 请求。 */
    const handling = harness.handleIncomingRequest(request)
    harness.port = replacementPort
    harness.runtimeProcess = replacementProcess
    harness.generation = 2
    harness.bootId = 'boot-new'
    capability.resolve({ accepted: true })
    await handling

    expect(oldPort.sent).toHaveLength(0)
    expect(replacementPort.sent).toHaveLength(0)
  })

  test('Given handshake 尚未完成 When stop 与 start 竞态 Then 客户端最终保持 stopped 而不是 crashed', async () => {
    createdPorts.length = 0
    createdProcesses.length = 0
    forkCreatesSpawnedProcess = true
    forkProcessExitsOnKill = true
    /** 被测客户端。 */
    const client = new AgentRuntimeClient({ sessionId: 'session-stop-start' })
    /** 尚未收到 handshake 的启动 Promise。 */
    const starting = client.start()
    /** 本轮启动创建的主进程端口。 */
    const port = await waitForCreatedPort(0)
    await waitForMessage(port, AGENT_RUNTIME_METHODS.HANDSHAKE)

    /** 与未完成启动并发的停止 Promise。 */
    const stopping = client.stop()
    /** stop 向 runtime 发出的关闭请求。 */
    const shutdownRequest = await waitForMessage(port, AGENT_RUNTIME_METHODS.SHUTDOWN)
    port.emit(createAgentRuntimeResponse(shutdownRequest, { payload: { accepted: true } }, AGENT_RUNTIME_BOOTSTRAP_ID))

    await expect(starting).rejects.toBeInstanceOf(Error)
    await expect(stopping).resolves.toBeUndefined()
    expect(client.currentState).toEqual<AgentRuntimeState>({
      status: 'stopped',
      bootId: AGENT_RUNTIME_BOOTSTRAP_ID,
      pid: null,
      active: false,
      pendingRequests: 0,
    })
    expect(createdProcesses[0]?.killed).toBe(true)
  })

  test('Given stop 早于 utility spawn When spawn 到达 Then 等真实 exit 后进入 stopped', async () => {
    createdPorts.length = 0
    createdProcesses.length = 0
    forkCreatesSpawnedProcess = false
    forkProcessExitsOnKill = true
    /** 被测客户端。 */
    const client = new AgentRuntimeClient({ sessionId: 'session-stop-before-spawn' })
    /** 尚未收到 handshake 的启动 Promise。 */
    const starting = client.start()
    /** 本轮启动创建的主进程端口。 */
    const port = await waitForCreatedPort(0)
    await waitForMessage(port, AGENT_RUNTIME_METHODS.HANDSHAKE)
    /** spawn 前发起的停止 Promise。 */
    const stopping = client.stop()
    /** stop 向 runtime 发出的关闭请求。 */
    const shutdownRequest = await waitForMessage(port, AGENT_RUNTIME_METHODS.SHUTDOWN)
    port.emit(createAgentRuntimeResponse(shutdownRequest, { payload: { accepted: true } }, AGENT_RUNTIME_BOOTSTRAP_ID))

    await expect(starting).rejects.toBeInstanceOf(Error)
    expect(await Promise.race([
      stopping.then(() => 'resolved' as const, () => 'rejected' as const),
      Bun.sleep(20).then(() => 'pending' as const),
    ])).toBe('pending')
    createdProcesses[0]!.emitSpawn(1001)

    await expect(stopping).resolves.toBeUndefined()
    expect(client.currentState.status).toBe('stopped')
  })

  test('Given utility 无法在时限内退出 When stop Then 保留所有权并阻止重启', async () => {
    createdPorts.length = 0
    createdProcesses.length = 0
    forkCreatesSpawnedProcess = true
    forkProcessExitsOnKill = false
    /** 使用短退出预算的被测客户端。 */
    const client = new AgentRuntimeClient({ sessionId: 'session-stop-timeout', startupTimeoutMs: 5 })
    /** 尚未收到 handshake 的启动 Promise。 */
    const starting = client.start()
    /** 本轮启动创建的主进程端口。 */
    const port = await waitForCreatedPort(0)
    await waitForMessage(port, AGENT_RUNTIME_METHODS.HANDSHAKE)
    /** 无法完成真实 exit 的停止 Promise。 */
    const stopping = client.stop()
    /** stop 向 runtime 发出的关闭请求。 */
    const shutdownRequest = await waitForMessage(port, AGENT_RUNTIME_METHODS.SHUTDOWN)
    port.emit(createAgentRuntimeResponse(shutdownRequest, { payload: { accepted: true } }, AGENT_RUNTIME_BOOTSTRAP_ID))

    await expect(starting).rejects.toBeInstanceOf(Error)
    await expect(stopping).rejects.toMatchObject({ code: UTILITY_PROCESS_EXIT_TIMEOUT_CODE })
    expect(client.currentState.status).toBe('crashed')
    await expect(client.start()).rejects.toThrow('cleanup incomplete')

    createdProcesses[0]!.emitExit(0)
    await expect(client.stop()).resolves.toBeUndefined()
    expect(client.currentState.status).toBe('stopped')
  })
})
