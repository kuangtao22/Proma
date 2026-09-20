import { describe, expect, test } from 'bun:test'
import type { ServerOpsProject } from '@proma/shared'
import {
  createServerOpsProjectController,
  describeServerOpsProjectMutationFailure,
  describeServerOpsProjectFailure,
  resolveServerOpsCurrentProjectId,
} from './server-ops-project-controller'
import type { ServerOpsProjectsProjection } from './server-ops-project-controller'

/** 创建可控 Promise，用于验证迟到结果被代次拒绝。 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, resolve, reject }
}

/** 创建项目样本。 */
function createProject(id: string, name: string): ServerOpsProject {
  return { id, name, createdAt: 1, updatedAt: 1 }
}

/** 等待控制器 Promise 回调完成。 */
async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('运维项目状态', () => {
  test('Given 未激活 When 刷新 Then 不发起请求也不发布', async () => {
    /** 列表调用次数。 */
    let listCalls = 0
    /** 控制器发布的投影历史。 */
    const published: ServerOpsProjectsProjection[] = []
    const controller = createServerOpsProjectController({
      listProjects: async () => { listCalls += 1; return { projects: [] } },
      publish: (projection) => published.push(projection),
    })
    controller.refresh()
    expect(listCalls).toBe(0)
    expect(published).toEqual([])
    expect(controller.getProjection().status).toBe('idle')
  })

  test('Given 激活 When 加载成功 Then 发布 ready 与项目列表', async () => {
    const published: ServerOpsProjectsProjection[] = []
    const controller = createServerOpsProjectController({
      listProjects: async () => ({ projects: [createProject('project-1', '默认项目'), createProject('project-2', '本地开发')] }),
      publish: (projection) => published.push(projection),
    })
    controller.activate()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controller.getProjection().status).toBe('ready')
    expect(controller.getProjection().projects.map((project) => project.name)).toEqual(['默认项目', '本地开发'])
    /** 激活必须先进入 loading，不能跳过加载态直接展示空列表。 */
    expect(published[0]!.status).toBe('idle')
    expect(published.some((projection) => projection.status === 'loading')).toBe(true)
  })

  test('Given 读取失败 When 已激活 Then 发布可读错误且保留已有列表', async () => {
    const published: ServerOpsProjectsProjection[] = []
    /** 首次成功、第二次失败的列表数据源。 */
    let attempt = 0
    const controller = createServerOpsProjectController({
      listProjects: async () => {
        attempt += 1
        if (attempt === 1) return { projects: [createProject('project-1', '默认项目')] }
        throw new Error('SERVER_OPS_PROJECT_READ_FAILED')
      },
      publish: (projection) => published.push(projection),
    })
    controller.activate()
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controller.getProjection().status).toBe('error')
    expect(controller.getProjection().error).toBe('项目文件损坏或不可读，请检查数据根')
    /** 读取失败不得清空上一次成功的项目列表，避免侧栏闪空。 */
    expect(controller.getProjection().projects.map((project) => project.id)).toEqual(['project-1'])
  })

  test('Given preload 未更新 When 激活 Then 同步异常被转成错误状态而不击穿调用方', async () => {
    const published: ServerOpsProjectsProjection[] = []
    const controller = createServerOpsProjectController({
      /** 旧客户端里该方法不存在，调用会同步抛出 TypeError。 */
      listProjects: (() => { throw new TypeError('window.electronAPI.listServerOpsProjects is not a function') }) as unknown as () => Promise<never>,
      publish: (projection) => published.push(projection),
    })
    /** 同步异常不得从 activate() 抛出，否则 effect 会崩掉整个运维页面。 */
    expect(() => controller.activate()).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controller.getProjection().status).toBe('error')
    expect(controller.getProjection().error).toBe('当前客户端不支持项目列表，请重启客户端')
  })

  test('Given 不同失败原因 When 生成文案 Then 各自给出可操作指引', () => {
    expect(describeServerOpsProjectFailure(new Error('SERVER_OPS_PROJECT_API_UNAVAILABLE'))).toBe('当前客户端不支持项目列表，请重启客户端')
    expect(describeServerOpsProjectFailure(new Error("No handler registered for 'server-ops:list-projects'"))).toBe('当前客户端不支持项目列表，请重启客户端')
    expect(describeServerOpsProjectFailure(new Error('SERVER_OPS_PROJECT_UNAVAILABLE'))).toBe('项目服务未初始化，请重启应用')
    expect(describeServerOpsProjectFailure(new Error('SERVER_OPS_PROJECT_READ_FAILED'))).toBe('项目文件损坏或不可读，请检查数据根')
    expect(describeServerOpsProjectFailure(new Error('SERVER_OPS_PROJECT_FILE_INVALID'))).toBe('项目文件损坏或不可读，请检查数据根')
    expect(describeServerOpsProjectFailure(new Error('boom'))).toBe('项目读取失败，请检查数据根是否可用')
  })

  test('Given 卸载或重新激活 When 旧请求迟到 Then 不写回投影', async () => {
    /** 第一次读取的迟到 Promise。 */
    const firstLoad = createDeferred<{ projects: ServerOpsProject[] }>()
    const published: ServerOpsProjectsProjection[] = []
    /** 列表调用次数；只有第一次返回迟到结果。 */
    let attempt = 0
    const controller = createServerOpsProjectController({
      listProjects: async () => {
        attempt += 1
        return attempt === 1 ? firstLoad.promise : { projects: [createProject('project-2', '本地开发')] }
      },
      publish: (projection) => published.push(projection),
    })
    controller.activate()
    controller.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    firstLoad.resolve({ projects: [createProject('project-1', '迟到的项目')] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controller.getProjection().projects.map((project) => project.name)).toEqual(['本地开发'])

    controller.dispose()
    /** 卸载后连新的解析结果也不得发布。 */
    const publishedBefore = published.length
    controller.refresh()
    expect(published.length).toBe(publishedBefore)
  })

  test('Given 选择为空或指向已删除项目 When 解析当前项目 Then 回落到列表第一项', () => {
    const projects = [createProject('project-1', '默认项目'), createProject('project-2', '本地开发')]
    expect(resolveServerOpsCurrentProjectId(projects, 'project-2')).toBe('project-2')
    expect(resolveServerOpsCurrentProjectId(projects, null)).toBe('project-1')
    expect(resolveServerOpsCurrentProjectId(projects, 'project-deleted')).toBe('project-1')
    expect(resolveServerOpsCurrentProjectId([], 'project-1')).toBeNull()
  })

  test('Given 新建弹窗与合法名称 When 提交成功 Then 立即追加项目并通知调用方', async () => {
    const created = createProject('project-2', '本地开发')
    const createdProjects: ServerOpsProject[] = []
    const controller = createServerOpsProjectController({
      listProjects: async () => ({ projects: [createProject('project-1', '默认项目')] }),
      createProject: async (input) => {
        expect(input).toEqual({ name: '本地开发' })
        return { project: created }
      },
      onCreated: (project) => createdProjects.push(project),
      publish: () => {},
    })
    controller.activate()
    await flushPromises()
    controller.openCreate()

    await controller.submit('  本地开发  ')

    expect(controller.getProjection()).toMatchObject({
      status: 'ready', dialog: null, submitting: false, dialogError: null,
    })
    expect(controller.getProjection().projects.map((project) => project.id)).toEqual(['project-1', 'project-2'])
    expect(createdProjects).toEqual([created])
  })

  test('Given 重命名弹窗 When 提交成功 Then 只替换目标项目', async () => {
    const first = createProject('project-1', '默认项目')
    const second = createProject('project-2', '本地开发')
    const renamed = { ...second, name: '测试环境', updatedAt: 2 }
    const controller = createServerOpsProjectController({
      listProjects: async () => ({ projects: [first, second] }),
      renameProject: async (input) => {
        expect(input).toEqual({ projectId: 'project-2', name: '测试环境' })
        return { project: renamed }
      },
      publish: () => {},
    })
    controller.activate()
    await flushPromises()
    controller.openRename(second)

    await controller.submit('测试环境')

    expect(controller.getProjection().projects).toEqual([first, renamed])
    expect(controller.getProjection().dialog).toBeNull()
  })

  test('Given 删除弹窗且仍有其他项目 When 提交成功 Then 移除目标并回传剩余列表', async () => {
    const first = createProject('project-1', '默认项目')
    const second = createProject('project-2', '本地开发')
    /** 删除通知携带的稳定快照。 */
    const deleted: Array<{ projectId: string; remaining: ServerOpsProject[] }> = []
    const controller = createServerOpsProjectController({
      listProjects: async () => ({ projects: [first, second] }),
      deleteProject: async (input) => { expect(input).toEqual({ projectId: 'project-2' }) },
      onDeleted: (projectId, remaining) => deleted.push({ projectId, remaining: [...remaining] }),
      publish: () => {},
    })
    controller.activate()
    await flushPromises()
    controller.requestDelete(second)

    await controller.submit()

    expect(controller.getProjection().projects).toEqual([first])
    expect(deleted).toEqual([{ projectId: 'project-2', remaining: [first] }])
  })

  test('Given 非法名称或本地业务冲突 When 提交 Then 使用共享解析规则并且不调用服务', async () => {
    const projects = [createProject('project-1', '默认项目')]
    /** 记录不应发生的创建调用。 */
    let createCalls = 0
    const controller = createServerOpsProjectController({
      listProjects: async () => ({ projects }),
      createProject: async () => { createCalls += 1; return { project: createProject('project-2', '意外项目') } },
      publish: () => {},
    })
    controller.activate()
    await flushPromises()
    controller.openCreate()
    await controller.submit('   ')
    expect(controller.getProjection().dialogError).toBe('项目名称不能为空')
    await controller.submit('默认项目')
    expect(controller.getProjection().dialogError).toBe('已存在同名项目')
    expect(createCalls).toBe(0)
  })

  test('Given 达到项目上限、目标丢失或只剩最后项目 When 提交 Then 在调用服务前拒绝', async () => {
    const limitProjects = Array.from({ length: 200 }, (_, index) => createProject(`project-${index}`, `项目 ${index}`))
    const limitController = createServerOpsProjectController({
      listProjects: async () => ({ projects: limitProjects }),
      createProject: async () => ({ project: createProject('project-overflow', '超额项目') }),
      publish: () => {},
    })
    limitController.activate()
    await flushPromises()
    limitController.openCreate()
    await limitController.submit('超额项目')
    expect(limitController.getProjection().dialogError).toBe('项目数量已达上限（200 个）')

    const only = createProject('project-1', '默认项目')
    const boundaryController = createServerOpsProjectController({
      listProjects: async () => ({ projects: [only] }),
      deleteProject: async () => {},
      renameProject: async () => ({ project: only }),
      publish: () => {},
    })
    boundaryController.activate()
    await flushPromises()
    boundaryController.requestDelete(only)
    await boundaryController.submit()
    expect(boundaryController.getProjection().dialogError).toBe('至少需要保留一个项目')
    boundaryController.closeDialog()
    boundaryController.openRename(createProject('project-missing', '已删除'))
    await boundaryController.submit('新名称')
    expect(boundaryController.getProjection().dialogError).toBe('项目不存在，请刷新后重试')
  })

  test('Given 服务失败 When 提交 Then 显示中文错误并允许原弹窗重试', async () => {
    /** 创建尝试次数。 */
    let attempts = 0
    const controller = createServerOpsProjectController({
      listProjects: async () => ({ projects: [createProject('project-1', '默认项目')] }),
      createProject: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('SERVER_OPS_PROJECT_WRITE_FAILED')
        return { project: createProject('project-2', '本地开发') }
      },
      publish: () => {},
    })
    controller.activate()
    await flushPromises()
    controller.openCreate()
    await controller.submit('本地开发')
    expect(controller.getProjection()).toMatchObject({
      dialog: { kind: 'create' }, submitting: false, dialogError: '项目保存失败，请检查数据根是否可用',
    })

    await controller.submit('本地开发')
    expect(controller.getProjection().dialog).toBeNull()
    expect(attempts).toBe(2)
  })

  test('Given 保存进行中 When 重复提交或切换弹窗 Then 只保留原操作', async () => {
    const save = createDeferred<{ project: ServerOpsProject }>()
    /** 创建调用次数。 */
    let calls = 0
    const controller = createServerOpsProjectController({
      listProjects: async () => ({ projects: [createProject('project-1', '默认项目')] }),
      createProject: async () => { calls += 1; return save.promise },
      publish: () => {},
    })
    controller.activate()
    await flushPromises()
    controller.openCreate()
    const firstSubmit = controller.submit('本地开发')
    const duplicateSubmit = controller.submit('另一个项目')
    controller.closeDialog()
    controller.openRename(createProject('project-1', '默认项目'))
    expect(controller.getProjection()).toMatchObject({ dialog: { kind: 'create' }, submitting: true })
    expect(calls).toBe(1)
    save.resolve({ project: createProject('project-2', '本地开发') })
    await Promise.all([firstSubmit, duplicateSubmit])
  })

  test('Given 旧列表晚于创建回执 When 两者完成 Then 旧列表不得覆盖新项目', async () => {
    const staleList = createDeferred<{ projects: ServerOpsProject[] }>()
    const first = createProject('project-1', '默认项目')
    const created = createProject('project-2', '本地开发')
    const controller = createServerOpsProjectController({
      listProjects: async () => staleList.promise,
      createProject: async () => ({ project: created }),
      publish: () => {},
    })
    controller.activate()
    controller.openCreate()
    await controller.submit('本地开发')
    staleList.resolve({ projects: [first] })
    await flushPromises()
    expect(controller.getProjection().projects).toEqual([created])
  })

  test('Given 保存期间卸载并重新激活 When 旧回执迟到 Then 不关闭新弹窗或写入旧结果', async () => {
    const oldSave = createDeferred<{ project: ServerOpsProject }>()
    /** 列表结果随 owner 代次变化。 */
    let listAttempt = 0
    const current = createProject('project-current', '当前项目')
    const controller = createServerOpsProjectController({
      listProjects: async () => {
        listAttempt += 1
        return listAttempt === 1 ? { projects: [createProject('project-1', '默认项目')] } : { projects: [current] }
      },
      createProject: async () => oldSave.promise,
      publish: () => {},
    })
    controller.activate()
    await flushPromises()
    controller.openCreate()
    const submitting = controller.submit('旧项目')
    controller.dispose()
    controller.activate()
    await flushPromises()
    controller.openRename(current)
    oldSave.resolve({ project: createProject('project-old', '旧项目') })
    await submitting
    expect(controller.getProjection().projects).toEqual([current])
    expect(controller.getProjection().dialog).toEqual({ kind: 'rename', project: current })
    expect(controller.getProjection().submitting).toBe(false)
  })

  test('Given 后端稳定错误码 When 转换保存错误 Then 返回对应中文说明', () => {
    expect(describeServerOpsProjectMutationFailure(new Error('SERVER_OPS_PROJECT_NAME_TAKEN'))).toBe('已存在同名项目')
    expect(describeServerOpsProjectMutationFailure(new Error('SERVER_OPS_PROJECT_NOT_FOUND'))).toBe('项目不存在，请刷新后重试')
    expect(describeServerOpsProjectMutationFailure(new Error('SERVER_OPS_PROJECT_NOT_EMPTY'))).toBe('请先移除项目内的连接')
    expect(describeServerOpsProjectMutationFailure(new Error('SERVER_OPS_PROJECT_LAST_REMAINING'))).toBe('至少需要保留一个项目')
    expect(describeServerOpsProjectMutationFailure(new Error('SERVER_OPS_PROJECT_LIMIT_REACHED'))).toBe('项目数量已达上限（200 个）')
    expect(describeServerOpsProjectMutationFailure(new Error('SERVER_OPS_PROJECT_WRITE_FAILED'))).toBe('项目保存失败，请检查数据根是否可用')
    expect(describeServerOpsProjectMutationFailure(new Error("No handler registered for 'server-ops:create-project'"))).toBe('当前客户端不支持项目管理，请重启客户端')
  })

  test('Given 两个控制器共享项目集合 When B 重命名 A 新建的项目 Then 使用共享最新列表校验并合并', async () => {
    const first = createProject('project-1', '默认项目')
    const created = createProject('project-2', '本地开发')
    const renamed = { ...created, name: '测试环境', updatedAt: 2 }
    /** 模拟 Workspace Jotai atom 中的共享权威数组引用。 */
    let sharedProjects = [first]
    /** 创建共享 sink 的控制器依赖。 */
    const sharedOptions = {
      listProjects: async () => ({ projects: sharedProjects }),
      getProjects: () => sharedProjects,
      publish: (projection: ServerOpsProjectsProjection) => { sharedProjects = projection.projects },
    }
    const controllerA = createServerOpsProjectController({
      ...sharedOptions,
      createProject: async () => ({ project: created }),
    })
    const controllerB = createServerOpsProjectController({
      ...sharedOptions,
      renameProject: async (input) => {
        expect(input.projectId).toBe(created.id)
        return { project: renamed }
      },
    })
    controllerA.activate()
    controllerB.activate()
    await flushPromises()
    controllerA.openCreate()
    await controllerA.submit(created.name)

    controllerB.openRename(created)
    await controllerB.submit(renamed.name)

    expect(sharedProjects).toEqual([first, renamed])
    expect(controllerB.getProjection().dialogError).toBeNull()
  })

  test('Given B 的局部投影早于 A 新建 When B 重命名旧项目 Then 不擦除 A 新增项目', async () => {
    const first = createProject('project-1', '默认项目')
    const created = createProject('project-2', '本地开发')
    const renamedFirst = { ...first, name: '生产环境', updatedAt: 2 }
    /** 模拟 Workspace Jotai atom 中的共享权威数组引用。 */
    let sharedProjects = [first]
    /** 创建共享 sink 的控制器依赖。 */
    const sharedOptions = {
      listProjects: async () => ({ projects: sharedProjects }),
      getProjects: () => sharedProjects,
      publish: (projection: ServerOpsProjectsProjection) => { sharedProjects = projection.projects },
    }
    const controllerA = createServerOpsProjectController({
      ...sharedOptions,
      createProject: async () => ({ project: created }),
    })
    const controllerB = createServerOpsProjectController({
      ...sharedOptions,
      renameProject: async () => ({ project: renamedFirst }),
    })
    controllerA.activate()
    controllerB.activate()
    await flushPromises()
    controllerA.openCreate()
    await controllerA.submit(created.name)

    controllerB.openRename(first)
    await controllerB.submit(renamedFirst.name)

    expect(sharedProjects).toEqual([renamedFirst, created])
  })

  test('Given A 的列表读取在途 When B 写入成功后 A 旧列表到达 Then 不覆盖 B 写入', async () => {
    const first = createProject('project-1', '默认项目')
    const created = createProject('project-2', '本地开发')
    const staleList = createDeferred<{ projects: ServerOpsProject[] }>()
    /** 模拟 Workspace Jotai atom 中的共享权威数组引用。 */
    let sharedProjects = [first]
    const controllerA = createServerOpsProjectController({
      listProjects: async () => staleList.promise,
      getProjects: () => sharedProjects,
      publish: (projection) => { sharedProjects = projection.projects },
    })
    const controllerB = createServerOpsProjectController({
      listProjects: async () => ({ projects: sharedProjects }),
      getProjects: () => sharedProjects,
      createProject: async () => ({ project: created }),
      publish: (projection) => { sharedProjects = projection.projects },
    })
    controllerA.activate()
    controllerB.activate()
    await flushPromises()
    controllerB.openCreate()
    await controllerB.submit(created.name)

    staleList.resolve({ projects: [first] })
    await flushPromises()

    expect(sharedProjects).toEqual([first, created])
    expect(controllerA.getProjection()).toMatchObject({ status: 'ready', error: null, projects: [first, created] })
  })

  test('Given A 的列表读取在途 When B 写入后 A 读取失败 Then 过期失败收敛 ready 且保留共享最新列表', async () => {
    const first = createProject('project-1', '默认项目')
    const created = createProject('project-2', '本地开发')
    const staleList = createDeferred<{ projects: ServerOpsProject[] }>()
    /** 模拟 Workspace Jotai atom 中的共享权威数组引用。 */
    let sharedProjects = [first]
    const controllerA = createServerOpsProjectController({
      listProjects: async () => staleList.promise,
      getProjects: () => sharedProjects,
      publish: (projection) => { sharedProjects = projection.projects },
    })
    const controllerB = createServerOpsProjectController({
      listProjects: async () => ({ projects: sharedProjects }),
      getProjects: () => sharedProjects,
      createProject: async () => ({ project: created }),
      publish: (projection) => { sharedProjects = projection.projects },
    })
    controllerA.activate()
    controllerB.activate()
    await flushPromises()
    controllerB.openCreate()
    await controllerB.submit(created.name)

    staleList.reject(new Error('SERVER_OPS_PROJECT_READ_FAILED'))
    await flushPromises()

    expect(sharedProjects).toEqual([first, created])
    expect(controllerA.getProjection()).toMatchObject({
      status: 'ready', projects: [first, created], error: null,
    })
  })
})
