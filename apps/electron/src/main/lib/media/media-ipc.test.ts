import { describe, expect, test } from 'bun:test'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { AUDIO_GENERATION_CATALOG_MESSAGES, AUDIO_GENERATION_LEGACY_WARNING, AUDIO_GENERATION_TEST_MESSAGES, MEDIA_IPC_CHANNELS } from '@proma/shared'
import type { AudioGenerationCatalogFetchInput, AudioGenerationPublicCatalog, AudioGenerationSettingsResult, AudioGenerationTestInput, AudioGenerationTestResult, MediaApiModelCatalogEntry, ReplaceAudioGenerationCatalogRequest } from '@proma/shared'
import { createAudioGenerationIpcService, registerMediaIpcHandlers as registerProductionMediaIpcHandlers } from './media-ipc'
import type { AudioGenerationIpcService, MediaIpcOptions } from './media-ipc'
import { EventEmitter } from 'node:events'
import type { MediaRunEvent } from '@proma/shared'

/** 测试使用的完整图片引用，字段与 Renderer 公开合同一致。 */
const imageAsset = {
  assetId: 'asset-1',
  revision: 1,
  hash: 'a'.repeat(64),
  mediaKind: 'image' as const,
}

/** 构造可由 Shared 严格 parser 接受的小米音频配置。 */
function createAudioProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audio-1', name: '小米语音', provider: 'xiaomi' as const,
    baseUrl: 'https://example.com/tts', modelId: 'tts-model', voices: [{ id: 'voice-1', name: 'voice-1', source: 'manual' as const }],
    enabled: true, createdAt: 1, updatedAt: 1, ...overrides,
  }
}

/** 构造不含凭据的独立目录公开快照。 */
function createAudioCatalog(profiles: AudioGenerationPublicCatalog['profiles'] = []): AudioGenerationPublicCatalog {
  return { schemaVersion: 2, revision: 0, profiles }
}

/** 既有媒体 IPC 用例无需关心音频调用，统一注入无副作用服务以保留生产必填依赖。 */
const unusedAudioCatalogFetch = async (): Promise<never> => { throw new Error('unused') }

/** 既有媒体 IPC 用例无需关心音频调用，统一注入无副作用服务以保留生产必填依赖。 */
const unusedAudioGenerationService: AudioGenerationIpcService = {
  listSettings: () => ({ catalog: createAudioCatalog(), legacyAudioProfiles: [] }),
  replace: () => ({ catalog: createAudioCatalog(), legacyAudioProfiles: [] }),
  fetchCatalog: unusedAudioCatalogFetch,
  test: async (_ownerId, input) => ({ requestId: input.requestId, state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success }),
  cancel: () => undefined,
  releaseOwner: () => undefined,
}

/** 测试适配器为既有用例补齐音频依赖，生产注册函数仍保持必填约束。 */
function registerMediaIpcHandlers(options: Omit<MediaIpcOptions, 'audioGeneration'> & { audioGeneration?: AudioGenerationIpcService }): ReturnType<typeof registerProductionMediaIpcHandlers> {
  return registerProductionMediaIpcHandlers({ ...options, audioGeneration: options.audioGeneration ?? unusedAudioGenerationService })
}

/** 为音频 IPC 测试补齐既有媒体服务依赖，保持断言聚焦新增合同。 */
function createMediaOptions(
  handlers: Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>,
  audioGeneration: AudioGenerationIpcService,
  isAuthorizedSender: MediaIpcOptions['isAuthorizedSender'] = () => true,
): MediaIpcOptions {
  return {
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
    isAuthorizedSender,
    assertProject: () => undefined,
    configuration: {
      read: () => ({ schemaVersion: 1, revision: 0, connections: [], workflows: [], profiles: [] }),
      saveConnection: () => { throw new Error('unused') },
      saveWorkflow: () => { throw new Error('unused') },
      saveProfile: () => { throw new Error('unused') },
    },
    resources: { probe: async () => { throw new Error('unused') }, list: async () => { throw new Error('unused') } },
    audioGeneration,
    getRun: () => { throw new Error('unused') },
  }
}

