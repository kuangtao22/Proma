import { describe, expect, test } from 'bun:test'
import { PATH_MANAGEMENT_IPC_CHANNELS } from '@proma/shared'
import type { DataRootMigrationProgress, PathManagementState } from '@proma/shared'
import type { IpcRendererEvent } from 'electron'
import * as pathManagementPreload from './path-management-preload'
import type { PathManagementPreloadIpc } from './path-management-preload'

/** 测试记录的 renderer listener。 */
type RecordedListener = (event: IpcRendererEvent, ...args: unknown[]) => void

/** 三种 preload 工厂的目标导出合同。 */
interface ExpectedPreloadFactories {
  /** 创建普通主窗口的路径 API。 */
  createNormalPathManagementPreloadApi: (ipc: PathManagementPreloadIpc) => Record<string, unknown>
  /** 创建迁移窗口的路径 API。 */
  createMigrationPathManagementPreloadApi: (ipc: PathManagementPreloadIpc) => Record<string, unknown>
  /** 创建恢复窗口的路径 API。 */
  createRecoveryPathManagementPreloadApi: (ipc: PathManagementPreloadIpc) => Record<string, unknown>
  /** 按专用窗口 mode 选择最小 API。 */
  createDedicatedPathManagementPreloadApi: (
    mode: 'data-root-migration' | 'data-root-recovery',
    ipc: PathManagementPreloadIpc,
  ) => Record<string, unknown>
}

/** 把当前模块作为目标工厂合同读取，RED 阶段会明确暴露缺失导出。 */
function getExpectedFactories(): ExpectedPreloadFactories {
  return pathManagementPreload as unknown as ExpectedPreloadFactories
}

/** 创建记录 invoke 与 listener 的最小 ipcRenderer。 */
function createRecordedIpc(): {
  ipc: PathManagementPreloadIpc
  invokes: Array<{ channel: string; args: unknown[] }>
  added: RecordedListener[]
  removed: RecordedListener[]
} {
  /** 保存全部 invoke 调用。 */
  const invokes: Array<{ channel: string; args: unknown[] }> = []
  /** 保存注册的 listener。 */
  const added: RecordedListener[] = []
  /** 保存移除的 listener。 */
  const removed: RecordedListener[] = []
  return {
    invokes,
    added,
    removed,
    ipc: {
      invoke: async (channel, ...args) => {
        invokes.push({ channel, args })
        return undefined
      },
      on: (_channel, listener) => { added.push(listener) },
      removeListener: (_channel, listener) => { removed.push(listener) },
    },
  }
}

/** 调用对象上一个无返回值异步动作。 */
async function invokeApi(api: Record<string, unknown>, key: string, ...args: unknown[]): Promise<void> {
  const action = api[key]
  if (typeof action !== 'function') throw new Error(`缺少 preload 方法: ${key}`)
  await action(...args)
}

