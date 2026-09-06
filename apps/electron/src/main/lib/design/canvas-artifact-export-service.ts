import { createHash } from 'node:crypto'
import { closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  CanvasDocument,
  CanvasImageTarget,
  CanvasTarget,
  CanvasTextArtifactKind,
  CanvasTextArtifactTarget,
  CanvasWorkspaceSnapshot,
  DesignAsset,
  DesignJobRecord,
} from '@proma/shared'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import type {
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
  StableDirectoryOpenedRoot,
} from '../stable-directory-native-host'
import type { CanvasToolRunContext } from './canvas-tool-provider'
import type { CanvasDocumentStore } from './canvas-document-store'
import { createNativeCanvasTransactionArchive } from './canvas-transaction-archive'

/** Agent 只能显式请求精确图片 Job 或文本 revision。 */
export type CanvasArtifactExportVersion =
  | { kind: 'image'; jobId: string }
  | { kind: CanvasTextArtifactKind; revision: number }

/** 导出位置只允许保存窗口或已授权项目内相对路径。 */
export type CanvasArtifactExportDestination =
  | { kind: 'dialog' }
  | { kind: 'project'; relativePath: string }

/** Canvas Agent 精确版本导出请求。 */
export interface CanvasArtifactExportRequest extends CanvasTarget {
  nodeId: string
  version: CanvasArtifactExportVersion
  destination?: CanvasArtifactExportDestination
  overwrite?: boolean
  intent: 'explicit'
}

/** 批量导出项只声明节点与精确版本，文件名由权威节点标题派生。 */
export interface CanvasArtifactBatchExportItem {
  nodeId: string
  version: CanvasArtifactExportVersion
}

/** 批量导出一次选择目录，项目目标也只接受授权根内的相对目录。 */
export interface CanvasArtifactBatchExportRequest extends CanvasTarget {
  items: readonly CanvasArtifactBatchExportItem[]
  destination?: { kind: 'dialog' } | { kind: 'project'; relativeDirectory: string }
  overwrite?: boolean
  intent: 'explicit'
}

/** 执行期身份由工具 Provider 注入，不接受模型伪造。 */
export interface CanvasArtifactExportExecution {
  context: CanvasToolRunContext
  operationId: string
  validateAccess: () => void
  signal?: AbortSignal
}

/** 有界导出结果；取消不暴露或创建目标路径。 */
export type CanvasArtifactExportResult =
  | { status: 'saved'; path: string }
  | { status: 'cancelled' }

/** 批量导出逐项返回稳定结果，单项失败不隐藏其它成功文件。 */
export type CanvasArtifactBatchExportEntry =
  | { nodeId: string; status: 'saved'; path: string }
  | { nodeId: string; status: 'failed'; error: string }
  | { nodeId: string; status: 'cancelled' }

/** 批量导出的有界结果。 */
export interface CanvasArtifactBatchExportResult {
  status: 'completed' | 'cancelled'
  files: CanvasArtifactBatchExportEntry[]
}

/** 保存窗口只接收由权威节点和版本事实派生的建议名称。 */
export interface CanvasArtifactExportPathSelection {
  defaultName: string
  extension: string
}

/** 批量保存窗口只选择一次目录。 */
export interface CanvasArtifactExportDirectorySelection {
  defaultName: string
}

/** 导出 receipt 复用 Canvas transactions 与 transaction archive。 */
export interface CanvasArtifactExportReceiptStore {
  load(target: CanvasTarget, operationId: string): Promise<string | null>
  /** 在跨进程临界区内仅当 receipt 不存在时创建，返回是否取得执行权。 */
  claimActive?(target: CanvasTarget, operationId: string, content: string): Promise<boolean>
  saveActive(target: CanvasTarget, operationId: string, content: string): Promise<void>
  archiveCompleted(target: CanvasTarget, operationId: string, content: string): Promise<void>
}

/** 实际写边界继续由既有文本与图片服务负责。 */
export interface CanvasArtifactExportServiceDependencies {
  documents: Pick<CanvasDocumentStore, 'load'> & Partial<Pick<CanvasDocumentStore, 'loadWithDirectoryCapability'>>
  jobs: { getProjectJob: (projectId: string, jobId: string) => DesignJobRecord | undefined }
  assets: {
    getAsset: (projectId: string, assetId: string) => DesignAsset
    resolveAssetPath: (projectId: string, assetId: string) => string
  }
  textArtifacts: {
    read: (target: CanvasTextArtifactTarget) => Promise<{ target: CanvasTextArtifactTarget; content: string }>
  }
  getAuthorizedProjectRoot: (projectId: string, context: CanvasToolRunContext) => string | undefined
  choosePath: (
    selection: CanvasArtifactExportPathSelection,
    execution: CanvasArtifactExportExecution,
  ) => Promise<string | undefined>
  chooseDirectory?: (
    selection: CanvasArtifactExportDirectorySelection,
    execution: CanvasArtifactExportExecution,
  ) => Promise<string | undefined>
  receipts?: CanvasArtifactExportReceiptStore
  /** receipt 临界区复用现有 Canvas serializer，保存窗口等待不持锁。 */
  runExclusive?: <Result>(target: CanvasTarget, effect: () => Promise<Result>) => Promise<Result>
  runStableDirectoryNative?: (
    request: StableDirectoryNativeRequest,
    authorize: (roots: readonly StableDirectoryOpenedRoot[]) => boolean | Promise<boolean>,
  ) => Promise<StableDirectoryNativeResult>
}

/** 精确版本导出的领域服务。 */
export interface CanvasArtifactExportService {
  export: (
    request: CanvasArtifactExportRequest,
    execution: CanvasArtifactExportExecution,
  ) => Promise<CanvasArtifactExportResult>
  exportBatch: (
    request: CanvasArtifactBatchExportRequest,
    execution: CanvasArtifactExportExecution,
  ) => Promise<CanvasArtifactBatchExportResult>
}

/** 完整解析后的图片版本导出事实。 */
interface ResolvedImageExport {
  kind: 'image'
  assetId: string
  extension: string
  defaultName: string
  expectedSourceSize: number
  expectedSourceSha256: string
}

