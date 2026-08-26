import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { AgentSessionMeta, CanvasDocument } from '@proma/shared'
import {
  CANVAS_AGENT_ALLOWED_TOOL_NAMES,
  requireCanvasAgentRunOwner,
} from './canvas-agent-run-policy'

/** 创建带单个 Agent 节点的权威 Canvas 文档。 */
function createDocument(): CanvasDocument {
  const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
  document.nodes.push({
    id: 'node-1',
    kind: 'agent',
    title: '研究 Agent',
    position: { x: 0, y: 0 },
    agentSessionId: 'session-1',
  })
  return document
}

/** 创建完整 Canvas 归属的会话元数据。 */
function createSession(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 'session-1',
    title: '研究 Agent',
    channelId: 'channel-1',
    modelId: 'model-1',
    workspaceId: 'project-1',
    sourceCanvasProjectId: 'project-1',
    sourceCanvasId: 'canvas-1',
    sourceCanvasNodeId: 'node-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('Canvas Agent 运行策略', () => {
  test('Given 权威节点和会话三字段完全匹配 When 解析运行归属 Then 返回节点引用的会话', () => {
    const session = createSession()
    const document = createDocument()
    const node = document.nodes[0]
    if (!node || node.kind !== 'agent') throw new Error('测试 Agent 节点缺失')
    expect(requireCanvasAgentRunOwner({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      nodeId: 'node-1',
      document,
      getSession: () => session,
    })).toEqual({ node, session })
  })

  test.each([
    ['未知节点', undefined, createSession()],
    ['未知会话', 'node-1', undefined],
    ['跨项目', 'node-1', createSession({ sourceCanvasProjectId: 'project-2' })],
    ['跨 Canvas', 'node-1', createSession({ sourceCanvasId: 'canvas-2' })],
    ['跨节点', 'node-1', createSession({ sourceCanvasNodeId: 'node-2' })],
    ['半归属', 'node-1', createSession({ sourceCanvasNodeId: undefined })],
    ['混入委派', 'node-1', createSession({ sourceDelegationId: 'delegation-1' })],
  ])('Given %s When 解析运行归属 Then fail closed', (_name, nodeId, session) => {
    expect(() => requireCanvasAgentRunOwner({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      nodeId: nodeId ?? 'missing-node',
      document: createDocument(),
      getSession: () => session,
    })).toThrow('Canvas Agent 归属无效')
  })

  test('Given Canvas Agent 运行 When 构造工具策略 Then 只允许三个只读工具', () => {
    expect(CANVAS_AGENT_ALLOWED_TOOL_NAMES).toEqual(['Read', 'Glob', 'Grep'])
    for (const denied of [
      'Write', 'Edit', 'Bash', 'Shell', 'AskUserQuestion', 'EnterPlanMode',
      'mcp__browser__navigate', 'mcp__nano_banana__generate_image', 'Task',
    ]) {
      expect(CANVAS_AGENT_ALLOWED_TOOL_NAMES).not.toContain(denied)
    }
  })
})
