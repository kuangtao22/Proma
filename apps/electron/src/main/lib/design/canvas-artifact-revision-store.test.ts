import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { CanvasDocument, CanvasTarget } from '@proma/shared'
import type {
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
} from '../stable-directory-native-host'
import {
  createCanvasArtifactRevisionStore,
  type CanvasArtifactRevisionStoreDependencies,
} from './canvas-artifact-revision-store'

/** 测试使用的固定 Canvas 目标。 */
const target: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-1' }

/** 内存协议中的单个版本目录。 */
interface FakeRevisionFiles {
  [fileName: string]: string
}

/** 按生产合同派生测试 revision entry ID。 */
function createTestRevisionEntryId(contentId: string, revision: number): string {
  return `revision-${createHash('sha256').update(`${contentId}\u0000${revision}`, 'utf8').digest('hex')}`
}

/** 构造测试使用的合法 prepared 修订元数据。 */
function createTestRevisionMeta(input: {
  kind: 'document' | 'webview'
  contentId: string
  revision: number
  content: string
}): string {
  /** 测试正文的 UTF-8 sha256。 */
  const contentHash = createHash('sha256').update(input.content, 'utf8').digest('hex')
  return JSON.stringify({
    schemaVersion: 1,
    kind: input.kind,
    contentId: input.contentId,
    revision: input.revision,
    parentRevision: input.revision - 1,
    contentHash,
    createdBy: { type: 'user' },
    createdAt: input.revision,
    state: 'prepared',
  })
}

/** 创建只覆盖不可变版本业务的内存协议 fixture。 */
function createFixture(options: {
  now?: number
  entryCount?: number
  unrelatedRevisionCount?: number
  failWriteFileNameOnce?: 'content.md' | 'index.html' | 'meta.json'
} = {}) {
  /** revisions 受管目录的内存投影。 */
  const revisions = new Map<string, FakeRevisionFiles>()
  /** helper 请求记录，用于验证正文先于 meta 提交且不泄漏路径。 */
  const requests: StableDirectoryNativeRequest[] = []
  /** 指定文件剩余的一次写失败，用于模拟正文后、meta 前崩溃。 */
  let remainingWriteFailure = options.failWriteFileNameOnce ? 1 : 0
  /** 旧节点 revision 0 的只读正文。 */
  const revisionZero = new Map([
    ['document:doc-1', { meta: { schemaVersion: 1 as const, kind: 'document' as const, contentId: 'doc-1', revision: 0, createdAt: 10, updatedAt: 10 }, content: '# 初稿' }],
    ['webview:web-1', { meta: { schemaVersion: 1 as const, kind: 'webview' as const, contentId: 'web-1', revision: 0, createdAt: 11, updatedAt: 11 }, content: '<!doctype html><h1>初稿</h1>' }],
  ])
  /** native helper 的窄内存实现。 */
  const runNative: CanvasArtifactRevisionStoreDependencies['runStableDirectoryNative'] = async (
    request,
    authorize,
  ): Promise<StableDirectoryNativeResult> => {
    requests.push(request)
    if (!await authorize([{ requestedPath: '/canvas', canonicalPath: '/canvas', isDirectory: true, volume: '1', fileId: '2' }])) {
      throw new Error('稳定目录授权被拒绝')
    }
    if (request.mode === 'canvas-content-list') {
      if (revisions.size > (request.maxEntries ?? 512)) throw new Error('canvas content entry limit exceeded')
      return { roots: [], entries: [...revisions.keys()].sort().map((name) => ({ rootIndex: 0, name, path: '', isDirectory: true })) }
    }
    /** 当前固定 entry 的文件集合。 */
    const files = revisions.get(request.entryId!)
    if (request.mode === 'canvas-content-read') {
      /** 请求的固定文件正文。 */
      const content = files?.[request.fileName!]
      return { roots: [], entries: [], readOutcome: content === undefined
        ? { status: 'missing' }
        : { status: 'ok', content, size: Buffer.byteLength(content), volume: '1', fileId: '3' } }
    }
    if (request.mode === 'canvas-content-write') {
      if (request.fileName === options.failWriteFileNameOnce && remainingWriteFailure > 0) {
        remainingWriteFailure -= 1
        return { roots: [], entries: [], writeOutcome: {
          commitVisible: false, durabilityUncertain: false, error: 'injected crash',
        } }
      }
      /** 原子写可见后更新内存投影。 */
      const nextFiles = files ?? {}
      nextFiles[request.fileName!] = request.content!
      revisions.set(request.entryId!, nextFiles)
      return { roots: [], entries: [], writeOutcome: { commitVisible: true, durabilityUncertain: false } }
    }
    throw new Error('测试不支持该 helper 模式')
  }
  /** 当前图文档，供 reconcile 判断 prepared 是否已被采用。 */
  let document: CanvasDocument = {
    schemaVersion: 4, projectId: target.projectId, canvasId: target.canvasId, revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [], createdAt: 1, updatedAt: 1,
  }
  /** 基于同一磁盘投影创建新的 Store 实例，模拟主进程重启。 */
  const createStore = () => createCanvasArtifactRevisionStore({
      now: () => options.now ?? 100,
      store: {
        loadWithDirectoryCapability: () => ({
          snapshot: { document, writable: true, nodeIssues: [] },
          openSingleChildDirectory: () => ({
            path: '/canvas/unused', rootPath: '/canvas', assertValid: () => undefined,
            authorizeOpenedRoots: (roots) => roots.length === 1 && roots[0]?.requestedPath === '/canvas',
          }),
        }),
      },
      nodeContentStore: {
        readTextRevisionZero: async (_target, identity) => {
          /** revision 0 按类别和 contentId 精确索引。 */
          const snapshot = revisionZero.get(`${identity.kind}:${identity.contentId}`)
          if (!snapshot) throw new Error('CANVAS_CONTENT_NOT_FOUND')
          return snapshot
        },
      },
      runStableDirectoryNative: runNative,
    })
  /** 被测不可变版本 Store。 */
  const store = createStore()
  for (let index = 0; index < (options.entryCount ?? 0); index += 1) {
    revisions.set(`unrelated-${index}`, { 'meta.json': '{}' })
  }
  for (let index = 0; index < (options.unrelatedRevisionCount ?? 0); index += 1) {
    /** 与目标身份无关、但磁盘合同完全合法的版本。 */
    const contentId = `other-${index}`
    const content = `# 无关版本 ${index}`
    const revision = 1
    revisions.set(createTestRevisionEntryId(contentId, revision), {
      'content.md': content,
      'meta.json': createTestRevisionMeta({ kind: 'document', contentId, revision, content }),
    })
  }
  return {
    store,
    revisions,
    requests,
    createStore,
    /** 替换 reconcile 使用的权威图文档。 */
    setDocument: (value: CanvasDocument) => { document = value },
    /** 返回当前权威图文档供显式 reconcile 输入。 */
    getDocument: () => document,
  }
}

