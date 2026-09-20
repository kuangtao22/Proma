import { describe, expect, test } from 'bun:test'
import {
  analyzeServerOpsSqlQuery,
  getServerOpsSqlDiagnostic,
  isServerOpsSqlParserError,
  isServerOpsSqlSensitiveColumn,
  limitServerOpsSqlQuery,
  validateServerOpsSqlQuery,
} from './server-ops-sql-parser'

describe('MySQL 只读 SQL 解析器', () => {
  test('Given JOIN、聚合与筛选查询 When 分析 Then 返回真实表列并规范重建 SQL', () => {
    const plan = analyzeServerOpsSqlQuery(`
      select u.id, lower(u.name) as normalized_name, count(o.id) total
      from app.users u
      left join orders as o on o.user_id = u.id
      where u.status in ('active', 'trial') and o.created_at between date_sub(now(), interval 30 day) and now()
      group by u.id, u.name
      having count(o.id) > 0
      order by total desc, u.id asc
      limit 100 offset 20
    `, 'app')

    expect(plan.tables).toEqual(['users', 'orders'])
    expect(plan.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'u', column: 'id' }),
      expect.objectContaining({ table: 'u', column: 'name' }),
      expect.objectContaining({ table: 'o', column: 'id' }),
      expect.objectContaining({ table: 'o', column: 'user_id' }),
      expect.objectContaining({ table: 'u', column: 'status' }),
      expect.objectContaining({ table: 'o', column: 'created_at' }),
      expect.objectContaining({ column: 'total', outputAlias: true }),
    ]))
    expect(plan.hasWildcard).toBe(false)
    expect(plan.sql).toBe("SELECT `u`.`id`, LOWER(`u`.`name`) AS `normalized_name`, COUNT(`o`.`id`) AS `total` FROM `app`.`users` AS `u` LEFT JOIN `orders` AS `o` ON `o`.`user_id` = `u`.`id` WHERE `u`.`status` IN ('active', 'trial') AND `o`.`created_at` BETWEEN DATE_SUB(NOW(), INTERVAL 30 DAY) AND NOW() GROUP BY `u`.`id`, `u`.`name` HAVING COUNT(`o`.`id`) > 0 ORDER BY `total` DESC, `u`.`id` ASC LIMIT 100 OFFSET 20")
    expect(plan.fingerprint).toBe('SELECT `u`.`id`, LOWER(`u`.`name`) AS `normalized_name`, COUNT(`o`.`id`) AS `total` FROM `app`.`users` AS `u` LEFT JOIN `orders` AS `o` ON `o`.`user_id` = `u`.`id` WHERE `u`.`status` IN (?, ?) AND `o`.`created_at` BETWEEN DATE_SUB(NOW(), INTERVAL ? DAY) AND NOW() GROUP BY `u`.`id`, `u`.`name` HAVING COUNT(`o`.`id`) > ? ORDER BY `total` DESC, `u`.`id` ASC LIMIT ? OFFSET ?')
  })

  test('Given 通配列与反引号/引号转义 When 分析 Then 保留安全语义且不把别名当表', () => {
    const plan = analyzeServerOpsSqlQuery("SELECT `t`.*, CONCAT(`first`, 'O''Reilly') AS `display` FROM `odd``table` AS `t` WHERE `t`.`deleted_at` IS NULL", 'app')
    expect(plan.tables).toEqual(['odd`table'])
    expect(plan.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 't', column: '*' }),
      expect.objectContaining({ column: 'first' }),
      expect.objectContaining({ table: 't', column: 'deleted_at' }),
    ]))
    expect(plan.hasWildcard).toBe(true)
    expect(plan.sql).toBe("SELECT `t`.*, CONCAT(`first`, 'O''Reilly') AS `display` FROM `odd``table` AS `t` WHERE `t`.`deleted_at` IS NULL")
    expect(plan.fingerprint).not.toContain("O''Reilly")
  })

  test('Given 无 LIMIT 或用户 LIMIT When 限行 Then 仅收紧顶层结果且保留更小限制', () => {
    const noLimit = analyzeServerOpsSqlQuery('SELECT id FROM users ORDER BY id', 'app')
    expect(limitServerOpsSqlQuery(noLimit, 50)).toBe('SELECT `id` FROM `users` ORDER BY `id` LIMIT 51')

    const smallerLimit = analyzeServerOpsSqlQuery('SELECT id FROM users LIMIT 10 OFFSET 5', 'app')
    expect(limitServerOpsSqlQuery(smallerLimit, 50)).toBe('SELECT `id` FROM `users` LIMIT 10 OFFSET 5')

    const largerLimit = analyzeServerOpsSqlQuery('SELECT id FROM users LIMIT 200, 500', 'app')
    expect(limitServerOpsSqlQuery(largerLimit, 50)).toBe('SELECT `id` FROM `users` LIMIT 51 OFFSET 200')
  })

  test('Given 危险或范围不确定语法 When 分析 Then fail closed 且错误不回显正文', () => {
    const rejected = [
      'SELECT id FROM users -- comment',
      'SELECT id FROM users /* comment */',
      'SELECT id FROM users; SELECT id FROM orders',
      'WITH x AS (SELECT id FROM users) SELECT id FROM x',
      'SELECT id FROM (SELECT id FROM users) x',
      'SELECT id FROM users UNION SELECT id FROM admins',
      'SELECT DISTINCT id FROM users',
      'SELECT id INTO OUTFILE \'/tmp/a\' FROM users',
      'SELECT id FROM users FOR UPDATE',
      'SELECT id FROM users LOCK IN SHARE MODE',
      'SELECT @secret FROM users',
      'SELECT mysql.user FROM mysql.user',
      'SELECT other.users.id FROM other.users',
      'SELECT app.users.id FROM app.users',
      'SELECT custom_fn(id) FROM users',
      'SELECT sys.sleep(1) FROM users',
      'SELECT SLEEP(1) FROM users',
      'SELECT LOAD_FILE(\'/tmp/a\') FROM users',
      "SELECT id FROM users WHERE name = 'back\\slash'",
      'SELECT id FROM users LIMIT 1 OFFSET 1000001',
    ]
    for (const sql of rejected) {
      expect(() => analyzeServerOpsSqlQuery(sql, 'app')).toThrow(/^SERVER_OPS_SQL_[A-Z_]+$/)
    }
  })

  test('Given 敏感源列出现在任意表达式 When 分析 Then 别名无法绕过拒绝', () => {
    expect(isServerOpsSqlSensitiveColumn('password_hash')).toBe(true)
    expect(isServerOpsSqlSensitiveColumn('apiToken')).toBe(true)
    expect(isServerOpsSqlSensitiveColumn('monkey')).toBe(false)
    for (const sql of [
      'SELECT password_hash AS harmless FROM users',
      'SELECT id AS password FROM users',
      'SELECT id FROM users WHERE api_token IS NOT NULL',
      'SELECT id FROM users ORDER BY client_secret',
      'SELECT COUNT(*) FROM users GROUP BY access_key',
      'SELECT id FROM users u JOIN sessions s ON s.token = u.id',
    ]) {
      expect(() => analyzeServerOpsSqlQuery(sql, 'app')).toThrow('SERVER_OPS_SQL_SENSITIVE_COLUMN')
    }
  })

  test('Given COUNT 通配符和大小写混合关键字 When 分析 Then 不误报原始列通配符', () => {
    const plan = analyzeServerOpsSqlQuery('SeLeCt COUNT(*) total FrOm users WhErE deleted_at Is NuLl', 'app')
    expect(plan.hasWildcard).toBe(false)
    expect(plan.columns).toEqual([expect.objectContaining({ column: 'deleted_at' })])
    expect(plan.sql).toBe('SELECT COUNT(*) AS `total` FROM `users` WHERE `deleted_at` IS NULL')
    expect(plan.fingerprint).toBe(plan.sql)
  })

  test('Given 聚合别名与同名源列 When 分析不同子句 Then 仅允许的位置标记输出引用', () => {
    const plan = analyzeServerOpsSqlQuery('SELECT SUM(amount) AS total FROM orders WHERE total > 0 GROUP BY total HAVING total > 1 ORDER BY TOTAL', 'app')
    expect(plan.columns).toEqual([
      expect.objectContaining({ column: 'amount' }),
      expect.objectContaining({ column: 'total' }),
      expect.objectContaining({ column: 'total', outputAlias: true }),
    ])
    expect(plan.sql).toContain('WHERE `total` > 0 GROUP BY `total` HAVING `total` > 1 ORDER BY `TOTAL`')
    const joined = analyzeServerOpsSqlQuery('SELECT COUNT(*) AS total FROM users u JOIN orders o ON total = o.id HAVING total > 0', 'app')
    expect(joined.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'total' }),
      expect.objectContaining({ column: 'total', outputAlias: true }),
    ]))
    const qualified = analyzeServerOpsSqlQuery('SELECT COUNT(*) AS total FROM users ORDER BY users.total', 'app')
    expect(qualified.columns).toEqual([expect.objectContaining({ table: 'users', column: 'total' })])
  })

  test('Given 带反引号的 CURRENT_DATE When 分析 Then 保留列语义而裸关键字仍为日期函数', () => {
    const quoted = analyzeServerOpsSqlQuery('SELECT `CURRENT_DATE` FROM users', 'app')
    expect(quoted.sql).toBe('SELECT `CURRENT_DATE` FROM `users`')
    expect(quoted.columns).toEqual([expect.objectContaining({ column: 'CURRENT_DATE' })])
    expect(analyzeServerOpsSqlQuery('SELECT CURRENT_DATE FROM users', 'app').columns).toEqual([])
    expect(() => analyzeServerOpsSqlQuery('SELECT `NOW`() FROM users', 'app')).toThrow('SERVER_OPS_SQL_FUNCTION_UNSUPPORTED')
  })

  test('Given 旧行预览保护的认证字段 When 改为 SQL 表达式或别名 Then 保持同一敏感边界', () => {
    for (const name of ['authorization', 'cookie', 'session_id', 'secretkey', 'accessToken', 'refresh-token', 'credentials', 'apiKey', 'privateKey']) {
      expect(isServerOpsSqlSensitiveColumn(name)).toBe(true)
      expect(() => analyzeServerOpsSqlQuery(`SELECT LOWER(\`${name}\`) AS harmless FROM users`, 'app')).toThrow('SERVER_OPS_SQL_SENSITIVE_COLUMN')
    }
  })

  test('Given 超出 tokenizer、递归或 JOIN 预算 When 分析 Then 有界拒绝', () => {
    /** 大量 OR 节点用于证明 AST 复杂度存在固定上限。 */
    const oversizedExpression = Array.from({ length: 600 }, (_, index) => `id = ${index}`).join(' OR ')
    expect(() => analyzeServerOpsSqlQuery(`SELECT id FROM users WHERE ${oversizedExpression}`, 'app'))
      .toThrow(/^SERVER_OPS_SQL_(TOO_COMPLEX|TOO_LARGE)$/)

    /** JOIN 数量上限防止授权检查和执行计划无界扩张。 */
    const excessiveJoins = Array.from({ length: 9 }, (_, index) => `JOIN table_${index} t${index} ON t${index}.id = users.id`).join(' ')
    expect(() => analyzeServerOpsSqlQuery(`SELECT users.id FROM users ${excessiveJoins}`, 'app'))
      .toThrow('SERVER_OPS_SQL_TOO_COMPLEX')
  })
})

