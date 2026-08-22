import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, normalize, sep, win32 } from 'node:path'
import {
  DESIGN_DOCUMENT_VERSION,
  createEmptyDesignDocument,
} from '@proma/shared'
import type {
  DesignAnnotation,
  DesignAsset,
  DesignCanvasDocument,
  DesignCanvasNode,
  DesignGroup,
  DesignMutation,
  DesignPoint,
  DesignViewport,
  DesignWorkspaceSnapshot,
} from '@proma/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { designPathResolver } from './design-paths'
import type { DesignPathResolver, DesignPaths } from './design-paths'

/** 允许跨 revision 重放且不会覆盖结构的 mutation。 */
const REBASEABLE_MUTATIONS = new Set<DesignMutation['type']>([
  'set-viewport',
  'move-nodes',
])

/** Design 素材允许持久化的图片媒体类型。 */
const SUPPORTED_DESIGN_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/** Design 存储创建时可替换的窄依赖。 */
export interface DesignStoreOptions {
  /** 从稳定项目 ID 解析可信目录。 */
  pathResolver?: DesignPathResolver
  /** 返回当前时间，测试可注入固定值。 */
  now?: () => number
}

/** 项目 Design 文档的加载和 revision mutation 接口。 */
export interface DesignStore {
  /** 加载项目画布并标记是否发生安全恢复。 */
  load: (projectId: string) => DesignWorkspaceSnapshot
  /** 在磁盘最新 revision 上应用一组受控 mutation。 */
  mutate: (
    projectId: string,
    expectedRevision: number,
    mutations: DesignMutation[],
  ) => DesignCanvasDocument
}

/** JSON 候选实际来自哪个恢复层。 */
type DesignRecoverySource = NonNullable<DesignWorkspaceSnapshot['recoveredFrom']>

/** 未知 JSON 对象的安全索引结构。 */
interface UnknownRecord {
  [key: string]: unknown
}

/** 判断未知值是否为非空对象。 */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断未知值是否为有限数。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 判断未知值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 判断未知值是否为有限二维坐标。 */
function isDesignPoint(value: unknown): value is DesignPoint {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y)
}

/** 判断未知值是否为合法画布视口。 */
function isDesignViewport(value: unknown): value is DesignViewport {
  return isRecord(value)
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.zoom)
    && value.zoom >= 0.05
    && value.zoom <= 8
}

/** 判断相对素材路径不会逃逸受管目录。 */
function isSafeRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value) || isAbsolute(value) || win32.isAbsolute(value)) return false
  /** 统一分隔符，确保 Windows 风格路径在所有平台都按段检查。 */
  const normalizedSeparators = value.replaceAll('\\', '/')
  /** 路径中的任意上级段都会突破受管目录。 */
  const segments = normalizedSeparators.split('/')
  if (segments.some((segment) => segment === '..' || segment.length === 0)) return false
  /** 当前平台 normalize 后仍须保持相对且不回退。 */
  const normalizedPath = normalize(value)
  return normalizedPath !== '..'
    && !normalizedPath.startsWith(`..${sep}`)
    && !isAbsolute(normalizedPath)
}

/** 判断未知素材记录满足持久化 schema。 */
function isDesignAsset(value: unknown): value is DesignAsset {
  if (!isRecord(value)) return false
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.filename)
    && isSafeRelativePath(value.relativePath)
    && isSafeRelativePath(value.thumbnailRelativePath)
    && typeof value.mediaType === 'string'
    && SUPPORTED_DESIGN_MEDIA_TYPES.has(value.mediaType)
    && isFiniteNumber(value.width)
    && value.width > 0
    && isFiniteNumber(value.height)
    && value.height > 0
    && isFiniteNumber(value.byteSize)
    && value.byteSize >= 0
    && isNonEmptyString(value.sha256)
    && isFiniteNumber(value.createdAt)
    && isOptionalNonEmptyString(value.sourceSessionId)
    && isOptionalNonEmptyString(value.sourceJobId)
    && isOptionalString(value.prompt)
    && isOptionalNonEmptyString(value.parentAssetId)
}

