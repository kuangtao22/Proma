# Design 创作任务透明度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 Design 生图链建立稳定创作任务身份、可追溯任务详情，以及不污染普通 Agent 入口的内部执行会话生命周期。

**Architecture:** 保留 `DesignJobManager` 对单次尝试、占位节点、可信模型快照和恢复 journal 的所有权；新增 `creativeTaskId` 聚合同一任务的尝试，并用独立 `DesignTraceStore` 保存按需读取的 Thinking 与执行事件。Agent 会话层新增统一可见性判定和原子内部会话创建，所有用户查询与外部同步使用可见投影，Design 恢复和项目迁移继续使用内部全量索引。

**Tech Stack:** Bun、TypeScript、Electron IPC、Pi Agent Runtime、JSON/JSONL、React、Jotai、Radix/shadcn、BDD 风格 `bun:test`。

---

## 前置与范围

- 本计划是三阶段中的第 1 阶段；完成后再执行 `2026-08-24-design-project-context.md`，最后执行 `2026-08-24-agent-design-handoff.md`。
- 本阶段不开放项目文件读取工具；新任务暂以 `contextMode: 'none'` 运行，避免在安全边界完成前扩大权限。第 2 阶段会把 Design 表单默认值切换为 `auto`。
- 保留现有 GPT Image 2 / Nano Banana 可信路由、单次图片工具调用上限、`user + tool_result` 输出兼容、terminal pending、replacement retry 和可恢复删除。
- 所有自动化测试使用 fake Agent 和 fake image executor，禁止调用真实图片模型。

## 文件与职责

- `packages/shared/src/types/design.ts`：定义创作任务、透明度轻量字段、trace 详情和四层 IPC 契约。
- `packages/shared/src/types/design.test.ts`：锁定新旧 Job 兼容形状和新增通道。
- `apps/electron/src/main/lib/design/design-paths.ts`：新增 `tracesDir`，继续只由可信 projectId 解析路径。
- `apps/electron/src/main/lib/design/design-paths.test.ts`：锁定 trace 位于 Design cache 而非项目正式目录。
- `apps/electron/src/main/lib/agent-session-visibility.ts`：统一判断内部 Design 会话、用户可见会话和成对元数据合法性。
- `apps/electron/src/main/lib/agent-session-visibility.test.ts`：覆盖正常、内部和半损坏元数据的 fail-closed 行为。
- `apps/electron/src/main/lib/agent-session-manager.ts`：保留内部全量 API，新增可见列表与原子带元数据创建入口。
- `apps/electron/src/main/lib/agent-session-manager.test.ts`：覆盖创建时无可见窗口、列表、计数、搜索和引用过滤。
- `apps/electron/src/main/lib/design/design-trace-store.ts`：从内部 Pi SDK 消息提取 Thinking、真实图片工具参数和结构化事件，原子写/按需读 JSONL。
- `apps/electron/src/main/lib/design/design-trace-store.test.ts`：覆盖真实 Thinking、无 Thinking、精确 prompt、损坏 trace 和敏感字段清洗。
- `apps/electron/src/main/lib/safe-file.ts`：增加迭代式 JSONL 原子写，复用现有持久化边界。
- `apps/electron/src/main/lib/safe-file.test.ts`：覆盖临时文件、rename 和写入失败不替换旧 trace。
- `apps/electron/src/main/lib/design/design-execution-session-lifecycle.ts`：只在 trace 可读后幂等清理内部会话及其交互资源。
- `apps/electron/src/main/lib/design/design-execution-session-lifecycle.test.ts`：覆盖完整清理、trace 未就绪和中途失败恢复。
- `apps/electron/src/main/lib/design/design-job-manager.ts`：接入任务身份、attempt、trace pending、会话清理和恢复状态机。
- `apps/electron/src/main/lib/design/design-job-manager.test.ts`：覆盖首个尝试、重试、旧 journal、成功但 trace 失败、删除与恢复。
- `apps/electron/src/main/lib/design/design-recovery.test.ts`：覆盖启动时 trace/cleanup pending 的项目级隔离恢复。
- `apps/electron/src/main/lib/agent-memory-refresh-service.ts`：排除内部 Design 会话。
- `apps/electron/src/main/lib/agent-island-service.ts`：忽略内部会话实时事件和最近会话。
- `apps/electron/src/main/lib/tray-menu-model.ts`：从托盘运行中/最近列表排除内部会话。
- `apps/electron/src/main/lib/feishu-bridge-manager.ts`：拒绝为内部会话建立或推送镜像。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.ts`：向 LAN Adapter 只注入可见会话与可见搜索。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter-core.ts`：直接 sessionId 操作继续基于可见集合 fail closed。
- `apps/electron/src/main/lib/*test.ts`、`apps/electron/src/main/lib/lan-bridge/*test.ts`：锁定所有普通投影不可见。
- `apps/electron/src/main/ipc.ts`：普通 Agent IPC 使用可见查询；Design 详情继续按 `projectId + jobId` 读取。
- `apps/electron/src/main/lib/design/design-ipc.ts`：校验并注册任务详情与 trace 延迟加载 handler。
- `apps/electron/src/main/lib/design/design-ipc.test.ts`：覆盖归属校验、轻量列表和延迟 trace。
- `apps/electron/src/preload/design-preload.ts`、`apps/electron/src/preload/design-preload.test.ts`：暴露受控任务详情 API。
- `apps/electron/src/renderer/lib/design-adapter.ts`、`apps/electron/src/renderer/lib/design-adapter.test.ts`：收口 Renderer 调用。
- `apps/electron/src/renderer/atoms/design-atoms.ts`、`apps/electron/src/renderer/atoms/design-atoms.test.ts`：保存任务详情加载态，不把大 trace 放入项目列表状态。
- `apps/electron/src/renderer/components/design/DesignTaskDetails.tsx`、`DesignTaskDetails.test.tsx`：展示要求、摘要、精确提示词、Thinking、日志和尝试历史。
- `apps/electron/src/renderer/components/design/DesignInspector.tsx`、`DesignInspector.test.tsx`：选择 job/来源 asset 时进入任务详情。
- `apps/electron/src/renderer/components/design/DesignAssetNode.tsx`、`DesignAssetNode.test.tsx`：删除前确认并保留既有取消/重试入口。
- `apps/electron/src/renderer/components/design/design-accessibility.test.tsx`：覆盖键盘、窄栏、长内容和 loading/error 状态。

