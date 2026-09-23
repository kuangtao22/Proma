# 运维本地 SQLite 拖入打开实施计划

## 2026-09-23 入口调整

用户进一步指定：连接方式新增「本地数据库（SQLite）」；删除项目页常驻导入行，拖文件进入整个运维面板时显示覆盖背景与虚线说明。

- 表单只增加展示模式，继续提交 `sqlite + direct`，不迁移连接或修改 IPC；切换模式清理不适用字段，保留已有 SSH SQLite。
- 新增独立拖拽宿主覆盖工作区全部业务页，展开态按实际宿主尺寸显示；普通文本拖动、其他 Pane 与弹窗不被拦截。嵌套拖拽不闪烁，切项目、失焦、取消及松手清理提示。
- 探测与保存复用既有导入控制器；重复松手使用同步锁保护，进度使用 toast，避免异步期间切项目后仍遮住新页面。
- 验证表单模式转换与提交合同、拖拽进入/退出/取消/松手、忙碌和失活边界，再运行类型检查与真实 Electron GUI。仅 renderer 变更，dev 使用 Vite 热更新。
- 入口调整回归：5 文件 105 项通过（`/private/tmp/proma-sqlite-entry-final-tests.log`），7 workspace 类型检查通过（`/private/tmp/proma-sqlite-entry-typecheck.log`）；真实 dev 5174 已返回新表单、工作区接线与覆盖提示模块。
- 分屏审查补齐「拖入可见但未聚焦的 Pane」：文件进入时聚焦实际面板根，复用父级 Pane 激活逻辑，Portal 与文本不抢焦点；最终 Electron 类型检查再次通过（`/private/tmp/proma-sqlite-entry-electron-final-typecheck.log`）。
- 真实 Electron 合成 GUI 与 Vite 构建通过：验证文件拖入聚焦、嵌套进出、Escape、切项目、单次 drop、忙碌/失活/文本/外部/Portal 隔离、本地模式选文件与提交合同，以及展开后覆盖范围和无横向溢出。深色覆盖提示与动画完成后的浅色表单已目视复核，截图位于 `/private/tmp/proma-sqlite-entry-overlay-dark.png`、`/private/tmp/proma-sqlite-entry-local-form-light.png`；夹具位于 `/private/tmp/proma-sqlite-entry-ui-smoke/`。未读取用户数据库或修改真实配置；临时 preview 已停止，现有 dev 保持运行。

**目标：** 将本机 SQLite 文件拖入当前运维项目即可登记并打开，支持文件选择、表结构、分页筛选、只读 SQL 与现有 Agent 禁用表规则。

**架构：** 复用 `engine: 'sqlite', transport: 'direct'` 和现有数据源 CRUD / 工作台。主进程校验真实文件并保存文件身份；utility 在短生命周期 Electron Node 子进程使用内置 SQLite 只读查询，取消和超时等待进程退出后释放并发；独立监督线程负责父进程意外退出与最终硬时限。原文件按需读取，业务配置继续采用 JSON。

**技术：** Bun、TypeScript、Electron 43、React、Jotai、Node SQLite / child_process / worker_threads；不新增依赖。

## 合同与验收

- 首期普通未加密 SQLite；通过文件头识别格式，不只按扩展名判断。拒绝目录、缺失、损坏、非 SQLite 文件，并提供中文错误。
- 本地路径支持 POSIX 与 Windows 盘符绝对路径；远端路径继续只允许 POSIX。文件 URI、相对路径与内存数据库不接受。
- 拖入登记到发起时的项目并打开工作台；切项目或关闭后的迟到回执不抢导航。文件选择是等价入口。
- 文件真实路径、设备/inode/创建时间绑定到连接身份；替换原文件后阻止沿用旧目标。普通数据库内容更新不误报文件替换。
- 使用原文件、按需表目录和分页；默认只读，禁止 ATTACH、扩展加载、写 SQL 和任意文件函数。敏感列、筛选、结果预算沿用原合同。
- 独立子进程承接同步数据库操作，查询超时与取消必须真实终止执行，不能只丢弃结果。
- 不改现有远端 SQLite / MySQL / Redis 连接行为；不修改用户真实数据库或重启现有客户端。

## 任务与验证

