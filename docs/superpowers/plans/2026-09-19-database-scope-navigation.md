# 数据库实例与库级导航分区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按用户已批准的实例 / 数据库两区重组 MySQL 工作台，菜单范围和查询范围一致，保留现有表浏览及连接管理。

**Architecture:** 工作台管理两级导航，实例页为总览、会话、语句分析、实例参数；数据库区内唯一选库器共享给数据浏览、会话、语句分析。复用诊断控制器创建两个独立实例，分别持有全局和当前库快照，沿用请求队列的连接并发限制与配置失效保护。诊断组件只渲染当前页正文和刷新，不再持有混合范围的导航。

**Tech Stack:** React、Jotai、Radix Tabs / Select、现有 Proma 主题、Bun、隔离 Electron 模拟数据验证；不新增依赖。

## 范围与验收

- 实例区没有选库器，不依赖目录读取成功；未限定数据库的会话/语句查询只允许显式进入实例区时发出。
- 数据库区只有数据浏览、会话、语句分析；表内保留数据、结构、索引、属性。切换实例 / 数据库保留库、表、分页与各区当前页。
- 去掉「运行诊断」混合分类和未接入的「日志」页签。「慢语句」改称「语句分析」，继续说明累计摘要和默认库归属。
- 实例总览中的库容量表改称「数据库容量」；库名可进入该库数据浏览，仍由目录与权限校验目标，不用容量汇总冒充完整目录。
- 连接操作、测试密码、SSH、Redis、四层 IPC 协议不改动。指标保持按面板宽度三列 / 两列。
- 不增加轮询；两个控制器只在相应页激活时读取，旧配置和旧库晚到回执不能覆盖当前页。
- 在现有 WIP 分支继续，不拆走用户未提交的关联代码，不自动提交。

## Task 1：导航与范围隔离（主代理）

**Files:**
- Modify: `apps/electron/src/renderer/atoms/server-ops-database-atoms.ts`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsDatabaseWorkbench.tsx`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsSchemaBrowserView.tsx`
- Test: `apps/electron/src/renderer/components/server-ops/ServerOpsDataConnectionView.test.tsx`
- Test: `apps/electron/src/renderer/components/server-ops/server-ops-diagnostics-controller.test.ts`

- [x] 先更新旧的“选择器统领所有页签”测试，新增实例区不出现选库器、库区没有参数/日志、默认数据浏览断言，运行并确认失败。
- [x] 轻量状态拆为三个字段，各自记忆最后页面；旧状态仅在当前内存会话中存在，不写磁盘。

```ts
/** 对象范围、实例页面与库内页面分别记忆。 */
type ServerOpsDatabaseSection = 'instance' | 'database'
type ServerOpsInstancePage = 'overview' | 'sessions' | 'statements' | 'parameters'
type ServerOpsDatabasePage = 'browse' | 'sessions' | 'statements'
// 初始值：section: 'database', instancePage: 'overview', databasePage: 'browse'
```

- [x] 新增两个控制器共同工作的行为测试：相同 section、不同 database 的输入分别发送；切换范围不重复读取；库名变化不失效实例页；旧库回执晚到不串入实例页。
- [x] 工作台分别创建 instanceDiagnosticsController / databaseDiagnosticsController。每次同步先暂停，再设置配置身份，再设置范围，最后激活目标页；配置不匹配时两者均暂停。

```ts
instanceDiagnosticsController.selectPage(null)
instanceDiagnosticsController.setSource(source.id, identity, readable)
// 实例控制器的 database 始终为 null。
instanceDiagnosticsController.selectPage(configurationMatches && navigation.section === 'instance' ? navigation.instancePage : null)
databaseDiagnosticsController.selectPage(null)
databaseDiagnosticsController.setSource(source.id, identity, readable)
databaseDiagnosticsController.setDatabase(currentSchema.database)
databaseDiagnosticsController.selectPage(configurationMatches && navigation.section === 'database' && currentSchema.database !== null && navigation.databasePage !== 'browse' ? navigation.databasePage : null)
```

- [x] 用现有 Radix Tabs 实现两区及各自子页。表浏览保持挂载，保留搜索、表、页码；实例区隐藏且不挂载选库控件。库选择和库内页签宽时同排，窄时换行。
- [x] 容量表跳转显式切至数据库 / 数据浏览，再交给 schemaController.selectDatabase；同库跳转保留原表。
- [x] 运行 `bun test src/renderer/components/server-ops/ServerOpsDataConnectionView.test.tsx src/renderer/components/server-ops/server-ops-diagnostics-controller.test.ts`（工作目录 apps/electron），预期全部通过。

