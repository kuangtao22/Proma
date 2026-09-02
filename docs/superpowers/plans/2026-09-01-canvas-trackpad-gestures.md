# Canvas Trackpad Gestures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Canvas 使用两指滑动平移、捏合缩放，并保留工作台内部滚动隔离。

**Architecture:** 直接在 `NativeCanvasGraph` 的 XYFlow 属性边界声明手势合同，不增加自定义 wheel 监听器。现有 viewport reducer 和工作台 `nowheel/nopan` 继续分别负责持久化收敛与内部交互隔离。

**Tech Stack:** React、TypeScript、`@xyflow/react` 12.11.3、Bun Test

---

### Task 1: 锁定并实现画布手势合同

**Files:**
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx`
- Test: `apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`
- Modify: `MEMORY.md`

- [ ] **Step 1: 写失败测试**

在现有 select/pan 工具测试中增加以下 Flow 属性断言：

```ts
expect(captured[0]).toMatchObject({
  panOnScroll: true,
  zoomOnScroll: false,
  zoomOnPinch: true,
  preventScrolling: true,
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

Expected: FAIL，提示 `panOnScroll` 等属性缺失。

- [ ] **Step 3: 写最小实现**

在 `NativeCanvasGraph` 的 `flowProps` 中显式加入：

```ts
panOnScroll: true,
zoomOnScroll: false,
zoomOnPinch: true,
preventScrolling: true,
```

- [ ] **Step 4: 运行定向验证**

Run: `bun test apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

Expected: PASS。

- [ ] **Step 5: 运行类型检查**

Run: `bun run typecheck`

Expected: PASS。

- [ ] **Step 6: 更新项目记忆**

在 `MEMORY.md` 记录手势合同、采用原生配置的原因、用户影响和性能结论。
