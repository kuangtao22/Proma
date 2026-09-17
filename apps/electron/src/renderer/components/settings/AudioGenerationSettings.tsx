import * as React from 'react'
import type {
  AudioGenerationCatalogFetchInput,
  AudioGenerationCatalogFetchResult,
  AudioGenerationCredentialUpdate,
  AudioGenerationModelEntry,
  AudioGenerationProfile,
  AudioGenerationProvider,
  AudioGenerationPublicProfile,
  AudioGenerationSettingsResult,
  AudioGenerationTestInput,
  AudioGenerationTestResult,
  AudioGenerationVoice,
  ReplaceAudioGenerationCatalogRequest,
} from '@proma/shared'
import { AUDIO_GENERATION_PROVIDER_DEFAULTS, AUDIO_GENERATION_PROVIDER_DESCRIPTORS, parseAudioGenerationProfile } from '@proma/shared'
import { CheckCircle2, Copy, Download, Loader2, Pencil, Plus, Search, TestTube2, Trash2, Volume2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { MediaSettingsPage } from './MediaSettingsPage'
import { SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsToggle } from './primitives'

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
  catalogRevision: number
  profileFingerprint: string
  credentialGeneration: number
  testGeneration: number
}

/** 单条配置的本地测试代次，不包含 API Key 或其派生值。 */
/**
 * 供应商目录拉取的展示状态。
 * draftIdentity 记录结果所属草稿身份，草稿变化后旧结果不再展示。
 */
export interface AudioGenerationCatalogViewState {
  state: 'loading' | 'success' | 'failed'
  message?: string
  models: string[]
  voices: AudioGenerationVoice[]
  draftIdentity: string
}

/** 供应商模型决定 voice 字段语义，用于界面提示与列表可见性。 */
export type AudioVoiceCapability = 'voice-id' | 'voice-sample' | 'no-voice'

/**
 * 供应商目录拉取的归属身份。
 * 入参：当前草稿；返回值：稳定字符串。
 * 只包含供应商、服务地址、Group ID 与凭据来源，切换模型不应让已拉取的列表失效。
 */
export function catalogIdentity(draft: AudioGenerationDraft): string {
  return JSON.stringify([
    draft.provider,
    draft.baseUrl.trim(),
    draft.provider === 'minimax' ? draft.groupId?.trim() ?? '' : '',
    draft.id,
    draft.apiKey.trim() ? 'draft-key' : 'saved-key',
  ])
}

/**
 * 解析当前模型允许的音色输入方式。
 * 入参：供应商与模型 ID；返回值：音色能力。
 * 小米三个 TTS 模型的 voice 语义不同，界面必须据此提示而不是一律展示内置音色。
 */
export function resolveVoiceCapability(provider: AudioGenerationProvider, modelId: string): AudioVoiceCapability {
  if (provider !== 'xiaomi') return 'voice-id'
  if (modelId.trim() === 'mimo-v2.5-tts-voiceclone') return 'voice-sample'
  if (modelId.trim() === 'mimo-v2.5-tts-voicedesign') return 'no-voice'
  return 'voice-id'
}

/** 单条配置的本地测试代次，不包含 API Key 或其派生值。 */
interface AudioGenerationTestGeneration {
  testGeneration: number
  credentialGeneration: number
}

/** 等待取消或已发起测试的当前操作。 */
interface AudioGenerationActiveTest {
  testGeneration: number
  requestId?: string
}

/** 已离开 active 生命周期、但仍必须确认取消完成的请求。 */
interface AudioGenerationPendingCancellation {
  identity: string
  requestId: string
  status: 'cancelling' | 'failed'
  promise?: Promise<boolean>
}

