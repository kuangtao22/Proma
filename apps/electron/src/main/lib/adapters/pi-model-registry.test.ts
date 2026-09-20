import { describe, expect, test } from 'bun:test'
import type { Api, Model } from '@earendil-works/pi-ai/compat'
import { filterSupportedCodexModels } from './pi-model-registry'

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
