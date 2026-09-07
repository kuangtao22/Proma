import { describe, expect, test } from 'bun:test'
import type { IpcMainInvokeEvent } from 'electron'
import { MEDIA_IPC_CHANNELS } from '@proma/shared'
import { registerMediaIpcHandlers } from './media-ipc'
import { EventEmitter } from 'node:events'
import type { MediaRunEvent } from '@proma/shared'

describe('媒体设置 IPC 授权', () => {
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
