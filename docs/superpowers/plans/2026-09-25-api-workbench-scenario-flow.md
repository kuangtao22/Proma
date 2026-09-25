# 接口工作台 B13：场景流程与一次批准（实施计划）

> 用户 2026-09-25 定调：**B13a 分组即维度**（不新增「模块 / 端」字段，用现有集合 + 文件夹表达）、**B13b 新增场景（流程）实体**、**B13c 一次批准整个流程**。
> 本计划把这条路线落成「场景定义 → 一次批准 → 串行执行 → 逐步证据 + 流程结论」，并明确仍然不做无人值守。

## 1. 分组即维度（B13a，无代码改动）

- 现有结构：`ApiCollection`（顶层分组，可带默认变量）→ `folder`（请求上的单层字符串，界面按它聚成文件夹）→ 请求。
- 约定：**集合 = 端 / 产品线**（`APP`、`后台`、`H5`…），**文件夹 = 模块**（`用户模块`、`订单模块`…）。这正是用户要的「按模块 / 按端建接口」，不需要新增字段，也不会产生第二套分组真相。
- Agent 已经能写 `folder`（`api_prepare_request` 的 draft 含 `folder`），因此 Agent 可以把新建接口直接放进对应模块文件夹；集合与环境仍由人在界面或导入快照里建（Agent 没有目录写入口，这是既有边界）。
- 因此 B13a 只在本计划与 MEMORY 里固化命名约定，不改代码、不改合同。

## 2. 硬约束（B13b / B13c 新增，实施前先认这几条）

1. **场景不复制请求定义**：`ApiScenarioStep` 只引用 `requestId`（+ 可选 `caseId`、环境覆盖、变量覆盖、失败策略），不内联 draft。理由：内联会出现「同一条请求两处定义」，跑出来的证据无法对上人维护的那一份。Agent 想内联内容，先 `api_save_request` 建请求。
2. **一次批准 = 整流程一次出网授权**：审批卡逐行列出「序号 / 步骤名 / 方法 / host+path / 环境 / 用例 / 断言条数」；发送时逐步与批准快照核对（方法、最终 URL 的 origin 与 path、caseId、环境），任何一步不一致 → 整流程拒绝（`API_WORKBENCH_SCENARIO_APPROVAL_STALE`），已完成的步骤保留证据但不再继续。这条替代了原来的「一次批准只发一次请求」，是本轮唯一的授权语义放宽，因此必须**逐步核对**而不是只核对了流程 ID。
3. **串行、有界**：步骤严格按声明顺序串行执行（不并发）；单步沿用请求自身 `timeoutMs`；整流程有总时限（默认 10 分钟），到点不再启动后续步骤并把剩余步骤标为 `skipped`；步骤数上限 20。
4. **失败策略显式**：`onFailure: 'stop' | 'continue'`，默认 `stop`（后续步骤标 `skipped`）；`continue` 时后续步骤照跑，流程结论仍按「任一步失败即失败」表达。
5. **环境与 production**：场景有默认环境，步骤可覆盖（优先级：步骤覆盖 > 场景环境 > 请求自身标记）；解析结果里只要出现 `production`，审批卡与警告必须显著标注，UI 运行确认框同样显示。
6. **变量只复用运行时变量**：登录步骤提取 `{{token}}` → 后续步骤在 URL/Header/正文里用 `{{token}}`，沿用现有提取与运行时变量（1 小时、内存、每 workspace）。场景不引入第二套变量作用域。
7. **附件不新增路径入口**：步骤里的 multipart 只能引用**已保存请求**里的文件引用；引用失效（重启/清理）时该步 `API_WORKBENCH_FILE_*` 失败，绝不静默发出不带附件的请求。Agent 若要在流程里上传本机文件，先按 B12b 在请求上声明路径。
8. **证据分层**：每一步仍是独立的 `ApiRun`（完整证据在既有 `runs/` 目录，受既有 7 天 / 1 GiB 预算约束）；场景运行另存一份**紧凑摘要**（步骤 runId、状态、断言通过数、耗时，无正文、无秘密），条数上限 200，随 workspace 清理一并删除。

## 3. 分层设计

