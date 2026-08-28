import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument, createEmptyDesignDocument } from '@proma/shared'
import type {
  CanvasChangeEvent,
  CanvasImageModuleConfig,
  CanvasImageModuleSnapshot,
  DesignJobRecord,
  SaveDesignMutationsInput,
} from '@proma/shared'
import {
  CanvasPublicOperationError,
  createDesignAdapter,
  type PartialDesignApi,
} from './design-adapter'

describe('Design renderer adapter', () => {
  test('Given Canvas 生图 preload 成功 When adapter 调用全部方法 Then 解包结果并保留输入对象', async () => {
    /** preload 收到的调用参数，用于锁定 adapter 不改写业务命令。 */
    const received: unknown[] = []
    /** 图片模块身份。 */
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1',
    }
    /** 共享公开快照。 */
    const snapshot = {
      target,
      config: {
        schemaVersion: 2,
        kind: 'image',
        contentId: 'image-module-1',
        revision: 3,
        createdAt: 1,
        updatedAt: 2,
        prompt: '首页',
        selectedModelProfileId: 'profile-1',
        aspectRatio: '16:9',
        imageSize: '2K',
        contextMode: 'project',
        adoptedAssetId: null,
      },
      jobs: [],
      assets: [],
      assetBaseUrl: 'media://asset',
      thumbnailBaseUrl: 'media://thumbnail',
    } satisfies CanvasImageModuleSnapshot
    /** 保存后的配置。 */
    const config = { ...snapshot.config, revision: 4 } satisfies CanvasImageModuleConfig
    /** 任务操作返回的公开任务。 */
    const job = { id: 'job-1' } as DesignJobRecord
    const adapter = createDesignAdapter({
      loadCanvasImageModule: async (input) => { received.push(input); return { ok: true, value: snapshot as never } },
      saveCanvasImageModule: async (input) => { received.push(input); return { ok: true, value: config as never } },
      createCanvasImageJob: async (input) => { received.push(input); return { ok: true, value: job as never } },
      cancelCanvasImageJob: async (input) => { received.push(input); return { ok: true, value: job as never } },
      retryCanvasImageJob: async (input) => { received.push(input); return { ok: true, value: job as never } },
      adoptCanvasImageAsset: async (input) => { received.push(input); return { ok: true, value: config as never } },
      releaseCanvasImageMedia: async (input) => { received.push(input); return { ok: true, value: undefined } },
    })
    const saveInput = { ...target, expectedConfigRevision: 3, prompt: '首页', selectedModelProfileId: 'profile-1', aspectRatio: '16:9' as const, imageSize: '2K' as const, contextMode: 'project' as const }
    const createInput = { ...target, expectedConfigRevision: 3 }
    const jobInput = { ...target, jobId: 'job-1' }
    const adoptInput = { ...jobInput, assetId: 'asset-1', expectedConfigRevision: 4 }

    expect(await adapter.loadCanvasImageModule(target)).toBe(snapshot)
    expect(await adapter.saveCanvasImageModule(saveInput)).toBe(config)
    expect(await adapter.createCanvasImageJob(createInput)).toBe(job)
    expect(await adapter.cancelCanvasImageJob(jobInput)).toBe(job)
    expect(await adapter.retryCanvasImageJob(jobInput)).toBe(job)
    expect(await adapter.adoptCanvasImageAsset(adoptInput)).toBe(config)
    await expect(adapter.releaseCanvasImageMedia(target)).resolves.toBeUndefined()
    expect(received).toEqual([target, saveInput, createInput, jobInput, jobInput, adoptInput, target])
  })

  test('Given Canvas 生图失败 When adapter 解包 Then 保留公开冲突并净化缺失接线与 rejection', async () => {
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1',
    }
    const missing = createDesignAdapter({})
    await expect(missing.loadCanvasImageModule(target)).rejects.toMatchObject({
      code: 'CANVAS_IMAGE_LOAD_FAILED', message: '生图节点暂时无法加载。',
    })
    await expect(missing.saveCanvasImageModule({
      ...target, expectedConfigRevision: 1, prompt: '', selectedModelProfileId: null,
      aspectRatio: '1:1', imageSize: 'auto', contextMode: 'auto',
    })).rejects.toMatchObject({
      code: 'CANVAS_IMAGE_SAVE_FAILED', message: '生图配置保存失败，请重试。',
    })
    const rejected = createDesignAdapter({
      retryCanvasImageJob: async () => { throw new Error('canvas:retry-image-job /Users/private UUID=internal') },
    })
    const rejectedPromise = rejected.retryCanvasImageJob({ ...target, jobId: 'job-1' })
    await expect(rejectedPromise).rejects.toMatchObject({
      code: 'CANVAS_IMAGE_JOB_FAILED', message: '图片任务操作失败，请重试。',
    })
    await expect(rejectedPromise).rejects.not.toThrow('/Users/private')
    const conflicted = createDesignAdapter({
      adoptCanvasImageAsset: async () => ({
        ok: false,
        error: { code: 'CANVAS_IMAGE_REVISION_CONFLICT', message: '配置已在其他窗口更新。' },
      }),
    })
    await expect(conflicted.adoptCanvasImageAsset({
      ...target, jobId: 'job-1', assetId: 'asset-1', expectedConfigRevision: 2,
    })).rejects.toMatchObject({
      code: 'CANVAS_IMAGE_REVISION_CONFLICT', message: '配置已在其他窗口更新。',
    })
  })

  test('Given 完整目标的图片变化 When adapter 订阅 Then 只传目标一致事件且取消保持幂等', () => {
    /** 捕获每个 preload 图片事件监听器。 */
    const sourceListeners: Array<(event: typeof target) => void> = []
    /** preload 层释放调用次数。 */
    let releaseCalls = 0
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-image', imageModuleId: 'image-module-1',
    }
    const adapter = createDesignAdapter({
      onCanvasImageModuleChanged: (listener) => {
        sourceListeners.push(listener)
        return () => { releaseCalls += 1 }
      },
    })
    /** 两个业务订阅必须互不影响。 */
    const receivedA: unknown[] = []
    const receivedB: unknown[] = []
    const releaseA = adapter.onCanvasImageModuleChanged(target, (event) => receivedA.push(event))
    const releaseB = adapter.onCanvasImageModuleChanged(target, (event) => receivedB.push(event))
    const events = [
      { ...target, projectId: 'project-2' },
      { ...target, canvasId: 'canvas-2' },
      { ...target, nodeId: 'node-other' },
      { ...target, imageModuleId: 'image-module-2' },
      target,
    ]
    for (const event of events) {
      sourceListeners[0]?.(event)
      sourceListeners[1]?.(event)
    }
    releaseA()
    releaseA()
    releaseB()

    expect(receivedA).toEqual([target])
    expect(receivedB).toEqual([target])
    expect(releaseCalls).toBe(2)
  })

  test('Given 原生 Canvas preload 缺失或异常拒绝 When adapter 调用 Then 只返回当前操作公开错误', async () => {
    const missing = createDesignAdapter({})
    await expect(Promise.resolve().then(() => missing.loadCanvas({
      projectId: 'project-1', canvasId: 'canvas-1',
    }))).rejects.toMatchObject({
      name: 'CanvasPublicOperationError',
      code: 'CANVAS_LOAD_FAILED',
      message: '画布暂时无法加载。',
    })

    /** preload 抛出的原始错误对象。 */
    const originalError = new Error('CANVAS_COMMIT_UNCERTAIN: main durability requires reload')
    const failed = createDesignAdapter({
      saveCanvasMutations: async () => { throw originalError },
    })
    await expect(failed.saveCanvas({
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 1, mutations: [],
    })).rejects.toMatchObject({
      name: 'CanvasPublicOperationError',
      code: 'CANVAS_SAVE_FAILED',
      message: '画布暂时无法保存。',
    })
  })

  test('Given Adapter 收到公开失败 When 调用 LOAD Then 只抛公开码和文案', async () => {
    const adapter = createDesignAdapter({
      loadCanvasWorkspace: async () => ({
        ok: false,
        error: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
      }),
    })

    const promise = adapter.loadCanvas({ projectId: 'project-1', canvasId: 'canvas-1' })

    await expect(promise).rejects.toBeInstanceOf(CanvasPublicOperationError)
    await expect(promise).rejects.toMatchObject({
      name: 'CanvasPublicOperationError',
      code: 'CANVAS_LOAD_FAILED',
      message: '画布暂时无法加载。',
    })
  })

  test('Given 原生 Canvas API When 加载和保存 Then 参数与返回值保持同一引用', async () => {
    /** preload 收到的输入引用。 */
    const received: unknown[] = []
    /** preload 返回的公开快照。 */
    const snapshot = {
      document: createEmptyCanvasDocument('project-1', 'canvas-1', 1),
      writable: true as const,
      nodeIssues: [],
    }
    const api: PartialDesignApi = {
      loadCanvasWorkspace: async (input) => { received.push(input); return { ok: true, value: snapshot } },
      saveCanvasMutations: async (input) => { received.push(input); return { ok: true, value: snapshot.document } },
      createCanvasContentNode: async (input) => { received.push(input); return { ok: true, value: { snapshot, selectedNodeId: 'node-content' } } },
      deleteCanvasNode: async (input) => { received.push(input); return { ok: true, value: { snapshot } } },
      listCanvasTrash: async (input) => { received.push(input); return { ok: true, value: [] } },
      restoreCanvasNode: async (input) => { received.push(input); return { ok: true, value: { snapshot, selectedNodeId: 'node-content' } } },
      createCanvasAgentNode: async (input) => {
        received.push(input)
        return {
          ok: true,
          value: { document: snapshot.document, session: { id: 'session-1' } as never },
        }
      },
      rebuildCanvasAgentNode: async (input) => {
        received.push(input)
        return {
          ok: true,
          value: { snapshot, session: { id: 'session-2' } as never },
        }
      },
      getCanvasAgentMessages: async (input) => {
        received.push(input)
        return {
          ok: true,
          value: {
            sessionId: 'session-1',
            owner: {
              projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', title: 'Agent',
            },
            messages: [],
          },
        }
      },
      sendCanvasAgentMessage: async (input) => {
        received.push(input)
        return { ok: true, value: { ok: true } }
      },
      stopCanvasAgent: async (input) => { received.push(input); return { ok: true, value: undefined } },
    }
    const adapter = createDesignAdapter(api)
    const loadInput = { projectId: 'project-1', canvasId: 'canvas-1' }
    const saveInput = { ...loadInput, expectedRevision: 0, mutations: [] }
    const createInput = {
      ...loadInput,
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
    }
    const agentTarget = { ...loadInput, nodeId: 'node-1' }
    const contentCreateInput = { ...loadInput, operationId: '33333333-3333-4333-8333-333333333333', nodeId: 'node-content', kind: 'document' as const, contentId: 'content-1', title: '文档', position: { x: 0, y: 0 }, expectedRevision: 0 }
    const deleteInput = { ...loadInput, operationId: '44444444-4444-4444-8444-444444444444', nodeId: 'node-content', expectedRevision: 1 }
    const restoreInput = { ...loadInput, operationId: '55555555-5555-4555-8555-555555555555', trashId: 'trash-1', expectedRevision: 2, position: { x: 1, y: 2 } }
    const rebuildInput = {
      ...agentTarget,
      operationId: '22222222-2222-4222-8222-222222222222',
    }
    const sendInput = { ...agentTarget, message: '继续', userMessageUuid: 'message-1', startedAt: 10 }

    expect(await adapter.loadCanvas(loadInput)).toBe(snapshot)
    expect(await adapter.saveCanvas(saveInput)).toBe(snapshot.document)
    expect((await adapter.createCanvasContentNode(contentCreateInput)).selectedNodeId).toBe('node-content')
    await adapter.deleteCanvasNode(deleteInput)
    expect(await adapter.listCanvasTrash(loadInput)).toEqual([])
    expect((await adapter.restoreCanvasNode(restoreInput)).selectedNodeId).toBe('node-content')
    expect((await adapter.createCanvasAgentNode(createInput)).document).toBe(snapshot.document)
    expect((await adapter.rebuildCanvasAgentNode(rebuildInput)).snapshot).toBe(snapshot)
    expect((await adapter.getCanvasAgentMessages(agentTarget)).sessionId).toBe('session-1')
    await adapter.sendCanvasAgentMessage(sendInput)
    await adapter.stopCanvasAgent(agentTarget)
    expect(received).toEqual([
      loadInput, saveInput, contentCreateInput, deleteInput, loadInput, restoreInput,
      createInput, rebuildInput, agentTarget, sendInput, agentTarget,
    ])
    expect(received[0]).toBe(loadInput)
    expect(received[1]).toBe(saveInput)
    expect(received[2]).toBe(contentCreateInput)
    expect(received[5]).toBe(restoreInput)
  })

  test('Given 内容节点 bridge 缺失或 rejection When adapter 调用 Then 隐藏内部正文并按操作返回稳定错误', async () => {
    const missing = createDesignAdapter({})
    await expect(missing.deleteCanvasNode({ projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', operationId: '11111111-1111-4111-8111-111111111111', expectedRevision: 0 })).rejects.toMatchObject({ code: 'CANVAS_DELETE_FAILED', message: '节点删除失败，请重试。' })
    const failed = createDesignAdapter({
      restoreCanvasNode: async () => { throw new Error('/private/path/CANVAS_INTERNAL') },
    })
    await expect(failed.restoreCanvasNode({ projectId: 'project-1', canvasId: 'canvas-1', operationId: '22222222-2222-4222-8222-222222222222', trashId: 'trash-1', expectedRevision: 0, position: { x: 0, y: 0 } })).rejects.toMatchObject({ code: 'CANVAS_RESTORE_FAILED', message: '节点恢复失败，请重试。' })
  })

  test('Given 多个 Canvas 事件 When 订阅目标 B Then recovery 和 graph 都只按双身份隔离', () => {
    /** 捕获 preload 层注册的未过滤 listener。 */
    let sourceListener: ((event: CanvasChangeEvent) => void) | undefined
    /** preload 释放函数必须由 adapter 原样返回。 */
    const release = (): void => undefined
    const adapter = createDesignAdapter({
      onCanvasChanged: (listener) => { sourceListener = listener; return release },
    })
    /** 目标 B 实际收到的事件。 */
    const received: CanvasChangeEvent[] = []
    const returnedRelease = adapter.onCanvasChanged(
      { projectId: 'project-1', canvasId: 'canvas-b' },
      (event) => received.push(event),
    )
    const events: CanvasChangeEvent[] = [
      { projectId: 'project-1', canvasId: 'canvas-a', revision: 9, cause: 'graph' },
      { projectId: 'project-1', canvasId: 'canvas-a', revision: 1, cause: 'recovery' },
      { projectId: 'project-2', canvasId: 'canvas-b', revision: 10, cause: 'graph' },
      { projectId: 'project-1', canvasId: 'canvas-b', revision: 2, cause: 'recovery' },
      { projectId: 'project-1', canvasId: 'canvas-b', revision: 3, cause: 'graph' },
    ]
    for (const event of events) sourceListener?.(event)

    expect(returnedRelease).toBe(release)
    expect(received).toEqual(events.slice(3))
  })

  test('Given preload 拒绝加载 When adapter 调用 Then 保留稳定错误供 UI 展示', async () => {
    const adapter = createDesignAdapter({
      loadDesignWorkspace: async () => { throw new Error('项目离线，只能查看缓存') },
    } as PartialDesignApi)
    await expect(adapter.load('project-1')).rejects.toThrow('项目离线，只能查看缓存')
  })

  test('Given 注入完整 preload API When 调用 Then adapter 不改写参数与返回值', async () => {
    const document = createEmptyDesignDocument('project-1', 10)
    const snapshot = { document, writable: true }
    /** preload 实际收到的保存参数。 */
    let receivedInput: SaveDesignMutationsInput | undefined
    /** 模型 API 收到的原始参数，验证 adapter 不做业务改写。 */
    const modelInputs: unknown[] = []
    /** 上下文 API 收到的原始参数，验证 adapter 不做路径或元数据改写。 */
    const contextInputs: unknown[] = []
    /** Canvas 会话 API 收到的原始参数。 */
    const canvasInputs: unknown[] = []
    /** Canvas 会话公开返回值，不包含存储路径和内部形态。 */
    const canvasSession = {
      id: 'canvas-1',
      projectId: 'project-1',
      title: '页面设计',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    }
    /** 公开模型目录返回对象。 */
    const catalog = { profiles: [], channelOptions: [], inheritedFromLegacyConfig: false, credentialsConfigured: true }
    /** 项目模型选择返回对象。 */
    const selection = { projectId: 'project-1', options: [], selectedProfileId: 'profile-flash' }
    /** 任务详情和展开后的 trace 返回对象。 */
    const taskDetails = { creativeTaskId: 'creative-1', currentJobId: 'job-1', attempts: [], traceState: 'ready' as const }
    const taskTrace = { ...taskDetails, trace: [] }
    /** 两类订阅释放函数必须原样返回。 */
    const releaseProfiles = (): void => undefined
    const releaseSelection = (): void => undefined
    const releaseCanvas = (): void => undefined
    const api: PartialDesignApi = {
      listCanvasSessions: async (input) => { canvasInputs.push(input); return [canvasSession] },
      createCanvasSession: async (input) => { canvasInputs.push(input); return canvasSession },
      updateCanvasSession: async (input) => { canvasInputs.push(input); return canvasSession },
      onCanvasSessionChanged: () => releaseCanvas,
      listImageModelProfiles: async () => catalog,
      saveImageModelProfiles: async (input) => { modelInputs.push(input); return catalog },
      getImageModelSelection: async (projectId) => { modelInputs.push(projectId); return selection },
      setImageModelSelection: async (input) => { modelInputs.push(input); return selection },
      onImageModelProfilesChanged: () => releaseProfiles,
      onImageModelSelectionChanged: () => releaseSelection,
      loadDesignWorkspace: async () => snapshot,
      saveDesignMutations: async (input) => { receivedInput = input; return document },
      releaseDesignMediaAccess: async () => undefined,
      onDesignChanged: () => () => undefined,
      getDesignTaskDetails: async () => taskDetails,
      getDesignTaskTrace: async () => taskTrace,
      listDesignContext: async (input) => { contextInputs.push(input); return [] },
      upsertDesignContextDocument: async (input) => { contextInputs.push(input); return {} as never },
      importDesignContextDocument: async (input) => { contextInputs.push(input); return undefined },
      updateDesignContext: async (input) => { contextInputs.push(input); return {} as never },
      registerDesignContextAsset: async (input) => { contextInputs.push(input); return {} as never },
      deleteDesignContext: async (input) => { contextInputs.push(input) },
    }
    const adapter = createDesignAdapter(api)
    expect(await adapter.load('project-1')).toBe(snapshot)
    const input = { projectId: 'project-1', expectedRevision: 1, mutations: [] }
    expect(await adapter.save(input)).toBe(document)
    expect(receivedInput).toBe(input)
    /** 保存输入与选择输入使用同一对象引用透传。 */
    const saveProfilesInput = { profiles: [] }
    const setSelectionInput = { projectId: 'project-1', imageModelProfileId: 'profile-flash' }
    expect(await adapter.listImageModelProfiles()).toBe(catalog)
    expect(await adapter.saveImageModelProfiles(saveProfilesInput)).toBe(catalog)
    expect(await adapter.getImageModelSelection('project-1')).toBe(selection)
    expect(await adapter.setImageModelSelection(setSelectionInput)).toBe(selection)
    const taskInput = { projectId: 'project-1', jobId: 'job-1' }
    expect(await adapter.getTaskDetails(taskInput)).toBe(taskDetails)
    expect(await adapter.getTaskTrace(taskInput)).toBe(taskTrace)
    expect(modelInputs).toEqual([saveProfilesInput, 'project-1', setSelectionInput])
    /** 三个 Canvas 方法必须保留调用方对象身份。 */
    const listCanvasInput = { projectId: 'project-1', archived: false }
    const createCanvasInput = { projectId: 'project-1', title: '页面设计' }
    const updateCanvasInput = { projectId: 'project-1', canvasId: 'canvas-1', archived: true }
    expect(await adapter.listCanvasSessions(listCanvasInput)).toEqual([canvasSession])
    expect(await adapter.createCanvasSession(createCanvasInput)).toBe(canvasSession)
    expect(await adapter.updateCanvasSession(updateCanvasInput)).toBe(canvasSession)
    expect(canvasInputs).toEqual([listCanvasInput, createCanvasInput, updateCanvasInput])
    /** 六个上下文方法必须保留调用方对象身份。 */
    const listContextInput = { projectId: 'project-1', query: 'brand' }
    const upsertContextInput = { projectId: 'project-1', category: 'brand' as const, title: '品牌', tags: [], markdown: '# Brand' }
    const importContextInput = { projectId: 'project-1', category: 'brand' as const, tags: [] }
    const updateContextInput = { projectId: 'project-1', entryId: 'context-1', category: 'brand' as const, title: '品牌', tags: [] }
    const registerContextInput = { projectId: 'project-1', assetId: 'asset-1', category: 'reference' as const, title: '参考', tags: [] }
    const deleteContextInput = { projectId: 'project-1', entryId: 'context-1' }
    await adapter.listContext(listContextInput)
    await adapter.upsertContextDocument(upsertContextInput)
    await adapter.importContextDocument(importContextInput)
    await adapter.updateContext(updateContextInput)
    await adapter.registerContextAsset(registerContextInput)
    await adapter.deleteContext(deleteContextInput)
    expect(contextInputs).toEqual([
      listContextInput, upsertContextInput, importContextInput,
      updateContextInput, registerContextInput, deleteContextInput,
    ])
    expect(adapter.onImageModelProfilesChanged(() => undefined)).toBe(releaseProfiles)
    expect(adapter.onImageModelSelectionChanged(() => undefined)).toBe(releaseSelection)
    expect(adapter.onCanvasSessionChanged(() => undefined)).toBe(releaseCanvas)
    await expect(adapter.releaseMediaAccess()).resolves.toBeUndefined()
  })
})
