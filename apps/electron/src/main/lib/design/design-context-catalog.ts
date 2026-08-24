import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import type {
  DesignContextCategory,
  DesignContextEntry,
  DesignContextManifest,
  ImportDesignContextDocumentInput,
  RegisterDesignContextAssetInput,
  UpdateDesignContextEntryInput,
  UpsertDesignContextDocumentInput,
} from '@proma/shared'
import {
  ensureDirectoryDurable,
  readJsonFileSafe,
  removeFileAtomic,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from '../safe-file'
import { isSafeDesignStableId } from './design-paths'
import type { DesignPathResolver, DesignPaths } from './design-paths'

/** 创作上下文清单的当前 schema 版本。 */
const DESIGN_CONTEXT_MANIFEST_VERSION = 1 as const
/** 单份 Markdown 创作资料允许的最大 UTF-8 字节数。 */
const MAX_MARKDOWN_BYTES = 256 * 1024
/** 单个上下文标题允许的最大字符数。 */
const MAX_TITLE_LENGTH = 120
/** 单个上下文条目允许的最大标签数量。 */
const MAX_TAG_COUNT = 20
/** 允许写入共享契约的固定上下文类别。 */
const DESIGN_CONTEXT_CATEGORIES = new Set<DesignContextCategory>([
  'brand',
  'product',
  'code',
  'character',
  'story',
  'scene',
  'continuity',
  'reference',
])

/** 从主进程文件选择器导入 Markdown 时附加的可信来源路径。 */
export interface ImportDesignContextDocumentFromPathInput extends ImportDesignContextDocumentInput {
  sourcePath: string
}

/** 创作上下文目录可替换的确定性依赖。 */
export interface DesignContextCatalogDependencies {
  pathResolver: Pick<DesignPathResolver, 'resolve'>
  now?: () => number
  createId?: () => string
}

/** 项目创作上下文目录提供的受控增删改查合同。 */
export interface DesignContextCatalogContract {
  list: (projectId: string, query?: string) => DesignContextEntry[]
  readDocument: (projectId: string, entryId: string) => string
  upsertDocument: (input: UpsertDesignContextDocumentInput) => DesignContextEntry
  importDocument: (input: ImportDesignContextDocumentFromPathInput) => DesignContextEntry
  updateMetadata: (input: UpdateDesignContextEntryInput) => DesignContextEntry
  registerAsset: (input: RegisterDesignContextAssetInput) => DesignContextEntry
  delete: (projectId: string, entryId: string, referencedByJobIds: readonly string[]) => void
  isAssetReferenced: (projectId: string, assetId: string) => boolean
}

/** 原子管理项目内 Markdown 资料和 Design 素材引用。 */
export class DesignContextCatalog implements DesignContextCatalogContract {
  /** 返回当前墙钟时间，测试可注入固定值。 */
  private readonly now: () => number
  /** 只由主进程调用的稳定 ID 生成器。 */
  private readonly createId: () => string

  constructor(private readonly dependencies: DesignContextCatalogDependencies) {
    this.now = dependencies.now ?? Date.now
    this.createId = dependencies.createId ?? randomUUID
  }

  /**
   * 查询项目上下文条目并返回与清单隔离的副本。
   * @param projectId 已登记项目的稳定 ID。
   * @param query 可选的标题、标签或类别关键词。
   * @returns 按更新时间倒序排列的可移植条目。
   */
  list(projectId: string, query?: string): DesignContextEntry[] {
    /** 权威项目路径用于约束所有后续文件访问。 */
    const paths = this.dependencies.pathResolver.resolve(projectId)
    /** 当前清单；首次使用时只返回内存空清单，不制造磁盘写入。 */
    const manifest = this.readManifest(paths, projectId)
    /** 规范化后的可选查询词。 */
    const normalizedQuery = query?.trim().toLocaleLowerCase()
    /** 查询结果复制标签数组，避免调用方修改缓存事实。 */
    return manifest.entries
      .filter((entry) => !normalizedQuery || matchesQuery(entry, normalizedQuery))
      .map(cloneEntry)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  }

  /**
   * 从稳定文件身份读取一份受管 Markdown 文档。
   * @param projectId 已登记项目 ID。
   * @param entryId 文档条目的稳定 ID。
   * @returns UTF-8 Markdown 原文。
   */
  readDocument(projectId: string, entryId: string): string {
    assertStableId(entryId, '创作上下文 ID 非法')
    /** 读取前先解析可信路径并定位权威条目。 */
    const paths = this.dependencies.pathResolver.resolve(projectId)
    const manifest = this.readManifest(paths, projectId)
    const entry = manifest.entries.find((candidate) => candidate.id === entryId)
    if (!entry) throw new Error(`创作上下文不存在: ${entryId}`)
    if (entry.kind !== 'document' || !entry.relativePath) {
      throw new Error(`创作上下文不是文档: ${entryId}`)
    }
    /** 相对路径必须与条目 ID 的唯一受管位置完全一致。 */
    const documentPath = resolveDocumentPath(paths, entry)
    return readStableMarkdownFile(documentPath, '创作上下文文档不是普通文件')
  }

  /**
   * 新建或覆盖一份受管 Markdown 文档。
   * @param input Renderer 已通过 IPC 校验的结构化输入。
   * @returns 保存后的可移植目录条目。
   */
  upsertDocument(input: UpsertDesignContextDocumentInput): DesignContextEntry {
    /** 所有用户元数据在任何文件写入前完成清洗和上限校验。 */
    const title = normalizeTitle(input.title)
    const tags = normalizeTags(input.tags)
    assertMarkdown(input.markdown)
    /** 已登记项目解析出的可信受管路径。 */
    const paths = this.dependencies.pathResolver.resolve(input.projectId)
    const manifest = this.readManifest(paths, input.projectId)
    /** 更新沿用原 ID；新建 ID 只能来自主进程生成器。 */
    const entryId = input.entryId ?? this.createId()
    assertStableId(entryId, '创作上下文 ID 非法')
    /** 同 ID 更新时只能覆盖文档，不能把素材引用隐式改成文档。 */
    const existing = manifest.entries.find((entry) => entry.id === entryId)
    if (existing && existing.kind !== 'document') {
      throw new Error(`创作上下文类型不可变: ${entryId}`)
    }
    this.ensureContextDirectories(paths)
    /** 文档始终落在由 ID 推导的唯一相对路径。 */
    const relativePath = documentRelativePath(entryId)
    const documentPath = join(paths.contextRoot, relativePath)
    assertSafeWritableFile(documentPath, '创作上下文文档不是普通文件')
    assertSafeWritableFile(`${documentPath}.tmp`, '创作上下文临时文档不是普通文件')
    /** 先提交文档内容，避免清单指向尚不存在的新文件。 */
    writeTextFileAtomic(documentPath, input.markdown)
    /** 保存后的文档条目不保留任何来源绝对路径。 */
    const entry: DesignContextEntry = {
      id: entryId,
      projectId: input.projectId,
      category: input.category,
      kind: 'document',
      title,
      relativePath,
      tags,
      source: 'user',
      updatedAt: this.now(),
    }
    assertContextCategory(entry.category)
    this.writeManifest(paths, replaceEntry(manifest, entry))
    return cloneEntry(entry)
  }

  /**
   * 从文件选择器返回的普通 Markdown 文件复制创作资料。
   * @param input 包含主进程可信来源路径的导入输入。
   * @returns 新建的受管文档条目。
   */
  importDocument(input: ImportDesignContextDocumentFromPathInput): DesignContextEntry {
    if (!isAbsolute(input.sourcePath) || extname(input.sourcePath).toLocaleLowerCase() !== '.md') {
      throw new Error('导入文件必须是普通 Markdown 文件')
    }
    /** 使用 no-follow descriptor 固定选择器返回文件的读取身份。 */
    const markdown = readStableMarkdownFile(input.sourcePath, '导入文件必须是普通 Markdown 文件')
    /** 导入标题只取文件名，不保留所在目录。 */
    const title = basename(input.sourcePath, extname(input.sourcePath))
    return this.upsertDocument({
      projectId: input.projectId,
      category: input.category,
      title,
      tags: input.tags,
      markdown,
    })
  }

  /**
   * 只更新条目标题、类别和标签，不改变引用身份。
   * @param input 元数据更新输入。
   * @returns 更新后的可移植条目。
   */
  updateMetadata(input: UpdateDesignContextEntryInput): DesignContextEntry {
    assertStableId(input.entryId, '创作上下文 ID 非法')
    /** 清洗后的展示元数据。 */
    const title = normalizeTitle(input.title)
    const tags = normalizeTags(input.tags)
    assertContextCategory(input.category)
    /** 从权威清单获取不可变的引用字段。 */
    const paths = this.dependencies.pathResolver.resolve(input.projectId)
    const manifest = this.readManifest(paths, input.projectId)
    const existing = manifest.entries.find((entry) => entry.id === input.entryId)
    if (!existing) throw new Error(`创作上下文不存在: ${input.entryId}`)
    /** 新条目只替换允许编辑的元数据。 */
    const entry: DesignContextEntry = {
      ...existing,
      category: input.category,
      title,
      tags,
      updatedAt: this.now(),
    }
    this.ensureContextDirectories(paths)
    this.writeManifest(paths, replaceEntry(manifest, entry))
    return cloneEntry(entry)
  }

  /**
   * 把已有 Design 素材登记为长期视觉标准。
   * @param input 素材 ID 与用户确认后的展示元数据。
   * @returns 新建的素材引用条目。
   */
  registerAsset(input: RegisterDesignContextAssetInput): DesignContextEntry {
    assertStableId(input.assetId, 'Design 素材 ID 非法')
    assertContextCategory(input.category)
    /** 所有展示字段在写入清单前完成规范化。 */
    const title = normalizeTitle(input.title)
    const tags = normalizeTags(input.tags)
    /** 从可信项目路径加载当前清单。 */
    const paths = this.dependencies.pathResolver.resolve(input.projectId)
    const manifest = this.readManifest(paths, input.projectId)
    /** 同一素材重复登记时复用原条目，防止清单膨胀。 */
    const existing = manifest.entries.find((entry) => entry.kind === 'asset' && entry.assetId === input.assetId)
    /** 只有首次登记才由主进程生成新的目录条目 ID。 */
    const entryId = existing?.id ?? this.createId()
    assertStableId(entryId, '创作上下文 ID 非法')
    const entry: DesignContextEntry = {
      id: entryId,
      projectId: input.projectId,
      category: input.category,
      kind: 'asset',
      title,
      assetId: input.assetId,
      tags,
      source: 'design-asset',
      updatedAt: this.now(),
    }
    this.ensureContextDirectories(paths)
    this.writeManifest(paths, replaceEntry(manifest, entry))
    return cloneEntry(entry)
  }

  /**
   * 删除上下文条目；文档先原子移除，成功后才更新 manifest。
   * @param projectId 已登记项目 ID。
   * @param entryId 需要删除的稳定条目 ID。
   * @param referencedByJobIds 仍审计引用该条目的任务 ID。
   */
  delete(projectId: string, entryId: string, referencedByJobIds: readonly string[]): void {
    assertStableId(entryId, '创作上下文 ID 非法')
    if (referencedByJobIds.length > 0) {
      throw new Error(`创作上下文仍被任务引用: ${referencedByJobIds.join(', ')}`)
    }
    /** 从权威清单定位删除目标。 */
    const paths = this.dependencies.pathResolver.resolve(projectId)
    const manifest = this.readManifest(paths, projectId)
    const entry = manifest.entries.find((candidate) => candidate.id === entryId)
    if (!entry) throw new Error(`创作上下文不存在: ${entryId}`)
    if (entry.kind === 'document') {
      /** 文档删除失败时保持 manifest 不变，供用户重试。 */
      const documentPath = resolveDocumentPath(paths, entry)
      assertSafeExistingFile(documentPath, '创作上下文文档不是普通文件')
      removeFileAtomic(documentPath)
    }
    /** 素材条目只移除引用，不触碰正式 Design 素材。 */
    const nextManifest: DesignContextManifest = {
      ...manifest,
      entries: manifest.entries.filter((candidate) => candidate.id !== entryId),
      updatedAt: this.now(),
    }
    this.ensureContextDirectories(paths)
    this.writeManifest(paths, nextManifest)
  }

  /**
   * 判断当前项目的素材是否已登记为长期视觉标准。
   * @param projectId 已登记项目 ID。
   * @param assetId Design 素材稳定 ID。
   * @returns 存在素材引用条目时返回 true。
   */
  isAssetReferenced(projectId: string, assetId: string): boolean {
    assertStableId(assetId, 'Design 素材 ID 非法')
    return this.list(projectId).some((entry) => entry.kind === 'asset' && entry.assetId === assetId)
  }

  /** 读取主/tmp/bak 恢复链，并区分首次使用与全部候选损坏。 */
  private readManifest(paths: DesignPaths, projectId: string): DesignContextManifest {
    /** 先固定祖先目录边界，避免安全叶子文件经父目录符号链接越权。 */
    assertExistingContextDirectoryChain(paths)
    /** 读取前拒绝清单恢复链中的符号链接和特殊文件。 */
    const candidatePaths = [
      paths.contextManifestPath,
      `${paths.contextManifestPath}.tmp`,
      `${paths.contextManifestPath}.bak`,
    ]
    /** 是否存在至少一个需要恢复或判损的候选。 */
    const hasCandidate = candidatePaths.some((candidatePath) => assertOptionalRegularFile(candidatePath))
    if (!hasCandidate) return createEmptyManifest(projectId, this.now())
    /** 只接受项目 ID 与条目路径都匹配的 manifest。 */
    const manifest = readJsonFileSafe<DesignContextManifest>(paths.contextManifestPath, {
      validate: (value): value is DesignContextManifest => isDesignContextManifest(value, projectId),
    })
    if (!manifest) throw new Error(`创作上下文清单无效: ${projectId}`)
    return cloneManifest(manifest)
  }

  /** 原子写入已验证的 manifest，并保护固定 tmp/bak 目标不跟随符号链接。 */
  private writeManifest(paths: DesignPaths, manifest: DesignContextManifest): void {
    if (!isDesignContextManifest(manifest, paths.projectId)) {
      throw new Error(`创作上下文清单无效: ${paths.projectId}`)
    }
    assertSafeWritableFile(paths.contextManifestPath, '创作上下文清单不是普通文件')
    assertSafeWritableFile(`${paths.contextManifestPath}.tmp`, '创作上下文临时清单不是普通文件')
    assertSafeWritableFile(`${paths.contextManifestPath}.bak`, '创作上下文备份清单不是普通文件')
    writeJsonFileAtomic(paths.contextManifestPath, manifest)
  }

  /** 幂等创建项目内受管目录，并拒绝任一层符号链接或越权 realpath。 */
  private ensureContextDirectories(paths: DesignPaths): void {
    /** 项目根是所有正式上下文目录的包含关系基准。 */
    const projectRoot = realpathSync(paths.projectRoot)
    /** 按父到子顺序创建，满足 ensureDirectoryDurable 的单层父目录合同。 */
    const directories = [
      join(paths.projectRoot, '.proma'),
      paths.designRoot,
      paths.contextRoot,
      paths.contextDocumentsDir,
      paths.contextReferencesDir,
    ]
    for (const directoryPath of directories) {
      assertOrCreateManagedDirectory(directoryPath, projectRoot)
    }
  }
}

/** 创建尚未落盘的空项目清单。 */
function createEmptyManifest(projectId: string, now: number): DesignContextManifest {
  return {
    schemaVersion: DESIGN_CONTEXT_MANIFEST_VERSION,
    projectId,
    entries: [],
    updatedAt: now,
  }
}

/** 判断未知值是否为当前项目的严格上下文清单。 */
function isDesignContextManifest(value: unknown, projectId: string): value is DesignContextManifest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'projectId', 'entries', 'updatedAt'])) return false
  if (value.schemaVersion !== DESIGN_CONTEXT_MANIFEST_VERSION || value.projectId !== projectId) return false
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return false
  return Array.isArray(value.entries)
    && value.entries.every((entry) => isDesignContextEntry(entry, projectId))
    && new Set(value.entries.map((entry) => entry.id)).size === value.entries.length
}

