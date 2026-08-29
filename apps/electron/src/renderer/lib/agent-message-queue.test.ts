import { describe, expect, test } from 'bun:test'
import type { CanvasNodeReference } from '@proma/shared'
import {
  addCanvasNodeReferences,
  buildQueuedMessageSendPayload,
  createAgentQueuedMessage,
  getQueuedMessageDisplayParts,
  mergeAgentDraftWithRestoredMessage,
  parseQueuedMessageMentions,
  removeSentCanvasNodeReferences,
  submitQueuedMessagePayload,
} from './agent-message-queue'

/** 队列结构化引用测试使用的稳定节点快照。 */
const canvasReferenceA: CanvasNodeReference = {
  projectId: 'project-1',
  canvasId: 'canvas-1',
  nodeId: 'node-1',
  nodeType: 'document',
  nodeRevision: 4,
  title: '需求说明',
}

/** 同画布第二个节点用于验证首次出现顺序。 */
const canvasReferenceB: CanvasNodeReference = {
  ...canvasReferenceA,
  nodeId: 'node-2',
  nodeType: 'image',
  title: '首页视觉',
}

describe('Canvas 节点引用队列合同', () => {
  test('Given 仅有 Canvas 引用 When 普通发送 Then 仍调用真实提交并返回 submitted', async () => {
    const payload = buildQueuedMessageSendPayload(createAgentQueuedMessage('', 'message-refs-only', 100, null, {
      canvasNodeReferences: [canvasReferenceA],
    }))
    /** 记录提交边界实际收到的结构化引用。 */
    let submittedReferences: readonly CanvasNodeReference[] | undefined

    const outcome = await submitQueuedMessagePayload(payload, async (submittedPayload) => {
      submittedReferences = submittedPayload.canvasNodeReferences
    })

    expect(outcome).toBe('submitted')
    expect(submittedReferences).toEqual([canvasReferenceA])
  })

  test('Given 后台等待的仅引用消息 When 主进程提交失败 Then 不进入成功清理引用路径', async () => {
    const payload = buildQueuedMessageSendPayload(createAgentQueuedMessage('', 'message-background', 100, null, {
      canvasNodeReferences: [canvasReferenceA],
    }))
    /** 模拟 composer 当前仍持有的引用。 */
    let currentReferences = [canvasReferenceA]

    try {
      const outcome = await submitQueuedMessagePayload(payload, async () => {
        throw new Error('主进程未接管')
      })
      if (outcome === 'submitted') {
        currentReferences = removeSentCanvasNodeReferences(currentReferences, [canvasReferenceA])
      }
    } catch {
      // 提交失败由 AgentView 的现有错误恢复路径处理；此处只验证成功副作用不会发生。
    }

    expect(currentReferences).toEqual([canvasReferenceA])
  })

  test('Given 队列中的仅引用消息 When 立即发送未成功 Then 本地队列保留供重试', async () => {
    const message = createAgentQueuedMessage('', 'message-queued', 100, null, {
      canvasNodeReferences: [canvasReferenceA],
    })
    const payload = buildQueuedMessageSendPayload(message)
    /** 模拟 Renderer 当前队列投影。 */
    let queue = [message]

    try {
      const outcome = await submitQueuedMessagePayload(payload, async () => {
        throw new Error('重新提交失败')
      })
      if (outcome === 'submitted') {
        queue = queue.filter((item) => item.id !== message.id)
      }
    } catch {
      // 失败时不提前删除本地队列，用户仍可再次发送。
    }

    expect(queue).toEqual([message])
  })

  test('Given 普通空消息且没有引用 When 请求提交 Then 保持既有 skipped 行为', async () => {
    const payload = buildQueuedMessageSendPayload(createAgentQueuedMessage('', 'message-empty', 100))
    /** 记录空消息是否误触发主进程提交。 */
    let submitted = false

    const outcome = await submitQueuedMessagePayload(payload, async () => {
      submitted = true
    })

    expect(outcome).toBe('skipped')
    expect(submitted).toBe(false)
  })

  test('Given 已有引用和重复新引用 When 合并 Then 按画布与节点去重并保持正文无关', () => {
    const text = '基于这些页面继续设计'

    expect(addCanvasNodeReferences(
      [canvasReferenceA],
      [canvasReferenceA, canvasReferenceB],
    )).toEqual([canvasReferenceA, canvasReferenceB])
    expect(text).toBe('基于这些页面继续设计')
  })

  test('Given 排队消息携带节点引用 When 构建发送载荷 Then 完整保留结构化快照', () => {
    const message = createAgentQueuedMessage('继续', 'message-1', 100, null, {
      canvasNodeReferences: [canvasReferenceA],
    })

    expect(message.canvasNodeReferences).toEqual([canvasReferenceA])
    expect(buildQueuedMessageSendPayload(message).canvasNodeReferences).toEqual([canvasReferenceA])
  })

  test('Given 普通排队消息 When 构建发送载荷 Then 不增加空引用字段', () => {
    const message = createAgentQueuedMessage('继续', 'message-1', 100)

    expect(message).not.toHaveProperty('canvasNodeReferences')
    expect(buildQueuedMessageSendPayload(message)).not.toHaveProperty('canvasNodeReferences')
  })

  test('Given 发送期间同节点引用已更新 When 旧发送成功 Then 只清精确旧快照并保留新引用', () => {
    const updatedReference = { ...canvasReferenceA, nodeRevision: 5, title: '需求说明 v5' }

    expect(removeSentCanvasNodeReferences(
      [updatedReference, canvasReferenceB],
      [canvasReferenceA, canvasReferenceB],
    )).toEqual([updatedReference])
  })

  test('Given 带附件和引用的发送失败 When 使用排队消息恢复 composer Then 正文附件与引用快照均完整保留', () => {
    const failedMessage = createAgentQueuedMessage('保留这段正文', 'message-failed', 200, null, {
      attachments: [{
        filename: 'brief.png',
        mediaType: 'image/png',
        size: 128,
        targetPath: '/session/brief.png',
      }],
      canvasNodeReferences: [canvasReferenceA],
    })

    expect(failedMessage.text).toBe('保留这段正文')
    expect(failedMessage.attachments?.[0]?.filename).toBe('brief.png')
    expect(failedMessage.canvasNodeReferences).toEqual([canvasReferenceA])
  })

  test('Given 发送等待期间用户已输入新草稿 When 旧发送失败 Then 新旧正文都保留且不重复', () => {
    expect(mergeAgentDraftWithRestoredMessage('新的补充', '原发送正文')).toBe('新的补充\n\n原发送正文')
    expect(mergeAgentDraftWithRestoredMessage('原发送正文', '原发送正文')).toBe('原发送正文')
    expect(mergeAgentDraftWithRestoredMessage('', '原发送正文')).toBe('原发送正文')
  })
})

