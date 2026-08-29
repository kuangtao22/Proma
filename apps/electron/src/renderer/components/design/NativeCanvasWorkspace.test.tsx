import { describe, expect, mock, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type {
  CanvasAgentNodeCreationResult,
  CanvasChangeEvent,
  CanvasDocument,
  CanvasImageModuleConfig,
  CanvasImageModuleSnapshot,
  CanvasNodeLifecycleResult,
  CanvasMutation,
  CanvasNodeKind,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
  CreateCanvasAgentNodeInput,
  CreateCanvasContentNodeInput,
  DeleteCanvasNodeInput,
  DesignJobRecord,
  DesignTaskDetails,
  RebuildCanvasAgentNodeResult,
} from '@proma/shared'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { NativeCanvasState as GraphNativeCanvasState } from '@/atoms/native-canvas-atoms'
import {
  agentCanvasViewStatesAtom,
  createAgentCanvasViewKey,
  createAgentCanvasWorkbenchChangeUpdate as createNativeCanvasWorkbenchChangeUpdate,
  createInitialAgentCanvasViewState,
  removeAgentCanvasViewStateAtom,
  updateAgentCanvasViewStateAtom,
} from '@/atoms/agent-canvas-atoms'
import type { AgentCanvasViewState } from '@/atoms/agent-canvas-atoms'
import {
  canvasImageModuleStatesAtom,
  createInitialNativeCanvasState as createInitialGraphNativeCanvasState,
  createCanvasImageModuleKey,
  createInitialCanvasImageModuleState,
  createNativeCanvasKey,
  canvasAgentRunningSessionIdsAtom,
  nativeCanvasStatesAtom,
} from '@/atoms/native-canvas-atoms'
import {
  createInitialDesignProjectState,
  designProjectStatesAtom,
} from '@/atoms/design-atoms'
import { CanvasPublicOperationError } from '@/lib/design-adapter'
import {
  NATIVE_CANVAS_COMMIT_UNCERTAIN_CODE,
  NATIVE_CANVAS_RECOVERY_REQUIRED_CODE,
  NATIVE_CANVAS_REVISION_CONFLICT_CODE,
  NATIVE_CANVAS_SAVE_DEBOUNCE_MS,
  NATIVE_CANVAS_IMAGE_SAVE_DEBOUNCE_MS,
  NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
  NATIVE_CANVAS_WORKBENCH_CLOSE_TARGET,
  NativeCanvasWorkspace,
  createCanvasImageDraftAutoSaveController,
  createCanvasNodeCommandController,
  createCanvasAgentNodeCommandController,
  createCanvasAgentNodeRebuildController,
  createNativeCanvasWorkbenchDraftCommitCoordinator,
  createNativeCanvasWorkbenchCloseRequestUpdate,
  createNativeCanvasWorkbenchCleanupCoordinator,
  mountNativeCanvasSessionView,
  createNativeCanvasAgentNodeSuccessUpdate,
  createNativeCanvasNodeCreationSuccessUpdate,
  createNativeCanvasLifecycleSuccessUpdate,
  deleteNativeCanvasNodesSequentially,
  createResolvedNativeCanvasWorkbenchSwitchUpdate,
  getNativeCanvasWorkbenchCommitAvailability,
  createNativeCanvasWorkbenchDraftCommitterKey,
  findNativeCanvasAgentNodeCreationPosition,
  createRebuiltNativeCanvasStateUpdate,
  createStopAcceptedPendingCanvasDelete,
  settleNativeCanvasStopDeleteAttempt,
  createNativeCanvasWorkspaceController,
  getNativeCanvasConnectedEdgeCount,
  getPendingCanvasStopDeleteGenerationStatus,
  isPendingCanvasStopDeleteCurrent,
  runNativeCanvasToolbarAddNode,
  routeNativeCanvasWorkspaceMutation,
  commitCanvasImageDraftAndCreateJob,
} from './NativeCanvasWorkspace'
import type {
  CanvasAgentNodeCommandState,
  NativeCanvasScheduler,
  PendingCanvasStopDelete,
  NativeCanvasWorkspaceController,
  NativeCanvasWorkspaceControllerDependencies,
} from './NativeCanvasWorkspace'
import type { CanvasAgentConversationProps } from './CanvasAgentConversation'
import type { NativeCanvasFlowProps } from './NativeCanvasGraph'

/** 旧 controller 测试夹具同时承载迁移前视图字段，生产 NativeCanvasState 已不包含这些字段。 */
type NativeCanvasState = GraphNativeCanvasState & AgentCanvasViewState & {
  conversationNodeId: string | null
}

/** 为旧测试构造完整状态；新增状态隔离测试必须分别写入 graph/view atom。 */
function createInitialNativeCanvasState(): NativeCanvasState {
  return {
    ...createInitialGraphNativeCanvasState(),
    ...createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 1 }),
    conversationNodeId: null,
  } as NativeCanvasState
}

describe('Agent Canvas 共享图与独立视图', () => {
  test('Given 同一共享 Canvas 的两个 Agent 会话 When 渲染工作区 Then 共用 snapshot 且投影各自 viewport 与选区', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const graphKey = createNativeCanvasKey(target.projectId, target.canvasId)
    const firstViewKey = createAgentCanvasViewKey('session-a', target.projectId, target.canvasId)
    const secondViewKey = createAgentCanvasViewKey('session-b', target.projectId, target.canvasId)
    const snapshot = createSnapshot(7, target)
    snapshot.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent 1', agentSessionId: 'agent-node-session', position: { x: 0, y: 0 },
    }]
    const store = createStore()
    store.set(nativeCanvasStatesAtom, new Map([[graphKey, {
      ...createInitialNativeCanvasState(),
      phase: 'ready',
      snapshot,
    }]]))
    store.set(agentCanvasViewStatesAtom, new Map([
      [firstViewKey, {
        ...createInitialAgentCanvasViewState(snapshot.document.viewport),
        viewport: { x: 10, y: 20, zoom: 1.2 },
        selectedNodeId: 'agent-1',
        selectedNodeIds: ['agent-1'],
      }],
      [secondViewKey, {
        ...createInitialAgentCanvasViewState(snapshot.document.viewport),
        viewport: { x: 90, y: 80, zoom: 1.8 },
        selectedNodeId: null,
        selectedNodeIds: [],
      }],
    ]))
    const rendered: Array<Pick<NativeCanvasFlowProps, 'nodes' | 'viewport'>> = []
    const flowRenderer = (props: NativeCanvasFlowProps) => {
      rendered.push({ nodes: props.nodes, viewport: props.viewport })
      return <div />
    }
    const adapter = {
      loadCanvas: async () => snapshot,
      saveCanvas: async () => snapshot.document,
      onCanvasChanged: () => () => {},
    }

    renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          sessionId="session-a"
          target={target}
          title="共享 Canvas"
          adapter={adapter}
          flowRenderer={flowRenderer}
        />
      </Provider>,
    )
    renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          sessionId="session-b"
          target={target}
          title="共享 Canvas"
          adapter={adapter}
          flowRenderer={flowRenderer}
        />
      </Provider>,
    )

    expect(store.get(nativeCanvasStatesAtom).get(graphKey)?.snapshot).toBe(snapshot)
    expect(rendered[0]?.viewport).toEqual({ x: 10, y: 20, zoom: 1.2 })
    expect(rendered[0]?.nodes.find((node) => node.id === 'agent-1')?.selected).toBe(true)
    expect(rendered[1]?.viewport).toEqual({ x: 90, y: 80, zoom: 1.8 })
    expect(rendered[1]?.nodes.find((node) => node.id === 'agent-1')?.selected).toBe(false)
  })

  test('Given 已加载共享图 When 更新会话 viewport Then 不产生 graph mutation 且 revision 保持不变', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const graphKey = createNativeCanvasKey(target.projectId, target.canvasId)
    const viewKey = createAgentCanvasViewKey('session-a', target.projectId, target.canvasId)
    const snapshot = createSnapshot(4, target)
    const store = createStore()
    store.set(nativeCanvasStatesAtom, new Map([[graphKey, {
      ...createInitialNativeCanvasState(),
      phase: 'ready',
      snapshot,
    }]]))
    store.set(agentCanvasViewStatesAtom, new Map([[
      viewKey,
      createInitialAgentCanvasViewState(snapshot.document.viewport),
    ]]))
    const graphMutations: CanvasMutation[] = []

    routeNativeCanvasWorkspaceMutation(
      { type: 'set-viewport', viewport: { x: 45, y: 60, zoom: 1.4 } },
      (update) => store.set(updateAgentCanvasViewStateAtom, { key: viewKey, update }),
      (mutation) => graphMutations.push(mutation),
    )

    const graphState = store.get(nativeCanvasStatesAtom).get(graphKey)
    expect(store.get(agentCanvasViewStatesAtom).get(viewKey)?.viewport)
      .toEqual({ x: 45, y: 60, zoom: 1.4 })
    expect(graphMutations).toEqual([])
    expect(graphState?.pendingMutations).toEqual([])
    expect(graphState?.snapshot?.document.revision).toBe(4)
    expect(graphState?.snapshot?.document.viewport).toEqual(snapshot.document.viewport)
  })
})

describe('原生 Canvas 顶部添加节点路由', () => {
  test.each<CanvasNodeKind>(['agent', 'image', 'document', 'webview'])(
    'Given 选择 %s When 路由顶部添加命令 Then 原样传递节点类型',
    (kind) => {
      const execute = mock((_request: { kind: CanvasNodeKind }) => undefined)

      runNativeCanvasToolbarAddNode(kind, execute)

      expect(execute).toHaveBeenCalledWith({ kind })
    },
  )
})

describe('原生 Canvas 批量删除', () => {
  test('Given 框选两个节点 When 确认删除 Then 按最新 revision 串行提交独立 operation', async () => {
    const requests: DeleteCanvasNodeInput[] = []
    const deletedNodeIds: string[] = []
    const operationIds = ['operation-delete-1', 'operation-delete-2']

    const result = await deleteNativeCanvasNodesSequentially({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      nodeIds: ['agent-1', 'image-1'],
      initialRevision: 7,
      createOperationId: () => operationIds.shift()!,
      deleteNode: async (input) => {
        requests.push(input)
        return { snapshot: createSnapshot(input.expectedRevision + 1) }
      },
      onDeleted: (nodeId) => deletedNodeIds.push(nodeId),
    })

    expect(requests.map(({ nodeId, operationId, expectedRevision }) => ({
      nodeId,
      operationId,
      expectedRevision,
    }))).toEqual([
      { nodeId: 'agent-1', operationId: 'operation-delete-1', expectedRevision: 7 },
      { nodeId: 'image-1', operationId: 'operation-delete-2', expectedRevision: 8 },
    ])
    expect(deletedNodeIds).toEqual(['agent-1', 'image-1'])
    expect(result).toMatchObject({
      deletedNodeIds: ['agent-1', 'image-1'],
      remainingNodeIds: [],
      error: null,
    })
  })

  test('Given 第二个节点删除失败 When 批量提交 Then 保留已成功结果和剩余选区', async () => {
    const deletedNodeIds: string[] = []
    let attempts = 0
    const result = await deleteNativeCanvasNodesSequentially({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      nodeIds: ['document-1', 'webview-1'],
      initialRevision: 4,
      createOperationId: () => `operation-${attempts + 1}`,
      deleteNode: async (input) => {
        attempts += 1
        if (input.nodeId === 'webview-1') throw new Error('删除失败')
        return { snapshot: createSnapshot(input.expectedRevision + 1) }
      },
      onDeleted: (nodeId) => deletedNodeIds.push(nodeId),
    })

    expect(deletedNodeIds).toEqual(['document-1'])
    expect(result.deletedNodeIds).toEqual(['document-1'])
    expect(result.remainingNodeIds).toEqual(['webview-1'])
    expect(result.error).toBeInstanceOf(Error)
  })
})

