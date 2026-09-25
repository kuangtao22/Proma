# 接口工作台 B12：multipart 文件上传（实施计划）

> 用户已明确授权模型：**Agent 侧由用户指定文件、Agent 发起确认授权弹窗、确认后才可上传；用户也可以在接口界面自己选文件上传**。
> 本计划把这个模型落成两层实现（B12a 机制 → B12b Agent 授权面），并收紧三处安全语义。

## 1. 三条收紧后的硬约束

1. **路径不入库**：请求定义里只存文件引用（`file_xxx` + 文件名/大小/类型），真实绝对路径只活在主进程内存，服务重启即失效；失效时 prepare 直接拒绝（`API_WORKBENCH_FILE_REF_NOT_FOUND`）并提示重新选择。理由：否则一条保存好的请求会在几天后悄悄重读当初授权的文件（等价于把「读本机文件」变成一个长期能力）。
2. **路径只从一个入口进来**：界面走主进程原生文件对话框（渲染层与 Agent 都不接触路径字符串）；Agent 走审批卡——卡片显示 `fs.realpath` 解析后的**真实路径** + 大小，只接受常规文件（目录/FIFO/设备/符号链接目标不存在一律拒绝），且**只在批准后读取一次**。符号链接必须按 realpath 展示，防止把 `.ssh/id_rsa` 藏成 `/tmp/x`。
3. **附件字节不留存**：运行记录与预览只保留「字段名 + 文件名 + 大小 + sha256 + 未留存正文」摘要，不把文件内容写进 `record.json`/`raw.bin.enc`。理由：避免每次上传往数据根塞 20 MiB，也避免把你自己的文档复制进应用目录。

## 2. 分层设计

- **共享合同**：`ApiRequestBody.body.kind` 新增 `multipart`；新增 `ApiFilePart { id, name, fileName, sizeBytes, contentType?, ref }`（**不含路径**）与 `ApiAttachmentSummary`（记录/预览用：字段、文件名、大小、sha256）。
- **主进程文件仓库**：每 workspace 一份内存映射 `ref → { realpath, fileName, sizeBytes, contentType, sha256 }`；注册入口只有两个（原生对话框回调、Agent 审批通过后的登记），条数与单文件大小都有上限（单文件 20 MiB，总请求体仍受 `API_LIMITS.bodyBytes` 约束）。
- **解析器**：multipart 草稿解析出文本字段与文件引用；引用已失效即 fail closed；合成 multipart 正文时把文件字节读进来（主进程内），产出**待发送的 base64 正文**与**可留存的摘要正文**两份投影。
- **传输协议**：`ApiResolvedRequest` 增加可选 `bodyBase64`（仅多部分/二进制正文使用，有界），Utility 优先按 base64 解码成 Buffer 再发送（`Content-Length` 来自真实字节数）；记录侧把 `bodyBase64` 剥掉、`body` 换成摘要正文。
- **界面**：Body 分区新增 `multipart/form-data` 类型；文本字段复用现有行编辑器，文件行提供「选择文件 / 更换 / 移除」并显示文件名与大小；引用失效时显示「需要重新选择文件」。
- **Agent（B12b）**：`api_prepare_request` 的文件字段允许声明**路径**，但该路径只进入审批快照；保存审批卡逐行显示 realpath、大小与目标字段，批准后才登记引用；未批准前 prepare 出的 preparedId 不能发送。

## 3. 两步实施（每步独立可验收）

**B12a：上传机制（用户自己在界面选文件）**
1. 合同（`multipart` + `ApiFilePart` + 摘要类型）与解析器 BDD。
2. 主进程文件仓库 + 原生对话框 IPC（`pickApiFiles`）+ 失效语义回归。
3. 解析器合成 multipart 正文（base64 待发 + 摘要投影）+ `bodyBase64` 协议支持 + Utility 解码（Electron 自带 Node 的传输测试）。
4. 界面 Body 分区的文件行 + 界面 smoke（夹具扮演主进程返回引用）。
5. 真实 Electron 端到端：临时目录造一个二进制文件（含非 UTF-8 字节），注册后发送，服务端按 multipart 解析校验字节完全一致；断言运行记录里查不到文件内容、只有摘要。

**B12b：Agent 指定文件 + 确认授权**（授权流已定稿，见下节「B12b 定稿」，下一步一次做完）
6. 工具 schema：`request.body.files` 接受 `{ id, name, path, contentType? }`（路径只在审批快照里出现，不进请求定义）。
7. facade 在 prepare 阶段**只做 stat/realpath 校验并登记引用**（不读内容），把路径换成 B12a 的 `ApiFilePart`；审批快照带 `files: [{ field, path(=realpath), sizeBytes }]`。
8. 审批卡逐行显示 realpath/大小/目标字段；批准后 preparedId 才能发送；**字节在 send 时才读**（沿用 B12a 的 inode/时间戳复核，换文件即拒绝）。
9. 真实 Electron 端到端：Agent 声明路径 → 未批准时发送被拒 → 批准后真实上传成功；符号链接按 realpath 展示；目录/设备文件被拒。
10. 计划文档补验收证据，按显式路径合入 main。

### B12b 定稿（2026-09-25，供下次直接实施）