describe('路径管理 preload API', () => {
  test('Given normal 主窗口 When 创建真实 API 对象 Then 只暴露 normal keys 并调用 allowlist 通道', async () => {
    const { createNormalPathManagementPreloadApi } = getExpectedFactories()
    expect(typeof createNormalPathManagementPreloadApi).toBe('function')
    const recorded = createRecordedIpc()
    /** 普通窗口实际暴露的路径 API。 */
    const api = createNormalPathManagementPreloadApi(recorded.ipc)
    /** 主进程签发的目标选择授权必须原样传给 preview/start。 */
    const selection = { selectionId: 'selection-1', targetRoot: '/data/new' }

    expect(Object.keys(api).sort()).toEqual([
      'getDataRootMigrationStatus',
      'getPathManagementState',
      'onDataRootMigrationProgress',
      'openDataRoot',
      'pickDataRoot',
      'previewDataRootMigration',
      'startDataRootMigration',
    ])

    await invokeApi(api, 'getPathManagementState')
    await invokeApi(api, 'pickDataRoot')
    await invokeApi(api, 'previewDataRootMigration', selection)
    await invokeApi(api, 'startDataRootMigration', selection)
    await invokeApi(api, 'getDataRootMigrationStatus')
    await invokeApi(api, 'openDataRoot', 'previous')
    expect(recorded.invokes).toEqual([
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE, args: [] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT, args: [] },
      { channel: 'path-management:preview-data-root-migration', args: [selection] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION, args: [selection] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_MIGRATION_STATUS, args: [] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT, args: ['previous'] },
    ])
  })

  test('Given migration 专用窗口 When 创建真实 API 对象 Then 只暴露迁移 keys 并调用迁移通道', async () => {
    const { createMigrationPathManagementPreloadApi } = getExpectedFactories()
    expect(typeof createMigrationPathManagementPreloadApi).toBe('function')
    const recorded = createRecordedIpc()
    /** 迁移窗口实际暴露的路径 API。 */
    const api = createMigrationPathManagementPreloadApi(recorded.ipc)

    expect(Object.keys(api).sort()).toEqual([
      'cancelDataRootMigration',
      'exitDataRootManagement',
      'getPathManagementState',
      'onDataRootMigrationProgress',
      'openDataRoot',
      'resumeDataRootMigration',
    ])

    await invokeApi(api, 'getPathManagementState')
    await invokeApi(api, 'resumeDataRootMigration')
    await invokeApi(api, 'cancelDataRootMigration')
    await invokeApi(api, 'openDataRoot', 'current')
    await invokeApi(api, 'exitDataRootManagement')
    expect(recorded.invokes).toEqual([
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE, args: [] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.RESUME_DATA_ROOT_MIGRATION, args: [] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.CANCEL_DATA_ROOT_MIGRATION, args: [] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT, args: ['current'] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP, args: [] },
    ])
  })

  test('Given recovery 专用窗口 When 创建真实 API 对象 Then 只暴露恢复 keys 并调用恢复通道', async () => {
    const { createRecoveryPathManagementPreloadApi } = getExpectedFactories()
    expect(typeof createRecoveryPathManagementPreloadApi).toBe('function')
    const recorded = createRecordedIpc()
    /** 恢复窗口实际暴露的路径 API。 */
    const api = createRecoveryPathManagementPreloadApi(recorded.ipc)

    expect(Object.keys(api).sort()).toEqual([
      'exitDataRootManagement',
      'getPathManagementState',
      'openDataRoot',
      'pickDataRoot',
      'recoverDataRoot',
    ])

    await invokeApi(api, 'getPathManagementState')
    await invokeApi(api, 'pickDataRoot')
    await invokeApi(api, 'recoverDataRoot', { action: 'relocate', selectedRoot: '/data/found' })
    await invokeApi(api, 'openDataRoot', 'current')
    await invokeApi(api, 'exitDataRootManagement')
    expect(recorded.invokes).toEqual([
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE, args: [] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT, args: [] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT, args: [{ action: 'relocate', selectedRoot: '/data/found' }] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT, args: ['current'] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP, args: [] },
    ])
  })

  test('Given dedicated mode When 选择 API Then 返回对应的真实最小对象', () => {
    const { createDedicatedPathManagementPreloadApi } = getExpectedFactories()
    expect(typeof createDedicatedPathManagementPreloadApi).toBe('function')
    const recorded = createRecordedIpc()

    expect(Object.keys(createDedicatedPathManagementPreloadApi('data-root-migration', recorded.ipc)).sort())
      .toEqual([
        'cancelDataRootMigration',
        'exitDataRootManagement',
        'getPathManagementState',
        'onDataRootMigrationProgress',
        'openDataRoot',
        'resumeDataRootMigration',
      ])
    expect(Object.keys(createDedicatedPathManagementPreloadApi('data-root-recovery', recorded.ipc)).sort())
      .toEqual([
        'exitDataRootManagement',
        'getPathManagementState',
        'openDataRoot',
        'pickDataRoot',
        'recoverDataRoot',
      ])
  })

  test('Given 迁移进度订阅 When 推送后取消 Then 传递 typed progress 并移除同一 listener', () => {
    const { createMigrationPathManagementPreloadApi } = getExpectedFactories()
    expect(typeof createMigrationPathManagementPreloadApi).toBe('function')
    const recorded = createRecordedIpc()
    const api = createMigrationPathManagementPreloadApi(recorded.ipc)
    const subscribe = api.onDataRootMigrationProgress
    if (typeof subscribe !== 'function') throw new Error('迁移 API 缺少进度订阅')
    /** renderer 实际收到的进度。 */
    const received: DataRootMigrationProgress[] = []
    /** 模拟主进程推送的复制进度。 */
    const progress: DataRootMigrationProgress = {
      migrationId: 'migration-1',
      stage: 'copying',
      completedBytes: 50,
      totalBytes: 100,
    }

    const unsubscribe = subscribe((value: DataRootMigrationProgress) => received.push(value)) as () => void
    recorded.added[0]?.({} as IpcRendererEvent, progress)
    unsubscribe()

    expect(received).toEqual([progress])
    expect(recorded.removed).toEqual(recorded.added)
  })

  test('Given IPC 返回路径状态 When normal 查询 Then 保留同一 typed 对象', async () => {
    /** 主进程返回的路径状态。 */
    const state: PathManagementState = {
      activeRoot: '/data/proma',
      availability: 'available',
      deviceType: 'local',
      migration: null,
    }
    /** 仅状态查询返回对象的 ipcRenderer。 */
    const ipc: PathManagementPreloadIpc = {
      invoke: async () => state,
      on: () => undefined,
      removeListener: () => undefined,
    }
    const { createNormalPathManagementPreloadApi } = getExpectedFactories()
    expect(typeof createNormalPathManagementPreloadApi).toBe('function')
    const api = createNormalPathManagementPreloadApi(ipc)
    const getState = api.getPathManagementState
    if (typeof getState !== 'function') throw new Error('normal API 缺少状态查询')

    expect(await getState()).toBe(state)
  })
})
