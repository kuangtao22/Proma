import {
  parseCanvasImageModuleConfig,
  parseCanvasNodeContentMeta,
  parseSaveCanvasImageModuleInput,
} from '@proma/shared'
import type {
  CanvasImageArtifactVersion,
  CanvasImageModuleConfig,
  CanvasImageTarget,
  DesignAsset,
  DesignJobRecord,
  SaveCanvasImageModuleInput,
} from '@proma/shared'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import type {
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
} from '../stable-directory-native-host'
import type {
  CanvasDocumentStore,
  CanvasTrustedDirectoryCapability,
} from './canvas-document-store'

/** 图片配置文件读取上限，阻止损坏文件放大主进程内存。 */
const MAX_IMAGE_CONFIG_LENGTH = 256 * 1024
/** 图片模块稳定 ID 使用的共享字符边界。 */
const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
/** 图片版本默认只返回有限历史，避免长生命周期项目无限放大单次读取。 */
const DEFAULT_IMAGE_VERSION_LIMIT = 100

/** 判断任务是否精确属于目标图片模块。 */
function isOwnedCanvasImageJob(job: DesignJobRecord, target: CanvasImageTarget): boolean {
  return job.projectId === target.projectId
    && job.target?.kind === 'canvas-image'
    && job.target.canvasId === target.canvasId
    && job.target.nodeId === target.nodeId
    && job.target.imageModuleId === target.imageModuleId
}

/**
 * 从现有 Job 与素材事实派生有限图片版本，不创建第二份 revision 数据。
 * @param target 图片模块完整身份。
 * @param jobs 项目或模块现有任务列表。
 * @param assets 项目现有素材列表。
 * @param limit 最多返回的版本数量。
 * @returns 去重且按创建时间稳定倒序的合法成功版本。
 */
export function deriveCanvasImageArtifactVersions(
  target: CanvasImageTarget,
  jobs: readonly DesignJobRecord[],
  assets: readonly DesignAsset[],
  limit = DEFAULT_IMAGE_VERSION_LIMIT,
): CanvasImageArtifactVersion[] {
  /** 有限上限必须是安全正整数，非法调用不允许退化为无限列表。 */
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('CANVAS_IMAGE_VERSION_LIMIT_INVALID')
  /** 素材 ID 索引让任务与输出关联保持 O(jobs + assets)。 */
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
  /** 已收录素材用于防止多个异常任务重复声明同一输出。 */
  const seenAssetIds = new Set<string>()
  /** 只保留可由当前任务和仍存在素材共同证明的版本。 */
  const versions: CanvasImageArtifactVersion[] = []
  for (const job of jobs) {
    if (job.status !== 'succeeded' || !job.outputAssetId || !isOwnedCanvasImageJob(job, target)) continue
    /** 素材必须仍存在且来源任务精确匹配。 */
    const asset = assetsById.get(job.outputAssetId)
    if (!asset || asset.sourceJobId !== job.id || seenAssetIds.has(asset.id)) continue
    seenAssetIds.add(asset.id)
    versions.push({ jobId: job.id, assetId: asset.id, createdAt: asset.createdAt })
  }
  return versions
    .sort((left, right) => right.createdAt - left.createdAt
      || left.assetId.localeCompare(right.assetId)
      || left.jobId.localeCompare(right.jobId))
    .slice(0, limit)
}

/** Canvas 图片模块的权威配置接口。 */
export interface CanvasImageModuleStore {
  load: (target: CanvasImageTarget) => Promise<CanvasImageModuleConfig>
  save: (input: SaveCanvasImageModuleInput) => Promise<CanvasImageModuleConfig>
  adoptAsset: (
    target: CanvasImageTarget,
    expectedConfigRevision: number,
    assetId: string,
  ) => Promise<CanvasImageModuleConfig>
}

/** 图片模块 Store 的可信依赖。 */
export interface CanvasImageModuleStoreDependencies {
  store: Pick<CanvasDocumentStore, 'loadWithDirectoryCapability'>
  runStableDirectoryNative?: (
    request: StableDirectoryNativeRequest,
    authorize: CanvasTrustedDirectoryCapability['authorizeOpenedRoots'],
  ) => Promise<StableDirectoryNativeResult>
  now?: () => number
}

/** schema v1 只用于可信迁移，字段必须精确匹配。 */
interface LegacyCanvasImageModuleConfig {
  schemaVersion: 1
  kind: 'image'
  contentId: string
  revision: number
  createdAt: number
  updatedAt: number
  prompt: string
  selectedModelProfileId: string | null
  adoptedAssetId: string | null
}

