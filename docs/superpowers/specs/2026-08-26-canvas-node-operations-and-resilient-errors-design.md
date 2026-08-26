# Canvas 节点操作与局部故障恢复设计

## 状态

- 日期：2026-08-26
- 结论：已由用户确认
- 范围：原生 Canvas 节点工具栏、Agent 节点创建/扩展/删除/重建、节点级错误降级
- 前置规格：`2026-08-25-canvas-session-agent-orchestration-design.md`

## 结论

原生 Canvas 恢复旧 Design 的顶部悬浮工具栏形态，并明确区分两种创建语义：顶部“添加节点”创建无连线的独立节点，节点右侧 `+` 从当前节点创建下游节点并自动连线。删除只移除画布节点和关联边，底层 Agent 对话记录保留。

Canvas 加载必须区分“图文档损坏”和“单个业务引用不可用”。图文档、路径授权、schema 或未完成事务损坏时继续 fail closed；已提交 Agent 节点引用的会话缺失或归属异常时，仍返回完整画布，只把对应节点标记为“会话不可用”。用户可以显式重建为空白 Agent 会话，或删除该节点。

Renderer 不再直接展示 Electron IPC 异常正文。内部 session ID、路径、IPC 通道和堆栈只进入本地日志；界面只消费稳定公开错误码和可执行恢复动作。

## 与前置规格的关系

本规格是 Canvas 会话目标架构的当前增量，不改变以下长期方向：

- Canvas 仍将支持 `agent`、`image`、`visual-document` 和 `webview` 四类真实模块；
- 连线仍表达显式、有方向的数据或任务关系；
- 画布内浮动 Agent 对话仍是长期交互目标；
- Agent 仍可在受控权限内自动创建模块和连线。

当前实现仍使用右侧 Agent 对话面板，本次只为该面板增加坏节点恢复状态，不提前实施多浮窗对话。顶部节点类型菜单保留四类稳定入口，但在对应执行器接入前只启用 Agent，不展示可以执行的假能力。

## 要解决的问题

当前实现存在四个相互关联的问题：

1. 添加 Agent 入口是标题栏中的单个图标，Canvas 加载失败时完全不可用，且无法承载后续模块类型；
2. `remove-nodes` 已存在于共享 mutation 和 Store reducer，但 Renderer 没有可发现的删除入口；
3. 用户无法表达“从当前节点创建并关联下游节点”，只能线性追加独立 Agent；
4. 创建事务对账把已提交节点的单会话归属异常提升为 Canvas 致命错误，Renderer 又直接显示 `Error.message`，导致整张画布被阻断并泄露内部错误细节。

问题本质不是缺少三个按钮，而是缺少统一的节点命令合同和错误分级。仅在 Renderer 隐藏错误无法恢复权威快照；加载时静默自动重建会话又会改变对话身份并误导用户。因此必须在主进程把节点级问题作为公开派生状态返回，并让结构操作继续经过可恢复事务。

## 交互设计

### 顶部悬浮工具栏

Canvas 顶部居中显示悬浮工具栏，复用现有 Radix/shadcn primitives、主题变量、32px 图标按钮、Tooltip 和焦点样式。首批命令为：

- 选择；
- 平移；
- 添加节点；
- 删除选中节点。

现有左下角缩放与适应画布控件继续保留。撤销、重做、分组、箭头批注和画笔蒙版不在本次范围内；在原生 Canvas 具备完整历史或对应数据合同前不显示禁用占位按钮。

“添加节点”打开类型菜单：

- Agent：可用；
- 生图：保留稳定类型，当前禁用；
- 视觉文档：保留稳定类型，当前禁用；
- 原型：底层 `webview`，当前禁用。

窄窗口优先保持图标模式；空间不足时低频动作进入溢出菜单。工具栏不得遮挡右侧对话面板或产生横向页面滚动。

### 独立添加

用户从顶部菜单选择 Agent 后：

1. Renderer 以当前可视中心和现有确定性避让规则计算位置；
2. 创建服务原子提交 Agent session 和节点；
3. 成功后选中新节点并打开其对话；
4. 失败时保留原画布，不添加占位节点或边。

独立添加不产生任何连线，表示新 Agent 与现有节点没有数据或任务关系。

### 从节点扩展

可写且健康的节点在悬浮或选中时，于右侧显示固定屏幕尺寸的 `+`。键盘选中节点后也能聚焦该按钮。

点击 `+` 打开相同的节点类型菜单。首批选择 Agent 后：

1. 新节点以源节点右侧为首选位置，并使用确定性避让寻找不重叠位置；
2. Renderer 预分配 operation、node 和 edge 稳定 ID；
3. 主进程在一个可恢复事务中提交 session、节点和边；
4. 节点与边共享同一 Canvas revision；
5. 成功后选中新节点并打开新对话。

