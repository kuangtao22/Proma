/** 查询引用的源列或合法输出别名；`table` 保留 SQL 中的表名或别名限定符。 */
export interface ServerOpsSqlColumnReference {
  table?: string
  column: string
  /** 仅 GROUP BY/HAVING/ORDER BY 可引用的已声明输出别名，不是必须存在的物理列。 */
  outputAlias?: boolean
}

/** 经完整解析和规范重建后的只读查询计划。 */
export interface ServerOpsSqlQueryPlan {
  sql: string
  /** 供审计哈希的结构化语句；所有常量均已替换为 `?`。 */
  fingerprint: string
  tables: string[]
  columns: ServerOpsSqlColumnReference[]
  hasWildcard: boolean
}

type TokenKind = 'word' | 'quoted-identifier' | 'number' | 'string' | 'operator' | 'punctuation' | 'eof'

/** tokenizer 的最小 token；不保留原 SQL，避免错误路径回显字面值。 */
interface Token {
  kind: TokenKind
  value: string
}

interface ColumnExpression {
  kind: 'column'
  table?: string
  column: string
}

interface LiteralExpression {
  kind: 'literal'
  literalKind: 'number' | 'string' | 'null' | 'boolean'
  value: string
}

interface FunctionExpression {
  kind: 'function'
  name: string
  arguments: SqlExpression[]
}

interface WildcardExpression {
  kind: 'wildcard'
}

interface IntervalExpression {
  kind: 'interval'
  value: string
  unit: string
}

interface UnaryExpression {
  kind: 'unary'
  operator: string
  operand: SqlExpression
}

interface BinaryExpression {
  kind: 'binary'
  operator: string
  left: SqlExpression
  right: SqlExpression
}

interface BetweenExpression {
  kind: 'between'
  operand: SqlExpression
  lower: SqlExpression
  upper: SqlExpression
  negated: boolean
}

interface InExpression {
  kind: 'in'
  operand: SqlExpression
  values: SqlExpression[]
  negated: boolean
}

interface IsNullExpression {
  kind: 'is-null'
  operand: SqlExpression
  negated: boolean
}

interface LikeExpression {
  kind: 'like'
  left: SqlExpression
  right: SqlExpression
  negated: boolean
}

interface GroupExpression {
  kind: 'group'
  expression: SqlExpression
}

type SqlExpression = ColumnExpression | LiteralExpression | FunctionExpression | WildcardExpression
  | IntervalExpression | UnaryExpression | BinaryExpression | BetweenExpression | InExpression
  | IsNullExpression | LikeExpression | GroupExpression

interface SelectItem {
  expression: SqlExpression
  alias?: string
  projectionWildcard: boolean
}

interface TableReference {
  database?: string
  table: string
  alias?: string
}

interface JoinClause {
  type: 'JOIN' | 'INNER JOIN' | 'LEFT JOIN'
  table: TableReference
  on: SqlExpression
}

interface OrderItem {
  expression: SqlExpression
  direction?: 'ASC' | 'DESC'
}

interface LimitClause {
  count: number
  offset: number
}

/** 内部 AST 只通过 WeakMap 关联公开 plan，不扩展跨模块合同字段。 */
interface SelectStatement {
  select: SelectItem[]
  from: TableReference
  joins: JoinClause[]
  where?: SqlExpression
  groupBy: SqlExpression[]
  having?: SqlExpression
  orderBy: OrderItem[]
  limit?: LimitClause
}

/** tokenizer 与 AST 的固定预算，保证恶意输入只消耗有界 CPU/内存。 */
const MAX_SQL_BYTES = 16_384
const MAX_TOKENS = 2_048
const MAX_AST_NODES = 1_024
const MAX_EXPRESSION_DEPTH = 32
const MAX_JOINS = 8
const MAX_TABLES = 16
const MAX_LIST_ITEMS = 256
const MAX_OFFSET = 1_000_000

/** 安全内置函数白名单；名称统一按大写比较与渲染。 */
const SAFE_FUNCTIONS = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ROUND', 'ABS', 'COALESCE', 'IFNULL', 'NULLIF',
  'LOWER', 'UPPER', 'LENGTH', 'CHAR_LENGTH', 'CONCAT', 'SUBSTRING', 'DATE', 'DATE_FORMAT',
  'YEAR', 'MONTH', 'DAY', 'NOW', 'CURRENT_DATE', 'DATE_ADD', 'DATE_SUB',
])

/** INTERVAL 只接受固定时间单位，不允许表达式或动态单位。 */
const INTERVAL_UNITS = new Set([
  'MICROSECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR',
  'SECOND_MICROSECOND', 'MINUTE_MICROSECOND', 'MINUTE_SECOND', 'HOUR_MICROSECOND',
  'HOUR_SECOND', 'HOUR_MINUTE', 'DAY_MICROSECOND', 'DAY_SECOND', 'DAY_MINUTE', 'DAY_HOUR',
  'YEAR_MONTH',
])

/** 不能作为省略 AS 别名的结构关键字。 */
const ALIAS_BOUNDARIES = new Set([
  'FROM', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'ON', 'WHERE', 'GROUP', 'HAVING',
  'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTO', 'FOR', 'LOCK', 'ASC', 'DESC',
])

