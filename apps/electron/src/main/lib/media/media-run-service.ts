import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CanvasMediaTarget, ComfyObjectInfo, ComfyPrompt, JsonValue, MediaAssetRef, MediaInputValue, MediaKind, MediaRunPhase, MediaRunSnapshot, MediaRunSourceReference, MediaWorkflowDefinition, PrepareMediaRunInput } from '@proma/shared'
import { parseCanvasMediaTarget, parseComfyObjectInfo, parseComfyPrompt, parseMediaWorkflowDefinition, validateMediaWorkflowFieldValue } from '@proma/shared'
import { writeJsonFileAtomicSecure } from '../safe-file'
import { ComfyUIClient, ComfyUIError } from './comfyui-client'
import type { ComfyHistoryPrompt, ComfyOutputReference, ComfyUploadResult } from './comfyui-client'
import { COMFY_CORE_NODE_CONTRACTS, compileComfyWorkflow, validateComfyWorkflow } from './comfyui-workflow'
import type { ComfyBindingValue } from './comfyui-workflow'
import { MediaWorkflowValidationError } from './media-workflow-error'
import { MediaConfigStore } from './media-config-store'
import { acquireMediaFileLock } from './media-file-lock'
import { readMediaJsonFile } from './media-json-file'
import type { MediaOutputOrigin } from './media-design-assets'
import type { ComfyProgressSubscription } from './comfyui-progress-stream'
import { detectMediaFileSignature } from './media-file-probe'

/** 运行所需的协议方法；测试使用确定的边界而非真实 GPU。 */
export type MediaRunClient = Pick<ComfyUIClient, 'objectInfo' | 'uploadImage' | 'submitPrompt' | 'getQueue' | 'getHistory' | 'getOutput' | 'cancelPrompt'> & Partial<Pick<ComfyUIClient, 'uploadMedia'>>

/** Host 固化的发起来源；Agent 参数不能自行指定主体或父编排模式。 */
export interface MediaRunOrigin {
  designJobId?: string
  /** 可信画布媒体目标由 Host 填入，后台完成只挂接这一目标的候选。 */
  canvasMedia?: CanvasMediaTarget
  actor?: {
    sessionId: string
    runStartedAt: number
    mode: 'project-agent' | 'renderer-manual' | 'parent-orchestrated'
    canvasId?: string
    nodeId?: string
  }
  /** 父调度接管仍保留原准备者，避免把 child 编写归属改成父会话。 */
  preparedBy?: NonNullable<MediaRunOrigin['actor']>
}

/** Host 提供的授权、稳定素材消费与幂等产物登记边界。 */
export interface MediaRunServiceDependencies {
  configuration: MediaConfigStore
  getRunsDirectory(projectId: string): string
  authorize(projectId: string, operation: 'read' | 'prepare' | 'execute' | 'collect', origin?: MediaRunOrigin): void
  /** 固定工作流的本机输出处理能力必须在付费提交前可用。 */
  assertOutputSupport?: (workflow: MediaWorkflowDefinition) => Promise<void>
  readAsset(projectId: string, asset: MediaAssetRef): Promise<Uint8Array>
  registerOutput(projectId: string, operationId: string, bytes: Uint8Array, contentType: string | null, origin: MediaOutputOrigin): Promise<MediaAssetRef>
  createClient?: (connection: { baseUrl: string; headers: Record<string, string> }) => MediaRunClient
  onChange?: (snapshot: MediaRunSnapshot) => void
  runWorkspaceWrite?: <T>(projectId: string, effect: () => T) => T
}

/** 仅主进程读取的完整恢复事实；远端回执与固定图不进入公开任务投影。 */
interface MediaRunManifest {
  schemaVersion: 1
  driverContractVersion: 1
  snapshot: MediaRunSnapshot
  operationHash: string
  operationId: string
  connectionId: string
  instanceGeneration: string
  workflow: MediaWorkflowDefinition
  schema: ComfyObjectInfo
  schemaHash: string
  inputs: Record<string, MediaInputValue>
  uploads: Record<string, ComfyUploadResult>
  uploadPlans: Array<{ assetHash: string; filename: string; subfolder: string; state: 'planned' | 'uploaded' }>
  compiled: { prompt: ComfyPrompt; hash: string } | null
  submission: { promptId: string; requestedPromptId: string; clientId: string; requestHash: string; attemptedAt: number } | null
  collection: ComfyHistoryPrompt | null
  origin: MediaRunOrigin
  sourceRef: MediaRunSourceReference
}

/** 未发布项目工作流按不可变 revision 直接准备，不创建或伪造 profile。 */
export interface PrepareMediaDraftRunInput {
  projectId: string
  operationId: string
  connectionId: string
  workflowId: string
  workflowRevision: number
  mediaKind: MediaKind
  inputs: Record<string, MediaInputValue>
}

/** 有界 ID 防止通过工具参数跨越任务目录。 */
function assertIdentifier(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) throw new Error('MEDIA_ID_INVALID')
}

/** 恢复 JSON 必须是普通字段对象，不能靠类型断言信任磁盘内容。 */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MEDIA_RUN_INVALID')
  return value as Record<string, unknown>
}

/** 验证恢复对象的完整字段集合，避免遗漏字段被默认当成有效状态。 */
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new Error('MEDIA_RUN_INVALID')
}

/** 读取有界且可用于受管标识的字符串。 */
function identifier(value: unknown): string {
  if (typeof value !== 'string') throw new Error('MEDIA_RUN_INVALID')
  assertIdentifier(value)
  return value
}

/** 恢复整数不得接受浮点数、负数或溢出值。 */
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('MEDIA_RUN_INVALID')
  return value
}

/** 严格恢复媒体定义来源；draft 引用只接受项目配置中的受管标识。 */
function parseRunSourceReference(value: unknown): MediaRunSourceReference {
  const source = record(value)
  if (source.kind === 'profile-version') {
    keys(source, ['kind', 'profileId', 'profileRevision'])
    return { kind: 'profile-version', profileId: identifier(source.profileId),
      profileRevision: integer(source.profileRevision, 1) }
  }
  if (source.kind === 'project-draft-revision') {
    keys(source, ['kind', 'workflowId', 'workflowRevision', 'connectionId', 'mediaKind'])
    if (source.mediaKind !== 'image' && source.mediaKind !== 'audio' && source.mediaKind !== 'video') {
      throw new Error('MEDIA_RUN_INVALID')
    }
    return { kind: 'project-draft-revision', workflowId: identifier(source.workflowId),
      workflowRevision: integer(source.workflowRevision, 1), connectionId: identifier(source.connectionId),
      mediaKind: source.mediaKind }
  }
  throw new Error('MEDIA_RUN_INVALID')
}

/** 只接受完整 SHA-256，供素材、配置及请求关联校验。 */
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('MEDIA_RUN_INVALID')
  return value
}

/** 本地保存的远端路径仍需要校验，不能在恢复时扩大 view 读取范围。 */
function remoteFile(value: unknown): ComfyUploadResult {
  const item = record(value)
  keys(item, ['name', 'subfolder', 'type'])
  if (typeof item.name !== 'string' || !/^[^/\\\0]{1,255}$/.test(item.name) || ['.', '..'].includes(item.name)
    || typeof item.subfolder !== 'string' || item.subfolder.length > 1024 || /^[\\/]/.test(item.subfolder)
    || item.subfolder.split(/[\\/]/).some((part) => part === '.' || part === '..')
    || item.type !== 'input') throw new Error('MEDIA_RUN_INVALID')
  return { name: item.name, subfolder: item.subfolder, type: 'input' }
}

