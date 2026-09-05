# Server Ops 可观测性、systemd 与实时日志设计

日期：2026-09-05

状态：用户已确认

## 结论

Proma Server Ops 的下一阶段只完成三个真实能力：服务器概览、systemd 服务管理和实时日志。三者组成“发现异常 -> 定位服务 -> 查看日志 -> 经用户确认执行服务操作”的最小完整排障闭环。

本阶段不实现文件管理、Docker、PostgreSQL、MySQL 或 Redis。先建立稳定的结构化采集、受控远程操作和流式日志协议，后续模块再复用这些边界，避免每个页签只交付浅层占位。

## 用户目标

用户连接 Linux SSH 服务器后应当能够：

1. 在概览页看到真实的系统、资源、磁盘、网络和高占用进程数据；
2. 在服务页搜索、筛选和检查 systemd 服务；
3. 在明确确认后启动、停止、重启服务或修改开机自启动状态；
4. 在日志页读取系统或指定服务的历史日志，并按需进入实时跟随；
5. 切换服务器、断开连接或关闭相关页面后，不再收到旧连接的数据；
6. 继续在左侧普通 Agent 对话中使用已有 Server Ops 工具协助诊断，但页面日志不会自动进入模型上下文。

## 非目标

- 不新增独立运维 Agent、第三种工作模式或新的左侧导航层级；
- 不允许 Renderer 向主进程提交任意 Shell 命令；
- 不自动执行 `sudo`、自动重试服务变更或自动恢复日志流；
- 不把概览历史持久化为监控数据库，不做跨服务器监控大盘；
- 不在本阶段新增结构化 Agent 概览、服务或日志工具；已有 `server_exec` 足以支持用户主动要求的 Agent 诊断；
- 不引入新的运行时依赖。

## 现有能力与复用边界

现有 Server Ops 已提供：

- 应用级服务器资产和安全凭据；
- Host Key 确认；
- 独立 Electron utility process 内的 SSH 连接与 PTY；
- 有界 `ssh2.Client.exec()` 非交互命令执行；
- 精确 `sessionId + hostId` Agent 临时授权；
- Agent connect、exec、disconnect 审计。

新功能必须复用进程级 `ServerOpsConnectionService`、当前 SSH connection generation 和 utility process，不创建第二套 SSH 连接、凭据缓存或 Host Key 状态。

## 总体架构

```text
ServerOpsWorkspace
  -> typed preload API
  -> authorized main-window IPC
  -> ServerOpsOverviewService
  -> ServerOpsSystemdService
  -> ServerOpsLogService
  -> shared ServerOpsConnectionService
  -> ServerOpsRuntimeClient
  -> Electron utility process
  -> ssh2 exec / log stream channel
```

三个服务只负责各自领域：

- `ServerOpsOverviewService`：执行固定只读采集脚本、解析快照、管理单飞刷新；
- `ServerOpsSystemdService`：发现 systemd、读取服务、执行严格枚举的服务动作；
- `ServerOpsLogService`：创建和释放日志流、执行过滤映射、管理流身份；
- `ServerOpsConnectionService`：继续作为主机、连接和 generation 的唯一事实来源；
- utility process：只处理已由主进程构造的有界 exec 或日志流请求。

服务可以共享小型内部辅助模块，例如 Linux 字节数解析、受控 Shell 参数引用和 connection generation 校验，但不得合并为接受任意命令的通用 Renderer API。

## 服务器概览

### 展示字段

概览快照包含：

- 系统：主机名、发行版名称与版本、内核、架构、运行时间；
- CPU：逻辑核心数、使用率、1/5/15 分钟负载；
- 内存：总量、已用、可用、缓存；
- Swap：总量与已用量；
- 文件系统：挂载点、文件系统类型、总量、已用、可用、使用率；
- 网络：采样窗口内的接收和发送速率；
- 进程：按 CPU 和内存分别排序后的前 5 项，最多合并为 10 条；
- 元数据：采集时间、采样窗口和结构化 warning。

所有数字在主进程解析为有界 number。主机名、系统名称、挂载点和进程名称均限制长度；超出数量上限的数据截断并附 warning。

### 采集方式

概览使用仓库内版本化的固定只读 Shell 脚本，设置 `LC_ALL=C` 后读取 `/proc`、`df -P`、`uname` 和受控 `ps` 输出。脚本不得包含用户输入。

CPU 和网络速率在一次采集内读取两组计数，中间使用 250ms 采样窗口。这样首次打开即可展示速率，不需要等待下一个 10 秒刷新周期。只采集当前选中且已连接的服务器。

远程输出使用带字段前缀的行协议。主进程逐行解析、限制总输出大小，并把未知、重复、越界或格式错误字段转换为 warning。单项不可用时保留其它有效数据，不能因为一个挂载点或一条进程记录异常而清空整页。

