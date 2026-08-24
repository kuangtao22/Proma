import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IMAGE_GENERATION_MODEL_ID_MAX_LENGTH,
  IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH,
  createEmptyDesignDocument,
} from '@proma/shared'
import type {
  AgentMessage,
  AgentSessionMeta,
  CreateDesignJobInput,
  DesignAsset,
  DesignCanvasDocument,
  DesignJobRecord,
  ImageGenerationModelSnapshot,
} from '@proma/shared'
import type { DesignAssetImportBatch, DesignAssetImportSource } from './design-asset-service'
import { DesignJobManager } from './design-job-manager'
import { applyDesignMutations } from './design-store'
import type { DesignStore } from './design-store'
import { createWorkspaceOperationRegistry } from '../workspace-operation-lock'
import type { AgentRunExtensions } from '../agent-run-extensions'
import type { ResolvedImageGenerationRoute } from '../image-generation-runtime'

const NANO_BANANA_TOOL = 'mcp__nano_banana__generate_image'

/** 创建旧 Nano Banana 任务使用的公开模型快照。 */
function createNanoSnapshot(): ImageGenerationModelSnapshot {
  return {
    profileId: 'profile-nano',
    name: 'Nano Banana',
    executor: 'nano-banana',
    modelId: 'gemini-image',
  }
}