### Task 1: 扩展创作任务与 trace 共享契约

**Files:**
- Modify: `packages/shared/src/types/design.ts`
- Modify: `packages/shared/src/types/design.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-paths.ts`
- Modify: `apps/electron/src/main/lib/design/design-paths.test.ts`

- [ ] **Step 1: 写失败测试锁定新任务身份、兼容读取和 trace 路径**

在 `packages/shared/src/types/design.test.ts` 增加：

```ts
test('Given Design 首次尝试 When 构造公开记录 Then creativeTaskId 与 attemptNumber 独立于 job id', () => {
  const job: DesignJobRecord = {
    id: 'job-1',
    creativeTaskId: 'creative-1',
    attemptNumber: 1,
    projectId: 'project-1',
    action: 'generate',
    status: 'queued',
    prompt: '首页效果图',
    originalRequest: '首页效果图',
    contextMode: 'none',
    traceState: 'pending',
    executionSessionCleanupState: 'pending',
    createdAt: 10,
    updatedAt: 10,
  }

  expect(job.creativeTaskId).not.toBe(job.id)
  expect(job.attemptNumber).toBe(1)
})

test('Given 任务详情契约 When 序列化 Then 不包含内部 sessionId 或凭据字段', () => {
  const details: DesignTaskDetails = {
    creativeTaskId: 'creative-1',
    currentJobId: 'job-1',
    attempts: [],
    traceState: 'ready',
  }
  const encoded = JSON.stringify(details)
  expect(encoded).not.toContain('apiKey')
  expect(encoded).not.toContain('Authorization')
  expect(encoded).not.toContain('sessionId')
})
```

在 `design-paths.test.ts` 的期望对象中增加：

```ts
tracesDir: '/home/test/.proma/design-cache/project-1/traces',
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test packages/shared/src/types/design.test.ts apps/electron/src/main/lib/design/design-paths.test.ts`

Expected: FAIL，提示 `creativeTaskId`、`DesignTaskDetails` 或 `tracesDir` 尚未定义。

- [ ] **Step 3: 增加共享类型与通道**

在 `packages/shared/src/types/design.ts` 增加并应用以下定义：

```ts
export type DesignContextMode = 'auto' | 'project' | 'none'
export type DesignContextCategory =
  | 'brand' | 'product' | 'code' | 'character'
  | 'story' | 'scene' | 'continuity' | 'reference'
export type DesignTraceState = 'pending' | 'ready' | 'unavailable'
export type DesignExecutionSessionCleanupState = 'pending' | 'completed'

export interface DesignContextReference {
  id: string
  category: DesignContextCategory
  sourceKind: 'project-file' | 'context-document' | 'design-asset'
  label: string
  relativePath?: string
  assetId?: string
  purpose: string
  readAt: number
}

export interface DesignJobTraceSummary {
  contextReferences?: DesignContextReference[]
  designSummary?: string
  finalImagePrompt?: string
  rawThinkingAvailable?: boolean
  contextWarning?: string
}

export interface DesignTraceEntry {
  timestamp: number
  type: 'thinking' | 'context' | 'tool' | 'image' | 'validation' | 'status' | 'error'
  title: string
  content?: string
  toolName?: string
  isError?: boolean
}

export interface DesignTaskAttemptDetails {
  jobId: string
  attemptNumber: number
  status: DesignJobStatus
  startedAt?: number
  completedAt?: number
  error?: string
  traceState?: DesignTraceState
  designSummary?: string
  finalImagePrompt?: string
  rawThinkingAvailable?: boolean
}

export interface DesignTaskDetails {
  creativeTaskId: string
  currentJobId: string
  attempts: DesignTaskAttemptDetails[]
  traceState: DesignTraceState
  trace?: DesignTraceEntry[]
}
```

把 `DesignJobRecord` 扩展为：

```ts
export interface DesignJobRecord extends DesignJobTraceSummary {
  id: string
  creativeTaskId: string
  attemptNumber: number
  projectId: string
  sessionId?: string
  action: DesignJobAction
  status: DesignJobStatus
  prompt: string
  originalRequest: string
  contextMode: DesignContextMode
  sourceAgentMessageId?: string
  imageModelSnapshot?: ImageGenerationModelSnapshot
  sourceSessionId?: string
  sourceAssetId?: string
  parentAssetId?: string
  outputAssetId?: string
  error?: string
  traceState?: DesignTraceState
  executionSessionCleanupState?: DesignExecutionSessionCleanupState
  startedAt?: number
  completedAt?: number
  createdAt: number
  updatedAt: number
}
```

在 `DESIGN_IPC_CHANNELS` 增加：

```ts
GET_TASK_DETAILS: 'design:get-task-details',
GET_TASK_TRACE: 'design:get-task-trace',
```

并新增输入：

```ts
export interface GetDesignTaskDetailsInput {
  projectId: string
  jobId: string
}
```

- [ ] **Step 4: 扩展可信路径解析**

在 `DesignPaths` 增加 `tracesDir: string`，并在 `createDesignPathResolver()` 返回：

```ts
tracesDir: join(cacheRoot, 'traces'),
```

在 `design-store.ts` 的 cache 目录初始化数组中加入 `paths.tracesDir`，使新项目首次使用 Design 时持久创建该目录。

- [ ] **Step 5: 运行测试确认 GREEN 并提交**

Run: `bun test packages/shared/src/types/design.test.ts apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/design-store.test.ts`

Expected: PASS。

```bash
git add packages/shared/src/types/design.ts packages/shared/src/types/design.test.ts apps/electron/src/main/lib/design/design-paths.ts apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/design-store.ts apps/electron/src/main/lib/design/design-store.test.ts
git commit -m "设计：建立创作任务与追踪契约"
```

### Task 2: 原子创建并统一识别内部 Design 会话

