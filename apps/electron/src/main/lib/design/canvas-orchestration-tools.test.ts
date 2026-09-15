import { describe, expect, test } from 'bun:test'
import type { CanvasOrchestrationRecord } from '@proma/shared'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createCanvasOrchestrationTools, type CanvasOrchestrationToolDependencies } from './canvas-orchestration-tools'
import type { CanvasOrchestrationService } from './canvas-orchestration-service'
import type { CanvasToolRunContext } from './canvas-tool-provider'

/** 测试记录覆盖工具回传与可信身份断言所需的最小完整合同。 */
function createRecord(overrides: Partial<CanvasOrchestrationRecord> = {}): CanvasOrchestrationRecord {
  return {
    schemaVersion: 1,
    id: 'orchestration-1',
    revision: 1,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    ownerSessionId: 'session-1',
    request: {
      requestId: 'request-1',
      goal: '完成可交互原型',
      intent: 'design',
      constraints: ['保持现有主题'],
      referenceNodeIds: [],
      deliverables: [{ id: 'prototype', title: '交互原型', kind: 'webview', criteria: ['可操作'] }],
    },
    coordinatorNodeId: null,
    coordinatorSessionId: null,
    status: 'planning',
    steps: [],
    summary: '',
    runStartedAt: null,
    createdAt: 10,
    updatedAt: 10,
    budget: { maxAgentRuns: 32, agentRunsUsed: 0, maxMediaRuns: 0, mediaRunsUsed: 0 },
    ...overrides,
  }
}

/** 测试通过工具名执行真实 ToolDefinition，保持与 Pi 调用形态一致。 */
async function executeTool(tools: ToolDefinition[], name: string, input: unknown, signal?: AbortSignal) {
  const tool = tools.find(candidate => candidate.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool.execute('call-1', input as never, signal as never, undefined as never, undefined as never)
}

/** 构造可观测的服务替身，测试仅覆盖工具边界而不重复领域服务行为。 */
function createService(calls: Array<{ method: string; args: unknown[] }>): CanvasOrchestrationService {
  const record = createRecord()
  /** 分支方法不会在本工具切片触发，仅补足当前生产服务的完整类型合同。 */
  const step = { id: 'step-1', title: '设计', role: '设计师', instruction: '完成设计', dependsOn: [],
    inputNodeIds: [], outputNodeIds: [], agentNodeId: 'agent-1', criteria: [], status: 'running' as const, note: '' }
  return {
    /** 测试替身不产生实际写入，占位释放保持与生产服务合同一致。 */
    acquireWriteLease: () => () => undefined,
    get: (target) => { calls.push({ method: 'get', args: [target] }); return record },
    delegate: async (...args) => { calls.push({ method: 'delegate', args }); return record },
    resume: async (...args) => { calls.push({ method: 'resume', args }); return record },
    recover: async (...args) => { calls.push({ method: 'recover', args }); return record },
    cancel: (...args) => { calls.push({ method: 'cancel', args }); return record },
    assertActor: (...args) => { calls.push({ method: 'assertActor', args }); return record },
    assertBranch: (...args) => { calls.push({ method: 'assertBranch', args }); return { record, step } },
    updatePlan: async (...args) => { calls.push({ method: 'updatePlan', args }); return record },
    dispatch: async (...args) => { calls.push({ method: 'dispatch', args }); return record },
    registerOutput: async (...args) => { calls.push({ method: 'registerOutput', args }); return record },
    reviewStep: async (...args) => { calls.push({ method: 'reviewStep', args }); return record },
    finish: async (...args) => { calls.push({ method: 'finish', args }); return record },
    report: (...args) => { calls.push({ method: 'report', args }); return record },
    reserveMedia: (...args) => { calls.push({ method: 'reserveMedia', args }); return record },
  }
}

/** 普通 Agent 的可信上下文不带任何画布内部执行身份。 */
const ownerContext: CanvasToolRunContext = {
  projectId: 'project-1', sessionId: 'session-1', runStartedAt: 10,
  explicitReferences: [], permissionCeiling: 'execute',
}

/** 编排 Agent 的目标与任务身份只能由 Host 上下文注入。 */
const actorContext: CanvasToolRunContext = {
  projectId: 'project-1', sessionId: 'coordinator-session', runStartedAt: 20,
  explicitReferences: [], permissionCeiling: 'execute',
  canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'coordinator-node' },
  canvasAgentMode: 'canvas-orchestrator', canvasOrchestrationId: 'orchestration-1',
}

