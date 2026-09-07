import { describe, expect, test } from 'bun:test'
import type { DesignAsset, DesignJobRecord, MediaRunSnapshot, MediaWorkflowDefinition } from '@proma/shared'
import { createMediaDesignImageExecution } from './media-design-execution'

const comfySnapshot: Extract<NonNullable<DesignJobRecord['imageModelSnapshot']>, { executor: 'comfyui' }> = {
  profileId: 'media:preset-1:2', name: 'Comfy', modelId: 'workflow-1', executor: 'comfyui',
  mediaProfileId: 'preset-1', mediaProfileRevision: 2, connectionId: 'connection-1',
  workflowId: 'workflow-1', workflowRevision: 3, workflowHash: 'a'.repeat(64),
}

/** 公共工作流图片任务不携带伪造 profile，并冻结所有显式输入。 */
const workflowSnapshot: Extract<NonNullable<DesignJobRecord['imageModelSnapshot']>, { executor: 'comfyui'; source: 'workflow' }> = {
  executor: 'comfyui', source: 'workflow', name: '公共图片工作流', modelId: 'workflow-1@3', connectionId: 'connection-1',
  instanceGeneration: 'generation-1', workflowId: 'workflow-1', workflowRevision: 3,
  workflowHash: 'a'.repeat(64), inputs: {
    promptText: { kind: 'scalar', value: '工作流自己的提示词' },
    widthValue: { kind: 'scalar', value: 768 },
    firstImage: { kind: 'asset', asset: { assetId: 'asset-1', revision: 1, hash: '1'.repeat(64), mediaKind: 'image' } },
    secondImage: { kind: 'asset', asset: { assetId: 'asset-2', revision: 1, hash: '2'.repeat(64), mediaKind: 'image' } },
    soundtrack: { kind: 'asset', asset: { assetId: 'audio-1', revision: 1, hash: '3'.repeat(64), mediaKind: 'audio' } },
    clip: { kind: 'asset', asset: { assetId: 'video-1', revision: 1, hash: '4'.repeat(64), mediaKind: 'video' } },
  },
}

const asset = (id: string, sourceJobId?: string): DesignAsset => ({
  id, filename: `${id}.png`, relativePath: `assets/${id}.png`, thumbnailRelativePath: `thumbs/${id}.png`,
  mediaType: 'image/png', width: 100, height: 100, byteSize: 10, sha256: id.padEnd(64, '0'),
  createdAt: 1, ...(sourceJobId ? { sourceJobId } : {}),
})

const job = (overrides: Partial<DesignJobRecord> = {}): DesignJobRecord => ({
  id: 'job-1', creativeTaskId: 'task-1', attemptNumber: 1, projectId: 'project-1',
  target: { kind: 'canvas-image', canvasId: 'canvas-1', nodeId: 'node-1', imageModuleId: 'image-1' },
  action: 'generate', status: 'running', prompt: '主提示词', originalRequest: '主提示词', contextMode: 'none',
  imageModelSnapshot: comfySnapshot, createdAt: 1, updatedAt: 1, ...overrides,
})

const workflow = (bindings: MediaWorkflowDefinition['bindings']): MediaWorkflowDefinition => ({
  schemaVersion: 1,
  prompt: {
    text: { class_type: 'CLIPTextEncode', inputs: { text: '默认负面词' } },
    negative: { class_type: 'CLIPTextEncode', inputs: { text: '默认负面词' } },
    size: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
    image: { class_type: 'LoadImage', inputs: { image: 'default.png' } },
  },
  bindings,
  outputs: [{ key: 'image', nodeId: 'save', outputIndex: 0, mediaType: 'image' }],
})

const run = (overrides: Partial<MediaRunSnapshot> = {}): MediaRunSnapshot => ({
  id: 'run-1', projectId: 'project-1', revision: 4, phase: 'running', profileId: 'preset-1',
  profileRevision: 2, createdAt: 1, updatedAt: 2, outputs: [], error: null, progress: null, ...overrides,
})

