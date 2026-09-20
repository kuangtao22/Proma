import type { ServerOpsConnectionMoveInput, ServerOpsConnectionMoveResult, ServerOpsProject } from '@proma/shared'
import type { ServerOpsConnection } from './server-ops-connections'

/** 一次移动弹窗的公开状态；不包含任何连接凭据。 */
export interface ServerOpsConnectionMoveProjection {
  connection: ServerOpsConnection | null
  targetProjectId: string
  submitting: boolean
  error: string | null
}

/** 移动只依赖明确的资产写入接口和当前共享目录。 */
interface ServerOpsConnectionMoveOptions {
  getProjects: () => readonly ServerOpsProject[]
  getConnections: () => readonly ServerOpsConnection[]
  move: (input: ServerOpsConnectionMoveInput) => Promise<ServerOpsConnectionMoveResult>
  /** 写盘回执必须更新共享事实，即使发起弹窗的 Pane 已卸载。 */
  acceptMoved: (result: ServerOpsConnectionMoveResult, input: ServerOpsConnectionMoveInput) => void
  onSuccess: (projectName: string) => void
  publish: (projection: ServerOpsConnectionMoveProjection) => void
}

/** 可独立测试的弹窗生命周期和提交控制器。 */
export interface ServerOpsConnectionMoveController {
  getProjection(): ServerOpsConnectionMoveProjection
  activate(): void
  dispose(): void
  open(connection: ServerOpsConnection): void
  close(): void
  selectTarget(projectId: string): void
  submit(): Promise<void>
}

/** 返回一个没有目标和错误的关闭状态。 */
export function createServerOpsConnectionMoveIdleProjection(): ServerOpsConnectionMoveProjection {
  return { connection: null, targetProjectId: '', submitting: false, error: null }
}

/** 移动回执合并所需的最小资产身份，不接触凭据内容。 */
interface MovableServerOpsAsset { id: string; projectId?: string; updatedAt: number }

/**
 * 将已落盘的移动结果合入当前共享列表，保留其他 Pane 的较新记录和删除结果。
 * @param current 当前共享资产列表
 * @param moved 主进程确认的移动结果
 * @param fromProjectId 本次操作预期的原项目
 * @returns 合并后的数组；回执已过期时保留原引用
 */
export function mergeServerOpsMovedAsset<T extends MovableServerOpsAsset>(current: T[], moved: T, fromProjectId: string): T[] {
  /** 只替换仍然存在且归属匹配的记录，不能复活已删除资产。 */
  const existing = current.find((entry) => entry.id === moved.id)
  if (!existing || existing.updatedAt > moved.updatedAt
    || (existing.projectId !== undefined && existing.projectId !== fromProjectId)) return current
  return current.map((entry) => entry.id === moved.id ? moved : entry)
}

/** 将稳定错误码转为用户可恢复的移动失败提示，不显示内部路径。 */
function describeMoveFailure(error: unknown): string {
  /** IPC 可能为稳定错误码添加前缀，按子串分类。 */
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('SERVER_OPS_CONNECTION_PROJECT_CHANGED')) return '连接归属已变化，请刷新项目列表后重新移动'
  if (message.includes('SERVER_OPS_PROJECT_NOT_FOUND')) return '目标项目不存在，请刷新后重新选择'
  if (message.includes('NOT_FOUND')) return '连接已不存在，请刷新项目列表'
  if (message.includes('is not a function') || message.includes('No handler registered') || message.includes('UNAVAILABLE')) {
    return '当前客户端尚未加载移动功能，请重启客户端后重试'
  }
  return '移动失败，请稍后重试；若持续失败，请检查数据目录是否可写'
}

/**
 * 管理移动弹窗；重复提交单飞，过期表单拒绝覆盖新归属，旧回执不能关闭新弹窗。
 * @param options 当前共享目录、IPC 与状态发布接口
 * @returns 本 Pane 专用控制器
 */
export function createServerOpsConnectionMoveController(options: ServerOpsConnectionMoveOptions): ServerOpsConnectionMoveController {
  /** Pane 生命周期与弹窗代次共同隔离旧的异步回执。 */
  let active = false
  let generation = 0
  /** 当前弹窗投影。 */
  let projection = createServerOpsConnectionMoveIdleProjection()
  /** 只向当前存活的 Pane 发布状态。 */
  const publish = (next: ServerOpsConnectionMoveProjection): void => {
    projection = next
    if (active) options.publish(next)
  }
  return {
    getProjection: () => projection,
    activate() { active = true; generation += 1; publish(createServerOpsConnectionMoveIdleProjection()) },
    dispose() { active = false; generation += 1 },
    open(connection) {
      if (!active || projection.submitting) return
      generation += 1
      publish({ connection: { ...connection }, targetProjectId: '', submitting: false, error: null })
    },
    close() {
      if (!active || projection.submitting) return
      generation += 1
      publish(createServerOpsConnectionMoveIdleProjection())
    },
    selectTarget(projectId) {
      if (!active || !projection.connection || projection.submitting) return
      publish({ ...projection, targetProjectId: projectId, error: null })
    },
    async submit() {
      if (!active || !projection.connection || projection.submitting) return
      /** 捕获本次弹窗的原项目与目标，保存期间不再读取可变表单值。 */
      const { connection, targetProjectId } = projection
      /** 原项目可能已在另一个 Pane 改变，不能静默把新归属当作原始意图。 */
      const current = options.getConnections().find((entry) => entry.id === connection.id)
      /** 目标必须存在且不同于当前归属。 */
      const target = options.getProjects().find((project) => project.id === targetProjectId)
      if (!current) { publish({ ...projection, error: '连接已不存在，请刷新项目列表' }); return }
      if (current.projectId !== connection.projectId) { publish({ ...projection, error: '连接归属已变化，请重新打开移动窗口' }); return }
      if (!target || target.id === connection.projectId) { publish({ ...projection, error: '请选择其他目标项目' }); return }
      /** 后端资产 ID 与 UI 的类型前缀分离。 */
      const id = connection.kind === 'ssh' ? connection.hostId : connection.sourceId
      if (!id) { publish({ ...projection, error: '连接标识无效，请刷新项目列表' }); return }
      /** 明确原归属，防止另一窗口在校验后抢先移动。 */
      const input: ServerOpsConnectionMoveInput = { kind: connection.kind === 'ssh' ? 'ssh' : 'data', id, fromProjectId: connection.projectId, targetProjectId }
      /** 本次提交所属的弹窗代次。 */
      const submittedGeneration = generation
      publish({ ...projection, submitting: true, error: null })
      try {
        /** 同步缺失 API 和异步主进程失败都由同一错误分支收口。 */
        const result = await options.move(input)
        /** 校验回执必须对应本次移动，不能误合并其它类型或其它连接。 */
        const record = result.kind === 'ssh' ? result.host : result.source
        if (result.kind !== input.kind || record.id !== input.id || record.projectId !== targetProjectId) throw new Error('SERVER_OPS_CONNECTION_MOVE_RESULT_INVALID')
        options.acceptMoved(result, input)
        if (!active || generation !== submittedGeneration) return
        publish(createServerOpsConnectionMoveIdleProjection())
        options.onSuccess(options.getProjects().find((project) => project.id === targetProjectId)?.name ?? target.name)
      } catch (error) {
        if (active && generation === submittedGeneration) publish({ ...projection, submitting: false, error: describeMoveFailure(error) })
      }
    },
  }
}
