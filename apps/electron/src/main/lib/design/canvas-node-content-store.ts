import {
  parseCanvasImageModuleConfig,
  parseCanvasNodeContentMeta,
  parseCanvasTrashEntry,
} from '@proma/shared'
import type {
  CanvasContentKind,
  CanvasNodeContentMeta,
  CanvasTarget,
  CanvasTrashEntry,
} from '@proma/shared'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import type {
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
  StableDirectoryNativeWriteOutcome,
} from '../stable-directory-native-host'
import type {
  CanvasDocumentStore,
  CanvasTrustedDirectoryCapability,
  LegacyCanvasContentSeed,
} from './canvas-document-store'

/** 内容目录单次列表的硬上限，与 native helper 保持一致。 */
const MAX_CONTENT_ENTRIES = 512
/** nodes marker 最多保留的幂等恢复证据，避免长期删除恢复导致 JSON 无界增长。 */
const MAX_RESTORED_TRASH_ENTRIES = 32
/** 单个受管文本文件的业务上限，与 native helper 保持一致。 */
const MAX_CONTENT_TEXT_LENGTH = 256 * 1024
/** legacy 来源 URL 的有限长度，避免迁移元数据无界增长。 */
const MAX_LEGACY_SOURCE_URL_LENGTH = 2_048
/** Canvas 内容稳定 ID 的业务边界。 */
const CONTENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
/** Webview 空内容固定为不含脚本和外链的离线文档。 */
const EMPTY_WEBVIEW_HTML = '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>未命名原型</title>\n</head>\n<body></body>\n</html>\n'

/** 准备空内容的稳定身份。 */
export interface PrepareCanvasNodeContentInput {
  kind: CanvasContentKind
  contentId: string
  selectedModelProfileId?: string | null
}

/** Agent 创建画布产物时允许初始化的受管正文。 */
export interface PrepareCanvasArtifactContentInput {
  kind: CanvasContentKind
  contentId: string
  content: string
  selectedModelProfileId?: string | null
}

/** Store 内部统一的内容准备种子，兼容 legacy 迁移与新产物初始化。 */
interface CanvasPreparedContentSeed extends PrepareCanvasNodeContentInput {
  adoptedAssetId?: string
  legacySourceUrl?: string
  initialContent?: string
}

/** Canvas 非 Agent 节点内容与回收区的窄业务接口。 */
export interface CanvasNodeContentStore {
  prepareEmptyContent: (target: CanvasTarget, input: PrepareCanvasNodeContentInput) => Promise<void>
  prepareArtifactContent: (target: CanvasTarget, input: PrepareCanvasArtifactContentInput) => Promise<void>
  prepareMigratedContent: (target: CanvasTarget, seed: LegacyCanvasContentSeed) => Promise<void>
  assertContent: (target: CanvasTarget, input: PrepareCanvasNodeContentInput) => Promise<CanvasNodeContentMeta>
  /** 把未进入图提交的本轮新内容移出 active nodes，且不暴露为可恢复回收项。 */
  discardPreparedContent: (
    target: CanvasTarget,
    input: PrepareCanvasNodeContentInput,
    rollbackId: string,
  ) => Promise<void>
  moveToTrash: (target: CanvasTarget, entry: CanvasTrashEntry) => Promise<void>
  /** 共享同一内容资源的多个节点以一次目录移动保存多条独立回收快照。 */
  moveManyToTrash?: (target: CanvasTarget, entries: readonly CanvasTrashEntry[]) => Promise<void>
  restoreFromTrash: (target: CanvasTarget, trashId: string) => Promise<CanvasTrashEntry>
  listTrash: (target: CanvasTarget) => Promise<CanvasTrashEntry[]>
}

/** revision Store 读取旧节点文本正文所需的独立窄能力。 */
export interface CanvasTextRevisionZeroReader {
  /** 读取旧节点目录中的 revision 0 文本正文并返回严格元数据。 */
  readTextRevisionZero: (
    target: CanvasTarget,
    input: { kind: 'document' | 'webview'; contentId: string },
  ) => Promise<{ meta: CanvasNodeContentMeta; content: string }>
}

/** Store 的可信依赖，测试可注入相对协议 fake。 */
export interface CanvasNodeContentStoreDependencies {
  store: Pick<CanvasDocumentStore, 'loadWithDirectoryCapability'>
  runStableDirectoryNative?: (
    request: StableDirectoryNativeRequest,
    authorize: CanvasTrustedDirectoryCapability['authorizeOpenedRoots'],
  ) => Promise<StableDirectoryNativeResult>
  now?: () => number
}

/** 图片节点受管配置文件的严格磁盘结构。 */
interface CanvasImageContentConfig {
  schemaVersion: 1 | 2
  kind: 'image'
  contentId: string
  revision: number
  createdAt: number
  updatedAt: number
  prompt: string
  selectedModelProfileId: string | null
  adoptedAssetId: string | null
  aspectRatio: '1:1'
  imageSize: 'auto'
  contextMode: 'auto'
}

/** Webview 元数据允许携带旧来源，仅作为迁移参考，不用于加载远端内容。 */
export interface CanvasWebviewContentMeta extends CanvasNodeContentMeta {
  legacySourceUrl: string | null
}

/** 单次内容操作从同一个 LOAD 派生的受限目录能力。 */
interface CanvasContentScopes {
  nodes: CanvasTrustedDirectoryCapability
  trash?: CanvasTrustedDirectoryCapability
}

/** 可被列表隔离的单项内容错误码。 */
type CanvasContentItemErrorCode = 'CANVAS_CONTENT_CORRUPT' | 'CANVAS_TRASH_ENTRY_INVALID'

/** 标记单个 entry 自身损坏，避免误吞授权或 helper 基础设施错误。 */
class CanvasContentItemError extends Error {
  /** 单项错误的稳定类别。 */
  readonly code: CanvasContentItemErrorCode

  /**
   * 创建可辨识的单项内容错误。
   * @param code 稳定错误类别。
   * @param detail 不含路径的损坏详情。
   */
  constructor(code: CanvasContentItemErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'CanvasContentItemError'
    this.code = code
  }
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

/** 校验可进入相对目录协议的稳定 ID。 */
function requireContentId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CONTENT_ID_PATTERN.test(value)) {
    throw new Error(`CANVAS_CONTENT_ID_INVALID: ${label}`)
  }
  return value
}

/** 校验内容类别，阻止未来未知类别静默进入磁盘。 */
function requireContentKind(value: unknown): CanvasContentKind {
  if (value !== 'image' && value !== 'document' && value !== 'webview') {
    throw new Error('CANVAS_CONTENT_KIND_INVALID')
  }
  return value
}

/** 将未知错误稳定转换为可诊断文本。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 仅识别可被回收区列表隔离的单项磁盘内容损坏。 */
function isIsolatedTrashItemError(error: unknown): boolean {
  return error instanceof CanvasContentItemError
}

