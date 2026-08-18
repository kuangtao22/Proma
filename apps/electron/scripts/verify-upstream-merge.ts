import { spawnSync } from 'node:child_process'

/** merge 状态验证所需的只读 Git 查询边界。 */
export interface GitMergeQuery {
  /** 把 revision 解析为 commit；不存在时返回 undefined。 */
  resolveCommit: (revision: string) => string | undefined
  /** 判断 ancestor 是否为 descendant 的祖先。 */
  isAncestor: (ancestor: string, descendant: string) => boolean
}

/** 验证成功后的 merge 状态。 */
export interface UpstreamMergeVerification {
  /** pending 表示 merge 尚未提交，contained 表示 tag 已进入 HEAD 历史。 */
  mode: 'pending' | 'contained'
  /** 上游 tag 最终解析出的 commit。 */
  upstreamCommit: string
}

/** CLI 可注入的环境与错误输出边界。 */
export interface VerifyUpstreamMergeCliOptions {
  /** Workflow 传入的受信 namespaced tag ref。 */
  upstreamTagRef?: string
  /** 当前 Git 工作目录。 */
  cwd?: string
  /** 输出验证成功信息。 */
  log: (message: string) => void
  /** 输出明确失败原因。 */
  error: (message: string) => void
}

/** 执行只读 Git 命令并返回结果；非预期失败会抛出明确错误。 */
function runGitQuery(args: readonly string[], cwd: string, allowMissing: boolean): string | undefined {
  /** 当前只读 Git 子进程结果。 */
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error(`Git 查询启动失败：${result.error.message}`)
  if (result.status === 0) return result.stdout.trim()
  if (allowMissing && result.status === 1) return undefined
  /** Git stderr 中可供定位的失败文本。 */
  const detail = result.stderr.trim() || `退出码 ${result.status ?? 'unknown'}`
  throw new Error(`Git 查询失败（git ${args.join(' ')}）：${detail}`)
}

/** 创建仅允许 rev-parse 与 merge-base 查询的真实 Git 边界。 */
export function createGitMergeQuery(cwd = process.cwd()): GitMergeQuery {
  return {
    resolveCommit: (revision) => runGitQuery(
      ['rev-parse', '--verify', '--quiet', revision],
      cwd,
      true,
    ),
    isAncestor: (ancestor, descendant) => {
      /** merge-base 以退出码 1 表示合法的“不是祖先”。 */
      const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (result.error) throw new Error(`Git 查询启动失败：${result.error.message}`)
      if (result.status === 0) return true
      if (result.status === 1) return false
      /** 非关系判断退出码属于仓库或参数错误。 */
      const detail = result.stderr.trim() || `退出码 ${result.status ?? 'unknown'}`
      throw new Error(`Git 祖先关系查询失败：${detail}`)
    },
  }
}

/** 验证上游 tag 正处于待提交 merge，或已经被当前 HEAD 包含。 */
export function verifyUpstreamMerge(
  upstreamTagRef: string,
  git: GitMergeQuery,
): UpstreamMergeVerification {
  /** 上游 tag 必须先解析为稳定 commit，避免比较 annotated tag 对象。 */
  const upstreamCommit = git.resolveCommit(`${upstreamTagRef}^{commit}`)
  if (!upstreamCommit) throw new Error(`无法解析上游 tag ref：${upstreamTagRef}`)

  /** 未提交 merge 存在时，MERGE_HEAD 必须精确指向上游 tag commit。 */
  const mergeHeadCommit = git.resolveCommit('MERGE_HEAD^{commit}')
  if (mergeHeadCommit) {
    if (mergeHeadCommit !== upstreamCommit) {
      throw new Error(`MERGE_HEAD ${mergeHeadCommit} 与上游 tag commit ${upstreamCommit} 不一致`)
    }
    return { mode: 'pending', upstreamCommit }
  }

  if (git.isAncestor(upstreamTagRef, 'HEAD')) return { mode: 'contained', upstreamCommit }
  throw new Error(`既不存在匹配的 MERGE_HEAD，HEAD 也未包含上游 tag：${upstreamTagRef}`)
}

/** 执行 Workflow CLI，并把错误转换为非零退出码。 */
export function runVerifyUpstreamMergeCli(options: VerifyUpstreamMergeCliOptions): number {
  /** 去除意外空白后的 tag ref。 */
  const upstreamTagRef = options.upstreamTagRef?.trim()
  if (!upstreamTagRef) {
    options.error('上游 merge 验证失败：缺少 UPSTREAM_TAG_REF')
    return 1
  }

  try {
    /** 当前仓库的验证结果。 */
    const verification = verifyUpstreamMerge(
      upstreamTagRef,
      createGitMergeQuery(options.cwd),
    )
    options.log(`上游 merge 验证通过：${verification.mode} (${verification.upstreamCommit})`)
    return 0
  } catch (error) {
    options.error(`上游 merge 验证失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/** CLI 入口只读验证当前仓库，不修改 index、引用或工作树。 */
function main(): void {
  process.exitCode = runVerifyUpstreamMergeCli({
    upstreamTagRef: process.env.UPSTREAM_TAG_REF,
    log: console.log,
    error: console.error,
  })
}

if (import.meta.main) main()
