import {
  SERVER_OPS_DATA_CHANNELS,
  SERVER_OPS_DATA_SCHEMA_CHANNELS,
  SERVER_OPS_DATA_QUERY_CHANNELS,
  SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS,
  parseServerOpsDataQueryHistoryRecordInput,
  parseServerOpsDataQueryHistoryResultForScope,
  parseServerOpsDataQueryHistoryScope,
  parseServerOpsDataQueryInput,
  parseServerOpsDataQueryCancelInput,
  parseServerOpsDataQueryResult,
  parseServerOpsDataDiagnoseInput,
  parseServerOpsDataDiagnosticsResult,
  parseServerOpsDataProbeResult,
  parseServerOpsDataSourceDeleteInput,
  parseServerOpsDataSourceListInput,
  parseServerOpsDataSourceListResult,
  parseServerOpsDataSourcePasswordInput,
  parseServerOpsDataSourcePasswordResult,
  parseServerOpsDataSourceProbeInput,
  parseServerOpsDataSourceSetDefaultDatabaseInput,
  parseServerOpsDataSourceRowsInput,
  parseServerOpsDataSourceRowsResult,
  parseServerOpsDataSourceCellInput,
  parseServerOpsDataSourceCellResult,
  parseServerOpsDataSourceTableInput,
  parseServerOpsDataSourceTableResult,
  parseServerOpsDataSourceTablesInput,
  parseServerOpsDataSourceTablesResult,
  parseServerOpsDataSourceUpsertInput,
  parseServerOpsDataSourceUpsertResult,
} from '@proma/shared'
import type {
  ServerOpsDataDiagnoseInput,
  ServerOpsDataDiagnosticsResult,
  ServerOpsDataProbeResult,
  ServerOpsDataSourceDeleteInput,
  ServerOpsDataSourceListInput,
  ServerOpsDataSourceListResult,
  ServerOpsDataSourcePasswordInput,
  ServerOpsDataSourcePasswordResult,
  ServerOpsDataSourceProbeInput,
  ServerOpsDataSourceSetDefaultDatabaseInput,
  ServerOpsDataSourceRowsInput,
  ServerOpsDataSourceRowsResult,
  ServerOpsDataSourceCellInput,
  ServerOpsDataSourceCellResult,
  ServerOpsDataSourceTableInput,
  ServerOpsDataSourceTableResult,
  ServerOpsDataSourceTablesInput,
  ServerOpsDataSourceTablesResult,
  ServerOpsDataSourceUpsertInput,
  ServerOpsDataSourceUpsertResult,
  ServerOpsDataQueryInput,
  ServerOpsDataQueryCancelInput,
  ServerOpsDataQueryResult,
  ServerOpsDataQueryHistoryRecordInput,
  ServerOpsDataQueryHistoryResult,
  ServerOpsDataQueryHistoryScope,
} from '@proma/shared'

/** 数据服务 preload 调用主进程所需的最小接口。 */
export type ServerOpsDataInvoke = (channel: string, input: unknown) => Promise<unknown>

/** Renderer 可使用的数据服务严格桥接。 */
export interface ServerOpsDataPreload {
  /** 当前库只读 SQL 与精确请求取消，两个入口共用窗口所有权。 */
  queryServerOpsDatabase(input: ServerOpsDataQueryInput): Promise<ServerOpsDataQueryResult>
  cancelServerOpsDatabaseQuery(input: ServerOpsDataQueryCancelInput): Promise<void>
  /** 列出当前数据源数据库的本地 SQL 查询历史。 */
  listServerOpsDatabaseQueryHistory(input: ServerOpsDataQueryHistoryScope): Promise<ServerOpsDataQueryHistoryResult>
  /** 保存一次成功执行的 SQL，并返回当前 scope 的完整有界历史。 */
  saveServerOpsDatabaseQueryHistory(input: ServerOpsDataQueryHistoryRecordInput): Promise<ServerOpsDataQueryHistoryResult>
  listServerOpsDataSources(input: ServerOpsDataSourceListInput): Promise<ServerOpsDataSourceListResult>
  upsertServerOpsDataSource(input: ServerOpsDataSourceUpsertInput): Promise<ServerOpsDataSourceUpsertResult>
  /** 使用完整公开快照执行 CAS，只改变 SQL 数据源的默认数据库。 */
  setServerOpsDataSourceDefaultDatabase(input: ServerOpsDataSourceSetDefaultDatabaseInput): Promise<ServerOpsDataSourceUpsertResult>
  deleteServerOpsDataSource(input: ServerOpsDataSourceDeleteInput): Promise<void>
  probeServerOpsDataSource(input: ServerOpsDataSourceProbeInput): Promise<ServerOpsDataProbeResult>
  diagnoseServerOpsDataSource(input: ServerOpsDataDiagnoseInput): Promise<ServerOpsDataDiagnosticsResult>
  /**
   * 读取已保存的密码明文，用于界面上的"显示密码"。
   *
   * 只在用户显式要求时调用；明文仅用于这一次展示，调用方不得缓存或写入日志。
   */
  revealServerOpsDataSourcePassword(input: ServerOpsDataSourcePasswordInput): Promise<ServerOpsDataSourcePasswordResult>
  /** 表浏览：库与表清单（只读）。 */
  listServerOpsDataSchemaTables(input: ServerOpsDataSourceTablesInput): Promise<ServerOpsDataSourceTablesResult>
  /** 表浏览：单表结构（列 + 索引，只读）。 */
  describeServerOpsDataSchemaTable(input: ServerOpsDataSourceTableInput): Promise<ServerOpsDataSourceTableResult>
  /** 表浏览：分页读取表数据（只读）。 */
  readServerOpsDataSchemaRows(input: ServerOpsDataSourceRowsInput): Promise<ServerOpsDataSourceRowsResult>
  /** 表浏览：按需读取经过摘要验证的单格原文。 */
  readServerOpsDataSchemaCell(input: ServerOpsDataSourceCellInput): Promise<ServerOpsDataSourceCellResult>
}

