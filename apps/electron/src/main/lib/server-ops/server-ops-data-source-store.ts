import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isServerOpsId, parseServerOpsDataSource } from '@proma/shared'
import type { ServerOpsDataEngine, ServerOpsDataSourceUpsertInput, ServerOpsDataTlsMode, ServerOpsDataTransport } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readAtomicFileState, readJsonFileSafe, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicDestinationExpectation, ReadJsonFileSafeOptions } from '../safe-file'
import {
  createServerOpsConfigTransaction,
  resolveServerOpsConfigFilePath,
} from './server-ops-config-transaction'
import type { ServerOpsConfigTransaction } from './server-ops-config-transaction'

/** 数据源相对业务配置根的目录名，与主机资产共用同一运维目录。 */
const SERVER_OPS_DIRECTORY = 'server-ops'
/** 数据源元数据文件名。 */
const SERVER_OPS_DATA_SOURCES_FILENAME = 'data-sources.json'
/** 当前数据源文件 schema 版本。 */
const SERVER_OPS_DATA_SOURCES_VERSION = 1

/** 主进程内部数据源记录；`credentialRef` 绝不进入 Renderer 投影。 */
export interface ServerOpsStoredDataSource {
  id: string
  /** 归属的运维项目；直连数据源没有主机，项目归属只能来自这里。 */
  projectId?: string
  /** 连接方式；`direct` 表示从本机直连，不依赖任何主机。 */
  transport: ServerOpsDataTransport
  /** 跳板主机；仅 `ssh` 方式存在。 */
  hostId?: string
  engine: ServerOpsDataEngine
  label: string
  /** 网络引擎使用地址与端口；SQLite 使用服务器文件路径。 */
  address?: string
  port?: number
  /** SQLite 绝对文件路径：direct 为本机，SSH 为远端服务器。 */
  filePath?: string
  /** 主进程登记的本地 SQLite 文件身份。 */
  localFileId?: string
  database?: string
  username?: string
  tlsMode: ServerOpsDataTlsMode
  tlsServerName?: string
  credentialRef?: string
  createdAt: number
  updatedAt: number
}

/** 数据源 Store 可替换的安全文件、时间与 ID 依赖。 */
export interface ServerOpsDataSourceStoreDependencies {
  /** 使用 safe-file 候选恢复规则读取 JSON。 */
  readJson: <T>(filePath: string, options: ReadJsonFileSafeOptions<T>) => T | null
  /** 使用 safe-file 原子写入完整数据源快照。 */
  writeJson: (
    filePath: string,
    data: object,
    expectedDestination: AtomicDestinationExpectation,
    priorBackup?: object,
  ) => void
  /** 生成新数据源的稳定唯一 ID。 */
  uuid: () => string
  /** 生成创建和更新时间戳。 */
  now: () => number
  /** 覆盖 fresh-read 与原子提交的同步短事务。 */
  transaction?: ServerOpsConfigTransaction
  /** 迁移期解析默认项目 ID；未注入时保持原行为。 */
  resolveDefaultProjectId?: () => string
  /** 在当前配置事务内解析并验证新数据源的项目归属。 */
  resolveProjectId?: (projectId?: string) => string
}

/** 创建生产环境使用的数据源 Store 依赖。 */
export function createServerOpsDataSourceStoreDependencies(): ServerOpsDataSourceStoreDependencies {
  return {
    readJson: readJsonFileSafe,
    writeJson: (filePath, data, expectedDestination, priorBackup) => {
      writeJsonFileAtomicSecure(filePath, data, {
        expectedDestination,
        ...(priorBackup ? { priorBackup: { filePath: `${filePath}.bak`, data: priorBackup } } : {}),
      })
    },
    uuid: randomUUID,
    now: Date.now,
  }
}

/** 数据源文件的版本化根结构。 */
interface ServerOpsDataSourceFile {
  version: typeof SERVER_OPS_DATA_SOURCES_VERSION
  sources: ServerOpsStoredDataSource[]
}

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断 Store 时间源是否返回可持久化时间戳。 */
function isValidTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
}

