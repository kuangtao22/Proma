import { describe, expect, spyOn, test } from 'bun:test'
import { CANVAS_IPC_CHANNELS, createEmptyCanvasDocument } from '@proma/shared'
import type {
  AgentSessionMeta,
  CanvasAgentNodeCreationResult,
  CanvasDocument,
  CanvasInvokeResult,
  CanvasMutation,
  CanvasNodeLifecycleResult,
  CanvasTrashEntry,
  CanvasWorkspaceSnapshot,
  CanvasImageModuleConfig,
  CanvasImageModuleSnapshot,
  CanvasImageTarget,
  CreateDesignJobInput,
  DesignAsset,
  DesignJobRecord,
  SaveCanvasImageModuleInput,
  RebuildCanvasAgentNodeResult,
  SDKMessage,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { parseCanvasDocument } from './canvas-document-store'
import { createCanvasOperationSerializer, getCanvasToolProviderRuntime, registerCanvasDocumentIpcHandlers } from './canvas-document-ipc'

/** 测试 IPC handler 的最小签名。 */
type TestHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 可记录公开广播的测试窗口。 */
interface TestWebContents extends WebContents {
  sent: Array<{ channel: string; value: unknown }>
  destroyForTest: () => void
}

/** 创建固定 ID 且可记录广播的窗口。 */
function createSender(id: number): TestWebContents {
  /** 当前窗口收到的全部公开事件。 */
  const sent: Array<{ channel: string; value: unknown }> = []
  /** Electron destroyed 监听器集合。 */
  const destroyedListeners = new Set<() => void>()
  /** 模拟 Electron WebContents 销毁后的权威状态。 */
  let destroyed = false
  return {
    id,
    sent,
    isDestroyed: () => destroyed,
    send: (channel: string, value: unknown) => { sent.push({ channel, value }) },
    once: (event: string, listener: () => void) => {
      if (event === 'destroyed') destroyedListeners.add(listener)
    },
    removeListener: (event: string, listener: () => void) => {
      if (event === 'destroyed') destroyedListeners.delete(listener)
    },
    destroyForTest: () => {
      destroyed = true
      for (const listener of [...destroyedListeners]) listener()
      destroyedListeners.clear()
    },
  } as unknown as TestWebContents
}

/** 创建可由测试显式完成的 Promise。 */
function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return {
    promise,
    resolve: (value) => {
      if (!resolvePromise) throw new Error('deferred 未初始化')
      resolvePromise(value)
    },
  }
}

/** 测试图片模块的完整身份。 */
const imageTargetA: CanvasImageTarget = {
  projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'image-node-a', imageModuleId: 'module-a',
}
/** 另一个图片模块身份，用于验证跨目标访问失败。 */
const imageTargetB: CanvasImageTarget = {
  projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'image-node-b', imageModuleId: 'module-b',
}

/** 创建指定模块 revision 的图片配置。 */
function createImageConfig(target: CanvasImageTarget, revision = 3): CanvasImageModuleConfig {
  return {
    schemaVersion: 2, kind: 'image', contentId: target.imageModuleId, revision,
    createdAt: 1, updatedAt: 2, prompt: '生成首页主视觉', selectedModelProfileId: 'profile-1',
    aspectRatio: '16:9', imageSize: '2K', contextMode: 'project', adoptedAssetId: 'asset-a',
  }
}

/** 创建归属指定图片模块的任务。 */
function createImageJob(target: CanvasImageTarget, id: string, outputAssetId = 'asset-a'): DesignJobRecord {
  return {
    id, creativeTaskId: `creative-${id}`, attemptNumber: 1, projectId: target.projectId,
    target: { kind: 'canvas-image', canvasId: target.canvasId, nodeId: target.nodeId, imageModuleId: target.imageModuleId },
    action: 'generate', status: 'succeeded', prompt: '生成首页主视觉', originalRequest: '生成首页主视觉',
    contextMode: 'project', outputAssetId, createdAt: 1, updatedAt: 2,
  }
}

/** 创建由指定任务产出的 Design 素材。 */
function createImageAsset(id: string, sourceJobId?: string, parentAssetId?: string): DesignAsset {
  return {
    id, filename: `${id}.png`, relativePath: `assets/${id}.png`,
    thumbnailRelativePath: `thumbnails/${id}.webp`, mediaType: 'image/png',
    width: 100, height: 100, byteSize: 100, sha256: 'a'.repeat(64), createdAt: 2,
    ...(sourceJobId ? { sourceJobId } : {}),
    ...(parentAssetId ? { parentAssetId } : {}),
  }
}

/** 创建指定目标与 revision 的完整图片配置保存命令。 */
function createImageSaveInput(
  target: CanvasImageTarget,
  expectedConfigRevision: number,
): SaveCanvasImageModuleInput {
  return {
    ...target,
    expectedConfigRevision,
    prompt: '更新后的主视觉',
    selectedModelProfileId: 'profile-1',
    aspectRatio: '16:9',
    imageSize: '2K',
    contextMode: 'project',
  }
}

/** 调用指定 invoke handler。 */
function invoke(
  handlers: Map<string, TestHandler>,
  channel: string,
  sender: WebContents,
  input: unknown,
): Promise<unknown> {
  /** 测试目标通道必须已注册。 */
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler 未注册: ${channel}`)
  return Promise.resolve().then(() => handler({ sender } as IpcMainInvokeEvent, input))
}

/** 创建指定 revision 的原生 Canvas 文档。 */
function createDocument(revision: number): CanvasDocument {
  return { ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision }
}

/** 创建主进程 IPC 测试上下文。 */
function createContext(options: {
  authorized?: TestWebContents[]
  readOnlyReason?: string
  loadResult?: CanvasWorkspaceSnapshot
  mutateResult?: CanvasDocument
  guardError?: Error
  loadError?: Error
  mutateError?: Error
  reconcileError?: Error
  createError?: Error
  createPublication?: CanvasDocument
  reconcileResult?: {
    snapshot: CanvasWorkspaceSnapshot
    documentChanged: boolean
    error?: Error
  }
  retryReconcileResult?: {
    snapshot: CanvasWorkspaceSnapshot
    documentChanged: boolean
    error?: Error
  }
  beforeCreate?: (input: { projectId: string; canvasId: string }) => Promise<void>
  createErrorOnce?: Error
  createDocumentChanged?: boolean
  rebuildError?: Error
  reserveStartError?: Error
  activeRunSnapshot?: {
    owners: Array<{
      sessionId: string
      projectId: string
      canvasId: string
      nodeId: string
      title: string
      startedAt?: number
    }>
    internalInvalidRuns: Array<{ sessionId: string; startedAt: number; valid: false }>
  }
  contentOperationError?: Error
  contentOperationPublication?: CanvasDocument
  contentReconciliationPublication?: CanvasDocument
  contentResultFactory?: (selectedNodeId?: string) => CanvasNodeLifecycleResult
  contentTrashResult?: CanvasTrashEntry[]
  imageConfig?: CanvasImageModuleConfig
  imageJobs?: DesignJobRecord[]
  imageAssets?: DesignAsset[]
  imageLoadError?: Error
  mediaAccessErrorAt?: number
  imageLoad?: (target: CanvasImageTarget) => Promise<CanvasImageModuleConfig>
  imageSave?: (input: SaveCanvasImageModuleInput) => Promise<CanvasImageModuleConfig>
  imageJobsList?: (projectId: string) => DesignJobRecord[]
  imageTargetAssert?: (projectId: string, target: Omit<CanvasImageTarget, 'projectId'>) => Promise<void>
  imageCreateOnce?: (input: CreateDesignJobInput, jobId: string) => Promise<{ job: DesignJobRecord; created: boolean }>
  batchReconcile?: () => Promise<void>
  batchReconcileError?: Error
  batchPublications?: CanvasDocument[]
  enableToolProviderRuntime?: boolean
} = {}) {
  /** 当前注册的 invoke handler。 */
  const handlers = new Map<string, TestHandler>()
  /** handler 移除记录，用于锁定热注册与幂等 dispose。 */
  const removed: string[] = []
  /** 默认授权主窗口。 */
  const sender = createSender(1)
  /** 记录广播发生时 workspace lease 是否仍被持有。 */
  const broadcastLeaseStates: boolean[] = []
  /** 当前测试调用是否位于 workspace write lease 内。 */
  let leaseHeld = false
  /** 包装所有测试授权窗口，观察多窗口广播是否位于 lease 释放后。 */
  for (const contents of new Set([sender, ...(options.authorized ?? [])])) {
    const send = contents.send
    contents.send = (channel, value) => {
      broadcastLeaseStates.push(leaseHeld)
      send(channel, value)
    }
  }
  /** 按执行顺序记录只读、guard 和 store 边界。 */
  const calls: string[] = []
  /** Store 收到的重建参数。 */
  const storeInputs: unknown[] = []
  /** 创建调用次数用于模拟首次 committed 写失败后的同 operation 重试。 */
  let createAttempts = 0
  /** Canvas Agent 专用 IPC 调用记录。 */
  const agentCalls: Array<{ type: string; value: unknown }> = []
  /** 图片模块服务调用记录。 */
  const imageCalls: Array<{ type: string; value: unknown }> = []
  /** 媒体 lease 释放次数，按候选创建顺序记录。 */
  const mediaReleases: number[] = []
  /** 媒体候选创建序号。 */
  let mediaAccessCount = 0
  /** 普通 Agent 节点运行的进程内测试 journal；生产事实由 DesignJobManager 磁盘 journal 提供。 */
  const agentImageJobs = new Map<string, DesignJobRecord>()
  /** 权威 Canvas 会话元数据。 */
  const agentSession: AgentSessionMeta = {
    id: '22222222-2222-4222-8222-222222222222', title: '首页 Agent',
    channelId: 'channel-1', modelId: 'model-1', workspaceId: 'project-1',
    sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1',
    createdAt: 1, updatedAt: 1,
  }
  const registration = registerCanvasDocumentIpcHandlers({
    ipc: {
      handle: (channel, handler) => { handlers.set(channel, handler) },
      removeHandler: (channel) => { removed.push(channel); handlers.delete(channel) },
    },
    listAuthorizedWebContents: () => options.authorized ?? [sender],
    guard: {
      runWorkspaceWrite: (projectId, effect) => {
        calls.push(`guard:${projectId}`)
        if (options.guardError) throw options.guardError
        leaseHeld = true
        try {
          const result = effect()
          if (result instanceof Promise) {
            return result.finally(() => { leaseHeld = false }) as ReturnType<typeof effect>
          }
          leaseHeld = false
          return result
        } catch (error) {
          leaseHeld = false
          throw error
        }
      },
    },
    store: {
      loadWithDirectoryCapability: () => { throw new Error('测试未配置目录读取') },
      load: (target) => {
        calls.push('store:load')
        storeInputs.push(target)
        if (options.loadError) throw options.loadError
        return options.loadResult ?? { document: createDocument(4), writable: true, nodeIssues: [] }
      },
      mutate: (target, expectedRevision, mutations) => {
        calls.push('store:mutate')
        storeInputs.push({ target, expectedRevision, mutations })
        if (options.mutateError) throw options.mutateError
        return options.mutateResult ?? createDocument(expectedRevision + (mutations.length > 0 ? 1 : 0))
      },
      validateBatchOperations: (_target, _expectedRevision, operations) => structuredClone(operations) as CanvasMutation[],
    },
    batch: {
      ...(options.enableToolProviderRuntime ? {
        execute: async () => ({ document: createDocument(4), operationId: 'tool-provider-operation' }),
      } : {}),
      reconcileLocked: async () => {
        calls.push('batch:reconcile')
        await options.batchReconcile?.()
        if (options.batchReconcileError) throw options.batchReconcileError
        return {
          document: options.loadResult?.document ?? createDocument(4),
          operationId: '',
          publications: options.batchPublications ?? [],
        }
      },
    },
    creation: {
      reconcile: async (target) => {
        calls.push('creation:reconcile')
        storeInputs.push(target)
        if (options.reconcileError ?? options.loadError) throw options.reconcileError ?? options.loadError
        return options.reconcileResult ?? {
          snapshot: options.loadResult ?? { document: createDocument(4), writable: true, nodeIssues: [] },
          documentChanged: false,
        }
      },
      createReconciled: async (input) => {
        calls.push('creation:create')
        storeInputs.push(input)
        createAttempts += 1
        await options.beforeCreate?.(input)
        const reconciliation = (createAttempts > 1 ? options.retryReconcileResult : undefined)
          ?? options.reconcileResult ?? {
          snapshot: options.loadResult ?? { document: createDocument(4), writable: true, nodeIssues: [] },
          documentChanged: false,
        }
        const createError = options.createError
          ?? (createAttempts === 1 ? options.createErrorOnce : undefined)
        if (createError) {
          return {
            reconciliation,
            operationOutcome: {
              ok: false as const,
              error: createError,
              ...(options.createPublication ? { publication: options.createPublication } : {}),
            },
          }
        }
        const document = createDocument(5)
        document.nodes = [{
          id: input.nodeId,
          kind: 'agent',
          title: input.title,
          position: input.position,
          agentSessionId: '22222222-2222-4222-8222-222222222222',
        }]
        return {
          reconciliation,
          operationOutcome: {
            ok: true as const,
            value: {
              document,
              session: {
                id: '22222222-2222-4222-8222-222222222222',
                title: input.title,
                createdAt: 1,
                updatedAt: 1,
              },
              documentChanged: options.createDocumentChanged ?? true,
            },
          },
        }
      },
      rebuildReconciled: async (input) => {
        calls.push('creation:rebuild')
        storeInputs.push(input)
        if (options.rebuildError) throw options.rebuildError
        const document = createDocument(5)
        document.nodes = [{
          id: input.nodeId,
          kind: 'agent',
          title: '首页 Agent',
          position: { x: 10, y: 20 },
          agentSessionId: '44444444-4444-4444-8444-444444444444',
        }]
        return {
          snapshot: { document, writable: true, nodeIssues: [] },
          session: {
            id: '44444444-4444-4444-8444-444444444444',
            title: '首页 Agent',
            createdAt: 2,
            updatedAt: 2,
          },
          documentChanged: true,
        }
      },
    },
    contentLifecycle: {
      load: async () => {
        calls.push('content:load')
        return { snapshot: options.loadResult ?? { document: createDocument(4), writable: true as const, nodeIssues: [] }, documentChanged: false }
      },
      createReconciled: async (input) => {
        calls.push('content:create')
        storeInputs.push(input)
        return createContentOutcome(input.nodeId)
      },
      deleteReconciled: async (input) => {
        calls.push('content:delete')
        storeInputs.push(input)
        return createContentOutcome()
      },
      listTrashReconciled: async (input) => {
        calls.push('content:list-trash')
        storeInputs.push(input)
        return {
          reconciliation: {
            snapshot: options.loadResult ?? { document: createDocument(4), writable: true as const, nodeIssues: [] },
            documentChanged: false,
          },
          operationOutcome: { ok: true as const, value: options.contentTrashResult ?? [] },
        }
      },
      restoreReconciled: async (input) => {
        calls.push('content:restore')
        storeInputs.push(input)
        return createContentOutcome('node-restored')
      },
    },
    imageModules: {
      load: async (target) => {
        imageCalls.push({ type: 'load', value: target })
        if (options.imageLoadError) throw options.imageLoadError
        if (options.imageLoad) return options.imageLoad(target)
        return options.imageConfig ?? createImageConfig(target)
      },
      save: async (input) => {
        imageCalls.push({ type: 'save', value: input })
        if (options.imageSave) return options.imageSave(input)
        return { ...(options.imageConfig ?? createImageConfig(input)), revision: input.expectedConfigRevision + 1 }
      },
    },
    imageJobs: {
      createCanvasImage: async (input) => {
        imageCalls.push({ type: 'create', value: input })
        return createImageJob(imageTargetA, 'job-created')
      },
      createCanvasImageOnce: async (input, jobId) => {
        if (options.imageCreateOnce) return options.imageCreateOnce(input, jobId)
        const existing = agentImageJobs.get(jobId)
        if (existing) return { job: existing, created: false }
        if (input.target?.kind !== 'canvas-image') throw new Error('Canvas 图片任务目标无效')
        const job = createImageJob({ projectId: input.projectId, ...input.target }, jobId)
        agentImageJobs.set(jobId, job)
        imageCalls.push({ type: 'create-once', value: { input, jobId } })
        return { job, created: true }
      },
      run: async (jobId) => { imageCalls.push({ type: 'run', value: jobId }) },
      cancel: async (projectId, jobId) => {
        imageCalls.push({ type: 'cancel', value: { projectId, jobId } })
        return (options.imageJobs ?? [createImageJob(imageTargetA, 'job-a')]).find((job) => job.id === jobId)
          ?? createImageJob(imageTargetA, jobId)
      },
      retry: (projectId, jobId) => {
        imageCalls.push({ type: 'retry', value: { projectId, jobId } })
        return createImageJob(imageTargetA, 'job-retry')
      },
      getProjectJob: (projectId, jobId) => (
        options.imageJobsList?.(projectId)
          ?? options.imageJobs ?? [createImageJob(imageTargetA, 'job-a')]
      ).find((job) => job.projectId === projectId && job.id === jobId),
      listCanvasImageJobs: (target) => (
        options.imageJobsList?.(target.projectId)
          ?? options.imageJobs ?? [createImageJob(imageTargetA, 'job-a')]
      ).filter((job) => job.target?.kind === 'canvas-image'
        && job.projectId === target.projectId
        && job.target.canvasId === target.canvasId
        && job.target.nodeId === target.nodeId
        && job.target.imageModuleId === target.imageModuleId),
      onChanged: () => () => undefined,
    },
    imageJobTarget: {
      assertTarget: async (projectId, target) => {
        imageCalls.push({ type: 'assert-target', value: { projectId, target } })
        await options.imageTargetAssert?.(projectId, target)
      },
      adoptOutput: async (projectId, target, assetId) => {
        imageCalls.push({ type: 'adopt', value: { projectId, target, assetId } })
      },
    },
    imageAssets: {
      list: () => options.imageAssets ?? [createImageAsset('asset-a', 'job-a')],
      createMediaAccess: () => {
        const index = mediaAccessCount
        mediaAccessCount += 1
        if (options.mediaAccessErrorAt === index) throw new Error('媒体授权失败')
        return {
          assetBaseUrl: `proma-file://assets-${index}`,
          thumbnailBaseUrl: `proma-file://thumbnails-${index}`,
          release: () => { mediaReleases[index] = (mediaReleases[index] ?? 0) + 1 },
        }
      },
    },
    agent: {
      listActiveRuns: () => options.activeRunSnapshot ?? { owners: [], internalInvalidRuns: [] },
      getSession: (sessionId) => sessionId === agentSession.id ? agentSession : undefined,
      getMessages: (sessionId) => {
        agentCalls.push({ type: 'messages', value: sessionId })
        return [{ type: 'user', message: { content: [{ type: 'text', text: '已有消息' }] } }] as SDKMessage[]
      },
      reserveStart: (sessionId, startedAt) => {
        agentCalls.push({ type: 'reserve', value: { sessionId, startedAt } })
        if (options.reserveStartError) throw options.reserveStartError
        return () => { agentCalls.push({ type: 'release', value: sessionId }) }
      },
      run: async (input, sender, extensions) => {
        agentCalls.push({ type: 'run', value: { input, senderId: sender.id, extensions } })
      },
      stop: (sessionId) => { agentCalls.push({ type: 'stop', value: sessionId }) },
    },
    getProjectReadOnlyReason: (projectId) => {
      calls.push(`readonly:${projectId}`)
      return options.readOnlyReason
    },
  })
  /** 构造内容 lifecycle 的历史对账与当前操作分离结果。 */
  function createContentOutcome(selectedNodeId?: string) {
    const reconciliation = {
      snapshot: options.loadResult ?? { document: createDocument(4), writable: true as const, nodeIssues: [] },
      documentChanged: Boolean(options.contentReconciliationPublication),
      ...(options.contentReconciliationPublication ? { publication: options.contentReconciliationPublication } : {}),
    }
    if (options.contentOperationError) {
      return {
        reconciliation,
        operationOutcome: {
          ok: false as const,
          error: options.contentOperationError,
          ...(options.contentOperationPublication ? { publication: options.contentOperationPublication } : {}),
        },
      }
    }
    const value = options.contentResultFactory?.(selectedNodeId) ?? {
      snapshot: { document: createDocument(5), writable: true as const, nodeIssues: [] },
      ...(selectedNodeId ? { selectedNodeId } : {}),
    }
    return { reconciliation, operationOutcome: { ok: true as const, value } }
  }
  return {
    handlers, removed, sender, calls, storeInputs, agentCalls, imageCalls,
    mediaReleases, broadcastLeaseStates, registration,
    getMediaAccessCount: () => mediaAccessCount,
  }
}

