import * as React from 'react'
import { atom, useAtom } from 'jotai'
import type { ServerOpsDataSource, ServerOpsDatabaseAgentExclusion } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { ServerOpsAgentTableExclusions } from './ServerOpsAgentTablePicker'
import type { ServerOpsAgentCatalogApi } from './server-ops-agent-catalog-controller'
import { createServerOpsQueryableScope } from './server-ops-agent-table-scope'

/** 数据库卡片只编辑统一弹窗的禁用草稿，不自行打开弹窗或保存。 */
export interface ServerOpsDatabaseAgentPolicyProps {
  source: ServerOpsDataSource
  currentDatabase?: string
  exclusions: readonly ServerOpsDatabaseAgentExclusion[]
  disabled: boolean
  api?: ServerOpsAgentCatalogApi
  onChange: (exclusions: ServerOpsDatabaseAgentExclusion[]) => void
}

/** 优先使用工作台选库，否则使用连接配置或已有禁用项；选库只决定编辑目标。 */
export function ServerOpsDatabaseAgentPolicy({ source, currentDatabase, exclusions, disabled, api, onChange }: ServerOpsDatabaseAgentPolicyProps): React.ReactElement {
  /** 仅展示当前连接的范围，提交时保留其他连接的全部禁用规则。 */
  const scopes = exclusions.filter((entry) => entry.sourceId === source.id)
  /** 不同连接或工作台选库切换时丢弃上次弹窗内的本地选库。 */
  const targetKey = JSON.stringify([source, currentDatabase])
  const [selectedAtom] = React.useState(() => atom<{ key: string; database: string } | null>(null))
  const [selected, setSelected] = useAtom(selectedAtom)
  /** 首页没有选库时也允许展开连接目录直接选择；不因空禁用名单阻断入口。 */
  const database = (selected?.key === targetKey ? selected.database : undefined)
    ?? currentDatabase ?? (source.engine === 'sqlite' ? 'main' : source.database) ?? scopes[0]?.database
  /** 当前选库可没有禁用项，空名单表示全部业务表默认可读。 */
  const current = scopes.find((entry) => entry.database === database)
    ?? (database ? { sourceId: source.id, database, excludedTables: [] } : undefined)
  /** 其他库保持独立，不能因编辑当前库而丢失其禁用项。 */
  const others = scopes.filter((entry) => entry.database !== current?.database)
  /** 用精确连接和库替换草稿；清空只移除该库禁用项。 */
  const update = (targetDatabase: string, excludedTables: string[]): void => {
    const rest = exclusions.filter((entry) => entry.sourceId !== source.id || entry.database !== targetDatabase)
    onChange(excludedTables.length ? [...rest, { sourceId: source.id, database: targetDatabase, excludedTables }] : rest)
  }
  return <div className="min-w-0 space-y-3">
    <div className="space-y-1.5">
      <ServerOpsAgentTableExclusions key={JSON.stringify(source)} source={source}
        scope={current ? createServerOpsQueryableScope(current.database, current.excludedTables) : undefined} api={api} disabled={disabled}
        onDatabaseChange={(next) => setSelected({ key: targetKey, database: next })}
        onChange={(scope) => update(scope.database, scope.excludedTables ?? [])} />
      {database ? <p className="break-all text-[11px] text-muted-foreground">当前数据库：{database}</p> : null}
    </div>
    {others.length > 0 ? <details className="border-t border-border/40 pt-2 text-[11px]">
      <summary className="cursor-pointer text-muted-foreground">其他已禁用数据库（{others.length}）</summary>
      <div className="mt-2 space-y-3">
        {others.map((scope) => <div key={scope.database} className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="break-all text-muted-foreground">{scope.database}</span>
            <Button type="button" variant="ghost" size="sm" className="h-6 px-1 text-[10px]" disabled={disabled}
              aria-label={`清除 ${source.id}.${scope.database} 禁用表`} onClick={() => update(scope.database, [])}>清除禁用</Button>
          </div>
          <ServerOpsAgentTableExclusions key={JSON.stringify([source, scope.database])} source={source}
            scope={createServerOpsQueryableScope(scope.database, scope.excludedTables)} api={api} disabled={disabled}
            onChange={(next) => update(scope.database, next.excludedTables ?? [])} />
        </div>)}
      </div>
    </details> : null}
  </div>
}