**Files:**
- Create: `apps/electron/src/main/lib/agent-session-visibility.ts`
- Create: `apps/electron/src/main/lib/agent-session-visibility.test.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.test.ts`

- [ ] **Step 1: 写失败测试覆盖半损坏元数据与原子创建**

```ts
test('Given Design 元数据只有一半 When 判断用户可见性 Then fail closed', () => {
  expect(isAgentSessionUserVisible({ sourceDesignProjectId: 'project-1' })).toBe(false)
  expect(isAgentSessionUserVisible({ sourceDesignJobId: 'job-1' })).toBe(false)
  expect(hasValidDesignSessionOwnership({ sourceDesignProjectId: 'project-1' })).toBe(false)
})

test('Given Design 创建内部会话 When 索引首次写入 Then 两个来源字段同时存在', () => {
  const session = manager.createAgentSessionWithMetadata({
    title: '设计任务：首页效果图',
    channelId: 'channel-1',
    workspaceId: 'project-1',
    modelId: 'model-1',
    sourceDesignProjectId: 'project-1',
    sourceDesignJobId: 'job-1',
  })

  expect(manager.listAgentSessions()).toContainEqual(expect.objectContaining({
    id: session.id,
    sourceDesignProjectId: 'project-1',
    sourceDesignJobId: 'job-1',
  }))
  expect(manager.listVisibleAgentSessions()).not.toContainEqual(expect.objectContaining({ id: session.id }))
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/agent-session-visibility.test.ts apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts`

Expected: FAIL，提示可见性模块和 `createAgentSessionWithMetadata` 不存在。

- [ ] **Step 3: 实现单一可见性判定**

创建 `agent-session-visibility.ts`：

```ts
import type { AgentSessionMeta } from '@proma/shared'

type DesignSessionFields = Pick<AgentSessionMeta, 'sourceDesignProjectId' | 'sourceDesignJobId'>

/** 任一 Design 来源字段存在即视为内部会话，损坏元数据也不会泄露。 */
export function isInternalDesignSession(session: DesignSessionFields): boolean {
  return Boolean(session.sourceDesignProjectId || session.sourceDesignJobId)
}

/** 只有两个非空来源字段同时存在才拥有可执行的 Design 归属。 */
export function hasValidDesignSessionOwnership(session: DesignSessionFields): boolean {
  return Boolean(session.sourceDesignProjectId?.trim() && session.sourceDesignJobId?.trim())
}

/** 普通用户查询和外部同步只允许非 Design 内部会话。 */
export function isAgentSessionUserVisible(session: DesignSessionFields): boolean {
  return !isInternalDesignSession(session)
}

/** 直接 sessionId 用户入口统一拒绝内部或不存在的会话。 */
export function requireUserVisibleAgentSession(
  session: AgentSessionMeta | undefined,
): AgentSessionMeta {
  if (!session || !isAgentSessionUserVisible(session)) throw new Error('Agent 会话不存在')
  return session
}
```

- [ ] **Step 4: 新增带元数据的单次索引写入入口**

在 `agent-session-manager.ts` 新增：

```ts
export interface CreateAgentSessionWithMetadataInput {
  title?: string
  channelId?: string
  workspaceId?: string
  modelId?: string
  agentCwdMode?: AgentCwdMode
  sessionWorkbenchLayout?: SessionWorkbenchLayout
  sourceDesignProjectId?: string
  sourceDesignJobId?: string
}

export function createAgentSessionWithMetadata(
  input: CreateAgentSessionWithMetadataInput,
): AgentSessionMeta {
  const hasProject = Boolean(input.sourceDesignProjectId)
  const hasJob = Boolean(input.sourceDesignJobId)
  if (hasProject !== hasJob) throw new Error('Design 内部会话来源字段必须成对提供')
  const index = readIndex()
  const now = Date.now()
  const settings = getSettings()
  const meta: AgentSessionMeta = {
    id: randomUUID(),
    title: input.title || '新 Agent 会话',
    channelId: input.channelId,
    modelId: input.modelId,
    workspaceId: input.workspaceId,
    agentCwdMode: input.workspaceId ? input.agentCwdMode ?? 'project' : undefined,
    sessionWorkbenchLayout: input.workspaceId ? input.sessionWorkbenchLayout ?? 'root' : undefined,
    reasoningLevel: settings.defaultOpenAIThinkingLevel
      ?? resolvePiThinkingLevel(settings, undefined, 'openai-codex'),
    ...(hasProject ? {
      sourceDesignProjectId: input.sourceDesignProjectId,
      sourceDesignJobId: input.sourceDesignJobId,
    } : {}),
    createdAt: now,
    updatedAt: now,
  }
  index.sessions.push(meta)
  writeIndex(index)
  initializeAgentSessionDirectories(meta)
  return meta
}
```

把现有 `createAgentSession(...)` 改为调用该函数；把原目录初始化代码提取为 `initializeAgentSessionDirectories(meta)`，保证普通创建行为不变。新增：

```ts
export function listVisibleAgentSessions(): AgentSessionMeta[] {
  return listAgentSessions().filter(isAgentSessionUserVisible)
}
```

并让 `listActiveAgentSessions`、`listArchivedAgentSessions`、`countArchivedAgentSessions`、`searchAgentSessionMessages` 和 `searchAgentSessionReferences` 在读取消息文件前先使用 `isAgentSessionUserVisible` 过滤。

- [ ] **Step 5: 让 Design Manager 不再先创建普通会话再补标签**

把 `DesignJobManagerDependencies.createSession` 改为接收：

```ts
createSession: (input: {
  title: string
  channelId: string
  projectId: string
  modelId: string
  sourceDesignJobId: string
}) => AgentSessionMeta
```

删除 `updateSession` 依赖，并将 `run()` 的创建调用替换为：

```ts
const session = this.dependencies.createSession({
  title: `设计任务：${queued.originalRequest.trim().slice(0, 24)}`,
  channelId: model.channelId,
  projectId: queued.projectId,
  modelId: model.modelId,
  sourceDesignJobId: queued.id,
})
```

生产组合根使用：

```ts
createSession: (input) => createAgentSessionWithMetadata({
  title: input.title,
  channelId: input.channelId,
  workspaceId: input.projectId,
  modelId: input.modelId,
  sourceDesignProjectId: input.projectId,
  sourceDesignJobId: input.sourceDesignJobId,
}),
```

