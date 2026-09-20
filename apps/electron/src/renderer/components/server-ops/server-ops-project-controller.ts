import {
  parseServerOpsProjectCreateInput,
  parseServerOpsProjectDeleteInput,
  parseServerOpsProjectRenameInput,
} from '@proma/shared'
import type {
  ServerOpsProject,
  ServerOpsProjectCreateInput,
  ServerOpsProjectDeleteInput,
  ServerOpsProjectListResult,
  ServerOpsProjectRenameInput,
  ServerOpsProjectResult,
} from '@proma/shared'

/** 单机项目数量上限，与共享列表 parser 的有界合同一致。 */
const SERVER_OPS_PROJECT_LIMIT = 200

/**
 * 把项目读取失败转换为可操作的中文说明。
 *
 * 这几种原因的处置完全不同：preload 未更新要重启客户端、主进程未接线要重启应用、
 * 文件损坏要检查数据根；混成一句"请稍后重试"会让用户反复点击同一个坏按钮。
 *
 * @param error 读取项目时抛出的错误
 * @returns 面向用户的中文说明
 */
export function describeServerOpsProjectFailure(error: unknown): string {
  /** 原始错误文本只用于分类，不直接展示。 */
  const text = error instanceof Error ? error.message : String(error)
  if (text.includes('is not a function') || text.includes('No handler registered')
    || text.includes('SERVER_OPS_PROJECT_API_UNAVAILABLE')) {
    return '当前客户端不支持项目列表，请重启客户端'
  }
  if (text.includes('SERVER_OPS_PROJECT_READ_FAILED') || text.includes('SERVER_OPS_PROJECT_FILE_INVALID')) {
    return '项目文件损坏或不可读，请检查数据根'
  }
  if (text.includes('SERVER_OPS_PROJECT')) return '项目服务未初始化，请重启应用'
  return '项目读取失败，请检查数据根是否可用'
}

/**
 * 把项目写入失败转换为弹窗内可恢复的中文说明。
 *
 * @param error 项目创建、重命名或删除时抛出的错误
 * @returns 面向用户的中文说明
 */
export function describeServerOpsProjectMutationFailure(error: unknown): string {
  /** 原始错误文本只用于匹配稳定错误码，不直接展示。 */
  const text = error instanceof Error ? error.message : String(error)
  if (text.includes('SERVER_OPS_PROJECT_NAME_TAKEN')) return '已存在同名项目'
  if (text.includes('SERVER_OPS_PROJECT_NOT_FOUND')) return '项目不存在，请刷新后重试'
  if (text.includes('SERVER_OPS_PROJECT_NOT_EMPTY')) return '请先移除项目内的连接'
  if (text.includes('SERVER_OPS_PROJECT_LAST_REMAINING')) return '至少需要保留一个项目'
  if (text.includes('SERVER_OPS_PROJECT_LIMIT')) return '项目数量已达上限（200 个）'
  if (text.includes('SERVER_OPS_PROJECT_CREATE_INPUT_INVALID')
    || text.includes('SERVER_OPS_PROJECT_RENAME_INPUT_INVALID')) return '项目名称格式无效，请输入 1 至 60 个字符'
  if (text.includes('is not a function') || text.includes('No handler registered')
    || text.includes('SERVER_OPS_PROJECT_API_UNAVAILABLE')) {
    return '当前客户端不支持项目管理，请重启客户端'
  }
  if (text.includes('SERVER_OPS_PROJECT_WRITE_FAILED')
    || text.includes('SERVER_OPS_PROJECT_SAVE_FAILED')
    || text.includes('SERVER_OPS_PROJECT_READ_FAILED')
    || text.includes('SERVER_OPS_PROJECT_FILE_INVALID')) return '项目保存失败，请检查数据根是否可用'
  if (text.includes('SERVER_OPS_PROJECT')) return '项目保存失败，请重启应用后重试'
  return '项目保存失败，请稍后重试'
}

/** 项目列表加载状态。 */
export type ServerOpsProjectsStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 项目管理弹窗；弹窗目标快照用于隔离迟到回执。 */
export type ServerOpsProjectDialogState =
  | { kind: 'create' }
  | { kind: 'rename'; project: ServerOpsProject }
  | { kind: 'delete'; project: ServerOpsProject }
  | null

