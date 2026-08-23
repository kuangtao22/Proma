# 手机端 Agent 会话状态与星标设计

## 目标

手机端会话列表需要在不打开会话的情况下，直接识别 Agent 会话的实时状态与星标，并保持与桌面客户端一致的交互语义。

成功标准：

- 会话行固定按“状态色块、标题、五角星、相对时间”排列。
- 状态覆盖空闲、运行中、等待处理、完成未查看四种语义。
- 会话从桌面、手机、Automation、Bridge 或协作入口启动时，手机端都能实时更新。
- 手机重连或刷新后从服务端快照恢复正确状态，不依赖此前收到过推送。
- 星标使用 Agent 会话已有的 `starred` 字段，用户可在手机端直接切换。

## 方案选择

采用“四态色块 + 可交互星标”方案。

对比过的方案：

1. 状态色块：信息密度低，保留标题和时间空间，且可通过形状、颜色与辅助文本共同满足可访问性，最终采用。
2. 文字状态标签：含义直接，但窄屏会明显压缩标题，并挤占相对时间空间。
3. 极简状态点：空间最小，但过度依赖颜色，不利于快速识别和无障碍使用。

## 视觉与交互

会话行使用稳定四列：

```text
[状态色块] [可截断标题] [五角星] [相对时间]
```

- 蓝色：`running`，Agent 正在执行。
- 橙色：`blocked`，等待权限确认、用户回答或计划审批。
- 绿色：`completed`，执行已完成但用户尚未查看。
- 灰色：`idle`，当前没有执行或待处理事项。
- 琥珀色实心星：已星标；灰色空心星：未星标。
- 点击标题区域打开会话；点击星标只切换星标，不打开会话。
- 图标均提供中文 `aria-label`，状态不可只依赖颜色传达。
- 会话行高度、星标列和时间列宽度固定，状态变化不能引发布局跳动。

抽屉列表与顶部会话切换下拉复用同一个会话行组件，避免两处状态表达漂移。现有置顶分组仍由 `pinned` 决定；`starred` 只用于快速识别，不改变排序。旧字段 `manualWorking` 不再代表实时运行状态。

## 数据模型

LAN 稳定 DTO 增加两个可选字段，保持旧客户端兼容：

```ts
export type LanBridgeAgentSessionRuntimeStatus = 'idle' | 'running' | 'blocked' | 'completed'

export interface LanBridgeAgentSessionDto {
  id: string
  title: string
  workspaceId?: string
  pinned?: boolean
  archived?: boolean
  manualWorking?: boolean
  starred?: boolean
  runtimeStatus?: LanBridgeAgentSessionRuntimeStatus
  createdAt: number
  updatedAt: number
}
```

字段保持可选，旧服务端不返回时手机端按 `idle` 展示。星标是持久化元数据；运行状态只存在主进程内存和 WebSocket 消息中，不写入会话 JSON。

## 主进程状态来源

状态优先级固定为：

```text
blocked > running > completed > idle
```

- `blocked`：权限、AskUser 或 ExitPlan 任一服务存在该会话的待处理请求。
- `running`：Agent Orchestrator 仍持有该会话的 in-flight generation。
- `completed`：主进程 Agent 状态投影仍将该会话标记为完成未查看；错误终态也使用该状态提醒用户检查结果。
- `idle`：以上条件均不成立。

LAN Adapter 只依赖一个可注入的 `getAgentSessionRuntimeStatus(sessionId)` 查询，不直接理解权限或 Agent Island 的内部数据结构。组合根负责把现有主进程状态服务绑定到 Adapter，便于单元测试并隔离上游变化。

## 协议与数据流

### 列表快照

`agent.sessions` 返回每个会话的 `starred` 和 `runtimeStatus`。手机首次连接、手动刷新和 WebSocket 重连均以该列表作为权威快照。

手机读取某个 `completed` 会话的消息时，handler 同步把该会话标记为已查看，并向已认证客户端广播 `idle`。运行中会话的历史读取不改变状态。

### 实时状态

LAN Bridge 监听已有 Agent EventBus，将运行开始、交互阻塞、交互恢复、完成、错误和停止统一投影为：

```ts
{
  type: 'agent.session.runtime_updated',
  data: { sessionId, runtimeStatus }
}
```

该事件广播给所有已认证客户端，不要求客户端先订阅某个会话。正文与思考增量仍只发送给该会话订阅者，避免扩大流量与隐私暴露面。

### 星标切换

新增受认证命令 `agent.sessions.toggle_star`，仅接收 `sessionId`。主进程验证会话存在后，通过现有原子会话元数据更新路径切换 `starred`，返回更新后的会话摘要，并广播现有会话列表失效事件。手机端以响应结果立即更新本地 Jotai 状态；广播用于同步其他已连接设备。

## 移动端状态管理

`ConvItem` 增加 `starred` 与 `runtimeStatus`。新增纯函数完成两类更新：

- 按 `sessionId` 合并运行状态事件，找不到会话时忽略，等待下一次权威列表刷新。
- 按 `sessionId` 合并星标响应，不改动其他会话对象。
- 当前会话读取完成后若服务端确认已查看，将本地 `completed` 更新为 `idle`。

当前打开会话的发送栏不再只依赖全局临时 `streamingAtom`。切换到已运行会话或重连恢复时，由该会话的 `runtimeStatus` 恢复停止按钮；收到完成、错误或停止状态后清除流式展示。

## 错误与兼容

- 未识别的 `runtimeStatus` 按 `idle` 处理。
- 星标请求失败时保留服务端旧值，不做乐观反转，避免网络失败造成假状态。
- 旧服务端没有新字段和事件时，手机仍可正常显示会话，只是不展示实时状态和星标。
- 事件早于列表到达时不创建残缺会话；下次列表快照会恢复完整数据。
- 标记已查看失败不阻止消息读取；客户端保留原状态，等待下一次事件或快照纠正。
- 归档、置顶、手动工作中与星标语义保持独立。

## 关联影响

改动覆盖 LAN 四层契约：共享 DTO、主进程 Adapter/handler、WebSocket 事件、移动端状态与 UI。桌面 Renderer 不修改现有状态计算和星标行为。

普通 Chat 会话暂不纳入四态状态，因为其运行生命周期由独立 `activeControllers` 管理，且没有 blocked/completed 语义。强行合并会制造不真实的统一模型；本次仅保证 Agent 会话一致。

## 性能与资源

- 列表加载时每个 Agent 会话执行常数时间的内存状态查询。
- 实时更新只在状态变化时广播一条小型 WebSocket 消息，不发送 token 级状态消息。
- 手机端只替换目标会话对象，Jotai 派生列表不会因正文流式增量持续重排。
- 不新增依赖，不增加磁盘写入；仅星标切换沿用现有会话元数据原子写。

## 测试

采用 BDD 风格测试覆盖：

- Adapter 列表映射包含星标和四态状态。
- 状态优先级、开始、阻塞、恢复、完成、停止与重连快照。
- 未订阅会话的客户端仍收到全局状态变化，正文增量仍保持订阅隔离。
- 星标命令的认证、会话校验、持久化结果与广播。
- 完成会话读取后清除未查看状态，运行中会话读取不误清状态。
- 移动端状态合并函数处理正常事件、未知会话和未知状态。
- 会话行展示色块、星标、时间，星标点击不会打开会话。
- 抽屉和下拉列表使用一致组件，运行状态变化不改变结构。