/** 会改变 SELECT 作用域、执行目标或表达式语义的未开放关键字。 */
const UNSUPPORTED_KEYWORDS = new Set([
  'WITH', 'UNION', 'INTERSECT', 'EXCEPT', 'INTO', 'OUTFILE', 'DUMPFILE', 'FOR', 'LOCK',
  'PROCEDURE', 'WINDOW', 'OVER', 'PARTITION', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'DISTINCT', 'ALL', 'HIGH_PRIORITY', 'STRAIGHT_JOIN', 'SQL_SMALL_RESULT', 'SQL_BIG_RESULT',
  'SQL_BUFFER_RESULT', 'SQL_NO_CACHE', 'SQL_CALC_FOUND_ROWS', 'NATURAL', 'RIGHT', 'CROSS',
  'USING', 'USE', 'FORCE', 'IGNORE', 'EXPLAIN', 'SHOW', 'CALL', 'DO', 'VALUES', 'COLLATE',
  'REGEXP', 'RLIKE', 'XOR', 'DIV', 'MOD', 'MATCH', 'AGAINST',
])

/** 永不允许读取的 MySQL 系统 schema。 */
const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

/** 公开 plan 与已验证 AST 的进程内关联。 */
const statementByPlan = new WeakMap<ServerOpsSqlQueryPlan, SelectStatement>()

/** 抛出不携带 SQL 或字面值的稳定错误。 */
function fail(code: string): never {
  throw new Error(code)
}

/** 判断 ASCII 单词起始字符。MySQL 非 ASCII 标识符须使用反引号。 */
function isWordStart(character: string): boolean {
  return /[A-Za-z_$]/u.test(character)
}

/** 判断 ASCII 单词后续字符。 */
function isWordPart(character: string): boolean {
  return /[A-Za-z0-9_$]/u.test(character)
}

/** 将 SQL 完整切分为有界 token；注释、变量和模式相关字符串在此直接拒绝。 */
function tokenize(sql: string): Token[] {
  if (new TextEncoder().encode(sql).byteLength > MAX_SQL_BYTES) fail('SERVER_OPS_SQL_TOO_LARGE')
  const tokens: Token[] = []
  let index = 0

  /** 每次压入都检查 token 预算。 */
  const push = (token: Token): void => {
    tokens.push(token)
    if (tokens.length > MAX_TOKENS) fail('SERVER_OPS_SQL_TOO_COMPLEX')
  }

  while (index < sql.length) {
    const character = sql[index] ?? ''
    if (/\s/u.test(character)) {
      index += 1
      continue
    }
    const next = sql[index + 1] ?? ''
    if ((character === '-' && next === '-') || (character === '/' && next === '*') || character === '#') {
      fail('SERVER_OPS_SQL_COMMENTS_UNSUPPORTED')
    }
    if (character === '@') fail('SERVER_OPS_SQL_VARIABLE_UNSUPPORTED')
    if (character === '\\' || character === '"') fail('SERVER_OPS_SQL_STRING_MODE_UNSAFE')

    if (character === '`') {
      let value = ''
      index += 1
      let closed = false
      while (index < sql.length) {
        const current = sql[index] ?? ''
        if (current === '`') {
          if (sql[index + 1] === '`') {
            value += '`'
            index += 2
            continue
          }
          index += 1
          closed = true
          break
        }
        if (/[\u0000-\u001f\u007f]/u.test(current)) fail('SERVER_OPS_SQL_INVALID_IDENTIFIER')
        value += current
        index += 1
      }
      if (!closed || value.length === 0 || value.length > 128) fail('SERVER_OPS_SQL_INVALID_IDENTIFIER')
      push({ kind: 'quoted-identifier', value })
      continue
    }

    if (character === "'") {
      let value = ''
      index += 1
      let closed = false
      while (index < sql.length) {
        const current = sql[index] ?? ''
        if (current === '\\') fail('SERVER_OPS_SQL_STRING_MODE_UNSAFE')
        if (current === "'") {
          if (sql[index + 1] === "'") {
            value += "'"
            index += 2
            continue
          }
          index += 1
          closed = true
          break
        }
        if (current === '\u0000') fail('SERVER_OPS_SQL_INVALID')
        value += current
        index += 1
      }
      if (!closed || new TextEncoder().encode(value).byteLength > 4_096) fail('SERVER_OPS_SQL_INVALID_LITERAL')
      push({ kind: 'string', value })
      continue
    }

    if (/[0-9]/u.test(character)) {
      const start = index
      while (/[0-9]/u.test(sql[index] ?? '')) index += 1
      if (sql[index] === '.' && /[0-9]/u.test(sql[index + 1] ?? '')) {
        index += 1
        while (/[0-9]/u.test(sql[index] ?? '')) index += 1
      }
      push({ kind: 'number', value: sql.slice(start, index) })
      continue
    }

    if (isWordStart(character)) {
      const start = index
      index += 1
      while (isWordPart(sql[index] ?? '')) index += 1
      const value = sql.slice(start, index)
      if (value.length > 128) fail('SERVER_OPS_SQL_INVALID_IDENTIFIER')
      push({ kind: 'word', value })
      continue
    }

    const twoCharacters = `${character}${next}`
    if (['<=', '>=', '<>', '!='].includes(twoCharacters)) {
      push({ kind: 'operator', value: twoCharacters })
      index += 2
      continue
    }
    if (['=', '<', '>', '+', '-', '*', '/', '%'].includes(character)) {
      push({ kind: 'operator', value: character })
      index += 1
      continue
    }
    if (['(', ')', ',', '.', ';'].includes(character)) {
      push({ kind: 'punctuation', value: character })
      index += 1
      continue
    }
    fail('SERVER_OPS_SQL_INVALID')
  }
  push({ kind: 'eof', value: '' })
  return tokens
}

