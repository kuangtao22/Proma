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
import type { BigIntStats, Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
  CanvasTarget,
  CanvasWorkspaceSnapshot,
} from '@proma/shared'
export type { CanvasTarget, CanvasWorkspaceSnapshot } from '@proma/shared'
import {
  AtomicDestinationConflictError,
  AtomicWritePostCommitError,
  removeFileAtomic,
  writeJsonFileAtomicSecure,
} from '../safe-file'
import type {
  AtomicDestinationExpectation,
  AtomicFileIdentity,
  AtomicFileState,
  SecureAtomicJsonPriorBackup,
} from '../safe-file'
import type { CanvasSessionStore } from './canvas-session-store'
import type { StableDirectoryOpenedRoot } from '../stable-directory-native-host'
import { designPathResolver, isSafeDesignStableId } from './design-paths'
import type { CanvasPaths, DesignPathResolver } from './design-paths'

/** Canvas 节点标题上限，避免无界文案放大文档和 Renderer 布局。 */
const CANVAS_NODE_TITLE_MAX_LENGTH = 120

/** 原生 Canvas 文档的加载、稳定读取与 revision mutation 接口。 */
export interface CanvasDocumentStore {
  /** 加载文档并在必要时提升安全恢复候选。 */
  load: (target: CanvasTarget) => CanvasWorkspaceSnapshot
  /** 加载文档并返回绑定同一次授权目录身份的子目录 capability。 */
  loadWithDirectoryCapability: (target: CanvasTarget) => CanvasDocumentDirectoryCapability
  /** 加载并绑定一次私有 v1 内容迁移事务，路径与 CAS 身份不离开闭包。 */
  loadWithMigrationCapability: (target: CanvasTarget) => CanvasDocumentMigrationCapability
  /** 要求当前文档无需恢复即可作为副作用基线。 */
  requireStableAuthoritativeDocument: (target: CanvasTarget) => CanvasDocument
  /** 在创建外部资源前，基于权威文档严格解析一批不可信 mutation。 */
  validateBatchOperations: (
    target: CanvasTarget,
    expectedRevision: number,
    operations: unknown[],
  ) => CanvasMutation[]
  /** 在权威 revision 上应用并提交一批 mutation。 */
  mutate: (
    target: CanvasTarget,
    expectedRevision: number,
    mutations: CanvasMutation[],
    validateCurrent?: (document: CanvasDocument) => void,
  ) => CanvasDocument
}

/** 主进程私有的旧内容迁移能力，不进入共享合同或 IPC。 */
export interface CanvasDocumentMigrationCapability extends CanvasDocumentDirectoryCapability {
  migratedFrom?: 1
  legacyContentSeeds: LegacyCanvasContentSeed[]
  /** 把同次读取的规范化 v2 载荷按 CAS 提交，保持图 revision 与时间不变。 */
  commitMigration: () => CanvasDocument
}

/** 已绑定目录链身份的可信单目录 capability。 */
export interface CanvasTrustedDirectoryCapability {
  /** 仅供兼容读取测试拼接已验证单段文件名，生产 intent I/O 不按此路径打开。 */
  readonly path: string
  /** helper 启动时使用的具体 Canvas root。 */
  readonly rootPath: string
  /** 复验 canvasesRoot 与 canvasRoot 的完整身份链。 */
  assertValid: () => void
  /** 对 helper 已打开根的 canonical/dev/ino 事实执行双向复验。 */
  authorizeOpenedRoots: (roots: readonly StableDirectoryOpenedRoot[]) => boolean
}

/** Canvas LOAD 与同一目录授权事实的组合，不向 Renderer 暴露。 */
export interface CanvasDocumentDirectoryCapability {
  snapshot: CanvasWorkspaceSnapshot
  /** 只在已固定 canvasRoot 下创建或打开一个安全单级子目录。 */
  openSingleChildDirectory: (name: string) => CanvasTrustedDirectoryCapability
}

/** safe-file 安全原子写所需的最小回调合同。 */
interface CanvasSecureWriteOptions {
  /** 读取期主文件状态，用于绑定最终 rename 的 compare-and-swap。 */
  expectedDestination?: AtomicDestinationExpectation
  /** 与主提交共同预写、提交后发布的 previous revision backup。 */
  priorBackup?: SecureAtomicJsonPriorBackup
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
  validateDocument?: (value: unknown, target: CanvasTarget) => ParsedCanvasDocument
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
  /** 主提交 durable 但 previous backup 降级时的非阻塞告警。 */
  onRecoveryDegraded?: (message: string, error: AtomicWritePostCommitError) => void
}

