# Agent 与 Design 统一创作任务及可追溯执行设计

## 结论

Proma 应把 Agent 对话与 Design 视为同一个创作任务的两个工作表面：Agent 负责理解、澄清和结构化转交，Design 负责上下文选择、视觉执行、画布编排和版本迭代。

所有 Design 生成和编辑都必须经过内部 Pi Agent。内部 Agent 可以在授权边界内读取项目代码、品牌、角色、故事、场景、连续性文档和参考素材，再形成中文设计摘要与最终图片提示词，最后由主进程可信路由调用任务固化的生图模型。

内部 Agent 执行会话只是 Design 的临时执行资源，不是普通 Agent 对话。它不出现在侧栏、搜索、最近会话、归档、托盘、状态岛、会话引用、项目记忆或 LAN/mobile 中。任务结束后，Proma 先把可追溯信息转存为 Design 自有记录，再回收内部会话。

## 要解决的问题

当前 Design Job 已能通过 Pi Agent 调用可信生图模型，但产品层仍有四个断点：

- Agent 对话中发现视觉需求后，没有结构化方式把原要求、附件和项目上下文自然转入 Design；
- Design 直接生成时，用户不确定 Agent 是否查看了当前项目、为什么这样设计、最终向图片模型发送了什么；
- Design 底层执行复用普通 Agent 会话，容易在普通会话入口产生额外记录；
- 任务结束后，Thinking、工具步骤和最终提示词没有 Design 自有的稳定展示与清理边界。

本设计在不引入第二套 Agent runtime 的前提下打通这些链路。

## 目标

- Agent 根据语义判断视觉执行机会，不依赖 Renderer 关键词匹配；
- 从 Agent 转交和从 Design 直接提交最终进入同一条内部 Agent 执行链；
- 打开 Design 只创建或恢复预填草稿，不触发可计费图片调用；
- 所有 Design 生成都经过内部 Agent，并允许按任务自适应读取项目与创作上下文；
- Design 任务详情展示原始要求、实际引用上下文、中文设计摘要、最终精确提示词、模型信息、耗时和错误；
- 仅在模型真实返回时展示原始 Thinking，并提供完整执行日志；
- 内部执行会话不污染任何普通会话入口、项目记忆或外部同步面；
- 重试、取消、删除和应用重启都不产生隐式付费调用；
- 用户确认后才把单次结果沉淀为长期视觉标准。

## 非目标

- 不在本轮实现 AI 漫剧的剧本拆解、自动分镜、镜头批次生产、角色一致性执行器或视频合成；
- 不根据模型 ID、前端关键词或固定“开发项目 / 平面设计 / 漫剧项目”类型决定工作流；
- 不让内部 Agent 修改项目代码、运行任意脚本或自动写入长期设计规范；
- 不把 Design 执行过程复制成第二轮普通 Agent 对话；
- 不新增 Agent LLM 选择器，继续沿用来源会话优先、全局 Agent 模型兜底的现有规则；
- 不改变现有生图 profile、可信模型快照、附件归属、媒体授权和远程图片安全下载边界；
- 不保证任何供应商都返回可展示的原始 Thinking。

## 核心术语与身份

### 创作任务

`creativeTaskId` 是一次创作意图的稳定身份，贯穿 Agent 转交、Design 提交、任务详情和重试历史。

- 从 Agent 转交时，主进程为结构化建议预分配稳定 `handoffId`；用户接受后，该 ID 成为 `creativeTaskId`；
- 从 Design 直接提交时，主进程在创建首个任务前生成 `creativeTaskId`；
- 同一创作任务的重试继续使用原 `creativeTaskId`；
- 现有 `DesignJobRecord.id` 继续表示单次执行尝试，不改成任务身份；
- 老任务没有 `creativeTaskId` 时，读取层以原 job ID 合成兼容任务身份，不重写历史文件。

### 执行尝试

每次提交或显式重试创建一个独立 Design Job。Job 保留现有模型快照、状态、占位节点、来源素材、恢复 journal 和 replacement 语义，并新增：