/** 有界递归下降 + Pratt parser。 */
class SqlParser {
  private index = 0
  private nodeCount = 0
  private readonly columnReferences: ServerOpsSqlColumnReference[] = []
  private readonly columnReferenceKeys = new Set<string>()
  private readonly tableQualifiers = new Set<string>()
  /** 投影全部解析后建立的别名集合，不用于放行 WHERE 或 JOIN 的源列。 */
  private readonly projectionAliases = new Set<string>()
  /** 只在 MySQL 允许引用输出别名的尾部子句中开启。 */
  private acceptsProjectionAlias = false
  private hasProjectionWildcard = false

  constructor(
    private readonly tokens: Token[],
    private readonly database: string,
  ) {}

  /** 解析整条单 SELECT，并要求消费全部 token。 */
  parse(): { statement: SelectStatement; columns: ServerOpsSqlColumnReference[]; hasWildcard: boolean } {
    if (SYSTEM_SCHEMAS.has(this.database.toLowerCase())) fail('SERVER_OPS_SQL_SYSTEM_SCHEMA')
    if (this.tokens.some((token) => token.kind === 'word' && UNSUPPORTED_KEYWORDS.has(token.value.toUpperCase()))) {
      fail('SERVER_OPS_SQL_UNSUPPORTED')
    }
    this.expectWord('SELECT')
    const select = this.parseSelectItems()
    this.expectWord('FROM')
    const from = this.parseTableReference()
    this.registerTableQualifier(from)

    const joins: JoinClause[] = []
    while (this.matchesWord('JOIN') || this.matchesWord('INNER') || this.matchesWord('LEFT')) {
      if (joins.length >= MAX_JOINS) fail('SERVER_OPS_SQL_TOO_COMPLEX')
      let type: JoinClause['type']
      if (this.consumeWord('JOIN')) {
        type = 'JOIN'
      } else if (this.consumeWord('INNER')) {
        this.expectWord('JOIN')
        type = 'INNER JOIN'
      } else {
        this.expectWord('LEFT')
        this.consumeWord('OUTER')
        this.expectWord('JOIN')
        type = 'LEFT JOIN'
      }
      const table = this.parseTableReference()
      this.registerTableQualifier(table)
      this.expectWord('ON')
      joins.push({ type, table, on: this.parseExpression() })
    }
    if (joins.length + 1 > MAX_TABLES) fail('SERVER_OPS_SQL_TOO_COMPLEX')

    const where = this.consumeWord('WHERE') ? this.parseExpression() : undefined
    for (const item of select) {
      if (item.alias !== undefined) this.projectionAliases.add(item.alias.toLowerCase())
    }
    this.acceptsProjectionAlias = true
    const groupBy: SqlExpression[] = []
    if (this.consumeWord('GROUP')) {
      this.expectWord('BY')
      groupBy.push(...this.parseExpressionList())
    }
    const having = this.consumeWord('HAVING') ? this.parseExpression() : undefined
    const orderBy: OrderItem[] = []
    if (this.consumeWord('ORDER')) {
      this.expectWord('BY')
      do {
        const expression = this.parseExpression()
        const direction = this.consumeWord('ASC') ? 'ASC' : this.consumeWord('DESC') ? 'DESC' : undefined
        orderBy.push({ expression, ...(direction === undefined ? {} : { direction }) })
        if (orderBy.length > MAX_LIST_ITEMS) fail('SERVER_OPS_SQL_TOO_COMPLEX')
      } while (this.consumePunctuation(','))
    }
    const limit = this.consumeWord('LIMIT') ? this.parseLimit() : undefined
    this.consumePunctuation(';')
    if (this.peek().kind !== 'eof') fail('SERVER_OPS_SQL_UNSUPPORTED')
    this.validateColumnQualifiers()
    return {
      statement: {
        select,
        from,
        joins,
        ...(where === undefined ? {} : { where }),
        groupBy,
        ...(having === undefined ? {} : { having }),
        orderBy,
        ...(limit === undefined ? {} : { limit }),
      },
      columns: this.columnReferences,
      hasWildcard: this.hasProjectionWildcard,
    }
  }

