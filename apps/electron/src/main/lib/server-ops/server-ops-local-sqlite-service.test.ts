import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseServerOpsDataSourceUpsertInput } from '@proma/shared'
import { ServerOpsDataSourceStore } from './server-ops-data-source-store'
import { ServerOpsDataService } from './server-ops-data-service'
import { ServerOpsDataSchemaCache } from './server-ops-data-schema-cache'
import type { ServerOpsDataServiceDependencies } from './server-ops-data-service'
import { parseServerOpsRuntimeRequest } from '../../../utility/server-ops/server-ops-runtime-protocol'

/** 每个用例独占的目录，结束后清理，避免触碰用户数据。 */
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** 创建真实配置 Store、临时数据库和只记录参数的运行时。 */
function fixture() {
  /** 隔离的配置与数据库路径。 */
  const directory = mkdtempSync(join(tmpdir(), 'proma-local-sqlite-service-'))
  directories.push(directory)
  const filePath = join(directory, '业务.db')
  const database = new Database(filePath)
  database.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, name TEXT)')
  database.close()
  /** 捕获实际下发的读取参数，不连接 SSH。 */
  const reads: Parameters<ServerOpsDataServiceDependencies['runtime']['dataRead']>[0][] = []
  const store = new ServerOpsDataSourceStore(directory, { transaction: (callback) => callback() })
  /** 可替换回执以复现读取途中替换，而不是只验证路径字符串。 */
  const runtime: ServerOpsDataServiceDependencies['runtime'] = { dataRead: async (input) => {
    reads.push(input)
    if (input.mode === 'schema-tables') return { mode: 'schema-tables', capability: 'available', databases: ['main'], database: 'main', tables: [], warnings: [] }
    return { capability: 'available', serverVersion: '3.50', metrics: [], tables: [], warnings: [] }
  } }
  const service = new ServerOpsDataService({
    store,
    credentials: { setSecret: () => { throw new Error('不应读取凭据') }, resolveSecret: () => undefined, removeSecret: () => false, removeByHost: () => 0 },
    connection: { getActiveIdentity: () => { throw new Error('不应连接 SSH') } },
    runtime,
    schemaCache: new ServerOpsDataSchemaCache(directory, { transaction: (callback) => callback() }),
  })
  const input = parseServerOpsDataSourceUpsertInput({ transport: 'direct', engine: 'sqlite', label: '业务库', filePath, tlsMode: 'disabled' })
  return { directory, filePath, store, service, input, reads, runtime }
}

