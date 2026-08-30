# Agent 画布产物联动与 WebView 原子写入设计

## 状态

- 日期：2026-08-30
- 结论：复用 Agent 交互式问答，并通过受控原子产物工具写入画布
- 范围：普通项目 Agent、右侧画布、图片节点、WebView 原型节点

## 问题与目标

当前普通 Agent 虽然能创建和关联画布，也能批量修改图结构，但发送前的视觉分流仍由 Renderer 正则判断，并固定打开 `legacy-design` 生图面板。HTML、WebView、React 等实现表达会被排除，图片的自然表达也覆盖不足。

Agent 生成 HTML 后只能得到项目文件。现有 `canvas_apply_changes` 只接受图结构 mutation，不接受 HTML 正文；WebView 内容没有 Agent 写入工具，`canvas_run_nodes` 对 WebView 仍返回 `CANVAS_NODE_EXECUTOR_UNAVAILABLE`。因此会出现“画布已创建，但节点写入返回 `CANVAS_MUTATION_INVALID`，右侧画布为空”。

本次目标：

1. 由 Agent 基于完整语义判断是否建议把任务转入画布，不再依赖页面关键词决定产物类型。
2. 需求存在歧义时，复用 `AskUserQuestion` 让用户选择“WebView 原型”“图片设计稿”或“继续普通 Agent”；用户已明确指定画布产物时不重复询问。
3. 产物类型确定后，Agent 能在同一画布事务链中创建节点、写入内容并让 Renderer 定位结果。
4. WebView 使用受管单文件 HTML 作为首版权威内容；Agent 不直接写 Canvas 内部目录。
5. 保持普通代码实现、只读分析、带附件任务和已有节点引用流程不变。

## 方案比较

### 方案 A：继续扩充 Renderer 正则

增加“网页、HTML、图片、原型”等关键词并映射到节点类型。实现快，但换一种表达就失效，无法结合项目上下文，也会重复用户已经指出的“硬加”问题。

### 方案 B：Agent 语义判断 + 现有问答 + 原子产物工具（采用）

普通项目 Agent 根据完整语义和项目上下文判断用户需要代码文件、WebView 原型还是图片设计稿。需求存在歧义时调用已有 `AskUserQuestion`，其现有阻塞/恢复链路会把用户选择交还同一轮 Agent；用户明确指定产物类型时直接执行。确认后，Agent 调用单一 `canvas_create_artifact` 工具，由主进程原子完成节点内容准备、图结构提交和失败补偿。

该方案保留 Agent 理解能力，同时让 Host 负责交互、类型验证和持久化边界。它不新增提议状态机或独立模型请求，也不会把语义规则散落到 Renderer。

### 方案 C：Agent 直接生成文件，Renderer 监听并自动导入

复用现有文件生成能力，但文件与节点缺少稳定身份、原子 revision 和失败恢复，容易产生重复导入与孤立节点，不采用。

## 交互设计

### 触发规则

- 明确说“在画布中创建 WebView/设计稿”视为已选择画布和产物类型，Agent 直接执行，不重复询问。
- “做一个可点击的首页”“先画一版看看”“生成一个页面演示”等需要语义判断的表达，由 Agent 决定是否调用 `AskUserQuestion`。
- 普通分析、解释、修复现有代码或只要求输出项目文件时不提议画布。
- 已附加 Canvas 节点引用时，Agent优先使用现有画布上下文，不弹出全新画布建议。

### 交互式选择

复用现有 `AskUserQuestion` 横幅显示三个稳定选项：

- `创建 WebView 原型`
- `创建图片设计稿`
- `继续普通 Agent`

Host 不在问题出现时创建画布或节点。用户选择会作为工具回答返回同一轮 Agent；选择继续普通 Agent 后不再追问。产物完成后自动打开当前 Agent 右侧对应画布、选择新节点并保留工具审计记录，不新增一条伪造普通对话。

### 错误恢复

- 问答交互失败：保持现有 `AskUserQuestion` 错误和恢复语义，不发生画布写入。
- 创建或内容写入失败：保留 Agent 消息和工具错误，画布事务不得留下半节点。
- WebView 渲染失败：保留节点与 HTML 内容，显示可重试错误。
- revision 冲突：权威重读后最多重试一次；仍失败则要求用户重试。

