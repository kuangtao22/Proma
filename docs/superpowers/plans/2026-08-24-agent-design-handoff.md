# Agent 到 Design 结构化转交 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通 Agent 根据完整语义自然建议进入 Design，并把当前要求、附件和项目身份安全预填到设计面板，同时保证打开、拒绝、刷新和重启都不会隐式生图。

**Architecture:** 普通 Agent 通过无计费的 `suggest_design_handoff` 内置工具产生结构化建议，主进程 `AgentDesignHandoffCoordinator` 从当前真实会话和用户消息派生稳定 handoff journal。Renderer 只渲染经过校验的 tool result，并通过受控 IPC 接受或忽略建议；接受后用 Jotai 预填 Design，真正创建 Job 时主进程再次验证 handoff，令 `handoffId` 成为 `creativeTaskId`。

**Tech Stack:** Bun、TypeScript、Electron IPC、Pi Agent Runtime、JSON、React、Jotai、Radix/shadcn、BDD 风格 `bun:test`。

---

## 前置与范围

- 本计划依赖前两份计划按顺序完成：任务透明度与内部会话边界已稳定，Design 项目上下文和三态模式已可用。
- 结构化转交只对 `triggeredBy: 'user'`、存在项目且会话可见的普通 Agent run 注入；Automation、Collaboration 子 Agent、Design 内部 Agent、飞书镜像和无项目会话不注入。
- Renderer 不做“设计/视觉/生图”等关键词匹配。是否建议 Design 由 Agent 结合完整语义判断；主进程只验证授权事实和状态机。
- `打开设计` 只建立或恢复草稿，不创建 Design Job、不运行内部 Agent、不调用图片 executor。
- 用户明确要求留在对话或点击 `留在对话` 后，本 turn 不自动生图；后续 turn 的普通 Agent 能力保持不变。
- 所有测试使用 fake Agent、fake IPC 和 fake image executor，不调用真实模型。

## 文件与职责

- `packages/shared/src/types/design.ts`：转交建议、附件引用、草稿、状态和 IPC 输入输出。
- `packages/shared/src/types/design.test.ts`：公开载荷不含路径、通道唯一性和状态联合测试。
- `apps/electron/src/main/lib/design/design-paths.ts`：增加本机 `handoffs/` cache 路径。
- `apps/electron/src/main/lib/design/design-paths.test.ts`：验证 handoff 不写入项目正式合同。
- `apps/electron/src/main/lib/design/agent-design-handoff-coordinator.ts`：创建建议、验证来源、幂等接受/忽略、恢复草稿和查询状态。
- `apps/electron/src/main/lib/design/agent-design-handoff-coordinator.test.ts`：来源失效、附件归属、重启幂等和零 Job 测试。
- `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`：注入 `suggest_design_handoff`。
- `apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts`：工具可用边界和结构化 result 测试。
- `apps/electron/src/main/lib/agent-orchestrator.ts`：把当前用户消息 UUID 传入工具上下文并执行同 turn 图片工具互斥。
- `apps/electron/src/main/lib/agent-orchestrator.test.ts`：来源消息身份与工具顺序测试。
- `apps/electron/src/main/lib/agent-prompt-builder.ts`：向普通 Agent 描述语义转交边界。
- `apps/electron/src/main/lib/agent-prompt-builder.test.ts`：不使用关键词硬编码的提示词合同测试。
- `apps/electron/src/main/lib/agent-run-tool-policy.ts`：转交后拒绝本 turn 普通生图工具。
- `apps/electron/src/main/lib/agent-design-tool-policy.test.ts`：同 turn 重复执行保护。
- `apps/electron/src/main/lib/design/design-job-manager.ts`：接受 handoffId 并从 coordinator 固化来源和 creativeTaskId。
- `apps/electron/src/main/lib/design/design-job-manager.test.ts`：伪造、失效和附件子集测试。
- `apps/electron/src/main/lib/design/design-ipc.ts`：接受、忽略、查询 handoff 的严格 IPC handler。
- `apps/electron/src/main/lib/design/design-ipc.test.ts`：写锁、授权和零任务副作用测试。
- `apps/electron/src/preload/design-preload.ts`：暴露窄 handoff API。
- `apps/electron/src/preload/design-preload.test.ts`：通道透传测试。
- `apps/electron/src/renderer/lib/design-adapter.ts`：Renderer Design handoff 适配器。
- `apps/electron/src/renderer/lib/design-adapter.test.ts`：适配器完整性测试。
- `apps/electron/src/renderer/atoms/design-atoms.ts`：每项目 handoff 预填和选中附件状态。
- `apps/electron/src/renderer/atoms/design-atoms.test.ts`：幂等、项目隔离和清理测试。
- `apps/electron/src/renderer/components/agent/DesignHandoffCard.tsx`：打开设计、留在对话和任务状态回显。
- `apps/electron/src/renderer/components/agent/DesignHandoffCard.test.tsx`：交互、状态和来源失效测试。
- `apps/electron/src/renderer/components/agent/ContentBlock.tsx`：按结构化 tool result 分派转交卡片。
- `apps/electron/src/renderer/components/agent/ContentBlock.test.tsx`：禁止从 assistant 文本推断卡片。
- `apps/electron/src/renderer/components/design/DesignInspector.tsx`：显示转交来源并把 handoffId/附件子集带入显式提交。
- `apps/electron/src/renderer/components/design/DesignInspector.test.tsx`：预填可编辑且只在提交时 createJob。

