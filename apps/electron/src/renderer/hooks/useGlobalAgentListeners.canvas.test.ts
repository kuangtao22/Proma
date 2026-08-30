import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentCanvasBinding, AgentSessionMeta } from '@proma/shared'
import type { CanvasAgentOwner } from '@/lib/canvas-agent-event-routing'
import { resolveCanvasAgentWorkspaceOwner } from './useGlobalAgentListeners'

/** 构造不含路径等内部字段的普通 Agent 会话。 */
function createAgentSession(id: string, workspaceId = 'project-1'): AgentSessionMeta {
  return { id, title: id, workspaceId, createdAt: 1, updatedAt: 1 }
}

/** 构造用于通知宿主解析的项目级 Canvas binding。 */
function createBinding(sessionId: string, updatedAt: number): AgentCanvasBinding {
  return {
    projectId: 'project-1',
    sessionId,
    linkedCanvasIds: ['canvas-1'],
    lastActiveCanvasId: 'canvas-1',
    updatedAt,
  }
}

/** Canvas 内部 Agent 只公开节点归属，不携普通宿主会话。 */
const canvasOwner: CanvasAgentOwner = {
  sessionId: 'internal-canvas-agent',
  projectId: 'project-1',
  canvasId: 'canvas-1',
  nodeId: 'node-1',
  title: '画布节点 Agent',
}

