# Agent 画布生产系统总设计

日期：2026-08-31

## 结论

Proma 画布的长期定位不是独立设计工具，也不是任意节点自动触发的通用工作流引擎，而是普通 Agent 的多模态生产工作区。用户在普通 Agent 对话中描述业务目标，Agent 负责理解、规划、协调和验收；画布负责保存长期有价值的执行者、产物、版本和业务关系；Plan、Run 与 Artifact Revision 负责保存执行过程、恢复事实和产物血缘。

产品目标是让用户从一次自然语言请求获得可观察、可暂停、可恢复、可局部修改、可交付的多产物流程。实施顺序固定为：先补齐通用产物生命周期，再建立单 Agent 编排闭环，最后开放受控多 Agent 协作。第三方插件、视频时间线和多用户实时协作不进入首轮范围。

## 用户问题

当前普通项目 Agent 已能关联画布、读取节点、修改图结构、创建图片或 WebView，并在明确要求时运行图片节点。但图片、文档和 WebView 没有统一的创建、更新、版本、采用和导出合同；画布内 Agent 只能读取项目和输出建议，不能受控扩展下游节点；连线只有在图片直接入边场景中承担真实上下文语义；聊天也缺少一个能够持续展示画布任务状态的稳定投影。

这些限制导致复杂任务仍需要用户手工新建节点、复制输入、建立连线、运行、返回聊天解释结果并再次修改。Agent 能产生单个结果，但不能可靠管理一组互相关联、可持续迭代的业务产物。

## 目标体验

用户在普通 Agent 对话中提出“为当前产品创建产品介绍文档、三张宣传图和一个移动端活动页”。Agent 读取当前项目与已授权创作资料，建立 Plan，在默认画布中一次性创建文档、图片和 WebView 节点，并建立明确关系。文档和 WebView 草稿自动生成；付费图片任务汇总为一次审批，审批中展示节点数量、模型、成本范围和影响对象。执行期间，聊天只更新一张画布任务卡；详细提示词、运行日志、版本和产物留在画布。

用户随后提出“保留页面结构，把目标用户改成大学生，整体更年轻”。Agent 对新目标与当前 Plan 做差异分析，通过 `depends-on` 和 `reference` 关系找出受影响的文案、图片和页面，只创建这些产物的新 revision。未受影响节点保持不变，新旧版本可比较、采用和回退。

同一普通 Agent 对话默认维护一张画布。后续相关任务继续进入默认画布，不相关任务在同一画布建立无连线独立分支。用户可显式关联其他画布，但 Agent 不得隐式跨画布读取。

## 产品原则

### 聊天负责决策，画布负责生产

聊天只保存用户意图、关键决策、审批和最终结果。节点创建、模型运行、重试和版本更新不得逐条污染普通聊天历史。每个画布任务在聊天中对应一张可持续更新的任务卡。

### 画布只保存长期有价值的事实

Agent、产物和业务关系可以成为画布节点。执行步骤、重试、审批和日志不得全部变成节点，否则复杂任务会使画布退化为运行日志图。执行过程由 Plan 和 Run 单独管理。

### 连线表达关系，不隐式触发执行

有连线表示存在明确关系，无连线表示独立。连线不直接启动模型或付费任务，Orchestrator 根据当前 Plan 决定执行范围，避免循环触发、意外付费和上下文无限传播。

### 单一编排者提交图事实

普通 Agent 是单个画布任务的 Orchestrator。画布 Agent 可以担任策划、文案、视觉、编剧或评审等专业角色，但默认只返回结构化建议或产物草稿。所有图结构和 Plan 变更由 Orchestrator 统一提交，避免多 Agent 并发覆盖。

### 低风险自动执行，高成本与破坏性操作审批

创建节点、建立连线、生成文档草稿、生成离线 WebView 草稿和读取已授权上下文可以自动执行。付费模型任务、批量运行、覆盖已采用版本、删除和外部导出必须审批。

## 系统分层

### Canvas Graph

Canvas Graph 只维护节点、布局、语义连线和分支关系。HTML、Markdown、图片和运行日志继续保存在各自受管目录，不写入图文档。

