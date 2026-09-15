import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmptyCanvasDocument, getCanvasOrchestrationPendingDecision } from '@proma/shared'
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
import { createCanvasOrchestrationTools } from './canvas-orchestration-tools'

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
        /** 按真实计划核对送达范围，兼容单链与多个专业成果汇合，不依赖测试步骤名称。 */
        const record = store.get(target)!
        /** 本次受管专业步骤及其直接输入和依赖成果。 */
        const step = record.steps.find(candidate => candidate.id === access.stepId)!
        /** 审核范围必须完整携带实际依赖，避免只比较是否存在一个 scope。 */
        const expectedInputs = [...new Set([...step.inputNodeIds,
          ...record.steps.filter(candidate => step.dependsOn.includes(candidate.id)).flatMap(candidate => candidate.outputNodeIds)])]
        expect(request.reviewScope).toEqual(expectedInputs.length ? { mode: 'nodes', nodeIds: expectedInputs } : undefined)
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

  test.each(['unchanged', 'costume', 'scene', 'action'] as const)(
    'Given 服装场景动作汇入镜头且%s When 实际分派与复验 Then 传递完整设计或阻断失效分支且不扣额', async changed => {
      /** 使用真实 Store、版本解析和执行组合；专业正文受控，不发起模型或媒体请求。 */
      const harness = fixture()
      try {
        harness.document.nodes.push({ id: 'brief', kind: 'document', title: '开包取物脚本', documentId: 'brief-content',
          contentRevision: 1, position: { x: 0, y: 0 } })
        harness.bodies.set('brief', '人物在桌前开包取物；左手稳包，右手取出产品，连续切镜展示。')
        harness.coordinate(async record => {
          /** 使用本轮协调者的真实身份维护受管计划。 */
          const context = canvasOrchestratorContext(record)
          /** Actor 只在当前委托运行内有效。 */
          const actor = { ...harness.target, sessionId: context.sessionId, orchestrationId: record.id, runStartedAt: context.runStartedAt }
          /** 三项可独立评审的设计，随后汇入一个镜头，独立片尾仅依赖原始需求。 */
          const definitions = [
            { id: 'costume', role: '服装与造型', instruction: '确定袖口和配饰，避免遮挡取物；记录造型固定项', criteria: ['服装身份一致且允许右手取物'] },
            { id: 'scene', role: '场景与道具', instruction: '明确桌面、包与产品位置、开口朝向及光线', criteria: ['空间尺度和产品状态可核对'] },
            { id: 'action', role: '动作与表演', instruction: '动作段 A1：左手稳包，右手开包取物；视线由包转产品，结束展示', criteria: ['起止状态、接触和左右手连续'] },
            { id: 'shot', role: '镜头设计', instruction: 'S1-S2 引用服装、场景、动作的真实版本，保持 A1 的持有者和产品朝向', criteria: ['三项设计一致且切镜动作连续'] },
            { id: 'end-card', role: '片尾文案', instruction: '依据原需求写独立片尾文字', criteria: ['文字符合原目标'] },
          ]
          /** 分派采用现有开放步骤合同，不新增专业枚举或自造产物字段。 */
          let current = await harness.service.updatePlan(actor, record.revision, definitions.map(definition => ({
            ...definition, title: definition.role, dependsOn: definition.id === 'shot' ? ['costume', 'scene', 'action'] : [],
            inputNodeIds: ['brief'], outputNodeIds: [], agentNodeId: null, status: 'planned', note: '',
          })))
          for (const id of ['costume', 'scene', 'action']) {
            current = await harness.service.dispatch(actor, current.revision, id)
            /** 未验收的任意一项设计都不能用其它专业通过来替代。 */
            const beforeCalls = [...harness.calls]
            await expect(harness.service.dispatch(actor, current.revision, 'shot')).rejects.toThrow('CANVAS_ORCHESTRATION_DEPENDENCY_PENDING')
            expect(harness.calls).toEqual(beforeCalls)
            current = await harness.service.reviewStep(actor, current.revision, id, true, '已复读设计与脚本，符合本项验收')
          }
          /** 版本基线与运行预算须在试图启动镜头前冻结。 */
          const beforeBudget = current.budget!.agentRunsUsed
          /** 三项真实正式产物会通过依赖送达镜头。 */
          const designNodes = current.steps.filter(step => ['costume', 'scene', 'action'].includes(step.id)).flatMap(step => step.outputNodeIds)
          if (changed !== 'unchanged') {
            /** 模拟某专业正式设计修订，保留原节点身份和其它专业成果。 */
            const changedStep = current.steps.find(step => step.id === changed)!
            /** 正式输出版本改变必须被真实证据解析检测到。 */
            const node = harness.document.nodes.find(node => node.id === changedStep.agentNodeId)
            if (node?.kind !== 'agent' || !node.outputPointer) throw new Error('TEST_DESIGN_MISSING')
            node.outputPointer = { ...node.outputPointer, messageUuid: 'revised-design', contentSha256: 'b'.repeat(64) }
            harness.bodies.set(node.id, '设计已修订，原镜头输入需重新核对')
            /** 阻断不能创建/运行镜头 Agent，也不能消耗执行预算。 */
            const beforeRuns = harness.calls.filter(call => call.startsWith('run:') || call.startsWith('create:'))
            await expect(harness.service.dispatch(actor, current.revision, 'shot')).rejects.toThrow('CANVAS_ORCHESTRATION_EVIDENCE_STALE')
            current = harness.store.get(harness.target)!
            expect(current.budget!.agentRunsUsed).toBe(beforeBudget)
            expect(harness.calls.filter(call => call.startsWith('run:') || call.startsWith('create:'))).toEqual(beforeRuns)
            expect(current.steps.find(step => step.id === changed)?.status).toBe('needs-review')
            expect(current.steps.filter(step => ['costume', 'scene', 'action'].includes(step.id) && step.id !== changed)
              .every(step => step.status === 'completed')).toBe(true)
          } else {
            current = await harness.service.dispatch(actor, current.revision, 'shot')
            /** 检查 Host 冻结的输入确实包含原脚本和全部设计，正文也实际带有任务与验收要求。 */
            const shot = current.steps.find(step => step.id === 'shot')!
            expect(shot.inputVersions?.map(version => version.nodeId)).toEqual(['brief', ...designNodes])
            expect(harness.bodies.get(shot.agentNodeId!)).toContain('三项设计一致且切镜动作连续')
            for (const nodeId of designNodes) expect(harness.bodies.get(shot.agentNodeId!)).toContain(nodeId)
            current = await harness.service.reviewStep(actor, current.revision, 'shot', true, '已按三项设计核对镜头')
            /** 精确重放已完成镜头不得重建或重复扣额。 */
            const completedBudget = current.budget!.agentRunsUsed
            current = await harness.service.dispatch(actor, current.revision, 'shot')
            expect(current.budget!.agentRunsUsed).toBe(completedBudget)
          }
          current = await harness.service.dispatch(actor, current.revision, 'end-card')
          expect(current.steps.find(step => step.id === 'end-card')?.status).toBe('needs-review')
          expect(current.budget!.mediaRunsUsed).toBe(0)
        })
        await harness.service.delegate({ ...harness.target, sessionId: 'owner' }, {
          requestId: 'professional-design', goal: '设计开包宣传镜头', intent: 'design', constraints: [], referenceNodeIds: ['brief'],
          deliverables: [{ id: 'shots', kind: 'agent', title: '镜头方案', criteria: ['服装场景动作一致'] }],
        })
        /** 读取落盘后的状态，确保回调真实完成而非被协调层错误处理吞掉。 */
        expect(harness.store.get(harness.target)?.steps.find(step => step.id === 'end-card')?.status).toBe('needs-review')
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

  test.each(['completed', 'errored'] as const)(
    'Given 真实工具已发布关键问题 When 用户答复后执行%s Then 同一委托落盘保留答案且重放不重跑', async outcome => {
      /** 使用真实工具、Runtime 和文件 Store，仅模型执行结果由隔离夹具控制。 */
      const harness = fixture()
      try {
        /** 原用户是唯一决策答复者，所有恢复均复用当前画布和委托身份。 */
        const owner = { ...harness.target, sessionId: 'owner' }
        harness.coordinate(async record => {
          /** 编排者工具按生产身份创建，不能通过普通聊天身份发布问题。 */
          const actorTools = createCanvasOrchestrationTools({ service: harness.service, access: harness.dependencies.access },
            canvasOrchestratorContext(record))
          /** 发布与结束均经工具校验后进入生产服务并落盘。 */
          const reportTool = actorTools.find(tool => tool.name === 'canvas_report_orchestration')!
          await reportTool.execute('report-question', { expectedRevision: record.revision, report: {
            summary: '脚本方向需要确认', nextStep: '等待选择后继续镜头设计', decision: {
              id: 'visual-direction', question: '采用哪种视觉方向？',
              options: [{ id: 'minimal', label: '简约', impact: '复用当前场景' }, { id: 'rich', label: '丰富', impact: '增加场景设计' }],
              recommendedOptionId: 'minimal', reason: '符合现有素材和时长',
            },
          } }, new AbortController().signal, undefined, {} as never)
          await actorTools.find(tool => tool.name === 'canvas_finish_orchestration')!.execute('wait-answer', {
            status: 'waiting', summary: '等待用户选择视觉方向',
          }, new AbortController().signal, undefined, {} as never)
        })
        /** 首次运行只提出问题；检查落盘以免执行层吞掉回调断言。 */
        const waiting = await harness.service.delegate(owner, {
          requestId: 'decision-runtime', goal: '完成专业设计', intent: 'design', constraints: [], referenceNodeIds: [],
          deliverables: [{ id: 'design', kind: 'agent', title: '专业设计', criteria: ['有可核对产物'] }],
        })
        expect(waiting.status).toBe('waiting')
        expect(getCanvasOrchestrationPendingDecision(harness.store.get(harness.target)!)?.id).toBe('visual-direction')
        /** 可观察执行边界记录真实送达文本与身份，不调用模型。 */
        const resumed: Array<{ instruction: string; orchestrationId: string }> = []
        harness.dependencies.execution.execute = async execution => {
          if (execution.mode !== 'canvas-orchestrator') throw new Error('UNEXPECTED_SPECIALIST')
          resumed.push({ instruction: execution.instruction, orchestrationId: execution.orchestrationId })
          return { status: outcome }
        }
        /** 普通聊天只通过生产 resume 工具登记原文，不直接写 Store。 */
        const ownerTools = createCanvasOrchestrationTools({ service: harness.service, access: harness.dependencies.access }, {
          projectId: owner.projectId, sessionId: owner.sessionId, permissionCeiling: 'execute', runStartedAt: 1, explicitReferences: [],
        })
        const resumeTool = ownerTools.find(tool => tool.name === 'canvas_resume_orchestration')!
        const answer = { canvasId: waiting.canvasId, orchestrationId: waiting.id,
          followUp: { id: 'answer-visual', expectedRevision: waiting.revision, instruction: '我选择简约，保留原来的场景。', decisionId: 'visual-direction' } }
        await resumeTool.execute('answer-question', answer, new AbortController().signal, undefined, {} as never)
        /** 重新读取磁盘后的记录，覆盖真实序列化和答案关联的保存路径。 */
        const saved = harness.store.get(harness.target)!
        expect(saved.id).toBe(waiting.id)
        expect(saved.followUps?.[0]).toMatchObject({ decisionId: 'visual-direction', instruction: answer.followUp.instruction,
          status: outcome === 'completed' ? 'delivered' : 'failed' })
        expect(saved.report?.stale).toBe(true)
        expect(getCanvasOrchestrationPendingDecision(saved)).toBeNull()
        expect(resumed).toHaveLength(1)
        expect(resumed[0]?.instruction).toContain(answer.followUp.instruction)
        expect(resumed[0]?.orchestrationId).toBe(waiting.id)
        await resumeTool.execute('replay-answer', answer, new AbortController().signal, undefined, {} as never)
        expect(resumed).toHaveLength(1)
        expect(harness.store.get(harness.target)?.budget).toEqual(saved.budget)
      } finally { harness.cleanup() }
    },
  )

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
