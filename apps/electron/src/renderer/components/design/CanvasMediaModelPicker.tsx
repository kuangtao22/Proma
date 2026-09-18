import * as React from 'react'
import { useSetAtom } from 'jotai'
import { LoaderCircle, Settings2, SlidersHorizontal } from 'lucide-react'
import { buildCanvasGenerationModelOptions, resolveCanvasMediaModelOptions } from '@proma/shared'
import type { CanvasMediaModelOption, CanvasMediaModelScope, MediaApiModelKind } from '@proma/shared'
import type { DesignAdapter } from '@/lib/design-adapter'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { getJimengLogo, getProviderLogo } from '@/lib/model-logo'

/** 供应商稳定标识到中文名的展示映射，与生成模型设置页保持一致。 */
const PROVIDER_LABELS: Record<string, string> = {
  dreamina: '即梦',
  'openai-images': 'ChatGPT（OpenAI Images）',
  minimax: 'MiniMax 图像',
}

/**
 * 供应商到品牌图标的映射。
 * 即梦用官方图标；OpenAI 与 MiniMax 复用渠道图标；未知供应商不加图标而不是拿别的品牌冒充。
 */
function providerIcon(provider: string | undefined): string | undefined {
  if (provider === 'dreamina') return getJimengLogo()
  if (provider === 'openai-images') return getProviderLogo('openai')
  if (provider === 'minimax') return getProviderLogo('minimax')
  return undefined
}

/** 供应商图标；缺图标时保持占位宽度，避免同一列表里文字错位。 */
function ProviderIcon({ provider }: { provider: string | undefined }): React.ReactElement {
  const icon = providerIcon(provider)
  return icon === undefined
    ? <span aria-hidden="true" className="size-5 shrink-0 rounded bg-muted" />
    : <img src={icon} alt="" className="size-5 shrink-0 rounded object-contain" />
}

/** 画布媒体配置统一入口；模型范围和服务器绑定分别通过父组件的文档 CAS 保存。 */
export interface CanvasMediaModelPickerProps {
  projectId: string
  scope?: CanvasMediaModelScope
  disabled?: boolean
  getImageModelSelection?: DesignAdapter['getImageModelSelection']
  /** 读取独立生成配置的公开目录；画布候选由它组装，不再读旧统一目录。 */
  getCanvasGenerationCatalog?: DesignAdapter['getCanvasGenerationCatalog']
  onImageModelProfilesChanged?: DesignAdapter['onImageModelProfilesChanged']
  /** 已连接画布绑定状态的服务器控件，与模型多选保持独立。 */
  connectionPicker?: React.ReactNode
  onChange: (scope: CanvasMediaModelScope) => void
}

