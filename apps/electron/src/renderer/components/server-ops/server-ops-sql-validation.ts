import { validateServerOpsSqlQuery } from '@proma/shared'
import type { ServerOpsSqlDiagnostic } from '@proma/shared'
import type { ServerOpsSqlCompletionProjection } from './server-ops-sql-completion-controller'
import type { ServerOpsSqlDialect } from './server-ops-sql-completion'

/** 编辑器诊断包含阻断错误与仅供参考的缓存提醒；位置沿用 parser 的 UTF-16 偏移。 */
export interface ServerOpsSqlEditorDiagnostic extends Omit<ServerOpsSqlDiagnostic, 'category'> {
  category: ServerOpsSqlDiagnostic['category'] | 'schema'
  severity: 'error' | 'warning'
}

/** 本地校验不承诺数据库存在性和权限；valid 仅表示符合当前只读查询语法。 */
export interface ServerOpsSqlDraftValidation {
  status: 'empty' | 'unavailable' | 'valid' | 'invalid'
  diagnostics: ServerOpsSqlEditorDiagnostic[]
}

/** 校验当前草稿与已有结构快照，返回诊断；不加载结构、不执行 SQL、不写历史。 */
export function validateServerOpsSqlDraft(
  sql: string,
  database: string | null,
  schema?: ServerOpsSqlCompletionProjection,
  dialect: ServerOpsSqlDialect = 'mysql',
): ServerOpsSqlDraftValidation {
  if (!sql.trim()) return { status: 'empty', diagnostics: [] }
  if (!database) return { status: 'unavailable', diagnostics: [] }
  /** 与主进程共用同一 parser；前端校验不会扩展后台允许的语法。 */
  const parsed = validateServerOpsSqlQuery(sql, database, dialect)
  if (!parsed.plan) return { status: 'invalid', diagnostics: parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, severity: 'error' })) }
  /** 只核对当前库已就绪的快照，加载失败、刷新中或切库时不作缺失推断。 */
  const diagnostics: ServerOpsSqlEditorDiagnostic[] = []
  if (!schema || schema.database !== database || schema.status !== 'ready') return { status: 'valid', diagnostics }
  /** 提示有界，避免长语句在编辑器下方堆积大量结构提醒。 */
  const warn = (code: string, message: string, from: number, to: number): void => {
    if (diagnostics.length < 8) diagnostics.push({ code, category: 'schema', severity: 'warning', message, from, to })
  }
  /** PostgreSQL 按 parser 已规范化的标识精确匹配；其他引擎保留既有宽松缓存提示。 */
  const identifierKey = (value: string): string => dialect === 'postgresql' ? value : value.toLowerCase()
  const tableNames = new Map(schema.tables.map((table) => [identifierKey(table.name), table.name]))
  /** 字段集合只读取自有属性，防止 constructor 等合法表名命中原型。 */
  const fields = new Map<string, Set<string>>()
  for (const table of parsed.plan.tables) {
    const name = tableNames.get(identifierKey(table)) ?? table
    if (Object.hasOwn(schema.columns, name)) fields.set(identifierKey(table), new Set(schema.columns[name]!.map((column) => identifierKey(column.name))))
  }
  for (const reference of parsed.plan.tableReferences) {
    if (!schema.tablesTruncated && !tableNames.has(identifierKey(reference.table))) {
      warn('SCHEMA_TABLE_MISSING', '缓存中未找到这张表，请刷新结构确认；执行时仍会实时检查。', reference.from, reference.to)
    }
  }
  for (const column of parsed.plan.columns) {
    if (column.outputAlias || column.column === '*') continue
    /** 限定列用 parser 已验证的别名映射；裸列需所有引用表字段齐全才判断缺失。 */
    const references = column.sourceTable ? [column.sourceTable] : parsed.plan.tableReferences.map((reference) => reference.table)
    const known = references.map((table) => fields.get(identifierKey(table)))
    if (known.length === 0 || known.some((columns) => !columns)) continue
    const matches = known.filter((columns) => columns!.has(identifierKey(column.column))).length
    if (matches === 0) warn('SCHEMA_COLUMN_MISSING', '缓存中未找到该字段，请刷新结构确认；执行时仍会实时检查。', column.from, column.to)
    else if (matches > 1) warn('SCHEMA_COLUMN_AMBIGUOUS', '缓存中多个表包含此字段，建议使用表名或别名限定。', column.from, column.to)
  }
  return { status: 'valid', diagnostics }
}