/** v1 节点迁移后供后续内容目录落盘的主进程私有种子。 */
export interface LegacyCanvasContentSeed {
  kind: 'image' | 'document' | 'webview'
  contentId: string
  adoptedAssetId?: string
  selectedModelProfileId?: string | null
  legacySourceUrl?: string
}

/** 严格解析后的 v2 文档与不对 Renderer 公开的迁移上下文。 */
export interface ParsedCanvasDocument {
  document: CanvasDocument
  migratedFrom?: 1
  legacyContentSeeds: LegacyCanvasContentSeed[]
  persistencePayload: CanvasDocument | LegacyCanvasDocument
}

/** 严格重建后可安全重新落盘的 v1 节点联合。 */
type LegacyCanvasNode =
  | {
    id: string
    kind: 'agent'
    title: string
    position: { x: number; y: number }
    agentSessionId: string
  }
  | {
    id: string
    kind: 'image'
    title: string
    position: { x: number; y: number }
    assetId: string
  }
  | {
    id: string
    kind: 'visual-document'
    title: string
    position: { x: number; y: number }
    visualDocumentId: string
  }
  | {
    id: string
    kind: 'webview'
    title: string
    position: { x: number; y: number }
    url: string
  }

/** 严格 parser 逐字段重建的 v1 持久化载荷，不保留 unknown 或外部原型。 */
interface LegacyCanvasDocument {
  schemaVersion: 1
  projectId: string
  canvasId: string
  revision: number
  viewport: CanvasDocument['viewport']
  nodes: LegacyCanvasNode[]
  edges: CanvasEdge[]
  createdAt: number
  updatedAt: number
}

/** 未知 JSON 普通对象的安全索引结构。 */
interface UnknownRecord {
  [key: string]: unknown
}

/** no-follow 目录身份，用于读取、删除和 rename 前复验。 */
interface CanvasDirectoryIdentity {
  path: string
  canonicalPath: string
  dev: bigint
  ino: bigint
}

/** 同一次授权捕获的 Canvas 集合根与具体 Canvas 根身份。 */
interface CanvasDirectoryScopeIdentity {
  canvasesRoot: CanvasDirectoryIdentity
  canvasRoot: CanvasDirectoryIdentity
}

/** lstat/fstat 两类 Node stats 共同提供的内容状态字段。 */
interface CanvasFileStat {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

/** 单个主/tmp/bak 候选的安全读取结果。 */
interface CanvasCandidateState {
  exists: boolean
  parsedDocument: ParsedCanvasDocument | null
  state?: AtomicFileState
}

/** 整条恢复链的权威读取结果。 */
interface CanvasDocumentReadResult {
  parsedDocument: ParsedCanvasDocument | null
  primaryExpectation: AtomicDestinationExpectation
  recoveredFrom?: NonNullable<CanvasWorkspaceSnapshot['recoveredFrom']>
  hasCandidate: boolean
  recoveredState?: AtomicFileState
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

/** 严格解析 v2 四类互斥引用节点并重建对象。 */
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
    && (hasExactKeys(value, ['id', 'kind', 'title', 'position', 'imageModuleId'])
      || hasExactKeys(value, [
        'id', 'kind', 'title', 'position', 'imageModuleId', 'adoptedAssetId',
      ]))
    && isSafeDesignStableId(value.imageModuleId)
    && (value.adoptedAssetId === undefined || isSafeDesignStableId(value.adoptedAssetId))) {
    return {
      id: value.id,
      kind: 'image',
      title: value.title,
      position,
      imageModuleId: value.imageModuleId,
      ...(value.adoptedAssetId === undefined ? {} : { adoptedAssetId: value.adoptedAssetId }),
    }
  }
  if (value.kind === 'document'
    && hasExactKeys(value, [
      'id', 'kind', 'title', 'position', 'documentId', 'contentRevision',
    ])
    && isSafeDesignStableId(value.documentId)
    && Number.isSafeInteger(value.contentRevision)
    && (value.contentRevision as number) >= 0) {
    return {
      id: value.id,
      kind: 'document',
      title: value.title,
      position,
      documentId: value.documentId,
      contentRevision: value.contentRevision as number,
    }
  }
  if (value.kind === 'webview'
    && hasExactKeys(value, [
      'id', 'kind', 'title', 'position', 'prototypeId', 'contentRevision',
    ])
    && isSafeDesignStableId(value.prototypeId)
    && Number.isSafeInteger(value.contentRevision)
    && (value.contentRevision as number) >= 0) {
    return {
      id: value.id,
      kind: 'webview',
      title: value.title,
      position,
      prototypeId: value.prototypeId,
      contentRevision: value.contentRevision as number,
    }
  }
  throw new Error(message)
}

