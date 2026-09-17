import { describe, expect, test } from 'bun:test'
import { MEDIA_IPC_CHANNELS } from '@proma/shared'
import { createMediaPreloadApi } from './media-preload'

/** 构造严格合法的独立音频配置，供 preload 透传合同测试复用。 */
function createAudioProfile() {
  return {
    id: 'audio-1',
    name: '小米语音',
    provider: 'xiaomi' as const,
    baseUrl: 'https://example.com/tts',
    modelId: 'tts-model',
    voices: [{ id: 'voice-1', name: 'voice-1', source: 'manual' as const }],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('媒体 preload 合同', () => {
  test('Given 本地图片引用 When 请求缩略图 Then 仅向固定通道发送项目与四字段引用', async () => {
    const calls: Array<{ channel: string; input: unknown }> = []
    const api = createMediaPreloadApi(
      async (channel, input) => { calls.push({ channel, input }); return { bytes: new Uint8Array([1]), contentType: 'image/png' } },
      () => () => undefined,
    )
    const asset = { assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' as const }

    await api.mediaReadAssetThumbnail('project-1', asset)

    expect(calls).toEqual([{ channel: MEDIA_IPC_CHANNELS.READ_ASSET_THUMBNAIL, input: { projectId: 'project-1', asset } }])
  })

  test('Given 音频设置调用 When 通过 preload Then 只发送四个固定通道和结构', async () => {
    const calls: Array<{ channel: string; input: unknown }> = []
    const api = createMediaPreloadApi(
      async (channel, input) => { calls.push({ channel, input }) },
      () => () => undefined,
    )
    const request = {
      expectedRevision: 0,
      profiles: [{ profile: createAudioProfile(), credentialUpdate: { mode: 'replace' as const, apiKey: 'secret-key' } }],
    }
    const testInput = {
      kind: 'saved' as const,
      requestId: 'request-1',
      profileId: 'audio-1',
    }

    await api.mediaGetAudioGenerationSettings()
    await api.mediaReplaceAudioGenerationCatalog(request)
    await api.mediaTestAudioGeneration(testInput)
    await api.mediaCancelAudioGenerationTest('request-1')

    expect(calls).toEqual([
      { channel: MEDIA_IPC_CHANNELS.GET_AUDIO_GENERATION_SETTINGS, input: undefined },
      { channel: MEDIA_IPC_CHANNELS.REPLACE_AUDIO_GENERATION_CATALOG, input: request },
      { channel: MEDIA_IPC_CHANNELS.TEST_AUDIO_GENERATION, input: testInput },
      { channel: MEDIA_IPC_CHANNELS.CANCEL_AUDIO_GENERATION_TEST, input: { requestId: 'request-1' } },
    ])
  })
})
