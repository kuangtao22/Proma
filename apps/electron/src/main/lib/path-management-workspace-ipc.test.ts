import { describe, expect, test } from 'bun:test'
import { PATH_MANAGEMENT_IPC_CHANNELS } from '@proma/shared'
import type { WorkspaceRelocationProgress } from '@proma/shared'
import { registerPathManagementIpcHandlers } from './path-management-ipc'

/** 创建 workspace IPC 测试使用的最小 normal coordinator。 */
function createCoordinator() {
  return {
    getStatus: () => ({ activeRoot: '/data/proma', availability: 'available' as const, deviceType: 'local' as const, migration: null }),
    createPlan: async () => ({ migrationId: 'data-1', stage: 'pending' as const, completedBytes: 0, totalBytes: 1 }),
    runPending: async () => undefined,
    resumePending: async () => undefined,
    cancel: async () => undefined,
  }
}

describe('项目路径管理 IPC', () => {
  test('Given 两个窗口与两次选择 When 预检或启动 Then 只接受当前 owner 最新一次 relocation 授权并一次性消费', async () => {
    /** 当前主窗口身份。 */
    const ownerA = { send: () => undefined }
    const ownerB = { send: () => undefined }
    let currentOwner: object = ownerA
    /** 保存注册的 handler。 */
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    /** 记录真正进入 relocator 的调用。 */
    const calls: string[] = []
    let selectedPath = '/projects/first'
    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => currentOwner as { send: (channel: string, progress: never) => void },
      coordinator: createCoordinator(),
      inspectStorageFast: async () => ({ deviceType: 'local', availableBytes: 1, occupiedStatus: 'loading' }),
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedPath] }) },
      createSelectionId: (() => { let id = 0; return () => `selection-${++id}` })(),
      workspaceRelocator: {
        preflight: async (input) => {
          calls.push(`preview:${input.workspaceId}:${input.targetRoot}`)
          return { operationId: 'operation-1', workspaceId: input.workspaceId, workspaceSlug: 'one', sourceRoot: '/projects/old', targetRoot: input.targetRoot, totalBytes: 10, remainingBytes: 10, availableBytes: 20, kind: 'external' }
        },
        run: async (input) => {
          calls.push(`start:${input.workspaceId}:${input.targetRoot}`)
          return { operationId: 'operation-1', workspaceId: input.workspaceId, stage: 'completed', completedBytes: 10, totalBytes: 10 }
        },
        getStatus: () => null,
        cancel: () => false,
      },
      listWorkspacePathStates: () => [],
    })
    const pick = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PICK_WORKSPACE_TARGET)!
    const preview = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_WORKSPACE_RELOCATION)!
    const start = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_WORKSPACE_RELOCATION)!
    const first = await pick({ sender: ownerA }, { workspaceId: 'workspace-1', purpose: 'relocation' }) as object
    selectedPath = '/projects/second'
    const second = await pick({ sender: ownerA }, { workspaceId: 'workspace-1', purpose: 'relocation' }) as object
    expect(preview({ sender: ownerA }, first)).rejects.toThrow('项目目标选择已失效')
    currentOwner = ownerB
    expect(preview({ sender: ownerB }, second)).rejects.toThrow('项目目标选择已失效')
    currentOwner = ownerA
    await preview({ sender: ownerA }, second)
    await start({ sender: ownerA }, second)
    expect(start({ sender: ownerA }, second)).rejects.toThrow('项目目标选择已失效')
    expect(calls).toEqual(['preview:workspace-1:/projects/second', 'start:workspace-1:/projects/second'])
  })

  test('Given 原窗口已销毁 When 使用其未消费 selection Then 授权立即失效', async () => {
    /** 可切换销毁状态的 webContents 替身。 */
    let destroyed = false
    const owner = { send: () => undefined, isDestroyed: () => destroyed }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => owner,
      coordinator: createCoordinator(),
      inspectStorageFast: async () => ({ deviceType: 'local', availableBytes: 1, occupiedStatus: 'loading' }),
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/projects/new'] }) },
      workspaceRelocator: {
        preflight: async () => ({ operationId: 'operation-1', workspaceId: 'workspace-1', workspaceSlug: 'one', sourceRoot: '/projects/old', targetRoot: '/projects/new', totalBytes: 1, remainingBytes: 1, availableBytes: 2, kind: 'external' }),
        run: async () => ({ operationId: 'operation-1', workspaceId: 'workspace-1', stage: 'completed', completedBytes: 1, totalBytes: 1 }),
        getStatus: () => null,
        cancel: () => false,
      },
      listWorkspacePathStates: () => [],
    })
    const selection = await handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PICK_WORKSPACE_TARGET)!(
      { sender: owner },
      { workspaceId: 'workspace-1', purpose: 'relocation' },
    ) as object
    destroyed = true
    expect(handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_WORKSPACE_RELOCATION)!({ sender: owner }, selection))
      .rejects.toThrow('项目目标选择已失效')
  })

  test('Given relocation 与 relink 授权 When 交叉使用 Then scope 隔离且离线重定位不调用复制', async () => {
    const owner = { send: () => undefined }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    /** 记录复制与重定位边界。 */
    let copyCount = 0
    let relinkCount = 0
    registerPathManagementIpcHandlers({
      mode: 'normal',
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined },
      app: { relaunch: () => undefined, quit: () => undefined },
      getExpectedWebContents: () => owner,
      coordinator: createCoordinator(),
      inspectStorageFast: async () => ({ deviceType: 'local', availableBytes: 1, occupiedStatus: 'loading' }),
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/projects/found'] }) },
      workspaceRelocator: {
        preflight: async () => { throw new Error('不应预检复制') },
        run: async () => { copyCount += 1; throw new Error('不应复制') },
        getStatus: () => null,
        cancel: () => false,
      },
      listWorkspacePathStates: () => [],
      relinkWorkspace: () => { relinkCount += 1 },
    })
    const pick = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PICK_WORKSPACE_TARGET)!
    const start = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_WORKSPACE_RELOCATION)!
    const relink = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.RELINK_WORKSPACE)!
    const selection = await pick({ sender: owner }, { workspaceId: 'workspace-offline', purpose: 'relink' }) as object
    expect(start({ sender: owner }, selection)).rejects.toThrow('项目目标选择用途不匹配')
    await relink({ sender: owner }, selection)
    expect(copyCount).toBe(0)
    expect(relinkCount).toBe(1)
  })

  test('Given 迁移已提交 When watcher 切换成功或失败 Then 先释放旧监听并刷新，失败广播可重试错误且不回滚', async () => {
    for (const watcherFails of [false, true]) {
      const events: string[] = []
      const progressEvents: WorkspaceRelocationProgress[] = []
      const owner = { send: (_channel: string, progress: WorkspaceRelocationProgress) => { progressEvents.push(progress) } }
      const handlers = new Map<string, (...args: unknown[]) => unknown>()
      registerPathManagementIpcHandlers({
        mode: 'normal',
        ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined },
        app: { relaunch: () => undefined, quit: () => undefined },
        getExpectedWebContents: () => owner,
        coordinator: createCoordinator(),
        inspectStorageFast: async () => ({ deviceType: 'local', availableBytes: 1, occupiedStatus: 'loading' }),
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/projects/new'] }) },
        workspaceRelocator: {
          preflight: async () => ({ operationId: 'operation-1', workspaceId: 'workspace-1', workspaceSlug: 'one', sourceRoot: '/projects/old', targetRoot: '/projects/new', totalBytes: 1, remainingBytes: 1, availableBytes: 2, kind: 'external' }),
          run: async () => ({ operationId: 'operation-1', workspaceId: 'workspace-1', stage: 'completed', completedBytes: 1, totalBytes: 1 }),
          getStatus: () => null,
          cancel: () => false,
        },
        listWorkspacePathStates: () => [],
        switchWorkspaceWatcher: () => { events.push('watcher'); if (watcherFails) throw new Error('监听失败') },
        refreshWorkspaceRenderer: () => { events.push('refresh') },
      })
      const pick = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PICK_WORKSPACE_TARGET)!
      const preview = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_WORKSPACE_RELOCATION)!
      const start = handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.START_WORKSPACE_RELOCATION)!
      const selection = await pick({ sender: owner }, { workspaceId: 'workspace-1', purpose: 'relocation' }) as object
      await preview({ sender: owner }, selection)
      if (watcherFails) expect(start({ sender: owner }, selection)).rejects.toThrow('项目已迁移，但目录监听切换失败')
      else await start({ sender: owner }, selection)
      expect(events).toEqual(['watcher', 'refresh'])
      if (watcherFails) expect(progressEvents.at(-1)?.error).toContain('可重试')
    }
  })
})