/** 判断未知值是否为字段互斥且路径受管的上下文条目。 */
function isDesignContextEntry(value: unknown, projectId: string): value is DesignContextEntry {
  if (!isRecord(value)) return false
  if (value.projectId !== projectId || !isSafeDesignStableId(value.id)) return false
  if (!isDesignContextCategory(value.category) || typeof value.title !== 'string') return false
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string')) return false
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return false
  if (value.kind === 'document') {
    return hasOnlyKeys(value, [
      'id', 'projectId', 'category', 'kind', 'title', 'relativePath', 'tags', 'source', 'updatedAt',
    ])
      && value.source === 'user'
      && value.relativePath === documentRelativePath(value.id)
  }
  if (value.kind === 'asset') {
    return hasOnlyKeys(value, [
      'id', 'projectId', 'category', 'kind', 'title', 'assetId', 'tags', 'source', 'updatedAt',
    ])
      && value.source === 'design-asset'
      && isSafeDesignStableId(value.assetId)
  }
  return false
}

/** 把清单中的同 ID 条目替换到原位置，或追加新条目。 */
function replaceEntry(manifest: DesignContextManifest, entry: DesignContextEntry): DesignContextManifest {
  /** 已有条目的稳定数组位置。 */
  const existingIndex = manifest.entries.findIndex((candidate) => candidate.id === entry.id)
  /** 复制数组避免原地修改调用方持有的清单。 */
  const entries = manifest.entries.map(cloneEntry)
  if (existingIndex >= 0) entries[existingIndex] = cloneEntry(entry)
  else entries.push(cloneEntry(entry))
  return {
    ...manifest,
    entries,
    updatedAt: entry.updatedAt,
  }
}

