import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getUnstagedChanges, invalidateGitDiffCache, listWorktreesStrict } from './git-diff-service'

let repoPath = ''

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
}

function createRepository(prefix: string, fileName: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init'], { cwd: path, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'test@proma.local'], { cwd: path, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Proma Test'], { cwd: path, stdio: 'pipe' })
  writeFileSync(join(path, fileName), 'base\n')
  execFileSync('git', ['add', fileName], { cwd: path, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: path, stdio: 'pipe' })
  return path
}

beforeEach(() => {
  repoPath = createRepository('proma-git-diff-', 'tracked.txt')
})

afterEach(() => {
  invalidateGitDiffCache(repoPath)
  rmSync(repoPath, { recursive: true, force: true })
})

describe('git diff scan cache', () => {
  test('deduplicates concurrent scans and returns the cached snapshot until invalidated', async () => {
    const trackedPath = join(repoPath, 'tracked.txt')
    writeFileSync(trackedPath, 'base\nfirst\n')

    const results = await Promise.all(Array.from({ length: 8 }, () => getUnstagedChanges(repoPath)))
    expect(results.every((result) => result.files[0]?.additions === 1)).toBe(true)

    writeFileSync(trackedPath, 'base\nfirst\nsecond\n')
    const cached = await getUnstagedChanges(repoPath)
    expect(cached.files[0]?.additions).toBe(1)

    invalidateGitDiffCache(trackedPath)
    const refreshed = await getUnstagedChanges(repoPath)
    expect(refreshed.files[0]?.additions).toBe(2)
  })

  test('refreshes a linked worktree when its symbolic HEAD ref changes outside the watcher', async () => {
    const linkedParentPath = mkdtempSync(join(tmpdir(), 'proma-git-diff-linked-parent-'))
    const linkedWorktreePath = join(linkedParentPath, 'linked')
    try {
      execFileSync('git', ['worktree', 'add', '-b', 'linked-cache-test', linkedWorktreePath], { cwd: repoPath, stdio: 'pipe' })
      const linkedFile = join(linkedWorktreePath, 'tracked.txt')
      writeFileSync(linkedFile, 'base\ncommitted from linked worktree\n')
      execFileSync('git', ['add', 'tracked.txt'], { cwd: linkedWorktreePath, stdio: 'pipe' })
      execFileSync('git', ['commit', '-m', 'commit from linked worktree'], { cwd: linkedWorktreePath, stdio: 'pipe' })
      writeFileSync(linkedFile, 'base\ncommitted from linked worktree\nuncommitted\n')

      const cached = await getUnstagedChanges(linkedWorktreePath)
      expect(cached.files[0]?.additions).toBe(1)

      // 只移动 common git-dir 中的 branch ref，不改 linked worktree 的 HEAD 或 index。
      execFileSync('git', ['update-ref', 'refs/heads/linked-cache-test', 'HEAD~1'], { cwd: linkedWorktreePath, stdio: 'pipe' })

      const refreshed = await getUnstagedChanges(linkedWorktreePath)
      expect(refreshed.files[0]?.additions).toBe(2)
    } finally {
      invalidateGitDiffCache(linkedWorktreePath)
      execFileSync('git', ['worktree', 'remove', '--force', linkedWorktreePath], { cwd: repoPath, stdio: 'pipe' })
      rmSync(linkedParentPath, { recursive: true, force: true })
    }
  })

  test('keeps another repository cache valid after targeted invalidation', async () => {
    const secondRepo = createRepository('proma-git-diff-second-', 'other.txt')
    try {
      writeFileSync(join(repoPath, 'tracked.txt'), 'base\nfirst\n')
      writeFileSync(join(secondRepo, 'other.txt'), 'base\nfirst\n')
      const [, before] = await Promise.all([getUnstagedChanges(repoPath), getUnstagedChanges(secondRepo)])
      expect(before.files[0]?.additions).toBe(1)

      writeFileSync(join(repoPath, 'tracked.txt'), 'base\nfirst\nsecond\n')
      writeFileSync(join(secondRepo, 'other.txt'), 'base\nfirst\nsecond\n')
      invalidateGitDiffCache(join(repoPath, 'tracked.txt'))
      const [, after] = await Promise.all([getUnstagedChanges(repoPath), getUnstagedChanges(secondRepo)])

      expect(after.files[0]?.additions).toBe(1)

      invalidateGitDiffCache(join(secondRepo, 'other.txt'))
      const refreshedSecond = await getUnstagedChanges(secondRepo)
      expect(refreshedSecond.files[0]?.additions).toBe(2)
    } finally {
      invalidateGitDiffCache(secondRepo)
      rmSync(secondRepo, { recursive: true, force: true })
    }
  })
})

