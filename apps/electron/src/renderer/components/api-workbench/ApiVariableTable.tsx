import * as React from 'react'
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import type { ApiField } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

/** 一个可编辑的变量作用域：工作区级或某个集合。 */
export interface ApiVariableScope {
  id: string
  label: string
}

/** 表格行：把作用域与字段摊平成一行，便于统一筛选与渲染。 */
export interface ApiVariableRow {
  scopeId: string
  scopeLabel: string
  field: ApiField
}

/**
 * 变量与密钥列表（公共配置的第一个页签）。
 *
 * 完全受控：编辑只改上层草稿，落盘由「保存」按钮触发，避免边打字边写盘。
 * 秘密值默认只显示引用与非秘密值；点 👁 才向上层要一次明文（主进程留审计）。
 */
export function ApiVariableTable({ rows, scopes, activeScope, revealed, busy, onActiveScopeChange, onRevealChange, onPatch, onAdd, onDelete }: {
  rows: ApiVariableRow[]
  scopes: ApiVariableScope[]
  /** 当前新增行落在哪个作用域；'all' 只在筛选时出现。 */
  activeScope: string
  /** fieldId → 已揭示的明文值。 */
  revealed: Record<string, string>
  busy: boolean
  onActiveScopeChange: (scopeId: string) => void
  onRevealChange: (row: ApiVariableRow, reveal: boolean) => void
  onPatch: (row: ApiVariableRow, patch: Partial<ApiField>) => void
  onAdd: (scopeId: string) => void
  onDelete: (row: ApiVariableRow) => void
}): React.ReactElement {
  const [filter, setFilter] = React.useState<string>('all')
  const [search, setSearch] = React.useState('')
  const visible = rows.filter((row) => (filter === 'all' || row.scopeId === filter) && (!search || row.field.name.includes(search)))
  /** 新增行只能落在具体作用域上；筛选为「全部」时用当前选中作用域。 */
  const addTarget = filter === 'all' ? activeScope : filter
  return (
    <div data-common-panel="variables" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="h-8 w-40 text-xs" aria-label="变量作用域筛选"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部作用域</SelectItem>
            {scopes.map((scope) => <SelectItem key={scope.id} value={scope.id}>{scope.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索变量名" className="h-8 max-w-52 text-xs" aria-label="搜索变量" />
        <Button type="button" className="ml-auto h-8 gap-1 px-2 text-xs" onClick={() => onAdd(addTarget)} disabled={busy || addTarget === 'all'}>
          <Plus className="size-3.5" />添加变量
        </Button>
      </div>
      <div className="overflow-hidden rounded-md border border-border/50">
        <div className="grid grid-cols-[1.1fr_1.3fr_auto_auto_auto] items-center gap-2 border-b border-border/50 bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
          <span>名称</span><span>值</span><span>作用域</span><span>启用</span><span className="text-right">操作</span>
        </div>
        {visible.length === 0
          ? <p className="px-2 py-3 text-xs text-muted-foreground">{search ? '没有匹配的变量。' : '还没有变量。加密方案用到的密钥变量要在这里先建好，值可以稍后再填。'}</p>
          : visible.map((row) => {
            const revealable = row.field.secret === true || row.field.secretRef !== undefined
            const plaintext = revealed[row.field.id]
            return (
              <div key={`${row.scopeId}:${row.field.id}`} data-variable-row="true" data-variable-scope={row.scopeId} className="grid grid-cols-[1.1fr_1.3fr_auto_auto_auto] items-center gap-2 border-b border-border/30 px-2 py-1.5 text-xs last:border-b-0">
                <Input value={row.field.name} onChange={(event) => onPatch(row, { name: event.target.value })} className="h-7 text-xs" aria-label="变量名" disabled={busy} />
                <div className="flex min-w-0 items-center gap-1">
                  {revealable && plaintext === undefined
                    ? <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">••••••</span>
                    : <Input value={revealable ? (plaintext ?? '') : row.field.value} onChange={(event) => onPatch(row, { value: event.target.value })} className="h-7 min-w-0 flex-1 font-mono text-xs" aria-label="变量值" disabled={busy || (revealable && plaintext === undefined)} readOnly={revealable} />}
                  {revealable && (
                    <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={plaintext === undefined ? `明文显示 ${row.field.name}` : `隐藏 ${row.field.name}`} disabled={busy} onClick={() => onRevealChange(row, plaintext === undefined)}>
                      {plaintext === undefined ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                    </Button>
                  )}
                  {plaintext !== undefined && <Badge variant="secondary" className="shrink-0 text-[10px]">明文</Badge>}
                  {revealable && plaintext === undefined && <Badge variant="outline" className="shrink-0 text-[10px]">秘密</Badge>}
                </div>
                <span className="truncate text-[11px] text-muted-foreground">{row.scopeLabel}</span>
                <Switch checked={row.field.enabled} onCheckedChange={(checked) => onPatch(row, { enabled: checked })} aria-label={`启用 ${row.field.name}`} disabled={busy} />
                <div className="text-right">
                  <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`删除 ${row.field.name}`} disabled={busy} onClick={() => onDelete(row)}><Trash2 className="size-3.5" /></Button>
                </div>
                {revealable && <label className="col-span-5 flex items-center gap-1.5 pl-1 text-[11px] text-muted-foreground"><input type="checkbox" checked={row.field.secret === true} onChange={(event) => onPatch(row, { secret: event.target.checked })} className="size-3" disabled={busy} />按秘密保存（值只存主进程加密副本，导出快照只留占位符）</label>}
              </div>
            )
          })}
      </div>
      <p className={cn('text-[11px] text-muted-foreground')}>
        取值顺序：接口覆盖 → 运行时变量 → 环境 → 集合 → 工作区。这里管理工作区与集合两级的变量；环境变量仍在环境对话框里维护。
      </p>
    </div>
  )
}
