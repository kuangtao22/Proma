import * as React from 'react'
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react'
import type { ApiCatalog, ApiCryptoProfile, ApiCryptoReferences, ApiCryptoStep, ApiField } from '@proma/shared'
import { API_CRYPTO_ALGOS } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { ApiVariableTable } from './ApiVariableTable'
import type { ApiVariableRow, ApiVariableScope } from './ApiVariableTable'

/** 工作区级变量的伪作用域 id：只在本面板与会话之间传递，不落盘。 */
export const API_WORKSPACE_VARIABLE_SCOPE = '__workspace__'
const WORKSPACE_SCOPE = API_WORKSPACE_VARIABLE_SCOPE

/** 面板对外的写入能力；由会话组件接到 IPC，面板本身不直接调 api。 */
export interface ApiCryptoConfigOps {
  /** 保存工作区级变量。 */
  saveVariables: (variables: ApiField[]) => Promise<boolean>
  /** 保存某个集合的变量。 */
  saveCollectionVariables: (collectionId: string, variables: ApiField[]) => Promise<boolean>
  /** 新建或更新方案；返回落盘后的方案（含新 revision），失败返回 null。 */
  saveProfile: (profile: ApiCryptoProfile, expectedRevision: number | null) => Promise<ApiCryptoProfile | null>
  /** 删除方案；被引用且未 force 时返回 false。 */
  deleteProfile: (id: string, force: boolean) => Promise<boolean>
  /** 引用检查：删除确认与影响面提示共用。 */
  inspect: (kind: 'variable' | 'profile', name: string) => Promise<ApiCryptoReferences | null>
  /** 明文揭示一个字段（一次一个，主进程留审计）。 */
  reveal: (scopeId: string, field: ApiField) => Promise<string | null>
}

/** 步骤工厂：新建步骤给一组能直接跑的默认值，用户再改。 */
function createCryptoStep(kind: ApiCryptoStep['kind'], id: string): ApiCryptoStep {
  if (kind === 'derive') return { id, kind, enabled: true, algo: 'timestamp-nonce', target: { in: 'header', name: 'X-Timestamp' } }
  if (kind === 'decrypt') return { id, kind, enabled: true, algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'response-body', onFailure: 'stop' }
  if (kind === 'encrypt') return { id, kind, enabled: true, algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'body', target: { in: 'body', name: 'body' } }
  return { id, kind, enabled: true, algo: 'HMAC-SHA256', keyRef: 'appSecret', encoding: 'hex', target: { in: 'header', name: 'X-Sign' }, template: '{{method}}\n{{path}}\n{{timestamp}}\n{{body.sha256}}' }
}

/** 用当前变量草稿（含所选环境）算出方案还缺哪些密钥。 */
function missingSecrets(profile: ApiCryptoProfile, fields: readonly ApiField[]): string[] {
  const configured = new Set(fields.filter((field) => field.enabled && field.name && (field.value !== '' || field.secretRef !== undefined)).map((field) => field.name))
  const refs = [...profile.requestSteps, ...profile.responseSteps].flatMap((step) => [step.keyRef, step.ivRef]).filter((name): name is string => name !== undefined)
  return [...new Set(refs.filter((name) => !configured.has(name)))]
}

