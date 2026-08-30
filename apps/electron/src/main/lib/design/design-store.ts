import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep, win32 } from 'node:path'
import {
  applyDesignEntityPatch,
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
import { removeFileAtomic, writeJsonFileAtomicSecure } from '../safe-file'
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
  /** 幂等落盘项目的 legacy Design 空文档或返回既有权威文档。 */
  initialize: (projectId: string) => DesignCanvasDocument
  /** 加载未发生恢复的权威文档；恢复候选必须先由 Renderer 重载确认。 */
  requireStableAuthoritativeDocument: (projectId: string) => DesignCanvasDocument
  /** 在磁盘最新 revision 上应用一组受控 mutation。 */
  mutate: (
    projectId: string,
    expectedRevision: number,
    mutations: DesignMutation[],
    /** 在同一次磁盘加载后、应用 mutation 前校验权威文档。 */
    validateCurrent?: (document: DesignCanvasDocument) => void,
  ) => DesignCanvasDocument
}

/** JSON 候选实际来自哪个恢复层。 */
type DesignRecoverySource = NonNullable<DesignWorkspaceSnapshot['recoveredFrom']>

/** no-follow 目录身份，用于创建、读取和 rename 前复验。 */
interface DesignDirectoryIdentity {
  path: string
  canonicalPath: string
  dev: number | bigint
  ino: number | bigint
}

/** 可比较的文件系统对象身份字段。 */
interface DesignFileIdentity {
  dev: number | bigint
  ino: number | bigint
}

/** 单个画布候选的安全读取结果。 */
interface DesignCandidateState {
  exists: boolean
  document: DesignCanvasDocument | null
}

/** 画布恢复链读取结果。 */
interface DesignDocumentReadResult {
  document: DesignCanvasDocument | null
  recoveredFrom?: DesignRecoverySource
  hasCandidate: boolean
}

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
  if (!isNonEmptyString(value)
    || isAbsolute(value)
    || win32.isAbsolute(value)
    || value.includes('\\')
    || /^[A-Za-z]:/.test(value)) {
    return false
  }
  /** 路径中的任意上级段都会突破受管目录。 */
  const segments = value.split('/')
  if (segments.some((segment) => segment === '..' || segment.length === 0)) return false
  /** 当前平台 normalize 后仍须保持相对且不回退。 */
  const normalizedPath = normalize(value)
  return normalizedPath !== '..'
    && !normalizedPath.startsWith(`..${sep}`)
    && !isAbsolute(normalizedPath)
}

/** 判断素材相对路径位于指定受管一级目录。 */
function isSafeManagedRelativePath(value: unknown, directoryName: string): value is string {
  if (!isSafeRelativePath(value)) return false
  /** 持久化路径必须以固定目录前缀开头并包含叶子。 */
  return value.startsWith(`${directoryName}/`)
    && value.length > directoryName.length + 1
}

/** 判断未知素材记录满足持久化 schema。 */
function isDesignAsset(value: unknown): value is DesignAsset {
  if (!isRecord(value)) return false
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.filename)
    && isSafeManagedRelativePath(value.relativePath, 'assets')
    && isSafeManagedRelativePath(value.thumbnailRelativePath, 'thumbnails')
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

/** 判断实体指定字符串字段在集合中不重复。 */
function hasUniqueStringField<T>(items: T[], select: (item: T) => string): boolean {
  return new Set(items.map(select)).size === items.length
}

