# 接口工作台 B8：自动 Cookie Jar（实施计划）

> 前置：阶段 A 已明确「SSE、上传、代理、自动 Cookie Jar 和导入属于已批准路线中的下一增量」；B1–B7b 已交付导入导出、事件流、事件断言、变量提取、运行时变量面板、按用例执行与 Agent 出题。
> 本轮只做 **自动 Cookie Jar**，其余三项各自单独评估。
> 状态：**已交付**（提交 `72b69df0`、`d2215b30`、`68a552f3`、`41626f51`，验收记录见第 6 节）。

## 1. 要解决的问题

会话型接口（登录拿 `Set-Cookie`，后续请求带 `Cookie`）现在只能靠人工复制：手工加 `Cookie` 头，或用「提取」把 `Set-Cookie` 抄进运行时变量再拼 `{{token}}`。这正是「重复三遍就该自动化」的场景，但自动化带来两个必须由设计兜住的风险：**隐形的成功/失败变化**（某条请求因为上次的 cookie 而通过）与 **凭据外泄**（cookie 值进入运行记录、模型上下文或磁盘）。

## 2. 设计（三条硬约束）

1. **默认关闭，按请求显式开启**：`ApiRequestDraft.useCookieJar`（缺省 `false`，向后兼容）。关闭时既不读也不写 cookie，行为与今天完全一致，不存在「悄悄成功」。
2. **只活在主进程内存**：按 workspace 隔离，跟随主进程生命周期（服务关闭即清空），不落盘、不新增加密文件格式、不进入运行记录与历史摘要。元数据（名/域/路径/过期/HttpOnly）可回传界面；**值永不出主进程**。
3. **只回送到同一 host，且人写的头优先**：第一版不做 Domain 跨域共享（收到 `Domain=` 也不放宽作用域，按 host-only 处理）；路径前缀、`Secure`、过期时间参与匹配；草稿里已经显式写了 `Cookie` 头时以人的写法为准，不再叠加 jar。

## 3. 分层改动（不需要改 Utility 与传输协议）

- 传输层已经采集每次跳转的响应头（含重复 `Set-Cookie`），因此**主进程即可完成读写**：注入在请求解析阶段，采集在运行终态。
- 共享合同：`useCookieJar` 字段、`ApiCookieJarEntry` 元数据、`getCookieJar` / `clearCookieJar` 两条命令与严格回执解析（出现 `value` 之类字段直接判为损坏协议）。
- 请求解析器：`useCookieJar` 为真时按最终 URL（插值后）选 cookie，合成单个 `Cookie` 头并标记为敏感头（记录与预览按既有敏感规则脱敏）。
- 服务：**每 workspace 一份 jar**，与运行时变量同一套隔离与清理方式；运行终态采集所有跳转的 `Set-Cookie`（`Max-Age` / `Expires` 参与过期，`Max-Age=0` 或已过期即删除），条目数与值长度有界。
- 界面：请求「设置」页新增「自动 Cookie（仅本机内存）」开关；工具栏新增「Cookie」面板，列出元数据并支持刷新与一键清空。
- Agent：`api_prepare_request` 的草稿允许 `useCookieJar`（描述里写明只影响宿主内存），**不新增任何读取 cookie 值的工具**；模型看不到值，只能看到自己请求后端的响应头事实。

## 4. 明确不做（本轮范围外）

- 持久化 cookie、导入浏览器 cookie、Public Suffix List 级的 Domain/Path 矩阵、SameSite 强制策略。
- 代理与 multipart 文件上传（各自需要单独的授权模型决策）。
- 让 Agent 读取 cookie 值，或新增 Agent 侧批量运行工具。

## 5. 验收标准

