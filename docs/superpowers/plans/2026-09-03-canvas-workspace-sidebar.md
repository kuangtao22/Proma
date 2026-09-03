# Canvas 工作区画布抽屉 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将项目画布管理从顶部加号菜单迁移到默认收起的 Canvas Pane 内左侧抽屉，并提供标题原地重命名与当前画布删除入口。

**Architecture:** `SidePanel` 保持 Canvas registry、Toast、删除确认和业务动作的唯一所有者；新增 `CanvasWorkspaceSidebar` 负责 Pane 内抽屉与列表交互，`CanvasWorkspaceAdapter` 组合标题编辑、删除和展开状态。`NativeCanvasWorkspace` 只增加标题栏插槽以保留现有回收区按钮，不新增数据源或 IPC。

**Tech Stack:** Bun、TypeScript、React、Jotai、Tailwind CSS、Radix DropdownMenu/Collapsible/Tooltip、Lucide React、`bun:test`

---

## 文件结构

- Create: `apps/electron/src/renderer/components/design/CanvasWorkspaceSidebar.tsx`：Pane 内覆盖式抽屉、画布分组和行级操作。
- Create: `apps/electron/src/renderer/components/design/CanvasWorkspaceSidebar.test.tsx`：抽屉分组、能力和异步收口测试。
- Modify: `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.tsx`：组合抽屉、标题编辑、删除和展开按钮。
- Modify: `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx`：标题编辑、legacy 禁删和 `Esc` 优先级测试。
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`：为现有标题栏增加受控插槽。
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`：标题栏插槽与回收区共存测试。
- Modify: `apps/electron/src/renderer/components/agent/canvas-workspace-actions.ts`：增加归档当前画布后的回退选择器。
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`：归档回退和动作结果测试。
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.tsx`：将权威列表与既有动作传入每个 Canvas Pane。
- Modify: `apps/electron/src/renderer/components/diff/DiffPanelTabBar.tsx`：删除重复画布菜单及其局部状态。
- Modify: `apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx`：验证顶部菜单不再承担画布管理。
- Modify: `MEMORY.md`：记录入口归属、Pane 作用域和状态所有权。

### Task 1: 锁定抽屉视图模型和异步动作合同

**Files:**
- Create: `apps/electron/src/renderer/components/design/CanvasWorkspaceSidebar.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasWorkspaceSidebar.test.tsx`

- [ ] **Step 1: 写画布分组和删除能力的失败测试**

```tsx
test('Given 活动画布、归档画布和 legacy When 组装抽屉列表 Then 分组稳定且 legacy 不可永久删除', () => {
  const active = createSession('canvas-active', false)
  const legacy = createSession(LEGACY_DESIGN_CANVAS_ID, false)
  const archived = createSession('canvas-archived', true)

  expect(groupCanvasWorkspaceSessions([active, legacy, archived])).toEqual({
    active: [active, legacy],
    archived: [archived],
  })
  expect(canDeleteCanvasFromWorkspaceSidebar(legacy)).toBe(false)
  expect(canDeleteCanvasFromWorkspaceSidebar(active)).toBe(true)
})
```

- [ ] **Step 2: 运行测试并确认新模块尚不存在**

Run: `bun test apps/electron/src/renderer/components/design/CanvasWorkspaceSidebar.test.tsx`

Expected: FAIL，无法解析 `./CanvasWorkspaceSidebar`。

- [ ] **Step 3: 实现纯函数、props 和 pending 类型**