  /** 解析 SELECT 投影及可选别名。 */
  private parseSelectItems(): SelectItem[] {
    const items: SelectItem[] = []
    do {
      let expression: SqlExpression
      let projectionWildcard = false
      if (this.consumeOperator('*')) {
        expression = this.node({ kind: 'wildcard' })
        projectionWildcard = true
        this.recordColumn(undefined, '*')
      } else if (this.isQualifiedWildcard()) {
        const table = this.parseIdentifier()
        this.expectPunctuation('.')
        this.expectOperator('*')
        expression = this.node({ kind: 'column', table, column: '*' })
        projectionWildcard = true
        this.recordColumn(table, '*')
      } else {
        expression = this.parseExpression()
      }
      let alias: string | undefined
      if (this.consumeWord('AS')) {
        alias = this.parseIdentifier()
      } else if (this.canConsumeAlias()) {
        alias = this.parseIdentifier()
      }
      if (alias !== undefined && isServerOpsSqlSensitiveColumn(alias)) fail('SERVER_OPS_SQL_SENSITIVE_COLUMN')
      items.push({ expression, ...(alias === undefined ? {} : { alias }), projectionWildcard })
      if (projectionWildcard) this.hasProjectionWildcard = true
      if (items.length > MAX_LIST_ITEMS) fail('SERVER_OPS_SQL_TOO_COMPLEX')
    } while (this.consumePunctuation(','))
    if (items.length === 0) fail('SERVER_OPS_SQL_INVALID')
    return items
  }

  /** 解析基础表；仅允许当前库限定，不允许子查询或函数表。 */
  private parseTableReference(): TableReference {
    if (this.matchesPunctuation('(')) fail('SERVER_OPS_SQL_SUBQUERY_UNSUPPORTED')
    const first = this.parseIdentifier()
    let database: string | undefined
    let table = first
    if (this.consumePunctuation('.')) {
      database = first
      table = this.parseIdentifier()
      if (database !== this.database) fail('SERVER_OPS_SQL_CROSS_DATABASE')
    }
    if (SYSTEM_SCHEMAS.has((database ?? this.database).toLowerCase())) fail('SERVER_OPS_SQL_SYSTEM_SCHEMA')
    let alias: string | undefined
    if (this.consumeWord('AS')) {
      alias = this.parseIdentifier()
    } else if (this.canConsumeAlias()) {
      alias = this.parseIdentifier()
    }
    return { ...(database === undefined ? {} : { database }), table, ...(alias === undefined ? {} : { alias }) }
  }

  /** 注册表名与别名，供列限定符完整性检查。 */
  private registerTableQualifier(table: TableReference): void {
    this.tableQualifiers.add(table.table.toLowerCase())
    if (table.alias !== undefined) this.tableQualifiers.add(table.alias.toLowerCase())
  }

  /** 解析逗号分隔表达式列表。 */
  private parseExpressionList(): SqlExpression[] {
    const expressions: SqlExpression[] = []
    do {
      expressions.push(this.parseExpression())
      if (expressions.length > MAX_LIST_ITEMS) fail('SERVER_OPS_SQL_TOO_COMPLEX')
    } while (this.consumePunctuation(','))
    return expressions
  }

  /** Pratt 解析表达式，并按深度与节点总数双重限流。 */
  private parseExpression(minimumPrecedence = 0, depth = 0): SqlExpression {
    if (depth > MAX_EXPRESSION_DEPTH) fail('SERVER_OPS_SQL_TOO_COMPLEX')
    let left = this.parsePrefix(depth + 1)
    while (true) {
      /** readInfixOperator 会消费 token；优先级不足时必须恢复到窥视前位置。 */
      const operatorIndex = this.index
      const operator = this.readInfixOperator()
      if (operator === undefined) break
      if (operator.precedence < minimumPrecedence) {
        this.index = operatorIndex
        break
      }
      if (operator.kind === 'between') {
        const lower = this.parseExpression(operator.precedence + 1, depth + 1)
        this.expectWord('AND')
        const upper = this.parseExpression(operator.precedence + 1, depth + 1)
        left = this.node({ kind: 'between', operand: left, lower, upper, negated: operator.negated })
        continue
      }
      if (operator.kind === 'in') {
        this.expectPunctuation('(')
        if (this.matchesWord('SELECT')) fail('SERVER_OPS_SQL_SUBQUERY_UNSUPPORTED')
        const values = this.parseExpressionList()
        this.expectPunctuation(')')
        left = this.node({ kind: 'in', operand: left, values, negated: operator.negated })
        continue
      }
      if (operator.kind === 'is-null') {
        left = this.node({ kind: 'is-null', operand: left, negated: operator.negated })
        continue
      }
      const right = this.parseExpression(operator.precedence + 1, depth + 1)
      if (operator.kind === 'like') {
        left = this.node({ kind: 'like', left, right, negated: operator.negated })
        continue
      }
      if (operator.kind !== 'binary') fail('SERVER_OPS_SQL_INVALID_EXPRESSION')
      left = this.node({ kind: 'binary', operator: operator.operator, left, right })
    }
    return left
  }

