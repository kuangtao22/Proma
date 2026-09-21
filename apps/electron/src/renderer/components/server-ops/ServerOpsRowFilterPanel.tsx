import * as React from 'react'
import { atom, useAtom } from 'jotai'
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import {
  MAX_SERVER_OPS_ROW_FILTERS,
  MAX_SERVER_OPS_ROW_FILTER_VALUE_LENGTH,
  isServerOpsSqlSensitiveColumn,
  parseServerOpsDataRowFilters,
} from '@proma/shared'
import type { ServerOpsDataRowFilterOperator, ServerOpsDataRowFilters, ServerOpsDataSchemaColumn } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** 一行尚未提交的条件；id 只用于稳定渲染，不进入 IPC。 */
export interface ServerOpsFilterDraftCondition {
  id: number
  column: string
  operator: ServerOpsDataRowFilterOperator
  value: string
}

/** 面板草稿；与已经应用到预览请求的筛选分开。 */
export interface ServerOpsFilterDraft {
  match: 'all' | 'any'
  conditions: ServerOpsFilterDraftCondition[]
}

/** 预定义操作符与可见文案，不允许将自由输入当成 SQL。 */
const operators: ReadonlyArray<{ value: ServerOpsDataRowFilterOperator; label: string }> = [
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'contains', label: '包含' },
  { value: 'not-contains', label: '不包含' },
  { value: 'starts-with', label: '开头是' },
  { value: 'ends-with', label: '结尾是' },
  { value: 'gt', label: '大于' },
  { value: 'gte', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'lte', label: '小于等于' },
  { value: 'is-null', label: '为 NULL' },
  { value: 'is-not-null', label: '不为 NULL' },
]

/** 判断操作符是否无需文本值；入参为受控操作符，返回是否为 NULL 判断。 */
function isNullOperator(operator: ServerOpsDataRowFilterOperator): boolean {
  return operator === 'is-null' || operator === 'is-not-null'
}

/** 将已经应用的条件复制为可编辑草稿；入参允许尚未筛选，返回独立副本。 */
export function createServerOpsFilterDraft(filters: ServerOpsDataRowFilters | null): ServerOpsFilterDraft {
  return { match: filters?.match ?? 'all', conditions: filters?.conditions.map((condition, id) => ({
    id, column: condition.column, operator: condition.operator, value: condition.value ?? '',
  })) ?? [] }
}

/** 增加默认条件；入参为当前草稿及可选字段，返回最多十二行的新草稿。 */
export function addServerOpsFilterCondition(draft: ServerOpsFilterDraft, columns: ServerOpsDataSchemaColumn[]): ServerOpsFilterDraft {
  if (draft.conditions.length >= MAX_SERVER_OPS_ROW_FILTERS) return draft
  return { ...draft, conditions: [...draft.conditions, {
    id: Math.max(-1, ...draft.conditions.map((condition) => condition.id)) + 1,
    column: columns.find((column) => !isServerOpsSqlSensitiveColumn(column.name))?.name ?? '', operator: 'eq', value: '',
  }] }
}

/** 编辑目标条件；入参为草稿、行 id 和局部修改，返回不影响其他行的新草稿。 */
export function updateServerOpsFilterCondition(draft: ServerOpsFilterDraft, id: number, patch: Partial<Omit<ServerOpsFilterDraftCondition, 'id'>>): ServerOpsFilterDraft {
  return { ...draft, conditions: draft.conditions.map((condition) => condition.id === id ? { ...condition, ...patch } : condition) }
}

/** 删除目标条件；入参为草稿及行 id，返回剩余行。 */
export function removeServerOpsFilterCondition(draft: ServerOpsFilterDraft, id: number): ServerOpsFilterDraft {
  return { ...draft, conditions: draft.conditions.filter((condition) => condition.id !== id) }
}

