# Canvas 多类型节点与节点内工作台设计

## 状态

- 日期：2026-08-27
- 结论：已由用户确认
- 范围：原生 Canvas 添加交互、节点排布、Agent/生图/文档/原型节点、连线上下文、节点内工作台、持久化与恢复
- 前置规格：
  - `2026-08-25-canvas-session-agent-orchestration-design.md`
  - `2026-08-26-canvas-node-operations-and-resilient-errors-design.md`

## 结论

原生 Canvas 的顶部“添加节点”必须始终打开类型菜单。本阶段交付四种真实可用节点：`Agent`、`生图`、`文档`和`原型`；菜单同时显示禁用的“视频 · 即将支持”，但不提供假执行能力。

从顶部创建节点时，选择类型后立即创建空节点并选中，但不展开工作台、不自动连线、不启动 Agent、生图或原型任务。新节点按全画布最右侧向后追加，Canvas 的 viewport、zoom 和已有节点位置完全不变。节点侧 `+` 继续表示从源节点创建下游节点并自动连线。

所有复杂交互都发生在节点内部。节点默认保持紧凑、固定的持久化尺寸；用户显式展开后，完整工作台以锚定节点的临时覆盖层显示，不改变图布局、节点位置或连线端点。同一 Canvas 同一时间只挂载一个完整工作台。

连线是节点之间共享上下文的唯一合同。没有连线的节点完全独立；下游只读取直接入边节点的已提交快照。上游变化只把直接下游标记为“待更新”，不自动运行。Agent 可以在用户明确任务内自动创建节点和连线；计费生成必须有明确执行意图。

## 对前置规格的修订

本规格保留多 Canvas、真实 Pi Agent 子会话、typed edge、stale、显式上下文、原型沙箱和本地优先存储方向，并明确替换以下旧约定：

- UI 名称“视觉文档”改为“文档”，能力扩展为通用 Markdown 文档；
- 新文档 schema 使用 `document` 节点类型，旧 `visual-document` 只作为迁移输入；
- 不再使用固定右侧 Agent 主对话栏；
- 不采用可同时打开多个 Agent 浮窗的交互，改为同一时间一个节点内工作台；
- 顶部添加不再按当前可视中心落点，也不自动打开对话；
- 顶部菜单在只有 Agent 可用时也不再跳过类型选择；
- 菜单显示禁用的视频预留项，但视频执行器不在本阶段范围；
- 文档内容改为 Canvas 节点本地内容，不默认作为项目级全局单例跨 Canvas 共享。

现有 Agent 创建事务、坏会话局部降级、公开错误信封、删除保留底层对话和稳定目录安全边界继续有效。

## 要解决的问题

当前实现只有 Agent 节点拥有真实创建链路，顶部添加在单一可用类型时直接创建 Agent。新节点以当前可视中心为原点避让，并在右侧面板打开后可能通过 reveal viewport 校正移动画布。这个行为有三个问题：

1. 点击添加时用户的视图发生变化，连续构建流程缺少空间稳定性；
2. 顶部添加无法选择节点类型，Canvas 仍表现为多个 Agent 的线性列表；
3. 图片、文档和原型虽已有共享类型占位，但缺少创建、编辑、执行和持久化能力。

问题本质不是再增加几个菜单项，而是建立统一节点生命周期：创建空结构、节点内编辑、显式连线上下文、按需执行、独立持久化和局部恢复。

## 用户交互

### 顶部添加菜单

顶部悬浮工具栏的 `+` 每次都打开类型菜单：

- Agent：可用；
- 生图：可用；
- 文档：可用；
- 原型：可用；
- 视频：禁用，显示“即将支持”。

每个菜单项使用类型图标和清晰名称。禁用视频不能触发创建，其“即将支持”原因必须同时通过可见文本和辅助技术可读名称表达。菜单支持键盘方向键、Enter、Escape 和可见焦点状态。

### 独立创建

用户从顶部菜单选择类型后：

