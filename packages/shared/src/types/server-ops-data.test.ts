import { describe, expect, test } from 'bun:test'
import {
  isServerOpsSqliteFilePath,
  isServerOpsPlaintextDirectAddress,
  isServerOpsDataTlsMode,
  isServerOpsDataTlsStatus,
  isServerOpsMySqlTlsServerName,
  parseServerOpsDataDiagnoseInput,
  parseServerOpsDataDiagnosticsResult,
  parseServerOpsDataMetric,
  parseServerOpsDataMetricList,
  parseServerOpsDataProbeResult,
  parseServerOpsDataSource,
  parseServerOpsDataSourceDeleteInput,
  parseServerOpsDataSourceListInput,
  parseServerOpsDataSourceListResult,
  parseServerOpsDataSourcePasswordInput,
  parseServerOpsDataSourcePasswordResult,
  parseServerOpsDataSourceProbeInput,
  parseServerOpsDataSourceSetDefaultDatabaseInput,
  parseServerOpsDataSourceUpsertInput,
  parseServerOpsDataSourceUpsertResult,
  parseServerOpsDataTable,
  parseServerOpsDataTableList,
} from './server-ops-data'
import { isServerOpsSqliteFilePath as exportedSqliteFilePathGuard } from '../index'

/** 公开数据源测试样本，已保存密码但绝不携带明文。 */
const source = {
  id: 'source-1',
  transport: 'ssh' as const,
  hostId: 'host-1',
  engine: 'redis' as const,
  label: '会话缓存',
  address: '127.0.0.1',
  port: 6379,
  database: '0',
  tlsMode: 'disabled' as const,
  hasPassword: true,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

/** 公开指标卡样本。 */
const metric = { id: 'used-memory', label: '已用内存', value: '128.0 MiB', hint: '上限使用率 12.5%', ratio: 0.125 }
/** 公开表格样本。 */
const table = {
  id: 'keyspaces',
  title: 'Keyspace',
  columns: [{ id: 'database', label: '逻辑库' }, { id: 'keys', label: '键数', align: 'right' as const }],
  rows: [['db0', '12']],
  truncated: false,
  emptyText: '当前没有非空逻辑库',
}

describe('服务器运维数据服务公开合同', () => {
  test('Given SQL 数据源完整快照 When 设置默认数据库 Then 严格校验引擎、字段与数据库名', () => {
    const mysqlSource = {
      ...source, engine: 'mysql' as const, port: 3306, database: 'old_db', tlsMode: 'disabled' as const,
    }
    const postgresqlSource = {
      ...source, engine: 'postgresql' as const, port: 5432, database: 'postgres', tlsMode: 'required' as const,
    }
    expect(parseServerOpsDataSourceSetDefaultDatabaseInput({ source: mysqlSource, database: 'next_db' }))
      .toEqual({ source: mysqlSource, database: 'next_db' })
    expect(parseServerOpsDataSourceSetDefaultDatabaseInput({ source: postgresqlSource, database: '测'.repeat(21) }))
      .toEqual({ source: postgresqlSource, database: '测'.repeat(21) })
    for (const input of [
      { source, database: '1' },
      { source: { ...source, engine: 'sqlite', database: 'main' }, database: 'main' },
      { source: { id: 'source-1', engine: 'mysql' }, database: 'app' },
      { source: mysqlSource, database: 'app', extra: true },
      { source: mysqlSource, database: '' },
      { source: mysqlSource, database: 'app\ndb' },
      { source: mysqlSource, database: 'x'.repeat(65) },
      { source: postgresqlSource },
      { source: postgresqlSource, database: '测'.repeat(22) },
    ]) expect(() => parseServerOpsDataSourceSetDefaultDatabaseInput(input))
      .toThrow('SERVER_OPS_DATA_SOURCE_SET_DEFAULT_DATABASE_INPUT_INVALID')
  })

  test('Given PostgreSQL 数据源 When 解析连接合同 Then 支持三种显式 TLS 并拒绝 preferred', () => {
    const postgresql = {
      transport: 'direct' as const, engine: 'postgresql' as const, label: '分析库', address: 'db.internal',
      port: 5432, database: 'postgres', username: 'analyst', tlsMode: 'required' as const,
    }
    const postgresqlDraft = {
      transport: postgresql.transport, engine: postgresql.engine, address: postgresql.address,
      port: postgresql.port, database: postgresql.database, username: postgresql.username, tlsMode: postgresql.tlsMode,
    }
    expect(parseServerOpsDataSourceUpsertInput(postgresql)).toEqual(postgresql)
    expect(parseServerOpsDataSourceProbeInput({ draft: postgresqlDraft })).toEqual({ draft: postgresqlDraft })
    expect(() => parseServerOpsDataSourceUpsertInput({ ...postgresql, tlsMode: 'preferred' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
    expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...postgresqlDraft, tlsMode: 'preferred' } }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')
    expect(() => parseServerOpsDataSourceUpsertInput({ ...postgresql, database: '测'.repeat(22) }))
      .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
    for (const tlsServerName of ['db.example.com', 'PG-01.internal']) {
      expect(parseServerOpsDataSourceUpsertInput({ ...postgresql, tlsMode: 'verify', tlsServerName }).tlsServerName)
        .toBe(tlsServerName)
      expect(parseServerOpsDataSourceProbeInput({ draft: { ...postgresqlDraft, tlsMode: 'verify', tlsServerName } }))
        .toMatchObject({ draft: { tlsServerName } })
    }
    for (const tlsServerName of ['127.0.0.1', '::1', '[::1]', 'db.example.com:5432']) {
      expect(() => parseServerOpsDataSourceUpsertInput({ ...postgresql, tlsMode: 'verify', tlsServerName }))
        .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
      expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...postgresqlDraft, tlsMode: 'verify', tlsServerName } }))
        .toThrow('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')
    }
  })
  test('Given SQLite 远端文件 When 解析公开投影 Then 固定 SSH、main 与无凭据合同', () => {
    /** 合法 SQLite 公开投影允许空格和引号，并把省略的数据库归一为 main。 */
    const sqliteSource = {
      id: 'source-sqlite', transport: 'ssh' as const, hostId: 'host-1', engine: 'sqlite' as const,
      label: '业务归档', filePath: '/srv/data/app "archive".db', tlsMode: 'disabled' as const,
      hasPassword: false, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
    }
    expect(parseServerOpsDataSource(sqliteSource)).toEqual({ ...sqliteSource, database: 'main' })
    expect(parseServerOpsDataSource({ ...sqliteSource, database: 'main' }).database).toBe('main')
    expect(isServerOpsSqliteFilePath("/srv/data/it's ready.db")).toBe(true)
    expect(exportedSqliteFilePathGuard('/srv/data/app.db')).toBe(true)
  })

  test('Given SQLite 文件路径或网络字段越界 When 解析 Then fail closed', () => {
    /** SQLite 的文件身份只接受有界 POSIX 绝对路径，拒绝 URI、内存库、相对路径与控制字符。 */
    for (const filePath of ['', 'app.db', ':memory:', 'file:/srv/app.db', 'FILE:/srv/app.db', '/srv/app\n.db', `/${'x'.repeat(4096)}`]) {
      expect(isServerOpsSqliteFilePath(filePath)).toBe(false)
    }
    /** SQLite 公开投影不得夹带网络端点、凭据或 TLS 参数。 */
    const base = {
      id: 'source-sqlite', transport: 'ssh' as const, hostId: 'host-1', engine: 'sqlite' as const,
      label: '业务归档', filePath: '/srv/data/app.db', tlsMode: 'disabled' as const,
      hasPassword: false, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
    }
    for (const extra of [
      { address: '127.0.0.1' }, { port: 3306 }, { username: 'root' }, { tlsServerName: 'db.internal' },
      { address: undefined }, { database: 'other' }, { transport: 'direct' }, { hasPassword: true },
    ]) expect(() => parseServerOpsDataSource({ ...base, ...extra })).toThrow('SERVER_OPS_DATA_SOURCE_INVALID')
    for (const tlsMode of ['preferred', 'required', 'verify']) {
      expect(() => parseServerOpsDataSource({ ...base, tlsMode })).toThrow('SERVER_OPS_DATA_SOURCE_INVALID')
    }
  })

  test('Given SQLite 写入与探测草稿 When 解析 Then 仅接受远端文件参数并归一 main', () => {
    /** 合法 SQLite 写入与探测草稿共用相同端点约束。 */
    const sqliteUpsert = {
      transport: 'ssh' as const, hostId: 'host-1', engine: 'sqlite' as const,
      label: '业务归档', filePath: '/srv/data/app.db', tlsMode: 'disabled' as const,
    }
    expect(parseServerOpsDataSourceUpsertInput(sqliteUpsert)).toEqual({ ...sqliteUpsert, database: 'main' })
    /** 探测草稿没有 label，但同样归一到 main。 */
    const sqliteDraft = {
      transport: 'ssh' as const, hostId: 'host-1', engine: 'sqlite' as const,
      filePath: '/srv/data/app.db', tlsMode: 'disabled' as const,
    }
    expect(parseServerOpsDataSourceProbeInput({ draft: sqliteDraft })).toEqual({
      draft: { ...sqliteDraft, database: 'main' },
    })
    for (const extra of [
      { address: 'localhost' }, { port: 0 }, { username: 'root' }, { password: 'secret' },
      { clearPassword: true }, { clearPassword: undefined }, { tlsServerName: 'db.internal' }, { database: 'other' }, { transport: 'direct' },
    ]) expect(() => parseServerOpsDataSourceUpsertInput({ ...sqliteUpsert, ...extra }))
      .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
    for (const tlsMode of ['preferred', 'required', 'verify']) {
      expect(() => parseServerOpsDataSourceUpsertInput({ ...sqliteUpsert, tlsMode }))
        .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
      expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...sqliteDraft, tlsMode } }))
        .toThrow('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')
    }
    for (const extra of [
      { address: 'localhost' }, { port: 3306 }, { username: 'root' }, { password: 'secret' },
      { savedSourceId: 'source-1' }, { savedSourceId: undefined }, { tlsServerName: 'db.internal' }, { database: 'other' }, { transport: 'direct' },
    ]) expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...sqliteDraft, ...extra } }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')
  })

  test('Given 网络引擎 When 夹带 SQLite 文件路径 Then 保持旧端点必填并拒绝混用', () => {
    /** 网络引擎必须继续提供地址和端口。 */
    const mysql = { transport: 'direct' as const, engine: 'mysql' as const, label: '主库', tlsMode: 'disabled' as const }
    expect(() => parseServerOpsDataSourceUpsertInput(mysql)).toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
    expect(() => parseServerOpsDataSourceUpsertInput({ ...mysql, address: '127.0.0.1', port: 3306, filePath: '/srv/app.db' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
    expect(() => parseServerOpsDataSourceUpsertInput({ ...mysql, address: '127.0.0.1', port: 3306, filePath: undefined }))
      .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
  })

  test('Given 合法数据源 When 投影解析 Then 深复制且不携带凭据引用', () => {
    const parsed = parseServerOpsDataSource(source)
    expect(parsed).toEqual(source)
    expect(parsed).not.toHaveProperty('credentialRef')
    expect(parseServerOpsDataSourceListResult({ sources: [source] })).toEqual({ sources: [source] })
    expect(parseServerOpsDataSourceUpsertResult({ source })).toEqual({ source })
  })

  test('Given 数据源列表与回执 When 解析 Then 只接受当前合同的字段集合', () => {
    expect(parseServerOpsDataSourceListResult({ sources: [source] })).toEqual({ sources: [source] })
    expect(parseServerOpsDataSourceUpsertResult({ source })).toEqual({ source })
    /** 旧版按主机分组的列表结果不再被接受。 */
    expect(() => parseServerOpsDataSourceListResult({ hostId: 'host-1', sources: [source] }))
      .toThrow('SERVER_OPS_DATA_SOURCE_LIST_RESULT_INVALID')
    expect(() => parseServerOpsDataSourceUpsertResult({ hostId: 'host-1', source }))
      .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_RESULT_INVALID')
  })

  test('Given TLS 校验模式 When 缺少证书主机名 Then fail closed', () => {
    expect(() => parseServerOpsDataSource({ ...source, tlsMode: 'verify' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_INVALID')
    expect(parseServerOpsDataSource({ ...source, tlsMode: 'verify', tlsServerName: 'redis.internal' }).tlsServerName)
      .toBe('redis.internal')
  })

  test('Given MySQL verify 主机名 When 新操作解析 Then 接受 DNS 且拒绝 IP，但旧来源仍可读取', () => {
    const mysql = { ...source, engine: 'mysql' as const, tlsMode: 'verify' as const }
    const upsert = { transport: 'ssh' as const, hostId: 'host-1', engine: 'mysql' as const,
      label: '主库', address: '127.0.0.1', port: 3306, tlsMode: 'verify' as const }
    const draft = { transport: 'ssh' as const, hostId: 'host-1', engine: 'mysql' as const,
      address: '127.0.0.1', port: 3306, tlsMode: 'verify' as const }
    for (const name of ['localhost', 'db.example.com', 'DB-01.internal']) {
      expect(isServerOpsMySqlTlsServerName(name)).toBe(true)
      expect(parseServerOpsDataSourceUpsertInput({ ...upsert, tlsServerName: name }).tlsServerName).toBe(name)
      expect(parseServerOpsDataSourceProbeInput({ draft: { ...draft, tlsServerName: name } }))
        .toMatchObject({ draft: { tlsServerName: name } })
    }
    for (const name of ['127.0.0.1', '001.002.003.004', '::1', '[::1]', 'db.example.com:3306',
      'db..example', '-db.example', 'db-.example', 'db.example.', '1234']) {
      expect(isServerOpsMySqlTlsServerName(name)).toBe(false)
      expect(() => parseServerOpsDataSourceUpsertInput({ ...upsert, tlsServerName: name }))
        .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
      expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...draft, tlsServerName: name } }))
        .toThrow('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')
    }
    /** 历史 IP 校验配置需要保留可读投影，供界面打开后纠正。 */
    expect(parseServerOpsDataSource({ ...mysql, tlsServerName: '127.0.0.1' }).tlsServerName).toBe('127.0.0.1')
  })

  test('Given 网络数据库 TLS 模式 When 解析来源、写入和测试草稿 Then MySQL 支持协商而 Redis 不允许降级', () => {
    const mysql = { ...source, engine: 'mysql' as const }
    expect(isServerOpsDataTlsMode('preferred')).toBe(true)
    expect(isServerOpsDataTlsMode('required')).toBe(true)
    for (const mode of ['preferred', 'required'] as const) {
      expect(parseServerOpsDataSource({ ...mysql, tlsMode: mode }).tlsMode).toBe(mode)
      expect(parseServerOpsDataSourceUpsertInput({ transport: 'ssh', hostId: 'host-1', engine: 'mysql',
        label: '主库', address: '127.0.0.1', port: 3306, tlsMode: mode })).toMatchObject({ tlsMode: mode })
      expect(parseServerOpsDataSourceProbeInput({ draft: {
        transport: 'ssh', hostId: 'host-1', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: mode,
      } })).toMatchObject({ draft: { tlsMode: mode } })
    }
    expect(parseServerOpsDataSource({ ...source, tlsMode: 'required' }).tlsMode).toBe('required')
    for (const parse of [
      () => parseServerOpsDataSource({ ...source, tlsMode: 'preferred' }),
      () => parseServerOpsDataSourceUpsertInput({ transport: 'ssh', hostId: 'host-1', engine: 'redis',
        label: '缓存', address: '127.0.0.1', port: 6379, tlsMode: 'preferred' }),
      () => parseServerOpsDataSourceProbeInput({ draft: { transport: 'ssh', hostId: 'host-1', engine: 'redis',
        address: '127.0.0.1', port: 6379, tlsMode: 'preferred' } }),
    ]) expect(parse).toThrow()
  })

  test('Given 成功连接的 TLS 实际状态 When 解析测试及诊断回执 Then 保留状态且拒绝失败或 SQLite 声称加密', () => {
    expect(isServerOpsDataTlsStatus('verified')).toBe(true)
    const probe = { engine: 'mysql', capability: 'available', serverVersion: '8.0.36', warnings: [] }
    const diagnostics = { sourceId: 'source-1', engine: 'redis', capability: 'available',
      collectedAt: 1_700_000_000_000, metrics: [], tables: [], warnings: [] }
    for (const tlsStatus of ['plaintext', 'encrypted', 'verified'] as const) {
      expect(parseServerOpsDataProbeResult({ ...probe, tlsStatus }).tlsStatus).toBe(tlsStatus)
      expect(parseServerOpsDataDiagnosticsResult({ ...diagnostics, tlsStatus }).tlsStatus).toBe(tlsStatus)
    }
    expect(() => parseServerOpsDataProbeResult({ ...probe, tlsStatus: 'unknown' })).toThrow('SERVER_OPS_DATA_PROBE_RESULT_INVALID')
    expect(() => parseServerOpsDataProbeResult({ ...probe, capability: 'tls-failed', serverVersion: undefined,
      tlsStatus: 'plaintext' })).toThrow('SERVER_OPS_DATA_PROBE_RESULT_INVALID')
    expect(() => parseServerOpsDataDiagnosticsResult({ ...diagnostics, capability: 'timeout',
      tlsStatus: 'encrypted' })).toThrow('SERVER_OPS_DATA_DIAGNOSTICS_RESULT_INVALID')
    expect(() => parseServerOpsDataProbeResult({ ...probe, engine: 'sqlite', tlsStatus: 'verified' }))
      .toThrow('SERVER_OPS_DATA_PROBE_RESULT_INVALID')
    expect(() => parseServerOpsDataDiagnosticsResult({ ...diagnostics, engine: 'sqlite', tlsStatus: 'plaintext' }))
      .toThrow('SERVER_OPS_DATA_DIAGNOSTICS_RESULT_INVALID')
  })

  test('Given 未知字段或越界字段 When 解析数据源 Then 拒绝', () => {
    expect(() => parseServerOpsDataSource({ ...source, credentialRef: 'ref-1' })).toThrow('SERVER_OPS_DATA_SOURCE_INVALID')
    expect(() => parseServerOpsDataSource({ ...source, port: 0 })).toThrow('SERVER_OPS_DATA_SOURCE_INVALID')
    expect(() => parseServerOpsDataSource({ ...source, address: '127.0.0.1 5432' })).toThrow('SERVER_OPS_DATA_SOURCE_INVALID')
    expect(() => parseServerOpsDataSource({ ...source, engine: 'postgres' as never })).toThrow('SERVER_OPS_DATA_SOURCE_INVALID')
  })

  test('Given 写入输入 When 密码与清除同时出现或 Redis 逻辑库越界 Then 拒绝', () => {
    const base = { transport: 'ssh' as const, hostId: 'host-1', engine: 'redis' as const, label: '缓存', address: '127.0.0.1', port: 6379, tlsMode: 'disabled' as const }
    expect(parseServerOpsDataSourceUpsertInput(base)).toEqual(base)
    expect(parseServerOpsDataSourceUpsertInput({ ...base, password: 'secret', sourceId: 'source-1' }).password).toBe('secret')
    expect(() => parseServerOpsDataSourceUpsertInput({ ...base, password: 'secret', clearPassword: true }))
      .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
    expect(() => parseServerOpsDataSourceUpsertInput({ ...base, database: '16' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
    expect(parseServerOpsDataSourceUpsertInput({ ...base, database: '3' }).database).toBe('3')
    expect(() => parseServerOpsDataSourceUpsertInput({ ...base, tlsMode: 'verify' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
  })

  test('Given 数据源写入 When 指定或省略项目 Then 都保持兼容', () => {
    /** 不带项目的旧版数据源请求。 */
    const legacy = { transport: 'ssh' as const, hostId: 'host-1', engine: 'mysql' as const, label: '主库', address: '127.0.0.1', port: 3306, tlsMode: 'disabled' as const }
    expect(parseServerOpsDataSourceUpsertInput(legacy).projectId).toBeUndefined()
    expect(parseServerOpsDataSourceUpsertInput({ ...legacy, projectId: 'project-2' }).projectId).toBe('project-2')
    expect(() => parseServerOpsDataSourceUpsertInput({ ...legacy, projectId: 'project 2' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID')
  })

  test('Given 数据源身份与列表输入 When 解析 Then 只接受 exact-key', () => {
    expect(parseServerOpsDataSourceListInput({})).toEqual({})
    /** 按项目过滤是可选能力；非法项目身份必须拒绝。 */
    expect(parseServerOpsDataSourceListInput({ projectId: 'project-1' })).toEqual({ projectId: 'project-1' })
    expect(() => parseServerOpsDataSourceListInput({ projectId: 'project 1' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_LIST_INPUT_INVALID')
    expect(() => parseServerOpsDataSourceListInput({ hostId: 'host-1' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_LIST_INPUT_INVALID')
    expect(parseServerOpsDataSourceProbeInput({ sourceId: 'source-1' })).toEqual({ sourceId: 'source-1' })
    expect(parseServerOpsDataDiagnoseInput({ sourceId: 'source-1' })).toEqual({ sourceId: 'source-1' })
    expect(parseServerOpsDataDiagnoseInput({ sourceId: 'source-1', section: 'parameters' }))
      .toEqual({ sourceId: 'source-1', section: 'parameters' })
    expect(parseServerOpsDataDiagnoseInput({ sourceId: 'source-1', section: 'sessions', database: ' app data ' }))
      .toEqual({ sourceId: 'source-1', section: 'sessions', database: ' app data ' })
    expect(parseServerOpsDataDiagnoseInput({ sourceId: 'source-1', section: 'statements', database: 'analytics' }))
      .toEqual({ sourceId: 'source-1', section: 'statements', database: 'analytics' })
    expect(() => parseServerOpsDataDiagnoseInput({ sourceId: 'source-1', section: 'logs' }))
      .toThrow('SERVER_OPS_DATA_DIAGNOSE_INPUT_INVALID')
    for (const input of [
      { sourceId: 'source-1', database: 'app' },
      { sourceId: 'source-1', section: 'overview', database: 'app' },
      { sourceId: 'source-1', section: 'parameters', database: 'app' },
      { sourceId: 'source-1', section: 'sessions', database: '   ' },
      { sourceId: 'source-1', section: 'sessions', database: 'app\nprod' },
      { sourceId: 'source-1', section: 'sessions', database: 'x'.repeat(65) },
    ]) {
      expect(() => parseServerOpsDataDiagnoseInput(input)).toThrow('SERVER_OPS_DATA_DIAGNOSE_INPUT_INVALID')
    }
    expect(() => parseServerOpsDataDiagnoseInput({ sourceId: 'source-1', section: 'overview', extra: true }))
      .toThrow('SERVER_OPS_DATA_DIAGNOSE_INPUT_INVALID')
    expect(parseServerOpsDataSourceDeleteInput({ sourceId: 'source-1' })).toEqual({ sourceId: 'source-1' })
    expect(() => parseServerOpsDataSourceProbeInput({ sourceId: 'source 1' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')
  })

  test('Given 未保存草稿 When 解析连接测试输入 Then 校验字段自洽且密码来源二选一', () => {
    /** 一条合法的直连草稿。 */
    const directDraft = { transport: 'direct' as const, engine: 'mysql' as const, address: '127.0.0.1', port: 13306, tlsMode: 'disabled' as const }
    expect(parseServerOpsDataSourceProbeInput({ draft: { ...directDraft, password: 'secret' } }))
      .toEqual({ draft: { ...directDraft, password: 'secret' } })
    /** 编辑态复用已保存密码：只给 savedSourceId，不给明文。 */
    expect(parseServerOpsDataSourceProbeInput({ draft: { ...directDraft, savedSourceId: 'source-1' } }))
      .toEqual({ draft: { ...directDraft, savedSourceId: 'source-1' } })
    /** 内联密码与已保存密文同时出现时必须拒绝，避免"看起来用了新密码"。 */
    expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...directDraft, password: 'secret', savedSourceId: 'source-1' } }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')
    /** `ssh` 必须绑定跳板主机，`direct` 不允许携带主机。 */
    expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...directDraft, transport: 'ssh' } }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')
    expect(parseServerOpsDataSourceProbeInput({ draft: { ...directDraft, transport: 'ssh', hostId: 'host-1' } }))
      .toEqual({ draft: { ...directDraft, transport: 'ssh', hostId: 'host-1' } })
    /** 校验模式必须给出数据库真实主机名；Redis 逻辑库只能是 0-15。 */
    expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...directDraft, tlsMode: 'verify' } }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')
    expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...directDraft, engine: 'redis', database: '16' } }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')
    /** 未知字段一律拒绝，避免草稿悄悄夹带未定义语义。 */
    expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...directDraft, label: '不该出现在草稿里' } }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')
    expect(() => parseServerOpsDataSourceProbeInput({ sourceId: 'source-1', draft: directDraft }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')
  })

  test('Given 草稿测试结果 When 缺少 sourceId Then 仍然接受', () => {
    expect(parseServerOpsDataProbeResult({ engine: 'mysql', capability: 'available', serverVersion: '8.0.36', latencyMs: 8, warnings: [] }))
      .toEqual({ engine: 'mysql', capability: 'available', serverVersion: '8.0.36', latencyMs: 8, warnings: [] })
  })

  test('Given 直连地址 When 判定明文边界 Then 只放行回环与私有网段', () => {
    /** 允许明文直连的地址。 */
    for (const address of [
      '127.0.0.1', '127.9.9.9', 'localhost', '::1',
      '10.0.0.5', '10.255.255.255', '172.16.10.198', '172.31.0.1', '192.168.31.20', '169.254.10.1',
      'fd00::1', 'fc00::abcd', 'fe80::1', '[fd12:3456::1]',
    ]) {
      expect(isServerOpsPlaintextDirectAddress(address)).toBe(true)
    }
    /** 公网、非私有边界与主机名都必须继续要求 TLS。 */
    for (const address of [
      '8.8.8.8', '101.34.250.16', '172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.0.1', '169.253.0.1',
      '2001:db8::1', 'db.internal', 'db.example.com', 'mysql.prod', '', '1271.0.0.1', '10.0.0',
    ]) {
      expect(isServerOpsPlaintextDirectAddress(address)).toBe(false)
    }
    /** 前后空白不应改变判定结果（表单里用户常带空格）。 */
    expect(isServerOpsPlaintextDirectAddress(' 172.16.10.198 ')).toBe(true)
  })

  test('Given 读取已保存密码 When 解析输入与结果 Then 只接受 exact-key 且有界明文', () => {
    expect(parseServerOpsDataSourcePasswordInput({ sourceId: 'source-1' })).toEqual({ sourceId: 'source-1' })
    expect(() => parseServerOpsDataSourcePasswordInput({ sourceId: 'source 1' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PASSWORD_INPUT_INVALID')
    expect(() => parseServerOpsDataSourcePasswordInput({ sourceId: 'source-1', password: 'secret' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PASSWORD_INPUT_INVALID')
    /** 没有保存密码时用 null 表达，避免和空字符串混淆。 */
    expect(parseServerOpsDataSourcePasswordResult({ password: null })).toEqual({ password: null })
    expect(parseServerOpsDataSourcePasswordResult({ password: 'p@ss' })).toEqual({ password: 'p@ss' })
    expect(() => parseServerOpsDataSourcePasswordResult({ password: '' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PASSWORD_RESULT_INVALID')
    expect(() => parseServerOpsDataSourcePasswordResult({ password: 'x'.repeat(8_193) }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PASSWORD_RESULT_INVALID')
    expect(() => parseServerOpsDataSourcePasswordResult({ password: 'a\u0000b' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PASSWORD_RESULT_INVALID')
    expect(() => parseServerOpsDataSourcePasswordResult({ password: null, sourceId: 'source-1' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_PASSWORD_RESULT_INVALID')
  })

  test('Given 连接测试结果 When 能力与版本不自洽 Then 拒绝', () => {
    expect(parseServerOpsDataProbeResult({ sourceId: 'source-1', engine: 'redis', capability: 'available', serverVersion: '7.2.4', latencyMs: 12, warnings: [] }))
      .toMatchObject({ capability: 'available', serverVersion: '7.2.4', latencyMs: 12 })
    expect(parseServerOpsDataProbeResult({ sourceId: 'source-1', engine: 'redis', capability: 'auth-failed', warnings: ['认证失败（NOAUTH）'] }).capability)
      .toBe('auth-failed')
    expect(() => parseServerOpsDataProbeResult({ sourceId: 'source-1', engine: 'redis', capability: 'available', warnings: [] }))
      .toThrow('SERVER_OPS_DATA_PROBE_RESULT_INVALID')
    expect(() => parseServerOpsDataProbeResult({ sourceId: 'source-1', engine: 'redis', capability: 'timeout', serverVersion: '7.2.4', warnings: [] }))
      .toThrow('SERVER_OPS_DATA_PROBE_RESULT_INVALID')
  })

  test('Given 诊断结果 When 指标与表格合法 Then 深复制并强制行宽一致', () => {
    const parsed = parseServerOpsDataDiagnosticsResult({
      sourceId: 'source-1', engine: 'redis', capability: 'available',
      collectedAt: 1_700_000_000_000, metrics: [metric], tables: [table], warnings: [],
    })
    expect(parsed.metrics[0]!.ratio).toBe(0.125)
    expect(parsed.tables[0]!.rows).toEqual([['db0', '12']])
    expect(() => parseServerOpsDataDiagnosticsResult({
      sourceId: 'source-1', engine: 'redis', capability: 'available',
      collectedAt: 1_700_000_000_000, metrics: [], tables: [{ ...table, rows: [['db1']] }], warnings: [],
    })).toThrow('SERVER_OPS_DATA_DIAGNOSTICS_RESULT_INVALID')
  })

  test('Given 未连通能力 When 仍携带诊断数据 Then 拒绝', () => {
    expect(parseServerOpsDataDiagnosticsResult({
      sourceId: 'source-1', engine: 'mysql', capability: 'unreachable',
      collectedAt: 1_700_000_000_000, metrics: [], tables: [], warnings: ['目标端口拒绝连接'],
    }).capability).toBe('unreachable')
    expect(() => parseServerOpsDataDiagnosticsResult({
      sourceId: 'source-1', engine: 'mysql', capability: 'unreachable',
      collectedAt: 1_700_000_000_000, metrics: [metric], tables: [], warnings: [],
    })).toThrow('SERVER_OPS_DATA_DIAGNOSTICS_RESULT_INVALID')
  })

  test('Given 指标与表格越界 When 解析 Then fail closed', () => {
    expect(() => parseServerOpsDataMetric({ ...metric, ratio: 1.5 })).toThrow('SERVER_OPS_DATA_METRIC_INVALID')
    expect(() => parseServerOpsDataMetric({ ...metric, id: 'Used_Memory' })).toThrow('SERVER_OPS_DATA_METRIC_INVALID')
    expect(() => parseServerOpsDataMetricList(Array.from({ length: 25 }, () => metric))).toThrow('SERVER_OPS_DATA_METRIC_INVALID')
    expect(() => parseServerOpsDataTable({ ...table, columns: Array.from({ length: 13 }, () => ({ id: 'c', label: '列' })) }))
      .toThrow('SERVER_OPS_DATA_TABLE_INVALID')
    expect(() => parseServerOpsDataTableList([table, table, table, table, table])).toThrow('SERVER_OPS_DATA_TABLE_INVALID')
    expect(() => parseServerOpsDataTable({ ...table, rows: Array.from({ length: 201 }, () => ['db0', '1']) }))
      .toThrow('SERVER_OPS_DATA_TABLE_INVALID')
    expect(parseServerOpsDataTable({ ...table, truncated: true }).truncated).toBe(true)
  })
})
