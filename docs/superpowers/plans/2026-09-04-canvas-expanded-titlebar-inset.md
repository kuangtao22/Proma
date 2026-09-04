# Canvas Expanded Titlebar Inset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Canvas 展开态的整条导航栏移动到 macOS 与 Windows 系统标题栏下方，同时保留窗口拖拽、Windows 控制按钮和已有全屏遮挡修复。

**Architecture:** 在 `window-titlebar-layout.ts` 增加纯平台布局函数，由 `CanvasWorkspaceAdapter` 计算展开态顶部安全高度、渲染拖拽条并通过父容器 padding 收缩 Canvas 内容区。AppShell 右栏展开层级从 `200` 调整为 `90`，保持高于栏位分隔线 `61`、低于 Windows `WindowControls` 的 `100`。

**Tech Stack:** Bun、TypeScript、React、Jotai、Tailwind CSS、Electron、bun:test

---

### Task 1: 锁定跨平台标题栏布局合同

**Files:**
- Modify: `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx`
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`
- Modify: `apps/electron/src/renderer/lib/window-titlebar-layout.ts`

- [x] **Step 1: 写失败的纯函数与展开态 DOM 测试**

```tsx
expect(getCanvasExpandedTitlebarHeight(true, true, false)).toBe(40)
expect(getCanvasExpandedTitlebarHeight(true, false, true)).toBe(32)
expect(getCanvasExpandedTitlebarHeight(true, false, false)).toBe(0)
expect(getCanvasExpandedTitlebarHeight(false, true, false)).toBe(0)
expect(collapsed).not.toContain('data-canvas-expanded-titlebar-spacer')
expect(expanded).toContain('data-canvas-expanded-titlebar-spacer')
```

- [x] **Step 2: 写失败的层叠合同测试**

```tsx
expect(globalStyles).toMatch(
  /\.agent-right-panel-host:has\(\[data-canvas-workspace-expanded="true"\]\)[\s\S]*?z-index: 90;/,
)
expect(windowControlsSource).toContain('z-[100]')
```

- [x] **Step 3: 运行测试并确认 RED**

Run:

```bash
bun test apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx
```

Expected: FAIL，因为纯函数、安全区标记和 `z-index: 90` 尚不存在。

- [x] **Step 4: 实现最小平台布局函数**

```ts
export const MAC_WINDOW_TITLEBAR_HEIGHT_PX = 40

/** 返回 Canvas 展开态需要避让的系统标题栏高度。 */
export function getCanvasExpandedTitlebarHeight(
  expanded: boolean,
  isMac: boolean,
  isWindows: boolean,
): number {
  if (!expanded) return 0
  if (isWindows) return WINDOW_TITLEBAR_HEIGHT_PX
  if (isMac) return MAC_WINDOW_TITLEBAR_HEIGHT_PX
  return 0
}
```

纯函数与 DOM 合同位于同一测试文件，因此不在 DOM 实现前声称整文件 GREEN；统一在 Task 2 完成后验证。

### Task 2: 下移 Canvas 导航并修正 Windows 层级

**Files:**
- Modify: `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.tsx`
- Modify: `apps/electron/src/renderer/styles/globals.css`
- Test: `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx`
- Test: `apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`

- [x] **Step 1: 在 Adapter 计算平台安全高度**

```tsx
/** 当前平台在 Canvas 展开态需要保留的系统标题栏高度。 */
const expandedTitlebarHeight = getCanvasExpandedTitlebarHeight(
  isExpanded,
  detectIsMac(),
  detectIsWindows(),
)
```

- [x] **Step 2: 使用 padding 收缩内容并渲染拖拽安全区**

```tsx
<div
  data-canvas-workspace-expanded={isExpanded}
  style={{ paddingTop: expandedTitlebarHeight }}
>
  {isExpanded ? (
    <div
      data-canvas-expanded-titlebar-spacer
      aria-hidden="true"
      className="titlebar-drag-region absolute inset-x-0 top-0"
      style={{ height: expandedTitlebarHeight }}
    />
  ) : null}
  {workspace}
</div>
```

- [x] **Step 3: 将 AppShell 展开宿主层级固定到窗口控制按钮之下**

```css
.agent-right-panel-host:has([data-canvas-workspace-expanded="true"]) {
  z-index: 90;
}
```

- [x] **Step 4: 运行定向测试确认 GREEN**

Run:

```bash
bun test apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx
```

Expected: 相关测试全部通过，失败数为 0。

### Task 3: 构建与真实客户端验收

**Files:**
- Modify: `MEMORY.md`

- [x] **Step 1: 运行静态与构建验证**

```bash
bun run typecheck
bun run electron:build
git diff --check
```

Expected: 三条命令均以退出码 0 完成。

- [x] **Step 2: 在 macOS 开发客户端验证展开与还原**

验收项：红黄绿按钮不遮挡导航；导航整体位于 `40px` 安全区下方；顶部空白可拖动窗口；AppShell 分隔线不穿透；还原后普通 Pane 不留额外顶部空白。

- [x] **Step 3: 复核 Windows 合同**

验收项：`32px` 安全区来自统一常量；右栏宿主 `90` 低于 `WindowControls` 的 `100`；最小化、最大化、关闭按钮仍可见可点击；Linux/未知平台高度为 0。

- [x] **Step 4: 更新项目记忆**

在 `MEMORY.md` 记录 Canvas 展开态标题栏安全区、层叠顺序、用户影响和常数级性能开销，不复制可从代码直接读取的实现细节。

- [x] **Step 5: 最终检查**

```bash
git status --short
git diff --check
```

Expected: 仅出现本次实现文件、上一轮已知未提交 Canvas 修复，以及用户已有 `.omx/`、`.superpowers/`；无空白错误。
