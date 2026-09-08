import { createHash, randomUUID } from 'node:crypto'
import type {
  ComfyNodeSchema,
  ComfyObjectInfo,
  JsonObject,
  MediaConnectionProbe,
  MediaRemoteCapability,
  MediaRemoteDescriptor,
  MediaRemoteWorkflow,
  MediaResourcePage,
  MediaResourceQuery,
  MediaResourceSource,
} from '@proma/shared'
import { parseComfyObjectCatalog, parseComfyObjectInfo } from '@proma/shared'
import type {
  ComfyAssetListOptions,
  ComfyAssetPage,
  ComfyOutputContent,
  ComfyRemoteAsset,
  ComfyUIClientOptions,
  ComfyUserWorkflowFile,
} from './comfyui-client'
import { ComfyUIClient, ComfyUIError } from './comfyui-client'
import { COMFY_CORE_NODE_CONTRACTS } from './comfyui-workflow'
import type { MediaResourceSnapshotStore } from './media-resource-snapshot-store'

/** 资源发现与原文读取所需的纯读客户端接口。 */
interface ResourceClient {
  objectInfo(): Promise<unknown>
  systemStats?(): Promise<JsonObject>
  listModelFolders(): Promise<string[]>
  listModels(folder: string): Promise<string[]>
  listUserWorkflows?(): Promise<ComfyUserWorkflowFile[]>
  readUserWorkflow?(path: string): Promise<JsonObject>
  listAssets?(options: ComfyAssetListOptions): Promise<ComfyAssetPage>
  getAssetMetadata?(assetId: string): Promise<ComfyRemoteAsset>
  getAssetContent?(assetId: string): Promise<ComfyOutputContent>
}

/** 主进程按当前全局配置解析实例与凭据；空 projectId 保留旧签名兼容。 */
export interface MediaResourceServiceDependencies {
  resolveConnection(connectionId: string, projectId: string): {
    connection: { id: string; instanceGeneration: string; baseUrl: string }
    headers: Record<string, string>
  }
  createClient?: (options: ComfyUIClientOptions) => ResourceClient
  /** 生产环境注入原子 JSON 存储，测试可替换为隔离目录或内存持久层。 */
  snapshots?: Pick<MediaResourceSnapshotStore, 'read' | 'write'>
}

/** 每个缓存条目共有的采集身份。 */
interface SourceSnapshot {
  id: string
  checkedAt: number
  capability: MediaRemoteCapability
  snapshotOrigin?: 'local' | 'remote'
  syncError?: MediaRemoteCapability
}

/** 节点来源快照。 */
interface NodeSnapshot extends SourceSnapshot { schema: ComfyObjectInfo; schemaFormatVersion: number }
/** 模型快照保存全部目录的文件名，不读取权重文件。 */
interface ModelSnapshot extends SourceSnapshot { folders: string[]; models: Record<string, string[]> }
/** UserData 工作流目录快照，不包含工作流正文。 */
interface WorkflowSnapshot extends SourceSnapshot { files: ComfyUserWorkflowFile[] }
/** 正文与目录分开保存，目录版本变化时自然切换缓存键。 */
interface WorkflowBodySnapshot extends SourceSnapshot { definition: JsonObject }

/** 当前请求重新解析后的连接与远端用户身份。 */
interface ResourceContext {
  connectionId: string
  instanceGeneration: string
  remoteUser: string
  client: ResourceClient
}

const CACHE_TTL_MS = 60_000
const CACHE_LIMIT = 16
/** 限制首次全目录同步的远端并发和目录数量。 */
const MODEL_SYNC_CONCURRENCY = 4
const MAX_MODEL_FOLDERS = 256
const DEFAULT_REMOTE_ASSET_BYTES = 64 * 1024 * 1024
const MAX_REMOTE_ASSET_BYTES = 128 * 1024 * 1024
/** 节点 schema 快照格式；递增后旧快照只在首次读取时迁移一次。 */
const NODE_SCHEMA_FORMAT_VERSION = 2

