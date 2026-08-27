import { beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  CanvasNodeContentMeta,
  CanvasTarget,
  CanvasTrashEntry,
} from '@proma/shared'
import type { LegacyCanvasContentSeed } from './canvas-document-store'
import type {
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
} from '../stable-directory-native-host'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import {
  createCanvasNodeContentStore,
  type CanvasNodeContentStoreDependencies,
} from './canvas-node-content-store'

/** 测试使用的固定 Canvas 目标。 */
const target: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-1' }
/** 当前平台是否支持真实 stable-directory helper 集成测试。 */
const nativeHelperPlatformSupported = process.platform === 'darwin' || process.platform === 'win32'
/** Electron 应用根目录。 */
const electronAppRoot = resolve(import.meta.dir, '../../../..')
/** 当前平台真实 helper 路径。 */
const nativeHelperPath = resolve(
  electronAppRoot,
  `resources/stable-directory/stable-directory-helper${process.platform === 'win32' ? '.exe' : ''}`,
)

/** 文件级只编译一次真实 helper，避免每个集成用例重复冷编译。 */
beforeAll(() => {
  if (!nativeHelperPlatformSupported) return
  execFileSync(process.execPath, [resolve(electronAppRoot, 'scripts/build-stable-directory-native.ts')], {
    stdio: 'pipe',
  })
}, 30_000)

/** 测试使用的固定回收条目。 */
const trashEntry: CanvasTrashEntry = {
  schemaVersion: 1,
  trashId: 'trash-1',
  nodeId: 'node-1',
  kind: 'document',
  contentId: 'content-1',
  title: '首页说明',
  position: { x: 10, y: 20 },
  deletedRevision: 3,
  deletedAt: 200,
}

/** 内存协议中的单个内容目录。 */
interface FakeEntryFiles {
  [fileName: string]: string
}

/** 构造只实现 Task 2A 相对协议的内存 fake。 */
function createFixture(options: {
  now?: number
  revokeOnAuthorize?: boolean
  revokeOnAssertCall?: number
  entryReadError?: string
  outcomeFor?: (request: StableDirectoryNativeRequest) => StableDirectoryNativeResult['writeOutcome']
  moveOutcome?: StableDirectoryNativeResult['moveOutcome']
} = {}) {
  /** nodes 与 trash 两个受限子目录。 */
  const scopes: Record<'nodes' | 'trash', Map<string, FakeEntryFiles>> = {
    nodes: new Map(),
    trash: new Map(),
  }
  /** Store 发出的全部结构化请求。 */
  const requests: StableDirectoryNativeRequest[] = []
  /** capability 当前是否仍有效。 */
  let valid = true
  /** capability assertValid 调用次数，用于精确模拟列表后的撤权竞态。 */
  let assertCallCount = 0
  /** 单次 LOAD 次数，用于证明每个操作只取一次 capability。 */
  let loadCount = 0
  /** 协议 fake 只接受受限相对字段，不接受任意路径。 */
  const runNative: CanvasNodeContentStoreDependencies['runStableDirectoryNative'] = async (request, authorize) => {
    requests.push(request)
    const authorized = await authorize([{
      requestedPath: '/canvas',
      canonicalPath: '/canvas',
      isDirectory: true,
      volume: '1',
      fileId: '2',
    }])
    if (!authorized) throw new Error('稳定目录授权被拒绝')
    /** 当前受限子目录。 */
    const childName = request.childName as 'nodes' | 'trash'
    /** 当前受限 entry。 */
    const entryFiles = request.entryId ? scopes[childName].get(request.entryId) : undefined
    if (request.mode === 'canvas-content-read') {
      if (request.fileName === 'entry.json' && options.entryReadError) {
        throw new Error(options.entryReadError)
      }
      const content = entryFiles?.[request.fileName!]
      return {
        roots: [], entries: [],
        readOutcome: content === undefined
          ? { status: 'missing' }
          : { status: 'ok', content, size: content.length, volume: '1', fileId: '3' },
      }
    }
    if (request.mode === 'canvas-content-write') {
      const outcome = options.outcomeFor?.(request) ?? { commitVisible: true, durabilityUncertain: false }
      if (outcome?.commitVisible) {
        /** 写入时幂等创建 entry。 */
        const files = entryFiles ?? {}
        files[request.fileName!] = request.content!
        scopes[childName].set(request.entryId!, files)
      }
      return { roots: [], entries: [], writeOutcome: outcome }
    }
    if (request.mode === 'canvas-content-list') {
      return {
        roots: [],
        entries: [...scopes[childName].keys()].sort().slice(0, request.maxEntries).map((name) => ({
          rootIndex: 0, name, path: '', isDirectory: true,
        })),
      }
    }
    /** move 不覆盖目标，模拟 native rename 合同。 */
    const source = scopes[childName].get(request.entryId!)
    const destination = scopes[request.destinationChildName as 'nodes' | 'trash']
    if (!source || destination.has(request.destinationEntryId!)) {
      return {
        roots: [], entries: [],
        moveOutcome: {
          commitVisible: false,
          durabilityUncertain: false,
          error: source ? 'canvas content move destination exists' : 'canvas content move source missing',
        },
      }
    }
    destination.set(request.destinationEntryId!, source)
    scopes[childName].delete(request.entryId!)
    return {
      roots: [],
      entries: [],
      moveOutcome: options.moveOutcome ?? { commitVisible: true, durabilityUncertain: false },
    }
  }
  /** 被测 Store，只能从同一次 LOAD 派生目录 capability。 */
  const store = createCanvasNodeContentStore({
    now: () => options.now ?? 100,
    store: {
      loadWithDirectoryCapability: () => {
        loadCount += 1
        return {
          snapshot: { document: {} as never, writable: true, nodeIssues: [] },
          openSingleChildDirectory: () => ({
            path: '/canvas/unused',
            rootPath: '/canvas',
            assertValid: () => {
              assertCallCount += 1
              if (assertCallCount === options.revokeOnAssertCall) valid = false
              if (!valid) throw new Error('CANVAS_DIRECTORY_SCOPE_CHANGED')
            },
            authorizeOpenedRoots: () => {
              if (options.revokeOnAuthorize) valid = false
              return valid
            },
          }),
        }
      },
    },
    runStableDirectoryNative: runNative,
  })
  return {
    store,
    scopes,
    requests,
    get loadCount() { return loadCount },
    revoke: () => { valid = false },
  }
}