/** 规范化标题并执行共享展示上限。 */
function normalizeTitle(value: string): string {
  /** 去除用户粘贴产生的首尾空白。 */
  const title = value.trim()
  if (title.length === 0) throw new Error('标题不能为空')
  if (title.length > MAX_TITLE_LENGTH) throw new Error(`标题不能超过 ${MAX_TITLE_LENGTH} 个字符`)
  return title
}

/** 清洗标签空白、去重，并限制清单规模。 */
function normalizeTags(values: readonly string[]): string[] {
  /** 使用 Set 保持首次出现顺序并去除重复标签。 */
  const tags = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
  if (tags.length > MAX_TAG_COUNT) throw new Error(`标签最多 ${MAX_TAG_COUNT} 个`)
  return tags
}

/** 校验 Markdown 字符串和 UTF-8 字节上限。 */
function assertMarkdown(markdown: string): void {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw new Error('Markdown 不能超过 256 KiB')
  }
}

/** 校验共享上下文类别，防止运行时伪造联合类型。 */
function assertContextCategory(value: DesignContextCategory): void {
  if (!DESIGN_CONTEXT_CATEGORIES.has(value)) throw new Error(`创作上下文类别非法: ${String(value)}`)
}

/** 判断未知值是否属于共享上下文类别。 */
function isDesignContextCategory(value: unknown): value is DesignContextCategory {
  return typeof value === 'string' && DESIGN_CONTEXT_CATEGORIES.has(value as DesignContextCategory)
}

