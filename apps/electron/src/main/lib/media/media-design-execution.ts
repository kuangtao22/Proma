import type {
  DesignAsset,
  DesignJobRecord,
  MediaAssetRef,
  MediaInputValue,
  MediaRunSnapshot,
  MediaWorkflowBinding,
  MediaWorkflowDefinition,
  MediaWorkflowVersion,
  PrepareMediaRunInput,
} from '@proma/shared'
import type { DesignMediaImageExecution, DesignMediaImageExecutionResult } from '../design/design-job-manager'

/** 固定预设解析只暴露 Canvas 适配器实际使用的不可变身份与工作流。 */
interface MediaDesignConfiguration {
  resolveProfile(profileId: string, revision: number, projectId: string): {
    profile: { id: string; revision: number; connectionId: string; workflowId: string; workflowRevision: number }
    workflow: { id: string; revision: number; hash: string; definition: MediaWorkflowDefinition }
  }
  getWorkflow(workflowId: string, revision: number, projectId: string): MediaWorkflowVersion
  resolveConnectionVersion(connectionId: string, instanceGeneration: string): {
    connection: { id: string; instanceGeneration: string }
  }
}

/** 运行服务的窄接口，避免 Canvas 适配器获得无关配置写权限。 */
interface MediaDesignRuns {
  findOperation(projectId: string, operationId: string): MediaRunSnapshot | null
  getOrigin(projectId: string, runId: string): { designJobId?: string }
  prepare(input: PrepareMediaRunInput, origin?: { designJobId?: string }): Promise<MediaRunSnapshot>
  prepareDraft(input: {
    projectId: string
    operationId: string
    connectionId: string
    workflowId: string
    workflowRevision: number
    mediaKind: 'image'
    inputs: Record<string, MediaInputValue>
  }, origin?: { designJobId?: string }): Promise<MediaRunSnapshot>
  cancel(projectId: string, runId: string): Promise<MediaRunSnapshot>
}

/** 监督器的窄接口，等待超时只返回持久化事实，不取消远端任务。 */
interface MediaDesignSupervisor {
  start(projectId: string, runId: string, expectedRevision: number): MediaRunSnapshot
  wait(projectId: string, runId: string, timeoutMs?: number, afterRevision?: number): Promise<MediaRunSnapshot>
}

/** 权威 Design Store 只用于读取不可变素材元数据。 */
interface MediaDesignStore {
  requireStableAuthoritativeDocument(projectId: string): { assets: DesignAsset[] }
}

/** Canvas 媒体执行适配器依赖。 */
export interface MediaDesignImageExecutionDependencies {
  configuration: MediaDesignConfiguration
  runs: MediaDesignRuns
  supervisor: MediaDesignSupervisor
  store: MediaDesignStore
}

/** Canvas 尺寸档位以长边像素定义，不为 auto 猜测工作流分辨率。 */
const IMAGE_LONG_EDGE: Record<'1K' | '2K' | '4K', number> = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
}

/** 读取标量绑定在固定工作流图中的 literal 默认值。 */
function scalarDefault(definition: MediaWorkflowDefinition, binding: MediaWorkflowBinding): string | number | boolean {
  /** 绑定目标当前保存的输入值。 */
  const value = definition.prompt[binding.nodeId]?.inputs[binding.input]
  /** 标量绑定要求的 JavaScript 类型。 */
  const expectedType = binding.kind === 'text' ? 'string' : binding.kind
  if (!['string', 'number', 'boolean'].includes(expectedType) || typeof value !== expectedType) {
    throw new Error(`MEDIA_CANVAS_SCALAR_DEFAULT_INVALID:${binding.key}`)
  }
  return value as string | number | boolean
}

/** 从 Design 权威素材表构造统一媒体引用，旧素材版本固定为 1。 */
function mediaAssetReference(asset: DesignAsset): MediaAssetRef {
  return { assetId: asset.id, revision: 1, hash: asset.sha256, mediaKind: 'image' }
}

