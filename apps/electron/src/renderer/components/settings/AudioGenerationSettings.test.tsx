import { describe, expect, mock, test } from 'bun:test'

import * as React from 'react'
/** 单测不验证供应商品牌位图，避免 Bun 直接解析 Vite 位图导入。 */
mock.module('@/lib/model-logo', () => ({
  DefaultLogo: 'model-logo.png',
  PromaLogo: 'proma-logo.png',
  getChannelLogo: () => 'model-logo.png',
  getModelLogo: () => 'model-logo.png',
  getProviderLogo: () => 'model-logo.png',
  resolveModelDisplayName: (modelId: string) => modelId,
  resolveModelProvider: () => 'unknown',
}))
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  AudioGenerationCatalogFetchInput,
  AudioGenerationCatalogFetchResult,
  AudioGenerationProfile,
  AudioGenerationSettingsResult,
  AudioGenerationTestInput,
  AudioGenerationTestResult,
  ReplaceAudioGenerationCatalogRequest,
} from '@proma/shared'
import type {
  AudioGenerationController,
  AudioGenerationControllerOptions,
} from './AudioGenerationSettings'
/** 位图 mock 必须先于组件模块加载，因此这里使用动态导入。 */
const {
  AudioGenerationSettings,
  AudioGenerationCatalogView,
  buildAudioRequestPreview,
  catalogIdentity,
  changeAudioGenerationProvider,
  copyAudioGenerationProfile,
  createCredentialUpdate,
  filterAudioGenerationProfiles,
  resolveVoiceCapability,
  useAudioGenerationSettingsController,
} = await import('./AudioGenerationSettings')
const mediaSettingsModule = await import('./MediaSettings')

/** 构建不包含任何秘密的权威音频设置快照。 */
function createSettings(revision = 4): AudioGenerationSettingsResult {
  return {
    catalog: {
      schemaVersion: 3,
      revision,
      profiles: [
        {
          id: 'xiaomi-1', name: '小米旁白', provider: 'xiaomi', baseUrl: 'https://tts.example.com/private/path',
          models: [{ id: 'mimo-v1', voices: [{ id: 'xiaomi-voice', name: '小米旁白音色', source: 'manual' as const }] }],
          enabled: true, createdAt: 1, updatedAt: 2,
          credentialConfigured: true, endpointOrigin: 'https://tts.example.com',
        },
        {
          id: 'minimax-1', name: 'MiniMax 配音', provider: 'minimax', baseUrl: 'https://api.minimax.chat/v1/t2a/hidden-path',
          models: [{ id: 'speech-02-hd', voices: [{ id: 'male-qn-qingse', source: 'remote' as const }] }], groupId: 'group-secretish', enabled: true,
          createdAt: 2, updatedAt: 3, credentialConfigured: true, endpointOrigin: 'https://api.minimax.chat',
          legacyMediaProfileId: 'legacy-1',
        },
      ],
    },
    legacyAudioProfiles: [
      { id: 'legacy-1', name: '旧 MiniMax', protocol: 'minimax-speech', modelId: 'speech-02-hd', enabled: true },
      { id: 'legacy-2', name: '待迁移语音', protocol: 'minimax-speech', modelId: 'speech-01', enabled: false },
    ],
    legacyWarning: '旧音频配置读取失败，暂时无法显示迁移提示',
  }
}

/** Controller 测试使用的可控 IPC 替身。 */
function createApi(initial = createSettings()): AudioGenerationControllerOptions['api'] & {
  replacements: ReplaceAudioGenerationCatalogRequest[]
  tests: AudioGenerationTestInput[]
  catalogFetches: AudioGenerationCatalogFetchInput[]
  setCatalogResult: (result: AudioGenerationCatalogFetchResult) => void
  cancellations: string[]
  setSettings: (settings: AudioGenerationSettingsResult) => void
  resolveTest: (result: AudioGenerationTestResult) => void
  deferCancellation: () => void
  resolveCancellations: () => void
  resolveCancellation: (requestId: string) => void
} {
  let settings = initial
  /** 按 requestId 保存并发测试，允许精确模拟旧响应迟到。 */
  const pendingTests = new Map<string, (result: AudioGenerationTestResult) => void>()
  const replacements: ReplaceAudioGenerationCatalogRequest[] = []
  const tests: AudioGenerationTestInput[] = []
  /** 记录目录拉取输入并允许用例决定返回值。 */
  const catalogFetches: AudioGenerationCatalogFetchInput[] = []
  const cancellations: string[] = []
  let catalogResult: AudioGenerationCatalogFetchResult = {
    requestId: 'catalog-1',
    state: 'success',
    message: '已从供应商获取可用模型与音色',
    models: [],
    voices: [],
  }
  let deferCancellation = false
  const pendingCancellationResolvers = new Map<string, Array<() => void>>()
  return {
    replacements,
    tests,
    catalogFetches,
    cancellations,
    setCatalogResult: (next: AudioGenerationCatalogFetchResult) => { catalogResult = next },
    setSettings: (next) => { settings = next },
    resolveTest: (result) => { pendingTests.get(result.requestId)?.(result); pendingTests.delete(result.requestId) },
    deferCancellation: () => { deferCancellation = true },
    resolveCancellations: () => {
      deferCancellation = false
      for (const resolvers of pendingCancellationResolvers.values()) for (const resolve of resolvers) resolve()
      pendingCancellationResolvers.clear()
    },
    resolveCancellation: (requestId) => {
      const resolvers = pendingCancellationResolvers.get(requestId) ?? []
      pendingCancellationResolvers.delete(requestId)
      for (const resolve of resolvers) resolve()
    },
    getSettings: async () => settings,
    replaceCatalog: async (request) => {
      replacements.push(request)
      settings = {
        ...settings,
        catalog: {
          ...settings.catalog,
          revision: settings.catalog.revision + 1,
          profiles: request.profiles.map(({ profile }) => ({
            ...profile,
            credentialConfigured: true,
            endpointOrigin: new URL(profile.baseUrl).origin,
          })),
        },
      }
      return settings
    },
    test: async (input) => {
      tests.push(input)
      return await new Promise<AudioGenerationTestResult>((resolve) => { pendingTests.set(input.requestId, resolve) })
    },
    fetchCatalog: async (input) => {
      catalogFetches.push(input)
      return { ...catalogResult, requestId: input.requestId }
    },
    cancelTest: async (requestId) => {
      cancellations.push(requestId)
      if (deferCancellation) await new Promise<void>((resolve) => {
        pendingCancellationResolvers.set(requestId, [...pendingCancellationResolvers.get(requestId) ?? [], resolve])
      })
    },
  }
}

