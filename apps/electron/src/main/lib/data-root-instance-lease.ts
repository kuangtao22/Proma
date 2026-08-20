import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createConnection, createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** loopback challenge 服务的固定主机。 */
const LOOPBACK_HOST = '127.0.0.1' as const
/** 单次本机 challenge 的短超时，活跃实例通常在一个事件循环内响应。 */
const DEFAULT_PROBE_TIMEOUT_MS = 200
/** 防止损坏或恶意 intent 链无限遍历。 */
const MAX_INTENT_CHAIN_LENGTH = 256

/** 可跨进程验证的实例生命周期端点。 */
export interface DataRootLivenessEndpoint {
  /** 固定 IPv4 loopback，禁止记录外部地址。 */
  host: typeof LOOPBACK_HOST
  /** OS 随机分配的本机 TCP 端口。 */
  port: number
}

/** 当前实例持有的 challenge server。 */
export interface DataRootLivenessServer {
  /** 写入 lease/intent 的可验证端点。 */
  endpoint: DataRootLivenessEndpoint
  /** graceful quit 或测试崩溃模拟时停止接受 challenge。 */
  close(): void
}

/** normal 业务实例的临时 lease 记录。 */
interface DataRootInstanceLeaseRecord {
  version: 2
  pid: number
  ownerToken: string
  endpoint: DataRootLivenessEndpoint
  activeRoot: string
  createdAt: number
}

/** 迁移预检期间阻止新 normal 实例进入的不可变 intent claim。 */
interface DataRootMigrationIntentRecord {
  version: 2
  pid: number
  ownerToken: string
  endpoint: DataRootLivenessEndpoint
  createdAt: number
}

/** 文件创建后用于安全释放自身路径的稳定身份。 */
interface FileIdentity {
  dev: number
  ino: number
}

/** 读取不可变 claim 后保留的原文与文件身份。 */
interface ImmutableRecord<T> {
  record: T
  raw: string
  identity: FileIdentity
}

/** 从根 claim 到当前链尾的稳定快照。 */
interface IntentChainSnapshot {
  /** 已存在的全部不可变 claim。 */
  claims: Array<ImmutableRecord<DataRootMigrationIntentRecord>>
  /** 所有 contender 下一步竞争的唯一缺失后继路径。 */
  nextClaimPath: string
}

/** 迁移 intent 持有者必须显式释放的 guard。 */
export interface DataRootMigrationGuard {
  /** 仅删除当前持有者创建且仍未被替换的 active claim。 */
  release(): void
}

/** 实例 lease registry 的可注入依赖。 */
export interface DataRootInstanceLeaseRegistryOptions {
  /** dev/prod 共享 locator 所在的用户 home。 */
  homeDir: string
  /** 当前进程 PID，仅用于诊断。 */
  pid?: number
  /** 当前进程唯一 owner token。 */
  ownerToken?: string
  /** 测试可替换的 challenge server 工厂。 */
  startLivenessServer?: (ownerToken: string) => Promise<DataRootLivenessServer>
  /** 测试可替换的 challenge 探测器。 */
  probeLiveness?: (endpoint: DataRootLivenessEndpoint, ownerToken: string) => Promise<boolean>
  /** 生产 challenge 探测超时。 */
  probeTimeoutMs?: number
  /** 测试可替换的时钟。 */
  now?: () => number
}

/**
 * 使用共享 home 下的小型记录与 loopback challenge 协调 dev/prod 实例。
 * 不轮询；只在启动、迁移预检与退出时执行并发短探测。
 */
export class DataRootInstanceLeaseRegistry {
  /** 所有身份共享的固定 registry 目录。 */
  private readonly registryDir: string
  /** 当前进程 PID，仅写入诊断字段。 */
  private readonly pid: number
  /** challenge 与文件所有权共用的高熵 token。 */
  private readonly ownerToken: string
  /** challenge server 工厂。 */
  private readonly startLivenessServer: (ownerToken: string) => Promise<DataRootLivenessServer>
  /** 验证 endpoint 确实持有记录 token 的探测器。 */
  private readonly probeLiveness: (endpoint: DataRootLivenessEndpoint, ownerToken: string) => Promise<boolean>
  /** 记录创建时间的时钟。 */
  private readonly now: () => number
  /** 当前进程固定 lease 文件路径。 */
  private readonly ownLeasePath: string
  /** 当前实例启动后固定复用的 challenge server。 */
  private livenessServer: DataRootLivenessServer | null = null
  /** 当前进程成功创建的 lease 文件身份。 */
  private ownLeaseIdentity: FileIdentity | null = null
  /** 当前进程是否成功取得 lease。 */
  private acquired = false

