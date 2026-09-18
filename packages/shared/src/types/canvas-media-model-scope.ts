import type { ImageGenerationModelOption } from './design'
import type { MediaApiModelCapability, MediaApiModelCatalogResult, MediaApiModelExecutionSupport, MediaApiModelKind } from './media-api-model'
import type { ImageGenerationModelEntry, ImageGenerationPublicCatalog, ImageGenerationPublicProfile } from './image-generation'
import { imageGenerationModelKind } from './image-generation'

/** 全部启用模式持续跟随目录，明确选择模式允许空集合。 */
export type CanvasMediaModelScope = { mode: 'all-enabled' } | { mode: 'selected'; modelIds: string[] }

/** 候选只要求稳定模型身份与实时可用性，不依赖具体供应商。 */
export interface CanvasMediaModelCandidate { profileId: string; available: boolean; executor: string }

/** 设置、Canvas 和 Agent 共用的模型公开信息；不包含渠道凭据。 */
export interface CanvasMediaModelOption extends CanvasMediaModelCandidate {
  name: string
  modelId: string
  mediaKind: MediaApiModelKind
  channelId?: string
  channelName?: string
  capabilities: MediaApiModelCapability[]
  support: MediaApiModelExecutionSupport
  unavailableReason?: string
}

/** 将统一 API 目录与旧图片执行器合并；有目录时仅补充未迁移的 Nano 模型。 */
export function buildCanvasMediaModelOptions(catalog: MediaApiModelCatalogResult | undefined, legacy: readonly ImageGenerationModelOption[]): CanvasMediaModelOption[] {
  /** 旧图片选项包含 Nano 实时运行可用性，用于保留旧工作区兼容。 */
  const legacyOptions: CanvasMediaModelOption[] = legacy.filter((option) => option.executor !== 'comfyui'
    && (!catalog || option.executor === 'nano-banana')).map((option) => ({
    ...option, mediaKind: 'image', capabilities: ['text-to-image', 'image-to-image'],
    support: option.available ? { state: 'supported', adapterId: option.executor }
      : { state: 'unavailable', reason: option.unavailableReason ?? '模型不可用' },
  }))
  /** API profile 的启用与 adapter 状态共同决定是否可供执行。 */
  const apiOptions: CanvasMediaModelOption[] = (catalog?.entries ?? []).map(({ profile, support, channelName }) => ({
    profileId: profile.id, name: profile.name, modelId: profile.modelId, executor: profile.protocol,
    mediaKind: profile.mediaKind, channelId: profile.channelId, channelName, capabilities: [...profile.capabilities], support,
    available: profile.enabled && support.state === 'supported',
    ...(support.state !== 'supported' ? { unavailableReason: support.reason }
      : !profile.enabled ? { unavailableReason: '模型已停用' } : {}),
  }))
  /** 同一 ID 以统一目录为准，避免双份候选和互相矛盾的启用状态。 */
  const apiIds = new Set(apiOptions.map((option) => option.profileId))
  return [...apiOptions, ...legacyOptions.filter((option) => !apiIds.has(option.profileId))]
}

/** 独立生成配置在画布候选里的选择 ID 前缀，避免与旧目录条目混淆。 */
export const CANVAS_GENERATION_MODEL_ID_PREFIX = 'imagegen'

/**
 * 组装独立生成配置在画布候选里的选择 ID。
 * 入参：配置 ID 与模型 ID；返回值：可持久化到画布范围的稳定 ID。
 */
export function buildCanvasGenerationModelId(profileId: string, modelId: string): string {
  return `${CANVAS_GENERATION_MODEL_ID_PREFIX}:${profileId}:${modelId}`
}

/** 解析画布选择 ID；不是独立生成配置时返回 null。 */
export function parseCanvasGenerationModelId(value: string): { profileId: string; modelId: string } | null {
  const prefix = `${CANVAS_GENERATION_MODEL_ID_PREFIX}:`
  if (!value.startsWith(prefix)) return null
  const rest = value.slice(prefix.length)
  /** 模型 ID 允许包含冒号，因此按第一个冒号切分配置 ID。 */
  const separator = rest.indexOf(':')
  if (separator <= 0) return null
  return { profileId: rest.slice(0, separator), modelId: rest.slice(separator + 1) }
}

/** 独立能力到画布能力的映射；没有对应项的（如放大）不下放给画布。 */
const CANVAS_CAPABILITY_MAP: Record<string, MediaApiModelCapability | undefined> = {
  'text-to-image': 'text-to-image',
  'image-to-image': 'image-to-image',
  'text-to-video': 'text-to-video',
  'image-to-video': 'image-to-video',
}

/** 独立供应商到画布执行协议的映射；协议名不代表适配器已存在。 */
function canvasProtocolFor(profile: ImageGenerationPublicProfile, model: ImageGenerationModelEntry): string {
  if (profile.provider === 'dreamina') return 'dreamina'
  if (profile.provider === 'openai-images') return 'openai-images'
  return imageGenerationModelKind(model) === 'video' ? 'minimax-video' : 'minimax-image'
}

