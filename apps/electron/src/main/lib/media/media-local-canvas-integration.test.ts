import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createEmptyDesignDocument,
  type AgentSessionMeta,
  type CanvasMediaModuleConfig,
  type DesignCanvasDocument,
  type DesignInternalMutation,
  type MediaInputValue,
  type MediaRunSnapshot,
} from '@proma/shared'
import { CanvasMediaService, type CanvasMediaModuleState, type CanvasMediaModuleStore } from '../design/canvas-media-service'
import { MediaAssetService } from './media-asset-service'
import { MediaSourceService } from './media-source-service'
import type { MediaAssetServiceDependencies } from './media-asset-service'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 应用真实内部媒体资产 mutation，保持测试文档与生产资产服务一致。 */
function applyMutations(document: DesignCanvasDocument, mutations: DesignInternalMutation[]): DesignCanvasDocument {
  let next = structuredClone(document)
  for (const mutation of mutations) {
    if (mutation.type === 'upsert-media-assets') {
      next = {
        ...next,
        revision: next.revision + 1,
        mediaAssets: [
          ...(next.mediaAssets ?? []).filter((item) => !mutation.assets.some((asset) => asset.id === item.id)),
          ...structuredClone(mutation.assets),
        ],
      }
    } else {
      next = {
        ...next,
        revision: next.revision + 1,
        mediaAssets: (next.mediaAssets ?? []).filter((item) => !mutation.assetIds.includes(item.id)),
      }
    }
  }
  return next
}

/** 根据媒体类型创建只包含一个主输出的内存 Canvas 模块，返回可查询的 CAS Store。 */
function createCanvasStore(mediaKind: 'audio' | 'video'): CanvasMediaModuleStore & { current(): CanvasMediaModuleState } {
  const config: CanvasMediaModuleConfig = {
    schemaVersion: 1,
    contentId: 'media-1',
    mediaKind,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    profile: null,
    workflow: null,
    inputs: [],
    outputs: [{ key: mediaKind, mediaKind, role: 'primary', order: 0 }],
    adoptedOutputs: [],
  }
  let state: CanvasMediaModuleState = {
    schemaVersion: 1,
    revision: 1,
    config,
    operations: [],
    candidates: [],
    pendingAdoptionProjection: null,
  }
  return {
    load: async () => structuredClone(state),
    compareAndSwap: async (_target, expectedRevision, next) => {
      if (state.revision !== expectedRevision) throw new Error('CANVAS_MEDIA_STATE_CONFLICT')
      state = structuredClone(next)
      return structuredClone(state)
    },
    current: () => structuredClone(state),
  }
}

