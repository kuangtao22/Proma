import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaConfigStore } from './media-config-store'
import { ComfyUIError } from './comfyui-client'
import type { ComfyHistoryPrompt, ComfyOutputReference, ComfyQueuePrompt, ComfyUploadImageInput } from './comfyui-client'
import type { ComfyPrompt, JsonObject, JsonValue } from '@proma/shared'
import { createMediaWorkflowFieldBinding, listMediaWorkflowFields } from '@proma/shared'
import { MediaRunService } from './media-run-service'
import { writeJsonFileAtomicSecure } from '../safe-file'

/** 测试运行目录，不触碰真实素材和服务。 */
let directory = ''
/** 本地已授权素材内容，输入 hash 固定到实际字节。 */
const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
/** 固定版本的素材引用，远端文件名不能充当此引用。 */
const asset = { assetId: 'asset-a', revision: 1, hash: createHash('sha256').update(imageBytes).digest('hex'), mediaKind: 'image' as const }

/** 测试工作流需要的输出数量。 */
interface HarnessOptions {
  outputCount?: 1 | 2
  rootDirectory?: string
  assertOutputSupport?: () => Promise<void>
  installedProcessor?: boolean
  /** 真实 LoadImage 的输入使用动态文件枚举。 */
  resourceEnum?: boolean
}

/** 上传失败时远端文件是否已经落盘。 */
type UploadFailureMode = 'none' | 'response-lost-stored' | 'response-lost-missing'

/** 将远端文件描述符转换为测试存储键。 */
function remoteFileKey(reference: ComfyOutputReference): string {
  return `${reference.type}:${reference.subfolder}/${reference.filename}`
}

