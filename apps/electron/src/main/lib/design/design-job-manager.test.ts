import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEmptyDesignDocument,
} from '@proma/shared'
import type {
  AgentMessage,
  AgentSessionMeta,
  CreateDesignJobInput,
  DesignAsset,
  DesignCanvasDocument,
} from '@proma/shared'
import type { DesignAssetImportBatch, DesignAssetImportSource } from './design-asset-service'
import { DesignJobManager } from './design-job-manager'
import { applyDesignMutations } from './design-store'
import type { DesignStore } from './design-store'

const NANO_BANANA_TOOL = 'mcp__nano_banana__generate_image'

describe('Design Job Manager', () => {
  let cacheRoot: string
  let document: DesignCanvasDocument
  let harness: ReturnType<typeof createHarness>

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), 'proma-design-job-'))
    document = createEmptyDesignDocument('project-1', 1)
    document.assets = [createAsset('asset-source')]
    document.annotations = [{
      id: 'mask-1', kind: 'mask', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
      color: '#fff', width: 12, createdAt: 1,
    }]
    harness = createHarness()
  })

  afterEach(() => rmSync(cacheRoot, { recursive: true, force: true }))

  test('Given 图片编辑成功 When Pi 完成 Then 只导入当前任务图片并建立父子版本', async () => {
    harness.messages = [createToolMessage('session-1/output.png')]
    const job = harness.manager.create(createEditInput())

    await harness.manager.run(job.id)

    const completed = harness.manager.get(job.id)
    expect(completed).toMatchObject({
      status: 'succeeded',
      parentAssetId: 'asset-source',
      outputAssetId: 'asset-output',
      sessionId: 'session-1',
    })
    expect(harness.sessionUpdates).toEqual([{
      sessionId: 'session-1',
      updates: { sourceDesignProjectId: 'project-1', sourceDesignJobId: job.id },
    }])
    expect(harness.runInputs[0]).toMatchObject({
      source: 'design',
      triggeredBy: 'user',
      permissionModeOverride: 'bypassPermissions',
      allowedToolNames: [NANO_BANANA_TOOL],
    })
    expect(harness.runInputs[0]?.userMessage).toContain('/trusted/source.png')
    expect(harness.runInputs[0]?.userMessage).toContain('mask-1')
    expect(harness.importSources).toEqual([{
      kind: 'job',
      sourceJobId: job.id,
      sourceSessionId: 'session-1',
      parentAssetId: 'asset-source',
      prompt: '移除文字',
    }])
    expect(document.assets.map((asset) => asset.id)).toEqual(['asset-source', 'asset-output'])
    expect(document.nodes).toHaveLength(1)
    expect(document.nodes[0]).toMatchObject({ kind: 'asset', assetId: 'asset-output' })
  })

  test('Given 没有可用渠道或模型 When 运行 Then 直接失败且不创建空会话', async () => {
    harness.settings = { agentChannelId: 'channel-default' }
    const job = harness.manager.create(createGenerateInput())

    await harness.manager.run(job.id)

    expect(harness.manager.get(job.id)).toMatchObject({
      status: 'failed',
      error: '未配置可用的 Agent 渠道和模型',
    })
    expect(harness.createdSessions).toEqual([])
    expect(document.nodes[0]).toMatchObject({ kind: 'job', jobId: job.id })
  })

  test('Given Pi 成功结束但没有有效图片 When 完成 Then 标记失败并保留占位节点', async () => {
    harness.messages = [{ id: 'assistant-1', role: 'assistant', content: '完成', createdAt: 1 }]
    const job = harness.manager.create(createGenerateInput())

    await harness.manager.run(job.id)

    expect(harness.manager.get(job.id)).toMatchObject({
      status: 'failed',
      error: '任务完成但没有产生可验证图片',
    })
    expect(document.nodes[0]).toMatchObject({ kind: 'job', jobId: job.id })
  })

  test('Given running 任务取消后 Pi 迟到成功 When 完成回调到达 Then 保持 cancelled 且不导入', async () => {
    let completeRun: (() => void) | undefined
    harness.runHeadless = async (callbacks) => new Promise<void>((resolve) => {
      completeRun = () => {
        callbacks.onComplete([createToolMessage('session-1/output.png')])
        resolve()
      }
    })
    const job = harness.manager.create(createGenerateInput())
    const running = harness.manager.run(job.id)
    await Promise.resolve()

    await harness.manager.cancel('project-1', job.id)
    completeRun?.()
    await running

    expect(harness.manager.get(job.id)?.status).toBe('cancelled')
    expect(harness.stoppedSessions).toEqual(['session-1'])
    expect(harness.importSources).toEqual([])
    expect(document.nodes[0]).toMatchObject({ kind: 'job', jobId: job.id })
  })

  test('Given 失败任务 When 重试 Then 保留旧 journal 并用新任务和新会话接管原节点', async () => {
    harness.messages = []
    const original = harness.manager.create(createGenerateInput())
    await harness.manager.run(original.id)
    const originalJournal = join(cacheRoot, 'jobs', `${original.id}.json`)

    harness.messages = [createToolMessage('session-2/output.png')]
    const retried = harness.manager.retry('project-1', original.id)
    await harness.manager.run(retried.id)

    expect(retried.id).not.toBe(original.id)
    expect(harness.createdSessions.map((session) => session.id)).toEqual(['session-1', 'session-2'])
    expect(existsSync(originalJournal)).toBe(true)
    expect(JSON.parse(readFileSync(originalJournal, 'utf8')).status).toBe('failed')
    expect(document.nodes).toHaveLength(1)
    expect(document.nodes[0]).toMatchObject({ kind: 'asset', assetId: 'asset-output' })
  })

  test('Given 其它任务伪造相同工具图片 When 收集输出 Then 拒绝非当前 session 归属路径', async () => {
    harness.messages = [createToolMessage('other-session/output.png')]
    const job = harness.manager.create(createGenerateInput())

    await harness.manager.run(job.id)

    expect(harness.manager.get(job.id)).toMatchObject({
      status: 'failed',
      error: '任务完成但没有产生可验证图片',
    })
    expect(harness.importSources).toEqual([])
  })

  test('Given 上次进程留下 running job When 恢复 Then 标记 interrupted 且允许重试', () => {
    const jobsDirectory = join(cacheRoot, 'jobs')
    mkdirSync(jobsDirectory, { recursive: true })
    writeFileSync(join(jobsDirectory, 'job-running.json'), JSON.stringify({
      id: 'job-running', projectId: 'project-1', sessionId: 'session-old',
      action: 'generate', status: 'running', prompt: '旧任务', nodeId: 'node-old',
      position: { x: 0, y: 0 }, createdAt: 1, updatedAt: 1,
    }))

    const recovered = harness.manager.recover('project-1')

    expect(recovered[0]?.status).toBe('interrupted')
    expect(harness.manager.retry('project-1', 'job-running')).toMatchObject({
      status: 'queued',
      prompt: '旧任务',
    })
  })

  /** 创建覆盖真实状态机边界的可注入 Manager。 */
  function createHarness() {
    /** 状态机产生的单调 ID，测试可精确断言任务与会话关系。 */
    let identity = 0
    /** 当前模拟默认模型设置。 */
    const state: {
      settings: { agentChannelId?: string; agentModelId?: string }
      messages: AgentMessage[]
      runHeadless: undefined | ((callbacks: {
        onError: (error: string) => void
        onComplete: (messages?: AgentMessage[]) => void
      }) => Promise<void>)
    } = {
      settings: { agentChannelId: 'channel-default', agentModelId: 'model-default' },
      messages: [] as AgentMessage[],
      runHeadless: undefined,
    }
    const createdSessions: AgentSessionMeta[] = []
    const sessionUpdates: Array<{ sessionId: string; updates: Record<string, unknown> }> = []
    const stoppedSessions: string[] = []
    const importSources: DesignAssetImportSource[] = []
    const runInputs: Array<Record<string, unknown>> = []
    const store: DesignStore = {
      load: () => ({ document, writable: true }),
      requireStableAuthoritativeDocument: () => document,
      mutate: (_projectId, _expectedRevision, mutations) => {
        document = {
          ...applyDesignMutations(document, mutations),
          revision: document.revision + 1,
        }
        return document
      },
    }
    const manager = new DesignJobManager({
      pathResolver: { resolve: () => ({ jobsDir: join(cacheRoot, 'jobs') }) },
      store,
      assetService: {
        resolveAssetPath: () => '/trusted/source.png',
        importAuthorizedFiles: async (_projectId, _paths, source) => {
          importSources.push(source)
          const batch = [createAsset('asset-output', source)] as DesignAssetImportBatch
          batch.commit = () => undefined
          batch.rollback = () => undefined
          return batch
        },
      },
      getSettings: () => state.settings,
      getSession: (sessionId) => createdSessions.find((session) => session.id === sessionId),
      createSession: (title, channelId, projectId, modelId) => {
        const session: AgentSessionMeta = {
          id: `session-${createdSessions.length + 1}`,
          title,
          channelId,
          modelId,
          workspaceId: projectId,
          createdAt: 1,
          updatedAt: 1,
        }
        createdSessions.push(session)
        return session
      },
      updateSession: (sessionId, updates) => {
        sessionUpdates.push({ sessionId, updates })
      },
      runHeadless: async (input, callbacks, extensions) => {
        runInputs.push({
          ...input,
          source: callbacks.source,
          allowedToolNames: extensions.allowedToolNames,
        })
        if (state.runHeadless) return state.runHeadless(callbacks)
        callbacks.onComplete(state.messages)
      },
      stopAgent: async (sessionId) => { stoppedSessions.push(sessionId) },
      resolveOwnedOutputPath: (sessionId, localPath) => (
        localPath.startsWith(`${sessionId}/`) ? `/trusted/${localPath}` : undefined
      ),
      listProjectIds: () => ['project-1'],
      createId: () => `job-${++identity}`,
      now: () => 10 + identity,
    })
    return {
      manager,
      createdSessions,
      sessionUpdates,
      stoppedSessions,
      importSources,
      runInputs,
      get settings() { return state.settings },
      set settings(value: typeof state.settings) { state.settings = value },
      get messages() { return state.messages },
      set messages(value: AgentMessage[]) { state.messages = value },
      set runHeadless(value: typeof state.runHeadless) { state.runHeadless = value },
    }
  }
})

