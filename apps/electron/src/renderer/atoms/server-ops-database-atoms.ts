import { atom } from 'jotai'
import type { ServerOpsSchemaNavigation } from '@/components/server-ops/server-ops-schema-controller'
import type { ServerOpsDiagnosticPage } from '@/components/server-ops/server-ops-diagnostics-controller'

/** 工作台先按对象范围分区，不与 SSH 能力页签共享状态。 */
export type ServerOpsDatabaseSection = 'instance' | 'database'
/** 实例页面无需先选择数据库。 */
export type ServerOpsInstancePage = Exclude<ServerOpsDiagnosticPage, 'logs'>
/** 库内页面共享同一选库，不包含实例概览、参数和原始日志。 */
export type ServerOpsDatabasePage = 'browse' | 'query' | 'sessions' | 'statements'

/** 本会话只保存轻量导航；业务行和密码不进入全局或磁盘。 */
export interface ServerOpsDatabaseNavigation extends ServerOpsSchemaNavigation {
  configurationKey: string
  section: ServerOpsDatabaseSection
  instancePage: ServerOpsInstancePage
  databasePage: ServerOpsDatabasePage
  directoryWidth: number
}

/** 最近访问的连接导航，键包含会话、Pane 和数据源 ID。 */
export const serverOpsDatabaseNavigationAtom = atom(new Map<string, ServerOpsDatabaseNavigation>())

/** 初次进入默认数据浏览，等待库目录验证配置库。 */
export function createServerOpsDatabaseNavigation(configurationKey: string): ServerOpsDatabaseNavigation {
  return { configurationKey, section: 'database', instancePage: 'overview', databasePage: 'browse', directoryWidth: 190, database: null, table: null, detailTab: 'data', offset: 0 }
}

/** 有界更新最近访问状态，最多记住 32 个目标，不持有查询结果。 */
export const updateServerOpsDatabaseNavigationAtom = atom(null, (get, set, input: { key: string; navigation: ServerOpsDatabaseNavigation }): void => {
  /** 不同 Pane 导航分别存储，移到末尾作为最近访问目标。 */
  const next = new Map(get(serverOpsDatabaseNavigationAtom))
  next.delete(input.key)
  next.set(input.key, input.navigation)
  while (next.size > 32) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  set(serverOpsDatabaseNavigationAtom, next)
})
