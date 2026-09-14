import { createHash } from 'node:crypto'
import { parseCanvasOrchestrationRequest, parseCanvasOrchestrationRecord } from '@proma/shared'
import type { CanvasAgentTarget, CanvasDocument, CanvasOrchestrationFollowUp, CanvasOrchestrationRecord, CanvasOrchestrationRequest, CanvasOrchestrationStep, CanvasTarget } from '@proma/shared'
import type { CanvasAgentExecutionResult } from './canvas-agent-execution-service'
import type { CanvasExecutionOwnership } from './canvas-execution-ownership'

/** 普通会话的可信委托身份，由工具上下文提供。 */
export interface CanvasOrchestrationOwner extends CanvasTarget { sessionId: string }
/** 单次编排运行的可信身份，不接受模型填写 session 或启动时间。 */
export interface CanvasOrchestrationActor extends CanvasOrchestrationOwner { orchestrationId: string; runStartedAt: number }
/** 专业 child 的运行身份由 dispatch 签发，startedAt 独立于 coordinator 的启动时间。 */
export interface CanvasOrchestrationBranchAccess {
  target: CanvasAgentTarget
  parentSessionId: string
  orchestrationId: string
  stepId: string
  startedAt: number
  userMessageUuid: string
}
/** 普通会话沿原委托提交的一次幂等校正。 */
export interface CanvasOrchestrationFollowUpInput {
  id: string
  expectedRevision: number
  instruction: string
  supersedesId?: string
}
/** 委托服务只复用现有存储、节点与运行能力。 */
export interface CanvasOrchestrationServiceDependencies {
  /** 生产组合注入共同准入，持久记录创建前同步排除旧工作流接管。 */
  executionOwnership?: CanvasExecutionOwnership
  store: {
    get(target: CanvasTarget): CanvasOrchestrationRecord | null
    create(record: CanvasOrchestrationRecord): CanvasOrchestrationRecord
    save(target: CanvasTarget, expectedRevision: number, record: CanvasOrchestrationRecord): CanvasOrchestrationRecord
  }
  authorizeOwner(owner: CanvasOrchestrationOwner): void
  loadCanvas(target: CanvasTarget): CanvasDocument
  createAgent(record: CanvasOrchestrationRecord, step?: CanvasOrchestrationStep): Promise<CanvasAgentTarget>
  executeCoordinator(record: CanvasOrchestrationRecord, signal: AbortSignal): Promise<CanvasAgentExecutionResult>
  executeSpecialist(
    record: CanvasOrchestrationRecord,
    step: CanvasOrchestrationStep,
    signal: AbortSignal,
    access: CanvasOrchestrationBranchAccess,
  ): Promise<CanvasAgentExecutionResult>
  recoverSpecialist(
    record: CanvasOrchestrationRecord,
    step: CanvasOrchestrationStep,
  ): Promise<'completed' | 'missing' | 'changed' | 'running'>
  recoverCoordinator(
    record: CanvasOrchestrationRecord,
    followUp: CanvasOrchestrationFollowUp,
  ): Promise<'completed' | 'missing' | 'changed' | 'running'>
  isCoordinatorBusy(record: CanvasOrchestrationRecord): boolean
  assertOutputOwnership(
    access: CanvasOrchestrationBranchAccess,
    nodeId: string,
    sourceToolCallId: string,
  ): Promise<void> | void
  readNodeIdentity(target: CanvasTarget, nodeId: string): Promise<string>
  verifyDelivery(record: CanvasOrchestrationRecord): Promise<boolean>
  onChanged(record: CanvasOrchestrationRecord): void
  now?: () => number
}

/** 终态只由任务验收或明确取消产生。 */
function terminal(record: CanvasOrchestrationRecord): boolean {
  return record.status === 'completed' || record.status === 'cancelled'
}

/** 只比较专业工作定义，不把运行状态、评审说明或证据当作设计输入。 */
function definition(step: CanvasOrchestrationStep): string {
  return JSON.stringify([
    step.id, step.title, step.role, step.instruction, step.dependsOn,
    step.inputNodeIds, step.outputNodeIds, step.criteria,
  ])
}