/** 校验草稿与当前真实字段；返回受控筛选或可读错误，空草稿仅供重置语义使用。 */
export function validateServerOpsFilterDraft(draft: ServerOpsFilterDraft, columns: ServerOpsDataSchemaColumn[]): { filters: ServerOpsDataRowFilters | null; error: string | null } {
  if (draft.conditions.length === 0) return { filters: null, error: null }
  if (draft.conditions.length > MAX_SERVER_OPS_ROW_FILTERS) return { filters: null, error: `最多添加 ${MAX_SERVER_OPS_ROW_FILTERS} 条条件` }
  for (const [index, condition] of draft.conditions.entries()) {
    if (isServerOpsSqlSensitiveColumn(condition.column)) return { filters: null, error: `第 ${index + 1} 条条件使用了敏感字段，不支持筛选` }
    if (!columns.some((column) => column.name === condition.column)) return { filters: null, error: `第 ${index + 1} 条条件的字段不在当前表中，请重新选择` }
    if (!isNullOperator(condition.operator) && condition.value.length > MAX_SERVER_OPS_ROW_FILTER_VALUE_LENGTH) return { filters: null, error: `第 ${index + 1} 条条件的值超过长度上限` }
  }
  const filters: ServerOpsDataRowFilters = { match: draft.match, conditions: draft.conditions.map(({ column, operator, value }) => ({
    column, operator, ...(isNullOperator(operator) ? {} : { value }),
  })) }
  try { return { filters: parseServerOpsDataRowFilters(filters), error: null } }
  catch { return { filters: null, error: '条件不符合筛选规则，请检查字段和操作符' } }
}

/** 操作面板仅编辑草稿；外层控制展开及真正的行读取。 */
export interface ServerOpsRowFilterPanelProps {
  open: boolean
  columns: ServerOpsDataSchemaColumn[]
  structureStatus: 'idle' | 'loading' | 'ready' | 'error'
  structureError: string | null
  appliedFilters: ServerOpsDataRowFilters | null
  busy: boolean
  onApply: (filters: ServerOpsDataRowFilters | null) => void
  onRetryFields: () => void
}

/** 通过语义内容识别外层更换筛选，避免重复 render 覆盖尚未应用的输入。 */
function filterSignature(filters: ServerOpsDataRowFilters | null): string {
  return JSON.stringify(filters)
}

