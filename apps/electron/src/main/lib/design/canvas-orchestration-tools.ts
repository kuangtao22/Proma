import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { CanvasOrchestrationRecord, CanvasOrchestrationRequest, CanvasOrchestrationStep } from '@proma/shared'
import { Type } from 'typebox'
import type { Static, TSchema } from 'typebox'
import { Value } from 'typebox/value'
import type { CanvasOrchestrationActor, CanvasOrchestrationFollowUpInput, CanvasOrchestrationOwner, CanvasOrchestrationService } from './canvas-orchestration-service'
import type { CanvasToolAccessFacade } from './canvas-tool-access-facade'
import type { CanvasToolRunContext } from './canvas-tool-provider'

/** 编排工具只接受可持久化的稳定业务标识。 */
const stableId = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' })
/** 节点类型与 Canvas 共享合同保持一致，不允许模型扩展未知产物类型。 */
const nodeKind = Type.Union([
  Type.Literal('agent'), Type.Literal('image'), Type.Literal('audio'),
  Type.Literal('video'), Type.Literal('document'), Type.Literal('webview'),
])
/** 普通 Agent 只能声明原始目标、约束、引用和验收交付物。 */
const requestSchema = Type.Object({
  requestId: stableId,
  goal: Type.String({ minLength: 1, maxLength: 32_768 }),
  intent: Type.Union([Type.Literal('design'), Type.Literal('produce'), Type.Literal('review'), Type.Literal('revise')]),
  constraints: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 64, uniqueItems: true }),
  referenceNodeIds: Type.Array(stableId, { maxItems: 32, uniqueItems: true }),
  deliverables: Type.Array(Type.Object({
    id: stableId,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    kind: nodeKind,
    criteria: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 32, uniqueItems: true }),
  }, { additionalProperties: false }), { maxItems: 16 }),
}, { additionalProperties: false })
/** 编排者只能提交专业步骤定义，状态、证据、尝试次数和预算由 Host 管理。 */
const stepDefinitionSchema = Type.Object({
  id: stableId,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  role: Type.String({ minLength: 1, maxLength: 256 }),
  instruction: Type.String({ minLength: 1, maxLength: 32_768 }),
  dependsOn: Type.Array(stableId, { maxItems: 64, uniqueItems: true }),
  inputNodeIds: Type.Array(stableId, { maxItems: 32, uniqueItems: true }),
  outputNodeIds: Type.Array(stableId, { maxItems: 32, uniqueItems: true }),
  agentNodeId: Type.Union([stableId, Type.Null()]),
  criteria: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 32, uniqueItems: true }),
}, { additionalProperties: false })

/** 普通 Agent 工具均要求显式画布，由关联 facade 解析其合法范围。 */
const readOptions = {
  section: Type.Optional(Type.Union([
    Type.Literal('overview'), Type.Literal('constraints'), Type.Literal('deliverables'), Type.Literal('steps'), Type.Literal('followUps'),
  ])),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
}
/** 普通读取可分页查看完整需求与专业步骤，默认只返回概要。 */
const canvasTargetSchema = Type.Object({ canvasId: stableId, ...readOptions }, { additionalProperties: false })
/** 委托把严格需求对象与目标画布分开，避免接收完整持久记录。 */
const delegateSchema = Type.Object({ canvasId: stableId, request: requestSchema }, { additionalProperties: false })
/** 恢复与取消只引用已有任务，不接受可信执行身份。 */
const ownerControlSchema = Type.Object({ canvasId: stableId, orchestrationId: stableId }, { additionalProperties: false })
/** 继续入口可选携带一次有界校正；CAS 只约束首次登记，精确重放优先识别。 */
const resumeSchema = Type.Object({
  canvasId: stableId,
  orchestrationId: stableId,
  followUp: Type.Optional(Type.Object({
    id: stableId,
    expectedRevision: Type.Integer({ minimum: 1 }),
    instruction: Type.String({ minLength: 1, maxLength: 4_096 }),
    supersedesId: Type.Optional(stableId),
  }, { additionalProperties: false })),
}, { additionalProperties: false })
/** 编排者读取固定目标时不需要也不允许传入画布或任务身份。 */
const actorReadSchema = Type.Object(readOptions, { additionalProperties: false })
/** 计划更新使用 CAS revision，防止旧编排覆盖新状态。 */
const updatePlanSchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  steps: Type.Array(stepDefinitionSchema, { maxItems: 64 }),
}, { additionalProperties: false })
/** 分派精确绑定一个已登记步骤。 */
const dispatchSchema = Type.Object({ expectedRevision: Type.Integer({ minimum: 1 }), stepId: stableId }, { additionalProperties: false })
/** 专业步骤评审保留明确结论和有界说明。 */
const reviewStepSchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }), stepId: stableId, passed: Type.Boolean(),
  note: Type.String({ minLength: 1, maxLength: 16_384 }),
}, { additionalProperties: false })
/** 编排结束只声明任务状态和摘要，真实交付证据仍由服务复验。 */
const finishSchema = Type.Object({
  status: Type.Union([Type.Literal('completed'), Type.Literal('waiting'), Type.Literal('blocked')]),
  summary: Type.String({ minLength: 1, maxLength: 32_768 }),
}, { additionalProperties: false })

