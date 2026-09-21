# 服务器运维 SQLite 接入计划

**目标：** 在服务器运维的数据库连接中读取 SSH 服务器上的 SQLite 文件，支持连接测试、表结构、索引、分页数据和受控只读 SQL。

**架构：** 复用现有 data-read IPC、连接身份、并发限制、历史与审计。SQLite 端点独立使用 `filePath`，仅允许 SSH；网络引擎继续使用 address/port。远端通过 Python 3.11+ 标准库 sqlite3 执行内嵌固定脚本，数据参数经 stdin JSON 传递，不安装软件、不落地脚本、不下载数据库。

**技术：** Bun / TypeScript / Electron / React / Jotai；服务器 Python 3.11+ / SQLite。

## 行为与边界

- 用户从“添加数据库”选择 SQLite，指定 SSH 服务器和绝对文件路径；可测试、保存、编辑、移动和删除连接配置。
- SQLite 固定读取 `main`，不接受 URI、内存库或附加数据库。保留原文件，绝不创建数据库。
- 工作台复用数据浏览与 SQL 查询；隐藏 MySQL 专属实例会话、语句分析和参数页。展示 SQLite 与实际文件路径。
- 远端使用 mode=ro、query_only、authorizer、SQL AST 白名单、VM 操作预算、wall-clock 超时与有界 JSON，拒绝 ATTACH、写 SQL、扩展加载和任意文件函数。
- 每次读取独占短连接；不后台轮询，不扫描全部业务行。schema 缓存仍为显式 opt-in，文件路径参与连接身份；结果与 SQL 正文不进入审计。
- Agent 若接入，必须显式授予 SQLite 连接及 main/表/行/SQL 范围，不继承现有 MySQL 或 SSH 权限。
- 服务器必须具备 Python 3.11+ 的 sqlite3 标准库；缺失、路径不存在、损坏、锁定、断线和超时分别提供可操作的中文错误。

## 实施与验证

- [x] 共享合同：为 sqlite 增加 filePath 与严格分支校验，网络端点禁止 filePath；先覆盖合法路径、空路径、URI、网络参数夹带与旧配置回归。
- [x] SQL 方言：保留默认 MySQL 行为，增加 SQLite 标识符与内置函数校验；覆盖多语句、写入、ATTACH、危险函数与方言差异。
- [x] 远程执行：新增独立 SQLite adapter 与固定 Python 脚本，覆盖真实临时 SQLite 文件、空结果、中文、NULL/BLOB、大结果、缺失/损坏、写入拒绝、超时/取消及 shell 注入路径。
- [x] 主进程及 runtime：连接存储、探测、表浏览、查询、历史、SSH exec 和取消闭环，路径参与配置身份与缓存隔离；不改变网络引擎驱动。
- [x] UI：引擎选择、服务器选择、文件路径与 SQLite 工作台；复用 SQL 历史、补全和本地校验；测试旧 MySQL/Redis 表单及 SQLite 页签。
- [x] 权限：SQLite 独立授权，验证文件路径变化撤权、main 范围与表白名单，保留敏感列保护。
- [x] 先运行定向 Bun 测试，再全仓 typecheck 和隔离 Electron 构建；以隔离 fixture 验证，不连接用户真实服务器、不重启现有客户端。
- [x] 独立复审安全与兼容性；仅记录新的设计决策到 MEMORY.md，不复制代码细节。

## 影响评估

SQLite 每次读取启动一个短生命周期远程 Python 进程；相比持久数据库服务多一次进程启动，但不常驻、不传输整库，维持全局读取并发和结果预算。现有 SSH 认证与主机信任不变，SQLite 读取不借用终端任意命令权限。Proma 自身持久化仍使用原有配置格式。

## 验收证据

- 运维 Main / utility / renderer / preload / Pi 工具定向回归：1,105 项通过；shared 全包 389 项通过。真实回环服务与文件监听用例在允许本地监听的环境运行。
- 真实 Electron → utility → 回环 SSH → Python → 临时 SQLite：主机信任、连接测试、表/索引/行、查询、空结果列头、写入拒绝、TERM 取消、取消后复用均通过；主库文件逐字节保持不变。
- 在 `/private/tmp/proma-sqlite-build` 隔离源码、资源和 Electron 安装副本，完整 `bun run electron:build` 通过；没有覆盖原工作区 dist 或重启现有客户端。
- 独立后端复审通过；修复了只读权限错误分类、网络引擎误分派以及 SSH stdin 提前 EOF 导致 TERM 被忽略的问题。
- 用户真实服务器与安装版应用未参与验收；服务器需 Python 3.11+ 及 sqlite3 标准库。

- 界面冒烟：隔离 Vite + IAB 验证真实组件的深浅主题、MySQL→SQLite 切换、服务器可选、路径与保存 payload、仅显示数据浏览/SQL 两页；布局无溢出。项目添加 MySQL/Redis 的原跳板默认已恢复并有回归覆盖。
- 最终大记录边界：真实 2 MiB BLOB 超过读取预算时返回大小限制，不误报数据库损坏；SQLite 执行器 11 项测试通过。

- 最终 `bun run typecheck` 全部 7 个 workspace 退出 0；`git diff --check` 通过。
