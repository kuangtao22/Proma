# 接口工作台阶段 A 实施计划

> **For agentic workers:** 使用 subagent-driven-development 执行有界独立任务；按下列检查项推进，根 agent 负责契约、集成和最终验证。

**Goal:** 在 Proma 提供可保存 HTTP 请求、环境、详细响应和历史的接口工作台，并让普通交互 Pi Agent 使用同一服务测试接口。

**Architecture:** Shared 定义严格 IPC 与记录合同；独立 Node HTTP Utility 采集网络事实并执行取消；主进程服务负责 workspace 身份、原子保存、秘密、准备/发送去重；Renderer 与 Agent 共用该服务。阶段 A 仅直连 HTTP/1.1、JSON/text/urlencoded 和基础鉴权；SSE、上传、代理、自动 Cookie Jar 和导入属于已批准路线中的下一增量。

**Tech Stack:** Bun、TypeScript、Electron 43、React/Jotai、既有 Radix/shadcn、Node http/https/zlib/crypto、safe-file。无新增依赖。

## 授权与工作树
- 用户 2026-09-24 回复“可以”，批准前一轮路线；本轮执行阶段 A，不再重复询问实施许可。
- 工作树：/Users/xutaoyu/.codex/worktrees/api-workbench/Proma-git
- 分支：codex/api-workbench；原工作区媒体改动不带入。
- 业务配置与测试均使用临时数据根/合成接口，不操作用户真实 API 或重启现有客户端。

## 文件职责与并行边界
1. 根 agent：packages/shared/src/types/api-workbench.ts 及 parser/test/export；main IPC、preload、Agent Facade/工具及 orchestrator 接线；计划和记忆。
2. 传输执行：src/main/lib/api-workbench/api-transport.ts、runtime client/protocol，src/utility/api-workbench-runtime.ts，对应测试；构建接线由根 agent 整合。
3. 存储服务：src/main/lib/api-workbench/api-workbench-store.ts、api-workbench-service.ts、秘密/产物辅助及测试。不改 Shared，由根 agent 协调契约。
4. UI：src/renderer/components/api-workbench/、api-workbench atoms，以及 SidePanel/Tab 注册；Renderer 测试。独立用户草稿与权威持久事实。

## Task 1：固定共享合同
- [x] 写 BDD 解析测试：非法协议、CRLF Header、重复行、变量长度、未知字段、HTTP 方法、超时/重定向上限、secretRef 不能伪装外部路径。
- [x] 运行共享合同 BDD 测试，验证合法输入与主要拒绝边界。
- [x] 实现 ApiField、ApiAuth、ApiRequestDraft/Definition、ApiCollection、ApiEnvironment、ApiCatalog、ApiPreparedPreview、ApiRun、ApiHttpHop、ApiBodySlice 与 API 合同。
- [x] 使用数组保存 Header/query；服务使用 sessionId 推导 workspaceId，不接收模型自报权限身份。
- [x] 重跑相关测试。消费者以 Shared 文件中的最终签名为准。

## Task 2：HTTP 真实传输
- [x] 合成 server 先测 rawHeaders、多个 Set-Cookie、gzip、重定向、401/500 保留正文、取消与大小限制。
- [x] 实现 Node http/https 的有界流读取、分阶段 timing、socket/TLS 事实、重定向逐跳事实；跨来源目标在下一跳发出前拒绝。
- [x] 原始 Body/解码 Body 分开；采集来源明确，无证据不显示假 0 或假实际值。
- [x] Utility 接受 Host 提供的固定请求，按 requestId 取消并等待底层 close/进程退出；回执丢失不自动重发。
- [x] 运行定向 Bun 测试及 Electron Node 合成网络夹具，记录平台差异。

## Task 3：存储、秘密和调度
- [x] 先测试跨 workspace、revision 冲突、并发保存、坏文件、重复 send、保存失败不重发、取消与重启未知结果。
- [x] 在活动数据根下创建独立 api-workbench/workspaces/<id>；复用 safe-file 原子写，写事务串行且跨进程互斥。
- [x] 环境变量/鉴权秘密保存为系统保护的密文引用；公开 catalog 不回传已存明文。
- [x] 准备快照冻结环境与 catalog revision，preparedId 对应一次派发；发送前复核版本与所有权。
- [x] 请求记录与大正文产物分开；原始产物加密，系统安全存储不可用时只在内存使用并显式标注。
- [x] 每来源 2/全局 4 调度；排队可取消；30 秒默认/有限可配置超时；输入、响应和解压均限额。
- [x] 7 天/1 GiB 普通历史，收藏独立保护；运行中及跨实例活跃记录不被错误恢复/清理。
- [x] 保存定义与发送网络动作独立，错误分类保持真实 HTTP 状态和已收到正文。

