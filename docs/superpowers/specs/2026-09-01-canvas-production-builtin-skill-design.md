# Canvas Production 内置 Skill 设计

日期：2026-09-01

## 结论

Proma 画布开放能力采用现有 `automation`、`agent-collaboration`、`in-app-browser` 的同类架构：原生工具提供可信能力与权限边界，Proma 内置 Skill 提供触发判断、产物路由和操作流程。

新增单一内置 Skill `canvas-production`。它不实现 Canvas 存储、IPC、权限、revision、事务、运行器或付费审批，也不决定工具是否真正可执行。它只指导 Agent 在合适的用户意图下调用 Proma 已注入的 Canvas 工具。

## 用户问题

当前 Canvas 原生工具已经能读取关联、管理画布、读取节点、修改图结构、创建或更新产物和运行节点，但工具使用流程主要写在 `canvas-tool-provider.ts` 的固定 `systemPromptAppend` 中。

这会产生三个问题：

1. 所有普通项目 Agent 运行都会携带较长的 Canvas 操作说明，即使当前任务与画布无关。
2. 产物选择、澄清策略和操作顺序属于可迭代的工作流知识，却与原生权限和工具 Schema 一起发布，修改成本和回归范围过大。
3. 用户无法在 Proma 的 MCP/Skills 页面发现、停用或理解 Canvas 的 Agent 编排能力，产品模式与其它 Proma 内嵌能力不一致。

## 目标

- 让涉及画布、文档产物、WebView 原型、图片设计稿、生图任务、节点关系和可视化交付物的请求稳定触发 `canvas-production`。
- 让普通代码开发、项目 HTML/React 文件修改和泛化“设计”讨论不因关键词误入 Canvas。
- 把产物选择、一次澄清、标准工具顺序、版本迭代和失败处理迁入 Skill。
- 继续由原生代码执行项目归属、绑定、访问授权、revision、事务、容量、付费审批和破坏性操作校验。
- 沿用 Proma 默认 Skill 的分发、版本升级、启用/停用和 UI 展示机制，不新增第二套 Skill 系统。

## 非目标

- 不把 Canvas 原生工具改为 MCP。
- 不让 Skill 直接读写 Canvas JSON、受管产物目录、会话索引或内部 IPC。
- 不以 Skill 激活结果作为权限授予、项目授权或付费审批依据。
- 不在本次引入新的 Canvas 工具、Artifact 类型、执行器或持久化格式。
- 不把现有全部 Canvas 系统设计复制进 Skill。

## 对齐 Proma 内置 Skill 风格

### 目录与 frontmatter

新增：

```text
apps/electron/default-skills/canvas-production/
└── SKILL.md
```

使用与现有 Proma 内置 Skill 相同的 frontmatter：

```yaml
---
name: canvas-production
description: Proma 内嵌画布产物生产 Skill。当用户要求创建、修改或迭代画布、文档产物、WebView 原型、网页预览、图片设计稿、生图任务、节点关系或可视化交付物时使用；普通项目代码修改、HTML/React 源码开发不得仅因出现“网页”“设计”等词自动转入画布。
group: proma
version: "1.0.0"
---
```

`description` 是主要触发入口，必须同时覆盖正向意图和高风险误触发边界。`group: proma` 让 UI 与其它 Proma 内嵌能力归组。后续每次修改目录内容都递增 `version` 的 patch 位。

### 正文结构

`SKILL.md` 控制在 250 行以内，不增加脚本、模板或重复 API 文档。正文依次包含：

1. `# Proma Canvas Production`：说明这是 Proma 内嵌能力。
2. `## 核心原则`：Skill 负责编排，原生工具负责可信执行。
3. `## 先选择正确产物`：区分普通代码、文档、WebView、图片和多产物任务。
4. `## 标准工作流`：获取上下文、必要时创建/关联、读取、创建/更新、明确要求时运行、回读验收。
5. `## 工具使用`：列出七个稳定 Canvas 工具及用途，不复制完整 Schema。
6. `## 权限与审批`：说明 plan/execute 是上限，删除、覆盖和付费行为仍由 Host 裁决。
7. `## 失败处理`：revision 冲突重新读取，部分成功先对账，不直接改内部文件。
8. `## 常见错误`：禁止关键词路由、重复询问、WebView 创建后误运行、图片未授权自动生图、绕过工具写文件。

## 能力分层

### 必须保留在原生层

- 七个 `canvas_*` 工具的 TypeBox Schema、类型和实现。
- 项目、会话、Canvas binding 与显式节点引用的权威校验。
- `permissionCeiling`、单次审批工具列表和运行代次校验。
- revision 冲突、批量事务、journal、幂等和不确定提交对账。
- 读取字符预算、路径边界、WebView sandbox、Artifact Registry 和执行器路由。
- 删除、覆盖、运行、付费、生图和外部导出的最终裁决。

上述约束即使 Skill 被停用、未触发或被用户编辑也必须成立。

### 迁移到 Skill 层

- 根据完整用户语义判断是否进入画布，禁止关键词硬编码。
- WebView 原型、图片设计稿、普通代码三类模糊请求的一次性询问。
- 明确请求不重复询问。
- `canvas_get_context → canvas_manage → canvas_read/create/update → canvas_run_nodes` 的条件工作流。
- 文档传 Markdown、WebView 传单文件 HTML、图片传可执行提示词的产物准备规则。
- WebView 创建后直接预览，不调用 `canvas_run_nodes`。
- 图片只有在用户明确要求立即生成时才调用 `canvas_run_nodes`。
- 关系类型选择、版本更新和执行后回读验收的操作建议。

