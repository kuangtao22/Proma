import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DataRootLocatorFile } from '@proma/shared'
import { DataRootLocator } from './data-root-locator'

describe('DataRootLocator', () => {
  /** 每个用例独立使用的临时 home，避免读写真实用户目录。 */
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'proma-data-root-locator-'))
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  test('Given no locator file When inspecting Then the default root is ready without filesystem side effects', () => {
    /** 默认数据根在定位文件缺失时仅被解析，不应被创建。 */
    const defaultRoot = join(homeDir, '.proma')
    /** 待验证的固定定位器实例。 */
    const locator = new DataRootLocator({ homeDir })

    expect(locator.getLocatorPath()).toBe(join(homeDir, '.proma-location.json'))
    expect(locator.inspect()).toMatchObject({
      status: 'ready',
      state: {
        activeRoot: defaultRoot,
        availability: 'missing',
        migration: null,
      },
    })
    expect(existsSync(defaultRoot)).toBe(false)
    expect(existsSync(locator.getLocatorPath())).toBe(false)
  })

  test('Given no locator file When requiring the default root explicitly Then it creates and returns it', () => {
    /** 显式允许创建时应初始化的默认数据根。 */
    const defaultRoot = join(homeDir, '.proma')
    /** 待验证的固定定位器实例。 */
    const locator = new DataRootLocator({ homeDir })

    expect(locator.requireActiveRoot({ createDefault: true })).toBe(defaultRoot)
    expect(existsSync(defaultRoot)).toBe(true)
  })

  test('Given an offline custom root When inspecting or requiring Then it stays missing and is never created', () => {
    /** 模拟当前未挂载的自定义数据根。 */
    const customRoot = join(homeDir, 'offline-volume', 'Proma')
    /** 指向离线自定义根的合法定位文件。 */
    const locatorFile: DataRootLocatorFile = { version: 1, activeRoot: customRoot }
    writeFileSync(join(homeDir, '.proma-location.json'), JSON.stringify(locatorFile), 'utf-8')
    /** 待验证的固定定位器实例。 */
    const locator = new DataRootLocator({ homeDir })

    expect(locator.inspect()).toMatchObject({
      status: 'unavailable',
      state: { activeRoot: customRoot, availability: 'missing' },
    })
    expect(() => locator.requireActiveRoot({ createDefault: true })).toThrow('数据根不可用')
    expect(existsSync(customRoot)).toBe(false)
  })

  test('Given a readable and writable custom root When inspecting Then it is ready', () => {
    /** 模拟已挂载且可访问的自定义数据根。 */
    const customRoot = join(homeDir, 'mounted-volume', 'Proma')
    mkdirSync(customRoot, { recursive: true })
    /** 指向在线自定义根的定位文件。 */
    const locatorFile: DataRootLocatorFile = { version: 1, activeRoot: customRoot }
    writeFileSync(join(homeDir, '.proma-location.json'), JSON.stringify(locatorFile), 'utf-8')

    expect(new DataRootLocator({ homeDir }).inspect()).toMatchObject({
      status: 'ready',
      state: { activeRoot: customRoot, availability: 'available' },
    })
  })

  test('Given a damaged primary locator and valid backup When inspecting Then it recovers from backup', () => {
    /** 备份中保存的有效自定义数据根。 */
    const customRoot = join(homeDir, 'backup-root')
    mkdirSync(customRoot)
    /** 固定定位文件路径。 */
    const locatorPath = join(homeDir, '.proma-location.json')
    writeFileSync(locatorPath, '{broken', 'utf-8')
    writeFileSync(`${locatorPath}.bak`, JSON.stringify({ version: 1, activeRoot: customRoot }), 'utf-8')

    expect(new DataRootLocator({ homeDir }).inspect()).toMatchObject({
      status: 'ready',
      state: { activeRoot: customRoot, availability: 'available' },
    })
    expect(JSON.parse(readFileSync(locatorPath, 'utf-8'))).toEqual({ version: 1, activeRoot: customRoot })
  })

  test('Given all locator candidates are damaged When inspecting Then it reports invalid without falling back', () => {
    /** 固定定位文件路径。 */
    const locatorPath = join(homeDir, '.proma-location.json')
    writeFileSync(locatorPath, '{broken-primary', 'utf-8')
    writeFileSync(`${locatorPath}.tmp`, '{broken-temp', 'utf-8')
    writeFileSync(`${locatorPath}.bak`, '{broken-backup', 'utf-8')

    expect(new DataRootLocator({ homeDir }).inspect()).toMatchObject({
      status: 'invalid',
      state: { availability: 'invalid' },
    })
  })

  test('Given an active migration When inspecting Then it keeps the source root active and exposes progress', () => {
    /** 迁移期间仍然生效的源数据根。 */
    const sourceRoot = join(homeDir, 'source-root')
    /** 尚未切换为活动根的目标目录。 */
    const targetRoot = join(homeDir, 'target-root')
    mkdirSync(sourceRoot)
    mkdirSync(targetRoot)
    /** 包含可恢复迁移进度的定位文件。 */
    const locatorFile: DataRootLocatorFile = {
      version: 1,
      activeRoot: sourceRoot,
      migration: {
        id: 'migration-1',
        sourceRoot,
        targetRoot,
        stage: 'copying',
        completedBytes: 40,
        totalBytes: 100,
        startedAt: 1000,
        updatedAt: 2000,
      },
    }
    writeFileSync(join(homeDir, '.proma-location.json'), JSON.stringify(locatorFile), 'utf-8')

    expect(new DataRootLocator({ homeDir }).inspect()).toMatchObject({
      status: 'migration',
      state: {
        activeRoot: sourceRoot,
        availability: 'available',
        migration: {
          migrationId: 'migration-1',
          stage: 'copying',
          completedBytes: 40,
          totalBytes: 100,
        },
      },
    })
  })

  test('Given cached state When writing and committing migration Then each atomic update refreshes the cache', () => {
    /** 初始迁移源目录。 */
    const sourceRoot = join(homeDir, 'source-root')
    /** 迁移成功后应切换到的目标目录。 */
    const targetRoot = join(homeDir, 'target-root')
    mkdirSync(sourceRoot)
    mkdirSync(targetRoot)
    /** 待验证缓存刷新的固定定位器实例。 */
    const locator = new DataRootLocator({ homeDir })
    expect(locator.inspect().state.activeRoot).toBe(join(homeDir, '.proma'))

    /** 模拟其他进程在首次解析后直接改写磁盘，当前实例仍应返回缓存。 */
    const externalRoot = join(homeDir, 'external-root')
    mkdirSync(externalRoot)
    writeFileSync(locator.getLocatorPath(), JSON.stringify({ version: 1, activeRoot: externalRoot }), 'utf-8')
    expect(locator.inspect().state.activeRoot).toBe(join(homeDir, '.proma'))

    locator.write({
      version: 1,
      activeRoot: sourceRoot,
      migration: {
        id: 'migration-2',
        sourceRoot,
        targetRoot,
        stage: 'verifying',
        completedBytes: 100,
        totalBytes: 100,
        startedAt: 1000,
        updatedAt: 2000,
      },
    })
    expect(locator.inspect()).toMatchObject({ status: 'migration', state: { activeRoot: sourceRoot } })

    locator.commitMigration()
    expect(locator.inspect()).toMatchObject({
      status: 'ready',
      state: { activeRoot: targetRoot, previousRoot: sourceRoot, migration: null },
    })
    expect(JSON.parse(readFileSync(locator.getLocatorPath(), 'utf-8'))).toEqual({
      version: 1,
      activeRoot: targetRoot,
      previousRoot: sourceRoot,
    })
  })

  test('Given malformed locator fields When inspecting Then it reports invalid', () => {
    /** 覆盖版本、路径与迁移字段校验的无效定位文件。 */
    const invalidFiles: object[] = [
      { version: 2, activeRoot: join(homeDir, 'root') },
      { version: 1, activeRoot: 'relative/root' },
      {
        version: 1,
        activeRoot: join(homeDir, 'root'),
        migration: {
          id: '',
          sourceRoot: join(homeDir, 'source'),
          targetRoot: join(homeDir, 'target'),
          stage: 'copying',
          completedBytes: -1,
          totalBytes: 100,
          startedAt: 1000,
          updatedAt: 2000,
        },
      },
      {
        version: 1,
        activeRoot: join(homeDir, 'active-root'),
        migration: {
          id: 'migration-with-mismatched-source',
          sourceRoot: join(homeDir, 'different-source'),
          targetRoot: join(homeDir, 'target'),
          stage: 'pending',
          completedBytes: 0,
          totalBytes: 100,
          startedAt: 1000,
          updatedAt: 1000,
        },
      },
    ]

    for (const invalidFile of invalidFiles) {
      writeFileSync(join(homeDir, '.proma-location.json'), JSON.stringify(invalidFile), 'utf-8')
      expect(new DataRootLocator({ homeDir }).inspect().status).toBe('invalid')
    }
  })
})
