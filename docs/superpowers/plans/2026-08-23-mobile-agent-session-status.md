# 手机端 Agent 会话状态与星标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让手机端会话列表实时显示 Agent 四态色块、可交互星标和相对时间，并在重连后从权威快照恢复。

**Architecture:** 主进程现有 Agent Island 状态机继续拥有 `idle/running/needs-interaction/completed/error` 状态，向 LAN Adapter 暴露无 UI 细节的四态查询。LAN 列表返回快照，Agent EventBus 只在语义状态事件后向全部认证客户端广播轻量状态消息；正文流仍保持按会话订阅。移动端通过 Jotai 合并快照和增量事件，并复用一个无 Hook 的 Agent 会话行组件。

**Tech Stack:** Bun、TypeScript、Electron、React 18、Jotai、WebSocket、Lucide React、Bun Test

---

## 文件结构

- `packages/shared/src/types/lan-bridge.ts`：增加 LAN Agent 四态类型和 DTO 字段。
- `apps/electron/src/main/lib/agent-island-runtime-status.ts`：将 Agent Island 内部快照纯投影为 LAN 四态，并清除完成未读。
- `apps/electron/src/main/lib/agent-island-service.ts`：提供四态只读查询和可观察的“已查看”结果。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter-core.ts`：映射星标/状态并封装星标切换与已查看操作。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.ts`：将会话元数据更新和 Agent Island 状态绑定到 Adapter。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-subscription.ts`：向全部认证客户端广播语义状态变化。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts`：注册星标命令，并在完成会话读取后广播空闲状态。
- `apps/mobile/src/lib/session-runtime-state.ts`：规范化与合并会话状态的纯函数。
- `apps/mobile/src/components/conversation/AgentSessionRow.tsx`：统一抽屉与下拉中的 Agent 会话行。
- `apps/mobile/src/App.tsx`：消费全局运行状态推送。
- `apps/mobile/src/components/layout/Drawer.tsx`、`apps/mobile/src/components/conversation/ConvDropdown.tsx`：复用会话行并提交星标切换。
- `apps/mobile/src/components/conversation/InputBar.tsx`：从当前 Agent 权威状态恢复停止按钮。

### Task 1: 锁定共享 DTO 与 Adapter 快照

**Files:**
- Modify: `packages/shared/src/types/lan-bridge.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter-core.ts`
- Test: `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts`

- [ ] **Step 1: 写失败测试**

在测试依赖的 `agent-1` 增加 `starred: true`，注入状态读取与星标更新依赖：

```ts
getAgentSessionRuntimeStatus: sessionId => sessionId === 'agent-1' ? 'blocked' : 'idle',
updateAgentSessionStarred: sessionId => ({
  ...createDependencies().listAgentSessions().find(session => session.id === sessionId)!,
  starred: false,
}),
markAgentSessionViewed: () => true,
```

断言 `listAgentSessions()` 为 `agent-1` 返回 `starred: true`、`runtimeStatus: 'blocked'`，为 `agent-2` 返回 `runtimeStatus: 'idle'`；断言 `toggleAgentSessionStar('agent-1')` 返回 `starred: false`。

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts`

Expected: FAIL，提示缺少依赖字段、DTO 字段或 `toggleAgentSessionStar`。

- [ ] **Step 3: 增加最小共享类型与 Adapter 实现**

```ts
export type LanBridgeAgentSessionRuntimeStatus = 'idle' | 'running' | 'blocked' | 'completed'