/** 为指定媒体类型建立隔离项目；省略 probe 时使用生产 ffprobe，返回真实文件服务与 Canvas 边界。 */
function createScenario(mediaKind: 'audio' | 'video', probe?: MediaAssetServiceDependencies['probe']) {
  const root = mkdtempSync(join(tmpdir(), 'proma-media-canvas-integration-'))
  roots.push(root)
  const designRoot = join(root, '.proma', 'design')
  const assetsDir = join(designRoot, 'assets')
  mkdirSync(assetsDir, { recursive: true })

  /** 真实媒体资产服务共享的权威项目文档。 */
  let document = createEmptyDesignDocument('project-1', 1)
  const assets = new MediaAssetService({
    pathResolver: { resolve: () => ({ projectRoot: root, designRoot, assetsDir }) },
    store: {
      requireStableAuthoritativeDocument: () => structuredClone(document),
      mutateInternal: (_projectId, expectedRevision, mutations) => {
        if (document.revision !== expectedRevision) throw new Error('DESIGN_DOCUMENT_CONFLICT')
        document = applyMutations(document, mutations)
        return structuredClone(document)
      },
    },
    images: {
      read: async () => { throw new Error('不应读取图片') },
      register: async () => { throw new Error('不应登记图片') },
    },
    resolveImagePath: () => { throw new Error('不应解析图片') },
    runWorkspaceWrite: (_projectId, effect) => effect(),
    probe,
    now: () => 2,
  })
  const sources = new MediaSourceService({
    getSession: () => ({ id: 'session-1', workspaceId: 'project-1' } as AgentSessionMeta),
    getMessages: () => [],
    authorize: () => undefined,
    resolveAttachmentPath: (path) => path,
    getAllowedRoots: () => [root],
    getLocalFileAccess: () => ({ baseDir: root, allowedRoots: [root] }),
    assets,
  })
  const target = {
    projectId: 'project-1', canvasId: 'canvas-1', nodeId: `${mediaKind}-node`,
    mediaModuleId: 'media-1', mediaKind,
  }
  const moduleStore = createCanvasStore(mediaKind)
  const unusedRun: MediaRunSnapshot = {
    id: 'unused', projectId: 'project-1', revision: 0, phase: 'prepared',
    createdAt: 1, updatedAt: 1, outputs: [], error: null, progress: null,
  }
  const canvas = new CanvasMediaService({
    store: moduleStore,
    configuration: {
      resolveProfile: () => { throw new Error('不应解析预设') },
      getWorkflow: () => { throw new Error('不应解析工作流') },
      resolveConnection: () => { throw new Error('不应解析连接') },
    },
    runs: {
      prepare: async () => unusedRun,
      prepareDraft: async () => unusedRun,
      findOperation: () => null,
      get: () => unusedRun,
      getInputs: (): Record<string, MediaInputValue> => ({}),
      getOrigin: () => ({}),
      cancel: async () => unusedRun,
    },
    supervisor: { start: () => unusedRun, wait: async () => unusedRun },
    assets,
    hostFiles: {
      openPreview: async () => { throw new Error('不应打开预览') },
      releasePreview: async () => undefined,
      exportAsset: async () => ({ cancelled: true }),
    },
    resolveWorkflowInputs: async () => ({ ready: true, bindings: [] }),
    onAdopted: async () => undefined,
    authorizeTarget: async () => undefined,
    now: () => 3,
  })
  return { root, assets, sources, target, moduleStore, canvas }
}

