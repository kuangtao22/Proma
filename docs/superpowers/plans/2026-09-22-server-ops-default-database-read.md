# 运维数据库默认只读与持久禁用表实施计划

**Goal:** 已配置 MySQL/SQLite 的未禁用业务表默认可供普通 Agent 查询，不再要求会话临时授权。

**Architecture:** 数据库禁用规则独立持久化，按连接和数据库精确匹配；SSH、Redis、日志保留原有会话授权。Facade 复用只读执行、审计和取消链路，每轮冻结策略代次与连接身份。目录只读本地配置，数据库目录按需获取。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Jotai、现有 JSON 原子写入与配置事务。

## 合同与边界

```ts
interface ServerOpsDatabaseAgentPolicy {
  revision: number
  exclusions: Array<{ sourceId: string; database: string; excludedTables: string[] }>
}
interface ServerOpsDatabaseAgentPolicyUpdate {
  expectedRevision: number
  exclusions: ServerOpsDatabaseAgentPolicy['exclusions']
}
```

- 空名单、新增业务表默认可读；只读 SQL、逐表联表检查、限时、遮罩和审计保留。
- 普通顶层用户会话可用，Automation/Delegation/External 不扩大权限。
- MySQL 系统库不向 Agent 开放，避免账号权限过大时暴露数据库内部凭据。
- 旧临时禁用名单不曾持久化，重启后无法自动恢复，面板应提示重新设置。
- 主文件损坏或已知文件丢失时拒绝读取，不能回退旧备份而放开后来禁用的表。
- 跨实例 fresh read + CAS 防止覆盖；不新增轮询、远程自动扫描或行数据缓存。

## 执行与验证

- [x] 持久 Store/shared 合同：先验证默认、重启、CAS、损坏与删除的失败测试，再实现配置锁和原子写；`bun test` 对应两个测试文件。
- [x] Facade/tools：先复现无租约读库失败，再覆盖空禁用成功、禁用拒绝、JOIN/组合工具、策略与身份变化、SSH/Redis隔离、系统库限制；不以展示目录作权限依据。
- [x] IPC/preload：校验可信窗口、完整策略合同与目标连接；保存采用 expectedRevision，广播公开策略。测试非法窗口、污染请求与响应。
- [x] Renderer：数据库持久规则与临时授权独立存储，按用户最新要求在服务卡片右上角提供“Agent 只读授权”，一个按需挂载的编辑器只显示目标连接，保留底部保存/取消；详情沿用当前 Pane 选库，首页使用连接默认库或展开区选库；保留其他连接/库规则，取消不生效，冲突要求刷新；无会话也可编辑持久规则。
- [x] 运行最小相关回归、工作区类型检查、隔离构建与合成界面验证；独立审查访问范围、异步取消及多实例限制。
- [x] 更新 MEMORY 用户纠正；最终说明验证结果和客户端加载状态。不包含用户已有 `.gitignore` 改动。

## 复审补充

- 默认开放限于业务基础表：MySQL 系统库、视图、SQLite 虚拟表及 MySQL 实例全局诊断不随默认只读开放。Agent 结构与行读取由主进程注入基础表限制，runtime 实时核验，普通工作台仍可浏览视图。
- 目录超过 500 张表时，选择器提供显式“搜索全部表”。MySQL 与 SQLite 均绑定搜索参数，搜索结果独立于普通目录缓存；清空搜索恢复原目录，已选禁用项不丢。粘贴搜索词的首尾空格统一去掉。
- 策略文件按缩进序列化后的完整字节数限制为 1 MiB，避免保存成功后读取超限；备份仅作已保存标记，不作为较宽松规则恢复来源。
- 同实例保存策略会取消旧读取；跨实例在每个异步边界及返回前重新读取 revision。未新增文件轮询，不能宣称其他实例的在途查询即时收到取消。

## 验证证据

- 相关回归：`bun test server-ops agent-session-visibility agent-prompt-builder pi-agent-tools pi-server-ops`，1,487 pass / 0 fail，126 个文件；日志 `/private/tmp/proma-default-database-final-tests.log`。
- 七个 workspace 的 `bun run typecheck` 通过；日志 `/private/tmp/proma-default-database-final-typecheck.log`。复审全部修改完成后 Electron 类型检查再次退出 0，日志 `/private/tmp/proma-default-database-typecheck-after-review.log`。SQLite 执行器的追加边界检查与目录控制器再次验证 25 pass / 0 fail，日志 `/private/tmp/proma-default-database-tests-after-review.log`。
- 六个 Electron bundle 与 renderer 隔离构建通过，产物在 `/private/tmp/proma-default-database-build/`；末次搜索输入修正另通过实际 Electron 合成界面验收，运维 runtime 与最终 renderer 已重新构建成功，后者日志 `/private/tmp/proma-default-database-renderer-after-review.log`。Vite 原有大 chunk 提示仍存在，本次未调整打包拆分。
- 合成界面测试覆盖无聊天会话入口、点选禁用、取消、保存后重开、搜索第 501 张表、带空格搜索词及读取失败禁止保存。860/390 宽、深浅主题无弹窗越界；日志 `/private/tmp/proma-default-policy-qa.log`，截图 `/private/tmp/proma-policy-{860,390}-{light,dark}.png`。
- 真实临时 SQLite 验证视图拒绝与大目录搜索；MySQL 使用协议和执行器夹具，本轮未访问用户真实数据库。独立复审发现的实例诊断和截断目录选择问题均已修复。
- 临时 renderer 测试入口已移出仓库；现有 `.gitignore` 修改保留。代码和产物尚未加载进当前开发客户端，未确认所有在途 Agent 已空闲，故未重启开发实例或替换安装版。

