import { describe, expect, test } from 'bun:test'
import type { CanvasDocument, CanvasMediaAdoptedOutput, MediaRunSnapshot } from '@proma/shared'
import { createCanvasWorkflowAgentRecovery, createCanvasWorkflowMediaAdapter, findCanvasWorkflowConfirmedMediaOutput } from './canvas-workflow-runtime-adapters'
import type { CanvasWorkflowMediaAdapterDependencies } from './canvas-workflow-runtime-adapters'
import type { MediaRunOrigin } from '../media/media-run-service'

/** 所有入口共享同一个已授权画布目标和父运行身份。 */
const target = { projectId: 'project', canvasId: 'canvas', nodeId: 'video', mediaModuleId: 'module', mediaKind: 'video' as const }
const context = { projectId: 'project', sessionId: 'parent', runStartedAt: 100, permissionCeiling: 'execute' as const, explicitReferences: [] }

/** 最小远端快照只提供适配层所消费的事实。 */
function mediaFixture(phase: MediaRunSnapshot['phase'] = 'prepared') {
  let snapshot = { id: 'a'.repeat(48), projectId: 'project', revision: 1, phase, outputs: [], error: null } as unknown as MediaRunSnapshot
  let origin: MediaRunOrigin = { canvasMedia: target, actor: { sessionId: 'parent', runStartedAt: 100, mode: 'project-agent' } }
  const calls: string[] = []
  const dependencies: CanvasWorkflowMediaAdapterDependencies = {
    media: { run: async () => { calls.push('run'); return snapshot }, cancel: async () => { calls.push('cancel'); snapshot = { ...snapshot, phase: 'cancelled' }; return snapshot },
      refreshCompleted: async () => { calls.push('refresh') } },
    runs: { get: () => snapshot, getOrigin: () => origin },
    supervisor: { start: () => { calls.push('start'); return snapshot }, watch: () => { calls.push('watch') },
      wait: async () => { calls.push('wait'); return snapshot } },
    resolveInputs: async () => ({ configRevision: 1, ready: true, bindings: [] }),
    claimOptions: () => undefined,
    now: () => 200,
  }
  return { adapter: createCanvasWorkflowMediaAdapter(dependencies), dependencies, calls, setOrigin: (value: MediaRunOrigin) => { origin = value },
    reconcileInput: { ...target, context, operationId: 'operation', workflowRunId: 'b'.repeat(48), mediaRunId: snapshot.id,
      signal: new AbortController().signal, deadlineAt: 1200 } }
}