```ts
interface DesignJobTransparencyFields {
  creativeTaskId: string
  attemptNumber: number
  sourceAgentMessageId?: string
  originalRequest: string
  contextMode: 'auto' | 'project' | 'none'
  contextReferences?: DesignContextReference[]
  designSummary?: string
  finalImagePrompt?: string
  rawThinkingAvailable?: boolean
  traceState?: 'pending' | 'ready' | 'unavailable'
  executionSessionCleanupState?: 'pending' | 'completed'
}
```

公开类型不携带凭据、认证头、解密后的 Key、任意绝对配置路径或完整工具输出。

### 内部执行会话

内部执行会话仍由 Pi Agent runtime 管理，以便复用现有模型路由、项目指令、工具执行、取消、恢复和 generation guard。它必须在创建时原子写入 `sourceDesignProjectId` 与 `sourceDesignJobId`，不能先作为普通会话出现后再补标签。

`sourceSessionId` 继续表示任务从哪个可见 Agent 会话发起，并用于 Agent LLM 模型选择；`sessionId` 表示本次 Design Job 的内部执行会话，两者不能混用。

## 用户流程

### 从 Agent 对话转交

1. 用户在 Agent 对话中提出设计、视觉、图片生成或编辑需求；
2. Agent 根据完整语义、当前项目和对话上下文判断是否适合进入 Design；
3. Agent 输出结构化 Design 转交建议，Renderer 渲染内嵌卡片；
4. 卡片提供 `打开设计` 与 `留在对话`；
5. 用户选择 `打开设计` 后，Proma 验证来源会话、消息、附件和项目归属，打开当前项目 Design 并预填；
6. 此时不创建图片调用，也不自动提交任务；
7. 用户可调整要求、上下文模式、生图模型和参考素材；
8. 用户显式提交后才创建首个 Design Job；
9. 原 Agent 卡片按 `creativeTaskId` 原位显示草稿、生成中、已完成或失败，并提供 `在设计中查看`；
10. Design 不向普通 Agent 对话追加执行过程、工具结果或重复图片消息。

选择 `留在对话` 只关闭本次转交建议并保持输入焦点，不自动调用图片模型。用户随后在对话中的明确要求继续按普通 Agent 能力处理。

### 从 Design 直接提交

1. 用户在 Design 输入视觉目标；
2. 用户选择 `自动`、`使用项目` 或 `不使用项目`；
3. 用户选择生图模型并显式提交；
4. 主进程生成 `creativeTaskId` 和首个 Design Job；
5. 内部 Pi Agent 读取允许的上下文、形成设计摘要和最终提示词，再调用可信图片工具；
6. 结果进入画布，任务详情显示全过程；
7. 全流程不创建可见 Agent 对话。

### 基于结果继续

成功任务详情提供 `基于此版本继续`。该操作把输出素材作为下一次编辑的父版本，并继承当前创作任务的来源信息，但创建新的 `creativeTaskId`，避免把无限分支都挤进同一重试历史。

重试与版本迭代必须区分：

- `重试` 表示原尝试失败、取消或中断，继续使用相同 `creativeTaskId` 和原模型快照；
- `基于此版本继续` 表示新的创作决策，创建新任务并建立 `parentAssetId` 版本关系。

## Agent 语义转交

### 结构化建议

普通 Agent 增加无副作用的内置工具 `suggest_design_handoff`。工具成功后由主进程生成 handoffId，并在当前 Agent 消息中持久化 `design_handoff_suggestion` 结构化事件。Renderer 只渲染该事件，禁止解析 assistant 文本推断转交。

该工具不创建 Design Job、不调用图片模型、不写项目文件，也不需要外部权限确认。模型提交的任意 ID、项目路径或附件路径都不构成授权事实。

建议载荷包含：

- 主进程生成的 `handoffId`；
- 当前项目 ID；
- 来源 Agent 会话和消息 ID；
- 用户原始要求；
- 当前消息中的附件引用；
- Agent 整理的可编辑简要说明；
- 推荐的上下文模式，默认 `auto`；
- 建议使用的上下文类别，不包含任意文件路径授权。