describe('Canvas 生图工作台接入', () => {
  test('Given 连续修改图片配置 When 短延迟结束 Then 合并为一次自动保存', async () => {
    const callbacks = new Map<number, () => void>()
    const cleared: number[] = []
    const commits: string[] = []
    let nextTimerId = 0
    const controller = createCanvasImageDraftAutoSaveController({
      scheduler: {
        setTimeout: (callback, delayMs) => {
          expect(delayMs).toBe(NATIVE_CANVAS_IMAGE_SAVE_DEBOUNCE_MS)
          const timerId = ++nextTimerId
          callbacks.set(timerId, callback)
          return timerId
        },
        clearTimeout: (timerId) => {
          cleared.push(timerId)
          callbacks.delete(timerId)
        },
      },
      commitDraft: async () => {
        commits.push('save-image-config')
        return null
      },
    })

    controller.schedule({
      prompt: '首页第一版', selectedModelProfileId: 'profile-1', aspectRatio: '16:9',
      imageSize: '2K', contextMode: 'project', dirty: true,
    }, 'dirty')
    controller.schedule({
      prompt: '首页第二版', selectedModelProfileId: 'profile-1', aspectRatio: '16:9',
      imageSize: '2K', contextMode: 'project', dirty: true,
    }, 'dirty')

    expect(cleared).toEqual([1])
    callbacks.get(2)?.()
    await Promise.resolve()
    expect(commits).toEqual(['save-image-config'])
  })

  test('Given dirty 图片草稿 When 生成 Then 严格先保存再创建任务', async () => {
    const calls: string[] = []
    const config = { revision: 2 } as CanvasImageModuleConfig

    await commitCanvasImageDraftAndCreateJob({
      commitDraft: async () => {
        calls.push('save-image-config')
        return config
      },
      createJob: async () => {
        calls.push('create-image-job')
        return { id: 'job-1' } as DesignJobRecord
      },
    })

    expect(calls).toEqual(['save-image-config', 'create-image-job'])
  })

  test('Given 图片配置保存失败 When 生成 Then 不创建付费任务', async () => {
    let createJobCalls = 0

    await expect(commitCanvasImageDraftAndCreateJob({
      commitDraft: async () => {
        throw new Error('保存失败')
      },
      createJob: async () => {
        createJobCalls += 1
        return { id: 'job-1' } as DesignJobRecord
      },
    })).rejects.toThrow('保存失败')

    expect(createJobCalls).toBe(0)
  })

  test('Given 展开 image 节点 When 渲染 Then 挂载真实工作台且不显示占位文字', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const imageTarget = { ...target, nodeId: 'image-1', imageModuleId: 'module-1' }
    const snapshot = createSnapshot(3, target)
    snapshot.document.nodes = [{
      id: imageTarget.nodeId,
      kind: 'image',
      title: '首页视觉',
      imageModuleId: imageTarget.imageModuleId,
      position: { x: 0, y: 0 },
    }]
    const imageSnapshot: CanvasImageModuleSnapshot = {
      target: imageTarget,
      mediaLeaseId: 'lease-module-1',
      config: {
        schemaVersion: 2,
        kind: 'image',
        contentId: imageTarget.imageModuleId,
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
        prompt: '生成首页效果图',
        selectedModelProfileId: 'profile-1',
        aspectRatio: '16:9',
        imageSize: '2K',
        contextMode: 'project',
        adoptedAssetId: null,
      },
      jobs: [],
      assets: [],
      assetBaseUrl: 'proma-file://assets',
      thumbnailBaseUrl: 'proma-file://thumbnails',
    }
    const store = createStore()
    const workspaceKey = createNativeCanvasKey(target.projectId, target.canvasId)
    const imageKey = createCanvasImageModuleKey(imageTarget)
    store.set(nativeCanvasStatesAtom, new Map([[workspaceKey, {
      ...createInitialNativeCanvasState(),
      phase: 'ready',
      snapshot,
      selectedNodeId: imageTarget.nodeId,
      expandedNodeId: imageTarget.nodeId,
    }]]))
    store.set(canvasImageModuleStatesAtom, new Map([[imageKey, {
      ...createInitialCanvasImageModuleState(),
      phase: 'ready',
      snapshot: imageSnapshot,
      draft: {
        prompt: imageSnapshot.config.prompt,
        selectedModelProfileId: imageSnapshot.config.selectedModelProfileId,
        aspectRatio: imageSnapshot.config.aspectRatio,
        imageSize: imageSnapshot.config.imageSize,
        contextMode: imageSnapshot.config.contextMode,
        dirty: false,
      },
    }]]))
    store.set(designProjectStatesAtom, new Map([[target.projectId, {
      ...createInitialDesignProjectState(),
      imageModelLoadState: 'ready',
      imageModelProfileId: 'profile-1',
      imageModelOptions: [{
        profileId: 'profile-1',
        name: 'GPT Image 2',
        modelId: 'gpt-image-2',
        executor: 'openai-images',
        channelId: 'channel-1',
        available: true,
      }],
    }]]))
    const job = { id: 'job-1' } as DesignJobRecord
    const taskDetails = {
      creativeTaskId: 'creative-1', currentJobId: 'job-1', attempts: [], traceState: 'ready',
    } satisfies DesignTaskDetails

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          sessionId="legacy-test-session"
          target={target}
          title="首页 Canvas"
          adapter={{
            loadCanvas: async () => snapshot,
            saveCanvas: async () => snapshot.document,
            onCanvasChanged: () => () => {},
            loadCanvasImageModule: async () => imageSnapshot,
            saveCanvasImageModule: async () => imageSnapshot.config,
            createCanvasImageJob: async () => job,
            cancelCanvasImageJob: async () => job,
            retryCanvasImageJob: async () => job,
            adoptCanvasImageAsset: async () => imageSnapshot.config,
            releaseCanvasImageMedia: async () => undefined,
            onCanvasImageModuleChanged: () => () => {},
            getTaskDetails: async () => taskDetails,
            getTaskTrace: async () => taskDetails,
            getImageModelSelection: async () => ({
              projectId: target.projectId,
              selectedProfileId: 'profile-1',
              options: [],
            }),
            setImageModelSelection: async () => ({
              projectId: target.projectId,
              selectedProfileId: 'profile-1',
              options: [],
            }),
            onImageModelProfilesChanged: () => () => {},
            onImageModelSelectionChanged: () => () => {},
          }}
          flowRenderer={(props) => <>{props.nodes[0]?.data.workbench}</>}
        />
      </Provider>,
    )

    expect(html).toContain('生成图片')
    expect(html).toContain('提示词')
    expect(html).not.toContain('生图节点已创建')
  })
})

describe('原生 Canvas 单工作台切换', () => {
  test('Given 两个 Canvas 含同名节点 When 创建提交器键 Then Workspace 身份保持隔离', () => {
    const first = createNativeCanvasWorkbenchDraftCommitterKey('project-1:canvas-a', 'image-1')
    const second = createNativeCanvasWorkbenchDraftCommitterKey('project-1:canvas-b', 'image-1')

    expect(first).not.toBe(second)
  })

  test('Given 文档工作台有未保存草稿 When 请求展开原型 Then 只登记待切换且不改变图', () => {
    const current = createInitialNativeCanvasState()
    current.snapshot = createSnapshot(4)
    current.expandedNodeId = 'node-document'
    current.workbenchDraft = { nodeId: 'node-document', dirty: true }
    const beforeDocument = structuredClone(current.snapshot.document)

    const update = createNativeCanvasWorkbenchChangeUpdate(current, 'node-webview')
    const updated = { ...current, ...update }

    expect(updated).toMatchObject({
      expandedNodeId: 'node-document',
      pendingWorkbenchSwitchNodeId: 'node-webview',
      workbenchDraft: { nodeId: 'node-document', dirty: true },
    })
    expect(updated.snapshot?.document).toEqual(beforeDocument)
    expect(updated.pendingMutations).toEqual([])
  })

  test('Given 图片工作台有未保存草稿 When 请求关闭 Then 登记关闭目标并保留当前内容', () => {
    const current = createInitialNativeCanvasState()
    current.expandedNodeId = 'node-image'
    current.workbenchDraft = { nodeId: 'node-image', dirty: true }

    expect(createNativeCanvasWorkbenchCloseRequestUpdate(current)).toEqual({
      pendingWorkbenchSwitchNodeId: NATIVE_CANVAS_WORKBENCH_CLOSE_TARGET,
    })
    expect(createResolvedNativeCanvasWorkbenchSwitchUpdate({
      ...current,
      pendingWorkbenchSwitchNodeId: NATIVE_CANVAS_WORKBENCH_CLOSE_TARGET,
    })).toEqual({
      expandedNodeId: null,
      pendingWorkbenchSwitchNodeId: null,
      workbenchDraft: null,
    })
  })

  test('Given 当前工作台没有未保存草稿 When 请求关闭 Then 立即关闭', () => {
    const current = createInitialNativeCanvasState()
    current.expandedNodeId = 'node-image'

    expect(createNativeCanvasWorkbenchCloseRequestUpdate(current)).toEqual({
      expandedNodeId: null,
      pendingWorkbenchSwitchNodeId: null,
      workbenchDraft: null,
    })
  })

  test('Given 已确认放弃草稿 When 完成切换 Then 同时只保留目标工作台', () => {
    const current = createInitialNativeCanvasState()
    current.expandedNodeId = 'node-document'
    current.pendingWorkbenchSwitchNodeId = 'node-webview'
    current.workbenchDraft = { nodeId: 'node-document', dirty: true }

    expect(createResolvedNativeCanvasWorkbenchSwitchUpdate(current)).toEqual({
      expandedNodeId: 'node-webview',
      pendingWorkbenchSwitchNodeId: null,
      workbenchDraft: null,
    })
  })

  test('Given 当前 dirty 工作台未注册提交器 When 显示切换确认 Then 保存不可用且说明原因', () => {
    expect(getNativeCanvasWorkbenchCommitAvailability('node-document', undefined)).toEqual({
      enabled: false,
      reason: '当前工作台未注册保存能力，暂时不能保存并切换。',
    })
    expect(getNativeCanvasWorkbenchCommitAvailability('node-document', {
      nodeId: 'node-document',
      commitDraft: async () => undefined,
    })).toEqual({ enabled: true, reason: null })
  })

  /** 创建使用真实 Jotai 状态的草稿保存协调测试环境。 */
  function createDraftCommitHarness() {
    const store = createStore()
    const firstKey = createNativeCanvasKey('project-1', 'canvas-1')
    const secondKey = createNativeCanvasKey('project-1', 'canvas-2')
    let activeKey = firstKey
    let saving = false
    const errors: string[] = []
    const settled: string[] = []
    const coordinator = createNativeCanvasWorkbenchDraftCommitCoordinator({
      getCurrentWorkspaceKey: () => activeKey,
      getState: (key) => store.get(agentCanvasViewStatesAtom).get(key),
      onSuccess: ({ stateKey }) => {
        store.set(agentCanvasViewStatesAtom, new Map(store.get(agentCanvasViewStatesAtom)).set(
          stateKey,
          {
            ...store.get(agentCanvasViewStatesAtom).get(stateKey)!,
            ...createResolvedNativeCanvasWorkbenchSwitchUpdate(
              store.get(agentCanvasViewStatesAtom).get(stateKey)!,
            ),
          },
        ))
      },
      onFailure: () => errors.push('保存草稿失败，请重试。'),
      onSettled: ({ targetNodeId }) => {
        saving = false
        settled.push(targetNodeId)
      },
    })
    const setWorkbench = (
      key: string,
      expandedNodeId: string,
      pendingWorkbenchSwitchNodeId: string,
      draftNodeId = expandedNodeId,
    ): void => {
      store.set(agentCanvasViewStatesAtom, new Map(store.get(agentCanvasViewStatesAtom)).set(key, {
        ...createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 1 }),
        expandedNodeId,
        pendingWorkbenchSwitchNodeId,
        workbenchDraft: { nodeId: draftNodeId, dirty: true },
      }))
    }
    return {
      coordinator,
      errors,
      firstKey,
      secondKey,
      settled,
      store,
      getSaving: () => saving,
      setSaving: (value: boolean) => { saving = value },
      setActiveKey: (key: string) => { activeKey = key },
      setWorkbench,
    }
  }

  test('Given 旧保存仍在途 When Canvas 已切换且新工作台已有草稿 Then 旧 resolve 不关闭或清理新状态', async () => {
    const harness = createDraftCommitHarness()
    const deferred = createDeferred<void>()
    harness.setWorkbench(harness.firstKey, 'document-old', 'webview-old')
    const execution = harness.coordinator.execute({
      stateKey: harness.firstKey,
      sourceExpandedNodeId: 'document-old',
      sourceDraftNodeId: 'document-old',
      targetNodeId: 'webview-old',
      commitDraft: () => deferred.promise,
    })

    harness.coordinator.invalidate()
    harness.setActiveKey(harness.secondKey)
    harness.setWorkbench(harness.secondKey, 'document-new', 'image-new')
    deferred.resolve()
    await execution

    expect(harness.store.get(agentCanvasViewStatesAtom).get(harness.secondKey)).toMatchObject({
      expandedNodeId: 'document-new',
      pendingWorkbenchSwitchNodeId: 'image-new',
      workbenchDraft: { nodeId: 'document-new', dirty: true },
    })
    expect(harness.settled).toEqual([])
  })

  test('Given 旧保存仍在途 When 操作已失效 Then 旧 reject 不污染新工作台错误或保存状态', async () => {
    const harness = createDraftCommitHarness()
    const deferred = createDeferred<void>()
    harness.setWorkbench(harness.firstKey, 'document-old', 'webview-old')
    const execution = harness.coordinator.execute({
      stateKey: harness.firstKey,
      sourceExpandedNodeId: 'document-old',
      sourceDraftNodeId: 'document-old',
      targetNodeId: 'webview-old',
      commitDraft: () => deferred.promise,
    })

    harness.coordinator.invalidate()
    harness.setWorkbench(harness.firstKey, 'document-new', 'image-new')
    deferred.reject(new Error('旧保存失败'))
    await execution

    expect(harness.errors).toEqual([])
    expect(harness.settled).toEqual([])
    expect(harness.store.get(agentCanvasViewStatesAtom).get(harness.firstKey)).toMatchObject({
      expandedNodeId: 'document-new',
      pendingWorkbenchSwitchNodeId: 'image-new',
      workbenchDraft: { nodeId: 'document-new', dirty: true },
    })
  })

  test('Given 保存身份与代次均匹配 When commit resolve Then 正常切换并结束保存态', async () => {
    const harness = createDraftCommitHarness()
    const deferred = createDeferred<void>()
    harness.setWorkbench(harness.firstKey, 'document-1', 'webview-1')
    const execution = harness.coordinator.execute({
      stateKey: harness.firstKey,
      sourceExpandedNodeId: 'document-1',
      sourceDraftNodeId: 'document-1',
      targetNodeId: 'webview-1',
      commitDraft: () => deferred.promise,
    })

    deferred.resolve()
    await execution

    expect(harness.store.get(agentCanvasViewStatesAtom).get(harness.firstKey)).toMatchObject({
      expandedNodeId: 'webview-1',
      pendingWorkbenchSwitchNodeId: null,
      workbenchDraft: null,
    })
    expect(harness.errors).toEqual([])
    expect(harness.settled).toEqual(['webview-1'])
  })

  test.each([
    { outcome: 'resolve' as const },
    { outcome: 'reject' as const },
  ])('Given 保存 B 期间通知把目标改为 C When 旧 Promise $outcome Then 不切节点但收口当前 saving', async ({ outcome }) => {
    const harness = createDraftCommitHarness()
    const deferred = createDeferred<void>()
    harness.setWorkbench(harness.firstKey, 'document-1', 'webview-b')
    harness.setSaving(true)
    const execution = harness.coordinator.execute({
      stateKey: harness.firstKey,
      sourceExpandedNodeId: 'document-1',
      sourceDraftNodeId: 'document-1',
      targetNodeId: 'webview-b',
      commitDraft: () => deferred.promise,
    })

    harness.setWorkbench(harness.firstKey, 'document-1', 'webview-c')
    if (outcome === 'resolve') deferred.resolve()
    else deferred.reject(new Error('旧保存失败'))
    await execution

    expect(harness.store.get(agentCanvasViewStatesAtom).get(harness.firstKey)).toMatchObject({
      expandedNodeId: 'document-1',
      pendingWorkbenchSwitchNodeId: 'webview-c',
      workbenchDraft: { nodeId: 'document-1', dirty: true },
    })
    expect(harness.errors).toEqual([])
    expect(harness.getSaving()).toBe(false)
    expect(harness.settled).toEqual(['webview-b'])
  })

  test('Given LOAD 已删除保存源节点 When 旧 Promise settle Then 不恢复身份但收口当前 saving', async () => {
    const harness = createDraftCommitHarness()
    const deferred = createDeferred<void>()
    harness.setWorkbench(harness.firstKey, 'document-1', 'webview-1')
    harness.setSaving(true)
    const execution = harness.coordinator.execute({
      stateKey: harness.firstKey,
      sourceExpandedNodeId: 'document-1',
      sourceDraftNodeId: 'document-1',
      targetNodeId: 'webview-1',
      commitDraft: () => deferred.promise,
    })

    harness.store.set(agentCanvasViewStatesAtom, new Map([[
      harness.firstKey,
      createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 1 }),
    ]]))
    deferred.resolve()
    await execution

    expect(harness.store.get(agentCanvasViewStatesAtom).get(harness.firstKey)).toMatchObject({
      expandedNodeId: null,
      pendingWorkbenchSwitchNodeId: null,
      workbenchDraft: null,
    })
    expect(harness.getSaving()).toBe(false)
    expect(harness.settled).toEqual(['webview-1'])
  })

  test('Given 新 generation 已接管 saving When 旧 Promise settle Then 不关闭新 saving', async () => {
    const harness = createDraftCommitHarness()
    const firstDeferred = createDeferred<void>()
    const secondDeferred = createDeferred<void>()
    harness.setWorkbench(harness.firstKey, 'document-1', 'webview-1')
    harness.setSaving(true)
    const firstExecution = harness.coordinator.execute({
      stateKey: harness.firstKey,
      sourceExpandedNodeId: 'document-1',
      sourceDraftNodeId: 'document-1',
      targetNodeId: 'webview-1',
      commitDraft: () => firstDeferred.promise,
    })
    const secondExecution = harness.coordinator.execute({
      stateKey: harness.firstKey,
      sourceExpandedNodeId: 'document-1',
      sourceDraftNodeId: 'document-1',
      targetNodeId: 'webview-1',
      commitDraft: () => secondDeferred.promise,
    })

    firstDeferred.resolve()
    await firstExecution

    expect(harness.getSaving()).toBe(true)
    expect(harness.settled).toEqual([])
    secondDeferred.resolve()
    await secondExecution
  })

  test('Given Workspace 已真实卸载 When 旧 Promise settle Then 不再更新本地 saving', async () => {
    const harness = createDraftCommitHarness()
    const deferred = createDeferred<void>()
    harness.setWorkbench(harness.firstKey, 'document-1', 'webview-1')
    harness.setSaving(true)
    const execution = harness.coordinator.execute({
      stateKey: harness.firstKey,
      sourceExpandedNodeId: 'document-1',
      sourceDraftNodeId: 'document-1',
      targetNodeId: 'webview-1',
      commitDraft: () => deferred.promise,
    })

    harness.coordinator.invalidate()
    deferred.resolve()
    await execution

    expect(harness.getSaving()).toBe(true)
    expect(harness.settled).toEqual([])
  })
})

