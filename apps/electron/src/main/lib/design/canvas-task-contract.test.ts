import { describe, expect, test } from 'bun:test'
import { createCanvasTaskContract, type CanvasTaskEvidence } from './canvas-task-contract'

/** 同一权威文档版本的最小产物证据；测试不访问真实项目。 */
const evidence: CanvasTaskEvidence = { canvasId: 'canvas', nodeId: 'doc', nodeKind: 'document', validation: 'content', identity: 'revision-1' }
const existingRequirement = {
  id: 'report', description: '报告正文', nodeId: 'doc', nodeKind: 'document' as const,
  validation: 'content' as const,
}

describe('Canvas 任务交付合同', () => {
  test('Given 新导入的图片节点 When 检查真实图片 Then created不强制额外付费生成', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    task.start('canvas', [{ id: 'import', description: '导入并检查图片', nodeKind: 'image', change: 'created', validation: 'inspection' }], {
      nodeIds: ['doc'], evidence: [],
    })
    const proof = task.record({ canvasId: 'canvas', nodeId: 'imported', nodeKind: 'image', validation: 'inspection', identity: 'imported-image' })
    expect((await task.complete([{ id: 'import', evidenceId: proof.evidenceId }], new AbortController().signal)).phase).toBe('completed')
  })

  test('Given 多批生成超过来源容量 When 提交旧来源 Then 有界淘汰且最近来源仍可核验', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    task.start('canvas', [{ id: 'image', description: '生成并检查', nodeId: 'image', nodeKind: 'image', change: 'updated', validation: 'inspection' }], {
      nodeIds: ['image'], evidence: [{ canvasId: 'canvas', nodeId: 'image', nodeKind: 'image', validation: 'inspection', absent: true }],
    })
    for (let index = 0; index < 257; index += 1) task.recordGeneratedJobs('canvas', [{ nodeId: 'image', jobId: `job-${index}` }])
    const old = task.record({ canvasId: 'canvas', nodeId: 'image', nodeKind: 'image', validation: 'inspection', identity: 'first', jobId: 'job-0' })
    await expect(task.complete([{ id: 'image', evidenceId: old.evidenceId }], new AbortController().signal)).rejects.toThrow('CANVAS_TASK_CANDIDATE_NOT_GENERATED')
    const latest = task.record({ canvasId: 'canvas', nodeId: 'image', nodeKind: 'image', validation: 'inspection', identity: 'latest', jobId: 'job-256' })
    expect((await task.complete([{ id: 'image', evidenceId: latest.evidenceId }], new AbortController().signal)).phase).toBe('completed')
  })
  test('Given 普通问答未登记任务 When 模型结束 Then 无需工具或续行', async () => {
    const task = createCanvasTaskContract({ required: false, verify: async () => true })
    expect(await task.evaluate(new AbortController().signal)).toEqual({ action: 'complete' })
  })

  test('Given 父编排明确执行 When 只有回复而未声明交付 Then 要求继续并登记目标', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    expect(await task.evaluate(new AbortController().signal)).toMatchObject({ action: 'continue' })
  })

  test('Given 正文交付 When 没有证据或伪造 token Then 保持未完成', async () => {
    const task = createCanvasTaskContract({ required: false, verify: async () => true })
    task.start('canvas', [existingRequirement])
    await expect(task.complete([{ id: 'report', evidenceId: 'invented' }], new AbortController().signal)).rejects.toThrow('CANVAS_TASK_EVIDENCE_REQUIRED')
    expect(await task.evaluate(new AbortController().signal)).toMatchObject({ action: 'continue' })
  })

  test('Given 已读取真实产物 When 精确完成并再次核验 Then 返回完成', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    task.start('canvas', [existingRequirement])
    const proof = task.record(evidence)
    await task.complete([{ id: 'report', evidenceId: proof.evidenceId }], new AbortController().signal)
    expect(await task.evaluate(new AbortController().signal)).toEqual({ action: 'complete' })
  })

  test('Given 完成后用户修改产物 When 结束前 fresh-read Then 旧证据失效且重新续行', async () => {
    let current = true
    const task = createCanvasTaskContract({ required: true, verify: async () => current })
    task.start('canvas', [existingRequirement])
    const proof = task.record(evidence)
    await task.complete([{ id: 'report', evidenceId: proof.evidenceId }], new AbortController().signal)
    current = false
    expect(await task.evaluate(new AbortController().signal)).toMatchObject({ action: 'continue' })
  })

  test('Given 文本分析本身就是交付 When 登记响应并提供正文 Then 无需伪造工具证据', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => false })
    task.start('canvas', [{ id: 'answer', description: '分析结论', validation: 'response' }])
    await task.complete([{ id: 'answer', text: '依据已提供资料，结论如下。' }], new AbortController().signal)
    expect(await task.evaluate(new AbortController().signal)).toEqual({ action: 'complete' })
  })

  test('Given 已有交付合同 When 降低要求或跨画布提交 Then 拒绝改变合同', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    task.start('canvas', [existingRequirement])
    expect(() => task.start('canvas', [{ id: 'answer', description: '只答复', validation: 'response' }])).toThrow('CANVAS_TASK_ALREADY_STARTED')
    const wrong = task.record({ ...evidence, canvasId: 'other' })
    await expect(task.complete([{ id: 'report', evidenceId: wrong.evidenceId }], new AbortController().signal)).rejects.toThrow('CANVAS_TASK_EVIDENCE_MISMATCH')
  })

  test('Given 视频内容验收 When 只有元数据证据 Then 不能冒充看过内容', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    expect(() => task.start('canvas', [{
      id: 'review', description: '检查视频内容', nodeId: 'video-1',
      nodeKind: 'video', validation: 'inspection',
    }])).toThrow('CANVAS_TASK_REQUIREMENTS_INVALID')
    task.block('blocked', '当前没有音视频内容检查能力')
    expect(await task.evaluate(new AbortController().signal)).toMatchObject({ action: 'blocked' })
  })

  test('Given 未采用图片的更新检查 When 改看原历史候选 Then 不允许把更换检查对象冒充更新', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    task.start('canvas', [{ id: 'image', description: '更新当前图', nodeId: 'image-1', nodeKind: 'image', validation: 'inspection', change: 'updated' }], {
      nodeIds: ['image-1'], evidence: [{ canvasId: 'canvas', nodeId: 'image-1', nodeKind: 'image', validation: 'inspection', absent: true }],
    })
    const proof = task.record({ canvasId: 'canvas', nodeId: 'image-1', nodeKind: 'image', validation: 'inspection', identity: 'old-picture', jobId: 'old-job' })
    await expect(task.complete([{ id: 'image', evidenceId: proof.evidenceId }], new AbortController().signal)).rejects.toThrow('CANVAS_TASK_CANDIDATE_NOT_GENERATED')
  })

  test('Given 更新图片任务登记本轮生成回执 When 检查新候选且拒绝采用 Then 合同允许完成', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    task.start('canvas', [{ id: 'image', description: '生成并检查新候选', nodeId: 'image-1', nodeKind: 'image', validation: 'inspection', change: 'updated' }], {
      nodeIds: ['image-1'], evidence: [{ canvasId: 'canvas', nodeId: 'image-1', nodeKind: 'image', validation: 'inspection', identity: 'adopted' }],
    })
    task.recordGeneratedJobs('canvas', [{ nodeId: 'image-1', jobId: 'new-job' }])
    const proof = task.record({ canvasId: 'canvas', nodeId: 'image-1', nodeKind: 'image', validation: 'inspection', identity: 'candidate', jobId: 'new-job' })
    await expect(task.complete([{ id: 'image', evidenceId: proof.evidenceId }], new AbortController().signal)).resolves.toMatchObject({ phase: 'completed' })
  })

  test('Given 更新图片任务未登记或跨节点候选 When 完成 Then 拒绝冒充本轮生成', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    task.start('canvas', [{ id: 'image', description: '生成新候选', nodeId: 'image-1', nodeKind: 'image', validation: 'inspection', change: 'updated' }], {
      nodeIds: ['image-1'], evidence: [{ canvasId: 'canvas', nodeId: 'image-1', nodeKind: 'image', validation: 'inspection', identity: 'adopted' }],
    })
    const proof = task.record({ canvasId: 'canvas', nodeId: 'image-1', nodeKind: 'image', validation: 'inspection', identity: 'candidate', jobId: 'other-job' })
    await expect(task.complete([{ id: 'image', evidenceId: proof.evidenceId }], new AbortController().signal)).rejects.toThrow('CANVAS_TASK_CANDIDATE_NOT_GENERATED')
    expect(() => task.recordGeneratedJobs('canvas', [{ nodeId: 'other-node', jobId: 'new-job' }])).not.toThrow()
    const crossNode = task.record({ canvasId: 'canvas', nodeKind: 'image', validation: 'inspection', jobId: 'new-job', nodeId: 'other-node', identity: 'cross-node' })
    await expect(task.complete([{ id: 'image', evidenceId: crossNode.evidenceId }], new AbortController().signal)).rejects.toThrow('CANVAS_TASK_EVIDENCE_MISMATCH')
  })

  test('Given 缺少必要输入或用户停止 When 检查完成 Then 不假装成功也不继续', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    task.block('needs-input', '缺少用户指定的源音轨')
    expect(await task.evaluate(new AbortController().signal)).toEqual({ action: 'blocked', message: '缺少用户指定的源音轨' })
    const controller = new AbortController()
    controller.abort()
    await expect(task.evaluate(controller.signal)).rejects.toThrow()
  })

  test('Given 两项交付引用同一份节点证据 When 完成 Then 拒绝把单一产物重复计数', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    task.start('canvas', [
      existingRequirement,
      { ...existingRequirement, id: 'appendix', description: '附录正文' },
    ])
    const proof = task.record(evidence)

    await expect(task.complete([
      { id: 'report', evidenceId: proof.evidenceId },
      { id: 'appendix', evidenceId: proof.evidenceId },
    ], new AbortController().signal)).rejects.toThrow('CANVAS_TASK_EVIDENCE_REUSED')
  })

  test('Given 现有目标绑定确切节点 When 使用同类其它节点证据 Then 拒绝替代目标身份', async () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    task.start('canvas', [existingRequirement])
    const wrongNode = task.record({ ...evidence, nodeId: 'other-doc' })

    await expect(task.complete([
      { id: 'report', evidenceId: wrongNode.evidenceId },
    ], new AbortController().signal)).rejects.toThrow('CANVAS_TASK_EVIDENCE_MISMATCH')
  })

  test('Given 更新目标带启动基线 When 内容身份未变化或已经变化 Then 只接受真实新版本', async () => {
    const baseline = { nodeIds: ['doc'], evidence: [evidence] }
    const requirement = { ...existingRequirement, change: 'updated' as const }
    const unchangedTask = createCanvasTaskContract({ required: true, verify: async () => true })
    unchangedTask.start('canvas', [requirement], baseline)
    const unchanged = unchangedTask.record(evidence)
    await expect(unchangedTask.complete([
      { id: 'report', evidenceId: unchanged.evidenceId },
    ], new AbortController().signal)).rejects.toThrow('CANVAS_TASK_EVIDENCE_UNCHANGED')

    const changedTask = createCanvasTaskContract({ required: true, verify: async () => true })
    changedTask.start('canvas', [requirement], baseline)
    const changed = changedTask.record({ ...evidence, identity: 'revision-2' })
    await expect(changedTask.complete([
      { id: 'report', evidenceId: changed.evidenceId },
    ], new AbortController().signal)).resolves.toMatchObject({ phase: 'completed' })
  })

  test('Given 新建目标带节点基线 When 证据来自旧节点或新节点 Then 只接受基线外产物', async () => {
    const baseline = { nodeIds: ['doc'], evidence: [evidence] }
    const requirement = {
      id: 'new-report', description: '新建报告', nodeKind: 'document' as const,
      validation: 'content' as const, change: 'created' as const,
    }
    const oldTask = createCanvasTaskContract({ required: true, verify: async () => true })
    oldTask.start('canvas', [requirement], baseline)
    const oldProof = oldTask.record(evidence)
    await expect(oldTask.complete([
      { id: 'new-report', evidenceId: oldProof.evidenceId },
    ], new AbortController().signal)).rejects.toThrow('CANVAS_TASK_CREATED_TARGET_EXISTS')

    const newTask = createCanvasTaskContract({ required: true, verify: async () => true })
    newTask.start('canvas', [requirement], baseline)
    const newProof = newTask.record({ ...evidence, nodeId: 'new-doc', identity: 'revision-1-new' })
    await expect(newTask.complete([
      { id: 'new-report', evidenceId: newProof.evidenceId },
    ], new AbortController().signal)).resolves.toMatchObject({ phase: 'completed' })
  })

  test('Given 无效 validation-kind 或缺少目标基线 When 登记任务 Then 在执行前拒绝不可能合同', () => {
    const task = createCanvasTaskContract({ required: true, verify: async () => true })
    expect(() => task.start('canvas', [{
      id: 'invalid', description: '检查文档视觉', nodeId: 'doc',
      nodeKind: 'document', validation: 'inspection',
    }])).toThrow('CANVAS_TASK_REQUIREMENTS_INVALID')
    expect(() => task.start('canvas', [{
      ...existingRequirement, change: 'updated',
    }])).toThrow('CANVAS_TASK_BASELINE_REQUIRED')
    expect(() => task.start('canvas', [{
      id: 'unbound', description: '未绑定的现有文档', nodeKind: 'document', validation: 'content',
    }])).toThrow('CANVAS_TASK_REQUIREMENTS_INVALID')
  })

  test('Given 多项证据需要完成核验 When 提交 Then 只调用一次批量快照验证', async () => {
    let singleVerifyCount = 0
    let batchVerifyCount = 0
    const task = createCanvasTaskContract({
      required: true,
      verify: async () => { singleVerifyCount += 1; return true },
      verifyBatch: async (proofs) => { batchVerifyCount += 1; return proofs.length === 2 },
    })
    task.start('canvas', [
      existingRequirement,
      { ...existingRequirement, id: 'second', description: '第二份报告', nodeId: 'doc-2' },
    ])
    const first = task.record(evidence)
    const second = task.record({ ...evidence, nodeId: 'doc-2', identity: 'revision-2' })

    await task.complete([
      { id: 'report', evidenceId: first.evidenceId },
      { id: 'second', evidenceId: second.evidenceId },
    ], new AbortController().signal)

    expect(batchVerifyCount).toBe(1)
    expect(singleVerifyCount).toBe(0)
  })

  test('Given 纯文本任务启动后画布作用域撤销 When 完成或结束检查 Then 两处都拒绝越权完成', async () => {
    let scopeAvailable = true
    let scopeChecks = 0
    const task = createCanvasTaskContract({
      required: true,
      verify: async () => true,
      validateScope: async () => {
        scopeChecks += 1
        if (!scopeAvailable) throw new Error('CANVAS_ACCESS_DENIED')
      },
    })
    task.start('canvas', [{ id: 'answer', description: '分析结论', validation: 'response' }])
    await task.complete([{ id: 'answer', text: '已完成分析。' }], new AbortController().signal)
    expect(scopeChecks).toBe(1)
    scopeAvailable = false
    await expect(task.evaluate(new AbortController().signal)).rejects.toThrow('CANVAS_ACCESS_DENIED')
    expect(scopeChecks).toBe(2)
  })
})
