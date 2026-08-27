import {
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
}

/** Canvas 非 Agent 节点内容与回收区的窄业务接口。 */
export interface CanvasNodeContentStore {
  prepareEmptyContent: (target: CanvasTarget, input: PrepareCanvasNodeContentInput) => Promise<void>
  prepareMigratedContent: (target: CanvasTarget, seed: LegacyCanvasContentSeed) => Promise<void>
  assertContent: (target: CanvasTarget, input: PrepareCanvasNodeContentInput) => Promise<CanvasNodeContentMeta>
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
interface CanvasImageContentConfig extends CanvasNodeContentMeta {
  prompt: string
  selectedModelProfileId: string | null
  adoptedAssetId: string | null
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

/** 严格解析 JSON，语法错误统一按内容损坏处理。 */
function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content) as unknown
  } catch (error: unknown) {
    throw new Error(`CANVAS_CONTENT_CORRUPT: ${label}: ${errorText(error)}`)
  }
}

/** 严格解析图片配置并拒绝无界文本、未知字段和身份漂移。 */
function parseImageConfig(content: string): CanvasImageContentConfig {
  /** 图片配置的未知 JSON 值。 */
  const value = parseJson(content, 'config.json')
  /** 图片配置允许的完整字段集合。 */
  const keys = [
    'schemaVersion', 'kind', 'contentId', 'revision', 'createdAt', 'updatedAt',
    'prompt', 'selectedModelProfileId', 'adoptedAssetId',
  ] as const
  if (!hasExactKeys(value, keys)
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
  meta: CanvasNodeContentMeta,
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
      throw new Error(`CANVAS_CONTENT_CORRUPT: ${result.readOutcome.error}`)
    }
    if (result.readOutcome.content.length > MAX_CONTENT_TEXT_LENGTH) {
      throw new Error('CANVAS_CONTENT_CORRUPT: text exceeds limit')
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
    capability.assertValid()
    if (!outcome) throw new Error('CANVAS_CONTENT_PROTOCOL_INVALID: missing write outcome')
    if (!outcome.commitVisible) {
      throw new Error(`CANVAS_CONTENT_WRITE_FAILED: ${outcome.error ?? 'write not committed'}`)
    }
    return outcome.durabilityUncertain
      ? new Error(`CANVAS_CONTENT_DURABILITY_UNCERTAIN: ${outcome.error}`)
      : null
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
    /** rename 后耐久性不确定时，先复读确认正文可见，再向上层传播。 */
    const durabilityError = confirmWrite(capability, result.writeOutcome)
    if (durabilityError) {
      const committed = await readFile(capability, childName, entryId, fileName)
      if (committed !== content) throw new Error('CANVAS_CONTENT_COMMIT_UNCONFIRMED')
      throw durabilityError
    }
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
      ...(kind === 'image' ? ['adoptedAssetId'] : []),
      ...(kind === 'webview' ? ['legacySourceUrl'] : []),
    ])
    if (Object.keys(seed).some((key) => !allowedSeedKeys.has(key))) {
      throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
    }
    if (seed.adoptedAssetId !== undefined) requireContentId(seed.adoptedAssetId, 'adoptedAssetId')
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
            schemaVersion: 1 as const, kind: 'image' as const, contentId, revision: 0,
            createdAt: timestamp, updatedAt: timestamp, prompt: '',
            selectedModelProfileId: null, adoptedAssetId,
          }
        : parseImageConfig(existingConfigContent)
      if (config.contentId !== contentId
        || config.prompt !== ''
        || config.selectedModelProfileId !== null
        || config.adoptedAssetId !== adoptedAssetId) {
        throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      }
      const configText = `${JSON.stringify(config, null, 2)}\n`
      if (existingConfigContent !== null && existingConfigContent !== configText
        && existingConfigContent !== JSON.stringify(config)) {
        throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      }
      if (existingConfigContent === null) {
        await ensureExactFile(nodes, 'nodes', contentId, 'config.json', configText)
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
    if (existingMeta) {
      const existingSource = 'legacySourceUrl' in existingMeta ? existingMeta.legacySourceUrl : null
      if (existingSource !== webviewMeta.legacySourceUrl) {
        throw new Error('CANVAS_CONTENT_IDENTITY_CONFLICT')
      }
      return
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
    source.assertValid()
    destination.assertValid()
    if (!result.moveOutcome) throw new Error('CANVAS_CONTENT_PROTOCOL_INVALID: missing move outcome')
    if (!result.moveOutcome.commitVisible) {
      throw new Error(`CANVAS_CONTENT_MOVE_FAILED: ${result.moveOutcome.error ?? 'move not committed'}`)
    }
    return result.moveOutcome.durabilityUncertain
      ? new Error(`CANVAS_CONTENT_DURABILITY_UNCERTAIN: ${result.moveOutcome.error}`)
      : null
  }

  /** 严格读取 entry.json；缺失返回 null。 */
  const readTrashEntry = async (
    capability: CanvasTrustedDirectoryCapability,
    childName: 'nodes' | 'trash',
    entryId: string,
  ): Promise<CanvasTrashEntry | null> => {
    const content = await readFile(capability, childName, entryId, 'entry.json')
    return content === null ? null : parseCanvasTrashEntry(parseJson(content, 'entry.json'))
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
      } catch {
        /** 其它节点的损坏 entry.json 不得阻断目标恢复重放。 */
      }
    }
    return null
  }

  return {
    prepareEmptyContent: (target, input) => prepareContent(target, {
      kind: requireContentKind(input.kind),
      contentId: requireContentId(input.contentId, 'contentId'),
    }),
    prepareMigratedContent: prepareContent,
    assertContent: async (target, input) => {
      const kind = requireContentKind(input.kind)
      const contentId = requireContentId(input.contentId, 'contentId')
      const { nodes } = loadScopes(target)
      return assertContentInScope(nodes, 'nodes', { kind, contentId })
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
        durabilityError = await moveDirectory(
          scopes.nodes, trash, 'nodes', entry.contentId, 'trash', entry.trashId,
        )
      } else {
        if (!targetMeta) throw new Error('CANVAS_CONTENT_NOT_FOUND')
        assertSameIdentity(targetMeta, entry)
      }
      await assertContentInScope(trash, 'trash', entry, entry.trashId)
      await ensureExactFile(
        trash,
        'trash',
        entry.trashId,
        'entry.json',
        `${JSON.stringify(entry, null, 2)}\n`,
      )
      if (durabilityError) throw durabilityError
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
      await assertContentInScope(scopes.nodes, 'nodes', entry)
      if (durabilityError) throw durabilityError
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
        } catch {
          /** 损坏单项不应让整个回收区不可用。 */
        }
      }
      return entries.sort((left, right) => (
        right.deletedAt - left.deletedAt || left.trashId.localeCompare(right.trashId)
      )).slice(0, MAX_CONTENT_ENTRIES)
    },
  }
}