/** 工具层只依赖现有服务和统一授权 facade，不持有第二份业务状态。 */
export interface CanvasOrchestrationToolDependencies {
  service: CanvasOrchestrationService
  access: Pick<CanvasToolAccessFacade, 'authorizeRead' | 'requireLinkedCanvas' | 'runWrite'>
  getExecutionContext?: () => CanvasToolRunContext
}

/** 单次工具执行使用的严格参数和可信目标处理器。 */
type OrchestrationHandler<Input> = (
  input: Input,
  identity: CanvasOrchestrationOwner | CanvasOrchestrationActor,
  signal?: AbortSignal,
) => unknown | Promise<unknown>

/** 把模型不可控的步骤定义补全为服务输入，初始状态只能由 Host 设为 planned。 */
function toPlannedStep(definition: Static<typeof stepDefinitionSchema>): CanvasOrchestrationStep {
  return { ...definition, status: 'planned', note: '' }
}

/** 未知异常不得把磁盘路径、渠道错误或内部实现带回模型上下文。 */
function publicError(error: unknown): Error {
  const code = error instanceof Error && /^(CANVAS|AGENT_SESSION|DESIGN)_[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'CANVAS_ORCHESTRATION_FAILED'
  return new Error(code)
}

/** 为普通 Agent 构造受关联约束的 owner 身份。 */
function createOwner(context: CanvasToolRunContext, canvasId: string): CanvasOrchestrationOwner {
  return { projectId: context.projectId, canvasId, sessionId: context.sessionId }
}

/** 为编排 Agent 从 Host 上下文构造不可伪造的 actor 身份。 */
function createActor(context: CanvasToolRunContext): CanvasOrchestrationActor {
  if (context.canvasAgentMode !== 'canvas-orchestrator' || !context.canvasAgentTarget || !context.canvasOrchestrationId) {
    throw new Error('CANVAS_ORCHESTRATION_ACCESS_DENIED')
  }
  return {
    projectId: context.projectId,
    canvasId: context.canvasAgentTarget.canvasId,
    sessionId: context.sessionId,
    orchestrationId: context.canvasOrchestrationId,
    runStartedAt: context.runStartedAt,
  }
}

/** 从当前状态派生模型可执行的下一步提示，不替代服务的真实状态机。 */
function nextAction(record: CanvasOrchestrationRecord): string {
  if (record.status === 'completed' || record.status === 'cancelled') return 'none'
  const followUp = record.followUps?.at(-1)
  if (followUp?.status === 'pending') return 'resume-follow-up'
  if (followUp?.status === 'started') return 'inspect-follow-up-run'
  if (followUp?.status === 'failed') return 'retry-follow-up-with-new-id'
  if (record.steps.some(step => step.status === 'needs-review')) return 'review-step'
  if (record.steps.some(step => step.status === 'planned')) return 'dispatch-or-update-plan'
  if (record.status === 'blocked') return 'inspect-and-resume'
  return record.steps.length === 0 ? 'update-plan' : 'wait-or-finish'
}

/** 写操作仅返回任务推进所需的稳定摘要，避免重复回传整份大记录。 */
function mutationSummary(record: CanvasOrchestrationRecord) {
  const followUp = record.followUps?.at(-1)
  return {
    id: record.id,
    revision: record.revision,
    status: record.status,
    summary: record.summary,
    stepCounts: {
      total: record.steps.length,
      planned: record.steps.filter(step => step.status === 'planned').length,
      running: record.steps.filter(step => step.status === 'running').length,
      needsReview: record.steps.filter(step => step.status === 'needs-review').length,
      completed: record.steps.filter(step => step.status === 'completed').length,
      blocked: record.steps.filter(step => step.status === 'blocked').length,
    },
    nextAction: nextAction(record),
    ...(followUp ? { followUp: { id: followUp.id, status: followUp.status } } : {}),
  }
}

/** 分页读取完整数组项；任何专业指令或验收标准均不会被字符串截断。 */
function readProjection(
  record: CanvasOrchestrationRecord | null,
  input: { section?: 'overview' | 'constraints' | 'deliverables' | 'steps' | 'followUps'; offset?: number; limit?: number },
) {
  if (!record) return null
  const section = input.section ?? 'overview'
  if (section === 'overview') {
    return {
      id: record.id, revision: record.revision, status: record.status, summary: record.summary,
      request: {
        requestId: record.request.requestId, goal: record.request.goal, intent: record.request.intent,
        referenceNodeIds: record.request.referenceNodeIds,
      },
      coordinatorNodeId: record.coordinatorNodeId,
      runStartedAt: record.runStartedAt,
      counts: {
        constraints: record.request.constraints.length,
        deliverables: record.request.deliverables.length,
        steps: record.steps.length,
        followUps: record.followUps?.length ?? 0,
      },
      nextAction: nextAction(record),
      omittedSections: ['constraints', 'deliverables', 'steps', 'followUps'] as const,
    }
  }
  const entries = section === 'constraints'
    ? record.request.constraints
    : section === 'deliverables'
      ? record.request.deliverables
      : section === 'steps' ? record.steps : record.followUps ?? []
  const offset = Math.min(input.offset ?? 0, entries.length)
  /** 复杂交付物和步骤逐项读取，确保一个完整条目始终落在有界响应内。 */
  const limit = section === 'constraints' ? Math.min(input.limit ?? 8, 16) : Math.min(input.limit ?? 1, 2)
  const page = entries.slice(offset, offset + limit)
  const nextOffset = offset + page.length < entries.length ? offset + page.length : null
  return { id: record.id, revision: record.revision, status: record.status, section, offset,
    entries: page, total: entries.length, nextOffset, omitted: nextOffset !== null || offset > 0 }
}

/** 创建按运行角色收缩的 Canvas 编排工具集合。 */
export function createCanvasOrchestrationTools(
  dependencies: CanvasOrchestrationToolDependencies,
  context: CanvasToolRunContext,
): ToolDefinition[] {
  /** 每次调用重新取得执行上下文，支持 Host 注入当轮创建回执与最新权限事实。 */
  const getExecutionContext = dependencies.getExecutionContext ?? (() => context)

  /** 单工具包装统一执行严格校验、fresh 授权、写守卫和标准 JSON 返回。 */
  const define = <Schema extends TSchema>(
    name: string,
    label: string,
    description: string,
    parameters: Schema,
    mutates: boolean,
    resolveCanvasId: (input: Static<Schema>, executionContext: CanvasToolRunContext) => string,
    resolveIdentity: (input: Static<Schema>, executionContext: CanvasToolRunContext) => CanvasOrchestrationOwner | CanvasOrchestrationActor,
    handler: OrchestrationHandler<Static<Schema>>,
  ): ToolDefinition => ({
    name, label, description, parameters,
    execute: async (_toolCallId, rawParams, signal) => {
      if (!Value.Check(parameters, rawParams)) throw new Error('CANVAS_ORCHESTRATION_INPUT_INVALID')
      const input = rawParams as Static<Schema>
      const executionContext = getExecutionContext()
      if (mutates && executionContext.permissionCeiling !== 'execute') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
      const canvasId = resolveCanvasId(input, executionContext)
      /** 授权在开始、写守卫内部及返回前复验，取消后不发布旧结果。 */
      const validateAccess = (): void => {
        if (signal?.aborted) throw new Error('CANVAS_ORCHESTRATION_CANCELLED')
        dependencies.access.authorizeRead(executionContext)
        dependencies.access.requireLinkedCanvas(executionContext, canvasId)
      }
      try {
        validateAccess()
        const identity = resolveIdentity(input, executionContext)
        const details = mutates
          ? await dependencies.access.runWrite(executionContext, () => handler(input, identity, signal))
          : await handler(input, identity, signal)
        validateAccess()
        const text = JSON.stringify(details)
        if (Buffer.byteLength(text, 'utf8') > 512 * 1024) throw new Error('CANVAS_ORCHESTRATION_RESPONSE_TOO_LARGE')
        return { content: [{ type: 'text' as const, text }], details }
      } catch (error) {
        throw publicError(error)
      }
    },
  })

  /** Canvas Agent 不能借普通 Agent 工具创建或控制另一份编排。 */
  if (!context.canvasAgentTarget && !context.canvasAgentMode) {
    const canvasId = (input: { canvasId: string }): string => input.canvasId
    const owner = (input: { canvasId: string }, executionContext: CanvasToolRunContext): CanvasOrchestrationOwner => createOwner(executionContext, input.canvasId)
    return [
      define('canvas_delegate', '委托画布编排', '把跨专业且需要持久产物的目标交给画布编排 Agent。纯只读评审继续使用现有只读工具；review 委托不授权媒体生产或修改原有节点。',
        delegateSchema, true, canvasId, owner,
        async (input, identity, signal) => mutationSummary(await dependencies.service.delegate(identity as CanvasOrchestrationOwner, input.request as CanvasOrchestrationRequest, signal))),
      define('canvas_get_orchestration', '查看画布编排', '读取当前画布的权威编排状态、专业步骤与交付摘要，不启动新的执行。',
        canvasTargetSchema, false, canvasId, owner,
        (input, identity) => readProjection(dependencies.service.get(identity), input)),
      define('canvas_resume_orchestration', '继续画布编排', '沿原编排任务和已有产物继续；用户要求发生校正时用 followUp 传递稳定ID、当前revision和完整校正，不修改原始委托。最近校正为 failed 时必须用新 followUp ID 重试；started 结果不明时仅在确认原执行停止后用 supersedesId 显式替代。',
        resumeSchema, true, canvasId, owner,
        async (input, identity, signal) => mutationSummary(await dependencies.service.resume(identity as CanvasOrchestrationOwner,
          input.orchestrationId, input.followUp as CanvasOrchestrationFollowUpInput | undefined, signal))),
      define('canvas_cancel_orchestration', '停止画布编排', '停止原编排并保留已经交付的产物。',
        ownerControlSchema, true, canvasId, owner,
        (input, identity) => mutationSummary(dependencies.service.cancel(identity as CanvasOrchestrationOwner, input.orchestrationId))),
    ]
  }

  /** 只有 Host 明确签发的 coordinator 模式可获得编排写能力。 */
  if (context.canvasAgentMode !== 'canvas-orchestrator') return []
  createActor(context)
  const actorCanvasId = (_input: object, executionContext: CanvasToolRunContext): string => createActor(executionContext).canvasId
  const actor = (_input: object, executionContext: CanvasToolRunContext): CanvasOrchestrationActor => createActor(executionContext)
  return [
    define('canvas_update_plan', '更新专业计划', '提交可核对的专业步骤定义；Host 保留运行状态、预算、尝试次数和版本证据。',
      updatePlanSchema, true, actorCanvasId, actor,
      async (input, identity) => mutationSummary(await dependencies.service.updatePlan(identity as CanvasOrchestrationActor, input.expectedRevision, input.steps.map(toPlannedStep)))),
    define('canvas_dispatch', '分派专业步骤', '执行一个已登记且依赖就绪的专业步骤，结果进入待评审状态。',
      dispatchSchema, true, actorCanvasId, actor,
      async (input, identity) => mutationSummary(await dependencies.service.dispatch(identity as CanvasOrchestrationActor, input.expectedRevision, input.stepId))),
    define('canvas_review_step', '评审专业步骤', '按真实节点版本复核一个专业交付，记录通过或退回结论。',
      reviewStepSchema, true, actorCanvasId, actor,
      async (input, identity) => mutationSummary(await dependencies.service.reviewStep(identity as CanvasOrchestrationActor, input.expectedRevision, input.stepId, input.passed, input.note))),
    define('canvas_finish_orchestration', '结束画布编排', '声明完成、等待或受阻；完成仍需 Host 验证全部步骤和真实交付合同。',
      finishSchema, true, actorCanvasId, actor,
      async (input, identity) => mutationSummary(await dependencies.service.finish(identity as CanvasOrchestrationActor, input.status, input.summary))),
    define('canvas_get_orchestration', '查看画布编排', '读取本次固定画布与任务的权威编排状态。',
      actorReadSchema, false, actorCanvasId, actor,
      (input, identity) => readProjection(dependencies.service.get(identity), input)),
  ]
}
