/**
 * 独立生图供应商设置页。
 *
 * 布局与音频生成页逐块对齐：基本信息（供应商类型 / 名称 / 服务地址 / API Key / 启用）、
 * 已启用模型、可用模型。即梦没有服务地址与 API Key，对应位置显示登录面板占位；
 * 旧统一媒体目录里的渠道型生图条目只读提示迁移，不再在这里被编辑。
 */
import * as React from 'react'
import type {
  ImageGenerationModelEntry,
  ImageGenerationPublicProfile,
  ImageGenerationProvider,
} from '@proma/shared'
import { IMAGE_GENERATION_PROVIDER_DESCRIPTORS } from '@proma/shared'
import { CheckCircle2, Download, Loader2, Plus, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { getProviderLogo } from '@/lib/model-logo'
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
  imageGenerationSummary,
  imageProfileIdentity,
  providerUsesApiKey,
  type ImageGenerationDraft,
} from './ImageGenerationSettings.logic'

/** 页面插槽：与音频页保持一致，允许外部注入导航与头部内容。 */
export interface ImageGenerationSettingsProps {
  navigation?: React.ReactNode
  headerContent?: React.ReactNode
  children?: React.ReactNode
}

/** 追加模型时按供应商补齐能力默认值。 */
/**
 * 生图供应商到品牌 Logo 的显式映射。
 * 入参：生图供应商；返回值：Logo URL 或 undefined。
 * 即梦没有可用资源，返回 undefined 而不是拿别的品牌冒充。
 */
function imageProviderLogo(provider: ImageGenerationProvider): string | undefined {
  if (provider === 'dreamina') return undefined
  return getProviderLogo(provider === 'openai-images' ? 'openai' : 'minimax')
}

/** 追加模型时按供应商补齐能力默认值。 */
function withDefaultCapabilities(provider: ImageGenerationProvider, model: ImageGenerationModelEntry): ImageGenerationModelEntry {
  if (provider === 'dreamina') return { ...model, params: { ...(model.params ?? {}), resolution_type: model.params?.resolution_type ?? '2k' } }
  return { ...model }
}