Renderer 不根据“设计”“视觉”“生图”等关键词自行弹卡。Agent 可以理解“做张首页概念图”“把这张图改得更像杂志封面”“给角色设计三个造型”等不同表达，也可以判断纯讨论、代码修改或文本策划不需要 Design。

### 防止重复执行

- Agent 一旦在当前 turn 输出转交建议，就不得在同一 turn 再调用普通图片工具；
- 用户接受转交后，来源消息与 `handoffId` 幂等绑定，重复点击只打开同一草稿；
- Renderer 导航、窗口刷新和应用重启都不能把预填动作解释为任务提交；
- 用户明确要求“就在对话中生成”或拒绝 Design 后，后续 turn 才按普通 Agent 能力处理；
- 结构化建议本身不构成可计费调用授权。

## Design 上下文系统

### 不固定项目类型

上下文按本次任务匹配，而不是先把整个项目划分为开发、平面设计或漫剧。首版支持以下可扩展类别：

- 品牌；
- 产品；
- 代码；
- 角色；
- 故事；
- 场景；
- 连续性；
- 参考素材。

同一个项目可以同时拥有多个类别。例如产品官网任务使用品牌、产品和代码；海报任务使用品牌与参考素材；漫剧角色概念图使用角色、故事、场景与连续性。

### 项目创作上下文库

可移植上下文保存在：

```text
<project>/.proma/design/context/
├── manifest.json
├── documents/
└── references/
```

`manifest.json` 只保存稳定 ID、类别、标题、相对路径或 Design asset ID、标签、来源和更新时间。Markdown 文档放在 `documents/`，经用户确认采用的视觉参考放在 `references/` 或引用正式 Design asset。

所有清单与文档更新通过主进程、已验证相对路径和 `safe-file.ts` 原子写入。Renderer 不能提交任意绝对路径。首版提供：

- 查看和搜索上下文条目；
- 创建或导入 Markdown 说明；
- 将现有 Design 素材登记为参考；
- 编辑标题、类别和标签；
- 删除未被任务或其他标准引用的条目；
- 从生成结果执行 `采用为视觉标准`。

`采用为视觉标准` 必须由用户显式确认类别、名称和引用内容。单次生成、Agent 建议、失败结果或自动摘要不能直接写入长期规范。

### 三种上下文模式

`自动`：内部 Agent 可以访问授权项目根与创作上下文库，并根据请求决定是否读取。请求明确提到“当前项目首页”“沿用这个角色”等内容时，Agent 应读取相关项目代码或创作资料；无关任务不强制扫描项目。

`使用项目`：强制执行项目上下文预检。若项目离线、没有任何可用资料或授权失败，必须在图片调用前阻断，不能用无上下文结果消耗费用。

`不使用项目`：禁用项目代码、项目文档和创作上下文库工具，只允许使用本次用户明确附加的文字与素材。

内部 Agent 实际读取的每个上下文来源都进入审计引用，至少记录类别、项目相对路径或 asset ID、读取时间和用途摘要。任务详情展示实际引用，不展示“可能读取”的候选列表。

## 内部 Agent 执行链

```text
用户显式提交
  -> 创建 Design Job 与占位节点
  -> 固化 Agent LLM 来源和生图模型快照
  -> 上下文模式建立只读工具边界
  -> 内部 Pi Agent 理解任务并按需读取资料
  -> Agent 调用一次 Design 图片工具
  -> 主进程捕获设计摘要、精确提示词和实际上下文引用
  -> 可信执行器调用固化的图片模型
  -> 验证附件归属、媒体类型、大小和文件身份
  -> 导入正式素材并替换占位节点
  -> 转存 Design trace
  -> 回收内部 Agent 会话
```

### 工具边界

内部 Agent 只获得：

- 已授权项目范围内的只读目录查询、文本搜索和文件读取；
- Design 上下文清单与已授权参考素材读取；
- 当前任务唯一可信图片工具。

