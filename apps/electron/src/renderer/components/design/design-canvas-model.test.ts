import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { DesignAsset, DesignCanvasNode } from '@proma/shared'
import {
  createMoveNodesMutation,
  createViewportMutation,
  toFlowNodes,
} from './design-canvas-model'
import { getDesignCanvasInteractionConfig } from './DesignCanvas'

/** 创建包含敏感原图路径的素材，验证 Renderer 节点不会携带该路径。 */
function createAsset(): DesignAsset {
  return {
    id: 'asset-1',
    filename: '原始海报.png',
    relativePath: 'assets/private/original-source.png',
    thumbnailRelativePath: 'thumbnails/preview a.webp',
    mediaType: 'image/png',
    width: 1600,
    height: 1200,
    byteSize: 2048,
    sha256: 'sha256-secret',
    createdAt: 100,
  }
}

/** 创建指定业务类型的固定尺寸画布节点。 */
function createNode(overrides: Partial<DesignCanvasNode>): DesignCanvasNode {
  return {
    id: 'node-1',
    kind: 'asset',
    assetId: 'asset-1',
    position: { x: 24, y: 48 },
    width: 320,
    height: 240,
    zIndex: 3,
    ...overrides,
  }
}

describe('Design 画布节点映射', () => {
  test('Given 素材节点 When 映射到 XYFlow Then 只公开编码后的缩略图 URL 和展示字段', () => {
    /** 带素材节点的测试文档。 */
    const document = createEmptyDesignDocument('project-1', 100)
    document.assets = [createAsset()]
    document.nodes = [createNode({})]

    const nodes = toFlowNodes(document, { thumbnailBaseUrl: 'proma-file://thumbs/' })
    const serialized = JSON.stringify(nodes)

    expect(nodes[0]).toMatchObject({
      id: 'node-1',
      type: 'designAsset',
      position: { x: 24, y: 48 },
      width: 320,
      height: 240,
      selectable: true,
      draggable: true,
      connectable: false,
      data: {
        kind: 'asset',
        status: 'success',
        assetId: 'asset-1',
        title: '原始海报.png',
        pixelWidth: 1600,
        pixelHeight: 1200,
        previewUrl: 'proma-file://thumbs/preview%20a.webp',
      },
    })
    expect(serialized).not.toContain(document.assets[0]!.relativePath)
    expect(serialized).not.toContain(document.assets[0]!.thumbnailRelativePath)
    expect(serialized).not.toContain('sha256-secret')
  })

  test('Given 缺失素材和任务节点 When 映射 Then 使用稳定缺失态与任务排队态', () => {
    /** 不含素材记录、但同时存在素材与任务节点的测试文档。 */
    const document = createEmptyDesignDocument('project-1', 100)
    document.nodes = [
      createNode({ id: 'missing-node', assetId: 'missing-asset' }),
      createNode({ id: 'job-node', kind: 'job', assetId: undefined, jobId: 'job-1' }),
    ]

    const nodes = toFlowNodes(document, { thumbnailBaseUrl: 'proma-file://thumbs' })

    expect(nodes[0]?.data).toEqual({
      kind: 'asset',
      status: 'missing',
      assetId: 'missing-asset',
      title: '素材缺失',
    })
    expect(nodes[1]?.data).toEqual({
      kind: 'job',
      status: 'queued',
      jobId: 'job-1',
      title: '图片任务',
    })
  })

  test('Given 选择或平移工具 When 读取画布配置 Then 只允许选择模式拖动节点', () => {
    expect(getDesignCanvasInteractionConfig('select', true)).toEqual({
      selectionOnDrag: true,
      panOnDrag: [1, 2],
      nodesDraggable: true,
    })
    expect(getDesignCanvasInteractionConfig('pan', true)).toEqual({
      selectionOnDrag: false,
      panOnDrag: true,
      nodesDraggable: false,
    })
    expect(getDesignCanvasInteractionConfig('select', false).nodesDraggable).toBe(false)
  })

  test('Given 拖动结束和视口移动结束 When 构造保存输入 Then 各生成一个受控 mutation', () => {
    /** 拖动结束时 XYFlow 返回的最终节点位置。 */
    const movedNodes = [
      { id: 'node-1', position: { x: 20, y: 30 } },
      { id: 'node-2', position: { x: 40, y: 50 } },
    ]

    expect(createMoveNodesMutation(movedNodes)).toEqual({
      type: 'move-nodes',
      positions: [
        { nodeId: 'node-1', position: { x: 20, y: 30 } },
        { nodeId: 'node-2', position: { x: 40, y: 50 } },
      ],
    })
    expect(createViewportMutation({ x: 12, y: 18, zoom: 1.25 })).toEqual({
      type: 'set-viewport',
      viewport: { x: 12, y: 18, zoom: 1.25 },
    })
  })
})
