import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isServerOpsHostList,
  isServerOpsId,
  parseServerOpsHostInput,
} from '@proma/shared'
import type { ServerOpsHost, ServerOpsUpsertHostInput } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import type { ReadJsonFileSafeOptions } from '../safe-file'

/** 主机资产相对业务配置根的目录名。 */
const SERVER_OPS_DIRECTORY = 'server-ops'
/** 主机资产文件名。 */
const SERVER_OPS_HOSTS_FILENAME = 'hosts.json'

/** 主机 Store 可替换的安全文件、时间与 ID 依赖。 */
export interface ServerOpsHostStoreDependencies {
  /** 使用 safe-file 候选恢复规则读取 JSON。 */
  readJson: <T>(filePath: string, options: ReadJsonFileSafeOptions<T>) => T | null
  /** 使用 safe-file 原子写入完整主机列表。 */
  writeJson: (filePath: string, data: object) => void
  /** 生成新主机的稳定唯一 ID。 */
  uuid: () => string
  /** 生成创建和更新时间戳。 */
  now: () => number
}

/** 创建生产环境使用的主机 Store 依赖。 */
export function createServerOpsHostStoreDependencies(): ServerOpsHostStoreDependencies {
  return {
    readJson: readJsonFileSafe,
    writeJson: writeJsonFileAtomic,
    uuid: randomUUID,
    now: Date.now,
  }
}

/** 复制单条主机记录，阻断调用方修改内部标签数组。 */
function cloneHost(host: ServerOpsHost): ServerOpsHost {
  return { ...host, tags: [...host.tags] }
}

/** 旧版曾把私钥路径保存在公开主机记录中。 */
interface LegacyServerOpsHost extends Omit<ServerOpsHost, 'credentialRef'> {
  keyPath: string
}

/** 主机文件加载时允许的当前或旧版记录。 */
type ServerOpsStoredHost = ServerOpsHost | LegacyServerOpsHost

/** 兼容读取旧版 keyPath 字段，同时拒绝其它未知字段。 */
function isServerOpsStoredHostList(value: unknown): value is ServerOpsStoredHost[] {
  if (isServerOpsHostList(value)) return true
  if (!Array.isArray(value)) return false
  return value.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    /** 待检查的旧版记录。 */
    const record = item as Record<string, unknown>
    if (typeof record.keyPath !== 'string' || !record.keyPath.trim()) return false
    /** 去掉旧私钥路径后必须满足当前公开合同。 */
    const sanitized: Record<string, unknown> = { ...record }
    delete sanitized.keyPath
    return isServerOpsHostList([sanitized])
  })
}

/** 删除旧版公开私钥路径，保留其余主机资产。 */
function migrateStoredHost(host: ServerOpsStoredHost): ServerOpsHost {
  /** 当前或旧版记录的可枚举副本。 */
  const migrated = { ...host } as Record<string, unknown>
  delete migrated.keyPath
  return migrated as unknown as ServerOpsHost
}

/** 判断 Store 时间源是否返回可持久化时间戳。 */
function isValidTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/** 管理 `~/.proma/server-ops/hosts.json` 的全局服务器资产。 */
export class ServerOpsHostStore {
  /** 主机资产最终文件路径。 */
  private readonly filePath: string
  /** 可替换的安全文件、时间和 ID 边界。 */
  private readonly dependencies: ServerOpsHostStoreDependencies
  /** 仅在写盘成功后替换的内存主机快照。 */
  private hosts: ServerOpsHost[]

  /**
   * 创建并加载服务器资产 Store。
   *
   * @param configDir Proma 业务配置根
   * @param dependencies 测试可替换依赖
   */
  constructor(
    configDir = getConfigDir(),
    dependencies: Partial<ServerOpsHostStoreDependencies> = {},
  ) {
    /** 存放主机资产的固定子目录。 */
    const directoryPath = join(configDir, SERVER_OPS_DIRECTORY)
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = join(directoryPath, SERVER_OPS_HOSTS_FILENAME)
    this.dependencies = { ...createServerOpsHostStoreDependencies(), ...dependencies }
    /** 经 safe-file schema 校验和候选恢复后的当前或旧版主机列表。 */
    const loaded = this.dependencies.readJson(this.filePath, { validate: isServerOpsStoredHostList })
    this.hosts = loaded?.map(migrateStoredHost).map(cloneHost) ?? []
    if (loaded?.some((host) => 'keyPath' in host)) {
      // 连续两次原子提交让 safe-file 的主文件与备份都替换为已脱敏 schema。
      this.persist(this.hosts)
      this.persist(this.hosts)
    }
  }

  /** 返回当前主机资产的深层副本。 */
  list(): ServerOpsHost[] {
    return this.hosts.map(cloneHost)
  }

  /** 按稳定 ID 返回单条主机副本。 */
  get(hostId: string): ServerOpsHost | undefined {
    if (!isServerOpsId(hostId)) return undefined
    /** 当前 ID 对应的内部主机记录。 */
    const host = this.hosts.find((item) => item.id === hostId)
    return host ? cloneHost(host) : undefined
  }

