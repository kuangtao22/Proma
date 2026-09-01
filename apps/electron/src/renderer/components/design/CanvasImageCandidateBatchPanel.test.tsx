import { describe, expect, test } from 'bun:test'
import type { CanvasImageCandidateBatch, CanvasImageCandidateBatchSummary } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CanvasImageCandidateBatchPanel,
  createCandidateBatchAdoptRequest,
} from './CanvasImageCandidateBatchPanel'
import type { CanvasImageCandidateBatchViewState } from './use-canvas-image-candidate-batches'

/** 创建覆盖成功、失败条目的批次详情。 */
function createBatch(status: CanvasImageCandidateBatch['status'] = 'partial'): CanvasImageCandidateBatch {
  return {
    schemaVersion: 1, batchId: 'batch-1', projectId: 'project-1', canvasId: 'canvas-1',
    source: 'canvas-tool', sourceSessionId: 'session-1', sourceToolCallId: 'tool-1', status,
    entries: [
      { nodeId: 'node-1', imageModuleId: 'module-1', initialAdoptedAssetId: 'asset-old', initialConfigRevision: 1, jobId: 'job-1', candidateAssetId: 'asset-new', status: 'candidate', error: null },
      { nodeId: 'node-2', imageModuleId: 'module-2', initialAdoptedAssetId: 'asset-old-2', initialConfigRevision: 1, jobId: 'job-2', candidateAssetId: null, status: 'failed', error: '生成失败' },
    ],
    adoption: null, createdAt: 100, updatedAt: 200,
  }
}

/** 创建与详情一致的初始轻量摘要。 */
function createSummary(): CanvasImageCandidateBatchSummary {
  return {
    batchId: 'batch-1', projectId: 'project-1', canvasId: 'canvas-1', status: 'partial',
    entries: [{ nodeId: 'node-1', status: 'candidate' }, { nodeId: 'node-2', status: 'failed' }],
    totalCount: 2, candidateCount: 1, failedCount: 1, runningCount: 0, updatedAt: 200,
  }
}

/** 渲染批次面板的纯服务端标记。 */
function renderPanel(state: CanvasImageCandidateBatchViewState, writable = true): string {
  return renderToStaticMarkup(
    <CanvasImageCandidateBatchPanel
      summary={createSummary()}
      state={state}
      writable={writable}
      focusNodeId="node-1"
      nodeTitles={new Map([['node-1', '首页视觉'], ['node-2', '发现页视觉']])}
      onLoad={() => undefined}
      onContinue={() => undefined}
      onAdopt={() => undefined}
      onAbandon={() => undefined}
      onPreviewAsset={() => undefined}
    />,
  )
}

describe('Canvas 图片候选批次面板', () => {
  test('Given 只有摘要 When 渲染 Then 展示进度并提供按需查看入口', () => {
    const html = renderPanel({ phase: 'idle', batch: null, error: null, operation: 'idle' })

    expect(html).toContain('1 / 2 个候选已完成')
    expect(html).toContain('查看候选批次')
    expect(html).not.toContain('首页视觉')
  })

  test('Given 部分完成详情 When 渲染 Then 清晰展示混合版本风险和四种批次动作', () => {
    const html = renderPanel({ phase: 'ready', batch: createBatch(), error: null, operation: 'idle' })

    expect(html).toContain('当前版本')
    expect(html).toContain('候选版本')
    expect(html).toContain('继续补齐')
    expect(html).toContain('采用成功项')
    expect(html).toContain('放弃本批次')
    expect(html).toContain('仍有 1 个节点保留旧版')
    expect(html).toContain('首页视觉')
    expect(html).toContain('发现页视觉')
  })

  test('Given 批次操作中或只读 When 渲染 Then 所有写操作禁用且保留进度反馈', () => {
    const operating = renderPanel({ phase: 'ready', batch: createBatch(), error: null, operation: 'adopting' })
    const readOnly = renderPanel({ phase: 'ready', batch: createBatch(), error: null, operation: 'idle' }, false)

    expect(operating).toContain('正在采用候选')
    expect(operating.match(/disabled=""/gu)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(readOnly.match(/disabled=""/gu)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  test('Given 部分采用入口 When 请求动作 Then 先打开确认而不直接提交', () => {
    let confirmationOpened = false
    let adopted = false
    const request = createCandidateBatchAdoptRequest('succeeded', {
      onConfirmPartial: () => { confirmationOpened = true },
      onAdopt: () => { adopted = true },
    })

    request()

    expect(confirmationOpened).toBe(true)
    expect(adopted).toBe(false)
  })
})