/** 有界复制历史 JSON；原始服务端错误文本不会进入公开快照。 */
function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 32) throw new Error('MEDIA_RUN_INVALID')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value) && value.length <= 10000) return value.map((item) => jsonValue(item, depth + 1))
  const item = record(value)
  if (Object.keys(item).length > 10000 || Object.keys(item).some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('MEDIA_RUN_INVALID')
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, jsonValue(child, depth + 1)]))
}

/** 对 JSON 图与输入使用确定排序的指纹，避免对象字段顺序影响幂等。 */
function stableHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonical(nested)]))
    return item
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

/** 严格复制输入值，保留不同槽引用同一素材的语义。 */
export function parseMediaRunInputs(value: unknown): Record<string, MediaInputValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128) throw new Error('MEDIA_INPUT_INVALID')
  const parsed: Record<string, MediaInputValue> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) throw new Error('MEDIA_INPUT_INVALID')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MEDIA_INPUT_INVALID')
    const input = raw as Record<string, unknown>
    if (input.kind === 'scalar' && Object.keys(input).length === 2
      && (typeof input.value === 'boolean' || (typeof input.value === 'string' && input.value.length <= 16384) || (typeof input.value === 'number' && Number.isFinite(input.value)))) {
      parsed[key] = { kind: 'scalar', value: input.value }
    } else if (input.kind === 'asset' && Object.keys(input).length === 2) {
      parsed[key] = { kind: 'asset', asset: parseAsset(input.asset) }
    } else throw new Error('MEDIA_INPUT_INVALID')
  }
  return parsed
}

/** 校验项目资产的确切版本与内容 hash。 */
function parseAsset(value: unknown): MediaAssetRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MEDIA_ASSET_INVALID')
  const asset = value as Record<string, unknown>
  if (Object.keys(asset).length !== 4 || typeof asset.assetId !== 'string' || !Number.isSafeInteger(asset.revision) || Number(asset.revision) < 1
    || typeof asset.hash !== 'string' || !/^[a-f0-9]{64}$/.test(asset.hash) || !['image', 'audio', 'video'].includes(String(asset.mediaKind))) throw new Error('MEDIA_ASSET_INVALID')
  assertIdentifier(asset.assetId)
  return { assetId: asset.assetId, revision: Number(asset.revision), hash: asset.hash, mediaKind: asset.mediaKind as MediaAssetRef['mediaKind'] }
}

/** 输出数组由已验证节点合同决定；视频的 history 字段也可能叫 images。 */
function mediaOutput(history: ComfyHistoryPrompt, workflow: MediaWorkflowDefinition, selector: MediaWorkflowDefinition['outputs'][number]): ComfyOutputReference {
  const classType = workflow.prompt[selector.nodeId]?.class_type
  const contract = classType ? COMFY_CORE_NODE_CONTRACTS[classType]?.historyOutput : undefined
  if (!contract || contract.mediaType !== selector.mediaType) throw new Error('MEDIA_OUTPUT_SCHEMA_UNSUPPORTED')
  const node = history.outputs[selector.nodeId]
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('MEDIA_OUTPUT_MISSING')
  const entries = node[contract.historyKey]
  if (!Array.isArray(entries)) throw new Error('MEDIA_OUTPUT_MISSING')
  const output = entries[selector.outputIndex]
  if (!output || typeof output !== 'object' || Array.isArray(output) || typeof output.filename !== 'string'
    || !/^[^/\\\0]{1,255}$/.test(output.filename) || ['.', '..'].includes(output.filename)
    || typeof output.subfolder !== 'string' || output.subfolder.length > 1024 || /^[\\/]/.test(output.subfolder)
    || output.subfolder.split(/[\\/]/).some((part) => part === '.' || part === '..')
    || !['output', 'temp'].includes(String(output.type))) throw new Error('MEDIA_OUTPUT_INVALID')
  return { filename: output.filename, subfolder: output.subfolder, type: output.type as 'output' | 'temp' }
}

/** 持久 history 允许输出缺项，但已经出现的描述符必须满足同一安全读取合同。 */
function assertPersistedOutputSafe(history: ComfyHistoryPrompt, workflow: MediaWorkflowDefinition, selector: MediaWorkflowDefinition['outputs'][number]): void {
  const classType = workflow.prompt[selector.nodeId]?.class_type
  const contract = classType ? COMFY_CORE_NODE_CONTRACTS[classType]?.historyOutput : undefined
  if (!contract || contract.mediaType !== selector.mediaType) throw new Error('MEDIA_OUTPUT_SCHEMA_UNSUPPORTED')
  const node = history.outputs[selector.nodeId]
  if (node === undefined) return
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('MEDIA_OUTPUT_INVALID')
  const entries = node[contract.historyKey]
  if (entries === undefined) return
  if (!Array.isArray(entries)) throw new Error('MEDIA_OUTPUT_INVALID')
  if (entries[selector.outputIndex] === undefined) return
  mediaOutput(history, workflow, selector)
}

/** 仅为可选标量补入固定 API 图原值；媒体入口始终要求授权素材。 */
function applyOptionalWorkflowInputs(definition: MediaWorkflowDefinition, inputs: Record<string, MediaInputValue>): void {
  for (const binding of definition.bindings) {
    if (Object.hasOwn(inputs, binding.key) || binding.field?.required !== false || !['text', 'number', 'boolean'].includes(binding.kind)) continue
    const value = definition.prompt[binding.nodeId]?.inputs[binding.input]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') inputs[binding.key] = { kind: 'scalar', value }
  }
}

/** 统一媒体任务服务，网络等待只持有对应 run 的跨进程所有权。 */
export class MediaRunService {
  /** 主进程注入的项目和协议边界。 */
  private readonly dependencies: MediaRunServiceDependencies
  /** 同进程同实例使用同一 client_id，允许一个 WS 跟踪多个 prompt。 */
  private readonly clientIds = new Map<string, string>()
  /** 任务事件只投影持久化事实，监听器不参与提交事务。 */
  private readonly listeners = new Set<(snapshot: MediaRunSnapshot) => void>()

  constructor(dependencies: MediaRunServiceDependencies) { this.dependencies = dependencies }

  /** 准备固定图与素材版本，允许读取资源目录，禁止上传或提交生成。 */
  async prepare(input: PrepareMediaRunInput, origin: MediaRunOrigin = {}): Promise<MediaRunSnapshot> {
    return this.withWorkspace(input.projectId, () => this.prepareOwned(input, origin, {
      kind: 'profile-version', profileId: input.profileId, profileRevision: input.profileRevision,
    }, () => this.dependencies.configuration.resolveProfile(input.profileId, input.profileRevision, input.projectId)))
  }

  /** 冻结公共模板或当前项目旧草稿的精确版本；不会自动创建预设。 */
  async prepareDraft(input: PrepareMediaDraftRunInput, origin: MediaRunOrigin = {}): Promise<MediaRunSnapshot> {
    return this.withWorkspace(input.projectId, () => this.prepareOwned(input, origin, {
      kind: 'project-draft-revision', workflowId: input.workflowId, workflowRevision: input.workflowRevision,
      connectionId: input.connectionId, mediaKind: input.mediaKind,
    }, () => {
      const workflow = this.dependencies.configuration.getWorkflow(input.workflowId, input.workflowRevision, input.projectId)
      if ((workflow.projectId !== null && workflow.projectId !== input.projectId) || !workflow.definition.outputs.some((output) => output.mediaType === input.mediaKind)) {
        throw new Error('MEDIA_DRAFT_OUTPUT_MISMATCH')
      }
      if (this.dependencies.configuration.read().archivedWorkflowIds?.includes(workflow.id)) throw new Error('MEDIA_WORKFLOW_ARCHIVED')
      return { ...this.dependencies.configuration.resolveConnection(input.connectionId, input.projectId), workflow }
    }))
  }