/** 组合数据服务 API，并在 IPC 两侧都使用 exact-key parser。 */
export function createServerOpsDataPreload(invoke: ServerOpsDataInvoke): ServerOpsDataPreload {
  return {
    queryServerOpsDatabase: async (input) => parseServerOpsDataQueryResult(
      await invoke(SERVER_OPS_DATA_QUERY_CHANNELS.EXECUTE, parseServerOpsDataQueryInput(input)),
    ),
    cancelServerOpsDatabaseQuery: async (input) => {
      const result = await invoke(SERVER_OPS_DATA_QUERY_CHANNELS.CANCEL, parseServerOpsDataQueryCancelInput(input))
      if (result !== undefined) throw new Error('SERVER_OPS_SQL_CANCEL_RESULT_INVALID')
    },
    listServerOpsDatabaseQueryHistory: async (input) => {
      const scope = parseServerOpsDataQueryHistoryScope(input)
      return parseServerOpsDataQueryHistoryResultForScope(
        await invoke(SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS.LIST, scope),
        scope,
      )
    },
    saveServerOpsDatabaseQueryHistory: async (input) => {
      const record = parseServerOpsDataQueryHistoryRecordInput(input)
      return parseServerOpsDataQueryHistoryResultForScope(
        await invoke(SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS.SAVE, record),
        { sourceId: record.sourceId, database: record.database },
      )
    },
    listServerOpsDataSources: async (input) => parseServerOpsDataSourceListResult(
      await invoke(SERVER_OPS_DATA_CHANNELS.LIST_SOURCES, parseServerOpsDataSourceListInput(input)),
    ),
    upsertServerOpsDataSource: async (input) => parseServerOpsDataSourceUpsertResult(
      await invoke(SERVER_OPS_DATA_CHANNELS.UPSERT_SOURCE, parseServerOpsDataSourceUpsertInput(input)),
    ),
    setServerOpsDataSourceDefaultDatabase: async (input) => parseServerOpsDataSourceUpsertResult(
      await invoke(
        SERVER_OPS_DATA_CHANNELS.SET_DEFAULT_DATABASE,
        parseServerOpsDataSourceSetDefaultDatabaseInput(input),
      ),
    ),
    deleteServerOpsDataSource: async (input) => {
      /** 删除只接受空回执，携带结果说明协议被破坏。 */
      const result = await invoke(SERVER_OPS_DATA_CHANNELS.DELETE_SOURCE, parseServerOpsDataSourceDeleteInput(input))
      if (result !== undefined) throw new Error('SERVER_OPS_DATA_SOURCE_DELETE_RESULT_INVALID')
    },
    probeServerOpsDataSource: async (input) => parseServerOpsDataProbeResult(
      await invoke(SERVER_OPS_DATA_CHANNELS.PROBE_SOURCE, parseServerOpsDataSourceProbeInput(input)),
    ),
    diagnoseServerOpsDataSource: async (input) => parseServerOpsDataDiagnosticsResult(
      await invoke(SERVER_OPS_DATA_CHANNELS.DIAGNOSE_SOURCE, parseServerOpsDataDiagnoseInput(input)),
    ),
    revealServerOpsDataSourcePassword: async (input) => parseServerOpsDataSourcePasswordResult(
      await invoke(SERVER_OPS_DATA_CHANNELS.REVEAL_SOURCE_PASSWORD, parseServerOpsDataSourcePasswordInput(input)),
    ),
    listServerOpsDataSchemaTables: async (input) => parseServerOpsDataSourceTablesResult(
      await invoke(SERVER_OPS_DATA_SCHEMA_CHANNELS.LIST_TABLES, parseServerOpsDataSourceTablesInput(input)),
    ),
    describeServerOpsDataSchemaTable: async (input) => parseServerOpsDataSourceTableResult(
      await invoke(SERVER_OPS_DATA_SCHEMA_CHANNELS.DESCRIBE_TABLE, parseServerOpsDataSourceTableInput(input)),
    ),
    readServerOpsDataSchemaRows: async (input) => parseServerOpsDataSourceRowsResult(
      await invoke(SERVER_OPS_DATA_SCHEMA_CHANNELS.READ_ROWS, parseServerOpsDataSourceRowsInput(input)),
    ),
    readServerOpsDataSchemaCell: async (input) => parseServerOpsDataSourceCellResult(
      await invoke(SERVER_OPS_DATA_SCHEMA_CHANNELS.READ_CELL, parseServerOpsDataSourceCellInput(input)),
    ),
  }
}