- **共享合同**（`packages/shared/src/types/api-workbench.ts` + `api-workbench-ipc.ts`）：
  - `ApiScenarioStep { id, name, requestId, caseId?, environmentId?, overrides?, onFailure? }`
  - `ApiScenario { id, name, description, collectionId, folder, steps, environmentId?, onFailure, revision, updatedAt }`
  - `ApiScenarioRun { id, workspaceId, sessionId, source, scenarioId?, scenarioName, catalogRevision, environmentId?, state, startedAt, finishedAt?, steps: ApiScenarioStepOutcome[], assertions: ApiAssertionResult[], error? }`
  - `ApiScenarioStepOutcome { stepId, name, runId?, state: 'passed'|'failed'|'skipped'|'error', status, assertionPassed, assertionTotal, durationMs, message? }`
  - `ApiCatalog` 增加**可选** `scenarios`（解析缺省补空数组，与 `cases`/`extractions` 同一套升级兼容模式，`version` 仍为 1）。
  - 新错误码：`API_WORKBENCH_SCENARIO_NOT_FOUND`、`_STEP_LIMIT`、`_REQUEST_NOT_FOUND`、`_CASE_NOT_FOUND`、`_APPROVAL_STALE`、`_TIMEOUT`、`_RUNNING`。
- **存储**：`ApiWorkbenchStore` 增加场景运行的紧凑记录（`workspaces/<id>/scenario-runs/<runId>.json` + 一个 `list` 用轻量索引），复用 `safe-file` 原子写与 workspace 事务；目录/摘要随 workspace 删除，另有 200 条上限。
- **服务层执行器**：`ApiWorkbenchService.runScenario(context, preparedId, signal)`——按批准快照逐步 `prepare → send`，逐步核对步骤身份，聚合断言结论，产出 `ApiScenarioRun`；沿用现有调度、去重、取消与脱敏。
- **facade**：新增三个窄工具，保持「精确快照 + 独立批准」的既有形状：
  - `api_list_scenarios`（并入 `api_list` 输出，不新增工具）
  - `api_save_scenario`（draft + `expectedRevision` 审批；与 `api_save_request` 同样的目录 CAS）
  - `api_prepare_scenario`（解析每一步，返回步骤清单预览 + `preparedId`）
  - `api_run_scenario`（审批一次整流程，批准后执行；重复调用复用同一次运行）
- **IPC / preload / renderer**：`getCatalog` 已带场景定义；新增 `listScenarioRuns` / `getScenarioRun` / `runScenario`（界面路径由人自己点「运行场景」，弹确认框列出步骤与目标环境，不走 Agent 审批）；工作台新增「场景」分区：列表、步骤编辑（名称/顺序/用例选择）、一键运行、逐步结果面板（点步骤打开对应 runId）。
- **审批卡**：`api-approval-view` 增加 `scenario` 区块（步骤逐行 + 目标环境 + production 警示），`PermissionBanner` 渲染。

## 4. 实施步骤（每步独立可验收）

1. **合同与解析**：上述类型 + `parseApiScenario` / `parseApiScenarioRun` + `ApiCatalog.scenarios` 兼容解析；BDD 覆盖：步骤上限、重复步骤身份、引用不存在的用例/请求、未知字段、缺省空数组。
2. **服务层执行器**：串行执行、失败策略、总时限、逐步核对、提取与运行时变量串联、场景运行摘要落盘 + 列表/读取；BDD 覆盖：登录提取 → 后续步骤用 `{{token}}`、某步断言失败、某步超时、引用失效文件、取消流程。
3. **facade 与审批快照**：`api_save_scenario` / `api_prepare_scenario` / `api_run_scenario`；审批快照带逐步清单；BDD 覆盖：未批准不能跑、批准后目录变化整流程拒绝、步骤 URL 被改拒绝、重复调用只跑一次。
4. **界面**：场景分区（列表/编辑/一键运行/结果面板）+ 确认框；界面 smoke 覆盖：建场景 → 运行 → 逐步结果 → 打开某步 runId。
5. **真实验收**：真实 Electron 端到端跑一条三步骤流程（登录 → 用 `{{token}}` 拉用户详情 → 创建订单），断言：一次批准、三步真实出网且顺序正确、第二步确实带上了第一步提取的 token、逐步断言结论与流程结论一致、场景摘要里没有正文与秘密；随后把证据补进本文件。

## 5. 明确不做

- **不做无人值守**：接口能力仍只发给用户触发的普通会话（facade 对 `automation` 来源返回无能力），定时任务/后台 Agent 依旧不能调用这组工具；要做「定时跑流程」必须先单独设计授权模型（只对 local/test 环境）。
- 不做步骤并行、不做条件分支/循环/重试策略，不做场景级自定义断言（第一版用每步用例的断言聚合出流程结论）。
- 不把场景定义复制成第二份请求定义；不做跨会话复用文件引用；不做流程级秘密（沿用请求与环境的秘密解析）。

## 6. 验收证据（实施后补）

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 定向回归（共享合同 / 服务层 / facade / IPC / 渲染层 / preload） | 待实施 | — |
| `bun run typecheck` | 待实施 | — |
| `bun run electron:build` | 待实施 | — |
| 真实 Electron 端到端（三步骤流程，一次批准） | 待实施 | — |
| 真实界面（场景分区 + 运行确认 + 逐步结果） | 待实施 | — |
