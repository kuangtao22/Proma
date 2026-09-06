# Server Ops 剩余能力实施计划

> **For agentic workers:** 后续实施使用 `executing-plans` 按任务推进；独立子任务可采用 `subagent-driven-development`，但 shared/runtime/IPC 等共享文件由单一集成负责人维护。复选框只在取得对应证据后勾选。本轮只规划，不执行下面的代码任务。

**Goal:** 补齐 SSH 指纹恢复、文件管理、Docker 和 PostgreSQL/MySQL/Redis 数据服务，使每个阶段形成可观察、可批准、可取消、可验证的运维流程。

**Architecture:** 复用现有右侧 Server Ops 工作台、主进程领域服务与独立 SSH utility process。领域数据和运行身份独立于 Agent/Canvas 会话存储；新能力同时检查 UI、Agent、权限、审计、数据根及运行时释放边界。

**Tech Stack:** Bun 1.3.14、TypeScript、Electron 43、React/Jotai、现有 Radix/shadcn、ssh2 1.17.0、safe-file；数据库驱动在 P3 的依赖验收后确定，不在规划阶段安装。

---

## 1. 执行状态与输入

- [x] 读取项目约束、记忆及现有 Server Ops 实现/规格。
- [x] 核实三个占位模块和指纹恢复缺口，区分历史阶段非目标。
- [x] 从 `feed23c4dd6512cae0680dddd60d2f1276f38df2` 创建 `codex/server-ops-completion`。
- [x] 建立独立目录 `.worktrees/server-ops-completion`，不搬运主工作区未提交改动。
- [x] 编写总体设计与本实施计划初稿。
- [x] 完成计划交叉审查与修正；规划文档纳入本分支本次提交。
- [ ] P0 指纹恢复与共享配置一致性。
- [ ] P1 远程文件工作流。
- [ ] P2 Docker 工作流。
- [ ] P3a-c 三类数据服务诊断。
- [ ] P3d 查询与受控变更。
- [ ] 各阶段实机、压力与安装包验收。

设计依据：`docs/superpowers/specs/2026-09-07-server-ops-completion-design.md`。本计划锁定任务范围、文件责任与验收条件；新增领域服务的方法签名由各阶段合同任务先定义并评审，随后才进入实现，不能边接 UI 边临时扩大协议。

上次核查的 389 项测试结果属于 2026-09-06 主工作区，核心运维源码与本分支起点一致。本轮仅验证文档和 Git 状态，不重复运行未变化的代码或把历史测试冒充新分支完整基线。

## 2. 分阶段交付与依赖

| 阶段 | 最小可验收结果 | 依赖 | 完成证据 |
| --- | --- | --- | --- |
| P0 | 服务器换密钥后，可显式替换/撤销信任并重新连接 | 配置互斥、审计升级、连接撤权 | 双进程竞争 + 两个 Host Key 的 SSH fixture + 完整 UI |
| P1 | 浏览、传输和编辑文件，冲突/取消有结果 | P0 一致性与审计；SFTP 运行时 | 内容 hash、no-clobber、取消恢复及真实 SFTP |
| P2 | 查看容器并完成“日志 -> 操作 -> inspect 验证” | P0；复用已有日志背压 | 固定 Docker fixture、旧容器 ID 拒绝、权限和资源释放 |
| P3a-c | 分别完成 PostgreSQL/MySQL/Redis 只读诊断 | P0、隧道/驱动验收 | 真实引擎、认证/TLS、权限不足、容量限制 |
| P3d | 有界查询、取消与经批准的精确数据变更 | 对应引擎已通过 P3a-c | 只读边界、DDL/DML 语义、未知结果且无自动重放 |

推荐串行完成各阶段；P0 后 P1 与 P2 的领域 parser/测试可独立开发，但新 runtime 协议、审计 schema 和 root registrar 由同一负责人集成。P3 的三个引擎可独立交付，避免某个驱动兼容性阻塞其它引擎。

## 3. 现有文件与新增文件责任

