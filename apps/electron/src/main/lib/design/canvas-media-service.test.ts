import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CanvasMediaCandidate,
  CanvasMediaModuleConfig,
  CanvasMediaTarget,
  CanvasNodeContentMeta,
  MediaAssetRecord,
  MediaInputValue,
  MediaRunSnapshot,
} from '@proma/shared'
import type { StableDirectoryNativeRequest, StableDirectoryNativeResult } from '../stable-directory-native-host'
import {
  CanvasMediaService,
  type CanvasMediaModuleState,
  type CanvasMediaModuleStore,
} from './canvas-media-service'
import type { MediaRunOrigin } from '../media/media-run-service'
import { createCanvasMediaStore } from './canvas-media-store'

const target: CanvasMediaTarget = {
  projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', mediaModuleId: 'media-1', mediaKind: 'video',
}

const origin = {
  canvasMedia: target,
  actor: {
    sessionId: 'session-1', runStartedAt: 1, mode: 'renderer-manual' as const,
    canvasId: 'canvas-1', nodeId: 'node-1',
  },
}

/** 创建带独立视频、音轨和海报输出的媒体配置。 */
function config(revision = 2): CanvasMediaModuleConfig {
  return {
    schemaVersion: 1, contentId: 'media-1', mediaKind: 'video', revision,
    createdAt: 1, updatedAt: revision,
    profile: { profileId: 'profile-1', profileRevision: 3 },
    inputs: [{ key: 'prompt', kind: 'text', source: { type: 'literal', value: '生成短片' } }],
    outputs: [
      { key: 'video', mediaKind: 'video', role: 'primary', order: 0 },
      { key: 'audio', mediaKind: 'audio', role: 'auxiliary', order: 1 },
      { key: 'poster', mediaKind: 'image', role: 'preview', order: 2 },
    ],
    adoptedOutputs: [],
  }
}

