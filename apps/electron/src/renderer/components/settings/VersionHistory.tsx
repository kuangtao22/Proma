/**
 * VersionHistory - 版本历史组件
 *
 * 只展示本仓库（DutyDeck / Bone）的 GitHub Release 历史，不再列出上游 Proma 的版本：
 * 我们的内容基线与上游并不同步（版本号写着 0.19.53，完整合入的内容其实停在 0.19.31），
 * 两张列表并排会让用户误以为跟到了同一个进度。上游关系改在「关于」页用文字说明。
 */

import * as React from 'react'
import { RefreshCw, Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ReleaseNotesViewer } from './ReleaseNotesViewer'
import { SettingsCard } from './primitives'
import {
  createInitialVersionHistoryState,
  loadVersionHistory,
  reduceVersionHistoryState,
  sanitizeVersionHistoryError,
  shouldLoadVersionHistory,
} from './version-history-state'

/** 唯一的版本历史来源：本仓库自己的 Release。 */
const SOURCE = 'bone' as const

/**
 * VersionHistory 组件
 */
export function VersionHistory(): React.ReactElement {
  /** 版本历史状态（按来源分桶，这里只会用到 bone）。 */
  const [historyState, dispatch] = React.useReducer(
    reduceVersionHistoryState,
    undefined,
    createInitialVersionHistoryState,
  )
  /** 为稳定加载回调提供最新状态，避免错误后因依赖变化自动循环重试。 */
  const historyStateRef = React.useRef(historyState)
  historyStateRef.current = historyState
  /** 真实进行中的请求标记，抵御 StrictMode 与快速交互导致的重复请求。 */
  const inFlightRef = React.useRef(false)
  /** 当前来源（本仓库）的状态。 */
  const sourceState = historyState[SOURCE]

  /** 加载本仓库的 Release 历史；手动刷新可强制重试，但同时只允许一个请求。 */
  const loadReleases = React.useCallback(async (force = false): Promise<void> => {
    if (inFlightRef.current || !shouldLoadVersionHistory(historyStateRef.current[SOURCE], force)) {
      return
    }

    inFlightRef.current = true
    dispatch({ type: 'load-start', source: SOURCE })

    try {
      /** 本仓库最近三条稳定 Release。 */
      const releases = await loadVersionHistory(SOURCE, window.electronAPI.listReleases)
      dispatch({ type: 'load-success', source: SOURCE, releases })
    } catch (err) {
      console.error('[版本历史] 加载失败:', err)
      dispatch({ type: 'load-error', source: SOURCE, error: sanitizeVersionHistoryError(err) })
    } finally {
      inFlightRef.current = false
    }
  }, [])

  React.useEffect(() => {
    void loadReleases()
  }, [loadReleases])

  return (
    <SettingsCard>
      {/* 标题与刷新区 */}
      <div className="space-y-3 border-b p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">版本历史</h3>
          <button
            type="button"
            onClick={() => void loadReleases(true)}
            disabled={sourceState.loading}
            aria-label={sourceState.loading ? '正在刷新版本历史' : '刷新版本历史'}
            title={sourceState.loading ? '正在刷新' : '刷新版本历史'}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sourceState.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            刷新
          </button>
        </div>
      </div>

      {/* 版本列表 */}
      <div className="divide-y">
        {sourceState.loading && sourceState.releases.length === 0 ? (
          <div className="p-8 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-sm text-muted-foreground">加载中...</p>
          </div>
        ) : sourceState.error && sourceState.releases.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-muted-foreground">加载失败</p>
            <p className="mt-1 text-xs text-muted-foreground">{sourceState.error}</p>
          </div>
        ) : sourceState.releases.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-muted-foreground">暂无版本历史</p>
          </div>
        ) : (
          <>
            {sourceState.error && (
              <div className="px-4 py-3 text-xs text-muted-foreground" role="status">
                刷新失败：{sourceState.error}
              </div>
            )}
            {sourceState.releases.map((release, index) => {
              /** 当前 Release 是否已经展开。 */
              const isExpanded = sourceState.expandedIds.has(release.id)
              /** 第一条 Release 标记为最新。 */
              const isLatest = index === 0

              return (
                <div
                  key={release.id}
                  className={cn(
                    'transition-colors',
                    /** 展开中：常驻浅底，一眼看出哪一行是打开状态；否则只做 hover 高亮。 */
                    isExpanded ? 'bg-accent/20' : 'hover:bg-accent/40',
                  )}
                >
                  {/* 版本标题（整行可点击展开） */}
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'toggle-expanded', source: SOURCE, releaseId: release.id })}
                    aria-expanded={isExpanded}
                    title={isExpanded ? '收起版本说明' : '展开版本说明'}
                    className="flex w-full items-center justify-between gap-3 p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-sm font-medium">{release.tag_name}</span>
                          {isLatest && <span className="text-xs font-medium text-primary">最新</span>}
                        </div>
                        {release.name && release.name !== release.tag_name && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">{release.name}</p>
                        )}
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {new Date(release.published_at).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                    {isExpanded ? (
                      <ChevronUp className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                  </button>

                  {/* Release Notes（展开时显示） */}
                  {isExpanded && (
                    <div className="border-t border-border/60 px-4 pb-4 pt-4">
                      <ReleaseNotesViewer release={release} showHeader={false} compact />
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>
    </SettingsCard>
  )
}
