# 运维连接跨项目移动实施计划

**Goal:** 服务器、数据库和 Redis 均可从项目列表移动到其他项目，立即同步项目统计。

**Architecture:** 独立移动命令只更新归属与更新时间，保留稳定 ID、凭据、SSH 会话、跳板引用及既有 Agent 主机授权。Store 在共用配置事务中 fresh-read、验证目标项目及预期原项目，再原子提交；普通编辑继续拒绝改归属。前端使用真实回执合并共享 atoms，不依赖二次刷新。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Jotai、Radix。

## 交互与边界

- 每条连接行追加独立「…」菜单，包含「移动到项目」；点击菜单不进入连接。
- 弹窗显示连接名、当前项目和目标项目。目标只列其他项目；只有一个项目时说明需先添加项目。
- 确认时禁用重复提交，失败保留弹窗和所选目标；成功留在原项目，提示目标名称。
- 单独移动，不级联。SSH 数据源保留原跳板，界面说明移动不改变跳板关系；服务器移动不影响其关联数据源的归属。
- 对其他 Pane，已选连接移出当前项目后回到项目清单，不能悄悄显示另一台服务器。全局 SSH 会话继续保留。
- 移动回执更新全局资产，迟到列表读取不得覆盖它。过期表单携带原项目，后端拒绝覆盖另一窗口的新归属。
- 不访问真实数据库、不修改真实连接、不增加依赖或后台轮询、不提交已有 WIP。

## 统一合同

```ts
interface ServerOpsConnectionMoveInput {
  kind: 'ssh' | 'data'
  id: string
  fromProjectId: string
  targetProjectId: string
}
type ServerOpsConnectionMoveResult =
  | { kind: 'ssh'; host: ServerOpsHost }
  | { kind: 'data'; source: ServerOpsDataSource }
```

通道：`SERVER_OPS_PROJECT_CHANNELS.MOVE_CONNECTION`，方法：`moveServerOpsConnection`。输入输出均使用严格字段校验，输出禁止数据源凭据引用。

## 实施与验证

- [x] 后端：先补移动正常路径、错误目标、过期原项目、幂等、写入失败、保留秘密引用/跳板/同目录并发的 BDD 测试并确认失败；修改 shared 合同、两个 Store、data service、IPC 和 preload 四层。移动与项目删除使用同一事务，不连接网络。
  - 文件：`packages/shared/src/types/server-ops-connection-move.ts`、`server-ops-project.ts`、`index.ts`；`apps/electron/src/main/lib/server-ops/{server-ops-host-store,server-ops-data-source-store,server-ops-data-service,server-ops-ipc}.ts`；`apps/electron/src/preload/server-ops-project-preload.ts` 及相关测试。
  - 验证：`bun test packages/shared/src/types/server-ops-connection-move.test.ts`；在 `apps/electron` 运行对应 Store/service/IPC/preload 测试。
- [x] UI：先补三类入口独立性、空目标、失败重试、重复提交和过期回执测试；添加移动弹窗及 controller，在 `ServerOpsProjectView.tsx` 与 `ServerOpsWorkspace.tsx` 接线。恢复菜单焦点，采用已有 Portal 层级。
  - 文件：`apps/electron/src/renderer/components/server-ops/ServerOpsConnectionMoveDialog.tsx`、`server-ops-connection-move-controller.ts`、项目视图/工作区及测试。
  - 验证：在 `apps/electron` 运行相关 `bun test`；连接选择不命中时回项目清单的测试必须覆盖有其他连接的场景。
- [x] 集成：运行定向测试、`bun run typecheck`、main/preload/renderer 构建；隔离 Electron 带真实主窗口层级验证 SSH/MySQL/Redis 移动、项目统计、保留 ID、失败恢复、320/460/1024 深浅主题、菜单鼠标命中及 Escape。
- [x] 复核修改范围与关联业务，更新 MEMORY 的独立移动规则和验证结果。

## 性能与兼容性

每次移动只读取并原子写入对应 JSON 列表，复杂度 O(n)；不重建连接、不重加密凭据、不触发诊断。UI 复用全局连接模型和统计计算。项目目前是运维分组，Agent 授权实际按 sessionId + hostId 保留，不因归属变化扩大访问权限。

## 验证记录

- 运维 renderer、主机/数据源/项目 Store、data service、IPC、preload、shared 合同与装配回归：`451 pass / 0 fail`（37 个文件）。两个 Store 均覆盖同目录多实例读取旧归属、旧移动拒绝及分别移动不同连接不互相覆盖。
- 独立复核发现原授权绑定会把「被另一 Pane 移出项目」误当作显式离开并撤销授权，已修为按全局精确 SSH 选择保持身份，当前项目投影仍退回清单。回归覆盖移动保留授权，显式导航/删除继续撤销；未改变权限 Store 或授权范围。修正后独立复审通过，无剩余发现。
- `apps/electron` 的 `bun run typecheck` 通过。全仓 `bun run typecheck` 仅共享包既有 `canvas-media-model-scope.test.ts:46,68` 的 readonly capabilities 测试类型问题未通过，本轮未修改该文件。
- `build:main`、`build:preload`、`build:renderer` 通过；保留既有 CJS `import.meta` 与 bundle 大小提示。
- 隔离 GUI 脚本 `.omx/qa/connection-move-ui-check.cjs` 使用真实 Workspace、临时配置、内存示例和生产 CSS：验证三类菜单/移动、原项目停留、两边统计、ID/密码标记/跳板保留、失败重试、关闭焦点、真实鼠标命中及 320/460/1024 深浅布局；扩展验证已授权主机被其他 Pane 移动后回项目清单但不撤权，显式进入数据库后才撤销旧授权。已检查截图，无横向溢出；不代表访问或移动过用户真实连接。
- GUI 截图：`/private/tmp/proma-connection-move-light.png`、`/private/tmp/proma-connection-move-dark.png`。
- 已重建主进程与 preload，运行中的旧客户端须重启加载新增 IPC；本轮未重启用户客户端、未提交 Git。