/** 校验主进程生成或 IPC 传入的单级稳定 ID。 */
function assertStableId(value: unknown, message: string): asserts value is string {
  if (!isSafeDesignStableId(value)) throw new Error(`${message}: ${String(value)}`)
}

/** 返回文档条目唯一允许保存的 POSIX 风格受管相对路径。 */
function documentRelativePath(entryId: string): string {
  return `documents/${entryId}.md`
}

/** 从严格条目解析文档绝对路径，并拒绝任何替代相对路径。 */
function resolveDocumentPath(paths: DesignPaths, entry: DesignContextEntry): string {
  if (entry.kind !== 'document' || entry.relativePath !== documentRelativePath(entry.id)) {
    throw new Error(`创作上下文文档路径非法: ${entry.id}`)
  }
  return join(paths.contextRoot, entry.relativePath)
}

/** 使用 no-follow descriptor 读取并复验一份普通 Markdown 文件。 */
function readStableMarkdownFile(filePath: string, invalidMessage: string): string {
  /** 打开前的叶子文件身份。 */
  const initialStat = readRequiredRegularFileStat(filePath, invalidMessage)
  if (initialStat.size > MAX_MARKDOWN_BYTES) throw new Error('Markdown 不能超过 256 KiB')
  /** 文件 descriptor 仅由本次读取拥有。 */
  let descriptor: number | null = null
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    /** 打开后身份必须与路径检查相同。 */
    const openedStat = fstatSync(descriptor)
    if (!openedStat.isFile() || openedStat.dev !== initialStat.dev || openedStat.ino !== initialStat.ino) {
      throw new Error(invalidMessage)
    }
    /** 从固定 descriptor 读取原始字节。 */
    const content = readFileSync(descriptor)
    /** 读取后文件身份和大小都必须保持不变。 */
    const finalStat = fstatSync(descriptor)
    if (finalStat.dev !== initialStat.dev
      || finalStat.ino !== initialStat.ino
      || finalStat.size !== initialStat.size
      || content.byteLength !== finalStat.size) {
      throw new Error(`${invalidMessage}，读取期间身份发生变化`)
    }
    if (content.byteLength > MAX_MARKDOWN_BYTES) throw new Error('Markdown 不能超过 256 KiB')
    return content.toString('utf8')
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

/** 返回单链接普通文件状态，符号链接、目录和特殊文件一律拒绝。 */
function readRequiredRegularFileStat(filePath: string, invalidMessage: string): Stats {
  try {
    /** lstat 不跟随叶子符号链接。 */
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(invalidMessage)
    return stat
  } catch (error) {
    if (error instanceof Error && error.message === invalidMessage) throw error
    throw new Error(invalidMessage, { cause: error })
  }
}

/** 拒绝已存在的非普通写入目标；缺失时允许后续原子创建。 */
function assertSafeWritableFile(filePath: string, invalidMessage: string): void {
  try {
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(invalidMessage)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
}

/** 要求删除目标当前为单链接普通文件。 */
function assertSafeExistingFile(filePath: string, invalidMessage: string): void {
  readRequiredRegularFileStat(filePath, invalidMessage)
}

/** 检查恢复候选；缺失返回 false，存在且安全返回 true。 */
function assertOptionalRegularFile(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`创作上下文清单候选不是普通文件: ${filePath}`)
    }
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

/** 创建或验证项目内单层目录，禁止符号链接和 realpath 越界。 */
function assertOrCreateManagedDirectory(directoryPath: string, projectRoot: string): void {
  try {
    const stat = lstatSync(directoryPath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`创作上下文目录不是实际目录: ${directoryPath}`)
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    ensureDirectoryDurable(directoryPath)
  }
  /** 物理目录必须继续位于项目物理根内。 */
  const canonicalPath = realpathSync(directoryPath)
  const relativePath = relative(projectRoot, canonicalPath)
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
    throw new Error(`创作上下文目录越过项目边界: ${directoryPath}`)
  }
}

