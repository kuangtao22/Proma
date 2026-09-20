# 数据库工作台落地计划

> 按已批准的 `2026-09-19-database-workbench-layout-design.md` 执行。用户已授权实施，连续完成本地实现与验证，不另行提交或发布。

**目标：** 先选库、左侧持续表目录、右侧数据与结构；诊断按页面请求，参数独立只读。

**架构：** 保留项目、SSH、Redis 入口；MySQL 使用独立工作台。现有连接管理控制器只负责测试/编辑/删除，新增浏览与诊断请求协调，避免 StrictMode 和快速换表留下无人负责的加载状态。轻量导航用 Jotai，只读结果留在组件生命周期内。

**技术：** Bun、React、Jotai、既有 Radix primitives、Electron IPC、mysql2；不新增依赖。

## 影响和开销

界面改动限定 MySQL 分支；参数与诊断扩展保持旧输入兼容，Redis 仍使用 INFO/Keyspace/SLOWLOG。每页按需请求，不后台轮询；相同在途读取合并，同一资源排队并跳过已失效目标。表数据只有当前页，目录和结构有界，不持久化业务值。原始日志无来源，展示未接入状态。

## 1. 后端合同（子代理负责）

- [x] 测试无初始库、不可见库、空表字段、NULL/空串/二进制、截断与分页。
- [x] 库目录无需指定初始库；新增目录截断和表类型信息。
- [x] 诊断输入新增 `section`，按概览/会话/慢语句/参数分别读；参数全局变量有界读取，兼容 MySQL 5.7。
- [x] mysql2 fields 提供空表列头，单元格有类型，分页有下一页和主键排序信息。
- [x] 同步 shared parser、main、preload、utility 合同与定向测试。

## 2. 浏览与生命周期（主代理负责）

- [x] 先补 BDD：默认数据、目录保留、切库/换表/翻页迟到结果、StrictMode、同 ID 配置更新、BUSY 不永久 loading。
- [x] 请求协调器合并同目标在途请求，序列化同 lane，跳过失去订阅的排队目标。
- [x] 浏览控制器分离目录/结构/数据代次，保留同目标刷新前的成功结果；错误可重试。
- [x] 目录搜索、四个表视图、空表列头、NULL/空串区分，720px 响应式目录、160–240px 调宽。

## 3. 工作台整合（主代理负责）

- [x] MySQL 默认数据浏览；运行诊断独立二级导航与实例范围提示，参数名搜索。
- [x] 连接头只保留身份摘要、展开/还原、更多菜单；复用测试/编辑/删除及密码弹窗。
- [x] 展开沿用标题栏安全区，保持控制器不重挂载；按发起 Pane 保存轻量导航，隐藏 Pane 不抢 Escape。
- [x] Redis 保持自身诊断，不显示 MySQL 表入口。

## 4. 验证与交付

- [x] 定向 `bun test`、Electron `bun run typecheck`、`bun run electron:build`；全仓类型检查的既有错误已单独记录。
- [x] 实际组件宽窄、深浅主题、焦点/快捷键及菜单弹层检查。
- [x] 完整 Electron → preload → main → utility → 受控 MySQL 测试链路；不将 fixture 当内网实测。
- [x] 规格覆盖审查及代码质量审查，修正发现后复验。
- [x] 回写 MEMORY：本轮取舍、验证边界、仍未接入的日志能力。

## 验收记录

- 前端相关 25 个文件：267 pass / 0 fail；覆盖来源切换、弹窗异步身份、连续断线恢复、结构页保留数据页码与 Pane 接线。
- 后端相关 11 个文件：193 pass / 0 fail / 769 assertions；主代理另以隔离模式独立验证其中 7 个核心合同文件，134 pass / 0 fail。前后端相关回归共 460 项，最终独立规格/代码/安全复审均 APPROVE，无剩余问题。
- 独立 Electron 实际组件：320/460/720/1024px 无外壳横向溢出；深浅主题、目录焦点、关闭重开、配置变更、密码显示/隐藏、草稿测试、展开菜单通过。生产样式主题切换有过渡，截图需等待过渡结束。
- 实际 `ServerOpsDataConnectionView` 点击 → 生产 preload/main/utility → localhost MySQL 协议夹具通过，数据/结构/索引/空表、按页诊断/参数均可用；展开与日志入口不产生额外读取。证据 `/private/tmp/proma-db-workbench-smoke-sgI4p9/component-evidence.json`，截图 `/private/tmp/proma-db-workbench-component-e2e.png`。
- 完整 `bun run electron:build` 通过，日志 `/private/tmp/proma-db-workbench-build.log`；最终 utility 修复后 `build:server-ops-runtime` 通过，五个开发运行时产物新鲜度检查通过。临时 E2E 的 main/preload/runtime 也已重新构建并复跑成功。
- 查询在途超时使用真实 Electron utility 验证：MySQL 握手后收到 `SELECT VERSION()` 并故意不响应，1011ms 返回超时，服务端 1009ms 收到 EOF，socket end/close 均为 true；请求仅一个终态，350ms 观察窗没有迟到回执。证据 `/private/tmp/proma-db-workbench-smoke-sgI4p9/query-timeout-evidence.json`。本机临时夹具不等于内网数据库联调。
- 根目录 `bun run typecheck` 仅 `packages/shared/src/types/canvas-media-model-scope.test.ts:46,68` 的既有 readonly 类型错误失败，其余 workspace 包通过；Electron 自身检查通过。仓库没有独立 lint 脚本，使用 TypeScript、定向测试与 `git diff --check` 验证。
- 原始日志、自由 SQL、写入/DDL、导出和读取审计不在本次实现范围；没有重启用户运行中的客户端，没有发布或提交。
