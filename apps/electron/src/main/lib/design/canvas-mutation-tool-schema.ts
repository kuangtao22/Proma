import { Type } from 'typebox'

/** Agent 工具使用的稳定 ID；与 Store 的画布路径安全字符集保持一致。 */
const STABLE_ID_SCHEMA = Type.String({
  minLength: 1,
  pattern: '^[A-Za-z0-9_-]+$',
})

/** Canvas 身份进入路径解析前保持现有工具边界，避免异常长路径片段。 */
const CANVAS_ID_SCHEMA = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' })

/** 来源端口只接受 Store 支持的稳定 ID 或公开产物能力。 */
const SOURCE_PORT_SCHEMA = Type.Union([
  STABLE_ID_SCHEMA,
  Type.Literal('agent.text'),
  Type.Literal('image.asset'),
  Type.Literal('audio.asset'),
  Type.Literal('video.asset'),
  Type.Literal('document.markdown'),
  Type.Literal('webview.html'),
])

/** 目标端口只接受 Store 支持的稳定 ID 或公开输入槽。 */
const TARGET_PORT_SCHEMA = Type.Union([
  STABLE_ID_SCHEMA,
  Type.Literal('context.text'),
  Type.Literal('context.image'),
  Type.Literal('context.audio'),
  Type.Literal('context.video'),
  Type.Literal('image.reference'),
  Type.Literal('audio.reference'),
  Type.Literal('video.reference'),
])

/** 有限二维坐标；TypeBox number 会拒绝 NaN 与 Infinity。 */
const POINT_SCHEMA = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
}, { additionalProperties: false })

/** 结构 mutation 可携带的上游变更提示，不包含 Host 运行状态。 */
const UPSTREAM_CHANGE_SCHEMA = Type.Object({
  sourceNodeIds: Type.Array(STABLE_ID_SCHEMA, {
    minItems: 1,
    maxItems: 128,
    uniqueItems: true,
    description: '必须按稳定 ID 升序排列，且不能重复。',
  }),
  changedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false })

/** 所有公开节点共用的展示与布局字段。 */
const NODE_BASE_PROPERTIES = {
  id: STABLE_ID_SCHEMA,
  title: Type.String({
    minLength: 1,
    maxLength: 120,
    pattern: '^[\\s\\S]*\\S[\\s\\S]*$',
  }),
  position: POINT_SCHEMA,
  upstreamChange: Type.Optional(UPSTREAM_CHANGE_SCHEMA),
}

/** Agent 只能提交结构身份，正式输出指针由 Host 完成流程维护。 */
const AGENT_NODE_SCHEMA = Type.Object({
  ...NODE_BASE_PROPERTIES,
  kind: Type.Literal('agent'),
  agentSessionId: STABLE_ID_SCHEMA,
}, { additionalProperties: false })

/** 图片采用状态由候选采用工具维护，结构 mutation 只携带模块身份。 */
const IMAGE_NODE_SCHEMA = Type.Object({
  ...NODE_BASE_PROPERTIES,
  kind: Type.Literal('image'),
  imageModuleId: STABLE_ID_SCHEMA,
}, { additionalProperties: false })

/** 音视频采用 revision 属于 Host 投影，不进入 Agent 结构合同。 */
function createMediaNodeSchema(kind: 'audio' | 'video') {
  return Type.Object({
    ...NODE_BASE_PROPERTIES,
    kind: Type.Literal(kind),
    mediaModuleId: STABLE_ID_SCHEMA,
  }, { additionalProperties: false })
}

/** 正文通过专用内容工具更新；结构 mutation 仅引用现有内容 revision。 */
const DOCUMENT_NODE_SCHEMA = Type.Object({
  ...NODE_BASE_PROPERTIES,
  kind: Type.Literal('document'),
  documentId: STABLE_ID_SCHEMA,
  contentRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false })