  /** 单次准备期间保护运行目录，远端排队期间不持有工作区 lease。 */
  private async prepareOwned(
    input: Pick<PrepareMediaRunInput, 'projectId' | 'operationId' | 'inputs'>,
    origin: MediaRunOrigin,
    sourceRef: MediaRunSourceReference,
    resolve: () => ReturnType<MediaConfigStore['resolveConnection']> & { workflow: { definition: MediaWorkflowDefinition } },
  ): Promise<MediaRunSnapshot> {
    assertIdentifier(input.projectId)
    assertIdentifier(input.operationId)
    this.dependencies.authorize(input.projectId, 'prepare', origin)
    const inputs = parseMediaRunInputs(input.inputs)
    const id = stableHash([input.projectId, input.operationId]).slice(0, 48)
    const directory = this.directory(input.projectId, true)
    const release = acquireMediaFileLock(join(directory, `${id}.lock`))
    try {
      const operationHash = stableHash({ projectId: input.projectId, operationId: input.operationId, sourceRef, inputs, origin })
      if (existsSync(join(directory, `${id}.json`))) {
        const existing = this.load(input.projectId, id)
        if (existing.operationHash !== operationHash) throw new Error('MEDIA_OPERATION_CONFLICT')
        return this.snapshot(existing)
      }
      const resolved = resolve()
      await this.dependencies.assertOutputSupport?.(resolved.workflow.definition)
      this.dependencies.authorize(input.projectId, 'prepare', origin)
      const client = this.client(resolved.connection.baseUrl, resolved.headers)
      const schema = await this.selectedSchema(client, resolved.workflow.definition)
      this.dependencies.authorize(input.projectId, 'prepare', origin)
      this.assertValid(resolved.workflow.definition, schema)
      const bindingKeys = new Set(resolved.workflow.definition.bindings.map((binding) => binding.key))
      if (Object.keys(inputs).some((key) => !bindingKeys.has(key))) throw new Error('MEDIA_INPUT_UNEXPECTED')
      /** 显式意图保留原样参与幂等校验，缺省值仅从同次固化的图中解析。 */
      const effectiveInputs = structuredClone(inputs)
      applyOptionalWorkflowInputs(resolved.workflow.definition, effectiveInputs)
      for (const binding of resolved.workflow.definition.bindings) {
        const value = effectiveInputs[binding.key]
        if (!value) throw new Error(`MEDIA_INPUT_REQUIRED:${binding.key}`)
        if (value.kind === 'asset') {
          if (value.asset.mediaKind !== binding.kind) throw new Error(`MEDIA_INPUT_TYPE_INVALID:${binding.key}`)
          await this.readVerifiedAsset(input.projectId, value.asset)
        } else {
          if ((binding.kind === 'text' ? 'string' : binding.kind) !== typeof value.value) throw new Error(`MEDIA_INPUT_TYPE_INVALID:${binding.key}`)
          const problem = validateMediaWorkflowFieldValue(binding, value.value)
          if (problem) throw new Error(`MEDIA_INPUT_INVALID:${binding.key}:${problem}`)
        }
      }
      const now = Date.now()
      const manifest: MediaRunManifest = { schemaVersion: 1, driverContractVersion: 1,
        snapshot: { id, projectId: input.projectId, revision: 0, phase: 'prepared', sourceRef,
          ...(sourceRef.kind === 'profile-version' ? { profileId: sourceRef.profileId, profileRevision: sourceRef.profileRevision } : {}),
          createdAt: now, updatedAt: now, outputs: [], error: null, progress: null },
        operationHash, operationId: input.operationId, connectionId: resolved.connection.id, instanceGeneration: resolved.connection.instanceGeneration,
        workflow: resolved.workflow.definition, schema, schemaHash: stableHash(schema), inputs, uploads: {}, uploadPlans: [], compiled: null, submission: null, collection: null, origin, sourceRef }
      this.save(manifest)
      return this.snapshot(manifest)
    } finally { release() }
  }

  /** 上传、编译并至多提交一次；已有提交意图只能对账。 */
  async advance(projectId: string, runId: string, expectedRevision: number): Promise<MediaRunSnapshot> {
    return this.withWorkspace(projectId, () => this.advanceOwned(projectId, runId, expectedRevision))
  }

  /** Host 父调度器接管既有准备；保持 run ID 与输入，尚未提交时只转换执行所有者。 */
  async claimPrepared(
    input: { projectId: string; runId: string; profileId: string; profileRevision: number; inputs: Record<string, MediaInputValue> },
    expectedActor: NonNullable<MediaRunOrigin['actor']>,
    nextOrigin: MediaRunOrigin,
  ): Promise<MediaRunSnapshot> {
    return this.claimPreparedSource(input, {
      kind: 'profile-version', profileId: input.profileId, profileRevision: input.profileRevision,
    }, expectedActor, nextOrigin)
  }

  /** 父调度接管 child 固化的项目草稿运行，不要求发布 profile。 */
  async claimPreparedDraft(
    input: Pick<PrepareMediaDraftRunInput, 'projectId' | 'workflowId' | 'workflowRevision' | 'connectionId' | 'mediaKind' | 'inputs'> & { runId: string },
    expectedActor: NonNullable<MediaRunOrigin['actor']>,
    nextOrigin: MediaRunOrigin,
  ): Promise<MediaRunSnapshot> {
    return this.claimPreparedSource(input, {
      kind: 'project-draft-revision', workflowId: input.workflowId, workflowRevision: input.workflowRevision,
      connectionId: input.connectionId, mediaKind: input.mediaKind,
    }, expectedActor, nextOrigin)
  }

  /** 两类定义来源共享同一接管事务和 actor 校验。 */
  private async claimPreparedSource(
    input: { projectId: string; runId: string; inputs: Record<string, MediaInputValue> },
    sourceRef: MediaRunSourceReference,
    expectedActor: NonNullable<MediaRunOrigin['actor']>,
    nextOrigin: MediaRunOrigin,
  ): Promise<MediaRunSnapshot> {
    return this.withWorkspace(input.projectId, () => {
      this.dependencies.authorize(input.projectId, 'execute', nextOrigin)
      const release = acquireMediaFileLock(join(this.directory(input.projectId), `${this.id(input.runId)}.lock`))
      try {
        const manifest = this.load(input.projectId, input.runId)
        const inputs = parseMediaRunInputs(input.inputs)
        if (expectedActor.mode !== 'parent-orchestrated' || nextOrigin.actor?.mode !== 'project-agent'
          || !nextOrigin.canvasMedia || nextOrigin.preparedBy || nextOrigin.designJobId
          || stableHash(manifest.sourceRef) !== stableHash(sourceRef)
          || stableHash(manifest.inputs) !== stableHash(inputs)
          || stableHash(manifest.origin.canvasMedia ?? null) !== stableHash(nextOrigin.canvasMedia)) {
          throw new Error('MEDIA_PREPARED_HANDOFF_INVALID')
        }
        const claimedOrigin: MediaRunOrigin = { ...structuredClone(nextOrigin), preparedBy: structuredClone(expectedActor) }
        if (stableHash(manifest.origin) === stableHash(claimedOrigin)) return this.snapshot(manifest)
        if (manifest.snapshot.phase !== 'prepared' || manifest.submission || manifest.origin.preparedBy
          || stableHash(manifest.origin.actor ?? null) !== stableHash(expectedActor)) throw new Error('MEDIA_PREPARED_HANDOFF_INVALID')
        manifest.origin = claimedOrigin
        manifest.operationHash = stableHash({ projectId: input.projectId, operationId: manifest.operationId,
          sourceRef, inputs, origin: claimedOrigin })
        this.save(manifest)
        return this.snapshot(manifest)
      } finally { release() }
    })
  }

