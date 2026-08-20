import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataRootLocator } from './data-root-locator'

/** 提示词构建模块类型，用于动态导入后保持完整类型检查。 */
type AgentPromptBuilderModule = typeof import('./agent-prompt-builder')

/** 被测提示词构建模块，在依赖隔离完成后加载。 */
let agentPromptBuilder: AgentPromptBuilderModule

mock.module('./user-profile-service', () => ({
  getUserProfile: () => ({ userName: '测试用户', avatar: '' }),
}))

mock.module('./settings-service', () => ({
  getSettings: () => ({ gitAttributionEnabled: true }),
}))

mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspaceBySlug: () => undefined,
  getWorkspaceMcpConfig: () => ({ servers: {} }),
}))

/** 当前测试创建的临时目录，测试结束后统一清理。 */
const temporaryDirs: string[] = []

beforeAll(async () => {
  agentPromptBuilder = await import('./agent-prompt-builder')
})

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Given 自定义数据根 When 构建系统提示词 Then 工作区 AGENTS 路径不再指向默认根', () => {
  /** 为定位文件隔离的临时 home 目录。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'proma-prompt-home-'))
  /** 模拟带空格的外部数据根。 */
  const customRoot = mkdtempSync(join(tmpdir(), 'Proma Data-'))
  temporaryDirs.push(homeDir, customRoot)
  writeFileSync(
    join(homeDir, '.proma-location.json'),
    JSON.stringify({ version: 1, activeRoot: customRoot }),
    'utf-8',
  )
  mkdirSync(customRoot, { recursive: true })

  /** 注入独立 locator，避免污染进程默认数据根缓存。 */
  const configRootResolver = new DataRootLocator({ homeDir })
  /** 使用最小上下文构建真实系统提示词。 */
  const prompt = agentPromptBuilder.buildSystemPrompt({
    workspaceSlug: 'proma',
    sessionId: 'session-1',
    permissionMode: 'bypassPermissions',
    configRootResolver,
  })

  expect(prompt).toContain(join(customRoot, 'agent-workspaces', 'proma', 'AGENTS.md'))
  expect(prompt).not.toContain('/Users/test/.proma/agent-workspaces')
})
