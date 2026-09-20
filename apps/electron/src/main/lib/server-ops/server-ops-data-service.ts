import { createHash } from 'node:crypto'
import type {
  ServerOpsDataDiagnoseInput,
  ServerOpsDataDiagnosticsResult,
  ServerOpsDataProbeResult,
  ServerOpsDataQueryInput,
  ServerOpsDataQueryResult,
  ServerOpsDataSource,
  ServerOpsDataSourceDeleteInput,
  ServerOpsDataSourceListInput,
  ServerOpsDataSourceListResult,
  ServerOpsDataSourcePasswordInput,
  ServerOpsDataSourcePasswordResult,
  ServerOpsDataSourceProbeInput,
  ServerOpsDataSourceProbeDraft,
  ServerOpsDataSourceRowsInput,
  ServerOpsDataSourceRowsResult,
  ServerOpsDataSourceTableInput,
  ServerOpsDataSourceTableResult,
  ServerOpsDataSourceTablesInput,
  ServerOpsDataSourceTablesResult,
  ServerOpsDataSourceUpsertInput,
  ServerOpsDataSourceUpsertResult,
} from '@proma/shared'
import {
  isServerOpsPlaintextDirectAddress,
  parseServerOpsDataDiagnoseInput,
  parseServerOpsDataQueryInput,
  parseServerOpsDataSourceTableInput,
  parseServerOpsDataSourceTableResult,
  parseServerOpsDataSourceTablesInput,
  parseServerOpsDataSourceTablesResult,
} from '@proma/shared'
import type { ServerOpsActiveConnectionIdentity } from './server-ops-connection-service'
import type { ServerOpsDataSourceStore, ServerOpsStoredDataSource } from './server-ops-data-source-store'
import type { ServerOpsDataSourceCredentialStore } from './server-ops-data-credential-store'
import type { ServerOpsConfigTransaction } from './server-ops-config-transaction'
import type {
  ServerOpsDataSchemaCache,
  ServerOpsDataSchemaCacheScope,
  ServerOpsDataSchemaCacheValue,
} from './server-ops-data-schema-cache'
import type {
  ServerOpsRuntimeDataDiagnosticsResult,
  ServerOpsRuntimeDataReadRequest,
  ServerOpsRuntimeDataReadResult,
  ServerOpsRuntimeDataSchemaRowsResult,
  ServerOpsRuntimeDataSchemaTableResult,
  ServerOpsRuntimeDataSchemaTablesResult,
} from '../../../utility/server-ops/server-ops-runtime-protocol'

/** 单次数据库读取的固定超时；与设计文档的 15 秒预算一致。 */
const SERVER_OPS_DATA_READ_TIMEOUT_MS = 15_000
/** 全局同时进行的数据库读取上限；超出时拒绝而不是排队，避免连接堆积。 */
const SERVER_OPS_DATA_MAX_CONCURRENT_READS = 3

/** 数据服务依赖的主机连接能力；只读取当前活跃连接身份。 */
interface ServerOpsDataConnectionContract {
  getActiveIdentity(hostId: string): ServerOpsActiveConnectionIdentity
}

/** 数据服务依赖的 SSH runtime 能力。 */
interface ServerOpsDataRuntimeContract {
  dataRead(input: Omit<ServerOpsRuntimeDataReadRequest, 'requestId'>, signal?: AbortSignal): Promise<ServerOpsRuntimeDataReadResult>
}

/** 数据服务可替换依赖，全部按最小能力注入便于单测。 */
export interface ServerOpsDataServiceDependencies {
  /** 数据源元数据 Store。 */
  store: Pick<ServerOpsDataSourceStore, 'list' | 'getById' | 'create' | 'update' | 'move' | 'remove' | 'removeByHost'>
  /** 数据库密码密文 Store，与 SSH 凭据完全分离。 */
  credentials: Pick<ServerOpsDataSourceCredentialStore, 'setSecret' | 'resolveSecret' | 'removeSecret' | 'removeByHost'>
    & Partial<Pick<ServerOpsDataSourceCredentialStore, 'getSecretVersion'>>
  /** 当前活跃 SSH 连接身份。 */
  connection: ServerOpsDataConnectionContract
  /** 通过 SSH 隧道执行只读读取的 runtime 客户端。 */
  runtime: ServerOpsDataRuntimeContract
  /** 时间源，测试可替换。 */
  now?: () => number
  /** 生成直连读取所需的临时连接身份。 */
  uuid?: () => string
  /** 编辑数据源时覆盖归属预检、密文和元数据写入的同步配置事务。 */
  transaction?: ServerOpsConfigTransaction
  /** 可选的 schema 派生缓存；未注入时所有读取保持实时。 */
  schemaCache?: Pick<ServerOpsDataSchemaCache, 'lookup' | 'setIfRevision' | 'invalidate'>
}

/** 数据服务编排结果：数据源增删改查与只读读取。 */
export class ServerOpsDataService {
  /** 可替换依赖集合。 */
  private readonly dependencies: ServerOpsDataServiceDependencies
  /** 统一时间源。 */
  private readonly now: () => number
  /** 直连读取使用的临时连接 ID 生成器。 */
  private readonly uuid: () => string
  /** 数据源编辑使用的同步配置事务。 */
  private readonly transaction: ServerOpsConfigTransaction
  /** 每个数据源最多一个在途读取。 */
  private readonly activeReads = new Set<string>()
  /** 仅 opt-in 缓存请求使用的同身份同范围在途读取。 */
  private readonly activeSchemaCacheReads = new Map<string, Promise<ServerOpsDataSchemaCacheValue>>()
  /** 缓存异常后本实例 fail closed；服务重建前不再恢复缓存读写。 */
  private schemaCacheDisabled = false
  /** dispose 后进入终态，拒绝新的读取。 */
  private disposed = false

