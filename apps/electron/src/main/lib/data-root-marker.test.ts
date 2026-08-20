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
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

  test('Given 无 locator 且默认根只有 default-skills 目录 When 正常启动 Then 按受控默认根补 marker', () => {
    /** 历史默认根可能只完成默认 Skill 初始化，没有可作为 legacy 身份的 JSON。 */
    const activeRoot = join(homeDir, '.proma')
    mkdirSync(join(activeRoot, 'default-skills'), { recursive: true })
    const locator = new DataRootLocator({ homeDir })

    expect(prepareNormalDataRoot(locator, locator.inspect())).toBe(activeRoot)
    expect(readMarker(activeRoot)).toEqual({ owner: 'proma', version: 1 })
  })

  test('Given 无 locator 且默认根只有 agent-sessions 目录 When 正常启动 Then 按受控默认根补 marker', () => {
    /** 历史会话目录本身足以说明默认路径已被应用使用，但不放宽 custom 根。 */
    const activeRoot = join(homeDir, '.proma')
    mkdirSync(join(activeRoot, 'agent-sessions'), { recursive: true })
    const locator = new DataRootLocator({ homeDir })

    expect(prepareNormalDataRoot(locator, locator.inspect())).toBe(activeRoot)
    expect(readMarker(activeRoot)).toEqual({ owner: 'proma', version: 1 })
  })

  test('Given custom 根只有 default-skills 目录 When 正常启动 Then 仍拒绝补 marker', () => {
    /** 同名业务目录不能替代 custom 根的显式 marker 或 legacy 文件证据。 */
    const activeRoot = join(homeDir, 'custom-root')
    mkdirSync(join(activeRoot, 'default-skills'), { recursive: true })
    const locator = new DataRootLocator({ homeDir })
    locator.write({ version: 1, activeRoot })

    expect(() => prepareNormalDataRoot(locator, locator.inspect())).toThrow('不是可识别的 Proma 数据根')
    expect(existsSync(join(activeRoot, PROMA_DATA_ROOT_MARKER_FILE))).toBe(false)
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

  test('Given legacy 文件是 symlink When 识别 Then 不跟随且仍可检查后续合法 evidence', () => {
    /** 根外 settings 内容即使合法也不能证明候选目录所有权。 */
    const root = join(homeDir, 'symlink-root')
    const outsideSettings = join(homeDir, 'outside-settings.json')
    mkdirSync(root)
    writeFileSync(outsideSettings, '{"themeMode":"dark"}')
    symlinkSync(outsideSettings, join(root, 'settings.json'))

    expect(inspectPromaDataRootIdentity(root)).toBeNull()

    writeFileSync(join(root, 'channels.json'), '{"channels":[]}')
    expect(inspectPromaDataRootIdentity(root)).toBe('legacy')
  })

  test('Given 首个 legacy 文件不可读 When 后续 evidence 合法 Then fail closed 并继续识别', () => {
    if (process.platform === 'win32') return
    /** 不可读 settings 不应把整个身份扫描变成未捕获的 EACCES。 */
    const root = join(homeDir, 'unreadable-root')
    const settingsPath = join(root, 'settings.json')
    mkdirSync(root)
    writeFileSync(settingsPath, '{"themeMode":"dark"}')
    chmodSync(settingsPath, 0o000)
    writeFileSync(join(root, 'channels.json'), '{"channels":[]}')

    expect(inspectPromaDataRootIdentity(root)).toBe('legacy')
  })

  test('Given 首个 legacy 文件是 FIFO When 后续 evidence 合法 Then 不阻塞并继续识别', () => {
    if (process.platform === 'win32') return
    /** FIFO 必须在 open 前被 lstat 拒绝，子进程超时用于防止回归挂死测试。 */
    const root = join(homeDir, 'fifo-root')
    mkdirSync(root)
    const created = Bun.spawnSync(['mkfifo', join(root, 'settings.json')])
    if (created.exitCode !== 0) return
    writeFileSync(join(root, 'channels.json'), '{"channels":[]}')
    /** 子进程脚本加载真实模块并输出身份结果。 */
    const script = [
      `import { inspectPromaDataRootIdentity } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'data-root-marker.ts')).href)}`,
      `process.stdout.write(String(inspectPromaDataRootIdentity(${JSON.stringify(root)})))`,
    ].join(';')
    /** 两秒内未返回表示实现错误打开并阻塞在 FIFO。 */
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 2_000 })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('legacy')
  })
})

/** 读取测试根内的 marker JSON。 */
function readMarker(root: string): unknown {
  return JSON.parse(readFileSync(join(root, PROMA_DATA_ROOT_MARKER_FILE), 'utf8')) as unknown
}
