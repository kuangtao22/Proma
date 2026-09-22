import { isServerOpsId } from '@proma/shared'
import type { ServerOpsDataSourceTableResult } from '@proma/shared'
import type { ServerOpsAgentReadFacade } from './server-ops-agent-read-facade'

/** 只传递精确的数据库与表目标；不接受脚本正文、凭据或执行选项。 */
export interface ServerOpsDatabaseChangeContextInput {
  sourceId: string
  database: string
  tables: string[]
}

/** 脚本依据仅包含现有读取器实际提供的列和索引，不冒充完整 DDL。 */
interface ServerOpsDatabaseChangeTable extends ServerOpsDataSourceTableResult {
  name: string
  truncated?: boolean
}

/** 工具返回的是供模型编写脚本的事实与要求，始终不代表生成、验证或执行成功。 */
export interface ServerOpsDatabaseChangeContextResult {
  sourceId: string
  database: string
  engine: 'mysql' | 'sqlite'
  executionAllowed: false
  programContext: 'not-inspected'
  schemaCoverage: 'columns-and-indexes-only'
  tables: ServerOpsDatabaseChangeTable[]
  workflow: string[]
  warnings: string[]
  truncated: boolean
}

/** 共享产物规范供工具结果和系统提示词使用，禁止把生成脚本升级为远程执行。 */
export const SERVER_OPS_DATABASE_CHANGE_WORKFLOW = [
  '先核对当前已授权项目的程序模型、业务校验、枚举、软删除、审计字段、关联关系及既有迁移约定；引用实际读过的文件。未读取程序时明确标记缺失，不能声称已验证业务兼容。',
  '按项目现有框架生成迁移或修复程序；只有不涉及业务副作用且适合 SQL 时才生成 SQL 脚本。凭据使用由用户运行时提供的环境变量，不写入文件或聊天。',
  '产物必须包含目标与依据、只读预检查、精确主键或范围条件、预计影响行数与上限、重复运行策略、修改脚本/程序、修改后验证及恢复说明。不得猜测实际影响行数。',
  '修改程序默认预览或 dry-run，由人工显式选择应用；SQL 文件明确标记为待审阅，预检查与修改分离。按引擎与操作说明事务能力，MySQL DDL 不承诺事务回滚，无法恢复的操作明确列出。',
  '只生成可审查文件或带语言标记的代码块；不得执行变更脚本，不得通过 SSH、Shell、数据库客户端、MCP 或生成后自动运行的程序绕过数据库只读边界。不要修改数据库连接配置文件来取得写入能力。',
  '验证限定为静态检查、单元测试或无生产凭据的临时合成数据库；不得把生产事务回滚当作无副作用测试。区分已生成、已审查、已验证与已执行，交付时列明尚未完成的步骤。',
]

/** 验证模型输入并重建对象，防止不合法字段进入读取层；返回有界的目标列表。 */
function parseChangeContextInput(value: unknown): ServerOpsDatabaseChangeContextInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SERVER_OPS_CHANGE_CONTEXT_INPUT_INVALID')
  /** 精确字段集合拒绝 SQL、执行选项和会话身份。 */
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 3 || Object.keys(record).some((key) => !['sourceId', 'database', 'tables'].includes(key))
    || !isServerOpsId(record.sourceId) || typeof record.database !== 'string' || !record.database.length || record.database.length > 64
    || /[\u0000-\u001f\u007f]/u.test(record.database) || !Array.isArray(record.tables) || record.tables.length < 1 || record.tables.length > 4
    || record.tables.some((table) => typeof table !== 'string' || !table.length || table.length > 128 || /[\u0000-\u001f\u007f]/u.test(table))
    || new Set(record.tables).size !== record.tables.length) throw new Error('SERVER_OPS_CHANGE_CONTEXT_INPUT_INVALID')
  return { sourceId: record.sourceId, database: record.database, tables: [...record.tables] as string[] }
}

/**
 * 根据授权结构构建数据库变更依据，供 Agent 结合程序代码生成待审阅产物。
 * @param facade 精确复核目标权限与读取表结构的会话闭包。
 * @param value 模型提交的连接、库、最多四张表，不允许执行参数。
 * @param signal 本次工具调用的取消信号。
 * @returns 有界结构证据与生成规范；不查询数据、不写库、不生成或执行文件。
 */
export async function prepareServerOpsDatabaseChangeContext(
  facade: Pick<ServerOpsAgentReadFacade, 'checkDatabaseTables' | 'databaseDescribe'>,
  value: unknown,
  signal?: AbortSignal,
): Promise<ServerOpsDatabaseChangeContextResult> {
  /** 全部输入先校验，避免部分非法请求先触发远程读取。 */
  const input = parseChangeContextInput(value)
  /** 每个 await 前后同步复查真实会话授权与取消。 */
  const checkCancelled = (): void => {
    if (signal?.aborted) throw new Error('SERVER_OPS_AGENT_READ_CANCELLED')
  }
  checkCancelled()
  /** 一次预检全部表，禁止先读部分结构才发现剩余目标越权。 */
  const initial = facade.checkDatabaseTables(input)
  /** 不要求额外行权限，并明确尚未读取业务程序。 */
  const result: ServerOpsDatabaseChangeContextResult = {
    sourceId: input.sourceId, database: input.database, engine: initial.engine,
    executionAllowed: false, programContext: 'not-inspected', schemaCoverage: 'columns-and-indexes-only',
    tables: [], workflow: [...SERVER_OPS_DATABASE_CHANGE_WORKFLOW], truncated: false,
    warnings: ['结构证据仅覆盖列和索引；外键、触发器、检查约束、视图依赖、权限及程序副作用尚未验证，敏感字段默认值可能被遮罩。'],
  }
  /** 后续返回前复核同一租约代次，防止组合跨授权结果。 */
  const check = (): void => {
    checkCancelled()
    facade.checkDatabaseTables({ ...input, revision: initial.revision })
  }
  for (const table of input.tables) {
    check()
    /** 顺序读取复用数据源队列，避免为少量结构额外制造并发。 */
    const schema = await facade.databaseDescribe({ sourceId: input.sourceId, database: input.database, table }, signal)
    check()
    result.tables.push({ name: table, ...structuredClone(schema) })
    if (schema.truncated) result.truncated = true
  }
  /** 四张大表的组合结果仍采用一次工具 32 KiB 的最终 UTF-8 预算。 */
  const bytes = (): number => Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8')
  if (result.truncated || bytes() > 32_768) {
    result.truncated = true
    result.warnings.push('表结构已截断；不要按缺失字段推断可修改。请缩小表范围或补充完整迁移定义后再生成可执行版本。')
  }
  while (bytes() > 32_768) {
    /** 均衡裁剪最多结构项的表，保留每个目标的身份与不完整标记。 */
    const largest = result.tables.reduce((left, right) => left.columns.length + left.indexes.length >= right.columns.length + right.indexes.length ? left : right)
    largest.truncated = true
    if (largest.columns.length >= largest.indexes.length && largest.columns.length) largest.columns.pop()
    else if (largest.indexes.length) largest.indexes.pop()
    else throw new Error('SERVER_OPS_AGENT_RESULT_TOO_LARGE')
  }
  check()
  return result
}
