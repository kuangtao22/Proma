# Canvas Agent 能力补齐与稳定性实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通 Agent 在用户授权范围内完成任务查看、取消、重试、候选检查、精确版本采用、原工作流续跑、导出和节点恢复，并消除长期使用的容量阻断，验证真实 Electron 多图交互。

**Architecture:** UI 与 Agent 复用唯一主进程业务服务，分别验证各自调用身份；写操作沿用 Canvas 串行器、workspace 写守卫、revision 和幂等记录。持久续跑整合现有 ComfyUI 分支的 CanvasWorkflowRun；事务与运行历史按活跃状态和终态分别保存，保留可恢复性及操作去重证据。

**Tech Stack:** Bun、TypeScript、Electron、Pi Agent Runtime、TypeBox、Jotai、XYFlow、JSON/JSONL、现有 stable-directory native helper；不计划新增依赖或数据库。

---

## 规划状态与范围

- 用户已通过“开始吧”授权本地实现与验证；付费供应商调用、覆盖已安装应用和公开发布仍不在本轮操作范围。未勾选项目保留实际验收缺口。
- 已完成的审批等待修复、候选图片预览、采用恢复、50ms 事件合批和 Graph 对象复用作为回归基线，不重新实现。
- 业务闭环：生成 -> 查询任务 -> 检查候选 -> 明确采用 -> 继续原工作流 -> 导出。取消、失败重试、节点恢复和进程重启是同一闭环的异常路径。
- 本轮已基于 `/Users/xutaoyu/CodeSource/GPL/Proma-git/.worktrees/comfyui-media` 的持久合同整合 Store 与 execute/resume/cancel/get/list，保留该媒体 worktree 原文件；主目录整合使用本轮实现与独立差异审查结果，避免另建第二份 WorkflowRun。
- 视频、音频和 ComfyUI 供应商接入继续由既有媒体计划交付。本计划要求与其任务/版本/续跑合同兼容，不把尚未整合的媒体功能标为已支持。

## 顺序与交付

### 执行进度（2026-09-07）

- 实施目录：`/Users/xutaoyu/CodeSource/GPL/Proma-git/.worktrees/canvas-agent-completion`，分支 `codex/canvas-agent-completion`，基线 `feed23c4dd6512cae0680dddd60d2f1276f38df2`。
- 主目录已有 Windows 版本/打包修复和先前 Canvas/runtime 修改；本轮隔离实施，保留主目录与 `comfyui-media` 的所有权边界。
- 阶段 0 至 4 的主要入口、持久合同与权限回归已实现。新增独立审查修复：归档异常锁外 publication、重建归档后重放、超过 100 条历史图片分页/精确采用、工作流 owner 命名空间及恢复后的输出漂移保护。
- 阶段 5 已完成最多 16 项、一次目录选择的批量导出、跨进程原子 claim 和持久导出 receipt；整批候选采用复用 `all/succeeded` 合同，单个精确版本走 `canvas_adopt_version`。不提供任意子集原子采用。
- 阶段 6 已完成隔离 Electron 验证：正常尺寸本地 PNG、1000/3000 节点分别交互、12 路更新及五轮卸载。1000 节点 p95 9.5ms，3000 节点 p95 9.1ms，均无超过 100ms 停顿；CDP GC 后 heap、DOM 和监听器释放断言通过。最终主目录整合回归与构建见下方验证记录。
- 隔离 Electron 不等于用户安装版实跑，生产 App bootstrap、真实渠道付费联调与跨平台安装验收需分别记录，不能以单测或 Renderer fixture 代替。

