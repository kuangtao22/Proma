import { describe, expect, test } from 'bun:test'
import {
  CANVAS_WORKSPACE_FAILURE_MESSAGES,
  runCanvasWorkspaceAction,
} from './canvas-workspace-actions'

describe('Canvas 宿主异步动作', () => {
  test('Given 所有用户失败提示 When 检查合同 Then 都是固定中文且不含底层详情', () => {
    const messages = Object.values(CANVAS_WORKSPACE_FAILURE_MESSAGES)

    expect(messages).toContain('设置默认画布失败')
    expect(messages).toContain('恢复画布失败')
    expect(messages.join('')).not.toContain('IPC')
    expect(messages.join('')).not.toContain('/private/')
  })

  test('Given 成功结果 When 执行动作 Then 原样返回且不显示错误', async () => {
    const errors: string[] = []
    const result = await runCanvasWorkspaceAction({
      action: async () => 'ok',
      failureMessage: '新建画布失败',
      logContext: '新建画布',
      onErrorMessage: (message) => { errors.push(message) },
      onLogError: () => undefined,
    })

    expect(result).toBe('ok')
    expect(errors).toEqual([])
  })
})