describe('原生 Canvas 工作台卸载清理协调', () => {
  /** 创建可手动推进的微任务队列。 */
  function createCleanupHarness() {
    const tasks: Array<() => void> = []
    const cleared: string[] = []
    const coordinator = createNativeCanvasWorkbenchCleanupCoordinator((task) => tasks.push(task))
    const flush = (): void => {
      while (tasks.length > 0) tasks.shift()?.()
    }
    return { coordinator, cleared, flush }
  }

  test('Given StrictMode 同 key cleanup 后立即 setup When 微任务执行 Then 不清理新挂载状态', () => {
    const harness = createCleanupHarness()
    const disposeFirst = harness.coordinator.mount('project-1:canvas-1', () => {
      harness.cleared.push('first')
    })

    disposeFirst()
    const disposeSecond = harness.coordinator.mount('project-1:canvas-1', () => {
      harness.cleared.push('second')
    })
    harness.flush()

    expect(harness.cleared).toEqual([])
    disposeSecond()
    harness.flush()
    expect(harness.cleared).toEqual(['second'])
  })

  test('Given 工作台真实卸载 When 微任务执行 Then 清理一次', () => {
    const harness = createCleanupHarness()
    const dispose = harness.coordinator.mount('project-1:canvas-1', () => {
      harness.cleared.push('canvas-1')
    })

    dispose()
    dispose()
    harness.flush()

    expect(harness.cleared).toEqual(['canvas-1'])
  })

  test('Given 两个会话挂载同一共享图 When 当前会话真实卸载 Then 只删除当前 view 并保留 graph 与另一 view', () => {
    const harness = createCleanupHarness()
    const store = createStore()
    const graphKey = createNativeCanvasKey('project-1', 'canvas-1')
    const firstViewKey = createAgentCanvasViewKey('session-a', 'project-1', 'canvas-1')
    const secondViewKey = createAgentCanvasViewKey('session-b', 'project-1', 'canvas-1')
    const graphState = {
      ...createInitialGraphNativeCanvasState(),
      phase: 'ready' as const,
      snapshot: createSnapshot(1),
    }
    const secondViewState = createInitialAgentCanvasViewState({ x: 20, y: 30, zoom: 1.2 })
    store.set(nativeCanvasStatesAtom, new Map([[graphKey, graphState]]))
    store.set(agentCanvasViewStatesAtom, new Map([
      [firstViewKey, createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 1 })],
      [secondViewKey, secondViewState],
    ]))
    const dispose = mountNativeCanvasSessionView(
      harness.coordinator,
      firstViewKey,
      (viewKey) => store.set(removeAgentCanvasViewStateAtom, viewKey),
    )

    dispose()
    harness.flush()

    expect(store.get(agentCanvasViewStatesAtom).has(firstViewKey)).toBe(false)
    expect(store.get(agentCanvasViewStatesAtom).get(secondViewKey)).toBe(secondViewState)
    expect(store.get(nativeCanvasStatesAtom).get(graphKey)).toBe(graphState)
  })

  test('Given Workspace 从 A 切到 B When A 清理微任务执行 Then 只清 A', () => {
    const harness = createCleanupHarness()
    const disposeA = harness.coordinator.mount('project-1:canvas-a', () => {
      harness.cleared.push('canvas-a')
    })

    disposeA()
    const disposeB = harness.coordinator.mount('project-1:canvas-b', () => {
      harness.cleared.push('canvas-b')
    })
    harness.flush()

    expect(harness.cleared).toEqual(['canvas-a'])
    disposeB()
  })

  test('Given 不同 workspace 各自待清理 When 其中一个同 key 重挂 Then 不取消另一个清理', () => {
    const harness = createCleanupHarness()
    const disposeA = harness.coordinator.mount('project-a:canvas-1', () => {
      harness.cleared.push('project-a')
    })
    const disposeB = harness.coordinator.mount('project-b:canvas-1', () => {
      harness.cleared.push('project-b')
    })

    disposeA()
    disposeB()
    const disposeNextA = harness.coordinator.mount('project-a:canvas-1', () => {
      harness.cleared.push('project-a-next')
    })
    harness.flush()

    expect(harness.cleared).toEqual(['project-b'])
    disposeNextA()
  })
})

/** 可从测试精确控制完成时机的 Promise。 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 创建类型完整的可控异步结果。 */
function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined
  let rejectPromise: ((reason: unknown) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (reason) => rejectPromise?.(reason),
  }
}

/** 等待 Promise 微任务回调提交状态。 */
async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** 创建指定双身份与 revision 的测试快照。 */
function createSnapshot(
  revision: number,
  target: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-1' },
): CanvasWorkspaceSnapshot {
  const document = createEmptyCanvasDocument(target.projectId, target.canvasId, revision)
  document.revision = revision
  return { document, writable: true, nodeIssues: [] }
}

/** 手动推进的 trailing debounce 调度器。 */
class ManualScheduler implements NativeCanvasScheduler {
  private nextId = 1
  private tasks = new Map<number, { callback: () => void; delayMs: number }>()

  /** 登记待触发任务并返回稳定 ID。 */
  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId
    this.nextId += 1
    this.tasks.set(id, { callback, delayMs })
    return id
  }

  /** 取消尚未手动触发的任务。 */
  clearTimeout(timerId: number): void {
    this.tasks.delete(timerId)
  }

  /** 返回当前唯一任务的延迟，验证 400ms 合同。 */
  getDelay(): number | undefined {
    return [...this.tasks.values()][0]?.delayMs
  }

  /** 触发当前全部任务；回调可继续登记下一轮。 */
  runAll(): void {
    const tasks = [...this.tasks.values()]
    this.tasks.clear()
    for (const task of tasks) task.callback()
  }
}

/** controller 测试夹具，完整记录 load/save/事件与状态。 */
interface ControllerHarness {
  controller: NativeCanvasWorkspaceController
  scheduler: ManualScheduler
  getState: () => NativeCanvasState
  loads: Deferred<CanvasWorkspaceSnapshot>[]
  saves: Array<{
    expectedRevision: number
    mutations: CanvasMutation[]
    deferred: Deferred<CanvasDocument>
  }>
  emit: (event: CanvasChangeEvent) => void
  unsubscribeCount: () => number
}

/** 创建绑定指定 projectId:canvasId 的纯 controller 测试夹具。 */
function createHarness(
  initial?: Partial<NativeCanvasState>,
  target: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-1' },
): ControllerHarness {
  let state: NativeCanvasState = { ...createInitialNativeCanvasState(), ...initial }
  const scheduler = new ManualScheduler()
  const loads: Deferred<CanvasWorkspaceSnapshot>[] = []
  const saves: ControllerHarness['saves'] = []
  let listener: ((event: CanvasChangeEvent) => void) | undefined
  let releases = 0
  const dependencies: NativeCanvasWorkspaceControllerDependencies = {
    target,
    adapter: {
      loadCanvas: () => {
        const deferred = createDeferred<CanvasWorkspaceSnapshot>()
        loads.push(deferred)
        return deferred.promise
      },
      saveCanvas: (input) => {
        const deferred = createDeferred<CanvasDocument>()
        saves.push({
          expectedRevision: input.expectedRevision,
          mutations: input.mutations,
          deferred,
        })
        return deferred.promise
      },
      onCanvasChanged: (_target, nextListener) => {
        listener = nextListener
        return () => { releases += 1 }
      },
    },
    getState: () => state,
    updateState: (update) => {
      const patch = typeof update === 'function' ? update(state) : update
      state = { ...state, ...patch }
    },
    scheduler,
  }
  return {
    controller: createNativeCanvasWorkspaceController(dependencies),
    scheduler,
    getState: () => state,
    loads,
    saves,
    emit: (event) => listener?.(event),
    unsubscribeCount: () => releases,
  }
}