```tsx
export type CanvasSidebarPendingAction =
  | 'create:new'
  | `${'open' | 'default' | 'archive' | 'restore'}:${string}`

export interface CanvasWorkspaceSidebarProps {
  open: boolean
  currentCanvasId: string
  sessions: readonly CanvasSessionMeta[]
  defaultCanvasId?: string
  activityStates: ReadonlyMap<string, AgentCanvasActivityState>
  onOpenChange: (open: boolean) => void
  onCreateCanvas: () => Promise<boolean>
  onOpenCanvas: (session: CanvasSessionMeta) => Promise<boolean>
  onSetDefaultCanvas: (session: CanvasSessionMeta) => Promise<boolean>
  onToggleArchiveCanvas: (session: CanvasSessionMeta) => Promise<boolean>
  onRequestDeleteCanvas: (session: CanvasSessionMeta) => void
}

export interface RunCanvasSidebarNavigationActionOptions {
  pendingAction: CanvasSidebarPendingAction
  action: () => Promise<boolean>
  onPendingChange: (pending: CanvasSidebarPendingAction | null) => void
  onOpenChange: (open: boolean) => void
}

/** 按公开归档事实分组，保留 registry 原始顺序。 */
export function groupCanvasWorkspaceSessions(sessions: readonly CanvasSessionMeta[]): {
  active: CanvasSessionMeta[]
  archived: CanvasSessionMeta[]
} {
  return sessions.reduce((groups, session) => {
    groups[session.archived ? 'archived' : 'active'].push(session)
    return groups
  }, { active: [], archived: [] } as { active: CanvasSessionMeta[]; archived: CanvasSessionMeta[] })
}

/** legacy Design 只允许归档，不进入永久删除流程。 */
export function canDeleteCanvasFromWorkspaceSidebar(session: CanvasSessionMeta): boolean {
  return session.id !== LEGACY_DESIGN_CANVAS_ID
}
```

- [ ] **Step 4: 写导航成功关闭、失败保留和 pending 释放测试**

```tsx
test('Given 抽屉导航动作 When 成功或失败 Then 仅成功关闭且 pending 必定释放', async () => {
  const pending: Array<CanvasSidebarPendingAction | null> = []
  const openStates: boolean[] = []
  const onPendingChange = (value: CanvasSidebarPendingAction | null): void => { pending.push(value) }
  const onOpenChange = (value: boolean): void => { openStates.push(value) }

  expect(await runCanvasSidebarNavigationAction({
    pendingAction: 'open:canvas-1', action: async () => true, onPendingChange, onOpenChange,
  })).toBe(true)
  expect(pending).toEqual(['open:canvas-1', null])
  expect(openStates).toEqual([false])

  expect(await runCanvasSidebarNavigationAction({
    pendingAction: 'open:canvas-2', action: async () => false, onPendingChange, onOpenChange,
  })).toBe(false)
  expect(pending.at(-1)).toBeNull()
  expect(openStates).toEqual([false])
})
```

- [ ] **Step 5: 实现动作 helper 和 Pane 内覆盖结构**

```tsx
export async function runCanvasSidebarNavigationAction(
  options: RunCanvasSidebarNavigationActionOptions,
): Promise<boolean> {
  options.onPendingChange(options.pendingAction)
  try {
    const succeeded = await options.action()
    if (succeeded) options.onOpenChange(false)
    return succeeded
  } finally {
    options.onPendingChange(null)
  }
}
```

组件关闭时返回 `null`；打开时渲染 `absolute inset-0 z-30` 的 Pane 局部层。第一层是带 `aria-label="关闭画布列表"` 的透明按钮遮罩，第二层是 `role="dialog"`、`aria-modal="false"`、`w-60 max-w-[80%]` 的左侧 `aside`。`aside` 内按顺序直接渲染标题和关闭按钮、新建按钮、未归档 `ScrollArea`、默认关闭的 `Collapsible` 归档组。列表行使用现有 `DropdownMenu`；当前项使用选中背景，默认项显示 `Star`，`isAgentCanvasActivityUnread` 为真时显示 `aria-label="有新版本"` 的圆点。点击当前画布只关闭抽屉，不调用 `onOpenCanvas`。

- [ ] **Step 6: 运行抽屉测试并提交**

Run: `bun test apps/electron/src/renderer/components/design/CanvasWorkspaceSidebar.test.tsx`

Expected: PASS。

