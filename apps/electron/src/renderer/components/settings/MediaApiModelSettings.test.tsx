import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ImageGenerationChannelOption, MediaApiModelCatalogEntry } from '@proma/shared'
import {
  changeMediaApiModelKind,
  changeMediaApiModelProtocol,
  createMediaApiModelProfile,
  filterMediaApiModelEntries,
  formatMediaApiModelMessage,
  getMediaApiModelCopy,
  MediaApiModelCatalogView,
  mergeFixedMediaApiModelProfiles,
  setMediaApiModelEnabled,
  validateMediaApiModelDraft,
  useMediaApiModelCatalogController,
  type MediaApiModelCatalogController,
  type MediaApiModelCatalogControllerOptions,
} from './MediaApiModelSettings'

/** 测试使用的现有渠道公开选项，不包含秘密。 */
const channels: ImageGenerationChannelOption[] = [{
  channelId: 'channel-1',
  name: '统一 API',
  available: true,
  models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
}]

interface MinimalEventTarget {
  addEventListener: () => void
  removeEventListener: () => void
}

/** 创建仅执行 catalog controller Hook 的最小 React 宿主。 */
function createControllerRoot(): {
  render: (node: React.ReactElement) => void
  unmount: () => void
  restore: () => void
} {
  const eventTarget: MinimalEventTarget = { addEventListener: () => undefined, removeEventListener: () => undefined }
  class FakeHtmlIFrameElement {}
  const fakeWindow = { ...eventTarget, event: undefined, HTMLIFrameElement: FakeHtmlIFrameElement }
  const fakeDocument = {
    ...eventTarget, nodeType: 9, defaultView: fakeWindow, activeElement: null, body: null,
    documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' },
  }
  const container = {
    ...eventTarget, nodeType: 1, tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: fakeDocument,
  }
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(container as unknown as Element)
  return {
    render: (node) => { root.render(node) },
    unmount: () => { root.unmount() },
    restore: () => {
      globals.window = previousWindow
      globals.document = previousDocument
      globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    },
  }
}

/** 暴露生产目录 controller，测试可触发与组件相同的保存处理器。 */
function CatalogControllerProbe({
  onController,
  ...options
}: MediaApiModelCatalogControllerOptions & {
  onController: (controller: MediaApiModelCatalogController) => void
}): null {
  const controller = useMediaApiModelCatalogController(options)
  React.useEffect(() => onController(controller), [controller, onController])
  return null
}

/** 确保 React effect 已发布 controller，并帮助 TypeScript 跨闭包读取最新实例。 */
function requireCatalogController(controller: MediaApiModelCatalogController | null): MediaApiModelCatalogController {
  if (!controller) throw new Error('测试 controller 尚未初始化')
  return controller
}

/** 创建 fixed catalog 测试使用的三类目录。 */
function createMixedEntries(audioName = '旧语音'): MediaApiModelCatalogEntry[] {
  return [
    { profile: { ...changeMediaApiModelKind(createMediaApiModelProfile('audio-1', 2), 'audio'), name: audioName, channelId: 'channel-1', modelId: 'speech-2.6', extension: { source: audioName } } as MediaApiModelCatalogEntry['profile'], support: { state: 'configuration-only', reason: '待迁移' } },
    { profile: { ...createMediaApiModelProfile('image-1', 1), name: '图片模型', channelId: 'channel-1', modelId: 'gpt-image-2' }, support: { state: 'supported', adapterId: 'openai-images' } },
    { profile: { ...changeMediaApiModelKind(createMediaApiModelProfile('video-1', 3), 'video'), name: '旧视频', channelId: 'channel-1', modelId: 'video-01', extension: { source: 'video' } } as MediaApiModelCatalogEntry['profile'], support: { state: 'configuration-only', reason: '待迁移' } },
  ]
}