- [ ] **Step 6: 运行测试确认 GREEN 并提交**

Run: `bun test apps/electron/src/main/lib/agent-session-visibility.test.ts apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts`

Expected: PASS；测试 spy 不再观察到 `createSession` 与 `updateSession` 两步窗口。

```bash
git add apps/electron/src/main/lib/agent-session-visibility.ts apps/electron/src/main/lib/agent-session-visibility.test.ts apps/electron/src/main/lib/agent-session-manager.ts apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/lib/design/design-job-manager.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/ipc.ts
git commit -m "设计：原子创建并隐藏内部执行会话"
```

### Task 3: 封闭所有普通会话投影和外部入口

**Files:**
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/main/lib/agent-memory-refresh-service.ts`
- Create: `apps/electron/src/main/lib/agent-memory-refresh-service.test.ts`
- Modify: `apps/electron/src/main/lib/agent-island-service.ts`
- Modify: `apps/electron/src/main/lib/agent-island-runtime-status.test.ts`
- Modify: `apps/electron/src/main/lib/tray-menu-model.ts`
- Create: `apps/electron/src/main/lib/tray-menu-model.test.ts`
- Modify: `apps/electron/src/main/lib/feishu-bridge-manager.ts`
- Modify: `apps/electron/src/main/lib/feishu/session-mirror.test.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.test.ts`

- [ ] **Step 1: 写失败测试覆盖普通入口矩阵**

为每个模块使用同一类 fixture：

```ts
const visible = createSession({ id: 'visible-1', title: '用户会话' })
const internal = createSession({
  id: 'design-1',
  title: '设计任务',
  sourceDesignProjectId: 'project-1',
  sourceDesignJobId: 'job-1',
})
```

增加断言：

```ts
expect(createTrayMenuModel([visible, internal], [], new Set(['design-1'])))
  .toEqual(expect.objectContaining({
    runningSessions: [],
    recentSessions: [expect.objectContaining({ id: 'visible-1' })],
  }))

expect(claimWorkspaceMemoryRefreshOpportunity('project-1', now)?.newerSessionCount).toBe(1)
expect(lanAdapter.listAgentSessions().map((session) => session.id)).toEqual(['visible-1'])
expect(() => lanAdapter.getAgentMessages('design-1')).toThrow('会话不存在')
```

Agent Island 测试先投递内部会话的 `run_started` 和 assistant 消息，再断言 `sessions`、`recentSessions` 与 pill count 均不含它。飞书测试断言 `ensureSessionMirror(internal)` 与 `startSessionMirrorRun(internal)` 不触发 bridge。

- [ ] **Step 2: 运行矩阵测试确认 RED**

Run: `bun test apps/electron/src/main/lib/tray-menu-model.test.ts apps/electron/src/main/lib/agent-memory-refresh-service.test.ts apps/electron/src/main/lib/agent-island-runtime-status.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.test.ts apps/electron/src/main/lib/feishu/session-mirror.test.ts`

Expected: FAIL，至少托盘、记忆、Island、LAN 或飞书仍看到 `design-1`。

- [ ] **Step 3: 在各投影的最早边界应用统一判定**

应用以下明确映射：

```ts
// tray-menu-model.ts
const visibleSessions = sessions
  .filter(isAgentSessionUserVisible)
  .filter((session) => !session.archived || runningSessionIds.has(session.id))

// agent-memory-refresh-service.ts
const sessions = listAgentSessions()
  .filter(isAgentSessionUserVisible)
  .filter((session) => session.workspaceId === workspaceSlug)

// agent-island-service.ts
function handleAgentEvent(sessionId: string, payload: AgentStreamPayload): void {
  if (!isAgentSessionUserVisible(getAgentSessionMeta(sessionId) ?? {})) {
    sessions.delete(sessionId)
    return
  }
  // 保留现有事件分派。
}

// feishu-bridge-manager.ts
if (!isAgentSessionUserVisible(session)) return

// lan-bridge-proma-adapter.ts
listAgentSessions: () => listVisibleAgentSessions(),
searchAgentSessionMessages: (query) => searchAgentSessionMessages(query),
```

`searchAgentSessionMessages` 已在 Task 2 内部过滤，LAN Adapter 的 `hasAgentSession`、读消息、星标、查看、发送和停止继续以这份可见列表作为存在性事实。

- [ ] **Step 4: 普通 Agent IPC 对直接 sessionId fail closed**

在 `ipc.ts` 增加局部 helper：

```ts
const requireVisibleSession = (sessionId: string): AgentSessionMeta => (
  requireUserVisibleAgentSession(getAgentSessionMeta(sessionId))
)
```

将 `LIST_SESSIONS` 改为 `listVisibleAgentSessions()`；GET SDK messages、标题、模型、worktree、删除、pin/star/archive、move/fork、browser、permission/ask/exit 响应等普通用户 handler 在触碰文件或状态前调用 `requireVisibleSession(id)`。Design Manager、退出清理、项目迁移和恢复继续直接使用 `getAgentSessionMeta` / `listAgentSessions`，不经过该 helper。

- [ ] **Step 5: 运行矩阵测试确认 GREEN 并提交**

Run: `bun test apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/lib/tray-menu-model.test.ts apps/electron/src/main/lib/agent-memory-refresh-service.test.ts apps/electron/src/main/lib/agent-island-runtime-status.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.test.ts apps/electron/src/main/lib/feishu/session-mirror.test.ts`

Expected: PASS；内部全量测试仍能由 `listAgentSessions()` 找到 Design 会话。

```bash
git add apps/electron/src/main/ipc.ts apps/electron/src/main/lib/agent-memory-refresh-service.ts apps/electron/src/main/lib/agent-memory-refresh-service.test.ts apps/electron/src/main/lib/agent-island-service.ts apps/electron/src/main/lib/agent-island-runtime-status.test.ts apps/electron/src/main/lib/tray-menu-model.ts apps/electron/src/main/lib/tray-menu-model.test.ts apps/electron/src/main/lib/feishu-bridge-manager.ts apps/electron/src/main/lib/feishu/session-mirror.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.test.ts
git commit -m "设计：隔离内部会话的普通投影"
```

### Task 4: 建立原子 JSONL trace 与内部会话回收器

**Files:**
- Modify: `apps/electron/src/main/lib/safe-file.ts`
- Modify: `apps/electron/src/main/lib/safe-file.test.ts`
- Create: `apps/electron/src/main/lib/design/design-trace-store.ts`
- Create: `apps/electron/src/main/lib/design/design-trace-store.test.ts`
- Create: `apps/electron/src/main/lib/design/design-execution-session-lifecycle.ts`
- Create: `apps/electron/src/main/lib/design/design-execution-session-lifecycle.test.ts`

- [ ] **Step 1: 写失败测试覆盖 trace 事实来源和清理顺序**

```ts
test('Given Pi 返回 Thinking 与图片工具参数 When 转存 trace Then 摘要只来自真实消息', () => {
  const result = store.writeFromMessages('project-1', 'job-1', createSdkMessages({
    thinking: '先建立信息层级',
    designSummary: '突出产品主操作并保持安静层级',
    prompt: 'A quiet desktop agent dashboard, exact layout...',
  }))

  expect(result.summary).toEqual({
    designSummary: '突出产品主操作并保持安静层级',
    finalImagePrompt: 'A quiet desktop agent dashboard, exact layout...',
    rawThinkingAvailable: true,
  })
  expect(store.read('project-1', 'job-1')).toContainEqual(expect.objectContaining({
    type: 'thinking',
    content: '先建立信息层级',
  }))
})

