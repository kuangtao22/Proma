import { describe, expect, test } from 'bun:test'
import {
  clearTrustedDeviceAuthentication,
  createRandomDeviceId,
  getOrCreateDeviceId,
  readTrustedDeviceAuthentication,
  saveTrustedDeviceAuthentication,
} from './device-credentials'

/** 测试使用的最小同步键值存储。 */
class MemoryStorage {
  /** 当前测试存储的键值。 */
  private readonly values = new Map<string, string>()

  /** 读取指定键。 */
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  /** 保存指定键值。 */
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  /** 删除指定键。 */
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('移动端可信设备凭证存储', () => {
  test('Given 局域网 HTTP 环境没有 randomUUID When 生成设备 ID Then 仅依赖 getRandomValues', () => {
    /** 固定返回 0 到 15 的随机源，模拟 HTTP 仍可用的 Web Crypto 子集。 */
    const cryptoSource = {
      getRandomValues: (bytes: Uint8Array): Uint8Array => {
        bytes.set(Array.from({ length: 16 }, (_value, index) => index))
        return bytes
      },
    }

    expect(createRandomDeviceId(cryptoSource)).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
  })

  test('Given 首次打开 When 获取设备 ID Then 生成一次并在后续刷新中稳定复用', () => {
    /** 当前用例的隔离存储。 */
    const storage = new MemoryStorage()
    /** 当前用例累计的设备 ID 生成次数。 */
    let generationCount = 0
    /** 固定返回稳定测试 ID 的生成器。 */
    const generateId = (): string => {
      generationCount += 1
      return 'mobile-device-1'
    }

    expect(getOrCreateDeviceId(storage, generateId)).toBe('mobile-device-1')
    expect(getOrCreateDeviceId(storage, generateId)).toBe('mobile-device-1')
    expect(generationCount).toBe(1)
  })

  test('Given 扫码成功 When 保存认证材料 Then 可完整恢复且清除授权时保留设备 ID', () => {
    /** 当前用例的隔离存储。 */
    const storage = new MemoryStorage()
    getOrCreateDeviceId(storage, () => 'mobile-device-1')

    saveTrustedDeviceAuthentication(storage, {
      token: 'access-token',
      deviceId: 'mobile-device-1',
      deviceCredential: 'device-credential',
    })

    expect(readTrustedDeviceAuthentication(storage)).toEqual({
      token: 'access-token',
      deviceId: 'mobile-device-1',
      deviceCredential: 'device-credential',
    })
    clearTrustedDeviceAuthentication(storage)
    expect(readTrustedDeviceAuthentication(storage)).toEqual({
      token: null,
      deviceId: 'mobile-device-1',
      deviceCredential: null,
    })
  })
})
