import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentSessionMeta, AgentWorkspace, MediaAssetRef, SDKMessage } from '@proma/shared'
import { openAuthorizedAgentMediaSource } from './design/design-session-bridge'
import {
  prepareAgentMediaAttachmentsForSend,
  type AgentMediaAttachmentPreparationDependencies,
} from './agent-media-attachment-preparation'
import { MediaSourceService } from './media/media-source-service'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 构造真实文件、会话目录和稳定读取依赖。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'proma-agent-media-'))
  roots.push(root)
  const sourceRoot = join(root, 'project')
  const sessionRoot = join(root, 'session')
  const attachmentsDirectory = join(sessionRoot, 'attachments')
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(attachmentsDirectory, { recursive: true })
  const audioPath = join(sourceRoot, 'voice.wav')
  const videoPath = join(sourceRoot, 'clip.mp4')
  const imagePath = join(sourceRoot, 'frame.png')
  writeFileSync(audioPath, Buffer.from('RIFFvoice'))
  writeFileSync(videoPath, Buffer.from('000000186674797069736f6d', 'hex'))
  writeFileSync(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const session = { id: 'session-1', workspaceId: 'project-1' } as AgentSessionMeta
  const workspace = { id: 'project-1', slug: 'project-1' } as AgentWorkspace
  /** 生产稳定打开器复用同一 fd 完成授权与读取。 */
  const dependencies: AgentMediaAttachmentPreparationDependencies = {
    getSession: (sessionId) => sessionId === session.id ? session : undefined,
    getWorkspace: (workspaceId) => workspaceId === workspace.id ? workspace : undefined,
    getAllowedRoots: () => [sourceRoot, sessionRoot],
    getSessionAttachmentsDirectory: () => attachmentsDirectory,
    openSource: ({ inputPath, allowedRoots, maxBytes }) => openAuthorizedAgentMediaSource({
      inputPath,
      baseDir: root,
      allowedRoots,
      maxBytes,
      label: '媒体',
    }),
  }
  return { root, sourceRoot, sessionRoot, attachmentsDirectory, audioPath, videoPath, imagePath, dependencies }
}

describe('Agent 媒体附件固化', () => {
  test('Given 当前项目授权媒体 When 发送前准备 Then 固化到会话目录且重复准备保持同一文件', () => {
    const f = fixture()
    const input = {
      sessionId: 'session-1',
      workspaceId: 'project-1',
      mediaAttachments: [{
        filename: '../voice.wav', mediaType: 'audio/wav', size: 9, targetPath: f.audioPath,
      }],
    }

    const first = prepareAgentMediaAttachmentsForSend(input, f.dependencies)
    const second = prepareAgentMediaAttachmentsForSend(first, f.dependencies)
    expect(first.mediaAttachments?.[0]?.targetPath.startsWith(realpathSync(f.attachmentsDirectory))).toBe(true)
    expect(first.mediaAttachments?.[0]?.filename).toBe('voice.wav')
    expect(second.mediaAttachments).toEqual(first.mediaAttachments)
    writeFileSync(f.audioPath, 'changed')
    expect(readFileSync(first.mediaAttachments![0]!.targetPath, 'utf8')).toBe('RIFFvoice')
  })

  test('Given 旧消息缺少附件字段 When 准备 Then 保持原对象和既有行为', () => {
    const f = fixture()
    const input = { sessionId: 'session-1', workspaceId: 'project-1' }
    expect(prepareAgentMediaAttachmentsForSend(input, f.dependencies)).toBe(input)
  })

  test('Given 项目不匹配、伪造类型或错误大小 When 准备 Then 在持久化前拒绝', () => {
    const f = fixture()
    const base = {
      sessionId: 'session-1', workspaceId: 'project-1',
      mediaAttachments: [{ filename: 'voice.wav', mediaType: 'audio/wav', size: 9, targetPath: f.audioPath }],
    }
    expect(() => prepareAgentMediaAttachmentsForSend({ ...base, workspaceId: 'project-2' }, f.dependencies))
      .toThrow('AGENT_MEDIA_PROJECT_MISMATCH')
    expect(() => prepareAgentMediaAttachmentsForSend({
      ...base, mediaAttachments: [{ ...base.mediaAttachments[0]!, mediaType: 'text/plain' }],
    }, f.dependencies)).toThrow('AGENT_MEDIA_ATTACHMENT_INVALID')
    expect(() => prepareAgentMediaAttachmentsForSend({
      ...base, mediaAttachments: [{ ...base.mediaAttachments[0]!, size: 8 }],
    }, f.dependencies)).toThrow('AGENT_MEDIA_ATTACHMENT_CHANGED')
  })

  test('Given 越权路径或叶子符号链接 When 准备 Then 稳定文件边界拒绝', () => {
    const f = fixture()
    const outside = join(f.root, 'outside.mp4')
    const linked = join(f.sourceRoot, 'linked.mp4')
    writeFileSync(outside, Buffer.from('outside'))
    symlinkSync(f.videoPath, linked)
    const createInput = (targetPath: string, size: number) => ({
      sessionId: 'session-1', workspaceId: 'project-1',
      mediaAttachments: [{ filename: 'clip.mp4', mediaType: 'video/mp4', size, targetPath }],
    })
    expect(() => prepareAgentMediaAttachmentsForSend(createInput(outside, 7), f.dependencies)).toThrow()
    expect(() => prepareAgentMediaAttachmentsForSend(createInput(linked, 12), f.dependencies)).toThrow()
  })

  test('Given 发送边界固化的附件 When JSONL 回放并导入 Then MediaSourceService 读取同一结构化事实', async () => {
    const f = fixture()
    const prepared = prepareAgentMediaAttachmentsForSend({
      sessionId: 'session-1', workspaceId: 'project-1',
      mediaAttachments: [{ filename: 'frame.png', mediaType: 'image/png', size: 8, targetPath: f.imagePath }],
    }, f.dependencies)
    /** 模拟实际 SDKUserMessage 的单行 JSONL 序列化与重载。 */
    const jsonlPath = join(f.sessionRoot, 'messages.jsonl')
    const sentMessage: SDKMessage = {
      type: 'user', parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '处理图片' }] },
      mediaAttachments: prepared.mediaAttachments,
    }
    writeFileSync(jsonlPath, `${JSON.stringify(sentMessage)}\n`, 'utf8')
    const messages = readFileSync(jsonlPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as SDKMessage)
    const registrations: number[][] = []
    const service = new MediaSourceService({
      getSession: () => ({ id: 'session-1', workspaceId: 'project-1' } as AgentSessionMeta),
      getMessages: () => messages,
      authorize: () => undefined,
      resolveAttachmentPath: (path) => path,
      getAllowedRoots: () => [f.sessionRoot],
      assets: {
        register: async (_projectId, _operationId, bytes): Promise<MediaAssetRef> => {
          registrations.push([...bytes])
          return { assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' }
        },
      },
      createSourceRef: () => 'source-1',
    })
    const sources = await service.listSources({ projectId: 'project-1', sessionId: 'session-1' })
    expect(sources).toEqual([{ sourceRef: 'source-1', name: 'frame.png', mediaKind: 'image' }])
    await service.importAssets({ projectId: 'project-1', sessionId: 'session-1' }, ['source-1'])
    expect(registrations).toHaveLength(1)
  })
})
