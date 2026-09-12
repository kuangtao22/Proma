import { createHash } from 'node:crypto'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { Static, TSchema } from 'typebox'
import { Value } from 'typebox/value'
import { CANVAS_WORKFLOW_MAX_DURATION_EXTENSION_MS, CANVAS_WORKFLOW_MAX_MEDIA_RUN_EXTENSION,
  CANVAS_WORKFLOW_RUN_NODE_LIMIT, parseAdoptCanvasImageCandidateBatchInput } from '@proma/shared'
import type { AdoptCanvasImageCandidateBatchInput } from '@proma/shared'
import type { CanvasToolRunContext } from './canvas-tool-provider'
import type { CanvasToolAccessFacade } from './canvas-tool-access-facade'

/** 新工具只接受稳定业务标识，路径必须走单独授权字段。 */
const stableId = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' })
/** 图片服务通常需要几十秒返回；等待上限覆盖正常长耗时，同时仍保持工具调用有界。 */
export const CANVAS_TASK_WAIT_MAX_MS = 60_000
/** 所有版本均为不可变引用，图片通过成功任务解析真实素材。 */
const versionReference = Type.Union([
  Type.Object({ kind: Type.Literal('image'), jobId: stableId }, { additionalProperties: false }),
  Type.Object({ kind: Type.Union([Type.Literal('document'), Type.Literal('webview')]), revision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
])
/** 列表统一提供有界分页，游标由主进程生成。 */
const pagination = { cursor: Type.Optional(Type.String({ maxLength: 2048 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }
/** 节点操作由当前项目和明确画布定位，不接受 session 或素材内部身份。 */
const nodeTarget = { canvasId: stableId, nodeId: stableId }
/** 现有意图约束继续用于覆盖、停止、重试和恢复等明确命令。 */
const explicitIntent = { intent: Type.Literal('explicit') }
/** 查询任务可分别分页尝试记录和日志；默认只读摘要。 */
const taskReadSchema = Type.Object({
  ...nodeTarget, jobId: stableId, ...pagination,
  waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: CANVAS_TASK_WAIT_MAX_MS })),
  logs: Type.Optional(Type.Object(pagination, { additionalProperties: false })),
}, { additionalProperties: false })
/** 停止和原快照重试共享精确任务身份。 */
const taskWriteSchema = Type.Object({ ...nodeTarget, jobId: stableId, ...explicitIntent }, { additionalProperties: false })
/** 版本列表在节点范围内分页。 */
const versionsSchema = Type.Object({ ...nodeTarget, ...pagination }, { additionalProperties: false })
/** 精确正文读取与图片预览使用相同版本引用。 */
const versionReadSchema = Type.Object({
  ...nodeTarget, version: versionReference, offset: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false })
/** 采用必须绑定图和配置/正文的双重基线。 */
const versionAdoptSchema = Type.Object({
  ...nodeTarget, version: versionReference, ...explicitIntent,
  expectedCanvasRevision: Type.Integer({ minimum: 0 }), expectedVersion: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
/** 候选批次采用严格复用 shared 的 all/succeeded 模式，并额外要求本轮明确意图。 */
const candidateBatchAdoptSchema = Type.Object({
  canvasId: stableId,
  batchId: stableId,
  mode: Type.Union([Type.Literal('all'), Type.Literal('succeeded')]),
  ...explicitIntent,
}, { additionalProperties: false })
/** 单项导出保持精确文件目标兼容。 */
const singleExportSchema = Type.Object({
  ...nodeTarget, version: versionReference, ...explicitIntent,
  destination: Type.Optional(Type.Union([
    Type.Object({ kind: Type.Literal('dialog') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('project'), relativePath: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }),
  ])),
  overwrite: Type.Optional(Type.Boolean()),
}, { additionalProperties: false })
/** 批量导出一次选择目录，最多十六项且文件名由 Host 派生。 */
const batchExportSchema = Type.Object({
  canvasId: stableId,
  items: Type.Array(Type.Object({ nodeId: stableId, version: versionReference }, { additionalProperties: false }), {
    minItems: 1, maxItems: 16,
  }),
  destination: Type.Optional(Type.Union([
    Type.Object({ kind: Type.Literal('dialog') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('project'), relativeDirectory: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }),
  ])),
  overwrite: Type.Optional(Type.Boolean()),
  ...explicitIntent,
}, { additionalProperties: false })
/** 项目路径仍需 Host 验证授权，外部目标由本轮可见窗口选择。 */
const exportSchema = Type.Union([singleExportSchema, batchExportSchema])
/** 回收区不接受模型提供的路径或原始节点 JSON。 */
const trashSchema = Type.Object({ canvasId: stableId, ...pagination }, { additionalProperties: false })
/** 恢复位置由用户意图给出，稳定内容身份由回收项解析。 */
const restoreSchema = Type.Object({
  canvasId: stableId, trashId: stableId, expectedRevision: Type.Integer({ minimum: 0 }),
  position: Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false }),
  ...explicitIntent,
}, { additionalProperties: false })
/** 重建不允许指定旧、新会话 ID。 */
const rebuildSchema = Type.Object({ ...nodeTarget, expectedRevision: Type.Integer({ minimum: 0 }), ...explicitIntent }, { additionalProperties: false })
/** 工作流详情绑定现有运行，不创建新的运行意图。 */
const workflowReadSchema = Type.Object({ canvasId: stableId, runId: stableId }, { additionalProperties: false })
/** 继续与取消均要求明确命令，运行代次由持久 Store 复核。 */
const workflowWriteSchema = Type.Object({ canvasId: stableId, runId: stableId, ...explicitIntent }, { additionalProperties: false })
/** 恢复沿用持久工作流的完整合同，扩额和定向重试须绑定原 revision 与幂等操作身份。 */
const workflowResumeSchema = Type.Object({
  canvasId: stableId, runId: stableId, ...explicitIntent,
  expectedRunRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  resumeOperationId: Type.Optional(Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9_-]+$' })),
  addDurationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: CANVAS_WORKFLOW_MAX_DURATION_EXTENSION_MS })),
  addMediaRuns: Type.Optional(Type.Integer({ minimum: 0, maximum: CANVAS_WORKFLOW_MAX_MEDIA_RUN_EXTENSION })),
  retryNodeIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
    maxItems: CANVAS_WORKFLOW_RUN_NODE_LIMIT, uniqueItems: true,
  })),
}, { additionalProperties: false })