/** WebView 结构保留设备视口，HTML 正文仍由专用内容工具维护。 */
const WEBVIEW_NODE_SCHEMA = Type.Object({
  ...NODE_BASE_PROPERTIES,
  kind: Type.Literal('webview'),
  prototypeId: STABLE_ID_SCHEMA,
  contentRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  devicePreset: Type.Union([Type.Literal('desktop'), Type.Literal('mobile')]),
}, { additionalProperties: false })

/** Agent 可见的完整结构节点联合，不包含正式输出与媒体采用投影。 */
const CANVAS_AGENT_NODE_SCHEMA = Type.Union([
  AGENT_NODE_SCHEMA,
  IMAGE_NODE_SCHEMA,
  createMediaNodeSchema('audio'),
  createMediaNodeSchema('video'),
  DOCUMENT_NODE_SCHEMA,
  WEBVIEW_NODE_SCHEMA,
])

/** 精确边结构；实际端点存在性和端口兼容性继续由权威 Store 校验。 */
const CANVAS_EDGE_SCHEMA = Type.Object({
  id: STABLE_ID_SCHEMA,
  sourceNodeId: STABLE_ID_SCHEMA,
  sourcePort: SOURCE_PORT_SCHEMA,
  sourceOutputKey: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$',
  })),
  targetNodeId: STABLE_ID_SCHEMA,
  targetPort: TARGET_PORT_SCHEMA,
  relation: Type.Union([
    Type.Literal('association'),
    Type.Literal('reference'),
    Type.Literal('depends-on'),
    Type.Literal('derives'),
  ]),
}, { additionalProperties: false })

/** Agent 当前获准提交的结构 mutation；用户管理配置和 Host 状态不在联合内。 */
export const CANVAS_AGENT_STRUCTURE_MUTATION_SCHEMA = Type.Union([
  Type.Object({
    type: Type.Literal('upsert-edges'),
    edges: Type.Array(CANVAS_EDGE_SCHEMA),
  }, {
    additionalProperties: false,
    description: '新增或替换真实图边。必须使用 type="upsert-edges" 和 edges 数组；单条边不是 edge 字段。',
  }),
  Type.Object({
    type: Type.Literal('set-viewport'),
    viewport: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
      zoom: Type.Number({ exclusiveMinimum: 0 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('move-nodes'),
    positions: Type.Array(Type.Object({
      nodeId: STABLE_ID_SCHEMA,
      position: POINT_SCHEMA,
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('upsert-nodes'),
    nodes: Type.Array(CANVAS_AGENT_NODE_SCHEMA),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('remove-nodes'),
    nodeIds: Type.Array(STABLE_ID_SCHEMA, { uniqueItems: true }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('remove-edges'),
    edgeIds: Type.Array(STABLE_ID_SCHEMA, { uniqueItems: true }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('set-webview-device-preset'),
    nodeId: STABLE_ID_SCHEMA,
    devicePreset: Type.Union([Type.Literal('desktop'), Type.Literal('mobile')]),
  }, { additionalProperties: false }),
])

/** `canvas_apply_changes` 的完整参数合同，供 Provider 和真实 Pi 校验共用。 */
export const CANVAS_AGENT_MUTATION_SCHEMA = Type.Object({
  canvasId: CANVAS_ID_SCHEMA,
  baseRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  operations: Type.Array(CANVAS_AGENT_STRUCTURE_MUTATION_SCHEMA, {
    minItems: 1,
    maxItems: 128,
    description: '按数组顺序原子校验并提交；任一项失败时整批零写入。',
  }),
  destructiveIntent: Type.Optional(Type.Literal('explicit')),
}, { additionalProperties: false })

/** 加边失败后可直接照此修正的最小结构，不包含真实业务 ID。 */
export const CANVAS_UPSERT_EDGES_EXAMPLE = JSON.stringify({
  type: 'upsert-edges',
  edges: [{
    id: 'stable-edge-id',
    sourceNodeId: 'source-node-id',
    sourcePort: 'image.asset',
    targetNodeId: 'target-node-id',
    targetPort: 'context.image',
    relation: 'depends-on',
  }],
})
