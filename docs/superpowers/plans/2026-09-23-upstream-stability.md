# 官方稳定性改进选择性移植实施与验收

**目标：** 按用户确认的第一批范围，适配官方 `1f8df675`、`d30c57d7`、`1b866c45` 和 `15c59296` 的有效能力，保留 Bone 已有功能与运行边界。

**架构：** 复用既有 AgentOrchestrator、Pi utility、Jotai 与原子配置持久化。删除采用先标记、再停止等待、最后清理；运行事件带现有 generation 身份；进度按当前运行聚合。模型目录仅增加 FlashX。

**技术栈：** Bun、TypeScript、Electron 43、Pi 0.85.1、React、Jotai。

**授权与范围：** 用户已确认上一轮选择性移植建议并要求开始。此次不整仓合并，不升级 Pi、不提高重试预算、不移除 OpenCode Go、不修改版本号、发布配置或运行中的客户端。开发在 `codex/upstream-stability-sept23` 隔离工作树进行。

## 设计判断

- 删除期间的运行身份和写入许可必须先失效，异步 preflight、旧 utility 回调与 JSONL 追加不能重新创建已删除会话。单会话与批量/工作区删除共用同一收尾边界，并保留运维撤权、Canvas/协作、权限提示和终端清理。
- runtime 启动重试仅适用于 Windows 同步 ENOTCONN，最多等待 25/100ms；取消、旧 port 和旧进程回执必须隔离。PiUtilityAdapter 必须保留 Bone 已有强制关闭及取消能力的合同。
- 任务 ID 从 toolCallId 开始保持稳定；实时消息的运行标记仅发给 renderer，不污染持久化正文。压缩后的 live turn 仍属于同一次运行，历史消息与旧运行不得混入；已有 runGeneration、Canvas 事件与重试提示保持兼容。
- 浏览器只补 per-session atom 清理，复用既有主进程 close；FlashX 只补候选、参数与展示，旧模型和默认选择不变，配置沿用原子写入。
- 性能：不增加常驻轮询、全库扫描或模型请求。删除等待有界收尾；任务计算只随相关消息变化，runtime 保留常数级代次状态；删除标记的进程内生命周期明确，不持久化额外数据库。

## 执行与文件所有权

- [x] 运行最小相关基线：5 个文件、114 项测试通过；全仓类型检查在实现完成后执行，不将其记作改动前基线。
- [x] runtime lane：完成 `agent-runtime-client.ts`、`terminal-runtime-client.ts`、`utility-process-startup.ts`、`adapters/pi-utility-adapter.ts`、`packages/shared/src/types/agent-provider.ts` 及测试，覆盖取消、迟到回执和异步 abort。
- [x] progress lane：完成 `adapters/pi-agent-adapter.ts`、renderer 的 `AgentMessages`、任务卡/浮层、`task-progress`、`useGlobalAgentListeners` 及测试，覆盖跨压缩/运行隔离、稳定 ID 和终态；普通运行与 headless 均携带权威 runGeneration。
- [x] catalog/browser lane：完成模型候选、参数与界面适配及浏览器会话状态清理，覆盖迁移幂等、自定义选择保留、删除失败与级联删除边界。
- [x] 主代理：完成会话存储、service、orchestrator、IPC 与工作区删除独占锁，覆盖真实临时 JSONL 不复活、异步 preflight 被删除、等待 abort 及停止失败。
- [x] 新增可执行行为回归并完成修复；删除与 runtime 竞态具备先失败、后通过证据，不引入依赖。
- [x] 独立审查关联链路、收尾/代次与副作用边界，修复四处可复现 runtime 竞态，复审无剩余发现。
- [x] 完成全仓 Bun 隔离测试、7 workspace 类型检查、完整 Electron 构建与最后 runtime 改动后的受影响产物重建。
- [x] 更新主工作区和隔离工作树的 MEMORY.md，记录决策、代码位置和真实客户端/跨平台验证边界。

## 验收合同

