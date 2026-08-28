import { describe, expect, test } from 'bun:test'
import type {
  CanvasDocument,
  CanvasImageModuleConfig,
  CanvasImageTarget,
} from '@proma/shared'
import type {
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
} from '../stable-directory-native-host'
import {
  createCanvasImageModuleStore,
  type CanvasImageModuleStoreDependencies,
} from './canvas-image-module-store'

/** 测试使用的完整图片模块身份。 */
const target: CanvasImageTarget = {
  projectId: 'project-1',
  canvasId: 'canvas-1',
  nodeId: 'node-1',
  imageModuleId: 'module-1',
}

/** 创建只实现图片配置读写协议的内存夹具。 */
function createFixture() {
  /** 图片模块目录中的受管文件。 */
  const files = new Map<string, string>()
  /** 权威 Canvas 文档用于验证节点和模块归属。 */
  const document: CanvasDocument = {
    schemaVersion: 2,
    projectId: target.projectId,
    canvasId: target.canvasId,
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: target.nodeId,
      kind: 'image',
      title: '首页主视觉',
      position: { x: 0, y: 0 },
      imageModuleId: target.imageModuleId,
    }],
    edges: [],
    createdAt: 10,
    updatedAt: 10,
  }
  /** stable-directory helper 的最小内存实现。 */
  const runNative: CanvasImageModuleStoreDependencies['runStableDirectoryNative'] = async (request) => {
    if (request.mode === 'canvas-content-read') {
      const content = files.get(request.fileName!)
      return {
        roots: [],
        entries: [],
        readOutcome: content === undefined
          ? { status: 'missing' }
          : { status: 'ok', content, size: content.length, volume: '1', fileId: '2' },
      }
    }
    if (request.mode === 'canvas-content-write') {
      files.set(request.fileName!, request.content!)
      return {
        roots: [],
        entries: [],
        writeOutcome: { commitVisible: true, durabilityUncertain: false },
      }
    }
    throw new Error(`不支持的测试协议: ${request.mode}`)
  }
  /** 图片 Store 只需从同次 LOAD 获取文档和 nodes capability。 */
  const dependencies: CanvasImageModuleStoreDependencies = {
    store: {
      loadWithDirectoryCapability: () => ({
        snapshot: { document, writable: true, nodeIssues: [] },
        openSingleChildDirectory: () => ({
          path: '/canvas/nodes',
          rootPath: '/canvas',
          assertValid: () => undefined,
          authorizeOpenedRoots: () => true,
        }),
      }),
    },
    runStableDirectoryNative: runNative,
    now: () => 200,
  }
  return {
    files,
    store: createCanvasImageModuleStore(dependencies),
    /** 写入公共 meta 与指定图片配置。 */
    seed: (config: object) => {
      files.set('config.json', JSON.stringify(config))
      files.set('meta.json', JSON.stringify({
        schemaVersion: 1,
        kind: 'image',
        contentId: target.imageModuleId,
        revision: 0,
        createdAt: 100,
        updatedAt: 100,
      }))
    },
  }
}

describe('Canvas 图片模块 Store', () => {
  test('Given v1 图片配置 When LOAD Then 原子迁移并补齐默认值', async () => {
    const fixture = createFixture()
    fixture.seed({
      schemaVersion: 1,
      kind: 'image',
      contentId: target.imageModuleId,
      revision: 0,
      createdAt: 100,
      updatedAt: 100,
      prompt: '首页',
      selectedModelProfileId: 'profile-1',
      adoptedAssetId: null,
    })

    const config = await fixture.store.load(target)

    expect(config).toMatchObject({
      schemaVersion: 2,
      prompt: '首页',
      selectedModelProfileId: 'profile-1',
      aspectRatio: '1:1',
      imageSize: 'auto',
      contextMode: 'auto',
    } satisfies Partial<CanvasImageModuleConfig>)
    expect(JSON.parse(fixture.files.get('config.json')!).schemaVersion).toBe(2)
  })

  test('Given revision 已变化 When 保存旧草稿 Then 拒绝覆盖', async () => {
    const fixture = createFixture()
    fixture.seed({
      schemaVersion: 2,
      kind: 'image',
      contentId: target.imageModuleId,
      revision: 0,
      createdAt: 100,
      updatedAt: 100,
      prompt: '',
      selectedModelProfileId: null,
      aspectRatio: '1:1',
      imageSize: 'auto',
      contextMode: 'auto',
      adoptedAssetId: null,
    })
    /** 第一次保存推进配置 revision。 */
    const input = {
      ...target,
      expectedConfigRevision: 0,
      prompt: '首页主视觉',
      selectedModelProfileId: null,
      aspectRatio: '16:9' as const,
      imageSize: '2K' as const,
      contextMode: 'project' as const,
    }
    await fixture.store.save(input)

    await expect(fixture.store.save(input)).rejects.toThrow('CANVAS_IMAGE_REVISION_CONFLICT')
  })
})
