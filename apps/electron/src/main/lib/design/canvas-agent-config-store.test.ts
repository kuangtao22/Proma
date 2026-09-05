import { describe, expect, test } from 'bun:test'
import type { CanvasDocument, CanvasAgentTarget, SkillMeta } from '@proma/shared'
import type {
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
  StableDirectoryNativeWriteOutcome,
} from '../stable-directory-native-host'
import type { CanvasDocumentStore } from './canvas-document-store'
import {
  createCanvasOperationSerializer,
  type CanvasOperationSerializer,
} from './canvas-document-ipc'
import {
  createCanvasAgentConfigStore,
  type CanvasAgentConfig,
  type CanvasAgentConfigStoreDependencies,
  type UpdateCanvasAgentConfigInput,
} from './canvas-agent-config-store'

/** 测试使用的固定 Canvas Agent 三重身份。 */
const target: CanvasAgentTarget = {
  projectId: 'project-1',
  canvasId: 'canvas-1',
  nodeId: 'agent-1',
}

/** 构造包含唯一 Agent 节点的权威图文档。 */
function createDocument(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return {
    schemaVersion: 4,
    projectId: target.projectId,
    canvasId: target.canvasId,
    revision: 7,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: target.nodeId,
      kind: 'agent',
      title: '研究员',
      position: { x: 0, y: 0 },
      agentSessionId: 'session-1',
    }],
    edges: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/** 构造测试使用的已持久化配置。 */
function createConfig(overrides: Partial<CanvasAgentConfig> = {}): CanvasAgentConfig {
  return {
    schemaVersion: 1,
    ...target,
    revision: 2,
    instruction: '负责事实核查',
    skillNames: ['research'],
    channelId: 'channel-1',
    modelId: 'model-1',
    updatedAt: 10,
    ...overrides,
  }
}

