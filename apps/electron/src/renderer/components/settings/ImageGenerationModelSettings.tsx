import * as React from 'react'
import type { ImageGenerationModelProfile } from '@proma/shared'
import { Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsCard, SettingsSection } from './primitives'

interface ImageGenerationModelSettingsViewProps {
  /** 当前可编辑的生图模型列表。 */
  profiles: ImageGenerationModelProfile[]
  /** Nano Banana 公共凭据是否已配置。 */
  credentialsConfigured: boolean
  /** 当前是否正在保存完整模型目录。 */
  saving: boolean
  /** 模型列表发生编辑时回传完整列表。 */
  onProfilesChange: (profiles: ImageGenerationModelProfile[]) => void
  /** 用户请求保存完整模型目录。 */
  onSave: () => void
}

interface ImageGenerationModelSettingsProps {
  /** Nano Banana 凭据变化后触发重新读取的代次。 */
  refreshVersion?: number
}

/** 创建一条尚待填写的新生图模型配置。 */
export function createImageGenerationModelProfile(
  id: string,
  now: number,
): ImageGenerationModelProfile {
  return {
    id,
    name: '',
    executor: 'nano-banana',
    modelId: '',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
}

/** 在提交 IPC 前检查 Renderer 可直接修正的模型目录问题。 */
export function validateImageGenerationModelProfiles(
  profiles: readonly ImageGenerationModelProfile[],
): string | null {
  /** 已出现的稳定 profile ID。 */
  const seenIds = new Set<string>()

  for (const [index, profile] of profiles.entries()) {
    if (!profile.name.trim()) return `第 ${index + 1} 个生图模型缺少名称`
    if (!profile.modelId.trim()) return `生图模型「${profile.name.trim()}」缺少模型 ID`
    if (!profile.id.trim()) return `第 ${index + 1} 个生图模型缺少配置 ID`
    if (seenIds.has(profile.id)) return '生图模型配置 ID 重复，请删除重复项后重试'
    seenIds.add(profile.id)
  }

  return null
}

/** 把编辑态整理为可持久化的完整 profile 列表。 */
function prepareProfilesForSave(
  profiles: readonly ImageGenerationModelProfile[],
  now: number,
): ImageGenerationModelProfile[] {
  return profiles.map((profile) => ({
    ...profile,
    name: profile.name.trim(),
    modelId: profile.modelId.trim(),
    updatedAt: now,
  }))
}

/** 渲染无嵌套卡片的生图模型配置列表。 */
export function ImageGenerationModelSettingsView({
  profiles,
  credentialsConfigured,
  saving,
  onProfilesChange,
  onSave,
}: ImageGenerationModelSettingsViewProps): React.ReactElement {
  /** 当前列表的本地校验结果。 */
  const validationError = validateImageGenerationModelProfiles(profiles)
  /** 保存动作是否应被阻断。 */
  const saveDisabled = saving
    || profiles.length === 0
    || !credentialsConfigured
    || validationError !== null

  /** 更新指定 profile，同时保留其它行顺序。 */
  const updateProfile = (
    profileId: string,
    patch: Partial<Pick<ImageGenerationModelProfile, 'name' | 'modelId' | 'enabled'>>,
  ): void => {
    onProfilesChange(profiles.map((profile) => (
      profile.id === profileId ? { ...profile, ...patch } : profile
    )))
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
      {!credentialsConfigured && (
        <div className="px-4 py-3 text-xs text-destructive">
          请先配置 Nano Banana API Key，配置完成后才能保存和使用生图模型。
        </div>
      )}

      {profiles.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="text-xs text-muted-foreground">尚未配置生图模型</p>
        </div>
      ) : profiles.map((profile) => (
        <div key={profile.id} className="flex flex-wrap items-end gap-3 px-4 py-3">
          <label className="min-w-40 flex-1 space-y-1">
            <span className="block text-xs font-medium text-foreground">名称</span>
            <Input
              aria-label={`生图模型名称 ${profile.name || profile.id}`}
              className="h-8 rounded px-2.5 text-xs"
              disabled={saving}
              value={profile.name}
              placeholder="例如：快速出图"
              onChange={(event) => updateProfile(profile.id, { name: event.target.value })}
            />
          </label>
          <label className="min-w-52 flex-[1.4] space-y-1">
            <span className="block text-xs font-medium text-foreground">模型 ID</span>
            <Input
              aria-label={`生图模型 ID ${profile.name || profile.id}`}
              className="h-8 rounded px-2.5 font-mono text-xs"
              disabled={saving}
              value={profile.modelId}
              placeholder="gemini-3.1-flash-image-preview"
              onChange={(event) => updateProfile(profile.id, { modelId: event.target.value })}
            />
          </label>
          <div className="flex h-8 items-center gap-2">
            <span className="text-xs text-muted-foreground">启用</span>
            <Switch
              aria-label={`启用生图模型 ${profile.name || profile.id}`}
              checked={profile.enabled}
              disabled={saving}
              onCheckedChange={(enabled) => updateProfile(profile.id, { enabled })}
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
      ))}

      {validationError && profiles.length > 0 && (
        <div className="px-4 py-2 text-xs text-destructive">{validationError}</div>
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
export function ImageGenerationModelSettings({
  refreshVersion = 0,
}: ImageGenerationModelSettingsProps): React.ReactElement {
  /** 当前编辑中的模型列表。 */
  const [profiles, setProfiles] = React.useState<ImageGenerationModelProfile[]>([])
  /** Nano Banana 公共凭据是否可供模型使用。 */
  const [credentialsConfigured, setCredentialsConfigured] = React.useState(false)
  /** 首次加载是否仍在进行。 */
  const [loading, setLoading] = React.useState(true)
  /** 当前目录是否正在保存。 */
  const [saving, setSaving] = React.useState(false)
  /** 最近一次目录加载错误。 */
  const [loadError, setLoadError] = React.useState<string | null>(null)

  /** 从主进程刷新清洗后的非敏感模型目录。 */
  const loadProfiles = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      /** 主进程返回的模型目录及凭据可用状态。 */
      const result = await window.electronAPI.listImageModelProfiles()
      setProfiles(result.profiles)
      setCredentialsConfigured(result.credentialsConfigured)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadProfiles()
  }, [loadProfiles, refreshVersion])

  React.useEffect(() => {
    /** 其它窗口保存目录后的刷新订阅。 */
    const unsubscribe = window.electronAPI.onImageModelProfilesChanged(() => {
      void loadProfiles()
    })
    return unsubscribe
  }, [loadProfiles])

  /** 本地校验通过后完整替换系统模型目录。 */
  const handleSave = React.useCallback(async (): Promise<void> => {
    /** 当前编辑态的本地校验错误。 */
    const validationError = validateImageGenerationModelProfiles(profiles)
    if (validationError) {
      toast.error(validationError)
      return
    }
    if (!credentialsConfigured || profiles.length === 0) return

    setSaving(true)
    try {
      /** 提交前去除用户输入两端空白，并统一更新时间。 */
      const normalizedProfiles = prepareProfilesForSave(profiles, Date.now())
      /** 主进程原子保存后返回的权威目录。 */
      const result = await window.electronAPI.saveImageModelProfiles({ profiles: normalizedProfiles })
      setProfiles(result.profiles)
      setCredentialsConfigured(result.credentialsConfigured)
      toast.success('生图模型配置已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '生图模型配置保存失败')
    } finally {
      setSaving(false)
    }
  }, [credentialsConfigured, profiles])

  return (
    <SettingsSection
      title="生图模型"
      description="Design 项目可独立选择这里启用的模型；名称用于识别，模型 ID 决定实际出图模型。"
    >
      {loading ? (
        <SettingsCard divided={false} className="rounded">
          <div className="flex h-20 items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            正在读取生图模型...
          </div>
        </SettingsCard>
      ) : loadError ? (
        <SettingsCard divided={false} className="rounded">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p className="text-xs text-destructive">生图模型加载失败：{loadError}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 rounded text-xs"
              onClick={() => { void loadProfiles() }}
            >
              重试
            </Button>
          </div>
        </SettingsCard>
      ) : (
        <ImageGenerationModelSettingsView
          profiles={profiles}
          credentialsConfigured={credentialsConfigured}
          saving={saving}
          onProfilesChange={setProfiles}
          onSave={() => { void handleSave() }}
        />
      )}
    </SettingsSection>
  )
}
