import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { Static, TSchema } from 'typebox'
import { Value } from 'typebox/value'

/** 音视频内容检查与评审工具的稳定名称，供 Provider 加入只读能力清单。 */
export const CANVAS_MEDIA_REVIEW_TOOL_NAMES = [
  'canvas_inspect_media_content',
  'canvas_review_media',
] as const

/** 画布和节点只接受安全业务 ID，不允许路径及其它资源定位符。 */
const SAFE_ID_SCHEMA = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
})

/** 内容检查只定位当前画布中的单个已采用媒体节点。 */
const INSPECTION_SCHEMA = Type.Object({
  canvasId: SAFE_ID_SCHEMA,
  nodeId: SAFE_ID_SCHEMA,
}, { additionalProperties: false })

/** 评审必须绑定真实检查证据，并明确声明结论与实际覆盖范围。 */
const REVIEW_SCHEMA = Type.Object({
  canvasId: SAFE_ID_SCHEMA,
  nodeId: SAFE_ID_SCHEMA,
  inspectionEvidenceId: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  verdict: Type.Union([Type.Literal('passed'), Type.Literal('failed')]),
  coverage: Type.Union([Type.Literal('sampled'), Type.Literal('full')]),
  notes: Type.String({ maxLength: 2_048 }),
}, { additionalProperties: false })

/** 读取已采用媒体并生成有界内容样本的严格输入。 */
export type CanvasMediaInspectionInput = Static<typeof INSPECTION_SCHEMA>

/** 将 Agent 判断绑定到现有检查证据的严格输入。 */
export type CanvasMediaReviewInput = Static<typeof REVIEW_SCHEMA>

/** 工具只负责输入边界与取消传递，真实读取和证据持久化由 Host 回调负责。 */
export interface CanvasMediaReviewToolDependencies {
  inspect: (input: CanvasMediaInspectionInput, signal: AbortSignal) => Promise<AgentToolResult<unknown>>
  review: (input: CanvasMediaReviewInput, signal: AbortSignal) => Promise<AgentToolResult<unknown>>
}

/** 保留 TypeBox schema 对工具 execute 参数的静态推断。 */
function defineMediaReviewTool<Schema extends TSchema>(
  tool: ToolDefinition<Schema>,
): ToolDefinition<Schema> {
  return tool
}

/** 校验并重建声明字段，拒绝 SDK 之外的直接调用绕过固定 schema。 */
function parseInput<Schema extends TSchema>(
  schema: Schema,
  input: unknown,
): Static<Schema> {
  if (!Value.Check(schema, input)) throw new Error('CANVAS_MEDIA_REVIEW_INPUT_INVALID')
  return structuredClone(input) as Static<Schema>
}

/** 创建只读媒体检查能力；review 仅追加任务证据，不修改或采用媒体。 */
export function createCanvasMediaReviewTools(
  dependencies: CanvasMediaReviewToolDependencies,
): ToolDefinition[] {
  return [
    defineMediaReviewTool({
      name: 'canvas_inspect_media_content',
      label: '检查音视频内容',
      description: '读取画布节点真实已采用的音视频，执行技术解码并生成有界抽样供内容检查。元数据或成功解码不等于完整观看；工具只读媒体，不修改媒体。',
      parameters: INSPECTION_SCHEMA,
      execute: async (_toolCallId, input, signal) => {
        /** 只向 Host 传递固定字段与当前调用的同一取消信号。 */
        const parsed = parseInput(INSPECTION_SCHEMA, input)
        return dependencies.inspect(parsed, signal ?? new AbortController().signal)
      },
    }),
    defineMediaReviewTool({
      name: 'canvas_review_media',
      label: '记录音视频评审',
      description: '记录 Agent 基于实际已收到样本作出的内容评审，只写任务证据，不修改媒体。抽样不能冒充完整观看；当前只支持 sampled，full 请求由 Host 按真实能力明确拒绝。',
      parameters: REVIEW_SCHEMA,
      execute: async (_toolCallId, input, signal) => {
        /** 证据身份、结论、覆盖范围和备注均由严格 schema 重建后传入 Host。 */
        const parsed = parseInput(REVIEW_SCHEMA, input)
        return dependencies.review(parsed, signal ?? new AbortController().signal)
      },
    }),
  ] as ToolDefinition[]
}
