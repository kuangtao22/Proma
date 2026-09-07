import { describe, expect, test } from 'bun:test'
import * as mediaApiModelModule from './media-api-model'

/** 测试期望的统一 API 媒体模型合同。 */
interface ExpectedMediaApiModelModule {
  parseMediaApiModelProfile: (value: unknown) => {
    id: string
    mediaKind: 'image' | 'audio' | 'video'
    protocol: string
    capabilities: string[]
  }
  canExecuteMediaApiModel: (entry: {
    profile: { enabled: boolean }
    support: { state: 'supported'; adapterId: string } | { state: 'configuration-only'; reason: string } | { state: 'unavailable'; reason: string }
  }) => boolean
}

/** 通过期望合同访问 RED 阶段尚未实现的模块。 */
function getExpectedModule(): ExpectedMediaApiModelModule {
  return mediaApiModelModule as unknown as ExpectedMediaApiModelModule
}

/** 创建合法模型配置的公共字段。 */
function createProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'media-model-1',
    name: 'GPT Image',
    mediaKind: 'image',
    protocol: 'openai-images',
    channelId: 'channel-1',
    modelId: 'gpt-image-2',
    capabilities: ['text-to-image'],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('统一 API 媒体模型合同', () => {
  test('Given 图片、音频和视频协议 When 解析 Then 保留真实媒体类型与能力', () => {
    const { parseMediaApiModelProfile } = getExpectedModule()
    expect(parseMediaApiModelProfile(createProfile()).mediaKind).toBe('image')
    expect(parseMediaApiModelProfile(createProfile({ mediaKind: 'audio', protocol: 'minimax-speech', capabilities: ['text-to-speech'] })).capabilities).toEqual(['text-to-speech'])
    expect(parseMediaApiModelProfile(createProfile({ mediaKind: 'video', protocol: 'minimax-video', capabilities: ['text-to-video'] })).protocol).toBe('minimax-video')
  })

  test('Given 协议与媒体类型或能力不匹配 When 解析 Then 不允许把模型冒充其它执行器', () => {
    const { parseMediaApiModelProfile } = getExpectedModule()
    expect(() => parseMediaApiModelProfile(createProfile({ mediaKind: 'audio', protocol: 'openai-images', capabilities: ['text-to-speech'] }))).toThrow('协议')
    expect(() => parseMediaApiModelProfile(createProfile({ mediaKind: 'image', protocol: 'minimax-image', capabilities: ['text-to-music'] }))).toThrow('能力')
    expect(() => parseMediaApiModelProfile(createProfile({ mediaKind: 'audio', protocol: 'minimax-speech', capabilities: ['text-to-music'] }))).toThrow('能力')
    expect(() => parseMediaApiModelProfile(createProfile({ mediaKind: 'audio', protocol: 'minimax-music', capabilities: ['text-to-speech'] }))).toThrow('能力')
  })

  test('Given 模型会进入 Canvas scope When 解析稳定 ID Then 使用同一安全字符合同', () => {
    const { parseMediaApiModelProfile } = getExpectedModule()
    expect(parseMediaApiModelProfile(createProfile({ id: 'media:model.audio-1' })).id).toBe('media:model.audio-1')
    expect(() => parseMediaApiModelProfile(createProfile({ id: '包含空格' }))).toThrow('模型 ID')
    expect(() => parseMediaApiModelProfile(createProfile({ id: '__proto__' }))).toThrow('模型 ID')
  })

  test('Given 模型已配置但 adapter 尚未注册 When 判断执行资格 Then 不进入候选', () => {
    const { canExecuteMediaApiModel } = getExpectedModule()
    expect(canExecuteMediaApiModel({ profile: { enabled: true }, support: { state: 'configuration-only', reason: '尚未安装 MiniMax Speech adapter' } })).toBeFalse()
    expect(canExecuteMediaApiModel({ profile: { enabled: true }, support: { state: 'supported', adapterId: 'openai-images-v1' } })).toBeTrue()
    expect(canExecuteMediaApiModel({ profile: { enabled: false }, support: { state: 'supported', adapterId: 'openai-images-v1' } })).toBeFalse()
  })
})
