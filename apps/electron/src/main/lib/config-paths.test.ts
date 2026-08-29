import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAgentCanvasBindingsPath,
  getAgentSessionMessagesPath,
  getAgentWorkspacePath,
  getConfigDir,
  getConfigDirName,
  getConversationMessagesPath,
  resolveAgentSessionWorkspacePath,
} from './config-paths'
import { DataRootLocator } from './data-root-locator'

/** 当前测试创建的临时 home 目录，测试结束后统一清理。 */
const temporaryHomeDirs: string[] = []

afterEach(() => {
  for (const homeDir of temporaryHomeDirs.splice(0)) {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

/** 创建未读取磁盘状态的独立测试 resolver。 */
function createLocator(): { homeDir: string; locator: DataRootLocator } {
  /** 为当前用例隔离的临时 home 目录。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'proma-config-paths-'))
  temporaryHomeDirs.push(homeDir)
  return { homeDir, locator: new DataRootLocator({ homeDir }) }
}

test('Given a development environment When resolving business storage Then it shares the production config directory', () => {
  // 保存调用方环境，避免测试修改影响同进程中的其他用例。
  const originalPromaDev = process.env.PROMA_DEV
  process.env.PROMA_DEV = '1'

  try {
    expect(getConfigDirName()).toBe('.proma')
  } finally {
    if (originalPromaDev === undefined) {
      delete process.env.PROMA_DEV
    } else {
      process.env.PROMA_DEV = originalPromaDev
    }
  }
})

test('Given traversal 消息 ID When 解析 JSONL 路径 Then Agent 与 Conversation 均拒绝越界', () => {
  expect(() => getAgentSessionMessagesPath('../outside')).toThrow('无效的会话 ID')
  expect(() => getConversationMessagesPath('../outside')).toThrow('无效的会话 ID')
})

test('Given the default environment When resolving business storage Then it uses the shared config directory', () => {
  expect(getConfigDirName()).toBe('.proma')
})

test('Given 配置根 When 解析 Agent-画布关联索引 Then 使用根目录下固定 JSON 文件', () => {
  /** 独立配置根用于证明路径不依赖 Electron userData。 */
  const configRoot = join(tmpdir(), 'proma-agent-canvas-bindings')

  expect(getAgentCanvasBindingsPath(configRoot)).toBe(
    join(configRoot, 'agent-canvas-bindings.json'),
  )
})

test('Given traversal 或绝对 sessionId When 解析会话目录 Then 在文件系统访问前拒绝越界', () => {
  for (const sessionId of ['../outside', 'nested/session', 'nested\\session', '/tmp/outside']) {
    expect(() => resolveAgentSessionWorkspacePath('workspace', sessionId)).toThrow('无效的会话 ID')
  }
})

test('Given 自定义数据根 When 解析 Agent 工作区 Then 使用该根且保留空格', () => {
  /** 独立 locator 避免修改进程默认 locator 的缓存。 */
  const { homeDir, locator } = createLocator()
  /** 模拟用户选择的带空格外部数据根。 */
  const customRoot = join(homeDir, 'Volumes', 'Work', 'Proma Data')
  mkdirSync(customRoot, { recursive: true })
  writeFileSync(
    join(homeDir, '.proma-location.json'),
    JSON.stringify({ version: 1, activeRoot: customRoot }),
    'utf-8',
  )

  expect(getAgentWorkspacePath('proma', locator)).toBe(join(customRoot, 'agent-workspaces', 'proma'))
})

test('Given 缺失的默认数据根 When 首次读取配置目录 Then 按需创建并保持进程内结果稳定', () => {
  /** 没有定位文件和默认根的独立 locator。 */
  const { homeDir, locator } = createLocator()
  /** 默认业务数据根在读取前不应存在。 */
  const defaultRoot = join(homeDir, '.proma')

  expect(existsSync(defaultRoot)).toBe(false)
  expect(getConfigDir(locator)).toBe(defaultRoot)
  expect(existsSync(defaultRoot)).toBe(true)

  /** 后写入的定位文件不应让已缓存进程根热切换。 */
  const laterRoot = join(homeDir, 'later-root')
  mkdirSync(laterRoot, { recursive: true })
  writeFileSync(
    join(homeDir, '.proma-location.json'),
    JSON.stringify({ version: 1, activeRoot: laterRoot }),
    'utf-8',
  )

  expect(getConfigDir(locator)).toBe(defaultRoot)
})