```bash
git add apps/electron/src/renderer/components/design/CanvasWorkspaceSidebar.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceSidebar.test.tsx
git commit -m "功能：新增画布工作区管理抽屉"
```

### Task 2: 将标题编辑和当前操作接入标题栏

**Files:**
- Modify: `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写标题栏插槽和 legacy 禁删失败测试**

在 `NativeCanvasWorkspace.test.tsx` 验证 `headerLeading`、`headerTitle`、`headerActions` 与“打开回收区”同时渲染。在 Adapter 测试中验证：

```tsx
expect(nativeHtml).toContain('aria-label="打开画布列表"')
expect(nativeHtml).toContain('aria-label="删除当前画布"')
expect(nativeHtml).toContain('aria-label="展开画布"')
expect(legacyHtml).toContain('aria-label="打开画布列表"')
expect(legacyHtml).not.toContain('aria-label="删除当前画布"')
```

- [ ] **Step 2: 运行测试并确认缺少标题栏合同**

Run: `bun test apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: FAIL，缺少新按钮或 header slot。

- [ ] **Step 3: 为原生 Canvas 标题栏增加三个可选插槽**

向 `NativeCanvasWorkspaceProps` 添加：

```tsx
/** 标题前的 Pane 局部导航入口。 */
headerLeading?: React.ReactNode
/** 替换默认标题的可编辑标题内容。 */
headerTitle?: React.ReactNode
/** 位于回收区按钮之前的 Pane 局部动作。 */
headerActions?: React.ReactNode
```

现有 header 改为：

```tsx
<header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
  {headerLeading}
  {headerTitle ?? <h1 className="min-w-0 truncate px-2 text-sm font-medium text-foreground">{title}</h1>}
  <div className="ml-auto flex shrink-0 items-center gap-1">
    {headerActions}
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label="打开回收区"
      disabled={!adapter.listCanvasTrash || !adapter.restoreCanvasNode}
      onClick={() => {
        setTrashOpen(true)
        void trashControllerRef.current?.load()
      }}
    >
      <ArchiveRestore aria-hidden="true" />
    </Button>
  </div>
</header>
```

- [ ] **Step 4: 写标题保存、取消、失败保留和 `Esc` 优先级测试**

```tsx
test('Given 当前标题 When 提交变化、空白、原值或失败 Then 返回明确编辑决策', async () => {
  const submitted: string[] = []
  const rename = async (title: string): Promise<boolean> => {
    submitted.push(title)
    return title !== '失败标题'
  }

  expect(await submitCanvasWorkspaceTitle({ originalTitle: '旧标题', draftTitle: ' 新标题 ', rename }))
    .toEqual({ status: 'saved', title: '新标题' })
  expect(await submitCanvasWorkspaceTitle({ originalTitle: '旧标题', draftTitle: '   ', rename }))
    .toEqual({ status: 'reset', title: '旧标题' })
  expect(await submitCanvasWorkspaceTitle({ originalTitle: '旧标题', draftTitle: '旧标题', rename }))
    .toEqual({ status: 'unchanged', title: '旧标题' })
  expect(await submitCanvasWorkspaceTitle({ originalTitle: '旧标题', draftTitle: '失败标题', rename }))
    .toEqual({ status: 'failed', title: '失败标题' })
  expect(submitted).toEqual(['新标题', '失败标题'])
})

test('Given 多层状态 When 解析 Escape Then 标题、抽屉、全屏按顺序消费', () => {
  expect(resolveCanvasWorkspaceEscapeAction({ editingTitle: true, sidebarOpen: true, expanded: true }))
    .toBe('cancel-title')
  expect(resolveCanvasWorkspaceEscapeAction({ editingTitle: false, sidebarOpen: true, expanded: true }))
    .toBe('close-sidebar')
  expect(resolveCanvasWorkspaceEscapeAction({ editingTitle: false, sidebarOpen: false, expanded: true }))
    .toBe('exit-expanded')
  expect(resolveCanvasWorkspaceEscapeAction({ editingTitle: false, sidebarOpen: false, expanded: false }))
    .toBeNull()
})
```