| 阶段 | 优先级 | 独立交付结果 | 依赖 |
| --- | --- | --- | --- |
| 0. 统一合同与实施基线 | P0 | 当前缺口、并行分支边界、Agent 权限和操作身份固定 | 无 |
| 1. 容量治理 | P0 | 已完成事务及运行历史不再占满活动容量，历史幂等仍可查询 | 0 |
| 2. 任务查看与控制 | P0 | Agent 按准确任务查看、取消、原快照重试 | 0；发布前完成 1 |
| 3. 版本采用 | P0 | 图片、文档、WebView 历史可发现、可检查、可明确采用 | 1、2 |
| 4. 原工作流续跑 | P0 | 整合持久状态，只运行未完成且输入仍有效的下游 | 1、3、媒体分支合同整合 |
| 5. 导出与恢复 | P1 | 授权导出、回收区恢复、坏 Agent 节点重建 | 0、1、3 |
| 6. 大画布性能与最终交付 | P0 验收 | 完整 Electron 下验证多图、历史任务及节点规模，形成可核对构建产物 | 1 至 5 |

阶段 1 与 2 可以按文件所有权并行；阶段 4 只能有一个持久化实现负责人。每阶段先写行为测试、验证失败，再实现并跑相关回归；提交需仅包含该阶段拥有的变更，中文提交说明。

## 阶段 0：统一合同与实施基线

**Files:**

- 修改入口：[canvas-tool-provider.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-tool-provider.ts)、[canvas-tool-access-facade.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-tool-access-facade.ts)、[canvas-agent-run-policy.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-agent-run-policy.ts)。
- 生产装配：[ipc.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/ipc.ts)、[canvas-document-ipc.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-document-ipc.ts)。
- 合同与桥接：[canvas.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/packages/shared/src/types/canvas.ts)、[design-preload.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/preload/design-preload.ts)。

- [x] 对照主目录与媒体 worktree 的实际文件，给每个缺口标明“需新增入口 / 已有实现待整合 / 验收未完成”。记录实施时的基线提交及已有未提交文件。
- [x] 将重复出现在 UI handler 与 Agent 中的业务步骤提取到对应领域服务；身份认证仍在入口执行。仅在确有重复时新增服务文件，不改造成通用命令总线。
- [x] 写模式合同测试：普通 Agent 可按意图执行；手动画布 Agent 限定自身画布；父编排子 Agent 保留查询/内容工作，付费重试、采用和工作流调度由父运行管理；plan 模式禁止新增的执行动作。
- [x] 固定所有写入口使用 host 派生的 operation ID、项目/画布/节点身份和当前运行代次。响应丢失后的同一操作返回原结果；新的明确重试产生新尝试。执行前重新验证绑定与权限。
- [x] 公共结果使用稳定错误码、有界摘要与必要 revision；任务、版本、回收项和运行均先有发现入口，再提供操作入口，避免要求模型猜 ID。

**验收：** UI 与 Agent 对同一目标产生一致业务结果；跨项目、被解绑、过期运行和 plan 调用均在副作用前拒绝。Automation/Collaboration 的非交互模式维持既有上限。

**影响：** 避免同一操作经两个入口出现不同状态；增加的身份检查以既有 Store 和内存查询为主，不增加轮询。

## 阶段 1：事务与运行历史容量治理

**Files:**

- 原生边界：[stable-directory-native-host.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/stable-directory-native-host.ts)、[stable-directory-helper.cc](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/native/stable-directory/stable-directory-helper.cc)。
- 调整读取/恢复方：[canvas-agent-node-creation.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-agent-node-creation.ts)、[canvas-agent-batch-operation.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-agent-batch-operation.ts)、[canvas-content-node-lifecycle.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts)、[canvas-image-candidate-batch-store.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.ts)。
- 拟新增归档服务及测试：`/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-transaction-archive.ts`、同目录 `canvas-transaction-archive.test.ts`。
- 整合媒体分支：[canvas-workflow-run-store.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/.worktrees/comfyui-media/apps/electron/src/main/lib/design/canvas-workflow-run-store.ts) 及其测试。