1. Renderer 预分配 operation、node 和内容身份；
2. 以当前权威文档计算全局追加位置；
3. 主进程原子提交节点及该类型所需的最小空内容；
4. 成功后选中新节点，但保持折叠；
5. 不创建边，不打开工作台，不执行任何模型。

创建前后的 viewport 和 zoom 必须逐字段相同。创建失败保留原图、原选区和原视口，不产生占位节点或孤立内容。

### 全局追加位置

顶部创建使用稳定的全局顺序向右追加规则：

- 空 Canvas 的首个节点放在初始可视中心对应的世界坐标；
- 非空 Canvas 以所有节点持久化边界的最大 `right` 为基准，在右侧增加固定间距；
- 新节点的 `y` 与权威 `document.nodes` 中首个仍存在节点的基线对齐，节点数组顺序继续承担稳定创建顺序；
- 若该位置被不同尺寸节点占用，只向下检查同一右侧列的确定性候选；
- 不因为当前用户平移到远处而改变追加序列；
- 不调用 reveal viewport，也不产生 `set-viewport` mutation。

节点侧 `+` 继续以源节点右侧为首选位置。顶部添加表示独立节点；节点侧添加表示有关联扩展，两套空间语义不得混用。

### 折叠与节点内工作台

节点持久化卡片保持固定紧凑尺寸，折叠态展示：

- 节点类型与标题；
- 当前状态；
- 内容或结果摘要；
- 待更新、错误或不可用状态；
- 展开、运行或恢复等最小操作入口。

双击节点或点击展开按钮后，由节点卡自身渲染锚定覆盖层并显示完整工作台。工作台是 Renderer 临时状态：

- 不写入节点位置或尺寸；
- 不推动相邻节点，不改写边；
- 可以临时覆盖邻近画布内容；
- z-index 高于普通节点和边，低于系统弹窗；
- 打开另一节点时先安全处理当前草稿，再切换工作台；
- 收起、切换 Canvas 或卸载时释放编辑器、预览、大图和对象 URL。

创建节点只选中，不自动展开。同一时间只允许一个节点工作台，避免大量编辑器和预览环境同时占用资源。

## 节点能力

### Agent 节点

Agent 节点继续引用真实 Pi Agent Canvas 子会话。展开工作台后提供完整对话、输入、停止、恢复和运行状态。会话消息按需加载，折叠节点不读取 JSONL。

Agent 可以通过受控 Canvas 工具：

- 查看直接连接的输入摘要和版本；
- 创建 Agent、生图、文档或原型节点；
- 创建兼容连线；
- 预填节点内容；
- 在明确执行意图下启动生图或原型生成；
- 提议修改文档或原型。

Agent 不直接写 Canvas JSON 或节点文件。删除用户节点、断开用户连线、覆盖已提交文档或原型必须经过现有确认或差异审阅边界。

### 生图节点

生图节点是稳定、独立、可执行的创作模块。展开工作台提供：

- 提示词编辑；
- 已配置生图模型选择；
- 直接上游上下文摘要；
- 参考图片选择；
- 生成、取消、重试和版本选择；
- 当前采用图片和历史结果。

无连线时仅使用自身提示词和显式参考图；有连线时，在执行瞬间读取直接上游已提交快照。创建节点不调用模型。明确点击“生成”，或 Agent 从明确执行要求发起运行，才进入现有可信生图模型和 Design Job/资产安全链。

生成结果继续使用版本化资产，不把原图写入 Canvas JSON。失败、取消或中断只更新当前节点运行状态，保留提示词、输入版本和重试入口。

### 文档节点

用户可见名称统一为“文档”。新 schema 的节点类型为 `document`；旧 `visual-document` 在 LOAD 迁移时转为 `document`，不得继续写出旧类型。

文档节点保存 Markdown，可承载设计规范、产品需求、脚本、角色设定、研究结论和其他通用内容。展开工作台提供编辑、预览、版本和 Agent 变更审阅。

