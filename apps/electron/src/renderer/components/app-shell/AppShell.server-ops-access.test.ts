import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('AppShell Server Ops 授权生命周期', () => {
  test('Given 运维页未挂载 When 当前 Agent 会话变化 Then 常驻 AppShell 仍驱动会话撤权守卫', () => {
    /** 直接验证常驻布局层接线，避免条件渲染的 SidePanel 成为授权生命周期 owner。 */
    const source = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8')
    /** 守卫实例化必须发生在组件返回 JSX 之前。 */
    const guardIndex = source.indexOf('createServerOpsAgentAccessSessionGuard({')
    /** 会话变化 effect 必须把当前会话交给常驻守卫。 */
    const selectIndex = source.indexOf('serverOpsAgentAccessSessionGuard.select(currentSessionId)')
    /** 条件渲染右侧工作区所在的 JSX 起点。 */
    const renderIndex = source.indexOf('\n  return (')

    expect(guardIndex).toBeGreaterThan(0)
    expect(selectIndex).toBeGreaterThan(guardIndex)
    expect(renderIndex).toBeGreaterThan(selectIndex)
  })
})
