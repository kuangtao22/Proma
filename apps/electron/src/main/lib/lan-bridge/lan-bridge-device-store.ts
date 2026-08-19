/**
 * LAN Bridge 已配对设备存储。
 *
 * 仅持久化可公开展示的设备元数据，不保存 PIN、Token 或签名密钥。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'

const DEVICES_FILENAME = 'lan-bridge-devices.json'
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000
const MAX_DEVICE_ID_LENGTH = 128
const MAX_DEVICE_NAME_LENGTH = 100
const MAX_DEVICE_IP_LENGTH = 128
const DEVICE_CREDENTIAL_HASH_LENGTH = 43
const DEFAULT_DEVICE_NAME = 'LAN 设备'

/** LAN Bridge 已配对设备的安全元数据。 */
export interface LanBridgeDevice {
  /** 设备唯一标识。 */
  id: string
  /** 用户可识别的设备名称。 */
  name: string
  /** 首次配对时间。 */
  createdAt: number
  /** 最近一次成功认证时间。 */
  lastSeenAt: number
  /** 最近一次成功认证 IP，仅用于审计展示，不参与身份校验。 */
  lastIp?: string
  /** Token 撤销版本。 */
  tokenVersion: number
  /** 撤销时间；未撤销时为空。 */
  revokedAt?: number
}

/** 仅在主进程设备仓库内部保存的可信设备记录。 */
interface StoredLanBridgeDevice extends LanBridgeDevice {
  /** 长期设备凭证的 SHA-256 base64url 哈希，不向 IPC 或 UI 暴露。 */
  credentialHash?: string
}

/** 注册或重新授权可信设备所需的输入。 */
export interface LanBridgeTrustedDeviceRegistration {
  /** 移动端本地生成并持久化的稳定设备标识。 */
  deviceId?: string
  /** 用户可识别的设备名称。 */
  name: string
  /** 高熵长期凭证的 SHA-256 base64url 哈希。 */
  credentialHash: string
  /** 首次授权时的来源 IP，仅用于审计。 */
  ip: string
}

/** 设备存储的文件与 ID 依赖，便于隔离测试。 */
export interface LanBridgeDeviceStoreDependencies {
  /** 使用安全 JSON API 读取设备文件。 */
  readJson: (filePath: string) => unknown
  /** 使用原子 JSON API 写入设备文件。 */
  writeJson: (filePath: string, data: object) => void
  /** 生成设备唯一标识。 */
  uuid: () => string
}

/**
 * 创建生产设备存储依赖，显式保持与 safe-file 原子 API 的接线。
 *
 * @returns 生产环境使用的安全文件与 ID 依赖
 */
export function createLanBridgeDeviceStoreDependencies(): LanBridgeDeviceStoreDependencies {
  return {
    readJson: readJsonFileSafe,
    writeJson: writeJsonFileAtomic,
    uuid: randomUUID,
  }
}

/** 管理 `~/.proma/lan-bridge-devices.json` 的设备仓库。 */
export class LanBridgeDeviceStore {
  private readonly filePath: string
  private readonly dependencies: LanBridgeDeviceStoreDependencies
  private readonly devices = new Map<string, StoredLanBridgeDevice>()
  private readonly persistedLastSeenAt = new Map<string, number>()

  /**
   * 创建并加载设备仓库。
   *
   * @param configDir Proma 配置目录
   * @param dependencies 可替换的安全文件与 ID 依赖
   */
  constructor(
    configDir = getConfigDir(),
    dependencies: Partial<LanBridgeDeviceStoreDependencies> = {},
  ) {
    this.filePath = join(configDir, DEVICES_FILENAME)
    this.dependencies = { ...createLanBridgeDeviceStoreDependencies(), ...dependencies }
    this.load()
  }

  /**
   * 注册新设备并立即持久化。
   *
   * @param name 设备显示名
   * @param now 当前时间戳
   * @returns 新注册的设备记录
   */
  registerDevice(name: string, now = Date.now()): LanBridgeDevice {
    /** 新设备的唯一标识。 */
    const id = this.dependencies.uuid()
    if (!isValidDeviceId(id) || this.devices.has(id)) {
      throw new Error('设备 ID 无效或重复')
    }
    if (!isValidTimestamp(now)) throw new Error('设备注册时间无效')
    /** 新设备只包含允许持久化的安全字段。 */
    const device: LanBridgeDevice = {
      id,
      name: normalizeDeviceName(name),
      createdAt: now,
      lastSeenAt: now,
      tokenVersion: 1,
      revokedAt: undefined,
    }
    /** 原子写入前构造的下一设备快照。 */
    const nextDevices = [...this.devices.values(), device]
    this.persist(nextDevices)
    this.devices.set(device.id, device)
    this.persistedLastSeenAt.set(device.id, now)
    return { ...device }
  }