describe('原生 Canvas controller 加载与事件', () => {
  test('Given LOAD 异常含内部正文 When 加载失败 Then 状态只保留固定公开文案', async () => {
    const harness = createHarness()
    harness.controller.start()
    harness.loads[0]?.reject(new Error(
      'Error invoking remote method /Users/name 11111111-1111-4111-8111-111111111111',
    ))
    await flushPromises()

    expect(harness.getState()).toMatchObject({
      phase: 'error',
      error: '画布暂时无法加载。',
    })
  })

  test('Given 普通 graph 事件 When revision 未前进 Then 忽略；更高时才加载', async () => {
    const harness = createHarness()
    harness.controller.start()
    harness.loads[0]?.resolve(createSnapshot(3))
    await flushPromises()

    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 3, cause: 'graph' })
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 2, cause: 'graph' })
    expect(harness.loads).toHaveLength(1)
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 4, cause: 'graph' })
    expect(harness.loads).toHaveLength(2)
  })

  test('Given recovery 事件 revision 更低 When 到达 Then 无条件阻断并权威加载', async () => {
    const harness = createHarness()
    harness.controller.start()
    harness.loads[0]?.resolve(createSnapshot(8))
    await flushPromises()

    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' })

    expect(harness.loads).toHaveLength(2)
    expect(harness.getState()).toMatchObject({
      authoritativeRecoveryState: 'loading',
      saveState: 'failed',
    })
  })

  test('Given recovery LOAD 在途 When 收到多个更高 graph revision Then 恢复完成后只按最高目标对账一次', async () => {
    const harness = createHarness()
    harness.controller.start()
    harness.loads[0]?.resolve(createSnapshot(8))
    await flushPromises()

    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 4, cause: 'recovery' })
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 10, cause: 'graph' })
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 12, cause: 'graph' })
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 11, cause: 'graph' })

    expect(harness.loads).toHaveLength(2)
    expect(harness.getState().deferredGraphRevision).toBe(12)
    harness.loads[1]?.resolve(createSnapshot(4))
    await flushPromises()

    expect(harness.getState()).toMatchObject({ authoritativeRecoveryState: 'idle' })
    expect(harness.getState().deferredGraphRevision).toBeNull()
    expect(harness.loads).toHaveLength(3)
    harness.loads[2]?.resolve(createSnapshot(12))
    await flushPromises()
    expect(harness.getState().snapshot?.document.revision).toBe(12)
  })

  test('Given 两次 LOAD 乱序 When 旧请求最后返回 Then 旧结果无副作用', async () => {
    const harness = createHarness()
    harness.controller.start()
    harness.controller.retryLoad()
    harness.loads[1]?.resolve(createSnapshot(4))
    await flushPromises()
    harness.loads[0]?.resolve(createSnapshot(9))
    await flushPromises()

    expect(harness.getState().snapshot?.document.revision).toBe(4)
  })
})

describe('原生 Canvas controller 保存', () => {
  test('Given 连续交互 When 400ms 尾触发 Then 重排定时并压缩视口后单批保存', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(2) })
    harness.controller.enqueueMutation({ type: 'set-viewport', viewport: { x: 1, y: 1, zoom: 1 } })
    harness.controller.enqueueMutation({
      type: 'move-nodes', positions: [{ nodeId: 'node-1', position: { x: 2, y: 3 } }],
    })
    harness.controller.enqueueMutation({ type: 'set-viewport', viewport: { x: 8, y: 9, zoom: 2 } })

    expect(harness.scheduler.getDelay()).toBe(NATIVE_CANVAS_SAVE_DEBOUNCE_MS)
    harness.scheduler.runAll()

    expect(harness.saves).toHaveLength(1)
    expect(harness.saves[0]).toMatchObject({ expectedRevision: 2, mutations: [
      { type: 'move-nodes', positions: [{ nodeId: 'node-1', position: { x: 2, y: 3 } }] },
      { type: 'set-viewport', viewport: { x: 8, y: 9, zoom: 2 } },
    ] })
    expect(harness.getState()).toMatchObject({ pendingMutations: [], saveState: 'saving' })
    expect(harness.getState().inFlightMutations).toHaveLength(2)

    harness.saves[0]?.deferred.resolve({ ...createSnapshot(3).document })
    await flushPromises()
    expect(harness.getState()).toMatchObject({ inFlightMutations: [], saveState: 'saved' })
  })

  test('Given SAVE 失败且期间有新 mutation When 回调 Then 原批次在前归还并阻断自动重试', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(2) })
    const first: CanvasMutation = { type: 'set-viewport', viewport: { x: 1, y: 1, zoom: 1 } }
    const later: CanvasMutation = { type: 'set-viewport', viewport: { x: 2, y: 2, zoom: 1 } }
    harness.controller.enqueueMutation(first)
    harness.scheduler.runAll()
    harness.controller.enqueueMutation(later)
    harness.saves[0]?.deferred.reject(new Error('磁盘忙'))
    await flushPromises()

    expect(harness.getState()).toMatchObject({
      pendingMutations: [first, later],
      inFlightMutations: [],
      saveState: 'failed',
      error: '画布暂时无法保存。',
    })
    harness.scheduler.runAll()
    expect(harness.saves).toHaveLength(1)
    harness.controller.retrySave()
    harness.scheduler.runAll()
    expect(harness.saves).toHaveLength(2)
  })

  test('Given SAVE 在途 When dispose Then 同步归还旧 Canvas 且迟到回调无副作用', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(2) })
    harness.controller.start()
    const mutation: CanvasMutation = { type: 'set-viewport', viewport: { x: 3, y: 4, zoom: 1 } }
    harness.controller.enqueueMutation(mutation)
    harness.scheduler.runAll()
    harness.controller.dispose()

    expect(harness.getState()).toMatchObject({
      pendingMutations: [mutation], inFlightMutations: [], saveState: 'dirty',
    })
    expect(harness.unsubscribeCount()).toBe(1)
    harness.saves[0]?.deferred.resolve(createSnapshot(7).document)
    await flushPromises()
    expect(harness.getState().snapshot?.document.revision).toBe(2)
    expect(harness.getState().pendingMutations).toEqual([mutation])
  })

  for (const errorCode of [
    NATIVE_CANVAS_RECOVERY_REQUIRED_CODE,
    NATIVE_CANVAS_COMMIT_UNCERTAIN_CODE,
  ]) {
    test(`Given SAVE 返回 ${errorCode} When 权威 LOAD 完成 Then 归还批次并隔离迟到回调`, async () => {
      const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(6) })
      const mutation: CanvasMutation = { type: 'set-viewport', viewport: { x: 7, y: 8, zoom: 1.4 } }
      harness.controller.enqueueMutation(mutation)
      harness.scheduler.runAll()

      harness.saves[0]?.deferred.reject(new Error(`${errorCode}: reload required`))
      await flushPromises()

      expect(harness.loads).toHaveLength(1)
      expect(harness.getState()).toMatchObject({
        pendingMutations: [mutation], inFlightMutations: [], authoritativeRecoveryState: 'loading',
      })
      harness.loads[0]?.resolve(createSnapshot(2))
      await flushPromises()
      expect(harness.getState().snapshot?.document).toMatchObject({
        revision: 2, viewport: { x: 7, y: 8, zoom: 1.4 },
      })

      harness.saves[0]?.deferred.resolve(createSnapshot(99).document)
      await flushPromises()
      expect(harness.getState().snapshot?.document.revision).toBe(2)
    })
  }

  test('Given Electron 包装 recovery-required 错误 When SAVE 失败 Then 仍按稳定错误码权威加载', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(6) })
    harness.controller.enqueueMutation({ type: 'set-viewport', viewport: { x: 3, y: 4, zoom: 1.1 } })
    harness.scheduler.runAll()

    harness.saves[0]?.deferred.reject(new Error(
      `Error invoking remote method 'DESIGN_CANVAS_SAVE': Error: ${NATIVE_CANVAS_RECOVERY_REQUIRED_CODE}: reload required`,
    ))
    await flushPromises()

    expect(harness.loads).toHaveLength(1)
    expect(harness.getState().authoritativeRecoveryState).toBe('loading')
  })

  test('Given SAVE revision conflict 且仅有位置 mutation When 远端加载 Then 重放到远端并重新保存', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(3) })
    const mutation: CanvasMutation = { type: 'set-viewport', viewport: { x: 12, y: 13, zoom: 1.8 } }
    harness.controller.enqueueMutation(mutation)
    harness.scheduler.runAll()
    harness.saves[0]?.deferred.reject(new Error(`${NATIVE_CANVAS_REVISION_CONFLICT_CODE}: expected=3, current=4`))
    await flushPromises()

    expect(harness.loads).toHaveLength(1)
    harness.loads[0]?.resolve(createSnapshot(4))
    await flushPromises()

    expect(harness.getState()).toMatchObject({
      pendingMutations: [mutation], saveState: 'dirty', authoritativeRecoveryState: 'idle',
    })
    expect(harness.getState().snapshot?.document.viewport).toEqual(mutation.viewport)
    expect(harness.scheduler.getDelay()).toBe(NATIVE_CANVAS_SAVE_DEBOUNCE_MS)
  })

  test('Given SAVE revision conflict 且含结构 mutation When 远端加载 Then 保留权威结构并进入冲突', async () => {
    const structural: CanvasMutation = { type: 'remove-nodes', nodeIds: ['agent-1'] }
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(3) })
    harness.controller.enqueueMutation(structural)
    harness.scheduler.runAll()
    harness.saves[0]?.deferred.reject(new Error(`${NATIVE_CANVAS_REVISION_CONFLICT_CODE}: expected=3, current=4`))
    await flushPromises()

    const remote = createSnapshot(4)
    remote.document.nodes = [{
      id: 'remote-agent', kind: 'agent', title: '远端 Agent',
      agentSessionId: 'remote-session', position: { x: 1, y: 2 },
    }]
    harness.loads[0]?.resolve(remote)
    await flushPromises()

    expect(harness.getState()).toMatchObject({
      pendingMutations: [structural], saveState: 'conflict',
      error: NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
    })
    expect(harness.getState().snapshot?.document.nodes).toEqual(remote.document.nodes)
  })
})

