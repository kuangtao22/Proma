import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ServerOpsRuntimeDataReadRequest } from './server-ops-runtime-protocol'
import {
  runServerOpsSqliteRead,
  type ServerOpsSqliteChannel,
  type ServerOpsSqliteChannelFactory,
} from './server-ops-sqlite-runtime'

/** 当前测试使用的临时目录，每个用例组结束后整体清理。 */
let fixtureDirectory = ''
/** 当前测试使用的真实 SQLite 文件路径。 */
let databasePath = ''

/** 构造 SQLite runtime 请求；共享合同接线完成前通过 unknown 保持测试独立。 */
function createInput(overrides: Partial<ServerOpsRuntimeDataReadRequest> = {}): ServerOpsRuntimeDataReadRequest {
  return {
    requestId: 'request-sqlite',
    hostId: 'host-sqlite',
    connectionId: 'connection-sqlite',
    transport: 'ssh',
    mode: 'probe',
    engine: 'sqlite',
    database: 'main',
    filePath: databasePath,
    tlsMode: 'disabled',
    timeoutMs: 2_000,
    ...overrides,
  }
}

/** 把本地 shell 子进程适配为 SSH ClientChannel 的最小测试替身。 */
function createLocalChannelFactory(commands: string[], states: Array<{ exited: boolean }> = [], payloads: Array<Record<string, unknown>> = []): ServerOpsSqliteChannelFactory {
  return async (command) => {
    commands.push(command)
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
    /** close 事件同时证明进程退出及标准流关闭，区别于只收到 JSON 结果。 */
    const state = { exited: false }
    states.push(state)
    child.once('close', () => { state.exited = true })
    if (child.stdin === null || child.stdout === null || child.stderr === null) throw new Error('TEST_CHILD_STREAM_MISSING')
    /** 显式标注 channel，避免对象方法中的 this 被异步返回类型宽化。 */
    const channel: ServerOpsSqliteChannel = {
      stderr: child.stderr,
      on(event, listener) {
        child.stdout.on(event, listener)
        return channel
      },
      once(event, listener) {
        if (event === 'close') child.once('close', (code, signal) => listener(code ?? undefined, signal ?? undefined))
        else child.once('error', listener)
        return channel
      },
      write(data) {
        /** 捕获真正传给 Python 的请求，验证调用方不能延长预算。 */
        const line = Buffer.from(data).toString('utf8').trim()
        if (line.length > 0) payloads.push(JSON.parse(line) as Record<string, unknown>)
        return child.stdin.write(data)
      },
      destroy() { child.kill('SIGKILL') },
      signal(_name, callback) {
        child.kill('SIGTERM')
        callback?.()
      },
    }
    return channel
  }
}

/** 构造只返回固定 stdout/exit code 的 channel，用于验证远端环境错误映射。 */
function createFixedChannelFactory(stdout: string, exitCode: number): ServerOpsSqliteChannelFactory {
  return async () => {
    /** 当前测试注册的 stdout 与 close 监听器。 */
    let dataListener: ((data: Uint8Array | string) => void) | undefined
    let closeListener: ((code?: number, signal?: string) => void) | undefined
    /** 固定输出 channel 的方法均返回同一显式对象。 */
    const channel: ServerOpsSqliteChannel = {
      stderr: { on() { return this } },
      on(_event, listener) { dataListener = listener; return channel },
      once(event, listener) {
        if (event === 'close') closeListener = listener as (code?: number, signal?: string) => void
        return channel
      },
      write() {
        queueMicrotask(() => {
          if (stdout.length > 0) dataListener?.(stdout)
          closeListener?.(exitCode)
        })
        return true
      },
      destroy() {},
    }
    return channel
  }
}

