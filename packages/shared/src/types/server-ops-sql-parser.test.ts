import { describe, expect, test } from 'bun:test'
import {
  analyzeServerOpsSqlQuery,
  isServerOpsSqlSensitiveColumn,
  limitServerOpsSqlQuery,
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
      { table: 'u', column: 'id' },
      { table: 'u', column: 'name' },
      { table: 'o', column: 'id' },
      { table: 'o', column: 'user_id' },
      { table: 'u', column: 'status' },
      { table: 'o', column: 'created_at' },
      { column: 'total', outputAlias: true },
    ]))
    expect(plan.hasWildcard).toBe(false)
    expect(plan.sql).toBe("SELECT `u`.`id`, LOWER(`u`.`name`) AS `normalized_name`, COUNT(`o`.`id`) AS `total` FROM `app`.`users` AS `u` LEFT JOIN `orders` AS `o` ON `o`.`user_id` = `u`.`id` WHERE `u`.`status` IN ('active', 'trial') AND `o`.`created_at` BETWEEN DATE_SUB(NOW(), INTERVAL 30 DAY) AND NOW() GROUP BY `u`.`id`, `u`.`name` HAVING COUNT(`o`.`id`) > 0 ORDER BY `total` DESC, `u`.`id` ASC LIMIT 100 OFFSET 20")
    expect(plan.fingerprint).toBe('SELECT `u`.`id`, LOWER(`u`.`name`) AS `normalized_name`, COUNT(`o`.`id`) AS `total` FROM `app`.`users` AS `u` LEFT JOIN `orders` AS `o` ON `o`.`user_id` = `u`.`id` WHERE `u`.`status` IN (?, ?) AND `o`.`created_at` BETWEEN DATE_SUB(NOW(), INTERVAL ? DAY) AND NOW() GROUP BY `u`.`id`, `u`.`name` HAVING COUNT(`o`.`id`) > ? ORDER BY `total` DESC, `u`.`id` ASC LIMIT ? OFFSET ?')
  })

  test('Given 通配列与反引号/引号转义 When 分析 Then 保留安全语义且不把别名当表', () => {
    const plan = analyzeServerOpsSqlQuery("SELECT `t`.*, CONCAT(`first`, 'O''Reilly') AS `display` FROM `odd``table` AS `t` WHERE `t`.`deleted_at` IS NULL", 'app')
    expect(plan.tables).toEqual(['odd`table'])
    expect(plan.columns).toEqual(expect.arrayContaining([
      { table: 't', column: '*' },
      { column: 'first' },
      { table: 't', column: 'deleted_at' },
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
    expect(plan.columns).toEqual([{ column: 'deleted_at' }])
    expect(plan.sql).toBe('SELECT COUNT(*) AS `total` FROM `users` WHERE `deleted_at` IS NULL')
    expect(plan.fingerprint).toBe(plan.sql)
  })

  test('Given 聚合别名与同名源列 When 分析不同子句 Then 仅允许的位置标记输出引用', () => {
    const plan = analyzeServerOpsSqlQuery('SELECT SUM(amount) AS total FROM orders WHERE total > 0 GROUP BY total HAVING total > 1 ORDER BY TOTAL', 'app')
    expect(plan.columns).toEqual([{ column: 'amount' }, { column: 'total' }, { column: 'total', outputAlias: true }])
    expect(plan.sql).toContain('WHERE `total` > 0 GROUP BY `total` HAVING `total` > 1 ORDER BY `TOTAL`')
    const joined = analyzeServerOpsSqlQuery('SELECT COUNT(*) AS total FROM users u JOIN orders o ON total = o.id HAVING total > 0', 'app')
    expect(joined.columns).toEqual(expect.arrayContaining([{ column: 'total' }, { column: 'total', outputAlias: true }]))
    const qualified = analyzeServerOpsSqlQuery('SELECT COUNT(*) AS total FROM users ORDER BY users.total', 'app')
    expect(qualified.columns).toEqual([{ table: 'users', column: 'total' }])
  })

  test('Given 带反引号的 CURRENT_DATE When 分析 Then 保留列语义而裸关键字仍为日期函数', () => {
    const quoted = analyzeServerOpsSqlQuery('SELECT `CURRENT_DATE` FROM users', 'app')
    expect(quoted.sql).toBe('SELECT `CURRENT_DATE` FROM `users`')
    expect(quoted.columns).toEqual([{ column: 'CURRENT_DATE' }])
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
