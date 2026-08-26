import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CANVAS_DOCUMENT_VERSION,
  createEmptyCanvasDocument,
} from '@proma/shared'
import type { CanvasDocument, CanvasMutation, CanvasNode } from '@proma/shared'
import {
  createCanvasDocumentStore,
  isOpenedRootSameDirectoryIdentity,
  parseCanvasDocument,
} from './canvas-document-store'
import type { CanvasDocumentStoreOptions } from './canvas-document-store'
import { CanvasSessionStore } from './canvas-session-store'
import { createDesignPathResolver } from './design-paths'
import type { DesignPathResolver } from './design-paths'
import { writeJsonFileAtomicSecure } from '../safe-file'

/** 单个测试环境中的可信路径、会话索引和文档 Store。 */
interface CanvasStoreFixture {
  pathResolver: DesignPathResolver
  sessions: CanvasSessionStore
  store: ReturnType<typeof createCanvasDocumentStore>
  documentPath: string
  legacyPath: string
}

/** 测试只允许替换性能计数和安全文件边界，不替换 registry 与路径所有权。 */
interface CanvasStoreOverrides {
  sessions?: CanvasDocumentStoreOptions['sessions']
  pathResolver?: CanvasDocumentStoreOptions['pathResolver']
  now?: CanvasDocumentStoreOptions['now']
  validateDocument?: CanvasDocumentStoreOptions['validateDocument']
  writeJsonFileAtomicSecure?: CanvasDocumentStoreOptions['writeJsonFileAtomicSecure']
  removeFileAtomic?: CanvasDocumentStoreOptions['removeFileAtomic']
  afterCandidateRead?: CanvasDocumentStoreOptions['afterCandidateRead']
  beforeConsumeRecoveredTemporary?: CanvasDocumentStoreOptions['beforeConsumeRecoveredTemporary']
  onRecoveryDegraded?: CanvasDocumentStoreOptions['onRecoveryDegraded']
}