describe('媒体设置 IPC 授权', () => {
  test('Given 当前项目图片引用 When 读取本地缩略图 Then 返回受控图片字节并复核项目', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const projectChecks: string[] = []
    const reads: unknown[] = []
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => true,
      assertProject: (projectId) => { projectChecks.push(projectId) },
      configuration: { read: () => ({ schemaVersion: 1, revision: 0, connections: [], workflows: [], profiles: [] }),
        saveConnection: () => { throw new Error('unused') }, saveWorkflow: () => { throw new Error('unused') }, saveProfile: () => { throw new Error('unused') } },
      resources: { probe: async () => { throw new Error('unused') }, list: async () => { throw new Error('unused') } },
      readAssetThumbnail: async (projectId, asset) => {
        reads.push([projectId, asset])
        return { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/webp' }
      },
      getRun: () => { throw new Error('unused') },
    })

    try {
      const result = await handlers.get(MEDIA_IPC_CHANNELS.READ_ASSET_THUMBNAIL)!(
        { sender: {} } as IpcMainInvokeEvent,
        { projectId: 'project-1', asset: imageAsset },
      )
      expect(result).toEqual({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/webp' })
      expect(reads).toEqual([['project-1', imageAsset]])
      expect(projectChecks).toEqual(['project-1', 'project-1'])
    } finally { registration.dispose() }
  })

  test('Given 非图片或伪造缩略图参数 When 读取 Then 在访问项目和磁盘前拒绝', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    let projectChecks = 0
    let reads = 0
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => true,
      assertProject: () => { projectChecks += 1 },
      configuration: { read: () => ({ schemaVersion: 1, revision: 0, connections: [], workflows: [], profiles: [] }),
        saveConnection: () => { throw new Error('unused') }, saveWorkflow: () => { throw new Error('unused') }, saveProfile: () => { throw new Error('unused') } },
      resources: { probe: async () => { throw new Error('unused') }, list: async () => { throw new Error('unused') } },
      readAssetThumbnail: async () => { reads += 1; throw new Error('unused') },
      getRun: () => { throw new Error('unused') },
    })
    /** 统一通过 Promise 捕获同步参数错误与异步读取错误。 */
    const invoke = (input: unknown): Promise<unknown> => Promise.resolve().then(() => handlers.get(MEDIA_IPC_CHANNELS.READ_ASSET_THUMBNAIL)!({ sender: {} } as IpcMainInvokeEvent, input))

    try {
      for (const input of [
        { projectId: 'project-1', asset: { ...imageAsset, mediaKind: 'video' } },
        { projectId: 'project-1', asset: { ...imageAsset, hash: 'not-a-hash' } },
        { projectId: 'project-1', asset: { ...imageAsset, revision: 0 } },
        { projectId: 'project-1', asset: { ...imageAsset, internalPath: '/tmp/private' } },
        { projectId: '../project-1', asset: imageAsset },
        { projectId: 'project-1', asset: imageAsset, extra: true },
      ]) await expect(invoke(input)).rejects.toThrow('MEDIA_IPC_INPUT_INVALID')
      expect(projectChecks).toBe(0)
      expect(reads).toBe(0)
    } finally { registration.dispose() }
  })

  test('Given 图片读取期间窗口或项目撤权 When 返回字节 Then 不向 Renderer 泄露结果', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    let senderAuthorized = true
    let projectAuthorized = true
    let releaseRead: (() => void) | undefined
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => senderAuthorized,
      assertProject: () => { if (!projectAuthorized) throw new Error('MEDIA_PROJECT_NOT_AUTHORIZED') },
      configuration: { read: () => ({ schemaVersion: 1, revision: 0, connections: [], workflows: [], profiles: [] }),
        saveConnection: () => { throw new Error('unused') }, saveWorkflow: () => { throw new Error('unused') }, saveProfile: () => { throw new Error('unused') } },
      resources: { probe: async () => { throw new Error('unused') }, list: async () => { throw new Error('unused') } },
      readAssetThumbnail: async () => {
        await new Promise<void>((resolve) => { releaseRead = resolve })
        return { bytes: new Uint8Array([1]), contentType: 'image/png' }
      },
      getRun: () => { throw new Error('unused') },
    })

    try {
      const senderRevoked = handlers.get(MEDIA_IPC_CHANNELS.READ_ASSET_THUMBNAIL)!({ sender: {} } as IpcMainInvokeEvent, { projectId: 'project-1', asset: imageAsset })
      senderAuthorized = false
      releaseRead?.()
      await expect(senderRevoked).rejects.toThrow('MEDIA_ACCESS_DENIED')

      senderAuthorized = true
      const projectRevoked = handlers.get(MEDIA_IPC_CHANNELS.READ_ASSET_THUMBNAIL)!({ sender: {} } as IpcMainInvokeEvent, { projectId: 'project-1', asset: imageAsset })
      projectAuthorized = false
      releaseRead?.()
      await expect(projectRevoked).rejects.toThrow('MEDIA_PROJECT_NOT_AUTHORIZED')
    } finally { registration.dispose() }
  })
  test('Given 旧配置未包含授权模式 When 获取设置 Then 返回每次询问', () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => true,
      assertProject: () => undefined,
      configuration: { read: () => ({ schemaVersion: 1, revision: 0, connections: [], workflows: [], profiles: [] }),
        saveConnection: () => { throw new Error('unused') }, saveWorkflow: () => { throw new Error('unused') }, saveProfile: () => { throw new Error('unused') } },
      resources: { probe: async () => { throw new Error('unused') }, list: async () => { throw new Error('unused') } },
      getRun: () => { throw new Error('unused') },
    })

    try {
      expect(handlers.get(MEDIA_IPC_CHANNELS.GET_SETTINGS)!({} as IpcMainInvokeEvent)).toMatchObject({ authorizationMode: 'ask' })
    } finally { registration.dispose() }
  })

  test('Given 主窗口保存授权模式 When 参数合法 Then 透传 CAS 且不要求项目授权', () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const calls: unknown[] = []
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => true,
      assertProject: () => { throw new Error('不应要求项目') },
      configuration: { read: () => ({ schemaVersion: 2, revision: 3, authorizationMode: 'ask', connections: [], workflows: [], profiles: [] }),
        saveConnection: () => { throw new Error('unused') }, saveWorkflow: () => { throw new Error('unused') }, saveProfile: () => { throw new Error('unused') },
        saveAuthorizationMode: (mode, expectedRevision) => {
          calls.push([mode, expectedRevision])
          return { schemaVersion: 2, revision: 4, authorizationMode: 'automatic', connections: [], workflows: [], profiles: [] }
        } },
      resources: { probe: async () => { throw new Error('unused') }, list: async () => { throw new Error('unused') } },
      getRun: () => { throw new Error('unused') },
    })

    try {
      expect(handlers.get(MEDIA_IPC_CHANNELS.SAVE_AUTHORIZATION)!({} as IpcMainInvokeEvent, { mode: 'automatic', expectedRevision: 3 }))
        .toMatchObject({ revision: 4, authorizationMode: 'automatic' })
      expect(calls).toEqual([['automatic', 3]])
    } finally { registration.dispose() }
  })

  test('Given 授权保存请求非法、未授权或能力缺失 When 调用 Then 在写入前返回稳定错误', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    let authorized = true
    let writes = 0
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => authorized,
      assertProject: () => undefined,
      configuration: { read: () => ({ schemaVersion: 2, revision: 0, connections: [], workflows: [], profiles: [] }),
        saveConnection: () => { throw new Error('unused') }, saveWorkflow: () => { throw new Error('unused') }, saveProfile: () => { throw new Error('unused') },
        saveAuthorizationMode: () => { writes += 1; throw new Error('不应调用') } },
      resources: { probe: async () => { throw new Error('unused') }, list: async () => { throw new Error('unused') } },
      getRun: () => { throw new Error('unused') },
    })
    const invoke = (input: unknown): unknown => handlers.get(MEDIA_IPC_CHANNELS.SAVE_AUTHORIZATION)!({} as IpcMainInvokeEvent, input)

    try {
      for (const input of [
        { mode: 'always', expectedRevision: 0 }, { mode: 'ask', expectedRevision: -1 },
        { mode: 'ask', expectedRevision: 0, extra: true },
      ]) await expect(Promise.resolve().then(() => invoke(input))).rejects.toThrow('MEDIA_IPC_INPUT_INVALID')
      authorized = false
      await expect(Promise.resolve().then(() => invoke({ mode: 'ask', expectedRevision: 0 }))).rejects.toThrow('MEDIA_ACCESS_DENIED')
      expect(writes).toBe(0)
    } finally { registration.dispose() }

    authorized = true
    const unavailable = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => true,
      assertProject: () => undefined,
      configuration: { read: () => ({ schemaVersion: 2, revision: 0, connections: [], workflows: [], profiles: [] }),
        saveConnection: () => { throw new Error('unused') }, saveWorkflow: () => { throw new Error('unused') }, saveProfile: () => { throw new Error('unused') } },
      resources: { probe: async () => { throw new Error('unused') }, list: async () => { throw new Error('unused') } },
      getRun: () => { throw new Error('unused') },
    })
    try {
      await expect(Promise.resolve().then(() => invoke({ mode: 'ask', expectedRevision: 0 }))).rejects.toThrow('MEDIA_CONFIGURATION_UNAVAILABLE')
    } finally { unavailable.dispose() }
  })

  test('Given 远端 UI 工作流 When 设置页读取详情 Then IPC 复用转换分析并只返回安全问题', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const descriptor = { connectionId: 'gpu', instanceGeneration: 'v1', remoteUser: 'default', source: 'user-data' as const, id: 'workflow-1', workflowPath: 'workflow-1.json' }
    /** 模拟正文读取成功而节点接口暂时不可用。 */
    let schemaUnavailable = false
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => true,
      assertProject: () => undefined,
      configuration: { read: () => ({ schemaVersion: 2, revision: 0, connections: [], workflows: [], profiles: [] }), saveConnection: () => { throw new Error('unused') }, saveWorkflow: () => { throw new Error('unused') }, saveProfile: () => { throw new Error('unused') } },
      resources: {
        probe: async () => { throw new Error('unused') },
        list: async () => { throw new Error('unused') },
        readWorkflow: async () => ({ descriptor, format: 'ui', definition: {
          nodes: [{ id: 1, type: 'MissingNode', inputs: [{ name: 'token', link: null }], widgets_values: ['Bearer should-not-leak'] }],
          links: [],
        } }),
        getSchema: async () => { if (schemaUnavailable) throw new Error('Bearer schema-secret'); return {} },
      },
      getRun: () => { throw new Error('unused') },
    })
    try {
      const result = await handlers.get(MEDIA_IPC_CHANNELS.READ_REMOTE_WORKFLOW)!({} as IpcMainInvokeEvent, descriptor) as {
        analysis?: { convertible: boolean; definition: unknown; issues: Array<{ code: string; nodeId?: string }> }
      }
      expect(result.analysis).toMatchObject({ convertible: false, definition: null })
      expect(result.analysis?.issues).toContainEqual(expect.objectContaining({ code: 'NODE_CLASS_UNKNOWN', nodeId: '1' }))
      expect(JSON.stringify(result.analysis)).not.toContain('Bearer should-not-leak')
      schemaUnavailable = true
      const offline = await handlers.get(MEDIA_IPC_CHANNELS.READ_REMOTE_WORKFLOW)!({} as IpcMainInvokeEvent, descriptor) as {
        definition: unknown; analysis: { convertible: boolean; issues: Array<{ code: string }> }
      }
      expect(offline.definition).toBeDefined()
      expect(offline.analysis.convertible).toBeFalse()
      expect(offline.analysis.issues).toContainEqual(expect.objectContaining({ code: 'REMOTE_WORKFLOW_SCHEMA_UNAVAILABLE' }))
      expect(JSON.stringify(offline.analysis)).not.toContain('schema-secret')
    } finally { registration.dispose() }
  })

  test('Given 工作流读取抛出远端异常 When IPC 收口 Then 主进程记录原异常与安全身份且 Renderer 只收到稳定错误码', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const descriptor = { connectionId: 'gpu', instanceGeneration: 'v1', remoteUser: 'secret-user', source: 'user-data' as const, id: 'workflow-safe-id', workflowPath: 'workflow.json' }
    const caughtError = new Error('Authorization: Bearer should-not-reach-renderer')
    const logs: Array<{ message: string; error: unknown }> = []
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => true,
      assertProject: () => undefined,
      configuration: { read: () => ({ schemaVersion: 2, revision: 0, connections: [], workflows: [], profiles: [] }), saveConnection: () => { throw new Error('unused') }, saveWorkflow: () => { throw new Error('unused') }, saveProfile: () => { throw new Error('unused') } },
      resources: { probe: async () => { throw new Error('unused') }, list: async () => { throw new Error('unused') }, readWorkflow: async () => { throw caughtError }, getSchema: async () => ({}) },
      onBackgroundError: (message, error) => { logs.push({ message, error }) },
      getRun: () => { throw new Error('unused') },
    })
    try {
      await expect(handlers.get(MEDIA_IPC_CHANNELS.READ_REMOTE_WORKFLOW)!({} as IpcMainInvokeEvent, descriptor))
        .rejects.toThrow('MEDIA_REMOTE_WORKFLOW_READ_FAILED')
      expect(logs).toEqual([{ message: '[媒体工作流] 详情分析失败 id=workflow-safe-id source=user-data', error: caughtError }])
      expect(logs[0]?.message).not.toContain('secret-user')
      expect(logs[0]?.message).not.toContain('Bearer')
    } finally { registration.dispose() }
  })

  test('Given 资源预览和本地导入 When 主窗口读取 Then 媒体验签且导入始终检查项目', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    let authorized = true
    let imported = false
    let invalidBytes = false
    let revokeOnRead = false
    const descriptor = { connectionId: 'gpu', instanceGeneration: 'v1', remoteUser: 'default', source: 'assets-api' as const, id: 'asset-1', assetId: 'asset-1' }
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => authorized,
      assertProject: (id) => { if (id !== 'project-a') throw new Error('PROJECT_NOT_AUTHORIZED') },
      configuration: { read: () => ({ schemaVersion: 2, revision: 0, connections: [], workflows: [], profiles: [] }), saveConnection: () => { throw new Error('unused') }, saveWorkflow: () => { throw new Error('unused') }, saveProfile: () => { throw new Error('unused') } },
      resources: { probe: async () => { throw new Error('unused') }, list: async () => { throw new Error('unused') }, readRemoteAsset: async (_descriptor, _project, maxBytes) => {
        expect(maxBytes).toBe(16 * 1024 * 1024)
        if (revokeOnRead) authorized = false
        return { descriptor, bytes: invalidBytes ? new Uint8Array([1, 2, 3]) : new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), contentType: 'text/html' }
      } },
      importLocalAsset: async () => { imported = true; return null }, getRun: () => { throw new Error('unused') },
    })
    const event = {} as IpcMainInvokeEvent
    try {
      await expect(handlers.get(MEDIA_IPC_CHANNELS.READ_REMOTE_ASSET)!(event, descriptor)).resolves.toMatchObject({ contentType: 'image/png' })
      invalidBytes = true
      await expect(handlers.get(MEDIA_IPC_CHANNELS.READ_REMOTE_ASSET)!(event, descriptor)).rejects.toThrow('MEDIA_FILE_SIGNATURE_UNSUPPORTED')
      revokeOnRead = true
      await expect(handlers.get(MEDIA_IPC_CHANNELS.READ_REMOTE_ASSET)!(event, descriptor)).rejects.toThrow('MEDIA_ACCESS_DENIED')
      authorized = true
      await expect(handlers.get(MEDIA_IPC_CHANNELS.IMPORT_LOCAL_ASSET)!(event, { projectId: 'other', mediaKind: 'audio' })).rejects.toThrow('PROJECT_NOT_AUTHORIZED')
      expect(imported).toBeFalse()
      await expect(handlers.get(MEDIA_IPC_CHANNELS.IMPORT_LOCAL_ASSET)!(event, { projectId: 'project-a', mediaKind: 'audio' })).resolves.toBeNull()
      expect(imported).toBeTrue()
    } finally { registration.dispose() }
  })
  test('Given 未选择项目的设置窗口 When 保存全局连接和公共工作流 Then 不触发项目授权且隐藏认证历史', async () => {
    /** 调用表只模拟主窗口 IPC 身份，不创建项目。 */
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const configuration = { schemaVersion: 2 as const, revision: 1, connections: [], workflows: [], profiles: [], connectionHistory: [] }
    let writes = 0
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => true,
      assertProject: () => { throw new Error('不应要求项目') },
      configuration: { read: () => configuration, saveConnection: () => { writes += 1; return configuration },
        saveWorkflow: () => { writes += 1; return configuration }, saveProfile: () => { throw new Error('unused') } },
      resources: { probe: async () => ({ connectionId: 'gpu', checkedAt: 1, nodeCount: 1, modelFolders: [], modelListing: 'available' }), list: async () => { throw new Error('unused') } },
      getRun: () => { throw new Error('unused') },
    })
    const event = {} as IpcMainInvokeEvent
    try {
      const saved = handlers.get(MEDIA_IPC_CHANNELS.SAVE_CONNECTION)!(event, { input: { id: 'gpu', name: 'GPU', driver: 'comfyui', baseUrl: 'http://localhost:8188', enabled: true, auth: { kind: 'none' } }, expectedRevision: 0 })
      expect(saved).not.toHaveProperty('connectionHistory')
      handlers.get(MEDIA_IPC_CHANNELS.SAVE_WORKFLOW)!(event, { input: { id: 'wf', name: '图', projectId: null, definition: {} }, expectedRevision: 0 })
      expect(writes).toBe(2)
      await expect(handlers.get(MEDIA_IPC_CHANNELS.PROBE_CONNECTION)!(event, { connectionId: 'gpu' })).resolves.toMatchObject({ connectionId: 'gpu' })
    } finally { registration.dispose() }
  })
  test('Given 非主窗口 When 调用配置保存 Then 在解析和写入之前拒绝', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    let writes = 0
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => false,
      assertProject: () => undefined,
      configuration: { read: () => ({ schemaVersion: 1, revision: 0, connections: [], workflows: [], profiles: [] }),
        saveConnection: () => { writes += 1; throw new Error('不应调用') }, saveWorkflow: () => { throw new Error('不应调用') }, saveProfile: () => { throw new Error('不应调用') } },
      resources: { probe: async () => { throw new Error('不应调用') }, list: async () => { throw new Error('不应调用') } },
      getRun: () => { throw new Error('不应调用') },
    })
    await expect(Promise.resolve().then(() => handlers.get(MEDIA_IPC_CHANNELS.SAVE_CONNECTION)!({} as IpcMainInvokeEvent, {}))).rejects.toThrow('MEDIA_ACCESS_DENIED')
    expect(writes).toBe(0)
    registration.dispose()
    expect(handlers.size).toBe(0)
  })
  test('Given 多窗口多项目订阅 When 退订、撤权或销毁 Then 事件按当前权限和引用计数隔离并释放监听', () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const authorized = new Set([1, 2])
    const createWindow = (id: number) => Object.assign(new EventEmitter(), {
      id, destroyed: false, received: [] as unknown[],
      isDestroyed() { return this.destroyed },
      send(_channel: string, value: unknown) { this.received.push(value) },
    })
    const first = createWindow(1); const second = createWindow(2)
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: (event) => authorized.has(event.sender.id), assertProject: () => undefined,
      configuration: { read: () => ({ schemaVersion: 1, revision: 0, connections: [], workflows: [], profiles: [] }),
        saveConnection: () => { throw new Error('unused') }, saveWorkflow: () => { throw new Error('unused') }, saveProfile: () => { throw new Error('unused') } },
      resources: { probe: async () => { throw new Error('unused') }, list: async () => { throw new Error('unused') } },
      getRun: () => { throw new Error('unused') },
    })
    const invoke = (window: typeof first, channel: string, projectId: string) => handlers.get(channel)!({ sender: window } as unknown as IpcMainInvokeEvent, { projectId })
    const event = (projectId: string): MediaRunEvent => ({ run: { id: 'run', projectId, revision: 1, profileId: 'profile', profileRevision: 1,
      createdAt: 1, updatedAt: 1, phase: 'running', outputs: [], error: null, progress: { nodeId: '3', value: 12, max: 30 } } })
    invoke(first, MEDIA_IPC_CHANNELS.WATCH_PROJECT, 'project-a')
    invoke(first, MEDIA_IPC_CHANNELS.WATCH_PROJECT, 'project-a')
    invoke(second, MEDIA_IPC_CHANNELS.WATCH_PROJECT, 'project-b')
    invoke(first, MEDIA_IPC_CHANNELS.UNWATCH_PROJECT, 'project-a')
    registration.publishRun(event('project-a'))
    expect(first.received).toHaveLength(1)
    expect(second.received).toHaveLength(0)
    expect(first.listenerCount('destroyed')).toBe(1)
    authorized.delete(1)
    registration.publishRun(event('project-a'))
    expect(first.received).toHaveLength(1)
    expect(first.listenerCount('destroyed')).toBe(0)
    authorized.add(1)
    registration.publishRun(event('project-a'))
    expect(first.received).toHaveLength(1)
    invoke(first, MEDIA_IPC_CHANNELS.UNWATCH_PROJECT, 'project-a')
    expect(first.listenerCount('destroyed')).toBe(0)
    second.destroyed = true
    second.emit('destroyed')
    registration.publishRun(event('project-b'))
    expect(second.received).toHaveLength(0)
    registration.dispose()
    expect(handlers.size).toBe(0)
    expect(second.listenerCount('destroyed')).toBe(0)
  })
  test.each(['unwatch', 'publish'] as const)('Given 项目删除且同窗口订阅多个项目 When %s Then 释放失效引用并保留其它项目', (action) => {
    /** 调用表和项目集合模拟同一窗口的真实生命周期。 */
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const projects = new Set(['project-a', 'project-b'])
    const sender = Object.assign(new EventEmitter(), {
      received: [] as unknown[], isDestroyed: () => false,
      send(_channel: string, value: unknown) { this.received.push(value) },
    })
    const registration = registerMediaIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      isAuthorizedSender: () => true,
      assertProject: (projectId) => { if (!projects.has(projectId)) throw new Error('PROJECT_NOT_FOUND') },
      configuration: { read: () => ({ schemaVersion: 1, revision: 0, connections: [], workflows: [], profiles: [] }),
        saveConnection: () => { throw new Error('unused') }, saveWorkflow: () => { throw new Error('unused') }, saveProfile: () => { throw new Error('unused') } },
      resources: { probe: async () => { throw new Error('unused') }, list: async () => { throw new Error('unused') } },
      getRun: () => { throw new Error('unused') },
    })
    /** 发送指定项目的订阅调用或运行事件，无需完整 Electron 实例。 */
    const invoke = (channel: string, projectId: string): unknown => handlers.get(channel)!({ sender } as unknown as IpcMainInvokeEvent, { projectId })
    const publish = (projectId: string): void => registration.publishRun({ run: { id: 'run', projectId, revision: 1,
      profileId: 'profile', profileRevision: 1, createdAt: 1, updatedAt: 1, phase: 'running', outputs: [], error: null, progress: null } })
    try {
      invoke(MEDIA_IPC_CHANNELS.WATCH_PROJECT, 'project-a')
      invoke(MEDIA_IPC_CHANNELS.WATCH_PROJECT, 'project-b')
      projects.delete('project-a')
      expect(() => action === 'unwatch' ? invoke(MEDIA_IPC_CHANNELS.UNWATCH_PROJECT, 'project-a') : publish('project-a')).not.toThrow()
      expect(sender.listenerCount('destroyed')).toBe(1)
      publish('project-b')
      expect(sender.received).toHaveLength(1)
      // 即使同名项目后来恢复，旧订阅也不能自行重新获得访问。
      projects.add('project-a')
      publish('project-a')
      expect(sender.received).toHaveLength(1)
      projects.delete('project-b')
      expect(() => action === 'unwatch' ? invoke(MEDIA_IPC_CHANNELS.UNWATCH_PROJECT, 'project-b') : publish('project-b')).not.toThrow()
      expect(sender.listenerCount('destroyed')).toBe(0)
      expect(() => invoke(MEDIA_IPC_CHANNELS.WATCH_PROJECT, 'project-b')).toThrow('PROJECT_NOT_FOUND')
    } finally { registration.dispose() }
  })
})