- **路径只活在两处**：facade 的待批准快照（内存）与 B12a 的文件仓库（内存）。请求定义、运行记录、模型可见的预览里都只有引用与元数据。
- **时序**：`api_prepare_request` → Host `realpath + stat`（不读字节）→ 登记引用并把路径替换成 `ApiFilePart` → `approval('api_send_request')` 快照里带 `files[{field, path, sizeBytes}]` → 审批卡展示（路径用 realpath，符号链接无法伪装）→ 批准后 `send` 读取字节（inode/时间戳复核）→ 记录只留摘要。
- **拒绝即作废**：未批准或拒绝时 preparedId 不能发送（现有 `API_AGENT_APPROVAL_REQUIRED` 语义已覆盖）。
- **错误可行动**：目录/FIFO/设备/悬空链接 → `API_WORKBENCH_FILE_INVALID_TYPE` / `_MISSING`；超过 16 个 → `_FILE_LIMIT`；准备后文件被换掉 → `_FILE_CHANGED`（都已有稳定错误码）。
- **不做**：Agent 读取文件内容、跨会话复用引用、批准后换文件重发。

## 4. 明确不做

- 不做大文件流式上传（当前上限 20 MiB，一次性读入主进程内存）；不做断点续传、不做多文件并行读取优化。
- 不把文件路径写进请求定义或运行记录；不提供「历史里重新上传同一文件」的自动重读。
- 不引入新的 multipart 依赖：边界、`Content-Disposition`、文件名转义自己按 RFC 7578 生成并单测（含中文/引号/换行文件名的转义与拒绝）。

## 5. B12b 验收证据（2026-09-25）

已交付行为（对应用户指定文件 + 确认授权）：

- **工具 schema**：`request.body.kind` 放开 `multipart`，`request.body.files[]` 只接受 `{ id, name, path, contentType? }`；`ref`/`fileName`/`sizeBytes` 等 Host 才有权知道的事实一律拒绝，数量沿用 16 上限。
- **路径只活在两处**：facade 在 prepare 阶段把声明路径交给 `ApiFileStore.register`（`realpath` + `stat`，**不读字节**），把 `path` 换成 `ApiFilePart` 引用；真实路径只留在待批准快照与文件仓库。模型可见的准备回执、请求定义、运行记录里都只有引用、文件名与大小。
- **时序**：`api_prepare_request`（stat）→ `approval('api_send_request')` 快照带 `files[{field, path(realpath), sizeBytes}]` → 审批卡逐行展示 → 批准后 `send` 才读取字节（读取前复核 inode/时间戳，换文件即 `API_WORKBENCH_FILE_CHANGED`）→ 记录只留 `attachments` 摘要。
- **字节读取时点**：B12a 原本在 prepare 阶段读字节合成 `bodyBase64` + `attachments`，本轮改成**真正派发时**（`send`）读取——否则 Agent 声明的文件会在用户批准之前被读。已知大小之和仍会在 prepare 阶段先判 `API_WORKBENCH_MULTIPART_TOO_LARGE`，避免为发不出去的请求弹确认。
- **审批卡**：复用 `api-approval-view` 与 `PermissionBanner`，新增「本次将读取并上传的文件（批准后才读取字节）」区块，逐行 `字段 X：<realpath>（n 字节）`，并写明符号链接已按 realpath 展开、目录与特殊文件不会出现。
- **失败可行动**：目录/设备/FIFO → `API_WORKBENCH_FILE_INVALID_TYPE`；悬空链接/不存在 → `_MISSING`；超 16 个 → `_FILE_LIMIT`；声明了文件但正文不是 multipart → `API_WORKBENCH_INVALID: body.files.multipartOnly`；批量登记中任一条非法整批回滚，准备失败也会回滚已登记的引用（否则失败的准备会白占文件槽位）。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 定向回归（工作台主进程 / agent 组件 / preload / 共享合同与 IPC） | 417 pass / 0 fail，61 文件 | `/tmp/proma-api-b12b-targeted.log` |
| 全量回归（`bun test --isolate`） | 8169 pass / 6 skip / 5 fail；5 条失败都在未改动文件里（`release-workflow.test.ts` 2 条、`agent-service-route-rebind.test.ts` 3 条 `assertAgentSessionAcceptsInput is not defined`），与本增量无关 | `/tmp/proma-b12b-full-escalated.log` |
| `bun run typecheck` | 7 workspace 全部通过 | `/tmp/proma-api-b12b-typecheck.log` |
| `bun run electron:build` | 通过，仅既有 EventKit 告警 | `/tmp/proma-api-b12b-build.log` |
| 真实 Electron 端到端（`api-workbench-smoke.ts`） | PASS，网络调用 17 次：Agent 声明符号链接路径 → 准备回执不含真实路径、摘要用真实文件名 → **未批准发送被拒且 0 次网络调用** → 审批快照给出 `{field:'file', path: realpath, sizeBytes}` → 批准后服务端逐字节收到附件、文件名来自 realpath → 运行记录只有 sha256 摘要、无路径无字节 → 批准后换文件被 `FILE_CHANGED` 拒绝（网络调用数不变）→ 目录与 `/dev/null` 在准备阶段被拒 | `/tmp/proma-api-b12b-smoke.log` |
| 真实界面（`api-workbench-ui-smoke.ts`） | PASS（无回归）：multipart 选择文件、文件行、保存后定义只含引用元数据仍全部通过 | `/tmp/proma-api-b12b-ui-smoke.log` |

已知边界（有意保留）：

- 模型自己的工具调用参数（含路径）由 SDK 写进会话记录，这一点不由本应用控制；本应用保证的是**自己的**请求定义、运行记录、预览与模型回执里不再出现路径。
- 保存下来的请求只保留引用，重启后引用失效，必须重新声明路径或重新选择文件（这正是「路径不入库」的代价）。
- 审批快照里的附件行只随权限事件发到本机渲染进程用于展示（Agent 岛、桌面通知与 LAN 订阅只读工具名/状态，拿不到附件行），不落盘、不复用。
