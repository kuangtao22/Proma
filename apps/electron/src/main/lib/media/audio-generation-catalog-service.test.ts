import { describe, expect, test } from 'bun:test'
import { AUDIO_GENERATION_CATALOG_MESSAGES } from '@proma/shared'
import { AudioGenerationCatalogService, type AudioGenerationCatalogFetch } from './audio-generation-catalog-service'

/** 记录一次上游请求，供断言 URL、方法与请求头。 */
interface RecordedRequest {
  url: string
  init: RequestInit
}

/** 构造只回放固定 JSON 的 fetch 替身。 */
function createFetchStub(routes: Record<string, { status?: number; body: unknown }>): {
  fetchImpl: AudioGenerationCatalogFetch
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const fetchImpl: AudioGenerationCatalogFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    requests.push({ url, init: init ?? {} })
    const route = routes[url]
    if (!route) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, requests }
}

/** 只回放固定文本的 fetch 替身，用于构造非 JSON 或空响应。 */
function createTextFetchStub(body: string, status = 200): AudioGenerationCatalogFetch {
  return async () => new Response(body, { status })
}

/** 固定输入，避免每个用例重复拼装。 */
function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'fetch-1',
    provider: 'xiaomi',
    baseUrl: 'https://tts.example/v1',
    credential: { mode: 'draft', apiKey: 'secret-key' },
    ...overrides,
  }
}

describe('音频供应商目录拉取', () => {
  test('Given 小米草稿凭据 When 拉取 Then 请求 models 并直接返回官方内置音色', async () => {
    const { fetchImpl, requests } = createFetchStub({
      'https://tts.example/v1/models': { body: { data: [{ id: 'mimo-v2.5-tts' }, { id: 'mimo-v2.5' }] } },
    })
    const service = new AudioGenerationCatalogService({ store: { resolveApiKey: () => { throw new Error('unused') } }, fetchImpl })

    const result = await service.fetch(createInput())

    expect(result.state).toBe('success')
    expect(result.models).toEqual(['mimo-v2.5-tts', 'mimo-v2.5'])
    expect(result.voices.map((voice) => voice.id)).toContain('mimo_default')
    expect(result.voices.every((voice) => voice.source === 'builtin')).toBeTrue()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://tts.example/v1/models')
    expect((requests[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key')
  })

  test('Given MiniMax 已保存凭据 When 拉取 Then 合并系统、克隆与生成音色并去重', async () => {
    const { fetchImpl, requests } = createFetchStub({
      'https://api.minimax.example/v1/models': { body: { data: [{ id: 'speech-2.5-hd' }, { id: 'speech-2.5-hd' }] } },
      'https://api.minimax.example/v1/get_voice': {
        body: {
          system_voice: { items: [{ voice_id: 'sys-1', voice_name: '系统音色' }, { voice_id: 'sys-1' }] },
          voice_cloning: { items: [{ voice_id: 'clone-1' }] },
          voice_generation: [{ voice_id: 'gen-1', voice_name: '生成音色' }],
        },
      },
    })
    const service = new AudioGenerationCatalogService({ store: { resolveApiKey: () => 'saved-secret' }, fetchImpl })

    const result = await service.fetch(createInput({
      provider: 'minimax',
      baseUrl: 'https://api.minimax.example/v1',
      credential: { mode: 'saved', profileId: 'minimax-1' },
    }))

    expect(result.state).toBe('success')
    expect(result.models).toEqual(['speech-2.5-hd'])
    expect(result.voices).toEqual([
      { id: 'sys-1', name: '系统音色', source: 'remote' },
      { id: 'clone-1', source: 'remote' },
      { id: 'gen-1', name: '生成音色', source: 'remote' },
    ])
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.minimax.example/v1/models',
      'https://api.minimax.example/v1/get_voice',
    ])
  })

  test('Given 上游鉴权失败 When 拉取 Then 返回固定失败文案且不泄露上游正文与路径', async () => {
    const { fetchImpl } = createFetchStub({
      'https://tts.example/v1/models': { status: 401, body: { error: { message: 'Bearer secret-key /Users/private' } } },
    })
    const service = new AudioGenerationCatalogService({ store: { resolveApiKey: () => { throw new Error('unused') } }, fetchImpl })

    const result = await service.fetch(createInput())

    expect(result).toEqual({
      requestId: 'fetch-1',
      state: 'failed',
      message: AUDIO_GENERATION_CATALOG_MESSAGES.failed,
      models: [],
      voices: [],
    })
    expect(JSON.stringify(result)).not.toContain('secret-key')
    expect(JSON.stringify(result)).not.toContain('/Users/private')
  })

  test('Given 已保存凭据解析失败或上游超时 When 拉取 Then 都收敛为固定失败结果', async () => {
    const unauthorized = new AudioGenerationCatalogService({
      store: { resolveApiKey: () => { throw new Error('AUDIO_GENERATION_PROFILE_NOT_FOUND') } },
      fetchImpl: createTextFetchStub('{}', 200),
    })
    expect((await unauthorized.fetch(createInput({ credential: { mode: 'saved', profileId: 'missing' } }))).state).toBe('failed')

    /** 永不返回的 fetch 必须被超时终止，而不是挂起设置页。 */
    const hanging = new AudioGenerationCatalogService({
      store: { resolveApiKey: () => 'unused' },
      timeoutMs: 10,
      fetchImpl: (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    })
    const timedOut = await hanging.fetch(createInput())
    expect(timedOut.state).toBe('failed')
    expect(timedOut.message).toBe(AUDIO_GENERATION_CATALOG_MESSAGES.failed)
  })

  test('Given 响应不是 JSON 或缺少模型数组 When 拉取 Then 返回失败而不是抛出', async () => {
    const broken = new AudioGenerationCatalogService({
      store: { resolveApiKey: () => 'unused' },
      fetchImpl: createTextFetchStub('not-json', 200),
    })
    expect((await broken.fetch(createInput())).state).toBe('failed')

    const shapeMismatch = new AudioGenerationCatalogService({
      store: { resolveApiKey: () => 'unused' },
      fetchImpl: createTextFetchStub(JSON.stringify({ unexpected: true }), 200),
    })
    expect((await shapeMismatch.fetch(createInput())).state).toBe('failed')
  })
})
