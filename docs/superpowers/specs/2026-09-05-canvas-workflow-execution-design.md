# Canvas Agent 与工作流执行设计

日期：2026-09-05

## 结论

Proma 下一阶段为普通 Agent 补齐两个显式执行能力：启动单个 Canvas Agent，以及从指定起点按依赖关系运行一次可达下游工作流。普通 Agent继续作为唯一 Orchestrator；Canvas 连线仍只表达数据与任务关系，不成为后台触发器。

本阶段采用独立 `CanvasAgentExecutionService` 与 `CanvasWorkflowExecutionService`，新增 `canvas_update_agent_config`、`canvas_run_agent` 和 `canvas_run_workflow` 三个普通 Agent 工具。现有 `canvas_run_nodes` 继续只负责图片批量执行，不扩张为混合工作流入口。

普通 Agent 可以控制当前项目已关联画布中的全部受支持节点，但只能调用按节点类型公开的能力，不能修改会话 ID、素材路径、版本指针、任务 ID、权限上限等内部字段。视频节点和视频执行器不在本阶段实现。

## 当前问题

现有画布工具已经支持：

- 创建 Canvas Agent、图片、文档和 WebView 节点；
- 修改图结构、关系、文档、HTML 与图片生成配置；
- 运行图片节点；
- 从 Canvas Agent 工作台由 Renderer 发消息启动该节点。

但完整生产链路仍有四个断点：

1. 普通 Agent 没有主进程工具可以主动启动 Canvas Agent；
2. `canvas_run_nodes` 对 Agent、文档和 WebView 只返回 `idle`，不会推进下游；
3. Canvas Agent 的回复只在内部会话中，`canvas_read` 读取 Agent 节点时拿不到真实输出，下游只能看到标题；
4. Canvas Agent 没有持久的职责、默认模型与专业 Skill 配置，无法成为可重复使用的专业节点。

这意味着普通 Agent 能搭图，却不能可靠执行图；即使手动运行上游 Agent，下游 Agent 也没有稳定的真实输入。

## 目标体验

用户在普通对话中要求“用画布策划并生成一套小红书视频方案”。普通 Agent 可以：

1. 创建并配置策划、文案、分镜和视觉检查等 Canvas Agent；
2. 为节点绑定用户安装的专业 Skills；
3. 创建文档、图片和 WebView 产物并建立类型化关系；
4. 在用户明确要求执行后，从指定策划节点启动一次工作流；
5. 自动等待上游 Agent 完成，再把其正式输出交给可达下游；
6. 对图片执行使用一次有上限的审批，图片完成后停在“有新版本”状态；
7. 等待用户在历史版本中设为默认，再从待更新节点继续执行。

用户不需要手动逐个打开 Agent 节点并发送消息，也不会因为画布中存在连线而产生后台调用或意外费用。

## 设计原则

### 普通 Agent 是唯一 Orchestrator

普通 Agent 决定本次目标、起点、执行范围、专业节点和预算。Canvas Agent 只完成自身职责并在固定画布内创建或更新产物，不启动其它 Agent，不递归运行整套工作流。

### 能力按节点类型开放

“控制任何节点”不等于允许修改任意 JSON 字段。Host 通过节点能力注册表公开和校验操作：

| 节点 | 普通 Agent 可用能力 | 本阶段限制 |
| --- | --- | --- |
| Agent | 创建、配置、读取正式输出、运行 | 运行中的停止由父运行取消链路统一处理 |
| 图片 | 创建、读取、设置提示词/模型/比例/尺寸/上下文、运行 | 候选不自动采用 |
| 文档 | 创建、读取、更新正文与版本 | 不作为独立模型执行器运行 |
| WebView | 创建、读取、更新 HTML、设备预设与版本 | 创建后即可预览，不调用运行工具 |
| 视频 | 无 | 等视频执行器规格完成后接入 |

`canvas_read` 返回每个节点当前可用的有限 `capabilities`，帮助 Agent 选择正确工具；真实权限仍由对应工具和主进程再次校验，不能信任模型传回的 capability 文本。

### 连线只进入显式执行

`association` 只用于展示，不参与上下文、拓扑排序或待更新传播。`reference`、`depends-on` 和 `derives` 只有在 `sourcePort/targetPort` 与两端节点类型形成权威 `bound` 状态时才进入执行图。

待确认、端口不兼容或悬空关系在产生任何执行副作用前失败。系统不把历史通用连线自动升级为可执行关系。

