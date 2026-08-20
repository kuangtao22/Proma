import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** normal 业务实例的临时 lease 记录。 */
interface DataRootInstanceLeaseRecord {
  version: 1
  pid: number
  ownerToken: string
  activeRoot: string
  createdAt: number
}

/** 迁移预检期间阻止新 normal 实例进入的独占 intent。 */
interface DataRootMigrationIntentRecord {
  version: 1
  pid: number
  ownerToken: string
  createdAt: number
}

/** 迁移 intent 持有者必须显式释放的 guard。 */
export interface DataRootMigrationGuard {
  /** 仅当 owner token 仍匹配时释放 intent。 */
  release(): void
}

/** 实例 lease registry 的可注入依赖。 */
export interface DataRootInstanceLeaseRegistryOptions {
  /** dev/prod 共享 locator 所在的用户 home。 */
  homeDir: string
  /** 当前进程 PID。 */
  pid?: number
  /** 当前进程唯一 owner token。 */
  ownerToken?: string
  /** 测试可替换的 PID 存活检查。 */
  isPidRunning?: (pid: number) => boolean
  /** 测试可替换的时钟。 */
  now?: () => number
}

/**
 * 使用 home 下小型独占文件协调共享数据根的 dev/prod 实例。
 * registry 不轮询，只在启动、迁移预检与退出时执行少量文件操作。
 */
export class DataRootInstanceLeaseRegistry {
  /** 所有身份共享的固定 registry 目录。 */
  private readonly registryDir: string
  /** 当前进程 PID。 */
  private readonly pid: number
  /** 防止旧实例误删新记录的唯一 owner token。 */
  private readonly ownerToken: string
  /** PID 存活检查器。 */
  private readonly isPidRunning: (pid: number) => boolean
  /** 记录创建时间的时钟。 */
  private readonly now: () => number
  /** 当前进程固定 lease 文件路径。 */
  private readonly ownLeasePath: string
  /** 当前进程是否成功取得 lease。 */
  private acquired = false

  /** 根据共享 home 创建实例 registry。 */
  constructor(options: DataRootInstanceLeaseRegistryOptions) {
    if (!isAbsolute(options.homeDir)) throw new Error('实例 lease homeDir 必须是绝对路径')
    this.pid = options.pid ?? process.pid
    this.ownerToken = options.ownerToken ?? randomUUID()
    this.isPidRunning = options.isPidRunning ?? isProcessRunning
    this.now = options.now ?? Date.now
    this.registryDir = join(resolve(options.homeDir), '.proma-instance-leases')
    /** owner token 只用于哈希命名，文件内容仍保存原 token 供所有权复核。 */
    const ownerHash = createHash('sha256').update(this.ownerToken).digest('hex').slice(0, 16)
    this.ownLeasePath = join(this.registryDir, `${this.pid}-${ownerHash}.lease`)
  }

  /** 返回当前进程 lease 路径，供所有权回归测试使用。 */
  getOwnLeasePath(): string {
    return this.ownLeasePath
  }

  /** normal 模式在业务服务前原子注册自身 lease。 */
  acquire(activeRoot: string): void {
    if (this.acquired) return
    if (!isAbsolute(activeRoot)) throw new Error('实例 lease 数据根必须是绝对路径')
    mkdirSync(this.registryDir, { recursive: true })
    this.assertNoActiveMigrationIntent()
    /** 当前实例写入的完整 lease。 */
    const record: DataRootInstanceLeaseRecord = {
      version: 1,
      pid: this.pid,
      ownerToken: this.ownerToken,
      activeRoot: resolve(activeRoot),
      createdAt: this.now(),
    }
    writeExclusiveJson(this.ownLeasePath, record)
    this.acquired = true
    try {
      // 与迁移 intent 竞争时二次检查：intent 持有者会扫描到本 lease，或本实例主动退出。
      this.assertNoActiveMigrationIntent()
    } catch (error) {
      this.release()
      throw error
    }
  }

  /** 排除自身后扫描活跃实例；死 PID 安全清理，损坏记录 fail closed。 */
  hasOtherActiveLease(): boolean {
    mkdirSync(this.registryDir, { recursive: true })
    /** registry 中全部普通实例 lease 文件。 */
    const leaseNames = readdirSync(this.registryDir).filter((name) => name.endsWith('.lease'))
    for (const leaseName of leaseNames) {
      /** 当前扫描的 lease 绝对路径。 */
      const leasePath = join(this.registryDir, leaseName)
      /** 严格解析后的 lease 内容。 */
      const record = readLeaseRecord(leasePath)
      if (record.pid === this.pid && record.ownerToken === this.ownerToken) continue
      if (this.isPidRunning(record.pid)) return true
      removeOwnedRecord(leasePath, record.ownerToken, readLeaseRecord)
    }
    return false
  }

