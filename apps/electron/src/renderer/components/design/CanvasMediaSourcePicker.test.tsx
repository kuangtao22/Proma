import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CanvasDocument } from '@proma/shared'
import { CanvasMediaSourcePicker, getCanvasMediaSourceNodes, previewForNode, selectCanvasMediaOutputs } from './CanvasMediaSourcePicker'

/** 使用真实画布合同，禁止类型断言掩盖schema错误。 */
const documentFixture: CanvasDocument = {
  schemaVersion: 4, projectId: 'p', canvasId: 'c', revision: 2,
  viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
    { id: 'agent', kind: 'agent', title: '提示词', position: { x: 0, y: 0 }, agentSessionId: 's' },
    { id: 'doc', kind: 'document', title: '动态词', position: { x: 0, y: 0 }, documentId: 'd', contentRevision: 1 },
    { id: 'image', kind: 'image', title: '首帧', position: { x: 0, y: 0 }, imageModuleId: 'm', adoptedAssetId: 'asset-1' },
    { id: 'video', kind: 'video', title: '视频', position: { x: 0, y: 0 }, mediaModuleId: 'media', adoptedConfigRevision: 1 },
  ], edges: [], createdAt: 1, updatedAt: 1,
}

describe('CanvasMediaSourcePicker', () => {
  test('按输入类型筛选来源并显示已授权缩略图', () => {
    expect(getCanvasMediaSourceNodes(documentFixture, 'image').map((node) => node.title)).toEqual(['首帧'])
    expect(previewForNode(documentFixture.nodes[2]!, [{ assetId: 'asset-1', previewUrl: 'thumb://1', width: 10, height: 10 }])?.previewUrl).toBe('thumb://1')
  })
  test('Given 音频视频或标量槽 When 筛选 Then 不混入图片并排除目标自身', () => {
    expect(getCanvasMediaSourceNodes(documentFixture, 'audio')).toEqual([])
    expect(getCanvasMediaSourceNodes(documentFixture, 'number')).toEqual([])
    expect(getCanvasMediaSourceNodes(documentFixture, 'video', 'video')).toEqual([])
  })

  test('文档来源使用固定 document.markdown 输出', () => {
    const changes: Array<{ nodeId: string; outputKey: string }> = []
    expect(getCanvasMediaSourceNodes(documentFixture, 'text').map((node) => node.title)).toEqual(['提示词', '动态词'])
    const html = renderToStaticMarkup(<CanvasMediaSourcePicker document={documentFixture} inputKind="text" value={{ nodeId: 'doc', outputKey: 'document.markdown' }} onChange={(value) => changes.push(value)} />)
    expect(html).toContain('document.markdown')
    expect(changes).toHaveLength(0)
  })

  test('Given AV声明多个同类型输出 When 列出 Then 保留所有真实key和角色供明确选择', () => {
    expect(selectCanvasMediaOutputs([
      { key: 'audio-main', mediaKind: 'audio' },
      { key: 'video-final', mediaKind: 'video', role: 'primary' },
      { key: 'video-alt', mediaKind: 'video', role: 'auxiliary' },
    ], 'video')).toEqual([{ key: 'video-final', mediaKind: 'video', role: 'primary' }, { key: 'video-alt', mediaKind: 'video', role: 'auxiliary' }])
    expect(selectCanvasMediaOutputs([{ key: 'custom', mediaKind: 'audio' }], 'video')).toEqual([])
  })

  test('旧来源不存在时显示失效提示', () => {
    const html = renderToStaticMarkup(<CanvasMediaSourcePicker document={documentFixture} inputKind="image" value={{ nodeId: 'deleted', outputKey: 'image.asset' }} onChange={() => undefined} />)
    expect(html).toContain('原来源节点已不存在')
  })
})
