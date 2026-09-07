import { createHash } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { parseCanvasMediaTarget } from '@proma/shared'
import type { CanvasMediaTarget, CanvasWorkflowRun, CanvasWorkflowRunInputBinding, MediaRunSourceReference } from '@proma/shared'
import { ensureDirectoryDurable, writeJsonFileAtomicSecure } from '../safe-file'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readMediaJsonFile } from '../media/media-json-file'
import type { MediaRunOrigin } from '../media/media-run-service'

/** 子 Agent 只能交接固定计划内的直接下游，记录不包含素材路径或正文。 */
export interface CanvasMediaPreparedHandoff {
  schemaVersion: 1
  target: CanvasMediaTarget
  workflowRunId: string
  parentSessionId: string
  preparedRunId: string
  preparedActor: NonNullable<MediaRunOrigin['actor']>
  configRevision: number
  sourceRef: MediaRunSourceReference
  inputBindings: CanvasWorkflowRunInputBinding[]
}

/** 交接文件复用父 Canvas 的事务目录及工作区写守卫。 */
export interface CanvasMediaHandoffDependencies {
  getDirectory(target: CanvasMediaTarget): string
  getWorkflow(target: CanvasMediaTarget, runId: string): CanvasWorkflowRun
  getRunOrigin(projectId: string, runId: string): MediaRunOrigin
  getRunSourceRef?(projectId: string, runId: string): MediaRunSourceReference
  runWorkspaceWrite<T>(projectId: string, effect: () => T): T
}

/** 严格字段检查让恢复不会接受新增执行权限。 */
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && Object.keys(value).every((key) => fields.includes(key))
}

/** 业务 ID 与哈希只用于定位受管记录，不允许路径片段。 */
function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
}

/** 目标身份按固定字段顺序比较，不受调用方对象插入顺序影响。 */
function targetIdentity(target: CanvasMediaTarget): string {
  return JSON.stringify([target.projectId, target.canvasId, target.nodeId, target.mediaModuleId, target.mediaKind])
}

/** 交接来源兼容旧 profile 字段，新记录可直接指向项目草稿 revision。 */
function sourceReference(value: unknown): MediaRunSourceReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CANVAS_MEDIA_HANDOFF_INVALID')
  const source = value as Record<string, unknown>
  if (exact(source, ['kind', 'profileId', 'profileRevision']) && source.kind === 'profile-version'
    && isId(source.profileId) && Number.isSafeInteger(source.profileRevision) && Number(source.profileRevision) >= 1) {
    return { kind: 'profile-version', profileId: source.profileId, profileRevision: Number(source.profileRevision) }
  }
  if (exact(source, ['kind', 'workflowId', 'workflowRevision', 'connectionId', 'mediaKind'])
    && source.kind === 'project-draft-revision' && isId(source.workflowId) && isId(source.connectionId)
    && Number.isSafeInteger(source.workflowRevision) && Number(source.workflowRevision) >= 1
    && (source.mediaKind === 'image' || source.mediaKind === 'audio' || source.mediaKind === 'video')) {
    return { kind: 'project-draft-revision', workflowId: source.workflowId,
      workflowRevision: Number(source.workflowRevision), connectionId: source.connectionId, mediaKind: source.mediaKind }
  }
  throw new Error('CANVAS_MEDIA_HANDOFF_INVALID')
}

/** 严格解析交接记录，inputs 只包含 resolver 固化的绑定及 hash。 */
function parseHandoff(value: unknown): CanvasMediaPreparedHandoff {
  const legacy = !!value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'sourceRef')
  if (!exact(value, legacy
    ? ['schemaVersion', 'target', 'workflowRunId', 'parentSessionId', 'preparedRunId', 'preparedActor', 'configRevision', 'profileId', 'profileRevision', 'inputBindings']
    : ['schemaVersion', 'target', 'workflowRunId', 'parentSessionId', 'preparedRunId', 'preparedActor', 'configRevision', 'sourceRef', 'inputBindings'])
    || value.schemaVersion !== 1 || typeof value.workflowRunId !== 'string' || !/^[a-f0-9]{48}$/.test(value.workflowRunId)
    || !isId(value.parentSessionId)
    || typeof value.preparedRunId !== 'string' || !/^[a-f0-9]{48}$/.test(value.preparedRunId)
    || (legacy && (!isId(value.profileId) || !Number.isSafeInteger(value.profileRevision) || Number(value.profileRevision) < 1))
    || !Number.isSafeInteger(value.configRevision) || Number(value.configRevision) < 0
    || !exact(value.preparedActor, ['sessionId', 'runStartedAt', 'mode', 'canvasId', 'nodeId'])
    || value.preparedActor.mode !== 'parent-orchestrated' || !isId(value.preparedActor.sessionId)
    || !isId(value.preparedActor.canvasId) || !isId(value.preparedActor.nodeId)
    || !Number.isSafeInteger(value.preparedActor.runStartedAt) || Number(value.preparedActor.runStartedAt) < 1
    || !Array.isArray(value.inputBindings) || value.inputBindings.length > 128) throw new Error('CANVAS_MEDIA_HANDOFF_INVALID')
  const target = parseCanvasMediaTarget(value.target)
  const inputBindings = value.inputBindings.map((raw): CanvasWorkflowRunInputBinding => {
    if (!exact(raw, ['targetInputKey', 'requiredKind', 'sourceNodeId', 'sourceOutputKey', 'sourceArtifactHash', 'resolvedValueHash'])
      || typeof raw.targetInputKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(raw.targetInputKey)
      || !['text', 'number', 'boolean', 'image', 'audio', 'video'].includes(String(raw.requiredKind))
      || (raw.sourceNodeId !== null && !isId(raw.sourceNodeId))
      || (raw.sourceOutputKey !== null && (typeof raw.sourceOutputKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(raw.sourceOutputKey)))
      || (raw.sourceArtifactHash !== null && (typeof raw.sourceArtifactHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sourceArtifactHash)))
      || typeof raw.resolvedValueHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.resolvedValueHash)) throw new Error('CANVAS_MEDIA_HANDOFF_INVALID')
    return { targetInputKey: raw.targetInputKey, requiredKind: raw.requiredKind as CanvasWorkflowRunInputBinding['requiredKind'],
      sourceNodeId: raw.sourceNodeId, sourceOutputKey: raw.sourceOutputKey, sourceArtifactHash: raw.sourceArtifactHash, resolvedValueHash: raw.resolvedValueHash }
  })
  if (new Set(inputBindings.map((binding) => binding.targetInputKey)).size !== inputBindings.length
    || target.canvasId !== value.preparedActor.canvasId) throw new Error('CANVAS_MEDIA_HANDOFF_INVALID')
  const sourceRef = legacy
    ? { kind: 'profile-version' as const, profileId: value.profileId as string, profileRevision: Number(value.profileRevision) }
    : sourceReference(value.sourceRef)
  return { schemaVersion: 1, target, workflowRunId: value.workflowRunId, parentSessionId: value.parentSessionId, preparedRunId: value.preparedRunId,
    preparedActor: { sessionId: value.preparedActor.sessionId, runStartedAt: Number(value.preparedActor.runStartedAt), mode: 'parent-orchestrated',
      canvasId: value.preparedActor.canvasId, nodeId: value.preparedActor.nodeId },
    configRevision: Number(value.configRevision), sourceRef, inputBindings }
}