### Task 1: 建立 handoff 共享契约和本机 journal 路径

**Files:**
- Modify: `packages/shared/src/types/design.ts`
- Modify: `packages/shared/src/types/design.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-paths.ts`
- Modify: `apps/electron/src/main/lib/design/design-paths.test.ts`

- [ ] **Step 1: 写失败的公开载荷与路径测试**

```ts
test('Given 结构化转交建议 When 进入公开类型 Then 不携带绝对路径或模型凭据', () => {
  const suggestion: DesignHandoffSuggestion = {
    type: 'design_handoff_suggestion', handoffId: 'handoff-1', projectId: 'project-1',
    sourceSessionId: 'session-1', sourceAgentMessageId: 'message-1',
    originalRequest: '帮我生成当前项目首页效果图', brief: '基于当前产品结构制作首页视觉稿',
    attachmentRefs: [{ id: 'attachment-1', name: 'logo.png', mediaType: 'image/png' }],
    recommendedContextMode: 'auto', suggestedCategories: ['brand', 'product', 'code'], createdAt: 10,
  }
  expect(JSON.stringify(suggestion)).not.toContain('/Users/')
  expect(JSON.stringify(suggestion)).not.toContain('apiKey')
})

test('Given 已登记项目 When 解析路径 Then handoff journal 位于本机 Design cache', () => {
  const paths = resolver.resolve('project-1')
  expect(paths.handoffsDir).toBe(join(paths.cacheRoot, 'handoffs'))
  expect(paths.handoffsDir.startsWith(paths.designRoot)).toBe(false)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/shared/src/types/design.test.ts apps/electron/src/main/lib/design/design-paths.test.ts`

Expected: FAIL，转交类型与 `handoffsDir` 尚不存在。

- [ ] **Step 3: 增加共享类型和 IPC 通道**

```ts
export interface DesignHandoffAttachmentRef {
  id: string
  name: string
  mediaType: string
}

export interface DesignHandoffSuggestion {
  type: 'design_handoff_suggestion'
  handoffId: string
  projectId: string
  sourceSessionId: string
  sourceAgentMessageId: string
  originalRequest: string
  brief: string
  attachmentRefs: DesignHandoffAttachmentRef[]
  recommendedContextMode: DesignContextMode
  suggestedCategories: DesignContextCategory[]
  createdAt: number
}

export interface DesignHandoffDraft extends DesignHandoffSuggestion {
  creativeTaskId: string
  state: 'draft'
  selectedAttachmentIds: string[]
  updatedAt: number
}

export type DesignHandoffStatus =
  | 'suggested' | 'dismissed' | 'draft'
  | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  | 'source-invalid'

export interface AcceptDesignHandoffInput { projectId: string; handoffId: string }
export interface DismissDesignHandoffInput { projectId: string; handoffId: string }
export interface GetDesignHandoffStatusInput { projectId: string; handoffId: string }
export interface DesignHandoffStatusResult {
  handoffId: string
  creativeTaskId: string
  status: DesignHandoffStatus
  latestJobId?: string
  outputAssetId?: string
  error?: string
}
```

`CreateDesignJobInput` 新增可选 `handoffId` 与 `handoffAttachmentIds`；不新增 sourceSessionId/sourceMessageId 的 Renderer 可写覆盖字段。新增通道 `ACCEPT_HANDOFF`、`DISMISS_HANDOFF`、`GET_HANDOFF_STATUS`。

- [ ] **Step 4: 增加 handoffsDir 路径**

```ts
export interface DesignPaths {
  // 既有字段保持不变
  handoffsDir: string
}

return {
  // 既有路径保持不变
  handoffsDir: join(cacheRoot, 'handoffs'),
}
```

