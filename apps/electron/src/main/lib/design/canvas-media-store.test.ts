import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanvasDocument, CanvasMediaTarget, CanvasNodeContentMeta } from '@proma/shared'
import type { StableDirectoryNativeRequest, StableDirectoryNativeResult } from '../stable-directory-native-host'
import { acquireMediaFileLock } from '../media/media-file-lock'
import {
  createCanvasMediaStore,
  createInitialCanvasMediaModuleState,
  type CanvasMediaStoreDependencies,
} from './canvas-media-store'
import type { CanvasMediaModuleState } from './canvas-media-service'

/** 测试使用的完整媒体模块身份。 */
const target: CanvasMediaTarget = {
  projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'video-1',
  mediaModuleId: 'media-1', mediaKind: 'video',
}

/** 单个测试夹具暴露磁盘投影和可控写入故障。 */
interface MediaStoreFixture {
  files: Map<string, string>
  modulePath: string
  store: ReturnType<typeof createCanvasMediaStore>
  createStore(): ReturnType<typeof createCanvasMediaStore>
  changed: CanvasMediaModuleState[]
  setDocument(document: CanvasDocument): void
  setMetaWriteFailure(enabled: boolean): void
  seed(state: CanvasMediaModuleState, meta?: CanvasNodeContentMeta): void
}

/** 每个夹具的真实锁目录，测试结束统一回收。 */
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建真实锁、内存文件和权威 Canvas 归属的 Store。 */
function createFixture(
  documentOverride?: CanvasDocument,
  fixtureTarget: CanvasMediaTarget = target,
  beforeRead?: (request: StableDirectoryNativeRequest) => Promise<void>,
): MediaStoreFixture {
  const root = mkdtempSync(join(tmpdir(), 'proma-canvas-media-store-'))
  roots.push(root)
  const nodesPath = join(root, 'nodes')
  const modulePath = join(nodesPath, fixtureTarget.mediaModuleId)
  mkdirSync(modulePath, { recursive: true })
  const files = new Map<string, string>()
  const changed: CanvasMediaModuleState[] = []
  let failMetaWrite = false
  let document: CanvasDocument = documentOverride ?? {
    schemaVersion: 4, projectId: fixtureTarget.projectId, canvasId: fixtureTarget.canvasId, revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: fixtureTarget.nodeId, kind: fixtureTarget.mediaKind, title: '短片', position: { x: 0, y: 0 },
      mediaModuleId: fixtureTarget.mediaModuleId,
    }],
    edges: [], createdAt: 1, updatedAt: 1,
  }
  /** stable-directory helper 的内存实现保留每次原子提交结果。 */
  const runNative = async (request: StableDirectoryNativeRequest): Promise<StableDirectoryNativeResult> => {
    if (request.mode === 'canvas-content-read') {
      await beforeRead?.(request)
      const content = files.get(request.fileName!)
      return {
        roots: [], entries: [],
        readOutcome: content === undefined
          ? { status: 'missing' }
          : { status: 'ok', content, size: content.length, volume: '1', fileId: '2' },
      }
    }
    if (request.mode === 'canvas-content-write') {
      if (request.fileName === 'meta.json' && failMetaWrite) {
        return {
          roots: [], entries: [],
          writeOutcome: { commitVisible: false, durabilityUncertain: false, error: 'injected' },
        }
      }
      files.set(request.fileName!, request.content!)
      return { roots: [], entries: [], writeOutcome: { commitVisible: true, durabilityUncertain: false } }
    }
    throw new Error(`不支持的测试协议: ${request.mode}`)
  }
  const dependencies: CanvasMediaStoreDependencies = {
    store: {
      loadWithDirectoryCapability: () => ({
        snapshot: { document, writable: true, nodeIssues: [] },
        openSingleChildDirectory: () => ({
          path: nodesPath,
          rootPath: root,
          assertValid: () => undefined,
          authorizeOpenedRoots: () => true,
        }),
      }),
    },
    runStableDirectoryNative: runNative,
    onChanged: (_changedTarget, state) => {
      /** 通知必须发生在两个文件都可见之后。 */
      expect(JSON.parse(files.get('config.json')!).revision).toBe(state.revision)
      expect(JSON.parse(files.get('meta.json')!).revision).toBe(state.revision)
      changed.push(structuredClone(state))
    },
  }
  const createStore = (): ReturnType<typeof createCanvasMediaStore> => createCanvasMediaStore(dependencies)
  return {
    files,
    modulePath,
    store: createStore(),
    createStore,
    changed,
    setDocument: (nextDocument) => { document = nextDocument },
    setMetaWriteFailure: (enabled) => { failMetaWrite = enabled },
    seed: (state, meta) => {
      files.set('config.json', JSON.stringify(state))
      files.set('meta.json', JSON.stringify(meta ?? {
        schemaVersion: 1,
        kind: fixtureTarget.mediaKind,
        contentId: fixtureTarget.mediaModuleId,
        revision: state.revision,
        createdAt: state.config.createdAt,
        updatedAt: state.config.updatedAt,
      } satisfies CanvasNodeContentMeta))
    },
  }
}

