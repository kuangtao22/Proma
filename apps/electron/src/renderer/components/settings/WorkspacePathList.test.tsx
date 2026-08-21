import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkspacePathState, WorkspaceRelocationPreview, WorkspaceTargetSelection } from '@proma/shared'
import * as workspacePathModule from './WorkspacePathList'

/** 创建列表测试使用的项目路径状态。 */
function createWorkspace(overrides: Partial<WorkspacePathState>): WorkspacePathState {
  return {
    workspaceId: 'workspace-1',
    name: '示例项目',
    sourceRoot: '/projects/example',
    kind: 'external',
    availability: 'available',
    relocation: null,
    ...overrides,
  }
}

describe('WorkspacePathList', () => {
  test('Given 放弃迁移成功 When 清理本地进度 Then 删除当前项目且保留其他项目缓存', () => {
    const { removeWorkspaceRelocationProgress } = workspacePathModule
    const current = {
      'workspace-1': { operationId: 'operation-1', workspaceId: 'workspace-1', stage: 'failed' as const, completedBytes: 2, totalBytes: 4 },
      'workspace-2': { operationId: 'operation-2', workspaceId: 'workspace-2', stage: 'copying' as const, completedBytes: 1, totalBytes: 4 },
    }

    expect(removeWorkspaceRelocationProgress(current, 'workspace-1')).toEqual({
      'workspace-2': current['workspace-2'],
    })
  })

  test('Given start Promise 仍 pending When 收到 copying 后点击取消 Then starting 转 running 且仅 cancelling 禁用取消', () => {
    const { reduceWorkspaceActionPhase } = workspacePathModule
    const starting = reduceWorkspaceActionPhase('idle', { type: 'start-requested' })
    const running = reduceWorkspaceActionPhase(starting, { type: 'progress', stage: 'copying' })
    const cancelling = reduceWorkspaceActionPhase(running, { type: 'cancel-requested' })
    expect([starting, running, cancelling]).toEqual(['starting', 'running', 'cancelling'])
    expect(reduceWorkspaceActionPhase(cancelling, { type: 'settled' })).toBe('idle')
  })

  test('Given stale 与 active persisted journal When 渲染 Then 分别显示继续放弃或取消迁移', () => {
    const { WorkspacePathList } = workspacePathModule
    const staleHtml = renderToStaticMarkup(<WorkspacePathList workspaces={[createWorkspace({
      relocation: { operationId: 'operation-1', workspaceId: 'workspace-1', stage: 'failed', completedBytes: 2, totalBytes: 4, active: false },
    })]} />)
    const activeHtml = renderToStaticMarkup(<WorkspacePathList workspaces={[createWorkspace({
      relocation: { operationId: 'operation-1', workspaceId: 'workspace-1', stage: 'copying', completedBytes: 2, totalBytes: 4, active: true },
    })]} />)
    expect(staleHtml).toContain('继续迁移')
    expect(staleHtml).toContain('放弃迁移')
    expect(activeHtml).toContain('取消迁移')
    expect(activeHtml).not.toContain('继续迁移')
  })
  test('Given external、managed、offline 三类项目 When 渲染列表 Then 展示迁移、迁出、重定位动作与截断路径', () => {
    const { WorkspacePathList } = workspacePathModule
    const html = renderToStaticMarkup(<WorkspacePathList
      workspaces={[
        createWorkspace({ workspaceId: 'external', name: '外部项目' }),
        createWorkspace({ workspaceId: 'managed', name: '托管项目', kind: 'managed', sourceRoot: '/data/workspace-files' }),
        createWorkspace({ workspaceId: 'offline', name: '离线项目', availability: 'missing', sourceRoot: '/Volumes/offline/project' }),
      ]}
    />)
    expect(html).toContain('外部项目')
    expect(html).toContain('托管项目')
    expect(html).toContain('离线项目')
    expect(html).toContain('>迁移<')
    expect(html).toContain('>迁出<')
    expect(html).toContain('>重定位<')
    expect(html).toContain('truncate')
  })

  test('Given loading、error 或空项目 When 渲染 Then 展示稳定空态且不渲染嵌套卡片', () => {
    const { WorkspacePathList } = workspacePathModule
    expect(renderToStaticMarkup(<WorkspacePathList workspaces={[]} loading />)).toContain('正在读取项目路径')
    expect(renderToStaticMarkup(<WorkspacePathList workspaces={[]} error="无法读取项目路径" />)).toContain('无法读取项目路径')
    const emptyHtml = renderToStaticMarkup(<WorkspacePathList workspaces={[]} />)
    expect(emptyHtml).toContain('暂无项目')
    expect(emptyHtml.match(/data-settings-card/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  test('Given 离线项目 When 执行路径动作 Then 使用 relink selection 且不预检或启动复制', async () => {
    const { requestWorkspacePathAction } = workspacePathModule
    /** 记录离线重定位调用边界。 */
    const calls: string[] = []
    const selection: WorkspaceTargetSelection = {
      selectionId: 'selection-1', workspaceId: 'offline', targetRoot: '/projects/found', purpose: 'relink',
    }
    await requestWorkspacePathAction(createWorkspace({ workspaceId: 'offline', availability: 'missing' }), {
      pickWorkspaceTarget: async (input) => { calls.push(`pick:${input.purpose}`); return selection },
      previewWorkspaceRelocation: async () => { calls.push('preview'); throw new Error('不应预检') },
      confirmRelocation: async () => { calls.push('confirm'); return true },
      startWorkspaceRelocation: async () => { calls.push('start'); throw new Error('不应复制') },
      relinkWorkspace: async () => { calls.push('relink') },
    })
    expect(calls).toEqual(['pick:relink', 'relink'])
  })

  test('Given 可用项目 When 预检与确认迁移 Then 展示源目标空间并按 progress 禁用重复操作', async () => {
    const { WorkspacePathList, requestWorkspacePathAction } = workspacePathModule
    /** 测试预检结果。 */
    const preview: WorkspaceRelocationPreview = {
      operationId: 'operation-1', workspaceId: 'external', workspaceSlug: 'external',
      sourceRoot: '/projects/old', targetRoot: '/projects/new', totalBytes: 100,
      remainingBytes: 100, availableBytes: 200, kind: 'external',
    }
    /** 记录迁移流程顺序。 */
    const calls: string[] = []
    await requestWorkspacePathAction(createWorkspace({ workspaceId: 'external' }), {
      pickWorkspaceTarget: async () => ({ selectionId: 'selection-1', workspaceId: 'external', targetRoot: '/projects/new', purpose: 'relocation' }),
      previewWorkspaceRelocation: async () => { calls.push('preview'); return preview },
      confirmRelocation: async (value) => { calls.push(`confirm:${value.sourceRoot}:${value.targetRoot}:${value.availableBytes}`); return true },
      startWorkspaceRelocation: async () => { calls.push('start'); return { operationId: 'operation-1', workspaceId: 'external', stage: 'completed', completedBytes: 100, totalBytes: 100 } },
      relinkWorkspace: async () => undefined,
    })
    expect(calls).toEqual(['preview', 'confirm:/projects/old:/projects/new:200', 'start'])

    const progressHtml = renderToStaticMarkup(<WorkspacePathList workspaces={[createWorkspace({
      workspaceId: 'external',
      relocation: { operationId: 'operation-1', workspaceId: 'external', stage: 'copying', completedBytes: 25, totalBytes: 100 },
    })]} />)
    expect(progressHtml).toContain('aria-valuenow="25"')
    expect(progressHtml).toContain('继续迁移')
    expect(progressHtml).toContain('放弃迁移')
    expect(progressHtml).toContain('h-1.5')
  })

  test('Given 预检失败 When 执行动作 Then 保留中文阻断原因且不启动迁移', async () => {
    const { requestWorkspacePathAction } = workspacePathModule
    /** 记录是否错误启动复制。 */
    let started = false
    await expect(requestWorkspacePathAction(createWorkspace({}), {
      pickWorkspaceTarget: async () => ({ selectionId: 'selection-1', workspaceId: 'workspace-1', targetRoot: '/projects/new', purpose: 'relocation' }),
      previewWorkspaceRelocation: async () => { throw new Error('目标目录必须为空') },
      confirmRelocation: async () => true,
      startWorkspaceRelocation: async () => { started = true; throw new Error('不应启动') },
      relinkWorkspace: async () => undefined,
    })).rejects.toThrow('目标目录必须为空')
    expect(started).toBe(false)
  })
})
