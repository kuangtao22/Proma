# Agent Canvas 工作区恢复设计

## 目标

普通 Agent 会话在用户明确打开 Canvas 后，应在切换会话、Renderer 重载或 Proma 重启后恢复相同的 Canvas 工作状态。恢复必须尊重用户最后一次标签选择，不得后台复时抢占文件、Skills、浏览器或其他右侧板能力。

## 用户行为

- 用户退出会话时正在查看某张 Canvas，再次进入该会话时恢复该 Canvas。
- 用户只保留 Canvas 标签但切换到了其他右侧板标签，再次进入时保持用户最后选择的非 Canvas 标签，不主动切回 Canvas。
- 用户关闭整个右侧工作区后，保持右侧工作区关闭；Canvas 标签记录继续保留，重新打开右侧工作区后仍可回到原 Canvas。
- 用户关闭某个 Canvas 标签后，该标签不再恢复。
- Canvas 已删除、归档、解除关联或不再属于当前项目时，不恢复失效标签，也不展示空壳内容。

## 状态模型

新增按 `sessionId` 隔离的持久化 Canvas 工作区状态：

```ts
interface PersistedAgentCanvasWorkspaceState {
  openTabs: AgentSidePanelTab[]
  activeTab: AgentSidePanelTab | null
}
```

`openTabs` 只允许通过现有 Canvas tab parser 验证的具体 `canvas:<canvasId>` 标签，不保存仅用于首次选择的 `canvas` launcher。`activeTab` 只记录退出时实际处于前台的具体 Canvas；用户切到非 Canvas 标签时清空，从而避免重启后 Canvas 抢焦点。读取到未知字段、错误类型或非法标签时按空状态降级，不让损坏的本地偏好卸载 Renderer。

状态使用 Jotai `atomWithStorage<Record<string, PersistedAgentCanvasWorkspaceState>>` 保存到 Renderer 本地存储。项目 Canvas、关联权限和默认画布仍由现有主进程 registry 与 binding 负责，Renderer 持久化状态只表达用户界面意图，不能成为访问权限或 Canvas 存在性的依据。

## 恢复流程

1. SidePanel 读取当前 `sessionId` 的持久化状态。
2. 等待当前 `projectId + sessionId` 的 Canvas metadata 与 binding 同时就绪。
3. 使用实时可用 Canvas 标签过滤 `openTabs`，并把清理后的结果写回持久化状态。
4. 若 `activeTab` 仍在有效集合内，右侧工作区处于打开状态，且加载期间用户没有主动选择其他标签，则恢复该 Canvas。
5. 若 `activeTab` 已失效，则清空它并沿用现有右侧标签回退逻辑，不自动新建 Canvas，也不自动打开 launcher。

恢复动作需要绑定当前宿主身份与单调代次。会话切换、项目切换或用户主动选择标签后，迟到的恢复结果不得改写新宿主或覆盖用户选择。

## 写入与清理

- 打开或切换 Canvas 时，将具体 Canvas 加入 `openTabs`，并在其成为当前前台标签时写入 `activeTab`。
- 切换到非 Canvas 标签时只清空 `activeTab`，保留 `openTabs`。
- 关闭、归档、删除或解除关联 Canvas 时，同步移除对应标签；若它是 `activeTab`，同时清空。
- 删除或归档 Agent 会话时删除整个 `sessionId` 条目。
- 持久化集合最多保留最近活动的 50 个普通 Agent 会话，并采用与现有会话布局相同的会话元数据排序和活动会话兜底策略，避免历史会话长期累积本地状态。

## 关联模块影响

- `agent-atoms.ts`：将当前运行期 Canvas 打开标签 Map 替换为带校验边界的持久化状态，并提供集中更新方法。
- `SidePanel.tsx`：登记打开、关闭、焦点切换、恢复和失效过滤；不改变 Canvas registry、binding 或主进程 IPC。
- `useGlobalAgentListeners.ts`：Canvas 通知导航继续登记并激活具体 Canvas，改为写入统一持久化状态。
- `LeftSidebar.tsx`：会话终态清理同步删除持久化 Canvas 状态。

该改动不影响 Canvas 图数据、Agent 执行、图片任务、项目权限、WebView 或普通右侧工作区标签的数据模型。

## 性能与资源

每个会话仅保存少量 Canvas 标签字符串和一个活动标签。打开、关闭和切换时发生一次小型本地存储写入；恢复与清理使用内存集合做线性过滤，复杂度与该会话已打开 Canvas 数量成正比。实现不新增 IPC、目录扫描、轮询、媒体读取或后台任务。

## 测试

BDD 回归至少覆盖：

- 已打开且正在查看的 Canvas 在重新挂载和本地存储恢复后重新激活。
- 已打开但退出时查看其他右侧标签时，不抢回 Canvas 焦点。
- 用户关闭的 Canvas 不再恢复。
- 删除、归档、解绑和跨项目失效 Canvas 被清理。
- metadata 或 binding 未就绪时不提前清洗状态。
- 恢复请求在会话切换或用户主动选标签后失效，不覆盖新选择。
- 会话删除或归档后不遗留持久化条目。

实现后运行相关 Bun 测试，再运行 `bun run typecheck`；若变更只涉及 Renderer 状态与组件，不要求新增 Electron 主进程构建验证。
