import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { projectSDKMessageForDisplay } from './agent-message-display'

describe('音视频抽帧会话展示投影', () => {
  test('Given 内容检查工具返回内嵌抽帧 When 投影到界面 Then 保留文字并移除图片字节', () => {
    const original = {
      type: 'user',
      message: { content: [{
        type: 'tool_result', tool_use_id: 'canvas_inspect_media_content',
        content: [
          { type: 'text', text: '已生成 2 个抽帧样本' },
          { type: 'image', data: 'A'.repeat(400_000), mimeType: 'image/jpeg' },
        ],
      }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const projected = projectSDKMessageForDisplay(original)

    expect(JSON.stringify(projected)).toContain('已生成 2 个抽帧样本')
    expect(JSON.stringify(projected)).not.toContain('A'.repeat(1_000))
    expect(projected).not.toBe(original)
    expect(JSON.stringify(original)).toContain('A'.repeat(1_000))
  })
})
