import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readMySqlWithConnection } from './server-ops-data-runtime'

/** 同时识别旧读取和合并元数据读取，验证驱动调用次数；真实网络开销另用隔离实例测量。 */
function createPreviewFixture() {
  /** 实际发往驱动的语句，包含执行方式和绑定参数。 */
  const calls: Array<{ sql: string; values: (string | number)[]; prepared: boolean }> = []
  /** 固定表结构同时覆盖文本、二进制与普通数值。 */
  const columns = [
    { table_name: 'items', name: 'id', data_type: 'int', rows_estimate: 12, primary_seq: 1 },
    { table_name: 'items', name: 'note', data_type: 'longtext', rows_estimate: 12 },
    { table_name: 'items', name: 'payload', data_type: 'longblob', rows_estimate: 12 },
  ]
  /** 只替代驱动返回，实际 SQL 生成和结果归一化仍由生产实现执行。 */
  const read = async (sql: string, values: (string | number)[] = [], prepared = false): Promise<unknown> => {
    calls.push({ sql, values, prepared })
    if (sql.includes('VERSION()')) return [[{ version: '8.0.36' }], []]
    if (sql.includes('information_schema.COLUMNS')) return [columns, []]
    if (sql.includes('information_schema.STATISTICS')) return [[{ name: 'PRIMARY', seq: 1, column_name: 'id' }], []]
    if (sql.includes('information_schema.TABLES')) return [[{ name: 'items', rows_estimate: 12 }], []]
    return [[{
      id: 1,
      note: 'x'.repeat(257),
      payload: sql.includes('OCTET_LENGTH(') ? 8_000_000 : Buffer.alloc(8),
      __proma_cell_sha256_1: createHash('sha256').update('x'.repeat(257), 'utf8').digest('hex'),
    }], columns.map(({ name }) => ({ name }))]
  }
  return { calls, columns, connection: {
    query: (sql: string, values?: (string | number)[]) => read(sql, values),
    execute: (sql: string, values?: (string | number)[]) => read(sql, values, true),
  } }
}

/** 为边界用例提供两次真实驱动响应形状，返回生产函数结果与发出的 SQL。 */
async function readPreviewFixture(metadata: Record<string, unknown>[], rows: Record<string, unknown>[] = [], fields: string[] = []) {
  /** 固定策略语句另行验证，业务元数据与预览仍只需两次绑定读取。 */
  const statements: string[] = []
  const result = await readMySqlWithConnection({
    query: async (sql) => {
      if (sql === 'SELECT VERSION() AS version') return [[{ version: '8.0.36' }], []]
      if (sql === 'SET SESSION MAX_EXECUTION_TIME = 10000, lock_wait_timeout = 2') return [[], []]
      throw new Error('TEST_CLIENT_INTERPOLATION_FORBIDDEN')
    },
    execute: async (sql) => {
      statements.push(sql)
      return statements.length === 1 ? [metadata, []] : [rows, fields.map((name) => ({ name }))]
    },
  }, {
    mode: 'schema-rows', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
    schemaDatabase: 'app', schemaTable: 'items', rowOffset: 0, rowLimit: 50,
  })
  return { result, statements }
}

