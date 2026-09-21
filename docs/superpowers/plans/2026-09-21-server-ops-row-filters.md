# 运维表数据多条件筛选实施计划

**目标：** 在表详情顶部提供可展开筛选面板，选择字段、运算符与值后在 MySQL / SQLite 服务端分页读取匹配行。

**方案：** 复用现有 READ_ROWS、Radix、Jotai 与只读调度。筛选草稿保留在当前视图内，点击应用才查询；已应用条件参与请求身份，换库/换表/配置变化时清空。最多 12 条条件，支持全部满足 / 任一满足，不支持原始 SQL 或嵌套条件。筛选不写入全局导航、配置或日志。

**技术栈：** Bun、TypeScript、React、Jotai、mysql2、远端 Python sqlite3；不新增依赖。

## 合同

```ts
type ServerOpsDataRowFilterOperator = 'eq' | 'ne' | 'contains' | 'not-contains'
  | 'starts-with' | 'ends-with' | 'gt' | 'gte' | 'lt' | 'lte' | 'is-null' | 'is-not-null'
interface ServerOpsDataRowFilter { column: string; operator: ServerOpsDataRowFilterOperator; value?: string }
interface ServerOpsDataRowFilters { match: 'all' | 'any'; conditions: ServerOpsDataRowFilter[] }
// ServerOpsDataSourceRowsInput.filters?: ServerOpsDataRowFilters
// utility request.rowFilters?: ServerOpsDataRowFilters（仅 schema-rows）
```

字段名有界且必须命中服务端当前结构；值最多 1024 字符。NULL 运算符禁止 value，其余运算符需要字符串 value，空串合法。LIKE 使用显式转义字符，用户的 % / _ 按字面量处理。有筛选时不返回未筛选的 totalEstimate，不做 COUNT(*)。

## 执行切片

- [x] 共享合同与 MySQL / SQLite 执行：先补非法运算符、额外键、数量/长度上限、字段注入、值注入、LIKE 字面量、AND/OR、NULL、分页测试，再实现白名单和参数绑定；原无筛选请求继续可用。
- [x] 独立筛选面板：添加/删除条件、字段选择、运算符、值、组合方式、应用和重置；加载结构时显示状态，可重试；折叠不撤销已应用条件；使用主题变量、键盘语义和窄面板布局。
- [x] 主进程与 renderer 集成：四层 IPC 检查；控制器按需读取字段，应用重置页码，翻页/刷新保留条件，切目标清空；同页旧请求不能覆盖新筛选结果。
- [x] 验证与交付：目标测试、7 工作区类型检查、隔离完整 Electron 构建；独立安全/业务复核。只使用临时数据夹具，不访问用户真实数据库。记录无法进行的 GUI 验收。

## 验证命令

```bash
bun test packages/shared/src/types/server-ops-data-schema.test.ts
bun test apps/electron/src/renderer/components/server-ops/ServerOpsRowFilterPanel.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsSchemaBrowser.test.tsx
bun test apps/electron/src/main/lib/server-ops/server-ops-data-service.test.ts apps/electron/src/utility/server-ops/server-ops-runtime-protocol.test.ts apps/electron/src/utility/server-ops/server-ops-data-runtime.test.ts apps/electron/src/utility/server-ops/server-ops-sqlite-runtime.test.ts
bun run typecheck
```

**关联影响：** Agent 原有读工具继续使用不带筛选的合同；Redis 不提供关系表筛选。新字段仅扩展现有行读取，保持主机身份、只读授权、取消与并发边界。应用条件才触发请求，继续最多 200 行和既有超时，结构按需复用缓存。

## 安全复核补充

- 界面与两个执行器均拒绝敏感字段筛选，避免通过命中与否探测已遮罩内容。
- MySQL 的 `query(sql, values)` 是客户端插值；不能据此声称在 `NO_BACKSLASH_ESCAPES` 下安全。筛选请求依赖的库/表/索引/列元数据与最终行查询全部使用 `execute` 服务端预处理；缺少能力时拒绝，不回退。分页数字先做有界整数校验再写入 SQL，用户字符串只走绑定参数。
- 独立复核已通过；真实 MySQL `NO_BACKSLASH_ESCAPES` 实例与客户端 GUI 点击未实测。

## 验证结果

- 最终 10 个相关文件：181 pass / 0 fail，覆盖共享合同、preload、主服务、utility、MySQL/SQLite、筛选面板和控制器；日志 `/private/tmp/proma-row-filter-final-tests.log`。参数类型进一步收窄后相关测试仍通过。
- 运维 82 个文件广泛回归：1,186 pass，1 项既有 SQL 历史容量测试超过默认 5 秒；单独复跑该文件 10 pass / 0 fail（容量项 3.46 秒）。日志分别为 `/private/tmp/proma-row-filter-regression.log`、`/private/tmp/proma-row-filter-history-rerun.log`。
- 7 个 workspace 类型检查全部通过：`/private/tmp/proma-row-filter-final-typecheck.log`；隔离完整 Electron 构建通过：`/private/tmp/proma-row-filter-final-build.log`；`git diff --check` 通过。
- 当前工作区的 main、Agent runtime、终端 runtime、运维 runtime 和 preload 均已重建；renderer 继续由现有 Vite 提供。未重启现有客户端，后台新合同在客户端重启后加载；未修改安装版。
- CUA 获取界面连续超时，未完成 GUI 点击及深浅主题截图验收；真实 SQLite 使用临时文件验证，未访问用户远程数据库，未提交或发布。

## 用户报错后的实机复验（2026-09-21）

- 后续截图报“操作失败”已定位为旧主进程拒绝新增筛选参数：旧客户端启动早于新后台构建，日志在 IPC 参数解析阶段报 `SERVER_OPS_DATA_SCHEMA_ROWS_INPUT_INVALID`，尚未访问数据库。
- 已对经过前端校验的筛选请求补充明确的完整重启提示，并保留已应用条件；普通输入错误不会误映射到该提示。新增回归先红后绿，32 项相关测试通过，7 工作区类型检查与前端构建通过。日志：`/private/tmp/proma-filter-stale-green.log`、`/private/tmp/proma-filter-stale-typecheck.log`、`/private/tmp/proma-filter-stale-renderer-build.log`。
- 已正常退出旧开发实例并启动当前构建，未替换或停止安装版。通过 CUA 在实际客户端打开原连接、库与表，应用用户原 UUID 等值筛选；界面显示“已应用 1 条”“没有符合筛选条件的记录”，截图确认“筛选结果 · 0 行”。原操作失败已消失，新进程日志未出现行读取 IPC 错误。
- 上述结果补足原先缺失的真实 MySQL GUI 验收；不代表真实 MySQL `NO_BACKSLASH_ESCAPES` 配置或浅色主题已实测。验证为只读，未修改数据库、连接配置或 Agent 授权，未提交或发布；不记录实际筛选值与数据内容。
