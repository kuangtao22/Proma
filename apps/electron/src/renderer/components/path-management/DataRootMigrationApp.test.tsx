import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PathManagementState } from '@proma/shared'
import type { PathManagementPreloadApi } from '../../../preload/path-management-preload'
import * as dataRootMigrationModule from './DataRootMigrationApp'
import {
  createDataRootMigrationViewState,
  DataRootMigrationProgressBar,
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
    expect(view.recoveryActions).toEqual([
      'recheck',
      'relocate',
      'restore-previous',
    ])
    expect(view.canRestorePrevious).toBe(true)
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
    expect(html).not.toContain('重新定位')
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
