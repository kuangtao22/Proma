import { describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Value } from 'typebox/value'
import { validateToolArguments } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentCanvasBinding, CanvasDocument, CanvasImageCandidateBatch, CanvasMutation, CanvasNodeReference, CanvasRunNodesBatchSummary, CanvasSessionMeta, DesignJobRecord } from '@proma/shared'
import { createEmptyCanvasDocument } from '@proma/shared'
import {
  CANVAS_TOOL_NAMES,
  createCanvasToolRun,
  filterCanvasAgentToolsForMode,
  type CanvasToolProviderDependencies,
  type CanvasToolRunContext,
} from './canvas-tool-provider'
import type { CanvasOperationToolHandlers } from './canvas-operation-tools'
import { createCanvasAgentReviewTracker, resolveCanvasAgentReviewContext } from './canvas-agent-review'

const target = { projectId: 'project-1', canvasId: 'canvas-1' }
const reference: CanvasNodeReference = { ...target, nodeId: 'doc-1', nodeType: 'document', nodeRevision: 3, title: '需求' }

test('Given 专业节点执行失败 When 父编排接收回执 Then 包含实际节点诊断和只读恢复动作', async () => {
  const fixture = createFixture()
  fixture.dependencies.agentExecution.execute = async () => ({ status: 'errored', failure: {
    code: 'CANVAS_AGENT_RUN_FAILED', stage: 'execution', reasonCode: 'connection', message: '连接中断', recovery: 'inspect-node',
  } })
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  const result = await executeTool(run.piCustomTools, 'canvas_run_agent', {
    canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3, instruction: '检查本任务',
  })
  expect(result.details).toMatchObject({ nodeId: 'agent-1', nodeTitle: expect.any(String), status: 'errored',
    failure: { code: 'CANVAS_AGENT_RUN_FAILED', stage: 'execution', recovery: 'inspect-node' },
    nextAction: { tool: 'canvas_read', canvasId: 'canvas-1', nodeIds: ['agent-1'] },
  })
  expect(fixture.runInputs).toEqual([])
})

test('Given 专业节点模型不可用 When 准备运行 Then 返回原节点配置诊断并保留撤权硬边界', async () => {
  const fixture = createFixture()
  fixture.dependencies.agentExecution.execute = async () => { throw new Error('CANVAS_AGENT_MODEL_UNAVAILABLE: 当前模型不可用') }
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  const input = { canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3, instruction: '检查' }
  expect((await executeTool(run.piCustomTools, 'canvas_run_agent', input)).details).toMatchObject({
    nodeId: 'agent-1', status: 'errored', failure: { stage: 'preparation', reasonCode: 'model-unavailable', recovery: 'inspect-model' },
    nextAction: { tool: 'canvas_read', nodeIds: ['agent-1'] },
  })
  fixture.dependencies.agentExecution.execute = async () => { throw new Error('CANVAS_ACCESS_DENIED') }
  await expect(executeTool(run.piCustomTools, 'canvas_run_agent', input)).rejects.toThrow('CANVAS_ACCESS_DENIED')
  expect(fixture.runInputs).toEqual([])
})

for (const entry of ['nodes', 'workflow', 'resume'] as const) {
  test(`Given 新候选检查合同 When 经${entry}真实创建并检查 Then 可交付而无需采用`, async () => {
    /** 三种执行入口共用同一 Host 身份登记边界。 */
    const fixture = createFixture()
    const jobId = 'new-candidate'
    fixture.dependencies.images.listVersions = async () => [{ jobId, assetId: 'new-asset', createdAt: 5 }]
    const originalRun = fixture.dependencies.imageRuns.run
    fixture.dependencies.imageRuns.run = async (context, ...args) => {
      context.onImageJobsCreated?.('canvas-1', [{ nodeId: 'image-1', jobId }])
      return originalRun(context, ...args)
    }
    const originalWorkflow = fixture.dependencies.workflowExecution.execute
    fixture.dependencies.workflowExecution.execute = async (context, ...args) => {
      context.onImageJobsCreated?.('canvas-1', [{ nodeId: 'image-1', jobId }])
      return originalWorkflow(context, ...args)
    }
    fixture.dependencies.operations = { resumeWorkflow: async (_input, execution) => {
      execution.context.onImageJobsCreated?.('canvas-1', [{ nodeId: 'image-1', jobId }])
      return { status: 'waiting-review' }
    } }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    await executeTool(run.piCustomTools, 'canvas_task', { action: 'start', canvasId: 'canvas-1', requirements: [
      { id: 'candidate', description: '生成并检查，不要求采用', nodeKind: 'image', nodeId: 'image-1', change: 'updated', validation: 'inspection' },
    ] })
    if (entry === 'nodes') await executeTool(run.piCustomTools, 'canvas_run_nodes', { canvasId: 'canvas-1', nodeIds: ['image-1'] })
    else if (entry === 'workflow') await executeTool(run.piCustomTools, 'canvas_run_workflow', {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['agent-1'], goal: '生成候选', maxImageRuns: 1,
    })
    else await executeTool(run.piCustomTools, 'canvas_resume_workflow', { canvasId: 'canvas-1', runId: 'workflow-1', intent: 'explicit' })
    const inspected = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1'], versions: [{ nodeId: 'image-1', jobId }], expectedRevision: 3,
    })
    const proof = (inspected.details as { inspections: Array<{ evidenceId: string }> }).inspections[0]!
    expect((await executeTool(run.piCustomTools, 'canvas_task', {
      action: 'complete', submissions: [{ id: 'candidate', evidenceId: proof.evidenceId }],
    })).details).toMatchObject({ phase: 'completed' })
    expect(fixture.imageSaveInputs).toEqual([])
    expect(await run.evaluateCompletion?.(new AbortController().signal)).toEqual({ action: 'complete' })
  })
}

test('Given 合同之前启动的图片延迟创建 When 后来登记合同并检查 Then 不能追认旧调用或历史候选', async () => {
  const fixture = createFixture()
  let releaseCreation = (): void => undefined
  const pendingCreation = new Promise<void>(resolve => { releaseCreation = resolve })
  const originalRun = fixture.dependencies.imageRuns.run
  fixture.dependencies.imageRuns.run = async (context, ...args) => {
    await pendingCreation
    context.onImageJobsCreated?.('canvas-1', [{ nodeId: 'image-1', jobId: 'old-pending' }])
    return originalRun(context, ...args)
  }
  fixture.dependencies.images.listVersions = async () => [{ jobId: 'old-pending', assetId: 'old-asset', createdAt: 10 }]
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  const generating = executeTool(run.piCustomTools, 'canvas_run_nodes', { canvasId: 'canvas-1', nodeIds: ['image-1'] })
  await executeTool(run.piCustomTools, 'canvas_task', { action: 'start', canvasId: 'canvas-1', requirements: [
    { id: 'candidate', description: '本轮新生成并检查', nodeKind: 'image', nodeId: 'image-1', change: 'updated', validation: 'inspection' },
  ] })
  releaseCreation()
  await generating
  const inspected = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
    canvasId: 'canvas-1', nodeIds: ['image-1'], versions: [{ nodeId: 'image-1', jobId: 'old-pending' }], expectedRevision: 3,
  })
  const proof = (inspected.details as { inspections: Array<{ evidenceId: string }> }).inspections[0]!
  await expect(executeTool(run.piCustomTools, 'canvas_task', {
    action: 'complete', submissions: [{ id: 'candidate', evidenceId: proof.evidenceId }],
  })).rejects.toThrow('CANVAS_TASK_CANDIDATE_NOT_GENERATED')
})

test('Given 导演明确审核范围 When 读取上下文和实际节点 Then 只在真实读取后登记覆盖且不启动媒体', async () => {
  /** 复用真实Provider读取链，枚举或获取上下文本身不得增加覆盖。 */
  const fixture = createFixture({ documentContent: '脚本' })
  const document = fixture.dependencies.documents.load(target).document
  const reviewContext = resolveCanvasAgentReviewContext(document, 'agent-1', { mode: 'nodes', nodeIds: ['doc-1'] })
  const run = createCanvasToolRun(fixture.dependencies, { ...fixture.context,
    canvasAgentTarget: { ...target, nodeId: 'agent-1' }, canvasAgentMode: 'parent-orchestrated', reviewContext,
  })
  expect((await executeTool(run.piCustomTools, 'canvas_get_context', {})).details).toMatchObject({
    review: { mode: 'nodes', nodeIds: ['doc-1'], coverage: { readNodes: 0, unreadNodes: 1 } },
  })
  await executeTool(run.piCustomTools, 'canvas_list_nodes', { canvasId: 'canvas-1', expectedRevision: 3 })
  expect(run.getReviewCoverage?.()).toMatchObject({ readNodes: 0 })
  await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['doc-1'], expectedRevision: 3, includeNeighbors: true })
  expect(run.getReviewCoverage?.()).toMatchObject({ readNodes: 1, unreadNodes: 0, qualityVerdict: 'not-assessed' })
  expect(fixture.runInputs).toEqual([])
})

test('Given 导演审核有提示词的图片 When 真实读取完整正文及截断正文 Then 覆盖按实际送达内容更新', async () => {
  /** Provider 在最终预算分配后将图片提示词回填配置，正文不重复携带同一字符串。 */
  const fixture = createFixture()
  /** 可变化的真实模块输入，用于验证完整读取之后仍识别新的正文裁剪。 */
  let prompt = '首帧保留空卡槽，卡片与卡槽的长边至少保留20%总余量。'
  /** 保留原模块合同，仅更换本次读取的提示词。 */
  const loadImage = fixture.dependencies.images.load
  fixture.dependencies.images.load = async (...args) => {
    const snapshot = await loadImage(...args)
    return { ...snapshot, config: { ...snapshot.config, prompt } }
  }
  /** 只审核目标图片，邻接节点用于补齐真实关系。 */
  const reviewContext = resolveCanvasAgentReviewContext(fixture.dependencies.documents.load(target).document,
    'agent-1', { mode: 'nodes', nodeIds: ['image-1'] })
  const run = createCanvasToolRun(fixture.dependencies, { ...fixture.context,
    canvasAgentTarget: { ...target, nodeId: 'agent-1' }, canvasAgentMode: 'parent-orchestrated', reviewContext,
  })
  const input = { canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3, includeNeighbors: true }
  const result = await executeTool(run.piCustomTools, 'canvas_read', input)
  expect(result.details).toMatchObject({ nodes: expect.arrayContaining([
    expect.objectContaining({ node: expect.objectContaining({ id: 'image-1' }), content: '',
      contentLength: prompt.length, artifact: expect.objectContaining({ config: expect.objectContaining({ prompt }) }) }),
  ]) })
  expect(run.getReviewCoverage?.()).toMatchObject({ readNodes: 1, incompleteNodes: 0, complete: true, qualityVerdict: 'not-assessed' })
  prompt = '精确约束'.repeat(20_000)
  await executeTool(run.piCustomTools, 'canvas_read', input)
  expect(run.getReviewCoverage?.()).toMatchObject({ readNodes: 0, incompleteNodes: 1, complete: false })
  expect(fixture.runInputs).toEqual([])
})

test('Given 导演读到被预算截断的正文 When 返回结果 Then 覆盖仍显示不完整', async () => {
  /** 单节点超预算正文不能仅凭节点ID算作已检查。 */
  const fixture = createFixture({ documentContent: 'A'.repeat(50_000) })
  const reviewContext = resolveCanvasAgentReviewContext(fixture.dependencies.documents.load(target).document,
    'agent-1', { mode: 'nodes', nodeIds: ['doc-1'] })
  const run = createCanvasToolRun(fixture.dependencies, { ...fixture.context,
    canvasAgentTarget: { ...target, nodeId: 'agent-1' }, canvasAgentMode: 'parent-orchestrated', reviewContext,
  })
  await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['doc-1'], expectedRevision: 3 })
  expect(run.getReviewCoverage?.()).toMatchObject({ readNodes: 0, incompleteNodes: 1, complete: false })
})

test('Given 父Agent选择导演范围和前置布局 When 运行 Then 只移动导演并传递更新后的版本及覆盖', async () => {
  /** 调用前验证公开schema，防止新增字段仅实现于内部却不可用。 */
  const fixture = createFixture()
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  const tool = run.piCustomTools.find(item => item.name === 'canvas_run_agent')!
  const args = { canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3, instruction: '完整检查视频方案',
    reviewScope: { mode: 'canvas' }, positionBeforeNodeIds: ['image-1'] }
  expect(() => validateToolArguments(tool, { type: 'toolCall', id: 'review-1', name: tool.name, arguments: args })).not.toThrow()
  const coverage = createCanvasAgentReviewTracker(resolveCanvasAgentReviewContext(fixture.dependencies.documents.load(target).document,
    'agent-1', { mode: 'canvas' })).status()
  const execute = fixture.dependencies.agentExecution.execute
  fixture.dependencies.agentExecution.execute = async input => ({ ...await execute(input), reviewCoverage: coverage })
  const result = await executeTool(run.piCustomTools, 'canvas_run_agent', args)
  expect(fixture.batchInputs).toHaveLength(1)
  expect(fixture.batchInputs[0]!.operations).toEqual([{ type: 'move-nodes', positions: [{ nodeId: 'agent-1', position: expect.any(Object) }] }])
  expect(fixture.agentExecutionInputs[0]).toMatchObject({ expectedGraphRevision: 4, reviewScope: { mode: 'canvas' } })
  expect(result.details).toMatchObject({ reviewCoverage: coverage })
  expect(fixture.runInputs).toEqual([])
})

test('Given 导演布局发生版本竞争 When 运行 Then 不自动换基线重试或启动导演', async () => {
  /** 位置写入同样遵守原CAS边界，避免覆盖用户刚调整的布局。 */
  const fixture = createFixture({ conflictAlways: true })
  await expect(executeTool(createCanvasToolRun(fixture.dependencies, fixture.context).piCustomTools, 'canvas_run_agent', {
    canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3, instruction: '检查',
    reviewScope: { mode: 'canvas' }, positionBeforeNodeIds: ['image-1'],
  })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
  expect(fixture.batchInputs).toHaveLength(1)
  expect(fixture.agentExecutionInputs).toEqual([])
})

test('Given 非法审核范围 When 同时请求前置布局 Then 写入和运行之前拒绝', async () => {
  /** 布局不能先成功，再发现审核目标根本不存在。 */
  const fixture = createFixture()
  await expect(executeTool(createCanvasToolRun(fixture.dependencies, fixture.context).piCustomTools, 'canvas_run_agent', {
    canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3, instruction: '检查',
    reviewScope: { mode: 'nodes', nodeIds: ['missing'] }, positionBeforeNodeIds: ['image-1'],
  })).rejects.toThrow('CANVAS_REVIEW_NODE_NOT_FOUND')
  expect(fixture.batchInputs).toEqual([])
  expect(fixture.agentExecutionInputs).toEqual([])
})

test('Given 未加载专业 Skill 的画布运行 When 创建工具上下文 Then 仍提供用途判断与评审边界且不自动执行', () => {
  /** 直接检查实际注入结果，兼顾主编排和固定分支，避免默认 Skill 成为唯一入口。 */
  const fixture = createFixture()
  const load = spyOn(fixture.dependencies.documents, 'load')
  for (const context of [fixture.context, { ...fixture.context, permissionCeiling: 'plan' as const }, { ...fixture.context,
    canvasAgentTarget: { ...target, nodeId: 'agent-1' }, canvasAgentMode: 'parent-orchestrated' as const,
  }]) {
    /** 创建工具只装配有界指引；用途判断本身不应触发扫图或启动 Agent。 */
    const run = createCanvasToolRun(fixture.dependencies, context)
    for (const rule of ['制作模式', '生成模式', '导演', '阻塞问题', '改进建议',
      '只读', 'canvas_run_agent', '实际末帧', '评审通过不等于生成授权']) {
      expect(run.systemPromptAppend).toContain(rule)
    }
    expect(run.systemPromptAppend).toContain('只评审时不创建或运行导演；已有当前有效方案时直接读取评审，不重跑导演')
    expect(run.systemPromptAppend).toContain('单项任务无需额外创建规划和评审文档')
    expect(run.systemPromptAppend).toContain('创建或运行导演还必须符合本轮工具能力；permissionCeiling=plan 时只读取现有方案并给出规划建议')
  }
  expect(load).not.toHaveBeenCalled()
})

test('Given Canvas 正文交付 When 只声明完成未读取 Then 拒绝，读取真实版本后可完成', async () => {
  /** 真实 Provider 与可观察存储夹具。 */
  const fixture = createFixture()
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  await executeTool(run.piCustomTools, 'canvas_task', { action: 'start', canvasId: 'canvas-1', requirements: [
    { id: 'report', description: '需求正文', nodeId: 'doc-1', nodeKind: 'document', validation: 'content' },
  ] })
  await expect(executeTool(run.piCustomTools, 'canvas_task', { action: 'complete', submissions: [{ id: 'report', evidenceId: 'invented' }] })).rejects.toThrow('CANVAS_TASK_EVIDENCE_REQUIRED')
  const read = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['doc-1'] })
  const details = read.details as { nodes: Array<{ evidence: Array<{ evidenceId: string; validation: string }> }> }
  const proof = details.nodes[0]!.evidence.find(item => item.validation === 'content')!
  const completed = await executeTool(run.piCustomTools, 'canvas_task', { action: 'complete', submissions: [{ id: 'report', evidenceId: proof.evidenceId }] })
  expect(completed.details).toMatchObject({ phase: 'completed' })
  expect(await run.evaluateCompletion?.(new AbortController().signal)).toEqual({ action: 'complete' })
})

test('Given 普通项目 Agent 未登记任务 When 模型结束 Then 保留原完成路径且不读图', async () => {
  const fixture = createFixture()
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  const load = spyOn(fixture.dependencies.documents, 'load')
  expect(await run.evaluateCompletion?.(new AbortController().signal)).toEqual({ action: 'complete' })
  expect(load).not.toHaveBeenCalled()
})

test('Given 父编排 Canvas Agent When 没有交付声明 Then 触发通用任务续行而非视为完成', async () => {
  const fixture = createFixture()
  const run = createCanvasToolRun(fixture.dependencies, { ...fixture.context,
    canvasAgentTarget: { ...target, nodeId: 'agent-1' }, canvasAgentMode: 'parent-orchestrated',
  })
  expect(run.allowedToolNames).toContain('canvas_task')
  expect(await run.evaluateCompletion?.(new AbortController().signal)).toMatchObject({ action: 'continue' })
})

test('Given 修改既有节点的任务 When 未修改或读到旧版本 Then 不允许完成，真实更新后可交付', async () => {
  /** 启动基线与最终采用版本来自同一受控存储。 */
  const fixture = createFixture()
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  const start = { action: 'start', canvasId: 'canvas-1', requirements: [
    { id: 'report', description: '更新报告', nodeId: 'doc-1', nodeKind: 'document', validation: 'content', change: 'updated' },
  ] }
  await executeTool(run.piCustomTools, 'canvas_task', start)
  const readProof = async (): Promise<string> => {
    const result = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['doc-1'] })
    return (result.details as { nodes: Array<{ evidence: Array<{ evidenceId: string }> }> }).nodes[0]!.evidence[0]!.evidenceId
  }
  const oldProof = await readProof()
  await expect(executeTool(run.piCustomTools, 'canvas_task', { action: 'complete', submissions: [{ id: 'report', evidenceId: oldProof }] })).rejects.toThrow('CANVAS_TASK_EVIDENCE_UNCHANGED')
  await executeTool(run.piCustomTools, 'canvas_update_artifact', { canvasId: 'canvas-1', nodeId: 'doc-1', baseRevision: 3,
    expectedContentRevision: 2, content: '# 新报告' })
  /** 同一 start 重放仍保留最初基线。 */
  await executeTool(run.piCustomTools, 'canvas_task', start)
  const evidenceId = await readProof()
  await executeTool(run.piCustomTools, 'canvas_task', { action: 'complete', submissions: [{ id: 'report', evidenceId }] })
  expect(await run.evaluateCompletion?.(new AbortController().signal)).toEqual({ action: 'complete' })
})

test('Given 修改目标没有可验证启动内容 When 登记任务 Then 拒绝用空身份伪造更新基线', async () => {
  /** 模拟节点元数据存在，但正文存储尚未形成正式产物。 */
  const fixture = createFixture()
  const readTextArtifact = fixture.dependencies.textArtifacts.read
  fixture.dependencies.textArtifacts.read = async input => ({ ...await readTextArtifact(input), content: '' })
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  await expect(executeTool(run.piCustomTools, 'canvas_task', { action: 'start', canvasId: 'canvas-1', requirements: [
    { id: 'report', description: '更新报告', nodeId: 'doc-1', nodeKind: 'document', validation: 'content', change: 'updated' },
  ] })).rejects.toThrow('CANVAS_TASK_BASELINE_REQUIRED')
})

test('Given 已确认的空草稿 When 填写原节点 Then 空状态可作修改基线但不可作完成证据', async () => {
  /** 正式版本零代表尚未提交正文，而非存储读取失败。 */
  const fixture = createFixture({ initialContentRevision: 0 })
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  await executeTool(run.piCustomTools, 'canvas_task', { action: 'start', canvasId: 'canvas-1', requirements: [
    { id: 'draft', description: '填好草稿', nodeId: 'doc-1', nodeKind: 'document', validation: 'content', change: 'updated' },
  ] })
  const before = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['doc-1'] })
  expect(before.details).toMatchObject({ nodes: [{ evidence: [] }] })
  await executeTool(run.piCustomTools, 'canvas_update_artifact', { canvasId: 'canvas-1', nodeId: 'doc-1', baseRevision: 3,
    expectedContentRevision: 0, content: '# 草稿完成' })
  const after = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['doc-1'] })
  const evidenceId = (after.details as { nodes: Array<{ evidence: Array<{ evidenceId: string }> }> }).nodes[0]!.evidence[0]!.evidenceId
  await executeTool(run.piCustomTools, 'canvas_task', { action: 'complete', submissions: [{ id: 'draft', evidenceId }] })
  expect(await run.evaluateCompletion?.(new AbortController().signal)).toEqual({ action: 'complete' })
})