/** Controller 依赖的最小 IPC 边界，测试与真实 Electron 共用。 */
export interface AudioGenerationSettingsApi {
  getSettings: () => Promise<AudioGenerationSettingsResult>
  replaceCatalog: (request: ReplaceAudioGenerationCatalogRequest) => Promise<AudioGenerationSettingsResult>
  test: (input: AudioGenerationTestInput) => Promise<AudioGenerationTestResult>
  cancelTest: (requestId: string) => Promise<void>
  fetchCatalog: (input: AudioGenerationCatalogFetchInput) => Promise<AudioGenerationCatalogFetchResult>
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
  needsReload: boolean
  generationEntryCount: number
  pendingCancellationCount: number
  loadError: string | null
  actionError: string | null
  query: string
  draft: AudioGenerationDraft | null
  deleteId: string | null
  testStates: Readonly<Record<string, AudioGenerationTestViewState>>
  catalog: AudioGenerationCatalogViewState | null
  visibleProfiles: AudioGenerationPublicProfile[]
  setQuery: (query: string) => void
  load: () => Promise<boolean>
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
  fetchCatalog: () => Promise<void>
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
  /** 新供应商的默认端与默认模型，避免用户面对空白地址。 */
  const defaults = AUDIO_GENERATION_PROVIDER_DEFAULTS[provider]
  /** 切换后仍可复用的非身份字段。 */
  const common = {
    id: draft.id,
    name: draft.name,
    baseUrl: defaults.baseUrl,
    enabled: draft.enabled,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    /** 切换供应商后保留一个默认模型条目，用户可再按需扩充。 */
    models: defaults.modelId ? [{ id: defaults.modelId, voices: [] }] : [],
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
    /** 复制配置保留模型与音色集合，但不继承凭据与旧目录引用。 */
    models: profile.models.map((model) => ({ ...model, voices: model.voices.map((voice) => ({ ...voice })) })),
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
    ...profile.models.flatMap((model) => [
      model.id,
      model.name ?? '',
      ...model.voices.flatMap((voice) => [voice.id, voice.name ?? '']),
    ]),
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
    models: profile.models.map((model) => ({ ...model, voices: model.voices.map((voice) => ({ ...voice })) })),
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
function draftToProfile(draft: AudioGenerationDraft): AudioGenerationProfile {
  /** 判别联合确保只提交当前供应商允许的字段。 */
  const candidate: AudioGenerationProfile = draft.provider === 'minimax'
    ? {
        id: draft.id, name: draft.name, provider: 'minimax', baseUrl: draft.baseUrl,
        models: draft.models, enabled: draft.enabled,
        createdAt: draft.createdAt, updatedAt: draft.updatedAt,
        ...(draft.groupId?.trim() ? { groupId: draft.groupId.trim() } : {}),
        ...(draft.legacyMediaProfileId ? { legacyMediaProfileId: draft.legacyMediaProfileId } : {}),
      }
    : {
        id: draft.id, name: draft.name, provider: 'xiaomi', baseUrl: draft.baseUrl,
        models: draft.models, enabled: draft.enabled,
        createdAt: draft.createdAt, updatedAt: draft.updatedAt,
        ...(draft.legacyMediaProfileId ? { legacyMediaProfileId: draft.legacyMediaProfileId } : {}),
      }
  return parseAudioGenerationProfile(candidate)
}

/** 对公开身份字段生成稳定指纹，用于检测外部修改与测试身份变化。 */
function profileIdentity(profile: AudioGenerationProfile): string {
  return JSON.stringify([
    profile.provider,
    profile.baseUrl.trim(),
    ...profile.models.map((model) => [
      model.id.trim(),
      model.name?.trim() ?? '',
      ...model.voices.map((voice) => [voice.id.trim(), voice.name?.trim() ?? '', voice.source]),
    ]),
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
  const [needsReload, setNeedsReload] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const [draft, setDraft] = React.useState<AudioGenerationDraft | null>(null)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)
  const [testStates, setTestStates] = React.useState<Record<string, AudioGenerationTestViewState>>({})
  /** 供应商目录拉取结果只属于当前草稿身份，草稿变化即失效。 */
  const [catalog, setCatalog] = React.useState<AudioGenerationCatalogViewState | null>(null)
  /** 最新展示状态只用于枚举需失效的 identity，不保存任何凭据。 */
  const testStatesRef = React.useRef<Record<string, AudioGenerationTestViewState>>({})
  testStatesRef.current = testStates
  /** 编辑与删除打开时的目标快照，用于阻止跨窗口覆盖。 */
  const editBaselineRef = React.useRef<{ id: string; fingerprint: string; identity: string } | null>(null)
  const deleteBaselineRef = React.useRef<{ id: string; fingerprint: string } | null>(null)
  /** 权威目录与草稿 ref 供 await 边界同步复核，避免旧闭包恢复请求。 */
  const settingsRef = React.useRef<AudioGenerationSettingsResult | null>(null)
  const draftRef = React.useRef<AudioGenerationDraft | null>(null)
  /** 每个 identity 的测试与凭据代次，只保存数字，不保存 Key 或 Key hash。 */
  const testGenerationsRef = React.useRef(new Map<string, AudioGenerationTestGeneration>())
  /** 每个 identity 正在等待取消或已发起的当前操作。 */
  const activeTestsRef = React.useRef(new Map<string, AudioGenerationActiveTest>())
  /** 已失效请求的取消所有权按 requestId 独立保留，失败后仍可重试。 */
  const pendingCancellationsRef = React.useRef(new Map<string, AudioGenerationPendingCancellation>())
  /** 组件生命周期内全局单调 token，Map 清理和同 ID 重开均不会复用旧值。 */
  const nextOperationTokenRef = React.useRef(0)
  /** 加载代次与挂载状态共同阻止卸载后 setState。 */
  const loadRevisionRef = React.useRef(0)
  const mountedRef = React.useRef(true)
  /** 写入结果未知后的同步门禁，避免 React 提交前仍使用旧 revision。 */
  const needsReloadRef = React.useRef(false)

  /** 读取指定 identity 的当前数字代次。 */
  const getTestGeneration = React.useCallback((identity: string): AudioGenerationTestGeneration => {
    return testGenerationsRef.current.get(identity) ?? { testGeneration: 0, credentialGeneration: 0 }
  }, [])

  /** 签发组件生命周期内唯一操作 token，并按需推进凭据代次。 */
  const issueOperationToken = React.useCallback((identity: string, credentialChanged = false): AudioGenerationTestGeneration => {
    const currentGeneration = getTestGeneration(identity)
    nextOperationTokenRef.current += 1
    const nextGeneration = {
      testGeneration: nextOperationTokenRef.current,
      credentialGeneration: currentGeneration.credentialGeneration + (credentialChanged ? 1 : 0),
    }
    testGenerationsRef.current.set(identity, nextGeneration)
    return nextGeneration
  }, [getTestGeneration])

  /** 同步发布完整测试状态快照，避免同一事件循环中的 ref 落后于 React 提交。 */
  const publishTestStates = React.useCallback((next: Record<string, AudioGenerationTestViewState>): void => {
    testStatesRef.current = next
    if (mountedRef.current) setTestStates(next)
  }, [])

  /** 清理已无活动、取消任务和展示状态的 identity 跟踪项。 */
  const cleanupIdentityTracking = React.useCallback((identity: string): void => {
    const hasPendingCancellation = [...pendingCancellationsRef.current.values()]
      .some((pending) => pending.identity === identity)
    if (!activeTestsRef.current.has(identity)
      && !hasPendingCancellation
      && !Object.hasOwn(testStatesRef.current, identity)) {
      testGenerationsRef.current.delete(identity)
    }
  }, [])

  /** 清除指定 identity 的展示状态，不触碰请求或凭据。 */
  const clearIdentityTestState = React.useCallback((identity: string): void => {
    if (!Object.hasOwn(testStatesRef.current, identity)) return
    const next = { ...testStatesRef.current }
    delete next[identity]
    publishTestStates(next)
  }, [publishTestStates])

  /** 执行或复用一次精确取消；失败时保留 requestId 供后续重试。 */
  const requestPendingCancellation = React.useCallback((requestId: string): Promise<boolean> => {
    const pending = pendingCancellationsRef.current.get(requestId)
    if (!pending) return Promise.resolve(true)
    if (pending.status === 'cancelling' && pending.promise) return pending.promise
    let cancellation: Promise<void>
    try {
      cancellation = api.cancelTest(requestId)
    } catch (error) {
      cancellation = Promise.reject(error)
    }
    const promise = cancellation
      .then(() => {
        const current = pendingCancellationsRef.current.get(requestId)
        if (current?.promise === promise) {
          pendingCancellationsRef.current.delete(requestId)
          cleanupIdentityTracking(current.identity)
        }
        return true
      }, () => {
        const current = pendingCancellationsRef.current.get(requestId)
        if (current?.promise === promise) {
          pendingCancellationsRef.current.set(requestId, {
            identity: current.identity,
            requestId,
            status: 'failed',
          })
        }
        return false
      })
    pendingCancellationsRef.current.set(requestId, {
      identity: pending.identity,
      requestId,
      status: 'cancelling',
      promise,
    })
    return promise
  }, [api, cleanupIdentityTracking])

  /** 将 active request 转交 pending cancellation，并立即开始安全取消。 */
  const queuePendingCancellation = React.useCallback((identity: string, requestId: string): void => {
    const existing = pendingCancellationsRef.current.get(requestId)
    if (!existing) {
      pendingCancellationsRef.current.set(requestId, { identity, requestId, status: 'failed' })
    }
    void requestPendingCancellation(requestId)
  }, [requestPendingCancellation])

  /** 确认同 identity 的全部旧请求均已取消；任一失败都阻止新测试。 */
  const ensureIdentityCancellations = React.useCallback((identity: string): Promise<boolean> => {
    const pending = [...pendingCancellationsRef.current.values()]
      .filter((item) => item.identity === identity)
    if (pending.length === 0) return Promise.resolve(true)
    if (pending.length === 1) return requestPendingCancellation(pending[0]!.requestId)
    return Promise.all(pending.map((item) => requestPendingCancellation(item.requestId)))
      .then((results) => results.every(Boolean))
  }, [requestPendingCancellation])

  /** 使 identity 的等待/在途/展示测试同步失效，再异步尝试取消请求。 */
  const invalidateIdentityTest = React.useCallback((identity: string, credentialChanged = false, terminal = false): void => {
    const storedGeneration = testGenerationsRef.current.get(identity)
    const activeTest = activeTestsRef.current.get(identity)
    const hasViewState = Object.hasOwn(testStatesRef.current, identity)
    const hasPendingCancellation = [...pendingCancellationsRef.current.values()]
      .some((pending) => pending.identity === identity)
    /** 未测试且无等待操作的草稿不创建无意义 Map 条目。 */
    if (!storedGeneration && !activeTest && !hasViewState && !hasPendingCancellation) return
    issueOperationToken(identity, credentialChanged)
    activeTestsRef.current.delete(identity)
    if (activeTest?.requestId) queuePendingCancellation(identity, activeTest.requestId)
    for (const pending of pendingCancellationsRef.current.values()) {
      if (pending.identity === identity) void requestPendingCancellation(pending.requestId)
    }
    clearIdentityTestState(identity)
    if (terminal) cleanupIdentityTracking(identity)
  }, [cleanupIdentityTracking, clearIdentityTestState, issueOperationToken, queuePendingCancellation, requestPendingCancellation])

  /** 权威 catalog 换代或卸载时批量失效测试，只提交一次展示状态清理。 */
  const invalidateAllTests = React.useCallback((terminal = false): void => {
    /** generation、活动请求和已展示状态的 identity 并集。 */
    const identities = new Set([
      ...testGenerationsRef.current.keys(),
      ...activeTestsRef.current.keys(),
      ...Object.keys(testStatesRef.current),
      ...[...pendingCancellationsRef.current.values()].map((pending) => pending.identity),
    ])
    for (const identity of identities) {
      issueOperationToken(identity)
      const activeTest = activeTestsRef.current.get(identity)
      activeTestsRef.current.delete(identity)
      if (activeTest?.requestId) queuePendingCancellation(identity, activeTest.requestId)
      for (const pending of pendingCancellationsRef.current.values()) {
        if (pending.identity === identity) void requestPendingCancellation(pending.requestId)
      }
    }
    publishTestStates({})
    if (terminal) {
      activeTestsRef.current.clear()
      pendingCancellationsRef.current.clear()
      testGenerationsRef.current.clear()
      return
    }
    for (const identity of identities) cleanupIdentityTracking(identity)
  }, [cleanupIdentityTracking, issueOperationToken, publishTestStates, queuePendingCancellation, requestPendingCancellation])

  /** 在权威回读前同步关闭写入和测试入口，并使全部旧结果永久失效。 */
  const enterReloadGate = React.useCallback((): void => {
    needsReloadRef.current = true
    if (mountedRef.current) setNeedsReload(true)
    invalidateAllTests()
  }, [invalidateAllTests])

  /** 接管主进程权威设置；revision 变化会使旧测试结论全部失效。 */
  const acceptSettings = React.useCallback((next: AudioGenerationSettingsResult): void => {
    const previousRevision = settingsRef.current?.catalog.revision
    if (previousRevision !== undefined && previousRevision !== next.catalog.revision) invalidateAllTests()
    settingsRef.current = next
    if (mountedRef.current) setSettings(next)
  }, [invalidateAllTests])

  /** 同步更新草稿 ref 与 React 状态。 */
  const publishDraft = React.useCallback((next: AudioGenerationDraft | null): void => {
    draftRef.current = next
    if (mountedRef.current) setDraft(next)
  }, [])

  /** 从主进程读取权威目录，迟到结果与卸载均无副作用。 */
  const load = React.useCallback(async (): Promise<boolean> => {
    const revision = loadRevisionRef.current + 1
    loadRevisionRef.current = revision
    setLoading(true)
    setLoadError(null)
    try {
      const next = await api.getSettings()
      if (!mountedRef.current || revision !== loadRevisionRef.current) return false
      acceptSettings(next)
      needsReloadRef.current = false
      setNeedsReload(false)
      setActionError(null)
      return true
    } catch {
      if (mountedRef.current && revision === loadRevisionRef.current) {
        const message = needsReloadRef.current
          ? '配置状态未知，重新加载失败，请先重试加载。'
          : '音频配置读取失败，请重试。'
        setLoadError(message)
        if (needsReloadRef.current) setActionError(message)
      }
      return false
    } finally {
      if (mountedRef.current && revision === loadRevisionRef.current) setLoading(false)
    }
  }, [acceptSettings, api])

  React.useEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
      loadRevisionRef.current += 1
      invalidateAllTests(true)
    }
  }, [invalidateAllTests, load])

