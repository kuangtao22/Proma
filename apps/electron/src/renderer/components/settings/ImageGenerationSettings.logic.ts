/**
 * 独立生图设置页的纯逻辑层。
 *
 * 只做与界面无关的草稿变换与校验收敛：新建、切换供应商、复制、搜索、指纹。
 * JSX 与请求生命周期在 ImageGenerationSettings.tsx 中实现，便于这两层分别测试。
 */
import type {
  ImageGenerationModelEntry,
  ImageGenerationProfile,
  ImageGenerationProvider,
  ImageGenerationPublicProfile,
} from '@proma/shared'
import {
  IMAGE_GENERATION_PROVIDER_DEFAULTS,
  IMAGE_GENERATION_PROVIDER_DESCRIPTORS,
  parseImageGenerationProfile,
} from '@proma/shared'

/** 编辑草稿只在 Renderer 内短暂持有明文 API Key。 */
export type ImageGenerationDraft = ImageGenerationProfile & {
  apiKey: string
  credentialConfigured: boolean
}

/** 供应商显示名，供列表与表单共用。 */
export const IMAGE_PROVIDER_LABELS: Record<ImageGenerationProvider, string> = Object.fromEntries(
  IMAGE_GENERATION_PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.provider, descriptor.label]),
) as Record<ImageGenerationProvider, string>

/** 判断供应商是否需要 API Key；即梦使用 CLI 登录态。 */
export function providerUsesApiKey(provider: ImageGenerationProvider): boolean {
  return IMAGE_GENERATION_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.provider === provider)?.usesApiKey ?? false
}

/**
 * 供应商默认模型条目。
 * 入参：供应商；返回值：初始模型数组（可能为空）。
 * 官方内置清单直接带出，用户不需要手工抄写 model_version。
 */
export function initialModelsForProvider(provider: ImageGenerationProvider): ImageGenerationModelEntry[] {
  return IMAGE_GENERATION_PROVIDER_DEFAULTS[provider].builtinModels.map((model) => ({
    ...model,
    ...(model.params === undefined ? {} : { params: { ...model.params } }),
  }))
}

/** 创建新草稿：带出默认服务地址与内置模型。 */
export function createImageGenerationDraft(
  provider: ImageGenerationProvider,
  id: string,
  now: number,
): ImageGenerationDraft {
  const defaults = IMAGE_GENERATION_PROVIDER_DEFAULTS[provider]
  /** 三家共享字段；即梦没有服务地址。 */
  const common = {
    id,
    name: '',
    models: initialModelsForProvider(provider),
    enabled: true,
    createdAt: now,
    updatedAt: now,
    apiKey: '',
    credentialConfigured: false,
  }
  if (provider === 'dreamina') return { ...common, provider: 'dreamina' }
  if (provider === 'openai-images') return { ...common, provider: 'openai-images', baseUrl: defaults.baseUrl }
  return { ...common, provider: 'minimax', baseUrl: defaults.baseUrl }
}

/** 切换供应商时清除不再可信的身份、凭据与迁移引用。 */
export function changeImageGenerationProvider(
  draft: ImageGenerationDraft,
  provider: ImageGenerationProvider,
): ImageGenerationDraft {
  if (draft.provider === provider) return draft
  return {
    ...createImageGenerationDraft(provider, draft.id, draft.createdAt),
    name: draft.name,
    enabled: draft.enabled,
    updatedAt: draft.updatedAt,
  }
}

/** 复制配置时保留模型与参数，但绝不继承凭据与旧目录引用。 */
export function copyImageGenerationProfile(
  profile: ImageGenerationPublicProfile | ImageGenerationDraft,
  id: string,
  now: number,
): ImageGenerationDraft {
  /** 公共且不含秘密的复制字段。 */
  const common = {
    id,
    name: `${profile.name} 副本`,
    models: profile.models.map((model) => ({
      ...model,
      capabilities: [...model.capabilities],
      ...(model.params === undefined ? {} : { params: { ...model.params } }),
    })),
    enabled: profile.enabled,
    createdAt: now,
    updatedAt: now,
    apiKey: '',
    credentialConfigured: false,
  }
  if (profile.provider === 'dreamina') {
    return {
      ...common,
      provider: 'dreamina',
      ...(profile.cliPath === undefined ? {} : { cliPath: profile.cliPath }),
    }
  }
  if (profile.provider === 'openai-images') {
    return { ...common, provider: 'openai-images', baseUrl: profile.baseUrl }
  }
  return {
    ...common,
    provider: 'minimax',
    baseUrl: profile.baseUrl,
    ...(profile.groupId === undefined ? {} : { groupId: profile.groupId }),
  }
}

/** 列表只搜索明确公开的展示字段，不读取完整服务 URL。 */
export function filterImageGenerationProfiles(
  profiles: readonly ImageGenerationPublicProfile[],
  query: string,
): ImageGenerationPublicProfile[] {
  /** 统一大小写后的搜索词。 */
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return [...profiles]
  return profiles.filter((profile) => [
    profile.name,
    profile.provider,
    IMAGE_PROVIDER_LABELS[profile.provider],
    ...profile.models.flatMap((model) => [model.id, model.name ?? '', ...model.capabilities]),
    profile.endpointOrigin ?? '',
  ].join('\n').toLocaleLowerCase().includes(normalized))
}

