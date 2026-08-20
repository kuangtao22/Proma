import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebaseDataRootOwnedPaths, rebaseOwnedPath } from './owned-path-rebaser'

/** 将测试对象写成持久化 JSON。 */
function writeJson(filePath: string, value: object): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

/** 读取测试生成的 JSON 对象。 */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
}

describe('rebaseOwnedPath', () => {
  test('Given POSIX 根内外路径 When 重写 Then 仅严格根内绝对路径改到目标根', () => {
    /** POSIX 旧数据根。 */
    const sourceRoot = '/Users/test/.proma'
    /** POSIX 新数据根。 */
    const targetRoot = '/Volumes/Data/Proma'

    expect(rebaseOwnedPath('/Users/test/.proma/sdk-config/sessions/a.jsonl', sourceRoot, targetRoot))
      .toBe('/Volumes/Data/Proma/sdk-config/sessions/a.jsonl')
    expect(rebaseOwnedPath(sourceRoot, sourceRoot, targetRoot)).toBe(sourceRoot)
    expect(rebaseOwnedPath('/Users/test/.proma-old/a.jsonl', sourceRoot, targetRoot))
      .toBe('/Users/test/.proma-old/a.jsonl')
    expect(rebaseOwnedPath('/Users/test/Desktop/a.jsonl', sourceRoot, targetRoot))
      .toBe('/Users/test/Desktop/a.jsonl')
    expect(rebaseOwnedPath('sdk-config/sessions/a.jsonl', sourceRoot, targetRoot))
      .toBe('sdk-config/sessions/a.jsonl')
  })

  test('Given Windows drive 和 UNC 路径 When 在 POSIX 宿主判断 Then 使用 Windows 数据语义', () => {
    expect(rebaseOwnedPath('C:\\Users\\test\\.proma\\sessions\\a.jsonl', 'C:\\Users\\test\\.proma', 'D:\\Proma'))
      .toBe('D:\\Proma\\sessions\\a.jsonl')
    expect(rebaseOwnedPath('C:\\Users\\test\\.proma2\\a.jsonl', 'C:\\Users\\test\\.proma', 'D:\\Proma'))
      .toBe('C:\\Users\\test\\.proma2\\a.jsonl')
    expect(rebaseOwnedPath('\\\\server\\share\\proma\\sessions\\a.jsonl', '\\\\server\\share\\proma', '\\\\server2\\data\\proma'))
      .toBe('\\\\server2\\data\\proma\\sessions\\a.jsonl')
    expect(rebaseOwnedPath('\\\\server\\share\\proma-other\\a.jsonl', '\\\\server\\share\\proma', '\\\\server2\\data\\proma'))
      .toBe('\\\\server\\share\\proma-other\\a.jsonl')
  })

  test('Given 相同或嵌套的数据根 When 重写单值 Then 拒绝不安全根关系', () => {
    expect(() => rebaseOwnedPath('/old-root/sessions/a.jsonl', '/old-root', '/old-root'))
      .toThrow('必须不同')
    expect(() => rebaseOwnedPath('/old-root/sessions/a.jsonl', '/old-root', '/old-root/nested'))
      .toThrow('不能互相嵌套')
    expect(() => rebaseOwnedPath('C:\\Proma\\sessions\\a.jsonl', 'C:\\Proma', 'C:\\Proma\\nested'))
      .toThrow('不能互相嵌套')
  })
})

