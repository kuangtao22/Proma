import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MediaAuthorizationMode, MediaConfiguration, MediaConnection, MediaConnectionAuth, MediaProfile, MediaProjectCatalog, MediaRemoteDescriptor, MediaWorkflowDefinition, MediaWorkflowRemoteSource, MediaWorkflowVersion } from '@proma/shared'
import { parseMediaWorkflowDefinition } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { removeFileAtomic, writeJsonFileAtomicSecure } from '../safe-file'
import { acquireMediaFileLock } from './media-file-lock'
import { readMediaJsonFile } from './media-json-file'
import { COMFY_CORE_NODE_CONTRACTS } from './comfyui-workflow'

/** 系统安全存储边界；不接受 Linux basic_text 明文后端。 */
export interface MediaSecureStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** 仅在主进程运行期间存在的连接认证头。 */
export interface ResolvedMediaConnection {
  connection: MediaConnection
  headers: Record<string, string>
}

/** 无密钥的默认加密器，确保未注入 Electron 时拒绝秘密落盘。 */
const unavailableStorage: MediaSecureStorage = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => 'unknown',
  encryptString: () => { throw new Error('MEDIA_SECURE_STORAGE_UNAVAILABLE') },
  decryptString: () => { throw new Error('MEDIA_SECURE_STORAGE_UNAVAILABLE') },
}
/** 路径标识不能引入目录穿越或特殊对象属性。 */
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
/** 保存和恢复凭据使用同一个最终序列化字节预算。 */
const credentialMaximumBytes = 32 * 1024
/** 远端正文和规范化工作流都使用完整 SHA-256 指纹。 */
const sha256Pattern = /^[a-f0-9]{64}$/

/** Host 缓存远端执行快照所需的可信输入。 */
export interface CacheRemoteWorkflowInput {
  projectId: string
  name: string
  descriptor: MediaRemoteDescriptor
  contentHash: string
  definition: MediaWorkflowDefinition
}

/** 解析普通对象并拒绝未声明的字段。 */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).every((key) => keys.includes(key))) throw new Error('MEDIA_CONFIG_INVALID')
  return value as Record<string, unknown>
}

/** 校验稳定 ID，返回可用于配置引用的原值。 */
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)
    || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('MEDIA_CONFIG_INVALID')
  return value
}

/** 校验有界展示名并清理首尾空白。 */
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) throw new Error('MEDIA_CONFIG_INVALID')
  return value.trim()
}

/** 校验非负整数版本或时间戳。 */
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('MEDIA_CONFIG_INVALID')
  return value
}

/** 校验明确布尔值，避免字符串被隐式启用。 */
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('MEDIA_CONFIG_INVALID')
  return value
}

/** 解析认证头名称，阻止改写 Host、Cookie 或请求传输语义。 */
function auth(value: unknown): MediaConnectionAuth {
  const input = record(value, ['kind', 'headerName'])
  if (input.kind === 'none' || input.kind === 'bearer') {
    if (input.headerName !== undefined) throw new Error('MEDIA_CONFIG_INVALID')
    return { kind: input.kind }
  }
  if (input.kind === 'header' && typeof input.headerName === 'string'
    && /^(?:x-[a-z0-9-]+|authorization)$/i.test(input.headerName) && input.headerName.length <= 80) {
    return { kind: 'header', headerName: input.headerName }
  }
  throw new Error('MEDIA_CONFIG_INVALID')
}

/** 连接 URL 只包含固定 HTTP(S) 地址与路径，认证放在独立字段。 */
function endpoint(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error()
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
    return url.href
  } catch { throw new Error('MEDIA_CONNECTION_URL_INVALID') }
}

/** 有界数组校验，避免损坏配置造成无界处理。 */
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('MEDIA_CONFIG_INVALID')
  return value
}

