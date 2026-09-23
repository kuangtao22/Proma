import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerOpsRuntimeDataReadRequest } from './server-ops-runtime-protocol'
import { runServerOpsLocalSqliteRead, SERVER_OPS_LOCAL_SQLITE_SCRIPT } from './server-ops-local-sqlite-runtime'

/** 当前测试使用的临时目录，每个用例后整体回收。 */
let fixtureDirectory = ''
/** 当前测试使用的真实 SQLite 文件路径。 */
let databasePath = ''

/** 返回 Electron 可执行文件，确保测试覆盖与生产相同的 node:sqlite 实现。 */
function getElectronExecutablePath(): string {
  const executable: unknown = createRequire(import.meta.url)('electron')
  if (typeof executable !== 'string') throw new Error('TEST_ELECTRON_EXECUTABLE_MISSING')
  return executable
}

/** 从 bigint stat 构造主进程与 runtime 共用的稳定文件身份。 */
function getFileId(path: string): string {
  const stat = statSync(path, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

/** 等待中间父进程输出数据库子进程 PID。 */
async function readChildPid(processWithStdout: ReturnType<typeof spawn>): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let output = ''
    processWithStdout.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const line = output.split('\n')[0] ?? ''
      if (/^\d+$/u.test(line)) resolve(Number(line))
    })
    processWithStdout.once('error', reject)
    processWithStdout.once('close', () => reject(new Error('TEST_PARENT_EXITED_BEFORE_PID')))
  })
}

