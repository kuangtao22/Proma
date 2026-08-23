import { describe, expect, test } from 'bun:test'
import type { AgentToolResultImage, DesignWorkspaceSnapshot } from '@proma/shared'
import { importAgentToolResultImagesToDesign } from './agent-design-actions'

describe('Agent 图片加入设计', () => {
  test('Given 项目会话和两张工具图片 When 加入设计 Then 逐张导入且不具备切页或发送消息能力', async () => {
    /** 记录主进程收到的精确附件路径与落点。 */
    const calls: Array<{ projectId: string; sessionId: string; localPath: string; position: { x: number; y: number } }> = []
    /** 当前活跃会话故意与消息所属会话不同，动作不得读取该环境身份。 */
    const activeSessionId = 'session-b'
    const images: AgentToolResultImage[] = [
      { localPath: '/attachments/a.png', filename: 'a.png', mediaType: 'image/png' },
      { localPath: '/attachments/b.png', filename: 'b.png', mediaType: 'image/png' },
    ]

    const count = await importAgentToolResultImagesToDesign({
      projectId: 'project-1', sessionId: 'session-1', images,
    }, {
      importImage: async (input) => {
        calls.push({ projectId: input.projectId, sessionId: input.sessionId, localPath: input.localPath, position: input.position })
        return {} as DesignWorkspaceSnapshot
      },
    })

    expect(count).toBe(2)
    expect(activeSessionId).toBe('session-b')
    expect(calls).toEqual([
      { projectId: 'project-1', sessionId: 'session-1', localPath: '/attachments/a.png', position: { x: 40, y: 40 } },
      { projectId: 'project-1', sessionId: 'session-1', localPath: '/attachments/b.png', position: { x: 64, y: 64 } },
    ])
  })
})
