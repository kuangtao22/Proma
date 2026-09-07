import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { CanvasImageCandidateBatch, CanvasTarget } from '@proma/shared'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import { createCanvasImageCandidateHash } from './canvas-image-candidate-batch-service'
import type { CanvasToolProviderDependencies, CanvasToolRunContext } from './canvas-tool-provider'

/** 候选只读检查和明确采用共用的工具名称。 */
export const CANVAS_IMAGE_CANDIDATE_TOOL_NAMES = ['canvas_get_image_candidates', 'canvas_adopt_image_candidates'] as const

/** 复用现有图片检查的字节校验与压缩预算。 */
type PrepareThumbnail = (thumbnail: Awaited<ReturnType<CanvasToolProviderDependencies['images']['readThumbnail']>>) => Promise<{
  thumbnail?: Awaited<ReturnType<CanvasToolProviderDependencies['images']['readThumbnail']>>
  failure?: 'image-unavailable' | 'image-too-large'
}>

/** 保留 schema 对每个工具参数的静态推断，不引入开放参数类型。 */
function defineCandidateTool<TParams extends TSchema>(tool: ToolDefinition<TParams>): ToolDefinition<TParams> {
  return tool
}

/** 候选摘要不携带文件路径、素材标识或供应商错误正文。 */
function summarizeBatch(batch: CanvasImageCandidateBatch): Record<string, unknown> {
  return {
    canvasId: batch.canvasId, batchId: batch.batchId, status: batch.status,
    candidateHash: createCanvasImageCandidateHash(batch),
    entries: batch.entries.map((entry) => ({ nodeId: entry.nodeId, status: entry.status })),
    adoptedNodeIds: batch.adoption?.adoptedNodeIds ?? [],
    keptNodeIds: batch.adoption?.keptNodeIds ?? [],
  }
}

/** 为普通及固定画布 Agent 创建候选检查/采用工具；Host 依赖缺失时不注册。 */
export function createCanvasImageCandidateTools(
  dependencies: CanvasToolProviderDependencies,
  context: CanvasToolRunContext,
  prepareThumbnail: PrepareThumbnail,
): ToolDefinition[] {
  /** 仅闭包真实生产服务，不创建另一套候选状态。 */
  const candidates = dependencies.imageCandidates
  if (!candidates) return []
  /** 每次等待后重新校验会话、关联和批次中的节点身份。 */
  const authorize = (target: CanvasTarget, batch?: CanvasImageCandidateBatch): number => {
    dependencies.access.authorizeRead(context)
    dependencies.access.requireLinkedCanvas(context, target.canvasId)
    const document = dependencies.documents.load(target).document
    if (batch && (batch.projectId !== target.projectId || batch.canvasId !== target.canvasId
      || batch.entries.some((entry) => !document.nodes.some((node) => node.id === entry.nodeId
        && node.kind === 'image' && node.imageModuleId === entry.imageModuleId)))) {
      throw new Error('CANVAS_IMAGE_BATCH_CONFLICT')
    }
    return document.revision
  }
  return [
    defineCandidateTool({
      name: 'canvas_get_image_candidates', label: '检查图片候选',
      description: '查询精确批次的候选状态与选择指纹；可指定最多四个节点读取候选缩略图进行视觉检查，未指定则只返回状态。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        batchId: Type.String({ minLength: 1, maxLength: 160 }),
        inspectNodeIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 4 })),
      }),
      execute: async (_toolCallId, params) => {
        const target = { projectId: context.projectId, canvasId: params.canvasId }
        authorize(target)
        const nodeIds = params.inspectNodeIds ?? []
        if (nodeIds.length > 4 || new Set(nodeIds).size !== nodeIds.length) throw new Error('CANVAS_IMAGE_BATCH_LIMIT')
        const batch = await candidates.load({ ...target, batchId: params.batchId })
        const revision = authorize(target, batch)
        const content: Array<TextContent | ImageContent> = []
        const inspections: Array<{ nodeId: string; status: string }> = []
        for (const nodeId of nodeIds) {
          const entry = batch.entries.find((item) => item.nodeId === nodeId)
          if (!entry) throw new Error('CANVAS_IMAGE_CANDIDATE_NOT_FOUND')
          if (!entry.candidateAssetId || !['candidate', 'adopted'].includes(entry.status)) {
            inspections.push({ nodeId, status: 'candidate-unavailable' })
            continue
          }
          try {
            const thumbnail = await dependencies.images.readThumbnail(context.projectId, entry.candidateAssetId)
            const prepared = await prepareThumbnail(thumbnail)
            if (!prepared.thumbnail) {
              inspections.push({ nodeId, status: prepared.failure ?? 'image-unavailable' })
              continue
            }
            inspections.push({ nodeId, status: 'ready' })
            content.push({ type: 'text', text: JSON.stringify({ nodeId, batchId: batch.batchId }) },
              { type: 'image', data: prepared.thumbnail.bytes.toString('base64'), mimeType: prepared.thumbnail.mediaType })
          } catch {
            inspections.push({ nodeId, status: 'image-unavailable' })
          }
        }
        authorize(target, batch)
        const fresh = await candidates.load({ ...target, batchId: params.batchId })
        if (authorize(target, fresh) !== revision || createCanvasImageCandidateHash(fresh) !== createCanvasImageCandidateHash(batch)) {
          throw new Error('CANVAS_IMAGE_CANDIDATES_CHANGED')
        }
        const details = { ...summarizeBatch(fresh), revision, inspections,
          imageCount: inspections.filter((entry) => entry.status === 'ready').length }
        return { content: [{ type: 'text', text: JSON.stringify(details) }, ...content], details }
      },
    }),
    defineCandidateTool({
      name: 'canvas_adopt_image_candidates', label: '采用图片候选',
      description: '采用查询得到的精确候选指纹；all 要求整批成功，succeeded 明确保留其余旧版本。只在用户已授权采用或自动推进的任务中调用，采用后可恢复原工作流。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        batchId: Type.String({ minLength: 1, maxLength: 160 }),
        candidateHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
        mode: Type.Union([Type.Literal('all'), Type.Literal('succeeded')]),
      }),
      execute: async (_toolCallId, params) => {
        const target = { projectId: context.projectId, canvasId: params.canvasId }
        authorize(target)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        return dependencies.access.runWrite(context, async () => {
          authorize(target)
          const batch = await candidates.load({ ...target, batchId: params.batchId })
          authorize(target, batch)
          const adopted = await candidates.adopt({ ...target, batchId: params.batchId, mode: params.mode },
            params.candidateHash, () => { authorize(target, batch) })
          const details = summarizeBatch(adopted)
          return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
        })
      },
    }),
  ] as ToolDefinition[]
}
