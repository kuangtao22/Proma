import { describe, expect, spyOn, test } from 'bun:test'
import { MediaResourceService } from './media-resource-service'

/** 模拟持久层序列化，服务重建后仍共享已保存文件；真实文件边界由 store 测试覆盖。 */
function fixture() {
  const files = new Map<string, unknown>()
  const state = { online: true, generation: 'v1', user: 'alice', version: 1, fixedMetadata: false, removed: false }
  const calls = { nodes: 0, folders: 0, models: 0, workflows: 0, body: 0, stats: 0 }
  /** 每次远端读取前统计并按测试状态模拟断网。 */
  const request = (kind: keyof typeof calls): void => {
    calls[kind] += 1
    if (!state.online) throw new Error('offline')
  }
  /** 不保留对象引用，防止内存 Map 使快照持久化测试误通过。 */
  const snapshots = {
    read<T>(key: string, parse: (value: unknown) => T): T | null {
      return files.has(key) ? parse(structuredClone(files.get(key))) : null
    },
    write(key: string, value: unknown): void { files.set(key, JSON.parse(JSON.stringify(value))) },
  }
  /** 每次创建的服务都没有进程内缓存。 */
  const create = (): MediaResourceService => new MediaResourceService({ snapshots,
    resolveConnection: () => ({ connection: { id: 'gpu', instanceGeneration: state.generation, baseUrl: 'http://localhost/' },
      headers: { 'comfy-user': state.user, Authorization: 'Bearer private-secret' } }),
    createClient: () => ({
      objectInfo: async () => { request('nodes'); return {
        LoadImage: { input: { required: { image: [['private.png'], { image_upload: true }] } }, output: ['IMAGE'], display_name: `Image ${state.version}` },
      } },
      systemStats: async () => { request('stats'); return { system: {} } },
      listModelFolders: async () => { request('folders'); return ['checkpoints', 'vae'] },
      listModels: async (folder) => { request('models'); return [`${folder}-${state.version}.safetensors`] },
      listUserWorkflows: async () => { request('workflows'); return state.removed ? [] : [{ path: 'nested/demo.json', size: 128, modified: state.fixedMetadata ? 1 : state.version, created: 1 }] },
      readUserWorkflow: async () => { request('body'); return { '1': { class_type: 'Node', inputs: { seed: state.version } } } },
    }),
  })
  return { create, state, calls, files }
}

