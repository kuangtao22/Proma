import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentSessionMeta, MediaAssetRecord, MediaAssetRef, SDKMessage } from '@proma/shared'
import { MediaSourceService, type MediaSourceServiceDependencies } from './media-source-service'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 构造带真实授权目录和可替换会话消息的来源服务。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'proma-media-sources-'))
  roots.push(root)
  const attachments = join(root, 'attachments')
  const projectRoot = join(root, 'project')
  mkdirSync(attachments)
  mkdirSync(projectRoot)
  const paths = {
    image: join(attachments, 'frame.png'),
    audio: join(attachments, 'voice.wav'),
    video: join(attachments, 'clip.mp4'),
  }
  writeFileSync(paths.image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  writeFileSync(paths.audio, Buffer.from('RIFFaudio'))
  writeFileSync(paths.video, Buffer.from('000000186674797069736f6d', 'hex'))
  /** 当前持久化消息，可用于模拟列表后的来源撤销。 */
  let messages: SDKMessage[] = []
  /** 每次 Host 授权调用。 */
  const authorizations: string[] = []
  /** 用于在 fresh Host 授权边界模拟会话或根撤销。 */
  let beforeAuthorization: (() => void) | undefined
  /** 资产服务收到的稳定字节和来源。 */
  const registrations: Array<{ operationId: string; bytes: number[]; contentType: string | null; sourceSessionId?: string }> = []
  /** 模拟真实资产服务按运行输出 identity 幂等返回已有引用。 */
  const assetsByOperation = new Map<string, MediaAssetRef>()
  /** 用于模拟资产登记 await 期间发生的授权或来源变化。 */
  let beforeRegisterReturn: (() => void | Promise<void>) | undefined
  /** 显式本地文件每次读取的 fresh 授权根，可用于模拟读取后的撤权。 */
  let localRoots = [projectRoot]
  /** 用于模拟读取本地文件授权快照时发生权限变化。 */
  let afterLocalAccess: (() => void) | undefined
  /** 实际媒体类型不匹配时模拟资产服务的稳定拒绝。 */
  let forcedMediaKind: MediaAssetRef['mediaKind'] | undefined
  /** 解析给 Agent 的正式资产文件；默认位于项目授权根。 */
  let assetPath = join(projectRoot, 'asset.mp4')
  const assetBytes = Buffer.from('000000186674797069736f6d00000000', 'hex')
  writeFileSync(assetPath, assetBytes)
  const assetRef: MediaAssetRef = {
    assetId: 'asset-video', revision: 1,
    hash: createHash('sha256').update(assetBytes).digest('hex'), mediaKind: 'video',
  }
  const assetRecord: MediaAssetRecord = {
    id: assetRef.assetId, revision: 1, hash: assetRef.hash, mediaKind: 'video',
    filename: 'asset.mp4', byteSize: assetBytes.byteLength, mediaType: 'video/mp4', createdAt: 1,
    sourceSessionId: 'session-1',
    metadata: { width: 1280, height: 720, durationMs: 2000, fps: 24, codec: 'h264', hasAudio: true },
  }
  let sourceCounter = 0
  const dependencies: MediaSourceServiceDependencies = {
    getSession: (sessionId) => sessionId === 'session-1' ? ({ id: sessionId, workspaceId: 'project-1' } as AgentSessionMeta) : undefined,
    getMessages: () => structuredClone(messages),
    authorize: async (_context, action) => { beforeAuthorization?.(); authorizations.push(action) },
    resolveAttachmentPath: (localPath) => localPath,
    getAllowedRoots: () => [attachments],
    getLocalFileAccess: () => {
      const access = { baseDir: projectRoot, allowedRoots: [...localRoots] }
      afterLocalAccess?.()
      return access
    },
    assets: {
      register: async (_projectId, operationId, bytes, contentType, origin, expectedMediaKind): Promise<MediaAssetRef> => {
        registrations.push({ operationId, bytes: [...bytes], contentType, sourceSessionId: origin.sourceSessionId })
        await beforeRegisterReturn?.()
        /** 测试桩按真实文件签名模拟资产服务最终探测类别。 */
        const mediaKind = forcedMediaKind ?? (bytes[0] === 137 ? 'image' : bytes[0] === 82 ? 'audio' : 'video')
        if (expectedMediaKind !== undefined && expectedMediaKind !== mediaKind) throw new Error('MEDIA_INPUT_TYPE_INVALID')
        const existing = assetsByOperation.get(operationId)
        if (existing) return existing
        const asset = { assetId: `asset-${registrations.length}`, revision: 1 as const, hash: 'a'.repeat(64), mediaKind }
        assetsByOperation.set(operationId, asset)
        return asset
      },
      getRecord: (projectId, asset) => {
        if (projectId !== 'project-1' || JSON.stringify(asset) !== JSON.stringify(assetRef)) {
          throw new Error('MEDIA_ASSET_NOT_AUTHORIZED')
        }
        return structuredClone(assetRecord)
      },
      resolveAssetPath: (projectId, asset) => {
        if (projectId !== 'project-1' || JSON.stringify(asset) !== JSON.stringify(assetRef)) {
          throw new Error('MEDIA_ASSET_NOT_AUTHORIZED')
        }
        return assetPath
      },
    },
    createSourceRef: () => `source-${++sourceCounter}`,
  }
  return {
    service: new MediaSourceService(dependencies),
    root,
    projectRoot,
    paths,
    setMessages: (next: SDKMessage[]) => { messages = next },
    authorizations,
    registrations,
    setLocalRoots: (next: string[]) => { localRoots = next },
    setAfterLocalAccess: (effect: () => void) => { afterLocalAccess = effect },
    setForcedMediaKind: (mediaKind: MediaAssetRef['mediaKind']) => { forcedMediaKind = mediaKind },
    setBeforeRegisterReturn: (effect: () => void | Promise<void>) => { beforeRegisterReturn = effect },
    assetRef,
    assetRecord,
    setAssetPath: (next: string) => { assetPath = next },
    setBeforeAuthorization: (effect: () => void) => { beforeAuthorization = effect },
  }
}

