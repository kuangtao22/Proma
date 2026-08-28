import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DESIGN_IPC_CHANNELS, createEmptyDesignDocument } from '@proma/shared'
import type { DesignCanvasDocument, DesignMutation, DesignWorkspaceSnapshot } from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { DesignAssetService } from './design-asset-service'
import { DesignContextCatalog } from './design-context-catalog'
import { DesignContextOrchestrator } from './design-context-orchestrator'
import { registerDesignIpcHandlers } from './design-ipc'
import type { DesignIpcOptions } from './design-ipc'
import { DesignJobManager } from './design-job-manager'
import { createDesignPathResolver } from './design-paths'
import { DesignProjectTextIndex } from './design-project-text-index'
import { createDesignStore } from './design-store'
import type { DesignStore } from './design-store'

/** 测试记录型 IPC handler。 */
type TestHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 可观察主进程广播的最小窗口。 */
interface TestSender extends WebContents {
  sent: Array<{ channel: string; value: unknown }>
}

describe('Design 跨模块恢复与资源边界', () => {
  let projectRoot: string
  let configRoot: string
  let pathResolver: ReturnType<typeof createDesignPathResolver>
  let store: DesignStore

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'proma-design-recovery-project-'))
    configRoot = mkdtempSync(join(tmpdir(), 'proma-design-recovery-config-'))
    pathResolver = createDesignPathResolver({
      getWorkspace: () => ({
        id: 'project-1', name: '项目', slug: 'project-slug', projectRootPath: projectRoot,
        createdAt: 1, updatedAt: 1,
      }),
      getProjectFilesPath: () => projectRoot,
      getConfigDir: () => configRoot,
    })
    store = createDesignStore({ pathResolver, now: () => 100 })
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(configRoot, { recursive: true, force: true })
  })

  test('Given 项目离线 When LOAD Then 返回固定原因的只读空文档且不创建项目或缓存目录', async () => {
    const fixture = createIpcFixture(store, '项目路径不可访问，设计工作区已切换为只读')
    registerDesignIpcHandlers(fixture.options)

    const snapshot = await invoke(fixture, DESIGN_IPC_CHANNELS.LOAD, { projectId: 'project-1' }) as DesignWorkspaceSnapshot

    expect(snapshot).toMatchObject({
      writable: false,
      readOnlyReason: '项目路径不可访问，设计工作区已切换为只读',
      document: { projectId: 'project-1', revision: 0 },
    })
    expect(existsSync(join(projectRoot, '.proma'))).toBe(false)
    expect(existsSync(join(configRoot, 'design-cache'))).toBe(false)
  })

  test('Given 主画布损坏且 backup 有效 When LOAD Then 提升备份并广播 recovery', async () => {
    const saved = store.mutate('project-1', 0, [{
      type: 'set-viewport', viewport: { x: 10, y: 20, zoom: 1.25 },
    }])
    const canvasPath = pathResolver.resolve('project-1').canvasPath
    writeFileSync(`${canvasPath}.bak`, readFileSync(canvasPath))
    writeFileSync(canvasPath, '{ broken', 'utf8')
    const fixture = createIpcFixture(store)
    registerDesignIpcHandlers(fixture.options)

    const snapshot = await invoke(fixture, DESIGN_IPC_CHANNELS.LOAD, { projectId: 'project-1' }) as DesignWorkspaceSnapshot

    expect(snapshot.recoveredFrom).toBe('backup')
    expect(snapshot.document.revision).toBe(saved.revision)
    expect(fixture.sender.sent).toContainEqual({
      channel: DESIGN_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', revision: saved.revision, cause: 'recovery' },
    })
  })

  test('Given 项目迁移锁 When save/import/create/retry Then 在业务副作用前统一阻止', async () => {
    const fixture = createIpcFixture(store)
    /** 迁移锁是所有正式写入的唯一准入边界。 */
    fixture.options.guard.runWorkspaceWrite = () => {
      throw new Error('项目正在迁移，请等待完成后重试')
    }
    registerDesignIpcHandlers(fixture.options)
    const cases: Array<{ channel: string; input: object }> = [
      {
        channel: DESIGN_IPC_CHANNELS.SAVE_MUTATIONS,
        input: { projectId: 'project-1', expectedRevision: 0, mutations: [] as DesignMutation[] },
      },
      {
        channel: DESIGN_IPC_CHANNELS.IMPORT_ASSETS,
        input: { projectId: 'project-1', expectedRevision: 0, viewportCenter: { x: 0, y: 0 } },
      },
      {
        channel: DESIGN_IPC_CHANNELS.CREATE_JOB,
        input: {
          projectId: 'project-1', action: 'generate', prompt: '生成海报',
          contextMode: 'auto', imageModelProfileId: 'profile-test',
          target: { kind: 'design-canvas', position: { x: 0, y: 0 } },
        },
      },
      {
        channel: DESIGN_IPC_CHANNELS.RETRY_JOB,
        input: { projectId: 'project-1', jobId: 'job-1' },
      },
    ]

    for (const current of cases) {
      await expect(invoke(fixture, current.channel, current.input))
        .rejects.toThrow('项目正在迁移，请等待完成后重试')
    }
    expect(fixture.effects).toEqual([])
  })

  test('Given 启动时存在无 journal 的 staging 遗留 When 恢复 Then 清理遗留且不删除正式 assets', () => {
    store.load('project-1')
    const paths = pathResolver.resolve('project-1')
    const abandoned = join(paths.stagingDir, 'import-abandoned')
    const retainedAsset = join(paths.assetsDir, 'retained.png')
    mkdirSync(abandoned)
    writeFileSync(join(abandoned, 'partial.png'), 'partial')
    writeFileSync(retainedAsset, 'asset')
    const service = createAssetService(store, pathResolver)

    service.recoverPromotionJournals('project-1')

    expect(readdirSync(paths.stagingDir)).toEqual([])
    expect(readFileSync(retainedAsset, 'utf8')).toBe('asset')
  })

  test('Given 上个进程留下 running job When 启动恢复 Then 标记 interrupted', () => {
    store.load('project-1')
    const paths = pathResolver.resolve('project-1')
    writeFileSync(join(paths.jobsDir, 'job-running.json'), JSON.stringify({
      id: 'job-running', projectId: 'project-1', sessionId: 'session-1', action: 'generate',
      status: 'running', prompt: '生成海报', nodeId: 'node-running', position: { x: 0, y: 0 },
      createdAt: 1, updatedAt: 2,
    }))
    /** 恢复过程启动 Agent 的次数，必须保持为零。 */
    let agentRunCount = 0
    const manager = createRecoveryJobManager(store, pathResolver, {
      onRunHeadless: () => { agentRunCount += 1 },
    })

    expect(manager.recover('project-1')).toContainEqual(expect.objectContaining({
      id: 'job-running', status: 'interrupted', error: '应用退出，任务已中断', contextMode: 'none',
    }))
    expect(agentRunCount).toBe(0)
  })

  test('Given 上个进程留下 Canvas active Job When 启动恢复 Then 只标记 interrupted 且不自动运行', () => {
    store.load('project-1')
    const paths = pathResolver.resolve('project-1')
    writeFileSync(join(paths.jobsDir, 'job-canvas-running.json'), JSON.stringify({
      id: 'job-canvas-running', creativeTaskId: 'creative-canvas', attemptNumber: 1,
      projectId: 'project-1', sessionId: 'session-canvas', action: 'generate', status: 'running',
      prompt: '生成首页主视觉', originalRequest: '生成首页主视觉', contextMode: 'none',
      target: {
        kind: 'canvas-image', canvasId: 'canvas-1',
        nodeId: 'image-node-1', imageModuleId: 'image-module-1',
      },
      generationConstraints: { aspectRatio: '16:9', imageSize: '2K' },
      canvasImageConfigRevision: 3,
      canvasInputReferences: [{
        nodeId: 'document-1', kind: 'document', revision: 2,
        summary: '已提交首页文档', summaryHash: 'a'.repeat(64),
      }],
      imageModelSnapshot: {
        profileId: 'profile-test', name: '测试生图模型',
        executor: 'nano-banana', modelId: 'image-model-test',
      },
      traceState: 'pending', executionSessionCleanupState: 'pending',
      startedAt: 2, createdAt: 1, updatedAt: 2,
    }))
    let createdSessionCount = 0
    let agentRunCount = 0
    const manager = createRecoveryJobManager(store, pathResolver, {
      onCreateSession: () => { createdSessionCount += 1 },
      onRunHeadless: () => { agentRunCount += 1 },
    })

    expect(manager.recover('project-1')).toContainEqual(expect.objectContaining({
      id: 'job-canvas-running', status: 'interrupted',
      target: { kind: 'canvas-image', canvasId: 'canvas-1', nodeId: 'image-node-1', imageModuleId: 'image-module-1' },
      generationConstraints: { aspectRatio: '16:9', imageSize: '2K' },
      canvasImageConfigRevision: 3,
    }))
    expect(createdSessionCount).toBe(0)
    expect(agentRunCount).toBe(0)
  })

  test('Given 上下文清单损坏 When 普通加载并以 project 模式生成 Then 画布可用且图片调用前失败', async () => {
    store.load('project-1')
    const paths = pathResolver.resolve('project-1')
    mkdirSync(paths.contextRoot, { recursive: true })
    writeFileSync(paths.contextManifestPath, '{broken', 'utf8')
    /** 使用真实 Catalog 证明普通 LOAD 不读取损坏的创作上下文清单。 */
    const catalog = new DesignContextCatalog({ pathResolver })
    const fixture = createIpcFixture(store)
    fixture.options.context = catalog
    registerDesignIpcHandlers(fixture.options)

    const snapshot = await invoke(
      fixture,
      DESIGN_IPC_CHANNELS.LOAD,
      { projectId: 'project-1' },
    ) as DesignWorkspaceSnapshot
    expect(snapshot.document).toMatchObject({ projectId: 'project-1', revision: 0 })

    /** 真实上下文编排器在 project 预检阶段读取损坏 Catalog。 */
    const contextOrchestrator = new DesignContextOrchestrator({
      catalog,
      textIndex: new DesignProjectTextIndex({ pathResolver }),
    })
    /** 会话创建和 Agent 运行次数共同证明不会到达付费图片工具。 */
    let createdSessionCount = 0
    let agentRunCount = 0
    const manager = createRecoveryJobManager(store, pathResolver, {
      contextOrchestrator,
      onCreateSession: () => { createdSessionCount += 1 },
      onRunHeadless: () => { agentRunCount += 1 },
    })
    const job = manager.create({
      projectId: 'project-1',
      action: 'generate',
      prompt: '根据项目资料生成首页效果图',
      contextMode: 'project',
      imageModelProfileId: 'profile-test',
      position: { x: 0, y: 0 },
    })

    await manager.run(job.id)

    expect(manager.get(job.id)).toMatchObject({
      status: 'failed',
      error: '创作上下文清单无效: project-1',
    })
    expect(createdSessionCount).toBe(0)
    expect(agentRunCount).toBe(0)
  })
})

