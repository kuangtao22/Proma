import { describe, expect, test } from 'bun:test'
import { validateServerOpsSqlDraft } from './server-ops-sql-validation'
import { createServerOpsSqlCompletionIdleProjection } from './server-ops-sql-completion-controller'
import type { ServerOpsSqlCompletionProjection } from './server-ops-sql-completion-controller'

/** 真实 parser 使用的有限结构快照；未加载字段必须与空字段集合区分。 */
const schema: ServerOpsSqlCompletionProjection = {
  ...createServerOpsSqlCompletionIdleProjection(), contextKey: 'app/v1', database: 'app', status: 'ready',
  tables: [{ name: 'users' }, { name: 'orders' }, { name: '用户资料' }],
  columns: {
    users: [{ name: 'id', type: 'bigint', nullable: false, primaryKey: true }, { name: 'name', type: 'varchar', nullable: true, primaryKey: false }],
    orders: [{ name: 'id', type: 'bigint', nullable: false, primaryKey: true }],
    用户资料: [{ name: '姓名', type: 'varchar', nullable: true, primaryKey: false }],
  },
}

describe('SQL 草稿本地校验', () => {
  test('Given 空输入或未选库 When 校验 Then 不把空白标成语法错误', () => {
    expect(validateServerOpsSqlDraft(' \n ', 'app', schema)).toMatchObject({ status: 'empty', diagnostics: [] })
    expect(validateServerOpsSqlDraft('SELECT * FROM users', null, schema)).toMatchObject({ status: 'unavailable', diagnostics: [] })
  })
  test('Given 截图中的缺 FROM 语句 When 校验 Then 报具体错误和可定位区间', () => {
    /** 原截图复现，定位不能只落到整段 SQL。 */
    const result = validateServerOpsSqlDraft('SELECT * WHERE cbb_admin_account', 'app', schema)
    expect(result.status).toBe('invalid')
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', category: 'syntax' })
    expect(result.diagnostics[0]?.message).toContain('FROM')
    expect(result.diagnostics[0]!.from).toBeGreaterThan(0)
  })
  test('Given 合法别名和聚合 When 校验 Then 不把输出别名当作物理字段', () => {
    expect(validateServerOpsSqlDraft('SELECT u.name, COUNT(*) AS total FROM users u GROUP BY u.name ORDER BY total DESC', 'app', schema)).toMatchObject({ status: 'valid', diagnostics: [] })
    expect(validateServerOpsSqlDraft('SELECT u.`姓名` FROM `用户资料` u', 'app', schema)).toMatchObject({ status: 'valid', diagnostics: [] })
  })
  test('Given 表或字段不在缓存 When 校验 Then 仅给结构提醒且保留可执行状态', () => {
    expect(validateServerOpsSqlDraft('SELECT * FROM fresh_table', 'app', schema)).toMatchObject({ status: 'valid', diagnostics: [{ severity: 'warning', category: 'schema' }] })
    /** 别名字段需用严格 parser 解析出的基础表核对。 */
    const result = validateServerOpsSqlDraft('SELECT u.missing FROM users u JOIN orders o ON u.id=o.id', 'app', schema)
    expect(result.status).toBe('valid')
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.message).toContain('字段')
    expect(result.diagnostics[0]?.severity).toBe('warning')
  })
  test('Given 未加载或不完整结构 When 校验 Then 不凭缺失的缓存推断不存在', () => {
    for (const current of [{ ...schema, status: 'loading' as const }, { ...schema, database: 'other' }, { ...schema, tablesTruncated: true }]) {
      expect(validateServerOpsSqlDraft('SELECT * FROM fresh_table', 'app', current).diagnostics).toEqual([])
    }
    expect(validateServerOpsSqlDraft('SELECT o.missing FROM orders o', 'app', { ...schema, columns: {} }).diagnostics).toEqual([])
    expect(validateServerOpsSqlDraft('SELECT missing FROM users u JOIN orders o ON u.id=o.id', 'app', { ...schema, columns: { users: schema.columns.users! } }).diagnostics).toEqual([])
  })
  test('Given 多表与同表多别名 When 裸字段有歧义 Then 提示限定字段而不拦执行', () => {
    for (const sql of ['SELECT id FROM users u JOIN orders o ON u.id=o.id', 'SELECT id FROM users a JOIN users b ON a.id=b.id']) {
      expect(validateServerOpsSqlDraft(sql, 'app', schema)).toMatchObject({ status: 'valid', diagnostics: [{ severity: 'warning' }] })
    }
    expect(validateServerOpsSqlDraft('SELECT o.name FROM users u JOIN orders o ON u.id=o.id', 'app', schema).diagnostics[0]?.message).toContain('字段')
  })
  test('Given 数据库最新结构可能变化 When 缓存告警 Then 文案明确需要刷新确认', () => {
    expect(validateServerOpsSqlDraft('SELECT missing FROM users', 'app', schema).diagnostics[0]?.message).toContain('缓存')
    expect(validateServerOpsSqlDraft('SELECT missing FROM users', 'app', schema).diagnostics[0]?.message).toContain('刷新')
  })
  test('Given 原型属性表名 When 缓存未加载 Then 不读取继承属性也不抛异常', () => {
    expect(validateServerOpsSqlDraft('SELECT missing FROM constructor', 'app', { ...schema, tables: [{ name: 'constructor' }], columns: {} }).diagnostics).toEqual([])
  })
  test('Given 跨库或敏感字段 When 校验 Then 保留原有保护规则', () => {
    for (const sql of ['SELECT * FROM other.users', 'SELECT password FROM users']) {
      expect(validateServerOpsSqlDraft(sql, 'app', schema)).toMatchObject({ status: 'invalid', diagnostics: [{ severity: 'error', category: 'policy' }] })
    }
  })

  test('Given SQLite 方言 SQL When 校验 Then 使用 SQLite 规则且 MySQL 默认行为保持不变', () => {
    expect(validateServerOpsSqlDraft("SELECT strftime('%Y', created_at) FROM users", 'main', undefined, 'sqlite')).toMatchObject({ status: 'valid' })
    expect(validateServerOpsSqlDraft('SELECT * FROM users', 'app', schema)).toMatchObject({ status: 'valid' })
  })

  test('Given PostgreSQL 大小写不同的表与字段 When 核对结构缓存 Then 精确匹配并保留真实缺失提醒', () => {
    /** PostgreSQL 带引号标识符可以只差大小写，不能混用另一张表的缓存。 */
    const postgresSchema: ServerOpsSqlCompletionProjection = {
      ...schema,
      tables: [{ name: '"public"."Users"' }, { name: '"public"."users"' }],
      columns: {
        '"public"."Users"': [{ name: 'UserName', type: 'text', nullable: false, primaryKey: false }],
        '"public"."users"': [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
      },
    }
    expect(validateServerOpsSqlDraft('SELECT "UserName" FROM "Users"', 'app', postgresSchema, 'postgresql').diagnostics).toEqual([])
    expect(validateServerOpsSqlDraft('SELECT username FROM "Users"', 'app', postgresSchema, 'postgresql').diagnostics).toMatchObject([{ code: 'SCHEMA_COLUMN_MISSING' }])
    expect(validateServerOpsSqlDraft('SELECT id FROM "USERS"', 'app', postgresSchema, 'postgresql').diagnostics).toMatchObject([{ code: 'SCHEMA_TABLE_MISSING' }])
  })
})