- [x] 分别测试两个上限：外层 transactions 的 512 个可识别普通事务文件，以及 workflow-runs 自身的 512 条列表限制。workflow-runs 子目录不能被误算为 512 个外层事务。
- [x] 建立每类事务的归档条件。只有恢复完成、无未决资源清理且已保存必要业务事实的记录可离开活动区；不能仅以状态字符串等于 committed 判断安全。
- [x] 采用受管、可分片的终态归档，保留 operation ID 到原结果的定位，以及 Agent 最新归属、删除 tombstone、采用结果等仍被读取方使用的证据。读取方改为活动记录加必要索引，历史详情按 ID 或游标读取。
- [x] 先持久写入并验证归档和必要索引，再从活动区移除原记录；在共享串行器和写守卫内推进，保留可重复的崩溃恢复状态。原生 helper 的固定目录、no-follow、目录身份及 Windows reparse 校验覆盖新路径。
- [x] 旧数据在 LOAD 恢复后或新增事务的容量预检中分批归档；每批有固定条数和字节上限。不清除尚待采用的候选，不删除图片/正文/任务历史，不通过单纯调高 512 掩盖累积问题。
- [x] 运行历史保持既有独立 `workflow-runs` JSON 目录，解除 512 条历史列表阻断，保留精确 run/operation 读取。分页以目录迭代和 owner/cursor 过滤仅保留 `limit + 1` 个候选，不新增第二套终态存储；按需列表仍为 O(历史条数) I/O，常驻完整 run 为 O(limit)。
- [x] 测试 511/512/513 边界、2000 条混合终态、归档各步骤崩溃、重复归档、历史操作重放、损坏文件及目录替换。真实 native 回归确认：512 时同名覆盖可读回、513 新增被拒绝、归档 64 条后可继续新增，最终 active 为 449。Windows 专用目录替换场景仍需在对应平台实跑。

**验收：** 历史总量超过 512 仍能创建和恢复新事务；旧操作重放不会重复建节点、采用、重试或提交付费任务；不能因归档让既有 Agent 节点变成损坏状态。

**影响：** 消除长期使用后的硬阻断；增加一次性的旧数据整理和少量终态写入，减少日常恢复扫描量。该阶段跨多个生命周期，必须独立审查及跨平台测试。

## 阶段 2：任务详情、取消与原快照重试

**Files:**

- 扩展：[design-job-manager.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/design-job-manager.ts)、[design-trace-store.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/design-trace-store.ts)、[canvas-image-candidate-batch-service.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.ts)。
- 工具与生产装配：阶段 0 的 Provider、权限策略、Canvas IPC 和主 IPC；对应 `.test.ts` 同步修改。

- [x] 新增 `canvas_get_task`、`canvas_cancel_task`、`canvas_retry_task` 三个独立入口，分别表达只读、停止和可能付费的重试。共享 task 引用至少绑定 canvasId/nodeId/jobId；内部 imageModuleId 由权威节点解析。
- [x] 详情返回状态、尝试链、实际模型、已记录最终提示词、执行摘要和可用日志。日志按需分页，默认不读取完整 trace；最多 50 条摘要、单响应不超过 64 KiB，并提供截断/后续游标。
- [x] 取消复用 JobManager.cancel；已终结任务返回实际终态。运行停止与远端确认取消分开报告，不能把本地停止当成供应商必然未执行或不收费。
- [x] 重试复用既有候选批次 retryJobLocked 和原任务快照，保留原模型、提示词与引用版本；同 operation 幂等返回 replacementJobId。原引用缺失、原模型不可用时明确失败，不能悄悄换用当前配置。
- [x] 详情尝试链使用现有目标索引派生并核验归属，避免每次查询都扫描整个项目；完整日志增加流式或有界读取，不先读取全部文件再截断返回。
- [x] 覆盖取消与完成竞态、取消两次、批次混合结果、单图旧批次兼容、重试响应丢失、节点删除/移动后调用、跨项目 jobId、真实模型快照未变化。

**验收：** 用户说“查看这张图失败原因”“停止这个任务”“按原配置重试”，Agent 可以找到目标并完成操作；重复投递不会多开任务。

**影响：** 常见失败可直接在对话中处理；只读详情保持低开销，付费重试仍经过现有授权与预算边界。

