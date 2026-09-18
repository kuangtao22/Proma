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

/**
 * 供应商到执行器的映射。
 * 只列出主进程已实现执行器的供应商；即梦尚未接入，保持缺席以便如实拒绝。
 */
const PROVIDER_EXECUTORS: Partial<Record<ImageGenerationPublicProfile['provider'], GenerationExecutor>> = {
  'openai-images': 'openai-images',
  minimax: 'minimax-image',
  dreamina: 'dreamina-image',
}

/** 独立生成配置可用的执行器标识。 */
type GenerationExecutor = 'openai-images' | 'minimax-image' | 'dreamina-image'

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

/** 独立生成配置来源的快照：一定带 imageProfileId。 */
export type GenerationSourceSnapshot =
  | (Extract<ImageGenerationModelSnapshot, { executor: 'openai-images' }> & { imageProfileId: string })
  | (Extract<ImageGenerationModelSnapshot, { executor: 'minimax-image' }> & { imageProfileId: string })
  | (Extract<ImageGenerationModelSnapshot, { executor: 'dreamina-image' }> & { imageProfileId: string })

/** 判断快照是否来自独立生成配置（而不是历史渠道快照）。 */
export function isGenerationSnapshot(snapshot: ImageGenerationModelSnapshot): snapshot is GenerationSourceSnapshot {
  return (snapshot.executor === 'openai-images' || snapshot.executor === 'minimax-image' || snapshot.executor === 'dreamina-image')
    && 'imageProfileId' in snapshot
}

/** 收窄到 MiniMax 快照；联合类型分支需要显式判断才能配对执行器。 */
function authorizedSnapshotIsMiniMax(snapshot: GenerationSourceSnapshot): snapshot is Extract<GenerationSourceSnapshot, { executor: 'minimax-image' }> {
  return snapshot.executor === 'minimax-image'
}

/** 收窄到即梦快照；即梦走 CLI，不需要密钥。 */
function authorizedSnapshotIsDreamina(snapshot: GenerationSourceSnapshot): snapshot is Extract<GenerationSourceSnapshot, { executor: 'dreamina-image' }> {
  return snapshot.executor === 'dreamina-image'
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
  /** 调用方覆盖的已接执行器供应商；缺省用生产映射。 */
  private readonly executableOverrides: ReadonlySet<string> | null

  constructor(options: ImageGenerationCanvasSourceOptions) {
    this.options = options
    this.executableOverrides = options.executableProviders ? new Set(options.executableProviders) : null
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
    /** 联合类型需要分支构造，才能让 executor 与快照成员严格配对。 */
    const base = {
      profileId: buildCanvasGenerationModelId(profile.id, modelId),
      name: `${profile.name} · ${model?.name ?? modelId}`,
      modelId,
      imageProfileId: profile.id,
    }
    const executor = this.executorFor(profile)
    if (executor === 'minimax-image') return { ...base, executor: 'minimax-image' }
    if (executor === 'dreamina-image') return { ...base, executor: 'dreamina-image' }
    return { ...base, executor: 'openai-images' }
  }

  /** 实时复核快照仍指向同一条已启用配置与同一个模型。 */
  assertSnapshotAvailable(snapshot: ImageGenerationModelSnapshot): void {
    if (!isGenerationSnapshot(snapshot)) {
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
    if (!isGenerationSnapshot(snapshot)) {
      throw new Error('生图模型快照来源不受支持，请按当前配置重新生成')
    }
    const { profile } = resolveTarget(this.options.readCatalog(), snapshot.profileId)
    /** 快照执行器必须与当前配置推导出的执行器一致，避免供应商被换掉后沿用旧路由。 */
    const executor = this.executorFor(profile)
    if (executor !== snapshot.executor) {
      throw new Error('生图模型快照与当前配置不一致，请按当前配置重新生成')
    }
    /** 即梦凭据是本机 CLI 登录态，路由只需要 CLI 路径。 */
    if (authorizedSnapshotIsDreamina(snapshot)) {
      const cliPath = profile.provider === 'dreamina' ? profile.cliPath?.trim() : undefined
      return cliPath ? { executor: 'dreamina-image', snapshot, cliPath } : { executor: 'dreamina-image', snapshot }
    }
    if (profile.provider === 'dreamina') {
      throw new Error('生图模型快照与当前配置不一致，请按当前配置重新生成')
    }
    const baseUrl = profile.baseUrl.trim()
    const apiKey = this.options.resolveApiKey(profile.id)
    /** 联合类型需要在分支里收窄，才能让执行器与快照类型配对。 */
    if (authorizedSnapshotIsMiniMax(snapshot)) return { executor: 'minimax-image', snapshot, baseUrl, apiKey }
    return {
      executor: 'openai-images',
      snapshot: snapshot as Extract<GenerationSourceSnapshot, { executor: 'openai-images' }>,
      baseUrl,
      apiKey,
    }
  }

  /** 判断选择 ID 是否属于独立生成配置。 */
  static isGenerationSelection(selectionId: string): boolean {
    return parseCanvasGenerationModelId(selectionId) !== null
  }

  /** 推导供应商对应的执行器；未接入的一律在运行前拒绝。 */
  private executorFor(profile: ImageGenerationPublicProfile): GenerationExecutor {
    const allowed = this.executableOverrides === null || this.executableOverrides.has(profile.provider)
    const executor = allowed ? PROVIDER_EXECUTORS[profile.provider] : undefined
    if (!executor) throw new Error(`生图模型不可用：${profile.provider} 的执行器尚未接入`)
    return executor
  }

  /** 未接入执行器的供应商必须在选择阶段就明确拒绝。 */
  private assertExecutable(profile: ImageGenerationPublicProfile): void {
    this.executorFor(profile)
  }
}