/** 读取并解析测试 fake 中的 JSON 文件。 */
function readJson<T>(files: FakeEntryFiles, fileName: string): T {
  return JSON.parse(files[fileName]!) as T
}

describe('Canvas 节点内容 Store', () => {
  test.each([
    ['image', ['config.json', 'meta.json']],
    ['document', ['content.md', 'meta.json']],
    ['webview', ['index.html', 'meta.json']],
  ] as const)('Given %s 节点 When 准备空内容 Then 最后提交严格 meta 且可断言', async (kind, expectedFiles) => {
    const fixture = createFixture()
    await fixture.store.prepareEmptyContent(target, { kind, contentId: 'content-1' })

    const files = fixture.scopes.nodes.get('content-1')!
    /** 准备操作的最后一个 helper 请求必须提交 meta。 */
    const finalPrepareRequest = fixture.requests.at(-1)
    expect(Object.keys(files).sort()).toEqual([...expectedFiles].sort())
    expect(await fixture.store.assertContent(target, { kind, contentId: 'content-1' })).toEqual({
      schemaVersion: 1,
      kind,
      contentId: 'content-1',
      revision: 0,
      createdAt: 100,
      updatedAt: 100,
    } satisfies CanvasNodeContentMeta)
    expect(finalPrepareRequest?.fileName).toBe('meta.json')
    expect(fixture.loadCount).toBe(2)
  })

  test.each([
    [{ kind: 'image', contentId: 'image-1', adoptedAssetId: 'asset-1' }, 'config.json', 'adoptedAssetId', 'asset-1'],
    [{ kind: 'document', contentId: 'document-1' }, 'content.md', null, null],
    [{ kind: 'webview', contentId: 'webview-1', legacySourceUrl: 'https://old.example/page' }, 'meta.json', 'legacySourceUrl', 'https://old.example/page'],
  ] as const)('Given legacy %s When 物化 Then 保留迁移种子且正文离线', async (seed, fileName, field, expected) => {
    const fixture = createFixture()
    await fixture.store.prepareMigratedContent(target, seed as LegacyCanvasContentSeed)
    const files = fixture.scopes.nodes.get(seed.contentId)!
    if (field) expect(readJson<Record<string, unknown>>(files, fileName)[field]).toBe(expected)
    if (seed.kind === 'document') expect(files['content.md']).toBe('')
    if (seed.kind === 'webview') {
      expect(files['index.html']).not.toContain('<script')
      expect(files['index.html']).not.toContain('https://')
    }
  })

  test('Given 相同请求与部分写入 When 重放 Then 收敛；kind 或 seed 不同则拒绝覆盖', async () => {
    const fixture = createFixture()
    const seed: LegacyCanvasContentSeed = { kind: 'image', contentId: 'image-1', adoptedAssetId: 'asset-1' }
    await fixture.store.prepareMigratedContent(target, seed)
    await fixture.store.prepareMigratedContent(target, seed)
    await expect(fixture.store.prepareEmptyContent(target, { kind: 'document', contentId: 'image-1' }))
      .rejects.toThrow('CANVAS_CONTENT_IDENTITY_CONFLICT')
    await expect(fixture.store.prepareMigratedContent(target, { ...seed, adoptedAssetId: 'asset-2' }))
      .rejects.toThrow('CANVAS_CONTENT_IDENTITY_CONFLICT')
    await expect(fixture.store.prepareMigratedContent(target, {
      ...seed,
      legacySourceUrl: 'https://unexpected.example',
    })).rejects.toThrow('CANVAS_CONTENT_IDENTITY_CONFLICT')

    const partial = createFixture({ now: 999 })
    partial.scopes.nodes.set('image-2', {
      'config.json': JSON.stringify({
        schemaVersion: 1, kind: 'image', contentId: 'image-2', revision: 0,
        createdAt: 100, updatedAt: 100, prompt: '', selectedModelProfileId: null, adoptedAssetId: null,
      }),
    })
    await partial.store.prepareEmptyContent(target, { kind: 'image', contentId: 'image-2' })
    expect(readJson<CanvasNodeContentMeta>(partial.scopes.nodes.get('image-2')!, 'meta.json').createdAt).toBe(100)
  })

  test.each([
    [{ revision: 1 }, 'revision 非 0'],
    [{ updatedAt: 101 }, '初始时间不一致'],
  ] as const)('Given 图片部分 config 的%s When 重放 Then 拒绝提交 meta', async (override) => {
    const fixture = createFixture({ now: 999 })
    fixture.scopes.nodes.set('image-partial', {
      'config.json': JSON.stringify({
        schemaVersion: 1,
        kind: 'image',
        contentId: 'image-partial',
        revision: 0,
        createdAt: 100,
        updatedAt: 100,
        prompt: '',
        selectedModelProfileId: null,
        adoptedAssetId: null,
        ...override,
      }),
    })

    await expect(fixture.store.prepareEmptyContent(target, {
      kind: 'image',
      contentId: 'image-partial',
    })).rejects.toThrow('CANVAS_CONTENT_IDENTITY_CONFLICT')
    expect(fixture.scopes.nodes.get('image-partial')?.['meta.json']).toBeUndefined()
  })

  test('Given 内容节点 When 移入独立 trashId 并恢复 Then entry 严格持久化且重放幂等', async () => {
    const fixture = createFixture()
    await fixture.store.prepareEmptyContent(target, { kind: 'document', contentId: 'content-1' })
    await fixture.store.moveToTrash(target, trashEntry)
    /** 模拟 rename 已提交、entry.json 写入确认前进程崩溃。 */
    delete fixture.scopes.trash.get('trash-1')!['entry.json']
    await fixture.store.moveToTrash(target, trashEntry)
    expect(fixture.scopes.nodes.has('content-1')).toBe(false)
    expect(fixture.scopes.trash.has('trash-1')).toBe(true)
    expect(readJson<CanvasTrashEntry>(fixture.scopes.trash.get('trash-1')!, 'entry.json')).toEqual(trashEntry)

    expect(await fixture.store.restoreFromTrash(target, 'trash-1')).toEqual(trashEntry)
    expect(await fixture.store.restoreFromTrash(target, 'trash-1')).toEqual(trashEntry)
    expect(fixture.scopes.nodes.has('content-1')).toBe(true)
    expect(fixture.scopes.trash.has('trash-1')).toBe(false)
  })

  test('Given move 已可见但目录持久性未确认 When 重放 Then 先补齐 entry 再明确告警且后续收敛', async () => {
    const fixture = createFixture({
      moveOutcome: {
        commitVisible: true,
        durabilityUncertain: true,
        error: 'directory flush failed',
      },
    })
    await fixture.store.prepareEmptyContent(target, { kind: 'document', contentId: 'content-1' })

    await expect(fixture.store.moveToTrash(target, trashEntry))
      .rejects.toThrow('CANVAS_CONTENT_DURABILITY_UNCERTAIN')
    expect(readJson<CanvasTrashEntry>(fixture.scopes.trash.get('trash-1')!, 'entry.json')).toEqual(trashEntry)
    await fixture.store.moveToTrash(target, trashEntry)
  })

  test('Given move 目标已有不同身份 When 删除或恢复 Then fail closed 且不覆盖', async () => {
    const fixture = createFixture()
    await fixture.store.prepareEmptyContent(target, { kind: 'document', contentId: 'content-1' })
    fixture.scopes.trash.set('trash-1', { 'meta.json': JSON.stringify({ schemaVersion: 1, kind: 'image', contentId: 'other', revision: 0, createdAt: 1, updatedAt: 1 }) })
    await expect(fixture.store.moveToTrash(target, trashEntry)).rejects.toThrow('CANVAS_CONTENT_IDENTITY_CONFLICT')

    fixture.scopes.trash.clear()
    await fixture.store.moveToTrash(target, trashEntry)
    await fixture.store.prepareEmptyContent(target, { kind: 'image', contentId: 'content-1' })
    await expect(fixture.store.restoreFromTrash(target, 'trash-1')).rejects.toThrow('CANVAS_CONTENT_IDENTITY_CONFLICT')
  })

  test('Given 多个与损坏回收条目 When 列表 Then 隔离损坏项、确定性排序并限制 512', async () => {
    const fixture = createFixture()
    for (let index = 0; index < 514; index += 1) {
      const trashId = `trash-${index.toString().padStart(3, '0')}`
      const entry = { ...trashEntry, trashId, contentId: `content-${index}`, deletedAt: index }
      fixture.scopes.trash.set(trashId, { 'entry.json': JSON.stringify(entry) })
    }
    fixture.scopes.trash.set('trash-bad', { 'entry.json': '{bad' })

    const result = await fixture.store.listTrash(target)
    expect(result).toHaveLength(512)
    expect(result[0]?.deletedAt).toBe(511)
    expect(result.at(-1)?.deletedAt).toBe(0)
  })

  test('Given 回收区包含损坏 entry.json When 列表 Then 只隔离损坏单项', async () => {
    const fixture = createFixture()
    fixture.scopes.trash.set('trash-good', { 'entry.json': JSON.stringify({
      ...trashEntry,
      trashId: 'trash-good',
    }) })
    fixture.scopes.trash.set('trash-bad', { 'entry.json': '{bad' })

    expect(await fixture.store.listTrash(target)).toEqual([{
      ...trashEntry,
      trashId: 'trash-good',
    }])
  })

  test('Given list 已取得条目后 capability 撤权 When 逐项读取 Then 原样传播而不是返回空列表', async () => {
    const fixture = createFixture({ revokeOnAssertCall: 5 })
    fixture.scopes.trash.set('trash-1', { 'entry.json': JSON.stringify(trashEntry) })

    await expect(fixture.store.listTrash(target)).rejects.toThrow('CANVAS_DIRECTORY_SCOPE_CHANGED')
  })

  test('Given helper 在逐项读取时协议失败 When 列出 Then 原样传播基础设施错误', async () => {
    const fixture = createFixture({ entryReadError: 'STABLE_DIRECTORY_PROTOCOL_INVALID' })
    fixture.scopes.trash.set('trash-1', { 'entry.json': JSON.stringify(trashEntry) })

    await expect(fixture.store.listTrash(target)).rejects.toThrow('STABLE_DIRECTORY_PROTOCOL_INVALID')
  })

  test('Given restore 遇到损坏 entry 或授权失败 When 恢复 Then 两类错误保持可辨识', async () => {
    const damaged = createFixture()
    damaged.scopes.trash.set('trash-1', { 'entry.json': '{bad' })
    await expect(damaged.store.restoreFromTrash(target, 'trash-1'))
      .rejects.toThrow('CANVAS_CONTENT_CORRUPT')

    const revoked = createFixture({ revokeOnAuthorize: true })
    await expect(revoked.store.restoreFromTrash(target, 'trash-1'))
      .rejects.toThrow('稳定目录授权被拒绝')

    const revokedDuringReplayScan = createFixture({ revokeOnAssertCall: 7 })
    revokedDuringReplayScan.scopes.nodes.set('content-1', {
      'entry.json': JSON.stringify(trashEntry),
    })
    await expect(revokedDuringReplayScan.store.restoreFromTrash(target, 'trash-1'))
      .rejects.toThrow('CANVAS_DIRECTORY_SCOPE_CHANGED')
  })

  test('Given OPENED 授权时撤权 When 操作 Then 拒绝且不写入', async () => {
    const fixture = createFixture({ revokeOnAuthorize: true })
    await expect(fixture.store.prepareEmptyContent(target, { kind: 'document', contentId: 'content-1' }))
      .rejects.toThrow('稳定目录授权被拒绝')
    expect(fixture.scopes.nodes.size).toBe(0)
  })

  test('Given helper rename 前失败或 rename 后耐久性未确认 When 提交 Then 映射为明确错误', async () => {
    const failed = createFixture({
      outcomeFor: (request) => request.fileName === 'content.md'
        ? { commitVisible: false, durabilityUncertain: false, error: 'disk full' }
        : undefined,
    })
    await expect(failed.store.prepareEmptyContent(target, { kind: 'document', contentId: 'content-1' }))
      .rejects.toThrow('CANVAS_CONTENT_WRITE_FAILED')

    const uncertain = createFixture({
      outcomeFor: (request) => request.fileName === 'meta.json'
        ? { commitVisible: true, durabilityUncertain: true, error: 'directory flush failed' }
        : undefined,
    })
    await expect(uncertain.store.prepareEmptyContent(target, { kind: 'document', contentId: 'content-1' }))
      .rejects.toThrow('CANVAS_CONTENT_DURABILITY_UNCERTAIN')
    expect(uncertain.scopes.nodes.has('content-1')).toBe(true)
  })

  test('Given 任意内容操作 When 检查 helper 请求 Then 仅包含 canvasRoot 与相对受限字段', async () => {
    const fixture = createFixture()
    await fixture.store.prepareEmptyContent(target, { kind: 'webview', contentId: 'content-1' })
    for (const request of fixture.requests) {
      expect(request.roots).toEqual(['/canvas'])
      expect(request.childName).toBeDefined()
      expect(['nodes', 'trash']).toContain(request.childName!)
      expect(JSON.stringify(request)).not.toContain('/canvas/nodes')
      expect(JSON.stringify(request)).not.toContain('/canvas/trash')
    }
  })

  test.skipIf(!nativeHelperPlatformSupported)('Given 真实 helper When 准备、回收并恢复 Then Store 全程通过相对协议完成', async () => {
    /** 隔离的真实 Canvas root。 */
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'proma-canvas-content-store-'))
    /** helper 获得的单个 Canvas root。 */
    const canvasRoot = join(temporaryRoot, 'canvas')
    mkdirSync(canvasRoot)
    try {
      /** 使用真实 helper、但仅提供同一次 LOAD capability 的 Store。 */
      const store = createCanvasNodeContentStore({
        now: () => 100,
        store: {
          loadWithDirectoryCapability: () => ({
            snapshot: { document: {} as never, writable: true, nodeIssues: [] },
            openSingleChildDirectory: (name) => ({
              path: join(canvasRoot, name),
              rootPath: canvasRoot,
              assertValid: () => undefined,
              authorizeOpenedRoots: (roots) => roots.length === 1
                && roots[0]?.requestedPath === canvasRoot,
            }),
          }),
        },
        runStableDirectoryNative: (request, authorize) => runStableDirectoryNative(
          request,
          authorize,
          { helperPath: () => nativeHelperPath },
        ),
      })

      await store.prepareEmptyContent(target, { kind: 'document', contentId: 'content-1' })
      await store.moveToTrash(target, trashEntry)
      expect(await store.listTrash(target)).toEqual([trashEntry])
      expect(await store.restoreFromTrash(target, trashEntry.trashId)).toEqual(trashEntry)
      expect(await store.assertContent(target, {
        kind: 'document',
        contentId: 'content-1',
      })).toMatchObject({ kind: 'document', contentId: 'content-1' })
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  })
})
