# 画布默认入口与修改定位验收

日期：2026-09-16。用户已确认实施；本轮源码完成，未提交、发布或替换安装版。

## 用户行为

- 去除画布列表默认星标与设置菜单。手动入口恢复当前聊天有效的最近关联画布，无目标显示列表/空状态，不静默选第一图或创建画布。
- 普通聊天首次成功修改自动打开实际画布，选中并居中受影响节点；单节点打开原详情，多节点展示合并摘要及逐节点入口。
- 同轮后续修改合并到摘要。后台聊天与可信委托只更新所属聊天摘要；失败、只读、进度和生成受理不触发内容修改导航。
- 草稿、手动切页/平移/缩放、撤销关联、运行切换和迟到结果不会被导航覆盖。显式查看也复验授权；同次点击关闭旧详情不应被误判为用户切走。

## 模块及兼容

- `canvas-workspace-actions`、`SidePanel`、`CanvasWorkspaceSidebar`、`CanvasWorkspaceAdapter`：清理默认 UI 与无用回调，保留旧主进程字段/API，已有持久标签及主动关闭规则继续沿用。
- `canvas-tool-initial-context`、`canvas-document-ipc`：在真实运行准备阶段固定隐式上下文，多图引用不猜选；失效后取消隐式目标。显式写工具仍逐次经过权限合同。
- shared `canvas-tool-navigation`、Provider、编排/操作工具：统一成功写入回执，区分图 revision 和模块正文版本；批次采用按真实 `adoption.adoptedNodeIds` 返回目标，内部重试保留外层 tool call 来源。
- `agent-canvas-change-navigation`、全局 Agent listener、`AgentCanvasChangeNotice`、`AgentView`：匹配工具 start/result、会话/运行/项目/授权，合并并去重，委托归属由 Host 复验；移除仅覆盖两种创建工具的旧消费者。
- `agent-canvas-atoms`、`NativeCanvasWorkspace`、`native-canvas-navigation`：等待权威 LOAD 和表面尺寸，再按真实节点几何消费一次定位；分屏保留其它 Pane，手势取消未完成定位。

没有新增依赖、IPC、轮询或媒体读取。摘要是进程内有界缓存（64 图、当前会话展示 8 图、每图至多 512 个节点），不是持久审计系统；超限回执不导航。业务历史继续使用原节点版本与运行记录。

## 验证证据

- 最终相关测试：`bun test --isolate`，15 文件，**556 pass / 0 fail / 2169 assertions**。日志 `/private/tmp/proma-canvas-navigation-final-tests.log`。
- 全仓 7 workspace 类型检查通过，最终修改后的 Electron 增量类型检查通过。日志 `/private/tmp/proma-canvas-navigation-final-typecheck.log`、`/private/tmp/proma-canvas-navigation-electron-final-typecheck.log`。
- 主进程与 Renderer 隔离构建成功，输出 `/private/tmp/proma-canvas-change-build`；Renderer 存在大 chunk 提示，未阻止构建。没有覆盖运行中的客户端 dist。
- 真实 Electron + React/Jotai/XYFlow 验证：首次打开、单节点详情、批量定位、后续不抢焦点、迟到 LOAD、草稿保护、深浅主题和 620px 窗口通过；业务保存 **0 次**。日志 `/private/tmp/proma-canvas-change-smoke.log`；截图 `/private/tmp/proma-canvas-change-dark.png`、`/private/tmp/proma-canvas-change-light.png`。
- 收尾 Electron 实测发现同一次“查看位置”点击会关闭原详情，使原焦点签名误拦截；已修复，并补充允许详情关闭与拒绝选区/视口变更的回归测试。
- 批次采用 fixture 全部按生产嵌套 adoption 形态修正，生产 IPC 测试同步断言回执节点。

验证使用隔离临时目录和内存画布，没有调用真实模型、收费生成或写入用户业务数据。窄视口详情继续遵循原世界坐标锚定/裁剪规则；未扩展为独立自适应详情布局。未进行安装包启动验证。