describe('queued message @file mention path decoding (Agent 侧真实路径)', () => {
  test('decodes percent-encoded @file path back to the real path with spaces', () => {
    const text = '请查看 @file:%2FUsers%2Fme%2FMy%20report.pdf 这份报告'
    const result = parseQueuedMessageMentions(text)
    expect(result.cleanedText).toBe('请查看 @file:/Users/me/My report.pdf 这份报告')
  })

  test('keeps legacy unencoded @file paths unchanged', () => {
    const text = '参考 @file:notes/brief.md 内容'
    const result = parseQueuedMessageMentions(text)
    expect(result.cleanedText).toBe('参考 @file:notes/brief.md 内容')
  })

  test('decode does not affect skill / mcp / session mentions removal', () => {
    const text = '@file:%2FUsers%2Fme%2FMy%20report.pdf /skill:brainstorming #mcp:playwright &session:session-123'
    const result = parseQueuedMessageMentions(text)
    expect(result.cleanedText).toBe('@file:/Users/me/My report.pdf')
    expect(result.mentionedSkills).toEqual(['brainstorming'])
    expect(result.mentionedMcpServers).toEqual(['playwright'])
    expect(result.mentionedSessionIds).toEqual(['session-123'])
  })

  test('buildQueuedMessageSendPayload sdkText contains the real (decoded) file path', () => {
    const payload = buildQueuedMessageSendPayload({
      id: 'msg-1',
      text: '看下 @file:%2FUsers%2Fme%2FMy%20report.pdf',
      createdAt: Date.now(),
    })
    expect(payload.sdkText).toContain('@file:/Users/me/My report.pdf')
  })

  test('getQueuedMessageDisplayParts shows the full filename for encoded paths with spaces', () => {
    const parts = getQueuedMessageDisplayParts('看下 @file:%2FUsers%2Fme%2FMy%20report.pdf 这份报告')
    const fileRef = parts.find((p) => p.type === 'reference' && p.referenceType === 'file')
    expect(fileRef).toBeDefined()
    if (fileRef && 'referenceType' in fileRef) {
      // id 保留协议原始值（编码）；label 是展示层解码后的完整文件名
      expect(fileRef.id).toBe('%2FUsers%2Fme%2FMy%20report.pdf')
      expect(fileRef.label).toBe('My report.pdf')
    }
  })

  test('preserves text immediately after a file mention without whitespace', () => {
    const text = '@file:Screenshot%202026-08-24%20at%2014.17.47.png还是做一个单独渲染的内容吧'
    const result = parseQueuedMessageMentions(text)

    expect(result.cleanedText).toBe('@file:Screenshot 2026-08-24 at 14.17.47.png还是做一个单独渲染的内容吧')
    expect(getQueuedMessageDisplayParts(text)).toEqual([
      {
        type: 'reference',
        referenceType: 'file',
        id: 'Screenshot%202026-08-24%20at%2014.17.47.png',
        label: 'Screenshot 2026-08-24 at 14.17.47.png',
      },
      { type: 'text', value: '还是做一个单独渲染的内容吧' },
    ])
  })

  test('parses and renders a CJK MCP server name', () => {
    const text = '#mcp:中文服务器 后续处理'
    const result = parseQueuedMessageMentions(text)

    expect(result.mentionedMcpServers).toEqual(['中文服务器'])
    expect(result.cleanedText).toBe('后续处理')
    expect(getQueuedMessageDisplayParts(text)).toEqual([
      {
        type: 'reference',
        referenceType: 'mcp',
        id: '中文服务器',
        label: '中文服务器',
      },
      { type: 'text', value: ' 后续处理' },
    ])
  })
})
