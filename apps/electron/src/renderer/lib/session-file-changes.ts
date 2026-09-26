function normalizePath(path: string, caseInsensitive: boolean): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

export function arePathsEqual(leftPath: string, rightPath: string, caseInsensitive = false): boolean {
  return normalizePath(leftPath, caseInsensitive) === normalizePath(rightPath, caseInsensitive)
}

export function isPathWithinRoot(rootPath: string, targetPath: string, caseInsensitive = false): boolean {
  const root = normalizePath(rootPath, caseInsensitive)
  const target = normalizePath(targetPath, caseInsensitive)
  return target === root || target.startsWith(`${root}/`)
}

export interface SessionWatcherOwnershipScope {
  sessionExists: boolean
  sessionPath?: string
  sessionAttachedDirectories: readonly string[]
  sessionAttachedFiles: readonly string[]
  workspaceAttachmentsComplete: boolean
  workspaceFilesPath?: string | null
  /**
   * 工作区绑定的本地项目根。
   * 会话直接在项目根工作时（用户本地仓库），改动路径必须能归属到该会话，
   * 否则监听器事件会因为没有匹配根而被整体丢弃。
   */
  workspaceProjectRootPath?: string | null
  workspaceAttachedDirectories: readonly string[]
  workspaceAttachedFiles: readonly string[]
}

/** 单个改动路径的归属命中。 */
export interface SessionWatcherPathMatch {
  /** 命中的改动路径。 */
  path: string
  /**
   * 命中的受管根。
   * 附加文件命中时取「其所在目录」：共享根场景下的证据判据要求证据严格深于该根，
   * 用所在目录才能让「证据就是该文件本身」成立。
   */
  root: string
}

/** 取父目录；仅用于渲染进程字符串处理，不依赖 node:path。 */
function getParentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '' : normalized.slice(0, index)
}

/**
 * 返回改动路径与「命中的受管根」的配对。
 *
 * 与 [[getOwnedSessionWatcherPaths]] 同一套作用域判据，额外把命中的根带出来：当一个
 * 改动路径同时落在多个运行中会话的根里（工作区级附加目录/项目根是该工作区所有会话
 * 共享的），调用方需要用根信息判断活动证据是否比共享根更具体。
 *
 * @param changedPaths 监听器上报的改动路径。
 * @param scope 目标会话的受管作用域。
 * @param caseInsensitive 是否按大小写不敏感比较（Windows 为 true）。
 * @returns 按改动路径顺序排列的命中列表；同一路径只保留首个命中的根。
 */
export function getOwnedSessionWatcherPathMatches(
  changedPaths: readonly string[],
  scope: SessionWatcherOwnershipScope,
  caseInsensitive = false,
): SessionWatcherPathMatch[] {
  if (!scope.sessionExists) return []

  const directoryRoots = [
    scope.sessionPath,
    ...scope.sessionAttachedDirectories,
  ]
  const attachedFiles = [...scope.sessionAttachedFiles]

  if (scope.workspaceAttachmentsComplete) {
    directoryRoots.push(
      scope.workspaceFilesPath ?? undefined,
      scope.workspaceProjectRootPath ?? undefined,
      ...scope.workspaceAttachedDirectories,
    )
    attachedFiles.push(...scope.workspaceAttachedFiles)
  }

  const matches: SessionWatcherPathMatch[] = []
  for (const changedPath of changedPaths) {
    const matchedRoot = directoryRoots.find((rootPath) => (
      typeof rootPath === 'string'
      && rootPath.length > 0
      && isPathWithinRoot(rootPath, changedPath, caseInsensitive)
    ))
    if (matchedRoot) {
      matches.push({ path: changedPath, root: matchedRoot })
      continue
    }

    const matchedFile = attachedFiles.find((filePath) => arePathsEqual(filePath, changedPath, caseInsensitive))
    if (matchedFile) {
      matches.push({ path: changedPath, root: getParentDirectory(matchedFile) || matchedFile })
    }
  }
  return matches
}

/** Returns watcher paths that can be attributed from the available session scope. */
export function getOwnedSessionWatcherPaths(
  changedPaths: readonly string[],
  scope: SessionWatcherOwnershipScope,
  caseInsensitive = false,
): string[] {
  return getOwnedSessionWatcherPathMatches(changedPaths, scope, caseInsensitive)
    .map((match) => match.path)
}

export type SessionFileChangeKind = "created" | "edited";

export interface SessionFileChange {
  path: string;
  kind: SessionFileChangeKind;
  runId: string;
  updatedAt: number;
}

export function getSessionFileChangeKind(
  toolName: string,
  existedBefore: boolean | undefined,
): SessionFileChangeKind {
  if (toolName === "Write" && existedBefore === false) return "created";
  return "edited";
}

export function upsertSessionFileChange(
  changes: readonly SessionFileChange[],
  next: SessionFileChange,
  caseInsensitive = false,
): SessionFileChange[] {
  const index = changes.findIndex((change) => arePathsEqual(change.path, next.path, caseInsensitive));
  if (index < 0) return [next, ...changes];

  const current = changes[index]!;
  const updated = {
    ...next,
    // A file created in this session should remain visibly new after later edits.
    kind: current.kind === "created" ? "created" : next.kind,
  };
  return changes.map((change, changeIndex) =>
    changeIndex === index ? updated : change,
  );
}

export function removeSessionFileChange(
  changes: readonly SessionFileChange[],
  path: string,
  caseInsensitive = false,
): SessionFileChange[] {
  return changes.filter((change) => !arePathsEqual(change.path, path, caseInsensitive));
}

/**
 * Returns tracked file paths touched by a watcher event for sessions that are
 * no longer running. Running sessions are handled by the normal watcher path,
 * while stopped sessions need their stale records pruned explicitly.
 */
export function getInactiveSessionFileChangePaths(
  changesBySession: ReadonlyMap<string, readonly SessionFileChange[]>,
  changedPaths: readonly string[],
  activeSessionIds: ReadonlySet<string>,
  caseInsensitive = false,
): string[] {
  const matching: string[] = []
  for (const [sessionId, changes] of changesBySession) {
    if (activeSessionIds.has(sessionId)) continue
    for (const change of changes) {
      if (
        changedPaths.some((changedPath) => arePathsEqual(change.path, changedPath, caseInsensitive))
        && !matching.some((path) => arePathsEqual(path, change.path, caseInsensitive))
      ) {
        matching.push(change.path)
      }
    }
  }
  return matching
}

export function groupSessionFileChanges(
  changes: readonly SessionFileChange[],
  currentRunId: string | undefined,
): { current: SessionFileChange[]; earlier: SessionFileChange[] } {
  if (!currentRunId) return { current: [...changes], earlier: [] };
  return {
    current: changes.filter((change) => change.runId === currentRunId),
    earlier: changes.filter((change) => change.runId !== currentRunId),
  };
}
