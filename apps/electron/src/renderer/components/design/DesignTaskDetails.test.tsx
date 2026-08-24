import { describe, expect, test } from 'bun:test'
import type { DesignJobRecord, DesignTaskDetails as DesignTaskDetailsData } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInitialDesignProjectState } from '@/atoms/design-atoms'
import type { DesignProjectState } from '@/atoms/design-atoms'
import type { DesignAdapter } from '@/lib/design-adapter'
import {
  createDesignTaskDetailsController,
  DesignTaskDetails,
  getDesignThinkingMessage,
  partitionDesignTrace,
} from './DesignTaskDetails'

/** 创建不包含内部会话信息的任务详情测试数据。 */
function createDetails(overrides: Partial<DesignTaskDetailsData> = {}): DesignTaskDetailsData {
  return {
    creativeTaskId: 'creative-1',
    currentJobId: 'job-1',
    attempts: [{
      jobId: 'job-1',
      attemptNumber: 1,
      status: 'succeeded',
      startedAt: 100,
      completedAt: 1_100,
      traceState: 'ready',
      designSummary: '保持首页层级，强化主操作。',
      finalImagePrompt: 'A precise homepage product screenshot',
      rawThinkingAvailable: false,
    }],
    traceState: 'ready',
    ...overrides,
  }
}

/** 创建首轮成功任务，覆盖 Inspector 默认可见的轻量摘要。 */
function createJob(): DesignJobRecord {
  return {
    id: 'job-1',
    creativeTaskId: 'creative-1',
    attemptNumber: 1,
    projectId: 'project-1',
    action: 'generate',
    status: 'succeeded',
    prompt: '生成当前项目首页效果图',
    originalRequest: '生成当前项目首页效果图',
    contextMode: 'none',
    outputAssetId: 'asset-1',
    designSummary: '保持首页层级，强化主操作。',
    finalImagePrompt: 'A precise homepage product screenshot',
    rawThinkingAvailable: false,
    traceState: 'ready',
    imageModelSnapshot: {
      profileId: 'profile-1',
      name: 'GPT Image 2',
      modelId: 'gpt-image-2',
      executor: 'openai-images',
      channelId: 'channel-1',
    },
    startedAt: 100,
    completedAt: 1_100,
    createdAt: 100,
    updatedAt: 1_100,
  }
}

describe('Design 任务详情', () => {
  test('Given 轻量详情已加载 When 渲染 Then 展示原始要求、摘要、精确提示词和尝试历史', () => {
    const html = renderToStaticMarkup(
      <DesignTaskDetails
        job={createJob()}
        detailsState={{
          phase: 'ready',
          details: createDetails(),
          traceLoaded: false,
          traceLoading: false,
        }}
        onLoadDetails={() => undefined}
        onLoadTrace={() => undefined}
        onCopyPrompt={() => undefined}
        onRetry={() => undefined}
        onContinueFromVersion={() => undefined}
      />,
    )

    expect(html).toContain('用户原始要求')
    expect(html).toContain('生成当前项目首页效果图')
    expect(html).toContain('设计摘要')
    expect(html).toContain('精确生图提示词')
    expect(html).toContain('A precise homepage product screenshot')
    expect(html).toContain('尝试历史')
    expect(html).toContain('基于此版本继续')
  })

  test('Given 模型没有 Thinking When trace 已加载 Then 明确说明不可用且不伪造内容', () => {
    const detailsState: DesignProjectState['taskDetailsByJobId'] extends Map<string, infer Value>
      ? Value
      : never = {
        phase: 'ready',
        details: createDetails({ trace: [] }),
        traceLoaded: true,
        traceLoading: false,
      }

    expect(getDesignThinkingMessage(detailsState)).toBe('模型未返回原始 Thinking')
    expect(partitionDesignTrace(detailsState.details?.trace).thinking).toEqual([])
  })

  test('Given 首次打开任务详情 When 加载 Then 只请求轻量详情；展开后才请求 trace', async () => {
    let state = {
      ...createInitialDesignProjectState(),
      jobs: [createJob()],
    }
    const calls: string[] = []
    const adapter: Pick<DesignAdapter, 'getTaskDetails' | 'getTaskTrace'> = {
      getTaskDetails: async () => {
        calls.push('details')
        return createDetails()
      },
      getTaskTrace: async () => {
        calls.push('trace')
        return createDetails({
          trace: [{ timestamp: 200, type: 'thinking', title: '分析布局', content: '检查信息层级' }],
        })
      },
    }
    const controller = createDesignTaskDetailsController({
      projectId: 'project-1',
      adapter,
      getState: () => state,
      updateState: (update) => {
        state = { ...state, ...(typeof update === 'function' ? update(state) : update) }
      },
    })

    await controller.loadDetails('job-1')
    expect(calls).toEqual(['details'])
    expect(state.taskDetailsByJobId.get('job-1')?.traceLoaded).toBe(false)

    await controller.loadTrace('job-1')
    expect(calls).toEqual(['details', 'trace'])
    expect(state.taskDetailsByJobId.get('job-1')?.traceLoaded).toBe(true)
  })
})