/** 复制单条数据源记录，阻断调用方修改内部对象。 */
function cloneSource(source: ServerOpsStoredDataSource): ServerOpsStoredDataSource {
  return { ...source }
}

/** 严格解析持久化记录；字段规则复用公开投影合同，避免两侧校验分叉。 */
function parseStoredDataSource(value: unknown): ServerOpsStoredDataSource {
  if (!isRecord(value)) throw new Error('SERVER_OPS_DATA_SOURCE_FILE_INVALID')
  /** 持久化记录中的密文引用。 */
  const credentialRef = value.credentialRef
  if (credentialRef !== undefined && !isServerOpsId(credentialRef)) throw new Error('SERVER_OPS_DATA_SOURCE_FILE_INVALID')
  /** 去掉密文引用后的公开字段集合。 */
  const publicCandidate: Record<string, unknown> = { ...value, hasPassword: credentialRef !== undefined }
  delete publicCandidate.credentialRef
  try {
    /** 通过公开合同校验的字段投影。 */
    const parsed = parseServerOpsDataSource(publicCandidate)
    return {
      id: parsed.id,
      ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
      transport: parsed.transport,
      ...(parsed.hostId === undefined ? {} : { hostId: parsed.hostId }),
      engine: parsed.engine,
      label: parsed.label,
      ...(parsed.address === undefined ? {} : { address: parsed.address }),
      ...(parsed.port === undefined ? {} : { port: parsed.port }),
      ...(parsed.filePath === undefined ? {} : { filePath: parsed.filePath }),
      ...(parsed.localFileId === undefined ? {} : { localFileId: parsed.localFileId }),
      ...(parsed.database === undefined ? {} : { database: parsed.database }),
      ...(parsed.username === undefined ? {} : { username: parsed.username }),
      tlsMode: parsed.tlsMode,
      ...(parsed.tlsServerName === undefined ? {} : { tlsServerName: parsed.tlsServerName }),
      ...(credentialRef === undefined ? {} : { credentialRef: credentialRef as string }),
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    }
  } catch {
    throw new Error('SERVER_OPS_DATA_SOURCE_FILE_INVALID')
  }
}

/** 严格解析数据源文件根结构，拒绝未知字段与重复 ID。 */
function parseDataSourceFile(value: unknown): ServerOpsDataSourceFile {
  if (!isRecord(value) || value.version !== SERVER_OPS_DATA_SOURCES_VERSION
    || !Array.isArray(value.sources)
    || Object.keys(value).some((key) => key !== 'version' && key !== 'sources')) {
    throw new Error('SERVER_OPS_DATA_SOURCE_FILE_INVALID')
  }
  /** 解析后的数据源记录。 */
  const sources = value.sources.map((entry) => parseStoredDataSource(entry))
  /** 出现重复 ID 的文件不可信，避免后续按 ID 定位到错误目标。 */
  const seen = new Set<string>()
  for (const source of sources) {
    if (seen.has(source.id)) throw new Error('SERVER_OPS_DATA_SOURCE_FILE_INVALID')
    seen.add(source.id)
  }
  return { version: SERVER_OPS_DATA_SOURCES_VERSION, sources }
}

/** 管理 `~/.proma/server-ops/data-sources.json` 的数据库数据源元数据。 */
export class ServerOpsDataSourceStore {
  /** 数据源元数据最终文件路径。 */
  private readonly filePath: string
  /** 可替换的安全文件、时间和 ID 边界。 */
  private readonly dependencies: ServerOpsDataSourceStoreDependencies
  /** 覆盖同目录协作写入的同步短事务。 */
  private readonly transaction: ServerOpsConfigTransaction