/** 判断未知值是否为无未知字段的普通记录。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  /** 实际字段集合。 */
  const actual = Object.keys(value).sort()
  /** 期望字段集合。 */
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** 严格解析 JSON，禁止把语法错误降级为空配置。 */
function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown
  } catch {
    throw new Error('CANVAS_IMAGE_CONFIG_INVALID')
  }
}

/** 严格解析旧图片配置并补入稳定 v2 默认值。 */
function migrateLegacyConfig(value: unknown): CanvasImageModuleConfig {
  /** v1 图片配置允许的完整字段集合。 */
  const keys = [
    'schemaVersion', 'kind', 'contentId', 'revision', 'createdAt', 'updatedAt',
    'prompt', 'selectedModelProfileId', 'adoptedAssetId',
  ] as const
  if (!hasExactKeys(value, keys)
    || value.schemaVersion !== 1
    || value.kind !== 'image'
    || typeof value.contentId !== 'string'
    || !IMAGE_ID_PATTERN.test(value.contentId)
    || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
    || typeof value.updatedAt !== 'number'
    || !Number.isSafeInteger(value.updatedAt)
    || value.updatedAt < 0
    || typeof value.prompt !== 'string'
    || value.prompt.length > 100_000
    || (value.selectedModelProfileId !== null
      && (typeof value.selectedModelProfileId !== 'string'
        || !IMAGE_ID_PATTERN.test(value.selectedModelProfileId)))
    || (value.adoptedAssetId !== null
      && (typeof value.adoptedAssetId !== 'string'
        || !IMAGE_ID_PATTERN.test(value.adoptedAssetId)))) {
    throw new Error('CANVAS_IMAGE_CONFIG_INVALID')
  }
  /** 类型收窄后的旧配置。 */
  const legacy = value as unknown as LegacyCanvasImageModuleConfig
  return {
    ...legacy,
    schemaVersion: 2,
    aspectRatio: '1:1',
    imageSize: 'auto',
    contextMode: 'auto',
  }
}