  /** 上传与提交事务期间阻止迁移复制尚未释放的跨进程 run 所有权。 */
  private async advanceOwned(projectId: string, runId: string, expectedRevision: number): Promise<MediaRunSnapshot> {
    this.dependencies.authorize(projectId, 'execute')
    const release = acquireMediaFileLock(join(this.directory(projectId), `${this.id(runId)}.lock`))
    try {
      const manifest = this.load(projectId, runId)
      this.dependencies.authorize(projectId, 'execute', manifest.origin)
      if (manifest.snapshot.revision !== expectedRevision) throw new Error('MEDIA_RUN_CONFLICT')
      if (manifest.submission || ['succeeded', 'cancelled', 'failed'].includes(manifest.snapshot.phase)) return this.snapshot(manifest)
      await this.dependencies.assertOutputSupport?.(manifest.workflow)
      this.dependencies.authorize(projectId, 'execute', manifest.origin)
      const client = this.resolveClient(manifest)
      const schema = await this.selectedSchema(client, manifest.workflow)
      this.dependencies.authorize(projectId, 'execute', manifest.origin)
      if (stableHash(schema) !== manifest.schemaHash) throw new Error('MEDIA_SCHEMA_CHANGED')
      this.assertValid(manifest.workflow, schema)
      try {
        manifest.snapshot.phase = 'uploading'
        this.save(manifest)
        const values: Record<string, ComfyBindingValue> = {}
        /** 恢复依赖任务内的固定图，不回查当前公共模板。 */
        const effectiveInputs = structuredClone(manifest.inputs)
        applyOptionalWorkflowInputs(manifest.workflow, effectiveInputs)
        const verifiedReceipts = new Set<string>()
        for (const binding of manifest.workflow.bindings) {
          const input = effectiveInputs[binding.key]!
          if (input.kind === 'scalar') {
            if (!['text', 'number', 'boolean'].includes(binding.kind)) throw new Error('MEDIA_INPUT_INVALID')
            values[binding.key] = { kind: binding.kind as 'text' | 'number' | 'boolean', value: input.value }
            continue
          }
          const bytes = await this.readVerifiedAsset(projectId, input.asset)
          // 同次多槽复用回执；恢复时先核验原回执或已持久化上传计划。
          const cacheKey = stableHash(input.asset)
          let receipt = manifest.uploads[cacheKey]
          if (receipt && !verifiedReceipts.has(cacheKey)) {
            try {
              const remote = await client.getOutput({ filename: receipt.name, subfolder: receipt.subfolder, type: receipt.type })
              if (createHash('sha256').update(remote.bytes).digest('hex') !== input.asset.hash) receipt = undefined
            } catch (error) {
              if (!(error instanceof ComfyUIError && error.status === 404)) throw error
              receipt = undefined
            }
          }
          if (!receipt) {
            this.dependencies.authorize(projectId, 'execute', manifest.origin)
            let plan = manifest.uploadPlans.findLast((item) => item.assetHash === input.asset.hash && item.state === 'planned')
            if (plan) {
              try {
                const remote = await client.getOutput({ filename: plan.filename, subfolder: plan.subfolder, type: 'input' })
                if (createHash('sha256').update(remote.bytes).digest('hex') !== input.asset.hash) throw new Error('MEDIA_UPLOAD_IDENTITY_CONFLICT')
                receipt = { name: plan.filename, subfolder: plan.subfolder, type: 'input' }
              } catch (error) {
                // 只有明确不存在才能重传；断线或权限错误不能被解释为缺失。
                if (!(error instanceof ComfyUIError && error.status === 404)) throw error
              }
            } else {
              if (manifest.uploadPlans.length >= 128) throw new Error('MEDIA_UPLOAD_ATTEMPT_LIMIT')
              plan = { assetHash: input.asset.hash, filename: `${randomUUID()}${detectMediaFileSignature(bytes).extension}`, subfolder: `proma/${runId}`, state: 'planned' }
              manifest.uploadPlans.push(plan)
              this.save(manifest)
            }
            if (!receipt) {
              const media = new Blob([new Uint8Array(bytes)])
              if (client.uploadMedia) receipt = await client.uploadMedia({ media, filename: plan.filename, subfolder: plan.subfolder, overwrite: false })
              else if (input.asset.mediaKind === 'image') receipt = await client.uploadImage({ image: media, filename: plan.filename, subfolder: plan.subfolder, overwrite: false })
              else throw new Error('MEDIA_UPLOAD_UNSUPPORTED')
            }
            plan.state = 'uploaded'
            manifest.uploads[cacheKey] = receipt
            this.save(manifest)
          }
          verifiedReceipts.add(cacheKey)
          values[binding.key] = { kind: input.asset.mediaKind, upload: receipt }
        }
        manifest.snapshot.phase = 'compiling'
        this.save(manifest)
        const compiled = compileComfyWorkflow(manifest.workflow, values, schema)
        manifest.compiled = { prompt: compiled.prompt, hash: stableHash(compiled.prompt) }
        this.dependencies.authorize(projectId, 'execute', manifest.origin)
        this.resolveClient(manifest)
        const requestedPromptId = randomUUID()
        const connectionKey = `${manifest.connectionId}:${manifest.instanceGeneration}`
        const clientId = this.clientIds.get(connectionKey) ?? randomUUID()
        this.clientIds.set(connectionKey, clientId)
        manifest.submission = { promptId: requestedPromptId, requestedPromptId, clientId, requestHash: manifest.compiled.hash, attemptedAt: Date.now() }
        manifest.snapshot.phase = 'submitting'
        this.save(manifest)
        try {
          const accepted = await client.submitPrompt(compiled.prompt, { promptId: manifest.submission.promptId, clientId: manifest.submission.clientId })
          manifest.submission.promptId = accepted.promptId
          manifest.snapshot.phase = 'queued'
          manifest.snapshot.error = null
        } catch (error) {
          const rejected = error instanceof ComfyUIError && error.kind === 'validation-rejected'
          manifest.snapshot.phase = rejected ? 'failed' : 'submission-unknown'
          manifest.snapshot.error = rejected ? 'MEDIA_SUBMISSION_REJECTED' : 'MEDIA_SUBMISSION_UNKNOWN'
        }
        this.save(manifest)
      } catch (error) {
        if (manifest.submission) {
          // 写入 intent 后任何异常都不能恢复为可重投状态。
          manifest.snapshot.phase = 'submission-unknown'
          manifest.snapshot.error = 'MEDIA_SUBMISSION_UNKNOWN'
        } else {
          manifest.snapshot.error = 'MEDIA_PREPARATION_FAILED'
        }
        this.save(manifest)
        if (!manifest.submission) throw error
      }
      return this.snapshot(manifest)
    } finally { release() }
  }

