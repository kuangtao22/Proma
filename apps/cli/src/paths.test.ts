import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfigDir } from './paths'

/** 当前测试创建的临时 home，测试结束后统一删除。 */
const temporaryHomes: string[] = []

afterEach(() => {
  for (const homeDir of temporaryHomes.splice(0)) {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

/** 创建带有效固定 locator 的 CLI 测试上下文。 */
function createCliPathFixture(): { homeDir: string; activeRoot: string } {
  /** 当前用例独立的 home 目录。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'proma-cli-paths-'))
  /** locator 指向的可用活动根。 */
  const activeRoot = join(homeDir, 'Proma Data')
  temporaryHomes.push(homeDir)
  mkdirSync(activeRoot, { recursive: true })
  writeFileSync(
    join(homeDir, '.proma-location.json'),
    JSON.stringify({ version: 1, activeRoot }),
    'utf-8',
  )
  return { homeDir, activeRoot }
}

test('Given flag、环境变量与 locator 同时存在 When 解析 CLI 配置根 Then flag 优先', () => {
  /** 三个不同来源的路径用于验证优先级。 */
  const { homeDir } = createCliPathFixture()
  const flagRoot = join(homeDir, 'flag-root')
  const envRoot = join(homeDir, 'env-root')

  expect(resolveConfigDir(
    { configDir: flagRoot },
    { homeDir, env: { PROMA_CONFIG_DIR: envRoot } },
  )).toBe(flagRoot)
})

test('Given 环境变量与 locator 同时存在 When 解析 CLI 配置根 Then 环境变量优先', () => {
  /** 有效 locator 与环境覆盖路径。 */
  const { homeDir } = createCliPathFixture()
  const envRoot = join(homeDir, 'env-root')

  expect(resolveConfigDir(
    {},
    { homeDir, env: { PROMA_CONFIG_DIR: envRoot } },
  )).toBe(envRoot)
})

test('Given 相对 config-dir flag When 解析 CLI 配置根 Then 拒绝非绝对路径', () => {
  /** flag 的公开合同要求绝对路径，不能受当前 cwd 隐式影响。 */
  const { homeDir } = createCliPathFixture()

  expect(() => resolveConfigDir(
    { configDir: 'relative/Proma Data' },
    { homeDir, env: {} },
  )).toThrow('--config-dir 必须是绝对路径')
})

test('Given 相对 PROMA_CONFIG_DIR When 解析 CLI 配置根 Then 拒绝非绝对路径', () => {
  /** 环境变量同样不能把会话读取重定向到进程 cwd。 */
  const { homeDir } = createCliPathFixture()

  expect(() => resolveConfigDir(
    {},
    { homeDir, env: { PROMA_CONFIG_DIR: 'relative/Proma Data' } },
  )).toThrow('PROMA_CONFIG_DIR 必须是绝对路径')
})

test('Given 显式配置根为空 When 解析 CLI 配置根 Then 不把空值静默当作缺省', () => {
  /** 来源存在即校验，避免无效输入绕过绝对路径合同。 */
  const { homeDir } = createCliPathFixture()

  expect(() => resolveConfigDir({ configDir: '' }, { homeDir, env: {} }))
    .toThrow('--config-dir 必须是绝对路径')
  expect(() => resolveConfigDir({}, { homeDir, env: { PROMA_CONFIG_DIR: '' } }))
    .toThrow('PROMA_CONFIG_DIR 必须是绝对路径')
})

test('Given POSIX、Win32 drive 与 UNC 绝对路径 When 解析显式配置根 Then 跨平台接受', () => {
  /** 即使测试运行在 POSIX Bun，也必须识别 Windows 调用方传入的绝对路径。 */
  const { homeDir } = createCliPathFixture()
  const absoluteRoots = [
    '/Volumes/Work/Proma Data',
    'D:\\Proma Data',
    '\\\\server\\share\\Proma Data',
  ]

  for (const configDir of absoluteRoots) {
    expect(resolveConfigDir({ configDir }, { homeDir, env: {} })).toBe(configDir)
    expect(resolveConfigDir({}, { homeDir, env: { PROMA_CONFIG_DIR: configDir } })).toBe(configDir)
  }
})

test('Given 未显式覆盖 When 解析 CLI 配置根 Then 读取固定 locator 的自定义根', () => {
  /** 有效 locator 提供的自定义根。 */
  const { homeDir, activeRoot } = createCliPathFixture()

  expect(resolveConfigDir({}, { homeDir, env: {} })).toBe(activeRoot)
})

test('Given locator 指向离线数据根 When 解析 CLI 配置根 Then 报错且不回退默认根', () => {
  /** 当前用例独立的 home 目录。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'proma-cli-offline-'))
  /** 不创建该目录，用于模拟离线数据根。 */
  const offlineRoot = join(homeDir, 'offline-volume', 'Proma Data')
  temporaryHomes.push(homeDir)
  writeFileSync(
    join(homeDir, '.proma-location.json'),
    JSON.stringify({ version: 1, activeRoot: offlineRoot }),
    'utf-8',
  )

  expect(() => resolveConfigDir({}, { homeDir, env: {} })).toThrow('数据根不可用')
})

test('Given 仅存在有效 tmp locator When 解析 CLI 配置根 Then 使用 tmp 的活动根', () => {
  /** 模拟主文件原子替换前仅临时文件落盘的状态。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'proma-cli-tmp-only-'))
  const activeRoot = join(homeDir, 'Proma Data')
  temporaryHomes.push(homeDir)
  mkdirSync(activeRoot, { recursive: true })
  writeFileSync(
    join(homeDir, '.proma-location.json.tmp'),
    JSON.stringify({ version: 1, activeRoot }),
    'utf-8',
  )

  expect(resolveConfigDir({}, { homeDir, env: {} })).toBe(activeRoot)
})

test('Given 主 locator 损坏且 bak 有效 When 解析 CLI 配置根 Then 使用 bak 恢复', () => {
  /** 主文件损坏时应继续检查备份，而不是回退默认根。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'proma-cli-bak-recovery-'))
  const activeRoot = join(homeDir, 'Proma Data')
  temporaryHomes.push(homeDir)
  mkdirSync(activeRoot, { recursive: true })
  writeFileSync(join(homeDir, '.proma-location.json'), '{broken', 'utf-8')
  writeFileSync(
    join(homeDir, '.proma-location.json.bak'),
    JSON.stringify({ version: 1, activeRoot }),
    'utf-8',
  )

  expect(resolveConfigDir({}, { homeDir, env: {} })).toBe(activeRoot)
})

test('Given locator 候选全部损坏 When 解析 CLI 配置根 Then 报定位文件无效', () => {
  /** 三个候选都存在但没有 schema-valid 内容。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'proma-cli-all-invalid-'))
  temporaryHomes.push(homeDir)
  writeFileSync(join(homeDir, '.proma-location.json'), '{broken', 'utf-8')
  writeFileSync(join(homeDir, '.proma-location.json.tmp'), JSON.stringify({ version: 2 }), 'utf-8')
  writeFileSync(join(homeDir, '.proma-location.json.bak'), JSON.stringify({ version: 1, activeRoot: 'relative' }), 'utf-8')

  expect(() => resolveConfigDir({}, { homeDir, env: {} })).toThrow('数据根定位文件无效')
})

test('Given 首个有效候选指向离线根 When 后续备份可用 Then 报不可用且不回退', () => {
  /** locator 顺序代表权威性，首个有效 schema 一旦选中就不再尝试旧备份。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'proma-cli-offline-primary-'))
  const offlineRoot = join(homeDir, 'offline-volume', 'Proma Data')
  const staleBackupRoot = join(homeDir, 'stale-backup-root')
  temporaryHomes.push(homeDir)
  mkdirSync(staleBackupRoot, { recursive: true })
  writeFileSync(
    join(homeDir, '.proma-location.json'),
    JSON.stringify({ version: 1, activeRoot: offlineRoot }),
    'utf-8',
  )
  writeFileSync(
    join(homeDir, '.proma-location.json.bak'),
    JSON.stringify({ version: 1, activeRoot: staleBackupRoot }),
    'utf-8',
  )

  expect(() => resolveConfigDir({}, { homeDir, env: {} })).toThrow('数据根不可用')
})