## Task 2：诊断正文与容量跳转（独立子代理）

**Files:**
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsDatabaseDiagnostics.tsx`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsDataServicesPanel.tsx`（仅结果表的可选单元格渲染能力）
- Test: `apps/electron/src/renderer/components/server-ops/ServerOpsDatabaseDiagnostics.test.tsx`

- [x] 先写失败测试，验证实例会话 null 库可刷新、库会话 null 库禁止刷新、无内置日志/混合范围导航、容量标题及库名操作。
- [x] 正文接口替换 onPageChange 为 scope，导航由工作台持有；调用方可传入容量跳转回调。

```ts
/** 页面管理对象范围，库名为空时不能伪装成实例范围。 */
interface ServerOpsDatabaseDiagnosticsProps {
  projection: ServerOpsDiagnosticsProjection
  page: Exclude<ServerOpsDiagnosticPage, 'logs'>
  scope: 'instance' | 'database'
  onRefresh: () => void
  onSelectDatabase?: (database: string) => void
}
```

- [x] 删除组件内的 Tabs 和日志占位正文，保留现有指标、参数搜索、错误恢复、时间戳与响应式列数。实例会话/语句说明全部可见范围，库级说明当前库和默认库归属。
- [x] 复用 ServerOpsDataTable，仅增加可选 renderCell 回调以渲染容量表库名按钮；其他表默认展示完全不变，未提供跳转动作时保持纯文本。
- [x] `bun test src/renderer/components/server-ops/ServerOpsDatabaseDiagnostics.test.tsx src/renderer/components/server-ops/ServerOpsDataServicesPanel.test.tsx` 全部通过后复核范围与共享表兼容性。

## Task 3：集成与验收（主代理 + 独立复核）

**Files:**
- Modify: `.omx/qa/database-workbench-ui.tsx`
- Modify: `.omx/qa/database-workbench-ui-check.cjs`
- Modify: `MEMORY.md`（记录已实施范围及验证边界）

- [x] 旧导航的组件测试先得到 3 项失败，再用已有真实组件模拟 API 夹具更新并运行交互验收。
- [x] 验证实例无选库、两类会话实际输入、缓存保留、参数不因选库重读、容量表跳转、目录失败后实例仍可访问、恢复库页面零临时全局请求、同 ID 配置更新、表/页码保留。
- [x] 验证 320 / 460 / 720 / 1024px 和深浅主题；表目录键盘恢复与连接设置沿用旧回归。测试不访问真实数据库、不读取真实密码、不重启用户客户端。
- [x] 执行 renderer 运维定向测试、`bun run typecheck`、`bun run build:renderer`；按失败证据处理本轮相关问题。
- [x] 先独立需求复核，再独立质量复核；修复实际问题并重新验证。
- [x] 记录测试证据与完成状态；检查空白错误并回写 MEMORY，交付具体结果及剩余限制。

## 执行记录

实现与动态验证完成；独立需求复核 PASS，独立质量复核 APPROVE，无阻塞项。未提交，保留原工作区关联改动。

- 运维 renderer：`bun test --isolate src/renderer/components/server-ops`，266 pass / 0 fail，1215 assertions，日志 `/private/tmp/proma-database-scope-renderer-final.log`。
- 类型检查：Electron 与其他应用包通过；全仓 `bun run typecheck` exit 2，阻塞来自本轮未改动的 `packages/shared/src/types/canvas-media-model-scope.test.ts:46,68` 两处 readonly capabilities 与可变数组的类型不匹配，未扩大范围修改。
- 前端构建通过，日志 `/private/tmp/proma-database-scope-build-final.log`；保留仓库既有大 chunk 警告，无新增依赖。
- 最终隔离 Electron GUI exit 0 / PASS，日志 `/private/tmp/proma-database-scope-gui-final.log`。控制器与 UI 使用真实代码，API 全部为示例数据；没有测试用户内网数据库或重启真实客户端。
- 已查看截图：`/private/tmp/proma-db-diagnostics-ui-light.png`、`/private/tmp/proma-db-workbench-ui-320.png`、`/private/tmp/proma-db-workbench-ui-dark.png`。
- 独立复核额外运行 65 项相关用例全部通过。非阻塞观察：重新打开实例区仍沿用旧 schema controller 的导航恢复读取，可能恢复隐藏的目录和表页；这不是本轮新增路径，也不扩大诊断范围。若后续优化，应先补实例区重开与首次进入数据库的生命周期回归，再引入显式暂停门禁。