  /** 根据共享 home 创建实例 registry。 */
  constructor(options: DataRootInstanceLeaseRegistryOptions) {
    if (!isAbsolute(options.homeDir)) throw new Error('实例 lease homeDir 必须是绝对路径')
    this.pid = options.pid ?? process.pid
    this.ownerToken = options.ownerToken ?? randomUUID()
    this.startLivenessServer = options.startLivenessServer ?? startLoopbackChallengeServer
    /** 默认探测器闭包固定本 registry 的短超时。 */
    const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    this.probeLiveness = options.probeLiveness
      ?? ((endpoint, ownerToken) => probeLoopbackChallenge(endpoint, ownerToken, timeoutMs))
    this.now = options.now ?? Date.now
    this.registryDir = join(resolve(options.homeDir), '.proma-instance-leases')
    /** owner token 只用于哈希命名，文件内容仍保存原 token 供 challenge。 */
    const ownerHash = createHash('sha256').update(this.ownerToken).digest('hex').slice(0, 16)
    this.ownLeasePath = join(this.registryDir, `${this.pid}-${ownerHash}.lease`)
  }

  /** 返回当前进程 lease 路径，供所有权回归测试使用。 */
  getOwnLeasePath(): string {
    return this.ownLeasePath
  }

  /** normal 模式在业务服务前原子注册自身 lease。 */
  async acquire(activeRoot: string): Promise<void> {
    if (this.acquired) return
    if (!isAbsolute(activeRoot)) throw new Error('实例 lease 数据根必须是绝对路径')
    mkdirSync(this.registryDir, { recursive: true })
    const server = await this.ensureLivenessServer()
    await this.assertNoActiveMigrationIntent()
    /** 当前实例写入的完整 lease，PID 不参与活性判断。 */
    const record: DataRootInstanceLeaseRecord = {
      version: 2,
      pid: this.pid,
      ownerToken: this.ownerToken,
      endpoint: server.endpoint,
      activeRoot: resolve(activeRoot),
      createdAt: this.now(),
    }
    this.ownLeaseIdentity = writeExclusiveJson(this.ownLeasePath, record)
    this.acquired = true
    try {
      // 与迁移 intent 竞争时二次检查：claim 持有者会扫描到本 lease，或本实例主动退出。
      await this.assertNoActiveMigrationIntent()
    } catch (error) {
      this.release()
      throw error
    }
  }

  /** 排除自身后并发探测全部 lease；PID 复用不会被误判为活跃。 */
  async hasOtherActiveLease(): Promise<boolean> {
    mkdirSync(this.registryDir, { recursive: true })
    /** registry 中全部其他普通实例 lease。 */
    const candidates = readdirSync(this.registryDir)
      .filter((name) => name.endsWith('.lease'))
      .map((name) => {
        const path = join(this.registryDir, name)
        const immutable = readImmutableRecord(path, readLeaseRecord)
        return { path, ...immutable }
      })
      .filter(({ record }) => record.ownerToken !== this.ownerToken)
    /** 并发短探测避免多个陈旧记录线性叠加启动延迟。 */
    const results = await Promise.all(candidates.map(async (candidate) => ({
      candidate,
      active: await this.probeLiveness(candidate.record.endpoint, candidate.record.ownerToken),
    })))
    if (results.some(({ active }) => active)) return true
    for (const { candidate } of results) {
      removeImmutableOwnedPath(candidate.path, candidate.record.ownerToken, candidate.identity, readLeaseRecord)
    }
    return false
  }

  /** 取得迁移独占 intent；死亡 claim 通过确定性后继链线性接管，绝不删除前驱。 */
  async acquireMigrationGuard(): Promise<DataRootMigrationGuard> {
    mkdirSync(this.registryDir, { recursive: true })
    const server = await this.ensureLivenessServer()
    /** 当前迁移预检绑定同一个实例 challenge。 */
    const intent: DataRootMigrationIntentRecord = {
      version: 2,
      pid: this.pid,
      ownerToken: this.ownerToken,
      endpoint: server.endpoint,
      createdAt: this.now(),
    }
    for (let attempt = 0; attempt < MAX_INTENT_CHAIN_LENGTH; attempt += 1) {
      /** 先完整读取链，再并发验证全部 owner，避免 crash 链线性叠加超时。 */
      const chain = readIntentChain(this.registryDir)
      const activeClaims = await Promise.all(chain.claims.map(({ record }) => (
        this.probeLiveness(record.endpoint, record.ownerToken)
      )))
      if (activeClaims.some(Boolean)) throw new Error('另一个 Proma 实例正在准备数据根迁移')
      /** 当前快照链尾对应的确定性后继是所有 contender 的唯一竞争目标。 */
      const claimPath = chain.nextClaimPath
      try {
        const identity = writeExclusiveJson(claimPath, intent)
        /** release 只删除本次成功 O_EXCL 创建且仍为同 inode/token 的 active claim。 */
        return {
          release: () => removeImmutableOwnedPath(
            claimPath,
            this.ownerToken,
            identity,
            readMigrationIntentRecord,
          ),
        }
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error
        // 另一个 contender 先创建同一后继；重新读取整条链并验证赢家。
      }
    }
    throw new Error('迁移 intent claim 链过长，拒绝继续接管')
  }