- 用户编辑可以直接保存为新 revision；
- Agent 修改先生成结构化差异；
- 用户接受后才更新已提交正文；
- 未提交草稿不进入下游上下文；
- 一个文档节点可以连接多个下游节点；
- 文档默认属于当前 Canvas，不自动跨 Canvas 共享。

### 原型节点

原型节点保存本地 HTML/CSS/JS 原型。展开工作台提供源码与预览标签，首版可以把单文件 HTML 作为权威内容；后续多文件项目通过同一 prototype ID 扩展。

Agent 可以根据直接上游内容创建或修改原型，但写入先形成可审阅差异。用户保存后才更新已提交版本和下游快照。

预览环境必须：

- 无 Node、Electron、业务 preload 和任意 IPC；
- 禁止 `file://`、下载、权限、外部导航和新窗口；
- 默认阻断 HTTP、HTTPS、WebSocket 等外部网络；
- 只允许受管 HTML 与显式连接的 Proma 媒体；
- 崩溃或违规访问只影响当前原型节点；
- 非激活原型不运行脚本，只显示安全快照或摘要。

### 视频预留

菜单显示视频类型，但本阶段不修改 Canvas schema、不创建视频节点、不接入模型或任务。禁用项只表达产品方向。视频生成必须另立规格，明确模型、时长、分辨率、首尾帧、音频、版本、计费和取消合同。

## 连线与上下文

### 唯一共享合同

没有连线的节点彼此独立，不能因为同属 Canvas 而读取对方内容。执行节点只读取直接入边节点的已提交快照：

- Agent：最近一次明确输出的结构化摘要、选定附件和引用；
- 生图：当前采用图片版本及安全媒体引用；
- 文档：当前已提交 Markdown revision 的有界摘要；
- 原型：当前已提交版本的描述、截图或有界源码摘要。

下游不隐式递归遍历整张图。`A -> B -> C` 时，C 读取 B 的输出；A 的影响应由 B 的已提交输出承接。该边界避免上下文体积随图深度失控。

### 待更新状态

上游已提交内容变化后，只把直接下游标记为 `stale`/“待更新”。系统：

- 不自动执行 Agent；
- 不自动生图；
- 不自动重写文档或原型；
- 不递归产生付费任务；
- 可以用访问去重传播受影响状态，但执行始终显式。

每次运行固化实际读取的上游 node ID、内容 revision 和摘要哈希，便于结果追溯。删除边立即解除未来上下文关系，但不删除节点内容、运行历史或已有产物。

### Agent 自动编排

用户明确要求执行时，Agent 可以在同一受控图事务中创建所需节点和连线，并按依赖就绪顺序启动必要步骤。普通讨论、结构规划或歧义需求只创建待运行结构或预填内容。

Agent 图 mutation 必须包含 `projectId + canvasId + agentNodeId + expectedRevision`。主进程验证节点归属、端口兼容、创建权限、运行成本边界和 revision；批次任一项无效时整批拒绝。

## 权威数据模型

### 节点类型

共享类型升级为：

```ts
type CanvasNodeKind = 'agent' | 'image' | 'document' | 'webview'
```

`video` 不进入本阶段共享联合。LOAD 可以接受旧 `visual-document`，但必须通过 schema migration 规范化为 `document` 后原子写回；新 mutation 拒绝旧类型。

图节点只保存稳定身份、位置、标题、展示摘要和内容引用：

```ts
interface CanvasDocumentNode extends CanvasNodeBase {
  kind: 'document'
  documentId: string
  contentRevision: number
}

interface CanvasImageNode extends CanvasNodeBase {
  kind: 'image'
  imageModuleId: string
  adoptedAssetId?: string
}

interface CanvasWebviewNode extends CanvasNodeBase {
  kind: 'webview'
  prototypeId: string
  contentRevision: number
}
```

具体字段以实施前共享类型盘点为准，但不得把 Markdown、HTML、图片正文或消息写入 Canvas 图文档。

### 本地目录

每个 Canvas 在现有稳定根下增加受管内容目录：