describe('Canvas 编排工具角色边界', () => {
  test('Given 普通 Agent When 创建工具 Then 只获得委托控制和读取能力', () => {
    const tools = createCanvasOrchestrationTools({
      service: createService([]),
      access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: (_context, effect) => effect() },
    }, ownerContext)
    expect(tools.map(tool => tool.name)).toEqual([
      'canvas_delegate', 'canvas_get_orchestration', 'canvas_resume_orchestration', 'canvas_cancel_orchestration',
    ])
  })

  test('Given 画布编排 Agent When 创建工具 Then 只获得计划分派评审完成和固定目标读取能力', () => {
    const tools = createCanvasOrchestrationTools({
      service: createService([]),
      access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: (_context, effect) => effect() },
    }, actorContext)
    expect(tools.map(tool => tool.name)).toEqual([
      'canvas_update_plan', 'canvas_dispatch', 'canvas_review_step', 'canvas_report_orchestration', 'canvas_finish_orchestration', 'canvas_get_orchestration',
    ])
  })

  test('Given 非编排 Canvas Agent When 创建工具 Then 不获得普通或编排控制能力', () => {
    for (const canvasAgentMode of ['renderer-manual', 'parent-orchestrated'] as const) {
      const tools = createCanvasOrchestrationTools({
        service: createService([]),
        access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: (_context, effect) => effect() },
      }, { ...actorContext, canvasAgentMode })
      expect(tools).toEqual([])
    }
  })
})

test('Given 另一个已关联会话 When 读取原owner委托 Then 不泄露报告和决策内容', async () => {
  /** 关联允许访问画布，不等于可以读取另一会话的业务委托。 */
  const tools = createCanvasOrchestrationTools({ service: createService([]),
    access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: (_context, effect) => effect() },
  }, { ...ownerContext, sessionId: 'different-owner' })
  await expect(executeTool(tools, 'canvas_get_orchestration', { canvasId: 'canvas-1' }))
    .rejects.toThrow('CANVAS_ORCHESTRATION_OWNER_MISMATCH')
})

test('Given 普通 Agent 委托 When 执行 Then 从上下文构造 owner 并透传取消信号', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const authorization: string[] = []
  const controller = new AbortController()
  const tools = createCanvasOrchestrationTools({
    service: createService(calls),
    access: {
      authorizeRead: () => { authorization.push('read') },
      requireLinkedCanvas: (_context, canvasId) => { authorization.push(`canvas:${canvasId}`); return {} as never },
      runWrite: (_context, effect) => { authorization.push('write'); return effect() },
    },
  }, ownerContext)
  const request = createRecord().request
  const result = await executeTool(tools, 'canvas_delegate', { canvasId: 'canvas-1', request }, controller.signal)
  expect(calls[0]).toEqual({
    method: 'delegate',
    args: [{ projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'session-1' }, request, controller.signal],
  })
  expect(authorization).toEqual(['read', 'canvas:canvas-1', 'write', 'read', 'canvas:canvas-1'])
  const details = {
    id: 'orchestration-1', revision: 1, status: 'planning', summary: '',
    stepCounts: { total: 0, planned: 0, running: 0, needsReview: 0, completed: 0, blocked: 0 },
    nextAction: 'update-plan',
  }
  expect(result.details).toMatchObject(details)
  expect(result.details).toHaveProperty('progress')
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.details) }])
})