  /**
   * 创建并加载数据源 Store。
   *
   * @param configDir Proma 业务配置根
   * @param dependencies 测试可替换依赖
   */
  constructor(
    configDir = getConfigDir(),
    dependencies: Partial<ServerOpsDataSourceStoreDependencies> = {},
  ) {
    /** 存放运维资产与凭据的固定子目录。 */
    const directoryPath = join(configDir, SERVER_OPS_DIRECTORY)
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = resolveServerOpsConfigFilePath(directoryPath, SERVER_OPS_DATA_SOURCES_FILENAME)
    this.dependencies = { ...createServerOpsDataSourceStoreDependencies(), ...dependencies }
    this.transaction = dependencies.transaction ?? createServerOpsConfigTransaction(directoryPath)
  }

  /**
   * 列出指定主机已保存的数据源。
   *
   * @param hostId 目标主机 ID
   * @returns 按创建时间升序排列的数据源副本
   */
  list(): ServerOpsStoredDataSource[] {
    const loaded = this.readStoredSources()
    if (!loaded.needsMigration) return loaded.sources.sort((left, right) => left.createdAt - right.createdAt).map(cloneSource)
    /** 迁移写入必须落在锁内，避免与其它实例的提交相互覆盖。 */
    return this.transaction(() => {
      const authoritative = this.readStoredSources()
      if (authoritative.needsMigration) {
        // 双次原子提交让主文件与备份同时带上项目归属，避免备份回滚成旧 schema。
        this.persist(authoritative.sources, authoritative.expectedDestination, authoritative.priorBackup)
        this.persist(authoritative.sources, this.captureDestinationExpectation(), authoritative.sources.map(cloneSource))
      }
      return authoritative.sources.sort((left, right) => left.createdAt - right.createdAt).map(cloneSource)
    })
  }

  /**
   * 按主机与数据源身份读取单条记录。
   *
   * @param hostId 目标主机 ID
   * @param sourceId 目标数据源 ID
   * @returns 数据源副本；不存在或归属其它主机时返回 undefined
   */
  getById(sourceId: string): ServerOpsStoredDataSource | undefined {
    if (!isServerOpsId(sourceId)) return undefined
    /** 按稳定数据源身份定位记录。 */
    const found = this.readStoredSources().sources.find((source) => source.id === sourceId)
    return found ? cloneSource(found) : undefined
  }

  /**
   * 新增数据源元数据。
   *
   * @param input 已通过共享合同解析的写入输入
   * @param credentialRef 可选的密码密文引用
   * @param localFileId 主进程校验的本地 SQLite 文件身份，不能来自渲染层输入
   * @returns 新建的数据源副本
   */
  create(input: ServerOpsDataSourceUpsertInput, credentialRef?: string, localFileId?: string): ServerOpsStoredDataSource {
    if (input.sourceId !== undefined) throw new Error('SERVER_OPS_DATA_SOURCE_ID_INVALID')
    if (credentialRef !== undefined && !isServerOpsId(credentialRef)) throw new Error('SERVER_OPS_CREDENTIAL_REF_INVALID')
    /** 新数据源的稳定 ID。 */
    const id = this.dependencies.uuid()
    if (!isServerOpsId(id)) throw new Error('SERVER_OPS_DATA_SOURCE_ID_INVALID')
    /** 当前操作的权威时间。 */
    const now = this.dependencies.now()
    if (!isValidTimestamp(now)) throw new Error('SERVER_OPS_DATA_SOURCE_TIMESTAMP_INVALID')
    return this.transaction(() => {
      /** 锁内权威快照，避免跨实例丢更新。 */
      const loaded = this.readStoredSources()
      if (loaded.sources.some((source) => source.id === id)) throw new Error('SERVER_OPS_DATA_SOURCE_ID_INVALID')
      /** 待持久化的新记录。 */
      const projectId = this.resolveCreatedProjectId(input.projectId)
      const created: ServerOpsStoredDataSource = {
        id,
        ...(projectId === undefined ? {} : { projectId }),
        transport: input.transport,
        ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
        engine: input.engine,
        label: input.label,
        ...(input.address === undefined ? {} : { address: input.address }),
        ...(input.port === undefined ? {} : { port: input.port }),
        ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
        ...(localFileId === undefined ? {} : { localFileId }),
        ...(input.database === undefined ? {} : { database: input.database }),
        ...(input.username === undefined ? {} : { username: input.username }),
        tlsMode: input.tlsMode,
        ...(input.tlsServerName === undefined ? {} : { tlsServerName: input.tlsServerName }),
        ...(credentialRef === undefined ? {} : { credentialRef }),
        createdAt: now,
        updatedAt: now,
      }
      parseStoredDataSource(created)
      this.persist([...loaded.sources, created], loaded.expectedDestination, loaded.priorBackup)
      return cloneSource(created)
    })
  }

