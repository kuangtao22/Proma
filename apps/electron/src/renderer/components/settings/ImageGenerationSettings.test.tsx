import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
/** 单测不验证品牌位图，避免 Bun 直接解析 Vite 位图导入。 */
mock.module('@/lib/model-logo', () => ({
  DefaultLogo: 'model-logo.png',
  PromaLogo: 'proma-logo.png',
  getChannelLogo: () => 'model-logo.png',
  getModelLogo: () => 'model-logo.png',
  getProviderLogo: () => 'model-logo.png',
  resolveModelDisplayName: (modelId: string) => modelId,
  resolveModelProvider: () => 'unknown',
}))
import type { ImageGenerationSettingsResult } from '@proma/shared'
import { EMPTY_DREAMINA_LOGIN } from './ImageGenerationSettings.controller'
import type { ImageGenerationController } from './ImageGenerationSettings.controller'
/** 位图 mock 必须先于组件模块加载，因此这里使用动态导入。 */
const { ImageGenerationCatalogView } = await import('./ImageGenerationSettings')
const { createImageGenerationDraft, imageCatalogIdentity, profileToDraft } = await import('./ImageGenerationSettings.logic')

/** 构造权威设置快照。 */
function createSettings(): ImageGenerationSettingsResult {
  return {
    catalog: {
      schemaVersion: 1,
      revision: 2,
      profiles: [{
        id: 'image-1',
        name: 'ChatGPT 生图',
        provider: 'openai-images',
        baseUrl: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-image-1', capabilities: ['text-to-image', 'image-to-image'] }],
        enabled: true,
        createdAt: 1,
        updatedAt: 2,
        credentialConfigured: true,
        endpointOrigin: 'https://api.openai.com',
      }],
    },
    legacyImageProfiles: [{ id: 'legacy-1', name: '旧渠道生图', protocol: 'openai-images', modelId: 'gpt-image-1', enabled: true }],
  }
}

/** 构造只读控制器桩，聚焦渲染断言。 */
function createController(overrides: Partial<ImageGenerationController> = {}): ImageGenerationController {
  const settings = createSettings()
  return {
    settings, loading: false, saving: false, loadError: null, actionError: null, query: '', draft: null,
    deleteId: null, catalog: null, visibleProfiles: settings.catalog.profiles,
    setQuery: () => undefined, load: async () => true, startCreate: () => undefined, startEdit: () => undefined,
    startCopy: () => undefined, updateDraft: () => undefined, closeDraft: () => undefined,
    saveDraft: async () => undefined, toggleEnabled: async () => undefined, requestDelete: () => undefined,
    closeDelete: () => undefined, confirmDelete: async () => undefined, fetchCatalog: async () => undefined,
    /** 即梦面板的默认替身：未查询状态、无进行中的登录。 */
    dreaminaStatus: null, dreaminaLogin: EMPTY_DREAMINA_LOGIN, dreaminaBusy: false,
    refreshDreaminaStatus: async () => undefined, startDreaminaLogin: async () => undefined,
    pollDreaminaLogin: async () => undefined, cancelDreaminaLogin: async () => undefined,
    logoutDreamina: async () => undefined,
    ...overrides,
  }
}

