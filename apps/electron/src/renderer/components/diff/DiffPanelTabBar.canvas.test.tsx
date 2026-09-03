import { describe, expect, test } from 'bun:test'

describe('右侧工作区顶部加号菜单', () => {
  test('Given 顶部加号菜单 When 检查入口所有权 Then 不再包含画布管理', async () => {
    /** 读取真实组件源文件，锁定画布管理只能归属 Canvas Pane。 */
    const source = await Bun.file(new URL('./DiffPanelTabBar.tsx', import.meta.url)).text()

    expect(source).toContain('新建浏览器标签')
    expect(source).toContain('打开文件')
    expect(source).not.toContain('新建画布')
    expect(source).not.toContain('现有画布')
    expect(source).not.toContain('canvasSessions?:')
    expect(source).not.toContain('onRenameCanvas?:')
  })
})