describe('原生 Canvas controller 权威恢复', () => {
  test('Given 普通 LOAD 返回 recoveredFrom 且旧 SAVE 在途 When 应用恢复快照 Then 旧回调无副作用', async () => {
    const harness = createHarness({
      phase: 'ready',
      snapshot: createSnapshot(5),
      expandedNodeId: 'agent-1',
      workbenchDraft: { nodeId: 'agent-1', dirty: true },
    })
    harness.controller.start()
    const mutation: CanvasMutation = { type: 'set-viewport', viewport: { x: 4, y: 5, zoom: 1.2 } }
    harness.controller.enqueueMutation(mutation)
    harness.scheduler.runAll()
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 6, cause: 'graph' })

    const recovered = { ...createSnapshot(1), recoveredFrom: 'backup' as const }
    harness.loads[1]?.resolve(recovered)
    await flushPromises()
    expect(harness.getState()).toMatchObject({
      pendingMutations: [mutation], inFlightMutations: [], saveState: 'dirty',
    })
    expect(harness.getState().snapshot?.document).toMatchObject({
      revision: 1, viewport: { x: 4, y: 5, zoom: 1.2 },
    })

    harness.saves[0]?.deferred.resolve(createSnapshot(88).document)
    await flushPromises()
    expect(harness.getState().snapshot?.document.revision).toBe(1)
    expect(harness.getState().pendingMutations).toEqual([mutation])
  })

  test('Given 在途与待保存均为位置类 When recovery 成功 Then 归还、重放并稍后自动保存', async () => {
    const base = createSnapshot(2)
    base.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent', agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const harness = createHarness({ phase: 'ready', snapshot: base })
    harness.controller.start()
    const move: CanvasMutation = {
      type: 'move-nodes', positions: [{ nodeId: 'agent-1', position: { x: 10, y: 20 } }],
    }
    harness.controller.enqueueMutation(move)
    harness.scheduler.runAll()
    const viewport: CanvasMutation = { type: 'set-viewport', viewport: { x: 5, y: 6, zoom: 1.5 } }
    harness.controller.enqueueMutation(viewport)

    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' })
    expect(harness.getState().pendingMutations).toEqual([move, viewport])
    expect(harness.getState().inFlightMutations).toEqual([])
    const recovered = createSnapshot(1)
    recovered.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: '权威 Agent', agentSessionId: 'session-1', position: { x: 1, y: 1 },
    }]
    harness.loads[1]?.resolve(recovered)
    await flushPromises()

    expect(harness.getState().snapshot?.document).toMatchObject({
      revision: 1,
      viewport: { x: 5, y: 6, zoom: 1.5 },
      nodes: [{ id: 'agent-1', title: '权威 Agent', position: { x: 10, y: 20 } }],
    })
    expect(harness.getState()).toMatchObject({
      pendingMutations: [move, viewport], saveState: 'dirty',
      authoritativeRecoveryState: 'idle', selectedNodeId: null, conversationNodeId: null,
    })
    expect(harness.scheduler.getDelay()).toBe(400)

    harness.saves[0]?.deferred.resolve(createSnapshot(99).document)
    await flushPromises()
    expect(harness.getState().snapshot?.document.revision).toBe(1)
    expect(harness.getState().pendingMutations).toEqual([move, viewport])
  })

  test('Given 远端已删除本地待移动节点 When recovery 接管 Then 保留 pending 冲突且采用远端后恢复可编辑', async () => {
    const base = createSnapshot(5)
    base.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: '本地 Agent',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const harness = createHarness({ phase: 'ready', snapshot: base })
    harness.controller.start()
    const move: CanvasMutation = {
      type: 'move-nodes', positions: [{ nodeId: 'agent-1', position: { x: 20, y: 30 } }],
    }
    harness.controller.enqueueMutation(move)
    harness.scheduler.runAll()

    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 6, cause: 'recovery' })
    const remote = createSnapshot(6)
    remote.document.nodes = []
    harness.loads[1]?.resolve(remote)
    await flushPromises()

    expect(harness.getState()).toMatchObject({
      snapshot: remote,
      pendingMutations: [move],
      inFlightMutations: [],
      saveState: 'conflict',
      error: NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
    })
    expect(harness.scheduler.getDelay()).toBeUndefined()
    expect(harness.saves).toHaveLength(1)

    harness.controller.acceptRemoteVersion()
    expect(harness.getState()).toMatchObject({
      snapshot: remote,
      pendingMutations: [],
      inFlightMutations: [],
      saveState: 'saved',
      error: null,
    })
    harness.controller.enqueueMutation({ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1.1 } })
    expect(harness.getState()).toMatchObject({ saveState: 'dirty' })
  })

  test('Given pending 含结构 mutation When recovery 成功 Then 接管权威结构并显式冲突', async () => {
    const structural: CanvasMutation = { type: 'remove-nodes', nodeIds: ['agent-1'] }
    const harness = createHarness({
      phase: 'ready', snapshot: createSnapshot(5), pendingMutations: [structural],
      saveState: 'dirty', selectedNodeId: 'agent-1', conversationNodeId: 'agent-1',
      expandedNodeId: 'agent-1', pendingWorkbenchSwitchNodeId: 'agent-other',
      workbenchDraft: { nodeId: 'agent-1', dirty: true },
    })
    harness.controller.start()
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' })
    harness.loads[1]?.resolve(createSnapshot(1))
    await flushPromises()

    expect(harness.getState()).toMatchObject({
      pendingMutations: [structural], saveState: 'conflict',
      authoritativeRecoveryState: 'idle',
    })
    expect(harness.getState().error).toContain('结构')
    expect(harness.scheduler.getDelay()).toBeUndefined()
    harness.loads[0]?.resolve(createSnapshot(9))
    await flushPromises()
    expect(harness.getState().snapshot?.document.revision).toBe(1)
  })

  test('Given 已进入结构冲突 When 采用远端版本 Then 丢弃旧 mutation 并恢复可编辑状态', () => {
    const structural: CanvasMutation = { type: 'remove-nodes', nodeIds: ['agent-1'] }
    const remote = createSnapshot(7)
    const harness = createHarness({
      phase: 'ready', snapshot: remote, pendingMutations: [structural],
      inFlightMutations: [structural], saveState: 'conflict',
      error: NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
    })

    harness.controller.acceptRemoteVersion()

    expect(harness.getState()).toMatchObject({
      snapshot: remote, pendingMutations: [], inFlightMutations: [],
      saveState: 'saved', error: null,
    })
    expect(harness.scheduler.getDelay()).toBeUndefined()
  })

  test('Given 结构 pending 与 deferred graph When recovery 后对账 Then 始终展示权威结构且保留冲突', async () => {
    const structural: CanvasMutation = { type: 'remove-nodes', nodeIds: ['agent-1'] }
    const initial = createSnapshot(5)
    initial.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: '旧 Agent',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const harness = createHarness({
      phase: 'ready', snapshot: initial,
      pendingMutations: [structural], saveState: 'dirty',
    })
    harness.controller.start()
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' })
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 9, cause: 'graph' })
    const recovered = createSnapshot(1)
    recovered.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: '恢复权威 Agent',
      agentSessionId: 'session-1', position: { x: 10, y: 20 },
    }]
    harness.loads[1]?.resolve(recovered)
    await flushPromises()

    const reconciled = createSnapshot(9)
    reconciled.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: '最新权威 Agent',
      agentSessionId: 'session-1', position: { x: 30, y: 40 },
    }]
    harness.loads[2]?.resolve(reconciled)
    await flushPromises()

    expect(harness.getState().snapshot?.document.nodes).toEqual(reconciled.document.nodes)
    expect(harness.getState()).toMatchObject({
      pendingMutations: [structural],
      saveState: 'conflict',
      error: NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
    })
    expect(harness.saves).toHaveLength(0)
    expect(harness.scheduler.getDelay()).toBeUndefined()
  })

  test('Given recovery LOAD 失败 When 显式重试 Then 保持阻断直到新权威快照成功', async () => {
    const harness = createHarness({ phase: 'ready', snapshot: createSnapshot(5) })
    harness.controller.start()
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' })
    harness.emit({ projectId: 'project-1', canvasId: 'canvas-1', revision: 7, cause: 'graph' })
    harness.loads[1]?.reject(new Error('恢复文件损坏'))
    await flushPromises()
    expect(harness.getState()).toMatchObject({
      authoritativeRecoveryState: 'failed', deferredGraphRevision: 7, saveState: 'failed',
    })

    harness.controller.retryRecovery()
    expect(harness.loads).toHaveLength(3)
    harness.loads[2]?.resolve(createSnapshot(1))
    await flushPromises()
    expect(harness.loads).toHaveLength(4)
    expect(harness.getState()).toMatchObject({
      authoritativeRecoveryState: 'idle', deferredGraphRevision: null, saveState: 'saved',
    })
    harness.loads[3]?.resolve(createSnapshot(7))
    await flushPromises()
    expect(harness.getState().snapshot?.document.revision).toBe(7)
  })

  test('Given A recovery 在途 When 切换 B 再返回 A Then A 继续权威恢复且 B 不继承队列', async () => {
    const targetA: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-a' }
    const targetB: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-b' }
    const snapshotA = createSnapshot(5, targetA)
    snapshotA.document.nodes = [{
      id: 'agent-a', kind: 'agent', title: 'Agent A',
      agentSessionId: 'session-a', position: { x: 0, y: 0 },
    }]
    const firstA = createHarness({ phase: 'ready', snapshot: snapshotA }, targetA)
    const moveA: CanvasMutation = {
      type: 'move-nodes', positions: [{ nodeId: 'agent-a', position: { x: 20, y: 30 } }],
    }
    firstA.controller.start()
    firstA.controller.enqueueMutation(moveA)
    firstA.scheduler.runAll()
    firstA.emit({ projectId: targetA.projectId, canvasId: targetA.canvasId, revision: 1, cause: 'recovery' })
    firstA.emit({ projectId: targetA.projectId, canvasId: targetA.canvasId, revision: 9, cause: 'graph' })
    firstA.controller.dispose()

    const persistedA = firstA.getState()
    expect(persistedA).toMatchObject({
      pendingMutations: [moveA], inFlightMutations: [], authoritativeRecoveryState: 'loading',
      deferredGraphRevision: 9,
    })

    const canvasB = createHarness(undefined, targetB)
    canvasB.controller.start()
    expect(canvasB.getState()).toMatchObject({
      pendingMutations: [], inFlightMutations: [], authoritativeRecoveryState: 'idle',
    })
    canvasB.loads[0]?.resolve(createSnapshot(2, targetB))
    await flushPromises()

    const secondA = createHarness(persistedA, targetA)
    secondA.controller.start()
    expect(secondA.loads).toHaveLength(1)
    const recoveredA = createSnapshot(1, targetA)
    recoveredA.document.nodes = [{
      id: 'agent-a', kind: 'agent', title: '恢复 Agent A',
      agentSessionId: 'session-a', position: { x: 1, y: 1 },
    }]
    secondA.loads[0]?.resolve(recoveredA)
    await flushPromises()

    expect(secondA.loads).toHaveLength(2)
    const reconciledA = createSnapshot(9, targetA)
    reconciledA.document.nodes = [{
      id: 'agent-a', kind: 'agent', title: '最新 Agent A',
      agentSessionId: 'session-a', position: { x: 2, y: 2 },
    }]
    secondA.loads[1]?.resolve(reconciledA)
    await flushPromises()

    expect(secondA.getState()).toMatchObject({
      phase: 'ready', pendingMutations: [moveA], authoritativeRecoveryState: 'idle',
      deferredGraphRevision: null, saveState: 'dirty',
    })
    expect(canvasB.getState().pendingMutations).toEqual([])
  })
})

