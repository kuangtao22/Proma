import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasDocument, CanvasMediaTarget, CanvasWorkflowRun, MediaInputValue, MediaRunSnapshot } from '@proma/shared'
import type { MediaRunOrigin } from '../media/media-run-service'
import type { CanvasToolRunContext } from './canvas-tool-provider'
import { createCanvasMediaHandoffService } from './canvas-media-handoff-service'
import { createCanvasMediaHandoffStore, type CanvasMediaPreparedHandoff } from './canvas-media-handoff-store'
import type { CanvasMediaModuleState, CanvasMediaResolvedInput } from './canvas-media-service'
import { prepareCanvasWorkflowMediaInputs } from './canvas-workflow-planner'
import { createCanvasWorkflowRunStore } from './canvas-workflow-run-store'

const WORKFLOW_ID = 'a'.repeat(48)
const PREPARED_RUN_ID = 'b'.repeat(48)
const target: CanvasMediaTarget = {
  projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'video-target', mediaModuleId: 'video-module', mediaKind: 'video',
}
const actor = {
  sessionId: 'child-session', runStartedAt: 10, mode: 'parent-orchestrated' as const, canvasId: 'canvas-1', nodeId: 'agent-child',
}
const inputs: Record<string, MediaInputValue> = { prompt: { kind: 'scalar', value: '生成视频' } }

/** 创建真实 Canvas 节点身份。 */
function document(): CanvasDocument {
  const value = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
  value.nodes = [
    { id: 'agent-child', kind: 'agent', title: '子 Agent', position: { x: 0, y: 0 }, agentSessionId: 'child-session' },
    { id: 'video-target', kind: 'video', title: '视频', position: { x: 10, y: 0 }, mediaModuleId: 'video-module' },
  ]
  return value
}

/** 创建父计划，可通过节点状态模拟 prepare、apply 与 claim 阶段。 */
function workflow(childStatus: CanvasWorkflowRun['nodes'][number]['status'] = 'running'): CanvasWorkflowRun {
  return {
    schemaVersion: 1, id: WORKFLOW_ID, revision: 0, projectId: 'project-1', canvasId: 'canvas-1', operationId: 'workflow-operation',
    owner: { sessionId: 'parent-session', runStartedAt: 10 }, status: 'running', initialCanvasRevision: 1, observedCanvasRevision: 1,
    rootNodeIds: ['agent-child'], goal: '生成视频', autoResumeAfterAdoption: false, cancelRequestedAt: null, cancelledAt: null,
    budget: { maxMediaRuns: 2, consumedMediaRuns: 0, remainingMediaRuns: 2, maxDurationMs: 60_000, remainingDurationMs: 60_000, activeStartedAt: 10 },
    nodes: [
      { nodeId: 'agent-child', kind: 'agent', identityHash: '1'.repeat(64), plannedArtifactHash: null, mediaConfigRevision: null,
        inputBindings: [], dependencyNodeIds: [], status: childStatus, errorCode: null,
        execution: { kind: 'agent', operationId: 'child-operation' }, completedArtifactHash: childStatus === 'completed' ? '5'.repeat(64) : null,
        completedAt: childStatus === 'completed' ? 12 : null },
      { nodeId: 'video-target', kind: 'video', identityHash: '2'.repeat(64), plannedArtifactHash: null, mediaConfigRevision: null,
        inputBindings: [], dependencyNodeIds: ['agent-child'], status: 'blocked', errorCode: 'CANVAS_WORKFLOW_DEPENDENCY_PENDING',
        execution: null, completedArtifactHash: null, completedAt: null },
    ],
    createdAt: 10, updatedAt: 10,
  }
}

