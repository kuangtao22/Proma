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
  /** 固定媒体类型时只展示和编辑该类型，隐藏类型切换控件。 */
  fixedMediaKind?: 'image'
  /** 与搜索筛选同一行的媒体配置页签。 */
  navigation?: React.ReactNode
  /** 标题下方的全局媒体设置。 */
  headerContent?: React.ReactNode
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

/** 目录 controller 使用的权威输入，组件与无 DOM 行为测试共用。 */
export interface MediaApiModelCatalogControllerOptions {
  entries: MediaApiModelCatalogEntry[]
  channelOptions: ImageGenerationChannelOption[]
  saving: boolean
  fixedMediaKind?: 'image'
  onSaveProfiles: (profiles: MediaApiModelProfile[]) => boolean | Promise<boolean>
}

/** 目录单条动作的生产 controller。 */
export interface MediaApiModelCatalogController {
  profiles: MediaApiModelProfile[]
  visibleProfiles: MediaApiModelProfile[]
  draft: MediaApiModelProfile | null
  deleteId: string | null
  existing: boolean
  draftError: string | null
  actionError: string | null
  startCreate: () => void
  startEdit: (profile: MediaApiModelProfile) => void
  startCopy: (profile: MediaApiModelProfile) => void
  updateDraft: (profile: MediaApiModelProfile) => void
  closeDraft: () => void
  saveDraft: () => Promise<void>
  toggleEnabled: (profile: MediaApiModelProfile, enabled: boolean) => Promise<void>
  requestDelete: (profileId: string) => void
  closeDelete: () => void
  confirmDelete: () => Promise<void>
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

/** 返回 fixed 与统一目录各自使用的用户可见文案。 */
export function getMediaApiModelCopy(fixedMediaKind?: 'image'): {
  title: string
  addTitle: string
  editTitle: string
  loading: string
  empty: string
  noMatches: string
  deleteTitle: string
  loadError: string
  saveError: string
} {
  if (fixedMediaKind === 'image') {
    return {
      title: '生图模型', addTitle: '添加生图模型', editTitle: '编辑生图模型',
      loading: '正在读取生图模型...', empty: '尚未配置生图模型', noMatches: '没有匹配的生图模型',
      deleteTitle: '删除生图模型？', loadError: '生图模型读取失败', saveError: '生图模型保存失败',
    }
  }
  return {
    title: '媒体模型', addTitle: '添加媒体模型', editTitle: '编辑媒体模型',
    loading: '正在读取媒体模型...', empty: '尚未配置 API 媒体模型', noMatches: '没有匹配的媒体模型',
    deleteTitle: '删除 API 媒体模型？', loadError: '媒体模型读取失败', saveError: '媒体模型保存失败',
  }
}

/** fixed 生图页将上游通用错误中的旧目录称呼归一为当前分区文案。 */
export function formatMediaApiModelMessage(message: string, fixedMediaKind?: 'image'): string {
  if (fixedMediaKind !== 'image') return message
  return message
    .replaceAll('媒体 API 模型', '生图模型')
    .replaceAll('API 媒体模型', '生图模型')
    .replaceAll('媒体模型', '生图模型')
}

/** 对 Profile 的嵌套字段按键名排序，生成不受对象键顺序影响的稳定指纹。 */
function stableMediaApiModelStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableMediaApiModelStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableMediaApiModelStringify(record[key])}`).join(',')}}`
}