内部 Agent 不获得任意 shell、项目写入、Git 修改、外部浏览、Automation、Collaboration 或普通会话管理工具。长期上下文更新由用户确认后的专用主进程操作完成，不交给 Agent 自主写入。

图片工具的 Design 专用调用参数至少包含中文设计摘要和最终图片提示词。最终提示词以真实工具调用参数为事实，不能从 assistant 文本重新推测。上下文引用以实际只读工具审计为事实，不能只信任模型声明。

### 计费边界

- 打开 Design、生成转交建议、预填草稿、读取上下文和 Agent LLM 分析都不能调用图片模型；
- 每次用户提交最多允许一次图片工具调用；
- 工具层继续以任务固化的可信模型快照强制 executor、channelId 和 modelId；
- Agent 不能通过提示词或工具参数切换图片供应商；
- 失败、取消、应用重启和恢复不自动重试；
- 重试必须由用户显式触发，并继续使用原模型快照；
- 图片供应商已接收请求后取消，Proma 不承诺退款，界面应避免暗示费用一定撤销。

## 组件边界

- `AgentDesignHandoffCoordinator`：接收 Agent 的结构化建议，生成稳定 handoffId，验证来源会话、消息、项目和附件，并幂等建立 Design 预填；不创建 Job 或调用图片模型。
- `DesignContextCatalog`：管理 `.proma/design/context/` 的 manifest、Markdown 文档和素材引用；只接受已验证的项目相对路径及用户确认的标准采用操作。
- `DesignContextOrchestrator`：把三态上下文模式转换为本轮只读工具策略、预算和审计记录；不直接修改长期上下文库。
- `DesignJobManager`：继续拥有 Job、占位节点、模型快照、取消、重试、结果提交和恢复，新增 creativeTaskId、attemptNumber 与一次图片调用约束。
- `DesignTraceStore`：逐行写入 Thinking 与结构化执行事件，生成轻量任务摘要，并为任务详情提供按需读取；不依赖普通会话搜索接口。
- `DesignExecutionSessionLifecycle`：原子创建已标记的内部会话，并在 trace 可读后清理权限、交互、消息和工作目录；清理失败由 job journal 恢复。
- `DesignHandoffCard`：在来源 Agent 消息中展示转交选择和任务状态，只按 creativeTaskId 订阅 Design 状态。
- `DesignTaskDetails`：展示要求、上下文、摘要、精确提示词、Thinking、日志和尝试历史，不直接读取 Agent 会话文件。

这些组件通过共享类型和主进程服务接口通信。Renderer 只持有显示状态和受控命令，不承担上下文授权、会话隐藏、trace 清理或计费判定。

## 任务详情

选中由 Design Job 生成的素材或失败占位节点时，右侧进入 `任务详情`。默认展示：

- 状态、实际生图模型、开始时间和耗时；
- 用户原始要求；
- 上下文模式；
- 实际引用的文档、代码和素材；
- 中文设计摘要；
- 最终发送给图片模型的精确提示词；
- 错误摘要或上下文截断警告；
- `复制提示词` 与适用的后续操作。

按需展开：

- `模型原始 Thinking`：仅展示供应商通过 Pi runtime 明确返回的 reasoning/thinking 内容；不可用时显示“模型未返回原始 Thinking”，禁止伪造或根据摘要反推；
- `完整执行日志`：按时间显示上下文读取、工具调用、图片执行、输出验证、取消和错误事件；
- `尝试历史`：同一 `creativeTaskId` 下按 attemptNumber 展示失败、取消、中断和当前尝试。

完整 trace 采用延迟加载。任务列表、画布首帧和普通 Inspector 切换不读取原始 Thinking 或工具日志。

## 内部会话可见性

内部与用户可见查询必须分层：