/** 公共配置面板：变量与密钥、签名与加密方案两个列表。 */
export function ApiCryptoConfigPanel({ open, tab, catalog, environmentId, environmentLabel, busy, ops, onTabChange, onOpenChange }: {
  open: boolean
  tab: 'variables' | 'schemes'
  catalog: ApiCatalog
  environmentId: string | null
  environmentLabel: string
  busy: boolean
  ops: ApiCryptoConfigOps
  onTabChange: (tab: 'variables' | 'schemes') => void
  onOpenChange: (open: boolean) => void
}): React.ReactElement {
  /** 本地草稿：保存成功前不写盘，取消就整批丢弃。 */
  const [variables, setVariables] = React.useState<Record<string, ApiField[]>>({})
  const [profiles, setProfiles] = React.useState<ApiCryptoProfile[]>([])
  /** 载入时的方案 revision：保存时做乐观并发校验。 */
  const [baseline, setBaseline] = React.useState<Record<string, number>>({})
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [revealed, setRevealed] = React.useState<Record<string, string>>({})
  const [activeScope, setActiveScope] = React.useState<string>(WORKSPACE_SCOPE)
  const [dirtyScopes, setDirtyScopes] = React.useState<Set<string>>(new Set())
  const [message, setMessage] = React.useState<string | null>(null)
  /** 当前方案被多少条请求引用：保存前的「影响面」提示。 */
  const [references, setReferences] = React.useState<ApiCryptoReferences | null>(null)

  /** 每次打开都从目录重建草稿，避免残留上一次的未保存改动。 */
  React.useEffect(() => {
    if (!open) return
    setVariables({
      [WORKSPACE_SCOPE]: (catalog.workspaceVariables ?? []).map((field) => ({ ...field })),
      ...Object.fromEntries(catalog.collections.map((collection) => [collection.id, collection.variables.map((field) => ({ ...field }))])),
    })
    setProfiles((catalog.cryptoProfiles ?? []).map((profile) => ({ ...profile })))
    setBaseline(Object.fromEntries((catalog.cryptoProfiles ?? []).map((profile) => [profile.id, profile.revision])))
    setSelectedId((previous) => (catalog.cryptoProfiles ?? []).some((item) => item.id === previous) ? previous : (catalog.cryptoProfiles?.[0]?.id ?? null))
    setRevealed({})
    setDirtyScopes(new Set())
  }, [open, catalog])

  /** 关闭时清掉明文与提示：明文显示不留到下一次打开。 */
  React.useEffect(() => {
    if (open) return
    setMessage(null)
    setRevealed({})
  }, [open])

  const scopes: ApiVariableScope[] = [
    { id: WORKSPACE_SCOPE, label: '工作区（跨集合共用）' },
    ...catalog.collections.map((collection) => ({ id: collection.id, label: `集合：${collection.name}` })),
  ]
  const rows: ApiVariableRow[] = Object.entries(variables).flatMap(([scopeId, fields]) => fields.map((field) => ({
    scopeId, scopeLabel: scopes.find((scope) => scope.id === scopeId)?.label ?? scopeId, field,
  })))
  const selected = profiles.find((profile) => profile.id === selectedId) ?? null
  /** 方案检查与保存都用同一份变量视图：所选环境的变量也要算进来。 */
  const environmentFields = environmentId ? (catalog.environments.find((item) => item.id === environmentId)?.variables ?? []) : []
  const allFields = [...Object.values(variables).flat(), ...environmentFields]
  const missing = selected ? missingSecrets(selected, allFields) : []

  /** 载入选中方案的引用面。 */
  React.useEffect(() => {
    if (!open || !selectedId) { setReferences(null); return }
    let cancelled = false
    void ops.inspect('profile', selectedId).then((result) => { if (!cancelled) setReferences(result) })
    return () => { cancelled = true }
  }, [open, selectedId, ops])

  const patchRow = (row: ApiVariableRow, patch: Partial<ApiField>): void => {
    setVariables((previous) => ({
      ...previous,
      [row.scopeId]: (previous[row.scopeId] ?? []).map((field) => (field.id === row.field.id ? { ...field, ...patch } : field)),
    }))
    setDirtyScopes((previous) => new Set(previous).add(row.scopeId))
  }

  const addRow = (scopeId: string): void => {
    if (scopeId === 'all') return
    const id = `var_${Math.random().toString(36).slice(2, 10)}`
    setVariables((previous) => ({ ...previous, [scopeId]: [...(previous[scopeId] ?? []), { id, name: 'newVariable', value: '', enabled: true }] }))
    setDirtyScopes((previous) => new Set(previous).add(scopeId))
  }

  const deleteRow = async (row: ApiVariableRow): Promise<void> => {
    const refs = await ops.inspect('variable', row.field.name)
    if (refs && (refs.profiles.length > 0 || refs.requests > 0)) {
      const detail = `${refs.profiles.join('、') || '若干方案'} · 影响 ${refs.requests} 个接口`
      if (!window.confirm(`变量「${row.field.name}」正被引用（${detail}）。仍然删除？`)) return
    }
    setVariables((previous) => ({ ...previous, [row.scopeId]: (previous[row.scopeId] ?? []).filter((field) => field.id !== row.field.id) }))
    setDirtyScopes((previous) => new Set(previous).add(row.scopeId))
  }

  const revealRow = async (row: ApiVariableRow, reveal: boolean): Promise<void> => {
    if (!reveal) {
      setRevealed((previous) => { const next = { ...previous }; delete next[row.field.id]; return next })
      return
    }
    const value = await ops.reveal(row.scopeId, row.field)
    if (value === null) { setMessage('读取明文失败：该字段可能尚未填写'); return }
    setRevealed((previous) => ({ ...previous, [row.field.id]: value }))
    setMessage(`已明文显示「${row.field.name}」：此操作已记入主进程日志`)
  }

  const saveScope = async (scopeId: string): Promise<void> => {
    const fields = variables[scopeId] ?? []
    const ok = scopeId === WORKSPACE_SCOPE ? await ops.saveVariables(fields) : await ops.saveCollectionVariables(scopeId, fields)
    if (!ok) { setMessage('保存变量失败，请查看顶部错误提示'); return }
    setDirtyScopes((previous) => { const next = new Set(previous); next.delete(scopeId); return next })
    setMessage('变量已保存：秘密值只写主进程加密副本，导出快照只留占位符')
  }

  const patchSelected = (patch: Partial<ApiCryptoProfile>): void => {
    if (!selected) return
    setProfiles((previous) => previous.map((profile) => profile.id === selected.id ? { ...profile, ...patch } : profile))
  }

  const patchStep = (side: 'requestSteps' | 'responseSteps', index: number, patch: Partial<ApiCryptoStep>): void => {
    if (!selected) return
    patchSelected({ [side]: selected[side].map((step, current) => current === index ? { ...step, ...patch } : step) } as Partial<ApiCryptoProfile>)
  }

  const moveStep = (side: 'requestSteps' | 'responseSteps', index: number, delta: number): void => {
    if (!selected) return
    const list = [...selected[side]]
    const target = index + delta
    if (target < 0 || target >= list.length) return
    const [moved] = list.splice(index, 1)
    list.splice(target, 0, moved as ApiCryptoStep)
    patchSelected({ [side]: list } as Partial<ApiCryptoProfile>)
  }

  const saveSelected = async (): Promise<void> => {
    if (!selected) return
    if (references && references.requests > 0) {
      if (!window.confirm(`这套方案正被 ${references.requests} 个接口使用（${references.collections.join('、')}）。保存后它们立刻按新方案执行，确认保存？`)) return
    }
    const saved = await ops.saveProfile(selected, baseline[selected.id] ?? null)
    if (!saved) { setMessage('保存方案失败：可能已被其它窗口修改，请关闭后重新打开'); return }
    setProfiles((previous) => previous.map((profile) => profile.id === saved.id ? saved : profile))
    setBaseline((previous) => ({ ...previous, [saved.id]: saved.revision }))
    setMessage(`已保存方案「${saved.name}」revision ${saved.revision}`)
  }

  const addProfile = (): void => {
    const id = `profile_${Math.random().toString(36).slice(2, 10)}`
    const profile: ApiCryptoProfile = {
      id, name: '新方案', description: '', scope: 'workspace', appliesTo: 'all', requestSteps: [], responseSteps: [], revision: 0, updatedAt: 0,
    }
    setProfiles((previous) => [...previous, profile])
    setSelectedId(id)
    setMessage('新方案还没有步骤：加上「派生时间戳」「签名」等步骤后再保存')
  }

  const duplicateProfile = (): void => {
    if (!selected) return
    const id = `profile_${Math.random().toString(36).slice(2, 10)}`
    setProfiles((previous) => [...previous, { ...selected, id, name: `${selected.name} 副本`, revision: 0 }])
    setSelectedId(id)
  }

  const deleteSelected = async (): Promise<void> => {
    if (!selected) return
    const refs = await ops.inspect('profile', selected.id)
    const force = Boolean(refs && refs.requests > 0)
    if (force && !window.confirm(`方案「${selected.name}」正被 ${refs?.requests} 个接口引用。删除后这些接口会留下悬空引用并拒绝发送，确认删除？`)) return
    if (!(await ops.deleteProfile(selected.id, force))) { setMessage('删除方案失败，请刷新后重试'); return }
    setProfiles((previous) => previous.filter((profile) => profile.id !== selected.id))
    setSelectedId(null)
    setMessage('已删除方案')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>公共配置</DialogTitle>
          <DialogDescription>签名/加密方案在这里统一维护，接口只选择用哪一套；密钥值只存主进程加密副本，不进运行记录、不进日志、导出快照只留占位符。</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 border-b border-border/50">
          {([['variables', '变量与密钥'], ['schemes', '签名与加密方案']] as const).map(([id, label]) => (
            <button key={id} type="button" data-common-tab={id} className={cn('h-8 border-b-2 px-2 text-xs', tab === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')} onClick={() => onTabChange(id)}>{label}</button>
          ))}
          <span className="ml-auto self-center text-[11px] text-muted-foreground">当前环境：{environmentLabel}</span>
        </div>
        {message && <p className="rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground" data-crypto-message="true">{message}</p>}
        {tab === 'variables'
          ? (
            <div className="space-y-2">
              <ApiVariableTable
                rows={rows}
                scopes={scopes}
                activeScope={activeScope}
                revealed={revealed}
                busy={busy}
                onActiveScopeChange={setActiveScope}
                onRevealChange={(row, reveal) => void revealRow(row, reveal)}
                onPatch={patchRow}
                onAdd={addRow}
                onDelete={(row) => void deleteRow(row)}
              />
              {[...dirtyScopes].length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">有未保存的变量改动</span>
                  {[...dirtyScopes].map((scopeId) => (
                    <Button key={scopeId} type="button" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void saveScope(scopeId)}>
                      保存{scopes.find((scope) => scope.id === scopeId)?.label ?? scopeId}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )
          : (
            <div data-common-panel="schemes" className="grid min-h-[420px] grid-cols-[220px_1fr] gap-3">
              <div className="space-y-1 border-r border-border/50 pr-3">
                <div className="flex items-center gap-1">
                  <Button type="button" className="h-7 flex-1 gap-1 px-2 text-xs" onClick={addProfile}><Plus className="size-3.5" />新建方案</Button>
                  <Button type="button" variant="outline" size="icon" className="size-7" aria-label="复制方案" disabled={!selected} onClick={duplicateProfile}><Copy className="size-3.5" /></Button>
                </div>
                {profiles.length === 0 && <p className="pt-2 text-[11px] text-muted-foreground">还没有方案。新建一个，或让 Agent 按接口文档帮你配好。</p>}
                {profiles.map((profile) => (
                  <button key={profile.id} type="button" data-crypto-profile={profile.id} className={cn('w-full rounded-md px-2 py-1.5 text-left text-xs', profile.id === selectedId ? 'bg-muted/60 text-foreground' : 'text-muted-foreground hover:bg-muted/40')} onClick={() => setSelectedId(profile.id)}>
                    <span className="block truncate">{profile.name}</span>
                    <span className="mt-0.5 block text-[10px]">revision {profile.revision || '未保存'} · {profile.requestSteps.length + profile.responseSteps.length} 步</span>
                  </button>
                ))}
              </div>
              {selected
                ? (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input value={selected.name} onChange={(event) => patchSelected({ name: event.target.value })} className="h-8 max-w-64 text-xs" aria-label="方案名称" />
                      <Select value={selected.appliesTo} onValueChange={(value) => patchSelected({ appliesTo: value as ApiCryptoProfile['appliesTo'] })}>
                        <SelectTrigger className="h-8 w-32 text-xs" aria-label="适用环境"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">所有环境</SelectItem>
                          <SelectItem value="test">仅测试</SelectItem>
                          <SelectItem value="production">仅生产</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button type="button" className="ml-auto h-8 px-2 text-xs" disabled={busy} onClick={() => void saveSelected()}>保存方案</Button>
                      <Button type="button" variant="destructive" className="h-8 px-2 text-xs" disabled={busy} onClick={() => void deleteSelected()}>删除方案</Button>
                    </div>
                    <Input value={selected.description} onChange={(event) => patchSelected({ description: event.target.value })} placeholder="用途说明（会出现在审批卡上）" className="h-8 text-xs" aria-label="方案说明" />
                    {references && references.requests > 0 && (
                      <p data-crypto-impact="true" className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                        修改这个方案会影响 {references.requests} 个接口（{references.collections.join('、')}）：它们下一次发送就按新方案执行。
                      </p>
                    )}
                    {missing.length > 0 && (
                      <p data-crypto-missing="true" className="rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                        {environmentLabel} 缺少密钥变量：{missing.join('、')}。缺密钥不会阻断发送，但对应步骤会被跳过并标记「明文发出」。
                      </p>
                    )}
                    {([['requestSteps', '发送前（按顺序执行）', ['derive', 'sign', 'encrypt']], ['responseSteps', '收到后（按顺序还原）', ['decrypt']]] as const).map(([side, title, kinds]) => (
                      <div key={side} className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">{title}</span>
                          {kinds.map((kind) => (
                            <Button key={kind} type="button" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => patchSelected({ [side]: [...selected![side], createCryptoStep(kind, `step_${Math.random().toString(36).slice(2, 8)}`)] } as Partial<ApiCryptoProfile>)}>
                              <Plus className="size-3" />{kind === 'derive' ? '时间戳' : kind === 'sign' ? '签名' : kind === 'encrypt' ? '加密' : '解密'}
                            </Button>
                          ))}
                        </div>
                        {selected[side].length === 0 && <p className="text-[11px] text-muted-foreground">还没有步骤。</p>}
                        {selected[side].map((step, index) => (
                          <div key={step.id} data-api-crypto-step={`${side}:${index}`} className="space-y-1.5 rounded-md border border-border/50 p-2">
                            <div className="flex items-center gap-1.5">
                              <span className="w-5 text-center text-[11px] text-muted-foreground">{index + 1}</span>
                              <Switch checked={step.enabled} onCheckedChange={(checked) => patchStep(side, index, { enabled: checked })} aria-label={`启用第 ${index + 1} 步`} />
                              <Select value={step.kind} onValueChange={(value) => patchStep(side, index, { kind: value as ApiCryptoStep['kind'] })}>
                                <SelectTrigger className="h-7 w-24 text-[11px]"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {([['derive', '派生'], ['sign', '签名'], ['encrypt', '加密'], ['decrypt', '解密']] as const).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                                </SelectContent>
                              </Select>
                              <Select value={step.algo} onValueChange={(value) => patchStep(side, index, { algo: value })}>
                                <SelectTrigger className="h-7 w-40 text-[11px]" aria-label={`第 ${index + 1} 步算法`}><SelectValue /></SelectTrigger>
                                <SelectContent>{(API_CRYPTO_ALGOS[step.kind] as readonly string[]).map((algo) => <SelectItem key={algo} value={algo}>{algo}</SelectItem>)}</SelectContent>
                              </Select>
                              <div className="ml-auto flex items-center gap-0.5">
                                <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={`上移第 ${index + 1} 步`} onClick={() => moveStep(side, index, -1)}><ArrowUp className="size-3" /></Button>
                                <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={`下移第 ${index + 1} 步`} onClick={() => moveStep(side, index, 1)}><ArrowDown className="size-3" /></Button>
                                <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={`删除第 ${index + 1} 步`} onClick={() => patchSelected({ [side]: selected[side].filter((item) => item.id !== step.id) } as Partial<ApiCryptoProfile>)}><Trash2 className="size-3" /></Button>
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                              {step.kind !== 'derive' && <Input value={step.keyRef ?? ''} onChange={(event) => patchStep(side, index, { keyRef: event.target.value })} placeholder="密钥变量名" className="h-7 max-w-44 font-mono text-[11px]" aria-label={`第 ${index + 1} 步密钥变量`} />}
                              {(step.kind === 'encrypt' || step.kind === 'decrypt') && <Input value={step.ivRef ?? ''} onChange={(event) => patchStep(side, index, { ivRef: event.target.value })} placeholder="IV 变量名" className="h-7 max-w-40 font-mono text-[11px]" aria-label={`第 ${index + 1} 步 IV 变量`} />}
                              {step.kind !== 'derive' && (
                                <Select value={step.encoding ?? 'hex'} onValueChange={(value) => patchStep(side, index, { encoding: value as ApiCryptoStep['encoding'] })}>
                                  <SelectTrigger className="h-7 w-24 text-[11px]"><SelectValue /></SelectTrigger>
                                  <SelectContent>{['hex', 'base64', 'raw'].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                                </Select>
                              )}
                              {side === 'requestSteps' && step.kind !== 'encrypt' && (
                                <>
                                  <Input value={step.target?.name ?? ''} onChange={(event) => patchStep(side, index, { target: { in: step.target?.in ?? 'header', name: event.target.value } })} placeholder="写入位置" className="h-7 max-w-40 text-[11px]" aria-label={`第 ${index + 1} 步输出名称`} />
                                  <Select value={step.target?.in ?? 'header'} onValueChange={(value) => patchStep(side, index, { target: { in: value as 'header' | 'query' | 'body', name: step.target?.name ?? '' } })}>
                                    <SelectTrigger className="h-7 w-20 text-[11px]"><SelectValue /></SelectTrigger>
                                    <SelectContent>{([['header', 'Header'], ['query', 'Query']] as const).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                                  </Select>
                                </>
                              )}
                              {(step.kind === 'decrypt' || step.kind === 'encrypt') && (
                                <Select value={step.onFailure ?? 'stop'} onValueChange={(value) => patchStep(side, index, { onFailure: value as 'stop' | 'continue' })}>
                                  <SelectTrigger className="h-7 w-32 text-[11px]" aria-label={`第 ${index + 1} 步失败策略`}><SelectValue /></SelectTrigger>
                                  <SelectContent><SelectItem value="stop">失败即停</SelectItem><SelectItem value="continue">失败继续</SelectItem></SelectContent>
                                </Select>
                              )}
                            </div>
                            {step.kind === 'sign' && (
                              <Textarea value={step.template ?? ''} onChange={(event) => patchStep(side, index, { template: event.target.value })} placeholder={'{{method}}\n{{path}}\n{{query.sorted}}\n{{timestamp}}\n{{nonce}}\n{{body.sha256}}'} className="min-h-16 font-mono text-[11px]" aria-label={`第 ${index + 1} 步待签模板`} />
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                    <p className="text-[11px] text-muted-foreground">顺序即语义：签名排在加密之前就签明文，排在之后就签密文。可用占位符：<code className="font-mono">{'{{method}} {{path}} {{query}} {{query.sorted}} {{timestamp}} {{nonce}} {{body.raw}} {{body.sha256}} {{body.md5}}'}</code></p>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{selected.requestSteps.length + selected.responseSteps.length} 个步骤</Badge>
                      <span className="text-[11px] text-muted-foreground">P1 支持在正文上做对称加解密；认证加密（GCM）的标签落点留到 P2。</span>
                    </div>
                  </div>
                )
                : <p className="text-xs text-muted-foreground">左侧选一个方案，或新建一个。</p>}
            </div>
          )}
      </DialogContent>
    </Dialog>
  )
}
