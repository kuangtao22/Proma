import { describe, expect, test } from 'bun:test'
import {
  getNativeCanvasDeleteDialogCopy,
  isNativeCanvasDeleteShortcut,
} from './NativeCanvasDeleteDialog'

describe('原生 Canvas 删除确认', () => {
  test('Given 选中节点有两条关联边 When 请求删除 Then 说明关联边和 Agent 对话保留', () => {
    expect(getNativeCanvasDeleteDialogCopy('首页设计', 2, false)).toEqual({
      title: '删除“首页设计”？',
      edgeMessage: '将同时删除 2 条关联连线。',
      retentionMessage: 'Agent 对话记录会保留。',
      confirmLabel: '删除节点',
    })
  })

  test('Given 运行中节点 When 请求删除 Then 明确先停止再删除', () => {
    expect(getNativeCanvasDeleteDialogCopy('研究 Agent', 0, true)).toMatchObject({
      edgeMessage: '此节点没有关联连线。',
      confirmLabel: '停止后删除',
    })
  })

  test('Given Delete 或 Backspace When 焦点位于编辑器 Then 不触发画布删除', () => {
    expect(isNativeCanvasDeleteShortcut({ key: 'Delete', target: null })).toBe(true)
    expect(isNativeCanvasDeleteShortcut({
      key: 'Backspace',
      target: { closest: () => ({}) },
    })).toBe(false)
    expect(isNativeCanvasDeleteShortcut({ key: 'Enter', target: null })).toBe(false)
  })
})