/** 判断素材父版本引用不存在自环或任意环。 */
function hasAcyclicAssetParents(assets: DesignAsset[]): boolean {
  /** 按素材 ID 查询可选父版本。 */
  const parentById = new Map(assets.map((asset) => [asset.id, asset.parentAssetId]))
  /** 访问状态：1 表示当前父链中，2 表示该父链已经确认无环。 */
  const visitState = new Map<string, 1 | 2>()
  for (const asset of assets) {
    if (visitState.get(asset.id) === 2) continue
    /** 本轮结束后需要统一标记为已确认无环的父链。 */
    const traversedIds: string[] = []
    /** 当前正在检查的父链节点。 */
    let currentId: string | undefined = asset.id
    while (currentId !== undefined) {
      /** 再次进入当前父链代表检测到环，进入已完成父链则可提前结束。 */
      const state = visitState.get(currentId)
      if (state === 1) return false
      if (state === 2) break
      visitState.set(currentId, 1)
      traversedIds.push(currentId)
      currentId = parentById.get(currentId)
    }
    for (const traversedId of traversedIds) visitState.set(traversedId, 2)
  }
  return true
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
    || !hasUniqueIds(annotations)
    || !hasUniqueStringField(assets, (asset) => asset.relativePath)
    || !hasUniqueStringField(assets, (asset) => asset.thumbnailRelativePath)
    || !hasAcyclicAssetParents(assets)) {
    return false
  }

  /** 用于校验素材父版本和节点素材引用的素材 ID。 */
  const assetIds = new Set(assets.map((asset) => asset.id))
  /** 用于校验分组成员引用的节点 ID。 */
  const nodeIds = new Set(nodes.map((node) => node.id))
  /** 用于校验节点分组引用的分组 ID。 */
  const groupIds = new Set(groups.map((group) => group.id))
  /** 用于线性校验分组反向成员关系的节点索引。 */
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  /** 用于线性校验节点反向分组关系的分组索引。 */
  const groupById = new Map(groups.map((group) => [group.id, group]))
  /** 用于常数时间校验节点是否被所属分组列出的成员索引。 */
  const groupNodeIds = new Map(groups.map((group) => [group.id, new Set(group.nodeIds)]))
  return assets.every((asset) => asset.parentAssetId === undefined || assetIds.has(asset.parentAssetId))
    && nodes.every((node) => node.assetId === undefined || assetIds.has(node.assetId))
    && nodes.every((node) => node.groupId === undefined || groupIds.has(node.groupId))
    && groups.every((group) => group.nodeIds.every((nodeId) => nodeIds.has(nodeId)))
    && nodes.every((node) => {
      /** 节点所属分组必须反向列出该节点。 */
      const group = node.groupId === undefined
        ? undefined
        : groupById.get(node.groupId)
      return node.groupId === undefined
        || (group !== undefined && groupNodeIds.get(group.id)?.has(node.id) === true)
    })
    && groups.every((group) => group.nodeIds.every((nodeId) => {
      /** 分组成员节点必须反向声明同一 groupId。 */
      const node = nodeById.get(nodeId)
      return node?.groupId === group.id
    }))
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
      case 'patch-nodes':
        next.nodes = applyDesignEntityPatch(next.nodes, mutation.removeIds, mutation.upserts)
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
      case 'patch-groups':
        next.groups = applyDesignEntityPatch(next.groups, mutation.removeIds, mutation.upserts)
        break
      case 'upsert-annotations':
        next.annotations = upsertById(next.annotations, mutation.annotations)
        break
      case 'remove-annotations':
        next.annotations = next.annotations.filter((item) => !mutation.annotationIds.includes(item.id))
        break
      case 'patch-annotations':
        next.annotations = applyDesignEntityPatch(next.annotations, mutation.removeIds, mutation.upserts)
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
  if (expectedRevision < currentRevision
    && mutations.every((mutation) => REBASEABLE_MUTATIONS.has(mutation.type))) {
    return
  }
  throw new Error(`DESIGN_REVISION_CONFLICT: expected=${expectedRevision}, current=${currentRevision}`)
}

/** 校验所有节点移动目标仍存在于当前磁盘 revision。 */
function assertMoveTargetsExist(
  document: DesignCanvasDocument,
  expectedRevision: number,
  mutations: DesignMutation[],
): void {
  /** 当前磁盘 revision 中仍存在的节点 ID。 */
  const nodeIds = new Set(document.nodes.map((node) => node.id))
  /** 所有 move mutation 指向的节点 ID。 */
  const movedNodeIds = mutations.flatMap((mutation) => mutation.type === 'move-nodes'
    ? mutation.positions.map((position) => position.nodeId)
    : [])
  if (movedNodeIds.every((nodeId) => nodeIds.has(nodeId))) return
  if (expectedRevision !== document.revision) {
    throw new Error(`DESIGN_REVISION_CONFLICT: expected=${expectedRevision}, current=${document.revision}`)
  }
  throw new Error('DESIGN_DOCUMENT_INVALID: move node does not exist')
}

/** 创建统一的 Design 路径安全错误。 */
function unsafeDesignPath(message: string): Error {
  return new Error(`DESIGN_PATH_UNSAFE: ${message}`)
}

/** lstat 不存在路径时返回 null，其他错误保持原样。 */
function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

/** 判断 candidate 的物理路径位于 root 内或等于 root。 */
function isCanonicalPathContained(root: string, candidate: string): boolean {
  /** candidate 相对于可信根的物理位置。 */
  const relativePath = relative(root, candidate)
  return relativePath.length === 0
    || (relativePath !== '..'
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath))
}

