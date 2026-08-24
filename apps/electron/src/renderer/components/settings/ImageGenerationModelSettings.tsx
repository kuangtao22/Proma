import * as React from 'react'
import type {
  ImageGenerationChannelOption,
  ImageGenerationModelCatalogResult,
  ImageGenerationModelProfile,
} from '@proma/shared'
import {
  IMAGE_GENERATION_MODEL_ID_MAX_LENGTH,
  IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH,
} from '@proma/shared'
import { Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsCard, SettingsSection } from './primitives'

interface ImageGenerationModelSettingsViewProps {
  /** 当前可编辑的生图模型列表。 */
  profiles: ImageGenerationModelProfile[]
  /** 模型配置页提供的清洗渠道与启用模型。 */
  channelOptions?: ImageGenerationChannelOption[]
  /** Nano Banana 公共凭据是否已配置。 */
  credentialsConfigured: boolean
  /** 当前是否正在保存完整模型目录。 */
  saving: boolean
  /** 后台发现权威目录已变化，等待用户决定是否重载。 */
  externalUpdatePending?: boolean
  /** 最近一次后台读取错误，不隐藏当前表单。 */
  loadError?: string | null
  /** 用户触发的重载或重试是否仍在进行。 */
  reloadInProgress?: boolean
  /** 用户明确放弃本地编辑并重新加载权威目录。 */
  onReload?: () => void
  /** 用户在保留表单的前提下重试后台读取。 */
  onRetry?: () => void
  /** 模型列表发生编辑时回传完整列表。 */
  onProfilesChange: (profiles: ImageGenerationModelProfile[]) => void
  /** 用户请求保存完整模型目录。 */
  onSave: () => void
}

/** 生图模型设置的可预测加载与编辑状态。 */
export interface ImageGenerationModelSettingsState {
  profiles: ImageGenerationModelProfile[]
  baselineProfiles: ImageGenerationModelProfile[]
  channelOptions: ImageGenerationChannelOption[]
  credentialsConfigured: boolean
  initialLoading: boolean
  loadError: string | null
  dirty: boolean
  externalUpdatePending: boolean
  requestGeneration: number
  requestEditGeneration: number
  editGeneration: number
}

type ImageGenerationModelSettingsAction =
  | { type: 'profiles-edited'; profiles: ImageGenerationModelProfile[] }
  | { type: 'request-started'; requestGeneration: number; mode: 'initial' | 'background' | 'reload' }
  | { type: 'request-succeeded'; requestGeneration: number; mode: 'initial' | 'background' | 'reload'; result: ImageGenerationModelCatalogResult }
  | { type: 'request-failed'; requestGeneration: number; message: string }
  | { type: 'save-succeeded'; result: ImageGenerationModelCatalogResult }

/** 判断保存命令能否在当前同步互斥状态下执行。 */
export function canStartImageGenerationModelSave(
  savingInProgress: boolean,
  reloadInProgress: boolean,
): boolean {
  return !savingInProgress && !reloadInProgress
}

