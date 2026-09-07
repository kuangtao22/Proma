import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ImageGenerationChannelOption, MediaApiModelCatalogEntry } from '@proma/shared'
import {
  changeMediaApiModelKind,
  changeMediaApiModelProtocol,
  createMediaApiModelProfile,
  filterMediaApiModelEntries,
  MediaApiModelCatalogView,
  setMediaApiModelEnabled,
  validateMediaApiModelDraft,
} from './MediaApiModelSettings'

/** 测试使用的现有渠道公开选项，不包含秘密。 */
const channels: ImageGenerationChannelOption[] = [{
  channelId: 'channel-1',
  name: '统一 API',
  available: true,
  models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
}]

describe('MediaApiModelSettings', () => {
  test('Given 用户新增音频或视频模型 When 切换类型与协议 Then 使用协议精确能力且不保留旧模型 ID', () => {
    /** 从已有图片配置开始，证明切换不会污染旧身份字段。 */
    const image = { ...createMediaApiModelProfile('model-1', 10), channelId: 'channel-1', modelId: 'gpt-image-2' }
    const audio = changeMediaApiModelKind(image, 'audio')
    expect(audio).toMatchObject({ id: 'model-1', mediaKind: 'audio', protocol: 'minimax-speech', modelId: '' })
    expect(audio.capabilities).toEqual(['text-to-speech', 'voice-cloning'])

    const music = changeMediaApiModelProtocol(audio, 'minimax-music')
    expect(music.capabilities).toEqual(['text-to-music'])
    const video = changeMediaApiModelKind(music, 'video')
    expect(video).toMatchObject({ mediaKind: 'video', protocol: 'minimax-video', modelId: '' })
  })

  test('Given 模型引用渠道秘密 When 本地校验 Then 只接受已有渠道与真实 OpenAI 图片模型', () => {
    /** 合法图片 profile 只保存渠道引用。 */
    const profile = { ...createMediaApiModelProfile('model-1', 10), name: '图片模型', channelId: 'channel-1', modelId: 'gpt-image-2' }
    expect(validateMediaApiModelDraft(profile, channels)).toBeNull()
    expect(validateMediaApiModelDraft({ ...profile, channelId: 'missing' }, channels)).toContain('已有模型配置')
    expect(validateMediaApiModelDraft({ ...profile, modelId: 'invented' }, channels)).toContain('图片模型')
    expect(JSON.stringify(profile)).not.toContain('secret')
  })

  test('Given 图片音频视频目录 When 渲染 Then 提供真实支持状态和单条增删改复制入口', () => {
    /** 三类目录条目分别锁定 supported 与 configuration-only 展示。 */
    const entries: MediaApiModelCatalogEntry[] = [
      { profile: { ...createMediaApiModelProfile('image-1', 1), name: '图片', channelId: 'channel-1', modelId: 'gpt-image-2' }, channelName: '统一 API', support: { state: 'supported', adapterId: 'openai-images' } },
      { profile: { ...changeMediaApiModelKind(createMediaApiModelProfile('audio-1', 1), 'audio'), name: '语音', channelId: 'channel-1', modelId: 'speech-2.6' }, support: { state: 'configuration-only', reason: '执行适配尚未接入' } },
      { profile: { ...changeMediaApiModelKind(createMediaApiModelProfile('video-1', 1), 'video'), name: '视频', channelId: 'channel-1', modelId: 'video-01' }, support: { state: 'configuration-only', reason: '执行适配尚未接入' } },
    ]
    const html = renderToStaticMarkup(<MediaApiModelCatalogView entries={entries} channelOptions={channels} saving={false} onSaveProfiles={async () => true} />)
    expect(html).toContain('图片')
    expect(html).toContain('语音')
    expect(html).toContain('视频')
    expect(html).toContain('可执行')
    expect(html).toContain('待适配')
    expect(html).toContain('渠道：统一 API')
    expect(html).toContain('搜索名称、协议、渠道或能力')
    expect(html).toContain('aria-label="筛选媒体类型"')
    expect(html).toContain('aria-label="停用 图片"')
    expect(html).toContain('添加 API 模型')
    expect(html).toContain('aria-label="编辑 语音"')
  })

  test('Given 多种媒体模型 When 搜索渠道能力并筛选类型 Then 只保留同时匹配的条目', () => {
    /** 图片条目由主进程直接提供渠道名称。 */
    const image: MediaApiModelCatalogEntry = {
      profile: { ...createMediaApiModelProfile('image-1', 1), name: '主视觉', channelId: 'channel-1', modelId: 'gpt-image-2' },
      channelName: '创作渠道',
      support: { state: 'supported', adapterId: 'openai-images' },
    }
    /** 音频条目验证能力中文名和渠道摘要回退。 */
    const audio: MediaApiModelCatalogEntry = {
      profile: { ...changeMediaApiModelKind(createMediaApiModelProfile('audio-1', 1), 'audio'), name: '旁白', channelId: 'channel-1', modelId: 'speech-2.6' },
      support: { state: 'configuration-only', reason: '执行适配尚未接入' },
    }
    expect(filterMediaApiModelEntries([image, audio], channels, '创作渠道', 'all')).toEqual([image])
    expect(filterMediaApiModelEntries([image, audio], channels, '声音克隆', 'audio')).toEqual([audio])
    expect(filterMediaApiModelEntries([image, audio], channels, 'OpenAI Images', 'audio')).toEqual([])
  })

  test('Given 列表快捷开关 When 停用目标模型 Then 只更新目标状态与时间并保留目录顺序', () => {
    /** 两条 profile 用于证明快捷开关不会覆盖其它模型。 */
    const image = { ...createMediaApiModelProfile('image-1', 1), name: '图片', channelId: 'channel-1', modelId: 'gpt-image-2' }
    const audio = { ...changeMediaApiModelKind(createMediaApiModelProfile('audio-1', 2), 'audio'), name: '语音', channelId: 'channel-1', modelId: 'speech-2.6' }
    const result = setMediaApiModelEnabled([image, audio], 'image-1', false, 30)
    expect(result.map((profile) => profile.id)).toEqual(['image-1', 'audio-1'])
    expect(result[0]).toMatchObject({ enabled: false, updatedAt: 30 })
    expect(result[1]).toEqual(audio)
  })
})