/** 严格读取连接，所有字段重新构造而非信任文件类型断言。 */
function parseConnection(value: unknown): MediaConnection {
  const input = record(value, ['id', 'name', 'driver', 'baseUrl', 'enabled', 'projectIds', 'comfyUser', 'archivedAt', 'auth', 'credentialRef', 'revision', 'instanceGeneration', 'updatedAt'])
  if (input.driver !== 'comfyui') throw new Error('MEDIA_CONFIG_INVALID')
  if (input.projectIds !== undefined) {
    /** 旧授权字段只用于验证旧文件，不复制到全局配置。 */
    const projectIds = array(input.projectIds, 1024).map(identifier)
    if (new Set(projectIds).size !== projectIds.length) throw new Error('MEDIA_CONFIG_INVALID')
  }
  if (input.comfyUser !== undefined && (typeof input.comfyUser !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(input.comfyUser))) throw new Error('MEDIA_CONFIG_INVALID')
  const authentication = auth(input.auth)
  const credentialRef = input.credentialRef === undefined ? undefined : identifier(input.credentialRef)
  if ((authentication.kind === 'none') !== (credentialRef === undefined)) throw new Error('MEDIA_CONFIG_INVALID')
  return {
    id: identifier(input.id), name: name(input.name), driver: 'comfyui', baseUrl: endpoint(input.baseUrl),
    enabled: boolean(input.enabled), auth: authentication,
    ...(input.comfyUser ? { comfyUser: input.comfyUser as string } : {}),
    ...(input.archivedAt === undefined ? {} : { archivedAt: integer(input.archivedAt) }),
    ...(credentialRef ? { credentialRef } : {}), revision: integer(input.revision, 1),
    instanceGeneration: identifier(input.instanceGeneration), updatedAt: integer(input.updatedAt),
  }
}

/** 计算固定图定义的内容指纹。 */
function workflowHash(definition: MediaWorkflowVersion['definition']): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex')
}

/** 递归规范化对象键顺序，避免 JSON 属性顺序改变远端快照身份。 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]))
  }
  return value
}

/** 计算不受对象属性顺序影响的工作流定义指纹。 */
function canonicalWorkflowHash(definition: MediaWorkflowDefinition): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(definition))).digest('hex')
}

/** 校验远端工作流路径，允许目录层级但拒绝绝对路径和目录穿越。 */
function workflowPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.startsWith('/')
    || /^[A-Za-z]:\//.test(value) || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)
    || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('MEDIA_REMOTE_RESOURCE_INVALID')
  }
  return value
}

/** 严格解析仅来自 UserData 的远端工作流描述符。 */
function remoteWorkflowDescriptor(value: unknown): MediaRemoteDescriptor {
  let input: Record<string, unknown>
  try {
    input = record(value, ['connectionId', 'instanceGeneration', 'remoteUser', 'source', 'id', 'workflowPath'])
  } catch { throw new Error('MEDIA_REMOTE_RESOURCE_INVALID') }
  if (input.source !== 'user-data' || typeof input.remoteUser !== 'string'
    || input.remoteUser.length > 128 || !/^[\x20-\x7e]*$/.test(input.remoteUser)) throw new Error('MEDIA_REMOTE_RESOURCE_INVALID')
  const path = workflowPath(input.workflowPath)
  if (input.id !== path) throw new Error('MEDIA_REMOTE_RESOURCE_INVALID')
  try {
    return { connectionId: identifier(input.connectionId), instanceGeneration: identifier(input.instanceGeneration),
      remoteUser: input.remoteUser, source: 'user-data', id: path, workflowPath: path }
  } catch { throw new Error('MEDIA_REMOTE_RESOURCE_INVALID') }
}

/** 严格解析落盘的远端来源标记，旧工作流没有该字段时保持兼容。 */
function parseRemoteSource(value: unknown): MediaWorkflowRemoteSource {
  let input: Record<string, unknown>
  try { input = record(value, ['descriptor', 'contentHash']) } catch { throw new Error('MEDIA_CONFIG_INVALID') }
  if (typeof input.contentHash !== 'string' || !sha256Pattern.test(input.contentHash)) throw new Error('MEDIA_CONFIG_INVALID')
  try {
    return { descriptor: remoteWorkflowDescriptor(input.descriptor), contentHash: input.contentHash }
  } catch { throw new Error('MEDIA_CONFIG_INVALID') }
}

