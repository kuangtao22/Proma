import { createHash } from 'node:crypto'
import type {
  AdoptCanvasMediaCandidateInput,
  AttachCanvasMediaImportedAssetsInput,
  CanvasMediaCandidate,
  CanvasMediaModuleConfig,
  CanvasMediaModuleSnapshot,
  CanvasMediaOutputBinding,
  CanvasMediaOutputPreview,
  CanvasMediaPreparationIssue,
  CanvasMediaPreparationStatus,
  CanvasMediaTarget,
  ExportCanvasMediaOutputInput,
  ExportCanvasMediaOutputResult,
  MediaAssetRecord,
  MediaInputValue,
  MediaRunSnapshot,
  MediaRunSourceReference,
  MediaWorkflowDefinition,
  RunCanvasMediaModuleInput,
  SaveCanvasMediaModuleInput,
} from '@proma/shared'
import { getCanvasMediaInputErrorMessage, validateMediaWorkflowFieldValue } from '@proma/shared'
import type { MediaRunOrigin } from '../media/media-run-service'
import { ComfyUIError, type ComfyUIErrorKind } from '../media/comfyui-client'
import { MediaWorkflowValidationError } from '../media/media-workflow-error'

/** 可安全持久化并向调用方抛出的工作流准备错误。 */
export class CanvasMediaPreparationError extends Error {
  readonly issue: CanvasMediaPreparationIssue

  constructor(issue: CanvasMediaPreparationIssue) {
    /** 所有动态定位字段即使上游合同变化也不能突破持久化消息上限。 */
    const boundedIssue = { ...issue, message: issue.message.slice(0, 2_048) }
    super(`${boundedIssue.code}: ${boundedIssue.message}`)
    this.name = 'CanvasMediaPreparationError'
    this.issue = boundedIssue
  }
}

/** ComfyUI 节点目录错误只映射为固定文案，避免底层响应、路径或凭据进入持久状态和 IPC。 */
const COMFY_OBJECT_INFO_PREPARATION_ISSUES: Readonly<Record<string, CanvasMediaPreparationIssue>> = {
  COMFY_OBJECT_INFO_SIZE_LIMIT: {
    code: 'COMFY_OBJECT_INFO_SIZE_LIMIT',
    message: 'ComfyUI 节点目录超过安全处理上限，请更新应用；若仍失败，请精简服务端自定义节点。',
  },
  COMFY_OBJECT_INFO_INVALID: {
    code: 'COMFY_OBJECT_INFO_INVALID',
    message: '节点接口响应失效，请刷新 ComfyUI 节点目录后重试。',
  },
}

/** ComfyUI 传输错误按稳定 kind 映射，禁止使用可能含地址、路径或凭据的 message。 */
const COMFYUI_PREPARATION_ISSUES: Readonly<Partial<Record<ComfyUIErrorKind, CanvasMediaPreparationIssue>>> = {
  timeout: {
    code: 'COMFYUI_REQUEST_TIMEOUT',
    message: '连接 ComfyUI 超时，请检查服务状态后重试。',
  },
  'size-limit': {
    code: 'COMFYUI_RESPONSE_SIZE_LIMIT',
    message: 'ComfyUI 响应超过安全大小上限，请更新应用；若仍失败，请精简服务端自定义节点。',
  },
  authentication: {
    code: 'COMFYUI_AUTHENTICATION_REQUIRED',
    message: 'ComfyUI 认证失败，请检查连接凭据和访问权限。',
  },
  network: {
    code: 'COMFYUI_NETWORK_UNAVAILABLE',
    message: '无法连接 ComfyUI，请检查服务地址和网络状态后重试。',
  },
}

/** 将准备阶段异常收敛为既有可信错误类，供持久化与 IPC 使用同一诊断。 */
function normalizeCanvasMediaPreparationError(
  error: unknown,
): Error {
  if (error instanceof CanvasMediaPreparationError || error instanceof MediaWorkflowValidationError) return error
  if (error instanceof ComfyUIError) {
    /** 未单独公开的 ComfyUI kind 继续使用通用脱敏诊断。 */
    const comfyIssue = COMFYUI_PREPARATION_ISSUES[error.kind]
    if (comfyIssue) return new CanvasMediaPreparationError({ ...comfyIssue })
  }
  /** 既有内部控制流错误码仍由调用方判定；它们不携带自由文本。 */
  if (error instanceof Error && (/^CANVAS_MEDIA_[A-Z0-9_]+$/.test(error.message)
    || error.message === 'CANVAS_REVISION_CONFLICT'
    || error.message === 'MEDIA_FILE_BUSY')) return error
  /** 只读取首个稳定错误码，不转发冒号后的外部错误正文。 */
  const errorCode = error instanceof Error
    ? /^([A-Z0-9_]{1,96})(?::|$)/.exec(error.message)?.[1]
    : undefined
  /** 目录类错误使用固定副本，避免调用方修改共享常量。 */
  const catalogIssue = errorCode ? COMFY_OBJECT_INFO_PREPARATION_ISSUES[errorCode] : undefined
  return new CanvasMediaPreparationError(catalogIssue
    ? { ...catalogIssue }
    : {
        code: 'CANVAS_MEDIA_PREPARATION_FAILED',
        message: '媒体工作流准备失败，请检查工作流、连接和输入配置。',
      })
}

/** operation 固化工作流 selector；outputIndex 是节点 history 数组索引，不是 UI 顺序。 */
export interface CanvasMediaOperationOutput extends CanvasMediaOutputBinding {
  nodeId: string
  outputIndex: number
}

/** 已登记运行绑定独立配置 revision，候选追加不会改变该值。 */
export interface CanvasMediaOperation {
  operationId: string
  runId: string
  sourceConfigRevision: number
  sourceRef?: MediaRunSourceReference
  profile?: NonNullable<CanvasMediaModuleConfig['profile']>
  outputs: CanvasMediaOperationOutput[]
  createdAt: number
}

/** 已提交但尚未完成 Host 下游传播的采用事实。 */
export interface CanvasMediaPendingAdoptionProjection {
  configRevision: number
  candidateId: string
  runId: string
  selectedKeys: string[]
  outputs: CanvasMediaModuleConfig['adoptedOutputs']
  adoptedAt: number
}

/** 模块 Store 的内部 CAS 状态；可落在受管 Canvas 内容文件，不建立独立数据库。 */
export interface CanvasMediaModuleState {
  schemaVersion: 1
  revision: number
  config: CanvasMediaModuleConfig
  operations: CanvasMediaOperation[]
  candidates: CanvasMediaCandidate[]
  pendingAdoptionProjection: CanvasMediaPendingAdoptionProjection | null
}

/** 模块 Store 只暴露稳定读取和 compare-and-swap。 */
export interface CanvasMediaModuleStore {
  load(target: CanvasMediaTarget): Promise<CanvasMediaModuleState>
  compareAndSwap(
    target: CanvasMediaTarget,
    expectedRevision: number,
    next: CanvasMediaModuleState,
  ): Promise<CanvasMediaModuleState>
}

/** 固定预设解析只返回运行所需工作流。 */
interface CanvasMediaConfiguration {
  resolveProfile(profileId: string, revision: number, projectId: string): {
    profile: { id: string; revision: number; mediaKind: string }
    workflow: { definition: MediaWorkflowDefinition }
  }
  getWorkflow(workflowId: string, revision: number, projectId: string): {
    id: string
    revision: number
    projectId: string | null
    definition: MediaWorkflowDefinition
  }
  resolveConnection(connectionId: string, projectId: string): {
    connection: { id: string }
  }
}