### 原生层保留的最小提示

`canvas-tool-provider.ts` 的 `systemPromptAppend` 不完全删除，只保留不可绕过且与工具同时可见的短合同：

- Canvas 工具只作用于当前项目、当前会话已关联或明确引用的画布。
- 不得直接修改 Canvas 内部文件或调用未公开 IPC。
- plan/execute 只是 Host 权限上限，删除、覆盖和付费运行仍需满足原生审批。
- 操作流程和产物路由遵循已激活的 `canvas-production` Skill；Skill 未激活时仍以工具 Schema 和原生拒绝结果为准。

这一小段不是 Skill 的重复副本，只负责在 Skill 未触发时维持安全语义。

## 触发与路由

### 应触发

- “在画布里做一个活动页原型。”
- “把这份研究结论整理成画布文档，并和参考图连接。”
- “生成三张宣传图，放进当前画布。”
- “更新这个 WebView 节点，保留旧版本。”
- “读取我引用的节点，再创建一个衍生方案。”
- “为产品发布准备文案、图片和移动端页面。”

### 不应自动触发

- “修改项目里的 React 首页组件。”
- “解释一下这个页面为什么白屏。”
- “评审当前视觉设计方案。”
- “优化 HTML 文件的 SEO。”
- “写一个图片压缩脚本。”

除非用户同时明确要求把结果创建、修改或管理为 Canvas 产物。

### 需要一次澄清

用户只说“做一个首页”“帮我出个视觉方案”等，且无法判断需要可交互 WebView、静态图片设计稿还是普通项目代码时，使用现有 `AskUserQuestion` 询问一次。选项沿用当前产品合同：

- 创建 WebView 原型
- 创建图片设计稿
- 继续普通 Agent

## 分发与升级

`canvas-production` 随 App bundle 进入 `apps/electron/default-skills`。启动时复用现有流程同步到 `~/.proma/default-skills/`，并注入所有工作区：

- 新用户和缺失 Skill 的旧工作区默认放入 active Skills。
- 已存在目录仅在 bundled `version` 更高时升级。
- 用户已停用 Skill 时仍在 inactive 目录升级，不擅自重新启用。
- Skill 被停用只影响 Agent 的主动发现和编排提示，不撤销 Canvas UI、原生工具安全合同或既有产物访问规则。

## 测试设计

### Bundled Skill 合同测试

新增 `apps/electron/src/main/lib/default-canvas-production-skill.test.ts`，读取真实 `SKILL.md` 并断言：

- `name: canvas-production`、`group: proma`、合法 `version` 存在。
- description 覆盖 Canvas、文档、WebView、图片、生图和普通代码排除边界。
- 正文列出七个稳定 Canvas 工具。
- 明确禁止直接修改内部文件和绕过原生审批。
- 明确 WebView 不运行、图片仅在明确要求时运行。

### 原生提示合同测试

调整 `canvas-tool-provider.test.ts`：

- 不再断言已迁移到 Skill 的长流程原文。
- 继续断言原生提示包含项目/关联边界、禁止旁路和 Host 权限上限。
- 七个工具、`allowedToolNamesMode: extend` 和 `singleApprovalToolNames` 保持不变。

### Skill 行为场景

用固定场景验证触发和路由：

1. 明确 Canvas WebView 请求直接进入创建流程，不重复询问，不运行节点。
2. 明确图片并要求立即生成时创建配置后请求运行审批。
3. 普通 React 页面修改保持项目代码路径，不调用 Canvas 工具。
4. 模糊“做首页”只询问一次，并根据回答选择路径。
5. Skill 停用时原生工具仍拒绝越权、跨项目和未审批运行。

## 性能与资源影响

非 Canvas 请求不再固定携带完整工作流说明，可减少每次 Agent 运行的提示 Token。Canvas 请求触发 Skill 后会加载一份不超过 250 行的说明，开销只在相关任务发生。

原生工具仍按当前方式注入，因此本阶段不改变工具 Schema Token、主进程 I/O、Renderer 状态或打包依赖。后续若要按 Skill 激活懒加载工具，必须另立设计并解决“激活前不可调用工具”和恢复会话能力一致性问题，本次不做。

## 用户影响

- 用户在 MCP/Skills 页面能看到 Proma 自带的 Canvas Production 能力，并可按工作区停用。
- 相关请求的产物选择和工具顺序更一致，普通代码任务不容易误入画布。
- Skill 升级可独立于 Canvas 存储和权限代码迭代，降低小幅流程调整的发布风险。
- Skill 停用不会降低原生安全边界，也不会删除 Canvas、会话或产物。

## 验收标准

1. `canvas-production` 使用 Proma 默认 Skill 目录、frontmatter、版本和升级机制。
2. 原生工具、安全校验、权限和审批不迁入 Skill。
3. Skill 正确覆盖五类正向场景、五类排除场景和一次澄清流程。
4. `systemPromptAppend` 明显缩短，但仍保留项目归属、禁止旁路和权限上限。
5. 七个 Canvas 工具的 API、allowlist 模式和审批列表不变。
6. Bundled Skill 合同、Canvas tool provider 测试、typecheck 和 Renderer build 全部通过。