/** 完整解析后的文本版本导出事实。 */
interface ResolvedTextExport {
  kind: CanvasTextArtifactKind
  target: CanvasTextArtifactTarget
  extension: '.md' | '.html'
  defaultName: string
  content: string
  contentSha256: string
}

type ResolvedExport = ResolvedImageExport | ResolvedTextExport

const MAX_BATCH_EXPORT_ITEMS = 16
const EXPORT_RECEIPT_FILE = /^artifact-export-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/

/** receipt 中的单项计划不保存正文，只固化精确版本和目标路径。 */
interface CanvasArtifactExportReceiptItem extends CanvasArtifactBatchExportItem {
  index: number
  path: string
  fingerprint: string
}

/** 外部写入前后的持久状态；selecting 阻止崩溃重放再次弹窗。 */
interface CanvasArtifactExportReceipt {
  schemaVersion: 1
  operationId: string
  projectId: string
  canvasId: string
  requestFingerprint: string
  destinationKind: 'project' | 'dialog'
  nodeOrder: string[]
  state: 'selecting' | 'prepared' | 'completed'
  items: CanvasArtifactExportReceiptItem[]
  files: CanvasArtifactBatchExportEntry[]
  result?: CanvasArtifactBatchExportResult
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const IMAGE_EXPORT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/** 校验 receipt 中的精确版本，避免任意对象进入恢复路径。 */
function isReceiptVersion(value: unknown): value is CanvasArtifactExportVersion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (record.kind === 'image') return keys === 'jobId,kind' && typeof record.jobId === 'string' && record.jobId.length > 0
  return (record.kind === 'document' || record.kind === 'webview')
    && keys === 'kind,revision'
    && typeof record.revision === 'number'
    && Number.isSafeInteger(record.revision)
    && record.revision >= 0
}

/** 校验单个公开文件结果，不接受额外字段或空身份。 */
function isReceiptFile(value: unknown): value is CanvasArtifactBatchExportEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.nodeId !== 'string' || record.nodeId.length === 0) return false
  const keys = Object.keys(record).sort().join(',')
  if (record.status === 'saved') {
    return keys === 'nodeId,path,status' && typeof record.path === 'string' && isAbsolute(record.path)
  }
  if (record.status === 'failed') {
    return keys === 'error,nodeId,status' && typeof record.error === 'string' && /^CANVAS_[A-Z0-9_]+$/.test(record.error)
  }
  return record.status === 'cancelled' && keys === 'nodeId,status'
}

/** 把未知异常收口为可公开稳定错误。 */
function exportErrorCode(error: unknown): string {
  return error instanceof Error && /^CANVAS_[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'CANVAS_ARTIFACT_EXPORT_FAILED'
}

/** 取消与授权撤销属于整批执行边界，不能降级成普通逐项失败。 */
function mustStopBatch(error: unknown, execution: CanvasArtifactExportExecution): boolean {
  return execution.signal?.aborted === true
    || (error instanceof Error && error.message === 'CANVAS_ACCESS_DENIED')
}

/** 操作请求指纹绑定目标、顺序、版本、目标类型和覆盖语义。 */
function createRequestFingerprint(request: CanvasArtifactExportRequest | CanvasArtifactBatchExportRequest): string {
  /** 递归排序对象键，保证语义相同的工具参数不因 JSON 属性顺序产生不同 operation。 */
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]))
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(request))).digest('hex')
}

/** 精确版本指纹用于崩溃后核验目标内容属于原请求。 */
function createResolvedFingerprint(resolved: ResolvedExport): string {
  return createHash('sha256').update(JSON.stringify(resolved.kind === 'image'
    ? [resolved.kind, resolved.assetId, resolved.expectedSourceSize, resolved.expectedSourceSha256]
    : [resolved.kind, resolved.target, resolved.contentSha256])).digest('hex')
}

