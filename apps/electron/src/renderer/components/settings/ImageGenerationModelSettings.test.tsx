import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ImageGenerationModelProfile } from '@proma/shared'
import * as imageModelSettingsModule from './ImageGenerationModelSettings'
import * as toolSettingsModule from './ToolSettings'

/** 创建生图模型设置测试使用的 profile。 */
function createProfile(
  id: string,
  name: string,
  modelId: string,
  enabled = true,
): ImageGenerationModelProfile {
  return {
    id,
    name,
    executor: 'nano-banana',
    modelId,
    enabled,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('ImageGenerationModelSettings', () => {
  test('Given 两个生图 profile When 渲染设置 Then 显示名称、真实模型 ID、启停和删除命令', () => {
    const { ImageGenerationModelSettingsView } = imageModelSettingsModule
    const html = renderToStaticMarkup(
      <ImageGenerationModelSettingsView
        profiles={[
          createProfile('profile-flash', 'Flash', 'gemini-flash'),
          createProfile('profile-pro', 'Pro', 'gemini-pro'),
        ]}
        credentialsConfigured
        saving={false}
        onProfilesChange={() => undefined}
        onSave={() => undefined}
      />,
    )

    expect(html).toContain('value="Flash"')
    expect(html).toContain('value="gemini-flash"')
    expect(html).toContain('value="Pro"')
    expect(html).toContain('value="gemini-pro"')
    expect(html).toContain('aria-label="启用生图模型 Flash"')
    expect(html).toContain('aria-label="删除生图模型 Pro"')
    expect(html).toContain('保存模型配置')
    expect(html.match(/settings-card/g)?.length ?? 0).toBe(1)
  })

  test('Given 未配置 API Key When 渲染模型设置 Then 明确提示并禁用保存', () => {
    const { ImageGenerationModelSettingsView } = imageModelSettingsModule
    const html = renderToStaticMarkup(
      <ImageGenerationModelSettingsView
        profiles={[createProfile('profile-flash', 'Flash', 'gemini-flash')]}
        credentialsConfigured={false}
        saving={false}
        onProfilesChange={() => undefined}
        onSave={() => undefined}
      />,
    )

    expect(html).toContain('请先配置 Nano Banana API Key')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>[\s\S]*保存模型配置/)
  })

  test('Given 模型列表为空 When 渲染设置 Then 展示新增入口且保存保持禁用', () => {
    const { ImageGenerationModelSettingsView } = imageModelSettingsModule
    const html = renderToStaticMarkup(
      <ImageGenerationModelSettingsView
        profiles={[]}
        credentialsConfigured
        saving={false}
        onProfilesChange={() => undefined}
        onSave={() => undefined}
      />,
    )

    expect(html).toContain('尚未配置生图模型')
    expect(html).toContain('新增模型')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>[\s\S]*保存模型配置/)
  })

  test('Given 正在保存 When 渲染设置 Then 编辑、启停、删除、新增和保存均禁用', () => {
    const { ImageGenerationModelSettingsView } = imageModelSettingsModule
    const html = renderToStaticMarkup(
      <ImageGenerationModelSettingsView
        profiles={[createProfile('profile-flash', 'Flash', 'gemini-flash')]}
        credentialsConfigured
        saving
        onProfilesChange={() => undefined}
        onSave={() => undefined}
      />,
    )

    expect(html).toContain('保存中...')
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  test('Given 名称、模型 ID 或 profile ID 非法 When 本地校验 Then 返回可操作错误', () => {
    const { validateImageGenerationModelProfiles } = imageModelSettingsModule

    expect(validateImageGenerationModelProfiles([
      createProfile('profile-flash', ' ', 'gemini-flash'),
    ])).toBe('第 1 个生图模型缺少名称')
    expect(validateImageGenerationModelProfiles([
      createProfile('profile-flash', 'Flash', ' '),
    ])).toBe('生图模型「Flash」缺少模型 ID')
    expect(validateImageGenerationModelProfiles([
      createProfile('profile-flash', 'Flash', 'gemini-flash'),
      createProfile('profile-flash', 'Pro', 'gemini-pro'),
    ])).toBe('生图模型配置 ID 重复，请删除重复项后重试')
  })

  test('Given 新增模型 When 创建 profile Then 使用稳定 ID 和同一时间戳', () => {
    const { createImageGenerationModelProfile } = imageModelSettingsModule

    expect(createImageGenerationModelProfile('profile-new', 1234)).toEqual({
      id: 'profile-new',
      name: '',
      executor: 'nano-banana',
      modelId: '',
      enabled: true,
      createdAt: 1234,
      updatedAt: 1234,
    })
  })
})

test('Given 普通会话已保存旧模型 When 更新 Nano Banana 连接信息 Then 原样保留旧模型', () => {
  const { createNanoBananaCredentialsUpdate } = toolSettingsModule

  expect(createNanoBananaCredentialsUpdate(
    '  new-key  ',
    '  https://example.com  ',
    { apiKey: 'old-key', baseUrl: '', model: 'legacy-chat-model' },
  )).toEqual({
    apiKey: 'new-key',
    baseUrl: 'https://example.com',
    model: 'legacy-chat-model',
  })
})

test('Given Nano Banana 凭据保存成功 When 完成工具刷新 Then 通知生图模型目录重新读取', async () => {
  const { persistNanoBananaCredentialsUpdate } = toolSettingsModule
  /** 记录凭据保存后的顺序，目录只能在持久化完成后刷新。 */
  const calls: string[] = []
  /** 待保存且保留旧普通会话模型的完整凭据。 */
  const credentials = {
    apiKey: 'new-key',
    baseUrl: 'https://example.com',
    model: 'legacy-chat-model',
  }

  await persistNanoBananaCredentialsUpdate(credentials, {
    updateCredentials: async (input) => { calls.push(`save:${input.model}`) },
    refreshChatTools: async () => { calls.push('refresh-tools') },
    notifyImageModelCatalog: () => { calls.push('refresh-models') },
  })

  expect(calls).toEqual([
    'save:legacy-chat-model',
    'refresh-tools',
    'refresh-models',
  ])
})
