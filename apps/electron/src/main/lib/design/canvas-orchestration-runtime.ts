import { createHash } from 'node:crypto'
import type { CanvasAgentTarget, CanvasDocument, CanvasOrchestrationFollowUp, CanvasOrchestrationRecord, CanvasOrchestrationStep, CanvasTarget, SDKMessage } from '@proma/shared'
import { inspectCanvasAgentOutputRecovery } from './canvas-agent-output-service'
import { createCanvasOrchestrationService } from './canvas-orchestration-service'
import type { CanvasOrchestrationServiceDependencies } from './canvas-orchestration-service'
import type { CanvasAgentExecutionService } from './canvas-agent-execution-service'
import type { CanvasArtifactCreationService } from './canvas-artifact-creation'
import type { CanvasToolAccessFacade } from './canvas-tool-access-facade'
import type { CanvasToolRun, CanvasToolRunContext } from './canvas-tool-provider'
import { createCanvasTaskEvidence, resolveCanvasTaskEvidence } from './canvas-task-evidence'
import type { CanvasTaskEvidenceDependencies } from './canvas-task-evidence'

/** 主进程组合只引用既有服务，不另外建立会话、图或媒体存储。 */
export interface CanvasOrchestrationRuntimeDependencies {
  /** 与旧 DAG 共用准入，防止委托登记或恢复时产生第二个调度者。 */
  executionOwnership?: CanvasOrchestrationServiceDependencies['executionOwnership']
  store: CanvasOrchestrationServiceDependencies['store']
  access: Pick<CanvasToolAccessFacade, 'authorizeRead' | 'requireLinkedCanvas' | 'runWrite'>
  documents: { load(target: CanvasTarget): { document: CanvasDocument } }
  artifacts: Pick<CanvasArtifactCreationService, 'createAgent' | 'resolveCreated'>
  execution: Pick<CanvasAgentExecutionService, 'execute'>
  evidence: CanvasTaskEvidenceDependencies
  /** 精确恢复只消费权威会话消息和真实忙状态，不发起新模型请求。 */
  getAgentMessages(sessionId: string): SDKMessage[]
  isAgentBusy(sessionId: string): boolean
  createRun(context: CanvasToolRunContext): CanvasToolRun | undefined
  onChanged: CanvasOrchestrationServiceDependencies['onChanged']
}

/** 按本次专业分派的持久锚点复验输出；后续手动运行不能替代本次产物。 */
export async function recoverCanvasOrchestrationSpecialist(
  dependencies: Pick<CanvasOrchestrationRuntimeDependencies, 'documents' | 'evidence' | 'getAgentMessages' | 'isAgentBusy'>,
  target: CanvasTarget, step: Pick<CanvasOrchestrationStep, 'agentNodeId' | 'execution'>,
): Promise<'completed' | 'missing' | 'changed' | 'running'> {
  if (!step.execution || !step.agentNodeId) return 'missing'
  const node = dependencies.documents.load(target).document.nodes.find(candidate => candidate.id === step.agentNodeId)
  if (node?.kind !== 'agent') return 'missing'
  const recovery = inspectCanvasAgentOutputRecovery(dependencies.getAgentMessages(node.agentSessionId),
    step.execution.userMessageUuid, step.execution.startedAt, node.outputPointer)
  if (recovery.status === 'changed') return 'changed'
  if (recovery.status === 'completed' && node.outputPointer) {
    /** 正文读取期间可能提交新回复，返回前核对同一 owner 和正式指针。 */
    const pointerIdentity = JSON.stringify([node.agentSessionId, node.outputPointer])
    await dependencies.evidence.agentOutputs.readAtPointer({ ...target, nodeId: node.id }, node.outputPointer)
    const current = dependencies.documents.load(target).document.nodes.find(candidate => candidate.id === node.id)
    if (current?.kind !== 'agent' || pointerIdentity !== JSON.stringify([current.agentSessionId, current.outputPointer])) return 'changed'
    return 'completed'
  }
  return recovery.latestRun && dependencies.isAgentBusy(node.agentSessionId) ? 'running' : 'missing'
}

/** 按稳定用户消息锚点判断中断的 coordinator 校正是否已有可信终态，避免盲重发。 */
export async function recoverCanvasOrchestrationCoordinator(
  dependencies: Pick<CanvasOrchestrationRuntimeDependencies, 'documents' | 'evidence' | 'getAgentMessages' | 'isAgentBusy'>,
  record: CanvasOrchestrationRecord,
  followUp: CanvasOrchestrationFollowUp,
): Promise<'completed' | 'missing' | 'changed' | 'running'> {
  if (!record.coordinatorSessionId || !followUp.userMessageUuid || followUp.startedAt === undefined) return 'missing'
  return recoverCanvasOrchestrationSpecialist(dependencies, record, {
    agentNodeId: record.coordinatorNodeId,
    execution: { startedAt: followUp.startedAt, userMessageUuid: followUp.userMessageUuid },
  })
}

