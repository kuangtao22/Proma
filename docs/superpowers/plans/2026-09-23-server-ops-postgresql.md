# 运维 PostgreSQL 接入实施与验收

**目标：** 在既有运维工作台增加 PostgreSQL，覆盖配置、直连/SSH、TLS、只读结构与数据浏览、受控 SQL、Agent 默认只读和禁用表。

**架构：** 复用通用数据源、凭据存储、IPC、调度器、缓存和工作台；新增独立 PostgreSQL runtime adapter。实际数据库与 schema 分开：数据库沿用 database 字段，表身份采用规范双引号限定名 `"schema"."table"`，未限定 SQL 表名固定 public。

**技术：** Bun、TypeScript、Electron utility process、React/Jotai；PostgreSQL 驱动锁定 pg@8.23.0、@types/pg@8.23.1（MIT，已核实维护状态与 Node 兼容性）。测试只使用临时合成数据库。

## 决策与影响

- 独立适配器避免把 MySQL 的 SHOW、反引号、TLS 握手与驱动行为强套给 PostgreSQL，已有三种引擎沿用原路径。
- 复用已有页面和 IPC，用户不必学习第二套管理方式；不增加后台轮询或自动全库扫描。
- PostgreSQL 支持 disabled、required、verify；不支持 preferred，避免认证失败或证书异常触发隐式明文降级。
- 固定只读事务、数据库执行限时、标识符白名单、绑定筛选值、流式/有界结果。数据库写操作仍仅生成脚本。
- JSON、大整数、日期保留数据库原文，bytea 仅预览大小；单元格全文遵守现有摘要一致性与 1 MiB 上限。
- PostgreSQL 系统 schema 不进入 Agent 默认读取，schema 同名表的策略互不混淆。授权变更与身份复核继续生效。
- 不改变安装版、不访问现有用户数据库；不提交、推送或发布。

## 实施检查

- [x] Shared：engine、TLS、Agent resource、连接草稿、规范表身份、PostgreSQL SQL 方言及所有严格解析器；先补 BDD 失败用例。
- [x] Runtime：独立驱动适配器与最小分派、连接生命周期、元数据、诊断、分页筛选、全文与只读查询；先补 BDD 失败用例。
- [x] Main：数据源服务、查询历史、禁用表策略、Agent 查询/诊断/变更上下文与工具声明。
- [x] Renderer：引擎/端口/默认库/TLS 表单、引擎标题、工作台、SQL 校验与补全、禁用表选择。
- [x] 构建：驱动版本与类型、Bun lockfile、external、开发及打包 runtime 依赖同步。
- [x] 验证：定向回归、类型检查、Electron 构建；独立 PostgreSQL 临时集群验证实际协议、数据类型、系统范围、超时与连接关闭。
- [x] 复查差异与独立审查，记录验证范围，补充 MEMORY.md。

## 验收记录

