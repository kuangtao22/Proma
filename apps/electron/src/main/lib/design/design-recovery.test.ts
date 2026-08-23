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
import { registerDesignIpcHandlers } from './design-ipc'
import type { DesignIpcOptions } from './design-ipc'
import { DesignJobManager } from './design-job-manager'
import { createDesignPathResolver } from './design-paths'
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
          imageModelProfileId: 'profile-test', position: { x: 0, y: 0 },
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
    const manager = createRecoveryJobManager(store, pathResolver)

    expect(manager.recover('project-1')).toContainEqual(expect.objectContaining({
      id: 'job-running', status: 'interrupted', error: '应用退出，任务已中断',
    }))
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
    jobs: {
      create: () => { effects.push('create'); return createJobRecord('job-created') },
      run: async () => { effects.push('run') },
      cancel: async () => createJobRecord('job-cancelled'),
      retry: () => { effects.push('retry'); return createJobRecord('job-retry') },
      list: () => [],
      reconcilePendingTerminals: () => [],
      onChanged: () => () => undefined,
    },
    imageModels: {
      listCatalog: () => ({ profiles: [], inheritedFromLegacyConfig: false, credentialsConfigured: false }),
      replaceProfiles: (profiles) => ({ profiles, inheritedFromLegacyConfig: false, credentialsConfigured: false }),
      resolveAvailableSnapshot: (profileId) => ({
        profileId, name: '测试模型', executor: 'nano-banana', modelId: 'test-model',
      }),
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
    id, projectId: 'project-1', action: 'generate' as const, status: 'queued' as const,
    prompt: '生成海报', createdAt: 1, updatedAt: 1,
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
): DesignJobManager {
  return new DesignJobManager({
    pathResolver: { resolve: (projectId) => ({ jobsDir: pathResolver.resolve(projectId).jobsDir }) },
    store,
    assetService: {
      resolveAssetPath: () => '/unused',
      importAuthorizedFiles: async () => createEmptyBatch(),
    },
    getSettings: () => ({}),
    getSession: () => undefined,
    createSession: () => { throw new Error('恢复不应创建会话') },
    updateSession: () => undefined,
    runHeadless: async () => undefined,
    stopAgent: () => undefined,
    resolveOwnedOutputPath: () => undefined,
    listProjectIds: () => ['project-1'],
    runWorkspaceWrite: (_projectId, effect) => effect(),
    now: () => 10,
  })
}