  /** 清除明文草稿并返回列表。 */
  const closeDraft = React.useCallback((): void => {
    const currentDraft = draftRef.current
    if (currentDraft) invalidateIdentityTest(currentDraft.id, false, true)
    publishDraft(null)
    editBaselineRef.current = null
    setActionError(null)
  }, [invalidateIdentityTest, publishDraft])

  /** 写入结果未知时阻止继续使用旧 revision，直到显式 GET 成功。 */
  const ensureCatalogReady = React.useCallback((): boolean => {
    if (!needsReloadRef.current) return true
    setActionError('配置状态未知，重新加载失败，请先重试加载。')
    return false
  }, [])

  /** 用完整目录执行一次 CAS，并接管返回的权威结果。 */
  const replace = React.useCallback(async (request: ReplaceAudioGenerationCatalogRequest): Promise<boolean> => {
    if (saving) return false
    setSaving(true)
    setActionError(null)
    try {
      const next = await api.replaceCatalog(request)
      loadRevisionRef.current += 1
      acceptSettings(next)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('AUDIO_GENERATION_CONFIG_CONFLICT') || message.includes('AUDIO_GENERATION_CONFIG_OUTCOME_UNKNOWN')) {
        enterReloadGate()
        const reloaded = await load()
        if (mountedRef.current) {
          setActionError(reloaded
            ? formatAudioGenerationError(error)
            : '配置状态未知，重新加载失败，请先重试加载。')
          if (!reloaded) {
            setDeleteId(null)
            deleteBaselineRef.current = null
          }
        }
        return false
      }
      if (mountedRef.current) setActionError(formatAudioGenerationError(error))
      return false
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [acceptSettings, api, enterReloadGate, load, saving])

  /** 为未修改条目构造 preserve 更新。 */
  const preserveEntries = React.useCallback((profiles: readonly AudioGenerationPublicProfile[]): ReplaceAudioGenerationCatalogRequest['profiles'] => profiles.map((profile) => ({
    profile: draftToProfile(profileToDraft(profile)),
    credentialUpdate: { mode: 'preserve' },
  })), [])

  /** 打开空的小米配置草稿。 */
  const startCreate = React.useCallback((): void => {
    if (!ensureCatalogReady()) return
    const currentDraft = draftRef.current
    if (currentDraft) invalidateIdentityTest(currentDraft.id, false, true)
    const now = Date.now()
    editBaselineRef.current = null
    setActionError(null)
    /** 新建配置直接带入小米官方默认端与默认模型。 */
    const defaults = AUDIO_GENERATION_PROVIDER_DEFAULTS.xiaomi
    publishDraft({ id: createAudioGenerationId(), name: '', provider: 'xiaomi', baseUrl: defaults.baseUrl, models: [{ id: defaults.modelId, voices: [] }], enabled: true, createdAt: now, updatedAt: now, apiKey: '', credentialConfigured: false })
  }, [ensureCatalogReady, invalidateIdentityTest, publishDraft])

  /** 编辑已保存配置但不读取旧 Key。 */
  const startEdit = React.useCallback((profile: AudioGenerationPublicProfile): void => {
    if (!ensureCatalogReady()) return
    const currentDraft = draftRef.current
    if (currentDraft) invalidateIdentityTest(currentDraft.id, false, true)
    editBaselineRef.current = { id: profile.id, fingerprint: profileFingerprint(profile), identity: profileIdentity(profile) }
    setActionError(null)
    publishDraft(profileToDraft(profile))
  }, [ensureCatalogReady, invalidateIdentityTest, publishDraft])

  /** 复制时生成新 ID 并强制重新填写 Key。 */
  const startCopy = React.useCallback((profile: AudioGenerationPublicProfile): void => {
    if (!ensureCatalogReady()) return
    const currentDraft = draftRef.current
    if (currentDraft && currentDraft.id !== profile.id) invalidateIdentityTest(currentDraft.id, false, true)
    invalidateIdentityTest(profile.id, false, true)
    editBaselineRef.current = null
    setActionError(null)
    publishDraft(copyAudioGenerationProfile(profile, createAudioGenerationId(), Date.now()))
  }, [ensureCatalogReady, invalidateIdentityTest, publishDraft])

  /** 从旧 MiniMax 摘要创建非破坏迁移草稿。 */
  const startMigration = React.useCallback((profileId: string): void => {
    if (!ensureCatalogReady()) return
    const legacy = settingsRef.current?.legacyAudioProfiles.find((profile) => profile.id === profileId)
    if (!legacy) return
    const currentDraft = draftRef.current
    if (currentDraft) invalidateIdentityTest(currentDraft.id, false, true)
    const now = Date.now()
    editBaselineRef.current = null
    setActionError(null)
    publishDraft({
      id: createAudioGenerationId(), name: legacy.name, provider: 'minimax', baseUrl: AUDIO_GENERATION_PROVIDER_DEFAULTS.minimax.baseUrl,
      models: [{ id: legacy.modelId, voices: [] }], groupId: '', enabled: legacy.enabled, createdAt: now, updatedAt: now,
      legacyMediaProfileId: legacy.id, apiKey: '', credentialConfigured: false,
    })
  }, [ensureCatalogReady, invalidateIdentityTest, publishDraft])

  /** 更新草稿；身份变化立即使旧测试失效。 */
  const updateDraft = React.useCallback((next: AudioGenerationDraft): void => {
    const currentDraft = draftRef.current
    if (currentDraft) {
      const identityChanged = profileIdentity(currentDraft) !== profileIdentity(next)
      const credentialChanged = currentDraft.apiKey !== next.apiKey
      if (identityChanged || credentialChanged) invalidateIdentityTest(currentDraft.id, credentialChanged)
    }
    publishDraft(next)
    setActionError(null)
  }, [invalidateIdentityTest, publishDraft])

  /** 保存新增、复制、迁移或编辑草稿。 */
  const saveDraft = React.useCallback(async (): Promise<void> => {
    if (!settings || !draft || saving || !ensureCatalogReady()) return
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
      const profile = draftToProfile(draft)
      const entries = preserveEntries(settings.catalog.profiles)
      const credentialUpdate = createCredentialUpdate(draft.apiKey, draft.credentialConfigured)
      if (existingIndex >= 0) entries[existingIndex] = { profile, credentialUpdate }
      else entries.push({ profile, credentialUpdate })
      const saved = await replace({ expectedRevision: settings.catalog.revision, profiles: entries })
      if (saved && mountedRef.current) {
        invalidateIdentityTest(draft.id, false, true)
        publishDraft(null)
        editBaselineRef.current = null
      }
    } catch (error) {
      /** API Key 必填提示可直接操作，其它 schema 错误统一转为稳定表单文案。 */
      const message = error instanceof Error && error.message === '请输入 API Key'
        ? error.message
        : '请完整填写有效的名称、服务地址和模型 ID，并至少添加一个音色。'
      if (mountedRef.current) setActionError(message)
    }
  }, [draft, ensureCatalogReady, invalidateIdentityTest, preserveEntries, publishDraft, replace, saving, settings])

