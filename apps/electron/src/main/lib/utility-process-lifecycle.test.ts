import { describe, expect, test } from 'bun:test'
import {
  UTILITY_PROCESS_EXIT_TIMEOUT_CODE,
  createUtilityProcessLifecycle,
  type UtilityProcessLifecycleTarget,
} from './utility-process-lifecycle'

/** 可控的 utility process 生命周期替身。 */
class FakeUtilityProcess implements UtilityProcessLifecycleTarget {
  /** spawn 后、exit 前可见的进程 PID。 */
  pid: number | undefined
  /** kill 调用次数。 */
  killCalls = 0
  /** kill 后是否自动发出 exit。 */
  exitOnKill = false
  /** spawn 一次性监听器。 */
  private spawnListener?: () => void
  /** exit 一次性监听器。 */
  private exitListener?: (code: number) => void

  constructor(pid?: number) {
    this.pid = pid
  }

  once(event: 'spawn', listener: () => void): this
  once(event: 'exit', listener: (code: number) => void): this
  once(event: 'spawn' | 'exit', listener: (() => void) | ((code: number) => void)): this {
    if (event === 'spawn') this.spawnListener = listener as () => void
    else this.exitListener = listener as (code: number) => void
    return this
  }

  kill(): boolean {
    this.killCalls += 1
    if (this.exitOnKill) queueMicrotask(() => this.emitExit(0))
    return true
  }

  /** 模拟 Electron 完成底层进程 spawn。 */
  emitSpawn(pid: number): void {
    this.pid = pid
    const listener = this.spawnListener
    this.spawnListener = undefined
    listener?.()
  }

  /** 模拟 Electron 回收底层进程并发出 exit。 */
  emitExit(code: number): void {
    this.pid = undefined
    const listener = this.exitListener
    this.exitListener = undefined
    listener?.(code)
  }
}

describe('utility process 可等待生命周期', () => {
  test('Given 已 spawn 进程 When stop Then kill 并等待 exit 后完成', async () => {
    /** 已完成 spawn 的测试进程。 */
    const process = new FakeUtilityProcess(101)
    process.exitOnKill = true
    /** 被测生命周期。 */
    const lifecycle = createUtilityProcessLifecycle(process)

    await expect(lifecycle.stop()).resolves.toBeUndefined()

    expect(process.killCalls).toBe(1)
    expect(lifecycle.hasExited).toBe(true)
    await expect(lifecycle.waitForExit()).resolves.toBe(0)
  })

  test('Given 进程已经 exit When stop Then 不重复 kill', async () => {
    /** exit 先于 stop 的测试进程。 */
    const process = new FakeUtilityProcess(202)
    /** 被测生命周期。 */
    const lifecycle = createUtilityProcessLifecycle(process)
    process.emitExit(7)

    await expect(lifecycle.stop()).resolves.toBeUndefined()

    expect(process.killCalls).toBe(0)
    await expect(lifecycle.waitForExit()).resolves.toBe(7)
  })

  test('Given stop 早于 spawn When spawn 到达 Then 立即 kill 并等待 exit', async () => {
    /** 尚未完成 spawn 的测试进程。 */
    const process = new FakeUtilityProcess()
    process.exitOnKill = true
    /** 被测生命周期。 */
    const lifecycle = createUtilityProcessLifecycle(process)
    /** spawn 前发起的停止 Promise。 */
    const stopping = lifecycle.stop()
    expect(process.killCalls).toBe(0)

    process.emitSpawn(303)

    await expect(stopping).resolves.toBeUndefined()
    expect(process.killCalls).toBe(1)
    expect(lifecycle.hasExited).toBe(true)
  })

  test('Given kill 后没有 exit When 超过时限 Then 返回稳定超时错误', async () => {
    /** 不响应 kill 的测试进程。 */
    const process = new FakeUtilityProcess(404)
    /** 使用最短测试预算的生命周期。 */
    const lifecycle = createUtilityProcessLifecycle(process, { exitTimeoutMs: 5 })

    await expect(lifecycle.stop()).rejects.toMatchObject({
      code: UTILITY_PROCESS_EXIT_TIMEOUT_CODE,
    })

    expect(process.killCalls).toBe(1)
    expect(lifecycle.hasExited).toBe(false)
  })

  test('Given 首次 stop 超时后进程才 exit When 再次 stop Then 允许调用方完成清理', async () => {
    /** 首次停止预算内不退出的测试进程。 */
    const process = new FakeUtilityProcess(505)
    /** 使用最短测试预算的生命周期。 */
    const lifecycle = createUtilityProcessLifecycle(process, { exitTimeoutMs: 5 })
    await expect(lifecycle.stop()).rejects.toMatchObject({
      code: UTILITY_PROCESS_EXIT_TIMEOUT_CODE,
    })

    process.emitExit(0)

    await expect(lifecycle.stop()).resolves.toBeUndefined()
    expect(lifecycle.hasExited).toBe(true)
  })
})
