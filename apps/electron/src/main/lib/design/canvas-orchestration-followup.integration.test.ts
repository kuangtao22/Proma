import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { SDKMessage } from '@proma/shared'
import type { CanvasAgentExecutionRequest } from './canvas-agent-execution-service'
import { createCanvasOrchestrationRuntime } from './canvas-orchestration-runtime'
import type { CanvasOrchestrationRuntimeDependencies } from './canvas-orchestration-runtime'
import { createCanvasOrchestrationStore } from './canvas-orchestration-store'
import { createCanvasOrchestrationTools } from './canvas-orchestration-tools'
import type { CanvasTaskEvidenceDependencies } from './canvas-task-evidence'
import type { CanvasPaths } from './design-paths'

/** 故障点均发生在真实原子提交之后，模拟提交成功但调用方丢失回执。 */
type CommitFault = 'pending' | 'started' | 'delivered'

/** 组装真实工具、runtime 和磁盘 Store；仅模型执行与画布图存取为隔离替身。 */
function createFollowUpFixture() {
  /** 所有持久化均写独立临时目录，不读取业务工作区或会话。 */
  const directory = mkdtempSync(join(tmpdir(), 'proma-followup-integration-'))
  const target = { projectId: 'project-followup', canvasId: 'canvas-followup' }
  const owner = { ...target, sessionId: 'owner-session' }
  const document = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
  const messages: SDKMessage[] = []
  const executions: CanvasAgentExecutionRequest[] = []
  const store = createCanvasOrchestrationStore({
    pathResolver: { resolveCanvas: () => ({ canvasRoot: directory } as CanvasPaths) },
    runWorkspaceWrite: (_projectId, effect) => effect(),
  })
  /** 本轮仅注入一次故障；重新创建 runtime 时仍复用真实磁盘记录。 */
  let fault: CommitFault | undefined
  let finishBlocked = false
  /** 正式输出提交后丢失执行回执，恢复必须使用原消息与指针。 */
  let loseExecutionReceipt = false
  /** 执行服务明确报告失败，与没有回执的未知运行分别测试。 */
  let failExecution = false
  /** 重启后仍可由权威运行服务识别忙状态，不能仅依赖新实例的 active map。 */
  let coordinatorBusy = false
  let service: ReturnType<typeof createCanvasOrchestrationRuntime>
  /** 有界的虚拟正式回复使恢复走真实消息锚点与输出指针校验。 */
  const response = '已收到本轮校正并核对原委托，后续验收尚未完成。'
  const dependencies: CanvasOrchestrationRuntimeDependencies = {
    store: { ...store, save: (input, expectedRevision, record) => {
      const saved = store.save(input, expectedRevision, record)
      if (fault && saved.followUps?.at(-1)?.status === fault) {
        fault = undefined
        throw new Error('TEST_COMMIT_RECEIPT_LOST')
      }
      return saved
    } },
    documents: { load: () => ({ document: structuredClone(document) }) },
    access: {
      authorizeRead: () => undefined,
      requireLinkedCanvas: () => ({ projectId: target.projectId, sessionId: owner.sessionId,
        linkedCanvasIds: [target.canvasId], defaultCanvasId: target.canvasId, lastActiveCanvasId: target.canvasId, updatedAt: 1 }),
      runWrite: (_context, effect) => effect(),
    },
    artifacts: {
      resolveCreated: () => null,
      createAgent: async () => {
        document.nodes.push({ id: 'coordinator-node', kind: 'agent', title: '画布编排',
          position: { x: 0, y: 0 }, agentSessionId: 'coordinator-session' })
        document.revision += 1
        return { ...target, nodeId: 'coordinator-node', revision: document.revision, sourceToolCallId: 'create-coordinator' }
      },
    },
    evidence: { agentOutputs: { readAtPointer: async () => response } } as unknown as CanvasTaskEvidenceDependencies,
    getAgentMessages: () => structuredClone(messages),
    isAgentBusy: () => coordinatorBusy,
    execution: { execute: async (request) => {
      if (request.mode !== 'canvas-orchestrator') throw new Error('TEST_UNEXPECTED_SPECIALIST')
      executions.push(request)
      if (failExecution) {
        failExecution = false
        return { status: 'errored' }
      }
      /** 记录生产执行服务通常提交的锚点、完整回复与正式输出身份。 */
      const replyId = randomUUID()
      messages.push(
        { type: 'user', uuid: request.userMessageUuid, message: { role: 'user', content: [{ type: 'text', text: request.instruction }] } } as unknown as SDKMessage,
        { type: 'assistant', uuid: replyId, message: { role: 'assistant', content: [{ type: 'text', text: response }] } } as unknown as SDKMessage,
      )
      const node = document.nodes.find((candidate) => candidate.id === request.target.nodeId)
      if (node?.kind !== 'agent') throw new Error('TEST_COORDINATOR_MISSING')
      node.outputPointer = { messageUuid: replyId, completedAt: request.startedAt + 1,
        contentSha256: createHash('sha256').update(response).digest('hex') }
      if (loseExecutionReceipt) {
        loseExecutionReceipt = false
        throw new Error('TEST_EXECUTION_RECEIPT_LOST')
      }
      if (finishBlocked) await service.finish({ ...target, sessionId: node.agentSessionId,
        orchestrationId: request.orchestrationId, runStartedAt: request.startedAt }, 'blocked', '校正已收到，仍待后续验收。')
      return { status: 'completed' }
    } },
    createRun: () => undefined,
    onChanged: () => undefined,
  }
  service = createCanvasOrchestrationRuntime(dependencies)
  /** 每次构造工具都使用当前 runtime，模拟主进程重启后重新注册 Provider。 */
  const invoke = async (name: string, input: unknown) => {
    const tools = createCanvasOrchestrationTools({ service, access: dependencies.access }, {
      projectId: target.projectId, sessionId: owner.sessionId, runStartedAt: 9, explicitReferences: [], permissionCeiling: 'execute',
    })
    const tool = tools.find((candidate) => candidate.name === name)
    if (!tool) throw new Error(`TEST_TOOL_MISSING:${name}`)
    return tool.execute('followup-call', input as never, undefined as never, undefined as never, undefined as never)
  }
  return {
    target, store, executions, invoke,
    /** 新实例丢弃进程内 active map，持久数据和权威消息保留。 */
    restart: () => { service = createCanvasOrchestrationRuntime(dependencies) },
    failAfterCommit: (status: CommitFault) => { fault = status },
    finishBlocked: () => { finishBlocked = true },
    loseExecutionReceipt: () => { loseExecutionReceipt = true },
    failExecution: () => { failExecution = true },
    setCoordinatorBusy: (busy: boolean) => { coordinatorBusy = busy },
    /** 创建普通会话的原始不可变委托；全部通过真实工具入口。 */
    delegate: async () => {
      await invoke('canvas_delegate', { canvasId: target.canvasId, request: {
        requestId: 'original-request', goal: '完成专业制作方案', intent: 'design', constraints: ['保留原资产'], referenceNodeIds: [],
        deliverables: [{ id: 'design', title: '制作方案', kind: 'document', criteria: ['正文可复读'] }],
      } })
      return store.get(target)!
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}

describe('普通会话校正到原画布编排的真实持久链路', () => {
  test('Given 原编排仍有业务阻塞 When 普通工具提交校正 Then 原coordinator收到原文且重放不会重复运行', async () => {
    const fixture = createFollowUpFixture()
    try {
      const original = await fixture.delegate()
      fixture.finishBlocked()
      const input = { canvasId: fixture.target.canvasId, orchestrationId: original.id,
        followUp: { id: 'correct-mapping', expectedRevision: original.revision, instruction: '重新读取两份正文，将制作方案归首阶段，验收记录只归终审。' } }
      await fixture.invoke('canvas_resume_orchestration', input)
      const corrected = fixture.store.get(fixture.target)!
      const execution = fixture.executions.at(-1)!
      expect(execution.mode).toBe('canvas-orchestrator')
      if (execution.mode !== 'canvas-orchestrator') throw new Error('TEST_MODE_MISMATCH')
      expect(execution.instruction).toContain(input.followUp.instruction)
      expect(execution.target.nodeId).toBe(original.coordinatorNodeId!)
      expect(execution.parentSessionId).toBe(original.ownerSessionId)
      expect(corrected.request).toEqual(original.request)
      expect(corrected.coordinatorSessionId).toBe(original.coordinatorSessionId)
      expect(corrected.budget).toEqual({ ...original.budget!, agentRunsUsed: original.budget!.agentRunsUsed + 1 })
      expect(corrected.status).toBe('blocked')
      expect(corrected.followUps?.at(-1)?.status).toBe('delivered')
      fixture.restart()
      await fixture.invoke('canvas_resume_orchestration', input)
      expect(fixture.executions).toHaveLength(2)
      expect(fixture.store.get(fixture.target)).toEqual(corrected)
      await expect(fixture.invoke('canvas_delegate', { canvasId: fixture.target.canvasId,
        request: { ...original.request, goal: input.followUp.instruction } })).rejects.toThrow('CANVAS_ORCHESTRATION_REQUEST_CONFLICT')
    } finally { fixture.cleanup() }
  })

  /** 三个提交空窗分别验证：待发可续、已启动先对账、已送达不重跑。 */
  for (const fault of ['pending', 'started', 'delivered'] as const) {
    test(`Given ${fault} 提交成功但回执丢失 When 重建服务后精确重放 Then 不丢指令也不重复扣额`, async () => {
      const fixture = createFollowUpFixture()
      try {
        const original = await fixture.delegate()
        const input = { canvasId: fixture.target.canvasId, orchestrationId: original.id,
          followUp: { id: 'durable-correction', expectedRevision: original.revision, instruction: '保留原计划，复读正文后局部校正。' } }
        fixture.failAfterCommit(fault)
        await expect(fixture.invoke('canvas_resume_orchestration', input)).rejects.toThrow('CANVAS_ORCHESTRATION_FAILED')
        const committed = fixture.store.get(fixture.target)!
        expect(committed.followUps).toHaveLength(1)
        expect(committed.followUps![0]!.instruction).toBe(input.followUp.instruction)
        fixture.restart()
        await fixture.invoke('canvas_resume_orchestration', input)
        const recovered = fixture.store.get(fixture.target)!
        expect(recovered.request).toEqual(original.request)
        expect(recovered.followUps).toHaveLength(1)
        expect(recovered.budget!.agentRunsUsed).toBe(original.budget!.agentRunsUsed + 1)
        expect(recovered.budget!.mediaRunsUsed).toBe(original.budget!.mediaRunsUsed)
        expect(fixture.executions).toHaveLength(fault === 'started' ? 1 : 2)
        expect(recovered.followUps![0]!.status).toBe(fault === 'started' ? 'started' : 'delivered')
        if (fault === 'started') {
          expect(recovered.status).toBe('blocked')
          expect(recovered.followUps![0]!.userMessageUuid).toBe(committed.followUps![0]!.userMessageUuid)
          expect(recovered.followUps![0]!.startedAt).toBe(committed.followUps![0]!.startedAt)
        }
      } finally { fixture.cleanup() }
    })
  }

  test('Given 正式输出已提交但执行回执丢失 When 重建服务后重放校正 Then 核对原pointer收口且不启动第二轮', async () => {
    const fixture = createFollowUpFixture()
    try {
      const original = await fixture.delegate()
      const input = { canvasId: fixture.target.canvasId, orchestrationId: original.id,
        followUp: { id: 'recover-output', expectedRevision: original.revision, instruction: '重新检查原制作方案。' } }
      fixture.loseExecutionReceipt()
      await expect(fixture.invoke('canvas_resume_orchestration', input)).rejects.toThrow('CANVAS_ORCHESTRATION_FAILED')
      const interrupted = fixture.store.get(fixture.target)!
      fixture.restart()
      await fixture.invoke('canvas_resume_orchestration', input)
      const recovered = fixture.store.get(fixture.target)!
      expect(recovered.followUps?.at(-1)?.status).toBe('delivered')
      expect(recovered.budget).toEqual(interrupted.budget)
      expect(fixture.executions).toHaveLength(2)
    } finally { fixture.cleanup() }
  })

  test('Given 原校正结果不明 When 明确引用旧校正发起新尝试 Then 保留旧锚点且新尝试只运行一次', async () => {
    const fixture = createFollowUpFixture()
    try {
      const original = await fixture.delegate()
      const input = { canvasId: fixture.target.canvasId, orchestrationId: original.id,
        followUp: { id: 'unknown-attempt', expectedRevision: original.revision, instruction: '复读正文后校正原计划。' } }
      fixture.failAfterCommit('started')
      await expect(fixture.invoke('canvas_resume_orchestration', input)).rejects.toThrow('CANVAS_ORCHESTRATION_FAILED')
      fixture.restart()
      await fixture.invoke('canvas_resume_orchestration', input)
      const unknown = fixture.store.get(fixture.target)!
      const retry = { ...input, followUp: { ...input.followUp, id: 'explicit-new-attempt', expectedRevision: unknown.revision } }
      await expect(fixture.invoke('canvas_resume_orchestration', retry)).rejects.toThrow('CANVAS_ORCHESTRATION_FOLLOW_UP_PENDING')
      expect(fixture.store.get(fixture.target)).toEqual(unknown)
      const explicit = { ...retry, followUp: { ...retry.followUp, supersedesId: input.followUp.id } }
      fixture.setCoordinatorBusy(true)
      await expect(fixture.invoke('canvas_resume_orchestration', explicit)).rejects.toThrow('CANVAS_ORCHESTRATION_ACTIVE')
      expect(fixture.store.get(fixture.target)).toEqual(unknown)
      expect(fixture.executions).toHaveLength(1)
      fixture.setCoordinatorBusy(false)
      await fixture.invoke('canvas_resume_orchestration', explicit)
      const recovered = fixture.store.get(fixture.target)!
      expect(recovered.followUps?.[0]).toEqual({ ...unknown.followUps![0]!, status: 'abandoned' })
      expect(recovered.followUps?.[1]?.status).toBe('delivered')
      expect(recovered.followUps?.[1]?.userMessageUuid).not.toBe(unknown.followUps![0]!.userMessageUuid)
      expect(recovered.budget!.agentRunsUsed).toBe(unknown.budget!.agentRunsUsed + 1)
      fixture.restart()
      await fixture.invoke('canvas_resume_orchestration', explicit)
      await fixture.invoke('canvas_resume_orchestration', input)
      expect(fixture.store.get(fixture.target)).toEqual(recovered)
      expect(fixture.executions).toHaveLength(2)
    } finally { fixture.cleanup() }
  })

  test('Given 执行服务明确失败 When 修复原因后提交新校正 Then 原失败回执幂等且允许有界重试', async () => {
    const fixture = createFollowUpFixture()
    try {
      const original = await fixture.delegate()
      const input = { canvasId: fixture.target.canvasId, orchestrationId: original.id,
        followUp: { id: 'failed-attempt', expectedRevision: original.revision, instruction: '重新核对原有文档。' } }
      fixture.failExecution()
      await fixture.invoke('canvas_resume_orchestration', input)
      const failed = fixture.store.get(fixture.target)!
      expect(failed.followUps?.at(-1)?.status).toBe('failed')
      fixture.restart()
      await fixture.invoke('canvas_resume_orchestration', input)
      expect(fixture.store.get(fixture.target)).toEqual(failed)
      expect(fixture.executions).toHaveLength(2)
      await expect(fixture.invoke('canvas_resume_orchestration', {
        canvasId: fixture.target.canvasId, orchestrationId: original.id,
      })).rejects.toThrow('CANVAS_ORCHESTRATION_FOLLOW_UP_RETRY_REQUIRED')
      expect(fixture.store.get(fixture.target)).toEqual(failed)
      expect(fixture.executions).toHaveLength(2)
      await fixture.invoke('canvas_resume_orchestration', { ...input,
        followUp: { ...input.followUp, id: 'retry-after-repair', expectedRevision: failed.revision } })
      const resumed = fixture.store.get(fixture.target)!
      expect(resumed.followUps?.[0]).toEqual(failed.followUps![0]!)
      expect(resumed.followUps?.[1]?.status).toBe('delivered')
      expect(resumed.budget!.agentRunsUsed).toBe(failed.budget!.agentRunsUsed + 1)
      expect(fixture.executions).toHaveLength(3)
    } finally { fixture.cleanup() }
  })
})