## Task 4：IPC 与 Agent
- [x] 主进程建立统一服务 singleton，IPC sender 与 session 所属 workspace 校验；preload 参数和结果严格校验。
- [x] 接入 api_list/get_request/prepare_request/send_request/inspect_run/save_request；只向普通交互运行装配，内部/Automation 不继承。
- [x] 模型输出有界脱敏；Host 执行前复核 runSignal/代次及精确 preparedId。
- [x] 发送与保存分别走既有权限链；工具批准输入包含真实目标/方法和请求差异，不能仅审批不透明 ID。
- [x] 运行 Facade、IPC、preload 与会话边界测试；参数为空/伪造 workspace/过期输入均可解释拒绝。

## Task 5：工作台界面
- [x] 新增“接口”同级标签、加号入口、session Tab 恢复清洗。
- [x] 集合/文件夹和请求标签；URL/方法、Query/Header 行、Body、Auth、测试与设置；环境编辑器支持普通/秘密变量。
- [x] 响应包含概览、正文、头、实际请求、重定向、耗时/TLS、断言；原文/格式化分开且不丢数字。
- [x] 历史打开原运行且不自动重发；收藏、保存/复制/删除与 revision 冲突提示；历史载入编辑器延后。
- [x] React/Jotai 单次发送身份固定；切请求/环境、晚回执、卸载与关闭不串状态。
- [x] 真实组件在宽/窄 Pane 与深浅主题验收请求、保存、原文与历史打开；快捷键接线及单飞/取消由定向测试覆盖。大正文仅将有界页面传入 UI。
- [x] 聊天工具结果提供精确 runId 进入工作台，不重复展开大正文。

## Task 6：集成与验证
- [x] 定向测试 green 后运行 bun run typecheck；修复本改动引入问题。
- [x] 将 Utility 加入 build/watch/readiness/资源和打包，运行 bun run electron:build（隔离工作树）。
- [x] 实际 Electron 启动临时数据根 + 回环 HTTP/HTTPS：手动/Agent 同服务，保存/重新创建 Store 后读取/查看历史，401 与取消；此项未模拟完整进程重启。
- [x] 进行规格复审，再进行代码质量复审；修复所有阻断问题后重跑相关验证。
- [x] 更新本计划的证据、限制与 MEMORY；检查 git diff；保持未完成媒体改动、运行中的客户端与真实业务数据不受影响。

## 验收记录
最终验收证据（2026-09-24）：

独立最终复审结论 APPROVE；之前发现的持久化事务、取消、重复发送、UI 所有权隔离、原文读取与脱敏边界均已修复并补回归。`git diff --check` 与新增源文件空白检查通过。实现保持未提交、未合并、未发布。隔离树 MEMORY 的既有历史差异保留，本任务仅追加自己的记录，未来提交时需按任务范围选择。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| Bun 联合定向回归：共享合同、IPC/preload、Store/Service、Agent、退出/迁移、UI 与既有 Canvas 入口 | 286 pass / 0 fail，26 文件 | `/tmp/proma-api-targeted-final.log` |
| Electron 43.2.0 自带 Node 24.18.0：HTTP/HTTPS 传输与 Utility 加密产物 | 21 pass / 0 fail，含重复头、压缩、同源重定向、TLS/降级拒绝、阶段耗时、取消关闭、产物错误 | `/tmp/proma-api-node-final.log` |
| `bun run typecheck` | 7 workspace 全部通过 | `/tmp/proma-api-typecheck-final.log` |
| `bun run electron:build`，随后对最终脱敏修正重建 `build:main` | 通过；已有大 bundle 和原生 EventKit 编译告警，无失败 | `/tmp/proma-api-build-final.log`、`/tmp/proma-api-main-final.log` |
| 真实 Electron preload → IPC → Service → Utility → 本机 HTTP | PASS；3 次网络调用，重复 send/打开历史不新增调用；加密保存、401/gzip、重复头、大整数、Agent 审批、取消 partial 均通过 | `/tmp/proma-api-smoke-final.log` |
| 真实 Electron 挂载 React 工作台，受控 IPC 夹具 | PASS；Dialog、新建集合/请求、保存、单次发送、原文 reveal、历史只读、宽/窄布局及亮暗主题 | `/tmp/proma-api-ui-smoke-final.log` |

