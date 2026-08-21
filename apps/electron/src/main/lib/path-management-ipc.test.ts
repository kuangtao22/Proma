import { describe, expect, spyOn, test } from 'bun:test'
import { PATH_MANAGEMENT_IPC_CHANNELS } from '@proma/shared'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DataRootLocator } from './data-root-locator'
import type { DataRootLocatorResult } from './data-root-locator'
import { DataRootMigrationCoordinator } from './data-root-migration'
import { PROMA_DATA_ROOT_MARKER_FILE } from './data-root-marker'
import {
  registerPathManagementIpcHandlers,
  resolveDataRootStartupMode,
} from './path-management-ipc'

/** 测试中唯一获授权的 renderer webContents。 */
const expectedWebContents = { send: () => undefined }
/** 通过 sender 身份门的最小 IPC event。 */
const expectedEvent = { sender: expectedWebContents }

/** normal 启动测试通过真实 pick/preview handler 取得服务端授权。 */
async function authorizeMigrationSelection(
  handlers: Map<string, (...args: unknown[]) => unknown>,
): Promise<{ selectionId: string; targetRoot: string }> {
  const pick = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT)
  const preview = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_DATA_ROOT_MIGRATION)
  if (!pick || !preview) throw new Error('缺少 selection 授权 handler')
  const selection = await pick(expectedEvent) as { selectionId: string; targetRoot: string }
  await preview(expectedEvent, selection)
  return selection
}

/** 启动测试使用的无 blocker 目标预览。 */
async function createSafePreview(targetRoot: string) {
  return { targetRoot, deviceType: 'local' as const, requiredBytes: 1, blockers: [] }
}

/** 创建测试用 locator 检查结果，避免触碰真实 home 目录。 */
function createLocatorResult(
  overrides: Partial<DataRootLocatorResult> = {},
): DataRootLocatorResult {
  return {
    status: 'ready',
    state: {
      activeRoot: '/data/proma',
      availability: 'available',
      deviceType: 'unknown',
      migration: null,
    },
    ...overrides,
  }
}

describe('数据根启动模式', () => {
  test('Given 活动数据根离线 When 启动 Then 只进入 data-root-recovery 模式', () => {
    const unavailableLocator = createLocatorResult({
      status: 'unavailable',
      state: {
        activeRoot: '/Volumes/Proma/data',
        availability: 'unavailable',
        deviceType: 'unknown',
        migration: null,
      },
    })

    expect(resolveDataRootStartupMode(unavailableLocator)).toBe('data-root-recovery')
  })

  test('Given 迁移记录存在 When 启动 Then 迁移模式优先于源根离线状态', () => {
    const migratingLocator = createLocatorResult({
      status: 'migration',
      state: {
        activeRoot: '/Volumes/Proma/data',
        availability: 'unavailable',
        deviceType: 'unknown',
        migration: {
          migrationId: 'migration-1',
          stage: 'copying',
          completedBytes: 10,
          totalBytes: 100,
        },
      },
    })

    expect(resolveDataRootStartupMode(migratingLocator)).toBe('data-root-migration')
  })

  test('Given 只有 post-commit cleanup When 启动 Then 保持 normal 并交给自动重试', () => {
    const cleanupLocator = createLocatorResult({
      state: {
        activeRoot: '/data/proma-new',
        previousRoot: '/data/proma-old',
        availability: 'available',
        deviceType: 'unknown',
        migration: null,
        postCommitCleanup: {
          migrationId: 'migration-1',
          targetRoot: '/data/proma-new',
          status: 'failed',
          error: '清理 sidecar 失败',
        },
      },
    })

    expect(resolveDataRootStartupMode(cleanupLocator)).toBe('normal')
  })
})

describe('数据根目录打开', () => {
  /** 注册 normal 模式并返回 OPEN_DATA_ROOT handler 与实际打开记录。 */
  function createOpenDataRootHarness(previousRoot?: string): {
    open: (...args: unknown[]) => unknown
    openedPaths: string[]
  } {
    /** 保存测试所需的通道 handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    /** 保存 shell 实际收到的可信路径。 */
    const openedPaths: string[] = []
    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
      shell: {
        openPath: async (path) => {
          openedPaths.push(path)
          return ''
        },
      },
      coordinator: {
        getStatus: () => ({
          activeRoot: '/data/current',
          ...(previousRoot === undefined ? {} : { previousRoot }),
          availability: 'available',
          deviceType: 'local',
          migration: null,
        }),
        createPlan: async () => ({ migrationId: 'migration-1', stage: 'pending', completedBytes: 0, totalBytes: 1 }),
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => undefined,
      },
    })
    const open = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT)
    if (!open) throw new Error('缺少打开数据根 handler')
    return { open, openedPaths }
  }

  test('Given 存在上次数据根 When 打开 previous Then 只打开 locator 中的 previousRoot', async () => {
    const harness = createOpenDataRootHarness('/data/previous')

    await harness.open(expectedEvent, 'previous')

    expect(harness.openedPaths).toEqual(['/data/previous'])
  })

  test('Given 不存在上次数据根 When 打开 previous Then 明确拒绝且不打开其他目录', async () => {
    const harness = createOpenDataRootHarness()

    expect(harness.open(expectedEvent, 'previous')).rejects.toThrow('当前没有可打开的上次数据根目录')
    expect(harness.openedPaths).toEqual([])
  })

  test('Given renderer 传入任意路径 When 打开数据根 Then 运行时拒绝不可信目标', async () => {
    const harness = createOpenDataRootHarness('/data/previous')

    expect(harness.open(expectedEvent, '/tmp/untrusted')).rejects.toThrow('数据根打开目标无效')
    expect(harness.openedPaths).toEqual([])
  })

  test('Given renderer 未传 target When 打开数据根 Then 拒绝缺省参数', async () => {
    const harness = createOpenDataRootHarness('/data/previous')

    expect(harness.open(expectedEvent)).rejects.toThrow('数据根打开目标无效')
    expect(harness.openedPaths).toEqual([])
  })
})