describe('独立生图设置页视图', () => {
  test('Given 目录含旧配置 When 渲染列表 Then 展示独立配置与迁移提示', () => {
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController()} />)
    expect(html).toContain('ChatGPT 生图')
    expect(html).toContain('gpt-image-1')
    /** 摘要改为按产物类别汇总：图片与视频合并后仍要说清构成。 */
    expect(html).toContain('gpt-image-1 · 图片模型')
    /** 列表行必须带供应商 Logo，与音频页一致。 */
    expect(html).toContain('src="model-logo.png"')
    expect(html).toContain('旧渠道生图')
    expect(html).toContain('旧配置借用渠道凭据')
  })

  test('Given 已配置目录 When 渲染列表行 Then 操作区为开关加图标按钮且可复制', () => {
    /** 文字按钮会与相邻操作互相挤压（曾出现“启用中编辑”连成一片）。 */
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController()} />)
    expect(html).toContain('aria-label="停用 ChatGPT 生图"')
    expect(html).toContain('aria-label="复制 ChatGPT 生图"')
    expect(html).toContain('aria-label="编辑 ChatGPT 生图"')
    expect(html).toContain('aria-label="删除 ChatGPT 生图"')
    expect(html).not.toContain('>启用中<')
  })

  test('Given 即梦草稿 When 渲染表单 Then 没有服务地址与密钥字段而有登录面板', () => {
    const draft = { ...createImageGenerationDraft('dreamina', 'image-d', 10), name: '即梦主号' }
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({ draft })} />)
    expect(html).toContain('即梦登录')
    expect(html).toContain('登录即梦')
    /** 即梦走 CLI 登录，必须能在表单里配置 CLI 路径。 */
    expect(html).toContain('id="image-cli-path"')
    expect(html).not.toContain('id="image-base-url"')
    expect(html).not.toContain('id="image-api-key"')
    expect(html).toContain('id="image-model-id"')
  })

  test('Given 即梦已登录 When 渲染登录面板 Then 展示额度与账号操作', () => {
    const draft = { ...createImageGenerationDraft('dreamina', 'image-d', 10), name: '即梦主号' }
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({
      draft,
      dreaminaStatus: { state: 'loggedIn', credit: 987, message: '即梦已登录' },
    })} />)
    expect(html).toContain('本机已登录 · 剩余额度 987')
    /** 登录态属于本机 CLI，界面上必须说明所有即梦配置共用同一账号。 */
    expect(html).toContain('本机所有即梦配置共用同一个账号')
    expect(html).toContain('重新登录')
    expect(html).toContain('退出登录')
    /** 已登录时不再展示「登录即梦」入口，避免重复授权。 */
    expect(html).not.toContain('>登录即梦<')
  })

  test('Given 即梦草稿 When 渲染表单 Then 未查询状态时说明是本机登录态', () => {
    const draft = { ...createImageGenerationDraft('dreamina', 'image-d', 10), name: '即梦主号' }
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({ draft })} />)
    expect(html).toContain('尚未查询本机登录态')
  })

  test('Given 等待授权 When 渲染登录面板 Then 展示设备码与授权入口', () => {
    const draft = { ...createImageGenerationDraft('dreamina', 'image-d', 10), name: '即梦主号' }
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({
      draft,
      dreaminaStatus: { state: 'loggedOut', credit: null, message: '未登录，请先登录即梦' },
      dreaminaLogin: {
        state: 'pending',
        requestId: 'dreamina-1',
        verificationUri: 'https://jimeng.jianying.com/login',
        userCode: 'ABCD-1234',
        expiresInSeconds: 600,
        message: '请在浏览器完成授权，本页会自动刷新登录状态',
      },
    })} />)
    expect(html).toContain('ABCD-1234')
    expect(html).toContain('打开授权页面')
    expect(html).toContain('复制设备码')
    expect(html).toContain('剩余约 10 分钟')
    expect(html).toContain('取消')
  })

  test('Given 密钥型草稿 When 渲染表单 Then 有服务地址与密钥且保留语义明确', () => {
    /** 编辑已有配置时凭据已存在，输入框必须提示“留空即保留”。 */
    const draft = profileToDraft(createSettings().catalog.profiles[0]!)
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({ draft })} />)
    expect(html).toContain('id="image-base-url"')
    expect(html).toContain('id="image-api-key"')
    expect(html).toContain('留空以保留已保存凭据')
    expect(html).toContain('已启用模型')
    expect(html).toContain('从供应商获取')
  })

  test('Given 密钥型草稿 When 渲染密钥输入 Then 默认明文并可临时隐藏', () => {
    /** 与模型配置一致：默认能直接看到 Key，眼睛按钮只负责临时遮挡。 */
    const draft = profileToDraft(createSettings().catalog.profiles[0]!)
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({ draft })} />)
    const apiKeyInput = html.match(/<input[^>]*id="image-api-key"[^>]*>/)?.[0] ?? ''
    expect(apiKeyInput).toContain('type="text"')
    expect(html).toContain('aria-label="隐藏 API Key"')
  })

  test('Given 拉取失败 When 渲染可用模型 Then 展示固定失败提示', () => {
    const draft = { ...createImageGenerationDraft('openai-images', 'image-o', 10), name: 'GPT' }
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({
      draft,
      catalog: { state: 'failed', message: '鉴权失败，请检查 API Key', models: [], draftIdentity: imageCatalogIdentity(draft) },
    })} />)
    expect(html).toContain('鉴权失败，请检查 API Key')
  })

  test('Given MiniMax 草稿清空模型 When 渲染可用模型 Then 列出官方内置图像模型', () => {
    /** 供应商拉取失败或只返回对话模型时，内置清单必须仍然可添加。 */
    const draft = { ...createImageGenerationDraft('minimax', 'image-m', 10), name: '我的', models: [] }
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({ draft })} />)
    expect(html).toContain('Image 01')
    expect(html).toContain('Image 01 Live')
  })

  test('Given 即梦草稿 When 渲染模型列表 Then 图片与视频合并展示且可分类筛选', () => {
    const draft = { ...createImageGenerationDraft('dreamina', 'image-d', 10), name: '即梦主号' }
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({ draft })} />)
    /** 分区描述按产物类别分别计数，而不是只给一个总数。 */
    expect(html).toContain('9 个图片模型 · 8 个视频模型')
    expect(html).toContain('全部 17')
    /** 能力用中文标签，视频能力必须能看见。 */
    expect(html).toContain('文生视频')
    expect(html).toContain('首尾帧')
  })

  test('Given 图片与视频混排 When 渲染筛选栏 Then 每档都带数量便于回退', () => {
    /** 筛选残留曾让配置看起来像没有模型，计数与退路必须始终可见。 */
    const draft = { ...createImageGenerationDraft('minimax', 'image-m', 10), name: '我的', models: [] }
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({ draft })} />)
    expect(html).toContain('全部 0')
    expect(html).toContain('图片 0')
    expect(html).toContain('视频 0')
  })

  test('Given MiniMax 草稿 When 清空模型 Then 可用模型同时列出图片与视频', () => {
    const draft = { ...createImageGenerationDraft('minimax', 'image-m', 10), name: '我的', models: [] }
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({ draft })} />)
    expect(html).toContain('MiniMax Hailuo 2.3')
    expect(html).toContain('I2V-01 Live')
    /** 只做图生视频的模型不能标成文生视频。 */
    expect(html).toContain('图生视频')
  })

  test('Given 内置模型已全部启用 When 拉取成功但无新增 Then 提示可用模型都已添加', () => {
    /** MiniMax 的 /v1/models 只返回对话模型，过滤后为空，此时不能显示成拉取失败。 */
    const draft = { ...createImageGenerationDraft('minimax', 'image-m', 10), name: '我的' }
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({
      draft,
      catalog: { state: 'success', models: [], draftIdentity: imageCatalogIdentity(draft) },
    })} />)
    expect(html).toContain('可用的模型都已添加')
    expect(html).not.toContain('从供应商获取失败')
  })
})
