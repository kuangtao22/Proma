import { describe, expect, test } from 'bun:test'
import type { CanvasImageCandidateBatch, CanvasImageCandidateBatchSummary } from '@proma/shared'
import {
  createCanvasImageCandidateBatchController,
  createInitialCanvasImageCandidateBatchState,
  findCanvasImageCandidateBatchSummary,
  getCanvasImageCandidateNodeState,
} from './use-canvas-image-candidate-batches'

/** 创建只含一个成功候选的完整批次。 */
function createBatch(status: CanvasImageCandidateBatch['status'] = 'partial'): CanvasImageCandidateBatch {
  return {
    schemaVersion: 1,
    batchId: 'batch-1',
    projectId: 'project-1',
    canvasId: 'canvas-1',
    source: 'canvas-tool',
    sourceSessionId: 'session-1',
    sourceToolCallId: 'tool-1',
    status,
    entries: [{
      nodeId: 'node-1', imageModuleId: 'module-1', initialAdoptedAssetId: 'asset-old',
      initialConfigRevision: 2, jobId: 'job-1', candidateAssetId: 'asset-new',
      status: 'candidate', error: null,
    }],
    adoption: null,
    createdAt: 100,
    updatedAt: 200,
  }
}

/** 从完整批次创建初始 LOAD 使用的轻量摘要。 */
function createSummary(): CanvasImageCandidateBatchSummary {
  return {
    batchId: 'batch-1', projectId: 'project-1', canvasId: 'canvas-1', status: 'partial',
    entries: [{ nodeId: 'node-1', status: 'candidate' }, { nodeId: 'node-2', status: 'failed' }],
    totalCount: 2, candidateCount: 1, failedCount: 1, runningCount: 0, updatedAt: 200,
  }
}

describe('Canvas 图片候选批次 controller', () => {
  test('Given 摘要携带节点轻量状态 When 投影卡片 Then 不读取详情即可区分新版本和部分完成', () => {
    const ready = { ...createSummary(), batchId: 'batch-ready', status: 'ready' as const, failedCount: 0, entries: [{ nodeId: 'node-1', status: 'candidate' as const }] }
    const partial = createSummary()

    expect(getCanvasImageCandidateNodeState([ready], 'node-1')).toBe('new-version')
    expect(getCanvasImageCandidateNodeState([partial], 'node-1')).toBe('partial')
    expect(getCanvasImageCandidateNodeState([partial], 'node-2')).toBe('partial')
    expect(findCanvasImageCandidateBatchSummary([partial], 'node-1')).toBe(partial)
    expect(findCanvasImageCandidateBatchSummary([partial], 'node-missing')).toBeUndefined()
  })

  test('Given 只有摘要 When 首次打开详情 Then 才按批次身份加载完整条目', async () => {
    const states: ReturnType<typeof createInitialCanvasImageCandidateBatchState>[] = []
    let loadCount = 0
    const controller = createCanvasImageCandidateBatchController({
      summary: createSummary(),
      adapter: {
        getCanvasImageCandidateBatch: async () => { loadCount += 1; return createBatch() },
        continueCanvasImageCandidateBatch: async () => createBatch('running'),
        adoptCanvasImageCandidateBatch: async () => createBatch('adopted'),
        abandonCanvasImageCandidateBatch: async () => createBatch('abandoned'),
      },
      getState: () => states.at(-1) ?? createInitialCanvasImageCandidateBatchState(),
      updateState: (update) => states.push(update(states.at(-1) ?? createInitialCanvasImageCandidateBatchState())),
    })

    expect(loadCount).toBe(0)
    await controller.load()

    expect(loadCount).toBe(1)
    expect(states.at(-1)).toMatchObject({ phase: 'ready', batch: { batchId: 'batch-1' }, error: null })
  })

  test('Given 部分完成批次 When 采用成功项 Then 只发 succeeded 模式并接管返回事实', async () => {
    const receivedModes: Array<'all' | 'succeeded'> = []
    const refreshedBatchIds: string[] = []
    let state: ReturnType<typeof createInitialCanvasImageCandidateBatchState> = {
      ...createInitialCanvasImageCandidateBatchState(), phase: 'ready', batch: createBatch(),
    }
    const controller = createCanvasImageCandidateBatchController({
      summary: createSummary(),
      adapter: {
        getCanvasImageCandidateBatch: async () => createBatch(),
        continueCanvasImageCandidateBatch: async () => createBatch('running'),
        adoptCanvasImageCandidateBatch: async (input) => {
          receivedModes.push(input.mode)
          return createBatch('adopted')
        },
        abandonCanvasImageCandidateBatch: async () => createBatch('abandoned'),
      },
      getState: () => state,
      updateState: (update) => { state = update(state) },
      onBatchChanged: (batch) => { refreshedBatchIds.push(batch.batchId) },
    })

    await controller.adopt('succeeded')

    expect(receivedModes).toEqual(['succeeded'])
    expect(refreshedBatchIds).toEqual(['batch-1'])
    expect(state).toMatchObject({ operation: 'idle', batch: { status: 'adopted' }, error: null })
  })

  test('Given 继续补齐失败 When 操作结束 Then 保留已加载详情并展示安全错误', async () => {
    const original = createBatch()
    let state: ReturnType<typeof createInitialCanvasImageCandidateBatchState> = {
      ...createInitialCanvasImageCandidateBatchState(), phase: 'ready', batch: original,
    }
    const controller = createCanvasImageCandidateBatchController({
      summary: createSummary(),
      adapter: {
        getCanvasImageCandidateBatch: async () => original,
        continueCanvasImageCandidateBatch: async () => { throw new Error('补齐失败') },
        adoptCanvasImageCandidateBatch: async () => createBatch('adopted'),
        abandonCanvasImageCandidateBatch: async () => createBatch('abandoned'),
      },
      getState: () => state,
      updateState: (update) => { state = update(state) },
    })

    await controller.continueBatch()

    expect(state.batch).toBe(original)
    expect(state).toMatchObject({ phase: 'ready', operation: 'idle', error: '补齐失败' })
  })
})