以下路径均相对本 worktree 根。标注“新增”的文件尚不存在，是规划的实现位置。

| 文件/目录 | 责任 |
| --- | --- |
| `packages/shared/src/types/server-ops.ts` 及 `.test.ts` | 保留已有公开 API，增加并导出严格的领域 DTO、通道、事件与 parser |
| `packages/shared/src/types/server-ops-trust.ts`（新增） | 信任候选、替换/撤销、受影响 endpoint 与公开结果 |
| `packages/shared/src/types/server-ops-files.ts`（新增） | 文件 entry、edit token、transfer、冲突与操作合同 |
| `packages/shared/src/types/server-ops-docker.ts`（新增） | Docker 能力、资源、日志/console、动作合同 |
| `packages/shared/src/types/server-ops-data.ts`（新增） | 数据源、查询、结果、取消与引擎能力合同 |
| `apps/electron/src/main/lib/server-ops/server-ops-host-trust-store.ts` | fresh-read、endpoint 级信任条件提交，不接受 UI 自报可信密钥 |
| `apps/electron/src/main/lib/server-ops/server-ops-audit-store.ts` | 唯一审计 Store、schema 迁移、operation 关联与未知结果 |
| `apps/electron/src/main/lib/server-ops/server-ops-config-transaction.ts`（新增） | 固定配置文件集合的跨进程互斥、原子写及冲突传播 |
| `apps/electron/src/main/lib/server-ops/server-ops-trust-service.ts`（新增） | 候选/审批/信任/连接/审计编排；避免把新业务塞入 IPC |
| `apps/electron/src/main/lib/server-ops/server-ops-file-service.ts`（新增） | 远程文件语义、版本冲突、操作与恢复状态 |
| `apps/electron/src/main/lib/server-ops/server-ops-file-transfer-service.ts`（新增） | 传输队列、本地 fd lease、ACK、取消和发布 |
| `apps/electron/src/main/lib/server-ops/server-ops-docker-service.ts`（新增） | 固定命令、结构化解析、容器动作与回查 |
| `apps/electron/src/main/lib/server-ops/server-ops-data-source-store.ts`（新增） | 数据源元数据与独立安全凭据引用 |
| `apps/electron/src/main/lib/server-ops/server-ops-data-service.ts`（新增） | 数据访问权限、查询身份、审批与有界结果编排 |
| `apps/electron/src/main/lib/server-ops/server-ops-connection-service.ts` | 新 channel 沿用连接代次；信任变更后全 endpoint 失效 |
| `apps/electron/src/main/lib/server-ops/server-ops-runtime-client.ts` | RPC、运行时退出、取消及 stale result 清理 |
| `apps/electron/src/utility/server-ops/server-ops-runtime-protocol.ts` | 与各阶段一起扩展 exact-key 的双向内部协议 |
| `apps/electron/src/utility/server-ops-runtime.ts` | 分派 SFTP/Docker/data 请求，不承担用户授权决策 |
| `apps/electron/src/utility/server-ops/server-ops-sftp-runtime.ts`（新增） | SFTP channel、流、扩展探测及资源关闭 |
| `apps/electron/src/utility/server-ops/server-ops-data-runtime.ts`（新增） | forwardOut channel 和引擎驱动生命周期 |
| `apps/electron/src/utility/server-ops/data-adapters/`（新增） | 各引擎独立适配与合同测试；文件由通过选型的引擎任务创建 |
| `apps/electron/src/main/lib/server-ops/server-ops-ipc.ts` | main-window 鉴权、严格 parser、窄领域路由 |
| `apps/electron/src/preload/server-ops-*-preload.ts`（按域新增） | 分别组合 trust/files/docker/data API 与事件清理 |
| `apps/electron/src/renderer/components/server-ops/` | 新增 TrustDialog、FilesPanel、Transfers、DockerPanel、DataServicesPanel；既有 Workspace 只组合 |
| `apps/electron/src/main/lib/server-ops/server-ops-agent-facade.ts` | 同一临时授权下转调新领域服务，输出预算与脱敏 |
| `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts` | 注册已真实可用的能力，UI 占位不得成为工具能力声明 |