/** 构造可观察网络副作用次数的端到端协议边界。 */
function harness(options: HarnessOptions = {}) {
  /** 当前测试工作流声明的输出数量。 */
  const outputCount = options.outputCount ?? 1
  /** 当前 fixture 独立使用的配置与运行根目录。 */
  const rootDirectory = options.rootDirectory ?? directory
  const configuration = new MediaConfigStore(rootDirectory)
  configuration.saveConnection({ id: 'gpu', name: 'GPU', driver: 'comfyui', baseUrl: 'http://localhost:8188', enabled: true, projectIds: ['project-a'], auth: { kind: 'none' } }, 0)
  /** 根据测试规模增加第二个图片输出节点。 */
  const prompt: ComfyPrompt = {
    '1': { class_type: 'LoadImage', inputs: {} },
    ...(options.installedProcessor ? { processor: { class_type: 'InstalledImageProcessor', inputs: {
      image: ['1', 0], model_name: 'processor-v2.safetensors', prompt: 'cinematic portrait', strength: 0.75,
    } } } : {}),
    '2': { class_type: 'SaveImage', inputs: { images: [options.installedProcessor ? 'processor' : '1', 0], filename_prefix: 'Proma' } },
    ...(outputCount === 2 ? { '3': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma-alt' } } } : {}),
  }
  configuration.saveWorkflow({ id: 'wf', name: '图片', projectId: 'project-a', definition: { schemaVersion: 1,
    prompt,
    bindings: [{ key: 'source', kind: 'image', nodeId: '1', input: 'image', loader: 'LoadImage' }],
    outputs: [
      { key: 'image.main', nodeId: '2', outputIndex: 0, mediaType: 'image' },
      ...(outputCount === 2 ? [{ key: 'image.alt', nodeId: '3', outputIndex: 0, mediaType: 'image' } as const] : []),
    ] } }, 1)
  configuration.saveProfile({ id: 'preset', name: '图片', connectionId: 'gpu', workflowId: 'wf', workflowRevision: 1, mediaKind: 'image', projectId: 'project-a', enabled: true }, 2)
  const calls = { upload: 0, submit: 0, download: 0, register: 0, cancel: 0 }
  /** 远端 input/output 文件的按路径内容。 */
  const remoteFiles = new Map<string, Uint8Array>()
  /** 上传请求的关键参数，用于验证恢复沿用原计划。 */
  const uploadRequests: Array<Pick<ComfyUploadImageInput, 'filename' | 'subfolder' | 'type' | 'overwrite'>> = []
  /** view 请求的完整描述符。 */
  const viewRequests: ComfyOutputReference[] = []
  /** 已登记输出的稳定操作键。 */
  const registeredOperations: string[] = []
  let unknownSubmission = false
  let failDownload = false
  let failOutputFilename: string | null = null
  let uploadFailureMode: UploadFailureMode = 'none'
  let recordedPromptId = ''
  let recordedClientId = ''
  let recordedPrompt: ComfyPrompt = {}
  let acceptedNodeErrors: JsonObject = {}
  let history: ComfyHistoryPrompt | null = null
  let queue: ComfyQueuePrompt | null = null
  const client = {
    objectInfo: async () => ({ LoadImage: { input: { required: { image: [options.resourceEnum ? ['existing.png'] : 'STRING', { image_upload: true }] as [string | string[], { image_upload: boolean }] } }, output: ['IMAGE'], output_node: false },
      ...(options.installedProcessor ? { InstalledImageProcessor: { input: { required: {
        image: ['IMAGE'] as ['IMAGE'], model_name: [['processor-v2.safetensors']] as [[string]],
        prompt: ['STRING'] as ['STRING'], strength: ['FLOAT', { min: 0, max: 1 }] as ['FLOAT', { min: number; max: number }],
      } }, output: ['IMAGE'], output_is_list: [false] } } : {}),
      SaveImage: { input: { required: { images: ['IMAGE'] as ['IMAGE'], filename_prefix: ['STRING'] as ['STRING'] } }, output: [], output_node: true } }),
    uploadImage: async (upload: ComfyUploadImageInput) => {
      calls.upload += 1
      uploadRequests.push({ filename: upload.filename, subfolder: upload.subfolder, type: upload.type, overwrite: upload.overwrite })
      /** 本次上传携带的真实图片字节。 */
      const bytes = new Uint8Array(await upload.image.arrayBuffer())
      /** 请求计划对应的远端 input 描述符。 */
      const requested = { filename: upload.filename, subfolder: upload.subfolder ?? '', type: upload.type ?? 'input' } as const
      if (uploadFailureMode === 'response-lost-stored') remoteFiles.set(remoteFileKey(requested), bytes)
      if (uploadFailureMode !== 'none') throw new Error('上传响应丢失')
      /** 正常响应模拟服务端采用的权威改名回执。 */
      const accepted = { name: 'renamed.png', subfolder: 'proma/test', type: 'input' as const }
      remoteFiles.set(remoteFileKey({ filename: accepted.name, subfolder: accepted.subfolder, type: accepted.type }), bytes)
      return accepted
    },
    submitPrompt: async (prompt: ComfyPrompt, options: { promptId?: string; clientId?: string }) => {
      calls.submit += 1
      expect(typeof prompt['1']?.inputs.image).toBe('string')
      recordedPromptId = options.promptId ?? ''
      recordedPrompt = prompt
      recordedClientId = options.clientId ?? ''
      if (unknownSubmission) throw new ComfyUIError('unknown-submission', '提交响应遗失')
      return { promptId: recordedPromptId, number: 0, nodeErrors: structuredClone(acceptedNodeErrors) }
    },
    getQueue: async () => queue,
    getHistory: async () => history,
    getOutput: async (reference: ComfyOutputReference) => {
      calls.download += 1
      viewRequests.push(structuredClone(reference))
      if (failDownload || reference.filename === failOutputFilename) throw new Error('下载断线')
      const bytes = remoteFiles.get(remoteFileKey(reference))
      if (!bytes) throw new ComfyUIError('http', '远端文件不存在', 404)
      return { bytes, contentType: 'image/png' }
    },
    cancelPrompt: async () => { calls.cancel += 1 },
  }
  const dependencies = {
    configuration,
    assertOutputSupport: options.assertOutputSupport,
    getRunsDirectory: (projectId: string) => join(rootDirectory, projectId, 'runs'),
    authorize: (_projectId: string, _operation: string) => undefined,
    readAsset: async () => imageBytes,
    registerOutput: async (_projectId: string, operationId: string) => {
      calls.register += 1
      registeredOperations.push(operationId)
      return { assetId: `output-${calls.register}`, revision: 1, hash: asset.hash, mediaKind: 'image' as const }
    },
    createClient: () => client,
  }
  const create = () => new MediaRunService(dependencies)
  return { create, calls, configuration, uploadRequests, viewRequests, registeredOperations,
    getRecordedPrompt: () => structuredClone(recordedPrompt),
    setUnknown: () => { unknownSubmission = true }, setUploadFailureMode: (value: UploadFailureMode) => { uploadFailureMode = value },
    setAcceptedNodeErrors: (value: JsonObject) => { acceptedNodeErrors = structuredClone(value) },
    setFailDownload: (value: boolean) => { failDownload = value }, setFailOutputFilename: (value: string | null) => { failOutputFilename = value },
    clearHistory: () => { history = null },
    mismatchHistoryClient: () => { if (history) history.prompt = JSON.parse(JSON.stringify([0, recordedPromptId, recordedPrompt, { client_id: 'other-client' }, ['2']])) as JsonValue },
    mismatchHistoryGraph: () => { if (history) history.prompt = JSON.parse(JSON.stringify([0, recordedPromptId, { ...recordedPrompt, '2': { ...recordedPrompt['2'], inputs: { ...recordedPrompt['2']?.inputs, filename_prefix: 'changed' } } }, { client_id: recordedClientId }, ['2']])) as JsonValue },
    mismatchHistoryPromptId: () => { if (history) history.prompt = JSON.parse(JSON.stringify([0, 'other-prompt', recordedPrompt, { client_id: recordedClientId }, ['2']])) as JsonValue },
    setPendingQueue: (ownership: 'owned' | 'wrong-client' | 'wrong-graph' | 'wrong-prompt') => {
      /** 可按单个归属字段制造冲突的官方队列 tuple。 */
      const tuplePromptId = ownership === 'wrong-prompt' ? 'other-prompt' : recordedPromptId
      const tupleGraph = ownership === 'wrong-graph' ? { ...recordedPrompt, unexpected: { class_type: 'SaveImage', inputs: {} } } : recordedPrompt
      const tupleClientId = ownership === 'wrong-client' ? 'other-client' : recordedClientId
      queue = { promptId: recordedPromptId, state: 'pending', number: 0,
        raw: JSON.parse(JSON.stringify([0, tuplePromptId, tupleGraph, { client_id: tupleClientId }, ['2']])) as JsonValue }
    },
    complete: () => {
      /** 工作流成功 history 中的固定输出描述符。 */
      const outputs: Record<string, { images: Array<{ filename: string; subfolder: string; type: 'output' }> }> = {
        '2': { images: [{ filename: 'result-1.png', subfolder: '', type: 'output' }] },
        ...(outputCount === 2 ? { '3': { images: [{ filename: 'result-2.png', subfolder: '', type: 'output' }] } } : {}),
      }
      for (const output of Object.values(outputs).flatMap((item) => item.images)) remoteFiles.set(remoteFileKey(output), imageBytes)
      history = { promptId: recordedPromptId, prompt: JSON.parse(JSON.stringify([0, recordedPromptId, recordedPrompt, { client_id: recordedClientId }, Object.keys(outputs)])) as JsonValue,
        outputs, status: { completed: true, status_str: 'success' } }
    } }
}

/** 首次生成请求，operationId 绑定用户的一次明确操作。 */
function input() { return { projectId: 'project-a', operationId: 'action-a', profileId: 'preset', profileRevision: 1, inputs: { source: { kind: 'asset' as const, asset } } } }

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'proma-media-run-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('媒体运行完整链路', () => {
  test('Given 远端 Loader 文件枚举 When 新素材尚未上传 Then 可准备并用实际回执填充且只提交一次', async () => {
    /** 模拟真实 ComfyUI 的文件列表，不使用 STRING 简化 Loader 合同。 */
    const fixture = harness({ resourceEnum: true })
    /** 公共模板会把媒体引用清空为占位字符串。 */
    const definition = fixture.configuration.getWorkflow('wf', 1, 'project-a').definition
    fixture.configuration.saveWorkflow({ id: 'public-workflow', name: '公共图', projectId: null, definition }, 3)
    const service = fixture.create()
    const prepared = await service.prepareDraft({ projectId: 'project-a', operationId: 'new-source',
      connectionId: 'gpu', workflowId: 'public-workflow', workflowRevision: 1, mediaKind: 'image', inputs: input().inputs })
    const queued = await service.advance('project-a', prepared.id, prepared.revision)
    expect(queued.phase).toBe('queued')
    expect(fixture.getRecordedPrompt()['1']?.inputs.image).toBe('proma/test/renamed.png')
    expect(fixture.calls.submit).toBe(1)
  })

  test('Given 可选填写项缺省 When 准备后恢复执行 Then 冻结 API 图原值且重放不重复提交', async () => {
    const fixture = harness()
    const definition = fixture.configuration.getWorkflow('wf', 1, 'project-a').definition
    const field = listMediaWorkflowFields(definition.prompt).find((item) => item.input === 'filename_prefix')!
    const binding = createMediaWorkflowFieldBinding(field, 'text')
    binding.field!.required = false
    definition.bindings.push(binding)
    fixture.configuration.saveWorkflow({ id: 'public-workflow', name: '图', projectId: null, definition }, 3)
    const request = { projectId: 'project-a', operationId: 'optional-field', connectionId: 'gpu', workflowId: 'public-workflow', workflowRevision: 1, mediaKind: 'image' as const, inputs: input().inputs }
    const prepared = await fixture.create().prepareDraft(request)
    expect((await fixture.create().prepareDraft(request)).id).toBe(prepared.id)
    const queued = await fixture.create().advance('project-a', prepared.id, prepared.revision)
    expect(queued.phase).toBe('queued')
    const manifest = JSON.parse(readFileSync(join(directory, 'project-a', 'runs', `${prepared.id}.json`), 'utf8'))
    expect(manifest.compiled.prompt['2'].inputs.filename_prefix).toBe('Proma')
    expect(fixture.calls.submit).toBe(1)
  })
  test('Given 公共工作流 When 另一个项目准备 Then 冻结同版本且不需要项目预设', async () => {
    const fixture = harness()
    const definition = fixture.configuration.getWorkflow('wf', 1, 'project-a').definition
    fixture.configuration.saveWorkflow({ id: 'public-workflow', name: '公共图', projectId: null, definition }, 3)
    const prepared = await fixture.create().prepareDraft({ projectId: 'project-b', operationId: 'public-run',
      connectionId: 'gpu', workflowId: 'public-workflow', workflowRevision: 1, mediaKind: 'image', inputs: input().inputs })
    expect(prepared.projectId).toBe('project-b')
    expect(prepared.profileId).toBeUndefined()
    expect(fixture.calls.submit).toBe(0)
  })

  test('Given 已准备任务 When 连接停用并改地址后推进 Then 使用原实例继续且不重新选型', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    fixture.configuration.saveConnection({ id: 'gpu', name: '新地址', driver: 'comfyui', baseUrl: 'http://localhost:8189', enabled: false, auth: { kind: 'none' } }, 3)
    const running = await fixture.create().advance('project-a', prepared.id, prepared.revision)
    expect(running.phase).toBe('queued')
    expect(fixture.calls.submit).toBe(1)
  })
  test('Given 本机输出处理不可用 When 准备或执行 Then 上传和付费提交均未发生', async () => {
    let available = false
    const fixture = harness({ assertOutputSupport: async () => { if (!available) throw new Error('MEDIA_PROBE_UNAVAILABLE') } })
    await expect(fixture.create().prepare(input())).rejects.toThrow('MEDIA_PROBE_UNAVAILABLE')
    available = true
    const prepared = await fixture.create().prepare(input())
    available = false
    await expect(fixture.create().advance('project-a', prepared.id, prepared.revision)).rejects.toThrow('MEDIA_PROBE_UNAVAILABLE')
    expect(fixture.calls.upload).toBe(0)
    expect(fixture.calls.submit).toBe(0)
  })
  test('Given child准备与父调度接管 When 重启并重复接管 Then 保留同一run与准备者且拒绝改输入', async () => {
    const fixture = harness()
    const canvasMedia = { projectId: 'project-a', canvasId: 'canvas', nodeId: 'video', mediaModuleId: 'module', mediaKind: 'video' as const }
    const actor = { sessionId: 'child', runStartedAt: 1, mode: 'parent-orchestrated' as const, canvasId: 'canvas', nodeId: 'agent' }
    const nextOrigin = { canvasMedia, actor: { sessionId: 'parent', runStartedAt: 1, mode: 'project-agent' as const } }
    const prepared = await fixture.create().prepare(input(), { canvasMedia, actor })
    const claim = { ...input(), runId: prepared.id }
    const result = await fixture.create().claimPrepared(claim, actor, nextOrigin)
    expect(result.id).toBe(prepared.id)
    expect(result.phase).toBe('prepared')
    expect(fixture.create().getOrigin('project-a', result.id)).toEqual({ ...nextOrigin, preparedBy: actor })
    expect((await fixture.create().claimPrepared(claim, actor, nextOrigin)).revision).toBe(result.revision)
    await expect(fixture.create().claimPrepared({ ...claim, inputs: {} }, actor, nextOrigin)).rejects.toThrow('MEDIA_PREPARED_HANDOFF_INVALID')
    expect(fixture.calls.upload).toBe(0)
    expect(fixture.calls.submit).toBe(0)
  })
  test('Given 授权图片 When prepare Then 固定运行身份且没有上传或生成', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    expect(prepared.phase).toBe('prepared')
    expect(fixture.calls).toEqual({ upload: 0, submit: 0, download: 0, register: 0, cancel: 0 })
    expect((await fixture.create().prepare(input())).id).toBe(prepared.id)
  })

  test('Given 已固化运行输入 When Host 读取并修改返回值 Then 持久输入仍保持不变', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    const service = fixture.create()
    const first = service.getInputs('project-a', prepared.id)
    first.source = { kind: 'scalar', value: '已篡改' }

    expect(service.getInputs('project-a', prepared.id)).toEqual(input().inputs)
  })

  test('Given 项目私有 API WorkflowDraft When 直接准备 Then 固化草稿与连接来源且不伪造 profile', async () => {
    const fixture = harness()
    const service = fixture.create()
    const prepared = await service.prepareDraft({ ...input(), connectionId: 'gpu', workflowId: 'wf',
      workflowRevision: 1, mediaKind: 'image' })

    expect(prepared.sourceRef).toEqual({ kind: 'project-draft-revision', workflowId: 'wf', workflowRevision: 1,
      connectionId: 'gpu', mediaKind: 'image' })
    expect(prepared.profileId).toBeUndefined()
    expect(service.getSourceRef('project-a', prepared.id)).toEqual({
      kind: 'project-draft-revision', workflowId: 'wf', workflowRevision: 1,
      connectionId: 'gpu', mediaKind: 'image',
    })
    expect(service.getWorkflowDefinition('project-a', prepared.id).outputs[0]?.key).toBe('image.main')
  })

  test('Given 图生图工作流 When 上传、提交、收集 Then 使用改名回执且产物可追踪', async () => {
    const fixture = harness()
    const service = fixture.create()
    const prepared = await service.prepare(input())
    const queued = await service.advance('project-a', prepared.id, prepared.revision)
    expect(queued.phase).toBe('queued')
    fixture.complete()
    const completed = await service.reconcile('project-a', queued.id)
    expect(completed.phase).toBe('succeeded')
    expect(completed.outputs[0]?.outputKey).toBe('image.main')
    expect(completed.outputs[0]?.asset.assetId).toBe('output-1')
    expect(fixture.calls).toEqual({ upload: 1, submit: 1, download: 1, register: 1, cancel: 0 })
  })

  test('Given 工作流包含连接已安装处理节点 When 准备、上传、提交并收集 Then 固化接口且保持 typed 素材链路', async () => {
    const fixture = harness({ installedProcessor: true })
    const service = fixture.create()
    const prepared = await service.prepare(input())
    const manifest = JSON.parse(readFileSync(join(directory, 'project-a', 'runs', `${prepared.id}.json`), 'utf8')) as {
      schema: Record<string, unknown>
    }
    expect(manifest.schema.InstalledImageProcessor).toBeDefined()

    const queued = await service.advance('project-a', prepared.id, prepared.revision)
    expect(queued.phase).toBe('queued')
    expect(fixture.getRecordedPrompt().processor?.inputs).toEqual({
      image: ['1', 0], model_name: 'processor-v2.safetensors', prompt: 'cinematic portrait', strength: 0.75,
    })
    expect(fixture.getRecordedPrompt()['1']?.inputs.image).toBe('proma/test/renamed.png')

    fixture.complete()
    const completed = await service.reconcile('project-a', queued.id)
    expect(completed.phase).toBe('succeeded')
    expect(completed.outputs[0]?.asset.assetId).toBe('output-1')
  })

  test('Given 提交响应遗失 When 重启并重复执行 Then 保持未知且只提交一次', async () => {
    const fixture = harness()
    fixture.setUnknown()
    const prepared = await fixture.create().prepare(input())
    const unknown = await fixture.create().advance('project-a', prepared.id, prepared.revision)
    expect(unknown.phase).toBe('submission-unknown')
    const resumed = await fixture.create().advance('project-a', unknown.id, unknown.revision)
    expect(resumed.phase).toBe('submission-unknown')
    expect(fixture.calls.submit).toBe(1)
    fixture.complete()
    expect((await fixture.create().reconcile('project-a', prepared.id)).phase).toBe('succeeded')
    expect(fixture.calls.submit).toBe(1)
  })

  test('Given ComfyUI 200 回执含 node_errors When 服务提交 Then 保留 prompt 身份继续追踪且不允许重提', async () => {
    const fixture = harness()
    fixture.setAcceptedNodeErrors({ optional_output: { errors: ['缺少可选模型'] } })
    const prepared = await fixture.create().prepare(input())
    const queued = await fixture.create().advance('project-a', prepared.id, prepared.revision)

    expect(queued.phase).toBe('queued')
    expect(queued.error).toBeNull()
    expect((await fixture.create().advance('project-a', queued.id, queued.revision)).phase).toBe('queued')
    expect(fixture.calls.submit).toBe(1)
  })

  test('Given 上传响应遗失但原文件存在 When 重启恢复 Then 哈希核对后复用原计划文件', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    fixture.setUploadFailureMode('response-lost-stored')
    await expect(fixture.create().advance('project-a', prepared.id, prepared.revision)).rejects.toThrow('上传响应丢失')
    fixture.setUploadFailureMode('none')
    /** 首次失败后已经原子保存的上传计划。 */
    const manifest = JSON.parse(readFileSync(join(directory, 'project-a', 'runs', `${prepared.id}.json`), 'utf8')) as {
      uploadPlans: Array<{ filename: string; subfolder: string }>
    }
    /** 恢复必须沿用首次副作用前持久化的唯一计划。 */
    const plan = manifest.uploadPlans[0]
    expect(plan).toBeDefined()
    if (!plan) throw new Error('测试缺少上传计划')
    const latest = fixture.create().get('project-a', prepared.id)
    expect((await fixture.create().advance('project-a', latest.id, latest.revision)).phase).toBe('queued')
    expect(fixture.calls.upload).toBe(1)
    expect(fixture.calls.download).toBe(1)
    expect(fixture.calls.submit).toBe(1)
    expect(fixture.viewRequests[0]).toEqual({ filename: plan.filename, subfolder: plan.subfolder, type: 'input' })
  })

  test('Given 未知上传且远端查询断线 When 恢复 Then 不把断线当文件不存在重新上传', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    fixture.setUploadFailureMode('response-lost-stored')
    await expect(fixture.create().advance('project-a', prepared.id, prepared.revision)).rejects.toThrow()
    fixture.setUploadFailureMode('none')
    fixture.setFailDownload(true)
    const latest = fixture.create().get('project-a', prepared.id)
    await expect(fixture.create().advance('project-a', latest.id, latest.revision)).rejects.toThrow('下载断线')
    expect(fixture.calls.upload).toBe(1)
    expect(fixture.calls.submit).toBe(0)
  })

  test('Given 未知上传且原计划文件不存在 When 恢复 Then 仅在404后按同一路径重传', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    fixture.setUploadFailureMode('response-lost-missing')
    await expect(fixture.create().advance('project-a', prepared.id, prepared.revision)).rejects.toThrow('上传响应丢失')
    fixture.setUploadFailureMode('none')
    const latest = fixture.create().get('project-a', prepared.id)
    expect((await fixture.create().advance('project-a', latest.id, latest.revision)).phase).toBe('queued')
    /** 两次上传请求必须复用同一已落盘路径和覆盖策略。 */
    const firstUpload = fixture.uploadRequests[0]
    const retryUpload = fixture.uploadRequests[1]
    expect(firstUpload).toBeDefined()
    expect(retryUpload).toBeDefined()
    if (!firstUpload || !retryUpload) throw new Error('测试缺少上传请求')
    expect(fixture.calls.upload).toBe(2)
    expect(retryUpload).toEqual(firstUpload)
    expect(retryUpload.overwrite).toBe(false)
    expect(fixture.viewRequests[0]).toEqual({
      filename: firstUpload.filename,
      subfolder: firstUpload.subfolder ?? '',
      type: 'input',
    })
  })

  test('Given 恢复记录被破坏 When 读取 Then 非法状态、伪造输出及跨run上传路径全部拒绝', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    const path = join(directory, 'project-a', 'runs', `${prepared.id}.json`)
    const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    for (const change of [
      { snapshot: { ...(original.snapshot as Record<string, unknown>), phase: 'succeeded' } },
      { snapshot: { ...(original.snapshot as Record<string, unknown>), phase: 'unrecognized' } },
      { snapshot: { ...(original.snapshot as Record<string, unknown>), outputs: [{ outputKey: 'image.main', index: 0, asset }] } },
      { uploadPlans: [{ assetHash: asset.hash, filename: 'image.png', subfolder: 'other-run', state: 'planned' }] },
      { operationId: 'other-action' },
    ]) {
      writeJsonFileAtomicSecure(path, { ...original, ...change })
      expect(() => fixture.create().get('project-a', prepared.id)).toThrow()
    }
  })

  test('Given 已提交运行记录被破坏 When 读取 Then 请求指纹、回执和阶段关联全部拒绝', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    await fixture.create().advance('project-a', prepared.id, prepared.revision)
    const path = join(directory, 'project-a', 'runs', `${prepared.id}.json`)
    const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    /** 已提交记录中必须相互关联的编译、提交和上传字段。 */
    const compiled = original.compiled as Record<string, unknown>
    const submission = original.submission as Record<string, unknown>
    const snapshot = original.snapshot as Record<string, unknown>
    const uploads = original.uploads as Record<string, unknown>
    const uploadKey = Object.keys(uploads)[0]
    expect(uploadKey).toBeDefined()
    for (const change of [
      { compiled: { ...compiled, hash: '0'.repeat(64) } },
      { submission: { ...submission, requestHash: '0'.repeat(64) } },
      { submission: { ...submission, clientId: '../outside' } },
      { uploads: { ...uploads, [uploadKey!]: { name: 'input.png', subfolder: '../outside', type: 'input' } } },
      { snapshot: { ...snapshot, phase: 'prepared' } },
      { snapshot: { ...snapshot, progress: { nodeId: '1', value: 2, max: 1 } } },
    ]) {
      writeJsonFileAtomicSecure(path, { ...original, ...change })
      expect(() => fixture.create().get('project-a', prepared.id)).toThrow()
    }
  })

  test('Given 已收集记录被破坏 When 读取 Then collection成功状态、prompt和输出完整性全部拒绝', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    await fixture.create().advance('project-a', prepared.id, prepared.revision)
    fixture.complete()
    await fixture.create().reconcile('project-a', prepared.id)
    const path = join(directory, 'project-a', 'runs', `${prepared.id}.json`)
    const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    /** 成功 collection 与公开输出必须保持的恢复关联。 */
    const collection = original.collection as Record<string, unknown>
    const status = collection.status as Record<string, unknown>
    const promptTuple = collection.prompt as JsonValue[]
    const collectionOutputs = collection.outputs as Record<string, unknown>
    const primaryOutput = collectionOutputs['2'] as Record<string, unknown>
    const snapshot = original.snapshot as Record<string, unknown>
    for (const change of [
      { collection: { ...collection, status: { ...status, completed: false } } },
      { collection: { ...collection, promptId: 'other-prompt' } },
      { collection: { ...collection, prompt: [promptTuple[0], promptTuple[1], { changed: true }, promptTuple[3], promptTuple[4]] } },
      { collection: { ...collection, outputs: { ...collectionOutputs, '2': {
        ...primaryOutput, images: [{ filename: '../outside.png', subfolder: '', type: 'output' }],
      } } } },
      { snapshot: { ...snapshot, outputs: [] } },
    ]) {
      writeJsonFileAtomicSecure(path, { ...original, ...change })
      expect(() => fixture.create().get('project-a', prepared.id)).toThrow()
    }
  })

  test('Given 尚未提交的准备 When 用户取消 Then 保留取消事实且后续不提交', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    const cancelled = await fixture.create().cancel('project-a', prepared.id)
    expect(cancelled.phase).toBe('cancelled')
    expect((await fixture.create().advance('project-a', prepared.id, cancelled.revision)).phase).toBe('cancelled')
    expect(fixture.calls.submit).toBe(0)
  })

  test('Given 远端已完成但下载中断 When 再次收集 Then 不重复提交生成', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    await fixture.create().advance('project-a', prepared.id, prepared.revision)
    fixture.complete()
    fixture.setFailDownload(true)
    expect((await fixture.create().reconcile('project-a', prepared.id)).phase).toBe('collection-failed')
    fixture.clearHistory()
    fixture.setFailDownload(false)
    expect((await fixture.create().reconcile('project-a', prepared.id)).phase).toBe('succeeded')
    expect(fixture.calls.submit).toBe(1)
    expect(fixture.calls.register).toBe(1)
  })

  test('Given 多输出仅首项已登记 When 第二项下载失败后重启 Then 固化history并只补收第二项', async () => {
    const fixture = harness({ outputCount: 2 })
    const prepared = await fixture.create().prepare(input())
    await fixture.create().advance('project-a', prepared.id, prepared.revision)
    fixture.complete()
    fixture.setFailOutputFilename('result-2.png')
    expect((await fixture.create().reconcile('project-a', prepared.id)).phase).toBe('collection-failed')
    expect(fixture.calls.register).toBe(1)
    expect(fixture.registeredOperations).toEqual([`${prepared.id}:image.main:0`])
    fixture.clearHistory()
    fixture.setFailOutputFilename(null)
    expect((await fixture.create().reconcile('project-a', prepared.id)).phase).toBe('succeeded')
    expect(fixture.calls.register).toBe(2)
    expect(fixture.registeredOperations).toEqual([`${prepared.id}:image.main:0`, `${prepared.id}:image.alt:0`])
    expect(fixture.viewRequests.filter((request) => request.filename === 'result-1.png')).toHaveLength(1)
    expect(fixture.viewRequests.filter((request) => request.filename === 'result-2.png')).toHaveLength(2)
  })

  test('Given 已完成运行 When 重复收集 Then 不重复登记素材', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    await fixture.create().advance('project-a', prepared.id, prepared.revision)
    fixture.complete()
    await fixture.create().reconcile('project-a', prepared.id)
    await fixture.create().reconcile('project-a', prepared.id)
    expect(fixture.calls.register).toBe(1)
  })

  test('Given history的prompt、图或client任一不匹配 When 收集 Then 不下载或登记其它任务输出', async () => {
    for (const mismatch of ['mismatchHistoryPromptId', 'mismatchHistoryGraph', 'mismatchHistoryClient'] as const) {
      const fixture = harness({ rootDirectory: join(directory, mismatch) })
      const prepared = await fixture.create().prepare(input())
      await fixture.create().advance('project-a', prepared.id, prepared.revision)
      fixture.complete()
      fixture[mismatch]()
      await expect(fixture.create().reconcile('project-a', prepared.id)).rejects.toThrow('MEDIA_REMOTE_OWNERSHIP_UNPROVEN')
      expect(fixture.calls.download).toBe(0)
      expect(fixture.calls.register).toBe(0)
    }
  })

  test('Given 排队任务归属字段不匹配 When 取消 Then 不发送远端删除', async () => {
    for (const ownership of ['wrong-prompt', 'wrong-graph', 'wrong-client'] as const) {
      const fixture = harness({ rootDirectory: join(directory, ownership) })
      const prepared = await fixture.create().prepare(input())
      await fixture.create().advance('project-a', prepared.id, prepared.revision)
      fixture.setPendingQueue(ownership)
      await expect(fixture.create().cancel('project-a', prepared.id)).rejects.toThrow('MEDIA_REMOTE_OWNERSHIP_UNPROVEN')
      expect(fixture.calls.cancel).toBe(0)
    }
  })

  test('Given 既有准备后连接停用 When 幂等prepare重放 Then 仍可取回原run', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    fixture.configuration.saveConnection({ id: 'gpu', name: 'GPU', driver: 'comfyui', baseUrl: 'http://localhost:8188', enabled: false, projectIds: ['project-a'], auth: { kind: 'none' } }, 3)
    expect((await fixture.create().prepare(input())).id).toBe(prepared.id)
    expect(fixture.calls.submit).toBe(0)
  })

  test('Given 素材 hash 不符 When 准备 Then 在上传前阻断', async () => {
    const fixture = harness()
    await expect(fixture.create().prepare({ ...input(), inputs: { source: { kind: 'asset', asset: { ...asset, hash: '0'.repeat(64) } } } })).rejects.toThrow('MEDIA_ASSET_CHANGED')
    expect(fixture.calls.upload).toBe(0)
  })

  test('Given 已有操作 ID When 输入改变或过期 revision Then 不覆盖旧运行', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    await expect(fixture.create().prepare({ ...input(), profileRevision: 2 })).rejects.toThrow()
    await expect(fixture.create().advance('project-a', prepared.id, 0)).rejects.toThrow('MEDIA_RUN_CONFLICT')
    expect(fixture.calls.submit).toBe(0)
  })

  test('Given 准备后连接更换 When 执行 Then 继续原实例并保留同一运行', async () => {
    const fixture = harness()
    const prepared = await fixture.create().prepare(input())
    fixture.configuration.saveConnection({ id: 'gpu', name: '新实例', driver: 'comfyui', baseUrl: 'http://localhost:9191', enabled: true, projectIds: ['project-a'], auth: { kind: 'none' } }, 3)
    expect((await fixture.create().advance('project-a', prepared.id, prepared.revision)).phase).toBe('queued')
    expect(fixture.calls.upload).toBe(1)
    expect((await fixture.create().prepare(input())).id).toBe(prepared.id)
  })
})