- [ ] **Step 5: 在 Adapter 组合标题控件与抽屉**

扩展 `CanvasWorkspaceAdapterProps` 接收 Task 1 的 sessions、default/activity 和动作回调。新增：

```tsx
const [sidebarOpen, setSidebarOpen] = React.useState(false)
const [editingTitle, setEditingTitle] = React.useState(false)
const [titleDraft, setTitleDraft] = React.useState(session?.title ?? '')
const [renaming, setRenaming] = React.useState(false)
```

实现并导出以下状态合同：

```tsx
export type CanvasWorkspaceTitleSubmitResult = {
  status: 'reset' | 'unchanged' | 'saved' | 'failed'
  title: string
}

export interface SubmitCanvasWorkspaceTitleInput {
  originalTitle: string
  draftTitle: string
  rename: (title: string) => Promise<boolean>
}

/** 归一化标题并返回组件应采取的确定性编辑结果。 */
export async function submitCanvasWorkspaceTitle(
  input: SubmitCanvasWorkspaceTitleInput,
): Promise<CanvasWorkspaceTitleSubmitResult> {
  const title = input.draftTitle.trim()
  if (!title) return { status: 'reset', title: input.originalTitle }
  if (title === input.originalTitle) return { status: 'unchanged', title }
  return await input.rename(title)
    ? { status: 'saved', title }
    : { status: 'failed', title }
}

export type CanvasWorkspaceEscapeAction = 'cancel-title' | 'close-sidebar' | 'exit-expanded'

/** 只选择最内层的 Escape 动作，避免一次按键关闭多层状态。 */
export function resolveCanvasWorkspaceEscapeAction(input: {
  editingTitle: boolean
  sidebarOpen: boolean
  expanded: boolean
}): CanvasWorkspaceEscapeAction | null {
  if (input.editingTitle) return 'cancel-title'
  if (input.sidebarOpen) return 'close-sidebar'
  if (input.expanded) return 'exit-expanded'
  return null
}
```

组件的全局 `Escape` 监听只执行返回的单一动作。

原绝对定位展开按钮移入 `headerActions`。native 通过 header slot 注入；legacy 由 Adapter 增加同高标题栏后把 `DesignWorkspaceView` 放入剩余高度。删除按钮仅对非 legacy 显示，并调用 `onRequestDeleteCanvas(session)`。

- [ ] **Step 6: 运行测试并提交**

Run: `bun test apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: PASS。

```bash
git add apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
git commit -m "功能：支持画布标题原地编辑与当前删除"
```

### Task 3: 让 SidePanel 返回真实动作结果并处理归档回退

**Files:**
- Modify: `apps/electron/src/renderer/components/agent/canvas-workspace-actions.ts`
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.tsx`

- [ ] **Step 1: 写归档回退选择器的失败测试**

```tsx
test('Given 当前画布被归档 When 选择回退 Then 默认优先、关联顺序次之、无可用返回 null', () => {
  const sessions = [createSession('default'), createSession('recent')]
  expect(selectCanvasAfterArchive({
    archivedCanvasId: 'current', defaultCanvasId: 'default',
    linkedCanvasIds: ['current', 'recent', 'default'], sessions,
  })?.id).toBe('default')
  expect(selectCanvasAfterArchive({
    archivedCanvasId: 'current', linkedCanvasIds: ['current', 'recent'], sessions,
  })?.id).toBe('recent')
  expect(selectCanvasAfterArchive({
    archivedCanvasId: 'current', linkedCanvasIds: ['current'], sessions: [],
  })).toBeNull()
})
```

- [ ] **Step 2: 运行测试并确认函数不存在**

Run: `bun test apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`

Expected: FAIL，`selectCanvasAfterArchive` 未导出。

- [ ] **Step 3: 实现确定性回退选择器**

