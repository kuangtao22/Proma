import { describe, expect, test } from 'bun:test'
import { PATH_MANAGEMENT_IPC_CHANNELS, isDataRootLocatorFile } from './path-management'

describe('isDataRootLocatorFile', () => {
  const sourceRoot = '/Users/test/.proma'
  const targetRoot = '/Volumes/Data/Proma'

  test('Given valid migration or cleanup locator When validating Then accepts complete portable paths', () => {
    expect(isDataRootLocatorFile({
      version: 1,
      activeRoot: sourceRoot,
      migration: {
        id: 'migration-1',
        sourceRoot,
        targetRoot,
        stage: 'copying',
        completedBytes: 1,
        totalBytes: 2,
        startedAt: 1,
        updatedAt: 2,
      },
    })).toBe(true)
    expect(isDataRootLocatorFile({
      version: 1,
      activeRoot: targetRoot,
      previousRoot: sourceRoot,
      postCommitCleanup: { migrationId: 'migration-1', targetRoot },
    })).toBe(true)
    expect(isDataRootLocatorFile({
      version: 1,
      activeRoot: targetRoot,
      previousRoot: sourceRoot,
      postCommitCleanup: { migrationId: 'migration-1', targetRoot, error: '清理迁移断点失败' },
    })).toBe(true)
  })

  test('Given cleanup incomplete、mismatch or coexisting migration When validating Then rejects', () => {
    const invalidValues = [
      { version: 1, activeRoot: targetRoot, postCommitCleanup: { migrationId: '', targetRoot } },
      { version: 1, activeRoot: targetRoot, postCommitCleanup: { migrationId: 'migration-1', targetRoot: 'relative' } },
      { version: 1, activeRoot: targetRoot, postCommitCleanup: { migrationId: 'migration-1', targetRoot: sourceRoot } },
      { version: 1, activeRoot: targetRoot, postCommitCleanup: { migrationId: 'migration-1', targetRoot, error: '' } },
      {
        version: 1,
        activeRoot: sourceRoot,
        migration: {
          id: 'migration-1', sourceRoot, targetRoot, stage: 'copying', completedBytes: 0,
          totalBytes: 1, startedAt: 1, updatedAt: 1,
        },
        postCommitCleanup: { migrationId: 'migration-1', targetRoot: sourceRoot },
      },
    ]
    for (const value of invalidValues) expect(isDataRootLocatorFile(value)).toBe(false)
  })

  test('Given POSIX、drive or UNC paths When validating Then remains browser-safe and cross-platform', () => {
    for (const activeRoot of ['/Users/test/.proma', 'D:\\Proma', '\\\\server\\share\\Proma']) {
      expect(isDataRootLocatorFile({ version: 1, activeRoot })).toBe(true)
    }
    expect(isDataRootLocatorFile({ version: 1, activeRoot: 'relative/root' })).toBe(false)
  })
})

describe('workspace path management contract', () => {
  test('Given 项目路径管理四层合同 When 读取通道 Then 包含选择、预检、执行、取消、重定位与进度', () => {
    expect(PATH_MANAGEMENT_IPC_CHANNELS).toMatchObject({
      PICK_WORKSPACE_TARGET: 'path-management:pick-workspace-target',
      PREVIEW_WORKSPACE_RELOCATION: 'path-management:preview-workspace-relocation',
      START_WORKSPACE_RELOCATION: 'path-management:start-workspace-relocation',
      GET_WORKSPACE_RELOCATION_STATUS: 'path-management:get-workspace-relocation-status',
      CANCEL_WORKSPACE_RELOCATION: 'path-management:cancel-workspace-relocation',
      RELINK_WORKSPACE: 'path-management:relink-workspace',
      WORKSPACE_RELOCATION_PROGRESS: 'path-management:workspace-relocation-progress',
    })
  })
})
