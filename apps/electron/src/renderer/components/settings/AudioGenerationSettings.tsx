import * as React from 'react'
import type {
  AudioGenerationCredentialUpdate,
  AudioGenerationProfile,
  AudioGenerationProvider,
  AudioGenerationPublicProfile,
  AudioGenerationSettingsResult,
  AudioGenerationTestInput,
  AudioGenerationTestResult,
  ReplaceAudioGenerationCatalogRequest,
} from '@proma/shared'
import { AUDIO_GENERATION_PROVIDER_DESCRIPTORS, parseAudioGenerationProfile } from '@proma/shared'
import { Copy, Loader2, Pencil, Plus, Search, TestTube2, Trash2, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { MediaSettingsPage } from './MediaSettingsPage'
import { SettingsCard, SettingsRow } from './primitives'

/** 音频编辑草稿只在 Renderer 内短暂持有明文 API Key。 */
export type AudioGenerationDraft = AudioGenerationProfile & {
  apiKey: string
  credentialConfigured: boolean
}

/** 当前窗口中单条连接测试的展示状态。 */
export interface AudioGenerationTestViewState {
  requestId: string
  state: 'loading' | AudioGenerationTestResult['state']
  message: string
}

/** Controller 依赖的最小 IPC 边界，测试与真实 Electron 共用。 */
export interface AudioGenerationSettingsApi {
  getSettings: () => Promise<AudioGenerationSettingsResult>
  replaceCatalog: (request: ReplaceAudioGenerationCatalogRequest) => Promise<AudioGenerationSettingsResult>
  test: (input: AudioGenerationTestInput) => Promise<AudioGenerationTestResult>
  cancelTest: (requestId: string) => Promise<void>
}

/** 音频设置 Controller 的可注入参数。 */
export interface AudioGenerationControllerOptions {
  api: AudioGenerationSettingsApi
}

/** 音频配置视图与行为测试共用的生产 Controller。 */
export interface AudioGenerationController {
  settings: AudioGenerationSettingsResult | null
  loading: boolean
  saving: boolean
  loadError: string | null
  actionError: string | null
  query: string
  draft: AudioGenerationDraft | null
  deleteId: string | null
  testStates: Readonly<Record<string, AudioGenerationTestViewState>>
  visibleProfiles: AudioGenerationPublicProfile[]
  setQuery: (query: string) => void
  load: () => Promise<void>
  startCreate: () => void
  startEdit: (profile: AudioGenerationPublicProfile) => void
  startCopy: (profile: AudioGenerationPublicProfile) => void
  startMigration: (profileId: string) => void
  updateDraft: (draft: AudioGenerationDraft) => void
  closeDraft: () => void
  saveDraft: () => Promise<void>
  toggleEnabled: (profile: AudioGenerationPublicProfile, enabled: boolean) => Promise<void>
  requestDelete: (profileId: string) => void
  closeDelete: () => void
  confirmDelete: () => Promise<void>
  testProfile: (profile?: AudioGenerationPublicProfile) => Promise<void>
}

/** 音频配置页可复用的布局插槽。 */
interface AudioGenerationSettingsProps {
  navigation?: React.ReactNode
  headerContent?: React.ReactNode
  children?: React.ReactNode
}

/** 音频目录纯视图属性。 */
export interface AudioGenerationCatalogViewProps extends AudioGenerationSettingsProps {
  controller: AudioGenerationController
}

/** 各供应商的用户可见名称。 */
const PROVIDER_LABELS = Object.fromEntries(
  AUDIO_GENERATION_PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.provider, descriptor.label]),
) as Readonly<Record<AudioGenerationProvider, string>>

/** 测试状态的固定中文展示，不渲染异常正文。 */
const TEST_STATE_LABELS: Readonly<Record<AudioGenerationTestViewState['state'], string>> = {
  loading: '正在测试',
  success: '测试成功',
  failed: '测试失败',
  cancelled: '测试已取消',
  unavailable: '暂不可测试',
}