新增文件各有同目录 BDD 测试；只在第一次实际需要该领域时创建，不提前铺空目录/接口。根 `src/main/ipc.ts`、`src/preload/index.ts`、shared barrel 和 `server-ops-service-context.ts` 在每阶段只做必要组合变更。现有同类文件不因命名统一而迁移或全量拆分。

## 4. P0 任务

### Task 0.1：锁定基线和实现闸门

责任文件：现有 Server Ops 测试、`apps/electron/src/main/lib/safe-file.ts`、`apps/electron/src/main/lib/data-root-instance-lease.ts`、`apps/electron/scripts/build-stable-directory-native.ts`、`apps/electron/native/stable-directory/stable-directory-helper.cc` 与 `apps/electron/src/main/lib/stable-directory-native-host.test.ts`。

- [ ] 比较分支与准备合入的主线，确认只接纳已验证的启动、helper 和打包修复；记录精确 commit，不混用另一 worktree 的 dist。
- [ ] 用 Bun 安装锁定依赖并运行第 8 节基线命令；失败先分类为代码、环境或依赖问题，不修改无关模块以“刷绿”。
- [ ] 读取 helper 现有跨平台文件锁合同，完成两个本地子进程同时读改写的可执行验证；只有能证明互斥、崩溃释放和不误清他人锁时进入 Task 0.2。
- [ ] 验证本地盘与支持的迁移目标路径；不支持可靠文件锁的路径返回能力错误，不宣称 NAS 或非协作旧进程满足一致性。
- [ ] 明确旧版实例的升级边界：现有 registry 不提供应用版本事实，不得凭 PID/名称猜版本。首个信任迁移在其它实例存在时阻断并提示关闭；后续是否允许新版并行，以明确的协作协议能力证明为准。

验收：两个写者不能均基于同一旧快照成功覆盖；进程退出后下一写者能继续；旧实例不被错误识别为支持新协议。此任务只解决 Server Ops 配置的必要边界，不改造全仓 persistence。

### Task 0.2：配置提交与审计合同

文件：新增 `server-ops-config-transaction.ts`；修改 HostStore、CredentialStore、HostTrustStore、AuditStore 及 shared 审计合同；按 Task 0.1 已验证结论给现有 helper 增加窄模式。

- [ ] 先添加双 Store/双进程、原文件损坏、目标被替换、rename 后耐久失败、旧 schema 迁移和审计上限的失败测试。
- [ ] 在固定文件集合的短锁内 fresh-read -> 严格解析 -> 应用本次变化 -> `writeJsonFileAtomicSecure`。嵌套业务操作不重复取锁，按统一锁次序避免死锁；审批/SSH 网络等待放在锁外。
- [ ] 为审计增加 operation 关联、窗口来源和 pending/success/error/unknown 语义；v1/v2 严格迁移，保留既有脱敏及 actor 语义。未知 schema 不覆盖、不自动拿备份掩盖问题。
- [ ] 写完即释放锁；提交可见性未知先对账，结果审计失败仅加 warning。原有 connect/exec/systemd 同步使用新审计提交边界。
- [ ] 运行 shared、各 Store、Facade、systemd 与 IPC 定向测试，结果为零失败后检查 diff，并提交中文说明。

关键 BDD：Given A/B 同时追加审计，When 两进程提交，Then 成功记录均存在或其中一方明确冲突；Given start 审计失败，When 请求替换信任，Then trust 文件、连接和远端认证都无新副作用。

### Task 0.3：endpoint 级指纹替换与撤销

文件：新增 `server-ops-trust-service.ts`、`server-ops-trust.ts`；修改 HostTrustStore、ConnectionService、RuntimeClient、AgentAccessStore 和各测试。

