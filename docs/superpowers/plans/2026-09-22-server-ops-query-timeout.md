# 运维数据库查询超时保护

**目标：** 单表与联表查询共用执行保护，超时后释放本次连接，不自动重放耗时请求；只读数据库权限保持原边界。

**检查结论：** MySQL SQL 已设置十秒服务端时限，但在元数据预检之后；表预览没有对应服务端保护。SQLite 已有远端进程硬截止、VM 预算和两秒锁等待，但查询上限为十五秒。界面与 Agent 已共用同源串行、全局三路和五秒排队等待上限。

**方案：** MySQL 在表预览或 SQL 元数据读取前设置会话级十秒执行上限及两秒元数据锁等待；不支持保护的版本或设置失败须停止业务查询。SQLite 查询和行预览统一十秒封顶，保留更短的测试预算及既有 VM 预算。MySQL 建连、查询和收尾沿用十五秒 runtime 截止，主进程另有一秒兜底；SQLite 查询远端十秒截止、本地另留一秒收尾，超时释放独占通道。工作台 SQL 最多返回二百行与 32 KiB，Agent SQL/行工具最多五十行，不自动重试。MySQL 十秒限制针对单条 SELECT，两秒元数据锁等待针对每次锁获取，均不能代替整次请求截止。服务端终止采用引擎可用的中断点，不能承诺对所有数据库负载提供绝对保障。

**影响与性能：** 复用现有调度和取消链路，不引入依赖，不添加第二条控制连接或额外查询重试。MySQL 每次表预览增加版本识别和一次合并 SET，用少量往返换取服务端限时；本次只修改独占会话变量，不修改数据库全局配置。人工工作台与 Agent 走相同保护。

## 实施

- [x] 测试先证明 SQL 预检前未设上限、表预览未设上限、锁等待错误分类和超限预算缺口。
- [x] MySQL SQL/行预览复用限时配置，设置失败不发业务查询；维持参数绑定与原结果语义。
- [x] SQLite 查询/行预览封顶十秒，实测预算中止、子进程退出、锁等待有界和再次查询可用。
- [x] 界面与 Agent 工具说明明确保护值，错误提示建议缩小范围或优化条件，不自动重试。
- [x] 相关 BDD、类型检查、隔离 Electron 构建与临时 MySQL 慢查询/锁等待验证。
- [x] 回写 MEMORY、记录证据；不连接真实库、不提交发布、不重启运行中的客户端。

## 验证证据

- 红绿验证：新增用例先得到 38 pass / 4 fail，修复后 MySQL 定向 82 pass / 0 fail。日志：`/private/tmp/proma-query-timeout-red.log`、`/private/tmp/proma-query-timeout-mysql.log`。
- 运维相关回归：`bun test --isolate` 覆盖 utility、主进程运维、renderer 运维、Agent 读取工具、共享 SQL parser 和查询合同，**1270 pass / 0 fail / 5944 expect，90 文件**。日志：`/private/tmp/proma-query-timeout-regression.log`。
- 收尾改动后再次执行 MySQL 预览与 SQLite runtime：**29 pass / 0 fail / 108 expect**。SQLite 的实际 Python payload 验证 SQL/行预览均为 10000 ms，probe 保留 15000 ms；高耗联表先触发 VM 预算，不能把该用例当作等待十秒的墙钟实测。独占锁实测约 2.13 秒，退出及后续 probe 均通过。日志：`/private/tmp/proma-query-timeout-final-targeted.log`。
- 构建：主进程、Agent runtime、运维 runtime、renderer 均输出到 `/private/tmp/proma-query-timeout-build/`，未覆盖运行客户端产物。运维 runtime 已在最终等值模板改动后重建；主进程存在既有 CJS `import.meta` 警告，renderer 存在既有 chunk 体积警告。
- 类型检查：首次发现两处新增测试夹具缺失 address/port，补齐后 `bun run typecheck` 全仓七个工作区均退出 0。日志：`/private/tmp/proma-query-timeout-typecheck-final.log`。`git diff --check` 通过；仓库未配置独立 lint 命令。
- 独立复审：确认服务端限制早于业务/元数据查询、安装失败停止读取、取消和连接释放保留；未发现确定性缺陷。

### 临时 MySQL + Electron 实测

在全新临时 datadir 启动 MySQL 9.6.0，仅 Unix socket、关闭网络、32 MiB buffer pool、最多八连接；测试读取账号仅有 SELECT 权限。使用 Electron 43.2 / Node 24.18 执行生产 `runServerOpsDataRead` 的隔离 bundle，未访问用户数据库。

| 场景 | 结果 |
| --- | --- |
| 正常单表、联表 | 各返回三行，连接释放 |
| 高耗三表联查 | 10041 ms 返回超时；服务端 `Max_execution_time_exceeded` 计数增加 |
| SQL 元数据锁等待 | 2024 ms 返回超时 |
| 表预览元数据锁等待 | 2038 ms 返回超时 |
| 超时后新查询 | 成功返回，连接释放 |

每项结束后检查 `SHOW PROCESSLIST`，均无测试读取账号残留连接。临时 MySQL 已通过其专属 Unix socket 正常关闭，mysqld 与 shutdown 命令均退出 0。脚本与结果：`/private/tmp/proma-query-timeout.T183zJ/verify.mjs`、`/private/tmp/proma-query-timeout.T183zJ/verify.log`。

## 兼容与边界

- MySQL 5.7.8 之前与 MariaDB 10.1.1 之前无法满足受控查询超时，行预览现在也会拒绝，避免悄悄退回仅客户端断连。
- MySQL 5.7 与 MariaDB 仅经过版本/语法合同测试，本轮真实引擎只实测 MySQL 9.6.0；SQLite 使用本地临时库运行生产 Python 脚本。
- 现有 SQL parser 禁止注释，补充优化器 hint 回归，确保不能通过 `MAX_EXECUTION_TIME` hint 延长会话上限。
- 十秒执行预算、同源串行和全局三路并发共同降低资源风险；限时不等于 CPU/内存硬配额，服务端中断仍可能存在检查点延迟。
- 初次实现验收未重启客户端；用户随后明确要求构建重启，已完成下述开发实例更新。

## 客户端构建与重启

2026-09-22 按用户要求在当前工作区执行完整 Electron 构建。主进程、三个 runtime、preload、renderer、CLI 均成功；原生 Swift 编译首次因沙箱不能写入系统模块缓存而失败，改用 `/private/tmp/proma-query-timeout-module-cache` 后原生组件构建通过，并完成资源复制。所有产物完整，五个后台 bundle 的源码新鲜度检查通过。

`server-ops-reader` 开发实例已重启，复用本地 5174 前端服务；旧进程正常关闭窗口和停止监听后仍驻留，结束残留进程后以受管进程启动新实例（验证时 PID 94220）。实际界面显示 Proma 主窗口、项目列表与输入框，IPC 注册完成，无过期 bundle 告警。未修改或访问用户数据库；安装版继续运行。已有 LAN Bridge 端口占用及历史 Canvas 恢复日志不属于本次查询保护改动。

构建日志：`/private/tmp/proma-query-timeout-client-build.log`、`/private/tmp/proma-query-timeout-client-native-build.log`；新客户端日志：`/private/tmp/proma-query-timeout-client-restart.log`。
