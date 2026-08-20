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
