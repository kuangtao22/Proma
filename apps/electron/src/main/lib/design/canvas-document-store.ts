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
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  applyCanvasMutations,
  CANVAS_DOCUMENT_VERSION,
  createEmptyCanvasDocument,
} from '@proma/shared'
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasMutation,
  CanvasNode,
} from '@proma/shared'
import { removeFileAtomic, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicFileIdentity } from '../safe-file'
import type { CanvasSessionStore } from './canvas-session-store'
import { designPathResolver, isSafeDesignStableId } from './design-paths'
import type { CanvasPaths, DesignPathResolver } from './design-paths'

/** Canvas 节点标题上限，避免无界文案放大文档和 Renderer 布局。 */
const CANVAS_NODE_TITLE_MAX_LENGTH = 120

/** Canvas 文档访问的项目与会话双重身份。 */
export interface CanvasTarget {
  projectId: string
  canvasId: string
}

/** Canvas 文档加载结果；恢复来源只在首次安全提升时出现。 */
export interface CanvasWorkspaceSnapshot {
  document: CanvasDocument
  writable: true
  recoveredFrom?: 'tmp' | 'backup'
}

/** 原生 Canvas 文档的加载、稳定读取与 revision mutation 接口。 */
export interface CanvasDocumentStore {
  /** 加载文档并在必要时提升安全恢复候选。 */
  load: (target: CanvasTarget) => CanvasWorkspaceSnapshot
  /** 要求当前文档无需恢复即可作为副作用基线。 */
  requireStableAuthoritativeDocument: (target: CanvasTarget) => CanvasDocument
  /** 在权威 revision 上应用并提交一批 mutation。 */
  mutate: (
    target: CanvasTarget,
    expectedRevision: number,
    mutations: CanvasMutation[],
    validateCurrent?: (document: CanvasDocument) => void,
  ) => CanvasDocument
}

/** safe-file 安全原子写所需的最小回调合同。 */
interface CanvasSecureWriteOptions {
  /** temp 完成落盘后、rename 主提交前执行的目录复验。 */
  beforeRename?: (temporaryPath: string) => void
}

/** Canvas Store 消费恢复 tmp 时传给 safe-file 的最小身份合同。 */
interface CanvasRemoveFileOptions {
  /** 候选读取时绑定的文件 dev/ino。 */
  expectedIdentity?: AtomicFileIdentity
}

/** Canvas 文档 Store 的可信依赖与窄测试注入点。 */
export interface CanvasDocumentStoreOptions {
  /** 项目 Canvas registry 的 native 归属守卫。 */
  sessions: Pick<CanvasSessionStore, 'requireNative'>
  /** 项目与 Canvas 路径的可信解析器。 */
  pathResolver?: DesignPathResolver
  /** 返回当前有限时间戳，测试可注入固定值。 */
  now?: () => number
  /** 完整文档 schema 解析器，测试可统计全量校验次数。 */
  validateDocument?: (value: unknown, target: CanvasTarget) => CanvasDocument
  /** 主提交使用的 safe-file 写边界，测试可统计提交次数。 */
  writeJsonFileAtomicSecure?: (
    filePath: string,
    data: object,
    options?: CanvasSecureWriteOptions,
  ) => unknown
  /** 固定恢复 tmp 的安全原子删除边界。 */
  removeFileAtomic?: (filePath: string, options?: CanvasRemoveFileOptions) => unknown
  /** 候选完成解析后、最终状态复验前调用的竞态测试 hook。 */
  afterCandidateRead?: (candidatePath: string) => void
  /** tmp 提升为主文件后、绑定身份删除前调用的竞态测试 hook。 */
  beforeConsumeRecoveredTemporary?: (temporaryPath: string) => void
}

/** 未知 JSON 普通对象的安全索引结构。 */
interface UnknownRecord {
  [key: string]: unknown
}

/** no-follow 目录身份，用于读取、删除和 rename 前复验。 */
interface CanvasDirectoryIdentity {
  path: string
  canonicalPath: string
  dev: number | bigint
  ino: number | bigint
}

/** 可比较的文件系统对象身份。 */
interface CanvasFileState extends AtomicFileIdentity {
  size: number | bigint
  mtimeMs: number | bigint
  ctimeMs: number | bigint
}

