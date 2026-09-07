import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { ComfyUIClient, ComfyUIError } from './comfyui-client'

interface CapturedRequest {
  path: string
  method: string
  authorization: string | null
  formImageName?: string
  formImageType?: string
  formImageBytes?: number[]
  jsonBody?: unknown
}

/** 官方 UserData 列表中的单个工作流文件。 */
const workflowFile = { path: 'nested/demo.json', size: 128, modified: 20, created: 10 }

/** 官方 assets 列表中的单个远端媒体引用。 */
const remoteAsset = {
  id: '0f07dd18-0e66-4b63-b1ea-ecb07056b704',
  name: 'internal-reference-name',
  display_name: 'nested/preview.png',
  loader_path: 'preview.png',
  asset_hash: 'blake3:abc',
  size: 3,
  mime_type: 'image/png',
  tags: ['image'],
  user_metadata: {},
  created_at: '2026-09-07T00:00:00Z',
  updated_at: '2026-09-07T00:00:01Z',
}

let server: ReturnType<typeof Bun.serve>
let baseUrl = ''
let requests: CapturedRequest[] = []

/** 向系统申请当前测试可用的本地端口。 */
async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    /** 仅用于取得临时端口的 TCP 服务。 */
    const reservation = createServer()
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', () => {
      /** 系统分配的监听地址。 */
      const address = reservation.address()
      if (!address || typeof address === 'string') {
        reservation.close()
        reject(new Error('无法分配测试端口'))
        return
      }
      reservation.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

