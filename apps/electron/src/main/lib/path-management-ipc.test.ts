import { describe, expect, spyOn, test } from 'bun:test'
import { PATH_MANAGEMENT_IPC_CHANNELS } from '@proma/shared'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DataRootLocator } from './data-root-locator'
import type { DataRootLocatorResult } from './data-root-locator'
import { PROMA_DATA_ROOT_MARKER_FILE } from './data-root-marker'
import {
  registerPathManagementIpcHandlers,
  resolveDataRootStartupMode,
} from './path-management-ipc'

/** 测试中唯一获授权的 renderer webContents。 */
const expectedWebContents = { send: () => undefined }
/** 通过 sender 身份门的最小 IPC event。 */
const expectedEvent = { sender: expectedWebContents }

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
      PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION,
      PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_MIGRATION_STATUS,
      PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT,
    ])
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
    await handler(expectedEvent, '/data/proma-new')

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
        acquireMigrationGuard: () => ({
          release: () => {
            calls.push('release-intent')
            throw new Error('模拟 intent 清理持续失败')
          },
        }),
        coordinator: {
          getStatus: () => locator.inspect().state,
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
      await expect(handler(expectedEvent, targetRoot)).resolves.toBeUndefined()

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
      acquireMigrationGuard: () => ({ release: () => { calls.push('release-intent') } }),
      coordinator: {
        getStatus: () => createLocatorResult().state,
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
    await expect(handler(expectedEvent, '/data/proma-new')).rejects.toThrow('模拟计划创建失败')
    expect(calls).toEqual(['create-plan', 'release-intent'])
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
      acquireMigrationGuard: () => ({
        release: () => {
          calls.push('release-intent')
          throw new Error('模拟无 pending 时 intent 清理失败')
        },
      }),
      coordinator: {
        getStatus: () => createLocatorResult().state,
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
    await expect(handler(expectedEvent, '/data/proma-new')).rejects.toThrow('请完全退出所有 Proma 实例后重试')
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
    await expect(handler(expectedEvent, '/data/proma-new')).rejects.toThrow('仍有 Agent 或 Automation 正在运行')
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
    await expect(handler(expectedEvent, '/data/proma-new')).rejects.toThrow('仍有 Agent 或 Automation 正在运行')
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
    await expect(handler(expectedEvent, '/data/proma-new')).rejects.toThrow('模拟 pending 撤销失败')
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