```text
canvas.json
nodes/
  <image-module-id>/config.json
  <document-id>/content.md
  <document-id>/meta.json
  <prototype-id>/index.html
  <prototype-id>/meta.json
  <content-id>/history/
assets/
trash/
transactions/
```

图 mutation 与节点内容 mutation 使用独立 revision，避免拖动节点时重写 Markdown、HTML 或图片历史。所有文件通过稳定目录 capability 和原子写边界提交，不引入数据库，不接受 Renderer 任意绝对路径。

### 删除与恢复

- 删除 Agent 节点：移除节点和边，底层对话继续保留并保持内部不可见；
- 删除生图、文档或原型节点：移除节点和边，把节点专属内容移动到 Canvas `trash`；
- 项目级共享图片资产仍按引用检查决定是否保留，不因节点删除立即清理；
- 回收区记录原 node ID、content ID、类型、标题和删除 revision；
- 恢复在新 graph revision 中重建节点引用，位置使用删除前位置或当前全局追加位置；
- 回收区清空属于单独的不可恢复操作，不与普通删除合并。

## 主进程、IPC 与 Renderer

### 四层合同

任何新能力必须同步：

1. `packages/shared`：schema、节点类型、内容 revision、命令、结果和公开错误；
2. 主进程：稳定目录服务、内容服务、Agent 工具和执行器适配；
3. Preload：最小、类型安全的 invoke 与事件 bridge；
4. Renderer：Jotai 状态、adapter、节点投影和节点内工作台。

Renderer 不直接读写节点文件、Agent session、Design Job 或媒体路径。

### Renderer 状态

Renderer 将持久图状态与临时工作台状态分离：

- 图状态：snapshot、revision、nodes、edges、viewport、nodeIssues；
- 临时状态：expandedNodeId、编辑草稿、预览实例、对象 URL、运行表单；
- 运行状态：按 session/module ID 从全局权威事件路由；
- 内容缓存：按 `canvasId + contentId + revision` 有界缓存。

新节点创建不得写 `expandedNodeId`，不得调用 viewport reveal。展开另一节点前，如果当前存在未保存草稿，提供保存、放弃或取消切换，不得静默丢失。

## 错误与恢复

- 图文档、路径授权、schema 或事务事实不确定时继续整图 fail closed；
- 单节点内容缺失、损坏或执行失败只标记目标节点，其他图功能继续可用；
- 内容保存冲突保留本地草稿，提供重新加载、比较和另存为新版本；
- 生图失败保留输入、上下文版本、日志摘要和重试入口；
- 原型沙箱崩溃回退到最近安全快照，不影响 Canvas Renderer；
- 公开 UI 只展示稳定错误码和中文动作，不泄露 IPC、绝对路径、UUID 或堆栈；
- Canvas 切换、recovery 和迟到请求必须按 canvas/content generation 隔离。

## 关联业务影响

### 普通 Agent 与会话可见性

Canvas Agent 子会话继续从普通会话列表、搜索、归档、未读、通知、状态岛、项目记忆、LAN/mobile 和普通 Collaboration 中排除。新增 Agent 图工具不能绕过该边界。

### 旧 Design 与生图

生图节点复用现有可信模型选择、内部 Pi Agent、Design Job、trace、资产版本和安全导入能力，不创建第二套图片执行器。需要增加 Canvas module 适配层，把运行结果映射回稳定 image module，而不是把单次 Job 重新作为图节点。

### 项目迁移与路径管理

节点内容、history、trash 和原型文件随项目路径迁移，并受 workspace write lease、稳定目录 capability 和 verified copier 保护。活动 Agent、生图或原型运行继续纳入迁移准入。

### 性能与资源