- `listAgentSessions()` 等主进程内部能力继续返回全部会话，供任务恢复、项目迁移、退出清理和存储一致性使用；
- 普通会话 IPC、Renderer 侧栏和用户搜索使用统一的可见会话选择器；
- Design 内部会话从 active、archived、archive count、全局消息搜索、`@会话` 引用和最近会话中排除；
- 托盘菜单和 Agent Island 不显示其运行态、完成态或最近记录；
- 工作区记忆刷新不把 Design 执行 trace 当作新的用户对话或长期决策；
- LAN/mobile 列表、搜索、消息读取、星标、归档和通过普通 sessionId 直接打开都拒绝内部会话；
- 飞书镜像及其他普通 Agent 外部同步入口不创建或同步内部会话；
- 任务详情通过受控的 `projectId + jobId` Design API 读取 trace，不暴露普通 Agent 会话入口。

统一判断以 `sourceDesignProjectId` 或 `sourceDesignJobId` 任一存在为隐藏条件，并额外校验两字段必须成对有效。这样损坏或半写入元数据会 fail closed，不会泄露到普通会话列表。

## Design trace 与会话回收

### 数据归属

现有 Job journal 继续位于 Design 缓存，并作为单次执行状态事实：

```text
~/.proma/design-cache/<project-id>/
├── jobs/
│   └── <job-id>.json
└── traces/
    └── <job-id>.jsonl
```

Job journal 保存可直接展示的轻量字段：原始要求、上下文模式、引用摘要、设计摘要、最终提示词、状态、错误、模型快照、耗时和 trace 状态。`trace.jsonl` 保存原始 Thinking 与结构化执行事件。

正式输出素材继续随项目保存在 `.proma/design/assets/`，素材元数据保留 `prompt`、`sourceJobId`、`sourceSessionId` 和 `parentAssetId`。创作上下文库随项目保存；完整执行 trace 属于当前 Proma 安装的本地运行记录，不作为跨设备项目合同。

trace 保留到用户删除对应任务或成功素材，不参与普通 Agent 自动归档，也不能被通用“清理旧会话”逻辑提前删除。

### 转存状态机

终态处理按以下顺序执行：

1. 收敛 Design Job 的成功、失败、取消或中断状态；
2. 原子写入轻量任务详情和 trace pending 意图；
3. 流式写入并关闭 trace JSONL；
4. 将 `traceState` 标记为 ready；
5. 清理内部会话的权限、待处理交互、消息索引、JSONL 和工作目录；
6. 将 `executionSessionCleanupState` 标记为 completed。

任一步骤失败都保留可恢复意图。应用启动时按 job 精确继续，不扫描或接管无关普通会话。只有 trace 已确认可读后才允许删除仍承载唯一日志的内部会话。

如果图片和正式素材已经成功提交，但 trace 转存失败，任务仍显示生成成功，并附加“执行日志待恢复”警告；不能把已经成功的生图结果反报为生成失败。

### 删除与保留

- queued/running 任务只能取消，不能直接删除；
- failed/cancelled/interrupted 任务允许删除；
- 垃圾桶按钮和 `Delete/Backspace` 都先显示简短确认，说明将删除任务节点、提示词、尝试历史和执行记录；
- 删除按 `creativeTaskId` 清理所有未被成功素材引用的 attempts、trace 和残留内部会话；
- 删除意图继续使用可恢复 journal，节点、分组引用、job、trace 和 session 清理必须幂等；
- 成功结果按普通素材流程删除，不增加另一套“删除成功任务”入口；
- 成功素材仍被画布节点、子版本或上下文标准引用时禁止删除；
- 成功素材完成合法删除后，清理对应创作任务的本地 job 与 trace；
- 删除失败不回滚已经提交的权威画布 revision，而是保留清理意图供恢复继续。

## 错误、取消与重试

### 上下文错误

- `自动` 模式下，无关候选读取失败可以继续，但任务详情必须列出警告；
- 请求明确依赖当前项目而相关上下文不可读时，必须在图片调用前失败；
- `使用项目` 模式没有可用项目上下文时必须在图片调用前失败；
- `不使用项目` 模式任何项目文件工具请求都由主进程拒绝；
- 达到上下文预算时继续使用已读取内容，并在提交图片工具前把截断状态写入任务详情。

### 取消竞态

- queued/running 显示 `取消生成`；点击后进入稳定的取消中状态并禁用重复命令；
- 若成功提交先于取消完成，保留成功结果；
- 若取消先完成，迟到输出不得导入正式素材；
- 取消后的任务保留原要求、最终提示词和已有 trace，可显式重试或删除。

