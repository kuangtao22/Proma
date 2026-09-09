import { describe, expect, test } from 'bun:test'
import type { CanvasImageCandidateBatch } from '@proma/shared'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { StableDirectoryNativeRequest, StableDirectoryNativeResult } from '../stable-directory-native-host'
import {
  createCanvasImageCandidateBatchStore,
  parseCanvasImageCandidateAdoptionIntent,
  type CanvasImageCandidateAdoptionIntent,
  type CanvasImageCandidateBatchStoreDependencies,
} from './canvas-image-candidate-batch-store'
import { createCanvasTransactionArchive } from './canvas-transaction-archive'

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
  test('Given 大事务目录中已有明确身份 When 读取批次与采用凭据 Then 精确读取且不扫描目录', async () => {
    /** 原生协议测试桩拒绝全量扫描，防止指定 ID 查询重新变为线性操作。 */
    const value = batch('one', 'running', 2)
    const intent = adoptionIntent()
    const contents = new Map([
      ['image-candidate-batch-one.json', JSON.stringify(value)],
      ['image-candidate-adoption-operation-1.json', JSON.stringify(intent)],
    ])
    const modes: string[] = []
    const dependencies: CanvasImageCandidateBatchStoreDependencies = {
      documents: {
        loadWithDirectoryCapability: () => ({
          snapshot: { document: createEmptyCanvasDocument('project-1', 'canvas-1', 1), writable: true, nodeIssues: [] },
          openSingleChildDirectory: () => ({
            path: '/canvas/transactions', rootPath: '/canvas', assertValid: () => undefined, authorizeOpenedRoots: () => true,
          }),
        }),
      },
      runStableDirectoryNative: async (request: StableDirectoryNativeRequest): Promise<StableDirectoryNativeResult> => {
        modes.push(request.mode)
        if (request.mode !== 'canvas-intent-read') throw new Error('UNEXPECTED_FULL_SCAN')
        const content = contents.get(request.fileName!)
        return { roots: [], entries: [], readOutcome: content === undefined
          ? { status: 'missing' }
          : { status: 'ok', content, size: content.length, volume: '1', fileId: '2' } }
      },
    }
    const store = createCanvasImageCandidateBatchStore(dependencies)
    expect(await store.load(value, value.batchId)).toEqual(value)
    expect(await store.findByJobId(value, 'job-one', 'one')).toEqual(value)
    expect(await store.findByJobId(value, 'job-other', 'one')).toBeNull()
    expect(await store.loadAdoptionIntent(intent, intent.operationId)).toEqual(intent)
    expect(modes).toEqual(Array(4).fill('canvas-intent-read'))

    /** 精确读取仍须复核文件身份，不能因省去扫描而接受错配正文。 */
    contents.set('image-candidate-batch-one.json', JSON.stringify({ ...value, canvasId: 'canvas-other' }))
    await expect(store.load(value, value.batchId)).rejects.toThrow('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    contents.set('image-candidate-adoption-operation-1.json', JSON.stringify({ ...intent, operationId: 'operation-other' }))
    await expect(store.loadAdoptionIntent(intent, intent.operationId)).rejects.toThrow('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')

    /** 只有明确缺失才读取归档；损坏 active 不得被旧归档掩盖。 */
    const archivedNames: string[] = []
    const archivedStore = createCanvasImageCandidateBatchStore({
      ...dependencies,
      archive: {
        archiveEntries: async () => ({ archivedCount: 0, archivedBytes: 0 }),
        load: async (name) => { archivedNames.push(name); return name.includes('adoption') ? JSON.stringify(intent) : JSON.stringify(value) },
      },
    })
    await expect(archivedStore.load(value, value.batchId)).rejects.toThrow('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    expect(archivedNames).toEqual([])
    contents.clear()
    expect(await archivedStore.load(value, value.batchId)).toEqual(value)
    expect(await archivedStore.loadAdoptionIntent(intent, intent.operationId)).toEqual(intent)
    expect(archivedNames).toEqual(['image-candidate-batch-one.json', 'image-candidate-adoption-operation-1.json'])
    /** 原生层损坏与正文损坏保持相同诊断分类，并且均不得回退归档。 */
    const corruptStore = createCanvasImageCandidateBatchStore({
      ...dependencies,
      runStableDirectoryNative: async () => ({ roots: [], entries: [], readOutcome: { status: 'corrupt', error: 'invalid-file' } }),
    })
    await expect(corruptStore.load(value, value.batchId)).rejects.toThrow('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    await expect(corruptStore.loadAdoptionIntent(intent, intent.operationId)).rejects.toThrow('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
  })

  test('Given 预先采用的同素材条目 When 恢复 Then 允许原 revision 并拒绝伪造的素材或版本', () => {
    /** 新标记只证明当前同一素材已采用，旧 intent 仍要求模块 revision 增加一。 */
    const initial = adoptionIntent()
    const preserved = {
      ...initial,
      entries: [{ ...initial.entries[0]!, oldAssetId: 'new-1', alreadyAdopted: true as const }],
    }
    expect(parseCanvasImageCandidateAdoptionIntent(preserved, initial, initial.operationId)).toEqual(preserved)
    const committed: CanvasImageCandidateAdoptionIntent = {
      ...preserved, state: 'batch-committed',
      entries: [{ ...preserved.entries[0]!, committedConfigRevision: 1 }],
    }
    expect(parseCanvasImageCandidateAdoptionIntent(committed, initial, initial.operationId)).toEqual(committed)
    for (const invalid of [
      { ...committed.entries[0]!, oldAssetId: 'different-asset' },
      { ...committed.entries[0]!, committedConfigRevision: 2 },
      { ...committed.entries[0]!, alreadyAdopted: false },
    ]) {
      expect(() => parseCanvasImageCandidateAdoptionIntent({ ...committed, entries: [invalid] }, initial, initial.operationId))
        .toThrow('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_INVALID')
    }
  })
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

  test('Given 终态批次已离开 active When 按 batchId 加载 Then 精确读取归档且不扫描其它分片', async () => {
    const value = batch('11111111-1111-4111-8111-111111111111', 'abandoned', 3)
    const archived = new Map<string, string>()
    let active = [value]
    const archive = createCanvasTransactionArchive({
      writeArchived: async (fileName, content) => { archived.set(fileName, content) },
      readArchived: async (fileName) => archived.get(fileName) ?? null,
      removeActive: async () => { active = [] },
    })
    const store = createCanvasImageCandidateBatchStore({
      scanBatches: async () => active,
      writeBatch: async () => ({ commitVisible: true, durabilityUncertain: false }),
      archive,
    })

    await store.listActiveSummaries(value)
    await expect(store.load(value, value.batchId)).resolves.toEqual(value)
    expect(active).toEqual([])
  })

  test('Given 归档批次正文属于其它 Canvas When 精确加载或按任务恢复 Then fail closed', async () => {
    const requestedBatchId = '11111111-1111-4111-8111-111111111111'
    const archivedValue = {
      ...batch(requestedBatchId, 'abandoned', 3),
      canvasId: 'canvas-other',
    }
    const archive = createCanvasTransactionArchive({
      writeArchived: async () => {},
      readArchived: async () => `${JSON.stringify(archivedValue)}\n`,
      removeActive: async () => {},
    })
    const store = createCanvasImageCandidateBatchStore({
      scanBatches: async () => [],
      writeBatch: async () => ({ commitVisible: true, durabilityUncertain: false }),
      archive,
    })
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }

    await expect(store.load(target, requestedBatchId))
      .rejects.toThrow('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
    await expect(store.findByJobId(target, `job-${requestedBatchId}`, requestedBatchId))
      .rejects.toThrow('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
  })

  test('Given batch-committed 采用事务已归档 When 按 operationId 重放 Then 返回原采用证据', async () => {
    const value: CanvasImageCandidateAdoptionIntent = {
      ...adoptionIntent('operation-archive'),
      state: 'batch-committed',
      entries: [{
        ...adoptionIntent().entries[0]!,
        committedConfigRevision: 2,
      }],
    }
    const archived = new Map<string, string>()
    let active = [value]
    const archive = createCanvasTransactionArchive({
      writeArchived: async (fileName, content) => { archived.set(fileName, content) },
      readArchived: async (fileName) => archived.get(fileName) ?? null,
      removeActive: async () => { active = [] },
    })
    const store = createCanvasImageCandidateBatchStore({
      scanBatches: async () => [],
      writeBatch: async () => ({ commitVisible: true, durabilityUncertain: false }),
      scanAdoptionIntents: async () => active,
      writeAdoptionIntent: async () => ({ commitVisible: true, durabilityUncertain: false }),
      archive,
    })

    await store.scanAdoptionIntents(value)
    await expect(store.loadAdoptionIntent(value, value.operationId)).resolves.toEqual(value)
    expect(active).toEqual([])
  })
})
