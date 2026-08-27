import { describe, expect, test } from 'bun:test'
import type { CanvasDocument, CanvasTrashEntry } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  NativeCanvasTrashEntries,
  createNativeCanvasTrashController,
  resolveNativeCanvasTrashRestorePosition,
} from './NativeCanvasTrashDialog'

/** 创建文档回收条目，保持测试身份稳定。 */
function createTrashEntry(): CanvasTrashEntry {
  return {
    schemaVersion: 1,
    trashId: 'trash-1',
    nodeId: 'document-1',
    kind: 'document',
    contentId: 'content-1',
    title: '需求文档',
    position: { x: 40, y: 80 },
    deletedRevision: 3,
    deletedAt: Date.UTC(2026, 7, 28, 8, 0),
  }
}

describe('原生 Canvas 回收区', () => {
  test('Given 弹窗关闭 When 创建控制器 Then 不加载回收列表', () => {
    let calls = 0
    createNativeCanvasTrashController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      listTrash: async () => { calls += 1; return [] },
      restoreNode: async () => { throw new Error('not called') },
      createId: () => 'operation-1',
      getDocument: () => ({
        schemaVersion: 2, projectId: 'project-1', canvasId: 'canvas-1', revision: 1,
        createdAt: 1, updatedAt: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
      }),
      getEmptyCanvasCenter: () => ({ x: 0, y: 0 }),
      onStateChange: () => undefined,
      onRestored: () => undefined,
    })
    expect(calls).toBe(0)
  })

  test('Given 原位置被占用 When 恢复 Then 显式使用全局最右追加位置', () => {
    const entry = createTrashEntry()
    const document: CanvasDocument = {
      schemaVersion: 2,
      projectId: 'project-1',
      canvasId: 'canvas-1',
      revision: 4,
      createdAt: 1,
      updatedAt: 2,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{
        id: 'agent-1', kind: 'agent', title: 'Agent', agentSessionId: 'session-1',
        position: { ...entry.position },
      }],
      edges: [],
    }
    expect(resolveNativeCanvasTrashRestorePosition(entry, document, { x: 0, y: 0 }))
      .not.toEqual(entry.position)
  })

  test('Given 回收列表已加载 When 渲染 Then 展示类型、标题和删除时间', () => {
    const html = renderToStaticMarkup(
      <NativeCanvasTrashEntries
        entries={[createTrashEntry()]}
        loading={false}
        restoringTrashId={null}
        error={null}
        onRestore={() => undefined}
      />,
    )
    expect(html).toContain('文档')
    expect(html).toContain('需求文档')
    expect(html).toContain('2026')
  })

  test('Given 单项恢复失败 When 展示错误 Then 保留条目和恢复入口以便重试', () => {
    const html = renderToStaticMarkup(
      <NativeCanvasTrashEntries
        entries={[createTrashEntry()]}
        loading={false}
        restoringTrashId={null}
        error="节点恢复失败，请重试。"
        onRestore={() => undefined}
      />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('需求文档')
    expect(html).toContain('aria-label="恢复 需求文档"')
  })

  test('Given 恢复首次失败 When 重试 Then 完整复用操作身份并只选择恢复节点', async () => {
    const entry = createTrashEntry()
    const inputs: unknown[] = []
    const restored: string[] = []
    let attempt = 0
    const controller = createNativeCanvasTrashController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      listTrash: async () => [entry],
      restoreNode: async (input) => {
        inputs.push(input)
        attempt += 1
        if (attempt === 1) throw new Error('restore failed')
        return {
          snapshot: {
            document: {
              schemaVersion: 2, projectId: 'project-1', canvasId: 'canvas-1', revision: 5,
              createdAt: 1, updatedAt: 2, viewport: { x: 10, y: 20, zoom: 1.2 }, nodes: [], edges: [],
            },
            writable: true,
            nodeIssues: [],
          },
          selectedNodeId: entry.nodeId,
        }
      },
      createId: () => 'operation-1',
      getDocument: () => ({
        schemaVersion: 2, projectId: 'project-1', canvasId: 'canvas-1', revision: 4,
        createdAt: 1, updatedAt: 1, viewport: { x: 10, y: 20, zoom: 1.2 }, nodes: [], edges: [],
      }),
      getEmptyCanvasCenter: () => ({ x: 0, y: 0 }),
      onStateChange: () => undefined,
      onRestored: (_result, nodeId) => restored.push(nodeId),
    })

    await controller.load()
    await controller.restore(entry)
    await controller.restore(entry)

    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toEqual(inputs[0])
    expect(inputs[0]).toMatchObject({
      trashId: 'trash-1', expectedRevision: 4, position: entry.position,
    })
    expect(restored).toEqual(['document-1'])
  })
})
