import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import type { ApiEnvironment, ApiRun, ApiSseEvent } from '@proma/shared'
import type { ApiWorkbenchRequestTab } from '@/components/api-workbench/api-workbench-model'

/** 单个会话的接口工作台 UI 状态。 */
export interface ApiWorkbenchSessionState {
  tabs: ApiWorkbenchRequestTab[]
  activeTabId: string | null
  environmentId: string | null
  selectedRun: ApiRun | null
  historyOpen: boolean
}

/** Agent 结果卡请求打开的历史运行目标。 */
export interface ApiWorkbenchOpenRunTarget {
  sessionId: string
  runId: string
}

/** 正在接收的流式事件增量；终态后由运行记录接管，切换运行整体替换。 */
export const apiWorkbenchLiveStreamAtom = atom<{ runId: string; events: ApiSseEvent[] } | null>(null)

/** 创建隔离的会话初始状态。 */
export function createApiWorkbenchSessionState(): ApiWorkbenchSessionState {
  return { tabs: [], activeTabId: null, environmentId: null, selectedRun: null, historyOpen: false }
}

/** 生成工作区与会话共同限定的 UI 状态键，不参与 Host IPC。 */
export function createApiWorkbenchUiScope(sessionId: string, workspaceScope?: string): string {
  return JSON.stringify([workspaceScope ?? '', sessionId])
}

/** 请求编辑标签与运行选择按工作区和会话隔离，迁移同名会话时不串线。 */
export const apiWorkbenchSessionStateAtomFamily = atomFamily((uiScope: string) => {
  void uiScope
  return atom<ApiWorkbenchSessionState>(createApiWorkbenchSessionState())
})

/** 结果卡事件先落到原子，再打开工作台，避免组件挂载时丢事件。 */
export const apiWorkbenchOpenRunTargetAtom = atom<ApiWorkbenchOpenRunTarget | null>(null)

/** 判断环境是否仍存在，目录刷新后清理失效选择。 */
export function sanitizeApiEnvironmentId(
  environmentId: string | null,
  environments: readonly ApiEnvironment[],
): string | null {
  return environmentId && environments.some((environment) => environment.id === environmentId)
    ? environmentId
    : null
}
