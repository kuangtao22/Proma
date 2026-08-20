import { describe, expect, test } from 'bun:test'
import { createDataRootStartupRouter } from './data-root-startup-routing'

describe('数据根启动路由', () => {
  test('Given 启动模式尚未判定 When second-instance 带 planning 参数 Then 不进入普通窗口', () => {
    /** 记录门控前不应发生的窗口动作。 */
    const calls: string[] = []
    const router = createDataRootStartupRouter({
      hasOpenPlanningArgument: () => true,
      showPlanningWindow: () => { calls.push('planning') },
      showMainWindow: () => { calls.push('main') },
      showPathManagementWindow: () => { calls.push('path') },
    })

    router.handleSecondInstance(['--open-planning'])
    expect(calls).toEqual([])
    router.resolveMode('data-root-recovery')
    expect(calls).toEqual(['path'])
  })

  test('Given recovery 模式 When second-instance 带 planning 参数 Then 只聚焦路径窗口', () => {
    /** 记录 non-normal 模式唯一允许的窗口动作。 */
    const calls: string[] = []
    const router = createDataRootStartupRouter({
      hasOpenPlanningArgument: () => true,
      showPlanningWindow: () => { calls.push('planning') },
      showMainWindow: () => { calls.push('main') },
      showPathManagementWindow: () => { calls.push('path') },
    })

    router.resolveMode('data-root-recovery')
    router.handleSecondInstance(['--open-planning'])
    expect(calls).toEqual(['path'])
  })

  test('Given migration 模式且窗口已关闭 When second-instance 到达 Then 重建路径窗口', () => {
    /** 记录路径窗口创建或聚焦动作。 */
    const calls: string[] = []
    const router = createDataRootStartupRouter({
      hasOpenPlanningArgument: () => false,
      showPlanningWindow: () => { calls.push('planning') },
      showMainWindow: () => { calls.push('main') },
      showPathManagementWindow: (mode) => { calls.push(`path:${mode}`) },
    })

    router.resolveMode('data-root-migration')
    router.handleSecondInstance([])
    expect(calls).toEqual(['path:data-root-migration'])
  })

  test('Given normal 模式 When second-instance 带 planning 参数 Then 保留规划入口', () => {
    /** 记录 normal 模式的规划窗口动作。 */
    const calls: string[] = []
    const router = createDataRootStartupRouter({
      hasOpenPlanningArgument: () => true,
      showPlanningWindow: () => { calls.push('planning') },
      showMainWindow: () => { calls.push('main') },
      showPathManagementWindow: () => { calls.push('path') },
    })

    router.resolveMode('normal')
    router.handleSecondInstance(['--open-planning'])
    expect(calls).toEqual(['planning'])
  })
})