describe('原生 Canvas 文档 IPC', () => {
  test('Given LOAD 与 SAVE When 执行 Then 同一 lease 内先恢复 batch 再进入既有对账链', async () => {
    const context = createContext()
    await invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })
    await invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4, mutations: [],
    })
    expect(context.calls).toEqual([
      'readonly:project-1', 'guard:project-1', 'batch:reconcile', 'content:load', 'creation:reconcile',
      'readonly:project-1', 'guard:project-1', 'batch:reconcile', 'creation:reconcile', 'store:mutate',
    ])
  })

  test('Given 单节点图变更 When 执行 Then 同一 lease 内先通过 batch 恢复屏障', async () => {
    const document = createDocument(4)
    document.nodes = [{
      id: 'node-1', kind: 'agent', title: '首页 Agent', position: { x: 0, y: 0 },
      agentSessionId: '22222222-2222-4222-8222-222222222222',
    }]
    const context = createContext({ loadResult: { document, writable: true, nodeIssues: [] } })

    await invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'document-1', kind: 'document', contentId: 'content-1', title: '文档',
      position: { x: 0, y: 0 }, expectedRevision: 4,
    })
    await invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', operationId: '22222222-2222-4222-8222-222222222222',
      nodeId: 'agent-2', title: '新 Agent', position: { x: 10, y: 20 },
    })
    await invoke(context.handlers, CANVAS_IPC_CHANNELS.REBUILD_AGENT_NODE, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', operationId: '33333333-3333-4333-8333-333333333333',
      nodeId: 'node-1',
    })

    expect(context.calls).toEqual([
      'readonly:project-1', 'guard:project-1', 'batch:reconcile', 'creation:reconcile', 'content:create',
      'readonly:project-1', 'guard:project-1', 'batch:reconcile', 'creation:create',
      'readonly:project-1', 'guard:project-1', 'batch:reconcile', 'creation:reconcile', 'creation:rebuild',
    ])
  })

  test('Given batch 恢复失败 When 单节点图变更 Then 当前 mutation 零副作用', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext({ batchReconcileError: new Error('CANVAS_BATCH_RECOVERY_REQUIRED') })

    const result = await invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', operationId: '44444444-4444-4444-8444-444444444444',
      nodeId: 'document-1', kind: 'document', contentId: 'content-1', title: '文档',
      position: { x: 0, y: 0 }, expectedRevision: 4,
    }) as CanvasInvokeResult<unknown>

    expect(result.ok).toBe(false)
    expect(context.calls).toEqual(['readonly:project-1', 'guard:project-1', 'batch:reconcile'])
    expect(context.sender.sent).toEqual([])
    errorSpy.mockRestore()
  })

  test('Given batch 恢复与当前内容创建都提交图 When lease 释放 Then 按 revision 顺序广播', async () => {
    const context = createContext({
      batchPublications: [createDocument(5)],
      contentResultFactory: (selectedNodeId) => ({
        snapshot: { document: createDocument(6), writable: true, nodeIssues: [] },
        ...(selectedNodeId ? { selectedNodeId } : {}),
      }),
    })

    await invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', operationId: '55555555-5555-4555-8555-555555555555',
      nodeId: 'document-1', kind: 'document', contentId: 'content-1', title: '文档',
      position: { x: 0, y: 0 }, expectedRevision: 5,
    })

    expect(context.sender.sent).toEqual([
      { channel: CANVAS_IPC_CHANNELS.CHANGED, value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' } },
      { channel: CANVAS_IPC_CHANNELS.CHANGED, value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 6, cause: 'graph' } },
    ])
    expect(context.broadcastLeaseStates).toEqual([false, false])
  })

  test('Given 共享 serializer When 同 Canvas 与不同 Canvas 并发 Then 仅同 Canvas 等待', async () => {
    const serializer = createCanvasOperationSerializer()
    const gate = createDeferred<void>()
    const firstStarted = createDeferred<void>()
    const otherStarted = createDeferred<void>()
    const events: string[] = []
    const first = serializer.run({ projectId: 'project-1', canvasId: 'canvas-1' }, async () => {
      events.push('first:start')
      firstStarted.resolve()
      await gate.promise
      events.push('first:end')
    })
    const same = serializer.run({ projectId: 'project-1', canvasId: 'canvas-1' }, async () => {
      events.push('same:start')
    })
    const other = serializer.run({ projectId: 'project-1', canvasId: 'canvas-2' }, async () => {
      events.push('other:start')
      otherStarted.resolve()
    })
    await Promise.all([firstStarted.promise, otherStarted.promise])
    expect(events).toEqual(['first:start', 'other:start'])
    gate.resolve()
    await Promise.all([first, same, other])
    expect(events).toEqual(['first:start', 'other:start', 'first:end', 'same:start'])
  })

  test('Given Canvas 生图节点已采用素材 When 重复 LOAD Then 返回缩略图预览且项目级授权只创建一次', async () => {
    const document = createDocument(4)
    document.nodes = [{
      id: 'node-image',
      kind: 'image',
      title: '首页视觉',
      position: { x: 0, y: 0 },
      imageModuleId: 'module-image',
      adoptedAssetId: 'asset-a',
    }]
    const context = createContext({
      loadResult: { document, writable: true, nodeIssues: [] },
      imageAssets: [createImageAsset('asset-a', 'job-a')],
    })
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }

    const first = await invoke(
      context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, target,
    ) as CanvasInvokeResult<CanvasWorkspaceSnapshot>
    const second = await invoke(
      context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, target,
    ) as CanvasInvokeResult<CanvasWorkspaceSnapshot>

    expect(first).toMatchObject({
      ok: true,
      value: {
        imagePreviews: [{
          assetId: 'asset-a',
          previewUrl: 'proma-file://thumbnails-0/asset-a.webp',
          width: 100,
          height: 100,
        }],
      },
    })
    expect(second).toMatchObject({
      ok: true,
      value: { imagePreviews: first.ok ? first.value.imagePreviews : [] },
    })
    expect(context.getMediaAccessCount()).toBe(1)
    expect(context.mediaReleases).toEqual([])

    context.registration.dispose()
    expect(context.mediaReleases).toEqual([1])
  })

  test('Given Canvas 缩略图授权失败 When LOAD Then 画布仍成功加载并回退为空预览', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const document = createDocument(4)
    document.nodes = [{
      id: 'node-image', kind: 'image', title: '首页视觉', position: { x: 0, y: 0 },
      imageModuleId: 'module-image', adoptedAssetId: 'asset-a',
    }]
    const context = createContext({
      loadResult: { document, writable: true, nodeIssues: [] },
      imageAssets: [createImageAsset('asset-a', 'job-a')],
      mediaAccessErrorAt: 0,
    })

    const result = await invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })

    expect(result).toMatchObject({ ok: true, value: { imagePreviews: [] } })
    expect(context.mediaReleases).toEqual([])
    errorSpy.mockRestore()
  })

  test('Given 合法图片目标 When LOAD Then 只返回目标配置、任务、资产和媒体 URL', async () => {
    /** A/B 任务与无关素材共存，快照只能暴露 A 模块闭包。 */
    const jobA = createImageJob(imageTargetA, 'job-a')
    const jobB = createImageJob(imageTargetB, 'job-b', 'asset-b')
    const context = createContext({
      imageJobs: [jobA, jobB],
      imageAssets: [
        createImageAsset('asset-a', jobA.id),
        createImageAsset('asset-b', jobB.id),
        createImageAsset('asset-unrelated', 'job-unrelated'),
      ],
    })

    const result = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      imageTargetA,
    )

    expect(result).toEqual({
      ok: true,
      value: {
        target: imageTargetA,
        mediaLeaseId: expect.any(String),
        config: createImageConfig(imageTargetA),
        jobs: [jobA],
        assets: [createImageAsset('asset-a', jobA.id)],
        assetBaseUrl: 'proma-file://assets-0',
        thumbnailBaseUrl: 'proma-file://thumbnails-0',
      },
    })
  })

  test('Given 第二次 LOAD 已接管 When 第一次授权迟到 RELEASE Then 不撤销新授权', async () => {
    const context = createContext()
    /** 第一次详情打开后取得的旧授权。 */
    const first = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      imageTargetA,
    ) as CanvasInvokeResult<CanvasImageModuleSnapshot & { mediaLeaseId: string }>
    /** 第二次详情打开后取得的当前授权。 */
    const second = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      imageTargetA,
    ) as CanvasInvokeResult<CanvasImageModuleSnapshot & { mediaLeaseId: string }>

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('图片模块测试 LOAD 必须成功')
    expect(first.value.mediaLeaseId).not.toBe(second.value.mediaLeaseId)

    const releaseResult = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.RELEASE_IMAGE_MEDIA,
      context.sender,
      { ...imageTargetA, mediaLeaseId: first.value.mediaLeaseId },
    )

    expect(releaseResult).toEqual({ ok: true, value: undefined })
    /** 第二次 LOAD 已释放第一代授权；迟到 RELEASE 不得继续释放第二代。 */
    expect(context.mediaReleases).toEqual([1])
  })

  test('Given A job 配 B target When cancel retry adopt Then 全部拒绝且不操作任务或资产', async () => {
    const jobA = createImageJob(imageTargetA, 'job-a')
    const context = createContext({ imageJobs: [jobA], imageAssets: [createImageAsset('asset-a', jobA.id)] })

    for (const [channel, input] of [
      [CANVAS_IPC_CHANNELS.CANCEL_IMAGE_JOB, { ...imageTargetB, jobId: jobA.id }],
      [CANVAS_IPC_CHANNELS.RETRY_IMAGE_JOB, { ...imageTargetB, jobId: jobA.id }],
      [CANVAS_IPC_CHANNELS.ADOPT_IMAGE_ASSET, {
        ...imageTargetB, jobId: jobA.id, assetId: 'asset-a', expectedConfigRevision: 3,
      }],
    ] as const) {
      const result = await invoke(context.handlers, channel, context.sender, input)
      expect(result).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_JOB_FAILED' } })
    }
    expect(context.imageCalls.filter((call) => ['cancel', 'retry', 'adopt'].includes(call.type))).toEqual([])
  })

  test('Given 图片节点已删除或换绑 When CANCEL/RETRY Then 权威目标复核先失败且不产生任务副作用', async () => {
    const deletedJob = { ...createImageJob(imageTargetA, 'job-running'), status: 'running' as const }
    const reboundJob = { ...createImageJob(imageTargetA, 'job-failed'), status: 'failed' as const }
    const deleted = createContext({
      imageJobs: [deletedJob],
      imageTargetAssert: async () => { throw new Error('CANVAS_IMAGE_TARGET_INVALID: deleted') },
    })
    const rebound = createContext({
      imageJobs: [reboundJob],
      imageTargetAssert: async () => { throw new Error('CANVAS_IMAGE_TARGET_INVALID: rebound') },
    })

    const cancelResult = await invoke(
      deleted.handlers,
      CANVAS_IPC_CHANNELS.CANCEL_IMAGE_JOB,
      deleted.sender,
      { ...imageTargetA, jobId: deletedJob.id },
    )
    const retryResult = await invoke(
      rebound.handlers,
      CANVAS_IPC_CHANNELS.RETRY_IMAGE_JOB,
      rebound.sender,
      { ...imageTargetA, jobId: reboundJob.id },
    )

    expect(cancelResult).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_JOB_FAILED' } })
    expect(retryResult).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_JOB_FAILED' } })
    expect(deleted.imageCalls.filter((call) => call.type === 'assert-target')).toHaveLength(1)
    expect(rebound.imageCalls.filter((call) => call.type === 'assert-target')).toHaveLength(1)
    expect(deleted.imageCalls.filter((call) => call.type === 'cancel')).toHaveLength(0)
    expect(rebound.imageCalls.filter((call) => call.type === 'retry' || call.type === 'run')).toHaveLength(0)
  })

  test('Given revision 身份或 asset 归属错误 When 写操作 Then fail closed 且无业务副作用', async () => {
    const jobA = createImageJob(imageTargetA, 'job-a')
    const context = createContext({
      imageConfig: createImageConfig(imageTargetA, 4),
      imageJobs: [jobA],
      imageAssets: [createImageAsset('asset-foreign', 'job-foreign')],
    })

    const createResult = await invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_IMAGE_JOB, context.sender, {
      ...imageTargetA, expectedConfigRevision: 3,
    })
    const adoptResult = await invoke(context.handlers, CANVAS_IPC_CHANNELS.ADOPT_IMAGE_ASSET, context.sender, {
      ...imageTargetA, jobId: jobA.id, assetId: 'asset-foreign', expectedConfigRevision: 4,
    })
    const identityContext = createContext({ imageConfig: createImageConfig(imageTargetB) })
    const loadResult = await invoke(
      identityContext.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      identityContext.sender,
      imageTargetA,
    )

    expect(createResult).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_REVISION_CONFLICT' } })
    expect(adoptResult).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_JOB_FAILED' } })
    expect(loadResult).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_LOAD_FAILED' } })
    expect(context.imageCalls.filter((call) => ['create', 'run', 'adopt'].includes(call.type))).toEqual([])
  })

  test('Given 重复 LOAD 与释放路径 When lease 替换失败或成功 Then 保旧授权并幂等回收当前授权', async () => {
    const failedReplacement = createContext({ mediaAccessErrorAt: 1 })
    const retained = await invoke(
      failedReplacement.handlers, CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE, failedReplacement.sender, imageTargetA,
    ) as CanvasInvokeResult<CanvasImageModuleSnapshot>
    if (!retained.ok) throw new Error('首个图片授权必须成功')
    const failed = await invoke(
      failedReplacement.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      failedReplacement.sender,
      imageTargetA,
    )
    expect(failed).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_LOAD_FAILED' } })
    expect(failedReplacement.mediaReleases[0] ?? 0).toBe(0)
    await invoke(
      failedReplacement.handlers,
      CANVAS_IPC_CHANNELS.RELEASE_IMAGE_MEDIA,
      failedReplacement.sender,
      { ...imageTargetA, mediaLeaseId: retained.value.mediaLeaseId },
    )
    expect(failedReplacement.mediaReleases[0]).toBe(1)

    const replacement = createContext()
    await invoke(replacement.handlers, CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE, replacement.sender, imageTargetA)
    await invoke(replacement.handlers, CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE, replacement.sender, imageTargetA)
    expect(replacement.mediaReleases[0]).toBe(1)
    replacement.sender.destroyForTest()
    replacement.sender.destroyForTest()
    expect(replacement.mediaReleases[1]).toBe(1)
  })

  test('Given 同 Canvas 两个 SAVE 并发 When 首个尚未提交 Then 第二个等待并按新 revision 冲突', async () => {
    const firstSave = createDeferred<CanvasImageModuleConfig>()
    const firstSaveEntered = createDeferred<void>()
    let revision = 3
    let saveCalls = 0
    const context = createContext({
      imageSave: async (input) => {
        saveCalls += 1
        if (saveCalls === 1) {
          firstSaveEntered.resolve(undefined)
          const result = await firstSave.promise
          revision = result.revision
          return result
        }
        if (input.expectedConfigRevision !== revision) throw new Error('CANVAS_IMAGE_REVISION_CONFLICT')
        revision += 1
        return createImageConfig(input, revision)
      },
    })
    const input = createImageSaveInput(imageTargetA, 3)

    const first = invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_IMAGE_MODULE, context.sender, input)
    const second = invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_IMAGE_MODULE, context.sender, input)
    await firstSaveEntered.promise

    expect(saveCalls).toBe(1)
    firstSave.resolve(createImageConfig(imageTargetA, 4))
    await expect(first).resolves.toMatchObject({ ok: true, value: { revision: 4 } })
    await expect(second).resolves.toMatchObject({
      ok: false,
      error: { code: 'CANVAS_IMAGE_REVISION_CONFLICT' },
    })
    expect(saveCalls).toBe(2)
  })

  test('Given 不同 Canvas 的 SAVE When A 被阻塞 Then B 无需等待即可提交', async () => {
    const blockedSave = createDeferred<CanvasImageModuleConfig>()
    const targetOtherCanvas: CanvasImageTarget = {
      projectId: 'project-1', canvasId: 'canvas-2', nodeId: 'image-node-c', imageModuleId: 'module-c',
    }
    const context = createContext({
      imageSave: async (input) => input.canvasId === imageTargetA.canvasId
        ? blockedSave.promise
        : createImageConfig(input, input.expectedConfigRevision + 1),
    })

    const first = invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.SAVE_IMAGE_MODULE,
      context.sender,
      createImageSaveInput(imageTargetA, 3),
    )
    const independent = invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.SAVE_IMAGE_MODULE,
      context.sender,
      createImageSaveInput(targetOtherCanvas, 7),
    )

    await expect(independent).resolves.toMatchObject({ ok: true, value: { revision: 8 } })
    blockedSave.resolve(createImageConfig(imageTargetA, 4))
    await expect(first).resolves.toMatchObject({ ok: true, value: { revision: 4 } })
  })

  test('Given A job 引用 B job 输出 When LOAD A Then fail closed 且不返回跨目标素材元数据', async () => {
    const jobA = {
      ...createImageJob(imageTargetA, 'job-a'),
      sourceAssetId: 'asset-b',
    }
    const jobB = createImageJob(imageTargetB, 'job-b', 'asset-b')
    const context = createContext({
      imageConfig: createImageConfig(imageTargetA),
      imageJobs: [jobA, jobB],
      imageAssets: [createImageAsset('asset-a', jobA.id), createImageAsset('asset-b', jobB.id)],
    })

    const result = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      imageTargetA,
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_LOAD_FAILED' } })
    expect(JSON.stringify(result)).not.toContain('asset-b.png')
    expect(context.getMediaAccessCount()).toBe(0)
  })

  test('Given 零 Canvas Job 且配置采用 legacy 素材 When LOAD Then 返回可信 adopted 祖先闭包', async () => {
    const legacyAsset = createImageAsset('asset-legacy')
    const context = createContext({
      imageConfig: { ...createImageConfig(imageTargetA), adoptedAssetId: legacyAsset.id },
      imageJobs: [],
      imageAssets: [legacyAsset, createImageAsset('asset-unrelated', 'job-unrelated')],
    })

    const result = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      imageTargetA,
    )

    expect(result).toMatchObject({
      ok: true,
      value: { jobs: [], assets: [legacyAsset] },
    })
  })

  test('Given 编辑 Job 以 legacy adopted 为来源 When LOAD Then 返回目标输出与完整祖先链', async () => {
    const legacyAsset = createImageAsset('asset-legacy')
    const editedAsset = createImageAsset('asset-edited', 'job-edit', legacyAsset.id)
    const editJob = {
      ...createImageJob(imageTargetA, 'job-edit', editedAsset.id),
      action: 'edit' as const,
      sourceAssetId: legacyAsset.id,
      parentAssetId: legacyAsset.id,
    }
    const context = createContext({
      imageConfig: { ...createImageConfig(imageTargetA), adoptedAssetId: editedAsset.id },
      imageJobs: [editJob],
      imageAssets: [legacyAsset, editedAsset],
    })

    const result = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      imageTargetA,
    )

    expect(result).toMatchObject({
      ok: true,
      value: { jobs: [editJob], assets: [editedAsset, legacyAsset] },
    })
  })

  test('Given Job 输出素材伪造父链 When LOAD Then edit 和 generate 均 fail closed 且不授权素材', async () => {
    const sourceAsset = createImageAsset('asset-source')
    const foreignAsset = createImageAsset('asset-foreign', undefined, sourceAsset.id)
    const editJob = {
      ...createImageJob(imageTargetA, 'job-edit-forged', 'asset-edit-output'),
      action: 'edit' as const,
      sourceAssetId: sourceAsset.id,
      parentAssetId: sourceAsset.id,
    }
    const generateJob = createImageJob(imageTargetA, 'job-generate-forged', 'asset-generate-output')
    const contexts = [
      createContext({
        imageConfig: { ...createImageConfig(imageTargetA), adoptedAssetId: 'asset-edit-output' },
        imageJobs: [editJob],
        imageAssets: [
          sourceAsset,
          foreignAsset,
          createImageAsset('asset-edit-output', editJob.id, foreignAsset.id),
        ],
      }),
      createContext({
        imageConfig: { ...createImageConfig(imageTargetA), adoptedAssetId: 'asset-generate-output' },
        imageJobs: [generateJob],
        imageAssets: [
          foreignAsset,
          createImageAsset('asset-generate-output', generateJob.id, foreignAsset.id),
        ],
      }),
    ]

    for (const context of contexts) {
      const result = await invoke(
        context.handlers,
        CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
        context.sender,
        imageTargetA,
      )
      expect(result).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_LOAD_FAILED' } })
      expect(JSON.stringify(result)).not.toContain('asset-foreign.png')
      expect(context.getMediaAccessCount()).toBe(0)
    }
  })

  test('Given generate Job 与输出素材协调伪造同一父链 When LOAD Then 仍 fail closed 且不授权父素材', async () => {
    const parentAsset = createImageAsset('asset-generate-parent')
    const generateJob = {
      ...createImageJob(imageTargetA, 'job-generate-coordinated', 'asset-generate-output'),
      sourceAssetId: parentAsset.id,
      parentAssetId: parentAsset.id,
    }
    const context = createContext({
      imageConfig: { ...createImageConfig(imageTargetA), adoptedAssetId: 'asset-generate-output' },
      imageJobs: [generateJob],
      imageAssets: [
        parentAsset,
        createImageAsset('asset-generate-output', generateJob.id, parentAsset.id),
      ],
    })

    const result = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      imageTargetA,
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_LOAD_FAILED' } })
    expect(JSON.stringify(result)).not.toContain('asset-generate-parent.png')
    expect(context.getMediaAccessCount()).toBe(0)
  })

  test('Given edit 来源由当前模块、跨模块或旧 Design Job 产出 When LOAD Then 只拒绝跨模块来源', async () => {
    const currentSourceJob = createImageJob(imageTargetA, 'job-source-current', 'asset-source-current')
    const currentEditJob = {
      ...createImageJob(imageTargetA, 'job-edit-current', 'asset-edit-current'),
      action: 'edit' as const,
      sourceAssetId: 'asset-source-current',
      parentAssetId: 'asset-source-current',
    }
    const crossSourceJob = createImageJob(imageTargetB, 'job-source-cross', 'asset-source-cross')
    const crossEditJob = {
      ...createImageJob(imageTargetA, 'job-edit-cross', 'asset-edit-cross'),
      action: 'edit' as const,
      sourceAssetId: 'asset-source-cross',
      parentAssetId: 'asset-source-cross',
    }
    const designSourceJob: DesignJobRecord = {
      id: 'job-source-design', creativeTaskId: 'creative-source-design', attemptNumber: 1,
      projectId: imageTargetA.projectId,
      target: { kind: 'design-canvas', nodeId: 'design-node-source', position: { x: 0, y: 0 } },
      action: 'generate', status: 'succeeded', prompt: '旧 Design 来源', originalRequest: '旧 Design 来源',
      contextMode: 'none', outputAssetId: 'asset-source-design', createdAt: 1, updatedAt: 2,
    }
    const designEditJob = {
      ...createImageJob(imageTargetA, 'job-edit-design', 'asset-edit-design'),
      action: 'edit' as const,
      sourceAssetId: 'asset-source-design',
      parentAssetId: 'asset-source-design',
    }
    const current = createContext({
      imageConfig: { ...createImageConfig(imageTargetA), adoptedAssetId: 'asset-edit-current' },
      imageJobs: [currentSourceJob, currentEditJob],
      imageAssets: [
        createImageAsset('asset-source-current', currentSourceJob.id),
        createImageAsset('asset-edit-current', currentEditJob.id, 'asset-source-current'),
      ],
    })
    const cross = createContext({
      imageConfig: { ...createImageConfig(imageTargetA), adoptedAssetId: 'asset-edit-cross' },
      imageJobs: [crossSourceJob, crossEditJob],
      imageAssets: [
        createImageAsset('asset-source-cross', crossSourceJob.id),
        createImageAsset('asset-edit-cross', crossEditJob.id, 'asset-source-cross'),
      ],
    })
    const design = createContext({
      imageConfig: { ...createImageConfig(imageTargetA), adoptedAssetId: 'asset-edit-design' },
      imageJobs: [designSourceJob, designEditJob],
      imageAssets: [
        createImageAsset('asset-source-design', designSourceJob.id),
        createImageAsset('asset-edit-design', designEditJob.id, 'asset-source-design'),
      ],
    })

    const currentResult = await invoke(
      current.handlers, CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE, current.sender, imageTargetA,
    )
    const crossResult = await invoke(
      cross.handlers, CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE, cross.sender, imageTargetA,
    )
    const designResult = await invoke(
      design.handlers, CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE, design.sender, imageTargetA,
    )

    expect(currentResult).toMatchObject({ ok: true, value: { jobs: [currentSourceJob, currentEditJob] } })
    expect(crossResult).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_LOAD_FAILED' } })
    expect(cross.getMediaAccessCount()).toBe(0)
    expect(designResult).toMatchObject({ ok: true, value: { jobs: [designEditJob] } })
  })

  test('Given edit 来源素材伪造同目标 Job 归属但 Job 输出为其他素材 When LOAD Then fail closed 且不授权', async () => {
    const sourceJob = createImageJob(imageTargetA, 'job-source-mismatch', 'asset-real-output')
    const editJob = {
      ...createImageJob(imageTargetA, 'job-edit-mismatch', 'asset-edit-mismatch'),
      action: 'edit' as const,
      sourceAssetId: 'asset-forged-source',
      parentAssetId: 'asset-forged-source',
    }
    const context = createContext({
      imageConfig: { ...createImageConfig(imageTargetA), adoptedAssetId: 'asset-edit-mismatch' },
      imageJobs: [sourceJob, editJob],
      imageAssets: [
        createImageAsset('asset-real-output', sourceJob.id),
        createImageAsset('asset-forged-source', sourceJob.id),
        createImageAsset('asset-edit-mismatch', editJob.id, 'asset-forged-source'),
      ],
    })

    const result = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      imageTargetA,
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_LOAD_FAILED' } })
    expect(JSON.stringify(result)).not.toContain('asset-forged-source.png')
    expect(context.getMediaAccessCount()).toBe(0)
  })

  test('Given adopted 素材祖先循环或超过上限 When LOAD Then fail closed 且不创建媒体 lease', async () => {
    const cyclicJob = createImageJob(imageTargetA, 'job-cycle', 'asset-cycle-a')
    const cyclic = createContext({
      imageConfig: { ...createImageConfig(imageTargetA), adoptedAssetId: 'asset-cycle-a' },
      imageJobs: [cyclicJob],
      imageAssets: [
        createImageAsset('asset-cycle-a', cyclicJob.id, 'asset-cycle-b'),
        createImageAsset('asset-cycle-b', undefined, 'asset-cycle-a'),
      ],
    })
    const deepAssets = Array.from({ length: 257 }, (_, index) => (
      createImageAsset(
        `asset-depth-${index}`,
        index === 0 ? 'job-depth' : undefined,
        index < 256 ? `asset-depth-${index + 1}` : undefined,
      )
    ))
    const deepJob = createImageJob(imageTargetA, 'job-depth', 'asset-depth-0')
    const tooDeep = createContext({
      imageConfig: { ...createImageConfig(imageTargetA), adoptedAssetId: 'asset-depth-0' },
      imageJobs: [deepJob],
      imageAssets: deepAssets,
    })

    for (const context of [cyclic, tooDeep]) {
      const result = await invoke(
        context.handlers,
        CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
        context.sender,
        imageTargetA,
      )
      expect(result).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_LOAD_FAILED' } })
      expect(context.getMediaAccessCount()).toBe(0)
    }
  })

  test('Given 旧 LOAD 晚回且较新 Canvas LOAD 已提交 When 旧请求完成 Then 不能撤销较新 lease', async () => {
    const oldLoad = createDeferred<CanvasImageModuleConfig>()
    const newerTarget: CanvasImageTarget = {
      projectId: 'project-1', canvasId: 'canvas-2', nodeId: 'image-node-new', imageModuleId: 'module-new',
    }
    const newerAsset = createImageAsset('asset-new', 'job-new')
    const newerJob = createImageJob(newerTarget, 'job-new', newerAsset.id)
    const oldAsset = createImageAsset('asset-a', 'job-old')
    const oldJob = createImageJob(imageTargetA, 'job-old', oldAsset.id)
    const context = createContext({
      imageLoad: async (target) => target.canvasId === imageTargetA.canvasId
        ? oldLoad.promise
        : { ...createImageConfig(newerTarget), adoptedAssetId: newerAsset.id },
      imageJobsList: () => [oldJob, newerJob],
      imageAssets: [oldAsset, newerAsset],
    })

    const oldResult = invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      imageTargetA,
    )
    await Promise.resolve()
    const newerResult = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      newerTarget,
    ) as CanvasInvokeResult<CanvasImageModuleSnapshot>
    oldLoad.resolve(createImageConfig(imageTargetA))

    expect(newerResult).toMatchObject({ ok: true, value: { target: newerTarget } })
    if (!newerResult.ok) throw new Error('较新图片授权必须成功')
    await expect(oldResult).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_LOAD_FAILED' } })
    expect(context.getMediaAccessCount()).toBe(1)
    expect(context.mediaReleases[0] ?? 0).toBe(0)
    await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.RELEASE_IMAGE_MEDIA,
      context.sender,
      { ...newerTarget, mediaLeaseId: newerResult.value.mediaLeaseId },
    )
    expect(context.mediaReleases[0]).toBe(1)
  })

  test('Given registration dispose 时 LOAD 仍在读取 When 读取完成 Then 不得重新提交媒体 lease', async () => {
    const blockedLoad = createDeferred<CanvasImageModuleConfig>()
    const context = createContext({ imageLoad: async () => blockedLoad.promise })
    const loading = invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      imageTargetA,
    )
    await Promise.resolve()
    context.registration.dispose()
    blockedLoad.resolve(createImageConfig(imageTargetA))

    await expect(loading).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_LOAD_FAILED' } })
    expect(context.getMediaAccessCount()).toBe(0)
    expect(context.mediaReleases.filter(Boolean)).toEqual([])
  })

  test('Given async LOAD 读取配置期间 sender destroyed When 读取恢复 Then 不创建或遗留媒体 lease', async () => {
    const blockedLoad = createDeferred<CanvasImageModuleConfig>()
    const context = createContext({ imageLoad: async () => blockedLoad.promise })
    const loading = invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      imageTargetA,
    )
    await Promise.resolve()
    context.sender.destroyForTest()
    blockedLoad.resolve(createImageConfig(imageTargetA))

    await expect(loading).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_LOAD_FAILED' } })
    expect(context.getMediaAccessCount()).toBe(0)
    expect(context.mediaReleases.filter(Boolean)).toEqual([])
    context.registration.dispose()
    expect(context.mediaReleases.filter(Boolean)).toEqual([])
  })

  test('Given LOAD 列任务时 sender destroyed When 列表返回 Then 候选授权不得提交', async () => {
    let context: ReturnType<typeof createContext>
    context = createContext({
      imageJobsList: () => {
        context.sender.destroyForTest()
        return [createImageJob(imageTargetA, 'job-a')]
      },
    })

    const result = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      context.sender,
      imageTargetA,
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_LOAD_FAILED' } })
    expect(context.getMediaAccessCount()).toBe(0)
    expect(context.mediaReleases.filter(Boolean)).toEqual([])
  })

  test('Given 四类内容生命周期命令 When IPC 调用 Then Agent 对账后调用内容服务并只返回公开业务字段', async () => {
    /** 合法公开图包含 Agent session 引用，不能按字段名称误删。 */
    const publicDocument = createDocument(5)
    publicDocument.nodes = [{
      id: 'agent-public', kind: 'agent', title: '公开 Agent', position: { x: 0, y: 0 },
      agentSessionId: 'session-public',
    }]
    /** 合法节点问题用于确认 IPC 会逐字段重建嵌套数组。 */
    const nodeIssues = [{
      nodeId: 'agent-public', code: 'AGENT_SESSION_UNAVAILABLE' as const,
      allowedActions: ['rebuild-agent-session', 'remove-node'] as const,
    }]
    /** 合法回收条目用于确认 list 会逐项严格重建。 */
    const trashEntry: CanvasTrashEntry = {
      schemaVersion: 1,
      trashId: 'trash-public',
      nodeId: 'document-public',
      kind: 'document',
      contentId: 'content-public',
      title: '公开文档',
      position: { x: 3, y: 4 },
      deletedRevision: 4,
      deletedAt: 10,
    }
    /** 生命周期故意夹带根与 snapshot 内部字段，IPC 必须丢弃而非透传。 */
    const context = createContext({
      contentResultFactory: (selectedNodeId) => ({
        snapshot: {
          document: publicDocument,
          writable: true,
          nodeIssues,
          recoveredFrom: 'backup',
          contentPath: '/private/content',
          internalIntent: { state: 'committed' },
        },
        ...(selectedNodeId ? { selectedNodeId } : {}),
        ...(!selectedNodeId ? { trashEntry } : {}),
        contentPath: '/private/content',
        transactionsPath: '/private/transactions',
        internalIntent: { state: 'committed' },
        credential: 'credential-secret',
      } as unknown as CanvasNodeLifecycleResult),
      contentTrashResult: [trashEntry],
    })
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const createResult = await invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE, context.sender, {
      ...target, operationId: '11111111-1111-4111-8111-111111111111', nodeId: 'node-content', kind: 'document', contentId: 'content-1', title: '文档', position: { x: 1, y: 2 }, expectedRevision: 4,
    }) as CanvasInvokeResult<CanvasNodeLifecycleResult>
    const deleteResult = await invoke(context.handlers, CANVAS_IPC_CHANNELS.DELETE_NODE, context.sender, {
      ...target, operationId: '22222222-2222-4222-8222-222222222222', nodeId: 'node-content', expectedRevision: 4,
    }) as CanvasInvokeResult<CanvasNodeLifecycleResult>
    const listResult = await invoke(context.handlers, CANVAS_IPC_CHANNELS.LIST_TRASH, context.sender, target) as CanvasInvokeResult<CanvasTrashEntry[]>
    const restoreResult = await invoke(context.handlers, CANVAS_IPC_CHANNELS.RESTORE_NODE, context.sender, {
      ...target, operationId: '33333333-3333-4333-8333-333333333333', trashId: 'trash-1', expectedRevision: 4, position: { x: 3, y: 4 },
    }) as CanvasInvokeResult<CanvasNodeLifecycleResult>

    /** 四个公开操作共享的精确规范化 snapshot。 */
    const expectedSnapshot: CanvasWorkspaceSnapshot = {
      document: publicDocument,
      writable: true,
      nodeIssues: nodeIssues.map((issue) => ({ ...issue, allowedActions: [...issue.allowedActions] })),
      recoveredFrom: 'backup',
    }
    expect(createResult).toEqual({
      ok: true,
      value: { snapshot: expectedSnapshot, selectedNodeId: 'node-content' },
    })
    expect(deleteResult).toEqual({
      ok: true,
      value: { snapshot: expectedSnapshot, trashEntry },
    })
    expect(listResult).toEqual({ ok: true, value: [trashEntry] })
    expect(restoreResult).toEqual({
      ok: true,
      value: { snapshot: expectedSnapshot, selectedNodeId: 'node-restored' },
    })
    expect(context.calls.filter((call) => call === 'creation:reconcile')).toHaveLength(4)
    expect(context.calls.filter((call) => call.startsWith('content:'))).toEqual([
      'content:create', 'content:delete', 'content:list-trash', 'content:restore',
    ])
    expect(context.sender.sent).toEqual([
      { channel: CANVAS_IPC_CHANNELS.CHANGED, value: { ...target, revision: 5, cause: 'graph' } },
      { channel: CANVAS_IPC_CHANNELS.CHANGED, value: { ...target, revision: 5, cause: 'graph' } },
      { channel: CANVAS_IPC_CHANNELS.CHANGED, value: { ...target, revision: 5, cause: 'graph' } },
    ])
    expect(context.agentCalls).toEqual([])
  })

  test('Given lifecycle 回收条目夹带内部字段 When IPC 列表 Then fail closed 为公开错误', async () => {
    /** 回收条目嵌套合同必须 exact，不能只丢弃未知字段后继续接受。 */
    const invalidEntry = {
      schemaVersion: 1,
      trashId: 'trash-invalid',
      nodeId: 'document-invalid',
      kind: 'document',
      contentId: 'content-invalid',
      title: '损坏条目',
      position: { x: 0, y: 0 },
      deletedRevision: 1,
      deletedAt: 10,
      transactionsPath: '/private/transactions',
      credential: 'credential-secret',
    } as unknown as CanvasTrashEntry
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext({ contentTrashResult: [invalidEntry] })

    const result = await invoke(context.handlers, CANVAS_IPC_CHANNELS.LIST_TRASH, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'CANVAS_CONTENT_INVALID', message: '回收区暂时无法加载。' },
    })
    errorSpy.mockRestore()
  })

  test('Given lifecycle nodeIssue 夹带内部字段 When IPC 创建 Then fail closed 为公开错误', async () => {
    /** nodeIssue 是 snapshot 内部公开联合，未知字段必须使整次结果失效。 */
    const context = createContext({
      contentResultFactory: () => ({
        snapshot: {
          document: createDocument(5),
          writable: true,
          nodeIssues: [{
            nodeId: 'agent-invalid',
            code: 'AGENT_SESSION_UNAVAILABLE',
            allowedActions: ['remove-node'],
            internalIntent: { state: 'committed' },
          }],
        },
      } as unknown as CanvasNodeLifecycleResult),
    })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '99999999-9999-4999-8999-999999999999',
      nodeId: 'document-invalid', kind: 'document', contentId: 'content-invalid',
      title: '损坏文档', position: { x: 0, y: 0 }, expectedRevision: 4,
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'CANVAS_CREATE_FAILED', message: '节点创建失败，请重试。' },
    })
    expect(context.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: {
        projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph',
      },
    }])
    expect(context.broadcastLeaseStates).toEqual([false])
    errorSpy.mockRestore()
  })

  test('Given 内容命令含未知字段、sessionId、path 或 getter When IPC 调用 Then 拒绝且不进入 lifecycle', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext()
    const invalidValues: Array<{ channel: string; value: unknown }> = [
      { channel: CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE, value: { projectId: 'project-1', canvasId: 'canvas-1', operationId: '11111111-1111-4111-8111-111111111111', nodeId: 'node-1', kind: 'image', contentId: 'content-1', title: '图片', position: { x: 0, y: 0 }, expectedRevision: 0, path: '/tmp/x' } },
      { channel: CANVAS_IPC_CHANNELS.DELETE_NODE, value: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', operationId: '22222222-2222-4222-8222-222222222222', expectedRevision: 0, sessionId: 'secret' } },
      { channel: CANVAS_IPC_CHANNELS.LIST_TRASH, value: { projectId: 'project-1', canvasId: 'canvas-1', trashEntry: {} } },
      { channel: CANVAS_IPC_CHANNELS.RESTORE_NODE, value: Object.defineProperty({ projectId: 'project-1', canvasId: 'canvas-1', operationId: '33333333-3333-4333-8333-333333333333', trashId: 'trash-1', expectedRevision: 0, position: { x: 0, y: 0 } }, 'path', { enumerable: true, get: () => '/tmp/x' }) },
    ]

    for (const item of invalidValues) {
      const result = await invoke(context.handlers, item.channel, context.sender, item.value) as CanvasInvokeResult<unknown>
      expect(result.ok).toBe(false)
    }
    expect(context.calls.some((call) => call.startsWith('content:'))).toBe(false)
    errorSpy.mockRestore()
  })

  test('Given 历史内容 publication 后当前删除失败 When IPC 返回 Then 先广播历史再返回稳定删除错误', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext({
      contentReconciliationPublication: createDocument(5),
      contentOperationError: new Error('/private/content/CANVAS_INTERNAL'),
    })
    const result = await invoke(context.handlers, CANVAS_IPC_CHANNELS.DELETE_NODE, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', operationId: '44444444-4444-4444-8444-444444444444', expectedRevision: 4,
    }) as CanvasInvokeResult<unknown>

    expect(context.sender.sent).toEqual([{ channel: CANVAS_IPC_CHANNELS.CHANGED, value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' } }])
    expect(result).toEqual({ ok: false, error: { code: 'CANVAS_DELETE_FAILED', message: '节点删除失败，请重试。' } })
    expect(context.broadcastLeaseStates).toEqual([false])
    errorSpy.mockRestore()
  })

  test('Given Agent 与内容对账发布相同 revision 且当前操作发布更高 revision When 删除失败 Then 按 revision 去重并保持顺序', async () => {
    /** 当前操作失败日志不属于公开合同，测试只观察安全结果与广播。 */
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    /** 组合相同历史 revision 与更高当前 publication 的 IPC 上下文。 */
    const context = createContext({
      reconcileResult: {
        snapshot: { document: createDocument(5), writable: true, nodeIssues: [] },
        documentChanged: true,
      },
      contentReconciliationPublication: createDocument(5),
      contentOperationPublication: createDocument(6),
      contentOperationError: new Error('CANVAS_CONTENT_WRITE_FAILED'),
    })

    await invoke(context.handlers, CANVAS_IPC_CHANNELS.DELETE_NODE, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-content',
      operationId: '77777777-7777-4777-8777-777777777777', expectedRevision: 5,
    })

    expect(context.sender.sent).toEqual([
      {
        channel: CANVAS_IPC_CHANNELS.CHANGED,
        value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
      },
      {
        channel: CANVAS_IPC_CHANNELS.CHANGED,
        value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 6, cause: 'graph' },
      },
    ])
    expect(context.broadcastLeaseStates).toEqual([false, false])
    errorSpy.mockRestore()
  })

  test('Given SAVE remove-nodes 指向内容节点 When 保存 Then 拒绝旧入口且不调用 Store mutate', async () => {
    const document = createDocument(4)
    document.nodes = [{ id: 'node-content', kind: 'document', title: '文档', position: { x: 0, y: 0 }, documentId: 'content-1', contentRevision: 0 }]
    const context = createContext({ loadResult: { document, writable: true, nodeIssues: [] } })

    const result = await invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4,
      mutations: [{ type: 'remove-nodes', nodeIds: ['node-content'] }],
    }) as CanvasInvokeResult<unknown>

    expect(result).toEqual({ ok: false, error: { code: 'CANVAS_CONTENT_INVALID', message: '请使用节点删除操作。' } })
    expect(context.calls).not.toContain('store:mutate')
  })

  test('Given 内容节点 revision conflict 或 Agent busy When 删除 Then 映射稳定公开错误', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const conflict = createContext({ contentOperationError: new Error('CANVAS_REVISION_CONFLICT') })
    const busy = createContext({
      contentOperationError: Object.assign(new Error('内部运行身份'), { code: 'AGENT_SESSION_BUSY' }),
    })
    const input = { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', operationId: '55555555-5555-4555-8555-555555555555', expectedRevision: 4 }

    expect(await invoke(conflict.handlers, CANVAS_IPC_CHANNELS.DELETE_NODE, conflict.sender, input)).toEqual({
      ok: false, error: { code: 'CANVAS_REVISION_CONFLICT', message: '画布已更新，请重新加载后重试。' },
    })
    expect(await invoke(busy.handlers, CANVAS_IPC_CHANNELS.DELETE_NODE, busy.sender, input)).toEqual({
      ok: false, error: { code: 'AGENT_SESSION_BUSY', message: '请先停止 Agent，再继续节点操作。' },
    })
    errorSpy.mockRestore()
  })

  test('Given 未授权窗口或只读项目 When 调用内容节点通道 Then 在 lifecycle 前安全拒绝', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const unauthorized = createContext({ authorized: [createSender(2)] })
    const readOnly = createContext({ readOnlyReason: '项目只读' })
    const createInput = { projectId: 'project-1', canvasId: 'canvas-1', operationId: '66666666-6666-4666-8666-666666666666', nodeId: 'node-1', kind: 'image', contentId: 'content-1', title: '图片', position: { x: 0, y: 0 }, expectedRevision: 4 }

    expect((await invoke(unauthorized.handlers, CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE, unauthorized.sender, createInput) as CanvasInvokeResult<unknown>).ok).toBe(false)
    expect((await invoke(readOnly.handlers, CANVAS_IPC_CHANNELS.LIST_TRASH, readOnly.sender, { projectId: 'project-1', canvasId: 'canvas-1' }) as CanvasInvokeResult<unknown>).ok).toBe(false)
    expect(unauthorized.calls.some((call) => call.startsWith('content:'))).toBe(false)
    expect(readOnly.calls.some((call) => call.startsWith('content:'))).toBe(false)
    errorSpy.mockRestore()
  })

  test('Given LOAD When 执行 Then 内容迁移完成后再执行 Agent 对账', async () => {
    const context = createContext()
    await invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, { projectId: 'project-1', canvasId: 'canvas-1' })
    expect(context.calls).toEqual([
      'readonly:project-1', 'guard:project-1', 'batch:reconcile', 'content:load', 'creation:reconcile',
    ])
  })

  test('Given schema v1 文档已规范化 When 经 IPC 加载并执行下一次写入 Then 公开文档始终为 v2', async () => {
    /** 迁移解析与 IPC 调用共享的稳定双身份。 */
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    /** 真实 v1 parser 输出的规范化 v2 文档。 */
    const migrated = parseCanvasDocument({
      schemaVersion: 1,
      ...target,
      revision: 4,
      createdAt: 1,
      updatedAt: 2,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{
        id: 'legacy-document', kind: 'visual-document', title: '旧文档',
        position: { x: 0, y: 0 }, visualDocumentId: 'document-1',
      }],
      edges: [],
    }, target).document
    /** 模拟迁移后下一次正常 mutation 的 v2 写入结果。 */
    const written = { ...migrated, revision: 5, updatedAt: 3 }
    /** IPC 上下文同时返回迁移快照与后续写入结果。 */
    const context = createContext({
      loadResult: { document: migrated, writable: true, nodeIssues: [] },
      mutateResult: written,
    })

    /** Renderer 通过 LOAD 获得的公开迁移结果。 */
    const loaded = await invoke(
      context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, target,
    ) as CanvasInvokeResult<CanvasWorkspaceSnapshot>
    /** Renderer 在迁移基线上执行下一次写入获得的公开结果。 */
    const saved = await invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, context.sender, {
      ...target,
      expectedRevision: 4,
      mutations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    }) as CanvasInvokeResult<CanvasDocument>

    expect(loaded).toHaveProperty('value.document.schemaVersion', 2)
    expect(saved).toHaveProperty('value.schemaVersion', 2)
  })
  test('Given 内部 LOAD 异常含路径和 UUID When IPC 返回 Then 只暴露公开文案', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext({
      loadError: new Error(
        'Error invoking remote method canvas:load /Users/name 11111111-1111-4111-8111-111111111111',
      ),
    })

    const result = await invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, {
      projectId: 'project-1',
      canvasId: 'canvas-1',
    }) as CanvasInvokeResult<CanvasWorkspaceSnapshot>

    expect(result).toEqual({
      ok: false,
      error: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
    })
    errorSpy.mockRestore()
  })

  test('Given 运行中 Agent 节点 When SAVE 删除 Then 拒绝整个 batch 且 Store 不变', async () => {
    const document = createDocument(4)
    document.nodes = [{
      id: 'node-1',
      kind: 'agent',
      title: '首页 Agent',
      position: { x: 0, y: 0 },
      agentSessionId: '22222222-2222-4222-8222-222222222222',
    }]
    const context = createContext({
      loadResult: { document, writable: true, nodeIssues: [] },
      activeRunSnapshot: {
        owners: [{
          sessionId: '22222222-2222-4222-8222-222222222222',
          projectId: 'project-1',
          canvasId: 'canvas-1',
          nodeId: 'node-1',
          title: '首页 Agent',
          startedAt: 10,
        }],
        internalInvalidRuns: [],
      },
    })

    const result = await invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, context.sender, {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      expectedRevision: 4,
      mutations: [{ type: 'remove-nodes', nodeIds: ['node-1'] }],
    }) as CanvasInvokeResult<CanvasDocument>

    expect(result).toEqual({
      ok: false,
      error: { code: 'AGENT_SESSION_BUSY', message: '请先停止 Agent，再删除节点。' },
    })
    expect(context.calls).not.toContain('store:mutate')
  })

  test('Given 坏节点 When GET 消息 Then 不读取 JSONL 并返回安全失败', async () => {
    const document = createDocument(4)
    document.nodes = [{
      id: 'node-1',
      kind: 'agent',
      title: '首页 Agent',
      position: { x: 0, y: 0 },
      agentSessionId: '22222222-2222-4222-8222-222222222222',
    }]
    const context = createContext({
      loadResult: {
        document,
        writable: true,
        nodeIssues: [{
          nodeId: 'node-1',
          code: 'AGENT_SESSION_UNAVAILABLE',
          allowedActions: ['rebuild-agent-session', 'remove-node'],
        }],
      },
    })

    const result = await invoke(context.handlers, CANVAS_IPC_CHANNELS.GET_AGENT_MESSAGES, context.sender, {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      nodeId: 'node-1',
    }) as CanvasInvokeResult<unknown>

    expect(result).toEqual({
      ok: false,
      error: { code: 'CANVAS_AGENT_MESSAGES_FAILED', message: '会话不可用。' },
    })
    expect(context.agentCalls).toEqual([])
  })

  test('Given 坏节点旧会话仍在运行 When REBUILD Then 拒绝且不创建替代会话', async () => {
    const document = createDocument(4)
    document.nodes = [{
      id: 'node-1',
      kind: 'agent',
      title: '首页 Agent',
      position: { x: 0, y: 0 },
      agentSessionId: '22222222-2222-4222-8222-222222222222',
    }]
    const context = createContext({
      loadResult: {
        document,
        writable: true,
        nodeIssues: [{
          nodeId: 'node-1',
          code: 'AGENT_SESSION_UNAVAILABLE',
          allowedActions: ['rebuild-agent-session', 'remove-node'],
        }],
      },
      activeRunSnapshot: {
        owners: [],
        internalInvalidRuns: [{
          sessionId: '22222222-2222-4222-8222-222222222222',
          startedAt: 10,
          valid: false,
        }],
      },
    })

    const result = await invoke(context.handlers, CANVAS_IPC_CHANNELS.REBUILD_AGENT_NODE, context.sender, {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      nodeId: 'node-1',
      operationId: '11111111-1111-4111-8111-111111111111',
    }) as CanvasInvokeResult<RebuildCanvasAgentNodeResult>

    expect(result).toEqual({
      ok: false,
      error: { code: 'AGENT_SESSION_BUSY', message: '请先停止 Agent，再重建会话。' },
    })
    expect(context.calls).not.toContain('creation:rebuild')
  })

  test('Given 坏节点已停止 When REBUILD Then 换绑新会话并在 lease 外广播', async () => {
    const document = createDocument(4)
    document.nodes = [{
      id: 'node-1',
      kind: 'agent',
      title: '首页 Agent',
      position: { x: 0, y: 0 },
      agentSessionId: '22222222-2222-4222-8222-222222222222',
    }]
    const context = createContext({
      loadResult: {
        document,
        writable: true,
        nodeIssues: [{
          nodeId: 'node-1',
          code: 'AGENT_SESSION_UNAVAILABLE',
          allowedActions: ['rebuild-agent-session', 'remove-node'],
        }],
      },
    })
    const input = {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      nodeId: 'node-1',
      operationId: '11111111-1111-4111-8111-111111111111',
    }

    const result = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.REBUILD_AGENT_NODE,
      context.sender,
      input,
    ) as CanvasInvokeResult<RebuildCanvasAgentNodeResult>

    expect(result).toMatchObject({
      ok: true,
      value: {
        snapshot: { document: { revision: 5 }, nodeIssues: [] },
        session: { id: '44444444-4444-4444-8444-444444444444' },
      },
    })
    expect(context.calls).toEqual([
      'readonly:project-1',
      'guard:project-1',
      'batch:reconcile',
      'creation:reconcile',
      'creation:rebuild',
    ])
    expect(context.storeInputs.at(-1)).toEqual(input)
    expect(context.storeInputs.at(-1)).not.toBe(input)
    expect(context.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
    }])
    expect(context.broadcastLeaseStates).toEqual([false])
  })

  test('Given renderer 重载 When bootstrap active Canvas run Then 只返回最小 owner 与损坏会话安全代次', async () => {
    /** 主进程已经按忙碌状态和归属完成过滤的安全快照。 */
    const snapshot = {
      owners: [{
        sessionId: 'session-1', projectId: 'project-1', canvasId: 'canvas-1',
        nodeId: 'node-1', title: '首页 Agent', startedAt: 10,
      }],
      internalInvalidRuns: [{ sessionId: 'session-invalid', startedAt: 20, valid: false as const }],
    }
    const context = createContext({ activeRunSnapshot: snapshot })

    const result = await invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.LIST_ACTIVE_AGENT_RUNS,
      context.sender,
      undefined,
    )

    expect(result).toEqual(snapshot)
    expect(context.calls).toEqual([])
    expect(context.agentCalls).toEqual([])
  })

  test('Given 权威 Agent 节点 When GET/SEND/STOP Then 每次先对账并只使用节点引用 session', async () => {
    const document = createDocument(4)
    document.nodes = [{
      id: 'node-1', kind: 'agent', title: '首页 Agent', position: { x: 0, y: 0 },
      agentSessionId: '22222222-2222-4222-8222-222222222222',
    }]
    const context = createContext({ loadResult: { document, writable: true, nodeIssues: [] } })
    const target = { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1' }

    const loaded = await invoke(context.handlers, CANVAS_IPC_CHANNELS.GET_AGENT_MESSAGES, context.sender, target)
    const sent = await invoke(context.handlers, CANVAS_IPC_CHANNELS.SEND_AGENT_MESSAGE, context.sender, {
      ...target, message: '请分析当前项目', userMessageUuid: 'message-1', startedAt: 10,
    })
    const stopped = await invoke(context.handlers, CANVAS_IPC_CHANNELS.STOP_AGENT, context.sender, target)

    expect(loaded).toEqual({
      ok: true,
      value: {
        sessionId: '22222222-2222-4222-8222-222222222222',
        messages: [{ type: 'user', message: { content: [{ type: 'text', text: '已有消息' }] } }],
        owner: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', title: '首页 Agent' },
      },
    })
    expect(sent).toEqual({ ok: true, value: { ok: true } })
    expect(stopped).toEqual({ ok: true, value: undefined })
    expect(context.calls.filter((call) => call === 'batch:reconcile')).toHaveLength(3)
    expect(context.calls.filter((call) => call === 'creation:reconcile')).toHaveLength(3)
    /** 从真实运行记录中读取系统追加项，避免非对称 matcher 影响后续序列化断言。 */
    const runCall = context.agentCalls.find((call) => call.type === 'run')
    /** 运行扩展是主进程可信测试值，只收窄本测试需要的字段。 */
    const runValue = runCall?.value as {
      input?: { userMessage?: string; rawUserMessage?: string }
      extensions?: { systemPromptAppend?: string }
    } | undefined
    /** 完整 Canvas 场景说明必须以字符串进入 Agent runtime。 */
    const canvasSystemPrompt = runValue?.extensions?.systemPromptAppend
    expect(canvasSystemPrompt).toContain('当前会话已经位于原生 Canvas')
    expect(canvasSystemPrompt).toContain('不得要求用户创建、打开或切换到另一个 Design/Canvas')
    expect(context.agentCalls).toEqual([
      { type: 'messages', value: '22222222-2222-4222-8222-222222222222' },
      { type: 'reserve', value: {
        sessionId: '22222222-2222-4222-8222-222222222222',
        startedAt: 10,
      } },
      { type: 'run', value: {
        input: {
          sessionId: '22222222-2222-4222-8222-222222222222',
          userMessage: '请分析当前项目', rawUserMessage: '请分析当前项目',
          userMessageUuid: 'message-1', startedAt: 10,
          channelId: 'channel-1', modelId: 'model-1', workspaceId: 'project-1', triggeredBy: 'user',
        },
        senderId: 1,
        extensions: {
          allowedToolNames: ['Read', 'Glob', 'Grep'],
          systemPromptAppend: canvasSystemPrompt,
        },
      } },
      { type: 'release', value: '22222222-2222-4222-8222-222222222222' },
      { type: 'stop', value: '22222222-2222-4222-8222-222222222222' },
    ])
    expect(runCall).toMatchObject({
      value: {
        input: {
          userMessage: '请分析当前项目',
          rawUserMessage: '请分析当前项目',
        },
        extensions: {
          systemPromptAppend: canvasSystemPrompt,
        },
      },
    })
  })

  test('Given Canvas Agent 已在运行 When SEND 预留启动槽失败 Then 只返回稳定公开 busy 结果', async () => {
    const document = createDocument(4)
    document.nodes = [{
      id: 'node-1', kind: 'agent', title: '首页 Agent', position: { x: 0, y: 0 },
      agentSessionId: '22222222-2222-4222-8222-222222222222',
    }]
    /** 主进程内部 busy code 不得作为 Electron reject 细节泄露给 Renderer。 */
    const busyError = Object.assign(new Error('内部启动状态细节'), { code: 'AGENT_SESSION_BUSY' })
    const context = createContext({
      loadResult: { document, writable: true, nodeIssues: [] },
      reserveStartError: busyError,
    })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.SEND_AGENT_MESSAGE, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      message: '继续', userMessageUuid: 'message-1', startedAt: 10,
    })).resolves.toEqual({
      ok: true,
      value: {
        ok: false,
        error: { code: 'SESSION_BUSY', message: '会话正在运行，请先停止当前任务。' },
      },
    })
    expect(context.agentCalls).toEqual([
      { type: 'reserve', value: {
        sessionId: '22222222-2222-4222-8222-222222222222',
        startedAt: 10,
      } },
    ])
  })

  test('Given Canvas Agent 普通准入错误 When SEND 预留启动槽失败 Then 返回安全发送失败', async () => {
    const document = createDocument(4)
    document.nodes = [{
      id: 'node-1', kind: 'agent', title: '首页 Agent', position: { x: 0, y: 0 },
      agentSessionId: '22222222-2222-4222-8222-222222222222',
    }]
    /** 内部配置错误正文不得跨 IPC 暴露给 Renderer。 */
    const admissionError = new Error('模型配置缺失')
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext({
      loadResult: { document, writable: true, nodeIssues: [] },
      reserveStartError: admissionError,
    })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.SEND_AGENT_MESSAGE, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      message: '继续', userMessageUuid: 'message-1', startedAt: 10,
    })).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_AGENT_SEND_FAILED', message: '消息发送失败，请重试。' },
    })
    errorSpy.mockRestore()
  })

  test('Given Renderer 伪造 sessionId 或未知字段 When 调用 Canvas Agent IPC Then 在对账前拒绝', async () => {
    const context = createContext()
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.STOP_AGENT, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', sessionId: 'forged',
    })).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_AGENT_STOP_FAILED', message: '停止 Agent 失败，请重试。' },
    })
    expect(context.calls).toEqual([])
    expect(context.agentCalls).toEqual([])
    errorSpy.mockRestore()
  })

  test('Given 未授权 sender When 提交带 getter 的请求 Then 在解析和 Store 前拒绝', async () => {
    /** 未授权窗口不能触发 payload getter。 */
    const unauthorized = createSender(9)
    /** getter 访问次数必须保持为零。 */
    let getterReads = 0
    const input = Object.defineProperty({}, 'projectId', {
      enumerable: true,
      get: () => { getterReads += 1; return 'project-1' },
    })
    Object.defineProperty(input, 'canvasId', { enumerable: true, value: 'canvas-1' })
    const context = createContext({ authorized: [] })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, unauthorized, input))
      .resolves.toEqual({
        ok: false,
        error: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
      })
    expect(getterReads).toBe(0)
    expect(context.calls).toEqual([])
    errorSpy.mockRestore()
  })

  test('Given 非精确外层对象或非法身份和 revision When 调用 Then 全部在 guard 前拒绝', async () => {
    const context = createContext()
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const invalidCases: Array<{ channel: string; input: unknown }> = [
      { channel: CANVAS_IPC_CHANNELS.LOAD, input: { projectId: 'project-1', canvasId: 'canvas-1', path: '/tmp/x' } },
      { channel: CANVAS_IPC_CHANNELS.LOAD, input: { projectId: '../project', canvasId: 'canvas-1' } },
      { channel: CANVAS_IPC_CHANNELS.LOAD, input: Object.assign(Object.create({ inherited: true }), { projectId: 'project-1', canvasId: 'canvas-1' }) },
      { channel: CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, input: { projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: -1, mutations: [] } },
      { channel: CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, input: { projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 1.5, mutations: [] } },
      { channel: CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, input: { projectId: 'project-1', canvasId: 'bad/id', expectedRevision: 0, mutations: [] } },
      { channel: CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, input: { projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 0, mutations: {} } },
      { channel: CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, input: { projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 0, mutations: {}, extra: true } },
      { channel: CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, input: {
        projectId: 'project-1', canvasId: 'canvas-1', operationId: 'not-uuid',
        nodeId: 'node-1', title: 'Agent', position: { x: 0, y: 0 },
      } },
      { channel: CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, input: {
        projectId: 'p'.repeat(121), canvasId: 'canvas-1',
        operationId: '11111111-1111-4111-8111-111111111111',
        nodeId: 'node-1', title: 'Agent', position: { x: 0, y: 0 },
      } },
      { channel: CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, input: {
        projectId: 'project-1', canvasId: 'canvas-1',
        operationId: '11111111-1111-4111-8111-111111111111',
        nodeId: 'bad/node', title: 'Agent', position: { x: 0, y: 0 },
      } },
      { channel: CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, input: {
        projectId: 'project-1', canvasId: 'canvas-1',
        operationId: '11111111-1111-4111-8111-111111111111',
        nodeId: 'node-1', title: '', position: { x: Number.NaN, y: 0 }, extra: true,
      } },
    ]

    for (const item of invalidCases) {
      const result = await invoke(context.handlers, item.channel, context.sender, item.input)
      expect(result).toMatchObject({ ok: false })
    }
    expect(context.calls).toEqual([])
    expect(context.storeInputs).toEqual([])
    errorSpy.mockRestore()
  })

  test('Given 只读项目 When LOAD 或 SAVE Then 在 guard 和 Store 前返回安全失败', async () => {
    const context = createContext({ readOnlyReason: '项目路径不可访问' })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
    })
    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4, mutations: [],
    })).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_SAVE_FAILED', message: '画布暂时无法保存。' },
    })
    expect(context.calls).toEqual(['readonly:project-1', 'readonly:project-1'])
    expect(context.storeInputs).toEqual([])
    errorSpy.mockRestore()
  })

  test('Given 可写项目 When LOAD 和 SAVE Then guard 包裹 Store 且参数由 IPC 重建', async () => {
    const context = createContext()
    const mutations: CanvasMutation[] = [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }]
    const loadInput = Object.assign(Object.create(null) as object, { projectId: 'project-1', canvasId: 'canvas-1' })
    const saveInput = { projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4, mutations }

    await invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, loadInput)
    await invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, context.sender, saveInput)

    expect(context.calls).toEqual([
      'readonly:project-1', 'guard:project-1', 'batch:reconcile', 'content:load', 'creation:reconcile',
      'readonly:project-1', 'guard:project-1', 'batch:reconcile', 'creation:reconcile', 'store:mutate',
    ])
    expect(context.storeInputs[0]).toEqual({ projectId: 'project-1', canvasId: 'canvas-1' })
    expect(context.storeInputs[0]).not.toBe(loadInput)
    expect(context.storeInputs[2]).toEqual({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      expectedRevision: 4,
      mutations,
    })
  })

  test('Given 普通加载 When 成功 Then 返回公开快照且不广播', async () => {
    const snapshot = { document: createDocument(4), writable: true as const, nodeIssues: [] }
    const context = createContext({ loadResult: snapshot })

    expect(await invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })).toEqual({ ok: true, value: { ...snapshot, imagePreviews: [] } })
    expect(context.sender.sent).toEqual([])
  })

  test('Given tmp 或 backup 恢复可能得到低 revision When LOAD Then 广播双身份 recovery', async () => {
    for (const recoveredFrom of ['tmp', 'backup'] as const) {
      const context = createContext({
        loadResult: { document: createDocument(1), writable: true, nodeIssues: [], recoveredFrom },
      })
      await invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, {
        projectId: 'project-1', canvasId: 'canvas-1',
      })
      expect(context.sender.sent).toEqual([{
        channel: CANVAS_IPC_CHANNELS.CHANGED,
        value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' },
      }])
    }
  })

  test('Given SAVE 对账恢复到更低 revision 且后续保存失败 When lease 释放 Then 所有窗口仍仅收到 recovery', async () => {
    const sender = createSender(2)
    const observer = createSender(3)
    const error = new Error('保存 revision 冲突')
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext({
      authorized: [sender, observer],
      mutateError: error,
      reconcileResult: {
        snapshot: { document: createDocument(1), writable: true, nodeIssues: [], recoveredFrom: 'backup' },
        documentChanged: false,
      },
    })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 9, mutations: [],
    })).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_SAVE_FAILED', message: '画布暂时无法保存。' },
    })

    const expected = [{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' },
    }]
    expect(sender.sent).toEqual(expected)
    expect(observer.sent).toEqual(expected)
    expect(context.broadcastLeaseStates).toEqual([false, false])
    errorSpy.mockRestore()
  })

  test('Given CREATE 对账发生 recovery When 当前创建成功或失败 Then recovery 均优先于 graph 且只广播一次', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const createInput = {
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
    }
    for (const createError of [undefined, new Error('当前创建失败')]) {
      const context = createContext({
        createError,
        reconcileResult: {
          snapshot: { document: createDocument(1), writable: true, nodeIssues: [], recoveredFrom: 'tmp' },
          documentChanged: true,
        },
      })

      if (createError) {
        await expect(invoke(
          context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, createInput,
        )).resolves.toEqual({
          ok: false,
          error: { code: 'CANVAS_CREATE_FAILED', message: '节点创建失败，请重试。' },
        })
      } else {
        await invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, createInput)
      }
      const expected = [{
        channel: CANVAS_IPC_CHANNELS.CHANGED,
        value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' },
      }]
      if (!createError) expected.push({
        channel: CANVAS_IPC_CHANNELS.CHANGED,
        value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
      })
      expect(context.sender.sent).toEqual(expected)
      expect(context.broadcastLeaseStates).toEqual(expected.map(() => false))
    }
    errorSpy.mockRestore()
  })

  test('Given 有效保存或空保存 When Store 成功 Then 仅 revision 前进时广播 graph', async () => {
    const changed = createContext({ mutateResult: createDocument(5) })
    await invoke(changed.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, changed.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4,
      mutations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    })
    expect(changed.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
    }])

    const unchanged = createContext({ mutateResult: createDocument(4) })
    await invoke(unchanged.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, unchanged.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4, mutations: [],
    })
    expect(unchanged.sender.sent).toEqual([])
  })

  test('Given 有效创建请求 When intent committed 后返回 Then 广播准确双身份并隐藏内部字段', async () => {
    const context = createContext()
    const input = {
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
    }

    const result = await invoke(
      context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, input,
    ) as CanvasInvokeResult<CanvasAgentNodeCreationResult>

    expect(context.calls).toEqual([
      'readonly:project-1', 'guard:project-1', 'batch:reconcile', 'creation:create',
    ])
    expect(context.storeInputs[0]).toEqual(input)
    expect(context.storeInputs[0]).not.toBe(input)
    expect(result).not.toHaveProperty('value.documentChanged')
    expect(result).toHaveProperty('value.session.id', '22222222-2222-4222-8222-222222222222')
    expect(context.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
    }])
    expect(context.broadcastLeaseStates).toEqual([false])
  })

  test('Given 有效扩展创建请求 When IPC 重建输入 Then 保留源节点与稳定边 ID', async () => {
    const context = createContext()
    const input = {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-2',
      title: '下游 Agent',
      position: { x: 420, y: 20 },
      relationship: {
        sourceNodeId: 'node-1',
        edgeId: '33333333-3333-4333-8333-333333333333',
      },
    }

    await invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, input)

    expect(context.storeInputs[0]).toEqual(input)
    expect(context.storeInputs[0]).not.toBe(input)
  })

  test('Given 同一 Canvas 两个异步 CREATE When 首个尚未完成 Then 第二个等待完整事务释放', async () => {
    let createEntrances = 0
    let releaseFirst = (): void => {}
    const firstGate = new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise })
    const context = createContext({
      beforeCreate: async () => {
        createEntrances += 1
        if (createEntrances === 1) await firstGate
      },
    })
    const baseInput = {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      title: '首页 Agent',
      position: { x: 10, y: 20 },
    }
    const first = invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, {
      ...baseInput,
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1',
    })
    while (createEntrances === 0) await Promise.resolve()
    const second = invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, {
      ...baseInput,
      operationId: '33333333-3333-4333-8333-333333333333',
      nodeId: 'node-2',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(createEntrances).toBe(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(createEntrances).toBe(2)
  })

  test('Given Canvas A CREATE 阻塞 When Canvas B CREATE 进入 Then B 独立完成且无需等待 A', async () => {
    /** 只阻塞 Canvas A，用于证明队列键包含 canvasId。 */
    let releaseCanvasA = (): void => {}
    const canvasAGate = new Promise<void>((resolvePromise) => { releaseCanvasA = resolvePromise })
    const entrances: string[] = []
    const context = createContext({
      beforeCreate: async (input) => {
        entrances.push(input.canvasId)
        if (input.canvasId === 'canvas-a') await canvasAGate
      },
    })
    const createFor = (canvasId: string, operationId: string, nodeId: string) => invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
      context.sender,
      {
        projectId: 'project-1', canvasId, operationId, nodeId,
        title: '首页 Agent', position: { x: 10, y: 20 },
      },
    )
    const canvasA = createFor(
      'canvas-a', '11111111-1111-4111-8111-111111111111', 'node-a',
    )
    while (!entrances.includes('canvas-a')) await Promise.resolve()

    await expect(createFor(
      'canvas-b', '33333333-3333-4333-8333-333333333333', 'node-b',
    )).resolves.toBeDefined()
    expect(entrances).toEqual(['canvas-a', 'canvas-b'])

    releaseCanvasA()
    await canvasA
  })

  test('Given 文档已写但 committed intent 失败 When 创建返回错误 Then 不广播且不泄漏节点', async () => {
    const error = new Error('Canvas Agent 创建事务提交失败')
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext({ createError: error })

    await expect(invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
      context.sender,
      {
        projectId: 'project-1', canvasId: 'canvas-1',
        operationId: '11111111-1111-4111-8111-111111111111',
        nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
      },
    )).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_CREATE_FAILED', message: '节点创建失败，请重试。' },
    })
    expect(context.sender.sent).toEqual([])
    errorSpy.mockRestore()
  })

  test('Given committed intent 可见但持久性未确认 When CREATE 返回发布事实 Then lease 后广播再返回安全失败', async () => {
    const error = new Error('CANVAS_INTENT_DURABILITY_UNCERTAIN: 目录持久性未确认')
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext({
      createError: error,
      createPublication: createDocument(5),
    })

    await expect(invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
      context.sender,
      {
        projectId: 'project-1', canvasId: 'canvas-1',
        operationId: '11111111-1111-4111-8111-111111111111',
        nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
      },
    )).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_CREATE_FAILED', message: '节点创建失败，请重试。' },
    })
    expect(context.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
    }])
    expect(context.broadcastLeaseStates).toEqual([false])
    errorSpy.mockRestore()
  })

  test('Given committed 首次写失败 When 同 operation 重试越过发布屏障 Then 既有 revision 恰好广播一次', async () => {
    const error = new Error('Canvas Agent 创建事务提交失败')
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext({
      createErrorOnce: error,
      createDocumentChanged: false,
      retryReconcileResult: {
        snapshot: { document: createDocument(5), writable: true, nodeIssues: [] },
        documentChanged: true,
      },
    })
    const input = {
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
    }

    await expect(invoke(
      context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, input,
    )).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_CREATE_FAILED', message: '节点创建失败，请重试。' },
    })
    expect(context.sender.sent).toEqual([])

    await expect(invoke(
      context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, input,
    )).resolves.toBeDefined()
    expect(context.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
    }])
    errorSpy.mockRestore()
  })

  test('Given SAVE 对账已提交图变更 When 后续 revision conflict Then 广播对账 revision 并返回公开冲突', async () => {
    const error = new Error('CANVAS_REVISION_CONFLICT: expected=4, current=5')
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext({
      reconcileResult: {
        snapshot: { document: createDocument(5), writable: true, nodeIssues: [] },
        documentChanged: true,
      },
      mutateError: error,
    })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4, mutations: [],
    })).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_REVISION_CONFLICT', message: '画布已更新，请重新加载后重试。' },
    })
    expect(context.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
    }])
    errorSpy.mockRestore()
  })

  test('Given detached intent 已可见但目录持久性未确认 When LOAD 对账 Then 返回安全失败且不广播 graph', async () => {
    /** detached 不改变画布 revision，因此耐久性错误不能伪造图发布事实。 */
    const error = new Error('CANVAS_INTENT_DURABILITY_UNCERTAIN: 目录持久性未确认')
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext({
      reconcileResult: {
        snapshot: { document: createDocument(4), writable: true, nodeIssues: [] },
        documentChanged: false,
        error,
      },
    })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
    })
    expect(context.sender.sent).toEqual([])
    expect(context.broadcastLeaseStates).toEqual([])
    errorSpy.mockRestore()
  })

  test('Given CREATE 对账已提交图变更 When 新请求默认模型失败 Then 广播对账 revision 并返回安全失败', async () => {
    const error = new Error('Canvas Agent 需要先配置默认渠道')
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const context = createContext({
      reconcileResult: {
        snapshot: { document: createDocument(6), writable: true, nodeIssues: [] },
        documentChanged: true,
      },
      createError: error,
    })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
    })).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_CREATE_FAILED', message: '节点创建失败，请重试。' },
    })
    expect(context.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 6, cause: 'graph' },
    }])
    expect(context.calls).toEqual([
      'readonly:project-1', 'guard:project-1', 'batch:reconcile', 'creation:create',
    ])
    expect(context.broadcastLeaseStates).toEqual([false])
    errorSpy.mockRestore()
  })

  test('Given guard 或 Store 内部失败 When LOAD/SAVE Then 返回安全失败且不广播', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const guardError = new Error('工作区迁移中')
    const guarded = createContext({ guardError })
    await expect(invoke(guarded.handlers, CANVAS_IPC_CHANNELS.LOAD, guarded.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
    })
    expect(guarded.sender.sent).toEqual([])

    /** 恢复对账错误必须保留 Store 原始对象和完整消息。 */
    const recoveryError = new Error('CANVAS_RECOVERY_REQUIRED: promotion commit durability uncertain')
    const recoveryFailed = createContext({ loadError: recoveryError })
    await expect(invoke(recoveryFailed.handlers, CANVAS_IPC_CHANNELS.LOAD, recoveryFailed.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
    })
    expect(recoveryFailed.sender.sent).toEqual([])

    /** durability 不确定错误同样不能被 IPC 字符串重写。 */
    const storeError = new Error('CANVAS_COMMIT_UNCERTAIN: main durability requires reload')
    const failed = createContext({ mutateError: storeError })
    await expect(invoke(failed.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, failed.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4, mutations: [],
    })).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_SAVE_FAILED', message: '画布暂时无法保存。' },
    })
    expect(failed.sender.sent).toEqual([])
    errorSpy.mockRestore()
  })

  test('Given 单窗口发送失败 When Store 已提交 Then 请求仍成功且其它窗口收到事件', async () => {
    const failing = createSender(2)
    const receiving = createSender(3)
    failing.send = () => { throw new Error('窗口发送失败') }
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const context = createContext({ authorized: [failing, receiving], mutateResult: createDocument(5) })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, receiving, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4,
      mutations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    })).resolves.toEqual({ ok: true, value: createDocument(5) })
    expect(receiving.sent).toHaveLength(1)
    expect(errorSpy).toHaveBeenCalledWith(
      '[CanvasDocumentIPC] Canvas 变化广播失败:',
      expect.objectContaining({ message: '窗口发送失败' }),
    )
    errorSpy.mockRestore()
  })

  test('Given 已注册处理器 When 重复 dispose Then 仅移除十九个固定 invoke 通道一次', () => {
    const context = createContext()
    expect(context.registration.channels).toEqual([
      CANVAS_IPC_CHANNELS.LOAD,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      CANVAS_IPC_CHANNELS.SAVE_IMAGE_MODULE,
      CANVAS_IPC_CHANNELS.CREATE_IMAGE_JOB,
      CANVAS_IPC_CHANNELS.CANCEL_IMAGE_JOB,
      CANVAS_IPC_CHANNELS.RETRY_IMAGE_JOB,
      CANVAS_IPC_CHANNELS.ADOPT_IMAGE_ASSET,
      CANVAS_IPC_CHANNELS.RELEASE_IMAGE_MEDIA,
      CANVAS_IPC_CHANNELS.SAVE_MUTATIONS,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
      CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE,
      CANVAS_IPC_CHANNELS.DELETE_NODE,
      CANVAS_IPC_CHANNELS.LIST_TRASH,
      CANVAS_IPC_CHANNELS.RESTORE_NODE,
      CANVAS_IPC_CHANNELS.REBUILD_AGENT_NODE,
      CANVAS_IPC_CHANNELS.LIST_ACTIVE_AGENT_RUNS,
      CANVAS_IPC_CHANNELS.GET_AGENT_MESSAGES,
      CANVAS_IPC_CHANNELS.SEND_AGENT_MESSAGE,
      CANVAS_IPC_CHANNELS.STOP_AGENT,
    ])
    context.removed.length = 0

    context.registration.dispose()
    context.registration.dispose()

    expect(context.removed).toEqual([
      CANVAS_IPC_CHANNELS.LOAD,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      CANVAS_IPC_CHANNELS.SAVE_IMAGE_MODULE,
      CANVAS_IPC_CHANNELS.CREATE_IMAGE_JOB,
      CANVAS_IPC_CHANNELS.CANCEL_IMAGE_JOB,
      CANVAS_IPC_CHANNELS.RETRY_IMAGE_JOB,
      CANVAS_IPC_CHANNELS.ADOPT_IMAGE_ASSET,
      CANVAS_IPC_CHANNELS.RELEASE_IMAGE_MEDIA,
      CANVAS_IPC_CHANNELS.SAVE_MUTATIONS,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
      CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE,
      CANVAS_IPC_CHANNELS.DELETE_NODE,
      CANVAS_IPC_CHANNELS.LIST_TRASH,
      CANVAS_IPC_CHANNELS.RESTORE_NODE,
      CANVAS_IPC_CHANNELS.REBUILD_AGENT_NODE,
      CANVAS_IPC_CHANNELS.LIST_ACTIVE_AGENT_RUNS,
      CANVAS_IPC_CHANNELS.GET_AGENT_MESSAGES,
      CANVAS_IPC_CHANNELS.SEND_AGENT_MESSAGE,
      CANVAS_IPC_CHANNELS.STOP_AGENT,
    ])
  })

  test('Given 同一 registrar 连续注册 A 和 B When dispose A Then 不删除 B 的 handler', async () => {
    /** 两代注册共享的当前 handler 表。 */
    const handlers = new Map<string, TestHandler>()
    /** 记录每代注册和清理触发的通道移除。 */
    const removed: string[] = []
    /** 两代注册共享的授权主窗口。 */
    const sender = createSender(1)
    /** 模拟 Electron ipcMain 的稳定 registrar 对象。 */
    const ipc = {
      handle: (channel: string, handler: TestHandler): void => { handlers.set(channel, handler) },
      removeHandler: (channel: string): void => { removed.push(channel); handlers.delete(channel) },
    }
    /** 两代注册故意复用同一个 batch execute，验证清理按注册代次而不是函数身份。 */
    const executeBatch = async () => ({ document: createDocument(3), operationId: 'batch-operation' })
    /** 创建使用同一 registrar、但返回不同 revision 的注册依赖。 */
    const createOptions = (revision: number) => ({
      ipc,
      listAuthorizedWebContents: () => [sender],
      guard: {
        runWorkspaceWrite: <T>(_projectId: string, effect: () => T): T => effect(),
      },
      store: {
        loadWithDirectoryCapability: () => { throw new Error('测试未配置目录读取') },
        load: () => ({ document: createDocument(revision), writable: true as const, nodeIssues: [] }),
        mutate: () => createDocument(revision),
        validateBatchOperations: (_target: unknown, _expectedRevision: number, operations: unknown[]) => structuredClone(operations) as CanvasMutation[],
      },
      batch: {
        execute: executeBatch,
        reconcileLocked: async () => ({
          document: createDocument(revision), operationId: '', publications: [],
        }),
      },
      creation: {
        reconcile: async () => ({
          snapshot: { document: createDocument(revision), writable: true as const, nodeIssues: [] },
          documentChanged: false,
        }),
        createReconciled: async () => ({
          reconciliation: {
            snapshot: { document: createDocument(revision), writable: true as const, nodeIssues: [] },
            documentChanged: false,
          },
          operationOutcome: {
            ok: true as const,
            value: {
              document: createDocument(revision),
              session: { id: 'session-1', title: 'Agent', createdAt: 1, updatedAt: 1 },
              documentChanged: false,
            },
          },
        }),
        rebuildReconciled: async () => ({
          snapshot: {
            document: createDocument(revision),
            writable: true as const,
            nodeIssues: [],
          },
          session: { id: 'session-2', title: 'Agent', createdAt: 2, updatedAt: 2 },
          documentChanged: false,
        }),
      },
      contentLifecycle: {
        load: async () => ({
          snapshot: { document: createDocument(revision), writable: true as const, nodeIssues: [] },
          documentChanged: false,
        }),
        createReconciled: async () => ({ reconciliation: { snapshot: { document: createDocument(revision), writable: true as const, nodeIssues: [] }, documentChanged: false }, operationOutcome: { ok: true as const, value: { snapshot: { document: createDocument(revision), writable: true as const, nodeIssues: [] } } } }),
        deleteReconciled: async () => ({ reconciliation: { snapshot: { document: createDocument(revision), writable: true as const, nodeIssues: [] }, documentChanged: false }, operationOutcome: { ok: true as const, value: { snapshot: { document: createDocument(revision), writable: true as const, nodeIssues: [] } } } }),
        listTrashReconciled: async () => ({ reconciliation: { snapshot: { document: createDocument(revision), writable: true as const, nodeIssues: [] }, documentChanged: false }, operationOutcome: { ok: true as const, value: [] } }),
        restoreReconciled: async () => ({ reconciliation: { snapshot: { document: createDocument(revision), writable: true as const, nodeIssues: [] }, documentChanged: false }, operationOutcome: { ok: true as const, value: { snapshot: { document: createDocument(revision), writable: true as const, nodeIssues: [] } } } }),
      },
      imageModules: {
        load: async (target: CanvasImageTarget) => createImageConfig(target),
        save: async (input: SaveCanvasImageModuleInput) => createImageConfig(input, input.expectedConfigRevision + 1),
      },
      imageJobs: {
        createCanvasImage: async () => createImageJob(imageTargetA, 'job-created'),
        createCanvasImageOnce: async (_input: CreateDesignJobInput, jobId: string) => ({
          job: createImageJob(imageTargetA, jobId), created: true,
        }),
        run: async () => undefined,
        cancel: async () => createImageJob(imageTargetA, 'job-a'),
        retry: () => createImageJob(imageTargetA, 'job-retry'),
        getProjectJob: () => undefined,
        listCanvasImageJobs: () => [],
        onChanged: () => () => undefined,
      },
      imageJobTarget: {
        assertTarget: async () => undefined,
        adoptOutput: async () => undefined,
      },
      imageAssets: {
        list: () => [],
        createMediaAccess: () => ({
          assetBaseUrl: 'proma-file://assets',
          thumbnailBaseUrl: 'proma-file://thumbnails',
          release: () => undefined,
        }),
      },
      agent: {
        listActiveRuns: () => ({ owners: [], internalInvalidRuns: [] }),
        getSession: () => undefined,
        getMessages: () => [],
        reserveStart: () => () => undefined,
        run: async () => undefined,
        stop: () => undefined,
      },
      getProjectReadOnlyReason: () => undefined,
    })
    /** 被后续注册替代的旧 generation。 */
    const registrationA = registerCanvasDocumentIpcHandlers(createOptions(1))
    /** 当前拥有 handler 的新 generation。 */
    const registrationB = registerCanvasDocumentIpcHandlers(createOptions(2))
    expect(getCanvasToolProviderRuntime()).not.toBeNull()
    removed.length = 0

    registrationA.dispose()
    expect(getCanvasToolProviderRuntime()).not.toBeNull()

    await expect(invoke(handlers, CANVAS_IPC_CHANNELS.LOAD, sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })).resolves.toEqual({
      ok: true,
      value: { document: createDocument(2), writable: true, nodeIssues: [], imagePreviews: [] },
    })
    expect(removed).toEqual([])

    registrationB.dispose()
    expect(getCanvasToolProviderRuntime()).toBeNull()
    expect(handlers.size).toBe(0)
    expect(removed).toEqual([
      CANVAS_IPC_CHANNELS.LOAD,
      CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE,
      CANVAS_IPC_CHANNELS.SAVE_IMAGE_MODULE,
      CANVAS_IPC_CHANNELS.CREATE_IMAGE_JOB,
      CANVAS_IPC_CHANNELS.CANCEL_IMAGE_JOB,
      CANVAS_IPC_CHANNELS.RETRY_IMAGE_JOB,
      CANVAS_IPC_CHANNELS.ADOPT_IMAGE_ASSET,
      CANVAS_IPC_CHANNELS.RELEASE_IMAGE_MEDIA,
      CANVAS_IPC_CHANNELS.SAVE_MUTATIONS,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
      CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE,
      CANVAS_IPC_CHANNELS.DELETE_NODE,
      CANVAS_IPC_CHANNELS.LIST_TRASH,
      CANVAS_IPC_CHANNELS.RESTORE_NODE,
      CANVAS_IPC_CHANNELS.REBUILD_AGENT_NODE,
      CANVAS_IPC_CHANNELS.LIST_ACTIVE_AGENT_RUNS,
      CANVAS_IPC_CHANNELS.GET_AGENT_MESSAGES,
      CANVAS_IPC_CHANNELS.SEND_AGENT_MESSAGE,
      CANVAS_IPC_CHANNELS.STOP_AGENT,
    ])

    registrationA.dispose()
    expect(removed).toHaveLength(19)
  })

  test('Given 可运行图片节点 When 普通 Agent 预检 Then 校验目标与配置且不创建 Job', async () => {
    const context = createContext({ enableToolProviderRuntime: true })
    try {
      const runtime = getCanvasToolProviderRuntime()
      if (!runtime) throw new Error('Canvas Tool Provider runtime 未注册')
      await runtime.inspectNode({
        projectId: imageTargetA.projectId,
        sessionId: 'agent-session-1',
        runStartedAt: 99,
        explicitReferences: [],
        permissionCeiling: 'execute',
      }, {
        id: imageTargetA.nodeId,
        kind: 'image',
        title: '主视觉',
        position: { x: 0, y: 0 },
        imageModuleId: imageTargetA.imageModuleId,
      }, {
        projectId: imageTargetA.projectId,
        canvasId: imageTargetA.canvasId,
      })

      expect(context.imageCalls.map((call) => call.type)).toEqual(['assert-target', 'load'])
      expect(context.imageCalls.some((call) => call.type === 'create' || call.type === 'run')).toBe(false)
    } finally {
      context.registration.dispose()
    }
  })

  test('Given 相同 Agent Canvas 工具调用 When runtime 连续及重建后重放 Then 复用 SHA-256 taskId 且只运行一次', async () => {
    /** 模拟跨 runtime 仍由持久化 journal 复用的任务事实。 */
    const persistedJobs = new Map<string, DesignJobRecord>()
    let createCount = 0
    const createOnce = async (input: CreateDesignJobInput, jobId: string) => {
      const existing = persistedJobs.get(jobId)
      if (existing) return { job: existing, created: false }
      if (input.target?.kind !== 'canvas-image') throw new Error('Canvas 图片任务目标无效')
      const job = createImageJob({ projectId: input.projectId, ...input.target }, jobId)
      persistedJobs.set(jobId, job)
      createCount += 1
      return { job, created: true }
    }
    const identity = {
      sessionId: 'agent-session-1', runStartedAt: 99, toolCallId: 'tool-run-1',
      canvasId: imageTargetA.canvasId, nodeId: imageTargetA.nodeId,
    }
    const node = {
      id: imageTargetA.nodeId, kind: 'image' as const, title: '主视觉',
      position: { x: 0, y: 0 }, imageModuleId: imageTargetA.imageModuleId,
    }
    const target = { projectId: imageTargetA.projectId, canvasId: imageTargetA.canvasId }
    const firstContext = createContext({ enableToolProviderRuntime: true, imageCreateOnce: createOnce })
    let firstTaskId: string | undefined
    try {
      const runtime = getCanvasToolProviderRuntime()
      if (!runtime) throw new Error('Canvas Tool Provider runtime 未注册')
      firstTaskId = (await runtime.runNode(identity, node, target)).taskId
      expect((await runtime.runNode(identity, node, target)).taskId).toBe(firstTaskId)
      expect(firstContext.imageCalls.filter((call) => call.type === 'run')).toHaveLength(1)
    } finally {
      firstContext.registration.dispose()
    }

    const reloadedContext = createContext({ enableToolProviderRuntime: true, imageCreateOnce: createOnce })
    try {
      const runtime = getCanvasToolProviderRuntime()
      if (!runtime) throw new Error('Canvas Tool Provider runtime 未注册')
      expect((await runtime.runNode(identity, node, target)).taskId).toBe(firstTaskId)
      expect(reloadedContext.imageCalls.filter((call) => call.type === 'run')).toHaveLength(0)
    } finally {
      reloadedContext.registration.dispose()
    }
    expect(firstTaskId).toMatch(/^agent-canvas-[a-f0-9]{64}$/)
    expect(createCount).toBe(1)
  })
})