/** 验证当前已存在的上下文祖先目录，缺失目录表示尚未初始化。 */
function assertExistingContextDirectoryChain(paths: DesignPaths): void {
  /** 项目根本身也必须是实际目录，不能通过符号链接改变授权边界。 */
  const rootStat = lstatSync(paths.projectRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`创作上下文项目根不是实际目录: ${paths.projectRoot}`)
  }
  /** 项目物理根用于复验每个现存子目录仍位于授权范围内。 */
  const projectRoot = realpathSync(paths.projectRoot)
  /** 读取清单前需要经过的固定正式目录链。 */
  const directories = [join(paths.projectRoot, '.proma'), paths.designRoot, paths.contextRoot]
  for (const directoryPath of directories) {
    try {
      const stat = lstatSync(directoryPath)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`创作上下文目录不是实际目录: ${directoryPath}`)
      }
      /** 已存在目录的 realpath 不得越过项目根。 */
      const canonicalPath = realpathSync(directoryPath)
      const relativePath = relative(projectRoot, canonicalPath)
      if (relativePath === '..'
        || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
        || isAbsolute(relativePath)) {
        throw new Error(`创作上下文目录越过项目边界: ${directoryPath}`)
      }
    } catch (error) {
      if (isMissingPathError(error)) return
      throw error
    }
  }
}

/** 判断条目是否匹配已规范化查询词。 */
function matchesQuery(entry: DesignContextEntry, query: string): boolean {
  return entry.title.toLocaleLowerCase().includes(query)
    || entry.category.toLocaleLowerCase().includes(query)
    || entry.tags.some((tag) => tag.toLocaleLowerCase().includes(query))
}

/** 深复制公开条目，避免调用方修改标签数组。 */
function cloneEntry(entry: DesignContextEntry): DesignContextEntry {
  return { ...entry, tags: [...entry.tags] }
}

/** 深复制 manifest 中的条目数组。 */
function cloneManifest(manifest: DesignContextManifest): DesignContextManifest {
  return { ...manifest, entries: manifest.entries.map(cloneEntry) }
}

/** 判断未知值是否为普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝 JSON 中未声明的字段，避免绝对路径或凭据混入清单。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  /** 允许字段集合用于线性检查实际 JSON 键。 */
  const allowedKeys = new Set(keys)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

/** 只把明确缺失视为可创建状态，权限和 I/O 错误继续失败。 */
function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