/** 严格解析自有 receipt，损坏或身份漂移时 fail closed。 */
function parseReceipt(content: string, target: CanvasTarget, operationId: string): CanvasArtifactExportReceipt {
  let value: unknown
  try { value = JSON.parse(content) as unknown } catch { throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
  const receipt = value as CanvasArtifactExportReceipt
  const expectedKeys = receipt.state === 'completed'
    ? 'canvasId,destinationKind,files,items,nodeOrder,operationId,projectId,requestFingerprint,result,schemaVersion,state'
    : 'canvasId,destinationKind,files,items,nodeOrder,operationId,projectId,requestFingerprint,schemaVersion,state'
  if (Object.keys(receipt).sort().join(',') !== expectedKeys
    || receipt.schemaVersion !== 1 || receipt.operationId !== operationId
    || receipt.projectId !== target.projectId || receipt.canvasId !== target.canvasId
    || (receipt.destinationKind !== 'project' && receipt.destinationKind !== 'dialog')
    || !['selecting', 'prepared', 'completed'].includes(receipt.state)
    || !SHA256_PATTERN.test(String(receipt.requestFingerprint)) || !Array.isArray(receipt.items)
    || !Array.isArray(receipt.files) || !Array.isArray(receipt.nodeOrder)
    || receipt.nodeOrder.length < 1 || receipt.nodeOrder.length > MAX_BATCH_EXPORT_ITEMS
    || receipt.nodeOrder.some((nodeId) => typeof nodeId !== 'string' || nodeId.length === 0)
    || new Set(receipt.nodeOrder).size !== receipt.nodeOrder.length
    || receipt.files.some((file) => !isReceiptFile(file))
    || new Set(receipt.files.map((file) => file.nodeId)).size !== receipt.files.length
    || receipt.files.some((file) => !receipt.nodeOrder.includes(file.nodeId))) {
    throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
  }
  const itemNodes = new Set<string>()
  const itemPaths = new Set<string>()
  let previousItemIndex = -1
  for (const item of receipt.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
    const record = item as unknown as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'fingerprint,index,nodeId,path,version'
      || typeof item.nodeId !== 'string' || item.nodeId.length === 0 || itemNodes.has(item.nodeId)
      || !Number.isSafeInteger(item.index) || item.index <= previousItemIndex || item.index >= receipt.nodeOrder.length
      || receipt.nodeOrder[item.index] !== item.nodeId || !isReceiptVersion(item.version)
      || typeof item.path !== 'string' || !isAbsolute(item.path) || resolve(item.path) !== item.path
      || basename(item.path).length === 0 || /[\u0000-\u001f]/.test(item.path)
      || itemPaths.has(item.path) || !SHA256_PATTERN.test(String(item.fingerprint))) {
      throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
    }
    const extension = extname(item.path).toLowerCase()
    if ((item.version.kind === 'document' && extension !== '.md')
      || (item.version.kind === 'webview' && extension !== '.html')
      || (item.version.kind === 'image' && !IMAGE_EXPORT_EXTENSIONS.has(extension))) {
      throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
    }
    itemNodes.add(item.nodeId)
    itemPaths.add(item.path)
    previousItemIndex = item.index
  }
  let previousFileIndex = -1
  for (const file of receipt.files) {
    const fileIndex = receipt.nodeOrder.indexOf(file.nodeId)
    if (fileIndex <= previousFileIndex) throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
    previousFileIndex = fileIndex
  }
  if (receipt.state === 'selecting'
    && (receipt.destinationKind !== 'dialog' || receipt.items.length > 0
      || receipt.files.some((file) => file.status !== 'failed'))) {
    throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
  }
  if (receipt.state !== 'completed' && receipt.result !== undefined) throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
  if (receipt.files.some((file) => file.status === 'saved'
    && (!itemNodes.has(file.nodeId) || receipt.items.find((item) => item.nodeId === file.nodeId)?.path !== file.path))) {
    throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
  }
  if (receipt.state === 'completed') {
    if (!receipt.result || Object.keys(receipt.result).sort().join(',') !== 'files,status'
      || (receipt.result.status !== 'completed' && receipt.result.status !== 'cancelled')
      || !Array.isArray(receipt.result.files)
      || JSON.stringify(receipt.result.files) !== JSON.stringify(receipt.files)
      || (receipt.result.status === 'cancelled') !== receipt.files.some((file) => file.status === 'cancelled')
      || receipt.files.length !== receipt.nodeOrder.length) {
      throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
    }
  }
  return receipt
}

/** 使用既有 transactions 与 transaction archive 保存导出 receipt。 */
export function createNativeCanvasArtifactExportReceiptStore(
  documents: Pick<CanvasDocumentStore, 'loadWithDirectoryCapability'>,
  nativeHost: typeof runStableDirectoryNative = runStableDirectoryNative,
): CanvasArtifactExportReceiptStore {
  const fileName = (operationId: string) => {
    const name = `artifact-export-${operationId}.json`
    if (!EXPORT_RECEIPT_FILE.test(name)) throw new Error('CANVAS_ARTIFACT_EXPORT_OPERATION_INVALID')
    return name
  }
  return {
    load: async (target, operationId) => {
      const loaded = documents.loadWithDirectoryCapability(target)
      const directory = loaded.openSingleChildDirectory('transactions')
      const name = fileName(operationId)
      const active = await nativeHost({
        mode: 'canvas-intent-read', roots: [directory.rootPath], childName: 'transactions',
        fileName: name,
      }, directory.authorizeOpenedRoots)
      if (active.readOutcome?.status === 'ok') {
        directory.assertValid()
        return active.readOutcome.content
      }
      if (active.readOutcome?.status === 'corrupt' || !active.readOutcome) {
        throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
      }
      return createNativeCanvasTransactionArchive(directory, { run: nativeHost }).load(name)
    },
    claimActive: async (target, operationId, content) => {
      const loaded = documents.loadWithDirectoryCapability(target)
      const directory = loaded.openSingleChildDirectory('transactions')
      const result = await nativeHost({
        mode: 'canvas-intent-write', roots: [directory.rootPath], childName: 'transactions',
        fileName: fileName(operationId), content, maxEntries: 512, createOnly: true,
      }, directory.authorizeOpenedRoots)
      directory.assertValid()
      if (!result.writeOutcome?.commitVisible) {
        if (result.writeOutcome?.error === 'canvas intent destination exists') return false
        throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_WRITE_FAILED')
      }
      if (result.writeOutcome.durabilityUncertain) throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_WRITE_FAILED')
      return true
    },
    saveActive: async (target, operationId, content) => {
      const loaded = documents.loadWithDirectoryCapability(target)
      const directory = loaded.openSingleChildDirectory('transactions')
      const result = await nativeHost({
        mode: 'canvas-intent-write', roots: [directory.rootPath], childName: 'transactions',
        fileName: fileName(operationId), content, maxEntries: 512,
      }, directory.authorizeOpenedRoots)
      directory.assertValid()
      if (!result.writeOutcome?.commitVisible || result.writeOutcome.durabilityUncertain) {
        throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_WRITE_FAILED')
      }
    },
    archiveCompleted: async (target, operationId, content) => {
      const loaded = documents.loadWithDirectoryCapability(target)
      const directory = loaded.openSingleChildDirectory('transactions')
      await createNativeCanvasTransactionArchive(directory, { run: nativeHost }).archiveEntries([{
        name: fileName(operationId), content,
      }])
    },
  }
}

/** 比较保存窗口前后重建的精确版本身份，拒绝节点被替换后沿用旧建议。 */
function isSameResolvedExport(left: ResolvedExport, right: ResolvedExport): boolean {
  if (left.kind !== right.kind || left.extension !== right.extension) return false
  if (left.kind === 'image') return right.kind === 'image' && left.assetId === right.assetId
    && left.expectedSourceSize === right.expectedSourceSize
    && left.expectedSourceSha256 === right.expectedSourceSha256
  return right.kind !== 'image'
    && left.target.projectId === right.target.projectId
    && left.target.canvasId === right.target.canvasId
    && left.target.nodeId === right.target.nodeId
    && left.target.kind === right.target.kind
    && left.target.contentId === right.target.contentId
    && left.target.contentRevision === right.target.contentRevision
    && left.contentSha256 === right.contentSha256
}