### 刷新生命周期

- 进入概览页立即刷新；
- 概览页可见且 SSH 已连接时，每 10 秒刷新一次；
- 同一 `hostId + connection generation` 最多一个采集在途；
- 手动刷新在已有请求运行时合并为下一次刷新，不并发启动；
- 切换页签、切换服务器、断线、关闭右栏或组件卸载时停止定时器并失效旧请求；
- 迟到结果必须同时匹配当前 host、generation 和 Renderer 请求代次后才能发布。

概览不落盘，不建立历史曲线。页面可保留当前连接最近一次成功快照；刷新失败时标记为“数据已过期”并显示最后成功时间，不把旧数据伪装成实时数据。

## systemd 服务

### 能力发现

服务页先检查远端 PID 1 和 `systemctl` 可用性。不是 systemd、命令不存在或权限不足时返回结构化 capability 状态。Proma 不通过进程名猜测或 SysV 脚本模拟 systemd。

### 列表与详情

服务列表最多返回 1000 项，包含：

- unit 名称和描述；
- load、active、sub 状态；
- 是否启用开机自启动；
- 主进程 PID；
- ActiveEnterTimestamp；
- 结构化 warning。

列表支持本地搜索，以及“运行中、失败、已停止、全部”筛选。选择服务后按需调用 `systemctl show` 读取固定属性，并读取最近 100 行 journal 摘要。列表首屏不为每个服务逐个发起远程请求。

### 服务动作

允许的动作固定为：

- `start`
- `stop`
- `restart`
- `enable`
- `disable`

Renderer 只能发送 `hostId`、严格 systemd unit ID 和动作枚举。unit ID 最长 256 字节，必须以 `.service` 结尾；普通字符只允许 ASCII 字母、数字、冒号、下划线、点、`@` 和连字符，反斜杠只允许出现在 systemd 标准 `\\xHH` 十六进制转义中。共享 parser 拒绝空白、控制字符、Shell 元字符、路径和其它转义；主进程再使用单引号参数编码并把动作映射到固定 `systemctl` 参数，不接受自定义 flags。

每次动作前使用 AlertDialog 展示服务器、服务和动作。确认只对本次操作有效，不提供永久允许。动作执行中禁用重复提交；成功或失败后重新读取该服务真实状态，不进行乐观更新。

Proma 不自动添加 `sudo`，也不提供密码交互。权限不足按稳定错误展示，用户可改用具备权限的 SSH 账户或在终端自行处理。

服务变更不会自动重试。连接在执行期间失效时，结果标记为未知并要求重新读取状态，不能假设动作未发生。

## 实时日志

### 日志来源与筛选

日志来源支持：

- 当前系统 journal；
- 一个已验证的 `.service` unit。

远程过滤只接受结构化选项：

- 时间范围：最近 15 分钟、1 小时、6 小时、24 小时、本次启动；
- 最低日志级别：emerg、alert、crit、err、warning、notice、info、debug；
- 初始行数：默认 200，最大 2000；
- 是否实时跟随。

关键字搜索只在已接收的 Renderer 缓冲区内执行，不拼入远程 Shell。日志格式固定使用 journal 的可解析时间格式；不支持 journal 时显示明确能力错误。

### utility 流协议

历史日志可继续使用有界 exec。实时跟随增加独立协议：

```text
server-ops.log-start
  -> server-ops.log-chunk
  -> server-ops.log-ack
  -> server-ops.log-chunk
server-ops.log-stop / server-ops.log-exit
```

每个流具有唯一 `streamId + hostId + connectionId`。主进程和 utility 都使用 exact-key parser；任何身份不匹配、未知字段或迟到消息都被拒绝。

utility 以最多 50ms 或 32 KiB 为一个批次，发送后等待 ACK。未收到 ACK 时最多保留一个有界待发送批次，不无限缓存远程输出。UTF-8 解码使用增量 decoder，跨 chunk 字符不能被破坏。

Renderer 最多保留 5000 行或 2 MiB，以先到上限者为准；超过后从最旧内容开始释放，并显示已截断状态。暂停只暂停页面跟随和渲染，不允许在后台无限积压；暂停期间仍按同一有界缓冲规则接收和淘汰。

同一窗口只允许一个活动日志流。切换来源或筛选时先停止旧流，再启动新流。切换页签、服务器、连接 generation、关闭右栏、窗口销毁、SSH 断线或 utility 退出都必须停止并清理流。

日志断线后不自动重连。用户重新连接 SSH 后显式点击继续，避免在用户未知的连接或服务状态下恢复读取。

### 日志操作

日志页提供：