/** 将 Canvas 比例和长边档位转换为工作流明确声明的宽高输入。 */
function constraintDimensions(job: DesignJobRecord): { width: number; height: number } | null {
  if (!job.generationConstraints) return null
  if (job.generationConstraints.imageSize === 'auto') throw new Error('MEDIA_CANVAS_CONSTRAINT_UNSUPPORTED')
  /** 当前尺寸档位的长边像素。 */
  const longEdge = IMAGE_LONG_EDGE[job.generationConstraints.imageSize]
  /** 比例中已校验的整数宽高项。 */
  const [ratioWidth, ratioHeight] = job.generationConstraints.aspectRatio.split(':').map(Number) as [number, number]
  /** 未知比例扩展必须得到确定整数，否则交给 Comfy INT 会变成迟到运行错误。 */
  const dimensions = ratioWidth >= ratioHeight
    ? { width: longEdge, height: longEdge * ratioHeight / ratioWidth }
    : { width: longEdge * ratioWidth / ratioHeight, height: longEdge }
  if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)) {
    throw new Error('MEDIA_CANVAS_CONSTRAINT_UNSUPPORTED')
  }
  return dimensions
}

/** 校验首次解析仍与 Job 固化的 Comfy 快照完全一致。 */
function resolveWorkflow(job: DesignJobRecord, configuration: MediaDesignConfiguration): MediaWorkflowDefinition {
  /** 只有 Comfy 快照允许进入统一媒体执行。 */
  const snapshot = job.imageModelSnapshot
  if (!snapshot || snapshot.executor !== 'comfyui') throw new Error('MEDIA_CANVAS_MODEL_INVALID')
  if ('source' in snapshot && snapshot.source === 'workflow') {
    /** 直接工作流任务按固定版本和历史连接代次复核，禁止目录编辑后改派。 */
    const workflow = configuration.getWorkflow(snapshot.workflowId, snapshot.workflowRevision, job.projectId)
    const connection = configuration.resolveConnectionVersion(snapshot.connectionId, snapshot.instanceGeneration).connection
    if (workflow.id !== snapshot.workflowId || workflow.revision !== snapshot.workflowRevision
      || workflow.hash !== snapshot.workflowHash
      || (workflow.projectId !== null && workflow.projectId !== job.projectId)
      || connection.id !== snapshot.connectionId || connection.instanceGeneration !== snapshot.instanceGeneration
      || workflow.definition.outputs.length !== 1 || workflow.definition.outputs[0]?.mediaType !== 'image') {
      throw new Error('MEDIA_CANVAS_MODEL_SNAPSHOT_MISMATCH')
    }
    return workflow.definition
  }
  /** 按快照中的预设 revision 解析固定工作流。 */
  const resolved = configuration.resolveProfile(snapshot.mediaProfileId, snapshot.mediaProfileRevision, job.projectId)
  if (resolved.profile.id !== snapshot.mediaProfileId
    || resolved.profile.revision !== snapshot.mediaProfileRevision
    || resolved.profile.connectionId !== snapshot.connectionId
    || resolved.profile.workflowId !== snapshot.workflowId
    || resolved.profile.workflowRevision !== snapshot.workflowRevision
    || resolved.workflow.id !== snapshot.workflowId
    || resolved.workflow.revision !== snapshot.workflowRevision
    || resolved.workflow.hash !== snapshot.workflowHash) throw new Error('MEDIA_CANVAS_MODEL_SNAPSHOT_MISMATCH')
  return resolved.workflow.definition
}

/** 收集 Job 明确引用的去重图片 ID，不从画布其它节点或文件名推断。 */
function referencedAssetIds(job: DesignJobRecord): string[] {
  /** 来源图与已提交直接入边共同组成允许的候选集合。 */
  const ids = [job.sourceAssetId, ...(job.canvasInputReferences ?? []).map((reference) => reference.assetId)]
    .filter((assetId): assetId is string => typeof assetId === 'string')
  return [...new Set(ids)]
}