/** 业务处理器必须在实际进入写锁及每个副作用前调用权限复核。 */
export interface CanvasOperationExecution {
  context: CanvasToolRunContext
  operationId: string
  validateAccess: () => void
  signal?: AbortSignal
}

/** 输入项目由当前运行派生；处理器只返回公开且有界的业务结果。 */
type CanvasOperationHandler<Input> = (
  input: Input & { projectId: string },
  execution: CanvasOperationExecution,
) => Promise<Record<string, unknown>>

/** 主进程候选批次 handler 只接收 shared 权威输入；工具意图由外层 schema 执法。 */
export type CanvasCandidateBatchAdoptHandler = (
  input: AdoptCanvasImageCandidateBatchInput,
  execution: CanvasOperationExecution,
) => Promise<Record<string, unknown>>

/** 每个工具独立装配，缺少业务处理器时不会向模型声明该能力。 */
export interface CanvasOperationToolHandlers {
  getTask?: CanvasOperationHandler<Static<typeof taskReadSchema>>
  cancelTask?: CanvasOperationHandler<Static<typeof taskWriteSchema>>
  retryTask?: CanvasOperationHandler<Static<typeof taskWriteSchema>>
  listVersions?: CanvasOperationHandler<Static<typeof versionsSchema>>
  readVersion?: CanvasOperationHandler<Static<typeof versionReadSchema>>
  adoptVersion?: CanvasOperationHandler<Static<typeof versionAdoptSchema>>
  adoptCandidateBatch?: CanvasCandidateBatchAdoptHandler
  exportArtifact?: CanvasOperationHandler<Static<typeof exportSchema>>
  listTrash?: CanvasOperationHandler<Static<typeof trashSchema>>
  restoreNode?: CanvasOperationHandler<Static<typeof restoreSchema>>
  rebuildAgent?: CanvasOperationHandler<Static<typeof rebuildSchema>>
  listWorkflows?: CanvasOperationHandler<Static<typeof trashSchema>>
  getWorkflow?: CanvasOperationHandler<Static<typeof workflowReadSchema>>
  resumeWorkflow?: CanvasOperationHandler<Static<typeof workflowResumeSchema>>
  cancelWorkflow?: CanvasOperationHandler<Static<typeof workflowWriteSchema>>
}