网络链路 smoke 使用实际服务；UI smoke 使用受控桥接夹具。两者分别验证执行与交互，未调用真实第三方接口或真实模型服务。不是整个 monorepo 全量测试，也不是四平台安装包验收。

截图已等待 Dialog 离场和抽屉动画结束后采集并目视检查：
- 宽布局：`/private/tmp/api-workbench-ui-wide.png`
- 亮色窄抽屉：`/private/tmp/api-workbench-ui-narrow.png`
- 暗色窄布局：`/private/tmp/api-workbench-ui-narrow-dark.png`

复跑示例（在隔离工作树执行）：
```bash
bun run typecheck
bun run electron:build
bun x esbuild apps/electron/src/main/lib/api-workbench/api-transport.node-test.ts --bundle --platform=node --format=cjs --outfile=/private/tmp/proma-api-transport-final.cjs --external:electron
bun x esbuild apps/electron/src/utility/api-workbench-runtime.node-test.ts --bundle --platform=node --format=cjs --outfile=/private/tmp/proma-api-utility-final.cjs --external:electron
ELECTRON_RUN_AS_NODE=1 NODE_EXTRA_CA_CERTS=/Users/xutaoyu/.codex/worktrees/api-workbench/Proma-git/apps/electron/src/utility/server-ops/fixtures/server-ops-tls-fixture-cert.pem /Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test /private/tmp/proma-api-transport-final.cjs /private/tmp/proma-api-utility-final.cjs
```
Electron 链路 smoke 在 `apps/electron` 编译 `scripts/api-workbench-smoke.ts` 为 `dist/api-workbench-smoke.cjs`（external:electron），使用上面的实际 Electron 二进制且清除 `ELECTRON_RUN_AS_NODE` 后运行。UI smoke 可在同目录设置 `PROMA_ELECTRON_PATH` 为实际 Electron 路径后 `bun run scripts/api-workbench-ui-smoke.ts`，自动使用临时 Vite/数据根；验收后清理测试进程。

## 已知范围与后续工作

### 阶段 B1：接口导入导出（已交付）

**目标**：把外部已有请求（浏览器「Copy as cURL」、文档示例、Proma 集合快照）转化为本工作台的可复用资产，并能反向导出分享。这是「接口管理保存」的入口环节。

**范围**

- cURL → 请求草稿：解析常用参数，一次可导入多条；绝不执行 shell；未知或不支持的选项逐条列出，不猜测语义。
- 请求草稿 → cURL：生成可粘贴命令；秘密值替换为变量占位符并在结果中列出被替换位置，导出结果无法直接发送，属于 fail closed。
- 集合快照导出：JSON 文本，秘密值清空并列出需要重新填写的位置。
- 集合快照导入：严格解析与版本校验；一律作为新增集合/环境/请求写入，不覆盖同名资产，保存仍走目录 revision 比较。

**不在本期范围**：文件对话框读写（先用剪贴板）、Postman Collection v2.1 与 OpenAPI 导入、multipart 文件的 `-F` 导入、代理与 Cookie Jar 参数、任何脚本字段。

**影响与边界**

- 解析与序列化是 `packages/shared` 内的纯函数：不新增 IPC 通道、不发起网络、不接触凭据解密。
- 渲染层新增导入对话框与导出入口，复用现有 `writeClipboardText` 与目录保存链路；不改变传输、存储与 Agent 权限边界。
- Agent 侧导入工具留到 B1b，避免一次扩大审批面。