function harness(options: { existing?: MediaRunSnapshot | null; definition?: MediaWorkflowDefinition; assets?: DesignAsset[] } = {}) {
  /** 记录跨服务调用，验证恢复幂等与首次输入投影。 */
  const calls: Array<{ name: string; value?: unknown }> = []
  let current = options.existing ?? null
  const definition = options.definition ?? workflow([{ key: 'prompt', kind: 'text', nodeId: 'text', input: 'text' }])
  const execution = createMediaDesignImageExecution({
    configuration: {
      resolveProfile: (profileId: string, revision: number, projectId: string) => {
        calls.push({ name: 'resolveProfile', value: { profileId, revision, projectId } })
        return {
          profile: { id: profileId, revision, connectionId: 'connection-1', workflowId: 'workflow-1', workflowRevision: 3 },
          workflow: { id: 'workflow-1', revision: 3, hash: 'a'.repeat(64), definition },
        }
      },
      getWorkflow: () => ({
        id: 'workflow-1', name: '公共图片工作流', projectId: null, revision: 3,
        hash: 'a'.repeat(64), definition, createdAt: 1,
      }),
      resolveConnectionVersion: () => ({ connection: { id: 'connection-1', instanceGeneration: 'generation-1' } }),
    },
    runs: {
      findOperation: () => current,
      getOrigin: () => ({ designJobId: 'job-1' }),
      prepare: async (input: unknown) => {
        calls.push({ name: 'prepare', value: input })
        current = run({ phase: 'prepared', revision: 0 })
        return current
      },
      prepareDraft: async (input: unknown) => {
        calls.push({ name: 'prepareDraft', value: input })
        current = run({
          phase: 'prepared', revision: 0, profileId: undefined, profileRevision: undefined,
          sourceRef: { kind: 'project-draft-revision', workflowId: 'workflow-1', workflowRevision: 3, connectionId: 'connection-1', mediaKind: 'image' },
        })
        return current
      },
      cancel: async () => run({ phase: 'cancel-requested' }),
    },
    supervisor: {
      start: (_projectId: string, _runId: string, _revision: number) => current ?? run(),
      wait: async () => current ?? run(),
    },
    store: { requireStableAuthoritativeDocument: () => ({ assets: options.assets ?? [] }) },
  })
  return { execution, calls, setRun: (value: MediaRunSnapshot) => { current = value } }
}