/** 构造首次 prepare 的完整绑定输入，并拒绝图片与尺寸语义歧义。 */
function prepareInputs(job: DesignJobRecord, definition: MediaWorkflowDefinition, store: MediaDesignStore): Record<string, MediaInputValue> {
  /** 用户主提示词必须有唯一明确 text 槽，禁止静默沿用图中旧 prompt。 */
  const promptBindings = definition.bindings.filter((binding) => binding.key === 'prompt')
  if (promptBindings.length !== 1 || promptBindings[0]?.kind !== 'text') {
    throw new Error('MEDIA_CANVAS_PROMPT_BINDING_REQUIRED')
  }
  /** 工作流中所有图片槽。 */
  const imageBindings = definition.bindings.filter((binding) => binding.kind === 'image')
  /** Job 明确授权的图片候选 ID。 */
  const assetIds = referencedAssetIds(job)
  if (imageBindings.length > 1 || assetIds.length > 1) throw new Error('MEDIA_CANVAS_IMAGE_INPUT_AMBIGUOUS')
  if (imageBindings.length === 1 && assetIds.length !== 1) throw new Error('MEDIA_CANVAS_IMAGE_INPUT_REQUIRED')
  if (imageBindings.length === 0 && assetIds.length === 1) throw new Error('MEDIA_CANVAS_IMAGE_INPUT_UNSUPPORTED')

  /** 当前项目权威文档，所有引用必须由它授权并提供 hash。 */
  const document = store.requireStableAuthoritativeDocument(job.projectId)
  /** 唯一图片候选的权威素材。 */
  const imageAsset = assetIds[0] ? document.assets.find((asset) => asset.id === assetIds[0]) : undefined
  if (assetIds.length === 1 && !imageAsset) throw new Error('MEDIA_ASSET_NOT_AUTHORIZED')

  /** Canvas 结构化尺寸；存在约束时必须同时找到明确 width/height 数值槽。 */
  const dimensions = constraintDimensions(job)
  /** 宽度的明确数值绑定。 */
  const widthBinding = definition.bindings.find((binding) => binding.key === 'width' && binding.kind === 'number')
  /** 高度的明确数值绑定。 */
  const heightBinding = definition.bindings.find((binding) => binding.key === 'height' && binding.kind === 'number')
  if (dimensions && (!widthBinding || !heightBinding)) throw new Error('MEDIA_CANVAS_CONSTRAINT_UNSUPPORTED')

  /** 传给 MediaRunService 的完整绑定映射。 */
  const inputs: Record<string, MediaInputValue> = {}
  for (const binding of definition.bindings) {
    if (binding.kind === 'image') {
      inputs[binding.key] = { kind: 'asset', asset: mediaAssetReference(imageAsset!) }
      continue
    }
    if (binding.kind === 'audio' || binding.kind === 'video') throw new Error('MEDIA_CANVAS_INPUT_UNSUPPORTED')
    if (binding.key === 'prompt' && binding.kind !== 'text') throw new Error('MEDIA_CANVAS_PROMPT_BINDING_INVALID')
    /** prompt 是唯一允许由 Job 主提示词覆盖的文本槽。 */
    const value = binding.key === 'prompt'
      ? job.prompt
      : dimensions && binding.key === 'width'
        ? dimensions.width
        : dimensions && binding.key === 'height'
          ? dimensions.height
          : scalarDefault(definition, binding)
    inputs[binding.key] = { kind: 'scalar', value }
  }
  return inputs
}

/** 校验 operation 与当前 Job 的固定模型和可信来源一致。 */
function assertRunIdentity(job: DesignJobRecord, run: MediaRunSnapshot, runs: MediaDesignRuns): void {
  /** 当前 Job 固化的 Comfy 快照。 */
  const snapshot = job.imageModelSnapshot
  if (!snapshot || snapshot.executor !== 'comfyui' || run.projectId !== job.projectId
    || runs.getOrigin(job.projectId, run.id).designJobId !== job.id) throw new Error('MEDIA_OPERATION_IDENTITY_MISMATCH')
  if ('source' in snapshot && snapshot.source === 'workflow') {
    if (run.sourceRef?.kind !== 'project-draft-revision'
      || run.sourceRef.workflowId !== snapshot.workflowId
      || run.sourceRef.workflowRevision !== snapshot.workflowRevision
      || run.sourceRef.connectionId !== snapshot.connectionId
      || run.sourceRef.mediaKind !== 'image') throw new Error('MEDIA_OPERATION_IDENTITY_MISMATCH')
    return
  }
  if (run.profileId !== snapshot.mediaProfileId || run.profileRevision !== snapshot.mediaProfileRevision) {
    throw new Error('MEDIA_OPERATION_IDENTITY_MISMATCH')
  }
}

/** 将媒体运行事实投影为 Design Manager 所需的成功或 pending 结果。 */
function projectResult(job: DesignJobRecord, run: MediaRunSnapshot, store: MediaDesignStore): DesignMediaImageExecutionResult {
  if (run.phase === 'failed') throw new Error(run.error ?? 'MEDIA_EXECUTION_FAILED')
  if (run.phase === 'cancelled') throw new Error(run.error ?? 'MEDIA_EXECUTION_CANCELLED')
  if (run.phase !== 'succeeded') return { status: 'pending', error: run.error ?? 'MEDIA_EXECUTION_PENDING' }
  if (run.outputs.length !== 1 || run.outputs[0]?.asset.mediaKind !== 'image') throw new Error('MEDIA_OUTPUT_COUNT_INVALID')
  /** 运行输出引用对应的权威 Design 素材。 */
  const reference = run.outputs[0].asset
  /** 成功素材必须同时匹配 ID、固定 revision、hash 和当前 Job 来源。 */
  const asset = store.requireStableAuthoritativeDocument(job.projectId).assets.find((candidate) => candidate.id === reference.assetId)
  if (!asset || reference.revision !== 1 || asset.sha256 !== reference.hash) throw new Error('MEDIA_OUTPUT_ASSET_INVALID')
  if (asset.sourceJobId !== job.id) throw new Error('MEDIA_OUTPUT_JOB_MISMATCH')
  return { status: 'succeeded', asset }
}