**验证**

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 共享解析器与渲染层模型 BDD（`api-workbench-curl.test.ts` 24 项、`api-workbench-sharing.test.ts` 12 项、`api-workbench-model.test.ts` 新增 4 项） | 全部通过 | `/tmp/proma-api-b1-targeted.log` |
| 工作台四层契约 + 关联模块完整定向回归（最终源码） | 775 pass / 0 fail，80 文件 | 同上 |
| `bun run typecheck` | 7 workspace 全部通过 | `/tmp/proma-api-typecheck-final.log` |
| `bun run electron:build` | 通过（含既有大 bundle 与 EventKit 编译告警） | `/tmp/proma-api-b1-build.log` |
| 真实 Electron 挂载工作台：导入 cURL → 预览 → 存为草稿 → 保存；导入集合快照 → 提示重填秘密 → 新增集合 | PASS | `/tmp/proma-api-ui-smoke-final.log`，截图 `/private/tmp/api-workbench-ui-import.png` |

**已实现的行为边界**

- 只翻译已知参数；`-F`/`-T`/`--cert`/`-d @文件`/`-b 文件` 会整条跳过并说明原因，不会静默丢掉正文后照常发送。
- `-k`、`-o`、`-x` 等不影响请求语义差异的选项保留请求并逐条提示；`--max-time` 映射到超时并收敛到 100–300000 毫秒。
- 导入的敏感 Header 与 `-u` 密码直接标记为秘密；导出时秘密值替换为 `{{变量}}` 占位符，因此导出结果无法直接发送。
- 集合快照导入只新增集合/环境/请求，ID 冲突时分配新 ID，目录 revision 仍由调用方比较；导入前展示增量与需要重填的秘密位置。

**未交付**：Agent 侧导入工具（B1b）、文件对话框读写（当前走剪贴板）、Postman Collection v2.1 与 OpenAPI 导入、multipart 文件导入。

### 阶段 B2：事件流（SSE）（已交付）

**目标**：流式接口在等待期间就能看到事件，能中断，中断后仍能核对已收到的片段与断流位置。

**范围与行为**

- 传输层识别 `text/event-stream`，按 SSE 规范分帧：`data` 多行合并、`event`/`id`/`retry`、注释（心跳）单独保留；跨 chunk 的多字节字符与帧边界都不会乱码。
- 每个事件记录序号、相对到达毫秒、事件名、id、注释、data、原始片段与截断标记；单帧 16 KiB、单次运行 2000 条与 2 MiB 总量上限，超出只计数量。
- utility 按 64 条或 32 KiB 或 100 毫秒批量上报增量；主进程新增 `api-workbench:stream` 通道，只广播有界增量，不重复正文。
- 服务层按运行缓存事件并在终态写入记录；历史摘要只保留计数；界面在运行头部尚未到达时也能实时显示，终态后回落到运行记录。
- 事件同样经过秘密脱敏；Agent 的 `api_inspect_run` 新增 `sse` 分区，按字符预算分页返回。

**验证**

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 共享 SSE 帧读取器 BDD | 9 pass / 0 fail | `/tmp/proma-api-b2-targeted.log` |
| Electron 自带 Node：传输层事件流（逐帧、取消保留、非流式不误判、跨 chunk 多字节） | 22 pass / 0 fail（含 4 项新增） | `/tmp/proma-api-sse-node.log` |
| Electron 自带 Node：utility 加密产物与事件上报 | 4 pass / 0 fail | `/tmp/proma-api-sse-utility.log` |
| 工作台四层契约 + 关联模块定向回归 | 794 pass / 0 fail，81 文件（含协议、客户端、服务、preload 新增用例） | `/tmp/proma-api-b2-targeted.log` |
| `bun run typecheck` / `bun run electron:build` | 7 workspace 通过 / 构建通过 | `/tmp/proma-api-b2-typecheck.log`、`/tmp/proma-api-b2-build.log` |
| 真实 Electron 端到端（真实 utility）：SSE 逐帧、实时广播、取消保留首帧、Agent 读取 `sse`、历史摘要不含明细 | PASS，网络调用 5 次，广播批次 2 | `/tmp/proma-api-smoke-final.log` |
| 真实 Electron 挂载界面：实时事件面板 + 落盘事件分区 | PASS，截图 `/private/tmp/api-workbench-ui-sse.png` | `/tmp/proma-api-ui-smoke-final.log` |

**未交付**：SSE 的断线自动重连与 `Last-Event-ID` 续传（事件级断言已在 B3 交付）、multipart 文件上传、显式 HTTP 代理、Cookie Jar、HTTP/2。

### 阶段 B3：事件级断言（已交付）

**目标**：流式接口也能给出「通过/失败」的确定结论，让 Agent 不必靠人来读事件列表。

