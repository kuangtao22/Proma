# 数据库 SQL 工作台排版优化

用户截图要求优化当前数据库 SQL 查询页，已授权直接修改。

## 设计与影响

- 工作台范围与选库器合并在紧凑工具栏，下方使用轻量功能页签；仍明确区分实例与当前数据库，不让选库控制全局指标。
- 编辑器改为全宽卡片：顶部名称与只读标记，正文多行输入，底部统一执行、取消、快捷键与行数控件。
- 详细限制通过「查询说明」按需查看，结果区域独立展示标题、当前执行状态或真实快照，避免无意义空白。
- 编辑器高度有上限，窄屏动作自动换行、短窗口可滚动，结果表仍可独立滚动。
- 复用 Proma 主题、Radix 及现有控制器；不新增请求、依赖、查询权限或持久化，不改变取消与切库语义。

## 验证

- [x] 运维前端相关测试及 Electron 类型检查。
- [x] 隔离 renderer 构建与真实组件 GUI：选库/范围、帮助、快捷键、结果快照、取消重试、宽窄深浅与短窗口。
- [x] 独立复审、MEMORY 和实际效果截图。

## 已有证据

- 运维 renderer 34 个文件共 345 项测试通过，日志 `/private/tmp/proma-sql-layout-tests.log`；包括 SQL 控制器取消/切库/迟到结果、导航范围和独立选库器兼容性。
- Electron 类型检查通过，日志 `/private/tmp/proma-sql-layout-typecheck.log`。
- 最终 renderer 隔离构建通过，产物 `/private/tmp/proma-sql-layout-build.1ElubY/final-renderer`，日志 `/private/tmp/proma-sql-layout-final-build.log`；保留既有大 chunk 提示。页签已显式清除基础组件 padding，使下划线贴合分隔线。
- 真实组件 GUI 通过：紧凑导航、Popover 正文/Escape、Cmd+Enter、失败与取消重试、切库 ACK 等待、空结果列头、长警告；320/460/1024 深浅主题及 1024×360 短窗口滚动到结果。脚本 `.omx/qa/database-sql-ui-check.cjs`。
- 主线目视复核空态、成功结果和 320px 窄屏，无横向溢出或控件遮挡；截图 `/private/tmp/proma-db-sql-dark-1024-idle.png`、`/private/tmp/proma-db-sql-dark-1024-success.png`、`/private/tmp/proma-db-sql-light-320.png`。
- GUI 使用当前源码打包的内存 fixture；初次/最终 CSS 唯一差异是移除未使用的 `.pt-0` 规则，测试样式与最终产物等效。未访问真实连接、覆盖运行中的 dist 或重启客户端。
- 独立只读复审通过，范围边界、查询取消与切库语义、Popover 层级、短窗口滚动未发现新增缺陷；查询页卸载时取消在途查询，保留既有生命周期设计。
- 布局决策已写入 `MEMORY.md`；可查看的效果截图已保存至 `/Users/xutaoyu/.codex/visualizations/2026/09/18/01a0b4d8-6cf5-7e03-98b9-2b1ca5bde1d5/proma-sql-layout-idle-20260920.png` 和同目录的 `proma-sql-layout-results-20260920.png`，均使用示例数据。
