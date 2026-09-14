import { CANVAS_READ_ONLY_TOOL_NAMES } from './canvas-agent-tool-policy'
import type { CanvasOrchestrationService, CanvasOrchestrationBranchAccess } from './canvas-orchestration-service'
import type { CanvasToolRunContext } from './canvas-tool-provider'
import type { CanvasDocument } from '@proma/shared'

/** 只读媒体工具使用固定集合，未知能力不能凭名称前缀获得权限。 */
const mediaReads = new Set(['media_list_workflows', 'media_list_resources', 'media_read_remote_workflow',
  'media_discover_workflows', 'media_list_api_models', 'media_get_node_schema', 'media_inspect_workflow',
  'media_match_assets', 'media_list_profiles', 'media_get_run', 'media_wait_run', 'media_list_assets',
  'media_list_sources', 'media_get_asset_file', 'canvas_get_image_candidates'])
/** 委托控制可在原任务运行中使用，不能被单一写入者守卫锁死。 */
const delegationTools = new Set(['canvas_delegate', 'canvas_get_orchestration', 'canvas_resume_orchestration', 'canvas_cancel_orchestration'])
/** 专业分支只准备受管产物；执行与采用由编排者统一完成。 */
const specialistWrites = new Set(['canvas_create_artifact', 'canvas_create_media', 'canvas_import_image',
  'canvas_update_artifact', 'canvas_update_image_config', 'canvas_update_media_config', 'canvas_apply_changes',
  'media_use_remote_workflow', 'media_import_remote_workflow', 'media_save_workflow_draft', 'media_save_local_workflow'])
/** 创建返回可信节点后再登记；创建前只需验证来源引用。 */
const creationTools = new Set(['canvas_create_artifact', 'canvas_create_media', 'canvas_import_image'])

/** 从 Host context 重建分支凭据，模型参数不能指定父会话和执行代次。 */
export function canvasOrchestrationBranch(context: CanvasToolRunContext): CanvasOrchestrationBranchAccess {
  if (!context.canvasAgentTarget || !context.canvasOrchestrationId || !context.canvasOrchestrationStepId
    || !context.canvasOrchestrationParentSessionId || !context.canvasOrchestrationUserMessageUuid) {
    throw new Error('CANVAS_ORCHESTRATION_ACCESS_DENIED')
  }
  return { target: context.canvasAgentTarget, parentSessionId: context.canvasOrchestrationParentSessionId,
    orchestrationId: context.canvasOrchestrationId, stepId: context.canvasOrchestrationStepId,
    startedAt: context.runStartedAt, userMessageUuid: context.canvasOrchestrationUserMessageUuid }
}

/** 每次工具执行 fresh-read 委托和专业范围；手动改图仍由既有 CAS 与产物版本检查保护。 */
export function createCanvasOrchestrationGuard(service: CanvasOrchestrationService, context: CanvasToolRunContext, loadCanvas?: () => CanvasDocument) {
  return (toolName: string, params: Record<string, unknown>): void => {
    /** 任务合同的内存协议不是业务图写入，执行期间可查询、交付和记录阻塞。 */
    const readOnly = CANVAS_READ_ONLY_TOOL_NAMES.has(toolName) || mediaReads.has(toolName)
    const canvasId = context.canvasAgentTarget?.canvasId ?? (typeof params.canvasId === 'string' ? params.canvasId : undefined)
    if (!context.canvasOrchestrationId) {
      /** 停止存量运行是解除双重占用的出口，实际所有者和显式取消意图仍由原工具验证。 */
      if (!canvasId || readOnly || delegationTools.has(toolName) || toolName === 'canvas_cancel_workflow') return
      const record = service.get({ projectId: context.projectId, canvasId })
      if (record && record.status !== 'completed' && record.status !== 'cancelled') throw new Error('CANVAS_ORCHESTRATION_OWNS_WRITES')
      return
    }
    if (!canvasId) throw new Error('CANVAS_ORCHESTRATION_ACCESS_DENIED')
    if (typeof params.canvasId === 'string' && params.canvasId !== canvasId) throw new Error('CANVAS_ORCHESTRATION_NODE_SCOPE')
    if (context.canvasAgentMode === 'canvas-orchestrator') {
      const record = service.assertActor({ projectId: context.projectId, canvasId, sessionId: context.sessionId,
        orchestrationId: context.canvasOrchestrationId, runStartedAt: context.runStartedAt })
      /** 旧整图入口可递归运行未登记的 Agent；编排必须通过受管步骤分派。 */
      if (['canvas_run_workflow', 'canvas_resume_workflow', 'media_execute_run'].includes(toolName)) {
        throw new Error('CANVAS_ORCHESTRATION_USE_MANAGED_EXECUTION')
      }
      if (record.request.intent === 'review' && !readOnly && !toolName.includes('orchestration')
        && !['canvas_update_plan', 'canvas_dispatch', 'canvas_review_step', 'canvas_create_artifact'].includes(toolName)) {
        throw new Error('CANVAS_ORCHESTRATION_REVIEW_ONLY')
      }
      if (record.request.intent === 'review' && toolName === 'canvas_create_artifact' && params.artifactType !== 'document') {
        throw new Error('CANVAS_ORCHESTRATION_REVIEW_ONLY')
      }
      return
    }
    const { record, step } = service.assertBranch(canvasOrchestrationBranch(context))
    if (readOnly) return
    if (!specialistWrites.has(toolName)) throw new Error('CANVAS_ORCHESTRATION_SPECIALIST_ONLY')
    if (record.request.intent === 'review'
      && (toolName !== 'canvas_create_artifact' || params.artifactType !== 'document')) throw new Error('CANVAS_ORCHESTRATION_REVIEW_ONLY')
    /** 上游结果可被读取和引用，但不能由下游专业分支改写。 */
    const readable = new Set([...record.request.referenceNodeIds, ...step.inputNodeIds, ...step.outputNodeIds,
      ...record.steps.filter(item => step.dependsOn.includes(item.id)).flatMap(item => item.outputNodeIds), step.agentNodeId!])
    const writable = new Set(step.outputNodeIds)
    if (creationTools.has(toolName)) {
      if (typeof params.sourceNodeId === 'string' && !readable.has(params.sourceNodeId)) throw new Error('CANVAS_ORCHESTRATION_NODE_SCOPE')
      return
    }
    if (typeof params.nodeId === 'string' && !writable.has(params.nodeId)) throw new Error('CANVAS_ORCHESTRATION_NODE_SCOPE')
    if (toolName === 'canvas_apply_changes') {
      /** 专业产物通过专用创建事务提交，结构入口只准本范围内的新增关联。 */
      const existingEdgeIds = new Set(loadCanvas?.().edges.map(edge => edge.id))
      if (!loadCanvas) throw new Error('CANVAS_ORCHESTRATION_NODE_SCOPE')
      if (!Array.isArray(params.operations) || params.operations.some(operation => {
        if (!operation || typeof operation !== 'object') return true
        const mutation = operation as Record<string, unknown>
        return mutation.type !== 'upsert-edges' || !Array.isArray(mutation.edges) || mutation.edges.some(edge => {
          if (!edge || typeof edge !== 'object') return true
          const relation = edge as Record<string, unknown>
          return typeof relation.id !== 'string' || existingEdgeIds.has(relation.id)
            || typeof relation.sourceNodeId !== 'string' || !readable.has(relation.sourceNodeId)
            || typeof relation.targetNodeId !== 'string' || !writable.has(relation.targetNodeId)
        })
      })) throw new Error('CANVAS_ORCHESTRATION_NODE_SCOPE')
    }
  }
}
