import { describe, expect, test } from 'bun:test'
import type { ApiResolvedRequest, ApiTransportResult } from '@proma/shared'
import { ApiRuntimeClient, type ApiRuntimeProcess } from './api-runtime-client'

/** 测试使用的最小执行请求。 */
function resolvedRequest(): ApiResolvedRequest {
  return {
    method: 'GET', url: 'http://127.0.0.1:8080/', headers: [], body: '', timeoutMs: 1_000,
    followRedirects: false, maxRedirects: 0, sensitiveHeaderNames: [], sensitiveQueryNames: [],
  }
}

/** 测试使用的成功传输结果。 */
function completedResult(): ApiTransportResult {
  return {
    state: 'completed', hops: [],
    body: { rawBytes: 0, decodedBytes: 0, contentType: '', encoding: '', preview: '', previewTruncated: false, complete: true, decoded: false },
  }
}

/** 可精确驱动 spawn/message/exit 顺序的内存 utility process。 */
class FakeRuntimeProcess implements ApiRuntimeProcess {
  readonly pid = 12345
  readonly posted: unknown[] = []
  killCalls = 0
  killResult = true
  postMessageError: Error | undefined
  killError: Error | undefined
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  postMessage(message: unknown): void { if (this.postMessageError) throw this.postMessageError; this.posted.push(message) }
  kill(): boolean { this.killCalls += 1; if (this.killError) throw this.killError; return this.killResult }
  on(event: 'spawn' | 'message' | 'error' | 'exit', listener: (...args: unknown[]) => void): void {
    const entries = this.listeners.get(event) ?? []
    entries.push(listener)
    this.listeners.set(event, entries)
  }
  /** 触发一个 Electron utility lifecycle 事件。 */
  emit(event: 'spawn' | 'message' | 'error' | 'exit', ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

describe('ApiRuntimeClient', () => {
  test('Given utility 先发事件增量再发结果，When 运行，Then 回调按批收到事件且终态不变', async () => {
    const process = new FakeRuntimeProcess()
    const client = new ApiRuntimeClient({ createProcess: () => process, uuid: () => 'request-1' })
    const batches: string[][] = []
    const running = client.run(resolvedRequest(), { onEvent: (events) => batches.push(events.map((event) => event.data)) })
    process.emit('spawn')
    process.emit('message', { type: 'api-workbench.stream', requestId: 'request-1', events: [{ index: 0, receivedMs: 4, event: 'message', id: '', comment: '', data: '甲', raw: 'data: 甲\n', truncated: false }] })
    process.emit('message', { type: 'api-workbench.stream', requestId: 'request-other', events: [{ index: 1, receivedMs: 5, event: '', id: '', comment: '', data: '其它', raw: 'data: 其它\n', truncated: false }] })
    process.emit('message', { type: 'api-workbench.result', requestId: 'request-1', result: completedResult() })
    process.emit('message', { type: 'api-workbench.stream', requestId: 'request-1', events: [{ index: 2, receivedMs: 6, event: '', id: '', comment: '', data: '迟到', raw: 'data: 迟到\n', truncated: false }] })
    process.emit('exit', 0)

    await expect(running).resolves.toEqual(completedResult())
    expect(batches).toEqual([['甲']])
    expect(process.posted.at(-1)).toEqual({ type: 'api-workbench.ack', requestId: 'request-1' })
  })

  test('Given utility 返回正确 requestId，When 进程尚未退出，Then run 仍保持在途', async () => {
    const process = new FakeRuntimeProcess()
    const client = new ApiRuntimeClient({ createProcess: () => process, uuid: () => 'request-1' })
    let settled = false
    const running = client.run(resolvedRequest()).finally(() => { settled = true })
    process.emit('spawn')
    expect(process.posted).toEqual([{ type: 'api-workbench.run', requestId: 'request-1', request: resolvedRequest() }])
    process.emit('message', { type: 'api-workbench.result', requestId: 'request-1', result: completedResult() })
    expect(process.posted.at(-1)).toEqual({ type: 'api-workbench.ack', requestId: 'request-1' })
    await Promise.resolve()
    expect(settled).toBe(false)

    process.emit('exit', 0)
    await expect(running).resolves.toEqual(completedResult())
  })

  test('Given utility 回传其他 requestId，When 随后退出，Then 不接受错配结果', async () => {
    const process = new FakeRuntimeProcess()
    const client = new ApiRuntimeClient({ createProcess: () => process, uuid: () => 'request-1' })
    const running = client.run(resolvedRequest())
    process.emit('spawn')
    process.emit('message', { type: 'api-workbench.result', requestId: 'request-other', result: completedResult() })
    process.emit('exit', 1)

    const result = await running
    expect(result.state).toBe('failed')
    expect(result.error?.code).toBe('API_RUNTIME_EXITED')
  })

  test('Given abort 早于 spawn 且首次 kill 未命中，When spawn 到达，Then 补发 kill 并等待 exit', async () => {
    const process = new FakeRuntimeProcess()
    process.killResult = false
    const controller = new AbortController()
    const client = new ApiRuntimeClient({ createProcess: () => process, uuid: () => 'request-1' })
    let settled = false
    const running = client.run(resolvedRequest(), { signal: controller.signal }).finally(() => { settled = true })
    controller.abort()
    expect(process.killCalls).toBe(1)
    process.killResult = true
    process.emit('spawn')
    expect(process.killCalls).toBe(2)
    await Promise.resolve()
    expect(settled).toBe(false)

    process.emit('exit', 0)
    const result = await running
    expect(result.state).toBe('cancelled')
    expect(result.error?.code).toBe('API_ABORTED')
  })

  test('Given 多个在途运行，When shutdown，Then 杀死全部进程并等待各自真实 exit', async () => {
    const processes = [new FakeRuntimeProcess(), new FakeRuntimeProcess()]
    let index = 0
    const client = new ApiRuntimeClient({ createProcess: () => processes[index++]!, uuid: () => `request-${index}` })
    const first = client.run(resolvedRequest())
    const second = client.run(resolvedRequest())
    processes.forEach((process) => process.emit('spawn'))
    let shutdownSettled = false
    const shutdown = client.shutdown().finally(() => { shutdownSettled = true })
    expect(processes.map((process) => process.killCalls)).toEqual([1, 1])
    processes[0]?.emit('exit', 0)
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)
    processes[1]?.emit('exit', 0)
    await shutdown
    await Promise.all([first, second])
  })

  test('Given 硬超时早于 spawn 且 kill 未命中，When 随后 spawn，Then 补发 kill 且不发送 run', async () => {
    const process = new FakeRuntimeProcess()
    process.killResult = false
    const client = new ApiRuntimeClient({ createProcess: () => process, uuid: () => 'request-timeout', exitGraceMs: 0 })
    const running = client.run({ ...resolvedRequest(), timeoutMs: 1 })
    await Bun.sleep(10)
    expect(process.killCalls).toBe(1)
    process.killResult = true
    process.emit('spawn')
    expect(process.killCalls).toBe(2)
    expect(process.posted).toEqual([])
    process.emit('exit', 1)
    expect((await running).error?.code).toBe('API_RUNTIME_TIMEOUT')
  })

  test('Given run postMessage 抛错，When spawn，Then 转为进程失败并等待 exit', async () => {
    const process = new FakeRuntimeProcess()
    process.postMessageError = new Error('synthetic post failure')
    const client = new ApiRuntimeClient({ createProcess: () => process, uuid: () => 'request-post' })
    const running = client.run(resolvedRequest())

    expect(() => process.emit('spawn')).not.toThrow()
    expect(process.killCalls).toBe(1)
    process.emit('exit', 1)
    expect((await running).error?.code).toBe('API_RUNTIME_PROCESS_ERROR')
  })

  test('Given kill 抛错，When abort 早于 spawn，Then 事件回调不抛且仍等待 exit', async () => {
    const process = new FakeRuntimeProcess()
    process.killError = new Error('synthetic kill failure')
    const controller = new AbortController()
    const client = new ApiRuntimeClient({ createProcess: () => process, uuid: () => 'request-kill' })
    const running = client.run(resolvedRequest(), { signal: controller.signal })

    expect(() => controller.abort()).not.toThrow()
    expect(() => process.emit('spawn')).not.toThrow()
    process.emit('exit', 1)
    expect((await running).state).toBe('cancelled')
  })

  test('Given 重复 result，When 正常 exit，Then 首个严格匹配结果是唯一回执', async () => {
    const process = new FakeRuntimeProcess()
    const client = new ApiRuntimeClient({ createProcess: () => process, uuid: () => 'request-duplicate' })
    const running = client.run(resolvedRequest())
    process.emit('spawn')
    process.emit('message', { type: 'api-workbench.result', requestId: 'request-duplicate', result: completedResult() })
    process.emit('message', { type: 'api-workbench.result', requestId: 'request-duplicate', result: { ...completedResult(), state: 'cancelled' } })
    process.emit('exit', 0)

    expect((await running).state).toBe('completed')
  })

  test('Given 已请求取消且 utility 回传 partial，When 正常 exit，Then 保留 utility 的取消正文事实', async () => {
    const process = new FakeRuntimeProcess()
    const controller = new AbortController()
    const client = new ApiRuntimeClient({ createProcess: () => process, uuid: () => 'request-partial' })
    const running = client.run(resolvedRequest(), { signal: controller.signal })
    process.emit('spawn')
    controller.abort()
    const partial: ApiTransportResult = {
      state: 'cancelled', hops: [],
      body: { ...completedResult().body, preview: 'partial', complete: false },
      error: { code: 'API_ABORTED', phase: 'cancel', message: '请求已取消' },
    }
    process.emit('message', { type: 'api-workbench.result', requestId: 'request-partial', result: partial })
    process.emit('exit', 0)

    expect(await running).toEqual(partial)
  })

  test('Given 成功 result 后进程非零退出，When 收口，Then exit 异常优先且保留正文事实', async () => {
    const process = new FakeRuntimeProcess()
    const client = new ApiRuntimeClient({ createProcess: () => process, uuid: () => 'request-exit' })
    const resultWithBody: ApiTransportResult = { ...completedResult(), body: { ...completedResult().body, preview: 'received' } }
    const running = client.run(resolvedRequest())
    process.emit('spawn')
    process.emit('message', { type: 'api-workbench.result', requestId: 'request-exit', result: resultWithBody })
    process.emit('exit', 7)

    const result = await running
    expect(result.state).toBe('failed')
    expect(result.error?.code).toBe('API_RUNTIME_EXITED')
    expect(result.body.preview).toBe('received')
  })

  test('Given shutdown 后 utility 不退出，When 两阶段时限耗尽，Then 请求 SIGKILL 并明确报超时', async () => {
    const process = new FakeRuntimeProcess()
    const forced: number[] = []
    const client = new ApiRuntimeClient({
      createProcess: () => process, uuid: () => 'request-stuck', shutdownGraceMs: 1, forceKillGraceMs: 1,
      forceKill: (pid) => { forced.push(pid) },
    })
    const running = client.run(resolvedRequest())
    process.emit('spawn')

    await expect(client.shutdown()).rejects.toThrow('API_RUNTIME_SHUTDOWN_TIMEOUT')
    expect(process.killCalls).toBe(1)
    expect(forced).toEqual([12345])
    process.emit('exit', 1)
    await running
  })
})
