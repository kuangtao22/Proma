import { describe, expect, test } from 'bun:test'
import { PATH_MANAGEMENT_IPC_CHANNELS } from '@proma/shared'
import { mkdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DataRootLocator } from './data-root-locator'
import type { DataRootLocatorResult } from './data-root-locator'
import {
  registerPathManagementIpcHandlers,
  resolveDataRootStartupMode,
} from './path-management-ipc'

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

describe('路径管理 IPC', () => {
  test('Given 迁移模式 When 注册 IPC Then 只暴露路径恢复合同', () => {
    /** 记录主进程注册的全部通道。 */
    const registeredChannels: string[] = []

    const channels = registerPathManagementIpcHandlers({
      mode: 'data-root-migration',
      ipc: {
        handle: (channel) => { registeredChannels.push(channel) },
        removeHandler: () => undefined,
      },
      app: {
        relaunch: () => undefined,
        quit: () => undefined,
      },
      getAllWindows: () => [],
      coordinator: {
        getStatus: () => createLocatorResult().state,
        createPlan: async () => ({
          migrationId: 'migration-1',
          stage: 'pending',
          completedBytes: 0,
          totalBytes: 100,
        }),
        runPending: async () => undefined,
        resumePending: async () => undefined,
        cancel: async () => undefined,
      },
    })

    expect(channels).toEqual([
      PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE,
      PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT,
      PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_MIGRATION_STATUS,
      PATH_MANAGEMENT_IPC_CHANNELS.RESUME_DATA_ROOT_MIGRATION,
      PATH_MANAGEMENT_IPC_CHANNELS.CANCEL_DATA_ROOT_MIGRATION,
      PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT,
      PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT,
      PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP,
    ])
    expect(registeredChannels).toEqual(channels)
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
      getAllWindows: () => [],
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
    await handler({}, '/data/proma-new')

    expect(calls).toEqual([
      'check-tasks',
      'check-instances',
      'acquire-intent',
      'check-tasks',
      'check-instances',
      'create-plan',
      'check-tasks',
      'check-instances',
      'relaunch',
      'quit',
    ])
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
      getAllWindows: () => [],
      hasActiveTasks: () => true,
      coordinator: {
        getStatus: () => createLocatorResult().state,
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
    await expect(handler({}, '/data/proma-new')).rejects.toThrow('仍有 Agent 或 Automation 正在运行')
    expect(created).toBe(false)
  })

  test('Given 异步预检期间启动新任务 When 计划刚落盘 Then 撤销计划且不重启', async () => {
    /** 前两次预检通过，计划落盘后的第三次检查发现新任务。 */
    let activeChecks = 0
    /** 标记已落盘计划是否被安全撤销。 */
    let cancelled = false
    /** 保存注册的 invoke handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    /** 记录禁止发生的应用重启。 */
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
      getAllWindows: () => [],
      hasActiveTasks: () => {
        activeChecks += 1
        return activeChecks === 3
      },
      hasOtherPromaInstance: () => false,
      acquireMigrationGuard: () => ({ release: () => undefined }),
      coordinator: {
        getStatus: () => createLocatorResult().state,
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
    await expect(handler({}, '/data/proma-new')).rejects.toThrow('仍有 Agent 或 Automation 正在运行')
    expect(cancelled).toBe(true)
    expect(relaunchCalls).toEqual([])
  })

  test('Given 数据根已移动到新目录 When 重新定位 Then 原子更新 locator 并重启', async () => {
    /** 隔离 locator 与候选目录的测试 home。 */
    const homeDir = await mkdtemp(join(tmpdir(), 'proma-path-recovery-'))
    /** 当前已经离线的旧数据根。 */
    const offlineRoot = join(homeDir, 'offline-root')
    /** 用户重新找到的可用数据根。 */
    const relocatedRoot = join(homeDir, 'relocated-root')
    mkdirSync(relocatedRoot)
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
      getAllWindows: () => [],
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT)
    if (!handler) throw new Error('未注册数据根恢复通道')
    handler({}, { action: 'relocate', selectedRoot: relocatedRoot })

    expect(new DataRootLocator({ homeDir }).inspect().locatorFile).toMatchObject({
      activeRoot: relocatedRoot,
      previousRoot: offlineRoot,
    })
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
      getAllWindows: () => [],
    })

    const handler = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT)
    if (!handler) throw new Error('未注册数据根恢复通道')
    handler({}, { action: 'restore-previous' })

    expect(new DataRootLocator({ homeDir }).inspect().locatorFile).toMatchObject({
      activeRoot: previousRoot,
      previousRoot: offlineRoot,
    })
  })
})