/** 创建只实现 Agent 配置相对协议的内存 fixture。 */
function createFixture(options: {
  content?: string | null
  document?: CanvasDocument
  skills?: SkillMeta[]
  revokeOnAuthorize?: boolean
  revokeAfterWrite?: boolean
  writeOutcome?: StableDirectoryNativeWriteOutcome
  rereadContent?: string
  postWriteReadError?: Error
  pauseFirstWrite?: boolean
  serializer?: CanvasOperationSerializer
} = {}) {
  /** 当前受管配置正文；null 表示文件缺失。 */
  let content = options.content ?? null
  /** native helper 收到的全部结构化请求。 */
  const requests: StableDirectoryNativeRequest[] = []
  /** 写入次数，用于证明所有冲突在写前失败。 */
  let writeCount = 0
  /** 每个公开操作取得权威 Canvas LOAD 的次数。 */
  let loadCount = 0
  /** native 固定文件读取次数，用于核对 uncertain 后确实复读。 */
  let readCount = 0
  /** capability 当前是否仍有效。 */
  let valid = true
  /** 模型校验调用，证明仅在保存显式选择时执行。 */
  const modelChecks: Array<{ channelId: string; modelId: string | null }> = []
  /** 渠道校验调用，包含选择渠道默认模型的场景。 */
  const channelChecks: string[] = []
  /** Store 与其它 Canvas 写路径共享的真实键控串行器。 */
  const serializer = options.serializer ?? createCanvasOperationSerializer()
  /** 第一次 write 到达 native 边界时的通知。 */
  let notifyFirstWriteStarted: (() => void) | undefined
  const firstWriteStarted = new Promise<void>((resolve) => {
    notifyFirstWriteStarted = resolve
  })
  /** 测试控制第一次 write 何时继续。 */
  let releaseFirstWrite: (() => void) | undefined
  const firstWriteRelease = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve
  })

  /** 测试 native 协议只接受固定目录、entry 和文件名。 */
  const runNative: CanvasAgentConfigStoreDependencies['runStableDirectoryNative'] = async (
    request,
    authorize,
  ): Promise<StableDirectoryNativeResult> => {
    requests.push(request)
    const openedRoots = [{
      requestedPath: '/canvas',
      canonicalPath: '/canvas',
      isDirectory: true,
      volume: '1',
      fileId: '2',
    }]
    if (options.revokeOnAuthorize) valid = false
    if (!authorize(openedRoots)) throw new Error('NATIVE_AUTHORIZATION_REVOKED')
    if (request.mode === 'canvas-content-read') {
      readCount += 1
      if (writeCount > 0 && options.postWriteReadError) throw options.postWriteReadError
      const readContent = writeCount > 0 && options.rereadContent !== undefined
        ? options.rereadContent
        : content
      return {
        roots: openedRoots,
        entries: [],
        readOutcome: readContent === null
          ? { status: 'missing' }
          : { status: 'ok', content: readContent, size: Buffer.byteLength(readContent), volume: '1', fileId: '3' },
      }
    }
    if (request.mode !== 'canvas-content-write' || typeof request.content !== 'string') {
      throw new Error('UNEXPECTED_NATIVE_REQUEST')
    }
    writeCount += 1
    if (options.pauseFirstWrite && writeCount === 1) {
      notifyFirstWriteStarted?.()
      await firstWriteRelease
    }
    content = request.content
    if (options.revokeAfterWrite) valid = false
    return {
      roots: openedRoots,
      entries: [],
      writeOutcome: options.writeOutcome ?? { commitVisible: true, durabilityUncertain: false },
    }
  }

  /** 测试 Store 只暴露同一次 LOAD 的文档和 agent-configs capability。 */
  /** 当前权威图，测试可模拟其它串行写在 config update 前推进。 */
  let currentDocument = options.document ?? createDocument()
  const documentStore: Pick<CanvasDocumentStore, 'loadWithDirectoryCapability'> = {
    loadWithDirectoryCapability: () => {
      loadCount += 1
      return {
        snapshot: {
          document: currentDocument,
          writable: true,
          nodeIssues: [],
        },
        openSingleChildDirectory: (name) => {
          if (name !== 'agent-configs') throw new Error(`UNEXPECTED_CHILD: ${name}`)
          return {
            path: '/canvas/agent-configs',
            rootPath: '/canvas',
            assertValid: () => {
              if (!valid) throw new Error('CAPABILITY_REVOKED')
            },
            authorizeOpenedRoots: () => valid,
          }
        },
      }
    },
  }

  /** 注入真实 serializer，验证 Store 与其它 Canvas 写路径共享同一临界区。 */
  const dependencies: CanvasAgentConfigStoreDependencies = {
    store: documentStore,
    runStableDirectoryNative: runNative,
    getWorkspaceSkills: () => options.skills ?? [{ slug: 'research', name: 'research', enabled: true }],
    assertChannelAvailable: (channelId) => {
      channelChecks.push(channelId)
      if (channelId === 'disabled-channel') throw new Error('MODEL_CHANNEL_DISABLED')
    },
    assertModelAvailable: (channelId, modelId) => {
      modelChecks.push({ channelId, modelId })
      if (modelId === 'missing-model') throw new Error('MODEL_DISABLED')
    },
    now: () => 100,
    runExclusive: <T>(runTarget: CanvasAgentTarget, effect: () => Promise<T>) => (
      serializer.run(runTarget, effect)
    ),
  }
  const store = createCanvasAgentConfigStore(dependencies)

  return {
    store,
    requests,
    modelChecks,
    channelChecks,
    serializer,
    firstWriteStarted,
    releaseFirstWrite: () => releaseFirstWrite?.(),
    setDocument: (document: CanvasDocument) => { currentDocument = document },
    get writeCount() { return writeCount },
    get loadCount() { return loadCount },
    get readCount() { return readCount },
    get content() { return content },
  }
}

