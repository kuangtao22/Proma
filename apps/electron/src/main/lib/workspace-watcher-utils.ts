import { dirname } from 'node:path'

// 高频变动目录：跳过依赖、缓存和构建中间物，防止产生 IPC 事件风暴。
const HIGH_NOISE_SEGMENTS = new Set([
  'node_modules', '.next', '.nuxt', '.git', 'dist', 'build',
  '.cache', '__pycache__', '.turbo', '.parcel-cache', '.svelte-kit',
  '.venv', 'venv', '.tox', '.nox', '__pypackages__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis',
  '.gradle',
])

const GIT_DIFF_STATE_FILES = new Set([
  'HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'index',
])

export function isHighNoisePath(normalizedPath: string): boolean {
  return normalizedPath.split('/').some((seg) => HIGH_NOISE_SEGMENTS.has(seg))
}

/** fs.watch 在部分平台/事件上可能返回 Buffer 或 null。未知路径不触发刷新，避免绕过噪声过滤。 */
export function normalizeWatchFilename(filename: string | Buffer | null): string | null {
  if (typeof filename === 'string') return filename.replace(/\\/g, '/')
  if (Buffer.isBuffer(filename)) return filename.toString('utf8').replace(/\\/g, '/')
  return null
}

/**
 * 只有直接影响 `git diff HEAD` 结果的 Git 元数据才触发刷新。
 * 远端 fetch 产生的 FETCH_HEAD、refs/remotes 与 objects 均不在范围内，避免重现刷新循环。
 */
export function isGitDiffStatePath(normalizedPath: string): boolean {
  const segments = normalizedPath.split('/').filter(Boolean)
  const gitIndex = segments.lastIndexOf('.git')
  if (gitIndex < 0) return false
  const gitRelativePath = segments.slice(gitIndex + 1)
  return gitRelativePath.length === 1 && GIT_DIFF_STATE_FILES.has(gitRelativePath[0]!)
}

export function shouldNotifyForWatchFilename(filename: string | Buffer | null): boolean {
  const normalizedFilename = normalizeWatchFilename(filename)
  return normalizedFilename !== null && (!isHighNoisePath(normalizedFilename) || isGitDiffStatePath(normalizedFilename))
}

/** 输入相对 agent-workspaces 根目录；仅工作区顶层能力目录触发能力通知。 */
export function classifyWorkspaceWatchFilename(filename: string | Buffer | null): 'capabilities' | 'files' | null {
  const normalized = normalizeWatchFilename(filename)
  if (!normalized || !shouldNotifyForWatchFilename(normalized)) return null
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 2 && parts[1] === 'config.json') return null
  if ((parts.length === 2 && parts[1] === 'mcp.json')
    || parts[1] === 'skills' || parts[1] === 'skills-inactive') return 'capabilities'
  return 'files'
}

/** 启动恢复监听所需的索引输入：只取与监听范围相关的字段。 */
export interface WatcherRestoreIndex {
  /** 会话级附加目录与附加文件（只对该会话生效）。 */
  sessions: ReadonlyArray<{
    attachedDirectories?: readonly string[]
    attachedFiles?: readonly string[]
  }>
  /** 工作区级项目根、附加目录与附加文件（对该工作区所有会话生效）。 */
  workspaces: ReadonlyArray<{
    projectRootPath?: string
    attachedDirectories?: readonly string[]
    attachedFiles?: readonly string[]
  }>
}

/**
 * 计算启动时必须恢复监听的目录清单。
 *
 * 主进程监听器只在用户「添加/关联」的那一刻挂上，进程重启后必须按索引重建，否则
 * 关联目录会静默失去监听——历史缺陷正是工作区级附加目录没有恢复入口，导致重启后
 * 外部业务项目里的改动收不到任何事件（右侧文件列表不刷新、「本轮文件改动」永远空态）。
 * 三类来源缺一不可：
 * 1. 会话级附加目录，以及会话级附加文件所在目录；
 * 2. 工作区级附加目录，以及工作区级附加文件所在目录；
 * 3. 工作区项目根（本地目录项目）。
 *
 * @param index 当前会话与工作区索引；字段缺失按「无」处理。
 * @returns 去重后的目录清单，保持「会话 → 工作区」的发现顺序；空值被丢弃，目录是否
 *          存在交给 watchAttachedDirectory 自行降级为父目录监听。
 */
export function collectWatcherRestoreDirectories(index: WatcherRestoreIndex): string[] {
  /** 按发现顺序去重：`attachedWatchers` 以原始字符串为键，这里保持同样的判等口径。 */
  const directories: string[] = []
  const pushDirectory = (dirPath: string | undefined): void => {
    if (typeof dirPath !== 'string' || dirPath.length === 0) return
    if (directories.includes(dirPath)) return
    directories.push(dirPath)
  }

  for (const session of index.sessions) {
    for (const dirPath of session.attachedDirectories ?? []) pushDirectory(dirPath)
    for (const filePath of session.attachedFiles ?? []) pushDirectory(dirname(filePath))
  }

  for (const workspace of index.workspaces) {
    pushDirectory(workspace.projectRootPath)
    for (const dirPath of workspace.attachedDirectories ?? []) pushDirectory(dirPath)
    for (const filePath of workspace.attachedFiles ?? []) pushDirectory(dirname(filePath))
  }

  return directories
}
