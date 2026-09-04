# Canvas Initial Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户从“添加 -> 打开画布”进入时直接打开默认或首个未归档画布，并在空项目中自动创建画布。

**Architecture:** 在 Canvas 宿主动作模块新增纯选择函数与单飞入口控制器，集中处理默认优先、首项回退、空列表创建和重复点击。`SidePanel` 只负责把已就绪的项目画布、当前默认 ID 与现有打开/创建回调交给控制器；不改变 IPC、binding 持久化或 Canvas registry 的后台行为。

**Tech Stack:** TypeScript、React、Jotai、Bun Test、Electron Renderer

---

### Task 1: 锁定首次打开决策和单飞行为

**Files:**
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`
- Modify: `apps/electron/src/renderer/components/agent/canvas-workspace-actions.ts`

- [ ] **Step 1: 写入失败测试**

在 `SidePanel.canvas.test.tsx` 导入 `createCanvasWorkspaceEntryController` 和 `selectInitialCanvasWorkspaceSession`，增加以下 BDD 用例：

```ts
test('Given 默认、首项和归档画布 When 选择首次打开目标 Then 默认优先且只考虑未归档画布', () => {
  const sessions = [
    createCanvasSession('canvas-first'),
    createCanvasSession('canvas-default'),
    createCanvasSession('canvas-archived', true),
  ]

  expect(selectInitialCanvasWorkspaceSession(sessions, 'canvas-default')?.id).toBe('canvas-default')
  expect(selectInitialCanvasWorkspaceSession(sessions, 'canvas-missing')?.id).toBe('canvas-first')
  expect(selectInitialCanvasWorkspaceSession([createCanvasSession('canvas-archived', true)], 'canvas-archived')).toBeNull()
})

test('Given 项目没有可用画布 When 首次打开被快速触发两次 Then 只创建一次并共享结果', async () => {
  let createCalls = 0
  const controller = createCanvasWorkspaceEntryController()
  const input = {
    sessions: [],
    defaultCanvasId: undefined,
    openCanvas: async () => false,
    createCanvas: async () => {
      createCalls += 1
      await Promise.resolve()
      return true
    },
  }

  const first = controller.open(input)
  const second = controller.open(input)

  expect(first).toBe(second)
  expect(await first).toBe(true)
  expect(createCalls).toBe(1)
})
```

测试文件内新增 `createCanvasSession(id, archived)` fixture，完整填写 `CanvasSessionMeta` 所需字段。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `bun test apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`

Expected: FAIL，提示两个新函数未导出。

- [ ] **Step 3: 实现最小选择函数和入口控制器**

在 `canvas-workspace-actions.ts` 删除不再需要的 `CanvasWorkspaceEntryTab` 与 `selectCanvasWorkspaceEntryTab`，新增：

```ts
/** 选择首次打开目标：有效默认画布优先，否则使用第一个未归档画布。 */
export function selectInitialCanvasWorkspaceSession(
  sessions: readonly CanvasSessionMeta[],
  defaultCanvasId?: string,
): CanvasSessionMeta | null {
  return sessions.find((session) => !session.archived && session.id === defaultCanvasId)
    ?? sessions.find((session) => !session.archived)
    ?? null
}

export interface OpenCanvasWorkspaceEntryInput {
  /** 当前项目的完整画布列表。 */
  sessions: readonly CanvasSessionMeta[]
  /** 当前 Agent 的默认画布 ID。 */
  defaultCanvasId?: string
  /** 打开并按需关联已有画布。 */
  openCanvas: (session: CanvasSessionMeta) => Promise<boolean>
  /** 创建、关联并打开新画布。 */
  createCanvas: () => Promise<boolean>
}

export interface CanvasWorkspaceEntryController {
  /** 执行或复用当前在途的首次打开动作。 */
  open: (input: OpenCanvasWorkspaceEntryInput) => Promise<boolean>
}

