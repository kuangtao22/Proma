# Agent Canvas Workspace Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通 Agent 会话在切换、Renderer 重载和 Proma 重启后恢复用户最后正在查看的有效 Canvas，同时不抢占用户最后选择的其他右侧标签。

**Architecture:** Renderer 使用 Jotai `atomWithStorage` 保存每个 `sessionId` 的具体 Canvas 标签集合与活动 Canvas 标签。SidePanel 仍以主进程返回的实时 metadata 和 binding 为权威，在两者就绪后过滤持久化偏好，并通过宿主身份、初始化标签和用户选择代次阻断迟到恢复。

**Tech Stack:** TypeScript、React、Jotai、Bun Test、Electron Renderer

---

## 文件职责

- `apps/electron/src/renderer/atoms/agent-atoms.ts`：定义持久化状态、严格清洗、更新和最多 50 个会话的有界裁剪。
- `apps/electron/src/renderer/atoms/agent-atoms.test.ts`：验证状态清洗、活动标签语义、会话隔离和有界裁剪。
- `apps/electron/src/renderer/components/agent/canvas-workspace-actions.ts`：提供无 React 依赖的恢复决策函数，隔离 metadata、binding、用户交互和当前标签判断。
- `apps/electron/src/renderer/components/agent/SidePanel.tsx`：接入恢复协调、Canvas 打开/关闭记录和非 Canvas 焦点清理。
- `apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`：验证恢复决策及 SidePanel 接线合同。
- `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts`：通知返回 Canvas 时写入统一持久化状态。
- `apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`：会话删除或归档时清理持久化状态。
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`：结合实时普通 Agent 会话列表执行 50 项有界裁剪。

### Task 1: 建立持久化状态合同

**Files:**
- Modify: `apps/electron/src/renderer/atoms/agent-atoms.test.ts`
- Modify: `apps/electron/src/renderer/atoms/agent-atoms.ts`

- [ ] **Step 1: 写入失败测试**

测试覆盖非法 launcher/非 Canvas 标签被清理、活动 Canvas 必须属于打开集合、关闭活动 Canvas 后同步清空，以及只保留最近 50 个普通 Agent 会话：

```ts
test('Given 损坏或失效持久化值 When 清洗 Then 只保留有效具体 Canvas', () => {
  expect(sanitizeAgentCanvasWorkspaceState({
    openTabs: ['canvas', 'files', 'canvas:valid', 'canvas:valid', 'canvas:'],
    activeTab: 'canvas:missing',
  })).toEqual({ openTabs: ['canvas:valid'], activeTab: null })
})

