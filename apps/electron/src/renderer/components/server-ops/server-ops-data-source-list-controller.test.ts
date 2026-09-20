import { describe, expect, test } from 'bun:test'
import type { ServerOpsDataSource } from '@proma/shared'
import {
  createServerOpsDataSourceListController,
  createServerOpsDataSourcesIdleProjection,
} from './server-ops-data-source-list-controller'
import type { ServerOpsDataSourcesProjection } from './server-ops-data-source-list-controller'

/** 创建数据源样本。 */
function createSource(id: string, label: string, projectId: string): ServerOpsDataSource {
  return {
    id, label, projectId, transport: 'direct', engine: 'mysql', address: '127.0.0.1', port: 13306,
    tlsMode: 'disabled', hasPassword: false, createdAt: 1, updatedAt: 1,
  }
}

/** 刷新微任务与宏任务，等待控制器发布终态。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('数据源列表状态', () => {
  test('Given 保存成功但旧列表仍在途 When 合并权威回执 Then 新连接立即可见且旧结果不能抹掉', async () => {
    /** 延迟列表模拟创建前已经发出的请求。 */
    let finishList!: (value: { sources: ServerOpsDataSource[] }) => void
    /** 已确认创建的数据源回执。 */
    const saved = createSource('new-source', '新项目数据库', 'new-project')
    /** 共享列表模拟多个 Pane 复用的 atom。 */
    let shared: ServerOpsDataSource[] = [createSource('other-source', '另一个面板的连接', 'other-project')]
    /** 数据源控制器使用真实回执并合并共享状态。 */
    const controller = createServerOpsDataSourceListController({
      api: { listServerOpsDataSources: () => new Promise((resolve) => { finishList = resolve }) },
      getSources: () => shared,
      publish: (next) => { shared = next.sources },
    })
    controller.activate()
    await settle()
    controller.acceptSavedSource(saved)
    expect(shared.map((source) => source.id)).toEqual(['other-source', 'new-source'])
    finishList({ sources: [] })
    await settle()
    expect(controller.getProjection().status).toBe('ready')
    expect(shared).toContain(saved)
  })

  test('Given 保存回执已显示 When 后续刷新失败 Then 保留新连接供用户继续使用', async () => {
    /** 刷新失败不会把已经成功的写入变成不可见连接。 */
    const controller = createServerOpsDataSourceListController({
      api: { listServerOpsDataSources: async () => { throw new Error('fixture-list-error') } },
      publish: () => undefined,
    })
    controller.activate()
    await settle()
    controller.acceptSavedSource(createSource('saved-source', '已保存', 'project-1'))
    controller.refresh()
    await settle()
    expect(controller.getProjection().status).toBe('error')
    expect(controller.getProjection().sources[0]?.id).toBe('saved-source')
  })
  test('Given 未激活 When 刷新 Then 不请求也不发布', () => {
    /** 列表调用次数。 */
    let calls = 0
    const published: ServerOpsDataSourcesProjection[] = []
    const controller = createServerOpsDataSourceListController({
      api: { listServerOpsDataSources: async () => { calls += 1; return { sources: [] } } },
      publish: (projection) => published.push(projection),
    })
    controller.refresh()
    expect(calls).toBe(0)
    expect(published).toEqual([])
    expect(controller.getProjection()).toEqual(createServerOpsDataSourcesIdleProjection())
  })

  test('Given 激活 When 加载成功 Then 一次拿到全量并按项目分组使用', async () => {
    const published: ServerOpsDataSourcesProjection[] = []
    const controller = createServerOpsDataSourceListController({
      api: {
        listServerOpsDataSources: async () => ({
          sources: [createSource('source-1', '生产库', 'project-1'), createSource('source-2', '本地库', 'project-2')],
        }),
      },
      publish: (projection) => published.push(projection),
    })
    controller.activate()
    await settle()
    expect(controller.getProjection().status).toBe('ready')
    /** 全量加载：一次请求覆盖所有项目，切项目不再触发请求。 */
    expect(controller.getProjection().sources.map((source) => source.projectId)).toEqual(['project-1', 'project-2'])
    expect(published.some((projection) => projection.status === 'loading')).toBe(true)
  })

  test('Given 读取失败或 preload 未更新 When 激活 Then 保留上次列表并给出可读错误', async () => {
    const published: ServerOpsDataSourcesProjection[] = []
    /** 首次成功、之后失败（含同步抛出的类型错误）。 */
    let attempt = 0
    const controller = createServerOpsDataSourceListController({
      api: {
        listServerOpsDataSources: (() => {
          attempt += 1
          if (attempt === 1) return Promise.resolve({ sources: [createSource('source-1', '生产库', 'project-1')] })
          throw new TypeError('window.electronAPI.listServerOpsDataSources is not a function')
        }) as never,
      },
      publish: (projection) => published.push(projection),
    })
    controller.activate()
    await settle()
    controller.refresh()
    await settle()
    expect(controller.getProjection().status).toBe('error')
    expect(controller.getProjection().error).toBe('数据源读取失败，请稍后重试')
    /** 失败不得清空连接列表，否则项目下的连接会整批消失。 */
    expect(controller.getProjection().sources.map((source) => source.id)).toEqual(['source-1'])
  })

  test('Given 卸载或重新激活 When 旧请求迟到 Then 不写回投影', async () => {
    /** 第一次请求的迟到结果。 */
    let resolveFirst: (value: { sources: ServerOpsDataSource[] }) => void = () => undefined
    const first = new Promise<{ sources: ServerOpsDataSource[] }>((resolve) => { resolveFirst = resolve })
    /** 请求次数；只有第一次返回迟到结果。 */
    let attempt = 0
    const controller = createServerOpsDataSourceListController({
      api: {
        listServerOpsDataSources: async () => {
          attempt += 1
          return attempt === 1 ? first : { sources: [createSource('source-2', '新结果', 'project-1')] }
        },
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.refresh()
    await settle()
    resolveFirst({ sources: [createSource('source-1', '迟到的旧结果', 'project-1')] })
    await settle()
    expect(controller.getProjection().sources.map((source) => source.label)).toEqual(['新结果'])

    controller.dispose()
    controller.refresh()
    expect(controller.getProjection().status).toBe('ready')
  })
})
