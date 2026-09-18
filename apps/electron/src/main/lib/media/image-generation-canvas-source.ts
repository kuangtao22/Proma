/**
 * 画布与 Agent 使用的独立生成模型来源。
 *
 * 画布侧原本从「统一媒体 API 模型目录」取候选，而那套条目借用 LLM 渠道凭据。
 * 这里改为只读独立生成目录（`image-generation-config-store`），在单个选择 ID 上
 * 同时固定「哪条配置 + 哪个模型」，并把凭据解析限制在本次主进程调用内。
 */
import type {
  CanvasImageMediaWorkflow,
  ImageGenerationModelSnapshot,
  ImageGenerationPublicCatalog,
  ImageGenerationPublicProfile,
} from '@proma/shared'
import { buildCanvasGenerationModelId, parseCanvasGenerationModelId } from '@proma/shared'
import type { ResolvedImageGenerationRoute } from '../image-generation-runtime'

/** 快照里引用的配置与模型。 */
interface ResolvedCanvasGenerationTarget {
  profile: ImageGenerationPublicProfile
  modelId: string
}

export interface ImageGenerationCanvasSourceOptions {
  /** 读取独立生成目录的公开快照。 */
  readCatalog(): ImageGenerationPublicCatalog
  /** 按配置 ID 解密 API Key；只在主进程调用链内使用。 */
  resolveApiKey(profileId: string): string
  /** 当前已接入执行器的供应商；未接入的一律按不可执行处理。 */
  executableProviders?: readonly ImageGenerationPublicProfile['provider'][]
}

/** 生产已接入执行器的供应商集合。 */
const DEFAULT_EXECUTABLE_PROVIDERS: readonly ImageGenerationPublicProfile['provider'][] = ['openai-images']

/**
 * 画布与 Agent 需要的生图运行能力。
 * 旧统一目录（ComfyUI 与历史作业）和独立生成来源共同满足该接口。
 */
export interface CanvasImageModelRuntime {
  resolveAvailableSnapshot(profileId: string, projectId?: string): ImageGenerationModelSnapshot
  assertSnapshotAvailable(snapshot: ImageGenerationModelSnapshot, projectId?: string): void
  resolveExecutionRoute(snapshot: ImageGenerationModelSnapshot, projectId?: string): ResolvedImageGenerationRoute
  resolveAvailableWorkflowSnapshot?(
    workflow: CanvasImageMediaWorkflow,
    projectId: string,
  ): Extract<ImageGenerationModelSnapshot, { executor: 'comfyui'; source: 'workflow' }>
}

/** 判断快照是否来自独立生成配置（而不是历史渠道快照）。 */
export function isGenerationSnapshot(snapshot: ImageGenerationModelSnapshot): boolean {
  return snapshot.executor === 'openai-images' && 'imageProfileId' in snapshot
}

/** 按选择 ID 读取独立生成配置与模型，任何不匹配都视为无效选择。 */
function resolveTarget(
  catalog: ImageGenerationPublicCatalog,
  selectionId: string,
): ResolvedCanvasGenerationTarget {
  const parsed = parseCanvasGenerationModelId(selectionId)
  if (!parsed) throw new Error('生图模型不可用：请重新选择模型')
  const profile = catalog.profiles.find((candidate) => candidate.id === parsed.profileId)
  if (!profile) throw new Error('生图模型不可用：配置已删除，请重新选择模型')
  const model = profile.models.find((candidate) => candidate.id === parsed.modelId)
  if (!model) throw new Error('生图模型不可用：模型已移除，请重新选择模型')
  if (!profile.enabled) throw new Error('生图模型不可用：配置已停用，请重新启用后再生成')
  return { profile, modelId: model.id }
}

/** 管理独立生成配置在画布侧的候选、快照与运行路由。 */
export class ImageGenerationCanvasSource {
  private readonly options: ImageGenerationCanvasSourceOptions
  private readonly executableProviders: ReadonlySet<string>

  constructor(options: ImageGenerationCanvasSourceOptions) {
    this.options = options
    this.executableProviders = new Set(options.executableProviders ?? DEFAULT_EXECUTABLE_PROVIDERS)
  }

  /**
   * 把一次画布选择固化为任务快照。
   * 入参：画布选择 ID；返回值：不含凭据的快照。
   * 只接受已接入执行器的供应商，避免任务落库后才在运行阶段失败。
   */
  resolveAvailableSnapshot(selectionId: string): ImageGenerationModelSnapshot {
    const catalog = this.options.readCatalog()
    const { profile, modelId } = resolveTarget(catalog, selectionId)
    this.assertExecutable(profile)
    const model = profile.models.find((candidate) => candidate.id === modelId)
    return {
      profileId: buildCanvasGenerationModelId(profile.id, modelId),
      name: `${profile.name} · ${model?.name ?? modelId}`,
      modelId,
      executor: 'openai-images',
      imageProfileId: profile.id,
    }
  }

  /** 实时复核快照仍指向同一条已启用配置与同一个模型。 */
  assertSnapshotAvailable(snapshot: ImageGenerationModelSnapshot): void {
    if (snapshot.executor !== 'openai-images' || !('imageProfileId' in snapshot)) {
      throw new Error('生图模型快照来源不受支持，请按当前配置重新生成')
    }
    const { profile, modelId } = resolveTarget(this.options.readCatalog(), snapshot.profileId)
    this.assertExecutable(profile)
    if (profile.id !== snapshot.imageProfileId || modelId !== snapshot.modelId) {
      throw new Error('生图模型快照与当前配置不一致，请按当前配置重新生成')
    }
  }

  /**
   * 解析单次执行的运行路由。
   * 入参：已复核的快照；返回值：仅本次调用存活的 baseUrl 与明文 Key。
   */
  resolveExecutionRoute(snapshot: ImageGenerationModelSnapshot): ResolvedImageGenerationRoute {
    this.assertSnapshotAvailable(snapshot)
    if (snapshot.executor !== 'openai-images' || !('imageProfileId' in snapshot)) {
      throw new Error('生图模型快照来源不受支持，请按当前配置重新生成')
    }
    const { profile } = resolveTarget(this.options.readCatalog(), snapshot.profileId)
    if (profile.provider !== 'openai-images') {
      throw new Error('生图模型快照与当前配置不一致，请按当前配置重新生成')
    }
    return {
      executor: 'openai-images',
      snapshot,
      baseUrl: profile.baseUrl.trim(),
      apiKey: this.options.resolveApiKey(profile.id),
    }
  }

  /** 判断选择 ID 是否属于独立生成配置。 */
  static isGenerationSelection(selectionId: string): boolean {
    return parseCanvasGenerationModelId(selectionId) !== null
  }

  /** 未接入执行器的供应商必须在选择阶段就明确拒绝。 */
  private assertExecutable(profile: ImageGenerationPublicProfile): void {
    if (!this.executableProviders.has(profile.provider)) {
      throw new Error(`生图模型不可用：${profile.provider} 的执行器尚未接入`)
    }
  }
}
