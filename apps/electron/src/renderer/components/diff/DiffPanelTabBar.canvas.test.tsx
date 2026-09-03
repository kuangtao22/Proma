import { describe, expect, test } from 'bun:test'

describe('右侧工作区顶部加号菜单', () => {
  test('Given 顶部加号菜单 When 检查入口所有权 Then 最后一项只提供打开画布入口', async () => {
    /** 读取真实组件源文件，锁定顶部只负责进入画布，管理能力仍归属 Canvas Pane。 */
    const source = await Bun.file(new URL('./DiffPanelTabBar.tsx', import.meta.url)).text()

    expect(source).toContain('新建浏览器标签')
    expect(source).toContain('打开文件')
    expect(source).toContain('onOpenCanvas?:')
    expect(source).toContain('openCanvasDisabled?:')
    expect(source).toContain('打开画布')
    expect(source.indexOf('打开画布')).toBeGreaterThan(source.indexOf('打开 {OBSIDIAN_NAME}'))
    expect(source).not.toContain('新建画布')
    expect(source).not.toContain('现有画布')
    expect(source).not.toContain('canvasSessions?:')
    expect(source).not.toContain('onRenameCanvas?:')
  })
})
