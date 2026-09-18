import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  ImageGenerationCatalogFetchInput,
  ImageGenerationCatalogFetchResult,
  ImageGenerationSettingsResult,
  ReplaceImageGenerationCatalogRequest,
} from '@proma/shared'
import { DREAMINA_LOGIN_MESSAGES, parseReplaceImageGenerationCatalogRequest } from '@proma/shared'
import {
  useImageGenerationController,
  type ImageGenerationController,
  type ImageGenerationSettingsApi,
} from './ImageGenerationSettings.controller'
import { changeImageGenerationProvider } from './ImageGenerationSettings.logic'

/** 构造权威设置快照：一家 ChatGPT 配置。 */
function createSettings(revision = 4): ImageGenerationSettingsResult {
  return {
    catalog: {
      schemaVersion: 1,
      revision,
      profiles: [{
        id: 'image-1',
        name: 'ChatGPT 生图',
        provider: 'openai-images',
        baseUrl: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-image-1', capabilities: ['text-to-image'] }],
        enabled: true,
        createdAt: 1,
        updatedAt: 2,
        credentialConfigured: true,
        endpointOrigin: 'https://api.openai.com',
      }],
    },
    legacyImageProfiles: [],
  }
}

/** 构造可注入的假 API，记录替换请求与拉取输入。 */
function createApi(initial = createSettings()): ImageGenerationSettingsApi & {
  replacements: ReplaceImageGenerationCatalogRequest[]
  fetches: ImageGenerationCatalogFetchInput[]
  setFetchResult: (result: ImageGenerationCatalogFetchResult) => void
} {
  let settings = initial
  const replacements: ReplaceImageGenerationCatalogRequest[] = []
  const fetches: ImageGenerationCatalogFetchInput[] = []
  let fetchResult: ImageGenerationCatalogFetchResult = {
    requestId: 'fetch-1',
    state: 'success',
    message: '已从供应商获取可用生图模型',
    models: [{ id: 'gpt-image-2', capabilities: ['text-to-image'] }],
  }
  return {
    replacements,
    fetches,
    setFetchResult: (result) => { fetchResult = result },
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
            credentialConfigured: profile.provider === 'dreamina' ? true : true,
            ...(profile.provider === 'dreamina' ? {} : { endpointOrigin: new URL(profile.baseUrl).origin }),
          })),
        },
      }
      return settings
    },
    fetchCatalog: async (input) => {
      fetches.push(input)
      return { ...fetchResult, requestId: input.requestId }
    },
    /** 默认返回已保存的明文凭据，用于断言编辑回填。 */
    revealCredential: async () => 'sk-saved-plaintext',
    /** 默认未登录，即梦相关断言按需覆盖。 */
    dreaminaStatus: async () => ({ state: 'loggedOut', credit: null, message: DREAMINA_LOGIN_MESSAGES.statusLoggedOut }),
    dreaminaLoginStart: async () => ({ state: 'failed', message: DREAMINA_LOGIN_MESSAGES.cliMissing }),
    dreaminaLoginPoll: async (input) => ({
      requestId: input.requestId,
      state: 'failed',
      message: DREAMINA_LOGIN_MESSAGES.requestUnknown,
    }),
    dreaminaLoginCancel: async () => undefined,
    dreaminaLogout: async () => ({ state: 'failed', message: DREAMINA_LOGIN_MESSAGES.logoutFailed }),
  }
}

