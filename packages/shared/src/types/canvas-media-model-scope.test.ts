import { describe, expect, test } from 'bun:test'
import { applyCanvasMutations, createEmptyCanvasDocument, parseCanvasWorkspaceSnapshot } from './canvas'
import {
  buildCanvasGenerationModelId,
  buildCanvasGenerationModelOptions,
  buildCanvasMediaModelOptions,
  isCanvasMediaModelAllowed,
  parseCanvasGenerationModelId,
  parseCanvasMediaModelScope,
  resolveCanvasMediaModelOptions,
} from './canvas-media-model-scope'

describe('独立生成配置的画布候选投影', () => {
  /** 目录含一条已接执行器的 OpenAI 配置与一条未接执行器的即梦配置。 */
  const catalog = {
    schemaVersion: 1 as const,
    revision: 1,
    profiles: [
      {
        id: 'image-openai', name: '我的 ChatGPT', provider: 'openai-images' as const,
        baseUrl: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-image-1', name: 'GPT Image 1', capabilities: ['text-to-image', 'image-to-image'] as const }],
        enabled: true, createdAt: 1, updatedAt: 1, credentialConfigured: true,
      },
      {
        id: 'image-jimeng', name: '即梦', provider: 'dreamina' as const,
        models: [
          { id: '5.0', name: '即梦 5.0', capabilities: ['text-to-image'] as const },
          { id: 'seedance2.5', name: 'Seedance 2.5', capabilities: ['text-to-video', 'image-to-video'] as const },
        ],
        enabled: true, createdAt: 1, updatedAt: 1, credentialConfigured: true,
      },
      {
        id: 'image-minimax', name: 'MiniMax 图像', provider: 'minimax' as const,
        baseUrl: 'https://api.minimax.cn/v1',
        models: [
          { id: 'image-01', name: 'Image 01', capabilities: ['text-to-image', 'image-to-image'] as const },
          { id: 'MiniMax-Hailuo-2.3', name: 'Hailuo 2.3', capabilities: ['text-to-video'] as const },
        ],
        enabled: true, createdAt: 1, updatedAt: 1, credentialConfigured: true,
      },
    ],
  }

  test('Given 独立生成目录 When 投影候选 Then 只有已接执行器的协议可用', () => {
    const options = buildCanvasGenerationModelOptions(catalog, [])
    const openai = options.find((option) => option.profileId === buildCanvasGenerationModelId('image-openai', 'gpt-image-1'))
    expect(openai).toMatchObject({ executor: 'openai-images', mediaKind: 'image', available: true })
    expect(openai?.support).toEqual({ state: 'supported', adapterId: 'openai-images' })
    /** 即梦图像已接 CLI 执行器，可用。 */
    const jimeng = options.find((option) => option.profileId === buildCanvasGenerationModelId('image-jimeng', '5.0'))
    expect(jimeng).toMatchObject({ available: true, executor: 'dreamina-image', mediaKind: 'image' })
    expect(jimeng?.support).toEqual({ state: 'supported', adapterId: 'dreamina-image' })
    /** 即梦视频尚未接入，必须与图片分开标注且不可用。 */
    const video = options.find((option) => option.profileId === buildCanvasGenerationModelId('image-jimeng', 'seedance2.5'))
    expect(video).toMatchObject({ mediaKind: 'video', executor: 'dreamina-video', available: false })
    expect(video?.capabilities).toEqual(['text-to-video', 'image-to-video'])
    /** MiniMax 图像执行器已接入，只有视频模型仍不可用。 */
    const minimaxImage = options.find((option) => option.profileId === buildCanvasGenerationModelId('image-minimax', 'image-01'))
    expect(minimaxImage).toMatchObject({ executor: 'minimax-image', available: true })
    expect(minimaxImage?.support).toEqual({ state: 'supported', adapterId: 'minimax-image' })
    const minimaxVideo = options.find((option) => option.profileId === buildCanvasGenerationModelId('image-minimax', 'MiniMax-Hailuo-2.3'))
    expect(minimaxVideo).toMatchObject({ executor: 'minimax-video', mediaKind: 'video', available: false })
  })

  test('Given 停用的配置 When 投影候选 Then 标注停用且不伪造可用', () => {
    const disabled = { ...catalog, profiles: catalog.profiles.map((profile) => ({ ...profile, enabled: false })) }
    const options = buildCanvasGenerationModelOptions(disabled, [])
    expect(options.every((option) => !option.available)).toBe(true)
    expect(options[0]?.unavailableReason).toBe('模型已停用')
  })

  test('Given 本地工作流候选 When 投影 Then 保持原语义且不混入生成配置', () => {
    const options = buildCanvasGenerationModelOptions(undefined, [{
      profileId: 'workflow', name: '本地工作流', modelId: 'flow', executor: 'comfyui',
      mediaProfileId: 'legacy', mediaProfileRevision: 1, connectionId: 'gpu',
      workflowId: 'flow', workflowRevision: 1, workflowHash: 'a'.repeat(64), available: true,
    }])
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ profileId: 'workflow', executor: 'comfyui', available: true })
  })

  test('Given 选择 ID When 往返解析 Then 模型 ID 含冒号也不歧义', () => {
    const id = buildCanvasGenerationModelId('image-openai', 'gpt-image-1')
    expect(id).toBe('imagegen:image-openai:gpt-image-1')
    expect(parseCanvasGenerationModelId(id)).toEqual({ profileId: 'image-openai', modelId: 'gpt-image-1' })
    expect(parseCanvasGenerationModelId(buildCanvasGenerationModelId('p', 'a:b'))).toEqual({ profileId: 'p', modelId: 'a:b' })
    /** 旧目录 ID 不参与解析，避免两套身份混淆。 */
    expect(parseCanvasGenerationModelId('image')).toBeNull()
    /** 生成的 ID 必须能通过画布范围解析的字符合同。 */
    expect(() => parseCanvasMediaModelScope({ mode: 'selected', modelIds: [id] })).not.toThrow()
  })
})

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
