import type { LanBridgeDeviceDto } from '@proma/shared'

/** 设置页展示的二维码剩余时间。 */
export interface PairingCountdown {
  expired: boolean
  secondsRemaining: number
  label: string
}

/** 将完整设备标识格式化为设置页可扫描的短标签。 */
export function formatDeviceIdentifier(deviceId: string): string {
  if (deviceId.length <= 12) return deviceId
  return `${deviceId.slice(0, 8)}...${deviceId.slice(-4)}`
}

/** 计算二维码倒计时展示状态。 */
export function getPairingCountdown(expiresAt: number, now: number): PairingCountdown {
  /** 向上取整保证剩余不足一秒时仍显示 1 秒，而不是提前过期。 */
  const secondsRemaining = Math.max(0, Math.ceil((expiresAt - now) / 1_000))
  if (secondsRemaining === 0) return { expired: true, secondsRemaining, label: '已过期' }
  /** 以紧凑中文格式显示二维码剩余分钟和秒数。 */
  const minutes = Math.floor(secondsRemaining / 60)
  /** 分钟之外的剩余秒数。 */
  const seconds = secondsRemaining % 60
  return {
    expired: false,
    secondsRemaining,
    label: minutes > 0
      ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
      : `${seconds} 秒`,
  }
}

/** 判断二维码倒计时是否仍需继续调度。 */
export function shouldRunPairingCountdown(expiresAt: number, now: number): boolean {
  return expiresAt > now
}

/** 从当前授权列表即时移除已撤销设备。 */
export function removeRevokedDevice(
  devices: LanBridgeDeviceDto[],
  deviceId: string,
): LanBridgeDeviceDto[] {
  return devices.filter(device => device.id !== deviceId)
}

/** 设置页受运行状态约束的异步资源类别。 */
export type LanBridgeSettingsRequestScope = 'pairingQr' | 'devicesList' | 'deviceRevoke' | 'pin'

/** 跨操作共享的数据结果类别。 */
export type LanBridgeSettingsResultScope = 'devices'

/** 单次请求可选的结果新旧约束。 */
export interface LanBridgeSettingsRequestOptions {
  /** 仅当共享结果世代未变化时才允许提交成功或错误。 */
  resultScope?: LanBridgeSettingsResultScope
}

/** 单次设置页异步请求的状态提交动作。 */
export interface LanBridgeSettingsRequestCallbacks<T> {
  /** 请求开始时设置 loading。 */
  onStart: () => void
  /** 当前请求成功时提交结果。 */
  onSuccess: (value: T) => void
  /** 当前请求失败时提交错误。 */
  onError: (error: unknown) => void
  /** 当前请求结束时清理 loading。 */
  onSettled: () => void
}

/** 设置页异步请求协调器。 */
export interface LanBridgeSettingsRequestCoordinator {
  /** 标记组件挂载；已挂载时保持当前生命周期。 */
  mount: () => void
  /** 更新 Bridge 运行态。 */
  setRunning: (running: boolean) => void
  /** 执行一次受生命周期保护的请求。 */
  run: <T>(
    scope: LanBridgeSettingsRequestScope,
    request: () => Promise<T>,
    callbacks: LanBridgeSettingsRequestCallbacks<T>,
    options?: LanBridgeSettingsRequestOptions,
  ) => Promise<void>
  /** 使指定数据类别的在途旧结果失效。 */
  invalidateResults: (scope: LanBridgeSettingsResultScope) => void
  /** 标记组件卸载。 */
  unmount: () => void
}

/** 创建按资源分代、受运行态和卸载态约束的设置页请求协调器。 */
export function createLanBridgeSettingsRequestCoordinator(): LanBridgeSettingsRequestCoordinator {
  /** 当前 Bridge 是否运行。 */
  let running = false
  /** 组件仅在 effect setup 与 cleanup 之间允许状态提交。 */
  let mounted = false
  /** stop/restart 或挂载状态转换时提升，统一淘汰所有旧请求。 */
  let lifecycleEpoch = 0
  /** 各资源独立分代，允许 QR、设备与 PIN 并行。 */
  const scopeGenerations = new Map<LanBridgeSettingsRequestScope, number>()
  /** 跨操作共享的数据世代，仅限制结果回写而不跳过各自 onSettled。 */
  const resultGenerations = new Map<LanBridgeSettingsResultScope, number>()
  return {
    mount: () => {
      if (mounted) return
      mounted = true
      lifecycleEpoch += 1
    },
    setRunning: value => {
      if (running === value) return
      running = value
      lifecycleEpoch += 1
    },
    run: async (scope, request, callbacks, options = {}) => {
      if (!mounted || !running) return
      /** 当前资源的新 generation 会立即淘汰上一同类请求。 */
      const generation = (scopeGenerations.get(scope) ?? 0) + 1
      scopeGenerations.set(scope, generation)
      /** 捕获请求启动时的全局生命周期。 */
      const requestEpoch = lifecycleEpoch
      /** 捕获设备等共享数据在请求启动时的结果世代。 */
      const resultGeneration = options.resultScope === undefined
        ? undefined
        : resultGenerations.get(options.resultScope) ?? 0
      /** 同时校验 mounted、running、epoch 与 scope generation。 */
      const isOperationCurrent = (): boolean => mounted
        && running
        && lifecycleEpoch === requestEpoch
        && scopeGenerations.get(scope) === generation
      /** 结果还需保证跨操作共享的数据世代未失效。 */
      const isResultCurrent = (): boolean => isOperationCurrent()
        && (options.resultScope === undefined
          || (resultGenerations.get(options.resultScope) ?? 0) === resultGeneration)
      callbacks.onStart()
      try {
        const value = await request()
        if (isResultCurrent()) callbacks.onSuccess(value)
      } catch (error) {
        if (isResultCurrent()) callbacks.onError(error)
      } finally {
        if (isOperationCurrent()) callbacks.onSettled()
      }
    },
    invalidateResults: scope => {
      resultGenerations.set(scope, (resultGenerations.get(scope) ?? 0) + 1)
    },
    unmount: () => {
      if (!mounted) return
      mounted = false
      lifecycleEpoch += 1
    },
  }
}
