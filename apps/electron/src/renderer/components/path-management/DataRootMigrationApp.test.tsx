import { describe, expect, test } from 'bun:test'
import type { PathManagementState } from '@proma/shared'
import {
  createDataRootMigrationViewState,
  DATA_ROOT_RECOVERY_ACTIONS,
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
    expect(DATA_ROOT_RECOVERY_ACTIONS.map(({ action }) => action)).toEqual([
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
})
