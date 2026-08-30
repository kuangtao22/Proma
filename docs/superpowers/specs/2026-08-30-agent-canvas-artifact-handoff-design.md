# Agent 画布产物联动与 WebView 原子写入设计

## 状态

- 日期：2026-08-30
- 结论：采用 Agent 结构化提议、Host 确认和受控原子内容写入
- 范围：普通项目 Agent、右侧画布、图片节点、WebView 原型节点

## 问题与目标

当前普通 Agent 虽然能创建和关联画布，也能批量修改图结构，但发送前的视觉分流仍由 Renderer 正则判断，并固定打开 `legacy-design` 生图面板。HTML、WebView、React 等实现表达会被排除，图片的自然表达也覆盖不足。

Agent 生成 HTML 后只能得到项目文件。现有 `canvas_apply_changes` 只接受图结构 mutation，不接受 HTML 正文；WebView 内容没有 Agent 写入工具，`canvas_run_nodes` 对 WebView 仍返回 `CANVAS_NODE_EXECUTOR_UNAVAILABLE`。因此会出现“画布已创建，但节点写入返回 `CANVAS_MUTATION_INVALID`，右侧画布为空”。

本次目标：

1. 由 Agent 基于完整语义判断是否建议把任务转入画布，不再依赖页面关键词决定产物类型。
2. 在发生任何画布写入前，让用户选择“WebView 原型”“图片设计稿”或“继续普通 Agent”。
3. 用户确认后，Agent 能在同一画布事务链中创建节点、写入内容并让 Renderer 定位结果。
4. WebView 使用受管单文件 HTML 作为首版权威内容；Agent 不直接写 Canvas 内部目录。
5. 保持普通代码实现、只读分析、带附件任务和已有节点引用流程不变。

## 方案比较

### 方案 A：继续扩充 Renderer 正则

增加“网页、HTML、图片、原型”等关键词并映射到节点类型。实现快，但换一种表达就失效，无法结合项目上下文，也会重复用户已经指出的“硬加”问题。

### 方案 B：Agent 结构化提议 + Host 确认 + 原子内容工具（采用）

普通项目 Agent 获得只产生建议、没有业务写副作用的 `canvas_propose_artifact` 工具。Agent 根据完整语义和项目上下文提交 `artifactType`、标题、建议画布和原始要求；Host 把工具结果渲染为确认卡。用户确认后，Host 将确认结果作为同一任务的明确授权交回 Agent，Agent 再调用画布管理、节点内容写入和执行工具。

该方案保留 Agent 理解能力，同时让 Host 负责授权、类型验证和持久化边界。代价是需要补齐一个提议状态和一个内容写入工具，但不会把语义规则散落到 Renderer。

### 方案 C：Agent 直接生成文件，Renderer 监听并自动导入

复用现有文件生成能力，但文件与节点缺少稳定身份、原子 revision 和失败恢复，容易产生重复导入与孤立节点，不采用。

## 交互设计

### 触发规则

- 明确说“在画布中创建 WebView/设计稿”视为已选择画布，可直接进入对应确认卡，不再询问是否使用画布，只确认产物类型和执行。
- “做一个可点击的首页”“先画一版看看”“生成一个页面演示”等需要语义判断的表达，由 Agent 决定是否调用提议工具。
- 普通分析、解释、修复现有代码或只要求输出项目文件时不提议画布。
- 已附加 Canvas 节点引用时，Agent优先使用现有画布上下文，不弹出全新画布建议。

### 确认卡

确认卡显示 Agent 建议和三个稳定动作：

- `创建 WebView 原型`
- `创建图片设计稿`
- `继续普通 Agent`

Host 不在卡片出现时创建画布或节点。关闭卡片等同继续普通 Agent，不丢失原始输入。用户确认产物后，卡片进入执行中状态，完成后自动打开当前 Agent 右侧对应画布、选择新节点并保留工具审计记录，不新增一条伪造普通对话。

### 错误恢复

