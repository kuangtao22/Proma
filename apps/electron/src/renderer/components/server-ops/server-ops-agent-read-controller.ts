import { parseServerOpsAgentReadGrant, parseServerOpsDatabaseAgentPolicyUpdate } from '@proma/shared'
import type { ServerOpsAgentAccessImpact, ServerOpsAgentReadAccess, ServerOpsAgentReadChanged, ServerOpsAgentReadGrant, ServerOpsAgentReadResource, ServerOpsDatabaseAgentExclusion, ServerOpsDatabaseAgentPolicy, ServerOpsDatabaseAgentPolicyUpdate } from '@proma/shared'
import type { ServerOpsAgentCatalogApi } from './server-ops-agent-catalog-controller'
import { prepareServerOpsReadEditorResources } from './server-ops-agent-table-scope'

/** 持久数据库禁用策略桥接，只供统一运维授权弹窗使用。 */
export interface ServerOpsDatabaseAgentPolicyApi {
  get(): Promise<ServerOpsDatabaseAgentPolicy>
  set(input: ServerOpsDatabaseAgentPolicyUpdate): Promise<ServerOpsDatabaseAgentPolicy>
  onChanged?: (listener: (policy: ServerOpsDatabaseAgentPolicy) => void) => () => void
}

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
  databasePolicy: ServerOpsDatabaseAgentPolicy | null
  databaseExclusions: ServerOpsDatabaseAgentExclusion[]
  databaseLoading: boolean
  databaseError: string | null
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
  return { sessionId: null, projectId: '', access: null, resources: [], databasePolicy: null, databaseExclusions: [], databaseLoading: false, databaseError: null, open: false, loading: false, saving: false, impact: null, impactLoading: false, confirming: false, error: null }
}