### 重试

- 仅 failed/cancelled/interrupted 可重试；
- replacement 复用原画布位置和节点 ID；
- replacement 使用相同 `creativeTaskId`、递增 attemptNumber，并复制原模型快照；
- 旧 attempt 的错误、提示词和 trace 保留在尝试历史中；
- 应用重启只把无法续跑的任务标记 interrupted，不自动调用图片模型；
- 配置删除、模型停用、凭据失效或旧任务缺少可信快照时明确阻断，不静默切换模型。

## 性能与资源

- 上下文编排先读取轻量 manifest、目录元数据和搜索结果，再按需读取相关片段，不预注入整个项目；
- 自动或强制项目上下文每次任务最多读取 24 个不同文本文件、单文件最多向模型返回 64 KiB、累计最多返回 512 KiB 解码后文本；目录与搜索结果元数据不计入文本预算，用户明确附加的图片继续使用现有媒体数量和大小上限；
- 达到任一预算后拒绝新的项目文本读取，将截断原因写入任务详情，并由 Agent 判断已取得的信息是否足以在不误导用户的情况下调用图片工具；
- 项目上下文索引按 projectId、路径修改时间和内容身份缓存，文件变化后增量失效；
- 任务只记录引用和摘要，不把完整项目文件复制到 journal 或 trace；
- 搜索内部会话时先按可见性过滤，再扫描消息 JSONL，减少无效 I/O；
- 任务列表和画布节点只加载轻量 job 字段，trace、Thinking 和工具详情按需读取；
- trace 采用逐行 JSONL，避免在任务结束时构造一个巨大内存对象；
- 内部会话终态回收减少会话索引、工作目录和自动归档开销；
- 不新增常驻进程、数据库、HTTP 服务或运行时依赖；
- 普通 Agent/Chat 不初始化 Design 上下文索引或 trace 读取器。

## 安全与隐私

- 项目指令继续通过 `project-instruction-resolver.ts` 在已授权项目根显式解析，不恢复 cwd、祖先或附加目录的环境式规则发现；
- 自动上下文排除 `.env*`、凭据、私钥、Git 内部目录、依赖目录、构建产物和 Proma 配置密钥文件；
- 用户明确附加的文件仍需经过现有路径归属、realpath、文件身份、媒体签名和大小验证；
- 发给图片模型的是 Agent 整理后的视觉提示词与明确参考图，不自动发送无关代码全文；
- 工具审计只记录项目相对路径、类别、时间和受限摘要，不把完整敏感文件内容复制到 trace；
- 原始 Thinking 与 trace 仅保存在当前本机 Design 缓存，并通过项目与 job 归属检查读取；
- API Key、Authorization Header、渠道解密结果和任意敏感配置值永不进入 journal、trace、IPC、Renderer 或公开错误；
- 内部会话在 LAN/mobile 和外部镜像的直接读取路径上 fail closed；
- `采用为视觉标准` 是独立、显式、可审计的用户操作，不能由 Agent 自动执行。

## 兼容性与关联模块

- 现有 `DesignJobRecord`、两阶段占位、terminal pending、replacement retry、recovery LOAD 和 workspace write guard 继续作为基础；
- 当前 GPT Image 2 与 Nano Banana 的可信快照、执行器分派和单次图片调用上限保持不变；
- Pi `user + tool_result` 图片输出兼容必须保留；
- 失败、取消和中断任务的可恢复删除不得退化；
- Agent 图片与 Design 素材的稳定文件身份、允许根和媒体 lease 不变；
- 旧 Job 没有透明度字段时仍可展示状态、原 prompt 和模型快照；Thinking、设计摘要和上下文引用显示为历史不可用；
- 旧内部 Design 会话在升级后按现有 `sourceDesignProjectId/sourceDesignJobId` 隐藏，不迁移成普通会话；
- 旧终态内部会话只有在成功提取可读 trace 后才能回收；历史消息损坏或提取失败时继续隐藏并保留，不以节省空间为由删除唯一诊断证据；
- IPC 变更必须同步 shared、main handler、preload bridge 和 renderer adapter；
- 项目迁移必须继续处理内部执行会话，但不能把它们加入普通会话列表；
- 上游 `WorkspaceMemoryChangeDock` 只展示真实工作区记忆变化，Design trace 不触发记忆刷新。