/** 清洗发现用 schema，只有受控模型字段可公开资源枚举。 */
function publicSchema(classType: string, schema: ComfyNodeSchema): ComfyNodeSchema {
  const copy = structuredClone(schema)
  delete copy.input.hidden
  const modelInputs = COMFY_CORE_NODE_CONTRACTS[classType]?.modelInputs ?? []
  for (const inputs of [copy.input.required, copy.input.optional ?? {}]) {
    for (const [key, value] of Object.entries(inputs)) {
      if (COMFY_CORE_NODE_CONTRACTS[classType]?.resourceInput?.input === key && value[1]) delete value[1].default
      if (Array.isArray(value[0]) && !modelInputs.includes(key)
        && (COMFY_CORE_NODE_CONTRACTS[classType]?.resourceInput?.input === key || !COMFY_CORE_NODE_CONTRACTS[classType])) {
        /** 未适配枚举可能包含远端用户私有路径，只保留参数约束。 */
        const options = value[1] ? { ...value[1] } : undefined
        if (options) delete options.default
        inputs[key] = options ? [[], options] : [[]]
      }
    }
  }
  return copy
}

/** 从大小写不敏感的请求头读取 ComfyUI 远端用户范围。 */
function remoteUser(headers: Record<string, string>): string {
  return Object.entries(headers).find(([name]) => name.toLocaleLowerCase() === 'comfy-user')?.[1] ?? ''
}

/** 把来源错误映射为 UI/Agent 可判断的能力状态。 */
function capabilityFromError(error: unknown): MediaRemoteCapability {
  if (!(error instanceof ComfyUIError)) return 'failed'
  if (error.kind === 'authentication' || error.status === 401 || error.status === 403) return 'authentication-required'
  if (error.kind === 'service-disabled') return 'disabled'
  if (error.status === 404 || error.status === 405) return 'unsupported'
  return 'failed'
}

/** 判断工作流正文是 UI 图、API prompt 或未知对象；判断不产生执行副作用。 */
function workflowFormat(definition: JsonObject): MediaRemoteWorkflow['format'] {
  if (Array.isArray(definition.nodes)) return 'ui'
  const nodes = Object.values(definition)
  if (nodes.length > 0 && nodes.every((node) => node !== null && typeof node === 'object' && !Array.isArray(node)
    && typeof node.class_type === 'string' && node.inputs !== null && typeof node.inputs === 'object' && !Array.isArray(node.inputs))) return 'api'
  return 'unknown'
}

/** 校验本地快照共有字段；不接受旧版内存缓存形状。 */
function snapshotRecord(value: unknown): Record<string, unknown> & SourceSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MEDIA_RESOURCE_SNAPSHOT_INVALID')
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !/^[a-f0-9]{64}$/.test(record.id)
    || typeof record.checkedAt !== 'number' || !Number.isSafeInteger(record.checkedAt) || record.checkedAt < 0
    || !['available', 'unsupported', 'disabled', 'authentication-required', 'failed', 'unknown'].includes(String(record.capability))) {
    throw new Error('MEDIA_RESOURCE_SNAPSHOT_INVALID')
  }
  return record as Record<string, unknown> & SourceSnapshot
}

/** 还原节点快照时使用严格 schema 校验，损坏数据不降级为有效目录。 */
function parseNodeSnapshot(value: unknown): NodeSnapshot {
  const record = snapshotRecord(value)
  const schemaFormatVersion = record.schemaFormatVersion === undefined ? 1 : record.schemaFormatVersion
  if (schemaFormatVersion !== 1 && schemaFormatVersion !== NODE_SCHEMA_FORMAT_VERSION) throw new Error('MEDIA_RESOURCE_SNAPSHOT_INVALID')
  return { id: record.id, checkedAt: record.checkedAt, capability: record.capability, schema: parseComfyObjectInfo(record.schema), schemaFormatVersion }
}