  /** 解析表达式前缀、字面值、列引用与白名单函数。 */
  private parsePrefix(depth: number): SqlExpression {
    const token = this.peek()
    if (this.consumeWord('NOT')) return this.node({ kind: 'unary', operator: 'NOT', operand: this.parseExpression(6, depth + 1) })
    if (this.consumeOperator('+')) return this.node({ kind: 'unary', operator: '+', operand: this.parseExpression(6, depth + 1) })
    if (this.consumeOperator('-')) return this.node({ kind: 'unary', operator: '-', operand: this.parseExpression(6, depth + 1) })
    if (this.consumePunctuation('(')) {
      if (this.matchesWord('SELECT')) fail('SERVER_OPS_SQL_SUBQUERY_UNSUPPORTED')
      const expression = this.parseExpression(0, depth + 1)
      this.expectPunctuation(')')
      return this.node({ kind: 'group', expression })
    }
    if (token.kind === 'number') {
      this.index += 1
      return this.node({ kind: 'literal', literalKind: 'number', value: token.value })
    }
    if (token.kind === 'string') {
      this.index += 1
      return this.node({ kind: 'literal', literalKind: 'string', value: token.value })
    }
    if (this.consumeWord('NULL')) return this.node({ kind: 'literal', literalKind: 'null', value: 'NULL' })
    if (this.consumeWord('TRUE')) return this.node({ kind: 'literal', literalKind: 'boolean', value: 'TRUE' })
    if (this.consumeWord('FALSE')) return this.node({ kind: 'literal', literalKind: 'boolean', value: 'FALSE' })
    if (this.consumeWord('INTERVAL')) return this.parseInterval()
    if (token.kind !== 'word' && token.kind !== 'quoted-identifier') fail('SERVER_OPS_SQL_INVALID_EXPRESSION')

    const first = this.parseIdentifier()
    if (this.matchesPunctuation('(')) {
      // 引用形式可能指向同名存储函数；只有裸白名单内置函数允许执行。
      if (token.kind !== 'word') fail('SERVER_OPS_SQL_FUNCTION_UNSUPPORTED')
      return this.parseFunction(first, depth + 1)
    }
    if (token.kind === 'word' && first.toUpperCase() === 'CURRENT_DATE') return this.node({ kind: 'function', name: 'CURRENT_DATE', arguments: [] })
    if (this.consumePunctuation('.')) {
      if (this.matchesOperator('*')) fail('SERVER_OPS_SQL_WILDCARD_POSITION')
      const column = this.parseIdentifier()
      if (this.matchesPunctuation('.')) fail('SERVER_OPS_SQL_CROSS_DATABASE')
      this.recordColumn(first, column)
      return this.node({ kind: 'column', table: first, column })
    }
    this.recordColumn(undefined, first)
    return this.node({ kind: 'column', column: first })
  }

  /** 解析函数调用；未知函数、限定函数和不合法通配参数全部拒绝。 */
  private parseFunction(name: string, depth: number): SqlExpression {
    const normalizedName = name.toUpperCase()
    if (!SAFE_FUNCTIONS.has(normalizedName)) fail('SERVER_OPS_SQL_FUNCTION_UNSUPPORTED')
    this.expectPunctuation('(')
    const argumentsList: SqlExpression[] = []
    if (!this.consumePunctuation(')')) {
      if (this.consumeOperator('*')) {
        if (normalizedName !== 'COUNT') fail('SERVER_OPS_SQL_WILDCARD_POSITION')
        argumentsList.push(this.node({ kind: 'wildcard' }))
      } else {
        do {
          argumentsList.push(this.parseExpression(0, depth + 1))
          if (argumentsList.length > 32) fail('SERVER_OPS_SQL_TOO_COMPLEX')
        } while (this.consumePunctuation(','))
      }
      this.expectPunctuation(')')
    }
    this.validateFunctionArguments(normalizedName, argumentsList)
    return this.node({ kind: 'function', name: normalizedName, arguments: argumentsList })
  }

