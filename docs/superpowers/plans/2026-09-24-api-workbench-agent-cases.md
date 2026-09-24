# 接口工作台 B7b：让 Agent 创建与分析测试用例（实施计划）

> 前置：阶段 B7 已交付具名用例的契约、执行、报告与界面（见 `2026-09-24-api-workbench.md` 阶段 B7，main `847c850c`）。
> 本计划只解决一件事：**Agent 能否自己出题**。它涉及「测试结论可信度」这条信任边界，实施前必须先确认设计取舍。
> 状态：**已按默认取舍实施完毕**（提交 `1e851ef2`、`825b5f4b`、`264318c0`、`4a219bf0`，验收记录见第 8 节）。

## 1. 现状（代码事实，已逐条核对）

| 事实 | 位置 |
| --- | --- |
| Agent 工具 `api_prepare_request` 的 `draft` schema **没有 `cases`**，且 `additionalProperties: false` | `apps/electron/src/main/lib/api-workbench/api-agent-tools.ts:20` |
| 实测该 schema 拒绝 `cases`、接受 `assertions` 与 `caseId` | `Value.Check(...)`：`cases=false`、`assertions=true`、`caseId=true` |
| SDK 校验失败会把该次工具调用变成错误结果（fail closed，不静默丢弃） | `@earendil-works/pi-ai` `validateToolArguments` ← `@earendil-works/pi-agent-core` `agent-loop.js` |
| Host 侧其实已放行：`prepare` 的覆盖键 = `Object.keys(base)`，而 `base` 是完整草稿（含 `cases`） | `api-agent-facade.ts:141` |
| 保存写的就是完整草稿，新请求 `id: randomUUID()` | `api-agent-facade.ts:168` |
| 已有用例对 Agent 可见：`api_get_request` 返回脱敏后的完整定义（含 `cases`） | `api-agent-facade.ts` `get()` |
| 保存与发送各自需要一次逐条批准，plan 模式拒绝，`bypassPermissions` 免批 | `agent-orchestrator.ts:1513` |
| 审批卡目前把 `toolInput` 原样渲染成 JSON，看不出用例差异 | `apps/electron/src/renderer/components/agent/PermissionBanner.tsx` |

结论：**缺的只是「schema 放开 + 谁出的题要能追溯」这两件事**，执行链路零改动。

## 2. 目标行为

1. Agent 可以声明用例（含断言、可选覆盖与环境），保存进项目资产。
2. Agent 只能改**自己创建**的用例；人写的用例不可被改名、改断言、改覆盖或被删除。
3. 用例来源（人 / Agent）由 **Host 盖章**，模型无法伪造。
4. 「保存接口」的审批卡显示**用例级差异**（新增 / 修改 / 删除 + 来源 + 断言条数），而不是一坨 JSON。
5. 报告、运行历史、界面三处都标注来源；报告结论语义不变——失败 / 取消 / 中断的运行永远不算通过。
6. 本轮**不新增批量发送工具**：Agent 仍逐个 `prepare + send`，每次发送各自审批（审批粒度不稀释）。

## 3. 设计

### 3.1 共享合同（`packages/shared/src/types/api-workbench*.ts`）

- `ApiTestCase` 增加可选 `source?: 'user' | 'agent'`；解析器 `testCase()` 的键白名单加 `source`，缺省补 `'user'`（B7 之前保存的用例都是人建的，这个默认是诚实的）。
- `ApiCaseReportRow` 增加可选 `source`；`formatApiCaseReportCells` / `formatApiCaseReportMarkdown` 增加「来源」列（复制文本随之变化，需要同步更新既有 4 个报告的逐字断言）。
- 版本兼容：`cases` 里的新键只影响**能解析 `cases` 的构建**；B7 之前的老版本读同一目录本来就会因未知字段拒绝整列表，因此本次不新增同级别风险，但要在验收里说明。

### 3.2 工具 schema（`api-agent-tools.ts`）

- `draft.cases`：`id`（`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`，模型自己生成，如 `case_login_401`）、`name`、`assertions`（≤64 条）、可选 `overrides`、可选 `environmentId`；数组 ≤16 条。
- 工具描述必须写明三件事：**整体替换语义**（传 `cases` 就是这一整套）、**不能修改/删除来源为人的用例**、**用例会进入项目资产、需人工复核后才作为验收依据**。