describe('本地 SQLite 主进程绑定与读取', () => {
  test('Given 截断单元格 When 读取全文 Then 复用文件身份并校验原文摘要', async () => {
    /** 合成全文与真实本地配置，仅 runtime 使用受控回执。 */
    const state = fixture()
    const source = state.service.upsertSource(state.input).source
    const value = '{\n"payload":"' + 'x'.repeat(400) + '"\n}'
    const sha256 = createHash('sha256').update(value).digest('hex')
    const input = { sourceId: source.id, database: 'main', table: 'entries', offset: 53, columnIndex: 1, expectedColumn: 'name', sha256 }
    state.runtime.dataRead = async (request) => {
      state.reads.push(request)
      return { mode: 'schema-cell', capability: 'available', value, warnings: [] }
    }
    await expect(state.service.readSchemaCell(input)).resolves.toEqual({ value })
    expect(state.reads[0]).toMatchObject({ mode: 'schema-cell', rowOffset: 53, cellColumnIndex: 1,
      cellExpectedColumn: 'name', cellSha256: sha256, localFileId: source.localFileId })
    expect(state.reads[0]).not.toHaveProperty('rowLimit')
    await expect(state.service.readSchemaCell({ ...input, sha256: 'b'.repeat(64) })).rejects.toThrow('SERVER_OPS_DATA_CELL_CHANGED')
  })
  test('Given 全文读取途中来源被替换 When 回执到达 Then 拒绝旧来源内容', async () => {
    /** 真实替换临时库，验证单格入口没有绕过身份复核。 */
    const state = fixture()
    const source = state.service.upsertSource(state.input).source
    const value = 'x'.repeat(400)
    state.runtime.dataRead = async () => {
      renameSync(state.filePath, `${state.filePath}.original`)
      const replacement = new Database(state.filePath)
      replacement.exec('CREATE TABLE other (id INTEGER)')
      replacement.close()
      return { mode: 'schema-cell', capability: 'available', value, warnings: [] }
    }
    await expect(state.service.readSchemaCell({ sourceId: source.id, database: 'main', table: 'entries', offset: 0,
      columnIndex: 1, expectedColumn: 'name', sha256: createHash('sha256').update(value).digest('hex') }))
      .rejects.toThrow('SERVER_OPS_SQLITE_FILE_CHANGED')
  })
  test('Given 真实 SQLite When 保存重载并读取 Then 固定文件身份且无需 SSH 或 TLS', async () => {
    const state = fixture()
    const source = state.service.upsertSource(state.input).source
    expect(source.localFileId).toMatch(/^\d+:\d+:\d+$/u)
    const reloaded = new ServerOpsDataSourceStore(state.directory, { transaction: (callback) => callback() }).getById(source.id)
    expect(reloaded?.localFileId).toBe(source.localFileId)
    await expect(state.service.probeSource({ sourceId: source.id })).resolves.toHaveProperty('capability', 'available')
    expect(state.reads[0]?.localFileId).toBe(source.localFileId)
    expect(parseServerOpsRuntimeRequest({ type: 'server-ops.data-read', input: { ...state.reads[0], requestId: 'local-read' } })).toHaveProperty('input.localFileId', source.localFileId)
  })

  test('Given 普通文件或缺失文件 When 保存 Then 拒绝且不留下数据源', () => {
    const state = fixture()
    writeFileSync(state.filePath, 'not sqlite')
    expect(() => state.service.upsertSource(state.input)).toThrow('SERVER_OPS_SQLITE_DATABASE_INVALID')
    expect(state.store.list()).toHaveLength(0)
    rmSync(state.filePath)
    expect(() => state.service.upsertSource(state.input)).toThrow('SERVER_OPS_SQLITE_FILE_NOT_FOUND')
  })

  test('Given 同一路径被替换 When 读取或只修改名称 Then 阻止沿用旧身份', async () => {
    const state = fixture()
    const source = state.service.upsertSource(state.input).source
    renameSync(state.filePath, `${state.filePath}.original`)
    const replacement = new Database(state.filePath)
    replacement.exec('CREATE TABLE other (id INTEGER)')
    replacement.close()
    await expect(state.service.probeSource({ sourceId: source.id })).rejects.toThrow('SERVER_OPS_SQLITE_FILE_CHANGED')
    expect(state.reads).toHaveLength(0)
    expect(() => state.service.upsertSource({ ...state.input, sourceId: source.id, label: '改名' })).toThrow('SERVER_OPS_SQLITE_FILE_CHANGED')
  })

  test('Given 原数据库正常写入 When 下一次读取 Then 文件身份不变', async () => {
    const state = fixture()
    const source = state.service.upsertSource(state.input).source
    const database = new Database(state.filePath)
    database.exec("INSERT INTO entries(name) VALUES ('正常更新')")
    database.close()
    await expect(state.service.probeSource({ sourceId: source.id })).resolves.toHaveProperty('capability', 'available')
    expect(state.reads[0]?.localFileId).toBe(source.localFileId)
  })

  // Windows 普通账户默认不能创建文件符号链接；其余真实文件身份用例仍全平台执行。
  test.skipIf(process.platform === 'win32')('Given 符号链接文件 When 登记 Then 保存真实文件路径而不是可重新指向的链接', async () => {
    const state = fixture()
    const linkPath = join(state.directory, 'alias.db')
    symlinkSync(state.filePath, linkPath)
    const source = state.service.upsertSource({ ...state.input, filePath: linkPath }).source
    expect(source.filePath).not.toBe(linkPath)
    rmSync(linkPath)
    await expect(state.service.probeSource({ sourceId: source.id })).resolves.toHaveProperty('capability', 'available')
  })

  test('Given 已缓存表目录 When 文件被替换 Then 也不能从旧缓存返回成功', async () => {
    const state = fixture()
    const source = state.service.upsertSource(state.input).source
    await state.service.listSchemaTables({ sourceId: source.id, database: 'main', cacheMode: 'prefer-cache' })
    await state.service.listSchemaTables({ sourceId: source.id, database: 'main', cacheMode: 'prefer-cache' })
    expect(state.reads).toHaveLength(1)
    renameSync(state.filePath, `${state.filePath}.original`)
    const replacement = new Database(state.filePath)
    replacement.exec('CREATE TABLE other (id INTEGER)')
    replacement.close()
    await expect(state.service.listSchemaTables({ sourceId: source.id, database: 'main', cacheMode: 'prefer-cache' })).rejects.toThrow('SERVER_OPS_SQLITE_FILE_CHANGED')
    expect(state.reads).toHaveLength(1)
  })

  test('Given 读取过程中原文件被替换 When 返回成功回执 Then 主进程拒绝迟到数据', async () => {
    const state = fixture()
    const source = state.service.upsertSource(state.input).source
    state.runtime.dataRead = async () => {
      renameSync(state.filePath, `${state.filePath}.original`)
      const replacement = new Database(state.filePath)
      replacement.exec('CREATE TABLE other (id INTEGER)')
      replacement.close()
      return { capability: 'available', serverVersion: '3.50', metrics: [], tables: [], warnings: [] }
    }
    await expect(state.service.probeSource({ sourceId: source.id })).rejects.toThrow('SERVER_OPS_SQLITE_FILE_CHANGED')
  })
})