  /** 对函数参数个数和特殊 INTERVAL 位置做保守校验。 */
  private validateFunctionArguments(name: string, argumentsList: SqlExpression[]): void {
    const count = argumentsList.length
    if ((name === 'NOW' || name === 'CURRENT_DATE') && count !== 0) fail('SERVER_OPS_SQL_FUNCTION_ARGUMENTS')
    if (['LOWER', 'UPPER', 'LENGTH', 'CHAR_LENGTH', 'DATE', 'YEAR', 'MONTH', 'DAY', 'ABS'].includes(name) && count !== 1) {
      fail('SERVER_OPS_SQL_FUNCTION_ARGUMENTS')
    }
    if (['IFNULL', 'NULLIF', 'DATE_FORMAT'].includes(name) && count !== 2) fail('SERVER_OPS_SQL_FUNCTION_ARGUMENTS')
    if ((name === 'DATE_ADD' || name === 'DATE_SUB')
      && (count !== 2 || argumentsList[1]?.kind !== 'interval')) fail('SERVER_OPS_SQL_FUNCTION_ARGUMENTS')
    if (name === 'ROUND' && (count < 1 || count > 2)) fail('SERVER_OPS_SQL_FUNCTION_ARGUMENTS')
    if (name === 'SUBSTRING' && (count < 2 || count > 3)) fail('SERVER_OPS_SQL_FUNCTION_ARGUMENTS')
    if (['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].includes(name) && count !== 1) fail('SERVER_OPS_SQL_FUNCTION_ARGUMENTS')
    if (['COALESCE', 'CONCAT'].includes(name) && count < 1) fail('SERVER_OPS_SQL_FUNCTION_ARGUMENTS')
  }

  /** 解析固定整数 INTERVAL。 */
  private parseInterval(): IntervalExpression {
    const value = this.peek()
    if (value.kind !== 'number' || value.value.includes('.')) fail('SERVER_OPS_SQL_INTERVAL_UNSUPPORTED')
    this.index += 1
    const unit = this.parseIdentifier().toUpperCase()
    if (!INTERVAL_UNITS.has(unit)) fail('SERVER_OPS_SQL_INTERVAL_UNSUPPORTED')
    return this.node({ kind: 'interval', value: value.value, unit })
  }

  /** 查看并消费当前中缀运算符。 */
  private readInfixOperator():
    | { kind: 'binary'; operator: string; precedence: number }
    | { kind: 'between' | 'in' | 'like' | 'is-null'; precedence: number; negated: boolean }
    | undefined {
    if (this.consumeWord('OR')) return { kind: 'binary', operator: 'OR', precedence: 1 }
    if (this.consumeWord('AND')) return { kind: 'binary', operator: 'AND', precedence: 2 }
    if (this.consumeWord('IS')) {
      const negated = this.consumeWord('NOT')
      this.expectWord('NULL')
      return { kind: 'is-null', precedence: 3, negated }
    }
    if (this.consumeWord('BETWEEN')) return { kind: 'between', precedence: 3, negated: false }
    if (this.consumeWord('IN')) return { kind: 'in', precedence: 3, negated: false }
    if (this.consumeWord('LIKE')) return { kind: 'like', precedence: 3, negated: false }
    if (this.matchesWord('NOT')) {
      const following = this.peek(1).value.toUpperCase()
      if (following === 'BETWEEN' || following === 'IN' || following === 'LIKE') {
        this.index += 2
        return { kind: following === 'BETWEEN' ? 'between' : following === 'IN' ? 'in' : 'like', precedence: 3, negated: true }
      }
    }
    const operator = this.peek()
    if (operator.kind === 'operator' && ['=', '<', '>', '<=', '>=', '<>', '!='].includes(operator.value)) {
      this.index += 1
      return { kind: 'binary', operator: operator.value, precedence: 3 }
    }
    if (operator.kind === 'operator' && ['+', '-'].includes(operator.value)) {
      this.index += 1
      return { kind: 'binary', operator: operator.value, precedence: 4 }
    }
    if (operator.kind === 'operator' && ['*', '/', '%'].includes(operator.value)) {
      this.index += 1
      return { kind: 'binary', operator: operator.value, precedence: 5 }
    }
    return undefined
  }

  /** 解析 MySQL 两种 LIMIT 写法，并限制 OFFSET。 */
  private parseLimit(): LimitClause {
    const first = this.parseUnsignedInteger('SERVER_OPS_SQL_LIMIT_INVALID')
    let count = first
    let offset = 0
    if (this.consumePunctuation(',')) {
      offset = first
      count = this.parseUnsignedInteger('SERVER_OPS_SQL_LIMIT_INVALID')
    } else if (this.consumeWord('OFFSET')) {
      offset = this.parseUnsignedInteger('SERVER_OPS_SQL_LIMIT_INVALID')
    }
    if (count < 1 || offset > MAX_OFFSET) fail('SERVER_OPS_SQL_LIMIT_INVALID')
    return { count, offset }
  }

  /** 读取安全整数 token。 */
  private parseUnsignedInteger(errorCode: string): number {
    const token = this.peek()
    if (token.kind !== 'number' || token.value.includes('.')) fail(errorCode)
    this.index += 1
    const value = Number(token.value)
    if (!Number.isSafeInteger(value) || value < 0) fail(errorCode)
    return value
  }

  /** 记录并去重列引用，敏感字段在首次出现时立即拒绝。 */
  private recordColumn(table: string | undefined, column: string): void {
    if (column !== '*' && isServerOpsSqlSensitiveColumn(column)) fail('SERVER_OPS_SQL_SENSITIVE_COLUMN')
    /** 同名源列和输出别名分别记录，避免后出现的别名吞掉 WHERE/JOIN 校验。 */
    const outputAlias = this.acceptsProjectionAlias && table === undefined && this.projectionAliases.has(column.toLowerCase())
    const key = `${table?.toLowerCase() ?? ''}\u0000${column.toLowerCase()}\u0000${outputAlias}`
    if (this.columnReferenceKeys.has(key)) return
    this.columnReferenceKeys.add(key)
    this.columnReferences.push({ ...(table === undefined ? {} : { table }), column, ...(outputAlias ? { outputAlias: true } : {}) })
  }

  /** 全部表解析完成后验证限定列只引用已声明表或别名。 */
  private validateColumnQualifiers(): void {
    for (const column of this.columnReferences) {
      if (column.table !== undefined && !this.tableQualifiers.has(column.table.toLowerCase())) {
        fail('SERVER_OPS_SQL_UNKNOWN_TABLE_ALIAS')
      }
    }
  }

  /** 注册 AST 节点并执行总复杂度预算。 */
  private node<T extends SqlExpression>(node: T): T {
    this.nodeCount += 1
    if (this.nodeCount > MAX_AST_NODES) fail('SERVER_OPS_SQL_TOO_COMPLEX')
    return node
  }

  /** 当前是否为 `identifier.*` 投影。 */
  private isQualifiedWildcard(): boolean {
    const first = this.peek()
    return (first.kind === 'word' || first.kind === 'quoted-identifier')
      && this.peek(1).value === '.'
      && this.peek(2).value === '*'
  }

  /** 当前 token 是否可作为省略 AS 的别名。 */
  private canConsumeAlias(): boolean {
    const token = this.peek()
    if (token.kind === 'quoted-identifier') return true
    return token.kind === 'word' && !ALIAS_BOUNDARIES.has(token.value.toUpperCase())
  }

  /** 读取标识符；未引用关键字仍由所在语法位置控制。 */
  private parseIdentifier(): string {
    const token = this.peek()
    if (token.kind !== 'word' && token.kind !== 'quoted-identifier') fail('SERVER_OPS_SQL_INVALID_IDENTIFIER')
    this.index += 1
    return token.value
  }

  /** 查看相对当前位置 token。 */
  private peek(offset = 0): Token {
    return this.tokens[this.index + offset] ?? { kind: 'eof', value: '' }
  }

  private matchesWord(word: string): boolean {
    const token = this.peek()
    return token.kind === 'word' && token.value.toUpperCase() === word
  }

  private consumeWord(word: string): boolean {
    if (!this.matchesWord(word)) return false
    this.index += 1
    return true
  }

  private expectWord(word: string): void {
    if (!this.consumeWord(word)) fail('SERVER_OPS_SQL_UNSUPPORTED')
  }

  private matchesOperator(operator: string): boolean {
    const token = this.peek()
    return token.kind === 'operator' && token.value === operator
  }

  private consumeOperator(operator: string): boolean {
    if (!this.matchesOperator(operator)) return false
    this.index += 1
    return true
  }

  private expectOperator(operator: string): void {
    if (!this.consumeOperator(operator)) fail('SERVER_OPS_SQL_INVALID_EXPRESSION')
  }

  private matchesPunctuation(punctuation: string): boolean {
    const token = this.peek()
    return token.kind === 'punctuation' && token.value === punctuation
  }

  private consumePunctuation(punctuation: string): boolean {
    if (!this.matchesPunctuation(punctuation)) return false
    this.index += 1
    return true
  }

  private expectPunctuation(punctuation: string): void {
    if (!this.consumePunctuation(punctuation)) fail('SERVER_OPS_SQL_INVALID_EXPRESSION')
  }
}

/** 判断列名是否属于常见凭据、令牌或密钥字段。 */
export function isServerOpsSqlSensitiveColumn(name: string): boolean {
  // 保留既有 Agent 行预览的全部保护词，SQL 不能成为较宽松的绕行入口。
  if (/(pass(word)?|secret|token|api[_-]?key|credential|private[_-]?key|authorization|cookie|session)/iu.test(name)) return true
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
  const segments = normalized.split('_').filter(Boolean)
  if (segments.some((segment) => ['pass', 'password', 'passwd', 'pwd', 'passphrase', 'token', 'secret', 'credential'].includes(segment))) return true
  if (segments.includes('key') && segments.some((segment) => ['api', 'access', 'private', 'client', 'auth', 'session', 'encryption', 'signing'].includes(segment))) return true
  return ['apikey', 'accesstoken', 'refreshtoken', 'clientsecret', 'privatekey'].includes(normalized.replaceAll('_', ''))
}

/** 分析一条单 SELECT，并返回从 AST 规范重建的查询计划。 */
export function analyzeServerOpsSqlQuery(sql: string, database: string): ServerOpsSqlQueryPlan {
  if (typeof sql !== 'string'
    || typeof database !== 'string'
    || database.length === 0
    || database.length > 64
    || /[\u0000-\u001f\u007f]/u.test(database)) {
    fail('SERVER_OPS_SQL_INVALID')
  }
  const parser = new SqlParser(tokenize(sql), database)
  const parsed = parser.parse()
  const plan: ServerOpsSqlQueryPlan = {
    sql: renderStatement(parsed.statement),
    fingerprint: renderStatement(parsed.statement, true),
    tables: collectTables(parsed.statement),
    columns: parsed.columns,
    hasWildcard: parsed.hasWildcard,
  }
  statementByPlan.set(plan, parsed.statement)
  return plan
}

/** 给顶层查询加 `maxRows + 1` 探测行；用户更小 LIMIT 保持原意。 */
export function limitServerOpsSqlQuery(plan: ServerOpsSqlQueryPlan, maxRows: number): string {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 200) fail('SERVER_OPS_SQL_LIMIT_INVALID')
  const statement = statementByPlan.get(plan)
  if (statement === undefined) fail('SERVER_OPS_SQL_PLAN_INVALID')
  const existingLimit = statement.limit
  const limit = existingLimit !== undefined && existingLimit.count <= maxRows
    ? existingLimit
    : { count: maxRows + 1, offset: existingLimit?.offset ?? 0 }
  return renderStatement({ ...statement, limit })
}

/** 按首次出现顺序收集真实基础表，别名不进入授权集合。 */
function collectTables(statement: SelectStatement): string[] {
  const tables = [statement.from.table, ...statement.joins.map((join) => join.table.table)]
  return tables.filter((table, index) => tables.indexOf(table) === index)
}

/** MySQL 标识符统一反引号输出，内部反引号双写。 */
function renderIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``
}

