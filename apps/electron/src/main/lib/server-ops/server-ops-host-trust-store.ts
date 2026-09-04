import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerOpsHost, ServerOpsHostKey } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'

/** 已确认 endpoint 的 Host Key 记录。 */
interface TrustedHostKey extends ServerOpsHostKey {
  endpoint: string
  trustedAt: number
}

/** Host Key 文件的版本化根结构。 */
interface TrustedHostKeyFile {
  version: 1
  hosts: TrustedHostKey[]
}

/** Host Key 校验的三种安全结果。 */
export type ServerOpsHostTrustResult =
  | { status: 'unknown'; observed: ServerOpsHostKey }
  | { status: 'trusted'; trusted: ServerOpsHostKey }
  | { status: 'changed'; trusted: ServerOpsHostKey; observed: ServerOpsHostKey }

/** Host Key Store 的可替换时间依赖。 */
export interface ServerOpsHostTrustStoreDependencies {
  now: () => number
}

/** 将 endpoint 规范化为与显示名、标签、用户名无关的身份。 */
function createEndpoint(host: Pick<ServerOpsHost, 'address' | 'port'>): string {
  return `${host.address.toLowerCase()}:${host.port}`
}

/** 校验 Host Key 文件只含公开且有界的字段。 */
function isTrustedHostKeyFile(value: unknown): value is TrustedHostKeyFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  /** 待校验的版本化根对象。 */
  const root = value as Record<string, unknown>
  if (root.version !== 1 || !Array.isArray(root.hosts)) return false
  return root.hosts.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    /** 待校验的单条信任记录。 */
    const record = item as Record<string, unknown>
    return typeof record.endpoint === 'string'
      && typeof record.algorithm === 'string'
      && typeof record.fingerprint === 'string'
      && typeof record.trustedAt === 'number'
      && record.fingerprint.startsWith('SHA256:')
      && Object.keys(record).every((key) => ['endpoint', 'algorithm', 'fingerprint', 'trustedAt'].includes(key))
  })
}

/** 原子持久化并精确匹配 SSH Host Key。 */
export class ServerOpsHostTrustStore {
  /** Host Key 文件的固定路径。 */
  private readonly filePath: string
  /** 可替换的时间依赖。 */
  private readonly dependencies: ServerOpsHostTrustStoreDependencies
  /** 当前 endpoint 到固定 Host Key 的快照。 */
  private hosts: TrustedHostKey[]

  constructor(configDir = getConfigDir(), dependencies: Partial<ServerOpsHostTrustStoreDependencies> = {}) {
    /** 运维模块固定数据目录。 */
    const directoryPath = join(configDir, 'server-ops')
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = join(directoryPath, 'known-hosts.json')
    this.dependencies = { now: Date.now, ...dependencies }
    this.hosts = readJsonFileSafe(this.filePath, { validate: isTrustedHostKeyFile })?.hosts ?? []
  }

  /** 比较当前 endpoint 已固定值与本次观测值。 */
  check(host: Pick<ServerOpsHost, 'address' | 'port'>, observed: ServerOpsHostKey): ServerOpsHostTrustResult {
    /** 当前 endpoint 已固定的 Host Key。 */
    const trusted = this.hosts.find((item) => item.endpoint === createEndpoint(host))
    if (!trusted) return { status: 'unknown', observed: { ...observed } }
    /** 去除持久化元数据后的公开 Host Key。 */
    const publicTrusted: ServerOpsHostKey = { algorithm: trusted.algorithm, fingerprint: trusted.fingerprint }
    if (trusted.algorithm === observed.algorithm && trusted.fingerprint === observed.fingerprint) {
      return { status: 'trusted', trusted: publicTrusted }
    }
    return { status: 'changed', trusted: publicTrusted, observed: { ...observed } }
  }

  /** 首次确认或显式替换 endpoint 的固定 Host Key。 */
  trust(host: Pick<ServerOpsHost, 'address' | 'port'>, key: ServerOpsHostKey): void {
    /** 当前 endpoint 的稳定身份。 */
    const endpoint = createEndpoint(host)
    /** 待提交的新固定记录。 */
    const record: TrustedHostKey = { endpoint, ...key, trustedAt: this.dependencies.now() }
    /** 替换当前 endpoint 后的完整信任快照。 */
    const next = this.hosts.some((item) => item.endpoint === endpoint)
      ? this.hosts.map((item) => item.endpoint === endpoint ? record : item)
      : [...this.hosts, record]
    writeJsonFileAtomic(this.filePath, { version: 1, hosts: next })
    this.hosts = next
  }

  /** 返回 endpoint 当前已固定的公开 Host Key。 */
  get(host: Pick<ServerOpsHost, 'address' | 'port'>): ServerOpsHostKey | undefined {
    /** 当前 endpoint 的信任记录。 */
    const trusted = this.hosts.find((item) => item.endpoint === createEndpoint(host))
    return trusted ? { algorithm: trusted.algorithm, fingerprint: trusted.fingerprint } : undefined
  }
}