## 阶段 3：图片、文档与 WebView 版本采用

**Files:**

- 复用：[canvas-artifact-registry.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-artifact-registry.ts)、[canvas-text-artifact-service.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-text-artifact-service.ts)、[canvas-image-candidate-batch-service.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.ts)。
- 扩展：Provider、Canvas IPC、shared canvas 合同与对应测试。

- [x] 增加 `canvas_list_versions` 和 `canvas_adopt_version`；列表按节点分页，返回可供后续工具使用的精确版本引用、当前采用状态与配置/正文 revision。文本历史需可读精确正文；图片复用已完成的候选预览。
- [x] 图片采用由 nodeId/jobId 验证成功任务和素材来源，再调用既有采用事务；不接受模型随意提交磁盘路径或修改 adoptedAssetId。
- [x] 文档/WebView 采用同时校验当前图 revision、正文 revision 和目标历史版本，沿用原服务的历史保留及依赖传播规则。
- [x] 整批选择沿用 `all/succeeded` 合同并在预检通过后进入可恢复采用事务；单项用精确版本采用，不支持任意子集的原子批量采用。
- [x] 采用需要当前用户意图；单纯看图不会修改正式版本。结果返回新版本及受影响下游，默认只标记可继续，是否执行交给原工作流续跑合同。
- [x] 覆盖已删除候选、旧版本失效、CAS 冲突、部分写入后崩溃、重复采用、后续对账失败仍锁外发布已提交事件。

**验收：** Agent 可检查候选后采用指定版本；并发编辑不被覆盖；重开画布可恢复采用，已成功部分不会被误报成从未发生。

**影响：** 用户无需手动搬运候选和版本号；复用既有事务，额外成本限于有界读取及必要版本提交。

## 阶段 4：整合原工作流持久续跑

**Files:**

- 整合来源：[canvas-workflow-run.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/.worktrees/comfyui-media/packages/shared/src/types/canvas-workflow-run.ts)、[canvas-workflow-run-store.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/.worktrees/comfyui-media/apps/electron/src/main/lib/design/canvas-workflow-run-store.ts)、[canvas-workflow-execution-service.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/.worktrees/comfyui-media/apps/electron/src/main/lib/design/canvas-workflow-execution-service.ts)。
- 主目录相关：[canvas-workflow-graph.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-workflow-graph.ts)、[canvas-agent-execution-service.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-agent-execution-service.ts)、[canvas-image-run-service.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-image-run-service.ts)、[NativeCanvasWorkspace.tsx](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx)。
- 测试包含媒体分支已有 `canvas-workflow-execution-persistence.test.ts` 与 workflow-run Store 测试；生产接线同时检查 shared -> main -> preload -> renderer。

- [x] 核对并整合已有持久合同及依赖，不用主目录旧执行器覆盖媒体分支的新状态机。保留稳定 run/operation ID、节点输入输出指纹、执行记录、剩余预算、owner 和 revision CAS。
- [x] 补齐 Agent 的工作流列表、详情、继续和取消入口，以及 UI 对应恢复/等待采用状态。启动结果明确返回 run ID，所有入口消费同一运行事实。
- [x] 默认采用后只变为可继续；用户此前已授权“采用后继续”时才允许事件驱动续跑。续跑复核当前绑定、配置和输入版本，只推进未完成且满足正式输入的节点。
- [x] 内容或执行关系变化导致需重规划；纯布局/视口变化不使运行失效。已完成节点不自动重跑；被改动的已完成结果需新的明确执行意图。
- [x] 采用事件、UI 继续与 Agent 同时触发时由跨进程 owner/CAS 只接受一次推进。进程崩溃后先对账原 Job/MediaRun，提交状态未知时不能新建等价付费请求。
- [x] 停止后保留已生成产物；迟到采用事件不能复活取消运行。重试生成计入原预算，重新下载不计作新生成；预算耗尽或权限撤销阻止后继启动。
- [ ] 覆盖 A 完成、B 待采用、C 未运行的重启续跑；重复事件和多窗口竞争；父 Agent 中断；原输入变更；旧候选迟到；跨项目/会话访问；图片及媒体两条执行分支。