  /** graceful quit 时释放自身 lease 与 challenge server。 */
  release(): void {
    if (this.ownLeaseIdentity !== null) {
      removeImmutableOwnedPath(
        this.ownLeasePath,
        this.ownerToken,
        this.ownLeaseIdentity,
        readLeaseRecord,
      )
    }
    this.ownLeaseIdentity = null
    this.acquired = false
    this.livenessServer?.close()
    this.livenessServer = null
  }

  /** normal 启动门沿不可变 claim 链检查是否存在活跃迁移 intent。 */
  private async assertNoActiveMigrationIntent(): Promise<void> {
    const chain = readIntentChain(this.registryDir)
    /** 全部 claim challenge 并发执行，活跃本机实例不受陈旧链长度影响。 */
    const activeClaims = await Promise.all(chain.claims.map(({ record }) => (
      this.probeLiveness(record.endpoint, record.ownerToken)
    )))
    if (activeClaims.some(Boolean)) throw new Error('数据根正在准备迁移，普通业务实例不会启动')
  }

  /** 首次 lease/intent 前启动一次 challenge server，后续固定复用。 */
  private async ensureLivenessServer(): Promise<DataRootLivenessServer> {
    if (this.livenessServer === null) {
      this.livenessServer = await this.startLivenessServer(this.ownerToken)
    }
    return this.livenessServer
  }
}

/** 生产进程共享的唯一实例 registry，延迟创建避免模块导入副作用。 */
let defaultRegistry: DataRootInstanceLeaseRegistry | null = null

/** 返回 dev/prod 均基于系统 home 协调的进程级实例 registry。 */
export function getDefaultDataRootInstanceLeaseRegistry(): DataRootInstanceLeaseRegistry {
  if (defaultRegistry === null) defaultRegistry = new DataRootInstanceLeaseRegistry({ homeDir: homedir() })
  return defaultRegistry
}

/** 启动仅监听 IPv4 loopback 的 token challenge server。 */
async function startLoopbackChallengeServer(ownerToken: string): Promise<DataRootLivenessServer> {
  /** 每个连接最多接收一行 token，错误输入立即关闭。 */
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.setTimeout(DEFAULT_PROBE_TIMEOUT_MS, () => socket.destroy())
    let input = ''
    socket.on('data', (chunk: string) => {
      input += chunk
      if (input.length > 512) {
        socket.destroy()
        return
      }
      const newline = input.indexOf('\n')
      if (newline === -1) return
      const challenge = input.slice(0, newline)
      socket.end(challenge === ownerToken ? `${ownerToken}\n` : 'invalid\n')
    })
  })
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', onError)
      resolvePromise()
    })
  })
  server.unref()
  const address = server.address() as AddressInfo
  return {
    endpoint: { host: LOOPBACK_HOST, port: address.port },
    close: () => server.close(),
  }
}

/** 连接记录端点并验证其响应 token，错误/超时统一视为 stale。 */
async function probeLoopbackChallenge(
  endpoint: DataRootLivenessEndpoint,
  ownerToken: string,
  timeoutMs: number,
): Promise<boolean> {
  if (endpoint.host !== LOOPBACK_HOST || !isValidPort(endpoint.port)) return false
  return new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host: endpoint.host, port: endpoint.port })
    let settled = false
    let response = ''
    const finish = (active: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(active)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => socket.write(`${ownerToken}\n`))
    socket.on('data', (chunk: string) => {
      response += chunk
      if (response.length > 512) return finish(false)
      const newline = response.indexOf('\n')
      if (newline !== -1) finish(response.slice(0, newline) === ownerToken)
    })
    socket.once('error', () => finish(false))
    socket.once('end', () => finish(response.trim() === ownerToken))
  })
}

/** 使用 O_EXCL 建立完整小文件并返回其不可替换身份。 */
function writeExclusiveJson(
  path: string,
  value: DataRootInstanceLeaseRecord | DataRootMigrationIntentRecord,
): FileIdentity {
  /** no-follow `wx` 对同一路径提供跨进程独占创建语义。 */
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
  const descriptor = openSync(path, flags, 0o600)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('实例协调 claim 不是普通文件')
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8')
    fsyncSync(descriptor)
    return { dev: stat.dev, ino: stat.ino }
  } finally {
    closeSync(descriptor)
  }
}

