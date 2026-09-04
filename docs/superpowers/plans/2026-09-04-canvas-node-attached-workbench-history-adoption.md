# Canvas 节点跟随详情与历史版本采用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让节点详情工作台跟随节点移动且保持固定屏幕尺寸，并把图片版本操作统一收敛到历史版本中的“设为默认”。

**Architecture:** Renderer 不再保存工作台绝对屏幕坐标，而是按节点保存相对偏移，并使用节点实时屏幕投影派生 Overlay 位置。图片详情只消费 `imageVersions` 与 `adoptedAssetId`；候选批次继续作为主进程内部事务存在，但从 Workspace UI 和 Canvas 初始 LOAD 中移除。

**Tech Stack:** Bun、TypeScript、React、Jotai、Electron IPC、Radix Tooltip、Tailwind CSS

---

### Task 1: 节点级工作台相对偏移

**Files:**
- Modify: `apps/electron/src/renderer/atoms/agent-canvas-atoms.ts`
- Test: `apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts`

- [ ] **Step 1: 写入节点级偏移失败测试**

在 `native-canvas-atoms.test.ts` 中断言初始化状态包含 `workbenchOffsetsByNodeId: {}`，两个节点分别提交偏移后保持隔离，超过 64 项时淘汰最早条目，并在节点清理时同步删除偏移：

```ts
const firstUpdate = createAgentCanvasWorkbenchGeometryUpdate(current, 'image-1', {
  offset: { x: 300, y: 40 },
})
const next = { ...current, ...firstUpdate }
const secondUpdate = createAgentCanvasWorkbenchGeometryUpdate(next, 'document-1', {
  offset: { x: -500, y: 20 },
})
expect(secondUpdate.workbenchOffsetsByNodeId).toEqual({
  'image-1': { x: 300, y: 40 },
  'document-1': { x: -500, y: 20 },
})
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `bun test apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts`

Expected: FAIL，类型或断言指出 `offset` / `workbenchOffsetsByNodeId` 尚不存在。

- [ ] **Step 3: 实现有界节点级偏移状态**

在 `AgentCanvasViewState` 中用以下字段替换 `workbenchPosition`：

```ts
/** 用户调整后的相对偏移按节点隔离，单位为屏幕像素。 */
workbenchOffsetsByNodeId: Record<string, AgentCanvasWorkbenchPosition>
```

把几何输入改为：

```ts
export interface AgentCanvasWorkbenchGeometryInput {
  size?: AgentCanvasWorkbenchSize
  offset?: AgentCanvasWorkbenchPosition
}
```

`createAgentCanvasWorkbenchGeometryUpdate()` 分别复制、更新并限制 `workbenchSizesByNodeId` 与 `workbenchOffsetsByNodeId` 为 64 项；节点清理函数同时过滤两个 Map。

- [ ] **Step 4: 运行 Atom 测试并确认通过**

Run: `bun test apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts`

Expected: PASS。

### Task 2: Overlay 使用节点锚点派生位置

**Files:**
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Test: `apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx`
- Test: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写入坐标转换与跟随失败测试**

新增纯函数合同：

```ts
expect(resolveCanvasWorkbenchScreenPosition({
  nodeAnchor: { x: 340, y: 180 },
  offset: { x: 300, y: 20 },
})).toEqual({ x: 640, y: 200 })

expect(resolveCanvasWorkbenchOffset({
  nodeAnchor: { x: 340, y: 180 },
  screenPosition: { x: 640, y: 200 },
})).toEqual({ x: 300, y: 20 })
```

再以不同 `nodeScreenRect.left/top` 渲染同一 offset，断言 Overlay 的 `left/top` 同步变化而 `width/height` 不变；viewport 把节点移到负坐标时断言不被 surface clamp 固定在边缘。

- [ ] **Step 2: 运行 Overlay 测试并确认按预期失败**

Run: `bun test apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx`

Expected: FAIL，缺少坐标转换函数或 Overlay 仍使用绝对 `position`。

- [ ] **Step 3: 实现相对偏移 Overlay**

把 Overlay props 的位置合同改为：

```ts
offset?: CanvasWorkbenchPosition | null
onOffsetChange?: (offset: CanvasWorkbenchPosition) => void
```

首次打开继续调用 `calculateCanvasWorkbenchInitialPosition()`，随后用节点锚点反算 offset；已有 offset 时直接通过节点锚点派生屏幕位置，不对 viewport 变化执行位置 clamp。标题拖动仍以屏幕位置做局部预览，手势结束时反算并提交一次 offset。

- [ ] **Step 4: 更新 Workspace 接线**

`NativeCanvasWorkspace` 从 `viewState.workbenchOffsetsByNodeId[node.id]` 读取 offset，并通过 `createAgentCanvasWorkbenchGeometryUpdate(current, node.id, { offset })` 提交；继续传入实时 `nodeScreenRect` 和节点级固定尺寸。

- [ ] **Step 5: 运行 Overlay 与 Workspace 测试**

Run: `bun test apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: PASS。