/** lstat/fstat 两类 Node stats 共同提供的内容状态字段。 */
interface CanvasFileStat {
  dev: number | bigint
  ino: number | bigint
  size: number | bigint
  mtimeMs: number | bigint
  ctimeMs: number | bigint
}

/** 单个主/tmp/bak 候选的安全读取结果。 */
interface CanvasCandidateState {
  exists: boolean
  document: CanvasDocument | null
  identity?: AtomicFileIdentity
}

/** 整条恢复链的权威读取结果。 */
interface CanvasDocumentReadResult {
  document: CanvasDocument | null
  recoveredFrom?: NonNullable<CanvasWorkspaceSnapshot['recoveredFrom']>
  hasCandidate: boolean
  recoveredIdentity?: AtomicFileIdentity
}

/** 判断未知值是否为无额外原型行为的普通对象。 */
function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  /** JSON 对象只允许标准原型或无原型结构。 */
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** 判断对象字段与当前 schema 精确相等。 */
function hasExactKeys(value: UnknownRecord, fields: readonly string[]): boolean {
  /** 字段集合同时用于必填检查和未知字段拒绝。 */
  const allowed = new Set(fields)
  return fields.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => allowed.has(field))
}

/** 判断未知值是有限数字。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 判断未知值是有限非负时间戳。 */
function isTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

/** 判断未知值是非空且长度受控的字符串。 */
function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

/** 严格解析有限二维坐标并重建对象。 */
function parsePoint(value: unknown, message: string): { x: number; y: number } {
  if (!isRecord(value)
    || !hasExactKeys(value, ['x', 'y'])
    || !isFiniteNumber(value.x)
    || !isFiniteNumber(value.y)) {
    throw new Error(message)
  }
  return { x: value.x, y: value.y }
}

/** 严格解析有限且正缩放的视口并重建对象。 */
function parseViewport(value: unknown, message: string): { x: number; y: number; zoom: number } {
  if (!isRecord(value)
    || !hasExactKeys(value, ['x', 'y', 'zoom'])
    || !isFiniteNumber(value.x)
    || !isFiniteNumber(value.y)
    || !isFiniteNumber(value.zoom)
    || value.zoom <= 0) {
    throw new Error(message)
  }
  return { x: value.x, y: value.y, zoom: value.zoom }
}

/** 严格解析四类互斥引用节点并重建对象。 */
function parseCanvasNode(value: unknown, message: string): CanvasNode {
  if (!isRecord(value)
    || !isSafeDesignStableId(value.id)
    || !isBoundedNonEmptyString(value.title, CANVAS_NODE_TITLE_MAX_LENGTH)) {
    throw new Error(message)
  }
  /** 所有节点共享的有限布局坐标。 */
  const position = parsePoint(value.position, message)
  if (value.kind === 'agent'
    && hasExactKeys(value, ['id', 'kind', 'title', 'position', 'agentSessionId'])
    && isSafeDesignStableId(value.agentSessionId)) {
    return { id: value.id, kind: 'agent', title: value.title, position, agentSessionId: value.agentSessionId }
  }
  if (value.kind === 'image'
    && hasExactKeys(value, ['id', 'kind', 'title', 'position', 'assetId'])
    && isSafeDesignStableId(value.assetId)) {
    return { id: value.id, kind: 'image', title: value.title, position, assetId: value.assetId }
  }
  if (value.kind === 'visual-document'
    && hasExactKeys(value, ['id', 'kind', 'title', 'position', 'visualDocumentId'])
    && isSafeDesignStableId(value.visualDocumentId)) {
    return {
      id: value.id,
      kind: 'visual-document',
      title: value.title,
      position,
      visualDocumentId: value.visualDocumentId,
    }
  }
  if (value.kind === 'webview'
    && hasExactKeys(value, ['id', 'kind', 'title', 'position', 'url'])
    && isBoundedNonEmptyString(value.url, 2_048)) {
    return { id: value.id, kind: 'webview', title: value.title, position, url: value.url }
  }
  throw new Error(message)
}

