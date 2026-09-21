# Agent 运维访问实施计划

状态：实现完成，自动化与隔离真实链路验收通过；真实 GUI 点击及外部模型自主选工具未验收。日期：2026-09-21。

目标：多会话短时只读授权、可取消有界读取队列、主进程强制的运维只读工具模式，以及常驻可管理的授权状态。保持已有 SQLite 支持与旧 SSH 审批语义。

## 实施与接口

1. 授权：主进程按 sessionId 保存最多 8 份 30 分钟租约，公开 expiresAt，使用单调时钟复核；API 为 getReadAccess(sessionId)、listReadAccesses()、getReadBinding(sessionId, key)、revokeLegacySession(sessionId)。每次保存生成新 revision，旧 SSH 授权与所有只读租约全局互斥。测试先覆盖隔离、期限、回拨、上限与事件。
2. 调度：DataService 所有只读方法接受 signal 与第三参 context（ownerSessionId、check）；每源串行、全局 3，等待每源 8/全局 24/每会话 8、5 秒超时，跨源轮转。修复审计 catch 先检查授权/取消。测试先覆盖真实 abort 拒绝、排队、公平与清理。
3. 运行：新增独立 AgentToolMode standard/server-ops-read，运行代次冻结模式。Orchestrator 将 runSignal 与 assertRunActive 注入只读 facade；Pi 工具注册与分派均执行精确 ops 白名单，禁用其他内置、MCP、旧 server_*；停止/切模式废弃旧代次。回归普通 Agent、恢复与后台触发。
4. 集成：Facade 全部读取合并工具与运行取消，绑定运行授权代次；IPC/preload 支持授权影响预览和旧 SSH 单独撤权，归档/删除主进程撤权。UI 事件驱动常驻状态、聊天模式、详情入口及 MySQL 范围校验。
5. 验证：定向测试、全仓类型检查、隔离构建与真实 Electron→SSH→SQLite 读取/取消/队列验证，独立规格和安全审查。记录 GUI/模型验证的实际边界；不操作用户真实服务器、不替换运行客户端。

## 所有权

- 授权子任务：shared server-ops-agent-read 合同、AccessStore、read-identity 及测试。
- 调度子任务：DataService、独立队列、query-audit 及测试。
- 运行子任务：shared agent 合同、session metadata、Orchestrator、Pi/runtime 工具边界及测试。
- 主任务：Facade、IPC/preload、renderer、整合、最终验证与记忆。

所有任务先分析再写回归测试，确认失败后实现。不同任务不覆盖他人文件；接口变化同步通知。无需新增依赖，不提交或发布。

## 验收记录

### 完成行为与代码入口

- `server-ops-agent-access-store.ts` 与共享 `server-ops-agent-read.ts`：最多 8 个会话各自持有固定 30 分钟的内存租约，墙钟与单调时钟共同控制期限。切换聊天保留只读权限；保存/缩权推进代次，旧运行必须结束后通过新消息使用新授权。归档、删除、到期及显式撤权由主进程处理。
- `server-ops-ipc.ts`、preload 与共享 `server-ops-agent-access-impact.ts`：旧 SSH 操作授权仍与所有只读授权互斥。授权前展示影响快照，提交时比较 token；失效预览不能静默撤销另一份授权。会话切换只撤销旧 SSH 操作权限。
- `agent-orchestrator.ts`、`agent-run-identity.ts`、`agent-run-tool-policy.ts` 与 Pi adapter/builtin tools：持久化的运维只读模式每轮冻结，只注册并允许分派 9 个指定 `ops_*` 工具。禁用普通 Shell、文件、浏览器、任意 MCP、委派与旧 `server_*` 工具，停止运行会取消本轮调用而不删除仍有效的会话租约；自动化、委派与内部会话不能借用。
- `server-ops-agent-read-facade.ts`、DataService、runtime client 与 utility：所有读取接通真实取消，排队、执行与返回处重验运行、授权及资源身份；撤权和用户取消保留准确的错误与审计原因。
- `server-ops-read-scheduler.ts`：每数据源串行、全局 3 个实际读取；每源/会话最多等待 8 个，全局 24 个，5 秒等待上限及跨源轮转。队列每 250 ms 复核跨实例配置变化，最多 24 个待处理请求；没有 Agent schema 缓存或自动 SQL 重放。改名、移动项目不改变安全身份，不取消读取。
- `server-ops-credential-store.ts` 与 `server-ops-agent-read-identity.ts`：密文版本参与绑定，跨实例在同一 credentialRef 下换凭据也会使旧授权失效；只撤销已检查的会话及代次，避免旧会话的过期绑定误撤其他会话刚确认的新身份。Facade 不解密凭据。
- `AgentOpsAccessControl.tsx`、`ServerOpsAgentReadAccess.tsx`、controller、共享摘要与导航 atom：聊天/详情直接展示目标、库表范围、能力和剩余时间；窄布局保留能力与期限，长目标可截断并进入编辑器查看。聊天管理入口精确打开本会话编辑器，不自动授予权限；未选实例/库的 MySQL 不能保存。