### 3.3 保存守卫与来源盖章（`api-agent-facade.ts` 的 `save`）

在既有的 `requireGrant → getCatalog → CAS 写入` 之间加一段纯逻辑（可单测）：

1. 取旧定义 `old.cases ?? []`，与新草稿 `draft.request.cases ?? []` 逐 id 比对。
2. 出现以下情况一律拒绝，返回稳定错误码 `API_WORKBENCH_USER_CASE_PROTECTED`，消息里说明「人写的用例不能被 Agent 修改或删除，请只新增自己的用例」：
   - id 在旧定义里且 `source === 'user'`，但 `name` / `assertions` / `overrides` / `environmentId` 任一变化；
   - 旧定义里 `source === 'user'` 的 id 在新草稿里消失。
3. 其余情况盖章：新增的用例、以及被 Agent 改过且原本来源为 agent 的用例，`source = 'agent'`；未改动的人写用例保持 `'user'`。新请求（无 `old`）里出现的用例全部为 `'agent'`。
4. 人的编辑不受影响：界面保存走 `renderer → IPC → service.saveCatalog`，不经过 facade，守卫天然只作用于 Agent 通道。

### 3.4 审批卡（结构化差异）

- facade 的 `approval('api_save_request')` 除现有脱敏 `definition` 外，新增 `caseDiff`：`Array<{ caseId, caseName, source, change: 'added' | 'updated' | 'removed', assertionCount }>`，只含身份与计数，不含断言值与秘密。
- `api_send_request` 的审批卡改为结构化展示：method / url / 环境 / `caseId`（若按用例执行）/ 断言条数。
- `PermissionBanner.tsx` 对这两个工具渲染结构化块，其余工具保持现有 JSON 兜底；删除用例的差异用红色并列在首位（Deletion 必须一眼看到）。

### 3.5 界面与报告

- `CaseEditor` 行内加「Agent」徽标（`source === 'agent'`），`createApiCase` 默认 `source: 'user'`；人新增的用例始终是 `user`。
- 用例报告弹层与复制文本都带来源列；`ApiWorkbench` 的 `run.caseId` 标注沿用「用例 X · 断言 x/y」，来源只在用例与报告处体现，避免运行头部过载。

## 4. 实施顺序（每步一个提交，先测试后实现）

1. 共享合同：`source` 字段 + 报告来源列 + 枚举/默认值 BDD（含「未知来源被拒绝」「缺省补 user」）。同步更新既有报告的逐字断言。
2. facade 守卫与盖章：先写「人写用例被改 / 被删 → 拒绝」「Agent 用例可改可删」「新增盖章 agent」「新请求全部 agent」「人未改动用例保持 user」的回归，再实现。含 `caseDiff` 生成。
3. 工具 schema 加 `cases`，更新工具描述；补一条「模型传 `cases` 能通过 schema 校验」的测试（避免只靠人工读 schema）。
4. 审批卡结构化渲染 + 界面「Agent」徽标 + 报告来源列接线；补渲染层/界面契约测试。
5. 真实验收：
   - `bun test packages/shared/src/types apps/electron/src/main/lib/api-workbench apps/electron/src/renderer/components/api-workbench apps/electron/src/preload`
   - `bun run typecheck`、`bun run electron:build`
   - `api-workbench-smoke.ts` 扩展：Agent 新建含用例的请求 → 断言盖章为 agent、报告带来源；人改动该用例后 Agent 再保存被拒（`API_WORKBENCH_USER_CASE_PROTECTED`）、Agent 再新增第二条用例成功。
   - `api-workbench-ui-smoke.ts` 扩展：「Agent」徽标、审批卡差异块。
6. 合并：与 B7 相同，**按显式路径提交**（`git checkout codex/api-cases -- <paths>` + `git commit <paths>`），避免带上主工作区其它会话的暂存内容。

## 5. 影响与风险

