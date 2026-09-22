import { describe, expect, test } from 'bun:test'
import type { ServerOpsAgentDatabaseScope, ServerOpsDataSource } from '@proma/shared'
import { createServerOpsDatabaseNavigation, getServerOpsDatabaseReadIdentity } from '@/atoms/server-ops-database-atoms'
import { createServerOpsQueryableScope, prepareServerOpsReadEditorResources, resolveServerOpsAgentDatabase, toggleServerOpsExcludedTable } from './server-ops-agent-table-scope'

describe('Agent 禁止表选择', () => {
  test('Given 当前 Pane 已选库 When 打开禁用表入口 Then 复用同配置目标且拒绝过期或其他连接导航', () => {
    /** 合成连接不包含密码，不访问真实服务。 */
    const source: ServerOpsDataSource = { id: 'db', engine: 'mysql', transport: 'direct', address: 'example.test', port: 3306, label: '业务库', tlsMode: 'verify', hasPassword: false, createdAt: 1, updatedAt: 1 }
    /** 仅配置身份匹配的导航可作为当前选库。 */
    const navigation = { ...createServerOpsDatabaseNavigation(getServerOpsDatabaseReadIdentity(source)), database: 'app' }
    expect(resolveServerOpsAgentDatabase(source, navigation)).toBe('app')
    expect(resolveServerOpsAgentDatabase({ ...source, updatedAt: 2 }, navigation)).toBeNull()
    expect(resolveServerOpsAgentDatabase({ ...source, id: 'other' }, navigation)).toBeNull()
    expect(resolveServerOpsAgentDatabase(source, undefined)).toBeNull()
    expect(resolveServerOpsAgentDatabase({ ...source, engine: 'sqlite' }, undefined)).toBe('main')
  })

  test('Given 已授权其他库且工作台当前库不同 When 打开草稿 Then 当前库直接可选禁用表并保留原库禁用项', () => {
    /** 当前库只补入已选连接，未选连接不能因浏览过而自动加入。 */
    const resources = [{ kind: 'mysql' as const, sourceId: 'db', instance: false, databases: [createServerOpsQueryableScope('audit', ['private'])] }]
    /** 目录之外的连接即便有浏览记录，也没有默认授权。 */
    const targets = new Map([['db', 'app'], ['unselected', 'another']])
    expect(prepareServerOpsReadEditorResources(resources, targets)).toEqual([{ ...resources[0]!, databases: [createServerOpsQueryableScope('app'), createServerOpsQueryableScope('audit', ['private'])] }])
    expect(resources[0]!.databases).toEqual([createServerOpsQueryableScope('audit', ['private'])])
    expect(prepareServerOpsReadEditorResources(resources, new Map([['db', 'audit']]))[0]).toEqual(resources[0])
  })

  test('Given 屏蔽模式 When 多选并取消 Then 保留其它选择且大小写不能重复', () => {
    /** 新授权默认可查询全部表，点选只改变禁用集合。 */
    const initial = createServerOpsQueryableScope('app')
    /** 连续点击模拟真实多选。 */
    const selected = toggleServerOpsExcludedTable(toggleServerOpsExcludedTable(initial, 'users'), 'audit')
    expect(selected).toEqual({ ...initial, excludedTables: ['users', 'audit'] })
    expect(toggleServerOpsExcludedTable(selected, 'USERS').excludedTables).toEqual(['audit'])
    expect(initial.excludedTables).toEqual([])
  })

  test('Given 新选数据库 When 创建草稿 Then 默认全部表可只读查询且无需其它开关', () => {
    expect(createServerOpsQueryableScope('app')).toEqual({ database: 'app', tables: null, excludedTables: [], readRows: true, query: true })
    expect(createServerOpsQueryableScope('main', ['private'])).toEqual({ database: 'main', tables: null, excludedTables: ['private'], readRows: true, query: true })
  })

  test('Given 旧白名单或旧结构授权 When 构建编辑草稿 Then 默认可查并保留明确禁用项且不修改原快照', () => {
    /** 默认可查询只作用于待保存草稿；现有授权对象保持不变。 */
    const resources = [{ kind: 'mysql' as const, sourceId: 'db', instance: true, databases: [{ database: 'app', tables: ['users'], readRows: false }, { database: 'audit', tables: null, excludedTables: ['private'], readRows: false }] }, { kind: 'ssh' as const, hostId: 'h', readLogs: false }]
    const edited = prepareServerOpsReadEditorResources(resources)
    expect(edited).toEqual([{ kind: 'mysql', sourceId: 'db', instance: false, databases: [createServerOpsQueryableScope('app'), createServerOpsQueryableScope('audit', ['private'])] }, { kind: 'ssh', hostId: 'h', readLogs: false }])
    expect(resources[0]).toMatchObject({ instance: true, databases: [{ tables: ['users'], readRows: false }, { excludedTables: ['private'], readRows: false }] })
  })

  test('Given 100 项限制 When 新选超限 Then 不丢失已有保护', () => {
    /** 合同容量达到上限时仍可取消已有选择。 */
    const full: ServerOpsAgentDatabaseScope = { database: 'app', tables: null, excludedTables: Array.from({ length: 100 }, (_, index) => `table_${index}`), readRows: false }
    expect(toggleServerOpsExcludedTable(full, 'extra')).toEqual(full)
    expect(toggleServerOpsExcludedTable(full, 'table_0').excludedTables).toHaveLength(99)
  })
})