以上入口均位于 `apps/electron/src`，共享合同位于 `packages/shared/src/types`。已有 SQLite 实现仍通过同一四层合同：仅经 SSH 读取远端文件，要求远端 Python 3.11+ 及 sqlite3 标准库，不引入 Proma 本地数据库或新依赖。

### 最终自动验证

| 验证 | 最终结果 | 证据 |
| --- | --- | --- |
| 全仓 `bun test --isolate` | **7,382 pass / 6 平台 skip / 0 fail**，565 文件，28,536 断言 | `/private/tmp/proma-ops-access-full-tests.log` |
| `bun run typecheck` | 7 个工作区全部通过 | `/private/tmp/proma-ops-access-final-types.log` |
| 完整隔离 `bun run electron:build` | 主进程、Agent/terminal/server-ops runtime、preload、renderer、CLI 与原生辅助程序全部通过 | `/private/tmp/proma-ops-access-build.log` |
| 实际主进程 IPC 访问矩阵与生命周期 | 53 pass / 0 fail，包含归档撤权及模式切换先停止后保存 | `/private/tmp/proma-ops-access-ipc-matrix.log` |
| 独立最终复核 | APPROVE，无阻断项；凭据身份、跨会话撤权、摘要、导航及队列兼容性均已复核 | 本任务独立审查结果 |
| 静态检查 | `git diff --check` 通过，新增 TypeScript 无 `any`；仓库未配置独立 lint 命令 | 本任务执行输出 |

完整构建在 `/private/tmp/proma-sqlite-build` 的源码、资源与 Electron 副本中执行，Swift/Clang 缓存显式放在该目录。仅保留既有 EventKit availability 编译警告，不影响成功退出；未替换原工作区产物或正在运行的安装版应用。

### 真实 Electron → SSH → SQLite 验证

夹具 `/private/tmp/proma-sqlite-verification/agent-smoke.ts` 运行正式工具 execute → Facade → DataService → Electron utility → 回环 SSH → Python → 临时 SQLite。日志：`/private/tmp/proma-ops-access-real-smoke.log`。

- 最终 `ACCESS_AND_QUEUE_ASSERTIONS_PASS`，`findings: []`；24 次真实 SSH exec、4 次 TERM、46 条审计记录。
- 未授权、越库越表、伪造会话、缺少行/SQL 权限、写语句及多语句均被拒绝；行敏感值遮罩，审计不含 SQL 正文和行内容，数据库字节保持不变。
- 两个会话授权并存，切换保留授权；同数据源并行两次都排队成功，不再立即 BUSY。
- 10 次连续结构读取全部成功，**p50 83 ms / p95 121 ms**；撤权中断 **19 ms**，SSH exec 取消 **1 ms**。这些仅为回环 SSH 小样本延迟，不代表公网或生产库性能。
- 撤权/取消收到真实 TERM 并等待关闭确认，迟到数据不发布，后续同连接查询成功；文件身份改变后旧请求失效。

### 验证边界

真实链路使用合成库、临时配置、会话/主机注册夹具与 SDK defineTool 注册替身，未调用外部模型，未经过真实 UI 点击授权 IPC。审计/配置使用单进程无竞争事务适配；不能把该探针当成多实例文件锁或模型自主工具选择验证。IPC、组件、controller、模式注册及宿主分派由独立可执行测试覆盖。

GUI 自动化受当前浏览器控制授权不可用限制，未完成实际点击链路；未连接用户真实服务器、未授予真实资源新权限、未重启或替换安装版。受限模式也不等于对所有业务文本完全匿名化：已交给模型的历史内容不能通过撤权收回，授权界面已说明。
