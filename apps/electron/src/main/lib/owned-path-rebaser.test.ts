import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebaseDataRootOwnedPaths, rebaseOwnedPath } from './owned-path-rebaser'
import {
  captureDirectoryGuard,
  fsyncParentDirectory,
  preflightPersistentJson,
  recoverPersistentJson,
  validateDataRoots,
  writePersistentJson,
} from './owned-path-rebaser-safe-json'
import { isWorkspaceConfig } from './owned-path-rebaser-schema'
import { readJsonFileSafe } from './safe-file'

/** 明确允许硬链接能力探测吞掉的平台或权限错误码。 */
const HARD_LINK_UNAVAILABLE_CODES = new Set([
  'EACCES',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
])

/** 探测当前临时文件系统是否支持硬链接，并清理探测文件。 */
function supportsHardLinks(): boolean {
  /** 隔离的硬链接能力探测目录。 */
  const probeDir = mkdtempSync(join(tmpdir(), 'proma-owned-path-hardlink-probe-'))
  /** 探测源文件。 */
  const sourcePath = join(probeDir, 'source')
  /** 探测硬链接。 */
  const linkPath = join(probeDir, 'link')
  try {
    writeFileSync(sourcePath, 'probe')
    linkSync(sourcePath, linkPath)
    return true
  } catch (error) {
    /** Node 文件系统错误码用于区分能力不足与测试故障。 */
    const code = error instanceof Error && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined
    if (code && HARD_LINK_UNAVAILABLE_CODES.has(code)) return false
    throw error
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

/** 探测当前临时文件系统是否大小写不敏感。 */
function isCaseInsensitiveFileSystem(): boolean {
  /** 隔离的大小写能力探测目录。 */
  const probeDir = mkdtempSync(join(tmpdir(), 'proma-owned-path-case-probe-'))
  /** 小写探测文件。 */
  const lowercasePath = join(probeDir, 'probe')
  try {
    writeFileSync(lowercasePath, 'probe')
    return existsSync(join(probeDir, 'PROBE'))
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

/** 当前测试文件系统的硬链接能力。 */
const HARD_LINKS_SUPPORTED = supportsHardLinks()
/** 当前测试文件系统的大小写语义。 */
const CASE_INSENSITIVE_FILE_SYSTEM = isCaseInsensitiveFileSystem()

/** 创建带 Node 文件系统错误码的测试异常。 */
function createFileSystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`filesystem error: ${code}`), { code })
}

describe('fsyncParentDirectory', () => {
  test('Given 目录 fsync 成功 When 刷盘 Then 依次打开、fsync 并关闭且不告警', () => {
    /** 记录依赖调用顺序。 */
    const calls: string[] = []
    /** 收集不应出现的 warning。 */
    const warnings: string[] = []

    fsyncParentDirectory('/target', {
      openDirectory: (directoryPath) => {
        calls.push(`open:${directoryPath}`)
        return 42
      },
      fsync: (descriptor) => calls.push(`fsync:${descriptor}`),
      close: (descriptor) => calls.push(`close:${descriptor}`),
      warn: (message) => warnings.push(message),
    })

    expect(calls).toEqual(['open:/target', 'fsync:42', 'close:42'])
    expect(warnings).toEqual([])
  })

  test('Given 平台明确不支持目录 fsync When 刷盘 Then warning 后继续', () => {
    /** 明确表示能力不支持的错误。 */
    const unsupportedError = createFileSystemError('ENOTSUP')
    /** 收集降级 warning。 */
    const warnings: string[] = []
    /** 记录目录 fd 是否关闭。 */
    let closed = false

    expect(() => fsyncParentDirectory('/target', {
      openDirectory: () => 43,
      fsync: () => { throw unsupportedError },
      close: () => { closed = true },
      warn: (message) => warnings.push(message),
    })).not.toThrow()
    expect(closed).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('ENOTSUP')
  })

  test('Given 打开目录失败 When 刷盘 Then 仅明确 unsupported 错误允许降级', () => {
    /** 收集 open unsupported 的降级 warning。 */
    const warnings: string[] = []
    expect(() => fsyncParentDirectory('/target', {
      openDirectory: () => { throw createFileSystemError('ENOSYS') },
      fsync: () => { throw new Error('不应调用 fsync') },
      close: () => { throw new Error('不应调用 close') },
      warn: (message) => warnings.push(message),
    })).not.toThrow()
    expect(warnings).toHaveLength(1)

    for (const code of ['ENOENT', 'EIO']) {
      /** 当前 open 必须传播的原始错误。 */
      const expectedError = createFileSystemError(code)
      expect(() => fsyncParentDirectory('/target', {
        openDirectory: () => { throw expectedError },
        fsync: () => { throw new Error('不应调用 fsync') },
        close: () => { throw new Error('不应调用 close') },
        warn: (message) => warnings.push(message),
      })).toThrow(expectedError)
    }
    expect(warnings).toHaveLength(1)
  })

  test('Given 目录 fsync 遇到持久化或未知错误 When 刷盘 Then 原样传播', () => {
    /** 不得降级的错误码；空字符串代表未知错误。 */
    const fatalCodes = ['EIO', 'ENOSPC', 'EROFS', 'EBADF', '']
    for (const code of fatalCodes) {
      /** 当前待传播的原始错误对象。 */
      const expectedError = code ? createFileSystemError(code) : new Error('unknown fsync failure')
      /** 收集不应出现的 warning。 */
      const warnings: string[] = []
      /** 记录异常路径是否关闭目录 fd。 */
      let closed = false

      expect(() => fsyncParentDirectory('/target', {
        openDirectory: () => 44,
        fsync: () => { throw expectedError },
        close: () => { closed = true },
        warn: (message) => warnings.push(message),
      })).toThrow(expectedError)
      expect(closed).toBe(true)
      expect(warnings).toEqual([])
    }
  })
})

/** 将测试对象写成持久化 JSON。 */
function writeJson(filePath: string, value: object): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

/** 读取测试生成的 JSON 对象。 */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
}