  /** 查询权威 history/queue 并幂等收集，缺失历史不意味着从未提交。 */
  async reconcile(projectId: string, runId: string): Promise<MediaRunSnapshot> {
    return this.withWorkspace(projectId, () => this.reconcileOwned(projectId, runId))
  }

  /** 对账结束即释放项目 lease，下一次轮询前允许正常项目操作。 */
  private async reconcileOwned(projectId: string, runId: string): Promise<MediaRunSnapshot> {
    this.dependencies.authorize(projectId, 'read')
    const release = acquireMediaFileLock(join(this.directory(projectId), `${this.id(runId)}.lock`))
    try {
      const manifest = this.load(projectId, runId)
      if (!manifest.submission || ['succeeded', 'cancelled', 'failed'].includes(manifest.snapshot.phase)) return this.snapshot(manifest)
      const client = this.resolveClient(manifest)
      const history = manifest.collection ?? await client.getHistory(manifest.submission.promptId)
      if (!history) {
        const queue = await client.getQueue(manifest.submission.promptId)
        const state = queue && 'state' in queue ? queue.state : null
        if (queue && 'raw' in queue) this.assertRemoteOwnership(manifest, queue.raw)
        if (state) {
          manifest.snapshot.phase = state === 'running' ? 'running' : 'queued'
          manifest.snapshot.error = null
        } else if (manifest.snapshot.phase !== 'cancel-requested') {
          manifest.snapshot.phase = 'submission-unknown'
          manifest.snapshot.error = 'MEDIA_SUBMISSION_UNKNOWN'
        }
        this.save(manifest)
        return this.snapshot(manifest)
      }
      this.assertRemoteOwnership(manifest, history.prompt)
      const status = history.status
      if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('MEDIA_HISTORY_STATUS_UNKNOWN')
      if (status.status_str === 'error') {
        manifest.snapshot.phase = 'failed'
        manifest.snapshot.error = 'MEDIA_REMOTE_EXECUTION_FAILED'
        this.save(manifest)
        return this.snapshot(manifest)
      }
      if (status.completed !== true || status.status_str !== 'success') return this.snapshot(manifest)
      this.assertSuccessfulCollection(manifest, history)
      manifest.collection = history
      manifest.snapshot.phase = 'collecting'
      manifest.snapshot.error = null
      manifest.snapshot.progress = null
      this.save(manifest)
      try {
        for (const output of manifest.workflow.outputs) {
          if (manifest.snapshot.outputs.some((item) => item.outputKey === output.key && item.index === output.outputIndex)) continue
          const descriptor = mediaOutput(history, manifest.workflow, output)
          const content = await client.getOutput(descriptor)
          this.dependencies.authorize(projectId, 'collect', manifest.origin)
          const asset = parseAsset(await this.dependencies.registerOutput(projectId, `${runId}:${output.key}:${output.outputIndex}`, content.bytes, content.contentType,
            { mediaRunId: runId, ...(manifest.origin.designJobId ? { designJobId: manifest.origin.designJobId } : {}),
              ...(manifest.origin.actor ? { sourceSessionId: manifest.origin.actor.sessionId } : {}) }))
          if (asset.mediaKind !== output.mediaType) throw new Error('MEDIA_OUTPUT_TYPE_MISMATCH')
          manifest.snapshot.outputs.push({ outputKey: output.key, index: output.outputIndex, asset })
          this.save(manifest)
        }
        manifest.snapshot.phase = 'succeeded'
        manifest.snapshot.error = null
      } catch {
        manifest.snapshot.phase = 'collection-failed'
        manifest.snapshot.error = 'MEDIA_OUTPUT_COLLECTION_FAILED'
      }
      this.save(manifest)
      return this.snapshot(manifest)
    } finally { release() }
  }

  /** 读取当前公开快照，不触发远端请求。 */
  get(projectId: string, runId: string): MediaRunSnapshot {
    this.dependencies.authorize(projectId, 'read')
    return this.snapshot(this.load(projectId, runId))
  }

  /** 仅可信 Host 读取运行时固化的 typed inputs；返回副本避免调用方改写持久事实。 */
  getInputs(projectId: string, runId: string): Record<string, MediaInputValue> {
    this.dependencies.authorize(projectId, 'read')
    return structuredClone(this.load(projectId, runId).inputs)
  }

  /** 仅可信 Host 读取已冻结定义来源。 */
  getSourceRef(projectId: string, runId: string): MediaRunSourceReference {
    this.dependencies.authorize(projectId, 'read')
    return structuredClone(this.load(projectId, runId).sourceRef)
  }

  /** 仅可信 Host 读取已冻结输出合同，不重新解析当前项目草稿。 */
  getWorkflowDefinition(projectId: string, runId: string): MediaWorkflowDefinition {
    this.dependencies.authorize(projectId, 'read')
    return structuredClone(this.load(projectId, runId).workflow)
  }

  /** Host 按既有操作身份定位运行，恢复时无需重新读取当前工作流或输入。 */
  findOperation(projectId: string, operationId: string): MediaRunSnapshot | null {
    this.dependencies.authorize(projectId, 'read')
    assertIdentifier(operationId)
    const runId = stableHash([projectId, operationId]).slice(0, 48)
    if (!existsSync(join(this.directory(projectId), `${runId}.json`))) return null
    return this.get(projectId, runId)
  }

  /** 仅可信 Host 用于完成已登记的 Job，不对模型公开内部任务归属。 */
  getOrigin(projectId: string, runId: string): MediaRunManifest['origin'] {
    this.dependencies.authorize(projectId, 'read')
    return { ...this.load(projectId, runId).origin }
  }

  /** 监督器订阅持久化变化，不触发网络或额外生成。 */
  subscribe(listener: (snapshot: MediaRunSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 只向主进程监督器提供固定远端身份，禁止经 IPC 或工具直接返回。 */
  getWatchTarget(projectId: string, runId: string): (ComfyProgressSubscription & { promptId: string }) | null {
    this.dependencies.authorize(projectId, 'read')
    const manifest = this.load(projectId, runId)
    if (!manifest.submission || ['succeeded', 'failed', 'cancelled'].includes(manifest.snapshot.phase)) return null
    const resolved = this.dependencies.configuration.resolveConnectionVersion(manifest.connectionId, manifest.instanceGeneration)
    return { connectionId: manifest.connectionId, instanceGeneration: manifest.instanceGeneration, baseUrl: resolved.connection.baseUrl,
      headers: resolved.headers, clientId: manifest.submission.clientId, promptId: manifest.submission.promptId }
  }

  /** 仅接受原 prompt 已知节点的采样计数；不推算总任务百分比。 */
  recordProgress(projectId: string, runId: string, promptId: string, progress: NonNullable<MediaRunSnapshot['progress']>): void {
    this.dependencies.authorize(projectId, 'read')
    const release = acquireMediaFileLock(join(this.directory(projectId), `${this.id(runId)}.lock`))
    try {
      const manifest = this.load(projectId, runId)
      if (manifest.submission?.promptId !== promptId || !['queued', 'running', 'cancel-requested'].includes(manifest.snapshot.phase)) return
      this.resolveClient(manifest)
      if (!manifest.workflow.prompt[progress.nodeId] || !Number.isSafeInteger(progress.value) || !Number.isSafeInteger(progress.max)
        || progress.value < 0 || progress.max <= 0 || progress.value > progress.max) return
      manifest.snapshot.progress = { ...progress }
      if (manifest.snapshot.phase !== 'cancel-requested') manifest.snapshot.phase = 'running'
      this.save(manifest)
    } finally { release() }
  }

  /** 启动只扫描项目受管运行索引；坏记录逐项隔离且不触发重新提交。 */
  listRecoverable(projectId: string): MediaRunSnapshot[] {
    this.dependencies.authorize(projectId, 'read')
    const snapshots: MediaRunSnapshot[] = []
    const directory = this.directory(projectId)
    if (!existsSync(directory)) return snapshots
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{48}\.json$/.test(name)) continue
      try {
        const manifest = this.load(projectId, name.slice(0, -5))
        if (manifest.submission && !['succeeded', 'failed', 'cancelled'].includes(manifest.snapshot.phase)) snapshots.push(this.snapshot(manifest))
      } catch { /* 损坏记录不阻断其它已提交任务恢复；显式读取时继续报错。 */ }
    }
    return snapshots.sort((left, right) => left.createdAt - right.createdAt)
  }

