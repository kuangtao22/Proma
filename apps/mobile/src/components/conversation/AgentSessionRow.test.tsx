import { describe, expect, test } from 'bun:test'
import { isValidElement } from 'react'
import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConvItem } from '../../atoms'
import { AgentSessionRow } from './AgentSessionRow'

/** 按 aria-label 深度查找无 Hook 组件返回的 React 元素。 */
function findByAriaLabel(node: ReactNode, label: string): ReactElement | null {
  if (!isValidElement(node)) return null
  /** 被测元素属性只读取通用可访问字段和子节点。 */
  const props = node.props as { 'aria-label'?: string; children?: ReactNode }
  if (props['aria-label'] === label) return node
  /** React 子节点统一转为数组后递归查找。 */
  const children = Array.isArray(props.children) ? props.children : [props.children]
  for (const child of children) {
    const matched = findByAriaLabel(child, label)
    if (matched) return matched
  }
  return null
}

/** 创建带指定四态的 Agent 会话。 */
function createSession(runtimeStatus: ConvItem['runtimeStatus'], starred = false): ConvItem {
  return {
    id: 'agent-1',
    title: '修复移动端恢复逻辑',
    type: 'agent',
    runtimeStatus,
    starred,
    updatedAt: Date.now(),
  }
}

describe('移动端 Agent 会话行', () => {
  test('Given 四种运行状态 When 渲染 Then 色块提供对应中文语义', () => {
    /** 四态与读屏名称必须保持一一对应。 */
    const cases: Array<[ConvItem['runtimeStatus'], string]> = [
      ['running', '运行中'],
      ['blocked', '等待处理'],
      ['completed', '已完成未查看'],
      ['idle', '空闲'],
    ]

    for (const [runtimeStatus, label] of cases) {
      const markup = renderToStaticMarkup(
        <AgentSessionRow
          session={createSession(runtimeStatus)}
          active={false}
          onOpen={() => undefined}
          onToggleStar={() => undefined}
        />,
      )
      expect(markup).toContain(`aria-label="${label}"`)
      expect(markup).toContain('data-agent-session-row="four-column"')
    }
  })

  test('Given 已星标会话 When 渲染 Then 五角星位于时间之前且保留操作语义', () => {
    /** 静态标记用于验证稳定列顺序。 */
    const markup = renderToStaticMarkup(
      <AgentSessionRow
        session={createSession('running', true)}
        active={false}
        onOpen={() => undefined}
        onToggleStar={() => undefined}
      />,
    )

    expect(markup).toContain('aria-label="取消星标"')
    expect(markup).toContain('fill="currentColor"')
    expect(markup).toContain('grid-cols-[8px_minmax(0,1fr)_44px_44px]')
    expect(markup.indexOf('aria-label="取消星标"')).toBeLessThan(markup.indexOf('data-session-time'))
  })

  test('Given 会话行 When 点击星标 Then 只切换星标而不打开会话', () => {
    /** 打开次数用于证明星标操作与主按钮隔离。 */
    let openCount = 0
    /** 星标次数用于证明操作被提交。 */
    let starCount = 0
    /** 组件没有 Hook，可直接检查返回元素的真实事件处理器。 */
    const row = AgentSessionRow({
      session: createSession('idle'),
      active: false,
      onOpen: () => { openCount += 1 },
      onToggleStar: () => { starCount += 1 },
    })
    /** 未星标时按钮使用“添加星标”名称。 */
    const starButton = findByAriaLabel(row, '添加星标')
    /** 事件处理器只需要 stopPropagation 边界。 */
    const event = { stopPropagation: () => undefined } as unknown as MouseEvent<HTMLButtonElement>

    expect(starButton).not.toBeNull()
    ;(starButton?.props as { onClick?: (event: MouseEvent<HTMLButtonElement>) => void }).onClick?.(event)
    expect(starCount).toBe(1)
    expect(openCount).toBe(0)
  })
})
