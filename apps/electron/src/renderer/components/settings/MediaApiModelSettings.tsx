import * as React from 'react'
import type {
  ImageGenerationChannelOption,
  MediaApiModelCapability,
  MediaApiModelCatalogResult,
  MediaApiModelCatalogEntry,
  MediaApiModelKind,
  MediaApiModelProfile,
  MediaApiModelProtocol,
} from '@proma/shared'
import { MEDIA_API_MODEL_PROTOCOLS, parseMediaApiModelProfile } from '@proma/shared'
import { Copy, Loader2, Pencil, Plus, Save, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { MediaSettingsPage } from './MediaSettingsPage'
import { SettingsCard } from './primitives'

/** 媒体模型页标题下方的导航与状态提示插槽。 */
interface MediaApiModelSettingsProps {
  /** 与搜索筛选同一行的媒体配置页签。 */
  navigation?: React.ReactNode
  /** 工具栏下方的公共状态提示。 */
  children?: React.ReactNode
}

/** 统一媒体模型编辑器使用的目录属性。 */
export interface MediaApiModelCatalogViewProps extends MediaApiModelSettingsProps {
  entries: MediaApiModelCatalogEntry[]
  channelOptions: ImageGenerationChannelOption[]
  saving: boolean
  /** 首次读取目录时展示加载态并禁用新增入口。 */
  loading?: boolean
  onSaveProfiles: (profiles: MediaApiModelProfile[]) => boolean | Promise<boolean>
}

/** 媒体类型中文标签。 */
const MEDIA_KIND_LABELS: Readonly<Record<MediaApiModelKind, string>> = {
  image: '图片',
  audio: '音频',
  video: '视频',
}

/** 协议中文标签。 */
const PROTOCOL_LABELS: Readonly<Record<MediaApiModelProtocol, string>> = {
  'openai-images': 'OpenAI Images',
  'minimax-image': 'MiniMax 图片',
  'minimax-video': 'MiniMax 视频',
  'minimax-speech': 'MiniMax 语音',
  'minimax-music': 'MiniMax 音乐',
}

/** 能力中文标签。 */
const CAPABILITY_LABELS: Readonly<Record<MediaApiModelCapability, string>> = {
  'text-to-image': '文生图',
  'image-to-image': '图生图',
  'text-to-video': '文生视频',
  'image-to-video': '图生视频',
  'text-to-speech': '文本转语音',
  'voice-cloning': '声音克隆',
  'text-to-music': '文本转音乐',
}

/** 返回媒体类型的首个协议描述。 */
function firstProtocolForKind(mediaKind: MediaApiModelKind): (typeof MEDIA_API_MODEL_PROTOCOLS)[number] {
  /** 每种公开媒体类型至少有一个固定协议。 */
  const descriptor = MEDIA_API_MODEL_PROTOCOLS.find((item) => item.mediaKind === mediaKind)
  if (!descriptor) throw new Error(`缺少 ${mediaKind} 媒体协议`)
  return descriptor
}

/** 创建一条使用稳定 ID、渠道引用且不携带秘密的新媒体模型。 */
export function createMediaApiModelProfile(
  id: string,
  now: number,
  mediaKind: MediaApiModelKind = 'image',
): MediaApiModelProfile {
  /** 新类型使用该类型首个已声明协议。 */
  const descriptor = firstProtocolForKind(mediaKind)
  return {
    id,
    name: '',
    mediaKind,
    protocol: descriptor.protocol,
    channelId: '',
    modelId: '',
    capabilities: [...descriptor.capabilities],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
}

/** 切换媒体类型时同步协议与能力，并清空不再可信的模型 ID。 */
export function changeMediaApiModelKind(
  profile: MediaApiModelProfile,
  mediaKind: MediaApiModelKind,
): MediaApiModelProfile {
  /** 新类型使用的默认协议。 */
  const descriptor = firstProtocolForKind(mediaKind)
  return { ...profile, mediaKind, protocol: descriptor.protocol, modelId: '', capabilities: [...descriptor.capabilities] }
}

/** 切换协议时使用协议固定输出类型与能力。 */
export function changeMediaApiModelProtocol(
  profile: MediaApiModelProfile,
  protocol: MediaApiModelProtocol,
): MediaApiModelProfile {
  /** 目标协议的权威描述。 */
  const descriptor = MEDIA_API_MODEL_PROTOCOLS.find((item) => item.protocol === protocol)
  if (!descriptor) throw new Error('媒体模型协议无效')
  return { ...profile, protocol, mediaKind: descriptor.mediaKind, modelId: '', capabilities: [...descriptor.capabilities] }
}

/** 保存前执行 shared schema 与渠道引用校验。 */
export function validateMediaApiModelDraft(
  profile: MediaApiModelProfile,
  channelOptions: readonly ImageGenerationChannelOption[],
): string | null {
  try {
    parseMediaApiModelProfile(profile)
  } catch (error) {
    return error instanceof Error ? error.message : '媒体模型配置无效'
  }
  /** 模型必须引用已有渠道，秘密仍只由主进程通过该 ID 解析。 */
  const channel = channelOptions.find((item) => item.channelId === profile.channelId)
  if (!channel) return '请选择已有模型配置'
  if (profile.protocol === 'openai-images' && !channel.models.some((model) => model.id === profile.modelId)) {
    return '请选择当前模型配置中的图片模型'
  }
  return null
}

/** 按媒体类型与用户可见字段筛选统一目录，保留渠道失效条目的稳定身份。 */
export function filterMediaApiModelEntries(
  entries: readonly MediaApiModelCatalogEntry[],
  channelOptions: readonly ImageGenerationChannelOption[],
  query: string,
  mediaKind: MediaApiModelKind | 'all',
): MediaApiModelCatalogEntry[] {
  /** 去除无意义空白并统一大小写后的查询词。 */
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return entries.filter((entry) => {
    if (mediaKind !== 'all' && entry.profile.mediaKind !== mediaKind) return false
    if (!normalizedQuery) return true
    /** 渠道目录只用于补齐旧调用方尚未携带的用户可见名称。 */
    const channelName = entry.channelName
      ?? channelOptions.find((channel) => channel.channelId === entry.profile.channelId)?.name
      ?? entry.profile.channelId
    /** 同时搜索显示文案与稳定协议、能力标识，便于精确定位。 */
    const searchableText = [
      entry.profile.name,
      entry.profile.modelId,
      entry.profile.protocol,
      PROTOCOL_LABELS[entry.profile.protocol],
      channelName,
      entry.profile.channelId,
      ...entry.profile.capabilities,
      ...entry.profile.capabilities.map((capability) => CAPABILITY_LABELS[capability]),
    ].join('\n').toLocaleLowerCase()
    return searchableText.includes(normalizedQuery)
  })
}

/** 快捷切换指定模型的启用状态，并保持目录顺序与其它 profile 不变。 */
export function setMediaApiModelEnabled(
  profiles: readonly MediaApiModelProfile[],
  profileId: string,
  enabled: boolean,
  now: number,
): MediaApiModelProfile[] {
  return profiles.map((profile) => profile.id === profileId
    ? { ...profile, enabled, updatedAt: now }
    : profile)
}

/** 图片、音频和视频 API 模型的已保存目录与单条编辑器。 */
export function MediaApiModelCatalogView({
  entries,
  channelOptions,
  saving,
  loading = false,
  onSaveProfiles,
  navigation,
  children,
}: MediaApiModelCatalogViewProps): React.ReactElement {
  /** 当前单条编辑草稿。 */
  const [draft, setDraft] = React.useState<MediaApiModelProfile | null>(null)
  /** 待删除的稳定模型 ID。 */
  const [deleteId, setDeleteId] = React.useState<string | null>(null)
  /** 列表本地搜索词，不影响持久化目录。 */
  const [query, setQuery] = React.useState('')
  /** 列表本地媒体类型筛选。 */
  const [mediaKindFilter, setMediaKindFilter] = React.useState<MediaApiModelKind | 'all'>('all')
  /** 权威 profile 列表。 */
  const profiles = entries.map((entry) => entry.profile)
  /** 应用本地搜索和媒体类型筛选后的目录条目。 */
  const filteredEntries = filterMediaApiModelEntries(entries, channelOptions, query, mediaKindFilter)
  /** 草稿是否对应已有条目。 */
  const existing = draft ? profiles.some((profile) => profile.id === draft.id) : false
  /** 草稿可操作错误。 */
  const draftError = draft ? validateMediaApiModelDraft(draft, channelOptions) : null
  /** 当前协议允许的能力。 */
  const protocolCapabilities = draft
    ? MEDIA_API_MODEL_PROTOCOLS.find((item) => item.protocol === draft.protocol)?.capabilities ?? []
    : []
  /** OpenAI Images 当前渠道提供的真实模型。 */
  const channelModels = draft?.protocol === 'openai-images'
    ? channelOptions.find((item) => item.channelId === draft.channelId)?.models ?? []
    : []

  /** 保存当前草稿并保留其它稳定条目。 */
  const saveDraft = async (): Promise<void> => {
    if (!draft || draftError || saving) return
    /** 去除用户可编辑文本两端空白后的配置。 */
    const normalized = parseMediaApiModelProfile({
      ...draft,
      name: draft.name.trim(),
      channelId: draft.channelId.trim(),
      modelId: draft.modelId.trim(),
      updatedAt: Date.now(),
    })
    /** 用稳定 ID 替换或追加后的完整目录。 */
    const nextProfiles = existing
      ? profiles.map((profile) => profile.id === normalized.id ? normalized : profile)
      : [...profiles, normalized]
    if (await onSaveProfiles(nextProfiles)) setDraft(null)
  }

  /** 切换能力勾选状态。 */
  const toggleCapability = (capability: MediaApiModelCapability, checked: boolean): void => {
    if (!draft) return
    /** 更新后仍保持协议声明顺序的能力列表。 */
    const capabilities = protocolCapabilities.filter((item) => item === capability ? checked : draft.capabilities.includes(item))
    setDraft({ ...draft, capabilities })
  }

  /** 复制条目时生成独立身份，不复用旧任务引用。 */
  const copyProfile = (profile: MediaApiModelProfile): void => {
    /** 复制操作使用同一时间作为创建与更新时间。 */
    const now = Date.now()
    setDraft({ ...profile, id: globalThis.crypto.randomUUID(), name: `${profile.name} 副本`, createdAt: now, updatedAt: now })
  }

  /** 从列表快捷切换启用状态，并通过现有完整目录 CAS 保存。 */
  const toggleProfileEnabled = async (profile: MediaApiModelProfile, enabled: boolean): Promise<void> => {
    if (saving || profile.enabled === enabled) return
    /** 只替换目标稳定 ID，保留其它媒体模型及其顺序。 */
    const nextProfiles = setMediaApiModelEnabled(profiles, profile.id, enabled, Date.now())
    await onSaveProfiles(nextProfiles)
  }

  return (
    <MediaSettingsPage
      title={draft ? (existing ? '编辑媒体模型' : '添加媒体模型') : '媒体模型'}
      onBack={draft ? () => setDraft(null) : undefined}
      busy={saving}
      action={
        <Button type="button" size="sm" disabled={loading || saving || draft !== null} onClick={() => setDraft(createMediaApiModelProfile(globalThis.crypto.randomUUID(), Date.now()))}>
          <Plus size={16} />
          <span>添加 API 模型</span>
        </Button>
      }
    >
      {!draft && <div className="flex flex-wrap items-center justify-between gap-3">
        {navigation}
        {!loading && (
          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <div className="relative w-64 max-w-full">
              <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input value={query} className="pl-9" placeholder="搜索名称、协议、渠道或能力" disabled={saving} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <Select value={mediaKindFilter} disabled={saving} onValueChange={(value: MediaApiModelKind | 'all') => setMediaKindFilter(value)}>
              <SelectTrigger className="w-32" aria-label="筛选媒体类型"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">全部类型</SelectItem>{(['image', 'audio', 'video'] as const).map((kind) => <SelectItem key={kind} value={kind}>{MEDIA_KIND_LABELS[kind]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        )}
      </div>}
      {children}
      <SettingsCard divided>
        {loading ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />正在读取媒体模型...</div>
        ) : draft ? (
          <div className="space-y-4 p-4">
            {draftError && <p role="alert" className="text-xs text-destructive">{draftError}</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs font-medium">名称<Input value={draft.name} disabled={saving} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
              <label className="space-y-1 text-xs font-medium">媒体类型<Select value={draft.mediaKind} disabled={saving} onValueChange={(mediaKind: MediaApiModelKind) => setDraft(changeMediaApiModelKind(draft, mediaKind))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(['image', 'audio', 'video'] as const).map((kind) => <SelectItem key={kind} value={kind}>{MEDIA_KIND_LABELS[kind]}</SelectItem>)}</SelectContent></Select></label>
              <label className="space-y-1 text-xs font-medium">协议<Select value={draft.protocol} disabled={saving} onValueChange={(protocol: MediaApiModelProtocol) => setDraft(changeMediaApiModelProtocol(draft, protocol))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{MEDIA_API_MODEL_PROTOCOLS.filter((item) => item.mediaKind === draft.mediaKind).map((item) => <SelectItem key={item.protocol} value={item.protocol}>{PROTOCOL_LABELS[item.protocol]}</SelectItem>)}</SelectContent></Select></label>
              <label className="space-y-1 text-xs font-medium">模型配置<Select value={draft.channelId || undefined} disabled={saving} onValueChange={(channelId) => setDraft({ ...draft, channelId, ...(draft.protocol === 'openai-images' ? { modelId: '' } : {}) })}><SelectTrigger><SelectValue placeholder="选择凭据所属配置" /></SelectTrigger><SelectContent>{channelOptions.map((channel) => <SelectItem key={channel.channelId} value={channel.channelId}>{channel.name}</SelectItem>)}</SelectContent></Select></label>
              {draft.protocol === 'openai-images' ? <label className="space-y-1 text-xs font-medium">模型<Select value={draft.modelId || undefined} disabled={saving || !draft.channelId} onValueChange={(modelId) => setDraft({ ...draft, modelId })}><SelectTrigger><SelectValue placeholder="选择图片模型" /></SelectTrigger><SelectContent>{channelModels.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent></Select></label> : <label className="space-y-1 text-xs font-medium">模型 ID<Input value={draft.modelId} disabled={saving} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} /></label>}
              <div className="space-y-2 text-xs font-medium"><span>能力</span><div className="flex flex-wrap gap-x-4 gap-y-2">{protocolCapabilities.map((capability) => <label key={capability} className="flex items-center gap-2 font-normal"><input type="checkbox" checked={draft.capabilities.includes(capability)} disabled={saving} onChange={(event) => toggleCapability(capability, event.target.checked)} />{CAPABILITY_LABELS[capability]}</label>)}</div></div>
              <label className="flex items-center gap-2 self-end pb-2 text-xs"><Switch checked={draft.enabled} disabled={saving} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />启用模型</label>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-3"><Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setDraft(null)}>取消</Button><Button type="button" size="sm" disabled={saving || draftError !== null} onClick={() => void saveDraft()}>{saving ? <Loader2 className="animate-spin" /> : <Save />}保存模型</Button></div>
          </div>
        ) : (
          <>
            {filteredEntries.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">{entries.length === 0 ? '尚未配置 API 媒体模型' : '没有匹配的媒体模型'}</div>
            ) : filteredEntries.map(({ profile, channelName, support }) => {
              /** 兼容旧目录结果，优先显示主进程派生的渠道名称。 */
              const visibleChannelName = channelName
                ?? channelOptions.find((channel) => channel.channelId === profile.channelId)?.name
                ?? profile.channelId
              return (
                <div key={profile.id} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1 basis-52">
                    <span className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-medium">{profile.name}</span><span className="border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">{MEDIA_KIND_LABELS[profile.mediaKind]}</span></span>
                    <span className="block truncate text-xs text-muted-foreground">{PROTOCOL_LABELS[profile.protocol]} · {profile.modelId}</span>
                    <span className="block truncate text-xs text-muted-foreground">渠道：{visibleChannelName}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground" title={support.state === 'supported' ? support.adapterId : support.reason}>{support.state === 'supported' ? '可执行' : support.state === 'configuration-only' ? '待适配' : '不可用'}</span>
                  <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"><Switch checked={profile.enabled} disabled={saving} aria-label={`${profile.enabled ? '停用' : '启用'} ${profile.name}`} onCheckedChange={(enabled) => void toggleProfileEnabled(profile, enabled)} />启用</label>
                  <div className="flex items-center gap-1"><Button type="button" size="icon-sm" variant="ghost" aria-label={`复制 ${profile.name}`} title="复制" disabled={saving} onClick={() => copyProfile(profile)}><Copy /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`编辑 ${profile.name}`} title="编辑" disabled={saving} onClick={() => setDraft({ ...profile, capabilities: [...profile.capabilities] })}><Pencil /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`删除 ${profile.name}`} title="删除" disabled={saving} onClick={() => setDeleteId(profile.id)}><Trash2 /></Button></div>
                </div>
              )
            })}
          </>
        )}
      </SettingsCard>
      <ConfirmDialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null) }} title="删除 API 媒体模型？" description="删除后，引用该稳定模型 ID 的画布范围需要重新选择。" confirmLabel="删除" loading={saving} variant="destructive" onConfirm={async () => { if (!deleteId) return; if (await onSaveProfiles(profiles.filter((profile) => profile.id !== deleteId))) setDeleteId(null) }} />
    </MediaSettingsPage>
  )
}