/** 创建 Canvas 图片模块 Store。 */
export function createCanvasImageModuleStore(
  dependencies: CanvasImageModuleStoreDependencies,
): CanvasImageModuleStore {
  /** Native helper 调用边界。 */
  const runNative = dependencies.runStableDirectoryNative ?? runStableDirectoryNative
  /** 有限时间来源。 */
  const now = dependencies.now ?? Date.now

  /** 加载并验证图片节点归属，再返回 nodes capability。 */
  const loadScope = (target: CanvasImageTarget): CanvasTrustedDirectoryCapability => {
    /** 与目录能力绑定的权威 Canvas LOAD。 */
    const loaded = dependencies.store.loadWithDirectoryCapability({
      projectId: target.projectId,
      canvasId: target.canvasId,
    })
    /** 目标节点必须仍引用同一图片模块。 */
    const node = loaded.snapshot.document.nodes.find((candidate) => candidate.id === target.nodeId)
    if (!node || node.kind !== 'image' || node.imageModuleId !== target.imageModuleId) {
      throw new Error('CANVAS_IMAGE_TARGET_INVALID')
    }
    /** 图片内容统一位于 Canvas 的 nodes 受管子目录。 */
    const capability = loaded.openSingleChildDirectory('nodes')
    capability.assertValid()
    return capability
  }

  /** 读取图片模块内的固定受管文件。 */
  const readFile = async (
    capability: CanvasTrustedDirectoryCapability,
    target: CanvasImageTarget,
    fileName: 'config.json' | 'meta.json',
  ): Promise<string> => {
    capability.assertValid()
    /** helper 的无路径读取结果。 */
    const result = await runNative({
      mode: 'canvas-content-read',
      roots: [capability.rootPath],
      childName: 'nodes',
      entryId: target.imageModuleId,
      fileName,
    }, capability.authorizeOpenedRoots)
    capability.assertValid()
    if (!result.readOutcome || result.readOutcome.status !== 'ok') {
      throw new Error('CANVAS_IMAGE_CONFIG_INVALID')
    }
    if (result.readOutcome.content.length > MAX_IMAGE_CONFIG_LENGTH) {
      throw new Error('CANVAS_IMAGE_CONFIG_INVALID')
    }
    return result.readOutcome.content
  }

  /** 原子替换图片模块内的固定受管文件。 */
  const writeFile = async (
    capability: CanvasTrustedDirectoryCapability,
    target: CanvasImageTarget,
    fileName: 'config.json' | 'meta.json',
    content: string,
  ): Promise<void> => {
    /** helper 的原子写结果。 */
    const result = await runNative({
      mode: 'canvas-content-write',
      roots: [capability.rootPath],
      childName: 'nodes',
      entryId: target.imageModuleId,
      fileName,
      content,
      maxEntries: 512,
    }, capability.authorizeOpenedRoots)
    if (!result.writeOutcome?.commitVisible) throw new Error('CANVAS_IMAGE_SAVE_FAILED')
    capability.assertValid()
    if (result.writeOutcome.durabilityUncertain) throw new Error('CANVAS_IMAGE_SAVE_UNCERTAIN')
  }

  /** 读取配置、公共 meta 并复核同一身份与 revision。 */
  const loadWithScope = async (
    target: CanvasImageTarget,
    capability: CanvasTrustedDirectoryCapability,
  ): Promise<CanvasImageModuleConfig> => {
    /** 原始配置用于区分 v1 迁移与 v2 读取。 */
    const rawConfig = parseJson(await readFile(capability, target, 'config.json'))
    /** v2 直接严格解析；v1 只通过精确迁移器。 */
    const config = hasExactKeys(rawConfig, [
      'schemaVersion', 'kind', 'contentId', 'revision', 'createdAt', 'updatedAt',
      'prompt', 'selectedModelProfileId', 'aspectRatio', 'imageSize', 'contextMode', 'adoptedAssetId',
    ])
      ? parseCanvasImageModuleConfig(rawConfig)
      : migrateLegacyConfig(rawConfig)
    /** 公共 meta 仍使用统一 schema v1 身份提交标记。 */
    const meta = parseCanvasNodeContentMeta(parseJson(await readFile(capability, target, 'meta.json')))
    if (config.contentId !== target.imageModuleId
      || meta.kind !== 'image'
      || meta.contentId !== target.imageModuleId
      || config.revision !== meta.revision
      || config.createdAt !== meta.createdAt
      || config.updatedAt !== meta.updatedAt) {
      throw new Error('CANVAS_IMAGE_IDENTITY_CONFLICT')
    }
    if ((rawConfig as { schemaVersion?: unknown }).schemaVersion === 1) {
      await writeFile(capability, target, 'config.json', `${JSON.stringify(config, null, 2)}\n`)
    }
    return config
  }

  /** 保存已经构造好的下一 revision，并最后提交公共 meta。 */
  const commitConfig = async (
    target: CanvasImageTarget,
    capability: CanvasTrustedDirectoryCapability,
    config: CanvasImageModuleConfig,
  ): Promise<CanvasImageModuleConfig> => {
    await writeFile(capability, target, 'config.json', `${JSON.stringify(config, null, 2)}\n`)
    await writeFile(capability, target, 'meta.json', `${JSON.stringify({
      schemaVersion: 1,
      kind: 'image',
      contentId: config.contentId,
      revision: config.revision,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    }, null, 2)}\n`)
    return config
  }

  return {
    load: async (target) => {
      const capability = loadScope(target)
      return loadWithScope(target, capability)
    },
    save: async (rawInput) => {
      const input = parseSaveCanvasImageModuleInput(rawInput)
      const capability = loadScope(input)
      const current = await loadWithScope(input, capability)
      if (current.revision !== input.expectedConfigRevision) {
        throw new Error('CANVAS_IMAGE_REVISION_CONFLICT')
      }
      /** 保存操作的新有限时间戳。 */
      const timestamp = now()
      if (!Number.isSafeInteger(timestamp) || timestamp < current.updatedAt) {
        throw new Error('CANVAS_IMAGE_TIME_INVALID')
      }
      return commitConfig(input, capability, {
        ...current,
        revision: current.revision + 1,
        updatedAt: timestamp,
        prompt: input.prompt,
        selectedModelProfileId: input.selectedModelProfileId,
        aspectRatio: input.aspectRatio,
        imageSize: input.imageSize,
        contextMode: input.contextMode,
      })
    },
    adoptAsset: async (target, expectedConfigRevision, assetId) => {
      if (!IMAGE_ID_PATTERN.test(assetId)) throw new Error('CANVAS_IMAGE_ASSET_INVALID')
      const capability = loadScope(target)
      const current = await loadWithScope(target, capability)
      if (current.revision !== expectedConfigRevision) {
        throw new Error('CANVAS_IMAGE_REVISION_CONFLICT')
      }
      /** 素材采用操作的新有限时间戳。 */
      const timestamp = now()
      if (!Number.isSafeInteger(timestamp) || timestamp < current.updatedAt) {
        throw new Error('CANVAS_IMAGE_TIME_INVALID')
      }
      return commitConfig(target, capability, {
        ...current,
        revision: current.revision + 1,
        updatedAt: timestamp,
        adoptedAssetId: assetId,
      })
    },
  }
}
