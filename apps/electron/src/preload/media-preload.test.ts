import { describe, expect, test } from 'bun:test'
import { MEDIA_IPC_CHANNELS } from '@proma/shared'
import { createMediaPreloadApi } from './media-preload'

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
})