/** 公共模板以参数槽代替媒体文件名；模型文件枚举保持原有精确值。 */
function makePublicDefinition(definition: MediaWorkflowVersion['definition']): void {
  for (const [nodeId, node] of Object.entries(definition.prompt)) {
    /** 已适配节点的文件输入具有明确上传语义。 */
    const resource = COMFY_CORE_NODE_CONTRACTS[node.class_type]?.resourceInput
    if (resource) {
      /** 只有真实媒体绑定能够清除项目文件引用并留待任务上传。 */
      const binding = definition.bindings.find((item) => item.nodeId === nodeId && item.input === resource.input
        && (item.kind === 'image' || item.kind === 'video' || item.kind === 'audio'))
      if (!binding) throw new Error('MEDIA_WORKFLOW_RESOURCE_BINDING_REQUIRED')
      node.inputs[resource.input] = ''
    }
    for (const [inputKey, value] of Object.entries(node.inputs)) {
      if (inputKey === resource?.input || typeof value !== 'string') continue
      // 公共图不得携带绝对文件地址；普通文本提示词不承担文件寻址。
      if ((inputKey !== 'text' && inputKey !== 'prompt') && /^(?:[A-Za-z]:[\\/]|\/|file:|\.\.[\\/]|proma-file:)/i.test(value)) {
        throw new Error('MEDIA_WORKFLOW_PRIVATE_RESOURCE')
      }
    }
  }
}

/** 验证工作流历史记录的内容与指纹一致。 */
function parseWorkflow(value: unknown): MediaWorkflowVersion {
  const input = record(value, ['id', 'name', 'projectId', 'revision', 'hash', 'definition', 'createdAt', 'remoteSource'])
  const definition = parseMediaWorkflowDefinition(input.definition)
  if (input.hash !== workflowHash(definition)) throw new Error('MEDIA_CONFIG_INVALID')
  return { id: identifier(input.id), name: name(input.name), projectId: input.projectId === null ? null : identifier(input.projectId),
    revision: integer(input.revision, 1), hash: input.hash as string, definition, createdAt: integer(input.createdAt),
    ...(input.remoteSource === undefined ? {} : { remoteSource: parseRemoteSource(input.remoteSource) }) }
}

/** 严格解析固定工作流版本的媒体预设。 */
function parseProfile(value: unknown): MediaProfile {
  const input = record(value, ['id', 'name', 'revision', 'connectionId', 'workflowId', 'workflowRevision', 'mediaKind', 'projectId', 'enabled', 'createdAt'])
  if (input.mediaKind !== 'image' && input.mediaKind !== 'video' && input.mediaKind !== 'audio') throw new Error('MEDIA_CONFIG_INVALID')
  return { id: identifier(input.id), name: name(input.name), revision: integer(input.revision, 1), connectionId: identifier(input.connectionId),
    workflowId: identifier(input.workflowId), workflowRevision: integer(input.workflowRevision, 1), mediaKind: input.mediaKind,
    projectId: identifier(input.projectId), enabled: boolean(input.enabled), createdAt: integer(input.createdAt) }
}

/** 严格解析媒体生成授权模式，拒绝宽松字符串转换。 */
function parseAuthorizationMode(value: unknown): MediaAuthorizationMode {
  if (value !== 'ask' && value !== 'automatic') throw new Error('MEDIA_AUTHORIZATION_MODE_INVALID')
  return value
}

/** 统一媒体配置；写入串行化，密钥单独加密，所有读操作重新读取磁盘。 */
export class MediaConfigStore {
  /** 当前数据根下的媒体配置目录。 */
  private readonly directory: string
  /** 系统加密器只在主进程持有。 */
  private readonly secureStorage: MediaSecureStorage
  /** Host 单例内的授权模式变化监听器，不跨进程轮询。 */
  private readonly authorizationModeListeners = new Set<() => void>()

  constructor(configDir = getConfigDir(), secureStorage: MediaSecureStorage = unavailableStorage) {
    this.directory = join(configDir, 'media')
    this.secureStorage = secureStorage
  }