### Task 3: 历史版本内设为默认

**Files:**
- Modify: `apps/electron/src/renderer/components/design/CanvasImageWorkbench.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Test: `apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx`
- Test: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写入历史版本交互失败测试**

删除旧候选 UI 期望，新增断言：

```ts
expect(html).not.toContain('候选批次')
expect(html).not.toContain('设为当前')
expect(html).toContain('默认')
expect(html).toContain('aria-label="设为默认"')
```

用可交互渲染测试分别点击缩略图与“设为默认”，断言前者只调用 `onPreviewAsset(assetId)`，后者只调用 `onAdoptAsset(assetId)`。只读状态断言采用按钮可见、禁用且 Tooltip 文案为“当前画布为只读状态”。

- [ ] **Step 2: 运行图片工作台测试并确认按预期失败**

Run: `bun test apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx`

Expected: FAIL，仍存在候选批次、外置“设为当前”，历史项没有“设为默认”按钮。

- [ ] **Step 3: 实现历史版本单项操作**

从 `CanvasImageWorkbenchProps` 删除 `candidateBatch`，移除 `CanvasImageCandidateBatchPanel` import 与渲染。历史项使用独立缩略图按钮和 icon button：

```tsx
{adopted ? (
  <span>默认</span>
) : (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        type="button"
        size="icon"
        variant="secondary"
        aria-label="设为默认"
        disabled={!writable || adoptingAssetId !== null}
        onClick={() => onAdoptAsset(asset.id)}
      >
        <Check aria-hidden="true" />
      </Button>
    </TooltipTrigger>
    <TooltipContent>{writable ? '设为默认' : '当前画布为只读状态'}</TooltipContent>
  </Tooltip>
)}
```

增加受控 `adoptingAssetId`，由 `CanvasImageNodeWorkbench` 在调用 `imageModule.adoptAsset()` 前设置、结束后清理，防止并发采用；失败继续由模块状态显示。

- [ ] **Step 4: 删除 Workspace 候选 UI 接线**

从 `NativeCanvasWorkspace` 删除候选 Adapter、controller、节点候选摘要、卡片候选标记与 `candidateBatch` props；不删除主进程 candidate batch 服务。

- [ ] **Step 5: 运行图片与 Workspace 测试**

Run: `bun test apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: PASS。

### Task 4: Canvas LOAD 不再扫描活跃候选摘要

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Test: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

- [ ] **Step 1: 写入 LOAD 不访问候选摘要的失败测试**

把测试依赖的 `listActiveSummaries` 改为抛错或记录调用次数，并断言 LOAD 仍成功且返回值无 `activeImageCandidateBatches`：

```ts
let listCalls = 0
imageCandidateBatches.listActiveSummaries = async () => {
  listCalls += 1
  throw new Error('LOAD 不应读取候选摘要')
}
const snapshot = await invokeLoad()
expect(listCalls).toBe(0)
expect(snapshot).not.toHaveProperty('activeImageCandidateBatches')
```

- [ ] **Step 2: 运行主进程定向测试并确认按预期失败**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

Expected: FAIL，Canvas LOAD 仍调用 `listActiveSummaries()`。

- [ ] **Step 3: 移除 LOAD 候选摘要读取**

在 Canvas `LOAD` handler 中直接返回已授权的权威 snapshot，不调用 `options.imageCandidateBatches.listActiveSummaries(input)`；依赖接口继续保留其它批次操作需要的方法。

- [ ] **Step 4: 运行 IPC 与候选后台测试**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.test.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts`

Expected: PASS，证明 UI/LOAD 收敛没有删除候选恢复能力。

### Task 5: 回归验证与项目记忆

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: 写入架构记忆**

在 `MEMORY.md` 追加一条 2026-09-04 决策：详情工作台采用节点相对偏移与固定屏幕尺寸；候选批次只保留内部事务，用户通过历史版本显式设为默认。说明为什么这样处理、用户影响与性能影响。

- [ ] **Step 2: 运行全部定向测试**

Run: `bun test apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.test.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts`

Expected: PASS。

- [ ] **Step 3: 运行类型检查与 Renderer build**

Run: `bun run typecheck`

Expected: PASS。

Run: `bun run build`

Expected: PASS。

- [ ] **Step 4: 检查差异与格式**

Run: `git diff --check`

Expected: 无输出且退出码为 0；检查 `git diff`，确认不覆盖用户原有改动、不删除 candidate batch 后台服务。

- [ ] **Step 5: 在当前开发客户端验证**

在 `http://127.0.0.1:5174/` 对包含图片节点的 Canvas 验证：平移、缩放、拖节点时工作台跟随且尺寸不变；历史预览不改变卡片；“设为默认”成功后卡片与默认标记同步；详情中无候选批次。