**范围**

- 新增四类断言：`sse-count`（事件数量，支持 `>=3` 或精确值）、`sse-first-event`（首事件耗时，毫秒比较）、`sse-ended`（`completed`/`cancelled`/`error`）、`sse-last-data`（最后一个带数据的事件，`=` 前缀为精确匹配，否则为包含）。
- 数量与耗时使用流式摘要里的真实计数，不受事件明细保留上限影响；`sse-last-data` 在事件超过保留上限时明确返回「无法验证」，不误判通过。
- 响应不是事件流时，四类断言一律失败并说明原因，不会静默通过。
- 断言实际值同样经过秘密脱敏；Agent 的 `api_prepare_request` 可直接声明这些断言。

**验证**

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 断言求值 BDD（含 6 项事件流用例） | 全部通过 | `/tmp/proma-api-b3-targeted.log` |
| 工作台四层契约 + 关联模块定向回归 | 800 pass / 0 fail，81 文件 | `/tmp/proma-api-b3-targeted.log` |
| `bun run typecheck` / `bun run electron:build` | 7 workspace 通过 / 构建通过 | `/tmp/proma-api-b3-typecheck.log`、`/tmp/proma-api-b3-build.log` |
| 真实 Electron 端到端：流式请求带四类断言，前三项通过、故意写错的最后一段数据判定失败 | PASS | `/tmp/proma-api-smoke-final.log` |

**未交付**：跨请求变量提取与注入（把事件里的 token 存成后续请求的变量）仍需单独设计存储、隔离与过期策略，留到下一增量。

### 阶段 B4：跨请求变量提取（已交付）

**目标**：把「登录拿 token，再手工粘到下一个请求」变成声明式链路，Agent 也能串起来。

**范围与关键取舍**

- 请求可声明最多 16 条提取规则：`json`（正文 JSON 路径）、`header`（响应头，忽略大小写并合并重复值）、`sse-last-data`（最后一个带数据的事件，可再给内部 JSON 路径）。
- **提取值只活在主进程内存里**：按 workspace 隔离，1 小时过期，按 64 条上限淘汰，服务关闭即清空。不落盘，因此不需要新的加密文件格式，token 不会进入 `record.json` 或历史摘要。
- 变量优先级固定为 `显式单次覆盖 > 运行时变量 > 环境 > 集合`；运行记录里的请求预览仍按秘密规则脱敏。
- 运行记录只保存提取**结果事实**（名称、是否命中、原因、是否按秘密处理），协议层显式拒绝携带取值字段；命中空值或超长值一律不写入，避免把无效 token 塞进后续请求。
- 只有正常完成的响应才提取；失败或取消的运行逐条返回「已跳过提取」，不会拿半截数据去覆盖已有变量。

**验证**

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 提取求值 BDD（8 项：JSON/Header/事件流、截断、心跳、超长、未命中、非事件流） | 全部通过 | `/tmp/proma-api-b4-targeted.log` |
| 解析器优先级（运行时覆盖环境、不覆盖单次覆盖、秘密 taint 传播） | 全部通过 | 同上 |
| 服务端到端（提取→复用→记录无明文→清空） | 全部通过 | 同上 |
| 工作台四层契约 + 关联模块定向回归 | 814 pass / 0 fail，82 文件 | 同上 |
| `bun run typecheck` / `bun run electron:build` | 7 workspace 通过 / 构建通过 | `/tmp/proma-api-b4-typecheck.log`、`/tmp/proma-api-b4-build.log` |
| 真实 Electron 端到端：登录响应提取 `token`，下个请求用 `{{sessionToken}}` 复用 | PASS，服务端确实收到 `Bearer fixture-token-9`，两次运行记录均无明文 | `/tmp/proma-api-smoke-final.log` |

**过程中抓到的真实缺陷**：提取最初跑在已脱敏的响应投影上，`{"token":"..."}` 这类最常见的登录响应会被遮罩成 `[REDACTED]`，等于提取到一个假值。现在提取只读原始传输结果，取值仍只在主进程内部使用。

**未交付**：把提取值写回环境变量的持久化选项、Agent 直接读取运行时变量取值（按设计永不开放）。

### 阶段 B6：用当前定义重发历史运行（已交付）

**目标**：调试时改完定义后，一条命令重跑同一条接口，不用回目录里找。

