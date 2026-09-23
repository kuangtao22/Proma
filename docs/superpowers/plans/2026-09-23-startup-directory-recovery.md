# 启动目录恢复实施与验收记录

## 已批准目标

缺失的受管目录自动补齐；根目录或 server-ops 的权限、同名文件和链接异常进入独立恢复窗口。窗口显示原因与路径，可重新检测、选择应用数据目录或退出。选择已有数据目录只切换读取位置；选择空目录必须明确确认启用全新数据区。旧数据保留，不把项目目录选择或重新定位描述为迁移。

## 实施边界

- 启动检查位于普通业务初始化之前，保持 migration 优先，不能自动创建离线的自定义数据根。
- 复用路径管理窗口与现有 IPC 通道；normal 迁移及 workspace relocation 不改变。
- 候选只接受可识别 Proma 根或严格空目录；只读预检，确认后复验目录身份、关键子目录和空目录状态，成功后原子切换 locator。
- 系统选择返回一次性授权；取消、新选择、其他窗口、路径替换不得复用旧确认。
- 开销为固定目录元数据检查、有界身份读取及一个目录项读取，无全盘扫描、新依赖或后台常驻任务。

## 验证清单

- [x] 启动：缺失目录自动补齐、再次启动保留配置、文件/链接/权限错误进入 recovery。
- [x] IPC：真实临时目录验证空目录确认、已有数据恢复、取消、伪造/过期授权、目录变化、旧数据和迁移意图保留。
- [x] UI/preload：原因和路径可见、明确数据影响、确认/取消及忙碌状态。
- [x] 相关 Bun 测试、全工作区类型检查、Electron 构建、隔离启动冒烟。

本任务不合并 main、不正式发布，不改用户当前安装版或真实业务数据。

## 本地证据

- 相关回归：229 pass / 0 fail，17 文件，647 断言（Bun --isolate）。
- 根 typecheck：shared、core、session-core、cli、ui、mobile、electron 全部通过。
- 真实 Electron 使用临时 home：首次/再次普通 IPC、文件冲突恢复专用 preload 与页面渲染、重新检测、空目录未确认拒绝、系统取消撤销旧选择、确认后 activeRoot/previousRoot 与旧文件原文均通过。
- POSIX 权限位场景在 Windows 明确跳过；不声称覆盖真实 Windows ACL 限制。
- `check:data-root` 仍报告既有的 `design-context-catalog.ts`、`design-paths.ts` 项目内 `.proma` 路径；两文件和扫描器均与任务基线无差异。本轮未扩大到 Design 路径修改。
- 日志位于 `/private/tmp/proma-directory-recovery-{tests,typecheck,smoke,contract}.log`；截图仅包含临时验收路径。

## 独立审查修复

- 面板取消通过既有恢复通道撤销选择授权，成功后才清草稿；迟到的旧取消不能撤销新选择。
- 选择身份在 marker 写前/原子提交前/写后、直接子目录创建前后及 locator 提交前持续复核；缺失子目录不再递归创建父路径。
- 新红测复现 3 个缺陷后转绿；增加 marker 前后及最终检查后目录替换测试，替换目录保持空白、原 locator 不变。
- 独立复审确认无剩余代码阻塞。目录保护沿用既有协作进程与校验点持续替换合同，不宣称抵御同用户恶意进程在系统调用间瞬时重绑，不引入新的原生目录事务或 locator 格式。

最终统一构建日志：`/private/tmp/proma-directory-recovery-final-full-build.log`（exit 0）；审查修复后真实 smoke 重新通过，包含面板取消撤销授权。原生 EventKit availability 警告与 Vite 大块提示为既有构建提示。
