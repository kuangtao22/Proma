import { describe, expect, test } from 'bun:test'
import type { ImageGenerationPublicProfile } from '@proma/shared'
import {
  changeImageGenerationProvider,
  copyImageGenerationProfile,
  createImageGenerationDraft,
  draftToProfile,
  filterImageGenerationProfiles,
  imageCatalogIdentity,
  imageGenerationSummary,
  imageProfileIdentity,
  profileToDraft,
  providerUsesApiKey,
  withDefaultCapabilities,
} from './ImageGenerationSettings.logic'

/** 构造公开生图配置快照。 */
function createProfile(overrides: Partial<ImageGenerationPublicProfile> = {}): ImageGenerationPublicProfile {
  return {
    id: 'image-1',
    name: 'ChatGPT 生图',
    provider: 'openai-images',
    baseUrl: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-image-1', capabilities: ['text-to-image', 'image-to-image'] }],
    enabled: true,
    createdAt: 10,
    updatedAt: 20,
    credentialConfigured: true,
    endpointOrigin: 'https://api.openai.com',
    ...overrides,
  } as ImageGenerationPublicProfile
}

describe('独立生图设置纯逻辑', () => {
  test('Given 三家供应商 When 创建草稿 Then 带出默认端与内置模型且即梦没有地址与密钥', () => {
    const dreamina = createImageGenerationDraft('dreamina', 'image-d', 100)
    expect(dreamina).toMatchObject({ provider: 'dreamina', apiKey: '', credentialConfigured: false })
    expect(dreamina.models.map((model) => model.id)).toContain('5.0Pro')
    expect('baseUrl' in dreamina).toBeFalse()

    const openai = createImageGenerationDraft('openai-images', 'image-o', 100)
    expect(openai).toMatchObject({ provider: 'openai-images', baseUrl: 'https://api.openai.com/v1' })
    expect(openai.models.map((model) => model.id)).toEqual(['gpt-image-1', 'gpt-image-1-mini', 'dall-e-3'])

    expect(providerUsesApiKey('dreamina')).toBeFalse()
    expect(providerUsesApiKey('minimax')).toBeTrue()
  })

  test('Given 已填写草稿 When 切换供应商 Then 重建默认模型并清空凭据但保留名称', () => {
    const draft = { ...createImageGenerationDraft('openai-images', 'image-1', 100), name: '我的生图账号', apiKey: 'secret' }
    const switched = changeImageGenerationProvider(draft, 'dreamina')
    expect(switched).toMatchObject({ provider: 'dreamina', name: '我的生图账号', apiKey: '', credentialConfigured: false })
    expect(switched.models.map((model) => model.id)).toContain('5.0Pro')
    /** 重复选择同一供应商不产生新对象，避免无意义重渲染。 */
    expect(changeImageGenerationProvider(switched, 'dreamina')).toBe(switched)
  })

  test('Given 既有配置 When 复制 Then 保留模型与参数但不继承凭据和旧引用', () => {
    const source = createProfile({ legacyMediaProfileId: 'legacy-1' })
    const copied = copyImageGenerationProfile(source, 'image-2', 50)
    expect(copied).toMatchObject({ id: 'image-2', name: 'ChatGPT 生图 副本', apiKey: '', createdAt: 50 })
    expect(copied.legacyMediaProfileId).toBeUndefined()
    expect(copied.models[0]!.capabilities).toEqual(['text-to-image', 'image-to-image'])
    expect(JSON.stringify(copied)).not.toContain('legacy-1')
  })

  test('Given 公开配置 When 转草稿再收敛 Then 严格合同字段完整往返', () => {
    const draft = profileToDraft(createProfile())
    expect(draft).toMatchObject({ apiKey: '', credentialConfigured: true })
    expect(draftToProfile(draft)).toEqual({
      id: 'image-1', name: 'ChatGPT 生图', provider: 'openai-images',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-image-1', capabilities: ['text-to-image', 'image-to-image'] }],
      enabled: true, createdAt: 10, updatedAt: 20,
    })
  })

  test('Given 即梦草稿 When 收敛 Then 不包含服务地址与密钥字段', () => {
    const draft = { ...createImageGenerationDraft('dreamina', 'image-d', 10), name: '即梦', apiKey: 'should-not-appear' }
    const profile = draftToProfile(draft)
    expect(profile).toMatchObject({ provider: 'dreamina', name: '即梦' })
    expect(JSON.stringify(profile)).not.toContain('should-not-appear')
  })

  test('Given 目录与搜索词 When 过滤 Then 只匹配公开字段并生成摘要', () => {
    const profiles = [
      createProfile(),
      createProfile({ id: 'image-2', name: '即梦主号', provider: 'dreamina', models: [{ id: '5.0', capabilities: ['text-to-image'] }] } as ImageGenerationPublicProfile),
    ]
    expect(filterImageGenerationProfiles(profiles, '即梦')).toHaveLength(1)
    expect(filterImageGenerationProfiles(profiles, 'gpt-image-1')).toHaveLength(1)
    expect(filterImageGenerationProfiles(profiles, 'private')).toHaveLength(0)
    /** 摘要按产物类别汇总，图片与视频模型合并后仍能一眼看出构成。 */
    expect(imageGenerationSummary(profiles[0]!)).toBe('gpt-image-1 · 图片模型')
    expect(imageGenerationSummary(profiles[1]!)).toBe('5.0 · 图片模型')
  })

  test('Given 图片与视频模型混排 When 生成摘要与默认参数 Then 按能力区分处理', () => {
    const mixed = createProfile({
      models: [
        { id: '5.0', capabilities: ['text-to-image'], params: { resolution_type: '2k' } },
        { id: 'seedance2.5', capabilities: ['text-to-video', 'image-to-video', 'first-last-frame'] },
      ],
    })
    expect(imageGenerationSummary(mixed)).toBe('5.0 等 2 个模型 · 1 图片 + 1 视频')
    /** 即梦图片模型补分辨率档位，视频模型补视频分辨率，不能互相串。 */
    expect(withDefaultCapabilities('dreamina', { id: '5.1', capabilities: ['text-to-image'] }).params)
      .toEqual({ resolution_type: '2k' })
    expect(withDefaultCapabilities('dreamina', { id: 'seedance2.0', capabilities: ['text-to-video'] }).params)
      .toEqual({ video_resolution: '720p' })
    /** 已带参数的内置清单不被覆盖。 */
    expect(withDefaultCapabilities('dreamina', {
      id: 'seedance2.0_vip',
      capabilities: ['text-to-video'],
      params: { video_resolution: '4k' },
    }).params).toEqual({ video_resolution: '4k' })
    /** 非即梦供应商不附加任何本地默认参数。 */
    expect(withDefaultCapabilities('minimax', { id: 'T2V-01', capabilities: ['text-to-video'] }).params).toBeUndefined()
  })

  test('Given 身份字段变化 When 生成指纹 Then 模型与端点变化都会改变指纹', () => {
    const base = draftToProfile(profileToDraft(createProfile()))
    const changedModel = draftToProfile(profileToDraft(createProfile({
      models: [{ id: 'dall-e-3', capabilities: ['text-to-image'] }],
    })))
    expect(imageProfileIdentity(base)).not.toBe(imageProfileIdentity(changedModel))
    expect(imageProfileIdentity(base)).toBe(imageProfileIdentity(base))
  })

  test('Given 未添加模型的草稿 When 生成拉取身份 Then 不抛错且随端点与凭据变化', () => {
    /** 供应商拉取必须在“还没有任何模型”时可用，否则会退回严格合同校验并抛错。 */
    const empty = { ...createImageGenerationDraft('minimax', 'image-m', 100), models: [] }
    const identity = imageCatalogIdentity(empty)
    expect(identity).toBe(imageCatalogIdentity(empty))

    const changedBaseUrl = { ...empty, baseUrl: 'https://api.minimaxi.com/v1' }
    expect(imageCatalogIdentity(changedBaseUrl)).not.toBe(identity)

    /** 填写新 Key 表示改用草稿凭据，不能和“沿用已保存凭据”混淆。 */
    const withDraftKey = { ...empty, apiKey: 'secret' }
    expect(imageCatalogIdentity(withDraftKey)).not.toBe(identity)
  })
})
