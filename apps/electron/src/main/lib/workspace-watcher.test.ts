import { describe, expect, it, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectWatcherRestoreDirectories, shouldNotifyForWatchFilename } from './workspace-watcher-utils'

describe('shouldNotifyForWatchFilename', () => {
  it('refreshes only Git metadata that changes diff state', () => {
    expect(shouldNotifyForWatchFilename('.git/FETCH_HEAD')).toBe(false)
    expect(shouldNotifyForWatchFilename('.git/objects/pack/pack-a.idx')).toBe(false)
    expect(shouldNotifyForWatchFilename('.git/index')).toBe(true)
    expect(shouldNotifyForWatchFilename('.git/HEAD')).toBe(true)
    expect(shouldNotifyForWatchFilename('node_modules/.cache/index')).toBe(false)
    expect(shouldNotifyForWatchFilename('src\\components\\Button.tsx')).toBe(true)
  })

  it('ignores Python, test and build cache directories', () => {
    const noisyPaths = [
      '.venv/lib/python3.12/site-packages/pkg.py',
      'venv/Lib/site-packages/pkg.py',
      '.tox/py312/lib/pkg.py',
      '.nox/tests/lib/pkg.py',
      '__pypackages__/3.12/lib/pkg.py',
      '.pytest_cache/v/cache/lastfailed',
      '.mypy_cache/3.12/pkg.meta.json',
      '.ruff_cache/0.8.0/cache',
      '.hypothesis/examples/example.db',
      '.gradle/caches/modules-2/metadata.bin',
    ]

    for (const path of noisyPaths) {
      expect(shouldNotifyForWatchFilename(path)).toBe(false)
    }
  })

  it('keeps generic coverage and target directories observable', () => {
    expect(shouldNotifyForWatchFilename('coverage/lcov.info')).toBe(true)
    expect(shouldNotifyForWatchFilename('target/debug/generated.rs')).toBe(true)
  })

  it('normalizes Buffer filenames before filtering', () => {
    expect(shouldNotifyForWatchFilename(Buffer.from('.git/index'))).toBe(true)
    expect(shouldNotifyForWatchFilename(Buffer.from('src/file.ts'))).toBe(true)
  })

  it('ignores events without a filename instead of bypassing the noise filter', () => {
    expect(shouldNotifyForWatchFilename(null)).toBe(false)
  })
})

describe('启动恢复监听目录清单', () => {
  test('Given 工作区挂了关联业务目录 When 计算恢复清单 Then 该目录必须被监听', () => {
    const directories = collectWatcherRestoreDirectories({
      sessions: [],
      workspaces: [{
        projectRootPath: '/Users/me/Code/app',
        attachedDirectories: ['/Users/me/Code/business-suite'],
        attachedFiles: [],
      }],
    })

    // 工作区级附加目录此前没有恢复入口，重启后外部业务项目里的改动收不到任何事件。
    expect(directories).toEqual(['/Users/me/Code/app', '/Users/me/Code/business-suite'])
  })

  test('Given 会话级附加目录与附加文件 When 计算恢复清单 Then 目录本身与文件所在目录都监听', () => {
    const directories = collectWatcherRestoreDirectories({
      sessions: [{
        attachedDirectories: ['/Users/me/Code/session-dir'],
        attachedFiles: ['/Users/me/Code/session-dir/notes/a.md'],
      }],
      workspaces: [],
    })

    // 附加文件的父目录与附加目录不是同一个目录，两者都要监听。
    expect(directories).toEqual(['/Users/me/Code/session-dir', '/Users/me/Code/session-dir/notes'])
  })

  test('Given 工作区级附加文件 When 计算恢复清单 Then 监听其所在目录', () => {
    const directories = collectWatcherRestoreDirectories({
      sessions: [],
      workspaces: [{ attachedFiles: ['/Users/me/Code/business-suite/README.md'] }],
    })

    expect(directories).toEqual(['/Users/me/Code/business-suite'])
  })

  test('Given 多个来源指向同一目录 When 计算恢复清单 Then 保持发现顺序且只出现一次', () => {
    const directories = collectWatcherRestoreDirectories({
      sessions: [{ attachedDirectories: ['/Users/me/Code/app', ''] }],
      workspaces: [{
        projectRootPath: '/Users/me/Code/app',
        attachedDirectories: ['/Users/me/Code/app', '/Users/me/Code/other'],
      }],
    })

    expect(directories).toEqual(['/Users/me/Code/app', '/Users/me/Code/other'])
  })
})

describe('启动恢复接线合同', () => {
  test('Given 启动流程 When 检查监听器源码 Then 附加目录恢复早于工作区目录缺失的提前返回', () => {
    /** 实际源码：验证恢复入口存在且没有被挪到提前返回之后。 */
    const source = readFileSync(join(import.meta.dir, 'workspace-watcher.ts'), 'utf8')
    const startIndex = source.indexOf('export function startWorkspaceWatcher(')
    const earlyReturnIndex = source.indexOf('if (!existsSync(watchDir))', startIndex)

    expect(startIndex).toBeGreaterThan(-1)
    expect(earlyReturnIndex).toBeGreaterThan(startIndex)
    expect(source.slice(startIndex, earlyReturnIndex)).toContain('restoreAttachedDirectoryWatchers()')
    // 工作区级附加目录不在工作区索引里，必须从各自工作区配置读取后纳入恢复范围。
    expect(source).toContain('getWorkspaceAttachedDirectories(')
  })
})