/** 创建受真实 Store 支撑、但业务副作用可观察的 IPC fixture。 */
function createIpcFixture(store: DesignStore, readOnlyReason?: string): {
  options: DesignIpcOptions
  handlers: Map<string, TestHandler>
  sender: TestSender
  effects: string[]
} {
  const handlers = new Map<string, TestHandler>()
  const effects: string[] = []
  const sender = {
    id: 1,
    sent: [],
    isDestroyed: () => false,
    send: (channel: string, value: unknown) => { sender.sent.push({ channel, value }) },
    once: () => sender,
    removeListener: () => sender,
  } as unknown as TestSender
  const options: DesignIpcOptions = {
    ipc: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    listAuthorizedWebContents: () => [sender],
    guard: { runWorkspaceWrite: (_projectId, effect) => effect() },
    store,
    assets: {
      importAuthorizedFiles: async () => { effects.push('import'); return createEmptyBatch() },
      deleteAsset: () => { effects.push('delete'); return createEmptyDesignDocument('project-1') },
      relinkAsset: async () => { effects.push('relink'); return createEmptyDesignDocument('project-1') },
      exportAsset: async () => { effects.push('export') },
      createMediaAccess: () => ({
        assetBaseUrl: 'proma-file://assets',
        thumbnailBaseUrl: 'proma-file://thumbnails',
        release: () => undefined,
      }),
    },
    context: {
      list: () => [],
      upsertDocument: () => { throw new Error('恢复测试不写上下文') },
      importDocument: () => { throw new Error('恢复测试不导入上下文') },
      updateMetadata: () => { throw new Error('恢复测试不更新上下文') },
      registerAsset: () => { throw new Error('恢复测试不登记上下文素材') },
      delete: () => undefined,
    },
    jobs: {
      create: () => { effects.push('create'); return createJobRecord('job-created') },
      run: async () => { effects.push('run') },
      cancel: async () => createJobRecord('job-cancelled'),
      retry: () => { effects.push('retry'); return createJobRecord('job-retry') },
      delete: () => { effects.push('delete-job'); return createEmptyDesignDocument('project-1') },
      list: () => [],
      getTaskDetails: (_projectId, jobId, includeTrace) => ({
        creativeTaskId: `creative-${jobId}`,
        currentJobId: jobId,
        attempts: [],
        traceState: 'unavailable',
        ...(includeTrace ? { trace: [] } : {}),
      }),
      reconcilePendingTerminals: () => [],
      onChanged: () => () => undefined,
    },
    imageModels: {
      listCatalog: () => ({ profiles: [], channelOptions: [], inheritedFromLegacyConfig: false, credentialsConfigured: false }),
      replaceProfiles: (profiles) => ({ profiles, channelOptions: [], inheritedFromLegacyConfig: false, credentialsConfigured: false }),
    },
    imagePreferences: {
      getSelection: (projectId) => ({ projectId, options: [] }),
      setSelection: ({ projectId, imageModelProfileId }) => ({
        projectId, options: [], selectedProfileId: imageModelProfileId,
      }),
      onChanged: () => () => undefined,
    },
    sessionBridge: {
      prepareAssetForSession: () => { throw new Error('未配置') },
      importAgentImage: async () => { throw new Error('未配置') },
    },
    pickImageFiles: async () => { effects.push('picker'); return [] },
    pickMarkdownFile: async () => null,
    pickRelinkImageFile: async () => null,
    pickExportPath: async () => null,
    getProjectReadOnlyReason: () => readOnlyReason,
  }
  return { options, handlers, sender, effects }
}

