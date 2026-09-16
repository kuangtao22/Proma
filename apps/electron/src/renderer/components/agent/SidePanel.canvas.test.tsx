import { describe, expect, test } from 'bun:test'
import type { AgentCanvasBinding, CanvasSessionMeta } from '@proma/shared'
import { createAgentCanvasViewKey } from '@/atoms/agent-canvas-atoms'
import type { DesignAdapter } from '@/lib/design-adapter'
import type { RightWorkspaceSplitState } from '@/lib/right-workspace-split'
import {
  buildCanvasWorkspaceTabs,
  markAgentCanvasActive,
  unlinkAgentCanvasForSession,
} from '@/components/design/CanvasWorkspaceAdapter'
import {
  createCanvasWorkspaceEntryController,
  getCanvasDeleteFailureMessage,
  createCanvasDeleteLifecycle,
  isCanvasWorkspaceTabStillCurrent,
  runCanvasDeleteAction,
  runCanvasWorkspaceAction,
  selectPersistedCanvasWorkspaceRestore,
  selectInitialCanvasWorkspaceSession,
  selectCanvasWorkspaceTabForPane,
  selectCanvasAfterArchive,
} from './canvas-workspace-actions'

/** 创建指定 Agent 的稳定 binding。 */
function createBinding(sessionId: string, canvasId = 'canvas-1'): AgentCanvasBinding {
  return {
    projectId: 'project-1',
    sessionId,
    defaultCanvasId: canvasId,
    lastActiveCanvasId: canvasId,
    linkedCanvasIds: [canvasId],
    updatedAt: 1,
  }
}

