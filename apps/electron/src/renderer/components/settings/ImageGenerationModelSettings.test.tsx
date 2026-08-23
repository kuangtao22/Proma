import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ImageGenerationModelCatalogResult, ImageGenerationModelProfile } from '@proma/shared'
import {
  IMAGE_GENERATION_MODEL_ID_MAX_LENGTH,
  IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH,
} from '@proma/shared'
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

/** 创建状态机测试使用的公开模型目录结果。 */
function createCatalog(
  profiles: ImageGenerationModelProfile[],
  credentialsConfigured = true,
): ImageGenerationModelCatalogResult {
  return { profiles, credentialsConfigured, inheritedFromLegacyConfig: false }
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

  test('Given 名称和模型 ID 达到或超过共享上限 When 本地校验 Then 最大值保留且超限明确阻断', () => {
    const { validateImageGenerationModelProfiles } = imageModelSettingsModule
    /** 最大合法名称用于证明 Renderer 与主进程采用同一闭区间边界。 */
    const maximumName = '名'.repeat(IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH)
    /** 最大合法模型 ID 不应被 Renderer 截断或拒绝。 */
    const maximumModelId = 'm'.repeat(IMAGE_GENERATION_MODEL_ID_MAX_LENGTH)

    expect(validateImageGenerationModelProfiles([
      createProfile('maximum', maximumName, maximumModelId),
    ])).toBeNull()
    expect(validateImageGenerationModelProfiles([
      createProfile('long-name', `${maximumName}名`, maximumModelId),
    ])).toBe(`生图模型名称不能超过 ${IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH} 个字符`)
    expect(validateImageGenerationModelProfiles([
      createProfile('long-model', maximumName, `${maximumModelId}m`),
    ])).toBe(`生图模型「${maximumName}」的模型 ID 不能超过 ${IMAGE_GENERATION_MODEL_ID_MAX_LENGTH} 个字符`)
  })

  test('Given 生图模型设置输入 When 渲染 Then 名称和模型 ID 使用共享 maxLength', () => {
    const { ImageGenerationModelSettingsView } = imageModelSettingsModule
    /** 静态 HTML 锁定两个输入分别使用对应共享边界。 */
    const html = renderToStaticMarkup(
      <ImageGenerationModelSettingsView
        profiles={[createProfile('profile-flash', 'Flash', 'gemini-flash')]}
        credentialsConfigured
        saving={false}
        onProfilesChange={() => undefined}
        onSave={() => undefined}
      />,
    )

    expect(html).toMatch(new RegExp(`aria-label="生图模型名称 [^"]+"[^>]*maxLength="${IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH}"`))
    expect(html).toMatch(new RegExp(`aria-label="生图模型 ID [^"]+"[^>]*maxLength="${IMAGE_GENERATION_MODEL_ID_MAX_LENGTH}"`))
  })

  test('Given 字段校验失败 When 渲染设置 Then 具体输入关联错误并通过 alert 宣告', () => {
    const { ImageGenerationModelSettingsView } = imageModelSettingsModule
    const html = renderToStaticMarkup(
      <ImageGenerationModelSettingsView
        profiles={[createProfile('profile-flash', '', '')]}
        credentialsConfigured
        saving={false}
        onProfilesChange={() => undefined}
        onSave={() => undefined}
      />,
    )

    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby="image-model-0-name-error"')
    expect(html).toContain('aria-describedby="image-model-0-model-id-error"')
    expect(html).toContain('id="image-model-0-name-error" role="alert"')
    expect(html).toContain('id="image-model-0-model-id-error" role="alert"')
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

  test('Given 权威 baseline When 保存 Then 仅新行或实际变化行更新 updatedAt', () => {
    const { prepareImageGenerationModelProfilesForSave } = imageModelSettingsModule
    /** 服务端上次返回的权威模型目录。 */
    const baseline = [
      { ...createProfile('unchanged', 'Flash', 'gemini-flash'), createdAt: 10, updatedAt: 20 },
      { ...createProfile('changed', 'Pro', 'gemini-pro'), createdAt: 11, updatedAt: 21 },
    ]
    /** 当前编辑态包含未改行、改名行和新增行。 */
    const editing = [
      { ...baseline[0]!, name: ' Flash ' },
      { ...baseline[1]!, name: 'Pro 2', createdAt: 999, updatedAt: 999 },
      { ...createProfile('new', 'New', 'gemini-new'), createdAt: 30, updatedAt: 30 },
    ]

    expect(prepareImageGenerationModelProfilesForSave(editing, baseline, 100)).toEqual([
      baseline[0]!,
      { ...baseline[1]!, name: 'Pro 2', updatedAt: 100 },
      { ...editing[2]!, updatedAt: 100 },
    ])
  })

  test('Given dirty 编辑 When 凭据或外部目录后台刷新 Then 保留表单并只标记真实目录变化', () => {
    const {
      createImageGenerationModelSettingsState,
      reduceImageGenerationModelSettingsState,
    } = imageModelSettingsModule
    /** 初始加载后的权威目录。 */
    const baseline = [createProfile('profile-flash', 'Flash', 'gemini-flash')]
    let state = createImageGenerationModelSettingsState(createCatalog(baseline, false))
    /** 用户尚未保存的本地名称。 */
    const editing = [{ ...baseline[0]!, name: '本地编辑' }]
    state = reduceImageGenerationModelSettingsState(state, { type: 'profiles-edited', profiles: editing })

    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-started', requestGeneration: 1, mode: 'background',
    })
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-succeeded', requestGeneration: 1, mode: 'background',
      result: createCatalog(baseline, true),
    })
    expect(state.profiles).toEqual(editing)
    expect(state.credentialsConfigured).toBe(true)
    expect(state.externalUpdatePending).toBe(false)

    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-started', requestGeneration: 2, mode: 'background',
    })
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-succeeded', requestGeneration: 2, mode: 'background',
      result: createCatalog([createProfile('profile-pro', '外部配置', 'gemini-pro')]),
    })
    expect(state.profiles).toEqual(editing)
    expect(state.externalUpdatePending).toBe(true)
    expect(state.editGeneration).toBe(1)
  })

  test('Given 后台刷新失败或请求乱序 When 归约结果 Then 保留表单且旧请求不能覆盖新请求', () => {
    const {
      createImageGenerationModelSettingsState,
      reduceImageGenerationModelSettingsState,
    } = imageModelSettingsModule
    /** 初始权威目录。 */
    const baseline = [createProfile('profile-flash', 'Flash', 'gemini-flash')]
    let state = createImageGenerationModelSettingsState(createCatalog(baseline))
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-started', requestGeneration: 1, mode: 'background',
    })
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-started', requestGeneration: 2, mode: 'background',
    })
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-succeeded', requestGeneration: 2, mode: 'background',
      result: createCatalog([createProfile('profile-pro', 'Pro', 'gemini-pro')]),
    })
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-succeeded', requestGeneration: 1, mode: 'background',
      result: createCatalog([createProfile('stale', '旧请求', 'gemini-stale')], false),
    })
    expect(state.profiles[0]?.id).toBe('profile-pro')
    expect(state.credentialsConfigured).toBe(true)

    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-started', requestGeneration: 3, mode: 'background',
    })
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-failed', requestGeneration: 3, message: '读取失败',
    })
    expect(state.profiles[0]?.id).toBe('profile-pro')
    expect(state.loadError).toBe('读取失败')
    expect(state.initialLoading).toBe(false)
  })

  test('Given 保存前后台读取仍在途 When 保存先成功 Then 迟到读取不得覆盖保存结果', () => {
    const {
      createImageGenerationModelSettingsState,
      reduceImageGenerationModelSettingsState,
    } = imageModelSettingsModule
    /** 保存前的旧权威目录。 */
    const baseline = [createProfile('profile-flash', 'Flash', 'gemini-flash')]
    let state = createImageGenerationModelSettingsState(createCatalog(baseline))
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-started', requestGeneration: 1, mode: 'background',
    })
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'save-succeeded',
      result: createCatalog([createProfile('profile-pro', '保存结果', 'gemini-pro')]),
    })
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-succeeded', requestGeneration: 1, mode: 'background',
      result: createCatalog(baseline),
    })

    expect(state.profiles[0]?.id).toBe('profile-pro')
  })

  test('Given 显式重载发出后用户继续编辑 When 重载响应迟到 Then 保留新编辑并标记外部更新', () => {
    const {
      createImageGenerationModelSettingsState,
      reduceImageGenerationModelSettingsState,
    } = imageModelSettingsModule
    /** 重载前的权威目录。 */
    const baseline = [createProfile('profile-flash', 'server-v1', 'gemini-flash')]
    let state = createImageGenerationModelSettingsState(createCatalog(baseline))
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'profiles-edited',
      profiles: [{ ...baseline[0]!, name: 'local-before' }],
    })
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-started', requestGeneration: 1, mode: 'reload',
    })
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'profiles-edited',
      profiles: [{ ...baseline[0]!, name: 'local-after' }],
    })
    state = reduceImageGenerationModelSettingsState(state, {
      type: 'request-succeeded', requestGeneration: 1, mode: 'reload',
      result: createCatalog([{ ...baseline[0]!, name: 'server-v2' }]),
    })

    expect(state.profiles[0]?.name).toBe('local-after')
    expect(state.dirty).toBe(true)
    expect(state.externalUpdatePending).toBe(true)
  })

  test('Given dirty 表单发现外部更新 When 渲染 Then 提供明确重新加载入口', () => {
    const { ImageGenerationModelSettingsView } = imageModelSettingsModule
    const html = renderToStaticMarkup(
      <ImageGenerationModelSettingsView
        profiles={[createProfile('profile-flash', '本地编辑', 'gemini-flash')]}
        credentialsConfigured
        saving={false}
        externalUpdatePending
        loadError="上次刷新失败"
        onProfilesChange={() => undefined}
        onSave={() => undefined}
        onReload={() => undefined}
        onRetry={() => undefined}
      />,
    )

    expect(html).toContain('外部配置已更新')
    expect(html).toContain('重新加载')
    expect(html).toContain('上次刷新失败')
    expect(html).toContain('重试')
    expect(html).toContain('value="本地编辑"')
  })

  test('Given 重载或重试正在进行 When 渲染设置 Then 保存重载重试禁用但表单仍可编辑', () => {
    const { ImageGenerationModelSettingsView } = imageModelSettingsModule
    const html = renderToStaticMarkup(
      <ImageGenerationModelSettingsView
        profiles={[createProfile('profile-flash', '本地编辑', 'gemini-flash')]}
        credentialsConfigured
        saving={false}
        externalUpdatePending
        loadError="上次刷新失败"
        reloadInProgress
        onProfilesChange={() => undefined}
        onSave={() => undefined}
        onReload={() => undefined}
        onRetry={() => undefined}
      />,
    )

    expect((html.match(/disabled=""/g) ?? []).length).toBe(3)
    expect(html).not.toMatch(/<input[^>]*disabled=""/)
  })

  test('Given 重载请求已同步进入 When 尝试保存 Then 不调用保存 API', async () => {
    const { canStartImageGenerationModelSave } = imageModelSettingsModule
    /** 记录模拟保存 API 的调用次数。 */
    let saveCalls = 0
    /** 模拟主进程保存 API，只有 gate 放行后才能调用。 */
    const saveImageModelProfiles = async (): Promise<void> => { saveCalls += 1 }

    if (canStartImageGenerationModelSave(false, true)) {
      await saveImageModelProfiles()
    }

    expect(saveCalls).toBe(0)
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

test('Given Nano Banana 凭据保存成功 When 完成工具刷新 Then Renderer 不自行模拟模型目录广播', async () => {
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
  })

  expect(calls).toEqual([
    'save:legacy-chat-model',
    'refresh-tools',
  ])
})