/** 等待原查询释放 SQLite 读锁，证明孤儿进程不再执行 sqlite3_step。 */
async function waitForExclusiveLock(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const database = new Database(path)
    try {
      database.exec('PRAGMA busy_timeout = 50; BEGIN EXCLUSIVE; ROLLBACK')
      return true
    } catch {
      // 查询仍持有读锁时短暂等待 watchdog，不放宽三秒总预算。
    } finally {
      database.close()
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** 等待长查询实际持有读锁；只把 SQLite 明确的 locked/busy 视为命中。 */
async function waitForReadLock(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const database = new Database(path)
    let transactionStarted = false
    try {
      database.exec('PRAGMA busy_timeout = 20; BEGIN EXCLUSIVE')
      transactionStarted = true
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : ''
      if (message.includes('locked') || message.includes('busy')) return true
      throw error
    } finally {
      if (transactionStarted) database.exec('ROLLBACK')
      database.close()
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

/** 构造本地 SQLite runtime 请求。 */
function createInput(overrides: Partial<ServerOpsRuntimeDataReadRequest> = {}): ServerOpsRuntimeDataReadRequest {
  return {
    requestId: 'request-local-sqlite',
    hostId: 'local',
    connectionId: 'connection-local-sqlite',
    transport: 'direct',
    mode: 'probe',
    engine: 'sqlite',
    database: 'main',
    filePath: databasePath,
    localFileId: getFileId(databasePath),
    tlsMode: 'disabled',
    timeoutMs: 15_000,
    ...overrides,
  }
}

beforeEach(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'proma-local-sqlite-runtime-'))
  databasePath = join(fixtureDirectory, "本地 数据'$(touch SHOULD_NOT_EXIST).sqlite")
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

describe('本地 SQLite 只读运行时', () => {
  test('Given 本地 SQLite 文件 When 探测、浏览、筛选与查询 Then 结果和远端工作台合同一致', async () => {
    const executablePath = getElectronExecutablePath()
    await expect(runServerOpsLocalSqliteRead(createInput(), undefined, { executablePath }))
      .resolves.toMatchObject({ capability: 'available', metrics: [], tables: [], warnings: [] })
    await expect(runServerOpsLocalSqliteRead(createInput({ mode: 'schema-tables', schemaDatabase: 'main' }), undefined, { executablePath }))
      .resolves.toMatchObject({ mode: 'schema-tables', database: 'main', tables: [{ name: 'users', type: 'table' }] })
    await expect(runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-table', schemaDatabase: 'main', schemaTable: 'users',
    }), undefined, { executablePath })).resolves.toMatchObject({
      mode: 'schema-table', indexes: [{ name: 'users_name_idx', unique: false, columns: ['name'] }],
    })
    await expect(runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0, rowLimit: 20,
      rowFilters: { match: 'all', conditions: [{ column: 'name', operator: 'contains', value: '中文' }] },
    }), undefined, { executablePath })).resolves.toMatchObject({
      columns: ['id', 'name', 'authorization', 'payload', 'note'],
      rows: [['1', '中文用户', '***', { kind: 'binary', bytes: 3 }, { kind: 'text', truncated: true }]],
      hasMore: false,
      orderedByPrimaryKey: true,
    })
    await expect(runServerOpsLocalSqliteRead(createInput({
      mode: 'sql-query', queryId: 'local-empty', sql: 'SELECT id, name FROM users WHERE id = 404', maxRows: 10,
    }), undefined, { executablePath })).resolves.toMatchObject({
      queryId: 'local-empty', database: 'main', columns: ['id', 'name'], rows: [], rowCount: 0,
    })
    await expect(runServerOpsLocalSqliteRead(createInput({
      mode: 'sql-query', queryId: 'local-values', sql: 'SELECT NULL AS empty_value, payload FROM users', maxRows: 10,
    }), undefined, { executablePath })).resolves.toMatchObject({
      columns: ['empty_value', 'payload'], rows: [[null, { kind: 'binary', bytes: 3 }]], rowCount: 1,
    })
  })

  test('Given 本地 SQLite 有损文本 When 按摘要读取全文 Then 返回原文并拒绝换序、敏感列与超限值', async () => {
    const executablePath = getElectronExecutablePath()
    const preview = await runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0, rowLimit: 20,
    }), undefined, { executablePath })
    if (!('rows' in preview)) throw new Error('TEST_SCHEMA_ROWS_MISSING')
    const note = preview.rows[0]?.[4]
    if (typeof note !== 'object' || note === null || note.kind !== 'text' || note.sha256 === undefined) {
      throw new Error('TEST_CELL_DIGEST_MISSING')
    }
    await expect(runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-cell', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0,
      cellColumnIndex: 4, cellExpectedColumn: 'note', cellSha256: note.sha256,
    }), undefined, { executablePath })).resolves.toMatchObject({ mode: 'schema-cell', value: `长文本${'甲'.repeat(300)}` })
    await expect(runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-cell', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0,
      cellColumnIndex: 0, cellExpectedColumn: 'id', cellSha256: createHash('sha256').update('1', 'utf8').digest('hex'),
    }), undefined, { executablePath })).resolves.toMatchObject({ mode: 'schema-cell', value: '1' })

    const database = new Database(databasePath)
    database.query('UPDATE users SET note = ? WHERE id = 1').run(`长文本${'甲'.repeat(253)}不同尾部`)
    database.exec('CREATE TABLE large_text (value TEXT)')
    database.query('INSERT INTO large_text VALUES (?)').run('x'.repeat(1_048_577))
    database.close()
    await expect(runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-cell', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0,
      cellColumnIndex: 4, cellExpectedColumn: 'note', cellSha256: note.sha256,
    }), undefined, { executablePath })).rejects.toMatchObject({ code: 'SERVER_OPS_DATA_CELL_CHANGED' })
    await expect(runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-cell', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0,
      cellColumnIndex: 2, cellExpectedColumn: 'authorization', cellSha256: 'a'.repeat(64),
    }), undefined, { executablePath })).rejects.toMatchObject({ code: 'SERVER_OPS_DATA_CELL_REDACTED' })

    const largePreview = await runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'large_text', rowOffset: 0, rowLimit: 1,
    }), undefined, { executablePath })
    if (!('rows' in largePreview)) throw new Error('TEST_SCHEMA_ROWS_MISSING')
    const largeCell = largePreview.rows[0]?.[0]
    if (typeof largeCell !== 'object' || largeCell === null || largeCell.kind !== 'text' || largeCell.sha256 === undefined) {
      throw new Error('TEST_CELL_DIGEST_MISSING')
    }
    await expect(runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-cell', schemaDatabase: 'main', schemaTable: 'large_text', rowOffset: 0,
      cellColumnIndex: 0, cellExpectedColumn: 'value', cellSha256: largeCell.sha256,
    }), undefined, { executablePath })).rejects.toMatchObject({ code: 'SERVER_OPS_DATA_CELL_TOO_LARGE' })
  }, 15_000)

  test('Given WAL 中有已提交数据 When 本地只读预览 Then 读取最新数据且不改写数据库主文件', async () => {
    const writer = new Database(databasePath)
    writer.exec('PRAGMA journal_mode = WAL')
    writer.query('INSERT INTO users (name) VALUES (?)').run('WAL 已提交用户')
    const before = statSync(databasePath)
    try {
      const result = await runServerOpsLocalSqliteRead(createInput({
        mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'users', rowOffset: 0, rowLimit: 20,
      }), undefined, { executablePath: getElectronExecutablePath() })
      expect('rows' in result && result.rows.map((row) => row[1])).toContain('WAL 已提交用户')
      const after = statSync(databasePath)
      expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs })
    } finally {
      writer.close()
    }
  })

  test('Given 写语句、敏感列与视图 When 本地查询 Then AST 与 authorizer 在读值前拒绝', async () => {
    const database = new Database(databasePath)
    database.exec('CREATE VIEW public_view AS SELECT authorization FROM users')
    database.close()
    const executablePath = getElectronExecutablePath()
    for (const sql of [
      'DELETE FROM users',
      'SELECT authorization AS harmless FROM users',
      'SELECT * FROM public_view',
      "SELECT load_extension('/tmp/extension') FROM users",
      'SELECT * FROM other.users',
    ]) {
      await expect(runServerOpsLocalSqliteRead(createInput({
        mode: 'sql-query', queryId: 'local-rejected', sql, maxRows: 10,
      }), undefined, { executablePath })).rejects.toThrow()
    }
    await expect(runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'public_view', rowOffset: 0, rowLimit: 10,
    }), undefined, { executablePath })).rejects.toMatchObject({ code: 'SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE' })
  })

  test('Given 非数据库或空查询结果 When 本地读取 Then 分别返回损坏错误与完整列头', async () => {
    const executablePath = getElectronExecutablePath()
    const corruptPath = join(fixtureDirectory, 'corrupt.sqlite')
    writeFileSync(corruptPath, 'not a sqlite database')
    await expect(runServerOpsLocalSqliteRead(createInput({
      filePath: corruptPath,
      localFileId: getFileId(corruptPath),
    }), undefined, { executablePath })).rejects.toMatchObject({ code: 'SERVER_OPS_SQLITE_DATABASE_INVALID' })
    await expect(runServerOpsLocalSqliteRead(createInput({
      mode: 'sql-query', queryId: 'local-null-blob', sql: 'SELECT NULL AS empty_value, payload FROM users WHERE id = 404', maxRows: 10,
    }), undefined, { executablePath })).resolves.toMatchObject({
      columns: ['empty_value', 'payload'], rows: [], rowCount: 0,
    })
  })

  test('Given 超大 BLOB 与独占锁 When 本地读取 Then 分别返回大小限制与有界锁定错误', async () => {
    const database = new Database(databasePath)
    database.exec('CREATE TABLE large_values (payload BLOB); INSERT INTO large_values VALUES (zeroblob(2097152))')
    database.close()
    const executablePath = getElectronExecutablePath()
    await expect(runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'large_values', rowOffset: 0, rowLimit: 10,
    }), undefined, { executablePath })).rejects.toMatchObject({ code: 'SERVER_OPS_SQLITE_RESULT_TOO_LARGE' })

    const writer = new Database(databasePath)
    writer.exec('BEGIN EXCLUSIVE')
    const startedAt = performance.now()
    try {
      await expect(runServerOpsLocalSqliteRead(createInput({
        mode: 'sql-query', queryId: 'local-locked', timeoutMs: 10_000, sql: 'SELECT id FROM users', maxRows: 10,
      }), undefined, { executablePath })).rejects.toMatchObject({ code: 'SERVER_OPS_SQLITE_DATABASE_LOCKED' })
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
    expect(performance.now() - startedAt).toBeLessThan(4_000)
  })

  test('Given 复合主键成员位于第65列 When 跨页预览 Then 使用完整主键稳定排序但只展示前64列', async () => {
    const database = new Database(databasePath)
    const visibleColumns = Array.from({ length: 64 }, (_, index) => `visible_${index} TEXT`).join(', ')
    database.exec(`CREATE TABLE wide_keys (${visibleColumns}, late_key INTEGER, PRIMARY KEY (visible_0, late_key DESC))`)
    database.prepare('INSERT INTO wide_keys (visible_0, visible_1, late_key) VALUES (?, ?, ?)').run('same', '第二条', 2)
    database.prepare('INSERT INTO wide_keys (visible_0, visible_1, late_key) VALUES (?, ?, ?)').run('same', '第一条', 1)
    database.close()
    const executablePath = getElectronExecutablePath()

    const first = await runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'wide_keys', rowOffset: 0, rowLimit: 1,
    }), undefined, { executablePath })
    const second = await runServerOpsLocalSqliteRead(createInput({
      mode: 'schema-rows', schemaDatabase: 'main', schemaTable: 'wide_keys', rowOffset: 1, rowLimit: 1,
    }), undefined, { executablePath })
    expect(first).toMatchObject({ orderedByPrimaryKey: true, hasMore: true })
    expect(second).toMatchObject({ orderedByPrimaryKey: true, hasMore: false })
    expect('rows' in first && first.rows[0]?.[1]).toBe('第一条')
    expect('rows' in second && second.rows[0]?.[1]).toBe('第二条')
    expect('columns' in first && first.columns).toHaveLength(64)
  })

  test('Given 子进程无法加载 node:sqlite When 读取 Then 只返回固定错误且不泄漏 stderr', async () => {
    await expect(runServerOpsLocalSqliteRead(createInput(), undefined, { executablePath: process.execPath }))
      .rejects.toMatchObject({ code: 'SERVER_OPS_SQLITE_READ_FAILED', publicMessage: 'SQLite 读取失败，请检查文件状态与读取权限' })
  })

  test('Given utility 父进程在阻塞查询中被强杀 When watchdog 检测失联 Then SQLite 子进程停止执行并释放读锁', async () => {
    const database = new Database(databasePath)
    database.exec("WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 3000) INSERT INTO users (name) SELECT printf('user-%d', value) FROM sequence")
    database.close()
    const payload = {
      mode: 'sql-query', filePath: databasePath, localFileId: getFileId(databasePath), timeoutMs: 10_000,
      queryId: 'orphan-watchdog', sql: 'SELECT COUNT(*) FROM users a JOIN users b ON a.id >= b.id JOIN users c ON b.id >= c.id LIMIT 11',
      maxRows: 10, allowedTables: ['users'], hasWildcard: false,
    }
    /** 中间 Electron Node 进程模拟 utility，并把固定脚本启动成其直接子进程。 */
    const harnessScript = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(SERVER_OPS_LOCAL_SQLITE_SCRIPT)}], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'ignore', 'ignore'],
      });
      process.stdout.write(String(child.pid) + '\\n');
      child.stdin.end(${JSON.stringify(JSON.stringify(payload))});
      setInterval(() => {}, 1000);
    `
    const harness = spawn(getElectronExecutablePath(), ['-e', harnessScript], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const childPid = await readChildPid(harness)
    try {
      /** 必须先证明长查询已持有读锁，避免慢机器上只验证启动前退出。 */
      expect(await waitForReadLock(databasePath, 3_000)).toBe(true)
      harness.kill('SIGKILL')
      expect(await waitForExclusiveLock(databasePath, 3_000)).toBe(true)
    } finally {
      try { process.kill(childPid, 'SIGKILL') } catch { /* watchdog 已完成回收。 */ }
      try { harness.kill('SIGKILL') } catch { /* 中间父进程已退出。 */ }
    }
  })

  test('Given 主进程登记后路径被替换 When 本地读取 Then 在打开前拒绝新的 inode', async () => {
    const input = createInput()
    const replacement = join(fixtureDirectory, 'replacement.sqlite')
    const database = new Database(replacement, { create: true })
    database.exec('CREATE TABLE replacement (id INTEGER)')
    database.close()
    const original = join(fixtureDirectory, 'original.sqlite')
    renameSync(databasePath, original)
    renameSync(replacement, databasePath)

    await expect(runServerOpsLocalSqliteRead(input, undefined, { executablePath: getElectronExecutablePath() }))
      .rejects.toMatchObject({ code: 'SERVER_OPS_SQLITE_FILE_CHANGED' })
  })

  test('Given 高消耗本地查询 When 超时或取消 Then 等子进程退出后及时返回且后续读取可继续', async () => {
    const database = new Database(databasePath)
    database.exec("WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 3000) INSERT INTO users (name) SELECT printf('user-%d', value) FROM sequence")
    database.close()
    const executablePath = getElectronExecutablePath()
    const query = createInput({
      mode: 'sql-query', queryId: 'local-long-query', timeoutMs: 250,
      sql: 'SELECT COUNT(*) FROM users a JOIN users b ON a.id >= b.id JOIN users c ON b.id >= c.id', maxRows: 10,
    })
    const startedAt = performance.now()
    await expect(runServerOpsLocalSqliteRead(query, undefined, { executablePath }))
      .rejects.toMatchObject({ code: 'SERVER_OPS_DATA_QUERY_TIMEOUT' })
    expect(performance.now() - startedAt).toBeLessThan(3_000)

    const controller = new AbortController()
    const pending = runServerOpsLocalSqliteRead({ ...query, requestId: 'request-cancelled', timeoutMs: 10_000 }, controller.signal, { executablePath })
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toThrow('SERVER_OPS_DATA_CANCELLED')
    await expect(runServerOpsLocalSqliteRead(createInput(), undefined, { executablePath }))
      .resolves.toMatchObject({ capability: 'available' })
  })
})
