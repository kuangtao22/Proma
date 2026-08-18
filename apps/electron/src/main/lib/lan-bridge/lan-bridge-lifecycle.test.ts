import { describe, expect, test } from 'bun:test'
import { createLanBridgeStartCoordinator } from './lan-bridge-lifecycle'
import {
  LAN_BRIDGE_MAX_PAYLOAD_BYTES,
  LAN_BRIDGE_WEBSOCKET_SERVER_OPTIONS,
} from './lan-bridge-server-options'

/** 创建由测试显式完成的 Promise。 */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  /** 完成当前 Promise 的回调。 */
  let resolvePromise: (() => void) | undefined
  /** 当前测试控制的 Promise。 */
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: () => { resolvePromise?.() },
  }
}

describe('LAN Bridge 生命周期资源边界', () => {
  test('并发 start 只执行一次启动操作', async () => {
    /** 当前用例的启动协调器。 */
    const coordinator = createLanBridgeStartCoordinator()
    /** 控制唯一启动操作的完成时机。 */
    const deferred = createDeferred()
    /** 实际执行的启动次数。 */
    let startCount = 0
    /** 被并发调用复用的启动操作。 */
    const operation = async (): Promise<void> => {
      startCount++
      await deferred.promise
    }

    /** 首次启动 Promise。 */
    const firstStart = coordinator.run(operation)
    /** 同代次并发启动 Promise。 */
    const secondStart = coordinator.run(operation)

    expect(startCount).toBe(1)
    expect(secondStart).toBe(firstStart)

    deferred.resolve()
    await Promise.all([firstStart, secondStart])
  })

  test('stop 取消未完成启动，后续 start 等旧操作退出后再执行', async () => {
    /** 当前用例的启动协调器。 */
    const coordinator = createLanBridgeStartCoordinator()
    /** 控制旧启动操作的完成时机。 */
    const deferred = createDeferred()
    /** 记录旧启动观察到的取消状态。 */
    let oldStartCancelled = false
    /** 记录 stop 后新启动的执行次数。 */
    let newStartCount = 0
    /** 尚未完成的旧启动 Promise。 */
    const oldStart = coordinator.run(async (isCancelled) => {
      await deferred.promise
      oldStartCancelled = isCancelled()
    })

    coordinator.cancelPending()
    /** stop 后请求的新启动 Promise。 */
    const newStart = coordinator.run(async () => {
      newStartCount++
    })

    expect(newStartCount).toBe(0)
    deferred.resolve()
    await Promise.all([oldStart, newStart])

    expect(oldStartCancelled).toBeTrue()
    expect(newStartCount).toBe(1)
  })

  test('WebSocketServer 固定使用 64 KiB 入站消息上限', () => {
    expect(LAN_BRIDGE_MAX_PAYLOAD_BYTES).toBe(64 * 1_024)
    expect(LAN_BRIDGE_WEBSOCKET_SERVER_OPTIONS).toEqual({
      noServer: true,
      maxPayload: 64 * 1_024,
    })
  })
})