**验收：** 上述 A/B/C 场景中，采用 B 后仅启动 C；重启或重复点击不会重新生成 A/B。与 ComfyUI 共用唯一工作流记录。

**影响：** 避免从头重做与重复计费；持久写发生在关键状态迁移，不随每条进度或日志写整个运行文件。

## 阶段 5：导出、回收恢复与坏节点重建

**Files:**

- 复用：[canvas-document-ipc.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-document-ipc.ts)、[canvas-text-artifact-service.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-text-artifact-service.ts)、[design-asset-service.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/design-asset-service.ts)、[canvas-content-node-lifecycle.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts)、[canvas-agent-node-creation.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-agent-node-creation.ts)。
- 扩展：Provider、主 IPC 装配、按需要扩展 shared/preload/UI 目标选择合同及各模块测试。

- [x] 增加 `canvas_export_artifact`。导出精确产物版本；项目内使用已有授权写目录，项目外复用主进程选择器产生的目标授权。批量导出复用一次目录选择；覆盖已存在文件需要明确意图。
- [x] 导出返回成功文件清单及失败项；不可用版本不改导为当前版本。后台任务无交互窗口时返回可恢复的目标选择需求，不能启动不可见且永久等待的文件对话框。
- [x] 增加 `canvas_list_trash`、`canvas_restore_node`，允许 Agent 发现回收项、识别原节点及恢复位置，复用已有 trash 身份与 content lifecycle。
- [x] 增加 `canvas_rebuild_agent`，仅对已诊断异常且当前不忙的目标调用 rebuildReconciled；原/新 session ID 由主进程确定，不允许模型直接换绑。
- [x] 覆盖同名文件、路径穿越、符号链接/目录替换、导出取消、旧版本缺失、回收项过期、ID 冲突、正在运行的 Agent、重建中崩溃与重复请求。

**验收：** 用户可在原对话完成导出和恢复；目标文件内容匹配所选版本，正常节点与其他画布不受影响。

**影响：** 复用用户已有操作路径；媒体复制只在导出时发生，大文件采用现有流式能力，有界并发，避免阻塞主进程。

## 阶段 6：性能回归与实际交付

**Files:**

- 核查：[NativeCanvasWorkspace.tsx](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx)、[NativeCanvasGraph.tsx](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx)、[use-canvas-image-module.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/renderer/components/design/use-canvas-image-module.ts)、[design-job-manager.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/design-job-manager.ts)。
- 性能基线：[native-canvas-performance.test.tsx](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx) 及 Workspace/hook 测试。
- 能力说明：[canvas-node-capability-registry.ts](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/src/main/lib/design/canvas-node-capability-registry.ts)、[canvas-production/SKILL.md](/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/default-skills/canvas-production/SKILL.md)。

- [x] 保留已通过的确定性指标：100 条突发通知在慢读取期间合并为首次读取加一次补读；1000 节点的单状态变化仅替换一个节点；未变化边复用数组；后台错误保留现有内容及草稿。
- [ ] 在完整 Electron 加载 1000 节点、12 个并发任务更新、真实本地缩略图及至少 5000 条历史 Job，采集主进程扫盘次数、renderer 长任务、帧间隔及内存。增加 3000 节点压力场景以暴露规模边界。
- [x] 优先复用 JobManager 已有节点索引，用按 Canvas 的有界快照/增量事件更新当前图；定义重连、项目切换、进程间写入和事件缺口时的重同步，禁止只用缓存导致状态陈旧。
- [ ] 对实测热点分别处理缩略图按需解码、不可见节点卸载和重复投影；不因节点多就默认上全新渲染引擎。宽/窄窗口、浅/深色均验证拖动、框选、缩放与工作台切换。
- [ ] 在记录硬件和刷新率的测试机上，以热态交互 p95 帧间隔不超过 33ms 为验收目标；任何超过 100ms 的交互停顿需定位。连续五轮生成/切换/关闭后，监听器和媒体授权返回基线，内存不持续增长。
- [x] 更新三类 Agent 的可发现能力与默认 Skill，并递增 Skill patch 版本；描述与实际允许的工具一致，明确待采用、可继续、完成和取消状态。
- [ ] 使用受控本地执行器跑完整闭环及崩溃恢复，不产生供应商费用；真实渠道联调使用执行时已明确的模型、项目和预算，未完成则明确保留验证缺口。
- [x] 完成类型检查、相关隔离测试、完整构建及 macOS arm64 本地产物冒烟，记录基线、版本、产物哈希及包内运行时版本。安装替换、真实打包应用的 GUI 验收和其它平台实跑仍未执行；正式发布不在本轮范围。