/** 从主进程统一目录加载并保存 API 媒体模型。 */
export function MediaApiModelSettings({ navigation, children }: MediaApiModelSettingsProps): React.ReactElement {
  /** 当前权威 API 媒体模型目录。 */
  const [catalog, setCatalog] = React.useState<MediaApiModelCatalogResult | null>(null)
  /** 渠道公开摘要只用于选择稳定 channelId，不包含秘密。 */
  const [channelOptions, setChannelOptions] = React.useState<ImageGenerationChannelOption[]>([])
  /** 首次与后台加载状态。 */
  const [loading, setLoading] = React.useState(true)
  /** CAS 保存互斥状态。 */
  const [saving, setSaving] = React.useState(false)
  /** 可展示的目录读取或保存错误。 */
  const [error, setError] = React.useState<string | null>(null)
  /** 组件卸载和并发读取使用同一请求代次。 */
  const requestRevisionRef = React.useRef(0)

  /** 并行读取统一目录和渠道摘要，并拒绝迟到响应。 */
  const load = React.useCallback(async (): Promise<void> => {
    /** 当前加载请求代次。 */
    const requestRevision = requestRevisionRef.current + 1
    requestRevisionRef.current = requestRevision
    setLoading(true)
    setError(null)
    try {
      /** 模型目录与渠道摘要来自同一主进程 catalog。 */
      const [nextCatalog, imageCatalog] = await Promise.all([
        window.electronAPI.listMediaApiModelProfiles(),
        window.electronAPI.listImageModelProfiles(),
      ])
      if (requestRevision !== requestRevisionRef.current) return
      setCatalog(nextCatalog)
      setChannelOptions(imageCatalog.channelOptions)
    } catch (loadError) {
      if (requestRevision === requestRevisionRef.current) setError(loadError instanceof Error ? loadError.message : '媒体模型读取失败')
    } finally {
      if (requestRevision === requestRevisionRef.current) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    /** 图片与 API 模型共用目录广播。 */
    const unsubscribe = window.electronAPI.onImageModelProfilesChanged(() => { void load() })
    return () => {
      requestRevisionRef.current += 1
      unsubscribe()
    }
  }, [load])

  /** 使用当前权威 revision 保存完整 API 模型目录。 */
  const saveProfiles = async (profiles: MediaApiModelProfile[]): Promise<boolean> => {
    if (!catalog || saving) return false
    setSaving(true)
    setError(null)
    try {
      /** CAS 成功后返回的新权威目录。 */
      const result = await window.electronAPI.saveMediaApiModelProfiles({ profiles, expectedRevision: catalog.revision })
      requestRevisionRef.current += 1
      setCatalog(result)
      return true
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '媒体模型保存失败')
      return false
    } finally {
      setSaving(false)
    }
  }

  return (
    <MediaApiModelCatalogView entries={catalog?.entries ?? []} channelOptions={channelOptions} loading={loading && !catalog} saving={saving} onSaveProfiles={saveProfiles} navigation={navigation}>
      {children}
      {error && <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 border border-destructive/30 px-3 py-2 text-xs text-destructive"><span>{error}</span><Button type="button" size="sm" variant="outline" disabled={loading || saving} onClick={() => void load()}>重新加载</Button></div>}
    </MediaApiModelCatalogView>
  )
}
