import { describe, expect, test } from 'bun:test'
import * as auth from './lan-bridge-auth'

type PairingResult = 'valid' | 'invalid' | 'rate_limited'

describe('LAN Bridge PIN 配对限速', () => {
  test('同一 IP 连续失败后拒绝继续尝试，并在窗口结束后恢复', () => {
    const verifyPairingPin = (auth as unknown as {
      verifyPairingPin?: (pin: string, ip: string, now?: number) => PairingResult
    }).verifyPairingPin

    expect(typeof verifyPairingPin).toBe('function')

    auth.initAuth()
    const startedAt = 1_000
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(verifyPairingPin?.('wrong-pin', '192.168.1.9', startedAt + attempt)).toBe('invalid')
    }
    expect(verifyPairingPin?.('wrong-pin', '192.168.1.9', startedAt + 5)).toBe('rate_limited')
    expect(verifyPairingPin?.('wrong-pin', '192.168.1.10', startedAt + 5)).toBe('invalid')
    expect(verifyPairingPin?.('wrong-pin', '192.168.1.9', startedAt + 60_001)).toBe('invalid')
  })
})