describe('CanvasDocumentStore', () => {
  test('Given dev/ino 超过 2^53 When 比较当前、首次与 helper 身份 Then 只接受十进制精确一致', () => {
    const identity = {
      path: '/canvas', canonicalPath: '/canvas',
      dev: 9_007_199_254_740_993n,
      ino: 18_014_398_509_481_985n,
    }
    expect(isOpenedRootSameDirectoryIdentity(identity, {
      requestedPath: '/canvas', canonicalPath: '/canvas', isDirectory: true,
      volume: '9007199254740993', fileId: '18014398509481985',
    })).toBe(true)
    expect(isOpenedRootSameDirectoryIdentity(identity, {
      requestedPath: '/canvas', canonicalPath: '/canvas', isDirectory: true,
      volume: '9007199254740992', fileId: '18014398509481984',
    })).toBe(false)
  })

  /** 每个测试独占的临时项目和配置根。 */
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proma-canvas-document-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * 创建已登记 native Canvas 的完整测试环境。
   * @param overrides 可替换的文档 Store 窄依赖。
   * @returns 固定项目与 Canvas 身份的测试环境。
   */
  function createFixture(overrides: CanvasStoreOverrides = {}): CanvasStoreFixture {
    /** 测试解析器只承认两个明确项目。 */
    const pathResolver = createDesignPathResolver({
      getWorkspace: (projectId) => ['project-1', 'project-2'].includes(projectId) ? {
        id: projectId,
        name: '项目',
        slug: projectId,
        projectRootPath: join(root, projectId),
        createdAt: 1,
        updatedAt: 1,
      } : undefined,
      getProjectFilesPath: (workspaceSlug) => join(root, workspaceSlug),
      getConfigDir: () => join(root, '.config'),
    })
    /** 会话索引先登记 native Canvas，满足文档访问的第一道授权。 */
    const sessions = new CanvasSessionStore({
      pathResolver,
      now: () => 10,
      createId: () => 'canvas-1',
    })
    sessions.create({ projectId: 'project-1', title: '原生 Canvas' })
    /** 文档 Store 默认使用固定时钟，便于断言 revision 时间语义。 */
    /** 所有权依赖默认使用真实 fixture，单测可窄替换观察安全顺序。 */
    const store = createCanvasDocumentStore({
      pathResolver: overrides.pathResolver ?? pathResolver,
      sessions: overrides.sessions ?? sessions,
      now: overrides.now ?? (() => 100),
      validateDocument: overrides.validateDocument,
      writeJsonFileAtomicSecure: overrides.writeJsonFileAtomicSecure,
      removeFileAtomic: overrides.removeFileAtomic,
      afterCandidateRead: overrides.afterCandidateRead,
      beforeConsumeRecoveredTemporary: overrides.beforeConsumeRecoveredTemporary,
      onRecoveryDegraded: overrides.onRecoveryDegraded,
    })
    /** 原生文档必须只位于 resolveCanvas 给出的独立目录。 */
    const documentPath = pathResolver.resolveCanvas('project-1', 'canvas-1').documentPath
    /** legacy 路径用于证明 native 不会回退。 */
    const legacyPath = pathResolver.resolve('project-1').canvasPath
    return { pathResolver, sessions, store, documentPath, legacyPath }
  }

  /**
   * 创建两节点一边的合法文档。
   * @param revision 需要固化的文档 revision。
   * @returns 可用于磁盘候选与 mutation 基线的严格文档。
   */
  function createConnectedDocument(revision = 2): CanvasDocument {
    return {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 20),
      revision,
      updatedAt: 20 + revision,
      nodes: [
        {
          id: 'node-agent',
          kind: 'agent',
          title: 'Agent',
          position: { x: 0, y: 0 },
          agentSessionId: 'agent-session-1',
        },
        {
          id: 'node-image',
          kind: 'image',
          title: '图片',
          position: { x: 10, y: 10 },
          assetId: 'asset-1',
        },
      ],
      edges: [{
        id: 'edge-1',
        sourceNodeId: 'node-agent',
        sourcePort: 'output',
        targetNodeId: 'node-image',
        targetPort: 'input',
      }],
    }
  }

  /** 把文档写入候选路径，并按需创建父目录。 */
  function writeDocument(path: string, document: object): void {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(document), 'utf8')
  }

  /** 返回 Canvas 根内残留的随机安全写 staging 文件。 */
  function listAtomicStagingFiles(documentPath: string): string[] {
    return readdirSync(join(documentPath, '..'))
      .filter((name) => name.startsWith('.canvas.json') && name.endsWith('.tmp'))
  }

  /** 把当前 Canvas 根转换为 helper OPENED 协议中的稳定身份事实。 */
  function createOpenedCanvasRoot(canvasRoot: string) {
    const stats = lstatSync(canvasRoot)
    return {
      requestedPath: canvasRoot,
      canonicalPath: realpathSync(canvasRoot),
      isDirectory: true,
      volume: String(stats.dev),
      fileId: String(stats.ino),
    }
  }

  test('Given 已登记 native Canvas 且文档缺失 When load Then 返回绑定双重身份的空文档且不落盘', () => {
    const fixture = createFixture()

    expect(fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' })).toEqual({
      document: createEmptyCanvasDocument('project-1', 'canvas-1', 100),
      writable: true,
      nodeIssues: [],
    })
    expect(existsSync(fixture.documentPath)).toBe(false)
  })

  test('Given helper OPENED 等待期间 Canvas registry 撤权 When 授权 scan Then fail closed 且零扫描', () => {
    /** 可变 registry 用于模拟 LOAD 后、helper 授权前撤销 Canvas。 */
    let authorized = true
    const fixture = createFixture({
      sessions: {
        requireNative: () => {
          if (!authorized) throw new Error('Canvas 会话不存在')
          return {} as never
        },
      },
    })
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    const capability = fixture.store.loadWithDirectoryCapability(target)
      .openSingleChildDirectory('transactions')
    const openedRoot = createOpenedCanvasRoot(capability.rootPath)
    /** 只有授权成功时才代表 helper 可以继续执行 scan。 */
    let scanCalls = 0
    authorized = false

    expect(() => {
      if (capability.authorizeOpenedRoots([openedRoot])) scanCalls += 1
    }).toThrow('Canvas 会话不存在')
    expect(scanCalls).toBe(0)
  })

  test('Given helper OPENED 等待期间项目迁移到新根 When 授权 write Then 旧根被拒绝且零写入', () => {
    /** resolver 每次读取当前项目根，模拟迁移或重链后的权威路径切换。 */
    let activeProjectRoot = join(root, 'project-before-migration')
    const pathResolver = createDesignPathResolver({
      getWorkspace: (projectId) => projectId === 'project-1' ? {
        id: projectId,
        name: '项目',
        slug: projectId,
        projectRootPath: activeProjectRoot,
        createdAt: 1,
        updatedAt: 1,
      } : undefined,
      getProjectFilesPath: () => activeProjectRoot,
      getConfigDir: () => join(root, '.config'),
    })
    const store = createCanvasDocumentStore({
      sessions: { requireNative: () => ({}) as never },
      pathResolver,
      now: () => 1,
    })
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    /** 会话索引在真实流程中会先创建当前 Canvas 集合根。 */
    mkdirSync(pathResolver.resolve(target.projectId).canvasesRoot, { recursive: true })
    const capability = store.loadWithDirectoryCapability(target)
      .openSingleChildDirectory('transactions')
    const openedRoot = createOpenedCanvasRoot(capability.rootPath)
    /** 只有旧 helper root 再次匹配当前 resolver 时才允许执行 write。 */
    let writeCalls = 0
    activeProjectRoot = join(root, 'project-after-migration')
    mkdirSync(pathResolver.resolve(target.projectId).canvasesRoot, { recursive: true })

    if (capability.authorizeOpenedRoots([openedRoot])) writeCalls += 1

    expect(writeCalls).toBe(0)
  })

  test('Given legacy 画布存在且 native 缺失 When load Then 返回独立空文档绝不回退', () => {
    const fixture = createFixture()
    writeDocument(fixture.legacyPath, { projectId: 'project-1', nodes: [{ id: 'legacy-node' }] })

    const snapshot = fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' })

    expect(snapshot.document.nodes).toEqual([])
    expect(snapshot.document.canvasId).toBe('canvas-1')
    expect(existsSync(fixture.documentPath)).toBe(false)
  })

  test('Given native 空文档 When mutate Then 只写 resolveCanvas documentPath', () => {
    const fixture = createFixture()
    /** 单次有效 mutation 应创建原生 Canvas 文档。 */
    const result = fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      0,
      [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1.5 } }],
    )

    expect(result.revision).toBe(1)
    expect(existsSync(fixture.documentPath)).toBe(true)
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8'))).toEqual(result)
    expect(existsSync(fixture.legacyPath)).toBe(false)
  })

  test.each([
    ['tmp', '.tmp'],
    ['backup', '.bak'],
  ] as const)('Given 主文件损坏且合法 %s 候选 When load Then 安全提升并仅首次报告恢复', (source, suffix) => {
    const fixture = createFixture()
    writeDocument(fixture.documentPath, { broken: true })
    writeDocument(`${fixture.documentPath}${suffix}`, createConnectedDocument())

    const recovered = fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' })
    expect(recovered.recoveredFrom).toBe(source)
    expect(recovered.document.revision).toBe(2)
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8'))).toEqual(recovered.document)
    if (source === 'tmp') expect(existsSync(`${fixture.documentPath}.tmp`)).toBe(false)

    const stable = fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' })
    expect(stable.recoveredFrom).toBeUndefined()
    expect(stable.document).toEqual(recovered.document)
  })

  test('Given 候选读取后同 inode 被原地改写 When load Then 内容状态变化 fail closed', () => {
    const fixture = createFixture({
      afterCandidateRead: (candidatePath) => {
        if (candidatePath !== fixture.documentPath) return
        /** 追加合法 JSON 空白会保留 inode，但改变 size/mtime/ctime。 */
        writeFileSync(candidatePath, `${readFileSync(candidatePath, 'utf8')} `, 'utf8')
      },
    })
    writeDocument(fixture.documentPath, createConnectedDocument())

    expect(() => fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('CANVAS_PATH_UNSAFE')
  })

  test('Given 候选读取后路径被新 inode 置换 When load Then 重新 lstat 拒绝替换路径', () => {
    const fixture = createFixture({
      afterCandidateRead: (candidatePath) => {
        if (candidatePath !== fixture.documentPath) return
        /** 原 fd 仍绑定旧 inode，但同名路径已经指向攻击者替换文件。 */
        renameSync(candidatePath, `${candidatePath}.original`)
        writeDocument(candidatePath, createConnectedDocument(4))
      },
    })
    writeDocument(fixture.documentPath, createConnectedDocument())

    expect(() => fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('CANVAS_PATH_UNSAFE')
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8')).revision).toBe(4)
  })

  test('Given tmp 提升后被新 inode 置换 When 消费恢复文件 Then 不删除替换文件', () => {
    const fixture = createFixture({
      beforeConsumeRecoveredTemporary: (temporaryPath) => {
        /** 保留已读取 tmp，并在原路径放置另一个合法文档。 */
        renameSync(temporaryPath, `${temporaryPath}.original`)
        writeDocument(temporaryPath, createConnectedDocument(4))
      },
    })
    writeDocument(fixture.documentPath, { broken: true })
    writeDocument(`${fixture.documentPath}.tmp`, createConnectedDocument(2))

    expect(() => fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('原子删除目标身份不匹配')
    expect(JSON.parse(readFileSync(`${fixture.documentPath}.tmp`, 'utf8')).revision).toBe(4)
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8')).revision).toBe(2)
  })

  test('Given 主 tmp bak 全部损坏 When load Then 明确失败且不覆盖任何候选', () => {
    const fixture = createFixture()
    /** 三份损坏原文用于验证失败不会触发修复性覆盖。 */
    const candidates = [fixture.documentPath, `${fixture.documentPath}.tmp`, `${fixture.documentPath}.bak`]
    mkdirSync(join(fixture.documentPath, '..'), { recursive: true })
    candidates.forEach((path, index) => writeFileSync(path, `{broken-${index}`, 'utf8'))

    expect(() => fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('CANVAS_DOCUMENT_CORRUPT')
    candidates.forEach((path, index) => expect(readFileSync(path, 'utf8')).toBe(`{broken-${index}`))
  })

  test('Given 磁盘 revision 已推进 When mutate 使用旧 expectedRevision Then 冲突且不覆盖', () => {
    const fixture = createFixture()
    writeDocument(fixture.documentPath, createConnectedDocument(3))

    expect(() => fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      2,
      [{ type: 'set-viewport', viewport: { x: 1, y: 1, zoom: 1 } }],
    )).toThrow('CANVAS_REVISION_CONFLICT: expected=2, current=3')
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8')).revision).toBe(3)
  })

  test('Given mutate 读取 revision 后另一写者推进主文件 When 提交 Then CAS 冲突且 main 与 bak 均不降级', () => {
    /** validateCurrent 位于稳定读取之后，模拟进程外写者提交更高 revision。 */
    const fixture = createFixture()
    writeDocument(fixture.documentPath, createConnectedDocument(2))
    writeDocument(`${fixture.documentPath}.bak`, createConnectedDocument(1))

    expect(() => fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      2,
      [{ type: 'set-viewport', viewport: { x: 1, y: 1, zoom: 1 } }],
      () => writeDocument(fixture.documentPath, createConnectedDocument(9)),
    )).toThrow('CANVAS_REVISION_CONFLICT')
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8')).revision).toBe(9)
    expect(JSON.parse(readFileSync(`${fixture.documentPath}.bak`, 'utf8')).revision).toBe(1)
  })

  test('Given validateCurrent 后 native 授权被撤销 When mutate 提交 Then 二次授权先于路径和写入', () => {
    const fixture = createFixture()
    /** 第二次授权模拟 Canvas 在校验后被归档迁移或删除。 */
    let authorizationCalls = 0
    const sessions: CanvasDocumentStoreOptions['sessions'] = {
      requireNative: () => {
        authorizationCalls += 1
        if (authorizationCalls === 2) throw new Error('Canvas 会话不存在')
        return fixture.sessions.requireNative('project-1', 'canvas-1')
      },
    }
    /** 只允许首次 load 解析一次文档路径。 */
    let resolveCanvasCalls = 0
    const pathResolver: DesignPathResolver = {
      resolve: fixture.pathResolver.resolve,
      resolveCanvas: (projectId, canvasId) => {
        resolveCanvasCalls += 1
        return fixture.pathResolver.resolveCanvas(projectId, canvasId)
      },
    }
    /** 写边界不得在二次授权失败后触达。 */
    let writeCalls = 0
    const store = createCanvasDocumentStore({
      sessions,
      pathResolver,
      now: () => 100,
      writeJsonFileAtomicSecure: () => { writeCalls += 1 },
    })

    expect(() => store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      0,
      [{ type: 'set-viewport', viewport: { x: 1, y: 1, zoom: 1 } }],
      () => undefined,
    )).toThrow('Canvas 会话不存在')
    expect(authorizationCalls).toBe(2)
    expect(resolveCanvasCalls).toBe(1)
    expect(writeCalls).toBe(0)
  })

  test('Given validateCurrent 拒绝且 revision 也冲突 When mutate Then 策略先于冲突、apply 和写入', () => {
    /** 当前文档确保 expectedRevision 明确过期。 */
    let writeCalls = 0
    const fixture = createFixture({
      writeJsonFileAtomicSecure: () => { writeCalls += 1 },
    })
    writeDocument(fixture.documentPath, createConnectedDocument(2))

    expect(() => fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      1,
      [{ type: 'upsert-nodes', nodes: [createConnectedDocument().nodes[0]!, createConnectedDocument().nodes[0]!] }],
      (document) => {
        expect(document.revision).toBe(2)
        throw new Error('CURRENT_POLICY_REJECTED')
      },
    )).toThrow('CURRENT_POLICY_REJECTED')
    expect(writeCalls).toBe(0)
  })

  test.each([
    ['同值时钟', 22],
    ['回拨时钟', 10],
  ] as const)('Given %s When mutate Then updatedAt 严格推进且 createdAt 不变', (_label, now) => {
    const fixture = createFixture({ now: () => now })
    writeDocument(fixture.documentPath, createConnectedDocument(2))

    const result = fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      2,
      [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    )

    expect(result.updatedAt).toBeGreaterThan(22)
    expect(result.createdAt).toBe(20)
  })

  test('Given 当前 updatedAt 已无法生成有限更大值 When mutate Then 明确失败且不写', () => {
    let writeCalls = 0
    const fixture = createFixture({
      now: () => 100,
      writeJsonFileAtomicSecure: () => { writeCalls += 1 },
    })
    writeDocument(fixture.documentPath, {
      ...createConnectedDocument(2),
      updatedAt: Number.MAX_VALUE,
    })

    expect(() => fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      2,
      [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    )).toThrow('CANVAS_TIMESTAMP_INVALID')
    expect(writeCalls).toBe(0)
  })

  test('Given 首次 mutate 发现恢复候选 When 保存 Then 提升后要求 Renderer 重载且不应用 mutation', () => {
    const fixture = createFixture()
    writeDocument(fixture.documentPath, { broken: true })
    writeDocument(`${fixture.documentPath}.tmp`, createConnectedDocument(2))

    expect(() => fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      2,
      [{ type: 'set-viewport', viewport: { x: 9, y: 9, zoom: 2 } }],
    )).toThrow('CANVAS_RECOVERY_REQUIRED: recoveredFrom=tmp')
    /** 主文件只包含恢复 revision，未包含本次 mutation。 */
    const promoted = JSON.parse(readFileSync(fixture.documentPath, 'utf8')) as CanvasDocument
    expect(promoted.revision).toBe(2)
    expect(promoted.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  test('Given backup 读取后另一写者修复主文件 When load Then 恢复 CAS 失败且所有候选保持不变', () => {
    /** backup hook 发生在主损坏状态已读取之后，用真实文件模拟并发修复。 */
    const fixture = createFixture({
      afterCandidateRead: (candidatePath) => {
        if (candidatePath === `${fixture.documentPath}.bak`) {
          writeDocument(fixture.documentPath, createConnectedDocument(9))
        }
      },
    })
    writeDocument(fixture.documentPath, { broken: true })
    writeFileSync(`${fixture.documentPath}.tmp`, '{broken-tmp', 'utf8')
    writeDocument(`${fixture.documentPath}.bak`, createConnectedDocument(2))

    expect(() => fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('CANVAS_REVISION_CONFLICT')
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8')).revision).toBe(9)
    expect(readFileSync(`${fixture.documentPath}.tmp`, 'utf8')).toBe('{broken-tmp')
    expect(JSON.parse(readFileSync(`${fixture.documentPath}.bak`, 'utf8')).revision).toBe(2)
  })

  test('Given 主文件缺失且 tmp 读取后另一写者创建主文件 When load Then 恢复失败且 tmp 不被消费', () => {
    /** tmp hook 在恢复提升前创建新主文件，验证 missing CAS 与消费顺序。 */
    const fixture = createFixture({
      afterCandidateRead: (candidatePath) => {
        if (candidatePath === `${fixture.documentPath}.tmp`) {
          writeDocument(fixture.documentPath, createConnectedDocument(9))
        }
      },
    })
    writeDocument(`${fixture.documentPath}.tmp`, createConnectedDocument(2))

    expect(() => fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('CANVAS_REVISION_CONFLICT')
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8')).revision).toBe(9)
    expect(JSON.parse(readFileSync(`${fixture.documentPath}.tmp`, 'utf8')).revision).toBe(2)
  })

  test('Given 已有主文件 When mutate 成功 Then 单次 CAS 提交并保留 previous revision backup', () => {
    /** 使用真实 secure write 锁定主文件与 backup 的共同提交合同。 */
    const fixture = createFixture()
    writeDocument(fixture.documentPath, createConnectedDocument(2))

    fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      2,
      [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    )

    expect(JSON.parse(readFileSync(`${fixture.documentPath}.bak`, 'utf8')).revision).toBe(2)
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8')).revision).toBe(3)
  })

  test('Given main durable 后 backup rename 前 CAS 失败 When mutate Then 返回 next 并告警且旧 backup 保留', () => {
    /** 第一次目录同步后触碰 backup 内容状态，真实触发 priorBackupDegraded。 */
    const degradedErrors: Error[] = []
    const fixture = createFixture({
      writeJsonFileAtomicSecure: (path, document, options) => writeJsonFileAtomicSecure(
        path,
        document,
        {
          ...options,
          syncDirectory: () => {
            const backupPath = `${path}.bak`
            const content = readFileSync(backupPath, 'utf8')
            writeFileSync(backupPath, content, 'utf8')
          },
        },
      ),
      onRecoveryDegraded: (_message, error) => { degradedErrors.push(error) },
    })
    writeDocument(fixture.documentPath, createConnectedDocument(2))
    writeDocument(`${fixture.documentPath}.bak`, createConnectedDocument(1))

    const next = fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      2,
      [{ type: 'set-viewport', viewport: { x: 3, y: 4, zoom: 1 } }],
    )

    expect(next.revision).toBe(3)
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8')).revision).toBe(3)
    expect(JSON.parse(readFileSync(`${fixture.documentPath}.bak`, 'utf8')).revision).toBe(1)
    expect(listAtomicStagingFiles(fixture.documentPath)).toEqual([])
    expect(degradedErrors).toHaveLength(1)
    expect(fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }).document).toEqual(next)
  })

  test('Given backup rename 后 durability 失败 When mutate Then 返回 next 并告警且 previous backup 可见', () => {
    /** 第二次目录同步注入 EIO，此时 main 与 backup rename 都已完成。 */
    let syncCalls = 0
    const degradedErrors: Error[] = []
    const fixture = createFixture({
      writeJsonFileAtomicSecure: (path, document, options) => writeJsonFileAtomicSecure(
        path,
        document,
        {
          ...options,
          syncDirectory: () => {
            syncCalls += 1
            if (syncCalls === 2) throw new Error('backup durability failed')
          },
        },
      ),
      onRecoveryDegraded: (_message, error) => { degradedErrors.push(error) },
    })
    writeDocument(fixture.documentPath, createConnectedDocument(2))
    writeDocument(`${fixture.documentPath}.bak`, createConnectedDocument(1))

    const next = fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      2,
      [{ type: 'set-viewport', viewport: { x: 3, y: 4, zoom: 1 } }],
    )

    expect(next.revision).toBe(3)
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8')).revision).toBe(3)
    expect(JSON.parse(readFileSync(`${fixture.documentPath}.bak`, 'utf8')).revision).toBe(2)
    expect(listAtomicStagingFiles(fixture.documentPath)).toEqual([])
    expect(degradedErrors).toHaveLength(1)
  })

  test('Given main rename 后 durability 失败 When mutate Then 要求对账且不自动重复 mutation', () => {
    /** 第一次目录同步即失败，主文件已 rename 但 durability 尚未确认。 */
    const fixture = createFixture({
      writeJsonFileAtomicSecure: (path, document, options) => writeJsonFileAtomicSecure(
        path,
        document,
        { ...options, syncDirectory: () => { throw new Error('main durability failed') } },
      ),
    })
    writeDocument(fixture.documentPath, createConnectedDocument(2))
    writeDocument(`${fixture.documentPath}.bak`, createConnectedDocument(1))

    expect(() => fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      2,
      [{ type: 'set-viewport', viewport: { x: 3, y: 4, zoom: 1 } }],
    )).toThrow('CANVAS_COMMIT_UNCERTAIN')
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8')).revision).toBe(3)
    expect(JSON.parse(readFileSync(`${fixture.documentPath}.bak`, 'utf8')).revision).toBe(1)
    expect(listAtomicStagingFiles(fixture.documentPath)).toEqual([])
    const reconciled = fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }).document
    expect(reconciled.revision).toBe(3)
    expect(reconciled.viewport).toEqual({ x: 3, y: 4, zoom: 1 })
  })

  test('Given recovery promotion main durability 未确认 When load Then 要求恢复对账且不消费 tmp', () => {
    /** recovery 无 priorBackup，主 rename 后同步失败仍必须使用 typed uncertain 分流。 */
    const fixture = createFixture({
      writeJsonFileAtomicSecure: (path, document, options) => writeJsonFileAtomicSecure(
        path,
        document,
        { ...options, syncDirectory: () => { throw new Error('recovery durability failed') } },
      ),
    })
    writeDocument(fixture.documentPath, { broken: true })
    writeDocument(`${fixture.documentPath}.tmp`, createConnectedDocument(2))

    expect(() => fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('CANVAS_RECOVERY_REQUIRED')
    expect(JSON.parse(readFileSync(fixture.documentPath, 'utf8')).revision).toBe(2)
    expect(JSON.parse(readFileSync(`${fixture.documentPath}.tmp`, 'utf8')).revision).toBe(2)
    expect(listAtomicStagingFiles(fixture.documentPath)).toEqual([])
    expect(fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }).document.revision).toBe(2)
  })

  test('Given 未知、跨项目或 legacy Canvas When load Then 在 resolveCanvas 前统一拒绝', () => {
    const fixture = createFixture()
    /** 建立 legacy 记录，但它不能进入 native 文档路径解析。 */
    writeDocument(fixture.legacyPath, {})
    fixture.sessions.ensureLegacySession('project-1')
    /** 代理解析器记录任何文档路径解析，requireNative 失败时必须保持为零。 */
    let resolveCanvasCalls = 0
    const guardedResolver: DesignPathResolver = {
      resolve: fixture.pathResolver.resolve,
      resolveCanvas: (projectId, canvasId) => {
        resolveCanvasCalls += 1
        return fixture.pathResolver.resolveCanvas(projectId, canvasId)
      },
    }
    const store = createCanvasDocumentStore({
      pathResolver: guardedResolver,
      sessions: fixture.sessions,
      now: () => 100,
    })

    for (const target of [
      { projectId: 'project-1', canvasId: 'missing' },
      { projectId: 'project-2', canvasId: 'canvas-1' },
      { projectId: 'project-1', canvasId: 'legacy-design' },
    ]) {
      expect(() => store.load(target)).toThrow('Canvas 会话不存在')
    }
    expect(resolveCanvasCalls).toBe(0)
  })

  test('Given resolver 把 Canvas 身份映射到同根其他目录 When load Then 固定目录合同拒绝', () => {
    const fixture = createFixture()
    /** 异常 resolver 保留声明身份，却把物理目录指向另一个 Canvas。 */
    const mismatchedResolver: DesignPathResolver = {
      resolve: fixture.pathResolver.resolve,
      resolveCanvas: (projectId, canvasId) => {
        /** 原始可信路径只用于取得同项目 canvasesRoot。 */
        const paths = fixture.pathResolver.resolveCanvas(projectId, canvasId)
        /** 伪造的 sibling 目录不等于请求 canvasId。 */
        const canvasRoot = join(paths.canvasRoot, '..', 'canvas-other')
        return { ...paths, canvasRoot, documentPath: join(canvasRoot, 'canvas.json') }
      },
    }
    const store = createCanvasDocumentStore({
      pathResolver: mismatchedResolver,
      sessions: fixture.sessions,
      now: () => 100,
    })

    expect(() => store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('CANVAS_PATH_UNSAFE')
  })

  test('Given 文档候选是 symlink 或非普通文件 When load Then no-follow 边界拒绝', () => {
    const fixture = createFixture()
    /** 外部合法文档不得经 symlink 候选进入 Canvas。 */
    const outsidePath = join(root, 'outside-canvas.json')
    writeDocument(outsidePath, createConnectedDocument())
    mkdirSync(join(fixture.documentPath, '..'), { recursive: true })
    symlinkSync(outsidePath, fixture.documentPath)
    expect(() => fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('CANVAS_PATH_UNSAFE')

    /** 同名目录同样不是可读取的普通候选。 */
    unlinkSync(fixture.documentPath)
    mkdirSync(fixture.documentPath)
    expect(() => fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('CANVAS_PATH_UNSAFE')
  })

  test.each([
    ['未知根字段', (document: CanvasDocument) => ({ ...document, secret: true })],
    ['重复节点 ID', (document: CanvasDocument) => ({ ...document, nodes: [document.nodes[0]!, document.nodes[0]!] })],
    ['重复边 ID', (document: CanvasDocument) => ({ ...document, edges: [document.edges[0], document.edges[0]] })],
    ['空端口', (document: CanvasDocument) => ({ ...document, edges: [{ ...document.edges[0], sourcePort: '' }] })],
    ['多余节点引用', (document: CanvasDocument) => ({
      ...document,
      nodes: [{ ...document.nodes[0], assetId: 'forged' }],
      edges: [],
    })],
    ['悬空边', (document: CanvasDocument) => ({
      ...document,
      edges: [{ ...document.edges[0], targetNodeId: 'missing-node' }],
    })],
    ['项目身份不匹配', (document: CanvasDocument) => ({ ...document, projectId: 'project-2' })],
    ['Canvas 身份不匹配', (document: CanvasDocument) => ({ ...document, canvasId: 'canvas-2' })],
  ] as const)('Given 文档包含%s When load Then 严格 schema 拒绝', (_label, corrupt) => {
    const fixture = createFixture()
    writeDocument(fixture.documentPath, corrupt(createConnectedDocument()))

    expect(() => fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('CANVAS_DOCUMENT_CORRUPT')
  })

  test.each([
    ['非有限节点坐标', (document: CanvasDocument) => ({
      ...document,
      nodes: [{ ...document.nodes[0], position: { x: Number.NaN, y: 0 } }],
      edges: [],
    })],
    ['非有限 viewport', (document: CanvasDocument) => ({
      ...document,
      viewport: { x: Number.POSITIVE_INFINITY, y: 0, zoom: 1 },
    })],
    ['非正 zoom', (document: CanvasDocument) => ({ ...document, viewport: { x: 0, y: 0, zoom: 0 } })],
    ['非整数 revision', (document: CanvasDocument) => ({ ...document, revision: 1.5 })],
    ['非有限 createdAt', (document: CanvasDocument) => ({ ...document, createdAt: Number.NaN })],
    ['非有限 updatedAt', (document: CanvasDocument) => ({ ...document, updatedAt: Number.POSITIVE_INFINITY })],
    ['空节点标题', (document: CanvasDocument) => ({
      ...document,
      nodes: [{ ...document.nodes[0], title: '   ' }],
      edges: [],
    })],
  ] as const)('Given 文档包含%s When load Then 有限 schema 拒绝', (_label, corrupt) => {
    const fixture = createFixture()
    writeDocument(fixture.documentPath, corrupt(createConnectedDocument()))

    expect(() => fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('CANVAS_DOCUMENT_CORRUPT')
  })

  test.each([
    ['agent', {
      id: 'node-agent', kind: 'agent', title: 'Agent', position: { x: 0, y: 0 },
      agentSessionId: 'session-1', assetId: 'forged',
    }],
    ['image', {
      id: 'node-image', kind: 'image', title: 'Image', position: { x: 0, y: 0 },
      assetId: 'asset-1', agentSessionId: 'forged',
    }],
    ['visual-document', {
      id: 'node-document', kind: 'visual-document', title: 'Document', position: { x: 0, y: 0 },
      visualDocumentId: 'document-1', url: 'https://example.com',
    }],
    ['webview', {
      id: 'node-webview', kind: 'webview', title: 'Webview', position: { x: 0, y: 0 },
      url: 'https://example.com', visualDocumentId: 'forged',
    }],
  ] as const)('Given %s 节点夹带其他类别引用 When load Then exact schema 拒绝', (_kind, node) => {
    const fixture = createFixture()
    writeDocument(fixture.documentPath, {
      ...createEmptyCanvasDocument('project-1', 'canvas-1', 20),
      nodes: [node],
    })

    expect(() => fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' }))
      .toThrow('CANVAS_DOCUMENT_CORRUPT')
  })

  test('Given 原始 mutation 包含重复 ID 或非法引用 When mutate Then reducer 前拒绝', () => {
    const fixture = createFixture()
    /** 合法基线的首节点用于构造同批重复 ID。 */
    const duplicatedNode = createConnectedDocument().nodes[0]!
    /** reducer 会折叠重复 ID，因此 Store 必须先检查原始 payload。 */
    const duplicate: CanvasMutation = {
      type: 'upsert-nodes',
      nodes: [duplicatedNode, duplicatedNode],
    }
    expect(() => fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' }, 0, [duplicate],
    )).toThrow('CANVAS_MUTATION_INVALID')

    /** 非法端口和悬空引用同样在任何写入前失败。 */
    expect(() => fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      0,
      [{ type: 'upsert-edges', edges: [{
        id: 'edge-invalid',
        sourceNodeId: 'missing-a',
        sourcePort: '',
        targetNodeId: 'missing-b',
        targetPort: 'input',
      }] }],
    )).toThrow('CANVAS_MUTATION_INVALID')

    /** 端口合法但节点引用悬空时，结果 schema 仍归因于本批 mutation。 */
    expect(() => fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      0,
      [{ type: 'upsert-edges', edges: [{
        id: 'edge-dangling',
        sourceNodeId: 'missing-a',
        sourcePort: 'output',
        targetNodeId: 'missing-b',
        targetPort: 'input',
      }] }],
    )).toThrow('CANVAS_MUTATION_INVALID')
    expect(existsSync(fixture.documentPath)).toBe(false)
  })

  test('Given move-nodes 指向当前不存在节点 When mutate Then reducer 和完整校验前拒绝', () => {
    /** 结果 validator 与写边界都不得触达。 */
    let validationCalls = 0
    let writeCalls = 0
    const fixture = createFixture({
      validateDocument: (value, target) => {
        validationCalls += 1
        return parseCanvasDocument(value, target)
      },
      writeJsonFileAtomicSecure: () => { writeCalls += 1 },
    })

    expect(() => fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      0,
      [{ type: 'move-nodes', positions: [{
        nodeId: 'missing-node',
        position: { x: 10, y: 20 },
      }] }],
    )).toThrow('CANVAS_MUTATION_INVALID')
    expect(validationCalls).toBe(0)
    expect(writeCalls).toBe(0)
    expect(existsSync(fixture.documentPath)).toBe(false)
  })

  test('Given 悬空边先 upsert 后同批 remove When mutate Then 后续删除不能掩盖非法引用', () => {
    /** 最终 reducer 结果会为空，因此必须在逐步 mutation 校验时失败。 */
    let validationCalls = 0
    let writeCalls = 0
    const fixture = createFixture({
      validateDocument: (value, target) => {
        validationCalls += 1
        return parseCanvasDocument(value, target)
      },
      writeJsonFileAtomicSecure: () => { writeCalls += 1 },
    })

    expect(() => fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      0,
      [
        { type: 'upsert-edges', edges: [{
          id: 'edge-dangling-hidden',
          sourceNodeId: 'missing-source',
          sourcePort: 'output',
          targetNodeId: 'missing-target',
          targetPort: 'input',
        }] },
        { type: 'remove-edges', edgeIds: ['edge-dangling-hidden'] },
      ],
    )).toThrow('CANVAS_MUTATION_INVALID')
    expect(validationCalls).toBe(0)
    expect(writeCalls).toBe(0)
    expect(existsSync(fixture.documentPath)).toBe(false)
  })

  test('Given 节点相连边和空 mutation When mutate Then 删除级联且空批次不推进不写入', () => {
    const fixture = createFixture()
    writeDocument(fixture.documentPath, createConnectedDocument(2))
    /** 删除节点必须同步删除所有入边和出边。 */
    const removed = fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      2,
      [{ type: 'remove-nodes', nodeIds: ['node-agent'] }],
    )
    expect(removed.nodes.map((node) => node.id)).toEqual(['node-image'])
    expect(removed.edges).toEqual([])
    expect(removed.revision).toBe(3)

    /** 空批次返回同一权威内容且不产生新的备份或 revision。 */
    const before = readFileSync(fixture.documentPath, 'utf8')
    const unchanged = fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' }, 3, [],
    )
    expect(unchanged).toEqual(removed)
    expect(readFileSync(fixture.documentPath, 'utf8')).toBe(before)
  })

  test('Given 1000 节点单批 mutation When mutate Then 一次完整 schema 校验和一次主安全写', () => {
    /** 生成稳定且互不重复的 1000 个 Agent 节点。 */
    const nodes: CanvasNode[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `node-${index}`,
      kind: 'agent',
      title: `Agent ${index}`,
      position: { x: index, y: index },
      agentSessionId: `session-${index}`,
    }))
    /** 窄依赖计数只观察完整文档 validator 和主提交写边界。 */
    let validationCalls = 0
    let writeCalls = 0
    const fixture = createFixture({
      validateDocument: (value, target) => {
        validationCalls += 1
        return parseCanvasDocument(value, target)
      },
      writeJsonFileAtomicSecure: (path, document) => {
        writeCalls += 1
        writeDocument(path, document)
      },
    })

    const result = fixture.store.mutate(
      { projectId: 'project-1', canvasId: 'canvas-1' },
      0,
      [{ type: 'upsert-nodes', nodes }],
    )

    expect(result.nodes).toHaveLength(1_000)
    expect(validationCalls).toBe(1)
    expect(writeCalls).toBe(1)
    expect(result.schemaVersion).toBe(CANVAS_DOCUMENT_VERSION)
  })
})