  constructor(dependencies: ServerOpsDataServiceDependencies) {
    this.dependencies = dependencies
    this.now = dependencies.now ?? Date.now
    this.uuid = dependencies.uuid ?? (() => `direct-${Math.random().toString(36).slice(2, 12)}`)
    this.transaction = dependencies.transaction ?? ((callback) => callback())
  }

  /** 把内部记录投影为不含秘密的公开数据源。 */
  private toPublicSource(record: ServerOpsStoredDataSource): ServerOpsDataSource {
    return {
      id: record.id,
      ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
      transport: record.transport,
      ...(record.hostId === undefined ? {} : { hostId: record.hostId }),
      engine: record.engine,
      label: record.label,
      address: record.address,
      port: record.port,
      ...(record.database === undefined ? {} : { database: record.database }),
      ...(record.username === undefined ? {} : { username: record.username }),
      tlsMode: record.tlsMode,
      ...(record.tlsServerName === undefined ? {} : { tlsServerName: record.tlsServerName }),
      /** 只暴露「是否已保存密码」这一位事实。 */
      hasPassword: record.credentialRef !== undefined,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  /**
   * 列出数据源。
   *
   * 数据源是全局条目、不按当前主机过滤；需要时可按项目过滤，
   * 供工作台在项目下展示该项目的连接清单。
   *
   * @param input 可选的项目过滤
   * @returns 数据源公开投影列表
   */
  listSources(input: ServerOpsDataSourceListInput = {}): ServerOpsDataSourceListResult {
    /** 全量记录；过滤只改变投影，不改变归属。 */
    const records = this.dependencies.store.list()
    const visible = input.projectId === undefined
      ? records
      : records.filter((record) => record.projectId === input.projectId)
    return { sources: visible.map((record) => this.toPublicSource(record)) }
  }

  /**
   * 独立移动数据源，并把内部记录收敛成不含凭据引用的公开投影。
   *
   * @param sourceId 待移动数据源 ID
   * @param fromProjectId 调用方看到的原项目
   * @param targetProjectId 目标项目
   * @returns 移动后的权威公开数据源
   */
  moveSource(sourceId: string, fromProjectId: string, targetProjectId: string): ServerOpsDataSource {
    this.assertUsable()
    return this.toPublicSource(this.dependencies.store.move(sourceId, fromProjectId, targetProjectId))
  }

  /**
   * 新建或编辑数据源；密码只在此处写入 `safeStorage` 密文。
   *
   * @param input 已通过共享合同解析的写入输入
   * @returns 公开数据源投影
   */
  upsertSource(input: ServerOpsDataSourceUpsertInput): ServerOpsDataSourceUpsertResult {
    this.assertUsable()
    if (input.sourceId === undefined) {
      /** 新建时先落元数据，再绑定密码密文，避免出现悬空凭据。 */
      const created = this.dependencies.store.create(input)
      if (input.password !== undefined) {
        try {
          /** 新数据源的密码密文引用。 */
          const credentialRef = this.dependencies.credentials.setSecret(created.hostId ?? SERVER_OPS_DATA_DIRECT_CREDENTIAL_SCOPE, created.id, input.password)
          return { source: this.toPublicSource(this.dependencies.store.update(created.id, { credentialRef })) }
        } catch (error) {
          /**
           * 密文写入失败（例如系统安全存储不可用）必须回滚刚落的元数据：
           * 否则界面上会留下一条"没有密码"的数据源，用户以为保存成功、实际连不上。
           */
          this.dependencies.store.remove(created.id)
          throw error
        }
      }
      return { source: this.toPublicSource(created) }
    }
    /** 分支收窄后的稳定数据源 ID，供事务回调复用。 */
    const sourceId = input.sourceId
    return this.transaction(() => {
      /** 锁内读取现有归属，必须在任何凭据副作用前拒绝迁移。 */
      const existing = this.dependencies.store.getById(sourceId)
      if (!existing) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
      if (input.projectId !== undefined && input.projectId !== existing.projectId) {
        throw new Error('SERVER_OPS_DATA_SOURCE_PROJECT_MISMATCH')
      }
      /** 密码变更意图：写入新密文、清除密文或保持原样。 */
      let credentialRef: string | null | undefined
      if (input.password !== undefined) {
        credentialRef = this.dependencies.credentials.setSecret(existing.hostId ?? SERVER_OPS_DATA_DIRECT_CREDENTIAL_SCOPE, sourceId, input.password)
      } else if (input.clearPassword === true) {
        this.dependencies.credentials.removeSecret(sourceId)
        credentialRef = null
      }
      /** 除密码外的元数据变更。 */
      const updated = this.dependencies.store.update(sourceId, {
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        transport: input.transport,
        hostId: input.hostId ?? null,
        label: input.label,
        address: input.address,
        port: input.port,
        database: input.database ?? null,
        username: input.username ?? null,
        tlsMode: input.tlsMode,
        tlsServerName: input.tlsServerName ?? null,
        ...(credentialRef === undefined ? {} : { credentialRef }),
      })
      return { source: this.toPublicSource(updated) }
    })
  }

  /**
   * 删除数据源并连带清理密码密文。
   *
   * @param input 主机与数据源身份
   */
  deleteSource(input: ServerOpsDataSourceDeleteInput): void {
    this.assertUsable()
    const existing = this.dependencies.store.getById(input.sourceId)
    if (!existing) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
    this.dependencies.credentials.removeSecret(input.sourceId)
    this.dependencies.store.remove(input.sourceId)
    this.invalidateSchemaCache({ sourceId: input.sourceId })
  }

  /**
   * 读取已保存的密码明文，供界面上的"显示密码"使用。
   *
   * 与模型配置里"编辑时加载明文 API Key"同一条思路：用户显式要求才返回，
   * 明文只在这一条 IPC 回执里存在，主进程不留任何副本；没有保存密码时返回 null。
   *
   * @param input 目标数据源
   * @returns 明文密码或 null
   */
  revealSourcePassword(input: ServerOpsDataSourcePasswordInput): ServerOpsDataSourcePasswordResult {
    this.assertUsable()
    /** 读取前确认数据源存在，避免把"记录没了"误报成"没保存密码"。 */
    const record = this.requireSource(input.sourceId)
    if (record.credentialRef === undefined) return { password: null }
    /** 解密失败会抛 SERVER_OPS_DATA_CREDENTIAL_CORRUPTED，由界面映射成中文原因。 */
    return { password: this.dependencies.credentials.resolveSecret(record.credentialRef) ?? null }
  }

  /**
   * 测试数据源连通性：既支持已保存的记录，也支持弹窗里的未保存草稿。
   *
   * 草稿测试不落盘任何字段与密码，但必须走同一条 runtime 读取路径，
   * 否则"测试通过、保存后连不上"会变成用户反复踩的坑。
   *
   * @param input 已保存的数据源身份，或一份未保存草稿
   * @returns 连接测试结果
   */
  async probeSource(input: ServerOpsDataSourceProbeInput): Promise<ServerOpsDataProbeResult> {
    if ('draft' in input) return this.probeDraft(input.draft)
    /** 读取前固定数据源身份，避免读取期间被删除后回执出现不一致的引擎字段。 */
    const engine = this.requireSource(input.sourceId).engine
    /** 实际读取结果与耗时。 */
    const { result, latencyMs } = await this.runRead('probe', input.sourceId)
    if (!isDiagnosticsReadResult(result)) throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    return {
      sourceId: input.sourceId,
      engine,
      capability: result.capability,
      ...(result.serverVersion === undefined ? {} : { serverVersion: result.serverVersion }),
      ...(result.capability === 'available' ? { latencyMs } : {}),
      warnings: result.warnings,
    }
  }

  /**
   * 用未保存的表单草稿测试连接；不写元数据、不写密文、不改动信任状态。
   *
   * 密码来源二选一：本次表单里新填的明文，或编辑态复用的已保存密文。
   *
   * @param draft 共享合同已校验的草稿
   * @returns 连接测试结果；不带 `sourceId`
   */
  private async probeDraft(draft: ServerOpsDataSourceProbeDraft): Promise<ServerOpsDataProbeResult> {
    this.assertUsable()
    /** 复用已保存密文时先在锁外解析；缺失或解密失败都按稳定错误码上报。 */
    const saved = draft.savedSourceId === undefined ? undefined : this.dependencies.store.getById(draft.savedSourceId)
    if (draft.savedSourceId !== undefined && !saved) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
    /** 本次测试使用的密码明文，只存在于本次请求内。 */
    const password = draft.password ?? (saved?.credentialRef === undefined
      ? undefined
      : this.dependencies.credentials.resolveSecret(saved.credentialRef))
    /** 草稿在并发与单飞规则上按"复用记录"或"临时目标"分别归属。 */
    const readKey = draft.savedSourceId === undefined ? `draft:${this.uuid()}` : draft.savedSourceId
    /** 草稿与已保存记录共用同一份直连 TLS 硬规则。 */
    this.assertDirectTransportIsSafe(draft)
    const { result, latencyMs } = await this.runReadTarget('probe', {
      transport: draft.transport,
      ...(draft.hostId === undefined ? {} : { hostId: draft.hostId }),
      engine: draft.engine,
      address: draft.address,
      port: draft.port,
      ...(draft.database === undefined ? {} : { database: draft.database }),
      ...(draft.username === undefined ? {} : { username: draft.username }),
      tlsMode: draft.tlsMode,
      ...(draft.tlsServerName === undefined ? {} : { tlsServerName: draft.tlsServerName }),
    }, password, readKey)
    /** 草稿测试与已保存记录一样只接受诊断类回执。 */
    if (!isDiagnosticsReadResult(result)) throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    return {
      engine: draft.engine,
      capability: result.capability,
      ...(result.serverVersion === undefined ? {} : { serverVersion: result.serverVersion }),
      ...(result.capability === 'available' ? { latencyMs } : {}),
      warnings: result.warnings,
    }
  }

  /**
   * 通过当前 SSH 连接读取数据源只读诊断。
   *
   * @param input 主机与数据源身份
   * @returns 结构化只读诊断结果
   */
  async diagnoseSource(input: ServerOpsDataDiagnoseInput): Promise<ServerOpsDataDiagnosticsResult> {
    /** 服务边界同样严格解析，避免内部调用绕过 IPC 合同。 */
    const parsedInput = parseServerOpsDataDiagnoseInput(input)
    /** 读取前固定数据源身份，避免读取期间被删除后回执出现不一致的引擎字段。 */
    const engine = this.requireSource(parsedInput.sourceId).engine
    if (parsedInput.database !== undefined && engine !== 'mysql') throw new Error('SERVER_OPS_DATA_DIAGNOSE_INPUT_INVALID')
    /** 实际读取结果与耗时；诊断不对外暴露时延指标。 */
    const { result } = await this.runRead('diagnostics', parsedInput.sourceId, parsedInput.section, parsedInput.database)
    if (!isDiagnosticsReadResult(result)) throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    return {
      sourceId: parsedInput.sourceId,
      engine,
      capability: result.capability,
      collectedAt: this.now(),
      metrics: result.metrics,
      tables: result.tables,
      ...(result.parameters === undefined ? {} : { parameters: result.parameters }),
      ...(result.parametersTruncated === undefined ? {} : { parametersTruncated: result.parametersTruncated }),
      warnings: result.warnings,
    }
  }

  /**
   * 列出某个数据源可见的库与表清单。
   *
   * 只读；默认取数据源自身配置的库。读取失败时抛出带原因的错误码，
   * 由渲染层把 runtime 给出的中文原因直接展示出来。
   *
   * @param input 数据源与目标库
   * @returns 库清单与目标库的表清单
   */
  async listSchemaTables(input: ServerOpsDataSourceTablesInput): Promise<ServerOpsDataSourceTablesResult> {
    this.assertUsable()
    const parsedInput = parseServerOpsDataSourceTablesInput(input)
    /** 数据源记录；同时用于推导默认库与连接方式。 */
    const record = this.requireSource(parsedInput.sourceId)
    /** 目标库：显式优先，其次数据源配置的库；两者都缺失时只列可见库。 */
    const database = parsedInput.database ?? record.database
    const cache = this.dependencies.schemaCache
    if (parsedInput.cacheMode === undefined || cache === undefined) {
      return this.readSchemaTablesLive(record, parsedInput.database, database)
    }
    const context = this.createSchemaCacheContext(record)
    if (context === undefined) return this.readSchemaTablesLive(record, parsedInput.database, database)
    /** 目录范围按实际请求库隔离；未选库时只缓存可见库目录。 */
    const scope: ServerOpsDataSchemaCacheScope = {
      kind: 'tables', sourceId: record.id, ...(database === undefined ? {} : { database }),
    }
    if (parsedInput.cacheMode === 'refresh') {
      this.invalidateSchemaCache({ sourceId: record.id, ...(parsedInput.database === undefined ? {} : { database: parsedInput.database }) })
    }
    const lookup = this.readSchemaCache(scope, context.identity)
    if (lookup === undefined) return this.readSchemaTablesLive(record, parsedInput.database, database, context.connection)
    if (parsedInput.cacheMode === 'prefer-cache' && lookup.value !== undefined) {
      this.assertSchemaCacheContextCurrent(context)
      return parseServerOpsDataSourceTablesResult(lookup.value)
    }
    return this.coalesceSchemaCacheRead(scope, context.identity, lookup.revision, async () => {
      const result = await this.readSchemaTablesLive(record, parsedInput.database, database, context.connection)
      this.assertSchemaCacheContextCurrent(context)
      this.writeSchemaCache(scope, context.identity, result, lookup.revision)
      return result
    })
  }

  /** 执行一次实时目录读取并投影公开结果。 */
  private async readSchemaTablesLive(
    record: ServerOpsStoredDataSource,
    explicitDatabase: string | undefined,
    database: string | undefined,
    expectedConnection?: ServerOpsActiveConnectionIdentity | null,
  ): Promise<ServerOpsDataSourceTablesResult> {
    /** 已保存密码只在本次请求内解密。 */
    const password = record.credentialRef === undefined ? undefined : this.dependencies.credentials.resolveSecret(record.credentialRef)
    const { result } = await this.runReadTarget(
      'schema-tables', record, password, `${record.id}:schema-tables`, { database }, undefined, undefined, undefined, undefined,
      expectedConnection ?? undefined,
    )
    if (!isSchemaTablesResult(result) || result.capability !== 'available') {
      throw new Error(`SERVER_OPS_DATA_SCHEMA_UNAVAILABLE: ${readSchemaWarning(result)}`)
    }
    /** 显式库必须由 runtime 的参数化查询精确确认，不能用截断目录中的同名项推断。 */
    if (explicitDatabase !== undefined && result.database !== explicitDatabase) {
      throw new Error(`SERVER_OPS_DATA_SCHEMA_UNAVAILABLE: 库 ${explicitDatabase} 不存在或当前账号不可见`)
    }
    /** 默认库同样只信任 runtime 的精确验证回执；不可见时保留目录但不选择其它库。 */
    const visibleDatabase = database !== undefined && result.database === database ? database : undefined
    return {
      databases: result.databases,
      tables: visibleDatabase === undefined ? [] : result.tables,
      ...(visibleDatabase === undefined ? {} : { database: visibleDatabase }),
      ...(result.databasesTruncated === undefined ? {} : { databasesTruncated: result.databasesTruncated }),
      ...(result.tablesTruncated === undefined ? {} : { tablesTruncated: result.tablesTruncated }),
    }
  }

  /**
   * 读取单张表的结构（列 + 索引）。
   *
   * @param input 数据源、库与表
   * @returns 列与索引定义
   */
  async describeSchemaTable(input: ServerOpsDataSourceTableInput): Promise<ServerOpsDataSourceTableResult> {
    this.assertUsable()
    const parsedInput = parseServerOpsDataSourceTableInput(input)
    const record = this.requireSource(parsedInput.sourceId)
    const cache = this.dependencies.schemaCache
    if (parsedInput.cacheMode === undefined || cache === undefined) return this.readSchemaTableLive(record, parsedInput)
    const context = this.createSchemaCacheContext(record)
    if (context === undefined) return this.readSchemaTableLive(record, parsedInput)
    const scope: ServerOpsDataSchemaCacheScope = {
      kind: 'table', sourceId: record.id, database: parsedInput.database, table: parsedInput.table,
    }
    if (parsedInput.cacheMode === 'refresh') {
      this.invalidateSchemaCache({ sourceId: record.id, database: parsedInput.database, table: parsedInput.table })
    }
    const lookup = this.readSchemaCache(scope, context.identity)
    if (lookup === undefined) return this.readSchemaTableLive(record, parsedInput, context.connection)
    if (parsedInput.cacheMode === 'prefer-cache' && lookup.value !== undefined) {
      this.assertSchemaCacheContextCurrent(context)
      return parseServerOpsDataSourceTableResult(lookup.value)
    }
    return this.coalesceSchemaCacheRead(scope, context.identity, lookup.revision, async () => {
      const result = await this.readSchemaTableLive(record, parsedInput, context.connection)
      this.assertSchemaCacheContextCurrent(context)
      this.writeSchemaCache(scope, context.identity, result, lookup.revision)
      return result
    })
  }

  /** 执行一次实时单表结构读取。 */
  private async readSchemaTableLive(
    record: ServerOpsStoredDataSource,
    input: Pick<ServerOpsDataSourceTableInput, 'database' | 'table'>,
    expectedConnection?: ServerOpsActiveConnectionIdentity | null,
  ): Promise<ServerOpsDataSourceTableResult> {
    const password = record.credentialRef === undefined ? undefined : this.dependencies.credentials.resolveSecret(record.credentialRef)
    const { result } = await this.runReadTarget(
      'schema-table', record, password, `${record.id}:schema-table`, { database: input.database, table: input.table },
      undefined, undefined, undefined, undefined, expectedConnection ?? undefined,
    )
    if (!isSchemaTableResult(result) || result.capability !== 'available') {
      throw new Error(`SERVER_OPS_DATA_SCHEMA_UNAVAILABLE: ${readSchemaWarning(result)}`)
    }
    return { columns: result.columns, indexes: result.indexes }
  }

  /**
   * 分页读取表数据预览。
   *
   * @param input 数据源、库、表与分页参数
   * @returns 列名与行数据
   */
  async readSchemaRows(input: ServerOpsDataSourceRowsInput): Promise<ServerOpsDataSourceRowsResult> {
    this.assertUsable()
    const record = this.requireSource(input.sourceId)
    const password = record.credentialRef === undefined ? undefined : this.dependencies.credentials.resolveSecret(record.credentialRef)
    const { result } = await this.runReadTarget('schema-rows', record, password, `${record.id}:schema-rows`, {
      database: input.database,
      table: input.table,
      offset: input.offset,
      limit: input.limit,
    })
    if (!isSchemaRowsResult(result) || result.capability !== 'available') {
      throw new Error(`SERVER_OPS_DATA_SCHEMA_UNAVAILABLE: ${readSchemaWarning(result)}`)
    }
    /** 只有匹配本次分页身份的回执才能交给界面，避免错页数据显示在新页码下。 */
    if (result.offset !== input.offset || result.limit !== input.limit) throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    return {
      columns: result.columns,
      rows: result.rows,
      offset: result.offset,
      limit: result.limit,
      truncated: result.truncated,
      ...(result.hasMore === undefined ? {} : { hasMore: result.hasMore }),
      ...(result.orderedByPrimaryKey === undefined ? {} : { orderedByPrimaryKey: result.orderedByPrimaryKey }),
      ...(result.totalEstimate === undefined ? {} : { totalEstimate: result.totalEstimate }),
    }
  }

  /**
   * 执行单条受控只读 SQL 查询，并在返回前复核连接配置与 SSH 会话身份。
   *
   * @param input 数据源、当前库、查询身份、SQL 与行上限
   * @param signal 页面关闭、Agent 撤权或用户取消时的真实取消信号
   * @returns 已由 utility 完成来源校验、遮罩与预算裁剪的查询结果
   */
  async querySource(input: ServerOpsDataQueryInput, signal?: AbortSignal): Promise<ServerOpsDataQueryResult> {
    this.assertUsable()
    const parsedInput = parseServerOpsDataQueryInput(input)
    /** 查询前固定真实连接配置；label、projectId 与 updatedAt 不属于安全身份。 */
    const expectedSource = this.requireSource(parsedInput.sourceId)
    if (expectedSource.engine !== 'mysql') throw new Error('SERVER_OPS_DATA_QUERY_ENGINE_UNSUPPORTED')
    const expectedConnection = expectedSource.transport === 'ssh'
      ? this.dependencies.connection.getActiveIdentity(expectedSource.hostId ?? '')
      : undefined
    const password = expectedSource.credentialRef === undefined
      ? undefined
      : this.dependencies.credentials.resolveSecret(expectedSource.credentialRef)
    const { result } = await this.runReadTarget(
      'sql-query', expectedSource, password, `${expectedSource.id}:sql-query`, undefined, undefined, undefined,
      { database: parsedInput.database, queryId: parsedInput.queryId, sql: parsedInput.sql, maxRows: parsedInput.maxRows },
      signal, expectedConnection,
    )
    /** 配置变化后旧回执不得回流到新目标；改名与项目移动不影响身份。 */
    const currentSource = this.requireSource(parsedInput.sourceId)
    if (!sameDataReadIdentity(expectedSource, currentSource)) throw new Error('SERVER_OPS_DATA_SOURCE_CHANGED')
    /** 同一 credentialRef 可能原位替换密文，必须重解密比对本次真实认证材料。 */
    const currentPassword = currentSource.credentialRef === undefined
      ? undefined
      : this.dependencies.credentials.resolveSecret(currentSource.credentialRef)
    if (currentPassword !== password) throw new Error('SERVER_OPS_DATA_SOURCE_CHANGED')
    if (expectedConnection !== undefined) {
      let currentConnection: ServerOpsActiveConnectionIdentity
      try {
        currentConnection = this.dependencies.connection.getActiveIdentity(expectedConnection.hostId)
      } catch {
        throw new Error('SERVER_OPS_DATA_SOURCE_CHANGED')
      }
      if (currentConnection.connectionId !== expectedConnection.connectionId
        || currentConnection.generation !== expectedConnection.generation) throw new Error('SERVER_OPS_DATA_SOURCE_CHANGED')
    }
    if (!isQueryReadResult(result)
      || result.queryId !== parsedInput.queryId
      || result.database !== parsedInput.database) throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    return result
  }

  /** 主机删除或退出清理时丢弃该主机全部在途读取归属。 */
  forgetHost(hostId: string): void {
    for (const key of this.activeReads) {
      if (key.startsWith(`${hostId}\u0000`)) this.activeReads.delete(key)
    }
  }

  /**
   * 删除主机时清理其全部数据源与密码密文。
   *
   * @param hostId 已删除的主机 ID
   */
  removeHost(hostId: string): void {
    this.forgetHost(hostId)
    this.dependencies.credentials.removeByHost(hostId)
    this.dependencies.store.removeByHost(hostId)
  }

  /** 进入终态并清空在途读取标记。 */
  dispose(): void {
    this.disposed = true
    this.activeReads.clear()
    this.activeSchemaCacheReads.clear()
  }

  /** 构造不含明文秘密的完整缓存身份；无法证明密文版本时禁用缓存。 */
  private createSchemaCacheContext(record: ServerOpsStoredDataSource): ServerOpsDataSchemaCacheContext | undefined {
    /** 没有凭据用 null 明确参与身份；有凭据则必须能取得当前密文版本。 */
    let credentialVersion: string | null
    if (record.credentialRef === undefined) {
      credentialVersion = null
    } else {
      const resolvedVersion = this.dependencies.credentials.getSecretVersion?.(record.credentialRef)
      if (resolvedVersion === undefined) return undefined
      credentialVersion = resolvedVersion
    }
    const connection = record.transport === 'ssh'
      ? this.dependencies.connection.getActiveIdentity(record.hostId ?? '')
      : null
    const identity = createHash('sha256').update(JSON.stringify({
      source: {
        id: record.id,
        transport: record.transport,
        hostId: record.hostId ?? null,
        engine: record.engine,
        address: record.address,
        port: record.port,
        database: record.database ?? null,
        username: record.username ?? null,
        tlsMode: record.tlsMode,
        tlsServerName: record.tlsServerName ?? null,
        credentialVersion,
      },
      connection: connection === null ? null : {
        hostId: connection.hostId,
        connectionId: connection.connectionId,
        generation: connection.generation,
      },
    })).digest('hex')
    return { source: { ...record }, credentialVersion, connection, identity }
  }

  /** 返回前重新核对数据源、密文版本与 SSH 活跃连接代次。 */
  private assertSchemaCacheContextCurrent(expected: ServerOpsDataSchemaCacheContext): void {
    this.assertUsable()
    const current = this.requireSource(expected.source.id)
    if (!sameDataReadIdentity(expected.source, current)) throw new Error('SERVER_OPS_DATA_SOURCE_CHANGED')
    const currentCredentialVersion = current.credentialRef === undefined
      ? null
      : this.dependencies.credentials.getSecretVersion?.(current.credentialRef)
    if (currentCredentialVersion !== expected.credentialVersion) throw new Error('SERVER_OPS_DATA_SOURCE_CHANGED')
    if (expected.connection === null) return
    let currentConnection: ServerOpsActiveConnectionIdentity
    try {
      currentConnection = this.dependencies.connection.getActiveIdentity(expected.connection.hostId)
    } catch {
      throw new Error('SERVER_OPS_DATA_SOURCE_CHANGED')
    }
    if (currentConnection.connectionId !== expected.connection.connectionId
      || currentConnection.generation !== expected.connection.generation) throw new Error('SERVER_OPS_DATA_SOURCE_CHANGED')
  }

  /** 缓存读取失败降级为 miss，避免派生数据阻断实时读取。 */
  private readSchemaCache(
    scope: ServerOpsDataSchemaCacheScope,
    identity: string,
  ): { revision: number; value?: ServerOpsDataSchemaCacheValue } | undefined {
    if (this.schemaCacheDisabled) return undefined
    try {
      return this.dependencies.schemaCache?.lookup(scope, identity)
    } catch {
      this.schemaCacheDisabled = true
      return undefined
    }
  }

  /** 缓存写入失败只丢缓存，不改变已经成功的实时读取。 */
  private writeSchemaCache(
    scope: ServerOpsDataSchemaCacheScope,
    identity: string,
    value: ServerOpsDataSchemaCacheValue,
    expectedRevision: number,
  ): void {
    if (this.schemaCacheDisabled) return
    try {
      this.dependencies.schemaCache?.setIfRevision(scope, identity, value, expectedRevision)
    } catch {
      /** 原文件可能仍含旧值，服务重建前禁用本实例缓存。 */
      this.schemaCacheDisabled = true
    }
  }

  /** 缓存失效失败同样降级；后续完整身份仍会阻止旧缓存串用。 */
  private invalidateSchemaCache(scope: { sourceId: string; database?: string; table?: string }): void {
    try {
      this.dependencies.schemaCache?.invalidate(scope)
    } catch {
      /** 失效未提交时旧字段仍可能在磁盘，本实例余下生命周期必须绕过缓存。 */
      this.schemaCacheDisabled = true
    }
  }

  /** 合并同一完整身份与范围的 opt-in 实时读取。 */
  private coalesceSchemaCacheRead<T extends ServerOpsDataSchemaCacheValue>(
    scope: ServerOpsDataSchemaCacheScope,
    identity: string,
    revision: number,
    read: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([
      scope.kind, scope.sourceId, scope.database ?? null, scope.kind === 'table' ? scope.table : null, identity, revision,
    ])
    const existing = this.activeSchemaCacheReads.get(key)
    if (existing !== undefined) return existing as Promise<T>
    const pending = read()
    this.activeSchemaCacheReads.set(key, pending)
    void pending.finally(() => {
      if (this.activeSchemaCacheReads.get(key) === pending) this.activeSchemaCacheReads.delete(key)
    }).catch(() => undefined)
    return pending
  }

  /** 读取数据源内部记录，缺失时抛出稳定错误码。 */
  private requireSource(sourceId: string): ServerOpsStoredDataSource {
    const record = this.dependencies.store.getById(sourceId)
    if (!record) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
    return record
  }

  /** 拒绝进入终态或未初始化后的新操作。 */
  private assertUsable(): void {
    if (this.disposed) throw new Error('SERVER_OPS_DATA_UNAVAILABLE')
  }

  /**
   * 执行一次受控只读读取，并维护单飞与全局并发上限。
   *
   * @param mode 连接测试或只读诊断
   * @param hostId 目标主机
   * @param sourceId 目标数据源
   * @returns runtime 结果与主进程侧往返耗时
   */
  private async runRead(
    mode: 'probe' | 'diagnostics',
    sourceId: string,
    diagnosticSection?: import('@proma/shared').ServerOpsDataDiagnosticSection,
    diagnosticDatabase?: string,
  ): Promise<{ result: ServerOpsRuntimeDataReadResult; latencyMs: number }> {
    this.assertUsable()
    /** 数据源身份必须在读取前存在。 */
    const record = this.requireSource(sourceId)
    /** 已保存密码只在本次请求内解密。 */
    const password = record.credentialRef === undefined ? undefined : this.dependencies.credentials.resolveSecret(record.credentialRef)
    /** JSON 元组避免合法库名中的分隔符造成单飞键碰撞。 */
    const readKey = diagnosticSection === undefined
      ? sourceId
      : JSON.stringify([sourceId, 'diagnostics', diagnosticSection, diagnosticDatabase ?? null])
    return this.runReadTarget(mode, record, password, readKey, undefined, diagnosticSection, diagnosticDatabase)
  }

  /**
   * 用一份连接目标执行受控只读读取。
   *
   * 已保存记录与未保存草稿共用这里，保证单飞、全局并发上限、直连 TLS 硬规则
   * 与 runtime 请求形状只有一份实现。
   *
   * @param mode 连接测试或只读诊断
   * @param target 连接目标字段
   * @param password 本次读取使用的密码明文；没有密码时为 undefined
   * @param readKey 单飞与并发计数使用的稳定键
   * @returns runtime 结果与主进程侧往返耗时
   */
  private async runReadTarget(
    mode: 'probe' | 'diagnostics' | 'schema-tables' | 'schema-table' | 'schema-rows' | 'sql-query',
    target: ServerOpsDataReadTarget,
    password: string | undefined,
    readKey: string,
    /** 表浏览参数；诊断模式下必须为空，由 runtime 协议再校验一次。 */
    schema?: { database?: string; table?: string; offset?: number; limit?: number },
    diagnosticSection?: import('@proma/shared').ServerOpsDataDiagnosticSection,
    diagnosticDatabase?: string,
    query?: { database: string; queryId: string; sql: string; maxRows: number },
    signal?: AbortSignal,
    expectedConnection?: ServerOpsActiveConnectionIdentity,
  ): Promise<{ result: ServerOpsRuntimeDataReadResult; latencyMs: number }> {
    this.assertUsable()
    /** 同一数据源的在途读取标记。 */
    if (this.activeReads.has(readKey)) throw new Error('SERVER_OPS_DATA_SOURCE_BUSY')
    if (this.activeReads.size >= SERVER_OPS_DATA_MAX_CONCURRENT_READS) throw new Error('SERVER_OPS_DATA_BUSY')
    /** 只有经由 SSH 的数据源才要求活跃连接；直连不依赖任何主机。 */
    const identity = target.transport === 'ssh'
      ? expectedConnection ?? this.dependencies.connection.getActiveIdentity(target.hostId ?? '')
      : null
    this.assertDirectTransportIsSafe(target)
    this.activeReads.add(readKey)
    /** 主进程侧往返耗时起点。 */
    const startedAt = this.now()
    try {
      const result = await this.dependencies.runtime.dataRead({
        hostId: identity?.hostId ?? SERVER_OPS_DATA_DIRECT_HOST_ID,
        connectionId: identity?.connectionId ?? this.uuid(),
        transport: target.transport,
        mode,
        engine: target.engine,
        address: target.address,
        port: target.port,
        ...((query?.database ?? target.database) === undefined ? {} : { database: query?.database ?? target.database }),
        ...(target.username === undefined ? {} : { username: target.username }),
        ...(password === undefined ? {} : { password }),
        tlsMode: target.tlsMode,
        ...(target.tlsServerName === undefined ? {} : { tlsServerName: target.tlsServerName }),
        timeoutMs: SERVER_OPS_DATA_READ_TIMEOUT_MS,
        ...(diagnosticSection === undefined ? {} : { diagnosticSection }),
        ...(diagnosticDatabase === undefined ? {} : { diagnosticDatabase }),
        ...(schema === undefined ? {} : {
          ...(schema.database === undefined ? {} : { schemaDatabase: schema.database }),
          ...(schema.table === undefined ? {} : { schemaTable: schema.table }),
          ...(schema.offset === undefined ? {} : { rowOffset: schema.offset }),
          ...(schema.limit === undefined ? {} : { rowLimit: schema.limit }),
        }),
        ...(query === undefined ? {} : { queryId: query.queryId, sql: query.sql, maxRows: query.maxRows }),
      }, signal)
      return { result, latencyMs: Math.max(0, this.now() - startedAt) }
    } finally {
      this.activeReads.delete(readKey)
    }
  }

  /**
   * 直连只允许对回环与私有网段关闭 TLS。
   *
   * 经由 SSH 时链路本身已加密，关掉数据库 TLS 尚可接受；从本机直连公网数据库时
   * 明文链路等于把密码和数据暴露在网络上，因此保留强制 TLS。判据与界面标注共用
   * `isServerOpsPlaintextDirectAddress()`，避免"界面说可以、主进程说不行"。
   */
  private assertDirectTransportIsSafe(target: ServerOpsDataReadTarget): void {
    if (target.transport !== 'direct' || target.tlsMode === 'verify') return
    if (isServerOpsPlaintextDirectAddress(target.address)) return
    throw new Error('SERVER_OPS_DATA_TLS_REQUIRED')
  }
}

/** 一次 opt-in 缓存读取固定的完整安全身份。 */
interface ServerOpsDataSchemaCacheContext {
  source: ServerOpsStoredDataSource
  credentialVersion: string | null
  connection: ServerOpsActiveConnectionIdentity | null
  identity: string
}

/** 一次只读读取所需的连接目标字段；已保存记录与未保存草稿都满足它。 */
type ServerOpsDataReadTarget = Pick<
  ServerOpsStoredDataSource,
  'transport' | 'hostId' | 'engine' | 'address' | 'port' | 'database' | 'username' | 'tlsMode' | 'tlsServerName'
>

/**
 * 判断 runtime 回执是否是诊断类结果（连接测试 / 只读诊断）。
 *
 * 表浏览结果带 `mode` 字段，两者共用同一条 `data-read` 通道，
 * 因此服务层必须显式收窄，避免把行数据当成指标读出。
 */
function isDiagnosticsReadResult(result: ServerOpsRuntimeDataReadResult): result is ServerOpsRuntimeDataDiagnosticsResult {
  return !('mode' in result) && !('queryId' in result)
}

/** 收窄到 SQL 查询回执，避免与同样没有 mode 的诊断结果混淆。 */
function isQueryReadResult(result: ServerOpsRuntimeDataReadResult): result is ServerOpsDataQueryResult {
  return 'queryId' in result
}

/**
 * 比较影响数据库安全身份的字段。
 *
 * 展示名称、项目归属与更新时间不参与；这些变化不会改变真实目标或凭据。
 */
function sameDataReadIdentity(left: ServerOpsStoredDataSource, right: ServerOpsStoredDataSource): boolean {
  return left.id === right.id
    && left.transport === right.transport
    && left.hostId === right.hostId
    && left.engine === right.engine
    && left.address === right.address
    && left.port === right.port
    && left.database === right.database
    && left.username === right.username
    && left.tlsMode === right.tlsMode
    && left.tlsServerName === right.tlsServerName
    && left.credentialRef === right.credentialRef
}

/** 收窄到表清单回执。 */
function isSchemaTablesResult(result: ServerOpsRuntimeDataReadResult): result is ServerOpsRuntimeDataSchemaTablesResult {
  return 'mode' in result && result.mode === 'schema-tables'
}

/** 收窄到单表结构回执。 */
function isSchemaTableResult(result: ServerOpsRuntimeDataReadResult): result is ServerOpsRuntimeDataSchemaTableResult {
  return 'mode' in result && result.mode === 'schema-table'
}

/** 收窄到行预览回执。 */
function isSchemaRowsResult(result: ServerOpsRuntimeDataReadResult): result is ServerOpsRuntimeDataSchemaRowsResult {
  return 'mode' in result && result.mode === 'schema-rows'
}

/**
 * 取出表浏览失败时最值得展示的一条原因。
 *
 * runtime 的 warnings 已经是中文可读文案（例如 `认证失败（ER_ACCESS_DENIED_ERROR）`），
 * 直接透出比让界面再翻译一层更有用；没有任何 warning 时给一个稳定兜底。
 *
 * @param result runtime 回执
 * @returns 面向用户的原因文本
 */
function readSchemaWarning(result: { warnings?: readonly string[] }): string {
  return result.warnings?.[0] ?? '读取失败，请检查连接与账号权限'
}

/** 直连读写在 runtime 协议中使用的稳定主机占位身份。 */
const SERVER_OPS_DATA_DIRECT_HOST_ID = 'server-ops-local-direct'

/** 直连数据源的密码密文作用域；不绑定任何主机。 */
const SERVER_OPS_DATA_DIRECT_CREDENTIAL_SCOPE = 'server-ops-direct'
