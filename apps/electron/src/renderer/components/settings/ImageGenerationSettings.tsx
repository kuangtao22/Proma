/**
 * 独立生成供应商设置页：图片与视频模型合并到同一条供应商配置。
 *
 * 布局与音频生成页逐块对齐：基本信息（供应商类型 / 名称 / 服务地址 / API Key / 启用）、
 * 已启用模型、可用模型。即梦没有服务地址与 API Key，对应位置显示登录面板；
 * 旧统一媒体目录里的渠道型生图条目只读提示迁移，不再在这里被编辑。
 */
import * as React from 'react'
import type {
  ImageGenerationModelEntry,
  ImageGenerationPublicProfile,
  ImageGenerationProvider,
} from '@proma/shared'
import {
  IMAGE_GENERATION_CAPABILITY_LABELS,
  IMAGE_GENERATION_PROVIDER_DESCRIPTORS,
  imageGenerationModelKind,
} from '@proma/shared'
import { toast } from 'sonner'
import { CheckCircle2, Copy, Download, ExternalLink, Eye, EyeOff, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { getJimengLogo, getProviderLogo } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import { MediaSettingsPage } from './MediaSettingsPage'
import { SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsToggle } from './primitives'
import {
  imageSettingsApiFromWindow,
  useImageGenerationController,
  type ImageGenerationController,
} from './ImageGenerationSettings.controller'
import {
  changeImageGenerationProvider,
  IMAGE_PROVIDER_LABELS,
  imageCatalogIdentity,
  imageGenerationSummary,
  initialModelsForProvider,
  providerUsesApiKey,
  withDefaultCapabilities,
  type ImageGenerationDraft,
} from './ImageGenerationSettings.logic'

/** 页面插槽：与音频页保持一致，允许外部注入导航与头部内容。 */
export interface ImageGenerationSettingsProps {
  navigation?: React.ReactNode
  headerContent?: React.ReactNode
  children?: React.ReactNode
}

/**
 * 生成供应商到品牌 Logo 的显式映射。
 * 入参：生成供应商；返回值：Logo URL。
 * 即梦用官方图标，不能拿豆包等其它字节产品冒充。
 */
function imageProviderLogo(provider: ImageGenerationProvider): string {
  if (provider === 'dreamina') return getJimengLogo()
  return getProviderLogo(provider === 'openai-images' ? 'openai' : 'minimax')
}

/** 模型条目上的产物类别徽标，让图片与视频在同一列表里可分辨。 */
function ModelKindBadge({ model }: { model: ImageGenerationModelEntry }): React.ReactElement {
  const kind = imageGenerationModelKind(model)
  return (
    <span className={cn(
      'shrink-0 rounded px-1 py-0.5 text-[10px] leading-none',
      kind === 'video' ? 'bg-sky-500/10 text-sky-600' : 'bg-emerald-500/10 text-emerald-600',
    )}>
      {kind === 'video' ? '视频' : '图片'}
    </span>
  )
}

/** 能力的中文文案；未知能力原样回显，避免静默丢失信息。 */
function capabilityText(model: ImageGenerationModelEntry): string {
  return model.capabilities.map((capability) => IMAGE_GENERATION_CAPABILITY_LABELS[capability] ?? capability).join(' / ')
}

/** 模型类型筛选：图片与视频合并后必须能分开查看。 */
export type ModelKindFilter = 'all' | 'image' | 'video'

/** 按产物类别筛选模型；全部时保持原顺序。 */
function filterModelsByKind(models: readonly ImageGenerationModelEntry[], filter: ModelKindFilter): ImageGenerationModelEntry[] {
  return filter === 'all' ? [...models] : models.filter((model) => imageGenerationModelKind(model) === filter)
}

/** 类型筛选控件：显示三档并带上各自数量。 */
function ModelKindFilterBar({ value, imageCount, videoCount, onChange }: {
  value: ModelKindFilter
  imageCount: number
  videoCount: number
  onChange: (next: ModelKindFilter) => void
}): React.ReactElement {
  const options: { value: ModelKindFilter; label: string }[] = [
    { value: 'all', label: `全部 ${imageCount + videoCount}` },
    { value: 'image', label: `图片 ${imageCount}` },
    { value: 'video', label: `视频 ${videoCount}` },
  ]
  return (
    <div role="group" aria-label="模型类型" className="flex items-center gap-1">
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="sm"
          variant={value === option.value ? 'secondary' : 'ghost'}
          className="h-7 px-2 text-xs"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

/** 当前草稿的模型列表编辑：新增、移除与选中摘要。 */
function ModelListEditor({ draft, models, kind, onShowAll, disabled, onChange }: {
  draft: ImageGenerationDraft
  /** 已按类型筛选后的模型；移除仍作用于完整列表。 */
  models: readonly ImageGenerationModelEntry[]
  /** 当前类型筛选，用于空状态区分「没启用」与「被筛掉」。 */
  kind: ModelKindFilter
  /** 回到全部类型；空状态里给用户一条明确的退路。 */
  onShowAll: () => void
  disabled: boolean
  onChange: (models: ImageGenerationModelEntry[]) => void
}): React.ReactElement {
  return (
    <SettingsCard divided={false}>
      {models.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          {draft.models.length === 0
            ? '还没有启用任何模型，从下方可用模型中选择'
            : (
              <span className="inline-flex flex-wrap items-center justify-center gap-2">
                <span>{kind === 'video' ? '该配置还没有启用视频模型' : '该配置还没有启用图片模型'}</span>
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={onShowAll}>
                  显示全部 {draft.models.length} 个模型
                </Button>
              </span>
            )}
        </div>
      ) : (
        <div className="divide-y divide-border/50">
          {models.map((model) => (
            <div key={model.id} className="group flex items-center gap-2 px-4 py-2.5">
              <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />
              <ModelKindBadge model={model} />
              <span className="min-w-0 flex-1 text-sm text-foreground">
                {model.name ?? model.id}
                {model.name && model.name !== model.id ? <span className="ml-1 text-muted-foreground">({model.id})</span> : null}
                <span className="ml-2 text-xs text-muted-foreground">{capabilityText(model)}</span>
              </span>
              <button
                type="button"
                disabled={disabled || draft.models.length <= 1}
                aria-label={`移除模型 ${model.id}`}
                title={draft.models.length <= 1 ? '至少保留一个模型' : '移除模型'}
                onClick={() => onChange(draft.models.filter((entry) => entry.id !== model.id))}
                className="p-0.5 text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:text-destructive disabled:opacity-30"
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

/** 可用模型：内置模型 + 供应商拉取结果，点一下加入已启用模型。 */
function AvailableModels({ draft, controller, disabled, kind }: {
  draft: ImageGenerationDraft
  controller: ImageGenerationController
  disabled: boolean
  /** 当前类型筛选；供应商拉取结果同样按类型过滤。 */
  kind: ModelKindFilter
}): React.ReactElement {
  const [pendingId, setPendingId] = React.useState('')
  const [addError, setAddError] = React.useState('')
  /** 当前草稿的拉取结果；身份不匹配视为过期。 */
  const catalog = controller.catalog?.draftIdentity === imageCatalogIdentity(draft)
    ? controller.catalog
    : null
  const enabledIds = new Set(draft.models.map((model) => model.id))
  /** 内置清单优先，其次是拉取结果；两家都按 ID 去重，与音频页一致。 */
  const candidates = [...initialModelsForProvider(draft.provider), ...(catalog?.models ?? [])].filter((model, index, all) =>
    all.findIndex((entry) => entry.id === model.id) === index)
  const available = filterModelsByKind(candidates, kind).filter((model) => !enabledIds.has(model.id))

  /** 追加模型；重复 ID 就地拒绝。 */
  const appendModel = (model: ImageGenerationModelEntry): void => {
    if (enabledIds.has(model.id)) {
      setAddError('该模型已添加')
      return
    }
    controller.updateDraft({
      ...draft,
      models: [...draft.models, withDefaultCapabilities(draft.provider, model)],
    })
    setAddError('')
  }

  return (
    <SettingsCard divided={false}>
      {available.map((model) => (
        <div
          key={model.id}
          role="button"
          tabIndex={0}
          onClick={() => appendModel(model)}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); appendModel(model) } }}
          className="group flex cursor-pointer items-center gap-2 px-4 py-2.5 transition-colors hover:bg-muted/30"
        >
          <Plus size={14} className="shrink-0 text-muted-foreground" />
          <ModelKindBadge model={model} />
          <span className="flex-1 text-sm text-foreground">{model.name ?? model.id}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{capabilityText(model)}</span>
        </div>
      ))}
      {available.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          {catalog?.state === 'loading'
            ? '正在从供应商获取…'
            : catalog?.state === 'failed'
              ? catalog.message ?? '从供应商获取失败'
              : candidates.length > 0
                ? '可用的模型都已添加'
                : catalog?.state === 'success'
                  ? '供应商没有返回图像模型，可在下方手填模型 ID'
                  : '点右上角「从供应商获取」读取该账号可用的图像模型'}
        </div>
      )}
      {catalog?.state === 'failed' && (
        <p role="alert" className="border-t border-border/50 px-4 py-2 text-xs text-destructive">
          {catalog.message ?? '从供应商获取失败'}
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-border/50 px-4 py-2.5">
        <Input
          id="image-model-id"
          aria-label="模型 ID"
          className="h-8 flex-1 text-sm"
          placeholder={draft.provider === 'dreamina' ? '模型版本（如 5.0）' : '模型 ID（如 gpt-image-1）'}
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
            const id = pendingId.trim()
            if (!id) {
              setAddError('请输入模型 ID')
              return
            }
            appendModel({ id, capabilities: ['text-to-image'] })
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

/** 拉取按钮：拉取中显示加载态并阻止重复点击。 */
function FetchModelsButton({ controller, disabled }: {
  controller: ImageGenerationController
  disabled: boolean
}): React.ReactElement {
  const loading = controller.catalog?.state === 'loading'
  return (
    <Button variant="outline" size="sm" type="button" className="h-7 text-xs" disabled={disabled || loading} onClick={() => void controller.fetchCatalog()}>
      {loading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
      <span>从供应商获取</span>
    </Button>
  )
}

/** 生成目录、动态表单与旧配置迁移提示的纯视图。 */
export function ImageGenerationCatalogView({ controller, navigation, headerContent, children }: {
  controller: ImageGenerationController
} & ImageGenerationSettingsProps): React.ReactElement {
  const { settings, loading, saving, loadError, actionError, query, draft, deleteId, visibleProfiles } = controller
  const deleteTarget = settings?.catalog.profiles.find((profile) => profile.id === deleteId)
  /** API Key 默认明文显示，与模型配置一致；眼睛按钮只负责临时遮挡。 */
  const [showApiKey, setShowApiKey] = React.useState(true)
  /** 图片与视频模型合并后按类型查看；不影响任何写入内容。 */
  const [modelKind, setModelKind] = React.useState<ModelKindFilter>('all')
  /**
   * 换一条配置就回到「全部」。
   * 图标筛选是视图偏好，残留会让新打开的配置看起来像没有模型。
   */
  const editingDraftId = draft?.id ?? null
  React.useEffect(() => { setModelKind('all') }, [editingDraftId])
  /**
   * 打开即梦表单时自动查询一次账号状态。
   * 只在草稿切到即梦且尚未查询过时触发，避免每次编辑都打点 CLI。
   */
  const dreaminaProfileId = draft?.provider === 'dreamina' ? draft.id : null
  /** 依赖里只放稳定的回调，避免 controller 每次重建触发重复查询。 */
  const refreshDreaminaStatus = controller.refreshDreaminaStatus
  React.useEffect(() => {
    if (dreaminaProfileId === null) return
    void refreshDreaminaStatus()
    /** 依赖只包含草稿身份，草稿内其它编辑不会重复查询。 */
  }, [dreaminaProfileId, refreshDreaminaStatus])

  if (draft) {
    /** 当前草稿的图片与视频模型数量，供筛选控件与分区描述共用。 */
    const imageModelCount = draft.models.filter((model) => imageGenerationModelKind(model) === 'image').length
    const videoModelCount = draft.models.length - imageModelCount
    return (
      <MediaSettingsPage title={settings?.catalog.profiles.some((profile) => profile.id === draft.id) ? '编辑生成模型配置' : '添加生成模型配置'} onBack={controller.closeDraft} busy={saving} headerContent={headerContent}>
        <SettingsSection title="基本信息">
          <SettingsCard>
            <SettingsSelect
              id="image-provider"
              label="供应商类型"
              value={draft.provider}
              disabled={saving}
              options={IMAGE_GENERATION_PROVIDER_DESCRIPTORS.map((descriptor) => ({
                value: descriptor.provider,
                label: descriptor.label,
                icon: imageProviderLogo(descriptor.provider),
              }))}
              onValueChange={(value) => {
                if (value !== 'dreamina' && value !== 'openai-images' && value !== 'minimax') return
                controller.updateDraft(changeImageGenerationProvider(draft, value))
              }}
            />
            <SettingsInput
              id="image-name"
              label="供应商名称"
              value={draft.name}
              disabled={saving}
              /** 通用示例，避免把某个具体账号名写进界面文案。 */
              placeholder="例如：我的生成账号"
              required
              onChange={(name) => controller.updateDraft({ ...draft, name })}
            />
            {draft.provider === 'dreamina' ? (
              <>
                <DreaminaLoginPanel controller={controller} disabled={saving} />
                {/** CLI 路径属于配置字段，放在面板外层避免二次内边距造成错位缩进。 */}
                <SettingsInput
                  id="image-cli-path"
                  label="CLI 路径（可选）"
                  description="留空则按 PATH 查找 dreamina；换路径不会切换账号，登录态属于本机 CLI"
                  value={draft.cliPath ?? ''}
                  disabled={saving}
                  placeholder="例如：/usr/local/bin/dreamina"
                  onChange={(cliPath) => controller.updateDraft({ ...draft, cliPath })}
                />
              </>
            ) : (
              <>
                <SettingsInput
                  id="image-base-url"
                  label="服务地址"
                  value={draft.baseUrl}
                  disabled={saving}
                  placeholder={draft.provider === 'openai-images' ? 'https://api.openai.com/v1' : 'https://api.minimax.cn/v1'}
                  onChange={(baseUrl) => controller.updateDraft({ ...draft, baseUrl })}
                />
                <div className="space-y-2 px-4 py-3">
                  <div className="text-sm font-medium text-foreground">API Key</div>
                  <div className="relative">
                    <Input
                      id="image-api-key"
                      type={showApiKey ? 'text' : 'password'}
                      autoComplete="new-password"
                      className="pr-10"
                      value={draft.apiKey}
                      disabled={saving}
                      placeholder={draft.credentialConfigured ? '留空以保留已保存凭据' : '请输入 API Key'}
                      onChange={(event) => controller.updateDraft({ ...draft, apiKey: event.target.value })}
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                      title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => setShowApiKey(!showApiKey)}
                    >
                      {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                {draft.provider === 'minimax' && (
                  <SettingsInput
                    id="image-group-id"
                    label="Group ID（可选）"
                    value={draft.groupId ?? ''}
                    disabled={saving}
                    onChange={(groupId) => controller.updateDraft({ ...draft, groupId })}
                  />
                )}
              </>
            )}
            <SettingsToggle
              label="启用此配置"
              description="关闭后该配置的图片与视频模型都不会出现在画布与 agent 的可选列表中"
              checked={draft.enabled}
              disabled={saving}
              onCheckedChange={(enabled) => controller.updateDraft({ ...draft, enabled })}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          title="已启用模型"
          description={draft.models.length > 0
            ? `${imageModelCount} 个图片模型 · ${videoModelCount} 个视频模型`
            : undefined}
          action={<ModelKindFilterBar value={modelKind} imageCount={imageModelCount} videoCount={videoModelCount} onChange={setModelKind} />}
        >
          <ModelListEditor
            draft={draft}
            models={filterModelsByKind(draft.models, modelKind)}
            kind={modelKind}
            onShowAll={() => setModelKind('all')}
            disabled={saving}
            onChange={(models) => controller.updateDraft({ ...draft, models })}
          />
        </SettingsSection>

        <SettingsSection title="可用模型" action={<FetchModelsButton controller={controller} disabled={saving} />}>
          <AvailableModels draft={draft} controller={controller} disabled={saving} kind={modelKind} />
        </SettingsSection>

        {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
        {loadError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border border-destructive/30 px-3 py-2 text-xs text-destructive"><span>{loadError}</span><Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void controller.load()}>重新加载</Button></div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={controller.closeDraft}>取消</Button>
          <Button type="button" disabled={saving} onClick={() => void controller.saveDraft()}>{saving ? <Loader2 className="animate-spin" /> : null}保存</Button>
        </div>
      </MediaSettingsPage>
    )
  }

  return (
    <MediaSettingsPage title="生成模型 · 独立供应商配置" action={<Button type="button" size="sm" disabled={saving} onClick={controller.startCreate}><Plus />添加生成模型配置</Button>} headerContent={headerContent}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        {navigation}
        <div className="relative w-64 max-w-full"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" aria-label="搜索生图配置" placeholder="搜索名称、供应商或模型" value={query} onChange={(event) => controller.setQuery(event.target.value)} /></div>
      </div>
      {children}
      {/** 读取失败必须显眼：细条容易被误当成“还在加载”。 */}
      {loadError && (
        <SettingsCard divided={false}>
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 px-4 py-6">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-destructive">{loadError}</p>
              <p className="text-xs text-muted-foreground">诊断信息已打印到开发者控制台（以 [生图配置] 开头）。</p>
            </div>
            <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void controller.load()}>重新加载</Button>
          </div>
        </SettingsCard>
      )}
      {actionError && !deleteId && <p role="alert" className="border border-destructive/30 px-3 py-2 text-xs text-destructive">{actionError}</p>}
      {/**
        * 旧统一媒体目录已从生成模型里退场：不再展示借用渠道凭据的旧条目，
        * 也不再提示迁移，避免用户以为还需要维护两套配置。
        */}
      {/** 未读取到目录时仍给出明确状态，并且不阻塞新增。 */}
      {!settings ? <SettingsCard divided={false}><div className="px-4 py-8 text-center text-sm text-muted-foreground">{loading ? <><Loader2 className="mr-2 inline size-4 animate-spin" />正在读取生成模型配置...</> : '未读取到生成模型配置：可先添加，或点上方「重新加载」重试'}</div></SettingsCard>
        : settings.catalog.profiles.length === 0 ? <SettingsCard divided={false}><div className="px-4 py-8 text-center text-sm text-muted-foreground">尚未配置独立生成供应商</div></SettingsCard>
          : visibleProfiles.length === 0 ? <SettingsCard divided={false}><div className="px-4 py-8 text-center text-sm text-muted-foreground">没有匹配的生成配置</div></SettingsCard>
            : <SettingsCard>{visibleProfiles.map((profile) => (
              <SettingsRow
                key={profile.id}
                label={profile.name}
                icon={<img src={imageProviderLogo(profile.provider)} alt="" className="h-10 w-10 rounded" />}
                description={<><span>{IMAGE_PROVIDER_LABELS[profile.provider]} · {imageGenerationSummary(profile)}</span><span className="block">{profile.endpointOrigin ?? 'CLI 登录态'} · {providerUsesApiKey(profile.provider) ? (profile.credentialConfigured ? '凭据已配置' : '缺少凭据') : 'CLI 登录态'}</span></>}
              >
                {/** 操作区与音频页一致：开关 + 图标按钮，文字按钮会互相挤压。 */}
                <div className="flex flex-wrap items-center justify-end gap-1">
                  <Switch checked={profile.enabled} disabled={saving} aria-label={`${profile.enabled ? '停用' : '启用'} ${profile.name}`} onCheckedChange={(enabled) => void controller.toggleEnabled(profile, enabled)} />
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`复制 ${profile.name}`} title="复制" disabled={saving} onClick={() => controller.startCopy(profile)}><Copy /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`编辑 ${profile.name}`} title="编辑" disabled={saving} onClick={() => controller.startEdit(profile)}><Pencil /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`删除 ${profile.name}`} title="删除" disabled={saving} onClick={() => controller.requestDelete(profile.id)}><Trash2 /></Button>
                </div>
              </SettingsRow>
            ))}</SettingsCard>}
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open) => { if (!open) controller.closeDelete() }}
        title="删除生成配置？"
        description={actionError ?? (deleteTarget ? `删除 ${deleteTarget.name} 后，画布与 agent 将不能再使用该配置的模型。` : '')}
        confirmLabel="删除"
        closeOnConfirm={false}
        loading={saving}
        variant="destructive"
        onConfirm={controller.confirmDelete}
      />
    </MediaSettingsPage>
  )
}

/** 连接真实 Electron IPC 的独立生图配置页面。 */
export function ImageGenerationSettings(props: ImageGenerationSettingsProps): React.ReactElement {
  /** 稳定 IPC 适配器避免每次渲染触发重新加载。 */
  const api = React.useMemo(() => imageSettingsApiFromWindow(), [])
  const controller = useImageGenerationController(api)
  return <ImageGenerationCatalogView {...props} controller={controller} />
}

/**
 * 即梦登录面板。
 * 入参：控制器与禁用态；返回值：本机登录态、设备码与账号操作按钮。
 * 设备码只在等待授权时展示，登录成功后立即回到账号状态，不保留任何凭据。
 */
function DreaminaLoginPanel({ controller, disabled }: {
  controller: ImageGenerationController
  disabled: boolean
}): React.ReactElement {
  const { dreaminaStatus, dreaminaLogin, dreaminaBusy } = controller
  const busy = disabled || dreaminaBusy
  const loggedIn = dreaminaStatus?.state === 'loggedIn'
  /**
   * 状态行文案：查询前、已登录、未登录与异常各自独立，不互相冒充。
   * 明确写成「本机」是因为登录态属于本地 CLI 会话，不属于这条配置。
   */
  const statusText = dreaminaStatus === null
    ? '尚未查询本机登录态'
    : dreaminaStatus.state === 'loggedIn'
      ? `本机已登录 · 剩余额度 ${dreaminaStatus.credit ?? 0}`
      : dreaminaStatus.message
  const statusTone = dreaminaStatus?.state === 'loggedIn'
    ? 'text-emerald-600'
    : dreaminaStatus === null || dreaminaStatus.state === 'unknown'
      ? 'text-muted-foreground'
      : 'text-destructive'

  /** 复制设备码或授权地址到系统剪贴板。 */
  const copyText = (text: string, label: string): void => {
    void window.electronAPI.writeClipboardText(text)
      .then(() => toast.success(`${label}已复制`))
      .catch(() => toast.error(`${label}复制失败`))
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium text-foreground">即梦登录</div>
          <div className={cn('text-xs', statusTone)}>{statusText}</div>
          <p className="text-xs text-muted-foreground">
            登录态由本地即梦 CLI 保存在系统凭据库，本机所有即梦配置共用同一个账号。
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 text-xs"
          disabled={busy}
          onClick={() => void controller.refreshDreaminaStatus()}
        >
          {dreaminaBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          <span>刷新状态</span>
        </Button>
      </div>

      {dreaminaLogin.state === 'pending' && dreaminaLogin.userCode !== null && (
        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">{dreaminaLogin.message}</p>
          <div className="flex items-center gap-2">
            <span className="font-mono text-base tracking-widest text-foreground">{dreaminaLogin.userCode}</span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="复制设备码"
              title="复制设备码"
              onClick={() => copyText(dreaminaLogin.userCode ?? '', '设备码')}
            >
              <Copy />
            </Button>
            {dreaminaLogin.expiresInSeconds !== null && (
              <span className="text-xs text-muted-foreground">
                剩余约 {Math.max(0, Math.round(dreaminaLogin.expiresInSeconds / 60))} 分钟
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={dreaminaLogin.verificationUri === null}
              onClick={() => {
                const uri = dreaminaLogin.verificationUri
                if (uri === null) return
                void window.electronAPI.openExternal(uri)
              }}
            >
              <ExternalLink size={12} />
              <span>打开授权页面</span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void controller.cancelDreaminaLogin()}
            >
              取消
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            在浏览器打开授权页并输入设备码，完成后本页会自动刷新登录状态。
          </p>
        </div>
      )}

      {dreaminaLogin.state !== 'pending' && dreaminaLogin.state !== 'idle' && dreaminaLogin.message !== null && (
        <p
          role={dreaminaLogin.state === 'failed' ? 'alert' : undefined}
          className={cn('text-xs', dreaminaLogin.state === 'failed' ? 'text-destructive' : 'text-emerald-600')}
        >
          {dreaminaLogin.message}
        </p>
      )}

      {/** 账号操作统一成一行：主操作在左，退出登录用弱化样式单独收在右侧。 */}
      <div className="flex flex-wrap items-center gap-2">
        {loggedIn ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={busy || dreaminaLogin.state === 'pending'}
              onClick={() => void controller.startDreaminaLogin(true)}
            >
              重新登录
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 text-xs text-muted-foreground hover:text-destructive"
              disabled={busy || dreaminaLogin.state === 'pending'}
              onClick={() => void controller.logoutDreamina()}
            >
              退出登录
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs"
            disabled={busy || dreaminaLogin.state === 'pending'}
            onClick={() => void controller.startDreaminaLogin(false)}
          >
            {dreaminaLogin.state === 'starting' ? <Loader2 size={12} className="animate-spin" /> : null}
            <span>登录即梦</span>
          </Button>
        )}
      </div>
    </div>
  )
}
