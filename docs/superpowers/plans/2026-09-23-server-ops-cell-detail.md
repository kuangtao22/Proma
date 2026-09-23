# 运维表数据单元格详情

用户要求点击被截断的表格内容查看全文、复制，并在 JSON 格式化与原文之间切换。

## 方案与影响

- 保留每格 256 字的轻量表预览。只有文本被裁剪或清理控制字符时，携带完整原文 SHA-256；点击才发起单字段只读查询。
- 详情使用当前表、已应用筛选、排序和绝对行位置；只有全文摘要一致才展示。无主键换序、内容变化或删除时提示刷新，避免同前缀不同正文误认；不保存整页原文或行身份缓存。
- SQLite 本机/SSH 与 MySQL 均复用已有读取限制、来源身份复核、敏感列规则、超时与资源回收。MySQL 继续数据库端有界投影，全文只按需传输。摘要带来必要数据库计算，网络与应用内存仍有界。
- 单字段正文最多 1 MiB（UTF-8），超限明确报错，不把部分内容称作全文。详情只保留当前弹窗内存；切目标、换页、刷新、关闭后迟到结果失效。
- 预览正文继续限制 1 MiB，最多 200×64 个定长摘要单独计入总共 2 MiB 的行回执预算，保持既有宽表分页能力；不能让摘要挤掉页内行或放宽正文。
- JSON 格式化只调整空白，不改数字、重复键和字符串转义；原文独立保留，复制当前显示内容。复用既有弹窗、只读编辑器与主题，无新依赖。
- 本轮覆盖截图中的表数据浏览，不扩展任意 SQL 查询结果的再执行语义；Agent 工具不新增全文入口，数据库始终只读。

## 实施与验证

1. 先补公开合同与边界 BDD 测试，再贯通 shared / main / preload / runtime。
2. 并行完成 runtime 按需读取与 renderer 详情交互，保持文件所有权分离。
3. 回归长 JSON、控制字符、大整数、无效 JSON、NULL/空串、二进制、遮罩、同前缀不同尾部、筛选分页、超限与迟到回执。
4. 定向测试、全仓类型检查、合成 SQLite 真实运行时与 GUI 冒烟；确认运行中的 dev 已加载新产物。

## 验证记录

- shared / main / preload / IPC / Agent Facade / 调度器回归：259 项通过。日志 `/private/tmp/proma-cell-contract-main.log`。
- 远端 SQLite 固定 Python 脚本：23 项通过，含原文换行、emoji、300 KiB NUL 转义、同前缀不同尾部、敏感列、超限以及 200×64 宽表预算。日志 `/private/tmp/proma-cell-remote-final.log`。
- protocol 与本地 SQLite：24 项通过；MySQL / Redis runtime 42 项通过，其中 2 项真实 TCP 回环在沙箱外补验通过。
- 真实 Electron 主进程 → utility → SQLite 子进程：完整原文、摘要拒绝、参数化筛选、遮罩、写拒绝、真实取消后复用及原库字节不变通过。使用隔离临时库，日志 `/private/tmp/proma-cell-electron-smoke.log`。
- dev 的 main / preload / 三个 runtime 已重新构建，Electron 开发实例随 main bundle 自动重启；安装版未替换。
- 最终 renderer 定向回归：5 文件 51 项通过，覆盖真实连接视图静态渲染、浏览控制器、详情弹窗、JSON 格式化与只读编辑器。日志 `/private/tmp/proma-cell-renderer-final-tests.log`。
- 7 个 workspace 类型检查通过；Electron 在补齐 SQLite/MySQL 工作台实际入口并将详情回调设为必填后，再次独立检查通过。日志 `/private/tmp/proma-cell-electron-final-typecheck.log`。
- 真实 Electron GUI（合成 API、生产组件与正式 CSS）通过：从 `ServerOpsDataConnectionView → ServerOpsDatabaseWorkbench` 选表点击单元格；SQLite 420px 深色验证原文、原生剪贴板精确复制、复制失败提示和 Escape；MySQL 1280px 浅色在展开工作台后验证 JSON 格式化、精确复制、弹窗层级和 Escape。两场景均无页面横向溢出，截图已经人工目视核验。临时服务器已停止，系统剪贴板已恢复并核对格式列表。
- GUI 证据：`/private/tmp/proma-cell-detail-narrow-dark.png`、`/private/tmp/proma-cell-detail-wide-light.png`；验收命令 `bun run /private/tmp/proma-cell-detail-ui-smoke/runner.ts` 退出码 0。
- 运行中的 Vite 5174 已实际返回含 SQLite/MySQL 单元格详情回调的新工作台模块；dev 后台新鲜度检查及最终 `git diff --check` 通过。
