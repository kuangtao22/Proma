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
    ...overrides,
  }
}

describe('独立生图设置页视图', () => {
  test('Given 目录含旧配置 When 渲染列表 Then 展示独立配置与迁移提示', () => {
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController()} />)
    expect(html).toContain('ChatGPT 生图')
    expect(html).toContain('gpt-image-1')
    expect(html).toContain('文生图 + 图生图')
    /** 列表行必须带供应商 Logo，与音频页一致。 */
    expect(html).toContain('src="model-logo.png"')
    expect(html).toContain('旧渠道生图')
    expect(html).toContain('旧配置借用渠道凭据')
  })

  test('Given 即梦草稿 When 渲染表单 Then 没有服务地址与密钥字段而有登录面板', () => {
    const draft = { ...createImageGenerationDraft('dreamina', 'image-d', 10), name: '即梦主号' }
    const html = renderToStaticMarkup(<ImageGenerationCatalogView controller={createController({ draft })} />)
    expect(html).toContain('即梦登录')
    expect(html).toContain('dreamina login')
    expect(html).not.toContain('id="image-base-url"')
    expect(html).not.toContain('id="image-api-key"')
    expect(html).toContain('id="image-model-id"')
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