1. 删除后，迟到 SDK/用户消息不能重新创建会话 JSONL；预检未进入运行槽也不能继续启动。异步停止失败不得伪装删除成功。
2. 正常查询、普通停止、并行不同会话、软中断、utility 强制终止仍可用；旧 runtime 的回执不能发送到新 port。
3. 同运行的任务跨压缩继续显示，旧运行事件被拒绝；完成数不把取消/删除当成功，结束态不再展示旧 activeForm。
4. 删除 A 清掉 A 的浏览器 map，B 的状态与网页保留；失败删除不提前清空有效状态。
5. FlashX 出现在目标供应商候选，使用 GLM-5.3 现有能力链路；迁移可重复执行且不会默认启用新候选或改默认模型。
6. Pi 仍为 0.85.1，重试仍为 3 次并首次提示，Bone 权限、Canvas、运维、自动化/协作与发布边界通过相关回归。

## 验证记录

2026-09-23，全部代码验证在隔离工作树 `/Users/xutaoyu/.codex/worktrees/upstream-stability-sept23/Proma-git` 执行，分支为 `codex/upstream-stability-sept23`，基线为 `bad69c4c`。以下记录对应第一批代码完成时的验证；最新提交及跨平台结果见文末。

| 验证 | 结果 |
| --- | --- |
| 改动前相关基线 | 5 个文件，114 pass |
| 删除、锁与编排定向回归 | 123 pass |
| runtime 最后一轮定向回归 | 4 个文件，24 pass / 0 fail |
| 最终运行身份与 service 检查 | 3 个文件，29 pass |
| `ELECTRON_OVERRIDE_DIST_PATH=/private/tmp/proma-upstream-electron-bin bun test --isolate` | 595 个文件，7691 pass / 6 Windows 平台 skip / 0 fail，29799 次断言 |
| `bun run typecheck` | 全部 7 个 workspace 通过 |
| `bun run electron:build` | 完整构建通过，包含 renderer、runtime、CLI 和本机 native 模块 |
| 最后修复后，Electron 包内分别运行 `bun run build:main`、`bun run build:agent-runtime`、`bun run build:terminal-runtime` | 全部通过 |
| `git diff --check` | 通过 |
| 版本与依赖边界 | 所有 package.json、bun.lock、发布配置未改；Pi 0.85.1、模型重试 3 次及首次提示保留 |

红绿回归覆盖：删除后的迟到写入不重建 JSONL、删除中预检失败不启动运行、异步 abort 必须被等待且失败向上传递。独立审查后又以失败测试复现并修复四个 runtime 窗口：query iterator 已结束而 stop 尚未结束、Terminal ready 后进程退出、ready 到 create 登记间发生 stop、create 的 postMessage 同步抛错后残留 pending。整个 runtime lane 新增 14 项生命周期回归；最终独立复审相关 19 项测试通过，无剩余发现。

删除失败合同：工作区必须等待所有会话停止动作 settle 后再返回；任一失败时保留会话索引和绑定，不报告删除成功。此前已执行的安全清理（撤权、关闭浏览器等）不回滚，删除标记继续阻止迟到输入和落盘。

验证环境：首次沙箱测试因 loopback 绑定和临时路径权限失败，获自动审批后重新执行；最终结果以上表为准。Electron 下载未完成，测试以临时 symlink 只读复用主工作区现有 Electron 43.2.0，并通过 `ELECTRON_OVERRIDE_DIST_PATH` 指向测试目录。OfficeCLI 复用既有 v1.0.145 文件，SHA-256 为 `d66763a563bc844c3cc67036ebc7c4a9caa9319b9592814d9acd3706da231fc1`，与构建脚本固定值一致。未启动或重启用户客户端，未覆盖主工作区构建产物。

构建仍有既有的 import.meta/CJS、renderer chunk size 和 macOS native availability 警告，均未使构建失败。未执行真实 GUI 操作、Windows 原生生命周期验证或 FlashX 在线 API 调用。等待进程收尾的保证适用于默认 Pi utility runtime；可选的旧 in-process adapter 仍保留 void abort 语义，不能将其视作相同的进程退出保证。FlashX 对已有渠道只追加默认关闭候选；新建渠道预设保持上游默认启用行为。

