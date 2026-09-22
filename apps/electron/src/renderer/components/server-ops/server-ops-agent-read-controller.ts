import { parseServerOpsAgentReadGrant } from '@proma/shared'
import type { ServerOpsAgentAccessImpact, ServerOpsAgentReadAccess, ServerOpsAgentReadChanged, ServerOpsAgentReadGrant, ServerOpsAgentReadResource } from '@proma/shared'
import type { ServerOpsAgentCatalogApi } from './server-ops-agent-catalog-controller'
import { prepareServerOpsReadEditorResources } from './server-ops-agent-table-scope'

/** 只读权限页面使用受控主进程接口，目录读取与授权保存保持分离。 */
export interface ServerOpsAgentReadAccessApi {
  get(sessionId: string): Promise<ServerOpsAgentReadAccess | null>
  set(grant: ServerOpsAgentReadGrant, impactToken?: string): Promise<ServerOpsAgentReadAccess | null>
  impact?: () => Promise<ServerOpsAgentAccessImpact>
  onChanged?: (listener: (event: ServerOpsAgentReadChanged) => void) => () => void
  /** 用户点开禁用表选择器时按需读取元数据，不自动授权。 */
  listServerOpsDataSchemaTables?: ServerOpsAgentCatalogApi['listServerOpsDataSchemaTables']
}

/** 权威快照与编辑草稿分离，未保存选择不计入授权数。 */
export interface ServerOpsAgentReadProjection {
  sessionId: string | null
  projectId: string
  access: ServerOpsAgentReadAccess | null
  resources: ServerOpsAgentReadResource[]
  open: boolean
  loading: boolean
  saving: boolean
  impact: ServerOpsAgentAccessImpact | null
  impactLoading: boolean
  confirming: boolean
  error: string | null
}

/** Controller 的初始空投影，不含持久化或后台轮询。 */
export function emptyServerOpsAgentReadProjection(): ServerOpsAgentReadProjection {
  return { sessionId: null, projectId: '', access: null, resources: [], open: false, loading: false, saving: false, impact: null, impactLoading: false, confirming: false, error: null }
}