/** 从当前状态生成满足单步 CAS 的下一状态。 */
function nextState(current: CanvasMediaModuleState): CanvasMediaModuleState {
  return {
    ...current,
    revision: current.revision + 1,
    config: { ...current.config, updatedAt: current.config.updatedAt + 1 },
  }
}

describe('CanvasMediaStore', () => {
  test('Given 两个 Store 实例并发读取同一模块 When 首次读取持锁 Then 后续读取等待并全部成功', async () => {
    let releaseRead = (): void => undefined
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    let notifyStarted = (): void => undefined
    const readStarted = new Promise<void>((resolve) => { notifyStarted = resolve })
    let blockFirstRead = true
    const fixture = createFixture(undefined, target, async () => {
      if (!blockFirstRead) return
      blockFirstRead = false
      notifyStarted()
      await readGate
    })
    fixture.seed(createInitialCanvasMediaModuleState(target, 10))

    const first = fixture.store.load(target)
    await readStarted
    const second = fixture.createStore().load(target)
    releaseRead()

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  test('Given LOAD 与 CAS 并发访问同一模块 When LOAD 先持锁 Then CAS 等待后保持 revision 语义', async () => {
    let releaseRead = (): void => undefined
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    let notifyStarted = (): void => undefined
    const readStarted = new Promise<void>((resolve) => { notifyStarted = resolve })
    let blockFirstRead = true
    const fixture = createFixture(undefined, target, async () => {
      if (!blockFirstRead) return
      blockFirstRead = false
      notifyStarted()
      await readGate
    })
    const initial = createInitialCanvasMediaModuleState(target, 10)
    fixture.seed(initial)

    const load = fixture.store.load(target)
    await readStarted
    const swap = fixture.store.compareAndSwap(target, 0, nextState(initial))
    releaseRead()

    await expect(load).resolves.toMatchObject({ revision: 0 })
    await expect(swap).resolves.toMatchObject({ revision: 1 })
  })

  test('Given 不同媒体模块并发读取 When 一个模块暂停 Then 另一个模块仍立即完成', async () => {
    let releaseRead = (): void => undefined
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    let notifyStarted = (): void => undefined
    const readStarted = new Promise<void>((resolve) => { notifyStarted = resolve })
    let blockFirstRead = true
    const first = createFixture(undefined, target, async () => {
      if (!blockFirstRead) return
      blockFirstRead = false
      notifyStarted()
      await readGate
    })
    const otherTarget: CanvasMediaTarget = {
      ...target, nodeId: 'video-2', mediaModuleId: 'media-2',
    }
    const other = createFixture(undefined, otherTarget)
    first.seed(createInitialCanvasMediaModuleState(target, 10))
    other.seed(createInitialCanvasMediaModuleState(otherTarget, 10))

    const blocked = first.store.load(target)
    await readStarted
    await expect(other.store.load(otherTarget)).resolves.toMatchObject({ revision: 0 })
    releaseRead()
    await blocked
  })

  test('Given 同模块前序读取失败 When 后续读取已排队 Then 队列继续执行成功', async () => {
    let releaseRead = (): void => undefined
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    let notifyStarted = (): void => undefined
    const readStarted = new Promise<void>((resolve) => { notifyStarted = resolve })
    let firstRead = true
    const fixture = createFixture(undefined, target, async () => {
      if (!firstRead) return
      firstRead = false
      notifyStarted()
      await readGate
      throw new Error('测试读取失败')
    })
    fixture.seed(createInitialCanvasMediaModuleState(target, 10))

    const failed = fixture.store.load(target)
    await readStarted
    const next = fixture.createStore().load(target)
    releaseRead()

    await expect(failed).rejects.toThrow('测试读取失败')
    await expect(next).resolves.toMatchObject({ revision: 0 })
  })

  test('Given 同模块后续读取等待期间节点归属变化 When 后续任务出队 Then 重新校验最新 Canvas 授权', async () => {
    let releaseRead = (): void => undefined
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    let notifyStarted = (): void => undefined
    const readStarted = new Promise<void>((resolve) => { notifyStarted = resolve })
    let blockFirstRead = true
    const fixture = createFixture(undefined, target, async () => {
      if (!blockFirstRead) return
      blockFirstRead = false
      notifyStarted()
      await readGate
    })
    fixture.seed(createInitialCanvasMediaModuleState(target, 10))

    const first = fixture.store.load(target)
    await readStarted
    const queued = fixture.createStore().load(target)
    fixture.setDocument({
      schemaVersion: 4, projectId: target.projectId, canvasId: target.canvasId, revision: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{
        id: target.nodeId, kind: 'video', title: '已替换短片', position: { x: 0, y: 0 },
        mediaModuleId: 'media-replaced',
      }],
      edges: [], createdAt: 1, updatedAt: 2,
    })
    /** 立即收口后继结果，避免在首个断言完成前留下未处理拒绝。 */
    const queuedOutcome = queued.then(
      () => 'unexpected-success',
      (error: unknown) => error instanceof Error ? error.message : String(error),
    )
    releaseRead()

    await expect(first).resolves.toMatchObject({ revision: 0 })
    expect(await queuedOutcome).toBe('CANVAS_MEDIA_TARGET_INVALID')
  })

  test('Given Canvas 节点不拥有目标模块 When load Then 在任何文件读取前拒绝', async () => {
    const fixture = createFixture({
      schemaVersion: 4, projectId: target.projectId, canvasId: target.canvasId, revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{
        id: target.nodeId, kind: 'video', title: '其他短片', position: { x: 0, y: 0 },
        mediaModuleId: 'media-other',
      }],
      edges: [], createdAt: 1, updatedAt: 1,
    })

    await expect(fixture.store.load(target)).rejects.toThrow('CANVAS_MEDIA_TARGET_INVALID')
  })

  test('Given state revision 已推进 When 用旧 revision CAS Then 拒绝覆盖', async () => {
    const fixture = createFixture()
    const current = { ...createInitialCanvasMediaModuleState(target, 10), revision: 2 }
    fixture.seed(current)

    await expect(fixture.store.compareAndSwap(target, 1, nextState(current)))
      .rejects.toThrow('CANVAS_MEDIA_STATE_CONFLICT')
  })

  test('Given 配置 revision 与 Store revision 独立 When 单步 CAS Then 两者无需同步递增', async () => {
    const fixture = createFixture()
    const initial = createInitialCanvasMediaModuleState(target, 10)
    const current = { ...initial, revision: 4, config: { ...initial.config, revision: 2 } }
    fixture.seed(current)
    const requested = {
      ...nextState(current),
      config: { ...current.config, revision: 2, updatedAt: 11 },
    }

    await expect(fixture.store.compareAndSwap(target, 4, requested))
      .resolves.toMatchObject({ revision: 5, config: { revision: 2 } })
    expect(fixture.changed).toHaveLength(1)
  })

  test('Given 另一 owner 持有模块锁 When load Then 返回 busy 且不读取状态', async () => {
    const fixture = createFixture()
    fixture.seed(createInitialCanvasMediaModuleState(target, 10))
    const release = acquireMediaFileLock(join(fixture.modulePath, '.canvas-media.lock'))
    try {
      await expect(fixture.store.load(target)).rejects.toThrow('MEDIA_FILE_BUSY')
    } finally {
      release()
    }
  })

  test('Given config 与 meta 相差超过一步或身份错配 When load Then fail closed', async () => {
    const fixture = createFixture()
    const current = { ...createInitialCanvasMediaModuleState(target, 10), revision: 3 }
    fixture.seed(current, {
      schemaVersion: 1, kind: 'video', contentId: target.mediaModuleId,
      revision: 1, createdAt: 10, updatedAt: 10,
    })
    await expect(fixture.store.load(target)).rejects.toThrow('CANVAS_MEDIA_IDENTITY_CONFLICT')

    fixture.seed(current, {
      schemaVersion: 1, kind: 'video', contentId: 'media-other',
      revision: 3, createdAt: 10, updatedAt: 10,
    })
    await expect(fixture.store.load(target)).rejects.toThrow('CANVAS_MEDIA_IDENTITY_CONFLICT')
  })

  test('Given config 已提交但 meta 写失败 When 重启 load Then 自动修复唯一一步并通知', async () => {
    const fixture = createFixture()
    const current = createInitialCanvasMediaModuleState(target, 10)
    fixture.seed(current)
    fixture.setMetaWriteFailure(true)

    await expect(fixture.store.compareAndSwap(target, 0, nextState(current)))
      .rejects.toThrow('CANVAS_MEDIA_SAVE_FAILED')
    expect(JSON.parse(fixture.files.get('config.json')!).revision).toBe(1)
    expect(JSON.parse(fixture.files.get('meta.json')!).revision).toBe(0)

    fixture.setMetaWriteFailure(false)
    await expect(fixture.store.load(target)).resolves.toMatchObject({ revision: 1 })
    expect(JSON.parse(fixture.files.get('meta.json')!).revision).toBe(1)
    expect(fixture.changed).toHaveLength(1)
  })

  test('Given 项目 WorkflowDraft 运行与候选 When Store 提交后重读 Then 保留真实来源且不生成 profile', async () => {
    const fixture = createFixture()
    const initial = createInitialCanvasMediaModuleState(target, 10)
    fixture.seed(initial)
    /** 草稿来源固定项目工作流 revision、连接和媒体类型，禁止伪装成已发布预设。 */
    const sourceRef = {
      kind: 'project-draft-revision' as const,
      workflowId: 'draft-video',
      workflowRevision: 2,
      connectionId: 'gpu',
      mediaKind: 'video' as const,
    }
    /** 下一状态同时覆盖可运行配置、运行登记与成功候选的真实磁盘投影。 */
    const next: CanvasMediaModuleState = {
      schemaVersion: 1,
      revision: 1,
      config: {
        ...initial.config,
        revision: 1,
        updatedAt: 11,
        profile: null,
        workflow: { workflowId: 'draft-video', workflowRevision: 2, connectionId: 'gpu' },
        inputs: [{ key: 'prompt', kind: 'text', source: { type: 'literal', value: '海边日落' } }],
        outputs: [{ key: 'video', mediaKind: 'video', role: 'primary', order: 0 }],
      },
      operations: [{
        operationId: 'draft-operation',
        runId: 'run-draft',
        sourceConfigRevision: 1,
        sourceRef,
        outputs: [{
          key: 'video', mediaKind: 'video', role: 'primary', order: 0,
          nodeId: 'node-output', outputIndex: 0,
        }],
        createdAt: 11,
      }],
      candidates: [{
        id: 'candidate-draft',
        operationId: 'draft-operation',
        runId: 'run-draft',
        sourceConfigRevision: 1,
        sourceRef,
        outputs: [{
          key: 'video', mediaKind: 'video', role: 'primary', order: 0,
          asset: { assetId: 'asset-video', revision: 1, hash: 'b'.repeat(64), mediaKind: 'video' },
        }],
        createdAt: 12,
      }],
      pendingAdoptionProjection: null,
    }

    await fixture.store.compareAndSwap(target, 0, next)
    const restored = await fixture.store.load(target)

    expect(restored.config.profile).toBeNull()
    expect(restored.config.workflow).toEqual({ workflowId: 'draft-video', workflowRevision: 2, connectionId: 'gpu' })
    expect(restored.config.outputs).toEqual(next.config.outputs)
    expect(restored.operations[0]).toMatchObject({ sourceRef })
    expect(restored.operations[0]?.profile).toBeUndefined()
    expect(restored.candidates[0]).toMatchObject({ sourceRef })
    expect(restored.candidates[0]?.profile).toBeUndefined()
  })

  test('Given 本地文件已形成候选 When Store 提交后重读 Then 保留本地来源且不伪造运行登记', async () => {
    const fixture = createFixture()
    const initial = createInitialCanvasMediaModuleState(target, 10)
    fixture.seed(initial)
    const next: CanvasMediaModuleState = {
      ...initial,
      revision: 1,
      config: {
        ...initial.config, revision: 1, updatedAt: 11,
        outputs: [{ key: 'video', mediaKind: 'video', role: 'primary', order: 0 }],
      },
      candidates: [{
        id: 'candidate:local-receipt', operationId: 'local-import-1', runId: 'local-receipt',
        sourceConfigRevision: 1,
        source: { kind: 'local-import', operationId: 'local-import-1', sourceSessionId: 'session-1' },
        outputs: [{ key: 'video', mediaKind: 'video', role: 'primary', order: 0,
          asset: { assetId: 'asset-video', revision: 1, hash: 'c'.repeat(64), mediaKind: 'video' } }],
        createdAt: 11,
      }],
    }

    await fixture.store.compareAndSwap(target, 0, next)
    const restored = await fixture.store.load(target)

    expect(restored.operations).toEqual([])
    expect(restored.candidates[0]).toMatchObject({
      runId: 'local-receipt', source: { kind: 'local-import', operationId: 'local-import-1', sourceSessionId: 'session-1' },
    })
  })
})