- [ ] 添加同 endpoint 两个 Host、未知/变化两类候选、五分钟过期、旧指纹冲突、窗口销毁、在途连接迟到及远程变更 busy 的失败用例。
- [ ] Main 为变化指纹生成专用候选；保留 blocked 状态。候选不等同权限，不复用首次确认接口来隐式覆盖旧 pin。
- [ ] 按设计顺序提交：校验及开始审计、endpoint busy 门禁、撤权和停止旧连接、条件写信任、结果与事件。审批期间不持有配置锁，提交前再次核对受影响范围。
- [ ] 替换和撤销均停在未连接态；新登录重新取得当前 host/credential/trust。旧 candidate、connectionId、Agent 授权和异步结果不得复活。
- [ ] 运行 trust/connection/runtime/access/audit 回归，覆盖变化后的 SSH fixture 不会提前发送密码，最后以中文说明提交。

关键 BDD：Given 已信任 A 而远端换成 B，When 只点击连接或取消替换，Then 零认证且保留 A；When 用户确认有效候选并提交，Then 两个别名 Host 的旧连接均失效，下一次显式连接仅接受 B。

### Task 0.4：四层接口与可用恢复入口

文件：新增 `server-ops-trust-preload.ts`、`ServerOpsTrustDialog.tsx`；修改 shared 导出、server-ops-ipc、preload/index、ServerOpsWorkspace、审计视图和注册上下文。

- [ ] 定义 list/prepare/replace/revoke 的严格输入、结果和事件；新指纹从 Main 候选解析，actor 从 sender 推导，不能由 Renderer 自报。
- [ ] 为未授权窗口、未知字段、伪造候选、错误 owner、跨 endpoint、过期响应和 listener cleanup 添加失败测试，再接入所有四层。
- [ ] 添加“管理服务器信任”入口，展示旧/新指纹、地址与关联配置；确认名、取消、loading、冲突刷新和恢复错误均有明确状态。
- [ ] 完成真实 Electron + 双 Host Key fixture 的替换、撤销、取消、重连流程；检查两主机同 endpoint、窄 Pane、键盘和深浅主题。
- [ ] 运行 P0 完整回归、typecheck、Electron build 与 helper 打包检查；保存验收记录后提交本阶段。

## 5. P1 文件任务

### Task 1.1：文件合同、SFTP 只读浏览与预览

文件：新增 `server-ops-files.ts`、FileService、SftpRuntime、FilesPreload、FilesPanel；修改 runtime 双向协议与 registrar。

- [ ] 先定义 entry/cursor/read/token/error DTO 和固定资源上限；以非法路径、NUL、符号链接、权限不足、非法分页和旧连接为失败测试。
- [ ] 实现 SFTP 能力及扩展探测，使用 opendir/readdir/close 有界读取，不先扫描全目录再分页；每个 cursor 绑定 owner、目录和连接代次。
- [ ] 接入目录导航与 1 MiB UTF-8 预览，二进制/超限明确转下载；显示已读取范围与截断原因。
- [ ] 给普通 Agent 增加相同授权主机下的 list/read 窄接口，校验 64 KiB 工具结果预算；用户未要求时不自动读取或发送文件正文。
- [ ] 运行 shared/parser、SFTP fixture、跨层和 Renderer 测试；真实浏览权限充分/不足/扩展缺失目录后提交。

### Task 1.2：上传下载与有界传输队列

文件：新增 FileTransferService 与 Transfers 视图；修改 Files 合同、runtime、preload 与现有窗口清理。

- [ ] 先写实际二进制 hash、64 KiB 背压、全局两项活动/20 项队列、取消、断线、关闭窗口和 no-clobber 的失败测试。
- [ ] Main 经系统选择器取得 fd lease；向 utility 分块 relay，不传可重开的任意本地路径；下载在 Main 持有临时 fd，完成后校验并 no-clobber 发布。
- [ ] 为远程上传使用独占临时名和最小持久恢复意图；重启不自动上传，通过文件状态和 hash 判断已提交/待清理/未知。
- [ ] 传输进度节流至 10Hz，明确队列/运行/取消中/成功/失败/未知；切主机或关 Pane 提示活动传输，确认后等待资源收口。
- [ ] 以本地 SFTP fixture 验证中文/二进制/最大边界文件、竞态与中断，不写用户真实服务器；通过后提交。

