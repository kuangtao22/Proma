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
  /** Token 撤销版本。 */
  tokenVersion: number
  /** 撤销时间；未撤销时为空。 */
  revokedAt?: number
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

const DEFAULT_DEPENDENCIES: LanBridgeDeviceStoreDependencies = {
  readJson: filePath => readJsonFileSafe<unknown>(filePath),
  writeJson: writeJsonFileAtomic,
  uuid: randomUUID,
}

/** 管理 `~/.proma/lan-bridge-devices.json` 的设备仓库。 */
export class LanBridgeDeviceStore {
  private readonly filePath: string
  private readonly dependencies: LanBridgeDeviceStoreDependencies
  private readonly devices = new Map<string, LanBridgeDevice>()
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
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies }
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
    /** 新设备只包含允许持久化的安全字段。 */
    const device: LanBridgeDevice = {
      id: this.dependencies.uuid(),
      name,
      createdAt: now,
      lastSeenAt: now,
      tokenVersion: 1,
      revokedAt: undefined,
    }
    this.devices.set(device.id, device)
    this.persistedLastSeenAt.set(device.id, now)
    this.persist()
    return { ...device }
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
    return device ? { ...device } : undefined
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
      .map(device => ({ ...device }))
  }

  /**
   * 更新最近访问时间，并将磁盘写入节流到每设备每分钟一次。
   *
   * @param deviceId 设备唯一标识
   * @param now 当前时间戳
   * @returns 更新后的设备；不存在时返回 undefined
   */
  updateLastSeen(deviceId: string, now = Date.now()): LanBridgeDevice | undefined {
    /** 待更新的设备记录。 */
    const device = this.devices.get(deviceId)
    if (!device) return undefined

    device.lastSeenAt = now
    /** 最近一次已持久化的访问时间。 */
    const lastPersistedAt = this.persistedLastSeenAt.get(deviceId) ?? device.createdAt
    if (now - lastPersistedAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
      this.persistedLastSeenAt.set(deviceId, now)
      this.persist()
    }
    return { ...device }
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
    if (device.revokedAt === undefined) {
      device.tokenVersion++
      device.revokedAt = now
      this.persist()
    }
    return { ...device }
  }

  /** 从安全 JSON 文件加载合法设备记录。 */
  private load(): void {
    /** 安全文件 API 返回的未知内容。 */
    const stored = this.dependencies.readJson(this.filePath)
    if (!Array.isArray(stored)) return

    for (const candidate of stored) {
      if (!isLanBridgeDevice(candidate)) continue
      /** 投影到固定安全字段后的设备记录，避免载入凭据或未知字段。 */
      const device: LanBridgeDevice = {
        id: candidate.id,
        name: candidate.name,
        createdAt: candidate.createdAt,
        lastSeenAt: candidate.lastSeenAt,
        tokenVersion: candidate.tokenVersion,
        revokedAt: candidate.revokedAt,
      }
      this.devices.set(device.id, device)
      this.persistedLastSeenAt.set(device.id, device.lastSeenAt)
    }
  }

  /** 使用原子 JSON API 持久化当前设备列表。 */
  private persist(): void {
    this.dependencies.writeJson(this.filePath, [...this.devices.values()])
  }
}

/** 判断未知值是否为完整且不含凭据的设备记录。 */
function isLanBridgeDevice(value: unknown): value is LanBridgeDevice {
  if (!value || typeof value !== 'object') return false
  /** 需要逐字段验证的候选记录。 */
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.createdAt === 'number'
    && typeof candidate.lastSeenAt === 'number'
    && typeof candidate.tokenVersion === 'number'
    && (candidate.revokedAt === undefined || typeof candidate.revokedAt === 'number')
}