/** 对已脱敏摘要分页，游标绑定当前结果内容，历史变化后须重新读取首页。 */
export function paginateCanvasOperationRecords<Item>(
  items: Item[],
  scope: string,
  input: { limit?: number; cursor?: string },
): { entries: Item[]; nextCursor: string | null; total: number } {
  /** 稳定摘要同时隔离项目、节点、列表类型和当前历史事实。 */
  const key = createHash('sha256').update(scope).update(JSON.stringify(items)).digest('hex')
  let offset = 0
  if (input.cursor) {
    try {
      const cursor: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error('invalid')
      const record = cursor as Record<string, unknown>
      if (Object.keys(record).sort().join(',') !== 'key,offset' || record.key !== key
        || !Number.isSafeInteger(record.offset) || (record.offset as number) < 0
        || (record.offset as number) > items.length) throw new Error('invalid')
      offset = record.offset as number
    } catch { throw new Error('CANVAS_OPERATION_CURSOR_INVALID') }
  }
  /** 留出外层状态和游标空间，条数与序列化字节同时受限。 */
  const entries: Item[] = []
  const limit = Math.min(50, Math.max(1, input.limit ?? 20))
  while (offset + entries.length < items.length && entries.length < limit) {
    const candidate = items[offset + entries.length]!
    if (Buffer.byteLength(JSON.stringify([...entries, candidate]), 'utf8') > 48 * 1024) break
    entries.push(candidate)
  }
  if (offset < items.length && entries.length === 0) throw new Error('CANVAS_OPERATION_ENTRY_TOO_LARGE')
  const nextOffset = offset + entries.length
  return {
    entries, total: items.length,
    nextCursor: nextOffset < items.length
      ? Buffer.from(JSON.stringify({ key, offset: nextOffset }), 'utf8').toString('base64url')
      : null,
  }
}