test('Given 新建产物合同 When 复用旧输入的真实证据 Then 拒绝将输入冒充新交付', async () => {
  const fixture = createFixture()
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  await executeTool(run.piCustomTools, 'canvas_task', { action: 'start', canvasId: 'canvas-1', requirements: [
    { id: 'new-report', description: '新增独立报告', nodeKind: 'document', validation: 'content', change: 'created' },
  ] })
  const result = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['doc-1'] })
  const evidenceId = (result.details as { nodes: Array<{ evidence: Array<{ evidenceId: string }> }> }).nodes[0]!.evidence[0]!.evidenceId
  await expect(executeTool(run.piCustomTools, 'canvas_task', { action: 'complete', submissions: [{ id: 'new-report', evidenceId }] })).rejects.toThrow('CANVAS_TASK_CREATED_TARGET_EXISTS')
})

test('Given 纯文本交付已登记 When 画布解绑 Then 完成与结束检查均拒绝', async () => {
  const fixture = createFixture()
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  await executeTool(run.piCustomTools, 'canvas_task', { action: 'start', canvasId: 'canvas-1', requirements: [
    { id: 'answer', description: '分析结论', validation: 'response' },
  ] })
  spyOn(fixture.dependencies.access, 'requireLinkedCanvas').mockImplementation(() => { throw new Error('CANVAS_NOT_LINKED') })
  await expect(executeTool(run.piCustomTools, 'canvas_task', { action: 'complete', submissions: [{ id: 'answer', text: '实际结论' }] })).rejects.toThrow('CANVAS_NOT_LINKED')
  await expect(run.evaluateCompletion!(new AbortController().signal)).rejects.toThrow('CANVAS_NOT_LINKED')
})

test('Given 两项交付 When 整批复验 Then 图仅首尾读取且中途版本改变拒绝完成', async () => {
  /** 两个独立产物用于发现逐项校验混合版本的漏洞。 */
  const fixture = createFixture()
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  await executeTool(run.piCustomTools, 'canvas_task', { action: 'start', canvasId: 'canvas-1', requirements: [
    { id: 'report', description: '报告', nodeId: 'doc-1', nodeKind: 'document', validation: 'content' },
    { id: 'prototype', description: '原型', nodeId: 'web-1', nodeKind: 'webview', validation: 'content' },
  ] })
  const read = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['doc-1', 'web-1'] })
  const nodes = (read.details as { nodes: Array<{ node: { id: string }; evidence: Array<{ evidenceId: string }> }> }).nodes
  const submissions = nodes.map(entry => ({ id: entry.node.id === 'doc-1' ? 'report' : 'prototype', evidenceId: entry.evidence[0]!.evidenceId }))
  const load = spyOn(fixture.dependencies.documents, 'load')
  await executeTool(run.piCustomTools, 'canvas_task', { action: 'complete', submissions })
  expect(load).toHaveBeenCalledTimes(2)
  const initial = fixture.dependencies.documents.load(target)
  const originalRead = fixture.dependencies.textArtifacts.read
  fixture.dependencies.textArtifacts.read = async input => {
    const result = await originalRead(input)
    if (input.nodeId === 'web-1') load.mockImplementation(() => ({ ...initial, document: { ...initial.document, revision: initial.document.revision + 1 } }))
    return result
  }
  expect(await run.evaluateCompletion!(new AbortController().signal)).toMatchObject({ action: 'continue' })
})

test('Given 正文超出返回预算 When 读取 Then 不为未送达正文签发交付凭据', async () => {
  const fixture = createFixture()
  const originalRead = fixture.dependencies.textArtifacts.read
  fixture.dependencies.textArtifacts.read = async input => ({ ...await originalRead(input), content: '长'.repeat(40_000) })
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  const result = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['doc-1'] })
  expect(JSON.stringify(result.details).length).toBeLessThanOrEqual(32_768)
  expect(result.details).toMatchObject({ truncated: true, nodes: [{ evidence: [] }] })
})

test('Given 配置 revision 独立于画布 When 验收其它节点期间配置改变 Then 拒绝过期配置证据', async () => {
  /** 用独立配置版本模拟 UI 在两项读取之间保存配置。 */
  const fixture = createFixture()
  let configRevision = 4
  const loadConfig = fixture.dependencies.agentConfigs.load
  fixture.dependencies.agentConfigs.load = async input => ({ ...await loadConfig(input), revision: configRevision })
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  await executeTool(run.piCustomTools, 'canvas_task', { action: 'start', canvasId: 'canvas-1', requirements: [
    { id: 'config', description: 'Agent 配置', nodeId: 'agent-1', nodeKind: 'agent', validation: 'configuration' },
    { id: 'report', description: '报告', nodeId: 'doc-1', nodeKind: 'document', validation: 'content' },
  ] })
  const read = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['agent-1', 'doc-1'] })
  const nodes = (read.details as { nodes: Array<{ node: { id: string }; evidence: Array<{ evidenceId: string }> }> }).nodes
  const readContent = fixture.dependencies.textArtifacts.read
  fixture.dependencies.textArtifacts.read = async input => {
    const result = await readContent(input)
    configRevision = 5
    return result
  }
  const submissions = nodes.map(entry => ({ id: entry.node.id === 'agent-1' ? 'config' : 'report', evidenceId: entry.evidence[0]!.evidenceId }))
  await expect(executeTool(run.piCustomTools, 'canvas_task', { action: 'complete', submissions })).rejects.toThrow('CANVAS_TASK_EVIDENCE_STALE')
})

test('Given 画布节点动作 When plan 读取 Then 返回真实查询工具且不宣称可写', async () => {
  const fixture = createFixture()
  const run = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
  const result = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['doc-1'] })
  const actions = (result.details as { nodes: Array<{ availableActions: Array<{ capability: string; toolNames: string[] }> }> }).nodes[0]!.availableActions
  expect(actions).toEqual([{ capability: 'read', toolNames: ['canvas_read'] }])
  expect(run.readOnlyToolNames).toEqual(expect.arrayContaining(['canvas_task', 'canvas_read', 'canvas_inspect_images']))
  expect(run.readOnlyToolNames).not.toContain('canvas_run_nodes')
  expect(run.readOnlyToolNames).not.toContain('canvas_update_artifact')
})

test('Given 图片只完成元数据读取 When 正式检查真实图像 Then 才返回 inspection 证据', async () => {
  const fixture = createFixture()
  const run = createCanvasToolRun(fixture.dependencies, fixture.context)
  const read = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['image-1'] })
  expect((read.details as { nodes: Array<{ evidence: Array<{ validation: string }> }> }).nodes[0]!.evidence.map(proof => proof.validation)).toEqual(['configuration'])
  const inspection = await executeTool(run.piCustomTools, 'canvas_inspect_images', { canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3 })
  const summary = (inspection.details as { inspections: Array<{ evidenceId: string; adoptedEvidenceId: string }> }).inspections[0]!
  expect(summary.evidenceId).toHaveLength(64)
  expect(summary.adoptedEvidenceId).toHaveLength(64)
  expect(summary.evidenceId).not.toBe(summary.adoptedEvidenceId)
})

/** 调用指定 Pi custom tool。 */
async function executeTool(
  tools: ToolDefinition[],
  name: string,
  args: Record<string, unknown>,
  toolCallId = 'tool-call-1',
  signal?: AbortSignal,
) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool.execute(toolCallId, args as never, signal as never, undefined as never, undefined as never)
}

/** 装配十五个无副作用操作处理器，用于验证运行模式的完整正向清单。 */
function createAllOperationHandlers(): CanvasOperationToolHandlers {
  return {
    getTask: async () => ({ ok: true }),
    cancelTask: async () => ({ ok: true }),
    retryTask: async () => ({ ok: true }),
    listVersions: async () => ({ ok: true }),
    readVersion: async () => ({ ok: true }),
    adoptVersion: async () => ({ ok: true }),
    adoptCandidateBatch: async () => ({ ok: true }),
    exportArtifact: async () => ({ ok: true }),
    listTrash: async () => ({ ok: true }),
    restoreNode: async () => ({ ok: true }),
    rebuildAgent: async () => ({ ok: true }),
    listWorkflows: async () => ({ ok: true }),
    getWorkflow: async () => ({ ok: true }),
    resumeWorkflow: async () => ({ ok: true }),
    cancelWorkflow: async () => ({ ok: true }),
  }
}