describe('Canvas 工作流媒体运行适配', () => {
  test('Given 默认首选或不同运行的输出 When 恢复等待采用的工作流 Then 只有原运行的明确采用可放行', () => {
    const video: CanvasMediaAdoptedOutput = {
      key: 'video', mediaKind: 'video', role: 'primary', order: 0, candidateId: 'candidate-1', runId: 'run-1',
      asset: { assetId: 'video-1', mediaKind: 'video', revision: 1, hash: 'a'.repeat(64) },
    }
    expect(findCanvasWorkflowConfirmedMediaOutput([{ ...video, selectionOrigin: 'initial' }], 'run-1', 'video')).toBeNull()
    expect(findCanvasWorkflowConfirmedMediaOutput([video], 'run-2', 'video')).toBeNull()
    expect(findCanvasWorkflowConfirmedMediaOutput([video], 'run-1', 'audio')).toBeNull()
    expect(findCanvasWorkflowConfirmedMediaOutput([video], 'run-1', 'video')).toEqual(video)
  })

  test('Given 父 deadline 中止 When 恢复远端任务 Then 保留远端任务且不请求取消', async () => {
    const fixture = mediaFixture('running')
    const controller = new AbortController()
    controller.abort('deadline')
    expect(await fixture.adapter.reconcile!({ ...fixture.reconcileInput, signal: controller.signal })).toMatchObject({ status: 'running', mediaRunId: 'a'.repeat(48) })
    expect(fixture.calls).toEqual([])
  })
  test('Given 用户显式取消 When 恢复远端任务 Then 请求精确取消', async () => {
    const fixture = mediaFixture('running')
    const controller = new AbortController()
    controller.abort('cancel')
    expect(await fixture.adapter.reconcile!({ ...fixture.reconcileInput, signal: controller.signal })).toMatchObject({ status: 'cancelled' })
    expect(fixture.calls).toEqual(['cancel'])
  })
  test('Given 新准备的远端任务 When 首次运行 Then 立即返回原 ID 供 journal 保存', async () => {
    const fixture = mediaFixture()
    const result = await fixture.adapter.run({ ...fixture.reconcileInput, expectedConfigRevision: 1, resolvedValues: {}, expectedInputHashes: {} })
    expect(result).toMatchObject({ status: 'running', mediaRunId: 'a'.repeat(48) })
    expect(fixture.calls).toEqual(['run'])
  })
  test('Given 下载失败 When 恢复 Then 监督原运行且不重新提交', async () => {
    const fixture = mediaFixture('collection-failed')
    expect(await fixture.adapter.reconcile!(fixture.reconcileInput)).toMatchObject({ status: 'running', mediaRunId: 'a'.repeat(48) })
    expect(fixture.calls).toEqual(['watch', 'wait'])
  })
  test('Given 准备后崩溃 When 恢复 Then 启动同一准备记录', async () => {
    const fixture = mediaFixture()
    await fixture.adapter.reconcile!(fixture.reconcileInput)
    expect(fixture.calls).toEqual(['start', 'wait'])
  })
  test('Given 另一节点或主体的任务 When 恢复 Then 在任何监督调用前拒绝', async () => {
    const fixture = mediaFixture()
    fixture.setOrigin({ canvasMedia: { ...target, nodeId: 'other' }, actor: { sessionId: 'parent', runStartedAt: 100, mode: 'project-agent' } })
    await expect(fixture.adapter.reconcile!(fixture.reconcileInput)).rejects.toThrow('CANVAS_MEDIA_RUN_OWNER_INVALID')
    expect(fixture.calls).toEqual([])
  })
  test('Given 已收齐的产物 When 恢复 Then 更新候选并等待采用', async () => {
    const fixture = mediaFixture('succeeded')
    expect(await fixture.adapter.reconcile!(fixture.reconcileInput)).toMatchObject({ status: 'waiting-adoption' })
    expect(fixture.calls).toEqual(['watch', 'wait', 'refresh'])
  })
})

describe('Canvas 工作流 Agent 恢复证明', () => {
  test('Given 原消息锚点对应已提交指针 When 恢复 Then 接续该正式输出', async () => {
    const pointer = { messageUuid: 'assistant', contentSha256: 'a'.repeat(64), completedAt: 200 }
    const document = { revision: 4, nodes: [{ id: 'agent', kind: 'agent', agentSessionId: 'child', outputPointer: pointer }] } as unknown as CanvasDocument
    const recover = createCanvasWorkflowAgentRecovery({ load: () => document, isBusy: () => false,
      outputs: { resolveCompletedOutput: (input) => { expect(input.userMessageUuid).toBe('original'); return { pointer, content: '正文', runGeneration: 1 } } } })
    expect(await recover({ projectId: 'project', canvasId: 'canvas', nodeId: 'agent', agentSessionId: 'child', operationId: 'operation', expectedUserMessageUuid: 'original', expectedStartedAt: 100 }))
      .toMatchObject({ status: 'completed', output: { pointer, revision: 4 } })
  })
  test('Given 当前指针来自其他轮次 When 恢复 Then 不把它当成原步骤完成', async () => {
    const pointer = { messageUuid: 'later', contentSha256: 'a'.repeat(64), completedAt: 200 }
    const document = { revision: 4, nodes: [{ id: 'agent', kind: 'agent', agentSessionId: 'child', outputPointer: pointer }] } as unknown as CanvasDocument
    const recover = createCanvasWorkflowAgentRecovery({ load: () => document, isBusy: () => false,
      outputs: { resolveCompletedOutput: () => ({ pointer: { ...pointer, messageUuid: 'original' }, content: '正文', runGeneration: 1 }) } })
    expect(await recover({ projectId: 'project', canvasId: 'canvas', nodeId: 'agent', agentSessionId: 'child', operationId: 'operation', expectedUserMessageUuid: 'original', expectedStartedAt: 100 }))
      .toEqual({ status: 'missing' })
  })
})
