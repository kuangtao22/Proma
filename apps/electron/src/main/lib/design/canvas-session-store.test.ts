import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesignPathResolver } from './design-paths'
import { CanvasSessionStore } from './canvas-session-store'

describe('CanvasSessionStore', () => {
  /** 每个测试独占的临时项目根。 */
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proma-canvas-session-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** 创建固定时间和 ID 的测试 store。 */
  function createStore(projectIds: readonly string[] = ['project-1']): CanvasSessionStore {
    /** 项目路径解析器只认当前测试声明的项目。 */
    const pathResolver = createDesignPathResolver({
      getWorkspace: (projectId) => projectIds.includes(projectId) ? {
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
    return new CanvasSessionStore({
      pathResolver,
      now: () => 100,
      createId: () => 'canvas-created',
    })
  }

  test('Given 旧 Design 画布 When 投影两次 Then 只产生一个默认 Canvas', () => {
    const store = createStore()
    /** 旧画布路径用于触发兼容投影。 */
    const legacyPath = join(root, 'project-1', '.proma', 'design', 'canvas.json')
    mkdirSync(join(root, 'project-1', '.proma', 'design'), { recursive: true })
    writeFileSync(legacyPath, '{}', 'utf8')

    expect(store.ensureLegacySession('project-1')).toEqual({
      id: 'legacy-design',
      projectId: 'project-1',
      title: '默认设计画布',
      archived: false,
      createdAt: 100,
      updatedAt: 100,
    })
    expect(store.ensureLegacySession('project-1')?.id).toBe('legacy-design')
    expect(store.list({ projectId: 'project-1' })).toHaveLength(1)
  })

  test('Given 项目 When 新建重命名归档 Then 原子索引保存稳定公开字段', () => {
    const store = createStore()
    const created = store.create({ projectId: 'project-1', title: ' App 页面设计 ' })
    expect(created).toMatchObject({
      id: 'canvas-created',
      projectId: 'project-1',
      title: 'App 页面设计',
      archived: false,
    })

    const updated = store.update({
      projectId: 'project-1',
      canvasId: created.id,
      title: 'App 页面视觉',
      archived: true,
    })
    expect(updated).toMatchObject({ title: 'App 页面视觉', archived: true })
    expect(store.list({ projectId: 'project-1', archived: false })).toEqual([])
    expect(store.list({ projectId: 'project-1', archived: true })).toHaveLength(1)

    /** 项目内索引路径必须与其它项目完全隔离。 */
    const indexPath = join(root, 'project-1', '.proma', 'design', 'canvases', 'index.json')
    expect(existsSync(indexPath)).toBe(true)
    expect(JSON.parse(readFileSync(indexPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      projectId: 'project-1',
      sessions: [{ id: 'canvas-created', storageKind: 'native' }],
    })
    expect(existsSync(`${indexPath}.tmp`)).toBe(false)
  })

  test('Given 确定性 Canvas ID When Store 重建后重放创建 Then 返回同一持久记录且不重复索引', () => {
    const canvasId = `agent-canvas-${'a'.repeat(64)}`
    const firstStore = createStore()
    const firstResult = firstStore.createWithIdOnce({ projectId: 'project-1', canvasId, title: 'Agent 画布' })
    const replayStore = createStore()
    const replayResult = replayStore.createWithIdOnce({ projectId: 'project-1', canvasId, title: '重放标题不得覆盖' })

    expect(firstResult.created).toBe(true)
    expect(replayResult).toEqual({ session: firstResult.session, created: false })
    expect(replayStore.list({ projectId: 'project-1' })).toEqual([firstResult.session])
    expect(replayStore.createWithId({ projectId: 'project-1', canvasId })).toEqual(firstResult.session)
  })

  test('Given 原生 Canvas 已创建内容与缓存 When 删除 Then 索引、正式目录和缓存目录一并清理', () => {
    const store = createStore()
    const created = store.create({ projectId: 'project-1', title: '待删除 Canvas' })
    /** 模拟已经落盘的画布文档和可重建缓存。 */
    const canvasRoot = join(root, 'project-1', '.proma', 'design', 'canvases', created.id)
    const cacheRoot = join(root, '.config', 'design-cache', 'project-1', 'canvases', created.id)
    mkdirSync(canvasRoot, { recursive: true })
    mkdirSync(cacheRoot, { recursive: true })
    writeFileSync(join(canvasRoot, 'canvas.json'), '{}', 'utf8')
    writeFileSync(join(cacheRoot, 'cache.json'), '{}', 'utf8')

    expect(store.delete({ projectId: 'project-1', canvasId: created.id })).toEqual(created)
    expect(store.list({ projectId: 'project-1' })).toEqual([])
    expect(existsSync(canvasRoot)).toBe(false)
    expect(existsSync(cacheRoot)).toBe(false)
  })

  test('Given legacy Design Canvas When 删除 Then 拒绝且保留兼容索引与旧画布', () => {
    const store = createStore()
    const legacyPath = join(root, 'project-1', '.proma', 'design', 'canvas.json')
    mkdirSync(join(root, 'project-1', '.proma', 'design'), { recursive: true })
    writeFileSync(legacyPath, '{}', 'utf8')
    store.ensureLegacySession('project-1')

    expect(() => store.delete({ projectId: 'project-1', canvasId: 'legacy-design' }))
      .toThrow('旧版默认设计画布不能删除')
    expect(store.list({ projectId: 'project-1' })).toHaveLength(1)
    expect(existsSync(legacyPath)).toBe(true)
  })

  test('Given 损坏索引 When 列表 Then 明确失败且不覆盖主文件', () => {
    const store = createStore()
    /** 已损坏主文件是需要显式处理的权威事实。 */
    const indexPath = join(root, 'project-1', '.proma', 'design', 'canvases', 'index.json')
    mkdirSync(join(root, 'project-1', '.proma', 'design', 'canvases'), { recursive: true })
    writeFileSync(indexPath, '{broken', 'utf8')

    expect(() => store.list({ projectId: 'project-1' })).toThrow('Canvas 会话索引 JSON 损坏')
    expect(readFileSync(indexPath, 'utf8')).toBe('{broken')
  })

  test('Given 非法标题、重复 ID 和空更新 When 写入 Then 在原子提交前拒绝', () => {
    const store = createStore()
    expect(() => store.create({ projectId: 'project-1', title: '   ' })).toThrow('标题不能为空')
    const created = store.create({ projectId: 'project-1', title: 'Canvas' })
    expect(() => store.create({ projectId: 'project-1', title: '重复 Canvas' })).toThrow('ID 非法或重复')
    expect(() => store.update({ projectId: 'project-1', canvasId: created.id })).toThrow('至少需要一个字段')
  })

  test('Given 两个项目 When 分别创建 Canvas Then 索引与列表互不串线', () => {
    const store = createStore(['project-1', 'project-2'])
    const projectOne = store.create({ projectId: 'project-1', title: '项目一' })
    /** 第二个项目使用独立 store ID 生成器，模拟真实 randomUUID 不重复。 */
    const secondStore = new CanvasSessionStore({
      pathResolver: createDesignPathResolver({
        getWorkspace: (projectId) => ['project-1', 'project-2'].includes(projectId) ? {
          id: projectId,
          name: '项目',
          slug: projectId,
          createdAt: 1,
          updatedAt: 1,
        } : undefined,
        getProjectFilesPath: (workspaceSlug) => join(root, workspaceSlug),
        getConfigDir: () => join(root, '.config'),
      }),
      now: () => 200,
      createId: () => 'canvas-project-2',
    })
    const projectTwo = secondStore.create({ projectId: 'project-2', title: '项目二' })

    expect(store.list({ projectId: 'project-1' })).toEqual([projectOne])
    expect(secondStore.list({ projectId: 'project-2' })).toEqual([projectTwo])
    expect(existsSync(join(root, 'project-1', '.proma', 'design', 'canvases', 'index.json'))).toBe(true)
    expect(existsSync(join(root, 'project-2', '.proma', 'design', 'canvases', 'index.json'))).toBe(true)
  })

  test('Given 索引包含未知字段或跨项目记录 When 读取 Then 严格拒绝', () => {
    const store = createStore()
    /** 固定索引目录用于逐个验证损坏 schema。 */
    const indexPath = join(root, 'project-1', '.proma', 'design', 'canvases', 'index.json')
    mkdirSync(join(root, 'project-1', '.proma', 'design', 'canvases'), { recursive: true })
    writeFileSync(indexPath, JSON.stringify({
      schemaVersion: 1,
      projectId: 'project-1',
      sessions: [],
      updatedAt: 1,
      credentials: 'forged',
    }))
    expect(() => store.list({ projectId: 'project-1' })).toThrow('根字段无效')

    writeFileSync(indexPath, JSON.stringify({
      schemaVersion: 1,
      projectId: 'project-1',
      sessions: [{
        id: 'canvas-1',
        projectId: 'project-2',
        title: '越界',
        archived: false,
        storageKind: 'native',
        createdAt: 1,
        updatedAt: 1,
      }],
      updatedAt: 1,
    }))
    expect(() => store.list({ projectId: 'project-1' })).toThrow('项目归属不匹配')
  })

  test('Given 未知或跨项目 Canvas When 要求 native Then 统一拒绝为会话不存在', () => {
    const store = createStore(['project-1', 'project-2'])
    /** 只在项目一登记的 native Canvas，不能被项目二索引读取。 */
    store.create({ projectId: 'project-1', title: '项目一 Canvas' })

    expect(() => store.requireNative('project-1', 'unknown-canvas')).toThrow('Canvas 会话不存在')
    expect(() => store.requireNative('project-2', 'canvas-created')).toThrow('Canvas 会话不存在')
  })

  test('Given legacy Design 会话 When 要求 native Then 不泄露内部 storageKind', () => {
    const store = createStore()
    /** 旧画布文件只用于建立固定 legacy-design 索引记录。 */
    const legacyPath = join(root, 'project-1', '.proma', 'design', 'canvas.json')
    mkdirSync(join(root, 'project-1', '.proma', 'design'), { recursive: true })
    writeFileSync(legacyPath, '{}', 'utf8')
    store.ensureLegacySession('project-1')

    /** Renderer 可见错误只表达会话不存在，不暴露迁移实现。 */
    let message = ''
    try {
      store.requireNative('project-1', 'legacy-design')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('Canvas 会话不存在')
    expect(message).not.toContain('legacy')
    expect(message).not.toContain('storageKind')
  })
})