/** 项目列表公开投影，可直接静态断言。 */
export interface ServerOpsProjectsProjection {
  status: ServerOpsProjectsStatus
  projects: ServerOpsProject[]
  error: string | null
  dialog: ServerOpsProjectDialogState
  submitting: boolean
  dialogError: string | null
}

/** 控制器依赖；`listProjects` 由工作区注入 preload bridge。 */
export interface ServerOpsProjectControllerOptions {
  listProjects: () => Promise<ServerOpsProjectListResult>
  /** 读取跨 Pane 共享的最新项目数组；未注入时兼容原单控制器用法。 */
  getProjects?: () => ServerOpsProject[]
  createProject?: (input: ServerOpsProjectCreateInput) => Promise<ServerOpsProjectResult>
  renameProject?: (input: ServerOpsProjectRenameInput) => Promise<ServerOpsProjectResult>
  deleteProject?: (input: ServerOpsProjectDeleteInput) => Promise<void>
  publish: (projection: ServerOpsProjectsProjection) => void
  onCreated?: (project: ServerOpsProject) => void
  onDeleted?: (projectId: string, remainingProjects: ServerOpsProject[]) => void
}

/** 项目列表控制器。 */
export interface ServerOpsProjectController {
  getProjection(): ServerOpsProjectsProjection
  /** 建立新的 owner 代次；重新挂载或 StrictMode 重放都会调用。 */
  activate(): void
  dispose(): void
  refresh(): void
  openCreate(): void
  openRename(project: ServerOpsProject): void
  requestDelete(project: ServerOpsProject): void
  closeDialog(): void
  submit(name?: string): Promise<void>
}

/** 创建初始投影。 */
export function createServerOpsProjectsIdleProjection(): ServerOpsProjectsProjection {
  return {
    status: 'idle',
    projects: [],
    error: null,
    dialog: null,
    submitting: false,
    dialogError: null,
  }
}

/**
 * 创建项目列表控制器。
 *
 * 项目是运维工作台的顶层分组，也是 Agent 授权的锚点；因此它的加载必须与
 * 其它领域一样带 owner 代次，切换或卸载后迟到的结果不得写回。
 *
 * @param options 列表数据源与投影发布边界
 * @returns 可独立测试的控制器
 */
