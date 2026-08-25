import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystemPrompt, createWorkspacePromptContextProvider } from './agent-prompt-builder'
import { DataRootLocator } from './data-root-locator'

/** 当前测试创建的临时目录，测试结束后统一清理。 */
const temporaryDirs: string[] = []

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
  /** 同 slug 在默认根元数据中指向的另一项目路径，用于发现混根。 */
  const defaultRootProject = join(homeDir, '.proma', 'default-root-project')
  /** 注入数据根对应的本地项目路径。 */
  const customRootProject = join(customRoot, 'custom-root-project')
  temporaryDirs.push(homeDir, customRoot)
  writeFileSync(
    join(homeDir, '.proma-location.json'),
    JSON.stringify({ version: 1, activeRoot: customRoot }),
    'utf-8',
  )
  mkdirSync(customRoot, { recursive: true })
  mkdirSync(join(homeDir, '.proma'), { recursive: true })
  /** 两个数据根保存相同 slug、不同项目路径，模拟迁移切换后的真实冲突。 */
  writeFileSync(
    join(homeDir, '.proma', 'agent-workspaces.json'),
    JSON.stringify({ version: 2, workspaces: [{ slug: 'proma', projectRootPath: defaultRootProject }] }),
    'utf-8',
  )
  writeFileSync(
    join(customRoot, 'agent-workspaces.json'),
    JSON.stringify({ version: 2, workspaces: [{ slug: 'proma', projectRootPath: customRootProject }] }),
    'utf-8',
  )

  /** 生产 provider factory 通过真实 locator 从同一活动根解析路径和元数据。 */
  const resolveWorkspaceContext = createWorkspacePromptContextProvider(new DataRootLocator({ homeDir }))
  const prompt = buildSystemPrompt({
    workspaceSlug: 'proma',
    sessionId: 'session-1',
    permissionMode: 'bypassPermissions',
    dependencies: {
      resolveWorkspaceContext,
      getUserName: () => '测试用户',
      isGitAttributionEnabled: () => true,
    },
  })

  expect(prompt).toContain(join(customRoot, 'agent-workspaces', 'proma', 'AGENTS.md'))
  expect(prompt).toContain(customRootProject)
  expect(prompt).not.toContain(defaultRootProject)
  expect(prompt).not.toContain('/Users/test/.proma/agent-workspaces')
})

test('Given 用户提出可能是视觉稿的设计需求 When 构建系统提示词 Then Agent 必须先区分设计与代码实现', () => {
  const prompt = buildSystemPrompt({
    sessionId: 'session-design-intent',
    permissionMode: 'bypassPermissions',
    dependencies: {
      resolveWorkspaceContext: () => ({
        workspaceRoot: '/tmp/workspace',
        projectRoot: '/tmp/project',
        isLocalProject: true,
      }),
      getUserName: () => '测试用户',
      isGitAttributionEnabled: () => false,
    },
  })

  expect(prompt).toContain('视觉设计与代码实现')
  expect(prompt).toContain('未明确要求修改代码')
  expect(prompt).toContain('先询问用户是否打开 Design')
})