/** 还原完整模型目录并检查每个目录都有可序列化的名称列表。 */
function parseModelSnapshot(value: unknown): ModelSnapshot {
  const record = snapshotRecord(value)
  if (!Array.isArray(record.folders) || record.folders.length > MAX_MODEL_FOLDERS
    || !record.models || typeof record.models !== 'object' || Array.isArray(record.models)) throw new Error('MEDIA_RESOURCE_SNAPSHOT_INVALID')
  const models = record.models as Record<string, unknown>
  const folders: string[] = []
  for (const folder of record.folders) {
    if (typeof folder !== 'string' || folder.length > 4096 || !Object.hasOwn(models, folder)
      || !Array.isArray(models[folder]) || models[folder].length > 100_000
      || models[folder].some((name: unknown) => typeof name !== 'string' || name.length > 4096)) throw new Error('MEDIA_RESOURCE_SNAPSHOT_INVALID')
    folders.push(folder)
  }
  return { id: record.id, checkedAt: record.checkedAt, capability: record.capability, folders,
    models: Object.fromEntries(folders.map((folder) => [folder, models[folder] as string[]])) }
}

/** 目录只接受有界相对路径和文件元数据，正文仍由客户端验证。 */
function parseWorkflowSnapshot(value: unknown): WorkflowSnapshot {
  const record = snapshotRecord(value)
  if (!Array.isArray(record.files) || record.files.length > 10_000) throw new Error('MEDIA_RESOURCE_SNAPSHOT_INVALID')
  const files = record.files.map((value: unknown): ComfyUserWorkflowFile => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MEDIA_RESOURCE_SNAPSHOT_INVALID')
    const file = value as Record<string, unknown>
    if (typeof file.path !== 'string' || !file.path.toLowerCase().endsWith('.json') || file.path.length > 4096
      || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some((part) => !part || part === '.' || part === '..')
      || [file.size, file.modified, file.created].some((field) => typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0)) {
      throw new Error('MEDIA_RESOURCE_SNAPSHOT_INVALID')
    }
    return { path: file.path, size: file.size as number, modified: file.modified as number, created: file.created as number }
  })
  return { id: record.id, checkedAt: record.checkedAt, capability: record.capability, files }
}

/** 存储层已校验完整普通 JSON，这里收窄正文根对象。 */
function parseWorkflowBody(value: unknown): WorkflowBodySnapshot {
  const record = snapshotRecord(value)
  if (!record.definition || typeof record.definition !== 'object' || Array.isArray(record.definition)) throw new Error('MEDIA_RESOURCE_SNAPSHOT_INVALID')
  return { id: record.id, checkedAt: record.checkedAt, capability: record.capability, definition: record.definition as JsonObject }
}

/** 所有 UI 与 Agent 共享的单飞资源目录；缓存命中也必须重新解析当前连接。 */
export class MediaResourceService {
  /** 最多保留 16 个连接代次/用户/来源快照，避免多窗口重复全量读取。 */
  private readonly cache = new Map<string, Promise<SourceSnapshot>>()
  /** 显式刷新复用同一来源尚未完成的请求。 */
  private readonly pending = new Set<string>()
  /** 目录内存层没有 TTL，淘汰后从持久层恢复。 */
  private readonly catalogs = new Map<string, SourceSnapshot>()
  /** 首次拉取与显式同步共用一个在途请求。 */
  private readonly catalogRequests = new Map<string, Promise<SourceSnapshot>>()
  /** 当前服务实例已经尝试过旧节点 schema 迁移的缓存键。 */
  private readonly nodeSchemaMigrationAttempts = new Set<string>()

  constructor(private readonly dependencies: MediaResourceServiceDependencies) {}

  /** 连接测试只访问轻量状态接口，已有目录统计从本地读取。 */
  async probe(connectionId: string, projectId = ''): Promise<MediaConnectionProbe> {
    const context = this.context(connectionId, projectId)
    await context.client.systemStats?.()
    const nodes = this.readCatalog(this.key(context, 'object-info'), parseNodeSnapshot)
    const models = this.readCatalog(this.key(context, 'models-api'), parseModelSnapshot)
    return {
      connectionId,
      checkedAt: Date.now(),
      nodeCount: nodes ? Object.keys(nodes.schema).length : 0,
      modelFolders: models?.folders ?? [],
      modelListing: !models ? 'unknown' : models.capability === 'available' ? 'available' : models.capability === 'unsupported' ? 'unsupported' : 'failed',
      workflowListing: 'unknown',
      assetListing: 'unknown',
    }
  }

