import { createHash } from 'node:crypto'
import type {
  CanvasArtifactAuthor,
  CanvasDocument,
  CanvasTarget,
  CanvasTextArtifactKind,
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
} from './canvas-document-store'
import type { CanvasTextRevisionZeroReader } from './canvas-node-content-store'

/** 单次版本列表的硬上限，与 native helper 合同一致。 */
const MAX_REVISION_ENTRIES = 512
/** 单个文本产物正文的 UTF-8 字节上限。 */
const MAX_CONTENT_BYTES = 256 * 1024
/** 固定长度 sha256 entry ID 的严格格式。 */
const REVISION_ENTRY_ID_PATTERN = /^revision-[0-9a-f]{64}$/

/** 不可变修订在图提交前后的耐久状态。 */
export type CanvasArtifactRevisionState = 'prepared' | 'committed'

/** 文本产物单个不可变修订的稳定身份。 */
export interface CanvasTextArtifactRevisionIdentity {
  kind: CanvasTextArtifactKind
  contentId: string
  revision: number
}

/** 创建下一个文本修订的业务输入。 */
export interface PrepareCanvasArtifactRevisionInput {
  kind: CanvasTextArtifactKind
  contentId: string
  parentRevision: number
  content: string
  createdBy: CanvasArtifactAuthor
}

/** 在指定修订号准备文本修订的恢复与测试输入。 */
export interface PrepareCanvasArtifactRevisionAtRevisionInput
  extends PrepareCanvasArtifactRevisionInput {
  revision: number
}

/** revisions/<entry>/meta.json 的严格磁盘结构。 */
export interface CanvasArtifactRevisionRecord {
  schemaVersion: 1
  kind: CanvasTextArtifactKind
  contentId: string
  revision: number
  parentRevision: number | null
  contentHash: string
  createdBy: CanvasArtifactAuthor
  createdAt: number
  state: CanvasArtifactRevisionState
}

/** 单个不可变修订的元数据与正文快照。 */
export interface CanvasArtifactRevisionSnapshot {
  record: CanvasArtifactRevisionRecord
  content: string
}

/** 文本产物不可变版本的窄持久化接口。 */
export interface CanvasArtifactRevisionStore {
  read: (
    target: CanvasTarget,
    identity: CanvasTextArtifactRevisionIdentity,
  ) => Promise<CanvasArtifactRevisionSnapshot>
  list: (
    target: CanvasTarget,
    identity: Omit<CanvasTextArtifactRevisionIdentity, 'revision'>,
  ) => Promise<CanvasArtifactRevisionRecord[]>
  prepare: (
    target: CanvasTarget,
    input: PrepareCanvasArtifactRevisionInput,
  ) => Promise<CanvasArtifactRevisionSnapshot>
  prepareAtRevision: (
    target: CanvasTarget,
    input: PrepareCanvasArtifactRevisionAtRevisionInput,
  ) => Promise<CanvasArtifactRevisionSnapshot>
  commit: (
    target: CanvasTarget,
    identity: CanvasTextArtifactRevisionIdentity,
  ) => Promise<CanvasArtifactRevisionRecord>
  reconcile: (target: CanvasTarget, document: CanvasDocument) => Promise<void>
}

/** Revision Store 的可信依赖，测试可注入相对协议 fake。 */
export interface CanvasArtifactRevisionStoreDependencies {
  store: Pick<CanvasDocumentStore, 'loadWithDirectoryCapability'>
  nodeContentStore: CanvasTextRevisionZeroReader
  runStableDirectoryNative?: (
    request: StableDirectoryNativeRequest,
    authorize: CanvasTrustedDirectoryCapability['authorizeOpenedRoots'],
  ) => Promise<StableDirectoryNativeResult>
  now?: () => number
}

