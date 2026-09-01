import { describe, expect, test } from 'bun:test'
import type { CanvasImageCandidateBatch } from '@proma/shared'
import {
  createCanvasImageCandidateBatchStore,
  parseCanvasImageCandidateAdoptionIntent,
  type CanvasImageCandidateAdoptionIntent,
} from './canvas-image-candidate-batch-store'

/** 创建 Store 测试使用的完整批次。 */
function batch(id: string, status: CanvasImageCandidateBatch['status'], updatedAt: number): CanvasImageCandidateBatch {
  return {
    schemaVersion: 1, batchId: id, projectId: 'project-1', canvasId: 'canvas-1',
    source: 'single', sourceSessionId: null, sourceToolCallId: null, status,
    entries: [{
      nodeId: `node-${id}`, imageModuleId: `module-${id}`, initialAdoptedAssetId: null,
      initialConfigRevision: 1, jobId: `job-${id}`, candidateAssetId: null,
      status: status === 'ready' ? 'candidate' : 'running', error: null,
    }],
    adoption: null, createdAt: 1, updatedAt,
  }
}

/** 创建 Store 恢复测试使用的完整采用 intent。 */
function adoptionIntent(operationId = 'operation-1'): CanvasImageCandidateAdoptionIntent {
  return {
    schemaVersion: 1,
    operationId,
    batchId: 'batch-1',
    projectId: 'project-1',
    canvasId: 'canvas-1',
    mode: 'all',
    baseCanvasRevision: 3,
    entries: [{
      nodeId: 'node-1', imageModuleId: 'module-1', oldAssetId: 'old-1',
      candidateAssetId: 'new-1', expectedConfigRevision: 1, committedConfigRevision: null,
    }],
    expectedGraphSha256: 'a'.repeat(64),
    state: 'prepared',
    createdAt: 10,
    updatedAt: 10,
  }
}

describe('Canvas 图片候选批次 Store', () => {
  test('Given 活跃与终态批次 When listActiveSummaries Then 只返回稳定排序活跃摘要', async () => {
    const values = [batch('old', 'running', 2), batch('done', 'abandoned', 4), batch('new', 'ready', 3)]
    const store = createCanvasImageCandidateBatchStore({
      scanBatches: async () => values,
      writeBatch: async () => ({ commitVisible: true, durabilityUncertain: false }),
    })
    const summaries = await store.listActiveSummaries({ projectId: 'project-1', canvasId: 'canvas-1' })
    expect(summaries.map((item) => item.batchId)).toEqual(['new', 'old'])
    expect(summaries[0]?.entries).toEqual([{ nodeId: 'node-new', status: 'candidate' }])
    expect((await store.findByJobId({ projectId: 'project-1', canvasId: 'canvas-1' }, 'job-new'))?.batchId)
      .toBe('new')
  })

  test('Given durability uncertain When save Then 重扫确认同一批次后成功', async () => {
    const value = batch('one', 'running', 2)
    let scans = 0
    const store = createCanvasImageCandidateBatchStore({
      scanBatches: async () => { scans += 1; return [value] },
      writeBatch: async () => ({ commitVisible: true, durabilityUncertain: true, error: 'fsync' }),
    })
    await expect(store.save(value)).resolves.toEqual(value)
    expect(scans).toBe(1)
  })

  test('Given 未知字段、跨 Canvas 或文件身份不一致 When 解析采用 intent Then fail closed', () => {
    const valid = adoptionIntent()
    expect(() => parseCanvasImageCandidateAdoptionIntent(
      { ...valid, unknown: true }, valid, valid.operationId,
    )).toThrow('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
    expect(() => parseCanvasImageCandidateAdoptionIntent(
      { ...valid, canvasId: 'canvas-other' }, valid, valid.operationId,
    )).toThrow('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
    expect(() => parseCanvasImageCandidateAdoptionIntent(
      valid, valid, 'operation-other',
    )).toThrow('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
  })

  test('Given adoption intent durability uncertain When 精确重扫可证明 Then 保存成功', async () => {
    const value = adoptionIntent()
    let scans = 0
    const store = createCanvasImageCandidateBatchStore({
      scanBatches: async () => [],
      writeBatch: async () => ({ commitVisible: true, durabilityUncertain: false }),
      scanAdoptionIntents: async () => { scans += 1; return [value] },
      writeAdoptionIntent: async () => ({ commitVisible: true, durabilityUncertain: true, error: 'fsync' }),
    })

    await expect(store.saveAdoptionIntent(value)).resolves.toEqual(value)
    expect(scans).toBe(1)
  })

  test('Given adoption intent durability uncertain When 重扫无法证明 Then 要求恢复', async () => {
    const value = adoptionIntent()
    const store = createCanvasImageCandidateBatchStore({
      scanBatches: async () => [],
      writeBatch: async () => ({ commitVisible: true, durabilityUncertain: false }),
      scanAdoptionIntents: async () => [],
      writeAdoptionIntent: async () => ({ commitVisible: true, durabilityUncertain: true, error: 'fsync' }),
    })

    await expect(store.saveAdoptionIntent(value)).rejects.toThrow('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
  })
})