/** 调用测试 fixture 中已注册的 IPC handler。 */
function invoke(
  fixture: { handlers: Map<string, TestHandler>; sender: TestSender },
  channel: string,
  input: unknown,
): Promise<unknown> {
  const handler = fixture.handlers.get(channel)
  if (!handler) throw new Error(`handler 未注册: ${channel}`)
  return Promise.resolve(handler({ sender: fixture.sender } as unknown as IpcMainInvokeEvent, input))
}

/** 创建空素材批次，同时保留事务方法合同。 */
function createEmptyBatch() {
  const batch = [] as unknown as Awaited<ReturnType<DesignAssetService['importAuthorizedFiles']>>
  batch.commit = () => undefined
  batch.rollback = () => undefined
  return batch
}

/** 创建最小任务记录供被 guard 阻止的 handler 满足类型。 */
function createJobRecord(id: string) {
  return {
    id, creativeTaskId: `creative-${id}`, attemptNumber: 1,
    projectId: 'project-1', action: 'generate' as const, status: 'queued' as const,
    prompt: '生成海报', originalRequest: '生成海报', contextMode: 'none' as const,
    createdAt: 1, updatedAt: 1,
  }
}

/** 创建真实素材恢复服务，媒体注册不参与本测试。 */
function createAssetService(
  store: DesignStore,
  pathResolver: ReturnType<typeof createDesignPathResolver>,
): DesignAssetService {
  return new DesignAssetService({
    pathResolver,
    store,
    runWorkspaceWrite: (_projectId, effect) => effect(),
    registerDirectoryPath: (path) => `proma-file://${basename(path)}`,
    revokePathUrl: () => undefined,
    warn: () => undefined,
    runtimeId: 'runtime-current',
  })
}