/**
 * 当前真正接过执行器的独立协议；其余先如实标为不可执行。
 * 即梦（CLI 异步）与 MiniMax 视频尚未接入，保持缺席。
 */
const EXECUTABLE_ADAPTERS: ReadonlySet<string> = new Set(['openai-images', 'minimax-image'])

/**
 * 把独立生成目录投影成画布候选。
 * 入参：独立生成目录与本地工作流候选；返回值：画布/Agent 共用的候选列表。
 * 只有已接入执行器的协议标记为 supported，其余带明确原因，避免用户选了却生成失败。
 */
export function buildCanvasGenerationModelOptions(
  catalog: ImageGenerationPublicCatalog | undefined,
  mediaOptions: readonly ImageGenerationModelOption[],
): CanvasMediaModelOption[] {
  /** 本地工作流不是独立配置，按原语义附加在末尾。 */
  const workflowOptions: CanvasMediaModelOption[] = mediaOptions
    .filter((option) => option.executor === 'comfyui')
    .map((option) => ({
      profileId: option.profileId, name: option.name, modelId: option.modelId, executor: option.executor,
      mediaKind: 'image', capabilities: ['text-to-image', 'image-to-image'],
      support: option.available
        ? { state: 'supported', adapterId: option.executor }
        : { state: 'unavailable', reason: option.unavailableReason ?? '模型不可用' },
      available: option.available,
      ...(option.available ? {} : { unavailableReason: option.unavailableReason ?? '模型不可用' }),
    }))
  const generationOptions: CanvasMediaModelOption[] = []
  for (const profile of catalog?.profiles ?? []) {
    for (const model of profile.models) {
      const protocol = canvasProtocolFor(profile, model)
      /** 独立能力里有、画布能力里没有的（例如放大）不下放给画布筛选。 */
      const capabilities = model.capabilities
        .map((capability) => CANVAS_CAPABILITY_MAP[capability])
        .filter((capability): capability is MediaApiModelCapability => capability !== undefined)
      const executable = profile.enabled && model.capabilities.some((capability) => CANVAS_CAPABILITY_MAP[capability] !== undefined)
        && EXECUTABLE_ADAPTERS.has(protocol)
      const reason = !profile.enabled ? '模型已停用' : '该供应商的执行器尚未接入'
      generationOptions.push({
        profileId: buildCanvasGenerationModelId(profile.id, model.id),
        name: `${profile.name} · ${model.name ?? model.id}`,
        modelId: model.id,
        executor: protocol,
        mediaKind: imageGenerationModelKind(model),
        channelName: profile.name,
        capabilities,
        support: executable ? { state: 'supported', adapterId: protocol } : { state: 'unavailable', reason },
        available: executable,
        ...(executable ? {} : { unavailableReason: reason }),
      })
    }
  }
  return [...generationOptions, ...workflowOptions]
}

/** 严格重建有界候选范围，避免空集合被隐式改写为全部。 */
export function parseCanvasMediaModelScope(value: unknown): CanvasMediaModelScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CANVAS_MEDIA_MODEL_SCOPE_INVALID')
  const input = value as Record<string, unknown>
  if (input.mode === 'all-enabled' && Object.keys(input).length === 1) return { mode: 'all-enabled' }
  if (input.mode !== 'selected' || Object.keys(input).length !== 2 || !Array.isArray(input.modelIds)
    || input.modelIds.length > 256 || input.modelIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id)
      || ['__proto__', 'constructor', 'prototype'].includes(id)) || new Set(input.modelIds).size !== input.modelIds.length) {
    throw new Error('CANVAS_MEDIA_MODEL_SCOPE_INVALID')
  }
  return { mode: 'selected', modelIds: [...input.modelIds] as string[] }
}

/** 判断画布是否允许这个 API 模型；启用与供应商配置由模型目录再校验。 */
export function isCanvasMediaModelAllowed(scope: CanvasMediaModelScope | undefined, modelId: string): boolean {
  return scope === undefined || scope.mode === 'all-enabled' || scope.modelIds.includes(modelId)
}

/** 以实时目录计算有效交集，并保留停用或删除模型供用户显式移除。 */
export function resolveCanvasMediaModelOptions(scope: CanvasMediaModelScope | undefined, options: readonly CanvasMediaModelCandidate[]): {
  selectedIds: string[]; availableIds: string[]; unavailableIds: string[]
} {
  const available = new Set(options.filter((option) => option.available && option.executor !== 'comfyui').map((option) => option.profileId))
  const selectedIds = scope?.mode === 'selected' ? [...scope.modelIds] : [...available]
  return { selectedIds, availableIds: selectedIds.filter((id) => available.has(id)), unavailableIds: selectedIds.filter((id) => !available.has(id)) }
}
