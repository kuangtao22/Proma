import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmptyDesignDocument } from '@proma/shared'
import type {
  AgentMessage,
  AgentSessionMeta,
  DesignAsset,
  DesignCanvasDocument,
  DesignMutation,
} from '@proma/shared'
import sharp from 'sharp'
import type { DesignAssetImportBatch } from './design-asset-service'
import { DesignSessionBridge } from './design-session-bridge'
import { applyDesignMutations } from './design-store'

describe('Design Session Bridge', () => {
  /** 每个用例独立的 Agent 图片授权根。 */
  let root: string
  /** 当前权威画布文档。 */
  let document: DesignCanvasDocument
  /** 测试会话索引。 */
  let sessions: Map<string, AgentSessionMeta>
  /** 测试会话持久化消息。 */
  let messages: Map<string, AgentMessage[]>
  /** 已进入素材服务的真实路径。 */
  let importedPaths: string[]
  /** 素材事务提交次数。 */
  let commitCount: number
  /** Sharp 生成的完整一像素 PNG，确保桥执行真实图片签名校验。 */
  let pngBytes: Buffer

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'proma-design-session-bridge-'))
    pngBytes = await sharp({
      create: { width: 1, height: 1, channels: 4, background: '#ffffff' },
    }).png().toBuffer()
    document = createEmptyDesignDocument('project-1', 10)
    document.assets = [createAsset('asset-existing', 'existing.png')]
    sessions = new Map([
      ['session-1', createSession('session-1', 'project-1')],
      ['session-2', createSession('session-2', 'project-1')],
      ['session-other', createSession('session-other', 'project-2')],
    ])
    messages = new Map()
    importedPaths = []
    commitCount = 0
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** 创建使用真实文件边界、但内存 Store 的桥实例。 */
  const createBridge = (): DesignSessionBridge => new DesignSessionBridge({
    getSession: (sessionId) => sessions.get(sessionId),
    getMessages: (sessionId) => messages.get(sessionId) ?? [],
    resolveAgentImagePath: (localPath) => localPath,
    getAllowedRoots: () => [root],
    store: {
      requireStableAuthoritativeDocument: (projectId) => {
        if (projectId !== document.projectId) throw new Error(`项目不存在: ${projectId}`)
        return document
      },
      mutate: (projectId, expectedRevision, mutations: DesignMutation[]) => {
        if (projectId !== document.projectId || expectedRevision !== document.revision) throw new Error('revision conflict')
        document = { ...applyDesignMutations(document, mutations), revision: document.revision + 1 }
        return document
      },
    },
    assets: {
      resolveAssetPath: (_projectId, assetId) => join(root, `${assetId}.png`),
      importAuthorizedFiles: async (_projectId, sourcePaths) => {
        importedPaths.push(...sourcePaths)
        const batch = [createAsset('asset-imported', 'agent.png')] as DesignAssetImportBatch
        batch.commit = () => { commitCount += 1 }
        batch.rollback = () => undefined
        return batch
      },
    },
    createId: () => 'node-imported',
  })

  test('Given 同项目会话与已有素材 When 准备发送 Then 返回主进程解析的项目素材引用且零会话副作用', () => {
    writeFileSync(join(root, 'asset-existing.png'), pngBytes)
    const bridge = createBridge()

    expect(bridge.prepareAssetForSession({
      projectId: 'project-1', assetId: 'asset-existing', sessionId: 'session-1',
    })).toEqual({
      sessionId: 'session-1',
      path: realpathSync(join(root, 'asset-existing.png')),
      name: 'existing.png',
      isDirectory: false,
      scope: 'project',
    })
    expect(messages.size).toBe(0)
  })

  test('Given 目标会话属于其它项目 When 准备素材 Then 在解析素材路径前拒绝', () => {
    const bridge = createBridge()

    expect(() => bridge.prepareAssetForSession({
      projectId: 'project-1', assetId: 'asset-existing', sessionId: 'session-other',
    })).toThrow('Agent 会话不属于当前项目')
  })

  test('Given 图片精确属于当前会话 When 导入设计 Then 校验真实路径并原子创建素材节点', async () => {
    const imagePath = join(root, 'owned.png')
    writeFileSync(imagePath, pngBytes)
    messages.set('session-1', [createToolResultMessage(imagePath)])
    const bridge = createBridge()

    const snapshot = await bridge.importAgentImage({
      projectId: 'project-1', sessionId: 'session-1', localPath: imagePath,
      position: { x: 40, y: 60 },
    })

    expect(importedPaths).toEqual([realpathSync(imagePath)])
    expect(commitCount).toBe(1)
    expect(snapshot.document.assets.at(-1)?.id).toBe('asset-imported')
    expect(snapshot.document.nodes.at(-1)).toMatchObject({
      id: 'node-imported', kind: 'asset', assetId: 'asset-imported',
      position: { x: 40, y: 60 }, width: 320, height: 240,
    })
  })

  test('Given SDK 工具结果持久化图片归属 When 导入设计 Then 接受当前会话的精确附件字段', async () => {
    const imagePath = join(root, 'sdk-owned.png')
    writeFileSync(imagePath, pngBytes)
    messages.set('session-1', createSdkToolResultMessages(imagePath) as unknown as AgentMessage[])
    const bridge = createBridge()

    await bridge.importAgentImage({
      projectId: 'project-1', sessionId: 'session-1', localPath: imagePath,
      position: { x: 12, y: 24 },
    })

    expect(importedPaths).toEqual([realpathSync(imagePath)])
  })

  test('Given 路径只出现在另一会话或从未持久化 When 导入设计 Then 精确拒绝且不扫描目录', async () => {
    const imagePath = join(root, 'other-session.png')
    writeFileSync(imagePath, pngBytes)
    messages.set('session-2', [createToolResultMessage(imagePath)])
    const bridge = createBridge()

    await expect(bridge.importAgentImage({
      projectId: 'project-1', sessionId: 'session-1', localPath: imagePath,
      position: { x: 0, y: 0 },
    })).rejects.toThrow('图片不属于指定 Agent 会话')
    await expect(bridge.importAgentImage({
      projectId: 'project-1', sessionId: 'session-1', localPath: join(root, 'forged.png'),
      position: { x: 0, y: 0 },
    })).rejects.toThrow('图片不属于指定 Agent 会话')
    expect(importedPaths).toEqual([])
  })

  test('Given 持久化路径通过符号解析后越过允许根 When 导入设计 Then 在素材服务前拒绝', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'proma-design-session-outside-'))
    try {
      const imagePath = join(outside, 'outside.png')
      writeFileSync(imagePath, pngBytes)
      messages.set('session-1', [createToolResultMessage(imagePath)])
      const bridge = createBridge()

      await expect(bridge.importAgentImage({
        projectId: 'project-1', sessionId: 'session-1', localPath: imagePath,
        position: { x: 0, y: 0 },
      })).rejects.toThrow('图片不在指定 Agent 会话的授权目录内')
      expect(importedPaths).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('Given 图片位于另一工作区生成目录 When 当前会话导入 Then 即使消息路径匹配也拒绝跨工作区', async () => {
    const otherWorkspace = mkdtempSync(join(tmpdir(), 'proma-design-other-workspace-'))
    try {
      const imagePath = join(otherWorkspace, 'generated-images', 'other.png')
      mkdirSync(join(otherWorkspace, 'generated-images'), { recursive: true })
      writeFileSync(imagePath, pngBytes)
      messages.set('session-1', [createToolResultMessage(imagePath)])

      await expect(createBridge().importAgentImage({
        projectId: 'project-1', sessionId: 'session-1', localPath: imagePath,
        position: { x: 0, y: 0 },
      })).rejects.toThrow('图片不在指定 Agent 会话的授权目录内')
      expect(importedPaths).toEqual([])
    } finally {
      rmSync(otherWorkspace, { recursive: true, force: true })
    }
  })

  test('Given 持久化图片超过 64 MiB When 导入设计 Then 在素材服务读取前拒绝', async () => {
    const imagePath = join(root, 'oversized.png')
    writeFileSync(imagePath, '')
    truncateSync(imagePath, 64 * 1024 * 1024 + 1)
    messages.set('session-1', [createToolResultMessage(imagePath)])

    await expect(createBridge().importAgentImage({
      projectId: 'project-1', sessionId: 'session-1', localPath: imagePath,
      position: { x: 0, y: 0 },
    })).rejects.toThrow('图片不能超过 64 MiB')
    expect(importedPaths).toEqual([])
  })
})

