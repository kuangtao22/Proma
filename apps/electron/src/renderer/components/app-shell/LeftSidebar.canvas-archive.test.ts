import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

describe('侧栏归档 Canvas 分组', () => {
  test('Given Agent 归档异步加载 When 组装归档列表 Then Canvas 分组保持在 Agent 历史之前', () => {
    /** 读取真实侧栏实现，锁定虚拟列表的稳定分组顺序。 */
    const source = readFileSync(new URL('./LeftSidebar.tsx', import.meta.url), 'utf8')
    /** 仅检查 Agent 归档列表 memo，避免被其它 Canvas 展示入口干扰。 */
    const rowsStart = source.indexOf('const agentArchivedVirtualRows')
    const rowsEnd = source.indexOf('const agentActiveVirtualRows', rowsStart)
    const archivedRowsSource = source.slice(rowsStart, rowsEnd)

    expect(archivedRowsSource.indexOf("id: 'canvas-archived-heading'"))
      .toBeLessThan(archivedRowsSource.indexOf('id: `agent-archived-date-${group.label}`'))
  })
})