describe('媒体资源持久快照', () => {
  test('Given 已首次同步节点 When 超过旧 TTL 并重建服务离线查询 Then 本地搜索分页和 schema 均不请求远端', async () => {
    const f = fixture()
    const service = f.create()
    const first = await service.list({ connectionId: 'gpu', kind: 'nodes' })
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 3600000)
    try {
      f.state.online = false
      const same = await service.list({ connectionId: 'gpu', kind: 'nodes', query: 'Image', limit: 1 })
      const restored = f.create()
      const page = await restored.list({ connectionId: 'gpu', kind: 'nodes' })
      expect(page.snapshotId).toBe(first.snapshotId)
      expect(page.checkedAt).toBe(first.checkedAt)
      expect(page.snapshotOrigin).toBe('local')
      expect(same.items).toEqual(page.items)
      expect(Object.keys(await restored.getSchema('gpu', '', ['LoadImage']))).toEqual(['LoadImage'])
      expect(f.calls.nodes).toBe(1)
      expect(JSON.stringify([...f.files.values()])).not.toContain('private-secret')
    } finally { clock.mockRestore() }
  })

  test('Given 首次模型同步 When 切换目录和重启后搜索 Then 全部目录模型都可离线读取', async () => {
    const f = fixture()
    const first = await f.create().list({ connectionId: 'gpu', kind: 'models', folder: 'checkpoints' })
    expect(first.modelFolders).toEqual(['checkpoints', 'vae'])
    expect(f.calls.models).toBe(2)
    f.state.online = false
    const second = await f.create().list({ connectionId: 'gpu', kind: 'models', folder: 'vae', query: '1.safetensors' })
    expect(second.items[0]?.name).toBe('vae-1.safetensors')
    expect(second.snapshotOrigin).toBe('local')
    expect(f.calls.folders).toBe(1)
    expect(f.calls.models).toBe(2)
  })

  test('Given 有节点快照 When 显式同步失败 Then 保留内容与成功时间并单独返回同步错误', async () => {
    const f = fixture()
    const service = f.create()
    const first = await service.list({ connectionId: 'gpu', kind: 'nodes' })
    f.state.online = false
    const failed = await service.list({ connectionId: 'gpu', kind: 'nodes', refresh: true })
    expect(failed.items).toEqual(first.items)
    expect(failed.checkedAt).toBe(first.checkedAt)
    expect(failed.syncError).toBe('failed')
    expect(failed.snapshotOrigin).toBe('local')
    expect((await service.list({ connectionId: 'gpu', kind: 'nodes' })).items).toEqual(first.items)
    expect(f.calls.nodes).toBe(2)
    expect((await f.create().list({ connectionId: 'gpu', kind: 'nodes' })).snapshotId).toBe(first.snapshotId)
  })

  test('Given 当前选中目录已不存在 When 读取新模型快照 Then 返回空页和最新目录以便切换', async () => {
    const f = fixture()
    const service = f.create()
    for (const folder of ['removed-folder', '__proto__']) {
      const page = await service.list({ connectionId: 'gpu', kind: 'models', folder })
      expect(page.items).toEqual([])
      expect(page.modelFolders).toEqual(['checkpoints', 'vae'])
    }
    expect(f.calls.models).toBe(2)
  })

  test('Given 有模型快照 When 同步失败后恢复同步 Then 旧模型保留直至新目录整体成功替换', async () => {
    const f = fixture()
    const service = f.create()
    const first = await service.list({ connectionId: 'gpu', kind: 'models' })
    f.state.online = false
    const failed = await service.list({ connectionId: 'gpu', kind: 'models', refresh: true })
    expect(failed.items).toEqual(first.items)
    expect(failed.syncError).toBe('failed')
    f.state.online = true
    f.state.version = 2
    const synced = await service.list({ connectionId: 'gpu', kind: 'models', refresh: true })
    expect(synced.items[0]?.name).toBe('checkpoints-2.safetensors')
    expect(synced.snapshotId).not.toBe(first.snapshotId)
    expect(synced.syncError).toBeUndefined()
  })

  test('Given 已读取工作流 JSON When 服务重建并再次查看 Then 复用正文且目录同步变化后才重新读取', async () => {
    const f = fixture()
    const service = f.create()
    const first = await service.list({ connectionId: 'gpu', kind: 'workflows' })
    const descriptor = first.items[0]!.descriptor!
    expect((await service.readWorkflow(descriptor)).definition['1']).toMatchObject({ inputs: { seed: 1 } })
    f.state.online = false
    expect((await f.create().readWorkflow(descriptor)).definition['1']).toMatchObject({ inputs: { seed: 1 } })
    expect(f.calls.body).toBe(1)
    f.state.online = true
    f.state.version = 2
    await service.list({ connectionId: 'gpu', kind: 'workflows', refresh: true })
    expect((await service.readWorkflow(descriptor)).definition['1']).toMatchObject({ inputs: { seed: 2 } })
    expect(f.calls.workflows).toBe(2)
    expect(f.calls.body).toBe(2)
  })

  test('Given 多个同时同步请求 When 来源相同 Then 共享一次拉取', async () => {
    const f = fixture()
    const service = f.create()
    await service.list({ connectionId: 'gpu', kind: 'nodes' })
    await Promise.all([service.list({ connectionId: 'gpu', kind: 'nodes', refresh: true }),
      service.list({ connectionId: 'gpu', kind: 'nodes', refresh: true })])
    expect(f.calls.nodes).toBe(2)
  })

  test('Given 远端工作流时间与大小未变 When 显式同步目录 Then 已缓存正文仍在下次查看时更新', async () => {
    const f = fixture()
    f.state.fixedMetadata = true
    const service = f.create()
    const descriptor = (await service.list({ connectionId: 'gpu', kind: 'workflows' })).items[0]!.descriptor!
    await service.readWorkflow(descriptor)
    f.state.version = 2
    await service.list({ connectionId: 'gpu', kind: 'workflows', refresh: true })
    expect((await service.readWorkflow(descriptor)).definition['1']).toMatchObject({ inputs: { seed: 2 } })
    expect(f.calls.body).toBe(2)
  })

  test('Given 工作流已从远端目录移除 When 同步后读取旧描述符 Then 不能回退已保存的旧正文', async () => {
    const f = fixture()
    const service = f.create()
    const descriptor = (await service.list({ connectionId: 'gpu', kind: 'workflows' })).items[0]!.descriptor!
    await service.readWorkflow(descriptor)
    f.state.removed = true
    await service.list({ connectionId: 'gpu', kind: 'workflows', refresh: true })
    await expect(service.readWorkflow(descriptor)).rejects.toThrow('MEDIA_REMOTE_RESOURCE_STALE')
    expect(f.calls.body).toBe(1)
  })

  test('Given 首次没有快照且离线 When 网络恢复后普通读取 Then 模型与工作流仍会完成首次同步', async () => {
    for (const kind of ['models', 'workflows'] as const) {
      const f = fixture()
      const service = f.create()
      f.state.online = false
      await expect(service.list({ connectionId: 'gpu', kind })).rejects.toThrow('offline')
      f.state.online = true
      const page = await service.list({ connectionId: 'gpu', kind })
      expect(page.capability).toBe('available')
      expect(page.items.length).toBeGreaterThan(0)
    }
  })

  test('Given 已保存快照 When 连接代次或远端用户改变 Then 不读取其它身份的旧目录', async () => {
    const f = fixture()
    await f.create().list({ connectionId: 'gpu', kind: 'nodes' })
    f.state.online = false
    f.state.generation = 'v2'
    await expect(f.create().list({ connectionId: 'gpu', kind: 'nodes' })).rejects.toThrow('offline')
    f.state.generation = 'v1'
    f.state.user = 'bob'
    await expect(f.create().list({ connectionId: 'gpu', kind: 'nodes' })).rejects.toThrow('offline')
  })

  test('Given 测试连接 When 尚未同步或已有节点快照 Then 仅访问轻量状态接口且不强制拉目录', async () => {
    const f = fixture()
    const service = f.create()
    const cold = await service.probe('gpu')
    expect(cold.modelListing).toBe('unknown')
    expect(f.calls).toEqual({ nodes: 0, folders: 0, models: 0, workflows: 0, body: 0, stats: 1 })
    await service.list({ connectionId: 'gpu', kind: 'nodes' })
    expect((await service.probe('gpu')).nodeCount).toBe(1)
    expect(f.calls.nodes).toBe(1)
    expect(f.calls.stats).toBe(2)
  })
})
