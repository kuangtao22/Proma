import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanvasMediaTarget, CanvasWorkflowRun } from '@proma/shared'
import type { MediaRunOrigin } from '../media/media-run-service'
import { createCanvasMediaHandoffStore, type CanvasMediaPreparedHandoff } from './canvas-media-handoff-store'

const WORKFLOW_ID = 'a'.repeat(48)
const PREPARED_RUN_ID = 'b'.repeat(48)
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建包含运行中子 Agent 和直接视频下游的固定父计划。 */
function workflow(): CanvasWorkflowRun {
  return {
    schemaVersion: 1, id: WORKFLOW_ID, revision: 0, projectId: 'project-1', canvasId: 'canvas-1', operationId: 'workflow-operation',
    owner: { sessionId: 'parent-session', runStartedAt: 10 }, status: 'running', initialCanvasRevision: 1, observedCanvasRevision: 1,
    rootNodeIds: ['agent-child'], goal: '生成视频', autoResumeAfterAdoption: false, cancelRequestedAt: null, cancelledAt: null,
    budget: { maxMediaRuns: 2, consumedMediaRuns: 0, remainingMediaRuns: 2, maxDurationMs: 60_000, remainingDurationMs: 60_000, activeStartedAt: 10 },
    nodes: [
      { nodeId: 'agent-child', kind: 'agent', identityHash: '1'.repeat(64), plannedArtifactHash: null, mediaConfigRevision: null,
        inputBindings: [], dependencyNodeIds: [], status: 'running', errorCode: null,
        execution: { kind: 'agent', operationId: 'child-operation' }, completedArtifactHash: null, completedAt: null },
      { nodeId: 'video-target', kind: 'video', identityHash: '2'.repeat(64), plannedArtifactHash: null, mediaConfigRevision: null,
        inputBindings: [], dependencyNodeIds: ['agent-child'], status: 'blocked', errorCode: null,
        execution: null, completedArtifactHash: null, completedAt: null },
    ],
    createdAt: 10, updatedAt: 10,
  }
}

/** 创建不携带正文和路径的最小合法交接记录。 */
function handoff(): CanvasMediaPreparedHandoff {
  return {
    schemaVersion: 1,
    target: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'video-target', mediaModuleId: 'video-module', mediaKind: 'video' },
    workflowRunId: WORKFLOW_ID, parentSessionId: 'parent-session', preparedRunId: PREPARED_RUN_ID,
    preparedActor: { sessionId: 'child-session', runStartedAt: 10, mode: 'parent-orchestrated', canvasId: 'canvas-1', nodeId: 'agent-child' },
    configRevision: 4,
    sourceRef: { kind: 'profile-version', profileId: 'video-profile', profileRevision: 2 },
    inputBindings: [{ targetInputKey: 'prompt', requiredKind: 'text', sourceNodeId: 'agent-child', sourceOutputKey: 'agent.text',
      sourceArtifactHash: '3'.repeat(64), resolvedValueHash: '4'.repeat(64) }],
  }
}

/** 使用真实目录创建可跨实例读取的 Store。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'proma-media-handoff-'))
  temporaryRoots.push(root)
  const directory = join(root, 'handoffs')
  let currentWorkflow = workflow()
  let currentOrigin: MediaRunOrigin = { canvasMedia: handoff().target, actor: handoff().preparedActor }
  const create = () => createCanvasMediaHandoffStore({
    getDirectory: () => directory,
    getWorkflow: () => structuredClone(currentWorkflow),
    getRunOrigin: () => structuredClone(currentOrigin),
    runWorkspaceWrite: (_projectId, effect) => effect(),
  })
  return {
    root, directory, create,
    setWorkflow: (value: CanvasWorkflowRun) => { currentWorkflow = structuredClone(value) },
    setOrigin: (value: MediaRunOrigin) => { currentOrigin = structuredClone(value) },
  }
}

describe('Canvas 媒体准备交接 Store', () => {
  test('Given 合法直接下游交接 When 重放并重建 Store Then 返回同一记录且不创建第二份 journal', () => {
    const current = fixture()
    const input = handoff()
    expect(current.create().record(input)).toEqual(input)
    expect(current.create().record(input)).toEqual(input)
    expect(current.create().get(input.target, WORKFLOW_ID)).toEqual(input)
    expect(readdirSync(current.directory).filter((name) => name.endsWith('.json'))).toHaveLength(1)
  })

  test('Given 同一目标已有交接 When prepared run 或 actor 被替换 Then 拒绝扩大既有授权', () => {
    const current = fixture()
    const input = handoff()
    current.create().record(input)
    const changed = { ...input, preparedRunId: 'c'.repeat(48) }
    current.setOrigin({ canvasMedia: changed.target, actor: changed.preparedActor })
    expect(() => current.create().record(changed)).toThrow('CANVAS_MEDIA_HANDOFF_CONFLICT')
  })

  test('Given 目标不是直接下游、预算耗尽或父工作流取消 When 记录 Then 全部拒绝', () => {
    const cases: Array<(value: CanvasWorkflowRun) => void> = [
      (value) => { value.nodes[1]!.dependencyNodeIds = [] },
      (value) => { value.budget.remainingMediaRuns = 0 },
      (value) => { value.cancelRequestedAt = 11 },
    ]
    for (const mutate of cases) {
      const current = fixture()
      const changed = workflow()
      mutate(changed)
      current.setWorkflow(changed)
      expect(() => current.create().record(handoff())).toThrow('CANVAS_MEDIA_HANDOFF_SCOPE_INVALID')
    }
  })

  test('Given journal 声称的 parent session 不是工作流 owner When 记录 Then 拒绝错误父编排身份', () => {
    const current = fixture()
    expect(() => current.create().record({ ...handoff(), parentSessionId: 'other-parent' }))
      .toThrow('CANVAS_MEDIA_HANDOFF_SCOPE_INVALID')
  })

  test('Given prepared run 的 actor 或 Canvas 目标漂移 When 记录 Then 不接受伪造来源', () => {
    const current = fixture()
    current.setOrigin({ canvasMedia: handoff().target, actor: { ...handoff().preparedActor, sessionId: 'other-child' } })
    expect(() => current.create().record(handoff())).toThrow('CANVAS_MEDIA_HANDOFF_SCOPE_INVALID')

    current.setOrigin({ canvasMedia: { ...handoff().target, nodeId: 'other-target' }, actor: handoff().preparedActor })
    expect(() => current.create().record(handoff())).toThrow('CANVAS_MEDIA_HANDOFF_SCOPE_INVALID')
  })

  test('Given journal 含未知字段或替换为符号链接 When 读取 Then fail closed', () => {
    const current = fixture()
    const input = handoff()
    current.create().record(input)
    const path = join(current.directory, readdirSync(current.directory).find((name) => name.endsWith('.json'))!)
    writeFileSync(path, JSON.stringify({ ...input, unexpected: true }))
    expect(() => current.create().get(input.target, WORKFLOW_ID)).toThrow('CANVAS_MEDIA_HANDOFF_INVALID')

    rmSync(path)
    const external = join(current.root, 'external.json')
    writeFileSync(external, JSON.stringify(input))
    symlinkSync(external, path)
    expect(() => current.create().get(input.target, WORKFLOW_ID)).toThrow()
  })
})
