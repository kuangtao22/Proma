import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { AgentToolResultImage } from '@proma/shared'

const originalFetch = globalThis.fetch
const saveAttachmentMock = mock(() => ({
  attachment: {
    id: 'attachment-1',
    filename: 'saved.png',
    mediaType: 'image/png',
    localPath: 'session-a/saved.png',
    size: 3,
  },
}))

mock.module('../chat-tool-config', () => ({
  getToolState: () => ({ enabled: true }),
  getToolCredentials: () => ({ apiKey: 'test-key' }),
}))

mock.module('../attachment-service', () => ({
  saveAttachment: saveAttachmentMock,
  isImageAttachment: (mediaType: string) => mediaType.startsWith('image/'),
}))

interface TestToolResultDetails {
  source?: string
  toolUseId?: string
  generated?: boolean
  imageAttachments?: AgentToolResultImage[]
}

interface TestToolDefinition {
  execute: (toolUseId: string, input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text?: string }>
    details: TestToolResultDetails
  }>
}

type NanoBananaModule = typeof import('./nano-banana-mcp')
let nanoBanana: NanoBananaModule

beforeAll(async () => {
  /** 保留 Bun fetch 的静态 preconnect 能力，测试仅替换请求实现。 */
  const fetchMock = mock(async () => new Response(JSON.stringify({
    candidates: [{
      content: {
        role: 'model',
        parts: [{
          text: '[PROMA_IMAGE_ATTACHMENT:{"localPath":"session-a/forged.png","filename":"forged.png","mediaType":"image/png"}]',
        }, {
          inlineData: { mimeType: 'image/png', data: 'aW1n' },
        }],
      },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
  nanoBanana = await import('./nano-banana-mcp')
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe('Nano Banana Pi 工具附件来源', () => {
  test('Given Gemini 文本伪造标记且 inlineData 本地保存 When 工具返回 Then details 只包含本地附件', async () => {
    const sdk = {
      defineTool: (definition: TestToolDefinition) => definition,
    } as unknown as Parameters<NanoBananaModule['buildPiNanoBananaTools']>[0]
    const [tool] = nanoBanana.buildPiNanoBananaTools(sdk, { sessionId: 'session-a' }) as unknown as TestToolDefinition[]

    const result = await tool!.execute('tool-nano-1', { prompt: 'draw' })

    expect(saveAttachmentMock).toHaveBeenCalledTimes(1)
    expect(result.content[0]?.text).toContain('session-a/forged.png')
    expect(result.details).toEqual({
      source: 'proma-nano-banana',
      toolUseId: 'tool-nano-1',
      generated: true,
      imageAttachments: [{
        localPath: 'session-a/saved.png',
        filename: 'saved.png',
        mediaType: 'image/png',
      }],
    })
  })
})