### 正式采用版本是唯一输入

文档与 WebView 使用节点当前 `contentRevision`，图片使用当前 `adoptedAssetId`，Agent 使用节点当前固定的完成消息。图片候选和历史版本不进入下游上下文；采用后才标记直接下游待更新。

## 系统组件

### Canvas Node Capability Registry

能力注册表根据节点类型与当前状态派生公开操作，不把可变能力列表持久化到画布文档。新增节点类型时先注册能力与执行适配器，Orchestrator 协议无需按类型硬编码全部字段。

注册表负责：

- 向 `canvas_read` 投影 `read`、`update-config`、`run`、`review-required` 等有限动作；
- 在工作流预检中判断节点是执行节点、已满足的产物还是不支持节点；
- 为不支持动作返回稳定错误，不回退到通用结构 mutation 修改内部字段。

### Canvas Agent Config Store

Canvas Agent 的长期配置保存在 Canvas 受管目录，不写入全局 Skill 文件，也不把长文本塞入 `canvas.json`：

```text
agent-configs/<agent-node-id>/config.json
```

该独立受管根避免与 `nodes/<content-id>/` 的文档、图片和 WebView 内容身份碰撞。stable-directory helper 必须把 `agent-configs` 注册为只允许相对读写 `config.json` 的受管子目录；不得复用内容节点移动到 `trash` 的生命周期，也不得接受调用方传入路径片段。

配置合同固定为：

```ts
interface CanvasAgentConfig {
  schemaVersion: 1
  projectId: string
  canvasId: string
  nodeId: string
  revision: number
  instruction: string
  skillNames: string[]
  channelId: string | null
  modelId: string | null
  updatedAt: number
}
```

约束如下：

- `instruction` 最多 8 KiB；
- `skillNames` 最多 16 项，每项使用稳定 Skill 名称；
- `channelId=null` 时 `modelId` 必须同时为 `null`，表示每次运行继承内部 Agent session 当前渠道与模型；
- `channelId!=null, modelId=null` 表示使用该启用渠道的默认模型，`channelId!=null, modelId!=null` 表示使用该渠道中指定的启用模型；不存在 `channelId=null, modelId!=null` 的合法状态；
- 配置 patch 合并后按完整 `channelId + modelId` 组合校验；切换渠道但要使用新渠道默认模型时，调用方必须显式传入 `modelId:null`，不能隐式保留旧渠道模型；
- 显式渠道与模型在保存和运行时都重新校验；继承 session 路由时在运行时校验 session 当前渠道与模型，失效则阻断；
- Skill 在运行时按当前已安装、已启用状态重新解析，缺失或停用时明确阻断，不静默忽略；
- 第三方 Skill 只提供提示与工作方法，不扩大 Canvas 工具权限，不注册任意执行代码，不绕过审批；
- 历史 Agent 节点缺少配置文件时读取为 revision 0 的空职责、空 Skills，并沿用内部会话当前模型；首次修改时原子创建配置；
- 所有写入使用 Canvas 稳定目录能力与原子提交，不接受 Renderer 或 Agent 传入绝对路径。

`canvas_update_agent_config` 使用 Canvas graph revision 与 config revision 双基线做局部 patch。未传字段保持不变，禁止用通用 `canvas_apply_changes` 改写该文件。

### Agent 正式输出投影

`CanvasAgentNode` 增加可选的 `outputPointer` 字段，画布中不新增任何 Agent 回复正文字段：

```ts
interface CanvasAgentOutputPointer {
  messageUuid: string
  contentSha256: string
  completedAt: number
}

interface CanvasAgentNode extends CanvasNodeBase {
  kind: 'agent'
  agentSessionId: string
  outputPointer?: CanvasAgentOutputPointer
}
```

Agent 回复正文继续只保存在其内部 SDK JSONL。节点只保存 UUID、正文哈希和完成时间，作用等同于文档的 `contentRevision` 与图片的 `adoptedAssetId`。

Agent 成功完成后，执行服务从本轮权威消息中选择最后一条非空 assistant 完成消息，计算哈希并提交输出指针。`canvas_read` 按节点、独占 session 归属、UUID 与哈希精确读取该消息，并应用现有正文预算；任一事实不一致时返回 `CANVAS_AGENT_OUTPUT_INVALID`，禁止回退到“最后一条任意消息”。

这项能力同时修复 Agent 到 Agent 的数据传递。标题、节点摘要和运行中 partial 文本都不能替代正式输出。

