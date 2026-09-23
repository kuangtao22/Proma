import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

describe('删除 Agent 会话后的浏览器收尾', () => {
  test('Given 主进程确认单会话删除成功 When renderer 收尾 Then 才清理对应浏览器状态', () => {
    const source = readFileSync(new URL('./LeftSidebar.tsx', import.meta.url), 'utf8')
    const handlerStart = source.indexOf('const handleConfirmDelete = async')
    const handlerEnd = source.indexOf('/** 请求重命名', handlerStart)
    const handler = source.slice(handlerStart, handlerEnd)
    const deleteIndex = handler.indexOf('await window.electronAPI.deleteAgentSession(sessionId)')
    const cleanupIndex = handler.indexOf('cleanupMapAtoms(sessionId)', deleteIndex)

    expect(source).toContain('clearBrowserSessionState(id)')
    expect(deleteIndex).toBeGreaterThanOrEqual(0)
    expect(cleanupIndex).toBeGreaterThan(deleteIndex)
  })

  test('Given 级联删除中部分子会话失败 When renderer 收尾 Then 只清理确认删除成功的子会话', () => {
    const source = readFileSync(new URL('./LeftSidebar.tsx', import.meta.url), 'utf8')
    const handlerStart = source.indexOf('const handleConfirmDelete = async')
    const handlerEnd = source.indexOf('/** 请求重命名', handlerStart)
    const handler = source.slice(handlerStart, handlerEnd)

    expect(handler).toContain('successfulChildIds.push(childId)')
    expect(handler).toContain('closeArchivedAgentTabs(successfulChildIds)')
  })
})