/** 判断路径是否严格位于指定根内或等于该根。 */
function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
}

/** 标题仅用于建议文件名，去除路径语义并限制长度。 */
function createDefaultName(title: string, extension: string): string {
  const safeTitle = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 80) || 'canvas-artifact'
  return `${safeTitle}${extension}`
}

/** 校验目标父目录为无符号链接的实际目录，叶子只能缺失或为普通文件。 */
function assertSafeDestination(targetPath: string, expectedExtension: string, overwrite: boolean): void {
  if (!isAbsolute(targetPath) || extname(targetPath).toLowerCase() !== expectedExtension.toLowerCase()) {
    throw new Error('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
  }
  try {
    const parentPath = dirname(targetPath)
    const parentStat = lstatSync(parentPath)
    if (!parentStat.isDirectory() || realpathSync(parentPath) !== resolve(parentPath)) {
      throw new Error('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
    }
    if (!existsSync(targetPath)) return
    const targetStat = lstatSync(targetPath)
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
    }
    if (!overwrite) throw new Error('CANVAS_ARTIFACT_EXPORT_EXISTS')
  } catch (error) {
    if (error instanceof Error && /^CANVAS_[A-Z0-9_]+$/.test(error.message)) throw error
    throw new Error('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
  }
}

/** 把 Node stat 与 helper 已打开根的跨平台字符串身份严格比较。 */
function matchesOpenedRoot(path: string, opened: StableDirectoryOpenedRoot, isDirectory: boolean): boolean {
  const stat = lstatSync(path)
  return !stat.isSymbolicLink()
    && stat.isDirectory() === isDirectory
    && stat.isFile() === !isDirectory
    && realpathSync(path) === opened.canonicalPath
    && String(stat.dev) === opened.volume
    && String(stat.ino) === opened.fileId
    && opened.isDirectory === isDirectory
    && (isDirectory || opened.size === stat.size)
}

/** 从每次 fresh 权威图重建节点和请求版本身份。 */
async function resolveExactExport(
  dependencies: CanvasArtifactExportServiceDependencies,
  request: CanvasTarget & CanvasArtifactBatchExportItem,
): Promise<ResolvedExport> {
  const document = dependencies.documents.load(request).document
  const node = document.nodes.find((candidate) => candidate.id === request.nodeId)
  if (!node) throw new Error('CANVAS_NODE_NOT_FOUND')
  if (request.version.kind === 'image') {
    /** 闭包内保留已由判别联合收窄的精确 Job ID。 */
    const jobId = request.version.jobId
    if (node.kind !== 'image') throw new Error('CANVAS_IMAGE_TARGET_INVALID')
    const target: CanvasImageTarget = {
      projectId: request.projectId,
      canvasId: request.canvasId,
      nodeId: node.id,
      imageModuleId: node.imageModuleId,
    }
    const job = dependencies.jobs.getProjectJob(request.projectId, jobId)
    const jobTarget = job?.target
    if (!job
      || job.status !== 'succeeded'
      || jobTarget?.kind !== 'canvas-image'
      || jobTarget.canvasId !== target.canvasId
      || jobTarget.nodeId !== target.nodeId
      || jobTarget.imageModuleId !== target.imageModuleId
      || !job.outputAssetId) {
      throw new Error('CANVAS_IMAGE_VERSION_UNAVAILABLE')
    }
    const asset = dependencies.assets.getAsset(request.projectId, job.outputAssetId)
    if (asset.id !== job.outputAssetId || asset.sourceJobId !== job.id) {
      throw new Error('CANVAS_IMAGE_ASSET_TARGET_CONFLICT')
    }
    const extension = extname(asset.filename).toLowerCase()
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) {
      throw new Error('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
    }
    return {
      kind: 'image', assetId: asset.id, extension, defaultName: createDefaultName(node.title, extension),
      expectedSourceSize: asset.byteSize, expectedSourceSha256: asset.sha256,
    }
  }
  if (node.kind !== request.version.kind) throw new Error('CANVAS_TEXT_ARTIFACT_KIND_MISMATCH')
  if (node.kind !== 'document' && node.kind !== 'webview') throw new Error('CANVAS_TEXT_ARTIFACT_KIND_MISMATCH')
  if (!Number.isSafeInteger(request.version.revision) || request.version.revision < 0) {
    throw new Error('CANVAS_ARTIFACT_REVISION_INVALID')
  }
  const contentId = node.kind === 'document' ? node.documentId : node.prototypeId
  const extension = node.kind === 'document' ? '.md' : '.html'
  const target: CanvasTextArtifactTarget = {
    projectId: request.projectId,
    canvasId: request.canvasId,
    nodeId: node.id,
    kind: node.kind,
    contentId,
    contentRevision: request.version.revision,
  }
  const artifact = await dependencies.textArtifacts.read(target)
  if (artifact.target.projectId !== target.projectId || artifact.target.canvasId !== target.canvasId
    || artifact.target.nodeId !== target.nodeId || artifact.target.contentId !== target.contentId
    || artifact.target.contentRevision !== target.contentRevision || artifact.target.kind !== target.kind) {
    throw new Error('CANVAS_ARTIFACT_EXPORT_VERSION_CONFLICT')
  }
  return {
    kind: node.kind,
    target,
    extension,
    defaultName: createDefaultName(node.title, extension),
    content: artifact.content,
    contentSha256: createHash('sha256').update(artifact.content).digest('hex'),
  }
}

/** 解析项目相对路径，拒绝绝对路径、越界和符号链接父目录。 */
function resolveProjectDestination(rootPath: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new Error('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
  }
  const canonicalRoot = realpathSync(rootPath)
  if (!lstatSync(canonicalRoot).isDirectory()) throw new Error('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
  const targetPath = resolve(canonicalRoot, relativePath)
  if (!isWithinRoot(canonicalRoot, targetPath) || targetPath === canonicalRoot || basename(targetPath) !== basename(relativePath)) {
    throw new Error('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
  }
  return targetPath
}

/** 批量目标目录必须位于授权项目根内，且整条现存路径不经过符号链接。 */
function resolveProjectDirectory(rootPath: string, relativeDirectory: string): string {
  if (typeof relativeDirectory !== 'string' || relativeDirectory.length === 0 || isAbsolute(relativeDirectory)) {
    throw new Error('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
  }
  const canonicalRoot = realpathSync(rootPath)
  const directoryPath = resolve(canonicalRoot, relativeDirectory)
  if (!isWithinRoot(canonicalRoot, directoryPath)) throw new Error('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
  const stat = lstatSync(directoryPath)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directoryPath) !== directoryPath) {
    throw new Error('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
  }
  return directoryPath
}

/** 同一批标题冲突时稳定追加序号，保证每项拥有独立安全叶子。 */
function createUniqueFileNames(exports: readonly ResolvedExport[]): string[] {
  const counts = new Map<string, number>()
  return exports.map((item) => {
    const key = item.defaultName.toLowerCase()
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    if (count === 1) return item.defaultName
    const extension = extname(item.defaultName)
    return `${basename(item.defaultName, extension)}-${count}${extension}`
  })
}

/** 在已固定的文件描述符上流式计算哈希，避免路径重开和大文件进入 JS 堆。 */
async function hashFileDescriptor(fileDescriptor: number): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream('', { fd: fileDescriptor, autoClose: false, highWaterMark: 64 * 1024 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('end', resolvePromise)
    stream.once('error', rejectPromise)
  })
  return hash.digest('hex')
}

/** 崩溃恢复只在目标内容可精确证明时确认外部提交。 */
async function destinationMatches(path: string, resolved: ResolvedExport): Promise<boolean> {
  let fileDescriptor: number | undefined
  try {
    const parentPath = dirname(path)
    const parent = lstatSync(parentPath)
    if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(parentPath) !== resolve(parentPath)) return false
    fileDescriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fileDescriptor)
    if (!stat.isFile()) return false
    const expectedSize = resolved.kind === 'image'
      ? resolved.expectedSourceSize
      : Buffer.byteLength(resolved.content, 'utf8')
    if (stat.size !== expectedSize) return false
    const expectedHash = resolved.kind === 'image' ? resolved.expectedSourceSha256 : resolved.contentSha256
    return await hashFileDescriptor(fileDescriptor) === expectedHash
  } catch {
    return false
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor)
  }
}

/** 创建不持有 UI 状态、也不切换当前采用版本的导出服务。 */
export function createCanvasArtifactExportService(
  dependencies: CanvasArtifactExportServiceDependencies,
): CanvasArtifactExportService {
  const runNative = dependencies.runStableDirectoryNative ?? runStableDirectoryNative
  /** 测试窄夹具可使用内存 receipt；生产 documents 能力始终自动接入原生 transactions。 */
  const memoryReceipts = new Map<string, string>()
  const receipts = dependencies.receipts ?? (dependencies.documents.loadWithDirectoryCapability
    ? createNativeCanvasArtifactExportReceiptStore(
        dependencies.documents as Pick<CanvasDocumentStore, 'loadWithDirectoryCapability'>,
        runNative,
      )
    : {
        load: async (target: CanvasTarget, operationId: string) => memoryReceipts.get(`${target.projectId}\0${target.canvasId}\0${operationId}`) ?? null,
        claimActive: async (target: CanvasTarget, operationId: string, content: string) => {
          const key = `${target.projectId}\0${target.canvasId}\0${operationId}`
          if (memoryReceipts.has(key)) return false
          memoryReceipts.set(key, content)
          return true
        },
        saveActive: async (target: CanvasTarget, operationId: string, content: string) => {
          memoryReceipts.set(`${target.projectId}\0${target.canvasId}\0${operationId}`, content)
        },
        archiveCompleted: async (target: CanvasTarget, operationId: string, content: string) => {
          memoryReceipts.set(`${target.projectId}\0${target.canvasId}\0${operationId}`, content)
        },
      })
  const activeOperations = new Map<string, {
    requestFingerprint: string
    promise: Promise<CanvasArtifactBatchExportResult>
  }>()
  const withReceiptLock = <Result>(target: CanvasTarget, effect: () => Promise<Result>) => (
    dependencies.runExclusive ? dependencies.runExclusive(target, effect) : effect()
  )

  /** 首次 receipt 必须原子创建；测试替身可在既有串行器内退化为检查后写入。 */
  const claimReceipt = async (receipt: CanvasArtifactExportReceipt): Promise<boolean> => {
    const target = { projectId: receipt.projectId, canvasId: receipt.canvasId }
    const content = `${JSON.stringify(receipt, null, 2)}\n`
    const claimed = await withReceiptLock(target, async () => {
      if (receipts.claimActive) return receipts.claimActive(target, receipt.operationId, content)
      if (await receipts.load(target, receipt.operationId)) return false
      await receipts.saveActive(target, receipt.operationId, content)
      return true
    })
    if (claimed && receipt.state === 'completed') {
      await receipts.archiveCompleted(target, receipt.operationId, content)
    }
    return claimed
  }

  /** claim 竞争失败后交回 runOperation 读取赢家状态，当前实例不执行任何外部副作用。 */
  const requireReceiptClaim = async (receipt: CanvasArtifactExportReceipt): Promise<void> => {
    if (!await claimReceipt(receipt)) throw new Error('CANVAS_ARTIFACT_EXPORT_CLAIM_LOST')
  }

  /** receipt 的每次推进都先写 active；completed 再归档，保留精确重放证据。 */
  const persistReceipt = async (receipt: CanvasArtifactExportReceipt): Promise<void> => {
    const target = { projectId: receipt.projectId, canvasId: receipt.canvasId }
    const content = `${JSON.stringify(receipt, null, 2)}\n`
    await withReceiptLock(target, async () => {
      const stored = await receipts.load(target, receipt.operationId)
      if (!stored) throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_MISSING')
      const current = parseReceipt(stored, target, receipt.operationId)
      if (current.requestFingerprint !== receipt.requestFingerprint) {
        throw new Error('CANVAS_ARTIFACT_EXPORT_OPERATION_CONFLICT')
      }
      await receipts.saveActive(target, receipt.operationId, content)
      if (receipt.state === 'completed') await receipts.archiveCompleted(target, receipt.operationId, content)
    })
  }

  /** 使用已打开稳定目录写入一个已全量预检的精确版本。 */
  const writeResolved = async (
    request: CanvasTarget & CanvasArtifactBatchExportItem,
    resolved: ResolvedExport,
    targetPath: string,
    overwrite: boolean,
    destinationKind: 'project' | 'dialog',
    execution: CanvasArtifactExportExecution,
  ): Promise<void> => {
    if (execution.signal?.aborted) throw execution.signal.reason ?? new Error('操作已取消')
    execution.validateAccess()
    const current = await resolveExactExport(dependencies, request)
    if (!isSameResolvedExport(resolved, current)) throw new Error('CANVAS_ARTIFACT_EXPORT_VERSION_CONFLICT')
    assertSafeDestination(targetPath, current.extension, overwrite)
    const parentPath = dirname(targetPath)
    let authorizationError: unknown
    const authorize = async (roots: readonly StableDirectoryOpenedRoot[]): Promise<boolean> => {
      try {
        execution.validateAccess()
        const latest = await resolveExactExport(dependencies, request)
        if (!isSameResolvedExport(current, latest)) return false
        const destinationRoot = roots.at(-1)
        if (!destinationRoot || !matchesOpenedRoot(parentPath, destinationRoot, true)) return false
        if (destinationKind === 'project') {
          const projectRoot = dependencies.getAuthorizedProjectRoot(request.projectId, execution.context)
          if (!projectRoot || !isWithinRoot(realpathSync(projectRoot), destinationRoot.canonicalPath)) return false
        }
        if (latest.kind !== 'image') return roots.length === 1
        const sourcePath = dependencies.assets.resolveAssetPath(request.projectId, latest.assetId)
        const sourceRoot = roots[0]
        return roots.length === 2 && Boolean(sourceRoot) && matchesOpenedRoot(sourcePath, sourceRoot!, false)
      } catch (error) {
        authorizationError = error
        return false
      }
    }
    let nativeResult: StableDirectoryNativeResult
    try {
      nativeResult = current.kind === 'image'
        ? await runNative({
            mode: 'artifact-export-copy',
            roots: [dependencies.assets.resolveAssetPath(request.projectId, current.assetId), parentPath],
            artifactFileName: basename(targetPath), expectedSourceSize: current.expectedSourceSize,
            expectedSourceSha256: current.expectedSourceSha256, overwrite, signal: execution.signal,
          }, authorize)
        : await runNative({
            mode: 'artifact-export-write', roots: [parentPath], artifactFileName: basename(targetPath),
            content: current.content, overwrite, signal: execution.signal,
          }, authorize)
    } catch (error) {
      if (authorizationError !== undefined) throw authorizationError
      /** 授权阶段失败后再检查目标，可把目录替换稳定归类为路径拒绝。 */
      assertSafeDestination(targetPath, current.extension, overwrite)
      throw error
    }
    if (!nativeResult.writeOutcome?.commitVisible) {
      if (nativeResult.writeOutcome?.error === 'artifact export destination exists') {
        throw new Error('CANVAS_ARTIFACT_EXPORT_EXISTS')
      }
      throw new Error('CANVAS_ARTIFACT_EXPORT_WRITE_FAILED')
    }
  }

  /** prepared receipt 重放只能核验已落盘内容；任何缺失都保持不确定而不重写。 */
  const reconcilePrepared = async (
    receipt: CanvasArtifactExportReceipt,
    execution: CanvasArtifactExportExecution,
  ): Promise<CanvasArtifactBatchExportResult> => {
    execution.validateAccess()
    const files = [...receipt.files]
    for (const item of receipt.items) {
      const recorded = files.find((entry) => entry.nodeId === item.nodeId)
      const request = { projectId: receipt.projectId, canvasId: receipt.canvasId, nodeId: item.nodeId, version: item.version }
      const resolved = await resolveExactExport(dependencies, request)
      if (createResolvedFingerprint(resolved) !== item.fingerprint) {
        throw new Error('CANVAS_ARTIFACT_EXPORT_VERSION_CONFLICT')
      }
      if (receipt.destinationKind === 'project') {
        const root = dependencies.getAuthorizedProjectRoot(receipt.projectId, execution.context)
        if (!root || !isWithinRoot(realpathSync(root), item.path)) throw new Error('CANVAS_ACCESS_DENIED')
      }
      const matches = await destinationMatches(item.path, resolved)
      if (recorded?.status === 'saved') {
        if (!matches) throw new Error('CANVAS_ARTIFACT_EXPORT_COMMIT_UNCERTAIN')
        continue
      }
      if (!matches) throw new Error('CANVAS_ARTIFACT_EXPORT_COMMIT_UNCERTAIN')
      files.push({ nodeId: item.nodeId, status: 'saved', path: item.path })
    }
    const result = { status: 'completed' as const, files: files.sort((left, right) => (
      receipt.nodeOrder.indexOf(left.nodeId) - receipt.nodeOrder.indexOf(right.nodeId)
    )) }
    const completed = { ...receipt, state: 'completed' as const, files: result.files, result }
    execution.validateAccess()
    await persistReceipt(completed)
    return result
  }

  /** completed receipt 重放仍复核精确版本与目标内容，损坏数据不能直接返回任意路径。 */
  const validateCompletedReceipt = async (
    receipt: CanvasArtifactExportReceipt,
    execution: CanvasArtifactExportExecution,
  ): Promise<CanvasArtifactBatchExportResult> => {
    execution.validateAccess()
    for (const file of receipt.files) {
      if (file.status !== 'saved') continue
      const item = receipt.items.find((candidate) => candidate.nodeId === file.nodeId)
      if (!item) throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
      const request = { projectId: receipt.projectId, canvasId: receipt.canvasId, nodeId: item.nodeId, version: item.version }
      const resolved = await resolveExactExport(dependencies, request)
      if (createResolvedFingerprint(resolved) !== item.fingerprint
        || !await destinationMatches(item.path, resolved)) {
        throw new Error('CANVAS_ARTIFACT_EXPORT_COMMIT_UNCERTAIN')
      }
      if (receipt.destinationKind === 'project') {
        const root = dependencies.getAuthorizedProjectRoot(receipt.projectId, execution.context)
        if (!root || !isWithinRoot(realpathSync(root), item.path)) {
          throw new Error('CANVAS_ACCESS_DENIED')
        }
      }
    }
    return receipt.result!
  }

  /** 同一 operationId 只运行一次；receipt 还会覆盖进程重启后的重放。 */
  const runOperation = async (
    request: CanvasArtifactExportRequest | CanvasArtifactBatchExportRequest,
    execution: CanvasArtifactExportExecution,
    executeNew: (requestFingerprint: string) => Promise<CanvasArtifactBatchExportResult>,
  ): Promise<CanvasArtifactBatchExportResult> => {
    const target = { projectId: request.projectId, canvasId: request.canvasId }
    const key = `${request.projectId}\0${request.canvasId}\0${execution.operationId}`
    const requestFingerprint = createRequestFingerprint(request)
    const existingOperation = activeOperations.get(key)
    if (existingOperation) {
      if (existingOperation.requestFingerprint !== requestFingerprint) {
        throw new Error('CANVAS_ARTIFACT_EXPORT_OPERATION_CONFLICT')
      }
      return existingOperation.promise
    }
    const promise = (async () => {
      const replayStored = async (): Promise<CanvasArtifactBatchExportResult> => {
        const stored = await withReceiptLock(target, () => receipts.load(target, execution.operationId))
        if (!stored) throw new Error('CANVAS_ARTIFACT_EXPORT_RECEIPT_MISSING')
        const receipt = parseReceipt(stored, target, execution.operationId)
        if (receipt.requestFingerprint !== requestFingerprint) throw new Error('CANVAS_ARTIFACT_EXPORT_OPERATION_CONFLICT')
        if (receipt.state === 'completed' && receipt.result) return validateCompletedReceipt(receipt, execution)
        if (receipt.state === 'selecting') throw new Error('CANVAS_ARTIFACT_EXPORT_COMMIT_UNCERTAIN')
        return reconcilePrepared(receipt, execution)
      }
      const stored = await withReceiptLock(target, () => receipts.load(target, execution.operationId))
      if (stored) {
        return replayStored()
      }
      try {
        return await executeNew(requestFingerprint)
      } catch (error) {
        if (error instanceof Error && error.message === 'CANVAS_ARTIFACT_EXPORT_CLAIM_LOST') {
          return replayStored()
        }
        throw error
      }
    })()
    activeOperations.set(key, { requestFingerprint, promise })
    try { return await promise } finally {
      if (activeOperations.get(key)?.promise === promise) activeOperations.delete(key)
    }
  }

  /** 把完整批次计划逐项提交，并在每个外部可见提交后立即推进 receipt。 */
  const commitPrepared = async (
    receipt: CanvasArtifactExportReceipt,
    resolvedItems: readonly ResolvedExport[],
    overwrite: boolean,
    execution: CanvasArtifactExportExecution,
  ): Promise<CanvasArtifactBatchExportResult> => {
    const files = [...receipt.files]
    for (let index = 0; index < receipt.items.length; index += 1) {
      const item = receipt.items[index]!
      const resolved = resolvedItems[index]!
      try {
        await writeResolved({ projectId: receipt.projectId, canvasId: receipt.canvasId, nodeId: item.nodeId, version: item.version },
          resolved, item.path, overwrite, receipt.destinationKind, execution)
        files.push({ nodeId: item.nodeId, status: 'saved', path: item.path })
      } catch (error) {
        if (mustStopBatch(error, execution)) throw error
        files.push({ nodeId: item.nodeId, status: 'failed', error: exportErrorCode(error) })
      }
      files.sort((left, right) => receipt.nodeOrder.indexOf(left.nodeId) - receipt.nodeOrder.indexOf(right.nodeId))
      receipt = { ...receipt, files: [...files] }
      await persistReceipt(receipt)
    }
    files.sort((left, right) => receipt.nodeOrder.indexOf(left.nodeId) - receipt.nodeOrder.indexOf(right.nodeId))
    const result = { status: 'completed' as const, files }
    await persistReceipt({ ...receipt, state: 'completed', result })
    return result
  }

  return {
    export: async (request, execution) => {
      if (request.intent !== 'explicit') throw new Error('CANVAS_ARTIFACT_EXPORT_INTENT_REQUIRED')
      if (execution.signal?.aborted) throw execution.signal.reason ?? new Error('操作已取消')
      execution.validateAccess()
      const batch = await runOperation(request, execution, async (requestFingerprint) => {
        const resolved = await resolveExactExport(dependencies, request)
        const destination = request.destination ?? { kind: 'dialog' as const }
        if (destination.kind === 'dialog') {
          await requireReceiptClaim({ schemaVersion: 1, operationId: execution.operationId,
            projectId: request.projectId, canvasId: request.canvasId, requestFingerprint,
            destinationKind: 'dialog', nodeOrder: [request.nodeId], state: 'selecting', items: [], files: [] })
        }
        const targetPath = destination.kind === 'dialog'
          ? await dependencies.choosePath({ defaultName: resolved.defaultName, extension: resolved.extension }, execution)
          : (() => {
              const root = dependencies.getAuthorizedProjectRoot(request.projectId, execution.context)
              if (!root) throw new Error('CANVAS_ARTIFACT_EXPORT_PROJECT_ROOT_UNAVAILABLE')
              return resolveProjectDestination(root, destination.relativePath)
            })()
        if (!targetPath) {
          const result = { status: 'cancelled' as const, files: [{ nodeId: request.nodeId, status: 'cancelled' as const }] }
          await persistReceipt({ schemaVersion: 1, operationId: execution.operationId,
            projectId: request.projectId, canvasId: request.canvasId, requestFingerprint,
            destinationKind: 'dialog', nodeOrder: [request.nodeId], state: 'completed', items: [], files: result.files, result })
          return result
        }
        assertSafeDestination(targetPath, resolved.extension, request.overwrite === true)
        const receipt: CanvasArtifactExportReceipt = {
          schemaVersion: 1, operationId: execution.operationId, projectId: request.projectId,
          canvasId: request.canvasId, requestFingerprint, destinationKind: destination.kind,
          nodeOrder: [request.nodeId],
          state: 'prepared', files: [], items: [{ index: 0, nodeId: request.nodeId,
            version: request.version, path: targetPath, fingerprint: createResolvedFingerprint(resolved) }],
        }
        if (destination.kind === 'dialog') await persistReceipt(receipt)
        else await requireReceiptClaim(receipt)
        return commitPrepared(receipt, [resolved], request.overwrite === true, execution)
      })
      const entry = batch.files[0]
      if (!entry || entry.status === 'cancelled') return { status: 'cancelled' }
      if (entry.status === 'failed') throw new Error(entry.error)
      return { status: 'saved', path: entry.path }
    },
    exportBatch: async (request, execution) => {
      if (request.intent !== 'explicit') throw new Error('CANVAS_ARTIFACT_EXPORT_INTENT_REQUIRED')
      if (execution.signal?.aborted) throw execution.signal.reason ?? new Error('操作已取消')
      if (request.items.length < 1 || request.items.length > MAX_BATCH_EXPORT_ITEMS) {
        throw new Error('CANVAS_ARTIFACT_EXPORT_BATCH_SIZE_INVALID')
      }
      if (new Set(request.items.map((item) => item.nodeId)).size !== request.items.length) {
        throw new Error('CANVAS_ARTIFACT_EXPORT_BATCH_TARGET_INVALID')
      }
      execution.validateAccess()
      return runOperation(request, execution, async (requestFingerprint) => {
        const resolved: ResolvedExport[] = []
        const validItems: Array<CanvasArtifactBatchExportItem & { index: number }> = []
        const files: CanvasArtifactBatchExportEntry[] = []
        for (let index = 0; index < request.items.length; index += 1) {
          if (execution.signal?.aborted) throw execution.signal.reason ?? new Error('操作已取消')
          const item = request.items[index]!
          try {
            resolved.push(await resolveExactExport(dependencies, {
              projectId: request.projectId, canvasId: request.canvasId, nodeId: item.nodeId, version: item.version,
            }))
            validItems.push({ ...item, index })
          } catch (error) {
            if (mustStopBatch(error, execution)) throw error
            files.push({ nodeId: item.nodeId, status: 'failed', error: exportErrorCode(error) })
          }
        }
        const destination = request.destination ?? { kind: 'dialog' as const }
        if (resolved.length === 0) {
          files.sort((left, right) => request.items.findIndex((item) => item.nodeId === left.nodeId)
            - request.items.findIndex((item) => item.nodeId === right.nodeId))
          const result = { status: 'completed' as const, files }
          await requireReceiptClaim({ schemaVersion: 1, operationId: execution.operationId,
            projectId: request.projectId, canvasId: request.canvasId, requestFingerprint,
            destinationKind: destination.kind, nodeOrder: request.items.map((item) => item.nodeId),
            state: 'completed', items: [], files, result })
          return result
        }
        if (destination.kind === 'dialog') {
          if (!dependencies.chooseDirectory) throw new Error('CANVAS_ARTIFACT_EXPORT_DESTINATION_REQUIRED')
          await requireReceiptClaim({ schemaVersion: 1, operationId: execution.operationId,
            projectId: request.projectId, canvasId: request.canvasId, requestFingerprint,
            destinationKind: 'dialog', nodeOrder: request.items.map((item) => item.nodeId), state: 'selecting', items: [], files })
        }
        const directoryPath = destination.kind === 'dialog'
          ? await dependencies.chooseDirectory!({ defaultName: 'Canvas exports' }, execution)
          : (() => {
              const root = dependencies.getAuthorizedProjectRoot(request.projectId, execution.context)
              if (!root) throw new Error('CANVAS_ARTIFACT_EXPORT_PROJECT_ROOT_UNAVAILABLE')
              return resolveProjectDirectory(root, destination.relativeDirectory)
            })()
        if (!directoryPath) {
          const cancelled = request.items.map((item) => files.find((entry) => entry.nodeId === item.nodeId)
            ?? { nodeId: item.nodeId, status: 'cancelled' as const })
          const result = { status: 'cancelled' as const, files: cancelled }
          await persistReceipt({ schemaVersion: 1, operationId: execution.operationId,
            projectId: request.projectId, canvasId: request.canvasId, requestFingerprint,
            destinationKind: 'dialog', nodeOrder: request.items.map((item) => item.nodeId), state: 'completed', items: [], files: cancelled, result })
          return result
        }
        const names = createUniqueFileNames(resolved)
        const preparedItems: CanvasArtifactExportReceiptItem[] = []
        const preparedResolved: ResolvedExport[] = []
        for (let index = 0; index < validItems.length; index += 1) {
          const item = validItems[index]!
          const itemResolved = resolved[index]!
          const path = resolve(directoryPath, names[index]!)
          try {
            assertSafeDestination(path, itemResolved.extension, request.overwrite === true)
            preparedItems.push({ ...item, path, fingerprint: createResolvedFingerprint(itemResolved) })
            preparedResolved.push(itemResolved)
          } catch (error) {
            files.push({ nodeId: item.nodeId, status: 'failed', error: exportErrorCode(error) })
          }
        }
        const receipt: CanvasArtifactExportReceipt = {
          schemaVersion: 1, operationId: execution.operationId, projectId: request.projectId,
          canvasId: request.canvasId, requestFingerprint, destinationKind: destination.kind,
          nodeOrder: request.items.map((item) => item.nodeId),
          state: 'prepared', items: preparedItems, files,
        }
        if (destination.kind === 'dialog') await persistReceipt(receipt)
        else await requireReceiptClaim(receipt)
        return commitPrepared(receipt, preparedResolved, request.overwrite === true, execution)
      })
    },
  }
}