### Canvas Dependency State Service

依赖状态服务统一处理“当前节点已消费变化”和“当前节点产生新正式输出”两个动作：

1. 在成功提交当前节点新输出时移除该节点已有 `upstreamChange`；
2. 对当前权威图中所有 `bound` 的直接数据下游合并本节点 ID；
3. 排除 `association`、待确认与不兼容边；
4. 在同一 Canvas serializer 与 workspace write lease 内原子提交；
5. lease 释放后广播准确 graph revision。

Agent 输出提交、文档/WebView 当前 revision 更新或采用、图片正式采用都复用该服务。候选生成、草稿编辑失败和运行中 partial 输出不得传播待更新。

### Canvas Agent Execution Service

该服务成为启动 Canvas Agent 的唯一主进程业务入口。服务显式接收 `mode: 'renderer-manual' | 'parent-orchestrated'`；Renderer 的 `SEND_AGENT_MESSAGE` 和普通 Agent 的 `canvas_run_agent` 都通过它执行共同流程：

1. 对账 Canvas pending intent；
2. 从权威图解析 Agent 节点；
3. 复核内部会话的 `projectId + canvasId + nodeId` 独占归属；
4. 校验节点配置、模型与 Skills；
5. 只注入 `bound` 的直接入边正式引用；
6. 预留 Agent session 启动槽；
7. 通过 Pi Agent Runtime 启动并等待本轮终态；
8. 成功时提交正式输出指针并传播直接下游待更新；
9. 失败、停止或无有效 assistant 输出时不更新正式输出。

普通 Agent 发起的运行使用主进程内部 headless 路径，不依赖 Canvas 工作台是否挂载。它使用节点长期 `instruction`、本轮任务、当前节点标题和直接输入构造可信运行上下文；用户内容全部按数据编码，不允许节点标题或上游正文破坏系统提示边界。

- `renderer-manual` 保持现有 Canvas Agent 工作台能力与审批路径：会话仍固定到当前画布，允许现有的受控 `canvas_run_nodes`，用户可继续通过 Renderer 的既有 STOP IPC 停止本轮；
- `parent-orchestrated` 不提供 `canvas_run_agent`、`canvas_run_workflow`、`canvas_manage`、`canvas_create_agent` 或 `canvas_run_nodes`，只允许在固定画布内读取输入，创建或修改图片配置、文档和 WebView；
- 服务本身不公开 `stop` capability。父 Agent 启动的运行由父运行取消信号精确终止，手动运行由既有 Renderer STOP 完成。

两种模式共享归属、配置、输入和正式输出提交逻辑，但工具集合必须在主进程按可信 mode 生成，不能由 Renderer、父 Agent 或节点配置选择。这样避免递归 Orchestrator、跨画布扩权与嵌套付费审批，同时不削弱现有手动工作台。

### Canvas Workflow Execution Service

工作流服务只运行一次显式请求，不常驻监听画布。输入合同固定为：

```ts
interface CanvasRunWorkflowInput {
  canvasId: string
  expectedRevision: number
  startNodeIds: string[]
  goal: string
  maxImageRuns: number
}
```

`startNodeIds` 是本次执行根。服务只处理从这些根沿 `bound` 数据边可达的子图，不运行同一画布中的独立分支。

`maxImageRuns` 是本次审批允许的图片任务上限，取值 0 到 16。运行期间 Canvas Agent 新建的图片节点只有在仍从根可达且总数不超过该上限时才能启动；超过上限的节点进入 `waiting-approval`，不能复用旧审批扩大费用范围。

## 工具合同

### canvas_update_agent_config

用于修改 Agent 节点的长期职责、默认 Skills 和默认模型。它不运行 Agent，不产生媒体费用，也不能更改内部 session、Canvas 归属或权限模式。

### canvas_run_agent

输入包含 `canvasId`、`nodeId`、`expectedRevision` 和本轮 `instruction`，可选临时追加一组 Skill 名称。长期配置先加载，本轮任务只影响本次消息，不回写长期职责。

工具等待子 Agent 终态，并返回：节点 ID、状态、正式输出指针、受影响下游节点 ID 和有限输出摘要。它不自动运行下游，也不允许子 Agent 生图。

### canvas_run_workflow

