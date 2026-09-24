import type { ServerOpsAgentDatabaseScope, ServerOpsAgentReadResource, ServerOpsDataSource } from '@proma/shared'
import { getServerOpsDatabaseReadIdentity } from '@/atoms/server-ops-database-atoms'
import type { ServerOpsDatabaseNavigation } from '@/atoms/server-ops-database-atoms'

/**
 * 复用当前 Pane 的明确选库，连接配置变化时拒绝旧导航，不猜测其他数据库。
 * @param source 当前公开连接配置。
 * @param navigation 当前 Pane、当前数据源的轻量导航。
 * @returns 可直接编辑禁用表的库名；尚未选库时返回 null。
 */
export function resolveServerOpsAgentDatabase(source: ServerOpsDataSource, navigation?: ServerOpsDatabaseNavigation): string | null {
  if (source.engine === 'sqlite') return 'main'
  if ((source.engine !== 'mysql' && source.engine !== 'postgresql') || navigation?.configurationKey !== getServerOpsDatabaseReadIdentity(source)) return null
  return navigation.database
}

/**
 * 为用户选中的数据库创建默认可查询范围，仅指定表名作为禁用例外。
 * @param database 用户从目录选择的数据库名称。
 * @param excludedTables 已明确禁用的表，默认没有禁用项。
 * @returns 允许结构、行预览及只读 SQL 的待保存草稿，不实际授予权限。
 */
export function createServerOpsQueryableScope(database: string, excludedTables: readonly string[] = []): ServerOpsAgentDatabaseScope {
  return { database, tables: null, excludedTables: [...excludedTables], readRows: true, query: true }
}

/**
 * 新编辑器只管理禁用表，默认开放所选库的只读查询；不改动现有授权事实。
 * @param resources 已保存的公开资源快照，SSH 与 Redis 仍保留原权限。
 * @param databaseTargets 用户打开弹窗时当前 Pane 的选库快照，只补入已选连接。
 * @returns 按新界面语义准备的独立副本；数据库实例跨库诊断不加入所选库权限。
 */
export function prepareServerOpsReadEditorResources(resources: readonly ServerOpsAgentReadResource[], databaseTargets: ReadonlyMap<string, string> = new Map()): ServerOpsAgentReadResource[] {
  return structuredClone(resources).map((resource) => {
    if (resource.kind !== 'mysql' && resource.kind !== 'postgresql' && resource.kind !== 'sqlite') return resource
    /** 保留全部既有禁用项，当前库置顶，其他库仍可查看与移除。 */
    const databases = resource.databases.map((scope) => createServerOpsQueryableScope(scope.database, scope.excludedTables))
    const currentDatabase = databaseTargets.get(resource.sourceId)
    if (currentDatabase) {
      const existing = databases.find((scope) => scope.database === currentDatabase)
      if (existing) databases.splice(databases.indexOf(existing), 1)
      databases.unshift(existing ?? createServerOpsQueryableScope(currentDatabase))
    }
    return { ...resource, instance: false, databases }
  })
}

/**
 * 切换禁止表选择，保留其它权限；最多 100 项；PostgreSQL 按完整大小写精确匹配。
 * @param scope 当前默认可查询的编辑草稿。
 * @param table 用户在实际目录中点击的完整表名。
 * @param engine 数据库引擎，决定标识符的大小写语义。
 * @returns 新草稿；不符合编辑器合同或新增超限时保持原范围。
 */
export function toggleServerOpsExcludedTable(scope: ServerOpsAgentDatabaseScope, table: string, engine: ServerOpsDataSource['engine'] = 'mysql'): ServerOpsAgentDatabaseScope {
  if (scope.tables !== null) return scope
  /** PostgreSQL canonical 名保留大小写，其他引擎延续已有保守匹配规则。 */
  const key = (name: string): string => engine === 'postgresql' ? name : name.toLowerCase()
  const previous = scope.excludedTables ?? []
  const matched = previous.some((name) => key(name) === key(table))
  if (!matched && previous.length >= 100) return scope
  return { ...scope, excludedTables: matched ? previous.filter((name) => key(name) !== key(table)) : [...previous, table] }
}