describe('独立音频生成 IPC', () => {
  /** 创建默认成功的可注入音频服务，并允许单项覆盖。 */
  function createService(overrides: Partial<AudioGenerationIpcService> = {}): AudioGenerationIpcService {
    const settings: AudioGenerationSettingsResult = { catalog: createAudioCatalog(), legacyAudioProfiles: [] }
    return {
      listSettings: () => settings,
      replace: () => settings,
      fetchCatalog: unusedAudioCatalogFetch,
      test: async (_ownerId, input) => ({ requestId: input.requestId, state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success }),
      cancel: () => undefined,
      releaseOwner: () => undefined,
      ...overrides,
    }
  }

  test('Given 已授权设置窗口 When 读取音频设置 Then 返回独立目录与只读旧音频摘要且拒绝 GET 多余参数', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const settings: AudioGenerationSettingsResult = {
      catalog: createAudioCatalog(),
      legacyAudioProfiles: [{ id: 'legacy-1', name: '旧语音', protocol: 'minimax-speech', modelId: 'speech-01', enabled: true }],
    }
    const registration = registerMediaIpcHandlers(createMediaOptions(handlers, createService({ listSettings: () => settings })))
    try {
      const handler = handlers.get(MEDIA_IPC_CHANNELS.GET_AUDIO_GENERATION_SETTINGS)!
      expect(handler({ sender: {} } as IpcMainInvokeEvent)).toEqual(settings)
      await expect(Promise.resolve().then(() => handler({ sender: {} } as IpcMainInvokeEvent, {})))
        .rejects.toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    } finally { registration.dispose() }
  })

  test('Given 非主窗口 When 调用音频配置 Then 在 parser、Store 和 tester 之前拒绝', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    let calls = 0
    const registration = registerMediaIpcHandlers(createMediaOptions(handlers, createService({
      listSettings: () => { calls += 1; throw new Error('不应调用') },
      replace: () => { calls += 1; throw new Error('不应调用') },
      test: async () => { calls += 1; throw new Error('不应调用') },
      cancel: () => { calls += 1 },
    }), () => false))
    const event = { sender: { id: 9 } } as IpcMainInvokeEvent
    try {
      for (const [channel, input] of [
        [MEDIA_IPC_CHANNELS.GET_AUDIO_GENERATION_SETTINGS, undefined],
        [MEDIA_IPC_CHANNELS.REPLACE_AUDIO_GENERATION_CATALOG, { malformed: true }],
        [MEDIA_IPC_CHANNELS.TEST_AUDIO_GENERATION, { malformed: true }],
        [MEDIA_IPC_CHANNELS.CANCEL_AUDIO_GENERATION_TEST, { malformed: true }],
        [MEDIA_IPC_CHANNELS.FETCH_AUDIO_GENERATION_CATALOG, { malformed: true }],
      ] as const) {
        await expect(Promise.resolve().then(() => handlers.get(channel)!(event, input))).rejects.toThrow('MEDIA_ACCESS_DENIED')
      }
      expect(calls).toBe(0)
    } finally { registration.dispose() }
  })

  test('Given 已授权窗口 When 从供应商获取 Then 先解析输入并在返回后重新核权', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    /** 拉取期间撤权，验证迟到结果不会回传给已失效窗口。 */
    let authorized = true
    const requests: string[] = []
    const registration = registerMediaIpcHandlers(createMediaOptions(handlers, createService({
      fetchCatalog: async (input) => {
        requests.push(`${input.provider}:${input.requestId}`)
        authorized = false
        return {
          requestId: input.requestId,
          state: 'success',
          message: AUDIO_GENERATION_CATALOG_MESSAGES.success,
          models: ['mimo-v2.5-tts'],
          voices: [],
        }
      },
    }), () => authorized))
    const event = { sender: Object.assign(new EventEmitter(), { id: 7 }) } as unknown as IpcMainInvokeEvent
    const fetchInput: AudioGenerationCatalogFetchInput = {
      requestId: 'fetch-1',
      provider: 'xiaomi',
      baseUrl: 'https://tts.example/v1',
      credential: { mode: 'draft', apiKey: 'secret-key' },
    }
    try {
      /** 多余字段必须在解析阶段失败，且不触发上游请求。 */
      await expect(handlers.get(MEDIA_IPC_CHANNELS.FETCH_AUDIO_GENERATION_CATALOG)!(event, { ...fetchInput, extra: true }))
        .rejects.toThrow('AUDIO_GENERATION_CONFIG_INVALID')
      expect(requests).toEqual([])
      await expect(handlers.get(MEDIA_IPC_CHANNELS.FETCH_AUDIO_GENERATION_CATALOG)!(event, fetchInput))
        .rejects.toThrow('MEDIA_ACCESS_DENIED')
      expect(requests).toEqual(['xiaomi:fetch-1'])
    } finally { registration.dispose() }
  })

  test('Given 音频写入测试与取消 When envelope 含额外字段 Then strict parser 在服务前拒绝', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const calls: string[] = []
    const registration = registerMediaIpcHandlers(createMediaOptions(handlers, createService({
      replace: (input) => { calls.push(`replace:${input.expectedRevision}`); return { catalog: createAudioCatalog(), legacyAudioProfiles: [] } },
      test: async (ownerId, input) => { calls.push(`test:${ownerId}:${input.requestId}`); return { requestId: input.requestId, state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success } },
      cancel: (ownerId, requestId) => { calls.push(`cancel:${ownerId}:${requestId}`) },
    })))
    const event = { sender: Object.assign(new EventEmitter(), { id: 7 }) } as unknown as IpcMainInvokeEvent
    const request: ReplaceAudioGenerationCatalogRequest = {
      expectedRevision: 0,
      profiles: [{ profile: createAudioProfile(), credentialUpdate: { mode: 'replace', apiKey: 'secret-key' } }],
    }
    const testInput: AudioGenerationTestInput = { kind: 'saved', requestId: 'request-1', profileId: 'audio-1' }
    try {
      expect(handlers.get(MEDIA_IPC_CHANNELS.REPLACE_AUDIO_GENERATION_CATALOG)!(event, request)).toBeDefined()
      await expect(handlers.get(MEDIA_IPC_CHANNELS.TEST_AUDIO_GENERATION)!(event, testInput)).resolves.toMatchObject({ state: 'success' })
      expect(handlers.get(MEDIA_IPC_CHANNELS.CANCEL_AUDIO_GENERATION_TEST)!(event, { requestId: 'request-1' })).toBeUndefined()
      for (const [channel, input] of [
        [MEDIA_IPC_CHANNELS.REPLACE_AUDIO_GENERATION_CATALOG, { ...request, extra: true }],
        [MEDIA_IPC_CHANNELS.TEST_AUDIO_GENERATION, { ...testInput, extra: true }],
        [MEDIA_IPC_CHANNELS.CANCEL_AUDIO_GENERATION_TEST, { requestId: 'request-1', extra: true }],
      ] as const) {
        await expect(Promise.resolve().then(() => handlers.get(channel)!(event, input)))
          .rejects.toThrow('AUDIO_GENERATION_CONFIG_INVALID')
      }
      expect(calls).toEqual(['replace:0', 'test:7:request-1', 'cancel:7:request-1'])
    } finally { registration.dispose() }
  })

  test('Given 底层异常或提交结果未知 When 音频 IPC 收口 Then 不泄露 cause 且保留 outcome unknown', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    let preserveOutcomeUnknown = true
    const outcomeUnknownError = new Error('AUDIO_GENERATION_CONFIG_OUTCOME_UNKNOWN', {
      cause: new Error('Authorization: Bearer secret-key /Users/private'),
    })
    const registration = registerMediaIpcHandlers(createMediaOptions(handlers, createService({
      replace: () => {
        if (preserveOutcomeUnknown) throw outcomeUnknownError
        throw new Error('Authorization: Bearer secret-key /Users/private')
      },
      test: async () => { throw new Error('Authorization: Bearer secret-key /Users/private') },
    })))
    const event = { sender: Object.assign(new EventEmitter(), { id: 8 }) } as unknown as IpcMainInvokeEvent
    const request: ReplaceAudioGenerationCatalogRequest = {
      expectedRevision: 0,
      profiles: [{ profile: createAudioProfile(), credentialUpdate: { mode: 'replace', apiKey: 'secret-key' } }],
    }
    try {
      let sanitizedError: unknown
      try {
        handlers.get(MEDIA_IPC_CHANNELS.REPLACE_AUDIO_GENERATION_CATALOG)!(event, request)
      } catch (error) {
        sanitizedError = error
      }
      expect(sanitizedError).toBeInstanceOf(Error)
      expect(sanitizedError).not.toBe(outcomeUnknownError)
      expect((sanitizedError as Error).message).toBe('AUDIO_GENERATION_CONFIG_OUTCOME_UNKNOWN')
      expect((sanitizedError as Error & { cause?: unknown }).cause).toBeUndefined()
      expect(String(sanitizedError)).not.toContain('secret-key')
      expect(String(sanitizedError)).not.toContain('/Users/private')
      preserveOutcomeUnknown = false
      expect(() => handlers.get(MEDIA_IPC_CHANNELS.REPLACE_AUDIO_GENERATION_CATALOG)!(event, request))
        .toThrow('AUDIO_GENERATION_CONFIG_WRITE_FAILED')
      await expect(handlers.get(MEDIA_IPC_CHANNELS.TEST_AUDIO_GENERATION)!(event, {
        kind: 'saved', requestId: 'request-1', profileId: 'audio-1',
      })).rejects.toThrow('AUDIO_GENERATION_TEST_FAILED')
    } finally { registration.dispose() }
  })

  test('Given 同一 sender 多次测试 When sender 销毁或测试迟到 Then 只注册一次监听、释放一次且不返回迟到结果', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const sender = Object.assign(new EventEmitter(), { id: 11, destroyed: false, isDestroyed() { return this.destroyed } })
    const releasedOwners: number[] = []
    let finishLate!: (result: AudioGenerationTestResult) => void
    let invocation = 0
    const registration = registerMediaIpcHandlers(createMediaOptions(handlers, createService({
      test: async (_ownerId, input) => {
        invocation += 1
        if (invocation < 3) return { requestId: input.requestId, state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success }
        return new Promise<AudioGenerationTestResult>((resolve) => { finishLate = resolve })
      },
      releaseOwner: (ownerId) => { releasedOwners.push(ownerId) },
    }), () => !sender.destroyed))
    const event = { sender } as unknown as IpcMainInvokeEvent
    const handler = handlers.get(MEDIA_IPC_CHANNELS.TEST_AUDIO_GENERATION)!
    try {
      await handler(event, { kind: 'saved', requestId: 'request-1', profileId: 'audio-1' })
      await handler(event, { kind: 'saved', requestId: 'request-2', profileId: 'audio-1' })
      expect(sender.listenerCount('destroyed')).toBe(1)
      const late = Promise.resolve(handler(event, { kind: 'saved', requestId: 'request-3', profileId: 'audio-1' }))
      sender.destroyed = true
      sender.emit('destroyed')
      expect(releasedOwners).toEqual([11])
      expect(sender.listenerCount('destroyed')).toBe(0)
      finishLate({ requestId: 'request-3', state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success })
      await expect(late).rejects.toThrow('MEDIA_ACCESS_DENIED')
      registration.dispose()
      expect(releasedOwners).toEqual([11])
    } finally { registration.dispose() }
  })

  test('Given sender 已登记测试 When dispose Then 移除监听、释放 owner 并注销所有 handler', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const sender = Object.assign(new EventEmitter(), { id: 12, isDestroyed: () => false })
    const releasedOwners: number[] = []
    let serviceDisposals = 0
    const registration = registerMediaIpcHandlers(createMediaOptions(handlers, createService({
      releaseOwner: (ownerId) => { releasedOwners.push(ownerId) },
      dispose: () => { serviceDisposals += 1 },
    })))
    await handlers.get(MEDIA_IPC_CHANNELS.TEST_AUDIO_GENERATION)!({ sender } as unknown as IpcMainInvokeEvent, {
      kind: 'saved', requestId: 'request-1', profileId: 'audio-1',
    })
    expect(sender.listenerCount('destroyed')).toBe(1)
    registration.dispose()
    expect(releasedOwners).toEqual([12])
    expect(serviceDisposals).toBe(1)
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(handlers.size).toBe(0)
  })
})