/** 从持久双身份重建固定编排上下文；调用方仍须 fresh 校验记录和运行代次。 */
export function canvasOrchestratorContext(record: CanvasOrchestrationRecord): CanvasToolRunContext {
  if (!record.coordinatorNodeId || !record.coordinatorSessionId || record.runStartedAt === null) throw new Error('CANVAS_ORCHESTRATION_AGENT_INVALID')
  return { projectId: record.projectId, sessionId: record.coordinatorSessionId, runStartedAt: record.runStartedAt,
    permissionCeiling: 'execute', explicitReferences: [], canvasAgentMode: 'canvas-orchestrator', canvasOrchestrationId: record.id,
    canvasAgentTarget: { projectId: record.projectId, canvasId: record.canvasId, nodeId: record.coordinatorNodeId } }
}

/** 输入业务关系属于产物版本；新增下游消费者不改变上游设计，边顺序和边 ID 不参与身份。 */
function inputRelationIdentity(document: CanvasDocument, nodeId: string): string {
  return JSON.stringify(document.edges.filter(edge => edge.targetNodeId === nodeId).map(edge => JSON.stringify([
    edge.sourceNodeId, edge.sourcePort, edge.sourceOutputKey ?? null, edge.targetPort, edge.relation,
  ])).sort())
}

/** 权威读取得到与布局无关的节点版本；配置或正式输出变化都会使原验收失效。 */
export async function readCanvasOrchestrationNodeIdentity(
  dependencies: Pick<CanvasOrchestrationRuntimeDependencies, 'documents' | 'evidence'>, target: CanvasTarget, nodeId: string,
): Promise<string> {
  const document = dependencies.documents.load(target).document
  const node = document.nodes.find(candidate => candidate.id === nodeId)
  if (!node) throw new Error('CANVAS_ORCHESTRATION_NODE_MISSING')
  /** 在首次 await 前冻结内容相关字段，避免可变 Store 返回值掩盖并发变更。 */
  const { position: _position, ...before } = node
  const baseline = JSON.stringify(before)
  const relations = inputRelationIdentity(document, nodeId)
  const contentNode = node.kind === 'document' || node.kind === 'webview' || (node.kind === 'agent' && node.outputPointer)
  const validation = contentNode ? 'content' : 'configuration'
  const proof = await resolveCanvasTaskEvidence(dependencies.evidence, target.projectId, node, createCanvasTaskEvidence(target.canvasId, node, validation, null))
  if (!proof) throw new Error('CANVAS_ORCHESTRATION_OUTPUT_UNAVAILABLE')
  const adopted = node.kind === 'image' || node.kind === 'audio' || node.kind === 'video'
    ? await resolveCanvasTaskEvidence(dependencies.evidence, target.projectId, node, createCanvasTaskEvidence(target.canvasId, node, 'adopted', null)) : undefined
  /** 已有正式输出的 Agent 仍须绑定职责配置，否则改职责会复用旧验收。 */
  const configuration = node.kind === 'agent' && contentNode
    ? await resolveCanvasTaskEvidence(dependencies.evidence, target.projectId, node, createCanvasTaskEvidence(target.canvasId, node, 'configuration', null)) : undefined
  /** 异步正文读取期间节点内容指针可能变化；布局不参与该并发检查。 */
  const currentDocument = dependencies.documents.load(target).document
  const current = currentDocument.nodes.find(candidate => candidate.id === nodeId)
  const { position: _currentPosition, ...after } = current ?? node
  if (!current || baseline !== JSON.stringify(after) || relations !== inputRelationIdentity(currentDocument, nodeId)) {
    throw new Error('CANVAS_ORCHESTRATION_VERSION_CHANGED')
  }
  return createHash('sha256').update(JSON.stringify([node.id, node.kind, proof.identity,
    adopted?.identity ?? null, configuration?.identity ?? null, relations])).digest('hex')
}

