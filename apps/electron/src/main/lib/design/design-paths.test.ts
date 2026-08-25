import { describe, expect, test } from 'bun:test'
import { createDesignPathResolver } from './design-paths'

describe('Design 路径解析', () => {
  test('Given 外部项目 When 解析 Then 正式数据随项目且缓存按稳定 ID 隔离', () => {
    /** 使用外部目录的项目路径解析器。 */
    const resolver = createDesignPathResolver({
      getWorkspace: () => ({
        id: 'project-1',
        name: '项目',
        slug: 'stable-slug',
        projectRootPath: '/projects/demo',
        createdAt: 1,
        updatedAt: 1,
      }),
      getProjectFilesPath: () => '/projects/demo',
      getConfigDir: () => '/home/test/.proma',
    })

    expect(resolver.resolve('project-1')).toEqual({
      projectId: 'project-1',
      projectRoot: '/projects/demo',
      designRoot: '/projects/demo/.proma/design',
      canvasPath: '/projects/demo/.proma/design/canvas.json',
      canvasesRoot: '/projects/demo/.proma/design/canvases',
      canvasSessionsIndexPath: '/projects/demo/.proma/design/canvases/index.json',
      assetsDir: '/projects/demo/.proma/design/assets',
      annotationsDir: '/projects/demo/.proma/design/annotations',
      contextRoot: '/projects/demo/.proma/design/context',
      contextManifestPath: '/projects/demo/.proma/design/context/manifest.json',
      contextDocumentsDir: '/projects/demo/.proma/design/context/documents',
      contextReferencesDir: '/projects/demo/.proma/design/context/references',
      cacheRoot: '/home/test/.proma/design-cache/project-1',
      preferencesPath: '/home/test/.proma/design-cache/project-1/preferences.json',
      thumbnailsDir: '/home/test/.proma/design-cache/project-1/thumbnails',
      jobsDir: '/home/test/.proma/design-cache/project-1/jobs',
      tracesDir: '/home/test/.proma/design-cache/project-1/traces',
      stagingDir: '/home/test/.proma/design-cache/project-1/staging',
    })

    expect(resolver.resolveCanvas('project-1', 'canvas-1')).toEqual({
      projectId: 'project-1',
      canvasId: 'canvas-1',
      canvasRoot: '/projects/demo/.proma/design/canvases/canvas-1',
      documentPath: '/projects/demo/.proma/design/canvases/canvas-1/canvas.json',
      transactionsDir: '/projects/demo/.proma/design/canvases/canvas-1/transactions',
      cacheRoot: '/home/test/.proma/design-cache/project-1/canvases/canvas-1',
      jobsDir: '/home/test/.proma/design-cache/project-1/canvases/canvas-1/jobs',
      tracesDir: '/home/test/.proma/design-cache/project-1/canvases/canvas-1/traces',
      stagingDir: '/home/test/.proma/design-cache/project-1/canvases/canvas-1/staging',
      thumbnailsDir: '/home/test/.proma/design-cache/project-1/canvases/canvas-1/thumbnails',
    })

    expect(() => resolver.resolveCanvas('project-1', '../escape')).toThrow('Canvas ID 非法')
    expect(() => resolver.resolveCanvas('project-1', 'nested/path')).toThrow('Canvas ID 非法')
  })

  test('Given 托管项目 When 解析 Then 通过不可变 slug 获取项目根', () => {
    /** 记录正式项目根解析实际收到的 slug。 */
    let resolvedSlug = ''
    /** 使用 Proma 托管目录的项目路径解析器。 */
    const resolver = createDesignPathResolver({
      getWorkspace: () => ({
        id: 'project-2',
        name: '托管项目',
        slug: 'managed-slug',
        createdAt: 1,
        updatedAt: 1,
      }),
      getProjectFilesPath: (slug) => {
        resolvedSlug = slug
        return '/home/test/.proma/agent-workspaces/managed-slug/workspace-files'
      },
      getConfigDir: () => '/home/test/.proma',
    })

    /** 托管项目解析后的可信路径集合。 */
    const paths = resolver.resolve('project-2')
    expect(resolvedSlug).toBe('managed-slug')
    expect(paths.projectRoot).toBe('/home/test/.proma/agent-workspaces/managed-slug/workspace-files')
    expect(paths.designRoot).toBe('/home/test/.proma/agent-workspaces/managed-slug/workspace-files/.proma/design')
  })

  test('Given 未知项目 When 解析 Then 明确拒绝', () => {
    /** 永远无法找到项目的路径解析器。 */
    const resolver = createDesignPathResolver({
      getWorkspace: () => undefined,
      getProjectFilesPath: () => '',
      getConfigDir: () => '',
    })

    expect(() => resolver.resolve('forged')).toThrow('项目不存在: forged')
  })

  test('Given 非法项目 ID When 解析 Then 在构造缓存路径前拒绝', () => {
    /** 记录非法 ID 是否错误触达工作区索引。 */
    let workspaceLookupCalled = false
    /** 非法 ID 必须在工作区查询前被拒绝的路径解析器。 */
    const resolver = createDesignPathResolver({
      getWorkspace: () => {
        workspaceLookupCalled = true
        return undefined
      },
      getProjectFilesPath: () => '/projects/safe',
      getConfigDir: () => '/home/test/.proma',
    })

    expect(() => resolver.resolve('../escape')).toThrow('项目 ID 非法')
    expect(workspaceLookupCalled).toBe(false)
  })

  test('Given 项目显示名变化 When 解析 Then 缓存映射保持稳定', () => {
    /** 当前项目显示名，模拟用户重命名项目。 */
    let projectName = '旧名称'
    /** 缓存只依赖稳定 ID 的路径解析器。 */
    const resolver = createDesignPathResolver({
      getWorkspace: () => ({
        id: 'stable_id-1',
        name: projectName,
        slug: 'stable-slug',
        createdAt: 1,
        updatedAt: 1,
      }),
      getProjectFilesPath: () => '/projects/demo',
      getConfigDir: () => '/home/test/.proma',
    })

    /** 重命名前的缓存根。 */
    const beforeRename = resolver.resolve('stable_id-1').cacheRoot
    projectName = '新名称'
    /** 重命名后的缓存根。 */
    const afterRename = resolver.resolve('stable_id-1').cacheRoot
    expect(afterRename).toBe(beforeRename)
  })
})