/** 去除空白后生成一次性凭据更新，已有配置允许保留密文。 */
export function createCredentialUpdate(apiKey: string, configured: boolean): AudioGenerationCredentialUpdate {
  /** 表单中本次显式输入的新凭据。 */
  const trimmed = apiKey.trim()
  if (trimmed) return { mode: 'replace', apiKey: trimmed }
  if (configured) return { mode: 'preserve' }
  throw new Error('请输入 API Key')
}

/** 切换供应商时清除所有不再可信的身份、凭据和迁移引用。 */
export function changeAudioGenerationProvider(
  draft: AudioGenerationDraft,
  provider: AudioGenerationProvider,
): AudioGenerationDraft {
  /** 切换后仍可复用的非身份字段。 */
  const common = {
    id: draft.id,
    name: draft.name,
    baseUrl: draft.baseUrl,
    enabled: draft.enabled,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    modelId: '',
    voiceId: '',
    apiKey: '',
    credentialConfigured: false,
  }
  return provider === 'minimax'
    ? { ...common, provider: 'minimax', groupId: '' }
    : { ...common, provider: 'xiaomi' }
}

/** 复制配置时保留可复用服务参数，但绝不继承凭据与旧目录引用。 */
export function copyAudioGenerationProfile(
  profile: AudioGenerationPublicProfile | AudioGenerationDraft,
  id: string,
  now: number,
): AudioGenerationDraft {
  /** 公共且不含秘密的复制字段。 */
  const common = {
    id,
    name: `${profile.name} 副本`,
    baseUrl: profile.baseUrl,
    modelId: profile.modelId,
    voiceId: profile.voiceId,
    enabled: profile.enabled,
    createdAt: now,
    updatedAt: now,
    apiKey: '',
    credentialConfigured: false,
  }
  return profile.provider === 'minimax'
    ? { ...common, provider: 'minimax', ...(profile.groupId !== undefined ? { groupId: profile.groupId } : {}) }
    : { ...common, provider: 'xiaomi' }
}

/** 列表只搜索明确公开的展示字段，不读取完整服务 URL。 */
export function filterAudioGenerationProfiles(
  profiles: readonly AudioGenerationPublicProfile[],
  query: string,
): AudioGenerationPublicProfile[] {
  /** 统一大小写后的搜索词。 */
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return [...profiles]
  return profiles.filter((profile) => [
    profile.name,
    profile.provider,
    PROVIDER_LABELS[profile.provider],
    profile.modelId,
    profile.voiceId,
    profile.endpointOrigin,
  ].join('\n').toLocaleLowerCase().includes(normalized))
}

/** 将公开配置转换为不回填明文凭据的编辑草稿。 */
function profileToDraft(profile: AudioGenerationPublicProfile): AudioGenerationDraft {
  /** Renderer 只复制持久化公开字段，endpointOrigin 仅属于列表摘要。 */
  const common = {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    modelId: profile.modelId,
    voiceId: profile.voiceId,
    enabled: profile.enabled,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    ...(profile.legacyMediaProfileId ? { legacyMediaProfileId: profile.legacyMediaProfileId } : {}),
    apiKey: '',
    credentialConfigured: profile.credentialConfigured,
  }
  return profile.provider === 'minimax'
    ? { ...common, provider: 'minimax', ...(profile.groupId !== undefined ? { groupId: profile.groupId } : {}) }
    : { ...common, provider: 'xiaomi' }
}

/** 将草稿收敛为 shared 严格配置，确保小米不会提交 Group ID。 */
function draftToProfile(draft: AudioGenerationDraft, now: number): AudioGenerationProfile {
  /** 判别联合确保只提交当前供应商允许的字段。 */
  const candidate: AudioGenerationProfile = draft.provider === 'minimax'
    ? {
        id: draft.id, name: draft.name, provider: 'minimax', baseUrl: draft.baseUrl,
        modelId: draft.modelId, voiceId: draft.voiceId, enabled: draft.enabled,
        createdAt: draft.createdAt, updatedAt: now,
        ...(draft.groupId?.trim() ? { groupId: draft.groupId.trim() } : {}),
        ...(draft.legacyMediaProfileId ? { legacyMediaProfileId: draft.legacyMediaProfileId } : {}),
      }
    : {
        id: draft.id, name: draft.name, provider: 'xiaomi', baseUrl: draft.baseUrl,
        modelId: draft.modelId, voiceId: draft.voiceId, enabled: draft.enabled,
        createdAt: draft.createdAt, updatedAt: now,
        ...(draft.legacyMediaProfileId ? { legacyMediaProfileId: draft.legacyMediaProfileId } : {}),
      }
  return parseAudioGenerationProfile(candidate)
}