1. 共享合同：`useCookieJar` 缺省 `false` 且合法；`ApiCookieJarEntry` 拒绝携带值字段；`getCookieJar` / `clearCookieJar` 命令与回执严格解析（拒绝伪造 workspace）。
2. 解析器：关闭时不注入；开启时按 host/路径/过期/secure 选值；显式 `Cookie` 头优先；注入的头被标记为敏感。
3. 服务：`Set-Cookie` 采集（含 `Max-Age`、`Expires`、删除语义）、跨 workspace 与跨 host 隔离、关闭时不写入、条目上限、清空、关闭服务即清空。
4. 四层契约与界面：IPC/preload/界面面板接线；请求设置开关；记录与预览里不出现 cookie 值。
5. 真实验收：`bun test`（共享合同 / 主进程工作台 / 工作台界面 / preload / agent 组件）、`bun run typecheck`、`bun run electron:build`、真实 Electron 端到端（登录后 jar 开启的后续请求确实带上 cookie，且运行记录与预览中查不到该值）、界面 smoke（开关、面板、清空）。

## 6. 已交付与验收记录（2026-09-24）

已交付行为：

- `ApiRequestDraft.useCookieJar`（缺省 `false`）在请求「设置」页是一个开关；解析器只在它为真、且草稿没有手写 `Cookie` 头时注入合成头（同时标记为敏感头）。
- 每 workspace 一份 jar，只活在主进程内存；运行终态逐跳采集 `Set-Cookie`（`Max-Age`/`Expires` 参与过期与删除；host-only 作用域；路径前缀匹配；`Secure` 只在 https 回送；条目 128 上限按最久未更新淘汰；值上限 4 KiB、头部预算 8 KiB，畸形/含 CR-LF 的值整条丢弃）。
- `getCookieJar`/`clearCookieJar` 两条命令只回元数据；界面工具栏「Cookie」面板列出名称、作用域、HttpOnly/Secure 与过期时间，并可刷新/清空。Agent 只多了 `useCookieJar` 布尔开关与一句说明，没有任何读取取值的参数。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 定向回归（共享合同 / IPC / 主进程工作台 / 工作台界面 / agent 组件 / preload） | 829 pass / 0 fail，100 文件 | `/tmp/proma-api-b8-targeted.log` |
| `bun run typecheck` | 7 workspace 全部通过 | `/tmp/proma-api-b8-typecheck.log` |
| `bun run electron:build` | 通过，仅既有 EventKit 告警 | `/tmp/proma-api-b8-build.log` |
| 真实 Electron 端到端（`api-workbench-smoke.ts`） | PASS；网络调用 14 次。首次请求不带 cookie → 服务端下发两条 → 开启自动 Cookie 的第二次请求服务端确实收到 `sid=smoke-cookie-1; theme=dark` → 关闭自动 Cookie 的请求收不到 → 清空后再发仍不带；注入的 `Cookie` 头在运行记录里是 `[REDACTED]`，元数据接口不含取值 | `/tmp/proma-api-b8-smoke.log` |
| 真实界面（`api-workbench-ui-smoke.ts`） | PASS；请求设置出现「自动 Cookie（仅本机内存）」开关，Cookie 面板显示元数据（含 HttpOnly 徽标与会话 cookie 文案）、一键清空为空状态、关闭弹层 | `/tmp/proma-api-b8-ui-smoke.log` |

截图：`/private/tmp/api-workbench-ui-cookie-jar.png`。

需要知悉的两条事实与坑：

- **服务端自己下发的 `Set-Cookie` 仍按原始网络事实留在运行记录里**（这是 B7 起就有的行为，用于调试「服务端到底发了什么」）；本增量保证的是**不会把 cookie 值写进磁盘、历史摘要、报告或模型上下文**。若将来要连服务端响应头一起遮罩，需要单独决策，因为它会损失证据。
- 已关闭的 Radix 弹层会**继续留在 DOM**（`data-state="closed"`），界面 smoke 里按文字找按钮必须限定在「当前打开的那层」，否则会点到隐藏弹层的同名按钮（本次踩到并已修正）。
- 新实例读同一个数据根拿不到任何 cookie：本能力**不落盘**，这也是「重启即失效」的实现方式。