export interface LanBridgeAgentSessionDto {
  id: string
  title: string
  workspaceId?: string
  pinned?: boolean
  archived?: boolean
  manualWorking?: boolean
  starred?: boolean
  runtimeStatus?: LanBridgeAgentSessionRuntimeStatus
  createdAt: number
  updatedAt: number
}
```

Adapter 依赖增加：

```ts
getAgentSessionRuntimeStatus: (sessionId: string) => LanBridgeAgentSessionRuntimeStatus
updateAgentSessionStarred: (sessionId: string) => UpstreamAgentSession
markAgentSessionViewed: (sessionId: string) => boolean
```

`mapAgentSession` 接收状态并输出 `starred`、`runtimeStatus`；Adapter 增加：

```ts
getAgentSessionRuntimeStatus: sessionId => {
  assertExistingAgentSession(dependencies, sessionId)
  return dependencies.getAgentSessionRuntimeStatus(sessionId)
},
toggleAgentSessionStar: sessionId => {
  assertExistingAgentSession(dependencies, sessionId)
  return mapAgentSession(
    dependencies.updateAgentSessionStarred(sessionId),
    dependencies.getAgentSessionRuntimeStatus(sessionId),
  )
},
markAgentSessionViewed: sessionId => {
  assertExistingAgentSession(dependencies, sessionId)
  const changed = dependencies.markAgentSessionViewed(sessionId)
  return { changed, runtimeStatus: dependencies.getAgentSessionRuntimeStatus(sessionId) }
},
```

- [ ] **Step 4: 运行定向测试并确认通过**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交协议与 Adapter 快照**

```bash
git add packages/shared/src/types/lan-bridge.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter-core.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts
git commit -m "功能：扩展手机端会话状态快照"
```

### Task 2: 暴露主进程四态并广播生命周期

**Files:**
- Create: `apps/electron/src/main/lib/agent-island-runtime-status.ts`
- Create: `apps/electron/src/main/lib/agent-island-runtime-status.test.ts`
- Modify: `apps/electron/src/main/lib/agent-island-service.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-subscription.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-subscription.test.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge.ts`

- [ ] **Step 1: 写 Agent Island 四态投影失败测试**

对纯状态快照断言四态和清除完成未读行为：

```ts
expect(projectAgentIslandRuntimeStatus({ phase: 'running', unread: false })).toBe('running')
expect(projectAgentIslandRuntimeStatus({ phase: 'needs-interaction', unread: false })).toBe('blocked')
expect(projectAgentIslandRuntimeStatus({ phase: 'completed', unread: true })).toBe('completed')
expect(projectAgentIslandRuntimeStatus({ phase: 'error', unread: true })).toBe('completed')
expect(projectAgentIslandRuntimeStatus({ phase: 'completed', unread: false })).toBe('idle')

const completed = { phase: 'completed' as const, unread: true, attention: true }
expect(markAgentIslandRuntimeViewed(completed)).toBe(true)
expect(completed).toEqual({ phase: 'completed', unread: false, attention: false })
expect(markAgentIslandRuntimeViewed(completed)).toBe(false)
```

- [ ] **Step 2: 运行测试并确认缺少查询 API**

Run: `bun test apps/electron/src/main/lib/agent-island-runtime-status.test.ts`

Expected: FAIL，提示纯投影模块不存在。

- [ ] **Step 3: 实现四态查询与已查看返回值**

```ts
export function projectAgentIslandRuntimeStatus(
  session: AgentIslandRuntimeState | undefined,
): LanBridgeAgentSessionRuntimeStatus {
  if (session?.phase === 'needs-interaction') return 'blocked'
  if (session?.phase === 'running') return 'running'
  if ((session?.phase === 'completed' || session?.phase === 'error') && session.unread) return 'completed'
  return 'idle'
}

export function markAgentIslandRuntimeViewed(session: AgentIslandRuntimeState | undefined): boolean {
  if (!session || (session.phase !== 'completed' && session.phase !== 'error') || !session.unread) return false
  session.unread = false
  session.attention = false
  return true
}
```

`agent-island-service.ts` 的公开查询把内部 Map 项交给 `projectAgentIslandRuntimeStatus`；现有 `markAgentIslandSessionViewed` 委托 `markAgentIslandRuntimeViewed`，仅在返回 `true` 时调度推送。

- [ ] **Step 4: 写 LAN 全局状态广播失败测试**

构造一个未订阅目标会话但已认证的客户端，启动订阅时注入状态读取器：

```ts
startSubscription(eventBus, () => 'blocked')
eventBus.emit('session-1', {
  kind: 'proma_event',
  event: { type: 'permission_request', request },
})
await Promise.resolve()
expect(clientMessages).toContainEqual({
  type: 'agent.session.runtime_updated',
  data: { sessionId: 'session-1', runtimeStatus: 'blocked' },
})
```

并断言普通 `sdk_delta` 不产生全局状态消息，正文仍只发给订阅者。

- [ ] **Step 5: 运行订阅测试并确认没有全局事件**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-subscription.test.ts`

Expected: FAIL，未收到 `agent.session.runtime_updated`。

- [ ] **Step 6: 实现语义事件过滤和微任务广播**

```ts
function affectsAgentRuntimeStatus(payload: AgentStreamPayload): boolean {
  if (payload.kind === 'sdk_message') {
    return payload.message.type === 'result'
      || (payload.message.type === 'assistant' && Boolean(payload.message.error))
  }
  if (payload.kind !== 'proma_event') return false
  return [
    'permission_request', 'ask_user_request', 'exit_plan_mode_request',
    'permission_resolved', 'ask_user_resolved', 'exit_plan_mode_resolved',
    'run_started', 'external_run_started', 'run_resumed', 'run_stopped', 'retry',
  ].includes(payload.event.type)
}
```

在 EventBus 同步分发完成后的微任务中读取 Adapter 状态，并使用 `manager.broadcast` 向全部认证客户端发送；然后继续执行原有订阅正文转发。

- [ ] **Step 7: 绑定 Adapter 状态读取器并运行两组测试**