/** 判断未知节点满足持久化 schema。 */
function isDesignNode(value: unknown): value is DesignCanvasNode {
  if (!isRecord(value)) return false
  /** 节点类型必须与所引用的业务实体一致。 */
  const hasValidKindReference = value.kind === 'asset'
    ? isNonEmptyString(value.assetId) && value.jobId === undefined
    : value.kind === 'job'
      ? isNonEmptyString(value.jobId) && value.assetId === undefined
      : false
  return isNonEmptyString(value.id)
    && hasValidKindReference
    && isDesignPoint(value.position)
    && isFiniteNumber(value.width)
    && value.width > 0
    && isFiniteNumber(value.height)
    && value.height > 0
    && isFiniteNumber(value.zIndex)
    && isOptionalNonEmptyString(value.groupId)
}

/** 判断未知分组满足持久化 schema。 */
function isDesignGroup(value: unknown): value is DesignGroup {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.name)
    && isUniqueNonEmptyStringArray(value.nodeIds)
}

/** 判断未知批注满足箭头或蒙版 schema。 */
function isDesignAnnotation(value: unknown): value is DesignAnnotation {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.color)
    || !isFiniteNumber(value.width)
    || value.width <= 0
    || !isFiniteNumber(value.createdAt)) {
    return false
  }
  if (value.kind === 'arrow') {
    return isDesignPoint(value.from) && isDesignPoint(value.to)
  }
  if (value.kind === 'mask') {
    return Array.isArray(value.points)
      && value.points.length >= 2
      && value.points.every(isDesignPoint)
  }
  return false
}

/** 判断可选值缺失或为非空字符串。 */
function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value)
}

/** 判断可选值缺失或为字符串，允许空 prompt。 */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/** 判断未知值为不重复的非空字符串数组。 */
function isUniqueNonEmptyStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) return false
  return new Set(value).size === value.length
}