**验收：** 从原对话完成一次生成、查看、采用、续跑、导出，以及一次取消/失败重试/重启恢复；产物版本准确，已完成节点没有重复调用。不能只凭单测通过宣称用户安装包已经更新。

## 验证命令与停止条件

每阶段在仓库根运行相关测试；新测试先得到对应行为缺失的失败，再实现。

```bash
bun test --isolate apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/design/canvas-tool-access-facade.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts
bun test --isolate apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts apps/electron/src/main/lib/design/canvas-text-artifact-service.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts
bun test --isolate apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-agent-batch-operation.test.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts
bun test --isolate apps/electron/src/main/lib/stable-directory-native-host.test.ts apps/electron/scripts/build-stable-directory-native.test.ts
bun test --isolate apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/use-canvas-image-module.test.ts
bun run typecheck
bun run electron:build
git diff --check
```

归档服务新增后运行其独立测试；工作流分支整合后运行 workflow-run Store、execution、execution-persistence 与 shared 合同测试。每条命令需退出码 0，测试无失败；跨平台 helper 需要 macOS/Linux/Windows 对应环境证据，单个平台构建不能替代全部平台验证。

完成判定按五项分别记录：代码实现、自动化回归、完整 Electron 验收、真实渠道联调、目标安装包交付。任一未完成必须明确列出，不能使用“全部修好”覆盖这些差异。

## 主目录交付记录（2026-09-07）

- 已将本轮实现整合回主目录，保留原有数据根 lazy 初始化、Windows 发布脚本、版本和锁文件改动。整合验证时尚未提交 Git，未发布，未覆盖已安装应用；后续提交以 Git 历史为准。
- 整合前逐文件核对主目录/base/worktree，独立审查确认重叠的 Canvas 改动均已包含；机械同步 75 个文件后验证 86 个代码/测试/Skill 文件与实施目录一致。整合前后备份与 SHA-256 manifest 位于 `/private/tmp/proma-canvas-completion-integration-1788713757368`。
- 构建时主目录版本为既有 `0.19.31-bone.7`，本轮未另行递增发布版本；下面产物是包含当时尚未提交 Canvas 改动的本地验证包，不等于此前同版本产物或正式发布。

