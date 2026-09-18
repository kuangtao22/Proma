import { describe, expect, test } from 'bun:test'
import type { ImageGenerationPublicCatalog } from '@proma/shared'
import { buildCanvasGenerationModelId } from '@proma/shared'
import { ImageGenerationCanvasSource, isGenerationSnapshot } from './image-generation-canvas-source'

/** 构造独立生成目录：一条可执行的 OpenAI 配置与一条未接执行器的即梦配置。 */
function createCatalog(): ImageGenerationPublicCatalog {
  return {
    schemaVersion: 1,
    revision: 3,
    profiles: [
      {
        id: 'image-openai', name: '我的 ChatGPT', provider: 'openai-images',
        baseUrl: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-image-1', capabilities: ['text-to-image', 'image-to-image'] }],
        enabled: true, createdAt: 1, updatedAt: 2,
        credentialConfigured: true, endpointOrigin: 'https://api.openai.com',
      },
      {
        id: 'image-jimeng', name: '即梦', provider: 'dreamina',
        models: [{ id: '5.0', capabilities: ['text-to-image'] }],
        enabled: true, createdAt: 1, updatedAt: 2,
        credentialConfigured: true,
      },
      {
        id: 'image-minimax', name: '我的 MiniMax', provider: 'minimax',
        baseUrl: 'https://api.minimax.cn/v1',
        models: [{ id: 'image-01', capabilities: ['text-to-image'] }],
        enabled: true, createdAt: 1, updatedAt: 2,
        credentialConfigured: true,
      },
    ],
  }
}

/** 构造带固定目录与可观测解密的来源。 */
function createSource(catalog: ImageGenerationPublicCatalog = createCatalog()): {
  source: ImageGenerationCanvasSource
  resolved: string[]
} {
  const resolved: string[] = []
  return {
    resolved,
    source: new ImageGenerationCanvasSource({
      readCatalog: () => catalog,
      resolveApiKey: (profileId) => { resolved.push(profileId); return 'sk-independent' },
    }),
  }
}

describe('独立生成配置的画布来源', () => {
  test('Given 已接入执行器的配置 When 固化快照 Then 引用生成配置而不是渠道', () => {
    const { source } = createSource()
    const snapshot = source.resolveAvailableSnapshot(buildCanvasGenerationModelId('openai-images', 'image-openai', 'gpt-image-1'))
    expect(snapshot).toMatchObject({
      executor: 'openai-images',
      imageProfileId: 'image-openai',
      modelId: 'gpt-image-1',
    })
    /** 快照绝不能携带渠道身份，否则等于继续借用 LLM 凭据。 */
    expect('channelId' in snapshot).toBe(false)
    expect(isGenerationSnapshot(snapshot)).toBe(true)
  })

  test('Given 即梦独立配置 When 固化并解析路由 Then 走 CLI 执行器且不带密钥', () => {
    const { source, resolved } = createSource()
    const snapshot = source.resolveAvailableSnapshot(buildCanvasGenerationModelId('dreamina', 'image-jimeng', '5.0'))
    expect(snapshot).toMatchObject({ executor: 'dreamina-image', imageProfileId: 'image-jimeng', modelId: '5.0' })
    const route = source.resolveExecutionRoute(snapshot)
    expect(route.executor).toBe('dreamina-image')
    /** 即梦凭据是本机 CLI 登录态，不能解析出任何密钥。 */
    expect(resolved).toEqual([])
    expect('apiKey' in route).toBe(false)
  })

  test('Given MiniMax 独立配置 When 固化并解析路由 Then 走 MiniMax 执行器', () => {
    const { source, resolved } = createSource()
    const snapshot = source.resolveAvailableSnapshot(buildCanvasGenerationModelId('minimax', 'image-minimax', 'image-01'))
    expect(snapshot).toMatchObject({ executor: 'minimax-image', imageProfileId: 'image-minimax', modelId: 'image-01' })
    expect(source.resolveExecutionRoute(snapshot)).toMatchObject({
      executor: 'minimax-image',
      baseUrl: 'https://api.minimax.cn/v1',
      apiKey: 'sk-independent',
    })
    expect(resolved).toEqual(['image-minimax'])
  })

  test('Given 已删除或停用的配置 When 固化快照 Then 给出可操作原因', () => {
    const catalog = createCatalog()
    catalog.profiles[0]!.enabled = false
    expect(() => createSource(catalog).source.resolveAvailableSnapshot(buildCanvasGenerationModelId('openai-images', 'image-openai', 'gpt-image-1')))
      .toThrow('配置已停用')
    expect(() => createSource(catalog).source.resolveAvailableSnapshot(buildCanvasGenerationModelId('openai-images', 'image-missing', 'gpt-image-1')))
      .toThrow('配置已删除')
    expect(() => createSource(catalog).source.resolveAvailableSnapshot('image-openai'))
      .toThrow('请重新选择模型')
  })

  test('Given 有效快照 When 解析路由 Then 用独立目录的地址与密钥', () => {
    const { source, resolved } = createSource()
    const snapshot = source.resolveAvailableSnapshot(buildCanvasGenerationModelId('openai-images', 'image-openai', 'gpt-image-1'))
    const route = source.resolveExecutionRoute(snapshot)
    expect(route).toMatchObject({
      executor: 'openai-images',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-independent',
    })
    expect(resolved).toEqual(['image-openai'])
  })

  test('Given 快照与当前配置不一致 When 复核或解析路由 Then 拒绝运行', () => {
    const { source } = createSource()
    const snapshot = source.resolveAvailableSnapshot(buildCanvasGenerationModelId('openai-images', 'image-openai', 'gpt-image-1'))
    /** 历史渠道来源的快照不再由独立来源解析（必须真的没有 imageProfileId 字段）。 */
    const { imageProfileId: _ignored, ...base } = snapshot as typeof snapshot & { imageProfileId: string }
    const legacySnapshot = { ...base, channelId: 'channel-1' } as unknown as typeof snapshot
    expect(() => source.assertSnapshotAvailable(legacySnapshot)).toThrow('来源不受支持')
    /** 模型被移除后运行阶段必须拒绝，而不是拿旧参数硬跑。 */
    const catalog = createCatalog()
    catalog.profiles[0]!.models = [{ id: 'gpt-image-2', capabilities: ['text-to-image'] }]
    expect(() => createSource(catalog).source.assertSnapshotAvailable(snapshot)).toThrow('模型已移除')
  })
})