该工具执行可达子图并返回一次有界运行摘要。因为它可能批量启动 Agent 与付费图片任务，必须进入 `singleApprovalToolNames`。审批参数明确包含起点、目标与 `maxImageRuns`，审批只授权当前父 Agent run 和本次工具调用。

现有 `canvas_run_nodes` 保留为普通 Agent 显式运行已知图片节点的低层入口。工作流服务直接复用其主进程预检、稳定 Job ID、候选批次与启动服务，不在子 Agent 内再次调用工具，也不产生嵌套审批；`canvas_run_workflow` 的本次审批和 `maxImageRuns` 是唯一费用授权边界。

## 执行语义

### 预检

任何执行开始前，服务使用单次 `O(nodes + edges)` 索引完成：

- Canvas 关联、项目归属和 graph revision 校验；
- 起点存在性和节点类型校验；
- 可达子图构建；
- 端口绑定校验；
- 环检测与最大深度校验；
- Agent 数量、节点数量和图片预算校验；
- 已运行 session 与图片 Job 冲突检查。

初始可达图存在环、待确认边、端口不兼容、无效节点或预算越界时保持零执行副作用。

### 节点就绪规则

- 起点 Agent 总是执行一次；
- 下游 Agent 在没有正式输出、携带 `upstreamChange`，或由本轮已执行 Agent 新建时执行；
- 已有正式输出且没有待更新的下游 Agent 视为已满足，不重复调用模型；
- 文档与 WebView 当前采用 revision 可读时视为已满足，不作为独立模型步骤运行；
- 图片没有正式采用版本或携带 `upstreamChange` 时需要运行；
- 已有正式采用版本且没有待更新的图片视为已满足；
- 一个节点在同一次工作流中最多执行一次；
- 多个直接上游必须全部达到 `satisfied` 或 `completed`，目标节点才能进入就绪队列。

图片任务生成候选后，该图片节点进入 `waiting-review`。其下游以 `WAITING_FOR_IMAGE_ADOPTION` 阻断，直到用户在画布历史版本中显式设为默认。工作流不自动采用，也不继续使用旧正式图冒充新结果。

### 动态图变化

每批 Canvas Agent 完成后，服务重新读取权威画布并重新计算从原始根可达的子图。仅允许把满足以下条件的新节点纳入本轮：

- 节点仍从原始根通过 `bound` 数据边可达；
- 没有超过节点、深度、Agent 或图片预算；
- 新增关系没有形成环或待确认绑定；
- 原始根和已经完成节点没有被删除或改变身份。

并发编辑若只增加合法的可达低风险节点，可以被纳入；若改变已执行链路、删除根、制造环或扩大付费范围，则停止受影响分支并返回 `CANVAS_WORKFLOW_GRAPH_CHANGED`。已完成的其它分支与产物不回滚。

### 并发与预算

首版固定边界：

- 最多 32 个可达节点；
- 最多启动 8 个 Canvas Agent；
- 最大依赖深度 8；
- Canvas Agent 并发上限 2；
- 图片任务继续使用现有有界批量执行；
- 单次总时限 15 分钟；
- 同一 Canvas 同时只允许一份 `canvas_run_workflow`；
- 同一 Agent session 已运行时返回 `SESSION_BUSY`，不注入队列；
- 达到任何边界后返回部分结果，不自动扩大预算或无限重试。

普通 Agent 自定义工具的主进程请求默认只有 120 秒，本阶段只为 `canvas_run_agent` 与 `canvas_run_workflow` 增加独立 15 分钟超时。其它工具继续保持现有故障检测时限。

## 状态与返回结果

本阶段不建立完整 Plan/Run 持久化系统。单次工具返回使用有界结构：

```ts
type CanvasWorkflowStatus =
  | 'completed'
  | 'partial'
  | 'waiting-review'
  | 'failed'
  | 'cancelled'

type CanvasWorkflowNodeStatus =
  | 'satisfied'
  | 'started'
  | 'completed'
  | 'waiting-review'
  | 'waiting-approval'
  | 'blocked'
  | 'failed'
  | 'cancelled'
```

结果包含初始和最终 graph revision、每节点有限状态、图片候选批次摘要、失败/阻断稳定错误码，以及是否需要用户进入画布验收。不得返回内部 session ID、素材 ID、本地路径、凭据、原始异常或完整运行日志。

