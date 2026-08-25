import { describe, expect, test } from 'bun:test'
import type { CanvasSessionMeta } from '@proma/shared'
import { createStore } from 'jotai'
import {
  activeCanvasSelectionAtom,
  canvasSessionsByProjectAtom,
  replaceCanvasSessionsAtom,
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
})
