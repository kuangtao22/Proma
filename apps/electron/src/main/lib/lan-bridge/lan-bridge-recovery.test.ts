import { describe, expect, test } from 'bun:test'
import type { AgentEventBus } from '../agent-event-bus'
import { createLanBridgeRecoveryController } from './lan-bridge-recovery'

/** 创建仅用于身份比较的 EventBus 测试对象。 */
function createEventBus(): AgentEventBus {
  return {} as unknown as AgentEventBus
}

describe('LAN Bridge 自愈控制器', () => {
  test('仅在配置启用且状态为 error 时需要恢复', () => {
    let enabled = false
    let status: 'running' | 'error' = 'error'
    const controller = createLanBridgeRecoveryController({
      isEnabled: () => enabled,
      getStatus: () => status,
      getActiveEventBus: () => null,
      stop: () => undefined,
      start: async () => undefined,
    })

    expect(controller.needsRecovery()).toBeFalse()

    enabled = true
    status = 'running'
    expect(controller.needsRecovery()).toBeFalse()

    status = 'error'
    expect(controller.needsRecovery()).toBeTrue()
  })

  test('recover 严格按 stop 到 start 顺序执行并等待 start 完成', async () => {
    const eventBus = createEventBus()
    const calls: string[] = []
    let finishStart: (() => void) | undefined
    let recoveryResolved = false
    const startPromise = new Promise<void>((resolve) => {
      finishStart = resolve
    })
    const controller = createLanBridgeRecoveryController({
      isEnabled: () => true,
      getStatus: () => 'error',
      getActiveEventBus: () => eventBus,
      stop: () => { calls.push('stop') },
      start: async (bus) => {
        calls.push('start')
        expect(bus).toBe(eventBus)
        await startPromise
      },
    })

    const recoveryPromise = controller.recover().then(() => {
      recoveryResolved = true
    })
    await Promise.resolve()

    expect(calls).toEqual(['stop', 'start'])
    expect(recoveryResolved).toBeFalse()

    finishStart?.()
    await recoveryPromise
    expect(recoveryResolved).toBeTrue()
  })

  test('首次启动失败并清空 active bus 后仍可用最近 bus 再次恢复', async () => {
    const eventBus = createEventBus()
    let activeEventBus: AgentEventBus | null = eventBus
    let startCount = 0
    const receivedBuses: Array<AgentEventBus | undefined> = []
    const controller = createLanBridgeRecoveryController({
      isEnabled: () => true,
      getStatus: () => 'error',
      getActiveEventBus: () => activeEventBus,
      stop: () => { activeEventBus = null },
      start: async (bus) => {
        receivedBuses.push(bus)
        startCount++
        if (startCount === 1) throw new Error('start failed')
      },
    })

    await expect(controller.recover()).rejects.toThrow('start failed')
    await controller.recover()

    expect(receivedBuses).toEqual([eventBus, eventBus])
  })

  test('从未记录 EventBus 时使用 undefined 启动', async () => {
    const receivedBuses: Array<AgentEventBus | undefined> = []
    const controller = createLanBridgeRecoveryController({
      isEnabled: () => true,
      getStatus: () => 'error',
      getActiveEventBus: () => null,
      stop: () => undefined,
      start: async (bus) => { receivedBuses.push(bus) },
    })

    controller.rememberEventBus(undefined)
    await controller.recover()

    expect(receivedBuses).toEqual([undefined])
  })
})