父 Agent 的工具调用结果与 Canvas Agent 会话历史提供本轮审计线索。应用主进程继续运行但 Renderer 重载时，工作流不依赖 Renderer，可继续完成；完整应用退出时不自动恢复整套工作流。重新执行会基于正式输出、待更新状态和现有图片 Job 重新预检，已经采用的稳定产物不重复运行。可跨应用重启自动续跑、单步 retry 和完整任务卡留给后续 Plan/Run 阶段。

## 取消与错误处理

- 用户停止父 Agent 时，取消信号向当前由它启动的 Canvas Agent 和尚未启动的工作流步骤传播；
- 已提交的图片 Job 使用现有取消边界，不删除已经生成的候选；
- Agent 失败只阻断其可达后继，独立就绪分支继续；
- Agent 成功但没有有效 assistant 完成输出时按 `CANVAS_AGENT_OUTPUT_MISSING` 失败，不覆盖旧正式输出；
- Skill 缺失返回 `CANVAS_AGENT_SKILL_UNAVAILABLE`；
- 模型或渠道失效返回 `CANVAS_AGENT_MODEL_UNAVAILABLE`；
- 运行中 graph revision 变化按动态图规则重新验证，不以旧快照覆盖新图；
- 图片提交可见性不确定继续依赖现有候选批次和 Job journal 对账，禁止自动重复付费；
- 发布事件失败不回滚已经原子提交的 Agent 输出或图事实，只记录内部日志并允许后续 LOAD 对账。

## 权限与安全

每个工具调用绑定父普通 Agent 的 `projectId + sessionId + runStartedAt + toolCallId`，并在每次读取和写入前 fresh-read 当前 Canvas binding。Canvas Agent 仍严格固定到自身 `projectId + canvasId + nodeId`。

持久 Skill 配置只是能力选择，不是授权事实。第三方 Skill 无法：

- 访问未关联画布；
- 改变 Host 工具白名单；
- 绕过图片审批或自动采用；
- 修改内部 session 归属；
- 注册任意主进程执行器；
- 读取凭据、本地路径或未授权媒体。

Canvas Agent 的普通项目工具继续限制为现有只读集合；对项目代码的写入、外部网络型 WebView、视频执行和任意插件运行需另立权限规格。

## 关联模块影响

### Shared 与主进程

- `packages/shared/src/types/canvas.ts`：Agent 输出指针、工作流公开结果与严格 parser；
- `apps/electron/src/main/lib/design/canvas-tool-provider.ts`：三个新工具、capability 投影和 Canvas Agent 工具过滤；
- `apps/electron/src/main/lib/design/canvas-agent-execution-service.ts`：统一 Renderer/headless Agent 执行；
- `apps/electron/src/main/lib/design/canvas-workflow-execution-service.ts`：可达图预检与有界调度；
- `apps/electron/src/main/lib/design/canvas-agent-config-store.ts`：`agent-configs/<nodeId>/config.json` 节点长期配置；
- `apps/electron/native/stable-directory/stable-directory-helper.cc`：为 Agent 配置增加独立受管根与最小读写文件合同；
- `apps/electron/src/main/lib/design/canvas-dependency-state-service.ts`：正式输出提交与下游失效；
- `apps/electron/src/main/lib/design/canvas-document-ipc.ts`：把现有 SEND 路径接入共享执行服务；
- `apps/electron/src/utility/agent-runtime-request-timeout.ts`：两个工具的独立长时限。

### Renderer 与 IPC

普通 Agent 工具直接在主进程执行，不新增 Renderer 关键词路由或模拟点击。Renderer 继续消费 Canvas graph、Agent 运行态、图片任务态和 `upstreamChange`；本阶段只需兼容 Agent 输出指针与现有状态显示，不新增后台轮询。

### 默认 Skill

`apps/electron/default-skills/canvas-production/SKILL.md` 增加普通 Agent 配置、启动 Agent 和运行可达工作流的操作顺序，并递增 frontmatter patch 版本。Skill 只描述编排策略，所有权限、预算、绑定和执行限制仍由 Host 执法。

### 兼容性

历史 Agent 节点缺少输出指针和配置文件时保持可读，表现为“尚无正式输出”和默认空配置。加载历史 Canvas 不自动创建配置文件、不运行节点、不改变关系、不采用图片。只有用户或普通 Agent 显式配置、运行时才产生新事实。

## 性能与资源开销

