import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel, ImageGenerationModelProfile, MediaApiModelProfile } from '@proma/shared'
import { ImageGenerationModelCatalog } from './image-generation-model-catalog'

/** 测试目录与用户真实模型目录隔离。 */
let directory = ''
/** 测试使用的模型目录路径。 */
let configPath = ''

/** 创建可解析秘密但不会向 Renderer 返回秘密的渠道。 */
function channel(): Channel {
  return {
    id: 'channel-1', name: '媒体 API', provider: 'openai', baseUrl: 'https://api.example/v1', apiKey: 'encrypted',
    models: [{ id: 'gpt-image-2', name: 'GPT Image 2', enabled: true }], enabled: true, createdAt: 1, updatedAt: 1,
  }
}

/** 创建只引用渠道 ID 的统一 API 媒体模型。 */
function mediaProfile(overrides: Partial<MediaApiModelProfile> = {}): MediaApiModelProfile {
  return {
    id: 'profile-gpt', name: 'GPT Image 2', mediaKind: 'image', protocol: 'openai-images',
    channelId: 'channel-1', modelId: 'gpt-image-2', capabilities: ['text-to-image'], enabled: true,
    createdAt: 10, updatedAt: 20, ...overrides,
  }
}

/** 创建测试目录实例。 */
function catalog(): ImageGenerationModelCatalog {
  return new ImageGenerationModelCatalog({
    configPath,
    getNanoBananaCredentials: () => ({ apiKey: 'nano-key' }),
    listChannels: () => [channel()],
    decryptChannelApiKey: () => 'channel-secret',
    now: () => 100,
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'proma-media-api-model-'))
  configPath = join(directory, 'image-generation-models.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('ImageGenerationModelCatalog 统一 API 媒体模型', () => {
  test('Given v2 OpenAI Images profile When 读取统一目录 Then 保留稳定 ID 与渠道秘密引用且不写盘迁移', () => {
    /** 旧 v2 目录中的可执行图片 profile。 */
    const image: Extract<ImageGenerationModelProfile, { executor: 'openai-images' }> = {
      id: 'profile-gpt', name: 'GPT Image 2', executor: 'openai-images', channelId: 'channel-1', modelId: 'gpt-image-2',
      enabled: true, createdAt: 10, updatedAt: 20,
    }
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, profiles: [image] }))

    const result = catalog().listMediaApiCatalog()

    expect(result.revision).toBe(0)
    expect(result.entries).toEqual([{
      profile: mediaProfile(),
      channelName: '媒体 API',
      support: { state: 'supported', adapterId: 'openai-images' },
    }])
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ schemaVersion: 2, profiles: [image] })
    expect(JSON.stringify(result)).not.toContain('channel-secret')
    expect(JSON.stringify(result)).not.toContain('encrypted')
  })

  test('Given 图片与音视频模型 When CAS 保存并由旧图片入口更新 Then 保留其它协议且 revision 单调递增', () => {
    /** 音频执行器尚未实现，只允许保存为 configuration-only。 */
    const audio = mediaProfile({ id: 'audio-1', name: '语音', mediaKind: 'audio', protocol: 'minimax-speech', modelId: 'speech-2.6', capabilities: ['text-to-speech'] })
    /** 视频执行器尚未实现，只允许保存为 configuration-only。 */
    const video = mediaProfile({ id: 'video-1', name: '视频', mediaKind: 'video', protocol: 'minimax-video', modelId: 'video-01', capabilities: ['text-to-video'] })
    const first = catalog().replaceMediaApiProfiles([mediaProfile(), audio, video], 0)
    expect(first.revision).toBe(1)
    expect(first.entries.map((entry) => [entry.profile.id, entry.support.state])).toEqual([
      ['profile-gpt', 'supported'], ['audio-1', 'configuration-only'], ['video-1', 'configuration-only'],
    ])

    /** 旧图片设置页只更新图片投影，不能丢失统一目录中的音视频配置。 */
    const changedImage: Extract<ImageGenerationModelProfile, { executor: 'openai-images' }> = {
      id: 'profile-gpt', name: 'GPT Image 新名称', executor: 'openai-images', channelId: 'channel-1', modelId: 'gpt-image-2',
      enabled: true, createdAt: 10, updatedAt: 30,
    }
    const imageResult = catalog().replaceProfiles([changedImage], 1)
    expect(imageResult.revision).toBe(2)
    const restored = catalog().listMediaApiCatalog()
    expect(restored.entries.map((entry) => entry.profile.id)).toEqual(['profile-gpt', 'audio-1', 'video-1'])
    expect(restored.entries[0]?.profile.name).toBe('GPT Image 新名称')
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ schemaVersion: 3, revision: 2 })
  })

  test('Given 两个窗口读取同一 revision When 后写窗口提交旧 expectedRevision Then 拒绝覆盖先写结果', () => {
    catalog().replaceMediaApiProfiles([mediaProfile()], 0)
    expect(() => catalog().replaceMediaApiProfiles([mediaProfile({ name: '迟到写入' })], 0)).toThrow('目录已变化')
    expect(catalog().listMediaApiCatalog().entries[0]?.profile.name).toBe('GPT Image 2')
  })
})
