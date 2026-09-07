import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('AgentView 媒体附件发送合同', () => {
  test('Given 图片音视频附件 When 普通发送、即时插队、deferred 和历史重试 Then 显式传递 mediaAttachments', () => {
    const source = readFileSync(join(import.meta.dir, 'AgentView.tsx'), 'utf8')
    const sendStart = source.indexOf('/** 发送消息 */')
    const retryStart = source.indexOf('/** 重试：', sendStart)
    const sendBody = source.slice(sendStart, retryStart)
    const retryEnd = source.indexOf('/** 在新对话继续', retryStart)
    const retryBody = source.slice(retryStart, retryEnd)

    expect(source).toContain("attachment.mediaType.startsWith('image/')")
    expect(source).toContain("attachment.mediaType.startsWith('audio/')")
    expect(source).toContain("attachment.mediaType.startsWith('video/')")
    expect(sendBody.match(/mediaAttachments/g)?.length ?? 0).toBeGreaterThanOrEqual(6)
    expect(retryBody).toContain('lastUserSDKMessage.mediaAttachments')
    expect(retryBody).toContain('mediaAttachments: [...lastUserSDKMessage.mediaAttachments]')
    expect(sendBody).not.toContain('queuePresentation?.attachments')
  })
})
