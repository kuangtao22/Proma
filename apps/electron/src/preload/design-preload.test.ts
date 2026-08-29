import { describe, expect, test } from 'bun:test'
import { CANVAS_IPC_CHANNELS, DESIGN_IPC_CHANNELS } from '@proma/shared'
import type { IpcRendererEvent } from 'electron'
import { createDesignPreloadApi, type DesignPreloadIpc } from './design-preload'

/** 创建记录型 renderer IPC。 */
function createRecordingIpc() {
  /** 全部 invoke 调用。 */
  const invokes: Array<{ channel: string; args: unknown[] }> = []
  /** 注册的事件 handler。 */
  const added: Array<{ channel: string; listener: (event: IpcRendererEvent, value: unknown) => void }> = []
  /** 移除的事件 handler。 */
  const removed: typeof added = []
  /** preload 所需最小 IPC。 */
  const ipc: DesignPreloadIpc = {
    invoke: async (channel, ...args) => { invokes.push({ channel, args }); return channel },
    on: (channel, listener) => added.push({ channel, listener }),
    removeListener: (channel, listener) => removed.push({ channel, listener }),
  }
  return { ipc, invokes, added, removed }
}

describe('Design preload', () => {
  test('Given Canvas 生图 API When 调用 Then 只向固定通道透传公开合同字段', async () => {
    const recorded = createRecordingIpc()
    const api = createDesignPreloadApi(recorded.ipc)
    /** 完整图片模块身份，额外字段不得进入主进程。 */
    const target = {
      projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1',
      internalPath: '/Users/private/.proma/image-module-1',
    }
    /** 图片模块配置保存命令，额外字段不得越过 preload。 */
    const saveInput = {
      ...target,
      expectedConfigRevision: 3,
      prompt: '首页主视觉',
      selectedModelProfileId: 'profile-1',
      aspectRatio: '16:9' as const,
      imageSize: '2K' as const,
      contextMode: 'project' as const,
      credential: 'secret',
    }
    /** 图片任务控制命令。 */
    const jobInput = { ...target, jobId: 'job-1', stack: 'internal stack' }
    /** 图片输出采用命令。 */
    const adoptInput = {
      ...jobInput, assetId: 'asset-1', expectedConfigRevision: 4, ipcChannel: 'arbitrary:channel',
    }

    await api.loadCanvasImageModule(target)
    await api.saveCanvasImageModule(saveInput)
    await api.createCanvasImageJob({ ...target, expectedConfigRevision: 3 })
    await api.cancelCanvasImageJob(jobInput)
    await api.retryCanvasImageJob(jobInput)
    await api.adoptCanvasImageAsset(adoptInput)
    await api.releaseCanvasImageMedia({ ...target, mediaLeaseId: 'lease-1' })

    expect(recorded.invokes).toEqual([
      { channel: CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE, args: [{ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1' }] },
      { channel: CANVAS_IPC_CHANNELS.SAVE_IMAGE_MODULE, args: [{ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1', expectedConfigRevision: 3, prompt: '首页主视觉', selectedModelProfileId: 'profile-1', aspectRatio: '16:9', imageSize: '2K', contextMode: 'project' }] },
      { channel: CANVAS_IPC_CHANNELS.CREATE_IMAGE_JOB, args: [{ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1', expectedConfigRevision: 3 }] },
      { channel: CANVAS_IPC_CHANNELS.CANCEL_IMAGE_JOB, args: [{ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1', jobId: 'job-1' }] },
      { channel: CANVAS_IPC_CHANNELS.RETRY_IMAGE_JOB, args: [{ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1', jobId: 'job-1' }] },
      { channel: CANVAS_IPC_CHANNELS.ADOPT_IMAGE_ASSET, args: [{ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1', jobId: 'job-1', assetId: 'asset-1', expectedConfigRevision: 4 }] },
      { channel: CANVAS_IPC_CHANNELS.RELEASE_IMAGE_MEDIA, args: [{ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1', mediaLeaseId: 'lease-1' }] },
    ])
  })

  test('Given 多个 Canvas 生图订阅 When 推送并重复取消 Then 只映射公开目标且各自独立解绑', () => {
    const recorded = createRecordingIpc()
    const api = createDesignPreloadApi(recorded.ipc)
    /** 两个订阅分别收集同一公开事件。 */
    const receivedA: unknown[] = []
    const receivedB: unknown[] = []
    const releaseA = api.onCanvasImageModuleChanged((event) => receivedA.push(event))
    const releaseB = api.onCanvasImageModuleChanged((event) => receivedB.push(event))
    const payload = {
      projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1',
      internalPath: '/Users/private/.proma/image-module-1', stack: 'internal stack',
    }

    recorded.added[0]?.listener({ sender: 'electron-event' } as never, payload)
    recorded.added[1]?.listener({ sender: 'electron-event' } as never, payload)
    releaseA()
    releaseA()
    releaseB()

    const publicPayload = {
      projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1',
    }
    expect(receivedA).toEqual([publicPayload])
    expect(receivedB).toEqual([publicPayload])
    expect(recorded.added.map(({ channel }) => channel)).toEqual([
      CANVAS_IPC_CHANNELS.IMAGE_MODULE_CHANGED,
      CANVAS_IPC_CHANNELS.IMAGE_MODULE_CHANGED,
    ])
    /** 两个已注册订阅在断言前均已确认存在。 */
    const addedA = recorded.added[0]
    /** 第二个订阅必须保持独立 handler。 */
    const addedB = recorded.added[1]
    if (!addedA || !addedB) throw new Error('图片模块订阅未完整注册')
    expect(recorded.removed).toEqual([
      addedA,
      addedB,
    ])
  })

  test('Given 固定 API When 逐一调用 Then 只透传对应 Design 通道和结构化参数', async () => {
    const recorded = createRecordingIpc()
    const api = createDesignPreloadApi(recorded.ipc)
    const calls: Array<[() => Promise<unknown>, string, unknown[]]> = [
      [() => api.loadCanvasWorkspace({ projectId: 'p1', canvasId: 'canvas-1' }), CANVAS_IPC_CHANNELS.LOAD, [{ projectId: 'p1', canvasId: 'canvas-1' }]],
      [() => api.saveCanvasMutations({ projectId: 'p1', canvasId: 'canvas-1', expectedRevision: 0, mutations: [] }), CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, [{ projectId: 'p1', canvasId: 'canvas-1', expectedRevision: 0, mutations: [] }]],
      [() => api.createCanvasContentNode({ projectId: 'p1', canvasId: 'canvas-1', operationId: '11111111-1111-4111-8111-111111111111', nodeId: 'node-image', kind: 'image', contentId: 'content-image', title: '图片', position: { x: 1, y: 2 }, expectedRevision: 0 }), CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE, [{ projectId: 'p1', canvasId: 'canvas-1', operationId: '11111111-1111-4111-8111-111111111111', nodeId: 'node-image', kind: 'image', contentId: 'content-image', title: '图片', position: { x: 1, y: 2 }, expectedRevision: 0 }]],
      [() => api.deleteCanvasNode({ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-image', operationId: '22222222-2222-4222-8222-222222222222', expectedRevision: 1 }), CANVAS_IPC_CHANNELS.DELETE_NODE, [{ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-image', operationId: '22222222-2222-4222-8222-222222222222', expectedRevision: 1 }]],
      [() => api.listCanvasTrash({ projectId: 'p1', canvasId: 'canvas-1' }), CANVAS_IPC_CHANNELS.LIST_TRASH, [{ projectId: 'p1', canvasId: 'canvas-1' }]],
      [() => api.restoreCanvasNode({ projectId: 'p1', canvasId: 'canvas-1', operationId: '33333333-3333-4333-8333-333333333333', trashId: 'trash-1', expectedRevision: 2, position: { x: 3, y: 4 } }), CANVAS_IPC_CHANNELS.RESTORE_NODE, [{ projectId: 'p1', canvasId: 'canvas-1', operationId: '33333333-3333-4333-8333-333333333333', trashId: 'trash-1', expectedRevision: 2, position: { x: 3, y: 4 } }]],
      [() => api.createCanvasAgentNode({
        projectId: 'p1', canvasId: 'canvas-1',
        operationId: '11111111-1111-4111-8111-111111111111', nodeId: 'node-1',
        title: '首页 Agent', position: { x: 10, y: 20 },
      }), CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, [{
        projectId: 'p1', canvasId: 'canvas-1',
        operationId: '11111111-1111-4111-8111-111111111111', nodeId: 'node-1',
        title: '首页 Agent', position: { x: 10, y: 20 },
      }]],
      [() => api.rebuildCanvasAgentNode({
        projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-1',
        operationId: '22222222-2222-4222-8222-222222222222',
      }), CANVAS_IPC_CHANNELS.REBUILD_AGENT_NODE, [{
        projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-1',
        operationId: '22222222-2222-4222-8222-222222222222',
      }]],
      [() => api.listActiveCanvasAgentRuns(), CANVAS_IPC_CHANNELS.LIST_ACTIVE_AGENT_RUNS, []],
      [() => api.getCanvasAgentMessages({ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-1' }), CANVAS_IPC_CHANNELS.GET_AGENT_MESSAGES, [{ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-1' }]],
      [() => api.sendCanvasAgentMessage({ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-1', message: '继续', userMessageUuid: 'message-1', startedAt: 10 }), CANVAS_IPC_CHANNELS.SEND_AGENT_MESSAGE, [{ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-1', message: '继续', userMessageUuid: 'message-1', startedAt: 10 }]],
      [() => api.stopCanvasAgent({ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-1' }), CANVAS_IPC_CHANNELS.STOP_AGENT, [{ projectId: 'p1', canvasId: 'canvas-1', nodeId: 'node-1' }]],
      [() => api.listCanvasSessions({ projectId: 'p1', archived: false }), DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS, [{ projectId: 'p1', archived: false }]],
      [() => api.createCanvasSession({ projectId: 'p1', title: '页面设计' }), DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION, [{ projectId: 'p1', title: '页面设计' }]],
      [() => api.updateCanvasSession({ projectId: 'p1', canvasId: 'canvas-1', archived: true }), DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION, [{ projectId: 'p1', canvasId: 'canvas-1', archived: true }]],
      [() => api.deleteCanvasSession({ projectId: 'p1', canvasId: 'canvas-1' }), DESIGN_IPC_CHANNELS.DELETE_CANVAS_SESSION, [{ projectId: 'p1', canvasId: 'canvas-1' }]],
      [() => api.listImageModelProfiles(), DESIGN_IPC_CHANNELS.LIST_IMAGE_MODEL_PROFILES, []],
      [() => api.saveImageModelProfiles({ profiles: [] }), DESIGN_IPC_CHANNELS.SAVE_IMAGE_MODEL_PROFILES, [{ profiles: [] }]],
      [() => api.getImageModelSelection('p1'), DESIGN_IPC_CHANNELS.GET_IMAGE_MODEL_SELECTION, [{ projectId: 'p1' }]],
      [() => api.setImageModelSelection({ projectId: 'p1', imageModelProfileId: 'profile-flash' }), DESIGN_IPC_CHANNELS.SET_IMAGE_MODEL_SELECTION, [{ projectId: 'p1', imageModelProfileId: 'profile-flash' }]],
      [() => api.loadDesignWorkspace('p1'), DESIGN_IPC_CHANNELS.LOAD, [{ projectId: 'p1' }]],
      [() => api.saveDesignMutations({ projectId: 'p1', expectedRevision: 0, mutations: [] }), DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, [{ projectId: 'p1', expectedRevision: 0, mutations: [] }]],
      [() => api.importDesignAssets({ projectId: 'p1', expectedRevision: 3, viewportCenter: { x: 10, y: 20 } }), DESIGN_IPC_CHANNELS.IMPORT_ASSETS, [{ projectId: 'p1', expectedRevision: 3, viewportCenter: { x: 10, y: 20 } }]],
      [() => api.deleteDesignAsset({ projectId: 'p1', assetId: 'a1', expectedRevision: 0 }), DESIGN_IPC_CHANNELS.DELETE_ASSET, [{ projectId: 'p1', assetId: 'a1', expectedRevision: 0 }]],
      [() => api.relinkDesignAsset({ projectId: 'p1', assetId: 'a1', expectedRevision: 0 }), DESIGN_IPC_CHANNELS.RELINK_ASSET, [{ projectId: 'p1', assetId: 'a1', expectedRevision: 0 }]],
      [() => api.exportDesignAsset({ projectId: 'p1', assetId: 'a1' }), DESIGN_IPC_CHANNELS.EXPORT_ASSET, [{ projectId: 'p1', assetId: 'a1' }]],
      [() => api.createDesignJob({ projectId: 'p1', action: 'generate', prompt: 'x', contextMode: 'auto', imageModelProfileId: 'profile-flash', position: { x: 0, y: 0 } }), DESIGN_IPC_CHANNELS.CREATE_JOB, [{ projectId: 'p1', action: 'generate', prompt: 'x', contextMode: 'auto', imageModelProfileId: 'profile-flash', position: { x: 0, y: 0 } }]],
      [() => api.cancelDesignJob({ projectId: 'p1', jobId: 'j1' }), DESIGN_IPC_CHANNELS.CANCEL_JOB, [{ projectId: 'p1', jobId: 'j1' }]],
      [() => api.retryDesignJob({ projectId: 'p1', jobId: 'j1' }), DESIGN_IPC_CHANNELS.RETRY_JOB, [{ projectId: 'p1', jobId: 'j1' }]],
      [() => api.deleteDesignJob({ projectId: 'p1', jobId: 'j1' }), DESIGN_IPC_CHANNELS.DELETE_JOB, [{ projectId: 'p1', jobId: 'j1' }]],
      [() => api.listDesignJobs('p1'), DESIGN_IPC_CHANNELS.LIST_JOBS, [{ projectId: 'p1' }]],
      [() => api.getDesignTaskDetails({ projectId: 'p1', jobId: 'j1' }), DESIGN_IPC_CHANNELS.GET_TASK_DETAILS, [{ projectId: 'p1', jobId: 'j1' }]],
      [() => api.getDesignTaskTrace({ projectId: 'p1', jobId: 'j1' }), DESIGN_IPC_CHANNELS.GET_TASK_TRACE, [{ projectId: 'p1', jobId: 'j1' }]],
      [() => api.listDesignContext({ projectId: 'p1', query: 'brand' }), DESIGN_IPC_CHANNELS.LIST_CONTEXT, [{ projectId: 'p1', query: 'brand' }]],
      [() => api.upsertDesignContextDocument({ projectId: 'p1', category: 'brand', title: '品牌', tags: [], markdown: '# Brand' }), DESIGN_IPC_CHANNELS.UPSERT_CONTEXT_DOCUMENT, [{ projectId: 'p1', category: 'brand', title: '品牌', tags: [], markdown: '# Brand' }]],
      [() => api.importDesignContextDocument({ projectId: 'p1', category: 'brand', tags: [] }), DESIGN_IPC_CHANNELS.IMPORT_CONTEXT_DOCUMENT, [{ projectId: 'p1', category: 'brand', tags: [] }]],
      [() => api.updateDesignContext({ projectId: 'p1', entryId: 'context-1', category: 'brand', title: '品牌', tags: [] }), DESIGN_IPC_CHANNELS.UPDATE_CONTEXT, [{ projectId: 'p1', entryId: 'context-1', category: 'brand', title: '品牌', tags: [] }]],
      [() => api.registerDesignContextAsset({ projectId: 'p1', assetId: 'asset-1', category: 'reference', title: '参考', tags: [] }), DESIGN_IPC_CHANNELS.REGISTER_CONTEXT_ASSET, [{ projectId: 'p1', assetId: 'asset-1', category: 'reference', title: '参考', tags: [] }]],
      [() => api.deleteDesignContext({ projectId: 'p1', entryId: 'context-1' }), DESIGN_IPC_CHANNELS.DELETE_CONTEXT, [{ projectId: 'p1', entryId: 'context-1' }]],
      [() => api.prepareDesignAssetForSession({ projectId: 'p1', assetId: 'a1', sessionId: 's1' }), DESIGN_IPC_CHANNELS.PREPARE_ASSET_FOR_SESSION, [{ projectId: 'p1', assetId: 'a1', sessionId: 's1' }]],
      [() => api.importAgentImageToDesign({ projectId: 'p1', sessionId: 's1', localPath: '/x.png', position: { x: 0, y: 0 } }), DESIGN_IPC_CHANNELS.IMPORT_AGENT_IMAGE, [{ projectId: 'p1', sessionId: 's1', localPath: '/x.png', position: { x: 0, y: 0 } }]],
      [() => api.releaseDesignMediaAccess(), DESIGN_IPC_CHANNELS.RELEASE_MEDIA_ACCESS, []],
    ]
    for (const [call] of calls) await call()
    expect(recorded.invokes).toEqual(calls.map(([, channel, args]) => ({ channel, args })))
  })

  test('Given Electron invoke rejection 含内部信息 When preload 调用 LOAD Then 丢弃原始正文', async () => {
    const recorded = createRecordingIpc()
    /** 模拟 Electron 对主进程 reject 的包装异常。 */
    recorded.ipc.invoke = async () => {
      throw new Error(
        'Error invoking remote method canvas:load /Users/name 11111111-1111-4111-8111-111111111111',
      )
    }
    const api = createDesignPreloadApi(recorded.ipc)

    const result = await api.loadCanvasWorkspace({ projectId: 'p1', canvasId: 'canvas-1' })

    expect(result).toEqual({
      ok: false,
      error: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
    })
    expect(JSON.stringify(result)).not.toContain('remote method')
    expect(JSON.stringify(result)).not.toContain('/Users/name')
  })

  test('Given 内容节点通道 rejection When preload 调用 Then 每类操作返回固定公开错误', async () => {
    const recorded = createRecordingIpc()
    recorded.ipc.invoke = async () => {
      throw new Error(
        '/Users/private/.proma/canvases/canvas-1/nodes/content-1 '
        + 'trash/trash-1 transactions/intent.json apiKey=credential-secret',
      )
    }
    const api = createDesignPreloadApi(recorded.ipc)
    const target = { projectId: 'p1', canvasId: 'canvas-1' }

    /** 四类内容 lifecycle 调用的公开失败结果。 */
    const results = [
      await api.createCanvasContentNode({ ...target, operationId: '11111111-1111-4111-8111-111111111111', nodeId: 'node-1', kind: 'document', contentId: 'content-1', title: '文档', position: { x: 0, y: 0 }, expectedRevision: 0 }),
      await api.deleteCanvasNode({ ...target, operationId: '22222222-2222-4222-8222-222222222222', nodeId: 'node-1', expectedRevision: 1 }),
      await api.listCanvasTrash(target),
      await api.restoreCanvasNode({ ...target, operationId: '33333333-3333-4333-8333-333333333333', trashId: 'trash-1', expectedRevision: 2, position: { x: 1, y: 2 } }),
    ]

    expect(results).toEqual([
      { ok: false, error: { code: 'CANVAS_CREATE_FAILED', message: '节点创建失败，请重试。' } },
      { ok: false, error: { code: 'CANVAS_DELETE_FAILED', message: '节点删除失败，请重试。' } },
      { ok: false, error: { code: 'CANVAS_CONTENT_INVALID', message: '回收区暂时无法加载。' } },
      { ok: false, error: { code: 'CANVAS_RESTORE_FAILED', message: '节点恢复失败，请重试。' } },
    ])
    /** 聚合公开结果，集中检查所有内部信息均被错误封装丢弃。 */
    const serialized = JSON.stringify(results)
    /** 主进程异常中不得穿透 Preload 的内部字段与凭据片段。 */
    for (const internalValue of [
      '/Users/private', '.proma', 'nodes/content-1', 'trash/trash-1',
      'transactions', 'intent.json', 'apiKey', 'credential-secret',
    ]) {
      expect(serialized).not.toContain(internalValue)
    }
  })

  test('Given change 订阅 When 推送并取消 Then 使用同一个 listener 引用', () => {
    const recorded = createRecordingIpc()
    const api = createDesignPreloadApi(recorded.ipc)
    const received: unknown[] = []
    const release = api.onDesignChanged((change) => received.push(change))
    const change = { projectId: 'p1', revision: 2, cause: 'canvas' as const }
    recorded.added[0]?.listener({} as IpcRendererEvent, change)
    release()
    expect(received).toEqual([change])
    expect(recorded.removed[0]?.listener).toBe(recorded.added[0]?.listener)
  })

  test('Given 两类模型变化订阅 When 推送并取消 Then 隐藏 Electron event 且同引用解绑', () => {
    const recorded = createRecordingIpc()
    const api = createDesignPreloadApi(recorded.ipc)
    /** 收集 profile 无 payload 通知次数。 */
    let profileChanges = 0
    /** 收集项目选择业务事件。 */
    const selectionChanges: unknown[] = []
    const releaseProfiles = api.onImageModelProfilesChanged(() => { profileChanges += 1 })
    const releaseSelection = api.onImageModelSelectionChanged((event) => selectionChanges.push(event))
    recorded.added[0]?.listener({} as IpcRendererEvent, undefined)
    recorded.added[1]?.listener({} as IpcRendererEvent, { projectId: 'p1' })
    releaseProfiles()
    releaseSelection()

    expect(profileChanges).toBe(1)
    expect(selectionChanges).toEqual([{ projectId: 'p1' }])
    expect(recorded.removed[0]?.listener).toBe(recorded.added[0]?.listener)
    expect(recorded.removed[1]?.listener).toBe(recorded.added[1]?.listener)
  })

  test('Given Canvas 会话变化订阅 When 推送并取消 Then 只传业务事件且同引用解绑', () => {
    const recorded = createRecordingIpc()
    const api = createDesignPreloadApi(recorded.ipc)
    /** 收集 Renderer 实际收到的 Canvas 会话事件。 */
    const received: unknown[] = []
    const release = api.onCanvasSessionChanged((event) => received.push(event))
    /** 主进程成功提交后的公开变化事件。 */
    const change = { projectId: 'p1', canvasId: 'canvas-1', cause: 'created' as const }

    recorded.added[0]?.listener({} as IpcRendererEvent, change)
    release()

    expect(received).toEqual([change])
    expect(recorded.added[0]?.channel).toBe(DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED)
    expect(recorded.removed[0]?.listener).toBe(recorded.added[0]?.listener)
  })

  test('Given 原生 Canvas 文档变化订阅 When 推送并取消 Then 使用固定通道且同引用解绑', () => {
    const recorded = createRecordingIpc()
    const api = createDesignPreloadApi(recorded.ipc)
    /** 收集 Renderer 收到的原生 Canvas 事件。 */
    const received: unknown[] = []
    const release = api.onCanvasChanged((event) => received.push(event))
    /** 同时携带项目与 Canvas 身份的恢复事件。 */
    const change = {
      projectId: 'p1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' as const,
    }

    recorded.added[0]?.listener({} as IpcRendererEvent, change)
    release()

    expect(received).toEqual([change])
    expect(recorded.added[0]?.channel).toBe(CANVAS_IPC_CHANNELS.CHANGED)
    expect(recorded.removed[0]?.channel).toBe(CANVAS_IPC_CHANNELS.CHANGED)
    expect(recorded.removed[0]?.listener).toBe(recorded.added[0]?.listener)
  })
})
