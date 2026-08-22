import type {
  GitHubRelease,
  GitHubReleaseHistorySource,
  GitHubReleaseListOptions,
} from '@proma/shared'

/** 单个版本历史来源的独立界面状态。 */
export interface VersionHistorySourceState {
  /** 当前来源已获取的版本列表。 */
  releases: GitHubRelease[]
  /** 当前来源是否正在请求。 */
  loading: boolean
  /** 当前来源是否至少成功加载过一次。 */
  loaded: boolean
  /** 当前来源最近一次请求的错误。 */
  error: string | null
  /** 当前来源已展开的 Release ID。 */
  expandedIds: Set<number>
}

/** Bone 与官方版本历史的完整独立状态。 */
export interface VersionHistoryState {
  /** Proma 修改版本历史状态。 */
  bone: VersionHistorySourceState
  /** Proma 官方版本历史状态。 */
  official: VersionHistorySourceState
}

/** 版本历史状态机支持的操作。 */
export type VersionHistoryAction =
  | { type: 'load-start'; source: GitHubReleaseHistorySource }
  | { type: 'load-success'; source: GitHubReleaseHistorySource; releases: GitHubRelease[] }
  | { type: 'load-error'; source: GitHubReleaseHistorySource; error: string }
  | { type: 'toggle-expanded'; source: GitHubReleaseHistorySource; releaseId: number }

/** Electron Release 列表 API 的最小调用契约。 */
export interface VersionHistoryListReleases {
  (options?: GitHubReleaseListOptions): Promise<GitHubRelease[]>
}

/** 创建一个来源的空版本历史状态，确保 Set 不在来源之间共享。 */
function createInitialSourceState(): VersionHistorySourceState {
  return {
    releases: [],
    loading: false,
    loaded: false,
    error: null,
    expandedIds: new Set<number>(),
  }
}

/** 创建 Bone 与官方均未加载的初始版本历史状态。 */
export function createInitialVersionHistoryState(): VersionHistoryState {
  return {
    bone: createInitialSourceState(),
    official: createInitialSourceState(),
  }
}

/** 只更新动作指定的来源，保留另一来源的数据和展开状态。 */
export function reduceVersionHistoryState(
  state: VersionHistoryState,
  action: VersionHistoryAction,
): VersionHistoryState {
  /** 动作所指向来源的当前状态。 */
  const current = state[action.source]

  if (action.type === 'load-start') {
    return {
      ...state,
      [action.source]: { ...current, loading: true, error: null },
    }
  }

  if (action.type === 'load-success') {
    return {
      ...state,
      [action.source]: {
        ...current,
        releases: action.releases,
        loading: false,
        loaded: true,
        error: null,
      },
    }
  }

  if (action.type === 'load-error') {
    return {
      ...state,
      [action.source]: { ...current, loading: false, error: action.error },
    }
  }

  /** 切换后该来源的新展开集合。 */
  const expandedIds = new Set(current.expandedIds)
  if (expandedIds.has(action.releaseId)) {
    expandedIds.delete(action.releaseId)
  } else {
    expandedIds.add(action.releaseId)
  }

  return {
    ...state,
    [action.source]: { ...current, expandedIds },
  }
}

/** 去掉 Electron IPC 包装前缀，向用户保留实际错误原因。 */
export function sanitizeVersionHistoryError(error: unknown): string {
  /** Error 实例携带的原始错误文本。 */
  const rawMessage = error instanceof Error ? error.message : '加载失败'
  /** Electron IPC 错误包装中实际业务错误的匹配结果。 */
  const ipcPrefixMatch = rawMessage.match(/^Error invoking remote method .*?:\s*Error:\s*(.+)$/s)
  return ipcPrefixMatch?.[1]?.trim() || rawMessage
}

/** 判断来源是否需要加载；强制刷新仍会避开正在进行的请求。 */
export function shouldLoadVersionHistory(
  state: VersionHistorySourceState,
  force = false,
): boolean {
  return !state.loading && (force || !state.loaded)
}

/** 使用固定的历史页参数加载指定来源，未指定时默认加载 Bone。 */
export async function loadVersionHistory(
  source: GitHubReleaseHistorySource | undefined,
  listReleases: VersionHistoryListReleases,
): Promise<GitHubRelease[]> {
  return listReleases({
    source: source ?? 'bone',
    perPage: 3,
    includePrerelease: false,
  })
}