/** 创建按入口实例隔离的单飞控制器，避免重复点击创建多个画布。 */
export function createCanvasWorkspaceEntryController(): CanvasWorkspaceEntryController {
  let inFlight: Promise<boolean> | null = null
  return {
    open: (input) => {
      if (inFlight) return inFlight
      const target = selectInitialCanvasWorkspaceSession(input.sessions, input.defaultCanvasId)
      const task = target ? input.openCanvas(target) : input.createCanvas()
      inFlight = task
      const clear = (): void => {
        if (inFlight === task) inFlight = null
      }
      void task.then(clear, clear)
      return task
    },
  }
}
```

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `bun test apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`

Expected: PASS，首次选择与并发创建用例均通过。

- [ ] **Step 5: 提交决策层改动**

```bash
git add apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/components/agent/canvas-workspace-actions.ts
git commit -m "测试：锁定画布首次打开决策"
```

### Task 2: 接入顶部“打开画布”入口

**Files:**
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.tsx`

- [ ] **Step 1: 写入 SidePanel 集成失败测试**

更新现有源码合同测试：

```ts
expect(source).toContain('createCanvasWorkspaceEntryController')
expect(source).toContain('handleOpenInitialCanvas')
expect(source).toContain('canvasRegistry.metadataReady')
expect(source).toContain('openCanvas: (canvas) => handleOpenCanvas(canvas, pane)')
expect(source).toContain('createCanvas: () => handleCreateCanvas(pane)')
expect(source).not.toContain('selectCanvasWorkspaceEntryTab')
expect(source).toContain('openCanvasDisabled={!currentWorkspaceId || !canvasRegistry.metadataReady || !canvasRegistry.bindingReady}')
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `bun test apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`

Expected: FAIL，现有入口仍直接选择标签且未等待 metadata。

- [ ] **Step 3: 实现 SidePanel 入口编排**

在 `SidePanel.tsx` 导入并按 `sessionId + currentWorkspaceId` 创建入口控制器，然后新增：

```ts
/** 从顶部入口打开默认/首个画布；空项目复用现有创建流程。 */
const handleOpenInitialCanvas = React.useCallback(async (
  pane: RightWorkspacePane | null,
): Promise<boolean> => {
  if (!canvasRegistry.metadataReady || !canvasRegistry.bindingReady) return false
  return canvasWorkspaceEntryController.open({
    sessions: canvasRegistry.sessions,
    defaultCanvasId: canvasRegistry.binding?.defaultCanvasId,
    openCanvas: (canvas) => handleOpenCanvas(canvas, pane),
    createCanvas: () => handleCreateCanvas(pane),
  })
}, [canvasRegistry, canvasWorkspaceEntryController, handleCreateCanvas, handleOpenCanvas])
```

顶部入口改为 `onOpenCanvas={() => void handleOpenInitialCanvas(split?.focusedPane ?? null)}`，禁用条件加入 `!canvasRegistry.metadataReady`。

- [ ] **Step 4: 运行定向测试并确认 GREEN**

Run: `bun test apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx`

Expected: PASS，且空 launcher 的保底组件测试保持通过。

- [ ] **Step 5: 提交入口集成**

```bash
git add apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/components/agent/SidePanel.tsx
git commit -m "修复：画布首次打开自动选择或新建"
```

### Task 3: 全量验证与客户端冒烟

**Files:**
- Modify: `MEMORY.md`（主工作区，仅记录决策，不纳入功能提交）

- [ ] **Step 1: 运行定向回归测试**

Run: `bun test apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx apps/electron/src/renderer/hooks/global-agent-canvas-activity.test.ts`

Expected: 0 fail。

- [ ] **Step 2: 运行全仓类型检查与差异检查**

```bash
bun run typecheck
git diff --check origin/codex/canvas-workspace-sidebar-pr...HEAD
```

Expected: 所有 workspace typecheck 退出码为 0，差异检查无输出。

- [ ] **Step 3: 重启开发客户端并验证用户路径**

使用 `bun run dev` 启动客户端，验证初始不显示 Canvas 标签；点击后按默认、首个未归档、自动新建依次回退，并且不显示空 launcher。

- [ ] **Step 4: 记录项目记忆**

在主工作区 `MEMORY.md` 追加：Canvas 顶部入口仅在 metadata 与 binding 就绪后可用；显式打开时按默认、首个未归档、自动新建依次回退，并以单飞控制避免重复创建。

- [ ] **Step 5: 推送并核对远端**

```bash
git push origin codex/canvas-workspace-sidebar-pr
git ls-remote origin refs/heads/codex/canvas-workspace-sidebar-pr
git rev-parse HEAD
```

Expected: 远端 SHA 与本地 HEAD 完全一致。
