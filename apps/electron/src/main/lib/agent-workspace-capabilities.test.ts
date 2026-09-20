import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 本测试独占的工作区根，避免读写用户真实的 ~/.proma。 */
const testRoot = mkdtempSync(join(tmpdir(), 'proma-workspace-capabilities-'))

mock.module('./config-paths', () => ({
  getAgentWorkspacesIndexPath: () => join(testRoot, 'agent-workspaces.json'),
  getAgentWorkspacesDir: () => testRoot,
  getAgentWorkspacePath: (slug: string) => join(testRoot, slug),
  getWorkspaceMcpPath: (slug: string) => join(testRoot, slug, 'mcp.json'),
  getWorkspaceSkillsDir: (slug: string) => join(testRoot, slug, 'skills'),
  getWorkspaceFilesDir: (slug: string) => join(testRoot, slug, 'workspace-files'),
  getInactiveSkillsDir: (slug: string) => join(testRoot, slug, 'skills-inactive'),
  getDefaultSkillsDir: () => join(testRoot, 'default-skills'),
  parseSkillVersion: () => undefined,
  RETIRED_DEFAULT_SKILL_SLUGS: [],
  isRetiredDefaultSkill: () => false,
}))

mock.module('./builtin-mcp/catalog', () => ({
  listBuiltinMcpServers: () => [],
}))

/** 被测的能力摘要与 Agent 运行时 Skill 扫描入口。 */
const {
  getWorkspaceCapabilities,
  getWorkspaceSkills,
} = await import('./agent-workspace-manager')

/** 写入一个最小可识别的 Skill，供能力摘要与运行时扫描共同验证。 */
function writeSkill(directory: string, slug: string, name: string): void {
  /** 当前测试 Skill 的独立目录。 */
  const skillDirectory = join(directory, slug)
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(join(skillDirectory, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf-8')
}

beforeAll(() => {
  /** 测试项目根，用于同时布置启用、关闭 Skill 与 MCP 配置。 */
  const workspaceRoot = join(testRoot, 'project-a')
  writeSkill(join(workspaceRoot, 'skills'), 'active-skill', '启用 Skill')
  writeSkill(join(workspaceRoot, 'skills-inactive'), 'inactive-skill', '关闭 Skill')
  writeFileSync(join(workspaceRoot, 'mcp.json'), JSON.stringify({
    servers: {
      example: {
        enabled: true,
        type: 'stdio',
        command: 'example',
        args: [],
        lastTestResult: {
          success: false,
          timestamp: 123,
          message: 'secret endpoint detail',
        },
      },
    },
  }), 'utf-8')
})

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true })
})

describe('工作区能力摘要', () => {
  test('Given Skill 已关闭 When 读取 UI 能力摘要 Then 保留 Skill 并标记为关闭', () => {
    /** UI 获取的完整能力摘要。 */
    const capabilities = getWorkspaceCapabilities('project-a')

    expect(capabilities.skills).toEqual([
      expect.objectContaining({ slug: 'active-skill', enabled: true }),
      expect.objectContaining({ slug: 'inactive-skill', enabled: false }),
    ])
  })

  test('Given Skill 已关闭 When Agent 运行时扫描 Skills Then 仍只返回启用目录', () => {
    expect(getWorkspaceSkills('project-a')).toEqual([
      expect.objectContaining({ slug: 'active-skill', enabled: true }),
    ])
  })

  test('Given MCP 测试结果含诊断详情 When 读取能力摘要 Then 仅暴露状态和时间戳', () => {
    /** IPC 能力摘要中的脱敏 MCP 测试结果。 */
    const result = getWorkspaceCapabilities('project-a').mcpServers[0]?.lastTestResult

    expect(result).toEqual({ success: false, timestamp: 123 })
    expect(result && 'message' in result).toBe(false)
  })
})
