import { describe, expect, test } from 'bun:test'
import type { CanvasSessionMeta } from '@proma/shared'
import { createCanvasSessionRegistryController } from './useCanvasSessionRegistry'

/** 构造同步测试使用的 Canvas 会话。 */
function createCanvas(id: string, projectId: string): CanvasSessionMeta {
  return {
    id,
    projectId,
    title: `Canvas ${id}`,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('Canvas 会话 registry controller', () => {
  test('Given 两个项目且一个读取失败 When 同步 Then 成功项目仍提交并单独报告错误', async () => {
    /** 成功提交记录，用于验证项目级隔离。 */
    const commits: Array<{ projectId: string; sessions: CanvasSessionMeta[] }> = []
    /** 错误记录不得吞掉其它项目结果。 */
    const errors: Array<{ projectId: string; message: string }> = []
    const controller = createCanvasSessionRegistryController({
      listCanvasSessions: async ({ projectId }) => {
        if (projectId === 'project-b') throw new Error('索引损坏')
        return [createCanvas('a-1', projectId)]
      },
      commit: (projectId, sessions) => commits.push({ projectId, sessions }),
      reportError: (projectId, message) => errors.push({ projectId, message }),
    })

    await controller.syncProjects(['project-a', 'project-b'])

    expect(commits).toEqual([{
      projectId: 'project-a',
      sessions: [createCanvas('a-1', 'project-a')],
    }])
    expect(errors).toEqual([{ projectId: 'project-b', message: '索引损坏' }])
  })

  test('Given 已登记项目 When 收到变化事件 Then 只刷新事件所属项目', async () => {
    /** 记录每次 IPC 读取的项目。 */
    const requestedProjects: string[] = []
    const controller = createCanvasSessionRegistryController({
      listCanvasSessions: async ({ projectId }) => {
        requestedProjects.push(projectId)
        return []
      },
      commit: () => undefined,
      reportError: () => undefined,
    })
    await controller.syncProjects(['project-a', 'project-b'])
    requestedProjects.length = 0

    await controller.handleChange({
      projectId: 'project-b',
      canvasId: 'b-1',
      cause: 'updated',
    })

    expect(requestedProjects).toEqual(['project-b'])
  })

  test('Given 项目已从 Renderer 移除 When 收到迟到事件 Then 不再读取索引', async () => {
    let requestCount = 0
    const controller = createCanvasSessionRegistryController({
      listCanvasSessions: async () => {
        requestCount += 1
        return []
      },
      commit: () => undefined,
      reportError: () => undefined,
    })
    await controller.syncProjects(['project-a'])
    await controller.syncProjects([])
    requestCount = 0

    await controller.handleChange({
      projectId: 'project-a',
      canvasId: 'a-1',
      cause: 'updated',
    })

    expect(requestCount).toBe(0)
  })

  test('Given 同项目两次并发刷新 When 旧请求更晚完成 Then 只提交较新结果', async () => {
    /** 手动控制请求完成顺序。 */
    const resolvers: Array<(sessions: CanvasSessionMeta[]) => void> = []
    const commits: CanvasSessionMeta[][] = []
    const controller = createCanvasSessionRegistryController({
      listCanvasSessions: () => new Promise((resolve) => resolvers.push(resolve)),
      commit: (_projectId, sessions) => commits.push(sessions),
      reportError: () => undefined,
    })

    const initial = controller.syncProjects(['project-a'])
    const refresh = controller.handleChange({
      projectId: 'project-a',
      canvasId: 'a-1',
      cause: 'created',
    })
    resolvers[1]?.([createCanvas('new', 'project-a')])
    await refresh
    resolvers[0]?.([createCanvas('old', 'project-a')])
    await initial

    expect(commits.map((sessions) => sessions[0]?.id)).toEqual(['new'])
  })
})
