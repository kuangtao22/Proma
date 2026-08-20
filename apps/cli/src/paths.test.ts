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
