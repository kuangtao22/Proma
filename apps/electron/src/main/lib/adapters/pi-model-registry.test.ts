import { describe, expect, test } from 'bun:test'
import type { Api, Model } from '@earendil-works/pi-ai/compat'
import { buildModel, filterSupportedCodexModels } from './pi-model-registry'

/** 构造最小可用的 Codex 目录条目，字段值本身不影响过滤判定。 */
function codexModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 372_000,
    maxTokens: 128_000,
  }
}

describe('Codex 目录下线模型过滤', () => {
  test('Given 目录含已下线的 Codex Spark When 过滤 Then 该条目不再进入候选', () => {
    const filtered = filterSupportedCodexModels([
      codexModel('gpt-5.6-sol'),
      codexModel('gpt-5.3-codex-spark'),
    ])

    expect(filtered.map((model) => model.id)).toEqual(['gpt-5.6-sol'])
  })

  test('Given 大小写或首尾空格不同的下线 ID When 过滤 Then 仍被识别并剔除', () => {
    const filtered = filterSupportedCodexModels([
      codexModel('GPT-5.3-Codex-Spark'),
      codexModel(' gpt-5.3-codex-spark '),
    ])

    expect(filtered).toEqual([])
  })

  test('Given 目录只含可用模型 When 过滤 Then 顺序与内容保持不变', () => {
    const filtered = filterSupportedCodexModels([
      codexModel('gpt-5.6-sol'),
      codexModel('gpt-5.6-luna'),
    ])

    expect(filtered.map((model) => model.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna'])
  })
})

describe('GLM-5.3-FlashX 离线模型注册', () => {
  test('Given Pi catalog 尚无 FlashX When 离线构建智谱模型 Then 沿用 GLM-5.3 推理能力与上下文参数', async () => {
    let registeredModel: Model<Api> | undefined
    const modelRuntime = {
      registerProvider: (_providerName: string, provider: { models: Model<Api>[] }) => {
        registeredModel = provider.models[0]
      },
      getModel: () => registeredModel,
    }
    const sdk = {
      ModelRuntime: {
        create: async (options: { allowModelNetwork: boolean }) => {
          expect(options).toEqual({ allowModelNetwork: false })
          return modelRuntime
        },
      },
    } as unknown as Parameters<typeof buildModel>[0]

    const { model } = await buildModel(sdk, {
      sessionId: 'session-flashx',
      apiKey: 'test-key',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      provider: 'zhipu',
      model: 'glm-5.3-flashx',
    })

    expect(model).toMatchObject({
      id: 'glm-5.3-flashx',
      api: 'openai-completions',
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'zai',
        zaiToolStream: true,
      },
    })
  })
})
