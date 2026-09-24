import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { MySQL, PostgreSQL, SQLite, keywordCompletionSource, schemaCompletionSource } from '@codemirror/lang-sql'
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { ServerOpsDataSchemaColumn, ServerOpsDataSchemaTableSummary } from '@proma/shared'
import { formatServerOpsPostgresTable } from '@proma/shared'

/** 当前连接/数据库的结构快照；不保存数据行或密码。 */
export interface ServerOpsSqlCompletionSchema {
  contextKey: string
  database: string | null
  tables: ServerOpsDataSchemaTableSummary[]
  columns: Record<string, ServerOpsDataSchemaColumn[]>
}

/** 只识别当前库基础表的简单 FROM/JOIN 来源。 */
export interface ServerOpsSqlTableReference {
  table: string
  alias: string
}

/** 补全源通过快照读取与按需加载回调共享页面元数据控制器。 */
interface ServerOpsSqlCompletionOptions {
  /** SQL 方言决定关键字、函数与标识符规则；缺省保持 MySQL 兼容。 */
  dialect?: ServerOpsSqlDialect
  getSchema: () => ServerOpsSqlCompletionSchema
  ensureCatalog?: () => Promise<void>
  ensureColumns: (tables: string[]) => Promise<void>
}

/** 运维查询当前支持的编辑器方言。 */
export type ServerOpsSqlDialect = 'mysql' | 'postgresql' | 'sqlite'

/** 保留语法节点边界，避免把字符串/注释内部文字解释为 SQL 来源。 */
interface SqlToken {
  name: string
  text: string
  from: number
  to: number
}

/** 保留字集合只构造一次，避免为每个字段重复拆分完整关键字表。 */
const DIALECT_KEYWORDS: Record<ServerOpsSqlDialect, Set<string>> = {
  mysql: new Set(MySQL.spec.keywords?.toLowerCase().split(/\s+/u)),
  postgresql: new Set(PostgreSQL.spec.keywords?.toLowerCase().split(/\s+/u)),
  sqlite: new Set(SQLite.spec.keywords?.toLowerCase().split(/\s+/u)),
}
/** CodeMirror SQLite 词表仍继承部分通用/厂商词；这些 MySQL 专有项不应误导用户。 */
const MYSQL_ONLY_COMPLETIONS = new Set([
  'SHOW', 'DESCRIBE', 'USE', 'DATABASES', 'STRAIGHT_JOIN', 'SQL_CALC_FOUND_ROWS',
  'DATE_FORMAT', 'JSON_EXTRACT', 'JSON_UNQUOTE', 'FOUND_ROWS',
])
/** 非 ASCII 字段也可以继续本地过滤，不重复发起补全请求。 */
const IDENTIFIER_PREFIX = /^[\p{L}\p{N}_$]*$/u

/** 普通对象不能把 constructor 等原型属性当作已缓存字段。 */
function getColumns(schema: ServerOpsSqlCompletionSchema, table: string): ServerOpsDataSchemaColumn[] {
  return Object.hasOwn(schema.columns, table) ? schema.columns[table]! : []
}

/** 移除 MySQL 标识符反引号，同时还原转义的反引号。 */
function unquoteIdentifier(value: string, dialect: ServerOpsSqlDialect = 'mysql'): string {
  if (dialect === 'postgresql') return value.startsWith('"')
    ? value.slice(1, value.endsWith('"') ? -1 : undefined).replace(/""/gu, '"') : value.toLowerCase()
  return value.startsWith('`') ? value.slice(1, value.endsWith('`') ? -1 : undefined).replace(/``/gu, '`') : value
}

/** 生成可安全插入 SQL 的标识符；特殊字符与保留字使用反引号。 */
function quoteIdentifier(value: string, dialect: ServerOpsSqlDialect): string {
  if (dialect === 'postgresql') return `"${value.replaceAll('"', '""')}"`
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(value) && !DIALECT_KEYWORDS[dialect].has(value.toLowerCase())
    ? value : `\`${value.replace(/`/gu, '``')}\``
}

/** 获取光标所在 Statement 的直接子节点，跳过注释但不展开子查询。 */
function statementTokens(state: EditorState, pos: number): SqlToken[] {
  /** 增量树在未完成标识符处仍然包含稳定的 Statement 外壳。 */
  let node = syntaxTree(state).resolveInner(pos, -1)
  while (node.parent && node.name !== 'Statement') node = node.parent
  if (node.name !== 'Statement') return []
  /** 顶层 token 足以覆盖当前支持的基础表 SELECT 与 JOIN。 */
  const tokens: SqlToken[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (/Comment/u.test(child.name)) continue
    tokens.push({ name: child.name, text: state.sliceDoc(child.from, child.to), from: child.from, to: child.to })
  }
  return tokens
}

