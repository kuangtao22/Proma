import { describe, expect, test } from 'bun:test'
import { runShutdownCleanupSteps } from './shutdown-cleanup'

describe('应用退出清理编排', () => {
  test('Given Design 中断写入失败 When 执行退出清理 Then 记录错误并继续所有关键清理', () => {
    const effects: string[] = []
    const errors: string[] = []

    runShutdownCleanupSteps([
      {
        name: 'Design Job 中断',
        run: () => {
          effects.push('design')
          throw new Error('journal 写入失败')
        },
      },
      { name: 'Agent', run: () => { effects.push('agents') } },
      { name: '浏览器', run: () => { effects.push('browser') } },
      { name: '工作区监听', run: () => { effects.push('watcher') } },
    ], (message) => { errors.push(message) })

    expect(effects).toEqual(['design', 'agents', 'browser', 'watcher'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Design Job 中断')
    expect(errors[0]).toContain('journal 写入失败')
  })
})