/** 创建最小项目会话元数据。 */
function createSession(id: string, workspaceId: string): AgentSessionMeta {
  return { id, title: id, workspaceId, createdAt: 1, updatedAt: 1 }
}

/** 创建素材元数据。 */
function createAsset(id: string, filename: string): DesignAsset {
  return {
    id, filename, relativePath: `assets/${filename}`, thumbnailRelativePath: `thumbnails/${id}.webp`,
    mediaType: 'image/png', width: 1, height: 1, byteSize: 68,
    sha256: 'a'.repeat(64), createdAt: 10,
  }
}

/** 创建包含精确图片归属证据的持久化工具消息。 */
function createToolResultMessage(localPath: string): AgentMessage {
  return {
    id: 'message-1', role: 'assistant', content: '', createdAt: 10,
    events: [{
      type: 'tool_result', toolUseId: 'tool-1', toolName: 'mcp__nano_banana__generate_image',
      result: 'ok', isError: false,
      imageAttachments: [{ localPath, filename: 'owned.png', mediaType: 'image/png' }],
    }],
  }
}

/** 创建当前 SDK JSONL 格式的工具结果归属证据。 */
function createSdkToolResultMessages(localPath: string): object[] {
  return [{
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use', id: 'tool-sdk-1', name: 'mcp__nano_banana__generate_image', input: {},
      }],
    },
  }, {
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-sdk-1',
        content: 'ok',
        imageAttachments: [{ localPath, filename: 'sdk-owned.png', mediaType: 'image/png' }],
      }],
    },
  }]
}