Run: `bun test apps/electron/src/main/lib/agent-island-runtime-status.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-subscription.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交主进程状态广播**

```bash
git add apps/electron/src/main/lib/agent-island-runtime-status.ts apps/electron/src/main/lib/agent-island-runtime-status.test.ts apps/electron/src/main/lib/agent-island-service.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-subscription.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-subscription.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge.ts
git commit -m "功能：广播 Agent 会话实时状态"
```

### Task 3: 增加星标命令与完成状态确认

**Files:**
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.test.ts`

- [ ] **Step 1: 写 Handler 失败测试**

覆盖三个行为：

```ts
expect(await request(client, socket, 'agent.sessions.toggle_star', {
  token,
  sessionId: 'agent-1',
})).toMatchObject({ ok: true, data: { session: { id: 'agent-1', starred: true } } })

expect(broadcasts).toContainEqual({
  type: 'agent.sessions.updated',
  data: { sessionId: 'agent-1' },
})

expect(await request(client, socket, 'agent.sessions.messages', {
  token,
  sessionId: 'agent-1',
})).toMatchObject({ ok: true })
expect(broadcasts).toContainEqual({
  type: 'agent.session.runtime_updated',
  data: { sessionId: 'agent-1', runtimeStatus: 'idle' },
})
```

另加不存在会话返回 `NOT_FOUND`，以及 `markAgentSessionViewed` 返回 `changed: false` 时不广播。

- [ ] **Step 2: 运行测试并确认路由不存在**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.test.ts`

Expected: FAIL，`agent.sessions.toggle_star` 未注册或无广播。

- [ ] **Step 3: 绑定真实依赖并实现 Handler**

组合根通过 `getAgentSessionMeta`、`updateAgentSessionMeta`、`getAgentIslandSessionRuntimeStatus`、`markAgentIslandSessionViewed` 实现 Adapter 依赖。星标切换必须调用现有 `updateAgentSessionMeta`：

```ts
updateAgentSessionStarred: sessionId => {
  const current = getAgentSessionMeta(sessionId)
  if (!current) throw new Error('会话不存在')
  return updateAgentSessionMeta(sessionId, { starred: !current.starred })
},
```

Handler 注册：

```ts
registerRoute('agent.sessions.toggle_star', bind(handleAgentSessionToggleStar))
```

成功切换后返回 `{ session }` 并广播 `agent.sessions.updated`。读取消息后仅在 `changed` 为真时广播 `agent.session.runtime_updated`。

- [ ] **Step 4: 运行 Handler 与 Adapter 测试**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交星标与已查看链路**

```bash
git add apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.test.ts
git commit -m "功能：支持手机端切换会话星标"
```

### Task 4: 合并移动端状态并复用会话行

**Files:**
- Create: `apps/mobile/src/lib/session-runtime-state.ts`
- Create: `apps/mobile/src/lib/session-runtime-state.test.ts`
- Create: `apps/mobile/src/components/conversation/AgentSessionRow.tsx`
- Create: `apps/mobile/src/components/conversation/AgentSessionRow.test.tsx`
- Modify: `apps/mobile/src/atoms/index.ts`
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/components/layout/Drawer.tsx`
- Modify: `apps/mobile/src/components/conversation/ConvDropdown.tsx`
- Modify: `apps/mobile/src/components/conversation/InputBar.tsx`
- Modify: `apps/mobile/src/components/layout/Drawer.test.tsx`

- [ ] **Step 1: 写状态合并失败测试**

```ts
expect(normalizeAgentRuntimeStatus('blocked')).toBe('blocked')
expect(normalizeAgentRuntimeStatus('future-status')).toBe('idle')
expect(updateAgentRuntimeStatus(items, 'agent-1', 'running')).toEqual([
  { ...items[0], runtimeStatus: 'running' },
  items[1],
])
expect(updateAgentRuntimeStatus(items, 'missing', 'running')).toBe(items)
```

同时测试 `updateAgentStarred` 只替换目标 Agent。

- [ ] **Step 2: 运行纯函数测试并确认模块不存在**

Run: `bun test apps/mobile/src/lib/session-runtime-state.test.ts`

Expected: FAIL，无法导入新模块。

- [ ] **Step 3: 实现纯状态函数与 `ConvItem` 字段**

```ts
export type AgentRuntimeStatus = 'idle' | 'running' | 'blocked' | 'completed'

export function normalizeAgentRuntimeStatus(value: unknown): AgentRuntimeStatus {
  return value === 'running' || value === 'blocked' || value === 'completed' ? value : 'idle'
}

export function isAgentRuntimeBusy(status: AgentRuntimeStatus | undefined): boolean {
  return status === 'running' || status === 'blocked'
}
```

更新函数仅在命中目标且值变化时创建新数组，否则返回原引用。

- [ ] **Step 4: 写 Agent 会话行失败测试**