/** 构造可观察写入、执行与全项目扫描的窄依赖。 */
function createFixture(options: {
  /** 自定义真实正文用于审核裁剪边界回归。 */
  documentContent?: string
  /** 用于验证空草稿和已有正式内容的不同启动基线。 */
  initialContentRevision?: number
  conflictOnce?: boolean
  conflictAlways?: boolean
  noDefaultCanvas?: boolean
  createCanvasError?: Error
  runBatch?: CanvasRunNodesBatchSummary
  agentOutput?: string
  agentOutputAtPointer?: string
  /** 模拟刚创建、尚未首次产生正式输出的节点。 */
  agentWithoutOutput?: boolean
  unlinkBeforeWrite?: boolean
  unlinkBeforeAgentConfigValidation?: boolean
} = {}) {
  let document: CanvasDocument = {
    ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
    nodes: [
      { id: 'agent-1', kind: 'agent', title: '策划', position: { x: -50, y: 0 }, agentSessionId: 'canvas-agent-session-1',
        ...(options.agentWithoutOutput ? {} : { outputPointer: {
          messageUuid: '33333333-3333-4333-8333-333333333333',
          contentSha256: createHash('sha256').update(options.agentOutput ?? 'Agent 正式输出').digest('hex'),
          completedAt: 1,
        } }),
      },
      { id: 'doc-1', kind: 'document', title: '需求', position: { x: 0, y: 0 }, documentId: 'content-1', contentRevision: options.initialContentRevision ?? 2 },
      { id: 'web-1', kind: 'webview', title: '原型', position: { x: 50, y: 0 }, prototypeId: 'prototype-1', contentRevision: 1, devicePreset: 'desktop' },
      { id: 'image-1', kind: 'image', title: '主视觉', position: { x: 100, y: 0 }, imageModuleId: 'image-content-1', adoptedAssetId: 'asset-1' },
    ],
    edges: [{ id: 'edge-1', sourceNodeId: 'doc-1', sourcePort: 'output', targetNodeId: 'image-1', targetPort: 'input', relation: 'reference' }],
  }
  const linkedCanvasIds = options.noDefaultCanvas ? [] : ['canvas-1', 'canvas-2']
  const createdSessions = new Map<string, CanvasSessionMeta>()
  let defaultCanvasId = options.noDefaultCanvas ? undefined : 'canvas-1'
  let lastActiveCanvasId = options.noDefaultCanvas ? undefined : 'canvas-2'
  let createCalls = 0
  let linkCalls = 0
  const batchInputs: Array<{ baseRevision: number; operations: unknown[]; sourceToolCallId: string }> = []
  const runInputs: string[][] = []
  const runToolCallIds: string[] = []
  const artifactInputs: Array<Record<string, unknown>> = []
  /** Canvas Agent 节点创建调用记录。 */
  const agentArtifactInputs: Array<Record<string, unknown>> = []
  /** 已授权本地图片导入调用记录。 */
  const importedImageInputs: Array<Record<string, unknown>> = []
  /** 文本产物更新调用记录。 */
  const textUpdateInputs: Array<Record<string, unknown>> = []
  /** 图片配置保存调用记录。 */
  const imageSaveInputs: Array<Record<string, unknown>> = []
  /** Canvas Agent 长期配置只记录允许的局部 patch。 */
  const agentConfigUpdateInputs: unknown[] = []
  /** 单节点执行只记录可信父运行身份和临时 Skills。 */
  const agentExecutionInputs: unknown[] = []
  /** 工作流执行只记录 Host 绑定后的父运行与审批参数。 */
  const workflowExecutionInputs: unknown[] = []
  /** 动态计划登记必须只消费 Host 创建结果。 */
  const successorRegistrationInputs: unknown[] = []
  /** 音视频工具调用记录用于验证所有路径委托统一 CanvasMediaService。 */
  const canvasMediaInputs: Array<{ operation: string; input: unknown }> = []
  /** 精确指针读取调用用于证明摘要不会漂移到后续运行。 */
  const agentOutputReadPointers: unknown[] = []
  /** 授权与关联调用计数用于证明工具执行时 fresh-read。 */
  let authorizeReadCalls = 0
  let requireLinkedCanvasCalls = 0
  let listCalls = 0
  let thumbnailReadCalls = 0
  /** 返回当前 fixture 的隔离关联事实。 */
  const getBinding = (): AgentCanvasBinding => ({
    projectId: target.projectId, sessionId: 'session-1', linkedCanvasIds: [...linkedCanvasIds],
    ...(defaultCanvasId ? { defaultCanvasId } : {}),
    ...(lastActiveCanvasId ? { lastActiveCanvasId } : {}), updatedAt: 1,
  })
  /** 复核测试 Canvas 是否仍属于目标项目。 */
  const requireNative = (projectId: string, canvasId: string): CanvasSessionMeta => {
    const created = createdSessions.get(canvasId)
    if (created) return created
    if (projectId !== target.projectId || !['canvas-1', 'canvas-2', 'created-canvas'].includes(canvasId)) {
      throw new Error('Canvas 会话不存在')
    }
    return { id: canvasId, projectId, title: canvasId, archived: false, createdAt: 1, updatedAt: 1 }
  }
  /** 模拟唯一 facade 的关联写入，并记录真实 mutation 次数。 */
  const link = (canvasId: string, makeDefault: boolean): AgentCanvasBinding => {
    linkCalls += 1
    if (!linkedCanvasIds.includes(canvasId)) linkedCanvasIds.push(canvasId)
    if (makeDefault) defaultCanvasId = canvasId
    lastActiveCanvasId = canvasId
    return getBinding()
  }
  const dependencies: CanvasToolProviderDependencies = {
    access: {
      authorizeRead: () => { authorizeReadCalls += 1 },
      getBinding: () => getBinding(),
      requireLinkedCanvas: (_context, canvasId) => {
        requireLinkedCanvasCalls += 1
        const binding = getBinding()
        if (!binding.linkedCanvasIds.includes(canvasId)) throw new Error('CANVAS_ACCESS_DENIED')
        requireNative(target.projectId, canvasId)
        return binding
      },
      runWrite: (_context, effect) => {
        if (options.unlinkBeforeWrite) linkedCanvasIds.splice(0)
        return effect()
      },
      createAndLink: (_context, input) => {
        createCalls += 1
        if (options.createCanvasError) throw options.createCanvasError
        const existing = createdSessions.get(input.canvasId)
        const session = existing ?? {
          id: input.canvasId, projectId: target.projectId, title: input.title ?? '新 Canvas',
          archived: false, createdAt: 1, updatedAt: 1,
        }
        if (!existing) createdSessions.set(input.canvasId, session)
        const current = getBinding()
        const alreadyLinked = current.linkedCanvasIds.includes(session.id)
        const binding = alreadyLinked && (!input.makeDefault || current.defaultCanvasId === session.id)
          ? current
          : link(session.id, input.makeDefault)
        return { session, binding }
      },
      link: (_context, canvasId, makeDefault) => {
        requireNative(target.projectId, canvasId)
        return link(canvasId, makeDefault)
      },
      unlink: (_context, canvasId) => {
        const nextCanvasIds = linkedCanvasIds.filter((id) => id !== canvasId)
        return {
          projectId: target.projectId, sessionId: 'session-1', linkedCanvasIds: nextCanvasIds,
          defaultCanvasId: 'canvas-1', lastActiveCanvasId: 'canvas-1', updatedAt: 2,
        }
      },
      setDefault: (_context, canvasId) => ({
        projectId: target.projectId, sessionId: 'session-1', linkedCanvasIds: [...linkedCanvasIds],
        defaultCanvasId: canvasId, lastActiveCanvasId: canvasId, updatedAt: 2,
      }),
    },
    documents: {
      load: () => ({ document: structuredClone(document), writable: true, nodeIssues: [] }),
      validateBatchOperations: (_target, expectedRevision, operations) => {
        if (expectedRevision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT')
        return structuredClone(operations) as CanvasMutation[]
      },
    },
    agentOutputs: {
      read: async () => {
        /** 正式输出服务在没有指针时会拒绝，测试替身不能伪造首次输出掩盖生命周期错误。 */
        if (options.agentWithoutOutput) throw new Error('CANVAS_AGENT_OUTPUT_INVALID')
        return options.agentOutput ?? 'Agent 正式输出'
      },
      readAtPointer: async (_target, pointer) => {
        agentOutputReadPointers.push(structuredClone(pointer))
        return options.agentOutputAtPointer ?? options.agentOutput ?? 'Agent 正式输出'
      },
    },
    agentConfigs: {
      load: async (input) => ({
        schemaVersion: 1 as const, ...input, revision: 4, instruction: '长期职责',
        skillNames: ['research'], channelId: 'channel-1', modelId: 'model-1', updatedAt: 1,
      }),
      update: async (input, validateAccess?: () => void) => {
        if (options.unlinkBeforeAgentConfigValidation) {
          linkedCanvasIds.splice(0)
          if (!validateAccess) throw new Error('CANVAS_AGENT_CONFIG_ACCESS_VALIDATOR_REQUIRED')
          validateAccess()
        }
        agentConfigUpdateInputs.push(structuredClone(input))
        return {
          schemaVersion: 1 as const,
          projectId: input.projectId,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          revision: input.expectedConfigRevision + 1,
          instruction: input.patch.instruction ?? '长期职责',
          skillNames: input.patch.skillNames ?? ['research'],
          channelId: input.patch.channelId === undefined ? 'channel-1' : input.patch.channelId,
          modelId: input.patch.modelId === undefined ? 'model-1' : input.patch.modelId,
          updatedAt: 2,
        }
      },
    },
    agentExecution: {
      execute: async (input) => {
        agentExecutionInputs.push(input)
        return {
          status: 'completed' as const,
          output: {
            target: input.target,
            revision: 4,
            pointer: {
              messageUuid: '33333333-3333-4333-8333-333333333333',
              contentSha256: 'a'.repeat(64),
              completedAt: 120,
            },
            downstreamNodeIds: ['doc-1', 'image-1'],
          },
        }
      },
    },
    workflowExecution: {
      execute: async (runContext, input, toolCallId, signal) => {
        workflowExecutionInputs.push({ runContext, input, toolCallId, signal })
        return {
          status: 'completed' as const,
          initialRevision: input.expectedRevision,
          finalRevision: input.expectedRevision + 1,
          nodes: input.startNodeIds.map((nodeId) => ({ nodeId, status: 'completed' as const, errorCode: null })),
          imageSummary: null,
          requiresReview: false as const,
          errorCode: null,
        }
      },
      resume: async () => { throw new Error('fixture resume unavailable') },
      cancel: async () => { throw new Error('fixture cancel unavailable') },
      get: async () => { throw new Error('fixture get unavailable') },
      list: async () => [],
      registerCreatedSuccessor: async (runContext, input) => {
        successorRegistrationInputs.push({ runContext, input })
        return { status: 'registered' as const, workflowRunId: 'workflow-1', workflowRunRevision: 2, reasonCode: null }
      },
    },
    readNodeContent: async (_target, node) => node.kind === 'document' ? 'A'.repeat(40_000) : '',
    artifacts: {
      create: async (input) => {
        artifactInputs.push(structuredClone(input) as unknown as Record<string, unknown>)
        return {
          canvasId: input.canvasId,
          nodeId: 'artifact-created',
          revision: 4,
          artifactType: input.artifactType,
          sourceToolCallId: input.source.toolCallId,
        }
      },
      createAgent: async (input) => {
        agentArtifactInputs.push(structuredClone(input) as unknown as Record<string, unknown>)
        return {
          canvasId: input.canvasId,
          nodeId: 'agent-created',
          revision: 4,
          sourceToolCallId: input.source.toolCallId,
        }
      },
    },
    importImage: async (input) => {
      importedImageInputs.push(structuredClone(input) as unknown as Record<string, unknown>)
      return {
        canvasId: input.canvasId,
        nodeId: 'image-imported',
        revision: 4,
        artifactType: 'image' as const,
        sourceToolCallId: input.source.toolCallId,
      }
    },
    textArtifacts: {
      read: async (input) => ({
        target: input,
        revision: {
          kind: input.kind, contentId: input.contentId, revision: input.contentRevision,
          parentRevision: input.contentRevision - 1, contentHash: 'a'.repeat(64),
          createdBy: { type: 'user' as const }, createdAt: 1,
        },
        content: input.kind === 'document' ? (options.documentContent ?? '# 需求正文') : '<main>旧版</main>',
      }),
      listVersions: async (input) => [1, 2].map((revision) => ({
        kind: input.kind, contentId: input.contentId, revision, parentRevision: revision - 1,
        contentHash: 'a'.repeat(64), createdBy: { type: 'user' as const }, createdAt: revision,
      })),
      update: async (input) => {
        textUpdateInputs.push(structuredClone(input) as unknown as Record<string, unknown>)
        /** 更新后的文本节点保持同一节点 ID。 */
        const node = document.nodes.find((candidate) => candidate.id === input.nodeId)!
        const nextNode = { ...node, contentRevision: input.expectedContentRevision + 1 }
        document = {
          ...document,
          revision: document.revision + 1,
          nodes: document.nodes.map((candidate) => candidate.id === node.id ? nextNode : candidate) as CanvasDocument['nodes'],
        }
        return {
          snapshot: { document: structuredClone(document), writable: true as const, nodeIssues: [] },
          artifact: {
            target: { ...input, contentRevision: input.expectedContentRevision + 1 },
            revision: {
              kind: input.kind, contentId: input.contentId,
              revision: input.expectedContentRevision + 1,
              parentRevision: input.expectedContentRevision,
              contentHash: 'b'.repeat(64), createdBy: { type: 'agent' as const, sessionId: 'session-1', toolCallId: 'tool-update-1' }, createdAt: 2,
            },
            content: input.content,
          },
        }
      },
    },
    images: {
      listVersions: async () => [],
      loadConfig: async () => ({
        schemaVersion: 2 as const, kind: 'image' as const, contentId: 'image-content-1', revision: 4,
        createdAt: 1, updatedAt: 2, prompt: '旧提示词', selectedModelProfileId: 'model-1',
        aspectRatio: '16:9' as const, imageSize: '2K' as const, contextMode: 'project' as const,
        adoptedAssetId: 'asset-1',
      }),
      load: async () => ({
        target: { ...target, nodeId: 'image-1', imageModuleId: 'image-content-1' },
        mediaLeaseId: 'lease-1',
        config: {
          schemaVersion: 2 as const, kind: 'image' as const, contentId: 'image-content-1', revision: 4,
          createdAt: 1, updatedAt: 2, prompt: '旧提示词', selectedModelProfileId: 'model-1',
          aspectRatio: '16:9' as const, imageSize: '2K' as const, contextMode: 'project' as const,
          adoptedAssetId: 'asset-1',
        },
        jobs: [], assets: [], assetBaseUrl: 'proma://asset/', thumbnailBaseUrl: 'proma://thumb/',
      }),
      save: async (input) => {
        imageSaveInputs.push(structuredClone(input) as unknown as Record<string, unknown>)
        return {
          schemaVersion: 2 as const, kind: 'image' as const, contentId: input.imageModuleId,
          revision: input.expectedConfigRevision + 1, createdAt: 1, updatedAt: 3,
          prompt: input.prompt, selectedModelProfileId: input.selectedModelProfileId,
          ...(input.mediaWorkflow ? { mediaWorkflow: structuredClone(input.mediaWorkflow) } : {}),
          aspectRatio: input.aspectRatio, imageSize: input.imageSize, contextMode: input.contextMode,
          adoptedAssetId: 'asset-1',
        }
      },
      readThumbnail: async () => {
        thumbnailReadCalls += 1
        return {
          bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwqSmQAAAABJRU5ErkJggg==', 'base64'),
          mediaType: 'image/png' as const,
        }
      },
    },
    batch: { execute: async (input) => {
      batchInputs.push({ baseRevision: input.baseRevision, operations: input.operations, sourceToolCallId: input.sourceToolCallId })
      if (options.conflictAlways || (options.conflictOnce && batchInputs.length === 1)) {
        document = { ...document, revision: 4 }
        throw new Error('CANVAS_REVISION_CONFLICT')
      }
      document = { ...document, revision: input.baseRevision + 1 }
      return { document, operationId: `operation-${batchInputs.length}` }
    } },
    imageRuns: {
      run: async (_context, _target, nodes, toolCallId) => {
        runInputs.push(nodes.map((node) => node.id))
        runToolCallIds.push(toolCallId)
        return {
          tasks: nodes.map((node) => node.kind === 'image'
            ? { nodeId: node.id, status: 'started' as const, taskId: `task-${node.id}` }
            : { nodeId: node.id, status: 'idle' as const }),
          ...(options.runBatch ? { batch: options.runBatch } : {}),
        }
      },
    },
    canvasMedia: {
      load: async (input) => {
        canvasMediaInputs.push({ operation: 'load', input: structuredClone(input) })
        return {
          target: input,
          config: {
            schemaVersion: 1 as const,
            contentId: input.mediaModuleId,
            mediaKind: input.mediaKind,
            revision: 2,
            createdAt: 1,
            updatedAt: 2,
            profile: { profileId: 'profile-1', profileRevision: 1 },
            inputs: [],
            outputs: [{ key: 'primary', mediaKind: input.mediaKind, role: 'primary' as const, order: 0 }],
            adoptedOutputs: [],
          },
          candidates: [],
          runs: [],
          assets: [],
        }
      },
      save: async (input) => {
        canvasMediaInputs.push({ operation: 'save', input: structuredClone(input) })
        return {
          schemaVersion: 1 as const,
          contentId: input.mediaModuleId,
          mediaKind: input.mediaKind,
          revision: input.expectedConfigRevision + 1,
          createdAt: 1,
          updatedAt: 3,
          profile: input.profile,
          inputs: input.inputs,
          outputs: input.outputs,
          adoptedOutputs: [],
        }
      },
      run: async (input, origin) => {
        canvasMediaInputs.push({ operation: 'run', input: structuredClone({ input, origin }) })
        return {
          id: `run-${input.nodeId}`,
          projectId: input.projectId,
          revision: 1,
          phase: 'queued' as const,
          profileId: 'profile-1',
          profileRevision: 1,
          createdAt: 1,
          updatedAt: 1,
          outputs: [],
          error: null,
          progress: { nodeId: '7', value: 1, max: 4 },
        }
      },
      attachCompletedRun: async (input, actor) => {
        canvasMediaInputs.push({ operation: 'attach', input: structuredClone({ input, actor }) })
        return {
          id: `candidate:${input.runId}`,
          operationId: 'attach-operation',
          runId: input.runId,
          sourceConfigRevision: input.expectedConfigRevision,
          profile: { profileId: 'profile-1', profileRevision: 1 },
          sourceRef: { kind: 'profile-version', profileId: 'profile-1', profileRevision: 1 },
          outputs: [{ key: 'primary', mediaKind: input.mediaKind, role: 'primary' as const, order: 0,
            asset: { assetId: 'attached-asset', revision: 1, hash: 'a'.repeat(64), mediaKind: input.mediaKind } }],
          createdAt: 3,
        }
      },
      cancel: async (input, runId) => {
        canvasMediaInputs.push({ operation: 'cancel', input: structuredClone({ input, runId }) })
        return {
          id: runId,
          projectId: input.projectId,
          revision: 2,
          phase: 'cancel-requested' as const,
          profileId: 'profile-1',
          profileRevision: 1,
          createdAt: 1,
          updatedAt: 2,
          outputs: [],
          error: null,
          progress: null,
        }
      },
      adopt: async (input) => {
        canvasMediaInputs.push({ operation: 'adopt', input: structuredClone(input) })
        return {
          schemaVersion: 1 as const,
          contentId: input.mediaModuleId,
          mediaKind: input.mediaKind,
          revision: input.expectedConfigRevision + 1,
          createdAt: 1,
          updatedAt: 3,
          profile: { profileId: 'profile-1', profileRevision: 1 },
          inputs: [],
          outputs: [{ key: 'primary', mediaKind: input.mediaKind, role: 'primary' as const, order: 0 }],
          adoptedOutputs: [],
        }
      },
    },
  }
  const context: CanvasToolRunContext = {
    projectId: target.projectId, sessionId: 'session-1', runStartedAt: 99,
    explicitReferences: [reference], permissionCeiling: 'execute',
  }
  return {
    dependencies, context, batchInputs, runInputs, runToolCallIds, artifactInputs,
    agentArtifactInputs, importedImageInputs,
    textUpdateInputs, imageSaveInputs,
    agentConfigUpdateInputs, agentExecutionInputs, workflowExecutionInputs, agentOutputReadPointers,
    successorRegistrationInputs,
    canvasMediaInputs,
    getAuthorizeReadCalls: () => authorizeReadCalls,
    getRequireLinkedCanvasCalls: () => requireLinkedCanvasCalls,
    getListCalls: () => listCalls,
    getThumbnailReadCalls: () => thumbnailReadCalls,
    getCreateCalls: () => createCalls,
    getLinkCalls: () => linkCalls,
  }
}

describe('普通 Agent Canvas Tool Provider', () => {
  test('Given 已装配任务查询 When Agent 按节点查询 Then 注入入口并绑定当前项目且返回有界结果', async () => {
    /** 生产权限与 Canvas 绑定的最小测试环境。 */
    const fixture = createFixture()
    /** 记录 Host 实际收到的输入，检查模型不能注入项目身份。 */
    const received: unknown[] = []
    /** 新增能力仅在主进程装配对应处理器后开放。 */
    const dependencies = {
      ...fixture.dependencies,
      operations: {
        getTask: async (input: unknown, execution: { validateAccess: () => void }) => {
          execution.validateAccess()
          received.push(input)
          return { status: 'failed', jobId: 'job-1', errorCode: 'IMAGE_GENERATION_FAILED' }
        },
      },
    }
    /** 本轮工具使用权威运行上下文创建。 */
    const run = createCanvasToolRun(dependencies, fixture.context)
    expect(run.allowedToolNames).toContain('canvas_get_task')
    const result = await executeTool(run.piCustomTools, 'canvas_get_task', {
      canvasId: 'canvas-1', nodeId: 'image-1', jobId: 'job-1',
    })
    expect(result.details).toMatchObject({ status: 'failed', jobId: 'job-1' })
    expect(received).toEqual([{ projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'image-1', jobId: 'job-1' }])
    await expect(executeTool(run.piCustomTools, 'canvas_get_task', {
      canvasId: 'canvas-1', nodeId: 'image-1', jobId: 'job-1', projectId: 'other',
    })).rejects.toThrow('CANVAS_OPERATION_INPUT_INVALID')
    expect(received).toHaveLength(1)
  })

  test('Given 版本采用处理器 When plan 或缺少明确意图 Then 不执行任何采用', async () => {
    const fixture = createFixture()
    /** 采用次数用于证明拒绝发生在业务副作用前。 */
    let calls = 0
    const dependencies = {
      ...fixture.dependencies,
      operations: { adoptVersion: async () => { calls += 1; return { adopted: true } } },
    }
    const input = {
      canvasId: 'canvas-1', nodeId: 'image-1', expectedCanvasRevision: 3,
      expectedVersion: 4, version: { kind: 'image', jobId: 'job-1' },
    }
    const plan = createCanvasToolRun(dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(plan.piCustomTools, 'canvas_adopt_version', {
      ...input, intent: 'explicit',
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    const execute = createCanvasToolRun(dependencies, fixture.context)
    await expect(executeTool(execute.piCustomTools, 'canvas_adopt_version', input))
      .rejects.toThrow('CANVAS_OPERATION_INPUT_INVALID')
    expect(calls).toBe(0)
  })

  test('Given 同一采用调用重复送达 When 构造操作身份 Then 使用相同 UUID 且新调用不同', async () => {
    const fixture = createFixture()
    /** 保存每次交给业务层的稳定操作身份。 */
    const operationIds: string[] = []
    const dependencies = {
      ...fixture.dependencies,
      operations: {
        adoptVersion: async (_input: unknown, execution: { operationId: string }) => {
          operationIds.push(execution.operationId)
          return { adopted: true }
        },
      },
    }
    const run = createCanvasToolRun(dependencies, fixture.context)
    const input = {
      canvasId: 'canvas-1', nodeId: 'image-1', expectedCanvasRevision: 3,
      expectedVersion: 4, version: { kind: 'image', jobId: 'job-1' }, intent: 'explicit',
    }
    await executeTool(run.piCustomTools, 'canvas_adopt_version', input, 'call-1')
    await executeTool(run.piCustomTools, 'canvas_adopt_version', input, 'call-1')
    await executeTool(run.piCustomTools, 'canvas_adopt_version', input, 'call-2')
    expect(operationIds[0]).toBe(operationIds[1])
    expect(operationIds[0]).not.toBe(operationIds[2])
    expect(operationIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('Given 候选批次采用已装配 When 按运行模式构造工具 Then 仅普通 execute Agent 可调用', async () => {
    const fixture = createFixture()
    /** 记录 shared 输入与稳定 operation 身份，供主 IPC handler 直接复用。 */
    const received: Array<{ input: unknown; operationId: string }> = []
    const dependencies = {
      ...fixture.dependencies,
      operations: {
        adoptCandidateBatch: async (input: unknown, execution: { operationId: string }) => {
          received.push({ input, operationId: execution.operationId })
          return { status: 'adopted', adoptedNodeIds: ['image-1'], keptNodeIds: [] }
        },
      },
    }
    const ordinary = createCanvasToolRun(dependencies, fixture.context)
    const params = { canvasId: 'canvas-1', batchId: 'batch-1', mode: 'succeeded', intent: 'explicit' }
    await executeTool(ordinary.piCustomTools, 'canvas_adopt_candidate_batch', params, 'call-1')
    expect(received[0]?.input).toEqual({
      projectId: 'project-1', canvasId: 'canvas-1', batchId: 'batch-1', mode: 'succeeded',
    })
    expect(received[0]?.operationId).toMatch(/^[0-9a-f-]{36}$/)

    const manual = createCanvasToolRun(dependencies, {
      ...fixture.context,
      canvasAgentTarget: { ...target, nodeId: 'agent-1' },
      canvasAgentMode: 'renderer-manual',
    })
    const parent = createCanvasToolRun(dependencies, {
      ...fixture.context,
      canvasAgentTarget: { ...target, nodeId: 'agent-1' },
      canvasAgentMode: 'parent-orchestrated',
    })
    const plan = createCanvasToolRun(dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    expect(manual.allowedToolNames).not.toContain('canvas_adopt_candidate_batch')
    expect(parent.allowedToolNames).not.toContain('canvas_adopt_candidate_batch')
    await expect(executeTool(plan.piCustomTools, 'canvas_adopt_candidate_batch', params))
      .rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(received).toHaveLength(1)
  })

  test('Given 父编排子 Agent When 新能力装配 Then 可查询但不能重试采用或继续工作流', () => {
    const fixture = createFixture()
    const dependencies = {
      ...fixture.dependencies,
      operations: {
        getTask: async () => ({ status: 'failed' }),
        listVersions: async () => ({ versions: [] }),
        retryTask: async () => ({ jobId: 'replacement' }),
        adoptVersion: async () => ({ adopted: true }),
        adoptCandidateBatch: async () => ({ adopted: true }),
        resumeWorkflow: async () => ({ status: 'running' }),
      },
    }
    const run = createCanvasToolRun(dependencies, {
      ...fixture.context,
      canvasAgentTarget: { ...target, nodeId: 'agent-1' },
      canvasAgentMode: 'parent-orchestrated',
    })
    expect(run.allowedToolNames).toContain('canvas_get_task')
    expect(run.allowedToolNames).toContain('canvas_list_versions')
    expect(run.allowedToolNames).not.toContain('canvas_retry_task')
    expect(run.allowedToolNames).not.toContain('canvas_adopt_version')
    expect(run.allowedToolNames).not.toContain('canvas_adopt_candidate_batch')
    expect(run.allowedToolNames).not.toContain('canvas_resume_workflow')
  })

  test('Given 十五个新增操作已装配 When 按三类 Agent 模式构造工具 Then 各自只暴露固定允许范围', () => {
    const fixture = createFixture()
    const dependencies = { ...fixture.dependencies, operations: createAllOperationHandlers() }
    const ordinary = createCanvasToolRun(dependencies, fixture.context)
    const rendererManual = createCanvasToolRun(dependencies, {
      ...fixture.context,
      canvasAgentTarget: { ...target, nodeId: 'agent-1' },
      canvasAgentMode: 'renderer-manual',
    })
    const parentOrchestrated = createCanvasToolRun(dependencies, {
      ...fixture.context,
      canvasAgentTarget: { ...target, nodeId: 'agent-1' },
      canvasAgentMode: 'parent-orchestrated',
    })
    const operationNames = [
      'canvas_get_task', 'canvas_cancel_task', 'canvas_retry_task',
      'canvas_list_versions', 'canvas_read_version', 'canvas_adopt_version',
      'canvas_adopt_candidate_batch',
      'canvas_export_artifact', 'canvas_list_trash', 'canvas_restore_node',
      'canvas_rebuild_agent', 'canvas_list_workflows', 'canvas_get_workflow',
      'canvas_resume_workflow', 'canvas_cancel_workflow',
    ]

    expect(ordinary.allowedToolNames.filter((name) => operationNames.includes(name))).toEqual(operationNames)
    expect(rendererManual.allowedToolNames.filter((name) => operationNames.includes(name))).toEqual([
      'canvas_get_task', 'canvas_cancel_task', 'canvas_retry_task',
      'canvas_list_versions', 'canvas_read_version', 'canvas_adopt_version',
      'canvas_export_artifact', 'canvas_list_trash', 'canvas_restore_node',
      'canvas_resume_workflow', 'canvas_cancel_workflow',
    ])
    expect(parentOrchestrated.allowedToolNames.filter((name) => operationNames.includes(name))).toEqual([
      'canvas_get_task', 'canvas_list_versions', 'canvas_read_version',
    ])
    expect(ordinary.systemPromptAppend).toContain('`canvas_rebuild_agent`')
    expect(rendererManual.systemPromptAppend).not.toContain('`canvas_rebuild_agent`')
    expect(parentOrchestrated.systemPromptAppend).toContain('`canvas_get_task`、`canvas_list_versions`、`canvas_read_version`')
    expect(parentOrchestrated.systemPromptAppend).not.toContain('`canvas_retry_task`')
  })

  test('Given 图片候选 When Agent 查询后采用 Then 使用精确指纹且不暴露素材路径', async () => {
    /** 仅当前画布的真实节点可被查询和采用。 */
    const fixture = createFixture()
    const batch: CanvasImageCandidateBatch = {
      schemaVersion: 1, ...target, batchId: 'batch-1', source: 'canvas-tool',
      sourceSessionId: 'session-1', sourceToolCallId: 'tool-1', status: 'ready',
      entries: [{ nodeId: 'image-1', imageModuleId: 'image-content-1', initialAdoptedAssetId: 'asset-1',
        initialConfigRevision: 1, jobId: 'job-1', candidateAssetId: 'secret-asset', status: 'candidate', error: null }],
      adoption: null, createdAt: 1, updatedAt: 2,
    }
    const adoptedHashes: Array<string | undefined> = []
    fixture.dependencies.imageCandidates = {
      load: async () => structuredClone(batch),
      adopt: async (_input, hash) => {
        adoptedHashes.push(typeof hash === 'string' ? hash : hash?.expectedCandidateHash)
        return { ...batch, status: 'adopted', adoption: { mode: 'all', adoptedNodeIds: ['image-1'],
          keptNodeIds: [], invalidatedDownstreamNodeIds: [], committedAt: 3 } }
      },
    }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const queried = await executeTool(run.piCustomTools, 'canvas_get_image_candidates', { canvasId: 'canvas-1', batchId: 'batch-1' })
    const details = queried.details as { candidateHash: string }
    expect(details.candidateHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(queried)).not.toContain('secret-asset')
    const inspected = await executeTool(run.piCustomTools, 'canvas_get_image_candidates', {
      canvasId: 'canvas-1', batchId: 'batch-1', inspectNodeIds: ['image-1'],
    })
    expect(inspected.details).toMatchObject({ imageCount: 1, inspections: [{ nodeId: 'image-1', status: 'ready' }] })
    expect(inspected.content.filter((entry) => entry.type === 'image')).toHaveLength(1)
    await expect(executeTool(run.piCustomTools, 'canvas_get_image_candidates', {
      canvasId: 'canvas-1', batchId: 'batch-1', inspectNodeIds: ['image-1', 'image-1'],
    })).rejects.toThrow('CANVAS_IMAGE_BATCH_LIMIT')
    await expect(executeTool(run.piCustomTools, 'canvas_get_image_candidates', {
      canvasId: 'canvas-unlinked', batchId: 'batch-1',
    })).rejects.toThrow()
    const result = await executeTool(run.piCustomTools, 'canvas_adopt_image_candidates', {
      canvasId: 'canvas-1', batchId: 'batch-1', candidateHash: details.candidateHash, mode: 'all',
    })
    expect(result.details).toMatchObject({ status: 'adopted', adoptedNodeIds: ['image-1'] })
    expect(adoptedHashes).toEqual([details.candidateHash])
    const plan = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(plan.piCustomTools, 'canvas_adopt_image_candidates', {
      canvasId: 'canvas-1', batchId: 'batch-1', candidateHash: details.candidateHash, mode: 'all',
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(adoptedHashes).toHaveLength(1)
    /** 文件读取期间发生候选替换时，不把旧缩略图与新指纹一起返回。 */
    const readThumbnail = fixture.dependencies.images.readThumbnail
    fixture.dependencies.images.readThumbnail = async (...args) => {
      batch.entries[0]!.candidateAssetId = 'replacement-asset'
      return readThumbnail(...args)
    }
    await expect(executeTool(run.piCustomTools, 'canvas_get_image_candidates', {
      canvasId: 'canvas-1', batchId: 'batch-1', inspectNodeIds: ['image-1'],
    })).rejects.toThrow('CANVAS_IMAGE_CANDIDATES_CHANGED')
  })

  test('Given 普通分析运行 When 获取上下文 Then 注入统一 Canvas 工具、Skill 路由与硬边界且不扫描全部画布', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    expect(run.piCustomTools.map((tool) => tool.name)).toEqual([
      'canvas_task',
      'canvas_get_context',
      'canvas_manage',
      'canvas_list_nodes',
      'canvas_inspect_images',
      'canvas_read',
      'canvas_apply_changes',
      'canvas_create_agent',
      'canvas_import_image',
      'canvas_create_artifact',
      'canvas_create_media',
      'canvas_update_artifact',
      'canvas_update_image_config',
      'canvas_update_media_config',
      'canvas_inspect_media',
      'canvas_attach_media_run',
      'canvas_cancel_media_run',
      'canvas_adopt_media_candidate',
      'canvas_update_agent_config',
      'canvas_run_agent',
      'canvas_run_workflow',
      'canvas_get_workflow_run',
      'canvas_list_workflow_runs',
      'canvas_resume_workflow',
      'canvas_cancel_workflow',
      'canvas_run_nodes',
    ])
    expect(run.allowedToolNames).toEqual([...CANVAS_TOOL_NAMES])
    expect(run.allowedToolNamesMode).toBe('extend')
    expect(run.singleApprovalToolNames).toEqual([
      'canvas_run_nodes', 'canvas_run_workflow', 'canvas_resume_workflow',
      'canvas_cancel_workflow', 'canvas_cancel_media_run',
    ])
    expect(run.systemPromptAppend).toContain('不要按“首页”或“设计”等关键词硬编码')
    expect(run.systemPromptAppend).toContain('先读取并遵循 `canvas-production` Skill')
    expect(run.systemPromptAppend).toContain('Skill 不可用')
    expect(run.systemPromptAppend).toContain('只询问一次')
    expect(run.systemPromptAppend).toContain('不要要求用户另建已经存在的画布')
    expect(run.systemPromptAppend).toContain('WebView 创建成功后即可直接预览')
    expect(run.systemPromptAppend).toContain('不得为 WebView 调用 canvas_run_nodes')
    expect(run.systemPromptAppend).toContain('图片仅在用户明确要求立即生成时')
    expect(run.systemPromptAppend).toContain('destructiveIntent=explicit')
    expect(run.piCustomTools.find((tool) => tool.name === 'canvas_create_artifact')?.description)
      .toContain('文档')
    const runNodesDescription = run.piCustomTools.find((tool) => tool.name === 'canvas_run_nodes')?.description ?? ''
    expect(runNodesDescription).toContain('图片、音频或视频节点')
    expect(runNodesDescription).toContain('产生费用')
    expect(runNodesDescription).not.toContain('WebView')
    const result = await executeTool(run.piCustomTools, 'canvas_get_context', {})
    expect(result.details).toMatchObject({ defaultCanvasId: 'canvas-1', activeCanvasId: 'canvas-2' })
    expect(JSON.stringify(result.details)).toContain('doc-1')
    expect(fixture.getListCalls()).toBe(0)
  })

  test('Given 已关联画布含多种节点 When 分页枚举图片 Then 只返回图片摘要且不泄露素材身份', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_list_nodes', {
      canvasId: 'canvas-1', kind: 'image', limit: 1,
    })

    expect(result.details).toMatchObject({
      canvasId: 'canvas-1', revision: 3, hasMore: false,
      nodes: [{ nodeId: 'image-1', kind: 'image', title: '主视觉', configRevision: 4, hasAdoptedAsset: true }],
    })
    expect(JSON.stringify(result.details)).not.toContain('asset-1')
  })

  test('Given 单个图片配置读取失败 When 分页审核全部节点 Then 保留失败项并继续返回其它节点', async () => {
    /** 读取错误只能形成待检查项，不能中断全量枚举或推断图片内容错误。 */
    const fixture = createFixture()
    fixture.dependencies.images.loadConfig = async () => { throw new Error('/private/image.json') }
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const run = createCanvasToolRun(fixture.dependencies, fixture.context)
      const result = await executeTool(run.piCustomTools, 'canvas_list_nodes', { canvasId: 'canvas-1' })
      expect(result.details).toMatchObject({ total: 4, hasMore: false, nodes: [
        { nodeId: 'agent-1' }, { nodeId: 'doc-1' }, { nodeId: 'web-1' },
        { nodeId: 'image-1', readError: {
          category: 'read-failed', stage: 'image-config', contentVerdict: 'unknown', nextAction: 'retry-read',
        } },
      ] })
      expect(JSON.stringify(result)).not.toContain('/private/')
      expect(fixture.runInputs).toEqual([])
      expect(fixture.batchInputs).toEqual([])
    } finally { errorSpy.mockRestore() }
  })

  test('Given 图片模块不可读但文档正常 When 批量读取审核 Then 返回局部结果且失败节点不宣告运行能力', async () => {
    const fixture = createFixture()
    fixture.dependencies.images.load = async () => { throw new Error('/private/image-module.json') }
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const run = createCanvasToolRun(fixture.dependencies, fixture.context)
      const result = await executeTool(run.piCustomTools, 'canvas_read', {
        canvasId: 'canvas-1', nodeIds: ['image-1', 'doc-1'], expectedRevision: 3,
      })
      expect(result.details).toMatchObject({ complete: false, missingNodeIds: [], nodes: [
        { node: { id: 'doc-1' }, artifact: { currentRevision: 2 } },
        { node: { id: 'image-1' }, capabilities: ['read'], readError: {
          category: 'read-failed', stage: 'image-module', contentVerdict: 'unknown', nextAction: 'retry-read',
        } },
      ] })
      expect(JSON.stringify(result)).not.toContain('/private/')
      expect(fixture.runInputs).toEqual([])
      expect(fixture.batchInputs).toEqual([])
    } finally { errorSpy.mockRestore() }
  })

  test('Given 节点历史暂时读取失败 When 审核正文 Then 保留已读正文和版本且仍标记未完整读取', async () => {
    const fixture = createFixture()
    fixture.dependencies.textArtifacts.listVersions = async () => { throw new Error('/private/history') }
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const run = createCanvasToolRun(fixture.dependencies, fixture.context)
      const result = await executeTool(run.piCustomTools, 'canvas_read', {
        canvasId: 'canvas-1', nodeIds: ['doc-1'], expectedRevision: 3,
      })
      expect(result.details).toMatchObject({ complete: false, nodes: [{
        node: { id: 'doc-1' }, content: '# 需求正文',
        artifact: { currentRevision: 2 }, readError: { stage: 'artifact-history' },
      }] })
      expect(JSON.stringify(result)).not.toContain('/private/')
    } finally { errorSpy.mockRestore() }
  })

  test('Given 审核基线已经过期 When 读取节点或枚举 Then 在模块读取前拒绝旧 revision', async () => {
    const fixture = createFixture()
    /** 基线冲突不能继续消费节点内容，更不能作为后续修复的依据。 */
    let reads = 0
    fixture.dependencies.images.load = async () => { reads += 1; throw new Error('不应读取') }
    fixture.dependencies.images.loadConfig = async () => { reads += 1; throw new Error('不应读取') }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    for (const name of ['canvas_read', 'canvas_list_nodes']) {
      await expect(executeTool(run.piCustomTools, name, {
        canvasId: 'canvas-1', expectedRevision: 2,
        ...(name === 'canvas_read' ? { nodeIds: ['image-1'] } : { kind: 'image' }),
      })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
    }
    expect(reads).toBe(0)
  })

  test('Given 节点异步读取期间画布改变 When 结束读取 Then 拒绝把混合版本当作复核证据', async () => {
    const fixture = createFixture()
    const document = fixture.dependencies.documents.load(target).document
    const read = fixture.dependencies.textArtifacts.read
    fixture.dependencies.textArtifacts.read = async (input) => {
      fixture.dependencies.documents.load = () => ({
        document: { ...document, revision: 4 }, writable: true, nodeIssues: [],
      })
      return read(input)
    }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['doc-1'], expectedRevision: 3,
    })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
  })

  test('Given 审核过程中被停止或撤权 When 节点读取返回 Then 整次调用拒绝且不继续读取下一个节点', async () => {
    for (const failure of ['abort', 'access'] as const) {
      const fixture = createFixture()
      const controller = new AbortController()
      let configReads = 0
      fixture.dependencies.agentOutputs.read = async () => {
        if (failure === 'abort') controller.abort(new Error('审核已停止'))
        else fixture.dependencies.access.authorizeRead = () => { throw new Error('CANVAS_ACCESS_DENIED') }
        return '已读正文'
      }
      fixture.dependencies.agentConfigs.load = async () => { configReads += 1; throw new Error('不应继续读取') }
      const run = createCanvasToolRun(fixture.dependencies, fixture.context)
      await expect(executeTool(run.piCustomTools, 'canvas_read', {
        canvasId: 'canvas-1', nodeIds: ['agent-1', 'doc-1'],
      }, 'review-stop', controller.signal)).rejects.toThrow(failure === 'abort' ? '审核已停止' : 'CANVAS_ACCESS_DENIED')
      expect(configReads).toBe(0)
    }
  })

  test('Given 审核节点不存在且部分连线端点未返回 When 读取 Then 明确列出缺失节点和未返回连线数', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['doc-1', 'missing-node'],
    })
    expect(result.details).toMatchObject({
      complete: false, missingNodeIds: ['missing-node'], omittedEdgeCount: 1, truncated: true,
    })
    const complete = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['doc-1', 'image-1'], expectedRevision: 3,
    })
    expect(complete.details).toMatchObject({ complete: true, missingNodeIds: [], omittedEdgeCount: 0 })
  })

  test('Given 审核音视频模块读取失败 When 检查 Then 返回读取阻塞且不能据此判定内容不合格', async () => {
    const fixture = createFixture()
    const document = fixture.dependencies.documents.load(target).document
    document.nodes.push({ id: 'video-1', kind: 'video', title: '视频', position: { x: 0, y: 0 }, mediaModuleId: 'media-1' })
    fixture.dependencies.documents.load = () => ({ document, writable: true, nodeIssues: [] })
    fixture.dependencies.canvasMedia.load = async () => { throw new Error('/private/video.json') }
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const run = createCanvasToolRun(fixture.dependencies, fixture.context)
      const result = await executeTool(run.piCustomTools, 'canvas_inspect_media', {
        canvasId: 'canvas-1', nodeId: 'video-1', expectedRevision: 3,
      })
      expect(result.details).toMatchObject({ metadataOnly: true, readError: {
        category: 'read-failed', stage: 'media-module', contentVerdict: 'unknown', nextAction: 'retry-read',
      } })
      expect(JSON.stringify(result)).not.toContain('/private/')
      expect(fixture.canvasMediaInputs).toEqual([])
    } finally { errorSpy.mockRestore() }
  })

  test('Given 已授权审核并修复 When 注入规则 Then 复用任务授权并约束替换顺序、复核与预算', () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    for (const rule of ['审核并修复', '本任务授权', '最多两轮', '读取失败不等于内容错误',
      '先验证新节点', '全部入边和出边', '重新读取', '原工作流预算', 'metadataOnly']) {
      expect(run.systemPromptAppend).toContain(rule)
    }
  })

  test('Given 任务查询工具已装配 When 注入生成后续规则 Then 明确等待真实终态而非提交后结束', () => {
    const fixture = createFixture()
    fixture.dependencies.operations = { getTask: async () => ({ status: 'running' }) }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    for (const rule of ['replacementJobId', 'waitMs=60000', '已提交不等于完成', '实际错误', '已有采用授权']) {
      expect(run.systemPromptAppend).toContain(rule)
    }
  })

  test('Given 枚举或媒体检查中停止、撤权或变更图 When 异步读取返回 Then 整次拒绝而非返回局部成功', async () => {
    for (const name of ['canvas_list_nodes', 'canvas_inspect_media']) {
      for (const failure of ['abort', 'access', 'revision'] as const) {
        /** 每个场景使用独立权限、信号和图快照，避免前一个拒绝污染后续断言。 */
        const fixture = createFixture()
        const document = fixture.dependencies.documents.load(target).document
        document.nodes.push({ id: 'video-1', kind: 'video', title: '视频', position: { x: 0, y: 0 }, mediaModuleId: 'media-1' })
        fixture.dependencies.documents.load = () => ({ document: structuredClone(document), writable: true, nodeIssues: [] })
        const controller = new AbortController()
        /** 模拟远端或本地异步读取结束之前上下文已失效。 */
        const invalidateRead = (): never => {
          if (failure === 'abort') controller.abort(new Error('审核已停止'))
          else if (failure === 'access') fixture.dependencies.access.authorizeRead = () => { throw new Error('CANVAS_ACCESS_DENIED') }
          else document.revision += 1
          throw new Error('/private/read-failed')
        }
        fixture.dependencies.images.loadConfig = async () => invalidateRead()
        fixture.dependencies.canvasMedia.load = async () => invalidateRead()
        const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
        try {
          const run = createCanvasToolRun(fixture.dependencies, fixture.context)
          await expect(executeTool(run.piCustomTools, name, {
            canvasId: 'canvas-1', expectedRevision: 3,
            ...(name === 'canvas_list_nodes' ? { kind: 'image' } : { nodeId: 'video-1' }),
          }, 'review-invalidated', controller.signal)).rejects.toThrow(
            failure === 'abort' ? '审核已停止' : failure === 'access' ? 'CANVAS_ACCESS_DENIED' : 'CANVAS_REVISION_CONFLICT',
          )
          expect(fixture.runInputs).toEqual([])
          expect(fixture.canvasMediaInputs).toEqual([])
        } finally { errorSpy.mockRestore() }
      }
    }
  })

  test('Given 整批节点历史均失败且正文很长 When 读取审核 Then 保留每项诊断和版本且整体响应不超过预算', async () => {
    const fixture = createFixture()
    /** 使用最大节点数和长正文，锁定新增诊断不会挤掉尾部节点或突破响应上限。 */
    const document = fixture.dependencies.documents.load(target).document
    const nodes = Array.from({ length: 32 }, (_, index) => ({
      id: `doc-${index}`, kind: 'document' as const, title: '文'.repeat(120),
      position: { x: index, y: 0 }, documentId: `content-${index}`, contentRevision: 2,
    }))
    fixture.dependencies.documents.load = () => ({ document: { ...document, nodes, edges: [] }, writable: true, nodeIssues: [] })
    const read = fixture.dependencies.textArtifacts.read
    fixture.dependencies.textArtifacts.read = async (input) => ({ ...await read(input), content: '正文'.repeat(40_000) })
    fixture.dependencies.textArtifacts.listVersions = async () => { throw new Error('/private/history') }
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const run = createCanvasToolRun(fixture.dependencies, fixture.context)
      const result = await executeTool(run.piCustomTools, 'canvas_read', {
        canvasId: 'canvas-1', nodeIds: nodes.map((node) => node.id), expectedRevision: 3,
      })
      expect(result.details).toMatchObject({ complete: false, truncated: true,
        nodes: nodes.map((node) => ({ node: { id: node.id }, artifact: { currentRevision: 2 },
          readError: { stage: 'artifact-history', contentVerdict: 'unknown' } })),
      })
      expect(JSON.stringify(result.details).length).toBeLessThanOrEqual(32_768)
      expect(result.content[0]).toMatchObject({ type: 'text' })
      if (result.content[0]?.type === 'text') expect(result.content[0].text.length).toBeLessThanOrEqual(32_768)
      expect(JSON.stringify(result)).not.toContain('/private/')
    } finally { errorSpy.mockRestore() }
  })

  test('Given 有当前采用图片 When 按权威 revision 检查 Then 返回节点身份文本和紧邻图片块', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1', 'image-1'], expectedRevision: 3,
    })

    expect(result.content.map((block) => block.type)).toEqual(['text', 'image'])
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('image-1') })
    expect(result.details).toMatchObject({
      canvasId: 'canvas-1', revision: 3,
      inspections: [{ nodeId: 'image-1', title: '主视觉', status: 'ready' }],
    })
    expect(JSON.stringify(result.details)).not.toContain('asset-1')
    expect(fixture.getThumbnailReadCalls()).toBe(1)
  })

  test('Given 枚举后画布 revision 改变 When 检查图片 Then 拒绝读取任何缩略图', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 2,
    })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
    expect(fixture.getThumbnailReadCalls()).toBe(0)
  })

  test('Given 成功候选尚未采用 When 按任务版本检查 Then 返回候选图片且不修改正式版本', async () => {
    /** 候选检查复用现有 fixture，只移除正式采用事实。 */
    const fixture = createFixture()
    const document = fixture.dependencies.documents.load(target).document
    fixture.dependencies.documents.load = () => ({
      document: { ...document, nodes: document.nodes.map((node) => node.kind === 'image'
        ? { ...node, adoptedAssetId: undefined }
        : node) }, writable: true, nodeIssues: [],
    })
    const config = await fixture.dependencies.images.loadConfig({ ...target, nodeId: 'image-1', imageModuleId: 'image-content-1' })
    fixture.dependencies.images.loadConfig = async () => ({ ...config, adoptedAssetId: null })
    /** 模拟权威版本适配器仅返回当前模块验证过的成功输出。 */
    Object.assign(fixture.dependencies.images, {
      listVersions: async () => [{ jobId: 'candidate-job', assetId: 'candidate-asset', createdAt: 5 }],
    })
    const readAssets: string[] = []
    const readThumbnail = fixture.dependencies.images.readThumbnail
    fixture.dependencies.images.readThumbnail = async (projectId, assetId) => {
      readAssets.push(assetId)
      return readThumbnail(projectId, assetId)
    }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3,
      versions: [{ nodeId: 'image-1', jobId: 'candidate-job' }],
    })

    expect(result.content.map((block) => block.type)).toEqual(['text', 'image'])
    expect(result.details).toMatchObject({ inspections: [{
      nodeId: 'image-1', status: 'ready', jobId: 'candidate-job', adopted: false,
    }] })
    expect(readAssets).toEqual(['candidate-asset'])
    expect(JSON.stringify(result)).not.toContain('candidate-asset')
    expect(fixture.imageSaveInputs).toEqual([])
    expect(fixture.runInputs).toEqual([])
    expect(fixture.batchInputs).toEqual([])
  })

  test('Given 已有正式图和历史候选 When 显式检查历史任务 Then 不以正式图替代请求版本', async () => {
    const fixture = createFixture()
    Object.assign(fixture.dependencies.images, {
      listVersions: async () => [{ jobId: 'old-job', assetId: 'old-asset', createdAt: 2 }],
    })
    const readAssets: string[] = []
    const readThumbnail = fixture.dependencies.images.readThumbnail
    fixture.dependencies.images.readThumbnail = async (projectId, assetId) => {
      readAssets.push(assetId)
      return readThumbnail(projectId, assetId)
    }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3,
      versions: [{ nodeId: 'image-1', jobId: 'old-job' }],
    })
    expect(result.content.map((block) => block.type)).toEqual(['text', 'image'])
    expect(readAssets).toEqual(['old-asset'])
    expect(fixture.imageSaveInputs).toEqual([])
  })

  test('Given 请求版本不属于当前节点或已失效 When 检查候选 Then 不读取图片也不回退正式图', async () => {
    const fixture = createFixture()
    Object.assign(fixture.dependencies.images, { listVersions: async () => [] })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3,
      versions: [{ nodeId: 'image-1', jobId: 'foreign-job' }],
    })
    expect(result.content.map((block) => block.type)).toEqual(['text'])
    expect(result.details).toMatchObject({ inspections: [{ status: 'version-unavailable' }] })
    expect(fixture.getThumbnailReadCalls()).toBe(0)
  })

  test('Given 版本选择重复或越过请求节点 When 检查候选 Then 在读取任何图片前拒绝', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    for (const versions of [
      [{ nodeId: 'other-node', jobId: 'candidate-job' }],
      [{ nodeId: 'image-1', jobId: 'first' }, { nodeId: 'image-1', jobId: 'second' }],
    ]) {
      await expect(executeTool(run.piCustomTools, 'canvas_inspect_images', {
        canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3, versions,
      })).rejects.toThrow('CANVAS_IMAGE_VERSION_SELECTION_INVALID')
    }
    expect(fixture.getThumbnailReadCalls()).toBe(0)
  })

  test('Given 显式历史版本在配置或媒体读取中失败 When 检查 Then 所有失败结果保留请求 jobId', async () => {
    /** 分别模拟图片读取链路中的可恢复失败，不暴露底层素材路径。 */
    for (const failure of ['config', 'version-list', 'thumbnail-read', 'thumbnail-validate', 'decode'] as const) {
      /** 每个失败阶段使用独立配置和媒体依赖。 */
      const fixture = createFixture()
      fixture.dependencies.images.listVersions = async () => [{ jobId: 'old-job', assetId: 'old-asset', createdAt: 2 }]
      if (failure === 'config') {
        fixture.dependencies.images.loadConfig = async () => { throw new Error('private config path') }
      } else if (failure === 'version-list') {
        fixture.dependencies.images.listVersions = async () => { throw new Error('private version path') }
      } else if (failure === 'thumbnail-read') {
        fixture.dependencies.images.readThumbnail = async () => { throw new Error('private asset path') }
      } else if (failure === 'decode') {
        fixture.dependencies.images.readThumbnail = async () => ({ bytes: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), mediaType: 'image/png' })
      } else {
        fixture.dependencies.images.readThumbnail = async () => ({ bytes: Buffer.from('invalid'), mediaType: 'image/png' })
      }
      /** 显式任务检查不应在失败后丢失用户正在检查的版本身份。 */
      const run = createCanvasToolRun(fixture.dependencies, fixture.context)
      const result = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
        canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3,
        versions: [{ nodeId: 'image-1', jobId: 'old-job' }],
      })
      expect(result.details).toMatchObject({ inspections: [{
        jobId: 'old-job', status: 'image-unavailable',
        failureStage: failure === 'decode' ? 'thumbnail-validate' : failure,
        failureCode: {
          config: 'CANVAS_IMAGE_CONFIG_READ_FAILED',
          'version-list': 'CANVAS_IMAGE_VERSION_LIST_FAILED',
          'thumbnail-read': 'DESIGN_THUMBNAIL_UNAVAILABLE',
          'thumbnail-validate': 'CANVAS_IMAGE_THUMBNAIL_INVALID',
          decode: 'CANVAS_IMAGE_THUMBNAIL_INVALID',
        }[failure],
        message: expect.any(String),
      }] })
      expect(result.content.map((block) => block.type)).toEqual(['text'])
      expect(JSON.stringify(result)).not.toContain('private')
    }
  })

  test('Given 版本查询抛出底层异常 When 检查失败 Then 本机日志保留异常且工具结果仅含公开诊断', async () => {
    /** 模拟包含本机路径的底层异常，原始对象只能进入本机日志。 */
    const failure = new TypeError('private version path: this.ensureCanvasImageIndex is not a function')
    const fixture = createFixture()
    fixture.dependencies.images.listVersions = async () => { throw failure }
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const run = createCanvasToolRun(fixture.dependencies, fixture.context)
      const result = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
        canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3,
        versions: [{ nodeId: 'image-1', jobId: 'old-job' }],
      })
      expect(errorSpy).toHaveBeenCalledWith('[CanvasTools] 图片检查失败:', expect.objectContaining({
        nodeId: 'image-1', jobId: 'old-job', failureStage: 'version-list',
      }), failure)
      expect(result.details).toMatchObject({ inspections: [{
        status: 'image-unavailable', failureCode: 'CANVAS_IMAGE_VERSION_LIST_FAILED',
      }] })
      expect(JSON.stringify(result)).not.toContain(failure.message)
      expect(fixture.getThumbnailReadCalls()).toBe(0)
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('Given 候选图片读取期间画布发生变化 When 返回检查结果 Then 拒绝混用旧图事实', async () => {
    const fixture = createFixture()
    const document = fixture.dependencies.documents.load(target).document
    const readThumbnail = fixture.dependencies.images.readThumbnail
    fixture.dependencies.images.readThumbnail = async (projectId, assetId) => {
      fixture.dependencies.documents.load = () => ({
        document: { ...document, revision: document.revision + 1 }, writable: true, nodeIssues: [],
      })
      return readThumbnail(projectId, assetId)
    }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3,
    })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
  })

  test('Given 分页游标生成后画布变化 When 继续枚举 Then 明确 revision 冲突', async () => {
    const fixture = createFixture()
    let revision = 3
    const baseDocument = fixture.dependencies.documents.load(target).document
    fixture.dependencies.documents.load = () => ({
      document: {
        ...baseDocument,
        revision,
        nodes: [
          ...baseDocument.nodes,
          { id: 'image-2', kind: 'image', title: '次视觉', position: { x: 150, y: 0 }, imageModuleId: 'image-content-2', adoptedAssetId: 'asset-1' },
        ],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const firstPage = await executeTool(run.piCustomTools, 'canvas_list_nodes', {
      canvasId: 'canvas-1', kind: 'image', limit: 1,
    })
    const cursor = (firstPage.details as { nextCursor: string }).nextCursor
    revision = 4

    await expect(executeTool(run.piCustomTools, 'canvas_list_nodes', {
      canvasId: 'canvas-1', kind: 'image', limit: 1, cursor,
    })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
  })

  test('Given 节点与配置采用身份不一致或缩略图损坏 When 检查 Then fail closed 且不返回图片', async () => {
    const fixture = createFixture()
    const baseDocument = fixture.dependencies.documents.load(target).document
    fixture.dependencies.documents.load = () => ({
      document: {
        ...baseDocument,
        nodes: baseDocument.nodes.map((node) => node.id === 'image-1'
          ? { ...node, adoptedAssetId: 'asset-other' }
          : node) as CanvasDocument['nodes'],
      },
      writable: true,
      nodeIssues: [],
    })
    let run = createCanvasToolRun(fixture.dependencies, fixture.context)
    let result = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3,
    })
    expect(result.content.map((block) => block.type)).toEqual(['text'])
    expect(result.details).toMatchObject({ inspections: [{ status: 'adopted-asset-mismatch' }] })
    expect(fixture.getThumbnailReadCalls()).toBe(0)

    fixture.dependencies.documents.load = () => ({ document: baseDocument, writable: true, nodeIssues: [] })
    fixture.dependencies.images.readThumbnail = async () => ({
      bytes: Buffer.from('not-an-image'), mediaType: 'image/png',
    })
    run = createCanvasToolRun(fixture.dependencies, fixture.context)
    result = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3,
    })
    expect(result.content.map((block) => block.type)).toEqual(['text'])
    expect(result.details).toMatchObject({ inspections: [{ status: 'image-unavailable' }] })
  })

  test('Given Agent 更新已有 WebView When 调用 canvas_update_artifact Then 节点 ID 不变且 revision 增加', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_update_artifact', {
      canvasId: 'canvas-1', nodeId: 'web-1', baseRevision: 3,
      expectedContentRevision: 1, content: '<!doctype html><h1>新版</h1>',
    }, 'tool-update-1')

    expect(result.details).toMatchObject({ nodeId: 'web-1', kind: 'webview', contentRevision: 2 })
    expect(fixture.textUpdateInputs[0]).toMatchObject({
      nodeId: 'web-1', kind: 'webview', contentId: 'prototype-1',
    })
  })

  test('Given Agent 更新图片 prompt When 调用 update Then 保留配置且不自动运行', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_update_artifact', {
      canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3,
      expectedContentRevision: 4, content: '新的首页视觉提示词',
    }, 'tool-image-update-1')

    expect(result.details).toMatchObject({ nodeId: 'image-1', kind: 'image', contentRevision: 5, requiresRun: true })
    expect(fixture.imageSaveInputs[0]).toMatchObject({
      imageModuleId: 'image-content-1', prompt: '新的首页视觉提示词',
      selectedModelProfileId: 'model-1', aspectRatio: '16:9', imageSize: '2K', contextMode: 'project',
    })
    expect(fixture.runInputs).toHaveLength(0)
  })

  test('Given 普通 Agent 要求调整图片画幅 When 更新图片配置 Then 保留未指定字段且不自动运行', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_update_image_config', {
      canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3,
      expectedConfigRevision: 4, aspectRatio: '3:4',
    }, 'tool-image-config-1')

    expect(result.details).toMatchObject({
      nodeId: 'image-1', kind: 'image', configRevision: 5, requiresRun: true,
    })
    expect(fixture.imageSaveInputs[0]).toMatchObject({
      nodeId: 'image-1', imageModuleId: 'image-content-1',
      expectedConfigRevision: 4, prompt: '旧提示词', selectedModelProfileId: 'model-1',
      aspectRatio: '3:4', imageSize: '2K', contextMode: 'project',
    })
    expect(fixture.runInputs).toHaveLength(0)
  })

  test('Given Agent 显式选择已绑定图片参考 When 更新图片配置 Then 保存节点身份且不切换正式采用', async () => {
    const fixture = createFixture()
    const document = fixture.dependencies.documents.load(target).document
    document.nodes.push({
      id: 'master-image', kind: 'image', title: '母版', position: { x: 0, y: 100 },
      imageModuleId: 'master-content', adoptedAssetId: 'master-asset',
    })
    document.edges.push({
      id: 'master-reference', sourceNodeId: 'master-image', sourcePort: 'image.asset',
      targetNodeId: 'image-1', targetPort: 'image.reference', relation: 'reference',
    })
    fixture.dependencies.documents.load = () => ({
      document: structuredClone(document), writable: true, nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await executeTool(run.piCustomTools, 'canvas_update_image_config', {
      canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3,
      expectedConfigRevision: 4, editSourceNodeId: 'master-image',
    }, 'tool-image-edit-source')

    expect(fixture.imageSaveInputs[0]).toMatchObject({
      editSourceNodeId: 'master-image',
    })
    expect(fixture.imageSaveInputs[0]).not.toHaveProperty('adoptedAssetId')
    expect(document.nodes.find((node) => node.id === 'image-1')).toMatchObject({ adoptedAssetId: 'asset-1' })
    expect(fixture.runInputs).toHaveLength(0)
  })

  test('Given Agent 指定未绑定或关联关系图片 When 更新编辑底图 Then 在保存前拒绝', async () => {
    const fixture = createFixture()
    const document = fixture.dependencies.documents.load(target).document
    document.nodes.push({
      id: 'master-image', kind: 'image', title: '母版', position: { x: 0, y: 100 },
      imageModuleId: 'master-content',
    })
    document.edges.push({
      id: 'master-association', sourceNodeId: 'master-image', sourcePort: 'image.asset',
      targetNodeId: 'image-1', targetPort: 'image.reference', relation: 'association',
    })
    fixture.dependencies.documents.load = () => ({
      document: structuredClone(document), writable: true, nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_update_image_config', {
      canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3,
      expectedConfigRevision: 4, editSourceNodeId: 'master-image',
    }, 'tool-image-edit-source-invalid')).rejects.toThrow('CANVAS_IMAGE_EDIT_SOURCE_INVALID')
    expect(fixture.imageSaveInputs).toHaveLength(0)
  })

  test('Given 普通 Agent 未提供图片配置变更 When 更新图片配置 Then 在保存前明确拒绝', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_update_image_config', {
      canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3, expectedConfigRevision: 4,
    }, 'tool-image-config-empty')).rejects.toThrow('CANVAS_IMAGE_CONFIG_PATCH_REQUIRED')
    expect(fixture.imageSaveInputs).toHaveLength(0)
  })

  test('Given 图片工作流分析失败 When 只记录待配置诊断 Then 保留图片参数且不提交生成', async () => {
    /** 原卡片保存分析错误，避免工作流不可转换时丢失用户上下文。 */
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const preparation = { code: 'UI_SUBGRAPH_INPUT_MISMATCH', message: '节点 105 的子图输入与定义不一致。' }
    await executeTool(run.piCustomTools, 'canvas_update_image_config', {
      canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3,
      expectedConfigRevision: 4, preparation,
    })
    expect(fixture.imageSaveInputs[0]).toMatchObject({ preparation, prompt: '旧提示词', selectedModelProfileId: 'model-1' })
    expect(fixture.runInputs).toHaveLength(0)
  })

  test('Given Agent 选择公共图片工作流 When 更新图片配置 Then 清除 profile 并保存完整媒体输入', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const mediaWorkflow = {
      workflowId: 'workflow-1', workflowRevision: 2, connectionId: 'connection-1',
      inputs: {
        promptText: { kind: 'scalar', value: '直接映射提示词' },
        reference: { kind: 'asset', asset: {
          assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image',
        } },
      },
    } as const

    await executeTool(run.piCustomTools, 'canvas_update_image_config', {
      canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3,
      expectedConfigRevision: 4, mediaWorkflow,
    }, 'tool-image-workflow-1')

    expect(fixture.imageSaveInputs[0]).toMatchObject({
      selectedModelProfileId: null,
      mediaWorkflow,
    })
    expect(fixture.runInputs).toHaveLength(0)
  })

  test('Given 普通 Agent 局部修改专业 Agent 配置 When 双 revision 匹配 Then 保留省略字段且不接受会话归属字段', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const tool = run.piCustomTools.find((candidate) => candidate.name === 'canvas_update_agent_config')
    if (!tool) throw new Error('canvas_update_agent_config 未注册')

    const result = await executeTool(run.piCustomTools, tool.name, {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedGraphRevision: 3,
      expectedConfigRevision: 4,
      patch: { instruction: '只负责分镜', agentSessionId: 'attempted-nested-takeover' },
      agentSessionId: 'attempted-session-takeover',
    }, 'tool-agent-config-1')

    expect(result.details).toEqual({
      canvasId: 'canvas-1', nodeId: 'agent-1', graphRevision: 3, configRevision: 5,
      instruction: '只负责分镜', skillNames: ['research'], channelId: 'channel-1', modelId: 'model-1',
    })
    expect(fixture.agentConfigUpdateInputs).toEqual([{
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-1',
      expectedGraphRevision: 3, expectedConfigRevision: 4,
      patch: { instruction: '只负责分镜' },
    }])
    const schemaProperties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(schemaProperties).not.toHaveProperty('agentSessionId')
    expect(fixture.getAuthorizeReadCalls()).toBe(1)
    expect(fixture.getRequireLinkedCanvasCalls()).toBe(1)
  })

  test('Given plan 权限上限 When 更新专业 Agent 长期配置 Then 在持久化前拒绝', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, {
      ...fixture.context, permissionCeiling: 'plan',
    })

    await expect(executeTool(run.piCustomTools, 'canvas_update_agent_config', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedGraphRevision: 3,
      expectedConfigRevision: 4, patch: { instruction: '持久职责' },
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(fixture.agentConfigUpdateInputs).toHaveLength(0)
  })

  test('Given 配置更新排队期间画布已解绑 When 进入写临界区 Then 在持久化前重新拒绝', async () => {
    const fixture = createFixture({ unlinkBeforeAgentConfigValidation: true })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_update_agent_config', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedGraphRevision: 3,
      expectedConfigRevision: 4, patch: { instruction: '不应保存' },
    })).rejects.toThrow('CANVAS_ACCESS_DENIED')
    expect(fixture.agentConfigUpdateInputs).toHaveLength(0)
  })

  test('Given 普通 Agent 显式执行单节点 When 子 Agent 完成 Then 等待终态并只返回正式指针、下游和有界摘要', async () => {
    const fixture = createFixture({ agentOutput: '输出'.repeat(3_000) })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const controller = new AbortController()

    const result = await executeTool(run.piCustomTools, 'canvas_run_agent', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3,
      instruction: '完成首页分镜', skillNames: ['storyboard', 'brand:review'],
    }, 'tool-agent-run-1', controller.signal)

    expect(Object.keys(result.details as Record<string, unknown>).sort()).toEqual([
      'downstreamNodeIds', 'nodeId', 'nodeTitle', 'outputPointer', 'outputSummary', 'status',
    ])
    expect(result.details).toMatchObject({
      nodeId: 'agent-1', status: 'completed',
      outputPointer: { messageUuid: '33333333-3333-4333-8333-333333333333' },
      downstreamNodeIds: ['doc-1', 'image-1'],
    })
    expect((result.details as { outputSummary: string }).outputSummary.length).toBeLessThanOrEqual(4_096)
    expect(fixture.agentExecutionInputs).toEqual([{
      mode: 'parent-orchestrated',
      target: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-1' },
      parentSessionId: 'session-1', expectedGraphRevision: 3, instruction: '完成首页分镜',
      skillNames: ['storyboard', 'brand:review'], userMessageUuid: 'tool-agent-run-1',
      startedAt: 99, signal: controller.signal,
    }])
    expect(fixture.runInputs).toHaveLength(0)
    expect(fixture.batchInputs).toHaveLength(0)
    /** 异步运行结束后再次复验，避免返回已撤权的正文和审核信息。 */
    expect(fixture.getAuthorizeReadCalls()).toBe(2)
    expect(fixture.getRequireLinkedCanvasCalls()).toBe(2)
  })

  test('Given 本次执行返回旧指针后下一轮已提交 When 生成响应摘要 Then 只读取本次精确指针正文', async () => {
    const fixture = createFixture({
      agentOutput: '下一轮不应泄露的正文',
      agentOutputAtPointer: '本次正式正文',
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_run_agent', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3,
      instruction: '完成本轮任务',
    }, 'tool-agent-run-race')

    expect(result.details).toMatchObject({
      outputPointer: {
        messageUuid: '33333333-3333-4333-8333-333333333333',
        contentSha256: 'a'.repeat(64),
        completedAt: 120,
      },
      outputSummary: '本次正式正文',
    })
    expect(fixture.agentOutputReadPointers).toEqual([{
      messageUuid: '33333333-3333-4333-8333-333333333333',
      contentSha256: 'a'.repeat(64),
      completedAt: 120,
    }])
  })

  test('Given 普通 Agent 明确运行工作流 When 工具执行 Then 只透传五个参数、父运行身份和取消信号', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const controller = new AbortController()

    const result = await executeTool(run.piCustomTools, 'canvas_run_workflow', {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['agent-1'],
      goal: '生成小红书视频方案', maxImageRuns: 2,
    }, 'tool-workflow-1', controller.signal)

    expect(result.details).toMatchObject({
      status: 'completed', initialRevision: 3, finalRevision: 4,
      nodes: [{ nodeId: 'agent-1', status: 'completed', errorCode: null }],
    })
    expect(fixture.workflowExecutionInputs).toEqual([{
      runContext: fixture.context,
      input: {
        canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['agent-1'],
        goal: '生成小红书视频方案', maxImageRuns: 2,
      },
      toolCallId: 'tool-workflow-1', signal: controller.signal,
    }])
    expect(fixture.getAuthorizeReadCalls()).toBe(1)
    expect(fixture.getRequireLinkedCanvasCalls()).toBe(1)
  })

  test('Given 持久工作流等待验收 When 查询、列出、恢复与取消 Then 全部委托统一工作流服务', async () => {
    const fixture = createFixture()
    const calls: string[] = []
    const durableRun = {
      id: 'workflow-1', revision: 4, status: 'waiting-review', rootNodeIds: ['agent-1'],
      budget: { maxMediaRuns: 4, consumedMediaRuns: 1, remainingMediaRuns: 3 }, updatedAt: 10,
    }
    fixture.dependencies.workflowExecution.get = async () => {
      calls.push('get')
      return durableRun as never
    }
    fixture.dependencies.workflowExecution.list = async () => {
      calls.push('list')
      return [durableRun as never]
    }
    const resumeInputs: unknown[] = []
    fixture.dependencies.workflowExecution.resume = async (_context, input) => {
      calls.push('resume')
      resumeInputs.push(input)
      return {
        status: 'completed', initialRevision: 3, finalRevision: 4, nodes: [],
        imageSummary: null, requiresReview: false, errorCode: null,
      }
    }
    fixture.dependencies.workflowExecution.cancel = async () => {
      calls.push('cancel')
      return { ...durableRun, status: 'cancelled' } as never
    }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await executeTool(run.piCustomTools, 'canvas_get_workflow_run', { canvasId: 'canvas-1', runId: 'workflow-1' })
    const listed = await executeTool(run.piCustomTools, 'canvas_list_workflow_runs', { canvasId: 'canvas-1' })
    await executeTool(run.piCustomTools, 'canvas_resume_workflow', { canvasId: 'canvas-1', runId: 'workflow-1' })
    await executeTool(run.piCustomTools, 'canvas_resume_workflow', {
      canvasId: 'canvas-1', runId: 'workflow-1', expectedRunRevision: 4,
      resumeOperationId: 'extend-1', addDurationMs: 3_600_000, addMediaRuns: 4, retryNodeIds: ['image-1'],
      projectId: 'spoofed-project', owner: { sessionId: 'spoofed-session' },
    })
    expect(resumeInputs[1]).toEqual({
      ...target, runId: 'workflow-1', expectedRunRevision: 4, resumeOperationId: 'extend-1',
      addDurationMs: 3_600_000, addMediaRuns: 4, retryNodeIds: ['image-1'],
    })
    await executeTool(run.piCustomTools, 'canvas_cancel_workflow', {
      canvasId: 'canvas-1', runId: 'workflow-1', cancelIntent: 'explicit',
    })

    expect(calls).toEqual(['get', 'list', 'resume', 'resume', 'cancel'])
    expect(listed.details).toMatchObject({
      runs: [{ id: 'workflow-1', status: 'waiting-review', budget: { remainingMediaRuns: 3 } }],
    })
  })

  test('Given 正式输出包含多字节字符 When 生成响应摘要 Then 按 UTF-8 字节安全截断且不切断字符', async () => {
    const prefix = '中'.repeat(1_365)
    const fixture = createFixture({ agentOutputAtPointer: `${prefix}😀后续正文` })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_run_agent', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3,
      instruction: '生成多字节正文',
    }, 'tool-agent-run-utf8-budget')
    const summary = (result.details as { outputSummary: string }).outputSummary

    expect(summary).toBe(prefix)
    expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(4_096)
    expect(summary).not.toContain('\uFFFD')
  })

  test('Given plan 上限或非法目标 When 单 Agent 运行 Then 不启动执行服务', async () => {
    const fixture = createFixture()
    const planRun = createCanvasToolRun(fixture.dependencies, {
      ...fixture.context, permissionCeiling: 'plan',
    })
    await expect(executeTool(planRun.piCustomTools, 'canvas_run_agent', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3, instruction: '执行',
    })).rejects.toThrow('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')

    const executeRun = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(executeRun.piCustomTools, 'canvas_run_agent', {
      canvasId: 'canvas-1', nodeId: 'image-1', expectedRevision: 3, instruction: '执行',
    })).rejects.toThrow('CANVAS_AGENT_NODE_REQUIRED')
    expect(fixture.agentExecutionInputs).toHaveLength(0)
  })

  test('Given 空白或超预算指令及非法临时 Skill When 单 Agent 运行 Then 在执行服务前拒绝', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    for (const input of [
      { instruction: '   ', skillNames: [] },
      { instruction: '中'.repeat(3_000), skillNames: [] },
      { instruction: '执行', skillNames: Array.from({ length: 17 }, (_, index) => `skill-${index}`) },
      { instruction: '执行', skillNames: ['../secret'] },
    ]) {
      await expect(executeTool(run.piCustomTools, 'canvas_run_agent', {
        canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3, ...input,
      })).rejects.toThrow('CANVAS_AGENT_RUN_INPUT_INVALID')
    }
    expect(fixture.agentExecutionInputs).toHaveLength(0)
  })

  test('Given Canvas Agent 的可信执行模式和未来未知工具 When 构造工具 Then 两种模式按固定正向清单默认拒绝未知能力', () => {
    const fixture = createFixture()
    const ordinary = createCanvasToolRun(fixture.dependencies, fixture.context)
    const canvasAgentTarget = { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-1' }
    const rendererManual = createCanvasToolRun(fixture.dependencies, {
      ...fixture.context, sessionId: 'canvas-agent-session-1', canvasAgentTarget,
      canvasAgentMode: 'renderer-manual',
    })
    const parentOrchestrated = createCanvasToolRun(fixture.dependencies, {
      ...fixture.context, sessionId: 'canvas-agent-session-1', canvasAgentTarget,
      canvasAgentMode: 'parent-orchestrated',
    })
    const rendererManualToolNames = [
      'canvas_task',
      'canvas_get_context', 'canvas_list_nodes', 'canvas_inspect_images', 'canvas_read',
      'canvas_apply_changes', 'canvas_import_image', 'canvas_create_artifact',
      'canvas_create_media', 'canvas_update_artifact',
      ...(ordinary.allowedToolNames.includes('canvas_update_image_config') ? ['canvas_update_image_config'] : []),
      'canvas_update_media_config', 'canvas_inspect_media', 'canvas_cancel_media_run',
      'canvas_adopt_media_candidate', 'canvas_get_workflow_run', 'canvas_list_workflow_runs',
      'canvas_resume_workflow', 'canvas_cancel_workflow',
      'canvas_run_nodes',
    ]
    const parentOrchestratedToolNames = rendererManualToolNames.filter((name) => ![
      'canvas_cancel_media_run', 'canvas_resume_workflow', 'canvas_cancel_workflow', 'canvas_run_nodes',
    ].includes(name))
    /** 模拟未来给普通 Agent 新增的高权限工具，Canvas Agent 必须默认拒绝。 */
    const futurePrivilegedTool: ToolDefinition = {
      ...ordinary.piCustomTools[0]!,
      name: 'canvas_future_privileged',
    }
    const candidateTools = [...ordinary.piCustomTools, futurePrivilegedTool]

    expect(rendererManual.allowedToolNames).toEqual(rendererManualToolNames)
    expect(parentOrchestrated.allowedToolNames).toEqual(parentOrchestratedToolNames)
    expect(filterCanvasAgentToolsForMode(candidateTools, 'renderer-manual').map((tool) => tool.name))
      .toEqual(rendererManualToolNames)
    expect(filterCanvasAgentToolsForMode(candidateTools, 'parent-orchestrated').map((tool) => tool.name))
      .toEqual(parentOrchestratedToolNames)
    expect(parentOrchestrated.singleApprovalToolNames).toEqual([])
  })

  test('Given 文本与图片节点 When canvas_read Then 返回当前版本和可用历史', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['web-1', 'image-1'],
    })
    const details = result.details as { nodes: Array<{ artifact?: Record<string, unknown> }> }

    expect(details.nodes[0]?.artifact).toMatchObject({
      nodeId: 'web-1', kind: 'webview', currentRevision: 1, availableRevisions: [1, 2],
    })
    expect((result.details as { nodes: Array<{ content: string }> }).nodes[0]?.content).toBe('<main>旧版</main>')
    expect(details.nodes[1]?.artifact).toMatchObject({
      nodeId: 'image-1', kind: 'image', currentRevision: 4, adoptedAssetId: 'asset-1',
    })
  })

  test('Given 音视频节点已有运行 When read 与 inspect Then 只返回配置、候选和节点进度元数据', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1),
        revision: 3,
        nodes: [{
          id: 'video-1', kind: 'video', title: '主片', position: { x: 0, y: 0 }, mediaModuleId: 'media-video-1',
        }],
      },
      writable: true,
      nodeIssues: [],
    })
    const originalLoad = fixture.dependencies.canvasMedia.load
    fixture.dependencies.canvasMedia.load = async (input) => ({
      ...(await originalLoad(input)),
      runs: [{
        id: 'run-video-1', projectId: 'project-1', revision: 4, phase: 'running',
        profileId: 'profile-1', profileRevision: 1, createdAt: 1, updatedAt: 4,
        outputs: [], error: null, progress: { nodeId: '42', value: 3, max: 8 },
      }],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const read = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['video-1'],
    })
    const inspect = await executeTool(run.piCustomTools, 'canvas_inspect_media', {
      canvasId: 'canvas-1', nodeId: 'video-1',
    })

    expect(JSON.stringify(read.details)).toContain('"metadataOnly":true')
    expect(inspect.details).toMatchObject({
      metadataOnly: true,
      runs: [{ phase: 'running', progress: { nodeId: '42', value: 3, max: 8 } }],
    })
    expect(JSON.stringify(inspect.details)).not.toContain('mediaUrl')
    expect(JSON.stringify(inspect.details)).not.toContain('localPath')
  })

  test('Given Agent 创建并配置音频节点 When 调用媒体工具 Then 只经产物服务和 CanvasMediaService 提交', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const created = await executeTool(run.piCustomTools, 'canvas_create_media', {
      canvasId: 'canvas-1', baseRevision: 3, mediaKind: 'audio', title: '旁白',
      sourceNodeId: 'doc-1', relation: 'depends-on',
    }, 'tool-create-audio')
    expect(created.details).toMatchObject({ mediaKind: 'audio', configRevision: 0, requiresConfiguration: true })
    expect(fixture.artifactInputs).toEqual([expect.objectContaining({
      artifactType: 'audio', content: '', sourceNodeId: 'doc-1', relation: 'depends-on',
    })])

    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 4,
        nodes: [{ id: 'audio-1', kind: 'audio', title: '旁白', position: { x: 0, y: 0 }, mediaModuleId: 'media-audio-1' }],
      },
      writable: true,
      nodeIssues: [],
    })
    const configured = await executeTool(run.piCustomTools, 'canvas_update_media_config', {
      canvasId: 'canvas-1', nodeId: 'audio-1', baseRevision: 4, expectedConfigRevision: 2,
      profile: { profileId: 'profile-1', profileRevision: 1 },
      inputs: [{ key: 'text', kind: 'text', source: { type: 'literal', value: '你好' } }],
      outputs: [{ key: 'primary', mediaKind: 'audio', role: 'primary', order: 0 }],
    })
    expect(configured.details).toMatchObject({ mediaKind: 'audio', configRevision: 3, requiresRun: true })
    expect(fixture.canvasMediaInputs.some((entry) => entry.operation === 'save')).toBe(true)
    await executeTool(run.piCustomTools, 'canvas_update_media_config', {
      canvasId: 'canvas-1', nodeId: 'audio-1', baseRevision: 4, expectedConfigRevision: 2,
      profile: null, inputs: [{ key: 'text', kind: 'text', source: { type: 'literal', value: '草稿旁白' } }],
      outputs: [{ key: 'primary', mediaKind: 'audio', role: 'primary', order: 0 }],
    })
    expect(fixture.canvasMediaInputs.at(-1)).toMatchObject({ operation: 'save', input: { profile: null } })
  })

  test('Given 视频输入引用图片但缺真实边 When 保存配置 Then 返回可批量补齐的精确连接状态', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 4,
        nodes: [
          { id: 'image-1', kind: 'image', title: '首帧', position: { x: 0, y: 0 }, imageModuleId: 'image-module-1' },
          { id: 'video-1', kind: 'video', title: '镜头', position: { x: 400, y: 0 }, mediaModuleId: 'media-video-1' },
        ],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_update_media_config', {
      canvasId: 'canvas-1', nodeId: 'video-1', baseRevision: 4, expectedConfigRevision: 2,
      inputs: [{ key: '114.image', kind: 'image', source: {
        type: 'canvas-output', nodeId: 'image-1', outputKey: 'image.asset',
      } }],
    })

    expect(result.details).toMatchObject({
      configRevision: 3,
      connectionStatus: {
        status: 'known',
        connected: false,
        bindings: [{
          inputKey: '114.image', sourceNodeId: 'image-1',
          errorCode: 'CANVAS_MEDIA_SOURCE_EDGE_MISSING',
        }],
        missingEdges: [{
          sourceNodeId: 'image-1', sourcePort: 'image.asset',
          targetNodeId: 'video-1', targetPort: 'context.image', relation: 'depends-on',
        }],
      },
    })
  })

  test('Given 配置已保存但连接诊断读取失败 When 返回结果 Then 保留新配置版本并标记未知', async () => {
    const fixture = createFixture()
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    let documentReads = 0
    fixture.dependencies.documents.load = () => {
      documentReads += 1
      if (documentReads > 1) throw new Error('/private/canvas.json')
      return {
        document: { ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
          nodes: [{ id: 'audio-1', kind: 'audio', title: '旁白', position: { x: 0, y: 0 }, mediaModuleId: 'media-audio-1' }] },
        writable: true, nodeIssues: [],
      }
    }
    try {
      const saved = await executeTool(
        createCanvasToolRun(fixture.dependencies, fixture.context).piCustomTools,
        'canvas_update_media_config',
        { canvasId: 'canvas-1', nodeId: 'audio-1', baseRevision: 3, expectedConfigRevision: 2,
          inputs: [{ key: 'text', kind: 'text', source: { type: 'literal', value: '旁白' } }] },
      )
      expect(saved.details).toMatchObject({
        configRevision: 3,
        connectionStatus: {
          status: 'unknown', connected: null, bindings: [], missingEdges: [],
          errorCode: 'CANVAS_MEDIA_CONNECTION_STATUS_UNKNOWN',
        },
      })
      expect(JSON.stringify(saved.details)).not.toContain('/private/')
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('Given 配置保存期间画布关联被撤销 When 生成连接诊断 Then 保留保存结果且不读取越权画布', async () => {
    const fixture = createFixture()
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const requireLinkedCanvas = fixture.dependencies.access.requireLinkedCanvas
    let authorizationChecks = 0
    let documentReads = 0
    fixture.dependencies.access.requireLinkedCanvas = (context, canvasId) => {
      authorizationChecks += 1
      if (authorizationChecks > 1) throw new Error('CANVAS_ACCESS_DENIED')
      return requireLinkedCanvas(context, canvasId)
    }
    fixture.dependencies.documents.load = () => {
      documentReads += 1
      return {
        document: { ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
          nodes: [{ id: 'audio-1', kind: 'audio', title: '旁白', position: { x: 0, y: 0 }, mediaModuleId: 'media-audio-1' }] },
        writable: true, nodeIssues: [],
      }
    }
    try {
      const saved = await executeTool(
        createCanvasToolRun(fixture.dependencies, fixture.context).piCustomTools,
        'canvas_update_media_config',
        { canvasId: 'canvas-1', nodeId: 'audio-1', baseRevision: 3, expectedConfigRevision: 2,
          inputs: [{ key: 'text', kind: 'text', source: { type: 'literal', value: '旁白' } }] },
      )
      expect(saved.details).toMatchObject({
        revision: 3,
        configRevision: 3,
        connectionStatus: { status: 'unknown', errorCode: 'CANVAS_MEDIA_CONNECTION_STATUS_UNKNOWN' },
      })
      expect(authorizationChecks).toBe(2)
      expect(documentReads).toBe(1)
      expect(fixture.canvasMediaInputs.some((entry) => entry.operation === 'save')).toBeTrue()
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('Given 媒体节点已保存配置 When 检查节点 Then 同时返回连接与深层准备状态', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: { ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [{ id: 'video-1', kind: 'video', title: '镜头', position: { x: 0, y: 0 }, mediaModuleId: 'media-video-1' }] },
      writable: true, nodeIssues: [],
    })
    fixture.dependencies.canvasMedia.checkPreparation = async () => ({
      configRevision: 2, workflowBound: true, inputsReady: true, ready: true, issues: [],
    })
    const inspected = await executeTool(
      createCanvasToolRun(fixture.dependencies, fixture.context).piCustomTools,
      'canvas_inspect_media',
      { canvasId: 'canvas-1', nodeId: 'video-1', expectedRevision: 3 },
    )
    expect(inspected.details).toMatchObject({
      connectionStatus: { status: 'known', connected: true, bindings: [], missingEdges: [] },
      preparationStatus: { configRevision: 2, workflowBound: true, inputsReady: true, ready: true, issues: [] },
    })
  })

  test('Given Agent 读取媒体工具 schema When 填写输出 Then 明确要求角色和从零开始的顺序', () => {
    /** 直接验证真正交给 Pi 的 schema，防止工具展示合同与保存合同脱节。 */
    const fixture = createFixture()
    const tool = createCanvasToolRun(fixture.dependencies, fixture.context).piCustomTools
      .find((candidate) => candidate.name === 'canvas_update_media_config')!
    /** 来自失败现场的最小输出形状，工作流输出选择器不等于画布输出绑定。 */
    const input = {
      canvasId: 'canvas-1', nodeId: 'video-1', baseRevision: 3, expectedConfigRevision: 2,
      workflow: { workflowId: 'minimax-ref-test', workflowRevision: 1, connectionId: 'gpu' },
      inputs: [], outputs: [{ key: '92.video', mediaKind: 'video' }],
    }
    expect(Value.Check(tool.parameters, input)).toBeFalse()
    expect(() => validateToolArguments(tool, {
      type: 'toolCall', id: 'invalid-output', name: tool.name, arguments: input,
    })).toThrow(/outputs\.0\.role/)
    expect(Value.Check(tool.parameters, {
      ...input, outputs: [{ key: '92.video', mediaKind: 'video', role: 'primary', order: 0 }],
    })).toBeTrue()
    expect(Value.Check(tool.parameters, {
      ...input, outputs: [{ key: '92.video', mediaKind: 'video', role: 'main', order: 0 }],
    })).toBeFalse()
    expect(Value.Check(tool.parameters, {
      ...input, outputs: [{ key: '92.video', mediaKind: 'video', role: 'primary', order: -1 }],
    })).toBeFalse()
  })

  test('Given Agent 填写部分媒体输入 When 检查工具 schema Then 保留类型化值与精确素材引用', () => {
    /** schema 覆盖标量、素材与画布输出来源，未知输入项不可进入工具执行。 */
    const fixture = createFixture()
    const tool = createCanvasToolRun(fixture.dependencies, fixture.context).piCustomTools
      .find((candidate) => candidate.name === 'canvas_update_media_config')!
    /** 每项已知输入均使用正式 CanvasMediaInputBinding 结构。 */
    const input = {
      canvasId: 'canvas-1', nodeId: 'video-1', baseRevision: 3, expectedConfigRevision: 2,
      inputs: [
        { key: 'prompt', kind: 'text', source: { type: 'literal', value: '镜头' } },
        { key: 'duration', kind: 'number', source: { type: 'literal', value: 6 } },
        { key: 'audio', kind: 'boolean', source: { type: 'literal', value: false } },
        { key: 'image', kind: 'image', source: { type: 'literal', value: {
          assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image',
        } } },
        { key: 'reference', kind: 'video', source: { type: 'canvas-output', nodeId: 'video-2', outputKey: 'primary' } },
      ],
    }
    expect(Value.Check(tool.parameters, input)).toBeTrue()
    for (const invalid of [
      { key: 'prompt', value: '镜头' },
      { key: 'duration', kind: 'number', source: { type: 'literal', value: '6' } },
      { key: 'image', kind: 'image', source: { type: 'literal', value: '/tmp/image.png' } },
      { key: 'image', kind: 'image', source: { type: 'literal', value: {
        assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'video',
      } } },
    ]) expect(Value.Check(tool.parameters, { ...input, inputs: [invalid] })).toBeFalse()
  })

  test('Given 视频卡片输出缺少角色和顺序 When 修正后重试 Then 保存空输入工作流草稿且不生成', async () => {
    /** 复用工具真实解析边界，观察错误调用零保存和正确调用的具体内容。 */
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: { ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [{ id: 'video-1', kind: 'video', title: '镜头', position: { x: 0, y: 0 }, mediaModuleId: 'media-video-1' }] },
      writable: true, nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    /** 失败现场仅保留业务结构，项目和节点身份使用隔离 fixture。 */
    const input = {
      canvasId: 'canvas-1', nodeId: 'video-1', baseRevision: 3, expectedConfigRevision: 2,
      workflow: { workflowId: 'minimax-ref-test', workflowRevision: 1, connectionId: 'gpu' },
      inputs: [], outputs: [{ key: '92.video', mediaKind: 'video' }],
    }
    await expect(executeTool(run.piCustomTools, 'canvas_update_media_config', input))
      .rejects.toThrow(/CANVAS_MEDIA_SAVE_INPUT_INVALID.*outputs\[0\].*role.*order/)
    expect(fixture.canvasMediaInputs.filter((entry) => entry.operation === 'save')).toHaveLength(0)
    await executeTool(run.piCustomTools, 'canvas_update_media_config', {
      ...input, outputs: [{ key: '92.video', mediaKind: 'video', role: 'primary', order: 0 }],
      preparation: null,
    })
    expect(fixture.canvasMediaInputs.at(-1)).toMatchObject({ operation: 'save', input: {
      profile: null, workflow: input.workflow, inputs: [], preparation: null,
      outputs: [{ key: '92.video', mediaKind: 'video', role: 'primary', order: 0 }],
    } })
    expect(fixture.canvasMediaInputs.filter((entry) => entry.operation === 'run')).toHaveLength(0)
  })

  test('Given 已创建媒体卡片 When 工作流分析失败后记录诊断 Then 保留原配置并允许原卡片继续编辑', async () => {
    /** 用既有模块快照验证仅写诊断不覆盖已有输入、预设和输出。 */
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: { ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [{ id: 'video-1', kind: 'video', title: '镜头', position: { x: 0, y: 0 }, mediaModuleId: 'media-video-1' }] },
      writable: true, nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const preparation = { code: 'UI_SUBGRAPH_INPUT_MISMATCH', message: '节点 105 的子图输入数量不一致。' }
    await executeTool(run.piCustomTools, 'canvas_update_media_config', {
      canvasId: 'canvas-1', nodeId: 'video-1', baseRevision: 3, expectedConfigRevision: 2, preparation,
    })
    expect(fixture.canvasMediaInputs.at(-1)).toMatchObject({ operation: 'save', input: {
      preparation, profile: { profileId: 'profile-1', profileRevision: 1 }, inputs: [],
      outputs: [{ key: 'primary', mediaKind: 'video', role: 'primary', order: 0 }],
    } })
    expect(fixture.canvasMediaInputs.filter((entry) => entry.operation === 'run')).toHaveLength(0)
    await expect(executeTool(run.piCustomTools, 'canvas_update_media_config', {
      canvasId: 'canvas-1', nodeId: 'video-1', baseRevision: 3, expectedConfigRevision: 1, preparation,
    })).rejects.toThrow('CANVAS_MEDIA_CONFIG_CONFLICT')
  })

  test('Given 父编排 child 创建产物 When 登记动态后继 Then 只传 Host 创建结果且登记失败保留创建事实', async () => {
    const fixture = createFixture()
    const context: CanvasToolRunContext = { ...fixture.context, canvasAgentMode: 'parent-orchestrated',
      canvasAgentTarget: { ...target, nodeId: 'agent-1' }, parentWorkflow: { runId: 'workflow-1', parentSessionId: 'parent-1' } }
    const run = createCanvasToolRun(fixture.dependencies, context)
    for (const [toolName, extra] of [
      ['canvas_create_media', { mediaKind: 'video' }],
      ['canvas_create_artifact', { artifactType: 'document', content: '# 交付' }],
      ['canvas_import_image', { localPath: '/authorized/reference.png' }],
    ] as const) {
      const result = await executeTool(run.piCustomTools, toolName, {
        canvasId: target.canvasId, baseRevision: 3, title: '新产物', ...extra,
      }, 'trusted-create-call')
      expect(result.details).toMatchObject({ workflowRegistration: { status: 'registered', workflowRunId: 'workflow-1' } })
    }
    expect(fixture.successorRegistrationInputs).toEqual([
      { runContext: context, input: { ...target, nodeId: 'artifact-created', sourceToolCallId: 'trusted-create-call' } },
      { runContext: context, input: { ...target, nodeId: 'artifact-created', sourceToolCallId: 'trusted-create-call' } },
      { runContext: context, input: { ...target, nodeId: 'image-imported', sourceToolCallId: 'trusted-create-call' } },
    ])
    fixture.dependencies.workflowExecution.registerCreatedSuccessor = async () => { throw new Error('DISK_ERROR_WITH_PRIVATE_PATH') }
    fixture.dependencies.workflowExecution.recordCreatedSuccessorRegistrationFailure = async () => ({
      status: 'blocked', workflowRunId: 'workflow-1', workflowRunRevision: 3,
      reasonCode: 'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_REGISTRATION_FAILED',
    })
    const created = await executeTool(run.piCustomTools, 'canvas_create_media', {
      canvasId: target.canvasId, baseRevision: 3, title: '旁白', mediaKind: 'audio',
    })
    expect(created.details).toMatchObject({ nodeId: 'artifact-created', workflowRegistration: {
      status: 'blocked', workflowRunRevision: 3,
      reasonCode: 'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_REGISTRATION_FAILED',
    } })
    expect(JSON.stringify(created)).not.toContain('PRIVATE_PATH')
  })

  test('Given 父工作流 child When 用结构批次创建未登记节点 Then 批次执行前拒绝', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, { ...fixture.context, canvasAgentMode: 'parent-orchestrated',
      canvasAgentTarget: { ...target, nodeId: 'agent-1' }, parentWorkflow: { runId: 'workflow-1', parentSessionId: 'parent-1' } })
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: target.canvasId, baseRevision: 3,
      operations: [{ type: 'upsert-nodes', nodes: [{ id: 'unregistered', kind: 'image', title: '绕过',
        imageModuleId: 'unregistered-image', position: { x: 0, y: 0 } }] }],
    })).rejects.toThrow('CANVAS_WORKFLOW_SUCCESSOR_USE_CREATE_TOOL')
    expect(fixture.batchInputs).toEqual([])
  })

  test('Given 媒体候选与活动运行 When Agent 采用并取消 Then 两项操作都绑定权威节点模块身份', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [{ id: 'audio-1', kind: 'audio', title: '旁白', position: { x: 0, y: 0 }, mediaModuleId: 'media-audio-1' }],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await executeTool(run.piCustomTools, 'canvas_adopt_media_candidate', {
      canvasId: 'canvas-1', nodeId: 'audio-1', expectedConfigRevision: 2,
      candidateId: 'candidate-1', selectedKeys: ['primary'],
    })
    await executeTool(run.piCustomTools, 'canvas_cancel_media_run', {
      canvasId: 'canvas-1', nodeId: 'audio-1', runId: 'run-audio-1', cancelIntent: 'explicit',
    })

    expect(fixture.canvasMediaInputs.filter((entry) => ['adopt', 'cancel'].includes(entry.operation)))
      .toEqual([
        expect.objectContaining({ operation: 'adopt', input: expect.objectContaining({ mediaModuleId: 'media-audio-1' }) }),
        expect.objectContaining({ operation: 'cancel', input: expect.objectContaining({ input: expect.objectContaining({ mediaModuleId: 'media-audio-1' }) }) }),
      ])
  })

  test('Given 普通 Agent 已有成功独立 run When 显式挂接既有 AV 节点 Then Host 传入真实 actor 且不返回资产标识', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [{ id: 'video-1', kind: 'video', title: '主片', position: { x: 0, y: 0 }, mediaModuleId: 'media-video-1' }],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_attach_media_run', {
      canvasId: 'canvas-1', nodeId: 'video-1', expectedConfigRevision: 2, runId: 'independent-run-1',
    })

    expect(fixture.canvasMediaInputs.at(-1)).toEqual({
      operation: 'attach',
      input: {
        input: { ...target, nodeId: 'video-1', mediaModuleId: 'media-video-1', mediaKind: 'video', expectedConfigRevision: 2, runId: 'independent-run-1' },
        actor: { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' },
      },
    })
    expect(result.details).toMatchObject({ candidateId: 'candidate:independent-run-1', runId: 'independent-run-1', adopted: false })
    expect(JSON.stringify(result.details)).not.toContain('attached-asset')

    const parent = createCanvasToolRun(fixture.dependencies, {
      ...fixture.context,
      sessionId: 'canvas-agent-session-1',
      canvasAgentMode: 'parent-orchestrated',
      canvasAgentTarget: { ...target, nodeId: 'agent-1' },
    })
    expect(parent.allowedToolNames).not.toContain('canvas_attach_media_run')
    expect(parent.piCustomTools.some((tool) => tool.name === 'canvas_attach_media_run')).toBe(false)
  })

  test('Given 当前会话导入的音视频 When 回填画布 Then 绑定 Host 身份且工具重放复用 operationId', async () => {
    /** 模拟本地导入后的精确资产引用和可观察调用。 */
    const fixture = createFixture()
    const asset = { assetId: 'local-asset', revision: 1, hash: 'a'.repeat(64), mediaKind: 'video' as const }
    const calls: unknown[] = []
    fixture.dependencies.documents.load = () => ({
      document: { ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [{ id: 'video-1', kind: 'video', title: '成片', position: { x: 0, y: 0 }, mediaModuleId: 'media-video-1' }] },
      writable: true, nodeIssues: [],
    })
    fixture.dependencies.canvasMedia.attachImportedAssets = async (input, actor) => {
      calls.push(structuredClone({ input, actor }))
      return { id: 'candidate:local-receipt', operationId: input.operationId, runId: 'local-receipt',
        sourceConfigRevision: input.expectedConfigRevision, createdAt: 1,
        source: { kind: 'local-import', operationId: input.operationId, sourceSessionId: actor.sessionId },
        outputs: [{ key: 'primary', mediaKind: 'video', role: 'primary', order: 0, asset }] }
    }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const params = { canvasId: target.canvasId, nodeId: 'video-1', expectedConfigRevision: 2,
      outputs: [{ key: 'primary', asset }] }
    const result = await executeTool(run.piCustomTools, 'canvas_attach_media_assets', params, 'local-attach-call')
    await executeTool(run.piCustomTools, 'canvas_attach_media_assets', params, 'local-attach-call')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(calls[0]).toEqual({ input: { ...target, nodeId: 'video-1', mediaModuleId: 'media-video-1',
      mediaKind: 'video', expectedConfigRevision: 2, operationId: expect.any(String), outputs: params.outputs },
    actor: { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' } })
    expect(result.details).toMatchObject({ candidateId: 'candidate:local-receipt', sourceKind: 'local-import', adopted: false })
    expect(JSON.stringify(result.details)).not.toContain('local-asset')
    expect(fixture.runInputs).toEqual([])
    expect(fixture.canvasMediaInputs).toEqual([])

    await expect(executeTool(run.piCustomTools, 'canvas_attach_media_assets', {
      ...params, outputs: [{ key: 'primary', asset: { ...asset, hash: 'invalid' } }],
    })).rejects.toThrow('CANVAS_MEDIA_INPUT_INVALID')
    const plan = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(plan.piCustomTools, 'canvas_attach_media_assets', params)).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(calls).toHaveLength(2)

    const manual = createCanvasToolRun(fixture.dependencies, { ...fixture.context,
      canvasAgentTarget: { ...target, nodeId: 'agent-1' }, canvasAgentMode: 'renderer-manual' })
    expect(manual.allowedToolNames).toContain('canvas_attach_media_assets')
    const parent = createCanvasToolRun(fixture.dependencies, { ...fixture.context,
      canvasAgentTarget: { ...target, nodeId: 'agent-1' }, canvasAgentMode: 'parent-orchestrated' })
    expect(parent.allowedToolNames).not.toContain('canvas_attach_media_assets')
  })

  test('Given 新建 Agent 尚无输出 When 读取并配置后首次运行 Then 返回配置版本与执行能力且不伪造正文', async () => {
    /** 首次输出尚不存在，配置仍是可独立读取与更新的正式事实。 */
    const fixture = createFixture({ agentWithoutOutput: true })
    const readOutput = spyOn(fixture.dependencies.agentOutputs, 'read')
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['agent-1'] })
    const details = result.details as { revision: number; nodes: Array<{
      content: string; capabilities: string[]; readError?: unknown
      artifact: { configRevision: number }
      availableActions: Array<{ toolNames: string[] }>
      evidence: Array<{ validation: string }>
    }> }
    const entry = details.nodes[0]!
    expect(entry.readError).toBeUndefined()
    expect(entry.content).toBe('')
    expect(entry.artifact.configRevision).toBe(4)
    expect(entry.evidence.map(proof => proof.validation)).toEqual(['configuration'])
    expect(entry.availableActions.flatMap(action => action.toolNames)).toEqual(expect.arrayContaining([
      'canvas_update_agent_config', 'canvas_run_agent',
    ]))
    expect(readOutput).not.toHaveBeenCalled()
    await executeTool(run.piCustomTools, 'canvas_update_agent_config', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedGraphRevision: details.revision,
      expectedConfigRevision: entry.artifact.configRevision, patch: { instruction: '完成导演方案，先不生成媒体' },
    })
    await executeTool(run.piCustomTools, 'canvas_run_agent', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: details.revision,
      instruction: '读取简报并交付导演方案',
    })
    expect(fixture.agentConfigUpdateInputs).toHaveLength(1)
    expect(fixture.agentExecutionInputs).toHaveLength(1)
    expect(fixture.runInputs).toHaveLength(0)
  })

  test('Given Agent 已有正式指针但正文损坏 When 读取 Then 保留 agent-output 故障且不冒充空草稿', async () => {
    /** 已发布但失效的输出必须继续沿严格校验路径处理。 */
    const fixture = createFixture()
    fixture.dependencies.agentOutputs.read = async () => { throw new Error('CANVAS_AGENT_OUTPUT_INVALID') }
    const readConfig = spyOn(fixture.dependencies.agentConfigs, 'load')
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['agent-1'] })
    expect(result.details).toMatchObject({ complete: false, nodes: [{
      content: '', capabilities: ['read'],
      readError: { code: 'CANVAS_NODE_READ_FAILED', stage: 'agent-output', contentVerdict: 'unknown' },
    }] })
    expect(readConfig).not.toHaveBeenCalled()
    expect((result.details as { nodes: Array<{ evidence?: unknown }> }).nodes[0]?.evidence).toBeUndefined()
  })

  test('Given 未运行 Agent 配置读取失败 When 读取 Then 精确报告 agent-config 阶段', async () => {
    /** 空输出不阻挡配置读取，但真实配置故障仍须报告。 */
    const fixture = createFixture({ agentWithoutOutput: true })
    fixture.dependencies.agentConfigs.load = async () => { throw new Error('CANVAS_AGENT_CONFIG_INVALID') }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['agent-1'] })
    expect(result.details).toMatchObject({ complete: false, nodes: [{
      capabilities: ['read'], readError: { stage: 'agent-config', contentVerdict: 'unknown' },
    }] })
  })

  test('Given plan 上限下的新建 Agent When 读取空输出节点 Then 可读配置但不提供执行动作', async () => {
    /** 恢复正常读取不改变本轮权限上限。 */
    const fixture = createFixture({ agentWithoutOutput: true })
    const run = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    const result = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['agent-1'] })
    const entry = (result.details as { nodes: Array<{ readError?: unknown; artifact: { configRevision: number }; availableActions: Array<{ toolNames: string[] }> }> }).nodes[0]!
    expect(entry.readError).toBeUndefined()
    expect(entry.artifact.configRevision).toBe(4)
    expect(entry.availableActions.flatMap(action => action.toolNames)).not.toContain('canvas_run_agent')
    expect(entry.availableActions.flatMap(action => action.toolNames)).not.toContain('canvas_update_agent_config')
  })

  test('Given Agent 节点已有权威正式输出 When canvas_read Then 返回验证正文且统一受32768字符预算约束', async () => {
    const fixture = createFixture({ agentOutput: '中'.repeat(40_000) })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['agent-1'],
    })
    const details = result.details as {
      nodes: Array<{ content: string; contentLength: number }>
      truncated: boolean
    }

    expect(details.nodes[0]?.contentLength).toBe(40_000)
    expect(details.nodes[0]?.content.length).toBeLessThan(40_000)
    expect(details.truncated).toBe(true)
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(32_768)
  })

  test('Given 已有 Agent 配置 When 读取后局部更新 Then 使用返回的图与配置版本且正文独立于职责', async () => {
    /** 现有配置只允许从 canvas_read 的权威结果取得写入基线。 */
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['agent-1'] })
    const details = result.details as { revision: number; nodes: Array<{ artifact: { configRevision: number } }> }
    expect(result.details).toMatchObject({ nodes: [{
      content: 'Agent 正式输出',
      artifact: {
        kind: 'agent', configRevision: 4,
        config: { instruction: '长期职责', skillNames: ['research'], channelId: 'channel-1', modelId: 'model-1' },
      },
    }] })
    expect(JSON.stringify(result.details)).not.toContain('"prompt"')
    const updated = await executeTool(run.piCustomTools, 'canvas_update_agent_config', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedGraphRevision: details.revision,
      expectedConfigRevision: details.nodes[0]!.artifact.configRevision, patch: { instruction: '更新职责' },
    })
    expect(updated.details).toMatchObject({ configRevision: 5, instruction: '更新职责', skillNames: ['research'] })
    expect(fixture.agentConfigUpdateInputs).toEqual([{
      ...target, nodeId: 'agent-1', expectedGraphRevision: 3, expectedConfigRevision: 4,
      patch: { instruction: '更新职责' },
    }])
  })

  test('Given 多个 Agent 职责占满响应预算 When 读取 Then 可省略配置但始终保留每个配置版本', async () => {
    /** 配置正文与正式输出共享预算，不能随节点数线性扩大发送体积。 */
    const fixture = createFixture()
    const document = fixture.dependencies.documents.load(target).document
    const nodes = Array.from({ length: 32 }, (_, index) => ({
      id: `agent-${index}`, kind: 'agent' as const, title: `Agent ${index}`, position: { x: index, y: 0 },
      agentSessionId: `agent-session-${index}`,
    }))
    fixture.dependencies.documents.load = () => ({ document: { ...document, nodes, edges: [] }, writable: true, nodeIssues: [] })
    fixture.dependencies.agentConfigs.load = async (input) => ({
      schemaVersion: 1, ...input, revision: 9, instruction: 'I'.repeat(8_192),
      skillNames: ['research'], channelId: null, modelId: null, updatedAt: 1,
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: nodes.map((node) => node.id) })
    const details = result.details as { nodes: Array<{ artifact: { configRevision: number; configOmitted?: boolean } }>; truncated: boolean }
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(32_768)
    expect(details.nodes).toHaveLength(32)
    expect(details.nodes.every((entry) => entry.artifact.configRevision === 9)).toBe(true)
    expect(details.nodes.some((entry) => entry.artifact.configOmitted)).toBe(true)
    expect(details.truncated).toBe(true)
  })

  test('Given 四类节点且 Agent 会话不可用 When canvas_read Then 每个条目公开当前派生能力且不可用节点没有 run', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [
          { id: 'agent-1', kind: 'agent', title: '策划', position: { x: 0, y: 0 }, agentSessionId: 'canvas-agent-session-1' },
          { id: 'image-1', kind: 'image', title: '主视觉', position: { x: 50, y: 0 }, imageModuleId: 'image-content-1' },
          { id: 'doc-1', kind: 'document', title: '需求', position: { x: 100, y: 0 }, documentId: 'content-1', contentRevision: 2 },
          { id: 'web-1', kind: 'webview', title: '原型', position: { x: 150, y: 0 }, prototypeId: 'prototype-1', contentRevision: 1, devicePreset: 'desktop' },
        ],
      },
      writable: true,
      nodeIssues: [{ nodeId: 'agent-1', code: 'AGENT_SESSION_UNAVAILABLE', allowedActions: ['rebuild-agent-session', 'remove-node'] }],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['agent-1', 'image-1', 'doc-1', 'web-1'],
    })
    const entries = (result.details as {
      nodes: Array<{ node: { id: string }; capabilities: string[] }>
    }).nodes

    expect(entries.map((entry) => [entry.node.id, entry.capabilities])).toEqual([
      ['agent-1', ['read', 'update-config']],
      ['image-1', ['read', 'preview', 'update-config', 'run', 'review-required']],
      ['doc-1', ['read', 'update-content']],
      ['web-1', ['read', 'update-content']],
    ])
    expect(entries[0]).toMatchObject({ issue: {
      nodeId: 'agent-1', code: 'AGENT_SESSION_UNAVAILABLE', allowedActions: ['rebuild-agent-session', 'remove-node'],
    } })
  })

  test('Given 调用方伪造 capability When 更新错误类型或旧版本产物 Then Host 仍拒绝类型与 revision', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_update_artifact', {
      canvasId: 'canvas-1', nodeId: 'agent-1', baseRevision: 3,
      expectedContentRevision: 1, content: '伪造正文', capabilities: ['update-content'],
    })).rejects.toThrow('CANVAS_ARTIFACT_TYPE_UNSUPPORTED')
    await expect(executeTool(run.piCustomTools, 'canvas_update_artifact', {
      canvasId: 'canvas-1', nodeId: 'doc-1', baseRevision: 2,
      expectedContentRevision: 2, content: '伪造正文', capabilities: ['update-content'],
    })).rejects.toThrow('CANVAS_ARTIFACT_REVISION_CONFLICT')
    expect(fixture.textUpdateInputs).toHaveLength(0)
  })

  test('Given 手动和父编排 Canvas Agent When 读取节点能力 Then 只声明本轮可调用操作', async () => {
    const fixture = createFixture()
    const dependencies = { ...fixture.dependencies, operations: createAllOperationHandlers() }
    for (const canvasAgentMode of ['renderer-manual', 'parent-orchestrated'] as const) {
      const run = createCanvasToolRun(dependencies, {
        ...fixture.context,
        canvasAgentTarget: { ...target, nodeId: 'agent-1' }, canvasAgentMode,
      })
      const result = await executeTool(run.piCustomTools, 'canvas_read', {
        canvasId: 'canvas-1', nodeIds: ['agent-1', 'image-1'],
      })
      const entries = (result.details as { nodes: Array<{ capabilities: string[] }> }).nodes
      expect(entries[0]!.capabilities).toEqual(['read'])
      expect(entries[1]!.capabilities).toContain('preview')
      expect(entries[1]!.capabilities).toContain('task-status')
      expect(entries[1]!.capabilities).toContain('versions')
      expect(entries[1]!.capabilities.includes('task-control')).toBe(canvasAgentMode === 'renderer-manual')
      expect(entries[1]!.capabilities.includes('adopt-version')).toBe(canvasAgentMode === 'renderer-manual')
      expect(entries[1]!.capabilities.includes('export')).toBe(canvasAgentMode === 'renderer-manual')
      expect(entries[1]!.capabilities.includes('run')).toBe(canvasAgentMode === 'renderer-manual')
    }
  })

  test('Given plan 上限 When 读取节点能力 Then 不宣告执行和内容修改但仍可预览', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    const result = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['agent-1', 'image-1', 'doc-1'],
    })
    const entries = (result.details as { nodes: Array<{ capabilities: string[] }> }).nodes
    for (const entry of entries) {
      expect(entry.capabilities).not.toContain('run')
      expect(entry.capabilities).not.toContain('update-config')
      expect(entry.capabilities).not.toContain('update-content')
    }
    expect(entries.some((entry) => entry.capabilities.includes('preview'))).toBe(true)
  })

  test('Given 调用方缓存 apply capability When 批处理使用旧 revision Then Host 仍执行权威 revision 校验', async () => {
    const fixture = createFixture({ conflictAlways: true })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 2,
      operations: [{ type: 'set-title', nodeId: 'doc-1', title: '新版需求' }],
      capabilities: ['update-content'],
    })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
    expect(fixture.batchInputs).toHaveLength(1)
  })

  test('Given 只读分析 When 读取节点 Then 返回必要邻接、限制总字符并拒绝未关联画布', async () => {
    const fixture = createFixture()
    fixture.dependencies.textArtifacts.read = async (input) => ({
      target: input,
      revision: {
        kind: input.kind, contentId: input.contentId, revision: input.contentRevision,
        parentRevision: input.contentRevision - 1, contentHash: 'a'.repeat(64),
        createdBy: { type: 'user' as const }, createdAt: 1,
      },
      content: 'A'.repeat(40_000),
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['doc-1'], includeNeighbors: true })
    expect(result.details).toMatchObject({ canvasId: 'canvas-1', revision: 3, truncated: true })
    expect(JSON.stringify(result.details).length).toBeLessThan(40_000)
    await expect(executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'foreign-canvas', nodeIds: ['doc-1'] })).rejects.toThrow('CANVAS_ACCESS_DENIED')
  })

  test('Given 高连接度节点 When 读取邻接 Then 节点和边共同受 32 节点预算约束', async () => {
    const fixture = createFixture()
    /** 构造一个中心节点连接 40 个邻居的权威文档。 */
    const neighborNodes = Array.from({ length: 40 }, (_, index) => ({
      id: `image-${index}`, kind: 'image' as const, title: `图片 ${index}`,
      position: { x: index, y: 0 }, imageModuleId: `module-${index}`,
    }))
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [
          { id: 'doc-1', kind: 'document', title: '中心', position: { x: 0, y: 0 }, documentId: 'content-1', contentRevision: 1 },
          ...neighborNodes,
        ],
        edges: neighborNodes.map((node, index) => ({
          id: `edge-${index}`, sourceNodeId: 'doc-1', sourcePort: 'output', targetNodeId: node.id, targetPort: 'input', relation: 'association',
        })),
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['doc-1'], includeNeighbors: true,
    })
    const details = result.details as { nodes: Array<{ node: { id: string } }>; edges: Array<{ sourceNodeId: string; targetNodeId: string }> }
    const returnedNodeIds = new Set(details.nodes.map((entry) => entry.node.id))
    expect(details.nodes.length).toBeLessThanOrEqual(32)
    expect(details.edges.every((edge) => returnedNodeIds.has(edge.sourceNodeId) && returnedNodeIds.has(edge.targetNodeId))).toBe(true)
    expect(result.details).toMatchObject({ complete: false, omittedEdgeCount: 9, truncated: true })
  })

  test('Given 31 个图片节点各有 1024 条任务且末尾为文档 When 读取 Then 完整响应受 32K 预算且保留末尾 revision 摘要', async () => {
    const fixture = createFixture()
    /** 末尾文档用于证明前序图片历史耗尽预算后仍保留 revision 语义。 */
    const imageNodes = Array.from({ length: 31 }, (_, index) => ({
      id: `image-${index}`, kind: 'image' as const, title: `图片节点 ${index}`,
      position: { x: index * 10, y: 0 }, imageModuleId: `module-${index}`,
    }))
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 9,
        nodes: [
          ...imageNodes,
          { id: 'doc-last', kind: 'document', title: '末尾需求', position: { x: 320, y: 0 }, documentId: 'content-last', contentRevision: 7 },
        ],
      },
      writable: true,
      nodeIssues: [],
    })
    fixture.dependencies.images.load = async (imageTarget) => ({
      target: imageTarget,
      mediaLeaseId: 'unused',
      config: {
        schemaVersion: 2, kind: 'image', contentId: imageTarget.imageModuleId, revision: 8,
        createdAt: 1, updatedAt: 2, prompt: 'P'.repeat(4_000), selectedModelProfileId: 'model-1',
        aspectRatio: '16:9', imageSize: '2K', contextMode: 'project', adoptedAssetId: null,
      },
      jobs: Array.from({ length: 1_024 }, (_, index): DesignJobRecord => ({
        id: `job-${imageTarget.nodeId}-${index}-${'x'.repeat(64)}`,
        creativeTaskId: `task-${index}`, attemptNumber: 1, projectId: imageTarget.projectId,
        action: 'generate', status: 'succeeded', prompt: 'prompt', originalRequest: 'request',
        contextMode: 'project', canvasImageConfigRevision: index + 1,
        outputAssetId: `asset-${index}-${'y'.repeat(64)}`, createdAt: index, updatedAt: index,
      })),
      assets: [], assetBaseUrl: '', thumbnailBaseUrl: '',
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1',
      nodeIds: [...imageNodes.map((node) => node.id), 'doc-last'],
    })
    const details = result.details as {
      truncated: boolean
      nodes: Array<{ node: { id: string }; artifact?: { currentRevision?: number } }>
    }

    expect(JSON.stringify(details).length).toBeLessThanOrEqual(32_768)
    const transmitted = result.content[0]
    if (transmitted?.type !== 'text') throw new Error('canvas_read 未返回文本内容')
    expect(transmitted.text.length).toBeLessThanOrEqual(32_768)
    expect(details.truncated).toBe(true)
    expect(details.nodes.at(-1)).toMatchObject({
      node: { id: 'doc-last' }, artifact: { currentRevision: 7 },
    })
    expect(fixture.runInputs).toHaveLength(0)
  })

  test('Given 模型自报 explicitSelection When link 任意同项目 Canvas Then 不得扩大权威访问集合', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(run.piCustomTools, 'canvas_manage', { action: 'link', canvasId: 'created-canvas' })).rejects.toThrow('CANVAS_EXPLICIT_SELECTION_REQUIRED')
    await expect(executeTool(run.piCustomTools, 'canvas_manage', {
      action: 'link', canvasId: 'created-canvas', explicitSelection: true,
    })).rejects.toThrow('CANVAS_EXPLICIT_SELECTION_REQUIRED')
    const existing = await executeTool(run.piCustomTools, 'canvas_manage', { action: 'link', canvasId: 'canvas-1' })
    expect(existing.details).toMatchObject({ action: 'link', canvasId: 'canvas-1' })
  })

  test('Given execute Agent 无默认画布 When 同一 create tool call 跨 Provider 重放 Then 持久复用同一 Canvas 且只绑定一次', async () => {
    const fixture = createFixture({ noDefaultCanvas: true })
    const firstRun = createCanvasToolRun(fixture.dependencies, fixture.context)
    const first = await executeTool(firstRun.piCustomTools, 'canvas_manage', {
      action: 'create', title: '执行画布', makeDefault: true,
    }, 'tool-create-1')
    const replayRun = createCanvasToolRun(fixture.dependencies, fixture.context)
    const replay = await executeTool(replayRun.piCustomTools, 'canvas_manage', {
      action: 'create', title: '执行画布', makeDefault: true,
    }, 'tool-create-1')

    expect((first.details as { canvasId: string }).canvasId).toBe((replay.details as { canvasId: string }).canvasId)
    expect((first.details as { canvasId: string }).canvasId).toMatch(/^agent-canvas-[0-9a-f]{64}$/)
    expect(fixture.getCreateCalls()).toBe(2)
    expect(fixture.getLinkCalls()).toBe(1)
    expect(fixture.getListCalls()).toBe(0)
  })

  test('Given plan 或项目路径授权失效 When 创建 Canvas Then 禁止持久副作用且 fresh call fail closed', async () => {
    const planFixture = createFixture({ noDefaultCanvas: true })
    const plan = createCanvasToolRun(planFixture.dependencies, {
      ...planFixture.context, permissionCeiling: 'plan',
    })
    await expect(executeTool(plan.piCustomTools, 'canvas_manage', { action: 'create' }, 'tool-plan-create'))
      .rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(planFixture.getCreateCalls()).toBe(0)
    expect(planFixture.getLinkCalls()).toBe(0)

    const revoked = createFixture({ noDefaultCanvas: true, createCanvasError: new Error('项目路径不可访问') })
    for (const toolCallId of ['tool-revoked-1', 'tool-revoked-2']) {
      const run = createCanvasToolRun(revoked.dependencies, revoked.context)
      await expect(executeTool(run.piCustomTools, 'canvas_manage', { action: 'create' }, toolCallId))
        .rejects.toThrow('项目路径不可访问')
    }
    expect(revoked.getCreateCalls()).toBe(2)
    expect(revoked.getLinkCalls()).toBe(0)
  })

  test('Given 项目授权在运行后撤销 When 十五工具 fresh execute Then 全部在 Store、batch 与 run 前拒绝', async () => {
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'canvas_get_context', args: {} },
      { name: 'canvas_manage', args: { action: 'create' } },
      { name: 'canvas_read', args: { canvasId: 'canvas-1', nodeIds: ['doc-1'] } },
      { name: 'canvas_apply_changes', args: { canvasId: 'canvas-1', baseRevision: 3, operations: [{ type: 'set-viewport', viewport: { x: 0, y: 0, zoom: 1 } }] } },
      { name: 'canvas_create_agent', args: { canvasId: 'canvas-1', baseRevision: 3, title: '分镜 Agent' } },
      { name: 'canvas_import_image', args: { canvasId: 'canvas-1', baseRevision: 3, title: '角色三视图', localPath: 'reference.png' } },
      { name: 'canvas_create_artifact', args: { canvasId: 'canvas-1', baseRevision: 3, artifactType: 'webview', title: '原型', content: '<!doctype html><html></html>' } },
      { name: 'canvas_update_artifact', args: { canvasId: 'canvas-1', nodeId: 'web-1', baseRevision: 3, expectedContentRevision: 1, content: '<main>新版</main>' } },
      { name: 'canvas_update_image_config', args: { canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3, expectedConfigRevision: 4, aspectRatio: '3:4' } },
      { name: 'canvas_update_agent_config', args: { canvasId: 'canvas-1', nodeId: 'agent-1', expectedGraphRevision: 3, expectedConfigRevision: 4, patch: { instruction: '职责' } } },
      { name: 'canvas_run_agent', args: { canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3, instruction: '执行' } },
      { name: 'canvas_run_nodes', args: { canvasId: 'canvas-1', nodeIds: ['image-1'] } },
    ]
    for (const entry of cases) {
      const fixture = createFixture()
      const dependencies = {
        ...fixture.dependencies,
        access: {
          authorizeRead: () => { throw new Error('PROJECT_ACCESS_REVOKED') },
          getBinding: () => { throw new Error('STORE_MUST_NOT_RUN') },
          requireLinkedCanvas: () => { throw new Error('STORE_MUST_NOT_RUN') },
          runWrite: () => { throw new Error('WRITE_MUST_NOT_RUN') },
          createAndLink: () => { throw new Error('STORE_MUST_NOT_RUN') },
          link: () => { throw new Error('STORE_MUST_NOT_RUN') },
          unlink: () => { throw new Error('STORE_MUST_NOT_RUN') },
          setDefault: () => { throw new Error('STORE_MUST_NOT_RUN') },
        },
      } as CanvasToolProviderDependencies
      const run = createCanvasToolRun(dependencies, fixture.context)
      await expect(executeTool(run.piCustomTools, entry.name, entry.args, `revoked-${entry.name}`))
        .rejects.toThrow('PROJECT_ACCESS_REVOKED')
      expect(fixture.batchInputs).toEqual([])
      expect(fixture.runInputs).toEqual([])
      expect(fixture.getCreateCalls()).toBe(0)
    }
  })

  test('Given execute-capable 与 plan 权限上限 When apply_changes Then host 不解析消息且 plan 只允许新增 idle 结构', async () => {
    const fixture = createFixture()
    const executeCapable = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(executeCapable.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3,
      operations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    })).resolves.toMatchObject({ details: { revision: 4 } })

    const planFixture = createFixture()
    const plan = createCanvasToolRun(planFixture.dependencies, { ...planFixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(plan.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3,
      operations: [{ type: 'upsert-nodes', nodes: [{
        id: 'doc-new', kind: 'document', title: '计划', position: { x: 0, y: 0 }, documentId: 'content-new', contentRevision: 0,
      }] }],
    })).resolves.toMatchObject({ details: { revision: 4 } })
    await expect(executeTool(plan.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 4,
      operations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
  })

  test('Given Agent 猜测单条加边操作 When 真实 apply_changes 参数校验 Then 返回字段路径和批量示例且零写入', () => {
    /** 验证最终 Provider 而非独立 schema，防止装配时退回 unknown。 */
    const fixture = createFixture()
    const tool = createCanvasToolRun(fixture.dependencies, fixture.context).piCustomTools
      .find((candidate) => candidate.name === 'canvas_apply_changes')!
    const invalid = {
      canvasId: 'canvas-1', baseRevision: 3,
      operations: [{ type: 'add-edge', edge: {
        sourceNodeId: 'image-1', targetNodeId: 'video-1',
      } }],
    }

    expect(Value.Check(tool.parameters, invalid)).toBeFalse()
    expect(() => validateToolArguments(tool, {
      type: 'toolCall', id: 'invalid-add-edge', name: tool.name, arguments: invalid,
    })).toThrow(/operations\.0\.edges/)
    expect(tool.description).toContain('"type":"upsert-edges"')
    expect(tool.description).toContain('"targetPort":"context.image"')
    expect(fixture.batchInputs).toEqual([])
  })

  test('Given Agent 有运行权限 When 尝试改写媒体模型范围 Then 拒绝自动扩大用户范围', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', { canvasId: 'canvas-1', baseRevision: 3,
      operations: [{ type: 'set-media-model-scope', scope: { mode: 'all-enabled' } }] })).rejects.toThrow('CANVAS_MEDIA_MODEL_SCOPE_USER_MANAGED')
    expect(fixture.batchInputs).toHaveLength(0)
  })

  test('Given Agent 有运行权限 When 尝试改写画布 ComfyUI 连接 Then 保留用户绑定', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', { canvasId: 'canvas-1', baseRevision: 3,
      operations: [{ type: 'set-comfyui-connection', connectionId: 'other-server' }] })).rejects.toThrow('CANVAS_COMFYUI_CONNECTION_USER_MANAGED')
    expect(fixture.batchInputs).toHaveLength(0)
  })

  test('Given 删除意图模糊或明确 When apply Then 模糊拒绝，明确返回 revision/task identity', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const args = { canvasId: 'canvas-1', baseRevision: 3, operations: [{ type: 'remove-nodes', nodeIds: ['doc-1'] }] }
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', args)).rejects.toThrow('CANVAS_DESTRUCTIVE_INTENT_REQUIRED')
    const result = await executeTool(run.piCustomTools, 'canvas_apply_changes', { ...args, destructiveIntent: 'explicit' }, 'task-tool-1')
    expect(fixture.batchInputs).toHaveLength(1)
    expect(result.details).toMatchObject({ revision: 4, operationId: 'operation-1', sourceToolCallId: 'task-tool-1' })
  })

  test('Given 首次 revision 冲突 When apply Then 权威重读后只重试一次', async () => {
    const fixture = createFixture({ conflictOnce: true })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_apply_changes', { canvasId: 'canvas-1', baseRevision: 3, operations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }] }, 'task-tool-conflict')
    expect(fixture.batchInputs.map((input) => input.baseRevision)).toEqual([3, 4])
    expect(result.details).toMatchObject({ revision: 5, sourceToolCallId: 'task-tool-conflict-retry' })
  })

  test('Given 审核后用户修改了节点 When 按旧基线删除或覆盖 Then 抛出冲突且不自动换基线提交', async () => {
    for (const conflictAt of ['validation', 'commit'] as const) {
      for (const operation of [
        { type: 'remove-nodes', nodeIds: ['doc-1'] },
        { type: 'upsert-nodes', nodes: [{ id: 'doc-1', kind: 'document', title: '修复后的需求',
          position: { x: 100, y: 0 }, documentId: 'content-1', contentRevision: 2 }] },
      ]) {
        /** 分别覆盖进入事务前已过期和提交期间发生竞争的两种旧证据路径。 */
        const fixture = createFixture({ conflictOnce: conflictAt === 'commit' })
        const run = createCanvasToolRun(fixture.dependencies, fixture.context)
        await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
          canvasId: 'canvas-1', baseRevision: conflictAt === 'validation' ? 2 : 3,
          operations: [operation], destructiveIntent: 'explicit',
        }, 'review-replace-conflict')).rejects.toThrow('CANVAS_REVISION_CONFLICT')
        expect(fixture.batchInputs).toHaveLength(conflictAt === 'validation' ? 0 : 1)
      }
    }
  })

  test('Given 最大长度 tool call ID When revision 冲突 Then 重试身份仍满足共享协议上限', async () => {
    const fixture = createFixture({ conflictOnce: true })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3,
      operations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    }, 't'.repeat(128))
    expect((result.details as { sourceToolCallId: string }).sourceToolCallId.length).toBeLessThanOrEqual(128)
  })

  test('Given 两次 revision 冲突 When apply Then 恰好尝试两次并原样抛出第二次冲突', async () => {
    const fixture = createFixture({ conflictAlways: true })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3,
      operations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    }, 'task-tool-conflict-twice')).rejects.toThrow('CANVAS_REVISION_CONFLICT')
    expect(fixture.batchInputs).toHaveLength(2)
  })

  test('Given upsert 覆盖现有节点 When apply Then 必须声明明确破坏性意图', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const operations = [{
      type: 'upsert-nodes',
      nodes: [{ id: 'doc-1', kind: 'document', title: '覆盖需求', position: { x: 0, y: 0 }, documentId: 'content-1', contentRevision: 2 }],
    }]
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3, operations,
    })).rejects.toThrow('CANVAS_DESTRUCTIVE_INTENT_REQUIRED')
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3, operations, destructiveIntent: 'explicit',
    })).resolves.toMatchObject({ details: { revision: 4 } })
  })

  test('Given upsert 覆盖现有 edge When apply Then 必须声明明确破坏性意图', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const operations = [{
      type: 'upsert-edges',
      edges: [{ id: 'edge-1', sourceNodeId: 'image-1', sourcePort: 'output', targetNodeId: 'doc-1', targetPort: 'input', relation: 'association' }],
    }]
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3, operations,
    })).rejects.toThrow('CANVAS_DESTRUCTIVE_INTENT_REQUIRED')
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3, operations, destructiveIntent: 'explicit',
    })).resolves.toMatchObject({ details: { revision: 4 } })
  })

  test('Given plan 与 execute-capable 权限上限 When run_nodes Then 只有 execute-capable 调用执行器并传递完整幂等身份', async () => {
    const fixture = createFixture({
      runBatch: {
        batchId: 'agent-canvas-batch-stable', status: 'running', totalCount: 1,
        candidateCount: 0, failedCount: 0, runningCount: 1, requiresCanvasReview: true,
      },
    })
    const plan = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(plan.piCustomTools, 'canvas_run_nodes', { canvasId: 'canvas-1', nodeIds: ['image-1'] })).rejects.toThrow('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')
    const executeCapable = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(executeCapable.piCustomTools, 'canvas_run_nodes', { canvasId: 'canvas-1', nodeIds: ['image-1'] }, 'tool-run-1')
    expect(fixture.runInputs).toEqual([['image-1']])
    expect(fixture.runToolCallIds).toEqual(['tool-run-1'])
    expect(result.details).toMatchObject({
      canvasId: 'canvas-1', revision: 3,
      tasks: [{ nodeId: 'image-1', taskId: 'task-image-1' }],
      batch: {
        batchId: 'agent-canvas-batch-stable', status: 'running', totalCount: 1,
        candidateCount: 0, failedCount: 0, runningCount: 1, requiresCanvasReview: true,
      },
    })
    const serialized = JSON.stringify(result.details)
    expect(serialized).not.toContain('assetId')
    expect(serialized).not.toContain('已替换')
  })

  test('Given plan 权限上限 When 声明 destructiveIntent Then 仍不得覆盖已有结构', async () => {
    const fixture = createFixture()
    const plan = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(plan.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3,
      operations: [{
        type: 'upsert-nodes',
        nodes: [{ id: 'doc-1', kind: 'document', title: '覆盖', position: { x: 0, y: 0 }, documentId: 'content-1', contentRevision: 2 }],
      }],
      destructiveIntent: 'explicit',
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
  })

  test('Given 生图启动期间停止 Agent When run_nodes Then 向唯一运行服务传递取消和有界期限', async () => {
    const fixture = createFixture()
    const controller = new AbortController()
    const startedAt = Date.now()
    /** 在调用外断言，防止执行器内断言失败被当作预期取消。 */
    const runOptions: Array<{ signal: AbortSignal; deadlineAt: number } | undefined> = []
    fixture.dependencies.imageRuns.run = async (_context, _target, _nodes, _toolCallId, options) => {
      runOptions.push(options)
      controller.abort()
      options?.signal.throwIfAborted()
      return { tasks: [] }
    }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(run.piCustomTools, 'canvas_run_nodes', {
      canvasId: 'canvas-1', nodeIds: ['image-1'],
    }, 'cancel-start', controller.signal)).rejects.toThrow()
    expect(runOptions[0]?.signal).toBe(controller.signal)
    expect(runOptions[0]!.deadlineAt).toBeGreaterThanOrEqual(startedAt + 15 * 60_000)
  })

  test('Given Agent 已停止 When 迟到 run_nodes 执行 Then 不进入图片运行服务', async () => {
    const fixture = createFixture()
    const controller = new AbortController()
    controller.abort()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(run.piCustomTools, 'canvas_run_nodes', {
      canvasId: 'canvas-1', nodeIds: ['image-1'],
    }, 'already-cancelled', controller.signal)).rejects.toThrow()
    expect(fixture.runInputs).toEqual([])
  })

  test('Given execute 权限和已关联画布 When 创建产物 Then 传递受控内容与完整 Agent 来源身份', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_create_artifact', {
      canvasId: 'canvas-1',
      baseRevision: 3,
      artifactType: 'webview',
      devicePreset: 'mobile',
      title: '首页原型',
      content: '<!doctype html><html><body>首页</body></html>',
      sourceNodeId: 'doc-1',
    }, 'tool-artifact-1')

    expect(result.details).toEqual({
      canvasId: 'canvas-1',
      nodeId: 'artifact-created',
      revision: 4,
      artifactType: 'webview',
      sourceToolCallId: 'tool-artifact-1',
    })
    expect(fixture.artifactInputs).toEqual([expect.objectContaining({
      projectId: 'project-1',
      canvasId: 'canvas-1',
      devicePreset: 'mobile',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-artifact-1' },
    })])
  })

  test('Given 普通 Agent 需要画布分工 When 创建 Canvas Agent Then 创建独立节点且不暴露内部会话身份', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_create_agent', {
      canvasId: 'canvas-1', baseRevision: 3, title: '分镜策划 Agent',
      sourceNodeId: 'doc-1', relation: 'depends-on',
    }, 'tool-agent-1')

    expect(result.details).toEqual({
      canvasId: 'canvas-1', nodeId: 'agent-created', revision: 4,
      sourceToolCallId: 'tool-agent-1',
    })
    expect(JSON.stringify(result.details)).not.toContain('sessionId')
    expect(fixture.agentArtifactInputs).toEqual([expect.objectContaining({
      projectId: 'project-1', canvasId: 'canvas-1', title: '分镜策划 Agent',
      sourceNodeId: 'doc-1', relation: 'depends-on',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-agent-1' },
    })])
  })

  test('Given Agent 工作区已有参考图 When 导入 Canvas Then 创建已采用图片节点且不暴露素材身份', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_import_image', {
      canvasId: 'canvas-1', baseRevision: 3, title: 'IP 三视图',
      localPath: 'workspace-files/ip-turnaround.png', prompt: '角色一致性参考',
      sourceNodeId: 'doc-1', relation: 'reference',
    }, 'tool-import-1')

    expect(result.details).toEqual({
      canvasId: 'canvas-1', nodeId: 'image-imported', revision: 4,
      artifactType: 'image', sourceToolCallId: 'tool-import-1',
    })
    expect(JSON.stringify(result.details)).not.toContain('assetId')
    expect(fixture.importedImageInputs).toEqual([expect.objectContaining({
      projectId: 'project-1', canvasId: 'canvas-1', localPath: 'workspace-files/ip-turnaround.png',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-import-1' },
    })])
  })

  test('Given plan 权限上限 When 创建 Canvas Agent 或导入图片 Then 在服务调用前拒绝', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, {
      ...fixture.context,
      permissionCeiling: 'plan',
    })

    await expect(executeTool(run.piCustomTools, 'canvas_create_agent', {
      canvasId: 'canvas-1', baseRevision: 3, title: '分镜 Agent',
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    await expect(executeTool(run.piCustomTools, 'canvas_import_image', {
      canvasId: 'canvas-1', baseRevision: 3, title: '参考图', localPath: 'reference.png',
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(fixture.agentArtifactInputs).toEqual([])
    expect(fixture.importedImageInputs).toEqual([])
  })

  test('Given plan 权限或未关联画布 When 创建产物 Then 在原子服务前拒绝', async () => {
    const planFixture = createFixture()
    const plan = createCanvasToolRun(planFixture.dependencies, {
      ...planFixture.context,
      permissionCeiling: 'plan',
    })
    await expect(executeTool(plan.piCustomTools, 'canvas_create_artifact', {
      canvasId: 'canvas-1', baseRevision: 3, artifactType: 'image', title: '设计稿', content: '首页视觉',
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(planFixture.artifactInputs).toEqual([])

    const executeFixture = createFixture()
    const executeRun = createCanvasToolRun(executeFixture.dependencies, executeFixture.context)
    await expect(executeTool(executeRun.piCustomTools, 'canvas_create_artifact', {
      canvasId: 'foreign-canvas', baseRevision: 3, artifactType: 'webview', title: '原型', content: '<html></html>',
    })).rejects.toThrow('CANVAS_ACCESS_DENIED')
    expect(executeFixture.artifactInputs).toEqual([])
  })

  test('Given 重复节点与后置无效节点 When run_nodes Then 去重执行且任一无效时零副作用', async () => {
    const duplicateFixture = createFixture()
    const duplicateRun = createCanvasToolRun(duplicateFixture.dependencies, duplicateFixture.context)
    await executeTool(duplicateRun.piCustomTools, 'canvas_run_nodes', {
      canvasId: 'canvas-1', nodeIds: ['image-1', 'image-1'],
    })
    expect(duplicateFixture.runInputs).toEqual([['image-1']])

    const invalidFixture = createFixture()
    const invalidRun = createCanvasToolRun(invalidFixture.dependencies, invalidFixture.context)
    await expect(executeTool(invalidRun.piCustomTools, 'canvas_run_nodes', {
      canvasId: 'canvas-1', nodeIds: ['image-1', 'missing-later'],
    })).rejects.toThrow('CANVAS_NODE_NOT_FOUND')
    expect(invalidFixture.runInputs).toEqual([])
  })

  test('Given 多个有效节点 When run_nodes Then 单次交给批量运行边界且保留顺序', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [
          { id: 'image-1', kind: 'image', title: '首图', position: { x: 0, y: 0 }, imageModuleId: 'module-1' },
          { id: 'image-2', kind: 'image', title: '次图', position: { x: 100, y: 0 }, imageModuleId: 'module-2' },
        ],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_run_nodes', {
      canvasId: 'canvas-1', nodeIds: ['image-1', 'image-2'],
    }, 'tool-batch-1')).resolves.toMatchObject({
      details: { tasks: [{ nodeId: 'image-1' }, { nodeId: 'image-2' }] },
    })
    expect(fixture.runInputs).toEqual([['image-1', 'image-2']])
    expect(fixture.runToolCallIds).toEqual(['tool-batch-1'])
  })

  test('Given 独立音视频节点 When run_nodes Then 使用权威模块身份委托统一媒体服务并返回进度任务 ID', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [
          { id: 'audio-1', kind: 'audio', title: '旁白', position: { x: 0, y: 0 }, mediaModuleId: 'media-audio-1' },
          { id: 'video-1', kind: 'video', title: '主片', position: { x: 100, y: 0 }, mediaModuleId: 'media-video-1' },
        ],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_run_nodes', {
      canvasId: 'canvas-1', nodeIds: ['video-1', 'audio-1'],
    }, 'tool-media-run')

    expect(result.details).toMatchObject({
      tasks: [
        { nodeId: 'video-1', status: 'started', taskId: 'run-video-1' },
        { nodeId: 'audio-1', status: 'started', taskId: 'run-audio-1' },
      ],
    })
    expect(fixture.canvasMediaInputs.filter((entry) => entry.operation === 'run')).toHaveLength(2)
    expect(fixture.runInputs).toEqual([])
  })

  test('Given 所选媒体节点存在直接上下游 When run_nodes Then 在任何生成副作用前阻断下游', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [
          { id: 'audio-1', kind: 'audio', title: '音轨', position: { x: 0, y: 0 }, mediaModuleId: 'media-audio-1' },
          { id: 'video-1', kind: 'video', title: '成片', position: { x: 100, y: 0 }, mediaModuleId: 'media-video-1' },
        ],
        edges: [{
          id: 'edge-media', sourceNodeId: 'audio-1', sourcePort: 'audio.asset',
          targetNodeId: 'video-1', targetPort: 'audio.reference', relation: 'depends-on',
        }],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_run_nodes', {
      canvasId: 'canvas-1', nodeIds: ['audio-1', 'video-1'],
    })).rejects.toThrow('SELECTED_UPSTREAM_REGENERATING')
    expect(fixture.canvasMediaInputs).toEqual([])
    expect(fixture.runInputs).toEqual([])
  })

  test('Given webview 内容已提交 When execute run_nodes Then 返回稳定 idle 而非 unsupported', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [{ id: 'webview-1', kind: 'webview', title: '原型', position: { x: 0, y: 0 }, prototypeId: 'prototype-1', contentRevision: 1, devicePreset: 'desktop' }],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_run_nodes', { canvasId: 'canvas-1', nodeIds: ['webview-1'] })
    expect(result.details).toMatchObject({
      tasks: [{ nodeId: 'webview-1', status: 'idle' }],
    })
    expect(result.details).not.toHaveProperty('batch')
  })
})
