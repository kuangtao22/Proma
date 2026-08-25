# Multi-Canvas Renderer Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在项目侧栏把 Canvas 作为独立一等会话展示，支持创建、切换、重命名和归档，并确保旧 Design 只由 `legacy-design` 会话加载。

**Architecture:** Renderer 使用独立 Jotai registry 保存各项目 Canvas 元数据和当前选择，不把 Canvas 写入 Agent 会话 atoms。项目侧栏合并渲染 Agent 与 Canvas 行；选择 `legacy-design` 时复用现有 `DesignWorkspaceView`，选择原生 Canvas 时渲染独立空工作区，禁止别名加载旧 Design 数据。

**Tech Stack:** Bun、TypeScript、React、Jotai、Radix DropdownMenu、Lucide、现有 Design Preload/Renderer adapter

---

## 文件职责

- `apps/electron/src/renderer/atoms/canvas-session-atoms.ts`：Canvas registry、选择和纯更新入口。
- `apps/electron/src/renderer/atoms/canvas-session-atoms.test.ts`：项目隔离、事件更新和归档选择清理。
- `apps/electron/src/renderer/hooks/useCanvasSessionRegistry.ts`：随项目列表加载 Canvas 索引并订阅变化事件。
- `apps/electron/src/renderer/hooks/useCanvasSessionRegistry.test.ts`：加载、错误隔离和事件刷新合同。
- `apps/electron/src/renderer/components/design/CanvasSessionItem.tsx`：紧凑 Canvas 行、重命名和归档操作。
- `apps/electron/src/renderer/components/design/CanvasSessionItem.test.tsx`：语义、图标、选中态和归档动作。
- `apps/electron/src/renderer/components/design/CanvasSessionTab.tsx`：当前 Canvas 顶部入口，替代项目级 Design 标签。
- `apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.tsx`：legacy 兼容加载与原生空状态分派。
- `apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`：项目创建菜单、Canvas 行和归档列表接入。
- `apps/electron/src/renderer/components/tabs/TabBar.tsx`、`MainArea.tsx`：由 Canvas selection 驱动顶部入口和主内容。
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`：挂载单例 registry observer，并按 Canvas selection 计算右栏。

### Task 1: 建立 Canvas Renderer registry

**Files:**
- Create: `apps/electron/src/renderer/atoms/canvas-session-atoms.ts`
- Create: `apps/electron/src/renderer/atoms/canvas-session-atoms.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖三个行为：项目 A 更新不改项目 B；选择值包含 `projectId + canvasId`；当前 Canvas 被归档后自动清除选择。

```ts
test('Given 两个项目 When 提交项目 A Canvas Then 项目 B 引用保持不变', () => {
  const store = createStore()
  const projectB = [createCanvas('b-1', 'project-b')]
  store.set(canvasSessionsByProjectAtom, new Map([['project-b', projectB]]))
  store.set(replaceCanvasSessionsAtom, { projectId: 'project-a', sessions: [createCanvas('a-1', 'project-a')] })
  expect(store.get(canvasSessionsByProjectAtom).get('project-b')).toBe(projectB)
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/atoms/canvas-session-atoms.test.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现最小 atoms**

```ts
export interface ActiveCanvasSelection {
  projectId: string
  canvasId: string
}

export const canvasSessionsByProjectAtom = atom<Map<string, CanvasSessionMeta[]>>(new Map())
export const activeCanvasSelectionAtom = atom<ActiveCanvasSelection | null>(null)
export const replaceCanvasSessionsAtom = atom(null, (get, set, input: ReplaceCanvasSessionsInput) => {
  const next = new Map(get(canvasSessionsByProjectAtom))
  next.set(input.projectId, [...input.sessions])
  set(canvasSessionsByProjectAtom, next)
  const selected = get(activeCanvasSelectionAtom)
  if (selected?.projectId === input.projectId
    && !input.sessions.some((session) => session.id === selected.canvasId && !session.archived)) {
    set(activeCanvasSelectionAtom, null)
  }
})
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/atoms/canvas-session-atoms.test.ts`

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/renderer/atoms/canvas-session-atoms.ts apps/electron/src/renderer/atoms/canvas-session-atoms.test.ts
git commit -m "设计：增加 Canvas 渲染状态"
```