describe('MySQL 只读 SQL 诊断', () => {
  test('Given SELECT 缺少 FROM When 校验 Then 返回具体语法原因与 WHERE 位置', () => {
    const sql = 'SELECT * WHERE cbb_admin_account'
    const result = validateServerOpsSqlQuery(sql, 'app')

    expect(result.plan).toBeNull()
    expect(result.diagnostics).toEqual([{
      code: 'SERVER_OPS_SQL_MISSING_FROM',
      category: 'syntax',
      message: 'SELECT 查询缺少 FROM 表来源',
      from: sql.indexOf('WHERE'),
      to: sql.indexOf('WHERE') + 'WHERE'.length,
    }])
  })

  test('Given 空输入或重复表别名 When 校验 Then 返回明确语法诊断', () => {
    expect(validateServerOpsSqlQuery('', 'app').diagnostics[0]).toMatchObject({
      code: 'SERVER_OPS_SQL_EXPECTED_SELECT',
      category: 'syntax',
      from: 0,
      to: 0,
    })
    expect(validateServerOpsSqlQuery(
      'SELECT first.id FROM first JOIN second first ON first.id = first.id',
      'app',
    ).diagnostics[0]).toMatchObject({
      code: 'SERVER_OPS_SQL_DUPLICATE_TABLE_ALIAS',
      category: 'syntax',
    })
  })

  test('Given 表已取别名或可见表名重复 When 校验限定符 Then 拒绝歧义但允许不同别名自连接', () => {
    expect(validateServerOpsSqlQuery('SELECT users.id FROM users u', 'app').diagnostics[0]).toMatchObject({
      code: 'SERVER_OPS_SQL_UNKNOWN_TABLE_ALIAS',
      category: 'syntax',
    })
    expect(validateServerOpsSqlQuery(
      'SELECT id FROM users JOIN users ON users.id = users.id',
      'app',
    ).diagnostics[0]).toMatchObject({
      code: 'SERVER_OPS_SQL_DUPLICATE_TABLE_ALIAS',
      category: 'syntax',
    })

    const selfJoin = validateServerOpsSqlQuery(
      'SELECT a.id, b.id FROM users a JOIN users b ON a.parent_id = b.id',
      'app',
    )
    expect(selfJoin.diagnostics).toEqual([])
    expect(selfJoin.plan?.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'a', sourceTable: 'users' }),
      expect.objectContaining({ table: 'b', sourceTable: 'users' }),
    ]))
  })

  test('Given 表名、表达式、括号或引号未完成 When 校验 Then 返回有界且不回显输入的语法诊断', () => {
    const cases = [
      { sql: 'SELECT * FROM', code: 'SERVER_OPS_SQL_MISSING_TABLE' },
      { sql: 'SELECT id FROM users WHERE', code: 'SERVER_OPS_SQL_EXPECTED_EXPRESSION' },
      { sql: 'SELECT (id FROM users', code: 'SERVER_OPS_SQL_UNCLOSED_PAREN' },
      { sql: "SELECT id FROM users WHERE name = 'private-value", code: 'SERVER_OPS_SQL_UNCLOSED_STRING' },
      { sql: 'SELECT `private-table FROM users', code: 'SERVER_OPS_SQL_UNCLOSED_IDENTIFIER' },
    ]

    for (const item of cases) {
      const diagnostic = validateServerOpsSqlQuery(item.sql, 'app').diagnostics[0]
      expect(diagnostic?.code).toBe(item.code)
      expect(diagnostic?.category).toBe('syntax')
      expect(diagnostic?.from).toBeGreaterThanOrEqual(0)
      expect(diagnostic?.to).toBeGreaterThanOrEqual(diagnostic?.from ?? 0)
      expect(diagnostic?.to).toBeLessThanOrEqual(item.sql.length)
      expect(JSON.stringify(diagnostic)).not.toContain('private-value')
      expect(JSON.stringify(diagnostic)).not.toContain('private-table')
    }
  })

  test('Given 多语句或未开放 SQL 能力 When 校验 Then 与语法错误分开归类', () => {
    expect(validateServerOpsSqlQuery('SELECT 1', 'app').diagnostics[0]).toEqual({
      code: 'SERVER_OPS_SQL_FROM_REQUIRED',
      category: 'unsupported',
      message: '当前查询必须通过 FROM 指定数据表',
      from: 'SELECT 1'.length,
      to: 'SELECT 1'.length,
    })

    const multiple = validateServerOpsSqlQuery('SELECT id FROM users; SELECT id FROM orders', 'app')
    expect(multiple.diagnostics[0]).toMatchObject({
      code: 'SERVER_OPS_SQL_MULTIPLE_STATEMENTS',
      category: 'unsupported',
      message: '每次只能校验和执行一条 SELECT 查询',
    })

    for (const sql of [
      'SELECT DISTINCT id FROM users',
      'SELECT custom_fn(id) FROM users',
      'SELECT id FROM (SELECT id FROM users) nested',
    ]) {
      expect(validateServerOpsSqlQuery(sql, 'app').diagnostics[0]?.category).toBe('unsupported')
    }
  })

  test('Given 跨库或敏感列 When 校验 Then 保持策略拒绝且旧异常只含稳定码', () => {
    for (const item of [
      { sql: 'SELECT password_hash FROM users', code: 'SERVER_OPS_SQL_SENSITIVE_COLUMN' },
      { sql: 'SELECT id FROM other.users', code: 'SERVER_OPS_SQL_CROSS_DATABASE' },
    ]) {
      const diagnostic = validateServerOpsSqlQuery(item.sql, 'app').diagnostics[0]
      expect(diagnostic).toMatchObject({ code: item.code, category: 'policy' })
      try {
        analyzeServerOpsSqlQuery(item.sql, 'app')
        throw new Error('expected parser rejection')
      } catch (error) {
        expect(isServerOpsSqlParserError(error)).toBe(true)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe(item.code)
        expect((error as Error).message).not.toContain(item.sql)
      }
    }
  })

  test('Given 合法 JOIN、函数与中文反引号 When 校验 Then 返回源引用位置和基础表映射', () => {
    const sql = 'SELECT u.id, LOWER(o.`显示名`) AS label FROM `用户` u LEFT JOIN orders o ON o.user_id = u.id ORDER BY label'
    const result = validateServerOpsSqlQuery(sql, 'app')

    expect(result.diagnostics).toEqual([])
    expect(result.plan?.tableReferences).toEqual([
      { table: '用户', alias: 'u', from: sql.indexOf('`用户`'), to: sql.indexOf('`用户`') + '`用户`'.length },
      { table: 'orders', alias: 'o', from: sql.indexOf('orders'), to: sql.indexOf('orders') + 'orders'.length },
    ])
    expect(result.plan?.columns).toEqual(expect.arrayContaining([
      {
        table: 'u',
        column: 'id',
        sourceTable: '用户',
        from: sql.indexOf('u.id') + 2,
        to: sql.indexOf('u.id') + 4,
      },
      {
        table: 'o',
        column: '显示名',
        sourceTable: 'orders',
        from: sql.indexOf('`显示名`'),
        to: sql.indexOf('`显示名`') + '`显示名`'.length,
      },
      { column: 'label', outputAlias: true, from: sql.lastIndexOf('label'), to: sql.lastIndexOf('label') + 5 },
    ]))
  })

  test('Given 超出预算、合法别名或未知错误码 When 获取诊断 Then 不放宽预算且只返回白名单消息', () => {
    const oversized = `SELECT id FROM users WHERE ${Array.from({ length: 600 }, (_, index) => `id = ${index}`).join(' OR ')}`
    expect(validateServerOpsSqlQuery(oversized, 'app').diagnostics[0]?.category).toBe('policy')

    const aliased = validateServerOpsSqlQuery('SELECT SUM(amount) AS total FROM orders o GROUP BY o.id HAVING total > 1', 'app')
    expect(aliased.diagnostics).toEqual([])
    expect(aliased.plan?.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'amount' }),
      expect.objectContaining({ table: 'o', column: 'id', sourceTable: 'orders' }),
      expect.objectContaining({ column: 'total', outputAlias: true }),
    ]))

    expect(getServerOpsSqlDiagnostic('SERVER_OPS_SQL_MISSING_FROM')).toEqual({
      category: 'syntax',
      message: 'SELECT 查询缺少 FROM 表来源',
    })
    expect(getServerOpsSqlDiagnostic('SERVER_OPS_SQL_NOT_REAL')).toBeNull()
    for (const inheritedName of ['constructor', 'toString', '__proto__']) {
      expect(getServerOpsSqlDiagnostic(inheritedName)).toBeNull()
    }
  })
})