/** 任务/版本/恢复工具共用输入与运行权限检查，业务仍由各领域服务负责。 */
export function createCanvasOperationTools(
  handlers: CanvasOperationToolHandlers,
  context: CanvasToolRunContext,
  access: Pick<CanvasToolAccessFacade, 'authorizeRead' | 'requireLinkedCanvas'>,
  createOperationId: (toolCallId: string) => string,
  /** 调用开始时捕获 Host 创建回执，不能在异步执行后追认任务范围。 */
  getExecutionContext: () => CanvasToolRunContext = () => context,
): ToolDefinition[] {
  /** 将一项已装配处理器转成 Pi 工具，保留 TypeBox 参数推断。 */
  const define = <Schema extends TSchema>(
    name: string,
    label: string,
    description: string,
    parameters: Schema,
    handler: CanvasOperationHandler<Static<Schema>> | undefined,
    mutates: boolean,
  ): ToolDefinition[] => {
    if (!handler) return []
    return [{
      name, label, description, parameters,
      execute: async (toolCallId, rawParams, signal) => {
        if (!Value.Check(parameters, rawParams)) throw new Error('CANVAS_OPERATION_INPUT_INVALID')
        /** SDK 和直接调用均重建严格 schema，拒绝未声明的项目及路径字段。 */
        const params = rawParams as Static<Schema> & { canvasId: string }
        if (mutates && context.permissionCeiling !== 'execute') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        /** 闭包只捕获固定身份，权限事实每次 fresh-read。 */
        const validateAccess = (): void => {
          if (signal?.aborted) throw new Error('CANVAS_OPERATION_CANCELLED')
          access.authorizeRead(context)
          access.requireLinkedCanvas(context, params.canvasId)
        }
        validateAccess()
        const executionContext = getExecutionContext()
        try {
          const details = await handler({ ...params, projectId: context.projectId }, {
            context: executionContext, operationId: createOperationId(toolCallId), validateAccess,
            ...(signal ? { signal } : {}),
          })
          /** 异步读取期间可能收到取消或解绑；响应前再次验证，避免发布过期权限下的结果。 */
          validateAccess()
          /** 只有领域层确认新建的 replacement 才属于本轮，重放旧重试不签发创建来源。 */
          if (name === 'canvas_retry_task' && details.created === true && typeof details.replacementJobId === 'string'
            && typeof params.nodeId === 'string') {
            executionContext.onImageJobsCreated?.(params.canvasId, [{ nodeId: params.nodeId, jobId: details.replacementJobId }])
          }
          /** 响应总预算是最后一道防线；各业务服务应在读取时限制正文和日志。 */
          const text = JSON.stringify(details)
          if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('CANVAS_OPERATION_RESPONSE_TOO_LARGE')
          return { content: [{ type: 'text' as const, text }], details }
        } catch (error) {
          /** 未知底层错误不得把磁盘路径、渠道凭据或原始异常带进模型上下文。 */
          const code = error instanceof Error && /^(CANVAS|AGENT_SESSION|DESIGN)_[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : 'CANVAS_OPERATION_FAILED'
          throw new Error(code)
        }
      },
    }]
  }
  /** 工具层剥离 intent 后调用 shared exact-key parser，防止 IPC handler 接收平行合同。 */
  const adoptCandidateBatch: CanvasOperationHandler<Static<typeof candidateBatchAdoptSchema>> | undefined
    = handlers.adoptCandidateBatch
      ? async (input, execution) => handlers.adoptCandidateBatch!(
          parseAdoptCanvasImageCandidateBatchInput({
            projectId: input.projectId,
            canvasId: input.canvasId,
            batchId: input.batchId,
            mode: input.mode,
          }),
          execution,
        )
      : undefined
  return [
    ...define('canvas_get_task', '查看图片任务', `查看指定节点任务的真实状态、尝试、最终提示词和按需日志，不重新生成。waitMs 可在 0 到 ${CANVAS_TASK_WAIT_MAX_MS} 毫秒内等待同一 job 进入终态；超时且仍在运行时继续用同一 job 查询，成功后再看图，失败时报告真实 error。`, taskReadSchema, handlers.getTask, false),
    ...define('canvas_cancel_task', '停止图片任务', '停止明确指定的现有任务；返回实际终态，不保证远端已取消或费用退回。', taskWriteSchema, handlers.cancelTask, true),
    ...define('canvas_retry_task', '重试图片任务', '按原任务固化模型、提示词和输入重试，可能产生模型费用；返回 replacementJobId 后必须调用 canvas_get_task 并沿同一 replacementJobId 等待真实终态。', taskWriteSchema, handlers.retryTask, true),
    ...define('canvas_list_versions', '查看产物版本', '分页列出节点可用版本及当前采用状态，为检查和明确采用提供准确引用。', versionsSchema, handlers.listVersions, false),
    ...define('canvas_read_version', '读取历史正文', '读取指定文档或 WebView 版本正文；图片请用 canvas_inspect_images 精确看图。', versionReadSchema, handlers.readVersion, false),
    ...define('canvas_adopt_version', '采用产物版本', '按明确意图采用精确图片、文档或 WebView 版本，校验当前图及配置/正文 revision；不会自动继续生成。', versionAdoptSchema, handlers.adoptVersion, true),
    ...define('canvas_adopt_candidate_batch', '采用图片候选批次', '按明确意图原子采用候选批次；all 要求全部条目成功，succeeded 采用当前全部成功候选，不接受模型自选任意子集。', candidateBatchAdoptSchema, adoptCandidateBatch, true),
    ...define('canvas_export_artifact', '导出画布产物', '导出一个精确版本，或一次选择目录批量导出最多十六个精确版本；已有文件需要明确覆盖。', exportSchema, handlers.exportArtifact, true),
    ...define('canvas_list_trash', '查看画布回收区', '分页读取当前画布可恢复内容节点的稳定回收标识，不暴露内部路径。', trashSchema, handlers.listTrash, false),
    ...define('canvas_restore_node', '恢复画布节点', '按明确意图恢复指定回收项；校验图版本并保留可恢复事务。', restoreSchema, handlers.restoreNode, true),
    ...define('canvas_rebuild_agent', '重建异常 Agent', '对已诊断异常且当前空闲的 Agent 节点重建会话，禁止直接指定或修改会话身份。', rebuildSchema, handlers.rebuildAgent, true),
    ...define('canvas_list_workflows', '查看画布工作流', '分页查询当前画布持久工作流，包含等待采用和可以继续的运行。', trashSchema, handlers.listWorkflows, false),
    ...define('canvas_get_workflow', '查看工作流状态', '查看指定原运行的节点状态与剩余预算，不启动执行。', workflowReadSchema, handlers.getWorkflow, false),
    ...define('canvas_resume_workflow', '继续原工作流', '在原授权和剩余预算内继续已有运行。定向重试或扩额需 expectedRunRevision 与稳定 resumeOperationId，同次恢复重用身份；正数扩额需确认。未知提交先查询原任务，不重复生成。', workflowResumeSchema, handlers.resumeWorkflow, true),
    ...define('canvas_cancel_workflow', '停止工作流', '停止指定原运行，保留已生成产物并阻止迟到采用事件重新启动。', workflowWriteSchema, handlers.cancelWorkflow, true),
  ]
}