/** 创建匹配固定输出合同的运行快照。 */
function run(phase: MediaRunSnapshot['phase'] = 'succeeded'): MediaRunSnapshot {
  return {
    id: 'run-1', projectId: 'project-1', revision: phase === 'succeeded' ? 4 : 1,
    phase, profileId: 'profile-1', profileRevision: 3, createdAt: 1, updatedAt: 4,
    outputs: phase === 'succeeded' ? [
      { outputKey: 'video', index: 0, asset: { assetId: 'video-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'video' } },
      { outputKey: 'audio', index: 0, asset: { assetId: 'audio-1', revision: 1, hash: 'b'.repeat(64), mediaKind: 'audio' } },
      { outputKey: 'poster', index: 0, asset: { assetId: 'image-1', revision: 1, hash: 'c'.repeat(64), mediaKind: 'image' } },
    ] : [],
    error: null, progress: null,
  }
}

/** 内存 Store 精确模拟模块状态 CAS。 */
function createStore(initial?: Partial<CanvasMediaModuleState>): CanvasMediaModuleStore & { current(): CanvasMediaModuleState } {
  let state: CanvasMediaModuleState = {
    schemaVersion: 1, revision: 1, config: config(), operations: [], candidates: [],
    pendingAdoptionProjection: null, ...initial,
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

/** 创建使用真实锁、严格解析和原子 CAS 路径的媒体 Store。 */
function createPersistentStore(initial: CanvasMediaModuleState): {
  store: CanvasMediaModuleStore
  cleanup(): void
} {
  const root = mkdtempSync(join(tmpdir(), 'proma-canvas-media-attach-'))
  const nodesPath = join(root, 'nodes')
  mkdirSync(join(nodesPath, target.mediaModuleId), { recursive: true })
  const files = new Map<string, string>()
  files.set('config.json', JSON.stringify(initial))
  files.set('meta.json', JSON.stringify({
    schemaVersion: 1, kind: target.mediaKind, contentId: target.mediaModuleId,
    revision: initial.revision, createdAt: initial.config.createdAt, updatedAt: initial.config.updatedAt,
  } satisfies CanvasNodeContentMeta))
  const runNative = async (request: StableDirectoryNativeRequest): Promise<StableDirectoryNativeResult> => {
    if (request.mode === 'canvas-content-read') {
      const content = files.get(request.fileName!)
      return { roots: [], entries: [], readOutcome: content === undefined
        ? { status: 'missing' }
        : { status: 'ok', content, size: content.length, volume: '1', fileId: '2' } }
    }
    if (request.mode === 'canvas-content-write') {
      files.set(request.fileName!, request.content!)
      return { roots: [], entries: [], writeOutcome: { commitVisible: true, durabilityUncertain: false } }
    }
    throw new Error('不支持的测试协议')
  }
  return {
    store: createCanvasMediaStore({
      store: { loadWithDirectoryCapability: () => ({
        snapshot: { document: {
          schemaVersion: 4, projectId: target.projectId, canvasId: target.canvasId, revision: 1,
          viewport: { x: 0, y: 0, zoom: 1 }, edges: [], createdAt: 1, updatedAt: 1,
          nodes: [{ id: target.nodeId, kind: 'video', title: '主片', position: { x: 0, y: 0 }, mediaModuleId: target.mediaModuleId }],
        }, writable: true, nodeIssues: [] },
        openSingleChildDirectory: () => ({ path: nodesPath, rootPath: root, assertValid: () => undefined, authorizeOpenedRoots: () => true }),
      }) },
      runStableDirectoryNative: runNative,
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** 构造只实现服务使用面的依赖。 */
function createService(
  store: CanvasMediaModuleStore,
  currentRun: MediaRunSnapshot,
  wait?: () => Promise<MediaRunSnapshot>,
  resolvedInputs?: () => Promise<{
    ready: boolean
    bindings: Array<{
      targetInputKey: string
      requiredKind: 'text'
      sourceNodeId: string | null
      sourceOutputKey: string | null
      sourceArtifactHash: string | null
      resolvedValue: MediaInputValue | null
      errorCode: string | null
    }>
  }>,
  onAdopted?: () => Promise<void>,
  claimPrepared?: (input: {
    projectId: string
    runId: string
    profileId: string
    profileRevision: number
    inputs: Record<string, MediaInputValue>
  }, expectedActor: NonNullable<MediaRunOrigin['actor']>, nextOrigin: MediaRunOrigin) => Promise<MediaRunSnapshot>,
  runOrigin: MediaRunOrigin = { actor: { sessionId: 'session-1', runStartedAt: 1, mode: 'project-agent' } },
  runInputs: Record<string, MediaInputValue> = { prompt: { kind: 'scalar', value: '生成短片' } },
  draft?: {
    workflow: import('@proma/shared').MediaWorkflowDefinition
    prepare(input: {
      projectId: string
      operationId: string
      workflowId: string
      workflowRevision: number
      connectionId: string
      mediaKind: 'image' | 'audio' | 'video'
      inputs: Record<string, MediaInputValue>
    }): Promise<MediaRunSnapshot>
  },
  /** 测试采用阶段的资产完整性读取。 */
  readAsset?: (
    projectId: string,
    asset: CanvasMediaCandidate['outputs'][number]['asset'],
  ) => Promise<Uint8Array>,
): CanvasMediaService {
  return new CanvasMediaService({
    store,
    configuration: {
      resolveProfile: () => ({
        profile: { id: 'profile-1', revision: 3, mediaKind: 'video' },
        workflow: { definition: {
          schemaVersion: 1, prompt: {}, bindings: [],
          outputs: [
            { key: 'video', nodeId: '1', outputIndex: 0, mediaType: 'video' },
            { key: 'audio', nodeId: '2', outputIndex: 0, mediaType: 'audio' },
            { key: 'poster', nodeId: '3', outputIndex: 0, mediaType: 'image' },
          ],
        } },
      }),
      getWorkflow: () => ({ id: 'public-video', revision: 2, projectId: null, definition: draft?.workflow ?? {
        schemaVersion: 1, prompt: {}, bindings: [],
        outputs: [
          { key: 'video', nodeId: '1', outputIndex: 0, mediaType: 'video' },
          { key: 'audio', nodeId: '2', outputIndex: 0, mediaType: 'audio' },
          { key: 'poster', nodeId: '3', outputIndex: 0, mediaType: 'image' },
        ],
      } }),
      resolveConnection: () => ({ connection: { id: 'gpu' } }),
    },
    runs: {
      prepare: async () => currentRun,
      prepareDraft: draft?.prepare ?? (async () => currentRun),
      claimPrepared: claimPrepared ?? (async () => currentRun),
      claimPreparedDraft: async () => currentRun,
      findOperation: () => null,
      get: () => currentRun,
      getInputs: () => structuredClone(runInputs),
      getSourceRef: () => structuredClone(currentRun.sourceRef ?? {
        kind: 'profile-version', profileId: currentRun.profileId!, profileRevision: currentRun.profileRevision!,
      }),
      getWorkflowDefinition: () => ({
        schemaVersion: 1, prompt: {}, bindings: [],
        outputs: [
          { key: 'video', nodeId: '1', outputIndex: 0, mediaType: 'video' },
          { key: 'audio', nodeId: '2', outputIndex: 0, mediaType: 'audio' },
          { key: 'poster', nodeId: '3', outputIndex: 0, mediaType: 'image' },
        ],
      }),
      getOrigin: () => structuredClone(runOrigin),
      cancel: async () => ({ ...currentRun, phase: 'cancelled' }),
    },
    supervisor: {
      start: () => currentRun,
      wait: wait ?? (async () => currentRun),
    },
    assets: {
      list: async () => [],
      read: readAsset ?? (async () => new Uint8Array([1])),
      getRecord: (_projectId, asset): MediaAssetRecord => ({
        id: asset.assetId, revision: 1, hash: asset.hash, filename: `${asset.assetId}.bin`,
        byteSize: 1, mediaType: 'application/octet-stream', mediaKind: asset.mediaKind,
        createdAt: 1,
        sourceSessionId: 'session-1',
        metadata: asset.mediaKind === 'image'
          ? { width: 1, height: 1 }
          : asset.mediaKind === 'audio'
            ? { durationMs: 1, sampleRate: 1, channels: 1, codec: 'test' }
            : { width: 1, height: 1, durationMs: 1, fps: null, codec: 'test', hasAudio: true },
      } as MediaAssetRecord),
    },
    hostFiles: {
      openPreview: async () => ({ mediaLeaseId: 'lease-1', mediaUrl: 'proma-media://lease-1/output' }),
      releasePreview: async () => undefined,
      exportAsset: async () => ({ cancelled: false }),
    },
    resolveWorkflowInputs: resolvedInputs ?? (async () => ({
      ready: true,
      bindings: [{
        targetInputKey: 'prompt', requiredKind: 'text', sourceNodeId: null, sourceOutputKey: null,
        sourceArtifactHash: null, resolvedValue: { kind: 'scalar', value: '生成短片' }, errorCode: null,
      }],
    })),
    onAdopted: onAdopted ?? (async () => undefined),
    authorizeTarget: async () => undefined,
    now: () => 10,
  })
}

describe('Canvas 通用媒体服务', () => {
  test('Given 固定 profile 和确切 operationId When 运行成功 Then 按 key/type/order CAS 挂候选', async () => {
    const store = createStore()
    const service = createService(store, run())
    await service.run({ ...target, expectedConfigRevision: 2, operationId: 'operation-1' }, origin)

    expect(store.current().operations[0]).toMatchObject({
      operationId: 'operation-1', runId: 'run-1', sourceConfigRevision: 2,
      profile: { profileId: 'profile-1', profileRevision: 3 },
    })
    expect(store.current().candidates[0]?.outputs.map((output) => [output.key, output.mediaKind, output.order])).toEqual([
      ['video', 'video', 0], ['audio', 'audio', 1], ['poster', 'image', 2],
    ])
  })

  test('Given 已登记运行仍在执行 When 恢复调用 Then 立即返回 owned run 且不等待终态', async () => {
    const operation = {
      operationId: 'operation-1', runId: 'run-1', sourceConfigRevision: 2,
      profile: { profileId: 'profile-1', profileRevision: 3 },
      outputs: config().outputs.map((output, index) => ({ ...output, nodeId: String(index + 1), outputIndex: 0 })),
      createdAt: 2,
    }
    const store = createStore({ operations: [operation] })
    const running = run('running')
    const service = createService(store, running, async () => { throw new Error('不应等待') })
    await expect(service.run(
      { ...target, expectedConfigRevision: 999, operationId: 'operation-1' }, origin,
    )).resolves.toMatchObject({ id: 'run-1', phase: 'running' })
    expect(store.current().candidates).toEqual([])
  })

  test('Given 角色输出来自同一候选 When 只采用 audio Then 不隐式采用 video 或 poster', async () => {
    const candidate: CanvasMediaCandidate = {
      id: 'candidate-1', operationId: 'operation-1', runId: 'run-1', sourceConfigRevision: 2,
      profile: { profileId: 'profile-1', profileRevision: 3 },
      outputs: config().outputs.map((binding, index) => ({ ...binding, asset: run().outputs[index]!.asset })),
      createdAt: 4,
    }
    const store = createStore({ candidates: [candidate] })
    const service = createService(store, run())
    const adopted = await service.adopt({
      ...target, expectedConfigRevision: 2, candidateId: 'candidate-1', selectedKeys: ['audio'],
    })
    expect(adopted.adoptedOutputs.map((output) => output.key)).toEqual(['audio'])
  })

  test('Given 输出显式属于同一 bundle When 采用缺少同组 key Then 拒绝部分采用', async () => {
    const bundled = config()
    bundled.outputs[0] = { ...bundled.outputs[0]!, bundle: 'av' }
    bundled.outputs[1] = { ...bundled.outputs[1]!, bundle: 'av' }
    const candidate: CanvasMediaCandidate = {
      id: 'candidate-1', operationId: 'operation-1', runId: 'run-1', sourceConfigRevision: 2,
      profile: { ...bundled.profile! },
      outputs: bundled.outputs.map((binding, index) => ({ ...binding, asset: run().outputs[index]!.asset })),
      createdAt: 4,
    }
    const store = createStore({ config: bundled, candidates: [candidate] })
    const service = createService(store, run())
    await expect(service.adopt({
      ...target, expectedConfigRevision: 2, candidateId: 'candidate-1', selectedKeys: ['video'],
    })).rejects.toThrow('CANVAS_MEDIA_BUNDLE_INCOMPLETE')
  })

  test('Given 精确候选输出 When 预览与导出 Then Host 只接收该不可变资产引用', async () => {
    const candidate: CanvasMediaCandidate = {
      id: 'candidate-1', operationId: 'operation-1', runId: 'run-1', sourceConfigRevision: 2,
      profile: { profileId: 'profile-1', profileRevision: 3 },
      outputs: config().outputs.map((binding, index) => ({ ...binding, asset: run().outputs[index]!.asset })),
      createdAt: 4,
    }
    const store = createStore({ candidates: [candidate] })
    const service = createService(store, run())
    const input = { ...target, candidateId: 'candidate-1', outputKey: 'audio', outputOrder: 1 }
    expect(await service.readPreview(input)).toMatchObject({
      mediaLeaseId: 'lease-1', mediaUrl: 'proma-media://lease-1/output', asset: { id: 'audio-1', mediaKind: 'audio' },
    })
    expect(await service.exportOutput(input)).toEqual({ cancelled: false })
    await expect(service.exportOutput({ ...input, outputOrder: 0 })).rejects.toThrow('CANVAS_MEDIA_OUTPUT_NOT_FOUND')
  })

  test('Given 后台运行已完成 When load 刷新 Then 幂等补挂候选', async () => {
    const operation = {
      operationId: 'operation-1', runId: 'run-1', sourceConfigRevision: 2,
      profile: { profileId: 'profile-1', profileRevision: 3 },
      outputs: config().outputs.map((output, index) => ({ ...output, nodeId: String(index + 1), outputIndex: 0 })),
      createdAt: 2,
    }
    const store = createStore({ operations: [operation] })
    const service = createService(store, run())
    await service.load(target)
    await service.refreshCompleted(target)
    expect(store.current().candidates).toHaveLength(1)
  })

  test('Given Host 媒体来源未绑定当前 Canvas 节点 When 运行 Then 在 prepare 前拒绝', async () => {
    const store = createStore()
    const service = createService(store, run())
    await expect(service.run(
      { ...target, expectedConfigRevision: 2, operationId: 'operation-1' },
      { ...origin, canvasMedia: { ...target, nodeId: 'node-other' } },
    )).rejects.toThrow('CANVAS_MEDIA_RUN_ORIGIN_INVALID')
    expect(store.current().operations).toEqual([])
  })

  test('Given Renderer 运行无 Agent actor When Host 已绑定媒体目标 Then 允许执行', async () => {
    const store = createStore()
    const service = createService(store, run())
    await expect(service.run(
      { ...target, expectedConfigRevision: 2, operationId: 'operation-ui' },
      { canvasMedia: target },
    )).resolves.toMatchObject({ id: 'run-1', phase: 'succeeded' })
  })

  test('Given DAG 输入尚未就绪 When 启动新运行 Then 在 prepare 前明确拒绝', async () => {
    const store = createStore()
    const service = createService(store, run(), undefined, async () => ({ ready: false, bindings: [] }))
    await expect(service.run(
      { ...target, expectedConfigRevision: 2, operationId: 'operation-1' },
      origin,
    )).rejects.toThrow('CANVAS_MEDIA_INPUTS_NOT_READY')
    expect(store.current().operations).toEqual([])
  })

  test('Given workflow 预检输入哈希不匹配 When 启动新运行 Then 在 prepare 前拒绝漂移', async () => {
    const store = createStore()
    const service = createService(store, run())
    await expect(service.run(
      { ...target, expectedConfigRevision: 2, operationId: 'operation-1' },
      origin,
      { expectedInputHashes: { prompt: '0'.repeat(64) } },
    )).rejects.toThrow('CANVAS_MEDIA_INPUT_HASH_MISMATCH')
    expect(store.current().operations).toEqual([])
  })

  test('Given 父工作流已准备同主体运行 When Canvas 输入仍一致 Then 接管原 run 并登记 operation', async () => {
    const store = createStore()
    const preparedActor = {
      sessionId: 'child-session', runStartedAt: 8, mode: 'project-agent' as const,
      canvasId: target.canvasId, nodeId: target.nodeId,
    }
    const claims: Array<{
      runId: string
      actor: NonNullable<MediaRunOrigin['actor']>
      nextOrigin: MediaRunOrigin
    }> = []
    const service = createService(store, run('running'), undefined, undefined, undefined, async (input, actor, nextOrigin) => {
      claims.push({ runId: input.runId, actor, nextOrigin })
      return run('running')
    })

    await service.run(
      { ...target, expectedConfigRevision: 2, operationId: 'operation-parent' },
      origin,
      { preparedRunId: 'run-1', preparedActor },
    )

    expect(claims).toEqual([{ runId: 'run-1', actor: preparedActor, nextOrigin: origin }])
    expect(store.current().operations[0]).toMatchObject({
      operationId: 'operation-parent', runId: 'run-1', sourceConfigRevision: 2,
    })
  })

  test('Given child 用项目 WorkflowDraft 准备运行 When 父工作流接管 Then 候选保留草稿来源且不伪造 profile', async () => {
    const draftSource = {
      kind: 'project-draft-revision' as const, workflowId: 'draft-video', workflowRevision: 2,
      connectionId: 'gpu', mediaKind: 'video' as const,
    }
    const draftRun = { ...run(), sourceRef: draftSource, profileId: undefined, profileRevision: undefined }
    const store = createStore({ config: { ...config(), profile: null } })
    const service = createService(store, draftRun)
    const preparedActor = { sessionId: 'child-session', runStartedAt: 1, mode: 'parent-orchestrated' as const,
      canvasId: 'canvas-1', nodeId: 'agent-child' }

    await service.run({ ...target, expectedConfigRevision: 2, operationId: 'draft-operation' }, origin, {
      preparedRunId: 'run-1', preparedActor, preparedSourceRef: draftSource,
    })

    expect(store.current().operations[0]).toMatchObject({ sourceRef: draftSource })
    expect(store.current().operations[0]?.profile).toBeUndefined()
    expect(store.current().candidates[0]).toMatchObject({ sourceRef: draftSource })
    expect(store.current().candidates[0]?.profile).toBeUndefined()
  })

  test('Given 公共工作流和显式连接 When 手动运行 Then 重新校验精确合同并调用 prepareDraft', async () => {
    const sourceRef = {
      kind: 'project-draft-revision' as const,
      workflowId: 'public-video', workflowRevision: 2, connectionId: 'gpu', mediaKind: 'video' as const,
    }
    const draftRun = { ...run('running'), sourceRef, profileId: undefined, profileRevision: undefined }
    const workflow: import('@proma/shared').MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: { '1': { class_type: 'TextNode', inputs: { text: '生成短片' } } },
      bindings: [{ key: 'prompt', kind: 'text', nodeId: '1', input: 'text' }],
      outputs: config().outputs.map((output, index) => ({
        key: output.key, nodeId: String(index + 2), outputIndex: 0, mediaType: output.mediaKind,
      })),
    }
    const savedConfig = { ...config(), profile: null, workflow: {
      workflowId: 'public-video', workflowRevision: 2, connectionId: 'gpu',
    } }
    const prepared: Array<{ operationId: string; workflowId: string; connectionId: string }> = []
    const service = createService(createStore({ config: savedConfig }), draftRun, undefined, undefined,
      undefined, undefined, undefined, undefined, {
        workflow,
        prepare: async (input) => {
          prepared.push({ operationId: input.operationId, workflowId: input.workflowId, connectionId: input.connectionId })
          return draftRun
        },
      })

    await service.run({ ...target, expectedConfigRevision: 2, operationId: 'manual-draft' }, origin)

    expect(prepared).toEqual([{ operationId: 'manual-draft', workflowId: 'public-video', connectionId: 'gpu' }])
  })

  test('Given 公共工作流输入合同已变化 When 手动运行 Then 在 prepareDraft 前拒绝旧草稿', async () => {
    const workflow: import('@proma/shared').MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: { '1': { class_type: 'TextNode', inputs: { text: '生成短片' } } },
      bindings: [{ key: 'renamed-prompt', kind: 'text', nodeId: '1', input: 'text' }],
      outputs: config().outputs.map((output, index) => ({
        key: output.key, nodeId: String(index + 2), outputIndex: 0, mediaType: output.mediaKind,
      })),
    }
    const savedConfig = { ...config(), profile: null, workflow: {
      workflowId: 'public-video', workflowRevision: 2, connectionId: 'gpu',
    } }
    let prepareCount = 0
    const service = createService(createStore({ config: savedConfig }), run('running'), undefined, undefined,
      undefined, undefined, undefined, undefined, {
        workflow,
        prepare: async () => { prepareCount += 1; return run('running') },
      })

    await expect(service.run(
      { ...target, expectedConfigRevision: 2, operationId: 'stale-draft' }, origin,
    )).rejects.toThrow('CANVAS_MEDIA_INPUT_CONTRACT_MISMATCH')
    expect(prepareCount).toBe(0)
  })

  test('Given prepared run 与主体只提供一项 When 运行 Then 在读取模块前拒绝不完整 handoff', async () => {
    const service = createService(createStore(), run('running'))

    await expect(service.run(
      { ...target, expectedConfigRevision: 2, operationId: 'operation-parent' },
      origin,
      { preparedRunId: 'run-1' },
    )).rejects.toThrow('CANVAS_MEDIA_PREPARED_HANDOFF_INVALID')
  })

  test('Given 普通 Agent 已成功独立 run When 挂接两次 Then 真实候选身份幂等且不执行或自动采用', async () => {
    const store = createStore()
    const service = createService(store, run())
    const input = { ...target, expectedConfigRevision: 2, runId: 'run-1' }
    const actor = { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' as const }

    const first = await service.attachCompletedRun(input, actor)
    const second = await service.attachCompletedRun(input, actor)

    expect(second).toEqual(first)
    expect(store.current().operations).toHaveLength(1)
    expect(store.current().candidates).toHaveLength(1)
    expect(store.current().config.adoptedOutputs).toEqual([])
    expect(first).toMatchObject({ id: 'candidate:run-1', runId: 'run-1', sourceConfigRevision: 2 })
  })

  test('Given 普通 Agent 导入完整多媒体输出 When 回填视频节点两次 Then 形成单一本地候选且可复用原采用流程', async () => {
    const store = createStore()
    const service = createService(store, run())
    const actor = { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' as const }
    const input = {
      ...target, expectedConfigRevision: 2, operationId: 'local-import-1',
      outputs: run().outputs.map((output) => ({ key: output.outputKey, asset: output.asset })),
    }

    const first = await service.attachImportedAssets(input, actor)
    const second = await service.attachImportedAssets(input, actor)
    const adopted = await service.adopt({
      ...target, expectedConfigRevision: 2, candidateId: first.id, selectedKeys: ['audio'],
    })

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      operationId: 'local-import-1', runId: expect.stringMatching(/^local-[0-9a-f]{40}$/),
      source: { kind: 'local-import', operationId: 'local-import-1', sourceSessionId: 'session-1' },
      outputs: [{ key: 'video' }, { key: 'audio' }, { key: 'poster' }],
    })
    expect(store.current().operations).toEqual([])
    expect(store.current().candidates).toHaveLength(1)
    expect(adopted.adoptedOutputs.map((output) => output.key)).toEqual(['audio'])
  })

  test('Given 本地候选元数据仍存在但资产缺失或篡改 When 正式采用 Then 拒绝且模块状态零写入', async () => {
    const actor = { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' as const }
    for (const errorCode of ['ENOENT', 'MEDIA_ASSET_CHANGED']) {
      const store = createStore()
      const verifiedAssetIds: string[] = []
      const service = createService(
        store,
        run(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async (_projectId, asset) => {
          verifiedAssetIds.push(asset.assetId)
          throw new Error(errorCode)
        },
      )
      const candidate = await service.attachImportedAssets({
        ...target,
        expectedConfigRevision: 2,
        operationId: `local-import-${errorCode.toLowerCase()}`,
        outputs: run().outputs.map((output) => ({ key: output.outputKey, asset: output.asset })),
      }, actor)
      const before = store.current()

      await expect(service.adopt({
        ...target,
        expectedConfigRevision: 2,
        candidateId: candidate.id,
        selectedKeys: ['audio'],
      })).rejects.toThrow(errorCode)

      expect(store.current()).toEqual(before)
      expect(store.current().config.adoptedOutputs).toEqual([])
      expect(store.current().pendingAdoptionProjection).toBeNull()
      expect(verifiedAssetIds).toEqual([
        candidate.outputs.find((output) => output.key === 'audio')!.asset.assetId,
      ])
    }
  })

  test('Given 同一本地 operation 更换输出 When 回填 Then 拒绝覆盖首次候选身份', async () => {
    const store = createStore()
    const service = createService(store, run())
    const actor = { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' as const }
    const outputs = run().outputs.map((output) => ({ key: output.outputKey, asset: output.asset }))
    await service.attachImportedAssets({ ...target, expectedConfigRevision: 2, operationId: 'local-import-1', outputs }, actor)

    await expect(service.attachImportedAssets({
      ...target, expectedConfigRevision: 2, operationId: 'local-import-1',
      outputs: outputs.map((output, index) => index === 0 ? { ...output, asset: { ...output.asset, hash: 'f'.repeat(64) } } : output),
    }, actor)).rejects.toThrow('CANVAS_MEDIA_LOCAL_IMPORT_CONFLICT')
    expect(store.current().candidates).toHaveLength(1)
  })

  test('Given 本地资产来源会话、key 或类型不匹配 When 回填 Then 不产生候选', async () => {
    const actor = { sessionId: 'other-session', runStartedAt: 99, mode: 'project-agent' as const }
    const cases = [
      run().outputs.map((output) => ({ key: output.outputKey, asset: output.asset })),
      run().outputs.map((output, index) => ({ key: index === 0 ? 'unknown' : output.outputKey, asset: output.asset })),
      run().outputs.map((output, index) => ({ key: output.outputKey, asset: index === 1
        ? { ...output.asset, mediaKind: 'video' as const } : output.asset })),
    ]
    const errors = ['CANVAS_MEDIA_LOCAL_ASSET_NOT_OWNED', 'CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH', 'CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH']
    for (const [index, outputs] of cases.entries()) {
      const store = createStore()
      await expect(createService(store, run()).attachImportedAssets({
        ...target, expectedConfigRevision: 2, operationId: `local-import-${index}`, outputs,
      }, index === 0 ? actor : { ...actor, sessionId: 'session-1' })).rejects.toThrow(errors[index]!)
      expect(store.current().candidates).toEqual([])
    }
  })

  test('Given 独立 run 已挂接并采用 When 使用新配置 revision 重放挂接 Then 返回首次候选且保留原来源 revision', async () => {
    const store = createStore()
    const service = createService(store, run())
    const actor = { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' as const }
    const first = await service.attachCompletedRun(
      { ...target, expectedConfigRevision: 2, runId: 'run-1' }, actor,
    )
    await service.adopt({
      ...target, expectedConfigRevision: 2, candidateId: first.id, selectedKeys: ['video'],
    })

    const replay = await service.attachCompletedRun(
      { ...target, expectedConfigRevision: 3, runId: 'run-1' }, actor,
    )

    expect(replay).toEqual(first)
    expect(replay.sourceConfigRevision).toBe(2)
    expect(store.current().operations).toHaveLength(1)
    expect(store.current().operations[0]?.sourceConfigRevision).toBe(2)
    expect(store.current().candidates).toHaveLength(1)
  })

  test('Given 成功 run 已挂接到真实 Store When 服务重建后重放 Then 保留单一 operation 与候选', async () => {
    const persistent = createPersistentStore(createStore().current())
    try {
      const input = { ...target, expectedConfigRevision: 2, runId: 'run-1' }
      const actor = { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' as const }
      await createService(persistent.store, run()).attachCompletedRun(input, actor)
      await createService(persistent.store, run()).attachCompletedRun(input, actor)

      const state = await persistent.store.load(target)
      expect(state.operations).toHaveLength(1)
      expect(state.candidates).toHaveLength(1)
      expect(state.candidates[0]).toMatchObject({ id: 'candidate:run-1', runId: 'run-1' })
      expect(state.config.adoptedOutputs).toEqual([])
    } finally {
      persistent.cleanup()
    }
  })

  test('Given run 跨 actor、跨项目或尚未成功 When 挂接 Then 在候选写入前拒绝冒领', async () => {
    const actor = { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' as const }
    const cases: Array<{ currentRun: MediaRunSnapshot; origin?: MediaRunOrigin; error: string }> = [
      { currentRun: run(), origin: { actor: { sessionId: 'other-session', runStartedAt: 1, mode: 'project-agent' } }, error: 'CANVAS_MEDIA_ATTACH_RUN_NOT_OWNED' },
      { currentRun: { ...run(), projectId: 'other-project' }, error: 'CANVAS_MEDIA_ATTACH_RUN_NOT_SUCCEEDED' },
      { currentRun: run('running'), error: 'CANVAS_MEDIA_ATTACH_RUN_NOT_SUCCEEDED' },
    ]
    for (const current of cases) {
      const store = createStore()
      const service = createService(store, current.currentRun, undefined, undefined, undefined, undefined, current.origin)
      await expect(service.attachCompletedRun({ ...target, expectedConfigRevision: 2, runId: 'run-1' }, actor))
        .rejects.toThrow(current.error)
      expect(store.current().operations).toEqual([])
      expect(store.current().candidates).toEqual([])
    }
  })

  test('Given run 的 profile 或输出合同不匹配目标配置 When 挂接 Then 不复制部分输出', async () => {
    const actor = { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' as const }
    const mismatchedProfile = { ...run(), profileRevision: 4 }
    const profileStore = createStore()
    await expect(createService(profileStore, mismatchedProfile).attachCompletedRun(
      { ...target, expectedConfigRevision: 2, runId: 'run-1' }, actor,
    )).rejects.toThrow('CANVAS_MEDIA_PROFILE_MISMATCH')

    const incomplete = { ...run(), outputs: run().outputs.slice(0, 2) }
    const outputStore = createStore()
    await expect(createService(outputStore, incomplete).attachCompletedRun(
      { ...target, expectedConfigRevision: 2, runId: 'run-1' }, actor,
    )).rejects.toThrow('CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH')
    expect(outputStore.current().candidates).toEqual([])
  })

  test('Given 独立 run 使用了不同 typed inputs When 挂接 Then 不写入虚假当前配置候选', async () => {
    const store = createStore()
    const service = createService(
      store, run(), undefined, undefined, undefined, undefined, undefined,
      { prompt: { kind: 'scalar', value: '另一条提示词' } },
    )
    const actor = { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' as const }

    await expect(service.attachCompletedRun(
      { ...target, expectedConfigRevision: 2, runId: 'run-1' }, actor,
    )).rejects.toThrow('CANVAS_MEDIA_ATTACH_INPUT_MISMATCH')
    expect(store.current().operations).toEqual([])
    expect(store.current().candidates).toEqual([])
  })

  test('Given resolver await 期间配置变化 When 提交运行 Then fresh revision 检查拒绝旧输入', async () => {
    const store = createStore()
    const service = createService(store, run(), undefined, async () => {
      const before = await store.load(target)
      await store.compareAndSwap(target, before.revision, {
        ...before,
        revision: before.revision + 1,
        config: { ...before.config, revision: 3, updatedAt: 3 },
      })
      return {
        ready: true,
        bindings: [{
          targetInputKey: 'prompt' as const, requiredKind: 'text' as const,
          sourceNodeId: null, sourceOutputKey: null, sourceArtifactHash: null,
          resolvedValue: { kind: 'scalar' as const, value: '生成短片' }, errorCode: null,
        }],
      }
    })
    await expect(service.run(
      { ...target, expectedConfigRevision: 2, operationId: 'operation-1' }, origin,
    )).rejects.toThrow('CANVAS_MEDIA_CONFIG_CONFLICT')
  })

  test('Given 正式采用已提交但 Host 传播失败 When 后续 load Then 重放并清除持久 marker', async () => {
    const candidate: CanvasMediaCandidate = {
      id: 'candidate-1', operationId: 'operation-1', runId: 'run-1', sourceConfigRevision: 2,
      profile: { profileId: 'profile-1', profileRevision: 3 },
      outputs: config().outputs.map((binding, index) => ({ ...binding, asset: run().outputs[index]!.asset })),
      createdAt: 4,
    }
    const store = createStore({ candidates: [candidate] })
    let fail = true
    const service = createService(store, run(), undefined, undefined, async () => {
      if (fail) throw new Error('传播暂时失败')
    })
    await expect(service.adopt({
      ...target, expectedConfigRevision: 2, candidateId: candidate.id, selectedKeys: ['audio'],
    })).rejects.toThrow('CANVAS_MEDIA_ADOPTION_PROPAGATION_PENDING')
    expect(store.current().pendingAdoptionProjection).toMatchObject({
      configRevision: 3, candidateId: candidate.id, selectedKeys: ['audio'],
    })
    fail = false
    await service.load(target)
    expect(store.current().pendingAdoptionProjection).toBeNull()
  })
})
