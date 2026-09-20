# MySQL 只读 SQL 查询实施计划

> 用户已批准开始。使用 writing-plans、TDD 与原生子任务分工执行；保留现有未提交修改，不访问真实数据库，不提交或重启客户端。

**目标：** 在当前数据库下提供 SQL 编辑、执行、取消与结果展示，普通 Agent 通过独立显式授权使用同一执行服务。

**架构：** shared 提供严格请求/结果合同及保守 SELECT 语法解析；主进程验证连接、会话和库表授权，utility 通过现有直连/SSH 驱动执行。查询使用只读事务、数据库执行时间限制、客户端取消、结果预算与读取审计。不会把旧行预览授权升级为 SQL 权限。

**技术栈：** Bun、TypeScript、mysql2、Electron IPC、React/Jotai、既有 Radix 与主题；不新增依赖。

## 已确认边界

- 首版为 MySQL 单条 SELECT，支持筛选、排序、分组聚合与当前库内已授权表 JOIN。语法必须完整解析；CTE、子查询、UNION、视图、跨库、写入、锁、文件操作、用户变量、存储函数和未知函数不开放，拒绝时明确原因。
- 查询许可 `query?: boolean` 默认为 false；执行还必须有对应库 `readRows`。查询所引用的每张表均须获授权，普通会话及连接身份在等待前后复核。自动化等内部来源不继承。
- SQL 上限 16 KiB，UI 最多 200 行、Agent 最多 50 行、结果 32 KiB，固定 10 秒执行预算。查询按需执行，无后台轮询；每个连接至多一个 SQL 查询，复用全局读取并发上限。
- 敏感字段引用在执行前拒绝，通配列按真实字段来源遮罩；别名与表达式不能绕过。只执行基础表，避免视图定义与存储函数扩大授权。
- 取消需传到真实驱动并释放连接/隧道，返回前验证查询 ID 和配置身份，切库/连接/卸载不接收旧结果。审计存 SQL 摘要、库表、耗时和状态，不存 SQL 正文/字面值或行数据。

## 合同

```ts
interface ServerOpsDataQueryInput {
  sourceId: string
  database: string
  queryId: string
  sql: string
  maxRows: number
}
interface ServerOpsDataQueryCancelInput { sourceId: string; queryId: string }
interface ServerOpsDataQueryResult {
  queryId: string
  database: string
  columns: string[]
  rows: ServerOpsDataSchemaCell[][]
  rowCount: number
  durationMs: number
  truncated: boolean
  warnings: string[]
}
```

## 执行任务

- [x] 1. shared `server-ops-data-query.ts` 与 `server-ops-sql-parser.ts`：先写正常 SELECT/JOIN/聚合及注释、多语句、敏感列、越界等失败测试，再实现有界 tokenizer/parser 和 canonical SQL 输出。语法计划返回真实表集合、列引用及通配符信息。
- [x] 2. runtime/data-service：新增 SQL 模式与取消消息；真实基础表校验、只读事务和超时；行/字段预算和驱动释放。测试实际取消、超时、非法 SQL 零执行、空结果列头和敏感来源。
- [x] 3. 权限/审计/Pi：旧合同兼容 false，独立查询授权；新 `ops_database_query` 绑定真实会话，查询所有表均需命中；扩展审计合同与迁移并覆盖撤销竞态和开始审计失败。
- [x] 4. IPC/preload/renderer：四层严格合同、窗口查询所有权和取消；数据库新增 SQL 查询页、Jotai 状态控制器、编辑/执行/取消/结果/错误；授权弹窗独立开关。
- [x] 5. 定向回归、Electron 类型检查与隔离构建；用真实组件检查宽窄深浅、切库和迟到结果；独立规格与代码质量审查，修复发现，再更新本计划与 MEMORY。

## 验证方式

相关测试使用 `bun test <改动文件对应测试>`；先确认新增行为失败，再实现至通过。最终 `bun run typecheck`，已知 shared 画布测试的两处 readonly 类型错误单独记录。构建输出临时目录，避免覆盖运行中的 dist。测试只使用内存/受控本地夹具，不使用用户凭据。