/** 判断语法节点是不是普通或反引号标识符。 */
function isIdentifier(token: SqlToken | undefined): token is SqlToken {
  return token?.name === 'Identifier' || token?.name === 'QuotedIdentifier'
}

/** 从当前语句的语法树提取当前库表和别名；跨库、CTE、派生表不推测。 */
export function getServerOpsSqlTableReferences(state: EditorState, pos: number, schema: ServerOpsSqlCompletionSchema, dialect: ServerOpsSqlDialect = 'mysql'): ServerOpsSqlTableReference[] {
  const tokens = statementTokens(state, pos)
  if (tokens[0]?.text.toUpperCase() !== 'SELECT' || tokens.some((token) => token.name === 'Keyword' && token.text.toUpperCase() === 'UNION')) return []
  /** 用精确表名映射尊重数据库大小写规则，不自动跨库匹配。 */
  const knownTables = new Set(schema.tables.filter((table) => table.type !== 'view').map((table) => table.name))
  const references: ServerOpsSqlTableReference[] = []
  let inSources = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    const keyword = token.text.toUpperCase()
    if (token.name === 'Keyword' && ['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'ON'].includes(keyword)) inSources = false
    if (keyword !== 'FROM' && keyword !== 'JOIN' && !(inSources && token.text === ',')) continue
    if (token.name !== 'Keyword' && token.text !== ',') continue
    inSources = true
    const tableToken = tokens[index + 1]
    if (!tableToken || (tableToken.name !== 'Identifier' && tableToken.name !== 'QuotedIdentifier'
      && !(dialect === 'postgresql' && tableToken.name === 'CompositeIdentifier'))) continue
    /** PostgreSQL 的两段名是 schema.table，规范表身份与后台保持一致。 */
    let table = unquoteIdentifier(tableToken.text, dialect)
    /** 没有显式别名时，SQL 字段限定符使用原始表名。 */
    let defaultAlias = table
    if (dialect === 'postgresql') {
      /** 只解析完整的一段或两段标识符，不推测跨库、子查询或未完成的表名。 */
      const parts = tableToken.text.match(/^("(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$]*)(?:\s*\.\s*("(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$]*))?$/u)
      if (!parts) continue
      defaultAlias = unquoteIdentifier(parts[2] ?? parts[1]!, dialect)
      try { table = formatServerOpsPostgresTable(parts[2] ? unquoteIdentifier(parts[1]!, dialect) : 'public', defaultAlias) } catch { continue }
    }
    if (!knownTables.has(table)) continue
    /** AS 不是别名自身；裸别名只接受 parser 标识符。 */
    const aliasToken = tokens[index + (tokens[index + 2]?.text.toUpperCase() === 'AS' ? 3 : 2)]
    const alias = isIdentifier(aliasToken) ? unquoteIdentifier(aliasToken.text, dialect) : defaultAlias
    references.push({ table, alias })
  }
  return references
}

/** 光标是否位于字符串或注释；这两类区域完全关闭联想。 */
function isLiteralContext(context: CompletionContext): boolean {
  let node = syntaxTree(context.state).resolveInner(context.pos, -1)
  while (node.parent) {
    if (/String|Comment/u.test(node.name)) return true
    node = node.parent
  }
  return false
}

/** 表名输入位置只给表；括号和表达式中的关键字不会改变顶层子句。 */
function isTableContext(context: CompletionContext): boolean {
  const before = statementTokens(context.state, context.pos).filter((token) => token.to <= context.pos)
  let clause = ''
  for (const token of before) {
    if (token.name === 'Keyword' && ['SELECT', 'FROM', 'JOIN', 'ON', 'WHERE', 'SET', 'GROUP', 'ORDER', 'HAVING', 'LIMIT'].includes(token.text.toUpperCase())) clause = token.text.toUpperCase()
  }
  return clause === 'FROM' || clause === 'JOIN'
}

/** 将服务端字段映射成 CodeMirror 候选，详情使用纯文本避免 HTML 注入。 */
function columnCompletion(column: ServerOpsDataSchemaColumn, dialect: ServerOpsSqlDialect): Completion {
  return { label: column.name, type: 'property', detail: column.type,
    ...(column.comment ? { info: column.comment } : {}), apply: quoteIdentifier(column.name, dialect) }
}