/** 严格解析稳定端口边并重建对象。 */
function parseCanvasEdge(value: unknown, message: string): CanvasEdge {
  const fields = ['id', 'sourceNodeId', 'sourcePort', 'targetNodeId', 'targetPort'] as const
  if (!isRecord(value)
    || !hasExactKeys(value, fields)
    || !isSafeDesignStableId(value.id)
    || !isSafeDesignStableId(value.sourceNodeId)
    || !isSafeDesignStableId(value.sourcePort)
    || !isSafeDesignStableId(value.targetNodeId)
    || !isSafeDesignStableId(value.targetPort)) {
    throw new Error(message)
  }
  return {
    id: value.id,
    sourceNodeId: value.sourceNodeId,
    sourcePort: value.sourcePort,
    targetNodeId: value.targetNodeId,
    targetPort: value.targetPort,
  }
}

/** 要求实体 ID 在数组内唯一。 */
function assertUniqueIds(items: readonly { id: string }[], message: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error(message)
}

/**
 * 严格解析未知 Canvas 文档，逐字段重建并校验双重身份与跨实体引用。
 * @param value JSON 解析结果或 mutation 归约后的未知文档。
 * @param target 当前已授权项目与 Canvas 身份。
 * @returns 不携带未知字段和外部原型的完整 Canvas 文档。
 */
export function parseCanvasDocument(value: unknown, target: CanvasTarget): CanvasDocument {
  const fields = [
    'schemaVersion',
    'projectId',
    'canvasId',
    'revision',
    'viewport',
    'nodes',
    'edges',
    'createdAt',
    'updatedAt',
  ] as const
  if (!isRecord(value)
    || !hasExactKeys(value, fields)
    || value.schemaVersion !== CANVAS_DOCUMENT_VERSION
    || value.projectId !== target.projectId
    || value.canvasId !== target.canvasId
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)) {
    throw new Error('CANVAS_DOCUMENT_INVALID')
  }
  /** 基础字段通过后使用局部变量保持 unknown 收窄稳定。 */
  const revision = value.revision as number
  /** 节点和边逐项重建，拒绝未知字段和互斥引用混用。 */
  const nodes = value.nodes.map((node) => parseCanvasNode(node, 'CANVAS_DOCUMENT_INVALID'))
  const edges = value.edges.map((edge) => parseCanvasEdge(edge, 'CANVAS_DOCUMENT_INVALID'))
  assertUniqueIds(nodes, 'CANVAS_DOCUMENT_INVALID')
  assertUniqueIds(edges, 'CANVAS_DOCUMENT_INVALID')
  /** 边的两端都必须引用当前文档中实际存在的节点。 */
  const nodeIds = new Set(nodes.map((node) => node.id))
  if (edges.some((edge) => !nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId))) {
    throw new Error('CANVAS_DOCUMENT_INVALID')
  }
  return {
    schemaVersion: CANVAS_DOCUMENT_VERSION,
    projectId: target.projectId,
    canvasId: target.canvasId,
    revision,
    viewport: parseViewport(value.viewport, 'CANVAS_DOCUMENT_INVALID'),
    nodes,
    edges,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

/** 严格解析稳定 ID 数组并拒绝重复项。 */
function parseUniqueStableIds(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || !value.every(isSafeDesignStableId)) throw new Error(message)
  /** 已完成元素收窄后复制数组，隔离调用方后续修改。 */
  const ids = [...value]
  if (new Set(ids).size !== ids.length) throw new Error(message)
  return ids
}