  /**
   * 注册或重新授权持有稳定设备 ID 的可信设备。
   *
   * @param registration 设备标识、显示名、凭证哈希和审计 IP
   * @param now 当前时间戳
   * @returns 不含凭证哈希的设备元数据
   */
  registerTrustedDevice(
    registration: LanBridgeTrustedDeviceRegistration,
    now = Date.now(),
  ): LanBridgeDevice {
    /** 客户端提供或服务端生成的稳定设备标识。 */
    const deviceId = registration.deviceId ?? this.dependencies.uuid()
    if (!isValidDeviceId(deviceId)) throw new Error('设备 ID 无效')
    if (!isValidTimestamp(now)) throw new Error('设备注册时间无效')
    if (!isValidCredentialHash(registration.credentialHash)) throw new Error('设备凭证哈希无效')
    if (!isValidDeviceIp(registration.ip)) throw new Error('设备 IP 无效')

    /** 同一浏览器重新扫码前的历史设备记录。 */
    const previous = this.devices.get(deviceId)
    if (previous?.tokenVersion === Number.MAX_SAFE_INTEGER) {
      throw new Error('Token 版本已达上限')
    }
    /** 原子提交前构造的新设备或重新授权记录。 */
    const nextDevice: StoredLanBridgeDevice = previous
      ? {
          ...previous,
          name: normalizeDeviceName(registration.name),
          lastSeenAt: now,
          lastIp: registration.ip,
          tokenVersion: previous.tokenVersion + 1,
          revokedAt: undefined,
          credentialHash: registration.credentialHash,
        }
      : {
          id: deviceId,
          name: normalizeDeviceName(registration.name),
          createdAt: now,
          lastSeenAt: now,
          lastIp: registration.ip,
          tokenVersion: 1,
          revokedAt: undefined,
          credentialHash: registration.credentialHash,
        }
    /** 包含可信设备变更的下一份完整持久化快照。 */
    const nextDevices = previous
      ? [...this.devices.values()].map(candidate => candidate.id === deviceId ? nextDevice : candidate)
      : [...this.devices.values(), nextDevice]
    this.persist(nextDevices)
    this.devices.set(deviceId, nextDevice)
    this.persistedLastSeenAt.set(deviceId, now)
    return toPublicDevice(nextDevice)
  }

  /**
   * 获取指定设备。
   *
   * @param deviceId 设备唯一标识
   * @returns 设备副本；不存在时返回 undefined
   */
  getDevice(deviceId: string): LanBridgeDevice | undefined {
    /** 仓库内保存的设备。 */
    const device = this.devices.get(deviceId)
    return device ? toPublicDevice(device) : undefined
  }

  /**
   * 读取长期设备凭证哈希，仅供认证服务执行常量时间校验。
   *
   * @param deviceId 待校验的设备标识
   * @returns 已持久化的凭证哈希；旧设备或不存在时为空
   */
  getCredentialHash(deviceId: string): string | undefined {
    return this.devices.get(deviceId)?.credentialHash
  }

  /**
   * 列出设备。
   *
   * @param includeRevoked 是否包含已撤销设备
   * @returns 设备副本列表
   */
  listDevices(includeRevoked = false): LanBridgeDevice[] {
    return [...this.devices.values()]
      .filter(device => includeRevoked || device.revokedAt === undefined)
      .map(toPublicDevice)
  }

  /**
   * 更新最近访问时间，并将磁盘写入节流到每设备每分钟一次。
   *
   * @param deviceId 设备唯一标识
   * @param now 当前时间戳
   * @returns 更新后的设备；不存在时返回 undefined
   */
  updateLastSeen(deviceId: string, now = Date.now(), ip?: string): LanBridgeDevice | undefined {
    /** 待更新的设备记录。 */
    const device = this.devices.get(deviceId)
    if (!device) return undefined
    if (!isValidTimestamp(now)) throw new Error('设备最近访问时间无效')
    if (ip !== undefined && !isValidDeviceIp(ip)) throw new Error('设备 IP 无效')

    device.lastSeenAt = now
    if (ip !== undefined) device.lastIp = ip
    /** 最近一次已持久化的访问时间。 */
    const lastPersistedAt = this.persistedLastSeenAt.get(deviceId) ?? device.createdAt
    if (now - lastPersistedAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
      this.persist()
      this.persistedLastSeenAt.set(deviceId, now)
    }
    return toPublicDevice(device)
  }

