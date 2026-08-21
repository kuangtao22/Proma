import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