test('Given 关闭当前 Canvas When 更新状态 Then 同时清空活动标签', () => {
  expect(forgetAgentCanvasWorkspaceTab(
    { openTabs: ['canvas:a', 'canvas:b'], activeTab: 'canvas:a' },
    'canvas:a',
  )).toEqual({ openTabs: ['canvas:b'], activeTab: null })
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test apps/electron/src/renderer/atoms/agent-atoms.test.ts`

Expected: FAIL，提示新的状态类型或 helper 尚未导出。

- [ ] **Step 3: 实现最小状态模型**

在 `agent-atoms.ts` 中新增严格类型与纯函数：

```ts
export type AgentCanvasWorkspaceTab = `canvas:${string}`

export interface PersistedAgentCanvasWorkspaceState {
  openTabs: AgentCanvasWorkspaceTab[]
  activeTab: AgentCanvasWorkspaceTab | null
}

export const agentCanvasWorkspaceStateMapAtom = atomWithStorage<
  Record<string, PersistedAgentCanvasWorkspaceState>
>('proma-agent-canvas-workspace-by-session', {}, undefined, { getOnInit: true })
```

实现 `sanitizeAgentCanvasWorkspaceState`、`rememberAgentCanvasWorkspaceTab`、`forgetAgentCanvasWorkspaceTab`、`setActiveAgentCanvasWorkspaceTab` 与 `pruneAgentCanvasWorkspaceStates`。所有入口必须复用 `parseCanvasWorkspaceTab`，去重并拒绝 launcher；裁剪复用 `MAX_PERSISTED_AGENT_SIDE_PANEL_LAYOUTS` 的 50 项上限和 `AgentSessionMeta.updatedAt` 顺序。

- [ ] **Step 4: 运行定向测试**

Run: `bun test apps/electron/src/renderer/atoms/agent-atoms.test.ts`

Expected: PASS。

### Task 2: 接入 SidePanel 恢复协调

**Files:**
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`
- Modify: `apps/electron/src/renderer/components/agent/canvas-workspace-actions.ts`
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.tsx`

- [ ] **Step 1: 写入恢复决策失败测试**

新增纯函数 `selectPersistedCanvasWorkspaceRestore` 的 BDD 用例：

```ts
test('Given 上次正在查看的 Canvas 仍有效 When registry 就绪且用户未切换 Then 恢复该标签', () => {
  expect(selectPersistedCanvasWorkspaceRestore({
    persistedActiveTab: 'canvas:canvas-1',
    availableTabs: ['canvas:canvas-1'],
    bindingReady: true,
    metadataReady: true,
    sidePanelOpen: true,
    initialTab: 'files',
    currentTab: 'files',
    userSelectionGeneration: 0,
  })).toBe('canvas:canvas-1')
})

test('Given 加载期间用户切换到文件 When 恢复结果到达 Then 不覆盖用户选择', () => {
  expect(selectPersistedCanvasWorkspaceRestore({
    persistedActiveTab: 'canvas:canvas-1',
    availableTabs: ['canvas:canvas-1'],
    bindingReady: true,
    metadataReady: true,
    sidePanelOpen: true,
    initialTab: 'changes',
    currentTab: 'files',
    userSelectionGeneration: 1,
  })).toBeNull()
})
```

同时覆盖右栏关闭、metadata/binding 未就绪和活动 Canvas 已失效。

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`

Expected: FAIL，提示恢复决策函数尚不存在。

- [ ] **Step 3: 实现恢复决策与 SidePanel 接线**

`canvas-workspace-actions.ts` 新增无副作用的恢复决策函数；`SidePanel.tsx` 改用 `agentCanvasWorkspaceStateMapAtom`：

```ts
const persistedCanvasState = sanitizeAgentCanvasWorkspaceState(
  canvasWorkspaceStateMap[sessionId],
)
```

恢复 effect 仅在当前 `projectId + sessionId` 的 metadata 与 binding 同时就绪后运行。它先用 `availableCanvasWorkspaceTabs` 清洗 `openTabs`，再复核初始标签、当前标签、右栏开关和用户选择代次；满足条件才调用 `onTabChange(activeTab)`。宿主变化时递增恢复代次，旧 effect 无权回写。

`handleWorkspaceTabChange` 每次明确选择都递增用户选择代次：具体 Canvas 写入并激活；非 Canvas 清空持久化 `activeTab` 但保留 `openTabs`。`handleCanvasWorkspaceTabChange` 复用同一状态更新方法。关闭、归档、删除、解绑及失效过滤通过统一 helper 同时维护 `openTabs` 与 `activeTab`。

- [ ] **Step 4: 运行 SidePanel 回归**

Run: `bun test apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`

Expected: PASS。

### Task 3: 统一外部导航、清理与有界裁剪

**Files:**
- Modify: `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts`
- Modify: `apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- Modify: `apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts`
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`

- [ ] **Step 1: 写入失败测试**

锁定三条跨组件合同：通知点击必须调用统一 Canvas 状态 helper 并激活目标；会话删除/归档删除整个持久化条目；AppShell 根据普通 Agent 会话元数据裁剪状态。

```ts
expect(listenerSource).toContain('rememberAgentCanvasWorkspaceTab')
expect(sidebarSource).toContain('agentCanvasWorkspaceStateMapAtom')
expect(appShellSource).toContain('pruneAgentCanvasWorkspaceStates')
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`

Expected: FAIL，提示外部入口仍使用旧内存 Map。

- [ ] **Step 3: 替换外部写入入口**

通知导航从旧 `Map<string, AgentSidePanelTab[]>` 更新改为：

```ts
store.set(agentCanvasWorkspaceStateMapAtom, (previous) => ({
  ...previous,
  [sessionId]: rememberAgentCanvasWorkspaceTab(previous[sessionId], targetTab, true),
}))
```

LeftSidebar 的会话终态清理删除 `Record` 键。AppShell 在会话列表变化时调用 `pruneAgentCanvasWorkspaceStates(previous, agentSessions, currentSessionId)`；不得触发 IPC 或 Canvas LOAD。

- [ ] **Step 4: 运行相关测试与类型检查**

Run: `bun test apps/electron/src/renderer/atoms/agent-atoms.test.ts apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts`

Expected: PASS。

Run: `bun run typecheck`

Expected: PASS，无 TypeScript 错误。

- [ ] **Step 5: 检查变更边界**

Run: `git diff --check`

Expected: 无空白错误。

Run: `git diff -- apps/electron/src/renderer/atoms/agent-atoms.ts apps/electron/src/renderer/atoms/agent-atoms.test.ts apps/electron/src/renderer/components/agent/canvas-workspace-actions.ts apps/electron/src/renderer/components/agent/SidePanel.tsx apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx apps/electron/src/renderer/components/app-shell/AppShell.tsx MEMORY.md`

Expected: 仅包含 Canvas 工作区持久化增量及工作树中已经存在、明确保留的相关改动。由于这些文件已有重叠未提交工作，本轮不自动创建代码提交，避免夹带既有变更。