/** 创建固定配置 revision 的媒体模块。 */
function moduleState(revision = 4): CanvasMediaModuleState {
  return {
    schemaVersion: 1, revision: 4,
    config: { schemaVersion: 1, contentId: 'video-module', mediaKind: 'video', revision, createdAt: 1, updatedAt: 1,
      profile: { profileId: 'video-profile', profileRevision: 2 }, inputs: [], outputs: [], adoptedOutputs: [] },
    operations: [], candidates: [], pendingAdoptionProjection: null,
  }
}

/** 构造可信父编排上下文。 */
function context(): CanvasToolRunContext {
  return {
    projectId: 'project-1', sessionId: 'child-session', runStartedAt: 10, explicitReferences: [], permissionCeiling: 'execute',
    canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-child' },
    canvasAgentMode: 'parent-orchestrated', parentWorkflow: { runId: WORKFLOW_ID, parentSessionId: 'parent-session' },
  }
}

/** 构造可观察交接、配置漂移和重启读取的服务依赖。 */
function fixture() {
  let currentDocument = document()
  let currentWorkflow = workflow()
  let currentModule = moduleState()
  let stored: CanvasMediaPreparedHandoff | null = null
  let prepareCount = 0
  let afterPrepare: (() => void) | null = null
  let resolvedBinding: CanvasMediaResolvedInput = {
    targetInputKey: 'prompt', requiredKind: 'text' as const, sourceNodeId: null, sourceOutputKey: null,
    sourceArtifactHash: null, resolvedValue: inputs.prompt!, errorCode: null,
  }
  const snapshot: MediaRunSnapshot = {
    id: PREPARED_RUN_ID, projectId: 'project-1', revision: 0, phase: 'prepared', profileId: 'video-profile', profileRevision: 2,
    createdAt: 10, updatedAt: 10, outputs: [], error: null, progress: null,
  }
  const create = () => createCanvasMediaHandoffService({
    handoffs: {
      record: (value) => { stored = structuredClone(value); return structuredClone(value) },
      get: (valueTarget, workflowRunId) => stored && workflowRunId === stored.workflowRunId && valueTarget.nodeId === stored.target.nodeId
        ? structuredClone(stored) : null,
    },
    modules: { load: async () => structuredClone(currentModule), compareAndSwap: async () => { throw new Error('不应写模块') } },
    inputs: { resolveNodeInputs: async () => ({
      configRevision: 4, ready: true,
      bindings: [structuredClone(resolvedBinding)],
    }) },
    runs: { prepare: async (_input, _origin) => {
      prepareCount += 1
      afterPrepare?.()
      return structuredClone(snapshot)
    }, prepareDraft: async (input) => {
      prepareCount += 1
      return { ...structuredClone(snapshot), sourceRef: { kind: 'project-draft-revision', workflowId: input.workflowId,
        workflowRevision: input.workflowRevision, connectionId: input.connectionId, mediaKind: input.mediaKind },
        profileId: undefined, profileRevision: undefined }
    }, getWorkflowDefinition: () => ({ schemaVersion: 1, prompt: {}, bindings: [],
      outputs: [{ key: 'video', nodeId: '1', outputIndex: 0, mediaType: 'video' }] }) },
    getWorkflow: () => structuredClone(currentWorkflow), loadCanvas: () => structuredClone(currentDocument), authorize: () => undefined,
  })
  return {
    create, snapshot,
    getStored: () => structuredClone(stored), getPrepareCount: () => prepareCount,
    setDocument: (value: CanvasDocument) => { currentDocument = structuredClone(value) },
    setWorkflow: (value: CanvasWorkflowRun) => { currentWorkflow = structuredClone(value) },
    setModule: (value: CanvasMediaModuleState) => { currentModule = structuredClone(value) },
    afterPrepare: (effect: () => void) => { afterPrepare = effect },
    setResolvedBinding: (value: typeof resolvedBinding) => { resolvedBinding = structuredClone(value) },
  }
}

