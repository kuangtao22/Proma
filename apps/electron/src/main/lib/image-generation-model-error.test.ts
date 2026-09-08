import { describe, expect, test } from 'bun:test'
import { runSafeImageModelOperation } from './image-generation-model-error'
import { MediaWorkflowValidationError } from './media/media-workflow-error'

describe('生图工作流校验错误边界', () => {
  test('Given 可信工作流校验失败 When 经过模型目录包装 Then 保留可供原卡片持久化的错误实例', () => {
    /** 错误类只公开白名单原因，底层诊断不随 message 流出。 */
    const issue = new MediaWorkflowValidationError([
      { code: 'INPUT_REQUIRED', nodeId: '12', input: 'image', message: 'Bearer secret' },
    ])
    expect(() => runSafeImageModelOperation(() => { throw issue }, '模型不可用', () => undefined)).toThrow(issue)
    try { runSafeImageModelOperation(() => { throw issue }, '模型不可用', () => undefined) }
    catch (error) {
      expect(error).toBe(issue)
      expect((error as Error).message).not.toContain('Bearer secret')
    }
  })

  test('Given 普通异常伪造工作流错误前缀 When 经过模型目录包装 Then 不回显原始正文', () => {
    /** 前缀相同的普通 Error 不具备可信结构错误身份。 */
    const error = new Error('MEDIA_WORKFLOW_INVALID:Bearer secret')
    expect(() => runSafeImageModelOperation(() => { throw error }, '模型不可用', () => undefined))
      .toThrow('模型不可用')
  })
})
