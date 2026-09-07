import { describe, expect, test } from 'bun:test'
import type { ComfyObjectInfo, MediaWorkflowDefinition } from '../../../../../../packages/shared/src/types/media-workflow'
import type { MediaAssetRef } from '../../../../../../packages/shared/src/types/media'
import { inspectMediaWorkflow, matchMediaWorkflowInputs } from './media-workflow-inspection'

const info: ComfyObjectInfo = { LoadImage: { input: { required: { image: ['STRING', { image_upload: true }] } }, output: ['IMAGE'] }, SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } }, output: [], output_node: true } }
const definition: MediaWorkflowDefinition = { schemaVersion: 1, prompt: { '1': { class_type: 'LoadImage', inputs: { image: 'x' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'x' } } }, bindings: [{ key: 'source', kind: 'image', nodeId: '1', input: 'image', loader: 'LoadImage' }], outputs: [{ key: 'result', nodeId: '2', outputIndex: 0, mediaType: 'image' }] }
const asset = (assetId: string): MediaAssetRef => ({ assetId, revision: 1, hash: assetId, mediaKind: 'image' })

describe('media workflow inspection', () => {
  test('分析节点、绑定、输出和校验问题', () => {
    const result = inspectMediaWorkflow(definition, info)
    expect(result.nodes.map((node) => node.nodeId)).toEqual(['1', '2'])
    expect(result.bindings[0]?.key).toBe('source')
    expect(result.outputs[0]?.key).toBe('result')
  })
  test('显式绑定优先且同素材可绑定多个槽', () => {
    const two: MediaWorkflowDefinition = { ...definition, bindings: [{ ...definition.bindings[0]!, key: 'first' }, { ...definition.bindings[0]!, key: 'second', input: 'image' }] }
    const result = matchMediaWorkflowInputs(two, [{ asset: asset('a'), roles: ['first', 'second'] }], { second: 'a' })
    expect(Object.keys(result.bindings)).toEqual(['first', 'second'])
  })
  test('多候选标记歧义，不凭顺序选择', () => {
    const result = matchMediaWorkflowInputs(definition, [{ asset: asset('a'), roles: ['source'] }, { asset: asset('b'), roles: ['source'] }])
    expect(result.ambiguous).toEqual(['source'])
    expect(result.bindings).toEqual({})
  })
  test('不兼容媒体类型标记缺失或不兼容', () => {
    const result = matchMediaWorkflowInputs(definition, [{ asset: { ...asset('a'), mediaKind: 'audio' }, roles: ['source'] }])
    expect(result.incompatible).toEqual(['source'])
  })
})