beforeEach(async () => {
  requests = []
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: await reservePort(),
    async fetch(request) {
      const url = new URL(request.url)
      const captured: CapturedRequest = {
        path: `${url.pathname}${url.search}`,
        method: request.method,
        authorization: request.headers.get('authorization'),
      }
      if (url.pathname.endsWith('/upload/image')) {
        const form = await request.formData()
        /** 官方接口始终使用 image 字段承载图片、音频或视频原始字节。 */
        const uploadedFile = form.get('image') as File
        captured.formImageName = uploadedFile.name
        captured.formImageType = uploadedFile.type
        captured.formImageBytes = [...new Uint8Array(await uploadedFile.arrayBuffer())]
        requests.push(captured)
        return Response.json({ name: 'server-renamed.png', subfolder: 'proma', type: 'input' })
      }
      if (request.method === 'POST') captured.jsonBody = await request.json()
      requests.push(captured)
      if (url.pathname.endsWith('/object_info/LoadImage')) return Response.json({ LoadImage: { input: { required: {} }, output: [] } })
      if (url.pathname.endsWith('/models')) return Response.json(['checkpoints', 'vae'])
      if (url.pathname.endsWith('/models/checkpoints')) return Response.json(['base.safetensors'])
      if (url.pathname.endsWith('/system_stats')) return Response.json({ system: { os: 'posix' }, devices: [] })
      if (url.pathname.endsWith('/prompt') && request.method === 'POST') return Response.json({ prompt_id: 'prompt-1', number: 7, node_errors: {} })
      if (url.pathname.endsWith('/queue') && request.method === 'POST') return Response.json({})
      if (url.pathname.endsWith('/queue')) return Response.json({ queue_running: [[7, 'prompt-1', {}, {}, []]], queue_pending: [] })
      if (url.pathname.endsWith('/history/prompt-1')) return Response.json({ 'prompt-1': { prompt: [7, 'prompt-1', {}, {}, []], outputs: {} } })
      if (url.pathname.endsWith('/view')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3', 'content-type': 'image/png' } })
      if (url.pathname.endsWith('/userdata')) return Response.json([workflowFile])
      if (url.pathname.endsWith('/userdata/workflows%2Fnested%2Fdemo.json') || url.pathname.endsWith('/userdata/workflows/nested/demo.json')) {
        return Response.json({ nodes: [], links: [] })
      }
      if (url.pathname.endsWith('/api/assets')) return Response.json({ assets: [remoteAsset], total: 1, has_more: false })
      if (url.pathname.endsWith(`/api/assets/${remoteAsset.id}/content`)) {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3', 'content-type': 'image/png' } })
      }
      if (url.pathname.endsWith(`/api/assets/${remoteAsset.id}`)) return Response.json(remoteAsset)
      return new Response('not found', { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}/proxy/comfy/`
})

afterEach(() => server?.stop(true))

describe('ComfyUI HTTP client', () => {
  test('Given 目录混合合法与不兼容自定义节点 When 读取 Then 保留所有节点并标识不可执行项', async () => {
    /** 第三方输出类型为枚举数组，无法按 Proma 当前端口合同执行。 */
    const client = new ComfyUIClient({ baseUrl, fetch: async () => Response.json({
      LoadImage: { input: { required: {} }, output: ['IMAGE'] },
      CustomEnum: { input: { required: {} }, output: [['a', 'b']], display_name: 'Custom Enum' },
    }) })
    const catalog = await client.objectInfo()
    expect(Object.keys(catalog)).toEqual(['LoadImage', 'CustomEnum'])
    expect(catalog.LoadImage?.output).toEqual(['IMAGE'])
    expect(catalog.CustomEnum).toMatchObject({ unsupported: true, display_name: 'Custom Enum' })
  })

  test('Given 反向代理基址和认证 When 读取能力 Then 保留前缀与认证头', async () => {
    const client = new ComfyUIClient({ baseUrl, headers: { Authorization: 'Bearer secret' } })
    await client.objectInfo('LoadImage')
    expect(requests[0]).toMatchObject({ path: '/proxy/comfy/object_info/LoadImage', authorization: 'Bearer secret' })
    expect(await client.listModelFolders()).toEqual(['checkpoints', 'vae'])
    expect(await client.listModels('checkpoints')).toEqual(['base.safetensors'])
    expect(await client.systemStats()).toEqual({ system: { os: 'posix' }, devices: [] })
  })

  test('Given 图片 Blob When 上传 Then 发送 multipart 并采用服务器改名回执', async () => {
    const client = new ComfyUIClient({ baseUrl })
    const result = await client.uploadImage({
      image: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
      filename: 'local.png',
      subfolder: 'proma',
    })
    expect(requests[0]?.formImageName).toBe('local.png')
    expect(result).toEqual({ name: 'server-renamed.png', subfolder: 'proma', type: 'input' })
  })

  test('Given 音频或视频 Blob When 上传媒体 Then 复用官方 image 字段并保持原始字节', async () => {
    const client = new ComfyUIClient({ baseUrl })
    const audio = await client.uploadMedia({
      media: new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }),
      filename: 'voice.wav',
      subfolder: 'proma/audio',
    })
    expect(requests[0]).toMatchObject({
      formImageName: 'voice.wav',
      formImageBytes: [82, 73, 70, 70],
    })
    expect(requests[0]?.formImageType?.startsWith('audio/')).toBe(true)
    expect(audio).toEqual({ name: 'server-renamed.png', subfolder: 'proma', type: 'input' })

    await client.uploadMedia({
      media: new Blob([new Uint8Array([0, 0, 0, 24])], { type: 'video/mp4' }),
      filename: 'clip.mp4',
    })
    expect(requests[1]).toMatchObject({
      formImageName: 'clip.mp4',
      formImageType: 'video/mp4',
      formImageBytes: [0, 0, 0, 24],
    })
  })

  test('Given 提交成功 When 查询 Then 精确按 prompt_id 读取 queue/history', async () => {
    const client = new ComfyUIClient({ baseUrl, clientId: 'client-1' })
    const submitted = await client.submitPrompt({ '1': { class_type: 'Node', inputs: {} } }, { promptId: 'related-1' })
    expect(submitted.promptId).toBe('prompt-1')
    expect(requests[0]?.jsonBody).toEqual({
      prompt: { '1': { class_type: 'Node', inputs: {} } },
      client_id: 'client-1',
      prompt_id: 'related-1',
    })
    expect(await client.getQueue('prompt-1')).toEqual(expect.objectContaining({ promptId: 'prompt-1', state: 'running' }))
    expect(await client.getHistory('prompt-1')).toEqual(expect.objectContaining({ promptId: 'prompt-1' }))
  })

  test('Given 200 回执含 prompt_id 与 node_errors When 提交 Then 保留 accepted 身份且只有 400 属于明确拒绝', async () => {
    /** 200 回执已分配远端任务身份，即使带节点错误也必须继续追踪该 prompt。 */
    const acceptedClient = new ComfyUIClient({
      baseUrl,
      fetch: async () => Response.json({
        prompt_id: 'prompt-partial',
        number: 8,
        node_errors: { optional_output: { errors: ['缺少可选模型'] } },
      }),
    })
    await expect(acceptedClient.submitPrompt({ '1': { class_type: 'Node', inputs: {} } })).resolves.toEqual({
      promptId: 'prompt-partial',
      number: 8,
      nodeErrors: { optional_output: { errors: ['缺少可选模型'] } },
    })

    /** 4xx 没有 accepted 回执，可以确定为提交验证拒绝。 */
    const rejectedClient = new ComfyUIClient({
      baseUrl,
      fetch: async () => Response.json({ error: 'invalid prompt' }, { status: 400 }),
    })
    await expect(rejectedClient.submitPrompt({ '1': { class_type: 'Node', inputs: {} } }))
      .rejects.toMatchObject({ kind: 'validation-rejected', status: 400 })
  })

  test('Given 指定 prompt id When 取消 Then 只发送定向 delete 而不全局 interrupt', async () => {
    const client = new ComfyUIClient({ baseUrl })
    await client.cancelPrompt('prompt-1')
    expect(requests[0]).toMatchObject({ path: '/proxy/comfy/queue', method: 'POST', jsonBody: { delete: ['prompt-1'] } })
    expect(requests.some((request) => request.path.includes('interrupt'))).toBe(false)
  })

  test('Given 提交超时 When 请求状态未知 Then 不自动重试并标记 unknown-submission', async () => {
    server.stop(true)
    let attempts = 0
    const client = new ComfyUIClient({
      baseUrl,
      timeoutMs: 10,
      fetch: async (_input, init) => {
        attempts += 1
        await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
        throw new Error('unreachable')
      },
    })
    await expect(client.submitPrompt({ '1': { class_type: 'Node', inputs: {} } }))
      .rejects.toMatchObject({ kind: 'unknown-submission' })
    expect(attempts).toBe(1)
  })

  test('Given 已收到响应头但 body 挂起 When 超时 Then GET 与 POST 仍受同一截止时间约束', async () => {
    server.stop(true)
    /** 创建永不主动结束的响应体，用于验证 body 阶段截止时间。 */
    const hangingResponse = (): Response => new Response(new ReadableStream<Uint8Array>({ start() {} }))
    const getClient = new ComfyUIClient({ baseUrl, timeoutMs: 10, fetch: async () => hangingResponse() })
    await expect(getClient.systemStats()).rejects.toMatchObject({ kind: 'timeout' })

    let submitAttempts = 0
    const submitClient = new ComfyUIClient({
      baseUrl,
      timeoutMs: 10,
      fetch: async () => {
        submitAttempts += 1
        return hangingResponse()
      },
    })
    await expect(submitClient.submitPrompt({ '1': { class_type: 'Node', inputs: {} } }))
      .rejects.toMatchObject({ kind: 'unknown-submission' })
    expect(submitAttempts).toBe(1)
  })

  test('Given 调用方在 body 读取期间取消 When 请求 Then 立即响应 AbortSignal', async () => {
    server.stop(true)
    /** 外部调用方单次取消控制器。 */
    const controller = new AbortController()
    const client = new ComfyUIClient({
      baseUrl,
      timeoutMs: 1_000,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ start() {} })),
    })
    /** 等待响应头已返回后触发取消。 */
    setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 10)
    await expect(client.systemStats({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('Given redirect 或非法上传响应 When 调用 Then 严格拒绝', async () => {
    server.stop(true)
    const redirectClient = new ComfyUIClient({ baseUrl, fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }) })
    await expect(redirectClient.systemStats()).rejects.toMatchObject({ kind: 'redirect' })
    const invalidClient = new ComfyUIClient({ baseUrl, fetch: async () => Response.json({ name: '../escape.png', subfolder: '', type: 'input' }) })
    await expect(invalidClient.uploadImage({ image: new Blob(['x']), filename: 'x.png' })).rejects.toMatchObject({ kind: 'validation' })
    const mismatchedTypeClient = new ComfyUIClient({ baseUrl, fetch: async () => Response.json({ name: 'existing.png', subfolder: '', type: 'output' }) })
    await expect(mismatchedTypeClient.uploadImage({ image: new Blob(['x']), filename: 'x.png' })).rejects.toMatchObject({ kind: 'validation' })
  })

  test('Given 输出大小越界 When view 返回 Then 中止读取', async () => {
    const client = new ComfyUIClient({ baseUrl, maxOutputBytes: 2 })
    await expect(client.getOutput({ filename: 'result.png', subfolder: '', type: 'output' }))
      .rejects.toBeInstanceOf(ComfyUIError)
    await expect(client.getOutput({ filename: 'result.png', subfolder: '', type: 'output' }))
      .rejects.toMatchObject({ kind: 'size-limit' })
  })

  test('Given client id When 构建 WebSocket Then 使用 ws 协议、保留前缀且不暴露认证到 URL', () => {
    const client = new ComfyUIClient({ baseUrl, headers: { Authorization: 'Bearer secret' } })
    expect(client.buildWebSocketUrl('client/a')).toBe(`ws://127.0.0.1:${server.port}/proxy/comfy/ws?clientId=client%2Fa`)
    expect(client.getWebSocketOptions()).toEqual({ headers: { Authorization: 'Bearer secret' } })
  })

  test('Given 用户工作流目录 When 列出并读取 Then 使用官方 UserData 参数与编码相对路径', async () => {
    const client = new ComfyUIClient({ baseUrl })
    await expect(client.listUserWorkflows()).resolves.toEqual([workflowFile])
    await expect(client.readUserWorkflow('nested/demo.json')).resolves.toEqual({ nodes: [], links: [] })
    expect(requests[0]?.path).toBe('/proxy/comfy/userdata?dir=workflows&recurse=true&full_info=true')
    expect(requests[1]?.path).toContain('/proxy/comfy/userdata/workflows')
    expect(requests[1]?.path).toContain('demo.json')
  })

  test('Given 非 JSON、遍历或超大工作流 When 读取 Then 在客户端边界拒绝', async () => {
    const client = new ComfyUIClient({ baseUrl, maxJsonBytes: 1_024 })
    await expect(client.readUserWorkflow('../secret.json')).rejects.toMatchObject({ kind: 'validation' })
    await expect(client.readUserWorkflow('demo.png')).rejects.toMatchObject({ kind: 'validation' })
    const oversized = new ComfyUIClient({ baseUrl, maxJsonBytes: 1_024, fetch: async () => new Response('x'.repeat(1_025)) })
    await expect(oversized.readUserWorkflow('demo.json')).rejects.toMatchObject({ kind: 'size-limit' })
    const mixedDirectory = new ComfyUIClient({ baseUrl, fetch: async () => Response.json([
      workflowFile,
      { path: 'README.txt', size: 32, modified: 20, created: 10 },
    ]) })
    await expect(mixedDirectory.listUserWorkflows()).resolves.toEqual([workflowFile])
  })

  test('Given assets 已启用 When 分页与读取内容 Then 保留官方描述符且内容有界', async () => {
    const client = new ComfyUIClient({ baseUrl, maxOutputBytes: 2 })
    await expect(client.listAssets({ offset: 10, limit: 20, nameContains: 'preview' })).resolves.toEqual({
      assets: [expect.objectContaining({ id: remoteAsset.id, displayName: 'nested/preview.png', loaderPath: 'preview.png' })],
      total: 1,
      hasMore: false,
      nextCursor: null,
    })
    expect(requests[0]?.path).toBe('/proxy/comfy/api/assets?limit=20&offset=10&name_contains=preview')
    await expect(client.getAssetMetadata(remoteAsset.id)).resolves.toEqual(expect.objectContaining({
      id: remoteAsset.id,
      assetHash: remoteAsset.asset_hash,
      loaderPath: remoteAsset.loader_path,
    }))
    expect(requests[1]?.path).toBe(`/proxy/comfy/api/assets/${remoteAsset.id}`)
    await expect(client.getAssetContent(remoteAsset.id)).rejects.toMatchObject({ kind: 'size-limit' })
  })

  test('Given assets 未启用或缺认证 When 请求 Then 返回稳定分类', async () => {
    const disabled = new ComfyUIClient({ baseUrl, fetch: async () => Response.json({ error: { code: 'SERVICE_DISABLED', message: 'disabled', details: {} } }, { status: 503 }) })
    await expect(disabled.listAssets({ offset: 0, limit: 20 })).rejects.toMatchObject({ kind: 'service-disabled', status: 503 })
    const unauthorized = new ComfyUIClient({ baseUrl, fetch: async () => new Response('denied', { status: 401 }) })
    await expect(unauthorized.listUserWorkflows()).rejects.toMatchObject({ kind: 'authentication', status: 401 })
  })
})
