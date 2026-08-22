/**
 * VersionHistory - 版本历史组件
 *
 * 显示 GitHub Release 历史版本列表
 */

import * as React from 'react'
import type { GitHubReleaseHistorySource } from '@proma/shared'
import { RefreshCw, Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ReleaseNotesViewer } from './ReleaseNotesViewer'
import { SettingsCard } from './primitives'
import {
  createInitialVersionHistoryState,
  loadVersionHistory,
  reduceVersionHistoryState,
  sanitizeVersionHistoryError,
  shouldLoadVersionHistory,
} from './version-history-state'

/** 版本历史来源的稳定渲染顺序。 */
const VERSION_HISTORY_SOURCES: GitHubReleaseHistorySource[] = ['bone', 'official']

/** 版本历史标签对应的用户可见名称。 */
const VERSION_HISTORY_LABELS: Record<GitHubReleaseHistorySource, string> = {
  bone: 'Proma 修改',
  official: '官方版本',
}

/**
 * VersionHistory 组件
 */
export function VersionHistory(): React.ReactElement {
  /** 当前显示的版本历史来源，默认只展示并加载 Bone。 */
  const [activeSource, setActiveSource] = React.useState<GitHubReleaseHistorySource>('bone')
  /** Bone 与官方版本历史各自独立的状态。 */
  const [historyState, dispatch] = React.useReducer(
    reduceVersionHistoryState,
    undefined,
    createInitialVersionHistoryState,
  )
  /** 为稳定加载回调提供最新状态，避免错误后因依赖变化自动循环重试。 */
  const historyStateRef = React.useRef(historyState)
  historyStateRef.current = historyState
  /** 按来源记录真实进行中的 Promise，抵御 StrictMode 与快速交互重复请求。 */
  const inFlightRef = React.useRef<Record<GitHubReleaseHistorySource, boolean>>({
    bone: false,
    official: false,
  })

  /** 加载指定来源；手动刷新可强制重试，但同来源同时只允许一个请求。 */
  const loadReleases = React.useCallback(async (
    source: GitHubReleaseHistorySource,
    force = false,
  ): Promise<void> => {
    /** 请求开始前该来源的最新状态。 */
    const sourceState = historyStateRef.current[source]
    if (inFlightRef.current[source] || !shouldLoadVersionHistory(sourceState, force)) {
      return
    }

    inFlightRef.current[source] = true
    dispatch({ type: 'load-start', source })

    try {
      /** 当前来源最近三条稳定 Release。 */
      const releases = await loadVersionHistory(source, window.electronAPI.listReleases)
      dispatch({ type: 'load-success', source, releases })
    } catch (err) {
      console.error('[版本历史] 加载失败:', err)
      dispatch({ type: 'load-error', source, error: sanitizeVersionHistoryError(err) })
    } finally {
      inFlightRef.current[source] = false
    }
  }, [])

  /** 首次仅加载 Bone；切换到未成功加载或曾失败的来源时再请求。 */
  React.useEffect(() => {
    void loadReleases(activeSource)
  }, [activeSource, loadReleases])

  return (
    <SettingsCard>
      <Tabs
        value={activeSource}
        onValueChange={(value) => setActiveSource(value as GitHubReleaseHistorySource)}
        className="w-full min-w-0"
      >
        {/* 标题与来源切换区 */}
        <div className="space-y-3 border-b p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">版本历史</h3>
            <button
              type="button"
              onClick={() => void loadReleases(activeSource, true)}
              disabled={historyState[activeSource].loading}
              aria-label={historyState[activeSource].loading ? '正在刷新当前版本历史' : '刷新当前版本历史'}
              title={historyState[activeSource].loading ? '正在刷新' : '刷新当前版本历史'}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {historyState[activeSource].loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              刷新
            </button>
          </div>
          <TabsList
            aria-label="版本历史来源"
            className="grid w-full grid-cols-2 sm:w-auto sm:min-w-64"
          >
            {VERSION_HISTORY_SOURCES.map((source) => (
              <TabsTrigger key={source} value={source} className="min-w-0 px-2 text-xs sm:px-3">
                {VERSION_HISTORY_LABELS[source]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {VERSION_HISTORY_SOURCES.map((source) => {
          /** 当前标签独立保存的列表、加载、错误和展开状态。 */
          const sourceState = historyState[source]
          return (
            <TabsContent key={source} value={source} className="mt-0">
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
                      /** 当前来源第一条 Release 是否标记为最新。 */
                      const isLatest = index === 0

                      return (
                        <div key={release.id} className="p-4">
                          {/* 版本标题（可点击展开） */}
                          <button
                            type="button"
                            onClick={() => dispatch({ type: 'toggle-expanded', source, releaseId: release.id })}
                            aria-expanded={isExpanded}
                            title={isExpanded ? '收起版本说明' : '展开版本说明'}
                            className="-m-4 flex w-full items-center justify-between rounded-lg p-4 text-left transition-colors hover:bg-accent/50"
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="truncate font-mono text-sm font-medium">
                                    {release.tag_name}
                                  </span>
                                  {isLatest && (
                                    <span className="text-xs font-medium text-primary">最新</span>
                                  )}
                                </div>
                                {release.name && release.name !== release.tag_name && (
                                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                    {release.name}
                                  </p>
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
                            <div className="mt-4 border-t pt-4">
                              <ReleaseNotesViewer release={release} showHeader={false} compact />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </>
                )}
              </div>
            </TabsContent>
          )
        })}
      </Tabs>
    </SettingsCard>
  )
}
