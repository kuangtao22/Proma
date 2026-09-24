import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  API_LIMITS,
  parseApiCatalog,
  parseApiId,
  parseApiResolvedRequest,
  parseApiRun,
} from '@proma/shared'
import type {
  ApiBodySlice,
  ApiCatalog,
  ApiField,
  ApiResolvedRequest,
  ApiRun,
  ApiValue,
} from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { acquireMediaFileLock } from '../media/media-file-lock'
import {
  readAtomicFileState,
  readJsonFileStrict,
  writeJsonFileAtomicSecure,
} from '../safe-file'
import { redactApiBody, redactApiRequest } from './api-redaction'

const EMPTY_BODY = {
  rawBytes: 0,
  decodedBytes: 0,
  contentType: '',
  encoding: '',
  preview: '',
  previewTruncated: false,
  complete: false,
  decoded: false,
} as const
const MAX_CATALOG_BYTES = API_LIMITS.catalogBytes + 256 * 1024
const MAX_RUN_BYTES = API_LIMITS.requestBytes * 6 + API_LIMITS.previewBytes * 4
/** 含 raw/decoded 正文、原始请求及备份的保守预留，防止落盘中途挤掉最新记录。 */
const RUN_RESERVATION_BYTES = API_LIMITS.bodyBytes * 2 + MAX_RUN_BYTES * 3
const MAX_PRIVATE_BYTES = API_LIMITS.requestBytes * 8
const ARTIFACT_MAGIC = Buffer.from('API1', 'ascii')
const COMMON_SENSITIVE_NAME = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|passwd|secret|client[-_]?secret)$/i

/** Electron safeStorage 的最小边界；测试可注入可逆实现。 */
export interface ApiWorkbenchSafeStorage {
  isEncryptionAvailable: () => boolean
  getSelectedStorageBackend: () => 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown'
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}

/** Store 可替换的系统依赖，生产默认 fail closed，必须由 singleton 注入 safeStorage。 */
export interface ApiWorkbenchStoreDependencies {
  safeStorage: ApiWorkbenchSafeStorage
  now: () => number
  uuid: () => string
  processId: number
  isProcessAlive: (processId: number) => boolean
  acquireLock: (path: string) => () => void
  /** 可注入小预算用于容量边界验收。 */
  historyCount: number
  historyBytes: number
}

interface StoredSecret {
  ref: string
  owner: string
  ciphertext: string
  revision: number
  updatedAt: number
}

interface SecretFile {
  version: 1
  secrets: StoredSecret[]
}

interface RunPrivateRecord {
  version: 1
  ownerPid: number
  wrappedKey?: string
  wrappedRedactionSecrets?: string
}

interface VolatileSecret {
  workspaceId: string
  owner: string
  value: string
  revision: number
}

interface VolatileRun {
  run: ApiRun
  rawRequest: ApiResolvedRequest
  rawHops?: ApiRun['hops']
  key?: Buffer
  secretValues: string[]
}

/** 默认空目录提供可立即编辑的 default collection。 */
function emptyCatalog(): ApiCatalog {
  return {
    version: 1,
    revision: 0,
    collections: [{ id: 'default', name: '默认', description: '', variables: [] }],
    environments: [],
    requests: [],
  }
}

/** 保守判断 PID；权限不足视为仍活跃。 */
function isProcessAlive(processId: number): boolean {
  try { process.kill(processId, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 严格 parser 适配 safe-file validator。 */
function isCatalog(value: unknown): value is ApiCatalog {
  try { parseApiCatalog(value); return true } catch { return false }
}

/** 公开 run 文件不允许携带任何私有键。 */
function isRun(value: unknown): value is ApiRun {
  try { parseApiRun(value); return true } catch { return false }
}

/** 验证密文秘密文件的 exact shape。 */
function isSecretFile(value: unknown): value is SecretFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const root = value as Record<string, unknown>
  if (root.version !== 1 || !Array.isArray(root.secrets) || Object.keys(root).length !== 2) return false
  return root.secrets.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const record = item as Record<string, unknown>
    return typeof record.ref === 'string'
      && typeof record.owner === 'string'
      && typeof record.ciphertext === 'string'
      && Number.isSafeInteger(record.revision)
      && Number(record.revision) >= 1
      && Number.isSafeInteger(record.updatedAt)
      && Object.keys(record).every((key) => ['ref', 'owner', 'ciphertext', 'revision', 'updatedAt'].includes(key))
  })
}

/** 验证运行私有记录，只保存 owner 与系统包裹后的随机正文密钥。 */
function isRunPrivate(value: unknown): value is RunPrivateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.version === 1
    && Number.isSafeInteger(record.ownerPid)
    && Number(record.ownerPid) > 0
    && (record.wrappedKey === undefined || typeof record.wrappedKey === 'string')
    && (record.wrappedRedactionSecrets === undefined || typeof record.wrappedRedactionSecrets === 'string')
    && Object.keys(record).every((key) => ['version', 'ownerPid', 'wrappedKey', 'wrappedRedactionSecrets'].includes(key))
}