## 测试与验收

所有行为采用 BDD 风格可执行测试，并优先运行最小相关测试，再运行全仓类型检查和 Electron 构建。

### 语义转交

- Given 用户用不同表达提出视觉执行需求，When Agent 判断需要 Design，Then 输出结构化建议而非依赖前端关键词；
- Given 用户只讨论视觉策略，When 不需要立即执行，Then Agent 可以继续对话且不强制弹卡；
- Given 同一 handoff 被重复点击或应用重启，When 打开 Design，Then 只恢复同一预填草稿；
- Given 用户打开 Design 但未提交，When 导航或退出，Then 图片执行器调用次数为零；
- Given Agent 已输出转交建议，When 当前 turn 结束，Then 不再调用普通图片工具。

### 上下文编排

- Given 请求生成当前项目首页，When 模式为 auto，Then Agent 实际读取相关产品、页面结构和视觉资料并记录引用；
- Given 平面海报、角色概念图和场景图请求，When 项目拥有对应类别，Then Agent 按任务匹配上下文而非固定项目类型；
- Given 模式为 project 且项目离线，When 提交，Then 在图片调用前失败；
- Given 模式为 none，When Agent 尝试读取项目文件，Then 主进程拒绝且允许使用明确附件；
- Given 大型项目超过预算，When 生成，Then 使用已选片段并在任务详情显示截断；
- Given `.env`、私钥或越权符号链接，When 自动发现上下文，Then 不读取、不记录、不发送。

### Design 执行与计费

- Given 从 Agent 转交或从 Design 直接提交，When 创建任务，Then 都先运行内部 Pi Agent；
- Given 单次提交，When Agent 多次尝试调用图片工具，Then 工具层只允许第一次有效调用；
- Given Agent LLM 在图片调用前失败，When 任务收敛，Then 图片执行器调用次数为零；
- Given 应用退出、恢复或上下文读取失败，When 重启，Then 不自动调用图片模型；
- Given 用户显式重试，When replacement 创建，Then 使用原 creativeTaskId 和模型快照。

### 任务详情与 trace

- Given 模型返回 reasoning，When 展开 Thinking，Then 展示原始返回并与中文设计摘要分离；
- Given 模型未返回 reasoning，When 查看任务详情，Then 明确显示不可用且不生成伪内容；
- Given 图片工具被调用，When 查看最终提示词，Then 内容与真实工具入参完全一致；
- Given Agent 读取上下文，When 查看引用，Then 只显示实际工具审计来源；
- Given trace 很大，When 打开画布，Then 首帧不读取 trace；展开后按需加载；
- Given 图片已成功但 trace 转存失败，When 收敛任务，Then 图片保持成功并显示日志恢复警告。

### 会话可见性与清理

- Given 内部 Design 会话，When 查询 active、archived、count、search、recent、reference、tray 或 island，Then 均不可见；
- Given 内部 Design 会话，When 通过 LAN/mobile 列表、搜索或直接 sessionId 读取，Then 不可见或拒绝；
- Given 只有 Design trace 更新，When 检查工作区记忆刷新，Then 不产生记忆邀请或变更；
- Given trace 已成功转存，When 回收会话，Then 消息、权限、待处理交互和工作目录全部清理；
- Given 清理过程中崩溃，When 启动恢复，Then 按 job 幂等继续且不影响普通 Agent 会话；
- Given trace 未完成，When 清理器运行，Then 不删除唯一内部会话日志。

### 错误、取消、删除和版本

