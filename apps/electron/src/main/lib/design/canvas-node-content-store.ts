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

/** Canvas 非 Agent 节点内容与回收区的窄业务接口。 */
export interface CanvasNodeContentStore {
  prepareEmptyContent: (target: CanvasTarget, input: PrepareCanvasNodeContentInput) => Promise<void>
  prepareMigratedContent: (target: CanvasTarget, seed: LegacyCanvasContentSeed) => Promise<void>
  assertContent: (target: CanvasTarget, input: PrepareCanvasNodeContentInput) => Promise<CanvasNodeContentMeta>
  /** 把未进入图提交的本轮新内容移出 active nodes，且不暴露为可恢复回收项。 */
  discardPreparedContent: (
    target: CanvasTarget,
    input: PrepareCanvasNodeContentInput,
    rollbackId: string,
  ) => Promise<void>
  moveToTrash: (target: CanvasTarget, entry: CanvasTrashEntry) => Promise<void>
  restoreFromTrash: (target: CanvasTarget, trashId: string) => Promise<CanvasTrashEntry>
  listTrash: (target: CanvasTarget) => Promise<CanvasTrashEntry[]>
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
interface CanvasWebviewContentMeta extends CanvasNodeContentMeta {
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
): CanvasNodeContentStore {
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
    /** Webview meta 的唯一扩展字段需在内部严格解析。 */
    const raw = parseJson(content, 'meta.json')
    return hasExactKeys(raw, [
      'schemaVersion', 'kind', 'contentId', 'revision', 'createdAt', 'updatedAt', 'legacySourceUrl',
    ]) ? parseWebviewMeta(content) : parseCanvasNodeContentMeta(raw)
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

  /** 准备空白或 legacy 内容，meta.json 固定最后提交。 */
  const prepareContent = async (
    target: CanvasTarget,
    seed: LegacyCanvasContentSeed,
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
          || config.prompt !== ''
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
        if (content !== '') throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
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
      if (html !== EMPTY_WEBVIEW_HTML) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
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
            createdAt: timestamp, updatedAt: timestamp, prompt: '',
            selectedModelProfileId: seed.selectedModelProfileId ?? null, adoptedAssetId,
            aspectRatio: '1:1' as const, imageSize: 'auto' as const, contextMode: 'auto' as const,
          }
        : parseImageConfig(existingConfigContent)
      if (config.contentId !== contentId
        || config.revision !== 0
        || config.createdAt !== config.updatedAt
        || config.prompt !== ''
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
      await ensureExactFile(nodes, 'nodes', contentId, 'content.md', '')
      const metaText = `${JSON.stringify(baseMeta, null, 2)}\n`
      if (!existingMeta) await ensureExactFile(nodes, 'nodes', contentId, 'meta.json', metaText)
      return
    }
    if (seed.adoptedAssetId !== undefined) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
    await ensureExactFile(nodes, 'nodes', contentId, 'index.html', EMPTY_WEBVIEW_HTML)
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

  /** 严格读取 entry.json；缺失返回 null。 */
  const readTrashEntry = async (
    capability: CanvasTrustedDirectoryCapability,
    childName: 'nodes' | 'trash',
    entryId: string,
  ): Promise<CanvasTrashEntry | null> => {
    const content = await readFile(capability, childName, entryId, 'entry.json')
    if (content === null) return null
    /** 未知 JSON 条目，解析失败会保留可辨识的单项错误类型。 */
    const value = parseJson(content, 'entry.json')
    try {
      return parseCanvasTrashEntry(value)
    } catch (error: unknown) {
      if (error instanceof CanvasContentItemError) throw error
      if (error instanceof Error && error.message === 'CANVAS_TRASH_ENTRY_INVALID') {
        throw new CanvasContentItemError('CANVAS_TRASH_ENTRY_INVALID', 'entry.json contract invalid')
      }
      throw error
    }
  }

  /** 判断两个回收 marker 是否属于同一节点内容身份。 */
  const isSameTrashOwner = (left: CanvasTrashEntry, right: CanvasTrashEntry): boolean => (
    left.nodeId === right.nodeId
    && left.kind === right.kind
    && left.contentId === right.contentId
  )

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
  )