describe('全局 Agent listener 的 Canvas 隔离', () => {
  test('Given Canvas owner When 流式事件到达 Then 跳过未知普通会话刷新', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain('const isCanvasAgent = store.get(canvasAgentOwnersAtom).has(sessionId)')
    expect(source).toContain('if (!isCanvasAgent && !knownSessions.some((s) => s.id === sessionId))')
  })

  test('Given Canvas 完成 When 处理终态 Then 不 upsert 普通列表或写普通未读并保留 live', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain('if (!isCanvasAgentCompletion && data.session && !backgroundTasksPending)')
    expect(source).toContain('else if (!isCanvasAgentCompletion) notifyAgentCompletion')
    expect(source).toContain('if (!isCanvasAgentCompletion && completionMarkers.markUnviewedCompleted')
    expect(source).toContain('if (isCanvasAgentCompletion) {')
  })

  test('Given Canvas completion When 代次不匹配或 GET 晚回 Then 所有终态副作用 fail closed', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain('designAdapter.getCanvasAgentMessages({')
    expect(source).not.toContain('window.electronAPI.getCanvasAgentMessages({')
    expect(source).toContain('!isCanvasAgentGenerationCurrent(store, data.sessionId, data.startedAt)')
    expect(source).toContain('if (!isCanvasAgentHandoffGenerationCurrent(store, data.sessionId, data.startedAt!)) return')
    expect(source).toContain("type: 'completed', sessionId: data.sessionId, startedAt: data.startedAt!")
    expect(source).toContain("type: 'settled', sessionId: data.sessionId, startedAt: data.startedAt!")
  })

  test('Given completion warning When 真实 listener 分派 Then 必须携 route kind 再决定 toast', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain('notifyAgentCompletionWarning(completionRoute.kind, data, (message) => {')
  })

  test('Given Canvas 完成通知 When 用户点击 Then 仅在普通 owner session 与 binding 均权威有效时打开右侧工作区', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    const start = source.indexOf('const makeNavigateToCanvasAgent')
    const end = source.indexOf('\n    /**', start + 1)
    const body = source.slice(start, end)
    expect(body).toContain('designAdapter.listAgentCanvasBindings({ projectId: owner.projectId })')
    expect(body).toContain('resolveCanvasAgentWorkspaceOwner(')
    expect(body).toContain('if (!workspaceOwner) return')
    expect(body).toContain('getCanvasWorkspaceTab(owner.canvasId)')
    expect(body).toContain('agentSidePanelOpenAtomFamily(workspaceOwner.id)')
    expect(body).toContain('agentDiffPanelTabAtom')
    expect(body).toContain('store.set(navigateAgentCanvasViewAtom')
    expect(body).toContain('nodeId: owner.nodeId')
    expect(body).toContain('openTab(')
    expect(body).not.toContain('activeCanvasSelectionAtom')
    expect(body).not.toContain("activeViewAtom, 'design'")
    expect(body).not.toContain('createLegacyAgentCanvasHostSessionId')
  })

  test('Given 多个有效 binding When 解析通知宿主 Then 返回最近活动且仍存在的普通 Agent', () => {
    const resolved = resolveCanvasAgentWorkspaceOwner(
      canvasOwner,
      [createBinding('agent-old', 1), createBinding('agent-new', 2)],
      [createAgentSession('agent-old'), createAgentSession('agent-new')],
    )

    expect(resolved?.id).toBe('agent-new')
  })

  test('Given binding 或普通 Agent 会话缺失或项目不一致 When 解析通知宿主 Then fail closed', () => {
    expect(resolveCanvasAgentWorkspaceOwner(canvasOwner, [], [createAgentSession('agent-1')])).toBeNull()
    expect(resolveCanvasAgentWorkspaceOwner(canvasOwner, [createBinding('agent-1', 1)], [])).toBeNull()
    expect(resolveCanvasAgentWorkspaceOwner(
      canvasOwner,
      [createBinding('agent-1', 1)],
      [createAgentSession('agent-1', 'project-other')],
    )).toBeNull()
  })

  test('Given renderer 重载且 bootstrap 未完成 When 未知流与标题先到 Then 暂存并在 owner 恢复后重放一次', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain('window.electronAPI.listActiveCanvasAgentRuns()')
    expect(source).toContain('createCanvasAgentBootstrapCoordinator')
    expect(source).toContain('canvasAgentBootstrapCoordinator.start()')
    expect(source).toContain('canvasAgentBootstrapCoordinator.dispose()')
    expect(source).toContain('canvasAgentBootstrapCoordinator.handle')
    expect(source).toContain('event.value.payload.event.session !== undefined')
  })

  test('Given renderer 重载且 completion 早到 When bootstrap deferred 或失败 Then completion 也通过有界 gate', () => {
    /** completion 必须与 stream/title 共用 bootstrap 判定，禁止直接走普通通知。 */
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain("| { type: 'complete'; sessionId: string; value: AgentStreamCompletePayload }")
    expect(source).toContain("allowUnknownAfterReady: (event) => event.type !== 'complete'")
    expect(source).toContain("allowInternalInvalid: (event) => event.type === 'complete'")
    expect(source).toContain("isTerminalEvent: (event) => event.type === 'complete'")
    expect(source).toContain("type: 'complete', sessionId: data.sessionId, value: data")
  })

  test('Given completion payload 明确损坏 When 本地已有旧 owner Then 失效缓存且禁止 fallback', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain("completionRoute.kind === 'internal-invalid'")
    expect(source).toContain("type: 'invalidated'")
    expect(source).not.toContain("completionRoute.kind === 'canvas'\n          ? completionRoute.owner\n          : store.get(canvasAgentOwnersAtom).get(data.sessionId)")
  })

  test('Given internal-invalid soft completion When 处理终态 Then 保留 active 阻断直到 hard terminal', () => {
    /** soft completion 必须把终态语义显式传入 lifecycle，不能无条件 terminalize。 */
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain('terminal: !backgroundTasksPending')
    expect(source).toContain("...(!backgroundTasksPending ? { startedAt: data.startedAt } : {})")
  })

  test('Given Canvas STREAM_ERROR When bootstrap pending、ready 或 failed Then 与 completion 共用 fail-closed gate', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain("| { type: 'error'; sessionId: string; value: AgentStreamErrorPayload }")
    expect(source).toContain("type: 'error', sessionId: data.sessionId, value: data")
    expect(source).toContain("event.type !== 'complete' && event.type !== 'error'")
    expect(source).toContain("event.type === 'complete' || event.type === 'error'")
    expect(source).toContain("getTerminalEventKey: (event) => `${event.type}:${event.sessionId}`")
    expect(source).toContain("type: 'invalidated', sessionId: data.sessionId, terminal: true, startedAt: data.startedAt")
  })

  test('Given internal-invalid 没有安全 owner When run_started 到达 Then 只更新 generation 并继续 fail closed', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain("type: 'invalid-started', sessionId, startedAt: runStartedEvent.startedAt")
    expect(source).toContain('internalInvalidRuns: snapshot.internalInvalidRuns')
  })
})