现有 `agent`、`image`、`document` 和 `webview` 节点继续兼容。首轮不把所有节点迁移为新的泛型 JSON 结构，而是在主进程内部通过 Artifact Adapter 统一能力，降低数据迁移和 Renderer 回归风险。

### Artifact Registry

Artifact Registry 以内部注册表统一产物能力。每种产物按实际能力实现以下接口的子集：

```text
create
read
update
version
preview
run
adopt
export
```

文档实现创建、读取、更新、版本和导出；WebView 实现创建、读取、更新、版本、预览和导出；图片适配现有读取、运行、采用、版本和导出能力。能力由注册表解析，不把可变能力列表持久化到节点，避免版本升级后持久化声明失真。

新增视频、音频或文件转换时，只增加内部 Artifact Adapter 与 Executor。两个以上新执行器能够在不修改 Orchestrator 主协议的情况下接入后，才评估稳定的第三方插件 API。

### Executor Registry

Executor Registry 包装现有 Design Job、生图、WebView 生成和文档写入能力。Executor 接收稳定步骤身份、精确输入 revision、审批事实和成本预算，返回结构化执行结果。执行器不得直接修改聊天历史或跨画布寻找上下文。

### Orchestrator

Orchestrator 把普通 Agent 的业务目标转换为 Plan，负责物化节点与连线、运行步骤、观察结构化结果、处理局部失败和请求用户决策。Orchestrator 不依赖 Renderer 关键词路由，仍由 Agent 根据完整语义和工具合同决定是否进入画布。

### Conversation Bridge

Conversation Bridge 把 Plan 与 Run 投影为普通聊天中的任务卡。任务卡显示目标、当前阶段、节点数量、关键产物、成本审批、失败摘要和“打开画布”操作，但不复制完整运行日志。

## 持久化模型

### Plan

Plan 保存期望状态，不保存执行日志。建议字段如下：

```ts
interface CanvasWorkflowPlan {
  schemaVersion: 1
  id: string
  projectId: string
  canvasId: string
  sourceSessionId: string
  revision: number
  goal: string
  acceptanceCriteria: string[]
  artifactIntents: CanvasArtifactIntent[]
  relationships: CanvasPlannedRelationship[]
  steps: CanvasWorkflowStep[]
  approvalPolicy: CanvasApprovalPolicy
  status: 'draft' | 'ready' | 'running' | 'review' | 'completed' | 'cancelled'
  createdAt: number
  updatedAt: number
}
```

Plan 使用 revision 做并发控制。修改用户目标时创建新 Plan revision，不覆盖旧 revision 的执行依据。

### Run

Run 保存一次执行事实。同一 Plan revision 可有多次 Run，每个步骤可以有多个 attempt。Run 记录审批、开始与结束时间、执行器、费用、错误、产物 revision 和恢复状态。

稳定步骤身份由 `planId + planRevision + stepId + attempt` 构成。应用重启、工具重试或 Agent 恢复时，先按稳定身份对账，已经成功或已提交的付费任务不得再次执行。

### Artifact Revision

不同产物继续保存在各自受管目录，但通过通用元数据表达版本血缘：

```ts
interface CanvasArtifactRevisionMeta {
  schemaVersion: 1
  artifactId: string
  artifactType: 'document' | 'image' | 'webview'
  revision: number
  parentRevision: number | null
  contentHash: string
  createdBy: CanvasArtifactAuthor
  createdAt: number
}
```

画布节点引用当前采用 revision。历史 revision 独立保留，更新既有产物不得通过删除旧节点再新建节点模拟。

### 文件布局

继续采用本地优先、可移植文件：

```text
canvas.json
plans/<planId>/plan.json
plans/<planId>/runs/<runId>.jsonl
plans/<planId>/runs/<runId>.snapshot.json
artifacts/<artifactId>/meta.json
artifacts/<artifactId>/revisions/*
```

Plan、任务卡索引、采用 revision 和快照使用 `safe-file` 原子写；Run 事件使用 JSONL 追加，并按有界阈值生成快照。所有路径由已验证项目和 Canvas 身份解析，Renderer 不传入任意绝对路径。

## 语义连线

首期关系类型固定为：

```text
association
reference
depends-on
derives
```