## 性能与兼容范围

默认目录只读取本地已保存连接，远端库表按需加载；没有增加全库自动扫描、轮询或行缓存。每轮会捕获数据库连接身份，超多连接时仍存在重复读取凭据版本元数据的本地 I/O 开销，后续可单独基准优化。旧临时禁用项重启后无法恢复，首次需重新勾选保存；旧版本客户端不认识持久策略，跨版本并行运行不能提供统一即时禁用保证。

## 单入口交互验收

用户明确要求保留原有授权交互，因此数据库禁用编辑嵌回原连接卡片弹窗，不再展示两个顶栏按钮。数据库卡片直接显示默认只读及禁用表多选；原 SSH/Redis 勾选、工具模式、保存与取消保持同一入口。移除独立禁用编辑控制器，复用统一草稿与保存状态。

保存先完成必要的旧 SSH 影响确认，再提交已修改的禁用名单与服务器授权。数据库单独变化不续服务器租约；显式保存服务器授权仍可续期。读取失败阻止空名单写入，写入失败保留草稿可重试；两部分非同一事务，界面必须反映部分成功及外部授权变更，不能静默关闭或自动覆盖。

实际 Electron 合成界面已验证一个入口、无会话禁用编辑、取消、重开、统一保存、两个接口的自身广播、服务器保存失败后的原样重试及禁用策略写入失败后不改勾选直接重试成功，860/390 宽及深浅主题无弹窗越界。最终结果 `passed: true`，策略写入 4 次、服务器写入 3 次；日志 `/private/tmp/proma-unified-access-qa.log`，截图 `/private/tmp/proma-unified-access-{860,390}-{light,dark}.png`。验证使用隔离 profile 与合成接口，未访问真实数据库。

最终 renderer 与 AgentOpsAccessControl 回归 493 pass / 0 fail（40 个文件），日志 `/private/tmp/proma-unified-access-final-tests.log`；七个 workspace 类型检查全部退出 0，日志 `/private/tmp/proma-unified-access-final-typecheck.log`。最终 renderer 隔离构建成功，日志 `/private/tmp/proma-unified-access-final-build.log`，产物 `/private/tmp/proma-unified-access-build/`；保留原有大 chunk 提示。独立复核已确认外部授权广播竞态、写入失败原样重试和影响范围不可用提示的问题全部关闭。本阶段不修改主进程与 preload，未重启当前客户端；默认数据库读取后端仍须加载此前构建才在运行实例生效。

## 后续卡片入口修正

用户进一步明确把项目顶部授权入口移到每张服务卡片右上角。入口与更多菜单并排，不触发卡片导航；只挂载一个目标连接编辑器，切项目、会话或连接失效后清除目标。详情仍可管理当前服务。保留其他连接完整权威草稿，只撤销当前连接；无变更保存不续服务器租约，实际修改仍遵循会话共享的 30 分钟期限。

首页没有工作台选库时仍显示“选择禁用表”。已有默认库直接使用，否则展开后先选库；数据库列表、表目录均显式按需读取。切库保留各库禁用项并隔离迟到结果；缺少持久策略桥接时禁止数据库保存，避免无写入假成功。

- 回归 501 pass / 0 fail（41 个文件），日志 `/private/tmp/proma-card-access-tests.log`；7 workspace 类型检查通过，日志 `/private/tmp/proma-card-access-typecheck.log`。
- 最终 renderer 隔离构建成功（39 秒），日志 `/private/tmp/proma-card-access-build.log`，产物 `/private/tmp/proma-card-access-build/`；保留原有大 chunk 提示。
- CUA 合成界面验证：首页零目录请求；点卡片只显示目标；无当前库展开选库、多选取消零写；保存禁用表不改服务器授权；SSH 原样保存零写，撤销后保留 Redis；切到另一数据库保存保留原库禁用项。最终策略写入 2 次、服务器写入 1 次、目录读取 6 次、卡片导航 0 次；测试夹具 `/private/tmp/proma-card-access-qa.tsx`。
- 真实开发实例已热更新，核验项目顶部无授权按钮、卡片右上角有授权图标，弹窗内显示禁用表入口及连接默认库；未保存用户授权、未读取真实库表。
- 独立复核已确认目标失效清理、首页不复用历史选库、缺桥接禁止保存、未修改不续租四项边界修正。