  /** 本地任务直接取消；远端排队只定向删除，运行中不调用全局 interrupt。 */
  async cancel(projectId: string, runId: string): Promise<MediaRunSnapshot> {
    return this.withWorkspace(projectId, () => this.cancelOwned(projectId, runId))
  }

  /** 定向取消与本地阶段更新在同一个项目迁移保护范围内。 */
  private async cancelOwned(projectId: string, runId: string): Promise<MediaRunSnapshot> {
    this.dependencies.authorize(projectId, 'execute')
    const release = acquireMediaFileLock(join(this.directory(projectId), `${this.id(runId)}.lock`))
    try {
      const manifest = this.load(projectId, runId)
      this.dependencies.authorize(projectId, 'execute', manifest.origin)
      if (['succeeded', 'failed', 'cancelled'].includes(manifest.snapshot.phase)) return this.snapshot(manifest)
      if (!manifest.submission) {
        manifest.snapshot.phase = 'cancelled'
        manifest.snapshot.error = null
        this.save(manifest)
        return this.snapshot(manifest)
      }
      const client = this.resolveClient(manifest)
      const queued = await client.getQueue(manifest.submission.promptId)
      if (!queued || !('state' in queued) || queued.state !== 'pending') throw new Error('MEDIA_PRECISE_CANCEL_UNSUPPORTED')
      this.assertRemoteOwnership(manifest, queued.raw)
      manifest.snapshot.phase = 'cancel-requested'
      manifest.snapshot.error = 'MEDIA_CANCEL_UNCONFIRMED'
      this.save(manifest)
      await client.cancelPrompt(manifest.submission.promptId)
      // 队列删除与开始执行可能竞态，删除响应本身不能证明任务已经取消。
      return this.snapshot(manifest)
    } finally { release() }
  }

  /** queue/history 的官方 tuple 必须与原图及 client_id 一致，才能消费或取消。 */
  private assertRemoteOwnership(manifest: MediaRunManifest, value: unknown): void {
    if (!manifest.submission || !Array.isArray(value) || value.length < 4 || value[1] !== manifest.submission.promptId
      || stableHash(value[2]) !== manifest.submission.requestHash || !value[3] || typeof value[3] !== 'object'
      || (value[3] as Record<string, unknown>).client_id !== manifest.submission.clientId) throw new Error('MEDIA_REMOTE_OWNERSHIP_UNPROVEN')
  }

  /** 成功 history 必须证明原提交身份；缺项可持久化，已有输出描述符必须安全。 */
  private assertSuccessfulCollection(manifest: MediaRunManifest, history: ComfyHistoryPrompt): void {
    const status = record(history.status)
    if (!manifest.submission || history.promptId !== manifest.submission.promptId
      || status.completed !== true || status.status_str !== 'success') throw new Error('MEDIA_RUN_INVALID')
    this.assertRemoteOwnership(manifest, history.prompt)
    for (const output of manifest.workflow.outputs) assertPersistedOutputSafe(history, manifest.workflow, output)
  }

  /** 为一次请求构造敏感数据只留在内存的客户端。 */
  private client(baseUrl: string, headers: Record<string, string>): MediaRunClient {
    return this.dependencies.createClient?.({ baseUrl, headers }) ?? new ComfyUIClient({ baseUrl, headers, maxOutputBytes: 128 * 1024 * 1024 })
  }

  /** 恢复始终连接原实例；替换端点不能重用历史 prompt_id。 */
  private resolveClient(manifest: MediaRunManifest): MediaRunClient {
    const resolved = this.dependencies.configuration.resolveConnectionVersion(manifest.connectionId, manifest.instanceGeneration)
    return this.client(resolved.connection.baseUrl, resolved.headers)
  }