/** v1 节点规范化结果，内容种子只保留在主进程。 */
interface ParsedLegacyCanvasNode {
  node: CanvasNode
  persistenceNode: LegacyCanvasNode
  legacyContentSeed?: LegacyCanvasContentSeed
}

/**
 * 严格解析 v1 节点并重建为 v2 节点与内容种子。
 * @param value 从 v1 文档节点数组取得的未知值。
 * @param message 严格校验失败时保持的上层错误码。
 * @returns 规范化节点，以及非 Agent 节点可选的私有迁移种子。
 */
function parseLegacyCanvasNode(value: unknown, message: string): ParsedLegacyCanvasNode {
  if (!isRecord(value)
    || !isSafeDesignStableId(value.id)
    || !isBoundedNonEmptyString(value.title, CANVAS_NODE_TITLE_MAX_LENGTH)) {
    throw new Error(message)
  }
  /** 旧节点位置与 v2 共用有限坐标合同。 */
  const position = parsePoint(value.position, message)
  if (value.kind === 'agent'
    && hasExactKeys(value, ['id', 'kind', 'title', 'position', 'agentSessionId'])
    && isSafeDesignStableId(value.agentSessionId)) {
    return {
      node: {
        id: value.id,
        kind: 'agent',
        title: value.title,
        position: { x: position.x, y: position.y },
        agentSessionId: value.agentSessionId,
      },
      persistenceNode: {
        id: value.id,
        kind: 'agent',
        title: value.title,
        position: { x: position.x, y: position.y },
        agentSessionId: value.agentSessionId,
      },
    }
  }
  if (value.kind === 'image'
    && hasExactKeys(value, ['id', 'kind', 'title', 'position', 'assetId'])
    && isSafeDesignStableId(value.assetId)) {
    return {
      node: {
        id: value.id,
        kind: 'image',
        title: value.title,
        position: { x: position.x, y: position.y },
        imageModuleId: value.assetId,
        adoptedAssetId: value.assetId,
      },
      persistenceNode: {
        id: value.id,
        kind: 'image',
        title: value.title,
        position: { x: position.x, y: position.y },
        assetId: value.assetId,
      },
      legacyContentSeed: {
        kind: 'image',
        contentId: value.assetId,
        adoptedAssetId: value.assetId,
      },
    }
  }
  if (value.kind === 'visual-document'
    && hasExactKeys(value, ['id', 'kind', 'title', 'position', 'visualDocumentId'])
    && isSafeDesignStableId(value.visualDocumentId)) {
    return {
      node: {
        id: value.id,
        kind: 'document',
        title: value.title,
        position: { x: position.x, y: position.y },
        documentId: value.visualDocumentId,
        contentRevision: 0,
      },
      persistenceNode: {
        id: value.id,
        kind: 'visual-document',
        title: value.title,
        position: { x: position.x, y: position.y },
        visualDocumentId: value.visualDocumentId,
      },
      legacyContentSeed: { kind: 'document', contentId: value.visualDocumentId },
    }
  }
  if (value.kind === 'webview'
    && hasExactKeys(value, ['id', 'kind', 'title', 'position', 'url'])
    && isBoundedNonEmptyString(value.url, 2_048)) {
    return {
      node: {
        id: value.id,
        kind: 'webview',
        title: value.title,
        position: { x: position.x, y: position.y },
        prototypeId: value.id,
        contentRevision: 0,
      },
      persistenceNode: {
        id: value.id,
        kind: 'webview',
        title: value.title,
        position: { x: position.x, y: position.y },
        url: value.url,
      },
      legacyContentSeed: {
        kind: 'webview',
        contentId: value.id,
        legacySourceUrl: value.url,
      },
    }
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
 * @returns 规范化 v2 文档与主进程私有迁移上下文。
 */
export function parseCanvasDocument(value: unknown, target: CanvasTarget): ParsedCanvasDocument {
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
    || (value.schemaVersion !== 1 && value.schemaVersion !== CANVAS_DOCUMENT_VERSION)
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
  /** v1 需要同时产生规范化节点、canonical 节点与不公开的内容种子。 */
  const legacyContentSeeds: LegacyCanvasContentSeed[] = []
  /** v1 节点只能由严格 parser 重建，禁止复用原始 unknown。 */
  const parsedLegacyNodes = value.schemaVersion === 1
    ? value.nodes.map((node) => parseLegacyCanvasNode(node, 'CANVAS_DOCUMENT_INVALID'))
    : null
  /** 节点和边逐项重建，拒绝未知字段和互斥引用混用。 */
  const nodes = parsedLegacyNodes
    ? parsedLegacyNodes.map((parsed) => {
      /** 单节点迁移结果的 seed 与节点顺序保持稳定。 */
      if (parsed.legacyContentSeed) legacyContentSeeds.push(parsed.legacyContentSeed)
      return parsed.node
    })
    : value.nodes.map((node) => parseCanvasNode(node, 'CANVAS_DOCUMENT_INVALID'))
  const edges = value.edges.map((edge) => parseCanvasEdge(edge, 'CANVAS_DOCUMENT_INVALID'))
  assertUniqueIds(nodes, 'CANVAS_DOCUMENT_INVALID')
  assertUniqueIds(edges, 'CANVAS_DOCUMENT_INVALID')
  /** 边的两端都必须引用当前文档中实际存在的节点。 */
  const nodeIds = new Set(nodes.map((node) => node.id))
  if (edges.some((edge) => !nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId))) {
    throw new Error('CANVAS_DOCUMENT_INVALID')
  }
  /** 视口只解析一次，v1 持久化载荷再从校验结果独立重建。 */
  const viewport = parseViewport(value.viewport, 'CANVAS_DOCUMENT_INVALID')
  /** Renderer 始终只看到规范化后的 v2 文档。 */
  const document: CanvasDocument = {
    schemaVersion: CANVAS_DOCUMENT_VERSION,
    projectId: target.projectId,
    canvasId: target.canvasId,
    revision,
    viewport,
    nodes,
    edges,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
  /** v1 在内容迁移完成前必须保留旧字段，v2 直接复用规范文档。 */
  const persistencePayload: CanvasDocument | LegacyCanvasDocument = parsedLegacyNodes
    ? {
      schemaVersion: 1,
      projectId: target.projectId,
      canvasId: target.canvasId,
      revision,
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
      nodes: parsedLegacyNodes.map((parsed) => parsed.persistenceNode),
      edges: edges.map((edge) => ({
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        sourcePort: edge.sourcePort,
        targetNodeId: edge.targetNodeId,
        targetPort: edge.targetPort,
      })),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }
    : document
  return {
    document,
    ...(value.schemaVersion === 1 ? { migratedFrom: 1 as const } : {}),
    legacyContentSeeds,
    persistencePayload,
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
function validateCanvasMutations(current: CanvasDocument, mutations: unknown[]): void {
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
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

/** 目录身份使用 bigint 读取，避免 Windows 64 位 file ID 经 number 丢失精度。 */
function lstatDirectoryOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true })
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
  const stats = lstatDirectoryOrNull(directoryPath)
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
  const stats = lstatDirectoryOrNull(identity.path)
  if (!stats
    || stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.dev !== identity.dev
    || stats.ino !== identity.ino
    || realpathSync(identity.path) !== identity.canonicalPath) {
    throw unsafeCanvasPath(`目录身份已变化: ${identity.path}`)
  }
}

/** 复验 Canvas 集合根和具体 Canvas 根仍保持原始父子身份。 */
function assertCanvasDirectoryScope(identity: CanvasDirectoryScopeIdentity): void {
  assertDirectoryIdentity(identity.canvasesRoot)
  assertDirectoryIdentity(identity.canvasRoot)
  if (dirname(identity.canvasRoot.path) !== identity.canvasesRoot.path
    || dirname(identity.canvasRoot.canonicalPath) !== identity.canvasesRoot.canonicalPath) {
    throw unsafeCanvasPath('Canvas 根不再属于已授权集合根')
  }
  /** 再次复验上层，缩短检查具体 Canvas 时的父目录竞态窗口。 */
  assertDirectoryIdentity(identity.canvasesRoot)
}

/** 比较两次捕获的目录路径、物理路径和稳定文件身份。 */
function isSameDirectoryIdentity(
  left: CanvasDirectoryIdentity,
  right: CanvasDirectoryIdentity,
): boolean {
  return left.path === right.path
    && left.canonicalPath === right.canonicalPath
    && left.dev === right.dev
    && left.ino === right.ino
}

/**
 * 精确比较 helper OPENED 与 Node bigint 目录身份。
 * @param identity 当前或首次 LOAD 捕获的目录身份。
 * @param root helper 从已打开目录句柄读取的十进制身份。
 */
export function isOpenedRootSameDirectoryIdentity(
  identity: CanvasDirectoryIdentity,
  root: StableDirectoryOpenedRoot,
): boolean {
  return root.requestedPath === identity.path
    && root.canonicalPath === identity.canonicalPath
    && root.isDirectory
    && root.volume === identity.dev.toString(10)
    && root.fileId === identity.ino.toString(10)
}

/** 从 lstat/fstat 提取读取期间必须保持稳定的内容状态。 */
function toCanvasFileState(stats: CanvasFileStat): AtomicFileState {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  }
}

/** 确认两次文件状态的身份与可观察内容版本完全一致。 */
function isSameFileState(left: AtomicFileState, right: AtomicFileState): boolean {
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
function ensureCanvasDirectory(paths: CanvasPaths, canvasesRoot: string): CanvasDirectoryScopeIdentity {
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
  const identity = { canvasesRoot: rootIdentity, canvasRoot: canvasIdentity }
  assertCanvasDirectoryScope(identity)
  return identity
}

/** 使用 no-follow 稳定句柄读取单个 Canvas 文档候选。 */
function readCanvasCandidate(
  candidatePath: string,
  target: CanvasTarget,
  directoryIdentity: CanvasDirectoryIdentity,
  validateDocument: (value: unknown, target: CanvasTarget) => ParsedCanvasDocument,
  afterCandidateRead?: (candidatePath: string) => void,
): CanvasCandidateState {
  if (dirname(candidatePath) !== directoryIdentity.path) {
    throw unsafeCanvasPath(`文档候选不在 Canvas 根: ${candidatePath}`)
  }
  assertDirectoryIdentity(directoryIdentity)
  /** 打开前不跟随 symlink 的路径状态。 */
  const pathStats = lstatOrNull(candidatePath)
  if (!pathStats) return { exists: false, parsedDocument: null }
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
    let parsedDocument: ParsedCanvasDocument | null = null
    try {
      /** 所有 JSON.parse 结果按 unknown 进入严格 validator。 */
      const value: unknown = JSON.parse(raw)
      parsedDocument = validateDocument(value, target)
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
      parsedDocument,
      state: initialState,
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
  validateDocument: (value: unknown, target: CanvasTarget) => ParsedCanvasDocument,
  afterCandidateRead?: (candidatePath: string) => void,
): CanvasDocumentReadResult {
  /** 当前正式主文件候选。 */
  const primary = readCanvasCandidate(
    paths.documentPath, target, directoryIdentity, validateDocument, afterCandidateRead,
  )
  /** 主文件无论缺失、合法或损坏，都形成最终写入必须匹配的 CAS 预期。 */
  const primaryExpectation: AtomicDestinationExpectation = primary.state
    ? { kind: 'state', state: primary.state }
    : { kind: 'missing' }
  if (primary.parsedDocument) {
    return { parsedDocument: primary.parsedDocument, primaryExpectation, hasCandidate: true }
  }
  /** 上次固定恢复流程遗留的 tmp 候选。 */
  const temporary = readCanvasCandidate(
    `${paths.documentPath}.tmp`, target, directoryIdentity, validateDocument, afterCandidateRead,
  )
  if (temporary.parsedDocument) {
    if (!temporary.state) throw unsafeCanvasPath('tmp 候选缺少稳定状态')
    return {
      parsedDocument: temporary.parsedDocument,
      primaryExpectation,
      recoveredFrom: 'tmp',
      recoveredState: temporary.state,
      hasCandidate: true,
    }
  }
  /** 最近一次稳定 revision 的 bak 候选。 */
  const backup = readCanvasCandidate(
    `${paths.documentPath}.bak`, target, directoryIdentity, validateDocument, afterCandidateRead,
  )
  if (backup.parsedDocument) {
    return {
      parsedDocument: backup.parsedDocument,
      primaryExpectation,
      recoveredFrom: 'backup',
      recoveredState: backup.state,
      hasCandidate: true,
    }
  }
  return {
    parsedDocument: null,
    primaryExpectation,
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
  /** 生产默认输出中文降级告警，禁止把已提交 mutation 伪装为失败。 */
  const onRecoveryDegraded = options.onRecoveryDegraded
    ?? ((message: string, error: AtomicWritePostCommitError) => console.warn(message, error))

  /** 降级通知属于观察副作用，自身失败不得改变已提交 mutation 的返回语义。 */
  function reportRecoveryDegraded(message: string, error: AtomicWritePostCommitError): void {
    try {
      onRecoveryDegraded(message, error)
    } catch (reportError) {
      console.warn(`${message}；降级通知失败`, reportError)
    }
  }

  /** 在安全写 rename 前复验固定父目录和路径身份。 */
  function writeCanvasJsonSecure(
    paths: CanvasPaths,
    directoryIdentity: CanvasDirectoryScopeIdentity,
    filePath: string,
    persistencePayload: CanvasDocument | LegacyCanvasDocument,
    writeOptions: Pick<CanvasSecureWriteOptions, 'expectedDestination' | 'priorBackup'> = {},
  ): void {
    if (dirname(filePath) !== paths.canvasRoot) {
      throw unsafeCanvasPath(`文档文件不在 Canvas 根: ${filePath}`)
    }
    writeJson(filePath, persistencePayload, {
      ...writeOptions,
      beforeRename: () => assertCanvasDirectoryScope(directoryIdentity),
    })
  }

  /** 在已授权边界内解析并复验当前 native 文档路径。 */
  function resolveTargetPaths(target: CanvasTarget): {
    paths: CanvasPaths
    directoryIdentity: CanvasDirectoryScopeIdentity
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
    directoryIdentity: CanvasDirectoryScopeIdentity
  } {
    options.sessions.requireNative(target.projectId, target.canvasId)
    /** requireNative 成功后才能触达项目与 Canvas 文档路径解析。 */
    return resolveTargetPaths(target)
  }

  /** 内部加载结果额外保留读取期主状态，公开接口不泄露文件系统信息。 */
  function loadWithAuthoritativeState(
    target: CanvasTarget,
    deferLegacyRecovery = false,
  ): {
    snapshot: CanvasWorkspaceSnapshot
    parsedDocument: ParsedCanvasDocument
    primaryExpectation: AtomicDestinationExpectation
    recoveredState?: AtomicFileState
    authorized: ReturnType<typeof resolveAuthorizedTarget>
  } {
    /** 授权和路径复验是任何文档候选访问的先决条件。 */
    const authorized = resolveAuthorizedTarget(target)
    /** 当前主/tmp/bak 候选链的读取结果。 */
    const readResult = readCanvasDocument(
      authorized.paths,
      target,
      authorized.directoryIdentity.canvasRoot,
      validateDocument,
      options.afterCandidateRead,
    )
    if (!readResult.parsedDocument && readResult.hasCandidate) {
      throw new Error(`CANVAS_DOCUMENT_CORRUPT: ${target.projectId}/${target.canvasId}`)
    }
    /** 缺失文档与磁盘解析结果统一为内部完整解析合同。 */
    const parsedDocument = readResult.parsedDocument ?? (() => {
      /** 空文档只读取一次时钟，保证公开图与持久化载荷完全一致。 */
      const document = createEmptyCanvasDocument(
        target.projectId,
        target.canvasId,
        requireNow(now),
      )
      return { document, legacyContentSeeds: [], persistencePayload: document }
    })()
    /** 副作用调用遇到 v1 时留给迁移事务处理，公开 LOAD 仍正常提升恢复候选。 */
    const shouldPromoteRecovery = readResult.parsedDocument !== null
      && readResult.recoveredFrom !== undefined
      && !(deferLegacyRecovery && readResult.parsedDocument.migratedFrom === 1)
    if (shouldPromoteRecovery && readResult.parsedDocument && readResult.recoveredFrom) {
      /** 恢复候选先安全提升，随后 tmp 才能被原子消费。 */
      try {
        writeCanvasJsonSecure(
          authorized.paths,
          authorized.directoryIdentity,
          authorized.paths.documentPath,
          readResult.parsedDocument.persistencePayload,
          { expectedDestination: readResult.primaryExpectation },
        )
      } catch (error) {
        if (error instanceof AtomicDestinationConflictError) {
          throw new Error('CANVAS_REVISION_CONFLICT: document changed during recovery', {
            cause: error,
          })
        }
        if (error instanceof AtomicWritePostCommitError
          && error.stage === 'mainDurabilityUncertain') {
          throw new Error('CANVAS_RECOVERY_REQUIRED: promotion commit durability uncertain', {
            cause: error,
          })
        }
        if (error instanceof AtomicWritePostCommitError
          && error.stage === 'priorBackupDegraded') {
          reportRecoveryDegraded('Canvas 恢复主文件已提交，但恢复备份状态已降级', error)
        } else {
          throw error
        }
      }
      if (readResult.recoveredFrom === 'tmp') {
        if (!readResult.recoveredState) throw unsafeCanvasPath('tmp 恢复缺少绑定状态')
        /** 删除只消费本次实际读取的 tmp inode，置换文件必须保留。 */
        const temporaryPath = `${authorized.paths.documentPath}.tmp`
        options.beforeConsumeRecoveredTemporary?.(temporaryPath)
        removeFile(temporaryPath, {
          expectedIdentity: {
            dev: readResult.recoveredState.dev,
            ino: readResult.recoveredState.ino,
          },
        })
        assertCanvasDirectoryScope(authorized.directoryIdentity)
      }
    }
    return {
      snapshot: {
        document: parsedDocument.document,
        writable: true,
        nodeIssues: [],
        ...(readResult.recoveredFrom ? { recoveredFrom: readResult.recoveredFrom } : {}),
      },
      parsedDocument,
      primaryExpectation: readResult.primaryExpectation,
      recoveredState: readResult.recoveredState,
      authorized,
    }
  }

  /** 从恢复链加载文档，合法恢复候选会安全提升为主文件。 */
  function load(target: CanvasTarget): CanvasWorkspaceSnapshot {
    return loadWithAuthoritativeState(target).snapshot
  }

  /** 从同一次 LOAD 授权事实派生单级子目录 capability。 */
  function loadWithDirectoryCapability(target: CanvasTarget): CanvasDocumentDirectoryCapability {
    const loaded = loadWithAuthoritativeState(target)
    const scopeIdentity = loaded.authorized.directoryIdentity
    return {
      snapshot: loaded.snapshot,
      openSingleChildDirectory: (name): CanvasTrustedDirectoryCapability => {
        if (!isSafeDesignStableId(name)) throw unsafeCanvasPath('Canvas 子目录名非法')
        const childPath = join(scopeIdentity.canvasRoot.path, name)
        if (dirname(childPath) !== scopeIdentity.canvasRoot.path || basename(childPath) !== name) {
          throw unsafeCanvasPath('Canvas 子目录不满足单级合同')
        }
        /** 子目录创建和打开交给 native helper 在已授权 root HANDLE 下完成。 */
        const assertValid = (): void => assertCanvasDirectoryScope(scopeIdentity)
        /** OPENED 必须同时匹配当前 registry/resolver 和首次 LOAD 捕获的 Canvas 根。 */
        const authorizeOpenedRoots = (roots: readonly StableDirectoryOpenedRoot[]): boolean => {
          /** 授权瞬间重新读取 registry 和当前 resolver，撤权或迁移不得复用旧 capability。 */
          const current = resolveAuthorizedTarget(target)
          const currentCanvasRoot = current.directoryIdentity.canvasRoot
          const [root] = roots
          const allowed = roots.length === 1
            && isSameDirectoryIdentity(currentCanvasRoot, scopeIdentity.canvasRoot)
            && root !== undefined
            && isOpenedRootSameDirectoryIdentity(currentCanvasRoot, root)
          /** 返回 ALLOW 前再次复验当前与首次目录身份，缩短捕获后的置换窗口。 */
          assertCanvasDirectoryScope(current.directoryIdentity)
          assertValid()
          return allowed
        }
        assertValid()
        return {
          path: childPath,
          rootPath: scopeIdentity.canvasRoot.path,
          assertValid,
          authorizeOpenedRoots,
        }
      },
    }
  }

  /** 返回只绑定同一次读取事实的旧内容迁移能力。 */
  function loadWithMigrationCapability(target: CanvasTarget): CanvasDocumentMigrationCapability {
    const loaded = loadWithAuthoritativeState(target, true)
    const scopeIdentity = loaded.authorized.directoryIdentity
    /** 为内容 Store 提供同一 Canvas 根下的窄子目录能力。 */
    const openSingleChildDirectory = (name: string): CanvasTrustedDirectoryCapability => {
      if (!isSafeDesignStableId(name)) throw unsafeCanvasPath('Canvas 子目录名非法')
      const childPath = join(scopeIdentity.canvasRoot.path, name)
      if (dirname(childPath) !== scopeIdentity.canvasRoot.path || basename(childPath) !== name) {
        throw unsafeCanvasPath('Canvas 子目录不满足单级合同')
      }
      const assertValid = (): void => assertCanvasDirectoryScope(scopeIdentity)
      const authorizeOpenedRoots = (roots: readonly StableDirectoryOpenedRoot[]): boolean => {
        const current = resolveAuthorizedTarget(target)
        const currentCanvasRoot = current.directoryIdentity.canvasRoot
        const [root] = roots
        const allowed = roots.length === 1
          && isSameDirectoryIdentity(currentCanvasRoot, scopeIdentity.canvasRoot)
          && root !== undefined
          && isOpenedRootSameDirectoryIdentity(currentCanvasRoot, root)
        assertCanvasDirectoryScope(current.directoryIdentity)
        assertValid()
        return allowed
      }
      assertValid()
      return { path: childPath, rootPath: scopeIdentity.canvasRoot.path, assertValid, authorizeOpenedRoots }
    }
    return {
      snapshot: loaded.snapshot,
      migratedFrom: loaded.parsedDocument.migratedFrom,
      legacyContentSeeds: loaded.parsedDocument.legacyContentSeeds.map((seed) => ({ ...seed })),
      openSingleChildDirectory,
      commitMigration: (): CanvasDocument => {
        if (loaded.parsedDocument.migratedFrom !== 1) return loaded.snapshot.document
        assertCanvasDirectoryScope(scopeIdentity)
        try {
          writeCanvasJsonSecure(
            loaded.authorized.paths,
            scopeIdentity,
            loaded.authorized.paths.documentPath,
            loaded.parsedDocument.document,
            { expectedDestination: loaded.primaryExpectation },
          )
        } catch (error) {
          if (error instanceof AtomicDestinationConflictError) {
            throw new Error('CANVAS_REVISION_CONFLICT: document changed during migration', { cause: error })
          }
          if (error instanceof AtomicWritePostCommitError) {
            throw new Error('CANVAS_COMMIT_UNCERTAIN: migration durability requires reload', { cause: error })
          }
          throw error
        }
        assertCanvasDirectoryScope(scopeIdentity)
        if (loaded.snapshot.recoveredFrom === 'tmp') {
          if (!loaded.recoveredState) throw unsafeCanvasPath('tmp 迁移缺少绑定状态')
          const temporaryPath = `${loaded.authorized.paths.documentPath}.tmp`
          options.beforeConsumeRecoveredTemporary?.(temporaryPath)
          removeFile(temporaryPath, {
            expectedIdentity: { dev: loaded.recoveredState.dev, ino: loaded.recoveredState.ino },
          })
          assertCanvasDirectoryScope(scopeIdentity)
        }
        return loaded.parsedDocument.document
      },
    }
  }

  /** 加载可用于副作用的稳定权威文档，恢复首次调用必须由上层重载确认。 */
  function requireStableAuthoritativeDocument(target: CanvasTarget): CanvasDocument {
    /** 内部解析结果同时决定恢复与迁移阻断。 */
    const loaded = loadWithAuthoritativeState(target, true)
    if (loaded.parsedDocument.migratedFrom === 1) throw new Error('CANVAS_MIGRATION_REQUIRED')
    if (loaded.snapshot.recoveredFrom) {
      throw new Error(`CANVAS_RECOVERY_REQUIRED: recoveredFrom=${loaded.snapshot.recoveredFrom}`)
    }
    return loaded.snapshot.document
  }

  /** 只验证并深拷贝 mutation，不产生 revision 或磁盘副作用。 */
  function validateBatchOperations(
    target: CanvasTarget,
    expectedRevision: number,
    operations: unknown[],
  ): CanvasMutation[] {
    const current = requireStableAuthoritativeDocument(target)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
      throw new Error(
        `CANVAS_REVISION_CONFLICT: expected=${expectedRevision}, current=${current.revision}`,
      )
    }
    validateCanvasMutations(current, operations)
    return structuredClone(operations) as CanvasMutation[]
  }

  /** 在磁盘最新 revision 上应用一批受控 mutation 并安全提交。 */
  function mutate(
    target: CanvasTarget,
    expectedRevision: number,
    mutations: CanvasMutation[],
    validateCurrent?: (document: CanvasDocument) => void,
  ): CanvasDocument {
    /** mutation 始终从稳定权威文档开始，禁止跨恢复边界写入。 */
    const loaded = loadWithAuthoritativeState(target, true)
    const current = loaded.snapshot.document
    if (loaded.parsedDocument.migratedFrom === 1) throw new Error('CANVAS_MIGRATION_REQUIRED')
    if (loaded.snapshot.recoveredFrom) {
      throw new Error(`CANVAS_RECOVERY_REQUIRED: recoveredFrom=${loaded.snapshot.recoveredFrom}`)
    }
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
      }, target).document
    } catch (error) {
      throw new Error('CANVAS_MUTATION_INVALID', { cause: error })
    }
    /** 写入前重新解析并复验路径，适配项目根在调用间迁移。 */
    const authorized = resolveAuthorizedTarget(target)
    /** 主提交与 previous revision backup 共用一次 CAS 安全写边界。 */
    try {
      writeCanvasJsonSecure(
        authorized.paths,
        authorized.directoryIdentity,
        authorized.paths.documentPath,
        next,
        {
          expectedDestination: loaded.primaryExpectation,
          ...(loaded.primaryExpectation.kind === 'state' ? {
            priorBackup: {
              filePath: `${authorized.paths.documentPath}.bak`,
              data: current,
            },
          } : {}),
        },
      )
    } catch (error) {
      if (error instanceof AtomicDestinationConflictError) {
        throw new Error('CANVAS_REVISION_CONFLICT: document changed before commit', {
          cause: error,
        })
      }
      if (error instanceof AtomicWritePostCommitError) {
        if (error.stage === 'priorBackupDegraded') {
          reportRecoveryDegraded(
            `Canvas mutation 已提交，但 previous revision backup 降级: ${target.projectId}/${target.canvasId}`,
            error,
          )
          return next
        }
        throw new Error('CANVAS_COMMIT_UNCERTAIN: main durability requires reload', {
          cause: error,
        })
      }
      throw error
    }
    return next
  }

  return { load, loadWithDirectoryCapability, loadWithMigrationCapability, requireStableAuthoritativeDocument, validateBatchOperations, mutate }
}