**范围与取舍**

- 运行头部新增「用当前定义重发」按钮，只对来自**已保存请求**的运行出现（`run.requestId` 存在）。它按目录里的**最新版本**重新 prepare 再发送，因此秘密仍由 Host 解析，不存在把旧快照里的脱敏值转发出去的风险。
- 事件只携带 `sessionId + requestId`（与结果卡定位运行同一套路），由会话决定如何执行；重发会先确保对应请求标签存在，等标签真正挂载后再发送，避免 React 批处理竞态。
- 请求已从目录删除时明确报错，不静默失败。

**验证**

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 重发事件分派（跨会话拒绝、无 requestId 拒绝、detail 只含身份） | 通过 | `/tmp/proma-api-b6-targeted.log` |
| 工作台四层契约 + 关联模块定向回归 | 816 pass / 0 fail，82 文件 | 同上 |
| `bun run typecheck` / `bun run electron:build` | 7 workspace / 构建 | `/tmp/proma-api-b6-typecheck.log`、`/tmp/proma-api-b6-build.log` |
| 真实界面：打开历史 → 点击重发 → 出现第二次真实发送与提示 | PASS | `/tmp/proma-api-ui-smoke-final.log` |

**未交付**：按历史快照（旧版本定义）重跑；multipart 文件上传仍在等待授权模型决策。

### 阶段 B5：运行时变量面板（已交付）

**目标**：让提取结果可见、可重置，而不是只能从运行记录里猜。

**范围**

- 新增两个 IPC 命令：`getRuntimeVariables`（只返回名称、是否秘密、来源、更新时间）与 `clearRuntimeVariables`（返回清空数量）；两者只接收会话身份，workspace 仍由主进程解析。
- 契约层显式拒绝携带取值的回执：`parseApiRun` 同级严格解析，出现 `value` 之类字段直接判为损坏协议。
- 工具栏新增「运行时变量」面板：展示元数据、来源与更新时间，支持刷新与一键清空；面板打开期间跟随运行状态自动刷新。

**验证**

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 共享 IPC 契约（命令白名单、拒绝伪造 workspace、拒绝取值字段、越界计数） | 通过 | `/tmp/proma-api-b5-targeted.log` |
| 工作台四层契约 + 关联模块定向回归 | 816 pass / 0 fail，82 文件 | 同上 |
| `bun run typecheck` / `bun run electron:build` | 7 workspace / 构建 | `/tmp/proma-api-b5-typecheck.log`、`/tmp/proma-api-b5-build.log` |
| 真实 Electron：读取运行时变量元数据 → 确认无取值 → 清空 → 再读为空 | PASS | `/tmp/proma-api-smoke-final.log` |
| 真实界面：面板显示名称/秘密/来源 → 清空后显示空状态 | PASS | `/tmp/proma-api-ui-smoke-final.log` |
- 阶段 A 无新增运行时依赖；传输在独立 Utility 中完成，默认不常驻进程。不会引入新数据库或共享浏览器 Cookie。
- 严格限制 HTTP/1.1 直连与同源重定向；SSE、multipart/文件、代理、Cookie Jar、导入导出属于阶段 B。
- 请求总量限 1 MiB，编辑器正文 131,072 字符；响应压缩前/后各 20 MiB；预览 256 KiB；Agent 单次结果 32 KiB。JSON 断言对超出完整预览的内容返回无法验证。
- 历史轻量分页；正文 IPC 分页，但主进程需完整认证并解码最多 20 MiB 文件。未做大规模实时性能基准；不宣称随机访问解密或零主进程开销。
- 系统安全存储不可用时新秘密禁止持久化，有限内存只保存请求与头的原始详情；正文只保留脱敏预览，界面需明确标识。自定义敏感项须标记或引用秘密环境变量。
- 文件夹基于请求路径，空文件夹不持久化；历史载入编辑器、集合鉴权继承、可拖动分隔条、JSON 类型断言与响应差异比较尚未交付。
- 本轮不执行安装包发布、Windows/Linux 原生测试、真实第三方接口调用或用户客户端重启；变更留在隔离工作树待审阅。

## 阶段 B7：接口测试用例（已交付）

分支 `codex/api-cases`（工作树 `.worktrees/api-cases`，基于 main `7aca05ff`）。目标：把请求上那份扁平的断言升级成**具名用例**，让同一接口的「正常 / 缺参数 / 越权」各自独立，并能一键跑全部用例拿到结论。