静态渲染四种状态并断言中文 `aria-label`、星标按钮、时间文本和固定列标记；直接调用返回 React 元素中星标按钮的 `onClick`，断言只触发 `onToggleStar`，不会触发 `onOpen`。

- [ ] **Step 5: 运行组件测试并确认组件不存在**

Run: `bun test apps/mobile/src/components/conversation/AgentSessionRow.test.tsx`

Expected: FAIL，无法导入 `AgentSessionRow`。

- [ ] **Step 6: 实现固定四列 Agent 会话行**

```tsx
<div className={active ? 'bg-sidebar-control' : 'hover:bg-sidebar-control/70'}>
  <button type="button" onClick={() => onOpen(session)} className="grid min-w-0 flex-1 grid-cols-[10px_minmax(0,1fr)] items-center gap-2">
    <span aria-label={statusLabel} className={statusClass} />
    <span className="truncate">{session.title || '新对话'}</span>
  </button>
  <button type="button" aria-label={session.starred ? '取消星标' : '添加星标'} onClick={() => onToggleStar(session)} className="flex size-10 items-center justify-center">
    <Star fill={session.starred ? 'currentColor' : 'none'} />
  </button>
  <span className="w-10 text-right text-[10px] text-muted-foreground">{formatRelativeTime(session.updatedAt)}</span>
</div>
```

状态色块使用稳定 `size-2 rounded-[2px]`，并分别采用主题可读的蓝、橙、绿、灰类名。

- [ ] **Step 7: 接入全局事件、星标命令与两个列表**

`App.tsx` 对 `agent.session.runtime_updated` 同时更新 `conversationsAtom` 和同 ID 的 `activeConvAtom`。Drawer 与 ConvDropdown 调用：

```ts
const result = await wsReq('agent.sessions.toggle_star', { token, sessionId: session.id })
const updated = (result as { session: ConvItem }).session
setConvs(current => updateAgentStarred(current, updated.id, !!updated.starred))
setActive(current => current?.id === updated.id ? { ...current, starred: updated.starred } : current)
```

`InputBar` 对 Agent 使用 `isAgentRuntimeBusy(active.runtimeStatus)` 决定发送/停止按钮，对 Chat 保留原 `streamingAtom`。

- [ ] **Step 8: 运行移动端定向测试**

Run: `bun test apps/mobile/src/lib/session-runtime-state.test.ts apps/mobile/src/components/conversation/AgentSessionRow.test.tsx apps/mobile/src/components/layout/Drawer.test.tsx apps/mobile/src/components/conversation/ChatView.test.tsx apps/mobile/src/components/conversation/InputBar.test.tsx`

Expected: PASS。

- [ ] **Step 9: 提交移动端状态 UI**

```bash
git add apps/mobile/src/lib/session-runtime-state.ts apps/mobile/src/lib/session-runtime-state.test.ts apps/mobile/src/components/conversation/AgentSessionRow.tsx apps/mobile/src/components/conversation/AgentSessionRow.test.tsx apps/mobile/src/atoms/index.ts apps/mobile/src/App.tsx apps/mobile/src/components/layout/Drawer.tsx apps/mobile/src/components/conversation/ConvDropdown.tsx apps/mobile/src/components/conversation/InputBar.tsx apps/mobile/src/components/layout/Drawer.test.tsx
git commit -m "功能：展示手机端会话状态与星标"
```

### Task 5: 完整验证与项目记忆

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: 运行全部相关 LAN 与移动端测试**

Run: `bun test apps/electron/src/main/lib/agent-island-runtime-status.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-subscription.test.ts apps/mobile/src/lib/session-runtime-state.test.ts apps/mobile/src/components/conversation/AgentSessionRow.test.tsx apps/mobile/src/components/layout/Drawer.test.tsx apps/mobile/src/components/conversation/ChatView.test.tsx apps/mobile/src/components/conversation/InputBar.test.tsx`

Expected: PASS，零失败。

- [ ] **Step 2: 运行类型检查**

Run: `bun run typecheck`

Expected: PASS，退出码 0。

- [ ] **Step 3: 运行 Electron 构建**

LAN 协议和移动端产物均参与桌面应用，运行：

Run: `bun run electron:build`

Expected: PASS，退出码 0。

- [ ] **Step 4: 检查最终差异和无关文件**

Run: `git diff --check && git status --short`

Expected: 无空白错误；`.superpowers/` 视觉伴侣目录不进入产品提交。

- [ ] **Step 5: 更新项目记忆并提交**

在 `MEMORY.md` 的架构决策中记录：手机端 Agent 会话四态由主进程 Agent Island 状态机提供，LAN 使用列表快照与认证客户端全局状态事件同步，星标复用既有会话元数据。

```bash
git add MEMORY.md docs/superpowers/plans/2026-08-23-mobile-agent-session-status.md
git commit -m "文档：记录手机端会话状态同步方案"
```
