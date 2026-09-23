import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataRootLocator } from './data-root-locator'
import { PROMA_DATA_ROOT_MARKER_FILE } from './data-root-marker'
import {
  inspectDataRootDirectories,
  inspectDataRootStartup,
} from './data-root-startup-check'

describe('数据根启动目录检查', () => {
  /** 每个场景使用独立 home，避免读写真实用户数据。 */
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'proma-data-root-startup-'))
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  test('Given 首次启动默认数据根缺失 When 执行启动初始化 Then 创建根、marker 与 server-ops', () => {
    const locator = new DataRootLocator({ homeDir })

    const result = inspectDataRootStartup(locator, true)

    const root = join(homeDir, '.proma')
    expect(result.status).toBe('ready')
    expect(result.state.startupIssue).toBeUndefined()
    expect(readFileSync(join(root, PROMA_DATA_ROOT_MARKER_FILE), 'utf8')).toContain('"owner": "proma"')
    expect(existsSync(join(root, 'server-ops'))).toBe(true)
  })

  test('Given 默认数据根与 server-ops 均缺失 When 只读检查 Then 不创建任何目录', () => {
    const locator = new DataRootLocator({ homeDir })

    const result = inspectDataRootStartup(locator)

    expect(result.status).toBe('ready')
    expect(result.state.availability).toBe('missing')
    expect(result.state.startupIssue).toBeUndefined()
    expect(existsSync(join(homeDir, '.proma'))).toBe(false)
  })

  test('Given 已有合法数据根但缺失 server-ops When 只读检查 Then 允许展示且不提前补目录', () => {
    const root = join(homeDir, '.proma')
    mkdirSync(root)
    writeFileSync(join(root, PROMA_DATA_ROOT_MARKER_FILE), '{"owner":"proma","version":1}')
    const locator = new DataRootLocator({ homeDir })

    const result = inspectDataRootStartup(locator)

    expect(result.status).toBe('ready')
    expect(result.state.startupIssue).toBeUndefined()
    expect(existsSync(join(root, 'server-ops'))).toBe(false)
  })

  test('Given server-ops 被同名文件占用 When 启动检查 Then 进入恢复且不覆盖用户文件', () => {
    const root = join(homeDir, '.proma')
    const serverOpsPath = join(root, 'server-ops')
    mkdirSync(root)
    writeFileSync(join(root, PROMA_DATA_ROOT_MARKER_FILE), '{"owner":"proma","version":1}')
    writeFileSync(serverOpsPath, 'user-content')
    const locator = new DataRootLocator({ homeDir })

    const result = inspectDataRootStartup(locator, true)

    expect(result.status).toBe('unavailable')
    expect(result.state.startupIssue).toEqual({
      path: serverOpsPath,
      code: 'not-directory',
      message: 'Server Ops 配置路径被同名文件占用',
    })
    expect(readFileSync(serverOpsPath, 'utf8')).toBe('user-content')
  })

  test('Given server-ops 是符号链接 When 启动检查 Then 进入恢复且不跟随链接', () => {
    const root = join(homeDir, '.proma')
    const outside = join(homeDir, 'outside')
    const serverOpsPath = join(root, 'server-ops')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(root, PROMA_DATA_ROOT_MARKER_FILE), '{"owner":"proma","version":1}')
    symlinkSync(outside, serverOpsPath, process.platform === 'win32' ? 'junction' : 'dir')
    const locator = new DataRootLocator({ homeDir })

    const result = inspectDataRootStartup(locator, true)

    expect(result.status).toBe('unavailable')
    expect(result.state.startupIssue).toEqual({
      path: serverOpsPath,
      code: 'symlink',
      message: 'Server Ops 配置目录不能是符号链接或目录联接',
    })
    expect(existsSync(join(outside, PROMA_DATA_ROOT_MARKER_FILE))).toBe(false)
  })

  test('Given 自定义数据根离线 When 启动初始化 Then 保持恢复状态且不创建目录', () => {
    const root = join(homeDir, 'offline-custom-root')
    const locator = new DataRootLocator({ homeDir })
    locator.write({ version: 1, activeRoot: root })

    const result = inspectDataRootStartup(locator, true)

    expect(result.status).toBe('unavailable')
    expect(result.state.availability).toBe('missing')
    expect(result.state.startupIssue).toEqual({
      path: root,
      code: 'missing',
      message: '应用数据目录不存在',
    })
    expect(existsSync(root)).toBe(false)
  })

  test('Given 迁移记录存在且源根异常 When 启动初始化 Then 迁移模式保持最高优先级', () => {
    const sourceRoot = join(homeDir, 'source-root')
    const targetRoot = join(homeDir, 'target-root')
    mkdirSync(sourceRoot)
    mkdirSync(targetRoot)
    const locator = new DataRootLocator({ homeDir })
    locator.write({
      version: 1,
      activeRoot: sourceRoot,
      migration: {
        id: 'migration-1',
        sourceRoot,
        targetRoot,
        stage: 'pending',
        completedBytes: 0,
        totalBytes: 0,
        startedAt: 1,
        updatedAt: 1,
      },
    })
    writeFileSync(join(sourceRoot, 'server-ops'), 'occupied')

    const result = inspectDataRootStartup(locator, true)

    expect(result.status).toBe('migration')
    expect(result.state.startupIssue).toBeUndefined()
    expect(readFileSync(join(sourceRoot, 'server-ops'), 'utf8')).toBe('occupied')
  })

  test.skipIf(process.platform === 'win32')('Given 数据根没有读写进入权限 When 检查目录 Then 返回权限问题且不 chmod', () => {
    const root = join(homeDir, 'permission-root')
    mkdirSync(root)
    chmodSync(root, 0o000)

    try {
      const issue = inspectDataRootDirectories(root)
      expect(issue).toEqual({ path: root, code: 'permission', message: '应用数据目录当前不可读写' })
    } finally {
      chmodSync(root, 0o700)
    }
  })
})