/** 字符串统一单引号输出，内部单引号双写。 */
function renderString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** 渲染完整 SELECT；所有片段均来自已验证 AST。 */
function renderStatement(statement: SelectStatement, redactLiterals = false): string {
  const parts = [
    `SELECT ${statement.select.map((item) => renderSelectItem(item, redactLiterals)).join(', ')}`,
    `FROM ${renderTable(statement.from)}`,
  ]
  for (const join of statement.joins) parts.push(`${join.type} ${renderTable(join.table)} ON ${renderExpression(join.on, 0, redactLiterals)}`)
  if (statement.where !== undefined) parts.push(`WHERE ${renderExpression(statement.where, 0, redactLiterals)}`)
  if (statement.groupBy.length > 0) parts.push(`GROUP BY ${statement.groupBy.map((expression) => renderExpression(expression, 0, redactLiterals)).join(', ')}`)
  if (statement.having !== undefined) parts.push(`HAVING ${renderExpression(statement.having, 0, redactLiterals)}`)
  if (statement.orderBy.length > 0) {
    parts.push(`ORDER BY ${statement.orderBy.map((item) => `${renderExpression(item.expression, 0, redactLiterals)}${item.direction === undefined ? '' : ` ${item.direction}`}`).join(', ')}`)
  }
  if (statement.limit !== undefined) {
    const count = redactLiterals ? '?' : String(statement.limit.count)
    const offset = redactLiterals ? '?' : String(statement.limit.offset)
    parts.push(`LIMIT ${count}${statement.limit.offset === 0 ? '' : ` OFFSET ${offset}`}`)
  }
  return parts.join(' ')
}