/** 在 reducer 前按顺序校验原始 mutation 字段、图引用和批内重复 ID。 */
function validateCanvasMutations(current: CanvasDocument, mutations: CanvasMutation[]): void {
  /** 跨 mutation 追踪 upsert ID，阻止同批次先后覆盖隐藏重复输入。 */
  const upsertedNodeIds = new Set<string>()
  const upsertedEdgeIds = new Set<string>()
  /** 当前步骤可引用的节点 ID，随 upsert/remove 顺序演进。 */
  const currentNodeIds = new Set(current.nodes.map((node) => node.id))
  /** 当前步骤的边端点，用于 remove-node 模拟 reducer 的级联删除。 */
  const currentEdges = new Map(current.edges.map((edge) => [edge.id, {
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
  }]))
  for (const mutation of mutations as unknown[]) {
    if (!isRecord(mutation) || typeof mutation.type !== 'string') {
      throw new Error('CANVAS_MUTATION_INVALID')
    }
    if (mutation.type === 'set-viewport' && hasExactKeys(mutation, ['type', 'viewport'])) {
      parseViewport(mutation.viewport, 'CANVAS_MUTATION_INVALID')
      continue
    }
    if (mutation.type === 'move-nodes' && hasExactKeys(mutation, ['type', 'positions'])
      && Array.isArray(mutation.positions)) {
      /** 位置列表按 nodeId 唯一，避免 reducer 的 Map 静默折叠。 */
      const positionIds = new Set<string>()
      for (const position of mutation.positions) {
        if (!isRecord(position)
          || !hasExactKeys(position, ['nodeId', 'position'])
          || !isSafeDesignStableId(position.nodeId)
          || positionIds.has(position.nodeId)
          || !currentNodeIds.has(position.nodeId)) {
          throw new Error('CANVAS_MUTATION_INVALID')
        }
        parsePoint(position.position, 'CANVAS_MUTATION_INVALID')
        positionIds.add(position.nodeId)
      }
      continue
    }
    if (mutation.type === 'upsert-nodes' && hasExactKeys(mutation, ['type', 'nodes'])
      && Array.isArray(mutation.nodes)) {
      for (const value of mutation.nodes) {
        /** 每个节点先做单体 exact schema，再检查整批重复 ID。 */
        const node = parseCanvasNode(value, 'CANVAS_MUTATION_INVALID')
        if (upsertedNodeIds.has(node.id)) throw new Error('CANVAS_MUTATION_INVALID')
        upsertedNodeIds.add(node.id)
        currentNodeIds.add(node.id)
      }
      continue
    }
    if (mutation.type === 'remove-nodes' && hasExactKeys(mutation, ['type', 'nodeIds'])) {
      /** 未知节点保持 reducer 的 no-op 语义，已存在节点同步移除相连边。 */
      const removedNodeIds = new Set(parseUniqueStableIds(
        mutation.nodeIds,
        'CANVAS_MUTATION_INVALID',
      ))
      for (const nodeId of removedNodeIds) currentNodeIds.delete(nodeId)
      for (const [edgeId, edge] of currentEdges) {
        if (removedNodeIds.has(edge.sourceNodeId) || removedNodeIds.has(edge.targetNodeId)) {
          currentEdges.delete(edgeId)
        }
      }
      continue
    }
    if (mutation.type === 'upsert-edges' && hasExactKeys(mutation, ['type', 'edges'])
      && Array.isArray(mutation.edges)) {
      for (const value of mutation.edges) {
        /** 边的字段和当前步骤引用在 reducer 前校验，避免后续 mutation 掩盖非法输入。 */
        const edge = parseCanvasEdge(value, 'CANVAS_MUTATION_INVALID')
        if (upsertedEdgeIds.has(edge.id)
          || !currentNodeIds.has(edge.sourceNodeId)
          || !currentNodeIds.has(edge.targetNodeId)) {
          throw new Error('CANVAS_MUTATION_INVALID')
        }
        upsertedEdgeIds.add(edge.id)
        currentEdges.set(edge.id, {
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
        })
      }
      continue
    }
    if (mutation.type === 'remove-edges' && hasExactKeys(mutation, ['type', 'edgeIds'])) {
      /** 删除未知边继续保持 no-op；存在边只更新顺序状态。 */
      const removedEdgeIds = parseUniqueStableIds(mutation.edgeIds, 'CANVAS_MUTATION_INVALID')
      for (const edgeId of removedEdgeIds) currentEdges.delete(edgeId)
      continue
    }
    throw new Error('CANVAS_MUTATION_INVALID')
  }
}

/** 创建统一的 native Canvas 路径安全错误。 */
function unsafeCanvasPath(message: string): Error {
  return new Error(`CANVAS_PATH_UNSAFE: ${message}`)
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

/** 判断 candidate 的物理路径位于可信 root 内或等于 root。 */
function isCanonicalPathContained(root: string, candidate: string): boolean {
  /** 物理相对路径不得返回可信根上级。 */
  const relativePath = relative(root, candidate)
  return relativePath.length === 0
    || (relativePath !== '..'
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath))
}