interface MediaApiModelTargetBaseline {
  id: string
  fingerprint: string
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

/** 将 fixed 视图的可见子集合并回当前完整目录，隐藏条目保持原对象与顺序。 */
export function mergeFixedMediaApiModelProfiles(
  currentProfiles: readonly MediaApiModelProfile[],
  fixedMediaKind: 'image',
  nextVisibleProfiles: readonly MediaApiModelProfile[],
): MediaApiModelProfile[] {
  /** 只接受固定类型条目，避免视图操作越过所属分区。 */
  const nextFixedProfiles = nextVisibleProfiles.filter((profile) => profile.mediaKind === fixedMediaKind)
  /** 已存在条目按稳定 ID 原位替换，删除则跳过。 */
  const nextById = new Map(nextFixedProfiles.map((profile) => [profile.id, profile]))
  /** 用于区分新增条目，新增项在现有目录末尾保持可预测顺序。 */
  const existingIds = new Set(currentProfiles.filter((profile) => profile.mediaKind === fixedMediaKind).map((profile) => profile.id))
  const merged: MediaApiModelProfile[] = []
  for (const profile of currentProfiles) {
    if (profile.mediaKind !== fixedMediaKind) {
      merged.push(profile)
      continue
    }
    const replacement = nextById.get(profile.id)
    if (replacement) merged.push(replacement)
  }
  for (const profile of nextFixedProfiles) {
    if (!existingIds.has(profile.id)) merged.push(profile)
  }
  return merged
}

/** 管理目录真实增删改复制与启停保存，所有 fixed 写入均合并当前 props 的完整目录。 */
export function useMediaApiModelCatalogController({
  entries,
  channelOptions,
  saving,
  fixedMediaKind,
  onSaveProfiles,
}: MediaApiModelCatalogControllerOptions): MediaApiModelCatalogController {
  /** 当前单条编辑草稿。 */
  const [draft, setDraft] = React.useState<MediaApiModelProfile | null>(null)
  /** 编辑已有条目时记录目标打开瞬间的稳定内容基线。 */
  const [editBaseline, setEditBaseline] = React.useState<MediaApiModelTargetBaseline | null>(null)
  /** 待删除的稳定模型 ID。 */
  const [deleteId, setDeleteId] = React.useState<string | null>(null)
  /** 删除确认打开瞬间的目标稳定内容基线。 */
  const [deleteBaseline, setDeleteBaseline] = React.useState<MediaApiModelTargetBaseline | null>(null)
  /** 外部刷新冲突与重复 ID 错误。 */
  const [actionError, setActionError] = React.useState<string | null>(null)
  /** 每次渲染都从最新 entries 派生完整目录，避免保留隐藏快照。 */
  const profiles = entries.map((entry) => entry.profile)
  /** fixed 模式只允许操作所属媒体类型。 */
  const visibleProfiles = fixedMediaKind
    ? profiles.filter((profile) => profile.mediaKind === fixedMediaKind)
    : profiles
  /** 草稿是否仍对应当前权威目录的可见条目。 */
  const existing = editBaseline !== null
  /** 草稿可操作错误。 */
  const rawDraftError = draft ? validateMediaApiModelDraft(draft, channelOptions) : null
  /** fixed 页不得向用户泄露旧统一目录称呼。 */
  const draftError = rawDraftError ? formatMediaApiModelMessage(rawDraftError, fixedMediaKind) : null

  /** 把可见子集保存为完整目录，fixed 模式保留最新 hidden 条目。 */
  const saveVisibleProfiles = async (nextVisibleProfiles: MediaApiModelProfile[]): Promise<boolean> => {
    /** 非 fixed 目录本身就是完整目录。 */
    const nextProfiles = fixedMediaKind
      ? mergeFixedMediaApiModelProfiles(profiles, fixedMediaKind, nextVisibleProfiles)
      : nextVisibleProfiles
    return onSaveProfiles(nextProfiles)
  }

  /** 新建草稿固定使用当前分区媒体类型。 */
  const startCreate = (): void => {
    setEditBaseline(null)
    setActionError(null)
    setDraft(createMediaApiModelProfile(globalThis.crypto.randomUUID(), Date.now(), fixedMediaKind ?? 'image'))
  }

  /** 编辑只接受当前视图可见条目，并复制能力数组避免修改权威对象。 */
  const startEdit = (profile: MediaApiModelProfile): void => {
    if (fixedMediaKind && profile.mediaKind !== fixedMediaKind) return
    setEditBaseline({ id: profile.id, fingerprint: stableMediaApiModelStringify(profile) })
    setActionError(null)
    setDraft({ ...profile, capabilities: [...profile.capabilities] })
  }

  /** 复制可见条目时生成独立身份，不复用旧任务引用。 */
  const startCopy = (profile: MediaApiModelProfile): void => {
    if (fixedMediaKind && profile.mediaKind !== fixedMediaKind) return
    /** 复制操作使用同一时间作为创建与更新时间。 */
    const now = Date.now()
    setEditBaseline(null)
    setActionError(null)
    setDraft({ ...profile, id: globalThis.crypto.randomUUID(), name: `${profile.name} 副本`, createdAt: now, updatedAt: now })
  }

  /** 更新草稿时强制维持 fixed 媒体类型。 */
  const updateDraft = (profile: MediaApiModelProfile): void => {
    setDraft(fixedMediaKind && profile.mediaKind !== fixedMediaKind
      ? changeMediaApiModelKind(profile, fixedMediaKind)
      : profile)
  }

  /** 保存当前草稿并保留其它稳定条目。 */
  const saveDraft = async (): Promise<void> => {
    if (!draft || draftError || saving) return
    /** 编辑目标必须仍存在且与打开草稿时完全一致。 */
    if (editBaseline) {
      const currentTarget = profiles.find((profile) => profile.id === editBaseline.id)
      if (!currentTarget) {
        setActionError(`该${fixedMediaKind ? '生图模型' : '媒体模型'}已被其他窗口删除，请关闭草稿后重新打开或刷新目录。`)
        return
      }
      if (stableMediaApiModelStringify(currentTarget) !== editBaseline.fingerprint) {
        setActionError(`该${fixedMediaKind ? '生图模型' : '媒体模型'}已被其他窗口修改，请关闭草稿后重新打开或刷新目录。`)
        return
      }
    } else if (profiles.some((profile) => profile.id === draft.id)) {
      setActionError('模型 ID 已被其他窗口占用，请重新新增或复制。')
      return
    }
    /** 去除用户可编辑文本两端空白后的配置。 */
    const normalized = parseMediaApiModelProfile({
      ...draft,
      name: draft.name.trim(),
      channelId: draft.channelId.trim(),
      modelId: draft.modelId.trim(),
      updatedAt: Date.now(),
    })
    /** 用稳定 ID 替换或追加后的可见目录。 */
    const nextVisibleProfiles = existing
      ? visibleProfiles.map((profile) => profile.id === normalized.id ? normalized : profile)
      : [...visibleProfiles, normalized]
    if (await saveVisibleProfiles(nextVisibleProfiles)) {
      setDraft(null)
      setEditBaseline(null)
      setActionError(null)
    }
  }

  /** 从列表快捷切换启用状态，并通过现有完整目录 CAS 保存。 */
  const toggleEnabled = async (profile: MediaApiModelProfile, enabled: boolean): Promise<void> => {
    /** 以最新 props 中的同 ID 条目为开关基线，不使用点击前的旧对象。 */
    const currentProfile = visibleProfiles.find((item) => item.id === profile.id)
    if (saving || !currentProfile || currentProfile.enabled === enabled || (fixedMediaKind && currentProfile.mediaKind !== fixedMediaKind)) return
    /** 只替换目标稳定 ID，保留其它可见模型及其顺序。 */
    const nextVisibleProfiles = setMediaApiModelEnabled(visibleProfiles, currentProfile.id, enabled, Date.now())
    await saveVisibleProfiles(nextVisibleProfiles)
  }

  /** 删除入口只接受当前可见条目。 */
  const requestDelete = (profileId: string): void => {
    const profile = visibleProfiles.find((item) => item.id === profileId)
    if (!profile) return
    setDeleteId(profileId)
    setDeleteBaseline({ id: profile.id, fingerprint: stableMediaApiModelStringify(profile) })
    setActionError(null)
  }

  /** 确认删除后从可见子集移除，并合并最新完整目录。 */
  const confirmDelete = async (): Promise<void> => {
    if (!deleteId || !deleteBaseline || saving) return
    const currentTarget = profiles.find((profile) => profile.id === deleteBaseline.id)
    if (!currentTarget) {
      setActionError(`该${fixedMediaKind ? '生图模型' : '媒体模型'}已被其他窗口删除，请关闭确认后重新打开或刷新目录。`)
      return
    }
    if (stableMediaApiModelStringify(currentTarget) !== deleteBaseline.fingerprint) {
      setActionError(`该${fixedMediaKind ? '生图模型' : '媒体模型'}已被其他窗口修改，请关闭确认后重新打开或刷新目录。`)
      return
    }
    const nextVisibleProfiles = visibleProfiles.filter((profile) => profile.id !== deleteId)
    if (await saveVisibleProfiles(nextVisibleProfiles)) {
      setDeleteId(null)
      setDeleteBaseline(null)
      setActionError(null)
    }
  }

  /** 关闭草稿时同时释放目标基线和冲突提示。 */
  const closeDraft = (): void => {
    setDraft(null)
    setEditBaseline(null)
    setActionError(null)
  }

  /** 关闭删除确认时同时释放目标基线和冲突提示。 */
  const closeDelete = (): void => {
    setDeleteId(null)
    setDeleteBaseline(null)
    setActionError(null)
  }

  return {
    profiles,
    visibleProfiles,
    draft,
    deleteId,
    existing,
    draftError,
    actionError,
    startCreate,
    startEdit,
    startCopy,
    updateDraft,
    closeDraft,
    saveDraft,
    toggleEnabled,
    requestDelete,
    closeDelete,
    confirmDelete,
  }
}

/** 图片、音频和视频 API 模型的已保存目录与单条编辑器。 */
export function MediaApiModelCatalogView({
  entries,
  channelOptions,
  saving,
  loading = false,
  onSaveProfiles,
  navigation,
  headerContent,
  children,
  fixedMediaKind,
}: MediaApiModelCatalogViewProps): React.ReactElement {
  /** 列表本地搜索词，不影响持久化目录。 */
  const [query, setQuery] = React.useState('')
  /** 列表本地媒体类型筛选。 */
  const [mediaKindFilter, setMediaKindFilter] = React.useState<MediaApiModelKind | 'all'>('all')
  /** 生产 controller 提供真实增删改复制与保存路径。 */
  const controller = useMediaApiModelCatalogController({ entries, channelOptions, saving, fixedMediaKind, onSaveProfiles })
  const { draft, deleteId, existing, draftError, actionError } = controller
  /** fixed 模式在搜索前排除旧音频和视频目录。 */
  const visibleEntries = fixedMediaKind
    ? entries.filter((entry) => entry.profile.mediaKind === fixedMediaKind)
    : entries
  /** 应用本地搜索和媒体类型筛选后的目录条目。 */
  const filteredEntries = filterMediaApiModelEntries(visibleEntries, channelOptions, query, fixedMediaKind ?? mediaKindFilter)
  /** 当前协议允许的能力。 */
  const protocolCapabilities = draft
    ? MEDIA_API_MODEL_PROTOCOLS.find((item) => item.protocol === draft.protocol)?.capabilities ?? []
    : []
  /** OpenAI Images 当前渠道提供的真实模型。 */
  const channelModels = draft?.protocol === 'openai-images'
    ? channelOptions.find((item) => item.channelId === draft.channelId)?.models ?? []
    : []
  /** fixed 生图页使用专属文案，非 fixed 调用方保留统一媒体目录文案。 */
  const copy = getMediaApiModelCopy(fixedMediaKind)
  /** 当前列表或编辑状态对应的页面标题。 */
  const pageTitle = draft
    ? existing
      ? copy.editTitle
      : copy.addTitle
    : copy.title

  /** 切换能力勾选状态。 */
  const toggleCapability = (capability: MediaApiModelCapability, checked: boolean): void => {
    if (!draft) return
    /** 更新后仍保持协议声明顺序的能力列表。 */
    const capabilities = protocolCapabilities.filter((item) => item === capability ? checked : draft.capabilities.includes(item))
    controller.updateDraft({ ...draft, capabilities })
  }

  return (
    <MediaSettingsPage
      title={pageTitle}
      onBack={draft ? controller.closeDraft : undefined}
      busy={saving}
      headerContent={headerContent}
      action={
        <Button type="button" size="sm" disabled={loading || saving || draft !== null} onClick={controller.startCreate}>
          <Plus size={16} />
          <span>{fixedMediaKind ? copy.addTitle : '添加 API 模型'}</span>
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
            {!fixedMediaKind && <Select value={mediaKindFilter} disabled={saving} onValueChange={(value: MediaApiModelKind | 'all') => setMediaKindFilter(value)}>
              <SelectTrigger className="w-32" aria-label="筛选媒体类型"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">全部类型</SelectItem>{(['image', 'audio', 'video'] as const).map((kind) => <SelectItem key={kind} value={kind}>{MEDIA_KIND_LABELS[kind]}</SelectItem>)}</SelectContent>
            </Select>}
          </div>
        )}
      </div>}
      {children}
      {actionError && !deleteId && <p role="alert" className="mb-3 text-xs text-destructive">{actionError}</p>}
      <SettingsCard divided>
        {loading ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />{copy.loading}</div>
        ) : draft ? (
          <div className="space-y-4 p-4">
            {draftError && <p role="alert" className="text-xs text-destructive">{draftError}</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs font-medium">名称<Input value={draft.name} disabled={saving} onChange={(event) => controller.updateDraft({ ...draft, name: event.target.value })} /></label>
              {!fixedMediaKind && <label className="space-y-1 text-xs font-medium">媒体类型<Select value={draft.mediaKind} disabled={saving} onValueChange={(mediaKind: MediaApiModelKind) => controller.updateDraft(changeMediaApiModelKind(draft, mediaKind))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(['image', 'audio', 'video'] as const).map((kind) => <SelectItem key={kind} value={kind}>{MEDIA_KIND_LABELS[kind]}</SelectItem>)}</SelectContent></Select></label>}
              <label className="space-y-1 text-xs font-medium">协议<Select value={draft.protocol} disabled={saving} onValueChange={(protocol: MediaApiModelProtocol) => controller.updateDraft(changeMediaApiModelProtocol(draft, protocol))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{MEDIA_API_MODEL_PROTOCOLS.filter((item) => item.mediaKind === draft.mediaKind).map((item) => <SelectItem key={item.protocol} value={item.protocol}>{PROTOCOL_LABELS[item.protocol]}</SelectItem>)}</SelectContent></Select></label>
              <label className="space-y-1 text-xs font-medium">模型配置<Select value={draft.channelId || undefined} disabled={saving} onValueChange={(channelId) => controller.updateDraft({ ...draft, channelId, ...(draft.protocol === 'openai-images' ? { modelId: '' } : {}) })}><SelectTrigger><SelectValue placeholder="选择凭据所属配置" /></SelectTrigger><SelectContent>{channelOptions.map((channel) => <SelectItem key={channel.channelId} value={channel.channelId}>{channel.name}</SelectItem>)}</SelectContent></Select></label>
              {draft.protocol === 'openai-images' ? <label className="space-y-1 text-xs font-medium">模型<Select value={draft.modelId || undefined} disabled={saving || !draft.channelId} onValueChange={(modelId) => controller.updateDraft({ ...draft, modelId })}><SelectTrigger><SelectValue placeholder="选择图片模型" /></SelectTrigger><SelectContent>{channelModels.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent></Select></label> : <label className="space-y-1 text-xs font-medium">模型 ID<Input value={draft.modelId} disabled={saving} onChange={(event) => controller.updateDraft({ ...draft, modelId: event.target.value })} /></label>}
              <div className="space-y-2 text-xs font-medium"><span>能力</span><div className="flex flex-wrap gap-x-4 gap-y-2">{protocolCapabilities.map((capability) => <label key={capability} className="flex items-center gap-2 font-normal"><input type="checkbox" checked={draft.capabilities.includes(capability)} disabled={saving} onChange={(event) => toggleCapability(capability, event.target.checked)} />{CAPABILITY_LABELS[capability]}</label>)}</div></div>
              <label className="flex items-center gap-2 self-end pb-2 text-xs"><Switch checked={draft.enabled} disabled={saving} onCheckedChange={(enabled) => controller.updateDraft({ ...draft, enabled })} />启用模型</label>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-3"><Button type="button" size="sm" variant="outline" disabled={saving} onClick={controller.closeDraft}>取消</Button><Button type="button" size="sm" disabled={saving || draftError !== null} onClick={() => void controller.saveDraft()}>{saving ? <Loader2 className="animate-spin" /> : <Save />}保存模型</Button></div>
          </div>
        ) : (
          <>
            {filteredEntries.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">{visibleEntries.length === 0 ? copy.empty : copy.noMatches}</div>
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
                  <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"><Switch checked={profile.enabled} disabled={saving} aria-label={`${profile.enabled ? '停用' : '启用'} ${profile.name}`} onCheckedChange={(enabled) => void controller.toggleEnabled(profile, enabled)} />启用</label>
                  <div className="flex items-center gap-1"><Button type="button" size="icon-sm" variant="ghost" aria-label={`复制 ${profile.name}`} title="复制" disabled={saving} onClick={() => controller.startCopy(profile)}><Copy /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`编辑 ${profile.name}`} title="编辑" disabled={saving} onClick={() => controller.startEdit(profile)}><Pencil /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`删除 ${profile.name}`} title="删除" disabled={saving} onClick={() => controller.requestDelete(profile.id)}><Trash2 /></Button></div>
                </div>
              )
            })}
          </>
        )}
      </SettingsCard>
      <ConfirmDialog open={deleteId !== null} onOpenChange={(open) => { if (!open) controller.closeDelete() }} title={copy.deleteTitle} description={actionError ?? '删除后，引用该稳定模型 ID 的画布范围需要重新选择。'} confirmLabel="删除" loading={saving} variant="destructive" onConfirm={controller.confirmDelete} />
    </MediaSettingsPage>
  )
}