describe('普通 Agent 本地媒体到 Canvas 组合链路', () => {
  test('Given Shell 生成项目视频 When 导入、挂候选并采用 Then 画布正式输出引用真实落盘资产', async () => {
    /** 保留无外部二进制依赖的服务合同测试。 */
    const { root, sources, assets, target, moduleStore, canvas } = createScenario('video', async () => ({
      mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4',
      metadata: { width: 1920, height: 1080, durationMs: 3000, fps: 24, codec: 'h264', hasAudio: true },
    }))
    const sourceBytes = Buffer.from('000000186674797069736f6d00000000', 'hex')
    writeFileSync(join(root, 'final.mp4'), sourceBytes)
    const asset = await sources.importLocalFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      { path: 'final.mp4', mediaKind: 'video' },
    )
    const candidate = await canvas.attachImportedAssets({
      ...target,
      expectedConfigRevision: 1,
      operationId: 'local-video-1',
      outputs: [{ key: 'video', asset }],
    }, { sessionId: 'session-1', runStartedAt: 1, mode: 'project-agent' })
    const adopted = await canvas.adopt({
      ...target,
      expectedConfigRevision: 1,
      candidateId: candidate.id,
      selectedKeys: ['video'],
    })

    expect(await assets.read('project-1', asset)).toEqual(sourceBytes)
    expect(moduleStore.current().operations).toEqual([])
    expect(adopted.adoptedOutputs).toEqual([{
      key: 'video', mediaKind: 'video', role: 'primary', order: 0,
      candidateId: candidate.id, runId: candidate.runId, asset,
    }])
  })

  /** 真实二进制验收可在未安装工具的 CI 跳过，普通服务合同测试始终执行。 */
  const ffmpegPath = Bun.which('ffmpeg')
  const realMediaTest = test.skipIf(!ffmpegPath || !Bun.which('ffprobe'))
  for (const mediaKind of ['audio', 'video'] as const) {
    realMediaTest(`Given 真实 ${mediaKind} 文件 When 导入、文件回流和候选采用 Then 探测准确且损坏可恢复、重放不重复`, async () => {
      /** 测试只生成极短的合成媒体，不读取用户文件或访问网络。 */
      const fixture = createScenario(mediaKind)
      const sourcePath = join(fixture.root, mediaKind === 'audio' ? 'tone.wav' : 'clip.mp4')
      const ffmpegArgs = mediaKind === 'audio'
        ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '0.25', '-c:a', 'pcm_s16le']
        : ['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
          '-t', '0.3', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-c:a', 'aac']
      execFileSync(ffmpegPath!, ['-nostdin', '-v', 'error', ...ffmpegArgs, sourcePath], { timeout: 10_000 })
      const sourceBytes = readFileSync(sourcePath)
      const context = { projectId: 'project-1', sessionId: 'session-1' }
      const asset = await fixture.sources.importLocalFile(context, { path: sourcePath, mediaKind })
      const returnedFile = await fixture.sources.getAssetFile(context, asset)
      expect(returnedFile.asset).toEqual(asset)
      expect(readFileSync(returnedFile.path)).toEqual(sourceBytes)
      expect(returnedFile.record.mediaKind).toBe(mediaKind)
      if (!('durationMs' in returnedFile.record.metadata)) throw new Error('音视频探测未返回时长')
      expect(returnedFile.record.metadata.durationMs).toBeGreaterThan(200)
      expect(returnedFile.record.metadata.durationMs).toBeLessThan(1_000)
      expect(returnedFile.record.metadata).toMatchObject(mediaKind === 'audio'
        ? { sampleRate: 16000, channels: 1, codec: 'pcm_s16le' }
        : { width: 64, height: 48, fps: 10, hasAudio: true, codec: 'mpeg4' })
      expect(await fixture.sources.importLocalFile(context, { path: sourcePath, mediaKind })).toEqual(asset)
      expect(await fixture.assets.list('project-1')).toHaveLength(1)

      const candidate = await fixture.canvas.attachImportedAssets({
        ...fixture.target, expectedConfigRevision: 1, operationId: `real-${mediaKind}`,
        outputs: [{ key: mediaKind, asset }],
      }, { sessionId: 'session-1', runStartedAt: 1, mode: 'project-agent' })
      const adoption = { ...fixture.target, expectedConfigRevision: 1, candidateId: candidate.id, selectedKeys: [mediaKind] }
      /** 同长度篡改必须由真实资产哈希阻断，失败不能提交正式采用状态。 */
      const damagedBytes = Buffer.from(sourceBytes)
      damagedBytes[damagedBytes.length - 1] = damagedBytes[damagedBytes.length - 1]! ^ 1
      writeFileSync(returnedFile.path, damagedBytes)
      await expect(fixture.canvas.adopt(adoption)).rejects.toThrow('MEDIA_ASSET_CHANGED')
      expect(fixture.moduleStore.current().config.adoptedOutputs).toEqual([])
      writeFileSync(returnedFile.path, sourceBytes)
      const adopted = await fixture.canvas.adopt(adoption)
      expect(adopted.adoptedOutputs).toEqual([{
        key: mediaKind, mediaKind, role: 'primary', order: 0, candidateId: candidate.id, runId: candidate.runId, asset,
      }])
      expect(fixture.moduleStore.current().operations).toEqual([])
      expect(await fixture.assets.read('project-1', asset)).toEqual(sourceBytes)
    })
  }

  realMediaTest('Given 只有合法 MP4 文件头的截断文件 When 真实探测导入 Then 拒绝登记且没有正式资产', async () => {
    /** 扩展名与签名不足以证明文件可用，最终以真实 ffprobe 结果为准。 */
    const fixture = createScenario('video')
    writeFileSync(join(fixture.root, 'truncated.mp4'), Buffer.from('000000186674797069736f6d00000000', 'hex'))
    await expect(fixture.sources.importLocalFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      { path: 'truncated.mp4', mediaKind: 'video' },
    )).rejects.toThrow('MEDIA_PROBE_FAILED')
    expect(await fixture.assets.list('project-1')).toEqual([])
    expect(fixture.moduleStore.current().candidates).toEqual([])
  })
})
