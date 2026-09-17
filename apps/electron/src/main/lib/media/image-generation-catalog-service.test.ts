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
})