test('Given trace 尚未 ready When 请求回收内部会话 Then 不删除唯一日志', async () => {
  await expect(lifecycle.cleanup({
    sessionId: 'design-session-1',
    traceState: 'pending',
  })).rejects.toThrow('Design trace 尚未就绪')
  expect(deletedSessions).toEqual([])
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/safe-file.test.ts apps/electron/src/main/lib/design/design-trace-store.test.ts apps/electron/src/main/lib/design/design-execution-session-lifecycle.test.ts`

Expected: FAIL，新增模块和 JSONL 写入器不存在。

- [ ] **Step 3: 增加迭代式 JSONL 原子写入器**

在 `safe-file.ts` 增加：

```ts
export function writeJsonLinesFileAtomic(
  filePath: string,
  values: Iterable<object>,
  options: AtomicWriteOptions = {},
): DurabilityResult {
  const temporaryPath = `${filePath}.tmp`
  const descriptor = openSync(temporaryPath, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY, 0o600)
  try {
    for (const value of values) writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporaryPath, filePath)
  return syncCommittedFileDurability(filePath, options)
}
```

测试注入写入失败并确认旧主文件保持不变、`.tmp` 不会被读取为 ready trace。

- [ ] **Step 4: 实现 trace 提取、清洗和按需读取**

`design-trace-store.ts` 的公开边界固定为：

```ts
export interface DesignTraceWriteResult {
  summary: DesignJobTraceSummary
  entryCount: number
}

export class DesignTraceStore {
  constructor(private readonly dependencies: {
    pathResolver: Pick<DesignPathResolver, 'resolve'>
    now?: () => number
  }) {}

  writeFromMessages(projectId: string, jobId: string, messages: SDKMessage[]): DesignTraceWriteResult
  read(projectId: string, jobId: string): DesignTraceEntry[]
  isReadable(projectId: string, jobId: string): boolean
  delete(projectId: string, jobId: string): void
}
```

提取规则必须写成确定函数：assistant `thinking` 块生成 `thinking` entry；图片工具 `tool_use` 的 `input.prompt` 原样成为 `finalImagePrompt`，`input.designSummary` 原样成为 `designSummary`；tool result 只记录成功/失败和工具名，不复制图片 Base64、绝对路径、Key、Header 或完整未知 details。没有 Thinking 时 `rawThinkingAvailable: false`，禁止从摘要生成 Thinking。

- [ ] **Step 5: 实现清理器并复用现有删除能力**

`design-execution-session-lifecycle.ts`：

```ts
export interface CleanupDesignExecutionSessionInput {
  sessionId: string
  traceState: DesignTraceState
}

export class DesignExecutionSessionLifecycle {
  constructor(private readonly dependencies: {
    getSession: (sessionId: string) => AgentSessionMeta | undefined
    clearPermission: (sessionId: string) => void
    clearAskUser: (sessionId: string) => void
    clearExitPlan: (sessionId: string) => void
    clearQueue: (sessionId: string) => void
    closeBrowser: (sessionId: string) => Promise<void>
    deleteSession: (sessionId: string) => void
  }) {}

  async cleanup(input: CleanupDesignExecutionSessionInput): Promise<void> {
    if (input.traceState !== 'ready') throw new Error('Design trace 尚未就绪')
    const session = this.dependencies.getSession(input.sessionId)
    if (!session) return
    if (!hasValidDesignSessionOwnership(session)) throw new Error('Design 内部会话归属无效')
    this.dependencies.clearPermission(input.sessionId)
    this.dependencies.clearAskUser(input.sessionId)
    this.dependencies.clearExitPlan(input.sessionId)
    this.dependencies.clearQueue(input.sessionId)
    await this.dependencies.closeBrowser(input.sessionId)
    this.dependencies.deleteSession(input.sessionId)
  }
}
```

清理失败由 Job journal 保留 pending；重复调用时已删除 session 直接成功。

- [ ] **Step 6: 运行测试确认 GREEN 并提交**

Run: `bun test apps/electron/src/main/lib/safe-file.test.ts apps/electron/src/main/lib/design/design-trace-store.test.ts apps/electron/src/main/lib/design/design-execution-session-lifecycle.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/safe-file.ts apps/electron/src/main/lib/safe-file.test.ts apps/electron/src/main/lib/design/design-trace-store.ts apps/electron/src/main/lib/design/design-trace-store.test.ts apps/electron/src/main/lib/design/design-execution-session-lifecycle.ts apps/electron/src/main/lib/design/design-execution-session-lifecycle.test.ts
git commit -m "设计：保存执行追踪并回收内部会话"
```

### Task 5: 把任务身份、trace 和清理状态机接入 Design Job

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-asset-service.ts`
- Modify: `apps/electron/src/main/lib/design/design-asset-service.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-recovery.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: 写失败测试覆盖首个尝试、重试和成功但 trace 失败**

```ts
test('Given Design 直接提交 When 创建首个 job Then 分配独立 creativeTaskId 与 attempt 1', () => {
  const job = harness.manager.create(createGenerateInput())
  expect(job.creativeTaskId).toBe('creative-1')
  expect(job.attemptNumber).toBe(1)
  expect(job.originalRequest).toBe(createGenerateInput().prompt)
  expect(job.contextMode).toBe('none')
})

test('Given failed attempt When 显式重试 Then 沿用任务 ID 并保留旧 attempt', () => {
  const failed = harness.createFailedJob()
  const replacement = harness.manager.retry('project-1', failed.id)
  expect(replacement.creativeTaskId).toBe(failed.creativeTaskId)
  expect(replacement.attemptNumber).toBe(failed.attemptNumber + 1)
  expect(harness.manager.list('project-1')).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: failed.id, status: 'failed' }),
    expect.objectContaining({ id: replacement.id, status: 'queued' }),
  ]))
})