- 空间落点计算只扫描当前节点边界，复杂度 O(N)；
- 折叠图只加载节点摘要，不加载 JSONL、Markdown、HTML 或图片历史；
- 同一时间只挂载一个完整工作台和一个原型沙箱；
- 内容在显式展开时按 revision 懒加载，收起后释放重资源；
- 连线上下文在执行时构建并设摘要、附件和字节上限；
- XYFlow `onlyRenderVisibleElements` 和 1000 节点基线不得回退；
- 拖动、缩放和选择不触发节点内容写入。

## 分阶段交付

最终目标包含四种可用节点和 Agent 自动编排，但实施必须按独立可验证阶段推进：

1. 基础层：schema migration、固定类型菜单、四种空节点、全局追加、零 viewport mutation、折叠/展开壳和删除恢复；
2. 能力层：生图执行、文档编辑与审阅、HTML 编辑与沙箱预览；
3. 编排层：typed edge、直接上游快照、stale、Agent 受控创建节点和连线；
4. 收口层：旧 Design 适配、路径迁移、多窗口、1000 节点和真实客户端验收。

每阶段写入的新数据必须可被后续阶段向前兼容读取。阶段未完成时不把对应能力标记为可用；可以通过 feature readiness 控制菜单启用状态，但最终四种节点均须启用。

## 测试与验收

### 共享与主进程 BDD

- 旧 `visual-document` 迁移为 `document`，新写入拒绝旧类型；
- 顶部四种节点创建分别原子提交空内容与图引用；
- 创建失败不产生孤立目录、节点、边或 viewport mutation；
- 全局追加在平移、缩放、不同节点位置和不同尺寸下保持确定性；
- 节点内容 revision 与 graph revision 独立并正确处理冲突；
- 删除非 Agent 节点进入 trash，恢复保留内容身份；
- 生图执行固化模型、直接上游版本和提示词；
- 文档与原型 Agent 修改必须经过差异审阅；
- 无连线节点不能读取彼此内容；
- 上游变化只产生 stale，不自动执行；
- Agent mutation batch 任一非法时不产生部分图变更；
- 原型阻断 Node、IPC、本地文件、网络、下载和外部导航。

### Renderer BDD

- 顶部添加始终打开类型菜单，四种类型可用且视频禁用；
- 创建成功后节点已选中但折叠，viewport 与 zoom 保持不变；
- 连续创建按最右侧稳定追加；
- 节点侧添加继续创建并连线下游；
- 同一时间只展开一个工作台，展开不改写节点位置和边；
- 未保存草稿切换时提供保存、放弃或取消；
- 折叠节点不触发重内容读取；
- 生图、文档、原型的正常、加载、运行、失败、重试和恢复状态可达；
- stale、输入缺失和节点内容损坏只影响目标节点；
- 键盘、窄窗口、深浅主题、焦点、文本溢出和禁用说明正确。

### 回归与真实窗口

- Canvas Agent creation/rebuild/detach、active-run、STOP、completion generation 和消息交接；
- 普通 Agent、LAN/mobile、Automation、Collaboration 的内部会话隔离；
- Design Job、图片模型路由、素材引用、trace 和删除安全；
- stable-directory helper、路径迁移、多窗口 revision 和 recovery；
- 1000 节点下首帧、拖动、平移、缩放和连续添加性能；
- 真实 Electron 验证节点菜单、四种节点、工作台展开、重启恢复、原型沙箱与资源释放。

完成每阶段后先运行最小定向测试，再运行 `bun run typecheck` 和 `bun run electron:build`。原型沙箱和付费生图链必须单独执行真实客户端安全/计费边界验收。

## 非目标

- 本阶段不实现视频生成；
- 不允许无连线节点共享上下文；
- 不自动连锁执行，不因 stale 自动产生模型或付费调用；
- 不让原型访问真实后端、外部网络、Node、Electron 或项目任意文件；
- 不把大内容写入 Canvas 图文档；
- 不让多个完整工作台或原型运行环境同时挂载；
- 不删除 Canvas Agent 的底层对话；
- 不把 Canvas 编辑能力开放给 LAN/mobile、Automation 或普通 Collaboration；
- 不创建第二套 Agent runtime 或第二套图片执行器。