  /** 取得迁移独占 intent，阻止新的 normal 实例通过启动门。 */
  acquireMigrationGuard(): DataRootMigrationGuard {
    mkdirSync(this.registryDir, { recursive: true })
    /** 固定 intent 文件确保 dev/prod 竞争同一原子目标。 */
    const intentPath = join(this.registryDir, 'migration.intent')
    /** 当前迁移预检的唯一 intent 内容。 */
    const intent: DataRootMigrationIntentRecord = {
      version: 1,
      pid: this.pid,
      ownerToken: this.ownerToken,
      createdAt: this.now(),
    }
    try {
      writeExclusiveJson(intentPath, intent)
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error
      /** 已存在 intent 必须可验证且属于死亡进程才允许清理重试。 */
      const existing = readMigrationIntentRecord(intentPath)
      if (this.isPidRunning(existing.pid)) throw new Error('另一个 Proma 实例正在准备数据根迁移')
      removeOwnedRecord(intentPath, existing.ownerToken, readMigrationIntentRecord)
      writeExclusiveJson(intentPath, intent)
    }
    /** guard 的释放函数保留当前 token，不会删除后来接管者的 intent。 */
    return {
      release: () => removeOwnedRecord(intentPath, this.ownerToken, readMigrationIntentRecord),
    }
  }

  /** graceful quit 时释放自身 lease，owner 不匹配时保持文件不变。 */
  release(): void {
    if (!this.acquired && !existsSync(this.ownLeasePath)) return
    removeOwnedRecord(this.ownLeasePath, this.ownerToken, readLeaseRecord)
    this.acquired = false
  }

  /** normal 启动门检查是否已有活跃迁移 intent。 */
  private assertNoActiveMigrationIntent(): void {
    /** 固定迁移 intent 路径。 */
    const intentPath = join(this.registryDir, 'migration.intent')
    if (!existsSync(intentPath)) return
    /** intent 损坏或身份不明时读取函数直接 fail closed。 */
    const intent = readMigrationIntentRecord(intentPath)
    if (this.isPidRunning(intent.pid)) throw new Error('数据根正在准备迁移，普通业务实例不会启动')
    removeOwnedRecord(intentPath, intent.ownerToken, readMigrationIntentRecord)
  }
}

/** 生产进程共享的唯一实例 registry，延迟创建避免模块导入副作用。 */
let defaultRegistry: DataRootInstanceLeaseRegistry | null = null

/** 返回 dev/prod 均基于系统 home 协调的进程级实例 registry。 */
export function getDefaultDataRootInstanceLeaseRegistry(): DataRootInstanceLeaseRegistry {
  if (defaultRegistry === null) defaultRegistry = new DataRootInstanceLeaseRegistry({ homeDir: homedir() })
  return defaultRegistry
}

/** 使用 O_EXCL 建立完整小文件并 fsync，避免两个进程同时取得同一所有权。 */
function writeExclusiveJson(path: string, value: DataRootInstanceLeaseRecord | DataRootMigrationIntentRecord): void {
  /** `wx` 对同一路径提供跨进程独占创建语义。 */
  const descriptor = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

/** 严格读取普通实例 lease，任何损坏都阻止迁移。 */
function readLeaseRecord(path: string): DataRootInstanceLeaseRecord {
  /** JSON 解析前保持 unknown，避免信任跨进程文件。 */
  const value = readJsonUnknown(path, '实例 lease 损坏')
  if (!isRecord(value)
    || value.version !== 1
    || !isPositiveInteger(value.pid)
    || !isNonEmptyString(value.ownerToken)
    || !isNonEmptyString(value.activeRoot)
    || !isAbsolute(value.activeRoot)
    || !isNonNegativeFiniteNumber(value.createdAt)) {
    throw new Error('实例 lease 损坏')
  }
  return value as unknown as DataRootInstanceLeaseRecord
}

/** 严格读取迁移 intent，任何损坏都阻止 normal 启动或迁移接管。 */
function readMigrationIntentRecord(path: string): DataRootMigrationIntentRecord {
  /** JSON 解析前保持 unknown，避免信任跨进程文件。 */
  const value = readJsonUnknown(path, '迁移 intent 损坏')
  if (!isRecord(value)
    || value.version !== 1
    || !isPositiveInteger(value.pid)
    || !isNonEmptyString(value.ownerToken)
    || !isNonNegativeFiniteNumber(value.createdAt)) {
    throw new Error('迁移 intent 损坏')
  }
  return value as unknown as DataRootMigrationIntentRecord
}

/** 读取并解析 registry JSON，ENOENT 也视为并发所有权变化而 fail closed。 */
function readJsonUnknown(path: string, message: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(message, { cause: error })
  }
}

/** 复读 owner token 后才删除，避免旧实例误删后来接管者。 */
function removeOwnedRecord<T extends { ownerToken: string }>(
  path: string,
  expectedOwnerToken: string,
  readRecord: (path: string) => T,
): void {
  if (!existsSync(path)) return
  /** 删除前最后一次读取的当前 owner。 */
  const current = readRecord(path)
  if (current.ownerToken !== expectedOwnerToken) return
  unlinkSync(path)
}

/** 判断文件独占创建是否因目标已存在失败。 */
function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/** 默认使用 signal 0 检查 PID，权限拒绝表示进程存在。 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/** 判断 unknown 是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