test('Given 合法大计划 When 分页读取 Then 概要标明省略且步骤正文保持完整', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const service = createService(calls)
  const instruction = '镜头设计'.repeat(8_000)
  service.get = () => createRecord({
    steps: [
      { id: 'step-1', title: '镜头设计', role: '导演', instruction, dependsOn: [], inputNodeIds: [], outputNodeIds: [],
        agentNodeId: null, criteria: ['逐镜头可核对'], status: 'planned', note: '' },
      { id: 'step-2', title: '剪辑设计', role: '剪辑师', instruction: '完成节奏设计', dependsOn: ['step-1'], inputNodeIds: [],
        outputNodeIds: [], agentNodeId: null, criteria: [], status: 'planned', note: '' },
    ],
  })
  const tools = createCanvasOrchestrationTools({
    service,
    access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: (_context, effect) => effect() },
  }, ownerContext)
  const overview = await executeTool(tools, 'canvas_get_orchestration', { canvasId: 'canvas-1' })
  expect(overview.details).toMatchObject({ counts: { steps: 2, followUps: 0 },
    omittedSections: ['constraints', 'deliverables', 'steps', 'followUps'] })
  const page = await executeTool(tools, 'canvas_get_orchestration', {
    canvasId: 'canvas-1', section: 'steps', offset: 0, limit: 1,
  })
  expect(page.details).toMatchObject({ section: 'steps', total: 2, nextOffset: 1, omitted: true })
  expect((page.details as { entries: Array<{ instruction: string }> }).entries[0]?.instruction).toBe(instruction)
})

test('Given 编排已有校正 When 分页读取 Then 普通会话可读取完整校正文与状态', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const service = createService(calls)
  service.get = () => createRecord({ followUps: [{
    id: 'correction-1', instruction: '重新读取正式正文后修正阶段映射', status: 'delivered',
    createdAt: 10, startedAt: 20, userMessageUuid: 'a'.repeat(64),
  }] })
  const tools = createCanvasOrchestrationTools({
    service,
    access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: (_context, effect) => effect() },
  }, ownerContext)

  const page = await executeTool(tools, 'canvas_get_orchestration', {
    canvasId: 'canvas-1', section: 'followUps', offset: 0, limit: 1,
  })
  expect(page.details).toMatchObject({ section: 'followUps', total: 1, entries: [{
    id: 'correction-1', instruction: '重新读取正式正文后修正阶段映射', status: 'delivered',
  }] })
})

test.each(['failed', 'started'] as const)(
  'Given 已取消任务保留%s校正 When 读取概要 Then 终态优先且不提示重试或检查运行', async followUpStatus => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const service = createService(calls)
    service.get = () => createRecord({ status: 'cancelled', followUps: [{
      id: 'correction-1', instruction: '保留历史校正', status: followUpStatus,
      createdAt: 10, startedAt: 20, userMessageUuid: 'a'.repeat(64),
    }] })
    const tools = createCanvasOrchestrationTools({ service,
      access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: (_context, effect) => effect() } }, ownerContext)

    const overview = await executeTool(tools, 'canvas_get_orchestration', { canvasId: 'canvas-1' })

    expect(overview.details).toMatchObject({ status: 'cancelled', nextAction: 'none' })
  },
)

test('Given 普通 Agent 未关联目标画布 When 读取 Then 在服务调用前拒绝', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const tools = createCanvasOrchestrationTools({
    service: createService(calls),
    access: {
      authorizeRead: () => undefined,
      requireLinkedCanvas: () => { throw new Error('CANVAS_ACCESS_DENIED') },
      runWrite: (_context, effect) => effect(),
    },
  }, ownerContext)
  await expect(executeTool(tools, 'canvas_get_orchestration', { canvasId: 'other-canvas' })).rejects.toThrow('CANVAS_ACCESS_DENIED')
  expect(calls).toEqual([])
})

test('Given 恢复编排并提交校正 When 执行 Then 透传原任务、CAS、校正和取消信号', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const controller = new AbortController()
  const tools = createCanvasOrchestrationTools({
    service: createService(calls),
    access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: (_context, effect) => effect() },
  }, ownerContext)
  await executeTool(tools, 'canvas_resume_orchestration', {
    canvasId: 'canvas-1', orchestrationId: 'orchestration-1',
    followUp: { id: 'correction-1', expectedRevision: 1, instruction: '重新读取正式正文后修正计划', supersedesId: 'stuck-correction' },
  }, controller.signal)
  expect(calls[0]?.method).toBe('resume')
  expect(calls[0]?.args[2]).toEqual({ id: 'correction-1', expectedRevision: 1,
    instruction: '重新读取正式正文后修正计划', supersedesId: 'stuck-correction' })
  expect(calls[0]?.args[3]).toBe(controller.signal)
})