- [ ] **Step 5: 运行测试并提交**

Run: `bun test packages/shared/src/types/design.test.ts apps/electron/src/main/lib/design/design-paths.test.ts`

Expected: PASS。

```bash
git add packages/shared/src/types/design.ts packages/shared/src/types/design.test.ts apps/electron/src/main/lib/design/design-paths.ts apps/electron/src/main/lib/design/design-paths.test.ts
git commit -m "设计：建立 Agent 转交共享契约"
```

### Task 2: 实现可恢复且幂等的转交协调器

**Files:**
- Create: `apps/electron/src/main/lib/design/agent-design-handoff-coordinator.ts`
- Create: `apps/electron/src/main/lib/design/agent-design-handoff-coordinator.test.ts`

- [ ] **Step 1: 写失败的协调器行为测试**

```ts
test('Given 当前真实用户消息 When Agent 建议 Design Then 主进程派生 ID、要求和附件', () => {
  const suggestion = coordinator.suggest({
    sessionId: 'session-1', sourceAgentMessageId: 'message-1',
    brief: '制作首页概念图', recommendedContextMode: 'auto',
    suggestedCategories: ['brand', 'product', 'code'],
  })
  expect(suggestion).toMatchObject({
    projectId: 'project-1', sourceSessionId: 'session-1', sourceAgentMessageId: 'message-1',
    originalRequest: '帮我生成当前项目首页效果图',
  })
  expect(suggestion.attachmentRefs).toEqual([{ id: expect.any(String), name: 'logo.png', mediaType: 'image/png' }])
})

test('Given 同一 handoff 重复接受或协调器重启 When 打开 Design Then 返回同一 creativeTaskId 草稿', () => {
  const first = coordinator.accept('project-1', suggestion.handoffId)
  const restarted = createCoordinatorFromSameDisk()
  const second = restarted.accept('project-1', suggestion.handoffId)
  expect(first).toEqual(second)
  expect(second.creativeTaskId).toBe(suggestion.handoffId)
  expect(jobCreateCalls).toBe(0)
  expect(imageExecutorCalls).toBe(0)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/design/agent-design-handoff-coordinator.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 定义私有 journal 与严格校验**

```ts
interface StoredDesignHandoff {
  schemaVersion: 1
  suggestion: DesignHandoffSuggestion
  state: 'suggested' | 'draft' | 'dismissed'
  attachmentBindings: Array<{
    id: string
    sessionRelativePath: string
    dev: number
    ino: number
    byteSize: number
  }>
  selectedAttachmentIds: string[]
  updatedAt: number
}
```

journal 写入 `handoffs/<handoffId>.json`，使用 `writeJsonFileAtomic`。公开 suggestion 只含附件 ID、名称和媒体类型；私有 binding 只保存会话附件目录内的相对路径和稳定文件身份，不保存任意外部绝对路径。

- [ ] **Step 4: 实现 suggest、accept、dismiss 和 status**

```ts
export interface AgentDesignHandoffCoordinatorContract {
  suggest: (input: SuggestDesignHandoffInput) => DesignHandoffSuggestion
  accept: (projectId: string, handoffId: string) => DesignHandoffDraft
  dismiss: (projectId: string, handoffId: string) => DesignHandoffStatusResult
  getStatus: (projectId: string, handoffId: string) => DesignHandoffStatusResult
  resolveForJob: (input: ResolveDesignHandoffForJobInput) => ResolvedDesignHandoff
}
```

`suggest()` 必须验证：session 是用户可见会话、workspaceId 与 projectId 一致、source message UUID 存在且是当前真实 user input、消息未被截断或合成；从消息 `<attached_files>` 块提取附件，并通过会话附件目录 realpath/身份/大小/媒体签名验证。模型提供的 ID、路径、projectId、sourceSessionId 一律不接受。

- [ ] **Step 5: 补齐失效和附件竞态测试**

覆盖：会话移动到其他项目、消息被回退删除、附件被替换、handoffId 跨项目使用、dismiss 后重复 accept、损坏 journal、同一来源消息多次调用工具。最后一项使用 `sessionId + sourceAgentMessageId` 建唯一索引并返回已有 suggestion，避免模型重放产生多张卡。

- [ ] **Step 6: 运行测试并提交**

Run: `bun test apps/electron/src/main/lib/design/agent-design-handoff-coordinator.test.ts`

Expected: PASS，所有打开/忽略/重启路径的 Job 与图片调用计数为 0。

```bash
git add apps/electron/src/main/lib/design/agent-design-handoff-coordinator.ts apps/electron/src/main/lib/design/agent-design-handoff-coordinator.test.ts
git commit -m "设计：实现 Agent 转交协调器"
```

### Task 3: 向普通 Pi Agent 注入语义转交工具

**Files:**
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Create: `apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.test.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.test.ts`

- [ ] **Step 1: 写失败的工具注入测试**

```ts
test('Given 用户项目会话 When 构建 Pi tools Then 提供无付费的 suggest_design_handoff', async () => {
  const result = await buildPiBuiltinTools(sdk, visibleUserContext)
  expect(result.tools.map((tool) => tool.name)).toContain('suggest_design_handoff')
})