### Task 1.3：经批准的文件变更与文本保存

文件：FileService、AuditStore、FilesPanel、AgentFacade 和相关合同/测试。

- [ ] 锁定新建目录、重命名、单文件/空目录删除、文本保存的意图 DTO；递归删除、chmod/chown、sudo 不进入合同。
- [ ] 编辑 token 固化读取时 hash/元数据；批准前显示目标和差异，批准后重查权限/代次/版本；冲突返回原草稿，不自动覆盖。
- [ ] 只有具备并验证原子 rename 能力时开放替换式保存；元数据/正文变化拒绝，遇不可靠外部并发给出另存路径。不能声称标准 SFTP 保证外部写者间 CAS。
- [ ] 新增精确文件动作审计，排除正文与本地私钥路径；普通 Agent 变更走同一动作服务和逐次审批，不能增加任意 Renderer Shell。
- [ ] 对每个动作验证用户取消无修改、目标变化无修改、远端已提交但超时不会重放；完成实机流程后提交 P1。

## 6. P2 Docker 任务

### Task 2.1：资源探测、列表和详情

文件：新增 `server-ops-docker.ts`、DockerService、DockerPreload、DockerPanel；沿现有 exec 和 AgentFacade 接入。

- [ ] 构建无 Docker、无权限、daemon 关闭、空列表、超限结果、恶意名称/参数和 context 指向外部的失败测试。
- [ ] 使用 Host 构造的固定 CLI 模板，绑定当前主机本地 daemon，不执行用户自定义模板；用 JSON 行/结构化输出解析容器、镜像、网络、卷摘要。
- [ ] 容器一律用完整 ID 做操作身份，名称只展示；详情默认剥离 Env、凭据与敏感启动参数，新增字段严格白名单。
- [ ] 列表/详情只在页签可见时工作，指标最多 10 秒刷新且同身份单飞；给 UI 与普通 Agent 复用相同只读服务。
- [ ] 运行 parser、命令合同、权限、跨层及 UI 测试，验证本地专用 Docker fixture 后提交。

### Task 2.2：容器日志、终端与启停回查

文件：DockerService、runtime 协议/分派、RuntimeClient、DockerPanel、AuditStore、Agent 工具注册。

- [ ] 为旧容器 ID、批准期间重建、日志乱码/背压、console 与主机 PTY 冲突、断线未知结果建立失败测试。
- [ ] 容器日志通过共用流控制器输出，console 使用独立 channel，退出时精确释放，不切断主机终端。
- [ ] start/stop/restart 先批准并 fresh 检查，再审计 dispatch，完成后只读 inspect；保留执行返回与真实状态不一致的 warning。
- [ ] 普通 Agent 复用同一动作合同，取消或超时只做有界状态回查，不自动重新执行；remove/prune/build/push/Compose 不出现在能力声明中。
- [ ] 完成“看容器 -> 看日志 -> 重启 -> 确认状态 -> 查审计”的真实 fixture 流程，记录 socket/channel 回收后提交 P2。

## 7. P3 数据服务任务

### Task 3.1：逐引擎驱动与 SSH stream 验收

文件：新增 `docs/superpowers/specs/2026-09-07-server-ops-data-drivers.md`（实施该任务时生成评估结果）、各引擎 adapter 合同测试；依赖批准后才修改 package、lock、构建和 runtime-deps 文件。

