import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { MySQL, sql } from '@codemirror/lang-sql'
import { createServerOpsSqlCompletionSource, getServerOpsSqlTableReferences } from './server-ops-sql-completion'
import type { ServerOpsSqlCompletionSchema } from './server-ops-sql-completion'

/** 使用真实 MySQL parser 的缓存夹具，包含重名字段和中文标识符。 */
const schema: ServerOpsSqlCompletionSchema = {
  contextKey: 'source/app/v1', database: 'app',
  tables: [{ name: 'users', comment: '用户' }, { name: 'orders' }, { name: '用户资料' }],
  columns: {
    users: [{ name: 'id', type: 'bigint', primaryKey: true, nullable: false }, { name: 'name', type: 'varchar(64)', primaryKey: false, nullable: true, comment: '用户名' }],
    orders: [{ name: 'id', type: 'bigint', primaryKey: true, nullable: false }],
    用户资料: [{ name: '姓名', type: 'varchar(32)', primaryKey: false, nullable: true, comment: '中文字段' }],
  },
}

/** 标记竖线为光标位置，调用真实补全源而不模拟 parser。 */
async function complete(marked: string, current = schema, explicit = true) {
  const pos = marked.indexOf('|')
  const state = EditorState.create({ doc: marked.replace('|', ''), extensions: [sql({ dialect: MySQL })] })
  return createServerOpsSqlCompletionSource({ getSchema: () => current, ensureColumns: async () => undefined })(new CompletionContext(state, pos, explicit))
}

describe('运维 SQL 联想', () => {
  test('Given 中文前缀 When 自动联想 Then 不必手动按快捷键且后续汉字仍能过滤', async () => {
    const table = await complete('SELECT * FROM 用|', schema, false)
    expect(table?.options.map((item) => item.label)).toContain('用户资料')
    expect(table?.from).toBe(14)
    expect(table?.validFor instanceof RegExp && table.validFor.test('用户')).toBe(true)
    expect((await complete('SELECT u.姓| FROM `用户资料` u', schema, false))?.options.map((item) => item.label)).toContain('姓名')
  })
  test('Given 特殊或保留字表名 When 接受补全 Then 插入有效反引号标识符', async () => {
    const result = await complete('SELECT * FROM |', { ...schema, tables: [{ name: 'order' }, { name: 'user data' }] })
    expect(result?.options.find((item) => item.label === 'order')?.apply).toBe('`order`')
    expect(result?.options.find((item) => item.label === 'user data')?.apply).toBe('`user data`')
  })
  test('Given 仅补全表名 When 请求联想 Then 仍检查目录时效', async () => {
    let checks = 0
    const state = EditorState.create({ doc: 'SELECT * FROM us', extensions: [sql({ dialect: MySQL })] })
    await createServerOpsSqlCompletionSource({ getSchema: () => schema, ensureCatalog: async () => { checks += 1 }, ensureColumns: async () => undefined })(new CompletionContext(state, state.doc.length, true))
    expect(checks).toBe(1)
  })
  test('Given FROM/JOIN When 输入表名前缀 Then 只包含表和关键字，不混入字段', async () => {
    for (const value of ['SELECT * FROM us|', 'SELECT * FROM users u JOIN or|']) {
      const result = await complete(value)
      expect(result?.options.some((item) => item.label === 'users')).toBe(true)
      expect(result?.options.some((item) => item.label === 'name')).toBe(false)
    }
  })
  test('Given 别名 When 输入点号 Then 返回对应表字段及类型注释', async () => {
    const result = await complete('SELECT u.| FROM users AS u JOIN orders o ON u.id=o.id')
    expect(result?.options.map((item) => item.label)).toEqual(['id', 'name'])
    expect(result?.options.find((item) => item.label === 'name')).toMatchObject({ detail: 'varchar(64)', info: '用户名' })
  })
  test('Given 中文和反引号 When 引用别名 Then 补全中文字段', async () => {
    expect((await complete('SELECT u.| FROM `用户资料` u'))?.options.map((item) => item.label)).toEqual(['姓名'])
  })
  test('Given 多表重名列 When 补全裸字段 Then 使用别名前缀消除歧义', async () => {
    const labels = (await complete('SELECT | FROM users u JOIN orders o ON u.id=o.id'))?.options.map((item) => item.label)
    expect(labels).toContain('u.id')
    expect(labels).toContain('o.id')
    expect(labels).toContain('name')
  })
  test('Given 字符串或注释 When 请求补全 Then 不出现结构候选', async () => {
    for (const value of ["SELECT 'us|' FROM users", 'SELECT * FROM users -- na|', 'SELECT /* na| */ name FROM users']) expect(await complete(value)).toBeNull()
  })
  test('Given 跨库或子查询 When 解析来源 Then 不猜测当前库同名表字段', async () => {
    expect((await complete('SELECT u.| FROM other.users u'))?.options ?? []).toHaveLength(0)
    expect((await complete('SELECT u.| FROM (SELECT * FROM users) u'))?.options ?? []).toHaveLength(0)
  })
  test('Given 多语句 When 光标在后一句 Then 只识别当前语句的表', () => {
    const state = EditorState.create({ doc: 'SELECT * FROM users; SELECT * FROM orders o', extensions: [sql({ dialect: MySQL })] })
    expect(getServerOpsSqlTableReferences(state, state.doc.length, schema)).toEqual([{ table: 'orders', alias: 'o' }])
  })
  test('Given 字段按需读取 When 等待中切库 Then 丢弃旧补全结果', async () => {
    let current = schema
    const state = EditorState.create({ doc: 'SELECT u. FROM users u', extensions: [sql({ dialect: MySQL })] })
    const result = await createServerOpsSqlCompletionSource({
      getSchema: () => current,
      ensureColumns: async (tables) => { expect(tables).toEqual(['users']); current = { ...schema, contextKey: 'other' } },
    })(new CompletionContext(state, 9, true))
    expect(result).toBeNull()
  })
})
