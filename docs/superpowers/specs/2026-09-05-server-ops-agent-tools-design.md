# Server Ops Agent 工具设计

日期：2026-09-05

## 结论

Proma 为普通、用户可见的 Agent 会话提供五个服务器运维工具：`server_list`、`server_status`、`server_connect`、`server_exec` 和 `server_disconnect`。工具只接受服务器公开 ID 和有界命令参数，凭据始终由主进程内部解析，不进入模型上下文、Renderer、工具参数、工具结果、日志或审计明文。

服务器访问采用显式的会话级临时授权。用户在 Server Ops 右侧工作区顶部为“当前 Agent 会话 + 当前服务器”开启授权；授权默认关闭，仅保存在主进程内存，切换服务器、断开连接、撤销授权、删除服务器或应用重启后失效。工具仍经过 Proma 现有 Agent 权限服务，临时服务器授权不替代命令级审批。

## 用户流程

1. 用户在普通 Agent 会话右侧打开 Server Ops，选择服务器。
2. 用户点击顶部工具栏的“允许 Agent 使用当前服务器”图标开关。
3. 主进程确认该会话为用户可见普通 Agent 会话、服务器仍存在，然后只在内存中记录唯一的 `sessionId + hostId` 授权组合。
4. Agent 可调用 `server_list` 查看当前唯一已授权目标的公开摘要，调用 `server_status` 查看本地连接状态，调用 `server_connect` 使用已保存凭据连接。
5. Agent 调用 `server_exec` 时，主进程再次校验会话授权和服务器身份，然后通过 SSH 独立 exec channel 执行命令。
6. 只读探测命令可按现有权限策略自动放行；写入、删除、重启、`sudo`、数据库写操作逐次请求用户批准，且不提供“始终允许”。
7. 用户关闭授权或断开服务器后，Agent 后续调用返回稳定的授权错误；Agent 不能自行重新授权。

## 架构

```text
Pi Agent Tool
  -> ServerOpsAgentFacade
  -> ServerOpsAgentAccessStore(sessionId + hostId)
  -> ServerOpsConnectionService
  -> ServerOpsCredentialStore / HostTrustStore
  -> ServerOpsRuntimeClient
  -> Electron utility process
  -> ssh2 Client.exec()
```

IPC 和 Agent 共用同一组进程级 Server Ops Store、Connection Service 与 utility runtime。主进程通过独立 service context 组装依赖，避免 IPC 与 Agent 各自创建连接状态和凭据缓存。

## Agent 工具合同

### `server_list()`

返回当前 Agent 会话唯一已授权服务器的公开摘要。公开字段仅包括 `id`、`name`、`address`、`port`、`username`、`authMethod`、`tags` 和连接 phase；不返回其它未授权服务器，也不返回 `credentialRef`。无授权时返回 `SERVER_OPS_AGENT_ACCESS_REQUIRED`，工具描述明确引导用户先在 Server Ops UI 选择并授权目标。

### `server_status({ hostId })`

返回指定服务器的本地连接 phase、公开消息和 Host Key 状态。调用前必须校验当前会话已授权该 `hostId`。

### `server_connect({ hostId })`

使用主进程保存的凭据建立连接。未知 Host Key 返回稳定的“需要用户确认”结果，由 Server Ops UI 继续完成现有指纹确认流程；Agent 不得确认或绕过 Host Key。

### `server_exec({ hostId, command, timeoutMs })`

只在已连接状态执行单条非交互命令。结果包含 `stdout`、`stderr`、`exitCode`、`signal` 和 `truncated`。命令最大 8192 字符，超时范围 1000 至 120000 毫秒，默认 30000 毫秒；stdout 与 stderr 合计最多 1 MiB，达到上限后终止 channel 并标记截断。

### `server_disconnect({ hostId })`

断开当前连接并立即撤销当前活动授权。授权 Store 只有一个活动槽，不保留其它会话的并行授权。

## 授权模型

- 权威授权 Store 位于主进程，全局只保存一个当前 `sessionId + hostId` 授权组合；授予新组合会原子替换旧组合。
- Renderer 通过 `get/set` IPC 读取或切换当前组合；Renderer atom 仅是 UI 投影。
- 授权写入前校验 IPC sender、普通用户可见会话和现存服务器。
- 每次 Agent 工具调用都从工具上下文取得真实 `sessionId`，模型不能传入 sessionId。
- `server_list` 只返回公开主机字段，但仍仅在当前会话至少授权一台服务器时可用；列表中未授权主机不暴露地址和用户名。
- 自动任务、Canvas/Design 内部会话、delegation 子会话和外部 Bridge 不注入 Server Ops facade；facade 执行时再次校验来源与用户可见会话，防止未来误注入扩大权限。交互式桌面运行允许 `triggeredBy` 为 `user` 或未设置，后台入口必须显式归一化为 `automation`、`delegation` 或 `external`。

## 命令审批

服务器临时授权解决“Agent 能否触达这台服务器”，权限服务解决“本条命令是否允许执行”，两个边界必须同时通过。