export function createServerOpsProjectController(options: ServerOpsProjectControllerOptions): ServerOpsProjectController {
  /** 当前 owner 是否仍然有效。 */
  let ownerActive = false
  /** owner 代次；卸载后旧写入回执即使在重新激活后到达也必须失效。 */
  let ownerRevision = 0
  /** 请求代次；每次刷新或重新激活都推进。 */
  let revision = 0
  /** 写入代次；确保一次提交只消费自己的回执。 */
  let mutationRevision = 0
  /** 当前公开投影。 */
  let projection = createServerOpsProjectsIdleProjection()

  /** 只向仍活跃的 owner 发布不可变投影。 */
  const publish = (next: ServerOpsProjectsProjection): void => {
    projection = next
    if (ownerActive) options.publish(next)
  }

  /** 读取当前共享项目引用；旧调用方未注入 getter 时回退到本控制器投影。 */
  const getCurrentProjects = (): ServerOpsProject[] => options.getProjects?.() ?? projection.projects

  /** 合并少量管理投影并发布，同时保留跨 Pane 共享的最新项目引用。 */
  const patch = (next: Partial<ServerOpsProjectsProjection>): void => {
    publish({ ...projection, ...next, projects: getCurrentProjects() })
  }

  /** 判断项目是否仍存在于当前权威投影。 */
  const hasProject = (projectId: string): boolean => getCurrentProjects().some((project) => project.id === projectId)

  /** 校验名称并复用共享 IPC parser 完成 trim、长度和控制字符约束。 */
  const parseNameInput = (
    dialog: Exclude<ServerOpsProjectDialogState, null | { kind: 'delete'; project: ServerOpsProject }>,
    name: string | undefined,
  ): ServerOpsProjectCreateInput | ServerOpsProjectRenameInput => {
    if (typeof name === 'string' && name.trim().length === 0) throw new Error('SERVER_OPS_PROJECT_NAME_EMPTY')
    return dialog.kind === 'create'
      ? parseServerOpsProjectCreateInput({ name })
      : parseServerOpsProjectRenameInput({ projectId: dialog.project.id, name })
  }

  /** 把本地前置校验错误转换为弹窗文案。 */
  const describeLocalFailure = (error: unknown): string => {
    if (error instanceof Error && error.message === 'SERVER_OPS_PROJECT_NAME_EMPTY') return '项目名称不能为空'
    return describeServerOpsProjectMutationFailure(error)
  }

  return {
    getProjection: () => projection,

    activate(): void {
      if (ownerActive) return
      ownerActive = true
      ownerRevision += 1
      revision += 1
      mutationRevision += 1
      publish({
        ...projection,
        status: 'idle',
        projects: getCurrentProjects(),
        error: null,
        submitting: false,
        dialogError: null,
      })
      this.refresh()
    },

    dispose(): void {
      ownerActive = false
      ownerRevision += 1
      revision += 1
      mutationRevision += 1
    },

    refresh(): void {
      if (!ownerActive) return
      /** 本次请求独占的代次。 */
      const operationRevision = ++revision
      /** 列表读取开始时的共享数组引用；其它 Pane 写入后该引用会变化。 */
      const projectsAtStart = getCurrentProjects()
      publish({ ...projection, status: 'loading', projects: projectsAtStart, error: null })
      // 先包一层 Promise：preload 未更新时 `listProjects` 本身可能不存在，
      // 同步抛出的 TypeError 必须走同一条失败路径，不能击穿 effect 让页面崩掉。
      void Promise.resolve().then(() => options.listProjects()).then((result) => {
        if (!ownerActive || revision !== operationRevision) return
        /** 共享列表已被写操作更新时，本次基于旧起点的列表回执不得覆盖它。 */
        if (getCurrentProjects() !== projectsAtStart) {
          publish({ ...projection, status: 'ready', projects: getCurrentProjects(), error: null })
          return
        }
        publish({ ...projection, status: 'ready', projects: [...result.projects], error: null })
      }).catch((error: unknown) => {
        if (!ownerActive || revision !== operationRevision) return
        /** 其它 Pane 已成功更新列表时，旧读取失败也只负责结束自身 loading。 */
        if (getCurrentProjects() !== projectsAtStart) {
          publish({ ...projection, status: 'ready', projects: getCurrentProjects(), error: null })
          return
        }
        publish({
          ...projection,
          status: 'error',
          projects: getCurrentProjects(),
          error: describeServerOpsProjectFailure(error),
        })
      })
    },

    openCreate(): void {
      if (!ownerActive || projection.submitting) return
      patch({ dialog: { kind: 'create' }, dialogError: null })
    },

    openRename(project: ServerOpsProject): void {
      if (!ownerActive || projection.submitting) return
      patch({ dialog: { kind: 'rename', project }, dialogError: null })
    },

    requestDelete(project: ServerOpsProject): void {
      if (!ownerActive || projection.submitting) return
      patch({ dialog: { kind: 'delete', project }, dialogError: null })
    },

    closeDialog(): void {
      if (!ownerActive || projection.submitting) return
      patch({ dialog: null, dialogError: null })
    },

    async submit(name?: string): Promise<void> {
      /** 本次提交绑定的弹窗快照。 */
      const dialog = projection.dialog
      if (!ownerActive || projection.submitting || dialog === null) return

      try {
        if (dialog.kind === 'create') {
          /** 提交前读取跨 Pane 最新项目，避免用当前 Pane 的旧快照做边界判断。 */
          const projects = getCurrentProjects()
          if (projects.length >= SERVER_OPS_PROJECT_LIMIT) throw new Error('SERVER_OPS_PROJECT_LIMIT_REACHED')
          /** 已经由共享 parser 规范化的创建输入。 */
          const input = parseNameInput(dialog, name) as ServerOpsProjectCreateInput
          if (projects.some((project) => project.name === input.name)) throw new Error('SERVER_OPS_PROJECT_NAME_TAKEN')
        } else if (!hasProject(dialog.project.id)) {
          throw new Error('SERVER_OPS_PROJECT_NOT_FOUND')
        } else if (dialog.kind === 'delete' && getCurrentProjects().length <= 1) {
          throw new Error('SERVER_OPS_PROJECT_LAST_REMAINING')
        } else if (dialog.kind === 'rename') {
          /** 已经由共享 parser 规范化的重命名输入。 */
          const input = parseNameInput(dialog, name) as ServerOpsProjectRenameInput
          if (getCurrentProjects().some((project) => project.id !== input.projectId && project.name === input.name)) {
            throw new Error('SERVER_OPS_PROJECT_NAME_TAKEN')
          }
        }
      } catch (error: unknown) {
        patch({ dialogError: describeLocalFailure(error) })
        return
      }

      /** 本次提交固定的 owner 代次。 */
      const operationOwnerRevision = ownerRevision
      /** 本次提交独占的写入代次。 */
      const operationMutationRevision = ++mutationRevision
      patch({ submitting: true, dialogError: null })

      try {
        if (dialog.kind === 'create') {
          /** 创建输入再次从共享 parser 取得，避免本地与 IPC 规范化漂移。 */
          const input = parseServerOpsProjectCreateInput({ name })
          /** 创建服务由工作区 preload bridge 注入。 */
          const result = await options.createProject!(input)
          if (!ownerActive || ownerRevision !== operationOwnerRevision
            || mutationRevision !== operationMutationRevision || projection.dialog !== dialog) return
          revision += 1
          /** 回执到达时的共享列表可能已被其它 Pane 更新，必须以它作为合并基线。 */
          const currentProjects = getCurrentProjects()
          /** 同 ID 回执按替换处理，防止异常重试造成重复行。 */
          const projects = currentProjects.some((project) => project.id === result.project.id)
            ? currentProjects.map((project) => project.id === result.project.id ? result.project : project)
            : [...currentProjects, result.project]
          publish({ ...projection, status: 'ready', projects, error: null, dialog: null, submitting: false, dialogError: null })
          options.onCreated?.(result.project)
          return
        }

        if (dialog.kind === 'rename') {
          /** 重命名输入再次从共享 parser 取得，避免本地与 IPC 规范化漂移。 */
          const input = parseServerOpsProjectRenameInput({ projectId: dialog.project.id, name })
          /** 重命名服务由工作区 preload bridge 注入。 */
          const result = await options.renameProject!(input)
          if (!ownerActive || ownerRevision !== operationOwnerRevision
            || mutationRevision !== operationMutationRevision || projection.dialog !== dialog) return
          revision += 1
          /** 只替换后端确认的目标 ID，其余项目保持顺序与引用。 */
          const projects = getCurrentProjects().map((project) => project.id === result.project.id ? result.project : project)
          publish({ ...projection, status: 'ready', projects, error: null, dialog: null, submitting: false, dialogError: null })
          return
        }

        /** 删除输入由共享 parser 校验项目 ID。 */
        const input = parseServerOpsProjectDeleteInput({ projectId: dialog.project.id })
        await options.deleteProject!(input)
        if (!ownerActive || ownerRevision !== operationOwnerRevision
          || mutationRevision !== operationMutationRevision || projection.dialog !== dialog) return
        revision += 1
        /** 删除成功后的剩余列表是调用方选择回退的权威快照。 */
        const remainingProjects = getCurrentProjects().filter((project) => project.id !== dialog.project.id)
        publish({
          ...projection,
          status: 'ready',
          projects: remainingProjects,
          error: null,
          dialog: null,
          submitting: false,
          dialogError: null,
        })
        options.onDeleted?.(dialog.project.id, [...remainingProjects])
      } catch (error: unknown) {
        if (!ownerActive || ownerRevision !== operationOwnerRevision
          || mutationRevision !== operationMutationRevision || projection.dialog !== dialog) return
        patch({ submitting: false, dialogError: describeServerOpsProjectMutationFailure(error) })
      }
    },
  }
}

/**
 * 解析当前生效的项目 ID。
 *
 * 选择为空或指向已删除的项目时回落到列表第一项，保证界面不会停留在不存在的项目上。
 *
 * @param projects 已加载的项目列表
 * @param selectedProjectId 用户上次选择
 * @returns 生效的项目 ID；列表为空时为 null
 */
export function resolveServerOpsCurrentProjectId(
  projects: readonly ServerOpsProject[],
  selectedProjectId: string | null,
): string | null {
  if (projects.some((project) => project.id === selectedProjectId)) return selectedProjectId
  return projects[0]?.id ?? null
}