- 开始或停止实时跟随；
- 暂停或继续页面跟随；
- 清空当前本地视图；
- 下载当前有界缓冲区为 UTF-8 文本；
- 复制选中日志。

本阶段不提供“发送给 Agent”按钮。日志可能包含 Token、Cookie、个人信息或业务数据，打开日志页不构成把内容发送给模型的授权。用户仍可在已授权 Agent 会话中明确要求 Agent 通过 `server_exec` 读取指定日志。

## Renderer 设计

继续使用现有 Agent 右侧“运维”工作区和页签，不新增卡片式页面外壳。

### 概览页布局

- 顶部为 CPU、内存、根磁盘和负载的紧凑指标条；
- 中部为系统信息和文件系统表格；
- 底部为高占用进程表格；
- 顶栏显示最后更新时间、过期状态和刷新图标；
- 窄宽度下降为两列指标，表格横向滚动，不缩放字体。

### 服务页布局

- 顶部为搜索、状态筛选和刷新；
- 主体为紧凑服务表格；
- 选择服务后在同一页面下方或窄屏堆叠详情，不打开嵌套卡片；
- 服务动作使用图标或图标加明确命令文本，并提供 Tooltip；
- 运行、失败、停止状态使用主题语义色，不让整页由单一颜色主导。

### 日志页布局

- 顶部使用下拉菜单选择来源、时间和级别；
- 跟随、暂停、清空、下载使用稳定尺寸图标按钮；
- 主体是可选择文本的等宽日志视图；
- 新日志到达时只在用户位于底部且未暂停时自动滚动；
- 用户向上滚动后保留位置并显示“有新日志”返回底部入口。

三个页面都必须提供独立 loading、空、unsupported、partial、stale 和 error 状态。不得使用伪造指标或静态示例冒充服务器数据。

## IPC 合同

新增四层类型安全合同：

1. 获取概览快照；
2. 获取服务列表与单个服务详情；
3. 执行枚举化服务动作；
4. 开始、停止和订阅日志流。

每个请求都包含公开 `hostId`，但不包含凭据、connectionId、generation 或 Shell 命令。主进程从权威 Connection Service 解析内部连接身份。

Shared、main IPC、preload 和 Renderer 必须同步实现。输入与返回 DTO 都使用 exact-key parser，Preload 对主进程返回值再次执行严格解析，防止内部字段意外进入 Renderer。

仅 Electron 主窗口 sender allowlist 内的 Renderer 可以调用这些 IPC。Renderer 请求不会继承 Agent 临时授权；这是用户直接操作当前 Server Ops 页面，与 Agent 工具授权是两个独立边界。

## 审计升级

现有 Agent 审计 Store 从 schema v1 升级为 schema v2，并提供唯一已知的 v1 -> v2 原子迁移。损坏文件和未知版本继续 fail closed，不自动覆盖现场。

v2 为记录增加 `actor`：

- `agent`：现有 Agent connect、exec、disconnect；
- `user`：用户从 Server Ops UI 发起的服务变更。

新增结构化操作：service start、stop、restart、enable、disable。UI 服务记录包含公开 sessionId、hostId、unit ID、动作、开始时间、耗时、结果和稳定错误码；不记录生成的 Shell 命令、stdout、stderr、凭据或连接内部标识。

概览读取、服务读取和日志读取不写操作审计，避免高频噪声。服务变更的 start 审计写入失败时不执行远程动作；远程动作完成但 result 审计失败时保留真实结果并附公开 warning。

审计页增加 actor 和服务动作筛选，同时兼容迁移后的历史 Agent 记录。上限继续保持最近 5000 条。

## 错误处理

公开错误使用稳定 code 和中文恢复动作，至少区分：

- SSH 未连接或连接已变化；
- 当前 Linux 不支持 systemd 或 journal；
- 远程权限不足；
- 采集输出损坏或字段不受支持；
- 请求或输出超过资源限制；
- 服务动作结果未知；
- 日志流已停止、超时或背压失败；
- 审计不可用。

原始远程错误、内部 command、connectionId、堆栈和 stderr 中可能含有的秘密只进入脱敏后的主进程日志，不直接展示给 Renderer。可安全展示的 systemctl 状态和 journal 内容属于用户主动读取的数据，不写入应用日志或审计文件。

## 安全边界

- 凭据仍只由主进程解析，不进入新 DTO；
- Renderer 不能提交 Shell 命令或 systemctl flags；
- 固定概览脚本不包含用户输入；
- systemd unit、动作、日志来源、时间和级别都在 Shared 与 main 双重校验；
- 日志关键字只在本地过滤；
- 服务变更逐次确认、逐次审计、禁止自动重放；
- 连接身份以当前 `hostId + connection generation` 为准；
- 日志和命令输出有字节、行数和时间上限；
- 页面日志不会自动进入模型上下文。

