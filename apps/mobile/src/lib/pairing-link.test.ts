import { describe, expect, test } from 'bun:test'
import {
  consumePairingLink,
  getPairingFailureMessage,
  parsePairingLink,
  supportsPairingTicket,
} from './pairing-link'

describe('移动端一次性配对链接', () => {
  test('Given fragment 中包含票据 When 解析链接 Then 返回票据和不含 fragment 的清理地址', () => {
    expect(parsePairingLink('http://192.168.1.2:29888/#/pair?ticket=abc')).toEqual({
      ticket: 'abc',
      cleanUrl: 'http://192.168.1.2:29888/',
    })
  })

  test('Given 票据只出现在普通 query When 解析链接 Then 不读取该票据', () => {
    expect(parsePairingLink('http://192.168.1.2:29888/?ticket=leaked#/pair')).toBeNull()
  })

  test('Given fragment 无票据或票据为空 When 解析链接 Then 返回空结果', () => {
    expect(parsePairingLink('http://192.168.1.2:29888/#/pair')).toBeNull()
    expect(parsePairingLink('http://192.168.1.2:29888/#/pair?ticket=')).toBeNull()
  })

  test('Given fragment 票据编码损坏 When 解析链接 Then 拒绝不可逆的异常编码', () => {
    expect(parsePairingLink('http://192.168.1.2:29888/#/pair?ticket=%E0%A4%A')).toBeNull()
    expect(parsePairingLink('not-a-url#/pair?ticket=abc')).toBeNull()
  })

  test('Given 首次启动读取票据 When 消费链接 Then 立即替换历史且第二次无法再读', () => {
    /** 模拟浏览器当前地址，replace 后立即反映为清理地址。 */
    let currentHref = 'http://192.168.1.2:29888/#/pair?ticket=abc%2B123'
    /** 记录 history.replaceState 的清理目标。 */
    const replacements: string[] = []
    /** 测试用最小地址与历史对象。 */
    const browser = {
      getHref: () => currentHref,
      replaceUrl: (cleanUrl: string) => {
        replacements.push(cleanUrl)
        currentHref = cleanUrl
      },
    }

    expect(consumePairingLink(browser)).toEqual({
      ticket: 'abc+123',
      cleanUrl: 'http://192.168.1.2:29888/',
    })
    expect(replacements).toEqual(['http://192.168.1.2:29888/'])
    expect(consumePairingLink(browser)).toBeNull()
    expect(replacements).toHaveLength(1)
  })

  test('Given 服务端 connected 能力 When 判断票据兼容性 Then 仅明确声明能力时启用', () => {
    expect(supportsPairingTicket({ capabilities: ['pin-pairing', 'pairing-ticket'] })).toBe(true)
    expect(supportsPairingTicket({ capabilities: ['pin-pairing'] })).toBe(false)
    expect(supportsPairingTicket({ capabilities: 'pairing-ticket' })).toBe(false)
    expect(supportsPairingTicket(null)).toBe(false)
  })

  test('Given 扫码配对失败码 When 生成回退提示 Then 区分过期、已消费、限速和连接失败', () => {
    expect(getPairingFailureMessage({ code: 'PAIRING_TICKET_EXPIRED' })).toBe('二维码已过期，请在电脑端刷新后重试')
    expect(getPairingFailureMessage({ code: 'PAIRING_TICKET_INVALID' })).toBe('二维码已使用或无效，请在电脑端刷新后重试')
    expect(getPairingFailureMessage({ code: 'RATE_LIMITED' })).toBe('尝试次数过多，请稍后再试或使用 PIN 码')
    expect(getPairingFailureMessage({ code: 'CONNECTION_LOST' })).toBe('连接中断，请检查网络后使用 PIN 码重试')
    expect(getPairingFailureMessage(new Error('secret ticket value'))).toBe('扫码配对失败，请使用 PIN 码连接')
  })
})