test('Given 图片已提交但 trace 写入失败 When 收敛 Then 保持 succeeded 并等待恢复日志', async () => {
  harness.traceWriteError = new Error('trace rename failed')
  const job = harness.manager.create(createGenerateInput())
  await harness.manager.run(job.id)
  expect(harness.manager.get(job.id)).toEqual(expect.objectContaining({
    status: 'succeeded',
    traceState: 'pending',
    executionSessionCleanupState: 'pending',
  }))
})

test('Given 取消与成功并发 When 成功 revision 先提交 Then 保留成功素材', async () => {
  const job = harness.manager.create(createGenerateInput())
  harness.completeOutputBeforeAbort(job.id)
  await harness.manager.cancel('project-1', job.id)
  expect(harness.manager.get(job.id)?.status).toBe('succeeded')
  expect(harness.document.assets).toHaveLength(1)
})

test('Given 取消先收敛 When 迟到图片返回 Then 不导入正式素材', async () => {
  const job = harness.manager.create(createGenerateInput())
  await harness.manager.cancel('project-1', job.id)
  await harness.deliverLateOutput(job.id)
  expect(harness.manager.get(job.id)?.status).toBe('cancelled')
  expect(harness.document.assets).toHaveLength(0)
})

test('Given 成功素材合法删除 When 来源 Job 存在 Then 回收同创作任务的本地 job 与 trace', () => {
  const asset = harness.createSucceededAsset({ sourceJobId: 'job-1' })
  harness.assetService.deleteAsset('project-1', asset.id, harness.document.revision)
  expect(harness.manager.list('project-1')).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ creativeTaskId: 'creative-1' }),
  ]))
  expect(harness.traceExists('job-1')).toBe(false)
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-recovery.test.ts`

Expected: FAIL，旧 Manager 不认识任务身份和 trace 状态。

- [ ] **Step 3: 扩展严格 journal 与旧记录兼容读取**

将新增字段加入 `STORED_JOB_FIELDS`；新记录要求 `creativeTaskId`、`attemptNumber`、`originalRequest`、`contextMode`。读取旧 journal 时不要直接放宽严格 schema，而是在 `normalizeStoredDesignJob(value)` 中先验证旧字段，再返回内存兼容值：

```ts
return {
  ...legacy,
  creativeTaskId: legacy.id,
  attemptNumber: 1,
  originalRequest: legacy.prompt,
  contextMode: 'none',
  traceState: legacy.sessionId ? 'unavailable' : undefined,
}
```

旧 journal 不回写；只有发生状态变更时才按新 schema 原子保存。

- [ ] **Step 4: 创建、重试和终态写入新状态**

`createInternal()` 接收：

```ts
interface DesignAttemptIdentity {
  creativeTaskId: string
  attemptNumber: number
}
```

首次创建使用两个独立 `createId()`；replacement 使用：

```ts
const identity = replaced
  ? { creativeTaskId: replaced.creativeTaskId, attemptNumber: replaced.attemptNumber + 1 }
  : { creativeTaskId: this.createId(), attemptNumber: 1 }
```

进入 running 时写 `startedAt`；所有终态写 `completedAt`。图片成功提交后先保持 `status: 'succeeded'`，再调用统一 `finalizeExecution(jobId)`：

```ts
private async finalizeExecution(jobId: string): Promise<void> {
  let job = this.requireJob(jobId)
  if (!job.sessionId) return
  if (job.traceState !== 'ready') {
    this.updateStatus(job, job.status, { traceState: 'pending' })
    const messages = this.dependencies.getSessionMessages(job.sessionId)
    const written = this.dependencies.traceStore.writeFromMessages(job.projectId, job.id, messages)
    job = this.updateStatus(this.requireJob(jobId), job.status, {
      ...written.summary,
      traceState: 'ready',
      executionSessionCleanupState: 'pending',
    })
  }
  await this.dependencies.sessionLifecycle.cleanup({
    sessionId: job.sessionId,
    traceState: job.traceState ?? 'unavailable',
  })
  this.updateStatus(this.requireJob(jobId), job.status, {
    executionSessionCleanupState: 'completed',
  })
}
```

每个成功、失败、取消和中断分支都在状态收敛后调用；trace/cleanup 异常只保留 pending 和中文警告，不覆盖业务终态。

- [ ] **Step 5: 恢复和删除按任务聚合处理**

`recover(projectId)` 对所有终态且 `traceState !== 'ready'` 的 job 尝试转存；ready 但 cleanup pending 时只继续 cleanup。删除失败任务时按同一 `creativeTaskId` 找到 attempts，先写删除意图，再清理未被成功 asset 引用的节点、trace 和残留 session；任何失败保留发起 job 的 `deletionState`。

新增 `cleanupTaskAfterSuccessfulAssetDeletion(projectId, sourceJobId)`：`DesignAssetService.deleteAsset()` 只在权威素材元数据与文件删除均已合法提交后调用；Manager 从 `sourceJobId` 找到 `creativeTaskId`，以可恢复清理意图回收全部 attempts、trace 和残留内部会话。若任务还有其他成功素材引用则只清理已无引用的 attempt；清理失败不回滚已提交的画布 revision，由恢复流程继续。

新增 Manager 查询：

```ts
getTaskDetails(projectId: string, jobId: string, includeTrace = false): DesignTaskDetails
```

它验证 job 归属，按 `creativeTaskId` 排序 attempts；`includeTrace=false` 不调用 `traceStore.read()`。

- [ ] **Step 6: 运行测试确认 GREEN 并提交**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-asset-service.test.ts apps/electron/src/main/lib/design/design-recovery.test.ts apps/electron/src/main/lib/agent-design-tool-policy.test.ts`

