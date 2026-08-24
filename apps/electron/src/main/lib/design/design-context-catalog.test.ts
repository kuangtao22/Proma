import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesignPathResolver } from './design-paths'
import { createDesignPathResolver } from './design-paths'
import { DesignContextCatalog } from './design-context-catalog'

describe('DesignContextCatalog', () => {
  /** 每个测试独占的项目与配置根目录。 */
  let tempRoot: string
  /** 被测项目的可信根目录。 */
  let projectRoot: string
  /** 被测目录使用的生产路径解析器。 */
  let pathResolver: DesignPathResolver
  /** 使用确定性 ID 和时间的上下文目录。 */
  let catalog: DesignContextCatalog
  /** 下一条由主进程生成的稳定 ID 序号。 */
  let nextId: number

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'proma-design-context-'))
    projectRoot = join(tempRoot, 'project')
    mkdirSync(projectRoot, { recursive: true })
    pathResolver = createDesignPathResolver({
      getWorkspace: (projectId) => projectId === 'project-1'
        ? {
            id: 'project-1',
            name: '项目',
            slug: 'project-slug',
            projectRootPath: projectRoot,
            createdAt: 1,
            updatedAt: 1,
          }
        : undefined,
      getProjectFilesPath: () => projectRoot,
      getConfigDir: () => join(tempRoot, 'config'),
    })
    nextId = 1
    catalog = new DesignContextCatalog({
      pathResolver,
      now: () => 100,
      createId: () => `context-${nextId++}`,
    })
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('Given 空项目 When 新建 Markdown 上下文 Then 文档与 manifest 都写入受管目录', () => {
    /** 新建后的可移植文档条目。 */
    const entry = catalog.upsertDocument({
      projectId: 'project-1',
      category: 'brand',
      title: '品牌规范',
      tags: ['官网'],
      markdown: '# Brand',
    })
    /** 上下文目录的可信项目路径。 */
    const paths = pathResolver.resolve('project-1')

    expect(entry.relativePath).toBe(`documents/${entry.id}.md`)
    expect(readFileSync(join(paths.contextRoot, entry.relativePath!), 'utf8')).toBe('# Brand')
    expect(catalog.list('project-1')).toEqual([entry])
    expect(existsSync(paths.contextManifestPath)).toBe(true)
  })

  test('Given 素材已登记为视觉标准 When 删除目录条目 Then 只删除 manifest 引用而不删除正式素材', () => {
    /** 模拟已存在的正式 Design 素材。 */
    const paths = pathResolver.resolve('project-1')
    mkdirSync(paths.assetsDir, { recursive: true })
    const assetPath = join(paths.assetsDir, 'asset-1.png')
    writeFileSync(assetPath, 'image')
    /** 登记为视觉标准的素材条目。 */
    const entry = catalog.registerAsset({
      projectId: 'project-1',
      assetId: 'asset-1',
      category: 'reference',
      title: '首页色彩',
      tags: [],
    })

    catalog.delete('project-1', entry.id, [])

    expect(existsSync(assetPath)).toBe(true)
    expect(catalog.list('project-1')).toEqual([])
  })

  test('Given 主进程选择 Markdown When 导入上下文 Then 复制到受管 documents 且不保存来源绝对路径', () => {
    /** 文件选择器返回的项目外 Markdown 普通文件。 */
    const sourcePath = join(tempRoot, 'picked.md')
    writeFileSync(sourcePath, '# 第一章')

    /** 复制进入受管目录后的条目。 */
    const entry = catalog.importDocument({
      projectId: 'project-1',
      category: 'story',
      tags: ['第一章'],
      sourcePath,
    })
    /** 序列化结果用于验证来源路径没有进入持久化字段。 */
    const encoded = JSON.stringify(entry)

    expect(entry.relativePath).toBe(`documents/${entry.id}.md`)
    expect(readFileSync(join(pathResolver.resolve('project-1').contextRoot, entry.relativePath!), 'utf8')).toBe('# 第一章')
    expect(encoded).not.toContain(sourcePath)
  })

  test('Given manifest 主文件损坏 When 读取目录 Then 从备份恢复合法清单', () => {
    /** 初次写入用于建立主 manifest。 */
    const entry = catalog.upsertDocument({
      projectId: 'project-1',
      category: 'brand',
      title: '初版',
      tags: [],
      markdown: '# Brand',
    })
    catalog.updateMetadata({
      projectId: 'project-1',
      entryId: entry.id,
      category: 'brand',
      title: '新版',
      tags: [],
    })
    /** 人为损坏主文件，保留原子写生成的上一版备份。 */
    const paths = pathResolver.resolve('project-1')
    writeFileSync(paths.contextManifestPath, '{broken')

    expect(catalog.list('project-1')[0]?.title).toBe('初版')
  })

  test('Given manifest 项目 ID 不匹配 When 读取目录 Then 明确拒绝', () => {
    /** 构造上下文目录及伪造的其他项目 manifest。 */
    const paths = pathResolver.resolve('project-1')
    mkdirSync(paths.contextRoot, { recursive: true })
    writeFileSync(paths.contextManifestPath, JSON.stringify({
      schemaVersion: 1,
      projectId: 'project-other',
      entries: [],
      updatedAt: 100,
    }))

    expect(() => catalog.list('project-1')).toThrow('创作上下文清单无效')
  })

  test('Given 文档被符号链接置换 When 删除条目 Then 拒绝且保留 manifest 引用', () => {
    /** 新建后把受管文档叶子替换为项目外符号链接。 */
    const entry = catalog.upsertDocument({
      projectId: 'project-1',
      category: 'code',
      title: '界面说明',
      tags: [],
      markdown: '# UI',
    })
    const documentPath = join(pathResolver.resolve('project-1').contextRoot, entry.relativePath!)
    const outsidePath = join(tempRoot, 'outside.md')
    writeFileSync(outsidePath, '# Secret')
    unlinkSync(documentPath)
    symlinkSync(outsidePath, documentPath)

    expect(() => catalog.delete('project-1', entry.id, [])).toThrow('创作上下文文档不是普通文件')
    expect(catalog.list('project-1').map((item) => item.id)).toContain(entry.id)
  })

  test('Given context 父目录被符号链接置换 When 读取 Then 拒绝越过项目边界', () => {
    /** 先创建一份合法上下文及其受管目录。 */
    const entry = catalog.upsertDocument({
      projectId: 'project-1',
      category: 'brand',
      title: '品牌',
      tags: [],
      markdown: '# Brand',
    })
    const paths = pathResolver.resolve('project-1')
    /** 把完整 context 目录移到项目外，再用同名符号链接置换父目录。 */
    const outsideContext = join(tempRoot, 'outside-context')
    renameSync(paths.contextRoot, outsideContext)
    symlinkSync(outsideContext, paths.contextRoot)

    expect(() => catalog.readDocument('project-1', entry.id)).toThrow('创作上下文目录不是实际目录')
  })

  test('Given 项目根被符号链接置换 When 写入 Then 不在替代目录创建上下文', () => {
    /** 把路径解析器信任的项目根替换为指向另一个物理目录的符号链接。 */
    const actualRoot = join(tempRoot, 'actual-project')
    renameSync(projectRoot, actualRoot)
    symlinkSync(actualRoot, projectRoot)

    expect(() => catalog.upsertDocument({
      projectId: 'project-1',
      category: 'brand',
      title: '品牌',
      tags: [],
      markdown: '# Brand',
    })).toThrow('创作上下文项目根不是实际目录')
  })

  test('Given 条目被任务审计引用 When 删除 Then 明确拒绝并保留资料', () => {
    /** 需要受引用保护的文档条目。 */
    const entry = catalog.upsertDocument({
      projectId: 'project-1',
      category: 'character',
      title: '角色标准',
      tags: [],
      markdown: '# Character',
    })

    expect(() => catalog.delete('project-1', entry.id, ['job-1'])).toThrow('创作上下文仍被任务引用: job-1')
    expect(catalog.list('project-1').map((item) => item.id)).toContain(entry.id)
  })

  test('Given 同一文档重复更新 When 保存 Then 沿用原 ID 且不生成第二个文件', () => {
    /** 首次创建的受管文档。 */
    const initial = catalog.upsertDocument({
      projectId: 'project-1',
      category: 'product',
      title: '产品说明',
      tags: [],
      markdown: '# V1',
    })
    /** 使用同一 ID 更新文档内容与元数据。 */
    const updated = catalog.upsertDocument({
      projectId: 'project-1',
      entryId: initial.id,
      category: 'product',
      title: '产品说明 V2',
      tags: ['核心'],
      markdown: '# V2',
    })

    expect(updated.id).toBe(initial.id)
    expect(catalog.list('project-1')).toEqual([updated])
    expect(readFileSync(join(pathResolver.resolve('project-1').contextRoot, updated.relativePath!), 'utf8')).toBe('# V2')
  })

  test('Given 标题与标签包含冗余空白 When 保存 Then 清洗、去重并可按关键词查询', () => {
    /** 输入包含重复和空标签的上下文文档。 */
    const entry = catalog.upsertDocument({
      projectId: 'project-1',
      category: 'scene',
      title: '  雨夜街道  ',
      tags: [' 夜景 ', '夜景', '', '  '],
      markdown: '# Scene',
    })

    expect(entry.title).toBe('雨夜街道')
    expect(entry.tags).toEqual(['夜景'])
    expect(catalog.list('project-1', '雨夜')).toEqual([entry])
    expect(catalog.readDocument('project-1', entry.id)).toBe('# Scene')
  })

  test('Given Markdown 或元数据超过上限 When 保存 Then 在写盘前拒绝', () => {
    /** 超过 256 KiB 的 UTF-8 文档内容。 */
    const oversizedMarkdown = 'a'.repeat(256 * 1024 + 1)
    /** 超过最多 20 项的标签集合。 */
    const oversizedTags = Array.from({ length: 21 }, (_, index) => `tag-${index}`)

    expect(() => catalog.upsertDocument({
      projectId: 'project-1',
      category: 'story',
      title: '故事',
      tags: [],
      markdown: oversizedMarkdown,
    })).toThrow('Markdown 不能超过 256 KiB')
    expect(() => catalog.upsertDocument({
      projectId: 'project-1',
      category: 'story',
      title: '故事',
      tags: oversizedTags,
      markdown: '# Story',
    })).toThrow('标签最多 20 个')
    expect(existsSync(pathResolver.resolve('project-1').contextManifestPath)).toBe(false)
  })

  test('Given 文件选择器返回符号链接 When 导入 Then 拒绝读取链接目标', () => {
    /** 项目外的真实 Markdown 与指向它的选择器符号链接。 */
    const outsidePath = join(tempRoot, 'outside-source.md')
    const sourceLink = join(tempRoot, 'picked-link.md')
    writeFileSync(outsidePath, '# Outside')
    symlinkSync(outsidePath, sourceLink)

    expect(() => catalog.importDocument({
      projectId: 'project-1',
      category: 'reference',
      tags: [],
      sourcePath: sourceLink,
    })).toThrow('导入文件必须是普通 Markdown 文件')
  })

  test('Given 素材已登记 When 查询引用 Then 只按当前项目的 assetId 返回结果', () => {
    catalog.registerAsset({
      projectId: 'project-1',
      assetId: 'asset-1',
      category: 'continuity',
      title: '角色连续性标准',
      tags: [],
    })

    expect(catalog.isAssetReferenced('project-1', 'asset-1')).toBe(true)
    expect(catalog.isAssetReferenced('project-1', 'asset-missing')).toBe(false)
  })

  test('Given 条目或素材 ID 含路径语义 When 写入 Then 在解析受管文件前拒绝', () => {
    expect(() => catalog.upsertDocument({
      projectId: 'project-1',
      entryId: '../escape',
      category: 'code',
      title: '非法条目',
      tags: [],
      markdown: '# Unsafe',
    })).toThrow('创作上下文 ID 非法')
    expect(() => catalog.registerAsset({
      projectId: 'project-1',
      assetId: '../asset',
      category: 'reference',
      title: '非法素材',
      tags: [],
    })).toThrow('Design 素材 ID 非法')
  })
})