- [x] 合同与主进程：新增本地绝对路径分支、主进程文件校验与文件身份保存/复核，更新 runtime protocol、身份与缓存。先写本地合法/非法路径、配置往返、替换文件拒绝的 BDD 回归。
- [x] 执行器：复用 SQLite 请求与结果校验，新增独立本地读取子进程。以临时 SQLite 验证目录/结构/索引/分页/筛选/SQL/NULL/BLOB/敏感列、写入拒绝、损坏、锁定、WAL、超时与取消。
- [x] 界面：项目视图拖入与选择文件，SQLite 表单区分本地/SSH；保存后复用现有连接工作台，错误不遗留无效数据源。覆盖成功、失败和项目切换竞态。
- [x] 集成：执行定向 Bun 回归、全仓 typecheck、隔离 Electron 构建、实际 Electron 本地读取及独立评审；检查 git diff，不提交无关改动。

## 影响与成本

每次读取启动短生命周期子进程，避免主进程/UI 阻塞；保留现有有界队列、行数、字节和时间上限。首次打开仅校验文件头与目录，不复制整库、不做全表计数或后台轮询。Agent 仍使用权威连接和禁用表策略，文件目标更换使旧读取失效。

实现取舍：DatabaseSync 是同步原生调用，Worker.terminate 不能作为 sqlite3_step 已停止的证据；采用可硬终止的子进程并等待 close，代价是每次读取有一次进程启动，换取可靠取消与界面响应。

## 验收证据

- shared 与主进程范围覆盖 1,056 项；沙箱内 1,054 项通过，另外两项文件监听用例在允许系统监听的环境重跑通过。本地文件绑定、缓存拒绝、读取途中替换等 7 项也单独重跑通过。
- utility 既有 SSH、SFTP、MySQL、Redis 与 TLS 回归中，沙箱禁止监听 `127.0.0.1` 的四个测试文件在提权环境重跑，65 项全部通过。所有服务使用回环地址和合成数据。
- 本地 SQLite runtime 最终 10 项通过，包含真实 Electron Node 的 WAL、写入拒绝、敏感列、BLOB/结果预算、锁、文件替换、250 ms 超时、50 ms 后取消以及取消后读取。孤儿查询用例先观察 SQLite 读锁阻止独占事务，再强杀父进程，验证 3 秒内锁释放；宽表复合主键跨第 64 列的分页用例先红后绿。普通用例采用生产一致的 15 秒预算，避免并行构建负载被误认为功能超时。
- renderer 运维范围最终 508 项全部通过；preload 本地数据源合同 7 项通过。错误映射覆盖 IPC 包装后的普通文件、缺失文件、目录、权限和路径替换；长文件名自动生成有界名称，编辑 SQLite 时锁定连接方式以免界面改选被忽略。
- 隔离 GUI 使用真实 ProjectView、DataSourceFields 与导入 controller，加载正式构建的 Tailwind CSS。文件选择、DataTransfer 拖入、本地/SSH 切换及切项目后的迟到探测均通过；420 px 深色与 1,280 px 浅色无横向溢出，经截图复核控件无重叠。证据：`/private/tmp/proma-local-sqlite-narrow-dark.png`、`/private/tmp/proma-local-sqlite-wide-light.png`。这验证局部组件与交互，不代表安装版整窗端到端验收；临时前端服务已停止。
- 全仓 7 个工作区 `bun run typecheck` 全部通过。证据：`/private/tmp/proma-local-sqlite-typecheck-final.log`。
- 在 `/private/tmp/proma-local-sqlite-build-tk_naum0` 复制源码与 Electron 本体后运行完整 `bun run electron:build`，成功完成；既有 Vite chunk 大小与 EventKit availability 警告不阻断构建。没有签名或替换工作区原 Electron、安装版客户端。
- 最终复核修正后，额外完成最新 runtime bundle、renderer 构建、Electron workspace 类型检查与真实 Electron smoke；独立交叉复核覆盖主进程/shared 合同和 renderer/runtime。`git diff --check` 通过，用户已有 `.gitignore` 修改保留。
- 新增可重复运行的 `apps/electron/scripts/server-ops-local-sqlite-smoke.ts`，隔离的真实 Electron 主进程 → ServerOpsRuntimeClient → utility → SQLite 子进程通过登记、探测、表结构、筛选、SQL、遮罩、写入拒绝、300 ms 后取消长查询、取消后再探测，以及数据库原始字节不变断言。证据：`/private/tmp/proma-local-sqlite-smoke.log`。

## 适用范围与未执行项

- 首期普通未加密 SQLite；不支持 SQLCipher、DuckDB、Access 或数据库服务端的数据目录。仅提供只读浏览与查询。
- 本轮真实运行在 macOS Electron 43.2.0 / Node 24.18.0；Windows 路径和测试执行器选择有合同覆盖，但未在 Windows/Linux 实机启动验收。
- 安装版没有更新或重启。曾在前期构建过当前工作区的运维 runtime，已向用户说明；此后构建和验收均在临时目录完成。未提交、推送或发布。