  /**
   * 更新数据源元数据；密码引用与普通字段语义不同，必须显式区分三态。
   *
   * @param hostId 目标主机 ID
   * @param sourceId 目标数据源 ID
   * @param patch 待更新字段；`null` 表示删除可选字段或清除密码引用
   * @returns 更新后的数据源副本
   */
  update(
    sourceId: string,
    patch: {
      projectId?: string
      transport?: ServerOpsDataTransport
      hostId?: string | null
      label?: string
      address?: string
      port?: number
      /** 编辑 SQLite 文件目标时参与原子配置更新。 */
      filePath?: string
      /** 本地文件绑定变更；切换到 SSH 时清除。 */
      localFileId?: string | null
      database?: string | null
      username?: string | null
      tlsMode?: ServerOpsDataTlsMode
      tlsServerName?: string | null
      credentialRef?: string | null
    },
  ): ServerOpsStoredDataSource {
    if (!isServerOpsId(sourceId)) throw new Error('SERVER_OPS_DATA_SOURCE_ID_INVALID')
    if (patch.credentialRef !== undefined && patch.credentialRef !== null && !isServerOpsId(patch.credentialRef)) {
      throw new Error('SERVER_OPS_CREDENTIAL_REF_INVALID')
    }
    return this.transaction(() => {
      /** 锁内权威快照。 */
      const loaded = this.readStoredSources()
      /** 待更新记录在当前快照中的位置。 */
      const index = loaded.sources.findIndex((source) => source.id === sourceId)
      if (index < 0) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
      /** 经过存在性校验的当前记录。 */
      const existing = loaded.sources[index]
      if (!existing) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
      if (patch.projectId !== undefined && patch.projectId !== existing.projectId) {
        throw new Error('SERVER_OPS_DATA_SOURCE_PROJECT_MISMATCH')
      }
      /** 当前操作的权威时间。 */
      const now = this.dependencies.now()
      if (!isValidTimestamp(now)) throw new Error('SERVER_OPS_DATA_SOURCE_TIMESTAMP_INVALID')
      /** 合并后的下一版记录，先复制再按需删除可选字段。 */
      const updated: ServerOpsStoredDataSource = {
        ...existing,
        ...(patch.transport === undefined ? {} : { transport: patch.transport }),
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.address === undefined ? {} : { address: patch.address }),
        ...(patch.port === undefined ? {} : { port: patch.port }),
        ...(patch.filePath === undefined ? {} : { filePath: patch.filePath }),
        ...(patch.tlsMode === undefined ? {} : { tlsMode: patch.tlsMode }),
        updatedAt: Math.max(now, existing.updatedAt),
      }
      if (patch.localFileId === null) delete updated.localFileId
      else if (patch.localFileId !== undefined) updated.localFileId = patch.localFileId
      if (patch.database === null) delete updated.database
      else if (patch.database !== undefined) updated.database = patch.database
      if (patch.username === null) delete updated.username
      else if (patch.username !== undefined) updated.username = patch.username
      if (patch.tlsServerName === null) delete updated.tlsServerName
      else if (patch.tlsServerName !== undefined) updated.tlsServerName = patch.tlsServerName
      if (patch.credentialRef === null) delete updated.credentialRef
      else if (patch.credentialRef !== undefined) updated.credentialRef = patch.credentialRef
      if (patch.hostId === null) delete updated.hostId
      else if (patch.hostId !== undefined) updated.hostId = patch.hostId
      /** 更新后的记录必须仍然满足共享合同，避免写出不可读文件。 */
      parseStoredDataSource(updated)
      this.persist(
        loaded.sources.map((source, sourceIndex) => sourceIndex === index ? updated : source),
        loaded.expectedDestination,
        loaded.priorBackup,
      )
      return cloneSource(updated)
    })
  }

  /** 在外层写事务内解析新数据源归属，显式项目缺少解析器时 fail closed。 */
  private resolveCreatedProjectId(projectId?: string): string | undefined {
    if (this.dependencies.resolveProjectId !== undefined) return this.dependencies.resolveProjectId(projectId)
    if (projectId !== undefined) throw new Error('SERVER_OPS_PROJECT_UNAVAILABLE')
    return this.dependencies.resolveDefaultProjectId?.()
  }

  /**
   * 独立移动数据源归属；保留稳定身份、密码引用、跳板与全部连接字段。
   *
   * @param sourceId 待移动数据源 ID
   * @param fromProjectId 调用方看到的原项目，用于拒绝过期操作
   * @param targetProjectId 当前权威项目文件中必须存在的目标项目
   * @returns 移动后的内部记录副本
   */
  move(sourceId: string, fromProjectId: string, targetProjectId: string): ServerOpsStoredDataSource {
    if (!isServerOpsId(sourceId)) throw new Error('SERVER_OPS_DATA_SOURCE_ID_INVALID')
    if (!isServerOpsId(fromProjectId) || !isServerOpsId(targetProjectId)) {
      throw new Error('SERVER_OPS_PROJECT_ID_INVALID')
    }
    return this.transaction(() => {
      /** 移动必须基于锁内 fresh read，避免覆盖其它窗口已完成的归属变更。 */
      const loaded = this.readStoredSources()
      const index = loaded.sources.findIndex((source) => source.id === sourceId)
      if (index < 0) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
      const existing = loaded.sources[index]
      if (!existing) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
      if (existing.projectId !== fromProjectId) throw new Error('SERVER_OPS_CONNECTION_PROJECT_CHANGED')
      /** 目标验证必须与写入处于同一配置事务；漏接依赖时禁止盲写。 */
      const resolveProjectId = this.dependencies.resolveProjectId
      if (!resolveProjectId) throw new Error('SERVER_OPS_PROJECT_UNAVAILABLE')
      const resolvedTargetProjectId = resolveProjectId(targetProjectId)
      if (resolvedTargetProjectId === existing.projectId) return cloneSource(existing)
      /** 只有真实跨项目移动才读取时间源并写盘。 */
      const now = this.dependencies.now()
      if (!isValidTimestamp(now)) throw new Error('SERVER_OPS_DATA_SOURCE_TIMESTAMP_INVALID')
      const moved: ServerOpsStoredDataSource = {
        ...existing,
        projectId: resolvedTargetProjectId,
        updatedAt: Math.max(now, existing.updatedAt),
      }
      this.persist(
        loaded.sources.map((source, sourceIndex) => sourceIndex === index ? moved : source),
        loaded.expectedDestination,
        loaded.priorBackup,
      )
      return cloneSource(moved)
    })
  }

  /**
   * 删除单个数据源；目标不存在时幂等返回 false。
   *
   * @param hostId 目标主机 ID
   * @param sourceId 目标数据源 ID
   * @returns 是否实际删除
   */
  remove(sourceId: string): boolean {
    if (!isServerOpsId(sourceId)) throw new Error('SERVER_OPS_DATA_SOURCE_ID_INVALID')
    return this.transaction(() => {
      /** 锁内权威快照。 */
      const loaded = this.readStoredSources()
      if (!loaded.sources.some((source) => source.id === sourceId)) return false
      this.persist(
        loaded.sources.filter((source) => source.id !== sourceId),
        loaded.expectedDestination,
        loaded.priorBackup,
      )
      return true
    })
  }

  /**
   * 删除指定主机的全部数据源，供主机删除与数据根清理复用。
   *
   * @param hostId 目标主机 ID
   * @returns 实际删除条数
   */
  removeByHost(hostId: string): number {
    if (!isServerOpsId(hostId)) throw new Error('SERVER_OPS_DATA_SOURCE_HOST_INVALID')
    return this.transaction(() => {
      /** 锁内权威快照。 */
      const loaded = this.readStoredSources()
      /** 待保留的其它主机数据源。 */
      const remaining = loaded.sources.filter((source) => source.hostId !== hostId)
      /** 本次实际删除条数。 */
      const removed = loaded.sources.length - remaining.length
      if (removed === 0) return 0
      this.persist(remaining, loaded.expectedDestination, loaded.priorBackup)
      return removed
    })
  }

  /** fresh-read 当前数据源文件；已有坏文件不得被当作空列表覆盖。 */
  private readStoredSources(): {
    sources: ServerOpsStoredDataSource[]
    /** 是否存在缺少项目归属、需要立刻回写的条目。 */
    needsMigration: boolean
    expectedDestination: AtomicDestinationExpectation
    priorBackup?: object
  } {
    /** 读取前目标文件是否已存在。 */
    const existed = existsSync(this.filePath)
    const loaded = this.dependencies.readJson(this.filePath, { validate: isDataSourceFileShape })
    /** 提交时必须匹配的目标身份，阻断不协作旧实例的迟到覆盖。 */
    const expectedDestination = this.captureDestinationExpectation()
    if (loaded === null) {
      if (existed) throw new Error('SERVER_OPS_DATA_SOURCE_READ_FAILED')
      return { sources: [], needsMigration: false, expectedDestination }
    }
    /** 严格解析后的数据源记录。 */
    const parsed = parseDataSourceFile(loaded)
    /** 缺少项目归属的数据源数量；直连条目没有主机，只能靠默认项目补。 */
    const missingProject = parsed.sources.filter((source) => source.projectId === undefined).length
    /** 迁移期解析默认项目；未接线时保持原行为。 */
    const defaultProjectId = missingProject > 0 ? this.dependencies.resolveDefaultProjectId?.() : undefined
    return {
      sources: defaultProjectId === undefined
        ? parsed.sources.map(cloneSource)
        : parsed.sources.map((source) => source.projectId === undefined ? { ...source, projectId: defaultProjectId } : source),
      needsMigration: missingProject > 0 && defaultProjectId !== undefined,
      expectedDestination,
      priorBackup: parsed.sources.map(cloneSource),
    }
  }

  /** 使用 safe-file 原子边界持久化完整数据源快照。 */
  private persist(
    sources: readonly ServerOpsStoredDataSource[],
    expectedDestination: AtomicDestinationExpectation,
    priorBackup?: object,
  ): void {
    this.dependencies.writeJson(
      this.filePath,
      { version: SERVER_OPS_DATA_SOURCES_VERSION, sources: sources.map(cloneSource) } satisfies ServerOpsDataSourceFile,
      expectedDestination,
      priorBackup,
    )
  }

  /** 捕获 fresh-read 对应的目标身份。 */
  private captureDestinationExpectation(): AtomicDestinationExpectation {
    const state = readAtomicFileState(this.filePath)
    return state === null ? { kind: 'missing' } : { kind: 'state', state }
  }
}

/** 仅在 safe-file 层做形状判定，完整校验交给 parseDataSourceFile。 */
function isDataSourceFileShape(value: unknown): value is ServerOpsDataSourceFile {
  return isRecord(value) && value.version === SERVER_OPS_DATA_SOURCES_VERSION && Array.isArray(value.sources)
}
