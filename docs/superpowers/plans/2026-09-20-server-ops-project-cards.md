# 运维项目紧凑连接卡片实施计划

**Goal:** 将用户确认的 HTML 排版落到真实项目页：卡片网格、类型筛选、搜索及统一添加入口，保留现有连接和移动行为。

**Architecture:** 仍由 Workspace 提供当前项目连接与原有动作回调。连接模型直接生成 endpoint / metadata，避免拆解展示文案；类型和搜索只过滤内存列表，计数始终来自未过滤的当前项目连接。筛选状态由 Pane 独立 Jotai atom 持有，切换项目清空；CSS 容器查询决定 1/2/3 列。复用 Radix、Button 和 Proma 主题，不增加 IPC、依赖、持久化或后台请求。

**Tech Stack:** TypeScript、React、Jotai、Radix、Tailwind、Bun。

设计依据：`/Users/xutaoyu/.codex/visualizations/2026/09/18/01a0b4d8-6cf5-7e03-98b9-2b1ca5bde1d5/proma-project-connections-preview.html`。用户于 2026-09-20 确认；生产界面不包含预览的样例数量、尺寸和主题控制条。

## 1. 连接信息与本地过滤

- [x] 先在 `server-ops-connections.test.ts` 增加结构化地址/说明、三类连接过滤、大小写与空白、搜索和类型交集、无匹配、输入数组不变的 BDD 测试，运行并确认缺少行为导致失败。
- [x] 在 `server-ops-connections.ts` 给展示模型追加可选 `endpoint` / `metadata`（真实构建均提供，旧调用可回退 detail）；保留现有 detail 和所有身份字段。导出纯过滤方法：

```ts
export function filterServerOpsConnections(
  connections: readonly ServerOpsConnection[],
  kind: ServerOpsConnectionKind | 'all',
  query: string,
): ServerOpsConnection[]
```

过滤满足 `(kind === 'all' || connection.kind === kind)` 且规范化查询命中名称/地址/说明；不查询服务器、不更改连接选择。

- [x] 运行 `bun test src/renderer/components/server-ops/server-ops-connections.test.ts`，要求全绿。

## 2. 真实视图与状态

- [x] 更新 `ServerOpsProjectView.test.tsx`，先验证旧版不满足统一卡片/筛选/空态；保留三类连接点击、菜单独立性与明文标记回归。
- [x] `ServerOpsProjectView.tsx` 继续为纯视图，追加受控 `filterKind` / `searchQuery` 与变更回调。工具栏显示项目名、连接总数和添加菜单；筛选为全部/服务器/数据库/Redis，保留零计数，搜索无结果与类别为空分别提供清除/添加。整卡点击与右上菜单为平级按钮。
- [x] 视图使用直接生成的 endpoint / metadata 展示地址和说明，保留已知 SSH 连接状态与内网明文标记，不推测数据库状态。
- [x] `ServerOpsWorkspace.tsx` 增加 Pane 独立的筛选 Jotai atom，projectId 变化时同步显示默认条件并清空旧条件；返回连接原流程和移动授权身份逻辑保持一致。
- [x] `globals.css` 添加只命中项目卡片的容器查询：内容区域 `<560px` 一列、`560–849px` 两列、`≥850px` 三列；窄面板搜索换行。卡片不因数量少跨多列铺满。

## 3. 集成与复核

- [x] `bun test --isolate src/renderer/components/server-ops`：分类计数、过滤、空态和已有运维回归通过。
- [x] `bun run typecheck`（Electron 及全仓，已有失败单独记录）；`bun run build:renderer`；`git diff --check`。
- [x] 对真实组件执行隔离本地 GUI 回归，使用 `.omx/qa/project-management-ui.tsx` 的内存示例，与之前被阻止的 HTML 文件浏览无关。验证筛选/搜索/空态/项目重置、菜单与明文标记、三类跳转/添加、移动后计数和授权保留、320/460/720/1024 深浅主题及鼠标命中。不访问真实数据库或修改真实项目。
- [x] 请求独立只读审查本轮模型、视图、状态和样式，修正具体问题后复验。
- [x] 更新本计划结果与 MEMORY；不提交、发布或重启客户端，不改无关 WIP。

## 影响与资源

只改变项目清单呈现；服务器能力、MySQL/Redis 内部工作台、后端持久化、凭据与授权合同不变。每次搜索在当前项目数组上 O(n) 扫描，布局由浏览器 CSS 处理；不订阅高频窗口尺寸事件、不轮询连接、不新增长期缓存。

## 验证结果

2026-09-20 完成：

- 测试先行：模型缺少过滤方法时失败，视图旧分组版为 4 pass / 5 fail；无障碍修复新增两条测试先失败后通过。
- `bun test --isolate src/renderer/components/server-ops`：317 pass、0 fail，27 文件、1401 次断言。
- Electron `bun run typecheck`：通过；全仓 `bun run typecheck` 中 Electron/Core/Session Core/CLI/UI/Mobile 通过，Shared 仍有既有的 `canvas-media-model-scope.test.ts:46,68` readonly capabilities 类型不兼容，未改动该无关测试。
- `bun run build:renderer`：通过，保留既有的大 chunk 警告；`git diff --check`：通过。仓库没有独立 lint 脚本。
- `.omx/qa/project-cards-ui-check.cjs`：真实 React 工作区在内存 fixture 中通过搜索/分类交集、固定计数、无结果恢复、零类别添加、切项目清空、返回保留、SSH/MySQL/Redis 导航与添加表单、移动后统计；320/460/720/1024 深浅主题分别为 1/1/2/3 列，长名称/地址无内部横向溢出，两个结果不撑满宽面板，点击均校验真实命中。
- `.omx/qa/connection-move-ui-check.cjs`：跨 Pane 移动保留 Agent 授权、显式切换才撤权，三类移动、凭据标记/跳板字段保留、失败重试、焦点和宽窄布局通过。
- `.omx/qa/project-management-ui-check.cjs`：项目增删改、删除保护、错误恢复、菜单/弹窗 Escape、三类新增归属与深浅布局通过。
- 已查看真实组件深浅截图：`/private/tmp/proma-project-cards-dark.png`、`/private/tmp/proma-project-cards-light.png`。验收未连接真实服务器/数据库，未改用户配置。
- 独立审查提出的同名卡片无障碍上下文、零结果播报、长名称悬停已修复并复核通过。操作按钮使用类型/地址区分同名连接、描述包含已连接/内网明文；结果状态节点持续挂载。无新依赖、IPC、轮询或持久化字段。