test('Given 编排 Agent 更新计划 When 执行 Then 只能提交步骤定义且身份固定来自上下文', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const tools = createCanvasOrchestrationTools({
    service: createService(calls),
    access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: (_context, effect) => effect() },
  }, actorContext)
  const definition = {
    id: 'step-1', title: '交互设计', role: '交互设计师', instruction: '完成关键流程',
    dependsOn: [], inputNodeIds: [], outputNodeIds: [], agentNodeId: null, criteria: ['流程完整'],
  }
  await executeTool(tools, 'canvas_update_plan', { expectedRevision: 1, steps: [definition] })
  expect(calls[0]).toEqual({
    method: 'updatePlan',
    args: [{ projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'coordinator-session',
      orchestrationId: 'orchestration-1', runStartedAt: 20 }, 1, [{ ...definition, status: 'planned', note: '' }]],
  })
})

test('Given 工具输入包含 Host 字段或未知字段 When 执行 Then 严格拒绝且不进入服务', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const dependencies: CanvasOrchestrationToolDependencies = {
    service: createService(calls),
    access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: <T,>(_context: CanvasToolRunContext, effect: () => T): T => effect() },
  }
  const ownerTools = createCanvasOrchestrationTools(dependencies, ownerContext)
  const actorTools = createCanvasOrchestrationTools(dependencies, actorContext)
  const request = createRecord().request
  for (const input of [
    { canvasId: 'canvas-1', request, budget: { maxAgentRuns: 99 } },
    { canvasId: 'canvas-1', request: { ...request, sessionId: 'forged' } },
    { canvasId: 'canvas-1', orchestrationId: 'orchestration-1', runStartedAt: 99 },
  ]) {
    const name = 'request' in input ? 'canvas_delegate' : 'canvas_get_orchestration'
    await expect(executeTool(ownerTools, name, input)).rejects.toThrow('CANVAS_ORCHESTRATION_INPUT_INVALID')
  }
  const definition = { id: 'step-1', title: '设计', role: '设计师', instruction: '完成设计', dependsOn: [],
    inputNodeIds: [], outputNodeIds: [], agentNodeId: null, criteria: [] }
  for (const input of [
    { expectedRevision: 1, steps: [{ ...definition, status: 'completed', note: '伪造完成' }] },
    { expectedRevision: 1, steps: [{ ...definition, attempts: 8 }] },
    { expectedRevision: 1, steps: [definition], canvasId: 'other-canvas' },
    { expectedRevision: 1, steps: [definition], orchestrationId: 'forged' },
  ]) {
    await expect(executeTool(actorTools, 'canvas_update_plan', input)).rejects.toThrow('CANVAS_ORCHESTRATION_INPUT_INVALID')
  }
  expect(calls).toEqual([])
})

test('Given 编排上下文缺少可信身份 When 创建工具 Then fail closed', () => {
  const dependencies: CanvasOrchestrationToolDependencies = {
    service: createService([]),
    access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: <T,>(_context: CanvasToolRunContext, effect: () => T): T => effect() },
  }
  for (const context of [
    { ...actorContext, canvasOrchestrationId: undefined },
    { ...actorContext, canvasAgentTarget: undefined },
  ]) {
    expect(() => createCanvasOrchestrationTools(dependencies, context)).toThrow('CANVAS_ORCHESTRATION_ACCESS_DENIED')
  }
})