```tsx
export interface SelectCanvasAfterArchiveInput {
  archivedCanvasId: string
  defaultCanvasId?: string
  linkedCanvasIds: readonly string[]
  sessions: readonly CanvasSessionMeta[]
}

/** 当前画布归档后选择下一张未归档且仍存在的关联画布。 */
export function selectCanvasAfterArchive(input: SelectCanvasAfterArchiveInput): CanvasSessionMeta | null {
  const available = new Map(input.sessions
    .filter((session) => !session.archived && session.id !== input.archivedCanvasId)
    .map((session) => [session.id, session]))
  if (input.defaultCanvasId) {
    const defaultCanvas = available.get(input.defaultCanvasId)
    if (defaultCanvas) return defaultCanvas
  }
  for (const canvasId of input.linkedCanvasIds) {
    const canvas = available.get(canvasId)
    if (canvas) return canvas
  }
  return null
}
```

- [ ] **Step 4: 将 SidePanel 画布动作统一为 `Promise<boolean>`**

新建、打开、重命名、设默认和归档/恢复都保存 `runCanvasWorkspaceAction` 的结果并返回 `result !== null`。这样失败 Toast 已经显示，但抽屉能准确知道不能关闭。

归档当前画布成功后构造包含 updated session 的 `nextSessions`，再执行：

```tsx
const fallback = selectCanvasAfterArchive({
  archivedCanvasId: canvas.id,
  defaultCanvasId: canvasRegistry.binding?.defaultCanvasId,
  linkedCanvasIds: canvasRegistry.binding?.linkedCanvasIds ?? [],
  sessions: nextSessions,
})
if (fallback) await canvasRegistry.linkAndOpen(fallback.id, false)
else returnToPreviousTabAfterClose(getCanvasWorkspaceTab(canvas.id))
```

仅当 `activeCanvasId === canvas.id` 时执行回退；归档非当前项后保持抽屉打开。

- [ ] **Step 5: 将完整画布视图模型传入 Adapter**

提取稳定 `handleRequestDeleteCanvas(canvas)`，内部继续调用 `deleteLifecycleRef.current.open(sessionId, currentWorkspaceId, canvas)`。在每个 Canvas Pane 的 Adapter 上传入：

```tsx
sessions={canvasRegistry.sessions}
defaultCanvasId={canvasRegistry.binding?.defaultCanvasId}
activityStates={canvasRegistry.canvasActivityStates}
onCreateCanvas={handleCreateCanvas}
onOpenCanvas={handleOpenCanvas}
onRenameCanvas={handleRenameCanvas}
onSetDefaultCanvas={handleSetDefaultCanvas}
onToggleArchiveCanvas={handleToggleArchiveCanvas}
onRequestDeleteCanvas={handleRequestDeleteCanvas}
```

- [ ] **Step 6: 运行测试并提交**

Run: `bun test apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx`

Expected: PASS。

```bash
git add apps/electron/src/renderer/components/agent/canvas-workspace-actions.ts apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/components/agent/SidePanel.tsx
git commit -m "优化：统一画布抽屉操作与归档回退"
```

### Task 4: 移除顶部重复画布菜单

