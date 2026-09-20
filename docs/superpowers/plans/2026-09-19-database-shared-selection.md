# 数据库工作台公共选库与诊断范围

**目标：** 将数据库选择置于「数据浏览 / 运行诊断 / 实例参数」上方。数据浏览、会话和慢语句跟随选库；概览、全局参数和未接入的日志明确保持实例范围。

**方案：** 复用现有库目录与 schema controller，不维护第二份选择。诊断输入增加可选 `database`，仅 MySQL 会话与摘要支持。utility 使用独立 `diagnosticDatabase`，SQL 参数绑定且在 LIMIT 前筛选；慢语句按默认库归属，不推断跨库访问。Redis 与已有未指定库的调用保持兼容。

**影响与性能：** 切库只清理会话/慢语句结果并按当前页读取，实例页快照及在途请求继续有效；库身份加入请求去重键。无新增依赖、轮询、日志源或真实服务操作。保留独立表浏览组件的原入口，公共选库模式仅用于 MySQL 工作台。

## 步骤

- [x] 后端先补失败用例，再贯通 shared parser、preload/IPC、service、utility protocol 和绑定参数的查询；验证非法组合拒绝与旧调用兼容。
- [x] 渲染层先补失败用例，再实现公共选库、库范围提示、按库作废缓存与迟到回执隔离；验证参数页切库无额外诊断读取。
- [x] 定向回归、类型检查、受影响 bundle 构建与隔离 Electron 交互验证：选择器仅一处且在主页签上方，诊断页切库可用，宽窄布局无溢出。
- [x] 更新 MEMORY 中的范围约定，记录实际验证结果。不提交或覆盖无关工作树改动。

## 验收记录

- 后端定向 132 项：首次普通沙箱中 131 通过、1 项 localhost 监听受限；允许本地监听后 runtime 全部 28 项通过，覆盖该失败用例。没有访问用户内网或真实凭据。
- Renderer 完整回归 257 项通过；随后增加的暂停态提示与禁用刷新断言，连同另外 2 项诊断范围视图测试通过。
- Electron 类型检查通过；main、preload、server-ops-runtime 和 renderer 构建通过。已有 CJS/import.meta 与大 chunk 警告仍存在。
- GUI 使用真实组件、内存 API 和临时 userData，覆盖选库位置/唯一性、按库请求、实例参数不重读、库目录失败不扩大范围、恢复重试、同 ID 配置更新、分页/结构/索引/属性、目录焦点、320/460/720/1024px 与深浅主题。
- 独立审查找出的恢复范围扩张已先在 Electron 复现（无 database 的 statements 后才请求目标库），修正为先暂停页面、同步来源及选库，再激活；配置变化也暂停旧页。复审通过。
- GUI 夹具：`.omx/qa/database-workbench-ui.tsx`；完整鼠标/键盘验收脚本保存在 `.omx/qa/database-workbench-ui-check.cjs`，使用 esbuild 生成 `/private/tmp/proma-db-workbench-ui.js`、现有同名 HTML 与最新 renderer CSS 后，在 `apps/electron` 运行 `./node_modules/.bin/electron ../../.omx/qa/database-workbench-ui-check.cjs`。
- 原始日志没有新增来源；实例参数仍为全局变量，Redis 逻辑库语义保持不变。本轮不重启用户客户端、不提交代码。