Expected: PASS；fake 图片执行器调用次数保持每次显式提交最多 1，恢复调用次数为 0。

```bash
git add apps/electron/src/main/lib/design/design-job-manager.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-asset-service.ts apps/electron/src/main/lib/design/design-asset-service.test.ts apps/electron/src/main/lib/design/design-recovery.test.ts apps/electron/src/main/ipc.ts
git commit -m "设计：接入创作任务追踪状态机"
```

### Task 6: 打通任务详情与 trace 延迟加载 IPC

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/design-ipc.test.ts`
- Modify: `apps/electron/src/preload/design-preload.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写失败测试锁定四层契约和延迟读取**

```ts
test('Given 用户打开任务详情 When 未展开 trace Then 只读取轻量详情', async () => {
  await handlers.get(DESIGN_IPC_CHANNELS.GET_TASK_DETAILS)!(authorizedEvent, {
    projectId: 'project-1',
    jobId: 'job-1',
  })
  expect(jobManager.getTaskDetails).toHaveBeenCalledWith('project-1', 'job-1', false)
  expect(traceStore.read).not.toHaveBeenCalled()
})

test('Given 展开 Thinking When 请求 trace Then 通过 projectId 与 jobId 校验后读取', async () => {
  await handlers.get(DESIGN_IPC_CHANNELS.GET_TASK_TRACE)!(authorizedEvent, {
    projectId: 'project-1',
    jobId: 'job-1',
  })
  expect(jobManager.getTaskDetails).toHaveBeenCalledWith('project-1', 'job-1', true)
})
```

- [ ] **Step 2: 运行 IPC 测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: FAIL，两个通道尚未注册。

- [ ] **Step 3: 在 main 严格解析并注册 handler**

新增：

```ts
function parseTaskDetailsInput(value: unknown): GetDesignTaskDetailsInput {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['projectId', 'jobId'])
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.jobId)) throw new Error('Design 请求结构无效')
  return { projectId: value.projectId, jobId: value.jobId }
}
```

注册 `GET_TASK_DETAILS` 和 `GET_TASK_TRACE`；两者先 `assertAuthorizedSender`，再调用 Manager 的归属校验查询。

- [ ] **Step 4: 同步 preload 与 Renderer adapter**

在 `DesignPreloadApi` 增加：

```ts
getDesignTaskDetails: (input: GetDesignTaskDetailsInput) => Promise<DesignTaskDetails>
getDesignTaskTrace: (input: GetDesignTaskDetailsInput) => Promise<DesignTaskDetails>
```

工厂分别调用两个通道；`DesignAdapter` 增加 `getTaskDetails` 和 `getTaskTrace`，继续通过 `requireMethod` fail closed。

- [ ] **Step 5: 运行测试确认 GREEN 并提交**

Run: `bun test apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/design/design-ipc.ts apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "设计：开放受控任务详情读取"
```

### Task 7: 在 Inspector 展示任务详情并确认删除

**Files:**
- Modify: `apps/electron/src/renderer/atoms/design-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/design-atoms.test.ts`
- Create: `apps/electron/src/renderer/components/design/DesignTaskDetails.tsx`
- Create: `apps/electron/src/renderer/components/design/DesignTaskDetails.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignAssetNode.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignAssetNode.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/design-accessibility.test.tsx`

- [ ] **Step 1: 写失败测试覆盖轻量首屏、按需 trace 和确认删除**