/** 创建并复验非符号链接目录；生成路径均来自 parseApiId。 */
function ensureDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('API_WORKBENCH_UNSAFE_PATH')
  return realpathSync(path)
}

/** 确认子路径仍位于已解析根目录内。 */
function assertContained(root: string, path: string): void {
  const relation = relative(root, path)
  if (relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !resolve(path).startsWith(`${root}${sep}`))) return
  if (relation.startsWith(`..${sep}`) || relation === '..' || resolve(path) === root) throw new Error('API_WORKBENCH_UNSAFE_PATH')
}

/** AES-256-GCM 文件格式：ASCII API1 + IV(12) + ciphertext + tag(16)。 */
function encryptArtifact(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  return Buffer.concat([ARTIFACT_MAGIC, iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

/** 以随机同目录临时文件原子发布二进制密文。 */
function writeEncryptedFileAtomic(path: string, plaintext: Buffer, key: Buffer): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, encryptArtifact(plaintext, key), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

/** 返回目录占用字节；目录结构完全由 Store 生成且有历史上限。 */
function directoryBytes(path: string): number {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isFile()) total += statSync(child).size
    else if (entry.isDirectory()) total += directoryBytes(child)
  }
  return total
}

/** 工作台目录、秘密和运行记录的唯一持久化边界。 */
export class ApiWorkbenchStore {
  private readonly rootPath: string
  private readonly dependencies: ApiWorkbenchStoreDependencies
  private readonly volatileSecrets = new Map<string, VolatileSecret>()
  private readonly volatileRuns = new Map<string, VolatileRun>()

  constructor(configDir = getConfigDir(), dependencies: Partial<ApiWorkbenchStoreDependencies> = {}) {
    const unavailable: ApiWorkbenchSafeStorage = {
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => 'unknown',
      encryptString: () => { throw new Error('API_WORKBENCH_SECURE_STORAGE_UNAVAILABLE') },
      decryptString: () => { throw new Error('API_WORKBENCH_SECURE_STORAGE_UNAVAILABLE') },
    }
    this.dependencies = {
      safeStorage: unavailable,
      now: Date.now,
      uuid: randomUUID,
      processId: process.pid,
      isProcessAlive,
      acquireLock: acquireMediaFileLock,
      historyCount: API_LIMITS.maxRuns,
      historyBytes: API_LIMITS.historyBytes,
      ...dependencies,
    }
    this.rootPath = ensureDirectory(join(configDir, 'api-workbench'))
    ensureDirectory(join(this.rootPath, 'workspaces'))
  }

  /** 读取 workspace 权威目录；文件存在但损坏时严格失败。 */
  getCatalog(workspaceId: string): ApiCatalog {
    const paths = this.workspacePaths(workspaceId)
    const loaded = readJsonFileStrict<ApiCatalog>(paths.catalog, {
      validate: isCatalog,
      description: '接口工作台目录',
      maxBytes: MAX_CATALOG_BYTES,
      secureRecovery: true,
    })
    return loaded ? parseApiCatalog(loaded) : emptyCatalog()
  }

  /** 在跨进程短事务中比较 revision、秘密化字段并原子提交完整目录。 */
  saveCatalog(workspaceId: string, expectedRevision: number, catalog: ApiCatalog): ApiCatalog {
    parseApiId(workspaceId)
    const input = parseApiCatalog(catalog)
    return this.transaction(workspaceId, () => {
      const current = this.getCatalog(workspaceId)
      if (current.revision !== expectedRevision) throw new Error('API_WORKBENCH_REVISION_CONFLICT')
      const nextRevision = current.revision + 1
      const now = this.dependencies.now()
      const requests = input.requests.map((request) => {
        const previous = current.requests.find((item) => item.id === request.id)
        if (previous && request.revision !== previous.revision) throw new Error('API_WORKBENCH_REQUEST_REVISION_CONFLICT')
        const changed = !previous || JSON.stringify({ ...request, revision: 0, updatedAt: 0 }) !== JSON.stringify({ ...previous, revision: 0, updatedAt: 0 })
        return {
          ...request,
          revision: previous ? previous.revision + (changed ? 1 : 0) : 1,
          updatedAt: previous && !changed ? previous.updatedAt : now,
        }
      })
      const draft: ApiCatalog = { ...input, revision: nextRevision, requests }
      const sanitized = this.sanitizeCatalogSecrets(workspaceId, draft)
      const paths = this.workspacePaths(workspaceId)
      this.writeJson(paths.catalog, sanitized, current.revision === 0 && !existsSync(paths.catalog) ? undefined : current)
      return parseApiCatalog(sanitized)
    })
  }

  /** 按 workspace 与精确 owner 解析秘密，跨资源复用一律视为不存在。 */
  resolveSecret(workspaceId: string, ref: string, owner: string): { value: string; revision: string } | undefined {
    parseApiId(workspaceId)
    parseApiId(ref)
    const volatile = this.volatileSecrets.get(ref)
    if (volatile) {
      if (volatile.workspaceId !== workspaceId || volatile.owner !== owner) throw new Error('API_WORKBENCH_SECRET_NOT_FOUND')
      return { value: volatile.value, revision: String(volatile.revision) }
    }
    const secret = this.readSecrets(workspaceId).find((item) => item.ref === ref && item.owner === owner)
    if (!secret) throw new Error('API_WORKBENCH_SECRET_NOT_FOUND')
    this.assertSecureStorage()
    try {
      return {
        value: this.dependencies.safeStorage.decryptString(Buffer.from(secret.ciphertext, 'base64')),
        revision: String(secret.revision),
      }
    } catch { throw new Error('API_WORKBENCH_SECRET_DECRYPT_FAILED') }
  }

  /** 当前系统可将随机正文密钥安全包裹并持久化。 */
  canRecordArtifacts(): boolean {
    try { this.assertSecureStorage(); return true } catch { return false }
  }

  /** 发送前登记不可重复派发的 run intent，并返回 Utility 受管产物参数。 */
  createRun(
    run: ApiRun,
    rawRequest: ApiResolvedRequest,
    secretValues: readonly string[] = [],
  ): { run: ApiRun; artifacts?: { directory: string; keyBase64: string } } {
    const parsedRun = parseApiRun(run)
    const paths = this.runPaths(parsedRun.workspaceId, parsedRun.id)
    return this.transaction(parsedRun.workspaceId, () => {
      if (existsSync(paths.directory)) throw new Error('API_WORKBENCH_RUN_EXISTS')
      this.applyRetention(parsedRun.workspaceId, RUN_RESERVATION_BYTES, 1)
      ensureDirectory(paths.directory)
      let key: Buffer | undefined
      let wrappedKey: string | undefined
      let wrappedRedactionSecrets: string | undefined
      try {
        if (this.canRecordArtifacts()) {
          key = randomBytes(32)
          wrappedKey = this.dependencies.safeStorage.encryptString(key.toString('base64')).toString('base64')
          wrappedRedactionSecrets = this.dependencies.safeStorage.encryptString(JSON.stringify([...new Set(secretValues)].filter(Boolean))).toString('base64')
        }
        const storedRun = parseApiRun({ ...parsedRun, recording: key ? 'saved' : 'memory-only' })
        this.writeJson(paths.record, storedRun)
        this.writeJson(paths.summary, this.summarize(storedRun))
        this.writeJson(paths.privateRecord, {
          version: 1,
          ownerPid: this.dependencies.processId,
          ...(wrappedKey ? { wrappedKey } : {}),
          ...(wrappedRedactionSecrets ? { wrappedRedactionSecrets } : {}),
        })
        if (key) writeEncryptedFileAtomic(paths.rawRecord, Buffer.from(JSON.stringify({ request: parseApiResolvedRequest(rawRequest) })), key)
        this.volatileRuns.set(this.runKey(parsedRun.workspaceId, parsedRun.id), {
          run: storedRun,
          rawRequest,
          secretValues: [...new Set(secretValues)].filter(Boolean),
          ...(key ? { key } : {}),
        })
        return {
          run: storedRun,
          ...(key ? { artifacts: { directory: paths.directory, keyBase64: key.toString('base64') } } : {}),
        }
      } catch (error) {
        /** 尚未派发网络的初始化失败不留下半条历史；不清理其他 run。 */
        key?.fill(0)
        this.volatileRuns.delete(this.runKey(parsedRun.workspaceId, parsedRun.id))
        rmSync(paths.directory, { recursive: true, force: true })
        throw error
      }
    })
  }

  /** 条件更新公开 run；expectedStates 防止迟到回执覆盖取消或中断终态。 */
  updateRun(
    workspaceId: string,
    runId: string,
    expectedStates: readonly ApiRun['state'][],
    update: (current: ApiRun) => ApiRun,
  ): ApiRun {
    return this.transaction(workspaceId, () => {
      const current = this.getRun(workspaceId, runId, false)
      if (!expectedStates.includes(current.state)) return current
      const next = parseApiRun(update(current))
      if (next.id !== current.id || next.workspaceId !== current.workspaceId || next.sessionId !== current.sessionId) {
        throw new Error('API_WORKBENCH_RUN_IDENTITY_CHANGED')
      }
      const paths = this.runPaths(workspaceId, runId)
      this.writeJson(paths.record, next, current)
      try {
        this.writeJson(paths.summary, this.summarize(next))
      } finally {
        /** record 已提交即以它为准清理终态秘密，摘要失败不能延长明文寿命。 */
        const volatile = this.volatileRuns.get(this.runKey(workspaceId, runId))
        if (volatile) volatile.run = next
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(next.state)) {
          if (next.recording === 'saved' && volatile) { volatile.key?.fill(0); this.volatileRuns.delete(this.runKey(workspaceId, runId)) }
          this.pruneVolatileRuns()
        }
      }
      return next
    })
  }

  /** 读取单个运行；reveal 只替换 request 为受控解密后的原始快照。 */
  getRun(workspaceId: string, runId: string, reveal = false): ApiRun {
    parseApiId(workspaceId)
    parseApiId(runId)
    const volatile = this.volatileRuns.get(this.runKey(workspaceId, runId))
    const persisted = this.readRun(workspaceId, runId)
    const recovered = this.recoverInterrupted(workspaceId, persisted)
    if (!reveal) return parseApiRun(recovered)
    if (volatile && recovered.recording !== 'saved') return parseApiRun({ ...recovered, request: volatile.rawRequest, ...(volatile.rawHops ? { hops: volatile.rawHops } : {}) })
    const paths = this.runPaths(workspaceId, runId)
    const key = this.readRunKey(paths.privateRecord)
    if (!key || !existsSync(paths.rawRecord)) {
      if (volatile) return parseApiRun({ ...recovered, request: volatile.rawRequest, ...(volatile.rawHops ? { hops: volatile.rawHops } : {}) })
      throw new Error('API_WORKBENCH_RAW_RECORD_UNAVAILABLE')
    }
    const raw = JSON.parse(this.decryptArtifactBuffer(readFileSync(paths.rawRecord), key).toString('utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('API_WORKBENCH_RAW_RECORD_CORRUPTED')
    const record = raw as Record<string, unknown>
    return parseApiRun({
      ...recovered,
      request: parseApiResolvedRequest(record.request),
      ...(record.hops === undefined ? {} : { hops: record.hops }),
    })
  }

  /** 在网络完成后独立更新加密原始详情；失败不触发重新发送。 */
  saveRawDetails(workspaceId: string, runId: string, request: ApiResolvedRequest, hops: ApiRun['hops']): void {
    const paths = this.runPaths(workspaceId, runId)
    const validated = parseApiRun({ ...this.readRun(workspaceId, runId), request, hops })
    const volatile = this.volatileRuns.get(this.runKey(workspaceId, runId))
    if (volatile) volatile.rawHops = validated.hops
    const key = this.readRunKey(paths.privateRecord)
    if (!key) return
    writeEncryptedFileAtomic(
      paths.rawRecord,
      Buffer.from(JSON.stringify({ request: validated.request, hops: validated.hops })),
      key,
    )
  }

  /** 列出轻量历史；请求正文与多跳详情由 getRun/readBody 按需读取。 */
  listRuns(workspaceId: string, cursor = 0, limit = 20, sessionId?: string): { runs: ApiRun[]; nextCursor: number | null } {
    if (sessionId) parseApiId(sessionId)
    const paths = this.workspacePaths(workspaceId)
    const ids = readdirSync(paths.runs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    const runs = ids.map((id) => this.readSummary(workspaceId, id))
      .filter((run) => sessionId === undefined || run.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
    const selected = runs.slice(cursor, cursor + limit)
    return { runs: selected, nextCursor: cursor + selected.length < runs.length ? cursor + selected.length : null }
  }

  /** 收藏固定同一个 run，不创建新的网络执行身份。 */
  pinRun(workspaceId: string, runId: string, pinned: boolean): ApiRun {
    const current = this.getRun(workspaceId, runId, false)
    return this.updateRun(workspaceId, runId, [current.state], (run) => ({ ...run, pinned }))
  }

  /** 异步流式认证并按字符范围返回正文；未持久化时只读取有界 preview。 */
  async readBody(
    workspaceId: string,
    runId: string,
    options: { offset?: number; limit?: number; reveal?: boolean; secrets?: readonly string[] } = {},
  ): Promise<ApiBodySlice> {
    const run = this.getRun(workspaceId, runId, false)
    const offset = options.offset ?? 0
    const limit = Math.min(options.limit ?? API_LIMITS.previewBytes, API_LIMITS.previewBytes)
    const paths = this.runPaths(workspaceId, runId)
    let text: string
    if (existsSync(paths.decodedBody)) {
      const key = this.readRunKey(paths.privateRecord)
      if (!key) throw new Error('API_WORKBENCH_BODY_KEY_UNAVAILABLE')
      text = await this.decryptArtifactText(paths.decodedBody, key)
    } else {
      text = run.body.preview
    }
    if (!options.reveal) {
      text = redactApiBody(text, [
        ...this.getKnownSecretValues(workspaceId),
        ...this.readRunRedactionSecrets(workspaceId, runId),
        ...(options.secrets ?? []),
      ])
    }
    const sliced = text.slice(offset, offset + limit)
    const nextOffset = offset + sliced.length < text.length ? offset + sliced.length : null
    return { text: sliced, offset, nextOffset, totalChars: text.length, truncated: nextOffset !== null }
  }

  /** 清除进程内明文与密钥；不会删除持久历史。 */
  shutdown(): void {
    this.volatileSecrets.clear()
    for (const entry of this.volatileRuns.values()) entry.key?.fill(0)
    this.volatileRuns.clear()
  }

  /** 解密当前 workspace 已持久化和内存秘密，仅供主进程脱敏，不向 IPC 暴露。 */
  getKnownSecretValues(workspaceId: string): string[] {
    const values = new Set<string>()
    for (const secret of this.volatileSecrets.values()) {
      if (secret.workspaceId === workspaceId && secret.value) values.add(secret.value)
    }
    const stored = this.readSecrets(workspaceId)
    if (stored.length > 0) this.assertSecureStorage()
    for (const secret of stored) {
      try {
        const value = this.dependencies.safeStorage.decryptString(Buffer.from(secret.ciphertext, 'base64'))
        if (value) values.add(value)
      } catch { throw new Error('API_WORKBENCH_SECRET_DECRYPT_FAILED') }
    }
    return [...values]
  }

  /** 将所有秘密字段替换为 owner-bound ref；秘密文件先提交，catalog 后提交。 */
  private sanitizeCatalogSecrets(workspaceId: string, catalog: ApiCatalog): ApiCatalog {
    const secretFile = this.readSecrets(workspaceId)
    const byOwner = new Map(secretFile.map((secret) => [secret.owner, secret]))
    const byRef = new Map(secretFile.map((secret) => [secret.ref, secret]))
    let persistentChanged = false
    const sanitize = (value: ApiValue, owner: string, forceSecret = false): ApiValue => {
      const shouldSecret = forceSecret || value.secret === true || value.secretRef !== undefined
      if (!shouldSecret) return { value: value.value, ...(value.secret === undefined ? {} : { secret: value.secret }) }
      if (value.secretRef && !value.value) {
        const known = byRef.get(value.secretRef)
        const volatile = this.volatileSecrets.get(value.secretRef)
        if (!(known?.ref === value.secretRef && known.owner === owner) && !(volatile?.workspaceId === workspaceId && volatile.owner === owner)) {
          throw new Error('API_WORKBENCH_SECRET_OWNER_MISMATCH')
        }
        return { value: '', secret: true, secretRef: value.secretRef }
      }
      if (!value.value) throw new Error('API_WORKBENCH_SECRET_EMPTY')
      const previous = byOwner.get(owner)
      const ref = parseApiId(this.dependencies.uuid())
      if (byRef.has(ref)) throw new Error('API_WORKBENCH_SECRET_ID_COLLISION')
      const revision = (previous?.revision ?? this.volatileSecrets.get(ref)?.revision ?? 0) + 1
      if (this.canRecordArtifacts()) {
        const next: StoredSecret = {
          ref,
          owner,
          ciphertext: this.dependencies.safeStorage.encryptString(value.value).toString('base64'),
          revision,
          updatedAt: this.dependencies.now(),
        }
        byOwner.set(owner, next)
        byRef.set(ref, next)
        persistentChanged = true
      } else {
        throw new Error('API_WORKBENCH_SECURE_STORAGE_UNAVAILABLE')
      }
      return { value: '', secret: true, secretRef: ref }
    }
    const fields = (items: readonly ApiField[], prefix: string, forceByName = false): ApiField[] => items.map((field) => ({
      ...field,
      ...sanitize(field, `${prefix}:${field.id}`, forceByName && COMMON_SENSITIVE_NAME.test(field.name)),
    }))
    const sanitized: ApiCatalog = {
      ...catalog,
      collections: catalog.collections.map((collection) => ({
        ...collection,
        variables: fields(collection.variables, `collection:${collection.id}:variable`),
      })),
      environments: catalog.environments.map((environment) => ({
        ...environment,
        variables: fields(environment.variables, `environment:${environment.id}:variable`),
      })),
      requests: catalog.requests.map((request) => ({
        ...request,
        query: fields(request.query, `request:${request.id}:query`, true),
        headers: fields(request.headers, `request:${request.id}:header`, true),
        body: { ...request.body, fields: fields(request.body.fields, `request:${request.id}:body`) },
        auth: {
          ...request.auth,
          value: sanitize(request.auth.value, `request:${request.id}:auth:value`, request.auth.type !== 'none'),
        },
      })),
    }
    if (persistentChanged) {
      /** 旧 catalog 与其恢复备份仍可引用旧密文；新 ref 写入失败只留下无效孤儿，不改变旧值。 */
      const referenced = new Set<string>()
      const collect = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        if (Array.isArray(value)) { value.forEach(collect); return }
        const record = value as Record<string, unknown>
        if (typeof record.secretRef === 'string') referenced.add(record.secretRef)
        Object.values(record).forEach(collect)
      }
      collect(sanitized)
      collect(this.getCatalog(workspaceId))
      const backup = this.workspacePaths(workspaceId).catalog + '.bak'
      if (existsSync(backup)) { try { collect(JSON.parse(readFileSync(backup, 'utf8'))) } catch { /* 主目录已通过严格校验，坏备份不能成为新凭据来源。 */ } }
      this.writeSecrets(workspaceId, [...byRef.values()].filter((secret) => referenced.has(secret.ref)), secretFile.length ? { version: 1, secrets: secretFile } : undefined)
    }
    return sanitized
  }

  /** 读取当前 workspace 密文秘密；坏文件不得降级为空。 */
  private readSecrets(workspaceId: string): StoredSecret[] {
    const path = this.workspacePaths(workspaceId).secrets
    const loaded = readJsonFileStrict<SecretFile>(path, {
      validate: isSecretFile,
      description: '接口工作台秘密',
      maxBytes: MAX_CATALOG_BYTES,
      secureRecovery: true,
    })
    return loaded?.secrets.map((secret) => ({ ...secret })) ?? []
  }

  /** 原子提交密文秘密快照。 */
  private writeSecrets(workspaceId: string, secrets: StoredSecret[], prior?: SecretFile): void {
    if (Buffer.byteLength(JSON.stringify(secrets)) > MAX_CATALOG_BYTES) throw new Error('API_WORKBENCH_SECRET_BUDGET_EXCEEDED')
    this.writeJson(this.workspacePaths(workspaceId).secrets, { version: 1, secrets }, prior)
  }

  /** 验证系统保护能力，Linux basic_text 明确视为不可用。 */
  private assertSecureStorage(): void {
    if (!this.dependencies.safeStorage.isEncryptionAvailable()) throw new Error('API_WORKBENCH_SECURE_STORAGE_UNAVAILABLE')
    if (process.platform === 'linux' && this.dependencies.safeStorage.getSelectedStorageBackend() === 'basic_text') {
      throw new Error('API_WORKBENCH_SECURE_STORAGE_UNAVAILABLE')
    }
  }

  /** 获取并释放 workspace 文件锁；回调保持同步，避免锁跨事件循环。 */
  private transaction<T>(workspaceId: string, callback: () => T): T {
    const paths = this.workspacePaths(workspaceId)
    const release = this.dependencies.acquireLock(paths.lock)
    try { return callback() } finally { release() }
  }

  /** 生成并验证固定 workspace 路径。 */
  private workspacePaths(workspaceId: string): {
    directory: string
    catalog: string
    secrets: string
    runs: string
    lock: string
  } {
    parseApiId(workspaceId)
    const workspacesRoot = ensureDirectory(join(this.rootPath, 'workspaces'))
    const directory = ensureDirectory(join(workspacesRoot, workspaceId))
    assertContained(workspacesRoot, directory)
    const runs = ensureDirectory(join(directory, 'runs'))
    return {
      directory,
      catalog: join(directory, 'catalog.json'),
      secrets: join(directory, 'secrets.json'),
      runs,
      lock: join(directory, '.store.lock'),
    }
  }

  /** 生成固定 run 子目录及文件路径。 */
  private runPaths(workspaceId: string, runId: string): {
    directory: string
    record: string
    summary: string
    privateRecord: string
    rawRecord: string
    rawBody: string
    decodedBody: string
  } {
    parseApiId(runId)
    const workspace = this.workspacePaths(workspaceId)
    const directory = join(workspace.runs, runId)
    assertContained(workspace.runs, resolve(directory))
    return {
      directory,
      record: join(directory, 'record.json'),
      summary: join(directory, 'summary.json'),
      privateRecord: join(directory, 'private.json'),
      rawRecord: join(directory, 'raw-record.bin.enc'),
      rawBody: join(directory, 'raw.bin.enc'),
      decodedBody: join(directory, 'decoded.bin.enc'),
    }
  }

  /** 使用 safe-file CAS 写入 exact JSON，旧值作为 prior backup。 */
  private writeJson(path: string, value: object, prior?: object): void {
    const state = readAtomicFileState(path)
    writeJsonFileAtomicSecure(path, value, {
      expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' },
      ...(prior && state ? { priorBackup: { filePath: `${path}.bak`, data: prior } } : {}),
    })
  }

  /** 严格读取公开 run。 */
  private readRun(workspaceId: string, runId: string): ApiRun {
    const path = this.runPaths(workspaceId, runId).record
    const loaded = readJsonFileStrict<ApiRun>(path, {
      validate: isRun,
      description: '接口工作台运行记录',
      maxBytes: MAX_RUN_BYTES,
      secureRecovery: true,
    })
    if (!loaded) throw new Error('API_WORKBENCH_RUN_NOT_FOUND')
    return parseApiRun(loaded)
  }

  /** 读取私有 owner/key 记录。 */
  private readPrivate(path: string): RunPrivateRecord {
    const loaded = readJsonFileStrict<RunPrivateRecord>(path, {
      validate: isRunPrivate,
      description: '接口工作台运行私有记录',
      maxBytes: MAX_PRIVATE_BYTES,
      secureRecovery: true,
    })
    if (!loaded) throw new Error('API_WORKBENCH_RUN_PRIVATE_NOT_FOUND')
    return loaded
  }

  /** 仅在 owner 已确定退出时把遗留在途状态标为 interrupted。 */
  private recoverInterrupted(workspaceId: string, run: ApiRun): ApiRun {
    if (run.state !== 'queued' && run.state !== 'running') return run
    const privateRecord = this.readPrivate(this.runPaths(workspaceId, run.id).privateRecord)
    if (this.dependencies.isProcessAlive(privateRecord.ownerPid)) return run
    const interrupted = parseApiRun({
      ...run,
      state: 'interrupted',
      finishedAt: this.dependencies.now(),
      error: { code: 'API_WORKBENCH_INTERRUPTED', phase: 'recovery', message: '执行进程已退出，远端结果未知' },
    })
    this.writeJson(this.runPaths(workspaceId, run.id).record, interrupted, run)
    return interrupted
  }

  /** 解包单个 run 的随机正文密钥。 */
  private readRunKey(privatePath: string): Buffer | undefined {
    const privateRecord = this.readPrivate(privatePath)
    if (!privateRecord.wrappedKey) return undefined
    this.assertSecureStorage()
    try {
      const key = Buffer.from(this.dependencies.safeStorage.decryptString(Buffer.from(privateRecord.wrappedKey, 'base64')), 'base64')
      if (key.length !== 32) throw new Error('invalid key')
      return key
    } catch { throw new Error('API_WORKBENCH_BODY_KEY_DECRYPT_FAILED') }
  }

  /** 读取单次运行准备阶段固化的秘密值，仅用于历史正文脱敏。 */
  private readRunRedactionSecrets(workspaceId: string, runId: string): string[] {
    const volatile = this.volatileRuns.get(this.runKey(workspaceId, runId))
    if (volatile) return [...volatile.secretValues]
    const privateRecord = this.readPrivate(this.runPaths(workspaceId, runId).privateRecord)
    if (!privateRecord.wrappedRedactionSecrets) return []
    this.assertSecureStorage()
    try {
      const plaintext = this.dependencies.safeStorage.decryptString(Buffer.from(privateRecord.wrappedRedactionSecrets, 'base64'))
      const parsed = JSON.parse(plaintext) as unknown
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error('invalid secrets')
      return parsed.filter(Boolean)
    } catch { throw new Error('API_WORKBENCH_SECRET_DECRYPT_FAILED') }
  }

  /** 解密完整小型原始请求记录。 */
  private decryptArtifactBuffer(encrypted: Buffer, key: Buffer): Buffer {
    if (encrypted.length < 32 || !encrypted.subarray(0, 4).equals(ARTIFACT_MAGIC)) throw new Error('API_WORKBENCH_ARTIFACT_CORRUPTED')
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(4, 16))
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16))
    try { return Buffer.concat([decipher.update(encrypted.subarray(16, -16)), decipher.final()]) }
    catch { throw new Error('API_WORKBENCH_ARTIFACT_CORRUPTED') }
  }

  /** 流式解密正文并完成 GCM 认证；只累积文本结果，不保留密文副本。 */
  private async decryptArtifactText(path: string, key: Buffer): Promise<string> {
    const size = statSync(path).size
    if (size < 32 || size > API_LIMITS.bodyBytes + 1024 * 1024 + 32) throw new Error('API_WORKBENCH_ARTIFACT_CORRUPTED')
    const descriptor = openSync(path, 'r')
    const header = Buffer.alloc(16)
    const tag = Buffer.alloc(16)
    try {
      if (readSync(descriptor, header, 0, 16, 0) !== 16 || readSync(descriptor, tag, 0, 16, size - 16) !== 16 || !header.subarray(0, 4).equals(ARTIFACT_MAGIC)) {
        throw new Error('API_WORKBENCH_ARTIFACT_CORRUPTED')
      }
    } finally { closeSync(descriptor) }
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(4, 16))
    decipher.setAuthTag(tag)
    const decoder = new TextDecoder()
    let text = ''
    try {
      for await (const chunk of createReadStream(path, { start: 16, end: size - 17 }).pipe(decipher)) {
        text += decoder.decode(chunk as Buffer, { stream: true })
      }
      text += decoder.decode()
      return text
    } catch { throw new Error('API_WORKBENCH_ARTIFACT_CORRUPTED') }
  }

  /** 应用 7 天、1 GiB 与条数上限，收藏和在途记录不参与淘汰。 */
  private applyRetention(workspaceId: string, reserveBytes = 0, reserveCount = 0): void {
    const workspace = this.workspacePaths(workspaceId)
    const entries = readdirSync(workspace.runs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const run = this.readSummary(workspaceId, entry.name)
        const path = join(workspace.runs, entry.name)
        const active = ['queued', 'running'].includes(run.state)
        return { run, path, bytes: Math.max(directoryBytes(path), active ? RUN_RESERVATION_BYTES : 0) }
      })
      .sort((a, b) => a.run.createdAt - b.run.createdAt)
    let totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0)
    let totalCount = entries.length
    const cutoff = this.dependencies.now() - API_LIMITS.historyDays * 24 * 60 * 60 * 1000
    const removable: typeof entries = []
    for (const entry of entries) {
      const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(entry.run.state)
      const shouldRemove = terminal && !entry.run.pinned
        && (entry.run.createdAt < cutoff || totalBytes + reserveBytes > this.dependencies.historyBytes || totalCount + reserveCount > this.dependencies.historyCount)
      if (!shouldRemove) continue
      removable.push(entry)
      totalBytes -= entry.bytes
      totalCount -= 1
    }
    if (totalBytes + reserveBytes > this.dependencies.historyBytes || totalCount + reserveCount > this.dependencies.historyCount) throw new Error('API_WORKBENCH_CAPACITY_LIMIT: 收藏或活动记录已占满预算，请取消收藏后重试')
    /** 先证明腾出的空间足够，再提交淘汰；发送被拒绝不会顺带删除普通历史。 */
    for (const entry of removable) {
      const real = realpathSync(entry.path)
      assertContained(workspace.runs, real)
      rmSync(real, { recursive: true, force: true })
      this.volatileRuns.get(this.runKey(workspaceId, entry.run.id))?.key?.fill(0)
      this.volatileRuns.delete(this.runKey(workspaceId, entry.run.id))
    }
  }

  /** 历史列表不加载整份请求和预览；完整事实仍在 record.json。 */
  private summarize(run: ApiRun): ApiRun {
    return parseApiRun({ ...run, request: { ...run.request, body: '', headers: [] },
      hops: run.hops.length ? [{ ...run.hops.at(-1)!, requestHeaders: [], responseHeaders: [], trailers: [] }] : [],
      assertions: [], body: { ...run.body, preview: '', previewTruncated: run.body.preview.length > 0 || run.body.previewTruncated },
      /** 历史列只保留事件计数，明细仍在完整记录中按需读取。 */
      ...(run.sse ? { sse: { ...run.sse, events: [] } } : {}) })
  }

  /** 小摘要损坏显式失败；旧记录缺少摘要时才回退完整记录。 */
  private readSummary(workspaceId: string, runId: string): ApiRun {
    const path = this.runPaths(workspaceId, runId).summary
    if (!existsSync(path)) return this.summarize(this.getRun(workspaceId, runId))
    const value = readJsonFileStrict<ApiRun>(path, { validate: isRun, description: '接口工作台历史摘要', maxBytes: 128 * 1024, secureRecovery: true })
    if (!value) throw new Error('API_WORKBENCH_HISTORY_CORRUPTED')
    return ['queued', 'running'].includes(value.state) ? this.summarize(this.getRun(workspaceId, runId)) : parseApiRun(value)
  }

  /** 无系统保护时只保留有限原文缓存；公开历史不会因此消失。 */
  private pruneVolatileRuns(): void {
    let bytes = [...this.volatileRuns.values()].reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0)
    for (const [id, entry] of this.volatileRuns) {
      if (this.volatileRuns.size <= 32 && bytes <= 8 * 1024 * 1024) break
      if (['queued', 'running'].includes(entry.run.state)) continue
      bytes -= Buffer.byteLength(JSON.stringify(entry))
      entry.key?.fill(0)
      this.volatileRuns.delete(id)
    }
  }

  /** 构造内存缓存专用身份，不用于文件路径。 */
  private runKey(workspaceId: string, runId: string): string {
    return `${workspaceId}\0${runId}`
  }
}

/** 供 Service 构造初始 queued run 使用的空正文事实。 */
export function createEmptyApiBody() {
  return { ...EMPTY_BODY }
}
