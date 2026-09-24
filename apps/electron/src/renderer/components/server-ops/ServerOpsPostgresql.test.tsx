import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import {
  applyServerOpsDataSourceEngineChange,
  buildServerOpsDataSourceProbeDraft,
  buildServerOpsDataSourceUpsertInput,
  createServerOpsDataSourceDraft,
  getServerOpsDataConnectionModeEngines,
  validateServerOpsDataSourceDraft,
} from './ServerOpsDataSourceDialog'
import { createServerOpsSqlCompletionSource } from './server-ops-sql-completion'
import type { ServerOpsSqlCompletionSchema } from './server-ops-sql-completion'
import { createServerOpsQueryableScope, toggleServerOpsExcludedTable } from './server-ops-agent-table-scope'

describe('PostgreSQL 运维表单与补全', () => {
  test('Given 大小写不同的 PostgreSQL 表 When 勾选第二张表 Then 不撤销第一张表的禁用', () => {
    /** PostgreSQL 双引号保留大小写，两个名称属于不同策略目标。 */
    const scope = createServerOpsQueryableScope('business', ['"public"."Users"'])
    expect(toggleServerOpsExcludedTable(scope, '"public"."users"', 'postgresql').excludedTables)
      .toEqual(['"public"."Users"', '"public"."users"'])
  })
  test('Given 直连或 SSH When 添加 PostgreSQL Then 使用 5432 且保留实际连接数据库', () => {
    for (const mode of ['direct', 'ssh'] as const) expect(getServerOpsDataConnectionModeEngines(mode)).toContain('postgresql')
    /** 首次建连需要一个真实 PostgreSQL 数据库，后续可在工作台切换。 */
    const draft = { ...createServerOpsDataSourceDraft(null, 'postgresql'), label: '业务库', database: 'business' }
    expect(draft).toMatchObject({ port: '5432', tlsMode: 'required' })
    expect(validateServerOpsDataSourceDraft(draft)).toEqual({})
    expect(buildServerOpsDataSourceProbeDraft({ hostId: '', source: null, draft })).toMatchObject({ engine: 'postgresql', database: 'business', port: 5432 })
    expect(buildServerOpsDataSourceUpsertInput({ hostId: '', source: null, draft })).toMatchObject({ engine: 'postgresql', database: 'business' })
    /** 首次连接库允许留空，由运行时使用 postgres，不阻碍普通用户保存和测试。 */
    const automaticDraft = { ...draft, database: '' }
    expect(validateServerOpsDataSourceDraft(automaticDraft)).toEqual({})
    expect(buildServerOpsDataSourceProbeDraft({ hostId: '', source: null, draft: automaticDraft })?.database).toBeUndefined()
    expect(buildServerOpsDataSourceUpsertInput({ hostId: '', source: null, draft: automaticDraft }).database).toBeUndefined()
  })

  test('Given MySQL preferred When 切换 PostgreSQL Then 转为必须 TLS 且带入默认库', () => {
    /** 切换协议不会把不支持的 TLS 协商模式带给 PostgreSQL。 */
    const draft = applyServerOpsDataSourceEngineChange(createServerOpsDataSourceDraft(null), 'postgresql')
    expect(draft).toMatchObject({ database: 'postgres', port: '5432', tlsMode: 'required' })
    expect(validateServerOpsDataSourceDraft({ ...draft, tlsMode: 'preferred' }).tlsMode).toContain('PostgreSQL')
  })

  test('Given PostgreSQL 通过 IP 连接 When 校验证书 Then 提前提示填写证书 DNS 名称', () => {
    /** 地址与证书身份分离，避免保存主进程必然拒绝的校验配置。 */
    const draft = { ...createServerOpsDataSourceDraft(null, 'postgresql'), label: '业务库', tlsMode: 'verify' as const }
    expect(validateServerOpsDataSourceDraft(draft).tlsServerName).toContain('DNS')
    expect(validateServerOpsDataSourceDraft({ ...draft, tlsServerName: 'db.example.com' })).toEqual({})
  })

  test('Given 同名 schema 表和大小写列 When 补全别名字段 Then 使用正确表身份与双引号', async () => {
    /** 元数据保留规范表身份，以免 public 与 archive 的同名表串用字段。 */
    const schema: ServerOpsSqlCompletionSchema = {
      contextKey: 'pg/business/v1', database: 'business',
      tables: [{ name: '"public"."users"' }, { name: '"archive"."users"' }],
      columns: { '"public"."users"': [{ name: 'UserName', type: 'text', nullable: true, primaryKey: false }], '"archive"."users"': [{ name: 'archived', type: 'bool', nullable: false, primaryKey: false }] },
    }
    /** 真实 PostgreSQL CodeMirror 语法树，光标位于 u. 后。 */
    const state = EditorState.create({ doc: 'SELECT u. FROM public.users u', extensions: [sql({ dialect: PostgreSQL })] })
    /** 收集按需读取的真实身份，确保未扫描整个数据库。 */
    const requested: string[][] = []
    const completion = createServerOpsSqlCompletionSource({ dialect: 'postgresql', getSchema: () => schema, ensureColumns: async (tables) => { requested.push(tables) } })
    const result = await completion(new CompletionContext(state, 9, true))
    expect(requested).toEqual([['"public"."users"']])
    expect(result?.options.map((entry) => entry.label)).toEqual(['UserName'])
    expect(result?.options[0]?.apply).toBe('"UserName"')
    /** 表位置直接插入两个独立标识符，不能把限定名整体引用。 */
    const tableState = EditorState.create({ doc: 'SELECT * FROM ', extensions: [sql({ dialect: PostgreSQL })] })
    const tables = await completion(new CompletionContext(tableState, tableState.doc.length, true))
    expect(tables?.options.find((entry) => entry.label === '"archive"."users"')?.apply).toBe('"archive"."users"')
  })
})
