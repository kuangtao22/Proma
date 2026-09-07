import { createHash } from 'node:crypto'
import type { CanvasDocument, CanvasMediaTarget, CanvasWorkflowRun, MediaInputValue, MediaRunSnapshot, MediaRunSourceReference } from '@proma/shared'
import { parseMediaRunInputs } from '../media/media-run-service'
import type { MediaRunOrigin, MediaRunService } from '../media/media-run-service'
import type { CanvasToolRunContext } from './canvas-tool-provider'
import type { CanvasMediaInputResolver } from './canvas-media-input-resolver'
import type { CanvasMediaModuleStore } from './canvas-media-service'
import type { CanvasMediaPreparedHandoff, createCanvasMediaHandoffStore } from './canvas-media-handoff-store'

/** 交接始终由 Host 读取父计划、真实 DAG 输入及已登记 run。 */
export interface CanvasMediaHandoffServiceDependencies {
  handoffs: ReturnType<typeof createCanvasMediaHandoffStore>
  modules: CanvasMediaModuleStore
  inputs: CanvasMediaInputResolver
  runs: Pick<MediaRunService, 'prepare'> & Partial<Pick<MediaRunService, 'prepareDraft' | 'getWorkflowDefinition'>>
  getWorkflow(target: { projectId: string; canvasId: string }, runId: string): CanvasWorkflowRun
  loadCanvas(target: { projectId: string; canvasId: string }): CanvasDocument
  authorize(context: CanvasToolRunContext): void
}

/** 准备工具只接收预设和槽位，身份与父计划来自可信上下文。 */
interface PrepareCanvasMediaHandoffBase {
  targetNodeId: string
  operationId: string
  inputs: Record<string, MediaInputValue>
}

/** child 可选择已发布 profile 或项目私有 workflow 草稿 revision，两者严格互斥。 */
export type PrepareCanvasMediaHandoffInput = PrepareCanvasMediaHandoffBase & (
  | { profileId: string; profileRevision: number; workflowId?: never; workflowRevision?: never; connectionId?: never; mediaKind?: never }
  | { profileId?: never; profileRevision?: never; workflowId: string; workflowRevision: number; connectionId: string; mediaKind: CanvasMediaTarget['mediaKind'] }
)

/** 解析图中真实媒体模块，不能接受模型传来的模块路径或 ID。 */
function mediaTarget(document: CanvasDocument, nodeId: string): CanvasMediaTarget {
  const node = document.nodes.find((item) => item.id === nodeId)
  if (!node || (node.kind !== 'audio' && node.kind !== 'video')) throw new Error('CANVAS_MEDIA_NODE_REQUIRED')
  return { projectId: document.projectId, canvasId: document.canvasId, nodeId, mediaModuleId: node.mediaModuleId, mediaKind: node.kind }
}

/** 按 key 排序的已解析值比较，使对象字段顺序不影响授权判断。 */
function inputIdentity(value: Record<string, MediaInputValue>): string {
  return JSON.stringify(Object.entries(parseMediaRunInputs(value)).sort(([left], [right]) => left.localeCompare(right)))
}

/** 子工具提供的 origin 必须精确等于 Host 注入的本轮 Canvas Agent 身份。 */
function validatePreparedActor(context: CanvasToolRunContext, origin: MediaRunOrigin): NonNullable<MediaRunOrigin['actor']> {
  const actor = origin.actor
  const target = context.canvasAgentTarget
  if (!actor || actor.mode !== 'parent-orchestrated'
    || actor.sessionId !== context.sessionId || actor.runStartedAt !== context.runStartedAt
    || !target || actor.canvasId !== target.canvasId || actor.nodeId !== target.nodeId
    || origin.preparedBy || origin.designJobId || origin.canvasMedia) {
    throw new Error('CANVAS_MEDIA_HANDOFF_ACTOR_INVALID')
  }
  return actor
}