- [ ] 以 chosen-engine 的官方文档和具体版本证明 custom stream、TLS、认证、取消、流式结果及许可/维护状态；每个候选给出 install/build/native 影响，不能仅列包名。
- [ ] 用隔离 fixture 验证 `forwardOut` -> driver -> 查询 -> 取消 -> close；确认无 loopback 监听、无明文文件、无 SSH 密码复用、无目标身份校验降级。
- [ ] 证明客户端达到行数/字节上限时不会继续积累全量结果，取消失败也能关闭自己连接并明确结果未知。
- [ ] 固化通过验证的精确版本和直接依赖；新增依赖须有明确授权，不从 Pi 等包的传递依赖偷用。
- [ ] 只有对应引擎通过测试和独立 utility 构建后才勾选该引擎就绪；失败只阻断该引擎，结论和限制写入评估文档。

### Task 3.2：数据源、安全凭据与运行时生命周期

文件：新增 DataSourceStore、DataService、DataRuntime、DataPreload、DataServicesPanel 和 DataSourceDialog；扩展 shared data 合同及 service-context。

- [ ] 定义数据源和数据库凭据独立 schema，拒绝从 hostId 推断数据库账号；覆盖创建/编辑/删除、损坏文件、并发写和安全存储不可用。
- [ ] 用户显式配置服务器视角地址/端口和 TLS；Main 校验 host、数据源与会话权限，utility 沿现有 SSH 打开专属 channel。
- [ ] 将取消、离开页签、切主机、断线、runtime 崩溃和数据根迁移接入统一清理；旧查询不得写新数据源 UI，不自动重连/重跑写操作。
- [ ] 只读连接元数据可以展示，秘密、连接串密码、结果正文和内部 connectionId 不出现在公开错误/审计。
- [ ] 用每个已就绪引擎的 fixture 验证连接成功、认证失败、TLS 失败、无权限和重载清理后提交。

### Task 3.3：三个引擎的只读诊断，分别交付

文件：`data-adapters/` 各引擎实现/测试、DataService、DataServicesPanel、AgentFacade/工具合同。

- [ ] PostgreSQL：固定模板读取目录、容量、连接和复制；慢查询依赖扩展时先检测，缺失显示不可用，不自动安装。
- [ ] MySQL：固定模板读取 schema、容量、进程和复制；performance_schema 不可用时保留其他数据，不自动配置服务器。
- [ ] Redis：INFO/SLOWLOG 只读诊断及 cursor 浏览；不使用 KEYS；SCAN COUNT 不作硬上限依据，以实际数量/字节/回合预算截断并保留 cursor。
- [ ] 每个引擎分别测试权限不足、异常版本、空状态、巨量返回、中文/二进制值、截断、取消及切换代次；未就绪引擎保持明确不可用。
- [ ] UI 和普通 Agent 共用诊断服务，Agent 不自动获得全量 SQL/Key 值；每个引擎完成真实测试后单独提交。

### Task 3.4：查询控制台和精确数据变更

文件：各引擎 query policy/adapter、DataService、数据控制台视图、AuditStore 与 Agent 审批合同。

- [ ] 用合法只读、注释/多语句、函数副作用、存储过程、DDL 隐式提交、超时和取消失败建立失败测试；引擎权限是最终边界，不能通过 `startsWith('SELECT')` 放行。
- [ ] PostgreSQL/MySQL 自由 SQL 查询仅在对应引擎已验证只读机制、可信 parser 和最小权限角色后开放；不支持的语法保守拒绝或转为单次写审批，不凭 UI“只读”标签承诺安全。Redis 使用按命令枚举的受控入口，不复用 SQL parser 或开放任意命令透传。
- [ ] 查询上限在驱动消费层实施；查询编辑稿与结果保持分离，旧结果不覆盖新查询，取消完成前不复用连接执行替代语句。
- [ ] DDL/DML、终止连接和单 Key 修改/删除按精确目标逐次审批；需要写权限时明确选择独立写身份，批准不生成额外数据库权限。
- [ ] 审计只记引擎、资源类别、动作/语句摘要 hash、行数和结果，不落查询参数/数据值。未知结果不重放；DDL 不承诺通用回滚。禁用 FLUSH/DEBUG/复制变更/批量删 Key 的默认入口。
- [ ] 每引擎用一次性数据库验证正常读写、拒绝、事务边界、取消与未知结果，完成完整 UI/Agent 回归后提交 P3d。