describe('音频生成 IPC 服务装配', () => {
  /** 创建旧统一目录条目，允许覆盖协议和标识以验证迁移边界。 */
  function createLegacyEntry(overrides: Record<string, unknown> = {}): MediaApiModelCatalogEntry {
    return {
      profile: {
        id: 'legacy-1', name: '旧 MiniMax', mediaKind: 'audio', protocol: 'minimax-speech',
        channelId: 'channel-1', modelId: 'speech-01', capabilities: ['text-to-speech'],
        enabled: true, createdAt: 1, updatedAt: 1, ...overrides,
      } as MediaApiModelCatalogEntry['profile'],
      support: { state: 'configuration-only' as const, reason: '旧配置' },
    }
  }

  test('Given 独立目录与混合旧目录 When 读取设置 Then 只投影 minimax-speech 且不改变旧条目', () => {
    const legacyCatalog = { revision: 3, entries: [
      createLegacyEntry(),
      createLegacyEntry({ id: 'image-1', name: '生图', mediaKind: 'image', protocol: 'openai-images', modelId: 'gpt-image-1' }),
      createLegacyEntry({ id: 'video-1', name: '视频', mediaKind: 'video', protocol: 'minimax-video', modelId: 'video-01' }),
    ] }
    const original = structuredClone(legacyCatalog)
    const service = createAudioGenerationIpcService({
      store: { readPublic: () => createAudioCatalog(), replace: () => createAudioCatalog() },
      tests: { test: async () => { throw new Error('unused') }, cancel: () => undefined, releaseOwner: () => undefined },
      catalog: { fetch: unusedAudioCatalogFetch },
      listLegacyCatalog: () => legacyCatalog,
    })

    expect(service.listSettings()).toEqual({
      catalog: createAudioCatalog(),
      legacyAudioProfiles: [{ id: 'legacy-1', name: '旧 MiniMax', protocol: 'minimax-speech', modelId: 'speech-01', enabled: true }],
    })
    expect(legacyCatalog).toEqual(original)
  })

  test('Given 旧目录读取失败、重复或损坏 When 读取设置 Then 只返回固定 warning 且独立目录仍可用', () => {
    const catalog = createAudioCatalog()
    for (const listLegacyCatalog of [
      () => { throw new Error('Authorization: Bearer secret-key /Users/private') },
      () => ({ revision: 1, entries: [createLegacyEntry(), createLegacyEntry()] }),
      () => ({ revision: 1, entries: [createLegacyEntry({ id: '../invalid' })] }),
    ]) {
      const service = createAudioGenerationIpcService({
        store: { readPublic: () => catalog, replace: () => catalog },
        tests: { test: async () => { throw new Error('unused') }, cancel: () => undefined, releaseOwner: () => undefined },
        catalog: { fetch: unusedAudioCatalogFetch },
        listLegacyCatalog,
      })
      expect(service.listSettings()).toEqual({ catalog, legacyAudioProfiles: [], legacyWarning: AUDIO_GENERATION_LEGACY_WARNING })
      expect(JSON.stringify(service.listSettings())).not.toContain('secret-key')
    }
  })

  test('Given 独立目录读取失败 When 读取设置 Then 抛稳定错误且不读取旧目录', () => {
    let legacyReads = 0
    const service = createAudioGenerationIpcService({
      store: { readPublic: () => { throw new Error('private path and key') }, replace: () => createAudioCatalog() },
      tests: { test: async () => { throw new Error('unused') }, cancel: () => undefined, releaseOwner: () => undefined },
      catalog: { fetch: unusedAudioCatalogFetch },
      listLegacyCatalog: () => { legacyReads += 1; return { revision: 0, entries: [] } },
    })
    expect(() => service.listSettings()).toThrow('AUDIO_GENERATION_CONFIG_READ_FAILED')
    expect(legacyReads).toBe(0)
  })

  test('Given 新增、改变或非法旧引用 When 替换目录 Then 写入前 fail closed；未改变引用可保留', () => {
    const existingProfile = {
      ...createAudioProfile({ legacyMediaProfileId: 'legacy-1' }),
      credentialConfigured: true,
      endpointOrigin: 'https://example.com',
    }
    const current = createAudioCatalog([existingProfile])
    let writes = 0
    let legacyReads = 0
    const store = {
      readPublic: () => current,
      replace: (_input: ReplaceAudioGenerationCatalogRequest) => { writes += 1; return { ...current, revision: current.revision + 1 } },
    }
    const tests = { test: async () => { throw new Error('unused') }, cancel: () => undefined, releaseOwner: () => undefined }
    const keepService = createAudioGenerationIpcService({
      store,
      tests,
      catalog: { fetch: unusedAudioCatalogFetch },
      listLegacyCatalog: () => { legacyReads += 1; throw new Error('旧目录故障') },
    })
    const preserveRequest: ReplaceAudioGenerationCatalogRequest = {
      expectedRevision: 0,
      profiles: [{ profile: createAudioProfile({ legacyMediaProfileId: 'legacy-1' }), credentialUpdate: { mode: 'preserve' } }],
    }
    expect(keepService.replace(preserveRequest).catalog.revision).toBe(1)
    expect(writes).toBe(1)
    expect(legacyReads).toBe(1)

    const rejectService = createAudioGenerationIpcService({
      store,
      tests,
      catalog: { fetch: unusedAudioCatalogFetch },
      listLegacyCatalog: () => ({ revision: 1, entries: [createLegacyEntry()] }),
    })
    const invalidReference: ReplaceAudioGenerationCatalogRequest = {
      expectedRevision: 0,
      profiles: [{ profile: createAudioProfile({ legacyMediaProfileId: 'image-1' }), credentialUpdate: { mode: 'preserve' } }],
    }
    expect(() => rejectService.replace(invalidReference)).toThrow('AUDIO_GENERATION_LEGACY_REFERENCE_INVALID')
    expect(writes).toBe(1)

    const changedToValid: ReplaceAudioGenerationCatalogRequest = {
      expectedRevision: 0,
      profiles: [{ profile: createAudioProfile({ legacyMediaProfileId: 'legacy-1' }), credentialUpdate: { mode: 'preserve' } }],
    }
    const emptyCurrentStore = { readPublic: () => createAudioCatalog(), replace: store.replace }
    expect(createAudioGenerationIpcService({ store: emptyCurrentStore, tests, catalog: { fetch: unusedAudioCatalogFetch }, listLegacyCatalog: () => ({ revision: 1, entries: [createLegacyEntry()] }) })
      .replace(changedToValid).catalog.revision).toBe(1)
    expect(writes).toBe(2)
  })
})