describe('rebaseDataRootOwnedPaths', () => {
  /** 每个用例隔离的父目录。 */
  let tempDir: string
  /** 模拟迁移前的数据根。 */
  let sourceRoot: string
  /** 模拟已复制完成的目标数据根。 */
  let targetRoot: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-owned-path-rebaser-'))
    sourceRoot = join(tempDir, 'source')
    targetRoot = join(tempDir, 'target')
    mkdirSync(sourceRoot)
    mkdirSync(targetRoot)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('Given 会话和工作区配置包含根内外混合路径 When 重写 Then 仅更新声明字段并保留未知数据', () => {
    /** 会话索引路径。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    /** 工作区索引路径。 */
    const workspacesPath = join(targetRoot, 'agent-workspaces.json')
    /** 工作区受管目录。 */
    const workspaceDir = join(targetRoot, 'agent-workspaces', 'alpha')
    /** 工作区配置路径。 */
    const workspaceConfigPath = join(workspaceDir, 'config.json')
    /** 不属于旧数据根的外部路径。 */
    const externalPath = join(tempDir, 'external', 'project')
    /** 与旧根只有字符串前缀相似的路径。 */
    const similarPrefixPath = `${sourceRoot}-old/file.txt`
    mkdirSync(workspaceDir, { recursive: true })

    writeJson(sessionsPath, {
      version: 4,
      sessions: [{
        id: 'session-1',
        title: '保留会话',
        piSessionFile: join(sourceRoot, 'sdk-config', 'sessions', 'a.jsonl'),
        forkSourceDir: sourceRoot,
        attachedDirectories: [join(sourceRoot, 'attachments'), externalPath, null],
        attachedFiles: [join(sourceRoot, 'attachments', 'a.png'), similarPrefixPath],
        sdkSessionId: 'pi-sdk-id',
        piEntryBindings: { ui: 'entry' },
        activeWorktree: { path: join(sourceRoot, '不要改'), mainRepoRoot: join(sourceRoot, '也不要改') },
        note: `说明文字 ${join(sourceRoot, 'sdk-config')}`,
        unknown: { preserved: true },
      }],
      unknownRoot: ['keep'],
    })
    writeJson(workspacesPath, {
      version: 2,
      workspaces: [{
        id: 'workspace-1',
        name: 'Alpha',
        slug: 'alpha',
        projectRootPath: join(sourceRoot, '用户项目路径不属于 Proma-owned 字段'),
        createdAt: 1,
        updatedAt: 2,
        unknown: 'keep',
      }],
      unknownRoot: true,
    })
    writeJson(workspaceConfigPath, {
      attachedDirectories: [join(sourceRoot, 'agent-workspaces', 'alpha', 'workspace-files'), externalPath, null],
      attachedFiles: [join(sourceRoot, 'agent-workspaces', 'alpha', 'file.txt'), similarPrefixPath],
      worktreeRepos: [{
        name: 'managed',
        repoPath: join(sourceRoot, 'repos', 'main'),
        worktreesPath: join(sourceRoot, 'worktrees'),
        priority: 1,
        unknown: 'keep',
      }, {
        name: 'external',
        repoPath: externalPath,
        worktreesPath: '',
      }, null],
      projectKnowledgeMaintenanceApproved: true,
      note: `普通说明 ${sourceRoot}`,
      unknown: { nestedPath: join(sourceRoot, '不得递归替换') },
    })

    /** 首次重写的文件级结果。 */
    const firstResult = rebaseDataRootOwnedPaths({ sourceRoot, targetRoot })
    /** 首次重写后的会话索引。 */
    const sessions = readJson(sessionsPath)
    /** 首次重写后的会话记录。 */
    const session = (sessions.sessions as Array<Record<string, unknown>>)[0]
    /** 首次重写后的工作区索引。 */
    const workspaces = readJson(workspacesPath)
    /** 首次重写后的工作区配置。 */
    const config = readJson(workspaceConfigPath)

    expect(firstResult.updatedFiles).toEqual([sessionsPath, workspaceConfigPath])
    expect(session).toBeDefined()
    if (!session) throw new Error('测试夹具缺少会话记录')
    expect(session.piSessionFile).toBe(join(targetRoot, 'sdk-config', 'sessions', 'a.jsonl'))
    expect(session.forkSourceDir).toBe(sourceRoot)
    expect(session.attachedDirectories).toEqual([join(targetRoot, 'attachments'), externalPath, null])
    expect(session.attachedFiles).toEqual([join(targetRoot, 'attachments', 'a.png'), similarPrefixPath])
    expect(session.sdkSessionId).toBe('pi-sdk-id')
    expect(session.piEntryBindings).toEqual({ ui: 'entry' })
    expect(session.activeWorktree).toEqual({ path: join(sourceRoot, '不要改'), mainRepoRoot: join(sourceRoot, '也不要改') })
    expect(session.note).toBe(`说明文字 ${join(sourceRoot, 'sdk-config')}`)
    expect(session.unknown).toEqual({ preserved: true })
    expect(sessions.unknownRoot).toEqual(['keep'])
    expect((workspaces.workspaces as Array<Record<string, unknown>>)[0]?.projectRootPath)
      .toBe(join(sourceRoot, '用户项目路径不属于 Proma-owned 字段'))
    expect(existsSync(`${workspacesPath}.bak`)).toBe(false)
    expect(config.attachedDirectories).toEqual([
      join(targetRoot, 'agent-workspaces', 'alpha', 'workspace-files'),
      externalPath,
      null,
    ])
    expect(config.attachedFiles).toEqual([join(targetRoot, 'agent-workspaces', 'alpha', 'file.txt'), similarPrefixPath])
    expect(config.worktreeRepos).toEqual([{
      name: 'managed',
      repoPath: join(targetRoot, 'repos', 'main'),
      worktreesPath: join(targetRoot, 'worktrees'),
      priority: 1,
      unknown: 'keep',
    }, {
      name: 'external',
      repoPath: externalPath,
      worktreesPath: '',
    }, null])
    expect(config.note).toBe(`普通说明 ${sourceRoot}`)
    expect(config.unknown).toEqual({ nestedPath: join(sourceRoot, '不得递归替换') })

    /** 首次重写后的稳定文件内容，用于证明第二次运行无写入。 */
    const stableSessionsContent = readFileSync(sessionsPath, 'utf-8')
    /** 第二次重写的幂等结果。 */
    const secondResult = rebaseDataRootOwnedPaths({ sourceRoot, targetRoot })

    expect(secondResult.updatedFiles).toEqual([])
    expect(readFileSync(sessionsPath, 'utf-8')).toBe(stableSessionsContent)
  })

  test('Given 索引和配置文件全部缺失 When 重写 Then 安全跳过且不创建文件', () => {
    expect(rebaseDataRootOwnedPaths({ sourceRoot, targetRoot })).toEqual({
      inspectedFiles: [],
      updatedFiles: [],
    })
    expect(existsSync(join(targetRoot, 'agent-sessions.json'))).toBe(false)
    expect(existsSync(join(targetRoot, 'agent-workspaces.json'))).toBe(false)
  })

  test('Given 主文件损坏但备份合法 When 重写 Then 使用 safe-file 恢复后更新', () => {
    /** 损坏的会话主文件路径。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    writeFileSync(sessionsPath, '{broken', 'utf-8')
    writeJson(`${sessionsPath}.bak`, {
      version: 4,
      sessions: [{ id: 's', piSessionFile: join(sourceRoot, 'sessions', 's.jsonl') }],
    })

    expect(rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }).updatedFiles).toEqual([sessionsPath])
    /** 从备份恢复并完成重写的会话记录。 */
    const recoveredSession = (readJson(sessionsPath).sessions as Array<Record<string, unknown>>)[0]
    expect(recoveredSession).toBeDefined()
    expect(recoveredSession?.piSessionFile).toBe(join(targetRoot, 'sessions', 's.jsonl'))
  })

  test('Given 持久化 JSON 无可用恢复候选 When 重写 Then 明确失败', () => {
    /** 无法解析的会话索引路径。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    writeFileSync(sessionsPath, '{broken', 'utf-8')

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('agent-sessions.json 损坏或 schema 无法安全解释')
  })

  test('Given workspace 配置候选是 symlink When 重写 Then 拒绝跟随', () => {
    /** 工作区目录。 */
    const workspaceDir = join(targetRoot, 'agent-workspaces', 'alpha')
    /** 目标根外的真实配置。 */
    const externalConfigPath = join(tempDir, 'external-config.json')
    mkdirSync(workspaceDir, { recursive: true })
    writeJson(join(targetRoot, 'agent-workspaces.json'), {
      version: 2,
      workspaces: [{ slug: 'alpha' }],
    })
    writeJson(externalConfigPath, { attachedFiles: [join(sourceRoot, 'secret.txt')] })
    symlinkSync(externalConfigPath, join(workspaceDir, 'config.json'))

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('配置候选必须是普通文件')
    expect(readJson(externalConfigPath).attachedFiles).toEqual([join(sourceRoot, 'secret.txt')])
  })

  test('Given workspace slug 会逃逸目标根 When 重写 Then 在读取配置前拒绝', () => {
    writeJson(join(targetRoot, 'agent-workspaces.json'), {
      version: 2,
      workspaces: [{ slug: '../../outside' }],
    })

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('工作区配置路径越过目标数据根')
  })

  test('Given 数据根相同、相对或嵌套 When 重写 Then 在 I/O 前拒绝', () => {
    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot: sourceRoot })).toThrow('必须不同')
    expect(() => rebaseDataRootOwnedPaths({ sourceRoot: 'relative-source', targetRoot })).toThrow('必须是绝对路径')
    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot: join(sourceRoot, 'nested') })).toThrow('不能互相嵌套')
  })
})