describe('路径管理 IPC', () => {
  test('Given recovery 模式 When 注册 IPC Then 不读取或构造迁移协调器', () => {
    /** 通过 getter 证明 recovery 注册链没有触碰协调器依赖。 */
    const options = {
      mode: 'data-root-recovery' as const,
      ipc: { handle: () => undefined, removeHandler: () => undefined },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
      get coordinator(): never {
        throw new Error('recovery 不得构造迁移协调器')
      },
    }

    expect(() => registerPathManagementIpcHandlers(options)).not.toThrow()
  })

  test('Given 三种启动模式 When 注册 IPC Then 各自只暴露最小通道集合', () => {
    /** 统一协调器避免通道审计触碰真实业务目录。 */
    const coordinator = {
      getStatus: () => createLocatorResult().state,
      createPlan: async () => ({ migrationId: 'migration-1', stage: 'pending' as const, completedBytes: 0, totalBytes: 100 }),
      runPending: async () => undefined,
      resumePending: async () => undefined,
      cancel: async () => undefined,
    }
    /** 各模式允许的精确 invoke 通道。 */
    const modeChannels = new Map([
      ['normal', [
        PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE,
        PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT,
        'path-management:preview-data-root-migration',
        PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION,
        PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_MIGRATION_STATUS,
        PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT,
      ]],
      ['data-root-migration', [
        PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE,
        PATH_MANAGEMENT_IPC_CHANNELS.RESUME_DATA_ROOT_MIGRATION,
        PATH_MANAGEMENT_IPC_CHANNELS.CANCEL_DATA_ROOT_MIGRATION,
        PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT,
        PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP,
      ]],
      ['data-root-recovery', [
        PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE,
        PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT,
        PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT,
        PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT,
        PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP,
      ]],
    ] as const)

    for (const [mode, expectedChannels] of modeChannels) {
      const channels = registerPathManagementIpcHandlers({
        mode,
        ipc: { handle: () => undefined, removeHandler: () => undefined },
        app: { relaunch: () => undefined, quit: () => undefined },
        getExpectedWebContents: () => expectedWebContents,
        coordinator,
      })
      expect(channels).toEqual([...expectedChannels])
    }
  })

  test('Given 开发热重载从 recovery 切到 normal When 重新注册 Then 不残留旧敏感 handler', () => {
    /** 真实模拟 removeHandler 对同一个 ipcMain handler 表的影响。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown): void => { handlers.set(channel, handler) },
      removeHandler: (channel: string): void => { handlers.delete(channel) },
    }
    const common = {
      ipc,
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
      coordinator: {
        getStatus: () => createLocatorResult().state,
        createPlan: async () => ({ migrationId: 'migration-1', stage: 'pending' as const, completedBytes: 0, totalBytes: 1 }),
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => undefined,
      },
    }

    registerPathManagementIpcHandlers({ ...common, mode: 'data-root-recovery' })
    registerPathManagementIpcHandlers({ ...common, mode: 'normal' })

    expect([...handlers.keys()]).toEqual([
      PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE,
      PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT,
      PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_DATA_ROOT_MIGRATION,
      PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION,
      PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_MIGRATION_STATUS,
      PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT,
    ])
  })

  test('Given normal 窗口已 pick 绝对目标 When preview Then 只预检同一目标且不创建计划', async () => {
    /** 保存 normal 模式 handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    /** 记录 preview 与 createPlan 调用。 */
    const calls: string[] = []
    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/data/proma-new'] }) },
      createSelectionId: () => 'selection-new',
      coordinator: {
        getStatus: () => createLocatorResult().state,
        previewTarget: async (targetRoot) => {
          calls.push(`preview:${targetRoot}`)
          return {
            targetRoot,
            deviceType: 'removable',
            availableBytes: 1000,
            requiredBytes: 100,
            blockers: [],
          }
        },
        createPlan: async (targetRoot) => {
          calls.push(`create:${targetRoot}`)
          return { migrationId: 'migration-1', stage: 'pending', completedBytes: 0, totalBytes: 100 }
        },
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => undefined,
      },
    })
    const pickHandler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT)
    const previewHandler = handlers.get('path-management:preview-data-root-migration')
    if (!pickHandler || !previewHandler) throw new Error('缺少 pick 或 preview handler')

    const selection = await pickHandler(expectedEvent)
    expect(selection).toEqual({ selectionId: 'selection-new', targetRoot: '/data/proma-new' })
    expect(await previewHandler(expectedEvent, selection)).toMatchObject({ deviceType: 'removable', blockers: [] })
    await expect(previewHandler(expectedEvent, { selectionId: 'selection-new', targetRoot: '/data/other' }))
      .rejects.toThrow('目标选择已失效')
    await expect(previewHandler(expectedEvent, { selectionId: 'selection-new', targetRoot: 'relative' }))
      .rejects.toThrow('数据根目标选择无效')
    expect(calls).toEqual(['preview:/data/proma-new'])
  })

  test('Given 未 preview、旧 selection 或 A-token/B-path When start Then 服务端全部拒绝', async () => {
    /** 系统选择器依次授权 A、B 两个目录。 */
    const pickedRoots = ['/data/a', '/data/b']
    /** 生成可断言的服务端 selectionId。 */
    const selectionIds = ['selection-a', 'selection-b']
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    let createdPlans = 0
    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [pickedRoots.shift() ?? '/data/missing'] }),
      },
      createSelectionId: () => selectionIds.shift() ?? 'selection-extra',
      coordinator: {
        getStatus: () => createLocatorResult().state,
        previewTarget: async (targetRoot) => ({
          targetRoot,
          deviceType: 'local',
          availableBytes: 1000,
          requiredBytes: 10,
          blockers: [],
        }),
        createPlan: async () => {
          createdPlans += 1
          return { migrationId: 'migration-1', stage: 'pending', completedBytes: 0, totalBytes: 10 }
        },
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => undefined,
      },
    })
    const pick = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT)
    const preview = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_DATA_ROOT_MIGRATION)
    const start = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION)
    if (!pick || !preview || !start) throw new Error('缺少 selection 状态机 handler')

    const selectionA = await pick(expectedEvent) as { selectionId: string; targetRoot: string }
    await expect(start(expectedEvent, selectionA)).rejects.toThrow('目标选择尚未完成预检')
    await preview(expectedEvent, selectionA)
    const selectionB = await pick(expectedEvent) as { selectionId: string; targetRoot: string }
    await expect(start(expectedEvent, selectionA)).rejects.toThrow('目标选择已失效')
    await expect(start(expectedEvent, { selectionId: selectionA.selectionId, targetRoot: selectionB.targetRoot }))
      .rejects.toThrow('目标选择已失效')
    expect(createdPlans).toBe(0)
  })

  test('Given coordinator 返回不同目标 When preview Then 不记录 previewed 授权', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/data/a'] }) },
      createSelectionId: () => 'selection-a',
      coordinator: {
        getStatus: () => createLocatorResult().state,
        previewTarget: async () => ({ targetRoot: '/data/other', deviceType: 'local', requiredBytes: 1, blockers: [] }),
        createPlan: async () => ({ migrationId: 'migration-1', stage: 'pending', completedBytes: 0, totalBytes: 1 }),
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => undefined,
      },
    })
    const pick = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT)
    const preview = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_DATA_ROOT_MIGRATION)
    const start = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION)
    if (!pick || !preview || !start) throw new Error('缺少目标一致性 handler')
    const selection = await pick(expectedEvent) as { selectionId: string; targetRoot: string }

    await expect(preview(expectedEvent, selection)).rejects.toThrow('预检返回的目标数据根不一致')
    await expect(start(expectedEvent, selection)).rejects.toThrow('目标选择尚未完成预检')
  })

  test('Given 新 pick 已开始或旧 pick 晚返回 When preview/start Then 旧代次永不恢复授权', async () => {
    /** 精确控制两个系统选择器完成顺序。 */
    const dialogResolvers: Array<(value: { canceled: boolean; filePaths: string[] }) => void> = []
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
      dialog: {
        showOpenDialog: async () => await new Promise((resolve) => { dialogResolvers.push(resolve) }),
      },
      createSelectionId: () => 'selection-current',
      coordinator: {
        getStatus: () => createLocatorResult().state,
        previewTarget: async (targetRoot) => ({
          targetRoot,
          deviceType: 'local',
          requiredBytes: 1,
          blockers: [],
        }),
        createPlan: async () => ({ migrationId: 'migration-1', stage: 'pending', completedBytes: 0, totalBytes: 1 }),
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => undefined,
      },
    })
    const pick = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT)
    const preview = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_DATA_ROOT_MIGRATION)
    if (!pick || !preview) throw new Error('缺少并发 pick handler')

    const pickA = Promise.resolve(pick(expectedEvent))
    const pickB = Promise.resolve(pick(expectedEvent))
    dialogResolvers[1]?.({ canceled: false, filePaths: ['/data/b'] })
    const selectionB = await pickB as { selectionId: string; targetRoot: string }
    dialogResolvers[0]?.({ canceled: false, filePaths: ['/data/a'] })
    expect(await pickA).toBeNull()
    expect(selectionB).toEqual({ selectionId: 'selection-current', targetRoot: '/data/b' })
    await expect(preview(expectedEvent, { selectionId: 'stale-a', targetRoot: '/data/a' }))
      .rejects.toThrow('目标选择已失效')
    await expect(preview(expectedEvent, selectionB)).resolves.toMatchObject({ targetRoot: '/data/b' })
  })

  test('Given preview A 尚未完成 When pick B Then A 晚完成也不能给 B 或 A 授权', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const roots = ['/data/a', '/data/b']
    const ids = ['selection-a', 'selection-b']
    /** 第一轮 preview 的 resolver 用于制造 A-preview/B-pick 交错。 */
    const previewResolvers: Array<(value: Awaited<ReturnType<typeof createSafePreview>>) => void> = []
    let previewCalls = 0
    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [roots.shift() ?? '/data/missing'] }) },
      createSelectionId: () => ids.shift() ?? 'selection-extra',
      coordinator: {
        getStatus: () => createLocatorResult().state,
        previewTarget: async (targetRoot) => {
          previewCalls += 1
          if (previewCalls === 1) {
            return await new Promise((resolve) => { previewResolvers.push(resolve) })
          }
          return createSafePreview(targetRoot)
        },
        createPlan: async () => ({ migrationId: 'migration-1', stage: 'pending', completedBytes: 0, totalBytes: 1 }),
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => undefined,
      },
    })
    const pick = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT)
    const preview = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_DATA_ROOT_MIGRATION)
    if (!pick || !preview) throw new Error('缺少 preview 交错 handler')
    const selectionA = await pick(expectedEvent) as { selectionId: string; targetRoot: string }
    const previewA = Promise.resolve(preview(expectedEvent, selectionA))
    const selectionB = await pick(expectedEvent) as { selectionId: string; targetRoot: string }
    previewResolvers[0]?.(await createSafePreview(selectionA.targetRoot))

    await expect(previewA).rejects.toThrow('目标选择已失效')
    await expect(preview(expectedEvent, selectionB)).resolves.toMatchObject({ targetRoot: '/data/b' })
  })

  test('Given 已成功 preview When 两次并发 start Then selection 只允许一个调用占用', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    /** 首次 start 在 createPlan 内暂停，暴露第二次并发调用窗口。 */
    const createPlanResolvers: Array<() => void> = []
    let createPlanCalls = 0
    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/data/a'] }) },
      createSelectionId: () => 'selection-a',
      coordinator: {
        getStatus: () => createLocatorResult().state,
        previewTarget: async (targetRoot) => ({
          targetRoot,
          deviceType: 'local',
          requiredBytes: 1,
          blockers: [],
        }),
        createPlan: async () => {
          createPlanCalls += 1
          await new Promise<void>((resolve) => { createPlanResolvers.push(resolve) })
          return { migrationId: 'migration-1', stage: 'pending', completedBytes: 0, totalBytes: 1 }
        },
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => undefined,
      },
    })
    const pick = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT)
    const preview = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_DATA_ROOT_MIGRATION)
    const start = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION)
    if (!pick || !preview || !start) throw new Error('缺少并发 start handler')
    const selection = await pick(expectedEvent) as { selectionId: string; targetRoot: string }
    await preview(expectedEvent, selection)

    const firstStart = Promise.resolve(start(expectedEvent, selection))
    await expect(start(expectedEvent, selection)).rejects.toThrow('目标选择已失效')
    for (let attempt = 0; attempt < 10 && createPlanResolvers.length === 0; attempt += 1) await Promise.resolve()
    expect(createPlanCalls).toBe(1)
    createPlanResolvers[0]?.()
    await expect(firstStart).resolves.toBeUndefined()
    expect(createPlanCalls).toBe(1)
  })

  test('Given 真实 coordinator 与 IPC When renderer 选择并预览 Then 返回真实预检且无磁盘写入', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'proma-path-preview-chain-'))
    const sourceRoot = join(homeDir, 'source')
    const targetRoot = join(homeDir, 'target')
    mkdirSync(sourceRoot)
    writeFileSync(join(sourceRoot, 'settings.json'), '{"theme":"dark"}')
    const locator = new DataRootLocator({ homeDir })
    locator.write({ version: 1, activeRoot: sourceRoot })
    const coordinator = new DataRootMigrationCoordinator({
      locator,
      lockPath: join(homeDir, 'migration.lock'),
      createMigrationId: () => 'preview-chain',
      getAvailableBytes: async () => 10_000,
    })
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerPathManagementIpcHandlers({
      mode: 'normal',
      homeDir,
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [targetRoot] }) },
      coordinator,
    })
    const pick = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT)
    const preview = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_DATA_ROOT_MIGRATION)
    if (!pick || !preview) throw new Error('缺少真实预览链 handler')

    const selection = await pick(expectedEvent) as { selectionId: string; targetRoot: string }
    expect(selection.targetRoot).toBe(targetRoot)
    expect(await preview(expectedEvent, selection)).toMatchObject({
      targetRoot,
      requiredBytes: Buffer.byteLength('{"theme":"dark"}'),
      availableBytes: 10_000,
      blockers: [],
    })
    expect(locator.inspect().locatorFile?.migration).toBeUndefined()
    expect(() => readFileSync(targetRoot)).toThrow()
  })

  test('Given normal 状态查询 When 存储检查成功或失败 Then 合并真实元数据或安全降级', async () => {
    /** 注册两次独立 handler，验证异常不会让设置页整体加载失败。 */
    const registerGetState = (inspectStorage: () => Promise<{
      occupiedBytes: number
      availableBytes: number
      deviceType: 'network'
    }>): ((...args: unknown[]) => unknown) => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>()
      registerPathManagementIpcHandlers({
        mode: 'normal',
        ipc: {
          handle: (channel, handler) => { handlers.set(channel, handler) },
          removeHandler: () => undefined,
        },
        app: { relaunch: () => undefined, quit: () => undefined },
        getExpectedWebContents: () => expectedWebContents,
        coordinator: {
          getStatus: () => createLocatorResult().state,
          createPlan: async () => ({ migrationId: 'migration-1', stage: 'pending', completedBytes: 0, totalBytes: 1 }),
          runPending: async () => undefined,
          resumePending: async () => undefined,
          cancel: async () => undefined,
        },
        inspectStorage,
      })
      const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE)
      if (!handler) throw new Error('缺少状态 handler')
      return handler
    }
    const success = registerGetState(async () => ({ occupiedBytes: 10, availableBytes: 90, deviceType: 'network' }))
    const failure = registerGetState(async () => { throw new Error('模拟 statfs 失败') })

    expect(await success(expectedEvent)).toMatchObject({ occupiedBytes: 10, availableBytes: 90, deviceType: 'network' })
    expect(await failure(expectedEvent)).toMatchObject({ availability: 'available', deviceType: 'unknown' })
  })

  test('Given 普通或路径窗口之外的 sender When 调用敏感通道 Then 一律拒绝', () => {
    /** 分别保存 normal/recovery handler，模拟 planning/其他普通窗口直接 invoke。 */
    const registerMode = (mode: 'normal' | 'data-root-recovery'): Map<string, (...args: unknown[]) => unknown> => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>()
      registerPathManagementIpcHandlers({
        mode,
        homeDir: '/tmp/proma-wrong-sender-test',
        ipc: {
          handle: (channel, handler) => { handlers.set(channel, handler) },
          removeHandler: (channel) => { handlers.delete(channel) },
        },
        app: { relaunch: () => undefined, quit: () => undefined },
        getExpectedWebContents: () => expectedWebContents,
        coordinator: {
          getStatus: () => createLocatorResult().state,
          createPlan: async () => ({ migrationId: 'migration-1', stage: 'pending', completedBytes: 0, totalBytes: 1 }),
          runPending: async () => undefined,
          resumePending: async () => undefined,
          cancel: async () => undefined,
        },
      })
      return handlers
    }
    const normalHandlers = registerMode('normal')
    const recoveryHandlers = registerMode('data-root-recovery')

    expect(() => normalHandlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION)?.({ sender: {} }, '/data/new'))
      .toThrow('当前窗口无权执行路径管理操作')
    expect(() => recoveryHandlers.get(PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT)?.({ sender: {} }, { action: 'recheck' }))
      .toThrow('当前窗口无权执行路径管理操作')
    expect(() => recoveryHandlers.get(PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP)?.({ sender: {} }))
      .toThrow('当前窗口无权执行路径管理操作')
  })

  test('Given 正常模式且没有活跃任务 When 创建计划 Then 计划落盘后立即重启退出', async () => {
    /** 验证计划、relaunch、quit 的严格调用顺序。 */
    const calls: string[] = []
    /** 保存注册的 invoke handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()

    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: {
        relaunch: () => { calls.push('relaunch') },
        quit: () => { calls.push('quit') },
      },
      getExpectedWebContents: () => expectedWebContents,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/data/proma-new'] }) },
      hasActiveTasks: () => {
        calls.push('check-tasks')
        return false
      },
      hasOtherPromaInstance: () => {
        calls.push('check-instances')
        return false
      },
      acquireMigrationGuard: () => {
        calls.push('acquire-intent')
        return { release: () => { calls.push('release-intent') } }
      },
      coordinator: {
        getStatus: () => createLocatorResult().state,
        previewTarget: createSafePreview,
        createPlan: async () => {
          calls.push('create-plan')
          return {
            migrationId: 'migration-1',
            stage: 'pending',
            completedBytes: 0,
            totalBytes: 100,
          }
        },
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => undefined,
      },
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION)
    if (!handler) throw new Error('未注册创建迁移计划通道')
    const selection = await authorizeMigrationSelection(handlers)
    await handler(expectedEvent, selection)

    expect(calls).toEqual([
      'check-tasks',
      'check-instances',
      'acquire-intent',
      'check-tasks',
      'check-instances',
      'create-plan',
      'check-tasks',
      'check-instances',
      'release-intent',
      'relaunch',
      'quit',
    ])
  })

  test('Given pending 已持久化且 guard 每次释放都失败 When 创建计划 Then 保留 pending 并必然重启退出', async () => {
    /** 隔离真实 locator，证明 guard 清理失败不会撤销已持久化计划。 */
    const homeDir = await mkdtemp(join(tmpdir(), 'proma-path-guard-release-'))
    /** 当前活动根只用于构造合法 locator 状态。 */
    const sourceRoot = join(homeDir, 'source-root')
    /** 迁移目标根由测试协调器直接写入 pending 记录。 */
    const targetRoot = join(homeDir, 'target-root')
    mkdirSync(sourceRoot)
    const locator = new DataRootLocator({ homeDir })
    locator.write({ version: 1, activeRoot: sourceRoot })
    /** 记录 guard 清理和应用退出的严格调用顺序。 */
    const calls: string[] = []
    /** 保存注册的迁移启动 handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    /** 抑制预期的受控警告，同时验证失败未向 renderer 传播。 */
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      registerPathManagementIpcHandlers({
        mode: 'normal',
        homeDir,
        ipc: {
          handle: (channel, handler) => { handlers.set(channel, handler) },
          removeHandler: () => undefined,
        },
        app: {
          relaunch: () => { calls.push('relaunch') },
          quit: () => { calls.push('quit') },
        },
        getExpectedWebContents: () => expectedWebContents,
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [targetRoot] }) },
        acquireMigrationGuard: () => ({
          release: () => {
            calls.push('release-intent')
            throw new Error('模拟 intent 清理持续失败')
          },
        }),
        coordinator: {
          getStatus: () => locator.inspect().state,
          previewTarget: createSafePreview,
          createPlan: async () => {
            calls.push('create-plan')
            locator.beginMigration({
              id: 'migration-guard-release',
              sourceRoot,
              targetRoot,
              stage: 'pending',
              completedBytes: 0,
              totalBytes: 100,
              startedAt: 1,
              updatedAt: 1,
            })
            return {
              migrationId: 'migration-guard-release',
              stage: 'pending',
              completedBytes: 0,
              totalBytes: 100,
            }
          },
          runPending: async () => undefined,
          resumePending: async () => undefined,
          cancel: async () => { calls.push('cancel') },
        },
      })

      const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION)
      if (!handler) throw new Error('未注册创建迁移计划通道')
      const selection = await authorizeMigrationSelection(handlers)
      await expect(handler(expectedEvent, selection)).resolves.toBeUndefined()

      expect(calls).toEqual(['create-plan', 'release-intent', 'relaunch', 'quit'])
      expect(locator.inspect().locatorFile?.migration).toMatchObject({
        id: 'migration-guard-release',
        stage: 'pending',
      })
      expect(warningSpy).toHaveBeenCalledTimes(1)
    } finally {
      warningSpy.mockRestore()
    }
  })

  test('Given createPlan 失败 When 启动迁移 Then 释放 guard 且不重启', async () => {
    /** 记录计划失败后的清理与禁止发生的重启动作。 */
    const calls: string[] = []
    /** 保存注册的迁移启动 handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()

    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: {
        relaunch: () => { calls.push('relaunch') },
        quit: () => { calls.push('quit') },
      },
      getExpectedWebContents: () => expectedWebContents,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/data/proma-new'] }) },
      acquireMigrationGuard: () => {
        calls.push('acquire-intent')
        return { release: () => { calls.push('release-intent') } }
      },
      coordinator: {
        getStatus: () => createLocatorResult().state,
        previewTarget: createSafePreview,
        createPlan: async () => {
          calls.push('create-plan')
          throw new Error('模拟计划创建失败')
        },
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => { calls.push('cancel') },
      },
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION)
    if (!handler) throw new Error('未注册创建迁移计划通道')
    const selection = await authorizeMigrationSelection(handlers)
    await expect(handler(expectedEvent, selection)).rejects.toThrow('模拟计划创建失败')
    await expect(handler(expectedEvent, selection)).rejects.toThrow('目标选择已失效')
    expect(calls).toEqual(['acquire-intent', 'create-plan', 'release-intent'])
  })

  test('Given createPlan 失败且 guard 无法释放 When 没有 pending Then 返回可操作错误且不静默继续', async () => {
    /** 记录无 pending 场景下的计划、清理与重启动作。 */
    const calls: string[] = []
    /** 保存注册的迁移启动 handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()

    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: {
        relaunch: () => { calls.push('relaunch') },
        quit: () => { calls.push('quit') },
      },
      getExpectedWebContents: () => expectedWebContents,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/data/proma-new'] }) },
      acquireMigrationGuard: () => ({
        release: () => {
          calls.push('release-intent')
          throw new Error('模拟无 pending 时 intent 清理失败')
        },
      }),
      coordinator: {
        getStatus: () => createLocatorResult().state,
        previewTarget: createSafePreview,
        createPlan: async () => {
          calls.push('create-plan')
          throw new Error('模拟计划创建失败')
        },
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => { calls.push('cancel') },
      },
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION)
    if (!handler) throw new Error('未注册创建迁移计划通道')
    const selection = await authorizeMigrationSelection(handlers)
    await expect(handler(expectedEvent, selection)).rejects.toThrow('请完全退出所有 Proma 实例后重试')
    expect(calls).toEqual(['create-plan', 'release-intent'])
  })

  test('Given 存在活跃 Agent 或 Automation When 创建计划 Then 拒绝且不写计划', async () => {
    /** 标记测试中是否错误写入迁移计划。 */
    let created = false
    /** 保存注册的 invoke handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()

    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/data/proma-new'] }) },
      hasActiveTasks: () => true,
      coordinator: {
        getStatus: () => createLocatorResult().state,
        previewTarget: createSafePreview,
        createPlan: async () => {
          created = true
          throw new Error('不应执行')
        },
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => undefined,
      },
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION)
    if (!handler) throw new Error('未注册创建迁移计划通道')
    const selection = await authorizeMigrationSelection(handlers)
    await expect(handler(expectedEvent, selection)).rejects.toThrow('仍有 Agent 或 Automation 正在运行')
    expect(created).toBe(false)
  })

  test('Given 异步预检期间启动新任务 When 计划刚落盘且撤销成功 Then 返回阻断错误且不重启', async () => {
    /** 前两次预检通过，计划落盘后的第三次检查发现新任务。 */
    let activeChecks = 0
    /** 标记已落盘计划是否被安全撤销。 */
    let cancelled = false
    /** 保存注册的 invoke handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    /** 记录 pending 已撤销后禁止发生的应用重启。 */
    const relaunchCalls: string[] = []

    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: {
        relaunch: () => { relaunchCalls.push('relaunch') },
        quit: () => { relaunchCalls.push('quit') },
      },
      getExpectedWebContents: () => expectedWebContents,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/data/proma-new'] }) },
      hasActiveTasks: () => {
        activeChecks += 1
        return activeChecks === 3
      },
      hasOtherPromaInstance: () => false,
      acquireMigrationGuard: () => ({ release: () => undefined }),
      coordinator: {
        getStatus: () => createLocatorResult().state,
        previewTarget: createSafePreview,
        createPlan: async () => ({
          migrationId: 'migration-1',
          stage: 'pending',
          completedBytes: 0,
          totalBytes: 100,
        }),
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => { cancelled = true },
      },
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION)
    if (!handler) throw new Error('未注册创建迁移计划通道')
    const selection = await authorizeMigrationSelection(handlers)
    await expect(handler(expectedEvent, selection)).rejects.toThrow('仍有 Agent 或 Automation 正在运行')
    expect(cancelled).toBe(true)
    expect(relaunchCalls).toEqual([])
  })

  test('Given 异步预检期间启动新任务 When pending 撤销失败 Then 释放 guard 并必然重启退出', async () => {
    /** 前两次预检通过，计划落盘后的第三次检查发现新任务。 */
    let activeChecks = 0
    /** 记录撤销失败、guard 释放与应用退出的严格顺序。 */
    const calls: string[] = []
    /** 保存注册的迁移启动 handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()

    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: {
        relaunch: () => { calls.push('relaunch') },
        quit: () => { calls.push('quit') },
      },
      getExpectedWebContents: () => expectedWebContents,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/data/proma-new'] }) },
      hasActiveTasks: () => {
        activeChecks += 1
        return activeChecks === 3
      },
      hasOtherPromaInstance: () => false,
      acquireMigrationGuard: () => ({ release: () => { calls.push('release-intent') } }),
      coordinator: {
        getStatus: () => createLocatorResult({
          status: 'migration',
          state: {
            activeRoot: '/data/proma',
            availability: 'available',
            deviceType: 'unknown',
            migration: {
              migrationId: 'migration-1',
              stage: 'pending',
              completedBytes: 0,
              totalBytes: 100,
            },
          },
        }).state,
        previewTarget: createSafePreview,
        createPlan: async () => ({
          migrationId: 'migration-1',
          stage: 'pending',
          completedBytes: 0,
          totalBytes: 100,
        }),
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => {
          calls.push('cancel')
          throw new Error('模拟 pending 撤销失败')
        },
      },
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION)
    if (!handler) throw new Error('未注册创建迁移计划通道')
    const selection = await authorizeMigrationSelection(handlers)
    await expect(handler(expectedEvent, selection)).rejects.toThrow('模拟 pending 撤销失败')
    expect(calls).toEqual(['cancel', 'release-intent', 'relaunch', 'quit'])
  })

  test('Given 数据根已移动到新目录 When 重新定位 Then 原子更新 locator 并重启', async () => {
    /** 隔离 locator 与候选目录的测试 home。 */
    const homeDir = await mkdtemp(join(tmpdir(), 'proma-path-recovery-'))
    /** 当前已经离线的旧数据根。 */
    const offlineRoot = join(homeDir, 'offline-root')
    /** 用户重新找到的可用数据根。 */
    const relocatedRoot = join(homeDir, 'relocated-root')
    mkdirSync(relocatedRoot)
    writeFileSync(join(relocatedRoot, 'settings.json'), '{"themeMode":"dark"}')
    new DataRootLocator({ homeDir }).write({ version: 1, activeRoot: offlineRoot })
    /** 保存注册的 recovery handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    /** 记录重启与退出。 */
    const calls: string[] = []

    registerPathManagementIpcHandlers({
      mode: 'data-root-recovery',
      homeDir,
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: {
        relaunch: () => { calls.push('relaunch') },
        quit: () => { calls.push('quit') },
      },
      getExpectedWebContents: () => expectedWebContents,
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT)
    if (!handler) throw new Error('未注册数据根恢复通道')
    handler(expectedEvent, { action: 'relocate', selectedRoot: relocatedRoot })

    expect(new DataRootLocator({ homeDir }).inspect().locatorFile).toMatchObject({
      activeRoot: relocatedRoot,
      previousRoot: offlineRoot,
    })
    expect(JSON.parse(
      readFileSync(join(relocatedRoot, PROMA_DATA_ROOT_MARKER_FILE), 'utf8'),
    )).toEqual({ owner: 'proma', version: 1 })
    expect(calls).toEqual(['relaunch', 'quit'])
  })

  test('Given previousRoot 已恢复在线 When 切回旧备份 Then 验证目录后交换 activeRoot', async () => {
    /** 隔离 locator 与候选目录的测试 home。 */
    const homeDir = await mkdtemp(join(tmpdir(), 'proma-path-restore-'))
    /** 当前已经离线的活动根。 */
    const offlineRoot = join(homeDir, 'offline-root')
    /** 已重新在线的旧备份根。 */
    const previousRoot = join(homeDir, 'previous-root')
    mkdirSync(previousRoot)
    writeFileSync(join(previousRoot, 'settings.json'), '{"themeMode":"dark"}')
    new DataRootLocator({ homeDir }).write({
      version: 1,
      activeRoot: offlineRoot,
      previousRoot,
    })
    /** 保存注册的 recovery handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()

    registerPathManagementIpcHandlers({
      mode: 'data-root-recovery',
      homeDir,
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT)
    if (!handler) throw new Error('未注册数据根恢复通道')
    handler(expectedEvent, { action: 'restore-previous' })

    expect(new DataRootLocator({ homeDir }).inspect().locatorFile).toMatchObject({
      activeRoot: previousRoot,
      previousRoot: offlineRoot,
    })
    expect(JSON.parse(
      readFileSync(join(previousRoot, PROMA_DATA_ROOT_MARKER_FILE), 'utf8'),
    )).toEqual({ owner: 'proma', version: 1 })
  })

  test('Given 迁移后的 marker-only 根重新在线 When recovery 重新定位 Then 不要求 legacy 文件', async () => {
    /** 模拟迁移目标仅保留所有权 marker，业务配置均为可选。 */
    const homeDir = await mkdtemp(join(tmpdir(), 'proma-path-marker-only-recovery-'))
    const offlineRoot = join(homeDir, 'offline-root')
    const markerOnlyRoot = join(homeDir, 'marker-only-root')
    mkdirSync(markerOnlyRoot)
    writeFileSync(
      join(markerOnlyRoot, PROMA_DATA_ROOT_MARKER_FILE),
      '{"owner":"proma","version":1}',
    )
    new DataRootLocator({ homeDir }).write({ version: 1, activeRoot: offlineRoot })
    /** 保存 recovery handler，证明完整 IPC 路径接受 marker-only 根。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()

    registerPathManagementIpcHandlers({
      mode: 'data-root-recovery',
      homeDir,
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT)
    if (!handler) throw new Error('未注册数据根恢复通道')
    expect(() => handler(expectedEvent, { action: 'relocate', selectedRoot: markerOnlyRoot })).not.toThrow()
    expect(new DataRootLocator({ homeDir }).inspect().locatorFile).toMatchObject({
      activeRoot: markerOnlyRoot,
      previousRoot: offlineRoot,
    })
  })

  test('Given 候选为空目录或普通目录 When 重新定位 Then 拒绝且 locator 不变', async () => {
    /** 隔离 locator 与候选目录的测试 home。 */
    const homeDir = await mkdtemp(join(tmpdir(), 'proma-path-invalid-root-'))
    /** 当前离线根必须在失败后保持不变。 */
    const offlineRoot = join(homeDir, 'offline-root')
    /** 两种不能证明为 Proma 数据根的候选目录。 */
    const emptyRoot = join(homeDir, 'empty-root')
    const ordinaryRoot = join(homeDir, 'ordinary-root')
    mkdirSync(emptyRoot)
    mkdirSync(ordinaryRoot)
    writeFileSync(join(ordinaryRoot, 'notes.txt'), 'ordinary')
    writeFileSync(join(ordinaryRoot, 'settings.json'), '{"project":"ordinary"}')
    new DataRootLocator({ homeDir }).write({ version: 1, activeRoot: offlineRoot })
    /** 保存注册的 recovery handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()

    registerPathManagementIpcHandlers({
      mode: 'data-root-recovery',
      homeDir,
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT)
    if (!handler) throw new Error('未注册数据根恢复通道')
    expect(() => handler(expectedEvent, { action: 'relocate', selectedRoot: emptyRoot }))
      .toThrow('所选目录不是可识别的 Proma 数据根')
    expect(() => handler(expectedEvent, { action: 'relocate', selectedRoot: ordinaryRoot }))
      .toThrow('所选目录不是可识别的 Proma 数据根')
    expect(new DataRootLocator({ homeDir }).inspect().locatorFile).toMatchObject({ activeRoot: offlineRoot })
  })

  test('Given cleanup 尚未解决 When 重新定位或切回旧根 Then 阻断且保留完整 locator', async () => {
    /** 隔离 locator 与候选目录的测试 home。 */
    const homeDir = await mkdtemp(join(tmpdir(), 'proma-path-cleanup-block-'))
    /** cleanup 指向的当前目标盘离线。 */
    const activeRoot = join(homeDir, 'offline-active-root')
    /** 可识别的新位置与旧根都不能覆盖 cleanup 意图。 */
    const relocatedRoot = join(homeDir, 'relocated-root')
    const previousRoot = join(homeDir, 'previous-root')
    mkdirSync(relocatedRoot)
    mkdirSync(previousRoot)
    writeFileSync(join(relocatedRoot, 'settings.json'), '{"themeMode":"dark"}')
    writeFileSync(join(previousRoot, 'settings.json'), '{"themeMode":"dark"}')
    /** cleanup 状态用于证明恢复动作不会静默丢弃提交后清理。 */
    const cleanup = {
      migrationId: 'migration-1',
      targetRoot: activeRoot,
      error: '目标盘离线',
    }
    const locator = new DataRootLocator({ homeDir })
    locator.write({ version: 1, activeRoot, previousRoot, postCommitCleanup: cleanup })
    /** 保存注册的 recovery handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()

    registerPathManagementIpcHandlers({
      mode: 'data-root-recovery',
      homeDir,
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: () => undefined,
      },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => expectedWebContents,
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT)
    if (!handler) throw new Error('未注册数据根恢复通道')
    expect(() => handler(expectedEvent, { action: 'relocate', selectedRoot: relocatedRoot }))
      .toThrow('迁移已提交但仍待清理')
    expect(() => handler(expectedEvent, { action: 'restore-previous' }))
      .toThrow('迁移已提交但仍待清理')
    expect(locator.inspect().locatorFile).toEqual({
      version: 1,
      activeRoot,
      previousRoot,
      postCommitCleanup: cleanup,
    })
  })
})
