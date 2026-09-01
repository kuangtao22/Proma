# Canvas 手型模式节点交互 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让手型模式下的画布节点仍可单击选中、双击打开详情，同时保持节点不可拖动并继续支持空白区域平移。

**Architecture:** 继续使用 XYFlow 的原生节点点击、双击和 `panOnDrag` 事件，不引入自定义手势层。只放宽节点选择与详情事件的工具限制，节点拖动、连线、框选和空白清选区仍由选择模式独占。

**Tech Stack:** React、TypeScript、Jotai、XYFlow、Bun Test

---

### Task 1: 恢复手型模式节点访问能力

**Files:**
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx:498-545`
- Test: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx:2708-2755`
- Modify: `MEMORY.md`

- [ ] **Step 1: 写入失败的 BDD 测试**

在已有手型模式 Graph 投影测试中增加以下断言，并模拟节点事件：

```ts
expect(flowProps?.elementsSelectable).toBe(true)
flowProps?.onNodeClick?.({} as never, flowProps.nodes[0]!)
expect(view.selectedNodeIds).toEqual(['agent-1'])
expect(view.expandedNodeId).toBeNull()
flowProps?.onNodeDoubleClick?.({} as never, flowProps.nodes[0]!)
expect(view.expandedNodeId).toBe('agent-1')
expect(mutations).toEqual([])
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `bun test apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx --test-name-pattern "手型模式"`

Expected: FAIL，`elementsSelectable` 当前为 `false`，节点点击不会更新选区或展开工作台。

- [ ] **Step 3: 写入最小实现**

将节点点击和双击改为两种工具都可用，并保持空白区域清选区只在选择模式发生：

```ts
const handleNodeClick = React.useCallback<NonNullable<NativeCanvasFlowProps['onNodeClick']>>((_event, node) => {
  syncSelectedNodeIds([node.id])
}, [syncSelectedNodeIds])

const handleNodeDoubleClick = React.useCallback<NonNullable<NativeCanvasFlowProps['onNodeDoubleClick']>>((_event, node) => {
  syncSelectedNodeIds([node.id])
  workbenchNodeChange(node.id)
}, [syncSelectedNodeIds, workbenchNodeChange])

elementsSelectable: true,
```

保留以下边界不变：

```ts
nodesDraggable: writable && activeTool === 'select',
nodesConnectable: writable && activeTool === 'select',
selectionOnDrag: activeTool === 'select',
panOnDrag: activeTool === 'pan' ? true : [1],
```

- [ ] **Step 4: 运行定向测试并确认通过**

Run: `bun test apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx --test-name-pattern "手型模式"`

Expected: PASS，手型模式单击只选中、双击展开，且无节点移动 mutation。

- [ ] **Step 5: 运行关联回归和类型检查**

Run: `bun test apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

Expected: PASS，Workspace 和大画布 Graph 既有交互测试无回归。

Run: `bun run typecheck`

Expected: 所有 workspace typecheck 退出码为 0。

- [ ] **Step 6: 记录长期交互规则并检查差异**

在 `MEMORY.md` 记录：手型模式只改变画布平移与结构编辑能力，不关闭节点单击选中和双击详情；节点拖动、连线和框选仍由选择模式独占。

Run: `git diff --check -- MEMORY.md apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: 退出码为 0。

- [ ] **Step 7: 提交实现**

```bash
git add MEMORY.md \
  apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx \
  apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx \
  docs/superpowers/plans/2026-09-01-canvas-pan-node-interaction.md
git commit -m "优化：支持手型模式访问画布节点"
```