/** 创建保留底层 scope/复验失败原因的提交未确认错误。 */
function contentCommitUnconfirmed(detail: string, cause: unknown): Error {
  return new Error(`CANVAS_CONTENT_COMMIT_UNCONFIRMED: ${detail}`, { cause })
}

/** 严格解析 JSON，语法错误统一按内容损坏处理。 */
function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content) as unknown
  } catch (error: unknown) {
    throw new CanvasContentItemError('CANVAS_CONTENT_CORRUPT', `${label}: ${errorText(error)}`)
  }
}

/** 严格解析图片配置并拒绝无界文本、未知字段和身份漂移。 */
function parseImageConfig(content: string): CanvasImageContentConfig {
  /** 图片配置的未知 JSON 值。 */
  const value = parseJson(content, 'config.json')
  /** 图片配置允许的完整字段集合。 */
  const v1Keys = [
    'schemaVersion', 'kind', 'contentId', 'revision', 'createdAt', 'updatedAt',
    'prompt', 'selectedModelProfileId', 'adoptedAssetId',
  ] as const
  const v2Keys = [...v1Keys, 'aspectRatio', 'imageSize', 'contextMode'] as const
  if (hasExactKeys(value, v2Keys)) return parseCanvasImageModuleConfig(value) as CanvasImageContentConfig
  if (!hasExactKeys(value, v1Keys)
    || typeof value.prompt !== 'string'
    || value.prompt.length > MAX_CONTENT_TEXT_LENGTH
    || (value.selectedModelProfileId !== null
      && (typeof value.selectedModelProfileId !== 'string'
        || !CONTENT_ID_PATTERN.test(value.selectedModelProfileId)))
    || (value.adoptedAssetId !== null
      && (typeof value.adoptedAssetId !== 'string' || !CONTENT_ID_PATTERN.test(value.adoptedAssetId)))) {
    throw new Error('CANVAS_CONTENT_CORRUPT: config.json')
  }
  /** 复用共享解析器校验公共身份和所有数值边界。 */
  const meta = parseCanvasNodeContentMeta({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    contentId: value.contentId,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  })
  if (meta.kind !== 'image') throw new Error('CANVAS_CONTENT_CORRUPT: config kind')
  return {
    ...meta,
    kind: 'image',
    prompt: value.prompt,
    selectedModelProfileId: value.selectedModelProfileId,
    adoptedAssetId: value.adoptedAssetId,
    aspectRatio: '1:1',
    imageSize: 'auto',
    contextMode: 'auto',
  }
}

/** 严格解析 Webview 元数据，同时保留有界 legacy 来源。 */
function parseWebviewMeta(content: string): CanvasWebviewContentMeta {
  /** Webview 元数据的未知 JSON 值。 */
  const value = parseJson(content, 'meta.json')
  /** Webview 元数据允许的完整字段集合。 */
  const keys = [
    'schemaVersion', 'kind', 'contentId', 'revision', 'createdAt', 'updatedAt', 'legacySourceUrl',
  ] as const
  if (!hasExactKeys(value, keys)
    || (value.legacySourceUrl !== null
      && (typeof value.legacySourceUrl !== 'string'
        || value.legacySourceUrl.length > MAX_LEGACY_SOURCE_URL_LENGTH))) {
    throw new Error('CANVAS_CONTENT_CORRUPT: webview meta.json')
  }
  /** 共享元数据解析结果。 */
  const meta = parseCanvasNodeContentMeta({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    contentId: value.contentId,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  })
  if (meta.kind !== 'webview') throw new Error('CANVAS_CONTENT_CORRUPT: webview kind')
  return { ...meta, kind: 'webview', legacySourceUrl: value.legacySourceUrl }
}

/**
 * 严格解析已提交内容目录的 meta.json，同时兼容 WebView 的合法扩展字段。
 * @param content 从受管内容目录读取的原始 JSON 正文。
 * @returns 经过 exact-key、身份和数值边界校验的内容元数据。
 */
export function parseCanvasNodeContentMetaContent(
  content: string,
): CanvasNodeContentMeta | CanvasWebviewContentMeta {
  /** WebView 必须始终走扩展解析，缺字段或未知字段都不能降级为基础元数据。 */
  const value = parseJson(content, 'meta.json')
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.get(value, 'kind') === 'webview') {
    return parseWebviewMeta(content)
  }
  return parseCanvasNodeContentMeta(value)
}

/** 比较公共内容身份，不把不同 kind 或 ID 当作可覆盖的重放。 */
function assertSameIdentity(
  meta: Pick<CanvasNodeContentMeta, 'kind' | 'contentId'>,
  expected: PrepareCanvasNodeContentInput,
): void {
  if (meta.kind !== expected.kind || meta.contentId !== expected.contentId) {
    throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
  }
}