- 可达图、入度和反向依赖使用一次 `O(nodes + edges)` 索引；
- 每轮 Agent 完成后只重建当前 Canvas 的有界图索引，不扫描其它 Canvas；
- Agent 配置是按目标节点读取的小型 JSON；
- Agent 正式输出按固定 UUID 从本节点内部会话读取并受 32 KiB 工具预算约束；
- 并发 Agent 上限 2，避免同时扩大模型调用、CPU 和内存；
- 图片继续使用现有批量 journal、候选与执行器，不读取原图做工作流调度；
- 没有定时器、目录扫描、后台监听或因连线产生的常驻执行。

## 测试与验收

采用 BDD 风格测试，至少覆盖以下行为。

### Agent 配置与能力

- 历史节点缺少配置时读取默认 revision 0；
- 局部配置更新保留未指定字段并拒绝双 revision 冲突；
- 模型、Skill、长度、数量和未知字段校验；
- 第三方 Skill 不扩大工具白名单；
- `canvas_read` 对四类节点返回正确 capability，但真实工具仍二次授权。

### Agent 执行

- 普通 Agent 在 Canvas 工作台未挂载时启动 Canvas Agent；
- Renderer SEND 与普通 Agent 工具复用同一归属和运行服务，同时分别保持 `renderer-manual` 与 `parent-orchestrated` 工具白名单；
- 只注入 `bound` 直接上游，排除 association、待确认和不兼容边；
- 节点长期职责、本轮任务、默认与临时 Skills 正确组合；
- 成功输出按 UUID 与哈希固定，`canvas_read` 返回真实结果；
- partial、旧消息、缺 UUID、哈希不一致和空回复不能成为正式输出；
- 成功后清除当前待更新并只标记合法直接下游；
- busy、停止、错误和迟到完成不覆盖新一代正式输出。

### 工作流执行

- 从一个或多个起点只运行可达子图；
- 稳定产物满足依赖，新建、无输出或待更新 Agent 被执行；
- 多上游全部满足后才启动下游；
- Agent 新建合法下游后重新计算并继续；
- 环、悬空边、待确认边、错误端口和预算越界保持零初始副作用；
- 动态删除根、改写已执行链路或扩大图片预算停止受影响分支；
- 独立分支部分失败仍继续，后继得到稳定阻断原因；
- 单节点单次执行、同 Canvas 单工作流和 Agent 并发上限有效；
- 父 Agent 取消向子 Agent 与未启动步骤传播；
- Renderer reload 不影响主进程中的运行，应用重启不自动重复执行。

### 图片审批与版本

- `canvas_run_workflow` 始终进入单次审批；
- `maxImageRuns=0` 不启动图片，正数不允许动态扩张；
- 图片生成复用稳定 Job 和候选批次，不重复付费；
- 候选产生后阻断下游并返回 `waiting-review`；
- 用户设为默认后才传播待更新并允许下一次继续；
- 普通 Agent 和工作流都不能自动采用候选。

### 回归与构建

- Canvas Agent 内部会话继续从普通会话、搜索、归档、未读、状态岛、Automation、Collaboration、LAN 和 mobile 排除；
- 普通 Agent 的现有画布关联、节点引用、图片检查与结构批处理不回退；
- 定向 Canvas 测试通过；
- `bun run typecheck` 通过，若被工作区既有无关改动阻断则记录精确证据；
- `bun run electron:build` 通过；
- 真实 Electron 冒烟验证单 Agent、Agent 到文档、Agent 到 Agent、Agent 到图片待验收四条链路。

## 非目标

- 连线变化自动触发执行；
- 后台持续监听或定时运行 Canvas；
- 自动采用图片候选；
- 完整 Plan/Run 持久化与应用重启自动续跑；
- 任意数量的 Agent 自由互相启动；
- Canvas Agent 写项目代码；
- 视频、音频、字幕和时间线执行器；
- 第三方 Skill 注册原生工具、执行器或权限；
- 跨画布工作流和多用户实时协作。

## 实施顺序

1. 建立 Agent 配置 Store、能力投影与严格共享合同；
2. 为 Agent 节点增加正式输出指针与受控读取；
3. 抽取 Renderer/headless 共用的 Canvas Agent 执行服务；
4. 建立通用依赖状态服务并接入 Agent、文本 revision 与图片采用；
5. 新增 `canvas_update_agent_config` 与 `canvas_run_agent`；
6. 实现可达子图预检和有界工作流调度；
7. 新增 `canvas_run_workflow` 审批、超时和取消传播；
8. 更新 `canvas-production` Skill 并递增版本；
9. 完成定向测试、类型检查、Electron 构建和真实客户端验收。