/** 用最小 DOM shim 承载 Controller，只观察其公开状态。 */
function createHost(): { render: (node: React.ReactElement) => void; unmount: () => void; restore: () => void } {
  const eventTarget = { addEventListener: () => undefined, removeEventListener: () => undefined }
  class FakeHtmlIFrameElement {}
  const fakeWindow = { ...eventTarget, event: undefined, HTMLIFrameElement: FakeHtmlIFrameElement }
  const fakeDocument = { ...eventTarget, nodeType: 9, defaultView: fakeWindow, activeElement: null, body: null, documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' } }
  const container = { ...eventTarget, nodeType: 1, tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: fakeDocument }
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(container as unknown as Element)
  return {
    render: (node) => root.render(node),
    unmount: () => root.unmount(),
    restore: () => { globals.window = previousWindow; globals.document = previousDocument; globals.IS_REACT_ACT_ENVIRONMENT = previousAct },
  }
}

/** 暴露生产 Controller 供测试触发真实 handler。 */
function ControllerProbe({ api, onController }: {
  api: ImageGenerationSettingsApi
  onController: (controller: ImageGenerationController) => void
}): null {
  const controller = useImageGenerationController(api)
  React.useEffect(() => onController(controller), [controller, onController])
  return null
}

/** 确保 effect 已发布 Controller。 */
function requireController(controller: ImageGenerationController | null): ImageGenerationController {
  if (!controller) throw new Error('测试 controller 尚未初始化')
  return controller
}

describe('独立生图设置控制器', () => {
  test('Given 权威目录 When 加载 Then 暴露可见配置且搜索生效', async () => {
    const api = createApi()
    let controller: ImageGenerationController | null = null
    const host = createHost()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      expect(requireController(controller).settings?.catalog.revision).toBe(4)
      expect(requireController(controller).visibleProfiles).toHaveLength(1)
      act(() => requireController(controller).setQuery('gpt-image-1'))
      expect(requireController(controller).visibleProfiles).toHaveLength(1)
      act(() => requireController(controller).setQuery('不存在'))
      expect(requireController(controller).visibleProfiles).toHaveLength(0)
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 编辑草稿 When 保存 Then 整目录 CAS 且其它条目保留凭据', async () => {
    const api = createApi()
    let controller: ImageGenerationController | null = null
    const host = createHost()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startEdit(requireController(controller).settings!.catalog.profiles[0]!))
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, name: '改名', apiKey: '' }))
      await act(async () => { await requireController(controller).saveDraft() })
      expect(api.replacements).toHaveLength(1)
      expect(api.replacements[0]!.expectedRevision).toBe(4)
      /** 未填新 Key 时必须 preserve，不能清空已保存密文。 */
      expect(api.replacements[0]!.profiles[0]!.credentialUpdate).toEqual({ mode: 'preserve' })
      /**
       * 提交载荷必须能通过主进程的严格合同。
       * 公开配置带 credentialConfigured / endpointOrigin，原样提交会被整体拒绝。
       */
      expect(() => parseReplaceImageGenerationCatalogRequest(api.replacements[0]!)).not.toThrow()
      expect(requireController(controller).draft).toBeNull()
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 写入冲突 When 保存 Then 重新读取权威目录并给出稳定提示', async () => {
    const api = createApi()
    api.replaceCatalog = async () => { throw new Error('IMAGE_GENERATION_CONFIG_CONFLICT') }
    let controller: ImageGenerationController | null = null
    const host = createHost()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startEdit(requireController(controller).settings!.catalog.profiles[0]!))
      await act(async () => { await requireController(controller).saveDraft() })
      expect(requireController(controller).actionError).toContain('其他窗口')
      expect(requireController(controller).settings?.catalog.revision).toBe(4)
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 新配置草稿 When 填写 Key 后保存 Then 使用 replace 凭据动作', async () => {
    const api = createApi()
    let controller: ImageGenerationController | null = null
    const host = createHost()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startCreate())
      /** 即梦草稿没有服务地址与密钥字段。 */
      expect(requireController(controller).draft?.provider).toBe('dreamina')
      act(() => requireController(controller).updateDraft({
        ...requireController(controller).draft!,
        name: '即梦主号',
      }))
      await act(async () => { await requireController(controller).saveDraft() })
      expect(api.replacements[0]!.profiles.at(-1)!.credentialUpdate).toEqual({ mode: 'preserve' })
      expect(api.replacements[0]!.profiles.at(-1)!.profile).toMatchObject({ provider: 'dreamina', name: '即梦主号' })
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 拉取结果 When 草稿身份变化 Then 迟到结果不展示', async () => {
    const api = createApi()
    const apiWithResult = api
    let controller: ImageGenerationController | null = null
    const host = createHost()
    try {
      await act(async () => { host.render(<ControllerProbe api={apiWithResult} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startEdit(requireController(controller).settings!.catalog.profiles[0]!))
      await act(async () => { await requireController(controller).fetchCatalog() })
      expect(requireController(controller).catalog?.models[0]?.id).toBe('gpt-image-2')
      expect(api.fetches.at(-1)?.credential).toEqual({ mode: 'saved', profileId: 'image-1' })
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 尚未添加模型的草稿 When 拉取 Then 发出请求且不报配置无效', async () => {
    /** 新建配置默认零模型，拉取身份不能走严格 Profile 合同（历史 bug：抛 IMAGE_GENERATION_CONFIG_INVALID）。 */
    const api = createApi()
    let controller: ImageGenerationController | null = null
    const host = createHost()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startCreate())
      /** 走生产切换函数，得到与真实界面一致的 MiniMax 草稿；用户清空模型后仍必须能拉取。 */
      const minimaxDraft = changeImageGenerationProvider(requireController(controller).draft!, 'minimax')
      act(() => requireController(controller).updateDraft({ ...minimaxDraft, models: [], apiKey: 'secret' }))
      await act(async () => { await requireController(controller).fetchCatalog() })
      expect(api.fetches).toHaveLength(1)
      expect(api.fetches[0]).toMatchObject({ provider: 'minimax', credential: { mode: 'draft', apiKey: 'secret' } })
      expect(requireController(controller).catalog).toMatchObject({ state: 'success', models: [{ id: 'gpt-image-2' }] })
      expect(requireController(controller).actionError).toBeNull()
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 已保存密钥型配置 When 编辑 Then 回填明文 Key 且不覆盖用户输入', async () => {
    const api = createApi()
    let controller: ImageGenerationController | null = null
    const host = createHost()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startEdit(requireController(controller).settings!.catalog.profiles[0]!))
      /** 解密是异步的，需要让微任务队列走完。 */
      await act(async () => { await Promise.resolve() })
      expect(requireController(controller).draft?.apiKey).toBe('sk-saved-plaintext')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 用户已开始输入 When 解密结果迟到 Then 不覆盖正在编辑的 Key', async () => {
    const api = createApi()
    let releaseKey!: (key: string) => void
    api.revealCredential = () => new Promise<string>((resolve) => { releaseKey = resolve })
    let controller: ImageGenerationController | null = null
    const host = createHost()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startEdit(requireController(controller).settings!.catalog.profiles[0]!))
      act(() => requireController(controller).updateDraft({ ...requireController(controller).draft!, apiKey: 'sk-user-typed' }))
      releaseKey('sk-saved-plaintext')
      await act(async () => { await Promise.resolve() })
      expect(requireController(controller).draft?.apiKey).toBe('sk-user-typed')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 未登录状态 When 发起即梦登录 Then 展示设备码并接受轮询结果', async () => {
    const api = createApi()
    api.dreaminaStatus = async () => ({ state: 'loggedOut', credit: null, message: DREAMINA_LOGIN_MESSAGES.statusLoggedOut })
    api.dreaminaLoginStart = async () => ({
      state: 'pending',
      requestId: 'dreamina-1',
      verificationUri: 'https://jimeng.jianying.com/login',
      userCode: 'ABCD-1234',
      expiresInSeconds: 600,
      message: DREAMINA_LOGIN_MESSAGES.pending,
    })
    let pollState: 'pending' | 'success' = 'pending'
    api.dreaminaLoginPoll = async (input) => ({
      requestId: input.requestId,
      state: pollState,
      message: pollState === 'success' ? DREAMINA_LOGIN_MESSAGES.success : DREAMINA_LOGIN_MESSAGES.pending,
    })
    let controller: ImageGenerationController | null = null
    const host = createHost()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startCreate())
      await act(async () => { await requireController(controller).refreshDreaminaStatus() })
      expect(requireController(controller).dreaminaStatus?.state).toBe('loggedOut')

      await act(async () => { await requireController(controller).startDreaminaLogin(false) })
      expect(requireController(controller).dreaminaLogin).toMatchObject({
        state: 'pending',
        requestId: 'dreamina-1',
        userCode: 'ABCD-1234',
      })
      /** 等待期间继续轮询仍保持待授权。 */
      await act(async () => { await requireController(controller).pollDreaminaLogin() })
      expect(requireController(controller).dreaminaLogin.state).toBe('pending')

      /** 授权完成后必须刷新账号状态，让面板显示已登录。 */
      pollState = 'success'
      api.dreaminaStatus = async () => ({ state: 'loggedIn', credit: 321, message: DREAMINA_LOGIN_MESSAGES.statusLoggedIn })
      await act(async () => { await requireController(controller).pollDreaminaLogin() })
      expect(requireController(controller).dreaminaLogin.state).toBe('success')
      expect(requireController(controller).dreaminaStatus).toMatchObject({ state: 'loggedIn', credit: 321 })
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 等待授权中 When 取消或关闭表单 Then 通知主进程丢弃设备码', async () => {
    const api = createApi()
    api.dreaminaLoginStart = async () => ({
      state: 'pending',
      requestId: 'dreamina-2',
      verificationUri: 'https://jimeng.jianying.com/login',
      userCode: 'WXYZ-9999',
      expiresInSeconds: null,
      message: DREAMINA_LOGIN_MESSAGES.pending,
    })
    const cancelled: string[] = []
    api.dreaminaLoginCancel = async (input) => { cancelled.push(input.requestId) }
    let controller: ImageGenerationController | null = null
    const host = createHost()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      act(() => requireController(controller).startCreate())
      await act(async () => { await requireController(controller).startDreaminaLogin(false) })
      await act(async () => { await requireController(controller).cancelDreaminaLogin() })
      expect(cancelled).toEqual(['dreamina-2'])
      expect(requireController(controller).dreaminaLogin).toMatchObject({
        state: 'failed',
        message: DREAMINA_LOGIN_MESSAGES.cancelled,
      })

      await act(async () => { await requireController(controller).startDreaminaLogin(false) })
      expect(requireController(controller).dreaminaLogin.state).toBe('pending')
      await act(async () => { requireController(controller).closeDraft() })
      expect(cancelled).toEqual(['dreamina-2', 'dreamina-2'])
      expect(requireController(controller).dreaminaLogin.state).toBe('idle')
    } finally { act(() => host.unmount()); host.restore() }
  })

  test('Given 目录已有配置 When 启停与删除 Then 提交载荷同样通过严格合同', async () => {
    /** 只要目录非空，未修改条目也会进入替换请求，必须还原为严格配置。 */
    const api = createApi()
    let controller: ImageGenerationController | null = null
    const host = createHost()
    try {
      await act(async () => { host.render(<ControllerProbe api={api} onController={(next) => { controller = next }} />) })
      await act(async () => {
        await requireController(controller).toggleEnabled(requireController(controller).settings!.catalog.profiles[0]!, false)
      })
      expect(api.replacements).toHaveLength(1)
      expect(() => parseReplaceImageGenerationCatalogRequest(api.replacements[0]!)).not.toThrow()
      expect(api.replacements[0]!.profiles[0]!.profile.enabled).toBe(false)

      act(() => requireController(controller).requestDelete('image-1'))
      await act(async () => { await requireController(controller).confirmDelete() })
      expect(api.replacements).toHaveLength(2)
      expect(() => parseReplaceImageGenerationCatalogRequest(api.replacements[1]!)).not.toThrow()
      expect(api.replacements[1]!.profiles).toHaveLength(0)
    } finally { act(() => host.unmount()); host.restore() }
  })
})
