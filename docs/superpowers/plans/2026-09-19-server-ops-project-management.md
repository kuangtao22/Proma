# 运维项目管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 运维项目抽屉支持添加、重命名、删除，新增项目能实际承接服务器、MySQL 与 Redis 连接。

**Architecture:** 复用现有项目四层 IPC 和 JSON 原子存储；抽屉仅增加项目级操作，表单与删除确认沿用 Radix Dialog。项目列表控制器统一管理操作状态、错误和迟到回执；主进程在同一配置事务内验证项目归属及非空删除，新增连接携带创建时的项目 ID，编辑不开放跨项目迁移。

**Tech Stack:** Bun、TypeScript、React、Jotai、Radix、现有 server-ops 原子配置事务；不加依赖。

## 已确定的业务行为

- 添加入口位于项目抽屉标题旁；每行独立的更多菜单含重命名、删除，不嵌套 button，不误触项目切换。
- 名称 1–60 字符、去首尾空白，禁止控制字符与同名；空名称、重复名称、读取/保存失败显示可恢复中文错误。
- 新增成功后进入新项目，重命名保留项目 ID、连接与当前页；删除前确认名称，只删空项目，至少保留一个项目。主进程根据权威连接清单校验，不依赖界面统计保证安全。
- 新建服务器/数据库/Redis 归入创建表单打开时的项目；编辑继续保留原项目。不能让新建项目成为无法添加连接的空壳。
- 变更不自动连接远程服务器，不迁移已有连接、不删除真实数据库或服务器；本轮仅实现能力并用隔离数据验收。

## Task 1：后端合同、项目删除与新连接归属

**Files:** `packages/shared/src/types/server-ops.ts`、`server-ops-data.ts` 及测试；`apps/electron/src/main/lib/server-ops/server-ops-{project,host,data-source}-store.ts` 及测试；`apps/electron/src/main/ipc.ts` 装配；必要的现有服务/preload合同测试。

- [x] TDD 覆盖指定项目创建、项目不存在拒绝、编辑不可迁移、无 projectId 的旧调用兼容。
- [x] 保存输入增加可选 `projectId`（SSH 在 `input.host.projectId`，数据服务在 `input.projectId`）；在配置事务内确认目标仍存在。
- [x] TDD 覆盖非空项目删除被拒绝、空项目可删、最后项目受保护、超出 200 项限制可恢复拒绝。
- [x] 主进程项目删除 guard 与资源创建共用配置锁，避免检查后新增连接形成孤儿；删除不触碰凭据和连接生命周期。
- [x] 使用临时业务目录和模拟凭据执行 Store / Shared / IPC 合同回归，禁止真实配置写入。

## Task 2：项目列表和操作控制器

**Files:** `apps/electron/src/renderer/components/server-ops/server-ops-project-controller.ts` 及测试。

- [x] TDD 添加创建、重命名、删除、失败重试、防重复提交、卸载迟到、旧列表不能覆盖变更的测试。
- [x] 投影扩展 dialog/submitting/dialogError，接口扩展 openCreate/openRename/requestDelete/closeDialog/submit；保留现有 list API 的兼容。
- [x] 新名称走共享 parser；成功立即更新列表，失效旧读取，再按需权威重读；变更成功但后续读取失败不报成保存失败。
- [x] 使用 onCreated(project) / onDeleted(projectId, remainingProjects) 回调将导航交给工作区原有 transferLeave 守卫。

## Task 3：抽屉、弹窗与工作区接线

**Files:** `ServerOpsProjectDrawer.tsx` 及测试；新增 `ServerOpsProjectDialog.tsx` 及测试；`ServerOpsWorkspace.tsx`；`.omx/qa` 隔离 UI 验收夹具。

- [x] 抽屉增加添加按钮和项目行更多菜单，保持统计和项目切换；菜单 Escape 不关闭抽屉，Tab 不被父层焦点循环截获。
- [x] 新增/重命名表单自动聚焦名称，Enter 提交，处理中禁止重复操作；删除确认显示名称及阻止原因。
- [x] 用 Jotai 保存操作投影，复用现有 IPC，创建后/删除当前项目后正确更新选择，重命名当前连接不卸载。
- [x] 连接创建捕获表单打开时项目 ID；服务保存返回仍作为实际归属依据，移除旧的“新建只能归默认项目”提示。
- [x] 用实际 React 组件模拟 API 验证新增、重命名、重复名错误、取消/确认删除、默认/非空保护、菜单键盘和宽窄深浅布局。

## Task 4：验证和交付

- [x] 运行最小相关测试后，运维 renderer、shared/store/IPC 回归和 Electron typecheck。
- [x] 构建 main/preload/renderer，验证生产装配字段未丢失；不重启用户客户端或访问真实数据库。
- [x] 独立需求/质量复核后修复实际缺陷，更新 MEMORY 与本计划执行记录。
- [x] 保留现有 WIP；不自动提交、不改 README/发布说明。

## 执行记录

已完成项目管理与创建归属接线：抽屉标题提供添加入口，项目行菜单提供修改名称与删除；项目表单复用 Proma 的 Dialog 与主题，新增后进入项目，重命名不重建连接，只删除空项目并保留至少一个。初始项目列表未就绪时禁止创建，避免遗漏已有项目。

删除保护与连接创建共用配置事务；旧连接的默认归属迁移继续保留，数据源编辑先检查归属再操作凭据。多 Pane 的项目列表使用共享最新引用，旧读取不能覆盖其他 Pane 的写入。新数据连接使用保存回执直接进入列表，后续读取失败也不会隐藏已保存连接。

验证：运维 renderer 288 项通过，新增列表未就绪保护后抽屉 11 项通过（较全量多 1 项）；Shared / Store / Service / IPC / Preload / wiring 166 项通过。Electron 类型检查通过；main、preload、server-ops-runtime、renderer 构建通过。完整 Workspace 的隔离 Electron 验收覆盖添加、重命名、删除与取消、同名/写失败恢复、Enter、Escape、焦点恢复、SSH/MySQL/Redis 创建归属，以及 320/460/1024 深浅主题布局。未操作真实配置或网络。

全仓类型检查仍被既有 `packages/shared/src/types/canvas-media-model-scope.test.ts:46,68` 两处 readonly capabilities 错误阻挡，本轮未修改该文件。没有独立 lint 脚本，使用 tsc、定向测试、构建、diff-check 与独立复核。未提交 Git、未修改 README 或发布说明。

最终独立需求复核与质量复核均为 APPROVE，无剩余阻塞项；最后的 renderer 重建 exit 0，全部任务已完成。项目删除、归属、旧配置迁移与多 Pane 一致性约定已回写 MEMORY.md。
