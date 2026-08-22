import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesignCanvasNode } from '@proma/shared'
import { createEmptyDesignDocument } from '@proma/shared'
import { createDesignPathResolver } from './design-paths'
import { createDesignStore, isDesignCanvasDocument } from './design-store'

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

  test('Given 损坏主文件和有效备份 When 加载 Then 从备份恢复并标记来源', () => {
    /** 使用真实 safe-file 恢复链的存储。 */
    const store = createStore()
    /** 当前项目画布主文件路径。 */
    const canvasPath = join(projectRoot, '.proma/design/canvas.json')
    store.mutate('project-1', 0, [])
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
