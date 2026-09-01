import { describe, expect, test } from 'bun:test'
import type {
  CanvasDocument,
  CanvasImageModuleConfig,
  CanvasImageTarget,
  DesignAsset,
  DesignJobRecord,
} from '@proma/shared'
import type {
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
} from '../stable-directory-native-host'
import {
  createCanvasImageModuleStore,
  deriveCanvasImageArtifactVersions,
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
    schemaVersion: 4,
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
  test('Given 混合任务与素材 When 派生图片版本 Then 只返回精确归属且仍存在的成功输出', () => {
    /** 创建最小任务事实，用于覆盖状态、归属、来源与重复输出边界。 */
    const createJob = (
      id: string,
      status: DesignJobRecord['status'],
      outputAssetId: string | undefined,
      overrides: Partial<DesignJobRecord> = {},
    ): DesignJobRecord => ({
      id,
      creativeTaskId: `creative-${id}`,
      attemptNumber: 1,
      projectId: target.projectId,
      target: {
        kind: 'canvas-image', canvasId: target.canvasId,
        nodeId: target.nodeId, imageModuleId: target.imageModuleId,
      },
      action: 'generate', status, prompt: id, originalRequest: id,
      contextMode: 'none', createdAt: 1, updatedAt: 1,
      ...(outputAssetId ? { outputAssetId } : {}),
      ...overrides,
    })
    /** 创建与任务绑定的最小素材事实。 */
    const createAsset = (id: string, sourceJobId: string, createdAt: number): DesignAsset => ({
      id, filename: `${id}.png`, relativePath: `assets/${id}.png`,
      thumbnailRelativePath: `thumbnails/${id}.webp`, mediaType: 'image/png',
      width: 100, height: 100, byteSize: 100, sha256: id.padEnd(64, 'a'),
      sourceJobId, createdAt,
    })
    const jobs = [
      createJob('job-old', 'succeeded', 'asset-old'),
      createJob('job-new', 'succeeded', 'asset-new'),
      createJob('job-missing', 'succeeded', 'asset-missing'),
      createJob('job-failed', 'failed', 'asset-failed'),
      createJob('job-foreign', 'succeeded', 'asset-foreign', {
        target: { kind: 'canvas-image', canvasId: target.canvasId, nodeId: 'node-other', imageModuleId: target.imageModuleId },
      }),
      createJob('job-wrong-source', 'succeeded', 'asset-wrong-source'),
      createJob('job-duplicate', 'succeeded', 'asset-old'),
    ]
    const assets = [
      createAsset('asset-old', 'job-old', 100),
      createAsset('asset-new', 'job-new', 300),
      createAsset('asset-failed', 'job-failed', 400),
      createAsset('asset-foreign', 'job-foreign', 500),
      createAsset('asset-wrong-source', 'job-other', 600),
    ]

    expect(deriveCanvasImageArtifactVersions(target, jobs, assets, 10)).toEqual([
      { jobId: 'job-new', assetId: 'asset-new', createdAt: 300 },
      { jobId: 'job-old', assetId: 'asset-old', createdAt: 100 },
    ])
  })

  test('Given 合法图片版本超过上限 When 派生 Then 稳定倒序并截断有限结果', () => {
    /** 生成三个合法版本，时间相同用于锁定稳定 ID 次序。 */
    const jobs: DesignJobRecord[] = ['a', 'c', 'b'].map((suffix) => ({
      id: `job-${suffix}`, creativeTaskId: `creative-${suffix}`, attemptNumber: 1,
      projectId: target.projectId,
      target: { kind: 'canvas-image', canvasId: target.canvasId, nodeId: target.nodeId, imageModuleId: target.imageModuleId },
      action: 'generate', status: 'succeeded', prompt: suffix, originalRequest: suffix,
      contextMode: 'none', outputAssetId: `asset-${suffix}`, createdAt: 1, updatedAt: 1,
    }))
    const assets: DesignAsset[] = jobs.map((job) => ({
      id: job.outputAssetId!, filename: `${job.id}.png`, relativePath: `assets/${job.id}.png`,
      thumbnailRelativePath: `thumbnails/${job.id}.webp`, mediaType: 'image/png',
      width: 1, height: 1, byteSize: 1, sha256: job.id.padEnd(64, 'a'),
      sourceJobId: job.id, createdAt: 100,
    }))

    expect(deriveCanvasImageArtifactVersions(target, jobs, assets, 2).map((version) => version.assetId))
      .toEqual(['asset-a', 'asset-b'])
  })

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