  /**
   * 撤销设备并递增 Token 版本。
   *
   * @param deviceId 设备唯一标识
   * @param now 当前时间戳
   * @returns 撤销后的设备；不存在时返回 undefined
   */
  revokeDevice(deviceId: string, now = Date.now()): LanBridgeDevice | undefined {
    /** 待撤销的设备记录。 */
    const device = this.devices.get(deviceId)
    if (!device) return undefined
    if (!isValidTimestamp(now)) throw new Error('设备撤销时间无效')
    if (device.revokedAt === undefined) {
      if (device.tokenVersion === Number.MAX_SAFE_INTEGER) {
        throw new Error('Token 版本已达上限')
      }
      /** 尚未提交到内存的撤销后设备。 */
      const revokedDevice: StoredLanBridgeDevice = {
        ...device,
        tokenVersion: device.tokenVersion + 1,
        revokedAt: now,
      }
      /** 原子写入前构造的下一设备快照。 */
      const nextDevices = [...this.devices.values()].map(candidate => (
        candidate.id === deviceId ? revokedDevice : candidate
      ))
      this.persist(nextDevices)
      this.devices.set(deviceId, revokedDevice)
      return toPublicDevice(revokedDevice)
    }
    return toPublicDevice(device)
  }

  /** 从安全 JSON 文件加载合法设备记录。 */
  private load(): void {
    /** 安全文件 API 返回的未知内容。 */
    const stored = this.dependencies.readJson(this.filePath)
    if (!Array.isArray(stored)) return

    for (const candidate of stored) {
      if (!isLanBridgeDevice(candidate)) continue
      /** 投影到固定安全字段后的设备记录，避免载入凭据或未知字段。 */
      const device: StoredLanBridgeDevice = {
        id: candidate.id,
        name: candidate.name,
        createdAt: candidate.createdAt,
        lastSeenAt: candidate.lastSeenAt,
        lastIp: candidate.lastIp,
        tokenVersion: candidate.tokenVersion,
        revokedAt: candidate.revokedAt,
        credentialHash: candidate.credentialHash,
      }
      this.devices.set(device.id, device)
      this.persistedLastSeenAt.set(device.id, device.lastSeenAt)
    }
  }

  /** 使用原子 JSON API 持久化当前设备列表。 */
  private persist(devices: StoredLanBridgeDevice[] = [...this.devices.values()]): void {
    this.dependencies.writeJson(this.filePath, devices)
  }
}

/** 判断未知值是否为完整且不含凭据的设备记录。 */
function isLanBridgeDevice(value: unknown): value is StoredLanBridgeDevice {
  if (!value || typeof value !== 'object') return false
  /** 需要逐字段验证的候选记录。 */
  const candidate = value as Record<string, unknown>
  return isValidDeviceId(candidate.id)
    && isValidStoredDeviceName(candidate.name)
    && isValidTimestamp(candidate.createdAt)
    && isValidTimestamp(candidate.lastSeenAt)
    && (candidate.lastIp === undefined || isValidDeviceIp(candidate.lastIp))
    && Number.isSafeInteger(candidate.tokenVersion)
    && (candidate.tokenVersion as number) > 0
    && (candidate.revokedAt === undefined || isValidTimestamp(candidate.revokedAt))
    && (candidate.credentialHash === undefined || isValidCredentialHash(candidate.credentialHash))
}

/** 将内部设备记录投影为不含凭证哈希的公开元数据。 */
function toPublicDevice(device: StoredLanBridgeDevice): LanBridgeDevice {
  /** 只允许离开仓库边界的安全字段。 */
  const publicDevice: LanBridgeDevice = {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    tokenVersion: device.tokenVersion,
    revokedAt: device.revokedAt,
  }
  if (device.lastIp !== undefined) publicDevice.lastIp = device.lastIp
  return publicDevice
}

/** 判断设备 ID 是否为非空且长度受限的字符串。 */
function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_DEVICE_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value)
}

/** 判断审计 IP 是否为非空且长度受限的字符串。 */
function isValidDeviceIp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_DEVICE_IP_LENGTH
}

/** 判断凭证哈希是否为固定长度的 base64url SHA-256。 */
function isValidCredentialHash(value: unknown): value is string {
  return typeof value === 'string'
    && value.length === DEVICE_CREDENTIAL_HASH_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value)
}

/** 判断持久化设备名是否已经规范化且长度受限。 */
function isValidStoredDeviceName(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= MAX_DEVICE_NAME_LENGTH
}

/** 将用户输入名称规范化为稳定安全的显示名。 */
function normalizeDeviceName(value: string): string {
  /** 去除首尾空白后的设备名。 */
  const trimmed = value.trim()
  return (trimmed || DEFAULT_DEVICE_NAME).slice(0, MAX_DEVICE_NAME_LENGTH)
}

/** 判断时间戳是否为有限非负数。 */
function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