/** 判断带 ID 的实体数组内部 ID 唯一。 */
function hasUniqueIds<T extends { id: string }>(items: T[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length
}

/**
 * 校验磁盘画布文档及其跨实体引用。
 * @param value 从 JSON 读取的未知值。
 * @param projectId 当前可信工作区 ID。
 * @returns value 是否可作为该项目的 Design 文档使用。
 */
export function isDesignCanvasDocument(
  value: unknown,
  projectId: string,
): value is DesignCanvasDocument {
  if (!isRecord(value)
    || value.schemaVersion !== DESIGN_DOCUMENT_VERSION
    || value.projectId !== projectId
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || !isFiniteNumber(value.createdAt)
    || !isFiniteNumber(value.updatedAt)
    || !isDesignViewport(value.viewport)
    || !Array.isArray(value.assets)
    || !value.assets.every(isDesignAsset)
    || !Array.isArray(value.nodes)
    || !value.nodes.every(isDesignNode)
    || !Array.isArray(value.groups)
    || !value.groups.every(isDesignGroup)
    || !Array.isArray(value.annotations)
    || !value.annotations.every(isDesignAnnotation)) {
    return false
  }

  /** 已通过单体 schema 校验的素材列表。 */
  const assets = value.assets
  /** 已通过单体 schema 校验的节点列表。 */
  const nodes = value.nodes
  /** 已通过单体 schema 校验的分组列表。 */
  const groups = value.groups
  /** 已通过单体 schema 校验的批注列表。 */
  const annotations = value.annotations
  if (!hasUniqueIds(assets)
    || !hasUniqueIds(nodes)
    || !hasUniqueIds(groups)
    || !hasUniqueIds(annotations)) {
    return false
  }

  /** 用于校验素材父版本和节点素材引用的素材 ID。 */
  const assetIds = new Set(assets.map((asset) => asset.id))
  /** 用于校验分组成员引用的节点 ID。 */
  const nodeIds = new Set(nodes.map((node) => node.id))
  /** 用于校验节点分组引用的分组 ID。 */
  const groupIds = new Set(groups.map((group) => group.id))
  return assets.every((asset) => asset.parentAssetId === undefined || assetIds.has(asset.parentAssetId))
    && nodes.every((node) => node.assetId === undefined || assetIds.has(node.assetId))
    && nodes.every((node) => node.groupId === undefined || groupIds.has(node.groupId))
    && groups.every((group) => group.nodeIds.every((nodeId) => nodeIds.has(nodeId)))
}

/** 使用稳定 ID 合并实体数组，保留未更新实体原顺序。 */
function upsertById<T extends { id: string }>(current: T[], updates: T[]): T[] {
  /** 按原顺序初始化、按更新覆盖的实体映射。 */
  const next = new Map(current.map((item) => [item.id, item]))
  for (const update of updates) next.set(update.id, update)
  return [...next.values()]
}

/**
 * 以纯函数方式依次应用一组受控 Design mutation。
 * @param document 当前不可直接修改的画布文档。
 * @param mutations 需要按顺序应用的变更集合。
 * @returns 不会修改输入文档的新文档。
 */
export function applyDesignMutations(
  document: DesignCanvasDocument,
  mutations: DesignMutation[],
): DesignCanvasDocument {
  /** 深拷贝确保调用方持有的旧 revision 不会被修改。 */
  let next = structuredClone(document)
  for (const mutation of mutations) {
    switch (mutation.type) {
      case 'set-viewport':
        next.viewport = mutation.viewport
        break
      case 'move-nodes': {
        /** 本次移动中每个节点的最终位置。 */
        const positions = new Map(mutation.positions.map((item) => [item.nodeId, item.position]))
        next.nodes = next.nodes.map((node) => positions.has(node.id)
          ? { ...node, position: positions.get(node.id)! }
          : node)
        break
      }
      case 'upsert-nodes':
        next.nodes = upsertById(next.nodes, mutation.nodes)
        break
      case 'remove-nodes':
        next.nodes = next.nodes.filter((node) => !mutation.nodeIds.includes(node.id))
        break
      case 'upsert-assets':
        next.assets = upsertById(next.assets, mutation.assets)
        break
      case 'remove-assets':
        next.assets = next.assets.filter((asset) => !mutation.assetIds.includes(asset.id))
        break
      case 'upsert-groups':
        next.groups = upsertById(next.groups, mutation.groups)
        break
      case 'remove-groups':
        next.groups = next.groups.filter((group) => !mutation.groupIds.includes(group.id))
        break
      case 'upsert-annotations':
        next.annotations = upsertById(next.annotations, mutation.annotations)
        break
      case 'remove-annotations':
        next.annotations = next.annotations.filter((item) => !mutation.annotationIds.includes(item.id))
        break
      default:
        throw new Error('DESIGN_MUTATION_INVALID')
    }
  }
  return next
}

/** 校验陈旧 revision 是否仅包含可安全重放的布局变更。 */
function assertCanApply(
  expectedRevision: number,
  currentRevision: number,
  mutations: DesignMutation[],
): void {
  if (expectedRevision === currentRevision) return
  if (mutations.every((mutation) => REBASEABLE_MUTATIONS.has(mutation.type))) return
  throw new Error(`DESIGN_REVISION_CONFLICT: expected=${expectedRevision}, current=${currentRevision}`)
}

/** 创建 Design 所需正式目录和缓存目录，但不创建空画布文件。 */
function ensureDesignDirectories(paths: DesignPaths): void {
  /** 加载和后续素材操作共同依赖的目录集合。 */
  const directories = [
    paths.designRoot,
    paths.assetsDir,
    paths.annotationsDir,
    paths.cacheRoot,
    paths.thumbnailsDir,
    paths.jobsDir,
    paths.stagingDir,
  ]
  for (const directory of directories) mkdirSync(directory, { recursive: true })
}

/** 尝试读取单个 JSON 候选并使用正式 validator 校验。 */
function isValidCandidate(candidatePath: string, projectId: string): boolean {
  if (!existsSync(candidatePath)) return false
  try {
    /** 候选文件解析后的未知 JSON 值。 */
    const value: unknown = JSON.parse(readFileSync(candidatePath, 'utf8'))
    return isDesignCanvasDocument(value, projectId)
  } catch {
    return false
  }
}

/** 在 safe-file 提升候选前记录实际恢复层。 */
function detectRecoverySource(
  canvasPath: string,
  projectId: string,
): DesignRecoverySource | undefined {
  if (isValidCandidate(canvasPath, projectId)) return undefined
  if (isValidCandidate(`${canvasPath}.tmp`, projectId)) return 'tmp'
  if (isValidCandidate(`${canvasPath}.bak`, projectId)) return 'backup'
  return undefined
}

/** 判断画布路径是否至少存在一个主/tmp/bak 候选。 */
function hasAnyCanvasCandidate(canvasPath: string): boolean {
  return [canvasPath, `${canvasPath}.tmp`, `${canvasPath}.bak`].some(existsSync)
}

/**
 * 创建基于 safe-file 的 Design revision 存储。
 * @param options 可信路径解析器与时钟依赖。
 * @returns 可加载和原子修改项目画布的同步存储。
 */
export function createDesignStore(options: DesignStoreOptions = {}): DesignStore {
  /** 生产默认使用进程级可信路径解析器。 */
  const pathResolver = options.pathResolver ?? designPathResolver
  /** 生产默认使用系统当前时间。 */
  const now = options.now ?? Date.now

  /** 从磁盘恢复链加载当前项目文档。 */
  function load(projectId: string): DesignWorkspaceSnapshot {
    /** 当前项目所有 Design 路径。 */
    const paths = pathResolver.resolve(projectId)
    ensureDesignDirectories(paths)
    /** safe-file 提升候选前检测到的恢复来源。 */
    const recoveredFrom = detectRecoverySource(paths.canvasPath, projectId)
    /** 当前是否存在任何画布候选，用于区分空画布与全部损坏。 */
    const hasCandidate = hasAnyCanvasCandidate(paths.canvasPath)
    /** 通过主/tmp/bak 恢复链读取并校验的文档。 */
    const document = readJsonFileSafe<DesignCanvasDocument>(paths.canvasPath, {
      validate: (value): value is DesignCanvasDocument => isDesignCanvasDocument(value, projectId),
    })
    if (!document && hasCandidate) {
      throw new Error(`DESIGN_DOCUMENT_CORRUPT: ${projectId}`)
    }
    return {
      document: document ?? createEmptyDesignDocument(projectId, now()),
      writable: true,
      ...(recoveredFrom ? { recoveredFrom } : {}),
    }
  }

  /** 在磁盘最新 revision 上应用并原子保存 mutation。 */
  function mutate(
    projectId: string,
    expectedRevision: number,
    mutations: DesignMutation[],
  ): DesignCanvasDocument {
    /** mutation 开始时重新加载的磁盘最新文档。 */
    const current = load(projectId).document
    assertCanApply(expectedRevision, current.revision, mutations)
    /** 尚未递增 revision 的 mutation 结果。 */
    const mutated = applyDesignMutations(current, mutations)
    /** 本次提交的统一更新时间。 */
    const updatedAt = now()
    /** 递增 revision 后准备持久化的完整文档。 */
    const next: DesignCanvasDocument = {
      ...mutated,
      revision: current.revision + 1,
      updatedAt,
    }
    if (!isDesignCanvasDocument(next, projectId)) {
      throw new Error('DESIGN_DOCUMENT_INVALID')
    }
    /** 重新解析路径，避免存储跨调用缓存已迁移的项目根。 */
    const paths = pathResolver.resolve(projectId)
    writeJsonFileAtomic(paths.canvasPath, next)
    return next
  }

  return { load, mutate }
}

/** 生产进程共享的 Design 存储实例。 */
export const designStore = createDesignStore()