describe('strict worktree query', () => {
  test('Given 普通非 Git 目录 When 严格查询 worktree Then 安全返回空数组', async () => {
    const nonGitPath = mkdtempSync(join(tmpdir(), 'proma-non-git-'))
    try {
      await expect(listWorktreesStrict(nonGitPath)).resolves.toEqual([])
    } finally {
      rmSync(nonGitPath, { recursive: true, force: true })
    }
  })

  test('Given 主仓库含 linked worktree When 分别从主仓库和 linked 查询 Then 都返回正确主从身份', async () => {
    const linkedParentPath = mkdtempSync(join(tmpdir(), 'proma-strict-worktree-'))
    const linkedWorktreePath = join(linkedParentPath, 'linked')
    try {
      execFileSync('git', ['worktree', 'add', '-b', 'strict-linked-test', linkedWorktreePath], { cwd: repoPath, stdio: 'pipe' })

      const fromMain = await listWorktreesStrict(repoPath)
      const fromLinked = await listWorktreesStrict(linkedWorktreePath)
      const expectedMain = realpathSync(repoPath)
      const expectedLinked = realpathSync(linkedWorktreePath)

      expect(fromMain.find((item) => realpathSync(item.path) === expectedMain)?.isMain).toBe(true)
      expect(fromMain.find((item) => realpathSync(item.path) === expectedLinked)?.isMain).toBe(false)
      expect(fromLinked.find((item) => realpathSync(item.path) === expectedMain)?.isMain).toBe(true)
      expect(fromLinked.find((item) => realpathSync(item.path) === expectedLinked)?.isMain).toBe(false)
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', linkedWorktreePath], { cwd: repoPath, stdio: 'pipe' })
      rmSync(linkedParentPath, { recursive: true, force: true })
    }
  })

  test('Given 非 Git 父目录包含带 linked worktree 的嵌套仓库 When 严格查询 Then 仍返回 linked blocker', async () => {
    /** 非 Git 容器、嵌套仓库和容器外 linked worktree。 */
    const parentPath = mkdtempSync(join(tmpdir(), 'proma-strict-multi-root-'))
    const nestedRepoPath = join(parentPath, 'nested-repo')
    const linkedParentPath = mkdtempSync(join(tmpdir(), 'proma-strict-multi-linked-'))
    const linkedWorktreePath = join(linkedParentPath, 'linked')
    mkdirSync(nestedRepoPath)
    initializeRepository(nestedRepoPath, 'nested.txt')
    try {
      execFileSync('git', ['worktree', 'add', '-b', 'strict-multi-linked', linkedWorktreePath], {
        cwd: nestedRepoPath,
        stdio: 'pipe',
      })

      const worktrees = await listWorktreesStrict(parentPath)

      expect(worktrees.find((item) => realpathSync(item.path) === realpathSync(linkedWorktreePath))?.isMain).toBe(false)
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', linkedWorktreePath], { cwd: nestedRepoPath, stdio: 'pipe' })
      rmSync(parentPath, { recursive: true, force: true })
      rmSync(linkedParentPath, { recursive: true, force: true })
    }
  })

  test.each([
    ['断链', (parentPath: string) => symlinkSync(join(parentPath, 'missing-target'), join(parentPath, 'dangling'))],
    ['指向根外仓库', (parentPath: string, outsideRepoPath: string) => symlinkSync(outsideRepoPath, join(parentPath, 'outside-repo'))],
  ])('Given 非 Git 父目录含%s目录 symlink When 严格发现 Then 不跟随且返回空数组', async (_label, createLink) => {
    /** 隔离扫描根与根外真实仓库。 */
    const parentPath = mkdtempSync(join(tmpdir(), 'proma-strict-symlink-root-'))
    const outsideRepoPath = mkdtempSync(join(tmpdir(), 'proma-strict-symlink-outside-'))
    initializeRepository(outsideRepoPath, 'outside.txt')
    try {
      createLink(parentPath, outsideRepoPath)

      await expect(listWorktreesStrict(parentPath)).resolves.toEqual([])
    } finally {
      rmSync(parentPath, { recursive: true, force: true })
      rmSync(outsideRepoPath, { recursive: true, force: true })
    }
  })

  test('Given 五层以上目录内仓库含 linked worktree When 严格发现 Then 返回 linked blocker', async () => {
    /** 深层扫描根、仓库和根外 linked worktree。 */
    const parentPath = mkdtempSync(join(tmpdir(), 'proma-strict-deep-root-'))
    const nestedRepoPath = join(parentPath, 'one', 'two', 'three', 'four', 'five', 'repo')
    const linkedParentPath = mkdtempSync(join(tmpdir(), 'proma-strict-deep-linked-'))
    const linkedWorktreePath = join(linkedParentPath, 'linked')
    mkdirSync(nestedRepoPath, { recursive: true })
    initializeRepository(nestedRepoPath, 'deep.txt')
    try {
      execFileSync('git', ['worktree', 'add', '-b', 'strict-deep-linked', linkedWorktreePath], {
        cwd: nestedRepoPath,
        stdio: 'pipe',
      })

      const worktrees = await listWorktreesStrict(parentPath)

      expect(worktrees.find((item) => realpathSync(item.path) === realpathSync(linkedWorktreePath))?.isMain).toBe(false)
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', linkedWorktreePath], { cwd: nestedRepoPath, stdio: 'pipe' })
      rmSync(parentPath, { recursive: true, force: true })
      rmSync(linkedParentPath, { recursive: true, force: true })
    }
  })

  test('Given 非 Git 目录扫描条目超过预算 When 严格发现 Then 明确阻断', async () => {
    /** 两个条目确保一条预算无法完成扫描。 */
    const parentPath = mkdtempSync(join(tmpdir(), 'proma-strict-budget-'))
    mkdirSync(join(parentPath, 'first'))
    mkdirSync(join(parentPath, 'second'))
    try {
      await expect(listWorktreesStrict(parentPath, { maxDiscoveryEntries: 1 })).rejects.toThrow('预算')
    } finally {
      rmSync(parentPath, { recursive: true, force: true })
    }
  })

  test('Given 扫描子目录不可读 When 严格发现 Then I/O 错误向上传播', async () => {
    /** chmod 000 稳定触发真实目录读取失败。 */
    const parentPath = mkdtempSync(join(tmpdir(), 'proma-strict-io-'))
    const unreadablePath = join(parentPath, 'unreadable')
    mkdirSync(unreadablePath)
    chmodSync(unreadablePath, 0o000)
    try {
      await expect(listWorktreesStrict(parentPath)).rejects.toThrow()
    } finally {
      chmodSync(unreadablePath, 0o700)
      rmSync(parentPath, { recursive: true, force: true })
    }
  })

  test.each([
    ['prunable linked', join(tmpdir(), 'proma-prunable-linked'), 'prunable gitdir file points to non-existent location'],
    ['missing linked', join(tmpdir(), 'proma-missing-linked'), ''],
  ])('Given porcelain 含 %s record When 严格查询 Then 保留为 linked blocker', async (_label, linkedPath, stateLine) => {
    /** 生成包含主记录与异常 linked 注册项的固定 porcelain。 */
    const porcelain = [
      `worktree ${realpathSync(repoPath)}\nHEAD 1234567890abcdef\nbranch refs/heads/main`,
      `worktree ${linkedPath}\nHEAD abcdef1234567890\nbranch refs/heads/stale${stateLine ? `\n${stateLine}` : ''}`,
    ].join('\n\n')
    const runGitCommand = async (args: string[]): Promise<string> => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true'
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return realpathSync(repoPath)
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return join(realpathSync(repoPath), '.git')
      if (args[0] === 'worktree') return porcelain
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    }

    const worktrees = await listWorktreesStrict(repoPath, { runGitCommand })

    expect(worktrees.find((item) => item.path === linkedPath)?.isMain).toBe(false)
  })

  test('Given 已确认 Git 仓库但 worktree 命令失败 When 严格查询 Then 向上传播错误', async () => {
    /** 只在 worktree list 阶段注入失败，其余发现命令返回真实合同值。 */
    const runGitCommand = async (args: string[]): Promise<string> => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true'
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return realpathSync(repoPath)
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return join(realpathSync(repoPath), '.git')
      throw new Error('forced worktree failure')
    }

    await expect(listWorktreesStrict(repoPath, { runGitCommand })).rejects.toThrow('forced worktree failure')
  })
})

/** 在指定已有目录初始化带首个提交的最小 Git 仓库。 */
function initializeRepository(repositoryPath: string, fileName: string): void {
  execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'test@proma.local'], { cwd: repositoryPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Proma Test'], { cwd: repositoryPath, stdio: 'pipe' })
  writeFileSync(join(repositoryPath, fileName), 'base\n')
  execFileSync('git', ['add', fileName], { cwd: repositoryPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repositoryPath, stdio: 'pipe' })
}