源节点存在节点级问题、Canvas 不可写、正在恢复或存在结构冲突时，扩展入口禁用并通过 Tooltip 说明原因。创建失败不得留下孤立节点、重复边或悬空边。

### 删除节点

顶部删除按钮只在存在可删除选区时启用。`Delete` 和 `Backspace` 复用同一命令，但输入框、文本域、富文本编辑器及其他可编辑区域获得焦点时不得触发。

删除前使用确认框说明：

- 将删除节点；
- 将同步删除的关联边数量；
- Agent 对话记录会保留。

运行中的 Agent 节点不能直接移除。界面先提供“停止后删除”，只有 Agent 到达终态后才提交 `remove-nodes`；停止失败或仍在运行时保持节点不变，避免产生不可见的后台运行。

删除继续使用权威 `remove-nodes` mutation。Store 在同一 revision 中移除节点和全部关联边；后续对账把对应创建 intent 转为 `detached`，不会重建引用。底层 Agent session 不归档、不删除，也不重新进入普通会话列表。

Renderer 的停止流程只负责交互，不能成为唯一守卫。主进程在应用含 Agent 节点的 `remove-nodes` 前必须重新解析权威 document 和 active run，运行仍未结束时以公开 `AGENT_SESSION_BUSY` 拒绝整个 mutation batch。

### 会话重建

坏 Agent 节点保持原位置和连线，节点卡显示“会话不可用”。点击后，现有右侧面板显示：

> 此节点关联的 Agent 会话不可用。你可以重建为空白会话，或从画布删除该节点；原对话记录不会被删除。

提供“重建会话”和“删除节点”两个动作。重建必须明确创建新的空白对话，不得暗示旧消息已恢复。

重建成功时保留节点 ID、标题、位置和所有边，只替换 `agentSessionId`。旧 session 及其文件不删除。若旧 session 仍有权威活动运行，重建先拒绝并要求停止，不能让运行结果写入已换绑节点。

## 权威数据合同

### 运行时节点问题

`CanvasWorkspaceSnapshot` 增加运行时派生问题列表：

```ts
type CanvasNodeIssueCode = 'AGENT_SESSION_UNAVAILABLE'

interface CanvasNodeIssue {
  nodeId: string
  code: CanvasNodeIssueCode
  allowedActions: Array<'rebuild-agent-session' | 'remove-node'>
}

interface CanvasWorkspaceSnapshot {
  document: CanvasDocument
  writable: true
  nodeIssues: CanvasNodeIssue[]
  recoveredFrom?: 'tmp' | 'backup'
}
```

`nodeIssues` 不进入 `CanvasDocument`，不增加 schema 版本，不写入项目文件，也不包含 session ID、路径或内部错误正文。Renderer 以 `document + nodeIssues` 共同投影节点状态，但所有结构身份仍只来自权威 document。

首批公开码合并“会话不存在”和“Canvas 三字段归属异常”，因为两者的用户动作相同。主进程日志保留内部分类，便于诊断。

### 错误分级

以下错误继续阻断 Canvas 加载：

- Canvas 路径授权、stable-directory capability 或 workspace 归属失败；
- Canvas JSON、schema、revision 或节点/边结构损坏；
- intent 文件名、schema、稳定身份或持久性状态损坏；
- `prepared` / `session-created` 未完成事务无法安全对账；
- native helper 或原子写无法确定事实是否已提交。

以下情况降级为节点问题：

- document 中存在 Agent 节点；
- 与节点对应的创建 intent 已是 `committed`；
- session 缺失，或 session 不再满足该节点的完整 Canvas 独占归属；
- 图文档和 intent 自身仍可安全读取并确定身份。

加载不得自动创建、换绑或删除 session。降级只改变返回快照，不产生磁盘写入。

### 扩展命令

现有 Agent 创建输入增加可选关系字段，独立添加不传该字段：

```ts
interface CreateCanvasAgentNodeRelationship {
  sourceNodeId: string
  edgeId: string
}

interface CreateCanvasAgentNodeInput extends CanvasTarget {
  operationId: string
  nodeId: string
  title: string
  position: DesignPoint
  relationship?: CreateCanvasAgentNodeRelationship
}
```

主进程验证源节点存在、健康、属于当前 Canvas，并使用固定兼容端口创建 `source -> target` 边。创建 intent 记录可选关系事实；重试或崩溃恢复必须复用相同 node 和 edge ID，禁止重复创建。

### 重建命令

重建使用独立 IPC 与独立可恢复 intent，不能把它伪装为普通 `upsert-nodes`：

