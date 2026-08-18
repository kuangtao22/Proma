import { describe, expect, test } from 'bun:test'
import {
  isLanBridgeWebSocketClientIp,
  isRfc1918Ipv4,
  selectRfc1918Ipv4,
} from './private-ipv4'

describe('LAN Bridge RFC1918 IPv4 准入', () => {
  test('Given RFC1918 三个网段边界 When 校验地址 Then 仅严格私网 IPv4 通过', () => {
    /** 三个 RFC1918 网段的有效边界地址。 */
    const allowed = [
      '10.0.0.0', '10.255.255.255',
      '172.16.0.0', '172.31.255.255',
      '192.168.0.0', '192.168.255.255',
    ]
    /** 公网、链路本地、回环、未指定、越界和 IPv6 地址。 */
    const rejected = [
      '8.8.8.8', '172.15.255.255', '172.32.0.0', '169.254.1.2',
      '127.0.0.1', '0.0.0.0', '192.168.1.256', '::1', 'fd00::1',
    ]

    for (const address of allowed) expect(isRfc1918Ipv4(address)).toBe(true)
    for (const address of rejected) expect(isRfc1918Ipv4(address)).toBe(false)
  })

  test('Given 网卡同时有公网和私网地址 When 选择 Bridge 地址 Then 不回退公网 IPv4', () => {
    expect(selectRfc1918Ipv4(['8.8.8.8', '169.254.1.2', '10.1.2.3'])).toBe('10.1.2.3')
    expect(selectRfc1918Ipv4(['8.8.8.8', '169.254.1.2', '127.0.0.1'])).toBeUndefined()
  })

  test('Given 本机 PIN 与开发默认 host When 校验 WebSocket 来源 Then 接受明确回环地址', () => {
    /** 本机连接可能由 IPv4、IPv6 或 IPv4-mapped IPv6 表示。 */
    const localAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

    for (const address of localAddresses) {
      expect(isLanBridgeWebSocketClientIp(address)).toBe(true)
    }
  })

  test('Given 局域网与第三方地址 When 校验 WebSocket 来源 Then 仅接受 RFC1918 并拒绝其他来源', () => {
    /** 合法局域网来源，包括 Node 可能返回的 IPv4-mapped 形式。 */
    const allowed = ['192.168.1.8', '10.0.0.2', '172.20.1.3', '::ffff:192.168.1.8']
    /** 第三方公网、APIPA、非默认回环和非回环 IPv6 均不可接入。 */
    const rejected = ['8.8.8.8', '169.254.1.2', '127.0.0.2', 'fd00::1', '2001:db8::1']

    for (const address of allowed) expect(isLanBridgeWebSocketClientIp(address)).toBe(true)
    for (const address of rejected) expect(isLanBridgeWebSocketClientIp(address)).toBe(false)
  })
})
