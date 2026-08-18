import { describe, expect, test } from 'bun:test'
import type { LanBridgeDeviceDto } from '@proma/shared'
import {
  createLanBridgeSettingsRequestCoordinator,
  getPairingCountdown,
  removeRevokedDevice,
  shouldRunPairingCountdown,
} from './lan-bridge-settings-logic'

/** 可手动控制结算顺序的 Promise。 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

/** 创建 deferred Promise，模拟 IPC 乱序响应。 */
function createDeferred<T>(): Deferred<T> {
  /** Promise 的成功结算函数。 */
  let resolvePromise: ((value: T) => void) | undefined
  /** 由测试稍后结算的 Promise。 */
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: value => resolvePromise?.(value) }
}

describe('LAN Bridge 设置页纯逻辑', () => {
  test('Given 二维码仍有效 When 计算倒计时 Then 向上取整并生成稳定中文时间', () => {
    expect(getPairingCountdown(61_001, 0)).toEqual({
      expired: false,
      secondsRemaining: 62,
      label: '1 分 02 秒',
    })
  })

  test('Given 二维码刚好到期 When 计算倒计时 Then 返回过期状态且不出现负数', () => {
    expect(getPairingCountdown(1_000, 1_000)).toEqual({
      expired: true,
      secondsRemaining: 0,
      label: '已过期',
    })
    expect(getPairingCountdown(1_000, 5_000).secondsRemaining).toBe(0)
    expect(shouldRunPairingCountdown(1_001, 1_000)).toBe(true)
    expect(shouldRunPairingCountdown(1_000, 1_000)).toBe(false)
    expect(shouldRunPairingCountdown(1_000, 5_000)).toBe(false)
  })

  test('Given 撤销成功 When 更新设备列表 Then 仅移除目标设备且不修改原数组', () => {
    /** 测试使用的两个授权设备。 */
    const devices: LanBridgeDeviceDto[] = [
      { id: 'a', name: 'iPhone', createdAt: 1, lastSeenAt: 2, tokenVersion: 1 },
      { id: 'b', name: 'Android', createdAt: 3, lastSeenAt: 4, tokenVersion: 1 },
    ]

    expect(removeRevokedDevice(devices, 'a')).toEqual([devices[1]!])
    expect(devices).toHaveLength(2)
  })

  test('Given 连续刷新二维码 When 旧请求先返回 Then 旧 success/finally 不覆盖新状态或提前清 loading', async () => {
    /** 两次连续二维码请求。 */
    const first = createDeferred<string>()
    const second = createDeferred<string>()
    /** 模拟组件展示的数据与 loading。 */
    let displayed = ''
    let loading = false
    const coordinator = createLanBridgeSettingsRequestCoordinator()
    coordinator.setRunning(true)
    /** 复用组件真实提交语义。 */
    const callbacks = {
      onStart: () => { loading = true },
      onSuccess: (value: string) => { displayed = value },
      onError: () => undefined,
      onSettled: () => { loading = false },
    }
    const firstRun = coordinator.run('pairingQr', () => first.promise, callbacks)
    const secondRun = coordinator.run('pairingQr', () => second.promise, callbacks)

    first.resolve('old-qr')
    await firstRun
    expect(displayed).toBe('')
    expect(loading).toBe(true)

    second.resolve('new-qr')
    await secondRun
    expect(displayed).toBe('new-qr')
    expect(loading).toBe(false)
  })

  test('Given stop 后 restart When 旧设备请求迟到 Then 只允许新运行周期提交', async () => {
    /** stop 前后的设备请求。 */
    const stoppedRequest = createDeferred<string[]>()
    const restartedRequest = createDeferred<string[]>()
    /** 模拟组件设备列表。 */
    let devices: string[] = []
    const coordinator = createLanBridgeSettingsRequestCoordinator()
    coordinator.setRunning(true)
    /** 设备请求共用的提交动作。 */
    const callbacks = {
      onStart: () => undefined,
      onSuccess: (value: string[]) => { devices = value },
      onError: () => undefined,
      onSettled: () => undefined,
    }
    const oldRun = coordinator.run('devices', () => stoppedRequest.promise, callbacks)
    coordinator.setRunning(false)
    coordinator.setRunning(true)
    const newRun = coordinator.run('devices', () => restartedRequest.promise, callbacks)

    stoppedRequest.resolve(['old-device'])
    await oldRun
    expect(devices).toEqual([])
    restartedRequest.resolve(['new-device'])
    await newRun
    expect(devices).toEqual(['new-device'])
  })

  test('Given PIN 请求 pending When 组件卸载 Then 迟到响应不执行任何状态回调', async () => {
    /** 卸载后才返回的 PIN 请求。 */
    const deferred = createDeferred<string>()
    /** 记录卸载后是否仍触发回调。 */
    const events: string[] = []
    const coordinator = createLanBridgeSettingsRequestCoordinator()
    coordinator.setRunning(true)
    const run = coordinator.run('pin', () => deferred.promise, {
      onStart: () => events.push('start'),
      onSuccess: value => events.push(`success:${value}`),
      onError: () => events.push('error'),
      onSettled: () => events.push('settled'),
    })

    coordinator.unmount()
    deferred.resolve('123456')
    await run

    expect(events).toEqual(['start'])
  })
})