/** 对公开身份字段生成稳定指纹，用于检测外部修改与测试身份变化。 */
function profileIdentity(profile: AudioGenerationProfile): string {
  return JSON.stringify([
    profile.provider,
    profile.baseUrl.trim(),
    profile.modelId.trim(),
    profile.voiceId.trim(),
    profile.provider === 'minimax' ? profile.groupId?.trim() ?? '' : '',
  ])
}

/** 对完整公开配置生成稳定指纹，防止编辑和删除覆盖外部修改。 */
function profileFingerprint(profile: AudioGenerationProfile): string {
  return JSON.stringify(profile)
}

/** 主进程错误只按稳定错误码翻译，原异常正文不进入界面。 */
function formatAudioGenerationError(error: unknown): string {
  /** Electron IPC 拒绝后的稳定错误码。 */
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('AUDIO_GENERATION_CONFIG_CONFLICT')) return '音频配置已被其他窗口更新，已重新加载，请重新应用本次修改。'
  if (message.includes('AUDIO_GENERATION_CONFIG_OUTCOME_UNKNOWN')) return '音频配置写入结果未知，已重新加载，请核对后重新应用。'
  return '音频配置操作失败，请重试。'
}

/** 创建安全稳定 ID。 */
function createAudioGenerationId(): string {
  return `audio-${globalThis.crypto.randomUUID()}`
}

