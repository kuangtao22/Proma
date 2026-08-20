import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystemPrompt } from './agent-prompt-builder'
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

  /** 使用同一依赖对象注入路径解析、workspace 元数据与静态配置。 */
  const prompt = buildSystemPrompt({
    workspaceSlug: 'proma',
    sessionId: 'session-1',
    permissionMode: 'bypassPermissions',
    dependencies: {
      configRootResolver: new DataRootLocator({ homeDir }),
      getWorkspaceBySlug: (slug) => {
        /** lookup 与 resolver 读取同一个自定义根的工作区索引。 */
        const index = JSON.parse(readFileSync(join(customRoot, 'agent-workspaces.json'), 'utf-8')) as {
          workspaces: Array<{ slug: string; projectRootPath?: string }>
        }
        return index.workspaces.find((workspace) => workspace.slug === slug)
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
