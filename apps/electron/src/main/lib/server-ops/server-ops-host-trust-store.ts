import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerOpsHost, ServerOpsHostKey } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readAtomicFileState, readJsonFileStrict, writeJsonFileAtomicSecure } from '../safe-file'
import { createServerOpsConfigTransaction, resolveServerOpsConfigFilePath } from './server-ops-config-transaction'
import type { ServerOpsConfigTransaction } from './server-ops-config-transaction'

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
  /** 单元测试可注入同步事务；生产默认使用原生跨进程锁。 */
  transaction: ServerOpsConfigTransaction
}

/** 将 endpoint 规范化为与显示名、标签、用户名无关的身份。 */
export function createServerOpsEndpoint(host: Pick<ServerOpsHost, 'address' | 'port'>): string {
  return `${host.address.toLowerCase()}:${host.port}`
}

/** 校验 Host Key 文件只含公开且有界的字段。 */
function isTrustedHostKeyFile(value: unknown): value is TrustedHostKeyFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  /** 待校验的版本化根对象。 */
  const root = value as Record<string, unknown>
  if (root.version !== 1 || !Array.isArray(root.hosts) || root.hosts.length > 10_000
    || !Object.keys(root).every((key) => key === 'version' || key === 'hosts')) return false
  /** 相同 endpoint 不能出现多个互相矛盾的身份。 */
  const endpoints = new Set<string>()
  return root.hosts.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    /** 待校验的单条信任记录。 */
    const record = item as Record<string, unknown>
    if (typeof record.endpoint !== 'string' || endpoints.has(record.endpoint)) return false
    endpoints.add(record.endpoint)
    return record.endpoint.length > 0 && record.endpoint.length <= 512
      && isServerOpsTrustedKey(record)
      && typeof record.trustedAt === 'number' && Number.isSafeInteger(record.trustedAt) && record.trustedAt >= 0
      && Object.keys(record).every((key) => ['endpoint', 'algorithm', 'fingerprint', 'trustedAt'].includes(key))
  })
}

/** 校验 SSH 公开指纹的有限算法和摘要字符集，不接受控制字符。 */
function isServerOpsTrustedKey(key: Record<string, unknown>): boolean {
  return typeof key.algorithm === 'string' && /^[A-Za-z0-9@._+-]{1,128}$/.test(key.algorithm)
    && typeof key.fingerprint === 'string' && /^SHA256:[A-Za-z0-9+/=]{1,128}$/.test(key.fingerprint)
}

/** 按算法与完整摘要判断两个可选身份是否相等。 */
export function sameServerOpsHostKey(first: ServerOpsHostKey | undefined, second: ServerOpsHostKey | undefined): boolean {
  return first?.algorithm === second?.algorithm && first?.fingerprint === second?.fingerprint
}

/** 原子持久化并精确匹配 SSH Host Key。 */
export class ServerOpsHostTrustStore {
  /** Host Key 文件的固定路径。 */
  private readonly filePath: string
  /** 可替换的时间依赖。 */
  private readonly dependencies: ServerOpsHostTrustStoreDependencies
  /** 与主机、凭据和审计共享的短期同步配置锁。 */
  private readonly transaction: ServerOpsConfigTransaction

  constructor(configDir = getConfigDir(), dependencies: Partial<ServerOpsHostTrustStoreDependencies> = {}) {
    /** 运维模块固定数据目录。 */
    const directoryPath = join(configDir, 'server-ops')
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = resolveServerOpsConfigFilePath(directoryPath, 'known-hosts.json')
    this.transaction = dependencies.transaction ?? createServerOpsConfigTransaction(directoryPath)
    this.dependencies = { now: Date.now, transaction: this.transaction, ...dependencies }
  }