/** 创建只执行 journal 恢复路径的最小 Design Job Manager。 */
function createRecoveryJobManager(
  store: DesignStore,
  pathResolver: ReturnType<typeof createDesignPathResolver>,
  overrides: {
    /** 可替换真实上下文编排器以覆盖预检失败。 */
    contextOrchestrator?: Pick<DesignContextOrchestrator, 'createRun'>
    /** 记录意外的内部会话创建。 */
    onCreateSession?: () => void
    /** 记录意外的 Agent 执行。 */
    onRunHeadless?: () => void
  } = {},
): DesignJobManager {
  return new DesignJobManager({
    pathResolver: { resolve: (projectId) => {
      const paths = pathResolver.resolve(projectId)
      return { jobsDir: paths.jobsDir, projectRoot: paths.projectRoot }
    } },
    store,
    assetService: {
      resolveAssetPath: () => '/unused',
      importAuthorizedFiles: async () => createEmptyBatch(),
    },
    imageModels: {
      resolveAvailableSnapshot: (profileId) => ({
        profileId, name: '测试生图模型', executor: 'nano-banana', modelId: 'image-model-test',
      }),
      assertSnapshotAvailable: () => undefined,
      resolveExecutionRoute: (snapshot) => {
        /** 恢复测试不会运行图片工具，仅补齐 Nano Banana 路由契约。 */
        if (snapshot.executor !== 'nano-banana') throw new Error('恢复测试不支持 OpenAI Images 路由')
        return { executor: 'nano-banana', snapshot }
      },
    },
    contextOrchestrator: overrides.contextOrchestrator ?? {
      createRun: () => ({
        tools: [], allowedToolNames: [], getReferences: () => [], getWarnings: () => [],
        assertReadyForImageCall: () => undefined,
      }),
    },
    getSettings: () => ({ agentChannelId: 'channel-test', agentModelId: 'model-test' }),
    getSession: () => undefined,
    getSessionMessages: () => [],
    createSession: () => {
      overrides.onCreateSession?.()
      throw new Error('恢复或上下文预检失败时不应创建会话')
    },
    runHeadless: async () => { overrides.onRunHeadless?.() },
    stopAgent: () => undefined,
    traceStore: {
      writeFromMessages: () => ({ summary: { rawThinkingAvailable: false }, entryCount: 0 }),
      read: () => [],
      delete: () => undefined,
    },
    sessionLifecycle: { cleanup: async () => undefined },
    resolveOwnedOutputPath: () => undefined,
    listProjectIds: () => ['project-1'],
    runWorkspaceWrite: (_projectId, effect) => effect(),
    now: () => 10,
  })
}