/** 创建符合 AgentSessionMeta 必填合同的会话测试数据。 */
function createSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'session-1',
    title: '测试会话',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/** 创建符合 AgentWorkspace 必填合同的工作区测试数据。 */
function createWorkspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'workspace-1',
    name: '测试项目',
    slug: 'alpha',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
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
    expect(rebaseOwnedPath('//server/share/proma/sessions/a.jsonl', '//server/share/proma', '//server2/data/proma'))
      .toBe('\\\\server2\\data\\proma\\sessions\\a.jsonl')
    expect(rebaseOwnedPath('//server/share2/proma/a.jsonl', '//server/share/proma', '//server2/data/proma'))
      .toBe('//server/share2/proma/a.jsonl')
    expect(rebaseOwnedPath('//server/share/proma2/a.jsonl', '//server/share/proma', '//server2/data/proma'))
      .toBe('//server/share/proma2/a.jsonl')
    expect(rebaseOwnedPath('\\\\server2\\data\\proma\\sessions\\a.jsonl', '\\\\server\\share\\proma', '\\\\server2\\data\\proma'))
      .toBe('\\\\server2\\data\\proma\\sessions\\a.jsonl')
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
      sessions: [createSession({
        title: '保留会话',
        piSessionFile: join(sourceRoot, 'sdk-config', 'sessions', 'a.jsonl'),
        forkSourceDir: sourceRoot,
        attachedDirectories: [join(sourceRoot, 'attachments'), externalPath, join(sourceRoot, 'attachments')],
        attachedFiles: [join(sourceRoot, 'attachments', 'a.png'), similarPrefixPath, join(sourceRoot, 'attachments', 'a.png')],
        sdkSessionId: 'pi-sdk-id',
        permissionMode: 'auto',
        reasoningLevel: 'future-reasoning-level',
        agentCwdMode: 'future-cwd-mode',
        piEntryBindings: { ui: 'entry' },
        activeWorktree: {
          path: join(sourceRoot, '不要改'),
          mainRepoRoot: join(sourceRoot, '也不要改'),
          branch: 'main',
          selectedAt: 3,
        },
        note: `说明文字 ${join(sourceRoot, 'sdk-config')}`,
        unknown: { preserved: true },
      })],
      unknownRoot: ['keep'],
    })
    writeJson(workspacesPath, {
      version: 2,
      workspaces: [createWorkspace({
        name: 'Alpha',
        projectRootPath: join(sourceRoot, '用户项目路径不属于 Proma-owned 字段'),
        unknown: 'keep',
      })],
      unknownRoot: true,
    })
    writeJson(workspaceConfigPath, {
      attachedDirectories: [
        join(sourceRoot, 'agent-workspaces', 'alpha', 'workspace-files'),
        externalPath,
        join(sourceRoot, 'agent-workspaces', 'alpha', 'workspace-files'),
      ],
      attachedFiles: [
        join(sourceRoot, 'agent-workspaces', 'alpha', 'file.txt'),
        similarPrefixPath,
        join(sourceRoot, 'agent-workspaces', 'alpha', 'file.txt'),
      ],
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
      }],
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
    expect(session.attachedDirectories).toEqual([join(targetRoot, 'attachments'), externalPath, join(targetRoot, 'attachments')])
    expect(session.attachedFiles).toEqual([
      join(targetRoot, 'attachments', 'a.png'),
      similarPrefixPath,
      join(targetRoot, 'attachments', 'a.png'),
    ])
    expect(session.sdkSessionId).toBe('pi-sdk-id')
    expect(session.permissionMode).toBe('auto')
    expect(session.reasoningLevel).toBe('future-reasoning-level')
    expect(session.agentCwdMode).toBe('future-cwd-mode')
    expect(session.piEntryBindings).toEqual({ ui: 'entry' })
    expect(session.activeWorktree).toEqual({
      path: join(sourceRoot, '不要改'),
      mainRepoRoot: join(sourceRoot, '也不要改'),
      branch: 'main',
      selectedAt: 3,
    })
    expect(session.note).toBe(`说明文字 ${join(sourceRoot, 'sdk-config')}`)
    expect(session.unknown).toEqual({ preserved: true })
    expect(sessions.unknownRoot).toEqual(['keep'])
    expect((workspaces.workspaces as Array<Record<string, unknown>>)[0]?.projectRootPath)
      .toBe(join(sourceRoot, '用户项目路径不属于 Proma-owned 字段'))
    expect(existsSync(`${workspacesPath}.bak`)).toBe(false)
    expect(config.attachedDirectories).toEqual([
      join(targetRoot, 'agent-workspaces', 'alpha', 'workspace-files'),
      externalPath,
      join(targetRoot, 'agent-workspaces', 'alpha', 'workspace-files'),
    ])
    expect(config.attachedFiles).toEqual([
      join(targetRoot, 'agent-workspaces', 'alpha', 'file.txt'),
      similarPrefixPath,
      join(targetRoot, 'agent-workspaces', 'alpha', 'file.txt'),
    ])
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
    }])
    expect(config.note).toBe(`普通说明 ${sourceRoot}`)
    expect(config.unknown).toEqual({ nestedPath: join(sourceRoot, '不得递归替换') })
    expect(readFileSync(`${sessionsPath}.bak`).equals(readFileSync(sessionsPath))).toBe(true)
    expect(readFileSync(`${workspaceConfigPath}.bak`).equals(readFileSync(workspaceConfigPath))).toBe(true)
    expect(readdirSync(targetRoot).filter((name) => name.startsWith('.proma-atomic-'))).toEqual([])
    expect(readdirSync(workspaceDir).filter((name) => name.startsWith('.proma-atomic-'))).toEqual([])

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
      sessions: [createSession({ id: 's', piSessionFile: join(sourceRoot, 'sessions', 's.jsonl') })],
    })

    expect(rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }).updatedFiles).toEqual([sessionsPath])
    /** 从备份恢复并完成重写的会话记录。 */
    const recoveredSession = (readJson(sessionsPath).sessions as Array<Record<string, unknown>>)[0]
    expect(recoveredSession).toBeDefined()
    expect(recoveredSession?.piSessionFile).toBe(join(targetRoot, 'sessions', 's.jsonl'))
    expect(readJson(`${sessionsPath}.bak`)).toEqual(readJson(sessionsPath))
    writeFileSync(sessionsPath, '{broken-again', 'utf-8')
    /** 使用全局 safe-file 从 Task4 生成的备份恢复出的最终值。 */
    const safeRecovered = readJsonFileSafe<Record<string, unknown>>(sessionsPath, {
      validate: (value): value is Record<string, unknown> => (
        typeof value === 'object' && value !== null && !Array.isArray(value)
      ),
    })
    /** safe-file 恢复出的会话数组。 */
    const safeRecoveredSessions = safeRecovered && 'sessions' in safeRecovered
      ? safeRecovered.sessions as Array<Record<string, unknown>>
      : []
    expect(safeRecoveredSessions[0]?.piSessionFile)
      .toBe(join(targetRoot, 'sessions', 's.jsonl'))
  })

  test('Given 主文件已是目标路径但 bak 仍是旧路径 When 二次执行 Then 修复 bak 且不误报 owned 更新', () => {
    /** 已完成迁移的会话主文件。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    writeJson(sessionsPath, {
      version: 2,
      sessions: [createSession({ piSessionFile: join(targetRoot, 'sessions', 'stable.jsonl') })],
    })
    writeJson(`${sessionsPath}.bak`, {
      version: 2,
      sessions: [createSession({ piSessionFile: join(sourceRoot, 'sessions', 'stale.jsonl') })],
    })

    expect(rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }).updatedFiles).toEqual([])
    expect(readJson(`${sessionsPath}.bak`)).toEqual(readJson(sessionsPath))
  })

  test('Given 持久化 JSON 无可用恢复候选 When 重写 Then 明确失败', () => {
    /** 无法解析的会话索引路径。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    writeFileSync(sessionsPath, '{broken', 'utf-8')

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('agent-sessions.json 损坏或 schema 无法安全解释')
  })

  test('Given 主文件缺失且 tmp 会话索引合法 When 重写 Then 先恢复再更新根内路径', () => {
    /** 仅存在安全写残留的会话主路径。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    writeJson(`${sessionsPath}.tmp`, {
      version: 2,
      sessions: [createSession({ piSessionFile: join(sourceRoot, 'sessions', 'tmp.jsonl') })],
    })

    expect(rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }).updatedFiles).toEqual([sessionsPath])
    expect(existsSync(`${sessionsPath}.tmp`)).toBe(false)
    /** 从 tmp 提升并重写后的会话。 */
    const restoredSession = (readJson(sessionsPath).sessions as Array<Record<string, unknown>>)[0]
    expect(restoredSession?.piSessionFile).toBe(join(targetRoot, 'sessions', 'tmp.jsonl'))
  })

  test('Given 会话缺少真实必填字段 When 重写 Then schema 失败且不创建备份', () => {
    /** schema 合法 JSON 但不符合 AgentSessionMeta 的索引路径。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    writeJson(sessionsPath, { version: 2, sessions: [{}] })

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('agent-sessions.json 损坏或 schema 无法安全解释')
    expect(existsSync(`${sessionsPath}.bak`)).toBe(false)
  })

  test('Given 后续工作区索引 schema 无效 When 预检 Then 不部分写已读取的会话索引', () => {
    /** 原本会被重写的合法会话索引。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    /** 缺少 name 和时间戳的非法工作区索引。 */
    const workspacesPath = join(targetRoot, 'agent-workspaces.json')
    writeJson(sessionsPath, {
      version: 2,
      sessions: [createSession({ piSessionFile: join(sourceRoot, 'sessions', 'a.jsonl') })],
    })
    writeJson(workspacesPath, { version: 2, workspaces: [{ id: 'w', slug: 'alpha' }] })
    /** 失败前必须保持的会话文件原文。 */
    const originalSessions = readFileSync(sessionsPath, 'utf-8')

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('agent-workspaces.json 损坏或 schema 无法安全解释')
    expect(readFileSync(sessionsPath, 'utf-8')).toBe(originalSessions)
    expect(existsSync(`${sessionsPath}.bak`)).toBe(false)
  })

  test('Given 会话需要 bak 恢复但后续 schema 无效 When 预检 Then 不提前恢复任何文件', () => {
    /** 保持损坏状态直到全量 schema 通过的会话主文件。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    /** 后续会触发预检失败的工作区索引。 */
    const workspacesPath = join(targetRoot, 'agent-workspaces.json')
    /** 预检失败后必须保持不变的损坏主文件原文。 */
    const brokenPrimary = '{broken'
    writeFileSync(sessionsPath, brokenPrimary, 'utf-8')
    writeJson(`${sessionsPath}.bak`, { version: 2, sessions: [createSession()] })
    writeJson(workspacesPath, { version: 2, workspaces: [{ slug: 'alpha' }] })

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('agent-workspaces.json 损坏或 schema 无法安全解释')
    expect(readFileSync(sessionsPath, 'utf-8')).toBe(brokenPrimary)
  })

  test('Given 两个完整 workspace 重复 slug When 全量预检 Then 失败且所有候选字节不变', () => {
    /** 需要 bak 恢复但不得在所有权校验前恢复的会话主文件。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    /** 会话备份候选。 */
    const sessionsBackupPath = `${sessionsPath}.bak`
    /** 含重复 slug 的工作区索引。 */
    const workspacesPath = join(targetRoot, 'agent-workspaces.json')
    /** 重复条目共同指向的工作区目录。 */
    const workspaceDir = join(targetRoot, 'agent-workspaces', 'alpha')
    /** 重复条目共同指向的配置文件。 */
    const configPath = join(workspaceDir, 'config.json')
    mkdirSync(workspaceDir, { recursive: true })
    writeFileSync(sessionsPath, '{broken', 'utf-8')
    writeJson(sessionsBackupPath, { version: 2, sessions: [createSession()] })
    writeJson(workspacesPath, {
      version: 2,
      workspaces: [
        createWorkspace({ id: 'workspace-a', name: '项目 A', slug: 'alpha' }),
        createWorkspace({ id: 'workspace-b', name: '项目 B', slug: 'alpha' }),
      ],
    })
    writeJson(configPath, { attachedFiles: [join(sourceRoot, 'file.txt')] })
    /** 调用前每个现存候选的原始字节。 */
    const originalBytes = new Map([
      [sessionsPath, readFileSync(sessionsPath)],
      [sessionsBackupPath, readFileSync(sessionsBackupPath)],
      [workspacesPath, readFileSync(workspacesPath)],
      [configPath, readFileSync(configPath)],
    ])

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('agent-workspaces.json 存在重复 workspace slug')
    for (const [filePath, content] of originalBytes) {
      expect(readFileSync(filePath).equals(content)).toBe(true)
    }
    expect(existsSync(`${sessionsPath}.tmp`)).toBe(false)
    expect(existsSync(`${workspacesPath}.bak`)).toBe(false)
    expect(existsSync(`${configPath}.bak`)).toBe(false)
  })

  test('Given 两个完整 workspace 重复 id When 全量预检 Then 视为索引损坏', () => {
    /** 含重复 id、不同 slug 的工作区索引。 */
    const workspacesPath = join(targetRoot, 'agent-workspaces.json')
    writeJson(workspacesPath, {
      version: 2,
      workspaces: [
        createWorkspace({ id: 'workspace-duplicate', slug: 'alpha' }),
        createWorkspace({ id: 'workspace-duplicate', slug: 'beta' }),
      ],
    })
    /** 失败前索引原始字节。 */
    const originalIndex = readFileSync(workspacesPath)

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('agent-workspaces.json 存在重复 workspace id')
    expect(readFileSync(workspacesPath).equals(originalIndex)).toBe(true)
  })

  test.skipIf(!HARD_LINKS_SUPPORTED)('Given 唯一 workspace 的 config 主文件共享物理 identity When 预检 Then 拒绝重复所有权', () => {
    /** 两个唯一工作区的容器目录。 */
    const workspacesDir = join(targetRoot, 'agent-workspaces')
    /** 两个不同请求路径的配置文件。 */
    const alphaConfigPath = join(workspacesDir, 'alpha', 'config.json')
    const betaConfigPath = join(workspacesDir, 'beta', 'config.json')
    mkdirSync(join(workspacesDir, 'alpha'), { recursive: true })
    mkdirSync(join(workspacesDir, 'beta'), { recursive: true })
    writeJson(join(targetRoot, 'agent-workspaces.json'), {
      version: 2,
      workspaces: [
        createWorkspace({ id: 'workspace-alpha', slug: 'alpha' }),
        createWorkspace({ id: 'workspace-beta', slug: 'beta' }),
      ],
    })
    writeJson(alphaConfigPath, { attachedFiles: [join(sourceRoot, 'shared.txt')] })
    linkSync(alphaConfigPath, betaConfigPath)
    /** 失败前共享 inode 的原始字节。 */
    const originalConfig = readFileSync(alphaConfigPath)

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('配置候选不得是多链接文件')
    expect(readFileSync(alphaConfigPath).equals(originalConfig)).toBe(true)
    expect(readFileSync(betaConfigPath).equals(originalConfig)).toBe(true)
    expect(existsSync(`${alphaConfigPath}.bak`)).toBe(false)
    expect(existsSync(`${betaConfigPath}.bak`)).toBe(false)
  })

  test.skipIf(!HARD_LINKS_SUPPORTED)('Given main tmp bak 候选含根外硬链接或互相别名 When 预检 Then 拒绝且 sentinel 字节不变', () => {
    /** 目标根外不可被 Task4 修改的 sentinel。 */
    const sentinelPath = join(tempDir, 'outside-sentinel.json')
    /** 会话主文件路径。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    writeJson(sentinelPath, {
      version: 2,
      sessions: [createSession({ piSessionFile: join(sourceRoot, 'outside.jsonl') })],
    })
    linkSync(sentinelPath, sessionsPath)
    /** 调用前 sentinel 原始字节。 */
    const originalSentinel = readFileSync(sentinelPath)

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot })).toThrow('多链接')
    expect(readFileSync(sentinelPath).equals(originalSentinel)).toBe(true)

    unlinkSync(sessionsPath)
    writeJson(sessionsPath, { version: 2, sessions: [createSession()] })
    linkSync(sentinelPath, `${sessionsPath}.tmp`)
    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot })).toThrow('多链接')
    expect(readFileSync(sentinelPath).equals(originalSentinel)).toBe(true)
    unlinkSync(`${sessionsPath}.tmp`)

    linkSync(sentinelPath, `${sessionsPath}.bak`)
    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot })).toThrow('多链接')
    expect(readFileSync(sentinelPath).equals(originalSentinel)).toBe(true)
    unlinkSync(`${sessionsPath}.bak`)

    linkSync(sessionsPath, `${sessionsPath}.tmp`)
    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot })).toThrow('多链接')
    expect(readdirSync(targetRoot).filter((name) => name.startsWith('.proma-atomic-'))).toEqual([])
  })

  test('Given owned 路径字段类型错误 When 预检 Then 仍拒绝损坏数据', () => {
    /** owned 字段类型错误的会话索引。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    writeJson(sessionsPath, {
      version: 2,
      sessions: [createSession({ attachedFiles: { invalid: true } })],
    })

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('agent-sessions.json 损坏或 schema 无法安全解释')
  })

  test('Given workspace slug 为点目录 When 预检 Then 不读取或写入工作区容器 config', () => {
    /** 工作区容器路径。 */
    const workspacesDir = join(targetRoot, 'agent-workspaces')
    /** 点目录会错误映射到的容器 config。 */
    const containerConfigPath = join(workspacesDir, 'config.json')
    mkdirSync(workspacesDir)
    writeJson(join(targetRoot, 'agent-workspaces.json'), {
      version: 2,
      workspaces: [createWorkspace({ slug: '.' })],
    })
    writeJson(containerConfigPath, { attachedFiles: [join(sourceRoot, 'protected.txt')] })
    /** 调用前容器 config 原始字节。 */
    const originalConfig = readFileSync(containerConfigPath)

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('workspace slug 不符合生成合同')
    expect(readFileSync(containerConfigPath).equals(originalConfig)).toBe(true)
    expect(existsSync(`${containerConfigPath}.bak`)).toBe(false)
  })

  test('Given 保留名或非规范 workspace slug When 预检 Then 在目录 I/O 前拒绝', () => {
    /** manager 永远不会生成的 slug 值。 */
    const invalidSlugs = ['..', 'CON', 'alpha beta', 'Alpha', 'alpha_beta', 'alpha/beta', 'alpha\\beta', '-alpha', 'alpha-']
    for (const slug of invalidSlugs) {
      writeJson(join(targetRoot, 'agent-workspaces.json'), {
        version: 2,
        workspaces: [createWorkspace({ slug })],
      })
      expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
        .toThrow('workspace slug 不符合生成合同')
    }
  })

  test('Given manager 可生成或默认创建的 workspace slug When 预检 Then 保持兼容', () => {
    /** 仓库真实生成合同中的合法 slug。 */
    const validSlugs = ['default', 'proma', 'product-dev', 'workspace-1720000000000', 'product-dev-2']
    writeJson(join(targetRoot, 'agent-workspaces.json'), {
      version: 2,
      workspaces: validSlugs.map((slug, index) => createWorkspace({ id: `workspace-${index}`, slug })),
    })

    expect(rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }).updatedFiles).toEqual([])
  })

  test.skipIf(!CASE_INSENSITIVE_FILE_SYSTEM)('Given 大小写不敏感文件系统和大写 slug When 预检 Then 先拒绝非规范 slug', () => {
    /** 用于探测当前文件系统大小写语义的工作区容器。 */
    const workspacesDir = join(targetRoot, 'agent-workspaces')
    /** 小写实际目录。 */
    const lowercaseDir = join(workspacesDir, 'alpha')
    /** 仅大小写不同的请求目录。 */
    const uppercaseDir = join(workspacesDir, 'ALPHA')
    mkdirSync(lowercaseDir, { recursive: true })
    writeJson(join(targetRoot, 'agent-workspaces.json'), {
      version: 2,
      workspaces: [
        createWorkspace({ id: 'workspace-lower', slug: 'alpha' }),
        createWorkspace({ id: 'workspace-upper', slug: 'ALPHA' }),
      ],
    })

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('workspace slug 不符合生成合同')
  })

  test('Given worktree repo 缺少必填字段 When 预检 Then 不部分写其它文件', () => {
    /** 原本会被重写的合法会话索引。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    /** 指向非法 config 的工作区索引。 */
    const workspacesPath = join(targetRoot, 'agent-workspaces.json')
    /** 当前工作区目录。 */
    const workspaceDir = join(targetRoot, 'agent-workspaces', 'alpha')
    mkdirSync(workspaceDir, { recursive: true })
    writeJson(sessionsPath, {
      version: 2,
      sessions: [createSession({ piSessionFile: join(sourceRoot, 'sessions', 'a.jsonl') })],
    })
    writeJson(workspacesPath, { version: 2, workspaces: [createWorkspace()] })
    writeJson(join(workspaceDir, 'config.json'), {
      worktreeRepos: [{ repoPath: join(sourceRoot, 'repo'), worktreesPath: join(sourceRoot, 'trees') }],
    })
    /** 失败前必须保持的会话文件原文。 */
    const originalSessions = readFileSync(sessionsPath, 'utf-8')

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('config.json 损坏或 schema 无法安全解释')
    expect(readFileSync(sessionsPath, 'utf-8')).toBe(originalSessions)
  })

  test('Given 目标根本身是 symlink When 重写 Then 在读取索引前拒绝', () => {
    /** symlink 指向的实际目标目录。 */
    const actualTarget = join(tempDir, 'actual-target')
    rmSync(targetRoot, { recursive: true })
    mkdirSync(actualTarget)
    symlinkSync(actualTarget, targetRoot)

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('targetRoot 必须是实际目录')
  })

  test('Given 目标根是普通文件 When 重写 Then 在读取索引前拒绝', () => {
    rmSync(targetRoot, { recursive: true })
    writeFileSync(targetRoot, 'not-directory', 'utf-8')

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('targetRoot 必须是实际目录')
  })

  test('Given 会话索引候选是 symlink When 重写 Then 拒绝读取根外文件', () => {
    /** 目标根外的合法会话索引。 */
    const externalIndexPath = join(tempDir, 'external-sessions.json')
    writeJson(externalIndexPath, { version: 2, sessions: [createSession()] })
    symlinkSync(externalIndexPath, join(targetRoot, 'agent-sessions.json'))

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('配置候选必须是普通文件')
    expect(readJson(externalIndexPath).sessions).toEqual([createSession()])
  })

  test('Given workspace 目录是 symlink When 重写 Then 拒绝读取根外配置', () => {
    /** 目标根外的真实工作区目录。 */
    const externalWorkspaceDir = join(tempDir, 'external-workspace')
    /** 目标根内的 workspace 容器。 */
    const workspacesDir = join(targetRoot, 'agent-workspaces')
    mkdirSync(externalWorkspaceDir)
    mkdirSync(workspacesDir)
    writeJson(join(targetRoot, 'agent-workspaces.json'), { version: 2, workspaces: [createWorkspace()] })
    writeJson(join(externalWorkspaceDir, 'config.json'), { attachedFiles: [join(sourceRoot, 'secret.txt')] })
    symlinkSync(externalWorkspaceDir, join(workspacesDir, 'alpha'))

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('工作区配置目录必须是普通目录')
    expect(readJson(join(externalWorkspaceDir, 'config.json')).attachedFiles)
      .toEqual([join(sourceRoot, 'secret.txt')])
  })

  test('Given 配置恢复确认后 workspace 目录被替换 When 原子提交 Then 按目录身份拒绝', () => {
    /** 工作区容器目录。 */
    const workspacesDir = join(targetRoot, 'agent-workspaces')
    /** 预检时的工作区目录。 */
    const workspaceDir = join(workspacesDir, 'alpha')
    /** 被移走的原工作区目录。 */
    const replacedWorkspaceDir = join(workspacesDir, 'alpha-replaced')
    /** 待预检的配置路径。 */
    const configPath = join(workspaceDir, 'config.json')
    mkdirSync(workspaceDir, { recursive: true })
    writeJson(configPath, { attachedFiles: [join(sourceRoot, 'file.txt')] })
    /** 目标根稳定身份。 */
    const targetGuard = validateDataRoots(sourceRoot, targetRoot)
    /** 工作区容器稳定身份。 */
    const workspacesGuard = captureDirectoryGuard(workspacesDir, targetGuard)
    /** 工作区目录稳定身份。 */
    const workspaceGuard = captureDirectoryGuard(workspaceDir, targetGuard)
    if (!workspacesGuard || !workspaceGuard) throw new Error('测试夹具缺少工作区目录 guard')
    /** 目录替换前完成的只读配置预检。 */
    const preflight = preflightPersistentJson(
      configPath,
      isWorkspaceConfig,
      targetGuard,
      [workspacesGuard, workspaceGuard],
    )
    if (!preflight) throw new Error('测试夹具缺少配置预检结果')
    /** 仍只存在内存、尚未写回的配置恢复值。 */
    const persistent = recoverPersistentJson(preflight, isWorkspaceConfig, targetGuard)
    persistent.value.attachedFiles = [join(targetRoot, 'file.txt')]
    renameSync(workspaceDir, replacedWorkspaceDir)
    mkdirSync(workspaceDir)
    writeJson(configPath, { attachedFiles: [] })

    expect(() => writePersistentJson(persistent, targetGuard))
      .toThrow('工作区配置目录被替换')
  })

  test('Given 恢复确认后主文件被替换为根外 symlink When 原子提交 Then 失败且根外字节不变', () => {
    /** 会话主文件路径。 */
    const sessionsPath = join(targetRoot, 'agent-sessions.json')
    /** 目标根外不可被写入的 sentinel。 */
    const sentinelPath = join(tempDir, 'late-sentinel.json')
    writeJson(sessionsPath, { version: 2, sessions: [createSession()] })
    writeJson(sentinelPath, { protected: true })
    /** 目标根和候选的预检身份。 */
    const targetGuard = validateDataRoots(sourceRoot, targetRoot)
    const preflight = preflightPersistentJson(sessionsPath, (value): value is Record<string, unknown> => (
      typeof value === 'object' && value !== null && !Array.isArray(value)
    ), targetGuard, [])
    if (!preflight) throw new Error('测试夹具缺少会话预检结果')
    /** 仍只存在内存、尚未写回的会话恢复值。 */
    const persistent = recoverPersistentJson(preflight, (value): value is Record<string, unknown> => (
      typeof value === 'object' && value !== null && !Array.isArray(value)
    ), targetGuard)
    persistent.value.marker = 'changed'
    /** 调用前 sentinel 原始字节。 */
    const originalSentinel = readFileSync(sentinelPath)
    renameSync(sessionsPath, `${sessionsPath}.replaced`)
    symlinkSync(sentinelPath, sessionsPath)

    expect(() => writePersistentJson(persistent, targetGuard)).toThrow('配置候选必须是普通文件')
    expect(readFileSync(sentinelPath).equals(originalSentinel)).toBe(true)
  })

  test('Given 恢复确认后候选同长度同mtime原地变更 When 原子提交 Then SHA校验失败且所有字节不变', () => {
    /** 待提交的 workspace config。 */
    const configPath = join(targetRoot, 'config.json')
    /** 固定 backup 候选。 */
    const backupPath = `${configPath}.bak`
    writeJson(configPath, { attachedFiles: [join(sourceRoot, 'a.txt')] })
    writeJson(backupPath, { attachedFiles: [join(sourceRoot, 'backup.txt')] })
    /** 文件系统可精确恢复的整秒固定时间。 */
    const fixedTime = new Date('2026-01-01T00:00:00.000Z')
    utimesSync(configPath, fixedTime, fixedTime)
    /** 预检时主文件的原始时间。 */
    const originalStat = statSync(configPath)
    /** 目标根和候选的预检身份。 */
    const targetGuard = validateDataRoots(sourceRoot, targetRoot)
    const preflight = preflightPersistentJson(configPath, isWorkspaceConfig, targetGuard, [])
    if (!preflight) throw new Error('测试夹具缺少配置预检结果')
    /** 仍只存在内存、尚未写回的配置恢复值。 */
    const persistent = recoverPersistentJson(preflight, isWorkspaceConfig, targetGuard)
    persistent.value.attachedFiles = [join(targetRoot, 'a.txt')]

    /** 与原文件等长但内容不同的 JSON 字节。 */
    const tampered = readFileSync(configPath, 'utf-8').replace('a.txt', 'b.txt')
    writeFileSync(configPath, tampered, 'utf-8')
    utimesSync(configPath, originalStat.atime, originalStat.mtime)
    /** 提交调用前主文件篡改字节。 */
    const tamperedBytes = readFileSync(configPath)
    /** 提交调用前 backup 原始字节。 */
    const originalBackup = readFileSync(backupPath)

    expect(() => writePersistentJson(persistent, targetGuard)).toThrow('内容 SHA-256')
    expect(readFileSync(configPath).equals(tamperedBytes)).toBe(true)
    expect(readFileSync(backupPath).equals(originalBackup)).toBe(true)
  })

  test('Given backup rename 后父目录 fsync 返回 EIO When 写回 Then 上层抛错且不提交 main', () => {
    /** 待提交的 workspace config。 */
    const configPath = join(targetRoot, 'config.json')
    writeJson(configPath, { attachedFiles: [join(sourceRoot, 'a.txt')] })
    /** 提交前 main 原始字节。 */
    const originalMain = readFileSync(configPath)
    /** 目标根和候选的预检身份。 */
    const targetGuard = validateDataRoots(sourceRoot, targetRoot)
    const preflight = preflightPersistentJson(configPath, isWorkspaceConfig, targetGuard, [])
    if (!preflight) throw new Error('测试夹具缺少配置预检结果')
    /** 仍只存在内存、尚未写回的配置恢复值。 */
    const persistent = recoverPersistentJson(preflight, isWorkspaceConfig, targetGuard)
    persistent.value.attachedFiles = [join(targetRoot, 'a.txt')]
    /** 必须由上层观察到的持久化错误。 */
    const ioError = createFileSystemError('EIO')

    expect(() => writePersistentJson(persistent, targetGuard, {
      fsyncParentDirectory: () => { throw ioError },
    })).toThrow(ioError)
    expect(readFileSync(configPath).equals(originalMain)).toBe(true)
  })

  test('Given sourceRoot 通过父目录 symlink 与 targetRoot 指向同一物理目录 When 重写 Then 拒绝物理别名', () => {
    /** 指向临时父目录的物理别名。 */
    const aliasParent = join(tempDir, 'alias-parent')
    symlinkSync(tempDir, aliasParent)
    /** 经父目录别名访问到目标根的 sourceRoot。 */
    const aliasedSourceRoot = join(aliasParent, 'target')

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot: aliasedSourceRoot, targetRoot }))
      .toThrow('必须不同')
  })

  test('Given workspace 配置候选是 symlink When 重写 Then 拒绝跟随', () => {
    /** 工作区目录。 */
    const workspaceDir = join(targetRoot, 'agent-workspaces', 'alpha')
    /** 目标根外的真实配置。 */
    const externalConfigPath = join(tempDir, 'external-config.json')
    mkdirSync(workspaceDir, { recursive: true })
    writeJson(join(targetRoot, 'agent-workspaces.json'), {
      version: 2,
      workspaces: [createWorkspace()],
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
      workspaces: [createWorkspace({ slug: '../../outside' })],
    })

    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot }))
      .toThrow('workspace slug 不符合生成合同')
  })

  test('Given 数据根相同、相对或嵌套 When 重写 Then 在 I/O 前拒绝', () => {
    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot: sourceRoot })).toThrow('必须不同')
    expect(() => rebaseDataRootOwnedPaths({ sourceRoot: 'relative-source', targetRoot })).toThrow('必须是绝对路径')
    expect(() => rebaseDataRootOwnedPaths({ sourceRoot, targetRoot: join(sourceRoot, 'nested') })).toThrow('不能互相嵌套')
  })
})
