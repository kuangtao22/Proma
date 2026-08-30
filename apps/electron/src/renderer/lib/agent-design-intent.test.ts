import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Agent 到 Design 的发送前意图判断', () => {
  test('Given 用户只表达视觉设计 When 判断 Then 应先询问是否打开设计面板', async () => {
    /** 动态加载让 RED 阶段以明确断言失败，而不是被缺失模块中断。 */
    const intentModule = await import('./agent-design-intent').catch(() => undefined)

    expect(intentModule?.shouldOfferDesignHandoff).toBeFunction()
    if (!intentModule) return

    expect(intentModule.shouldOfferDesignHandoff('设计首页')).toBe(true)
    expect(intentModule.shouldOfferDesignHandoff('帮我生成当前项目首页效果图')).toBe(true)
    expect(intentModule.shouldOfferDesignHandoff('给这个产品画一版落地页视觉稿')).toBe(true)
    expect(intentModule.shouldOfferDesignHandoff('Create a homepage mockup for this project')).toBe(true)
  })

  test('Given 用户明确要求代码实现或普通分析 When 判断 Then 不打断 Agent', async () => {
    const intentModule = await import('./agent-design-intent').catch(() => undefined)

    expect(intentModule?.shouldOfferDesignHandoff).toBeFunction()
    if (!intentModule) return

    expect(intentModule.shouldOfferDesignHandoff('请修改代码实现首页')).toBe(false)
    expect(intentModule.shouldOfferDesignHandoff('设计并开发 React 首页')).toBe(false)
    expect(intentModule.shouldOfferDesignHandoff('分析首页为什么加载很慢')).toBe(false)
    expect(intentModule.shouldOfferDesignHandoff('修复首页白屏问题')).toBe(false)
  })

  test('Given 会话项目与全局项目不同 When 打开设计 handoff Then 先建立关联再聚焦右侧 Canvas', () => {
    const source = readFileSync(join(import.meta.dir, '../components/agent/AgentView.tsx'), 'utf8')
    const handlerStart = source.indexOf('const handleOpenDesignHandoff')
    const handlerEnd = source.indexOf('/** 停止生成', handlerStart)
    const handlerBody = source.slice(handlerStart, handlerEnd)
    const canvasBindingIndex = handlerBody.indexOf('designAdapter.linkAgentCanvas({')
    const projectSwitchIndex = handlerBody.indexOf('setCurrentAgentWorkspaceId(currentWorkspaceId)')
    const canvasTabIndex = handlerBody.indexOf('getCanvasWorkspaceTab(LEGACY_DESIGN_CANVAS_ID)')

    expect(handlerStart).toBeGreaterThan(-1)
    expect(canvasBindingIndex).toBeGreaterThan(-1)
    expect(projectSwitchIndex).toBeGreaterThan(canvasBindingIndex)
    expect(canvasTabIndex).toBeGreaterThan(projectSwitchIndex)
    expect(handlerBody).not.toContain("setActiveView('design')")
  })
})
