# 运维数据库结构缓存与 SQL 联想 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. 用户已批准实施；本次不提交 Git。

**Goal:** 缓存当前连接的数据库目录与表结构，为 SQL 编辑器提供关键字、表名、字段和别名联想。

**Architecture:** 复用 schema IPC，在主进程提供显式 opt-in 的派生缓存。缓存只用于浏览和补全，SQL 执行、Agent 与数据行读取继续走原有实时路径。CodeMirror 使用已有版本，字段按需读取；切库与连接变更通过上下文代次丢弃迟到结果。

**Tech Stack:** Bun、Electron IPC、TypeScript、Jotai、CodeMirror 6、safe-file JSON。

## 约定与影响

- `ServerOpsDataSourceTablesInput` 和 `ServerOpsDataSourceTableInput` 增加可选 `cacheMode: 'prefer-cache' | 'refresh'`；缺省保留实时语义，不新增 IPC 通道。
- 缓存包含目录和结构，不包含数据行、SQL 结果或密码。固定路径 `server-ops/schema-cache.json`，有效期 10 分钟，总文件不超过 4 MiB、最多 256 项；内存同样有界。
- 缓存身份包含真实连接参数、账号和内部密文版本指纹；不使用明文密码摘要。返回/落盘前重新核对身份。SSH 连接变化与配置变化使旧读取失效。
- 手动刷新目录同时使该数据库字段缓存失效。缓存损坏或写入失败不阻断实时结构读取。
- 表和字段保留现有协议上限。加载当前 SQL 引用的表，不全库预取；输入防抖、请求去重，切库后旧结果不可回填。
- 保留查询历史回填、取消、Ctrl/Cmd+Enter；Tab 仅接受补全，中文输入法确认不触发查询。编辑器采用现有主题变量和 12px 字号。

## Task 1：主进程缓存与 IPC 合同

文件：`packages/shared/src/types/server-ops-data-schema.ts` 及测试；`apps/electron/src/main/lib/server-ops/server-ops-data-schema-cache.ts` 及测试；`server-ops-data-service.ts`、`server-ops-data-credential-store.ts`、`server-ops-config-transaction.ts`、`apps/electron/src/main/ipc.ts`。

- [x] 写并运行失败用例：持久化复用、TTL、同 scope 去重、跨库/账号隔离、密码同 ref 原位更改、在途配置变化、刷新、损坏文件及容量限制。
- [x] 实现可选 cacheMode 严格解析；旧输入输出形状不变。
- [x] 新增有界派生缓存，复用配置短事务和 safe-file 原子写；缓存异常降级实时读取。
- [x] 接入两个 schema 服务方法与生产实例；不修改 SQL 实时校验和 rows 路径。
- [x] 运行 shared schema、credential、cache、data-service、IPC/preload 相关测试。

## Task 2：SQL 编辑器与元数据加载

文件：`apps/electron/src/renderer/components/server-ops/ServerOpsSqlEditor.tsx`、`server-ops-sql-completion.ts`、`server-ops-sql-completion-controller.ts` 及测试；`ServerOpsSqlQueryPanel.tsx`、`server-ops-schema-controller.ts`；`apps/electron/package.json`、`bun.lock`。

- [x] 先验证失败用例：FROM/JOIN 表名、别名字段、中文和反引号标识符、字符串/注释不补全、切库迟到回执、按需去重和手动刷新。
- [x] 使用已安装的 CodeMirror SQL/补全/commands 版本，声明直接依赖；新增独立可控编辑器组件和 focus 接口。
- [x] 用 CodeMirror SQL 语法树理解表引用及上下文，字段显示类型与注释。
- [x] 元数据控制器连接 schema IPC，私有 Jotai 保存投影；显示读取状态/失败重试/刷新入口。
- [x] 替换 textarea，保留历史回填、查询/取消与快捷键。
- [x] 表浏览读取 opt-in 缓存，现有刷新显式 bypass；验证相关控制器回归。

## Task 3：集成验证与交付

- [x] 先独立规格审查，再代码质量审查，修复确证问题。
- [x] 运行新增与既有 SQL/schema/IPC 测试、`bun run typecheck`、`bun run electron:build`。
- [x] 浏览器/Electron 夹具验证补全键盘行为、中文、历史回填、主题、布局与真实 IPC 缓存复用。
- [x] 检查 dev 实例在途任务，更新构建并验证实际 preload 和编辑器生效。
- [x] 将稳定产品决策写入 `MEMORY.md`，报告验证结果与真实限制。

## 验证记录

- 13 个相关测试文件：235 pass / 0 fail。Electron workspace 类型检查通过；全仓类型检查仅有既有 `canvas-media-model-scope.test.ts` 的两处 readonly 类型错误。
- `bun run electron:build` 通过；首次 Swift 编译被沙箱禁止写编译缓存，允许构建缓存写入后完整通过。
- 独立 Electron GUI：Tab 接受/Esc 关闭、表名/字段/中文自动联想、IME 期间禁止执行、刷新结构、查询/取消与历史回填、320/460/1024 深浅主题布局通过。
- 生产 preload + IPC + service + 持久 store 冒烟：重复读取命中、refresh 失效、跨库隔离、未 opt-in 和 rows 实时；重建服务后 runtime 请求数保持 9 → 9。
- 实际 dev：更新前活动 Agent 为 0；构建更新后台后，用户数据库 SQL 页正常显示 CodeMirror、行号、75 张表与刷新结构入口，没有 alert；未执行真实 SQL。
- 缓存 IO 故障后当前服务实例保持禁用缓存，直到重建实例；不因其他 scope 刷新成功解除，避免复用未成功失效的旧数据。
- 独立规格与质量审查均 APPROVE；补充损坏缓存全候选失败与刷新目录期间切结构页的回归。最终修复后的 main、renderer 重新构建通过。