/** 捕获实际目录身份，并可选校验物理路径包含关系。 */
function captureDirectoryIdentity(
  directoryPath: string,
  canonicalRoot?: string,
): CanvasDirectoryIdentity {
  /** 最后一段目录必须自身为实际目录，禁止 symlink。 */
  const stats = lstatOrNull(directoryPath)
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw unsafeCanvasPath(`目录必须是实际目录: ${directoryPath}`)
  }
  /** 当前目录解析后的稳定物理路径。 */
  const canonicalPath = realpathSync(directoryPath)
  if (canonicalRoot && !isCanonicalPathContained(canonicalRoot, canonicalPath)) {
    throw unsafeCanvasPath(`目录逃逸可信根: ${directoryPath}`)
  }
  return { path: directoryPath, canonicalPath, dev: stats.dev, ino: stats.ino }
}

/** 复验目录路径仍指向捕获时的实际目录身份。 */
function assertDirectoryIdentity(identity: CanvasDirectoryIdentity): void {
  /** 当前路径状态用于阻断读取或 rename 期间的目录置换。 */
  const stats = lstatOrNull(identity.path)
  if (!stats
    || stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.dev !== identity.dev
    || stats.ino !== identity.ino
    || realpathSync(identity.path) !== identity.canonicalPath) {
    throw unsafeCanvasPath(`目录身份已变化: ${identity.path}`)
  }
}

/** 从 lstat/fstat 提取读取期间必须保持稳定的内容状态。 */
function toCanvasFileState(stats: CanvasFileStat): CanvasFileState {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  }
}

/** 确认两次文件状态的身份与可观察内容版本完全一致。 */
function isSameFileState(left: CanvasFileState, right: CanvasFileState): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

/**
 * 验证 resolver 输出并创建缺失的单级 canvasRoot。
 * @param paths resolveCanvas 产生的项目和 Canvas 专属路径。
 * @param canvasesRoot resolve(projectId) 产生的可信 Canvas 集合根。
 * @returns 已复验的 canvasRoot 目录身份。
 */