`association` 只表示用户可见关系，不进入上下文或影响分析。`reference` 表示目标明确消费来源内容或素材。`depends-on` 表示来源变化时目标进入“可能需要更新”状态。`derives` 表示目标是来源的变体、版本或衍生产物。

历史普通连线迁移为 `association`。历史连向图片并已承担生图输入的连线继续通过兼容路径生效，避免升级后图片上下文丢失。新 Agent 操作必须显式声明关系类型。

上下文默认只读取显式 `reference` 的直接上游。多跳上下文必须由当前 Plan 编译为有界上下文包，并记录实际使用的节点 revision；不得递归展开整张画布。

## Agent 生产循环

### 意图识别

普通 Agent 根据完整语义判断请求是普通对话或代码修改、单一画布产物、多产物任务，还是对已有分支的更新。需求明确时直接执行；产物形态不明确时只询问一次。

### 计划与任务卡

Agent 创建 Plan，描述目标、验收标准、产物、关系、执行顺序、费用操作和决策点。Conversation Bridge 创建唯一任务卡。任务卡后续原位更新，不为每个步骤追加普通聊天消息。

### 批量物化

Plan 中的节点和连线通过现有 Canvas 批处理与恢复合同一次性提交。用户不应看到节点逐个出现、位置跳动或部分图事实成功而内容目录缺失。

### 执行与观察

低风险步骤自动执行。付费、覆盖、删除、批量运行和外部导出进入统一审批。每批结束后，Orchestrator 读取成功产物、失败原因、新 revision、质量结果和待决策项，决定继续、重试、分支或进入验收。

### 局部修改

用户修改目标后，Orchestrator 比较 Plan revision，通过 `depends-on` 和 `reference` 建立反向影响集合。只为受影响产物生成更新步骤；未受影响产物和已采用版本保持不变。

## 画布 Agent 协作

普通 Agent 是唯一 Orchestrator。画布 Agent 默认只允许读取明确节点、读取授权项目和提交结构化输出。需要扩展画布时，由 Orchestrator 发放一次性能力范围，例如只允许读取两个节点、创建三个图片节点、连接当前分支且禁止运行付费任务。

能力范围绑定 `projectId + sessionId + canvasId + planId + runId + scope`，在主进程重新验证。画布 Agent 不得持有可跨 Run 复用的长期写权限。多个 Agent 并行产出的草稿由 Orchestrator 在当前 Plan revision 上统一提交；revision 冲突时重新读取并重新规划，不以最后写入覆盖。

## 审批与错误处理

审批必须展示具体影响，包括产物数量、执行器、模型、预计成本范围、覆盖或删除对象。审批只授权当前 Plan revision 和明确步骤集合，Plan 变化后旧审批失效。

Run 支持部分成功。已经成功的产物不会因后续步骤失败而删除；结构提交失败不会留下可见节点与悬空内容目录；付费任务提交可见但响应不确定时进入对账状态，禁止自动重试扣费。

用户可以继续 Run、重试单步、跳过非必需步骤或取消剩余步骤。取消不删除已经产生的产物。崩溃恢复后，运行中步骤先与执行器和本地 journal 对账，再决定恢复、失败或等待用户。

## 性能与资源开销

Artifact 内容按 revision 和 content hash 缓存安全摘要。Plan 维护当前任务所需的反向依赖索引，影响分析不扫描所有历史 Run。批量运行限制并发数、媒体数量、文本预算和总成本。大画布继续只挂载可见节点，任务卡只订阅当前 Plan 的轻量状态。

通用编排会增加一次规划和结果观察开销，但通过局部更新、摘要缓存和幂等恢复减少重复模型调用。多 Agent 阶段必须增加轮次、并发和费用预算；达到预算后暂停并请求用户，不允许为了“自治”无限对话。

## 安全与所有权

每次 Agent 操作绑定 `projectId + sourceSessionId + canvasId + planId`。默认画布只在同项目普通 Agent 会话内建立。跨画布读取必须来自当前 binding 或用户明确节点引用。Renderer 只发起公开操作，不决定权限上限。

删除、覆盖采用版本、付费运行和外部导出保持显式授权。HTML 预览继续使用离线 sandbox；引入网络型原型能力需要另立安全规格，不随本设计隐式开放。

## 兼容与影响范围

