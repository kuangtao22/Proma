import { describe, expect, test } from 'bun:test'
import { IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES } from '@proma/shared'
import {
  ImageGenerationCatalogService,
  type ImageGenerationCatalogFetch,
  type ImageGenerationCliResult,
} from './image-generation-catalog-service'

/** 只回放固定 JSON 的 fetch 替身。 */
function createFetchStub(body: unknown, status = 200): ImageGenerationCatalogFetch {
  return async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 创建只抛出固定结构化错误的 fetch 替身。 */
function createRejectingFetch(error: unknown): ImageGenerationCatalogFetch {
  return async () => { throw error }
}

/** 创建使用草稿密钥的 OpenAI 图片目录输入。 */
function createOpenAiInput(baseUrl = 'https://api.openai.com/v1'): Record<string, unknown> {
  return {
    requestId: 'fetch-openai',
    provider: 'openai-images',
    baseUrl,
    credential: { mode: 'draft', apiKey: 'secret' },
  }
}

/** 记录 CLI 调用的替身。 */
function createCliStub(result: ImageGenerationCliResult): {
  runCli: (args: readonly string[], cliPath: string) => Promise<ImageGenerationCliResult>
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    runCli: async (args, cliPath) => { calls.push(`${cliPath} ${args.join(' ')}`); return result },
  }
}