/** 创建 Canvas 非 Agent 内容 Store。 */
export function createCanvasNodeContentStore(
  dependencies: CanvasNodeContentStoreDependencies,
): CanvasNodeContentStore & CanvasTextRevisionZeroReader {
  /** Native helper 调用边界。 */
  const runNative = dependencies.runStableDirectoryNative ?? runStableDirectoryNative
  /** 有限时间来源。 */
  const now = dependencies.now ?? Date.now

  /** 从同一次 LOAD 派生本次操作需要的 nodes/trash capability。 */
  const loadScopes = (target: CanvasTarget, includeTrash = false): CanvasContentScopes => {
    /** 同一次权威 LOAD 与目录身份。 */
    const loaded = dependencies.store.loadWithDirectoryCapability(target)
    /** nodes 目录 capability。 */
    const nodes = loaded.openSingleChildDirectory('nodes')
    /** trash 目录 capability，仅移动和列表需要。 */
    const trash = includeTrash ? loaded.openSingleChildDirectory('trash') : undefined
    nodes.assertValid()
    trash?.assertValid()
    return { nodes, ...(trash ? { trash } : {}) }
  }

  /** 使用受限相对协议读取固定文件。 */
  const readFile = async (
    capability: CanvasTrustedDirectoryCapability,
    childName: 'nodes' | 'trash',
    entryId: string,
    fileName: 'config.json' | 'meta.json' | 'content.md' | 'index.html' | 'entry.json',
  ): Promise<string | null> => {
    capability.assertValid()
    /** helper 的无路径读取结果。 */
    const result = await runNative({
      mode: 'canvas-content-read',
      roots: [capability.rootPath],
      childName,
      entryId,
      fileName,
    }, capability.authorizeOpenedRoots)
    capability.assertValid()
    if (!result.readOutcome) throw new Error('CANVAS_CONTENT_PROTOCOL_INVALID: missing read outcome')
    if (result.readOutcome.status === 'missing') return null
    if (result.readOutcome.status === 'corrupt') {
      throw new CanvasContentItemError('CANVAS_CONTENT_CORRUPT', result.readOutcome.error)
    }
    if (result.readOutcome.content.length > MAX_CONTENT_TEXT_LENGTH) {
      throw new CanvasContentItemError('CANVAS_CONTENT_CORRUPT', 'text exceeds limit')
    }
    return result.readOutcome.content
  }

  /** 列出单个受限 scope 内最多 512 个稳定 entry ID。 */
  const listEntries = async (
    capability: CanvasTrustedDirectoryCapability,
    childName: 'nodes' | 'trash',
  ): Promise<string[]> => {
    capability.assertValid()
    /** helper 返回的无路径目录项。 */
    const result = await runNative({
      mode: 'canvas-content-list',
      roots: [capability.rootPath],
      childName,
      maxEntries: MAX_CONTENT_ENTRIES,
    }, capability.authorizeOpenedRoots)
    capability.assertValid()
    return result.entries
      .filter((entry) => entry.isDirectory && CONTENT_ID_PATTERN.test(entry.name))
      .slice(0, MAX_CONTENT_ENTRIES)
      .map((entry) => entry.name)
  }

  /** 将 helper 写提交三态映射为业务错误，并复验 capability。 */
  const confirmWrite = (
    capability: CanvasTrustedDirectoryCapability,
    outcome: StableDirectoryNativeWriteOutcome | undefined,
  ): Error | null => {
    if (!outcome) throw new Error('CANVAS_CONTENT_PROTOCOL_INVALID: missing write outcome')
    /** outcome 必须先于 post-assert 被保存，防止撤权覆盖已提交事实。 */
    const committedOutcome = outcome
    /** helper 返回后的 capability 复验错误。 */
    let scopeError: unknown
    try {
      capability.assertValid()
    } catch (error: unknown) {
      scopeError = error
    }
    if (!committedOutcome.commitVisible) {
      throw new Error(
        `CANVAS_CONTENT_WRITE_FAILED: ${committedOutcome.error ?? 'write not committed'}`,
        scopeError === undefined ? undefined : { cause: scopeError },
      )
    }
    if (committedOutcome.durabilityUncertain) {
      if (scopeError !== undefined) {
        throw contentCommitUnconfirmed('write visible but scope revalidation failed', scopeError)
      }
      return new Error(`CANVAS_CONTENT_DURABILITY_UNCERTAIN: ${committedOutcome.error}`)
    }
    if (scopeError !== undefined) throw scopeError
    return null
  }

  /** 通过 helper 原子写入或替换一个固定受管文件。 */
  const writeManagedFile = async (
    capability: CanvasTrustedDirectoryCapability,
    childName: 'nodes' | 'trash',
    entryId: string,
    fileName: 'config.json' | 'meta.json' | 'content.md' | 'index.html' | 'entry.json',
    content: string,
  ): Promise<void> => {
    /** helper 原子写结果。 */
    const result = await runNative({
      mode: 'canvas-content-write',
      roots: [capability.rootPath],
      childName,
      entryId,
      fileName,
      content,
      maxEntries: MAX_CONTENT_ENTRIES,
    }, capability.authorizeOpenedRoots)
    /** rename 后耐久性不确定时，复读失败不得覆盖已可见证据。 */
    const durabilityError = confirmWrite(capability, result.writeOutcome)
    if (durabilityError) {
      try {
        const committed = await readFile(capability, childName, entryId, fileName)
        if (committed !== content) {
          throw new Error('committed content does not match requested content')
        }
      } catch (error: unknown) {
        throw contentCommitUnconfirmed('write visible but content verification failed', error)
      }
      throw durabilityError
    }
  }

  /** 删除只包含 entry.json 的 trash tombstone；helper 会拒绝任何物理内容目录。 */
  const removeTrashMarker = async (
    capability: CanvasTrustedDirectoryCapability,
    entryId: string,
  ): Promise<void> => {
    const result = await runNative({
      mode: 'canvas-content-remove-marker',
      roots: [capability.rootPath],
      childName: 'trash',
      entryId,
      maxEntries: MAX_CONTENT_ENTRIES,
    }, capability.authorizeOpenedRoots)
    const durabilityError = confirmWrite(capability, result.writeOutcome)
    if (durabilityError) throw durabilityError
  }

  /** 幂等写固定文件；已有不同正文一律按身份冲突 fail closed。 */
  const ensureExactFile = async (
    capability: CanvasTrustedDirectoryCapability,
    childName: 'nodes' | 'trash',
    entryId: string,
    fileName: 'config.json' | 'meta.json' | 'content.md' | 'index.html' | 'entry.json',
    content: string,
  ): Promise<void> => {
    /** 写前已有正文。 */
    const existing = await readFile(capability, childName, entryId, fileName)
    if (existing !== null) {
      if (existing !== content) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      return
    }
    await writeManagedFile(capability, childName, entryId, fileName, content)
  }

  /** 读取并严格解析内容最终 meta；缺失返回 null 供部分写重放。 */
  const readMeta = async (
    capability: CanvasTrustedDirectoryCapability,
    childName: 'nodes' | 'trash',
    entryId: string,
  ): Promise<CanvasNodeContentMeta | CanvasWebviewContentMeta | null> => {
    /** 磁盘 meta 正文。 */
    const content = await readFile(capability, childName, entryId, 'meta.json')
    if (content === null) return null
    return parseCanvasNodeContentMetaContent(content)
  }

  /** 验证内容最终提交标记及其最小正文文件存在且身份一致。 */
  const assertContentInScope = async (
    capability: CanvasTrustedDirectoryCapability,
    childName: 'nodes' | 'trash',
    input: PrepareCanvasNodeContentInput,
    directoryEntryId = input.contentId,
  ): Promise<CanvasNodeContentMeta> => {
    /** 最终身份提交标记。 */
    const meta = await readMeta(capability, childName, directoryEntryId)
    if (!meta) throw new Error('CANVAS_CONTENT_NOT_FOUND')
    assertSameIdentity(meta, input)
    if (input.kind === 'image') {
      const configContent = await readFile(capability, childName, directoryEntryId, 'config.json')
      if (configContent === null) throw new Error('CANVAS_CONTENT_CORRUPT: missing config.json')
      const config = parseImageConfig(configContent)
      assertSameIdentity(config, input)
      if (config.revision !== meta.revision
        || config.createdAt !== meta.createdAt
        || config.updatedAt !== meta.updatedAt) {
        throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      }
    } else {
      const bodyName = input.kind === 'document' ? 'content.md' : 'index.html'
      if (await readFile(capability, childName, directoryEntryId, bodyName) === null) {
        throw new Error(`CANVAS_CONTENT_CORRUPT: missing ${bodyName}`)
      }
    }
    return {
      schemaVersion: 1,
      kind: meta.kind,
      contentId: meta.contentId,
      revision: meta.revision,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    }
  }

  /** 判断稳定 entry 目录是否真实存在，不能把 meta-last 缺失等同于目录缺失。 */
  const hasEntryDirectory = async (
    capability: CanvasTrustedDirectoryCapability,
    childName: 'nodes' | 'trash',
    entryId: string,
  ): Promise<boolean> => (await listEntries(capability, childName)).includes(entryId)

  /** 校验完整或 meta-last partial 目录确属本次内容身份，跨类型文件一律失败关闭。 */
  const assertPreparedDirectoryIdentity = async (
    capability: CanvasTrustedDirectoryCapability,
    childName: 'nodes' | 'trash',
    directoryEntryId: string,
    input: PrepareCanvasNodeContentInput,
  ): Promise<void> => {
    const meta = await readMeta(capability, childName, directoryEntryId)
    if (meta) {
      await assertContentInScope(capability, childName, input, directoryEntryId)
      return
    }
    /** meta-last 前仅允许出现当前类别唯一的主体文件。 */
    const [config, document, webview] = await Promise.all([
      readFile(capability, childName, directoryEntryId, 'config.json'),
      readFile(capability, childName, directoryEntryId, 'content.md'),
      readFile(capability, childName, directoryEntryId, 'index.html'),
    ])
    if (input.kind === 'image') {
      if (config === null || document !== null || webview !== null) {
        throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      }
      assertSameIdentity(parseImageConfig(config), input)
      return
    }
    if (input.kind === 'document') {
      if (document === null || document !== '' || config !== null || webview !== null) {
        throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      }
      return
    }
    if (webview === null || webview !== EMPTY_WEBVIEW_HTML || config !== null || document !== null) {
      throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
    }
  }

  /** 准备空白或 legacy 内容，meta.json 固定最后提交。 */
  const prepareContent = async (
    target: CanvasTarget,
    seed: CanvasPreparedContentSeed,
  ): Promise<void> => {
    /** 经过相对协议边界校验的内容身份。 */
    const kind = requireContentKind(seed.kind)
    const contentId = requireContentId(seed.contentId, 'contentId')
    /** 当前类别允许出现的 legacy seed 字段。 */
    const allowedSeedKeys = new Set<string>([
      'kind',
      'contentId',
      ...(kind === 'image' ? ['adoptedAssetId', 'selectedModelProfileId'] : []),
      ...(kind === 'webview' ? ['legacySourceUrl'] : []),
      'initialContent',
    ])
    if (Object.keys(seed).some((key) => !allowedSeedKeys.has(key))) {
      throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
    }
    if (seed.adoptedAssetId !== undefined) requireContentId(seed.adoptedAssetId, 'adoptedAssetId')
    if (seed.selectedModelProfileId !== undefined && seed.selectedModelProfileId !== null) {
      requireContentId(seed.selectedModelProfileId, 'selectedModelProfileId')
    }
    if (seed.legacySourceUrl !== undefined
      && (typeof seed.legacySourceUrl !== 'string'
        || seed.legacySourceUrl.length > MAX_LEGACY_SOURCE_URL_LENGTH)) {
      throw new Error('CANVAS_CONTENT_LEGACY_SOURCE_INVALID')
    }
    if (seed.initialContent !== undefined
      && (typeof seed.initialContent !== 'string'
        || seed.initialContent.length > MAX_CONTENT_TEXT_LENGTH)) {
      throw new Error('CANVAS_ARTIFACT_CONTENT_INVALID')
    }
    /** 新产物正文；空内容与 legacy 迁移沿用既有默认值。 */
    const initialContent = seed.initialContent
      ?? (kind === 'webview' ? EMPTY_WEBVIEW_HTML : '')
    /** 本操作唯一 LOAD 派生的 nodes capability。 */
    const { nodes } = loadScopes(target)
    /** 已提交 meta 用于幂等重放和冲突拒绝。 */
    const existingMeta = await readMeta(nodes, 'nodes', contentId)
    if (existingMeta) assertSameIdentity(existingMeta, { kind, contentId })
    if (existingMeta) {
      if (existingMeta.revision !== 0) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      if (kind === 'image') {
        /** 已提交图片必须完整存在，meta-last 之后禁止补写 config。 */
        const configContent = await readFile(nodes, 'nodes', contentId, 'config.json')
        if (configContent === null) {
          throw new CanvasContentItemError('CANVAS_CONTENT_CORRUPT', 'committed image missing config.json')
        }
        /** 已提交图片配置。 */
        const config = parseImageConfig(configContent)
        if (config.contentId !== contentId
          || config.revision !== 0
          || config.createdAt !== config.updatedAt
          || config.createdAt !== existingMeta.createdAt
          || config.updatedAt !== existingMeta.updatedAt
          || config.prompt !== initialContent
          || config.selectedModelProfileId !== (seed.selectedModelProfileId ?? null)
          || config.adoptedAssetId !== (seed.adoptedAssetId ?? null)) {
          throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
        }
        return
      }
      if (kind === 'document') {
        /** 已提交文档正文。 */
        const content = await readFile(nodes, 'nodes', contentId, 'content.md')
        if (content === null) {
          throw new CanvasContentItemError('CANVAS_CONTENT_CORRUPT', 'committed document missing content.md')
        }
        if (content !== initialContent) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
        return
      }
      /** 已提交 Webview 的 legacy 来源必须与本次 seed 一致。 */
      const existingSource = 'legacySourceUrl' in existingMeta ? existingMeta.legacySourceUrl : null
      if (existingSource !== (seed.legacySourceUrl ?? null)) {
        throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      }
      /** 已提交 Webview 正文。 */
      const html = await readFile(nodes, 'nodes', contentId, 'index.html')
      if (html === null) {
        throw new CanvasContentItemError('CANVAS_CONTENT_CORRUPT', 'committed webview missing index.html')
      }
      if (html !== initialContent) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      return
    }
    /** 新内容使用的有限时间戳。 */
    const timestamp = now()
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('CANVAS_CONTENT_TIME_INVALID')

    if (kind === 'image') {
      /** 已有部分图片配置决定重放必须沿用的初始时间。 */
      const existingConfigContent = await readFile(nodes, 'nodes', contentId, 'config.json')
      /** 空内容和 legacy 内容都显式固化 adoptedAssetId。 */
      const adoptedAssetId = seed.adoptedAssetId ?? null
      /** 图片配置；已有部分写入时复用其时间身份。 */
      const config = existingConfigContent === null
        ? {
            schemaVersion: 2 as const, kind: 'image' as const, contentId, revision: 0,
            createdAt: timestamp, updatedAt: timestamp, prompt: initialContent,
            selectedModelProfileId: seed.selectedModelProfileId ?? null, adoptedAssetId,
            aspectRatio: '1:1' as const, imageSize: 'auto' as const, contextMode: 'auto' as const,
          }
        : parseImageConfig(existingConfigContent)
      if (config.contentId !== contentId
        || config.revision !== 0
        || config.createdAt !== config.updatedAt
        || config.prompt !== initialContent
        || config.selectedModelProfileId !== (seed.selectedModelProfileId ?? null)
        || config.aspectRatio !== '1:1'
        || config.imageSize !== 'auto'
        || config.contextMode !== 'auto'
        || config.adoptedAssetId !== adoptedAssetId) {
        throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      }
      const configText = `${JSON.stringify(config, null, 2)}\n`
      if (existingConfigContent === null) {
        await ensureExactFile(nodes, 'nodes', contentId, 'config.json', configText)
      } else if (config.schemaVersion === 1) {
        /** 未提交 meta 的旧部分配置可在同一身份下安全升级为 v2。 */
        await writeManagedFile(nodes, 'nodes', contentId, 'config.json', configText)
      } else if (existingConfigContent !== configText && existingConfigContent !== JSON.stringify(config)) {
        throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      }
      /** 公共 meta 始终最后提交。 */
      const meta: CanvasNodeContentMeta = {
        schemaVersion: 1, kind, contentId, revision: 0,
        createdAt: config.createdAt, updatedAt: config.updatedAt,
      }
      const metaText = `${JSON.stringify(meta, null, 2)}\n`
      if (existingMeta) {
        if (JSON.stringify(existingMeta) !== JSON.stringify(meta)) {
          throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
        }
        return
      }
      await ensureExactFile(nodes, 'nodes', contentId, 'meta.json', metaText)
      return
    }

    /** 文档或 Webview 的公共 meta。 */
    const baseMeta: CanvasNodeContentMeta = existingMeta ?? {
      schemaVersion: 1, kind, contentId, revision: 0, createdAt: timestamp, updatedAt: timestamp,
    }
    if (baseMeta.revision !== 0) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
    if (kind === 'document') {
      if (seed.legacySourceUrl !== undefined || seed.adoptedAssetId !== undefined) {
        throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      }
      await ensureExactFile(nodes, 'nodes', contentId, 'content.md', initialContent)
      const metaText = `${JSON.stringify(baseMeta, null, 2)}\n`
      if (!existingMeta) await ensureExactFile(nodes, 'nodes', contentId, 'meta.json', metaText)
      return
    }
    if (seed.adoptedAssetId !== undefined) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
    await ensureExactFile(nodes, 'nodes', contentId, 'index.html', initialContent)
    /** Webview meta 固定显式记录 legacySourceUrl，空内容为 null。 */
    const webviewMeta: CanvasWebviewContentMeta = {
      ...baseMeta,
      kind: 'webview',
      legacySourceUrl: seed.legacySourceUrl ?? null,
    }
    await ensureExactFile(nodes, 'nodes', contentId, 'meta.json', `${JSON.stringify(webviewMeta, null, 2)}\n`)
  }

  /** 原子移动目录并返回 rename 后耐久性告警。 */
  const moveDirectory = async (
    source: CanvasTrustedDirectoryCapability,
    destination: CanvasTrustedDirectoryCapability,
    sourceChildName: 'nodes' | 'trash',
    sourceEntryId: string,
    destinationChildName: 'nodes' | 'trash',
    destinationEntryId: string,
  ): Promise<Error | null> => {
    source.assertValid()
    destination.assertValid()
    /** helper 相对目录 rename 结果。 */
    const result = await runNative({
      mode: 'canvas-content-move',
      roots: [source.rootPath],
      childName: sourceChildName,
      entryId: sourceEntryId,
      destinationChildName,
      destinationEntryId,
      maxEntries: MAX_CONTENT_ENTRIES,
    }, source.authorizeOpenedRoots)
    if (!result.moveOutcome) throw new Error('CANVAS_CONTENT_PROTOCOL_INVALID: missing move outcome')
    /** outcome 必须先于 post-assert 被保存，防止撤权覆盖 rename 事实。 */
    const committedOutcome = result.moveOutcome
    /** move 后任一 capability 的复验错误。 */
    let scopeError: unknown
    try {
      source.assertValid()
      destination.assertValid()
    } catch (error: unknown) {
      scopeError = error
    }
    if (!committedOutcome.commitVisible) {
      throw new Error(
        `CANVAS_CONTENT_MOVE_FAILED: ${committedOutcome.error ?? 'move not committed'}`,
        scopeError === undefined ? undefined : { cause: scopeError },
      )
    }
    if (committedOutcome.durabilityUncertain) {
      if (scopeError !== undefined) {
        throw contentCommitUnconfirmed('move visible but scope revalidation failed', scopeError)
      }
      return new Error(`CANVAS_CONTENT_DURABILITY_UNCERTAIN: ${committedOutcome.error}`)
    }
    if (scopeError !== undefined) throw scopeError
    return null
  }

  /** entry.json 内部状态；公开 API 仍只暴露 CanvasTrashEntry。 */
  interface CanvasTrashMarkerState {
    pending: CanvasTrashEntry[]
    restored: CanvasTrashEntry[]
    legacySingular: boolean
    /** 物理内容目录当前所在的受限子目录。 */
    contentLocation: 'nodes' | 'trash'
    /** 物理内容目录在对应子目录中的 entry ID。 */
    physicalEntryId: string
  }

  /** 校验同一物理内容目录内的 marker 身份和唯一性。 */
  const validateTrashMarker = (marker: CanvasTrashMarkerState): CanvasTrashMarkerState => {
    const entries = [...marker.pending, ...marker.restored]
    if (!CONTENT_ID_PATTERN.test(marker.physicalEntryId)
      || new Set(entries.map((entry) => entry.trashId)).size !== entries.length
      || entries.some((entry) => entry.kind !== entries[0]?.kind || entry.contentId !== entries[0]?.contentId)) {
      throw new CanvasContentItemError('CANVAS_TRASH_ENTRY_INVALID', 'entry.json marker contract invalid')
    }
    return marker
  }

  /** 严格读取 entry.json；兼容旧 singular 与 grouped array marker。 */
  const readTrashMarker = async (
    capability: CanvasTrustedDirectoryCapability,
    childName: 'nodes' | 'trash',
    entryId: string,
  ): Promise<CanvasTrashMarkerState | null> => {
    const content = await readFile(capability, childName, entryId, 'entry.json')
    if (content === null) return null
    /** 未知 JSON 条目，解析失败会保留可辨识的单项错误类型。 */
    const value = parseJson(content, 'entry.json')
    try {
      if (hasExactKeys(value, ['schemaVersion', 'contentLocation', 'physicalEntryId', 'pending', 'restored'])
        && value.schemaVersion === 1
        && (value.contentLocation === 'nodes' || value.contentLocation === 'trash')
        && typeof value.physicalEntryId === 'string'
        && Array.isArray(value.pending)
        && Array.isArray(value.restored)) {
        return validateTrashMarker({
          pending: value.pending.map(parseCanvasTrashEntry),
          restored: value.restored.map(parseCanvasTrashEntry),
          legacySingular: false,
          contentLocation: value.contentLocation,
          physicalEntryId: value.physicalEntryId,
        })
      }
      if (hasExactKeys(value, ['schemaVersion', 'pending', 'restored'])
        && value.schemaVersion === 1 && Array.isArray(value.pending) && Array.isArray(value.restored)) {
        return validateTrashMarker({
          pending: value.pending.map(parseCanvasTrashEntry),
          restored: value.restored.map(parseCanvasTrashEntry),
          legacySingular: false,
          contentLocation: childName,
          physicalEntryId: entryId,
        })
      }
      if (Array.isArray(value)) {
        return validateTrashMarker({
          pending: value.map(parseCanvasTrashEntry),
          restored: [],
          legacySingular: false,
          contentLocation: childName,
          physicalEntryId: entryId,
        })
      }
      const entry = parseCanvasTrashEntry(value)
      return validateTrashMarker({
        pending: childName === 'trash' ? [entry] : [],
        restored: childName === 'nodes' ? [entry] : [],
        legacySingular: true,
        contentLocation: childName,
        physicalEntryId: entryId,
      })
    } catch (error: unknown) {
      if (error instanceof CanvasContentItemError) throw error
      if (error instanceof Error && error.message === 'CANVAS_TRASH_ENTRY_INVALID') {
        throw new CanvasContentItemError('CANVAS_TRASH_ENTRY_INVALID', 'entry.json contract invalid')
      }
      throw error
    }
  }

  /** 判断两个回收 marker 是否为完全相同的删除事实。 */
  const isSameTrashEntry = (left: CanvasTrashEntry, right: CanvasTrashEntry): boolean => (
    left.schemaVersion === right.schemaVersion
    && left.trashId === right.trashId
    && left.nodeId === right.nodeId
    && left.kind === right.kind
    && left.contentId === right.contentId
    && left.title === right.title
    && left.position.x === right.position.x
    && left.position.y === right.position.y
    && left.deletedRevision === right.deletedRevision
    && left.deletedAt === right.deletedAt
    && (left.kind !== 'image' || right.kind !== 'image' || left.adoptedAssetId === right.adoptedAssetId)
    && (left.kind === 'image' || right.kind === 'image' || left.contentRevision === right.contentRevision)
    && (left.kind !== 'webview' || right.kind !== 'webview' || left.devicePreset === right.devicePreset)
  )

  /** 把 marker 原子写入指定物理目录；简单待恢复状态继续沿用旧格式。 */
  const writeTrashMarker = async (
    capability: CanvasTrustedDirectoryCapability,
    childName: 'nodes' | 'trash',
    trashId: string,
    marker: CanvasTrashMarkerState,
  ): Promise<void> => {
    const normalized = validateTrashMarker({ ...marker, legacySingular: false })
    const canUseLegacyFormat = normalized.contentLocation === childName
      && normalized.physicalEntryId === trashId
      && normalized.restored.length === 0
    const value = canUseLegacyFormat && normalized.pending.length === 1
      ? normalized.pending[0]
      : canUseLegacyFormat && normalized.pending.length > 1
        ? normalized.pending
        : {
            schemaVersion: 1,
            contentLocation: normalized.contentLocation,
            physicalEntryId: normalized.physicalEntryId,
            pending: normalized.pending,
            restored: normalized.restored,
          }
    await writeManagedFile(
      capability,
      childName,
      trashId,
      'entry.json',
      `${JSON.stringify(value, null, 2)}\n`,
    )
  }

  /** 合并新删除快照，保留同一内容目录内仍待恢复和已恢复的崩溃证据。 */
  const commitTrashMarkers = async (
    capability: CanvasTrustedDirectoryCapability,
    markerId: string,
    entries: CanvasTrashEntry[],
    contentLocation: 'nodes' | 'trash',
    physicalEntryId: string,
    movedSourceMarker?: CanvasTrashMarkerState | null,
  ): Promise<void> => {
    const current = movedSourceMarker ?? await readTrashMarker(capability, 'trash', markerId)
    const pending = [...(current?.pending ?? [])]
    const restored = [...(current?.restored ?? [])]
    for (const entry of entries) {
      const existing = [...pending, ...restored].find((candidate) => candidate.trashId === entry.trashId)
      if (existing) {
        if (!isSameTrashEntry(existing, entry)) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
        continue
      }
      pending.push(entry)
    }
    await writeTrashMarker(capability, 'trash', markerId, {
      pending,
      restored,
      legacySingular: false,
      contentLocation,
      physicalEntryId,
    })
  }

  /** 单条恢复把 marker 从 pending 迁移到 restored。 */
  const transitionTrashEntryToRestored = (
    marker: CanvasTrashMarkerState,
    trashId: string,
    contentLocation: 'nodes' | 'trash',
    physicalEntryId: string,
  ): { entry: CanvasTrashEntry; marker: CanvasTrashMarkerState } => {
    const restoredEntry = marker.restored.find((entry) => entry.trashId === trashId)
    if (restoredEntry) {
      return {
        entry: restoredEntry,
        marker: { ...marker, contentLocation, physicalEntryId, legacySingular: false },
      }
    }
    const entry = marker.pending.find((candidate) => candidate.trashId === trashId)
    if (!entry) throw new Error('CANVAS_TRASH_ENTRY_NOT_FOUND')
    /** 同一节点的新恢复事实替换旧事实，再对跨节点历史施加固定上限。 */
    const restored = [...marker.restored.filter((candidate) => candidate.nodeId !== entry.nodeId), entry]
      .slice(-MAX_RESTORED_TRASH_ENTRIES)
    return {
      entry,
      marker: {
        pending: marker.pending.filter((candidate) => candidate.trashId !== trashId),
        restored,
        legacySingular: false,
        contentLocation,
        physicalEntryId,
      },
    }
  }

  /** 在 uncertain move 后执行复验，失败时保留 move 已可见但未确认的主错误。 */
  const verifyAfterMove = async (
    durabilityError: Error | null,
    verify: () => Promise<void>,
  ): Promise<void> => {
    try {
      await verify()
    } catch (error: unknown) {
      if (durabilityError) {
        throw contentCommitUnconfirmed('move visible but follow-up verification failed', error)
      }
      throw error
    }
    if (durabilityError) throw durabilityError
  }

  /** 在已恢复 nodes 中按 trashId 找到幂等重放条目。 */
  const findNodeTrashEntry = async (
    nodes: CanvasTrustedDirectoryCapability,
    trashId: string,
  ): Promise<{ entry: CanvasTrashEntry; marker: CanvasTrashMarkerState } | null> => {
    const contentIds = await listEntries(nodes, 'nodes')
    for (const contentId of contentIds) {
      try {
        const marker = await readTrashMarker(nodes, 'nodes', contentId)
        const pendingEntry = marker?.pending.find((candidate) => candidate.trashId === trashId && candidate.contentId === contentId)
        if (pendingEntry && marker) return { entry: pendingEntry, marker }
        const restoredEntry = marker?.restored.find((candidate) => candidate.trashId === trashId && candidate.contentId === contentId)
        if (restoredEntry && marker) return { entry: restoredEntry, marker }
      } catch (error: unknown) {
        /** 只隔离其它节点自身损坏，授权和 helper 故障必须原样传播。 */
        if (!isIsolatedTrashItemError(error)) throw error
      }
    }
    return null
  }

  /** 在回收区定位请求 trashId；目录名只属于同组第一条物理资源。 */
  const findTrashedEntry = async (
    trash: CanvasTrustedDirectoryCapability,
    trashId: string,
  ): Promise<{ entry: CanvasTrashEntry; markerId: string; marker: CanvasTrashMarkerState } | null> => {
    /** 常规单条回收先尝试同名目录，避免额外扫描。 */
    const directMarker = await readTrashMarker(trash, 'trash', trashId)
    const directEntry = directMarker
      ? [...directMarker.pending, ...directMarker.restored].find((entry) => entry.trashId === trashId)
      : undefined
    if (directEntry && directMarker) return { entry: directEntry, markerId: trashId, marker: directMarker }
    const physicalTrashIds = await listEntries(trash, 'trash')
    for (const physicalTrashId of physicalTrashIds) {
      if (physicalTrashId === trashId) continue
      try {
        const marker = await readTrashMarker(trash, 'trash', physicalTrashId)
        const entry = marker
          ? [...marker.pending, ...marker.restored].find((candidate) => candidate.trashId === trashId)
          : undefined
        if (entry && marker) return { entry, markerId: physicalTrashId, marker }
      } catch (error: unknown) {
        if (!isIsolatedTrashItemError(error)) throw error
      }
    }
    return null
  }

  /** 在 trash 侧查找同一内容的权威 marker；恢复后的 tombstone 优先于物理目录副本。 */
  const findContentTrashMarker = async (
    trash: CanvasTrustedDirectoryCapability,
    expected: Pick<CanvasTrashEntry, 'kind' | 'contentId'>,
  ): Promise<{ markerId: string; marker: CanvasTrashMarkerState } | null> => {
    const markerIds = await listEntries(trash, 'trash')
    let fallback: { markerId: string; marker: CanvasTrashMarkerState } | null = null
    for (const markerId of markerIds) {
      try {
        const marker = await readTrashMarker(trash, 'trash', markerId)
        const entries = marker ? [...marker.pending, ...marker.restored] : []
        if (!marker || !entries.some((entry) => entry.kind === expected.kind && entry.contentId === expected.contentId)) {
          continue
        }
        const candidate = { markerId, marker }
        /** tombstone 与物理目录分离时，它才是跨 move 保持稳定的权威副本。 */
        if (markerId !== marker.physicalEntryId || marker.contentLocation === 'nodes') return candidate
        fallback ??= candidate
      } catch (error: unknown) {
        if (!isIsolatedTrashItemError(error)) throw error
      }
    }
    return fallback
  }

  /** 多个节点共享一个 contentId 时只移动一次目录，并原子写入全部节点快照。 */
  const moveEntriesToTrash = async (
    target: CanvasTarget,
    rawEntries: readonly CanvasTrashEntry[],
  ): Promise<void> => {
    const entries = rawEntries.map((entry) => parseCanvasTrashEntry(entry))
    if (entries.length === 0
      || new Set(entries.map((entry) => entry.trashId)).size !== entries.length
      || new Set(entries.map((entry) => entry.nodeId)).size !== entries.length
      || entries.some((entry) => entry.kind !== entries[0]!.kind || entry.contentId !== entries[0]!.contentId)) {
      throw new Error('CANVAS_TRASH_ENTRY_INVALID')
    }
    const primaryEntry = entries[0]!
    const scopes = loadScopes(target, true)
    const trash = scopes.trash!
    /** 已恢复共享内容可能已有稳定的 trash 侧 tombstone。 */
    const canonical = await findContentTrashMarker(trash, primaryEntry)
    const sourceMeta = await readMeta(scopes.nodes, 'nodes', primaryEntry.contentId)
    const targetMeta = await readMeta(trash, 'trash', primaryEntry.trashId)
    /** move 前捕获 nodes marker，避免目录改名后把旧 singular 的 restored 语义误判为 pending。 */
    let sourceMarker: CanvasTrashMarkerState | null = canonical?.marker ?? null
    let durabilityError: Error | null = null
    if (sourceMeta) {
      assertSameIdentity(sourceMeta, primaryEntry)
      if (targetMeta) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      await assertContentInScope(scopes.nodes, 'nodes', primaryEntry)
      const nodeMarker = await readTrashMarker(scopes.nodes, 'nodes', primaryEntry.contentId)
      sourceMarker ??= nodeMarker
      const sourceEntries = sourceMarker ? [...sourceMarker.pending, ...sourceMarker.restored] : []
      if (sourceEntries.some((entry) => entry.kind !== primaryEntry.kind || entry.contentId !== primaryEntry.contentId)
        || (sourceMarker?.legacySingular && sourceEntries.some((entry) => entry.nodeId !== primaryEntry.nodeId))) {
        throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      }
      if (sourceMarker) {
        /** move 前写入不公开新删除项的恢复 marker，供 marker 提交失败后的重放收敛。 */
        await writeTrashMarker(scopes.nodes, 'nodes', primaryEntry.contentId, {
          ...sourceMarker,
          legacySingular: false,
          contentLocation: 'trash',
          physicalEntryId: primaryEntry.trashId,
        })
      }
      durabilityError = await moveDirectory(
        scopes.nodes, trash, 'nodes', primaryEntry.contentId, 'trash', primaryEntry.trashId,
      )
    } else {
      if (!targetMeta) throw new Error('CANVAS_CONTENT_NOT_FOUND')
      assertSameIdentity(targetMeta, primaryEntry)
    }
    await verifyAfterMove(durabilityError, async () => {
      await assertContentInScope(trash, 'trash', primaryEntry, primaryEntry.trashId)
      const markerId = canonical?.markerId ?? primaryEntry.trashId
      await commitTrashMarkers(
        trash,
        markerId,
        entries,
        'trash',
        primaryEntry.trashId,
        sourceMarker,
      )
      if (markerId !== primaryEntry.trashId) {
        /** 物理目录只保留空副本，避免 listTrash 重复公开 canonical pending。 */
        await writeTrashMarker(trash, 'trash', primaryEntry.trashId, {
          pending: [],
          restored: [],
          legacySingular: false,
          contentLocation: 'trash',
          physicalEntryId: primaryEntry.trashId,
        })
      }
    })
  }

  return {
    prepareEmptyContent: (target, input) => prepareContent(target, {
      kind: requireContentKind(input.kind),
      contentId: requireContentId(input.contentId, 'contentId'),
      ...(input.kind === 'image'
        ? { selectedModelProfileId: input.selectedModelProfileId ?? null }
        : {}),
    }),
    prepareArtifactContent: (target, input) => prepareContent(target, {
      kind: input.kind,
      contentId: requireContentId(input.contentId, 'contentId'),
      initialContent: input.content,
      ...(input.kind === 'image'
        ? { selectedModelProfileId: input.selectedModelProfileId ?? null }
        : {}),
    }),
    prepareMigratedContent: prepareContent,
    assertContent: async (target, input) => {
      const kind = requireContentKind(input.kind)
      const contentId = requireContentId(input.contentId, 'contentId')
      const { nodes } = loadScopes(target)
      return assertContentInScope(nodes, 'nodes', { kind, contentId })
    },
    readTextRevisionZero: async (target, input) => {
      /** revision 0 只允许两类文本产物，图片继续由既有素材事实源管理。 */
      const kind = input.kind
      /** 受管内容 ID 必须先通过既有安全字符边界。 */
      const contentId = requireContentId(input.contentId, 'contentId')
      /** 同一次权威 LOAD 派生的 nodes capability。 */
      const { nodes } = loadScopes(target)
      /** 最终 meta 用于证明目录属于请求身份且仍是 revision 0。 */
      const meta = await assertContentInScope(nodes, 'nodes', { kind, contentId })
      if (meta.revision !== 0) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      /** 正文文件名由类别固定，不接受调用方传入路径或文件名。 */
      const fileName = kind === 'document' ? 'content.md' : 'index.html'
      /** 已通过 meta 校验的 revision 0 正文。 */
      const content = await readFile(nodes, 'nodes', contentId, fileName)
      if (content === null) {
        throw new CanvasContentItemError('CANVAS_CONTENT_CORRUPT', `${fileName} missing`)
      }
      return { meta, content }
    },
    discardPreparedContent: async (target, input, rawRollbackId) => {
      const kind = requireContentKind(input.kind)
      const contentId = requireContentId(input.contentId, 'contentId')
      const rollbackId = requireContentId(rawRollbackId, 'rollbackId')
      const scopes = loadScopes(target, true)
      const trash = scopes.trash!
      const identity = { kind, contentId }
      const [sourceExists, rollbackExists] = await Promise.all([
        hasEntryDirectory(scopes.nodes, 'nodes', contentId),
        hasEntryDirectory(trash, 'trash', rollbackId),
      ])
      if (!sourceExists) {
        /** 两端真缺失表示 prepare 尚未形成目录；精确 rollback 已存在则验证后幂等成功。 */
        if (!rollbackExists) return
        await assertPreparedDirectoryIdentity(trash, 'trash', rollbackId, identity)
        return
      }
      if (rollbackExists) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      await assertPreparedDirectoryIdentity(scopes.nodes, 'nodes', contentId, identity)
      const durabilityError = await moveDirectory(
        scopes.nodes, trash, 'nodes', contentId, 'trash', rollbackId,
      )
      if (durabilityError) {
        try {
          await assertPreparedDirectoryIdentity(trash, 'trash', rollbackId, identity)
        } catch {
          throw contentCommitUnconfirmed('discard visible but verification failed', durabilityError)
        }
        throw durabilityError
      }
    },
    moveToTrash: (target, entry) => moveEntriesToTrash(target, [entry]),
    moveManyToTrash: moveEntriesToTrash,
    restoreFromTrash: async (target, rawTrashId) => {
      const trashId = requireContentId(rawTrashId, 'trashId')
      /** nodes/trash 必须来自同一次 LOAD。 */
      const scopes = loadScopes(target, true)
      const trash = scopes.trash!
      /** trash 内的权威条目可能位于共享内容组的主目录。 */
      const trashed = await findTrashedEntry(trash, trashId)
      if (!trashed) {
        const nodeEntry = await findNodeTrashEntry(scopes.nodes, trashId)
        if (!nodeEntry) throw new Error('CANVAS_TRASH_ENTRY_NOT_FOUND')
        await assertContentInScope(scopes.nodes, 'nodes', nodeEntry.entry)
        const transitioned = transitionTrashEntryToRestored(
          nodeEntry.marker,
          trashId,
          'nodes',
          nodeEntry.entry.contentId,
        )
        if (transitioned.marker.pending.length > 0) {
          /** 兼容上一版 move 后仅在 nodes 留 marker 的中间态。 */
          const markerId = [...nodeEntry.marker.pending, ...nodeEntry.marker.restored][0]!.trashId
          await writeTrashMarker(trash, 'trash', markerId, transitioned.marker)
        }
        await writeTrashMarker(
          scopes.nodes,
          'nodes',
          nodeEntry.entry.contentId,
          transitioned.marker,
        )
        return transitioned.entry
      }
      const { entry, markerId, marker } = trashed
      if (marker.contentLocation === 'nodes') {
        await assertContentInScope(scopes.nodes, 'nodes', entry, marker.physicalEntryId)
        const transitioned = transitionTrashEntryToRestored(marker, trashId, 'nodes', entry.contentId)
        /** nodes marker 是内容已恢复后的权威幂等事实。 */
        const nodeMarker = await readTrashMarker(scopes.nodes, 'nodes', entry.contentId)
        const alreadyRestored = nodeMarker?.restored.find((candidate) => candidate.trashId === trashId)
        if (!alreadyRestored) {
          /** 必须先提交 nodes 恢复事实，随后才允许清理最后一个 trash tombstone。 */
          await writeTrashMarker(scopes.nodes, 'nodes', entry.contentId, transitioned.marker)
        }
        if (transitioned.marker.pending.length > 0) {
          await writeTrashMarker(trash, 'trash', markerId, transitioned.marker)
        } else {
          await removeTrashMarker(trash, markerId)
        }
        return alreadyRestored ?? transitioned.entry
      }
      await assertContentInScope(trash, 'trash', entry, marker.physicalEntryId)
      const destinationMeta = await readMeta(scopes.nodes, 'nodes', entry.contentId)
      if (destinationMeta) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      const durabilityError = await moveDirectory(
        trash, scopes.nodes, 'trash', marker.physicalEntryId, 'nodes', entry.contentId,
      )
      const transitioned = transitionTrashEntryToRestored(marker, trashId, 'nodes', entry.contentId)
      await verifyAfterMove(durabilityError, async () => {
        await assertContentInScope(scopes.nodes, 'nodes', entry)
        /** 共享内容或独立 tombstone 必须留在 trash，供列表和后续恢复直接读取。 */
        if (transitioned.marker.pending.length > 0 || markerId !== marker.physicalEntryId) {
          await writeTrashMarker(trash, 'trash', markerId, transitioned.marker)
        }
        await writeTrashMarker(scopes.nodes, 'nodes', entry.contentId, transitioned.marker)
      })
      return transitioned.entry
    },
    listTrash: async (target) => {
      const scopes = loadScopes(target, true)
      const trash = scopes.trash!
      /** native helper 已确定性返回最多 512 个安全 entry ID。 */
      const trashIds = await listEntries(trash, 'trash')
      /** 单项解析失败会被隔离。 */
      const entries = new Map<string, CanvasTrashEntry>()
      for (const trashId of trashIds) {
        try {
          const marker = await readTrashMarker(trash, 'trash', trashId)
          if (marker) {
            for (const entry of marker.pending) entries.set(entry.trashId, entry)
          }
        } catch (error: unknown) {
          /** 只隔离损坏单项，授权和 helper 基础设施错误必须原样传播。 */
          if (!isIsolatedTrashItemError(error)) throw error
        }
      }
      return [...entries.values()].sort((left, right) => (
        right.deletedAt - left.deletedAt || left.trashId.localeCompare(right.trashId)
      )).slice(0, MAX_CONTENT_ENTRIES)
    },
  }
}
