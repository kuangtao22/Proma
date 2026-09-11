import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComfyObjectInfo, ComfyPrompt } from '@proma/shared'
import { ComfyUIClient } from './comfyui-client'
import type { ComfyFetch } from './comfyui-client'
import { MediaConfigStore } from './media-config-store'
import { MediaRunService } from './media-run-service'

/** 每个用例的隔离配置根，测试结束后统一释放。 */
const directories: string[] = []

/**
 * 通过真实 HTTP parser 与运行持久化边界构造纯标量工作流。
 * @param processorCount 不同处理节点种类数，用于核查有界并发。
 * @returns 可注入响应的服务、请求记录和准备入参。
 */
function createFixture(processorCount = 1) {
  /** 本用例独立的数据目录。 */
  const directory = mkdtempSync(join(tmpdir(), 'proma-run-schema-'))
  directories.push(directory)
  /** 权威模板存储。 */
  const configuration = new MediaConfigStore(directory)
  /** 各处理节点的真实 schema 子集。 */
  const schema: ComfyObjectInfo = {
    SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } }, output: [], output_node: true },
  }
  /** 多个来源类共享同一输出类，验证去重。 */
  const prompt: ComfyPrompt = {}
  for (let index = 0; index < processorCount; index += 1) {
    /** 当前 class 名同时用于模板与服务器返回，避免猜测不存在的节点。 */
    const name = `ImageSource${index}`
    schema[name] = { input: { required: { value: ['FLOAT'] } }, output: ['IMAGE'] }
    prompt[`source${index}`] = { class_type: name, inputs: { value: 1 } }
    prompt[`save${index}`] = { class_type: 'SaveImage', inputs: { images: [`source${index}`, 0], filename_prefix: 'Proma' } }
  }
  configuration.saveConnection({ id: 'gpu', name: 'GPU', driver: 'comfyui', baseUrl: 'http://localhost:8188/proxy/',
    enabled: true, projectIds: ['project'], auth: { kind: 'none' } }, 0)
  configuration.saveWorkflow({ id: 'workflow', name: '图', projectId: null, definition: {
    schemaVersion: 1, prompt, bindings: [], outputs: Array.from({ length: processorCount }, (_, index) => ({
      key: `image${index}`, nodeId: `save${index}`, outputIndex: 0, mediaType: 'image' as const,
    })),
  } }, 1)
  /** HTTP 请求路径，禁止退回完整目录。 */
  const requests: string[] = []
  /** 真实提交数，准备失败不得触发。 */
  let submits = 0
  /** 可切换的权限状态，用于异步等待后的撤权验证。 */
  let authorized = true
  /** 可替换的只读远端响应。 */
  let respond: ComfyFetch = async (url) => {
    /** URL 尾段就是本次请求的精确节点类型。 */
    const name = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1)!)
    if (name === 'object_info') throw new Error('禁止读取完整目录')
    return Response.json(schema[name] ? { [name]: schema[name] } : {})
  }
  /** 使用生产客户端解析响应，仅模拟传输。 */
  const client = new ComfyUIClient({ baseUrl: 'http://localhost:8188/proxy/', fetch: async (url, init) => {
    requests.push(new URL(String(url)).pathname)
    if (String(url).endsWith('/prompt')) {
      submits += 1
      return Response.json({ prompt_id: 'accepted', number: 1, node_errors: {} })
    }
    return respond(url, init)
  } })
  /** 每次重建服务均读取同一磁盘 manifest，覆盖恢复合同。 */
  const createService = (): MediaRunService => new MediaRunService({
    configuration, getRunsDirectory: () => join(directory, 'runs'),
    authorize: () => { if (!authorized) throw new Error('CANVAS_ACCESS_DENIED') },
    readAsset: async () => { throw new Error('标量工作流不得读取素材') },
    registerOutput: async () => { throw new Error('本用例不收集媒体') },
    createClient: () => client,
  })
  return { createService, schema, requests, directory,
    input: { projectId: 'project', operationId: 'action', connectionId: 'gpu', workflowId: 'workflow', workflowRevision: 1,
      mediaKind: 'image' as const, inputs: {} },
    setResponder: (fetch: ComfyFetch): void => { respond = fetch },
    revoke: (): void => { authorized = false },
    getSubmits: (): number => submits,
  }
}

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('运行只读取当前图的实时节点接口', () => {
  test('Given 服务器完整目录不可读 When 准备并重启执行 Then 去重查询使用的类且不依赖其他节点', async () => {
    /** 两个来源和一个共用输出类。 */
    const fixture = createFixture(2)
    /** 准备只保存固定图，不提交任务。 */
    const prepared = await fixture.createService().prepareDraft(fixture.input)
    expect(prepared.phase).toBe('prepared')
    expect(fixture.getSubmits()).toBe(0)
    expect(fixture.requests.toSorted()).toEqual(['/proxy/object_info/ImageSource0', '/proxy/object_info/ImageSource1', '/proxy/object_info/SaveImage'])
    fixture.schema.Unrelated = { input: { required: {} }, output: [] }
    /** 重启后用相同相关 schema 可继续，仅提交一次。 */
    const queued = await fixture.createService().advance('project', prepared.id, prepared.revision)
    expect(queued.phase).toBe('queued')
    expect(fixture.getSubmits()).toBe(1)
    expect(fixture.requests.filter((path) => path.includes('object_info'))).toHaveLength(6)
  })

  test('Given 多个节点类 When 并发读取 Then 最多四个在途且成功后完整收口', async () => {
    /** 六个来源加一个输出，超过并发上限。 */
    const fixture = createFixture(6)
    /** 首批请求的可控完成回调。 */
    const pending: Array<() => void> = []
    /** 当前和最大在途读取数。 */
    let active = 0
    let maximum = 0
    /** 首批四个请求到齐后解除测试等待。 */
    const started = Promise.withResolvers<void>()
    fixture.setResponder(async (url) => {
      /** 当前请求的 class。 */
      const name = new URL(String(url)).pathname.split('/').at(-1)!
      if (name === 'object_info') return Response.json(fixture.schema)
      active += 1
      maximum = Math.max(maximum, active)
      if (pending.length < 4) {
        await new Promise<void>((resolve) => { pending.push(resolve); if (pending.length === 4) started.resolve() })
      }
      active -= 1
      return Response.json({ [name]: fixture.schema[name] })
    })
    /** 待完成的真实准备动作。 */
    const preparing = fixture.createService().prepareDraft(fixture.input)
    await Promise.race([started.promise, preparing])
    expect(active).toBe(4)
    pending.forEach((resolve) => resolve())
    expect((await preparing).phase).toBe('prepared')
    expect(maximum).toBe(4)
    expect(active).toBe(0)
    expect(fixture.requests).toHaveLength(7)
  })

  test('Given 一个节点查询失败 When 其他请求仍在途 Then 取消并等待它们结束且不创建运行', async () => {
    /** 多于首批并发容量，错误后不得再发起余下查询。 */
    const fixture = createFixture(6)
    /** 正在等待的请求数。 */
    let active = 0
    fixture.setResponder(async (_url, init) => {
      if (fixture.requests.length === 1) return new Response('', { status: 401 })
      active += 1
      try {
        await new Promise<void>((_resolve, reject) => {
          if (init?.signal?.aborted) { reject(init.signal.reason); return }
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
        throw new Error('取消请求不应成功')
      } finally { active -= 1 }
    })
    await expect(fixture.createService().prepareDraft(fixture.input)).rejects.toMatchObject({ kind: 'authentication' })
    expect(active).toBe(0)
    expect(fixture.requests.length).toBeLessThanOrEqual(4)
    expect(readdirSync(join(fixture.directory, 'runs')).filter((name) => name.endsWith('.json'))).toEqual([])
    expect(fixture.getSubmits()).toBe(0)
  })

  test('Given 实时查询期间撤权 When 响应返回 Then 禁止保存准备事实', async () => {
    /** 当前主体在响应返回时不再具备权限。 */
    const fixture = createFixture()
    fixture.setResponder(async (url) => {
      fixture.revoke()
      /** 仍返回合法 schema，必须由调用后授权复验拒绝。 */
      const name = new URL(String(url)).pathname.split('/').at(-1)!
      return Response.json(name === 'object_info' ? fixture.schema : { [name]: fixture.schema[name] })
    })
    await expect(fixture.createService().prepareDraft(fixture.input)).rejects.toThrow('CANVAS_ACCESS_DENIED')
    expect(readdirSync(join(fixture.directory, 'runs')).filter((name) => name.endsWith('.json'))).toEqual([])
  })

  test('Given 使用的节点已卸载 When 单类接口返回空目录 Then 提供节点诊断且不创建运行', async () => {
    /** 模拟升级后缺少当前图的来源节点。 */
    const fixture = createFixture()
    delete fixture.schema.ImageSource0
    await expect(fixture.createService().prepareDraft(fixture.input)).rejects.toThrow('NODE_CLASS_UNKNOWN@source0')
    expect(fixture.getSubmits()).toBe(0)
    expect(readdirSync(join(fixture.directory, 'runs')).filter((name) => name.endsWith('.json'))).toEqual([])
  })

  test('Given 单类响应均未超限但累计超过八 MiB When 准备 Then 有界失败且不保存不完整接口', async () => {
    /** 六个合法接口合计超过原完整目录的内存预算。 */
    const fixture = createFixture(6)
    for (let index = 0; index < 6; index += 1) {
      fixture.schema[`ImageSource${index}`]!.input.optional = Object.fromEntries(
        Array.from({ length: 100 }, (_, field) => [`extra${field}`, ['FLOAT', { tooltip: 'x'.repeat(15_000) }]]),
      )
    }
    await expect(fixture.createService().prepareDraft(fixture.input)).rejects.toMatchObject({ kind: 'size-limit' })
    expect(fixture.getSubmits()).toBe(0)
    expect(readdirSync(join(fixture.directory, 'runs')).filter((name) => name.endsWith('.json'))).toEqual([])
  })

  test('Given 准备后实际使用节点变化 When 重启执行 Then 保留原快照并在提交前拒绝', async () => {
    /** 同一模板的实时接口在准备后发生变化。 */
    const fixture = createFixture()
    /** 首次准备固定旧接口。 */
    const prepared = await fixture.createService().prepareDraft(fixture.input)
    fixture.schema.ImageSource0!.input.required.value = ['FLOAT', { min: 0, max: 10 }]
    await expect(fixture.createService().advance('project', prepared.id, prepared.revision)).rejects.toThrow('MEDIA_SCHEMA_CHANGED')
    expect(fixture.getSubmits()).toBe(0)
    expect(fixture.createService().get('project', prepared.id).phase).toBe('prepared')
  })
})