/** 创建实际授权页面使用的状态机；所有 IPC 迟到结果受同一动作代次约束。 */
export function createServerOpsAgentReadController(options: { api: ServerOpsAgentReadAccessApi; policyApi?: ServerOpsDatabaseAgentPolicyApi; publish: (state: ServerOpsAgentReadProjection) => void }) {
  /** 状态只存在于当前挂载页面；权限事实仍由主进程掌握。 */
  let state = emptyServerOpsAgentReadProjection()
  /** 广播、目标切换与卸载均使旧回执失效。 */
  let epoch = 0
  /** 两份独立读取分别计代次，任一广播不得卡住另一份加载态。 */
  let policyReadEpoch = 0
  let impactReadEpoch = 0
  /** 同一主进程有序授权事件的已见最高代次。 */
  let knownRevision = 0
  /** 卸载不撤销权限，只阻止该页面继续写状态。 */
  let active = true
  /** 确认旧 SSH 影响后才能按冻结的数据库和服务器草稿执行保存。 */
  let pendingSave: { grant: ServerOpsAgentReadGrant | null; policy: ServerOpsDatabaseAgentPolicyUpdate | null } | null = null
  /** 自身策略广播可能早于 set 回执，不能中断后续服务器写入。 */
  let savingPolicy: ServerOpsDatabaseAgentPolicyUpdate | null = null
  /** 保存阶段用于区分 SSH 广播与已发出的禁用策略回执。 */
  let savingStage: 'policy' | 'server' | null = null
  /** 两阶段保存期间直到终态都需要识别外部 SSH 变更。 */
  let savingIncludesPolicy = false
  /** 冻结的提交范围与广播比较，外部变更不得冒充自身保存。 */
  let savingGrant: ServerOpsAgentReadGrant | null = null
  /** SSH 范围在保存期间变化时，保留已完成的数据库提交结果。 */
  let savingConflict = false
  /** 每次发布独立副本，不让 React/调用者修改内部快照。 */
  const publish = (): void => { if (active) options.publish(structuredClone(state)) }
  /** 把匹配会话的主进程回执应用为权威事实。 */
  const adopt = (access: ServerOpsAgentReadAccess | null): void => {
    state.access = access?.sessionId === state.sessionId ? structuredClone(access) : null
    state.resources = state.open ? prepareServerOpsReadEditorResources(state.access?.resources ?? []) : structuredClone(state.access?.resources ?? [])
    if (state.access) knownRevision = Math.max(knownRevision, state.access.revision)
  }
  /** 使用已展示的影响 token 提交；CAS 冲突刷新预览但保留草稿。 */
  const persist = async (save: { grant: ServerOpsAgentReadGrant | null; policy: ServerOpsDatabaseAgentPolicyUpdate | null }): Promise<void> => {
    const revision = ++epoch
    const token = state.impact?.token
    state.saving = true; state.confirming = false; state.error = null; state.databaseError = null; pendingSave = null
    savingPolicy = save.policy; savingGrant = save.grant; savingIncludesPolicy = Boolean(save.policy)
    savingStage = save.policy ? 'policy' : 'server'; savingConflict = false; publish()
    let policySaved = false
    try {
      if (save.policy) {
        if (!options.policyApi) throw new Error('数据库禁用表接口不可用')
        const policy = await options.policyApi.set(save.policy)
        if (!active || epoch !== revision) return
        state.databasePolicy = structuredClone(policy)
        state.databaseExclusions = structuredClone(policy.exclusions)
        policySaved = true
        savingPolicy = null
      }
      if (savingConflict) {
        state.error = '禁用表已保存；服务器授权已变化，请关闭后重新打开检查'
        return
      }
      if (save.grant) {
        savingStage = 'server'
        const access = await options.api.set(save.grant, token)
        if (!active || epoch !== revision) return
        if (savingConflict) {
          try {
            const latest = await options.api.get(save.grant.sessionId)
            if (!active || epoch !== revision) return
            adopt(latest)
          } catch { /* 广播中的授权仍比本次旧请求可靠。 */ }
        }
        else adopt(access)
      }
      if (savingConflict) state.error = '禁用表已保存；服务器授权已变化，请关闭后重新打开检查'
      else state.open = false
    } catch (error) {
      if (!active || epoch !== revision) return
      const message = error instanceof Error ? error.message : '保存授权失败'
      const conflict = message.includes('SERVER_OPS_ACCESS_IMPACT_CHANGED')
      if (savingConflict && policySaved && save.grant) {
        try {
          const latest = await options.api.get(save.grant.sessionId)
          if (!active || epoch !== revision) return
          adopt(latest)
        } catch { /* 保留最近的授权广播。 */ }
        if (!active || epoch !== revision) return
      }
      state.error = policySaved && savingConflict ? '禁用表已保存；服务器授权已变化，请关闭后重新打开检查'
        : policySaved ? `禁用表已保存；服务器授权失败：${message}`
        : savingConflict ? `禁用表保存失败：${message}；服务器授权已变化，请关闭后重新打开检查`
        : message.includes('SERVER_OPS_DATABASE_AGENT_POLICY_CONFLICT') ? '禁用表已在其他窗口更新，请关闭后重新打开检查'
        : conflict ? '授权范围已变化，请检查新的影响范围后重试'
        : error instanceof Error && error.message.includes('SERVER_OPS_READ_ACCESS_INVALID') ? '后台尚未接受新的授权格式，请完整重启客户端后重试'
          : message
      if (conflict && !savingConflict && options.api.impact && save.grant) {
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
      if (active && epoch === revision) { state.saving = false; savingPolicy = null; savingStage = null; savingGrant = null; savingIncludesPolicy = false; savingConflict = false; publish() }
    }
  }
  return {
    /** 供实际组件与行为测试读取隔离投影。 */
    snapshot: (): ServerOpsAgentReadProjection => structuredClone(state),
    /** StrictMode 重新 setup 可复用同一控制器。 */
    activate(): void { active = true },
    /** 卸载使全部 get/save 回执失效。 */
    dispose(): void { active = false; epoch += 1; policyReadEpoch += 1; impactReadEpoch += 1; pendingSave = null; savingPolicy = null; savingStage = null; savingGrant = null; savingIncludesPolicy = false; savingConflict = false },
    /** 切换项目保留同会话权限，切换会话立即清除旧显示与编辑。 */
    async select(sessionId: string | null, projectId: string): Promise<void> {
      const sameSession = state.sessionId === sessionId
      if (!sameSession) knownRevision = 0
      pendingSave = null; savingPolicy = null; savingStage = null; savingGrant = null; savingIncludesPolicy = false; savingConflict = false
      const needsRead = !sameSession || state.loading || state.error !== null || state.projectId === ''
      const revision = ++epoch
      policyReadEpoch += 1; impactReadEpoch += 1
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
      if (!active || (!state.sessionId && !options.policyApi) || state.loading || state.saving) return
      epoch += 1
      const policyRevision = ++policyReadEpoch
      impactReadEpoch += 1
      state.open = true; state.error = null; state.resources = prepareServerOpsReadEditorResources(state.access?.resources ?? [], databaseTargets)
      state.impact = null; state.impactLoading = false; state.confirming = false; pendingSave = null
      state.databaseError = null
      state.databaseLoading = Boolean(options.policyApi)
      state.databaseExclusions = []
      state.databasePolicy = null
      publish()
      if (options.policyApi) {
        void options.policyApi.get().then((policy) => {
          if (!active || policyReadEpoch !== policyRevision || !state.open) return
          state.databasePolicy = structuredClone(policy)
          state.databaseExclusions = structuredClone(policy.exclusions)
        }, () => {
          if (!active || policyReadEpoch !== policyRevision || !state.open) return
          state.databaseError = '读取禁用表失败，请重试；已有禁用规则不会改变'
        }).finally(() => {
          if (active && policyReadEpoch === policyRevision) { state.databaseLoading = false; publish() }
        })
      }
    },
    /** 打开编辑器时取得影响快照；刷新后 token 必须重新由用户确认。 */
    async loadImpact(): Promise<void> {
      if (!active || !state.open || !state.sessionId || !options.api.impact) return
      const revision = ++impactReadEpoch
      state.impactLoading = true; state.confirming = false; pendingSave = null; publish()
      try {
        const impact = await options.api.impact()
        if (!active || impactReadEpoch !== revision || !state.open) return
        state.impact = impact
      } catch (error) {
        if (!active || impactReadEpoch !== revision || !state.open) return
        state.impact = null
        state.error = error instanceof Error ? error.message : '读取授权影响失败'
      } finally {
        if (active && impactReadEpoch === revision) { state.impactLoading = false; publish() }
      }
    },
    /** 取消、Escape 和遮罩关闭共用同一草稿收口。 */
    close(): void {
      if (state.saving) return
      epoch += 1
      policyReadEpoch += 1; impactReadEpoch += 1
      state.open = false; state.resources = structuredClone(state.access?.resources ?? []); state.error = null
      state.databaseExclusions = structuredClone(state.databasePolicy?.exclusions ?? [])
      state.databaseLoading = false; state.databaseError = null
      state.impact = null; state.impactLoading = false; state.confirming = false; pendingSave = null
      publish()
    },
    /** 只编辑草稿，保存前再做全量严格合同校验。 */
    edit(resources: ServerOpsAgentReadResource[]): void {
      if (!state.open || state.loading || state.saving || state.confirming) return
      state.resources = structuredClone(resources); state.error = null; pendingSave = null; publish()
    },
    /** 数据库禁用项独立编辑，禁止读取失败时以空名单提交。 */
    editDatabase(exclusions: ServerOpsDatabaseAgentExclusion[]): void {
      if (!state.open || state.databaseLoading || !state.databasePolicy || state.saving || state.confirming) return
      state.databaseExclusions = structuredClone(exclusions); state.error = null; state.databaseError = null; publish()
    },
    /** 外部策略更新立即换掉旧草稿；自身提交广播则保留保存链。 */
    databaseChanged(policy: ServerOpsDatabaseAgentPolicy): void {
      if (!active || (state.databasePolicy && policy.revision <= state.databasePolicy.revision)) return
      const own = state.saving && savingPolicy && policy.revision === savingPolicy.expectedRevision + 1
        && JSON.stringify(policy.exclusions) === JSON.stringify(savingPolicy.exclusions.filter((entry) => entry.excludedTables.length > 0))
      state.databasePolicy = structuredClone(policy)
      state.databaseExclusions = structuredClone(policy.exclusions)
      if (!own) {
        // 全局策略广播不属于 SSH 首次读取；只中断当前确认或保存事务。
        if (state.saving || state.confirming || pendingSave) epoch += 1
        pendingSave = null; state.confirming = false; state.saving = false
        if (state.open) state.error = '禁用表已在其他窗口更新，请检查新范围'
      }
      policyReadEpoch += 1
      state.databaseLoading = false; publish()
    },
    /** 广播优先于 get/save；保存自身的广播也可立即关闭弹窗而不等待 IPC 回执。 */
    changed(event: ServerOpsAgentReadChanged): void {
      if (event.current?.sessionId !== state.sessionId && event.previous?.sessionId !== state.sessionId) return
      const revision = Math.max(event.current?.revision ?? 0, event.previous?.revision ?? 0)
      if (!active || revision < knownRevision) return
      const ownServerBroadcast = state.saving && savingStage === 'server' && savingGrant
        && JSON.stringify(event.current?.resources ?? []) === JSON.stringify(savingGrant.resources)
      if (state.saving && savingIncludesPolicy && (!savingGrant || savingStage === 'policy' || !ownServerBroadcast)) {
        knownRevision = revision
        if (savingGrant) savingConflict = true
        impactReadEpoch += 1
        pendingSave = null; state.confirming = false; state.impact = null; state.impactLoading = false
        adopt(event.current)
        state.loading = false; publish()
        return
      }
      epoch += 1; knownRevision = revision
      impactReadEpoch += 1
      pendingSave = null; state.confirming = false; state.impact = null; state.impactLoading = false
      if (state.saving) state.open = false
      adopt(event.current)
      state.loading = false; state.saving = false; state.error = null
      publish()
      if (state.open && options.api.impact) {
        /** 在途编辑遇到外部缩权时刷新预览；代次避免跨会话回填。 */
        const refreshRevision = ++impactReadEpoch
        state.impactLoading = true; publish()
        void options.api.impact().then((impact) => {
          if (active && impactReadEpoch === refreshRevision && state.open) state.impact = impact
        }).catch(() => {
          if (active && impactReadEpoch === refreshRevision && state.open) state.error = '刷新授权影响失败，请重新打开授权编辑器'
        }).finally(() => {
          if (active && impactReadEpoch === refreshRevision) { state.impactLoading = false; publish() }
        })
      }
    },
    /** 用户确认覆盖旧操作授权后，提交确认时锁定的原始草稿。 */
    async confirmSave(): Promise<void> {
      if (!active || !state.open || !state.confirming || !pendingSave) return
      await persist(pendingSave)
    },
    /** 取消影响确认时只放弃待提交副本，保留可编辑草稿。 */
    cancelConfirmation(): void {
      pendingSave = null; state.confirming = false; publish()
    },
    /** 保存完整草稿；数据库卡片传入 renewServerAccess=false，避免续期其他连接。 */
    async save(resources = state.resources, includeDatabase = true, renewServerAccess = true): Promise<void> {
      if (!active || state.loading || state.databaseLoading || state.saving || !state.open || state.confirming) return
      if (includeDatabase && state.databaseError) { state.error = state.databaseError; publish(); return }
      let policy: ServerOpsDatabaseAgentPolicyUpdate | null = null
      if (includeDatabase && options.policyApi) {
        if (!state.databasePolicy) { state.error = '读取禁用表失败，请重新打开'; publish(); return }
        if (JSON.stringify(state.databaseExclusions) !== JSON.stringify(state.databasePolicy.exclusions)) {
          try { policy = parseServerOpsDatabaseAgentPolicyUpdate({ expectedRevision: state.databasePolicy.revision, exclusions: state.databaseExclusions }) }
          catch { state.error = '请检查禁用表范围'; publish(); return }
        }
      }
      const serverResources = resources.filter((resource) => resource.kind === 'ssh' || resource.kind === 'redis')
      const originalServer = state.access?.resources.filter((resource) => resource.kind === 'ssh' || resource.kind === 'redis') ?? []
      const serverChanged = JSON.stringify(serverResources) !== JSON.stringify(originalServer)
      const shouldWriteServer = Boolean(state.sessionId && (serverChanged || (renewServerAccess && !policy && serverResources.length > 0)))
      let grant: ServerOpsAgentReadGrant | null = null
      if (shouldWriteServer && state.sessionId) {
        try { grant = parseServerOpsAgentReadGrant({ sessionId: state.sessionId, resources: serverResources }) }
        catch { state.error = '请检查服务器授权范围：最多 32 个连接'; publish(); return }
      }
      if (grant && options.api.impact && !state.impact) {
        state.error = state.impactLoading ? '请等待授权影响范围加载完成' : '授权影响范围不可用，请关闭后重新打开检查'; publish(); return
      }
      const change = { grant, policy }
      if (grant && grant.resources.length > 0 && state.impact?.legacy) {
        pendingSave = structuredClone(change); state.confirming = true; state.error = null; publish(); return
      }
      if (!grant && !policy) { state.open = false; publish(); return }
      await persist(change)
    },
  }
}
