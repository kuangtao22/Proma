import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('Given 展开的 macOS Agent Island When 检查视觉层级 Then 外壳只有一道描边且计划区不再嵌套卡片', () => {
  /** 原生 Island Swift 源码，用于锁定透明窗口的视觉合成合同。 */
  const source = readFileSync(resolve(import.meta.dir, '../native/agent-island/macos-agent-island-helper.swift'), 'utf8')
  /** 计划区组件源码，确保其只负责内容排版，不再绘制第二层容器。 */
  const planningColumn = source.slice(
    source.indexOf('struct PlanningColumn<Content: View>: View'),
    source.indexOf('struct IslandRootView: View'),
  )
  /** 展开态外壳源码，确保只保留一条稳定轮廓线。 */
  const expandedOutline = source.slice(
    source.indexOf('if expanded {', source.indexOf('struct IslandRootView: View')),
    source.indexOf('} else if hovered {', source.indexOf('struct IslandRootView: View')),
  )

  expect(expandedOutline.match(/outline\.stroke/g)).toHaveLength(1)
  expect(planningColumn).not.toContain('.compositingGroup()')
  expect(planningColumn).not.toContain('.clipShape(')
  expect(planningColumn).not.toContain('.background(')
  expect(planningColumn).not.toContain('.overlay(')
})

test('Given 原生面板持续接收运行快照 When 面板已经可见 Then 不重复置顶且隐藏时仍正常移出', () => {
  /** 原生 Island Swift 源码，用于约束 NSPanel 的可见性生命周期。 */
  const source = readFileSync(resolve(import.meta.dir, '../native/agent-island/macos-agent-island-helper.swift'), 'utf8')
  /** 面板展示分支源码，覆盖持续更新和隐藏两个主要边界。 */
  const visibilityBranch = source.slice(
    source.indexOf('panel.ignoresMouseEvents = !message.state.visible'),
    source.indexOf('\n  }', source.indexOf('panel.ignoresMouseEvents = !message.state.visible')),
  )

  expect(visibilityBranch).toContain('if !panel.isVisible { panel.orderFrontRegardless() }')
  expect(visibilityBranch).toContain('else if panel.isVisible { panel.orderOut(nil) }')
  expect(visibilityBranch).not.toContain('if message.state.visible { panel.orderFrontRegardless() }')
})