/** 列表摘要只显示模型数量与首个能力，避免长列表撑开行。 */
export function imageGenerationSummary(profile: ImageGenerationPublicProfile): string {
  const [first] = profile.models
  if (!first) return '未配置模型'
  const modelLabel = profile.models.length === 1 ? first.id : `${first.id} 等 ${profile.models.length} 个模型`
  const capabilityLabel = first.capabilities.includes('image-to-image')
    ? '文生图 + 图生图'
    : first.capabilities.includes('upscale') ? '放大' : '文生图'
  return `${modelLabel} · ${capabilityLabel}`
}

/** 将公开配置转换为不回填明文凭据的编辑草稿。 */
export function profileToDraft(profile: ImageGenerationPublicProfile): ImageGenerationDraft {
  /** Renderer 只复制持久化公开字段。 */
  const common = {
    id: profile.id,
    name: profile.name,
    models: profile.models.map((model) => ({
      ...model,
      capabilities: [...model.capabilities],
      ...(model.params === undefined ? {} : { params: { ...model.params } }),
    })),
    enabled: profile.enabled,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    ...(profile.legacyMediaProfileId ? { legacyMediaProfileId: profile.legacyMediaProfileId } : {}),
    apiKey: '',
    credentialConfigured: profile.credentialConfigured,
  }
  if (profile.provider === 'dreamina') {
    return {
      ...common,
      provider: 'dreamina',
      ...(profile.cliPath === undefined ? {} : { cliPath: profile.cliPath }),
    }
  }
  if (profile.provider === 'openai-images') {
    return { ...common, provider: 'openai-images', baseUrl: profile.baseUrl }
  }
  return {
    ...common,
    provider: 'minimax',
    baseUrl: profile.baseUrl,
    ...(profile.groupId === undefined ? {} : { groupId: profile.groupId }),
  }
}

/** 将草稿收敛为 shared 严格配置，确保即梦不会提交服务地址或密钥字段。 */
export function draftToProfile(draft: ImageGenerationDraft): ImageGenerationProfile {
  if (draft.provider === 'dreamina') {
    return parseImageGenerationProfile({
      id: draft.id, name: draft.name, provider: 'dreamina', models: draft.models, enabled: draft.enabled,
      createdAt: draft.createdAt, updatedAt: draft.updatedAt,
      ...(draft.cliPath?.trim() ? { cliPath: draft.cliPath.trim() } : {}),
      ...(draft.legacyMediaProfileId ? { legacyMediaProfileId: draft.legacyMediaProfileId } : {}),
    })
  }
  if (draft.provider === 'openai-images') {
    return parseImageGenerationProfile({
      id: draft.id, name: draft.name, provider: 'openai-images', baseUrl: draft.baseUrl,
      models: draft.models, enabled: draft.enabled,
      createdAt: draft.createdAt, updatedAt: draft.updatedAt,
      ...(draft.legacyMediaProfileId ? { legacyMediaProfileId: draft.legacyMediaProfileId } : {}),
    })
  }
  return parseImageGenerationProfile({
    id: draft.id, name: draft.name, provider: 'minimax', baseUrl: draft.baseUrl,
    models: draft.models, enabled: draft.enabled,
    createdAt: draft.createdAt, updatedAt: draft.updatedAt,
    ...(draft.groupId?.trim() ? { groupId: draft.groupId.trim() } : {}),
    ...(draft.legacyMediaProfileId ? { legacyMediaProfileId: draft.legacyMediaProfileId } : {}),
  })
}

/** 对公开身份字段生成稳定指纹，用于检测外部修改与草稿代次变化。 */
export function imageProfileIdentity(profile: ImageGenerationProfile): string {
  return JSON.stringify([
    profile.provider,
    profile.provider === 'dreamina' ? profile.cliPath?.trim() ?? '' : profile.baseUrl.trim(),
    profile.provider === 'minimax' ? profile.groupId?.trim() ?? '' : '',
    ...profile.models.map((model) => [model.id.trim(), model.name?.trim() ?? '', ...model.capabilities]),
  ])
}

/**
 * 目录拉取的归属身份。
 * 入参：当前草稿；返回值：稳定字符串。
 * 与严格 Profile 指纹不同：草稿尚未添加模型时也必须能拉取供应商清单，
 * 因此这里不做任何合同校验，只取与目录相关的字段。
 */
export function imageCatalogIdentity(draft: ImageGenerationDraft): string {
  return JSON.stringify([
    draft.provider,
    draft.provider === 'dreamina' ? draft.cliPath?.trim() ?? '' : draft.baseUrl.trim(),
    draft.provider === 'minimax' ? draft.groupId?.trim() ?? '' : '',
    draft.apiKey.trim() ? 'draft-key' : 'saved-key',
    draft.models.map((model) => model.id.trim()),
  ])
}

/** 对完整公开配置生成稳定指纹，防止编辑和删除覆盖外部修改。 */
export function imageProfileFingerprint(profile: ImageGenerationProfile): string {
  return JSON.stringify(profile)
}