/** 创建一条尚待填写的新生图模型配置。 */
export function createImageGenerationModelProfile(
  id: string,
  now: number,
): ImageGenerationModelProfile {
  return {
    id,
    name: 'GPT Image 2',
    executor: 'openai-images',
    channelId: '',
    modelId: '',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
}

/** 在提交 IPC 前检查 Renderer 可直接修正的模型目录问题。 */
export function validateImageGenerationModelProfiles(
  profiles: readonly ImageGenerationModelProfile[],
  channelOptions?: readonly ImageGenerationChannelOption[],
): string | null {
  /** 已出现的稳定 profile ID。 */
  const seenIds = new Set<string>()

  for (const [index, profile] of profiles.entries()) {
    if (!profile.name.trim()) return `第 ${index + 1} 个生图模型缺少名称`
    if (profile.name.length > IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH) {
      return `生图模型名称不能超过 ${IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH} 个字符`
    }
    if (profile.executor === 'openai-images' && !profile.channelId.trim()) return '请选择模型配置'
    if (!profile.modelId.trim()) return profile.executor === 'openai-images'
      ? '请选择生图模型'
      : `生图模型「${profile.name.trim()}」缺少模型 ID`
    if (profile.modelId.length > IMAGE_GENERATION_MODEL_ID_MAX_LENGTH) {
      return `生图模型「${profile.name.trim()}」的模型 ID 不能超过 ${IMAGE_GENERATION_MODEL_ID_MAX_LENGTH} 个字符`
    }
    if (!profile.id.trim()) return `第 ${index + 1} 个生图模型缺少配置 ID`
    if (seenIds.has(profile.id)) return '生图模型配置 ID 重复，请删除重复项后重试'
    seenIds.add(profile.id)
    if (profile.executor === 'openai-images' && channelOptions) {
      const channel = channelOptions.find((candidate) => candidate.channelId === profile.channelId)
      if (!channel) return '所选模型配置已不存在'
      if (!channel.models.some((model) => model.id === profile.modelId)) return '所选生图模型已不存在'
    }
  }

  return null
}

/** 返回渠道引用 profile 当前可选的启用模型。 */
export function getImageGenerationProfileModels(
  profile: ImageGenerationModelProfile,
  channelOptions: readonly ImageGenerationChannelOption[],
): ImageGenerationChannelOption['models'] {
  if (profile.executor !== 'openai-images') return []
  return channelOptions.find((channel) => channel.channelId === profile.channelId)?.models ?? []
}

/** 把编辑态整理为可持久化的完整 profile 列表。 */
function prepareProfilesForSave(
  profiles: readonly ImageGenerationModelProfile[],
  baselineProfiles: readonly ImageGenerationModelProfile[],
  now: number,
): ImageGenerationModelProfile[] {
  /** 按稳定 ID 索引的权威 profile。 */
  const baselineById = new Map(baselineProfiles.map((profile) => [profile.id, profile]))
  return profiles.map((profile) => {
    /** 去除用户输入两端空白后的编辑值。 */
    const normalized: ImageGenerationModelProfile = profile.executor === 'openai-images'
      ? {
          ...profile,
          channelId: profile.channelId.trim(),
          name: profile.name.trim(),
          modelId: profile.modelId.trim(),
        }
      : { ...profile, name: profile.name.trim(), modelId: profile.modelId.trim() }
    /** 当前行对应的权威 baseline。 */
    const baseline = baselineById.get(profile.id)
    if (!baseline) return { ...normalized, updatedAt: now }
    /** 只有用户可编辑字段变化时才推进更新时间。 */
    const changed = normalized.name !== baseline.name
      || normalized.modelId !== baseline.modelId
      || normalized.enabled !== baseline.enabled
      || normalized.executor !== baseline.executor
      || (normalized.executor === 'openai-images'
        && (baseline.executor !== 'openai-images' || normalized.channelId !== baseline.channelId))
    return changed
      ? { ...normalized, createdAt: baseline.createdAt, updatedAt: now }
      : baseline
  })
}

/** 导出保存整理函数，锁定时间戳与权威 baseline 语义。 */
export const prepareImageGenerationModelProfilesForSave = prepareProfilesForSave

/** 比较两份目录的稳定身份和用户可编辑字段。 */
function haveSameEditableProfiles(
  left: readonly ImageGenerationModelProfile[],
  right: readonly ImageGenerationModelProfile[],
): boolean {
  return left.length === right.length && left.every((profile, index) => {
    /** 同一顺序位置的对照 profile。 */
    const other = right[index]
    return other !== undefined
      && profile.executor === other.executor
      && profile.id === other.id
      && profile.name.trim() === other.name
      && profile.modelId.trim() === other.modelId
      && profile.enabled === other.enabled
      && (profile.executor !== 'openai-images'
        || (other.executor === 'openai-images' && profile.channelId.trim() === other.channelId))
  })
}

/** 创建初始或已加载的生图模型设置状态。 */
export function createImageGenerationModelSettingsState(
  catalog?: ImageGenerationModelCatalogResult,
): ImageGenerationModelSettingsState {
  return {
    profiles: catalog?.profiles ?? [],
    baselineProfiles: catalog?.profiles ?? [],
    channelOptions: catalog?.channelOptions ?? [],
    credentialsConfigured: catalog?.credentialsConfigured ?? false,
    initialLoading: catalog === undefined,
    loadError: null,
    dirty: false,
    externalUpdatePending: false,
    requestGeneration: 0,
    requestEditGeneration: 0,
    editGeneration: 0,
  }
}

/** 归约加载、乱序响应、外部变化和本地编辑，避免后台刷新覆盖 dirty 表单。 */
export function reduceImageGenerationModelSettingsState(
  state: ImageGenerationModelSettingsState,
  action: ImageGenerationModelSettingsAction,
): ImageGenerationModelSettingsState {
  switch (action.type) {
    case 'profiles-edited':
      return {
        ...state,
        profiles: action.profiles,
        dirty: !haveSameEditableProfiles(action.profiles, state.baselineProfiles),
        editGeneration: state.editGeneration + 1,
      }
    case 'request-started':
      return {
        ...state,
        requestGeneration: action.requestGeneration,
        requestEditGeneration: state.editGeneration,
        initialLoading: action.mode === 'initial' && state.baselineProfiles.length === 0,
        loadError: null,
      }
    case 'request-succeeded': {
      if (action.requestGeneration !== state.requestGeneration) return state
      /** dirty 后台刷新只更新凭据；目录变化留给用户明确重载。 */
      const editedAfterRequest = state.editGeneration !== state.requestEditGeneration
      const preserveEditing = (action.mode === 'background' && state.dirty)
        || (action.mode === 'reload' && editedAfterRequest)
      if (preserveEditing) {
        return {
          ...state,
          credentialsConfigured: action.result.credentialsConfigured,
          channelOptions: action.result.channelOptions,
          initialLoading: false,
          loadError: null,
          externalUpdatePending: action.mode === 'reload' || !haveSameEditableProfiles(
              action.result.profiles,
              state.baselineProfiles,
            ),
        }
      }
      return {
        ...state,
        profiles: action.result.profiles,
        baselineProfiles: action.result.profiles,
        credentialsConfigured: action.result.credentialsConfigured,
        channelOptions: action.result.channelOptions,
        initialLoading: false,
        loadError: null,
        dirty: false,
        externalUpdatePending: false,
      }
    }
    case 'request-failed':
      if (action.requestGeneration !== state.requestGeneration) return state
      return {
        ...state,
        initialLoading: false,
        loadError: action.message,
      }
    case 'save-succeeded':
      return {
        ...state,
        profiles: action.result.profiles,
        baselineProfiles: action.result.profiles,
        credentialsConfigured: action.result.credentialsConfigured,
        channelOptions: action.result.channelOptions,
        dirty: false,
        externalUpdatePending: false,
        loadError: null,
        requestGeneration: state.requestGeneration + 1,
        requestEditGeneration: state.editGeneration,
      }
  }
}

/** 渲染无嵌套卡片的生图模型配置列表。 */
export function ImageGenerationModelSettingsView({
  profiles,
  channelOptions = [],
  credentialsConfigured,
  saving,
  externalUpdatePending = false,
  loadError = null,
  reloadInProgress = false,
  onReload,
  onRetry,
  onProfilesChange,
  onSave,
}: ImageGenerationModelSettingsViewProps): React.ReactElement {
  /** 当前列表的本地校验结果。 */
  const validationError = validateImageGenerationModelProfiles(profiles, channelOptions)
  /** 名称或模型 ID 错误已经在字段旁显示，无需重复卡片级摘要。 */
  const hasFieldValidationError = profiles.some((profile) => (
    !profile.name.trim()
      || profile.name.length > IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH
      || !profile.modelId.trim()
      || profile.modelId.length > IMAGE_GENERATION_MODEL_ID_MAX_LENGTH
  ))
  /** 保存动作是否应被阻断。 */
  const nanoCredentialsMissing = profiles.some((profile) => profile.executor === 'nano-banana')
    && !credentialsConfigured
  const saveDisabled = saving
    || reloadInProgress
    || profiles.length === 0
    || nanoCredentialsMissing
    || validationError !== null

  /** 更新指定 profile，同时保留其它行顺序。 */
  const updateProfile = (
    profileId: string,
    update: (profile: ImageGenerationModelProfile) => ImageGenerationModelProfile,
  ): void => {
    onProfilesChange(profiles.map((profile) => (
      profile.id === profileId ? update(profile) : profile
    )))
  }

  /** 切换渠道后自动选择该渠道首个启用模型。 */
  const updateChannel = (profileId: string, channelId: string): void => {
    const channel = channelOptions.find((candidate) => candidate.channelId === channelId)
    updateProfile(profileId, (profile) => profile.executor === 'openai-images'
      ? { ...profile, channelId, modelId: channel?.models[0]?.id ?? '' }
      : profile)
  }

  /** 删除指定 profile。 */
  const removeProfile = (profileId: string): void => {
    onProfilesChange(profiles.filter((profile) => profile.id !== profileId))
  }

  /** 在 Renderer 生成稳定 ID 和一致时间戳后追加空白 profile。 */
  const addProfile = (): void => {
    /** 新配置的创建时间。 */
    const now = Date.now()
    onProfilesChange([
      ...profiles,
      createImageGenerationModelProfile(globalThis.crypto.randomUUID(), now),
    ])
  }

  return (
    <SettingsCard divided className="rounded">
      {nanoCredentialsMissing && (
        <div role="alert" className="px-4 py-3 text-xs text-destructive">
          请先配置 Nano Banana API Key，配置完成后才能保存和使用生图模型。
        </div>
      )}

      {externalUpdatePending && (
        <div aria-live="polite" className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground">
          <span>外部配置已更新，本地未保存编辑仍保留。</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 rounded text-xs"
            disabled={saving || reloadInProgress}
            onClick={onReload}
          >
            重新加载
          </Button>
        </div>
      )}

      {loadError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-destructive">
          <span>{loadError}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 rounded text-xs"
            disabled={saving || reloadInProgress}
            onClick={onRetry}
          >
            重试
          </Button>
        </div>
      )}

      {profiles.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="text-xs text-muted-foreground">尚未配置生图模型</p>
        </div>
      ) : profiles.map((profile, index) => {
        /** 名称输入的稳定错误说明 ID。 */
        const nameErrorId = `image-model-${index}-name-error`
        /** 模型 ID 输入的稳定错误说明 ID。 */
        const modelIdErrorId = `image-model-${index}-model-id-error`
        /** 当前名称是否为空或超过共享持久化上限。 */
        const nameInvalid = !profile.name.trim()
          || profile.name.length > IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH
        /** 当前真实模型 ID 是否为空或超过共享持久化上限。 */
        const modelIdInvalid = !profile.modelId.trim()
          || profile.modelId.length > IMAGE_GENERATION_MODEL_ID_MAX_LENGTH
        /** 名称字段旁的可操作错误。 */
        const nameError = !profile.name.trim()
          ? '请输入名称'
          : `名称不能超过 ${IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH} 个字符`
        /** 模型 ID 字段旁的可操作错误。 */
        const modelIdError = !profile.modelId.trim()
          ? '请输入模型 ID'
          : `模型 ID 不能超过 ${IMAGE_GENERATION_MODEL_ID_MAX_LENGTH} 个字符`
        return (
        <div key={profile.id} className="flex flex-wrap items-end gap-3 px-4 py-3">
          <label className="min-w-40 flex-1 space-y-1">
            <span className="block text-xs font-medium text-foreground">名称</span>
            <Input
              aria-label={`生图模型名称 ${profile.name || profile.id}`}
              aria-invalid={nameInvalid}
              aria-describedby={nameInvalid ? nameErrorId : undefined}
              className="h-8 rounded px-2.5 text-xs"
              disabled={saving}
              maxLength={IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH}
              value={profile.name}
              placeholder="例如：快速出图"
              onChange={(event) => updateProfile(profile.id, (current) => ({ ...current, name: event.target.value }))}
            />
            {nameInvalid && <span id={nameErrorId} role="alert" className="block text-xs text-destructive">{nameError}</span>}
          </label>
          {profile.executor === 'openai-images' && (
            <div className="min-w-48 flex-1 space-y-1">
              <span className="block text-xs font-medium text-foreground">模型配置</span>
              <Select value={profile.channelId || undefined} disabled={saving} onValueChange={(value) => updateChannel(profile.id, value)}>
                <SelectTrigger className="h-8 min-w-0 rounded text-xs" aria-label={`模型配置 ${profile.name || profile.id}`}>
                  <SelectValue placeholder="选择模型配置" />
                </SelectTrigger>
                <SelectContent>
                  {channelOptions.map((channel) => (
                    <SelectItem key={channel.channelId} value={channel.channelId} disabled={!channel.available}>
                      {channel.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {profile.executor === 'nano-banana' ? <label className="min-w-52 flex-[1.4] space-y-1">
            <span className="block text-xs font-medium text-foreground">模型 ID</span>
            <Input
              aria-label={`生图模型 ID ${profile.name || profile.id}`}
              aria-invalid={modelIdInvalid}
              aria-describedby={modelIdInvalid ? modelIdErrorId : undefined}
              className="h-8 rounded px-2.5 font-mono text-xs"
              disabled={saving}
              maxLength={IMAGE_GENERATION_MODEL_ID_MAX_LENGTH}
              value={profile.modelId}
              placeholder="gemini-3.1-flash-image-preview"
              onChange={(event) => updateProfile(profile.id, (current) => ({ ...current, modelId: event.target.value }))}
            />
            {modelIdInvalid && <span id={modelIdErrorId} role="alert" className="block text-xs text-destructive">{modelIdError}</span>}
          </label> : (
            <div className="min-w-48 flex-1 space-y-1">
              <span className="block text-xs font-medium text-foreground">模型</span>
              <Select
                value={profile.modelId || undefined}
                disabled={saving || !profile.channelId}
                onValueChange={(modelId) => updateProfile(profile.id, (current) => current.executor === 'openai-images'
                  ? { ...current, modelId }
                  : current)}
              >
                <SelectTrigger className="h-8 min-w-0 rounded text-xs" aria-label={`生图模型 ${profile.name || profile.id}`}>
                  <SelectValue placeholder="选择生图模型" />
                </SelectTrigger>
                <SelectContent>
                  {getImageGenerationProfileModels(profile, channelOptions).map((model) => (
                    <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelIdInvalid && <span id={modelIdErrorId} role="alert" className="block text-xs text-destructive">{modelIdError}</span>}
            </div>
          )}
          <div className="min-w-32 space-y-1">
            <span className="block text-xs font-medium text-foreground">调用协议</span>
            <div className="flex h-8 items-center rounded border border-border bg-muted/30 px-2.5 text-xs text-muted-foreground">
              {profile.executor === 'openai-images' ? 'OpenAI Images' : 'Nano Banana'}
            </div>
          </div>
          <div className="flex h-8 items-center gap-2">
            <span className="text-xs text-muted-foreground">启用</span>
            <Switch
              aria-label={`启用生图模型 ${profile.name || profile.id}`}
              checked={profile.enabled}
              disabled={saving}
              onCheckedChange={(enabled) => updateProfile(profile.id, (current) => ({ ...current, enabled }))}
            />
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded text-muted-foreground hover:text-destructive"
            aria-label={`删除生图模型 ${profile.name || profile.id}`}
            title={`删除生图模型 ${profile.name || profile.id}`}
            disabled={saving}
            onClick={() => removeProfile(profile.id)}
          >
            <Trash2 />
          </Button>
        </div>
        )
      })}

      {validationError && !hasFieldValidationError && profiles.length > 0 && (
        <div role="alert" aria-live="polite" className="px-4 py-2 text-xs text-destructive">{validationError}</div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 rounded text-xs"
          disabled={saving}
          onClick={addProfile}
        >
          <Plus />
          新增模型
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-8 rounded text-xs"
          disabled={saveDisabled}
          onClick={onSave}
        >
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          {saving ? '保存中...' : '保存模型配置'}
        </Button>
      </div>
    </SettingsCard>
  )
}

/** 连接系统生图模型 IPC，并管理设置页加载与保存状态。 */
export function ImageGenerationModelSettings(): React.ReactElement {
  /** 设置页权威 baseline、编辑态与加载代次。 */
  const [state, dispatch] = React.useReducer(
    reduceImageGenerationModelSettingsState,
    undefined,
    () => createImageGenerationModelSettingsState(),
  )
  /** 当前目录是否正在保存。 */
  const [saving, setSaving] = React.useState(false)
  /** 用户主动重载或重试是否仍在执行。 */
  const [reloadInProgress, setReloadInProgress] = React.useState(false)
  /** 同步阻断连续点击在 React 提交前重复进入保存。 */
  const savingRef = React.useRef(false)
  /** 同步阻断保存期间或 React 提交前的重复重载。 */
  const reloadInProgressRef = React.useRef(false)
  /** 每次读取递增，旧响应由 reducer 拒绝。 */
  const requestGenerationRef = React.useRef(0)
  /** 卸载后拒绝迟到响应提交。 */
  const mountedRef = React.useRef(false)

  /** 从主进程刷新清洗后的非敏感模型目录。 */
  const loadProfiles = React.useCallback(async (
    mode: 'initial' | 'background' | 'reload',
  ): Promise<void> => {
    /** 本次读取的唯一请求代次。 */
    const requestGeneration = ++requestGenerationRef.current
    dispatch({ type: 'request-started', requestGeneration, mode })
    try {
      /** 主进程返回的模型目录及凭据可用状态。 */
      const result = await window.electronAPI.listImageModelProfiles()
      if (!mountedRef.current) return
      dispatch({ type: 'request-succeeded', requestGeneration, mode, result })
    } catch (error) {
      if (!mountedRef.current) return
      dispatch({
        type: 'request-failed',
        requestGeneration,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }, [])

  /** 串行执行用户主动的重载或重试，不影响表单继续编辑。 */
  const runInteractiveLoad = React.useCallback(async (
    mode: 'background' | 'reload',
  ): Promise<void> => {
    if (savingRef.current || reloadInProgressRef.current) return
    reloadInProgressRef.current = true
    setReloadInProgress(true)
    try {
      await loadProfiles(mode)
    } finally {
      reloadInProgressRef.current = false
      if (mountedRef.current) setReloadInProgress(false)
    }
  }, [loadProfiles])

  React.useEffect(() => {
    mountedRef.current = true
    void loadProfiles('initial')
    /** 其它窗口保存目录后的刷新订阅。 */
    const unsubscribe = window.electronAPI.onImageModelProfilesChanged(() => {
      void loadProfiles('background')
    })
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
      reloadInProgressRef.current = false
      unsubscribe()
    }
  }, [loadProfiles])

  /** 本地校验通过后完整替换系统模型目录。 */
  const handleSave = React.useCallback(async (): Promise<void> => {
    /** 当前编辑态的本地校验错误。 */
    const validationError = validateImageGenerationModelProfiles(state.profiles, state.channelOptions)
    if (validationError) {
      toast.error(validationError)
      return
    }
    if (
      (state.profiles.some((profile) => profile.executor === 'nano-banana') && !state.credentialsConfigured)
      || state.profiles.length === 0
      || !canStartImageGenerationModelSave(
        savingRef.current,
        reloadInProgressRef.current,
      )
    ) return

    savingRef.current = true
    setSaving(true)
    try {
      /** 提交前去除用户输入两端空白，并统一更新时间。 */
      const normalizedProfiles = prepareProfilesForSave(
        state.profiles,
        state.baselineProfiles,
        Date.now(),
      )
      /** 主进程原子保存后返回的权威目录。 */
      const result = await window.electronAPI.saveImageModelProfiles({ profiles: normalizedProfiles })
      if (!mountedRef.current) return
      requestGenerationRef.current += 1
      dispatch({ type: 'save-succeeded', result })
      toast.success('生图模型配置已保存')
    } catch (error) {
      if (mountedRef.current) {
        toast.error(error instanceof Error ? error.message : '生图模型配置保存失败')
      }
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }, [state.baselineProfiles, state.channelOptions, state.credentialsConfigured, state.profiles])

  return (
    <SettingsSection
      title="生图模型"
      description="Design 项目可独立选择这里启用的模型；名称用于识别，模型 ID 决定实际出图模型。"
    >
      {state.initialLoading ? (
        <SettingsCard divided={false} className="rounded">
          <div className="flex h-20 items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            正在读取生图模型...
          </div>
        </SettingsCard>
      ) : state.loadError && state.profiles.length === 0 ? (
        <SettingsCard divided={false} className="rounded">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p role="alert" className="text-xs text-destructive">生图模型加载失败：{state.loadError}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 rounded text-xs"
              disabled={reloadInProgress}
              onClick={() => { void runInteractiveLoad('reload') }}
            >
              重试
            </Button>
          </div>
        </SettingsCard>
      ) : (
        <ImageGenerationModelSettingsView
          profiles={state.profiles}
          channelOptions={state.channelOptions}
          credentialsConfigured={state.credentialsConfigured}
          saving={saving}
          reloadInProgress={reloadInProgress}
          externalUpdatePending={state.externalUpdatePending}
          loadError={state.loadError}
          onProfilesChange={(profiles) => dispatch({ type: 'profiles-edited', profiles })}
          onSave={() => { void handleSave() }}
          onReload={() => { void runInteractiveLoad('reload') }}
          onRetry={() => { void runInteractiveLoad('background') }}
        />
      )}
    </SettingsSection>
  )
}
