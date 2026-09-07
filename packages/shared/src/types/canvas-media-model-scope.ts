import type { ImageGenerationModelOption } from './design'
import type { MediaApiModelCapability, MediaApiModelCatalogResult, MediaApiModelExecutionSupport, MediaApiModelKind } from './media-api-model'

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
