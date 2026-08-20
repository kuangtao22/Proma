import { describe, expect, test } from 'bun:test'
import { PATH_MANAGEMENT_IPC_CHANNELS } from '@proma/shared'
import type { DataRootMigrationProgress, PathManagementState } from '@proma/shared'
import type { IpcRendererEvent } from 'electron'
import {
  createPathManagementPreloadApi,
  type PathManagementPreloadIpc,
} from './path-management-preload'

/** 测试记录的 renderer listener。 */
type RecordedListener = (event: IpcRendererEvent, ...args: unknown[]) => void

describe('路径管理 preload API', () => {
  test('Given typed API When 调用全部路径动作 Then 使用共享通道与原始参数', async () => {
    /** 保存全部 invoke 调用。 */
    const invokes: Array<{ channel: string; args: unknown[] }> = []
    /** 测试使用的最小 ipcRenderer。 */
    const ipc: PathManagementPreloadIpc = {
      invoke: async (channel, ...args) => {
        invokes.push({ channel, args })
        return undefined
      },
      on: () => undefined,
      removeListener: () => undefined,
    }
    /** 被测路径 preload API。 */
    const api = createPathManagementPreloadApi(ipc)

    await api.getPathManagementState()
    await api.pickDataRoot()
    await api.resumeDataRootMigration()
    await api.cancelDataRootMigration()
    await api.recoverDataRoot({ action: 'relocate', selectedRoot: '/data/found' })
    await api.openDataRoot()
    await api.exitDataRootManagement()

    expect(invokes).toEqual([
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE, args: [] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT, args: [] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.RESUME_DATA_ROOT_MIGRATION, args: [] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.CANCEL_DATA_ROOT_MIGRATION, args: [] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT, args: [{ action: 'relocate', selectedRoot: '/data/found' }] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT, args: [] },
      { channel: PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP, args: [] },
    ])
  })

  test('Given 迁移进度订阅 When 推送后取消 Then 传递 typed progress 并移除同一 listener', () => {
    /** 保存注册的 listener。 */
    const added: RecordedListener[] = []
    /** 保存移除的 listener。 */
    const removed: RecordedListener[] = []
    /** 测试使用的最小 ipcRenderer。 */
    const ipc: PathManagementPreloadIpc = {
      invoke: async () => undefined,
      on: (_channel, listener) => { added.push(listener) },
      removeListener: (_channel, listener) => { removed.push(listener) },
    }
    /** 被测路径 preload API。 */
    const api = createPathManagementPreloadApi(ipc)
    /** renderer 实际收到的进度。 */
    const received: DataRootMigrationProgress[] = []
    /** 模拟主进程推送的复制进度。 */
    const progress: DataRootMigrationProgress = {
      migrationId: 'migration-1',
      stage: 'copying',
      completedBytes: 50,
      totalBytes: 100,
    }

    const unsubscribe = api.onDataRootMigrationProgress((value) => received.push(value))
    added[0]?.({} as IpcRendererEvent, progress)
    unsubscribe()

    expect(received).toEqual([progress])
    expect(removed).toEqual(added)
  })

  test('Given IPC 返回路径状态 When 查询 Then 保留同一 typed 对象', async () => {
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

    expect(await createPathManagementPreloadApi(ipc).getPathManagementState()).toBe(state)
  })
})
