import { describe, expect, test } from 'bun:test'
import { isServerOpsAgentTableAllowed } from '@proma/shared'
import { prepareServerOpsDatabaseChangeContext } from './server-ops-database-change-context'
import type { ServerOpsAgentReadFacade } from './server-ops-agent-read-facade'

/** 结构专用依赖不提供查询/执行接口，测试同时验证只读能力的最小边界。 */
function fixture() {
  /** 收集真正发生的结构读取，发现越权目标被提前访问。 */
  const reads: string[] = []
  /** 可变租约代次用于模拟异步读取期间重新授权。 */
  let revision = 1
  /** 仅暴露结构权限，不提供行访问与 SQL 查询。 */
  const facade: Pick<ServerOpsAgentReadFacade, 'resources' | 'checkDatabaseTables' | 'databaseDescribe'> = {
    resources: () => ({ revision, resources: [{ kind: 'mysql', sourceId: 'db-1', name: '测试库', instance: false,
      databases: [{ database: 'app', tables: ['users', 'orders'], readRows: false }] }] }),
    checkDatabaseTables: ({ sourceId, database, tables, revision: expectedRevision }) => {
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('SERVER_OPS_AGENT_ACCESS_CHANGED')
      const resource = facade.resources().resources.find((entry) => entry.kind !== 'ssh' && entry.sourceId === sourceId)
      if (!resource || (resource.kind !== 'mysql' && resource.kind !== 'sqlite')) throw new Error('SERVER_OPS_AGENT_ACCESS_REQUIRED')
      const scope = resource.databases.find((entry) => entry.database === database)
      if (!scope || tables.some((table) => !isServerOpsAgentTableAllowed(resource.kind, scope, table))) throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
      return { engine: resource.kind, revision }
    },
    databaseDescribe: async ({ table }) => {
      reads.push(table)
      return { columns: [{ name: 'id', type: 'bigint', nullable: false, primaryKey: true }],
        indexes: [{ name: 'PRIMARY', unique: true, columns: ['id'] }] }
    },
  }
  return { facade, reads, regrant: () => { revision += 1 } }
}