beforeEach(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'proma-sqlite-runtime-'))
  databasePath = join(fixtureDirectory, "运维 数据'$(touch SHOULD_NOT_EXIST).sqlite")
  const database = new Database(databasePath, { create: true })
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      authorization TEXT,
      payload BLOB,
      note TEXT
    );
    CREATE INDEX users_name_idx ON users(name);
  `)
  database.query('INSERT INTO users (name, authorization, payload, note) VALUES (?, ?, ?, ?)')
    .run('中文用户', 'Bearer-secret', new Uint8Array([1, 2, 3]), `长文本${'甲'.repeat(300)}`)
  database.close()
})

afterEach(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true })
})

describe('远程 SQLite 只读运行时', () => {
  test('Given 有损预览 When 读取单格 Then 按筛选和页内位置返回含换行的完整原文', async () => {
    /** JSON 保留超安全整数和换行，确保原文不会被预览清洗覆盖。 */
    const value = '{\n\t"id":90071992547409931234,"body":"' + '长'.repeat(400) + '"\n}'
    const database = new Database(databasePath)
    database.query('INSERT INTO users(name,note) VALUES (?,?)').run('target', value)
    database.close()
    const channel = createLocalChannelFactory([])
    const filters = { match: 'all' as const, conditions: [{ column: 'name', operator: 'eq' as const, value: 'target' }] }
    const sha256 = createHash('sha256').update(value).digest('hex')
    const rows = await runServerOpsSqliteRead(createInput({ mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0, rowLimit: 50, rowFilters: filters }), channel)
    expect(rows).toMatchObject({ rows: [['2', 'target', '***', null, { kind: 'text', truncated: true, sha256 }]] })
    await expect(runServerOpsSqliteRead(createInput({ mode: 'schema-cell', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0,
      cellColumnIndex: 4, cellExpectedColumn: 'note', cellSha256: sha256, rowFilters: filters }), channel)).resolves.toMatchObject({ mode: 'schema-cell', value })
    /** 不带筛选时用第二行的绝对位置定位。 */
    await expect(runServerOpsSqliteRead(createInput({ mode: 'schema-cell', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 1,
      cellColumnIndex: 4, cellExpectedColumn: 'note', cellSha256: sha256 }), channel)).resolves.toMatchObject({ value })
  })
  test('Given 控制字符短文本或无主键尾部更新 When 查看详情 Then 原文保真且摘要变化拒绝', async () => {
    /** 无主键表与相同预览前缀复现最容易误认的更新场景。 */
    const database = new Database(databasePath)
    database.exec('CREATE TABLE loose(body TEXT)')
    const short = 'one\ntwo\tthree\0end'
    database.query('INSERT INTO loose VALUES (?)').run(short)
    const channel = createLocalChannelFactory([])
    const sha256 = createHash('sha256').update(short).digest('hex')
    try {
      const rows = await runServerOpsSqliteRead(createInput({ mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'loose', rowOffset: 0, rowLimit: 50 }), channel)
      expect(rows).toMatchObject({ rows: [[{ kind: 'text', truncated: true, sha256 }]] })
      await expect(runServerOpsSqliteRead(createInput({ mode: 'schema-cell', schemaDatabase: 'main', schemaTable: 'loose', rowOffset: 0,
        cellColumnIndex: 0, cellExpectedColumn: 'body', cellSha256: sha256 }), channel)).resolves.toMatchObject({ value: short })
      const original = 'x'.repeat(300) + 'old'
      database.query('UPDATE loose SET body=?').run(original)
      const previousSha256 = createHash('sha256').update(original).digest('hex')
      database.query('UPDATE loose SET body=?').run('x'.repeat(300) + 'new')
      await expect(runServerOpsSqliteRead(createInput({ mode: 'schema-cell', schemaDatabase: 'main', schemaTable: 'loose', rowOffset: 0,
        cellColumnIndex: 0, cellExpectedColumn: 'body', cellSha256: previousSha256 }), channel)).rejects.toMatchObject({ code: 'SERVER_OPS_DATA_CELL_CHANGED' })
    } finally { database.close() }
  })
  test('Given 敏感字段、列变化或超限正文 When 读取全文 Then 返回明确错误不泄露内容', async () => {
    /** 直接构造请求验证 runtime 不信任前端摘要或列选择。 */
    const channel = createLocalChannelFactory([])
    const base = createInput({ mode: 'schema-cell', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0,
      cellColumnIndex: 2, cellExpectedColumn: 'authorization', cellSha256: createHash('sha256').update('Bearer-secret').digest('hex') })
    await expect(runServerOpsSqliteRead(base, channel)).rejects.toMatchObject({ code: 'SERVER_OPS_DATA_CELL_REDACTED' })
    await expect(runServerOpsSqliteRead({ ...base, cellColumnIndex: 4, cellExpectedColumn: 'renamed' }, channel)).rejects.toMatchObject({ code: 'SERVER_OPS_DATA_CELL_CHANGED' })
    const database = new Database(databasePath)
    database.query('UPDATE users SET note=?').run('x'.repeat(1_048_577))
    database.close()
    await expect(runServerOpsSqliteRead({ ...base, cellColumnIndex: 4, cellExpectedColumn: 'note' }, channel)).rejects.toMatchObject({ code: 'SERVER_OPS_DATA_CELL_TOO_LARGE' })
  })
  test('Given emoji或大量控制字符 When 预览再读全文 Then UTF16预览有界且JSON转义不挤掉原文', async () => {
    /** 分别覆盖代理对 Unicode 的长度差异和最坏六倍 JSON 转义。 */
    const channel = createLocalChannelFactory([])
    for (const value of ['😀'.repeat(200), '\0'.repeat(300_000)]) {
      const database = new Database(databasePath)
      database.query('UPDATE users SET note=?').run(value)
      database.close()
      const sha256 = createHash('sha256').update(value).digest('hex')
      const rows = await runServerOpsSqliteRead(createInput({ mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0, rowLimit: 50 }), channel)
      expect(rows).toMatchObject({ rows: [['1', '中文用户', '***', { kind: 'binary', bytes: 3 }, { kind: 'text', sha256 }]] })
      await expect(runServerOpsSqliteRead(createInput({ mode: 'schema-cell', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0,
        cellColumnIndex: 4, cellExpectedColumn: 'note', cellSha256: sha256 }), channel)).resolves.toMatchObject({ value })
    }
  })
  test('Given 超过500张表 When 搜索SQLite目录 Then 能按字面匹配尾部表', async () => {
    const database = new Database(databasePath)
    for (let index = 0; index < 505; index += 1) database.exec(`CREATE TABLE table_${String(index).padStart(3, '0')} (id INTEGER)`)
    database.close()
    const channel = createLocalChannelFactory([])
    const first = await runServerOpsSqliteRead(createInput({ mode: 'schema-tables', schemaDatabase: 'main' }), channel)
    expect(first).toMatchObject({ tablesTruncated: true })
    const searched = await runServerOpsSqliteRead(createInput({ mode: 'schema-tables', schemaDatabase: 'main', schemaTableSearch: 'table_504' }), channel)
    expect(searched).toMatchObject({ tables: [{ name: 'table_504', type: 'table' }] })
    for (const invalid of [{ mode: 'schema-table' as const, schemaTable: 'users' }, { schemaTableSearch: '' }, { schemaTableSearch: 'x'.repeat(129) }]) {
      await expect(runServerOpsSqliteRead(createInput({ mode: 'schema-tables', schemaDatabase: 'main', schemaTableSearch: 'table_504', ...invalid }), channel))
        .rejects.toThrow('SERVER_OPS_SQLITE_REQUEST_INVALID')
    }
  })
  test('Given 视图读取敏感基表 When Agent 请求结构或行预览 Then 两者在读取列前拒绝', async () => {
    const database = new Database(databasePath)
    database.exec("CREATE VIEW public_view AS SELECT authorization FROM users")
    database.close()
    for (const mode of ['schema-table', 'schema-rows'] as const) {
      await expect(runServerOpsSqliteRead(createInput({ mode, schemaDatabase: 'main', schemaTable: 'public_view', baseTablesOnly: true,
        ...(mode === 'schema-rows' ? { rowOffset: 0, rowLimit: 10 } : {}) }), createLocalChannelFactory([])))
        .rejects.toThrow('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
    }
    /** UI 仍可正常查看视图结构，避免扩大本次 Agent 权限变更范围。 */
    await expect(runServerOpsSqliteRead(createInput({ mode: 'schema-table', schemaDatabase: 'main', schemaTable: 'public_view' }), createLocalChannelFactory([])))
      .resolves.toMatchObject({ capability: 'available' })
  })
  test('Given 多字段与字面通配符 When 服务端筛选并分页 Then AND/OR、NULL 与 hasMore 保持准确', async () => {
    const database = new Database(databasePath)
    const insert = database.prepare('INSERT INTO users (name, note) VALUES (?, ?)')
    insert.run('alpha%_!', 'keep')
    insert.run('beta', null)
    insert.run('alpha%_! second', 'keep')
    database.close()
    const createChannel = createLocalChannelFactory([])
    const filters = { match: 'all' as const, conditions: [
      { column: 'name', operator: 'contains' as const, value: '%_!' },
      { column: 'note', operator: 'is-not-null' as const },
    ] }
    const first = await runServerOpsSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0, rowLimit: 1, rowFilters: filters,
    }), createChannel)
    expect(first).toMatchObject({ rows: [['2', 'alpha%_!', '***', null, 'keep']], hasMore: true, orderedByPrimaryKey: true })
    expect('totalEstimate' in first).toBe(false)
    const second = await runServerOpsSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 1, rowLimit: 1, rowFilters: filters,
    }), createChannel)
    expect(second).toMatchObject({ rows: [['4', 'alpha%_! second', '***', null, 'keep']], hasMore: false })
    const any = await runServerOpsSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0, rowLimit: 10,
      rowFilters: { match: 'any', conditions: [
        { column: 'name', operator: 'eq', value: '中文用户' },
        { column: 'note', operator: 'is-null' },
      ] },
    }), createChannel)
    expect('rows' in any && any.rows.map((row) => row[1])).toEqual(['中文用户', 'beta'])
    const missing = await runServerOpsSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0, rowLimit: 10,
      rowFilters: { match: 'all', conditions: [{ column: 'name', operator: 'eq', value: 'absent' }] },
    }), createChannel)
    expect(missing).toMatchObject({ rows: [], hasMore: false })
  })

  test('Given 不可信筛选字段与恶意值 When SQLite 校验 Then 拒绝未知/敏感列且值无法注入', async () => {
    const createChannel = createLocalChannelFactory([])
    for (const column of ['missing', 'authorization']) {
      await expect(runServerOpsSqliteRead(createInput({
        mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0, rowLimit: 10,
        rowFilters: { match: 'all', conditions: [{ column, operator: 'eq', value: 'secret' }] },
      }), createChannel)).rejects.toMatchObject({ code: 'SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID' })
    }
    const filtered = await runServerOpsSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0, rowLimit: 10,
      rowFilters: { match: 'all', conditions: [{ column: 'name', operator: 'eq', value: "' OR 1=1 --" }] },
    }), createChannel)
    expect(filtered).toMatchObject({ rows: [], hasMore: false })
  })
  test('Given 真实 SQLite 文件 When 探测、浏览与查询 Then 保留列头并裁剪敏感和复杂值', async () => {
    const commands: string[] = []
    const createChannel = createLocalChannelFactory(commands)

    const probe = await runServerOpsSqliteRead(createInput(), createChannel)
    expect(probe).toMatchObject({ capability: 'available', metrics: [], tables: [], warnings: [] })
    expect('serverVersion' in probe && probe.serverVersion).toContain('SQLite')

    const list = await runServerOpsSqliteRead(createInput({ mode: 'schema-tables', schemaDatabase: 'main' }), createChannel)
    expect(list).toMatchObject({ mode: 'schema-tables', capability: 'available', database: 'main', databases: ['main'] })
    expect('tables' in list && list.tables).toContainEqual(expect.objectContaining({ name: 'users', type: 'table' }))

    const table = await runServerOpsSqliteRead(createInput({ mode: 'schema-table', schemaDatabase: 'main', schemaTable: 'users' }), createChannel)
    expect(table).toMatchObject({
      mode: 'schema-table',
      capability: 'available',
      indexes: [{ name: 'users_name_idx', unique: false, columns: ['name'] }],
    })

    const rows = await runServerOpsSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0, rowLimit: 20,
    }), createChannel)
    expect(rows).toMatchObject({
      mode: 'schema-rows',
      capability: 'available',
      columns: ['id', 'name', 'authorization', 'payload', 'note'],
      rows: [['1', '中文用户', '***', { kind: 'binary', bytes: 3 }, { kind: 'text', truncated: true }]],
      orderedByPrimaryKey: true,
    })

    const empty = await runServerOpsSqliteRead(createInput({
      mode: 'sql-query', queryId: 'query-empty', sql: 'SELECT id, name FROM users WHERE id = 404', maxRows: 10,
    }), createChannel)
    expect(empty).toMatchObject({ queryId: 'query-empty', database: 'main', columns: ['id', 'name'], rows: [], rowCount: 0 })

    const wildcard = await runServerOpsSqliteRead(createInput({
      mode: 'sql-query', queryId: 'query-wildcard', sql: 'SELECT * FROM users', maxRows: 10,
    }), createChannel)
    expect(wildcard).toMatchObject({
      queryId: 'query-wildcard', database: 'main',
      columns: ['id', 'name', 'authorization', 'payload', 'note'],
      rows: [['1', '中文用户', '***', { kind: 'binary', bytes: 3 }, { kind: 'text', truncated: true }]],
      rowCount: 1,
    })
    const functions = await runServerOpsSqliteRead(createInput({
      mode: 'sql-query', queryId: 'query-functions',
      sql: "SELECT TRIM(name) AS clean_name, REPLACE(name, '用户', '成员') AS renamed, DATE('2026-09-21') AS day FROM users",
      maxRows: 10,
    }), createChannel)
    expect(functions).toMatchObject({ rows: [['中文用户', '中文成员', '2026-09-21']], rowCount: 1 })
    expect(commands.every((command) => !command.includes(databasePath) && !command.includes('SELECT * FROM users'))).toBe(true)
    expect(existsSync(join(fixtureDirectory, 'SHOULD_NOT_EXIST'))).toBe(false)
  })

  test.each([
    ['sql-query', '通配查询'],
    ['schema-rows', '行预览'],
  ] as const)('Given 敏感词在第 128 字符后的真实列名 When %s %s Then 原始列名仍决定遮罩', async (mode) => {
    /** SQLite 允许超长列名；展示截断不得先于敏感判定。 */
    const sensitiveColumn = `${'x'.repeat(128)}password`
    const database = new Database(databasePath)
    database.exec(`CREATE TABLE long_columns (safe_value TEXT, "${sensitiveColumn}" TEXT)`)
    database.prepare(`INSERT INTO long_columns VALUES (?, ?)`).run('public-value', 'synthetic-secret')
    database.close()
    const createChannel = createLocalChannelFactory([])

    const result = await runServerOpsSqliteRead(createInput(mode === 'sql-query'
      ? { mode, queryId: 'long-sensitive-name', sql: 'SELECT * FROM long_columns', maxRows: 10 }
      : { mode, schemaDatabase: 'main', schemaTable: 'long_columns', rowOffset: 0, rowLimit: 10 }), createChannel)
    expect(result).toMatchObject({ columns: ['safe_value', 'x'.repeat(128)], rows: [['public-value', '***']] })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })

  test('Given 写语句、敏感别名与多语句 When 查询 Then 在启动远端进程前拒绝', async () => {
    const commands: string[] = []
    const createChannel = createLocalChannelFactory(commands)
    for (const sql of [
      'DELETE FROM users',
      'SELECT authorization AS harmless FROM users',
      'SELECT id FROM users; SELECT name FROM users',
    ]) {
      await expect(runServerOpsSqliteRead(createInput({
        mode: 'sql-query', queryId: 'query-rejected', sql, maxRows: 10,
      }), createChannel)).rejects.toThrow()
    }
    expect(commands).toHaveLength(0)
  })

  test('Given 超过 64 列的合法表 When 读取结构和行 Then 数据库可打开且行预览只公开前 64 列', async () => {
    const database = new Database(databasePath)
    /** 70 列覆盖 SQLite schema 可解析但公开行合同只允许 64 列的边界。 */
    const definitions = Array.from({ length: 70 }, (_, index) => `column_${index} TEXT`).join(', ')
    database.exec(`CREATE TABLE wide_table (${definitions}); INSERT INTO wide_table DEFAULT VALUES`)
    database.close()
    const createChannel = createLocalChannelFactory([])

    const table = await runServerOpsSqliteRead(createInput({
      mode: 'schema-table', schemaDatabase: 'main', schemaTable: 'wide_table',
    }), createChannel)
    expect('columns' in table && table.columns).toHaveLength(70)

    const rows = await runServerOpsSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'wide_table', rowOffset: 0, rowLimit: 10,
    }), createChannel)
    expect(rows).toMatchObject({ mode: 'schema-rows', capability: 'available', truncated: true })
    expect('columns' in rows && rows.columns).toHaveLength(64)
    expect('rows' in rows && rows.rows[0]).toHaveLength(64)
  })

  test('Given 200 行 64 列长文本 When 触发 1 MiB 预算 Then 压缩单元格但不丢页内行', async () => {
    const database = new Database(databasePath)
    /** 每行 64 个长中文字段，原始公开结果显著超过 1 MiB。 */
    const definitions = Array.from({ length: 64 }, (_, index) => `column_${index} TEXT`).join(', ')
    const value = `预算${'甲'.repeat(254)}`
    const values = Array.from({ length: 64 }, () => '?').join(', ')
    database.exec(`CREATE TABLE budget_table (${definitions})`)
    const insert = database.prepare(`INSERT INTO budget_table VALUES (${values})`)
    /** 单事务写入 fixture，避免测试时间被 fsync 放大。 */
    const insertRows = database.transaction(() => {
      for (let index = 0; index < 200; index += 1) insert.run(...Array.from({ length: 64 }, () => value))
    })
    insertRows()
    database.close()

    const rows = await runServerOpsSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'budget_table', rowOffset: 0, rowLimit: 200,
    }), createLocalChannelFactory([]))
    expect(rows).toMatchObject({ mode: 'schema-rows', capability: 'available', truncated: true, hasMore: false })
    expect('rows' in rows && rows.rows).toHaveLength(200)
    expect('rows' in rows && rows.rows.every((row) => row.length === 64)).toBe(true)
  })

  test('Given 远端路径缺失或不是普通文件 When 读取 Then 返回不含路径的稳定安全错误', async () => {
    const createChannel = createLocalChannelFactory([])
    await expect(runServerOpsSqliteRead(createInput({ filePath: join(fixtureDirectory, 'missing.sqlite') }), createChannel))
      .rejects.toMatchObject({ code: 'SERVER_OPS_SQLITE_FILE_NOT_FOUND', publicMessage: 'SQLite 文件不存在' })
    await expect(runServerOpsSqliteRead(createInput({ filePath: fixtureDirectory }), createChannel))
      .rejects.toMatchObject({ code: 'SERVER_OPS_SQLITE_FILE_NOT_REGULAR', publicMessage: 'SQLite 路径不是普通文件' })

    chmodSync(databasePath, 0o000)
    try {
      await expect(runServerOpsSqliteRead(createInput(), createChannel)).rejects.toMatchObject({
        code: 'SERVER_OPS_SQLITE_FILE_PERMISSION_DENIED',
        publicMessage: '当前 SSH 用户没有读取 SQLite 文件的权限',
      })
    } finally {
      chmodSync(databasePath, 0o600)
    }
  })

  test('Given 单条 BLOB 超过读取预算 When 预览 Then 报大小限制而不误报数据库损坏', async () => {
    /** 超大记录只存在于临时 fixture，用于验证 SQLite DataError 的固定分类。 */
    const database = new Database(databasePath)
    database.exec('CREATE TABLE large_values (payload BLOB); INSERT INTO large_values VALUES (zeroblob(2097152))')
    database.close()
    await expect(runServerOpsSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'large_values', rowOffset: 0, rowLimit: 10,
    }), createLocalChannelFactory([]))).rejects.toMatchObject({ code: 'SERVER_OPS_SQLITE_RESULT_TOO_LARGE' })
  })

  test('Given 损坏文件 When probe Then 必须实际读取 schema 后返回数据库损坏错误', async () => {
    /** 写入非 SQLite 内容，证明 probe 不能只依赖 connect 或 SELECT 常量。 */
    const corruptPath = join(fixtureDirectory, 'corrupt.sqlite')
    await Bun.write(corruptPath, 'this is not a sqlite database')
    await expect(runServerOpsSqliteRead(createInput({ filePath: corruptPath }), createLocalChannelFactory([])))
      .rejects.toMatchObject({
        code: 'SERVER_OPS_SQLITE_DATABASE_INVALID',
        publicMessage: '文件不是有效的 SQLite 数据库或数据库已损坏',
      })
  })

  test('Given WAL 模式且写连接保持打开 When 只读预览 Then 读取最新提交且不改写主文件', async () => {
    const writer = new Database(databasePath)
    writer.exec('PRAGMA journal_mode = WAL')
    writer.query('INSERT INTO users (name) VALUES (?)').run('WAL 已提交用户')
    /** 主文件状态用于证明远端只读连接没有回写数据库主体。 */
    const before = statSync(databasePath)
    try {
      const rows = await runServerOpsSqliteRead(createInput({
        mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0, rowLimit: 20,
      }), createLocalChannelFactory([]))
      expect('rows' in rows && rows.rows.map((row) => row[1])).toContain('WAL 已提交用户')
      const after = statSync(databasePath)
      expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs })
    } finally {
      writer.close()
    }
  })

  test('Given Python 缺失、sqlite3 缺失、版本过低或硬墙钟退出 When 读取 Then 返回各自固定中文错误', async () => {
    await expect(runServerOpsSqliteRead(createInput(), createFixedChannelFactory('', 127)))
      .rejects.toMatchObject({ code: 'SERVER_OPS_SQLITE_PYTHON_MISSING', publicMessage: '服务器未安装 Python 3' })
    await expect(runServerOpsSqliteRead(createInput(), createFixedChannelFactory(
      '{"ok":false,"code":"SERVER_OPS_SQLITE_MODULE_UNAVAILABLE"}', 0,
    ))).rejects.toMatchObject({
      code: 'SERVER_OPS_SQLITE_MODULE_UNAVAILABLE',
      publicMessage: '服务器 Python 缺少 sqlite3 模块',
    })
    await expect(runServerOpsSqliteRead(createInput(), createFixedChannelFactory(
      '{"ok":false,"code":"SERVER_OPS_SQLITE_PYTHON_VERSION_UNSUPPORTED"}', 0,
    ))).rejects.toMatchObject({
      code: 'SERVER_OPS_SQLITE_PYTHON_VERSION_UNSUPPORTED',
      publicMessage: '服务器 Python 版本过低，需要 Python 3.11 或更高版本',
    })
    await expect(runServerOpsSqliteRead(createInput(), createFixedChannelFactory('', 124)))
      .rejects.toMatchObject({ code: 'SERVER_OPS_SQLITE_TIMEOUT', publicMessage: 'SQLite 读取超时' })
  })

  test('Given 查询尝试调用高消耗函数 When 超过远端预算 Then 以固定超时错误结束', async () => {
    /** 记录每次独占远端进程的退出状态。 */
    const states: Array<{ exited: boolean }> = []
    /** 使用真实本地 shell/Python 模拟 SSH，验证进程生命周期。 */
    const createChannel = createLocalChannelFactory([], states)
    await expect(runServerOpsSqliteRead(createInput({
      mode: 'sql-query', queryId: 'query-timeout', timeoutMs: 1_000,
      sql: 'SELECT COUNT(*) FROM users a JOIN users b ON a.id >= b.id JOIN users c ON b.id >= c.id', maxRows: 10,
    }), createChannel)).resolves.toMatchObject({ queryId: 'query-timeout', rowCount: 1 })

    const database = new Database(databasePath)
    database.exec('WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 3000) INSERT INTO users (name) SELECT printf(\'user-%d\', value) FROM sequence')
    database.close()
    /** 高消耗联表会先触发 VM 指令预算，墙钟只负责检测意外悬挂。 */
    const startedAt = performance.now()
    await expect(runServerOpsSqliteRead(createInput({
      mode: 'sql-query', queryId: 'query-budget', timeoutMs: 15_000,
      sql: 'SELECT COUNT(*) FROM users a JOIN users b ON a.id >= b.id JOIN users c ON b.id >= c.id', maxRows: 10,
    }), createChannel)).rejects.toMatchObject({ code: 'SERVER_OPS_DATA_QUERY_TIMEOUT' })
    /** 不让预算失败后挂起；精确十秒封顶由下面的实际 payload 断言验证。 */
    expect(performance.now() - startedAt).toBeLessThan(13_000)
    await expect(runServerOpsSqliteRead(createInput({ mode: 'probe', timeoutMs: 1_000 }), createChannel))
      .resolves.toMatchObject({ capability: 'available' })
    expect(states.every((state) => state.exited)).toBe(true)
  })

  test('Given SQLite 数据库被独占锁定 When Agent 查询 Then 锁等待有界并返回锁定错误', async () => {
    /** 仅锁定临时夹具数据库，模拟其他程序正在修改数据。 */
    const writer = new Database(databasePath)
    writer.exec('BEGIN EXCLUSIVE')
    /** 统计忙等待的实际墙钟时间，不依赖 mock 计时器。 */
    const startedAt = performance.now()
    try {
      await expect(runServerOpsSqliteRead(createInput({ mode: 'sql-query', queryId: 'locked', timeoutMs: 10_000,
        sql: 'SELECT id FROM users', maxRows: 10 }), createLocalChannelFactory([])))
        .rejects.toMatchObject({ code: 'SERVER_OPS_SQLITE_DATABASE_LOCKED' })
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
    expect(performance.now() - startedAt).toBeLessThan(4_000)
  })

  test('Given 调用方请求超过上限的预算 When 执行查询和行预览 Then 远端 payload 按模式收敛预算', async () => {
    /** 收集真实发送内容，防止只改变文案而未压缩超时参数。 */
    const payloads: Array<Record<string, unknown>> = []
    /** 在正常返回路径核对预算，不需要故意等待十秒。 */
    const createChannel = createLocalChannelFactory([], [], payloads)
    await expect(runServerOpsSqliteRead(createInput({ mode: 'sql-query', queryId: 'budget-payload', timeoutMs: 15_000,
      sql: 'SELECT id FROM users', maxRows: 1 }), createChannel)).resolves.toMatchObject({ queryId: 'budget-payload' })
    await expect(runServerOpsSqliteRead(createInput({ mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users',
      rowOffset: 0, rowLimit: 1, timeoutMs: 15_000 }), createChannel)).resolves.toMatchObject({ mode: 'schema-rows' })
    await expect(runServerOpsSqliteRead(createInput({ mode: 'probe', timeoutMs: 15_000 }), createChannel))
      .resolves.toMatchObject({ capability: 'available' })
    expect(payloads.map((payload) => [payload.mode, payload.timeoutMs])).toEqual([
      ['sql-query', 10_000], ['schema-rows', 10_000], ['probe', 15_000],
    ])
  })

  test('Given 在途远端进程 When 用户取消 Then 发送 TERM、关闭通道并返回取消码', async () => {
    let termSignals = 0
    let destroyed = 0
    let writable = true
    const createChannel: ServerOpsSqliteChannelFactory = async () => {
      /** 该替身永不自然结束，用于证明取消不依赖远端响应。 */
      const listeners = new Map<string, (...values: unknown[]) => void>()
      /** 取消测试 channel 永不主动结束，只记录终止动作。 */
      const channel: ServerOpsSqliteChannel = {
        stderr: { on() { return this } },
        on(event, listener) { listeners.set(event, listener as (...values: unknown[]) => void); return channel },
        once(event, listener) { listeners.set(event, listener as (...values: unknown[]) => void); return channel },
        write() { return writable },
        destroy() { writable = false; destroyed += 1 },
        signal(_name, callback) {
          /** 模拟 ssh2：只有保持可写的 channel 才真正发送 signal。 */
          if (writable) termSignals += 1
          callback?.()
        },
      }
      return channel
    }
    const controller = new AbortController()
    const pending = runServerOpsSqliteRead(createInput(), createChannel, controller.signal)
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toThrow('SERVER_OPS_DATA_CANCELLED')
    expect(termSignals).toBe(1)
    expect(destroyed).toBe(1)
  })
})