本设计主要修改 `packages/shared` Canvas 合同、`apps/electron/src/main/lib/design`、Canvas IPC/Preload、右侧画布任务卡与工作台。Pi Agent Runtime 继续作为唯一 Agent runtime，不修改其内部会话语义。普通 Agent 通过扩展工具提供器接入 Orchestrator，降低与官方 Proma 高频变化模块的重叠。

现有四类节点和内容目录保持可读。迁移使用显式 schema version 和幂等转换，历史画布加载后不得自动运行、改变连线可见性或覆盖产物。旧客户端无法理解的新 Plan/Run 数据与旧 Canvas 图文档分离，避免破坏基础画布打开能力。

## 测试与验收

功能改动采用 BDD 风格测试，至少覆盖正常路径和主要边界：

- Artifact Registry 能力检测以及不支持能力的稳定失败；
- 文档、WebView 和图片的创建、更新、版本、采用与导出；
- Plan 到节点和语义连线的原子物化；
- 修改目标后的局部影响分析；
- 付费步骤重试和重启不重复执行；
- Run 部分成功、取消、恢复和对账；
- 多 Agent 并发结果的 revision 冲突；
- 跨项目、跨会话和跨画布权限拒绝；
- 历史画布迁移后行为不变；
- 1000 节点下画布、影响索引和任务卡性能；
- Electron 真实流程：对话、创建 Plan、打开画布、审批、执行、重启恢复、局部修改和导出。

## 分阶段交付

### 阶段 1：通用产物生命周期

建立 Artifact Registry；补齐文档工作台与正文写入；支持更新既有 WebView、版本比较和回退；把图片接入统一读取、运行、采用和版本接口；支持单产物导出；增加语义连线并兼容旧画布。

阶段 1 验收标准是普通 Agent 创建的文档、图片和 WebView 均可在后续对话中继续更新同一产物，而不是通过新建无关节点模拟修改。

### 阶段 2：单 Agent 编排 MVP

增加 Plan/Run 存储、一个对话默认一张画布、聊天任务卡、自动规划、批量物化、统一审批、图片批量执行、文档与 WebView 自动更新，以及应用重启后的任务恢复。

阶段 2 的端到端验收请求是“为当前项目创建产品介绍文档、三张宣传图和一个移动端活动页”。用户只输入一次，Agent 自动建立画布结构、生成免费草稿、请求一次生图审批并持续更新任务卡。

### 阶段 3：局部迭代与交付

增加依赖影响分析、只更新受影响分支、质量检查、版本对比、批量采用、多产物审阅、整套任务导出和声明式任务模板。

### 阶段 4：受控多 Agent 协作

增加专业 Agent 角色、一次性能力范围、结构化结果回传、Agent 间节点引用、并发冲突处理以及轮次和成本预算。首期不建设多个 Agent 自由修改整张画布的分布式自治系统。

### 阶段 5：新媒体与内部扩展

依次验证视频、音频或配音、字幕、时间线、文件转换和打包执行器。接口经至少两个新增执行器验证后，再单独设计第三方插件合同。

## 首轮非目标

- 第三方插件市场；
- Figma 文件级编辑；
- 多用户实时协作；
- 任意节点事件自动触发；
- 无限制多跳上下文；
- 无审批自动付费执行；
- 视频时间线和成片生产；
- 网络型 WebView 原型。

## 成功指标

- 一个自然语言请求可以创建包含多类产物的完整 Plan；
- 一个画布任务在聊天中只维护一张任务卡；
- 重试和重启不会重复创建节点或重复付费；
- 修改目标时只更新受影响分支；
- 每个结果可以追溯输入 revision、Agent、Run 和版本血缘；
- 历史画布升级后行为不变；
- 新增内部产物类型不需要修改普通 Agent 的整体编排协议；
- 一个包含 5 至 10 个产物的任务，把手工节点操作压缩为方向、成本、版本和验收等 3 至 5 次有效决策。

## 实施计划边界

本文件是总架构规格。后续实施计划只覆盖阶段 1。阶段 1 通过测试和真实 Electron 验收后，阶段 2 至阶段 5 分别建立独立规格与实施计划，避免一次改动同时扩张存储、Agent 工具、IPC、Renderer 和多 Agent 权限。
