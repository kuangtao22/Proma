import { validateMediaWorkflowFieldValue } from '@proma/shared'
import type { CanvasImageMediaWorkflow, ImageGenerationModelOption, ImageGenerationModelSnapshot, MediaAssetRef, MediaInputValue, MediaWorkflowBinding, MediaWorkflowDefinition, MediaProfile, MediaWorkflowVersion } from '@proma/shared'
import type { ImageGenerationMediaCatalogAdapter } from '../image-generation-model-catalog'
import type { MediaConfigStore } from './media-config-store'
import { MediaWorkflowValidationError } from './media-workflow-error'
import type { ComfyWorkflowIssueCode } from './comfyui-workflow'

/** Comfy 预设仍保存在统一媒体目录，旧图片选择器只读取轻量投影。 */
type ComfySnapshot = Extract<ImageGenerationModelSnapshot, { executor: 'comfyui'; profileId: string }>
/** 公共或当前项目工作流直接执行的独立图片快照。 */
type WorkflowSnapshot = Extract<ImageGenerationModelSnapshot, { executor: 'comfyui'; source: 'workflow' }>

/** 用不可变预设及工作流版本生成稳定的图片选择身份。 */
function snapshot(profile: MediaProfile, workflow: MediaWorkflowVersion): ComfySnapshot {
  return { executor: 'comfyui', profileId: `media:${profile.id}:${profile.revision}`, name: profile.name,
    modelId: `comfyui:${workflow.id}@${workflow.revision}`, mediaProfileId: profile.id, mediaProfileRevision: profile.revision,
    connectionId: profile.connectionId, workflowId: workflow.id, workflowRevision: workflow.revision, workflowHash: workflow.hash }
}

/** 校验图片选择器只接收单图片输出，通用多输出工作流由媒体节点管理。 */
function assertImageWorkflow(workflow: MediaWorkflowVersion): void {
  if (workflow.definition.outputs.length !== 1 || workflow.definition.outputs[0]?.mediaType !== 'image') throw new Error('该工作流需要通过多输出媒体节点运行')
}

/** 只允许显示已验证绑定的节点和输入，防止错误信息回显画布中的任意内容。 */
function inputError(code: ComfyWorkflowIssueCode, binding: MediaWorkflowBinding | undefined, reason: string): MediaWorkflowValidationError {
  return new MediaWorkflowValidationError([{
    code,
    ...(binding ? { nodeId: binding.nodeId, input: binding.input } : {}),
    /** 原因仅保留在主进程可信对象内，公开文案由错误类的白名单映射生成。 */
    message: reason,
  }])
}

/** 图片节点缺省可选标量会在 prepare 阶段回退到固定 API 图的原始值。 */
function isOptionalScalar(binding: MediaWorkflowBinding): boolean {
  return binding.field?.required === false && ['text', 'number', 'boolean'].includes(binding.kind)
}

/** 严格验证素材引用，避免内存状态绕过画布持久化解析器后创建不可信快照。 */
function isAssetReference(value: unknown): value is MediaAssetRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const asset = value as Record<string, unknown>
  return Object.keys(asset).length === 4
    && typeof asset.assetId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(asset.assetId)
    && !['constructor', 'prototype', '__proto__'].includes(asset.assetId)
    && Number.isSafeInteger(asset.revision) && Number(asset.revision) >= 1
    && typeof asset.hash === 'string' && /^[a-f0-9]{64}$/.test(asset.hash)
    && (asset.mediaKind === 'image' || asset.mediaKind === 'audio' || asset.mediaKind === 'video')
}

/** 在创建运行快照前验证全部工作流输入，阻止不完整草稿进入 Job 准备阶段。 */
function assertWorkflowSelectionInputs(definition: MediaWorkflowDefinition, inputs: Record<string, MediaInputValue>): void {
  const bindings = new Map(definition.bindings.map((binding) => [binding.key, binding]))
  for (const key of Object.keys(inputs)) {
    if (!bindings.has(key)) throw inputError('INPUT_UNKNOWN', undefined, '输入不属于当前工作流')
  }
  for (const binding of definition.bindings) {
    /** 可选标量的运行默认值来自固定 API 图，也必须经过同一类型和范围校验。 */
    const fallback = isOptionalScalar(binding) ? definition.prompt[binding.nodeId]?.inputs[binding.input] : undefined
    const value = inputs[binding.key] ?? (typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean'
      ? { kind: 'scalar' as const, value: fallback } : undefined)
    if (!value) {
      throw inputError('INPUT_REQUIRED', binding, '缺少必填输入')
    }
    if (value.kind === 'asset') {
      if (!isAssetReference(value.asset)) throw inputError('INPUT_TYPE_INVALID', binding, '媒体引用格式无效')
      if (value.asset.mediaKind !== binding.kind) throw inputError('INPUT_TYPE_INVALID', binding, '媒体类型与工作流输入不匹配')
      continue
    }
    if (value.kind !== 'scalar') throw inputError('INPUT_TYPE_INVALID', binding, '输入格式无效')
    const expectedType = binding.kind === 'text' ? 'string' : binding.kind
    if (!['text', 'number', 'boolean'].includes(binding.kind)
      || typeof value.value !== expectedType
      || (typeof value.value === 'number' && !Number.isFinite(value.value))) {
      throw inputError('INPUT_TYPE_INVALID', binding, '输入类型与工作流要求不匹配')
    }
    const problem = validateMediaWorkflowFieldValue(binding, value.value)
    if (problem) {
      /** 必填文本、字段类型与数值约束分别保留准确诊断，不能统一冒充数值越界。 */
      const code = typeof value.value === 'string' && binding.field?.required && !value.value.trim()
        ? 'INPUT_REQUIRED'
        : typeof value.value === 'number' && binding.field?.valueKind === 'number'
          ? 'INPUT_RANGE_INVALID'
          : 'INPUT_TYPE_INVALID'
      throw inputError(code, binding, problem)
    }
  }
}

