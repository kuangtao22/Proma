import * as React from 'react'
import type {
  CanvasSessionChangeEvent,
  CanvasSessionMeta,
  ListCanvasSessionsInput,
} from '@proma/shared'
import { useSetAtom } from 'jotai'
import {
  replaceCanvasSessionsAtom,
  setCanvasSessionProjectStatusAtom,
} from '@/atoms/canvas-session-atoms'
import { designAdapter } from '@/lib/design-adapter'

/** Canvas registry controller 使用的可测试依赖。 */
export interface CanvasSessionRegistryControllerDependencies {
  listCanvasSessions: (input: ListCanvasSessionsInput) => Promise<CanvasSessionMeta[]>
  commit: (projectId: string, sessions: CanvasSessionMeta[]) => void
  reportError: (projectId: string, message: string) => void
  reportLoading?: (projectId: string) => void
}

/** Canvas registry 的可测试命令面。 */
export interface CanvasSessionRegistryController {
  syncProjects: (projectIds: string[]) => Promise<void>
  handleChange: (event: CanvasSessionChangeEvent) => Promise<void>
}

/** 把未知异常收敛为稳定的项目级错误文案。 */
function getCanvasSessionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Canvas 会话加载失败'
}

/**
 * 创建按项目隔离且拒绝迟到响应的 Canvas registry controller。
 * @param dependencies IPC 读取、状态提交与错误报告边界。
 * @returns 可由 React hook 和单元测试共同驱动的 controller。
 */
export function createCanvasSessionRegistryController(
  dependencies: CanvasSessionRegistryControllerDependencies,
): CanvasSessionRegistryController {
  /** 当前 Renderer 仍登记的项目，删除项目后迟到事件会被忽略。 */
  let activeProjectIds = new Set<string>()
  /** 每项目请求代次，防止旧读取覆盖创建或归档后的新列表。 */
  const requestGenerationByProject = new Map<string, number>()

  /** 读取一个仍活跃项目的完整 Canvas 索引。 */
  const refreshProject = async (projectId: string): Promise<void> => {
    if (!activeProjectIds.has(projectId)) return
    /** 新请求立即推进项目代次。 */
    const generation = (requestGenerationByProject.get(projectId) ?? 0) + 1
    requestGenerationByProject.set(projectId, generation)
    dependencies.reportLoading?.(projectId)
    try {
      /** archived 缺失表示一次读取完整索引，Renderer 本地筛选 active/archived。 */
      const sessions = await dependencies.listCanvasSessions({ projectId })
      if (!activeProjectIds.has(projectId)) return
      if (requestGenerationByProject.get(projectId) !== generation) return
      dependencies.commit(projectId, sessions)
    } catch (error) {
      if (!activeProjectIds.has(projectId)) return
      if (requestGenerationByProject.get(projectId) !== generation) return
      dependencies.reportError(projectId, getCanvasSessionErrorMessage(error))
    }
  }

  return {
    /** 用最新项目集合替换监听范围，并并行刷新轻量索引。 */
    async syncProjects(projectIds: string[]): Promise<void> {
      activeProjectIds = new Set(projectIds)
      await Promise.all(projectIds.map((projectId) => refreshProject(projectId)))
    },
    /** Canvas 成功提交后的事件只刷新所属项目。 */
    async handleChange(event: CanvasSessionChangeEvent): Promise<void> {
      await refreshProject(event.projectId)
    },
  }
}

/** 在 AppShell 生命周期内同步所有已登记项目的 Canvas 元数据。 */
export function useCanvasSessionRegistry(projectIds: string[]): void {
  const replaceSessions = useSetAtom(replaceCanvasSessionsAtom)
  const setProjectStatus = useSetAtom(setCanvasSessionProjectStatusAtom)
  /** 项目集合按稳定顺序生成依赖键，避免父组件普通重渲染重复读取。 */
  const projectIdsKey = projectIds.join('\u0000')

  const controller = React.useMemo(
    () => createCanvasSessionRegistryController({
      listCanvasSessions: (input) => designAdapter.listCanvasSessions(input),
      commit: (projectId, sessions) => {
        replaceSessions({ projectId, sessions })
        setProjectStatus({ projectId, phase: 'ready', error: null })
      },
      reportLoading: (projectId) => {
        setProjectStatus({ projectId, phase: 'loading', error: null })
      },
      reportError: (projectId, message) => {
        console.error(`[Canvas 会话] 项目 ${projectId} 索引加载失败: ${message}`)
        setProjectStatus({ projectId, phase: 'failed', error: message })
      },
    }),
    [replaceSessions, setProjectStatus],
  )

  React.useEffect(() => {
    /** projectIdsKey 变化时数组内容必然变化，controller 会替换活跃项目集合。 */
    void controller.syncProjects(projectIds)
  }, [controller, projectIdsKey])

  React.useEffect(() => {
    /** Preload 监听器返回幂等清理函数，AppShell 卸载时释放。 */
    return designAdapter.onCanvasSessionChanged((event) => {
      void controller.handleChange(event)
    })
  }, [controller])
}