/** 渲染投影及别名。 */
function renderSelectItem(item: SelectItem, redactLiterals: boolean): string {
  const expression = renderExpression(item.expression, 0, redactLiterals)
  return item.alias === undefined ? expression : `${expression} AS ${renderIdentifier(item.alias)}`
}

/** 渲染基础表及别名。 */
function renderTable(table: TableReference): string {
  const qualified = table.database === undefined
    ? renderIdentifier(table.table)
    : `${renderIdentifier(table.database)}.${renderIdentifier(table.table)}`
  return table.alias === undefined ? qualified : `${qualified} AS ${renderIdentifier(table.alias)}`
}

/** 表达式运算符优先级，用于仅在必要时补括号。 */
function expressionPrecedence(expression: SqlExpression): number {
  if (expression.kind === 'binary') {
    if (expression.operator === 'OR') return 1
    if (expression.operator === 'AND') return 2
    if (['=', '<', '>', '<=', '>=', '<>', '!='].includes(expression.operator)) return 3
    if (['+', '-'].includes(expression.operator)) return 4
    return 5
  }
  if (['between', 'in', 'is-null', 'like'].includes(expression.kind)) return 3
  if (expression.kind === 'unary') return 6
  return 7
}

/** 递归渲染表达式，保证重建 SQL 仍遵守原 AST 优先级。 */
function renderExpression(expression: SqlExpression, parentPrecedence = 0, redactLiterals = false): string {
  const precedence = expressionPrecedence(expression)
  let rendered: string
  switch (expression.kind) {
    case 'column':
      rendered = expression.table === undefined
        ? renderIdentifier(expression.column)
        : `${renderIdentifier(expression.table)}.${expression.column === '*' ? '*' : renderIdentifier(expression.column)}`
      break
    case 'literal':
      rendered = redactLiterals ? '?' : expression.literalKind === 'string' ? renderString(expression.value) : expression.value
      break
    case 'function':
      rendered = `${expression.name}(${expression.arguments.map((argument) => renderExpression(argument, 0, redactLiterals)).join(', ')})`
      break
    case 'wildcard':
      rendered = '*'
      break
    case 'interval':
      rendered = `INTERVAL ${redactLiterals ? '?' : expression.value} ${expression.unit}`
      break
    case 'unary':
      rendered = expression.operator === 'NOT'
        ? `NOT ${renderExpression(expression.operand, precedence, redactLiterals)}`
        : `${expression.operator}${renderExpression(expression.operand, precedence, redactLiterals)}`
      break
    case 'binary':
      rendered = `${renderExpression(expression.left, precedence, redactLiterals)} ${expression.operator} ${renderExpression(expression.right, precedence + 1, redactLiterals)}`
      break
    case 'between':
      rendered = `${renderExpression(expression.operand, precedence, redactLiterals)}${expression.negated ? ' NOT' : ''} BETWEEN ${renderExpression(expression.lower, precedence + 1, redactLiterals)} AND ${renderExpression(expression.upper, precedence + 1, redactLiterals)}`
      break
    case 'in':
      rendered = `${renderExpression(expression.operand, precedence, redactLiterals)}${expression.negated ? ' NOT' : ''} IN (${expression.values.map((value) => renderExpression(value, 0, redactLiterals)).join(', ')})`
      break
    case 'is-null':
      rendered = `${renderExpression(expression.operand, precedence, redactLiterals)} IS${expression.negated ? ' NOT' : ''} NULL`
      break
    case 'like':
      rendered = `${renderExpression(expression.left, precedence, redactLiterals)}${expression.negated ? ' NOT' : ''} LIKE ${renderExpression(expression.right, precedence + 1, redactLiterals)}`
      break
    case 'group':
      rendered = `(${renderExpression(expression.expression, 0, redactLiterals)})`
      break
  }
  return precedence < parentPrecedence ? `(${rendered})` : rendered
}
