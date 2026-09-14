import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasOrchestrationRecord, CanvasOrchestrationRequest, CanvasOrchestrationStep } from '@proma/shared'
import { createCanvasOrchestrationService, type CanvasOrchestrationServiceDependencies } from './canvas-orchestration-service'

/** 构造同画布的受控运行边界，真实模型执行由单独集成测试覆盖。 */
function fixture() {
  /** 当前权威计划、图和可观察执行次数。 */
  let record: CanvasOrchestrationRecord | null = null
  const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
  const calls: string[] = []
  const ownedOutputs: string[] = []
  const dependencies: CanvasOrchestrationServiceDependencies = {
    store: {
      get: () => record ? structuredClone(record) : null,
      create: value => {
        if (record && record.request.requestId === value.request.requestId) return structuredClone(record)
        if (record && !['completed', 'cancelled'].includes(record.status)) throw new Error('CANVAS_ORCHESTRATION_ACTIVE')
        record = structuredClone(value)
        return structuredClone(record)
      },
      save: (_target, revision, value) => {
        if (record?.revision !== revision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
        record = structuredClone(value)
        return structuredClone(record)
      },
    },
    authorizeOwner: () => undefined,
    loadCanvas: () => document,
    createAgent: async (_record, step) => {
      const id = step ? `expert-${step.id}` : 'coordinator'
      calls.push(`create:${id}`)
      document.nodes.push({ id, kind: 'agent', title: id, position: { x: 0, y: 0 }, agentSessionId: `session-${id}` })
      document.revision++
      return { projectId: document.projectId, canvasId: document.canvasId, nodeId: id }
    },
    executeCoordinator: async () => { calls.push('coordinator'); return { status: 'completed' } },
    executeSpecialist: async (_record, step) => {
      calls.push(`execute:${step.id}`)
      const node = document.nodes.find(node => node.id === step.agentNodeId)
      if (!node || node.kind !== 'agent') throw new Error('MISSING_NODE')
      node.outputPointer = { messageUuid: 'output-1', contentSha256: 'a'.repeat(64), completedAt: 50 }
      return { status: 'completed' }
    },
    recoverSpecialist: async (_record, step) => {
      const node = document.nodes.find(node => node.id === step.agentNodeId)
      return node?.kind === 'agent' && node.outputPointer ? 'completed' : 'missing'
    },
    recoverCoordinator: async () => 'missing',
    isCoordinatorBusy: () => false,
    assertOutputOwnership: async (_access, nodeId) => { ownedOutputs.push(nodeId) },
    readNodeIdentity: async (_target, id) => createHash('sha256').update(JSON.stringify(document.nodes.find(node => node.id === id))).digest('hex'),
    verifyDelivery: async () => false,
    onChanged: () => undefined,
    now: (() => { let time = 100; return () => ++time })(),
  }
  const service = createCanvasOrchestrationService(dependencies)
  const request: CanvasOrchestrationRequest = { requestId: 'request-1', goal: '设计交互原型', intent: 'design', constraints: [],
    referenceNodeIds: [], deliverables: [{ id: 'prototype', title: '原型', kind: 'webview', criteria: ['核心路径可操作'] }] }
  const owner = { projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'parent-1' }
  return {
    service, dependencies, request, owner, calls, ownedOutputs, document,
    getRecord: () => record!,
    setRecord: (value: CanvasOrchestrationRecord) => { record = structuredClone(value) },
  }
}

/** 创建可控异步边界，用于验证取消和 CAS 竞争。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** 可逐项验收的专业计划步骤。 */
function step(id: string, dependsOn: string[] = []): CanvasOrchestrationStep {
  return { id, title: id, role: '交互设计', instruction: '设计核心路径', dependsOn, inputNodeIds: [], outputNodeIds: [],
    agentNodeId: null, criteria: ['有正常和异常路径'], status: 'planned', note: '' }
}

describe('画布持久委托与专业分派', () => {
  test.each(['missing-input', 'missing-output', 'incomplete-input', 'incomplete-output'] as const)(
    'Given 已完成祖先的%s版本证据缺失 When 分派下游 Then 不把未知基线当通过且零新增执行', async scenario => {
      /** 先通过实际分派和评审形成合法基线，再模拟旧记录缺失证据。 */
      const f = fixture()
      f.document.nodes.push({ id: 'brief', kind: 'document', title: '需求', position: { x: 0, y: 0 }, documentId: 'brief-content', contentRevision: 1 })
      f.dependencies.executeCoordinator = async record => {
        const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
        const planned = await f.service.updatePlan(actor, record.revision, [{ ...step('script'), inputNodeIds: ['brief'] }, step('shot', ['script'])])
        const executed = await f.service.dispatch(actor, planned.revision, 'script')
        const reviewed = await f.service.reviewStep(actor, executed.revision, 'script', true, '符合原需求')
        const ancestor = reviewed.steps[0]!
        if (scenario === 'missing-input') delete ancestor.inputVersions
        if (scenario === 'missing-output') delete ancestor.outputVersions
        if (scenario === 'incomplete-input') ancestor.inputVersions = []
        if (scenario === 'incomplete-output') ancestor.outputVersions = []
        f.setRecord(reviewed)
        const beforeCalls = [...f.calls]
        const beforeBudget = reviewed.budget!.agentRunsUsed
        await expect(f.service.dispatch(actor, reviewed.revision, 'shot')).rejects.toThrow('CANVAS_ORCHESTRATION_EVIDENCE_STALE')
        expect(f.calls).toEqual(beforeCalls)
        expect(f.getRecord().budget!.agentRunsUsed).toBe(beforeBudget)
        expect(f.getRecord().steps[1]!.status).toBe('planned')
        return { status: 'completed' }
      }
      await f.service.delegate(f.owner, f.request)
    },
  )
  test('Given 委托没有交付物 When 提交编排 Then 入口拒绝且不创建协调Agent', async () => {
    const f = fixture()

    await expect(f.service.delegate(f.owner, { ...f.request, deliverables: [] }))
      .rejects.toThrow('CANVAS_ORCHESTRATION_DELIVERABLES_REQUIRED')
    expect(f.calls).toEqual([])
  })

  test('Given 同一请求重放 When 再次委托 Then 复用身份且不再次创建或运行', async () => {
    const f = fixture()
    const first = await f.service.delegate(f.owner, f.request)
    const replay = await f.service.delegate(f.owner, f.request)
    expect(replay.id).toBe(first.id)
    expect(f.calls).toEqual(['create:coordinator', 'coordinator'])
    expect(replay.status).toBe('waiting')
  })

  test('Given 原任务等待且用户提交校正 When 继续 Then 原委托不变、校正送达且重复提交不重复扣额', async () => {
    const f = fixture()
    const first = await f.service.delegate(f.owner, f.request)
    let received: CanvasOrchestrationRecord | undefined
    let followUpRuns = 0
    f.dependencies.executeCoordinator = async record => {
      followUpRuns += 1
      received = record
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      await f.service.finish(actor, 'blocked', '已接收校正，仍需处理业务阻碍')
      return { status: 'completed' }
    }
    const followUp = { id: 'correction-1', expectedRevision: first.revision, instruction: '重新读取正式正文后修正阶段映射' }

    const resumed = await f.service.resume(f.owner, first.id, followUp)
    const replay = await f.service.resume(f.owner, first.id, followUp)

    expect(received?.request).toEqual(f.request)
    expect(received?.followUps?.at(-1)).toMatchObject({ id: followUp.id, instruction: followUp.instruction, status: 'started' })
    expect(resumed.followUps?.at(-1)?.status).toBe('delivered')
    expect(replay.revision).toBe(resumed.revision)
    expect(replay.budget?.agentRunsUsed).toBe(resumed.budget?.agentRunsUsed)
    expect(followUpRuns).toBe(1)
  })

  test('Given 校正启动前对账正在读取证据 When 普通会话撤权 Then 不扣额、不进入started且不执行协调Agent', async () => {
    const f = fixture()
    const initial = await f.service.delegate(f.owner, f.request)
    const coordinatorNodeId = initial.coordinatorNodeId!
    const outputIdentity = await f.dependencies.readNodeIdentity(initial, coordinatorNodeId)
    /** 已验收步骤确保恢复对账经过异步证据读取边界。 */
    f.setRecord({ ...initial, revision: initial.revision + 1, steps: [{ ...step('existing'),
      agentNodeId: coordinatorNodeId, outputNodeIds: [coordinatorNodeId], status: 'completed',
      inputVersions: [], outputVersions: [{ nodeId: coordinatorNodeId, identity: outputIdentity }] }],
      updatedAt: initial.updatedAt + 1 })
    const before = f.getRecord()
    let authorized = true
    let followUpRuns = 0
    f.dependencies.authorizeOwner = () => {
      if (!authorized) throw new Error('CANVAS_ACCESS_DENIED')
    }
    const readNodeIdentity = f.dependencies.readNodeIdentity
    f.dependencies.readNodeIdentity = async (target, nodeId) => {
      const identity = await readNodeIdentity(target, nodeId)
      authorized = false
      return identity
    }
    f.dependencies.executeCoordinator = async () => {
      followUpRuns += 1
      return { status: 'completed' }
    }

    await expect(f.service.resume(f.owner, initial.id, {
      id: 'correction-revoked', expectedRevision: before.revision, instruction: '重新核对正式产物',
    })).rejects.toThrow('CANVAS_ACCESS_DENIED')

    const persisted = f.getRecord()
    expect(persisted.budget?.agentRunsUsed).toBe(before.budget?.agentRunsUsed)
    expect(persisted.followUps?.at(-1)).toMatchObject({ id: 'correction-revoked', status: 'pending' })
    expect(persisted.runStartedAt).toBe(before.runStartedAt)
    expect(followUpRuns).toBe(0)
  })

  test('Given 校正启动前对账期间出现新revision When 旧启动继续 Then 拒绝覆盖新记录且不扣额或执行', async () => {
    const f = fixture()
    const initial = await f.service.delegate(f.owner, f.request)
    const coordinatorNodeId = initial.coordinatorNodeId!
    const outputIdentity = await f.dependencies.readNodeIdentity(initial, coordinatorNodeId)
    f.setRecord({ ...initial, revision: initial.revision + 1, steps: [{ ...step('existing'),
      agentNodeId: coordinatorNodeId, outputNodeIds: [coordinatorNodeId], status: 'completed',
      inputVersions: [], outputVersions: [{ nodeId: coordinatorNodeId, identity: outputIdentity }] }],
      updatedAt: initial.updatedAt + 1 })
    const before = f.getRecord()
    const readNodeIdentity = f.dependencies.readNodeIdentity
    let concurrentWritten = false
    f.dependencies.readNodeIdentity = async (target, nodeId) => {
      const identity = await readNodeIdentity(target, nodeId)
      if (!concurrentWritten) {
        concurrentWritten = true
        const current = f.getRecord()
        f.setRecord({ ...current, revision: current.revision + 1, summary: '对账期间的新记录', updatedAt: current.updatedAt + 1 })
      }
      return identity
    }
    let followUpRuns = 0
    f.dependencies.executeCoordinator = async () => { followUpRuns += 1; return { status: 'completed' } }

    await expect(f.service.resume(f.owner, initial.id, {
      id: 'correction-conflict', expectedRevision: before.revision, instruction: '重新核对正式产物',
    })).rejects.toThrow('CANVAS_ORCHESTRATION_CONFLICT')

    const persisted = f.getRecord()
    expect(persisted.summary).toBe('对账期间的新记录')
    expect(persisted.budget?.agentRunsUsed).toBe(before.budget?.agentRunsUsed)
    expect(persisted.followUps?.at(-1)?.status).toBe('pending')
    expect(followUpRuns).toBe(0)
  })

  test('Given 失败校正所属任务已取消 When 普通会话再次恢复 Then 直接返回终态且不要求新ID', async () => {
    const f = fixture()
    const initial = await f.service.delegate(f.owner, f.request)
    f.dependencies.executeCoordinator = async () => ({ status: 'errored' })
    const failed = await f.service.resume(f.owner, initial.id, {
      id: 'correction-failed-before-cancel', expectedRevision: initial.revision, instruction: '重新核对正式产物',
    })
    const cancelled = f.service.cancel(f.owner, failed.id)

    const resumed = await f.service.resume(f.owner, cancelled.id)

    expect(resumed.status).toBe('cancelled')
    expect(resumed.revision).toBe(cancelled.revision)
    expect(resumed.followUps?.at(-1)?.status).toBe('failed')
  })

  test('Given coordinator已结算校正为delivered When 执行层随后返回错误 Then 保留结算事实并返回受阻状态', async () => {
    const f = fixture()
    const initial = await f.service.delegate(f.owner, f.request)
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      await f.service.finish(actor, 'blocked', '校正已接收，后续执行受阻')
      return { status: 'errored', failure: { code: 'CANVAS_AGENT_RUN_FAILED', stage: 'execution',
        reasonCode: 'unknown', recovery: 'inspect-node', message: '执行层迟到错误' } }
    }

    const result = await f.service.resume(f.owner, initial.id, {
      id: 'correction-delivered-before-error', expectedRevision: initial.revision, instruction: '重新核对正式产物',
    })

    expect(result.status).toBe('blocked')
    expect(result.followUps?.at(-1)?.status).toBe('delivered')
    expect(result.summary).toBe('执行层迟到错误')
  })

  test('Given 校正执行明确失败 When 普通恢复原任务 Then 校正已结算且后续仍携带同一记录', async () => {
    const f = fixture()
    const initial = await f.service.delegate(f.owner, f.request)
    f.dependencies.executeCoordinator = async () => ({ status: 'errored' })
    const failed = await f.service.resume(f.owner, initial.id, {
      id: 'correction-1', expectedRevision: initial.revision, instruction: '重新读取正式正文',
    })
    expect(failed.status).toBe('blocked')
    expect(failed.followUps?.[0]?.status).toBe('failed')
    const used = failed.budget!.agentRunsUsed
    let retried: CanvasOrchestrationRecord | undefined
    f.dependencies.executeCoordinator = async record => { retried = record; return { status: 'completed' } }

    expect(() => f.service.resume(f.owner, initial.id)).toThrow('CANVAS_ORCHESTRATION_FOLLOW_UP_RETRY_REQUIRED')
    expect(f.getRecord().budget?.agentRunsUsed).toBe(used)
    expect(retried).toBeUndefined()

    await f.service.resume(f.owner, initial.id, {
      id: 'correction-2', expectedRevision: failed.revision, instruction: '重新读取正式正文',
    })

    expect(retried?.followUps?.map(item => item.status)).toEqual(['failed', 'started'])
    expect(retried?.followUps?.[1]).toMatchObject({ id: 'correction-2', instruction: '重新读取正式正文' })
    expect(f.getRecord().budget?.agentRunsUsed).toBe(used + 1)
  })

  test('Given 校正ID已存在或任务正在运行 When 再次提交 Then 异文和新ID均拒绝且不写入', async () => {
    const f = fixture()
    const first = await f.service.delegate(f.owner, f.request)
    const running = deferred<{ status: 'completed' }>()
    const started = deferred<void>()
    f.dependencies.executeCoordinator = async () => { started.resolve(); return running.promise }
    const pending = f.service.resume(f.owner, first.id, {
      id: 'correction-1', expectedRevision: first.revision, instruction: '修正阶段映射',
    })
    await started.promise
    const before = f.getRecord()

    expect(() => f.service.resume(f.owner, first.id, {
      id: 'correction-1', expectedRevision: first.revision, instruction: '偷换另一份要求',
    })).toThrow('CANVAS_ORCHESTRATION_FOLLOW_UP_CONFLICT')
    expect(() => f.service.resume(f.owner, first.id, {
      id: 'correction-2', expectedRevision: before.revision, instruction: '同时启动另一轮',
    })).toThrow('CANVAS_ORCHESTRATION_ACTIVE')
    expect(f.getRecord()).toEqual(before)
    running.resolve({ status: 'completed' })
    await pending
  })

  test('Given 校正已started后进程重启 When 同ID恢复 Then 先核对原消息且不重复扣额或执行', async () => {
    const f = fixture()
    const initial = await f.service.delegate(f.owner, f.request)
    const budgetUsed = initial.budget!.agentRunsUsed
    f.setRecord({ ...initial, revision: initial.revision + 1, status: 'running', runStartedAt: initial.updatedAt + 1,
      followUps: [{ id: 'correction-1', instruction: '核对正式正文', status: 'started', createdAt: initial.updatedAt,
        startedAt: initial.updatedAt + 1, userMessageUuid: 'a'.repeat(64) }], updatedAt: initial.updatedAt + 1 })
    f.dependencies.recoverCoordinator = async () => 'completed'
    const callsBefore = [...f.calls]

    const recovered = await f.service.resume(f.owner, initial.id, {
      id: 'correction-1', expectedRevision: initial.revision, instruction: '核对正式正文',
    })

    expect(recovered.followUps?.[0]?.status).toBe('delivered')
    expect(recovered.budget?.agentRunsUsed).toBe(budgetUsed)
    expect(f.calls).toEqual(callsBefore)
  })

  test('Given started校正无可信终态且协调Agent已停止 When owner显式替代 Then 保留旧锚点和额度并用新身份重试', async () => {
    const f = fixture()
    const initial = await f.service.delegate(f.owner, f.request)
    const startedAt = initial.updatedAt + 1
    f.setRecord({ ...initial, revision: initial.revision + 1, status: 'blocked', runStartedAt: startedAt,
      followUps: [{ id: 'correction-1', instruction: '第一次校正', status: 'started', createdAt: initial.updatedAt,
        startedAt, userMessageUuid: 'a'.repeat(64) }], updatedAt: startedAt })
    const used = f.getRecord().budget!.agentRunsUsed
    let received: CanvasOrchestrationRecord | undefined
    f.dependencies.executeCoordinator = async record => { received = record; return { status: 'completed' } }

    const result = await f.service.resume(f.owner, initial.id, {
      id: 'correction-2', expectedRevision: f.getRecord().revision, instruction: '确认旧执行已停止后重试', supersedesId: 'correction-1',
    })

    expect(received?.followUps?.map(item => item.status)).toEqual(['abandoned', 'started'])
    expect(received?.followUps?.[0]?.userMessageUuid).toBe('a'.repeat(64))
    expect(received?.followUps?.[1]?.userMessageUuid).not.toBe('a'.repeat(64))
    expect(result.followUps?.map(item => item.status)).toEqual(['abandoned', 'delivered'])
    expect(result.budget?.agentRunsUsed).toBe(used + 1)
  })

  test('Given 编排运行仍等待 When 新请求进入 Then 不能替换原目标', async () => {
    const f = fixture()
    await f.service.delegate(f.owner, f.request)
    await expect(f.service.delegate(f.owner, { ...f.request, requestId: 'another-request' })).rejects.toThrow('CANVAS_ORCHESTRATION_ACTIVE')
    expect(f.getRecord().request.goal).toBe(f.request.goal)
  })

  test('Given 专业设计完成 When 分派返回 Then 只进入待评审且保留正式输出身份', async () => {
    const f = fixture()
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      const planned = await f.service.updatePlan(actor, record.revision, [step('interaction')])
      const result = await f.service.dispatch(actor, planned.revision, 'interaction')
      expect(result.steps[0]?.status).toBe('needs-review')
      expect(result.steps[0]?.outputVersions?.length).toBe(1)
      return { status: 'completed' }
    }
    await f.service.delegate(f.owner, f.request)
    expect(f.calls).toContain('execute:interaction')
  })

  test('Given 上游尚未通过评审 When 分派下游 Then 不创建专业节点或启动模型', async () => {
    const f = fixture()
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      const planned = await f.service.updatePlan(actor, record.revision, [step('script'), step('storyboard', ['script'])])
      await expect(f.service.dispatch(actor, planned.revision, 'storyboard')).rejects.toThrow('CANVAS_ORCHESTRATION_DEPENDENCY_PENDING')
      return { status: 'completed' }
    }
    await f.service.delegate(f.owner, f.request)
    expect(f.calls.some(call => call.includes('storyboard'))).toBe(false)
  })

  test('Given 直接祖先的原始输入已改变 When 分派下游 Then 失效当前分支且不创建或执行Agent也不扣额', async () => {
    /** 测试边界包含一条直接依赖和可变的原始需求节点。 */
    const f = fixture()
    f.document.nodes.push({ id: 'brief-node', kind: 'document', title: '需求', position: { x: 0, y: 0 }, documentId: 'brief-doc', contentRevision: 1 })
    f.dependencies.executeCoordinator = async record => {
      /** 当前协调运行的可信身份。 */
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      /** 先完成并验收直接祖先，形成真实输入与输出版本。 */
      const planned = await f.service.updatePlan(actor, record.revision, [
        { ...step('script'), inputNodeIds: ['brief-node'] }, step('storyboard', ['script']),
      ])
      /** 脚本专业分支完成后的待评审记录。 */
      const delivered = await f.service.dispatch(actor, planned.revision, 'script')
      /** 脚本验收后的稳定记录。 */
      const reviewed = await f.service.reviewStep(actor, delivered.revision, 'script', true, '脚本通过')
      /** 被修改的原始需求节点。 */
      const brief = f.document.nodes.find(node => node.id === 'brief-node')
      if (!brief || brief.kind !== 'document') throw new Error('TEST_BRIEF_MISSING')
      brief.contentRevision += 1
      f.document.revision += 1
      /** 分派前的调用轨迹，用于证明没有创建或执行下游 Agent。 */
      const callsBeforeDispatch = [...f.calls]
      /** 分派前的额度，用于证明拒绝路径不扣费。 */
      const runsBeforeDispatch = reviewed.budget!.agentRunsUsed

      await expect(f.service.dispatch(actor, reviewed.revision, 'storyboard'))
        .rejects.toThrow('CANVAS_ORCHESTRATION_EVIDENCE_STALE')

      expect(f.calls).toEqual(callsBeforeDispatch)
      expect(f.getRecord().budget!.agentRunsUsed).toBe(runsBeforeDispatch)
      expect(f.getRecord().steps.map(item => [item.id, item.status])).toEqual([
        ['script', 'blocked'], ['storyboard', 'planned'],
      ])
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)
  })

  test('Given 多级祖先的原始输入已改变 When 分派末端步骤 Then 从失效根重置分支且不启动末端Agent', async () => {
    /** 测试边界包含三层依赖和最上游原始需求。 */
    const f = fixture()
    f.document.nodes.push({ id: 'brief-node', kind: 'document', title: '需求', position: { x: 0, y: 0 }, documentId: 'brief-doc', contentRevision: 1 })
    f.dependencies.executeCoordinator = async record => {
      /** 当前协调运行的可信身份。 */
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      /** 三层专业计划，末端只直接依赖中间步骤。 */
      const planned = await f.service.updatePlan(actor, record.revision, [
        { ...step('script'), inputNodeIds: ['brief-node'] }, step('storyboard', ['script']), step('editing', ['storyboard']),
      ])
      /** 已交付脚本记录。 */
      const scriptDelivered = await f.service.dispatch(actor, planned.revision, 'script')
      /** 已验收脚本记录。 */
      const scriptReviewed = await f.service.reviewStep(actor, scriptDelivered.revision, 'script', true, '脚本通过')
      /** 已交付分镜记录。 */
      const storyboardDelivered = await f.service.dispatch(actor, scriptReviewed.revision, 'storyboard')
      /** 已验收分镜记录。 */
      const storyboardReviewed = await f.service.reviewStep(actor, storyboardDelivered.revision, 'storyboard', true, '分镜通过')
      /** 被修改的最上游需求节点。 */
      const brief = f.document.nodes.find(node => node.id === 'brief-node')
      if (!brief || brief.kind !== 'document') throw new Error('TEST_BRIEF_MISSING')
      brief.contentRevision += 1
      f.document.revision += 1
      /** 末端分派前的调用轨迹。 */
      const callsBeforeDispatch = [...f.calls]
      /** 末端分派前的 Agent 额度。 */
      const runsBeforeDispatch = storyboardReviewed.budget!.agentRunsUsed

      await expect(f.service.dispatch(actor, storyboardReviewed.revision, 'editing'))
        .rejects.toThrow('CANVAS_ORCHESTRATION_EVIDENCE_STALE')

      expect(f.calls).toEqual(callsBeforeDispatch)
      expect(f.getRecord().budget!.agentRunsUsed).toBe(runsBeforeDispatch)
      expect(f.getRecord().steps.map(item => [item.id, item.status])).toEqual([
        ['script', 'blocked'], ['storyboard', 'planned'], ['editing', 'planned'],
      ])
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)
  })

  test('Given 祖先正式产物已改变 When 分派下游 Then 要求重新评审且不创建或执行下游Agent', async () => {
    /** 测试边界包含一个产物可变的直接祖先。 */
    const f = fixture()
    f.dependencies.executeCoordinator = async record => {
      /** 当前协调运行的可信身份。 */
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      /** 先完成并验收脚本步骤。 */
      const planned = await f.service.updatePlan(actor, record.revision, [step('script'), step('storyboard', ['script'])])
      /** 已交付脚本记录。 */
      const delivered = await f.service.dispatch(actor, planned.revision, 'script')
      /** 已验收脚本记录。 */
      const reviewed = await f.service.reviewStep(actor, delivered.revision, 'script', true, '脚本通过')
      /** 脚本 Agent 节点代表正式产物。 */
      const scriptAgent = f.document.nodes.find(node => node.id === 'expert-script')
      if (!scriptAgent || scriptAgent.kind !== 'agent' || !scriptAgent.outputPointer) throw new Error('TEST_SCRIPT_OUTPUT_MISSING')
      scriptAgent.outputPointer = { ...scriptAgent.outputPointer, contentSha256: 'b'.repeat(64) }
      f.document.revision += 1
      /** 下游分派前的调用轨迹。 */
      const callsBeforeDispatch = [...f.calls]
      /** 下游分派前的 Agent 额度。 */
      const runsBeforeDispatch = reviewed.budget!.agentRunsUsed

      await expect(f.service.dispatch(actor, reviewed.revision, 'storyboard'))
        .rejects.toThrow('CANVAS_ORCHESTRATION_EVIDENCE_STALE')

      expect(f.calls).toEqual(callsBeforeDispatch)
      expect(f.getRecord().budget!.agentRunsUsed).toBe(runsBeforeDispatch)
      expect(f.getRecord().steps.map(item => [item.id, item.status])).toEqual([
        ['script', 'needs-review'], ['storyboard', 'planned'],
      ])
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)
  })

  test('Given 无关分支输入已改变 When 分派当前分支 Then 不阻断当前专业执行', async () => {
    /** 测试边界包含两个互不依赖的根分支。 */
    const f = fixture()
    f.document.nodes.push({ id: 'aside-input', kind: 'document', title: '旁支输入', position: { x: 0, y: 0 }, documentId: 'aside-doc', contentRevision: 1 })
    f.dependencies.executeCoordinator = async record => {
      /** 当前协调运行的可信身份。 */
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      /** 主分支与无关旁支的计划。 */
      const planned = await f.service.updatePlan(actor, record.revision, [
        step('script'), step('storyboard', ['script']), { ...step('aside'), inputNodeIds: ['aside-input'] },
      ])
      /** 主分支祖先的交付记录。 */
      const scriptDelivered = await f.service.dispatch(actor, planned.revision, 'script')
      /** 主分支祖先的验收记录。 */
      const scriptReviewed = await f.service.reviewStep(actor, scriptDelivered.revision, 'script', true, '脚本通过')
      /** 旁支交付记录。 */
      const asideDelivered = await f.service.dispatch(actor, scriptReviewed.revision, 'aside')
      /** 旁支验收记录。 */
      const asideReviewed = await f.service.reviewStep(actor, asideDelivered.revision, 'aside', true, '旁支通过')
      /** 只修改无关旁支的输入。 */
      const asideInput = f.document.nodes.find(node => node.id === 'aside-input')
      if (!asideInput || asideInput.kind !== 'document') throw new Error('TEST_ASIDE_INPUT_MISSING')
      asideInput.contentRevision += 1
      f.document.revision += 1

      /** 当前分支成功分派后的记录。 */
      const result = await f.service.dispatch(actor, asideReviewed.revision, 'storyboard')

      expect(result.steps.find(item => item.id === 'storyboard')?.status).toBe('needs-review')
      expect(result.steps.find(item => item.id === 'aside')?.status).toBe('completed')
      expect(f.calls).toContain('execute:storyboard')
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)
  })

  test('Given 祖先版本异步读取期间计划发生CAS竞争 When 拒绝分派 Then 不覆盖较新的计划记录', async () => {
    /** 测试边界在祖先输入身份读取的异步回调内制造计划竞争。 */
    const f = fixture()
    f.document.nodes.push({ id: 'brief-node', kind: 'document', title: '需求', position: { x: 0, y: 0 }, documentId: 'brief-doc', contentRevision: 1 })
    f.dependencies.executeCoordinator = async record => {
      /** 当前协调运行的可信身份。 */
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      /** 先形成已验收的祖先版本。 */
      const planned = await f.service.updatePlan(actor, record.revision, [
        { ...step('script'), inputNodeIds: ['brief-node'] }, step('storyboard', ['script']),
      ])
      /** 脚本交付记录。 */
      const delivered = await f.service.dispatch(actor, planned.revision, 'script')
      /** 脚本验收记录。 */
      const reviewed = await f.service.reviewStep(actor, delivered.revision, 'script', true, '脚本通过')
      /** 原始身份读取实现，用于只暂停指定节点。 */
      const readNodeIdentity = f.dependencies.readNodeIdentity
      /** 保证竞争记录只写入一次。 */
      let concurrentWritten = false
      f.dependencies.readNodeIdentity = async (target, nodeId) => {
        if (nodeId === 'brief-node' && !concurrentWritten) {
          concurrentWritten = true
          /** 身份读取期间形成的新权威记录。 */
          const concurrent = f.getRecord()
          f.setRecord({ ...concurrent, revision: concurrent.revision + 1, summary: '并发新计划', updatedAt: concurrent.updatedAt + 1 })
        }
        return readNodeIdentity(target, nodeId)
      }

      await expect(f.service.dispatch(actor, reviewed.revision, 'storyboard'))
        .rejects.toThrow('CANVAS_ORCHESTRATION_CONFLICT')
      expect(f.getRecord().summary).toBe('并发新计划')
      expect(f.getRecord().steps[0]?.status).toBe('completed')
      expect(f.calls).not.toContain('create:expert-storyboard')
      expect(f.calls).not.toContain('execute:storyboard')
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)
  })

  test('Given createAgent等待期间祖先输入改变 When Agent创建返回 Then 不扣额也不执行新Agent', async () => {
    /** 测试边界提供可暂停的专业 Agent 创建。 */
    const f = fixture()
    /** 专业 Agent 创建已经开始的通知。 */
    const creationStarted = deferred<void>()
    /** 允许专业 Agent 创建结束的闸门。 */
    const creationRelease = deferred<void>()
    f.document.nodes.push({ id: 'brief-node', kind: 'document', title: '需求', position: { x: 0, y: 0 }, documentId: 'brief-doc', contentRevision: 1 })
    /** 原始 Agent 创建实现，仍保留真实测试节点副作用。 */
    const createAgent = f.dependencies.createAgent
    f.dependencies.createAgent = async (record, currentStep) => {
      if (currentStep?.id === 'storyboard') {
        creationStarted.resolve()
        await creationRelease.promise
      }
      return createAgent(record, currentStep)
    }
    f.dependencies.executeCoordinator = async record => {
      /** 当前协调运行的可信身份。 */
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      /** 先形成已验收的祖先版本。 */
      const planned = await f.service.updatePlan(actor, record.revision, [
        { ...step('script'), inputNodeIds: ['brief-node'] }, step('storyboard', ['script']),
      ])
      /** 脚本交付记录。 */
      const delivered = await f.service.dispatch(actor, planned.revision, 'script')
      /** 脚本验收记录。 */
      const reviewed = await f.service.reviewStep(actor, delivered.revision, 'script', true, '脚本通过')
      /** 正在等待专业 Agent 创建的分派。 */
      const dispatching = f.service.dispatch(actor, reviewed.revision, 'storyboard')
      await creationStarted.promise
      /** 创建窗口内发生变化的祖先输入。 */
      const brief = f.document.nodes.find(node => node.id === 'brief-node')
      if (!brief || brief.kind !== 'document') throw new Error('TEST_BRIEF_MISSING')
      brief.contentRevision += 1
      f.document.revision += 1
      creationRelease.resolve()

      await expect(dispatching).rejects.toThrow('CANVAS_ORCHESTRATION_EVIDENCE_STALE')
      expect(f.calls).toContain('create:expert-storyboard')
      expect(f.calls).not.toContain('execute:storyboard')
      expect(f.getRecord().budget!.agentRunsUsed).toBe(reviewed.budget!.agentRunsUsed)
      expect(f.getRecord().steps.map(item => [item.id, item.status])).toEqual([
        ['script', 'blocked'], ['storyboard', 'planned'],
      ])
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)
  })

  test('Given 模型计划夹带Agent身份 When 更新计划 Then Host忽略身份且等待分派时创建', async () => {
    const f = fixture()
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      const planned = await f.service.updatePlan(actor, record.revision, [{ ...step('interaction'), agentNodeId: record.coordinatorNodeId }])
      expect(planned.steps[0]?.agentNodeId).toBeNull()
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)
  })

  test('Given Host为多个步骤返回同一专业Agent When 分派第二步 Then 拒绝覆盖前一步正式输出', async () => {
    const f = fixture()
    f.dependencies.createAgent = async (record, currentStep) => {
      if (!currentStep) {
        f.document.nodes.push({ id: 'coordinator', kind: 'agent', title: '协调者', position: { x: 0, y: 0 }, agentSessionId: 'session-coordinator' })
        return { projectId: record.projectId, canvasId: record.canvasId, nodeId: 'coordinator' }
      }
      if (!f.document.nodes.some(node => node.id === 'expert-shared')) {
        f.document.nodes.push({ id: 'expert-shared', kind: 'agent', title: '共享专家', position: { x: 0, y: 0 }, agentSessionId: 'session-expert-shared' })
      }
      return { projectId: record.projectId, canvasId: record.canvasId, nodeId: 'expert-shared' }
    }
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      const planned = await f.service.updatePlan(actor, record.revision, [step('script'), step('storyboard')])
      const first = await f.service.dispatch(actor, planned.revision, 'script')
      await expect(f.service.dispatch(actor, first.revision, 'storyboard'))
        .rejects.toThrow('CANVAS_ORCHESTRATION_AGENT_DUPLICATE')
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)
  })

  test('Given 多个步骤声明同一输出节点 When 更新计划 Then 拒绝产生多个写入者', async () => {
    const f = fixture()
    f.document.nodes.push({
      id: 'shared-output', kind: 'document', title: '共享产物', position: { x: 0, y: 0 },
      documentId: 'shared-output-document', contentRevision: 1,
    })
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      await expect(f.service.updatePlan(actor, record.revision, [
        { ...step('script'), outputNodeIds: ['shared-output'] },
        { ...step('storyboard'), outputNodeIds: ['shared-output'] },
      ])).rejects.toThrow('CANVAS_ORCHESTRATION_OUTPUT_DUPLICATE')
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)
  })

  test('Given 模型声称完成但交付合同未通过 When 完成委托 Then 保留未完成状态', async () => {
    const f = fixture()
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      await expect(f.service.finish(actor, 'completed', '已经完成')).rejects.toThrow('CANVAS_ORCHESTRATION_DELIVERY_INCOMPLETE')
      return { status: 'completed' }
    }
    const result = await f.service.delegate(f.owner, f.request)
    expect(result.status).toBe('waiting')
  })

  test('Given 最终合同核验期间上游版本变化 When 完成委托 Then 根步骤失效并重置下游', async () => {
    const f = fixture()
    const deliveryStarted = deferred<void>()
    const deliveryRelease = deferred<boolean>()
    f.document.nodes.push(
      { id: 'brief-node', kind: 'document', title: '需求', position: { x: 0, y: 0 }, documentId: 'brief-doc', contentRevision: 1 },
      { id: 'script-node', kind: 'document', title: '脚本', position: { x: 0, y: 0 }, documentId: 'script-doc', contentRevision: 1 },
      { id: 'storyboard-node', kind: 'document', title: '分镜', position: { x: 0, y: 0 }, documentId: 'storyboard-doc', contentRevision: 1 },
    )
    f.dependencies.verifyDelivery = async () => {
      deliveryStarted.resolve()
      return deliveryRelease.promise
    }
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      const planned = await f.service.updatePlan(actor, record.revision, [
        { ...step('script'), inputNodeIds: ['brief-node'], outputNodeIds: ['script-node'] },
        { ...step('storyboard', ['script']), outputNodeIds: ['storyboard-node'] },
      ])
      const [briefIdentity, scriptIdentity, storyboardIdentity] = await Promise.all([
        f.dependencies.readNodeIdentity(planned, 'brief-node'),
        f.dependencies.readNodeIdentity(planned, 'script-node'),
        f.dependencies.readNodeIdentity(planned, 'storyboard-node'),
      ])
      f.setRecord({
        ...planned,
        revision: planned.revision + 1,
        steps: [
          { ...planned.steps[0]!, status: 'completed', inputVersions: [{ nodeId: 'brief-node', identity: briefIdentity }],
            outputVersions: [{ nodeId: 'script-node', identity: scriptIdentity }] },
          { ...planned.steps[1]!, status: 'completed', inputVersions: [{ nodeId: 'script-node', identity: scriptIdentity }],
            outputVersions: [{ nodeId: 'storyboard-node', identity: storyboardIdentity }] },
        ],
        updatedAt: planned.updatedAt + 1,
      })

      const finishing = f.service.finish(actor, 'completed', '已经完成')
      await deliveryStarted.promise
      const brief = f.document.nodes.find(node => node.id === 'brief-node')
      if (!brief || brief.kind !== 'document') throw new Error('TEST_BRIEF_MISSING')
      brief.contentRevision += 1
      f.document.revision += 1
      deliveryRelease.resolve(true)

      await expect(finishing).rejects.toThrow('CANVAS_ORCHESTRATION_EVIDENCE_STALE')
      expect(f.getRecord().steps.map(item => [item.id, item.status])).toEqual([
        ['script', 'blocked'], ['storyboard', 'planned'],
      ])
      return { status: 'completed' }
    }

    const result = await f.service.delegate(f.owner, f.request)
    expect(result.status).toBe('waiting')
  })

  test('Given 专业运行尚未返回 When 用户取消后旧结果到达 Then 保持取消且不登记迟到结果', async () => {
    const f = fixture()
    const specialist = deferred<{ status: 'completed' }>()
    const started = deferred<void>()
    let dispatchResult: Promise<CanvasOrchestrationRecord> | undefined
    f.dependencies.executeSpecialist = async () => {
      started.resolve()
      return specialist.promise
    }
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      const planned = await f.service.updatePlan(actor, record.revision, [step('interaction')])
      dispatchResult = f.service.dispatch(actor, planned.revision, 'interaction')
      await started.promise
      return { status: 'completed' }
    }

    const delegation = f.service.delegate(f.owner, f.request)
    await started.promise
    const cancelled = f.service.cancel(f.owner, f.getRecord().id)
    specialist.resolve({ status: 'completed' })

    expect((await dispatchResult!).status).toBe('cancelled')
    expect((await delegation).status).toBe('cancelled')
    expect(f.service.get(f.owner)?.revision).toBe(cancelled.revision)
  })

  test('Given 重启前专业步骤仍running且已有正式输出 When 同身份恢复 Then 先登记为待评审且不盲重跑', async () => {
    const f = fixture()
    const initial = await f.service.delegate(f.owner, f.request)
    f.document.nodes.push({
      id: 'expert-interaction', kind: 'agent', title: '专家', position: { x: 0, y: 0 },
      agentSessionId: 'session-expert-interaction',
      outputPointer: { messageUuid: 'recovered-output', contentSha256: 'b'.repeat(64), completedAt: 200 },
    })
    f.setRecord({
      ...initial,
      revision: initial.revision + 1,
      status: 'running',
      steps: [{ ...step('interaction'), agentNodeId: 'expert-interaction', status: 'running', attempts: 1, inputVersions: [],
        execution: { startedAt: initial.updatedAt, userMessageUuid: 'recovered-specialist-anchor' } }],
      updatedAt: initial.updatedAt + 1,
    })
    let recoveredStep: CanvasOrchestrationStep | undefined
    f.dependencies.executeCoordinator = async record => {
      recoveredStep = record.steps[0]
      return { status: 'completed' }
    }

    await f.service.resume(f.owner, initial.id)

    expect(recoveredStep?.status).toBe('needs-review')
    expect(recoveredStep?.outputNodeIds).toContain('expert-interaction')
    expect(f.calls.filter(call => call === 'execute:interaction')).toHaveLength(0)
  })

  test('Given 重启前专业步骤仍running且没有可信输出 When 启动恢复 Then 标记受阻且不启动任何模型', async () => {
    const f = fixture()
    const initial = await f.service.delegate(f.owner, f.request)
    f.document.nodes.push({
      id: 'expert-interaction', kind: 'agent', title: '专家', position: { x: 0, y: 0 },
      agentSessionId: 'session-expert-interaction',
    })
    f.setRecord({
      ...initial,
      revision: initial.revision + 1,
      status: 'running',
      steps: [{ ...step('interaction'), agentNodeId: 'expert-interaction', status: 'running', attempts: 1, inputVersions: [],
        execution: { startedAt: initial.updatedAt, userMessageUuid: 'missing-specialist-anchor' } }],
      updatedAt: initial.updatedAt + 1,
    })
    const callsBeforeRecovery = [...f.calls]

    const recovered = await f.service.recover(f.owner)

    expect(recovered?.status).toBe('blocked')
    expect(recovered?.steps[0]?.status).toBe('blocked')
    expect(f.calls).toEqual(callsBeforeRecovery)
  })

  test('Given Agent后来被手动运行并改变正式指针 When 启动恢复 Then 不把非本次输出登记为步骤产物', async () => {
    const f = fixture()
    const initial = await f.service.delegate(f.owner, f.request)
    f.document.nodes.push({
      id: 'expert-interaction', kind: 'agent', title: '专家', position: { x: 0, y: 0 },
      agentSessionId: 'session-expert-interaction',
      outputPointer: { messageUuid: 'manual-output', contentSha256: 'c'.repeat(64), completedAt: initial.updatedAt + 2 },
    })
    f.setRecord({
      ...initial,
      revision: initial.revision + 1,
      status: 'running',
      steps: [{ ...step('interaction'), agentNodeId: 'expert-interaction', status: 'running', attempts: 1, inputVersions: [],
        execution: { startedAt: initial.updatedAt, userMessageUuid: 'expected-specialist-anchor' } }],
      updatedAt: initial.updatedAt + 3,
    })
    f.dependencies.recoverSpecialist = async () => 'changed'

    const recovered = await f.service.recover(f.owner)

    expect(recovered?.status).toBe('blocked')
    expect(recovered?.steps[0]?.outputNodeIds).not.toContain('expert-interaction')
    expect(recovered?.steps[0]?.note).toContain('不属于本次专业分派')
  })

  test('Given 当前编排仍在进程内运行 When 启动恢复扫描到同一任务 Then 返回原记录且不干扰运行', async () => {
    const f = fixture()
    const coordinatorStarted = deferred<void>()
    const coordinatorFinished = deferred<{ status: 'completed' }>()
    f.dependencies.executeCoordinator = async () => {
      coordinatorStarted.resolve()
      return coordinatorFinished.promise
    }
    const delegation = f.service.delegate(f.owner, f.request)
    await coordinatorStarted.promise
    const running = f.getRecord()

    const recovered = await f.service.recover(f.owner)

    expect(recovered).toEqual(running)
    coordinatorFinished.resolve({ status: 'completed' })
    await delegation
  })

  test('Given 已验收上游产物版本改变 When 恢复对账 Then 上游回到待评审且下游重新规划', async () => {
    const f = fixture()
    const initial = await f.service.delegate(f.owner, f.request)
    f.document.nodes.push(
      { id: 'script-node', kind: 'document', title: '脚本v2', position: { x: 0, y: 0 }, documentId: 'script-doc', contentRevision: 2 },
      { id: 'storyboard-node', kind: 'document', title: '分镜', position: { x: 0, y: 0 }, documentId: 'storyboard-doc', contentRevision: 1 },
    )
    f.setRecord({
      ...initial,
      revision: initial.revision + 1,
      status: 'waiting',
      steps: [
        { ...step('script'), inputVersions: [], outputNodeIds: ['script-node'], outputVersions: [{ nodeId: 'script-node', identity: 'old-script' }], status: 'completed' },
        { ...step('storyboard', ['script']), inputNodeIds: ['script-node'], inputVersions: [{ nodeId: 'script-node', identity: 'old-script' }],
          outputNodeIds: ['storyboard-node'], outputVersions: [{ nodeId: 'storyboard-node', identity: 'old-board' }], status: 'completed' },
      ],
      updatedAt: initial.updatedAt + 1,
    })
    let reconciled: CanvasOrchestrationRecord | undefined
    f.dependencies.executeCoordinator = async record => { reconciled = record; return { status: 'completed' } }

    await f.service.resume(f.owner, initial.id)

    expect(reconciled?.steps.map(item => [item.id, item.status])).toEqual([
      ['script', 'needs-review'], ['storyboard', 'planned'],
    ])
    expect(reconciled?.steps[1]?.outputVersions).toBeUndefined()
  })

  test('Given 旧记录缺少预算 When 恢复 Then 按原intent补默认预算且不重置后续消耗', async () => {
    const f = fixture()
    const initial = await f.service.delegate(f.owner, f.request)
    const { budget: _budget, ...legacy } = initial
    f.setRecord({ ...legacy, revision: initial.revision + 1, status: 'waiting', updatedAt: initial.updatedAt + 1 })

    const recovered = await f.service.resume(f.owner, initial.id)

    expect(recovered.budget).toMatchObject({ maxAgentRuns: 32, maxMediaRuns: 0 })
    expect(recovered.budget!.agentRunsUsed).toBeGreaterThan(0)
  })

  test('Given 当前专业分支创建可信文档 When 自动登记输出 Then 校验child时间而非coordinator时间并保存版本', async () => {
    const f = fixture()
    let registered: CanvasOrchestrationRecord | undefined
    f.dependencies.executeSpecialist = async (_record, _step, _signal, access) => {
      f.document.nodes.push({
        id: 'review-report', kind: 'document', title: '评审报告', position: { x: 0, y: 0 },
        documentId: 'review-report-doc', contentRevision: 1,
      })
      expect(access.startedAt).not.toBe(f.getRecord().runStartedAt)
      expect(access.userMessageUuid).toBe(f.getRecord().steps[0]!.execution!.userMessageUuid)
      expect(access.userMessageUuid).toMatch(/^[a-f0-9]{64}$/)
      expect(f.service.assertBranch(access).step.id).toBe('review')
      registered = await f.service.registerOutput(access, 'review-report', 'tool-create-report')
      return { status: 'completed' }
    }
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      const planned = await f.service.updatePlan(actor, record.revision, [step('review')])
      await f.service.dispatch(actor, planned.revision, 'review')
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)

    expect(registered?.steps[0]?.outputNodeIds).toContain('review-report')
    expect(f.ownedOutputs).toEqual(['review-report'])
  })

  test('Given 输出归属校验期间计划发生CAS竞争 When 自动登记 Then 不覆盖较新的计划', async () => {
    const f = fixture()
    const ownershipStarted = deferred<void>()
    const ownershipRelease = deferred<void>()
    let registration: Promise<CanvasOrchestrationRecord> | undefined
    f.dependencies.assertOutputOwnership = async () => {
      ownershipStarted.resolve()
      await ownershipRelease.promise
    }
    f.dependencies.executeSpecialist = async (_record, _step, _signal, access) => {
      f.document.nodes.push({
        id: 'concurrent-output', kind: 'document', title: '并发产物', position: { x: 0, y: 0 },
        documentId: 'concurrent-doc', contentRevision: 1,
      })
      registration = f.service.registerOutput(access, 'concurrent-output', 'tool-create-concurrent')
      await ownershipStarted.promise
      const current = f.getRecord()
      f.setRecord({ ...current, revision: current.revision + 1, summary: '并发更新', updatedAt: current.updatedAt + 1 })
      ownershipRelease.resolve()
      await expect(registration).rejects.toThrow('CANVAS_ORCHESTRATION_CONFLICT')
      return { status: 'cancelled' }
    }
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      const planned = await f.service.updatePlan(actor, record.revision, [step('concurrent')])
      await f.service.dispatch(actor, planned.revision, 'concurrent')
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)

    expect(f.getRecord().summary).toBe('并发更新')
    expect(f.getRecord().steps[0]?.outputNodeIds).not.toContain('concurrent-output')
  })

  test('Given review委托 When 专业分支登记媒体或原参考节点 Then 拒绝越过只读评审边界', async () => {
    const f = fixture()
    f.request.intent = 'review'
    f.document.nodes.push(
      { id: 'reference-doc', kind: 'document', title: '原稿', position: { x: 0, y: 0 }, documentId: 'reference-doc', contentRevision: 1 },
      { id: 'new-video', kind: 'video', title: '视频', position: { x: 0, y: 0 }, mediaModuleId: 'video-module' },
    )
    f.request.referenceNodeIds = ['reference-doc']
    f.dependencies.executeSpecialist = async (_record, _step, _signal, access) => {
      await expect(f.service.registerOutput(access, 'reference-doc', 'tool-update-reference')).rejects.toThrow('CANVAS_ORCHESTRATION_REVIEW_WRITE_DENIED')
      await expect(f.service.registerOutput(access, 'new-video', 'tool-create-video')).rejects.toThrow('CANVAS_ORCHESTRATION_REVIEW_WRITE_DENIED')
      return { status: 'cancelled' }
    }
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      const planned = await f.service.updatePlan(actor, record.revision, [step('review')])
      await f.service.dispatch(actor, planned.revision, 'review')
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)
  })

  test('Given 同一媒体预留operation重放 When 再次预留 Then 不重复扣额且冲突count被拒绝', async () => {
    const f = fixture()
    f.request.intent = 'produce'
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      const first = f.service.reserveMedia(actor, 2, 'media-operation-1')
      const replay = f.service.reserveMedia(actor, 2, 'media-operation-1')
      expect(replay.revision).toBe(first.revision)
      expect(replay.budget?.mediaRunsUsed).toBe(2)
      await expect(Promise.resolve().then(() => f.service.reserveMedia(actor, 3, 'media-operation-1')))
        .rejects.toThrow('CANVAS_ORCHESTRATION_MEDIA_RESERVATION_CONFLICT')
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)
  })

  test('Given 评审前上游产物版本变化 When 提交评审 Then 持久标记根步骤并重置下游', async () => {
    const f = fixture()
    f.document.nodes.push(
      { id: 'script-node', kind: 'document', title: '脚本v2', position: { x: 0, y: 0 }, documentId: 'script-doc', contentRevision: 2 },
      { id: 'storyboard-node', kind: 'document', title: '分镜', position: { x: 0, y: 0 }, documentId: 'storyboard-doc', contentRevision: 1 },
    )
    f.dependencies.executeCoordinator = async record => {
      const actor = { ...f.owner, sessionId: record.coordinatorSessionId!, orchestrationId: record.id, runStartedAt: record.runStartedAt! }
      const planned = await f.service.updatePlan(actor, record.revision, [
        { ...step('script'), outputNodeIds: ['script-node'] },
        { ...step('storyboard', ['script']), inputNodeIds: ['script-node'], outputNodeIds: ['storyboard-node'] },
      ])
      f.setRecord({
        ...planned,
        revision: planned.revision + 1,
        steps: [
          { ...planned.steps[0]!, status: 'needs-review', outputVersions: [{ nodeId: 'script-node', identity: 'old-script' }] },
          { ...planned.steps[1]!, status: 'completed', inputVersions: [{ nodeId: 'script-node', identity: 'old-script' }],
            outputVersions: [{ nodeId: 'storyboard-node', identity: 'old-board' }] },
        ],
        updatedAt: planned.updatedAt + 1,
      })
      await expect(f.service.reviewStep(actor, f.getRecord().revision, 'script', true, '通过'))
        .rejects.toThrow('CANVAS_ORCHESTRATION_EVIDENCE_STALE')
      expect(f.getRecord().steps.map(item => [item.id, item.status])).toEqual([
        ['script', 'needs-review'], ['storyboard', 'planned'],
      ])
      return { status: 'completed' }
    }

    await f.service.delegate(f.owner, f.request)
  })
})