### Task 2: 加载并同步各项目 Canvas 索引

**Files:**
- Create: `apps/electron/src/renderer/hooks/useCanvasSessionRegistry.ts`
- Create: `apps/electron/src/renderer/hooks/useCanvasSessionRegistry.test.ts`
- Modify: `apps/electron/src/renderer/components/app-shell/AppShell.tsx`

- [ ] **Step 1: 写失败测试**

使用纯 controller 工厂验证：项目列表变化时每项目只读取一次 active/archived 全量列表；单项目失败不阻断其他项目；变化事件只刷新对应项目。

```ts
const controller = createCanvasSessionRegistryController({
  listCanvasSessions: async ({ projectId }) => sessionsByProject.get(projectId) ?? [],
  commit: (projectId, sessions) => commits.push({ projectId, sessions }),
})
await controller.syncProjects(['project-a', 'project-b'])
expect(commits.map((item) => item.projectId)).toEqual(['project-a', 'project-b'])
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/hooks/useCanvasSessionRegistry.test.ts`

- [ ] **Step 3: 实现 controller 与 hook**

Controller 只通过 `designAdapter.listCanvasSessions({ projectId })` 读取元数据；hook 在 `AppShell` 挂载一次，订阅 `onCanvasSessionChanged` 并清理监听器。错误按项目记录中文日志，不清空已缓存列表。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/hooks/useCanvasSessionRegistry.test.ts`

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/renderer/hooks/useCanvasSessionRegistry.ts apps/electron/src/renderer/hooks/useCanvasSessionRegistry.test.ts apps/electron/src/renderer/components/app-shell/AppShell.tsx
git commit -m "设计：同步项目 Canvas 会话"
```

### Task 3: 增加 Canvas 会话行与项目创建菜单

**Files:**
- Create: `apps/electron/src/renderer/components/design/CanvasSessionItem.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasSessionItem.test.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`

- [ ] **Step 1: 写失败测试**

静态渲染覆盖 `Workflow` 图标、当前项语义、中文标题和菜单；交互测试覆盖重命名与归档调用使用精确 `projectId + canvasId`。

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/components/design/CanvasSessionItem.test.tsx`

- [ ] **Step 3: 实现 CanvasSessionItem**

行高、字号、圆角和 hover/selected 复用现有 Agent 会话行；菜单只提供“重命名”和“归档/取消归档”。所有可见文案为中文，图标按钮带 `aria-label` 和 Tooltip。

- [ ] **Step 4: 接入 LeftSidebar**

项目 `+` 改为菜单：`新建 Agent 会话`、`新建 Canvas`。创建 Canvas 后展开项目、更新 registry、设置当前项目并激活 Canvas；项目展开区在 Agent 会话之后渲染 Canvas 行。归档视图展示已归档 Canvas，并允许取消归档。

- [ ] **Step 5: 运行定向测试**

Run: `bun test apps/electron/src/renderer/components/design/CanvasSessionItem.test.tsx apps/electron/src/renderer/atoms/canvas-session-atoms.test.ts`

- [ ] **Step 6: 提交**

```bash
git add apps/electron/src/renderer/components/design/CanvasSessionItem.tsx apps/electron/src/renderer/components/design/CanvasSessionItem.test.tsx apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx
git commit -m "设计：在项目侧栏展示 Canvas 会话"
```

### Task 4: 用 Canvas selection 驱动顶部入口与兼容工作区

**Files:**
- Create: `apps/electron/src/renderer/components/design/CanvasSessionTab.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasSessionTab.test.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.test.tsx`
- Modify: `apps/electron/src/renderer/components/tabs/TabBar.tsx`
- Modify: `apps/electron/src/renderer/components/tabs/MainArea.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/design-layout.ts`
- Modify: `apps/electron/src/renderer/components/app-shell/design-layout.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖：没有 selection 时不显示 Canvas 顶部入口；`legacy-design` 渲染 `DesignWorkspaceView`；原生 Canvas 只渲染独立空状态且源码不调用 `loadDesignWorkspace`；Canvas 视图右栏仅对 legacy 显示。

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/components/design/CanvasSessionTab.test.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.test.tsx apps/electron/src/renderer/components/app-shell/design-layout.test.ts`

- [ ] **Step 3: 实现顶部入口和分派视图**

`CanvasSessionTab` 显示 Canvas 标题与 `Workflow` 图标。`CanvasWorkspaceEntry` 只在 `canvasId === 'legacy-design'` 时挂载现有 Design；原生 Canvas 保持轻量空状态，不创建 Design controller、对象 URL 或图片订阅。

- [ ] **Step 4: 更新 TabBar/MainArea/右栏规则**

`TabBar` 从 registry 查找当前 Canvas；普通 tab 激活时清除 Canvas selection。`MainArea` 的 design 分支改为 `CanvasWorkspaceEntry`。`getRightPanelMode` 增加 `canvasId`，仅 legacy Canvas 返回 `design`。

- [ ] **Step 5: 运行定向测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/components/design/CanvasSessionTab.test.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.test.tsx apps/electron/src/renderer/components/app-shell/design-layout.test.ts apps/electron/src/renderer/components/design/DesignWorkspaceView.test.tsx`

