import type { LanBridgeDeviceDto } from '@proma/shared'

/** 设置页展示的二维码剩余时间。 */
export interface PairingCountdown {
  expired: boolean
  secondsRemaining: number
  label: string
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

/** 从当前授权列表即时移除已撤销设备。 */
export function removeRevokedDevice(
  devices: LanBridgeDeviceDto[],
  deviceId: string,
): LanBridgeDeviceDto[] {
  return devices.filter(device => device.id !== deviceId)
}
