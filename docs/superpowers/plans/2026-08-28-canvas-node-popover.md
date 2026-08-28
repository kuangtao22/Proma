# Canvas 节点添加悬浮菜单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Canvas 顶部节点类型选择从居中模态弹窗改成紧贴“添加节点”按钮下方的小型悬浮菜单。

**Architecture:** 复用 renderer 已有 Radix `Popover`，并通过原生 `PopoverClose` 在选择后关闭。节点类型合同和 `onAddNode(kind)` 保持不变，不引入额外工具栏状态。

**Tech Stack:** React、TypeScript、Radix Popover、Tailwind CSS、Bun Test

---

### Task 1: 用测试锁定悬浮菜单合同

**Files:**
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx`

- [ ] **Step 1: 把 Dialog 合同改成 Popover 合同**

保留五种节点类型、视频禁用、精确回调和按钮禁用测试，将选择器断言改成：

```tsx
test('Given 添加节点入口 When 渲染工具栏 Then 提供按钮下方的紧凑悬浮菜单', () => {
  const elementTree = NativeCanvasToolbar(createToolbarProps())

  expect(hasElementProperty(elementTree, 'data-canvas-node-picker', 'popover')).toBeTrue()
  expect(hasElementProperty(elementTree, 'data-canvas-node-picker-width', 'compact')).toBeTrue()
  expect(hasElementProperty(elementTree, 'side', 'bottom')).toBeTrue()
  expect(hasElementProperty(elementTree, 'align', 'center')).toBeTrue()
})
```

- [ ] **Step 2: 运行定向测试并确认 RED**

```bash
bun test apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx
```

Expected: FAIL，原因是当前组件仍公开居中 `Dialog` 合同。

### Task 2: 用 Popover 实现紧凑节点类型菜单

**Files:**
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasToolbar.tsx`
- Modify: `apps/electron/src/renderer/components/ui/popover.tsx`

- [ ] **Step 1: 替换 Dialog 导入并公开 PopoverClose**

```tsx
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
```

- [ ] **Step 2: 让可用类型选择后创建节点并关闭菜单**

保持现有选择处理器，并用 `PopoverClose` 包裹可用选项：

```tsx
const onSelect = createNativeCanvasNodeTypeSelectHandler(option, onAddNode)

if (!option.enabled) return optionButton
return (
  <PopoverClose asChild data-canvas-node-picker-close="selection">
    {optionButton}
  </PopoverClose>
)
```

菜单项使用紧凑的无边框按钮：

```tsx
<Button
  type="button"
  variant="ghost"
  className="h-9 w-full justify-start gap-2 px-2"
  disabled={!option.enabled}
  aria-disabled={!option.enabled}
  aria-label={option.enabled ? `添加${option.label}节点` : `${option.label}，即将支持`}
  onClick={onSelect}
>
```

- [ ] **Step 3: 将顶部添加入口改为按钮下方 Popover**

```tsx
<Popover>
  <PopoverTrigger asChild>{addButton}</PopoverTrigger>
  <PopoverContent
    side="bottom"
    align="center"
    sideOffset={6}
    className="w-48 max-w-[calc(100vw-1rem)] p-1"
    data-canvas-node-picker="popover"
    data-canvas-node-picker-width="compact"
    onPointerDown={(event) => event.stopPropagation()}
  >
    {NATIVE_CANVAS_NODE_TYPE_OPTIONS.map((option) => (
      <NativeCanvasNodeTypePickerOption
        key={option.kind}
        option={option}
        onAddNode={onAddNode}
      />
    ))}
  </PopoverContent>
</Popover>
```

其中 `addButton` 仍使用当前 `Button`，保留 `aria-label="添加节点"` 和 `disabled={!writable || !canAdd}`。

- [ ] **Step 4: 运行定向测试并确认 GREEN**

```bash
bun test apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx
```

Expected: PASS，且无 warning 或 error。

### Task 3: 验证关联业务与真实客户端交互

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: 运行 Canvas 相关回归测试**

```bash
bun test apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/NativeCanvas.test.tsx apps/electron/src/renderer/components/design/NativeCanvasNode.test.tsx
```

Expected: 全部 PASS，证明工具栏改动没有破坏节点追加、画布视口和节点渲染。

- [ ] **Step 2: 运行类型检查和差异检查**

```bash
bun run typecheck
git diff --check
```

Expected: 两条命令均以退出码 0 完成。

- [ ] **Step 3: 在真实 Electron 客户端验证**

使用客户端鼠标验证：菜单显示在 `+` 下方；点击外部、再次点击 `+` 和 `Escape` 能关闭；四个可用类型能创建并保持视口不跳动；视频不可创建；窄窗口不溢出。

- [ ] **Step 4: 记录长期决策**

在 `MEMORY.md` 追加：

```markdown
- Canvas 顶部添加入口使用锚定按钮下方的 Radix Popover 单列菜单；选择可用类型后关闭并沿用工作区可视区追加逻辑，视频保留禁用占位。
```

- [ ] **Step 5: 提交实现**

```bash
git add apps/electron/src/renderer/components/design/NativeCanvasToolbar.tsx apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/ui/popover.tsx docs/superpowers/plans/2026-08-28-canvas-node-popover.md MEMORY.md
git commit -m "优化：将 Canvas 节点选择改为悬浮菜单"
```

提交前检查暂存差异，确保不包含 `.superpowers/` 等无关文件。