/** 给既有图片目录注入媒体 profile，不复制配置或凭据。 */
export function createMediaImageCatalog(configuration: MediaConfigStore): ImageGenerationMediaCatalogAdapter {
  /** 在每次选择和创建时复核项目、版本和当前连接授权。 */
  const resolve = (projectId: string, selectionId: string): ComfySnapshot => {
    const match = /^media:([A-Za-z0-9][A-Za-z0-9_.-]{0,127}):([1-9][0-9]*)$/.exec(selectionId)
    if (!match) throw new Error('MEDIA_PROFILE_SELECTION_INVALID')
    const resolved = configuration.resolveProfile(match[1]!, Number(match[2]), projectId)
    if (resolved.profile.mediaKind !== 'image') throw new Error('MEDIA_PROFILE_TYPE_INVALID')
    assertImageWorkflow(resolved.workflow)
    return snapshot(resolved.profile, resolved.workflow)
  }
  return {
    listOptions(projectId): Array<Extract<ImageGenerationModelOption, { executor: 'comfyui' }>> {
      const catalog = configuration.listProject(projectId)
      const latest = new Map<string, MediaProfile>()
      for (const profile of catalog.profiles) if (!latest.has(profile.id) || latest.get(profile.id)!.revision < profile.revision) latest.set(profile.id, profile)
      return [...latest.values()].filter((profile) => profile.mediaKind === 'image').map((profile) => {
        const workflow = configuration.getWorkflow(profile.workflowId, profile.workflowRevision, projectId)
        const value = snapshot(profile, workflow)
        try { resolve(projectId, value.profileId); return { ...value, available: true } }
        catch { return { ...value, available: false, unavailableReason: '媒体预设或连接当前不可用，请检查媒体配置' } }
      })
    },
    resolveAvailableSnapshot: resolve,
    resolveAvailableWorkflowSnapshot(projectId: string, selection: CanvasImageMediaWorkflow): WorkflowSnapshot {
      /** 图片节点只允许公共或当前项目工作流，禁止跨项目读取草稿。 */
      const workflow = configuration.getWorkflow(selection.workflowId, selection.workflowRevision, projectId)
      if (workflow.projectId !== null && workflow.projectId !== projectId) throw new Error('MEDIA_IMAGE_WORKFLOW_MUST_BE_PUBLIC')
      assertImageWorkflow(workflow)
      /** 快照是 Job 的输入合同，先本地拒绝不完整或过期字段，避免创建后才失败。 */
      assertWorkflowSelectionInputs(workflow.definition, selection.inputs)
      /** 新任务绑定当前启用实例代次，后续连接编辑不得把历史任务改派。 */
      const connection = configuration.resolveConnection(selection.connectionId, projectId).connection
      return {
        executor: 'comfyui',
        source: 'workflow',
        name: workflow.name,
        modelId: `${workflow.id}@${workflow.revision}`,
        connectionId: connection.id,
        instanceGeneration: connection.instanceGeneration,
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        workflowHash: workflow.hash,
        inputs: structuredClone(selection.inputs),
      }
    },
    assertSnapshotAvailable(projectId, value): void {
      if ('source' in value && value.source === 'workflow') {
        const workflow = configuration.getWorkflow(value.workflowId, value.workflowRevision, projectId)
        if ((workflow.projectId !== null && workflow.projectId !== projectId)
          || workflow.hash !== value.workflowHash) throw new Error('MEDIA_WORKFLOW_SNAPSHOT_CHANGED')
        assertImageWorkflow(workflow)
        const connection = configuration.resolveConnectionVersion(value.connectionId, value.instanceGeneration).connection
        if (connection.id !== value.connectionId || connection.instanceGeneration !== value.instanceGeneration) {
          throw new Error('MEDIA_CONNECTION_CHANGED')
        }
        return
      }
      const current = resolve(projectId, value.profileId)
      if (current.mediaProfileId !== value.mediaProfileId || current.mediaProfileRevision !== value.mediaProfileRevision
        || current.connectionId !== value.connectionId || current.workflowId !== value.workflowId || current.workflowRevision !== value.workflowRevision
        || current.workflowHash !== value.workflowHash) throw new Error('MEDIA_PROFILE_SNAPSHOT_CHANGED')
    },
  }
}