/** 同一弹层管理服务器与 API 模型候选，不为节点自动挑选执行模型。 */
export function CanvasMediaModelPicker({ projectId, scope, disabled, getImageModelSelection, getCanvasGenerationCatalog, onImageModelProfilesChanged, connectionPicker, onChange }: CanvasMediaModelPickerProps): React.ReactElement {
  /** 目录响应按请求代次接管，防止切换项目后旧请求覆盖当前选择器。 */
  const requestVersion = React.useRef(0)
  const [options, setOptions] = React.useState<CanvasMediaModelOption[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  /** 类型筛选只影响展示，不修改已保存的完整候选范围。 */
  const [kind, setKind] = React.useState<MediaApiModelKind | 'all'>('all')
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const load = React.useCallback(async () => {
    const version = ++requestVersion.current
    setLoading(true)
    setError(null)
    try {
      const [selection, catalog] = await Promise.all([getImageModelSelection?.(projectId), getCanvasGenerationCatalog?.()])
      /** 独立生成配置与本地工作流候选合并；历史渠道条目不再进入画布选择。 */
      if (version === requestVersion.current) setOptions(buildCanvasGenerationModelOptions(catalog, selection?.options ?? []))
    } catch {
      if (version === requestVersion.current) setError('媒体模型加载失败')
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [getCanvasGenerationCatalog, getImageModelSelection, projectId])
  React.useEffect(() => {
    void load()
    const unsubscribe = onImageModelProfilesChanged?.(() => { void load() })
    return () => { ++requestVersion.current; unsubscribe?.() }
  }, [load, onImageModelProfilesChanged])
  const selection = resolveCanvasMediaModelOptions(scope, options)
  const optionIds = new Set(options.map((option) => option.profileId))
  const search = query.trim().toLocaleLowerCase()
  const filtered = options.filter((option) => (kind === 'all' || kind === option.mediaKind)
    && `${option.name} ${option.modelId} ${option.channelId ?? ''}`.toLocaleLowerCase().includes(search))
  /** 按渠道归组，保留同一媒体类型下的不同供应商。 */
  const groups = [...new Set(filtered.map((option) => option.channelId ?? '内置'))]
  /** 当前目录里出现过的供应商，供「按供应商自动」逐家勾选。 */
  const providerIds = [...new Set(options.map((option) => option.provider).filter((provider): provider is string => provider !== undefined))]
  /** 当前生效的供应商集合；全部已启用等价于「所有供应商都选」。 */
  const selectedProviders = scope?.mode === 'providers'
    ? scope.providers.filter((provider) => providerIds.includes(provider))
    : providerIds
  /** 页签由范围模式推导：显式选模型才属于自定义。 */
  const mode: 'auto' | 'manual' = scope?.mode === 'selected' ? 'manual' : 'auto'
  const missingIds = selection.unavailableIds.filter((id) => !optionIds.has(id) && id.toLocaleLowerCase().includes(search))
  /** 首次切换单项即固定当前完整候选集合，保留失效引用以便显式移除。 */
  const toggle = (id: string, checked: boolean): void => {
    const ids = new Set(selection.selectedIds)
    if (checked) ids.add(id)
    else ids.delete(id)
    onChange({ mode: 'selected', modelIds: [...ids] })
  }
  return <Popover>
    <PopoverTrigger asChild>
      <Button type="button" size="icon-sm" variant="ghost" className="size-8 shrink-0" aria-label={`画布媒体配置${loading ? '' : `：${selection.availableIds.length} 个可用模型`}`} title="画布媒体配置">
        <SlidersHorizontal aria-hidden="true" />
      </Button>
    </PopoverTrigger>
    {/* 嵌套服务器下拉会测量触发器尺寸，父层保留淡入和平移，避免缩放引发重复尺寸通知。 */}
    <PopoverContent align="center" side="bottom" collisionPadding={8} aria-label="画布媒体配置" className="max-h-[calc(100vh-5rem)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-3 data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">画布媒体配置</h3>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="管理媒体配置" title="管理媒体配置" onClick={() => { setSettingsTab('media'); setSettingsOpen(true) }}><Settings2 aria-hidden="true" /></Button>
      </div>
      {connectionPicker ? <div className="mb-3 space-y-2 border-b border-border pb-3">
        <h4 className="text-xs font-medium">ComfyUI 服务器</h4>
        {connectionPicker}
      </div> : null}
      <h4 className="mb-2 text-xs font-medium">可用媒体模型</h4>
      <Input aria-label="搜索媒体模型" placeholder="搜索媒体模型" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div role="group" aria-label="媒体类型" className="mt-2 grid grid-cols-4 gap-1">
        {(['all', 'image', 'audio', 'video'] as const).map((value) => <Button key={value} type="button" variant={kind === value ? 'secondary' : 'ghost'} size="sm" className="h-7 px-1 text-xs" aria-pressed={kind === value} onClick={() => setKind(value)}>{({ all: '全部', image: '图片', audio: '音频', video: '视频' })[value]}</Button>)}
      </div>
      {/**
        * 两种使用方式用页签切换：
        * 自动 = 只选供应商，具体模型由 agent 在范围内适配；自定义 = 逐条指定模型。
        */}
      <div role="tablist" aria-label="模型选择方式" className="my-2 grid grid-cols-2 gap-1 rounded bg-muted/40 p-1">
        {([['auto', '按供应商自动'], ['manual', '自定义模型']] as const).map(([value, label]) => (
          <Button key={value} type="button" role="tab" size="sm" aria-selected={mode === value}
            variant={mode === value ? 'secondary' : 'ghost'} className="h-7 text-xs"
            disabled={disabled || loading || !!error}
            onClick={() => {
              if (value === mode) return
              /** 切到自动时保留当前可用范围；切到自定义时固定当前生效模型，避免选择丢失。 */
              if (value === 'auto') onChange(providerIds.length > 0 && selectedProviders.length === providerIds.length
                ? { mode: 'all-enabled' }
                : { mode: 'providers', providers: selectedProviders.length > 0 ? selectedProviders : providerIds })
              else onChange({ mode: 'selected', modelIds: selection.selectedIds })
            }}>
            {label}
          </Button>
        ))}
      </div>
      <div className="max-h-64 overflow-y-auto" aria-busy={loading}>
        {loading ? <div role="status" className="flex justify-center py-5"><LoaderCircle className="size-4 animate-spin" aria-label="正在加载媒体模型" /></div> : error ? <div role="alert" className="py-3 text-sm text-destructive">{error}<Button variant="ghost" size="sm" onClick={() => { void load() }}>重试</Button></div> : <>
          {/**
            * 自动模式只列供应商，模型交给 agent 适配。
            * 用列表行而不是内联复选，供应商再多也排得下，并且带上品牌图标。
            */}
          {mode === 'auto' ? <>
            <p className="px-1 pb-1 text-xs text-muted-foreground">勾选供应商即可，具体模型由 agent 在该范围内适配。</p>
            <div className="divide-y divide-border/40 rounded border border-border/60">
              {providerIds.map((provider) => {
                const checked = selectedProviders.includes(provider)
                /** 全部供应商都选中时回退为「跟随目录」，新增供应商会自动纳入。 */
                const nextProviders = checked
                  ? selectedProviders.filter((item) => item !== provider)
                  : [...selectedProviders, provider]
                return <label key={provider} className="flex min-w-0 items-center gap-2 px-2 py-2 hover:bg-accent">
                  <ProviderIcon provider={provider} />
                  <span className="min-w-0 flex-1 truncate text-sm">{PROVIDER_LABELS[provider] ?? provider}</span>
                  <input type="checkbox" aria-label={`供应商 ${provider}`} disabled={disabled} checked={checked}
                    onChange={(event) => onChange(event.target.checked
                      ? nextProviders.length === providerIds.length
                        ? { mode: 'all-enabled' }
                        : { mode: 'providers', providers: nextProviders }
                      : { mode: 'providers', providers: nextProviders })} />
                </label>
              })}
              {providerIds.length === 0 ? <p className="px-2 py-3 text-center text-xs text-muted-foreground">还没有可用的生成供应商，请先到设置里添加</p> : null}
            </div>
          </> : null}
          {mode === 'manual' ? <>
          {groups.map((group) => <div key={group}>
          <div className="truncate px-1 pt-2 text-xs text-muted-foreground">{filtered.find((option) => option.channelId === group)?.channelName ?? group}</div>
          {filtered.filter((option) => (option.channelId ?? '内置') === group).map((option) => <label key={option.profileId} className="flex min-w-0 items-center gap-2 rounded px-1 py-2 hover:bg-accent">
            <input type="checkbox" aria-label={option.name} checked={selection.selectedIds.includes(option.profileId)} disabled={disabled || (!option.available && !selection.selectedIds.includes(option.profileId))} onChange={(event) => toggle(option.profileId, event.target.checked)} />
            <ProviderIcon provider={option.provider} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm">{option.name}</span><span className="block truncate text-xs text-muted-foreground" title={option.unavailableReason}>{option.available ? option.modelId : option.unavailableReason ?? '当前不可用'}</span></span>
          </label>)}</div>)}
          {!filtered.length ? <p className="py-4 text-center text-sm text-muted-foreground">{query ? '没有匹配的模型' : '暂无媒体模型'}</p> : null}
          </> : null}
          {/**
            * 失效选择来自旧媒体目录：只给裸 ID 用户看不懂，因此显式说明来源、
            * 保留完整 ID 作 title，并提供一次清空全部失效引用的入口。
            */}
          {missingIds.length > 0 ? <div className="flex items-center justify-between px-1 pt-2">
            <span className="text-xs text-muted-foreground">失效的旧模型选择 {missingIds.length} 个</span>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={disabled} onClick={() => { for (const id of missingIds) toggle(id, false) }}>清理全部</Button>
          </div> : null}
          {missingIds.map((id) => <label key={id} className="flex min-w-0 items-center gap-2 px-1 py-2" title={id}><input type="checkbox" checked disabled={disabled} aria-label={`移除失效模型 ${id}`} onChange={() => toggle(id, false)} /><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">该模型已从媒体目录移除，勾选可取消</span></label>)}
        </>}
      </div>
    </PopoverContent>
  </Popover>
}