/** no-follow 读取不可变小记录并确认读取期间 inode 未变化。 */
function readImmutableRecord<T>(path: string, parse: (raw: string) => T): ImmutableRecord<T> {
  /** no-follow 打开后用同一 descriptor 前后 fstat，拒绝 symlink 与读取期置换。 */
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const descriptor = openSync(path, flags)
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile()) throw new Error('实例协调记录不是普通文件')
    const raw = readFileSync(descriptor, 'utf8')
    const after = fstatSync(descriptor)
    const identity = { dev: before.dev, ino: before.ino }
    if (!after.isFile() || after.dev !== identity.dev || after.ino !== identity.ino) {
      throw new Error('实例协调记录读取期间已变化')
    }
    return { record: parse(raw), raw, identity }
  } finally {
    closeSync(descriptor)
  }
}

/** 严格读取普通实例 lease，任何损坏都阻止迁移。 */
function readLeaseRecord(raw: string): DataRootInstanceLeaseRecord {
  const value = parseJsonUnknown(raw, '实例 lease 损坏')
  if (!isRecord(value)
    || value.version !== 2
    || !isPositiveInteger(value.pid)
    || !isNonEmptyString(value.ownerToken)
    || !isLivenessEndpoint(value.endpoint)
    || !isNonEmptyString(value.activeRoot)
    || !isAbsolute(value.activeRoot)
    || !isNonNegativeFiniteNumber(value.createdAt)) {
    throw new Error('实例 lease 损坏')
  }
  return value as unknown as DataRootInstanceLeaseRecord
}

/** 严格读取迁移 intent，任何损坏都阻止 normal 启动或迁移接管。 */
function readMigrationIntentRecord(raw: string): DataRootMigrationIntentRecord {
  const value = parseJsonUnknown(raw, '迁移 intent 损坏')
  if (!isRecord(value)
    || value.version !== 2
    || !isPositiveInteger(value.pid)
    || !isNonEmptyString(value.ownerToken)
    || !isLivenessEndpoint(value.endpoint)
    || !isNonNegativeFiniteNumber(value.createdAt)) {
    throw new Error('迁移 intent 损坏')
  }
  return value as unknown as DataRootMigrationIntentRecord
}

/** 解析 registry JSON，任何语法错误都 fail closed。 */
function parseJsonUnknown(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(message, { cause: error })
  }
}

/** 只删除当前实例创建且路径、inode、owner token 都仍匹配的记录。 */
function removeImmutableOwnedPath<T extends { ownerToken: string }>(
  path: string,
  expectedOwnerToken: string,
  expectedIdentity: FileIdentity,
  parse: (raw: string) => T,
): void {
  if (!existsSync(path)) return
  const current = readImmutableRecord(path, parse)
  if (current.record.ownerToken !== expectedOwnerToken
    || current.identity.dev !== expectedIdentity.dev
    || current.identity.ino !== expectedIdentity.ino) return
  unlinkSync(path)
}

/** 每个不可变前驱原文确定唯一后继路径，所有 contender 竞争同一个 O_EXCL claim。 */
function getIntentSuccessorPath(registryDir: string, predecessorRaw: string): string {
  const predecessorHash = createHash('sha256').update(predecessorRaw).digest('hex')
  return join(registryDir, `migration.intent.${predecessorHash}.claim`)
}

/** 同步读取不可变 intent 链结构；网络 challenge 由调用方随后并发执行。 */
function readIntentChain(registryDir: string): IntentChainSnapshot {
  /** 固定根 claim；每个前驱原文唯一确定下一路径。 */
  let claimPath = join(registryDir, 'migration.intent.claim')
  const claims: Array<ImmutableRecord<DataRootMigrationIntentRecord>> = []
  for (let depth = 0; depth < MAX_INTENT_CHAIN_LENGTH; depth += 1) {
    if (!existsSync(claimPath)) return { claims, nextClaimPath: claimPath }
    const claim = readImmutableRecord(claimPath, readMigrationIntentRecord)
    claims.push(claim)
    claimPath = getIntentSuccessorPath(registryDir, claim.raw)
  }
  throw new Error('迁移 intent claim 链过长，拒绝继续协调')
}

/** 判断文件独占创建是否因目标已存在失败。 */
function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/** 判断 unknown 是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断 unknown 是否为合法 loopback challenge 端点。 */
function isLivenessEndpoint(value: unknown): value is DataRootLivenessEndpoint {
  return isRecord(value) && value.host === LOOPBACK_HOST && isValidPort(value.port)
}

/** 判断端口为非特权 TCP 端口范围内整数。 */
function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535
}

/** 判断 unknown 是否为正整数。 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** 判断 unknown 是否为有限非负数。 */
function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 判断 unknown 是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
