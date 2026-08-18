import { describe, expect, test } from 'bun:test'
import type { LanBridgeDeviceDto } from '@proma/shared'
import { getPairingCountdown, removeRevokedDevice } from './lan-bridge-settings-logic'

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
})