/** 创建首次打开决策使用的稳定 Canvas 元数据。 */
function createCanvasSession(id: string, archived = false): CanvasSessionMeta {
  return {
    id,
    projectId: 'project-1',
    title: id,
    archived,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('Agent 右侧画布动态标签', () => {
  test('Given Canvas 全屏展开 When 检查层叠契约 Then 外层右栏与 SidePanel 都能越过应用分隔线', async () => {
    const [sidePanelSource, appShellSource, globalStyles, windowControlsSource] = await Promise.all([
      Bun.file(new URL('./SidePanel.tsx', import.meta.url)).text(),
      Bun.file(new URL('../app-shell/AppShell.tsx', import.meta.url)).text(),
      Bun.file(new URL('../../styles/globals.css', import.meta.url)).text(),
      Bun.file(new URL('../WindowControls.tsx', import.meta.url)).text(),
    ])

    expect(sidePanelSource).toContain('agent-side-panel')
    expect(appShellSource).toContain('agent-right-panel-host')
    expect(globalStyles).toMatch(
      /\.agent-right-panel-host:has\(\[data-canvas-workspace-expanded="true"\]\)[\s\S]*?z-index: 90;/,
    )
    expect(globalStyles).toContain('.agent-side-panel:has([data-canvas-workspace-expanded="true"])')
    expect(windowControlsSource).toContain('z-[100]')
  })

  test('Given 多个关联 Canvas When 组装标签 Then 保持 linked 顺序且只暴露最近语义', () => {
    const binding: AgentCanvasBinding = {
      ...createBinding('agent-1'),
      defaultCanvasId: 'canvas-2',
      lastActiveCanvasId: 'canvas-1',
      linkedCanvasIds: ['canvas-2', 'canvas-1'],
    }
    const sessions: CanvasSessionMeta[] = [
      { id: 'canvas-1', projectId: 'project-1', title: '首页方案', archived: false, createdAt: 1, updatedAt: 1 },
      { id: 'canvas-2', projectId: 'project-1', title: '品牌方案', archived: false, createdAt: 1, updatedAt: 1 },
    ]

    expect(buildCanvasWorkspaceTabs(binding, sessions)).toEqual([
      expect.not.objectContaining({ isDefault: expect.anything() }),
      expect.not.objectContaining({ isDefault: expect.anything() }),
    ])
    expect(buildCanvasWorkspaceTabs(binding, sessions)).toEqual([
      expect.objectContaining({ id: 'canvas:canvas-2', title: '品牌方案', isRecent: false }),
      expect.objectContaining({ id: 'canvas:canvas-1', title: '首页方案', isRecent: true }),
    ])
  })

  test('Given 用户关闭 Canvas 标签 When 执行关闭 Then 只调用 unlink 且保留 Canvas', async () => {
    const calls: string[] = []
    const adapter: Pick<DesignAdapter, 'unlinkAgentCanvas'> = {
      unlinkAgentCanvas: async (input) => {
        calls.push(`${input.sessionId}:${input.canvasId}`)
        return null
      },
    }

    await unlinkAgentCanvasForSession(adapter, 'project-1', 'agent-1', 'canvas-1')

    expect(calls).toEqual(['agent-1:canvas-1'])
  })

  test('Given 两个 Agent 共享同一 Canvas When 更新最近语义 Then binding 与视图身份互不串线', async () => {
    const inputs: string[] = []
    const adapter: Pick<DesignAdapter, 'markAgentCanvasActive'> = {
      markAgentCanvasActive: async (input) => {
        inputs.push(`${input.sessionId}:${input.canvasId}`)
        return createBinding(input.sessionId, input.canvasId)
      },
    }

    await Promise.all([
      markAgentCanvasActive(adapter, 'project-1', 'agent-1', 'canvas-1'),
      markAgentCanvasActive(adapter, 'project-1', 'agent-2', 'canvas-1'),
    ])

    expect(inputs).toEqual([
      'agent-1:canvas-1',
      'agent-2:canvas-1',
    ])
    expect(createAgentCanvasViewKey('agent-1', 'project-1', 'canvas-1'))
      .not.toBe(createAgentCanvasViewKey('agent-2', 'project-1', 'canvas-1'))
  })

  test('Given 只读或 IPC reject When 执行菜单宿主动作 Then 固定中文提示且不抛出内部错误', async () => {
    const errors: string[] = []
    const logs: unknown[] = []

    const result = await runCanvasWorkspaceAction({
      action: async () => { throw new Error('READ_ONLY_INTERNAL_PATH=/secret/project') },
      failureMessage: '重命名画布失败',
      logContext: '重命名画布',
      onErrorMessage: (message) => { errors.push(message) },
      onLogError: (_context, error) => { logs.push(error) },
    })

    expect(result).toBeNull()
    expect(errors).toEqual(['重命名画布失败'])
    expect(errors.join('')).not.toContain('secret')
    expect(logs).toHaveLength(1)
  })

  test('Given 删除被运行任务阻断 When 确认删除 Then 保持确认态并返回固定可操作提示', async () => {
    expect(getCanvasDeleteFailureMessage(new Error('画布仍有任务运行')))
      .toBe('画布仍有任务运行，请先停止后再删除')
    expect(getCanvasDeleteFailureMessage(new Error('IPC_SECRET=/private/path')))
      .toBe('删除画布失败')

    let confirmationOpen = true
    const errors: string[] = []
    const deleted = await runCanvasDeleteAction({
      action: async () => { throw new Error('画布仍有任务运行') },
      onErrorMessage: (message) => { errors.push(message) },
      onLogError: () => undefined,
    })
    if (deleted) confirmationOpen = false

    expect(deleted).toBe(false)
    expect(confirmationOpen).toBe(true)
    expect(errors).toEqual(['画布仍有任务运行，请先停止后再删除'])
  })

  test('Given A 身份打开删除确认 When 切换到 B Then 旧确认失效且不能删除 A', () => {
    const lifecycle = createCanvasDeleteLifecycle()
    const pending = lifecycle.open('agent-a', 'project-1', {
      id: 'canvas-a', projectId: 'project-1', title: 'A', archived: false, createdAt: 1, updatedAt: 1,
    })

    lifecycle.switchHost('agent-b', 'project-2')

    expect(lifecycle.isCurrent(pending)).toBe(false)
    expect(lifecycle.getPending()).toBeNull()
  })

  test('Given A 删除已开始 When 切换到 B 且 A 迟到完成 Then 不允许回写 B 的 UI', () => {
    const lifecycle = createCanvasDeleteLifecycle()
    const pending = lifecycle.open('agent-a', 'project-1', {
      id: 'canvas-a', projectId: 'project-1', title: 'A', archived: false, createdAt: 1, updatedAt: 1,
    })
    const operation = lifecycle.begin(pending)
    const retriedOperation = lifecycle.begin(pending)

    lifecycle.switchHost('agent-b', 'project-2')

    expect(operation).not.toBeNull()
    expect(retriedOperation?.generation).toBeGreaterThan(operation!.generation)
    expect(lifecycle.isOperationCurrent(operation!)).toBe(false)
  })

  test('Given 当前画布被归档 When 选择回退 Then 最近有效关联优先、关联顺序次之、无可用返回 null', () => {
    /** 构造可用于回退的未归档画布。 */
    const sessions: CanvasSessionMeta[] = [
      { id: 'default', projectId: 'project-1', title: '默认', archived: false, createdAt: 1, updatedAt: 1 },
      { id: 'recent', projectId: 'project-1', title: '最近', archived: false, createdAt: 1, updatedAt: 1 },
    ]

    expect(selectCanvasAfterArchive({
      archivedCanvasId: 'current',
      lastActiveCanvasId: 'recent',
      linkedCanvasIds: ['current', 'recent', 'default'],
      sessions,
    })?.id).toBe('recent')
    expect(selectCanvasAfterArchive({
      archivedCanvasId: 'current',
      linkedCanvasIds: ['current', 'recent'],
      sessions,
    })?.id).toBe('recent')
    expect(selectCanvasAfterArchive({
      archivedCanvasId: 'current',
      lastActiveCanvasId: 'default',
      linkedCanvasIds: ['current', 'recent'],
      sessions,
    })?.id).toBe('recent')
    expect(selectCanvasAfterArchive({
      archivedCanvasId: 'current',
      linkedCanvasIds: ['current'],
      sessions: [],
    })).toBeNull()
  })

  test('Given Canvas IPC 在途期间焦点变化 When 指定原 Pane 打开标签 Then 使用最新 split 且只更新目标 Pane', async () => {
    const split: RightWorkspaceSplitState = {
      leftTab: 'canvas:canvas-left',
      rightTab: 'files',
      focusedPane: 'right',
      ratio: 0.5,
    }
    expect(selectCanvasWorkspaceTabForPane(split, 'canvas:canvas-next', 'left')).toEqual({
      ...split,
      leftTab: 'canvas:canvas-next',
      focusedPane: 'left',
    })
  })

  test('Given 用户未点击添加画布 When 检查 SidePanel Then 只恢复用户持久化的有效画布标签', async () => {
    const source = await Bun.file(new URL('./SidePanel.tsx', import.meta.url)).text()

    expect(source).toContain('agentCanvasWorkspaceStateMapAtom')
    expect(source).toContain('sanitizeAgentCanvasWorkspaceState')
    expect(source).toContain('selectPersistedCanvasWorkspaceRestore')
    expect(source).toContain('canvasWorkspaceRestoreRef')
    expect(source).toContain('canvasWorkspaceRestoreRef.current.pendingTab = null')
    expect(source).toContain('openedCanvasWorkspaceTabs')
    expect(source).not.toContain("openedCanvasWorkspaceTabs.includes('canvas')")
    expect(source).toContain("effectiveActiveTab === 'canvas'")
    expect(source).toContain('shouldShowCanvasWorkspaceLauncher')
    expect(source).toContain('createCanvasWorkspaceEntryController')
    expect(source).toContain('handleOpenInitialCanvas')
    expect(source).toContain('canvasRegistry.metadataReady')
    expect(source).toContain('openCanvas: (canvas) => handleOpenCanvas(canvas, pane)')
    expect(source).toContain("handleCanvasWorkspaceTabChange('canvas', pane)")
    expect(source).toContain('openLauncher: async () =>')
    expect(source).not.toContain('createCanvas: () => handleCreateCanvas(pane)')
    expect(source).not.toContain('selectCanvasWorkspaceEntryTab')
    expect(source).toContain('openCanvasDisabled={!currentWorkspaceId || !canvasRegistry.metadataReady || !canvasRegistry.bindingReady}')
    expect(source).toContain('if (!split || !canvasRegistry.bindingReady) return')
    expect(source).toContain('split?.focusedPane ?? null')
    expect(source).not.toContain('agentCanvasWorkspaceOpenTabsAtom')
  })

  test('Given 最近画布仍是有效关联 When 选择首次打开目标 Then 只恢复该最近画布', () => {
    const sessions = [
      createCanvasSession('canvas-first'),
      createCanvasSession('canvas-recent'),
      createCanvasSession('canvas-archived', true),
    ]

    expect(selectInitialCanvasWorkspaceSession(
      sessions,
      ['canvas-first', 'canvas-recent'],
      'canvas-recent',
    )?.id).toBe('canvas-recent')
    expect(selectInitialCanvasWorkspaceSession(
      sessions,
      ['canvas-first'],
      'canvas-recent',
    )).toBeNull()
    expect(selectInitialCanvasWorkspaceSession(
      [createCanvasSession('canvas-archived', true)],
      ['canvas-archived'],
      'canvas-archived',
    )).toBeNull()
  })

  test('Given 没有可恢复的最近画布 When 首次打开被快速触发两次 Then 只打开一次列表且不创建画布', async () => {
    let launcherCalls = 0
    const controller = createCanvasWorkspaceEntryController()
    const input = {
      sessions: [],
      linkedCanvasIds: [],
      lastActiveCanvasId: undefined,
      openCanvas: async (): Promise<boolean> => false,
      openLauncher: async (): Promise<boolean> => {
        launcherCalls += 1
        await Promise.resolve()
        return true
      },
    }

    const first = controller.open(input)
    const second = controller.open(input)

    expect(first).toBe(second)
    expect(await first).toBe(true)
    expect(launcherCalls).toBe(1)
  })

  test('Given 上次正在查看的 Canvas 仍有效 When registry 就绪且用户未切换 Then 恢复该标签', () => {
    expect(selectPersistedCanvasWorkspaceRestore({
      persistedActiveTab: 'canvas:canvas-1',
      availableTabs: ['canvas:canvas-1'],
      bindingReady: true,
      metadataReady: true,
      sidePanelOpen: true,
      initialTab: 'files',
      currentTab: 'files',
      userSelectionGeneration: 0,
    })).toBe('canvas:canvas-1')
  })

  test('Given 恢复条件不完整 When 决策 Then 不打开失效 Canvas 或覆盖用户选择', () => {
    /** 共享的有效 Canvas 恢复输入。 */
    const baseInput = {
      persistedActiveTab: 'canvas:canvas-1' as const,
      availableTabs: ['canvas:canvas-1'] as const,
      bindingReady: true,
      metadataReady: true,
      sidePanelOpen: true,
      initialTab: 'files' as const,
      currentTab: 'files' as const,
      userSelectionGeneration: 0,
    }

    expect(selectPersistedCanvasWorkspaceRestore({ ...baseInput, bindingReady: false })).toBeNull()
    expect(selectPersistedCanvasWorkspaceRestore({ ...baseInput, metadataReady: false })).toBeNull()
    expect(selectPersistedCanvasWorkspaceRestore({ ...baseInput, sidePanelOpen: false })).toBeNull()
    expect(selectPersistedCanvasWorkspaceRestore({ ...baseInput, availableTabs: [] })).toBeNull()
    expect(selectPersistedCanvasWorkspaceRestore({
      ...baseInput,
      currentTab: 'changes',
      userSelectionGeneration: 1,
    })).toBeNull()
  })

  test('Given 会话终态或历史状态超限 When 检查应用接线 Then 清理并有界裁剪持久化 Canvas 状态', async () => {
    const [sidebarSource, appShellSource] = await Promise.all([
      Bun.file(new URL('../app-shell/LeftSidebar.tsx', import.meta.url)).text(),
      Bun.file(new URL('../app-shell/AppShell.tsx', import.meta.url)).text(),
    ])

    expect(sidebarSource).toContain('agentCanvasWorkspaceStateMapAtom')
    expect(sidebarSource).not.toContain('agentCanvasWorkspaceOpenTabsAtom')
    expect(appShellSource).toContain('pruneAgentCanvasWorkspaceStates')
    expect(appShellSource).toContain('agentCanvasWorkspaceStateMapAtom')
  })

  test('Given 归档请求在途时用户切换目标 Pane When 请求完成 Then 不再执行迟到回退', () => {
    const changedSplit: RightWorkspaceSplitState = {
      leftTab: 'files',
      rightTab: 'changes',
      focusedPane: 'left',
      ratio: 0.5,
    }

    expect(isCanvasWorkspaceTabStillCurrent({
      split: changedSplit,
      activeTab: 'canvas:canvas-archived',
      pane: 'left',
      canvasId: 'canvas-archived',
    })).toBe(false)
    expect(isCanvasWorkspaceTabStillCurrent({
      split: { ...changedSplit, rightTab: 'canvas:canvas-archived' },
      activeTab: 'files',
      pane: 'right',
      canvasId: 'canvas-archived',
    })).toBe(true)
    expect(isCanvasWorkspaceTabStillCurrent({
      split: null,
      activeTab: 'canvas:canvas-archived',
      pane: null,
      canvasId: 'canvas-archived',
    })).toBe(true)
    expect(isCanvasWorkspaceTabStillCurrent({
      split: null,
      activeTab: 'canvas:canvas-archived',
      pane: 'left',
      canvasId: 'canvas-archived',
    })).toBe(false)
  })
})
