import type { CanvasImageMediaWorkflow, ImageGenerationModelOption, ImageGenerationModelSnapshot, MediaProfile, MediaWorkflowVersion } from '@proma/shared'
import type { ImageGenerationMediaCatalogAdapter } from '../image-generation-model-catalog'
import type { MediaConfigStore } from './media-config-store'

/** Comfy 预设仍保存在统一媒体目录，旧图片选择器只读取轻量投影。 */
type ComfySnapshot = Extract<ImageGenerationModelSnapshot, { executor: 'comfyui'; profileId: string }>
/** 公共工作流直接执行的独立图片快照。 */
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
      /** 图片节点只暴露公共工作流；项目草稿继续由通用媒体节点管理。 */
      const workflow = configuration.getWorkflow(selection.workflowId, selection.workflowRevision, projectId)
      if (workflow.projectId !== null) throw new Error('MEDIA_IMAGE_WORKFLOW_MUST_BE_PUBLIC')
      assertImageWorkflow(workflow)
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
        if (workflow.projectId !== null || workflow.hash !== value.workflowHash) throw new Error('MEDIA_WORKFLOW_SNAPSHOT_CHANGED')
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
