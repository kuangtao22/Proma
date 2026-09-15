import { describe, expect, test } from 'bun:test'
import {
  getCanvasOrchestrationPendingDecision,
  getCanvasOrchestrationProgress,
  isCanvasOrchestrationTerminal,
  parseCanvasOrchestrationChangedEvent,
  parseCanvasOrchestrationRecord,
  parseCanvasOrchestrationReportInput,
  parseCanvasOrchestrationRequest,
  parseCanvasOrchestrationStep,
} from './canvas-orchestration'
import type { CanvasOrchestrationRecord, CanvasOrchestrationReportInput } from './canvas-orchestration'

/** 构造覆盖视频前期设计、试片与交付阶段的合法编排记录。 */
function videoRecord(): CanvasOrchestrationRecord {
  return {
    schemaVersion: 1,
    id: 'orchestration-one',
    revision: 1,
    projectId: 'project-one',
    canvasId: 'canvas-one',
    ownerSessionId: 'session-one',
    request: {
      requestId: 'request-one',
      goal: '制作一支完整的产品短片',
      intent: 'produce',
      constraints: ['18 秒', '竖屏'],
      referenceNodeIds: ['brief-one'],
      deliverables: [
        { id: 'script', title: '脚本', kind: 'document', criteria: ['时长可执行'] },
        { id: 'film', title: '成片', kind: 'video', criteria: ['完整视听验收'] },
      ],
    },
    coordinatorNodeId: 'director-agent',
    coordinatorSessionId: 'director-session',
    status: 'running',
    steps: [
      {
        id: 'script-design', title: '脚本设计', role: '编剧', instruction: '完成叙事、旁白和时长预算。',
        dependsOn: [], inputNodeIds: ['brief-one'], outputNodeIds: ['script-node'], agentNodeId: 'writer-agent',
        criteria: ['脚本覆盖完整信息'], status: 'completed', note: '导演已确认方向。',
      },
      {
        id: 'shot-design', title: '镜头设计', role: '导演', instruction: '把脚本拆成可执行镜头。',
        dependsOn: ['script-design'], inputNodeIds: ['script-node'], outputNodeIds: ['shot-node'], agentNodeId: null,
        criteria: ['镜头总时长不超过 18 秒'], status: 'needs-review', note: '',
      },
    ],
    summary: '脚本完成，镜头设计待评审。',
    runStartedAt: 100,
    createdAt: 90,
    updatedAt: 110,
  }
}