  /** 工作流分析只读取已选节点的 schema；不会因资源库查询提前加载。 */
  async getSchema(connectionId: string, projectId: string, classTypes: string[]): Promise<ComfyObjectInfo> {
    if (classTypes.length > 512 || classTypes.some((name) => typeof name !== 'string' || name.length > 256)) throw new Error('MEDIA_RESOURCE_QUERY_INVALID')
    const snapshot = await this.loadNodes(this.context(connectionId, projectId), false)
    return Object.fromEntries([...new Set(classTypes)].filter((name) => snapshot.schema[name])
      .map((name) => [name, structuredClone(snapshot.schema[name]!)]))
  }

  /** 搜索一页单一来源资源；一个页签失败只在该页返回能力状态。 */
  async list(input: MediaResourceQuery): Promise<MediaResourcePage> {
    const offset = input.offset ?? 0
    const limit = input.limit ?? 30
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256))) throw new Error('MEDIA_RESOURCE_QUERY_INVALID')
    const context = this.context(input.connectionId, input.projectId ?? '')
    if (input.kind === 'assets') return await this.listAssets(context, input, offset, limit)

    /** 当前来源的完整有界摘要；分页在清洗和搜索后执行。 */
    let items: MediaResourcePage['items'] = []
    let snapshot: SourceSnapshot
    let source: MediaResourceSource
    let modelFolders: string[] | undefined
    if (input.kind === 'nodes') {
      const nodes = await this.loadNodes(context, input.refresh === true)
      snapshot = nodes
      source = 'object-info'
      items = Object.entries(nodes.schema).map(([id, schema]) => {
        const supported = schema.unsupported !== true && Object.hasOwn(COMFY_CORE_NODE_CONTRACTS, id)
        return { id, name: schema.display_name ?? id, category: schema.category ?? '', supported,
          support: supported ? 'supported' : 'unsupported', source, schema }
      })
    } else if (input.kind === 'models') {
      const models = await this.loadModels(context, input.refresh === true)
      modelFolders = models.folders
      snapshot = models
      source = 'models-api'
      if (models.capability === 'available') {
        const folder = input.folder ?? models.folders[0]
        if (folder) {
          /** 已从新快照移除的目录展示空页，仍返回新目录供用户切换。 */
          const names = models.folders.includes(folder) ? models.models[folder] ?? [] : []
          items = names.map((name) => ({ id: `${folder}:${name}`, name, category: folder, supported: false,
            support: 'unknown', source: 'models-api' }))
        }
      } else if (models.capability === 'unsupported') {
        const nodes = await this.loadNodes(context, input.refresh === true)
        snapshot = { ...nodes, capability: 'unsupported', ...(models.syncError ? { syncError: models.syncError } : {}) }
        source = 'loader-schema'
        for (const [classType, schema] of Object.entries(nodes.schema)) {
          for (const field of COMFY_CORE_NODE_CONTRACTS[classType]?.modelInputs ?? []) {
            const options = schema.input.required[field]?.[0] ?? schema.input.optional?.[field]?.[0]
            if (!Array.isArray(options)) continue
            for (const value of options) if (typeof value === 'string') items.push({
              id: `${classType}:${field}:${value}`, name: value, category: `${classType}.${field}`,
              supported: true, support: 'supported', source,
            })
          }
        }
      }
    } else if (input.kind === 'workflows') {
      const workflows = await this.loadWorkflows(context, input.refresh === true)
      snapshot = workflows
      source = 'user-data'
      items = workflows.files.map((file) => {
        /** 展示名与真实 UserData 相对路径分离。 */
        const name = file.path.split('/').at(-1) ?? file.path
        return {
          id: `user-data:${file.path}`, name, category: file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '',
          supported: false, support: 'unknown', source,
          descriptor: this.descriptor(context, 'user-data', file.path, { workflowPath: file.path }),
          metadata: { size: file.size, modified: file.modified, created: file.created },
        }
      })
    } else throw new Error('MEDIA_RESOURCE_QUERY_INVALID')

    const query = input.query?.toLocaleLowerCase() ?? ''
    items = items.filter((item) => `${item.id} ${item.name} ${item.category}`.toLocaleLowerCase().includes(query))
      .sort((left, right) => left.id.localeCompare(right.id))
    return { ...this.page(context, snapshot, source, items, offset, limit),
      ...(modelFolders ? { modelFolders } : {}) }
  }

  /** 按固定远端描述符读取一个工作流并仅识别格式，不自动执行。 */
  async readWorkflow(descriptor: MediaRemoteDescriptor, projectId = ''): Promise<MediaRemoteWorkflow> {
    if (descriptor.source !== 'user-data' || typeof descriptor.workflowPath !== 'string') throw new Error('MEDIA_REMOTE_RESOURCE_INVALID')
    const context = this.context(descriptor.connectionId, projectId)
    this.assertDescriptor(context, descriptor)
    const directory = await this.loadWorkflows(context, false)
    const file = directory.files.find((file) => file.path === descriptor.workflowPath)
    if (!file) throw new Error('MEDIA_REMOTE_RESOURCE_STALE')
    const key = this.key(context, 'user-data', JSON.stringify(['body', directory.id, file]))
    const snapshot = await this.catalog(key, false, parseWorkflowBody, async () => {
      if (!context.client.readUserWorkflow) throw new ComfyUIError('http', 'ComfyUI UserData 工作流读取接口不受支持', 404)
      const definition = await context.client.readUserWorkflow(file.path)
      return { id: createHash('sha256').update(JSON.stringify(definition)).digest('hex'), checkedAt: Date.now(), capability: 'available', definition }
    })
    return { descriptor: structuredClone(descriptor), format: workflowFormat(snapshot.definition), definition: structuredClone(snapshot.definition) }
  }

  /** 按固定 assets UUID 有界读取原始内容，供 Host 预览或导入项目资产。 */
  async readRemoteAsset(descriptor: MediaRemoteDescriptor, projectId = '', maxBytes = DEFAULT_REMOTE_ASSET_BYTES): Promise<ComfyOutputContent & { descriptor: MediaRemoteDescriptor }> {
    if (descriptor.source !== 'assets-api' || typeof descriptor.assetId !== 'string'
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_REMOTE_ASSET_BYTES) throw new Error('MEDIA_REMOTE_RESOURCE_INVALID')
    const context = this.context(descriptor.connectionId, projectId, maxBytes)
    this.assertDescriptor(context, descriptor)
    if (!context.client.getAssetMetadata) throw new ComfyUIError('http', 'ComfyUI Assets 元数据接口不受支持', 404)
    if (!context.client.getAssetContent) throw new ComfyUIError('http', 'ComfyUI Assets 内容接口不受支持', 404)
    /** 下载前 fresh 获取的远端身份，防止同一 UUID 的内容或 Loader 路径被替换。 */
    const metadata = await context.client.getAssetMetadata(descriptor.assetId)
    if (metadata.id !== descriptor.assetId || (metadata.assetHash ?? undefined) !== descriptor.contentHash
      || (metadata.loaderPath ?? undefined) !== descriptor.loaderPath) throw new Error('MEDIA_REMOTE_RESOURCE_STALE')
    const content = await context.client.getAssetContent(descriptor.assetId)
    if (content.bytes.byteLength > maxBytes) throw new ComfyUIError('size-limit', 'ComfyUI Asset 内容超出调用方大小上限')
    return { descriptor: structuredClone(descriptor), ...content }
  }

  /** 按真实 assets 服务分页；不预取内容，也不读取 object_info。 */
  private async listAssets(context: ResourceContext, input: MediaResourceQuery, offset: number, limit: number): Promise<MediaResourcePage> {
    const source = 'assets-api' as const
    const cacheKey = this.key(context, source, `${offset}:${limit}:${input.query ?? ''}`)
    const snapshot = await this.cached(cacheKey, input.refresh === true, async (): Promise<SourceSnapshot & { result: ComfyAssetPage | null }> => {
      try {
        if (!context.client.listAssets) throw new ComfyUIError('http', 'ComfyUI Assets 列表接口不受支持', 404)
        const result = await context.client.listAssets({ offset, limit, ...(input.query ? { nameContains: input.query } : {}) })
        return { id: createHash('sha256').update(JSON.stringify(result)).digest('hex'), checkedAt: Date.now(), capability: 'available', result }
      } catch (error) {
        const capability = capabilityFromError(error)
        return { id: createHash('sha256').update(capability).digest('hex'), checkedAt: Date.now(), capability, result: null }
      }
    }) as SourceSnapshot & { result: ComfyAssetPage | null }
    if (!snapshot.result) {
      return { connectionId: context.connectionId, instanceGeneration: context.instanceGeneration, remoteUser: context.remoteUser,
        snapshotId: snapshot.id, checkedAt: snapshot.checkedAt, source, capability: snapshot.capability,
        total: 0, nextOffset: null, items: [] }
    }
    {
      const items: MediaResourcePage['items'] = snapshot.result.assets.map((asset) => ({
        id: `assets-api:${asset.id}`, name: asset.displayName ?? asset.name, category: asset.mimeType?.split('/')[0] ?? 'unknown',
        supported: false, support: 'unknown', source,
        descriptor: this.descriptor(context, source, asset.id, {
          assetId: asset.id,
          ...(asset.loaderPath ? { loaderPath: asset.loaderPath } : {}),
          ...(asset.assetHash ? { contentHash: asset.assetHash } : {}),
        }),
        metadata: {
          ...(asset.size === null ? {} : { size: asset.size }),
          ...(asset.mimeType === null ? {} : { mimeType: asset.mimeType }),
          tags: asset.tags,
          createdAt: asset.createdAt,
          updatedAt: asset.updatedAt,
          ...(asset.lastAccessTime === null ? {} : { lastAccessTime: asset.lastAccessTime }),
        },
      }))
      return { connectionId: context.connectionId, instanceGeneration: context.instanceGeneration, remoteUser: context.remoteUser,
        snapshotId: snapshot.id, checkedAt: snapshot.checkedAt, source, capability: snapshot.capability,
        total: snapshot.result.total, nextOffset: snapshot.result.hasMore ? offset + items.length : null, items }
    }
  }

  /** 创建客户端并固定本次调用的连接代次与远端用户。 */
  private context(connectionId: string, projectId: string, maxOutputBytes = DEFAULT_REMOTE_ASSET_BYTES): ResourceContext {
    const resolved = this.dependencies.resolveConnection(connectionId, projectId)
    const options = { baseUrl: resolved.connection.baseUrl, headers: resolved.headers, maxOutputBytes }
    return {
      connectionId,
      instanceGeneration: resolved.connection.instanceGeneration,
      remoteUser: remoteUser(resolved.headers),
      client: this.dependencies.createClient?.(options) ?? new ComfyUIClient(options),
    }
  }

  /** 构造固定到连接、代次、远端用户和服务端 ID 的描述符。 */
  private descriptor(context: ResourceContext, source: MediaRemoteDescriptor['source'], id: string, fields: Partial<MediaRemoteDescriptor>): MediaRemoteDescriptor {
    return { connectionId: context.connectionId, instanceGeneration: context.instanceGeneration, remoteUser: context.remoteUser, source, id, ...fields }
  }

  /** 每次读取正文前重新解析并精确比对身份。 */
  private assertDescriptor(context: ResourceContext, descriptor: MediaRemoteDescriptor): void {
    if (descriptor.connectionId !== context.connectionId || descriptor.instanceGeneration !== context.instanceGeneration
      || descriptor.remoteUser !== context.remoteUser) throw new Error('MEDIA_REMOTE_RESOURCE_STALE')
    if ((descriptor.source === 'user-data' && descriptor.id !== descriptor.workflowPath)
      || (descriptor.source === 'assets-api' && descriptor.id !== descriptor.assetId)) throw new Error('MEDIA_REMOTE_RESOURCE_INVALID')
  }

  /** 节点来源按需加载。 */
  private async loadNodes(context: ResourceContext, refresh: boolean): Promise<NodeSnapshot> {
    const key = this.key(context, 'object-info')
    const cached = this.readCatalog(key, parseNodeSnapshot) as NodeSnapshot | null
    const needsMigration = cached?.schemaFormatVersion !== undefined && cached.schemaFormatVersion < NODE_SCHEMA_FORMAT_VERSION
      && !this.nodeSchemaMigrationAttempts.has(key)
    if (needsMigration) this.nodeSchemaMigrationAttempts.add(key)
    if (cached && !refresh && !needsMigration) return { ...cached, snapshotOrigin: 'local' }
    return await this.catalog(key, refresh || needsMigration, parseNodeSnapshot, async () => {
      const schema = parseComfyObjectCatalog(await context.client.objectInfo())
      return { id: createHash('sha256').update(JSON.stringify(schema)).digest('hex'), checkedAt: Date.now(), capability: 'available', schema, schemaFormatVersion: NODE_SCHEMA_FORMAT_VERSION }
    })
  }

  /** 模型目录独立加载，404/405 只表示该来源不支持。 */
  private async loadModels(context: ResourceContext, refresh: boolean): Promise<ModelSnapshot> {
    return await this.catalog(this.key(context, 'models-api'), refresh, parseModelSnapshot, async (): Promise<ModelSnapshot> => {
      try {
        const folders = await context.client.listModelFolders()
        if (folders.length > MAX_MODEL_FOLDERS) throw new Error('MEDIA_MODEL_FOLDER_LIMIT')
        const models: Record<string, string[]> = Object.fromEntries(folders.map((folder) => [folder, []]))
        /** 每批最多四个请求，等待本批结束再推进，失败不留下后台目录请求。 */
        for (let index = 0; index < folders.length; index += MODEL_SYNC_CONCURRENCY) {
          const batch = folders.slice(index, index + MODEL_SYNC_CONCURRENCY)
          const results = await Promise.allSettled(batch.map((folder) => context.client.listModels(folder)))
          for (const [position, result] of results.entries()) {
            if (result.status === 'rejected') throw result.reason
            models[batch[position]!] = result.value
          }
        }
        return { id: createHash('sha256').update(JSON.stringify({ folders, models })).digest('hex'), checkedAt: Date.now(), capability: 'available', folders, models }
      } catch (error) {
        const capability = capabilityFromError(error)
        if (capability !== 'unsupported' && capability !== 'disabled') throw error
        return { id: createHash('sha256').update(capability).digest('hex'), checkedAt: Date.now(), capability, folders: [], models: {} }
      }
    })
  }

  /** UserData 目录独立加载，列表不读取任何工作流正文。 */
  private async loadWorkflows(context: ResourceContext, refresh: boolean): Promise<WorkflowSnapshot> {
    return await this.catalog(this.key(context, 'user-data'), refresh, parseWorkflowSnapshot, async (): Promise<WorkflowSnapshot> => {
      try {
        if (!context.client.listUserWorkflows) throw new ComfyUIError('http', 'ComfyUI UserData 工作流目录不受支持', 404)
        const files = await context.client.listUserWorkflows()
        /** 每次成功同步都换代，避免远端文件时间精度不足导致正文长期陈旧。 */
        return { id: createHash('sha256').update(JSON.stringify(files)).update(randomUUID()).digest('hex'), checkedAt: Date.now(), capability: 'available', files }
      } catch (error) {
        const capability = capabilityFromError(error)
        if (capability !== 'unsupported' && capability !== 'disabled') throw error
        return { id: createHash('sha256').update(capability).digest('hex'), checkedAt: Date.now(), capability, files: [] }
      }
    })
  }

  /** 构建包含来源身份和能力状态的本地分页。 */
  private page(context: ResourceContext, snapshot: SourceSnapshot, source: MediaResourceSource, items: MediaResourcePage['items'], offset: number, limit: number): MediaResourcePage {
    return { connectionId: context.connectionId, instanceGeneration: context.instanceGeneration, remoteUser: context.remoteUser,
      snapshotId: snapshot.id, checkedAt: snapshot.checkedAt, source, capability: snapshot.capability, total: items.length,
      ...(snapshot.snapshotOrigin ? { snapshotOrigin: snapshot.snapshotOrigin } : {}),
      ...(snapshot.syncError ? { syncError: snapshot.syncError } : {}),
      nextOffset: offset + limit < items.length ? offset + limit : null,
      /** 只复制并清洗当前页节点，避免每次搜索都深复制完整 object_info。 */
      items: items.slice(offset, offset + limit).map((item) => item.schema ? { ...item, schema: publicSchema(item.id, item.schema) } : item) }
  }

  /** 连接代次、远端用户和来源共同组成缓存身份。 */
  private key(context: ResourceContext, source: MediaResourceSource, variant = ''): string {
    return JSON.stringify([context.connectionId, context.instanceGeneration, context.remoteUser, source, variant])
  }

  /** 本地快照读穿内存层；缺失或损坏只返回 miss，不访问远端。 */
  private readCatalog<T extends SourceSnapshot>(key: string, parse: (value: unknown) => T): T | null {
    const snapshot = this.catalogs.get(key) as T | undefined ?? this.dependencies.snapshots?.read(key, parse) ?? null
    if (snapshot) this.rememberCatalog(key, snapshot)
    return snapshot
  }

  /** LRU 只限制常驻内存，完整目录仍保存在磁盘。 */
  private rememberCatalog(key: string, snapshot: SourceSnapshot): void {
    this.catalogs.delete(key)
    this.catalogs.set(key, snapshot)
    while (this.catalogs.size > CACHE_LIMIT) this.catalogs.delete(this.catalogs.keys().next().value!)
  }

  /** 首次拉取后持久化；只有显式同步才更新，失败保留上次成功数据与时间。 */
  private async catalog<T extends SourceSnapshot>(key: string, refresh: boolean, parse: (value: unknown) => T, loader: () => Promise<T>): Promise<T> {
    const previous = this.readCatalog(key, parse)
    if (previous && !refresh) return { ...previous, snapshotOrigin: 'local' }
    const pending = this.catalogRequests.get(key) as Promise<T> | undefined
    if (pending) return await pending
    const request = (async (): Promise<T> => {
      try {
        const snapshot = await loader()
        if (previous && snapshot.capability !== 'available') {
          return { ...previous, snapshotOrigin: 'local', syncError: snapshot.capability }
        }
        /** 临时失败不写盘；下次启动仍可重新首次拉取。 */
        if (['available', 'unsupported', 'disabled'].includes(snapshot.capability)) this.dependencies.snapshots?.write(key, snapshot)
        this.rememberCatalog(key, snapshot)
        return { ...snapshot, snapshotOrigin: 'remote' }
      } catch (error) {
        if (previous) return { ...previous, snapshotOrigin: 'local', syncError: capabilityFromError(error) }
        throw error
      }
    })()
    this.catalogRequests.set(key, request)
    try { return await request } finally { this.catalogRequests.delete(key) }
  }

  /** 60 秒 TTL 的有界单飞缓存；失败条目立即移除。 */
  private async cached<T extends SourceSnapshot>(key: string, refresh: boolean, loader: () => Promise<T>): Promise<T> {
    let request = this.cache.get(key) as Promise<T> | undefined
    if (request && !refresh) {
      const cached = await request
      if (Date.now() - cached.checkedAt > CACHE_TTL_MS) request = undefined
    }
    if (!request || (refresh && !this.pending.has(key))) {
      this.pending.add(key)
      request = loader()
      this.cache.set(key, request)
      const current = request
      void request.then(() => this.pending.delete(key), () => {
        this.pending.delete(key)
        if (this.cache.get(key) === current) this.cache.delete(key)
      })
      while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!)
    }
    return await request
  }
}
