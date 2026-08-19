import { describe, expect, test } from 'bun:test'
import type { LanBridgeDeviceDto } from '@proma/shared'
import {
  createLanBridgeSettingsRequestCoordinator,
  formatDeviceIdentifier,
  getPairingCountdown,
  removeRevokedDevice,
  shouldRunPairingCountdown,
} from './lan-bridge-settings-logic'

/** 可手动控制结算顺序的 Promise。 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/** 创建 deferred Promise，模拟 IPC 乱序响应。 */
function createDeferred<T>(): Deferred<T> {
  /** Promise 的成功结算函数。 */
  let resolvePromise: ((value: T) => void) | undefined
  /** Promise 的失败结算函数。 */
  let rejectPromise: ((error: unknown) => void) | undefined
  /** 由测试稍后结算的 Promise。 */
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: value => resolvePromise?.(value),
    reject: error => rejectPromise?.(error),
  }
}

describe('LAN Bridge 设置页纯逻辑', () => {
  test('Given 完整设备 ID When 设置页展示 Then 保留首尾片段便于核对', () => {
    expect(formatDeviceIdentifier('mobile-device-1234567890')).toBe('mobile-d...7890')
    expect(formatDeviceIdentifier('device-1')).toBe('device-1')
  })

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
    coordinator.mount()
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
    coordinator.mount()
    coordinator.setRunning(true)
    /** 设备请求共用的提交动作。 */
    const callbacks = {
      onStart: () => undefined,
      onSuccess: (value: string[]) => { devices = value },
      onError: () => undefined,
      onSettled: () => undefined,
    }
    const oldRun = coordinator.run('devicesList', () => stoppedRequest.promise, callbacks)
    coordinator.setRunning(false)
    coordinator.setRunning(true)
    const newRun = coordinator.run('devicesList', () => restartedRequest.promise, callbacks)

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
    coordinator.mount()
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

  test('Given StrictMode 卸载重挂 When 旧请求迟到且新请求完成 Then 仅新生命周期可提交', async () => {
    /** 卸载前分别成功和失败的两个迟到请求。 */
    const oldSuccess = createDeferred<string>()
    const oldError = createDeferred<string>()
    /** 重挂后正常完成的新请求。 */
    const freshRequest = createDeferred<string>()
    /** 记录各生命周期实际提交的回调。 */
    const events: string[] = []
    const coordinator = createLanBridgeSettingsRequestCoordinator()
    coordinator.mount()
    coordinator.setRunning(true)
    const oldSuccessRun = coordinator.run('pairingQr', () => oldSuccess.promise, {
      onStart: () => events.push('old-success:start'),
      onSuccess: () => events.push('old-success:success'),
      onError: () => events.push('old-success:error'),
      onSettled: () => events.push('old-success:settled'),
    })
    const oldErrorRun = coordinator.run('pin', () => oldError.promise, {
      onStart: () => events.push('old-error:start'),
      onSuccess: () => events.push('old-error:success'),
      onError: () => events.push('old-error:error'),
      onSettled: () => events.push('old-error:settled'),
    })

    /** 模拟 StrictMode cleanup 后重新 setup。 */
    coordinator.setRunning(false)
    coordinator.unmount()
    coordinator.mount()
    coordinator.setRunning(true)
    const freshRun = coordinator.run('devicesList', () => freshRequest.promise, {
      onStart: () => events.push('fresh:start'),
      onSuccess: value => events.push(`fresh:success:${value}`),
      onError: () => events.push('fresh:error'),
      onSettled: () => events.push('fresh:settled'),
    })
    /** 已挂载时重复 setup 不得使当前请求失效。 */
    coordinator.mount()

    oldSuccess.resolve('stale-success')
    oldError.reject(new Error('stale-error'))
    freshRequest.resolve('fresh-value')
    await Promise.all([oldSuccessRun, oldErrorRun, freshRun])

    expect(events).toEqual([
      'old-success:start',
      'old-error:start',
      'fresh:start',
      'fresh:success:fresh-value',
      'fresh:settled',
    ])
  })

  test('Given 首次设备列表请求 When 结果返回 Then 未初始化的共享结果世代允许正常提交', async () => {
    /** 首次加载返回的设备列表。 */
    const initialList = createDeferred<string[]>()
    /** 模拟组件当前设备数据。 */
    let devices: string[] = []
    const coordinator = createLanBridgeSettingsRequestCoordinator()
    coordinator.mount()
    coordinator.setRunning(true)
    const run = coordinator.run('devicesList', () => initialList.promise, {
      onStart: () => undefined,
      onSuccess: value => { devices = value },
      onError: () => undefined,
      onSettled: () => undefined,
    }, { resultScope: 'devices' })

    initialList.resolve(['device-a'])
    await run

    expect(devices).toEqual(['device-a'])
  })

  test.each([
    ['列表先发且先返回', 'list', 'list'],
    ['列表先发且撤销先返回', 'list', 'revoke'],
    ['撤销先发且列表先返回', 'revoke', 'list'],
    ['撤销先发且先返回', 'revoke', 'revoke'],
  ] as const)(
    'Given %s When 撤销后重载设备 Then 旧列表不回写且所有 pending 最终清零',
    async (_caseName, firstStarted, firstResolved) => {
      /** 撤销前列表、撤销请求和撤销后的权威列表。 */
      const staleList = createDeferred<string[]>()
      const revoke = createDeferred<void>()
      const freshList = createDeferred<string[]>()
      /** 模拟组件设备数据与两个独立 pending 状态。 */
      let devices = ['device-a', 'device-b']
      let listPending = false
      let revokePending = false
      const coordinator = createLanBridgeSettingsRequestCoordinator()
      coordinator.mount()
      coordinator.setRunning(true)

      /** 发起受共享设备数据世代保护的列表请求。 */
      const runList = (request: Deferred<string[]>): Promise<void> => coordinator.run(
        'devicesList',
        () => request.promise,
        {
          onStart: () => { listPending = true },
          onSuccess: value => { devices = value },
          onError: () => undefined,
          onSettled: () => { listPending = false },
        },
        { resultScope: 'devices' },
      )
      /** 撤销成功时使旧列表失效、即时移除设备并触发权威重载。 */
      const runRevoke = (): Promise<void> => coordinator.run('deviceRevoke', () => revoke.promise, {
        onStart: () => { revokePending = true },
        onSuccess: () => {
          coordinator.invalidateResults('devices')
          devices = devices.filter(device => device !== 'device-a')
          void runList(freshList)
        },
        onError: () => undefined,
        onSettled: () => { revokePending = false },
      })

      /** 按用例指定顺序启动两个交叉操作。 */
      const staleListRun = firstStarted === 'list' ? runList(staleList) : null
      const revokeRun = runRevoke()
      const ensuredStaleListRun = staleListRun ?? runList(staleList)

      if (firstResolved === 'list') {
        staleList.resolve(['device-a', 'device-b', 'stale-device'])
        await ensuredStaleListRun
        revoke.resolve()
        await revokeRun
      } else {
        revoke.resolve()
        await revokeRun
        staleList.resolve(['device-a', 'device-b', 'stale-device'])
        await ensuredStaleListRun
      }
      freshList.resolve(['device-b', 'fresh-device'])
      /** 撤销成功回调内启动的 Promise 在下一微任务结算。 */
      await Promise.resolve()
      await Promise.resolve()

      expect(devices).toEqual(['device-b', 'fresh-device'])
      expect(listPending).toBe(false)
      expect(revokePending).toBe(false)
    },
  )
})