/** 未知 JSON 普通对象的安全索引结构。 */
interface UnknownRecord {
  [key: string]: unknown
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 判断普通对象是否只包含指定字段。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is UnknownRecord {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

/** 判断未知值是否为非负安全整数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}

/** 判断未知值是否为受管文本产物类别。 */
function isTextArtifactKind(value: unknown): value is CanvasTextArtifactKind {
  return value === 'document' || value === 'webview'
}

/** 校验不进入路径的稳定业务 ID。 */
function requireBusinessId(value: string, fieldName: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`CANVAS_ARTIFACT_REVISION_ID_INVALID: ${fieldName}`)
  }
  return value
}

/** 严格重建修订作者，拒绝未知字段。 */
function parseAuthor(value: unknown): CanvasArtifactAuthor {
  if (hasExactKeys(value, ['type']) && value.type === 'user') return { type: 'user' }
  if (hasExactKeys(value, ['type', 'sessionId', 'toolCallId'])
    && value.type === 'agent'
    && typeof value.sessionId === 'string'
    && typeof value.toolCallId === 'string') {
    return {
      type: 'agent',
      sessionId: requireBusinessId(value.sessionId, 'sessionId'),
      toolCallId: requireBusinessId(value.toolCallId, 'toolCallId'),
    }
  }
  throw new Error('CANVAS_ARTIFACT_REVISION_CORRUPT: createdBy')
}

/** 严格解析单个修订 meta.json。 */
function parseRevisionRecord(content: string): CanvasArtifactRevisionRecord {
  /** meta.json 的未知反序列化值。 */
  let value: unknown
  try {
    value = JSON.parse(content) as unknown
  } catch (error: unknown) {
    throw new Error('CANVAS_ARTIFACT_REVISION_CORRUPT: meta.json', { cause: error })
  }
  /** 磁盘元数据允许的完整字段集合。 */
  const keys = [
    'schemaVersion', 'kind', 'contentId', 'revision', 'parentRevision', 'contentHash',
    'createdBy', 'createdAt', 'state',
  ] as const
  if (!hasExactKeys(value, keys)
    || value.schemaVersion !== 1
    || !isTextArtifactKind(value.kind)
    || typeof value.contentId !== 'string'
    || !isNonNegativeInteger(value.revision)
    || !(value.parentRevision === null || isNonNegativeInteger(value.parentRevision))
    || typeof value.contentHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.contentHash)
    || !isNonNegativeInteger(value.createdAt)
    || (value.state !== 'prepared' && value.state !== 'committed')) {
    throw new Error('CANVAS_ARTIFACT_REVISION_CORRUPT: meta.json')
  }
  return {
    schemaVersion: 1,
    kind: value.kind,
    contentId: requireBusinessId(value.contentId, 'contentId'),
    revision: value.revision,
    parentRevision: value.parentRevision,
    contentHash: value.contentHash,
    createdBy: parseAuthor(value.createdBy),
    createdAt: value.createdAt,
    state: value.state,
  }
}

/** 固定长度 entry ID 避免 contentId 与 revision 拼接超过 helper 上限。 */
function createRevisionEntryId(contentId: string, revision: number): string {
  return `revision-${createHash('sha256').update(`${contentId}\u0000${revision}`, 'utf8').digest('hex')}`
}

/** 正文 UTF-8 hash 用于不可变校验和后续摘要缓存。 */
function createContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 校验正文的 UTF-8 字节边界。 */
function requireContent(content: string): string {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new Error('CANVAS_ARTIFACT_CONTENT_INVALID')
  }
  return content
}

/** 根据产物类别选择唯一固定正文文件。 */
function contentFileName(kind: CanvasTextArtifactKind): 'content.md' | 'index.html' {
  return kind === 'document' ? 'content.md' : 'index.html'
}

/** 判断两个作者是否表达相同不可变身份。 */
function isSameAuthor(left: CanvasArtifactAuthor, right: CanvasArtifactAuthor): boolean {
  return left.type === right.type
    && (left.type === 'user'
      || (right.type === 'agent'
        && left.sessionId === right.sessionId
        && left.toolCallId === right.toolCallId))
}

