import * as React from 'react'
import { useSetAtom } from 'jotai'
import { LoaderCircle, Settings2, SlidersHorizontal } from 'lucide-react'
import { buildCanvasMediaModelOptions, resolveCanvasMediaModelOptions } from '@proma/shared'
import type { CanvasMediaModelOption, CanvasMediaModelScope, MediaApiModelKind } from '@proma/shared'
import type { DesignAdapter } from '@/lib/design-adapter'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** 画布媒体配置统一入口；模型范围和服务器绑定分别通过父组件的文档 CAS 保存。 */
export interface CanvasMediaModelPickerProps {
  projectId: string
  scope?: CanvasMediaModelScope
  disabled?: boolean
  getImageModelSelection?: DesignAdapter['getImageModelSelection']
  listMediaApiModelProfiles?: DesignAdapter['listMediaApiModelProfiles']
  onImageModelProfilesChanged?: DesignAdapter['onImageModelProfilesChanged']
  /** 已连接画布绑定状态的服务器控件，与模型多选保持独立。 */
  connectionPicker?: React.ReactNode
  onChange: (scope: CanvasMediaModelScope) => void
}

/** 同一弹层管理服务器与 API 模型候选，不为节点自动挑选执行模型。 */
export function CanvasMediaModelPicker({ projectId, scope, disabled, getImageModelSelection, listMediaApiModelProfiles, onImageModelProfilesChanged, connectionPicker, onChange }: CanvasMediaModelPickerProps): React.ReactElement {
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
      const [selection, catalog] = await Promise.all([getImageModelSelection?.(projectId), listMediaApiModelProfiles?.()])
      if (version === requestVersion.current) setOptions(buildCanvasMediaModelOptions(catalog, selection?.options ?? []))
    } catch {
      if (version === requestVersion.current) setError('媒体模型加载失败')
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [getImageModelSelection, listMediaApiModelProfiles, projectId])
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
      <div className="my-2 flex items-center justify-between gap-2 text-xs">
        <label className="flex min-w-0 items-center gap-2"><input type="checkbox" disabled={disabled || loading || !!error} checked={!scope || scope.mode === 'all-enabled'} onChange={(event) => onChange(event.target.checked ? { mode: 'all-enabled' } : { mode: 'selected', modelIds: selection.selectedIds })} />全部已启用</label>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={disabled || loading || !!error} onClick={() => onChange({ mode: 'selected', modelIds: [] })}>全不选</Button>
      </div>
      <div className="max-h-64 overflow-y-auto" aria-busy={loading}>
        {loading ? <div role="status" className="flex justify-center py-5"><LoaderCircle className="size-4 animate-spin" aria-label="正在加载媒体模型" /></div> : error ? <div role="alert" className="py-3 text-sm text-destructive">{error}<Button variant="ghost" size="sm" onClick={() => { void load() }}>重试</Button></div> : <>
          {groups.map((group) => <div key={group}>
          <div className="truncate px-1 pt-2 text-xs text-muted-foreground">{filtered.find((option) => option.channelId === group)?.channelName ?? group}</div>
          {filtered.filter((option) => (option.channelId ?? '内置') === group).map((option) => <label key={option.profileId} className="flex min-w-0 items-center gap-2 rounded px-1 py-2 hover:bg-accent">
            <input type="checkbox" aria-label={option.name} checked={selection.selectedIds.includes(option.profileId)} disabled={disabled || (!option.available && !selection.selectedIds.includes(option.profileId))} onChange={(event) => toggle(option.profileId, event.target.checked)} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm">{option.name}</span><span className="block truncate text-xs text-muted-foreground" title={option.unavailableReason}>{option.available ? option.modelId : option.unavailableReason ?? '当前不可用'}</span></span>
          </label>)}</div>)}
          {missingIds.map((id) => <label key={id} className="flex min-w-0 items-center gap-2 px-1 py-2"><input type="checkbox" checked disabled={disabled} aria-label={`移除失效模型 ${id}`} onChange={() => toggle(id, false)} /><span className="min-w-0 truncate text-xs text-muted-foreground">{id} · 已移除</span></label>)}
          {!filtered.length && !missingIds.length ? <p className="py-4 text-center text-sm text-muted-foreground">{query ? '没有匹配的模型' : '暂无媒体模型'}</p> : null}
        </>}
      </div>
    </PopoverContent>
  </Popover>
}