- `server_list`、`server_status`：只读，可自动放行。
- `server_connect`、`server_disconnect`：连接生命周期操作，可自动放行，但仍需服务器临时授权。
- `server_exec`：复用现有权限弹窗并按远程命令分类。
- 明确只读的系统探测命令，例如 `uname`、`uptime`、`df`、`free`、`ps`、`ss`、`systemctl status/show/is-active`、`journalctl`、`docker ps/inspect/logs/stats` 可自动放行。
- 包含 shell 重定向、命令替换、管道后的未知命令、`sudo`、文件变更、进程终止、服务/Docker 重启、包管理器、数据库或 Redis 写入的命令必须逐次审批。
- `server_exec` 不允许保存“始终允许”规则，防止同名工具绕过未来命令内容变化。权限请求显式设置 `allowAlways: false`，白名单写入处再次拒绝该工具，形成双重防守。

## SSH exec 与资源边界

- 使用 `ssh2.Client.exec()` 创建独立 channel，不向交互 PTY 注入文本。
- exec 请求通过现有 utility process MessagePort，使用唯一 `requestId` 对应结果。
- timeout 同时存在于主进程 client 和 utility runtime；任一侧超时都会关闭 channel 并清理 pending request。
- result、timeout、连接退出和 runtime 退出以 `requestId` 单次 settled 状态收敛，迟到事件不得重复完成或泄漏 pending 请求。
- stdout/stderr 分开收集，合计达到 1 MiB 后停止读取并关闭 channel。
- 连接断开或 utility process 退出时，所有 pending exec 以稳定错误结束。
- 不新增轮询；授权查询为 O(1)，exec 仅在调用期间占用一个 SSH channel 和有界缓冲区。

## UI

开关位于 `ServerOpsWorkspace` 顶部工具栏、连接状态附近，复用现有按钮、Tooltip 和主题变量。默认显示 Shield 图标；开启时使用现有强调色和 `aria-pressed="true"`，悬停文本明确为“允许当前 Agent 使用此服务器”。

- 没有当前 Agent 会话、没有选中服务器或请求进行中时禁用；未连接状态仍可授权，使 Agent 能调用 `server_connect` 完成首次登录。
- 切换 Agent 会话或服务器后立即读取对应主进程授权状态，不继承前一组合。
- 点击关闭立即撤销；断开连接成功后 UI 同步显示关闭。
- IPC 失败通过现有 Toast 展示稳定中文错误，按钮恢复前一权威状态。
- 控件支持键盘焦点、Enter/Space 触发、Tooltip 和深浅主题。

## 审计

首版记录 Agent 发起的 `connect`、`exec` 和 `disconnect`，包含时间、sessionId、hostId、操作、脱敏命令摘要、执行结果、退出码、耗时和稳定错误码。审批结果继续由现有权限服务负责，不在 facade 中重复推断。审计不记录凭据、完整私钥路径、环境变量值或完整 stdout/stderr；命令先对 `password`、`token`、`secret`、`Authorization`、URI 用户信息和 heredoc/重定向内容做模式脱敏，再按 512 字符上限保存并标记截断。

审计采用有界版本化 JSON 文件，使用 `safe-file` 原子写与备份恢复能力；默认保留最近 5000 条。Server Ops 的“审计”页读取公开审计 DTO，并支持按服务器和操作筛选。执行前的开始记录写入失败时 fail closed，不发起远程操作；执行后的结果记录写入失败时，工具必须保留真实远程结果并附带 `SERVER_OPS_AUDIT_RESULT_WRITE_FAILED` 警告，明确操作已经发生，不能把它伪装成远程失败。坏文件或未知版本会阻断 Agent 远程操作，但审计页以稳定错误隔离，不击穿其它 Server Ops 页面。

## 关联影响

- Canvas、数据库/Redis业务适配器、现有凭据格式、LLM 渠道和本地 Terminal 不变。
- Server Ops IPC 创建方式会提取为共享 service context，但现有 Renderer API 和连接行为保持兼容。
- 共享 context 必须在首次 Agent query 前由 IPC 初始化；Agent 侧只能读取该实例，缺失时不注入工具，禁止惰性创建第二套 Store 或 Connection Service。
- Agent 工具仅注入普通用户可见会话，Automation、内部会话与 Collaboration 不获得服务器权限。
- 命令执行增加一次权限分类和一次内存授权查询；无授权时不会启动 utility process。

## 验收条件

- 未授权 Agent 无法列出敏感服务器字段、连接、执行或断开服务器。
- 用户授权当前会话与服务器后，五个工具可按合同调用；切换、撤销、断开或重启后授权失效。
- Agent 工具参数和结果均不包含密码、私钥、口令或 `credentialRef`。
- `server_exec` 使用独立 SSH exec channel，正确返回 stdout、stderr、退出码、超时和截断状态。
- 高风险命令逐次审批且不能永久允许，只读探测保持低摩擦。
- Agent 工具不暴露 Host Key 确认能力；首次指纹只能由用户在 Server Ops UI 确认。
- 主进程 IPC 与 Agent 复用同一 Connection Service，不产生双重连接状态。
- UI 开关在深浅主题、键盘操作、加载态和错误态下可用。
- 正常路径、无授权、失效授权、危险命令、超时、输出上限、审计展示和凭据脱敏均有 BDD 风格测试。
