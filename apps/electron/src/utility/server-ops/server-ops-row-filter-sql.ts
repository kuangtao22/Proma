import { isServerOpsSqlSensitiveColumn, parseServerOpsDataRowFilters } from '@proma/shared'
import type { ServerOpsDataRowFilters } from '@proma/shared'

/** 根据引擎选择标识符引用规则，筛选值始终使用绑定参数。 */
type FilterDialect = 'mysql' | 'postgresql' | 'sqlite'
/** 严格白名单错误码，不允许用户输入穿过错误消息边界。 */
const INVALID_FILTER_CODE = 'SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID'
/** 当前驱动没有服务端预处理能力时拒绝退回客户端 SQL 插值。 */
const UNAVAILABLE_FILTER_CODE = 'SERVER_OPS_DATA_SCHEMA_FILTERS_UNAVAILABLE'

/** 构建结果仅包含固定操作符产生的 SQL 与参数，不承接调用方 SQL 片段。 */
export interface ServerOpsRowFilterSql {
  clause: string
  values: string[]
}

/** 把筛选校验错误公开为固定中文说明；入参为未知错误，非本类错误返回 null。 */
export function getServerOpsRowFilterPublicError(error: unknown): { code: string; message: string } | null {
  if (!(error instanceof Error)) return null
  if (error.message === INVALID_FILTER_CODE) {
    return { code: INVALID_FILTER_CODE, message: '筛选条件无效或字段不可用于筛选' }
  }
  return error.message === UNAVAILABLE_FILTER_CODE
    ? { code: UNAVAILABLE_FILTER_CODE, message: '当前连接不支持安全筛选，请重连后重试' } : null
}

/** 以 ! 转义 LIKE 通配符；入参为原始值，返回只匹配字面字符的模式。 */
function escapeLikeValue(value: string): string {
  return value.replace(/[!%_]/gu, (character) => `!${character}`)
}

/** 使用当前引擎的标识符规则；入参只能是实时 metadata 中已验证的列名。 */
function quoteColumn(column: string, dialect: FilterDialect): string {
  return dialect === 'mysql' ? `\`${column.replaceAll('`', '``')}\`` : `"${column.replaceAll('"', '""')}"`
}

/**
 * 根据当前表的真实列构造只读 WHERE 条件；入参为筛选合同、列名及引擎，返回 SQL 与绑定值。
 * 即便上游已解析输入，这里也再次验证，禁止过滤敏感列或拼接未核验标识符。
 */
export function buildServerOpsRowFilterSql(
  filters: ServerOpsDataRowFilters,
  columns: readonly string[],
  dialect: FilterDialect,
): ServerOpsRowFilterSql {
  const parsed = parseServerOpsDataRowFilters(filters)
  const available = new Set(columns)
  const values: string[] = []
  const clauses = parsed.conditions.map((condition) => {
    if (!available.has(condition.column) || isServerOpsSqlSensitiveColumn(condition.column)) {
      throw new Error(INVALID_FILTER_CODE)
    }
    const column = quoteColumn(condition.column, dialect)
    if (condition.operator === 'is-null') return `${column} IS NULL`
    if (condition.operator === 'is-not-null') return `${column} IS NOT NULL`
    const value = condition.value!
    if (condition.operator === 'contains' || condition.operator === 'not-contains'
      || condition.operator === 'starts-with' || condition.operator === 'ends-with') {
      const escaped = escapeLikeValue(value)
      const pattern = condition.operator === 'contains' || condition.operator === 'not-contains' ? `%${escaped}%`
        : condition.operator === 'starts-with' ? `${escaped}%` : `%${escaped}`
      values.push(pattern)
      const placeholder = dialect === 'postgresql' ? `$${values.length}` : '?'
      return `${column} ${condition.operator === 'not-contains' ? 'NOT LIKE' : 'LIKE'} ${placeholder} ESCAPE '!'`
    }
    values.push(value)
    const operator = {
      eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
    }[condition.operator]
    const placeholder = dialect === 'postgresql' ? `$${values.length}` : '?'
    return `${column} ${operator} ${placeholder}`
  })
  return { clause: ` WHERE (${clauses.join(parsed.match === 'all' ? ' AND ' : ' OR ')})`, values }
}