### 已交付（6 个提交，均带测试）

| 提交 | 内容 |
| --- | --- |
| `5c21e764` | 契约：`cases?: ApiTestCase[]`（id/name/assertions/overrides/environmentId），≤16 条，可选字段向后兼容 |
| `2f91540b` | 求值：`prepare({ caseId })` 用该用例的断言与覆盖；优先级 **显式覆盖 > 用例覆盖 > 运行时变量 > 环境 > 集合**；用例环境仅在仍存在时生效；用例不存在时 `API_WORKBENCH_CASE_NOT_FOUND`；运行记录带 `caseId` |
| `30e76442` | Agent：`api_prepare_request` 接受 `caseId` 并透传；运行摘要带 `caseId`；补齐用例执行回归测试 |
| `e79c0ad4` | 报告：`ApiCaseReportRow` + `formatApiCaseReportMarkdown`（未执行/未验证/通过/失败四态分明，单元格转义竖线与换行） |
| `4fdda2ee` | 发送链路：控制器 `send` 接受 `caseId` 并透传 `prepare`，未指定时仍按请求默认断言 |
| `46a4f6fe` | 界面：用例分区、按用例发送与标注、跑全部用例、用例报告与复制、目录用例数量 |

验证基线：主进程工作台 91 项、共享合同与服务工作台 559 项、用例报告 4 项测试通过；`@proma/shared` 与 `@proma/electron` 类型检查通过。

### 界面与批量运行（已交付）

- 模型层：`ApiWorkbenchRequestTab.activeCaseId` 保留每个请求标签各自选中的用例；`draftAssertions`/`withDraftAssertions` 决定「断言」页当前编辑的是用例还是请求默认断言（用例被删后自动回落，绝不写到错误位置）；`resolveApiCaseName` 按「当前草稿 → 目录 requestId 回查 → 已删除的用例」解析用例名；`runAllApiCases` 把「顺序执行 + 取消后不再派发 + 每次进度回调」抽成可注入的纯逻辑。
- 「用例」分区支持新增/重命名/删除/设为当前，`0/16` 上限与请求默认断言入口同排；新增用例创建后立即选中；选中用例时「断言」页顶部标明「正在编辑：用例「<名称>」的断言」。
- 发送入口（按钮与 ⌘/Ctrl+Enter）带上当前用例身份；按用例运行时响应头部显示「用例 <名称> · 断言 x/y」，运行历史每行显示用例名，目录树在 `cases.length > 0` 时显示「N 用例」。
- 「跑全部用例」顺序对每个用例走同一个控制器 `prepare + send`（单飞与取消语义不变），**跑完再汇总**；报告弹层列出 用例/结果/状态码/断言/耗时/备注，可「复制报告」或逐行「打开运行」（打开时先关闭报告，让位给响应面板）。
- 报告表格与复制出的 Markdown 共用 `formatApiCaseReportCells`：`createApiCaseReportRow` 只取运行里的真实状态码、断言计数与耗时；失败、取消、中断的运行一律不算通过，备注写出「期望 X，实际 Y」或具体错误码，未执行的行保留声明的断言数量。
- 批量运行期间「发送」入口关闭、报告弹层不允许关闭（只能「取消剩余用例」），避免插进另一个用例的执行或看不到中途结果。

### 验收记录（2026-09-24）

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 定向回归 `bun test packages/shared/src/types apps/electron/src/main/lib/api-workbench apps/electron/src/renderer/components/api-workbench apps/electron/src/preload` | 679 pass / 0 fail，75 文件 | `/tmp/proma-api-b7-targeted.log` |
| `bun run typecheck` | 7 workspace 全部通过 | `/tmp/proma-api-b7-typecheck.log` |
| `bun run electron:build`（隔离工作树） | 通过；仅既有 EventKit `@available` 告警 | 见下文命令 |
| 真实 Electron 端到端（`api-workbench-smoke.ts`，真实 utility） | PASS；网络调用 10 次，含 `caseId`、用例级断言一通过一失败、`case_not_found` 拒绝、无用例运行不带 `caseId` 与报告文本 | `/tmp/proma-api-b7-smoke.log` |
| 真实界面（`api-workbench-ui-smoke.ts` + 受控夹具） | PASS；用例新增/改名/删除、保存、跑全部用例、报告「1/2 通过」、复制报告文本、逐行打开运行、目录用例数量徽标 | `/tmp/proma-api-b7-ui-smoke.log` |