/** 统一运行服务的窄依赖。 */
interface CanvasMediaRuns {
  prepare(input: {
    projectId: string
    operationId: string
    profileId: string
    profileRevision: number
    inputs: Record<string, MediaInputValue>
  }, origin: MediaRunOrigin): Promise<MediaRunSnapshot>
  prepareDraft(input: {
    projectId: string
    operationId: string
    workflowId: string
    workflowRevision: number
    connectionId: string
    mediaKind: 'image' | 'audio' | 'video'
    inputs: Record<string, MediaInputValue>
  }, origin: MediaRunOrigin): Promise<MediaRunSnapshot>
  claimPrepared?(input: {
    projectId: string
    runId: string
    profileId: string
    profileRevision: number
    inputs: Record<string, MediaInputValue>
  }, expectedActor: NonNullable<MediaRunOrigin['actor']>, nextOrigin: MediaRunOrigin): Promise<MediaRunSnapshot>
  claimPreparedDraft?(input: {
    projectId: string
    runId: string
    workflowId: string
    workflowRevision: number
    connectionId: string
    mediaKind: 'image' | 'audio' | 'video'
    inputs: Record<string, MediaInputValue>
  }, expectedActor: NonNullable<MediaRunOrigin['actor']>, nextOrigin: MediaRunOrigin): Promise<MediaRunSnapshot>
  findOperation(projectId: string, operationId: string): MediaRunSnapshot | null
  get(projectId: string, runId: string): MediaRunSnapshot
  getInputs(projectId: string, runId: string): Record<string, MediaInputValue>
  getSourceRef?(projectId: string, runId: string): MediaRunSourceReference
  getWorkflowDefinition?(projectId: string, runId: string): MediaWorkflowDefinition
  getOrigin(projectId: string, runId: string): MediaRunOrigin
  cancel(projectId: string, runId: string): Promise<MediaRunSnapshot>
}

/** 独立成功 run 只能显式挂到当前配置完全匹配的既有 AV 节点。 */
export interface AttachCompletedCanvasMediaRunInput extends CanvasMediaTarget {
  expectedConfigRevision: number
  runId: string
}

/** Supervisor 只推进或等待既有运行。 */
interface CanvasMediaSupervisor {
  start(projectId: string, runId: string, expectedRevision: number): MediaRunSnapshot
  wait(projectId: string, runId: string, timeoutMs: number, afterRevision?: number): Promise<MediaRunSnapshot>
}

/** 资产服务负责公共枚举和不可变引用校验。 */
interface CanvasMediaAssets {
  list(projectId: string): Promise<MediaAssetRecord[]>
  getRecord(projectId: string, asset: CanvasMediaCandidate['outputs'][number]['asset']): MediaAssetRecord
  /** 采用前复验确切资产引用的受管文件内容。 */
  read(projectId: string, asset: CanvasMediaCandidate['outputs'][number]['asset']): Promise<Uint8Array>
}

/** Host 控制预览授权和系统导出对话框，服务只传权威资产引用。 */
interface CanvasMediaHostFiles {
  openPreview(
    target: CanvasMediaTarget,
    asset: CanvasMediaCandidate['outputs'][number]['asset'],
    record: MediaAssetRecord,
  ): Promise<{ mediaLeaseId: string; mediaUrl: string }>
  releasePreview(target: CanvasMediaTarget, mediaLeaseId: string): Promise<void>
  exportAsset(
    target: CanvasMediaTarget,
    asset: CanvasMediaCandidate['outputs'][number]['asset'],
    record: MediaAssetRecord,
  ): Promise<ExportCanvasMediaOutputResult>
}

/** 通用 Canvas 媒体服务依赖。 */
export interface CanvasMediaServiceDependencies {
  store: CanvasMediaModuleStore
  configuration: CanvasMediaConfiguration
  runs: CanvasMediaRuns
  supervisor: CanvasMediaSupervisor
  assets: CanvasMediaAssets
  hostFiles: CanvasMediaHostFiles
  /** Host 按权威 Canvas DAG 解析 literal 与上游正式输出，禁止从展示文本猜测输入。 */
  resolveWorkflowInputs(
    target: CanvasMediaTarget,
    expectedConfigRevision: number,
  ): Promise<CanvasMediaResolvedInputs>
  /** Host 幂等投影正式输出依赖状态并唤醒等待中的持久工作流。 */
  onAdopted(
    target: CanvasMediaTarget,
    projection: CanvasMediaPendingAdoptionProjection,
  ): void | Promise<void>
  /** 每次磁盘读取和跨 await 后的远端执行前重新验证 Canvas target。 */
  authorizeTarget(target: CanvasMediaTarget, operation: 'read' | 'write' | 'run'): void | Promise<void>
  now?: () => number
}

/** 单个 DAG 输入的权威解析结果，保留来源用于错误诊断。 */
export interface CanvasMediaResolvedInput {
  targetInputKey: string
  requiredKind: 'text' | 'number' | 'boolean' | 'image' | 'audio' | 'video'
  sourceNodeId: string | null
  sourceOutputKey: string | null
  sourceArtifactHash: string | null
  resolvedValue: MediaInputValue | null
  errorCode: string | null
}

/** Host 一次解析本次配置的全部输入；ready=false 表示图依赖尚未满足。 */
export interface CanvasMediaResolvedInputs {
  ready: boolean
  bindings: CanvasMediaResolvedInput[]
}

/** Host-only 运行约束用于绑定 workflow 预检事实和调用生命周期。 */
export interface CanvasMediaRunOptions {
  expectedInputHashes?: Record<string, string>
  signal?: AbortSignal
  /** Host 工作流预先创建的 prepared run；必须与 preparedActor 成对提供。 */
  preparedRunId?: string
  /** prepared run 的原始主体，防止父调度冒领其他 Agent 的运行。 */
  preparedActor?: NonNullable<MediaRunOrigin['actor']>
  /** prepared run 的真实定义来源；draft 不得伪装为目标当前 profile。 */
  preparedSourceRef?: MediaRunSourceReference
}

/** 对单个已解析输入计算稳定哈希，阻断预检与提交之间的来源漂移。 */
function hashResolvedInput(value: MediaInputValue): string {
  return createHash('sha256')
    .update(JSON.stringify(['canvas-workflow-media-input', value]))
    .digest('hex')
}

/** 输入 key 与值都必须一致，避免独立 run 被错误标记为由目标当前配置生成。 */
function mediaInputsMatch(
  left: Record<string, MediaInputValue>,
  right: Record<string, MediaInputValue>,
): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && hashResolvedInput(left[key]!) === hashResolvedInput(right[key]!))
}

/** 期望哈希必须与本次全部输入 key 精确一致。 */
function assertExpectedInputHashes(
  inputs: Record<string, MediaInputValue>,
  expected: Record<string, string> | undefined,
): void {
  if (!expected) return
  const keys = Object.keys(inputs).sort()
  const expectedKeys = Object.keys(expected).sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
    || keys.some((key) => expected[key] !== hashResolvedInput(inputs[key]!))) {
    throw new Error('CANVAS_MEDIA_INPUT_HASH_MISMATCH')
  }
}

