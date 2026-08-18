import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitMergeQuery } from './verify-upstream-merge'
import { createGitMergeQuery, verifyUpstreamMerge } from './verify-upstream-merge'

/** 创建只返回指定提交关系的 Git 查询替身。 */
function createGitQuery(
  revisions: Readonly<Record<string, string | undefined>>,
  ancestors: ReadonlySet<string> = new Set(),
): GitMergeQuery {
  return {
    resolveCommit: (revision) => revisions[revision],
    isAncestor: (ancestor, descendant) => ancestors.has(`${ancestor}\0${descendant}`),
  }
}

/** 在临时仓库执行 Git 命令，失败时保留完整诊断。 */
function runGit(cwd: string, args: readonly string[]): string {
  /** 当前 Git 子进程结果。 */
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

/** 创建 main 与上游 tag 分叉的真实临时 Git 仓库。 */
function createDivergedRepository(): string {
  /** 当前测试独享的临时仓库。 */
  const repository = mkdtempSync(join(tmpdir(), 'proma-upstream-merge-'))
  runGit(repository, ['init'])
  runGit(repository, ['config', 'user.name', 'Proma Test'])
  runGit(repository, ['config', 'user.email', 'proma-test@example.invalid'])
  runGit(repository, ['commit', '--allow-empty', '-m', 'base'])
  runGit(repository, ['branch', '-M', 'main'])
  runGit(repository, ['switch', '-c', 'upstream'])
  runGit(repository, ['commit', '--allow-empty', '-m', 'upstream'])
  runGit(repository, ['tag', 'upstream/v1.2.3'])
  runGit(repository, ['switch', 'main'])
  return repository
}

describe('上游 merge 状态验证', () => {
  test('Given MERGE_HEAD 对应上游 tag When 验证未提交 merge Then 接受 pending 状态', () => {
    /** 未提交 merge 中 tag 与 MERGE_HEAD 解析出的同一提交。 */
    const git = createGitQuery({
      'refs/tags/upstream/v1.2.3^{commit}': 'upstream-sha',
      'MERGE_HEAD^{commit}': 'upstream-sha',
    })

    expect(verifyUpstreamMerge('refs/tags/upstream/v1.2.3', git)).toEqual({
      mode: 'pending',
      upstreamCommit: 'upstream-sha',
    })
  })

  test('Given 不存在 MERGE_HEAD 且 tag 已包含 When 验证 merge Then 接受 contained 状态', () => {
    /** 已完成或无需 merge 时，仅通过祖先关系证明包含。 */
    const git = createGitQuery(
      {
        'refs/tags/upstream/v1.2.3^{commit}': 'upstream-sha',
        'MERGE_HEAD^{commit}': undefined,
      },
      new Set(['refs/tags/upstream/v1.2.3\0HEAD']),
    )

    expect(verifyUpstreamMerge('refs/tags/upstream/v1.2.3', git)).toEqual({
      mode: 'contained',
      upstreamCommit: 'upstream-sha',
    })
  })

  test('Given MERGE_HEAD 与 tag 不一致 When 验证 merge Then 明确拒绝', () => {
    /** 攻击或错误 merge 指向了另一个提交。 */
    const git = createGitQuery({
      'refs/tags/upstream/v1.2.3^{commit}': 'upstream-sha',
      'MERGE_HEAD^{commit}': 'other-sha',
    })

    expect(() => verifyUpstreamMerge('refs/tags/upstream/v1.2.3', git)).toThrow('MERGE_HEAD')
  })

  test('Given 无 MERGE_HEAD 且 tag 未被 HEAD 包含 When 验证 merge Then 明确拒绝', () => {
    /** merge 既未处于进行态，也未进入当前历史。 */
    const git = createGitQuery({
      'refs/tags/upstream/v1.2.3^{commit}': 'upstream-sha',
      'MERGE_HEAD^{commit}': undefined,
    })

    expect(() => verifyUpstreamMerge('refs/tags/upstream/v1.2.3', git)).toThrow('既不存在匹配的 MERGE_HEAD')
  })

  test('Given tag ref 无法解析 When 验证 merge Then 明确拒绝', () => {
    /** 不存在或不是 commit 的 tag ref。 */
    const git = createGitQuery({})

    expect(() => verifyUpstreamMerge('refs/tags/upstream/v1.2.3', git)).toThrow('无法解析上游 tag ref')
  })

  test('Given 真实仓库存在新未提交 merge When 验证 Then 接受 pending 状态', () => {
    /** 上游 tag 尚未进入 HEAD，但 MERGE_HEAD 已准确记录待合并提交。 */
    const repository = createDivergedRepository()
    try {
      runGit(repository, ['merge', '--no-commit', '--no-ff', 'refs/tags/upstream/v1.2.3'])

      expect(verifyUpstreamMerge(
        'refs/tags/upstream/v1.2.3',
        createGitMergeQuery(repository),
      ).mode).toBe('pending')
    } finally {
      rmSync(repository, { recursive: true, force: true })
    }
  })

  test('Given 真实仓库已合并上游 tag When 验证 Then 接受 contained 状态', () => {
    /** merge commit 已提交，因此不存在 MERGE_HEAD 且 tag 是 HEAD 祖先。 */
    const repository = createDivergedRepository()
    try {
      runGit(repository, ['merge', '--no-edit', '--no-ff', 'refs/tags/upstream/v1.2.3'])

      expect(verifyUpstreamMerge(
        'refs/tags/upstream/v1.2.3',
        createGitMergeQuery(repository),
      ).mode).toBe('contained')
    } finally {
      rmSync(repository, { recursive: true, force: true })
    }
  })

  test('Given 真实仓库既未开始也未完成 merge When 验证 Then 拒绝 invalid 状态', () => {
    /** main 仍停留在分叉点，不存在可接受的 merge 状态。 */
    const repository = createDivergedRepository()
    try {
      expect(() => verifyUpstreamMerge(
        'refs/tags/upstream/v1.2.3',
        createGitMergeQuery(repository),
      )).toThrow('既不存在匹配的 MERGE_HEAD')
    } finally {
      rmSync(repository, { recursive: true, force: true })
    }
  })
})