```ts
interface RebuildCanvasAgentNodeInput extends CanvasAgentTarget {
  operationId: string
}

interface RebuildCanvasAgentNodeResult {
  snapshot: CanvasWorkspaceSnapshot
  session: AgentSessionMeta
}
```

重建 intent 保存 node ID、旧 session ID、预分配新 session ID 和事务阶段，按 `prepared -> session-created -> committed` 推进。提交阶段只替换节点的 session 引用并递增一次 revision。恢复时以 intent、session registry 和 document 三方事实判断继续、完成或明确失败；不得出现节点短暂引用未注册 session 的可见状态。

## 主进程与 IPC

IPC 继续同步四层合同：

1. `packages/shared` 增加 snapshot issue、扩展关系和重建请求/响应类型及通道；
2. `apps/electron/src/main/lib/design` 负责对账分级、扩展创建和重建事务；
3. `apps/electron/src/preload` 暴露最小类型安全 bridge；
4. Renderer 通过 Design Adapter 调用，不读取会话索引或本地路径。

LOAD、SAVE、CREATE 和 REBUILD 继续按 `projectId + canvasId` 键控串行，并在现有 workspace write lease 内执行权威操作。发布仍发生在 lease 释放后；recovery 事件优先级、历史对账 revision 和后续操作错误不得相互吞掉。

删除沿用 SAVE mutation，不增加删除 session 的 IPC。运行态检查和停止继续复用现有 Canvas Agent STOP 合同。

### 公开错误信封

相关 invoke API 不把底层 `Error.message` 当作用户合同。可预期业务失败使用共享结果联合：

```ts
type CanvasPublicErrorCode =
  | 'CANVAS_LOAD_FAILED'
  | 'CANVAS_REVISION_CONFLICT'
  | 'AGENT_SESSION_BUSY'
  | 'AGENT_SESSION_REBUILD_FAILED'

interface CanvasPublicError {
  code: CanvasPublicErrorCode
  message: string
}

type CanvasInvokeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CanvasPublicError }
```

主进程只为已分类失败返回稳定码和安全中文文案。未预期异常仍写入内部日志；Preload/Adapter 捕获 Electron invoke rejection 后必须丢弃原始 message，并按当前操作映射为通用公开失败。Renderer 只读取 `CanvasInvokeResult`，不能回退展示捕获异常的字符串。

## Renderer 状态

原生 Canvas Jotai 状态增加当前 snapshot 的 `nodeIssues` 投影，不另存 session ID。Canvas 切换、LOAD 代次、权威 recovery 和 dispose 必须同时清理旧问题列表，避免上一 Canvas 的错误污染新画布。

工具栏、节点卡和右侧面板消费同一派生 selector：

- 工具栏警告徽标显示当前问题数量；
- 节点卡显示健康、运行或会话不可用；
- 对话面板对坏节点不调用 GET/SEND/STOP 消息接口；
- 重建成功的权威 snapshot 一次性替换旧节点问题和 session 引用；
- 迟到的 GET、SEND、创建或重建结果继续受 Canvas 命令代次和 node generation 隔离。

普通 Agent lifecycle、未读、通知和状态岛不能消费 `nodeIssues`，也不能把坏 Canvas session 恢复为普通会话。

## 用户可见错误

Renderer 不直接展示 `Error.message`。统一映射如下：

- Canvas 致命加载失败：“画布暂时无法加载。”，提供“重试”；
- 节点级问题：“会话不可用”；
- 重建失败：“重建失败，请重试。”；
- revision 冲突：重新加载权威画布后提示用户重试；
- 运行中重建或删除：提示先停止 Agent。

画布级详情只能展示稳定公开说明。`Error invoking remote method`、IPC 通道、session UUID、绝对路径和堆栈不得进入标题栏、画布、右侧面板、Toast 或系统通知。内部日志继续记录诊断细节，但不得包含凭据或消息正文。

节点级问题不使用顶部红色致命错误条。工具栏显示紧凑警告徽标，例如“1 个节点需要处理”；点击后聚焦首个问题节点。单个节点异常不触发普通 Agent 错误 Toast。

## 关联业务影响

### 普通 Agent 与会话可见性

重建产生的新 session 继续带完整 Canvas 三字段归属，旧、新 session 都从普通会话列表、搜索、归档、最近记录、未读、通知、状态岛、项目记忆和 LAN/mobile 中排除。删除节点不会改变 session 可见性。

### Canvas 运行态

坏节点不得进入 GET/SEND/STOP 对话路径。active-invalid run 仍按现有 fail-closed lifecycle 保留最小运行事实；用户必须先停止后才能重建或删除，不允许用 Renderer owner fallback 恢复身份。

