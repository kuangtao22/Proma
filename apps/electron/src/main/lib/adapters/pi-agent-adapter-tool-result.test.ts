import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentMessage, AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import type { AgentRuntimeGuard } from '../agent-runtime-guards'
import { convertPiMessage } from './pi-message-adapter'

type PiAdapterModule = typeof import('./pi-agent-adapter')
let installRuntimeGuardHooks: PiAdapterModule['installRuntimeGuardHooks']

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getName: () => 'Proma Test' },
  BrowserWindow: { getAllWindows: () => [] },
  WebContentsView: class {},
  MessageChannelMain: class {},
  utilityProcess: {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  shell: { openExternal: async () => undefined, openPath: async () => '' },
  dialog: {}, clipboard: {}, nativeImage: {}, screen: {}, globalShortcut: {},
  powerSaveBlocker: {}, powerMonitor: {}, systemPreferences: {}, Menu: {},
  Notification: class {},
  net: {},
  session: {},
  safeStorage: { isEncryptionAvailable: () => false },
  default: {},
}))

beforeAll(async () => {
  ;({ installRuntimeGuardHooks } = await import('./pi-agent-adapter'))
})

const imageToolName = 'mcp__nano_banana__generate_image'

/** 创建不改变结果的守卫，用于只验证 afterToolCall 的失败标记。 */
function createPassThroughGuard(): AgentRuntimeGuard {
  return {
    recordMessage: () => undefined,
    shouldStopBeforeNextTurn: () => false,
    applyToolResult: <TDetails>(result: AgentToolResult<TDetails>) => result,
    getLimitResultOverride: () => undefined,
    getResultOverride: () => undefined,
  }
}

/** 运行一次真实 Pi 工具循环，并返回持久化的工具结果消息。 */
async function runImageToolLoop(
  result: AgentToolResult<unknown>,
  toolCallId = 'tool-image-1',
): Promise<{ message: AgentMessage; modelCalls: number }> {
  const provider = fauxProvider()
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall(imageToolName, { prompt: 'draw' }, { id: toolCallId }), {
      stopReason: 'toolUse',
    }),
  ])
  const tool = {
    name: imageToolName,
    label: '生成图片',
    description: '测试工具',
    parameters: Type.Object({ prompt: Type.String() }),
    execute: async () => result,
  } as unknown as AgentTool
  const agent = new Agent({
    initialState: { model: provider.models[0], tools: [tool] },
    streamFn: provider.provider.streamSimple,
  })
  installRuntimeGuardHooks({ agent } as unknown as Parameters<typeof installRuntimeGuardHooks>[0], createPassThroughGuard())

  await agent.prompt('生成一张图片')
  const message = agent.state.messages.find((item) => item.role === 'toolResult')
  if (!message) throw new Error('测试未收到 Pi 工具结果')
  return { message, modelCalls: provider.state.callCount }
}

describe('Pi Nano Banana 失败结果传播', () => {
  test('Given 可信 503 失败详情 When Pi 完成工具调用 Then SDK 标记 is_error 且单轮终止', async () => {
    const { message, modelCalls } = await runImageToolLoop({
      content: [{ type: 'text', text: '图片生成失败: 生图服务请求失败 (503)：No available compatible accounts' }],
      details: {
        source: 'proma-nano-banana',
        toolUseId: 'tool-image-1',
        generated: false,
        imageAttachments: [],
        error: { message: '生图服务请求失败 (503)：No available compatible accounts' },
      },
      terminate: true,
    })

    const sdkMessage = convertPiMessage(message, 'session-1') as {
      message: { content: Array<{ content?: unknown; is_error?: boolean }> }
      tool_use_result?: unknown
    }
    expect(message).toMatchObject({ role: 'toolResult', isError: true })
    expect(sdkMessage.message.content[0]?.is_error).toBe(true)
    expect(JSON.stringify(sdkMessage.message.content[0]?.content)).toContain('No available compatible accounts')
    expect(sdkMessage.tool_use_result).toMatchObject({
      source: 'proma-nano-banana',
      toolUseId: 'tool-image-1',
      error: { message: expect.stringContaining('503') },
    })
    expect(modelCalls).toBe(1)
  })

  test('Given 图片工具成功 When Pi 完成工具调用 Then SDK 保持非错误并单轮终止', async () => {
    const { message, modelCalls } = await runImageToolLoop({
      content: [{ type: 'text', text: '图片已生成。' }],
      details: {
        source: 'proma-nano-banana',
        toolUseId: 'tool-image-1',
        generated: true,
        imageAttachments: [{ localPath: 'session-1/image.png', filename: 'image.png', mediaType: 'image/png' }],
      },
      terminate: true,
    })

    expect(message).toMatchObject({ role: 'toolResult', isError: false })
    expect((convertPiMessage(message, 'session-1') as {
      message: { content: Array<{ is_error?: boolean }> }
    }).message.content[0]?.is_error).toBe(false)
    expect(modelCalls).toBe(1)
  })

  test.each([
    ['仅无图片', {
      source: 'proma-nano-banana',
      toolUseId: 'tool-image-1',
      generated: false,
      imageAttachments: [],
    }],
    ['调用 ID 不匹配', {
      source: 'proma-nano-banana',
      toolUseId: 'forged-tool-id',
      generated: false,
      imageAttachments: [],
      error: { message: '伪造失败' },
    }],
    ['来源不匹配', {
      source: 'untrusted-source',
      toolUseId: 'tool-image-1',
      generated: false,
      imageAttachments: [],
      error: { message: '伪造失败' },
    }],
  ])('Given %s的结构化详情 When Pi 完成工具调用 Then 不提升为运行时错误', async (_name, details) => {
    const { message } = await runImageToolLoop({
      content: [{ type: 'text', text: '没有生成图片' }],
      details,
      terminate: true,
    })

    expect(message).toMatchObject({ role: 'toolResult', isError: false })
  })
})