test('Given Design 内部或 delegation run When 构建 tools Then 不提供转交工具', async () => {
  expect(await toolNames(internalDesignContext)).not.toContain('suggest_design_handoff')
  expect(await toolNames(delegationContext)).not.toContain('suggest_design_handoff')
})

test('Given 转交工具执行 When 读取结果 Then details 是结构化 suggestion 且没有创建 Job', async () => {
  const result = await executeTool('suggest_design_handoff', {
    brief: '制作首页视觉稿', recommendedContextMode: 'auto',
    suggestedCategories: ['brand', 'product', 'code'],
  })
  expect(result.details).toMatchObject({ type: 'design_handoff_suggestion', handoffId: expect.any(String) })
  expect(jobCreateCalls).toBe(0)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts`

Expected: FAIL，工具和消息上下文尚未注入。

- [ ] **Step 3: 把真实用户消息 UUID 传入工具上下文**

`persistInitialUserMessage()` 已在 Pi runtime 和工具构建前同步完成。扩展 `PiBuiltinToolsContext`：

```ts
export interface PiBuiltinToolsContext {
  // 既有字段保持不变
  sourceUserMessageId?: string
  sourceSessionVisible: boolean
  sourceDesignProjectId?: string
  suggestDesignHandoff?: (input: SuggestDesignHandoffToolInput) => DesignHandoffSuggestion
  onDesignHandoffSuggested?: () => void
}
```

`agent-orchestrator.ts` 传 `sourceUserMessageId: initialUserMessageUuid`。如果本轮没有新持久化用户消息、没有 workspace、来源不是 user 或会话是内部 Design，会把 `suggestDesignHandoff` 留空。

- [ ] **Step 4: 定义无路径、无 ID 输入的 Pi 工具**

```ts
sdk.defineTool({
  name: 'suggest_design_handoff',
  label: '建议打开设计',
  description: '当用户需要实际生成或编辑视觉内容，且进入 Design 能提供上下文、画布或版本能力时，创建可编辑的转交建议。纯讨论、代码实现或用户明确要求留在对话时不要调用。',
  parameters: Type.Object({
    brief: Type.String({ minLength: 1, maxLength: 2000 }),
    recommendedContextMode: Type.Union([Type.Literal('auto'), Type.Literal('project'), Type.Literal('none')]),
    suggestedCategories: Type.Array(categorySchema, { maxItems: 8 }),
  }),
  async execute(_toolCallId, params) {
    if (!ctx.suggestDesignHandoff) throw new Error('当前会话不能创建 Design 转交')
    const suggestion = ctx.suggestDesignHandoff(params as SuggestDesignHandoffToolInput)
    ctx.onDesignHandoffSuggested?.()
    return createJsonToolResult(suggestion)
  },
})
```

工具输入不包含 handoffId、sessionId、messageId、projectId、附件路径或 creativeTaskId。返回 `createJsonToolResult(suggestion)`，使 Pi adapter 把同一对象持久化到 SDK `tool_use_result`。

- [ ] **Step 5: 在系统提示词描述语义边界**

在 `agent-prompt-builder.ts` 增加独立“视觉执行转交”段落：判断用户是否需要实际视觉产出；可识别首页概念图、海报、品牌视觉、图片编辑、角色/场景设计等自然表达；纯策略讨论、代码改 UI 或文本策划继续对话；用户明确“就在对话生成”时不转交；转交只创建建议，必须等待用户在 Design 显式提交。

测试只断言语义规则和工具名，不维护前端关键词列表。

- [ ] **Step 6: 运行测试并提交**

Run: `bun test apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/adapters/pi-builtin-tools.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/agent-prompt-builder.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts
git commit -m "设计：让 Agent 语义建议打开设计"
```

### Task 4: 阻止同一 turn 重复生图

**Files:**
- Modify: `apps/electron/src/main/lib/agent-run-tool-policy.ts`
- Modify: `apps/electron/src/main/lib/agent-design-tool-policy.test.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`

- [ ] **Step 1: 写失败的互斥策略测试**

```ts
test('Given 本 turn 已建议 Design When 再调用普通图片工具 Then 在权限和 executor 前拒绝', () => {
  const guard = createDesignHandoffTurnGuard()
  expect(guard.check('suggest_design_handoff')).toBeUndefined()
  guard.markSuggested()
  expect(guard.check('mcp__nano_banana__generate_image')).toEqual({
    behavior: 'deny', message: '本轮已建议转到 Design，不能同时在对话中生成图片',
  })
})

test('Given 用户没有触发转交 When 调用普通图片工具 Then 保持现有权限流程', () => {
  const guard = createDesignHandoffTurnGuard()
  expect(guard.check('mcp__nano_banana__generate_image')).toBeUndefined()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/agent-design-tool-policy.test.ts`

Expected: FAIL，turn guard 尚不存在。

- [ ] **Step 3: 实现 per-run 动态 guard**

```ts
export function createDesignHandoffTurnGuard(): {
  markSuggested: () => void
  check: (toolName: string) => PermissionResult | undefined
} {
  let suggested = false
  return {
    markSuggested: () => { suggested = true },
    check: (toolName) => suggested && toolName.endsWith('__generate_image')
      ? { behavior: 'deny', message: '本轮已建议转到 Design，不能同时在对话中生成图片' }
      : undefined,
  }
}
```

`canUseTool` 中执行顺序固定为 stale generation -> run allowlist -> handoff turn guard -> 参数校验 -> 调用次数 limiter -> 普通权限。这样一旦工具 result 成功，任何随后或并发稍晚进入权限边界的图片工具都不能到 executor。

- [ ] **Step 4: 增加并发准入测试**

模拟 suggestion 工具先成功、图片工具随后请求；再模拟图片工具已先通过并开始执行时 suggestion 到达。前者拒绝图片，后者不虚假承诺撤销已发生调用，因此工具描述要求 Agent 在决定转交时先调用 suggestion，不并行调用图片工具。

- [ ] **Step 5: 运行测试并提交**

Run: `bun test apps/electron/src/main/lib/agent-design-tool-policy.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/agent-run-tool-policy.ts apps/electron/src/main/lib/agent-design-tool-policy.test.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-orchestrator.test.ts
git commit -m "设计：阻止转交后同轮重复生图"
```

### Task 5: 打通接受、忽略、状态与 Job 创建 IPC

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/design-ipc.test.ts`
- Modify: `apps/electron/src/preload/design-preload.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写失败的 IPC 与 Job 验证测试**

```ts
test('Given 建议 When 接受 Then 返回 draft 且不创建 Job或调用图片', async () => {
  const draft = await invoke(handlers, DESIGN_IPC_CHANNELS.ACCEPT_HANDOFF, sender, {
    projectId: 'project-1', handoffId: 'handoff-1',
  })
  expect(draft).toMatchObject({ state: 'draft', creativeTaskId: 'handoff-1' })
  expect(jobCreateCalls).toBe(0)
  expect(imageExecutorCalls).toBe(0)
})

test('Given 已接受 handoff When 用户显式提交 Then Job 固化来源且 creativeTaskId 等于 handoffId', () => {
  const job = manager.create({
    projectId: 'project-1', action: 'generate', prompt: '调整后的首页要求',
    imageModelProfileId: 'profile-1', contextMode: 'auto', position: { x: 0, y: 0 },
    handoffId: 'handoff-1', handoffAttachmentIds: ['attachment-1'],
  })
  expect(job).toMatchObject({
    creativeTaskId: 'handoff-1', sourceSessionId: 'session-1', sourceAgentMessageId: 'message-1',
    originalRequest: '帮我生成当前项目首页效果图',
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: FAIL，handler 和 handoff 解析尚未接入。

- [ ] **Step 3: 在 create 前解析权威 handoff**

`DesignJobManager.create()` 收到 `handoffId` 时调用 coordinator `resolveForJob`。主进程验证：状态为 draft、projectId 匹配、来源会话和消息仍有效、附件 ID 是建议附件子集、文件身份未变化。然后固化 `creativeTaskId`、sourceSessionId、sourceAgentMessageId、originalRequest 和可信附件路径；Renderer 只控制可编辑 prompt、contextMode、模型和附件子集。

不带 handoffId 的 Design 直接提交继续由 Manager 生成新 creativeTaskId。

- [ ] **Step 4: 注册三条严格 IPC 并同步 preload/adapter**

```ts
export interface DesignPreloadApi {
  // 既有方法保持不变
  acceptDesignHandoff: (input: AcceptDesignHandoffInput) => Promise<DesignHandoffDraft>
  dismissDesignHandoff: (input: DismissDesignHandoffInput) => Promise<DesignHandoffStatusResult>
  getDesignHandoffStatus: (input: GetDesignHandoffStatusInput) => Promise<DesignHandoffStatusResult>
}
```

accept/dismiss 在项目写锁内更新 journal；getStatus 是只读查询，并把同 creativeTaskId 最新 attempt 状态聚合为卡片状态。任何 handler 都不能接收路径、完整 suggestion 或 Job 状态覆盖。

- [ ] **Step 5: 覆盖伪造和恢复边界**

增加测试：跨项目 handoff、未接受直接 create、dismiss 后 create、附件 ID 越界、来源消息回退、应用重启后 getStatus、失败重试继续同 creativeTaskId、基于版本继续不回写旧卡片。

- [ ] **Step 6: 运行四层测试并提交**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/design/design-job-manager.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-ipc.ts apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "设计：打通 Agent 转交与任务状态"
```

### Task 6: 用 Jotai 幂等预填 Design 并保持显式提交

**Files:**
- Modify: `apps/electron/src/renderer/atoms/design-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/design-atoms.test.ts`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.test.tsx`

- [ ] **Step 1: 写失败的预填状态测试**

```ts
test('Given 同一 handoff 被重复打开 When 写入预填 Then 不覆盖用户已编辑的草稿', () => {
  store.set(applyDesignHandoffDraftAtom, { projectId: 'project-1', draft })
  store.set(updateDesignProjectStateAtom, { projectId: 'project-1', update: { generationPrompt: '用户已修改' } })
  store.set(applyDesignHandoffDraftAtom, { projectId: 'project-1', draft })
  expect(store.get(designProjectStatesAtom).get('project-1')?.generationPrompt).toBe('用户已修改')
})

test('Given 预填草稿 When 打开 Design 但不提交 Then createJob 调用次数为零', async () => {
  render(<DesignInspector projectId="project-1" />)
  expect(adapter.createJob).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/DesignInspector.test.tsx`

Expected: FAIL，handoff 状态与 action 尚不存在。

- [ ] **Step 3: 扩展每项目 Design 状态**

```ts
export interface DesignProjectState {
  // 既有字段保持不变
  handoffDraft: DesignHandoffDraft | null
  handoffDraftDirty: boolean
}

export const applyDesignHandoffDraftAtom = atom(null, (get, set, input: {
  projectId: string
  draft: DesignHandoffDraft
}) => {
  const current = get(designProjectStatesAtom).get(input.projectId) ?? createInitialDesignProjectState()
  if (current.handoffDraft?.handoffId === input.draft.handoffId) return
  set(updateDesignProjectStateAtom, {
    projectId: input.projectId,
    update: {
      handoffDraft: input.draft,
      handoffDraftDirty: false,
      generationPrompt: input.draft.brief,
      contextMode: input.draft.recommendedContextMode,
    },
  })
})
```

新 handoff 把 `brief` 预填到 generationPrompt，把 recommendedContextMode 预填到 contextMode，并默认选中所有附件。任何字段变化把 `handoffDraftDirty` 设为 true；项目切换保留各自草稿，任务成功后只清理对应项目和 handoffId。

- [ ] **Step 4: 在 Inspector 展示来源和附件选择**

AI 表单顶部显示紧凑来源行“来自 Agent 对话”，附件用可移除 chip；用户可以修改要求、三态模式、模型和附件子集。提交 helper 把 `handoffId` 和选中附件 IDs 放进 `CreateDesignJobInput`，但只有点击“生成图片/开始编辑”才调用 `createJob`。

- [ ] **Step 5: 运行测试并提交**

Run: `bun test apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/DesignInspector.test.tsx`

Expected: PASS，重复打开、刷新状态恢复和只打开不提交均不触发 createJob。

```bash
git add apps/electron/src/renderer/atoms/design-atoms.ts apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/DesignInspector.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx
git commit -m "设计：实现 Agent 转交预填草稿"
```

### Task 7: 在 Agent 消息中渲染结构化转交卡片

**Files:**
- Create: `apps/electron/src/renderer/components/agent/DesignHandoffCard.tsx`
- Create: `apps/electron/src/renderer/components/agent/DesignHandoffCard.test.tsx`
- Modify: `apps/electron/src/renderer/components/agent/ContentBlock.tsx`
- Modify: `apps/electron/src/renderer/components/agent/ContentBlock.test.tsx`

- [ ] **Step 1: 写失败的结构化渲染测试**

```ts
test('Given assistant 文本包含生图关键词但没有结构化 tool result When 渲染 Then 不显示转交卡', () => {
  renderMessage('我建议打开设计面板生成图片')
  expect(screen.queryByRole('button', { name: '打开设计' })).toBeNull()
})

test('Given 真实 design_handoff_suggestion result When 渲染 Then 显示打开和留在对话', () => {
  renderToolResult(suggestion)
  expect(screen.getByRole('button', { name: '打开设计' })).toBeVisible()
  expect(screen.getByRole('button', { name: '留在对话' })).toBeVisible()
})

test('Given 点击打开设计 When 接受成功 Then 切项目、预填并导航且不创建 Job', async () => {
  await user.click(screen.getByRole('button', { name: '打开设计' }))
  expect(adapter.acceptDesignHandoff).toHaveBeenCalledWith({ projectId: 'project-1', handoffId: 'handoff-1' })
  expect(store.get(currentAgentWorkspaceIdAtom)).toBe('project-1')
  expect(store.get(activeViewAtom)).toBe('design')
  expect(adapter.createJob).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/renderer/components/agent/DesignHandoffCard.test.tsx apps/electron/src/renderer/components/agent/ContentBlock.test.tsx`

Expected: FAIL，组件和分派不存在。

- [ ] **Step 3: 从 tool_use_result.details 严格解析 suggestion**

扩展 `useToolResult()` 返回 `details?: unknown`，来源是匹配 tool_result 所在 `SDKUserMessage.tool_use_result`。新增 `parseDesignHandoffSuggestion(value)`，严格检查 `type`、稳定 ID、枚举、数组长度和字符串上限；解析失败回退普通工具行，不渲染卡片。

`ContentBlock` 只在 `block.name === 'suggest_design_handoff'` 且 details 校验成功时渲染 `DesignHandoffCard`。assistant text、tool input 和普通 JSON 文本都不作为卡片来源。

- [ ] **Step 4: 实现卡片交互和状态回显**

卡片为单层紧凑面板，显示 brief、推荐上下文模式和附件数量。初态有 `打开设计`、`留在对话`；接受后订阅 `designAdapter.onChanged`，只在同 projectId 事件时重新查询 `getDesignHandoffStatus`。状态映射：draft“待提交”、queued/running“生成中”、succeeded“已完成”、failed/cancelled/interrupted 显示明确状态与“在设计中查看”。

点击 `留在对话` 调 dismiss、恢复对话输入焦点，不调用普通图片工具；点击已完成卡片只导航 Design 并定位 `latestJobId/outputAssetId`，不创建新版本。

- [ ] **Step 5: 覆盖加载、失效和可访问性**

测试接受中禁用重复点击；来源失效显示“转交来源已失效”；长 brief 换行；窄宽度按钮换行不溢出；键盘可触发两个命令；图标使用 lucide；未知状态不伪装成功；组件卸载时解除 Design change 订阅。

- [ ] **Step 6: 运行测试并提交**

Run: `bun test apps/electron/src/renderer/components/agent/DesignHandoffCard.test.tsx apps/electron/src/renderer/components/agent/ContentBlock.test.tsx`

Expected: PASS。

```bash
git add apps/electron/src/renderer/components/agent/DesignHandoffCard.tsx apps/electron/src/renderer/components/agent/DesignHandoffCard.test.tsx apps/electron/src/renderer/components/agent/ContentBlock.tsx apps/electron/src/renderer/components/agent/ContentBlock.test.tsx
git commit -m "设计：在 Agent 消息中展示设计转交卡"
```

### Task 8: 完成端到端回归与零计费验收

**Files:**
- Modify: `apps/electron/src/main/lib/design/agent-design-handoff-coordinator.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.test.ts`
- Modify: `apps/electron/src/renderer/components/agent/DesignHandoffCard.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.test.tsx`

- [ ] **Step 1: 增加完整 fake 链路测试**

```ts
test('Given Agent 建议 Design When 用户接受、修改并显式提交 Then 只创建一个同 creativeTaskId 的 Job', async () => {
  const suggestion = await fakeAgent.callSuggestTool()
  const draft = coordinator.accept('project-1', suggestion.handoffId)
  expect(imageExecutorCalls).toBe(0)
  const job = manager.create({
    projectId: 'project-1', action: 'generate', prompt: '用户调整后的要求',
    imageModelProfileId: 'profile-1', contextMode: 'auto', position: { x: 0, y: 0 },
    handoffId: draft.handoffId, handoffAttachmentIds: draft.selectedAttachmentIds,
  })
  expect(job.creativeTaskId).toBe(suggestion.handoffId)
  await manager.run(job.id)
  expect(imageExecutorCalls).toBe(1)
})
```

- [ ] **Step 2: 增加自然表达和非转交场景 fixture**

用 fake Agent 决策 fixture 覆盖“做张当前项目首页概念图”“把这张图改成杂志封面”“给角色设计三个造型”；同时覆盖“讨论一下首页视觉策略”“直接修改 CSS”“就在对话里生成”。测试目标是工具事件有无和计费边界，不断言固定关键词解析器，因为 Renderer 不存在该解析器。

- [ ] **Step 3: 增加恢复与重复动作测试**

覆盖：重复工具调用复用 handoffId；重复点击复用草稿；应用重启后重新打开；dismiss 后不自动生图；queued/running 不因卡片刷新重复 create；失败重试仍回显旧卡；基于结果继续创建新 creativeTaskId 后旧卡保持原任务完成态。

- [ ] **Step 4: 运行第三阶段定向测试**

Run:

```bash
bun test packages/shared/src/types/design.test.ts \
  apps/electron/src/main/lib/design/design-paths.test.ts \
  apps/electron/src/main/lib/design/agent-design-handoff-coordinator.test.ts \
  apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts \
  apps/electron/src/main/lib/agent-prompt-builder.test.ts \
  apps/electron/src/main/lib/agent-design-tool-policy.test.ts \
  apps/electron/src/main/lib/agent-orchestrator.test.ts \
  apps/electron/src/main/lib/design/design-job-manager.test.ts \
  apps/electron/src/main/lib/design/design-ipc.test.ts \
  apps/electron/src/preload/design-preload.test.ts \
  apps/electron/src/renderer/lib/design-adapter.test.ts \
  apps/electron/src/renderer/atoms/design-atoms.test.ts \
  apps/electron/src/renderer/components/agent/DesignHandoffCard.test.tsx \
  apps/electron/src/renderer/components/agent/ContentBlock.test.tsx \
  apps/electron/src/renderer/components/design/DesignInspector.test.tsx
```

Expected: PASS；只有最后一个“显式提交”场景的 fake image executor 调用次数为 1，其余建议、接受、忽略、导航、刷新和重启场景均为 0。

- [ ] **Step 5: 运行类型检查与 Electron 构建**

Run: `bun run typecheck`

Expected: PASS，无 `any`、tool result 未校验断言或 Jotai 项目串线。

Run: `bun run electron:build`

Expected: PASS，主进程 coordinator、Pi 工具和 Renderer 卡片均进入正确 bundle。

- [ ] **Step 6: 人工无付费冒烟检查并提交**

使用 fake executor 或明确断网测试配置验证：Agent 消息卡片在宽/窄窗口和明暗主题下可用；打开 Design 后要求、模式与附件已预填；不点击提交时任务列表、画布节点和图片调用计数均不变化；点击“留在对话”后输入焦点恢复。

```bash
git add packages/shared/src/types/design.ts apps/electron/src/main/lib/design apps/electron/src/main/lib/adapters/pi-builtin-tools.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-prompt-builder.ts apps/electron/src/main/lib/agent-run-tool-policy.ts apps/electron/src/preload/design-preload.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/atoms/design-atoms.ts apps/electron/src/renderer/components/agent apps/electron/src/renderer/components/design/DesignInspector.tsx
git commit -m "设计：完成 Agent 与 Design 统一转交验收"
```

## 第三阶段完成条件

- Agent 能按完整语义识别多种视觉执行表达，Renderer 不维护关键词规则。
- 纯讨论、代码实现或用户明确要求留在对话时不会强制显示转交卡。
- `suggest_design_handoff` 不创建 Job、不调用图片模型、不接受模型提供的授权 ID 或路径。
- 打开 Design 可编辑预填要求、上下文模式、模型和附件；只有显式提交才开始内部 Agent 与图片执行。
- 同一来源消息、handoffId、重复点击和应用重启都恢复同一草稿。
- 转交成功后同一 turn 的普通图片工具被拒绝，避免重复执行和重复计费。
- Agent 卡片按 creativeTaskId 回显草稿、生成中、完成、失败、取消和中断，不接收 Design 执行消息副本。
- 所有定向测试、`bun run typecheck` 和 `bun run electron:build` 通过。