截图（等弹层与抽屉动画结束后采集并目视检查）：
- 用例报告（两条用例一通过一失败，备注显示「期望 401，实际 200」）：`/private/tmp/api-workbench-ui-cases.png`
- 宽布局（响应头部「用例 正常用例 · 断言 1/1」、目录「1 用例」徽标）：`/private/tmp/api-workbench-ui-wide.png`
- 亮色窄抽屉：`/private/tmp/api-workbench-ui-narrow.png`；暗色窄布局：`/private/tmp/api-workbench-ui-narrow-dark.png`

复跑命令（在隔离工作树 `apps/electron` 下）：
```bash
bun run typecheck && bun run electron:build
bun x esbuild scripts/api-workbench-smoke.ts --bundle --platform=node --format=cjs --outfile=dist/api-workbench-smoke.cjs --external:electron
PROMA_ELECTRON_PATH=<Electron 二进制> <Electron 二进制> dist/api-workbench-smoke.cjs
PROMA_ELECTRON_PATH=<Electron 二进制> bun run scripts/api-workbench-ui-smoke.ts
```

已知范围与限制：界面 smoke 使用受控 IPC 夹具（用例结论由夹具按用例序号给出），真实传输链路由 `api-workbench-smoke.ts` 覆盖，两者合并才能代表「用例定义 → 真实发送 → 报告」；未跑四平台安装包验收，也未接真实第三方接口。用例的 `overrides`/`environmentId` 仍只能经 Agent 或导入快照声明，界面本期不提供编辑入口。批量运行串行执行，不做并发；某个用例失败后仍继续跑完（fail-fast 未实现，属有意取舍）。

合并进主工作区的方式：**按显式路径提交**（`git checkout codex/api-cases -- <paths>` + `git commit <paths>`），因为主区索引里可能已有用户暂存的 `MEMORY.md`/`.gitignore`，`git commit -m` 会把整个索引一起提交（B6 那次踩过）。

### 环境注意事项（踩过的坑）

- 新建工作树没有 `node_modules`，先 `bun install --offline --frozen-lockfile`，否则 `@proma/electron` 类型检查会报大量「找不到 @proma/shared」的假错误。
- 解析器给新字段补默认值（如 `cases ?? []`）时，`createApiRequestDraft` 必须同步补形状，否则「解析前 vs 解析后」不一致会让既有相等断言失败（B7 第二步实际踩到）。
- `ApiWorkbench.tsx` 里有几行超长 JSX，`apply_patch` 常对不上上下文；改用带断言的定点替换更稳。
- 隔离工作树里 `node_modules/electron` 没有下载 dist，跑真实 Electron 需复用主仓库已下载的二进制（`PROMA_ELECTRON_PATH=/Users/xutaoyu/CodeSource/GPL/Proma-git/apps/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`）；启动 GUI 进程在受限沙箱下会被 SIGABRT，须在沙箱外执行。
- `bun run electron:build` 里的 `prepare:officecli` 会联网下载并校验 33MB 二进制；离线时把主仓库 `apps/electron/resources/officecli/officecli`（大小与 SHA-256 一致）复制过来即可跳过下载。原生 helper 编译若报 `~/.cache/clang/ModuleCache ... Operation not permitted`，用 `CLANG_MODULE_CACHE_PATH=/tmp/<dir> SWIFT_MODULECACHE_PATH=/tmp/<dir>` 重跑即可。
- 界面 smoke 在 `executeJavaScript` 里执行 JS 字符串，`a && b ?? c` 这种 `&&` 与 `??` 混写是无括号语法错误（会报 `Unexpected token '??'`），必须加括号；Radix 弹层关闭后节点仍会短暂留在 DOM，判定「已关闭」要看 `[role=dialog]` 的 `data-state` 而不是节点是否存在。

后续增量：**让 Agent 自己出题**（用例来源盖章、人写用例保护、审批卡用例差异）。现状核实、设计取舍与实施顺序见 `2026-09-24-api-workbench-agent-cases.md`；本轮 Agent 仍只能按已有 `caseId` 执行，不能创建或修改用例。