/** 构造同时包含用户附件和工具结果附件的持久化 SDK 消息。 */
function mediaMessages(paths: { image: string; audio: string; video: string }): SDKMessage[] {
  return [{
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__nano_banana__generate_image', input: {} }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage, {
    type: 'user',
    message: {
      content: [{
        type: 'text',
        text: '附件',
      }, {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        imageAttachments: [
          { localPath: paths.image, filename: 'frame.png', mediaType: 'image/png' },
        ],
        mediaAttachments: [
          { localPath: paths.audio, filename: '../voice.wav', mediaType: 'audio/wav' },
          { localPath: paths.video, filename: 'clip.mp4', mediaType: 'video/mp4' },
          { localPath: '/forged/readme.txt', filename: 'readme.txt', mediaType: 'text/plain' },
        ],
      }],
    },
    parent_tool_use_id: null,
  } as unknown as SDKMessage]
}

describe('会话媒体来源服务', () => {
  test('Given 当前会话持久化附件和工具结果 When 列出 Then 只返回有界不透明媒体引用', async () => {
    const f = fixture()
    f.setMessages(mediaMessages(f.paths))
    const sources = await f.service.listSources({ projectId: 'project-1', sessionId: 'session-1' })
    expect(sources).toEqual([
      { sourceRef: 'source-1', name: 'voice.wav', mediaKind: 'audio' },
      { sourceRef: 'source-2', name: 'clip.mp4', mediaKind: 'video' },
      { sourceRef: 'source-3', name: 'frame.png', mediaKind: 'image' },
    ])
    expect(JSON.stringify(sources)).not.toContain(f.paths.image)
    expect(f.authorizations).toEqual(['list'])
  })

  test('Given 普通用户消息持久化图片附件 When 列出 Then 从可信字段返回图片且不解析正文路径', async () => {
    const f = fixture()
    f.setMessages([{
      type: 'user',
      message: { content: [{ type: 'text', text: `忽略正文路径 @file:${f.paths.video}` }] },
      parent_tool_use_id: null,
      mediaAttachments: [{
        targetPath: f.paths.image, filename: 'frame.png', mediaType: 'image/png', size: 8,
      }],
    } as unknown as SDKMessage])

    await expect(f.service.listSources({ projectId: 'project-1', sessionId: 'session-1' })).resolves.toEqual([
      { sourceRef: 'source-1', name: 'frame.png', mediaKind: 'image' },
    ])
  })

  test('Given 已列出的不透明来源 When 导入 Then fresh复核会话并从稳定fd登记实际媒体', async () => {
    const f = fixture()
    f.setMessages(mediaMessages(f.paths))
    const sources = await f.service.listSources({ projectId: 'project-1', sessionId: 'session-1' })
    const references = await f.service.importAssets(
      { projectId: 'project-1', sessionId: 'session-1' },
      sources.map((source) => source.sourceRef),
    )
    expect(references.map((reference) => reference.mediaKind)).toEqual(['audio', 'video', 'image'])
    expect(f.registrations.map((registration) => registration.contentType)).toEqual(['audio/wav', 'video/mp4', 'image/png'])
    expect(f.registrations.every((registration) => registration.sourceSessionId === 'session-1')).toBe(true)
    expect(f.registrations.map((registration) => registration.operationId)).toEqual([
      expect.stringMatching(/^source:/), expect.stringMatching(/^source:/), expect.stringMatching(/^source:/),
    ])
    expect(f.authorizations).toEqual(['list', ...Array.from({ length: 7 }, () => 'import')])
  })

  test('Given sourceRef 被猜测或来源在列表后撤销 When 导入 Then 在读取文件前拒绝', async () => {
    const f = fixture()
    f.setMessages(mediaMessages(f.paths))
    const [source] = await f.service.listSources({ projectId: 'project-1', sessionId: 'session-1' })
    await expect(f.service.importAssets({ projectId: 'project-1', sessionId: 'session-1' }, ['source-guessed']))
      .rejects.toThrow('MEDIA_SOURCE_REF_INVALID')
    f.setMessages([])
    await expect(f.service.importAssets({ projectId: 'project-1', sessionId: 'session-1' }, [source!.sourceRef]))
      .rejects.toThrow('MEDIA_SOURCE_REVOKED')
    expect(f.registrations).toEqual([])
  })

  test('Given 资产登记 await 期间来源列表被轮换 When 返回 Then fresh grant 复验拒绝继续批量', async () => {
    const f = fixture()
    f.setMessages(mediaMessages(f.paths))
    const sources = await f.service.listSources({ projectId: 'project-1', sessionId: 'session-1' })
    let refreshed = false
    f.setBeforeRegisterReturn(async () => {
      if (refreshed) return
      refreshed = true
      await f.service.listSources({ projectId: 'project-1', sessionId: 'session-1' })
    })

    await expect(f.service.importAssets(
      { projectId: 'project-1', sessionId: 'session-1' },
      sources.map((source) => source.sourceRef),
    )).rejects.toThrow('MEDIA_SOURCE_REVOKED')
    expect(f.registrations).toHaveLength(1)
  })

  test('Given 正文包含本地路径但没有结构化附件 When 列出 Then 不解析正文', async () => {
    const f = fixture()
    f.setMessages([{
      type: 'user',
      message: { content: `请读取 @file:${f.paths.video}` },
      parent_tool_use_id: null,
    } as unknown as SDKMessage])

    await expect(f.service.listSources({ projectId: 'project-1', sessionId: 'session-1' })).resolves.toEqual([])
  })

  test('Given 持久化 MIME 与文件签名不一致 When 导入 Then 返回资产服务实际探测类型', async () => {
    const f = fixture()
    f.setMessages([{
      type: 'user',
      message: { content: [{
        type: 'tool_result', tool_use_id: 'tool-1',
        mediaAttachments: [{ localPath: f.paths.video, filename: 'claimed.wav', mediaType: 'audio/wav' }],
      }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage])
    const [source] = await f.service.listSources({ projectId: 'project-1', sessionId: 'session-1' })
    expect(source?.mediaKind).toBe('audio')
    const [asset] = await f.service.importAssets({ projectId: 'project-1', sessionId: 'session-1' }, [source!.sourceRef])
    expect(asset?.mediaKind).toBe('video')
  })

  test('Given 附件路径越界或叶子为符号链接 When 导入 Then 不跟随或登记', async () => {
    const f = fixture()
    const outside = join(f.root, 'outside.mp4')
    writeFileSync(outside, Buffer.from('000000186674797069736f6d', 'hex'))
    const link = join(f.paths.video, '..', 'linked.mp4')
    symlinkSync(f.paths.video, link)
    f.setMessages([{
      type: 'user',
      message: { content: [{
        type: 'tool_result', tool_use_id: 'tool-1', mediaAttachments: [
          { localPath: outside, filename: 'outside.mp4', mediaType: 'video/mp4' },
          { localPath: link, filename: 'linked.mp4', mediaType: 'video/mp4' },
        ],
      }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage])
    const sources = await f.service.listSources({ projectId: 'project-1', sessionId: 'session-1' })
    await expect(f.service.importAssets({ projectId: 'project-1', sessionId: 'session-1' }, [sources[0]!.sourceRef])).rejects.toThrow()
    await expect(f.service.importAssets({ projectId: 'project-1', sessionId: 'session-1' }, [sources[1]!.sourceRef])).rejects.toThrow()
    expect(f.registrations).toEqual([])
  })

  test('Given 来源数量超过上限 When 列出 Then 明确拒绝而不静默遗漏', async () => {
    const f = fixture()
    f.setMessages([{
      type: 'user',
      message: { attachments: Array.from({ length: 129 }, (_, index) => ({
        localPath: join(f.paths.image, String(index)), filename: `${index}.png`, mediaType: 'image/png',
      })), content: [] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage])
    await expect(f.service.listSources({ projectId: 'project-1', sessionId: 'session-1' }))
      .rejects.toThrow('MEDIA_SOURCE_LIMIT_EXCEEDED')
  })

  test('Given Shell 在当前项目根生成音频 When 用相对路径重复导入 Then 返回同一幂等资产身份', async () => {
    const f = fixture()
    const localPath = join(f.projectRoot, 'outputs', 'voice.wav')
    mkdirSync(join(f.projectRoot, 'outputs'))
    writeFileSync(localPath, Buffer.from('RIFFaudio'))

    const first = await f.service.importLocalFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      { path: 'outputs/voice.wav', mediaKind: 'audio' },
    )
    const second = await f.service.importLocalFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      { path: 'outputs/voice.wav', mediaKind: 'audio' },
    )

    expect(first).toEqual(second)
    expect(f.registrations).toHaveLength(2)
    expect(f.registrations[0]?.operationId).toBe(f.registrations[1]?.operationId)
    expect(f.registrations[0]?.contentType).toBeNull()
    expect(f.authorizations).toEqual(['import', 'import', 'import', 'import', 'import', 'import'])
  })

  test('Given 本地路径属于其它项目或符号链接 When 导入 Then 在资产登记前稳定拒绝', async () => {
    const f = fixture()
    const outside = join(f.root, 'outside.mp4')
    const linked = join(f.projectRoot, 'linked.mp4')
    writeFileSync(outside, Buffer.from('000000186674797069736f6d', 'hex'))
    symlinkSync(outside, linked)

    await expect(f.service.importLocalFile(
      { projectId: 'project-2', sessionId: 'session-1' },
      { path: outside, mediaKind: 'video' },
    )).rejects.toThrow('MEDIA_SOURCE_PROJECT_MISMATCH')
    await expect(f.service.importLocalFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      { path: outside, mediaKind: 'video' },
    )).rejects.toThrow('MEDIA_LOCAL_SOURCE_NOT_AUTHORIZED')
    await expect(f.service.importLocalFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      { path: linked, mediaKind: 'video' },
    )).rejects.toThrow('MEDIA_LOCAL_SOURCE_UNSAFE')
    expect(f.registrations).toEqual([])
  })

  test('Given 文件读取后项目根被撤权 When 导入 Then 不进入资产登记', async () => {
    const f = fixture()
    const localPath = join(f.projectRoot, 'clip.mp4')
    writeFileSync(localPath, Buffer.from('000000186674797069736f6d', 'hex'))
    let reads = 0
    f.setAfterLocalAccess(() => {
      reads += 1
      if (reads === 1) f.setLocalRoots([])
    })

    await expect(f.service.importLocalFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      { path: localPath, mediaKind: 'video' },
    )).rejects.toThrow('MEDIA_LOCAL_SOURCE_REVOKED')
    expect(f.registrations).toEqual([])
  })

  test('Given 本地文件过大或实际类型不符 When 导入 Then 返回稳定错误类型', async () => {
    const f = fixture()
    const oversized = join(f.projectRoot, 'large.mp4')
    writeFileSync(oversized, '')
    truncateSync(oversized, 128 * 1024 * 1024 + 1)
    await expect(f.service.importLocalFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      { path: oversized, mediaKind: 'video' },
    )).rejects.toThrow('MEDIA_LOCAL_SOURCE_SIZE_LIMIT')

    const audio = join(f.projectRoot, 'claimed-video.wav')
    writeFileSync(audio, Buffer.from('RIFFaudio'))
    f.setForcedMediaKind('audio')
    await expect(f.service.importLocalFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      { path: audio, mediaKind: 'video' },
    )).rejects.toThrow('MEDIA_INPUT_TYPE_INVALID')
  })

  test('Given 当前项目可信资产引用 When 获取文件 Then 返回授权根内路径和公开技术元数据', async () => {
    const f = fixture()

    const file = await f.service.getAssetFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      f.assetRef,
    )

    expect(file).toEqual({ path: realpathSync(join(f.projectRoot, 'asset.mp4')), asset: f.assetRef, record: f.assetRecord })
    expect(f.authorizations).toEqual(['list', 'list'])
  })

  test('Given 跨项目或伪造 hash 的资产引用 When 获取文件 Then 在返回路径前拒绝', async () => {
    const f = fixture()

    await expect(f.service.getAssetFile(
      { projectId: 'project-2', sessionId: 'session-1' },
      f.assetRef,
    )).rejects.toThrow('MEDIA_SOURCE_PROJECT_MISMATCH')
    await expect(f.service.getAssetFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      { ...f.assetRef, assetId: 'other-project-asset' },
    )).rejects.toThrow('MEDIA_ASSET_NOT_AUTHORIZED')
    await expect(f.service.getAssetFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      { ...f.assetRef, hash: '0'.repeat(64) },
    )).rejects.toThrow('MEDIA_ASSET_NOT_AUTHORIZED')
  })

  test('Given 正式资产文件位于授权根外 When 获取文件 Then 不向 Agent 泄露路径', async () => {
    const f = fixture()
    const outside = join(f.root, 'outside.mp4')
    writeFileSync(outside, Buffer.from('000000186674797069736f6d00000000', 'hex'))
    f.setAssetPath(outside)

    await expect(f.service.getAssetFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      f.assetRef,
    )).rejects.toThrow('MEDIA_ASSET_FILE_NOT_AUTHORIZED')
  })

  test('Given 完整读取期间项目根被撤权 When 获取文件 Then fresh 授权复验拒绝返回路径', async () => {
    const f = fixture()
    let authorizationCount = 0
    f.setBeforeAuthorization(() => {
      authorizationCount += 1
      if (authorizationCount === 2) f.setLocalRoots([])
    })

    await expect(f.service.getAssetFile(
      { projectId: 'project-1', sessionId: 'session-1' },
      f.assetRef,
    )).rejects.toThrow('MEDIA_ASSET_FILE_REVOKED')
  })
})