describe('Canvas Artifact Revision Store', () => {
  test('Given 旧节点只有 revision 0 When 读取 Then 从 nodes 内容目录返回兼容快照', async () => {
    const fixture = createFixture()

    const snapshot = await fixture.store.read(target, { kind: 'document', contentId: 'doc-1', revision: 0 })

    expect(snapshot).toMatchObject({ record: { revision: 0, parentRevision: null, state: 'committed' }, content: '# 初稿' })
  })

  test('Given 当前采用 revision 1 且历史最大 revision 3 When 从旧版继续编辑 Then 创建 revision 4 且 parentRevision 为 1', async () => {
    const fixture = createFixture()
    for (const revision of [1, 2, 3]) {
      await fixture.store.prepareAtRevision(target, {
        kind: 'webview', contentId: 'web-1', revision, parentRevision: revision - 1,
        content: `<!doctype html><h1>版本 ${revision}</h1>`, createdBy: { type: 'user' },
      })
      await fixture.store.commit(target, { kind: 'webview', contentId: 'web-1', revision })
    }

    const prepared = await fixture.store.prepare(target, {
      kind: 'webview', contentId: 'web-1', parentRevision: 1,
      content: '<!doctype html><h1>分支版本</h1>', createdBy: { type: 'user' },
    })

    expect(prepared.record).toMatchObject({ revision: 4, parentRevision: 1, state: 'prepared' })
  })

  test('Given 相同 revision 已有不同 hash When prepare Then 拒绝覆盖', async () => {
    const fixture = createFixture()
    await fixture.store.prepareAtRevision(target, {
      kind: 'document', contentId: 'doc-1', revision: 1, parentRevision: 0,
      content: '# 第一版', createdBy: { type: 'user' },
    })

    await expect(fixture.store.prepareAtRevision(target, {
      kind: 'document', contentId: 'doc-1', revision: 1, parentRevision: 0,
      content: '# 冲突版', createdBy: { type: 'user' },
    })).rejects.toThrow('CANVAS_ARTIFACT_REVISION_CONFLICT')
  })

  test('Given 新版本 When prepare 与 commit Then 正文先写、prepared meta 后写且 commit 只替换同 hash meta', async () => {
    const fixture = createFixture()
    const prepared = await fixture.store.prepareAtRevision(target, {
      kind: 'document', contentId: 'doc-1', revision: 1, parentRevision: 0,
      content: '# 中文正文', createdBy: { type: 'agent', sessionId: 'session-1', toolCallId: 'tool-1' },
    })

    expect(prepared.record.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(fixture.requests.filter((request) => request.mode === 'canvas-content-write').map((request) => request.fileName)).toEqual(['content.md', 'meta.json'])
    expect((await fixture.store.commit(target, { kind: 'document', contentId: 'doc-1', revision: 1 })).state).toBe('committed')
    expect((await fixture.store.read(target, { kind: 'document', contentId: 'doc-1', revision: 1 })).content).toBe('# 中文正文')
    expect(JSON.stringify(fixture.requests)).not.toContain('/canvas/revisions')
  })

  test('Given prepared meta 的 hash 被替换 When commit Then 拒绝覆盖且保留 prepared', async () => {
    const fixture = createFixture()
    await fixture.store.prepareAtRevision(target, {
      kind: 'document', contentId: 'doc-1', revision: 1, parentRevision: 0,
      content: '# 原文', createdBy: { type: 'user' },
    })
    /** 测试中唯一版本 entry 的 prepared 元数据。 */
    const files = fixture.revisions.values().next().value
    if (!files) throw new Error('测试版本目录缺失')
    /** 模拟同 revision meta 被外部异常替换为另一 hash。 */
    const meta = JSON.parse(files['meta.json']!) as Record<string, unknown>
    meta.contentHash = '0'.repeat(64)
    files['meta.json'] = JSON.stringify(meta)

    await expect(fixture.store.commit(target, {
      kind: 'document', contentId: 'doc-1', revision: 1,
    })).rejects.toThrow('CANVAS_ARTIFACT_REVISION_CORRUPT')
    expect(JSON.parse(files['meta.json']!).state).toBe('prepared')
  })

  test('Given 图已引用 prepared revision When reconcile Then 仅补提交被引用版本', async () => {
    const fixture = createFixture()
    await fixture.store.prepareAtRevision(target, { kind: 'document', contentId: 'doc-1', revision: 1, parentRevision: 0, content: '# 已采用', createdBy: { type: 'user' } })
    await fixture.store.prepareAtRevision(target, { kind: 'webview', contentId: 'web-1', revision: 1, parentRevision: 0, content: '<h1>未采用</h1>', createdBy: { type: 'user' } })
    fixture.setDocument({
      schemaVersion: 4, projectId: target.projectId, canvasId: target.canvasId, revision: 1,
      viewport: { x: 0, y: 0, zoom: 1 }, edges: [], createdAt: 1, updatedAt: 2,
      nodes: [{ id: 'node-1', kind: 'document', title: '文档', position: { x: 0, y: 0 }, documentId: 'doc-1', contentRevision: 1 }],
    })

    await fixture.store.reconcile(target, fixture.getDocument())

    expect((await fixture.store.read(target, { kind: 'document', contentId: 'doc-1', revision: 1 })).record.state).toBe('committed')
    expect((await fixture.store.read(target, { kind: 'webview', contentId: 'web-1', revision: 1 })).record.state).toBe('prepared')
  })

  test('Given 列表包含其它身份元数据 When list Then 仅返回 kind 与 contentId 精确匹配记录', async () => {
    const fixture = createFixture()
    await fixture.store.prepareAtRevision(target, { kind: 'document', contentId: 'doc-1', revision: 1, parentRevision: 0, content: '# 文档', createdBy: { type: 'user' } })
    await fixture.store.prepareAtRevision(target, { kind: 'webview', contentId: 'web-1', revision: 1, parentRevision: 0, content: '<h1>网页</h1>', createdBy: { type: 'user' } })

    expect((await fixture.store.list(target, { kind: 'document', contentId: 'doc-1' })).map((record) => record.contentId)).toEqual(['doc-1'])
  })

  test.each([
    ['meta 解析损坏', { 'meta.json': '{bad' }],
    ['meta 身份与 entryId 不一致', {
      'meta.json': createTestRevisionMeta({
        kind: 'document', contentId: 'other-doc', revision: 1, content: '# 其它正文',
      }),
      'content.md': '# 其它正文',
    }],
  ] as const)('Given 合法 revision entry 的%s When list Then fail closed', async (_label, files) => {
    const fixture = createFixture()
    /** entryId 固定绑定 doc-1/revision 1，测试元数据不能改变该目录身份。 */
    fixture.revisions.set(createTestRevisionEntryId('doc-1', 1), { ...files })

    await expect(fixture.store.list(target, { kind: 'document', contentId: 'doc-1' }))
      .rejects.toThrow('CANVAS_ARTIFACT_REVISION_CORRUPT')
  })

  test('Given 正文已写但 prepared meta 前崩溃 When 重建 Store 并用相同输入 Then 补写 meta 收敛', async () => {
    const fixture = createFixture({ failWriteFileNameOnce: 'meta.json' })
    /** 同一业务输入在重启后必须恢复同一 revision。 */
    const input = { kind: 'document' as const, contentId: 'doc-1', parentRevision: 0, content: '# 新版', createdBy: { type: 'user' as const } }

    await expect(fixture.store.prepare(target, input)).rejects.toThrow('CANVAS_ARTIFACT_REVISION_WRITE_FAILED')
    expect(await fixture.createStore().list(target, { kind: 'document', contentId: 'doc-1' })).toEqual([])
    const recovered = await fixture.createStore().prepare(target, input)

    expect(recovered).toMatchObject({ record: { revision: 1, state: 'prepared' }, content: '# 新版' })
  })

  test('Given 正文已写但 meta 前崩溃 When 重建 Store 并用不同正文 Then 拒绝覆盖 partial', async () => {
    const fixture = createFixture({ failWriteFileNameOnce: 'meta.json' })
    await expect(fixture.store.prepare(target, {
      kind: 'document', contentId: 'doc-1', parentRevision: 0,
      content: '# 原文', createdBy: { type: 'user' },
    })).rejects.toThrow('CANVAS_ARTIFACT_REVISION_WRITE_FAILED')

    await expect(fixture.createStore().prepare(target, {
      kind: 'document', contentId: 'doc-1', parentRevision: 0,
      content: '# 不同正文', createdBy: { type: 'user' },
    })).rejects.toThrow('CANVAS_ARTIFACT_REVISION_CONFLICT')
  })

  test('Given 首次缓存扫描包含大量无关 revision When 连续 prepare Then 第二次 helper 调用保持常数', async () => {
    const fixture = createFixture({ unrelatedRevisionCount: 100 })
    await fixture.store.prepare(target, {
      kind: 'document', contentId: 'doc-1', parentRevision: 0,
      content: '# 第一版', createdBy: { type: 'user' },
    })
    /** 首次扫描完成后的 helper 请求基线。 */
    const firstRequestCount = fixture.requests.length
    await fixture.store.prepare(target, {
      kind: 'webview', contentId: 'web-1', parentRevision: 0,
      content: '<h1>第一版</h1>', createdBy: { type: 'user' },
    })
    /** 第二个无关身份不应重新扫描 101 个 revisions meta。 */
    const secondRequestCount = fixture.requests.length - firstRequestCount

    expect(secondRequestCount).toBeLessThanOrEqual(5)
    expect(fixture.requests.filter((request) => request.mode === 'canvas-content-list')).toHaveLength(1)
  })

  test('Given revisions 超过 512 项 When list Then 原样传播 helper 上限错误', async () => {
    const fixture = createFixture({ entryCount: 513 })

    await expect(fixture.store.list(target, { kind: 'document', contentId: 'doc-1' }))
      .rejects.toThrow('canvas content entry limit exceeded')
  })
})
