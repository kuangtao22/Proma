import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

describe('项目级 Agent 会话创建入口', () => {
  test('Given 普通项目行 When 点击加号 Then 直接创建该项目的 Agent 会话且不打开中间菜单', () => {
    // 读取真实侧边栏源码，锁定项目加号恢复官方的一键创建行为。
    const source = readFileSync(new URL('./LeftSidebar.tsx', import.meta.url), 'utf8')
    const entryStart = source.indexOf('aria-label={`在「${group.workspace.name}」中新建会话`}')
    const entryEnd = source.indexOf('</Tooltip>', entryStart)

    expect(entryStart).toBeGreaterThanOrEqual(0)
    expect(entryEnd).toBeGreaterThan(entryStart)

    const projectNewSessionEntry = source.slice(entryStart, entryEnd)
    expect(projectNewSessionEntry).toContain('void onNewSession(group.workspace.id)')
    expect(projectNewSessionEntry).not.toContain('DropdownMenuTrigger')
    expect(projectNewSessionEntry).not.toContain('DropdownMenuContent')
  })
})