  /** 比较当前 endpoint 已固定值与本次观测值。 */
  check(host: Pick<ServerOpsHost, 'address' | 'port'>, observed: ServerOpsHostKey): ServerOpsHostTrustResult {
    /** 当前 endpoint 已固定的 Host Key。 */
    const trusted = this.read().find((item) => item.endpoint === createServerOpsEndpoint(host))
    if (!trusted) return { status: 'unknown', observed: { ...observed } }
    /** 去除持久化元数据后的公开 Host Key。 */
    const publicTrusted: ServerOpsHostKey = { algorithm: trusted.algorithm, fingerprint: trusted.fingerprint }
    if (trusted.algorithm === observed.algorithm && trusted.fingerprint === observed.fingerprint) {
      return { status: 'trusted', trusted: publicTrusted }
    }
    return { status: 'changed', trusted: publicTrusted, observed: { ...observed } }
  }

  /** 首次确认只能固定未知身份，相同指纹重试幂等；变化必须走独立条件替换。 */
  trust(host: Pick<ServerOpsHost, 'address' | 'port'>, key: ServerOpsHostKey): void {
    this.commit(host, undefined, key, true)
  }

  /** 根据已展示的旧身份替换指定 endpoint，冲突时保留当前文件。 */
  replace(host: Pick<ServerOpsHost, 'address' | 'port'>, expected: ServerOpsHostKey, key: ServerOpsHostKey): void {
    this.commit(host, expected, key)
  }

  /** 仅撤销仍与审批快照一致的 endpoint，不影响其它服务器身份。 */
  revoke(host: Pick<ServerOpsHost, 'address' | 'port'>, expected: ServerOpsHostKey): void {
    this.commit(host, expected)
  }

  /** 返回 endpoint 当前已固定的公开 Host Key。 */
  get(host: Pick<ServerOpsHost, 'address' | 'port'>): ServerOpsHostKey | undefined {
    /** 当前 endpoint 的信任记录。 */
    const trusted = this.read().find((item) => item.endpoint === createServerOpsEndpoint(host))
    return trusted ? { algorithm: trusted.algorithm, fingerprint: trusted.fingerprint } : undefined
  }

  /** 每次从权威文件严格读取，已有损坏文件绝不降级为首次连接。 */
  private read(): TrustedHostKey[] {
    try {
      return readJsonFileStrict(this.filePath, { validate: isTrustedHostKeyFile, description: '服务器信任记录' })?.hosts ?? []
    } catch {
      throw new Error('SERVER_OPS_TRUST_READ_FAILED')
    }
  }

  /** fresh 读取并检查旧指纹后执行一次原子提交；互斥边界由配置事务层接入。 */
  private commit(host: Pick<ServerOpsHost, 'address' | 'port'>, expected: ServerOpsHostKey | undefined,
    key?: ServerOpsHostKey, allowSame = false): void {
    this.transaction(() => this.commitLocked(host, expected, key, allowSame))
  }

  /** 锁内只进行本地 fresh-read、条件检查和 safe-file 提交，不等待网络或审批。 */
  private commitLocked(host: Pick<ServerOpsHost, 'address' | 'port'>, expected: ServerOpsHostKey | undefined,
    key?: ServerOpsHostKey, allowSame = false): void {
    if (key && !isServerOpsTrustedKey({ ...key })) throw new Error('SERVER_OPS_TRUST_KEY_INVALID')
    /** 固化读前文件身份，safe-file 继续检测非协作的文件替换。 */
    const before = readAtomicFileState(this.filePath)
    const hosts = this.read()
    const endpoint = createServerOpsEndpoint(host)
    const current = hosts.find((item) => item.endpoint === endpoint)
    if (allowSame && sameServerOpsHostKey(current, key)) return
    if (!sameServerOpsHostKey(current, expected)) throw new Error('SERVER_OPS_TRUST_CONFLICT')
    /** 只变更当前 endpoint，保留锁内 fresh 读取的其它记录。 */
    const next = hosts.filter((item) => item.endpoint !== endpoint)
    if (key) next.push({ endpoint, ...key, trustedAt: this.dependencies.now() })
    const document: TrustedHostKeyFile = { version: 1, hosts: next }
    if (!isTrustedHostKeyFile(document)) throw new Error('SERVER_OPS_TRUST_KEY_INVALID')
    writeJsonFileAtomicSecure(this.filePath, document, { expectedDestination: before ? { kind: 'state', state: before } : { kind: 'missing' } })
  }
}