/** 创建动态 SQL 补全源；异步读取失败时保留关键字，切库后丢弃旧结果。 */
export function createServerOpsSqlCompletionSource(options: ServerOpsSqlCompletionOptions): CompletionSource {
  /** 缺省沿用现有 MySQL 行为。 */
  const dialect = options.dialect ?? 'mysql'
  const sqlDialect = dialect === 'postgresql' ? PostgreSQL : dialect === 'sqlite' ? SQLite : MySQL
  /** 关键字源是只读共享函数，不为每次按键重新构造。 */
  const keywords = keywordCompletionSource(sqlDialect, true)
  return async (context): Promise<CompletionResult | null> => {
    if (isLiteralContext(context)) return null
    const requestedContext = options.getSchema().contextKey
    try { await options.ensureCatalog?.() } catch { /* 目录失败时仍允许关键字联想。 */ }
    const initial = options.getSchema()
    if (context.aborted || requestedContext !== initial.contextKey) return null
    const references = getServerOpsSqlTableReferences(context.state, context.pos, initial, dialect)
    const tablePosition = isTableContext(context)
    /** 点号前仅匹配词法标识符，来源归属仍由语法树与已知表决定。 */
    const qualifier = context.state.sliceDoc(0, context.pos).match(dialect === 'postgresql'
      ? /("(?:[^"]|"")+"|[\p{L}\p{N}_$]+)\.\s*(?:"(?:[^"]|"")*|[\p{L}\p{N}_$]*)$/u
      : /(`(?:[^`]|``)+`|[\p{L}\p{N}_$]+)\.\s*(?:`(?:[^`]|``)*|[\p{L}\p{N}_$]*)$/u)
    const reference = qualifier ? references.find((item) => item.alias === unquoteIdentifier(qualifier[1]!, dialect) || item.table === unquoteIdentifier(qualifier[1]!, dialect)) : undefined
    if (qualifier && !reference) return null
    if (!tablePosition || qualifier) {
      try { await options.ensureColumns([...new Set((reference ? [reference] : references).map((item) => item.table))]) } catch { /* 元数据失败不影响编辑或执行。 */ }
    }
    const schema = options.getSchema()
    if (context.aborted || initial.contextKey !== schema.contextKey) return null
    /** 无原型容器允许数据库包含 constructor、__proto__ 等合法表名。 */
    const namespace: Record<string, { self: Completion; children: Completion[] }> = Object.create(null)
    for (const table of schema.tables) {
      if (table.type === 'view') continue
      namespace[table.name] = { self: { label: table.name, type: 'type', detail: '表', apply: dialect === 'postgresql' ? table.name : quoteIdentifier(table.name, dialect), ...(table.comment ? { info: table.comment } : {}) }, children: getColumns(schema, table.name).map((column) => columnCompletion(column, dialect)) }
    }
    /** 内置 SQL source 负责别名限定与反引号转义。 */
    const native = dialect === 'postgresql' ? null : await schemaCompletionSource({ dialect: sqlDialect, schema: namespace })(context)
    /** 内置 source 的词边界只识别 ASCII，中文前缀以真实光标范围补齐。 */
    const word = context.matchBefore(/[\p{L}\p{N}_$]+/u)
    const fallback: CompletionResult | null = word || context.explicit || qualifier
      ? { from: word?.from ?? context.pos, options: Object.values(namespace).map((item) => item.self), validFor: IDENTIFIER_PREFIX } : null
    const nativeOrUnicode = native ? { ...native, validFor: native.validFor && context.state.sliceDoc(native.from, context.pos).startsWith('`') ? native.validFor : IDENTIFIER_PREFIX } : fallback
    if (qualifier) return nativeOrUnicode ? { ...nativeOrUnicode, options: native?.options ?? (reference ? getColumns(schema, reference.table).map((column) => columnCompletion(column, dialect)) : []) } : null
    const rawKeywordResult = await keywords(context)
    /** 结构候选不参与过滤；SQLite 只去掉明确属于 MySQL 的关键字与函数。 */
    const keywordResult = rawKeywordResult && dialect !== 'mysql'
      ? { ...rawKeywordResult, options: rawKeywordResult.options.filter((item) => !MYSQL_ONLY_COMPLETIONS.has(item.label.toUpperCase())) }
      : rawKeywordResult
    if (tablePosition) return nativeOrUnicode ? { ...nativeOrUnicode, options: [...nativeOrUnicode.options.filter((item) => item.type === 'type'), ...(keywordResult?.options ?? [])] } : keywordResult
    /** 普通字段位置按本语句来源补齐，重名列用各自别名前缀区分。 */
    const counts = new Map<string, number>()
    for (const source of references) for (const column of getColumns(schema, source.table)) counts.set(column.name, (counts.get(column.name) ?? 0) + 1)
    const columns: Completion[] = []
    for (const source of references) {
      for (const column of getColumns(schema, source.table)) {
        const completion = columnCompletion(column, dialect)
        if ((counts.get(column.name) ?? 0) > 1) {
          completion.label = `${source.alias}.${column.name}`
          completion.apply = `${quoteIdentifier(source.alias, dialect)}.${quoteIdentifier(column.name, dialect)}`
        }
        columns.push(completion)
      }
    }
    const base = nativeOrUnicode ?? keywordResult
    return base ? { ...base, options: [...columns, ...(keywordResult?.options ?? []), ...(nativeOrUnicode?.options.filter((item) => item.type === 'type') ?? [])] } : null
  }
}