  /** 快捷启停仍完整替换目录，所有凭据保持不变。 */
  const toggleEnabled = React.useCallback(async (profile: AudioGenerationPublicProfile, enabled: boolean): Promise<void> => {
    if (!settings || saving || !ensureCatalogReady()) return
    const entries = preserveEntries(settings.catalog.profiles)
    const index = settings.catalog.profiles.findIndex((item) => item.id === profile.id)
    if (index < 0 || profileFingerprint(settings.catalog.profiles[index]!) !== profileFingerprint(profile)) {
      setActionError('目标已被其他窗口修改，请重新加载后操作。')
      return
    }
    entries[index] = { profile: { ...entries[index]!.profile, enabled, updatedAt: Date.now() }, credentialUpdate: { mode: 'preserve' } }
    await replace({ expectedRevision: settings.catalog.revision, profiles: entries })
  }, [ensureCatalogReady, preserveEntries, replace, saving, settings])

  /** 打开受控删除确认并记录目标快照。 */
  const requestDelete = React.useCallback((profileId: string): void => {
    if (!ensureCatalogReady()) return
    const profile = settings?.catalog.profiles.find((item) => item.id === profileId)
    if (!profile) return
    invalidateIdentityTest(profileId, false, true)
    deleteBaselineRef.current = { id: profileId, fingerprint: profileFingerprint(profile) }
    setActionError(null)
    setDeleteId(profileId)
  }, [ensureCatalogReady, invalidateIdentityTest, settings])

  /** 关闭删除确认并清理局部错误。 */
  const closeDelete = React.useCallback((): void => {
    if (saving) return
    setDeleteId(null)
    deleteBaselineRef.current = null
    setActionError(null)
  }, [saving])

  /** 删除目标成功后才关闭确认框，失败保留错误供用户重试。 */
  const confirmDelete = React.useCallback(async (): Promise<void> => {
    if (!settings || !deleteId || saving || !ensureCatalogReady()) return
    invalidateIdentityTest(deleteId, false, true)
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
  }, [deleteId, ensureCatalogReady, invalidateIdentityTest, preserveEntries, replace, saving, settings])

  /** 判断测试绑定仍对应当前代次、目录 revision 和非秘密配置身份。 */
  const isTestBindingCurrent = React.useCallback((identity: string, binding: Omit<AudioGenerationTestViewState, 'requestId' | 'state' | 'message'>): boolean => {
    if (needsReloadRef.current) return false
    if (!mountedRef.current || settingsRef.current?.catalog.revision !== binding.catalogRevision) return false
    const generation = getTestGeneration(identity)
    if (generation.testGeneration !== binding.testGeneration
      || generation.credentialGeneration !== binding.credentialGeneration) return false
    /** 编辑态优先复核当前草稿，否则复核权威目录中的已保存配置。 */
    const currentProfile = draftRef.current?.id === identity
      ? draftRef.current
      : settingsRef.current?.catalog.profiles.find((profile) => profile.id === identity)
    return Boolean(currentProfile && profileIdentity(currentProfile) === binding.profileFingerprint)
  }, [getTestGeneration])