/** 独立音频配置的完整状态与动作 Controller。 */
export function useAudioGenerationSettingsController({ api }: AudioGenerationControllerOptions): AudioGenerationController {
  const [settings, setSettings] = React.useState<AudioGenerationSettingsResult | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const [draft, setDraft] = React.useState<AudioGenerationDraft | null>(null)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)
  const [testStates, setTestStates] = React.useState<Record<string, AudioGenerationTestViewState>>({})
  /** 编辑与删除打开时的目标快照，用于阻止跨窗口覆盖。 */
  const editBaselineRef = React.useRef<{ id: string; fingerprint: string; identity: string } | null>(null)
  const deleteBaselineRef = React.useRef<{ id: string; fingerprint: string } | null>(null)
  /** 每个草稿/配置当前在途测试的 requestId。 */
  const activeTestsRef = React.useRef(new Map<string, string>())
  /** 加载代次与挂载状态共同阻止卸载后 setState。 */
  const loadRevisionRef = React.useRef(0)
  const mountedRef = React.useRef(true)

  /** 取消指定 identity 的旧测试，并清理当前窗口展示。 */
  const cancelIdentityTest = React.useCallback((identity: string): void => {
    const requestId = activeTestsRef.current.get(identity)
    if (!requestId) return
    activeTestsRef.current.delete(identity)
    void api.cancelTest(requestId).catch(() => undefined)
    if (mountedRef.current) setTestStates((current) => {
      /** 删除旧测试状态，避免身份改变后沿用旧成功结论。 */
      const next = { ...current }
      delete next[identity]
      return next
    })
  }, [api])

  /** 从主进程读取权威目录，迟到结果与卸载均无副作用。 */
  const load = React.useCallback(async (): Promise<void> => {
    const revision = loadRevisionRef.current + 1
    loadRevisionRef.current = revision
    setLoading(true)
    setLoadError(null)
    try {
      const next = await api.getSettings()
      if (!mountedRef.current || revision !== loadRevisionRef.current) return
      setSettings(next)
    } catch {
      if (mountedRef.current && revision === loadRevisionRef.current) setLoadError('音频配置读取失败，请重试。')
    } finally {
      if (mountedRef.current && revision === loadRevisionRef.current) setLoading(false)
    }
  }, [api])

  React.useEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
      loadRevisionRef.current += 1
      for (const requestId of activeTestsRef.current.values()) void api.cancelTest(requestId).catch(() => undefined)
      activeTestsRef.current.clear()
    }
  }, [api, load])

  /** 清除明文草稿并返回列表。 */
  const closeDraft = React.useCallback((): void => {
    if (draft) cancelIdentityTest(draft.id)
    setDraft(null)
    editBaselineRef.current = null
    setActionError(null)
  }, [cancelIdentityTest, draft])

  /** 用完整目录执行一次 CAS，并接管返回的权威结果。 */
  const replace = React.useCallback(async (request: ReplaceAudioGenerationCatalogRequest): Promise<boolean> => {
    if (saving) return false
    setSaving(true)
    setActionError(null)
    try {
      const next = await api.replaceCatalog(request)
      loadRevisionRef.current += 1
      if (mountedRef.current) setSettings(next)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('AUDIO_GENERATION_CONFIG_CONFLICT') || message.includes('AUDIO_GENERATION_CONFIG_OUTCOME_UNKNOWN')) {
        loadRevisionRef.current += 1
        try {
          const authoritative = await api.getSettings()
          if (mountedRef.current) setSettings(authoritative)
        } catch {
          // 原始写入状态不明确时仍保留稳定提示，不追加新的异常正文。
        }
      }
      if (mountedRef.current) setActionError(formatAudioGenerationError(error))
      return false
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [api, saving])

  /** 为未修改条目构造 preserve 更新。 */
  const preserveEntries = React.useCallback((profiles: readonly AudioGenerationPublicProfile[]): ReplaceAudioGenerationCatalogRequest['profiles'] => profiles.map((profile) => ({
    profile: draftToProfile(profileToDraft(profile), profile.updatedAt),
    credentialUpdate: { mode: 'preserve' },
  })), [])

  /** 打开空的小米配置草稿。 */
  const startCreate = React.useCallback((): void => {
    if (draft) cancelIdentityTest(draft.id)
    const now = Date.now()
    editBaselineRef.current = null
    setActionError(null)
    setDraft({ id: createAudioGenerationId(), name: '', provider: 'xiaomi', baseUrl: '', modelId: '', voiceId: '', enabled: true, createdAt: now, updatedAt: now, apiKey: '', credentialConfigured: false })
  }, [cancelIdentityTest, draft])

  /** 编辑已保存配置但不读取旧 Key。 */
  const startEdit = React.useCallback((profile: AudioGenerationPublicProfile): void => {
    if (draft) cancelIdentityTest(draft.id)
    editBaselineRef.current = { id: profile.id, fingerprint: profileFingerprint(profile), identity: profileIdentity(profile) }
    setActionError(null)
    setDraft(profileToDraft(profile))
  }, [cancelIdentityTest, draft])

  /** 复制时生成新 ID 并强制重新填写 Key。 */
  const startCopy = React.useCallback((profile: AudioGenerationPublicProfile): void => {
    if (draft) cancelIdentityTest(draft.id)
    editBaselineRef.current = null
    setActionError(null)
    setDraft(copyAudioGenerationProfile(profile, createAudioGenerationId(), Date.now()))
  }, [cancelIdentityTest, draft])

  /** 从旧 MiniMax 摘要创建非破坏迁移草稿。 */
  const startMigration = React.useCallback((profileId: string): void => {
    const legacy = settings?.legacyAudioProfiles.find((profile) => profile.id === profileId)
    if (!legacy) return
    if (draft) cancelIdentityTest(draft.id)
    const now = Date.now()
    editBaselineRef.current = null
    setActionError(null)
    setDraft({
      id: createAudioGenerationId(), name: legacy.name, provider: 'minimax', baseUrl: '', modelId: legacy.modelId,
      voiceId: '', groupId: '', enabled: legacy.enabled, createdAt: now, updatedAt: now,
      legacyMediaProfileId: legacy.id, apiKey: '', credentialConfigured: false,
    })
  }, [cancelIdentityTest, draft, settings])

  /** 更新草稿；身份变化立即使旧测试失效。 */
  const updateDraft = React.useCallback((next: AudioGenerationDraft): void => {
    if (draft && profileIdentity(draft) !== profileIdentity(next)) cancelIdentityTest(draft.id)
    setDraft(next)
    setActionError(null)
  }, [cancelIdentityTest, draft])

  /** 保存新增、复制、迁移或编辑草稿。 */
  const saveDraft = React.useCallback(async (): Promise<void> => {
    if (!settings || !draft || saving) return
    try {
      const existingIndex = settings.catalog.profiles.findIndex((profile) => profile.id === draft.id)
      const baseline = editBaselineRef.current
      if (baseline) {
        const current = settings.catalog.profiles.find((profile) => profile.id === baseline.id)
        if (!current) { setActionError('目标已被其他窗口删除，请返回列表后重新打开。'); return }
        if (profileFingerprint(current) !== baseline.fingerprint) { setActionError('目标已被其他窗口修改，请返回列表后重新打开。'); return }
      } else if (existingIndex >= 0) {
        setActionError('配置 ID 已被其他窗口占用，请重新添加。')
        return
      }
      const profile = draftToProfile(draft, Date.now())
      const entries = preserveEntries(settings.catalog.profiles)
      const credentialUpdate = createCredentialUpdate(draft.apiKey, draft.credentialConfigured)
      if (existingIndex >= 0) entries[existingIndex] = { profile, credentialUpdate }
      else entries.push({ profile, credentialUpdate })
      const saved = await replace({ expectedRevision: settings.catalog.revision, profiles: entries })
      if (saved && mountedRef.current) {
        cancelIdentityTest(draft.id)
        setDraft(null)
        editBaselineRef.current = null
      }
    } catch (error) {
      /** API Key 必填提示可直接操作，其它 schema 错误统一转为稳定表单文案。 */
      const message = error instanceof Error && error.message === '请输入 API Key'
        ? error.message
        : '请完整填写有效的名称、服务地址、模型 ID 和音色 ID。'
      if (mountedRef.current) setActionError(message)
    }
  }, [cancelIdentityTest, draft, preserveEntries, replace, saving, settings])

  /** 快捷启停仍完整替换目录，所有凭据保持不变。 */
  const toggleEnabled = React.useCallback(async (profile: AudioGenerationPublicProfile, enabled: boolean): Promise<void> => {
    if (!settings || saving) return
    const entries = preserveEntries(settings.catalog.profiles)
    const index = settings.catalog.profiles.findIndex((item) => item.id === profile.id)
    if (index < 0 || profileFingerprint(settings.catalog.profiles[index]!) !== profileFingerprint(profile)) {
      setActionError('目标已被其他窗口修改，请重新加载后操作。')
      return
    }
    entries[index] = { profile: { ...entries[index]!.profile, enabled, updatedAt: Date.now() }, credentialUpdate: { mode: 'preserve' } }
    await replace({ expectedRevision: settings.catalog.revision, profiles: entries })
  }, [preserveEntries, replace, saving, settings])

  /** 打开受控删除确认并记录目标快照。 */
  const requestDelete = React.useCallback((profileId: string): void => {
    const profile = settings?.catalog.profiles.find((item) => item.id === profileId)
    if (!profile) return
    cancelIdentityTest(profileId)
    deleteBaselineRef.current = { id: profileId, fingerprint: profileFingerprint(profile) }
    setActionError(null)
    setDeleteId(profileId)
  }, [cancelIdentityTest, settings])

  /** 关闭删除确认并清理局部错误。 */
  const closeDelete = React.useCallback((): void => {
    if (saving) return
    setDeleteId(null)
    deleteBaselineRef.current = null
    setActionError(null)
  }, [saving])

  /** 删除目标成功后才关闭确认框，失败保留错误供用户重试。 */
  const confirmDelete = React.useCallback(async (): Promise<void> => {
    if (!settings || !deleteId || saving) return
    const baseline = deleteBaselineRef.current
    const current = settings.catalog.profiles.find((profile) => profile.id === deleteId)
    if (!current) { setActionError('目标已被其他窗口删除，请重新加载。'); return }
    if (!baseline || profileFingerprint(current) !== baseline.fingerprint) { setActionError('目标已被其他窗口修改，请重新加载。'); return }
    const entries = preserveEntries(settings.catalog.profiles.filter((profile) => profile.id !== deleteId))
    const deleted = await replace({ expectedRevision: settings.catalog.revision, profiles: entries })
    if (deleted && mountedRef.current) {
      setDeleteId(null)
      deleteBaselineRef.current = null
    }
  }, [deleteId, preserveEntries, replace, saving, settings])

  /** 测试当前草稿或已保存配置，并按 identity 取消上一请求。 */
  const testProfile = React.useCallback(async (profile?: AudioGenerationPublicProfile): Promise<void> => {
    const targetDraft = profile ? null : draft
    const identity = profile?.id ?? targetDraft?.id
    if (!identity) return
    const oldRequestId = activeTestsRef.current.get(identity)
    if (oldRequestId) {
      try { await api.cancelTest(oldRequestId) } catch { /* 仍以新 requestId 取代旧请求。 */ }
    }
    let input: AudioGenerationTestInput
    const requestId = globalThis.crypto.randomUUID()
    try {
      if (profile) {
        input = { kind: 'saved', profileId: profile.id, requestId }
      } else if (targetDraft) {
        const apiKey = targetDraft.apiKey.trim()
        const baseline = editBaselineRef.current
        if (apiKey) input = { kind: 'draft', requestId, profile: draftToProfile(targetDraft, Date.now()), apiKey }
        else if (baseline && baseline.identity === profileIdentity(targetDraft) && targetDraft.credentialConfigured) {
          input = { kind: 'saved', profileId: targetDraft.id, requestId }
        } else {
          setActionError('当前服务身份已修改，请重新填写 API Key 后测试。')
          return
        }
      } else return
    } catch {
      setActionError('请先完整填写音频配置后再测试。')
      return
    }
    activeTestsRef.current.set(identity, requestId)
    setTestStates((current) => ({ ...current, [identity]: { requestId, state: 'loading', message: TEST_STATE_LABELS.loading } }))
    try {
      const result = await api.test(input)
      if (!mountedRef.current || activeTestsRef.current.get(identity) !== result.requestId) return
      activeTestsRef.current.delete(identity)
      setTestStates((current) => ({ ...current, [identity]: { requestId: result.requestId, state: result.state, message: TEST_STATE_LABELS[result.state] } }))
    } catch {
      if (!mountedRef.current || activeTestsRef.current.get(identity) !== requestId) return
      activeTestsRef.current.delete(identity)
      setTestStates((current) => ({ ...current, [identity]: { requestId, state: 'failed', message: TEST_STATE_LABELS.failed } }))
    }
  }, [api, draft])

  return {
    settings, loading, saving, loadError, actionError, query, draft, deleteId, testStates,
    visibleProfiles: filterAudioGenerationProfiles(settings?.catalog.profiles ?? [], query),
    setQuery, load, startCreate, startEdit, startCopy, startMigration, updateDraft, closeDraft, saveDraft,
    toggleEnabled, requestDelete, closeDelete, confirmDelete, testProfile,
  }
}