- [ ] **Step 6: 提交**

```bash
git add apps/electron/src/renderer/components/design/CanvasSessionTab.tsx apps/electron/src/renderer/components/design/CanvasSessionTab.test.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.test.tsx apps/electron/src/renderer/components/tabs/TabBar.tsx apps/electron/src/renderer/components/tabs/MainArea.tsx apps/electron/src/renderer/components/app-shell/design-layout.ts apps/electron/src/renderer/components/app-shell/design-layout.test.ts
git commit -m "设计：按 Canvas 会话切换工作区"
```

### Task 5: 回归、视觉验收与记忆收口

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: 运行 Canvas 与现有 Design 回归**

Run: `bun test apps/electron/src/renderer/atoms/canvas-session-atoms.test.ts apps/electron/src/renderer/hooks/useCanvasSessionRegistry.test.ts apps/electron/src/renderer/components/design/CanvasSessionItem.test.tsx apps/electron/src/renderer/components/design/CanvasSessionTab.test.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.test.tsx apps/electron/src/renderer/components/design/DesignWorkspaceView.test.tsx apps/electron/src/renderer/components/app-shell/design-layout.test.ts`

- [ ] **Step 2: 运行类型检查和 Electron 构建**

Run: `bun run typecheck`

Run: `bun run electron:build`

- [ ] **Step 3: 启动开发版并做浏览器视觉检查**

验证宽/窄侧栏、active/archived、创建菜单、重命名、深浅主题、键盘焦点和原生 Canvas 空状态；确认 Canvas 切换不会挂载多个 Design 工作区。

- [ ] **Step 4: 更新 MEMORY 并提交**

记录：Renderer Canvas registry 独立于 Agent atoms；`legacy-design` 是唯一兼容旧 Design 的会话；原生 Canvas 在数据迁移前不会别名读取旧画布。

```bash
git add MEMORY.md
git commit -m "文档：记录多 Canvas 渲染边界"
```

## 停止条件

- 项目侧栏可创建、选择、重命名、归档和取消归档 Canvas；
- Canvas 不进入 Agent 会话列表、搜索、Automation、LAN/mobile；
- `legacy-design` 正常打开现有 Design；
- 原生 Canvas 不读取或修改旧 `.proma/design/canvas.json`；
- 未打开 Canvas 只保留轻量元数据，不挂载 Design controller；
- 定向回归、全仓类型检查和 Electron 构建通过。