  /** 测试当前草稿或已保存配置，每个 await 前后都复核 generation 与权威身份。 */
  const testProfile = React.useCallback(async (profile?: AudioGenerationPublicProfile): Promise<void> => {
    if (!ensureCatalogReady()) return
    const targetDraft = profile ? null : draftRef.current
    const identity = profile?.id ?? targetDraft?.id
    const currentSettings = settingsRef.current
    if (!identity || !currentSettings) return
    /** 新测试先同步取得唯一代次，后续用户动作可立即使其失效。 */
    const previousGeneration = getTestGeneration(identity)
    const nextGeneration = issueOperationToken(identity)
    const testGeneration = nextGeneration.testGeneration
    const binding = {
      catalogRevision: currentSettings.catalog.revision,
      profileFingerprint: profileIdentity(profile ?? targetDraft!),
      credentialGeneration: previousGeneration.credentialGeneration,
      testGeneration,
    }
    /** 在等待旧 cancel 前登记无 requestId 的启动操作，返回/修改可同步注销。 */
    const previousTest = activeTestsRef.current.get(identity)
    activeTestsRef.current.set(identity, { testGeneration })
    clearIdentityTestState(identity)
    if (previousTest?.requestId) queuePendingCancellation(identity, previousTest.requestId)
    const hasPendingCancellation = [...pendingCancellationsRef.current.values()]
      .some((pending) => pending.identity === identity)
    if (hasPendingCancellation) {
      const cancellationsCompleted = await ensureIdentityCancellations(identity)
      if (!cancellationsCompleted) {
        if (activeTestsRef.current.get(identity)?.testGeneration !== testGeneration
          || !isTestBindingCurrent(identity, binding)) return
        const failedRequestId = [...pendingCancellationsRef.current.values()]
          .find((pending) => pending.identity === identity)?.requestId
        if (!failedRequestId) return
        publishTestStates({
          ...testStatesRef.current,
          [identity]: {
            requestId: failedRequestId, state: 'failed', message: '取消上一次测试失败，请重试。', ...binding,
          },
        })
        return
      }
    }
    if (activeTestsRef.current.get(identity)?.testGeneration !== testGeneration
      || !isTestBindingCurrent(identity, binding)) return

    const requestId = globalThis.crypto.randomUUID()
    let input: AudioGenerationTestInput
    try {
      if (profile) {
        const currentProfile = settingsRef.current?.catalog.profiles.find((item) => item.id === profile.id)
        if (!currentProfile || profileIdentity(currentProfile) !== binding.profileFingerprint) return
        input = { kind: 'saved', profileId: profile.id, requestId }
      } else {
        const currentDraft = draftRef.current
        if (!currentDraft || currentDraft.id !== identity || profileIdentity(currentDraft) !== binding.profileFingerprint) return
        const apiKey = currentDraft.apiKey.trim()
        const baseline = editBaselineRef.current
        if (apiKey) input = { kind: 'draft', requestId, profile: draftToProfile(currentDraft), apiKey }
        else if (baseline && baseline.identity === profileIdentity(currentDraft) && currentDraft.credentialConfigured) {
          input = { kind: 'saved', profileId: currentDraft.id, requestId }
        } else {
          setActionError('当前服务身份已修改，请重新填写 API Key 后测试。')
          activeTestsRef.current.delete(identity)
          return
        }
      }
    } catch {
      setActionError('请先完整填写音频配置后再测试。')
      activeTestsRef.current.delete(identity)
      return
    }
    activeTestsRef.current.set(identity, { testGeneration, requestId })
    if (!isTestBindingCurrent(identity, binding)) {
      activeTestsRef.current.delete(identity)
      return
    }
    publishTestStates({
      ...testStatesRef.current,
      [identity]: { requestId, state: 'loading', message: TEST_STATE_LABELS.loading, ...binding },
    })
    try {
      const result = await api.test(input)
      const activeTest = activeTestsRef.current.get(identity)
      if (activeTest?.requestId !== result.requestId || activeTest.testGeneration !== testGeneration
        || !isTestBindingCurrent(identity, binding)) return
      activeTestsRef.current.delete(identity)
      publishTestStates({
        ...testStatesRef.current,
        [identity]: { requestId: result.requestId, state: result.state, message: TEST_STATE_LABELS[result.state], ...binding },
      })
    } catch {
      const activeTest = activeTestsRef.current.get(identity)
      if (activeTest?.requestId !== requestId || activeTest.testGeneration !== testGeneration
        || !isTestBindingCurrent(identity, binding)) return
      activeTestsRef.current.delete(identity)
      publishTestStates({
        ...testStatesRef.current,
        [identity]: { requestId, state: 'failed', message: TEST_STATE_LABELS.failed, ...binding },
      })
    }
  }, [api, clearIdentityTestState, ensureCatalogReady, ensureIdentityCancellations, getTestGeneration, isTestBindingCurrent, issueOperationToken, publishTestStates, queuePendingCancellation])

  /**
   * 从供应商拉取可用模型与音色。
   * 结果绑定当前草稿身份：身份变化后旧结果直接丢弃，避免污染新草稿。
   */
  const fetchCatalog = React.useCallback(async (): Promise<void> => {
    const currentDraft = draftRef.current
    if (!currentDraft) return
    /** 发起时的草稿身份，用于丢弃迟到结果；切换模型不会使结果失效。 */
    const identity = catalogIdentity(currentDraft)
    if (!currentDraft.baseUrl.trim()) {
      setCatalog({ state: 'failed', message: '请先填写服务地址', models: [], voices: [], draftIdentity: identity })
      return
    }
    /** 本次表单填了新 Key 就用草稿凭据，否则用已保存密文。 */
    const draftApiKey = currentDraft.apiKey.trim()
    const credential: AudioGenerationCatalogFetchInput['credential'] = draftApiKey
      ? { mode: 'draft', apiKey: draftApiKey }
      : { mode: 'saved', profileId: currentDraft.id }
    setCatalog({ state: 'loading', models: [], voices: [], draftIdentity: identity })
    try {
      const result = await api.fetchCatalog({
        requestId: createAudioGenerationId(),
        provider: currentDraft.provider,
        baseUrl: currentDraft.baseUrl,
        ...(currentDraft.provider === 'minimax' && currentDraft.groupId?.trim()
          ? { groupId: currentDraft.groupId.trim() }
          : {}),
        credential,
      })
      if (!mountedRef.current || catalogIdentity(draftRef.current ?? currentDraft) !== identity) return
      setCatalog({
        state: result.state,
        message: result.message,
        models: result.models,
        voices: result.voices,
        draftIdentity: identity,
      })
    } catch {
      if (!mountedRef.current || catalogIdentity(draftRef.current ?? currentDraft) !== identity) return
      setCatalog({ state: 'failed', message: '从供应商获取失败，请检查服务地址与凭据', models: [], voices: [], draftIdentity: identity })
    }
  }, [api])

  return {
    settings, loading, saving, needsReload, generationEntryCount: testGenerationsRef.current.size,
    pendingCancellationCount: pendingCancellationsRef.current.size,
    loadError, actionError, query, draft, deleteId, testStates, catalog,
    visibleProfiles: filterAudioGenerationProfiles(settings?.catalog.profiles ?? [], query),
    setQuery, load, startCreate, startEdit, startCopy, startMigration, updateDraft, closeDraft, saveDraft,
    toggleEnabled, requestDelete, closeDelete, confirmDelete, testProfile, fetchCatalog,
  }
}