describe('media design execution', () => {
  test('Given 已有 operation, When 继续执行, Then 不重新解析配置或 prepare', async () => {
    const { execution, calls } = harness({ existing: run() })
    expect(await execution.runImage(job())).toEqual({ status: 'pending', error: 'MEDIA_EXECUTION_PENDING' })
    expect(calls).toEqual([])
  })

  test('Given prompt 与其它文本绑定, When 首次 prepare, Then 只覆盖 prompt 并保留图中 literal', async () => {
    const { execution, calls } = harness({ definition: workflow([
      { key: 'prompt', kind: 'text', nodeId: 'text', input: 'text' },
      { key: 'negative', kind: 'text', nodeId: 'negative', input: 'text' },
    ]) })
    await execution.runImage(job())
    expect(calls.find((call) => call.name === 'prepare')?.value).toMatchObject({ inputs: {
      prompt: { kind: 'scalar', value: '主提示词' },
      negative: { kind: 'scalar', value: '默认负面词' },
    } })
  })

  test('Given 公共图片工作流与多媒体输入, When 首次执行, Then 完整映射原样进入 prepareDraft', async () => {
    const { execution, calls } = harness({ definition: workflow([]) })
    await execution.runImage(job({ imageModelSnapshot: workflowSnapshot }))
    expect(calls.find((call) => call.name === 'prepareDraft')?.value).toEqual({
      projectId: 'project-1', operationId: 'job-1', connectionId: 'connection-1',
      workflowId: 'workflow-1', workflowRevision: 3, mediaKind: 'image', inputs: workflowSnapshot.inputs,
    })
    expect(calls.some((call) => call.name === 'prepare')).toBe(false)
  })

  test('Given 公共工作流产生多个输出, When 创建图片运行, Then 提示改用媒体节点且不提交', async () => {
    const definition = workflow([])
    definition.outputs.push({ key: 'preview', nodeId: 'save-2', outputIndex: 0, mediaType: 'image' })
    const { execution, calls } = harness({ definition })
    await expect(execution.runImage(job({ imageModelSnapshot: workflowSnapshot })))
      .rejects.toThrow('MEDIA_CANVAS_MODEL_SNAPSHOT_MISMATCH')
    expect(calls.some((call) => call.name === 'prepareDraft')).toBe(false)
  })

  test('Given 工作流缺少 prompt 文本绑定, When 首次执行, Then 不得静默忽略用户提示词', async () => {
    const { execution } = harness({ definition: workflow([
      { key: 'negative', kind: 'text', nodeId: 'negative', input: 'text' },
    ]) })
    await expect(execution.runImage(job())).rejects.toThrow('MEDIA_CANVAS_PROMPT_BINDING_REQUIRED')
  })

  test('Given 单图片候选与单图片槽, When 首次 prepare, Then 使用权威资产引用', async () => {
    const source = asset('asset-1')
    const { execution, calls } = harness({ assets: [source], definition: workflow([
      { key: 'prompt', kind: 'text', nodeId: 'text', input: 'text' },
      { key: 'reference', kind: 'image', nodeId: 'image', input: 'image', loader: 'LoadImage' },
    ]) })
    await execution.runImage(job({ sourceAssetId: source.id }))
    expect(calls.find((call) => call.name === 'prepare')?.value).toMatchObject({ inputs: {
      reference: { kind: 'asset', asset: { assetId: source.id, revision: 1, hash: source.sha256, mediaKind: 'image' } },
    } })
  })

  test('Given Job 带来源图但工作流无图片槽, When 首次执行, Then 不得静默丢弃编辑输入', async () => {
    const source = asset('asset-1')
    const { execution } = harness({ assets: [source] })
    await expect(execution.runImage(job({ action: 'edit', sourceAssetId: source.id })))
      .rejects.toThrow('MEDIA_CANVAS_IMAGE_INPUT_UNSUPPORTED')
  })

  test('Given 多图片候选或多图片槽, When 首次执行, Then 拒绝歧义绑定', async () => {
    const inputs = [asset('asset-1'), asset('asset-2')]
    const definition = workflow([
      { key: 'prompt', kind: 'text', nodeId: 'text', input: 'text' },
      { key: 'reference', kind: 'image', nodeId: 'image', input: 'image', loader: 'LoadImage' },
    ])
    const { execution } = harness({ assets: inputs, definition })
    await expect(execution.runImage(job({ sourceAssetId: 'asset-1', canvasInputReferences: [{
      nodeId: 'upstream', kind: 'image', revision: 1, summary: '参考图', summaryHash: 'b'.repeat(64),
      sourcePort: 'image.asset', targetPort: 'image.reference', assetId: 'asset-2',
    }] }))).rejects.toThrow('MEDIA_CANVAS_IMAGE_INPUT_AMBIGUOUS')

    const multipleSlots = harness({ assets: [inputs[0]!], definition: workflow([
      { key: 'prompt', kind: 'text', nodeId: 'text', input: 'text' },
      { key: 'reference', kind: 'image', nodeId: 'image', input: 'image', loader: 'LoadImage' },
      { key: 'mask', kind: 'image', nodeId: 'image', input: 'image', loader: 'LoadImage' },
    ]) })
    await expect(multipleSlots.execution.runImage(job({ sourceAssetId: 'asset-1' }))).rejects.toThrow('MEDIA_CANVAS_IMAGE_INPUT_AMBIGUOUS')
  })

  test('Given 生成约束但工作流无尺寸绑定, When 首次执行, Then 明确拒绝', async () => {
    const { execution } = harness()
    await expect(execution.runImage(job({ generationConstraints: { aspectRatio: '16:9', imageSize: '2K' } })))
      .rejects.toThrow('MEDIA_CANVAS_CONSTRAINT_UNSUPPORTED')
  })

  test('Given 明确尺寸绑定, When 首次执行, Then 将长边与比例转换为像素', async () => {
    const { execution, calls } = harness({ definition: workflow([
      { key: 'prompt', kind: 'text', nodeId: 'text', input: 'text' },
      { key: 'width', kind: 'number', nodeId: 'size', input: 'width' },
      { key: 'height', kind: 'number', nodeId: 'size', input: 'height' },
    ]) })
    await execution.runImage(job({ generationConstraints: { aspectRatio: '16:9', imageSize: '2K' } }))
    expect(calls.find((call) => call.name === 'prepare')?.value).toMatchObject({ inputs: {
      width: { kind: 'scalar', value: 2048 }, height: { kind: 'scalar', value: 1152 },
    } })
  })

  test('Given succeeded 单输出, When 恢复, Then 返回属于当前 Job 的权威资产', async () => {
    const output = asset('asset-output', 'job-1')
    const succeeded = run({ phase: 'succeeded', outputs: [{ outputKey: 'image', index: 0, asset: { assetId: output.id, revision: 1, hash: output.sha256, mediaKind: 'image' } }] })
    const { execution } = harness({ existing: succeeded, assets: [output] })
    expect(await execution.recoverImage(job())).toEqual({ status: 'succeeded', asset: output })
  })

  test('Given succeeded 输出身份错误, When 恢复, Then 拒绝跨任务素材', async () => {
    const output = asset('asset-output', 'other-job')
    const succeeded = run({ phase: 'succeeded', outputs: [{ outputKey: 'image', index: 0, asset: { assetId: output.id, revision: 1, hash: output.sha256, mediaKind: 'image' } }] })
    const { execution } = harness({ existing: succeeded, assets: [output] })
    await expect(execution.recoverImage(job())).rejects.toThrow('MEDIA_OUTPUT_JOB_MISMATCH')
  })

  test('Given recover 找不到 operation, When 恢复, Then 不创建新付费运行', async () => {
    const { execution, calls } = harness()
    expect(await execution.recoverImage(job())).toEqual({ status: 'pending', error: 'MEDIA_OPERATION_NOT_FOUND' })
    expect(calls).toEqual([])
  })

  test('Given 取消前无运行或远端尚未确认, When cancel, Then 返回真实确认状态', async () => {
    const missing = harness()
    expect(await missing.execution.cancel('project-1', 'job-1')).toEqual({ confirmed: true })
    const active = harness({ existing: run() })
    expect(await active.execution.cancel('project-1', 'job-1')).toEqual({ confirmed: false })
  })
})
