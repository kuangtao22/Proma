import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystemPrompt } from './agent-prompt-builder'

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

  /** 单个 provider 从指定 fixture 根一次性返回完整 workspace 上下文。 */
  const prompt = buildSystemPrompt({
    workspaceSlug: 'proma',
    sessionId: 'session-1',
    permissionMode: 'bypassPermissions',
    dependencies: {
      resolveWorkspaceContext: (slug) => {
        /** provider 内的路径和元数据始终来自同一个自定义根。 */
        const index = JSON.parse(readFileSync(join(customRoot, 'agent-workspaces.json'), 'utf-8')) as {
          workspaces: Array<{ slug: string; projectRootPath?: string }>
        }
        const workspace = index.workspaces.find((item) => item.slug === slug)
        return {
          workspaceRoot: join(customRoot, 'agent-workspaces', slug),
          projectRoot: workspace?.projectRootPath ?? join(customRoot, 'agent-workspaces', slug, 'workspace-files'),
          isLocalProject: Boolean(workspace?.projectRootPath),
        }
      },
      getUserName: () => '测试用户',
      isGitAttributionEnabled: () => true,
    },
  })

  expect(prompt).toContain(join(customRoot, 'agent-workspaces', 'proma', 'AGENTS.md'))
  expect(prompt).toContain(customRootProject)
  expect(prompt).not.toContain(defaultRootProject)
  expect(prompt).not.toContain('/Users/test/.proma/agent-workspaces')
})