### 旧 Design、生图和原型

本次只修改原生 Canvas Agent 节点合同，不改变旧 Design Store、Design Job、生图模型路由、素材、trace 或原型沙箱。禁用的未来节点类型不启动任务、不读素材、不产生付费调用。

### 项目迁移与多窗口

所有新事务继续使用目标 Canvas 的稳定目录 capability 和项目迁移守卫。多窗口通过 revision 和 graph/recovery 广播收敛；本地删除、扩展或重建遇到结构冲突时不得覆盖远端。

## 性能与资源

- LOAD 只读取有限 intent 和 session 元数据，不读取 JSONL 消息，不启动 Agent；
- `nodeIssues` 只存在于内存和 IPC 响应，不产生额外正常路径写盘；
- intent 仍受单 Canvas 512 项上限和稳定目录锁保护；
- 对账复杂度保持与当前 Canvas 节点、边和有限 intent 数量线性相关；
- 扩展创建只增加一个节点、一条边和一次 session 创建；
- 重建只创建一个空 session 并替换一个稳定引用，不复制旧消息；
- XYFlow 继续使用 `onlyRenderVisibleElements`，问题状态不得关闭节点虚拟化；
- 离开 Canvas 后继续释放 Renderer 临时问题、选区和面板状态。

## 测试与验收

### 主进程 BDD

- Given 正常 Agent 节点，When LOAD，Then 返回完整 snapshot 且 `nodeIssues` 为空；
- Given committed 节点的 session 缺失或归属异常，When LOAD，Then 返回完整 document 并只标记目标节点；
- Given Canvas、intent、路径授权或未完成事务损坏，When LOAD，Then 继续 fail closed；
- Given 独立创建，When 成功，Then 只增加节点；
- Given 从健康节点扩展，When 成功，Then 节点与边在同一 revision 提交；
- Given 扩展在任一事务阶段失败或重试，Then 不产生重复节点、重复边或悬空边；
- Given 删除节点，When SAVE，Then 同 revision 删除关联边，后续对账转 detached 且 session 保留；
- Given 运行中的节点，When 删除或重建，Then 拒绝结构变化并要求先停止；
- Given 坏节点重建成功，Then 保留 node ID、标题、位置和边，只替换 session 引用；
- Given 重建任一阶段失败或恢复，Then 不暴露半提交引用，并保持可重试或明确失败；
- Given 主进程内部异常，When 跨 IPC 返回，Then 只暴露稳定公开码和安全文案。

### Renderer BDD

- 顶部悬浮工具栏在宽窄窗口、深浅主题和右侧面板打开时均可达；
- 添加菜单只启用 Agent，未来类型有明确禁用原因；
- 顶部添加创建独立节点，节点 `+` 创建并选择自动连线的下游节点；
- 删除按钮和快捷键共用确认框，编辑器焦点不误触；
- 确认框显示关联边数量和“对话记录保留”；
- 坏节点不阻断画布拖动、缩放、添加、删除或其他 Agent 对话；
- 坏节点面板不发送 GET/SEND，提供重建和删除；
- 工具栏徽标、节点状态和面板使用同一问题事实；
- 切换 Canvas、recovery、dispose 和迟到请求不会污染当前 Canvas；
- UI 中不存在 `Error invoking remote method`、内部 UUID、绝对路径或堆栈。

### 关联回归

- Canvas Agent active-run bootstrap、STOP、completion generation 和消息交接；
- Canvas 内部 session 在全部普通会话消费者中的排除；
- workspace write lease、稳定目录 helper、项目迁移和多窗口 revision；
- 旧 Design、生图任务、素材、trace 和普通 Agent 对话；
- 全仓类型检查、Electron 构建和稳定目录平台测试。

### 真实窗口验收

- 1200px 宽窗口验证工具栏、节点扩展菜单、删除确认和局部问题状态；
- 620px 窄窗口验证溢出菜单、文字不溢出、右侧面板和焦点顺序；
- 深浅主题验证警告、错误、选中和禁用状态；
- 多节点画布中注入一个坏 session，确认其余节点与工具栏持续可用；
- 键盘验证选择、菜单、删除、确认、取消、恢复和输入框隔离。

## 不在本次范围

- 生图、视觉文档和原型节点的真实执行器；
- 画布内多 Agent 浮动对话窗；
- 连线手工编辑、端口兼容 UI 和任意节点类型互连；
- Canvas 完整撤销/重做历史；
- 自动修复或静默换绑坏 session；
- 删除、归档或迁移底层 Agent 对话记录；
- LAN/mobile、Automation 或 Collaboration 的 Canvas 编辑能力。