/** 创建 Design Job 到统一媒体运行的幂等图片执行适配器。 */
export function createMediaDesignImageExecution(dependencies: MediaDesignImageExecutionDependencies): DesignMediaImageExecution {
  /** 观察已有运行并等待一次有界状态变化。 */
  const continueRun = async (job: DesignJobRecord, run: MediaRunSnapshot): Promise<DesignMediaImageExecutionResult> => {
    assertRunIdentity(job, run, dependencies.runs)
    if (['succeeded', 'failed', 'cancelled'].includes(run.phase)) return projectResult(job, run, dependencies.store)
    dependencies.supervisor.start(job.projectId, run.id, run.revision)
    /** 等待 revision 变化或终态；超时仍返回最新持久化事实。 */
    const latest = await dependencies.supervisor.wait(job.projectId, run.id, 30_000, run.revision)
    assertRunIdentity(job, latest, dependencies.runs)
    return projectResult(job, latest, dependencies.store)
  }

  return {
    /** 首次运行允许 prepare；相同 operation 已存在时只继续原运行。 */
    async runImage(job: DesignJobRecord): Promise<DesignMediaImageExecutionResult> {
      /** Job ID 是媒体 operation 的稳定幂等键。 */
      const existing = dependencies.runs.findOperation(job.projectId, job.id)
      if (existing) return continueRun(job, existing)
      /** 首次提交才读取快照指定的固定工作流并解析输入。 */
      const definition = resolveWorkflow(job, dependencies.configuration)
      /** 固定媒体快照提供 prepare 所需的预设身份。 */
      const snapshot = job.imageModelSnapshot
      if (!snapshot || snapshot.executor !== 'comfyui') throw new Error('MEDIA_CANVAS_MODEL_INVALID')
      const prepared = 'source' in snapshot && snapshot.source === 'workflow'
        ? await dependencies.runs.prepareDraft({
            projectId: job.projectId,
            operationId: job.id,
            connectionId: snapshot.connectionId,
            workflowId: snapshot.workflowId,
            workflowRevision: snapshot.workflowRevision,
            mediaKind: 'image',
            inputs: structuredClone(snapshot.inputs),
          }, { designJobId: job.id })
        : await dependencies.runs.prepare({
            projectId: job.projectId,
            operationId: job.id,
            profileId: snapshot.mediaProfileId,
            profileRevision: snapshot.mediaProfileRevision,
            inputs: prepareInputs(job, definition, dependencies.store),
          }, { designJobId: job.id })
      return continueRun(job, prepared)
    },

    /** 恢复只查找原 operation，缺失时保留 pending 供人工诊断。 */
    async recoverImage(job: DesignJobRecord): Promise<DesignMediaImageExecutionResult> {
      /** 恢复路径绝不重建可能收费的远端任务。 */
      const existing = dependencies.runs.findOperation(job.projectId, job.id)
      return existing
        ? continueRun(job, existing)
        : { status: 'pending', error: 'MEDIA_OPERATION_NOT_FOUND' }
    },

    /** 取消只在远端快照明确进入 cancelled 后确认成功。 */
    async cancel(projectId: string, jobId: string): Promise<{ confirmed: boolean }> {
      /** 未创建 operation 的本地任务无需远端确认。 */
      const existing = dependencies.runs.findOperation(projectId, jobId)
      if (!existing) return { confirmed: true }
      /** operation 的可信 Design Job 来源必须与取消目标一致。 */
      if (dependencies.runs.getOrigin(projectId, existing.id).designJobId !== jobId) throw new Error('MEDIA_OPERATION_IDENTITY_MISMATCH')
      const cancelled = await dependencies.runs.cancel(projectId, existing.id)
      return { confirmed: cancelled.phase === 'cancelled' }
    },
  }
}
