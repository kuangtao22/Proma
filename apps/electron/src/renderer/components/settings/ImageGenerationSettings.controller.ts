/**
 * 独立生图设置页的控制器。
 *
 * 负责读取、CAS 保存、复制、启停、删除与「从供应商获取」的请求生命周期，
 * 与音频页保持同一语义：冲突/结果未知一律重新读取权威目录并给出稳定提示，
 * 拉取结果绑定草稿身份，草稿变化后迟到结果不会再影响界面。
 */
import * as React from 'react'
import type {
  ImageGenerationCatalogFetchInput,
  ImageGenerationCatalogFetchResult,
  ImageGenerationModelEntry,
  ImageGenerationSettingsResult,
  ImageGenerationPublicProfile,
  ReplaceImageGenerationCatalogRequest,
} from '@proma/shared'
import {
  copyImageGenerationProfile,
  createImageGenerationDraft,
  draftToProfile,
  filterImageGenerationProfiles,
  imageProfileFingerprint,
  imageProfileIdentity,
  IMAGE_PROVIDER_LABELS,
  profileToDraft,
  type ImageGenerationDraft,
} from './ImageGenerationSettings.logic'

/** Controller 依赖的最小 IPC 边界，测试与真实 Electron 共用。 */
export interface ImageGenerationSettingsApi {
  getSettings: () => Promise<ImageGenerationSettingsResult>
  replaceCatalog: (request: ReplaceImageGenerationCatalogRequest) => Promise<ImageGenerationSettingsResult>
  fetchCatalog: (input: ImageGenerationCatalogFetchInput) => Promise<ImageGenerationCatalogFetchResult>
}

/** 供应商目录拉取的展示状态；draftIdentity 保证迟到结果不串草稿。 */
export interface ImageGenerationCatalogViewState {
  state: 'loading' | 'success' | 'failed'
  message?: string
  models: ImageGenerationModelEntry[]
  draftIdentity: string
}

/** 设置页视图与行为测试共用的生产 Controller。 */
export interface ImageGenerationController {
  settings: ImageGenerationSettingsResult | null
  loading: boolean
  saving: boolean
  loadError: string | null
  actionError: string | null
  query: string
  draft: ImageGenerationDraft | null
  deleteId: string | null
  catalog: ImageGenerationCatalogViewState | null
  visibleProfiles: ImageGenerationPublicProfile[]
  setQuery: (query: string) => void
  load: () => Promise<boolean>
  startCreate: () => void
  startEdit: (profile: ImageGenerationPublicProfile) => void
  startCopy: (profile: ImageGenerationPublicProfile) => void
  updateDraft: (draft: ImageGenerationDraft) => void
  closeDraft: () => void
  saveDraft: () => Promise<void>
  toggleEnabled: (profile: ImageGenerationPublicProfile, enabled: boolean) => Promise<void>
  requestDelete: (profileId: string) => void
  closeDelete: () => void
  confirmDelete: () => Promise<void>
  fetchCatalog: () => Promise<void>
}