## 实施结果与边界

- 数据库工作台新增「SQL 查询」，共用顶部选库；支持编辑、Ctrl/Cmd+Enter 执行、取消、失败重试、结果快照、空结果列头、截断和中文错误。切库先等旧查询清理；取消失败保留同一身份重试。查询正文和结果只保存在组件内存，不新增后台轮询。
- 普通 Agent 新增 `ops_database_query`，须显式同时授予当前库行读取和 SQL 查询。所有 JOIN 表逐一验证授权，撤权/会话变化/配置变化后不返回迟到结果。旧权限默认不开放查询，自动化与内部运行不继承。
- 首版完整解析一个 SELECT 子集，支持筛选、排序、分组聚合及同库受控 JOIN；输出别名只在合法子句识别。CTE、子查询、UNION、DISTINCT、视图、跨库、写操作、未知函数等未开放语法明确拒绝，不声称完整 MySQL SQL 支持。
- mysql2 core 按行读取，最多 64 列，窗口 200 行、Agent 50 行，最终 JSON 32 KiB；单元格展示最多 256 字符。字段声明宽度超过 1024 字节时在行解码前拒绝，需明确选列或 `SUBSTRING(字段, 1, 256)` 缩小大字段。限制作用于实际读取过程，避免全量缓冲后再裁剪。
- MySQL 5.7.8+ 使用 `MAX_EXECUTION_TIME=10000`，MariaDB 10.1.1+ 使用 `max_statement_time=10`，并启用只读事务；更旧版本拒绝 SQL 查询。连接/元数据/清理沿用 15 秒整体预算。取消 ACK、已完成结果与错误都能精确收束；只有 utility 超过总预算仍不响应时才触发共享 runtime 的失联恢复。
- 查询与既有行预览共用敏感列分类。显式敏感表达式拒绝，通配列按驱动原始字段名遮罩。该辅助机制不等于完整匿名化，用户仍决定允许模型读取哪些库表。审计升级 v5，兼容旧记录，只保存去除常量后的结构哈希、库表和执行状态。

## 已完成验证

- 全运维 98 个测试文件：**1077 pass / 0 fail**。本机 SSH/SFTP/MySQL 协议夹具与目录监听在沙箱外隔离执行，未连接真实数据库或服务器；日志 `/private/tmp/proma-sql-ops-final.log`。
- 真实 mysql2 夹具覆盖生产 `runServerOpsDataRead`：正确选库、事务设置、查询结果、metadata 阶段取消及 socket 关闭。测试服务端把 SET 发往 `stmt_prepare`，须单独回复，不能把夹具漏处理误认为生产查询挂起。
- 真实 Store → Facade → Pi 工具组合验证独立授权、JOIN 范围、撤权和 SDK signal；UI 另验证 query 先返回取消、取消 ACK 后到的正常终态。驱动错误按稳定 code 分类，正文不进入审计或 UI。
- SQL 和授权弹窗的隔离 Electron GUI 通过：快捷键、错误与取消重试、切库等待、空结果、长警告，320/460/1024 深浅主题。脚本 `.omx/qa/database-sql-ui-check.cjs` 与 `.omx/qa/agent-read-ui-check.cjs`；截图 `/private/tmp/proma-db-sql-{light,dark}-{320,460,1024}.png`。
- 独立 parser/授权/审计与 runtime 最终复审均 **APPROVE**，已修复审查发现的敏感分类、别名、标识符、未知结果和取消竞态；`git diff --check` 通过。
- Electron 类型检查通过（`/private/tmp/proma-sql-electron-final.log`）；main、preload、runtime、renderer 隔离构建全部通过，输出目录 `/private/tmp/proma-sql-build.lD9UBo`。保留既有 main CJS `import.meta` 和 renderer 大 chunk 警告，未覆盖运行中的 dist 或重启用户客户端。
- 全仓类型检查仍有既有 `packages/shared/src/types/canvas-media-model-scope.test.ts:46,68` readonly 类型错误，未修改无关画布文件。以上验证不等于真实数据库验收或安装版更新。