  /**
   * 仅查询当前图使用的节点接口；并发、总时长和累计 schema 体积均有界。
   * @param client 固定到本次连接身份的客户端。
   * @param workflow 已解析的工作流；同类节点只查询一次。
   * @returns 完整相关 schema，任一请求失败则取消并等待所有在途读取结束。
   */
  private async selectedSchema(client: MediaRunClient, workflow: MediaWorkflowDefinition): Promise<ComfyObjectInfo> {
    /** 按图中出现顺序去重，保持历史 schema 序列稳定。 */
    const names = [...new Set(Object.values(workflow.prompt).map((node) => node.class_type))]
    /** 各读取协程仅写入自身 class 对应的结果。 */
    const selected: ComfyObjectInfo = {}
    /** 任一失败和整体截止时间共用取消信号。 */
    const controller = new AbortController()
    /** 下一个待查询 class；同步递增不会重复分配。 */
    let nextIndex = 0
    /** 累计保留的 schema 不超过原完整 JSON 响应的默认体积。 */
    let schemaBytes = 0
    /** 保留首个业务异常，避免后续取消掩盖认证或接口错误。 */
    let failure: { error: unknown } | undefined
    /** 多类查询整体沿用原单次目录读取的三十秒预算。 */
    const deadline = setTimeout(() => controller.abort(new ComfyUIError('timeout', 'ComfyUI 节点接口读取超时')), 30_000)
    /** 单个协程顺序领取节点类型，失败后不再发起后继请求。 */
    const readNext = async (): Promise<void> => {
      try {
        while (!controller.signal.aborted) {
          /** 本协程当前领取的 class。 */
          const name = names[nextIndex++]
          if (name === undefined) return
          /** 请求路径由生产客户端编码，保留代理前缀、认证与响应体限制。 */
          const response = await client.objectInfo(name, { signal: controller.signal })
          controller.signal.throwIfAborted()
          if (!Object.hasOwn(response, name)) continue
          /** 缺失类交由工作流校验生成具体节点诊断；已有类必须完整保留。 */
          const schema = structuredClone(response[name]!)
          schemaBytes += Buffer.byteLength(JSON.stringify(schema), 'utf8')
          if (schemaBytes > 8 * 1024 * 1024) throw new ComfyUIError('size-limit', '工作流节点接口总大小超出限制')
          selected[name] = schema
        }
      } catch (error) {
        failure ??= { error }
        controller.abort(error)
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(4, names.length) }, () => readNext()))
      if (failure) throw failure.error
      controller.signal.throwIfAborted()
    } finally { clearTimeout(deadline) }
    return Object.fromEntries(names.filter((name) => Object.hasOwn(selected, name)).map((name) => {
      /** 仅擦除动态上传目录值，其他 schema 继续参与准备/执行一致性检查。 */
      const schema = selected[name]!
      const input = COMFY_CORE_NODE_CONTRACTS[name]?.resourceInput?.input
      if (input) {
        // 已上传文件目录是动态资源事实，不能把别的上传误判为 Loader schema 升级。
        for (const fields of [schema.input.required, schema.input.optional ?? {}]) {
          const field = fields[input]
          if (!field) continue
          if (Array.isArray(field[0])) field[0] = []
          if (field[1]) delete field[1].default
        }
      }
      return [name, schema]
    }))
  }

  /** 静态未适配或不兼容问题必须发生在上传之前。 */
  private assertValid(workflow: MediaWorkflowDefinition, schema: ComfyObjectInfo): void {
    const validation = validateComfyWorkflow(workflow, schema)
    if (!validation.valid) throw new MediaWorkflowValidationError(validation.issues)
  }

  /** 素材读取依赖 Host 的稳定文件身份授权，再对实际内容复验 hash。 */
  private async readVerifiedAsset(projectId: string, asset: MediaAssetRef): Promise<Uint8Array> {
    const bytes = await this.dependencies.readAsset(projectId, asset)
    if (bytes.byteLength > (asset.mediaKind === 'image' ? 64 : 128) * 1024 * 1024) throw new Error('MEDIA_INPUT_SIZE_LIMIT')
    if (createHash('sha256').update(bytes).digest('hex') !== asset.hash) throw new Error('MEDIA_ASSET_CHANGED')
    const signature = detectMediaFileSignature(bytes)
    if (signature.mediaKind && signature.mediaKind !== asset.mediaKind) throw new Error('MEDIA_INPUT_TYPE_INVALID')
    return bytes
  }

  /** 从 Host 的项目解析器取得任务目录，不接受调用方任意路径。 */
  private directory(projectId: string, create = false): string {
    assertIdentifier(projectId)
    const directory = this.dependencies.getRunsDirectory(projectId)
    if (create) {
      const effect = (): void => { mkdirSync(directory, { recursive: true, mode: 0o700 }) }
      if (this.dependencies.runWorkspaceWrite) this.dependencies.runWorkspaceWrite(projectId, effect)
      else effect()
    }
    return directory
  }

  /** 任务 ID 只接受本服务派生的固定 hash。 */
  private id(runId: string): string {
    if (!/^[a-f0-9]{48}$/.test(runId)) throw new Error('MEDIA_RUN_ID_INVALID')
    return runId
  }

  /** 短阶段事务复用已有迁移 lease，跨次远端等待不占用该 lease。 */
  private withWorkspace<T>(projectId: string, effect: () => T): T {
    return this.dependencies.runWorkspaceWrite ? this.dependencies.runWorkspaceWrite(projectId, effect) : effect()
  }

  /** 有界读取恢复记录并验证图、输入与提交 hash 的关联。 */
  private load(projectId: string, runId: string): MediaRunManifest {
    const value = record(readMediaJsonFile(join(this.directory(projectId), `${this.id(runId)}.json`), 16 * 1024 * 1024))
    keys(value, ['schemaVersion', 'driverContractVersion', 'snapshot', 'operationHash', 'operationId', 'connectionId', 'instanceGeneration', 'workflow', 'schema', 'schemaHash', 'inputs', 'uploads', 'uploadPlans', 'compiled', 'submission', 'collection', 'origin'], ['sourceRef'])
    if (value.schemaVersion !== 1 || value.driverContractVersion !== 1) throw new Error('MEDIA_RUN_INVALID')
    const rawSnapshot = record(value.snapshot)
    keys(rawSnapshot, ['id', 'projectId', 'revision', 'phase', 'createdAt', 'updatedAt', 'outputs', 'error', 'progress'], ['sourceRef', 'profileId', 'profileRevision'])
    const phases: MediaRunPhase[] = ['prepared', 'uploading', 'compiling', 'submitting', 'submission-unknown', 'queued', 'running', 'collecting', 'collection-failed', 'succeeded', 'failed', 'cancel-requested', 'cancelled']
    if (rawSnapshot.id !== runId || rawSnapshot.projectId !== projectId || !phases.includes(rawSnapshot.phase as MediaRunPhase)
      || (rawSnapshot.error !== null && (typeof rawSnapshot.error !== 'string' || !/^MEDIA_[A-Z_]{1,100}$/.test(rawSnapshot.error)))) throw new Error('MEDIA_RUN_INVALID')
    const workflow = parseMediaWorkflowDefinition(value.workflow)
    const schema = parseComfyObjectInfo(value.schema)
    const inputs = parseMediaRunInputs(value.inputs)
    const originValue = record(value.origin)
    keys(originValue, [], ['designJobId', 'actor', 'canvasMedia', 'preparedBy'])
    const origin: MediaRunOrigin = Object.hasOwn(originValue, 'designJobId') ? { designJobId: identifier(originValue.designJobId) } : {}
    if (originValue.canvasMedia !== undefined) {
      origin.canvasMedia = parseCanvasMediaTarget(originValue.canvasMedia)
      if (origin.canvasMedia.projectId !== projectId || origin.designJobId) throw new Error('MEDIA_RUN_INVALID')
    }
    for (const actorField of ['actor', 'preparedBy'] as const) {
      if (originValue[actorField] === undefined) continue
      const actor = record(originValue[actorField])
      keys(actor, ['sessionId', 'runStartedAt', 'mode'], ['canvasId', 'nodeId'])
      if (actor.mode !== 'project-agent' && actor.mode !== 'renderer-manual' && actor.mode !== 'parent-orchestrated') throw new Error('MEDIA_RUN_INVALID')
      if ((actor.mode === 'project-agent') !== (actor.canvasId === undefined && actor.nodeId === undefined)
        || (actor.mode !== 'project-agent' && (actor.canvasId === undefined || actor.nodeId === undefined))) throw new Error('MEDIA_RUN_INVALID')
      origin[actorField] = { sessionId: identifier(actor.sessionId), runStartedAt: integer(actor.runStartedAt, 1), mode: actor.mode,
        ...(actor.canvasId === undefined ? {} : { canvasId: identifier(actor.canvasId), nodeId: identifier(actor.nodeId) }) }
    }
    if (origin.preparedBy && (origin.preparedBy.mode !== 'parent-orchestrated' || origin.actor?.mode !== 'project-agent' || !origin.canvasMedia)) {
      throw new Error('MEDIA_RUN_INVALID')
    }
    const legacySourceRef: MediaRunSourceReference | null = value.sourceRef === undefined
      ? { kind: 'profile-version', profileId: identifier(rawSnapshot.profileId), profileRevision: integer(rawSnapshot.profileRevision, 1) }
      : null
    const sourceRef = legacySourceRef ?? parseRunSourceReference(value.sourceRef)
    if (rawSnapshot.sourceRef !== undefined && stableHash(parseRunSourceReference(rawSnapshot.sourceRef)) !== stableHash(sourceRef)) {
      throw new Error('MEDIA_RUN_INVALID')
    }
    if ((sourceRef.kind === 'profile-version'
        && (rawSnapshot.profileId !== sourceRef.profileId || rawSnapshot.profileRevision !== sourceRef.profileRevision))
      || (sourceRef.kind === 'project-draft-revision'
        && (rawSnapshot.profileId !== undefined || rawSnapshot.profileRevision !== undefined))) throw new Error('MEDIA_RUN_INVALID')
    const snapshot: MediaRunSnapshot = { id: runId, projectId, revision: integer(rawSnapshot.revision, 1), phase: rawSnapshot.phase as MediaRunPhase,
      sourceRef, ...(sourceRef.kind === 'profile-version' ? { profileId: sourceRef.profileId, profileRevision: sourceRef.profileRevision } : {}),
      createdAt: integer(rawSnapshot.createdAt, 1), updatedAt: integer(rawSnapshot.updatedAt, 1),
      outputs: [], error: rawSnapshot.error as string | null, progress: null }
    if (snapshot.updatedAt < snapshot.createdAt || !Array.isArray(rawSnapshot.outputs) || rawSnapshot.outputs.length > workflow.outputs.length) throw new Error('MEDIA_RUN_INVALID')
    const outputKeys = new Set<string>()
    for (const rawOutput of rawSnapshot.outputs) {
      const output = record(rawOutput)
      keys(output, ['outputKey', 'index', 'asset'])
      const index = integer(output.index)
      const selector = workflow.outputs.find((item) => item.key === output.outputKey && item.outputIndex === index)
      const asset = parseAsset(output.asset)
      if (!selector || asset.mediaKind !== selector.mediaType || outputKeys.has(selector.key)) throw new Error('MEDIA_RUN_INVALID')
      outputKeys.add(selector.key)
      snapshot.outputs.push({ outputKey: selector.key, index, asset })
    }
    if (rawSnapshot.progress !== null) {
      const progress = record(rawSnapshot.progress)
      keys(progress, ['nodeId', 'value', 'max'])
      const nodeId = identifier(progress.nodeId)
      const count = integer(progress.value)
      const max = integer(progress.max, 1)
      if (!workflow.prompt[nodeId] || count > max) throw new Error('MEDIA_RUN_INVALID')
      snapshot.progress = { nodeId, value: count, max }
    }
    const uploads: Record<string, ComfyUploadResult> = {}
    const assetHashes = new Set(Object.values(inputs).filter((item) => item.kind === 'asset').map((item) => item.asset.hash))
    const assetKeys = new Set(Object.values(inputs).filter((item) => item.kind === 'asset').map((item) => stableHash(item.asset)))
    for (const [key, receipt] of Object.entries(record(value.uploads))) {
      if (!assetKeys.has(key)) throw new Error('MEDIA_RUN_INVALID')
      uploads[key] = remoteFile(receipt)
    }
    if (!Array.isArray(value.uploadPlans) || value.uploadPlans.length > 128) throw new Error('MEDIA_RUN_INVALID')
    const uploadPlans: MediaRunManifest['uploadPlans'] = value.uploadPlans.map((raw) => {
      const plan = record(raw)
      keys(plan, ['assetHash', 'filename', 'subfolder', 'state'])
      const assetHash = hash(plan.assetHash)
      const file = remoteFile({ name: plan.filename, subfolder: plan.subfolder, type: 'input' })
      if (!assetHashes.has(assetHash) || file.subfolder !== `proma/${runId}` || (plan.state !== 'planned' && plan.state !== 'uploaded')) throw new Error('MEDIA_RUN_INVALID')
      return { assetHash, filename: file.name, subfolder: file.subfolder, state: plan.state }
    })
    let compiled: MediaRunManifest['compiled'] = null
    if (value.compiled !== null) {
      const item = record(value.compiled)
      keys(item, ['prompt', 'hash'])
      compiled = { prompt: parseComfyPrompt(item.prompt), hash: hash(item.hash) }
      if (stableHash(compiled.prompt) !== compiled.hash) throw new Error('MEDIA_RUN_INVALID')
    }
    let submission: MediaRunManifest['submission'] = null
    if (value.submission !== null) {
      const item = record(value.submission)
      keys(item, ['promptId', 'requestedPromptId', 'clientId', 'requestHash', 'attemptedAt'])
      submission = { promptId: identifier(item.promptId), requestedPromptId: identifier(item.requestedPromptId), clientId: identifier(item.clientId), requestHash: hash(item.requestHash), attemptedAt: integer(item.attemptedAt, 1) }
      if (submission.requestHash !== compiled?.hash) throw new Error('MEDIA_RUN_INVALID')
    }
    const manifest: MediaRunManifest = { schemaVersion: 1, driverContractVersion: 1, snapshot, operationId: identifier(value.operationId), operationHash: hash(value.operationHash),
      connectionId: identifier(value.connectionId), instanceGeneration: identifier(value.instanceGeneration), workflow, schema, schemaHash: hash(value.schemaHash), inputs, uploads, uploadPlans, compiled, submission, collection: null, origin, sourceRef }
    if (stableHash(schema) !== manifest.schemaHash || stableHash([projectId, manifest.operationId]).slice(0, 48) !== runId
      || (legacySourceRef
        ? stableHash({ projectId, operationId: manifest.operationId, profileId: snapshot.profileId, profileRevision: snapshot.profileRevision, inputs, origin })
        : stableHash({ projectId, operationId: manifest.operationId, sourceRef, inputs, origin })) !== manifest.operationHash) throw new Error('MEDIA_RUN_INVALID')
    if (value.collection !== null) {
      const collection = record(value.collection)
      keys(collection, ['promptId', 'prompt', 'outputs'], ['status'])
      const outputs = jsonValue(record(collection.outputs))
      if (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) throw new Error('MEDIA_RUN_INVALID')
      const status = record(collection.status)
      if (status.completed !== true || status.status_str !== 'success' || collection.promptId !== submission?.promptId) throw new Error('MEDIA_RUN_INVALID')
      manifest.collection = { promptId: identifier(collection.promptId), prompt: jsonValue(collection.prompt), outputs, status: jsonValue(status) }
      this.assertSuccessfulCollection(manifest, manifest.collection)
    }
    if ((['prepared', 'uploading', 'compiling'].includes(snapshot.phase) && submission)
      || (['submitting', 'submission-unknown', 'queued', 'running', 'collecting', 'collection-failed', 'succeeded', 'cancel-requested'].includes(snapshot.phase) && !submission)
      || (['collecting', 'collection-failed', 'succeeded'].includes(snapshot.phase) && !manifest.collection)
      || (snapshot.outputs.length > 0 && !manifest.collection)
      || (snapshot.phase === 'succeeded' && snapshot.outputs.length !== workflow.outputs.length)) throw new Error('MEDIA_RUN_INVALID')
    return manifest
  }

  /** 先落盘再广播阶段事实，界面重载不会丢失执行状态。 */
  private save(manifest: MediaRunManifest): void {
    manifest.snapshot.revision += 1
    manifest.snapshot.updatedAt = Date.now()
    const effect = (): void => { writeJsonFileAtomicSecure(join(this.directory(manifest.snapshot.projectId), `${manifest.snapshot.id}.json`), manifest) }
    if (this.dependencies.runWorkspaceWrite) this.dependencies.runWorkspaceWrite(manifest.snapshot.projectId, effect)
    else effect()
    try { this.dependencies.onChange?.(this.snapshot(manifest)) } catch { /* UI 订阅失败不能改变已提交执行事实。 */ }
    for (const listener of this.listeners) {
      try { listener(this.snapshot(manifest)) } catch { /* 单个观察者不能改变已经提交的运行事实。 */ }
    }
  }

  /** 每次向调用方返回独立投影，内部上传/提交标识不外泄。 */
  private snapshot(manifest: MediaRunManifest): MediaRunSnapshot { return structuredClone(manifest.snapshot) }
}
