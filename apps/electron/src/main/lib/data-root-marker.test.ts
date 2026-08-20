import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataRootLocator } from './data-root-locator'
import {
  DATA_ROOT_IDENTITY_JSON_MAX_BYTES,
  PROMA_DATA_ROOT_MARKER_FILE,
  ensurePromaDataRootMarker,
  inspectPromaDataRootIdentity,
  prepareNormalDataRoot,
} from './data-root-marker'

describe('Proma 数据根 marker', () => {
  /** 每个测试独立的用户 home。 */
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'proma-data-root-marker-'))
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  test('Given 首次正常启动的隐式默认根 When 准备业务数据根 Then 创建目录并原子写入精确 marker', () => {
    const locator = new DataRootLocator({ homeDir })
    const initial = locator.inspect()

    const activeRoot = prepareNormalDataRoot(locator, initial)

    expect(activeRoot).toBe(join(homeDir, '.proma'))
    expect(readMarker(activeRoot)).toEqual({ owner: 'proma', version: 1 })
  })

  test('Given 合法精简 legacy 根 When 首次正常启动 Then 补 marker 且保留原配置', () => {
    /** 自定义 legacy 根只包含一个稳定 Proma 设置。 */
    const activeRoot = join(homeDir, 'legacy-root')
    mkdirSync(activeRoot)
    writeFileSync(join(activeRoot, 'settings.json'), '{"themeMode":"dark"}')
    const locator = new DataRootLocator({ homeDir })
    locator.write({ version: 1, activeRoot })

    expect(prepareNormalDataRoot(locator, locator.inspect())).toBe(activeRoot)
    expect(readMarker(activeRoot)).toEqual({ owner: 'proma', version: 1 })
    expect(readFileSync(join(activeRoot, 'settings.json'), 'utf8')).toBe('{"themeMode":"dark"}')
  })

  test('Given marker-only 根 When 识别和初始化 Then 直接接受且不要求 legacy 文件', () => {
    /** marker-only 根模拟已升级且删去可选业务配置的最小数据根。 */
    const root = join(homeDir, 'marker-only')
    mkdirSync(root)
    writeFileSync(join(root, PROMA_DATA_ROOT_MARKER_FILE), '{"owner":"proma","version":1}')

    expect(inspectPromaDataRootIdentity(root)).toBe('marker')
    expect(() => ensurePromaDataRootMarker(root)).not.toThrow()
  })

  test('Given 自定义 activeRoot 离线 When 准备正常根 Then 拒绝且不尝试创建或写 marker', () => {
    /** locator 指向不存在目录，准备流程必须保持磁盘无副作用。 */
    const activeRoot = join(homeDir, 'offline-root')
    const locator = new DataRootLocator({ homeDir })
    locator.write({ version: 1, activeRoot })

    expect(() => prepareNormalDataRoot(locator, locator.inspect())).toThrow('数据根不可用')
    expect(existsSync(activeRoot)).toBe(false)
  })

  test('Given 超过读取上限的伪 legacy JSON When 识别 Then fail closed 且不写 marker', () => {
    /** 超限文件首部看似合法，但不得整文件同步读入主进程。 */
    const root = join(homeDir, 'oversized-root')
    mkdirSync(root)
    writeFileSync(
      join(root, 'settings.json'),
      `{"themeMode":"dark","padding":"${'x'.repeat(DATA_ROOT_IDENTITY_JSON_MAX_BYTES)}"}`,
    )

    expect(inspectPromaDataRootIdentity(root)).toBeNull()
    expect(() => ensurePromaDataRootMarker(root)).toThrow('不是可识别的 Proma 数据根')
    expect(existsSync(join(root, PROMA_DATA_ROOT_MARKER_FILE))).toBe(false)
  })
})

/** 读取测试根内的 marker JSON。 */
function readMarker(root: string): unknown {
  return JSON.parse(readFileSync(join(root, PROMA_DATA_ROOT_MARKER_FILE), 'utf8')) as unknown
}