  /** 返回严格解析的公开目录；损坏文件不得退回空目录。 */
  read(): MediaConfiguration {
    const path = join(this.directory, 'config.json')
    try { lstatSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 2, revision: 0, authorizationMode: 'ask', connections: [], workflows: [], profiles: [], connectionHistory: [], archivedWorkflowIds: [] }
      throw error
    }
    try {
      const input = record(readMediaJsonFile(path, 32 * 1024 * 1024), ['schemaVersion', 'revision', 'authorizationMode', 'connections', 'workflows', 'profiles', 'connectionHistory', 'archivedWorkflowIds'])
      if (input.schemaVersion !== 1 && input.schemaVersion !== 2) throw new Error('MEDIA_CONFIG_INVALID')
      const configuration: MediaConfiguration = { schemaVersion: 2, revision: integer(input.revision), authorizationMode: parseAuthorizationMode(input.authorizationMode ?? 'ask'),
        connections: array(input.connections, 256).map(parseConnection), workflows: array(input.workflows, 4096).map(parseWorkflow),
        profiles: array(input.profiles, 4096).map(parseProfile),
        connectionHistory: array(input.connectionHistory ?? [], 4096).map(parseConnection),
        archivedWorkflowIds: array(input.archivedWorkflowIds ?? [], 4096).map(identifier) }
      for (const entries of [configuration.connections.map((item) => item.id), configuration.workflows.map((item) => `${item.id}:${item.revision}`), configuration.profiles.map((item) => `${item.id}:${item.revision}`),
        configuration.connectionHistory!.map((item) => `${item.id}:${item.instanceGeneration}`), configuration.archivedWorkflowIds!]) {
        if (new Set(entries).size !== entries.length) throw new Error('MEDIA_CONFIG_INVALID')
      }
      for (const entries of [configuration.workflows, configuration.profiles]) {
        const groups = new Map<string, Array<{ revision: number; projectId: string | null }>>()
        for (const item of entries) groups.set(item.id, [...(groups.get(item.id) ?? []), item])
        for (const versions of groups.values()) {
          versions.sort((left, right) => left.revision - right.revision)
          if (versions.some((item, index) => item.revision !== index + 1 || item.projectId !== versions[0]?.projectId)) throw new Error('MEDIA_CONFIG_INVALID')
        }
      }
      return configuration
    } catch (error) { throw new Error('MEDIA_CONFIG_INVALID', { cause: error }) }
  }

  /** 保存全局媒体授权模式；相同值保持幂等，不推进配置版本。 */
  saveAuthorizationMode(value: unknown, expectedRevision: number): MediaConfiguration {
    const mode = parseAuthorizationMode(value)
    let changed = false
    const configuration = this.mutate(expectedRevision, (current) => {
      if ((current.authorizationMode ?? 'ask') === mode) return undefined
      current.authorizationMode = mode
      changed = true
      return current
    })
    if (changed) {
      for (const listener of [...this.authorizationModeListeners]) {
        try { listener() } catch { /* 已提交配置不能因观察者异常表现为保存失败。 */ }
      }
    }
    return configuration
  }

  /** 订阅已持久化的授权模式变化，返回幂等退订函数。 */
  subscribeAuthorizationMode(listener: () => void): () => void {
    this.authorizationModeListeners.add(listener)
    return () => { this.authorizationModeListeners.delete(listener) }
  }

  /** 返回公共目录及当前项目旧草稿，任务授权仍由调用方 Host 检查。 */
  listProject(projectId = ''): MediaProjectCatalog {
    const configuration = this.read()
    return { revision: configuration.revision,
      connections: configuration.connections.filter((item) => item.archivedAt === undefined).map((item) => ({ id: item.id, name: item.name,
        driver: item.driver, enabled: item.enabled, revision: item.revision, instanceGeneration: item.instanceGeneration, credentialConfigured: !!item.credentialRef })),
      workflows: configuration.workflows.filter((item) => (item.projectId === null || item.projectId === projectId) && !configuration.archivedWorkflowIds?.includes(item.id)).map((item) => ({
        id: item.id, name: item.name, revision: item.revision, projectId: item.projectId, hash: item.hash, createdAt: item.createdAt,
        ...(item.remoteSource ? { remoteSource: item.remoteSource } : {}) })),
      profiles: configuration.profiles.filter((item) => item.projectId === projectId) }
  }

  /** 保存管理界面提供的连接；一次性凭据不进入公开快照。 */
  saveConnection(value: unknown, expectedRevision: number): MediaConfiguration {
    return this.mutate(expectedRevision, (configuration) => {
      const input = record(value, ['id', 'name', 'driver', 'baseUrl', 'enabled', 'projectIds', 'comfyUser', 'auth', 'credential'])
      const id = identifier(input.id)
      const previous = configuration.connections.find((item) => item.id === id)
      const authentication = auth(input.auth)
      let credentialRef = authentication.kind === 'none' ? undefined : previous?.credentialRef
      const secret = input.credential
      if (authentication.kind === 'none' && secret !== undefined) throw new Error('MEDIA_CREDENTIAL_UNEXPECTED')
      if (secret !== undefined && (typeof secret !== 'string' || !secret.trim() || secret.length > 8192 || !/^[\x20-\x7e]+$/.test(secret))) throw new Error('MEDIA_CREDENTIAL_INVALID')
      if (authentication.kind !== 'none' && secret === undefined && (!previous || JSON.stringify(previous.auth) !== JSON.stringify(authentication))) throw new Error('MEDIA_CREDENTIAL_REQUIRED')
      if (authentication.kind !== 'none' && secret !== undefined) credentialRef = randomUUID()
      const next = parseConnection({ id, name: input.name, driver: input.driver, baseUrl: input.baseUrl,
        enabled: input.enabled, projectIds: input.projectIds, comfyUser: input.comfyUser, auth: authentication,
        ...(credentialRef ? { credentialRef } : {}), revision: (previous?.revision ?? 0) + 1,
        instanceGeneration: randomUUID(), updatedAt: Date.now() })
      // 停用只影响新任务资格；已有任务始终解析准备时的实例与认证。
      if (previous && previous.baseUrl === next.baseUrl && previous.driver === next.driver
        && previous.comfyUser === next.comfyUser && previous.credentialRef === next.credentialRef
        && JSON.stringify(previous.auth) === JSON.stringify(next.auth)
      ) {
        next.instanceGeneration = previous.instanceGeneration
      }
      if (previous && previous.instanceGeneration !== next.instanceGeneration) {
        configuration.connectionHistory = [...(configuration.connectionHistory ?? []), previous]
      }
      if (authentication.kind !== 'none' && typeof secret === 'string') {
        this.assertSecureStorage()
        const ciphertext = this.secureStorage.encryptString(secret).toString('base64')
        if (Buffer.byteLength(JSON.stringify({ connectionId: id, ciphertext }), 'utf8') > credentialMaximumBytes) throw new Error('MEDIA_CREDENTIAL_SIZE_LIMIT')
        mkdirSync(join(this.directory, 'credentials'), { recursive: true, mode: 0o700 })
        writeJsonFileAtomicSecure(join(this.directory, 'credentials', `${credentialRef}.json`), { connectionId: id, ciphertext })
      }
      configuration.connections = [...configuration.connections.filter((item) => item.id !== id), next]
      return configuration
    })
  }

  /** 新任务解析全局启用连接，不向 Agent 或 Renderer 暴露认证头。 */
  resolveConnection(connectionId: string, _projectId = ''): ResolvedMediaConnection {
    const connection = this.read().connections.find((item) => item.id === connectionId)
    if (!connection) throw new Error('MEDIA_CONNECTION_NOT_AUTHORIZED')
    if (!connection.enabled || connection.archivedAt !== undefined) throw new Error('MEDIA_CONNECTION_DISABLED')
    return this.decryptConnection(connection)
  }

  /** 已准备任务只读取其固定实例代次，目录停用和后续认证编辑不改派旧任务。 */
  resolveConnectionVersion(connectionId: string, instanceGeneration: string): ResolvedMediaConnection {
    const configuration = this.read()
    const connection = [...configuration.connections, ...(configuration.connectionHistory ?? [])]
      .find((item) => item.id === connectionId && item.instanceGeneration === instanceGeneration)
    if (!connection) throw new Error('MEDIA_CONNECTION_CHANGED')
    return this.decryptConnection(connection)
  }

  /** 认证头仅在主进程内生成；远端用户身份与认证协议分开处理。 */
  private decryptConnection(connection: MediaConnection): ResolvedMediaConnection {
    const headers: Record<string, string> = {}
    if (connection.comfyUser) headers['comfy-user'] = connection.comfyUser
    if (connection.auth.kind !== 'none') {
      this.assertSecureStorage()
      try {
        const stored = record(readMediaJsonFile(join(this.directory, 'credentials', `${connection.credentialRef}.json`), credentialMaximumBytes), ['connectionId', 'ciphertext'])
        if (stored.connectionId !== connection.id || typeof stored.ciphertext !== 'string') throw new Error()
        const secret = this.secureStorage.decryptString(Buffer.from(stored.ciphertext, 'base64'))
        if (!secret || /[\r\n]/.test(secret)) throw new Error()
        if (connection.auth.kind === 'bearer') headers.Authorization = `Bearer ${secret}`
        else headers[connection.auth.headerName] = secret
      } catch { throw new Error('MEDIA_CREDENTIAL_UNAVAILABLE') }
    }
    return { connection, headers }
  }

  /** 管理员或已授权项目操作保存不可变工作流版本。 */
  saveWorkflow(value: unknown, expectedRevision: number): MediaConfiguration {
    return this.mutate(expectedRevision, (configuration) => {
      const input = record(value, ['id', 'name', 'projectId', 'definition'])
      const id = identifier(input.id)
      const previous = configuration.workflows.filter((item) => item.id === id)
      const projectId = input.projectId === null || input.projectId === undefined ? null : identifier(input.projectId)
      if (previous.some((item) => item.remoteSource !== undefined)) throw new Error('MEDIA_WORKFLOW_REMOTE_SNAPSHOT_IMMUTABLE')
      if (previous.some((item) => item.projectId !== projectId)) throw new Error('MEDIA_WORKFLOW_SCOPE_CONFLICT')
      const definition = parseMediaWorkflowDefinition(input.definition)
      if (projectId === null) makePublicDefinition(definition)
      const workflow = parseWorkflow({ ...input, projectId, definition, hash: workflowHash(definition), revision: previous.length + 1, createdAt: Date.now() })
      configuration.workflows.push(workflow)
      return configuration
    })
  }

  /** 自动缓存绑定远端身份的执行快照；相同内容命中时不写盘也不推进配置版本。 */
  cacheRemoteWorkflow(value: CacheRemoteWorkflowInput): MediaWorkflowVersion {
    const projectId = identifier(value.projectId)
    const workflowName = name(value.name)
    const descriptor = remoteWorkflowDescriptor(value.descriptor)
    if (typeof value.contentHash !== 'string' || !sha256Pattern.test(value.contentHash)) throw new Error('MEDIA_REMOTE_RESOURCE_INVALID')
    const definition = parseMediaWorkflowDefinition(value.definition)
    const definitionHash = canonicalWorkflowHash(definition)
    const identityHash = createHash('sha256').update(JSON.stringify({ projectId, descriptor,
      contentHash: value.contentHash, definitionHash })).digest('hex')
    const id = `remote-workflow-${identityHash}`
    let snapshot: MediaWorkflowVersion | undefined
    this.mutateCurrent((configuration) => {
      const connection = configuration.connections.find((item) => item.id === descriptor.connectionId)
      if (!connection || connection.instanceGeneration !== descriptor.instanceGeneration
        || (connection.comfyUser ?? '') !== descriptor.remoteUser) throw new Error('MEDIA_REMOTE_RESOURCE_STALE')
      if (!connection.enabled || connection.archivedAt !== undefined) throw new Error('MEDIA_CONNECTION_DISABLED')
      const existing = configuration.workflows.find((item) => item.id === id && item.revision === 1)
      if (existing) {
        if (existing.projectId !== projectId || !existing.remoteSource
          || existing.remoteSource.contentHash !== value.contentHash
          || canonicalWorkflowHash(existing.definition) !== definitionHash) throw new Error('MEDIA_CONFIG_INVALID')
        snapshot = existing
        return undefined
      }
      snapshot = parseWorkflow({ id, name: workflowName, projectId, revision: 1, hash: workflowHash(definition), definition,
        createdAt: Date.now(), remoteSource: { descriptor, contentHash: value.contentHash } })
      configuration.workflows.push(snapshot)
      return configuration
    })
    if (!snapshot) throw new Error('MEDIA_CONFIG_INVALID')
    return snapshot
  }

  /** 查询精确模板版本，并复核项目可见性。 */
  getWorkflow(workflowId: string, revision: number, projectId: string): MediaWorkflowVersion {
    const workflow = this.read().workflows.find((item) => item.id === workflowId && item.revision === revision)
    if (!workflow || (workflow.projectId !== null && workflow.projectId !== projectId)) throw new Error('MEDIA_WORKFLOW_NOT_AUTHORIZED')
    return workflow
  }

  /** 保存固定版本预设，验证连接授权及产物类型。 */
  saveProfile(value: unknown, expectedRevision: number): MediaConfiguration {
    return this.mutate(expectedRevision, (configuration) => {
      const input = record(value, ['id', 'name', 'connectionId', 'workflowId', 'workflowRevision', 'mediaKind', 'projectId', 'enabled'])
      const previous = configuration.profiles.filter((item) => item.id === input.id)
      const profile = parseProfile({ ...input, revision: previous.length + 1, createdAt: Date.now() })
      if (previous.some((item) => item.projectId !== profile.projectId)) throw new Error('MEDIA_PROFILE_SCOPE_CONFLICT')
      const connection = configuration.connections.find((item) => item.id === profile.connectionId)
      if (!connection || connection.archivedAt !== undefined) throw new Error('MEDIA_CONNECTION_NOT_AUTHORIZED')
      const workflow = configuration.workflows.find((item) => item.id === profile.workflowId && item.revision === profile.workflowRevision)
      if (!workflow || (workflow.projectId !== null && workflow.projectId !== profile.projectId)) throw new Error('MEDIA_WORKFLOW_NOT_AUTHORIZED')
      if (!workflow.definition.outputs.some((item) => item.mediaType === profile.mediaKind)) throw new Error('MEDIA_PROFILE_OUTPUT_MISMATCH')
      configuration.profiles.push(profile)
      return configuration
    })
  }

  /** 运行前解析预设的固定图与当前连接，历史预设不会自动追随模板更新。 */
  resolveProfile(profileId: string, revision: number, projectId: string): ResolvedMediaConnection & { profile: MediaProfile; workflow: MediaWorkflowVersion } {
    const profiles = this.read().profiles.filter((item) => item.id === profileId).sort((left, right) => left.revision - right.revision)
    const profile = profiles.find((item) => item.revision === revision)
    if (!profile || profile.projectId !== projectId) throw new Error('MEDIA_PROFILE_NOT_AUTHORIZED')
    if (!profile.enabled || !profiles.at(-1)?.enabled) throw new Error('MEDIA_PROFILE_DISABLED')
    return { ...this.resolveConnection(profile.connectionId, projectId), profile, workflow: this.getWorkflow(profile.workflowId, profile.workflowRevision, projectId) }
  }

  /** 删除只归档目录身份；旧任务已经固化的图和连接版本继续可读。 */
  archive(value: unknown, expectedRevision: number): MediaConfiguration {
    const input = record(value, ['kind', 'id'])
    const id = identifier(input.id)
    return this.mutate(expectedRevision, (configuration) => {
      if (input.kind === 'connection') {
        const connection = configuration.connections.find((item) => item.id === id)
        if (!connection) throw new Error('MEDIA_CONNECTION_NOT_AUTHORIZED')
        connection.archivedAt = Date.now()
        connection.enabled = false
        connection.revision += 1
      } else if (input.kind === 'workflow') {
        if (!configuration.workflows.some((item) => item.id === id)) throw new Error('MEDIA_WORKFLOW_NOT_AUTHORIZED')
        configuration.archivedWorkflowIds = [...new Set([...(configuration.archivedWorkflowIds ?? []), id])]
      } else throw new Error('MEDIA_CONFIG_INVALID')
      return configuration
    })
  }

  /** 同步短事务只持有配置锁，不在锁内执行远程请求。 */
  private mutate(expectedRevision: number, update: (configuration: MediaConfiguration) => MediaConfiguration | undefined): MediaConfiguration {
    integer(expectedRevision)
    return this.mutateLocked(expectedRevision, update)
  }

  /** Host 内部事务总是基于锁内最新配置，不要求调用方持有 Renderer CAS 版本。 */
  private mutateCurrent(update: (configuration: MediaConfiguration) => MediaConfiguration | undefined): MediaConfiguration {
    return this.mutateLocked(undefined, update)
  }

  /** 在同一文件锁内执行 CAS 或 Host 幂等事务，undefined 表示无需提交。 */
  private mutateLocked(expectedRevision: number | undefined, update: (configuration: MediaConfiguration) => MediaConfiguration | undefined): MediaConfiguration {
    mkdirSync(this.directory, { recursive: true })
    let release: () => void
    try { release = acquireMediaFileLock(join(this.directory, 'config.lock')) } catch (error) {
      if (error instanceof Error && error.message === 'MEDIA_FILE_BUSY') throw new Error('MEDIA_CONFIG_BUSY')
      throw error
    }
    try {
      const previous = this.read()
      if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw new Error('MEDIA_CONFIG_CONFLICT')
      /** 首次升级前保存原始 v1 文件；后续写入不得覆盖迁移证据。 */
      const configPath = join(this.directory, 'config.json')
      if (existsSync(configPath)) {
        const original = readMediaJsonFile(configPath, 32 * 1024 * 1024) as Record<string, unknown>
        const backupPath = join(this.directory, 'config.v1.backup.json')
        if (original.schemaVersion === 1 && !existsSync(backupPath)) writeJsonFileAtomicSecure(backupPath, original)
      }
      this.collectUnusedCredentials(previous)
      const next = update(previous)
      if (!next) return previous
      next.revision += 1
      if (next.connections.length > 256 || next.workflows.length > 4096 || next.profiles.length > 4096
        || (next.connectionHistory?.length ?? 0) > 4096) throw new Error('MEDIA_CONFIG_LIMIT')
      if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 32 * 1024 * 1024) throw new Error('MEDIA_CONFIG_SIZE_LIMIT')
      writeJsonFileAtomicSecure(join(this.directory, 'config.json'), next)
      this.collectUnusedCredentials(next)
      return next
    } finally { release() }
  }

  /** 在配置锁内按已提交配置的可达引用回收密文；失败只保留文件，下一次写入再对账。 */
  private collectUnusedCredentials(configuration: MediaConfiguration): void {
    const directory = join(this.directory, 'credentials')
    const reachable = new Set([...configuration.connections, ...(configuration.connectionHistory ?? [])]
      .flatMap((item) => item.credentialRef ? [`${item.credentialRef}.json`] : []))
    try {
      for (const filename of readdirSync(directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(filename) || reachable.has(filename)) continue
        const path = join(directory, filename)
        const state = lstatSync(path)
        if (!state.isFile()) continue
        removeFileAtomic(path, { expectedIdentity: { dev: state.dev, ino: state.ino } })
      }
    } catch { /* 密文回收不影响已提交配置，残留文件会在下次写入时重试。 */ }
  }

  /** 安全存储不可用时保持连接保存失败，禁止静默明文回退。 */
  private assertSecureStorage(): void {
    if (!this.secureStorage.isEncryptionAvailable() || this.secureStorage.getSelectedStorageBackend() === 'basic_text') throw new Error('MEDIA_SECURE_STORAGE_UNAVAILABLE')
  }
}