describe('MySQL 表预览读取预算', () => {
  test('Given 表在首500张之外 When 搜索目录 Then 参数化匹配且百分号按字面处理', async () => {
    const calls: Array<{ sql: string; values: (string | number)[] }> = []
    const connection = { query: async (sql: string, values: (string | number)[] = []) => {
      calls.push({ sql, values })
      if (sql.includes('information_schema.SCHEMATA')) return [[{ name: 'app' }], []]
      return [[{ name: 'table_501', table_type: 'BASE TABLE' }], []]
    } }
    const result = await readMySqlWithConnection(connection, {
      mode: 'schema-tables', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', schemaDatabase: 'app', schemaTableSearch: "table_%'",
    })
    expect(calls.at(-1)?.sql).toContain('TABLE_NAME LIKE ?')
    expect(calls.at(-1)?.sql).not.toContain("table_%'")
    expect(calls.at(-1)?.values).toEqual(['app', "%table!_!%'%"])
    expect(result).toMatchObject({ tables: [{ name: 'table_501' }] })
  })
  test('Given 视图映射敏感基表 When Agent 请求结构或预览 Then 元数据阶段拒绝且不执行列查询和业务 SELECT', async () => {
    for (const mode of ['schema-table', 'schema-rows'] as const) {
      const calls: string[] = []
      const connection = {
        query: async (sql: string) => {
          calls.push(sql)
          return [sql.includes('VERSION()') ? [{ version: '8.0.36' }]
            : sql.includes('information_schema.') ? [{ name: 'public_view', table_name: 'public_view', table_type: 'VIEW' }] : [], []]
        },
        execute: async (sql: string) => {
          calls.push(sql)
          return [[{ name: 'public_view', table_name: 'public_view', table_type: 'VIEW', name_of_hidden_base: 'secret' }], []]
        },
      }
      await expect(readMySqlWithConnection(connection, {
        mode, engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', schemaDatabase: 'app', schemaTable: 'public_view',
        baseTablesOnly: true, ...(mode === 'schema-rows' ? { rowOffset: 0, rowLimit: 10 } : {}),
      })).rejects.toThrow('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
      expect(calls.filter((sql) => sql.includes('information_schema.'))).toHaveLength(1)
      expect(calls.some((sql) => sql.includes('FROM `app`.`public_view`'))).toBe(false)
    }
    const ui = await readMySqlWithConnection({
      query: async (sql: string) => [sql.includes('information_schema.TABLES') ? [{ name: 'public_view', table_type: 'VIEW' }] : [], []],
      execute: async () => [[{ name: 'authorization', column_type: 'text', nullable: 'YES' }], []],
    }, { mode: 'schema-table', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', schemaDatabase: 'app', schemaTable: 'public_view' })
    expect(ui).toMatchObject({ capability: 'available' })
  })
  test('Given 单表数据预览 When 读取元数据或行 Then MySQL和MariaDB均先设置十秒执行与两秒锁等待', async () => {
    for (const version of ['8.0.36', '10.11.8-MariaDB']) {
      /** 记录固定策略配置；含用户标识的查询仍只走服务端绑定。 */
      const settings: string[] = []
      /** 复用真实预览结果夹具，仅收口连接初始化行为。 */
      const fixture = createPreviewFixture()
      await readMySqlWithConnection({
        query: async (sql) => { settings.push(sql); return sql.includes('VERSION()') ? [[{ version }], []] : [[], []] },
        execute: async (sql, values) => {
          expect(settings).toContain(version.includes('MariaDB')
            ? 'SET SESSION max_statement_time = 10, lock_wait_timeout = 2'
            : 'SET SESSION MAX_EXECUTION_TIME = 10000, lock_wait_timeout = 2')
          return fixture.connection.execute(sql, values)
        },
      }, { mode: 'schema-rows', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', schemaDatabase: 'app', schemaTable: 'items', rowOffset: 0, rowLimit: 10 })
      expect(fixture.calls).toHaveLength(2)
    }
  })

  test('Given 预览连接不支持服务端保护 When 设置失败 Then 不下发任何表数据读取', async () => {
    /** MySQL旧版本与配置失败都应在访问表前停止。 */
    for (const version of ['5.6.51', '8.0.36']) {
      /** 保护安装失败后，任何业务读取调用都属于回归。 */
      let reads = 0
      await expect(readMySqlWithConnection({
        query: async (sql) => {
          if (sql.includes('VERSION()')) return [[{ version }], []]
          throw new Error('TEST_LIMIT_SETUP_FAILED')
        },
        execute: async () => { reads++; return [[], []] },
      }, { mode: 'schema-rows', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled', schemaDatabase: 'app', schemaTable: 'items', rowOffset: 0, rowLimit: 10 })).rejects.toThrow()
      expect(reads).toBe(0)
    }
  })

  for (const filtered of [false, true]) {
    test(`Given ${filtered ? '已筛选' : '未筛选'}表 When 读取一页 Then 两次绑定查询且保留预览语义`, async () => {
      /** 每次请求都独立查询实时元数据，不依赖权限或字段缓存。 */
      const fixture = createPreviewFixture()
      /** 原有公开合同保持不变，筛选参数仍走绑定。 */
      const result = await readMySqlWithConnection(fixture.connection, {
        mode: 'schema-rows', engine: 'mysql', address: '127.0.0.1', port: 3306, tlsMode: 'disabled',
        schemaDatabase: 'app', schemaTable: 'items', rowOffset: 0, rowLimit: 50,
        ...(filtered ? { rowFilters: { match: 'all' as const, conditions: [{ column: 'id', operator: 'eq' as const, value: '1' }] } } : {}),
      })
      expect(fixture.calls).toHaveLength(4)
      expect(fixture.calls.slice(0, 2).map(({ sql }) => sql)).toEqual(['SELECT VERSION() AS version', 'SET SESSION MAX_EXECUTION_TIME = 10000, lock_wait_timeout = 2'])
      expect(fixture.calls.slice(2).every(({ prepared }) => prepared)).toBe(true)
      expect(fixture.calls.at(-1)?.sql).not.toContain('SELECT *')
      expect(fixture.calls.at(-1)?.sql).toContain('LEFT(CONVERT(`note` USING utf8mb4), 257)')
      expect(fixture.calls.at(-1)?.sql).toContain('OCTET_LENGTH(`payload`)')
      expect(result).toMatchObject({
        columns: ['id', 'note', 'payload'],
        rows: [['1', { kind: 'text', text: 'x'.repeat(256), truncated: true }, { kind: 'binary', bytes: 8_000_000 }]],
        orderedByPrimaryKey: true, truncated: true,
      })
      if (filtered) {
        expect(fixture.calls.slice(2).every(({ prepared }) => prepared)).toBe(true)
        expect(fixture.calls.at(-1)?.values).toEqual(['1'])
        expect('totalEstimate' in result).toBe(false)
      } else expect(result).toMatchObject({ totalEstimate: 12 })
    })
  }

  test('Given 超过预览列数且主键位于后方 When 读取 Then 仅传可见前64列但按完整主键顺序分页', async () => {
    /** 主键顺序故意与物理列顺序不同；隐藏列不得占用可见预览名额。 */
    const metadata = Array.from({ length: 70 }, (_, index) => ({
      table_name: 'items', name: `column_${index}`, data_type: 'int',
      extra: index === 1 ? 'INVISIBLE' : '', primary_seq: index === 69 ? 1 : index === 0 ? 2 : null,
    }))
    const fields = ['column_0', ...Array.from({ length: 63 }, (_, index) => `column_${index + 2}`)]
    const { result, statements } = await readPreviewFixture(metadata, [], fields)
    expect(result).toMatchObject({ columns: fields, rows: [], truncated: true, orderedByPrimaryKey: true })
    expect(statements).toHaveLength(2)
    expect(statements[1]).toContain('ORDER BY `column_69`, `column_0`')
    expect(statements[1]).not.toContain('AS `column_1`')
    expect(statements[1]).not.toContain('AS `column_65`')
  })

  test('Given 原始字段有反引号 When 生成预览 Then 字段始终按标识符转义并保留原列名', async () => {
    const name = "odd`'column"
    const { result, statements } = await readPreviewFixture([{ table_name: 'items', name, data_type: 'text' }], [{ [name]: 'safe' }], [name])
    expect(result).toMatchObject({ columns: [name], rows: [['safe']] })
    expect(statements[1]).toContain("LEFT(CONVERT(`odd``'column` USING utf8mb4), 257) AS `odd``'column`")
    expect(statements[1]).toContain("SHA2(CAST(CONVERT(`odd``'column` USING utf8mb4) AS BINARY), 256)")
  })

  test('Given NULL与空二进制 When 仅传大小 Then 不把NULL误报为零字节', async () => {
    const { result } = await readPreviewFixture([{ table_name: 'items', name: 'payload', data_type: 'longblob' }], [{ payload: null }, { payload: 0 }, { payload: '4096' }], ['payload'])
    expect(result).toMatchObject({ rows: [[null], [{ kind: 'binary', bytes: 0 }], [{ kind: 'binary', bytes: 4096 }]] })
  })

  test('Given 异常二进制大小 When 归一化 Then 拒绝负数或非整数而非伪造内容', async () => {
    for (const payload of [-1, 1.5, 'not-a-size']) {
      await expect(readPreviewFixture([{ table_name: 'items', name: 'payload', data_type: 'blob' }], [{ payload }], ['payload'])).rejects.toThrow('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    }
  })

  test('Given 结构在途变化导致字段错位 When 返回预览 Then 拒绝把数据按错误类型解释', async () => {
    await expect(readPreviewFixture([{ table_name: 'items', name: 'payload', data_type: 'blob' }], [{ another: 1 }], ['another'])).rejects.toThrow('SERVER_OPS_DATA_UNEXPECTED_RESULT')
  })

  test('Given 表不可见或返回其他表 When 读取 Then 在拼接数据查询前停止', async () => {
    for (const metadata of [[], [{ table_name: 'another', name: 'id', data_type: 'int' }]]) {
      const { result, statements } = await readPreviewFixture(metadata)
      expect(result.capability).toBe('unsupported')
      expect(statements).toHaveLength(1)
    }
  })

  test('Given 元数据超限或缺少可见列 When 读取 Then 拒绝回退无界SELECT星号', async () => {
    for (const metadata of [
      [{ table_name: 'items', name: null }],
      Array.from({ length: 4097 }, (_, index) => ({ table_name: 'items', name: `column_${index}`, data_type: 'int' })),
    ]) {
      await expect(readPreviewFixture(metadata)).rejects.toThrow('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    }
  })

  test('Given JSON和空间字段 When 预览 Then JSON有界转为文本且空间对象保留驱动语义', async () => {
    const metadata = [{ table_name: 'items', name: 'document', data_type: 'json' }, { table_name: 'items', name: 'location', data_type: 'geometry' }]
    const document = { quote: '"', text: '界😀', list: [1, null] }
    const location = { x: 1, y: 2 }
    const { result, statements } = await readPreviewFixture(metadata, [{ document: JSON.stringify(document), location }], ['document', 'location'])
    expect(result).toMatchObject({ rows: [[JSON.stringify(document), JSON.stringify(location)]] })
    expect(statements[1]).toContain('LEFT(CONVERT(`document` USING utf8mb4), 257)')
    expect(statements[1]).not.toContain('LEFT(`location`')
    expect(statements[1]).not.toContain('OCTET_LENGTH(`location`)')
  })
})