/** 创建生成任务输入。 */
function createGenerateInput(): CreateDesignJobInput {
  return { projectId: 'project-1', action: 'generate', prompt: '生成海报', position: { x: 10, y: 20 } }
}

/** 创建带主进程解析蒙版的编辑任务输入。 */
function createEditInput(): CreateDesignJobInput {
  return {
    projectId: 'project-1', action: 'edit', prompt: '移除文字', sourceAssetId: 'asset-source',
    maskAnnotationId: 'mask-1', position: { x: 10, y: 20 },
  }
}

/** 创建测试素材，并保留任务来源关系。 */
function createAsset(id: string, source: DesignAssetImportSource = { kind: 'picker' }): DesignAsset {
  return {
    id,
    filename: `${id}.png`,
    relativePath: `assets/${id}.png`,
    thumbnailRelativePath: `thumbnails/${id}.webp`,
    mediaType: 'image/png',
    width: 10,
    height: 10,
    byteSize: 100,
    sha256: id,
    createdAt: 1,
    ...(source.sourceSessionId ? { sourceSessionId: source.sourceSessionId } : {}),
    ...(source.sourceJobId ? { sourceJobId: source.sourceJobId } : {}),
    ...(source.parentAssetId ? { parentAssetId: source.parentAssetId } : {}),
    ...(source.prompt ? { prompt: source.prompt } : {}),
  }
}

/** 创建本轮 Nano Banana 成功工具消息。 */
function createToolMessage(localPath: string): AgentMessage {
  return {
    id: 'tool-message',
    role: 'tool',
    content: '完成',
    createdAt: 1,
    events: [{
      type: 'tool_result',
      toolUseId: 'tool-1',
      toolName: NANO_BANANA_TOOL,
      result: 'ok',
      isError: false,
      imageAttachments: [{ localPath, filename: 'output.png', mediaType: 'image/png' }],
    }],
  }
}