/** 断言保存结果完整保留传入 hidden 条目的身份、扩展字段和相对顺序。 */
function expectHiddenProfilesPreserved(
  profiles: readonly MediaApiModelCatalogEntry['profile'][],
  entries: readonly MediaApiModelCatalogEntry[],
): void {
  const hidden = entries.filter((entry) => entry.profile.mediaKind !== 'image').map((entry) => entry.profile)
  const savedHidden = profiles.filter((profile) => profile.mediaKind !== 'image')
  expect(savedHidden).toEqual(hidden)
  expect(savedHidden[0]).toBe(hidden[0])
  expect(savedHidden[1]).toBe(hidden[1])
}

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

  test('Given 固定生图视图含旧音频和视频 When 渲染 Then 只显示图片且隐藏类型控件', () => {
    /** 隐藏条目仍交给保存合并逻辑，不进入生图列表。 */
    const entries: MediaApiModelCatalogEntry[] = [
      { profile: { ...createMediaApiModelProfile('image-1', 1), name: '图片模型', channelId: 'channel-1', modelId: 'gpt-image-2' }, support: { state: 'supported', adapterId: 'openai-images' } },
      { profile: { ...changeMediaApiModelKind(createMediaApiModelProfile('audio-1', 2), 'audio'), name: '旧语音', channelId: 'channel-1', modelId: 'speech-2.6' }, support: { state: 'configuration-only', reason: '待迁移' } },
      { profile: { ...changeMediaApiModelKind(createMediaApiModelProfile('video-1', 3), 'video'), name: '旧视频', channelId: 'channel-1', modelId: 'video-01' }, support: { state: 'configuration-only', reason: '待迁移' } },
    ]
    const html = renderToStaticMarkup(<MediaApiModelCatalogView fixedMediaKind="image" entries={entries} channelOptions={channels} saving={false} onSaveProfiles={async () => true} />)
    expect(html).toContain('图片模型')
    expect(html).not.toContain('旧语音')
    expect(html).not.toContain('旧视频')
    expect(html).not.toContain('aria-label="筛选媒体类型"')
    expect(html).not.toContain('媒体类型')
    expect(html).toContain('生图模型')
    expect(html).toContain('添加生图模型')
    expect(createMediaApiModelProfile('new-image', 4, 'image').mediaKind).toBe('image')
  })

  test('Given fixed 与 nonfixed 状态 When 展示空结果、删除确认或兜底错误 Then 使用各自准确文案', () => {
    expect(getMediaApiModelCopy('image')).toMatchObject({
      empty: '尚未配置生图模型', noMatches: '没有匹配的生图模型', deleteTitle: '删除生图模型？',
      loadError: '生图模型读取失败', saveError: '生图模型保存失败',
    })
    expect(getMediaApiModelCopy(undefined)).toMatchObject({
      empty: '尚未配置 API 媒体模型', noMatches: '没有匹配的媒体模型', deleteTitle: '删除 API 媒体模型？',
      loadError: '媒体模型读取失败', saveError: '媒体模型保存失败',
    })
    const fixedLoading = renderToStaticMarkup(<MediaApiModelCatalogView fixedMediaKind="image" entries={[]} channelOptions={channels} loading saving={false} onSaveProfiles={() => true} />)
    const genericLoading = renderToStaticMarkup(<MediaApiModelCatalogView entries={[]} channelOptions={channels} loading saving={false} onSaveProfiles={() => true} />)
    expect(fixedLoading).toContain('正在读取生图模型')
    expect(fixedLoading).not.toContain('媒体模型')
    expect(genericLoading).toContain('正在读取媒体模型')
    expect(formatMediaApiModelMessage('媒体 API 模型读取失败', 'image')).toBe('生图模型读取失败')
    expect(formatMediaApiModelMessage('媒体 API 模型读取失败', undefined)).toBe('媒体 API 模型读取失败')
  })

  test('Given fixed catalog When 实际触发新增编辑复制删除和启停 Then 每次保存都原样保留 hidden 条目', async () => {
    let entries = createMixedEntries()
    /** 记录生产 controller 交给 IPC 边界的完整目录。 */
    const saves: Array<MediaApiModelCatalogEntry['profile'][]> = []
    let controller: MediaApiModelCatalogController | null = null
    const host = createControllerRoot()
    const onController = (nextController: MediaApiModelCatalogController): void => { controller = nextController }
    const onSaveProfiles = async (profiles: MediaApiModelCatalogEntry['profile'][]): Promise<boolean> => {
      saves.push(profiles)
      return true
    }
    const renderController = (): void => {
      host.render(<CatalogControllerProbe entries={entries} channelOptions={channels} fixedMediaKind="image" saving={false} onSaveProfiles={onSaveProfiles} onController={onController} />)
    }

    try {
      act(renderController)
      act(() => { controller?.startCreate() })
      act(() => { controller?.updateDraft({ ...controller.draft!, name: '新增图片', channelId: 'channel-1', modelId: 'gpt-image-2' }) })
      await act(async () => { await controller?.saveDraft() })
      expectHiddenProfilesPreserved(saves.at(-1)!, entries)
      expect(saves.at(-1)?.filter((profile) => profile.mediaKind === 'image').some((profile) => profile.name === '新增图片')).toBeTrue()

      act(() => { controller?.startEdit(entries[1]!.profile) })
      act(() => { controller?.updateDraft({ ...controller.draft!, name: '编辑图片' }) })
      await act(async () => { await controller?.saveDraft() })
      expectHiddenProfilesPreserved(saves.at(-1)!, entries)
      expect(saves.at(-1)?.find((profile) => profile.id === 'image-1')?.name).toBe('编辑图片')

      act(() => { controller?.startCopy(entries[1]!.profile) })
      await act(async () => { await controller?.saveDraft() })
      expectHiddenProfilesPreserved(saves.at(-1)!, entries)
      expect(saves.at(-1)?.filter((profile) => profile.mediaKind === 'image')).toHaveLength(2)

      await act(async () => { await controller?.toggleEnabled(entries[1]!.profile, false) })
      expectHiddenProfilesPreserved(saves.at(-1)!, entries)
      expect(saves.at(-1)?.find((profile) => profile.id === 'image-1')?.enabled).toBeFalse()

      act(() => { controller?.requestDelete('image-1') })
      await act(async () => { await controller?.confirmDelete() })
      expectHiddenProfilesPreserved(saves.at(-1)!, entries)
      expect(saves.at(-1)?.some((profile) => profile.id === 'image-1')).toBeFalse()
      expect(requireCatalogController(controller).deleteId).toBeNull()
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given fixed 草稿已打开 When entries 外部刷新后保存 Then 使用最新 hidden catalog', async () => {
    let entries = createMixedEntries('旧语音')
    /** 保存记录用于确认不会回写旧 hidden 快照。 */
    const saves: Array<MediaApiModelCatalogEntry['profile'][]> = []
    let controller: MediaApiModelCatalogController | null = null
    const host = createControllerRoot()
    const onController = (nextController: MediaApiModelCatalogController): void => { controller = nextController }
    const renderController = (): void => {
      host.render(<CatalogControllerProbe entries={entries} channelOptions={channels} fixedMediaKind="image" saving={false} onSaveProfiles={(profiles) => { saves.push(profiles); return true }} onController={onController} />)
    }

    try {
      act(renderController)
      act(() => { controller?.startEdit(entries[1]!.profile) })
      entries = createMixedEntries('刷新后语音')
      act(renderController)
      act(() => { controller?.updateDraft({ ...controller.draft!, name: '刷新后保存图片' }) })
      await act(async () => { await controller?.saveDraft() })
      expectHiddenProfilesPreserved(saves[0]!, entries)
      expect(saves[0]?.[0]?.name).toBe('刷新后语音')
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 编辑目标被其他窗口修改或删除 When 保存草稿 Then 阻止覆盖或复活并提示重新打开', async () => {
    let entries = createMixedEntries()
    /** 冲突路径不得到达保存边界。 */
    const saves: Array<MediaApiModelCatalogEntry['profile'][]> = []
    let controller: MediaApiModelCatalogController | null = null
    const host = createControllerRoot()
    const onController = (nextController: MediaApiModelCatalogController): void => { controller = nextController }
    const renderController = (): void => {
      host.render(<CatalogControllerProbe entries={entries} channelOptions={channels} fixedMediaKind="image" saving={false} onSaveProfiles={(profiles) => { saves.push(profiles); return true }} onController={onController} />)
    }

    try {
      act(renderController)
      act(() => { controller?.startEdit(entries[1]!.profile) })
      act(() => { controller?.updateDraft({ ...controller.draft!, name: '本地编辑' }) })
      entries = createMixedEntries()
      entries[1] = { ...entries[1]!, profile: { ...entries[1]!.profile, name: '其他窗口修改' } }
      act(renderController)
      await act(async () => { await controller?.saveDraft() })
      expect(saves).toHaveLength(0)
      expect(requireCatalogController(controller).actionError).toContain('已被其他窗口修改')
      expect(requireCatalogController(controller).actionError).toContain('重新打开')

      entries = entries.filter((entry) => entry.profile.id !== 'image-1')
      act(renderController)
      await act(async () => { await controller?.saveDraft() })
      expect(saves).toHaveLength(0)
      expect(requireCatalogController(controller).actionError).toContain('已被其他窗口删除')
      expect(requireCatalogController(controller).draft?.id).toBe('image-1')
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 删除确认打开后目标被修改或删除 When 确认 Then 阻止删除并保留确认目标', async () => {
    let entries = createMixedEntries()
    /** 冲突路径不得调用完整目录保存。 */
    const saves: Array<MediaApiModelCatalogEntry['profile'][]> = []
    let controller: MediaApiModelCatalogController | null = null
    const host = createControllerRoot()
    const onController = (nextController: MediaApiModelCatalogController): void => { controller = nextController }
    const renderController = (): void => {
      host.render(<CatalogControllerProbe entries={entries} channelOptions={channels} fixedMediaKind="image" saving={false} onSaveProfiles={(profiles) => { saves.push(profiles); return true }} onController={onController} />)
    }

    try {
      act(renderController)
      act(() => { controller?.requestDelete('image-1') })
      entries = createMixedEntries()
      entries[1] = { ...entries[1]!, profile: { ...entries[1]!.profile, modelId: 'other-window-model' } }
      act(renderController)
      await act(async () => { await controller?.confirmDelete() })
      expect(saves).toHaveLength(0)
      expect(requireCatalogController(controller).actionError).toContain('已被其他窗口修改')
      expect(requireCatalogController(controller).deleteId).toBe('image-1')

      act(() => { controller?.closeDelete() })
      act(() => { controller?.requestDelete('image-1') })
      entries = entries.filter((entry) => entry.profile.id !== 'image-1')
      act(renderController)
      await act(async () => { await controller?.confirmDelete() })
      expect(saves).toHaveLength(0)
      expect(requireCatalogController(controller).actionError).toContain('已被其他窗口删除')
      expect(requireCatalogController(controller).deleteId).toBe('image-1')
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 删除保存失败 When 确认 Then 保留删除目标等待重试', async () => {
    const entries = createMixedEntries()
    let controller: MediaApiModelCatalogController | null = null
    const host = createControllerRoot()
    const onController = (nextController: MediaApiModelCatalogController): void => { controller = nextController }
    try {
      act(() => {
        host.render(<CatalogControllerProbe entries={entries} channelOptions={channels} fixedMediaKind="image" saving={false} onSaveProfiles={() => false} onController={onController} />)
      })
      act(() => { controller?.requestDelete('image-1') })
      await act(async () => { await controller?.confirmDelete() })
      expect(requireCatalogController(controller).deleteId).toBe('image-1')
      expect(requireCatalogController(controller).actionError).toContain('删除未完成')
      expect(requireCatalogController(controller).actionError).toContain('重试')
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 新增或复制草稿 ID 被外部占用 When 保存 Then 阻止重复稳定 ID', async () => {
    let entries = createMixedEntries()
    /** 重复 ID 不得到达保存边界。 */
    const saves: Array<MediaApiModelCatalogEntry['profile'][]> = []
    let controller: MediaApiModelCatalogController | null = null
    const host = createControllerRoot()
    const onController = (nextController: MediaApiModelCatalogController): void => { controller = nextController }
    const renderController = (): void => {
      host.render(<CatalogControllerProbe entries={entries} channelOptions={channels} fixedMediaKind="image" saving={false} onSaveProfiles={(profiles) => { saves.push(profiles); return true }} onController={onController} />)
    }
    /** 将当前新草稿 ID 注入外部刷新目录，模拟另一窗口抢先占用。 */
    const occupyDraftId = (): void => {
      const draft = controller?.draft
      if (!draft) throw new Error('测试草稿缺失')
      entries = [...entries, { profile: { ...draft, name: '其他窗口新增', channelId: 'channel-1', modelId: 'gpt-image-2' }, support: { state: 'supported', adapterId: 'openai-images' } }]
      act(renderController)
    }

    try {
      act(renderController)
      act(() => { controller?.startCreate() })
      act(() => { controller?.updateDraft({ ...controller.draft!, name: '本地新增', channelId: 'channel-1', modelId: 'gpt-image-2' }) })
      occupyDraftId()
      await act(async () => { await controller?.saveDraft() })
      expect(saves).toHaveLength(0)
      expect(requireCatalogController(controller).actionError).toContain('ID 已被其他窗口占用')

      act(() => { controller?.closeDraft() })
      act(() => { controller?.startCopy(entries[1]!.profile) })
      occupyDraftId()
      await act(async () => { await controller?.saveDraft() })
      expect(saves).toHaveLength(0)
      expect(requireCatalogController(controller).actionError).toContain('ID 已被其他窗口占用')
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given fixed image 编辑新增删除或启停 When 合并保存 Then hidden 音视频保持原对象和顺序', () => {
    /** 模拟外部刷新后的完整目录，合并必须以本次传入值为权威基线。 */
    const hiddenAudio = { ...changeMediaApiModelKind(createMediaApiModelProfile('audio-1', 2), 'audio'), name: '外部更新语音', channelId: 'channel-1', modelId: 'speech-2.6' }
    const hiddenVideo = { ...changeMediaApiModelKind(createMediaApiModelProfile('video-1', 3), 'video'), name: '旧视频', channelId: 'channel-1', modelId: 'video-01' }
    const image = { ...createMediaApiModelProfile('image-1', 1), name: '图片', channelId: 'channel-1', modelId: 'gpt-image-2' }
    const fullCatalog = [hiddenAudio, image, hiddenVideo]

    const updatedImage = { ...image, name: '更新图片', enabled: false }
    const addedImage = { ...createMediaApiModelProfile('image-2', 4), name: '新增图片', channelId: 'channel-1', modelId: 'gpt-image-2' }
    const saved = mergeFixedMediaApiModelProfiles(fullCatalog, 'image', [updatedImage, addedImage])
    expect(saved.map((profile) => profile.id)).toEqual(['audio-1', 'image-1', 'video-1', 'image-2'])
    expect(saved[0]).toBe(hiddenAudio)
    expect(saved[2]).toBe(hiddenVideo)
    expect(saved[1]).toEqual(updatedImage)

    const deleted = mergeFixedMediaApiModelProfiles(fullCatalog, 'image', [])
    expect(deleted).toEqual([hiddenAudio, hiddenVideo])
    expect(deleted[0]).toBe(hiddenAudio)
    expect(deleted[1]).toBe(hiddenVideo)
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