| 验证项 | 实际结果 | 证据 |
| --- | --- | --- |
| Canvas、Renderer、shared/preload、Pi、队列、Automation、项目指令及 bootstrap 回归 | 101 文件，1905 pass，0 fail，6942 assertions | `/private/tmp/proma-canvas-integrated-tests.log` |
| 原生 helper/Host、真实 511/512/513 容量与归档恢复、默认 Skill | 71 pass，6 Windows 专用测试跳过，0 fail | `/private/tmp/proma-canvas-integrated-native.log` |
| 全仓类型检查 | 7 个 workspace 均退出 0 | `/private/tmp/proma-canvas-integrated-typecheck.log` |
| 主目录完整 Electron 构建 | 退出 0，包含 main、各 utility、preload、Renderer、CLI、原生 helper | `/private/tmp/proma-canvas-integrated-build.log` |
| 隔离 Electron 1000 节点交互 | p95 9.5ms，最大 24.9ms，超过 100ms 停顿 0 | `/private/tmp/proma-canvas-completion-qa-1788713012375/report.json` |
| 隔离 Electron 3000 节点交互 | 独立重复同一操作，p95 9.1ms，最大 10.3ms，超过 100ms 停顿 0 | 同上 |
| 五轮挂载/关闭资源检查 | CDP 强制 GC 后 heap、DOM 回落和监听器释放断言通过，runtimeErrors 0 | 同上 |
| macOS arm64 本地产物 | Electron 43.3.0，应用版本 0.19.31-bone.7，未签名，无发布 | `/private/tmp/proma-canvas-package.log` |
| 产物内原生和运行时依赖 | 实际打包 Electron 可运行 Sharp PNG 编解码、PTY 创建/退出、Pi ESM 加载；关键 Canvas 工具与 Skill 1.0.10 存在 | `/private/tmp/proma-canvas-package-smoke.json` |
| 源码生产 bootstrap 的隔离窗口检查 | 已观察真实欢迎窗口、572 个 preload API 和成功的 getSystemTheme IPC；完整自动化未通过，详见下文 | `/private/tmp/proma-bootstrap-smoke-CQKaxN/report.json`、`/private/tmp/proma-bootstrap-smoke-MsR7Lu/report.json` |

性能测试机：Apple M3 Pro、arm64、12 逻辑核、18 GiB，估算 120Hz；交互测试使用 Electron 43.2.0 和真实 Workspace/Jotai/XYFlow、本地 320x200 PNG。5000 条真实 Job journal 的首次扫盘及增量索引验证来自独立 JobManager 测试；Renderer fixture 只接收有界摘要，不把 fixture 计数当作生产扫盘证据。上述性能测试没有覆盖生产应用内同时加载完整 5000 条业务历史的单次端到端场景。

源码 bootstrap 检查使用 Electron 43.2.0 defaultApp 加载最终 main/preload/Renderer，并把 os.homedir、appData 和 userData 定位到随机临时目录，HOME 环境变量不变，对真实 `.proma` 与定位文件的审计访问为 0。首次运行观察到真实欢迎窗口并调用 IPC，但临时 runner 把预期 userData 写成 `@proma/electron`，而源码与实际均为 `@proma/electron-dev`，因此原始报告 `passed=false`。仅修正该预期后的复测在 Playwright launch 的 120 秒握手阶段超时，尚未进入窗口断言；进程和 5174 端口已释放。两份原始报告均保留失败状态，不以人工裁定报告代替完整通过结果，也不将源码窗口检查称为 Electron 43.3 打包应用的 GUI 实跑。

本地验证包：`/private/tmp/proma-canvas-completion-package/Proma-0.19.31-bone.7-canvas-completion-local-arm64.zip`。

- ZIP SHA-256：`dadafcb78e5c3071f44148907fcb0d9424a8eaf5235211a0d4c35687b9cfe273`
- app.asar SHA-256：`497d6095313d1a39680ab73efbef0a0e7ea4d4b6de9bcf7ae81152f841982e81`
- main.cjs SHA-256：`652dd5431460709d51d25cb146a5aca95b44cf1c52848b3584bce26cd2ce1c0d`，与主目录构建一致。
- stable-directory helper SHA-256：`011c884bb4b12df7f9b935f86f39d677de546f6e2b1d21ef92348bcbc5bb308b`，与主目录构建一致。

仍需单独验收：真实模型/渠道与预算下的供应商调用、生产业务画布完整闭环及媒体授权释放、Windows/Linux 本轮原生变更、安装替换后的使用结果。视频、音频及 ComfyUI 供应商仍由媒体计划交付；本轮不宣称这些尚未整合入口可由 Agent 使用。工作流历史查询仍按需遍历 JSON 目录，仅保证分页内存有界，未引入新的历史索引。