  /** 写入本次 marker；同 owner 的历史 marker 可原子替换，其它事实 fail closed。 */
  const commitTrashMarker = async (
    capability: CanvasTrustedDirectoryCapability,
    trashId: string,
    entry: CanvasTrashEntry,
  ): Promise<void> => {
    /** move 后目标内当前 marker，可能来自上一次恢复。 */
    const current = await readTrashEntry(capability, 'trash', trashId)
    if (current) {
      if (isSameTrashEntry(current, entry)) return
      if (!isSameTrashOwner(current, entry)) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
    }
    await writeManagedFile(
      capability,
      'trash',
      trashId,
      'entry.json',
      `${JSON.stringify(entry, null, 2)}\n`,
    )
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
  const findRestoredEntry = async (
    nodes: CanvasTrustedDirectoryCapability,
    trashId: string,
  ): Promise<CanvasTrashEntry | null> => {
    const contentIds = await listEntries(nodes, 'nodes')
    for (const contentId of contentIds) {
      try {
        const entry = await readTrashEntry(nodes, 'nodes', contentId)
        if (entry?.trashId === trashId && entry.contentId === contentId) return entry
      } catch (error: unknown) {
        /** 只隔离其它节点自身损坏，授权和 helper 故障必须原样传播。 */
        if (!isIsolatedTrashItemError(error)) throw error
      }
    }
    return null
  }

  return {
    prepareEmptyContent: (target, input) => prepareContent(target, {
      kind: requireContentKind(input.kind),
      contentId: requireContentId(input.contentId, 'contentId'),
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
    discardPreparedContent: async (target, input, rawRollbackId) => {
      const kind = requireContentKind(input.kind)
      const contentId = requireContentId(input.contentId, 'contentId')
      const rollbackId = requireContentId(rawRollbackId, 'rollbackId')
      const scopes = loadScopes(target, true)
      const trash = scopes.trash!
      const sourceMeta = await readMeta(scopes.nodes, 'nodes', contentId)
      if (!sourceMeta) {
        const existingRollback = await readMeta(trash, 'trash', rollbackId)
        /** prepare 在创建前失败时两端都缺失，精确 rollback 可幂等视为已清理。 */
        if (!existingRollback) return
        if (existingRollback.kind !== kind || existingRollback.contentId !== contentId) {
          throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
        }
        return
      }
      if (sourceMeta.kind !== kind || sourceMeta.contentId !== contentId) {
        throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      }
      const durabilityError = await moveDirectory(
        scopes.nodes, trash, 'nodes', contentId, 'trash', rollbackId,
      )
      if (durabilityError) {
        const moved = await readMeta(trash, 'trash', rollbackId)
        if (!moved || moved.kind !== kind || moved.contentId !== contentId) {
          throw contentCommitUnconfirmed('discard visible but verification failed', durabilityError)
        }
        throw durabilityError
      }
    },
    moveToTrash: async (target, rawEntry) => {
      /** 严格克隆后的 Renderer 可见条目。 */
      const entry = parseCanvasTrashEntry(rawEntry)
      /** nodes/trash 必须来自同一次 LOAD。 */
      const scopes = loadScopes(target, true)
      const trash = scopes.trash!
      /** 源和目标最终身份。 */
      const sourceMeta = await readMeta(scopes.nodes, 'nodes', entry.contentId)
      const targetMeta = await readMeta(trash, 'trash', entry.trashId)
      let durabilityError: Error | null = null
      if (sourceMeta) {
        assertSameIdentity(sourceMeta, entry)
        if (targetMeta) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
        await assertContentInScope(scopes.nodes, 'nodes', entry)
        /** 恢复后遗留在 nodes 的 marker 必须在 move 前验证 owner。 */
        const sourceMarker = await readTrashEntry(scopes.nodes, 'nodes', entry.contentId)
        if (sourceMarker && !isSameTrashOwner(sourceMarker, entry)) {
          throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
        }
        durabilityError = await moveDirectory(
          scopes.nodes, trash, 'nodes', entry.contentId, 'trash', entry.trashId,
        )
      } else {
        if (!targetMeta) throw new Error('CANVAS_CONTENT_NOT_FOUND')
        assertSameIdentity(targetMeta, entry)
      }
      await verifyAfterMove(durabilityError, async () => {
        await assertContentInScope(trash, 'trash', entry, entry.trashId)
        await commitTrashMarker(trash, entry.trashId, entry)
      })
    },
    restoreFromTrash: async (target, rawTrashId) => {
      const trashId = requireContentId(rawTrashId, 'trashId')
      /** nodes/trash 必须来自同一次 LOAD。 */
      const scopes = loadScopes(target, true)
      const trash = scopes.trash!
      /** trash 内的权威条目。 */
      const entry = await readTrashEntry(trash, 'trash', trashId)
      if (!entry) {
        const restored = await findRestoredEntry(scopes.nodes, trashId)
        if (!restored) throw new Error('CANVAS_TRASH_ENTRY_NOT_FOUND')
        await assertContentInScope(scopes.nodes, 'nodes', restored)
        return restored
      }
      if (entry.trashId !== trashId) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      await assertContentInScope(trash, 'trash', entry, trashId)
      const destinationMeta = await readMeta(scopes.nodes, 'nodes', entry.contentId)
      if (destinationMeta) throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      const durabilityError = await moveDirectory(
        trash, scopes.nodes, 'trash', trashId, 'nodes', entry.contentId,
      )
      await verifyAfterMove(durabilityError, async () => {
        await assertContentInScope(scopes.nodes, 'nodes', entry)
      })
      return entry
    },
    listTrash: async (target) => {
      const scopes = loadScopes(target, true)
      const trash = scopes.trash!
      /** native helper 已确定性返回最多 512 个安全 entry ID。 */
      const trashIds = await listEntries(trash, 'trash')
      /** 单项解析失败会被隔离。 */
      const entries: CanvasTrashEntry[] = []
      for (const trashId of trashIds) {
        try {
          const entry = await readTrashEntry(trash, 'trash', trashId)
          if (entry && entry.trashId === trashId) entries.push(entry)
        } catch (error: unknown) {
          /** 只隔离损坏单项，授权和 helper 基础设施错误必须原样传播。 */
          if (!isIsolatedTrashItemError(error)) throw error
        }
      }
      return entries.sort((left, right) => (
        right.deletedAt - left.deletedAt || left.trashId.localeCompare(right.trashId)
      )).slice(0, MAX_CONTENT_ENTRIES)
    },
  }
}