describe('原生 Canvas 冲突提示', () => {
  test('Given 结构冲突 When 渲染工作区 Then 明确提示并提供采用远端版本动作', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const store = createStore()
    store.set(nativeCanvasStatesAtom, new Map([[
      createNativeCanvasKey(target.projectId, target.canvasId),
      {
        ...createInitialNativeCanvasState(),
        phase: 'ready',
        snapshot: createSnapshot(7),
        pendingMutations: [{ type: 'remove-nodes', nodeIds: ['agent-1'] }],
        saveState: 'conflict',
        error: NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
      },
    ]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          sessionId="legacy-test-session"
          target={target}
          title="冲突 Canvas"
          adapter={{
            loadCanvas: async () => createSnapshot(7),
            saveCanvas: async () => createSnapshot(8).document,
            onCanvasChanged: () => () => {},
          }}
          flowRenderer={() => <div />}
        />
      </Provider>,
    )

    expect(html).toContain(NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE)
    expect(html).toContain('采用远端版本')
  })
})

describe('原生 Canvas 添加 Agent 命令', () => {
  test.each([
    ['agent', '新 Agent'],
    ['image', '新生图'],
    ['document', '新文档'],
    ['webview', '新原型'],
  ] as const)('Given 顶部选择 %s When 创建 Then 使用固定标题并复用失败操作身份', async (kind, title) => {
    const agentInputs: CreateCanvasAgentNodeInput[] = []
    const contentInputs: CreateCanvasContentNodeInput[] = []
    const document = createSnapshot(7).document
    let attempts = 0
    const controller = createCanvasNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      createAgentNode: async (input) => {
        agentInputs.push(input)
        attempts += 1
        if (attempts === 1) throw new Error('first failure')
        return { document: createSnapshot(8).document, session: { id: 'session-1' } as never }
      },
      createContentNode: async (input) => {
        contentInputs.push(input)
        attempts += 1
        if (attempts === 1) throw new Error('first failure')
        return { snapshot: createSnapshot(8), selectedNodeId: input.nodeId }
      },
      createId: (() => {
        const ids = ['operation-1', 'node-1', 'content-1']
        return () => ids.shift() ?? 'unexpected-id'
      })(),
      getDocument: () => document,
      getPosition: () => ({ x: 320, y: 40 }),
      onStateChange: () => undefined,
      onSuccess: () => undefined,
    })

    await expect(controller.execute({ kind })).rejects.toThrow('first failure')
    await expect(controller.execute({ kind })).resolves.toBeUndefined()

    const inputs = kind === 'agent' ? agentInputs : contentInputs
    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toEqual(inputs[0])
    expect(inputs[0]).toMatchObject({ title, position: { x: 320, y: 40 } })
    if (kind !== 'agent') {
      expect(contentInputs[0]).toMatchObject({ kind, contentId: 'content-1', expectedRevision: 7 })
    }
  })

  test.each<CanvasNodeKind>(['agent', 'image', 'document', 'webview'])(
    'Given 节点侧选择 %s When 扩展 Then 请求包含稳定连线身份',
    async (kind) => {
      const inputs: Array<CreateCanvasAgentNodeInput | CreateCanvasContentNodeInput> = []
      const controller = createCanvasNodeCommandController({
        target: { projectId: 'project-1', canvasId: 'canvas-1' },
        createAgentNode: async (input) => {
          inputs.push(input)
          return { document: createSnapshot(2).document, session: { id: 'session-2' } as never }
        },
        createContentNode: async (input) => {
          inputs.push(input)
          return { snapshot: createSnapshot(2), selectedNodeId: input.nodeId }
        },
        createId: (() => {
          const ids = kind === 'agent'
            ? ['operation-1', 'node-2', 'edge-1']
            : ['operation-1', 'node-2', 'content-2', 'edge-1']
          return () => ids.shift() ?? 'unexpected-id'
        })(),
        getDocument: () => createSnapshot(1).document,
        getPosition: () => ({ x: 412, y: 268 }),
        onStateChange: () => undefined,
        onSuccess: () => undefined,
      })

      await controller.execute({ kind, sourceNodeId: 'source-1' })

      expect(inputs[0]).toMatchObject({
        relationship: { sourceNodeId: 'source-1', edgeId: 'edge-1' },
      })
    },
  )

  test('Given 生命周期成功 When 接管权威快照 Then 只清理共享保存队列', () => {
    const current = createInitialNativeCanvasState()
    current.snapshot = createSnapshot(4)
    current.selectedNodeId = 'document-1'
    current.expandedNodeId = 'document-1'
    current.pendingWorkbenchSwitchNodeId = 'webview-1'
    current.workbenchDraft = { nodeId: 'document-1', dirty: true }
    const result: CanvasNodeLifecycleResult = { snapshot: createSnapshot(5) }

    expect(createNativeCanvasLifecycleSuccessUpdate(current, result, null)).toMatchObject({
      snapshot: result.snapshot,
      pendingMutations: [],
      inFlightMutations: [],
      saveState: 'saved',
      error: null,
    })
  })

  test('Given 生命周期结果 revision 已落后 When 当前 Canvas 更高 Then 迟到结果完全无副作用', () => {
    const current = createInitialNativeCanvasState()
    current.snapshot = createSnapshot(8)
    current.selectedNodeId = 'document-current'
    current.expandedNodeId = 'document-current'
    current.workbenchDraft = { nodeId: 'document-current', dirty: true }

    expect(createNativeCanvasLifecycleSuccessUpdate(
      current,
      { snapshot: createSnapshot(7), selectedNodeId: 'document-old' },
      'document-old',
    )).toEqual({})
  })

  test('Given 当前快照已有图片预览 When 生命周期旧结果未携带预览字段 Then 保留现有缩略图', () => {
    const current = createInitialNativeCanvasState()
    current.snapshot = {
      ...createSnapshot(4),
      imagePreviews: [{
        assetId: 'asset-1', previewUrl: 'proma-file://thumbnail/result.webp', width: 100, height: 100,
      }],
    }
    const result: CanvasNodeLifecycleResult = { snapshot: createSnapshot(5) }

    expect(createNativeCanvasLifecycleSuccessUpdate(current, result, null)).toMatchObject({
      snapshot: { imagePreviews: current.snapshot.imagePreviews },
    })
  })

  test('Given 创建结果 revision 可接管 When 创建成功 Then 只接管共享图并保留视图字段', () => {
    const current = createInitialNativeCanvasState()
    current.snapshot = createSnapshot(4)
    current.expandedNodeId = 'document-old'
    current.pendingWorkbenchSwitchNodeId = 'webview-next'
    current.workbenchDraft = { nodeId: 'document-old', dirty: true }
    const result: CanvasNodeLifecycleResult = {
      snapshot: createSnapshot(5),
      selectedNodeId: 'document-new',
    }

    const update = createNativeCanvasNodeCreationSuccessUpdate(current, {
      kind: 'document', nodeId: 'document-new', result,
    })
    expect({ ...current, ...update }).toMatchObject({
      selectedNodeId: null,
      expandedNodeId: 'document-old',
      pendingWorkbenchSwitchNodeId: 'webview-next',
      workbenchDraft: { nodeId: 'document-old', dirty: true },
    })
    expect(update).not.toHaveProperty('expandedNodeId')
    expect(update).not.toHaveProperty('selectedNodeId')
    expect(update).not.toHaveProperty('pendingWorkbenchSwitchNodeId')
    expect(update).not.toHaveProperty('workbenchDraft')
  })

  test('Given 当前快照已有图片预览 When 内容创建结果未携带预览字段 Then 创建后缩略图保持可见', () => {
    const current = createInitialNativeCanvasState()
    current.snapshot = {
      ...createSnapshot(4),
      imagePreviews: [{
        assetId: 'asset-1', previewUrl: 'proma-file://thumbnail/result.webp', width: 100, height: 100,
      }],
    }

    const update = createNativeCanvasNodeCreationSuccessUpdate(current, {
      kind: 'document',
      nodeId: 'document-new',
      result: { snapshot: createSnapshot(5), selectedNodeId: 'document-new' },
    })

    expect(update).toMatchObject({ snapshot: { imagePreviews: current.snapshot.imagePreviews } })
  })

  test('Given 创建期间工作台始终为空 When 创建成功 Then graph helper 不写入视图状态', () => {
    const current = createInitialNativeCanvasState()
    current.snapshot = createSnapshot(4)
    const updated = {
      ...current,
      ...createNativeCanvasNodeCreationSuccessUpdate(current, {
        kind: 'document', nodeId: 'document-new',
        result: { snapshot: createSnapshot(5), selectedNodeId: 'document-new' },
      }),
    }

    expect(updated).toMatchObject({
      selectedNodeId: null,
      expandedNodeId: null,
      pendingWorkbenchSwitchNodeId: null,
      workbenchDraft: null,
    })
  })

  test('Given CREATE 在途后用户产生 dirty 工作台 When 迟到成功 Then graph helper 只接管文档', async () => {
    const deferred = createDeferred<CanvasAgentNodeCreationResult>()
    let current = createInitialNativeCanvasState()
    current.snapshot = createSnapshot(4)
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      createAgentNode: () => deferred.promise,
      createId: (() => {
        const ids = ['11111111-1111-4111-8111-111111111111', 'agent-new']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 0, y: 0 }),
      onStateChange: () => undefined,
      onSuccess: (nodeId, result) => {
        current = {
          ...current,
          ...createNativeCanvasNodeCreationSuccessUpdate(current, {
            kind: 'agent', nodeId, result,
          }),
        }
      },
    })
    const creating = controller.execute()
    current.expandedNodeId = 'document-current'
    current.pendingWorkbenchSwitchNodeId = 'webview-next'
    current.workbenchDraft = { nodeId: 'document-current', dirty: true }

    deferred.resolve({
      document: createSnapshot(5).document,
      session: { id: 'session-new' } as never,
    })
    await creating

    expect(current).toMatchObject({
      snapshot: { document: { revision: 5 } },
      selectedNodeId: null,
      expandedNodeId: 'document-current',
      pendingWorkbenchSwitchNodeId: 'webview-next',
      workbenchDraft: { nodeId: 'document-current', dirty: true },
    })
  })

  test('Given 创建结果 revision 已落后 When 新 Canvas 状态更高 Then 不关闭当前工作台', () => {
    const current = createInitialNativeCanvasState()
    current.snapshot = createSnapshot(8)
    current.expandedNodeId = 'document-current'
    current.workbenchDraft = { nodeId: 'document-current', dirty: true }

    expect(createNativeCanvasNodeCreationSuccessUpdate(current, {
      kind: 'agent',
      nodeId: 'agent-old',
      result: { document: createSnapshot(7).document, session: { id: 'session-old' } as never },
    })).not.toHaveProperty('expandedNodeId')
  })

  test('Given 空图和真实 surface When 独立新增 Then 只用 surface 中心换算世界坐标', () => {
    const document = createSnapshot(1).document
    document.viewport = { x: -100, y: 50, zoom: 2 }

    expect(findNativeCanvasAgentNodeCreationPosition(document, { width: 800, height: 600 }))
      .toEqual({ x: 106, y: 53 })
  })

  test('Given 全局追加位置仍在可视区 When 独立新增 Then 保持既有横向追加顺序', () => {
    const document = createSnapshot(1).document
    document.nodes = [
      { id: 'first', kind: 'agent', title: '首节点', agentSessionId: 's-1', position: { x: -200, y: 40 } },
      { id: 'right', kind: 'agent', title: '右节点', agentSessionId: 's-2', position: { x: 500, y: 300 } },
    ]
    document.viewport = { x: 0, y: 0, zoom: 1 }

    expect(findNativeCanvasAgentNodeCreationPosition(document, { width: 1_400, height: 900 }))
      .toEqual({ x: 812, y: 40 })
  })

  test('Given 横向节点已延伸到屏幕外 When 独立新增 Then 在当前可视区下一行追加且不改已有布局', () => {
    const document = createSnapshot(1).document
    document.viewport = { x: 0, y: 0, zoom: 1 }
    document.nodes = [
      { id: 'first', kind: 'agent', title: '首节点', agentSessionId: 's-1', position: { x: 100, y: 100 } },
      { id: 'second', kind: 'image', title: '第二节点', imageModuleId: 'i-2', position: { x: 412, y: 100 } },
      {
        id: 'third',
        kind: 'document',
        title: '第三节点',
        documentId: 'd-3',
        contentRevision: 0,
        position: { x: 724, y: 100 },
      },
    ]
    const original = structuredClone(document)

    expect(findNativeCanvasAgentNodeCreationPosition(document, { width: 800, height: 600 }))
      .toEqual({ x: 100, y: 268 })
    expect(document).toEqual(original)
  })

  test('Given 创建前已有 viewport mutation 与视图状态 When 创建成功 Then 只接管权威文档', () => {
    const current = createInitialNativeCanvasState()
    const viewportMutation: CanvasMutation = {
      type: 'set-viewport', viewport: { x: 12, y: 34, zoom: 1.5 },
    }
    current.phase = 'ready'
    current.snapshot = createSnapshot(2)
    current.snapshot.document.viewport = { x: 12, y: 34, zoom: 1.5 }
    current.pendingMutations = [viewportMutation]
    current.conversationNodeId = 'agent-existing'
    current.expandedNodeId = 'agent-existing'
    const createdDocument = createSnapshot(3).document
    createdDocument.viewport = { ...current.snapshot.document.viewport }
    const result: CanvasAgentNodeCreationResult = {
      document: createdDocument,
      session: { id: 'session-new' } as never,
    }

    const update = createNativeCanvasAgentNodeSuccessUpdate(current, 'node-new', result)

    expect({ ...current, ...update }).toMatchObject({
      snapshot: { document: result.document },
      selectedNodeId: null,
      conversationNodeId: 'agent-existing',
      expandedNodeId: 'agent-existing',
      pendingMutations: [viewportMutation],
    })
    expect(update.snapshot?.document.viewport).toEqual({ x: 12, y: 34, zoom: 1.5 })
    expect(update).not.toHaveProperty('conversationNodeId')
    expect(update).not.toHaveProperty('selectedNodeId')
    expect(update).not.toHaveProperty('expandedNodeId')
    expect(update).not.toHaveProperty('pendingMutations')
  })

  test('Given 创建期间发生缩放平移与节点拖动 When 旧 viewport 的创建结果返回 Then 按原顺序重放安全位置投影', () => {
    const current = createInitialNativeCanvasState()
    current.phase = 'ready'
    current.snapshot = createSnapshot(2)
    current.snapshot.document.nodes = [{
      id: 'agent-existing', kind: 'agent', title: '已有节点',
      agentSessionId: 'session-existing', position: { x: 360, y: 240 },
    }]
    const inFlightViewport: CanvasMutation = {
      type: 'set-viewport', viewport: { x: 20, y: 30, zoom: 1.2 },
    }
    const inFlightMove: CanvasMutation = {
      type: 'move-nodes', positions: [{ nodeId: 'agent-existing', position: { x: 120, y: 80 } }],
    }
    const structural: CanvasMutation = { type: 'remove-nodes', nodeIds: ['agent-other'] }
    const pendingViewport: CanvasMutation = {
      type: 'set-viewport', viewport: { x: 80, y: 90, zoom: 1.8 },
    }
    const pendingMove: CanvasMutation = {
      type: 'move-nodes', positions: [{ nodeId: 'agent-existing', position: { x: 360, y: 240 } }],
    }
    current.inFlightMutations = [inFlightViewport, inFlightMove]
    current.pendingMutations = [structural, pendingViewport, pendingMove]
    const createdDocument = createSnapshot(3).document
    createdDocument.nodes = [
      {
        id: 'agent-existing', kind: 'agent', title: '已有节点',
        agentSessionId: 'session-existing', position: { x: 0, y: 0 },
      },
      {
        id: 'node-new', kind: 'agent', title: '新 Agent',
        agentSessionId: 'session-new', position: { x: 312, y: 0 },
      },
      {
        id: 'agent-other', kind: 'agent', title: '其他节点',
        agentSessionId: 'session-other', position: { x: 624, y: 0 },
      },
    ]
    createdDocument.viewport = { x: 0, y: 0, zoom: 1 }
    const result: CanvasAgentNodeCreationResult = {
      document: createdDocument,
      session: { id: 'session-new' } as never,
    }

    const update = createNativeCanvasAgentNodeSuccessUpdate(current, 'node-new', result)
    const updated = { ...current, ...update }

    expect(updated.snapshot?.document.viewport).toEqual({ x: 80, y: 90, zoom: 1.8 })
    expect(updated.snapshot?.document.nodes.find((node) => node.id === 'agent-existing')?.position)
      .toEqual({ x: 360, y: 240 })
    expect(updated.snapshot?.document.nodes.map((node) => node.id))
      .toEqual(['agent-existing', 'node-new', 'agent-other'])
    expect(updated.inFlightMutations).toEqual([inFlightViewport, inFlightMove])
    expect(updated.pendingMutations).toEqual([structural, pendingViewport, pendingMove])
    expect(updated.conversationNodeId).toBeNull()
  })

  test('Given 当前 revision 更高且已含新节点 When 迟到创建结果返回 Then 保留当前文档与会话选区', () => {
    const current = createInitialNativeCanvasState()
    current.phase = 'ready'
    current.snapshot = createSnapshot(8)
    current.snapshot.document.viewport = { x: 90, y: 80, zoom: 1.6 }
    current.snapshot.document.nodes = [{
      id: 'node-new', kind: 'agent', title: '新 Agent',
      agentSessionId: 'session-new', position: { x: 400, y: 200 },
    }]
    current.selectedNodeId = 'agent-existing'
    current.conversationNodeId = 'agent-existing'
    current.expandedNodeId = 'agent-existing'
    const pendingViewport: CanvasMutation = {
      type: 'set-viewport', viewport: { x: 90, y: 80, zoom: 1.6 },
    }
    current.pendingMutations = [pendingViewport]
    const currentDocument = current.snapshot.document
    const staleDocument = createSnapshot(7).document
    staleDocument.viewport = { x: 0, y: 0, zoom: 1 }
    const result: CanvasAgentNodeCreationResult = {
      document: staleDocument,
      session: { id: 'session-new' } as never,
    }

    const update = createNativeCanvasAgentNodeSuccessUpdate(current, 'node-new', result)
    const updated = { ...current, ...update }

    expect(update).not.toHaveProperty('snapshot')
    expect(updated.snapshot?.document).toBe(currentDocument)
    expect(updated.snapshot?.document.viewport).toEqual({ x: 90, y: 80, zoom: 1.6 })
    expect(updated.selectedNodeId).toBe('agent-existing')
    expect(updated.conversationNodeId).toBe('agent-existing')
    expect(updated.expandedNodeId).toBe('agent-existing')
    expect(updated.pendingMutations).toEqual([pendingViewport])
  })

  test('Given 当前 revision 更高且不含新节点 When 迟到创建结果返回 Then 保留当前文档与原选区', () => {
    const current = createInitialNativeCanvasState()
    current.phase = 'ready'
    current.snapshot = createSnapshot(9)
    current.snapshot.document.nodes = [{
      id: 'agent-existing', kind: 'agent', title: '已有节点',
      agentSessionId: 'session-existing', position: { x: 40, y: 60 },
    }]
    current.selectedNodeId = 'agent-existing'
    const currentDocument = current.snapshot.document
    const result: CanvasAgentNodeCreationResult = {
      document: createSnapshot(8).document,
      session: { id: 'session-new' } as never,
    }

    const update = createNativeCanvasAgentNodeSuccessUpdate(current, 'node-new', result)
    const updated = { ...current, ...update }

    expect(update).not.toHaveProperty('snapshot')
    expect(updated.snapshot?.document).toBe(currentDocument)
    expect(updated.selectedNodeId).toBe('agent-existing')
  })

  test('Given 当前与创建结果 revision 相等 When 创建成功 Then 正常接管结果并重放位置 mutation', () => {
    const current = createInitialNativeCanvasState()
    current.phase = 'ready'
    current.snapshot = createSnapshot(5)
    const pendingViewport: CanvasMutation = {
      type: 'set-viewport', viewport: { x: 70, y: 50, zoom: 1.4 },
    }
    current.pendingMutations = [pendingViewport]
    const equalRevisionDocument = createSnapshot(5).document
    equalRevisionDocument.nodes = [{
      id: 'node-new', kind: 'agent', title: '新 Agent',
      agentSessionId: 'session-new', position: { x: 312, y: 0 },
    }]
    const result: CanvasAgentNodeCreationResult = {
      document: equalRevisionDocument,
      session: { id: 'session-new' } as never,
    }

    const update = createNativeCanvasAgentNodeSuccessUpdate(current, 'node-new', result)

    expect(update.snapshot?.document.revision).toBe(5)
    expect(update.snapshot?.document.nodes.map((node) => node.id)).toEqual(['node-new'])
    expect(update.snapshot?.document.viewport).toEqual({ x: 70, y: 50, zoom: 1.4 })
    expect(update).not.toHaveProperty('selectedNodeId')
  })

  test('Given CREATE 异常含内部正文 When 创建失败 Then 按钮状态只保留固定公开文案', async () => {
    const states: CanvasAgentNodeCommandState[] = []
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      createAgentNode: async () => {
        throw new Error(
          'Error invoking remote method /Users/name 11111111-1111-4111-8111-111111111111',
        )
      },
      createId: (() => {
        const ids = ['operation-1', 'node-1']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 0, y: 0 }),
      onStateChange: (state) => states.push(state),
      onSuccess: () => undefined,
    })

    await expect(controller.execute()).rejects.toThrow('Error invoking remote method')
    expect(states.at(-1)).toEqual({
      loading: false,
      error: '节点创建失败，请重试。',
    })
  })

  test('Given 健康源节点 When 扩展 Agent Then 预分配稳定边并使用源节点落点', async () => {
    const inputs: CreateCanvasAgentNodeInput[] = []
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      createAgentNode: async (input) => {
        inputs.push(input)
        return { document: createSnapshot(2).document, session: { id: 'session-2' } as never }
      },
      createId: (() => {
        const ids = ['operation-1', 'node-2', 'edge-1']
        return () => ids.shift()!
      })(),
      getPosition: (sourceNodeId) => sourceNodeId === 'agent-1'
        ? { x: 412, y: 268 }
        : { x: 0, y: 0 },
      onStateChange: () => undefined,
      onSuccess: () => undefined,
    })

    await controller.execute({ sourceNodeId: 'agent-1' })

    expect(inputs).toEqual([{
      projectId: 'project-1',
      canvasId: 'canvas-1',
      operationId: 'operation-1',
      nodeId: 'node-2',
      title: '新 Agent',
      position: { x: 412, y: 268 },
      relationship: { sourceNodeId: 'agent-1', edgeId: 'edge-1' },
    }])
  })

  test('Given 独立添加 When 创建 Agent Then 不生成 relationship', async () => {
    let input: CreateCanvasAgentNodeInput | undefined
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      createAgentNode: async (current) => {
        input = current
        return { document: createSnapshot(2).document, session: { id: 'session-2' } as never }
      },
      createId: (() => {
        const ids = ['operation-1', 'node-2']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 20, y: 40 }),
      onStateChange: () => undefined,
      onSuccess: () => undefined,
    })

    await controller.execute()

    expect(input?.position).toEqual({ x: 20, y: 40 })
    expect(input).not.toHaveProperty('relationship')
  })

  test('Given 节点有输入输出边 When 计算删除影响 Then 只统计一次每条关联边', () => {
    const document = createSnapshot(1).document
    document.nodes = [
      { id: 'agent-1', kind: 'agent', title: 'Agent 1', agentSessionId: 'session-1', position: { x: 0, y: 0 } },
      { id: 'agent-2', kind: 'agent', title: 'Agent 2', agentSessionId: 'session-2', position: { x: 320, y: 0 } },
    ]
    document.edges = [
      { id: 'edge-in', sourceNodeId: 'agent-2', sourcePort: 'output', targetNodeId: 'agent-1', targetPort: 'input' },
      { id: 'edge-out', sourceNodeId: 'agent-1', sourcePort: 'output', targetNodeId: 'agent-2', targetPort: 'input' },
    ]

    expect(getNativeCanvasConnectedEdgeCount(document, 'agent-1')).toBe(2)
  })

  test('Given 停止后删除请求 When Canvas 或 session 已切换 Then 旧请求不得提交删除', () => {
    const pending = {
      requestGeneration: 1,
      canvasKey: 'project-1:canvas-a',
      nodeId: 'agent-1',
      sessionId: 'session-old',
      startedAt: 100,
      stopAccepted: true,
    }
    const currentNode = {
      id: 'agent-1', kind: 'agent' as const, title: 'Agent 1',
      agentSessionId: 'session-old', position: { x: 0, y: 0 },
    }

    expect(isPendingCanvasStopDeleteCurrent(pending, 'project-1:canvas-a', currentNode, 100)).toBe(true)
    expect(isPendingCanvasStopDeleteCurrent(pending, 'project-1:canvas-b', currentNode, 100)).toBe(false)
    expect(isPendingCanvasStopDeleteCurrent(
      pending,
      'project-1:canvas-a',
      { ...currentNode, agentSessionId: 'session-new' },
      100,
    )).toBe(false)
    expect(isPendingCanvasStopDeleteCurrent(pending, 'project-1:canvas-a', currentNode, 200)).toBe(false)
  })

  test('Given STOP 绑定 generation 100 When 同 session generation 200 接管 Then 旧删除立即取消', () => {
    const pending = {
      requestGeneration: 1, canvasKey: 'project-1:canvas-a', nodeId: 'agent-1', sessionId: 'session-1',
      startedAt: 100, stopAccepted: true,
    }
    expect(getPendingCanvasStopDeleteGenerationStatus(
      pending,
      new Map([['session-1', 200]]),
      new Map(),
      new Set(['session-1']),
    )).toBe('replaced')
  })

  test('Given gen100 STOP 在途 When gen200 pending 后旧 reject 到达 Then 新删除状态完全不变', async () => {
    const deferred = createDeferred<void>()
    const oldPending = {
      requestGeneration: 1, canvasKey: 'project-1:canvas-a', nodeId: 'agent-1',
      sessionId: 'session-1', startedAt: 100, stopAccepted: false,
    }
    const newPending = { ...oldPending, requestGeneration: 2, startedAt: 200 }
    let currentGeneration = 1
    let pending: PendingCanvasStopDelete | null = oldPending
    let submitting = true
    let error: string | null = null
    let deleteCalls = 0
    const settled = settleNativeCanvasStopDeleteAttempt(oldPending, deferred.promise, {
      getCurrentRequestGeneration: () => currentGeneration,
      getPending: () => pending,
      onAccepted: () => { deleteCalls += 1 },
      onRejected: () => { pending = null; submitting = false; error = '旧错误' },
    })

    currentGeneration = 2
    pending = newPending
    deferred.reject(new Error('gen100 stop failed'))
    await settled

    expect({ pending, submitting, error, deleteCalls }).toEqual({
      pending: newPending, submitting: true, error: null, deleteCalls: 0,
    })
  })

  test('Given gen200 已提交删除 When gen100 旧 reject 到达 Then 不干扰在途删除', async () => {
    const deferred = createDeferred<void>()
    const oldPending = {
      requestGeneration: 1, canvasKey: 'project-1:canvas-a', nodeId: 'agent-1',
      sessionId: 'session-1', startedAt: 100, stopAccepted: false,
    }
    const newPending = {
      ...oldPending, requestGeneration: 2, startedAt: 200, stopAccepted: true,
    }
    let pending: PendingCanvasStopDelete | null = newPending
    let submitting = true
    let error: string | null = null
    let deleteCalls = 1
    const settled = settleNativeCanvasStopDeleteAttempt(oldPending, deferred.promise, {
      getCurrentRequestGeneration: () => 2,
      getPending: () => pending,
      onAccepted: () => { deleteCalls += 1 },
      onRejected: () => { pending = null; submitting = false; error = '旧错误' },
    })

    deferred.reject(new Error('gen100 stop failed'))
    await settled

    expect({ pending, submitting, error, deleteCalls }).toEqual({
      pending: newPending, submitting: true, error: null, deleteCalls: 1,
    })
  })

  test('Given gen100 STOP 在途 When gen200 接管后旧 resolve 到达 Then 不接受或触发删除', async () => {
    const deferred = createDeferred<void>()
    const oldPending = {
      requestGeneration: 1, canvasKey: 'project-1:canvas-a', nodeId: 'agent-1',
      sessionId: 'session-1', startedAt: 100, stopAccepted: false,
    }
    const newPending = { ...oldPending, requestGeneration: 2, startedAt: 200 }
    let accepted = 0
    const settled = settleNativeCanvasStopDeleteAttempt(oldPending, deferred.promise, {
      getCurrentRequestGeneration: () => 2,
      getPending: () => newPending,
      onAccepted: () => { accepted += 1 },
      onRejected: () => undefined,
    })

    deferred.resolve()
    await settled

    expect(accepted).toBe(0)
  })

  test('Given 当前 STOP attempt When reject 到达 Then 只结束自身 submitting 并显示错误', async () => {
    const deferred = createDeferred<void>()
    const currentPending = {
      requestGeneration: 3, canvasKey: 'project-1:canvas-a', nodeId: 'agent-1',
      sessionId: 'session-1', startedAt: 300, stopAccepted: false,
    }
    let pending: PendingCanvasStopDelete | null = currentPending
    let submitting = true
    let error: string | null = null
    const settled = settleNativeCanvasStopDeleteAttempt(currentPending, deferred.promise, {
      getCurrentRequestGeneration: () => 3,
      getPending: () => pending,
      onAccepted: () => undefined,
      onRejected: () => { pending = null; submitting = false; error = '停止失败，节点未删除。' },
    })

    deferred.reject(new Error('current stop failed'))
    await settled

    const getState = (): {
      pending: PendingCanvasStopDelete | null
      submitting: boolean
      error: string | null
    } => ({ pending, submitting, error })
    expect(getState()).toEqual({
      pending: null, submitting: false, error: '停止失败，节点未删除。',
    })
  })

  test('Given 旧 STOP Promise 晚回 When 同节点新 generation 已接管 Then 不标记新删除为已停止', () => {
    const oldPending = {
      requestGeneration: 1, canvasKey: 'project-1:canvas-a', nodeId: 'agent-1', sessionId: 'session-1',
      startedAt: 100, stopAccepted: false,
    }
    const newPending = { ...oldPending, startedAt: 200 }

    expect(createStopAcceptedPendingCanvasDelete(newPending, oldPending)).toBe(newPending)
    expect(createStopAcceptedPendingCanvasDelete(oldPending, oldPending)).toEqual({
      ...oldPending,
      stopAccepted: true,
    })
  })

  test('Given STOP 绑定 generation 100 When 匹配代次明确结束 Then 允许提交删除', () => {
    const pending = {
      requestGeneration: 1, canvasKey: 'project-1:canvas-a', nodeId: 'agent-1', sessionId: 'session-1',
      startedAt: 100, stopAccepted: true,
    }
    expect(getPendingCanvasStopDeleteGenerationStatus(
      pending,
      new Map(),
      new Map(),
      new Set(),
    )).toBe('ended')
    expect(getPendingCanvasStopDeleteGenerationStatus(
      pending,
      new Map([['session-1', null]]),
      new Map(),
      new Set(['session-1']),
    )).toBe('unknown')
  })

  test('Given 坏节点重建首次失败 When 显式重试 Then 复用完整 operation 并整体接管快照', async () => {
    const requests: Array<{ operationId: string; nodeId: string }> = []
    const states: CanvasAgentNodeCommandState[] = []
    const rebuiltSnapshot = createSnapshot(8)
    rebuiltSnapshot.nodeIssues = []
    const result: RebuildCanvasAgentNodeResult = {
      snapshot: rebuiltSnapshot,
      session: { id: 'session-new' } as never,
    }
    let attempts = 0
    let success: RebuildCanvasAgentNodeResult | undefined
    const controller = createCanvasAgentNodeRebuildController({
      target: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-1' },
      rebuildAgentNode: async (input) => {
        requests.push(input)
        attempts += 1
        if (attempts === 1) {
          throw new CanvasPublicOperationError(
            'AGENT_SESSION_REBUILD_FAILED',
            '重建失败，请重试。',
          )
        }
        return result
      },
      createId: () => 'operation-rebuild-1',
      onStateChange: (state) => states.push(state),
      onSuccess: (current) => { success = current },
    })

    await expect(controller.execute()).rejects.toThrow('重建失败，请重试。')
    await expect(controller.execute()).resolves.toBeUndefined()

    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(states).toContainEqual({ loading: false, error: '重建失败，请重试。' })
    expect(success).toBe(result)
    expect(createRebuiltNativeCanvasStateUpdate(result, 'agent-1')).toEqual({
      snapshot: rebuiltSnapshot,
      error: null,
    })
  })

  test('Given 坏 Agent 节点 When 渲染 Workspace Then 绕过对话并显示恢复面板', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const snapshot = createSnapshot(7, target)
    snapshot.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: '首页设计',
      agentSessionId: 'session-broken', position: { x: 0, y: 0 },
    }]
    snapshot.nodeIssues = [{
      nodeId: 'agent-1',
      code: 'AGENT_SESSION_UNAVAILABLE',
      allowedActions: ['rebuild-agent-session', 'remove-node'],
    }]
    const stateKey = createNativeCanvasKey(target.projectId, target.canvasId)
    const store = createStore()
    store.set(nativeCanvasStatesAtom, new Map([[stateKey, {
      ...createInitialNativeCanvasState(),
      phase: 'ready',
      snapshot,
      selectedNodeId: 'agent-1',
      expandedNodeId: 'agent-1',
    }]]))
    let conversationRenderCount = 0
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          sessionId="legacy-test-session"
          target={target}
          title="首页 Canvas"
          adapter={{
            loadCanvas: async () => snapshot,
            saveCanvas: async () => snapshot.document,
            onCanvasChanged: () => () => {},
            getCanvasAgentMessages: async () => {
              throw new Error('坏节点禁止读取消息')
            },
            sendCanvasAgentMessage: async () => ({ ok: true }),
            stopCanvasAgent: async () => undefined,
          }}
          flowRenderer={(props) => <>{props.nodes[0]?.data.workbench}</>}
          conversationRenderer={() => {
            conversationRenderCount += 1
            return <div>不应渲染</div>
          }}
        />
      </Provider>,
    )

    expect(html).toContain('此节点关联的 Agent 会话不可用。')
    expect(html).toContain('重建会话')
    expect(conversationRenderCount).toBe(0)
  })

  test('Given Canvas 有工具状态、问题和运行节点 When 渲染 Graph Then 传入真实投影参数', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const snapshot = createSnapshot(3, target)
    snapshot.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent 1',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    snapshot.nodeIssues = [{
      nodeId: 'agent-1', code: 'AGENT_SESSION_UNAVAILABLE',
      allowedActions: ['rebuild-agent-session', 'remove-node'],
    }]
    const store = createStore()
    store.set(nativeCanvasStatesAtom, new Map([[
      createNativeCanvasKey(target.projectId, target.canvasId),
      { ...createInitialNativeCanvasState(), phase: 'ready', snapshot, activeTool: 'pan' },
    ]]))
    store.set(canvasAgentRunningSessionIdsAtom, new Set(['session-1']))
    let flowProps: NativeCanvasFlowProps | undefined

    renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          sessionId="legacy-test-session"
          target={target}
          title="Canvas 1"
          adapter={{
            loadCanvas: async () => snapshot,
            saveCanvas: async () => snapshot.document,
            createCanvasAgentNode: async () => ({
              document: snapshot.document,
              session: { id: 'session-new' } as never,
            }),
            onCanvasChanged: () => () => {},
          }}
          flowRenderer={(props) => {
            flowProps = props
            return <div />
          }}
        />
      </Provider>,
    )

    expect(flowProps?.nodes[0]).toMatchObject({
      data: { status: 'unavailable', canOpenWorkbench: true, canCreateChild: false },
    })
    expect(flowProps?.nodesDraggable).toBe(false)
    expect(flowProps?.panOnDrag).toBe(true)
  })

  test('Given Agent 节点工作台已打开 When 收起工作台 Then 保留普通选区且不再挂载对话', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const snapshot = createSnapshot(7, target)
    snapshot.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent 1',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const store = createStore()
    const stateKey = createNativeCanvasKey(target.projectId, target.canvasId)
    const viewStateKey = createAgentCanvasViewKey('legacy-test-session', target.projectId, target.canvasId)
    store.set(nativeCanvasStatesAtom, new Map([[stateKey, {
      ...createInitialNativeCanvasState(),
      phase: 'ready',
      snapshot,
    }]]))
    store.set(agentCanvasViewStatesAtom, new Map([[viewStateKey, {
      ...createInitialAgentCanvasViewState(snapshot.document.viewport),
      selectedNodeId: 'agent-1',
      selectedNodeIds: ['agent-1'],
      expandedNodeId: 'agent-1',
    }]]))
    let conversationProps: CanvasAgentConversationProps | undefined
    let flowProps: NativeCanvasFlowProps | undefined
    renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          sessionId="legacy-test-session"
          target={target}
          title="Canvas 1"
          adapter={{
            loadCanvas: async () => snapshot,
            saveCanvas: async () => snapshot.document,
            onCanvasChanged: () => () => {},
            getCanvasAgentMessages: async () => ({
              sessionId: 'session-1',
              owner: { ...target, nodeId: 'agent-1', title: 'Agent 1' },
              messages: [],
            }),
            sendCanvasAgentMessage: async () => ({ ok: true }),
            stopCanvasAgent: async () => undefined,
          }}
          flowRenderer={(props) => {
            flowProps = props
            return <>{props.nodes[0]?.data.workbench}</>
          }}
          conversationRenderer={(props) => {
            conversationProps = props
            return <div data-testid="canvas-agent-conversation" />
          }}
        />
      </Provider>,
    )

    expect(conversationProps?.target).toEqual({ ...target, nodeId: 'agent-1' })
    expect(conversationProps?.onClose).toBeFunction()
    conversationProps?.onClose()
    expect(store.get(agentCanvasViewStatesAtom).get(viewStateKey)).toMatchObject({
      selectedNodeId: 'agent-1',
      expandedNodeId: null,
      pendingWorkbenchSwitchNodeId: null,
      workbenchDraft: null,
    })

    /** close 后不再订阅 XYFlow 派生 selection，避免受控选区反写形成反馈循环。 */
    expect(flowProps?.onSelectionChange).toBeUndefined()
    expect(store.get(agentCanvasViewStatesAtom).get(viewStateKey)).toMatchObject({
      selectedNodeId: 'agent-1',
      expandedNodeId: null,
    })
  })

  test('Given 两个内容节点 When 只展开文档 Then Graph 只注入一个文档工作台', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const snapshot = createSnapshot(2, target)
    snapshot.document.nodes = [
      {
        id: 'document-1', kind: 'document', title: '需求文档',
        documentId: 'content-1', contentRevision: 0, position: { x: 0, y: 0 },
      },
      {
        id: 'webview-1', kind: 'webview', title: '首页原型',
        prototypeId: 'prototype-1', contentRevision: 0, position: { x: 320, y: 0 },
      },
    ]
    const store = createStore()
    store.set(nativeCanvasStatesAtom, new Map([[
      createNativeCanvasKey(target.projectId, target.canvasId),
      {
        ...createInitialNativeCanvasState(), phase: 'ready', snapshot,
        selectedNodeId: 'document-1', expandedNodeId: 'document-1',
      },
    ]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          sessionId="legacy-test-session"
          target={target}
          title="Canvas 1"
          adapter={{
            loadCanvas: async () => snapshot,
            saveCanvas: async () => snapshot.document,
            onCanvasChanged: () => () => {},
          }}
          flowRenderer={(props) => (
            <>{props.nodes[0]?.data.workbench}{props.nodes[1]?.data.workbench}</>
          )}
        />
      </Provider>,
    )

    expect(html).toContain('aria-label="文档工作台"')
    expect(html).not.toContain('aria-label="原型工作台"')
    expect(html.match(/aria-label="文档工作台"/gu)).toHaveLength(1)
  })

  test('Given Agent 工作台已展开 When 渲染 Canvas Then 对话只挂载在节点覆盖层且画布不缩窄', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const snapshot = createSnapshot(7, target)
    snapshot.document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent 1',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const store = createStore()
    const stateKey = createNativeCanvasKey(target.projectId, target.canvasId)
    store.set(nativeCanvasStatesAtom, new Map([[stateKey, {
      ...createInitialNativeCanvasState(),
      phase: 'ready',
      snapshot,
      selectedNodeId: 'agent-1',
      expandedNodeId: 'agent-1',
    }]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          sessionId="legacy-test-session"
          target={target}
          title="Canvas 1"
          adapter={{
            loadCanvas: async () => snapshot,
            saveCanvas: async () => snapshot.document,
            onCanvasChanged: () => () => {},
            getCanvasAgentMessages: async () => ({
              sessionId: 'session-1',
              owner: { ...target, nodeId: 'agent-1', title: 'Agent 1' },
              messages: [],
            }),
            sendCanvasAgentMessage: async () => ({ ok: true }),
            stopCanvasAgent: async () => undefined,
          }}
          flowRenderer={(props) => <>{props.nodes[0]?.data.workbench}</>}
          conversationRenderer={() => <div data-testid="canvas-agent-conversation" />}
        />
      </Provider>,
    )

    expect(html).toContain('aria-label="Agent工作台"')
    expect(html).toContain('data-testid="canvas-agent-conversation"')
    expect(html).not.toContain('mr-[min(28rem,100%)]')
    expect(html).toMatch(/data-native-canvas-surface="true"[^>]*class="[^"]*relative/u)
  })

  test('Given Canvas A 创建中切换到 B When A 延迟成功 Then 不更新 B 的状态或节点', async () => {
    const deferred = createDeferred<CanvasAgentNodeCreationResult>()
    const states: CanvasAgentNodeCommandState[] = []
    const successes: string[] = []
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-a' },
      createAgentNode: () => deferred.promise,
      createId: (() => {
        const ids = ['11111111-1111-4111-8111-111111111111', 'node-a']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 0, y: 0 }),
      onStateChange: (state) => states.push(state),
      onSuccess: (nodeId) => successes.push(nodeId),
    })

    const request = controller.execute()
    controller.cancel()
    deferred.resolve({
      document: createSnapshot(1).document,
      session: { id: 'session-a' } as never,
    })
    await request

    expect(states).toEqual([
      { loading: true, error: null },
      { loading: false, error: null },
    ])
    expect(successes).toEqual([])
  })

  test('Given Canvas A 创建中切换到 B When A 延迟失败 Then B 保持非 loading 且无旧错误', async () => {
    const deferred = createDeferred<CanvasAgentNodeCreationResult>()
    const states: CanvasAgentNodeCommandState[] = []
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-a' },
      createAgentNode: () => deferred.promise,
      createId: (() => {
        const ids = ['11111111-1111-4111-8111-111111111111', 'node-a']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 0, y: 0 }),
      onStateChange: (state) => states.push(state),
      onSuccess: () => undefined,
    })

    const request = controller.execute()
    controller.cancel()
    deferred.reject(new Error('Canvas A 创建失败'))
    await expect(request).rejects.toThrow('Canvas A 创建失败')

    expect(states).toEqual([
      { loading: true, error: null },
      { loading: false, error: null },
    ])
  })

  test('Given 用户连续点击 When 首次创建仍在途 Then 只发送一个 operation', async () => {
    const deferred = createDeferred<{
      document: CanvasDocument
      session: { id: string }
    }>()
    /** 主进程实际收到的创建请求。 */
    const inputs: unknown[] = []
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      createAgentNode: (input) => {
        inputs.push(input)
        return deferred.promise as never
      },
      createId: (() => {
        const ids = ['11111111-1111-4111-8111-111111111111', 'node-1']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 100, y: 80 }),
      onStateChange: () => undefined,
      onSuccess: () => undefined,
    })

    const first = controller.execute()
    const duplicate = controller.execute()

    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', position: { x: 100, y: 80 },
    })
    expect(duplicate).toBe(first)
    deferred.resolve({ document: createSnapshot(1).document, session: { id: 'session-1' } })
    await first
  })

  test('Given 首次失败 When 显式重试 Then 复用 operation 并回传权威创建结果', async () => {
    /** 两次请求及按钮状态变化。 */
    const inputs: Array<{ operationId: string; nodeId: string }> = []
    const states: Array<{ loading: boolean; error: string | null }> = []
    const successes: Array<{ nodeId: string; document: CanvasDocument }> = []
    let attempts = 0
    const document = createSnapshot(1).document
    const controller = createCanvasAgentNodeCommandController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      createAgentNode: async (input) => {
        inputs.push(input)
        attempts += 1
        if (attempts === 1) {
          throw new CanvasPublicOperationError('CANVAS_CREATE_FAILED', '创建失败，请重试')
        }
        return { document, session: { id: 'session-1' } as never }
      },
      createId: (() => {
        const ids = ['11111111-1111-4111-8111-111111111111', 'node-1']
        return () => ids.shift()!
      })(),
      getPosition: () => ({ x: 0, y: 0 }),
      onStateChange: (state) => states.push(state),
      onSuccess: (nodeId, result) => successes.push({ nodeId, document: result.document }),
    })

    await expect(controller.execute()).rejects.toThrow('创建失败，请重试')
    await expect(controller.execute()).resolves.toBeUndefined()

    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toEqual(inputs[0])
    expect(states).toContainEqual({ loading: false, error: '创建失败，请重试' })
    expect(successes).toEqual([{ nodeId: 'node-1', document }])
  })

  test('Given Canvas 已加载 When 渲染工具栏 Then 添加 Agent 按钮可达并有 tooltip', () => {
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const store = createStore()
    store.set(nativeCanvasStatesAtom, new Map([[
      createNativeCanvasKey(target.projectId, target.canvasId),
      { ...createInitialNativeCanvasState(), phase: 'ready', snapshot: createSnapshot(0) },
    ]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <NativeCanvasWorkspace
          sessionId="legacy-test-session"
          target={target}
          title="页面 Canvas"
          adapter={{
            loadCanvas: async () => createSnapshot(0),
            saveCanvas: async () => createSnapshot(1).document,
            createCanvasAgentNode: async () => ({
              document: createSnapshot(1).document,
              session: { id: 'session-1' } as never,
            }),
            onCanvasChanged: () => () => {},
          }}
          flowRenderer={() => <div />}
        />
      </Provider>,
    )

    expect(html).toContain('aria-label="添加节点"')
    expect(html).toContain('aria-label="选择工具"')
  })
})