- 共享合同：117 项定向回归通过；SQL 审计上限同步覆盖 PostgreSQL 最长限定表名。
- Main/Agent：首轮 218 项定向回归通过；随后增加引擎显式匹配、默认库诊断隔离和 statements 不支持回执回归，分别通过。
- Renderer：最终运维 UI 加两项共享合同共 545 项通过；SQL 控制器用实际 API 调用回归双引号 PostgreSQL 查询，切换方言会清除旧执行状态。
- 全仓回归：`bun test --isolate`，7714 pass / 6 个 Windows 平台 skip / 0 fail，592 个文件；最终取消发送限时与 EOF 清理修复后，3 个相关 runtime 测试文件 61 pass / 0 fail。
- 类型检查：`bun run typecheck`，7 个工作区通过；最后取消清理改动后 Electron workspace 再次通过。`git diff --check` 通过。
- 构建：在 `/private/tmp/proma-pg-build-vb16m3ps` 源码副本运行 `bun run electron:build` 通过；后续变更已补主进程、Agent runtime、preload、运维 runtime、renderer 构建，最终运维 bundle 用于跨进程验收。实际工作区 dist 未作为构建目标，未重启客户端。
- 依赖分发：用生产 `syncRuntimeDeps` 将 pg 与完整运行依赖闭包复制至独立临时目录，再用 Electron 43.2.0 的 Node 加载，避免只验证 Bun 的解析行为。
- UI：真实生产表单在独立 Vite 合成页验证浅色/深色、受限高度滚动和保存；数据库 `business`、5432 与 required TLS 正确保留。测试回执为合成数据，未写真实配置。
- TLS：Electron 43.2.0 / Node 24.18.0 实际驱动验证 required 加密、自签未受信与证书名不符拒绝；仅测试进程信任合成 CA 后，正确证书名返回 verified。
- SSH：真实本地 ssh2 Server/Client + forwardOut + PostgreSQL 16.10 + required TLS 读取及取消成功；确认长查询真实执行后取消，24 ms 内服务端活动归零，4 个通道均观察到实际 close 事件。
- 只读和资源预算：生产连接与事务拒绝实际 INSERT（25006），数据保持不变；2 MiB bytea 经生产读取入口只返回长度预览，公开结果 178 字节；超大 SQL 文本在服务端投影后稳定拒绝，敏感列不可查询。bigint、numeric、JSON、微秒时间、主键索引、分页、摘要全文与参数单位均通过真实库验收。
- 超时和取消：服务端保留 10 秒 statement_timeout，SQL 流增加 500 ms 宽限后的硬关闭兜底，实测约 10513 ms 返回稳定 TIMEOUT；独立 Electron 主进程 → ServerOpsRuntimeClient → utility → PostgreSQL 直连取消，ACK 1 ms，服务端活动查询 24 ms 归零，后续 probe 可复用。
- 取消边界：CancelRequest 使用独立、只绑定原端点与原 SSH 身份的通道，不受已取消读取的门禁阻止；建链及发送分别限时，迟到通道回收。ssh2 的协议 close 不等于可读流 end；取消通道必须消费 EOF 并显式关闭，才能触发 close、释放资源表引用。新增可执行回归锁住此根因。
- 独立复审已修复：执行控制器默认 MySQL；canonical 同形 MySQL 名称的权限歧义；Agent 诊断目标库丢失；大字段在 pg 解码前的服务端投影边界；环境变量污染；生产入口取消工厂和 SSH EOF 回收。最终复审 APPROVE，无剩余阻断项。
- 环境清理：本任务临时 PostgreSQL 集群已停止；独立 Electron、SSH 与 Vite 验收进程均已退出。

### 验证证据（本机临时文件）

- 全仓与最终相关测试：`/private/tmp/proma-pg-full-test-complete.log`、`/private/tmp/proma-pg-targeted-final.log`。
- 类型与构建：`/private/tmp/proma-pg-typecheck-final.log`、`/private/tmp/proma-pg-build.log`、`/private/tmp/proma-pg-build-*-final.log`。
- 实际驱动与协议：`/private/tmp/proma-pg-tls-untrusted.log`、`/private/tmp/proma-pg-tls-trusted.log`、`/private/tmp/proma-pg-ssh-cancel-smoke.log`、`/private/tmp/proma-pg-boundary-smoke.log`、`/private/tmp/proma-pg-utility-smoke.log`。
- 下层压力执行摘要：`/private/tmp/proma-pg-runtime-smoke-summary.log`（根据成功执行输出记录；旧的同名 `.json` 空文件不是验收证据）。

## 明确边界

- PostgreSQL 语句统计当前返回“不支持”，不自动安装 pg_stat_statements，也不读取未脱敏 SQL。
- Agent 仅开放明确数据库的 sessions 诊断；实例概览和参数属于 UI 手动查看，避免把全实例信息当成库级授权结果。
- 所有真实数据库与 SSH 验收使用本次创建的临时合成环境；未读取用户已有数据库。
- 本轮不发布、不替换安装版；Windows/Linux 安装包与跨平台实际运行未做验收。