/** 捕获实际目录身份，并可选校验其物理路径仍位于可信根。 */
function captureDirectoryIdentity(
  directoryPath: string,
  canonicalRoot?: string,
): DesignDirectoryIdentity {
  /** 不跟随最终 symlink 读取的目录状态。 */
  const stats = lstatOrNull(directoryPath)
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw unsafeDesignPath(`目录必须是实际目录: ${directoryPath}`)
  }
  /** 目录当前解析到的物理路径。 */
  const canonicalPath = realpathSync(directoryPath)
  if (canonicalRoot && !isCanonicalPathContained(canonicalRoot, canonicalPath)) {
    throw unsafeDesignPath(`目录逃逸可信根: ${directoryPath}`)
  }
  return {
    path: directoryPath,
    canonicalPath,
    dev: stats.dev,
    ino: stats.ino,
  }
}

/** 复验目录路径仍指向捕获时的实际目录身份。 */
function assertDirectoryIdentity(identity: DesignDirectoryIdentity): void {
  /** 当前路径不跟随 symlink 的目录状态。 */
  const stats = lstatOrNull(identity.path)
  if (!stats
    || stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.dev !== identity.dev
    || stats.ino !== identity.ino
    || realpathSync(identity.path) !== identity.canonicalPath) {
    throw unsafeDesignPath(`目录身份已变化: ${identity.path}`)
  }
}

/** 校验目标词法上严格位于可信根内。 */
function getContainedSegments(root: string, target: string): string[] {
  /** 统一为绝对路径后的可信根。 */
  const absoluteRoot = resolve(root)
  /** 统一为绝对路径后的目标目录。 */
  const absoluteTarget = resolve(target)
  /** 目标相对可信根的词法位置。 */
  const relativePath = relative(absoluteRoot, absoluteTarget)
  if (relativePath.length === 0) return []
  if (relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)) {
    throw unsafeDesignPath(`目录词法逃逸可信根: ${target}`)
  }
  return relativePath.split(sep)
}

