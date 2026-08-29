import { describe, expect, test } from 'bun:test'
import {
  getNativeCanvasDeleteDialogCopy,
  isNativeCanvasDeleteShortcut,
} from './NativeCanvasDeleteDialog'

describe('原生 Canvas 删除确认', () => {
  test('Given 选中节点有两条关联边 When 请求删除 Then 说明关联边和 Agent 对话保留', () => {
    expect(getNativeCanvasDeleteDialogCopy('首页设计', 2, false, 'agent')).toEqual({
      title: '删除“首页设计”？',
      edgeMessage: '将同时删除 2 条关联连线。',
      retentionMessage: 'Agent 对话记录会保留。',
      confirmLabel: '删除节点',
    })
  })

  test('Given 运行中节点 When 请求删除 Then 明确先停止再删除', () => {
    expect(getNativeCanvasDeleteDialogCopy('研究 Agent', 0, true, 'agent')).toMatchObject({
      edgeMessage: '此节点没有关联连线。',
      confirmLabel: '停止后删除',
    })
  })

  test('Given 选中内容节点 When 请求删除 Then 说明内容可从回收区恢复', () => {
    expect(getNativeCanvasDeleteDialogCopy('需求文档', 1, false, 'document')).toMatchObject({
      title: '删除“需求文档”？',
      retentionMessage: '内容将移入回收区，可稍后恢复。',
    })
  })

  test('Given 混合框选三个节点 When 请求删除 Then 汇总节点、连线和内容保留边界', () => {
    expect(getNativeCanvasDeleteDialogCopy(
      '首页设计',
      4,
      false,
      'agent',
      { count: 3, hasAgent: true, hasContent: true },
    )).toMatchObject({
      title: '删除 3 个节点？',
      edgeMessage: '将同时删除 4 条关联连线。',
      retentionMessage: 'Agent 对话记录会保留；其他内容将移入回收区，可稍后恢复。',
      confirmLabel: '删除节点',
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
