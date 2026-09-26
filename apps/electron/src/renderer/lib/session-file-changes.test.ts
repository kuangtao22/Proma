import { describe, expect, test } from 'bun:test'
import { getOwnedSessionWatcherPathMatches, getOwnedSessionWatcherPaths } from './session-file-changes'

describe('getOwnedSessionWatcherPathMatches', () => {
  test('Given 工作区级附加目录 When 命中 Then 带出该共享根供归属判定', () => {
    const matches = getOwnedSessionWatcherPathMatches(
      ['/external/workspace-directory/sub/a.ts'],
      {
        sessionExists: true,
        sessionPath: '/workspaces/current-session',
        sessionAttachedDirectories: [],
        sessionAttachedFiles: [],
        workspaceAttachmentsComplete: true,
        workspaceFilesPath: '/workspaces/workspace-files',
        workspaceAttachedDirectories: ['/external/workspace-directory'],
        workspaceAttachedFiles: [],
      },
    )

    expect(matches).toEqual([{ path: '/external/workspace-directory/sub/a.ts', root: '/external/workspace-directory' }])
  })

  test('Given 附加文件命中 When 命中 Then 根取所在目录以支持「证据就是该文件」', () => {
    const matches = getOwnedSessionWatcherPathMatches(
      ['/external/notes/spec.md'],
      {
        sessionExists: true,
        sessionPath: '/workspaces/current-session',
        sessionAttachedDirectories: [],
        sessionAttachedFiles: ['/external/notes/spec.md'],
        workspaceAttachmentsComplete: true,
        workspaceFilesPath: '/workspaces/workspace-files',
        workspaceAttachedDirectories: [],
        workspaceAttachedFiles: [],
      },
    )

    expect(matches).toEqual([{ path: '/external/notes/spec.md', root: '/external/notes' }])
  })

  test('Given 同一路径同时落在会话目录与工作区目录 When 命中 Then 只保留首个命中根', () => {
    const matches = getOwnedSessionWatcherPathMatches(
      ['/workspaces/current-session/workspace-files/a.ts'],
      {
        sessionExists: true,
        sessionPath: '/workspaces/current-session',
        sessionAttachedDirectories: [],
        sessionAttachedFiles: [],
        workspaceAttachmentsComplete: true,
        workspaceFilesPath: '/workspaces/current-session/workspace-files',
        workspaceAttachedDirectories: [],
        workspaceAttachedFiles: [],
      },
    )

    expect(matches).toHaveLength(1)
    expect(matches[0]?.root).toBe('/workspaces/current-session')
  })
})

describe('getOwnedSessionWatcherPaths', () => {
  test('does not attribute paths for a missing session', () => {
    expect(getOwnedSessionWatcherPaths(
      ['/workspaces/current-session/generated/file.txt'],
      {
        sessionExists: false,
        sessionPath: '/workspaces/current-session',
        sessionAttachedDirectories: [],
        sessionAttachedFiles: [],
        workspaceAttachmentsComplete: true,
        workspaceFilesPath: '/workspaces/workspace-files',
        workspaceAttachedDirectories: [],
        workspaceAttachedFiles: [],
      },
    )).toEqual([])
  })

  test('retains session-local paths when workspace attachments are unavailable', () => {
    expect(getOwnedSessionWatcherPaths(
      [
        '/workspaces/current-session/generated/file.txt',
        '/external/session-directory/file.txt',
        '/external/session-file.md',
        '/workspaces/workspace-files/shared.md',
        '/external/workspace-directory/file.txt',
        '/external/workspace-file.md',
      ],
      {
        sessionExists: true,
        sessionPath: '/workspaces/current-session',
        sessionAttachedDirectories: ['/external/session-directory'],
        sessionAttachedFiles: ['/external/session-file.md'],
        workspaceAttachmentsComplete: false,
        workspaceFilesPath: '/workspaces/workspace-files',
        workspaceAttachedDirectories: ['/external/workspace-directory'],
        workspaceAttachedFiles: ['/external/workspace-file.md'],
      },
    )).toEqual([
      '/workspaces/current-session/generated/file.txt',
      '/external/session-directory/file.txt',
      '/external/session-file.md',
    ])
  })

  test('includes complete workspace scope without crossing root boundaries', () => {
    expect(getOwnedSessionWatcherPaths(
      [
        '/workspaces/current-session/generated/file.txt',
        '/workspaces/current-session-copy/file.txt',
        '/workspaces/workspace-files/shared.md',
        '/external/workspace-directory/file.txt',
        '/external/workspace-file.md',
        '/external/unattached.md',
      ],
      {
        sessionExists: true,
        sessionPath: '/workspaces/current-session',
        sessionAttachedDirectories: [],
        sessionAttachedFiles: [],
        workspaceAttachmentsComplete: true,
        workspaceFilesPath: '/workspaces/workspace-files',
        workspaceAttachedDirectories: ['/external/workspace-directory'],
        workspaceAttachedFiles: ['/external/workspace-file.md'],
      },
    )).toEqual([
      '/workspaces/current-session/generated/file.txt',
      '/workspaces/workspace-files/shared.md',
      '/external/workspace-directory/file.txt',
      '/external/workspace-file.md',
    ])
  })

  test('binds the local project root so agent edits inside the user project stay attributable', () => {
    expect(getOwnedSessionWatcherPaths(
      [
        '/Users/me/Project/src/app.ts',
        '/Users/me/Project-copy/src/app.ts',
        '/Users/me/other/app.ts',
      ],
      {
        sessionExists: true,
        sessionPath: '/workspaces/current-session',
        sessionAttachedDirectories: [],
        sessionAttachedFiles: [],
        workspaceAttachmentsComplete: true,
        workspaceFilesPath: '/workspaces/workspace-files',
        workspaceProjectRootPath: '/Users/me/Project',
        workspaceAttachedDirectories: [],
        workspaceAttachedFiles: [],
      },
    )).toEqual(['/Users/me/Project/src/app.ts'])
  })

  test('ignores the project root when workspace scope is unavailable', () => {
    expect(getOwnedSessionWatcherPaths(
      ['/Users/me/Project/src/app.ts'],
      {
        sessionExists: true,
        sessionPath: '/workspaces/current-session',
        sessionAttachedDirectories: [],
        sessionAttachedFiles: [],
        workspaceAttachmentsComplete: false,
        workspaceFilesPath: '/workspaces/workspace-files',
        workspaceProjectRootPath: '/Users/me/Project',
        workspaceAttachedDirectories: [],
        workspaceAttachedFiles: [],
      },
    )).toEqual([])
  })
})
