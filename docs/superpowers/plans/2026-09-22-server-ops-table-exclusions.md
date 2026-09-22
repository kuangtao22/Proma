# 运维 Agent 表屏蔽与点选授权

**目标：** 按用户最终要求“只做禁用表，默认全部能查”，授权弹窗直接展示禁用表多选，沿用工作台当前库，不再重复添加数据库。

**最终设计：** 所选数据库默认开放结构、行预览及只读 SQL，使用 `tables: null` 与 `excludedTables`。界面只选择禁用表，移除旧白名单转换、行读取、SQL 与跨库实例诊断开关；未选择的库与连接不自动加入。新表默认可查，禁用同时覆盖目录、结构、行预览、SQL 与变更上下文。打开编辑器仅准备新规则草稿，保留已有明确禁用项；取消不改变原租约，保存才应用。后台继续读取旧合同，避免仅升级客户端就改变正在生效的权限。数据库写入不开放，仍只生成脚本或程序。

**影响与性能：** 只影响 Agent 运维读取授权，不改变人工数据库工作台。复用现有只读目录 IPC、缓存和队列，不增加依赖；只在展开选择器时读取表目录，搜索本地过滤，无后台轮询。存在屏蔽表时限制可能暴露全库信息的诊断入口。

## 直接多选禁用表（最新纠正）

- 红框入口直接为“选择禁用表”；展开后搜索并多选，选中即禁用，未选与新增表默认允许只读查询。
- 移除弹窗添加数据库的下拉与嵌套库卡片；只沿用当前 Pane 正在查看且配置身份匹配的连接选库，SQLite 固定 main，库名仅作静态说明。
- 当前库只加入已选连接的编辑草稿，保存前不改变生效授权；取消恢复原快照。其他库与其他连接的已保存范围及禁用项保留，其他连接的历史导航不自动新增授权库。
- 其他已授权数据库收进可展开管理区；无当前库且无已有范围时提示去工作台顶部选库。超过 20 库时明确提示并禁用保存，可移除旧范围，不能静默丢弃。
- 相关回归 512 pass / 0 fail，42 个文件，日志 `/private/tmp/proma-direct-exclusions-regression.log`；最终类型修正后 scope 定向测试 6 pass / 0 fail，日志 `/private/tmp/proma-direct-exclusions-scope-final.log`。
- 最终 7 个工作区类型检查全部通过，renderer 隔离构建成功（38.16 秒），仅保留既有大 chunk 提示；日志 `/private/tmp/proma-direct-exclusions-typecheck-final.log`、`/private/tmp/proma-direct-exclusions-build-final.log`。`git diff --check` 通过。
- 真实组件与合成 API 验证：当前 app 直接多选 users/tokens，保存后两表均禁止，orders 与 new_table 仍允许；已有 audit.private 与其他连接范围保留，其他连接历史库 visited_only 未加入。重开回显两项，取消临时解除禁用不触发保存；完成选择只读取一次表目录。
- 此轮仅 renderer 变更，由 5174 开发客户端热更新；前轮后台已完成构建重启。未保存用户实际授权，未访问真实数据库，临时 renderer 验证页面已清理。

## 默认查询规则验证（历史，弹窗选库已被直接多选替代）

- [x] 删除白名单转换流程和数据库分层开关，MySQL 选库与 SQLite main 均默认查询全部未禁用表。
- [x] 保留已有禁用项，验证打开/取消不保存、保存才改变旧范围，广播更新与会话切换不会串用授权。
- [x] 20 项定向测试通过；相关回归 519 pass / 0 fail，44 个文件，日志 `/private/tmp/proma-ops-default-query-regression.log`。
- [x] 7 个工作区类型检查及隔离 renderer 构建通过，日志 `/private/tmp/proma-ops-default-query-typecheck.log`、`/private/tmp/proma-ops-default-query-build.log`；保留既有大 chunk 提示。
- [x] 真实组件配合合成 API 验证：只选择 app 保存后，行预览与 SQL 均启用且禁用项为空；多选 audit_log/private_accounts 后搜索 users，选择不丢失，保存仅禁用所选两表；取消临时解除禁用不触发保存；新增 SQLite 默认 main 全表可查询。
- [x] GUI 完成选库、展开、多选与搜索共两次目录请求，搜索无额外请求；没有白名单切换、行读取、SQL 或实例诊断开关。
- [x] 未连接真实服务器/数据库或替换、重启运行客户端；新后台合同仍需完整构建并重启客户端生效。

## 首轮实施与验收（历史，分层与转换方案已被最终规则替代）

- [x] shared 合同与后台统一表判定：兼容旧白名单，严格验证排除集合，防大小写绕过，截断不能删减屏蔽语义。
- [x] 数据库选择器与禁止表多选：按需读取、加载/错误/重试/截断提示、已选项保留、键盘可用、最多 100 张屏蔽表。
- [x] 旧授权显示与显式转换：不自动扩权、不在读取失败时重置选择；新表默认不屏蔽的行为明确展示。
- [x] BDD 覆盖结构/行/SQL/上下文屏蔽及目录竞态；运行相关测试、全仓类型检查与隔离构建。
- [x] 使用合成连接验证 UI，多选/搜索/取消/保存/重开及旧范围保持；不连接真实数据库，不重启运行客户端。

## 首轮验证记录（历史）

- 相关回归 586 pass / 0 fail，47 个文件；日志 `/private/tmp/proma-ops-exclusions-regression.log`。
- 全仓 7 个工作区类型检查全部通过；日志 `/private/tmp/proma-ops-exclusions-typecheck.log`。
- 主进程、Agent/终端/运维运行时、preload 与 renderer 隔离构建通过；产物在 `/private/tmp/proma-ops-exclusions-build/`，日志 `/private/tmp/proma-ops-exclusions-backend-build.log`、`/private/tmp/proma-ops-exclusions-renderer-build.log`。仍有既有 CJS/import.meta 与大 chunk 提示，本轮未修改相关构建规则。
- 真实组件与合成 API 的 GUI 验证：数据库下拉选择 app，多选 audit_log/private_accounts；搜索不清除已选项；两次目录读取即可完成选库与选表，搜索无额外请求。保存合同为 `tables:null` 加两项 `excludedTables`，独立行/SQL 权限未扩大；实例诊断自动清除并禁用。
- 保存重开回显正常；模拟目录失败仍保留两项屏蔽；取消临时解除屏蔽后原范围恢复。旧 users 白名单普通打开不改变范围，显式转换后其它四张表仍被屏蔽。
- 独立复审发现旧白名单转换不可依赖缓存目录；已改为旧模式展开和转换点击时均强制刷新，并在异步完成时复核组件生命期及当前草稿。目录读取与保存之间仍可能新增表，排除模式对此按界面说明默认允许；不声称保留旧白名单对未来表的限制。
- 验证未访问真实服务器/数据库，未替换运行中客户端产物。IPC 沿用现有目录及授权通道，shared 解析经主进程/preload/renderer 全链路复用；新后台授权合同需更新构建并完整重启客户端生效。