/** 组装委托生命周期；专业指令按原计划发送，审批仍沿用 Pi 的真实父会话路由。 */
export function createCanvasOrchestrationRuntime(dependencies: CanvasOrchestrationRuntimeDependencies) {
  /** 所有普通会话授权都重新检查关联和可写权限，撤权不能沿旧委托执行。 */
  const authorizeOwner: CanvasOrchestrationServiceDependencies['authorizeOwner'] = owner => {
    const context: CanvasToolRunContext = { projectId: owner.projectId, sessionId: owner.sessionId,
      runStartedAt: Date.now(), explicitReferences: [], permissionCeiling: 'execute' }
    dependencies.access.requireLinkedCanvas(context, owner.canvasId)
    dependencies.access.runWrite(context, () => undefined)
  }
  return createCanvasOrchestrationService({
    executionOwnership: dependencies.executionOwnership,
    store: dependencies.store, authorizeOwner, loadCanvas: target => dependencies.documents.load(target).document,
    createAgent: async (record, step) => {
      authorizeOwner({ ...record, sessionId: record.ownerSessionId })
      /** 来源稳定跨重启，创建提交后未回写计划也能找回同一节点。 */
      const source = { sessionId: record.ownerSessionId, runStartedAt: record.createdAt,
        toolCallId: createHash('sha256').update(JSON.stringify([record.id, step?.id ?? 'coordinator'])).digest('hex') }
      const existing = dependencies.artifacts.resolveCreated({ ...record, artifactType: 'agent', source })
      if (existing) return { projectId: record.projectId, canvasId: record.canvasId, nodeId: existing.nodeId }
      const created = await dependencies.artifacts.createAgent({ projectId: record.projectId, canvasId: record.canvasId,
        baseRevision: dependencies.documents.load(record).document.revision,
        title: step ? `${step.role} · ${step.title}`.slice(0, 120) : '画布编排', source })
      return { projectId: record.projectId, canvasId: record.canvasId, nodeId: created.nodeId }
    },
    executeCoordinator: async (record, signal) => {
      const context = canvasOrchestratorContext(record)
      const followUp = record.followUps?.at(-1)
      const activeFollowUp = followUp?.status === 'started' && followUp.startedAt === record.runStartedAt ? followUp : undefined
      const instruction = followUp
        ? `接管当前持久委托并遵守普通会话最近提交的后续校正：${followUp.instruction}\n原目标、约束和交付合同保持不变。先 canvas_get_orchestration 读取完整委托、校正与已有计划，再用 canvas_get_context 复核原交付合同；在原合同内更新必要步骤、重新读取受影响产物并推进到可证明的交付或明确阻塞。最终调用 canvas_finish_orchestration 汇报真实状态。`
        : '接管当前持久委托。先 canvas_get_orchestration 读取完整目标、约束、交付与已有计划，再用 canvas_get_context 获取原交付合同。按领域和缺口组织专业步骤，复用已验收成果，推进到可证明的交付或明确阻塞。最终调用 canvas_finish_orchestration 汇报真实状态。'
      return dependencies.execution.execute({ mode: 'canvas-orchestrator', target: context.canvasAgentTarget!,
        parentSessionId: record.ownerSessionId, orchestrationId: record.id,
        expectedGraphRevision: dependencies.documents.load(record).document.revision,
        instruction,
        userMessageUuid: activeFollowUp?.userMessageUuid
          ?? createHash('sha256').update(`${record.id}:${record.runStartedAt}`).digest('hex'),
        startedAt: record.runStartedAt!, signal })
    },
    executeSpecialist: async (record, step, signal, access) => {
      const target: CanvasAgentTarget = { projectId: record.projectId, canvasId: record.canvasId, nodeId: step.agentNodeId! }
      /** 计划依赖通过显式审核范围送达，不为审核制造执行边或依赖环。 */
      const inputNodeIds = [...new Set([...step.inputNodeIds,
        ...record.steps.filter(candidate => step.dependsOn.includes(candidate.id)).flatMap(candidate => candidate.outputNodeIds)])]
      if (inputNodeIds.length > 128) throw new Error('CANVAS_ORCHESTRATION_INPUT_SCOPE_TOO_LARGE')
      return dependencies.execution.execute({ mode: 'parent-orchestrated', target,
        parentSessionId: record.coordinatorSessionId!, orchestration: { id: record.id, stepId: step.id },
        expectedGraphRevision: dependencies.documents.load(record).document.revision,
        instruction: `专业职责：${step.role}\n本步任务：${step.instruction}\n验收要点：${JSON.stringify(step.criteria)}\n输入节点：${JSON.stringify(inputNodeIds)}\n先读取当前输入和原有产物，直接交付本职设计或评审；新增产物通过受管工具登记，不能代替编排者再分派或运行媒体。完整正文须留在正式产物或本轮最终回复。`,
        ...(inputNodeIds.length ? { reviewScope: { mode: 'nodes' as const, nodeIds: inputNodeIds } } : {}),
        userMessageUuid: access.userMessageUuid,
        startedAt: access.startedAt, signal })
    },
    recoverSpecialist: (record, step) => recoverCanvasOrchestrationSpecialist(dependencies, record, step),
    recoverCoordinator: (record, followUp) => recoverCanvasOrchestrationCoordinator(dependencies, record, followUp),
    isCoordinatorBusy: record => !!record.coordinatorSessionId && dependencies.isAgentBusy(record.coordinatorSessionId),
    readNodeIdentity: (target, nodeId) => readCanvasOrchestrationNodeIdentity(dependencies, target, nodeId),
    assertOutputOwnership: (access, nodeId, sourceToolCallId) => {
      const document = dependencies.documents.load(access.target).document
      const agent = document.nodes.find(node => node.id === access.target.nodeId)
      const output = document.nodes.find(node => node.id === nodeId)
      if (agent?.kind !== 'agent' || !output) throw new Error('CANVAS_ORCHESTRATION_OUTPUT_UNAVAILABLE')
      const created = dependencies.artifacts.resolveCreated({ ...access.target, artifactType: output.kind,
        source: { sessionId: agent.agentSessionId, runStartedAt: access.startedAt, toolCallId: sourceToolCallId } })
      if (created?.nodeId !== nodeId) throw new Error('CANVAS_ORCHESTRATION_OUTPUT_OWNER_MISMATCH')
    },
    verifyDelivery: async record => {
      const run = dependencies.createRun(canvasOrchestratorContext(record))
      return await run?.verifyOrchestrationDelivery?.() ?? false
    },
    onChanged: dependencies.onChanged,
  })
}
