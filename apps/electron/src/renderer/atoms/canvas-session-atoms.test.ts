import { describe, expect, test } from 'bun:test'
import type { CanvasSessionMeta } from '@proma/shared'
import { createStore } from 'jotai'
import {
  activeCanvasSelectionAtom,
  activeCanvasSessionAtom,
  canvasSessionsByProjectAtom,
  replaceCanvasSessionsAtom,
  removeCanvasSessionAtom,
  resolveActiveCanvasSession,
  upsertCanvasSessionAtom,
} from './canvas-session-atoms'

/** 构造测试使用的稳定 Canvas 会话。 */
function createCanvas(
  id: string,
  projectId: string,
  overrides: Partial<CanvasSessionMeta> = {},
): CanvasSessionMeta {
  return {
    id,
    projectId,
    title: `Canvas ${id}`,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('Canvas Renderer registry', () => {
  test('Given 两个项目 When 提交项目 A Canvas Then 项目 B 列表引用保持不变', () => {
    const store = createStore()
    /** 项目 B 的稳定列表用于验证局部更新不会复制无关项目。 */
    const projectB = [createCanvas('b-1', 'project-b')]
    store.set(canvasSessionsByProjectAtom, new Map([['project-b', projectB]]))

    store.set(replaceCanvasSessionsAtom, {
      projectId: 'project-a',
      sessions: [createCanvas('a-1', 'project-a')],
    })

    expect(store.get(canvasSessionsByProjectAtom).get('project-a')?.map((item) => item.id)).toEqual(['a-1'])
    expect(store.get(canvasSessionsByProjectAtom).get('project-b')).toBe(projectB)
  })

  test('Given 当前选择 When 更新其它项目 Canvas Then 选择保持 projectId 与 canvasId 双重身份', () => {
    const store = createStore()
    store.set(activeCanvasSelectionAtom, { projectId: 'project-a', canvasId: 'a-1' })

    store.set(upsertCanvasSessionAtom, createCanvas('b-1', 'project-b'))

    expect(store.get(activeCanvasSelectionAtom)).toEqual({
      projectId: 'project-a',
      canvasId: 'a-1',
    })
  })

  test('Given 当前 Canvas When 会话被归档 Then 清除选择但保留索引记录', () => {
    const store = createStore()
    const activeCanvas = createCanvas('a-1', 'project-a')
    store.set(canvasSessionsByProjectAtom, new Map([['project-a', [activeCanvas]]]))
    store.set(activeCanvasSelectionAtom, { projectId: 'project-a', canvasId: 'a-1' })

    store.set(upsertCanvasSessionAtom, { ...activeCanvas, archived: true, updatedAt: 2 })

    expect(store.get(activeCanvasSelectionAtom)).toBeNull()
    expect(store.get(canvasSessionsByProjectAtom).get('project-a')).toEqual([
      { ...activeCanvas, archived: true, updatedAt: 2 },
    ])
  })

  test('Given 当前 Canvas When 权威列表不再包含可见会话 Then 清除过期选择', () => {
    const store = createStore()
    store.set(activeCanvasSelectionAtom, { projectId: 'project-a', canvasId: 'a-1' })

    store.set(replaceCanvasSessionsAtom, {
      projectId: 'project-a',
      sessions: [createCanvas('a-1', 'project-a', { archived: true })],
    })

    expect(store.get(activeCanvasSelectionAtom)).toBeNull()
  })

  test('Given 当前 Canvas When 删除成功 Then 只移除目标项目记录并清除当前选择', () => {
    const store = createStore()
    const projectA = [createCanvas('a-1', 'project-a'), createCanvas('a-2', 'project-a')]
    const projectB = [createCanvas('b-1', 'project-b')]
    store.set(canvasSessionsByProjectAtom, new Map([
      ['project-a', projectA],
      ['project-b', projectB],
    ]))
    store.set(activeCanvasSelectionAtom, { projectId: 'project-a', canvasId: 'a-1' })

    store.set(removeCanvasSessionAtom, { projectId: 'project-a', canvasId: 'a-1' })

    expect(store.get(canvasSessionsByProjectAtom).get('project-a')?.map((item) => item.id)).toEqual(['a-2'])
    expect(store.get(canvasSessionsByProjectAtom).get('project-b')).toBe(projectB)
    expect(store.get(activeCanvasSelectionAtom)).toBeNull()
  })

  test('Given Agent 显式转交 legacy Design When 旧画布尚未落盘 Then 保留确定性兼容入口', () => {
    const store = createStore()
    const selection = { projectId: 'project-a', canvasId: 'legacy-design' }
    store.set(activeCanvasSelectionAtom, selection)

    store.set(replaceCanvasSessionsAtom, { projectId: 'project-a', sessions: [] })

    expect(store.get(activeCanvasSelectionAtom)).toEqual(selection)
    expect(resolveActiveCanvasSession(selection, store.get(canvasSessionsByProjectAtom))).toMatchObject({
      id: 'legacy-design',
      projectId: 'project-a',
      archived: false,
    })
  })

  test('Given legacy Design 已归档 When 解析迟到选择 Then 不生成虚拟兼容入口', () => {
    const store = createStore()
    const selection = { projectId: 'project-a', canvasId: 'legacy-design' }
    const archived = createCanvas('legacy-design', 'project-a', { archived: true })
    store.set(activeCanvasSelectionAtom, selection)
    store.set(canvasSessionsByProjectAtom, new Map([['project-a', [archived]]]))

    expect(resolveActiveCanvasSession(selection, new Map([['project-a', [archived]]]))).toBeNull()
    expect(store.get(activeCanvasSessionAtom)).toBeNull()
  })
})
