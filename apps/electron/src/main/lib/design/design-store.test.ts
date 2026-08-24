import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesignCanvasNode } from '@proma/shared'
import { createEmptyDesignDocument } from '@proma/shared'
import { createDesignPathResolver } from './design-paths'
import { applyDesignMutations, createDesignStore, isDesignCanvasDocument } from './design-store'

describe('Design revision 原子存储', () => {
  /** 每个用例使用的独立项目根。 */
  let projectRoot: string
  /** 每个用例使用的独立配置根。 */
  let configRoot: string
  /** 固定时间便于断言 revision 更新时间。 */
  let currentTime: number

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'proma-design-project-'))
    configRoot = mkdtempSync(join(tmpdir(), 'proma-design-config-'))
    currentTime = 100
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(configRoot, { recursive: true, force: true })
  })

  /** 创建绑定当前临时目录的真实存储。 */
  function createStore() {
    /** 测试项目的可信路径解析器。 */
    const pathResolver = createDesignPathResolver({
      getWorkspace: () => ({
        id: 'project-1',
        name: '项目',
        slug: 'stable-slug',
        projectRootPath: projectRoot,
        createdAt: 1,
        updatedAt: 1,
      }),
      getProjectFilesPath: () => projectRoot,
      getConfigDir: () => configRoot,
    })
    return createDesignStore({ pathResolver, now: () => currentTime })
  }

  /** 创建可用于节点 mutation 的合法图片节点。 */
  function createNode(): DesignCanvasNode {
    return {
      id: 'node-1',
      kind: 'job',
      jobId: 'job-1',
      position: { x: 10, y: 20 },
      width: 320,
      height: 240,
      zIndex: 1,
    }
  }

  test('Given 尚无画布文件 When 加载 Then 返回内存空文档且不写项目', () => {
    /** 尚无任何持久化内容的存储。 */
    const store = createStore()
    /** 首次加载得到的只读快照。 */
    const snapshot = store.load('project-1')

    expect(snapshot.document).toEqual(createEmptyDesignDocument('project-1', 100))
    expect(snapshot.writable).toBe(true)
    expect(existsSync(join(projectRoot, '.proma/design/canvas.json'))).toBe(false)
  })

  test('Given mutation 带权威策略 When 策略拒绝 Then 单次加载后在应用和写入前停止', () => {
    const store = createStore()
    /** 校验次数用于证明同一权威文档只进入一次策略。 */
    let validationCount = 0

    expect(() => store.mutate('project-1', 0, [{
      type: 'set-viewport',
      viewport: { x: 9, y: 9, zoom: 1 },
    }], (document) => {
      validationCount += 1
      expect(document.revision).toBe(0)
      throw new Error('策略拒绝')
    })).toThrow('策略拒绝')
    expect(validationCount).toBe(1)
    expect(existsSync(join(projectRoot, '.proma/design/canvas.json'))).toBe(false)
  })

  test('Given 损坏主文件和有效备份 When 加载 Then 从备份恢复并标记来源', () => {
    /** 使用真实 safe-file 恢复链的存储。 */
    const store = createStore()
    /** 当前项目画布主文件路径。 */
    const canvasPath = join(projectRoot, '.proma/design/canvas.json')
    store.mutate('project-1', 0, [{
      type: 'set-viewport',
      viewport: { x: 0, y: 0, zoom: 1 },
    }])
    /** 第一次保存的合法文档，稍后作为恢复备份。 */
    const validDocument = JSON.parse(readFileSync(canvasPath, 'utf8')) as object
    writeFileSync(`${canvasPath}.bak`, JSON.stringify(validDocument), 'utf8')
    writeFileSync(canvasPath, '{ broken', 'utf8')

    /** 从备份恢复后的显式快照。 */
    const recovered = store.load('project-1')
    expect(recovered.recoveredFrom).toBe('backup')
    expect(recovered.document.revision).toBe(1)
    expect(JSON.parse(readFileSync(canvasPath, 'utf8'))).toEqual(validDocument)
  })

  test('Given 固定 tmp 恢复后继续保存 When 主文件再次损坏 Then 消费旧 tmp 并恢复最新备份', () => {
    /** 使用真实安全恢复、备份和删除链的存储。 */
    const store = createStore()
    /** 当前项目画布主文件路径。 */
    const canvasPath = join(projectRoot, '.proma/design/canvas.json')
    /** revision 1 作为模拟崩溃遗留的固定 tmp。 */
    const revisionOne = store.mutate('project-1', 0, [{
      type: 'set-viewport',
      viewport: { x: 10, y: 10, zoom: 1 },
    }])
    renameSync(canvasPath, `${canvasPath}.tmp`)

    /** 首次从 tmp 恢复并安全提升的快照。 */
    const recoveredTemporary = store.load('project-1')
    /** 提升完成后立即记录固定 tmp 是否已被消费。 */
    const temporaryStillExists = existsSync(`${canvasPath}.tmp`)
    /** 正常保存 revision 2。 */
    const revisionTwo = store.mutate('project-1', recoveredTemporary.document.revision, [{
      type: 'set-viewport',
      viewport: { x: 20, y: 20, zoom: 2 },
    }])
    /** 正常保存 revision 3，使安全备份固定为 revision 2。 */
    const revisionThree = store.mutate('project-1', revisionTwo.revision, [{
      type: 'set-viewport',
      viewport: { x: 30, y: 30, zoom: 3 },
    }])
    writeFileSync(canvasPath, '{ broken again', 'utf8')

    /** 主文件再次损坏后的恢复结果必须来自最新 backup。 */
    const recoveredBackup = store.load('project-1')
    expect(revisionOne.revision).toBe(1)
    expect(recoveredTemporary.recoveredFrom).toBe('tmp')
    expect(temporaryStillExists).toBe(false)
    expect(revisionThree.revision).toBe(3)
    expect(recoveredBackup.recoveredFrom).toBe('backup')
    expect(recoveredBackup.document.revision).toBe(2)
    expect(recoveredBackup.document.viewport).toEqual({ x: 20, y: 20, zoom: 2 })
  })

  test('Given stale revision When 只移动节点 Then 在最新 revision 上重放', () => {
    /** 支持 revision 重放的存储。 */
    const store = createStore()
    /** 首次写入的合法画布节点。 */
    const node = createNode()
    /** revision 0 上写入节点的结果。 */
    const first = store.mutate('project-1', 0, [{ type: 'upsert-nodes', nodes: [node] }])
    /** 同样基于 revision 0 的可重放位置更新。 */
    const merged = store.mutate('project-1', 0, [{
      type: 'move-nodes',
      positions: [{ nodeId: node.id, position: { x: 40, y: 50 } }],
    }])

    expect(first.revision).toBe(1)
    expect(merged.revision).toBe(2)
    expect(merged.nodes[0]?.position).toEqual({ x: 40, y: 50 })
  })

  test('Given stale revision When 删除节点 Then 拒绝覆盖新结构', () => {
    /** 拒绝陈旧结构写入的存储。 */
    const store = createStore()
    /** 已由另一个窗口写入的合法节点。 */
    const node = createNode()
    store.mutate('project-1', 0, [{ type: 'upsert-nodes', nodes: [node] }])

    expect(() => store.mutate('project-1', 0, [{
      type: 'remove-nodes',
      nodeIds: [node.id],
    }])).toThrow('DESIGN_REVISION_CONFLICT')
  })

  test('Given stale revision 的移动目标已被删除 When 保存 Then 冲突且 revision 不递增', () => {
    /** 用于模拟另一窗口删除节点的存储。 */
    const store = createStore()
    /** revision 1 中存在、revision 2 中已删除的节点。 */
    const node = createNode()
    store.mutate('project-1', 0, [{ type: 'upsert-nodes', nodes: [node] }])
    store.mutate('project-1', 1, [{ type: 'remove-nodes', nodeIds: [node.id] }])

    expect(() => store.mutate('project-1', 1, [{
      type: 'move-nodes',
      positions: [{ nodeId: node.id, position: { x: 90, y: 100 } }],
    }])).toThrow('DESIGN_REVISION_CONFLICT')
    expect(store.load('project-1').document.revision).toBe(2)
  })

  test('Given fresh revision 的移动目标不存在 When 保存 Then 拒绝非法 mutation 且不落盘', () => {
    /** 尚无节点的全新项目存储。 */
    const store = createStore()

    expect(() => store.mutate('project-1', 0, [{
      type: 'move-nodes',
      positions: [{ nodeId: 'missing-node', position: { x: 10, y: 20 } }],
    }])).toThrow('DESIGN_DOCUMENT_INVALID')
    expect(existsSync(join(projectRoot, '.proma/design/canvas.json'))).toBe(false)
  })

  test('Given stale revision When 只更新视口 Then 仍在最新 revision 上重放', () => {
    /** 支持非结构视口重放的存储。 */
    const store = createStore()
    /** 另一窗口先写入的结构 mutation。 */
    const node = createNode()
    store.mutate('project-1', 0, [{ type: 'upsert-nodes', nodes: [node] }])

    /** 基于 revision 0 重放后的最新文档。 */
    const rebased = store.mutate('project-1', 0, [{
      type: 'set-viewport',
      viewport: { x: 30, y: 40, zoom: 2 },
    }])
    expect(rebased.revision).toBe(2)
    expect(rebased.viewport).toEqual({ x: 30, y: 40, zoom: 2 })
    expect(rebased.nodes).toEqual([node])
  })

  test('Given expected revision 超前于磁盘 When 保存可重放 mutation Then 仍拒绝覆盖恢复状态', () => {
    /** 当前磁盘仅有 revision 1 的存储。 */
    const store = createStore()
    /** 用于建立当前 revision 的合法节点。 */
    const node = createNode()
    store.mutate('project-1', 0, [{ type: 'upsert-nodes', nodes: [node] }])

    expect(() => store.mutate('project-1', 5, [{
      type: 'set-viewport',
      viewport: { x: 1, y: 2, zoom: 1.5 },
    }])).toThrow('DESIGN_REVISION_CONFLICT')
    expect(store.load('project-1').document.revision).toBe(1)
  })

  test('Given mutate 内部首次发现 tmp 恢复 When expected revision 恰好相等 Then 要求 reload 且不继续写', () => {
    /** 用于验证恢复与 mutation 必须分成两次用户操作的存储。 */
    const store = createStore()
    /** 当前项目画布主文件路径。 */
    const canvasPath = join(projectRoot, '.proma/design/canvas.json')
    /** 建立 revision 1 后模拟主文件 rename 前后的崩溃残留。 */
    store.mutate('project-1', 0, [{
      type: 'set-viewport',
      viewport: { x: 10, y: 10, zoom: 1 },
    }])
    renameSync(canvasPath, `${canvasPath}.tmp`)

    expect(() => store.mutate('project-1', 1, [{
      type: 'set-viewport',
      viewport: { x: 99, y: 99, zoom: 4 },
    }])).toThrow('DESIGN_RECOVERY_REQUIRED')
    expect(existsSync(`${canvasPath}.tmp`)).toBe(false)
    /** 恢复提交只保留 revision 1，不应用本次 mutation。 */
    const restored = store.load('project-1').document
    expect(restored.revision).toBe(1)
    expect(restored.viewport).toEqual({ x: 10, y: 10, zoom: 1 })
  })

  test('Given 项目 .proma 指向根外目录 When 加载或保存 Then fail closed 且不写外部目录', () => {
    /** 模拟攻击者控制的项目根外目录。 */
    const outsideRoot = mkdtempSync(join(tmpdir(), 'proma-design-outside-'))
    try {
      symlinkSync(outsideRoot, join(projectRoot, '.proma'), 'dir')
      /** 路径解析仍指向项目词法范围内的存储。 */
      const store = createStore()

      expect(() => store.load('project-1')).toThrow('DESIGN_PATH_UNSAFE')
      expect(() => store.mutate('project-1', 0, [])).toThrow('DESIGN_PATH_UNSAFE')
      expect(existsSync(join(outsideRoot, 'design'))).toBe(false)
      expect(existsSync(join(outsideRoot, 'design/canvas.json'))).toBe(false)
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  test('Given mutation 产生悬空素材引用 When 保存 Then schema 校验拒绝落盘', () => {
    /** 使用统一 schema 校验的存储。 */
    const store = createStore()
    /** 引用了不存在素材的非法节点。 */
    const invalidNode: DesignCanvasNode = {
      ...createNode(),
      kind: 'asset',
      assetId: 'missing-asset',
      jobId: undefined,
    }

    expect(() => store.mutate('project-1', 0, [{
      type: 'upsert-nodes',
      nodes: [invalidNode],
    }])).toThrow('DESIGN_DOCUMENT_INVALID')
    expect(existsSync(join(projectRoot, '.proma/design/canvas.json'))).toBe(false)
  })

  test('Given 空 mutation When 保存 Then 返回当前文档且不创建文件或递增 revision', () => {
    /** 尚无持久化画布的存储。 */
    const store = createStore()
    /** 空 mutation 返回的当前内存文档。 */
    const unchanged = store.mutate('project-1', 0, [])

    expect(unchanged.revision).toBe(0)
    expect(existsSync(join(projectRoot, '.proma/design/canvas.json'))).toBe(false)
  })
})

describe('Design 局部有序 patch', () => {
  test('Given 中间实体被删除 When 主进程应用 inverse patch Then 精确恢复数组顺序', () => {
    /** 批注数组顺序用于验证主进程与 renderer 使用同一有序语义。 */
    const document = createEmptyDesignDocument('project-1', 100)
    document.annotations = ['a1', 'a2', 'a3'].map((id, index) => ({
      id,
      kind: 'arrow' as const,
      from: { x: index, y: index },
      to: { x: index + 1, y: index + 1 },
      color: '#000000',
      width: 1,
      createdAt: index,
    }))
    /** 删除中间批注的局部 patch。 */
    const removed = applyDesignMutations(document, [{
      type: 'patch-annotations',
      removeIds: ['a2'],
      upserts: [],
    }])
    /** 只携带原实体和索引的 inverse patch。 */
    const restored = applyDesignMutations(removed, [{
      type: 'patch-annotations',
      removeIds: [],
      upserts: [{ entity: document.annotations[1]!, index: 1 }],
    }])

    expect(restored).toEqual(document)
  })
})

describe('Design 画布 schema 校验', () => {
  test('Given 合法空文档 When 校验 Then 接受', () => {
    expect(isDesignCanvasDocument(createEmptyDesignDocument('project-1', 100), 'project-1')).toBe(true)
  })

  test('Given 非法缩放、重复 ID 或路径穿越 When 校验 Then 拒绝', () => {
    /** 用于生成各类非法变体的合法基础文档。 */
    const valid = createEmptyDesignDocument('project-1', 100)
    /** 超出画布允许范围的缩放文档。 */
    const invalidZoom = { ...valid, viewport: { x: 0, y: 0, zoom: 9 } }
    /** 含重复节点 ID 的文档。 */
    const duplicateIds = {
      ...valid,
      nodes: [
        { id: 'same', kind: 'job', jobId: 'job-1', position: { x: 0, y: 0 }, width: 1, height: 1, zIndex: 0 },
        { id: 'same', kind: 'job', jobId: 'job-2', position: { x: 1, y: 1 }, width: 1, height: 1, zIndex: 1 },
      ],
    }
    /** 试图逃逸受管目录的素材文档。 */
    const traversingAsset = {
      ...valid,
      assets: [{
        id: 'asset-1',
        filename: 'secret.png',
        relativePath: '../secret.png',
        thumbnailRelativePath: 'thumbnails/secret.webp',
        mediaType: 'image/png',
        width: 10,
        height: 10,
        byteSize: 10,
        sha256: 'abc',
        createdAt: 100,
      }],
    }
    /** 跨平台读取时也必须拒绝的 Windows 绝对素材路径。 */
    const windowsAbsoluteAsset = {
      ...traversingAsset,
      assets: [{
        ...traversingAsset.assets[0],
        relativePath: 'C:\\outside\\secret.png',
      }],
    }

    expect(isDesignCanvasDocument(invalidZoom, 'project-1')).toBe(false)
    expect(isDesignCanvasDocument(duplicateIds, 'project-1')).toBe(false)
    expect(isDesignCanvasDocument(traversingAsset, 'project-1')).toBe(false)
    expect(isDesignCanvasDocument(windowsAbsoluteAsset, 'project-1')).toBe(false)
  })

  test('Given 节点同时包含或同时缺少业务引用 When 校验 Then 拒绝 kind 歧义', () => {
    /** 用于创建节点引用变体的合法空文档。 */
    const valid = createEmptyDesignDocument('project-1', 100)
    /** 同时携带 assetId 和 jobId 的歧义节点。 */
    const bothReferences = {
      ...valid,
      nodes: [{
        ...createStandaloneNode(),
        kind: 'asset',
        assetId: 'asset-1',
        jobId: 'job-1',
      }],
    }
    /** 未携带对应业务 ID 的 job 节点。 */
    const missingReference = {
      ...valid,
      nodes: [{
        ...createStandaloneNode(),
        kind: 'job',
      }],
    }

    expect(isDesignCanvasDocument(bothReferences, 'project-1')).toBe(false)
    expect(isDesignCanvasDocument(missingReference, 'project-1')).toBe(false)
  })

  test('Given 分组成员关系不是双向一致 When 校验 Then 拒绝悬空归属', () => {
    /** 分组引用节点、但节点没有 groupId 的文档。 */
    const groupOnly = createGroupedDocument(undefined, ['node-1'])
    /** 节点引用分组、但分组没有列出节点的文档。 */
    const nodeOnly = createGroupedDocument('group-1', [])

    expect(isDesignCanvasDocument(groupOnly, 'project-1')).toBe(false)
    expect(isDesignCanvasDocument(nodeOnly, 'project-1')).toBe(false)
  })

  test('Given 素材路径不在固定子目录或使用 drive-relative When 校验 Then 拒绝', () => {
    /** 用于生成路径变体的合法素材文档。 */
    const valid = createAssetDocument('assets/image.png', 'thumbnails/image.webp')
    /** 正式素材试图放到 Design 根其他位置的文档。 */
    const wrongAssetPrefix = createAssetDocument('image.png', 'thumbnails/image.webp')
    /** 缩略图试图放到缓存根其他位置的文档。 */
    const wrongThumbnailPrefix = createAssetDocument('assets/image.png', 'image.webp')
    /** Windows drive-relative 在非 Windows 主机也必须拒绝。 */
    const driveRelative = createAssetDocument('C:image.png', 'thumbnails/image.webp')
    /** 持久化 JSON 中的 Windows 分隔符在所有平台都必须拒绝。 */
    const backslashSeparated = createAssetDocument('assets\\image.png', 'thumbnails/image.webp')

    expect(isDesignCanvasDocument(valid, 'project-1')).toBe(true)
    expect(isDesignCanvasDocument(wrongAssetPrefix, 'project-1')).toBe(false)
    expect(isDesignCanvasDocument(wrongThumbnailPrefix, 'project-1')).toBe(false)
    expect(isDesignCanvasDocument(driveRelative, 'project-1')).toBe(false)
    expect(isDesignCanvasDocument(backslashSeparated, 'project-1')).toBe(false)
  })

  test('Given 素材父版本自环或任意环 When 校验 Then 拒绝循环版本关系', () => {
    /** 单一素材引用自身的非法文档。 */
    const selfCycle = createAssetVersions([
      createAssetRecord('asset-1', 'assets/one.png', 'thumbnails/one.webp', 'asset-1'),
    ])
    /** 两个素材互相作为父版本的非法文档。 */
    const twoNodeCycle = createAssetVersions([
      createAssetRecord('asset-1', 'assets/one.png', 'thumbnails/one.webp', 'asset-2'),
      createAssetRecord('asset-2', 'assets/two.png', 'thumbnails/two.webp', 'asset-1'),
    ])

    expect(isDesignCanvasDocument(selfCycle, 'project-1')).toBe(false)
    expect(isDesignCanvasDocument(twoNodeCycle, 'project-1')).toBe(false)
  })

  test('Given 两条素材元数据共享正式路径或缩略图路径 When 校验 Then 拒绝路径别名', () => {
    /** 两个素材指向同一正式文件的非法文档。 */
    const duplicateAssetPath = createAssetVersions([
      createAssetRecord('asset-1', 'assets/shared.png', 'thumbnails/one.webp'),
      createAssetRecord('asset-2', 'assets/shared.png', 'thumbnails/two.webp'),
    ])
    /** 两个素材指向同一缩略图文件的非法文档。 */
    const duplicateThumbnailPath = createAssetVersions([
      createAssetRecord('asset-1', 'assets/one.png', 'thumbnails/shared.webp'),
      createAssetRecord('asset-2', 'assets/two.png', 'thumbnails/shared.webp'),
    ])

    expect(isDesignCanvasDocument(duplicateAssetPath, 'project-1')).toBe(false)
    expect(isDesignCanvasDocument(duplicateThumbnailPath, 'project-1')).toBe(false)
  })
})

/** 创建不含业务引用的节点基础字段，用于 schema 负向测试。 */
function createStandaloneNode() {
  return {
    id: 'node-schema',
    position: { x: 0, y: 0 },
    width: 100,
    height: 100,
    zIndex: 0,
  }
}

/** 创建包含单节点和单分组的文档，用于双向归属校验。 */
function createGroupedDocument(groupId: string | undefined, nodeIds: string[]) {
  /** 合法空文档基础字段。 */
  const document = createEmptyDesignDocument('project-1', 100)
  return {
    ...document,
    nodes: [{
      ...createStandaloneNode(),
      id: 'node-1',
      kind: 'job',
      jobId: 'job-1',
      ...(groupId ? { groupId } : {}),
    }],
    groups: [{ id: 'group-1', name: '分组', nodeIds }],
  }
}

/** 创建单一合法素材文档，并允许替换两个受管相对路径。 */
function createAssetDocument(relativePath: string, thumbnailRelativePath: string) {
  return createAssetVersions([
    createAssetRecord('asset-1', relativePath, thumbnailRelativePath),
  ])
}

/** 创建包含给定素材版本记录的画布文档。 */
function createAssetVersions(assets: object[]) {
  /** 合法空文档基础字段。 */
  const document = createEmptyDesignDocument('project-1', 100)
  return { ...document, assets }
}

/** 创建一条可组合父版本关系和路径变体的素材记录。 */
function createAssetRecord(
  id: string,
  relativePath: string,
  thumbnailRelativePath: string,
  parentAssetId?: string,
) {
  return {
    id,
    filename: `${id}.png`,
    relativePath,
    thumbnailRelativePath,
    mediaType: 'image/png',
    width: 10,
    height: 10,
    byteSize: 10,
    sha256: 'abc',
    createdAt: 100,
    ...(parentAssetId ? { parentAssetId } : {}),
  }
}
