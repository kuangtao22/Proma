import { describe, expect, test } from 'bun:test'
import { parseCanvasArtifactToolResult } from './agent-canvas-artifact-result'

describe('Agent Canvas 产物工具结果解析', () => {
  test('Given 成功 WebView 工具结果 When 解析 Then 只返回导航所需公开字段', () => {
    expect(parseCanvasArtifactToolResult(JSON.stringify({
      canvasId: 'canvas-1',
      nodeId: 'artifact-1',
      revision: 4,
      artifactType: 'webview',
      sourceToolCallId: 'tool-artifact-1',
    }))).toEqual({
      canvasId: 'canvas-1',
      nodeId: 'artifact-1',
      revision: 4,
      artifactType: 'webview',
    })
  })

  test('Given Pi 以文本块数组返回成功结果 When 解析 Then 仍提取公开导航字段', () => {
    expect(parseCanvasArtifactToolResult(JSON.stringify([{
      type: 'text',
      text: JSON.stringify({
        canvasId: 'canvas-2', nodeId: 'artifact-2', revision: 5, artifactType: 'image',
      }),
    }]))).toEqual({
      canvasId: 'canvas-2', nodeId: 'artifact-2', revision: 5, artifactType: 'image',
    })
  })

  test('Given Host 返回已完成或待对账的任务登记 When 解析 Then 仍只返回导航公开字段', () => {
    const completed = {
      canvasId: 'canvas-completed', nodeId: 'artifact-completed', revision: 6, artifactType: 'webview',
      taskRegistration: { operationId: 'operation-completed', status: 'completed' },
    }
    const pending = {
      canvasId: 'canvas-pending', nodeId: 'artifact-pending', revision: 7, artifactType: 'image',
      taskRegistration: {
        operationId: 'operation-pending',
        status: 'pending',
        reasonCode: 'CANVAS_TASK_CREATED_RESULT_UNCONFIRMED',
        nextAction: { tool: 'canvas_task', action: 'resume', canvasId: 'canvas-pending', taskId: 'task-1' },
      },
    }

    expect(parseCanvasArtifactToolResult(JSON.stringify(completed))).toEqual({
      canvasId: 'canvas-completed', nodeId: 'artifact-completed', revision: 6, artifactType: 'webview',
    })
    expect(parseCanvasArtifactToolResult(JSON.stringify(pending))).toEqual({
      canvasId: 'canvas-pending', nodeId: 'artifact-pending', revision: 7, artifactType: 'image',
    })
  })

  test('Given 损坏或非成功结果 When 解析 Then fail closed', () => {
    expect(parseCanvasArtifactToolResult('not-json')).toBeNull()
    expect(parseCanvasArtifactToolResult(JSON.stringify({
      canvasId: 'canvas-1', nodeId: '', revision: 4, artifactType: 'image',
    }))).toBeNull()
    expect(parseCanvasArtifactToolResult(JSON.stringify({
      canvasId: 'canvas-1', nodeId: 'node-1', revision: -1, artifactType: 'video',
    }))).toBeNull()
    expect(parseCanvasArtifactToolResult(JSON.stringify([{ type: 'image', data: 'base64' }]))).toBeNull()
    expect(parseCanvasArtifactToolResult(JSON.stringify({
      canvasId: 'canvas-1', nodeId: 'node-1', revision: 4, artifactType: 'image',
      taskRegistration: { operationId: 'operation-1', status: 'completed', destructiveAction: 'delete' },
    }))).toBeNull()
  })
})