/** 创建实际授权页面使用的状态机；所有 IPC 迟到结果受同一动作代次约束。 */
export function createServerOpsAgentReadController(options: { api: ServerOpsAgentReadAccessApi; publish: (state: ServerOpsAgentReadProjection) => void }) {
  /** 状态只存在于当前挂载页面；权限事实仍由主进程掌握。 */
  let state = emptyServerOpsAgentReadProjection()
  /** 广播、目标切换与卸载均使旧回执失效。 */
  let epoch = 0
  /** 同一主进程有序授权事件的已见最高代次。 */
  let knownRevision = 0
  /** 卸载不撤销权限，只阻止该页面继续写状态。 */
  let active = true
  /** 确认对话框锁定的授权草稿，不能在确认期间暗中扩大范围。 */
  let pendingGrant: ServerOpsAgentReadGrant | null = null
  /** 每次发布独立副本，不让 React/调用者修改内部快照。 */
  const publish = (): void => { if (active) options.publish(structuredClone(state)) }
  /** 把匹配会话的主进程回执应用为权威事实。 */
  const adopt = (access: ServerOpsAgentReadAccess | null): void => {
    state.access = access?.sessionId === state.sessionId ? structuredClone(access) : null
    state.resources = state.open ? prepareServerOpsReadEditorResources(state.access?.resources ?? []) : structuredClone(state.access?.resources ?? [])
    if (state.access) knownRevision = Math.max(knownRevision, state.access.revision)
  }
  /** 使用已展示的影响 token 提交；CAS 冲突刷新预览但保留草稿。 */
  const persist = async (grant: ServerOpsAgentReadGrant): Promise<void> => {
    const revision = ++epoch
    const token = state.impact?.token
    state.saving = true; state.confirming = false; state.error = null; pendingGrant = null; publish()
    try {
      const access = await options.api.set(grant, token)
      if (!active || epoch !== revision) return
      state.open = false; adopt(access)
    } catch (error) {
      if (!active || epoch !== revision) return
      const conflict = error instanceof Error && error.message.includes('SERVER_OPS_ACCESS_IMPACT_CHANGED')
      state.error = conflict ? '授权范围已变化，请检查新的影响范围后重试'
        : error instanceof Error && error.message.includes('SERVER_OPS_READ_ACCESS_INVALID') ? '后台尚未接受新的授权格式，请完整重启客户端后重试'
          : error instanceof Error ? error.message : '保存授权失败'
      if (conflict && options.api.impact) {
        try {
          const impact = await options.api.impact()
          if (!active || epoch !== revision) return
          state.impact = impact
        } catch {
          if (!active || epoch !== revision) return
          state.impact = null
        }
      }
    } finally {
      if (active && epoch === revision) { state.saving = false; publish() }
    }
  }
  return {
    /** 供实际组件与行为测试读取隔离投影。 */
    snapshot: (): ServerOpsAgentReadProjection => structuredClone(state),
    /** StrictMode 重新 setup 可复用同一控制器。 */
    activate(): void { active = true },
    /** 卸载使全部 get/save 回执失效。 */
    dispose(): void { active = false; epoch += 1; pendingGrant = null },
    /** 切换项目保留同会话权限，切换会话立即清除旧显示与编辑。 */
    async select(sessionId: string | null, projectId: string): Promise<void> {
      const sameSession = state.sessionId === sessionId
      if (!sameSession) knownRevision = 0
      pendingGrant = null
      const needsRead = !sameSession || state.loading || state.error !== null || state.projectId === ''
      const revision = ++epoch
      state = { ...emptyServerOpsAgentReadProjection(), sessionId, projectId, access: sameSession ? state.access : null }
      state.resources = structuredClone(state.access?.resources ?? [])
      state.loading = Boolean(sessionId && needsRead)
      publish()
      if (!sessionId || !needsRead) return
      try {
        const access = await options.api.get(sessionId)
        if (!active || epoch !== revision) return
        adopt(access)
      } catch (error) {
        if (!active || epoch !== revision) return
        state.error = error instanceof Error ? error.message : '读取授权失败'
      } finally {
        if (active && epoch === revision) { state.loading = false; publish() }
      }
    },
    /** 打开时从已保存事实重建草稿，取消残留不会被再次提交。 */
    open(databaseTargets: ReadonlyMap<string, string> = new Map()): void {
      if (!active || !state.sessionId || state.loading || state.saving) return
      state.open = true; state.error = null; state.resources = prepareServerOpsReadEditorResources(state.access?.resources ?? [], databaseTargets)
      publish()
    },
    /** 打开编辑器时取得影响快照；刷新后 token 必须重新由用户确认。 */
    async loadImpact(): Promise<void> {
      if (!active || !state.open || !options.api.impact) return
      const revision = epoch
      state.impactLoading = true; state.confirming = false; pendingGrant = null; publish()
      try {
        const impact = await options.api.impact()
        if (!active || epoch !== revision || !state.open) return
        state.impact = impact
      } catch (error) {
        if (!active || epoch !== revision || !state.open) return
        state.impact = null
        state.error = error instanceof Error ? error.message : '读取授权影响失败'
      } finally {
        if (active && epoch === revision) { state.impactLoading = false; publish() }
      }
    },
    /** 取消、Escape 和遮罩关闭共用同一草稿收口。 */
    close(): void {
      if (state.saving) return
      state.open = false; state.resources = structuredClone(state.access?.resources ?? []); state.error = null
      state.impact = null; state.confirming = false; pendingGrant = null
      publish()
    },
    /** 只编辑草稿，保存前再做全量严格合同校验。 */
    edit(resources: ServerOpsAgentReadResource[]): void {
      if (!state.open || state.loading || state.saving) return
      state.resources = structuredClone(resources); state.error = null; state.confirming = false; pendingGrant = null; publish()
    },
    /** 广播优先于 get/save；保存自身的广播也可立即关闭弹窗而不等待 IPC 回执。 */
    changed(event: ServerOpsAgentReadChanged): void {
      if (event.current?.sessionId !== state.sessionId && event.previous?.sessionId !== state.sessionId) return
      const revision = Math.max(event.current?.revision ?? 0, event.previous?.revision ?? 0)
      if (!active || revision < knownRevision) return
      epoch += 1; knownRevision = revision
      pendingGrant = null; state.confirming = false; state.impact = null
      if (state.saving) state.open = false
      adopt(event.current)
      state.loading = false; state.saving = false; state.error = null
      publish()
      if (state.open && options.api.impact) {
        /** 在途编辑遇到外部缩权时刷新预览；代次避免跨会话回填。 */
        const refreshRevision = epoch
        state.impactLoading = true; publish()
        void options.api.impact().then((impact) => {
          if (active && epoch === refreshRevision && state.open) state.impact = impact
        }).catch(() => {
          if (active && epoch === refreshRevision && state.open) state.error = '刷新授权影响失败，请重新打开授权编辑器'
        }).finally(() => {
          if (active && epoch === refreshRevision) { state.impactLoading = false; publish() }
        })
      }
    },
    /** 用户确认覆盖旧操作授权后，提交确认时锁定的原始草稿。 */
    async confirmSave(): Promise<void> {
      if (!active || !state.open || !state.confirming || !pendingGrant) return
      await persist(pendingGrant)
    },
    /** 取消影响确认时只放弃待提交副本，保留可编辑草稿。 */
    cancelConfirmation(): void {
      pendingGrant = null; state.confirming = false; publish()
    },
    /** 保存或撤销整个资源集合；失败保留草稿，方便用户修正或重试。 */
    async save(resources = state.resources): Promise<void> {
      if (!active || !state.sessionId || state.loading || state.saving || !state.open) return
      let grant: ServerOpsAgentReadGrant
      try { grant = parseServerOpsAgentReadGrant({ sessionId: state.sessionId, resources }) } catch {
        state.error = '请检查授权范围：MySQL 需选择数据库，SQLite 仅支持 main 库；最多 32 个连接、每连接 20 个库、每库 100 张禁用表。'
        publish(); return
      }
      if (options.api.impact && !state.impact) {
        state.error = '请等待授权影响范围加载完成'; publish(); return
      }
      if (grant.resources.length > 0 && state.impact?.legacy) {
        pendingGrant = grant; state.confirming = true; state.error = null; publish(); return
      }
      await persist(grant)
    },
  }
}