/** 创建 GPT Image 2 任务使用的公开渠道模型快照。 */
function createOpenAISnapshot(): ImageGenerationModelSnapshot {
  return {
    profileId: 'profile-gpt',
    name: 'GPT Image 2',
    executor: 'openai-images',
    channelId: 'channel-gpt',
    modelId: 'gpt-image-2',
  }
}

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
    expect(harness.createdSessions[0]).toMatchObject({
      sourceDesignProjectId: 'project-1',
      sourceDesignJobId: job.id,
    })
    expect(harness.runInputs[0]).toMatchObject({
      source: 'design',
      triggeredBy: 'user',
      permissionModeOverride: 'bypassPermissions',
      allowedToolNames: [NANO_BANANA_TOOL],
      toolCallLimits: { [NANO_BANANA_TOOL]: 1 },
      trustedImageRoute: {
        profileId: 'profile-test',
        name: '测试生图模型',
        executor: 'nano-banana',
        modelId: 'image-model-test',
      },
      hasTrustedImageRouteResolver: true,
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
    expect(harness.changedEvents.at(-1)).toMatchObject({
      job: { id: job.id, status: 'succeeded' },
      revision: document.revision,
    })
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

  test.each([
    ['createSession', '会话创建失败'],
    ['importAuthorizedFiles', '素材导入失败'],
  ] as const)('Given %s 抛出异常 When 运行任务 Then 收敛为 failed journal', async (stage, message) => {
    harness.messages = [createToolMessage('session-1/output.png')]
    if (stage === 'createSession') harness.createSessionError = new Error(message)
    if (stage === 'importAuthorizedFiles') harness.importError = new Error(message)
    const job = harness.manager.create(createGenerateInput())

    await expect(harness.manager.run(job.id)).resolves.toBeUndefined()

    expect(harness.manager.get(job.id)).toMatchObject({ status: 'failed', error: message })
    expect(document.nodes[0]).toMatchObject({ kind: 'job', jobId: job.id })
  })

  test('Given Store 在写入占位节点前失败 When 创建任务 Then 删除 pending journal 且不遗留 queued', () => {
    harness.mutateError = new Error('Store mutation failed')

    expect(() => harness.manager.create(createGenerateInput())).toThrow('Store mutation failed')

    expect(harness.manager.list('project-1')).toEqual([])
    expect(existsSync(join(cacheRoot, 'jobs', 'job-1.json'))).toBe(false)
    expect(document.nodes).toEqual([])
  })

  test('Given Store 已写入占位节点但 durability 报错 When 创建任务 Then 确认权威节点后保留可恢复 journal', () => {
    harness.mutateAfterApplyError = new Error('directory fsync failed')

    const job = harness.manager.create(createGenerateInput())

    expect(job.status).toBe('queued')
    expect(harness.manager.get(job.id)?.status).toBe('queued')
    expect(document.nodes[0]).toMatchObject({ kind: 'job', jobId: job.id })
  })

  test('Given ID 生成器返回路径片段 When 创建任务 Then 在 journal 或 Store 副作用前拒绝', () => {
    harness.createId = () => '../escape'

    expect(() => harness.manager.create(createGenerateInput())).toThrow('设计任务 ID 非法')

    expect(existsSync(join(cacheRoot, 'escape.json'))).toBe(false)
    expect(existsSync(join(cacheRoot, 'jobs'))).toBe(false)
    expect(document.nodes).toEqual([])
  })

  test('Given Manager 直接收到伪造模型 ID When 创建任务 Then 在 Store、journal 和 Agent 副作用前拒绝', () => {
    harness.resolveAvailableSnapshot = () => { throw new Error('生图模型不存在: forged') }
    /** 绕过 IPC 直接调用 Manager，验证可信校验属于 Manager 自身。 */
    const input = { ...createGenerateInput(), imageModelProfileId: 'forged' }

    expect(() => harness.manager.create(input)).toThrow('生图模型不存在: forged')

    expect(document.revision).toBe(0)
    expect(document.nodes).toEqual([])
    expect(existsSync(join(cacheRoot, 'jobs'))).toBe(false)
    expect(harness.createdSessions).toEqual([])
    expect(harness.runInputs).toEqual([])
  })

  test('Given 创建任务解析模型时发生含绝对路径的底层错误 When 调用 Manager Then 只返回稳定中文且无副作用', () => {
    /** 模拟底层文件系统把用户目录写入错误消息。 */
    const rawError = new Error(
      'EACCES: permission denied, open /Users/private-user/.proma/image-generation-models.json',
    )
    harness.resolveAvailableSnapshot = () => { throw rawError }

    expect(() => harness.manager.create(createGenerateInput()))
      .toThrow('校验生图模型配置失败，请刷新后重试')

    expect(document.revision).toBe(0)
    expect(document.nodes).toEqual([])
    expect(existsSync(join(cacheRoot, 'jobs'))).toBe(false)
    expect(harness.createdSessions).toEqual([])
    expect(harness.runInputs).toEqual([])
    expect(harness.warnings[0]).toContain(rawError.message)
  })

  test('Given Manager 解析到可用模型 When 创建任务 Then 返回并持久化公开模型快照', () => {
    const job = harness.manager.create(createGenerateInput())

    expect(job.imageModelSnapshot).toEqual({
      profileId: 'profile-test',
      name: '测试生图模型',
      executor: 'nano-banana',
      modelId: 'image-model-test',
    })
    /** journal 只持久化公开 snapshot，不包含模型目录或凭据。 */
    const persisted = JSON.parse(readFileSync(join(cacheRoot, 'jobs', `${job.id}.json`), 'utf8'))
    expect(persisted.imageModelSnapshot).toEqual(job.imageModelSnapshot)
    expect(JSON.stringify(persisted)).not.toContain('apiKey')
  })

  test('Given 项目选择 GPT Image 2 When 创建任务 Then journal 固化渠道快照且运行时解析一次', async () => {
    harness.resolveAvailableSnapshot = () => createOpenAISnapshot()
    /** 记录工具执行时拿到的主进程运行路由。 */
    let resolved: ResolvedImageGenerationRoute | undefined
    harness.resolveExecutionRoute = (snapshot) => ({
      executor: 'openai-images',
      snapshot: snapshot as Extract<ImageGenerationModelSnapshot, { executor: 'openai-images' }>,
      baseUrl: 'http://100.124.186.117:8030/v1',
      apiKey: 'secret-key',
    })
    harness.runHeadless = async (callbacks, extensions) => {
      resolved = extensions.resolveTrustedImageRoute?.(extensions.trustedImageRoute!)
      callbacks.onComplete([])
    }

    const job = harness.manager.create({
      ...createGenerateInput(),
      imageModelProfileId: 'profile-gpt',
    })
    await harness.manager.run(job.id)

    expect(job.imageModelSnapshot).toEqual(expect.objectContaining({
      executor: 'openai-images',
      channelId: 'channel-gpt',
      modelId: 'gpt-image-2',
    }))
    expect(resolved).toEqual(expect.objectContaining({
      executor: 'openai-images',
      apiKey: 'secret-key',
    }))
  })

  test('Given GPT Image 2 失败任务 When 重试 Then replacement 复制原渠道快照', async () => {
    harness.resolveAvailableSnapshot = () => createOpenAISnapshot()
    harness.messages = []
    const failed = harness.manager.create({
      ...createGenerateInput(),
      imageModelProfileId: 'profile-gpt',
    })
    await harness.manager.run(failed.id)
    harness.resolveAvailableSnapshot = () => {
      throw new Error('重试不应重新读取当前模型目录')
    }

    const replacement = harness.manager.retry('project-1', failed.id)

    expect(replacement.imageModelSnapshot).toEqual(createOpenAISnapshot())
  })

  test('Given openai-images journal 缺少 channelId When 恢复 Then 拒绝损坏记录', () => {
    const jobsDirectory = join(cacheRoot, 'jobs')
    mkdirSync(jobsDirectory, { recursive: true })
    writeFileSync(join(jobsDirectory, 'job-gpt.json'), JSON.stringify({
      id: 'job-gpt',
      projectId: 'project-1',
      action: 'generate',
      status: 'interrupted',
      prompt: '损坏任务',
      nodeId: 'node-gpt',
      position: { x: 0, y: 0 },
      createdAt: 1,
      updatedAt: 1,
      imageModelSnapshot: {
        profileId: 'profile-gpt',
        name: 'GPT Image 2',
        executor: 'openai-images',
        modelId: 'gpt-image-2',
      },
    }))

    expect(harness.manager.list('project-1')).toEqual([])
  })

  test('Given queued 任务的模型配置已失效 When 执行任务 Then 明确失败且不创建 Agent 会话', async () => {
    const job = harness.manager.create(createGenerateInput())
    harness.assertSnapshotAvailable = () => { throw new Error('生图模型已停用: profile-test') }

    await harness.manager.run(job.id)

    expect(harness.manager.get(job.id)).toMatchObject({
      status: 'failed',
      error: '生图模型已停用: profile-test',
      imageModelSnapshot: job.imageModelSnapshot,
    })
    expect(harness.createdSessions).toEqual([])
    expect(harness.runInputs).toEqual([])
  })

  test('Given Agent 启动后模型被停用 When 图片工具实时复核 Then journal 保留真实业务原因', async () => {
    harness.resolveExecutionRoute = () => { throw new Error('生图模型已停用: profile-test') }
    harness.runHeadless = async (callbacks, extensions) => {
      try { extensions.resolveTrustedImageRoute?.(extensions.trustedImageRoute!) } catch { /* 模拟 Pi 工具错误结果 */ }
      callbacks.onComplete([])
    }
    const job = harness.manager.create(createGenerateInput())

    await harness.manager.run(job.id)

    expect(harness.manager.get(job.id)).toMatchObject({ status: 'failed', error: '生图模型已停用: profile-test' })
  })

  test('Given Agent 启动后凭据被删除 When 图片工具实时复核 Then journal 明确提示 Key 未配置', async () => {
    harness.resolveExecutionRoute = () => { throw new Error('Nano Banana API Key 未配置: nano-banana') }
    harness.runHeadless = async (callbacks, extensions) => {
      try { extensions.resolveTrustedImageRoute?.(extensions.trustedImageRoute!) } catch { /* 模拟 Pi 工具错误结果 */ }
      callbacks.onComplete([])
    }
    const job = harness.manager.create(createGenerateInput())

    await harness.manager.run(job.id)

    expect(harness.manager.get(job.id)).toMatchObject({ status: 'failed', error: 'Nano Banana API Key 未配置: nano-banana' })
  })

  test('Given 工具实时复核发生含绝对路径的底层错误 When Agent 完成 Then journal 只保留稳定中文', async () => {
    harness.resolveExecutionRoute = () => { throw new Error('EACCES /Users/secret/image-generation-models.json') }
    harness.runHeadless = async (callbacks, extensions) => {
      try { extensions.resolveTrustedImageRoute?.(extensions.trustedImageRoute!) } catch { /* 模拟 Pi 工具错误结果 */ }
      callbacks.onComplete([])
    }
    const job = harness.manager.create(createGenerateInput())

    await harness.manager.run(job.id)

    expect(harness.manager.get(job.id)).toMatchObject({ status: 'failed', error: '校验生图模型配置失败，请刷新后重试' })
    expect(harness.warnings.join('\n')).toContain('/Users/secret/image-generation-models.json')
    expect(JSON.stringify(harness.manager.get(job.id))).not.toContain('/Users/secret')
  })

  test('Given 执行前复核模型时发生含绝对路径的底层错误 When 运行 Then journal 与广播只保留稳定中文', async () => {
    const job = harness.manager.create(createGenerateInput())
    /** 模拟排队期间目录文件消失并暴露用户目录。 */
    const rawError = new Error(
      'ENOENT: no such file or directory, open /Users/private-user/.proma/image-generation-models.json',
    )
    harness.assertSnapshotAvailable = () => { throw rawError }

    await harness.manager.run(job.id)

    /** 任务公开终态不得包含底层文件系统诊断。 */
    const failed = harness.manager.get(job.id)
    if (!failed) throw new Error('测试预期任务仍可读取')
    expect(failed).toMatchObject({
      status: 'failed',
      error: '校验生图模型配置失败，请刷新后重试',
    })
    expect(harness.manager.list('project-1')).toContainEqual(failed)
    expect(harness.changedEvents.at(-1)?.job.error).toBe('校验生图模型配置失败，请刷新后重试')
    /** 模拟 Renderer 可从列表与广播观察到的完整公开数据。 */
    const publicResult = JSON.stringify({ failed, events: harness.changedEvents })
    expect(publicResult).not.toContain('/Users')
    expect(publicResult).not.toContain('private-user')
    expect(publicResult).not.toContain('.proma')
    expect(harness.createdSessions).toEqual([])
    expect(harness.runInputs).toEqual([])
    expect(harness.warnings[0]).toContain(rawError.message)
  })

  test('Given 旧 queued journal 没有模型快照 When 执行任务 Then 明确失败且不创建 Agent 会话', async () => {
    const jobsDirectory = join(cacheRoot, 'jobs')
    mkdirSync(jobsDirectory, { recursive: true })
    document.nodes = [{
      id: 'node-legacy', kind: 'job', jobId: 'job-legacy', position: { x: 0, y: 0 },
      width: 320, height: 240, zIndex: 0,
    }]
    writeFileSync(join(jobsDirectory, 'job-legacy.json'), JSON.stringify({
      id: 'job-legacy', projectId: 'project-1', action: 'generate', status: 'queued',
      prompt: '旧任务', nodeId: 'node-legacy', position: { x: 0, y: 0 },
      placementState: 'ready', createdAt: 1, updatedAt: 1,
    }))

    await harness.manager.run('job-legacy')

    expect(harness.manager.get('job-legacy')).toMatchObject({
      status: 'failed',
      error: '旧任务未记录生图模型，请重新提交新任务',
    })
    expect(harness.createdSessions).toEqual([])
    expect(harness.runInputs).toEqual([])
  })

  test('Given journal 含越界 ID、错名 payload 和损坏 schema When 恢复 Then 全部忽略且无文件或 Store 副作用', () => {
    const jobsDirectory = join(cacheRoot, 'jobs')
    mkdirSync(jobsDirectory, { recursive: true })
    /** 越界删除目标哨兵，恶意 pending journal 不得触碰。 */
    const sentinelPath = join(cacheRoot, 'victim.json')
    writeFileSync(sentinelPath, 'sentinel', 'utf8')
    writeFileSync(join(jobsDirectory, 'evil.json'), JSON.stringify({
      id: '../victim', projectId: 'project-1', action: 'generate', status: 'queued',
      prompt: '恶意任务', nodeId: 'node-evil', position: { x: 0, y: 0 },
      placementState: 'pending', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(jobsDirectory, 'wrong-name.json'), JSON.stringify({
      id: 'job-other', projectId: 'project-1', action: 'generate', status: 'running',
      prompt: '错名任务', nodeId: 'node-other', position: { x: 0, y: 0 },
      sessionId: 'session-other', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(jobsDirectory, 'broken.json'), JSON.stringify({
      id: 'broken', projectId: 'project-1', action: 'generate', status: 'running',
      prompt: '损坏任务', nodeId: 'node-broken', position: 'not-a-point',
      sessionId: 'session-broken', createdAt: 1, updatedAt: 1, unexpected: true,
    }))

    const recovered = harness.manager.recover('project-1')

    expect(recovered).toEqual([])
    expect(readFileSync(sentinelPath, 'utf8')).toBe('sentinel')
    expect(existsSync(join(jobsDirectory, 'job-other.json'))).toBe(false)
    expect(document.revision).toBe(0)
    expect(document.nodes).toEqual([])
  })

  test('Given 项目 A 路径解析失败且项目 B 有 running 任务 When recoverAll Then 记录 A 错误并继续中断 B', () => {
    const projectBJobs = join(cacheRoot, 'project-b-jobs')
    mkdirSync(projectBJobs, { recursive: true })
    writeFileSync(join(projectBJobs, 'job-b.json'), JSON.stringify(createStoredRunningJob('project-b', 'job-b')))
    const warnings: string[] = []
    const manager = createMultiProjectRecoveryManager(projectBJobs, warnings)

    const recovered = manager.recoverAll()

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ id: 'job-b', projectId: 'project-b', status: 'interrupted' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('project-a')
    expect(warnings[0]).toContain('路径解析失败')
  })

  test('Given 项目 A journal 读取失败且项目 B 有 running 任务 When 退出中断 Then 记录 A 错误并继续中断 B', () => {
    const projectBJobs = join(cacheRoot, 'project-b-jobs')
    mkdirSync(projectBJobs, { recursive: true })
    writeFileSync(join(projectBJobs, 'job-b.json'), JSON.stringify(createStoredRunningJob('project-b', 'job-b')))
    const warnings: string[] = []
    const manager = createMultiProjectRecoveryManager(projectBJobs, warnings)

    manager.markRunningInterrupted()

    expect(manager.list('project-b')).toEqual([
      expect.objectContaining({ id: 'job-b', projectId: 'project-b', status: 'interrupted' }),
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('project-a')
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

  test('Given output 正在提交 When 迁移尝试插入 Then import、复核、Store 与 batch 全程持有 workspace write lease', async () => {
    harness.messages = [createToolMessage('session-1/output.png')]
    harness.attemptRelocationDuringImport = true
    const job = harness.manager.create(createGenerateInput())

    await harness.manager.run(job.id)

    expect(harness.relocationAttemptError).toContain('Design 写入正在进行')
    expect(harness.unguardedOutputEffects).toEqual([])
    expect(harness.outputEffects).toEqual(['import', 'authoritative-read', 'store-mutate', 'commit'])
  })

  test('Given Store 终态已应用但 durability 与权威重读连续失败 When 任务完成 Then 保留 pending 证据且恢复后对账 succeeded', async () => {
    harness.messages = [createToolMessage('session-1/output.png')]
    harness.outputMutateAfterApplyError = new Error('canvas directory fsync failed')
    harness.outputReloadError = new Error('canvas reload failed')
    const job = harness.manager.create(createGenerateInput())

    await harness.manager.run(job.id)

    expect(harness.manager.get(job.id)).toMatchObject({
      status: 'running',
      terminalState: { status: 'pending', outputAssetId: 'asset-output' },
    })
    expect(harness.batchCommits).toBe(0)
    expect(harness.batchRollbacks).toBe(0)
    expect(JSON.parse(readFileSync(join(cacheRoot, 'jobs', `${job.id}.json`), 'utf8'))).toMatchObject({
      status: 'running',
      terminalState: { status: 'pending', outputAssetId: 'asset-output' },
    })

    harness.outputReloadError = undefined
    const recovered = harness.manager.recover('project-1')

    expect(recovered.find((candidate) => candidate.id === job.id)).toMatchObject({
      status: 'succeeded',
      outputAssetId: 'asset-output',
    })
  })

  test('Given pending terminal journal 在 Store 中没有对应素材和节点 When 恢复 Then 对账为 failed 而非 interrupted', () => {
    const jobsDirectory = join(cacheRoot, 'jobs')
    mkdirSync(jobsDirectory, { recursive: true })
    document.nodes = [{
      id: 'node-pending', kind: 'job', jobId: 'job-pending', position: { x: 0, y: 0 },
      width: 320, height: 240, zIndex: 0,
    }]
    writeFileSync(join(jobsDirectory, 'job-pending.json'), JSON.stringify({
      id: 'job-pending', projectId: 'project-1', action: 'generate', status: 'running',
      prompt: '待对账任务', nodeId: 'node-pending', position: { x: 0, y: 0 },
      placementState: 'ready', terminalState: { status: 'pending', outputAssetId: 'asset-missing' },
      sessionId: 'session-pending', createdAt: 1, updatedAt: 1,
    }))

    const recovered = harness.manager.recover('project-1')

    expect(recovered[0]).toMatchObject({ status: 'failed', error: '设计任务终态提交未完成' })
  })

  test('Given pending terminal 首次对账要求恢复 When 同进程权威加载完成 Then 可二次对账为 succeeded', () => {
    const jobsDirectory = join(cacheRoot, 'jobs')
    mkdirSync(jobsDirectory, { recursive: true })
    document.assets.push(createAsset('asset-pending', {
      kind: 'job', sourceJobId: 'job-pending', sourceSessionId: 'session-pending', prompt: '恢复任务',
    }))
    document.nodes = [{
      id: 'node-pending', kind: 'asset', assetId: 'asset-pending', position: { x: 0, y: 0 },
      width: 320, height: 240, zIndex: 0,
    }]
    writeFileSync(join(jobsDirectory, 'job-pending.json'), JSON.stringify({
      id: 'job-pending', projectId: 'project-1', action: 'generate', status: 'running',
      prompt: '恢复任务', nodeId: 'node-pending', position: { x: 0, y: 0 },
      placementState: 'ready', terminalState: { status: 'pending', outputAssetId: 'asset-pending' },
      sessionId: 'session-pending', createdAt: 1, updatedAt: 1,
    }))
    harness.outputReloadError = new Error('DESIGN_RECOVERY_REQUIRED: backup 已恢复')
    harness.forceOutputReloadError = true

    expect(harness.manager.recover('project-1')[0]).toMatchObject({
      status: 'running', terminalState: { status: 'pending' },
    })

    harness.forceOutputReloadError = false
    expect(harness.manager.reconcilePendingTerminals('project-1')[0]).toMatchObject({
      status: 'succeeded', outputAssetId: 'asset-pending',
    })
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
    expect(harness.changedEvents.some((event) => (
      event.job.id === retried.id && event.job.status === 'queued' && event.revision === 2
    ))).toBe(true)
  })

  test('Given 失败任务固化模型 B When 当前目录改为模型 A 后重试 Then replacement 继续复制模型 B', async () => {
    harness.resolveAvailableSnapshot = (profileId) => ({
      profileId, name: '高质量模型', executor: 'nano-banana', modelId: 'gemini-pro-image',
    })
    harness.messages = []
    const original = harness.manager.create({ ...createGenerateInput(), imageModelProfileId: 'profile-b' })
    await harness.manager.run(original.id)
    harness.resolveAvailableSnapshot = () => {
      throw new Error('重试不应重新读取当前模型目录')
    }

    const replacement = harness.manager.retry('project-1', original.id)

    expect(replacement.imageModelSnapshot).toEqual(original.imageModelSnapshot)
    expect(replacement.imageModelSnapshot?.profileId).toBe('profile-b')
  })

  test('Given replacement 已复制原模型但配置随后失效 When 执行 Then replacement 失败且不创建新会话', async () => {
    harness.messages = []
    const original = harness.manager.create(createGenerateInput())
    await harness.manager.run(original.id)
    const replacement = harness.manager.retry('project-1', original.id)
    const originalSnapshot = original.imageModelSnapshot
    if (!originalSnapshot) throw new Error('新任务必须固化生图模型快照')
    harness.assertSnapshotAvailable = (snapshot) => {
      expect(snapshot).toEqual(originalSnapshot)
      throw new Error('生图模型快照与当前配置不一致: profile-test')
    }

    await harness.manager.run(replacement.id)

    expect(harness.manager.get(replacement.id)).toMatchObject({
      status: 'failed',
      error: '生图模型快照与当前配置不一致: profile-test',
      imageModelSnapshot: originalSnapshot,
    })
    expect(harness.createdSessions).toHaveLength(1)
    expect(harness.runInputs).toHaveLength(1)
  })

  test('Given 旧 failed journal 没有模型快照 When 请求重试 Then 不创建 replacement 或其它副作用', () => {
    const jobsDirectory = join(cacheRoot, 'jobs')
    mkdirSync(jobsDirectory, { recursive: true })
    document.nodes = [{
      id: 'node-legacy', kind: 'job', jobId: 'job-legacy', position: { x: 0, y: 0 },
      width: 320, height: 240, zIndex: 0,
    }]
    writeFileSync(join(jobsDirectory, 'job-legacy.json'), JSON.stringify({
      id: 'job-legacy', projectId: 'project-1', action: 'generate', status: 'failed',
      prompt: '旧任务', nodeId: 'node-legacy', position: { x: 0, y: 0 },
      placementState: 'ready', error: '旧失败', createdAt: 1, updatedAt: 2,
    }))

    expect(() => harness.manager.retry('project-1', 'job-legacy'))
      .toThrow('旧任务未记录生图模型，请重新提交')

    expect(harness.manager.list('project-1')).toHaveLength(1)
    expect(readdirSync(jobsDirectory)).toEqual(['job-legacy.json'])
    expect(JSON.parse(readFileSync(join(jobsDirectory, 'job-legacy.json'), 'utf8'))).not.toHaveProperty('retryState')
    expect(document.revision).toBe(0)
    expect(document.nodes[0]).toMatchObject({ kind: 'job', jobId: 'job-legacy' })
    expect(harness.createdSessions).toEqual([])
    expect(harness.runInputs).toEqual([])
  })

  test('Given 旧 journal 留下 retry intent 但没有模型快照 When 自动恢复 Then 不补建 replacement', () => {
    const jobsDirectory = join(cacheRoot, 'jobs')
    mkdirSync(jobsDirectory, { recursive: true })
    document.nodes = [{
      id: 'node-legacy', kind: 'job', jobId: 'job-legacy', position: { x: 0, y: 0 },
      width: 320, height: 240, zIndex: 0,
    }]
    writeFileSync(join(jobsDirectory, 'job-legacy.json'), JSON.stringify({
      id: 'job-legacy', projectId: 'project-1', action: 'generate', status: 'failed',
      prompt: '旧任务', nodeId: 'node-legacy', position: { x: 0, y: 0 },
      placementState: 'ready', replacedByJobId: 'job-replacement',
      retryState: { status: 'pending' }, error: '旧失败', createdAt: 1, updatedAt: 2,
    }))

    const recovered = harness.manager.recover('project-1')

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ id: 'job-legacy', status: 'failed' })
    expect(readdirSync(jobsDirectory)).toEqual(['job-legacy.json'])
    expect(document.revision).toBe(0)
    expect(document.nodes[0]).toMatchObject({ kind: 'job', jobId: 'job-legacy' })
    expect(harness.createdSessions).toEqual([])
    expect(harness.warnings[0]).toContain('旧任务未记录生图模型，请重新提交')
  })

  test.each([
    ['名称', { name: '名'.repeat(IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH + 1) }],
    ['模型 ID', { modelId: 'm'.repeat(IMAGE_GENERATION_MODEL_ID_MAX_LENGTH + 1) }],
  ])('Given journal 模型快照%s超限 When 恢复项目 Then 忽略损坏任务且不产生 Store 或文件副作用', (_field, snapshotOverrides) => {
    /** 损坏 journal 所在目录。 */
    const jobsDirectory = join(cacheRoot, 'jobs')
    mkdirSync(jobsDirectory, { recursive: true })
    /** 超限快照 journal 的原始字节，恢复后必须保持完全不变。 */
    const rawJournal = JSON.stringify({
      id: 'job-oversized', projectId: 'project-1', action: 'generate', status: 'running',
      prompt: '损坏任务', nodeId: 'node-oversized', position: { x: 0, y: 0 },
      placementState: 'ready', createdAt: 1, updatedAt: 1,
      imageModelSnapshot: {
        profileId: 'profile-test',
        name: '测试生图模型',
        executor: 'nano-banana',
        modelId: 'image-model-test',
        ...snapshotOverrides,
      },
    })
    /** 严格解析失败后仍应保留供诊断的原始 journal。 */
    const journalPath = join(jobsDirectory, 'job-oversized.json')
    writeFileSync(journalPath, rawJournal)

    /** 恢复结果不得包含被严格 parser 拒绝的任务。 */
    const recovered = harness.manager.recover('project-1')

    expect(recovered).toEqual([])
    expect(readFileSync(journalPath, 'utf8')).toBe(rawJournal)
    expect(document.revision).toBe(0)
    expect(document.nodes).toEqual([])
    expect(harness.changedEvents).toEqual([])
    expect(harness.createdSessions).toEqual([])
    expect(harness.runInputs).toEqual([])
  })

  test('Given 同一失败任务被重复重试 When 请求到达 Then 幂等返回唯一 replacement 且只运行一个会话', async () => {
    harness.messages = []
    const original = harness.manager.create(createGenerateInput())
    await harness.manager.run(original.id)

    const first = harness.manager.retry('project-1', original.id)
    const second = harness.manager.retry('project-1', original.id)
    await Promise.all([harness.manager.run(first.id), harness.manager.run(second.id)])

    expect(second.id).toBe(first.id)
    expect(harness.manager.list('project-1')).toHaveLength(2)
    expect(harness.createdSessions).toHaveLength(2)
    expect(JSON.parse(readFileSync(join(cacheRoot, 'jobs', `${original.id}.json`), 'utf8'))).toMatchObject({
      replacedByJobId: first.id,
    })
  })

  test('Given retry intent 已落盘但 durability 报错 When 重试 Then 复核 intent 并只启动唯一 replacement', async () => {
    harness.messages = []
    const original = harness.manager.create(createGenerateInput())
    await harness.manager.run(original.id)
    harness.throwAfterRetryIntentWrite = true

    const replacement = harness.manager.retry('project-1', original.id)
    const duplicate = harness.manager.retry('project-1', original.id)
    await Promise.all([harness.manager.run(replacement.id), harness.manager.run(duplicate.id)])

    expect(duplicate.id).toBe(replacement.id)
    expect(harness.createdSessions).toHaveLength(2)
    expect(harness.manager.list('project-1')).toHaveLength(2)
    expect(harness.retryIntentWrites).toBe(1)
  })

  test('Given replacement 已创建但旧 journal 最终写失败 When 重试 Then 返回同一任务且仍只启动一次', async () => {
    harness.messages = []
    const original = harness.manager.create(createGenerateInput())
    await harness.manager.run(original.id)
    harness.throwOnRetryFinalizeWrite = true

    const replacement = harness.manager.retry('project-1', original.id)
    const duplicate = harness.manager.retry('project-1', original.id)
    await Promise.all([harness.manager.run(replacement.id), harness.manager.run(duplicate.id)])

    expect(duplicate.id).toBe(replacement.id)
    expect(harness.createdSessions).toHaveLength(2)
    expect(JSON.parse(readFileSync(join(cacheRoot, 'jobs', `${original.id}.json`), 'utf8'))).toMatchObject({
      replacedByJobId: replacement.id,
      retryState: { status: 'pending' },
    })
  })

  test('Given replacement pending journal 已写但 Store 尚未接管时崩溃 When 恢复 Then 续建同一 replacement', async () => {
    harness.messages = []
    const original = harness.manager.create(createGenerateInput())
    await harness.manager.run(original.id)
    harness.throwAfterReplacementJournalWrite = true

    expect(() => harness.manager.retry('project-1', original.id)).toThrow('replacement journal committed before crash')
    expect(document.nodes[0]).toMatchObject({ kind: 'job', jobId: original.id })

    harness.throwAfterReplacementJournalWrite = false
    const replacement = harness.manager.retry('project-1', original.id)

    expect(replacement).toMatchObject({ id: 'job-2', status: 'queued' })
    expect(document.nodes[0]).toMatchObject({ kind: 'job', jobId: 'job-2' })
    expect(harness.manager.retry('project-1', original.id).id).toBe('job-2')
  })

  test('Given 重启时只有旧 retry intent When 新 Manager 恢复 Then 新 replacement 立即 interrupted 且可由用户重试', () => {
    const jobsDirectory = join(cacheRoot, 'jobs')
    mkdirSync(jobsDirectory, { recursive: true })
    document.nodes = [{
      id: 'node-old', kind: 'job', jobId: 'job-old', position: { x: 0, y: 0 },
      width: 320, height: 240, zIndex: 0,
    }]
    writeFileSync(join(jobsDirectory, 'job-old.json'), JSON.stringify({
      id: 'job-old', projectId: 'project-1', sessionId: 'session-old',
      action: 'generate', status: 'failed', prompt: '崩溃前重试', nodeId: 'node-old',
      position: { x: 0, y: 0 }, placementState: 'ready', replacedByJobId: 'job-2',
      retryState: { status: 'pending' }, error: '旧任务失败', createdAt: 1, updatedAt: 2,
      imageModelSnapshot: {
        profileId: 'profile-test', name: '测试生图模型',
        executor: 'nano-banana', modelId: 'image-model-test',
      },
    }))
    /** 丢弃旧进程内存索引，使用同一磁盘与 Store 创建真正的新 Manager。 */
    harness = createHarness()

    const recovered = harness.manager.recover('project-1')
    const replacement = recovered.find((job) => job.id === 'job-2')

    expect(replacement).toMatchObject({
      status: 'interrupted',
      error: '应用退出，排队任务已中断',
    })
    expect(document.nodes[0]).toMatchObject({ kind: 'job', jobId: 'job-2' })
    expect(harness.createdSessions).toEqual([])

    harness.createId = () => 'job-3'
    expect(harness.manager.retry('project-1', 'job-2')).toMatchObject({
      id: 'job-3', status: 'queued',
    })
    expect(document.nodes[0]).toMatchObject({ kind: 'job', jobId: 'job-3' })
  })

  test('Given Store 节点已不再绑定旧任务 When 重试 Then 拒绝创建新 journal 或会话', async () => {
    harness.messages = []
    const original = harness.manager.create(createGenerateInput())
    await harness.manager.run(original.id)
    document.nodes = document.nodes.map((node) => (
      node.id === `design-job-${original.id}` && node.kind === 'job'
        ? { ...node, jobId: 'job-other' }
        : node
    ))

    expect(() => harness.manager.retry('project-1', original.id)).toThrow('设计任务节点已被其他任务接管')

    expect(harness.manager.list('project-1')).toHaveLength(1)
    expect(harness.createdSessions).toHaveLength(1)
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

  test('Given 上次进程留下无模型快照的 running job When 恢复 Then 标记 interrupted 但禁止重试', () => {
    const jobsDirectory = join(cacheRoot, 'jobs')
    mkdirSync(jobsDirectory, { recursive: true })
    document.nodes = [{
      id: 'node-old', kind: 'job', jobId: 'job-running', position: { x: 0, y: 0 },
      width: 320, height: 240, zIndex: 0,
    }]
    writeFileSync(join(jobsDirectory, 'job-running.json'), JSON.stringify({
      id: 'job-running', projectId: 'project-1', sessionId: 'session-old',
      action: 'generate', status: 'running', prompt: '旧任务', nodeId: 'node-old',
      position: { x: 0, y: 0 }, createdAt: 1, updatedAt: 1,
    }))

    const recovered = harness.manager.recover('project-1')

    expect(recovered[0]?.status).toBe('interrupted')
    expect(() => harness.manager.retry('project-1', 'job-running'))
      .toThrow('旧任务未记录生图模型，请重新提交')
    expect(harness.createdSessions).toEqual([])
  })

  test('Given 上次进程留下 queued 和未落占位的 pending journal When 恢复 Then queued 标记 interrupted 且孤立 pending 被删除', () => {
    const jobsDirectory = join(cacheRoot, 'jobs')
    mkdirSync(jobsDirectory, { recursive: true })
    document.nodes = [{
      id: 'node-queued', kind: 'job', jobId: 'job-queued', position: { x: 0, y: 0 },
      width: 320, height: 240, zIndex: 0,
    }]
    writeFileSync(join(jobsDirectory, 'job-queued.json'), JSON.stringify({
      id: 'job-queued', projectId: 'project-1', action: 'generate', status: 'queued',
      prompt: '排队任务', nodeId: 'node-queued', position: { x: 0, y: 0 },
      placementState: 'ready', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(jobsDirectory, 'job-orphan.json'), JSON.stringify({
      id: 'job-orphan', projectId: 'project-1', action: 'generate', status: 'queued',
      prompt: '孤立任务', nodeId: 'node-orphan', position: { x: 0, y: 0 },
      placementState: 'pending', createdAt: 1, updatedAt: 1,
    }))

    const recovered = harness.manager.recover('project-1')

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ id: 'job-queued', status: 'interrupted' })
    expect(existsSync(join(jobsDirectory, 'job-orphan.json'))).toBe(false)
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
      }, extensions: AgentRunExtensions) => Promise<void>)
      createSessionError?: Error
      importError?: Error
      mutateError?: Error
      mutateAfterApplyError?: Error
      createId: () => string
      outputMutateAfterApplyError?: Error
      outputReloadError?: Error
      outputPhase: boolean
      outputMutationAttempted: boolean
      attemptRelocationDuringImport: boolean
      relocationAttemptError?: string
      forceOutputReloadError: boolean
      throwAfterRetryIntentWrite: boolean
      throwOnRetryFinalizeWrite: boolean
      throwAfterReplacementJournalWrite: boolean
      resolveAvailableSnapshot: (profileId: string) => ImageGenerationModelSnapshot
      assertSnapshotAvailable: (snapshot: ImageGenerationModelSnapshot) => void
      resolveExecutionRoute: (snapshot: ImageGenerationModelSnapshot) => ResolvedImageGenerationRoute
    } = {
      settings: { agentChannelId: 'channel-default', agentModelId: 'model-default' },
      messages: [] as AgentMessage[],
      runHeadless: undefined,
      createId: () => `job-${identity}`,
      outputPhase: false,
      outputMutationAttempted: false,
      attemptRelocationDuringImport: false,
      forceOutputReloadError: false,
      throwAfterRetryIntentWrite: false,
      throwOnRetryFinalizeWrite: false,
      throwAfterReplacementJournalWrite: false,
      resolveAvailableSnapshot: (profileId) => ({
        profileId, name: '测试生图模型', executor: 'nano-banana', modelId: 'image-model-test',
      }),
      assertSnapshotAvailable: () => undefined,
      resolveExecutionRoute: (snapshot) => ({
        executor: 'nano-banana',
        snapshot: snapshot as Extract<ImageGenerationModelSnapshot, { executor: 'nano-banana' }>,
      }),
    }
    const createdSessions: AgentSessionMeta[] = []
    const stoppedSessions: string[] = []
    const importSources: DesignAssetImportSource[] = []
    const runInputs: Array<Record<string, unknown>> = []
    const warnings: string[] = []
    /** 真实 lease registry 用于验证迁移无法插入 output 提交窗口。 */
    const workspaceRegistry = createWorkspaceOperationRegistry()
    let workspaceWriteDepth = 0
    const outputEffects: string[] = []
    const unguardedOutputEffects: string[] = []
    let batchCommits = 0
    let batchRollbacks = 0
    let retryIntentWrites = 0
    /** 记录 output 阶段副作用并验证 Manager 外层 lease。 */
    const recordOutputEffect = (effect: string): void => {
      outputEffects.push(effect)
      if (workspaceWriteDepth === 0) unguardedOutputEffects.push(effect)
    }
    const store: DesignStore = {
      load: () => ({ document, writable: true }),
      requireStableAuthoritativeDocument: () => {
        if (state.outputPhase) recordOutputEffect('authoritative-read')
        if ((state.outputMutationAttempted || state.forceOutputReloadError) && state.outputReloadError) {
          throw state.outputReloadError
        }
        return document
      },
      mutate: (_projectId, _expectedRevision, mutations) => {
        const isOutputMutation = mutations.some((mutation) => mutation.type === 'upsert-assets')
        if (isOutputMutation) recordOutputEffect('store-mutate')
        if (state.mutateError) throw state.mutateError
        document = {
          ...applyDesignMutations(document, mutations),
          revision: document.revision + 1,
        }
        if (isOutputMutation) {
          state.outputMutationAttempted = true
          if (state.outputMutateAfterApplyError) throw state.outputMutateAfterApplyError
        }
        if (state.mutateAfterApplyError) throw state.mutateAfterApplyError
        return document
      },
    }
    const manager = new DesignJobManager({
      pathResolver: { resolve: () => ({ jobsDir: join(cacheRoot, 'jobs') }) },
      store,
      assetService: {
        resolveAssetPath: () => '/trusted/source.png',
        importAuthorizedFiles: async (_projectId, _paths, source) => {
          state.outputPhase = true
          recordOutputEffect('import')
          if (state.attemptRelocationDuringImport) {
            try {
              const release = workspaceRegistry.acquireWorkspaceOperation('project-1', 'relocation')
              release()
            } catch (error) {
              state.relocationAttemptError = error instanceof Error ? error.message : String(error)
            }
          }
          if (state.importError) throw state.importError
          importSources.push(source)
          const batch = [createAsset('asset-output', source)] as DesignAssetImportBatch
          batch.commit = () => { recordOutputEffect('commit'); batchCommits += 1 }
          batch.rollback = () => { recordOutputEffect('rollback'); batchRollbacks += 1 }
          return batch
        },
      },
      imageModels: {
        resolveAvailableSnapshot: (profileId) => state.resolveAvailableSnapshot(profileId),
        assertSnapshotAvailable: (snapshot) => state.assertSnapshotAvailable(snapshot),
        resolveExecutionRoute: (snapshot) => state.resolveExecutionRoute(snapshot),
      },
      getSettings: () => state.settings,
      getSession: (sessionId) => createdSessions.find((session) => session.id === sessionId),
      createSession: (input) => {
        if (state.createSessionError) throw state.createSessionError
        const session: AgentSessionMeta = {
          id: `session-${createdSessions.length + 1}`,
          title: input.title,
          channelId: input.channelId,
          modelId: input.modelId,
          workspaceId: input.projectId,
          sourceDesignProjectId: input.projectId,
          sourceDesignJobId: input.sourceDesignJobId,
          createdAt: 1,
          updatedAt: 1,
        }
        createdSessions.push(session)
        return session
      },
      runHeadless: async (input, callbacks, extensions) => {
        runInputs.push({
          ...input,
          source: callbacks.source,
          allowedToolNames: extensions.allowedToolNames,
          toolCallLimits: extensions.toolCallLimits,
          trustedImageRoute: extensions.trustedImageRoute,
          hasTrustedImageRouteResolver: typeof extensions.resolveTrustedImageRoute === 'function',
        })
        if (state.runHeadless) return state.runHeadless(callbacks, extensions)
        callbacks.onComplete(state.messages)
      },
      stopAgent: async (sessionId) => { stoppedSessions.push(sessionId) },
      resolveOwnedOutputPath: (sessionId, localPath) => (
        localPath.startsWith(`${sessionId}/`) ? `/trusted/${localPath}` : undefined
      ),
      listProjectIds: () => ['project-1'],
      warn: (message) => { warnings.push(message) },
      logImageModelError: (message, error) => { warnings.push(`${message} ${String(error)}`) },
      runWorkspaceWrite: <T>(projectId: string, effect: () => T): T => {
        const release = workspaceRegistry.acquireWorkspaceWriteLease(projectId)
        workspaceWriteDepth += 1
        try {
          const result = effect()
          if (result instanceof Promise) {
            return result.finally(() => {
              workspaceWriteDepth -= 1
              release()
            }) as T
          }
          workspaceWriteDepth -= 1
          release()
          return result
        } catch (error) {
          workspaceWriteDepth -= 1
          release()
          throw error
        }
      },
      writeJobJournal: (path, value) => {
        const job = value as { id?: string; replacedByJobId?: string; retryState?: { status?: string } }
        if (job.id === 'job-1' && job.replacedByJobId && job.retryState === undefined
          && state.throwOnRetryFinalizeWrite) {
          throw new Error('retry finalize directory fsync failed')
        }
        writeFileSync(path, JSON.stringify(value), 'utf8')
        if (job.id === 'job-2' && !job.replacedByJobId && job.retryState === undefined
          && state.throwAfterReplacementJournalWrite) {
          throw new Error('replacement journal committed before crash')
        }
        if (job.id === 'job-1' && job.replacedByJobId && job.retryState?.status === 'pending'
          && state.throwAfterRetryIntentWrite) {
          retryIntentWrites += 1
          state.throwAfterRetryIntentWrite = false
          throw new Error('retry intent directory fsync failed')
        }
        if (job.id === 'job-1' && job.replacedByJobId && job.retryState?.status === 'pending') retryIntentWrites += 1
      },
      createId: () => {
        identity += 1
        return state.createId()
      },
      now: () => 10 + identity,
    })
    /** Manager 对外事件必须携带 Store 权威 revision。 */
    const changedEvents: Array<{ job: DesignJobRecord; revision: number }> = []
    manager.onChanged((event) => { changedEvents.push(event) })
    return {
      manager,
      createdSessions,
      stoppedSessions,
      importSources,
      runInputs,
      warnings,
      changedEvents,
      outputEffects,
      unguardedOutputEffects,
      get batchCommits() { return batchCommits },
      get batchRollbacks() { return batchRollbacks },
      get retryIntentWrites() { return retryIntentWrites },
      get relocationAttemptError() { return state.relocationAttemptError },
      get settings() { return state.settings },
      set settings(value: typeof state.settings) { state.settings = value },
      get messages() { return state.messages },
      set messages(value: AgentMessage[]) { state.messages = value },
      set runHeadless(value: typeof state.runHeadless) { state.runHeadless = value },
      set createSessionError(value: Error | undefined) { state.createSessionError = value },
      set importError(value: Error | undefined) { state.importError = value },
      set mutateError(value: Error | undefined) { state.mutateError = value },
      set mutateAfterApplyError(value: Error | undefined) { state.mutateAfterApplyError = value },
      set createId(value: () => string) { state.createId = value },
      set outputMutateAfterApplyError(value: Error | undefined) { state.outputMutateAfterApplyError = value },
      set outputReloadError(value: Error | undefined) { state.outputReloadError = value },
      set attemptRelocationDuringImport(value: boolean) { state.attemptRelocationDuringImport = value },
      set forceOutputReloadError(value: boolean) { state.forceOutputReloadError = value },
      set throwAfterRetryIntentWrite(value: boolean) { state.throwAfterRetryIntentWrite = value },
      set throwOnRetryFinalizeWrite(value: boolean) { state.throwOnRetryFinalizeWrite = value },
      set throwAfterReplacementJournalWrite(value: boolean) { state.throwAfterReplacementJournalWrite = value },
      set resolveAvailableSnapshot(value: typeof state.resolveAvailableSnapshot) {
        state.resolveAvailableSnapshot = value
      },
      set assertSnapshotAvailable(value: typeof state.assertSnapshotAvailable) {
        state.assertSnapshotAvailable = value
      },
      set resolveExecutionRoute(value: typeof state.resolveExecutionRoute) {
        state.resolveExecutionRoute = value
      },
    }
  }
})

/** 创建只覆盖多项目恢复隔离所需边界的 Manager。 */
function createMultiProjectRecoveryManager(projectBJobs: string, warnings: string[]): DesignJobManager {
  const emptyBatch: DesignAssetImportBatch = Object.assign([], {
    commit: () => undefined,
    rollback: () => undefined,
  })
  return new DesignJobManager({
    pathResolver: {
      resolve: (projectId) => {
        if (projectId === 'project-a') throw new Error('路径解析失败')
        return { jobsDir: projectBJobs }
      },
    },
    store: {
      load: (projectId) => ({ document: createEmptyDesignDocument(projectId), writable: true }),
      requireStableAuthoritativeDocument: (projectId) => createEmptyDesignDocument(projectId),
      mutate: (projectId) => createEmptyDesignDocument(projectId),
    },
    assetService: {
      resolveAssetPath: () => '/unused.png',
      importAuthorizedFiles: async () => emptyBatch,
    },
    imageModels: {
      resolveAvailableSnapshot: (profileId) => ({
        profileId, name: '测试生图模型', executor: 'nano-banana', modelId: 'image-model-test',
      }),
      assertSnapshotAvailable: () => undefined,
      resolveExecutionRoute: (snapshot) => ({
        executor: 'nano-banana',
        snapshot: snapshot as Extract<ImageGenerationModelSnapshot, { executor: 'nano-banana' }>,
      }),
    },
    getSettings: () => ({}),
    getSession: () => undefined,
    createSession: () => { throw new Error('测试不应创建会话') },
    updateSession: () => undefined,
    runHeadless: async () => undefined,
    stopAgent: () => undefined,
    resolveOwnedOutputPath: () => undefined,
    listProjectIds: () => ['project-a', 'project-b'],
    runWorkspaceWrite: (_projectId, effect) => effect(),
    warn: (message) => { warnings.push(message) },
    now: () => 20,
  })
}

/** 创建可由重启/退出流程收敛的最小 running journal。 */
function createStoredRunningJob(projectId: string, id: string): object {
  return {
    id,
    projectId,
    action: 'generate',
    status: 'running',
    prompt: '生成海报',
    nodeId: `node-${id}`,
    position: { x: 0, y: 0 },
    placementState: 'ready',
    sessionId: `session-${id}`,
    createdAt: 1,
    updatedAt: 1,
  }
}

/** 创建生成任务输入。 */
function createGenerateInput(): CreateDesignJobInput {
  return {
    projectId: 'project-1', action: 'generate', prompt: '生成海报',
    imageModelProfileId: 'profile-test', position: { x: 10, y: 20 },
  }
}

/** 创建带主进程解析蒙版的编辑任务输入。 */
function createEditInput(): CreateDesignJobInput {
  return {
    projectId: 'project-1', action: 'edit', prompt: '移除文字', sourceAssetId: 'asset-source',
    imageModelProfileId: 'profile-test', maskAnnotationId: 'mask-1', position: { x: 10, y: 20 },
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
