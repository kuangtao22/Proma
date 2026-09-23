import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PathManagementState } from '@proma/shared'
import type { PathManagementPreloadApi } from '../../../preload/path-management-preload'
import * as dataRootMigrationModule from './DataRootMigrationApp'
import {
  cancelRecoveryDataRootSelection,
  createRelocateRecoveryInput,
  createDataRootMigrationViewState,
  replaceRecoveryDataRootSelection,
  DataRootInitialLoadError,
  DataRootMigrationProgressBar,
  DataRootRecoverySelectionPanel,
  DataRootRecoveryControls,
  confirmRestorePreviousDataRoot,
} from './DataRootMigrationApp'

/** 创建恢复页测试使用的最小路径状态。 */
function createState(overrides: Partial<PathManagementState> = {}): PathManagementState {
  return {
    activeRoot: '/data/proma',
    availability: 'available',
    deviceType: 'unknown',
    migration: null,
    ...overrides,
  }
}

describe('DataRootMigrationApp', () => {
  test('Given recovery API 不含进度订阅 When 页面初始化 Then 安全返回 no-op 取消函数', () => {
    /** 目标模块在 RED 阶段可能尚未导出安全订阅 helper。 */
    const subscribe = (dataRootMigrationModule as unknown as {
      subscribeToDataRootMigrationProgress?: (
        api: PathManagementPreloadApi,
        callback: () => void,
      ) => () => void
    }).subscribeToDataRootMigrationProgress
    expect(typeof subscribe).toBe('function')
    /** 真实 recovery API 形状不包含迁移进度 key。 */
    const recoveryApi: PathManagementPreloadApi = {
      getPathManagementState: async () => createState(),
      pickDataRoot: async () => null,
      recoverDataRoot: async () => undefined,
      openDataRoot: async () => undefined,
      exitDataRootManagement: async () => undefined,
    }

    expect(() => subscribe?.(recoveryApi, () => undefined)()).not.toThrow()
  })

  test('Given 已有恢复候选 When 重新打开选择器 Then 先清空失效授权再保存新选择', async () => {
    /** 记录候选状态变化，确保选择器异常时也不会遗留已撤销授权。 */
    const selections: Array<string | null> = ['old-selection']
    /** 记录空目录确认是否同步重置。 */
    const confirmations: boolean[] = [true]

    await replaceRecoveryDataRootSelection(
      async () => ({
        selectionId: 'new-selection',
        targetRoot: '/data/new',
        kind: 'existing',
      }),
      (selection) => selections.push(selection?.selectionId ?? null),
      (confirmed) => confirmations.push(confirmed),
    )

    expect(selections).toEqual(['old-selection', null, 'new-selection'])
    expect(confirmations).toEqual([true, false])
  })

  test('Given 待确认选择 When 后台撤销成功 Then 回传 selectionId 后才清理界面草稿', async () => {
    /** 记录恢复 IPC 与草稿清理的先后顺序。 */
    const events: string[] = []
    const selection = {
      selectionId: 'selection-cancel',
      targetRoot: '/data/cancel',
      kind: 'empty' as const,
    }

    await cancelRecoveryDataRootSelection(
      selection,
      async (input) => { events.push(`recover:${input.action}:${input.selectionId}`) },
      () => { events.push('clear') },
    )

    expect(events).toEqual(['recover:cancel-selection:selection-cancel', 'clear'])
  })

  test('Given 待确认选择 When 后台撤销失败 Then 保留草稿并向界面传播错误', async () => {
    /** 后端拒绝时不得误报已取消。 */
    let cleared = false
    const failure = new Error('选择授权撤销失败')

    await expect(cancelRecoveryDataRootSelection(
      {
        selectionId: 'selection-still-active',
        targetRoot: '/data/pending',
        kind: 'existing',
      },
      async () => { throw failure },
      () => { cleared = true },
    )).rejects.toBe(failure)
    expect(cleared).toBe(false)
  })

  test('Given 首次状态读取失败 When 渲染恢复窗口 Then 显示错误并保留重试与退出', () => {
    const html = renderToStaticMarkup(
      <DataRootInitialLoadError
        message="无法读取应用数据目录状态"
        isBusy={false}
        onRetry={() => undefined}
        onExit={() => undefined}
      />,
    )

    expect(html).toContain('无法读取应用数据目录状态')
    expect(html).toContain('重新检测')
    expect(html).toContain('退出')
    expect(html).not.toContain('正在读取数据根状态')
  })

  test('Given copying/verifying/rebasing 进度 When 生成视图 Then 显示复制/校验/重写阶段与稳定百分比', () => {
    expect(createDataRootMigrationViewState(createState({
      migration: {
        migrationId: 'migration-1',
        stage: 'copying',
        completedBytes: 25,
        totalBytes: 100,
      },
    }), 'data-root-migration')).toMatchObject({ stageLabel: '正在复制数据', percent: 25 })

    expect(createDataRootMigrationViewState(createState({
      migration: {
        migrationId: 'migration-1',
        stage: 'verifying',
        completedBytes: 100,
        totalBytes: 100,
      },
    }), 'data-root-migration').stageLabel).toBe('正在校验数据')

    expect(createDataRootMigrationViewState(createState({
      migration: {
        migrationId: 'migration-1',
        stage: 'rebasing',
        completedBytes: 100,
        totalBytes: 100,
      },
    }), 'data-root-migration').stageLabel).toBe('正在重写内部路径')
  })

  test('Given 数据根离线 When 生成视图 Then 提供重新检测、重新定位和切回旧备份', () => {
    const view = createDataRootMigrationViewState(createState({
      availability: 'unavailable',
      previousRoot: '/data/proma-backup',
    }), 'data-root-recovery')

    expect(view.kind).toBe('recovery')
    expect(view.stageLabel).toBe('应用数据目录需要处理')
    expect(view.recoveryActions).toEqual([
      'recheck',
      'relocate',
      'restore-previous',
    ])
    expect(view.canRestorePrevious).toBe(true)
  })

  test('Given 启动故障包含实际路径与原因 When 生成恢复视图 Then 不展示内部堆栈', () => {
    const state = createState({
      availability: 'unavailable',
      startupIssue: {
        path: 'C:\\Users\\alice\\.proma\\server-ops',
        code: 'not-directory',
        message: '该位置不是可安全使用的目录',
      },
    })
    const view = createDataRootMigrationViewState(state, 'data-root-recovery')

    expect(view.issue).toEqual(state.startupIssue)
    expect(view.issue?.message).not.toContain('at resolveTransactionDirectory')
  })

  test('Given 选择已有数据目录 When 渲染确认区 Then 说明不会迁移并允许确认', () => {
    const html = renderToStaticMarkup(
      <DataRootRecoverySelectionPanel
        selection={{
          selectionId: 'selection-existing',
          targetRoot: '/data/existing',
          kind: 'existing',
        }}
        initializeEmpty={false}
        isBusy={false}
        onInitializeEmptyChange={() => undefined}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    )

    expect(html).toContain('/data/existing')
    expect(html).toContain('使用该目录中的已有数据')
    expect(html).toContain('这不是迁移')
    expect(html).toContain('原位置会保留')
    expect(html).not.toContain('disabled=""')
  })

  test('Given 选择空目录 When 尚未明确确认 Then 提示旧数据不迁移且禁止启用', () => {
    const html = renderToStaticMarkup(
      <DataRootRecoverySelectionPanel
        selection={{
          selectionId: 'selection-empty',
          targetRoot: '/data/empty',
          kind: 'empty',
        }}
        initializeEmpty={false}
        isBusy={false}
        onInitializeEmptyChange={() => undefined}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    )

    expect(html).toContain('启用全新数据区')
    expect(html).toContain('旧聊天和配置不会自动迁移')
    expect(html).toContain('原数据仍会保留')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('disabled=""')
  })

  test('Given 主进程签发空目录选择 When 用户明确确认 Then 生成受授权的恢复请求', () => {
    const selection = {
      selectionId: 'selection-empty',
      targetRoot: '/data/empty',
      kind: 'empty' as const,
    }

    expect(createRelocateRecoveryInput(selection, false)).toBeNull()
    expect(createRelocateRecoveryInput(selection, true)).toEqual({
      action: 'relocate',
      selectedRoot: '/data/empty',
      selectionId: 'selection-empty',
      initializeEmpty: true,
    })
  })

  test('Given 主进程签发已有目录选择 When 用户确认 Then 保留授权且不初始化空目录', () => {
    expect(createRelocateRecoveryInput({
      selectionId: 'selection-existing',
      targetRoot: '/data/existing',
      kind: 'existing',
    }, false)).toEqual({
      action: 'relocate',
      selectedRoot: '/data/existing',
      selectionId: 'selection-existing',
    })
  })

  test('Given 迁移已提交但 cleanup 待重试 When 生成视图 Then 不误显示为无迁移', () => {
    const view = createDataRootMigrationViewState(createState({
      migration: null,
      postCommitCleanup: {
        migrationId: 'migration-1',
        targetRoot: '/data/proma',
        status: 'failed',
        error: '清理 sidecar 失败',
      },
    }), 'data-root-migration')

    expect(view.kind).toBe('cleanup')
    expect(view.error).toBe('清理 sidecar 失败')
  })

  test('Given recovery 模式且 cleanup 未解决 When 生成视图 Then 保留重新检测入口并展示 cleanup 错误', () => {
    const view = createDataRootMigrationViewState(createState({
      availability: 'unavailable',
      postCommitCleanup: {
        migrationId: 'migration-1',
        targetRoot: '/data/proma',
        status: 'failed',
        error: '目标盘离线，清理尚未完成',
      },
    }), 'data-root-recovery')

    expect(view.kind).toBe('recovery')
    expect(view.error).toBe('目标盘离线，清理尚未完成')
    expect(view.recoveryActions).toEqual(['recheck'])
  })

  test('Given recovery 模式且 cleanup 未解决 When 渲染按钮 Then 只显示重新检测与退出', () => {
    const view = createDataRootMigrationViewState(createState({
      availability: 'unavailable',
      previousRoot: '/data/proma-backup',
      postCommitCleanup: {
        migrationId: 'migration-1',
        targetRoot: '/data/proma',
        status: 'failed',
        error: '目标盘离线',
      },
    }), 'data-root-recovery')
    /** 静态按钮测试不执行事件，只校验实际可见操作。 */
    const noop = (): void => undefined
    const html = renderToStaticMarkup(
      <DataRootRecoveryControls
        view={view}
        isBusy={false}
        onRecheck={noop}
        onRelocate={noop}
        onRestorePrevious={noop}
        onExit={noop}
      />,
    )

    expect(html).toContain('重新检测')
    expect(html).toContain('退出')
    expect(html).not.toContain('选择应用数据目录')
    expect(html).not.toContain('切回旧备份')
  })

  test('Given 迁移进度 When 渲染页面 Then 暴露标准 progressbar 数值语义', () => {
    /** 无状态组件直接锁定最终输出的无障碍数值属性。 */
    const html = renderToStaticMarkup(<DataRootMigrationProgressBar percent={25} />)

    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuemin="0"')
    expect(html).toContain('aria-valuemax="100"')
    expect(html).toContain('aria-valuenow="25"')
  })

  test('Given 用户切回旧根 When 尚未确认 Then 不调用恢复 API', async () => {
    /** 记录是否错误执行不可逆的 locator 切换。 */
    let recovered = false
    await confirmRestorePreviousDataRoot(
      () => false,
      async () => { recovered = true },
    )
    expect(recovered).toBe(false)
  })

  test('Given 用户切回旧根 When 明确确认 Then 调用一次恢复 API', async () => {
    /** 记录确认后恢复 API 的调用次数。 */
    let recoverCount = 0
    await confirmRestorePreviousDataRoot(
      () => true,
      async () => { recoverCount += 1 },
    )
    expect(recoverCount).toBe(1)
  })
})
