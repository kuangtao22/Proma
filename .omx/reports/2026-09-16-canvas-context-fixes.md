# 画布摘要、活动身份与媒体来源修复验收

日期：2026-09-16。分支：`codex/canvas-delivery-lifecycle`。承接用户确认后的源码修复；未提交、推送、发布或更新安装客户端。

## 结论与修复范围

1. `AgentCanvasOrchestrationCard` 移除覆盖 `line-clamp-1` 的 `block`，使用真正单行目标摘要，保留完整 title 与可展开内容；标题同时展示取消、阻塞等实际委托状态。真实组件长目标高度为 20px。
2. 活动画布失配根因是 `CanvasWorkspaceAdapter.markAgentCanvasActive` 调用 `linkAgentCanvas(makeDefault:false)`：真实 Store 对已关联画布返回 no-op，不更新 `lastActiveCanvasId`。新增独立 mark-active 四层 IPC 合同，复用绑定文件的 fresh snapshot、safe-file 与 CAS；保持默认画布和关联顺序，只允许已关联且未归档的同项目画布、普通顶层会话及合法发送方。
3. SidePanel 以当前焦点更新活动身份，关闭或切换后丢弃旧请求错误提示。聊天发送前从 Jotai 读取当前会话/分屏焦点，等待主进程回执确认目标；等待期间切换或回执被替代，最多核对三轮，失败保留草稿、附件及节点引用。IPC 对同项目、会话使用唯一在途请求令牌，旧异步授权晚回只返回当前绑定，不覆盖或额外广播；最新请求结束释放令牌。
4. 媒体连接诊断显式返回 `literal` / `canvas-output` 来源；工作台说明固定素材不跟随图关系，保持合法固定素材运行及真实节点输入缺边门禁。默认制作 Skill 升至 1.0.39，要求核对当前画布、实际素材哈希和工作流，再决定是否修复关系或生成；补连线可复用已有素材。

## 关联业务与资源影响

- 关联、解除关联、设置默认仍沿用原合同。主进程入口复用现有注册模块，preload/index.ts 与 main/ipc.ts 通过既有模块装配获得新增能力，无需复制 handler。
- 重复标记相同活动身份不写盘、不广播。纯 `active-changed` 不刷新协作卡关联列表，20 次事件的回归从额外 20 次读取降为 0 次；关联集合真正变化仍刷新。
- 不增加依赖、轮询、素材扫描、媒体读取或后台模型任务。新请求令牌仅保留在途记录；发送焦点核对有界。
- 独立审查发现旧请求错误会显示到新画布，已通过 effect 清理及关闭侧栏前置修复，复核确认覆盖原路径。

## 验证证据

- 15 个相关测试文件：454 pass、0 fail、2075 assertions，日志 `/private/tmp/proma-canvas-context-final-tests.log`。覆盖 shared 合同、真实绑定 Store、IPC 权限与乱序、preload/adapter、发送焦点与回执、SidePanel、协作卡/控制器/决策、媒体连接与工作台、工具 Provider 和默认 Skill。
- 新行为红绿证据：原 Store 无 mark-active API；发送同步错误回执曾直接放行，新增反例失败后修复；20 次纯焦点事件曾产生 21 次列表读取，修复后保持首次 1 次；媒体固定来源断言先失败再通过。摘要原 CSS 冲突反例见上一份调查报告。
- `bun run typecheck`：7 workspace 全通过，日志 `/private/tmp/proma-canvas-context-typecheck.log`。
- main、preload、renderer 隔离构建通过，产物 `/private/tmp/proma-canvas-context-build/`；对应日志为 `/private/tmp/proma-canvas-context-{main,preload,renderer}-build.log`。Renderer 保留既有大分块警告，未新增运行依赖。仓库未配置独立 lint 命令，`git diff --check` 通过。
- 隔离 Electron 43 + 真实 React 组件/CSS：长目标 20px、取消状态、多画布 owner 隔离、完整影响说明、发送失败重试、防重复、草稿保留、事件合并、错误恢复、长内容边界、深浅主题、会话释放均通过，Renderer 错误为 0。脚本 `/private/tmp/proma-canvas-context-feedback-smoke.cjs`，日志 `/private/tmp/proma-canvas-context-feedback-smoke.log`，截图 `.omx/qa/artifacts/canvas-chat-long-goal.png`、`canvas-chat-feedback-light.png`、`canvas-chat-feedback-dark.png`。

## 验证边界

隔离测试使用测试业务数据、发送与模型替身，不证明真实模型制作或视频质量。未修改用户真实画布、迁移已有不一致连线、运行媒体或重新生成视频。发送前同步用于修复当前可见身份失配，不实现消息运行全过程的画布快照锁定。现有客户端需加载完整新构建后生效；默认 Skill 更新需通过既有播种机制加载，旧运行上下文不会自动重写。
