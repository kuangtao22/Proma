import { describe, expect, test } from 'bun:test'
import { isDataRootLocatorFile } from './path-management'

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
  })

  test('Given cleanup incomplete、mismatch or coexisting migration When validating Then rejects', () => {
    const invalidValues = [
      { version: 1, activeRoot: targetRoot, postCommitCleanup: { migrationId: '', targetRoot } },
      { version: 1, activeRoot: targetRoot, postCommitCleanup: { migrationId: 'migration-1', targetRoot: 'relative' } },
      { version: 1, activeRoot: targetRoot, postCommitCleanup: { migrationId: 'migration-1', targetRoot: sourceRoot } },
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