/** 创建 Canvas 文本产物不可变版本 Store。 */
export function createCanvasArtifactRevisionStore(
  dependencies: CanvasArtifactRevisionStoreDependencies,
): CanvasArtifactRevisionStore {
  /** Native helper 调用边界。 */
  const runNative = dependencies.runStableDirectoryNative ?? runStableDirectoryNative
  /** 有限时间来源。 */
  const now = dependencies.now ?? Date.now
  /** 同一内容身份的进程内串行尾 Promise，避免并发分配相同 revision。 */
  const operationTails = new Map<string, Promise<void>>()
  /** 按 Canvas target 保存的严格元数据快照，每个 target 最多 512 条。 */
  const metadataCaches = new Map<string, Map<string, CanvasArtifactRevisionRecord>>()
  /** 合并同一 Canvas 并发首次扫描，避免后完成的空缓存覆盖先完成的更新。 */
  const metadataCacheLoads = new Map<string, Promise<Map<string, CanvasArtifactRevisionRecord>>>()

  /** 创建不含路径的 Canvas target 缓存键。 */
  const createTargetCacheKey = (target: CanvasTarget): string => (
    `${target.projectId}\u0000${target.canvasId}`
  )

  /** 失效单个 Canvas 缓存，确保不确定写入后的下一次操作重新严格扫描。 */
  const invalidateMetadataCache = (target: CanvasTarget): void => {
    metadataCaches.delete(createTargetCacheKey(target))
  }

  /** 从本次权威 LOAD 派生 revisions capability。 */
  const loadRevisions = (target: CanvasTarget): CanvasTrustedDirectoryCapability => {
    /** 权威 Canvas 根及其稳定目录能力。 */
    const loaded = dependencies.store.loadWithDirectoryCapability(target)
    /** 固定 revisions 子目录能力。 */
    const revisions = loaded.openSingleChildDirectory('revisions')
    revisions.assertValid()
    return revisions
  }

  /** 在单个 contentId 上串行执行版本分配与写入。 */
  const runExclusive = async <Result>(
    target: CanvasTarget,
    kind: CanvasTextArtifactKind,
    contentId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    /** 串行键包含 Canvas 与文本内容完整身份。 */
    const key = `${target.projectId}\u0000${target.canvasId}\u0000${kind}\u0000${contentId}`
    /** 等待此前操作，无论它成功或失败都释放本次队列。 */
    const previous = operationTails.get(key) ?? Promise.resolve()
    /** 当前操作完成信号。 */
    let release: (() => void) | undefined
    /** 当前串行尾，不暴露业务结果。 */
    const tail = new Promise<void>((resolve) => { release = resolve })
    operationTails.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release?.()
      if (operationTails.get(key) === tail) operationTails.delete(key)
    }
  }

  /** 读取 revisions 中一个固定文件，缺失返回 null。 */
  const readManagedFile = async (
    capability: CanvasTrustedDirectoryCapability,
    entryId: string,
    fileName: 'meta.json' | 'content.md' | 'index.html',
  ): Promise<string | null> => {
    capability.assertValid()
    /** helper 的无路径读取结果。 */
    const result = await runNative({
      mode: 'canvas-content-read', roots: [capability.rootPath], childName: 'revisions',
      entryId, fileName,
    }, capability.authorizeOpenedRoots)
    capability.assertValid()
    if (!result.readOutcome) throw new Error('CANVAS_ARTIFACT_REVISION_PROTOCOL_INVALID')
    if (result.readOutcome.status === 'missing') return null
    if (result.readOutcome.status === 'corrupt') {
      throw new Error(`CANVAS_ARTIFACT_REVISION_CORRUPT: ${result.readOutcome.error}`)
    }
    if (Buffer.byteLength(result.readOutcome.content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new Error('CANVAS_ARTIFACT_REVISION_CORRUPT: content exceeds limit')
    }
    return result.readOutcome.content
  }

  /** 将 helper 原子写三态映射为版本业务错误。 */
  const confirmWrite = (
    capability: CanvasTrustedDirectoryCapability,
    outcome: StableDirectoryNativeWriteOutcome | undefined,
  ): void => {
    if (!outcome) throw new Error('CANVAS_ARTIFACT_REVISION_PROTOCOL_INVALID')
    /** helper 已返回的提交事实必须先于 capability 复验保留。 */
    const committedOutcome = outcome
    /** capability 复验错误。 */
    let scopeError: unknown
    try {
      capability.assertValid()
    } catch (error: unknown) {
      scopeError = error
    }
    if (!committedOutcome.commitVisible) {
      throw new Error(`CANVAS_ARTIFACT_REVISION_WRITE_FAILED: ${committedOutcome.error}`, {
        ...(scopeError === undefined ? {} : { cause: scopeError }),
      })
    }
    if (committedOutcome.durabilityUncertain) {
      throw new Error(`CANVAS_ARTIFACT_REVISION_DURABILITY_UNCERTAIN: ${committedOutcome.error}`, {
        ...(scopeError === undefined ? {} : { cause: scopeError }),
      })
    }
    if (scopeError !== undefined) throw scopeError
  }

  /** 原子写入 revisions 中一个固定文件。 */
  const writeManagedFile = async (
    capability: CanvasTrustedDirectoryCapability,
    entryId: string,
    fileName: 'meta.json' | 'content.md' | 'index.html',
    content: string,
  ): Promise<void> => {
    /** helper 原子写结果。 */
    const result = await runNative({
      mode: 'canvas-content-write', roots: [capability.rootPath], childName: 'revisions',
      entryId, fileName, content, maxEntries: MAX_REVISION_ENTRIES,
    }, capability.authorizeOpenedRoots)
    confirmWrite(capability, result.writeOutcome)
  }

  /** 在已打开 revisions capability 内读取 revision 1+。 */
  const readStoredRevision = async (
    capability: CanvasTrustedDirectoryCapability,
    identity: CanvasTextArtifactRevisionIdentity,
  ): Promise<CanvasArtifactRevisionSnapshot> => {
    /** 由业务身份单向派生的固定长度 entry ID。 */
    const entryId = createRevisionEntryId(identity.contentId, identity.revision)
    /** 受管 meta.json 正文。 */
    const metaContent = await readManagedFile(capability, entryId, 'meta.json')
    if (metaContent === null) throw new Error('CANVAS_ARTIFACT_REVISION_NOT_FOUND')
    /** 严格重建后的不可变元数据。 */
    const record = parseRevisionRecord(metaContent)
    if (record.kind !== identity.kind
      || record.contentId !== identity.contentId
      || record.revision !== identity.revision) {
      throw new Error('CANVAS_ARTIFACT_REVISION_IDENTITY_CONFLICT')
    }
    /** 类别决定的固定正文文件。 */
    const content = await readManagedFile(capability, entryId, contentFileName(identity.kind))
    if (content === null || createContentHash(content) !== record.contentHash) {
      throw new Error('CANVAS_ARTIFACT_REVISION_CORRUPT: content hash')
    }
    return { record, content }
  }

  /** 首次访问 Canvas 时严格扫描全部版本元数据，成功后缓存至多 512 条。 */
  const loadMetadataCache = async (
    target: CanvasTarget,
  ): Promise<Map<string, CanvasArtifactRevisionRecord>> => {
    /** 当前 Canvas 的稳定缓存键。 */
    const cacheKey = createTargetCacheKey(target)
    /** 只有完整扫描成功的缓存才能直接复用。 */
    const cached = metadataCaches.get(cacheKey)
    if (cached) return cached
    /** 已在进行的首次扫描由同一 Canvas 全部调用方共享。 */
    const existingLoad = metadataCacheLoads.get(cacheKey)
    if (existingLoad) return existingLoad
    /** 本次首次扫描 Promise，只在完整成功后发布缓存。 */
    const loadPromise = (async (): Promise<Map<string, CanvasArtifactRevisionRecord>> => {
      /** 本次首次扫描独占的 revisions capability。 */
      const capability = loadRevisions(target)
      capability.assertValid()
      /** helper 固定上限内的 revisions 目录项。 */
      const result = await runNative({
        mode: 'canvas-content-list', roots: [capability.rootPath], childName: 'revisions',
        maxEntries: MAX_REVISION_ENTRIES,
      }, capability.authorizeOpenedRoots)
      capability.assertValid()
      /** 只接受固定 hash entryId，避免其它目录参与解析。 */
      const entryIds = result.entries
        .filter((entry) => entry.isDirectory && REVISION_ENTRY_ID_PATTERN.test(entry.name))
        .slice(0, MAX_REVISION_ENTRIES)
        .map((entry) => entry.name)
      /** 只有完整严格扫描成功后才会发布的新缓存。 */
      const nextCache = new Map<string, CanvasArtifactRevisionRecord>()
      for (const entryId of entryIds) {
        /** meta 缺失表示正文先写、meta 后写协议留下的可恢复 partial。 */
        const content = await readManagedFile(capability, entryId, 'meta.json')
        if (content === null) continue
        /** 单项严格版本记录，解析错误保留稳定 corrupt 前缀。 */
        let record: CanvasArtifactRevisionRecord
        try {
          record = parseRevisionRecord(content)
        } catch (error: unknown) {
          throw new Error('CANVAS_ARTIFACT_REVISION_CORRUPT', { cause: error })
        }
        if (record.revision < 1
          || createRevisionEntryId(record.contentId, record.revision) !== entryId) {
          throw new Error('CANVAS_ARTIFACT_REVISION_CORRUPT')
        }
        nextCache.set(entryId, record)
      }
      /** 扫描完成前不写缓存，保证任何失败都不会污染后续操作。 */
      metadataCaches.set(cacheKey, nextCache)
      return nextCache
    })()
    metadataCacheLoads.set(cacheKey, loadPromise)
    try {
      return await loadPromise
    } finally {
      /** 仅清理本轮扫描，避免误删后续新扫描。 */
      if (metadataCacheLoads.get(cacheKey) === loadPromise) metadataCacheLoads.delete(cacheKey)
    }
  }

  /** 从 Canvas 元数据缓存列出精确身份记录。 */
  const listStoredRecords = async (
    target: CanvasTarget,
    identity: Omit<CanvasTextArtifactRevisionIdentity, 'revision'>,
  ): Promise<CanvasArtifactRevisionRecord[]> => {
    /** 首次调用严格扫描，后续调用复用同一 Canvas 缓存。 */
    const cache = await loadMetadataCache(target)
    return [...cache.values()]
      .filter((record) => record.kind === identity.kind && record.contentId === identity.contentId)
      .sort((left, right) => left.revision - right.revision)
  }

  /** 在已串行化身份内准备指定 revision。 */
  const prepareAtRevisionUnlocked = async (
    target: CanvasTarget,
    input: PrepareCanvasArtifactRevisionAtRevisionInput,
  ): Promise<CanvasArtifactRevisionSnapshot> => {
    /** 规范化并校验不可变身份与正文。 */
    const kind = input.kind
    const contentId = requireBusinessId(input.contentId, 'contentId')
    const revision = input.revision
    const parentRevision = input.parentRevision
    const content = requireContent(input.content)
    if (!isTextArtifactKind(kind)
      || !isNonNegativeInteger(revision) || revision < 1
      || !isNonNegativeInteger(parentRevision) || parentRevision >= revision) {
      throw new Error('CANVAS_ARTIFACT_REVISION_INPUT_INVALID')
    }
    /** 当前不可变正文 hash。 */
    const contentHash = createContentHash(content)
    /** 修订作者按严格联合重建，避免调用方对象夹带字段。 */
    const createdBy = parseAuthor(input.createdBy)
    /** 首次准备必须先完成严格全量扫描，避免缓存掩盖已有损坏。 */
    const cache = await loadMetadataCache(target)
    /** 本操作独占的 revisions capability。 */
    const revisions = loadRevisions(target)
    /** 由身份派生的固定长度 entry ID。 */
    const entryId = createRevisionEntryId(contentId, revision)
    /** 缓存中的已存在 meta 决定幂等返回或不可变冲突。 */
    const cachedRecord = cache.get(entryId)
    if (cachedRecord) {
      /** 已存在修订必须完整读取并验证 hash。 */
      const existing = await readStoredRevision(revisions, { kind, contentId, revision })
      if (existing.record.parentRevision === parentRevision
        && existing.record.contentHash === contentHash
        && isSameAuthor(existing.record.createdBy, createdBy)) return existing
      throw new Error('CANVAS_ARTIFACT_REVISION_CONFLICT')
    }
    if (cache.size >= MAX_REVISION_ENTRIES) {
      throw new Error('CANVAS_ARTIFACT_REVISION_LIMIT_EXCEEDED')
    }
    /** 严格扫描只证明没有正式 meta；精确 entry 仍可能有崩溃遗留正文。 */
    const fileName = contentFileName(kind)
    /** 同类别 partial 正文只允许同 hash 恢复。 */
    const partialContent = await readManagedFile(revisions, entryId, fileName)
    /** 另一类别正文存在表示该 contentId/revision 已被不同身份占用。 */
    const alternateFileName = kind === 'document' ? 'index.html' : 'content.md'
    const alternateContent = await readManagedFile(revisions, entryId, alternateFileName)
    if (alternateContent !== null
      || (partialContent !== null && createContentHash(partialContent) !== contentHash)) {
      throw new Error('CANVAS_ARTIFACT_REVISION_CONFLICT')
    }
    if (partialContent === null) await writeManagedFile(revisions, entryId, fileName, content)
    /** 新修订使用一次有限时间戳。 */
    const createdAt = now()
    if (!isNonNegativeInteger(createdAt)) throw new Error('CANVAS_ARTIFACT_REVISION_TIME_INVALID')
    /** 正文已可见后才提交 prepared meta。 */
    const record: CanvasArtifactRevisionRecord = {
      schemaVersion: 1, kind, contentId, revision, parentRevision,
      contentHash, createdBy, createdAt, state: 'prepared',
    }
    await writeManagedFile(revisions, entryId, 'meta.json', `${JSON.stringify(record, null, 2)}\n`)
    /** 正文与 prepared meta 均成功后才把新事实加入缓存。 */
    cache.set(entryId, record)
    return { record, content }
  }

  /** Store 公开实现，供内部方法共享。 */
  const store: CanvasArtifactRevisionStore = {
    read: async (target, identity) => {
      /** 读取身份必须精确且不含路径字段。 */
      const kind = identity.kind
      const contentId = requireBusinessId(identity.contentId, 'contentId')
      const revision = identity.revision
      if (!isTextArtifactKind(kind) || !isNonNegativeInteger(revision)) {
        throw new Error('CANVAS_ARTIFACT_REVISION_INPUT_INVALID')
      }
      if (revision === 0) {
        /** 旧节点目录的只读 revision 0 正文与元数据。 */
        const legacy = await dependencies.nodeContentStore.readTextRevisionZero(target, { kind, contentId })
        /** revision 0 合成不可变只读记录，不在 revisions 目录复制正文。 */
        const record: CanvasArtifactRevisionRecord = {
          schemaVersion: 1, kind, contentId, revision: 0, parentRevision: null,
          contentHash: createContentHash(legacy.content), createdBy: { type: 'user' },
          createdAt: legacy.meta.createdAt, state: 'committed',
        }
        return { record, content: legacy.content }
      }
      /** revision 1+ 只从 revisions 受管目录读取。 */
      return readStoredRevision(loadRevisions(target), { kind, contentId, revision })
    },
    list: async (target, identity) => {
      /** 列表身份经过固定业务 ID 与类别校验。 */
      const kind = identity.kind
      const contentId = requireBusinessId(identity.contentId, 'contentId')
      if (!isTextArtifactKind(kind)) throw new Error('CANVAS_ARTIFACT_REVISION_INPUT_INVALID')
      return listStoredRecords(target, { kind, contentId })
    },
    prepare: async (target, input) => runExclusive(
      target,
      input.kind,
      input.contentId,
      async () => {
        /** 历史最大 revision 决定新分支编号，而非当前采用版本。 */
        const records = await store.list(target, { kind: input.kind, contentId: input.contentId })
        /** revision 0 是无历史记录时的编号基线。 */
        const maxRevision = records.reduce((maximum, record) => Math.max(maximum, record.revision), 0)
        try {
          return await prepareAtRevisionUnlocked(target, { ...input, revision: maxRevision + 1 })
        } catch (error: unknown) {
          /** 失败可能已留下正文或不确定 meta，必须让下一次操作重新扫描。 */
          invalidateMetadataCache(target)
          throw error
        }
      },
    ),
    prepareAtRevision: async (target, input) => runExclusive(
      target,
      input.kind,
      input.contentId,
      async () => {
        try {
          return await prepareAtRevisionUnlocked(target, input)
        } catch (error: unknown) {
          /** 失败可能已留下正文或不确定 meta，必须让下一次操作重新扫描。 */
          invalidateMetadataCache(target)
          throw error
        }
      },
    ),
    commit: async (target, identity) => runExclusive(
      target,
      identity.kind,
      identity.contentId,
      async () => {
        try {
          if (!isNonNegativeInteger(identity.revision) || identity.revision < 1) {
            throw new Error('CANVAS_ARTIFACT_REVISION_INPUT_INVALID')
          }
          /** 提交前完整复读身份、正文与 hash。 */
          const cache = await loadMetadataCache(target)
          const revisions = loadRevisions(target)
          const snapshot = await readStoredRevision(revisions, identity)
          if (snapshot.record.state === 'committed') return snapshot.record
          /** 只改变状态，其余不可变身份与 hash 原样保留。 */
          const committed: CanvasArtifactRevisionRecord = { ...snapshot.record, state: 'committed' }
          /** 固定 entry ID 只能由已验证身份派生。 */
          const entryId = createRevisionEntryId(identity.contentId, identity.revision)
          await writeManagedFile(revisions, entryId, 'meta.json', `${JSON.stringify(committed, null, 2)}\n`)
          /** committed meta 成功替换后同步同一 Canvas 缓存。 */
          cache.set(entryId, committed)
          return committed
        } catch (error: unknown) {
          /** 失败或耐久性不确定时，下一次提交必须重新扫描磁盘事实。 */
          invalidateMetadataCache(target)
          throw error
        }
      },
    ),
    reconcile: async (target, document) => {
      if (document.projectId !== target.projectId || document.canvasId !== target.canvasId) {
        throw new Error('CANVAS_ARTIFACT_REVISION_IDENTITY_CONFLICT')
      }
      for (const node of document.nodes) {
        if (node.kind !== 'document' && node.kind !== 'webview') continue
        if (node.contentRevision < 1) continue
        /** 图节点类别决定其稳定内容 ID。 */
        const contentId = node.kind === 'document' ? node.documentId : node.prototypeId
        /** 只补提交图已经采用的 prepared 修订。 */
        const snapshot = await store.read(target, {
          kind: node.kind, contentId, revision: node.contentRevision,
        })
        if (snapshot.record.state === 'prepared') {
          await store.commit(target, { kind: node.kind, contentId, revision: node.contentRevision })
        }
      }
    },
  }

  return store
}
