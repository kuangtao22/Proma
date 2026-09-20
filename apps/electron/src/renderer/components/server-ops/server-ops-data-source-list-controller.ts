import type { ServerOpsDataSource } from '@proma/shared'
import type { ServerOpsDataPanelApi } from './ServerOpsDataServicesPanel'

/** 数据源列表加载状态。 */
export type ServerOpsDataSourcesStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 数据源列表公开投影。 */
export interface ServerOpsDataSourcesProjection {
  status: ServerOpsDataSourcesStatus
  sources: ServerOpsDataSource[]
  error: string | null
}

/** 控制器依赖。 */
export interface ServerOpsDataSourceListControllerOptions {
  /** 只读列表能力；由工作区注入 preload bridge。 */
  api: Pick<ServerOpsDataPanelApi, 'listServerOpsDataSources'>
  /** 从共享 atom 读取最新连接，避免另一个 Pane 的新增被旧投影覆盖。 */
  getSources?: () => ServerOpsDataSource[]
  publish: (projection: ServerOpsDataSourcesProjection) => void
}

/** 数据源列表控制器。 */
export interface ServerOpsDataSourceListController {
  getProjection(): ServerOpsDataSourcesProjection
  activate(): void
  dispose(): void
  refresh(): void
  /** 合并主进程保存回执，让新连接不依赖额外列表请求即可使用。 */
  acceptSavedSource(source: ServerOpsDataSource): void
}

/** 创建初始投影。 */
export function createServerOpsDataSourcesIdleProjection(): ServerOpsDataSourcesProjection {
  return { status: 'idle', sources: [], error: null }
}

/**
 * 创建数据源列表控制器。
 *
 * 一次加载全量数据源，项目过滤在渲染层完成：切项目只是重新过滤已有列表，
 * 不必每次发请求，也不会因为切项目产生请求竞态。
 *
 * @param options 列表数据源与投影发布边界
 * @returns 可独立测试的控制器
 */
export function createServerOpsDataSourceListController(
  options: ServerOpsDataSourceListControllerOptions,
): ServerOpsDataSourceListController {
  /** 当前 owner 是否仍然有效。 */
  let ownerActive = false
  /** 请求代次。 */
  let revision = 0
  /** 当前公开投影。 */
  let projection = createServerOpsDataSourcesIdleProjection()

  /** 只向仍活跃的 owner 发布不可变投影。 */
  const publish = (next: ServerOpsDataSourcesProjection): void => {
    projection = next
    if (ownerActive) options.publish(next)
  }
  /** 权威共享引用；独立使用控制器时保持原有本地投影行为。 */
  const getCurrentSources = (): ServerOpsDataSource[] => options.getSources?.() ?? projection.sources

  return {
    getProjection: () => projection,

    activate(): void {
      ownerActive = true
      revision += 1
      publish({ ...projection, sources: getCurrentSources(), status: 'idle', error: null })
      this.refresh()
    },

    dispose(): void {
      ownerActive = false
      revision += 1
    },

    acceptSavedSource(source): void {
      if (!ownerActive) return
      revision += 1
      /** 合并时以最新共享列表为准，保留其他 Pane 的连接。 */
      const sources = getCurrentSources()
      publish({
        status: 'ready', error: null,
        sources: sources.some((entry) => entry.id === source.id)
          ? sources.map((entry) => entry.id === source.id ? source : entry)
          : [...sources, source],
      })
    },

    refresh(): void {
      if (!ownerActive) return
      /** 本次请求独占的代次。 */
      const operationRevision = ++revision
      /** 记录读取起点；期间发生的其他 Pane 保存优先于旧列表回执。 */
      const sourcesAtStart = getCurrentSources()
      publish({ ...projection, sources: sourcesAtStart, status: 'loading', error: null })
      // 先包一层 Promise：preload 未更新时方法可能不存在，同步异常必须走同一条失败路径。
      void Promise.resolve().then(() => options.api.listServerOpsDataSources({})).then((result) => {
        if (!ownerActive || revision !== operationRevision) return
        if (getCurrentSources() !== sourcesAtStart) {
          publish({ status: 'ready', sources: getCurrentSources(), error: null })
          return
        }
        publish({ status: 'ready', sources: [...result.sources], error: null })
      }).catch(() => {
        if (!ownerActive || revision !== operationRevision) return
        if (getCurrentSources() !== sourcesAtStart) {
          publish({ status: 'ready', sources: getCurrentSources(), error: null })
          return
        }
        /** 失败保留上次成功的列表，避免项目下的连接列表闪空。 */
        publish({ status: 'error', sources: getCurrentSources(), error: '数据源读取失败，请稍后重试' })
      })
    },
  }
}