/** 表格上方的有界条件面板；展开、重试与查询生命周期分别由外层管理。 */
export function ServerOpsRowFilterPanel({ open, columns, structureStatus, structureError, appliedFilters, busy, onApply, onRetryFields }: ServerOpsRowFilterPanelProps): React.ReactElement | null {
  /** 本面板按父层 key 隔离数据源/库/表，Jotai 保留折叠时未提交的草稿。 */
  const [draftAtom] = React.useState(() => atom(createServerOpsFilterDraft(appliedFilters)))
  const [draft, setDraft] = useAtom(draftAtom)
  /** 只在外层实际替换已应用筛选时同步草稿。 */
  const appliedSignature = React.useMemo(() => filterSignature(appliedFilters), [appliedFilters])
  React.useEffect(() => { setDraft(createServerOpsFilterDraft(appliedFilters)) }, [appliedSignature, setDraft])
  /** 提交能力须同时满足字段可用、至少一条条件和受控参数校验。 */
  const selectableColumns = React.useMemo(() => columns.filter((column) => !isServerOpsSqlSensitiveColumn(column.name)), [columns])
  /** 草稿或字段实际变化时才重新校验，父层加载状态不触发条件解析。 */
  const validation = React.useMemo(() => validateServerOpsFilterDraft(draft, columns), [draft, columns])
  const canApply = structureStatus === 'ready' && selectableColumns.length > 0 && draft.conditions.length > 0 && validation.error === null
  /** 与当前请求比较只用于展示未应用状态，不改变已经查询的行。 */
  const pendingSignature = React.useMemo(() => filterSignature(validation.filters), [validation.filters])
  const pending = pendingSignature !== appliedSignature || validation.error !== null
  /** 点击应用或在值框回车后，仅提交已校验的条件。 */
  const apply = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (canApply && validation.filters) onApply(validation.filters)
  }
  /** 重置同时清除未提交草稿及已经应用的筛选。 */
  const reset = (): void => { setDraft(createServerOpsFilterDraft(null)); onApply(null) }

  if (!open) return null
  return <form className="shrink-0 border-b border-border/40 bg-content-area px-3 py-2.5" data-server-ops-row-filter-panel onSubmit={apply}>
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">行筛选</span>
        <span className="text-muted-foreground">符合</span>
        <div className="inline-flex h-7 items-center rounded-md border border-border/60 bg-muted/40 p-0.5" role="group" aria-label="条件组合方式">
          {(['all', 'any'] as const).map((match) => <button key={match} type="button" aria-pressed={draft.match === match} onClick={() => setDraft((previous) => ({ ...previous, match }))} className={`h-6 rounded px-2 text-xs transition-colors ${draft.match === match ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{match === 'all' ? '全部条件' : '任一条件'}</button>)}
        </div>
        <span className="text-muted-foreground">{pending ? '待应用' : appliedFilters ? `已应用 ${appliedFilters.conditions.length} 条` : '未筛选'}</span>
        {busy ? <span role="status" className="text-muted-foreground">正在读取结果…</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2" disabled={structureStatus !== 'ready' || selectableColumns.length === 0 || draft.conditions.length >= MAX_SERVER_OPS_ROW_FILTERS} onClick={() => setDraft((previous) => addServerOpsFilterCondition(previous, selectableColumns))}><Plus className="size-3.5" />添加条件</Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2" disabled={draft.conditions.length === 0 && !appliedFilters} onClick={reset}><RotateCcw className="size-3.5" />重置筛选</Button>
        <Button type="submit" size="sm" className="h-7 px-3" disabled={!canApply}>应用</Button>
      </div>
    </div>
    {structureStatus === 'error' ? <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive">{structureError ?? '字段读取失败'}<Button type="button" size="sm" variant="outline" className="h-7" onClick={onRetryFields}>重试读取字段</Button></div>
      : structureStatus === 'loading' || structureStatus === 'idle' ? <p role="status" className="mt-2 text-xs text-muted-foreground">正在读取字段…</p>
        : selectableColumns.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">当前表没有可用字段</p> : null}
    {draft.conditions.length > 0 ? <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto pr-1" aria-label="筛选条件">
      {draft.conditions.map((condition, index) => <div key={condition.id} className="flex min-w-0 flex-wrap items-center gap-1.5" data-server-ops-filter-condition>
        <span className="w-5 shrink-0 text-center text-[11px] text-muted-foreground">{index + 1}</span>
        <Select value={condition.column} onValueChange={(column) => setDraft((previous) => updateServerOpsFilterCondition(previous, condition.id, { column }))}>
          <SelectTrigger className="h-8 min-w-[9rem] max-w-60 flex-[1_1_10rem] px-2 text-xs" aria-label={`第 ${index + 1} 条条件的字段`} disabled={structureStatus !== 'ready' || selectableColumns.length === 0}><span className="min-w-0 truncate text-left"><SelectValue placeholder="选择字段" /></span></SelectTrigger>
          <SelectContent className="z-[240] max-h-64">{selectableColumns.map((column) => <SelectItem key={column.name} value={column.name} title={[column.type, column.comment].filter(Boolean).join(' · ')}><span className="flex max-w-72 items-center gap-2"><span className="truncate">{column.name}</span><span className="truncate text-xs text-muted-foreground">{column.type}{column.comment ? ` · ${column.comment}` : ''}</span></span></SelectItem>)}</SelectContent>
        </Select>
        <Select value={condition.operator} onValueChange={(operator: ServerOpsDataRowFilterOperator) => setDraft((previous) => updateServerOpsFilterCondition(previous, condition.id, { operator }))}>
          <SelectTrigger className="h-8 w-28 shrink-0 px-2 text-xs" aria-label={`第 ${index + 1} 条条件的操作符`}><SelectValue /></SelectTrigger>
          <SelectContent className="z-[240] max-h-64">{operators.map((operator) => <SelectItem key={operator.value} value={operator.value}>{operator.label}</SelectItem>)}</SelectContent>
        </Select>
        {isNullOperator(condition.operator) ? <span className="flex h-8 min-w-[8rem] flex-[1_1_10rem] items-center px-2 text-xs text-muted-foreground">无需输入值</span>
          : <Input className="h-8 min-w-[8rem] flex-[1_1_10rem] text-xs" aria-label={`第 ${index + 1} 条条件的值`} placeholder="输入值（可为空）" value={condition.value} maxLength={MAX_SERVER_OPS_ROW_FILTER_VALUE_LENGTH + 1} onChange={(event) => setDraft((previous) => updateServerOpsFilterCondition(previous, condition.id, { value: event.target.value }))} />}
        <Button type="button" size="icon-sm" variant="ghost" className="size-8 shrink-0 text-muted-foreground" aria-label={`删除第 ${index + 1} 条条件`} title="删除条件" onClick={() => setDraft((previous) => removeServerOpsFilterCondition(previous, condition.id))}><Trash2 className="size-3.5" /></Button>
      </div>)}
    </div> : structureStatus === 'ready' && selectableColumns.length > 0 ? <p className="mt-2 text-xs text-muted-foreground">添加条件后筛选当前表的数据</p> : null}
    {validation.error && structureStatus === 'ready' ? <p role="alert" className="mt-2 text-xs text-destructive">{validation.error}</p> : null}
  </form>
}
