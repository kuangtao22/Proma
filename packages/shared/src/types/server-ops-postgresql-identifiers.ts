/** PostgreSQL 单个标识符允许的最大 UTF-8 字节数。 */
const MAX_POSTGRES_IDENTIFIER_BYTES = 63
/** canonical schema/table 身份的公开合同上限。 */
export const MAX_SERVER_OPS_POSTGRES_TABLE_IDENTITY_LENGTH = 260

/** 校验 PostgreSQL 标识符并返回原值。 */
function parseIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || /\p{Cc}/u.test(value)
    || new TextEncoder().encode(value).byteLength > MAX_POSTGRES_IDENTIFIER_BYTES) {
    throw new Error('SERVER_OPS_POSTGRES_TABLE_INVALID')
  }
  return value
}

/** 使用 PostgreSQL 双引号规则生成单个标识符。 */
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * 生成 schema 与 table 的稳定策略身份。
 *
 * @param schema PostgreSQL schema 原始名称
 * @param table PostgreSQL table 原始名称
 * @returns 严格双引号限定的 canonical 身份
 */
export function formatServerOpsPostgresTable(schema: string, table: string): string {
  const identity = `${quoteIdentifier(parseIdentifier(schema))}.${quoteIdentifier(parseIdentifier(table))}`
  if (identity.length > MAX_SERVER_OPS_POSTGRES_TABLE_IDENTITY_LENGTH) {
    throw new Error('SERVER_OPS_POSTGRES_TABLE_INVALID')
  }
  return identity
}

/**
 * 解析严格 canonical 的 PostgreSQL 表身份。
 *
 * @param value 双引号完整名
 * @returns schema 与 table 原始名称
 */
export function parseServerOpsPostgresTable(value: string): { schema: string; table: string } {
  if (typeof value !== 'string' || value.length > MAX_SERVER_OPS_POSTGRES_TABLE_IDENTITY_LENGTH) {
    throw new Error('SERVER_OPS_POSTGRES_TABLE_INVALID')
  }
  let index = 0
  /** 读取一个双引号标识符，并还原内部双写引号。 */
  const readQuoted = (): string => {
    if (value[index] !== '"') throw new Error('SERVER_OPS_POSTGRES_TABLE_INVALID')
    index += 1
    let identifier = ''
    while (index < value.length) {
      if (value[index] !== '"') {
        identifier += value[index]
        index += 1
        continue
      }
      if (value[index + 1] === '"') {
        identifier += '"'
        index += 2
        continue
      }
      index += 1
      return parseIdentifier(identifier)
    }
    throw new Error('SERVER_OPS_POSTGRES_TABLE_INVALID')
  }
  const schema = readQuoted()
  if (value[index] !== '.') throw new Error('SERVER_OPS_POSTGRES_TABLE_INVALID')
  index += 1
  const table = readQuoted()
  if (index !== value.length || formatServerOpsPostgresTable(schema, table) !== value) {
    throw new Error('SERVER_OPS_POSTGRES_TABLE_INVALID')
  }
  return { schema, table }
}