describe('Canvas 编排共享合同', () => {
  test('Given 编排者报告影响与决策 When 严格解析 Then 保留有界字段和有效推荐项', () => {
    const input: CanvasOrchestrationReportInput = {
      summary: '服装与场景设计已完成，动作设计需要确认方向。',
      nextStep: '等待用户选择动作表现方案。',
      impact: {
        followUpId: 'correction-1',
        affectedStepIds: ['action-design'],
        retainedStepIds: ['costume-design', 'scene-design'],
        explanation: '新要求只改变人物动作，不影响已经确认的造型和场景。',
        additionalWork: '需更新动作段落和受影响镜头。',
        runningWork: '当前没有继续生成媒体。',
      },
      decision: {
        id: 'decision-action-style',
        question: '动作应偏写实还是夸张？',
        options: [
          { id: 'realistic', label: '写实', impact: '动作克制，适合产品宣传。' },
          { id: 'expressive', label: '夸张', impact: '节奏更强，需调整部分镜头。' },
        ],
        recommendedOptionId: 'realistic',
        reason: '当前品牌调性偏真实生活感。',
      },
    }

    expect(parseCanvasOrchestrationReportInput(input)).toEqual(input)
  })

  test('Given 报告含越权字段、无效推荐或冲突步骤 When 解析 Then 拒绝扩大合同', () => {
    const base: CanvasOrchestrationReportInput = {
      summary: '需要确认动作方向。',
      nextStep: '等待用户决策。',
      decision: {
        id: 'decision-one',
        question: '选择哪个动作方向？',
        options: [
          { id: 'option-a', label: '方向 A', impact: '保留当前镜头。' },
          { id: 'option-b', label: '方向 B', impact: '重做一个镜头。' },
        ],
        recommendedOptionId: 'option-a',
        reason: '方向 A 改动更小。',
      },
    }

    expect(() => parseCanvasOrchestrationReportInput({ ...base, hiddenPrompt: '越权' }))
      .toThrow('CANVAS_ORCHESTRATION_REPORT_INVALID')
    expect(() => parseCanvasOrchestrationReportInput({
      ...base,
      decision: { ...base.decision!, recommendedOptionId: 'missing-option' },
    })).toThrow('CANVAS_ORCHESTRATION_REPORT_INVALID')
    expect(() => parseCanvasOrchestrationReportInput({
      ...base,
      impact: {
        followUpId: 'correction-1',
        affectedStepIds: ['action-design'],
        retainedStepIds: ['action-design'],
        explanation: '存在冲突。',
        additionalWork: '',
        runningWork: '',
      },
    })).toThrow('CANVAS_ORCHESTRATION_REPORT_INVALID')
    expect(() => parseCanvasOrchestrationReportInput({ ...base, nextStep: '   ' }))
      .toThrow('CANVAS_ORCHESTRATION_REPORT_INVALID')
    expect(() => parseCanvasOrchestrationReportInput({
      ...base,
      impact: {
        followUpId: 'correction-1', affectedStepIds: ['action-design'], retainedStepIds: [],
        explanation: '动作需要调整。', additionalWork: '   ', runningWork: '当前工作已暂停。',
      },
    })).toThrow('CANVAS_ORCHESTRATION_REPORT_INVALID')
  })

  test('Given 老记录和新增报告 When 读取持久快照 Then 兼容缺省字段并校验当前影响引用', () => {
    const legacy = videoRecord()
    expect(parseCanvasOrchestrationRecord(legacy)).toEqual(legacy)

    const current = videoRecord()
    current.steps.push({
      id: 'action-design', title: '动作设计', role: '动作指导', instruction: '设计连续动作。',
      dependsOn: ['shot-design'], inputNodeIds: [], outputNodeIds: ['action-node'], agentNodeId: null,
      criteria: ['动作可执行'], status: 'planned', note: '',
    })
    current.followUps = [{
      id: 'correction-1', instruction: '增加动作指导。', status: 'delivered', createdAt: 105,
      startedAt: 106, userMessageUuid: 'message-one',
    }]
    current.report = {
      summary: '动作设计待补充。', nextStep: '补充动作设计。',
      impact: {
        followUpId: 'correction-1', affectedStepIds: ['action-design'], retainedStepIds: ['script-design'],
        explanation: '只影响动作设计。', additionalWork: '补充动作设计。', runningWork: '当前执行保持暂停。',
      },
      reportedAt: 109, basedOnRevision: 1, stale: false,
    }

    expect(parseCanvasOrchestrationRecord(current).report).toEqual(current.report)
    const currentImpact = current.report!.impact!
    expect(() => parseCanvasOrchestrationRecord({
      ...current,
      report: { ...current.report, impact: { ...currentImpact, affectedStepIds: ['missing-step'] } },
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    expect(parseCanvasOrchestrationRecord({
      ...current,
      report: {
        ...current.report,
        stale: true,
        impact: { ...currentImpact, followUpId: 'old-follow-up', affectedStepIds: ['old-step'] },
      },
    }).report?.stale).toBe(true)
  })

  test('Given 当前关键决策及回答校正 When 派生待决策 Then 只在未回答且非终态时返回', () => {
    const record = videoRecord()
    record.report = {
      summary: '动作方向待确认。', nextStep: '等待选择。', reportedAt: 109, basedOnRevision: 1, stale: false,
      decision: {
        id: 'decision-one', question: '选择哪个方向？',
        options: [
          { id: 'option-a', label: '方向 A', impact: '保留现有镜头。' },
          { id: 'option-b', label: '方向 B', impact: '调整现有镜头。' },
        ],
        recommendedOptionId: 'option-a', reason: '改动范围较小。',
      },
    }

    expect(getCanvasOrchestrationPendingDecision(record)?.id).toBe('decision-one')
    record.followUps = [{
      id: 'answer-one', decisionId: 'decision-one', instruction: '选择方向 A。', status: 'failed',
      createdAt: 109, startedAt: 110, userMessageUuid: 'message-one',
    }]
    expect(getCanvasOrchestrationPendingDecision(record)).toBeNull()
    expect(parseCanvasOrchestrationRecord(record).followUps?.[0]?.decisionId).toBe('decision-one')
    record.followUps = undefined
    record.status = 'completed'
    expect(getCanvasOrchestrationPendingDecision(record)).toBeNull()
    record.status = 'running'
    record.report.stale = true
    expect(getCanvasOrchestrationPendingDecision(record)?.id).toBe('decision-one')
  })

  test('Given 大型步骤列表 When 派生业务进度 Then 统计全部并按风险优先有界展示', () => {
    const record = videoRecord()
    record.steps = [
      ...Array.from({ length: 5 }, (_unused, index) => ({
        ...record.steps[0]!, id: `blocked-${index}`, title: `阻塞步骤 ${index}`, status: 'blocked' as const,
      })),
      ...Array.from({ length: 4 }, (_unused, index) => ({
        ...record.steps[0]!, id: `running-${index}`, title: `执行步骤 ${index}`, status: 'running' as const,
      })),
      { ...record.steps[0]!, id: 'review-one', title: '评审步骤', status: 'needs-review' },
      { ...record.steps[0]!, id: 'planned-one', title: '计划步骤', status: 'planned' },
      { ...record.steps[0]!, id: 'completed-one', title: '完成步骤', status: 'completed' },
    ]

    const progress = getCanvasOrchestrationProgress(record)
    expect(progress.stepCounts).toEqual({
      total: 12, planned: 1, running: 4, needsReview: 1, completed: 1, blocked: 5,
    })
    expect(progress.currentSteps).toEqual({
      items: [
        ...record.steps.slice(0, 5).map(({ id, title, status }) => ({ id, title, status })),
        ...record.steps.slice(5, 8).map(({ id, title, status }) => ({ id, title, status })),
      ],
      total: 11,
      omitted: 3,
    })
  })

  test('Given 只有完成步骤或报告已过期 When 派生进度 Then 回退展示完成项且不沿用旧建议', () => {
    const record = videoRecord()
    record.steps = record.steps.map(step => ({ ...step, status: 'completed' as const }))
    expect(getCanvasOrchestrationProgress(record).currentSteps.total).toBe(2)

    record.report = {
      summary: '历史影响评估。', nextStep: '执行旧方案。', reportedAt: 109, basedOnRevision: 1, stale: true,
    }
    expect(getCanvasOrchestrationProgress(record).nextStep).toBe('编排报告已过期，需要画布 Agent 更新影响评估。')
  })

  test('Given 终态旧建议或当前待决策 When 派生进度 Then 终态和用户决策拥有更高优先级', () => {
    const record = videoRecord()
    record.report = {
      summary: '历史报告。', nextStep: '继续执行旧任务。', reportedAt: 109, basedOnRevision: 1, stale: false,
      decision: {
        id: 'decision-one', question: '是否继续？',
        options: [
          { id: 'continue', label: '继续', impact: '继续执行。' },
          { id: 'stop', label: '停止', impact: '停止执行。' },
        ],
        recommendedOptionId: 'continue', reason: '仍有待交付工作。',
      },
    }

    expect(getCanvasOrchestrationProgress(record).nextStep).toBe('等待用户决策。')
    record.status = 'completed'
    expect(getCanvasOrchestrationProgress(record).nextStep).toBe('编排已完成。')
    record.status = 'cancelled'
    expect(getCanvasOrchestrationProgress(record).nextStep).toBe('编排已取消。')
  })

  test('Given 完整视频计划 When 严格解析并序列化往返 Then 保留专业步骤与真实节点引用', () => {
    const record = videoRecord()

    expect(parseCanvasOrchestrationRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
    expect(parseCanvasOrchestrationRequest(record.request)).toEqual(record.request)
    expect(parseCanvasOrchestrationStep(record.steps[1]!)).toEqual(record.steps[1]!)
  })

  test('Given UI 交互设计计划 When 解析 Then 接受网页原型交付类型', () => {
    const record = videoRecord()
    record.request.intent = 'design'
    record.request.deliverables = [
      { id: 'interaction-spec', title: '交互说明', kind: 'document', criteria: ['覆盖异常状态'] },
      { id: 'prototype', title: '可交互原型', kind: 'webview', criteria: ['键盘可操作'] },
    ]
    record.steps = [{
      id: 'prototype-design', title: '原型设计', role: '交互设计师', instruction: '实现核心任务路径。',
      dependsOn: [], inputNodeIds: [], outputNodeIds: ['prototype-node'], agentNodeId: null,
      criteria: ['可完成主流程'], status: 'planned', note: '',
    }]

    expect(parseCanvasOrchestrationRecord(record).request.deliverables[1]?.kind).toBe('webview')
  })

  test('Given Host冻结版本与预算 When 解析 Then 保留有界执行证据', () => {
    const record = videoRecord()
    const execution = { startedAt: 101, userMessageUuid: 'specialist-anchor-1' }
    const stepWithEvidence = {
      ...record.steps[0]!,
      inputVersions: [{ nodeId: 'brief-one', identity: 'revision-1' }],
      outputVersions: [{ nodeId: 'script-node', identity: 'sha256-abc' }],
      execution,
      attempts: 2,
    }
    record.budget = {
      maxAgentRuns: 32, agentRunsUsed: 2, maxMediaRuns: 16, mediaRunsUsed: 1,
      mediaReservations: [{ operationId: 'media-operation-1', count: 1 }],
    }

    const parsed = parseCanvasOrchestrationRecord({ ...record, steps: [stepWithEvidence, record.steps[1]!] })
    expect(parsed.steps[0]?.execution).toEqual(execution)
    expect(() => parseCanvasOrchestrationStep({ ...stepWithEvidence, execution: { ...execution, startedAt: 0 } }))
      .toThrow('CANVAS_ORCHESTRATION_STEP_INVALID')
  })

  test('Given 普通会话提交后续校正 When 解析记录 Then 保留有界状态和稳定执行锚点', () => {
    const record = videoRecord()
    record.followUps = [{
      id: 'correction-1',
      instruction: '重新读取两份正式文档，并在原交付合同内修正阶段映射。',
      status: 'started',
      createdAt: 105,
      startedAt: 106,
      userMessageUuid: 'a'.repeat(64),
    }]

    expect(parseCanvasOrchestrationRecord(record).followUps).toEqual(record.followUps)
    expect(() => parseCanvasOrchestrationRecord({
      ...record,
      followUps: [{ ...record.followUps![0], instruction: '修'.repeat(4_097) }],
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    expect(() => parseCanvasOrchestrationRecord({
      ...record,
      followUps: [{ ...record.followUps![0], status: 'pending', startedAt: 106, userMessageUuid: 'a'.repeat(64) }],
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    record.followUps = [
      { ...record.followUps[0]!, status: 'abandoned' },
      { id: 'correction-2', instruction: '用新身份重试校正', supersedesId: 'correction-1', status: 'pending', createdAt: 108 },
    ]
    expect(parseCanvasOrchestrationRecord(record).followUps?.map(item => item.status)).toEqual(['abandoned', 'pending'])
  })

  test('Given 后继校正指向未放弃的旧尝试 When 读取持久快照 Then 拒绝单向伪造替代关系', () => {
    const record = videoRecord()
    record.followUps = [
      { id: 'correction-1', instruction: '第一次校正', status: 'delivered', createdAt: 101,
        startedAt: 102, userMessageUuid: 'a'.repeat(64) },
      { id: 'correction-2', instruction: '伪造替代', supersedesId: 'correction-1', status: 'failed', createdAt: 103,
        startedAt: 104, userMessageUuid: 'b'.repeat(64) },
    ]

    expect(() => parseCanvasOrchestrationRecord(record)).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
  })

  test('Given abandoned校正没有唯一后继 When 读取持久快照 Then 拒绝悬空或重复替代关系', () => {
    const record = videoRecord()
    /** 被放弃的旧尝试必须由且仅由一个后继明确接管。 */
    const abandoned = { id: 'correction-1', instruction: '第一次校正', status: 'abandoned' as const, createdAt: 101,
      startedAt: 102, userMessageUuid: 'a'.repeat(64) }
    expect(() => parseCanvasOrchestrationRecord({ ...record, followUps: [abandoned] }))
      .toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    expect(() => parseCanvasOrchestrationRecord({ ...record, followUps: [abandoned,
      { id: 'correction-2', instruction: '第一次替代', supersedesId: abandoned.id, status: 'delivered', createdAt: 103,
        startedAt: 104, userMessageUuid: 'b'.repeat(64) },
      { id: 'correction-3', instruction: '重复替代', supersedesId: abandoned.id, status: 'failed', createdAt: 105,
        startedAt: 106, userMessageUuid: 'c'.repeat(64) },
    ] })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
  })

  test('Given 下游输入来自依赖步骤输出 When 解析完整记录 Then 接受有效版本并拒绝范围外节点', () => {
    const record = videoRecord()
    record.steps[1] = {
      ...record.steps[1]!,
      inputVersions: [{ nodeId: 'script-node', identity: 'a'.repeat(64) }],
    }

    expect(parseCanvasOrchestrationRecord(record).steps[1]?.inputVersions?.[0]?.nodeId).toBe('script-node')
    record.steps[1]!.inputVersions = [{ nodeId: 'unrelated-node', identity: 'b'.repeat(64) }]
    expect(() => parseCanvasOrchestrationRecord(record)).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
  })

  test('Given 下游汇总多个步骤产物 When 解析完整记录 Then 完整输入最多支持128项且拒绝静默截断', () => {
    const record = videoRecord()
    const upstream = Array.from({ length: 4 }, (_unused, groupIndex) => ({
      id: `upstream-${groupIndex}`,
      title: `上游${groupIndex}`,
      role: '专业设计',
      instruction: '交付本阶段完整产物。',
      dependsOn: [],
      inputNodeIds: [],
      outputNodeIds: Array.from({ length: 32 }, (_item, nodeIndex) => `output-${groupIndex}-${nodeIndex}`),
      agentNodeId: null,
      criteria: ['产物完整'],
      status: 'completed' as const,
      note: '已验收',
    }))
    const inputNodeIds = upstream.flatMap(step => step.outputNodeIds)
    const downstream = {
      id: 'downstream',
      title: '汇总',
      role: '总审',
      instruction: '读取全部上游产物并形成结论。',
      dependsOn: upstream.map(step => step.id),
      inputNodeIds: [],
      outputNodeIds: [],
      agentNodeId: null,
      criteria: ['没有遗漏输入'],
      status: 'running' as const,
      note: '',
      inputVersions: inputNodeIds.map(nodeId => ({ nodeId, identity: 'a'.repeat(64) })),
    }
    record.steps = [...upstream, downstream]

    expect(parseCanvasOrchestrationRecord(record).steps.at(-1)?.inputVersions).toHaveLength(128)
    const overflow = { ...upstream[0]!, id: 'overflow', outputNodeIds: ['overflow-output'] }
    const { inputVersions: _inputVersions, ...unversionedDownstream } = downstream
    expect(() => parseCanvasOrchestrationRecord({
      ...record,
      steps: [...upstream, overflow, {
        ...unversionedDownstream,
        dependsOn: [...downstream.dependsOn, overflow.id],
      }],
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
  })

  test('Given Host版本证据或预算越界 When 解析 Then 拒绝伪造执行事实', () => {
    const record = videoRecord()
    const step = record.steps[0]!

    expect(() => parseCanvasOrchestrationRecord({
      ...record,
      steps: [{ ...step, inputVersions: [{ nodeId: 'not-an-input', identity: 'revision-1' }] }],
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    expect(() => parseCanvasOrchestrationStep({ ...step, attempts: 9 }))
      .toThrow('CANVAS_ORCHESTRATION_STEP_INVALID')
    expect(() => parseCanvasOrchestrationRecord({
      ...record, budget: { maxAgentRuns: 32, agentRunsUsed: 33, maxMediaRuns: 16, mediaRunsUsed: 0 },
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    expect(() => parseCanvasOrchestrationRecord({
      ...record,
      budget: {
        maxAgentRuns: 32, agentRunsUsed: 1, maxMediaRuns: 16, mediaRunsUsed: 1,
        mediaReservations: [{ operationId: 'media-operation-1', count: 2 }],
      },
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
  })

  test('Given 未知字段或不安全ID When 解析 Then 拒绝扩大合同与路径作用域', () => {
    const record = videoRecord()

    expect(() => parseCanvasOrchestrationRequest({ ...record.request, hiddenPrompt: '越权' }))
      .toThrow('CANVAS_ORCHESTRATION_REQUEST_INVALID')
    expect(() => parseCanvasOrchestrationStep({ ...record.steps[0], id: '../escape' }))
      .toThrow('CANVAS_ORCHESTRATION_STEP_INVALID')
    expect(() => parseCanvasOrchestrationRecord({ ...record, projectId: 'project/escape' }))
      .toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
  })

  test('Given 重复步骤、悬空依赖、自依赖或依赖环 When 解析记录 Then 全部拒绝', () => {
    const record = videoRecord()
    const first = record.steps[0]!
    const second = record.steps[1]!

    expect(() => parseCanvasOrchestrationRecord({ ...record, steps: [first, { ...second, id: first.id }] }))
      .toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    expect(() => parseCanvasOrchestrationRecord({ ...record, steps: [first, { ...second, dependsOn: ['missing'] }] }))
      .toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    expect(() => parseCanvasOrchestrationRecord({ ...record, steps: [{ ...first, dependsOn: [first.id] }, second] }))
      .toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    expect(() => parseCanvasOrchestrationRecord({
      ...record,
      steps: [{ ...first, dependsOn: [second.id] }, { ...second, dependsOn: [first.id] }],
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    expect(() => parseCanvasOrchestrationRecord({
      ...record,
      steps: [first, { ...second, outputNodeIds: [...first.outputNodeIds] }],
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
  })

  test('Given 步骤、节点引用、交付物或正文超过上限 When 解析 Then 明确拒绝', () => {
    const record = videoRecord()
    const step = record.steps[0]!

    expect(() => parseCanvasOrchestrationRecord({
      ...record,
      steps: Array.from({ length: 65 }, (_unused, index) => ({ ...step, id: `step-${index}`, dependsOn: [] })),
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    expect(() => parseCanvasOrchestrationStep({
      ...step,
      inputNodeIds: Array.from({ length: 33 }, (_unused, index) => `node-${index}`),
    })).toThrow('CANVAS_ORCHESTRATION_STEP_INVALID')
    expect(() => parseCanvasOrchestrationRequest({
      ...record.request,
      deliverables: Array.from({ length: 17 }, (_unused, index) => ({
        id: `deliverable-${index}`, title: '交付物', kind: 'document', criteria: [],
      })),
    })).toThrow('CANVAS_ORCHESTRATION_REQUEST_INVALID')
    expect(() => parseCanvasOrchestrationRequest({ ...record.request, goal: '目'.repeat(32_769) }))
      .toThrow('CANVAS_ORCHESTRATION_REQUEST_INVALID')
  })

  test('Given 完成或取消状态 When 判断终态 Then 仅这两类状态停止继续编排', () => {
    expect(isCanvasOrchestrationTerminal('completed')).toBe(true)
    expect(isCanvasOrchestrationTerminal('cancelled')).toBe(true)
    expect(isCanvasOrchestrationTerminal('blocked')).toBe(false)
  })

  test('Given 编排记录发生变化 When 解析轻量事件 Then 只保留画布作用域与revision', () => {
    expect(parseCanvasOrchestrationChangedEvent({
      projectId: 'project-one', canvasId: 'canvas-one', revision: 3,
    })).toEqual({ projectId: 'project-one', canvasId: 'canvas-one', revision: 3 })
    expect(() => parseCanvasOrchestrationChangedEvent({
      projectId: 'project-one', canvasId: 'canvas-one', revision: 3, record: {},
    })).toThrow('CANVAS_ORCHESTRATION_CHANGED_EVENT_INVALID')
  })
})