## Agent 工具与数据流

### `canvas_create_artifact`

在一个已关联或待创建的画布中原子创建内容节点：

```ts
interface CanvasCreateArtifactInput {
  canvasId: string
  baseRevision: number
  artifactType: 'webview' | 'image'
  title: string
  content: string
  position?: { x: number; y: number }
  sourceNodeId?: string
}
```

WebView 的 `content` 必须是完整单文件 HTML；图片的 `content` 是生成提示词。主进程复用 `canvas-node-content-store` 的受管目录，不允许 Agent 传路径、目录或任意文件名。工具先准备内容，再提交节点和可选连线；提交失败时清理 prepared content。revision 冲突只允许权威重读后重试一次，同一 `sourceToolCallId` 保持幂等。

### 原子执行顺序

```text
Agent 语义判断
  -> 歧义时 AskUserQuestion / 明确时直接继续
  -> canvas_manage 创建或选择画布
  -> canvas_create_artifact 准备内容、创建节点与可选连线
  -> 图片按需调用 canvas_run_nodes
  -> 广播权威 revision
  -> 右侧画布打开并选中新节点
```

WebView 内容成功落盘后即可预览，不需要异步执行器；`canvas_run_nodes` 对 WebView 返回稳定 `ready` 或 `idle`，不再返回 unsupported。对新节点，创建图结构和初始化内容由主进程编排为可恢复操作，禁止用户看到永久空白节点。

## 组件边界

- Renderer `AgentView`：移除固定 Design 正则分流与旧 `pendingDesignHandoff` 弹窗，继续复用现有 `AskUserBanner`。
- 主进程 Agent 提示：说明画布能力、语义判断边界、稳定问答选项，以及明确指令不重复询问的规则。
- `CanvasToolProvider`：保留现有工具并增加原子产物创建；不得直接访问 Renderer 状态。
- `CanvasNodeContentStore`：继续作为 HTML/Markdown 内容的唯一持久化边界。
- 右侧画布工作区：接收完成事件后打开、定位和选中节点，不决定 Agent 意图。

不新增数据库、依赖或新的左侧会话类型。

## 关联业务与性能

- 普通 Chat、Automation、飞书触发和画布内部 Agent 不注入原子产物工具，也不增加画布问答提示，避免无 UI 确认通道时悬挂。
- 普通项目 Agent 每轮仅增加系统提示和一个小型工具 schema；不额外调用独立模型，不增加固定网络请求。
- 只有 Agent 明确执行画布产物后才发生 Canvas I/O；WebView 内容按大小上限单次受管写入。
- 图片生成继续遵循现有模型、审批、费用和任务恢复规则。
- 旧 `legacy-design` 数据继续可打开，但新联动不再固定写入该画布。

## 验收标准

1. “帮我创建一个网页原型”由 Agent 结合上下文直接创建 WebView，或在类型仍有歧义时通过 `AskUserQuestion` 询问，不再由 Renderer 正则直接分流。
2. “帮我设计一个首页”会通过 `AskUserQuestion` 提供 WebView、图片设计稿和继续普通 Agent 三个选项。
3. 选择 WebView 后，当前 Agent 自动关联或创建画布，节点显示真实 HTML 预览，不出现 `CANVAS_MUTATION_INVALID`。
4. 选择图片后，创建图片节点并预填原始要求；付费生成仍需要现有执行确认。
5. 选择继续普通 Agent 后，同一轮继续执行普通 Agent 工作，不再次询问。
6. 明确代码修复、分析请求、带附件请求和已有 Canvas 引用请求保持原行为。
7. WebView 内容写入失败不会留下不可恢复空节点；重试保持同一工具调用身份。
8. 相关 BDD 测试覆盖 Agent 提示、问答选择、WebView 原子写入、revision 冲突、失败补偿、自动导航和旧流程回归。

## 非目标

- 视频节点执行。
- 多文件前端工程和构建工具链。
- 自动导入 Agent 任意生成的项目文件。
- 让 Renderer 自己推断页面类型。
- 修改 README、教程或发布说明。