日志：`/private/tmp/proma-upstream-final-tests.log`、`/private/tmp/proma-upstream-final-typecheck.log`、`/private/tmp/proma-upstream-build.log`、`/private/tmp/proma-upstream-live-run-tests.log`。

## 实际客户端补充验收（2026-09-23）

用户同意下一步后，在独立临时配置、Electron userData 和合成项目内加载本分支已构建的实际 main/preload/renderer。模型响应由回环 HTTP SSE 服务提供；没有调用 FlashX 在线接口、提交代码或更新用户客户端。本节补充上文原有的 GUI 验证缺口；Windows 原生验证缺口仍保留。

| 场景 | 实测结果 |
| --- | --- |
| 真实 Pi utility 运行中从侧栏删除 | 实际主进程接到本机模型 SSE 并显示流式文本；通过侧栏组件菜单和确认事件删除后，会话不在索引或 active snapshots，所有该模型请求流均关闭 |
| 删除后的持久化 | 对应 JSONL 不存在，数分钟后再次检查仍未重建；读取已删除会话的浏览器状态返回“Agent 会话不存在” |
| 浏览器会话隔离 | A 的实际 WebContentsView 被销毁，B 的原生网页及其 URL 保留；侧栏删除调用的是本分支生产 handler |
| 任务跨压缩显示 | 在完整 renderer 经真实 IPC 注入合成的 TaskCreate、compact_boundary、TaskUpdate；3 个任务保留，1 completed + 1 cancelled + 1 in_progress 显示成功数 1/3；旧 generation 的任务未混入 |
| 任务终态 | 收到当前代次 stream complete 后，不再显示旧 activeForm 或进行中悬浮进度 |
| FlashX 表单 | 实际添加智谱渠道界面显示 GLM-5.3-FlashX，新建预设默认启用，已查看截图 |
| FlashX 存量迁移 | 实际渠道读取/落盘链路覆盖 zhipu、zhipu-coding、zhipu-coding-team；新增候选为关闭，原有模型名称/启用状态保留，重复读取文件内容不再变化 |
| macOS 原生 utility / PTY | 新增可重复脚本 `apps/electron/scripts/upstream-runtime-smoke.ts`：Agent 启动中取消及重启、真实终端输出、启动中取消 create、不同 PID 再建 PTY 全部通过；5 个 utility 的 homedir 均为临时根 |

原生 runtime 最终复跑命令（Electron 包目录）：

```bash
PROMA_UPSTREAM_SMOKE_ELECTRON=/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron bun run scripts/upstream-runtime-smoke.ts
bun run typecheck
```

脚本默认从已安装 Electron 包解析真实可执行路径，也允许上述任务专用 override；不覆盖 HOME/USERPROFILE/NODE_OPTIONS。实际复跑日志为 `/private/tmp/proma-upstream-runtime-final.log`，Agent 重启 PID 57457，PTY 前后为 57498/57501。此阶段脚本仅支持 macOS；后续跨平台适配与 Windows 验证见文末。

GUI 是实际应用结合合成数据的组件事件验收：部分交互使用 Electron 原生输入，菜单和表单最终用 DOM 事件驱动真实 React handler；不能将其描述为全程人工鼠标操作。任务压缩与旧代次使用合成事件，未消耗真实模型生成压缩内容。截图与读取结果保存在 `/Users/xutaoyu/.codex/visualizations/2026/09/23/01a0cc6b-47fe-77f2-a170-51f2d41034f8/upstream-acceptance/`，含 progress-light/dark、flashx-dark、删除确认和保留会话 B。测试入口副本也在此目录；业务配置和会话正文未作为附件保存。

Windows 条件检查：本机无可用 Windows VM/运行器；`.github/workflows/build-windows.yml` 当前只执行 stable-directory 相关测试、依赖/PTY 重建和打包，没有运行本批 lifecycle 测试或启动真实 Windows utility/PTY。本轮未推送分支或触发 CI。发布前仍需 Windows runner 覆盖 ENOTCONN 启动重试、utility stop/restart、PTY 输出/取消和打包后的 helper 解析。