interface MinimalEventTarget {
  addEventListener: () => void
  removeEventListener: () => void
}

/** 创建仅执行 Hook 的最小 React 宿主。 */
function createControllerRoot(): { render: (node: React.ReactElement) => void; unmount: () => void; restore: () => void } {
  const eventTarget: MinimalEventTarget = { addEventListener: () => undefined, removeEventListener: () => undefined }
  class FakeHtmlIFrameElement {}
  const fakeWindow = { ...eventTarget, event: undefined, HTMLIFrameElement: FakeHtmlIFrameElement }
  const fakeDocument = { ...eventTarget, nodeType: 9, defaultView: fakeWindow, activeElement: null, body: null, documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' } }
  const container = { ...eventTarget, nodeType: 1, tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: fakeDocument }
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(container as unknown as Element)
  return {
    render: (node) => root.render(node),
    unmount: () => root.unmount(),
    restore: () => { globals.window = previousWindow; globals.document = previousDocument; globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment },
  }
}

/** 暴露生产 Controller 供测试触发真实 handler。 */
function ControllerProbe({ onController, ...options }: AudioGenerationControllerOptions & { onController: (controller: AudioGenerationController) => void }): null {
  const controller = useAudioGenerationSettingsController(options)
  React.useEffect(() => onController(controller), [controller, onController])
  return null
}

/** 确保 effect 已发布 Controller。 */
function requireController(controller: AudioGenerationController | null): AudioGenerationController {
  if (!controller) throw new Error('测试 controller 尚未初始化')
  return controller
}

describe('AudioGenerationSettings', () => {
  test('Given API Key 草稿 When 构造凭据更新 Then 新值替换、已配置空值保留、未配置空值拒绝', () => {
    expect(createCredentialUpdate('  new-key  ', true)).toEqual({ mode: 'replace', apiKey: 'new-key' })
    expect(createCredentialUpdate('', true)).toEqual({ mode: 'preserve' })
    expect(() => createCredentialUpdate('  ', false)).toThrow('请输入 API Key')
  })

  test('Given 小米与 MiniMax 草稿 When 切换供应商 Then 清空身份与凭据且严格移除不适用字段', () => {
    const original = { ...createSettings().catalog.profiles[1]!, apiKey: 'secret' }
    const xiaomi = changeAudioGenerationProvider(original, 'xiaomi')
    /** 切换供应商必须自动带入该供应商的官方默认端与默认模型。 */
    expect(xiaomi).toMatchObject({
      provider: 'xiaomi',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: '',
      credentialConfigured: false,
    })
    /** 默认模型直接带出官方内置音色，用户不需要逐条添加。 */
    expect(xiaomi.models[0]?.id).toBe('mimo-v2.5-tts')
    expect(xiaomi.models[0]?.voices.length).toBe(9)
    expect('groupId' in xiaomi).toBeFalse()
    expect(xiaomi.legacyMediaProfileId).toBeUndefined()
    const minimax = changeAudioGenerationProvider(xiaomi, 'minimax')
    expect(minimax).toMatchObject({ provider: 'minimax', baseUrl: 'https://api.minimax.cn/v1', groupId: '' })
  })

  test('Given 小米与 MiniMax 服务地址 When 生成预览 Then 归一化斜杠并追加各自请求路径', () => {
    expect(buildAudioRequestPreview('https://api.xiaomimimo.com/v1/', 'xiaomi')).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    expect(buildAudioRequestPreview('  https://api.minimax.cn/v1//  ', 'minimax')).toBe('https://api.minimax.cn/v1/t2a_v2')
  })

  test('Given 已保存或旧迁移配置 When 复制 Then 使用新身份且不继承凭据和旧引用', () => {
    const source = { ...createSettings().catalog.profiles[1]!, apiKey: 'must-not-copy' }
    const copied = copyAudioGenerationProfile(source, 'copy-1', 50)
    expect(copied).toMatchObject({ id: 'copy-1', name: 'MiniMax 配音 副本', provider: 'minimax', groupId: 'group-secretish', createdAt: 50, updatedAt: 50, apiKey: '', credentialConfigured: false })
    expect(copied.legacyMediaProfileId).toBeUndefined()
  })

  test('Given 公开目录 When 搜索和渲染列表 Then 只使用公开摘要且不泄露完整路径、查询或明文 Key', () => {
    const settings = createSettings()
    expect(filterAudioGenerationProfiles(settings.catalog.profiles, 'MiniMax Speech')).toHaveLength(1)
    expect(filterAudioGenerationProfiles(settings.catalog.profiles, 'private/path')).toHaveLength(0)
    const html = renderToStaticMarkup(<AudioGenerationCatalogView controller={{
      settings, loading: false, saving: false, needsReload: false, generationEntryCount: 0, pendingCancellationCount: 0, loadError: null, actionError: null, query: '', draft: null,
      deleteId: null, testStates: {}, visibleProfiles: settings.catalog.profiles,
      setQuery: () => undefined, load: async () => true, startCreate: () => undefined, startEdit: () => undefined,
      startCopy: () => undefined, startMigration: () => undefined, updateDraft: () => undefined, closeDraft: () => undefined,
      saveDraft: async () => undefined, toggleEnabled: async () => undefined, requestDelete: () => undefined,
      closeDelete: () => undefined, confirmDelete: async () => undefined, testProfile: async () => undefined, catalog: null, fetchCatalog: async () => undefined,
    }} />)
    expect(html).toContain('小米 TTS')
    expect(html).toContain('https://tts.example.com')
    expect(html).not.toContain('private/path')
    expect(html).not.toContain('hidden-path')
    expect(html).not.toContain('must-not-copy')
    expect(html).toContain('未验证')
    expect(html).toContain('旧配置，需要重新填写独立凭据')
    expect(html).toContain('已迁移')
    expect(html).toContain('迁移 待迁移语音')
  })

  test('Given 已有音色的配置 When 复制 Then 保留音色集合但不继承凭据', () => {
    const source = { ...createSettings().catalog.profiles[0]!, apiKey: 'must-not-copy' }
    const copied = copyAudioGenerationProfile(source, 'copy-voices', 70)
    expect(copied.models).toEqual([{ id: 'mimo-v1', voices: [{ id: 'xiaomi-voice', name: '小米旁白音色', source: 'manual' }] }])
    /** 模型与音色数组必须是新引用，避免后续编辑反向污染源配置。 */
    expect(copied.models).not.toBe(source.models)
    expect(copied.models[0]!.voices).not.toBe(source.models[0]!.voices)
    expect(JSON.stringify(copied)).not.toContain('must-not-copy')
  })

  test('Given 含音色的草稿 When 渲染表单 Then 展示已启用音色且不再提供手填音色', () => {
    const settings = createSettings()
    const common = {
      settings, loading: false, saving: false, needsReload: false, generationEntryCount: 0, pendingCancellationCount: 0, loadError: null, actionError: null, query: '', deleteId: null, testStates: {}, visibleProfiles: settings.catalog.profiles,
      setQuery: () => undefined, load: async () => true, startCreate: () => undefined, startEdit: () => undefined,
      startCopy: () => undefined, startMigration: () => undefined, updateDraft: () => undefined, closeDraft: () => undefined,
      saveDraft: async () => undefined, toggleEnabled: async () => undefined, requestDelete: () => undefined,
      closeDelete: () => undefined, confirmDelete: async () => undefined, testProfile: async () => undefined, catalog: null, fetchCatalog: async () => undefined,
    } satisfies Omit<AudioGenerationController, 'draft'>
    const html = renderToStaticMarkup(<AudioGenerationCatalogView controller={{ ...common, draft: { ...settings.catalog.profiles[0]!, apiKey: '' } }} />)
    expect(html).toContain('已启用音色')
    expect(html).toContain('1 个音色')
    expect(html).toContain('小米旁白音色')
    expect(html).toContain('移除音色 小米旁白音色')
    /** 音色改为随模型自动带出，界面不再提供手填入口。 */
    expect(html).not.toContain('添加音色')
    expect(html).not.toContain('显示名称（可选）')
  })

  test('Given MiniMax 草稿 When 未拉取 Then 可用模型显示官方内置语音模型', () => {
    const settings = createSettings()
    const minimax = settings.catalog.profiles[1]!
    const html = renderToStaticMarkup(<AudioGenerationCatalogView controller={{
      settings, loading: false, saving: false, needsReload: false, generationEntryCount: 0, pendingCancellationCount: 0, loadError: null, actionError: null, query: '', deleteId: null, testStates: {}, visibleProfiles: settings.catalog.profiles,
      setQuery: () => undefined, load: async () => true, startCreate: () => undefined, startEdit: () => undefined,
      startCopy: () => undefined, startMigration: () => undefined, updateDraft: () => undefined, closeDraft: () => undefined,
      saveDraft: async () => undefined, toggleEnabled: async () => undefined, requestDelete: () => undefined,
      closeDelete: () => undefined, confirmDelete: async () => undefined, testProfile: async () => undefined, fetchCatalog: async () => undefined, catalog: null,
      draft: { ...minimax, apiKey: '' },
    }} />)
    /** 官方 T2A 枚举里的模型必须直接可选，不依赖 /v1/models。 */
    expect(html).toContain('speech-2.8-hd')
    expect(html).toContain('speech-01-turbo')
  })

  test('Given 供应商与模型 When 解析音色能力 Then 小米三种模型语义各不相同', () => {
    expect(resolveVoiceCapability('xiaomi', 'mimo-v2.5-tts')).toBe('voice-id')
    expect(resolveVoiceCapability('xiaomi', ' mimo-v2.5-tts-voiceclone ')).toBe('voice-sample')
    expect(resolveVoiceCapability('xiaomi', 'mimo-v2.5-tts-voicedesign')).toBe('no-voice')
    expect(resolveVoiceCapability('minimax', 'speech-2.5-hd')).toBe('voice-id')
  })

  test('Given 已拉取的目录 When 渲染草稿 Then 可用模型可选且复刻模型提示不适用内置音色', () => {
    const settings = createSettings()
    const draft = { ...settings.catalog.profiles[0]!, apiKey: '' }
    const common = {
      settings, loading: false, saving: false, needsReload: false, generationEntryCount: 0, pendingCancellationCount: 0, loadError: null, actionError: null, query: '', deleteId: null, testStates: {}, visibleProfiles: settings.catalog.profiles,
      setQuery: () => undefined, load: async () => true, startCreate: () => undefined, startEdit: () => undefined,
      startCopy: () => undefined, startMigration: () => undefined, updateDraft: () => undefined, closeDraft: () => undefined,
      saveDraft: async () => undefined, toggleEnabled: async () => undefined, requestDelete: () => undefined,
      closeDelete: () => undefined, confirmDelete: async () => undefined, testProfile: async () => undefined, fetchCatalog: async () => undefined,
    } satisfies Omit<AudioGenerationController, 'draft' | 'catalog'>
    /** 拉取结果必须绑定同一目录身份才会渲染。 */
    const identity = catalogIdentity(draft)
    const html = renderToStaticMarkup(<AudioGenerationCatalogView controller={{
      ...common,
      draft,
      catalog: {
        state: 'success',
        message: '已从供应商获取可用模型与音色',
        models: ['mimo-v2.5-tts', 'mimo-v2.5-tts-voiceclone'],
        voices: [{ id: 'remote-1', name: '远端音色', source: 'remote' }],
        draftIdentity: identity,
      },
    }} />)
    expect(html).toContain('可用模型')
    expect(html).toContain('从供应商获取')
    expect(html).toContain('mimo-v2.5-tts-voiceclone')
    /** 拉到的账号音色不再逐条点选，而是提示会在加入模型时自动带出。 */
    expect(html).toContain('个音色未加入，重新添加该模型即可全部带出')

    /** 切到声音复刻模型后，内置音色与手填行都不应出现。 */
    const cloneHtml = renderToStaticMarkup(<AudioGenerationCatalogView controller={{
      ...common,
      draft: { ...draft, models: [{ id: 'mimo-v2.5-tts-voiceclone', voices: [] }] },
      catalog: null,
    }} />)
    expect(cloneHtml).toContain('voice` 字段必须传音频样本的 base64')
    expect(cloneHtml).not.toContain('MiMo-默认')
  })

  test('Given 草稿填写新 Key When 从供应商获取 Then 用草稿凭据并填充模型与音色', async () => {
    const api = createApi()
    api.setCatalogResult({
      requestId: 'catalog-1',
      state: 'success',
      message: '已从供应商获取可用模型与音色',
      models: ['mimo-v2.5-tts'],
      voices: [{ id: 'remote-1', name: '远端音色', source: 'remote' }],
    })
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startCreate())
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, apiKey: 'draft-key' }))
      await act(async () => { await requireController(controller).fetchCatalog() })

      expect(api.catalogFetches.at(-1)?.credential).toEqual({ mode: 'draft', apiKey: 'draft-key' })
      expect(requireController(controller).catalog?.models).toEqual(['mimo-v2.5-tts'])
      expect(requireController(controller).catalog?.voices).toEqual([{ id: 'remote-1', name: '远端音色', source: 'remote' }])
      /** 默认模型已自动带上官方内置音色，拉取结果不会覆盖它。 */
      expect(requireController(controller).draft?.models[0]?.voices.length).toBeGreaterThan(0)
      expect(requireController(controller).draft?.models[0]?.voices[0]?.source).toBe('builtin')

      /** 已保存配置未填新 Key 时必须改用已保存密文，不能让界面发空凭据。 */
      act(() => requireController(controller).startEdit(requireController(controller).settings!.catalog.profiles[0]!))
      await act(async () => { await requireController(controller).fetchCatalog() })
      expect(api.catalogFetches.at(-1)?.credential).toEqual({ mode: 'saved', profileId: requireController(controller).draft!.id })
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 从供应商获取失败 When 返回失败态 Then 只展示固定文案', async () => {
    const api = createApi()
    api.setCatalogResult({
      requestId: 'catalog-1',
      state: 'failed',
      message: '从供应商获取失败，请检查服务地址与凭据',
      models: [],
      voices: [],
    })
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startCreate())
      /** 填了 Key 才会真正走供应商请求，失败态才有意义。 */
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, apiKey: 'draft-key' }))
      await act(async () => { await requireController(controller).fetchCatalog() })
      expect(requireController(controller).catalog).toMatchObject({
        state: 'failed',
        models: [],
        voices: [],
      })
      expect(requireController(controller).catalog?.message).toBe('从供应商获取失败，请检查服务地址与凭据')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 新建草稿尚未填写 Key When 从供应商获取 Then 不发请求并提示先填 Key', async () => {
    const api = createApi()
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startCreate())
      await act(async () => { await requireController(controller).fetchCatalog() })
      expect(api.catalogFetches).toEqual([])
      expect(requireController(controller).catalog?.state).toBe('failed')
      expect(requireController(controller).catalog?.message).toBe('请先填写 API Key')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 表单切换供应商 When 渲染 Then MiniMax 显示 Group ID、小米不渲染且密码框不回填旧 Key', () => {
    const settings = createSettings()
    const common = {
      settings, loading: false, saving: false, needsReload: false, generationEntryCount: 0, pendingCancellationCount: 0, loadError: null, actionError: null, query: '', deleteId: null, testStates: {}, visibleProfiles: settings.catalog.profiles,
      setQuery: () => undefined, load: async () => true, startCreate: () => undefined, startEdit: () => undefined,
      startCopy: () => undefined, startMigration: () => undefined, updateDraft: () => undefined, closeDraft: () => undefined,
      saveDraft: async () => undefined, toggleEnabled: async () => undefined, requestDelete: () => undefined,
      closeDelete: () => undefined, confirmDelete: async () => undefined, testProfile: async () => undefined, catalog: null, fetchCatalog: async () => undefined,
    } satisfies Omit<AudioGenerationController, 'draft'>
    const minimax = renderToStaticMarkup(<AudioGenerationCatalogView controller={{ ...common, draft: { ...settings.catalog.profiles[1]!, apiKey: '' } }} />)
    expect(minimax).toContain('Group ID')
    expect(minimax).toContain('type="password"')
    expect(minimax).not.toContain('value="must-not-copy"')
    const xiaomi = renderToStaticMarkup(<AudioGenerationCatalogView controller={{ ...common, draft: { ...settings.catalog.profiles[0]!, apiKey: '' } }} />)
    expect(xiaomi).not.toContain('Group ID')
  })

  test('Given 权威目录 When 新增编辑复制启停删除 Then 每次写入完整 CAS 且非目标凭据 preserve', async () => {
    const api = createApi()
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    const onController = (next: AudioGenerationController): void => { controller = next }
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={onController} />) })
      await act(async () => { await requireController(controller).load() })

      act(() => { requireController(controller).startCreate() })
      act(() => { requireController(controller).updateDraft({ ...requireController(controller).draft!, name: '新增小米', baseUrl: 'https://new.example.com', models: [{ id: 'model', voices: [{ id: 'voice', name: 'voice', source: 'manual' }] }], apiKey: 'new-key' }) })
      await act(async () => { await requireController(controller).saveDraft() })
      expect(api.replacements.at(-1)?.expectedRevision).toBe(4)
      expect(api.replacements.at(-1)?.profiles.slice(0, 2).map((item) => item.credentialUpdate)).toEqual([{ mode: 'preserve' }, { mode: 'preserve' }])
      expect(api.replacements.at(-1)?.profiles.at(-1)?.credentialUpdate).toEqual({ mode: 'replace', apiKey: 'new-key' })

      act(() => { requireController(controller).startEdit(requireController(controller).settings!.catalog.profiles[0]!) })
      act(() => { requireController(controller).updateDraft({ ...requireController(controller).draft!, name: '编辑小米', apiKey: '' }) })
      await act(async () => { await requireController(controller).saveDraft() })
      expect(api.replacements.at(-1)?.profiles[0]?.credentialUpdate).toEqual({ mode: 'preserve' })

      await act(async () => { await requireController(controller).toggleEnabled(requireController(controller).settings!.catalog.profiles[0]!, false) })
      expect(api.replacements.at(-1)?.profiles.every((item) => item.credentialUpdate.mode === 'preserve')).toBeTrue()

      act(() => { requireController(controller).requestDelete(requireController(controller).settings!.catalog.profiles[0]!.id) })
      await act(async () => { await requireController(controller).confirmDelete() })
      expect(api.replacements.at(-1)?.profiles.every((item) => item.credentialUpdate.mode === 'preserve')).toBeTrue()
      expect(requireController(controller).deleteId).toBeNull()
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })

  test('Given 保存 CAS 冲突 When 写入 Then 重新读取权威目录且不自动重试', async () => {
    const api = createApi()
    let replaceCalls = 0
    api.replaceCatalog = async () => { replaceCalls += 1; throw new Error('AUDIO_GENERATION_CONFIG_CONFLICT') }
    const authoritative = createSettings(9)
    api.setSettings(authoritative)
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      await act(async () => { await requireController(controller).load() })
      act(() => requireController(controller).startEdit(authoritative.catalog.profiles[0]!))
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, name: '本地修改' }))
      await act(async () => { await requireController(controller).saveDraft() })
      expect(replaceCalls).toBe(1)
      expect(requireController(controller).settings?.catalog.revision).toBe(9)
      expect(requireController(controller).actionError).toContain('重新应用')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 写入结果未知 When 保存 Then 只调用一次 replace 并重新 GET 权威目录', async () => {
    const api = createApi()
    let replaceCalls = 0
    let getCalls = 0
    const originalGet = api.getSettings
    api.getSettings = async () => { getCalls += 1; return await originalGet() }
    api.replaceCatalog = async () => { replaceCalls += 1; throw new Error('AUDIO_GENERATION_CONFIG_OUTCOME_UNKNOWN') }
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      const initialGets = getCalls
      act(() => requireController(controller).startEdit(requireController(controller).settings!.catalog.profiles[0]!))
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, name: '未知结果编辑' }))
      await act(async () => { await requireController(controller).saveDraft() })
      expect(replaceCalls).toBe(1)
      expect(getCalls).toBe(initialGets + 1)
      expect(requireController(controller).actionError).toContain('写入结果未知')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given CAS 结果需回读但 GET 失败 When 后续操作 Then 保持锁定直到显式重试成功', async () => {
    for (const code of ['AUDIO_GENERATION_CONFIG_CONFLICT', 'AUDIO_GENERATION_CONFIG_OUTCOME_UNKNOWN'] as const) {
      const api = createApi()
      const originalGet = api.getSettings
      const originalReplace = api.replaceCatalog
      let failGet = false
      api.getSettings = async () => {
        if (failGet) throw new Error('private reload detail')
        return await originalGet()
      }
      api.replaceCatalog = async (request) => {
        api.replacements.push(request)
        throw new Error(code)
      }
      let controller: AudioGenerationController | null = null
      const host = createControllerRoot()
      try {
        await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
        const profile = requireController(controller).settings!.catalog.profiles[0]!
        act(() => requireController(controller).startEdit(profile))
        act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, name: '本地待确认修改' }))
        failGet = true
        await act(async () => { await requireController(controller).saveDraft() })
        expect(api.replacements).toHaveLength(1)
        expect((requireController(controller) as AudioGenerationController & { needsReload: boolean }).needsReload).toBeTrue()
        expect(requireController(controller).actionError).toContain('配置状态未知')
        expect(requireController(controller).actionError).toContain('重新加载失败')
        expect(requireController(controller).actionError).not.toContain('private')
        await act(async () => { await requireController(controller).saveDraft() })
        await act(async () => { await requireController(controller).toggleEnabled(profile, false) })
        await act(async () => { await requireController(controller).testProfile(profile) })
        expect(api.replacements).toHaveLength(1)
        expect(api.tests).toHaveLength(0)

        api.setSettings(createSettings(9))
        failGet = false
        let reloadSucceeded = false
        await act(async () => { reloadSucceeded = await requireController(controller).load() })
        expect(reloadSucceeded).toBeTrue()
        expect((requireController(controller) as AudioGenerationController & { needsReload: boolean }).needsReload).toBeFalse()
        expect(requireController(controller).settings?.catalog.revision).toBe(9)
        api.replaceCatalog = originalReplace
        await act(async () => { await requireController(controller).toggleEnabled(requireController(controller).settings!.catalog.profiles[0]!, false) })
        expect(api.replacements).toHaveLength(2)
      } finally { act(() => host.unmount()); host.restore() }
    }
  })

  test('Given 首次读取失败 When 重试成功 Then 清除错误并展示权威空目录', async () => {
    const api = createApi({ catalog: { schemaVersion: 3, revision: 0, profiles: [] }, legacyAudioProfiles: [] })
    let fail = true
    const originalGet = api.getSettings
    api.getSettings = async () => {
      if (fail) throw new Error('private upstream detail')
      return await originalGet()
    }
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      expect(requireController(controller).loadError).toBe('音频配置读取失败，请重试。')
      expect(requireController(controller).settings).toBeNull()
      fail = false
      await act(async () => { await requireController(controller).load() })
      expect(requireController(controller).loadError).toBeNull()
      expect(requireController(controller).settings?.catalog.profiles).toEqual([])
      const html = renderToStaticMarkup(<AudioGenerationCatalogView controller={requireController(controller)} />)
      expect(html).toContain('尚未配置音频生成服务')
      expect(html).not.toContain('private upstream detail')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 现有配置与旧目录 When 触发复制和迁移 Then 都创建必须重填 Key 的独立草稿', async () => {
    const api = createApi()
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startCopy(requireController(controller).settings!.catalog.profiles[1]!))
      expect(requireController(controller).draft).toMatchObject({ name: 'MiniMax 配音 副本', apiKey: '', credentialConfigured: false })
      expect(requireController(controller).draft?.legacyMediaProfileId).toBeUndefined()
      act(() => requireController(controller).closeDraft())
      act(() => requireController(controller).startMigration('legacy-2'))
      expect(requireController(controller).draft).toMatchObject({
        name: '待迁移语音', provider: 'minimax', models: [{ id: 'speech-01', voices: [] }], groupId: '',
        apiKey: '', credentialConfigured: false, legacyMediaProfileId: 'legacy-2', enabled: false,
      })
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 复制配置 When 填写新 Key 并保存 Then 新 ID 使用 replace 且其它配置 preserve', async () => {
    const api = createApi()
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      const source = requireController(controller).settings!.catalog.profiles[1]!
      act(() => requireController(controller).startCopy(source))
      const copyId = requireController(controller).draft!.id
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, apiKey: 'copy-key' }))
      await act(async () => { await requireController(controller).saveDraft() })
      const request = api.replacements.at(-1)!
      expect(copyId).not.toBe(source.id)
      expect(request.profiles.slice(0, 2).every((item) => item.credentialUpdate.mode === 'preserve')).toBeTrue()
      expect(request.profiles.at(-1)).toMatchObject({ profile: { id: copyId }, credentialUpdate: { mode: 'replace', apiKey: 'copy-key' } })
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 旧配置迁移 When 保存再删除独立配置 Then 已迁移状态与迁移入口按权威目录恢复', async () => {
    const api = createApi()
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startMigration('legacy-2'))
      /** 迁移入口按合同固定生成 MiniMax 判别分支。 */
      const migrationDraft = requireController(controller).draft
      if (migrationDraft?.provider !== 'minimax') throw new Error('迁移草稿供应商错误')
      act(() => requireController(controller).updateDraft({ ...migrationDraft, baseUrl: 'https://api.minimax.chat', models: [{ id: 'speech-01', voices: [{ id: 'voice', name: 'voice', source: 'manual' }] }], groupId: 'group', apiKey: 'migration-key' }))
      await act(async () => { await requireController(controller).saveDraft() })
      let html = renderToStaticMarkup(<AudioGenerationCatalogView controller={requireController(controller)} />)
      expect(html).toContain('已迁移')
      expect(html).not.toContain('迁移 待迁移语音')
      const migrated = requireController(controller).settings!.catalog.profiles.find((profile) => profile.legacyMediaProfileId === 'legacy-2')!
      act(() => requireController(controller).requestDelete(migrated.id))
      await act(async () => { await requireController(controller).confirmDelete() })
      html = renderToStaticMarkup(<AudioGenerationCatalogView controller={requireController(controller)} />)
      expect(html).toContain('迁移 待迁移语音')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 删除写入失败 When 确认 Then 保留受控弹窗目标与稳定错误供重试', async () => {
    const api = createApi()
    api.replaceCatalog = async () => { throw new Error('sensitive delete failure') }
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      const profile = requireController(controller).settings!.catalog.profiles[0]!
      act(() => requireController(controller).requestDelete(profile.id))
      await act(async () => { await requireController(controller).confirmDelete() })
      expect(requireController(controller).deleteId).toBe(profile.id)
      expect(requireController(controller).actionError).toBe('音频配置操作失败，请重试。')
      expect(requireController(controller).actionError).not.toContain('sensitive')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 已保存配置测试 When 返回四种终态 Then 当前窗口准确区分且不展示上游正文', async () => {
    const api = createApi()
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      const profile = requireController(controller).settings!.catalog.profiles[0]!
      const expected = { success: '测试成功', failed: '测试失败', cancelled: '测试已取消', unavailable: '暂不可测试' } as const
      for (const state of ['success', 'failed', 'cancelled', 'unavailable'] as const) {
        let pending: Promise<void> = Promise.resolve()
        act(() => { pending = requireController(controller).testProfile(profile) })
        const requestId = api.tests.at(-1)!.requestId
        api.resolveTest({ requestId, state, message: `private-${state}` })
        await act(async () => { await pending })
        expect(requireController(controller).testStates[profile.id]?.message).toBe(expected[state])
        expect(requireController(controller).testStates[profile.id]?.message).not.toContain('private')
        expect(requireController(controller).testStates[profile.id]).toMatchObject({
          catalogRevision: 4,
          profileFingerprint: expect.any(String),
          credentialGeneration: expect.any(Number),
          testGeneration: expect.any(Number),
        })
        expect(JSON.stringify(requireController(controller).testStates[profile.id])).not.toContain('key')
      }
      const html = renderToStaticMarkup(<AudioGenerationCatalogView controller={requireController(controller)} />)
      expect(html).toContain('暂不可测试')
      expect(html).not.toContain('text-destructive">暂不可测试')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 第二次测试等待取消 When 用户改 Key、返回、复制或删除 Then 等待结束后不得启动新测试', async () => {
    for (const action of ['key', 'back', 'copy', 'delete'] as const) {
      const api = createApi()
      let controller: AudioGenerationController | null = null
      const host = createControllerRoot()
      try {
        await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
        const profile = requireController(controller).settings!.catalog.profiles[0]!
        act(() => requireController(controller).startEdit(profile))
        let first: Promise<void> = Promise.resolve()
        act(() => { first = requireController(controller).testProfile() })
        api.deferCancellation()
        let second: Promise<void> = Promise.resolve()
        act(() => { second = requireController(controller).testProfile() })
        await act(async () => { await Promise.resolve() })
        if (action === 'key') act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, apiKey: 'new-secret' }))
        if (action === 'back') act(() => requireController(controller).closeDraft())
        if (action === 'copy') act(() => requireController(controller).startCopy(profile))
        if (action === 'delete') act(() => { requireController(controller).closeDraft(); requireController(controller).requestDelete(profile.id) })
        await act(async () => { api.resolveCancellations(); await Promise.resolve(); await Promise.resolve() })
        /** RED 实现若错误启动第二个请求，也先结束它，避免用超时冒充断言失败。 */
        const unexpected = api.tests[1]
        if (unexpected) api.resolveTest({ requestId: unexpected.requestId, state: 'cancelled', message: 'unexpected' })
        await act(async () => { await second })
        expect(api.tests).toHaveLength(1)
        api.resolveTest({ requestId: api.tests[0]!.requestId, state: 'cancelled', message: 'late' })
        await act(async () => { await first })
      } finally { act(() => host.unmount()); host.restore() }
    }
  })

  test('Given 第二次草稿测试取消旧请求失败 When 重试取消成功 Then 失败时不发新请求且草稿身份时间稳定', async () => {
    const api = createApi()
    let cancelAttempts = 0
    api.cancelTest = async (requestId) => {
      api.cancellations.push(requestId)
      cancelAttempts += 1
      if (cancelAttempts === 1) throw new Error('private cancel detail')
    }
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    let first: Promise<void> = Promise.resolve()
    let third: Promise<void> = Promise.resolve()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      const profile = requireController(controller).settings!.catalog.profiles[0]!
      act(() => requireController(controller).startEdit(profile))
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, apiKey: 'first-key' }))
      const stableUpdatedAt = requireController(controller).draft!.updatedAt
      act(() => { first = requireController(controller).testProfile() })
      const firstInput = api.tests[0]
      expect(firstInput?.kind).toBe('draft')
      if (firstInput?.kind !== 'draft') throw new Error('首个测试输入错误')
      expect(firstInput.profile.updatedAt).toBe(stableUpdatedAt)

      await act(async () => { await requireController(controller).testProfile() })
      expect(api.tests).toHaveLength(1)
      expect(requireController(controller).testStates[profile.id]?.message).toContain('取消上一次测试失败')
      expect(requireController(controller).testStates[profile.id]?.message).not.toContain('private')

      await act(async () => {
        third = requireController(controller).testProfile()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(api.tests).toHaveLength(2)
      const retryInput = api.tests[1]
      if (retryInput?.kind !== 'draft') throw new Error('重试测试输入错误')
      expect(retryInput.profile).toEqual(firstInput.profile)
      expect(cancelAttempts).toBe(2)
      api.resolveTest({ requestId: retryInput.requestId, state: 'success', message: 'success' })
      await act(async () => { await third })
      api.resolveTest({ requestId: firstInput.requestId, state: 'cancelled', message: 'late' })
      await act(async () => { await first })
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given active 测试后多次修改身份且取消失败 When 再测试 Then pending request 未清除前绝不启动新测试', async () => {
    const api = createApi()
    let cancelAttempts = 0
    api.cancelTest = async (requestId) => {
      api.cancellations.push(requestId)
      cancelAttempts += 1
      if (cancelAttempts < 3) throw new Error(`private cancel ${cancelAttempts}`)
    }
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    let first: Promise<void> = Promise.resolve()
    let retry: Promise<void> = Promise.resolve()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      const profile = requireController(controller).settings!.catalog.profiles[0]!
      act(() => requireController(controller).startEdit(profile))
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, apiKey: 'draft-key' }))
      act(() => { first = requireController(controller).testProfile() })
      const firstRequestId = api.tests[0]!.requestId
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, baseUrl: 'https://changed.example.com' }))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, models: [{ id: 'changed-model', voices: [] }] }))
      await act(async () => { await requireController(controller).testProfile() })
      expect(api.tests).toHaveLength(1)
      expect(api.cancellations.every((requestId) => requestId === firstRequestId)).toBeTrue()
      expect(requireController(controller).testStates[profile.id]?.message).toContain('取消上一次测试失败')

      await act(async () => {
        retry = requireController(controller).testProfile()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(cancelAttempts).toBe(3)
      expect(api.tests).toHaveLength(2)
      const retryInput = api.tests[1]!
      api.resolveTest({ requestId: retryInput.requestId, state: 'success', message: 'success' })
      await act(async () => { await retry })
      api.resolveTest({ requestId: firstRequestId, state: 'cancelled', message: 'late' })
      await act(async () => { await first })
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 同 ID 关闭重开形成 ABA When 新旧取消依次完成 Then 旧 continuation 不得启动或覆盖新测试', async () => {
    const api = createApi()
    api.deferCancellation()
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    let a1: Promise<void> = Promise.resolve()
    let a2: Promise<void> = Promise.resolve()
    let b1: Promise<void> = Promise.resolve()
    let b2: Promise<void> = Promise.resolve()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      const profile = requireController(controller).settings!.catalog.profiles[0]!
      act(() => requireController(controller).startEdit(profile))
      act(() => { a1 = requireController(controller).testProfile() })
      const a1RequestId = api.tests[0]!.requestId
      act(() => { a2 = requireController(controller).testProfile() })
      act(() => requireController(controller).closeDraft())
      act(() => requireController(controller).startEdit(profile))
      act(() => { b1 = requireController(controller).testProfile() })
      await act(async () => { api.resolveCancellation(a1RequestId); await Promise.resolve(); await Promise.resolve() })
      expect(api.tests).toHaveLength(2)
      const b1RequestId = api.tests[1]!.requestId
      act(() => { b2 = requireController(controller).testProfile() })
      await act(async () => { api.resolveCancellation(b1RequestId); await Promise.resolve(); await Promise.resolve() })
      expect(api.tests).toHaveLength(3)
      const b2RequestId = api.tests[2]!.requestId
      api.resolveTest({ requestId: a1RequestId, state: 'success', message: 'late-a1' })
      api.resolveTest({ requestId: b1RequestId, state: 'success', message: 'late-b1' })
      api.resolveTest({ requestId: b2RequestId, state: 'success', message: 'b2' })
      await act(async () => { await Promise.all([a1, a2, b1, b2]) })
      expect(requireController(controller).testStates[profile.id]).toMatchObject({ requestId: b2RequestId, state: 'success' })
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 已完成草稿测试 When API Key 改变 Then 清除旧结论并使用新的凭据代次', async () => {
    const api = createApi()
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      const profile = requireController(controller).settings!.catalog.profiles[0]!
      act(() => requireController(controller).startEdit(profile))
      let first: Promise<void> = Promise.resolve()
      act(() => { first = requireController(controller).testProfile() })
      const firstRequestId = api.tests[0]!.requestId
      api.resolveTest({ requestId: firstRequestId, state: 'success', message: 'success' })
      await act(async () => { await first })
      const firstGeneration = requireController(controller).testStates[profile.id]!.credentialGeneration
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, apiKey: 'rotated-secret' }))
      expect(requireController(controller).testStates[profile.id]).toBeUndefined()
      let second: Promise<void> = Promise.resolve()
      act(() => { second = requireController(controller).testProfile() })
      const secondRequestId = api.tests[1]!.requestId
      api.resolveTest({ requestId: secondRequestId, state: 'success', message: 'success' })
      await act(async () => { await second })
      expect(requireController(controller).testStates[profile.id]!.credentialGeneration).toBeGreaterThan(firstGeneration)
      expect(JSON.stringify(requireController(controller).testStates[profile.id])).not.toContain('rotated-secret')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 测试绑定旧 catalog revision When GET 返回新 revision Then 取消旧请求并丢弃迟到结果', async () => {
    const api = createApi()
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    let pending: Promise<void> = Promise.resolve()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      const profile = requireController(controller).settings!.catalog.profiles[0]!
      act(() => { pending = requireController(controller).testProfile(profile) })
      const requestId = api.tests[0]!.requestId
      api.setSettings(createSettings(5))
      await act(async () => { await requireController(controller).load() })
      expect(api.cancellations).toContain(requestId)
      expect(requireController(controller).testStates[profile.id]).toBeUndefined()
      api.resolveTest({ requestId, state: 'success', message: 'late-success' })
      await act(async () => { await pending })
      expect(requireController(controller).testStates[profile.id]).toBeUndefined()
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 在途测试 When 写入结果未知且权威 GET 失败 Then reload gate 立即取消并永久丢弃迟到成功', async () => {
    const api = createApi()
    const originalGet = api.getSettings
    let failGet = false
    api.getSettings = async () => {
      if (failGet) throw new Error('private reload failure')
      return await originalGet()
    }
    api.replaceCatalog = async (request) => {
      api.replacements.push(request)
      throw new Error('AUDIO_GENERATION_CONFIG_OUTCOME_UNKNOWN')
    }
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    let pending: Promise<void> = Promise.resolve()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      const profile = requireController(controller).settings!.catalog.profiles[0]!
      act(() => { pending = requireController(controller).testProfile(profile) })
      const requestId = api.tests[0]!.requestId
      failGet = true
      await act(async () => { await requireController(controller).toggleEnabled(profile, false) })
      expect((requireController(controller) as AudioGenerationController & { needsReload: boolean }).needsReload).toBeTrue()
      expect(api.cancellations).toContain(requestId)
      expect(requireController(controller).testStates[profile.id]).toBeUndefined()
      api.resolveTest({ requestId, state: 'success', message: 'late-success' })
      await act(async () => { await pending })
      expect(requireController(controller).testStates[profile.id]).toBeUndefined()
      await act(async () => { await requireController(controller).testProfile(profile) })
      expect(api.tests).toHaveLength(1)

      api.setSettings(createSettings(8))
      failGet = false
      await act(async () => { await requireController(controller).load() })
      let next: Promise<void> = Promise.resolve()
      act(() => { next = requireController(controller).testProfile(requireController(controller).settings!.catalog.profiles[0]!) })
      expect(api.tests).toHaveLength(2)
      api.resolveTest({ requestId: api.tests[1]!.requestId, state: 'success', message: 'new-success' })
      await act(async () => { await next })
      expect(requireController(controller).testStates[profile.id]?.state).toBe('success')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given MediaSettings 选择音频分支 When 创建生产元素 Then 真实挂载独立音频配置页并透传插槽', () => {
    const expectedModule = mediaSettingsModule as unknown as {
      createMediaSettingsAudioGenerationElement: (props: { navigation: React.ReactNode; headerContent: React.ReactNode; children: React.ReactNode }) => React.ReactElement
    }
    const element = expectedModule.createMediaSettingsAudioGenerationElement({ navigation: 'nav', headerContent: 'header', children: 'notice' })
    expect(element.type).toBe(AudioGenerationSettings)
    expect(element.props).toMatchObject({ navigation: 'nav', headerContent: 'header', children: 'notice' })
  })

  test('Given 多个从未测试的新草稿 When 反复创建并返回 Then generation Map 不保留无效 identity', async () => {
    const api = createApi()
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      for (let index = 0; index < 20; index += 1) {
        act(() => requireController(controller).startCreate())
        act(() => requireController(controller).closeDraft())
      }
      const observable = requireController(controller) as AudioGenerationController & { generationEntryCount: number }
      expect(observable.generationEntryCount).toBe(0)
      expect((observable as typeof observable & { pendingCancellationCount: number }).pendingCancellationCount).toBe(0)
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 同一配置连续测试 When 第二次启动、身份修改和卸载 Then 取消旧请求且迟到结果不覆盖新状态', async () => {
    const api = createApi()
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      await act(async () => { await requireController(controller).load() })
      const profile = requireController(controller).settings!.catalog.profiles[0]!
      act(() => requireController(controller).startEdit(profile))
      /** Promise 在测试替身返回前保持 pending，用 act 捕获启动阶段更新。 */
      let first: Promise<void> = Promise.resolve()
      act(() => { first = requireController(controller).testProfile() })
      const firstId = api.tests[0]!.requestId
      let second: Promise<void> = Promise.resolve()
      await act(async () => {
        second = requireController(controller).testProfile()
        while (api.tests.length < 2) await Promise.resolve()
      })
      expect(api.cancellations).toContain(firstId)
      const secondId = api.tests[1]!.requestId
      api.resolveTest({ requestId: firstId, state: 'failed', message: '旧失败' })
      await act(async () => { await first })
      expect(requireController(controller).testStates[profile.id]?.requestId).toBe(secondId)
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, models: [{ id: 'mimo-v1', voices: [{ id: 'changed', name: 'changed', source: 'manual' }] }] }))
      expect(api.cancellations).toContain(secondId)
      api.resolveTest({ requestId: secondId, state: 'success', message: '旧成功' })
      await act(async () => { await second })
      act(() => host.unmount())
    } finally { host.restore() }
  })

  test('Given 测试仍在执行 When 页面卸载 Then 取消当前窗口全部请求且迟到响应无状态写入', async () => {
    const api = createApi()
    let controller: AudioGenerationController | null = null
    const host = createControllerRoot()
    let pending: Promise<void> = Promise.resolve()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      const profile = requireController(controller).settings!.catalog.profiles[0]!
      act(() => { pending = requireController(controller).testProfile(profile) })
      const requestId = api.tests.at(-1)!.requestId
      act(() => host.unmount())
      expect(api.cancellations).toContain(requestId)
      api.resolveTest({ requestId, state: 'success', message: 'late private result' })
      await pending
    } finally { host.restore() }
  })
})