## 8. 验证命令与成功标准

实施命令统一在本 worktree 执行，使用 Bun，不替换主工作区依赖。本轮规划不执行安装/构建。

```bash
bun install --frozen-lockfile
bun test --isolate packages/shared/src/types/server-ops.test.ts apps/electron/src/main/lib/server-ops apps/electron/src/utility/server-ops apps/electron/src/renderer/components/server-ops apps/electron/src/preload/server-ops-audit-preload.test.ts apps/electron/src/preload/server-ops-observability-preload.test.ts
bun test --isolate apps/electron/src/renderer/atoms/server-ops-workspace-registration.test.ts apps/electron/src/renderer/lib/server-ops-agent-access-session-guard.test.ts apps/electron/src/renderer/components/app-shell/AppShell.server-ops-access.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/agent-permission-service.test.ts
bun run typecheck
bun run electron:build
git diff --check
```

新增 shared/preload 测试须逐阶段加入命令，不能因原目录过滤遗漏。每个任务先运行其精确失败测试，确认失败原因匹配缺失行为；实现后相同测试通过，再跑关联目录。CI 原有检查是最终合入要求。若该分支存在 lint/static 脚本，按 package 中真实名称执行，不发明不存在的命令。

本地 SSH/SFTP fixture 需要 loopback 监听能力；环境 `EPERM` 单独记录并在允许本地监听的环境复跑，不把它当成产品失败或跳过通过。测试只访问临时 fixture，不访问用户生产服务器、数据库或凭据。

真实 Electron 验收在各阶段进行，覆盖宽/窄 Pane、深浅主题、键盘、加载/空/错状态、host 切换首帧、重复点击及 Renderer reload。压力验收使用设计中的预算，记录峰值、趋势和释放后资源计数。包验证覆盖 macOS arm64/x64、Windows x64、Linux x64，确认产物内真实版本及 utility/驱动闭包；无法执行的平台明确未验收。

## 9. 验收映射与停止条件

| 场景 | 负责任务 | 不合格条件 |
| --- | --- | --- |
| 换密钥后恢复、撤销后重新确认 | 0.3-0.4 | 提前认证、旧 pin 被无条件覆盖、UI 无入口 |
| 双进程/同 endpoint、多窗口迟到操作 | 0.1-0.4 | 静默丢更新、遗漏关联 Host、旧授权继续执行 |
| 文件内容一致、传输可取消、已有目标不覆盖 | 1.1-1.3 | 全文件进内存、误删他人文件、远端写被重放 |
| Docker 权限、日志/终端、动作后验证 | 2.1-2.2 | 名称代替完整 ID、环境默认连外部 daemon、盲目重试 |
| 数据连接、TLS、最小权限和结果预算 | 3.1-3.3 | 查询成功但绕过认证、全量读完才截断、泄漏秘密 |
| 查询取消、写审批、结果未知 | 3.4 | SQL 前缀判断只读、审批绕过数据库权限、DDL 假回滚 |
| Agent 与 UI 权限同源但身份独立 | 各域任务 | 新能力进入内部/自动化/外部来源，或页面正文自动入模 |
| 数据根/启动/退出/打包 | 每阶段验收 | normal gate 前构造 Store，关闭后留 fd/channel，包缺驱动 |

阶段完成以实现、BDD、关联回归、typecheck、必要构建和对应 fixture/UI 证据为准；功能完成、真实环境验收、安装包发布分别标记。用户未要求发布，本分支不提前改版本、README、tutorial 或 release notes。所有功能复选框在规划结束时保持未勾选。

## 10. 本轮交付与下一步

本轮只提交这份计划、配套设计和分支 MEMORY 的规划记录。后续开始实施时从 Task 0.1 进入，先验证共享配置与信任恢复，再推进文件、Docker 和数据服务。依赖选型、fixture 能力和真实平台可用性都有明确闸门，不据尚未执行的验证作完成承诺。
