import { describe, expect, test } from 'bun:test'
import { createServerOpsLocalSqliteDragController } from './server-ops-local-sqlite-drag'
import type { ServerOpsLocalSqliteDragEvent } from './server-ops-local-sqlite-drag'

/** 模拟浏览器文件拖拽，记录默认导航与冒泡是否被阻止。 */
function createDragEvent(files: File[] = [], types = ['Files']): ServerOpsLocalSqliteDragEvent & { prevented: boolean; stopped: boolean } {
  return { dataTransfer: { files, types, dropEffect: 'none' }, prevented: false, stopped: false,
    preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
}

describe('运维整面板 SQLite 拖拽', () => {
  test('Given 文件拖入嵌套卡片 When 穿过子元素再离开面板 Then 提示不会闪烁且最终隐藏', () => {
    /** 只记录可见状态的实际变化。 */
    const states: boolean[] = []
    const controller = createServerOpsLocalSqliteDragController({ isEnabled: () => true, isBusy: () => false, onDraggingChange: (value) => states.push(value), onFiles: () => undefined })
    controller.enter(createDragEvent())
    controller.enter(createDragEvent())
    controller.leave()
    expect(states).toEqual([true])
    controller.leave()
    controller.leave()
    expect(states).toEqual([true, false])
  })

  test('Given 文件在任意面板子区域松开 When 接收拖放 Then 阻止默认导航并只交付这批原生文件一次', () => {
    /** 业务层负责解析路径，拖拽层不读取文件正文。 */
    const file = new File(['synthetic'], 'audit.sqlite')
    const received: File[][] = []
    const states: boolean[] = []
    const controller = createServerOpsLocalSqliteDragController({ isEnabled: () => true, isBusy: () => false, onDraggingChange: (value) => states.push(value), onFiles: (files) => received.push([...files]) })
    const event = createDragEvent([file])
    controller.enter(event)
    controller.over(event)
    expect(event.dataTransfer.dropEffect).toBe('copy')
    controller.drop(event)
    expect(event.prevented && event.stopped).toBe(true)
    expect(received).toEqual([[file]])
    expect(states).toEqual([true, false])
  })

  test('Given 拖入普通文本或拖拽期间切换项目 When 重置上下文 Then 文本不被劫持且旧提示被清理', () => {
    const states: boolean[] = []
    const controller = createServerOpsLocalSqliteDragController({ isEnabled: () => true, isBusy: () => false, onDraggingChange: (value) => states.push(value), onFiles: () => { throw new Error('不应导入') } })
    const text = createDragEvent([], ['text/plain'])
    controller.enter(text)
    controller.over(text)
    controller.drop(text)
    expect(text.prevented || text.stopped).toBe(false)
    expect(states).toEqual([])
    controller.enter(createDragEvent())
    controller.reset()
    expect(states).toEqual([true, false])
  })

  test('Given 面板失活或已有导入 When 松开文件 Then 阻止浏览器跳转但不发起重复导入', () => {
    let enabled = true
    let busy = false
    const received: File[][] = []
    const controller = createServerOpsLocalSqliteDragController({ isEnabled: () => enabled, isBusy: () => busy, onDraggingChange: () => undefined, onFiles: (files) => received.push([...files]) })
    for (const state of [{ enabled: false, busy: false }, { enabled: true, busy: true }]) {
      enabled = state.enabled
      busy = state.busy
      const event = createDragEvent([new File([], 'audit.db')])
      controller.over(event)
      controller.drop(event)
      expect(event.dataTransfer.dropEffect).toBe('none')
      expect(event.prevented && event.stopped).toBe(true)
    }
    expect(received).toEqual([])
  })
})