- 提议失败：原消息继续普通 Agent，不阻断发送。
- 创建或内容写入失败：保留 Agent 消息和确认卡错误，画布事务不得留下半节点。
- WebView 渲染失败：保留节点与 HTML 内容，显示可重试错误。
- revision 冲突：权威重读后最多重试一次；仍失败则要求用户重试。

## Agent 工具与数据流

### `canvas_propose_artifact`

只返回结构化建议，不写盘：

```ts
interface CanvasArtifactProposal {
  artifactType: 'webview' | 'image'
  title: string
  prompt: string
  preferredCanvasId?: string
}
```

工具仅对交互式普通项目 Agent 开放。系统提示要求 Agent 根据完整语义调用，不按单一关键词触发。

### `canvas_upsert_content`

受控写入一个已关联画布的内容节点：

```ts
interface CanvasContentWriteInput {
  canvasId: string
  nodeId: string
  kind: 'webview' | 'document'
  expectedContentRevision: number
  content: string
}
```

首版 WebView `content` 必须是完整单文件 HTML。主进程复用 `canvas-node-content-store` 的原子写和内容 revision，不允许 Agent 传路径、目录或任意文件名。HTML 大小、脚本、外部资源和预览继续受现有安全策略限制。

### 原子执行顺序

```text
Agent 提议产物
  -> Host 展示确认卡
  -> 用户确认类型
  -> canvas_manage 创建或选择画布
  -> canvas_apply_changes 创建 idle 节点与连线
  -> canvas_upsert_content 写入 HTML/文档正文
  -> canvas_run_nodes 生成图片或刷新 WebView 预览
  -> 广播权威 revision
  -> 右侧画布打开并选中新节点
```

图结构与内容使用各自 revision。对新节点，创建图结构和初始化内容必须由主进程编排为可恢复操作：内容写入失败时回滚新节点或完成幂等补偿，禁止用户看到永久空白节点。

## 组件边界

- Renderer `AgentView`：移除固定 Design 正则分流职责，渲染结构化提议卡和用户选择。
- 主进程 Agent 扩展：注入提议工具与已确认的画布授权上下文。
- `CanvasToolProvider`：保留现有五工具，增加内容写入；不得直接访问 Renderer 状态。
- `CanvasNodeContentStore`：继续作为 HTML/Markdown 内容的唯一持久化边界。
- 右侧画布工作区：接收完成事件后打开、定位和选中节点，不决定 Agent 意图。

不新增数据库、依赖或新的左侧会话类型。

## 关联业务与性能

- 普通 Chat、Automation、飞书触发和画布内部 Agent 不注入提议工具，避免无 UI 确认通道时悬挂。
- 普通项目 Agent 每轮仅增加一个小型工具 schema；不额外调用独立模型，不增加一次固定网络请求。
- 只有 Agent 实际提议且用户确认后才发生 Canvas I/O；WebView 内容按大小上限单次原子写入。
- 图片生成继续遵循现有模型、审批、费用和任务恢复规则。
- 旧 `legacy-design` 数据继续可打开，但新联动不再固定写入该画布。

## 验收标准

1. “帮我创建一个网页原型”会出现类型化画布确认卡，而不是直接修改项目代码。
2. “帮我增加一张图片设计稿”会出现同一确认卡并默认建议图片类型。
3. 选择 WebView 后，当前 Agent 自动关联或创建画布，节点显示真实 HTML 预览，不出现 `CANVAS_MUTATION_INVALID`。
4. 选择图片后，创建图片节点并预填原始要求；付费生成仍需要现有执行确认。
5. 选择继续普通 Agent 后，原始消息只发送一次，不再次弹出同一提议。
6. 明确代码修复、分析请求、带附件请求和已有 Canvas 引用请求保持原行为。
7. WebView 内容写入失败不会留下不可恢复空节点；重试保持同一工具调用身份。
8. 相关 BDD 测试覆盖语义提议、用户选择、WebView 原子写入、revision 冲突、失败补偿和旧流程回归。

## 非目标

- 视频节点执行。
- 多文件前端工程和构建工具链。
- 自动导入 Agent 任意生成的项目文件。
- 让 Renderer 自己推断页面类型。
- 修改 README、教程或发布说明。