/** 创建可恢复的单画布编排服务；等待时不运行额外的轮询或模型调用。 */
export function createCanvasOrchestrationService(dependencies: CanvasOrchestrationServiceDependencies) {
  /** 进程内只保存活动调用与取消信号，持久事实始终从 Store 读取。 */
  const active = new Map<string, { controller: AbortController; promise: Promise<CanvasOrchestrationRecord> }>()
  /** 仅当前进程内正在执行的专业 child 拥有分支 token；重启后旧回调自然失效。 */
  const branches = new Map<string, CanvasOrchestrationBranchAccess>()
  /** child 启动时间保持单调，不能误用 coordinator 的 runStartedAt。 */
  let lastBranchStartedAt = 0
  /** 可替换时钟便于验证旧运行代次和重启。 */
  const now = dependencies.now ?? Date.now
  /** 以画布隔离活动运行，防止第二个委托同时接管结构。 */
  const key = (target: CanvasTarget): string => JSON.stringify([target.projectId, target.canvasId])
  /** 专业分支身份包含 child 节点和自身运行时间。 */
  const branchKey = (access: CanvasOrchestrationBranchAccess): string => JSON.stringify([
    access.target.projectId, access.target.canvasId, access.target.nodeId, access.parentSessionId,
    access.orchestrationId, access.stepId, access.startedAt, access.userMessageUuid,
  ])
  /** 读取当前记录并拒绝悬空委托。 */
  const requireRecord = (target: CanvasTarget): CanvasOrchestrationRecord => {
    const record = dependencies.store.get(target)
    if (!record) throw new Error('CANVAS_ORCHESTRATION_NOT_FOUND')
    return record
  }
  /** 广播只投影已落盘事实，观察者失败不改变提交结果。 */
  const publish = (record: CanvasOrchestrationRecord): CanvasOrchestrationRecord => {
    try { dependencies.onChanged(record) } catch { /* 界面可通过原记录补读。 */ }
    return record
  }
  /** 所有变更沿 Store CAS，不跨异步操作持有旧对象覆盖新计划。 */
  const save = (record: CanvasOrchestrationRecord, patch: Partial<CanvasOrchestrationRecord>): CanvasOrchestrationRecord => publish(
    dependencies.store.save(record, record.revision, parseCanvasOrchestrationRecord({ ...record, ...patch,
      revision: record.revision + 1, updatedAt: now() })),
  )
  /** 复验委托的原始普通会话，防止解绑或撤权后沿旧记录继续。 */
  const ownerRecord = (owner: CanvasOrchestrationOwner): CanvasOrchestrationRecord => {
    dependencies.authorizeOwner(owner)
    const record = requireRecord(owner)
    if (record.ownerSessionId !== owner.sessionId) throw new Error('CANVAS_ORCHESTRATION_OWNER_MISMATCH')
    return record
  }
  /** 兼容旧三参数 resume 调用，同时让新入口显式区分校正与取消信号。 */
  const isAbortSignal = (value: CanvasOrchestrationFollowUpInput | AbortSignal | undefined): value is AbortSignal => (
    !!value && typeof value === 'object' && 'aborted' in value && 'addEventListener' in value
  )
  /** 模式、会话、委托和运行代次共同决定当前写入者。 */
  const actorRecord = (actor: CanvasOrchestrationActor): CanvasOrchestrationRecord => {
    const record = requireRecord(actor)
    dependencies.authorizeOwner({ ...actor, sessionId: record.ownerSessionId })
    if (record.id !== actor.orchestrationId || record.coordinatorSessionId !== actor.sessionId
      || record.runStartedAt !== actor.runStartedAt || terminal(record)
      || !active.has(key(record))) throw new Error('CANVAS_ORCHESTRATION_ACCESS_DENIED')
    return record
  }
  /** 真实节点身份按有限列表获取，避免缓存媒体字节。 */
  const identities = async (target: CanvasTarget, nodeIds: string[]) => Promise.all(
    [...new Set(nodeIds)].map(async nodeId => {
      const rawIdentity = await dependencies.readNodeIdentity(target, nodeId)
      /** 只持久化固定长度 hash，避免外部实现把正文或路径塞入计划记录。 */
      const identity = /^[a-f0-9]{64}$/.test(rawIdentity)
        ? rawIdentity
        : createHash('sha256').update(rawIdentity).digest('hex')
      return { nodeId, identity }
    }),
  )
  /** 一项工作的有效输入包括直接输入和所有已声明上游产物。 */
  const effectiveInputNodeIds = (record: CanvasOrchestrationRecord, step: CanvasOrchestrationStep): string[] => [
    ...new Set([
      ...step.inputNodeIds,
      ...record.steps.filter(candidate => step.dependsOn.includes(candidate.id)).flatMap(candidate => candidate.outputNodeIds),
    ]),
  ]
  /** 按上游到下游顺序收集当前步骤的可达祖先，不读取或复验无关分支。 */
  const dependencyAncestors = (record: CanvasOrchestrationRecord, step: CanvasOrchestrationStep): CanvasOrchestrationStep[] => {
    /** 计划步骤索引用于沿显式依赖边回溯。 */
    const stepsById = new Map(record.steps.map(candidate => [candidate.id, candidate]))
    /** 已排序祖先保证最早失效的根先被处理。 */
    const ordered: CanvasOrchestrationStep[] = []
    /** 已访问集合避免共享祖先重复读取版本。 */
    const visited = new Set<string>()
    /** 深度优先遍历单个祖先及其上游。 */
    const visit = (stepId: string): void => {
      if (visited.has(stepId)) return
      visited.add(stepId)
      /** 当前显式依赖对应的计划步骤。 */
      const dependency = stepsById.get(stepId)
      if (!dependency) return
      dependency.dependsOn.forEach(visit)
      ordered.push(dependency)
    }
    step.dependsOn.forEach(visit)
    return ordered
  }
  /** 读取失败也表示旧证据不可继续信任。 */
  const versionsMatch = async (
    record: CanvasOrchestrationRecord,
    versions: CanvasOrchestrationStep['inputVersions'] | CanvasOrchestrationStep['outputVersions'],
    expectedNodeIds: string[],
  ): Promise<boolean> => {
    /** 空输入用显式空数组证明；缺失或只覆盖部分节点的旧记录不能冒充已核验。 */
    if (!versions || versions.length !== new Set(expectedNodeIds).size
      || expectedNodeIds.some(nodeId => !versions.some(version => version.nodeId === nodeId))) return false
    try {
      return JSON.stringify(await identities(record, versions.map(version => version.nodeId))) === JSON.stringify(versions)
    } catch {
      return false
    }
  }
  /** 完成前后统一复验全部步骤；失效时持久标记根步骤并按依赖重置下游。 */
  const assertStepVersions = async (actor: CanvasOrchestrationActor, record: CanvasOrchestrationRecord): Promise<void> => {
    for (const step of record.steps) {
      const inputsValid = await versionsMatch(record, step.inputVersions, effectiveInputNodeIds(record, step))
      const outputsValid = await versionsMatch(record, step.outputVersions, step.outputNodeIds)
      if (inputsValid && outputsValid) continue
      const latest = actorRecord(actor)
      if (latest.revision !== record.revision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
      invalidateStepAndDownstream(
        latest,
        step.id,
        inputsValid ? 'needs-review' : 'blocked',
        inputsValid ? '产物版本已改变，需要重新评审。' : '输入版本已改变，已有产物需重新核对。',
      )
      throw new Error('CANVAS_ORCHESTRATION_EVIDENCE_STALE')
    }
  }
  /** 检查引用属于本画布；计划中的未来产物用空映射表达。 */
  const validateNodes = (record: CanvasOrchestrationRecord, steps: CanvasOrchestrationStep[]): void => {
    const nodes = new Map(dependencies.loadCanvas(record).nodes.map(node => [node.id, node]))
    const stepsById = new Map(steps.map(step => [step.id, step]))
    /** 每个步骤独占专业 Agent，避免后一次运行覆盖前一步的正式输出指针。 */
    const assignedAgentNodeIds = new Set<string>()
    /** 每个产物只由一个步骤负责，后续步骤通过依赖把它作为输入。 */
    const assignedOutputNodeIds = new Set<string>()
    for (const step of steps) {
      if ([...step.inputNodeIds, ...step.outputNodeIds].some(id => !nodes.has(id))) throw new Error('CANVAS_ORCHESTRATION_NODE_MISSING')
      if (step.outputNodeIds.some(nodeId => assignedOutputNodeIds.has(nodeId))) throw new Error('CANVAS_ORCHESTRATION_OUTPUT_DUPLICATE')
      step.outputNodeIds.forEach(nodeId => assignedOutputNodeIds.add(nodeId))
      /** 专业分支必须能完整冻结并读取所有直接输入与依赖产物。 */
      const effectiveInputNodeIds = new Set([
        ...step.inputNodeIds,
        ...step.dependsOn.flatMap(dependencyId => stepsById.get(dependencyId)?.outputNodeIds ?? []),
      ])
      if (effectiveInputNodeIds.size > 128) throw new Error('CANVAS_ORCHESTRATION_INPUT_SCOPE_TOO_LARGE')
      if (step.agentNodeId && (nodes.get(step.agentNodeId)?.kind !== 'agent' || step.agentNodeId === record.coordinatorNodeId)) {
        throw new Error('CANVAS_ORCHESTRATION_AGENT_INVALID')
      }
      if (step.agentNodeId && assignedAgentNodeIds.has(step.agentNodeId)) throw new Error('CANVAS_ORCHESTRATION_AGENT_DUPLICATE')
      if (step.agentNodeId) assignedAgentNodeIds.add(step.agentNodeId)
      if (record.request.intent === 'review') {
        const previousOutputs = new Set(record.steps.find(candidate => candidate.id === step.id)?.outputNodeIds ?? [])
        if (step.outputNodeIds.some(id => record.request.referenceNodeIds.includes(id)
          || (nodes.get(id)?.kind !== 'agent' && !previousOutputs.has(id)))) {
          throw new Error('CANVAS_ORCHESTRATION_REVIEW_WRITE_DENIED')
        }
      }
    }
  }
  /** 旧记录首次恢复时补入按原 intent 计算的 Host 预算，之后只沿 Store 单调推进。 */
  const ensureBudget = (record: CanvasOrchestrationRecord): CanvasOrchestrationRecord => record.budget
    ? record
    : save(record, { budget: {
      maxAgentRuns: 32,
      agentRunsUsed: 0,
      maxMediaRuns: record.request.intent === 'produce' || record.request.intent === 'revise' ? 16 : 0,
      mediaRunsUsed: 0,
    } })
  /** 恢复时对账 running 步骤与版本证据；只更新状态，不自动再次启动专业运行。 */
  const reconcile = async (record: CanvasOrchestrationRecord): Promise<CanvasOrchestrationRecord> => {
    const nodes = new Map(dependencies.loadCanvas(record).nodes.map(node => [node.id, node]))
    const steps = record.steps.map(step => ({ ...step }))
    const staleRoots = new Set<string>()
    let changed = false
    for (const step of steps) {
      if (step.status === 'running') {
        const inputsValid = await versionsMatch(record, step.inputVersions, effectiveInputNodeIds(record, step))
        const agent = step.agentNodeId ? nodes.get(step.agentNodeId) : undefined
        if (!inputsValid) {
          step.status = 'blocked'
          step.note = '输入版本已改变，恢复后不能沿用旧运行结果。'
          delete step.outputVersions
          staleRoots.add(step.id)
        } else if ((step.outputVersions?.length ?? 0) > 0) {
          step.status = 'needs-review'
          step.note = '恢复时发现已有登记产物，等待重新评审。'
        } else {
          /** 只接受匹配持久执行锚点的正式输出，不能按当前指针猜测来源。 */
          let recovery: 'completed' | 'missing' | 'changed' | 'running' = 'missing'
          if (step.execution) {
            try { recovery = await dependencies.recoverSpecialist(record, step) } catch { /* 检查失败按缺失处理。 */ }
          }
          if (recovery === 'completed' && agent?.kind === 'agent' && agent.outputPointer) {
            step.outputNodeIds = [...new Set([...step.outputNodeIds, agent.id])]
            step.outputVersions = await identities(record, step.outputNodeIds)
            step.status = 'needs-review'
            step.note = '恢复时发现已有专业产物，已先登记并等待评审。'
          } else {
            step.status = 'blocked'
            step.note = recovery === 'changed'
              ? 'Agent 正式输出已改变或不属于本次专业分派，需要人工复核。'
              : recovery === 'running'
                ? '上次专业运行仍未形成可确认终态；不会自动等待或重跑。'
                : '上次专业运行中断，未发现可确认的正式输出；不会自动重跑。'
          }
        }
        changed = true
      }
    }
    for (const step of steps) {
      if (step.status !== 'completed' && step.status !== 'needs-review') continue
      if (!await versionsMatch(record, step.inputVersions, effectiveInputNodeIds(record, step))) {
        step.status = 'blocked'
        step.note = '输入版本已改变，已有产物需重新核对。'
        delete step.outputVersions
        staleRoots.add(step.id)
        changed = true
        continue
      }
      if (!await versionsMatch(record, step.outputVersions, step.outputNodeIds)) {
        step.status = 'needs-review'
        step.note = '产物版本已改变，需要重新评审。'
        staleRoots.add(step.id)
        changed = true
      }
    }
    /** 任一失效根的所有后继都回到计划态，保留节点本身供局部复用。 */
    const affected = new Set<string>()
    for (let pass = 0; pass < steps.length; pass += 1) {
      for (const step of steps) {
        if (step.dependsOn.some(id => staleRoots.has(id) || affected.has(id))) affected.add(step.id)
      }
    }
    for (const step of steps) {
      if (!affected.has(step.id)) continue
      step.status = 'planned'
      step.note = '上游版本已改变，需要按影响范围重新确认。'
      delete step.inputVersions
      delete step.outputVersions
      changed = true
    }
    return changed ? save(record, { steps }) : record
  }
  /** 复验当前专业 child 的父编排、步骤、节点及独立运行时间。 */
  const assertBranch = (access: CanvasOrchestrationBranchAccess): {
    record: CanvasOrchestrationRecord
    step: CanvasOrchestrationStep
  } => {
    const signed = branches.get(branchKey(access))
    if (!signed
      || !Number.isSafeInteger(access.startedAt) || access.startedAt < 1) {
      throw new Error('CANVAS_ORCHESTRATION_BRANCH_ACCESS_DENIED')
    }
    const record = requireRecord(access.target)
    dependencies.authorizeOwner({ ...access.target, sessionId: record.ownerSessionId })
    const step = record.steps.find(candidate => candidate.id === access.stepId)
    const node = dependencies.loadCanvas(record).nodes.find(candidate => candidate.id === access.target.nodeId)
    if (record.id !== access.orchestrationId || record.coordinatorSessionId !== access.parentSessionId
      || terminal(record) || !active.has(key(record)) || !step || step.status !== 'running'
      || step.agentNodeId !== access.target.nodeId || node?.kind !== 'agent') {
      throw new Error('CANVAS_ORCHESTRATION_BRANCH_ACCESS_DENIED')
    }
    return { record, step }
  }
  /** 证据失效时更新根步骤，并递归重置所有下游而不删除已生成节点。 */
  const invalidateStepAndDownstream = (
    record: CanvasOrchestrationRecord,
    stepId: string,
    status: 'blocked' | 'needs-review',
    note: string,
  ): CanvasOrchestrationRecord => {
    const affected = new Set([stepId])
    for (let pass = 0; pass < record.steps.length; pass += 1) {
      for (const step of record.steps) {
        if (step.dependsOn.some(id => affected.has(id))) affected.add(step.id)
      }
    }
    return save(record, { steps: record.steps.map(step => {
      if (step.id === stepId) {
        const invalidated = { ...step, status, note }
        delete invalidated.outputVersions
        return invalidated
      }
      if (!affected.has(step.id)) return step
      const reset = { ...step, status: 'planned' as const, note: '上游版本已改变，需要按影响范围重新确认。' }
      delete reset.inputVersions
      delete reset.outputVersions
      return reset
    }) })
  }
  /** 专业分派前复验当前分支全部祖先，并在每轮异步读取后拒绝过期计划写入。 */
  const assertDependencyVersions = async (
    actor: CanvasOrchestrationActor,
    record: CanvasOrchestrationRecord,
    ancestors: CanvasOrchestrationStep[],
  ): Promise<void> => {
    for (const dependency of ancestors) {
      /** 祖先自身的原始输入版本也决定其已验收产物是否仍可复用。 */
      const inputsValid = await versionsMatch(record, dependency.inputVersions, effectiveInputNodeIds(record, dependency))
      /** 异步读取后的最新记录用于 CAS，避免覆盖同时发生的新计划。 */
      let latest = actorRecord(actor)
      if (latest.revision !== record.revision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
      if (!inputsValid) {
        invalidateStepAndDownstream(latest, dependency.id, 'blocked', '输入版本已改变，已有产物需重新核对。')
        throw new Error('CANVAS_ORCHESTRATION_EVIDENCE_STALE')
      }
      /** 祖先正式产物版本必须与其通过评审时一致。 */
      const outputsValid = await versionsMatch(record, dependency.outputVersions, dependency.outputNodeIds)
      latest = actorRecord(actor)
      if (latest.revision !== record.revision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
      if (!outputsValid) {
        invalidateStepAndDownstream(latest, dependency.id, 'needs-review', '产物版本已改变，需要重新评审。')
        throw new Error('CANVAS_ORCHESTRATION_EVIDENCE_STALE')
      }
    }
  }
  /** 启动同一委托的一轮协调，保留旧计划、预算与已产生的产物。 */
  const launch = (owner: CanvasOrchestrationOwner, signal?: AbortSignal): Promise<CanvasOrchestrationRecord> => {
    const existing = active.get(key(owner))
    if (existing) return existing.promise
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', abort, { once: true })
    /** 先登记活动身份再开始任何异步节点创建。 */
    const promise = Promise.resolve().then(async () => {
      let record = ownerRecord(owner)
      if (terminal(record)) return record
      if (controller.signal.aborted) return save(record, { status: 'cancelled', summary: '用户已停止编排。' })
      const interruptedFollowUp = record.followUps?.at(-1)
      if (interruptedFollowUp?.status === 'started') {
        let recovery: 'completed' | 'missing' | 'changed' | 'running' = 'missing'
        try { recovery = await dependencies.recoverCoordinator(record, interruptedFollowUp) } catch { /* 不可信日志按缺失处理。 */ }
        record = ownerRecord(owner)
        if (recovery === 'completed') {
          return save(record, { status: 'waiting', summary: '上次校正已送达并完成，等待核对当前计划与交付。',
            followUps: record.followUps!.map(item => item.id === interruptedFollowUp.id ? { ...item, status: 'delivered' as const } : item) })
        }
        if (recovery === 'running') return record
        return save(record, { status: 'blocked', summary: recovery === 'changed'
          ? '校正运行后已有其它会话输入，不能自动归属或重发。'
          : '校正运行中断且没有可确认终态；保留原执行身份，不自动重复扣额或重发。' })
      }
      /** 升级前可能已有两套非终态记录；恢复先拒绝竞争，查询与取消仍沿原入口可用。 */
      dependencies.executionOwnership?.run(owner, 'orchestration', () => undefined)
      if (!record.coordinatorNodeId) {
        const target = await dependencies.createAgent(record)
        record = ownerRecord(owner)
        if (terminal(record)) return record
        const node = dependencies.loadCanvas(record).nodes.find(node => node.id === target.nodeId)
        if (!node || node.kind !== 'agent') throw new Error('CANVAS_ORCHESTRATION_AGENT_INVALID')
        record = save(record, { coordinatorNodeId: node.id, coordinatorSessionId: node.agentSessionId })
      }
      record = ensureBudget(record)
      record = await reconcile(record)
      /** 对账包含异步证据读取；扣额与启动前重新授权，并拒绝覆盖期间产生的新记录。 */
      const freshRecord = ownerRecord(owner)
      if (freshRecord.id !== record.id || freshRecord.revision !== record.revision) {
        throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
      }
      record = freshRecord
      const budget = record.budget!
      if (budget.agentRunsUsed >= budget.maxAgentRuns) return save(record, { status: 'blocked', summary: '本任务的 Agent 执行预算已用完。' })
      /** 启动时间单调前进，防止同毫秒重入复用上一轮可信身份。 */
      const runStartedAt = Math.max(now(), (record.runStartedAt ?? 0) + 1)
      const pendingFollowUp = record.followUps?.at(-1)?.status === 'pending' ? record.followUps.at(-1) : undefined
      const userMessageUuid = pendingFollowUp
        ? createHash('sha256').update(`${record.id}:follow-up:${pendingFollowUp.id}`).digest('hex')
        : createHash('sha256').update(`${record.id}:${runStartedAt}`).digest('hex')
      record = save(record, { status: 'running', runStartedAt, budget: { ...budget, agentRunsUsed: budget.agentRunsUsed + 1 },
        ...(pendingFollowUp ? { followUps: record.followUps!.map(item => item.id === pendingFollowUp.id
          ? { ...item, status: 'started' as const, startedAt: runStartedAt, userMessageUuid } : item) } : {}) })
      try {
        const result = await dependencies.executeCoordinator(record, controller.signal)
        const latest = ownerRecord(owner)
        if (latest.id !== record.id || latest.runStartedAt !== runStartedAt || terminal(latest)) return latest
        const deliveredFollowUps = pendingFollowUp ? latest.followUps!.map(item => item.id === pendingFollowUp.id
          ? { ...item, status: 'delivered' as const } : item) : latest.followUps
        if (result.status === 'cancelled') return save(latest, { status: 'cancelled', summary: '编排已停止，已交付产物保留。',
          ...(deliveredFollowUps ? { followUps: deliveredFollowUps } : {}) })
        if (controller.signal.aborted) return save(latest, { status: 'cancelled', summary: '编排已停止，已交付产物保留。' })
        if (result.status === 'errored') {
          /** finish 可能已结算本轮校正；仅未结算的 started 项可由执行错误推进为 failed。 */
          const failedFollowUps = pendingFollowUp && latest.followUps?.some(item => (
            item.id === pendingFollowUp.id && item.status === 'started'
          )) ? latest.followUps.map(item => item.id === pendingFollowUp.id && item.status === 'started'
              ? { ...item, status: 'failed' as const } : item) : undefined
          return save(latest, { status: 'blocked', summary: result.failure?.message ?? '编排运行失败，可沿原任务检查并继续。',
            ...(failedFollowUps ? { followUps: failedFollowUps } : {}) })
        }
        return ['planning', 'running'].includes(latest.status) || pendingFollowUp
          ? save(latest, { status: ['planning', 'running'].includes(latest.status) ? 'waiting' : latest.status,
            summary: latest.summary || '本轮协调已结束，交付尚未全部验收。',
            ...(deliveredFollowUps ? { followUps: deliveredFollowUps } : {}) }) : latest
      } catch (error) {
        const latest = ownerRecord(owner)
        if (!terminal(latest) && latest.id === record.id && latest.runStartedAt === runStartedAt) {
          save(latest, { status: controller.signal.aborted ? 'cancelled' : 'blocked', summary: '运行中断，保留原计划与执行记录供恢复。' })
        }
        throw error
      }
    }).finally(() => {
      signal?.removeEventListener('abort', abort)
      if (active.get(key(owner))?.controller === controller) active.delete(key(owner))
    })
    active.set(key(owner), { controller, promise })
    return promise
  }

  return {
    /** 返回权威状态；业务调用方另行验证读取权限。 */
    get: (target: CanvasTarget) => dependencies.store.get(target),
    /** 普通会话提交一次持久委托，重放只返回原任务。 */
    async delegate(owner: CanvasOrchestrationOwner, input: CanvasOrchestrationRequest, signal?: AbortSignal) {
      dependencies.authorizeOwner(owner)
      const request = parseCanvasOrchestrationRequest(input)
      if (request.deliverables.length === 0) throw new Error('CANVAS_ORCHESTRATION_DELIVERABLES_REQUIRED')
      const document = dependencies.loadCanvas(owner)
      if (request.referenceNodeIds.some(id => !document.nodes.some(node => node.id === id))) throw new Error('CANVAS_ORCHESTRATION_NODE_MISSING')
      const previous = dependencies.store.get(owner)
      const createdAt = now()
      const id = `orchestration-${createHash('sha256').update(JSON.stringify([owner.projectId, owner.canvasId, owner.sessionId, request.requestId])).digest('hex')}`
      /** 同步创建与跨执行器准入共用短锁，异步运行在落盘后才开始。 */
      const createRecord = () => dependencies.store.create({ schemaVersion: 1, id, revision: 1, projectId: owner.projectId, canvasId: owner.canvasId,
        ownerSessionId: owner.sessionId, request, coordinatorNodeId: null, coordinatorSessionId: null, status: 'planning',
        steps: [], summary: '', runStartedAt: null, createdAt, updatedAt: createdAt,
        budget: { maxAgentRuns: 32, agentRunsUsed: 0, maxMediaRuns: request.intent === 'produce' || request.intent === 'revise' ? 16 : 0, mediaRunsUsed: 0 } })
      /** 当前任务重放没有接管副作用；仍由 Store 验证同一 request 的全部不可变字段。 */
      const record = previous?.id === id || !dependencies.executionOwnership
        ? createRecord()
        : dependencies.executionOwnership.run(owner, 'orchestration', createRecord)
      if (previous?.id === record.id || record.id !== id || record.coordinatorNodeId) return record
      publish(record)
      return launch(owner, signal)
    },
    /** 应用启动时只对账中断状态，不创建节点、不启动模型或媒体。 */
    async recover(owner: CanvasOrchestrationOwner): Promise<CanvasOrchestrationRecord | null> {
      dependencies.authorizeOwner(owner)
      const stored = dependencies.store.get(owner)
      if (!stored) return null
      if (stored.ownerSessionId !== owner.sessionId) throw new Error('CANVAS_ORCHESTRATION_OWNER_MISMATCH')
      if (active.has(key(owner)) || terminal(stored)) return stored
      let recovered = ensureBudget(stored)
      recovered = await reconcile(recovered)
      if (active.has(key(owner))) return dependencies.store.get(owner)
      const blocked = recovered.steps.length === 0 || recovered.steps.some(step => step.status === 'blocked')
      const status = blocked ? 'blocked' as const : 'waiting' as const
      if (recovered.status === status) return recovered
      return save(recovered, {
        status,
        summary: blocked
          ? '应用重启后已停止旧运行；请核对中断步骤后再继续。'
          : '应用重启后已恢复计划与产物，等待继续编排或评审。',
      })
    },
    /** 恢复沿用同一委托；任何正在运行的专业步骤都不会在 dispatch 中自动重跑。 */
    resume(
      owner: CanvasOrchestrationOwner,
      orchestrationId: string,
      followUpOrSignal?: CanvasOrchestrationFollowUpInput | AbortSignal,
      signal?: AbortSignal,
    ) {
      const followUp = isAbortSignal(followUpOrSignal) ? undefined : followUpOrSignal
      const executionSignal = isAbortSignal(followUpOrSignal) ? followUpOrSignal : signal
      let record = ownerRecord(owner)
      if (record.id !== orchestrationId) throw new Error('CANVAS_ORCHESTRATION_OWNER_MISMATCH')
      if (followUp) {
        const replay = record.followUps?.find(item => item.id === followUp.id)
        if (replay) {
          if (replay.instruction !== followUp.instruction || replay.supersedesId !== followUp.supersedesId) {
            throw new Error('CANVAS_ORCHESTRATION_FOLLOW_UP_CONFLICT')
          }
          if (replay.status === 'delivered' || replay.status === 'failed' || replay.status === 'abandoned' || terminal(record)) {
            return Promise.resolve(record)
          }
          return launch(owner, executionSignal)
        }
        if (terminal(record)) throw new Error('CANVAS_ORCHESTRATION_TERMINAL')
        if (active.has(key(owner))) throw new Error('CANVAS_ORCHESTRATION_ACTIVE')
        const unresolved = record.followUps?.find(item => item.status === 'pending' || item.status === 'started')
        if (unresolved?.status === 'pending') throw new Error('CANVAS_ORCHESTRATION_FOLLOW_UP_PENDING')
        if ((record.status === 'running' || unresolved?.status === 'started') && dependencies.isCoordinatorBusy(record)) {
          throw new Error('CANVAS_ORCHESTRATION_ACTIVE')
        }
        if (!Number.isSafeInteger(followUp.expectedRevision) || record.revision !== followUp.expectedRevision) {
          throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(followUp.id)
          || (followUp.supersedesId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(followUp.supersedesId))
          || !followUp.instruction.trim() || followUp.instruction.length > 4_096) {
          throw new Error('CANVAS_ORCHESTRATION_FOLLOW_UP_INVALID')
        }
        if (unresolved?.status === 'started') {
          if (record.status !== 'blocked' || followUp.supersedesId !== unresolved.id) {
            throw new Error('CANVAS_ORCHESTRATION_FOLLOW_UP_PENDING')
          }
        } else if (followUp.supersedesId !== undefined) {
          throw new Error('CANVAS_ORCHESTRATION_FOLLOW_UP_CONFLICT')
        }
        if ((record.followUps?.length ?? 0) >= 32) throw new Error('CANVAS_ORCHESTRATION_FOLLOW_UP_LIMIT')
        if (record.budget && record.budget.agentRunsUsed >= record.budget.maxAgentRuns) {
          throw new Error('CANVAS_ORCHESTRATION_BUDGET_EXHAUSTED')
        }
        const createdAt = Math.max(now(), record.updatedAt)
        const settled = (record.followUps ?? []).map(item => item.id === followUp.supersedesId
          ? { ...item, status: 'abandoned' as const } : item)
        record = save(record, { followUps: [...settled, {
          id: followUp.id, instruction: followUp.instruction, ...(followUp.supersedesId ? { supersedesId: followUp.supersedesId } : {}),
          status: 'pending', createdAt,
        }] })
      }
      if (terminal(record)) return Promise.resolve(record)
      if (!followUp && record.followUps?.at(-1)?.status === 'failed') {
        throw new Error('CANVAS_ORCHESTRATION_FOLLOW_UP_RETRY_REQUIRED')
      }
      return launch(owner, executionSignal)
    },
    /** 明确取消先持久化，旧模型回调随后不能再改变状态。 */
    cancel(owner: CanvasOrchestrationOwner, orchestrationId: string) {
      const record = ownerRecord(owner)
      if (record.id !== orchestrationId) throw new Error('CANVAS_ORCHESTRATION_OWNER_MISMATCH')
      if (terminal(record)) return record
      const saved = save(record, { status: 'cancelled', summary: '用户已停止编排，已有产物保留。' })
      active.get(key(owner))?.controller.abort()
      return saved
    },
    /** 运行服务用于在 reserve 前复验编排身份。 */
    assertActor: actorRecord,
    /** Agent execution 启动临界区复验专业 child 的可信分支身份。 */
    assertBranch,
    /** 只接受计划字段；状态与证据由 Host 保留或失效，模型不能在计划更新中伪造完成。 */
    async updatePlan(actor: CanvasOrchestrationActor, expectedRevision: number, draft: CanvasOrchestrationStep[]) {
      const record = actorRecord(actor)
      if (record.revision !== expectedRevision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
      const previous = new Map(record.steps.map(step => [step.id, step]))
      const steps = draft.map(step => {
        const old = previous.get(step.id)
        if (old?.status === 'running' && definition(old) !== definition(step)) throw new Error('CANVAS_ORCHESTRATION_STEP_RUNNING')
        if (old && definition(old) === definition(step)) return old
        return { id: step.id, title: step.title, role: step.role, instruction: step.instruction, dependsOn: step.dependsOn,
          inputNodeIds: step.inputNodeIds, outputNodeIds: step.outputNodeIds, agentNodeId: old?.agentNodeId ?? null,
          criteria: step.criteria, status: 'planned' as const, note: '', ...(old?.attempts ? { attempts: old.attempts } : {}) }
      })
      if (record.steps.some(old => old.status === 'running' && !steps.some(step => step.id === old.id))) throw new Error('CANVAS_ORCHESTRATION_STEP_RUNNING')
      /** 上游定义变化使所有依赖它的验收失效，保留实际产物供局部复核。 */
      const changed = new Set(steps.filter(step => previous.has(step.id) && definition(previous.get(step.id)!) !== definition(step)).map(step => step.id))
      for (let pass = 0; pass < steps.length; pass++) for (const step of steps) {
        if (step.dependsOn.some(id => changed.has(id))) {
          if (step.status === 'running') throw new Error('CANVAS_ORCHESTRATION_STEP_RUNNING')
          changed.add(step.id)
          step.status = 'planned'
          delete step.inputVersions
          delete step.outputVersions
        }
      }
      validateNodes(record, steps)
      return save(record, { steps })
    },
    /** 按已登记步骤分派专业工作，执行成功只进入待评审。 */
    async dispatch(actor: CanvasOrchestrationActor, expectedRevision: number, stepId: string) {
      let record = actorRecord(actor)
      if (record.revision !== expectedRevision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
      let step = record.steps.find(step => step.id === stepId)
      if (!step) throw new Error('CANVAS_ORCHESTRATION_STEP_NOT_FOUND')
      if (step.status === 'running') return record
      if (step.status === 'needs-review' || step.status === 'completed') {
        if (!await versionsMatch(record, step.inputVersions, effectiveInputNodeIds(record, step))) {
          return invalidateStepAndDownstream(record, step.id, 'blocked', '输入版本已改变，已有产物需重新核对。')
        }
        if (!await versionsMatch(record, step.outputVersions, step.outputNodeIds)) {
          return invalidateStepAndDownstream(record, step.id, 'needs-review', '产物版本已改变，需要重新评审。')
        }
        return record
      }
      /** 直接上游用于冻结本步输入，完整祖先用于版本准入。 */
      const upstream = record.steps.filter(candidate => step!.dependsOn.includes(candidate.id))
      /** 当前分支的可达祖先，不包含无关计划步骤。 */
      const ancestors = dependencyAncestors(record, step)
      if (ancestors.some(candidate => candidate.status !== 'completed')) throw new Error('CANVAS_ORCHESTRATION_DEPENDENCY_PENDING')
      record = ensureBudget(record)
      const budget = record.budget!
      if (budget.agentRunsUsed >= budget.maxAgentRuns || (step.attempts ?? 0) >= 3) throw new Error('CANVAS_ORCHESTRATION_BUDGET_EXHAUSTED')
      const inputNodeIds = [...new Set([...step.inputNodeIds, ...upstream.flatMap(candidate => candidate.outputNodeIds)])]
      const inputVersions = await identities(record, inputNodeIds)
      record = actorRecord(actor)
      if (record.revision !== expectedRevision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
      await assertDependencyVersions(actor, record, ancestors)
      if (!step.agentNodeId) {
        const target = await dependencies.createAgent(record, step)
        record = actorRecord(actor)
        if (record.revision !== expectedRevision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
        /** Agent 创建是异步副作用窗口，返回后再次复验再决定是否扣额和执行。 */
        await assertDependencyVersions(actor, record, ancestors)
        const assigned = { ...step, agentNodeId: target.nodeId }
        validateNodes(record, record.steps.map(candidate => candidate.id === stepId ? assigned : candidate))
        step = assigned
      }
      /** 同一步骤跨重启重试也必须获得新代次，防止复用旧消息锚点。 */
      const persistedBranchStartedAt = Math.max(0, ...record.steps.map(candidate => candidate.execution?.startedAt ?? 0))
      lastBranchStartedAt = Math.max(now(), lastBranchStartedAt + 1, persistedBranchStartedAt + 1, (record.runStartedAt ?? 0) + 1)
      const userMessageUuid = createHash('sha256').update(`${record.id}:${step.id}:${lastBranchStartedAt}`).digest('hex')
      const running = { ...step, status: 'running' as const, inputVersions, attempts: (step.attempts ?? 0) + 1, note: '',
        execution: { startedAt: lastBranchStartedAt, userMessageUuid } }
      record = save(record, { steps: record.steps.map(candidate => candidate.id === stepId ? running : candidate),
        budget: { ...record.budget!, agentRunsUsed: record.budget!.agentRunsUsed + 1 } })
      const controller = active.get(key(record))!.controller
      const access: CanvasOrchestrationBranchAccess = {
        target: { projectId: record.projectId, canvasId: record.canvasId, nodeId: running.agentNodeId! },
        parentSessionId: record.coordinatorSessionId!,
        orchestrationId: record.id,
        stepId,
        startedAt: lastBranchStartedAt,
        userMessageUuid,
      }
      branches.set(branchKey(access), access)
      try {
        const result = await dependencies.executeSpecialist(record, running, controller.signal, access)
        const latest = dependencies.store.get(actor)
        if (!latest) throw new Error('CANVAS_ORCHESTRATION_NOT_FOUND')
        if (terminal(latest) || latest.id !== record.id || latest.runStartedAt !== actor.runStartedAt) return latest
        actorRecord(actor)
        const current = latest.steps.find(candidate => candidate.id === stepId)
        if (!current || current.status !== 'running' || current.attempts !== running.attempts) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
        const validInputs = await versionsMatch(latest, inputVersions, effectiveInputNodeIds(latest, current))
        const outputNodeIds = [...new Set([...current.outputNodeIds, ...(result.status === 'completed' ? [running.agentNodeId!] : [])])]
        const outputVersions = result.status === 'completed' && validInputs ? await identities(latest, outputNodeIds) : undefined
        const fresh = actorRecord(actor)
        if (fresh.revision !== latest.revision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
        return save(fresh, { steps: fresh.steps.map(candidate => candidate.id === stepId ? { ...current,
          status: result.status === 'completed' && validInputs ? 'needs-review' : 'blocked', outputNodeIds,
          ...(outputVersions ? { outputVersions } : {}),
          note: !validInputs ? '输入版本已改变，需复核本次结果。' : result.status === 'completed' ? '专业产物已交付，等待编排者评审。' : result.failure?.message ?? '专业运行未完成。',
        } : candidate) })
      } catch (error) {
        const latest = dependencies.store.get(actor)
        if (latest && terminal(latest)) return latest
        if (latest && latest.id === actor.orchestrationId && latest.runStartedAt === actor.runStartedAt) {
          save(latest, { steps: latest.steps.map(candidate => candidate.id === stepId ? { ...candidate, status: 'blocked', note: '专业运行中断，请先核对已有产物再决定是否继续。' } : candidate) })
        }
        throw error
      } finally {
        branches.delete(branchKey(access))
      }
    },
    /** 可信工具创建成功后把真实节点及版本自动登记到当前专业步骤。 */
    async registerOutput(access: CanvasOrchestrationBranchAccess, nodeId: string, sourceToolCallId: string) {
      if (typeof sourceToolCallId !== 'string' || sourceToolCallId.length < 1 || sourceToolCallId.length > 256
        || /[\0\r\n]/.test(sourceToolCallId)) throw new Error('CANVAS_ORCHESTRATION_OUTPUT_SOURCE_INVALID')
      const initial = assertBranch(access)
      const node = dependencies.loadCanvas(initial.record).nodes.find(candidate => candidate.id === nodeId)
      if (!node) throw new Error('CANVAS_ORCHESTRATION_NODE_MISSING')
      if (initial.record.request.intent === 'review'
        && (initial.record.request.referenceNodeIds.includes(nodeId)
          || node.kind === 'image' || node.kind === 'audio' || node.kind === 'video')) {
        throw new Error('CANVAS_ORCHESTRATION_REVIEW_WRITE_DENIED')
      }
      await dependencies.assertOutputOwnership(access, nodeId, sourceToolCallId)
      const verified = assertBranch(access)
      if (verified.record.revision !== initial.record.revision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
      if (verified.step.outputNodeIds.includes(nodeId)) return verified.record
      const identity = (await identities(verified.record, [nodeId]))[0]!
      const latest = assertBranch(access)
      if (latest.record.revision !== verified.record.revision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
      return save(latest.record, { steps: latest.record.steps.map(step => step.id === access.stepId
        ? { ...step, outputNodeIds: [...step.outputNodeIds, nodeId], outputVersions: [...(step.outputVersions ?? []), identity] }
        : step) })
    },
    /** 编排评审绑定当前真实版本；这条记录不替代领域工具的内容验收证据。 */
    async reviewStep(actor: CanvasOrchestrationActor, expectedRevision: number, stepId: string, passed: boolean, note: string) {
      const record = actorRecord(actor)
      if (record.revision !== expectedRevision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
      const step = record.steps.find(candidate => candidate.id === stepId)
      if (!step || step.status === 'running' || !step.outputNodeIds.length) throw new Error('CANVAS_ORCHESTRATION_REVIEW_NOT_READY')
      const inputVersions = await identities(record, effectiveInputNodeIds(record, step))
      const outputVersions = await identities(record, step.outputNodeIds)
      const latest = actorRecord(actor)
      if (latest.revision !== expectedRevision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
      if (step.inputVersions && JSON.stringify(step.inputVersions) !== JSON.stringify(inputVersions)) {
        invalidateStepAndDownstream(latest, step.id, 'blocked', '输入版本已改变，已有产物需重新核对。')
        throw new Error('CANVAS_ORCHESTRATION_EVIDENCE_STALE')
      }
      if (step.outputVersions && JSON.stringify(step.outputVersions) !== JSON.stringify(outputVersions)) {
        invalidateStepAndDownstream(latest, step.id, 'needs-review', '产物版本已改变，需要重新评审。')
        throw new Error('CANVAS_ORCHESTRATION_EVIDENCE_STALE')
      }
      return save(latest, { steps: latest.steps.map(candidate => candidate.id === stepId
        ? { ...candidate, status: passed ? 'completed' : 'blocked', note, inputVersions, outputVersions } : candidate) })
    },
    /** 完成必须同时满足计划与真实交付合同；等待和受阻保持可恢复。 */
    async finish(actor: CanvasOrchestrationActor, status: 'completed' | 'waiting' | 'blocked', summary: string) {
      const record = actorRecord(actor)
      if (status === 'completed') {
        if (record.steps.some(step => step.status !== 'completed')) throw new Error('CANVAS_ORCHESTRATION_DELIVERY_INCOMPLETE')
        await assertStepVersions(actor, record)
        if (!await dependencies.verifyDelivery(record)) throw new Error('CANVAS_ORCHESTRATION_DELIVERY_INCOMPLETE')
        /** 最终合同核验含异步文件与媒体读取，返回后必须拒绝期间发生的正式版本变化。 */
        await assertStepVersions(actor, record)
      }
      const latest = actorRecord(actor)
      if (latest.revision !== record.revision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
      const followUps = latest.followUps?.map(item => item.status === 'started' && item.startedAt === actor.runStartedAt
        ? { ...item, status: 'delivered' as const } : item)
      return save(latest, { status, summary, ...(followUps ? { followUps } : {}) })
    },
    /** 媒体启动前预留预算，未知提交结果不会退回额度后重复外发。 */
    reserveMedia(actor: CanvasOrchestrationActor, count: number, operationId?: string) {
      let record = actorRecord(actor)
      record = ensureBudget(record)
      const budget = record.budget!
      if (operationId !== undefined) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId)) {
          throw new Error('CANVAS_ORCHESTRATION_MEDIA_RESERVATION_INVALID')
        }
        const existing = budget.mediaReservations?.find(reservation => reservation.operationId === operationId)
        if (existing) {
          if (existing.count !== count) throw new Error('CANVAS_ORCHESTRATION_MEDIA_RESERVATION_CONFLICT')
          return record
        }
      }
      if (!Number.isSafeInteger(count) || count < 1 || budget.mediaRunsUsed + count > budget.maxMediaRuns) throw new Error('CANVAS_ORCHESTRATION_MEDIA_BUDGET_EXHAUSTED')
      return save(record, { budget: {
        ...budget,
        mediaRunsUsed: budget.mediaRunsUsed + count,
        ...(operationId ? { mediaReservations: [...(budget.mediaReservations ?? []), { operationId, count }] } : {}),
      } })
    },
  }
}

/** 主进程生产组合点及 Provider 共用同一服务接口。 */
export type CanvasOrchestrationService = ReturnType<typeof createCanvasOrchestrationService>
