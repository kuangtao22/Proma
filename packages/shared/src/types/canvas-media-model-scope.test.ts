import { describe, expect, test } from 'bun:test'
import { applyCanvasMutations, createEmptyCanvasDocument, parseCanvasWorkspaceSnapshot } from './canvas'
import { buildCanvasMediaModelOptions, isCanvasMediaModelAllowed, parseCanvasMediaModelScope, resolveCanvasMediaModelOptions } from './canvas-media-model-scope'

describe('画布媒体模型候选范围', () => {
  test('Given 统一音频 API 与旧图片目录 When 合并候选 Then 保留能力并拒绝配置占位执行且不重复图片', () => {
    /** 可执行图片与尚无 adapter 的音频共存于同一目录。 */
    const options = buildCanvasMediaModelOptions({ revision: 3, entries: [
      { profile: { id: 'image', name: '图片', modelId: 'gpt-image', protocol: 'openai-images', mediaKind: 'image', channelId: 'openai', capabilities: ['text-to-image'], enabled: true, createdAt: 1, updatedAt: 1 }, support: { state: 'supported', adapterId: 'openai-images' } },
      { profile: { id: 'audio', name: '语音', modelId: 'speech', protocol: 'minimax-speech', mediaKind: 'audio', channelId: 'minimax', capabilities: ['text-to-speech'], enabled: true, createdAt: 1, updatedAt: 1 }, support: { state: 'configuration-only', reason: '尚未接入执行器' } },
    ] }, [
      { profileId: 'image', name: '旧图片', modelId: 'gpt-image', executor: 'openai-images', channelId: 'openai', available: true },
      { profileId: 'nano', name: 'Nano', modelId: 'nano', executor: 'nano-banana', available: true },
      { profileId: 'workflow', name: '旧工作流', modelId: 'workflow', executor: 'comfyui', mediaProfileId: 'legacy', mediaProfileRevision: 1, connectionId: 'gpu', workflowId: 'flow', workflowRevision: 1, workflowHash: 'a'.repeat(64), available: true },
    ])
    expect(options.map((option) => option.profileId)).toEqual(['image', 'audio', 'nano'])
    expect(options[1]).toMatchObject({ mediaKind: 'audio', available: false, capabilities: ['text-to-speech'], support: { state: 'configuration-only' } })
    expect(resolveCanvasMediaModelOptions(undefined, options).availableIds).toEqual(['image', 'nano'])
    expect(resolveCanvasMediaModelOptions({ mode: 'selected', modelIds: [] }, options).availableIds).toEqual([])
  })

  test('Given 旧画布无范围 When 读取 Then 使用全部启用模型而显式空选择保持为空', () => {
    expect(isCanvasMediaModelAllowed(undefined, 'image-a')).toBe(true)
    expect(isCanvasMediaModelAllowed({ mode: 'selected', modelIds: [] }, 'image-a')).toBe(false)
    expect(() => parseCanvasMediaModelScope({ mode: 'selected', modelIds: ['a', 'a'] })).toThrow()
  })

  test('Given 已选模型失效和新增模型 When 解析候选 Then 保留失效身份但不自动扩展选择', () => {
    const options = [{ profileId: 'a', available: false, executor: 'openai-images' as const, channelId: 'channel', name: 'A', modelId: 'a' },
      { profileId: 'b', available: true, executor: 'openai-images' as const, channelId: 'channel', name: 'B', modelId: 'b' }]
    expect(resolveCanvasMediaModelOptions({ mode: 'selected', modelIds: ['a', 'deleted'] }, options)).toEqual({ selectedIds: ['a', 'deleted'], availableIds: [], unavailableIds: ['a', 'deleted'] })
    expect(resolveCanvasMediaModelOptions(undefined, options).availableIds).toEqual(['b'])
  })

  test('Given 模型范围变更 When 应用mutation及IPC解析 Then 只更新此画布并保留空范围', () => {
    const original = createEmptyCanvasDocument('project', 'canvas', 1)
    const updated = applyCanvasMutations(original, [{ type: 'set-media-model-scope', scope: { mode: 'selected', modelIds: [] } }])
    expect(updated.mediaModelScope).toEqual({ mode: 'selected', modelIds: [] })
    expect(original.mediaModelScope).toBeUndefined()
    expect(parseCanvasWorkspaceSnapshot({ document: updated, nodeIssues: [], writable: true }).document.mediaModelScope).toEqual(updated.mediaModelScope)
  })
})