describe('Canvas 媒体父工作流交接服务', () => {
  test('Given 真实父计划、子 actor 与 typed 输入 When prepare Then 固化同一 prepared run 和输入身份', async () => {
    const current = fixture()
    await expect(current.create().prepare(context(), {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
    }, { actor })).resolves.toEqual(current.snapshot)
    expect(current.getStored()).toMatchObject({
      target, workflowRunId: WORKFLOW_ID, parentSessionId: 'parent-session', preparedRunId: PREPARED_RUN_ID,
      preparedActor: actor, configRevision: 4,
      inputBindings: [{ targetInputKey: 'prompt', sourceNodeId: null, sourceArtifactHash: null }],
    })
  })

  test('Given 无 profile 媒体节点已配置 typed 合同 When child 准备 WorkflowDraft Then journal 保留真实草稿来源', async () => {
    const current = fixture()
    current.setModule({ ...moduleState(), config: { ...moduleState().config, profile: null,
      inputs: [{ key: 'prompt', kind: 'text', source: { type: 'literal', value: '生成视频' } }],
      outputs: [{ key: 'video', mediaKind: 'video', role: 'primary', order: 0 }] } })
    const source = { workflowId: 'branch-draft', workflowRevision: 1, connectionId: 'gpu', mediaKind: 'video' as const }

    await current.create().prepare(context(), { targetNodeId: target.nodeId, operationId: 'draft-operation',
      inputs, ...source }, { actor })

    expect(current.getStored()?.sourceRef).toEqual({ kind: 'project-draft-revision', ...source })
  })

  test('Given 调用方冒充其他 child actor When prepare Then 在创建 run 前拒绝扩权', async () => {
    const current = fixture()
    await expect(current.create().prepare(context(), {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
    }, { actor: { ...actor, sessionId: 'other-child' } })).rejects.toThrow('CANVAS_MEDIA_HANDOFF_ACTOR_INVALID')
    expect(current.getPrepareCount()).toBe(0)
    expect(current.getStored()).toBeNull()
  })

  test('Given Agent 传入输入与 Host resolver 结果不同 When prepare Then 不创建 prepared run', async () => {
    const current = fixture()
    await expect(current.create().prepare(context(), {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2,
      inputs: { prompt: { kind: 'scalar', value: '被篡改的输入' } },
    }, { actor })).rejects.toThrow('CANVAS_MEDIA_INPUTS_CHANGED')
    expect(current.getPrepareCount()).toBe(0)
    expect(current.getStored()).toBeNull()
  })

  test('Given 普通 Agent、错误父 owner 或非直接下游 When prepare Then 不创建 prepared run', async () => {
    const attempts: Array<() => Promise<MediaRunSnapshot>> = []
    const normal = fixture()
    attempts.push(() => normal.create().prepare({ ...context(), canvasAgentMode: undefined }, {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
    }, { actor }))
    const wrongOwner = fixture()
    const ownerWorkflow = workflow()
    ownerWorkflow.owner.sessionId = 'other-parent'
    wrongOwner.setWorkflow(ownerWorkflow)
    attempts.push(() => wrongOwner.create().prepare(context(), {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
    }, { actor }))
    const indirect = fixture()
    const indirectWorkflow = workflow()
    indirectWorkflow.nodes[1]!.dependencyNodeIds = []
    indirect.setWorkflow(indirectWorkflow)
    attempts.push(() => indirect.create().prepare(context(), {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
    }, { actor }))
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow()
  })

  test('Given prepare 期间配置或 scope 漂移 When 复验 Then 留下的 prepared run 不产生可 claim 交接', async () => {
    const configDrift = fixture()
    configDrift.afterPrepare(() => configDrift.setModule(moduleState(5)))
    await expect(configDrift.create().prepare(context(), {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
    }, { actor })).rejects.toThrow('CANVAS_MEDIA_CONFIG_CONFLICT')
    expect(configDrift.getPrepareCount()).toBe(1)
    expect(configDrift.getStored()).toBeNull()

    const scopeDrift = fixture()
    scopeDrift.afterPrepare(() => {
      const changed = workflow()
      changed.cancelRequestedAt = 11
      scopeDrift.setWorkflow(changed)
    })
    await expect(scopeDrift.create().prepare(context(), {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
    }, { actor })).rejects.toThrow('CANVAS_MEDIA_HANDOFF_SCOPE_INVALID')
    expect(scopeDrift.getPrepareCount()).toBe(1)
    expect(scopeDrift.getStored()).toBeNull()
  })

  test('Given child 完成 When apply Then 只释放原计划中的直接媒体下游并固化配置', async () => {
    const current = fixture()
    await current.create().prepare(context(), {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
    }, { actor })
    const run = workflow('completed')
    const applied = await current.create().apply(run, document())
    expect(applied.nodes[1]).toMatchObject({ status: 'ready', mediaConfigRevision: 4, errorCode: null })
  })

  test('Given 真实 workflow 与 handoff journals When child 完成后固化交接 Then 专用 CAS 让重启可继续同一 run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-media-handoff-integration-'))
    try {
      const transactionsDir = join(root, 'transactions')
      mkdirSync(transactionsDir, { recursive: true })
      const workflowRuns = createCanvasWorkflowRunStore({
        pathResolver: { resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']> },
        runWorkspaceWrite: (_projectId, effect) => effect(), now: () => 20,
      })
      const initial = workflow()
      initial.nodes[1]!.mediaConfigRevision = 3
      initial.nodes[1]!.inputBindings = [{
        targetInputKey: 'oldPrompt', requiredKind: 'text', sourceNodeId: null, sourceOutputKey: null,
        sourceArtifactHash: null, resolvedValueHash: null,
      }]
      const created = workflowRuns.create({
        projectId: initial.projectId, canvasId: initial.canvasId, operationId: initial.operationId, owner: initial.owner,
        initialCanvasRevision: initial.initialCanvasRevision, rootNodeIds: initial.rootNodeIds, goal: initial.goal,
        nodes: initial.nodes, maxMediaRuns: 2, consumedMediaRuns: 0, autoResumeAfterAdoption: false,
      })
      let preparedOrigin: MediaRunOrigin = {}
      const handoffs = createCanvasMediaHandoffStore({
        getDirectory: () => join(transactionsDir, 'media-handoffs'),
        getWorkflow: (valueTarget, runId) => workflowRuns.get(valueTarget, runId),
        getRunOrigin: () => structuredClone(preparedOrigin),
        runWorkspaceWrite: (_projectId, effect) => effect(),
      })
      const service = createCanvasMediaHandoffService({
        handoffs, modules: { load: async () => moduleState(), compareAndSwap: async () => { throw new Error('不应写模块') } },
        inputs: { resolveNodeInputs: async () => ({ configRevision: 4, ready: true, bindings: [{
          targetInputKey: 'prompt', requiredKind: 'text', sourceNodeId: null, sourceOutputKey: null,
          sourceArtifactHash: null, resolvedValue: inputs.prompt!, errorCode: null,
        }] }) },
        runs: { prepare: async (_input, origin) => {
          preparedOrigin = structuredClone(origin ?? {})
          return { id: PREPARED_RUN_ID, projectId: 'project-1', revision: 0, phase: 'prepared', profileId: 'video-profile', profileRevision: 2,
            createdAt: 10, updatedAt: 10, outputs: [], error: null, progress: null }
        } },
        getWorkflow: (valueTarget, runId) => workflowRuns.get(valueTarget, runId), loadCanvas: () => document(), authorize: () => undefined,
      })
      const runContext = { ...context(), parentWorkflow: { runId: created.id, parentSessionId: 'parent-session' } }
      await service.prepare(runContext, {
        targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
      }, { actor })
      const completed = workflowRuns.get(target, created.id)
      completed.nodes[0]!.status = 'completed'
      completed.nodes[0]!.completedArtifactHash = '5'.repeat(64)
      completed.nodes[0]!.completedAt = 21
      const savedCompletion = workflowRuns.save(completed, completed.revision)
      const applied = await service.apply(savedCompletion, document())
      const amended = workflowRuns.savePreparedMediaAmendment(applied, savedCompletion.revision)

      expect(workflowRuns.get(target, created.id)).toEqual(amended)
      expect(amended.nodes[1]).toMatchObject({ status: 'ready', mediaConfigRevision: 4 })
      expect(amended.nodes[1]?.inputBindings.map((binding) => binding.targetInputKey)).toEqual(['prompt'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given running child 用旧 agent.text 准备下游 When 完成后正式输出变化 Then 父执行拒绝旧交接输入', async () => {
    const current = fixture()
    current.setResolvedBinding({
      targetInputKey: 'prompt', requiredKind: 'text', sourceNodeId: 'agent-child', sourceOutputKey: 'agent.text',
      sourceArtifactHash: '3'.repeat(64), resolvedValue: inputs.prompt!, errorCode: null,
    })
    await current.create().prepare(context(), {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
    }, { actor })
    const applied = await current.create().apply(workflow('completed'), document())

    expect(() => prepareCanvasWorkflowMediaInputs(applied, target.nodeId, {
      configRevision: 4, ready: true,
      bindings: [{
        targetInputKey: 'prompt', requiredKind: 'text', sourceNodeId: 'agent-child', sourceOutputKey: 'agent.text',
        sourceArtifactHash: '6'.repeat(64), resolvedValue: { kind: 'scalar', value: '正式完成后的新输出' }, errorCode: null,
      }],
    })).toThrow('CANVAS_WORKFLOW_INPUT_CHANGED')
  })

  test('Given Canvas 子节点换绑会话或模块配置漂移 When apply Then 不使用旧交接', async () => {
    const current = fixture()
    await current.create().prepare(context(), {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
    }, { actor })
    const changedDocument = document()
    const child = changedDocument.nodes[0]!
    if (child.kind === 'agent') child.agentSessionId = 'replacement-session'
    await expect(current.create().apply(workflow('completed'), changedDocument)).rejects.toThrow('CANVAS_MEDIA_HANDOFF_SCOPE_INVALID')

    const configDrift = fixture()
    await configDrift.create().prepare(context(), {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
    }, { actor })
    configDrift.setModule(moduleState(5))
    await expect(configDrift.create().apply(workflow('completed'), document())).rejects.toThrow('CANVAS_MEDIA_HANDOFF_CONFIG_CHANGED')
  })

  test('Given 重启后目标已由父调度取得 running 所有权 When claim Then 返回原 prepared 身份且拒绝节点换绑', async () => {
    const current = fixture()
    await current.create().prepare(context(), {
      targetNodeId: target.nodeId, operationId: 'prepare-operation', profileId: 'video-profile', profileRevision: 2, inputs,
    }, { actor })
    const running = workflow('completed')
    running.nodes[1]!.status = 'running'
    running.nodes[1]!.mediaConfigRevision = 4
    running.nodes[1]!.execution = { kind: 'media', operationId: 'media-operation', mediaRunId: null, outputKeys: [] }
    current.setWorkflow(running)
    expect(current.create().claimOptions(target, WORKFLOW_ID)).toEqual({
      preparedRunId: PREPARED_RUN_ID,
      preparedActor: actor,
      preparedSourceRef: { kind: 'profile-version', profileId: 'video-profile', profileRevision: 2 },
    })

    const changedDocument = document()
    const child = changedDocument.nodes[0]!
    if (child.kind === 'agent') child.agentSessionId = 'replacement-session'
    current.setDocument(changedDocument)
    expect(() => current.create().claimOptions(target, WORKFLOW_ID)).toThrow('CANVAS_MEDIA_HANDOFF_SCOPE_INVALID')
  })
})