```tsx
test('Given 选中 Design job When 打开详情 Then 默认不请求 trace', async () => {
  renderInspectorWithSelectedJob('job-1')
  expect(await screen.findByText('用户原始要求')).toBeInTheDocument()
  expect(api.getDesignTaskDetails).toHaveBeenCalledTimes(1)
  expect(api.getDesignTaskTrace).not.toHaveBeenCalled()
})

test('Given 模型没有 Thinking When 展开 Then 明确说明不可用', async () => {
  api.getDesignTaskTrace.mockResolvedValue(createTaskDetails({ rawThinkingAvailable: false }))
  await user.click(screen.getByRole('button', { name: '模型原始 Thinking' }))
  expect(await screen.findByText('模型未返回原始 Thinking')).toBeInTheDocument()
})

test('Given 失败任务 When 点击垃圾桶 Then 确认后才调用删除', async () => {
  renderFailedNode()
  await user.click(screen.getByRole('button', { name: '删除任务' }))
  expect(api.deleteDesignJob).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '确认删除任务' }))
  expect(api.deleteDesignJob).toHaveBeenCalledTimes(1)
})

test('Given 选中成功素材 When 素材含 sourceJobId Then 通过来源 Job 加载任务详情', async () => {
  renderInspectorWithSelectedAsset({ id: 'asset-1', sourceJobId: 'job-1' })
  expect(api.getDesignTaskDetails).toHaveBeenCalledWith({ projectId: 'project-1', jobId: 'job-1' })
})

test('Given 成功素材 When 点击基于此版本继续 Then 只预填新编辑草稿且尚未创建 Job', async () => {
  renderInspectorWithSelectedAsset({ id: 'asset-1', sourceJobId: 'job-1' })
  await user.click(screen.getByRole('button', { name: '基于此版本继续' }))
  expect(screen.getByLabelText('编辑要求')).toHaveValue('')
  expect(api.createDesignJob).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行 Renderer 测试确认 RED**

Run: `bun test apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/DesignTaskDetails.test.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx apps/electron/src/renderer/components/design/DesignAssetNode.test.tsx`

Expected: FAIL，任务详情组件、加载态和确认对话框不存在。

- [ ] **Step 3: 增加按 job 隔离的轻量详情状态**

在 `DesignProjectState` 增加：

```ts
taskDetailsByJobId: Map<string, {
  phase: 'idle' | 'loading' | 'ready' | 'failed'
  details?: DesignTaskDetails
  traceLoaded: boolean
  error?: string
}>
```

所有更新复制 `Map`；项目 recovery、dispose 和删除 job 时清理对应项。普通 `listJobs` 和画布加载不写入 trace。

- [ ] **Step 4: 实现 `DesignTaskDetails`**

组件 props 固定为：

```ts
export interface DesignTaskDetailsProps {
  job: DesignJobRecord
  detailsState: DesignProjectState['taskDetailsByJobId'] extends Map<string, infer Value> ? Value : never
  onLoadDetails: () => void
  onLoadTrace: () => void
  onCopyPrompt: (prompt: string) => void
  onRetry: (jobId: string) => void
  onContinueFromVersion: (assetId: string) => void
}
```

默认区块显示状态、模型、开始时间、耗时、`originalRequest`、`contextMode`、引用、`designSummary`、`finalImagePrompt`、错误/警告和尝试历史。Thinking 与完整日志使用 Radix Collapsible；首次展开调用 `onLoadTrace`。历史任务缺字段时显示“历史任务未记录此信息”，不伪造内容。

- [ ] **Step 5: 接入 Inspector 与确认对话框**

当选中 job 节点，或选中 `sourceJobId` 对应的成功 asset 时，在 Inspector 顶部渲染 `DesignTaskDetails`；成功素材通过 `sourceJobId` 调用现有 `projectId + jobId` 详情 API，不暴露内部 sessionId。保留素材、AI 编辑和版本标签作为后续内容。

成功任务显示 `基于此版本继续`，只把当前 output asset 写入新的编辑草稿 `sourceAssetId/parentAssetId`，不立即创建 Job；用户显式提交时沿用普通首次创建路径生成新的 `creativeTaskId`。删除按钮与 Delete/Backspace 共用一个 Jotai/React confirmation intent，并使用现有 `AlertDialog` primitive，文案明确“将删除任务节点、提示词、尝试历史和执行记录”。运行中任务显示稳定“取消中”状态并禁用重复命令，不显示删除；取消说明注明供应商已收到请求时费用不一定撤销。

- [ ] **Step 6: 运行视觉与无障碍测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/DesignTaskDetails.test.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx apps/electron/src/renderer/components/design/DesignAssetNode.test.tsx apps/electron/src/renderer/components/design/design-accessibility.test.tsx apps/electron/src/renderer/components/design/design-performance.test.tsx`

Expected: PASS；1000 节点测试仍不因任务详情加载 trace。

- [ ] **Step 7: 提交 UI**

```bash
git add apps/electron/src/renderer/atoms/design-atoms.ts apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/DesignTaskDetails.tsx apps/electron/src/renderer/components/design/DesignTaskDetails.test.tsx apps/electron/src/renderer/components/design/DesignInspector.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx apps/electron/src/renderer/components/design/DesignAssetNode.tsx apps/electron/src/renderer/components/design/DesignAssetNode.test.tsx apps/electron/src/renderer/components/design/design-accessibility.test.tsx
git commit -m "设计：展示任务详情与执行记录"
```

### Task 8: 第一阶段回归与构建验收

**Files:**
- Test only; do not call a real image provider.

- [ ] **Step 1: 运行第一阶段定向测试**

Run:

```bash
bun test \
  packages/shared/src/types/design.test.ts \
  apps/electron/src/main/lib/agent-session-visibility.test.ts \
  apps/electron/src/main/lib/agent-session-manager.test.ts \
  apps/electron/src/main/lib/agent-memory-refresh-service.test.ts \
  apps/electron/src/main/lib/tray-menu-model.test.ts \
  apps/electron/src/main/lib/agent-island-runtime-status.test.ts \
  apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts \
  apps/electron/src/main/lib/design/design-trace-store.test.ts \
  apps/electron/src/main/lib/design/design-execution-session-lifecycle.test.ts \
  apps/electron/src/main/lib/design/design-job-manager.test.ts \
  apps/electron/src/main/lib/design/design-recovery.test.ts \
  apps/electron/src/main/lib/design/design-ipc.test.ts \
  apps/electron/src/preload/design-preload.test.ts \
  apps/electron/src/renderer/components/design/DesignTaskDetails.test.tsx \
  apps/electron/src/renderer/components/design/DesignInspector.test.tsx \
  apps/electron/src/renderer/components/design/DesignAssetNode.test.tsx
```

Expected: PASS；测试日志中不存在真实供应商 URL 或计费请求。

- [ ] **Step 2: 运行关联安全与性能回归**

Run:

```bash
bun test \
  apps/electron/src/main/lib/agent-design-tool-policy.test.ts \
  apps/electron/src/main/lib/design/design-session-bridge.test.ts \
  apps/electron/src/main/lib/design/design-asset-service.test.ts \
  apps/electron/src/renderer/components/design/design-performance.test.tsx \
  apps/electron/src/renderer/components/design/design-accessibility.test.tsx
```

Expected: PASS；单次图片工具上限、文件身份、媒体授权和 1000 节点虚拟化不回退。

- [ ] **Step 3: 运行全仓类型检查与 Electron 构建**

Run: `bun run typecheck`

Expected: PASS。

Run: `CLANG_MODULE_CACHE_PATH=/private/tmp/proma-clang-cache SWIFT_MODULE_CACHE_PATH=/private/tmp/proma-swift-cache bun run electron:build`

Expected: PASS。

- [ ] **Step 4: 检查变更并提交验收修正**

Run: `git diff --check`

Expected: 无输出。

若验收产生必要修正，只提交本阶段文件：

```bash
git add packages/shared/src/types/design.ts apps/electron/src/main apps/electron/src/preload apps/electron/src/renderer
git commit -m "设计：完成任务透明度阶段验收"
```