describe('数据库变更脚本上下文', () => {
  test('Given 仅表结构授权 When 请求变更依据 Then 只读指定结构并要求核对程序与人工执行', async () => {
    /** 无任何真实连接的授权依赖。 */
    const state = fixture()
    /** 两张相关表组成一次有界结构快照。 */
    const result = await prepareServerOpsDatabaseChangeContext(state.facade, { sourceId: 'db-1', database: 'app', tables: ['users', 'orders'] })
    expect(state.reads).toEqual(['users', 'orders'])
    expect(result.engine).toBe('mysql')
    expect(result.executionAllowed).toBe(false)
    expect(result.programContext).toBe('not-inspected')
    expect(result.schemaCoverage).toBe('columns-and-indexes-only')
    expect(result.workflow.join('\n')).toContain('业务校验')
    expect(result.workflow.join('\n')).toContain('预检查')
    expect(result.workflow.join('\n')).toContain('不得执行')
    expect(result.warnings.join('\n')).toContain('外键')
    expect(result.tables.map((table) => table.name)).toEqual(['users', 'orders'])
  })

  test('Given 写入字段、凭据或无效目标 When 解析 Then 不进行任何读取', async () => {
    /** 每项输入共享同一基线，额外字段必须拒绝而非静默忽略。 */
    const input = { sourceId: 'db-1', database: 'app', tables: ['users'] }
    for (const invalid of [
      { ...input, sql: 'UPDATE users SET id=1' }, { ...input, execute: true }, { ...input, password: 'secret' },
      { ...input, sessionId: 'other' }, { ...input, tables: [] }, { ...input, tables: ['users', 'users'] },
      { ...input, tables: ['a', 'b', 'c', 'd', 'e'] }, { ...input, database: 'app\n' },
      { ...input, tables: ['users\0'] }, { ...input, sourceId: '' },
    ]) {
      /** 每次失败必须发生在任何结构访问之前。 */
      const state = fixture()
      await expect(prepareServerOpsDatabaseChangeContext(state.facade, invalid)).rejects.toThrow('SERVER_OPS_CHANGE_CONTEXT_INPUT_INVALID')
      expect(state.reads).toEqual([])
    }
  })

  test('Given 任一表不在允许范围 When 请求组合上下文 Then 整次失败且不先读其它表', async () => {
    /** 防止部分授权变成跨库读取机会。 */
    const state = fixture()
    await expect(prepareServerOpsDatabaseChangeContext(state.facade, { sourceId: 'db-1', database: 'app', tables: ['users', 'secret'] }))
      .rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    expect(state.reads).toEqual([])
  })

  test('Given 全表范围有排除表 When 请求多表脚本依据 Then 拒绝整组且不读取其它表', async () => {
    const state = fixture()
    state.facade.resources = () => ({ revision: 1, resources: [{ kind: 'mysql', sourceId: 'db-1', name: '测试库', instance: false,
      databases: [{ database: 'app', tables: null, excludedTables: ['Secret'], readRows: false }] }] })
    await expect(prepareServerOpsDatabaseChangeContext(state.facade, { sourceId: 'db-1', database: 'app', tables: ['users', 'secret'] }))
      .rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    expect(state.reads).toEqual([])
    await expect(prepareServerOpsDatabaseChangeContext(state.facade, { sourceId: 'db-1', database: 'app', tables: ['users'] }))
      .resolves.toMatchObject({ executionAllowed: false })
    expect(state.reads).toEqual(['users'])
  })

  test('Given 结构读取期间授权改变 When 等待结束 Then 不返回旧快照', async () => {
    /** 在最后一次 await 内重新授权，检测组合结果的最终复核。 */
    const state = fixture()
    state.facade.databaseDescribe = async () => { state.regrant(); return { columns: [], indexes: [] } }
    await expect(prepareServerOpsDatabaseChangeContext(state.facade, { sourceId: 'db-1', database: 'app', tables: ['users'] }))
      .rejects.toThrow('SERVER_OPS_AGENT_ACCESS_CHANGED')
  })

  test('Given 取消已发生或在读取期间发生 When 生成上下文 Then 传递信号且不返回结果', async () => {
    /** 测试真实取消信号同时作为工具输入与结构读取依赖。 */
    const state = fixture()
    const controller = new AbortController()
    state.facade.databaseDescribe = async (_input, signal) => {
      expect(signal).toBe(controller.signal)
      controller.abort()
      return { columns: [], indexes: [] }
    }
    await expect(prepareServerOpsDatabaseChangeContext(state.facade, { sourceId: 'db-1', database: 'app', tables: ['users'] }, controller.signal))
      .rejects.toThrow('SERVER_OPS_AGENT_READ_CANCELLED')
    state.facade.databaseDescribe = async () => { throw new Error('不得读取') }
    await expect(prepareServerOpsDatabaseChangeContext(state.facade, { sourceId: 'db-1', database: 'app', tables: ['users'] }, controller.signal))
      .rejects.toThrow('SERVER_OPS_AGENT_READ_CANCELLED')
  })

  test('Given SQLite 与截断结构 When 生成上下文 Then 保留方言与不完整证据标记并限制输出', async () => {
    /** 模拟大量中文结构注释，验证最终 JSON 的字节预算。 */
    const state = fixture()
    state.facade.resources = () => ({ revision: 1, resources: [{ kind: 'sqlite', sourceId: 'db-1', name: 'SQLite', instance: false,
      databases: [{ database: 'main', tables: null, readRows: false }] }] })
    state.facade.databaseDescribe = async () => ({ truncated: true,
      columns: Array.from({ length: 256 }, (_, index) => ({ name: `column_${index}`, type: 'text', nullable: true, primaryKey: false, comment: '字段说明'.repeat(50) })), indexes: [] })
    const result = await prepareServerOpsDatabaseChangeContext(state.facade, { sourceId: 'db-1', database: 'main', tables: ['users'] })
    expect(result.engine).toBe('sqlite')
    expect(result.truncated).toBe(true)
    expect(result.tables[0]?.truncated).toBe(true)
    expect(result.warnings.join('\n')).toContain('截断')
    expect(Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8')).toBeLessThanOrEqual(32_768)
  })

  test('Given PostgreSQL 变更上下文 When 使用 canonical 表身份或别名 Then 只允许 schema 限定目标', async () => {
    const state = fixture()
    state.facade.checkDatabaseTables = ({ tables }) => {
      if (tables.includes('orders')) throw new Error('SERVER_OPS_AGENT_SCOPE_REQUIRED')
      return { engine: 'postgresql', revision: 1 }
    }
    const table = '"sales"."orders"'
    const result = await prepareServerOpsDatabaseChangeContext(state.facade, { sourceId: 'db-1', database: 'appdb', tables: [table] })
    expect(result).toMatchObject({ engine: 'postgresql', tables: [{ name: table }] })
    await expect(prepareServerOpsDatabaseChangeContext(state.facade, { sourceId: 'db-1', database: 'appdb', tables: ['orders'] }))
      .rejects.toThrow()
  })

})
