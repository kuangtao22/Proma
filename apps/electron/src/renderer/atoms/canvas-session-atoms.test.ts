import { describe, expect, test } from 'bun:test'
import type { CanvasSessionMeta } from '@proma/shared'
import { createStore } from 'jotai'
import {
  canvasSessionsByProjectAtom,
  removeCanvasSessionAtom,
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

  test('Given 跨项目元数据 When 替换项目 registry Then 拒绝污染目标项目', () => {
    const store = createStore()

    expect(() => store.set(replaceCanvasSessionsAtom, {
      projectId: 'project-a',
      sessions: [createCanvas('b-1', 'project-b')],
    })).toThrow('Canvas 会话项目归属不匹配')
  })

  test('Given 项目内已有 Canvas When upsert 新版本 Then 按更新时间倒序且不重复 ID', () => {
    const store = createStore()
    store.set(canvasSessionsByProjectAtom, new Map([[
      'project-a',
      [createCanvas('a-1', 'project-a'), createCanvas('a-2', 'project-a', { updatedAt: 2 })],
    ]]))

    store.set(upsertCanvasSessionAtom, createCanvas('a-1', 'project-a', { updatedAt: 3 }))

    expect(store.get(canvasSessionsByProjectAtom).get('project-a')?.map((item) => item.id))
      .toEqual(['a-1', 'a-2'])
  })

  test('Given 两个项目 When 删除目标 Canvas Then 只移除目标项目记录', () => {
    const store = createStore()
    const projectA = [createCanvas('a-1', 'project-a'), createCanvas('a-2', 'project-a')]
    const projectB = [createCanvas('b-1', 'project-b')]
    store.set(canvasSessionsByProjectAtom, new Map([
      ['project-a', projectA],
      ['project-b', projectB],
    ]))

    store.set(removeCanvasSessionAtom, { projectId: 'project-a', canvasId: 'a-1' })

    expect(store.get(canvasSessionsByProjectAtom).get('project-a')?.map((item) => item.id)).toEqual(['a-2'])
    expect(store.get(canvasSessionsByProjectAtom).get('project-b')).toBe(projectB)
  })
})