/** 从主进程统一目录加载并保存 API 媒体模型。 */
export function MediaApiModelSettings({ fixedMediaKind, navigation, headerContent, children }: MediaApiModelSettingsProps): React.ReactElement {
  /** fixed 与统一目录使用各自准确的读取、保存兜底文案。 */
  const copy = React.useMemo(() => getMediaApiModelCopy(fixedMediaKind), [fixedMediaKind])
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
      if (requestRevision === requestRevisionRef.current) {
        const message = loadError instanceof Error ? loadError.message : copy.loadError
        setError(formatMediaApiModelMessage(message, fixedMediaKind))
      }
    } finally {
      if (requestRevision === requestRevisionRef.current) setLoading(false)
    }
  }, [copy.loadError, fixedMediaKind])

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
      const message = saveError instanceof Error ? saveError.message : copy.saveError
      setError(formatMediaApiModelMessage(message, fixedMediaKind))
      return false
    } finally {
      setSaving(false)
    }
  }

  return (
    <MediaApiModelCatalogView fixedMediaKind={fixedMediaKind} entries={catalog?.entries ?? []} channelOptions={channelOptions} loading={loading && !catalog} saving={saving} onSaveProfiles={saveProfiles} navigation={navigation} headerContent={headerContent}>
      {children}
      {error && <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 border border-destructive/30 px-3 py-2 text-xs text-destructive"><span>{error}</span><Button type="button" size="sm" variant="outline" disabled={loading || saving} onClick={() => void load()}>重新加载</Button></div>}
    </MediaApiModelCatalogView>
  )
}
