import { describe, expect, test } from 'bun:test'
import {
  IMAGE_GENERATION_LEGACY_WARNING,
  IMAGE_GENERATION_PROVIDER_DEFAULTS,
  IMAGE_GENERATION_PROVIDER_DESCRIPTORS,
  parseImageGenerationProfile,
  parseImageGenerationSettingsResult,
  parseReplaceImageGenerationCatalogRequest,
} from './image-generation'

/** 创建合法的密钥型生图配置，允许单个测试覆盖目标字段。 */
function createOpenAIProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'image-1',
    name: ' ChatGPT 生图 ',
    provider: 'openai-images',
    baseUrl: 'https://api.openai.com/v1///',
    models: [{ id: ' gpt-image-1 ', name: ' GPT Image ', capabilities: ['text-to-image', 'text-to-image'] }],
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/** 创建合法的即梦配置：没有服务地址与密钥字段。 */
function createDreaminaProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'image-2',
    name: '即梦',
    provider: 'dreamina',
    models: [{ id: '5.0', capabilities: ['text-to-image'], params: { resolution_type: '2k' } }],
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe('独立生图生成 Shared 合同', () => {
  test('Given 三家供应商描述 When 读取 Then 标签、专属字段与凭据形态精确', () => {
    expect(IMAGE_GENERATION_PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.label)).toEqual([
      '即梦', 'ChatGPT（OpenAI Images）', 'MiniMax 图像',
    ])
    expect(IMAGE_GENERATION_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.provider === 'dreamina')?.usesApiKey).toBeFalse()
    expect(IMAGE_GENERATION_PROVIDER_DEFAULTS.dreamina.baseUrl).toBe('')
    expect(IMAGE_GENERATION_PROVIDER_DEFAULTS.dreamina.builtinModels.map((model) => model.id)).toContain('5.0Pro')
    expect(IMAGE_GENERATION_PROVIDER_DEFAULTS['openai-images'].baseUrl).toBe('https://api.openai.com/v1')
  })

  test('Given 密钥型配置 When 解析 Then 清洗字段并按能力去重', () => {
    expect(parseImageGenerationProfile(createOpenAIProfile())).toEqual({
      id: 'image-1', name: 'ChatGPT 生图', provider: 'openai-images',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-image-1', name: 'GPT Image', capabilities: ['text-to-image'] }],
      enabled: true, createdAt: 1, updatedAt: 2,
    })
  })

  test('Given 即梦配置 When 解析 Then 不出现服务地址且拒绝密钥字段', () => {
    expect(parseImageGenerationProfile(createDreaminaProfile())).toMatchObject({ provider: 'dreamina' })
    /** 即梦走 CLI 登录态，任何 baseUrl 或 groupId 都是非法字段。 */
    expect(() => parseImageGenerationProfile(createDreaminaProfile({ baseUrl: 'https://x.example/v1' })))
      .toThrow('IMAGE_GENERATION_CONFIG_INVALID')
    expect(() => parseImageGenerationProfile(createDreaminaProfile({ groupId: 'g' })))
      .toThrow('IMAGE_GENERATION_CONFIG_INVALID')
  })

  test('Given 非法地址、空模型、重复模型或未知能力 When 解析 Then 拒绝', () => {
    /** 服务地址有独立的稳定错误码，便于界面区分「地址写错」与「配置非法」。 */
    for (const baseUrl of [
      'http://api.openai.com/v1',
      'https://user:pass@api.openai.com/v1',
      'https://api.openai.com/v1?token=1',
      'https://api.openai.com/v1#fragment',
    ]) {
      expect(() => parseImageGenerationProfile(createOpenAIProfile({ baseUrl })))
        .toThrow('IMAGE_GENERATION_URL_INVALID')
    }
    for (const invalid of [
      createOpenAIProfile({ models: [] }),
      createOpenAIProfile({ models: [{ id: 'dup', capabilities: ['text-to-image'] }, { id: 'dup', capabilities: ['text-to-image'] }] }),
      createOpenAIProfile({ models: [{ id: 'm', capabilities: [] }] }),
      createOpenAIProfile({ models: [{ id: 'm', capabilities: ['text-to-music'] }] }),
      createOpenAIProfile({ models: [{ id: 'm', capabilities: ['text-to-image'], extra: true }] }),
      createOpenAIProfile({ updatedAt: 0 }),
      createOpenAIProfile({ provider: 'unknown' }),
    ]) {
      expect(() => parseImageGenerationProfile(invalid)).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
    }
  })

  test('Given 完整替换请求 When 解析 Then 即梦不允许替换密钥且重复 ID 被拒绝', () => {
    expect(parseReplaceImageGenerationCatalogRequest({
      expectedRevision: 3,
      profiles: [
        { profile: createOpenAIProfile(), credentialUpdate: { mode: 'replace', apiKey: ' secret ' } },
        { profile: createDreaminaProfile(), credentialUpdate: { mode: 'preserve' } },
      ],
    })).toMatchObject({
      expectedRevision: 3,
      profiles: [
        { credentialUpdate: { mode: 'replace', apiKey: 'secret' } },
        { credentialUpdate: { mode: 'preserve' } },
      ],
    })
    expect(() => parseReplaceImageGenerationCatalogRequest({
      expectedRevision: 0,
      profiles: [{ profile: createDreaminaProfile(), credentialUpdate: { mode: 'replace', apiKey: 'leak' } }],
    })).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
    expect(() => parseReplaceImageGenerationCatalogRequest({
      expectedRevision: 0,
      profiles: [
        { profile: createOpenAIProfile(), credentialUpdate: { mode: 'preserve' } },
        { profile: createOpenAIProfile(), credentialUpdate: { mode: 'preserve' } },
      ],
    })).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
  })

  test('Given 设置结果 When 解析 Then 公开配置与旧摘要均使用严格字段', () => {
    const parsed = parseImageGenerationSettingsResult({
      catalog: {
        schemaVersion: 1,
        revision: 4,
        profiles: [{
          ...createOpenAIProfile(),
          credentialConfigured: true,
          endpointOrigin: 'https://api.openai.com',
        }],
      },
      legacyImageProfiles: [{
        id: 'legacy-1', name: '旧生图', protocol: 'openai-images', modelId: 'gpt-image-1', enabled: true,
      }],
      legacyWarning: IMAGE_GENERATION_LEGACY_WARNING,
    })
    expect(parsed.catalog.profiles[0]).toMatchObject({ credentialConfigured: true, endpointOrigin: 'https://api.openai.com' })
    expect(parsed.legacyImageProfiles).toHaveLength(1)
    expect(parsed.legacyWarning).toBe(IMAGE_GENERATION_LEGACY_WARNING)
    /** 旧摘要协议必须是我们支持迁移的那一种。 */
    expect(() => parseImageGenerationSettingsResult({
      catalog: { schemaVersion: 1, revision: 0, profiles: [] },
      legacyImageProfiles: [{ id: 'legacy-2', name: '旧', protocol: 'minimax-image', modelId: 'm', enabled: true }],
    })).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
  })
})