test('Given 编排者汇报进度 When 执行报告工具 Then 固定身份和CAS送达且禁止伪造Host字段', async () => {
  /** 工具替身只观察边界，报告持久化在服务测试中验证。 */
  const calls: Array<{ method: string; args: unknown[] }> = []
  /** 复用正式工具与写权限入口，不让报告内容赋予角色权限。 */
  const dependencies: CanvasOrchestrationToolDependencies = { service: createService(calls),
    access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: (_context, effect) => effect() } }
  /** 初始交接可在没有步骤时报告需求理解，不要求产生空卡片。 */
  const report = { summary: '已理解需要可操作原型，准备信息结构与交互设计', nextStep: '先整理核心用户路径',
    decision: { id: 'direction', question: '优先哪种布局？',
      options: [{ id: 'compact', label: '紧凑布局', impact: '信息密度较高' }, { id: 'spacious', label: '舒展布局', impact: '页面较长' }],
      recommendedOptionId: 'compact', reason: '适合当前桌面使用目标' } }
  /** 只允许当前编排运行发表协作报告。 */
  const tools = createCanvasOrchestrationTools(dependencies, actorContext)
  await executeTool(tools, 'canvas_report_orchestration', { expectedRevision: 1, report })
  expect(calls[0]).toEqual({ method: 'report', args: [{ projectId: 'project-1', canvasId: 'canvas-1',
    sessionId: 'coordinator-session', orchestrationId: 'orchestration-1', runStartedAt: 20 }, 1, report] })
  for (const invalid of [{ ...report, stale: false }, { ...report, reportedAt: 20 }, { ...report, basedOnRevision: 1 },
    { ...report, decision: { ...report.decision, resolved: true } }]) {
    await expect(executeTool(tools, 'canvas_report_orchestration', { expectedRevision: 1, report: invalid }))
      .rejects.toThrow('CANVAS_ORCHESTRATION_INPUT_INVALID')
  }
  expect(calls).toHaveLength(1)
  await expect(executeTool(createCanvasOrchestrationTools(dependencies, { ...actorContext, permissionCeiling: 'plan' }),
    'canvas_report_orchestration', { expectedRevision: 1, report })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
})

test('Given owner回答待决策项 When 恢复同一委托 Then 透传decisionId和用户原文', async () => {
  /** 服务接受的来源身份必须由工具上下文重建。 */
  const calls: Array<{ method: string; args: unknown[] }> = []
  /** 回答复用现有恢复工具，不新增一个可绕过会话归属的写入口。 */
  const tools = createCanvasOrchestrationTools({ service: createService(calls),
    access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: (_context, effect) => effect() } }, ownerContext)
  await executeTool(tools, 'canvas_resume_orchestration', { canvasId: 'canvas-1', orchestrationId: 'orchestration-1',
    followUp: { id: 'answer-1', expectedRevision: 1, decisionId: 'direction', instruction: '选择紧凑布局，保留原有主题' } })
  expect(calls[0]?.args[2]).toEqual({ id: 'answer-1', expectedRevision: 1, decisionId: 'direction', instruction: '选择紧凑布局，保留原有主题' })
})

test('Given 等待业务决策 When 普通聊天查询概要 Then 返回阶段事实和问题且不建议直接分派', async () => {
  /** 用真实投影测试问题优先级，不由UI猜测summary里是否有问号。 */
  const service = createService([])
  service.get = () => createRecord({ status: 'waiting', report: {
    summary: '需要确认布局方向', nextStep: '等待用户选择', reportedAt: 10, basedOnRevision: 1, stale: false,
    decision: { id: 'direction', question: '选择哪个方向？', recommendedOptionId: 'a', reason: '桌面更适合',
      options: [{ id: 'a', label: '紧凑', impact: '信息集中' }, { id: 'b', label: '舒展', impact: '页面较长' }] },
  } })
  /** 普通Agent获取的是有界阶段数据，完整专业指令仍按需分页读取。 */
  const tools = createCanvasOrchestrationTools({ service,
    access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({} as never), runWrite: (_context, effect) => effect() } }, ownerContext)
  const result = await executeTool(tools, 'canvas_get_orchestration', { canvasId: 'canvas-1' })
  expect(result.details).toMatchObject({ nextAction: 'answer-decision', progress: {
    stepCounts: { total: 0, completed: 0 }, pendingDecision: { id: 'direction' }, report: { stale: false },
  } })
})