/** 构造 revision 双基线完整的局部更新。 */
function createUpdate(
  patch: UpdateCanvasAgentConfigInput['patch'],
  overrides: Partial<Omit<UpdateCanvasAgentConfigInput, 'patch'>> = {},
): UpdateCanvasAgentConfigInput {
  return {
    ...target,
    expectedGraphRevision: 7,
    expectedConfigRevision: 2,
    patch,
    ...overrides,
  }
}

describe('CanvasAgentConfigStore', () => {
  test('Given 配置文件缺失 When 加载 Then 返回 revision 0 的继承模型默认值且不写磁盘', async () => {
    const fixture = createFixture()

    await expect(fixture.store.load(target)).resolves.toEqual({
      schemaVersion: 1,
      ...target,
      revision: 0,
      instruction: '',
      skillNames: [],
      channelId: null,
      modelId: null,
      updatedAt: 0,
    })
    expect(fixture.writeCount).toBe(0)
    expect(fixture.loadCount).toBe(1)
    expect(fixture.requests).toHaveLength(1)
  })

  test('Given 配置包含未知字段或三重身份漂移 When 加载 Then exact-key 解析 fail closed', async () => {
    const unknownKey = createFixture({ content: JSON.stringify({ ...createConfig(), extra: true }) })
    const wrongProject = createFixture({ content: JSON.stringify(createConfig({ projectId: 'project-2' })) })

    await expect(unknownKey.store.load(target)).rejects.toThrow('CANVAS_AGENT_CONFIG_CORRUPT')
    await expect(wrongProject.store.load(target)).rejects.toThrow('CANVAS_AGENT_CONFIG_IDENTITY_CONFLICT')
  })

  test('Given 配置字段语义损坏 When 加载 Then 统一分类为 corrupt 并保留字段错误 cause', async () => {
    const fixture = createFixture({
      content: JSON.stringify(createConfig({ instruction: '中'.repeat(2_731) })),
    })

    const error = await fixture.store.load(target).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) return
    expect(error.message).toContain('CANVAS_AGENT_CONFIG_CORRUPT')
    expect(error.cause).toBeInstanceOf(Error)
    expect((error.cause as Error).message).toContain('CANVAS_AGENT_CONFIG_INSTRUCTION_INVALID')
  })

  test('Given 指令超过 8 KiB、Skill 超量重复或 ID 越界 When 更新 Then 全部在写前拒绝', async () => {
    const tooLong = createFixture({ content: JSON.stringify(createConfig()) })
    const tooMany = createFixture({ content: JSON.stringify(createConfig()) })
    const duplicate = createFixture({ content: JSON.stringify(createConfig()) })
    const invalidId = createFixture({ content: JSON.stringify(createConfig()) })

    await expect(tooLong.store.update(createUpdate({ instruction: '中'.repeat(2_731) })))
      .rejects.toThrow('CANVAS_AGENT_CONFIG_INSTRUCTION_INVALID')
    await expect(tooMany.store.update(createUpdate({ skillNames: Array.from({ length: 17 }, (_, index) => `skill-${index}`) })))
      .rejects.toThrow('CANVAS_AGENT_CONFIG_SKILLS_INVALID')
    await expect(duplicate.store.update(createUpdate({ skillNames: ['research', 'research'] })))
      .rejects.toThrow('CANVAS_AGENT_CONFIG_SKILLS_INVALID')
    await expect(invalidId.store.load({ ...target, nodeId: '../agent-1' }))
      .rejects.toThrow('CANVAS_AGENT_CONFIG_TARGET_INVALID')
    expect(tooLong.writeCount + tooMany.writeCount + duplicate.writeCount + invalidId.writeCount).toBe(0)
  })

  test('Given 只更新职责 When 保存 Then 保留未传 Skills 和模型并推进 revision', async () => {
    const fixture = createFixture({ content: JSON.stringify(createConfig()) })

    const updated = await fixture.store.update(createUpdate({ instruction: '负责证据审阅' }))

    expect(updated).toEqual(createConfig({ revision: 3, instruction: '负责证据审阅', updatedAt: 100 }))
    expect(JSON.parse(fixture.content ?? '')).toEqual(updated)
    expect(fixture.writeCount).toBe(1)
    expect(fixture.loadCount).toBe(1)
  })

  test('Given patch 清空渠道 When 保存 Then 强制同步清空模型', async () => {
    const fixture = createFixture({ content: JSON.stringify(createConfig()) })

    const updated = await fixture.store.update(createUpdate({ channelId: null }))

    expect(updated.channelId).toBeNull()
    expect(updated.modelId).toBeNull()
    expect(fixture.modelChecks).toEqual([])
    expect(fixture.channelChecks).toEqual([])
  })

  test('Given 切换渠道但未显式选择模型 When 保存 Then 拒绝隐式保留旧模型', async () => {
    const fixture = createFixture({ content: JSON.stringify(createConfig()) })

    await expect(fixture.store.update(createUpdate({ channelId: 'channel-2' })))
      .rejects.toThrow('CANVAS_AGENT_CONFIG_MODEL_PATCH_REQUIRED')
    expect(fixture.writeCount).toBe(0)
  })

  test('Given 切换渠道并显式选择有效模型或默认模型 When 保存 Then 接受完整新路由', async () => {
    const explicit = createFixture({ content: JSON.stringify(createConfig()) })
    const channelDefault = createFixture({ content: JSON.stringify(createConfig()) })

    await expect(explicit.store.update(createUpdate({ channelId: 'channel-2', modelId: 'model-2' })))
      .resolves.toMatchObject({ channelId: 'channel-2', modelId: 'model-2' })
    await expect(channelDefault.store.update(createUpdate({ channelId: 'channel-2', modelId: null })))
      .resolves.toMatchObject({ channelId: 'channel-2', modelId: null })
    expect(explicit.modelChecks).toEqual([{ channelId: 'channel-2', modelId: 'model-2' }])
    expect(channelDefault.channelChecks).toEqual(['channel-2'])
  })

  test('Given graph 或 config revision 基线过期 When 更新 Then 均在 native 写入前冲突', async () => {
    const graphConflict = createFixture({ content: JSON.stringify(createConfig()) })
    const configConflict = createFixture({ content: JSON.stringify(createConfig()) })

    await expect(graphConflict.store.update(createUpdate({ instruction: 'new' }, { expectedGraphRevision: 6 })))
      .rejects.toThrow('CANVAS_AGENT_GRAPH_REVISION_CONFLICT')
    await expect(configConflict.store.update(createUpdate({ instruction: 'new' }, { expectedConfigRevision: 1 })))
      .rejects.toThrow('CANVAS_AGENT_CONFIG_REVISION_CONFLICT')
    expect(graphConflict.writeCount + configConflict.writeCount).toBe(0)
  })

  test('Given 当前 config revision 已达安全整数上限 When 更新 Then 溢出前拒绝且不写', async () => {
    const fixture = createFixture({
      content: JSON.stringify(createConfig({ revision: Number.MAX_SAFE_INTEGER })),
    })

    await expect(fixture.store.update(createUpdate(
      { instruction: 'overflow' },
      { expectedConfigRevision: Number.MAX_SAFE_INTEGER },
    ))).rejects.toThrow('CANVAS_AGENT_CONFIG_REVISION_OVERFLOW')
    expect(fixture.writeCount).toBe(0)
  })

  test('Given 两个更新共享同一 config baseline When 并发提交 Then 只有一个写入成功', async () => {
    const fixture = createFixture({
      content: JSON.stringify(createConfig()),
      pauseFirstWrite: true,
    })
    const first = fixture.store.update(createUpdate({ instruction: 'first' }))
    await fixture.firstWriteStarted
    const second = fixture.store.update(createUpdate({ instruction: 'second' }))

    fixture.releaseFirstWrite()
    const results = await Promise.allSettled([first, second])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') {
      expect(String(rejected.reason)).toContain('CANVAS_AGENT_CONFIG_REVISION_CONFLICT')
    }
    expect(fixture.writeCount).toBe(1)
  })

  test('Given 同 Canvas 图写已持锁 When 节点在配置更新前被删除 Then 更新排队后拒绝且不写', async () => {
    const fixture = createFixture({ content: JSON.stringify(createConfig()) })
    /** 控制在 update 请求到达后才提交图 revision 与节点删除。 */
    let releaseGraphMutation: (() => void) | undefined
    const graphMutationRelease = new Promise<void>((resolve) => {
      releaseGraphMutation = resolve
    })
    let notifyGraphMutationStarted: (() => void) | undefined
    const graphMutationStarted = new Promise<void>((resolve) => {
      notifyGraphMutationStarted = resolve
    })
    const graphMutation = fixture.serializer.run(target, async () => {
      notifyGraphMutationStarted?.()
      await graphMutationRelease
      fixture.setDocument(createDocument({ revision: 8, nodes: [] }))
    })
    await graphMutationStarted

    const update = fixture.store.update(createUpdate({ instruction: 'stale write' }))
    await Promise.resolve()
    releaseGraphMutation?.()
    await graphMutation

    await expect(update).rejects.toThrow('CANVAS_AGENT_TARGET_INVALID')
    expect(fixture.writeCount).toBe(0)
  })

  test('Given 配置更新等待同 Canvas 串行器期间关联被撤销 When 获得写临界区 Then 授权复核先于 native 读写并拒绝更新', async () => {
    const fixture = createFixture({ content: JSON.stringify(createConfig()) })
    /** 模拟其它 Canvas 写先占用串行器，让配置更新在旧授权检查之后排队。 */
    let releaseCanvasWrite: (() => void) | undefined
    const canvasWriteRelease = new Promise<void>((resolve) => {
      releaseCanvasWrite = resolve
    })
    let notifyCanvasWriteStarted: (() => void) | undefined
    const canvasWriteStarted = new Promise<void>((resolve) => {
      notifyCanvasWriteStarted = resolve
    })
    const canvasWrite = fixture.serializer.run(target, async () => {
      notifyCanvasWriteStarted?.()
      await canvasWriteRelease
    })
    await canvasWriteStarted

    /** 第二参数模拟 Host 捕获的可信 binding 复核。 */
    let linked = true
    const update = fixture.store.update(createUpdate({ instruction: 'stale write' }), () => {
      if (!linked) throw new Error('CANVAS_ACCESS_DENIED')
    })
    await Promise.resolve()
    linked = false
    releaseCanvasWrite?.()
    await canvasWrite

    await expect(update).rejects.toThrow('CANVAS_ACCESS_DENIED')
    expect(fixture.requests).toHaveLength(0)
    expect(fixture.writeCount).toBe(0)
  })

  test('Given Skill 未安装或停用且模型选择无效 When 保存 Then 全部 fail closed', async () => {
    const missingSkill = createFixture({ content: JSON.stringify(createConfig()), skills: [] })
    const disabledSkill = createFixture({
      content: JSON.stringify(createConfig()),
      skills: [{ slug: 'research', name: 'research', enabled: false }],
    })
    const invalidModel = createFixture({ content: JSON.stringify(createConfig()) })

    await expect(missingSkill.store.update(createUpdate({ skillNames: ['missing'] })))
      .rejects.toThrow('CANVAS_AGENT_CONFIG_SKILL_UNAVAILABLE')
    await expect(disabledSkill.store.update(createUpdate({ skillNames: ['research'] })))
      .rejects.toThrow('CANVAS_AGENT_CONFIG_SKILL_UNAVAILABLE')
    await expect(invalidModel.store.update(createUpdate({ modelId: 'missing-model' })))
      .rejects.toThrow('MODEL_DISABLED')
    expect(missingSkill.writeCount + disabledSkill.writeCount + invalidModel.writeCount).toBe(0)
  })

  test('Given 图节点已不是匹配 Agent When 读写 Then 不触碰配置文件', async () => {
    const document = createDocument({ nodes: [] })
    const fixture = createFixture({ content: JSON.stringify(createConfig()), document })

    await expect(fixture.store.load(target)).rejects.toThrow('CANVAS_AGENT_TARGET_INVALID')
    await expect(fixture.store.update(createUpdate({ instruction: 'new' }))).rejects.toThrow('CANVAS_AGENT_TARGET_INVALID')
    expect(fixture.requests).toHaveLength(0)
  })

  test('Given native 授权撤销或 JSON 损坏 When 加载 Then fail closed', async () => {
    const revoked = createFixture({ content: JSON.stringify(createConfig()), revokeOnAuthorize: true })
    const corrupt = createFixture({ content: '{broken' })

    await expect(revoked.store.load(target)).rejects.toThrow()
    await expect(corrupt.store.load(target)).rejects.toThrow('CANVAS_AGENT_CONFIG_CORRUPT')
  })

  test('Given 写提交可见但耐久不确定且复读一致 When 更新 Then 复读一次后保留 durability 阶段', async () => {
    const fixture = createFixture({
      content: JSON.stringify(createConfig()),
      writeOutcome: { commitVisible: true, durabilityUncertain: true, error: 'directory flush failed' },
    })

    await expect(fixture.store.update(createUpdate({ instruction: 'new' })))
      .rejects.toThrow('CANVAS_AGENT_CONFIG_DURABILITY_UNCERTAIN')
    expect(fixture.readCount).toBe(2)
    expect(fixture.writeCount).toBe(1)
  })

  test('Given 写提交耐久不确定且复读不一致 When 更新 Then 报 commit-unconfirmed 且不重写', async () => {
    const fixture = createFixture({
      content: JSON.stringify(createConfig()),
      writeOutcome: { commitVisible: true, durabilityUncertain: true, error: 'directory flush failed' },
      rereadContent: JSON.stringify(createConfig({ revision: 99 })),
    })

    await expect(fixture.store.update(createUpdate({ instruction: 'new' })))
      .rejects.toThrow('CANVAS_AGENT_CONFIG_COMMIT_UNCONFIRMED')
    expect(fixture.writeCount).toBe(1)
  })

  test('Given uncertain 写返回后 capability 被撤销 When 更新 Then 保留 commit-unconfirmed 阶段且不重写', async () => {
    const fixture = createFixture({
      content: JSON.stringify(createConfig()),
      revokeAfterWrite: true,
      writeOutcome: { commitVisible: true, durabilityUncertain: true, error: 'directory flush failed' },
    })

    await expect(fixture.store.update(createUpdate({ instruction: 'new' })))
      .rejects.toThrow('CANVAS_AGENT_CONFIG_COMMIT_UNCONFIRMED')
    expect(fixture.writeCount).toBe(1)
  })

  test('Given durable commit 后复读 helper 抛错 When 更新 Then 统一报 commit-unconfirmed 并保留 cause', async () => {
    const rereadError = new Error('HELPER_START_FAILED')
    const fixture = createFixture({
      content: JSON.stringify(createConfig()),
      postWriteReadError: rereadError,
    })

    const error = await fixture.store.update(createUpdate({ instruction: 'new' }))
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) return
    expect(error.message).toContain('CANVAS_AGENT_CONFIG_COMMIT_UNCONFIRMED')
    expect(error.cause).toBe(rereadError)
    expect(fixture.writeCount).toBe(1)
  })

  test('Given durable commit 后 capability 被撤销 When 更新 Then 统一报 commit-unconfirmed 且不重写', async () => {
    const fixture = createFixture({
      content: JSON.stringify(createConfig()),
      revokeAfterWrite: true,
    })

    const error = await fixture.store.update(createUpdate({ instruction: 'new' }))
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) return
    expect(error.message).toContain('CANVAS_AGENT_CONFIG_COMMIT_UNCONFIRMED')
    expect(error.cause).toBeInstanceOf(Error)
    expect((error.cause as Error).message).toContain('CAPABILITY_REVOKED')
    expect(fixture.writeCount).toBe(1)
  })
})