额外发现：全新临时配置没有 `.proma/server-ops` 时，IPC 注册在 `createServerOpsConfigTransaction(join(getConfigDir(), 'server-ops'))` 处报 `SERVER_OPS_CONFIG_INVALID_DIRECTORY`，启动进入降级模式。确认基线 HEAD 同样在 Store 初始化之前调用该逻辑，属于既有初始化缺口；目标验收仅为临时夹具预建目录后继续，没有修改生产行为。发布前应单独补首次启动回归并修复。

夹具问题已辨明：直接执行临时 symlink 的 Electron 二进制会令 renderer/GPU/network helper 退出码为 5，改为 Electron.app 内真实路径后消失；脚本改用 realpath 解析避免复发。未保存的 FlashX 新建表单已放弃，验收实例和其浏览器均已退出；原主工作区业务代码及正在运行的用户实例未更新。

## 首次启动修复与 Windows 验证补齐（2026-09-23）

用户要求继续后，先处理上一节的新用户启动阻碍。生产修复只在 IPC 装配共享配置事务前创建固定 `server-ops` 目录；事务仍保留普通目录检查、符号链接拒绝、原生锁及原子持久化合同。新用户可以完成 IPC 注册，已有用户配置无需迁移；性能仅增加启动时一次幂等目录创建检查，无常驻任务或新依赖。

新增 `apps/electron/scripts/first-startup-smoke.cjs`，直接加载已构建的 main/preload/renderer，在独立 home 与 Electron userData 下连续启动两次。第一轮不预建 server-ops，第二轮保留合成 hosts.json 原文与目录身份；每轮必须取得真实 preload 的运维主机列表和 Agent 会话列表响应，并正常退出。夹具关闭 LAN、全局快捷键和系统钥匙串可用性，renderer 网络请求禁用；不测试真实凭据或访问用户业务配置。该回归在修复前捕获 `SERVER_OPS_CONFIG_INVALID_DIRECTORY`，修复后两轮通过。

跨平台 runtime smoke 现允许 macOS/Windows，Windows 使用 PowerShell 与目录 junction。PTY 输入将成功标记拆分再由 shell 拼接，防止命令回显被误当执行结果。Windows 工作流在依赖准备后、打包前新增启动重试和生命周期单测、真实 utility/PTY 冒烟及实际客户端首次/再次启动冒烟；它们不调用真实模型 API。ENOTCONN 的触发仍由确定性单测模拟，不宣称实际 Windows 原生故障必定出现。

目录初始化修复阶段：44 项 Server Ops 配置锁/项目/主机回归通过，11 项 utility/Agent/Terminal 生命周期定向回归通过，7 个工作区类型检查通过，主进程重建通过，实际首次/再次启动通过。随后加强真实退出断言时发现下面的生命周期缺陷；最终结果以下方为准。

日志：`/private/tmp/proma-first-startup-red.log`、`/private/tmp/proma-first-startup-final.log`、`/private/tmp/proma-first-startup-tests.log`、`/private/tmp/proma-first-startup-build.log`、`/private/tmp/proma-upstream-followup-runtime.log`、`/private/tmp/proma-upstream-followup-typecheck.log`。

## 真实进程退出屏障与最终回归（2026-09-23）

原生验收确认另一个竞态：`utilityProcess.fork()` 已返回但尚未收到 `spawn` 时，`kill()` 可能返回 false。旧实现仅请求 kill 就完成 stop，会让取消启动后的进程存活。不能用历史 PID 复用解释该失败，也不能把发出终止请求当成真实退出。

Agent 与 Terminal 现在共享进程生命周期 helper：fork 返回即监听 spawn/exit，提前 stop 会在 spawn 后补发 kill，只有真实 exit 才完成停止；并发停止共用等待，15 秒超时保留进程所有权并允许后续收尾。Agent 清理失败时禁止新代次覆盖旧句柄；Terminal 在停止期间拒绝新 create，并在再启前收尾。对用户的影响是避免取消后遗留后台进程及重复终端；每个 runtime 仅增加常数级监听/状态和停止期间定时器，无常驻轮询。