/** 生成稳定且不重复的草稿 ID。 */
function createImageGenerationId(): string {
  return `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 生图读取的超时时间；主进程未响应时也要给出可见错误而不是一直转圈。 */
const IMAGE_GENERATION_LOAD_TIMEOUT_MS = 5_000

/**
 * 给 IPC 调用加超时。
 * 入参：待等待的 promise 与超时毫秒；返回值：原结果或超时错误。
 * 典型触发场景是主进程仍是旧构建、通道尚未注册。
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('IMAGE_GENERATION_LOAD_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 把主进程错误翻译成可操作的中文提示，不泄露原始异常正文。 */
/**
 * 把读取失败翻译成可操作提示。
 * 入参：读取阶段的异常；返回值：面向用户的中文文案。
 * preload 缺失与主进程超时都会给出“重启开发实例”的明确动作。
 */
function describeLoadError(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code === 'IMAGE_GENERATION_PRELOAD_MISSING') {
    return 'preload 未包含生图接口：请重启开发实例（仅刷新窗口不够）。'
  }
  if (code === 'IMAGE_GENERATION_LOAD_TIMEOUT') {
    return '读取生图配置超时：主进程可能仍是旧构建，请重启开发实例后重试。'
  }
  /** 非设置窗口（例如应用内浏览器）调用设置接口会被主进程拒绝，这里给出准确指引。 */
  if (code.includes('MEDIA_ACCESS_DENIED')) {
    return '当前窗口没有读取生图配置的权限：请从「媒体生成 → 生图模型」设置页打开，而不是从应用内浏览器。'
  }
  return '读取生图配置失败，请重试。'
}

/** 把主进程错误翻译成可操作的中文提示，不泄露原始异常正文。 */
function describeImageError(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code === 'IMAGE_GENERATION_CONFIG_CONFLICT' || code === 'IMAGE_GENERATION_CONFIG_OUTCOME_UNKNOWN') {
    return '配置已被其他窗口修改，已重新读取权威目录，请重新应用改动。'
  }
  if (code === 'IMAGE_GENERATION_CREDENTIAL_PRESERVE_INVALID') return '新增配置必须填写 API Key。'
  if (code === 'IMAGE_GENERATION_CONFIG_INVALID' || code === 'IMAGE_GENERATION_URL_INVALID') {
    return '请完整填写有效的名称、服务地址与至少一个模型。'
  }
  return '保存失败，请稍后重试。'
}

/** 只保留不含凭据的公开展示字段用于列表摘要。 */
export function imageSettingsApiFromWindow(): ImageGenerationSettingsApi {
  return {
    getSettings: () => {
      /** preload 未更新时接口不存在，抛出可识别的稳定错误。 */
      const call = window.electronAPI?.mediaGetImageGenerationSettings
      if (typeof call !== 'function') throw new Error('IMAGE_GENERATION_PRELOAD_MISSING')
      return call()
    },
    replaceCatalog: (request) => window.electronAPI.mediaReplaceImageGenerationCatalog(request),
    fetchCatalog: (input) => window.electronAPI.mediaFetchImageGenerationCatalog(input),
  }
}

/** 创建独立生图设置页的生产控制器。 */
export function useImageGenerationController(api: ImageGenerationSettingsApi): ImageGenerationController {
  const [settings, setSettings] = React.useState<ImageGenerationSettingsResult | null>(null)
  /** 初始不进入 loading：读取失败或悬住时页面仍必须可操作（例如新增配置）。 */
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const [draft, setDraft] = React.useState<ImageGenerationDraft | null>(null)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)
  const [catalog, setCatalog] = React.useState<ImageGenerationCatalogViewState | null>(null)
  /** 编辑基线用于检测外部修改；保存成功后更新。 */
  const baselineRef = React.useRef<{ id: string; fingerprint: string } | null>(null)
  /** 所有异步回调据此判断组件是否仍然挂载。 */
  const mountedRef = React.useRef(true)
  React.useEffect(() => () => { mountedRef.current = false }, [])

  /** 读取独立目录；失败保持稳定提示而不会清空已有内容。 */
  const load = React.useCallback(async (): Promise<boolean> => {
    /** 先记录发起时刻：能区分“没发起”与“发起了但主进程没回”两种卡住。 */
    console.info('[生图配置] 开始读取 settings')
    setLoading(true)
    try {
      const next = await withTimeout(api.getSettings(), IMAGE_GENERATION_LOAD_TIMEOUT_MS)
      if (!mountedRef.current) return false
      setSettings(next)
      setLoadError(null)
      return true
    } catch (error) {
      /** 原始异常只进控制台，界面只显示稳定文案；超时单独提示。 */
      console.error('[生图配置] 读取失败', error)
      if (mountedRef.current) {
        setLoadError(describeLoadError(error))
      }
      return false
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [api])

  React.useEffect(() => { void load() }, [load])

  /** 保存草稿并提供冲突/结果未知后的重新读取。 */
  const saveDraft = React.useCallback(async (): Promise<void> => {
    if (!settings || !draft || saving) return
    setSaving(true)
    setActionError(null)
    try {
      const profile = draftToProfile(draft)
      const existingIndex = settings.catalog.profiles.findIndex((candidate) => candidate.id === profile.id)
      const baseline = baselineRef.current
      if (existingIndex >= 0 && baseline && baseline.id === profile.id) {
        const current = settings.catalog.profiles[existingIndex]!
        if (imageProfileFingerprint(current) !== baseline.fingerprint) {
          setActionError('目标已被其他窗口修改，已重新读取权威目录，请重新应用改动。')
          await load()
          return
        }
      }
      /** 完整替换目录：其它条目按原样提交，凭据保持不动。 */
      /** 其它条目按原样提交，凭据一律保持不动。 */
      const entries: ReplaceImageGenerationCatalogRequest['profiles'] = settings.catalog.profiles.map((candidate) => ({
        profile: candidate,
        credentialUpdate: { mode: 'preserve' as const },
      }))
      const nextEntry: ReplaceImageGenerationCatalogRequest['profiles'][number] = {
        profile: draftToProfile({ ...draft, updatedAt: Date.now() }),
        credentialUpdate: draft.apiKey.trim()
          ? { mode: 'replace' as const, apiKey: draft.apiKey.trim() }
          : { mode: 'preserve' as const },
      }
      if (existingIndex >= 0) entries[existingIndex] = nextEntry
      else entries.push(nextEntry)
      const saved = await api.replaceCatalog({ expectedRevision: settings.catalog.revision, profiles: entries })
      if (!mountedRef.current) return
      setSettings(saved)
      baselineRef.current = null
      setDraft(null)
      /** 保存成功后失效该草稿的拉取结果。 */
      setCatalog(null)
    } catch (error) {
      if (!mountedRef.current) return
      setActionError(describeImageError(error))
      /** 冲突或结果未知时必须重新读取权威目录，避免继续基于旧快照写入。 */
      const code = error instanceof Error ? error.message : ''
      if (code === 'IMAGE_GENERATION_CONFIG_CONFLICT' || code === 'IMAGE_GENERATION_CONFIG_OUTCOME_UNKNOWN') {
        await load()
      }
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [api, draft, load, saving, settings])

  /** 快捷启停仍完整替换目录，所有凭据保持不变。 */
  const toggleEnabled = React.useCallback(async (profile: ImageGenerationPublicProfile, enabled: boolean): Promise<void> => {
    if (!settings || saving) return
    setSaving(true)
    setActionError(null)
    try {
      const entries = settings.catalog.profiles.map((candidate) => ({
        profile: candidate.id === profile.id
          ? { ...candidate, enabled, updatedAt: Date.now() }
          : candidate,
        credentialUpdate: { mode: 'preserve' as const },
      }))
      const saved = await api.replaceCatalog({ expectedRevision: settings.catalog.revision, profiles: entries })
      if (mountedRef.current) setSettings(saved)
    } catch (error) {
      if (mountedRef.current) setActionError(describeImageError(error))
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [api, saving, settings])

  /** 删除同样走整目录 CAS，避免局部写引入不一致。 */
  const confirmDelete = React.useCallback(async (): Promise<void> => {
    if (!settings || !deleteId || saving) return
    setSaving(true)
    setActionError(null)
    try {
      const entries = settings.catalog.profiles
        .filter((candidate) => candidate.id !== deleteId)
        .map((candidate) => ({ profile: candidate, credentialUpdate: { mode: 'preserve' as const } }))
      const saved = await api.replaceCatalog({ expectedRevision: settings.catalog.revision, profiles: entries })
      if (!mountedRef.current) return
      setSettings(saved)
      setDeleteId(null)
    } catch (error) {
      /** 删除失败保留弹窗目标，用户可直接重试。 */
      if (mountedRef.current) setActionError(describeImageError(error))
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [api, deleteId, saving, settings])

  /** 从供应商拉取模型；结果只在同一草稿身份下展示。 */
  const fetchCatalog = React.useCallback(async (): Promise<void> => {
    const currentDraft = draft
    if (!currentDraft) return
    const identity = imageProfileIdentity(draftToProfile({ ...currentDraft, updatedAt: currentDraft.createdAt }))
    setCatalog({ state: 'loading', models: [], draftIdentity: identity })
    try {
      const credential = currentDraft.provider === 'dreamina'
        ? { mode: 'none' as const }
        : currentDraft.apiKey.trim()
          ? { mode: 'draft' as const, apiKey: currentDraft.apiKey.trim() }
          : { mode: 'saved' as const, profileId: currentDraft.id }
      const result = await api.fetchCatalog({
        requestId: createImageGenerationId(),
        provider: currentDraft.provider,
        ...(currentDraft.provider === 'dreamina' ? {} : { baseUrl: currentDraft.baseUrl }),
        ...(currentDraft.provider === 'minimax' && currentDraft.groupId?.trim()
          ? { groupId: currentDraft.groupId.trim() }
          : {}),
        credential,
      })
      if (!mountedRef.current) return
      setCatalog({ state: result.state, message: result.message, models: result.models, draftIdentity: identity })
    } catch (error) {
      if (!mountedRef.current) return
      setCatalog({
        state: 'failed',
        message: error instanceof Error && error.message === 'IMAGE_GENERATION_CONFIG_INVALID'
          ? '请先完整填写服务地址与凭据。'
          : '从供应商获取失败，请检查服务地址与凭据。',
        models: [],
        draftIdentity: identity,
      })
    }
  }, [api, draft])

  return {
    settings, loading, saving, loadError, actionError, query, draft, deleteId, catalog,
    visibleProfiles: filterImageGenerationProfiles(settings?.catalog.profiles ?? [], query),
    setQuery,
    load,
    startCreate: () => {
      baselineRef.current = null
      setActionError(null)
      setCatalog(null)
      /** 新配置默认第一家供应商（即梦），与音频页默认第一家的做法一致。 */
      setDraft(createImageGenerationDraft('dreamina', createImageGenerationId(), Date.now()))
    },
    startEdit: (profile) => {
      baselineRef.current = { id: profile.id, fingerprint: imageProfileFingerprint(profile) }
      setActionError(null)
      setCatalog(null)
      setDraft(profileToDraft(profile))
    },
    startCopy: (profile) => {
      baselineRef.current = null
      setActionError(null)
      setCatalog(null)
      setDraft(copyImageGenerationProfile(profile, createImageGenerationId(), Date.now()))
    },
    updateDraft: setDraft,
    closeDraft: () => { setDraft(null); setCatalog(null); setActionError(null) },
    saveDraft,
    toggleEnabled,
    requestDelete: setDeleteId,
    closeDelete: () => { setDeleteId(null); setActionError(null) },
    confirmDelete,
    fetchCatalog,
  }
}