function ensureCanvasDirectory(paths: CanvasPaths, canvasesRoot: string): CanvasDirectoryIdentity {
  if (!isAbsolute(canvasesRoot)
    || !isAbsolute(paths.canvasRoot)
    || !isAbsolute(paths.documentPath)
    || dirname(paths.canvasRoot) !== canvasesRoot
    || basename(paths.canvasRoot) !== paths.canvasId
    || dirname(paths.documentPath) !== paths.canvasRoot
    || basename(paths.documentPath) !== 'canvas.json') {
    throw unsafeCanvasPath('Canvas 路径不满足固定层级')
  }
  /** 集合根必须已经由会话索引创建且自身为实际目录。 */
  const rootIdentity = captureDirectoryIdentity(resolve(canvasesRoot))
  assertDirectoryIdentity(rootIdentity)
  if (lstatOrNull(paths.canvasRoot) === null) {
    try {
      mkdirSync(paths.canvasRoot)
    } catch (error) {
      /** 并发创建只接受 EEXIST，随后仍执行 no-follow 身份校验。 */
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
  }
  /** 单级 Canvas 目录必须保持在集合根的物理路径之下。 */
  const canvasIdentity = captureDirectoryIdentity(paths.canvasRoot, rootIdentity.canonicalPath)
  assertDirectoryIdentity(rootIdentity)
  return canvasIdentity
}

/** 使用 no-follow 稳定句柄读取单个 Canvas 文档候选。 */
function readCanvasCandidate(
  candidatePath: string,
  target: CanvasTarget,
  directoryIdentity: CanvasDirectoryIdentity,
  validateDocument: (value: unknown, target: CanvasTarget) => CanvasDocument,
  afterCandidateRead?: (candidatePath: string) => void,
): CanvasCandidateState {
  if (dirname(candidatePath) !== directoryIdentity.path) {
    throw unsafeCanvasPath(`文档候选不在 Canvas 根: ${candidatePath}`)
  }
  assertDirectoryIdentity(directoryIdentity)
  /** 打开前不跟随 symlink 的路径状态。 */
  const pathStats = lstatOrNull(candidatePath)
  if (!pathStats) return { exists: false, document: null }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw unsafeCanvasPath(`文档候选不是实际文件: ${candidatePath}`)
  }
  /** 路径初始身份与内容版本用于约束整个读取和解析窗口。 */
  const initialState = toCanvasFileState(pathStats)
  /** descriptor 只在本次稳定读取期间拥有。 */
  let descriptor: number | null = null
  try {
    descriptor = openSync(candidatePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    /** 打开后身份必须与路径 lstat 完全一致。 */
    const openedStats = fstatSync(descriptor)
    if (!openedStats.isFile() || !isSameFileState(initialState, toCanvasFileState(openedStats))) {
      throw unsafeCanvasPath(`文档候选身份已变化: ${candidatePath}`)
    }
    /** 从稳定 descriptor 读取候选原文。 */
    const raw = readFileSync(descriptor, 'utf8')
    /** 解析失败只标记候选损坏，仍必须完成读取后的身份复验。 */
    let document: CanvasDocument | null = null
    try {
      /** 所有 JSON.parse 结果按 unknown 进入严格 validator。 */
      const value: unknown = JSON.parse(raw)
      document = validateDocument(value, target)
    } catch { /* schema 或 JSON 损坏由恢复链继续处理。 */ }
    afterCandidateRead?.(candidatePath)
    /** 解析后 fd 的身份、大小和修改时间都必须与打开前一致。 */
    const finalStats = fstatSync(descriptor)
    if (!finalStats.isFile() || !isSameFileState(initialState, toCanvasFileState(finalStats))) {
      throw unsafeCanvasPath(`文档候选读取期间内容已变化: ${candidatePath}`)
    }
    /** 同名路径必须仍指向最初 inode，且内容状态没有原地变化。 */
    const finalPathStats = lstatOrNull(candidatePath)
    if (!finalPathStats
      || finalPathStats.isSymbolicLink()
      || !finalPathStats.isFile()
      || !isSameFileState(initialState, toCanvasFileState(finalPathStats))) {
      throw unsafeCanvasPath(`文档候选路径已变化: ${candidatePath}`)
    }
    assertDirectoryIdentity(directoryIdentity)
    return {
      exists: true,
      document,
      identity: { dev: initialState.dev, ino: initialState.ino },
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

/** 按主、固定 tmp、固定 bak 顺序读取 Canvas 恢复链。 */
function readCanvasDocument(
  paths: CanvasPaths,
  target: CanvasTarget,
  directoryIdentity: CanvasDirectoryIdentity,
  validateDocument: (value: unknown, target: CanvasTarget) => CanvasDocument,
  afterCandidateRead?: (candidatePath: string) => void,
): CanvasDocumentReadResult {
  /** 当前正式主文件候选。 */
  const primary = readCanvasCandidate(
    paths.documentPath, target, directoryIdentity, validateDocument, afterCandidateRead,
  )
  if (primary.document) return { document: primary.document, hasCandidate: true }
  /** 上次固定恢复流程遗留的 tmp 候选。 */
  const temporary = readCanvasCandidate(
    `${paths.documentPath}.tmp`, target, directoryIdentity, validateDocument, afterCandidateRead,
  )
  if (temporary.document) {
    if (!temporary.identity) throw unsafeCanvasPath('tmp 候选缺少稳定身份')
    return {
      document: temporary.document,
      recoveredFrom: 'tmp',
      recoveredIdentity: temporary.identity,
      hasCandidate: true,
    }
  }
  /** 最近一次稳定 revision 的 bak 候选。 */
  const backup = readCanvasCandidate(
    `${paths.documentPath}.bak`, target, directoryIdentity, validateDocument, afterCandidateRead,
  )
  if (backup.document) {
    return { document: backup.document, recoveredFrom: 'backup', hasCandidate: true }
  }
  return {
    document: null,
    hasCandidate: primary.exists || temporary.exists || backup.exists,
  }
}

/** 返回有限非负的当前时间戳。 */
function requireNow(now: () => number): number {
  /** 单次提交只读取一次时钟。 */
  const value = now()
  if (!isTimestamp(value)) throw new Error('CANVAS_TIMESTAMP_INVALID')
  return value
}

/** 返回严格晚于当前文档且保持有限的更新时间。 */
function requireNextUpdatedAt(now: () => number, currentUpdatedAt: number): number {
  /** 增量至少为 1；大数使用相对 epsilon 跨过当前浮点间距。 */
  const increment = Math.max(1, Math.abs(currentUpdatedAt) * Number.EPSILON)
  /** 墙钟前进时尊重墙钟，停滞或回拨时使用单调逻辑时间。 */
  const nextUpdatedAt = Math.max(requireNow(now), currentUpdatedAt + increment)
  if (!Number.isFinite(nextUpdatedAt) || nextUpdatedAt <= currentUpdatedAt) {
    throw new Error('CANVAS_TIMESTAMP_INVALID')
  }
  return nextUpdatedAt
}

/**
 * 创建独立 native Canvas revision Store。
 * @param options 会话授权、可信路径、时钟和窄测试依赖。
 * @returns 只访问 resolveCanvas 文档路径的同步 Store。
 */
export function createCanvasDocumentStore(options: CanvasDocumentStoreOptions): CanvasDocumentStore {
  /** 生产默认使用项目工作区绑定的 Design 路径解析器。 */
  const pathResolver = options.pathResolver ?? designPathResolver
  /** 生产默认使用严格 schema 解析器。 */
  const validateDocument = options.validateDocument ?? parseCanvasDocument
  /** 生产默认只通过 safe-file 安全原子写 JSON。 */
  const writeJson = options.writeJsonFileAtomicSecure ?? writeJsonFileAtomicSecure
  /** 生产默认使用身份绑定的原子删除消费固定 tmp。 */
  const removeFile = options.removeFileAtomic ?? removeFileAtomic
  /** 生产默认使用系统当前时间。 */
  const now = options.now ?? Date.now

  /** 在安全写 rename 前复验固定父目录和路径身份。 */
  function writeCanvasJsonSecure(
    paths: CanvasPaths,
    directoryIdentity: CanvasDirectoryIdentity,
    filePath: string,
    document: CanvasDocument,
  ): void {
    if (dirname(filePath) !== paths.canvasRoot) {
      throw unsafeCanvasPath(`文档文件不在 Canvas 根: ${filePath}`)
    }
    writeJson(filePath, document, {
      beforeRename: () => assertDirectoryIdentity(directoryIdentity),
    })
  }

  /** 在已授权边界内解析并复验当前 native 文档路径。 */
  function resolveTargetPaths(target: CanvasTarget): {
    paths: CanvasPaths
    directoryIdentity: CanvasDirectoryIdentity
  } {
    /** 路径每次重新解析，适配项目根迁移且不缓存旧位置。 */
    const projectPaths = pathResolver.resolve(target.projectId)
    const paths = pathResolver.resolveCanvas(target.projectId, target.canvasId)
    if (paths.projectId !== target.projectId || paths.canvasId !== target.canvasId) {
      throw unsafeCanvasPath('resolver 返回的 Canvas 身份不匹配')
    }
    return {
      paths,
      directoryIdentity: ensureCanvasDirectory(paths, projectPaths.canvasesRoot),
    }
  }

  /** 先完成 registry 授权，再解析并复验任何 native 文档路径。 */
  function resolveAuthorizedTarget(target: CanvasTarget): {
    paths: CanvasPaths
    directoryIdentity: CanvasDirectoryIdentity
  } {
    options.sessions.requireNative(target.projectId, target.canvasId)
    /** requireNative 成功后才能触达项目与 Canvas 文档路径解析。 */
    return resolveTargetPaths(target)
  }

  /** 从恢复链加载文档，合法恢复候选会安全提升为主文件。 */
  function load(target: CanvasTarget): CanvasWorkspaceSnapshot {
    /** 授权和路径复验是任何文档候选访问的先决条件。 */
    const authorized = resolveAuthorizedTarget(target)
    /** 当前主/tmp/bak 候选链的读取结果。 */
    const readResult = readCanvasDocument(
      authorized.paths,
      target,
      authorized.directoryIdentity,
      validateDocument,
      options.afterCandidateRead,
    )
    if (!readResult.document && readResult.hasCandidate) {
      throw new Error(`CANVAS_DOCUMENT_CORRUPT: ${target.projectId}/${target.canvasId}`)
    }
    if (readResult.document && readResult.recoveredFrom) {
      /** 恢复候选先安全提升，随后 tmp 才能被原子消费。 */
      writeCanvasJsonSecure(
        authorized.paths,
        authorized.directoryIdentity,
        authorized.paths.documentPath,
        readResult.document,
      )
      if (readResult.recoveredFrom === 'tmp') {
        if (!readResult.recoveredIdentity) throw unsafeCanvasPath('tmp 恢复缺少绑定身份')
        /** 删除只消费本次实际读取的 tmp inode，置换文件必须保留。 */
        const temporaryPath = `${authorized.paths.documentPath}.tmp`
        options.beforeConsumeRecoveredTemporary?.(temporaryPath)
        removeFile(temporaryPath, { expectedIdentity: readResult.recoveredIdentity })
        assertDirectoryIdentity(authorized.directoryIdentity)
      }
    }
    return {
      document: readResult.document
        ?? createEmptyCanvasDocument(target.projectId, target.canvasId, requireNow(now)),
      writable: true,
      ...(readResult.recoveredFrom ? { recoveredFrom: readResult.recoveredFrom } : {}),
    }
  }

  /** 加载可用于副作用的稳定权威文档，恢复首次调用必须由上层重载确认。 */
  function requireStableAuthoritativeDocument(target: CanvasTarget): CanvasDocument {
    /** 唯一 load 结果决定当前调用能否继续 mutation。 */
    const snapshot = load(target)
    if (snapshot.recoveredFrom) {
      throw new Error(`CANVAS_RECOVERY_REQUIRED: recoveredFrom=${snapshot.recoveredFrom}`)
    }
    return snapshot.document
  }

  /** 在磁盘最新 revision 上应用一批受控 mutation 并安全提交。 */
  function mutate(
    target: CanvasTarget,
    expectedRevision: number,
    mutations: CanvasMutation[],
    validateCurrent?: (document: CanvasDocument) => void,
  ): CanvasDocument {
    /** mutation 始终从稳定权威文档开始，禁止跨恢复边界写入。 */
    const current = requireStableAuthoritativeDocument(target)
    validateCurrent?.(current)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
      throw new Error(
        `CANVAS_REVISION_CONFLICT: expected=${expectedRevision}, current=${current.revision}`,
      )
    }
    if (mutations.length === 0) return current
    validateCanvasMutations(current, mutations)
    /** reducer 只执行一次，结果随后只走一次完整文档 schema 链。 */
    const mutated = applyCanvasMutations(current, mutations)
    /** updatedAt 独立生成，时间边界错误不得伪装为 mutation schema 错误。 */
    const updatedAt = requireNextUpdatedAt(now, current.updatedAt)
    /** 当前基线已严格合法，结果 schema 失败只能由本批 mutation 引入。 */
    let next: CanvasDocument
    try {
      next = validateDocument({
        ...mutated,
        revision: current.revision + 1,
        updatedAt,
      }, target)
    } catch (error) {
      throw new Error('CANVAS_MUTATION_INVALID', { cause: error })
    }
    /** 写入前重新解析并复验路径，适配项目根在调用间迁移。 */
    const authorized = resolveAuthorizedTarget(target)
    /** 主文件存在时先安全保存当前稳定 revision 作为固定备份。 */
    const primaryStats = lstatOrNull(authorized.paths.documentPath)
    if (primaryStats) {
      if (primaryStats.isSymbolicLink() || !primaryStats.isFile()) {
        throw unsafeCanvasPath(`主文档不是实际文件: ${authorized.paths.documentPath}`)
      }
      writeCanvasJsonSecure(
        authorized.paths,
        authorized.directoryIdentity,
        `${authorized.paths.documentPath}.bak`,
        current,
      )
    }
    /** 主提交始终只调用一次生产 safe-file 写边界。 */
    writeCanvasJsonSecure(
      authorized.paths,
      authorized.directoryIdentity,
      authorized.paths.documentPath,
      next,
    )
    return next
  }

  return { load, requireStableAuthoritativeDocument, mutate }
}
