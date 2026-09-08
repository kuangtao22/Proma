import { describe, expect, test } from 'bun:test'
import type { JsonObject } from '@proma/shared'
import { MediaResourceService } from './media-resource-service'
import { ComfyUIError } from './comfyui-client'

/** 资源目录中的实际 schema fixture，图片枚举包含不得作为模型公开的远端用户文件。 */
const schema = {
  LoadImage: { input: { required: { image: [['private.png'], { image_upload: true }] } }, output: ['IMAGE'], category: 'image' },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['model-a.safetensors']] } }, output: ['MODEL', 'CLIP', 'VAE'], category: 'loaders' },
}

/** 远端目录客户端的完整最小夹具。 */
const defaultClient = {
  objectInfo: async () => schema,
  listModelFolders: async () => ['checkpoints'],
  listModels: async (_folder: string) => ['model-a.safetensors'],
  listUserWorkflows: async () => [{ path: 'nested/demo.json', size: 128, modified: 20, created: 10 }],
  readUserWorkflow: async (_path: string): Promise<JsonObject> => ({ nodes: [], links: [] }),
  listAssets: async (_options: { offset: number; limit: number }) => ({ assets: [{ id: '0f07dd18-0e66-4b63-b1ea-ecb07056b704', name: 'internal', displayName: 'photo.png', loaderPath: 'photo.png', assetHash: 'blake3:abc', size: 3, mimeType: 'image/png', tags: [], userMetadata: {}, metadata: null, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:01Z', lastAccessTime: null }], total: 1, hasMore: false, nextCursor: null }),
  getAssetMetadata: async (_assetId: string) => ({ id: '0f07dd18-0e66-4b63-b1ea-ecb07056b704', name: 'internal', displayName: 'photo.png', loaderPath: 'photo.png', assetHash: 'blake3:abc', size: 3, mimeType: 'image/png', tags: [], userMetadata: {}, metadata: null, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:01Z', lastAccessTime: null }),
  getAssetContent: async (_assetId: string) => ({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' }),
}

/** 为单个行为覆盖必要的客户端方法。 */
function client(overrides: Partial<typeof defaultClient> = {}): typeof defaultClient {
  return { ...defaultClient, ...overrides }
}

describe('ComfyUI 资源目录', () => {
  test('Given 旧节点 schema 快照 When 首次迁移失败 Then 保留旧内容且同实例不重复请求', async () => {
    let reads = 0
    const stored = new Map<string, unknown>([['legacy-key', {
      id: 'a'.repeat(64), checkedAt: 1, capability: 'available', schema,
    }]])
    const service = new MediaResourceService({
      resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: 'v1', baseUrl: 'http://localhost/' }, headers: {} }),
      createClient: () => ({ ...defaultClient, objectInfo: async () => { reads += 1; throw new Error('offline') } }),
      snapshots: {
        read: (_key, parse) => {
          const value = stored.get('legacy-key')
          return value === undefined ? null : parse(value)
        },
        write: () => undefined,
      },
    })
    const first = await service.list({ connectionId: 'gpu', kind: 'nodes' })
    const second = await service.list({ connectionId: 'gpu', kind: 'nodes' })
    expect(first.total).toBe(2)
    expect(second.total).toBe(2)
    expect(reads).toBe(1)
  })

  test('Given 旧节点 schema 快照 When 迁移成功 Then 持久化新版本且重建服务不再联网；显式刷新仍可重试', async () => {
    const legacy = { id: 'a'.repeat(64), checkedAt: 1, capability: 'available', schema }
    const stored = new Map<string, unknown>([['legacy-key', legacy]])
    let reads = 0
    let fail = true
    const snapshots = {
      read: <T,>(_key: string, parse: (value: unknown) => T): T | null => parse(stored.get('legacy-key')),
      write: (_key: string, value: unknown) => { stored.set('legacy-key', value) },
    }
    const create = () => new MediaResourceService({
      resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: 'v1', baseUrl: 'http://localhost/' }, headers: {} }),
      createClient: () => ({ ...defaultClient, objectInfo: async () => {
        reads += 1
        if (fail) throw new Error('offline')
        return schema
      } }),
      snapshots,
    })
    const failedService = create()
    await failedService.list({ connectionId: 'gpu', kind: 'nodes' })
    await failedService.list({ connectionId: 'gpu', kind: 'nodes', refresh: true })
    expect(reads).toBe(2)
    fail = false
    await failedService.list({ connectionId: 'gpu', kind: 'nodes', refresh: true })
    expect(reads).toBe(3)
    expect((stored.get('legacy-key') as { schemaFormatVersion: number }).schemaFormatVersion).toBe(2)

    const rebuiltService = create()
    await rebuiltService.list({ connectionId: 'gpu', kind: 'nodes' })
    expect(reads).toBe(3)
  })

  test('Given 原生节点的 schema 被标记不兼容 When 查询目录 Then 保持可见且不能标成支持执行', async () => {
    /** 即使 class_type 命中本地已知合同，也要尊重当前实例的 schema 状态。 */
    const service = new MediaResourceService({
      resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: 'v1', baseUrl: 'http://localhost/' }, headers: {} }),
      createClient: () => ({ ...defaultClient, objectInfo: async () => ({
        LoadImage: { input: { required: {} }, output: [], unsupported: true },
        'Custom / Node': { input: { required: {} }, output: [], unsupported: true },
      }) }),
    })
    const page = await service.list({ connectionId: 'gpu', kind: 'nodes' })
    expect(page.total).toBe(2)
    expect(page.items.find((item) => item.id === 'LoadImage')).toMatchObject({ id: 'LoadImage', supported: false, support: 'unsupported', schema: { unsupported: true } })
    expect(page.items.find((item) => item.id === 'Custom / Node')).toMatchObject({ support: 'unsupported' })
  })

  test('Given 多个 Agent 同时查询 When 使用同一实例 Then 单飞读取且目录不暴露素材枚举', async () => {
    let reads = 0
    const service = new MediaResourceService({
      resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: 'v1', baseUrl: 'http://localhost/' }, headers: {} }),
      createClient: () => ({ objectInfo: async () => { reads += 1; return schema }, listModelFolders: async () => ['checkpoints'], listModels: async () => ['model-a.safetensors'] }),
    })
    const results = await Promise.all([service.list({ projectId: 'p', connectionId: 'gpu', kind: 'nodes', limit: 1 }), service.list({ projectId: 'p', connectionId: 'gpu', kind: 'nodes', limit: 1 })])
    expect(reads).toBe(1)
    expect(results[0]?.total).toBe(2)
    expect(results[0]?.nextOffset).toBe(1)
    const images = await service.list({ projectId: 'p', connectionId: 'gpu', kind: 'nodes', query: 'LoadImage' })
    expect(JSON.stringify(images)).not.toContain('private.png')
  })

  test('Given models端点不支持 When 查询模型 Then 返回标明Loader来源的实际枚举', async () => {
    const service = new MediaResourceService({
      resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: 'v1', baseUrl: 'http://localhost/' }, headers: {} }),
      createClient: () => ({ objectInfo: async () => schema, listModelFolders: async () => { throw new ComfyUIError('http', '未支持', 404) }, listModels: async () => [] }),
    })
    const models = await service.list({ projectId: 'p', connectionId: 'gpu', kind: 'models' })
    expect(models.items[0]?.name).toBe('model-a.safetensors')
    expect(models.items[0]?.category).toBe('CheckpointLoaderSimple.ckpt_name')
    expect((await service.probe('gpu', 'p')).modelListing).toBe('unsupported')
  })

  test('Given 项目权限被撤销 When 缓存命中 Then 仍重新校验权限', async () => {
    let allowed = true
    const service = new MediaResourceService({
      resolveConnection: () => { if (!allowed) throw new Error('DENIED'); return { connection: { id: 'gpu', instanceGeneration: 'v1', baseUrl: 'http://localhost/' }, headers: {} } },
      createClient: () => ({ objectInfo: async () => schema, listModelFolders: async () => [], listModels: async () => [] }),
    })
    await service.list({ projectId: 'p', connectionId: 'gpu', kind: 'nodes' })
    allowed = false
    await expect(service.list({ projectId: 'p', connectionId: 'gpu', kind: 'nodes' })).rejects.toThrow('DENIED')
  })

  test('Given 直接打开工作流或资源库 When 查询 Then 不读取 object_info 且来源失败互不覆盖', async () => {
    let nodeReads = 0
    const service = new MediaResourceService({
      resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: 'v1', baseUrl: 'http://localhost/' }, headers: { 'comfy-user': 'alice' } }),
      createClient: () => client({ objectInfo: async () => { nodeReads += 1; throw new Error('nodes unavailable') } }),
    })
    const workflows = await service.list({ projectId: '', connectionId: 'gpu', kind: 'workflows' })
    const assets = await service.list({ projectId: '', connectionId: 'gpu', kind: 'assets' })
    expect(nodeReads).toBe(0)
    expect(workflows.items[0]).toMatchObject({ name: 'demo.json', source: 'user-data', support: 'unknown' })
    expect(assets.items[0]).toMatchObject({ name: 'photo.png', source: 'assets-api', support: 'unknown' })
    expect(workflows.remoteUser).toBe('alice')
    expect(assets.instanceGeneration).toBe('v1')
  })

  test('Given 远端描述符 When 读取工作流和素材 Then 固定连接代次与远端用户并识别格式', async () => {
    /** 记录 fresh 元数据复核与正文下载的调用顺序。 */
    const assetReads: string[] = []
    const service = new MediaResourceService({
      resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: 'v1', baseUrl: 'http://localhost/' }, headers: { 'Comfy-User': 'alice' } }),
      createClient: () => client({
        getAssetMetadata: async (assetId) => { assetReads.push(`metadata:${assetId}`); return await defaultClient.getAssetMetadata(assetId) },
        getAssetContent: async (assetId) => { assetReads.push(`content:${assetId}`); return await defaultClient.getAssetContent(assetId) },
      }),
    })
    const workflowPage = await service.list({ projectId: '', connectionId: 'gpu', kind: 'workflows' })
    const assetPage = await service.list({ projectId: '', connectionId: 'gpu', kind: 'assets' })
    const workflow = await service.readWorkflow(workflowPage.items[0]!.descriptor!)
    expect(workflow).toMatchObject({ format: 'ui', definition: { nodes: [], links: [] } })
    const asset = await service.readRemoteAsset(assetPage.items[0]!.descriptor!)
    expect(asset.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(assetReads).toEqual([
      'metadata:0f07dd18-0e66-4b63-b1ea-ecb07056b704',
      'content:0f07dd18-0e66-4b63-b1ea-ecb07056b704',
    ])
  })

  test('Given 远端素材的 id、hash 或 loaderPath 已变化 When 读取旧描述符 Then 下载正文前拒绝', async () => {
    /** 分别模拟 UUID、内容 hash 和 Loader 路径在列表之后发生变化。 */
    for (const metadata of [
      { id: '1f07dd18-0e66-4b63-b1ea-ecb07056b704', assetHash: 'blake3:abc', loaderPath: 'photo.png' },
      { assetHash: 'blake3:changed', loaderPath: 'photo.png' },
      { assetHash: 'blake3:abc', loaderPath: 'moved/photo.png' },
    ]) {
      /** 统计正文请求，证明 stale 描述符不会触发大文件下载。 */
      let contentReads = 0
      const service = new MediaResourceService({
        resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: 'v1', baseUrl: 'http://localhost/' }, headers: {} }),
        createClient: () => client({
          getAssetMetadata: async (assetId) => ({ ...await defaultClient.getAssetMetadata(assetId), ...metadata }),
          getAssetContent: async (assetId) => { contentReads += 1; return await defaultClient.getAssetContent(assetId) },
        }),
      })
      /** 列表生成的旧描述符固定初始 hash 与 loaderPath。 */
      const descriptor = (await service.list({ connectionId: 'gpu', kind: 'assets' })).items[0]!.descriptor!
      await expect(service.readRemoteAsset(descriptor)).rejects.toThrow('MEDIA_REMOTE_RESOURCE_STALE')
      expect(contentReads).toBe(0)
    }
  })

  test('Given ComfyUI API prompt When 读取远端工作流 Then 明确标记 API 格式但不执行', async () => {
    let reads = 0
    const service = new MediaResourceService({
      resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: 'v1', baseUrl: 'http://localhost/' }, headers: {} }),
      createClient: () => client({ readUserWorkflow: async () => {
        reads += 1
        return { '1': { class_type: 'KSampler', inputs: {} } }
      } }),
    })
    const descriptor = (await service.list({ connectionId: 'gpu', kind: 'workflows' })).items[0]!.descriptor!
    await expect(service.readWorkflow(descriptor)).resolves.toMatchObject({ format: 'api' })
    expect(reads).toBe(1)
  })

  test('Given 连接代次或远端用户变化 When 使用旧描述符 Then fail closed', async () => {
    let generation = 'v1'
    const service = new MediaResourceService({
      resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: generation, baseUrl: 'http://localhost/' }, headers: { 'comfy-user': 'alice' } }),
      createClient: () => client(),
    })
    const descriptor = (await service.list({ projectId: '', connectionId: 'gpu', kind: 'workflows' })).items[0]!.descriptor!
    generation = 'v2'
    await expect(service.readWorkflow(descriptor)).rejects.toThrow('MEDIA_REMOTE_RESOURCE_STALE')
  })

  test('Given 描述符真实路径被篡改 When 读取 Then 不使用展示字段或借用旧身份寻址', async () => {
    const service = new MediaResourceService({
      resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: 'v1', baseUrl: 'http://localhost/' }, headers: {} }),
      createClient: () => client(),
    })
    const descriptor = (await service.list({ projectId: '', connectionId: 'gpu', kind: 'workflows' })).items[0]!.descriptor!
    await expect(service.readWorkflow({ ...descriptor, workflowPath: 'other.json' })).rejects.toThrow('MEDIA_REMOTE_RESOURCE_INVALID')
  })

  test('Given assets 端点状态不同 When 列资源 Then 明确区分不支持、未启用和缺认证', async () => {
    for (const [error, capability] of [
      [new ComfyUIError('http', 'missing', 404), 'unsupported'],
      [new ComfyUIError('service-disabled', 'disabled', 503), 'disabled'],
      [new ComfyUIError('authentication', 'denied', 403), 'authentication-required'],
    ] as const) {
      const service = new MediaResourceService({
        resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: 'v1', baseUrl: 'http://localhost/' }, headers: {} }),
        createClient: () => client({ listAssets: async () => { throw error } }),
      })
      const page = await service.list({ projectId: '', connectionId: 'gpu', kind: 'assets' })
      expect(page.capability).toBe(capability)
      expect(page.items).toEqual([])
    }
  })
})
