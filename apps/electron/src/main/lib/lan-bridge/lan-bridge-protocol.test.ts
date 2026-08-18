import { describe, expect, test } from 'bun:test'
import {
  LAN_BRIDGE_CAPABILITIES,
  LAN_BRIDGE_PROTOCOL_VERSION,
  type LanBridgeConnectedPayload,
} from '@proma/shared'

describe('LAN Bridge 协议协商', () => {
  test('连接确认包含稳定协议版本与能力集合', () => {
    /** 模拟服务端在 WebSocket 建连后发送的协议协商载荷。 */
    const payload: LanBridgeConnectedPayload = {
      message: 'Proma LAN Bridge',
      protocolVersion: LAN_BRIDGE_PROTOCOL_VERSION,
      serverVersion: '0.17.42',
      capabilities: [...LAN_BRIDGE_CAPABILITIES],
    }

    expect(payload.protocolVersion).toBe(2)
    expect(payload.capabilities).toContain('pairing-ticket')
    expect(payload.capabilities).toContain('device-revocation')
  })

  test('能力声明保持为无重复的稳定只读集合', () => {
    /** 以只读视图校验客户端可依赖的能力边界。 */
    const capabilities: readonly string[] = LAN_BRIDGE_CAPABILITIES

    expect(capabilities).toEqual([
      'pin-pairing',
      'pairing-ticket',
      'device-revocation',
      'streaming',
      'connection-recovery',
    ])
    expect(new Set(capabilities).size).toBe(capabilities.length)
  })
})