/** 验证 resolver 没有遗漏、重复或错配配置输入，并隔离本次运行值。 */
function resolvedMediaInputs(
  config: CanvasMediaModuleConfig,
  resolved: CanvasMediaResolvedInputs,
): Record<string, MediaInputValue> {
  if (!resolved.ready || resolved.bindings.length !== config.inputs.length) {
    throw new Error('CANVAS_MEDIA_INPUTS_NOT_READY')
  }
  const byKey = new Map(resolved.bindings.map((binding) => [binding.targetInputKey, binding]))
  if (byKey.size !== resolved.bindings.length) throw new Error('CANVAS_MEDIA_INPUT_RESOLUTION_INVALID')
  const entries = config.inputs.map((input): [string, MediaInputValue] => {
    const binding = byKey.get(input.key)
    if (!binding || binding.requiredKind !== input.kind || binding.errorCode || !binding.resolvedValue) {
      throw new Error(binding?.errorCode ?? 'CANVAS_MEDIA_INPUTS_NOT_READY')
    }
    const value = structuredClone(binding.resolvedValue)
    const expectedValueKind = input.kind === 'text' || input.kind === 'number' || input.kind === 'boolean'
      ? 'scalar'
      : 'asset'
    const scalarType = input.kind === 'text' ? 'string' : input.kind
    if (value.kind !== expectedValueKind
      || (value.kind === 'scalar' && typeof value.value !== scalarType)
      || (value.kind === 'asset' && value.asset.mediaKind !== input.kind)) {
      throw new Error('CANVAS_MEDIA_INPUT_RESOLUTION_INVALID')
    }
    return [input.key, value]
  })
  return Object.fromEntries(entries)
}

/** 终态判断不把 collection-failed 当成不可恢复失败。 */
function isTerminal(run: MediaRunSnapshot): boolean {
  return run.phase === 'succeeded' || run.phase === 'failed' || run.phase === 'cancelled'
}

/** 使用配置输出合同验证运行结果并保留原始顺序。 */
function createCandidate(
  operation: CanvasMediaOperation,
  run: MediaRunSnapshot,
  assets: CanvasMediaAssets,
  projectId: string,
  now: number,
): CanvasMediaCandidate {
  if (run.phase !== 'succeeded' || run.outputs.length !== operation.outputs.length) {
    throw new Error('CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH')
  }
  const outputs = operation.outputs.map((binding) => {
    /** 运行输出按工作流 key 与节点 history index 定位，order 只决定 UI 展示顺序。 */
    const matches = run.outputs.filter((output) => (
      output.outputKey === binding.key && output.index === binding.outputIndex
    ))
    const output = matches[0]
    if (matches.length !== 1 || !output
      || output.asset.mediaKind !== binding.mediaKind) throw new Error('CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH')
    assets.getRecord(projectId, output.asset)
    const { nodeId: _nodeId, outputIndex: _outputIndex, ...publicBinding } = binding
    return { ...publicBinding, asset: { ...output.asset } }
  })
  const sourceRef = operation.sourceRef ?? (operation.profile
    ? { kind: 'profile-version' as const, profileId: operation.profile.profileId, profileRevision: operation.profile.profileRevision }
    : (() => { throw new Error('CANVAS_MEDIA_RUN_IDENTITY_MISMATCH') })())
  return {
    id: `candidate:${run.id}`,
    operationId: operation.operationId,
    runId: run.id,
    sourceConfigRevision: operation.sourceConfigRevision,
    sourceRef: structuredClone(sourceRef),
    ...(operation.profile ? { profile: { ...operation.profile } } : {}),
    outputs,
    createdAt: now,
  }
}

/** 创建统一音视频 Canvas 服务。 */
export class CanvasMediaService {
  private readonly now: () => number

