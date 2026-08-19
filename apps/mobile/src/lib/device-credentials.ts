import type { TrustedDeviceAuthentication } from './pairing-startup-coordinator'

const DEVICE_ID_STORAGE_KEY = 'proma_mobile_device_id'
const ACCESS_TOKEN_STORAGE_KEY = 'proma_mobile_token'
const DEVICE_CREDENTIAL_STORAGE_KEY = 'proma_mobile_device_credential'

/** 浏览器凭证存储所需的最小同步接口。 */
export interface DeviceCredentialStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/** 移动端当前保存的可信设备认证状态。 */
export interface StoredTrustedDeviceAuthentication {
  token: string | null
  deviceId: string | null
  deviceCredential: string | null
}

/** 局域网 HTTP 环境可用的最小 Web Crypto 随机源。 */
export interface DeviceIdCryptoSource {
  getRandomValues: (bytes: Uint8Array) => Uint8Array
}

/** 使用 getRandomValues 生成 UUID v4 设备标识。 */
export function createRandomDeviceId(cryptoSource: DeviceIdCryptoSource = crypto): string {
  /** UUID v4 使用的 16 个随机字节。 */
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16))
  if (bytes.length !== 16) throw new Error('设备 ID 随机源返回长度无效')
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  /** 每个随机字节对应的两位十六进制文本。 */
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}

/** 获取或创建稳定设备 ID。 */
export function getOrCreateDeviceId(
  storage: DeviceCredentialStorage,
  generateId: () => string,
): string {
  /** 已在当前浏览器安装中持久化的设备标识。 */
  const existingDeviceId = storage.getItem(DEVICE_ID_STORAGE_KEY)
  if (existingDeviceId) return existingDeviceId
  /** 首次打开时生成的随机稳定设备标识。 */
  const generatedDeviceId = generateId()
  if (!generatedDeviceId) throw new Error('无法生成移动端设备 ID')
  storage.setItem(DEVICE_ID_STORAGE_KEY, generatedDeviceId)
  return generatedDeviceId
}

/** 保存可信设备认证材料。 */
export function saveTrustedDeviceAuthentication(
  storage: DeviceCredentialStorage,
  authentication: TrustedDeviceAuthentication,
): void {
  storage.setItem(DEVICE_ID_STORAGE_KEY, authentication.deviceId)
  storage.setItem(ACCESS_TOKEN_STORAGE_KEY, authentication.token)
  storage.setItem(DEVICE_CREDENTIAL_STORAGE_KEY, authentication.deviceCredential)
}

/** 读取可信设备认证材料。 */
export function readTrustedDeviceAuthentication(
  storage: DeviceCredentialStorage,
): StoredTrustedDeviceAuthentication {
  return {
    token: storage.getItem(ACCESS_TOKEN_STORAGE_KEY),
    deviceId: storage.getItem(DEVICE_ID_STORAGE_KEY),
    deviceCredential: storage.getItem(DEVICE_CREDENTIAL_STORAGE_KEY),
  }
}

/** 清除授权材料并保留稳定设备 ID。 */
export function clearTrustedDeviceAuthentication(storage: DeviceCredentialStorage): void {
  storage.removeItem(ACCESS_TOKEN_STORAGE_KEY)
  storage.removeItem(DEVICE_CREDENTIAL_STORAGE_KEY)
}