/** 独立交接 journal 避免子工具与父调度同时改写同一个 workflow CAS 文件。 */
export function createCanvasMediaHandoffStore(dependencies: CanvasMediaHandoffDependencies): {
  record(input: CanvasMediaPreparedHandoff): CanvasMediaPreparedHandoff
  get(target: CanvasMediaTarget, workflowRunId: string): CanvasMediaPreparedHandoff | null
} {
  /** 目标散列只包含固定身份；每个工作流最多为原计划中的媒体节点创建记录。 */
  const pathFor = (target: CanvasMediaTarget, workflowRunId: string): string => {
    if (!/^[a-f0-9]{48}$/.test(workflowRunId)) throw new Error('CANVAS_MEDIA_HANDOFF_INVALID')
    const id = createHash('sha256').update(JSON.stringify([workflowRunId, targetIdentity(target)])).digest('hex')
    return join(dependencies.getDirectory(target), `media-handoff-${id}.json`)
  }
  return {
    record: (input) => dependencies.runWorkspaceWrite(input.target.projectId, () => {
      const handoff = parseHandoff(input)
      const workflow = dependencies.getWorkflow(handoff.target, handoff.workflowRunId)
      const child = workflow.nodes.find((node) => node.nodeId === handoff.preparedActor.nodeId)
      const target = workflow.nodes.find((node) => node.nodeId === handoff.target.nodeId)
      const origin = dependencies.getRunOrigin(handoff.target.projectId, handoff.preparedRunId)
      const runSourceRef = dependencies.getRunSourceRef?.(handoff.target.projectId, handoff.preparedRunId)
      if (workflow.status !== 'running' || workflow.cancelRequestedAt !== null
        || workflow.owner.sessionId !== handoff.parentSessionId
        || workflow.owner.runStartedAt !== handoff.preparedActor.runStartedAt
        || child?.kind !== 'agent' || child.status !== 'running'
        || target?.kind !== handoff.target.mediaKind || target.execution !== null
        || !target.dependencyNodeIds.includes(child.nodeId)
        || workflow.budget.remainingMediaRuns < 1
        || JSON.stringify(origin.actor) !== JSON.stringify(handoff.preparedActor)
        || (runSourceRef && JSON.stringify(runSourceRef) !== JSON.stringify(handoff.sourceRef))
        || !origin.canvasMedia || targetIdentity(origin.canvasMedia) !== targetIdentity(handoff.target)) throw new Error('CANVAS_MEDIA_HANDOFF_SCOPE_INVALID')
      const directory = dependencies.getDirectory(handoff.target)
      if (!existsSync(directory)) ensureDirectoryDurable(directory)
      if (!lstatSync(directory).isDirectory()) throw new Error('CANVAS_MEDIA_HANDOFF_PATH_INVALID')
      const path = pathFor(handoff.target, handoff.workflowRunId)
      const release = acquireMediaFileLock(`${path}.lock`)
      try {
        if (existsSync(path)) {
          const existing = parseHandoff(readMediaJsonFile(path, 128 * 1024))
          if (JSON.stringify(existing) !== JSON.stringify(handoff)) throw new Error('CANVAS_MEDIA_HANDOFF_CONFLICT')
          return existing
        }
        writeJsonFileAtomicSecure(path, handoff)
        return handoff
      } finally { release() }
    }),
    get: (target, workflowRunId) => {
      const path = pathFor(target, workflowRunId)
      if (!existsSync(path)) return null
      const handoff = parseHandoff(readMediaJsonFile(path, 128 * 1024))
      if (targetIdentity(handoff.target) !== targetIdentity(target) || handoff.workflowRunId !== workflowRunId) throw new Error('CANVAS_MEDIA_HANDOFF_INVALID')
      return handoff
    },
  }
}
