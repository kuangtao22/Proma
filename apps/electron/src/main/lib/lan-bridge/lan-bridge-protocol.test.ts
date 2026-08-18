import { describe, expect, test } from 'bun:test'
import {
  LAN_BRIDGE_CAPABILITIES,
  LAN_BRIDGE_MAX_PROTOCOL_VERSION,
  LAN_BRIDGE_MIN_PROTOCOL_VERSION,
  LAN_BRIDGE_PROTOCOL_VERSION,
  LAN_BRIDGE_WS_CAPABILITIES,
  type LanBridgeConnectedPayload,
} from '@proma/shared'
import { createLanBridgeConnectedPayload } from './lan-bridge-handlers'
import electronPackage from '../../../../package.json'

describe('LAN Bridge 协议协商', () => {
  test('连接确认包含稳定协议版本与能力集合', () => {
    /** 模拟服务端在 WebSocket 建连后发送的协议协商载荷。 */
    const payload: LanBridgeConnectedPayload = {
      message: 'Proma LAN Bridge',
      protocolVersion: LAN_BRIDGE_PROTOCOL_VERSION,
      minProtocolVersion: LAN_BRIDGE_MIN_PROTOCOL_VERSION,
      maxProtocolVersion: LAN_BRIDGE_MAX_PROTOCOL_VERSION,
      serverVersion: '0.17.42',
      capabilities: [...LAN_BRIDGE_WS_CAPABILITIES],
    }

    expect(payload.protocolVersion).toBe(2)
    expect(payload.capabilities).toContain('pairing-ticket')
    expect(payload.capabilities).not.toContain('device-revocation')
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
    expect(LAN_BRIDGE_WS_CAPABILITIES).toEqual([
      'pin-pairing',
      'pairing-ticket',
      'streaming',
      'connection-recovery',
    ])
    expect(new Set(LAN_BRIDGE_WS_CAPABILITIES).size).toBe(LAN_BRIDGE_WS_CAPABILITIES.length)
  })

  test('Given WebSocket 建连 When 构造 connected push Then 保留旧消息并声明当前应用版本和能力', () => {
    expect(createLanBridgeConnectedPayload(electronPackage.version)).toEqual({
      message: 'Proma LAN Bridge',
      protocolVersion: LAN_BRIDGE_PROTOCOL_VERSION,
      minProtocolVersion: LAN_BRIDGE_MIN_PROTOCOL_VERSION,
      maxProtocolVersion: LAN_BRIDGE_MAX_PROTOCOL_VERSION,
      serverVersion: electronPackage.version,
      capabilities: [...LAN_BRIDGE_WS_CAPABILITIES],
    })
  })
})