/** 逐段 no-follow 创建目标目录，并复验父目录身份与物理包含关系。 */
function ensureContainedDirectory(root: string, target: string): DesignDirectoryIdentity {
  /** 可信根必须自身是实际目录，不接受根级 symlink。 */
  const rootIdentity = captureDirectoryIdentity(resolve(root))
  /** 从可信根到目标的安全词法路径段。 */
  const segments = getContainedSegments(rootIdentity.path, target)
  /** 当前已经确认的实际父目录身份。 */
  let currentIdentity = rootIdentity
  for (const segment of segments) {
    /** 下一层目录的词法路径。 */
    const nextPath = join(currentIdentity.path, segment)
    /** 创建前先固定并复验父目录，缩小祖先置换窗口。 */
    assertDirectoryIdentity(currentIdentity)
    if (lstatOrNull(nextPath) === null) {
      try {
        mkdirSync(nextPath)
      } catch (error) {
        /** 并发创建只允许 EEXIST，随后仍走 no-follow 身份校验。 */
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
    }
    /** 新层必须是根内实际目录，symlink 与根外 realpath 一律拒绝。 */
    const nextIdentity = captureDirectoryIdentity(nextPath, rootIdentity.canonicalPath)
    assertDirectoryIdentity(currentIdentity)
    currentIdentity = nextIdentity
  }
  return currentIdentity
}

/** 创建 Design 所需正式目录和缓存目录，但不创建空画布文件。 */
function ensureDesignDirectories(paths: DesignPaths): void {
  /** 正式数据目录分别逐段校验，禁止项目内 symlink 逃逸。 */
  const projectDirectories = [paths.designRoot, paths.assetsDir, paths.annotationsDir]
  for (const directory of projectDirectories) {
    ensureContainedDirectory(paths.projectRoot, directory)
  }
  /** 从稳定缓存路径反推出活动配置根。 */
  const configRoot = dirname(dirname(paths.cacheRoot))
  /** 缓存目录也使用同一 no-follow 创建规则。 */
  const cacheDirectories = [
    paths.cacheRoot,
    paths.thumbnailsDir,
    paths.jobsDir,
    paths.tracesDir,
    paths.stagingDir,
  ]
  for (const directory of cacheDirectories) {
    ensureContainedDirectory(configRoot, directory)
  }
}

/** 捕获并确认项目内 Design 正式目录身份。 */
function captureDesignRootIdentity(paths: DesignPaths): DesignDirectoryIdentity {
  /** 项目根物理路径是正式数据包含关系的唯一基准。 */
  const projectIdentity = captureDirectoryIdentity(resolve(paths.projectRoot))
  /** Design 根必须是项目物理根内的实际目录。 */
  return captureDirectoryIdentity(paths.designRoot, projectIdentity.canonicalPath)
}

/** 判断两次 no-follow 文件状态是否指向同一对象。 */
function isSameFileIdentity(
  left: DesignFileIdentity,
  right: DesignFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** 使用 no-follow 稳定句柄读取单个画布候选。 */
function readDesignCandidate(
  candidatePath: string,
  projectId: string,
  directoryIdentity: DesignDirectoryIdentity,
): DesignCandidateState {
  assertDirectoryIdentity(directoryIdentity)
  /** 打开前不跟随 symlink 的候选状态。 */
  const pathStats = lstatOrNull(candidatePath)
  if (!pathStats) return { exists: false, document: null }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw unsafeDesignPath(`画布候选不是实际文件: ${candidatePath}`)
  }
  /** 候选 descriptor 只在本函数内拥有。 */
  let descriptor: number | null = null
  try {
    descriptor = openSync(candidatePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    /** 打开后的文件身份必须与路径检查一致。 */
    const openedStats = fstatSync(descriptor)
    if (!openedStats.isFile() || !isSameFileIdentity(pathStats, openedStats)) {
      throw unsafeDesignPath(`画布候选身份已变化: ${candidatePath}`)
    }
    /** 从稳定 descriptor 单次读取的 JSON 原文。 */
    const raw = readFileSync(descriptor, 'utf8')
    /** 读取后再次复验 descriptor 身份。 */
    const finalStats = fstatSync(descriptor)
    if (!isSameFileIdentity(pathStats, finalStats)) {
      throw unsafeDesignPath(`画布候选读取期间被替换: ${candidatePath}`)
    }
    assertDirectoryIdentity(directoryIdentity)
    try {
      /** 候选 JSON 解析后的未知值。 */
      const value: unknown = JSON.parse(raw)
      return {
        exists: true,
        document: isDesignCanvasDocument(value, projectId) ? value : null,
      }
    } catch {
      return { exists: true, document: null }
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

/** 使用安全主/tmp/bak 顺序读取画布恢复链。 */
function readDesignDocument(paths: DesignPaths, projectId: string): DesignDocumentReadResult {
  /** 本次恢复链共同绑定的 Design 根目录身份。 */
  const directoryIdentity = captureDesignRootIdentity(paths)
  /** 主画布候选。 */
  const primary = readDesignCandidate(paths.canvasPath, projectId, directoryIdentity)
  if (primary.document) return { document: primary.document, hasCandidate: true }
  /** 原子写遗留的临时候选。 */
  const temporary = readDesignCandidate(`${paths.canvasPath}.tmp`, projectId, directoryIdentity)
  if (temporary.document) {
    return { document: temporary.document, recoveredFrom: 'tmp', hasCandidate: true }
  }
  /** 上次成功保存的备份候选。 */
  const backup = readDesignCandidate(`${paths.canvasPath}.bak`, projectId, directoryIdentity)
  if (backup.document) {
    return { document: backup.document, recoveredFrom: 'backup', hasCandidate: true }
  }
  return {
    document: null,
    hasCandidate: primary.exists || temporary.exists || backup.exists,
  }
}

/** 使用 safe-file 安全原子写，并在 rename 前复验项目内目录身份。 */
function writeDesignJsonSecure(paths: DesignPaths, filePath: string, document: DesignCanvasDocument): void {
  writeJsonFileAtomicSecure(filePath, document, {
    beforeRename: () => {
      /** 文件必须仍以 Design 根为直接父目录。 */
      if (dirname(filePath) !== paths.designRoot) {
        throw unsafeDesignPath(`画布文件不在 Design 根: ${filePath}`)
      }
      captureDesignRootIdentity(paths)
    },
  })
}

/** 使用身份绑定的原子删除安全消费已提升的固定 tmp。 */
function consumeRecoveredTemporary(paths: DesignPaths): void {
  /** 删除前绑定的项目内 Design 根身份。 */
  const directoryIdentity = captureDesignRootIdentity(paths)
  /** 仅允许消费画布恢复链约定的固定临时候选。 */
  const temporaryPath = `${paths.canvasPath}.tmp`
  if (dirname(temporaryPath) !== paths.designRoot) {
    throw unsafeDesignPath(`临时画布不在 Design 根: ${temporaryPath}`)
  }
  removeFileAtomic(temporaryPath)
  /** 删除完成后目录路径仍须指向同一实际目录。 */
  assertDirectoryIdentity(directoryIdentity)
}

/** 安全保存 mutation 文档，并在覆盖主文件前保存当前 revision 备份。 */
function writeMutatedDocument(
  paths: DesignPaths,
  current: DesignCanvasDocument,
  next: DesignCanvasDocument,
): void {
  /** 主文件当前状态用于决定是否需要保留上一 revision。 */
  const primaryStats = lstatOrNull(paths.canvasPath)
  if (primaryStats) {
    if (primaryStats.isSymbolicLink() || !primaryStats.isFile()) {
      throw unsafeDesignPath(`主画布不是实际文件: ${paths.canvasPath}`)
    }
    writeDesignJsonSecure(paths, `${paths.canvasPath}.bak`, current)
  }
  writeDesignJsonSecure(paths, paths.canvasPath, next)
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
    /** 通过 no-follow 主/tmp/bak 恢复链读取并校验的结果。 */
    const readResult = readDesignDocument(paths, projectId)
    if (!readResult.document && readResult.hasCandidate) {
      throw new Error(`DESIGN_DOCUMENT_CORRUPT: ${projectId}`)
    }
    if (readResult.document && readResult.recoveredFrom) {
      /** 恢复候选需安全提升为主文件，供下一次加载稳定使用。 */
      writeDesignJsonSecure(paths, paths.canvasPath, readResult.document)
      if (readResult.recoveredFrom === 'tmp') consumeRecoveredTemporary(paths)
    }
    return {
      document: readResult.document ?? createEmptyDesignDocument(projectId, now()),
      writable: true,
      ...(readResult.recoveredFrom ? { recoveredFrom: readResult.recoveredFrom } : {}),
    }
  }

  /** 幂等创建 legacy Design 文档；损坏候选继续 fail closed，不覆盖用户数据。 */
  function initialize(projectId: string): DesignCanvasDocument {
    /** 初始化与普通加载共用同一可信路径和恢复链。 */
    const paths = pathResolver.resolve(projectId)
    ensureDesignDirectories(paths)
    const readResult = readDesignDocument(paths, projectId)
    if (!readResult.document && readResult.hasCandidate) {
      throw new Error(`DESIGN_DOCUMENT_CORRUPT: ${projectId}`)
    }
    if (readResult.document) {
      if (readResult.recoveredFrom) {
        writeDesignJsonSecure(paths, paths.canvasPath, readResult.document)
        if (readResult.recoveredFrom === 'tmp') consumeRecoveredTemporary(paths)
      }
      return readResult.document
    }
    /** 全新项目只写一次 revision 0 空文档，重放读取该文档且不改时间。 */
    const document = createEmptyDesignDocument(projectId, now())
    writeDesignJsonSecure(paths, paths.canvasPath, document)
    return document
  }

  /** 加载可安全用于业务副作用的权威文档，恢复提升与业务操作必须分成两次调用。 */
  function requireStableAuthoritativeDocument(projectId: string): DesignCanvasDocument {
    /** 本次唯一加载的快照决定调用方能否继续业务副作用。 */
    const snapshot = load(projectId)
    if (snapshot.recoveredFrom) {
      throw new Error(`DESIGN_RECOVERY_REQUIRED: recoveredFrom=${snapshot.recoveredFrom}`)
    }
    return snapshot.document
  }

  /** 在磁盘最新 revision 上应用并原子保存 mutation。 */
  function mutate(
    projectId: string,
    expectedRevision: number,
    mutations: DesignMutation[],
    validateCurrent?: (document: DesignCanvasDocument) => void,
  ): DesignCanvasDocument {
    /** mutation 开始时重新加载且确认稳定的磁盘最新文档。 */
    const current = requireStableAuthoritativeDocument(projectId)
    /** 调用方策略与后续 apply/write 共享本次唯一加载的权威文档。 */
    validateCurrent?.(current)
    assertCanApply(expectedRevision, current.revision, mutations)
    assertMoveTargetsExist(current, expectedRevision, mutations)
    if (mutations.length === 0) return current
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
    ensureDesignDirectories(paths)
    writeMutatedDocument(paths, current, next)
    return next
  }

  return { load, initialize, requireStableAuthoritativeDocument, mutate }
}

/** 生产进程共享的 Design 存储实例。 */
export const designStore = createDesignStore()
