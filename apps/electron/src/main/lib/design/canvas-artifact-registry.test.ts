import { describe, expect, test } from 'bun:test'
import {
  DOCUMENT_ARTIFACT_DESCRIPTOR,
  IMAGE_ARTIFACT_DESCRIPTOR,
  WEBVIEW_ARTIFACT_DESCRIPTOR,
  createCanvasImageArtifactAdapter,
  createCanvasArtifactRegistry,
  replaceCanvasArtifactAdapter,
  type CanvasArtifactAdapter,
} from './canvas-artifact-registry'

/** 创建测试用适配器，业务方法由后续具体产物适配器扩展。 */
function createAdapters(): CanvasArtifactAdapter[] {
  return [
    { descriptor: DOCUMENT_ARTIFACT_DESCRIPTOR },
    { descriptor: WEBVIEW_ARTIFACT_DESCRIPTOR },
    { descriptor: IMAGE_ARTIFACT_DESCRIPTOR },
  ]
}

describe('Canvas Artifact Registry', () => {
  test('Given 图片业务依赖 When 创建真实适配器 Then 版本、运行、采用和导出复用现有服务', async () => {
    /** 记录适配器向既有服务发出的业务调用。 */
    const calls: string[] = []
    const adapter = createCanvasImageArtifactAdapter({
      read: async () => {
        calls.push('read')
        return {
          schemaVersion: 2, kind: 'image', contentId: 'module-1', revision: 3,
          createdAt: 1, updatedAt: 2, prompt: '首页', selectedModelProfileId: 'profile-1',
          aspectRatio: '16:9', imageSize: '2K', contextMode: 'project', adoptedAssetId: 'asset-2',
        }
      },
      update: async () => { throw new Error('测试不执行更新') },
      listJobs: () => [{
        id: 'job-2', creativeTaskId: 'creative-2', attemptNumber: 1, projectId: 'project-1',
        target: { kind: 'canvas-image', canvasId: 'canvas-1', nodeId: 'node-1', imageModuleId: 'module-1' },
        action: 'generate', status: 'succeeded', prompt: '首页', originalRequest: '首页',
        contextMode: 'project', outputAssetId: 'asset-2', createdAt: 1, updatedAt: 2,
      }],
      listAssets: () => [{
        id: 'asset-2', filename: 'asset-2.png', relativePath: 'assets/asset-2.png',
        thumbnailRelativePath: 'thumbnails/asset-2.webp', mediaType: 'image/png',
        width: 100, height: 100, byteSize: 100, sha256: 'a'.repeat(64),
        sourceJobId: 'job-2', createdAt: 20,
      }],
      run: async () => { calls.push('run') },
      adopt: async () => { calls.push('adopt'); return undefined },
      export: async ({ targetPath }) => { calls.push(`export:${targetPath}`) },
    })
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', imageModuleId: 'module-1',
    }

    expect(await adapter.listVersions(target)).toEqual([
      { jobId: 'job-2', assetId: 'asset-2', createdAt: 20 },
    ])
    await adapter.run(target)
    await adapter.adopt(target, 3, 'asset-2')
    await adapter.export({ ...target, kind: 'image', assetId: 'asset-2', targetPath: '/tmp/export.png' })

    expect(calls).toEqual(['run', 'adopt', 'read', 'export:/tmp/export.png'])
  })

  test('Given 完整 Registry When 替换图片适配器 Then 只更新图片路由并保持三类能力完整', () => {
    const adapters = createAdapters()
    const registry = createCanvasArtifactRegistry(adapters)
    const imageAdapter = { descriptor: IMAGE_ARTIFACT_DESCRIPTOR, marker: 'real-image' }
    const replaced = replaceCanvasArtifactAdapter(registry, imageAdapter)

    expect(replaced.requireCapability('document', 'read')).toBe(adapters[0]!)
    expect(replaced.requireCapability('webview', 'preview')).toBe(adapters[1]!)
    expect(replaced.requireCapability('image', 'run')).toBe(imageAdapter)
  })

  test('Given 三类适配器 When 查询能力 Then 返回阶段一真实能力', () => {
    /** 使用完整适配器集合创建被测注册表。 */
    const registry = createCanvasArtifactRegistry(createAdapters())

    expect(registry.describe('document').capabilities).toEqual([
      'create', 'read', 'update', 'version', 'adopt', 'export',
    ])
    expect(registry.describe('webview').capabilities).toEqual([
      'create', 'read', 'update', 'version', 'preview', 'adopt', 'export',
    ])
    expect(registry.describe('image').capabilities).toEqual([
      'create', 'read', 'update', 'version', 'run', 'adopt', 'export',
    ])
  })

  test('Given 文档产物 When 请求 run Then 返回稳定不支持错误', () => {
    /** 使用完整适配器集合创建被测注册表。 */
    const registry = createCanvasArtifactRegistry(createAdapters())

    expect(() => registry.requireCapability('document', 'run'))
      .toThrow('CANVAS_ARTIFACT_CAPABILITY_UNSUPPORTED')
  })

  test('Given 支持目标能力的产物 When 请求能力 Then 返回注册时的正确适配器', () => {
    /** 保留适配器引用用于校验路由未复制或替换实例。 */
    const adapters = createAdapters()
    /** 使用完整适配器集合创建被测注册表。 */
    const registry = createCanvasArtifactRegistry(adapters)

    expect(registry.requireCapability('webview', 'preview')).toBe(adapters[1]!)
    expect(registry.requireCapability('image', 'run')).toBe(adapters[2]!)
  })

  test('Given 调用方取得能力描述 When 尝试篡改 Then 注册表事实保持不变', () => {
    /** 使用完整适配器集合创建被测注册表。 */
    const registry = createCanvasArtifactRegistry(createAdapters())
    /** 调用方取得的只读文档能力描述。 */
    const descriptor = registry.describe('document')

    expect(() => {
      /** 模拟绕过 TypeScript 只读约束的非可信运行时调用方。 */
      const mutableCapabilities = descriptor.capabilities as string[]
      mutableCapabilities.push('run')
    }).toThrow()
    expect(registry.describe('document')).toEqual(DOCUMENT_ARTIFACT_DESCRIPTOR)
  })

  test('Given 注册后的适配器 When 调用方替换 descriptor Then 保持权威声明和适配器身份', () => {
    /** 带业务方法的可变文档适配器用于模拟非可信运行时调用方。 */
    const documentAdapter = {
      descriptor: {
        kind: 'document' as const,
        capabilities: [...DOCUMENT_ARTIFACT_DESCRIPTOR.capabilities],
      },
      readMarker: () => 'document-content',
    }
    /** 使用真实文档适配器和其余两类适配器创建注册表。 */
    const registry = createCanvasArtifactRegistry([
      documentAdapter,
      { descriptor: WEBVIEW_ARTIFACT_DESCRIPTOR },
      { descriptor: IMAGE_ARTIFACT_DESCRIPTOR },
    ])

    expect(() => {
      documentAdapter.descriptor = {
        kind: 'document',
        capabilities: ['create', 'run'],
      }
    }).toThrow()
    /** 注册表返回的文档适配器需保留原始身份和业务方法。 */
    const resolved = registry.requireCapability('document', 'read')
    expect(resolved).toBe(documentAdapter)
    expect(resolved.descriptor).toBe(DOCUMENT_ARTIFACT_DESCRIPTOR)
    expect(documentAdapter.readMarker()).toBe('document-content')
  })

  test('Given 适配器使用可变能力数组 When 注册后篡改旧数组 Then 返回声明不发生分叉', () => {
    /** 注册前由调用方持有的可变能力数组引用。 */
    const mutableCapabilities = [...DOCUMENT_ARTIFACT_DESCRIPTOR.capabilities]
    /** 使用可变能力数组声明的文档适配器。 */
    const documentAdapter: CanvasArtifactAdapter<'document'> = {
      descriptor: { kind: 'document', capabilities: mutableCapabilities },
    }
    /** 使用完整适配器集合创建被测注册表。 */
    const registry = createCanvasArtifactRegistry([
      documentAdapter,
      { descriptor: WEBVIEW_ARTIFACT_DESCRIPTOR },
      { descriptor: IMAGE_ARTIFACT_DESCRIPTOR },
    ])

    mutableCapabilities.push('run')

    expect(registry.requireCapability('document', 'read').descriptor)
      .toBe(DOCUMENT_ARTIFACT_DESCRIPTOR)
    expect(registry.describe('document').capabilities).not.toContain('run')
  })

  test('Given 同类适配器重复 When 初始化 Then 拒绝歧义路由', () => {
    /** 完整适配器集合用于追加重复文档适配器。 */
    const adapters = createAdapters()

    expect(() => createCanvasArtifactRegistry([...adapters, adapters[0]!]))
      .toThrow('CANVAS_ARTIFACT_ADAPTER_DUPLICATE')
  })

  test('Given 任一产物适配器缺失 When 初始化 Then 拒绝不完整注册表', () => {
    /** 完整适配器集合用于移除图片适配器。 */
    const adapters = createAdapters()

    expect(() => createCanvasArtifactRegistry(adapters.slice(0, 2)))
      .toThrow('CANVAS_ARTIFACT_ADAPTER_MISSING')
  })
})