describe('生图供应商目录拉取', () => {
  test('Given OpenAI 同时返回对话与图像模型 When 拉取 Then 只保留图像模型并推断能力', async () => {
    const service = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => { throw new Error('unused') } },
      fetchImpl: createFetchStub({ data: [
        { id: 'gpt-4o' },
        { id: 'gpt-image-1' },
        { id: 'dall-e-3' },
        { id: 'gpt-image-1' },
      ] }),
    })

    const result = await service.fetch({
      requestId: 'fetch-1',
      provider: 'openai-images',
      baseUrl: 'https://api.openai.com/v1',
      credential: { mode: 'draft', apiKey: 'secret' },
    })

    expect(result.state).toBe('success')
    expect(result.models).toEqual([
      { id: 'gpt-image-1', capabilities: ['text-to-image', 'image-to-image'] },
      { id: 'dall-e-3', capabilities: ['text-to-image'] },
    ])
  })

  test('Given MiniMax 只返回对话模型 When 拉取 Then 成功但清单为空', async () => {
    const service = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => 'saved-secret' },
      fetchImpl: createFetchStub({ data: [{ id: 'MiniMax-M2' }] }),
    })

    const result = await service.fetch({
      requestId: 'fetch-1',
      provider: 'minimax',
      baseUrl: 'https://api.minimax.cn/v1',
      credential: { mode: 'saved', profileId: 'minimax-1' },
    })

    /** 端点可用但确实没有图像模型时仍算成功，界面提示手填。 */
    expect(result.state).toBe('success')
    expect(result.models).toEqual([])
  })

  test('Given 即梦 CLI 已登录 When 拉取 Then 返回内置 model_version 清单', async () => {
    const cli = createCliStub({ exitCode: 0 })
    const service = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => { throw new Error('unused') } },
      runCli: cli.runCli,
    })

    const result = await service.fetch({
      requestId: 'fetch-1',
      provider: 'dreamina',
      credential: { mode: 'none' },
    })

    expect(result.state).toBe('success')
    expect(result.models.map((model) => model.id)).toContain('5.0Pro')
    /** 只跑额度查询，不发起任何生成任务。 */
    expect(cli.calls).toEqual(['dreamina user_credit'])
  })

  test('Given 即梦未登录或 CLI 缺失 When 拉取 Then 给出可操作分类文案', async () => {
    const notLoggedIn = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => { throw new Error('unused') } },
      runCli: createCliStub({ exitCode: 1 }).runCli,
    })
    expect((await notLoggedIn.fetch({ requestId: 'f', provider: 'dreamina', credential: { mode: 'none' } })).message)
      .toBe(IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.cliNotLoggedIn)

    const missing = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => { throw new Error('unused') } },
      runCli: createCliStub({ exitCode: 1, failureCode: 'cliMissing' }).runCli,
    })
    expect((await missing.fetch({ requestId: 'f', provider: 'dreamina', credential: { mode: 'none' } })).message)
      .toBe(IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.cliMissing)
  })

  test('Given 上游鉴权失败或凭据不可用 When 拉取 Then 只返回分类固定文案', async () => {
    const unauthorized = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => 'unused' },
      fetchImpl: createFetchStub({ error: { message: 'Bearer secret /Users/private' } }, 401),
    })
    const failed = await unauthorized.fetch({
      requestId: 'fetch-1',
      provider: 'openai-images',
      baseUrl: 'https://api.openai.com/v1',
      credential: { mode: 'draft', apiKey: 'secret' },
    })
    expect(failed.state).toBe('failed')
    expect(failed.message).toBe(IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.unauthorized)
    expect(JSON.stringify(failed)).not.toContain('secret')
    expect(JSON.stringify(failed)).not.toContain('/Users/private')

    const noCredential = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => { throw new Error('IMAGE_GENERATION_PROFILE_NOT_FOUND') } },
      fetchImpl: createFetchStub({ data: [] }),
    })
    expect((await noCredential.fetch({
      requestId: 'fetch-2',
      provider: 'minimax',
      baseUrl: 'https://api.minimax.cn/v1',
      credential: { mode: 'saved', profileId: 'missing' },
    })).message).toBe(IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.credential)
  })

  test('Given fetch 错误的有限层 cause 带 TLS code When 拉取 Then 返回证书校验提示且不泄露原始消息', async () => {
    const privateMessage = 'certificate for secret.internal /Users/private failed'
    const tlsError = new Error(privateMessage, {
      cause: new Error('outer transport', {
        cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
      }),
    })
    const service = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => 'unused' },
      fetchImpl: createRejectingFetch(tlsError),
    })

    const result = await service.fetch(createOpenAiInput())

    expect(result.message).toBe(IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.tls)
    expect(JSON.stringify(result)).not.toContain(privateMessage)
  })

  test('Given fetch 错误仅在 message 提到 TLS code When 拉取 Then 不根据原始消息误判证书问题', async () => {
    const service = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => 'unused' },
      fetchImpl: createRejectingFetch(new Error('UNABLE_TO_VERIFY_LEAF_SIGNATURE secret.internal')),
    })

    const result = await service.fetch(createOpenAiInput())

    expect(result.message).toBe(IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.network)
  })

  test('Given fetch 因连接失败 When 拉取 Then 返回网络提示', async () => {
    const service = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => 'unused' },
      fetchImpl: createRejectingFetch(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
    })

    const result = await service.fetch(createOpenAiInput())

    expect(result.message).toBe(IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.network)
  })

  test('Given 模型目录返回 404 When 拉取 Then 保持接口不存在分类', async () => {
    const service = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => 'unused' },
      fetchImpl: createFetchStub({ error: 'missing' }, 404),
    })

    const result = await service.fetch(createOpenAiInput())

    expect(result.message).toBe(IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.notFound)
  })

  test('Given 模型目录返回 HTML When 解析 JSON Then 返回响应格式错误提示', async () => {
    const service = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => 'unused' },
      fetchImpl: async () => new Response('<html>gateway error</html>', { status: 200 }),
    })

    const result = await service.fetch(createOpenAiInput())

    expect(result.message).toBe(IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.malformed)
  })

  test('Given 响应头已返回但正文读取直到超时 When 拉取 Then 返回超时提示', async () => {
    const fetchImpl: ImageGenerationCatalogFetch = async (_input, init) => ({
      status: 200,
      ok: true,
      text: async () => await new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      }),
    }) as unknown as Response
    const service = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => 'unused' },
      fetchImpl,
      timeoutMs: 5,
    })

    const result = await service.fetch(createOpenAiInput())

    expect(result.message).toBe(IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.timeout)
  })

  test('Given 模型目录返回重定向 When 拉取 Then 禁止跟随并返回重定向提示', async () => {
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = []
    const fetchImpl: ImageGenerationCatalogFetch = async (input, init) => {
      calls.push({ url: input.toString(), redirect: init?.redirect })
      return new Response(null, { status: 302, headers: { location: 'http://other.example/v1/models' } })
    }
    const service = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => 'unused' },
      fetchImpl,
    })

    const result = await service.fetch(createOpenAiInput())

    expect(result.message).toBe(IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.redirect)
    expect(calls).toEqual([{ url: 'https://api.openai.com/v1/models', redirect: 'manual' }])
  })

  test('Given HTTP 自定义路径 When 拉取 Then 原样在末尾追加 models 且不升级协议', async () => {
    const calls: string[] = []
    const service = new ImageGenerationCatalogService({
      store: { resolveApiKey: () => 'unused' },
      fetchImpl: async (input) => {
        calls.push(input.toString())
        return new Response(JSON.stringify({ data: [{ id: 'gpt-image-1' }] }), { status: 200 })
      },
    })

    const result = await service.fetch(createOpenAiInput('http://gateway.example/openai/v1/'))

    expect(result.state).toBe('success')
    expect(calls).toEqual(['http://gateway.example/openai/v1/models'])
  })
})