  /**
   * 新增或更新主机资产，写盘成功后才提交内存状态。
   *
   * @param input Renderer 提交的不含凭据主机字段
   * @returns 已提交的主机副本
   */
  upsert(input: ServerOpsUpsertHostInput): ServerOpsHost {
    /** 输入携带的可选更新目标 ID。 */
    const hostId = input.id
    /** 交给共享边界严格解析的可编辑字段。 */
    const parsed = parseServerOpsHostInput({
      name: input.name,
      address: input.address,
      port: input.port,
      username: input.username,
      authMethod: input.authMethod,
      tags: input.tags,
    })
    /** 当前操作的权威时间。 */
    const now = this.dependencies.now()
    if (!isValidTimestamp(now)) throw new Error('SERVER_OPS_HOST_TIMESTAMP_INVALID')

    if (hostId !== undefined) {
      if (!isServerOpsId(hostId)) throw new Error('SERVER_OPS_HOST_ID_INVALID')
      /** 被编辑主机在当前快照中的位置。 */
      const index = this.hosts.findIndex((host) => host.id === hostId)
      if (index < 0) throw new Error('SERVER_OPS_HOST_NOT_FOUND')
      /** 经过索引存在性校验的当前主机。 */
      const existing = this.hosts[index]
      if (!existing) throw new Error('SERVER_OPS_HOST_NOT_FOUND')
      /** 保留创建时间并更新可编辑字段的新记录。 */
      const updated: ServerOpsHost = {
        ...parsed,
        id: hostId,
        ...(existing.authMethod === parsed.authMethod && existing.credentialRef ? { credentialRef: existing.credentialRef } : {}),
        createdAt: existing.createdAt,
        updatedAt: Math.max(now, existing.updatedAt),
      }
      /** 原子写入前构造的完整下一快照。 */
      const nextHosts = this.hosts.map((host, hostIndex) => hostIndex === index ? updated : host)
      this.persist(nextHosts)
      this.hosts = nextHosts
      return cloneHost(updated)
    }

    /** 为新主机生成的稳定 ID。 */
    const id = this.dependencies.uuid()
    if (!isServerOpsId(id) || this.hosts.some((host) => host.id === id)) {
      throw new Error('SERVER_OPS_HOST_ID_INVALID')
    }
    /** 待新增并写盘的主机记录。 */
    const created: ServerOpsHost = {
      ...parsed,
      id,
      createdAt: now,
      updatedAt: now,
    }
    /** 包含新主机的完整下一快照。 */
    const nextHosts = [...this.hosts, created]
    this.persist(nextHosts)
    this.hosts = nextHosts
    return cloneHost(created)
  }

  /**
   * 删除指定主机；目标不存在时幂等返回 false。
   *
   * @param hostId 待删除主机 ID
   * @returns 是否实际删除了主机
   */
  remove(hostId: string): boolean {
    if (!isServerOpsId(hostId)) throw new Error('SERVER_OPS_HOST_ID_INVALID')
    if (!this.hosts.some((host) => host.id === hostId)) return false
    /** 删除目标后的完整下一快照。 */
    const nextHosts = this.hosts.filter((host) => host.id !== hostId)
    this.persist(nextHosts)
    this.hosts = nextHosts
    return true
  }

  /** 将主机绑定到已安全保存的凭据引用，或清除旧引用。 */
  setCredentialRef(hostId: string, credentialRef?: string): ServerOpsHost {
    if (!isServerOpsId(hostId) || (credentialRef !== undefined && !isServerOpsId(credentialRef))) {
      throw new Error('SERVER_OPS_CREDENTIAL_REF_INVALID')
    }
    /** 待绑定凭据的主机索引。 */
    const index = this.hosts.findIndex((host) => host.id === hostId)
    if (index < 0) throw new Error('SERVER_OPS_HOST_NOT_FOUND')
    /** 经过存在性校验的当前主机。 */
    const existing = this.hosts[index]
    if (!existing) throw new Error('SERVER_OPS_HOST_NOT_FOUND')
    /** 绑定新引用后的公开主机记录。 */
    const updated: ServerOpsHost = {
      ...existing,
      ...(credentialRef === undefined ? {} : { credentialRef }),
      updatedAt: Math.max(this.dependencies.now(), existing.updatedAt),
    }
    if (credentialRef === undefined) delete updated.credentialRef
    /** 完整下一主机快照。 */
    const next = this.hosts.map((host, hostIndex) => hostIndex === index ? updated : host)
    this.persist(next)
    this.hosts = next
    return cloneHost(updated)
  }

  /** 使用 safe-file 原子边界持久化完整主机快照。 */
  private persist(hosts: readonly ServerOpsHost[]): void {
    this.dependencies.writeJson(this.filePath, hosts.map(cloneHost))
  }
}
