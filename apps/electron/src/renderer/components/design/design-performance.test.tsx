import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { DesignAsset, DesignCanvasNode, DesignMutation } from '@proma/shared'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInitialDesignProjectState, designProjectStatesAtom } from '@/atoms/design-atoms'
import { DesignCanvas } from './DesignCanvas'
import type { DesignCanvasFlowProps } from './DesignCanvas'
import { createMoveNodesMutation, toFlowNodes } from './design-canvas-model'
import { coalesceDesignMutationsForSave } from './use-design-workspace'

/** 创建大画布预算测试需要的安全素材元数据。 */
function createAsset(index: number): DesignAsset {
  return {
    id: `asset-${index}`,
    filename: `素材-${index}.png`,
    relativePath: `assets/original-${index}.png`,
    thumbnailRelativePath: `thumbnails/preview-${index}.webp`,
    mediaType: 'image/png',
    width: 1024,
    height: 768,
    byteSize: 1024,
    sha256: `hash-${index}`,
    createdAt: 1,
  }
}

/** 创建一千个稳定布局节点，避免测试本身携带二进制内容。 */
function createNode(index: number): DesignCanvasNode {
  return {
    id: `node-${index}`,
    kind: 'asset',
    assetId: `asset-${index}`,
    position: { x: (index % 40) * 340, y: Math.floor(index / 40) * 260 },
    width: 320,
    height: 240,
    zIndex: index,
  }
}

describe('Design 大画布性能预算', () => {
  test('Given 1,000 个素材节点 When 投影 XYFlow Then 仅使用缩略图且不暴露原图或 base64', () => {
    const document = createEmptyDesignDocument('project-1', 1)
    document.assets = Array.from({ length: 1_000 }, (_, index) => createAsset(index))
    document.nodes = Array.from({ length: 1_000 }, (_, index) => createNode(index))

    const nodes = toFlowNodes(document, { thumbnailBaseUrl: 'proma-file://thumbnail-token' })
    const serialized = JSON.stringify(nodes)

    expect(nodes).toHaveLength(1_000)
    expect(nodes.every((node) => node.data.previewUrl?.startsWith('proma-file://thumbnail-token/preview-'))).toBe(true)
    expect(serialized).not.toContain('data:image')
    expect(serialized).not.toContain('assets/original-')
  })

  test('Given 真实画布 When 构造 XYFlow props Then 只渲染可见节点', () => {
    const document = createEmptyDesignDocument('project-1', 1)
    document.assets = [createAsset(0)]
    document.nodes = [createNode(0)]
    const store = createStore()
    store.set(designProjectStatesAtom, new Map([['project-1', {
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: { document, writable: true },
    }]]))
    let captured: DesignCanvasFlowProps | undefined

    renderToStaticMarkup(
      <Provider store={store}>
        <DesignCanvas
          document={document}
          writable
          authoritativeRecoveryState="idle"
          activeTool="select"
          selectedNodeIds={[]}
          flowRenderer={(props) => { captured = props; return <div /> }}
        />
      </Provider>,
    )

    expect(captured?.onlyRenderVisibleElements).toBe(true)
  })

  test('Given 一次拖动 1,000 个节点 When 结束手势 Then 只生成一个 move-nodes mutation', () => {
    const mutation = createMoveNodesMutation(Array.from({ length: 1_000 }, (_, index) => ({
      id: `node-${index}`,
      position: { x: index, y: index + 1 },
    })))

    expect(mutation.type).toBe('move-nodes')
    expect(mutation.type === 'move-nodes' ? mutation.positions : []).toHaveLength(1_000)
  })

  test('Given 400ms 内连续 viewport 事件 When 形成保存批次 Then 只保留最后视口且不丢其它 mutation', () => {
    const mutations: DesignMutation[] = [
      { type: 'set-viewport', viewport: { x: 1, y: 1, zoom: 1 } },
      { type: 'move-nodes', positions: [{ nodeId: 'node-1', position: { x: 10, y: 20 } }] },
      { type: 'set-viewport', viewport: { x: 2, y: 3, zoom: 1.1 } },
      { type: 'set-viewport', viewport: { x: 8, y: 9, zoom: 1.5 } },
    ]

    expect(coalesceDesignMutationsForSave(mutations)).toEqual([
      { type: 'move-nodes', positions: [{ nodeId: 'node-1', position: { x: 10, y: 20 } }] },
      { type: 'set-viewport', viewport: { x: 8, y: 9, zoom: 1.5 } },
    ])
  })
})
