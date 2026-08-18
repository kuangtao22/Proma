import { describe, expect, test } from 'bun:test'
import { executeLanBridgeDeviceRevocation } from './lan-bridge-device-revocation'

describe('LAN Bridge 设备撤销 facade', () => {
  test('Given 设备已连接 When 撤销写盘成功 Then 先断开再推送不含该连接的最新状态', () => {
    /** 模拟 session manager 当前连接列表。 */
    const connectedClients = ['device-1', 'device-2']
    /** 记录 facade 外部副作用顺序。 */
    const events: string[] = []

    const result = executeLanBridgeDeviceRevocation({
      revokeDevice: () => ({ id: 'device-1' }),
      disconnectDevice: () => {
        connectedClients.splice(connectedClients.indexOf('device-1'), 1)
        events.push('disconnect')
      },
      notifyStatusChanged: () => events.push(`notify:${connectedClients.join(',')}`),
    })

    expect(result).toEqual({ id: 'device-1' })
    expect(events).toEqual(['disconnect', 'notify:device-2'])
  })

  test('Given 设备不存在或写盘失败 When 撤销 Then 不断开且不推送成功状态', () => {
    /** 记录不存在设备路径的副作用。 */
    const missingEvents: string[] = []
    expect(executeLanBridgeDeviceRevocation({
      revokeDevice: () => undefined,
      disconnectDevice: () => missingEvents.push('disconnect'),
      notifyStatusChanged: () => missingEvents.push('notify'),
    })).toBeUndefined()
    expect(missingEvents).toEqual([])

    /** 记录写盘异常路径的副作用。 */
    const failedEvents: string[] = []
    expect(() => executeLanBridgeDeviceRevocation({
      revokeDevice: () => { throw new Error('write failed') },
      disconnectDevice: () => failedEvents.push('disconnect'),
      notifyStatusChanged: () => failedEvents.push('notify'),
    })).toThrow('write failed')
    expect(failedEvents).toEqual([])
  })
})