/** 父调度接管子 Agent 准备的同一个 run，不解析子 Agent 正文。 */
export function createCanvasMediaHandoffService(dependencies: CanvasMediaHandoffServiceDependencies): {
  prepare(context: CanvasToolRunContext, input: PrepareCanvasMediaHandoffInput, origin: MediaRunOrigin): Promise<MediaRunSnapshot>
  apply(run: CanvasWorkflowRun, document: CanvasDocument): Promise<CanvasWorkflowRun>
  claimOptions(target: CanvasMediaTarget, workflowRunId: string): {
    preparedRunId: string
    preparedActor: NonNullable<MediaRunOrigin['actor']>
    preparedSourceRef: MediaRunSourceReference
  } | undefined
} {
  /** 固定目标必须是原计划内当前 child 的直接下游。 */
  const validateScope = (context: CanvasToolRunContext, input: PrepareCanvasMediaHandoffInput): CanvasMediaTarget => {
    dependencies.authorize(context)
    if (context.canvasAgentMode !== 'parent-orchestrated' || !context.canvasAgentTarget || !context.parentWorkflow) {
      throw new Error('CANVAS_MEDIA_PARENT_WORKFLOW_REQUIRED')
    }
    const document = dependencies.loadCanvas(context.canvasAgentTarget)
    const child = document.nodes.find((node) => node.id === context.canvasAgentTarget!.nodeId)
    const run = dependencies.getWorkflow(context.canvasAgentTarget, context.parentWorkflow.runId)
    const planned = run.nodes.find((node) => node.nodeId === input.targetNodeId)
    if (child?.kind !== 'agent' || child.agentSessionId !== context.sessionId
      || run.owner.sessionId !== context.parentWorkflow.parentSessionId || run.owner.runStartedAt !== context.runStartedAt
      || run.status !== 'running' || run.cancelRequestedAt !== null || !planned?.dependencyNodeIds.includes(child.id)
      || (planned.kind !== 'audio' && planned.kind !== 'video') || planned.execution !== null) {
      throw new Error('CANVAS_MEDIA_HANDOFF_SCOPE_INVALID')
    }
    return mediaTarget(document, input.targetNodeId)
  }
  return {
    prepare: async (context, input, origin) => {
      const target = validateScope(context, input)
      const preparedActor = validatePreparedActor(context, origin)
      const module = await dependencies.modules.load(target)
      const sourceRef: MediaRunSourceReference = input.profileId !== undefined
        ? { kind: 'profile-version', profileId: input.profileId, profileRevision: input.profileRevision }
        : { kind: 'project-draft-revision', workflowId: input.workflowId, workflowRevision: input.workflowRevision,
            connectionId: input.connectionId, mediaKind: input.mediaKind }
      if (sourceRef.kind === 'profile-version'
        && (module.config.profile?.profileId !== sourceRef.profileId || module.config.profile.profileRevision !== sourceRef.profileRevision)) {
        throw new Error('CANVAS_MEDIA_PROFILE_MISMATCH')
      }
      if (sourceRef.kind === 'project-draft-revision' && sourceRef.mediaKind !== target.mediaKind) {
        throw new Error('CANVAS_MEDIA_DRAFT_KIND_MISMATCH')
      }
      const resolved = await dependencies.inputs.resolveNodeInputs(target)
      if (!resolved.ready || resolved.configRevision !== module.config.revision) throw new Error('CANVAS_MEDIA_INPUTS_NOT_READY')
      const inputs: Record<string, MediaInputValue> = {}
      for (const binding of resolved.bindings) {
        if (!binding.resolvedValue || binding.errorCode) throw new Error('CANVAS_MEDIA_INPUTS_NOT_READY')
        inputs[binding.targetInputKey] = binding.resolvedValue
      }
      if (inputIdentity(input.inputs) !== inputIdentity(inputs)) throw new Error('CANVAS_MEDIA_INPUTS_CHANGED')
      validateScope(context, input)
      if (sourceRef.kind === 'project-draft-revision' && (!dependencies.runs.prepareDraft || !dependencies.runs.getWorkflowDefinition)) {
        throw new Error('CANVAS_MEDIA_DRAFT_UNAVAILABLE')
      }
      const snapshot = sourceRef.kind === 'profile-version'
        ? await dependencies.runs.prepare({ projectId: context.projectId, operationId: input.operationId,
            profileId: sourceRef.profileId, profileRevision: sourceRef.profileRevision, inputs }, { ...origin, canvasMedia: target })
        : await dependencies.runs.prepareDraft!({ projectId: context.projectId, operationId: input.operationId,
            workflowId: sourceRef.workflowId, workflowRevision: sourceRef.workflowRevision,
            connectionId: sourceRef.connectionId, mediaKind: sourceRef.mediaKind, inputs }, { ...origin, canvasMedia: target })
      const frozenWorkflow = dependencies.runs.getWorkflowDefinition?.(context.projectId, snapshot.id)
      if (sourceRef.kind === 'project-draft-revision' && frozenWorkflow
        && (module.config.outputs.length === 0 || module.config.outputs.some((binding) => !frozenWorkflow.outputs.some((output) => (
        output.key === binding.key && output.mediaType === binding.mediaKind
      ))))) throw new Error('CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH')
      validateScope(context, input)
      const fresh = await dependencies.modules.load(target)
      if (fresh.config.revision !== resolved.configRevision) throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
      const handoff: CanvasMediaPreparedHandoff = {
        schemaVersion: 1, target, workflowRunId: context.parentWorkflow!.runId,
        parentSessionId: context.parentWorkflow!.parentSessionId, preparedRunId: snapshot.id,
        preparedActor, configRevision: resolved.configRevision, sourceRef,
        inputBindings: resolved.bindings.map(({ targetInputKey, requiredKind, sourceNodeId, sourceOutputKey, sourceArtifactHash, resolvedValue }) => ({
          targetInputKey, requiredKind, sourceNodeId, sourceOutputKey, sourceArtifactHash,
          resolvedValueHash: createHash('sha256').update(JSON.stringify(['canvas-workflow-media-input', resolvedValue])).digest('hex'),
        })),
      }
      dependencies.handoffs.record(handoff)
      return snapshot
    },
    apply: async (run, document) => {
      const updated = structuredClone(run)
      for (const planned of updated.nodes) {
        if ((planned.kind !== 'audio' && planned.kind !== 'video') || planned.execution) continue
        const target = mediaTarget(document, planned.nodeId)
        const handoff = dependencies.handoffs.get(target, run.id)
        if (!handoff) continue
        const child = updated.nodes.find((node) => node.nodeId === handoff.preparedActor.nodeId)
        const childNode = document.nodes.find((node) => node.id === handoff.preparedActor.nodeId)
        if (!child || childNode?.kind !== 'agent'
          || childNode.agentSessionId !== handoff.preparedActor.sessionId
          || run.projectId !== handoff.target.projectId || run.canvasId !== handoff.target.canvasId
          || run.owner.sessionId !== handoff.parentSessionId
          || run.owner.runStartedAt !== handoff.preparedActor.runStartedAt
          || !planned.dependencyNodeIds.includes(child.nodeId)) throw new Error('CANVAS_MEDIA_HANDOFF_SCOPE_INVALID')
        if (child.status !== 'completed') continue
        const module = await dependencies.modules.load(target)
        if (module.config.revision !== handoff.configRevision
          || (handoff.sourceRef.kind === 'profile-version'
            && (module.config.profile?.profileId !== handoff.sourceRef.profileId
              || module.config.profile.profileRevision !== handoff.sourceRef.profileRevision))) {
          throw new Error('CANVAS_MEDIA_HANDOFF_CONFIG_CHANGED')
        }
        planned.mediaConfigRevision = handoff.configRevision
        planned.inputBindings = structuredClone(handoff.inputBindings)
        planned.status = 'ready'
        planned.errorCode = null
      }
      return updated
    },
    claimOptions: (target, workflowRunId) => {
      const handoff = dependencies.handoffs.get(target, workflowRunId)
      if (!handoff) return undefined
      const run = dependencies.getWorkflow(target, workflowRunId)
      const child = run.nodes.find((node) => node.nodeId === handoff.preparedActor.nodeId)
      const planned = run.nodes.find((node) => node.nodeId === target.nodeId)
      const childNode = dependencies.loadCanvas(target).nodes.find((node) => node.id === handoff.preparedActor.nodeId)
      if (run.status !== 'running' || run.cancelRequestedAt !== null || child?.status !== 'completed'
        || childNode?.kind !== 'agent' || childNode.agentSessionId !== handoff.preparedActor.sessionId
        || run.projectId !== target.projectId || run.canvasId !== target.canvasId
        || run.owner.sessionId !== handoff.parentSessionId
        || run.owner.runStartedAt !== handoff.preparedActor.runStartedAt
        || planned?.status !== 'running' || planned.execution?.kind !== 'media'
        || planned.mediaConfigRevision !== handoff.configRevision || !planned.dependencyNodeIds.includes(child.nodeId)) {
        throw new Error('CANVAS_MEDIA_HANDOFF_SCOPE_INVALID')
      }
      return { preparedRunId: handoff.preparedRunId, preparedActor: handoff.preparedActor,
        preparedSourceRef: structuredClone(handoff.sourceRef) }
    },
  }
}