/** 当前草稿的模型列表编辑：新增、移除与选中摘要。 */
function ModelListEditor({ draft, disabled, onChange }: {
  draft: ImageGenerationDraft
  disabled: boolean
  onChange: (models: ImageGenerationModelEntry[]) => void
}): React.ReactElement {
  return (
    <SettingsCard divided={false}>
      {draft.models.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">还没有启用任何模型，从下方可用模型中选择</div>
      ) : (
        <div className="divide-y divide-border/50">
          {draft.models.map((model) => (
            <div key={model.id} className="group flex items-center gap-2 px-4 py-2.5">
              <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />
              <span className="min-w-0 flex-1 text-sm text-foreground">
                {model.name ?? model.id}
                {model.name && model.name !== model.id ? <span className="ml-1 text-muted-foreground">({model.id})</span> : null}
                <span className="ml-2 text-xs text-muted-foreground">{model.capabilities.join(' / ')}</span>
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
function AvailableModels({ draft, controller, disabled }: {
  draft: ImageGenerationDraft
  controller: ImageGenerationController
  disabled: boolean
}): React.ReactElement {
  const [pendingId, setPendingId] = React.useState('')
  const [addError, setAddError] = React.useState('')
  /** 当前草稿的拉取结果；身份不匹配视为过期。 */
  const catalog = controller.catalog?.draftIdentity === imageProfileIdentity({ ...draft, updatedAt: draft.createdAt })
    ? controller.catalog
    : null
  const enabledIds = new Set(draft.models.map((model) => model.id))
  const candidates = [...(catalog?.models ?? [])].filter((model, index, all) =>
    all.findIndex((entry) => entry.id === model.id) === index)
  const available = candidates.filter((model) => !enabledIds.has(model.id))

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
          <span className="flex-1 text-sm text-foreground">{model.name ?? model.id}</span>
          <span className="text-xs text-muted-foreground">{model.capabilities.join(' / ')}</span>
        </div>
      ))}
      {available.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          {catalog?.state === 'loading'
            ? '正在从供应商获取…'
            : catalog?.state === 'failed'
              ? catalog.message ?? '从供应商获取失败'
              : catalog?.state === 'success'
                ? '供应商没有返回图像模型，可在下方手填模型 ID'
                : '点右上角「从供应商获取」读取该账号可用的图像模型'}
        </div>
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

/** 生图目录、动态表单与旧配置迁移提示的纯视图。 */
export function ImageGenerationCatalogView({ controller, navigation, headerContent, children }: {
  controller: ImageGenerationController
} & ImageGenerationSettingsProps): React.ReactElement {
  const { settings, loading, saving, loadError, actionError, query, draft, deleteId, visibleProfiles } = controller
  const deleteTarget = settings?.catalog.profiles.find((profile) => profile.id === deleteId)
  /** 即梦登录面板在 S4 接通前只做说明，按钮禁用。 */
  const dreaminaNotice = (
    <div className="space-y-2 px-4 py-3">
      <div className="text-sm font-medium text-foreground">即梦登录</div>
      <p className="text-xs text-muted-foreground">
        即梦需要通过官方 CLI 在网页完成登录；登录链路接通后这里会显示设备码与验证链接，现在请先在终端执行
        <code className="mx-1 rounded bg-muted px-1">dreamina login</code>。
      </p>
      <Button type="button" size="sm" variant="outline" disabled>登录即梦（即将支持）</Button>
    </div>
  )

  if (draft) {
    return (
      <MediaSettingsPage title={settings?.catalog.profiles.some((profile) => profile.id === draft.id) ? '编辑生图配置' : '添加生图配置'} onBack={controller.closeDraft} busy={saving} headerContent={headerContent}>
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
                /** 即梦暂无官方 Logo 资源，留空避免用其它品牌冒充。 */
                ...(imageProviderLogo(descriptor.provider) === undefined
                  ? {}
                  : { icon: imageProviderLogo(descriptor.provider) }),
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
              placeholder="例如：老沈GPT"
              required
              onChange={(name) => controller.updateDraft({ ...draft, name })}
            />
            {draft.provider === 'dreamina' ? dreaminaNotice : (
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
                  <Input
                    id="image-api-key"
                    type="password"
                    autoComplete="new-password"
                    value={draft.apiKey}
                    disabled={saving}
                    placeholder={draft.credentialConfigured ? '留空以保留已保存凭据' : '请输入 API Key'}
                    onChange={(event) => controller.updateDraft({ ...draft, apiKey: event.target.value })}
                  />
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
              description="关闭后该配置的模型不会出现在画布与 agent 的可选列表中"
              checked={draft.enabled}
              disabled={saving}
              onCheckedChange={(enabled) => controller.updateDraft({ ...draft, enabled })}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="已启用模型" description={draft.models.length > 0 ? `${draft.models.length} 个模型` : undefined}>
          <ModelListEditor
            draft={draft}
            disabled={saving}
            onChange={(models) => controller.updateDraft({ ...draft, models })}
          />
        </SettingsSection>

        <SettingsSection title="可用模型" action={<FetchModelsButton controller={controller} disabled={saving} />}>
          <AvailableModels draft={draft} controller={controller} disabled={saving} />
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
    <MediaSettingsPage title="生图模型 · 独立供应商配置" action={<Button type="button" size="sm" disabled={loading || saving} onClick={controller.startCreate}><Plus />添加生图配置</Button>} headerContent={headerContent}>
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
      {settings?.legacyWarning && <p className="border border-border/60 px-3 py-2 text-xs text-muted-foreground">{settings.legacyWarning}</p>}
      {settings && settings.legacyImageProfiles.length > 0 && (
        <SettingsCard>
          {settings.legacyImageProfiles.map((legacy) => (
            <SettingsRow
              key={legacy.id}
              label={legacy.name}
              description={`旧配置借用渠道凭据 · ${legacy.modelId} · 请在上方新建独立配置后停用旧条目`}
            />
          ))}
        </SettingsCard>
      )}
      {loading && !settings ? <SettingsCard divided={false}><div className="px-4 py-8 text-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />正在读取生图配置...</div></SettingsCard>
        : settings && settings.catalog.profiles.length === 0 ? <SettingsCard divided={false}><div className="px-4 py-8 text-center text-sm text-muted-foreground">尚未配置独立生图供应商</div></SettingsCard>
          : settings && visibleProfiles.length === 0 ? <SettingsCard divided={false}><div className="px-4 py-8 text-center text-sm text-muted-foreground">没有匹配的生图配置</div></SettingsCard>
            : <SettingsCard>{visibleProfiles.map((profile) => (
              <SettingsRow
                key={profile.id}
                label={profile.name}
                icon={imageProviderLogo(profile.provider) === undefined
                  ? undefined
                  : <img src={imageProviderLogo(profile.provider)} alt="" className="h-10 w-10 rounded" />}
                description={<><span>{IMAGE_PROVIDER_LABELS[profile.provider]} · {imageGenerationSummary(profile)}</span><span className="block">{profile.endpointOrigin ?? 'CLI 登录态'} · {providerUsesApiKey(profile.provider) ? (profile.credentialConfigured ? '凭据已配置' : '缺少凭据') : 'CLI 登录态'}</span></>}
              >
                <div className="flex flex-wrap items-center justify-end gap-1">
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`${profile.enabled ? '停用' : '启用'} ${profile.name}`} title={profile.enabled ? '停用' : '启用'} disabled={saving} onClick={() => void controller.toggleEnabled(profile, !profile.enabled)}>{profile.enabled ? '启用中' : '已停用'}</Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`编辑 ${profile.name}`} title="编辑" disabled={saving} onClick={() => controller.startEdit(profile)}>编辑</Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`删除 ${profile.name}`} title="删除" disabled={saving} onClick={() => controller.requestDelete(profile.id)}><Trash2 /></Button>
                </div>
              </SettingsRow>
            ))}</SettingsCard>}
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open) => { if (!open) controller.closeDelete() }}
        title="删除生图配置？"
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
