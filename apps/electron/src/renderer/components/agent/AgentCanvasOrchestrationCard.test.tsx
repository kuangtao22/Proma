import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CanvasOrchestrationProgress, CanvasOrchestrationRecord } from '@proma/shared'
import { AgentCanvasOrchestrationCard } from './AgentCanvasOrchestrationCard'

/** 创建可直接渲染的最小编排记录，测试关注用户可见状态而非内部存储细节。 */
function createRecord(status: CanvasOrchestrationRecord['status'], goal: string): CanvasOrchestrationRecord {
  return {
    schemaVersion: 1, id: 'orchestration-1', revision: 1, projectId: 'project-1', canvasId: 'canvas-1', ownerSessionId: 'session-1',
    request: { requestId: 'request-1', goal, intent: 'produce', constraints: [], referenceNodeIds: [], deliverables: [] },
    coordinatorNodeId: null, coordinatorSessionId: null, status, steps: [], summary: 'summary', runStartedAt: null, createdAt: 1, updatedAt: 1,
  }
}

/** 建立与记录状态一致的有界进度投影，避免测试依赖 Host 或 IPC。 */
function createProgress(): CanvasOrchestrationProgress {
  return { stepCounts: { total: 0, planned: 0, running: 0, needsReview: 0, completed: 0, blocked: 0 }, currentSteps: { items: [], total: 0, omitted: 0 }, nextStep: '暂无下一步', report: null, pendingDecision: null }
}

describe('普通聊天画布协作卡', () => {
  test('Given 超长目标 When 卡片渲染摘要 Then 用户可见摘要并保留完整 title', () => {
    /** 模拟截图中的长制作目标，不读取真实会话正文。 */
    const goal = '长目标 '.repeat(400)
    /** 渲染生产组件，核对可见文字和供悬停查看的完整目标。 */
    const markup = renderToStaticMarkup(<AgentCanvasOrchestrationCard record={createRecord('running', goal)} progress={createProgress()} canvasTitle="视频画布" onDecision={() => undefined} />)
    expect(markup).toContain('视频画布')
    expect(markup).toContain('进行中')
    expect(markup).toContain(`title="${goal}"`)
  })

  test('Given 编排已取消 When 卡片渲染 Then 显示明确的取消状态', () => {
    /** 已取消的真实组件输出不能只剩阶段完成比例。 */
    const markup = renderToStaticMarkup(<AgentCanvasOrchestrationCard record={createRecord('cancelled', '已取消的制作委托')} progress={createProgress()} canvasTitle="视频画布" onDecision={() => undefined} />)
    expect(markup).toContain('已取消')
    expect(markup).toContain('已取消的制作委托')
  })
})