/** 紧凑表单字段，确保 label 与原生控件稳定关联。 */
function FormField({ id, label, children }: { id: string; label: string; children: React.ReactNode }): React.ReactElement {
  return <div className="space-y-1.5"><label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>{children}</div>
}

/** 「从供应商获取」按钮；拉取中显示加载态并阻止重复点击。 */
function FetchCatalogButton({ catalog, disabled, onFetch }: {
  catalog: AudioGenerationCatalogViewState | null
  disabled: boolean
  onFetch: () => Promise<void>
}): React.ReactElement {
  /** 拉取中保持按钮可见但不可再次点击。 */
  const loading = catalog?.state === 'loading'
  return (
    <Button variant="outline" size="sm" type="button" className="h-7 text-xs" disabled={disabled || loading} onClick={() => void onFetch()}>
      {loading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
      <span>从供应商获取</span>
    </Button>
  )
}

/** 已启用模型列表；点击行切换当前模型，最后一个模型不允许删除。 */
function AudioEnabledModelList({ models, selectedModelId, disabled, onSelect, onChange }: {
  models: readonly AudioGenerationModelEntry[]
  selectedModelId: string | null
  disabled: boolean
  onSelect: (modelId: string) => void
  onChange: (models: AudioGenerationModelEntry[]) => void
}): React.ReactElement {
  return (
    <SettingsCard divided={false}>
      {models.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">还没有启用任何模型，从下方可用模型中选择</div>
      ) : (
        <div className="divide-y divide-border/50">
          {models.map((model) => {
            /** 当前行是否正在被查看音色。 */
            const selected = model.id === selectedModelId
            return (
              <div key={model.id} className={`group flex items-center gap-2 px-4 py-2.5${selected ? ' bg-muted/40' : ''}`}>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`查看 ${model.id} 的音色`}
                  onClick={() => onSelect(model.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {selected
                    ? <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />
                    : <span className="size-3.5 shrink-0 rounded-full border border-muted-foreground/40" />}
                  <span className="min-w-0 flex-1 text-sm text-foreground">
                    {model.name ?? model.id}
                    {model.name && model.name !== model.id ? <span className="ml-1 text-muted-foreground">({model.id})</span> : null}
                    <span className="ml-2 text-xs text-muted-foreground">{model.voices.length} 个音色</span>
                  </span>
                </button>
                <button
                  type="button"
                  disabled={disabled || models.length <= 1}
                  aria-label={`移除模型 ${model.id}`}
                  title={models.length <= 1 ? '至少保留一个模型' : '移除模型'}
                  onClick={() => onChange(models.filter((entry) => entry.id !== model.id))}
                  className="p-0.5 text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:text-destructive disabled:opacity-30"
                >
                  <X size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </SettingsCard>
  )
}

/** 可用模型：拉取结果点选加入上方，底部保留手填一行。 */
function AudioAvailableModels({ models, fetchedModels, catalogState, disabled, onChange }: {
  models: readonly AudioGenerationModelEntry[]
  fetchedModels: readonly string[]
  catalogState: 'idle' | 'loading' | 'success' | 'failed'
  disabled: boolean
  onChange: (models: AudioGenerationModelEntry[]) => void
}): React.ReactElement {
  /** 待添加的模型 ID 与就地错误提示。 */
  const [pendingId, setPendingId] = React.useState('')
  const [addError, setAddError] = React.useState('')
  /** 已启用模型按 id 去重，决定清单里还剩哪些可添加。 */
  const enabledIds = new Set(models.map((model) => model.id))
  const available = fetchedModels.filter((id) => !enabledIds.has(id))

  /** 追加一个模型条目（音色留空，随后按模型维护）。 */
  const appendModel = (id: string): void => {
    const trimmed = id.trim()
    if (!trimmed) {
      setAddError('请输入模型 ID')
      return
    }
    if (enabledIds.has(trimmed)) {
      setAddError('该模型已添加')
      return
    }
    onChange([...models, { id: trimmed, voices: [] }])
    setAddError('')
  }

  return (
    <SettingsCard divided={false}>
      {available.map((id) => (
        <div
          key={id}
          role="button"
          tabIndex={0}
          onClick={() => appendModel(id)}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); appendModel(id) } }}
          className="group flex cursor-pointer items-center gap-2 px-4 py-2.5 transition-colors hover:bg-muted/30"
        >
          <Plus size={14} className="shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm text-foreground">{id}</span>
        </div>
      ))}
      {available.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          {catalogState === 'loading'
            ? '正在从供应商获取…'
            : fetchedModels.length === 0
              ? '点右上角「从供应商获取」读取该账号可用的模型'
              : '拉取到的模型都已添加'}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-border/50 px-4 py-2.5">
        <Input
          id="audio-model-id"
          aria-label="模型 ID"
          className="h-8 flex-1 text-sm"
          placeholder="模型 ID（如 mimo-v2.5-tts）"
          value={pendingId}
          disabled={disabled}
          onChange={(event) => setPendingId(event.target.value)}
        />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="添加模型"
          title="添加模型"
          disabled={disabled}
          onClick={() => {
            appendModel(pendingId)
            setPendingId('')
          }}
        >
          <Plus />
        </Button>
      </div>
      {addError && <p role="alert" className="px-4 pb-3 text-xs text-destructive">{addError}</p>}
    </SettingsCard>
  )
}

/** 已启用音色列表；悬停可移除，列表为空时给出引导。 */
function AudioEnabledVoiceList({ voices, disabled, onChange }: {
  voices: readonly AudioGenerationVoice[]
  disabled: boolean
  onChange: (voices: AudioGenerationVoice[]) => void
}): React.ReactElement {
  return (
    <SettingsCard divided={false}>
      {voices.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">还没有启用任何音色，从下方可用音色中选择</div>
      ) : (
        <div className="divide-y divide-border/50">
          {voices.map((voice) => (
            <div key={voice.id} className="group flex items-center gap-2 px-4 py-2.5">
              <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />
              <span className="flex-1 text-sm text-foreground">
                {voice.name ?? voice.id}
                {voice.name && voice.name !== voice.id ? <span className="ml-1 text-muted-foreground">({voice.id})</span> : null}
              </span>
              <button
                type="button"
                disabled={disabled}
                aria-label={`移除音色 ${voice.name ?? voice.id}`}
                title="移除音色"
                onClick={() => onChange(voices.filter((entry) => entry.id !== voice.id))}
                className="p-0.5 text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:text-destructive"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </SettingsCard>
  )
}

/**
 * 可用音色：官方内置清单点击即添加，底部保留手填一行。
 * 入参：已启用集合、内置清单、禁用态与集合变更回调；返回值：可用音色视图。
 */
function AudioAvailableVoices({ voices, builtinVoices, fetchedVoices, capability, disabled, onChange }: {
  voices: readonly AudioGenerationVoice[]
  builtinVoices: readonly AudioGenerationVoice[]
  fetchedVoices: readonly AudioGenerationVoice[]
  capability: AudioVoiceCapability
  disabled: boolean
  onChange: (voices: AudioGenerationVoice[]) => void
}): React.ReactElement {
  /** 待添加的音色 ID 与可选显示名称。 */
  const [pendingId, setPendingId] = React.useState('')
  const [pendingName, setPendingName] = React.useState('')
  /** 重复或空输入时的就地提示。 */
  const [addError, setAddError] = React.useState('')
  /** 已启用音色按 id 去重，决定内置清单里还剩哪些可添加。 */
  const enabledIds = new Set(voices.map((voice) => voice.id))
  /** 内置与供应商拉取结果合并后去重，顺序保持内置优先。 */
  const candidates = [...builtinVoices, ...fetchedVoices].filter((voice, index, all) =>
    all.findIndex((entry) => entry.id === voice.id) === index)
  const availableBuiltins = candidates.filter((voice) => !enabledIds.has(voice.id))

  /** 追加一条已启用音色，重复 id 就地拒绝。 */
  const appendVoice = (voice: AudioGenerationVoice): void => {
    if (enabledIds.has(voice.id)) {
      setAddError('该音色已添加')
      return
    }
    onChange([...voices, voice])
    setAddError('')
  }

  return (
    <SettingsCard divided={false}>
      {capability === 'voice-sample' && (
        <div className="px-4 py-3 text-xs text-muted-foreground">
          当前模型是声音复刻：`voice` 字段必须传音频样本的 base64，内置音色与音色 ID 都不适用，请在上方手填样本标识。
        </div>
      )}
      {capability === 'no-voice' && (
        <div className="px-4 py-3 text-xs text-muted-foreground">
          当前模型是音色设计：请求不传 `voice` 字段，音色由文本描述生成，因此这里不需要选择音色。
        </div>
      )}
      {availableBuiltins.map((voice) => (
        <div
          key={voice.id}
          role="button"
          tabIndex={0}
          onClick={() => appendVoice(voice)}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); appendVoice(voice) } }}
          className="group flex cursor-pointer items-center gap-2 px-4 py-2.5 transition-colors hover:bg-muted/30"
        >
          <Plus size={14} className="shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm text-foreground">{voice.name ?? voice.id}</span>
        </div>
      ))}
      {builtinVoices.length > 0 && availableBuiltins.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">所有内置音色已启用</div>
      )}
      {capability === 'voice-id' && <div className="flex items-center gap-2 border-t border-border/50 px-4 py-2.5">
        <Input id="audio-voice-id" aria-label="音色 ID" className="h-8 flex-1 text-sm" placeholder="音色 ID" value={pendingId} disabled={disabled} onChange={(event) => setPendingId(event.target.value)} />
        <Input id="audio-voice-name" aria-label="显示名称（可选）" className="h-8 flex-1 text-sm" placeholder="显示名称（可选）" value={pendingName} disabled={disabled} onChange={(event) => setPendingName(event.target.value)} />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="添加音色"
          title="添加音色"
          disabled={disabled}
          onClick={() => {
            const id = pendingId.trim()
            if (!id) {
              setAddError('请输入音色 ID')
              return
            }
            const name = pendingName.trim()
            appendVoice(name ? { id, name, source: 'manual' } : { id, source: 'manual' })
            setPendingId('')
            setPendingName('')
          }}
        >
          <Plus />
        </Button>
      </div>}
      {addError && <p role="alert" className="px-4 pb-3 text-xs text-destructive">{addError}</p>}
    </SettingsCard>
  )
}

/** 列表摘要只显示模型数量与首个音色，避免长列表撑开行。 */
function voiceSummary(models: readonly AudioGenerationModelEntry[]): string {
  const [first] = models
  if (!first) return '未配置模型'
  const voiceCount = models.reduce((total, model) => total + model.voices.length, 0)
  const firstVoice = first.voices[0]
  const voiceLabel = firstVoice ? firstVoice.name ?? firstVoice.id : '未配置音色'
  const modelLabel = models.length === 1 ? first.id : `${first.id} 等 ${models.length} 个模型`
  return `${modelLabel} · ${voiceCount === 0 ? '未配置音色' : voiceLabel}`
}

/**
 * 生成服务地址预览。
 * 入参：用户填写的 Base URL 与当前供应商；返回值：真实请求地址预览文本。
 * 只做展示，不参与请求拼接；末尾斜杠会被归一化，避免出现双斜杠。
 */
export function buildAudioRequestPreview(baseUrl: string, provider: AudioGenerationProvider): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return `${trimmed}${AUDIO_GENERATION_PROVIDER_DEFAULTS[provider].requestPath}`
}

/** 音频目录、动态表单与旧配置迁移的纯视图。 */
export function AudioGenerationCatalogView({ controller, navigation, headerContent, children }: AudioGenerationCatalogViewProps): React.ReactElement {
  const { settings, loading, saving, needsReload, loadError, actionError, query, draft, deleteId, visibleProfiles, testStates } = controller
  /** reload 门禁与保存互斥共用控件禁用态。 */
  const actionDisabled = saving || needsReload
  const legacyReferences = new Set(settings?.catalog.profiles.map((profile) => profile.legacyMediaProfileId).filter((id): id is string => Boolean(id)) ?? [])
  const deleteTarget = settings?.catalog.profiles.find((profile) => profile.id === deleteId)
  /** 当前正在查看音色的模型；草稿切换时回退到第一个模型。 */
  const [selectedModelId, setSelectedModelId] = React.useState<string | null>(null)

  if (draft) {
    const testState = testStates[draft.id]
    /** 当前供应商的默认端、默认模型与内置音色。 */
    const providerDefaults = AUDIO_GENERATION_PROVIDER_DEFAULTS[draft.provider]
    /** 当前查看音色的模型。 */
    const selectedModel = draft.models.find((model) => model.id === selectedModelId) ?? draft.models[0] ?? null
    /** 当前模型允许的音色输入方式。 */
    const resolvedVoiceCapability = selectedModel ? resolveVoiceCapability(draft.provider, selectedModel.id) : 'voice-id'
    /** 只替换选中模型的音色，其它模型的音色保持原样。 */
    const updateModelVoices = (modelId: string, voices: AudioGenerationVoice[]): void => {
      controller.updateDraft({
        ...draft,
        models: draft.models.map((model) => (model.id === modelId ? { ...model, voices } : model)),
      })
    }
    /** 只展示属于当前草稿身份的拉取结果。 */
    const catalogForDraft = controller.catalog?.draftIdentity === catalogIdentity(draft) ? controller.catalog : null
    return (
      <MediaSettingsPage title={editTitle(draft, settings)} onBack={controller.closeDraft} busy={saving} headerContent={headerContent}>
        <SettingsSection title="基本信息">
          <SettingsCard>
            <SettingsSelect
              id="audio-provider"
              label="供应商类型"
              value={draft.provider}
              disabled={actionDisabled}
              onValueChange={(value) => {
                /** 只接受两个已知供应商，未知值直接忽略。 */
                if (value !== 'xiaomi' && value !== 'minimax') return
                controller.updateDraft(changeAudioGenerationProvider(draft, value))
              }}
              options={AUDIO_GENERATION_PROVIDER_DESCRIPTORS.map((descriptor) => ({ value: descriptor.provider, label: descriptor.label }))}
            />
            <SettingsInput
              label="供应商名称"
              value={draft.name}
              disabled={actionDisabled}
              placeholder="例如：小米配音"
              required
              onChange={(name) => controller.updateDraft({ ...draft, name })}
            />
            <SettingsInput
              id="audio-base-url"
              label="服务地址"
              value={draft.baseUrl}
              disabled={actionDisabled}
              placeholder={providerDefaults.baseUrl}
              /** 预览真实请求地址，避免用户把路径写重或写漏。 */
              description={draft.baseUrl.trim() ? `预览：${buildAudioRequestPreview(draft.baseUrl, draft.provider)}` : undefined}
              onChange={(baseUrl) => controller.updateDraft({ ...draft, baseUrl })}
            />
            <div className="space-y-2 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-foreground">API Key</div>
                <Button variant="outline" size="sm" type="button" className="h-7 text-xs" disabled={actionDisabled} onClick={() => void controller.testProfile()}>
                  {testState?.state === 'loading' ? <Loader2 size={12} className="animate-spin" /> : <TestTube2 size={12} />}
                  <span>测试连接</span>
                </Button>
              </div>
              <Input id="audio-api-key" type="password" autoComplete="new-password" value={draft.apiKey} disabled={actionDisabled} placeholder={draft.credentialConfigured ? '留空以保留已保存凭据' : '请输入 API Key'} onChange={(event) => controller.updateDraft({ ...draft, apiKey: event.target.value })} />
            </div>
            {draft.provider === 'minimax' && <SettingsInput id="audio-group-id" label="Group ID（可选）" value={draft.groupId ?? ''} disabled={actionDisabled} onChange={(groupId) => controller.updateDraft({ ...draft, groupId })} />}
            <SettingsToggle
              label="启用此配置"
              description="关闭后该配置的音色不会出现在画布与 agent 的可选列表中"
              checked={draft.enabled}
              disabled={actionDisabled}
              onCheckedChange={(enabled) => controller.updateDraft({ ...draft, enabled })}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="已启用模型" description={draft.models.length > 0 ? `${draft.models.length} 个模型 · 音色按模型分别维护` : undefined}>
          <AudioEnabledModelList
            models={draft.models}
            selectedModelId={selectedModel?.id ?? null}
            disabled={actionDisabled}
            onSelect={setSelectedModelId}
            onChange={(models) => controller.updateDraft({ ...draft, models })}
          />
        </SettingsSection>

        <SettingsSection
          title="可用模型"
          action={<FetchCatalogButton catalog={catalogForDraft} disabled={actionDisabled} onFetch={controller.fetchCatalog} />}
        >
          <AudioAvailableModels
            models={draft.models}
            fetchedModels={catalogForDraft?.models ?? []}
            catalogState={catalogForDraft?.state ?? 'idle'}
            disabled={actionDisabled}
            onChange={(models) => controller.updateDraft({ ...draft, models })}
          />
        </SettingsSection>

        <SettingsSection
          title="已启用音色"
          description={selectedModel ? `归属模型 ${selectedModel.id}` : '请先添加模型'}
        >
          <AudioEnabledVoiceList
            voices={selectedModel?.voices ?? []}
            disabled={actionDisabled || !selectedModel}
            onChange={(voices) => selectedModel && updateModelVoices(selectedModel.id, voices)}
          />
        </SettingsSection>

        <SettingsSection title="可用音色">
          <AudioAvailableVoices
            voices={selectedModel?.voices ?? []}
            builtinVoices={resolvedVoiceCapability === 'voice-id' ? providerDefaults.builtinVoices : []}
            fetchedVoices={resolvedVoiceCapability === 'voice-id' ? catalogForDraft?.voices ?? [] : []}
            capability={selectedModel ? resolvedVoiceCapability : 'no-voice'}
            disabled={actionDisabled || !selectedModel}
            onChange={(voices) => selectedModel && updateModelVoices(selectedModel.id, voices)}
          />
        </SettingsSection>
        {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
        {loadError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border border-destructive/30 px-3 py-2 text-xs text-destructive"><span>{loadError}</span><Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void controller.load()}>重新加载</Button></div>}
        {testState && <p role="status" className="text-xs text-muted-foreground">{testState.message}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={controller.closeDraft}>取消</Button>
          <Button type="button" disabled={actionDisabled} onClick={() => void controller.saveDraft()}>{saving ? <Loader2 className="animate-spin" /> : null}保存</Button>
        </div>
      </MediaSettingsPage>
    )
  }

  return (
    <MediaSettingsPage title="音频生成" action={<Button type="button" size="sm" disabled={loading || actionDisabled} onClick={controller.startCreate}><Plus />添加音频配置</Button>} headerContent={headerContent}>
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
          return <SettingsRow key={legacy.id} label={legacy.name} description={`旧配置，需要重新填写独立凭据 · ${legacy.modelId}`}><Button type="button" size="sm" variant="outline" disabled={actionDisabled || migrated} onClick={() => controller.startMigration(legacy.id)}>{migrated ? '已迁移' : `迁移 ${legacy.name}`}</Button></SettingsRow>
        })}
      </SettingsCard>}
      {loading && !settings ? <SettingsCard divided={false}><div className="px-4 py-8 text-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />正在读取音频配置...</div></SettingsCard>
        : settings && settings.catalog.profiles.length === 0 ? <SettingsCard divided={false}><div className="px-4 py-8 text-center text-sm text-muted-foreground">尚未配置音频生成服务</div></SettingsCard>
          : settings && visibleProfiles.length === 0 ? <SettingsCard divided={false}><div className="px-4 py-8 text-center text-sm text-muted-foreground">没有匹配的音频配置</div></SettingsCard>
            : <SettingsCard>{visibleProfiles.map((profile) => {
                const testState = testStates[profile.id]
                return <SettingsRow key={profile.id} label={profile.name} icon={<Volume2 className="size-5 text-muted-foreground" />} description={<><span>{PROVIDER_LABELS[profile.provider]} · {voiceSummary(profile.models)}</span><span className="block">{profile.endpointOrigin} · {profile.credentialConfigured ? '凭据已配置' : '缺少凭据'} · {testState?.message ?? '未验证'}</span></>}><div className="flex flex-wrap items-center justify-end gap-1"><Switch checked={profile.enabled} disabled={actionDisabled} aria-label={`${profile.enabled ? '停用' : '启用'} ${profile.name}`} onCheckedChange={(enabled) => void controller.toggleEnabled(profile, enabled)} /><Button type="button" size="icon-sm" variant="ghost" aria-label={`测试 ${profile.name}`} title="测试连接" disabled={actionDisabled} onClick={() => void controller.testProfile(profile)}>{testState?.state === 'loading' ? <Loader2 className="animate-spin" /> : <TestTube2 />}</Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`复制 ${profile.name}`} title="复制" disabled={actionDisabled} onClick={() => controller.startCopy(profile)}><Copy /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`编辑 ${profile.name}`} title="编辑" disabled={actionDisabled} onClick={() => controller.startEdit(profile)}><Pencil /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`删除 ${profile.name}`} title="删除" disabled={actionDisabled} onClick={() => controller.requestDelete(profile.id)}><Trash2 /></Button></div></SettingsRow>
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
    fetchCatalog: (input) => window.electronAPI.mediaFetchAudioGenerationCatalog(input),
  }), [])
  const controller = useAudioGenerationSettingsController({ api })
  return <AudioGenerationCatalogView {...props} controller={controller} />
}
