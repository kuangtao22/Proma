import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiCatalogDrawer } from './ApiCatalogDrawer'

/** 渲染抽屉；关闭时不占用任何空间。 */
function render(open: boolean): string {
  return renderToStaticMarkup(<ApiCatalogDrawer open={open} onClose={() => undefined}><p>目录内容</p></ApiCatalogDrawer>)
}

describe('窄栏目录抽屉', () => {
  test('Given 抽屉关闭 When 渲染 Then 不产生任何节点', () => {
    expect(render(false)).toBe('')
  })

  test('Given 抽屉展开 When 渲染 Then 面板与遮罩都在工作台容器内绝对定位', () => {
    const html = render(true)

    expect(html).toContain('目录内容')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="接口目录"')
    /** 关键：容器内绝对定位，而不是通用 Sheet 的 fixed 全窗锚定（否则会飞到窗口最左侧）。 */
    expect(html).toContain('absolute inset-y-0 left-0')
    expect(html).not.toContain('fixed inset-y-0 left-0')
    /** 遮罩可点击关闭，键盘用户还能用 Esc。 */
    expect(html).toContain('aria-label="关闭接口目录"')
  })
})
