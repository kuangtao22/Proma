/** 隔离 Electron 主进程 → utility → SQLite 子进程的本地数据库验收，不读取用户配置。 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { ServerOpsDataService } from '../src/main/lib/server-ops/server-ops-data-service'
import { ServerOpsDataSourceStore } from '../src/main/lib/server-ops/server-ops-data-source-store'
import { ServerOpsRuntimeClient } from '../src/main/lib/server-ops/server-ops-runtime-client'

/** 夹具只需要建表与关闭能力；生产读取始终通过真实 utility。 */
interface FixtureDatabase { exec(sql: string): void; close(): void }
/** 当前 Electron 自带的 SQLite 夹具构造器，无需外部 Node 或 Python。 */
const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => FixtureDatabase }
/** 独立配置目录和 SQLite 文件，结束后整体删除。 */
const directory = mkdtempSync(join(tmpdir(), 'proma-local-sqlite-smoke-'))
/** 跨层客户端在 finally 中停止，不接触正式应用。 */
const runtime = new ServerOpsRuntimeClient()
/** 测试实例的 Electron 内部目录。 */
const electronDirectory = join(directory, 'electron')
mkdirSync(electronDirectory)
app.setPath('userData', electronDirectory)
/** 防止失败夹具永久遗留进程的整体验收时限。 */
const timeout = setTimeout(() => finish(1), 30_000)

/** 创建合成数据并验证完整本地读库链路、取消及原文件不变。 */
async function runSmoke(): Promise<void> {
  app.dock?.hide()
  /** 仅此脚本拥有的临时数据库。 */
  const filePath = join(directory, '业务库.sqlite3')
  const database = new sqlite.DatabaseSync(filePath)
  database.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY, title TEXT, password TEXT); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1200) INSERT INTO entries SELECT x, '合成-' || x, 'fixture-secret' FROM n;")
  /** 合成 JSON 详情含原始换行与超安全整数，不能以256字预览冒充全文。 */
  const cellValue = '{\n\t"id":90071992547409931234,"body":"' + '合成正文'.repeat(250) + '"\n}'
  database.exec("ALTER TABLE entries ADD COLUMN payload_json TEXT; UPDATE entries SET payload_json='" + cellValue.replaceAll("'", "''") + "' WHERE id=7")
  database.close()
  /** 保存原始字节，用于证明验收读取没有改写数据库。 */
  const before = readFileSync(filePath)
  /** 持久化和服务是真实实现；凭据/SSH 是不应触达的禁止路径。 */
  const store = new ServerOpsDataSourceStore(directory, { transaction: (callback) => callback() })
  const service = new ServerOpsDataService({ store, runtime,
    credentials: { setSecret: () => { throw new Error('不应保存凭据') }, resolveSecret: () => undefined, removeSecret: () => false, removeByHost: () => 0 },
    connection: { getActiveIdentity: () => { throw new Error('不应连接 SSH') } },
  })
  try {
    /** 登记本地来源并经真实跨进程协议读取。 */
    const source = service.upsertSource({ engine: 'sqlite', transport: 'direct', filePath, label: '隔离测试', database: 'main', tlsMode: 'disabled' }).source
    assert.equal((await service.probeSource({ sourceId: source.id })).capability, 'available')
    assert.equal((await service.listSchemaTables({ sourceId: source.id, database: 'main' })).tables[0]?.name, 'entries')
    assert.equal((await service.describeSchemaTable({ sourceId: source.id, database: 'main', table: 'entries' })).columns[0]?.name, 'id')
    /** 参数化筛选继续走现有行浏览合同。 */
    const rows = await service.readSchemaRows({ sourceId: source.id, database: 'main', table: 'entries', offset: 0, limit: 50,
      filters: { match: 'all', conditions: [{ column: 'id', operator: 'eq', value: '7' }] } })
    assert.equal(rows.rows.length, 1)
    assert.ok(!JSON.stringify(rows).includes('fixture-secret'))
    /** 摘要来自真实预览，详情经主进程、utility 和独立子进程完整往返。 */
    const preview = rows.rows[0]?.[3]
    assert.ok(preview !== null && typeof preview === 'object' && preview.kind === 'text' && preview.sha256)
    if (preview === null || typeof preview !== 'object' || preview.kind !== 'text' || !preview.sha256) throw new Error('详情预览摘要缺失')
    const detail = await service.readSchemaCell({ sourceId: source.id, database: 'main', table: 'entries', offset: 0,
      columnIndex: 3, expectedColumn: 'payload_json', sha256: preview.sha256,
      filters: { match: 'all', conditions: [{ column: 'id', operator: 'eq', value: '7' }] } })
    assert.equal(detail.value, cellValue)
    await assert.rejects(service.readSchemaCell({ sourceId: source.id, database: 'main', table: 'entries', offset: 0,
      columnIndex: 3, expectedColumn: 'payload_json', sha256: 'a'.repeat(64),
      filters: { match: 'all', conditions: [{ column: 'id', operator: 'eq', value: '7' }] } }))
    const query = await service.querySource({ sourceId: source.id, database: 'main', queryId: 'smoke-query', sql: 'SELECT id, title FROM entries WHERE id = 7', maxRows: 50 })
    assert.equal(query.rowCount, 1)
    assert.ok(JSON.stringify(query).includes('合成-7'))
    await assert.rejects(service.querySource({ sourceId: source.id, database: 'main', queryId: 'smoke-write', sql: 'DELETE FROM entries', maxRows: 50 }))
    /** 在实际长查询执行期间取消，并在确认终态后复用同一连接。 */
    const controller = new AbortController()
    const cancelTimer = setTimeout(() => controller.abort(), 300)
    const startedAt = Date.now()
    try {
      await assert.rejects(service.querySource({ sourceId: source.id, database: 'main', queryId: 'smoke-cancel',
        sql: 'SELECT COUNT(*) FROM entries a JOIN entries b ON 1 = 1 JOIN entries c ON 1 = 1', maxRows: 50 }, controller.signal),
      (error: unknown) => error instanceof Error && ('code' in error ? error.code === 'SERVER_OPS_DATA_CANCELLED' : error.message.includes('SERVER_OPS_DATA_CANCELLED')))
    } finally { clearTimeout(cancelTimer) }
    assert.ok(Date.now() - startedAt < 3_000, '取消必须及时确认真实进程收尾')
    assert.equal((await service.probeSource({ sourceId: source.id })).capability, 'available')
    assert.ok(before.equals(readFileSync(filePath)), '只读验收不得改写原数据库')
    console.log('[本地 SQLite smoke] PASS：真实 Electron→utility→子进程，登记/结构/筛选/单格完整原文及摘要验证/SQL/遮罩/写入拒绝/取消后复用/原文件不变')
  } finally { service.dispose() }
}

/** 停止本测试实例和临时目录，退出码供自动验收使用。 */
function finish(code: number): void {
  clearTimeout(timeout)
  runtime.stop()
  rmSync(directory, { recursive: true, force: true })
  app.exit(code)
}

void app.whenReady().then(runSmoke).then(() => finish(0), (error: unknown) => {
  console.error('[本地 SQLite smoke] FAIL', error)
  finish(1)
})
