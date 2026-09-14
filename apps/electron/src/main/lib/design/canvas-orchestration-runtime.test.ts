import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasOrchestrationRecord, CanvasOrchestrationStep, SDKMessage } from '@proma/shared'
import { createCanvasOrchestrationStore } from './canvas-orchestration-store'
import { canvasOrchestratorContext, createCanvasOrchestrationRuntime, readCanvasOrchestrationNodeIdentity, recoverCanvasOrchestrationSpecialist } from './canvas-orchestration-runtime'
import type { CanvasOrchestrationRuntimeDependencies } from './canvas-orchestration-runtime'
import type { CanvasOrchestrationService } from './canvas-orchestration-service'
import type { CanvasTaskEvidenceDependencies } from './canvas-task-evidence'
import type { CanvasArtifactSourceResult } from './canvas-artifact-creation'
import type { CanvasPaths } from './design-paths'
import { createCanvasTaskStore } from './canvas-task-store'
import { createCanvasToolRun } from './canvas-tool-provider'
import type { CanvasToolProviderDependencies, CanvasToolRun } from './canvas-tool-provider'
import { canvasOrchestrationRequirements } from './canvas-orchestration-contract'

/** 隔离落盘夹具：计划使用真实 Store，模型与内容提供者是可观察边界，不连接用户数据或远端。 */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'proma-orchestration-runtime-'))
  const target = { projectId: 'project', canvasId: 'canvas' }
  const document = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
  const bodies = new Map<string, string>()
  /** SDK 消息由隔离 fixture 提供，不读取用户会话。 */
  const messages: SDKMessage[] = []
  /** 配置版本可独立于正式输出与布局变化。 */
  let configRevision = 1
  const created = new Map<string, CanvasArtifactSourceResult>()
  const calls: string[] = []
  const store = createCanvasOrchestrationStore({ pathResolver: { resolveCanvas: () => ({ canvasRoot: directory } as CanvasPaths) },
    runWorkspaceWrite: (_projectId, effect) => effect() })
  const evidence = {
    agentOutputs: { read: async (input: { nodeId: string }) => bodies.get(input.nodeId) ?? '', readAtPointer: async () => '已核对正文' },
    agentConfigs: { load: async () => ({ revision: configRevision }) },
    textArtifacts: { read: async (input: { nodeId: string }) => ({ content: bodies.get(input.nodeId) ?? '' }) },
  } as unknown as CanvasTaskEvidenceDependencies
  let service: CanvasOrchestrationService
  let coordinate = async (_record: CanvasOrchestrationRecord): Promise<void> => undefined
  const dependencies: CanvasOrchestrationRuntimeDependencies = {
    store, evidence, documents: { load: () => ({ document }) },
    getAgentMessages: () => messages, isAgentBusy: () => false,
    access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({ ...target, sessionId: 'owner', linkedCanvasIds: ['canvas'],
      defaultCanvasId: 'canvas', lastActiveCanvasId: 'canvas', updatedAt: 1 }), runWrite: (_context, effect) => effect() },
    artifacts: {
      resolveCreated: input => created.get(input.source.toolCallId) ?? null,
      createAgent: async input => {
        const nodeId = `agent-${created.size + 1}`
        calls.push(`create:${nodeId}`)
        document.nodes.push({ id: nodeId, kind: 'agent', title: input.title, position: { x: 0, y: 0 }, agentSessionId: `session-${nodeId}` })
        document.revision++
        const result: CanvasArtifactSourceResult = { ...target, nodeId, revision: document.revision, artifactType: 'agent', sourceToolCallId: input.source.toolCallId }
        created.set(input.source.toolCallId, result)
        return result
      },
    },
    execution: { execute: async request => {
      if (request.mode === 'renderer-manual') throw new Error('UNEXPECTED_RENDERER')
      calls.push(`run:${request.mode}`)
      const node = document.nodes.find(node => node.id === request.target.nodeId)
      if (node?.kind !== 'agent') throw new Error('AGENT_MISSING')
      if (request.mode === 'canvas-orchestrator') {
        const record = store.get(target)!
        expect(request.parentSessionId).toBe(record.ownerSessionId)
        expect(request.orchestrationId).toBe(record.id)
        service.assertActor({ ...target, sessionId: node.agentSessionId, orchestrationId: record.id, runStartedAt: request.startedAt })
        await coordinate(record)
      } else {
        const access = { target: request.target, parentSessionId: request.parentSessionId, startedAt: request.startedAt,
          orchestrationId: request.orchestration!.id, stepId: request.orchestration!.stepId, userMessageUuid: request.userMessageUuid }
        service.assertBranch(access)
        expect(request.reviewScope?.mode ?? 'none').toBe(access.stepId === 'first' ? 'none' : 'nodes')
        bodies.set(node.id, request.instruction)
        node.outputPointer = { messageUuid: request.userMessageUuid, completedAt: request.startedAt,
          contentSha256: createHash('sha256').update(request.instruction).digest('hex') }
      }
      return { status: 'completed' }
    } },
    createRun: () => ({ systemPromptAppend: '', piCustomTools: [], allowedToolNames: [], singleApprovalToolNames: [],
      allowedToolNamesMode: 'extend', verifyOrchestrationDelivery: async () => true }),
    onChanged: record => { calls.push(`revision:${record.revision}`) },
  }
  service = createCanvasOrchestrationRuntime(dependencies)
  return { target, directory, document, store, service, dependencies, calls, bodies, messages,
    changeConfig: () => { configRevision++ },
    coordinate: (callback: typeof coordinate) => { coordinate = callback },
    cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

describe('真实编排生产组合边界', () => {
  test.each(['completed', 'missing-contract', 'stale-output', 'criteria-mismatch'] as const)(
    'Given 两步专业设计实际经过工具与持久验收合同 When %s Then 仅完整有效交付可以结束委托', async scenario => {
      /** 复用真实编排 Store；此次验收使用真正 Provider，不再使用固定 true 的替身。 */
      const harness = fixture()
      try {
        const taskStore = createCanvasTaskStore({ pathResolver: { resolveCanvas: () => ({ canvasRoot: harness.directory } as CanvasPaths) },
          runWorkspaceWrite: (_projectId, effect) => effect() })
        /** 本用例只执行内容设计，任何未装配的媒体/变更能力都不应调用。 */
        const unavailable = (): never => { throw new Error('TEST_CAPABILITY_NOT_USED') }
        const access = {
          ...harness.dependencies.access,
          authorizeRead: (context: { projectId: string }) => {
            if (context.projectId !== harness.target.projectId) throw new Error('CANVAS_ACCESS_DENIED')
          },
          requireLinkedCanvas: (context: { projectId: string }, canvasId: string) => {
            if (context.projectId !== harness.target.projectId || canvasId !== harness.target.canvasId) throw new Error('CANVAS_ACCESS_DENIED')
            return harness.dependencies.access.requireLinkedCanvas({ ...harness.target, sessionId: 'owner', runStartedAt: 1,
              permissionCeiling: 'execute', explicitReferences: [] }, canvasId)
          },
          getBinding: () => ({ ...harness.target, sessionId: 'owner', linkedCanvasIds: ['canvas'], defaultCanvasId: 'canvas', lastActiveCanvasId: 'canvas', updatedAt: 1 }),
          createAndLink: unavailable, link: unavailable, unlink: unavailable, setDefault: unavailable,
        }
        /** Adapter 返回受控正式正文，签发证据、复验、合同落盘与最终门禁仍走生产代码。 */
        const providerDependencies = {
          taskStore, orchestration: harness.service, access,
          documents: { load: () => ({ document: harness.document, nodeIssues: [] }), validateBatchOperations: unavailable },
          agentOutputs: { read: async (target: { nodeId: string }) => harness.bodies.get(target.nodeId) ?? '',
            readAtPointer: async (target: { nodeId: string }) => harness.bodies.get(target.nodeId) ?? '' },
          agentConfigs: { load: async () => ({ revision: 1, instruction: '', skillNames: [], channelId: null, modelId: null }), update: unavailable },
          agentExecution: harness.dependencies.execution,
          workflowExecution: { execute: unavailable, resume: unavailable, cancel: unavailable, get: unavailable, list: unavailable, registerCreatedSuccessor: unavailable },
          artifacts: { ...harness.dependencies.artifacts, create: unavailable },
          importImage: unavailable,
          textArtifacts: { read: unavailable, listVersions: unavailable, update: unavailable },
          images: {}, canvasMedia: {}, imageRuns: {}, batch: { execute: unavailable },
        } as unknown as CanvasToolProviderDependencies
        harness.dependencies.createRun = context => createCanvasToolRun(providerDependencies, context)
        /** 脚本化模型只选择真实工具和参数，不直接改合同或伪造验收结果。 */
        const invoke = async (run: CanvasToolRun, name: string, params: Record<string, unknown>) => {
          const tool = run.piCustomTools.find(candidate => candidate.name === name)
          if (!tool) throw new Error(`TEST_TOOL_MISSING:${name}`)
          return tool.execute(`tool-${name}`, params, new AbortController().signal, undefined, {} as never)
        }
        harness.coordinate(async record => {
          const run = harness.dependencies.createRun(canvasOrchestratorContext(record))!
          await invoke(run, 'canvas_task', { action: 'start', canvasId: record.canvasId, requirements: canvasOrchestrationRequirements(record) })
          const criteria = scenario === 'criteria-mismatch' ? ['其它条件'] : ['有可核对产物']
          await invoke(run, 'canvas_update_plan', { expectedRevision: harness.store.get(harness.target)!.revision,
            steps: ['first', 'second'].map((id, index) => ({ id, title: index ? '镜头设计' : '脚本设计', role: index ? '分镜师' : '编剧',
              instruction: '交付可复读的正式设计', dependsOn: index ? ['first'] : [], inputNodeIds: [], outputNodeIds: [], agentNodeId: null, criteria })) })
          for (const stepId of ['first', 'second']) {
            await invoke(run, 'canvas_dispatch', { expectedRevision: harness.store.get(harness.target)!.revision, stepId })
            await invoke(run, 'canvas_review_step', { expectedRevision: harness.store.get(harness.target)!.revision, stepId, passed: true, note: '已读取并核对设计' })
          }
          const current = harness.store.get(harness.target)!
          const outputNodeId = current.steps[1]!.agentNodeId!
          const read = await invoke(run, 'canvas_read', { canvasId: record.canvasId, nodeIds: [outputNodeId] })
          const details = read.details as { nodes: Array<{ evidence: Array<{ validation: string; evidenceId: string }> }> }
          const evidence = details.nodes[0]!.evidence.find(proof => proof.validation === 'content')!
          expect(evidence).toBeDefined()
          if (scenario !== 'missing-contract') {
            await invoke(run, 'canvas_task', { action: 'complete', submissions: [{ id: 'deliverable-1', evidenceId: evidence.evidenceId }] })
            expect(taskStore.getActive({ ...harness.target, sessionId: current.coordinatorSessionId! })?.state.phase).toBe('completed')
          }
          if (scenario === 'stale-output') harness.bodies.set(outputNodeId, '验收后发生变化的设计')
          if (scenario === 'completed') {
            await invoke(run, 'canvas_finish_orchestration', { status: 'completed', summary: '设计已完成' })
          } else {
            await expect(invoke(run, 'canvas_finish_orchestration', { status: 'completed', summary: '请求结束' }))
              .rejects.toThrow(scenario === 'stale-output' ? 'CANVAS_ORCHESTRATION_EVIDENCE_STALE' : 'CANVAS_ORCHESTRATION_DELIVERY_INCOMPLETE')
          }
        })
        const result = await harness.service.delegate({ ...harness.target, sessionId: 'owner' }, {
          requestId: 'real-contract-flow', goal: '完成脚本与镜头设计', intent: 'design', constraints: [], referenceNodeIds: [],
          deliverables: [{ id: 'design', title: '正式设计', kind: 'agent', criteria: ['有可核对产物'] }],
        })
        expect(result.status).toBe(scenario === 'completed' ? 'completed' : 'waiting')
      } finally { harness.cleanup() }
    },
  )
  test('Given 已评审设计 When 输入关系改变或仅新增下游消费者 Then 输入变化失效而下游扩展不失效', async () => {
    const harness = fixture()
    try {
      harness.document.nodes.push(...['reference', 'design', 'consumer'].map(id => ({ id, kind: 'document' as const,
        title: id, documentId: `content-${id}`, contentRevision: 1, position: { x: 0, y: 0 } })))
      harness.bodies.set('design', '专业设计')
      const initial = await readCanvasOrchestrationNodeIdentity(harness.dependencies, harness.target, 'design')
      harness.document.edges.push({ id: 'outgoing', sourceNodeId: 'design', targetNodeId: 'consumer',
        sourcePort: 'document.markdown', targetPort: 'context.text', relation: 'derives' })
      expect(await readCanvasOrchestrationNodeIdentity(harness.dependencies, harness.target, 'design')).toBe(initial)
      harness.document.edges.push({ id: 'incoming', sourceNodeId: 'reference', targetNodeId: 'design',
        sourcePort: 'document.markdown', targetPort: 'context.text', relation: 'reference' })
      const related = await readCanvasOrchestrationNodeIdentity(harness.dependencies, harness.target, 'design')
      expect(related).not.toBe(initial)
      harness.document.edges.reverse()
      expect(await readCanvasOrchestrationNodeIdentity(harness.dependencies, harness.target, 'design')).toBe(related)
      harness.document.edges.find(edge => edge.id === 'incoming')!.relation = 'depends-on'
      expect(await readCanvasOrchestrationNodeIdentity(harness.dependencies, harness.target, 'design')).not.toBe(related)
    } finally { harness.cleanup() }
  })

  test('Given 专业正式输出不变 When 职责配置改变 Then 原验收版本失效', async () => {
    const harness = fixture()
    try {
      harness.document.nodes.push({ id: 'agent', kind: 'agent', title: '导演', agentSessionId: 'session', position: { x: 0, y: 0 },
        outputPointer: { messageUuid: 'output', completedAt: 10, contentSha256: 'hash' } })
      harness.bodies.set('agent', '正式导演方案')
      const identity = await readCanvasOrchestrationNodeIdentity(harness.dependencies, harness.target, 'agent')
      harness.changeConfig()
      expect(await readCanvasOrchestrationNodeIdentity(harness.dependencies, harness.target, 'agent')).not.toBe(identity)
    } finally { harness.cleanup() }
  })

  test('Given 持久专业执行锚点 When 后续手动输出覆盖 Then 生产恢复拒绝错误归属', async () => {
    const harness = fixture()
    try {
      const anchor = 'original-run'
      const outputId = '123e4567-e89b-42d3-a456-426614174001'
      const laterId = '123e4567-e89b-42d3-a456-426614174002'
      harness.messages.push(...[
        { type: 'user', uuid: anchor, message: { content: [{ type: 'text', text: '原分派' }] } },
        { type: 'assistant', uuid: outputId, message: { content: [{ type: 'text', text: '原设计' }], stop_reason: 'end_turn' } },
        { type: 'user', uuid: 'manual-run', message: { content: [{ type: 'text', text: '手动请求' }] } },
        { type: 'assistant', uuid: laterId, message: { content: [{ type: 'text', text: '新设计' }], stop_reason: 'end_turn' } },
      ] as unknown as SDKMessage[])
      const node = { id: 'agent', kind: 'agent' as const, title: '专业', agentSessionId: 'session', position: { x: 0, y: 0 },
        outputPointer: { messageUuid: outputId, completedAt: 20, contentSha256: createHash('sha256').update('原设计').digest('hex') } }
      harness.document.nodes.push(node)
      const step = { agentNodeId: node.id, execution: { startedAt: 10, userMessageUuid: anchor } }
      expect(await recoverCanvasOrchestrationSpecialist(harness.dependencies, harness.target, step)).toBe('completed')
      node.outputPointer = { messageUuid: laterId, completedAt: 30, contentSha256: createHash('sha256').update('新设计').digest('hex') }
      expect(await recoverCanvasOrchestrationSpecialist(harness.dependencies, harness.target, step)).toBe('changed')
      /** 正文读取期间出现后续正式提交也不能在恢复结束后被认领。 */
      const laterPointer = node.outputPointer
      node.outputPointer = { messageUuid: outputId, completedAt: 20, contentSha256: createHash('sha256').update('原设计').digest('hex') }
      harness.dependencies.evidence.agentOutputs.readAtPointer = async () => {
        node.outputPointer = laterPointer
        return '原设计'
      }
      expect(await recoverCanvasOrchestrationSpecialist(harness.dependencies, harness.target, step)).toBe('changed')
    } finally { harness.cleanup() }
  })
  test.each([['视频', '编剧', '镜头设计'], ['UI', '信息架构', '交互设计']] as const)(
    'Given %s 跨专业任务 When 分派依赖与评审 Then 真实阶段顺序和来源落盘且重放不重跑', async (_domain, firstRole, secondRole) => {
      const harness = fixture()
      try {
        harness.coordinate(async record => {
          const context = canvasOrchestratorContext(record)
          const actor = { ...harness.target, sessionId: context.sessionId, orchestrationId: record.id, runStartedAt: context.runStartedAt }
          const steps: CanvasOrchestrationStep[] = [firstRole, secondRole].map((role, index) => ({ id: index ? 'second' : 'first',
            title: role, role, instruction: `交付${role}的完整设计`, dependsOn: index ? ['first'] : [],
            inputNodeIds: [], outputNodeIds: [], agentNodeId: null, criteria: ['有可核对产物'], status: 'planned', note: '' }))
          let current = await harness.service.updatePlan(actor, record.revision, steps)
          await expect(harness.service.dispatch(actor, current.revision, 'second')).rejects.toThrow('CANVAS_ORCHESTRATION_DEPENDENCY_PENDING')
          current = await harness.service.dispatch(actor, current.revision, 'first')
          expect(current.steps[0]!.status).toBe('needs-review')
          current = await harness.service.reviewStep(actor, current.revision, 'first', true, '已读正式设计')
          current = await harness.service.dispatch(actor, current.revision, 'second')
          expect(current.steps[1]!.inputVersions?.map(version => version.nodeId)).toEqual(current.steps[0]!.outputNodeIds)
          current = await harness.service.reviewStep(actor, current.revision, 'second', true, '已检查输入一致性')
          await harness.service.finish(actor, 'completed', '本次专业设计已完成')
        })
        const owner = { ...harness.target, sessionId: 'owner' }
        const request = { requestId: 'request', goal: '专业设计', intent: 'design' as const, constraints: [], referenceNodeIds: [],
          deliverables: [{ id: 'design', kind: 'agent' as const, title: '专业设计', criteria: ['有可核对产物'] }] }
        const result = await harness.service.delegate(owner, request)
        expect(result.status).toBe('completed')
        expect(result.budget?.agentRunsUsed).toBe(3)
        expect(result.budget?.mediaRunsUsed).toBe(0)
        const count = harness.calls.length
        const restarted = createCanvasOrchestrationRuntime(harness.dependencies)
        expect((await restarted.delegate(owner, request)).id).toBe(result.id)
        expect(harness.calls).toHaveLength(count)
        expect(harness.store.get(harness.target)?.steps.every(step => step.outputVersions?.every(version => /^[a-f0-9]{64}$/.test(version.identity)))).toBe(true)
      } finally { harness.cleanup() }
    },
  )

  test('Given 普通会话向原委托提交校正 When 恢复执行 Then coordinator收到校正文且沿用稳定消息身份', async () => {
    const harness = fixture()
    try {
      const owner = { ...harness.target, sessionId: 'owner' }
      const request = { requestId: 'follow-up-flow', goal: '完成专业设计', intent: 'design' as const,
        constraints: ['保留原交付合同'], referenceNodeIds: [],
        deliverables: [{ id: 'design', kind: 'agent' as const, title: '专业设计', criteria: ['有可核对产物'] }] }
      const initial = await harness.service.delegate(owner, request)
      let receivedInstruction = ''
      let receivedMessageUuid = ''
      harness.dependencies.execution.execute = async execution => {
        if (execution.mode !== 'canvas-orchestrator') throw new Error('UNEXPECTED_SPECIALIST')
        receivedInstruction = execution.instruction
        receivedMessageUuid = execution.userMessageUuid
        return { status: 'completed' }
      }

      const result = await harness.service.resume(owner, initial.id, {
        id: 'correction-1', expectedRevision: initial.revision, instruction: '重新读取两份正式文档并修正阶段登记',
      })

      expect(receivedInstruction).toContain('重新读取两份正式文档并修正阶段登记')
      expect(receivedInstruction).toContain('原目标、约束和交付合同保持不变')
      expect(receivedMessageUuid).toBe(createHash('sha256').update(`${initial.id}:follow-up:correction-1`).digest('hex'))
      expect(result.followUps?.[0]?.status).toBe('delivered')
    } finally { harness.cleanup() }
  })

  test('Given 正式设计已存在 When 只平移或修改正文 Then 布局不失效而真实版本会失效', async () => {
    const harness = fixture()
    try {
      harness.document.nodes.push({ id: 'document', kind: 'document', title: '脚本', documentId: 'content', contentRevision: 1, position: { x: 0, y: 0 } })
      harness.bodies.set('document', '第一版脚本')
      const initial = await readCanvasOrchestrationNodeIdentity(harness.dependencies, harness.target, 'document')
      harness.document.nodes[0]!.position.x = 100
      expect(await readCanvasOrchestrationNodeIdentity(harness.dependencies, harness.target, 'document')).toBe(initial)
      harness.bodies.set('document', '第二版脚本')
      expect(await readCanvasOrchestrationNodeIdentity(harness.dependencies, harness.target, 'document')).not.toBe(initial)
    } finally { harness.cleanup() }
  })
})