真实 smoke 逐阶段检查本轮 utility/PTY PID 消失，再启动下一代；不要求新旧 PID 数字不同，也不按历史 PID 去重。PTY 探针排除输入命令回显，Electron 父进程具有独立总时限并等待实际退出后清理临时目录。

独立复审：无 CRITICAL/HIGH/MEDIUM；核心 4 文件 20 pass / 0 fail（61 次断言）。最终 7 工作区类型检查、主进程重建、完整客户端首次/再次启动及 macOS utility/PTY 冒烟通过。macOS 最终 Agent PID 44974、PTY 44977/45010、utility 44974/44976/45009，均通过各阶段退出断言。

最终本机日志：`/private/tmp/proma-upstream-final2-tests.log`、`/private/tmp/proma-upstream-final2-typecheck.log`、`/private/tmp/proma-upstream-final2-main-build.log`、`/private/tmp/proma-first-startup-final2.log`、`/private/tmp/proma-upstream-runtime-final2.log`。最新全仓 `bun test --isolate`：596 个文件，7700 pass / 6 Windows 专属 skip / 0 fail，29835 次断言，103.95 秒。版本、package.json、bun.lock 和 release.yml 未改，`git diff --check` 通过。Windows CI 结果待固定源码提交执行后补录。

### 固定源码 Windows 预检

用户明确授权将独立分支推送到 `kuangtao22/Proma` 并运行 Windows 预检。源码提交 `dc1899758acd4a1d95b152a9285024865a784a53`（移植官方稳定性修复并补齐首次启动与跨平台回归）已推送到 `codex/upstream-stability-sept23`；工作流输入 ref 固定为同一完整 SHA。

[首轮 Build Windows 35834013117](https://github.com/kuangtao22/Proma/actions/runs/35834013117) 的依赖安装、原生目录 helper 和完整 Electron 构建通过，但生命周期测试在解析 `@proma/shared` 时失败（其余 16 项通过），后续 smoke/打包未运行。根因是 `package:prepare:win` 最终会清空应用 node_modules 并只保留生产 external 依赖；源码检查必须在裁剪前执行。CI 已按源码单测 → 构建/PTY 重编 → 真实 smoke → 平台依赖安装/裁剪 → 打包排序，静态核对拆分的构建与依赖准备命令完全等于原 package:prepare:win。无生产源码或 package.json 变更，待新提交重验。未合并 main、打标签、发布或重启用户客户端。

### Windows 真运行诊断与夹具修正

- [第二轮 35835085651](https://github.com/kuangtao22/Proma/actions/runs/35835085651)，提交 `e86e808e`：生命周期单测和 Electron/PTY 构建通过，真实终端 utility 早退，但默认标准流未给出原因。
- `0d18bace` 为隔离 smoke 增加 utility stdout/stderr 管道并独立运行首次启动。Git HTTPS 随后多次连接失败；通过同仓库 Git API 逐个核对 blob、完整 tree 和提交 SHA 后，非强制推进同一分支，提交身份未改变。中间 run `35836157636` 因远程尚未收到该 SHA，仅 checkout 失败，未提供运行时证据。
- [诊断轮 35836913871](https://github.com/kuangtao22/Proma/actions/runs/35836913871) 明确记录 `Cannot find module 'node-pty'`，发生在临时 bundle 的模块解析阶段，尚未加载原生 binding，不能归因于 ABI 或终止逻辑。临时 runtime 依赖需映射到真实安装目录。
- 同轮首次启动没有取得 IPC 成功标记：Windows 构建的 `dist/resources/startup-splash/index.html` 缺失，splash 关闭后触发退出。CI 现使用 Bun 的 `fs.cpSync` 严格准备资源，再运行真实 main/preload/renderer；不通过忽略错误或伪造 IPC 响应让 smoke 通过。

后续重验仍须全部实际 smoke 与安装包构建通过。本轮修改仅限 CI/验收夹具；生产业务代码保持 `dc189975`。原生 smoke 使用开发依赖 Electron 43.2.0；现有 electron-builder.yml 另固定 43.3.0，属于 fork 历史配置，本批未改变，不将 CI 源码 smoke 等同于已安装 EXE 的完整启动验收。