## 性能与资源开销

- 概览仅在概览页可见时每 10 秒执行一次约 250ms 的只读采集；
- 同一当前服务器最多一个概览请求、一个服务详情请求和一个日志流；
- 服务列表只在进入页面和手动刷新时读取，详情按选择加载；
- 日志批次受 32 KiB、ACK 和 Renderer 2 MiB/5000 行三重限制；
- 切页、切服务器、断线、关闭右栏或窗口时释放定时器、pending 和流；
- 快照与日志只保存在有界内存，不写数据库或长期历史文件；
- 不新增常驻服务器进程或后台跨主机轮询。

## 关联模块影响

- Shared：新增严格 DTO、错误码、IPC 常量和审计 v2 合同；
- main：增加三个领域服务，扩展 Server Ops service context、IPC 和审计迁移；
- preload：增加严格解析后的调用与日志事件桥接；
- utility：增加日志流协议、ACK 背压和清理；
- Renderer：把三个占位页替换为真实状态控制器和视图；
- Agent：现有五个工具和权限分类保持不变；
- Canvas、Design、Automation、Delegation、LAN 和移动端不获得新远程能力。

修改 IPC 和 utility 协议时必须继续检查应用退出、窗口销毁、主机删除、会话删除、服务器切换、SSH 重连和 utility 崩溃路径，避免资源与授权残留。

## 测试策略

所有功能按 BDD 风格先写失败测试，再实现。

### Shared 与解析器

- 合法概览、服务、动作、日志请求和返回 DTO；
- 未知字段、越界数值、非法 unit、非法枚举和控制字符；
- Ubuntu、Debian、CentOS 风格概览 fixture；
- `/proc` 字段缺失、挂载点异常、重复字段和部分输出损坏。

### 主进程服务

- 概览单飞、10 秒生命周期、手动刷新合并和 partial warning；
- systemd 不支持、权限不足、服务上限和详情按需加载；
- unit 注入、未知动作、动作失败、动作结果未知和状态回读；
- 主机切换、连接 generation 变化和迟到结果拒绝；
- 服务变更 start/result 审计及 v1 -> v2 迁移。

### utility 与日志流

- exact-key 双向协议；
- UTF-8 跨 chunk 解码；
- 50ms/32 KiB 合批和 ACK 背压；
- 连接退出、runtime 退出、显式停止和超时清理；
- stale stream 身份不能通知当前订阅者；
- 回环 SSH fixture 覆盖历史日志和实时日志。

### Renderer

- 三页 loading、empty、unsupported、partial、stale 和 error 状态；
- 概览刷新与旧请求竞态；
- 服务搜索、筛选、确认、操作中禁用和权威回读；
- 日志跟随、暂停、新日志提示、淘汰和切页停止；
- 无服务器、未连接、切换服务器和断线状态；
- 深浅主题、键盘焦点、1000px 常规宽度与 620px 窄面板无重叠。

### 完整验证

- Server Ops、Agent 权限和会话生命周期相关测试；
- `bun run typecheck`；
- `bun run electron:build`；
- utility 构建产物协议标识检查；
- 凭据、connectionId、generation 和远程输出泄漏扫描；
- Proma Dev 使用本地 SSH fixture 的视觉与交互冒烟，不操作真实服务器。

## 实施顺序

1. Shared 合同、解析器与审计 v2 迁移；
2. 概览采集脚本、解析器和 `ServerOpsOverviewService`；
3. systemd 能力发现、列表、详情和受控操作；
4. utility 日志流协议、Runtime Client 和 `ServerOpsLogService`；
5. IPC、Preload 与 Renderer 三个真实页面；
6. 完整安全、竞态、资源、构建与视觉验证。

每一步只在相关失败测试转绿后进入下一步。若日志流协议暴露底层连接生命周期缺陷，先修复共享连接边界，不在 Renderer 增加补丁式重试。

## 验收标准

- 已连接服务器的概览页展示真实数据，任何单项失败不会清空整页；
- 概览只在可见时刷新，切页和断线后不再采集；
- systemd 服务可搜索、筛选、查看详情，并在逐次确认后执行五种固定动作；
- 任何 Renderer 输入都不能形成任意 Shell 命令；
- 实时日志具有 ACK 背压、UTF-8 完整性和明确内存上限；
- 切换服务器、连接或页面后不会出现旧数据或残留日志流；
- 服务变更进入审计，读取操作不制造高频审计噪声；
- 日志不会自动进入 Agent 模型上下文；
- 相关测试、类型检查和 Electron 构建全部通过，视觉冒烟无重叠和假数据。