- Given 取消与成功竞态，When 成功先提交，Then 保留结果；取消先提交则拒绝迟到输出；
- Given failed/cancelled/interrupted，When 重试，Then 原 attempt 仍可在历史查看；
- Given 运行中任务，When 删除，Then 拒绝且要求先取消；
- Given 用户确认删除失败任务，When 任一步清理中断，Then pending journal 在恢复后完成节点、trace 和 session 清理；
- Given 成功素材存在子版本或上下文引用，When 删除，Then 明确拒绝；
- Given 成功素材已无引用并删除，When 清理来源任务，Then 对应本地 job 和 trace 被回收。

### UI 与回归

- 任务详情覆盖宽窗口、窄窗口、明暗主题、键盘导航、加载、空、失败和长内容；
- 转交卡覆盖 `打开设计`、`留在对话`、状态更新和来源任务失效；
- 上下文模式使用三态控件，模型选择、参考素材和提交按钮不因动态内容发生布局跳动；
- 自动化测试使用假 Agent 与假图片执行器，不触发真实费用；
- 真实模型仅在用户主动触发时做冒烟验证；
- 运行 Design 与关联 Agent 测试、`bun run typecheck` 和 `bun run electron:build`；
- 保留 1000 节点画布虚拟化和媒体授权安全回归。

## 实施分期

### 第一阶段：任务身份、透明度与会话边界

- 为新旧 Job 建立 creativeTaskId 与 attemptNumber 兼容读取；
- 原子创建已标记的内部会话；
- 统一过滤普通会话入口、项目记忆和 LAN/mobile；
- 建立 DesignTraceStore、终态转存和可恢复会话清理；
- 完成任务详情、Thinking、精确提示词、尝试历史和删除确认。

第一阶段不改变用户从哪里发起任务，只先保证现有 Design 生成可追溯且不会污染普通会话。

### 第二阶段：项目创作上下文

- 建立 Context Catalog、manifest 与基础管理界面；
- 实现三态上下文策略、只读工具、预算、审计和敏感路径排除；
- 调整 Design 专用图片工具，结构化捕获设计摘要和最终提示词；
- 实现 `采用为视觉标准` 与引用删除保护。

第二阶段完成后，Design 直接提交即可稳定读取项目代码、业务和创作资料。

### 第三阶段：Agent 结构化转交

- 增加 Agent Design handoff 建议能力和消息卡片；
- 实现来源消息、附件、项目和 handoffId 验证；
- 打开 Design 后幂等预填且不自动提交；
- 按 creativeTaskId 把任务状态回显到原卡片；
- 完成“留在对话”与 Design 转交的重复执行保护。

只有前三阶段分别通过相关回归后，才把结构化转交入口设为默认可用。任一阶段都不得通过功能开关绕过图片调用上限、上下文授权或内部会话隐藏。

## 验收标准

- 用户在 Agent 中提出视觉需求时，Agent 能理解不同表达并自然建议打开 Design；
- 用户进入 Design 后可以修改预填内容，只有显式提交才开始生成；
- 用户直接在 Design 提交时，内部 Agent 能根据上下文模式查看项目代码、业务和创作资料；
- 所有 Design 生成都经过内部 Agent，但不会产生普通 Agent 会话记录；
- 成功和失败任务都能说明使用了什么上下文、为什么这样设计、最终向图片模型发送了什么；
- Thinking 只在模型真实返回时展示，完整执行日志可追溯且按需加载；
- Agent 对话与 Design 通过稳定 `creativeTaskId` 共享状态，不重复执行或重复计费；
- 内部会话不进入项目记忆、普通会话发现或 LAN/mobile，并在 trace 转存后可靠回收；
- 单次结果不会未经用户确认变成长期视觉标准；
- 现有 Design 恢复、模型路由、媒体安全、任务删除和上游记忆展示均不回退。

## 后续独立规格

完整 AI 漫剧工作流应在本设计稳定后另立规格，至少覆盖剧本结构、角色表、场景表、镜头语言、分镜状态机、批次生成、跨镜连续性、人工审核点、失败重跑和成片装配。该工作流复用本设计的 `creativeTaskId`、上下文类别、Design trace 和可信图片执行器，但不得在本轮预先加入未经验证的批次抽象。