**Files:**
- Modify: `apps/electron/src/renderer/components/diff/DiffPanelTabBar.tsx`
- Modify: `apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx`
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.tsx`

- [ ] **Step 1: 写顶部菜单静态所有权失败测试**

读取相邻源文件并验证画布文案和 Canvas 专属 props 已从顶部菜单消失，同时保留普通入口文案：

```tsx
test('Given 顶部加号菜单 When 检查入口所有权 Then 不再包含画布管理', async () => {
  const source = await Bun.file(new URL('./DiffPanelTabBar.tsx', import.meta.url)).text()
  expect(source).toContain('新建浏览器标签')
  expect(source).toContain('打开文件')
  expect(source).not.toContain('新建画布')
  expect(source).not.toContain('现有画布')
  expect(source).not.toContain('canvasSessions?:')
  expect(source).not.toContain('onRenameCanvas?:')
})
```

- [ ] **Step 2: 运行测试并确认旧画布菜单仍存在**

Run: `bun test apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx`

Expected: FAIL，仍包含旧画布子菜单合同。

- [ ] **Step 3: 删除 DiffPanelTabBar 的 Canvas 专属职责**

从 props、参数和 JSX 删除 `canvasSessions`、`onOpenCanvas`、`onCreateCanvas`、`defaultCanvasId`、`onRenameCanvas`、`onSetDefaultCanvas`、`onToggleArchiveCanvas`、`onRequestDeleteCanvas`。同时删除只服务旧菜单的 Canvas import、重命名 state/ref、pending state、`submitCanvasRename`、`CanvasMenuPendingAction`、`runCanvasMenuAction` 和 `canDeleteCanvasFromWorkspaceMenu`。保留加号菜单其它入口及 `onCloseAutoFocus` 行为。

- [ ] **Step 4: 删除 SidePanel 对顶部菜单的旧 props 传递**

`DiffPanelTabBar` 不再接收 Canvas 数据与动作；同一批处理器只传给 `CanvasWorkspaceAdapter`。删除确认对话框仍由 `SidePanel` 渲染。

- [ ] **Step 5: 运行测试并提交**

Run: `bun test apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`

Expected: PASS。

```bash
git add apps/electron/src/renderer/components/diff/DiffPanelTabBar.tsx apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx apps/electron/src/renderer/components/agent/SidePanel.tsx
git commit -m "优化：迁移画布管理入口到工作区抽屉"
```

### Task 5: 验证、客户端 QA 与记忆更新

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: 运行完整相关测试集**

```bash
bun test apps/electron/src/renderer/components/design/CanvasWorkspaceSidebar.test.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx
```

Expected: 全部 PASS，无未处理 Promise rejection。

- [ ] **Step 2: 运行类型检查**

Run: `bun run typecheck`

Expected: exit code 0。

- [ ] **Step 3: 启动或复用 Electron 开发客户端**

先用 `ps -axo pid,command` 检查已有 `bun run dev`、Vite 和 Electron 进程；没有时运行 `bun run dev`。Expected: Renderer 与 Electron 启动且无启动期错误。

- [ ] **Step 4: 执行客户端视觉与交互检查**

验证普通宽度、窄 Pane、分屏、全屏、light/dark；检查抽屉默认关闭且不改画布宽度、最大宽度 80%、分屏不越界、`Esc` 优先级、长标题、成功/失败关闭规则、标题编辑、共用删除确认和顶部菜单去重。

- [ ] **Step 5: 修复视觉阻断并重跑最小验证**

只处理本功能引入的重叠、焦点、作用域或状态错误。每个行为修复先补失败测试，再运行对应测试和 `bun run typecheck`。

- [ ] **Step 6: 更新项目记忆**

在 `MEMORY.md` 记录：项目画布管理归属 Canvas Pane 内默认收起抽屉；顶部加号不再维护画布列表；`SidePanel` 仍是 registry、Toast 和删除确认唯一所有者；抽屉按 Pane 覆盖且不新增 IPC 或持久化状态。

- [ ] **Step 7: 检查最终差异**

```bash
git status --short
git diff --check
git diff -- apps/electron/src/renderer/components/design apps/electron/src/renderer/components/agent/SidePanel.tsx apps/electron/src/renderer/components/agent/canvas-workspace-actions.ts apps/electron/src/renderer/components/diff/DiffPanelTabBar.tsx apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx
```

Expected: 无空白错误；不覆盖或回退用户已有无关修改。

- [ ] **Step 8: 提交最终验证相关修改**

只暂存本任务文件；`MEMORY.md` 若包含前序未提交内容则逐块核对，不把无关内容混入提交。

```bash
git commit -m "测试：补全画布抽屉交互回归验证"
```