/** 紧凑表单字段，确保 label 与原生控件稳定关联。 */
function FormField({ id, label, children }: { id: string; label: string; children: React.ReactNode }): React.ReactElement {
  return <div className="space-y-1.5"><label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>{children}</div>
}

/** 音频目录、动态表单与旧配置迁移的纯视图。 */
export function AudioGenerationCatalogView({ controller, navigation, headerContent, children }: AudioGenerationCatalogViewProps): React.ReactElement {
  const { settings, loading, saving, loadError, actionError, query, draft, deleteId, visibleProfiles, testStates } = controller
  const legacyReferences = new Set(settings?.catalog.profiles.map((profile) => profile.legacyMediaProfileId).filter((id): id is string => Boolean(id)) ?? [])
  const deleteTarget = settings?.catalog.profiles.find((profile) => profile.id === deleteId)

  if (draft) {
    const testState = testStates[draft.id]
    return (
      <MediaSettingsPage title={editTitle(draft, settings)} onBack={controller.closeDraft} busy={saving} headerContent={headerContent}>
        <SettingsCard divided={false} className="p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="audio-name" label="名称"><Input id="audio-name" value={draft.name} disabled={saving} onChange={(event) => controller.updateDraft({ ...draft, name: event.target.value })} /></FormField>
            <FormField id="audio-provider" label="供应商"><Select value={draft.provider} disabled={saving} onValueChange={(provider: AudioGenerationProvider) => controller.updateDraft(changeAudioGenerationProvider(draft, provider))}><SelectTrigger id="audio-provider" aria-label="供应商"><SelectValue /></SelectTrigger><SelectContent>{AUDIO_GENERATION_PROVIDER_DESCRIPTORS.map((descriptor) => <SelectItem key={descriptor.provider} value={descriptor.provider}>{descriptor.label}</SelectItem>)}</SelectContent></Select></FormField>
            <FormField id="audio-base-url" label="服务地址"><Input id="audio-base-url" value={draft.baseUrl} disabled={saving} placeholder="https://..." onChange={(event) => controller.updateDraft({ ...draft, baseUrl: event.target.value })} /></FormField>
            <FormField id="audio-api-key" label="API Key"><Input id="audio-api-key" type="password" autoComplete="new-password" value={draft.apiKey} disabled={saving} placeholder={draft.credentialConfigured ? '留空以保留已保存凭据' : '请输入 API Key'} onChange={(event) => controller.updateDraft({ ...draft, apiKey: event.target.value })} /></FormField>
            <FormField id="audio-model-id" label="模型 ID"><Input id="audio-model-id" value={draft.modelId} disabled={saving} onChange={(event) => controller.updateDraft({ ...draft, modelId: event.target.value })} /></FormField>
            <FormField id="audio-voice-id" label="音色 ID"><Input id="audio-voice-id" value={draft.voiceId} disabled={saving} onChange={(event) => controller.updateDraft({ ...draft, voiceId: event.target.value })} /></FormField>
            {draft.provider === 'minimax' && <FormField id="audio-group-id" label="Group ID（可选）"><Input id="audio-group-id" value={draft.groupId ?? ''} disabled={saving} onChange={(event) => controller.updateDraft({ ...draft, groupId: event.target.value })} /></FormField>}
            <label className="flex items-center gap-2 self-end text-sm text-muted-foreground"><Switch checked={draft.enabled} disabled={saving} aria-label="启用音频配置" onCheckedChange={(enabled) => controller.updateDraft({ ...draft, enabled })} />启用</label>
          </div>
          {actionError && <p role="alert" className="mt-4 text-sm text-destructive">{actionError}</p>}
          {testState && <p className="mt-4 text-xs text-muted-foreground" role="status">{testState.message}</p>}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => void controller.testProfile()}>{testState?.state === 'loading' ? <Loader2 className="animate-spin" /> : <TestTube2 />}测试连接</Button>
            <Button type="button" variant="outline" disabled={saving} onClick={controller.closeDraft}>取消</Button>
            <Button type="button" disabled={saving} onClick={() => void controller.saveDraft()}>{saving ? <Loader2 className="animate-spin" /> : null}保存</Button>
          </div>
        </SettingsCard>
      </MediaSettingsPage>
    )
  }

  return (
    <MediaSettingsPage title="音频生成" action={<Button type="button" size="sm" disabled={loading || saving} onClick={controller.startCreate}><Plus />添加音频配置</Button>} headerContent={headerContent}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        {navigation}
        <div className="relative w-64 max-w-full"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" aria-label="搜索音频配置" placeholder="搜索名称、供应商、模型或音色" value={query} onChange={(event) => controller.setQuery(event.target.value)} /></div>
      </div>
      {children}
      {loadError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border border-destructive/30 px-3 py-2 text-xs text-destructive"><span>{loadError}</span><Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void controller.load()}>重新加载</Button></div>}
      {actionError && !deleteId && <p role="alert" className="border border-destructive/30 px-3 py-2 text-xs text-destructive">{actionError}</p>}
      {settings?.legacyWarning && <p className="border border-border/60 px-3 py-2 text-xs text-muted-foreground">{settings.legacyWarning}</p>}
      {settings && settings.legacyAudioProfiles.length > 0 && <SettingsCard>
        {settings.legacyAudioProfiles.map((legacy) => {
          const migrated = legacyReferences.has(legacy.id)
          return <SettingsRow key={legacy.id} label={legacy.name} description={`旧配置，需要重新填写独立凭据 · ${legacy.modelId}`}><Button type="button" size="sm" variant="outline" disabled={saving || migrated} onClick={() => controller.startMigration(legacy.id)}>{migrated ? '已迁移' : `迁移 ${legacy.name}`}</Button></SettingsRow>
        })}
      </SettingsCard>}
      {loading && !settings ? <SettingsCard divided={false}><div className="px-4 py-8 text-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />正在读取音频配置...</div></SettingsCard>
        : settings && settings.catalog.profiles.length === 0 ? <SettingsCard divided={false}><div className="px-4 py-8 text-center text-sm text-muted-foreground">尚未配置音频生成服务</div></SettingsCard>
          : settings && visibleProfiles.length === 0 ? <SettingsCard divided={false}><div className="px-4 py-8 text-center text-sm text-muted-foreground">没有匹配的音频配置</div></SettingsCard>
            : <SettingsCard>{visibleProfiles.map((profile) => {
                const testState = testStates[profile.id]
                return <SettingsRow key={profile.id} label={profile.name} icon={<Volume2 className="size-5 text-muted-foreground" />} description={<><span>{PROVIDER_LABELS[profile.provider]} · {profile.modelId} · {profile.voiceId}</span><span className="block">{profile.endpointOrigin} · {profile.credentialConfigured ? '凭据已配置' : '缺少凭据'}{testState ? ` · ${testState.message}` : ''}</span></>}><div className="flex flex-wrap items-center justify-end gap-1"><Switch checked={profile.enabled} disabled={saving} aria-label={`${profile.enabled ? '停用' : '启用'} ${profile.name}`} onCheckedChange={(enabled) => void controller.toggleEnabled(profile, enabled)} /><Button type="button" size="icon-sm" variant="ghost" aria-label={`测试 ${profile.name}`} title="测试连接" disabled={saving} onClick={() => void controller.testProfile(profile)}>{testState?.state === 'loading' ? <Loader2 className="animate-spin" /> : <TestTube2 />}</Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`复制 ${profile.name}`} title="复制" disabled={saving} onClick={() => controller.startCopy(profile)}><Copy /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`编辑 ${profile.name}`} title="编辑" disabled={saving} onClick={() => controller.startEdit(profile)}><Pencil /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`删除 ${profile.name}`} title="删除" disabled={saving} onClick={() => controller.requestDelete(profile.id)}><Trash2 /></Button></div></SettingsRow>
              })}</SettingsCard>}
      <ConfirmDialog open={deleteId !== null} onOpenChange={(open) => { if (!open) controller.closeDelete() }} title="删除音频配置？" description={actionError ?? (deleteTarget ? `删除 ${deleteTarget.name} 后，后续音频任务将不能再使用该配置。` : '')} confirmLabel="删除" closeOnConfirm={false} loading={saving} variant="destructive" onConfirm={controller.confirmDelete} />
    </MediaSettingsPage>
  )
}

/** 根据当前草稿来源显示准确的页面标题。 */
function editTitle(draft: AudioGenerationDraft, settings: AudioGenerationSettingsResult | null): string {
  return settings?.catalog.profiles.some((profile) => profile.id === draft.id) ? '编辑音频配置' : '添加音频配置'
}

/** 连接真实 Electron IPC 的独立音频配置页面。 */
export function AudioGenerationSettings(props: AudioGenerationSettingsProps): React.ReactElement {
  /** 稳定 IPC 适配器避免每次渲染触发重新加载。 */
  const api = React.useMemo<AudioGenerationSettingsApi>(() => ({
    getSettings: () => window.electronAPI.mediaGetAudioGenerationSettings(),
    replaceCatalog: (request) => window.electronAPI.mediaReplaceAudioGenerationCatalog(request),
    test: (input) => window.electronAPI.mediaTestAudioGeneration(input),
    cancelTest: (requestId) => window.electronAPI.mediaCancelAudioGenerationTest(requestId),
  }), [])
  const controller = useAudioGenerationSettingsController({ api })
  return <AudioGenerationCatalogView {...props} controller={controller} />
}