  constructor(private readonly dependencies: CanvasMediaServiceDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  /** 读取目标配置并在返回前复验权限，不刷新候选、默认采用或运行。 */
  async readConfig(target: CanvasMediaTarget): Promise<CanvasMediaModuleConfig> {
    await this.dependencies.authorizeTarget(target, 'read')
    const state = await this.dependencies.store.load(target)
    await this.dependencies.authorizeTarget(target, 'read')
    return structuredClone(state.config)
  }

  /** 完整工作台加载会恢复已完成运行；来源目录应使用只读 readConfig。 */
  async load(target: CanvasMediaTarget): Promise<CanvasMediaModuleSnapshot> {
    await this.dependencies.authorizeTarget(target, 'read')
    await this.refreshCompleted(target)
    await this.flushPendingAdoption(target)
    const state = await this.dependencies.store.load(target)
    return {
      target: { ...target },
      config: structuredClone(state.config),
      candidates: structuredClone(state.candidates),
      runs: state.operations.map((operation) => this.dependencies.runs.get(target.projectId, operation.runId)),
      assets: await this.dependencies.assets.list(target.projectId),
    }
  }

  /**
   * 按需检查本地运行准备，既不刷新候选也不创建或提交运行。
   * @param target 当前精确媒体目标。
   * @returns 当前配置的工作流、输入与可运行状态；异步期间变化会拒绝旧结果。
   */
  async checkPreparation(target: CanvasMediaTarget): Promise<CanvasMediaPreparationStatus> {
    await this.dependencies.authorizeTarget(target, 'read')
    /** 检查基线独立于运行历史和候选投影，不触发 load 的默认采用行为。 */
    const state = await this.dependencies.store.load(target)
    const config = state.config
    const issues: CanvasMediaPreparationIssue[] = []
    let workflowBound = false
    let inputsReady = false
    /** 公开诊断只使用受控代码和字段说明，禁止泄漏外部异常的磁盘路径。 */
    const report = (error: unknown): void => {
      if (error instanceof CanvasMediaPreparationError) { issues.push({ ...error.issue }); return }
      const code = error instanceof Error && /^CANVAS_MEDIA_[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'CANVAS_MEDIA_PREPARATION_INVALID'
      issues.push({ code, message: code === 'CANVAS_MEDIA_SOURCE_REQUIRED'
        ? '尚未绑定工作流，请选择工作流及连接。'
        : '工作流或输入输出合同尚不可用，请检查固定版本、连接和字段配置。' })
    }
    try {
      let workflow: MediaWorkflowDefinition
      if (config.workflow) {
        workflow = this.resolveAuthorizedWorkflow(config, {
          kind: 'project-draft-revision', workflowId: config.workflow.workflowId,
          workflowRevision: config.workflow.workflowRevision, connectionId: config.workflow.connectionId,
          mediaKind: config.mediaKind,
        }, target.projectId, false)
      } else if (config.profile) {
        const resolved = this.dependencies.configuration.resolveProfile(config.profile.profileId, config.profile.profileRevision, target.projectId)
        if (resolved.profile.id !== config.profile.profileId || resolved.profile.revision !== config.profile.profileRevision
          || resolved.profile.mediaKind !== config.mediaKind) throw new Error('CANVAS_MEDIA_PROFILE_MISMATCH')
        workflow = resolved.workflow.definition
      } else throw new Error('CANVAS_MEDIA_SOURCE_REQUIRED')
      workflowBound = true
      this.resolveOperationOutputs(config.outputs, workflow)
      this.assertDraftWorkflowInputContract(config, workflow)
    } catch (error) { report(error) }
    try {
      const resolved = await this.dependencies.resolveWorkflowInputs(target, config.revision)
      /** 逐槽展示缺边或缺少正式产物；不把素材内容传回 Renderer。 */
      for (const binding of resolved.bindings) {
        if (binding.errorCode) issues.push({ code: binding.errorCode,
          message: `输入“${binding.targetInputKey}”：${getCanvasMediaInputErrorMessage(binding.errorCode)}` })
      }
      if (resolved.ready) {
        resolvedMediaInputs(config, resolved)
        inputsReady = true
      } else if (!resolved.bindings.some((binding) => binding.errorCode)) {
        report(new Error('CANVAS_MEDIA_INPUTS_NOT_READY'))
      }
    } catch (error) { report(error) }
    await this.dependencies.authorizeTarget(target, 'read')
    const fresh = await this.dependencies.store.load(target)
    if (fresh.config.revision !== config.revision) throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
    return { configRevision: config.revision, workflowBound, inputsReady,
      ready: workflowBound && inputsReady && issues.length === 0, issues }
  }

  /** 保存配置时只推进独立 config revision，并保留仍匹配的正式输出。 */
  async save(input: SaveCanvasMediaModuleInput): Promise<CanvasMediaModuleConfig> {
    await this.dependencies.authorizeTarget(input, 'write')
    await this.flushPendingAdoption(input)
    const state = await this.dependencies.store.load(input)
    if (state.config.revision !== input.expectedConfigRevision) throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
    const adoptedOutputs = state.config.adoptedOutputs.filter((adopted) => input.outputs.some((binding) => (
      binding.key === adopted.key && binding.mediaKind === adopted.mediaKind
        && binding.role === adopted.role && binding.order === adopted.order && binding.bundle === adopted.bundle
    )))
    const config: CanvasMediaModuleConfig = {
      ...state.config,
      revision: state.config.revision + 1,
      updatedAt: this.now(),
      profile: input.profile ? { ...input.profile } : null,
      workflow: input.workflow ? { ...input.workflow } : null,
      preparation: input.preparation ? { ...input.preparation } : null,
      inputs: structuredClone(input.inputs),
      outputs: structuredClone(input.outputs),
      adoptedOutputs: structuredClone(adoptedOutputs),
    }
    const committed = await this.dependencies.store.compareAndSwap(input, state.revision, {
      ...state, revision: state.revision + 1, config,
    })
    return structuredClone(committed.config)
  }

  /** 使用确切 operationId 幂等创建或继续运行，并在成功后 CAS 挂候选。 */
  async run(
    input: RunCanvasMediaModuleInput,
    origin: MediaRunOrigin,
    options: CanvasMediaRunOptions = {},
  ): Promise<MediaRunSnapshot> {
    if ((options.preparedRunId === undefined) !== (options.preparedActor === undefined)) {
      throw new Error('CANVAS_MEDIA_PREPARED_HANDOFF_INVALID')
    }
    if (!options.preparedRunId && options.preparedSourceRef) throw new Error('CANVAS_MEDIA_PREPARED_HANDOFF_INVALID')
    await this.dependencies.authorizeTarget(input, 'run')
    const mediaOrigin = origin.canvasMedia
    if (!mediaOrigin
      || mediaOrigin.projectId !== input.projectId
      || mediaOrigin.canvasId !== input.canvasId
      || mediaOrigin.nodeId !== input.nodeId
      || mediaOrigin.mediaModuleId !== input.mediaModuleId
      || mediaOrigin.mediaKind !== input.mediaKind) {
      throw new Error('CANVAS_MEDIA_RUN_ORIGIN_INVALID')
    }
    let state = await this.dependencies.store.load(input)
    let operation = state.operations.find((item) => item.operationId === input.operationId)
    let run: MediaRunSnapshot
    if (operation) {
      /** 已登记 operation 属于历史配置，恢复不得被当前配置 revision 阻断。 */
      run = this.dependencies.runs.get(input.projectId, operation.runId)
      const operationSource = operation.sourceRef ?? (operation.profile
        ? { kind: 'profile-version', profileId: operation.profile.profileId, profileRevision: operation.profile.profileRevision }
        : null)
      const runSource = this.dependencies.runs.getSourceRef?.(input.projectId, run.id)
        ?? (run.profileId && run.profileRevision
          ? { kind: 'profile-version', profileId: run.profileId, profileRevision: run.profileRevision } as const
          : null)
      if (JSON.stringify(runSource) !== JSON.stringify(operationSource)) {
        throw new Error('CANVAS_MEDIA_RUN_IDENTITY_MISMATCH')
      }
    } else {
      if (state.config.revision !== input.expectedConfigRevision) throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
      state = await this.clearPreparationForRetry(input, state)
      try {
        const sourceRef: MediaRunSourceReference = options.preparedSourceRef ?? (state.config.workflow
          ? {
              kind: 'project-draft-revision',
              workflowId: state.config.workflow.workflowId,
              workflowRevision: state.config.workflow.workflowRevision,
              connectionId: state.config.workflow.connectionId,
              mediaKind: state.config.mediaKind,
            }
          : state.config.profile
            ? { kind: 'profile-version', profileId: state.config.profile.profileId, profileRevision: state.config.profile.profileRevision }
            : (() => { throw new Error('CANVAS_MEDIA_SOURCE_REQUIRED') })())
        let workflow: MediaWorkflowDefinition
        if (sourceRef.kind === 'profile-version') {
          if (state.config.profile?.profileId !== sourceRef.profileId
            || state.config.profile.profileRevision !== sourceRef.profileRevision) throw new Error('CANVAS_MEDIA_PROFILE_MISMATCH')
          const resolved = this.dependencies.configuration.resolveProfile(
            sourceRef.profileId, sourceRef.profileRevision, input.projectId,
          )
          if (resolved.profile.id !== sourceRef.profileId || resolved.profile.revision !== sourceRef.profileRevision
            || resolved.profile.mediaKind !== state.config.mediaKind) throw new Error('CANVAS_MEDIA_PROFILE_MISMATCH')
          workflow = resolved.workflow.definition
        } else {
          if (sourceRef.mediaKind !== state.config.mediaKind) {
            throw new Error('CANVAS_MEDIA_DRAFT_KIND_MISMATCH')
          }
          if (options.preparedRunId) {
            if (!this.dependencies.runs.getWorkflowDefinition) throw new Error('CANVAS_MEDIA_PREPARED_HANDOFF_UNAVAILABLE')
            workflow = this.dependencies.runs.getWorkflowDefinition(input.projectId, options.preparedRunId)
          } else {
            workflow = this.resolveAuthorizedWorkflow(state.config, sourceRef, input.projectId)
          }
        }
        const operationOutputs = this.resolveOperationOutputs(state.config.outputs, workflow)
        const resolvedInputs = await this.dependencies.resolveWorkflowInputs(input, state.config.revision)
        await this.dependencies.authorizeTarget(input, 'run')
        options.signal?.throwIfAborted()
        const freshState = await this.dependencies.store.load(input)
        if (freshState.config.revision !== state.config.revision) throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
        const inputs = resolvedMediaInputs(state.config, resolvedInputs)
        assertExpectedInputHashes(inputs, options.expectedInputHashes)
        if (options.preparedRunId && options.preparedActor) {
          /** 父工作流只能接管同主体预备且 typed-DAG 输入完全一致的运行。 */
          if (sourceRef.kind === 'profile-version') {
            if (!this.dependencies.runs.claimPrepared) throw new Error('CANVAS_MEDIA_PREPARED_HANDOFF_UNAVAILABLE')
            run = await this.dependencies.runs.claimPrepared({ projectId: input.projectId, runId: options.preparedRunId,
              profileId: sourceRef.profileId, profileRevision: sourceRef.profileRevision, inputs }, options.preparedActor, origin)
          } else {
            if (!this.dependencies.runs.claimPreparedDraft) throw new Error('CANVAS_MEDIA_PREPARED_HANDOFF_UNAVAILABLE')
            run = await this.dependencies.runs.claimPreparedDraft({ projectId: input.projectId, runId: options.preparedRunId,
              workflowId: sourceRef.workflowId, workflowRevision: sourceRef.workflowRevision,
              connectionId: sourceRef.connectionId, mediaKind: sourceRef.mediaKind, inputs }, options.preparedActor, origin)
          }
        } else {
          /** 手动运行继续用 operationId 幂等 prepare，并由 MediaRun 校验完整输入与来源。 */
          run = sourceRef.kind === 'profile-version'
            ? await this.dependencies.runs.prepare({
                projectId: input.projectId,
                operationId: input.operationId,
                profileId: sourceRef.profileId,
                profileRevision: sourceRef.profileRevision,
                inputs,
              }, origin)
            : await this.dependencies.runs.prepareDraft({
                projectId: input.projectId,
                operationId: input.operationId,
                workflowId: sourceRef.workflowId,
                workflowRevision: sourceRef.workflowRevision,
                connectionId: sourceRef.connectionId,
                mediaKind: sourceRef.mediaKind,
                inputs,
              }, origin)
        }
        await this.dependencies.authorizeTarget(input, 'run')
        operation = {
          operationId: input.operationId,
          runId: run.id,
          sourceConfigRevision: state.config.revision,
          sourceRef,
          ...(sourceRef.kind === 'profile-version' ? { profile: { profileId: sourceRef.profileId, profileRevision: sourceRef.profileRevision } } : {}),
          outputs: operationOutputs,
          createdAt: this.now(),
        }
        state = await this.appendOperation(input, state, operation)
      } catch (error) {
        /** 持久状态与调用方必须看到同一份安全诊断，避免原始异常绕过脱敏。 */
        const preparationError = normalizeCanvasMediaPreparationError(error)
        await this.persistPreparationIssue(input, state, preparationError)
        throw preparationError
      }
    }
    if (!isTerminal(run)) {
      await this.dependencies.authorizeTarget(input, 'run')
      options.signal?.throwIfAborted()
      run = this.dependencies.supervisor.start(input.projectId, run.id, run.revision)
    }
    if (run.phase === 'succeeded') {
      await this.attachCandidate(input, operation, run)
      await this.adoptInitialVideo(input)
    }
    return run
  }

  /** 新手动运行只接受公共或当前项目工作流，并在 prepareDraft 前锁定完整输入输出合同和连接身份。 */
  private resolveAuthorizedWorkflow(
    config: CanvasMediaModuleConfig,
    sourceRef: Extract<MediaRunSourceReference, { kind: 'project-draft-revision' }>,
    projectId: string,
    /** 只读准备检查先确认绑定，再独立展示输入输出合同问题。 */
    validateContract = true,
  ): MediaWorkflowDefinition {
    const selected = config.workflow
    if (!selected
      || selected.workflowId !== sourceRef.workflowId
      || selected.workflowRevision !== sourceRef.workflowRevision
      || selected.connectionId !== sourceRef.connectionId) {
      throw new Error('CANVAS_MEDIA_WORKFLOW_MISMATCH')
    }
    const workflow = this.dependencies.configuration.getWorkflow(
      sourceRef.workflowId,
      sourceRef.workflowRevision,
      projectId,
    )
    if (workflow.id !== sourceRef.workflowId || workflow.revision !== sourceRef.workflowRevision
      || (workflow.projectId !== null && workflow.projectId !== projectId)) throw new Error('CANVAS_MEDIA_WORKFLOW_MISMATCH')
    const connection = this.dependencies.configuration.resolveConnection(sourceRef.connectionId, projectId)
    if (connection.connection.id !== sourceRef.connectionId) throw new Error('CANVAS_MEDIA_CONNECTION_MISMATCH')
    if (!validateContract) return workflow.definition
    if (config.outputs.length !== workflow.definition.outputs.length
      || config.outputs.some((output, index) => {
        const selector = workflow.definition.outputs[index]
        return !selector || output.key !== selector.key || output.mediaKind !== selector.mediaType || output.order !== index
      })
      || !config.outputs.some((output) => output.role === 'primary' && output.mediaKind === config.mediaKind)) {
      throw new Error('CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH')
    }
    this.assertDraftWorkflowInputContract(config, workflow.definition)
    return workflow.definition
  }

  /** 新 draft 运行前验证显式输入；可选标量继续由 MediaRun 从固定 prompt 回退。 */
  private assertDraftWorkflowInputContract(
    config: CanvasMediaModuleConfig,
    workflow: MediaWorkflowDefinition,
  ): void {
    /** 按稳定 key 匹配，允许 UI 保存部分输入且不要求填写顺序与工作流一致。 */
    const inputsByKey = new Map(config.inputs.map((input) => [input.key, input]))
    for (const binding of workflow.bindings) {
      const input = inputsByKey.get(binding.key)
      const label = binding.field?.label ?? binding.key
      if (!input) {
        if (binding.field?.required === false
          && (binding.kind === 'text' || binding.kind === 'number' || binding.kind === 'boolean')) continue
        throw new CanvasMediaPreparationError({
          code: 'CANVAS_MEDIA_INPUT_REQUIRED',
          message: `待配置输入“${label}”（key=${binding.key}，nodeId=${binding.nodeId}，input=${binding.input}）。`,
        })
      }
      if (input.kind !== binding.kind) {
        throw new CanvasMediaPreparationError({
          code: 'CANVAS_MEDIA_INPUT_CONTRACT_MISMATCH',
          message: `输入“${label}”类型不匹配（key=${binding.key}，nodeId=${binding.nodeId}，input=${binding.input}）。`,
        })
      }
      if (input.source.type === 'literal'
        && (input.kind === 'text' || input.kind === 'number' || input.kind === 'boolean')) {
        const problem = validateMediaWorkflowFieldValue(binding, input.source.value)
        if (problem) {
          throw new CanvasMediaPreparationError({
            code: 'CANVAS_MEDIA_INPUT_INVALID',
            message: `${problem}（key=${binding.key}，nodeId=${binding.nodeId}，input=${binding.input}）`,
          })
        }
      }
    }
    const workflowKeys = new Set(workflow.bindings.map((binding) => binding.key))
    if ([...inputsByKey.keys()].some((key) => !workflowKeys.has(key))) {
      throw new CanvasMediaPreparationError({
        code: 'CANVAS_MEDIA_INPUT_CONTRACT_MISMATCH',
        message: '媒体输入包含工作流未声明的字段，请重新检查输入绑定。',
      })
    }
  }

  /** 重试清除诊断只推进状态版本，保留父工作流冻结的业务配置版本。 */
  private async clearPreparationForRetry(
    target: CanvasMediaTarget,
    state: CanvasMediaModuleState,
  ): Promise<CanvasMediaModuleState> {
    if (!state.config.preparation) return state
    await this.dependencies.authorizeTarget(target, 'run')
    const fresh = await this.dependencies.store.load(target)
    if (fresh.revision !== state.revision || fresh.config.revision !== state.config.revision) {
      throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
    }
    return await this.dependencies.store.compareAndSwap(target, state.revision, {
      ...state,
      revision: state.revision + 1,
      config: {
        ...state.config,
        updatedAt: this.now(),
        preparation: null,
      },
    })
  }

  /** 准备失败只在原状态仍精确有效时记录安全诊断，任何记录失败都不能覆盖原异常。 */
  private async persistPreparationIssue(
    target: CanvasMediaTarget,
    state: CanvasMediaModuleState,
    error: unknown,
  ): Promise<void> {
    const issue = error instanceof CanvasMediaPreparationError
      ? error.issue
      : error instanceof MediaWorkflowValidationError
        ? { code: 'MEDIA_WORKFLOW_INVALID', message: error.message.slice(0, 2_048) }
        : {
          code: 'CANVAS_MEDIA_PREPARATION_FAILED',
          message: '媒体工作流准备失败，请检查工作流、连接和输入配置。',
        }
    try {
      await this.dependencies.authorizeTarget(target, 'run')
      const fresh = await this.dependencies.store.load(target)
      if (fresh.revision !== state.revision || fresh.config.revision !== state.config.revision) return
      await this.dependencies.store.compareAndSwap(target, state.revision, {
        ...state,
        revision: state.revision + 1,
        config: {
          ...state.config,
          updatedAt: this.now(),
          preparation: { ...issue },
        },
      })
    } catch {
      /** 错误记录是 best-effort；并发编辑、撤权或磁盘失败时继续抛出原始运行错误。 */
    }
  }

  /** 把普通 Agent 已成功的独立 run 登记为候选，不迁移执行所有权或自动采用输出。 */
  async attachCompletedRun(
    input: AttachCompletedCanvasMediaRunInput,
    actor: NonNullable<MediaRunOrigin['actor']>,
  ): Promise<CanvasMediaCandidate> {
    await this.dependencies.authorizeTarget(input, 'write')
    const state = await this.dependencies.store.load(input)
    if (state.config.revision !== input.expectedConfigRevision) throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
    const run = this.dependencies.runs.get(input.projectId, input.runId)
    const origin = this.dependencies.runs.getOrigin(input.projectId, input.runId)
    const sourceRef = this.dependencies.runs.getSourceRef?.(input.projectId, input.runId)
      ?? (run.profileId && run.profileRevision
        ? { kind: 'profile-version', profileId: run.profileId, profileRevision: run.profileRevision } as const
        : (() => { throw new Error('CANVAS_MEDIA_RUN_IDENTITY_MISMATCH') })())
    if (run.projectId !== input.projectId || run.phase !== 'succeeded') throw new Error('CANVAS_MEDIA_ATTACH_RUN_NOT_SUCCEEDED')
    if (actor.mode !== 'project-agent' || origin.actor?.mode !== 'project-agent'
      || origin.actor.sessionId !== actor.sessionId || origin.canvasMedia || origin.designJobId || origin.preparedBy) {
      throw new Error('CANVAS_MEDIA_ATTACH_RUN_NOT_OWNED')
    }
    let workflow: MediaWorkflowDefinition
    if (sourceRef.kind === 'profile-version') {
      if (state.config.profile?.profileId !== sourceRef.profileId
        || state.config.profile.profileRevision !== sourceRef.profileRevision) throw new Error('CANVAS_MEDIA_PROFILE_MISMATCH')
      const resolved = this.dependencies.configuration.resolveProfile(sourceRef.profileId, sourceRef.profileRevision, input.projectId)
      if (resolved.profile.id !== sourceRef.profileId || resolved.profile.revision !== sourceRef.profileRevision
        || resolved.profile.mediaKind !== state.config.mediaKind) throw new Error('CANVAS_MEDIA_PROFILE_MISMATCH')
      workflow = resolved.workflow.definition
    } else {
      if (sourceRef.mediaKind !== state.config.mediaKind) throw new Error('CANVAS_MEDIA_DRAFT_KIND_MISMATCH')
      if (!this.dependencies.runs.getWorkflowDefinition) throw new Error('CANVAS_MEDIA_DRAFT_UNAVAILABLE')
      workflow = this.dependencies.runs.getWorkflowDefinition(input.projectId, input.runId)
    }
    const resolvedInputs = await this.dependencies.resolveWorkflowInputs(input, state.config.revision)
    await this.dependencies.authorizeTarget(input, 'write')
    const freshState = await this.dependencies.store.load(input)
    if (freshState.config.revision !== state.config.revision) throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
    const currentInputs = resolvedMediaInputs(state.config, resolvedInputs)
    if (!mediaInputsMatch(currentInputs, this.dependencies.runs.getInputs(input.projectId, input.runId))) {
      throw new Error('CANVAS_MEDIA_ATTACH_INPUT_MISMATCH')
    }
    const operationId = `attach:${createHash('sha256').update(JSON.stringify(['canvas-media-attach', run.id])).digest('hex')}`
    const operationOutputs = this.resolveOperationOutputs(state.config.outputs, workflow)
    const existing = state.operations.find((item) => item.runId === run.id)
    /** 重放保留首次挂接的来源 revision；当前配置仅负责证明该运行仍可兼容采用。 */
    if (existing && (existing.operationId !== operationId
      || JSON.stringify(existing.sourceRef ?? (existing.profile
        ? { kind: 'profile-version', profileId: existing.profile.profileId, profileRevision: existing.profile.profileRevision }
        : null)) !== JSON.stringify(sourceRef)
      || JSON.stringify(existing.outputs) !== JSON.stringify(operationOutputs))) {
      throw new Error('CANVAS_MEDIA_ATTACH_RUN_CONFLICT')
    }
    const operation: CanvasMediaOperation = existing ?? {
      operationId,
      runId: run.id,
      sourceConfigRevision: state.config.revision,
      sourceRef,
      ...(sourceRef.kind === 'profile-version' ? { profile: { profileId: sourceRef.profileId, profileRevision: sourceRef.profileRevision } } : {}),
      outputs: operationOutputs,
      createdAt: this.now(),
    }
    await this.dependencies.authorizeTarget(input, 'write')
    const registered = existing ? state : await this.appendOperation(input, state, operation)
    const ownedOperation = registered.operations.find((item) => item.runId === run.id)
    if (!ownedOperation) throw new Error('CANVAS_MEDIA_ATTACH_RUN_CONFLICT')
    await this.attachCandidate(input, ownedOperation, run)
    const attached = (await this.dependencies.store.load(input)).candidates.find((candidate) => candidate.runId === run.id)
    if (!attached) throw new Error('CANVAS_MEDIA_ATTACH_FAILED')
    return structuredClone(attached)
  }

  /** 把当前 Agent 已登记的本地资产追加为候选，不伪造媒体运行或自动采用。 */
  async attachImportedAssets(
    input: AttachCanvasMediaImportedAssetsInput,
    actor: NonNullable<MediaRunOrigin['actor']>,
  ): Promise<CanvasMediaCandidate> {
    await this.dependencies.authorizeTarget(input, 'write')
    const state = await this.dependencies.store.load(input)
    if (state.config.revision !== input.expectedConfigRevision) throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
    if (state.config.outputs.length === 0 || input.outputs.length !== state.config.outputs.length) {
      throw new Error('CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH')
    }
    const importedByKey = new Map(input.outputs.map((output) => [output.key, output.asset]))
    if (importedByKey.size !== input.outputs.length) throw new Error('CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH')
    const outputs = state.config.outputs.map((binding) => {
      const asset = importedByKey.get(binding.key)
      if (!asset || asset.mediaKind !== binding.mediaKind) throw new Error('CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH')
      const record = this.dependencies.assets.getRecord(input.projectId, asset)
      if (record.sourceSessionId !== actor.sessionId) throw new Error('CANVAS_MEDIA_LOCAL_ASSET_NOT_OWNED')
      if (record.id !== asset.assetId || record.revision !== asset.revision || record.hash !== asset.hash
        || record.mediaKind !== binding.mediaKind) throw new Error('CANVAS_MEDIA_LOCAL_ASSET_INVALID')
      return { ...binding, asset: { ...asset } }
    })
    if (input.outputs.some((output) => !state.config.outputs.some((binding) => binding.key === output.key))) {
      throw new Error('CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH')
    }
    /** receipt 只固定 Host 身份和操作语义，不冒充 MediaRunService 中的 run。 */
    const runId = `local-${createHash('sha256').update(JSON.stringify([
      input.projectId, input.canvasId, input.nodeId, input.mediaModuleId, actor.sessionId, input.operationId,
    ])).digest('hex').slice(0, 40)}`
    const source = { kind: 'local-import' as const, operationId: input.operationId, sourceSessionId: actor.sessionId }
    const expected = { operationId: input.operationId, runId, source, outputs }
    const matchesExpected = (candidate: CanvasMediaCandidate): boolean => candidate.operationId === expected.operationId
      && candidate.runId === expected.runId
      && JSON.stringify(candidate.source) === JSON.stringify(expected.source)
      && JSON.stringify(candidate.outputs) === JSON.stringify(expected.outputs)
    const existing = state.candidates.find((candidate) => (
      candidate.runId === runId
      || (candidate.source?.kind === 'local-import' && candidate.source.operationId === input.operationId)
    ))
    if (existing) {
      if (!matchesExpected(existing)) throw new Error('CANVAS_MEDIA_LOCAL_IMPORT_CONFLICT')
      return structuredClone(existing)
    }
    if (state.candidates.length >= 256) throw new Error('CANVAS_MEDIA_CANDIDATE_LIMIT')
    const candidate: CanvasMediaCandidate = {
      id: `candidate:${runId}`,
      operationId: input.operationId,
      runId,
      sourceConfigRevision: state.config.revision,
      source,
      outputs,
      createdAt: this.now(),
    }
    await this.dependencies.authorizeTarget(input, 'write')
    try {
      await this.dependencies.store.compareAndSwap(input, state.revision, {
        ...state, revision: state.revision + 1, candidates: [...state.candidates, candidate],
      })
      return structuredClone(candidate)
    } catch (error) {
      /** 提交回执不确定或并发重放时，只接受完全一致的本地候选。 */
      const replay = (await this.dependencies.store.load(input)).candidates.find((item) => (
        item.runId === runId
        || (item.source?.kind === 'local-import' && item.source.operationId === input.operationId)
      ))
      if (!replay || !matchesExpected(replay)) throw error
      return structuredClone(replay)
    }
  }

  /** 取消只返回统一运行事实，不伪造候选或采用状态。 */
  async cancel(target: CanvasMediaTarget, runId: string): Promise<MediaRunSnapshot> {
    await this.dependencies.authorizeTarget(target, 'run')
    const state = await this.dependencies.store.load(target)
    if (!state.operations.some((operation) => operation.runId === runId)) throw new Error('CANVAS_MEDIA_RUN_NOT_FOUND')
    return await this.dependencies.runs.cancel(target.projectId, runId)
  }

  /** 为精确候选输出创建临时预览授权。 */
  async readPreview(input: ExportCanvasMediaOutputInput): Promise<CanvasMediaOutputPreview> {
    await this.dependencies.authorizeTarget(input, 'read')
    const output = await this.requireCandidateOutput(input)
    const record = this.dependencies.assets.getRecord(input.projectId, output.asset)
    const preview = await this.dependencies.hostFiles.openPreview(input, output.asset, record)
    return {
      candidateId: input.candidateId,
      outputKey: input.outputKey,
      outputOrder: input.outputOrder,
      asset: structuredClone(record),
      mediaLeaseId: preview.mediaLeaseId,
      mediaUrl: preview.mediaUrl,
    }
  }

  /** 释放 Host 创建的临时媒体授权。 */
  async releasePreview(target: CanvasMediaTarget, mediaLeaseId: string): Promise<void> {
    await this.dependencies.authorizeTarget(target, 'read')
    await this.dependencies.hostFiles.releasePreview(target, mediaLeaseId)
  }

  /** 导出精确候选输出，文件选择和写入由 Host 受控回调完成。 */
  async exportOutput(input: ExportCanvasMediaOutputInput): Promise<ExportCanvasMediaOutputResult> {
    await this.dependencies.authorizeTarget(input, 'read')
    const output = await this.requireCandidateOutput(input)
    const record = this.dependencies.assets.getRecord(input.projectId, output.asset)
    return await this.dependencies.hostFiles.exportAsset(input, output.asset, record)
  }

  /** 按 selectedKeys 独立采用；显式 bundle 必须一次选择完整同组。 */
  async adopt(input: AdoptCanvasMediaCandidateInput): Promise<CanvasMediaModuleConfig> {
    return this.commitAdoption(input)
  }

  /** 默认选择与明确采用共用资产校验、配置 CAS 和可恢复传播，来源只能由 Host 指定。 */
  private async commitAdoption(
    input: AdoptCanvasMediaCandidateInput,
    selectionOrigin?: 'initial',
  ): Promise<CanvasMediaModuleConfig> {
    await this.dependencies.authorizeTarget(input, 'write')
    const state = await this.dependencies.store.load(input)
    if (state.config.revision !== input.expectedConfigRevision) throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
    const candidate = state.candidates.find((item) => item.id === input.candidateId)
    if (!candidate) throw new Error('CANVAS_MEDIA_CANDIDATE_NOT_FOUND')
    const selected = new Set(input.selectedKeys)
    for (const key of selected) {
      const binding = state.config.outputs.find((output) => output.key === key)
      const output = candidate.outputs.find((item) => item.key === key)
      if (!binding || !output || output.mediaKind !== binding.mediaKind || output.order !== binding.order) {
        throw new Error('CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH')
      }
      if (binding.bundle) {
        const bundleKeys = state.config.outputs.filter((item) => item.bundle === binding.bundle).map((item) => item.key)
        if (bundleKeys.some((bundleKey) => !selected.has(bundleKey))) throw new Error('CANVAS_MEDIA_BUNDLE_INCOMPLETE')
      }
    }
    /** 正式采用前串行复验本次选中资产，避免候选期文件缺失或篡改后仍传播画布事实。 */
    for (const binding of state.config.outputs) {
      if (!selected.has(binding.key)) continue
      const output = candidate.outputs.find((item) => item.key === binding.key)!
      await this.dependencies.assets.read(input.projectId, output.asset)
    }
    await this.dependencies.authorizeTarget(input, 'write')
    const adoptedByKey = new Map(state.config.adoptedOutputs.map((output) => [output.key, output]))
    for (const output of candidate.outputs) {
      if (selected.has(output.key)) adoptedByKey.set(output.key, {
        ...output, candidateId: candidate.id, runId: candidate.runId, asset: { ...output.asset },
        ...(selectionOrigin ? { selectionOrigin } : {}),
      })
    }
    const config: CanvasMediaModuleConfig = {
      ...state.config,
      revision: state.config.revision + 1,
      updatedAt: this.now(),
      adoptedOutputs: state.config.outputs.flatMap((binding) => {
        const adopted = adoptedByKey.get(binding.key)
        return adopted ? [adopted] : []
      }),
    }
    const projection: CanvasMediaPendingAdoptionProjection = {
      configRevision: config.revision,
      candidateId: candidate.id,
      runId: candidate.runId,
      selectedKeys: [...input.selectedKeys],
      outputs: structuredClone(config.adoptedOutputs.filter((output) => selected.has(output.key))),
      adoptedAt: config.updatedAt,
    }
    const committed = await this.dependencies.store.compareAndSwap(input, state.revision, {
      ...state, revision: state.revision + 1, config, pendingAdoptionProjection: projection,
    })
    await this.flushPendingAdoption(input, committed)
    return structuredClone(committed.config)
  }

  /** 输出合同必须与固定工作流 selector 在 key、类型和顺序上一致。 */
  private resolveOperationOutputs(
    bindings: readonly CanvasMediaOutputBinding[],
    workflow: MediaWorkflowDefinition,
  ): CanvasMediaOperationOutput[] {
    if (bindings.length !== workflow.outputs.length || bindings.some((binding, index) => {
      const selector = workflow.outputs[index]
      return !selector || binding.order !== index || binding.key !== selector.key || binding.mediaKind !== selector.mediaType
    })) throw new Error('CANVAS_MEDIA_OUTPUT_CONTRACT_MISMATCH')
    return bindings.map((binding, index) => ({
      ...binding,
      nodeId: workflow.outputs[index]!.nodeId,
      outputIndex: workflow.outputs[index]!.outputIndex,
    }))
  }

  /** 补挂后台已完成运行；Host run 事件可重复调用此入口。 */
  async refreshCompleted(target: CanvasMediaTarget): Promise<void> {
    await this.dependencies.authorizeTarget(target, 'read')
    const state = await this.dependencies.store.load(target)
    for (const operation of state.operations) {
      const run = this.dependencies.runs.get(target.projectId, operation.runId)
      if (run.phase === 'succeeded') await this.attachCandidate(target, operation, run)
    }
    await this.flushPendingAdoption(target)
    /** 已有视频的普通刷新无需再读取模块或申请默认采用写权限。 */
    if (!state.config.adoptedOutputs.some((output) => output.mediaKind === 'video')) await this.adoptInitialVideo(target)
  }

  /** 空视频从当前配置对应的最早有效候选初始化主输出；重跑和并发人工选择优先。 */
  private async adoptInitialVideo(target: CanvasMediaTarget): Promise<void> {
    if (target.mediaKind !== 'video') return
    for (let attempt = 0; attempt < 4; attempt += 1) {
      /** 只读项目仍能浏览历史，不通过 LOAD 绕过写权限。 */
      try { await this.dependencies.authorizeTarget(target, 'write') } catch { return }
      const state = await this.dependencies.store.load(target)
      if (state.pendingAdoptionProjection || state.config.adoptedOutputs.some((output) => output.mediaKind === 'video')) return
      /** 候选顺序来自完成时间，不依赖目录扫描或 UI 倒序展示。 */
      const candidates = [...state.candidates].sort((left, right) => left.createdAt - right.createdAt)
      /** 一次只选择主视频及其显式 bundle，未成组的音轨、海报保留原选择。 */
      let selection: { candidateId: string; selectedKeys: string[] } | null = null
      for (const candidate of candidates) {
        if (candidate.sourceConfigRevision !== state.config.revision) continue
        const primary = candidate.outputs.find((output) => output.mediaKind === 'video' && output.role === 'primary')
        if (!primary) continue
        const selectedOutputs = primary.bundle
          ? candidate.outputs.filter((output) => output.bundle === primary.bundle)
          : [primary]
        if (selectedOutputs.some((output) => state.config.adoptedOutputs.some((adopted) => adopted.key === output.key)
          || !state.config.outputs.some((binding) => binding.key === output.key && binding.mediaKind === output.mediaKind
            && binding.order === output.order && binding.role === output.role && binding.bundle === output.bundle))) continue
        selection = { candidateId: candidate.id, selectedKeys: selectedOutputs.map((output) => output.key) }
        break
      }
      if (!selection) return
      try {
        await this.commitAdoption({ ...target, expectedConfigRevision: state.config.revision, ...selection }, 'initial')
        return
      } catch (error) {
        /** 只有版本竞争可以重读；资产损坏、授权撤销和传播失败继续向调用方报错。 */
        if (!(error instanceof Error) || !['CANVAS_MEDIA_STATE_CONFLICT', 'CANVAS_MEDIA_CONFIG_CONFLICT'].includes(error.message)) throw error
      }
    }
    throw new Error('CANVAS_MEDIA_STATE_CONFLICT')
  }

  /** 重放已提交采用事实，Host 幂等成功后才清除持久 marker。 */
  private async flushPendingAdoption(
    target: CanvasMediaTarget,
    loaded?: CanvasMediaModuleState,
  ): Promise<void> {
    const state = loaded ?? await this.dependencies.store.load(target)
    const projection = state.pendingAdoptionProjection
    if (!projection) return
    try {
      await this.dependencies.onAdopted(target, structuredClone(projection))
    } catch (error) {
      throw new Error('CANVAS_MEDIA_ADOPTION_PROPAGATION_PENDING', { cause: error })
    }
    try {
      await this.dependencies.store.compareAndSwap(target, state.revision, {
        ...state,
        revision: state.revision + 1,
        pendingAdoptionProjection: null,
      })
    } catch (error) {
      const latest = await this.dependencies.store.load(target)
      if (latest.pendingAdoptionProjection === null
        || latest.pendingAdoptionProjection.configRevision !== projection.configRevision) return
      throw error
    }
  }

  /** 从模块候选中按 key 和 order 精确定位输出。 */
  private async requireCandidateOutput(input: ExportCanvasMediaOutputInput): Promise<CanvasMediaCandidate['outputs'][number]> {
    const state = await this.dependencies.store.load(input)
    const candidate = state.candidates.find((item) => item.id === input.candidateId)
    const output = candidate?.outputs.find((item) => item.key === input.outputKey && item.order === input.outputOrder)
    if (!output) throw new Error('CANVAS_MEDIA_OUTPUT_NOT_FOUND')
    return output
  }

  /** 首次运行登记使用模块状态 CAS，冲突时只接受同一 operation/run 重放。 */
  private async appendOperation(
    target: CanvasMediaTarget,
    state: CanvasMediaModuleState,
    operation: CanvasMediaOperation,
  ): Promise<CanvasMediaModuleState> {
    try {
      return await this.dependencies.store.compareAndSwap(target, state.revision, {
        ...state, revision: state.revision + 1, operations: [...state.operations, operation],
      })
    } catch (error) {
      const latest = await this.dependencies.store.load(target)
      const replay = latest.operations.find((item) => item.operationId === operation.operationId)
      if (!replay || replay.runId !== operation.runId) throw error
      return latest
    }
  }

  /** 成功运行追加候选时重读最新状态，避免旧配置结果回滚当前配置。 */
  private async attachCandidate(
    target: CanvasMediaTarget,
    operation: CanvasMediaOperation,
    run: MediaRunSnapshot,
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const state = await this.dependencies.store.load(target)
      if (state.candidates.some((candidate) => candidate.runId === run.id)) return
      const candidate = createCandidate(operation, run, this.dependencies.assets, target.projectId, this.now())
      try {
        await this.dependencies.store.compareAndSwap(target, state.revision, {
          ...state, revision: state.revision + 1, candidates: [...state.candidates, candidate],
        })
        return
      } catch {
        /** 并发配置或候选提交后重新读取，但绝不改变 operation 的 sourceConfigRevision。 */
      }
    }
    throw new Error('CANVAS_MEDIA_STATE_CONFLICT')
  }
}