- **最大风险是语义**：模型能出题以后，「跑全部用例 5/5 通过」可能只是模型自己写的断言全对。缓解措施是本计划的第 2、3.4、3.5 步（来源盖章 + 审批差异 + 报告标注），缺一不可；只做第 1、3 步等于放开自证。
- 报告新增「来源」列会改变复制文本的形状（下游客若要解析需同步）。
- 守卫会让模型偶尔收到拒绝。错误码与消息必须可行动（「请只新增自己的用例」），否则模型会反复重试同一份被拒草稿。
- 不做批量发送工具意味着 N 条用例 = N 次发送审批。这是有意的：批量一次批准会把「每条用例各自出网」的可见性压成一次确认。

## 6. 本轮不做

- `api_run_cases` 之类的批量发送工具（需要新的审批语义，单独设计）。
- 用例跨项目共享 / 用例库 / Agent 自动根据失败结果改写断言。
- 把「Agent 生成的用例」当作验收结论的自动化判定；报告只如实标注来源。

## 7. 取舍（已拍板，按默认实施）

1. **人写用例硬保护：采用**。`source` 为 `user`（含升级前缺省）的用例不允许被 Agent 改断言、改名、改覆盖或删除，违规在**审批之前**就以 `API_WORKBENCH_USER_CASE_PROTECTED` 拒绝；人的编辑走 IPC + service 另一条路径，不受影响。
2. **报告新增「来源」列：采用**。界面表格、复制出的 Markdown 与运行历史都带来源；代价是复制文本多一列（既有逐字断言已同步更新）。

## 8. 已交付与验收记录（2026-09-24）

已交付行为：

- `ApiTestCase.source`（`'user' | 'agent'`，解析缺省 `user`，第三种取值拒绝）；`ApiCaseReportRow.source` 与报告的「来源」列。
- `stampApiAgentCases`：新增或改动过的用例由 Host 盖章为 `agent`，模型自称的来源被忽略；人写用例保护如上。
- `api_prepare_request` 的 `draft.cases`（≤16 条、每条断言 ≤64、用例身份与共享解析器同一白名单；schema 显式拒绝 `source`）。
- 审批卡结构化：发送显示 目标 / 请求名 / 环境 / 「用例 X（n 条断言）」或「请求自身默认断言 n 条」；保存逐条列出用例 新增 / 修改 / 删除（删除标红），并提示 Agent 用例需人工复核。
- 界面：「用例」分区对 agent 用例显示 `Agent` 徽标；报告弹层与复制文本带来源列。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 定向回归（共享合同 / 主进程工作台 / 工作台界面 / preload / agent 组件） | 802 pass / 0 fail，98 文件 | `/tmp/proma-api-b7b-targeted.log` |
| `bun run typecheck` | 7 workspace 全部通过 | `/tmp/proma-api-b7b-typecheck.log` |
| `bun run electron:build`（隔离工作树，重建 preload/main/renderer） | 通过，仅既有 EventKit 告警 | `/tmp/proma-api-b7b-build.log` |
| 真实 Electron 端到端（`api-workbench-smoke.ts`） | PASS；网络调用仍 10 次，含 Agent 建带用例的接口（来源盖章为 agent）、按人工用例执行的发送审批摘要、人写用例被改/被删在审批前拒绝、保留人工用例并追加 Agent 用例成功、报告来源列 | `/tmp/proma-api-b7b-smoke.log` |
| 真实界面（`api-workbench-ui-smoke.ts`） | PASS；用例页签与报告（含来源列）、复制报告、逐行打开运行、目录用例数量、Agent 用例来源徽标 | `/tmp/proma-api-b7b-ui-smoke.log` |

截图：`/private/tmp/api-workbench-ui-agent-case.png`（Agent 徽标）、`/private/tmp/api-workbench-ui-cases.png`（报告来源列）。

过程中抓到的真实缺陷：第一次验收失败在 `API_WORKBENCH_INVALID: case`，根因是 **preload 里也内置了一份共享解析器**，改了共享合同却只重建 smoke 包时，preload 仍用旧白名单拒绝带 `source` 的目录。结论：改 `packages/shared` 的解析合同后，必须重建 preload/main/renderer（`bun run electron:build`），只重建被测脚本不够。

未交付 / 有意不做：`api_run_cases` 之类的批量发送工具（需要新的审批语义）；用例跨项目共享；Agent 自动根据失败结果改写断言；把 Agent 用例的通过率当作验收结论。
