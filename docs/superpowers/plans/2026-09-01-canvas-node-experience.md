# Canvas 节点体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为四类 Canvas 节点提供统一运行状态边框、固定可读的屏幕空间详情浮窗、Host 驱动的紧凑创建布局和显式整理布局。

**Architecture:** 先在 `@proma/shared` 建立与 React/Electron 无关的矩形空间索引和紧凑落点算法，主进程 Agent 产物创建与 Renderer 手工创建共同消费。工作台从 XYFlow 节点数据移到 Workspace surface 上层，尺寸和位置只保存在会话 view；节点活动状态通过结构化映射投影到通用卡片，运行轮廓由 CSS 驱动。

**Tech Stack:** TypeScript、React、Jotai、XYFlow、Radix/shadcn、Tailwind CSS、Bun test。

---

### Task 1: 建立共享紧凑布局内核

**Files:**
- Create: `packages/shared/src/utils/canvas-layout.ts`
- Create: `packages/shared/src/utils/canvas-layout.test.ts`
- Modify: `packages/shared/src/utils/index.ts`

- [ ] **Step 1: 写失败测试覆盖最近空槽和真实矩形避让**

```ts
test('Given 14 个连续候选 When 从同一锚点分配 Then 形成紧凑矩形而非单行', () => {
  const index = createCanvasLayoutSpatialIndex([], 24)
  const positions = Array.from({ length: 14 }, (_, order) => {
    const position = findCompactCanvasSlot(index, {
      anchor: { x: 0, y: 0 },
      size: { width: 288, height: 144 },
      order,
      direction: 'ring',
    })
    index.insert({ id: `node-${order}`, ...position, width: 288, height: 144 })
    return position
  })
  expect(new Set(positions.map((position) => position.y)).size).toBeGreaterThan(1)
  expect(Math.max(...positions.map((position) => position.x))).toBeLessThan(1_600)
})
```

- [ ] **Step 2: 运行共享测试确认失败**

Run: `bun test packages/shared/src/utils/canvas-layout.test.ts`

Expected: FAIL，提示 `createCanvasLayoutSpatialIndex` 或 `findCompactCanvasSlot` 尚未导出。

- [ ] **Step 3: 实现有界空间索引和确定性槽位合同**

```ts
export interface CanvasLayoutSize { width: number; height: number }
export interface CanvasLayoutRect extends DesignPoint, CanvasLayoutSize { id: string }
export interface FindCompactCanvasSlotInput {
  anchor: DesignPoint
  size: CanvasLayoutSize
  order: number
  direction: 'ring' | 'right'
}

export interface CanvasLayoutSpatialIndex {
  insert: (rect: CanvasLayoutRect) => void
  overlaps: (rect: Omit<CanvasLayoutRect, 'id'>) => boolean
}

export function createCanvasLayoutSpatialIndex(
  rects: readonly CanvasLayoutRect[],
  gap: number,
): CanvasLayoutSpatialIndex

export function findCompactCanvasSlot(
  index: CanvasLayoutSpatialIndex,
  input: FindCompactCanvasSlotInput,
): DesignPoint
```

实现要求：使用固定 bucket 哈希索引；候选顺序由 `order` 和方形环偏移确定；所有数值必须有限；达到 `existingCount + order + 1` 的有界环限制后抛出 `CANVAS_LAYOUT_SLOT_UNAVAILABLE`。

- [ ] **Step 4: 补充动态尺寸、重叠和非有限坐标测试并运行**

Run: `bun test packages/shared/src/utils/canvas-layout.test.ts`

Expected: PASS，至少覆盖 288×144、384×316、232×578 和非有限输入。

- [ ] **Step 5: 提交共享布局内核**

```bash
git add packages/shared/src/utils/canvas-layout.ts packages/shared/src/utils/canvas-layout.test.ts packages/shared/src/utils/index.ts
git commit -m "功能：增加画布紧凑布局内核"
```

### Task 2: 主进程 Agent 产物创建改用紧凑布局

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-artifact-creation.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts`
- Modify: `apps/electron/default-skills/canvas-production/SKILL.md`
- Modify: `apps/electron/src/main/lib/default-canvas-production-skill.test.ts`

- [ ] **Step 1: 写失败测试锁定无来源连续创建和同源兄弟布局**

```ts
test('Given Agent 连续创建 14 个产物 When 未提供坐标 Then 权威 Host 形成紧凑多行', async () => {
  const created = await createArtifactsSequentially(14)
  expect(new Set(created.map((node) => node.position.y)).size).toBeGreaterThan(1)
  expect(Math.max(...created.map((node) => node.position.x))).toBeLessThan(1_600)
})
```

- [ ] **Step 2: 运行测试确认仍为线性追加**

Run: `bun test apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts --test-name-pattern "紧凑多行"`

Expected: FAIL，现有结果全部 `y = 0`。

- [ ] **Step 3: 用共享空间索引替换 `ARTIFACT_HORIZONTAL_GAP` 追加逻辑**

```ts
function resolveArtifactPosition(
  document: CanvasDocument,
  requested: DesignPoint | undefined,
  sourceNodeId: string | undefined,
  candidateSize: CanvasLayoutSize,
): DesignPoint {
  const existing = document.nodes.map(toCanvasLayoutRect)
  const index = createCanvasLayoutSpatialIndex(existing, NATIVE_CANVAS_LAYOUT_GAP)
  const source = sourceNodeId
    ? document.nodes.find((node) => node.id === sourceNodeId)
    : undefined
  const anchor = source
    ? { x: source.position.x + resolvePersistedNodeSize(source).width + NATIVE_CANVAS_LAYOUT_GAP, y: source.position.y }
    : resolveDocumentLayoutAnchor(existing)
  if (requested && isSafeRequestedCanvasPosition(requested, existing, candidateSize, index)) return requested
  return findCompactCanvasSlot(index, {
    anchor,
    size: candidateSize,
    order: resolveStableSiblingOrder(document, sourceNodeId),
    direction: source ? 'right' : 'ring',
  })
}
```

候选尺寸必须按 `artifactType` 和 WebView `devicePreset` 解析；极远、重叠、`NaN` 和无穷坐标回退自动布局。

- [ ] **Step 4: 更新内置 Skill，停止要求 Agent 计算普通绝对坐标**

将 frontmatter `version` 从 `1.0.0` 增加到 `1.0.1`，在“规划产物图”补充：

```md
普通创建不要主动提供 position；由 Proma 根据来源关系和真实节点尺寸紧凑排布。只有用户明确要求特殊版式时才提供坐标，Host 仍会校验重叠和距离。
```

- [ ] **Step 5: 运行定向测试并提交**

Run: `bun test apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts apps/electron/src/main/lib/default-canvas-production-skill.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/design/canvas-artifact-creation.ts apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts apps/electron/default-skills/canvas-production/SKILL.md apps/electron/src/main/lib/default-canvas-production-skill.test.ts
git commit -m "优化：收紧 Agent 画布节点布局"
```

### Task 3: Renderer 手工创建复用共享布局

**Files:**
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.ts`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.test.ts`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

- [ ] **Step 1: 写失败测试覆盖顶部新增、节点扩展和动态尺寸避让**

```ts
test('Given 当前视口已有节点 When 连续顶部新增 Then 在视口锚点附近换行且不移动旧节点', () => {
  const position = findNativeCanvasNodeCreationPosition(document, surfaceBounds, { kind: 'image' })
  expect(position).toEqual({ x: 336, y: 192 })
  expect(document.nodes).toEqual(before)
})
```

- [ ] **Step 2: 运行 Renderer 布局测试确认失败**

Run: `bun test apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx --test-name-pattern "换行|动态尺寸"`

Expected: FAIL，现有顶部路径优先全局最右追加，扩展路径只检查固定高度。

- [ ] **Step 3: 将 Renderer 入口改为共享矩形索引**

```ts
export function findNativeCanvasNodeCreationPosition(
  document: CanvasDocument,
  surfaceBounds: NativeCanvasSurfaceBounds,
  candidate: Pick<CanvasNode, 'kind'> & { devicePreset?: CanvasWebviewDevicePreset },
): DesignPoint {
  const anchor = viewportCenterToWorld(document.viewport, surfaceBounds)
  return findCompactCanvasSlot(
    createCanvasLayoutSpatialIndex(toNativeCanvasLayoutRects(document.nodes), NATIVE_CANVAS_NODE_GAP),
    { anchor, size: resolveNativeCanvasNodeSize(candidate), order: document.nodes.length, direction: 'ring' },
  )
}
```

节点侧扩展以来源节点右侧为 anchor；创建控制器 `getPosition` 接收目标 `kind`，不再先按 Agent 固定尺寸计算。

- [ ] **Step 4: 运行布局与性能测试并提交**

Run: `bun test apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

Expected: PASS，千节点布局预算不回退。

```bash
git add apps/electron/src/renderer/components/design/native-canvas-model.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx
git commit -m "优化：统一画布节点紧凑落点"
```

### Task 4: 将工作台 view state 改为按节点几何

**Files:**
- Modify: `apps/electron/src/renderer/atoms/agent-canvas-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts`

- [ ] **Step 1: 写失败测试覆盖按节点尺寸和旧状态迁移**

```ts
test('Given 两类节点有不同尺寸 When 更新其中一个 Then 另一节点保持默认', () => {
  const current = createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 1 })
  const update = createAgentCanvasWorkbenchGeometryUpdate(current, 'image-1', {
    size: { width: 1_000, height: 720 },
  })
  expect(update.workbenchSizesByNodeId?.['image-1']).toEqual({ width: 1_000, height: 720 })
  expect(update.workbenchSizesByNodeId?.['document-1']).toBeUndefined()
})
```

- [ ] **Step 2: 运行原子测试确认失败**

Run: `bun test apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts --test-name-pattern "按节点尺寸"`

Expected: FAIL，类型仍只有单个 `workbenchSize`。

- [ ] **Step 3: 增加有界几何状态与迁移 helper**

```ts
export interface AgentCanvasWorkbenchPosition { x: number; y: number }

export interface AgentCanvasViewState {
  // existing fields
  workbenchSizesByNodeId: Record<string, AgentCanvasWorkbenchSize>
  workbenchPosition: AgentCanvasWorkbenchPosition | null
}

export function createAgentCanvasWorkbenchGeometryUpdate(
  current: AgentCanvasViewState,
  nodeId: string,
  input: { size?: AgentCanvasWorkbenchSize; position?: AgentCanvasWorkbenchPosition },
): Partial<AgentCanvasViewState>
```

尺寸映射最多保留 64 个节点；更新已有键不改变顺序，新增超限时删除最早键。Legacy `workbenchSize` 只迁入当前 `expandedNodeId`，随后删除旧字段。

- [ ] **Step 4: 运行测试并提交**

Run: `bun test apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/renderer/atoms/agent-canvas-atoms.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts
git commit -m "重构：按节点保存画布详情几何"
```

### Task 5: 把详情工作台移到屏幕空间浮窗

**Files:**
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写失败测试锁定默认尺寸、zoom 独立和边界选位**

```ts
test.each([
  ['agent', { width: 760, height: 640 }],
  ['image', { width: 960, height: 700 }],
  ['document', { width: 900, height: 700 }],
] as const)('Given %s 首次打开 When 解析默认尺寸 Then 使用屏幕像素预设', (kind, expected) => {
  expect(resolveCanvasWorkbenchDefaultSize(createNode(kind))).toEqual(expected)
})
```

另加测试：节点右侧不足时选择左侧；两侧不足时居中；`zoom=0.2` 与 `zoom=2` 得到相同浮窗宽高。

- [ ] **Step 2: 运行 Overlay 和 Workspace 测试确认失败**

Run: `bun test apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx --test-name-pattern "屏幕像素|右侧不足|zoom"`

Expected: FAIL，现有工作台仍由 XYFlow 节点携带并继承 transform。

- [ ] **Step 3: 重构 Overlay 为 surface 绝对定位浮窗**

```ts
export interface CanvasNodeWorkbenchOverlayProps {
  node: CanvasNode
  surfaceSize: CanvasWorkbenchSize
  position: CanvasWorkbenchPosition | null
  size: CanvasWorkbenchSize | null
  nodeScreenRect: DOMRectReadOnly
  onPositionChange: (position: CanvasWorkbenchPosition) => void
  onSizeChange: (size: CanvasWorkbenchSize) => void
  // existing dirty/close/content props
}

export function resolveCanvasWorkbenchDefaultSize(node: CanvasNode): CanvasWorkbenchSize
export function calculateCanvasWorkbenchInitialPosition(input: {
  nodeRect: Pick<DOMRectReadOnly, 'left' | 'right' | 'top'>
  surfaceSize: CanvasWorkbenchSize
  workbenchSize: CanvasWorkbenchSize
}): CanvasWorkbenchPosition
```

Overlay 根节点改为 `absolute` 的屏幕像素几何；标题栏增加 `cursor-move` 指针捕获，移动和缩放都只在结束时提交一次；小 surface 使用 12px 边距收敛。

- [ ] **Step 4: 从 Graph 删除工作台注入，在 Workspace surface 渲染唯一浮窗**

删除 `attachNativeCanvasWorkbench`、`renderWorkbench`、`expandedNodeId` 和节点数据中的 `workbench`。Workspace 根据 `viewState.viewport`、节点世界坐标和 `resolveNativeCanvasNodeSize` 计算 `nodeScreenRect`，在 `<NativeCanvasGraph />` 后渲染 `<CanvasNodeWorkbenchOverlay>`。

- [ ] **Step 5: 运行定向测试和性能测试并提交**

Run: `bun test apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

Expected: PASS，折叠节点数据不再携带 React 工作台元素。

```bash
git add apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.tsx apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx
git commit -m "优化：画布详情改为屏幕空间浮窗"
```

### Task 6: 增加结构化节点活动状态和运行虚线

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Modify: `packages/shared/src/types/canvas.test.ts`
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeCard.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.ts`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.test.ts`
- Modify: `apps/electron/src/renderer/styles/globals.css`

- [ ] **Step 1: 写失败测试覆盖四态、选中叠加和空闲零 SVG**

```ts
test.each([
  ['idle', false, false],
  ['queued', true, false],
  ['running', true, true],
  ['waiting-approval', true, false],
] as const)('Given %s When 渲染卡片 Then 轮廓与动画符合合同', (activityState, outline, animated) => {
  const html = renderCard('image', { activityState })
  expect(html.includes('data-canvas-activity-outline')).toBe(outline)
  expect(html.includes('canvas-running-dash')).toBe(animated)
})
```

- [ ] **Step 2: 运行卡片测试确认失败**

Run: `bun test apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx --test-name-pattern "轮廓与动画"`

Expected: FAIL，卡片尚无 `activityState`。

- [ ] **Step 3: 增加跨层活动类型和卡片 SVG 轮廓**

```ts
export type CanvasNodeActivityState = 'idle' | 'queued' | 'running' | 'waiting-approval'

function CanvasNodeActivityOutline({ state }: { state: CanvasNodeActivityState }): React.ReactElement | null {
  if (state === 'idle') return null
  return (
    <svg data-canvas-activity-outline aria-hidden="true" className="pointer-events-none absolute -inset-1 size-[calc(100%+8px)] overflow-visible">
      <rect
        x="2" y="2" width="calc(100% - 4px)" height="calc(100% - 4px)" rx="10"
        className={cn('fill-none stroke-primary stroke-2 [stroke-dasharray:8_6]', state === 'running' && 'canvas-running-dash')}
      />
    </svg>
  )
}
```

在 `globals.css` 增加 `stroke-dashoffset` keyframes，并在 `prefers-reduced-motion: reduce` 停止动画。活动轮廓必须位于选中 ring 外层且 `pointer-events: none`。

- [ ] **Step 4: 投影使用结构化状态，不比较 `statusLabel`**

`NativeCanvasProjectionOptions` 增加 `nodeActivityStates?: ReadonlyMap<string, CanvasNodeActivityState>`；Agent 的 `runningSessionIds` 在 Workspace 聚合为节点 ID 映射，优先级使用 `running > waiting-approval > queued > idle`。

- [ ] **Step 5: 运行类型、卡片和模型测试并提交**

Run: `bun test packages/shared/src/types/canvas.test.ts apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/native-canvas-model.test.ts`

Expected: PASS。

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts apps/electron/src/renderer/components/design/CanvasNodeCard.tsx apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/native-canvas-model.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/styles/globals.css
git commit -m "功能：增加画布节点运行状态边框"
```

### Task 7: 增加显式整理布局命令

**Files:**
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasToolbar.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.ts`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.test.ts`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写失败测试覆盖显式范围和运行节点跳过**

```ts
test('Given 选区含运行节点 When 整理选中节点 Then 只移动空闲节点且不改关系', () => {
  const mutation = createArrangeCanvasNodesMutation(document, ['idle-1', 'running-1'], new Set(['running-1']))
  expect(mutation.positions.map((entry) => entry.nodeId)).toEqual(['idle-1'])
  expect(document.edges).toEqual(beforeEdges)
})
```

- [ ] **Step 2: 运行工具栏和模型测试确认失败**

Run: `bun test apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx apps/electron/src/renderer/components/design/native-canvas-model.test.ts --test-name-pattern "整理"`

Expected: FAIL，整理菜单和 mutation helper 尚不存在。

- [ ] **Step 3: 实现确定性整理 helper**

```ts
export function createArrangeCanvasNodesMutation(
  document: CanvasDocument,
  scopeNodeIds: readonly string[],
  blockedNodeIds: ReadonlySet<string>,
): Extract<CanvasMutation, { type: 'move-nodes' }> {
  const movable = stableScopeNodes(document, scopeNodeIds, blockedNodeIds)
  const positions = arrangeCanvasLayoutRects({ nodes: movable, edges: document.edges })
  return { type: 'move-nodes', positions }
}
```

布局保持有向关系左到右、同层紧凑排列、无关系组件分组；只返回实际变化的位置。

- [ ] **Step 4: 在顶部工具栏增加整理菜单**

使用 Lucide `LayoutGrid` 图标。菜单固定包含：`整理选中节点`、`整理当前可见节点`、`整理整个画布`；整图操作显示节点数量确认，选中少于 2 时禁用选区项。

- [ ] **Step 5: Workspace 路由为单个位置 mutation**

当前可见节点通过 view viewport 与真实节点矩形计算；运行或等待审批节点加入 blocked 集合；最终调用现有 `controllerRef.current?.enqueueMutation(mutation)`，不创建新 IPC。

- [ ] **Step 6: 运行相关测试并提交**

Run: `bun test apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: PASS。

```bash
git add apps/electron/src/renderer/components/design/NativeCanvasToolbar.tsx apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx apps/electron/src/renderer/components/design/native-canvas-model.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
git commit -m "功能：增加画布节点整理布局"
```

### Task 8: 节点体验集成验证

**Files:**
- Modify only if failures require: files changed in Tasks 1-7

- [ ] **Step 1: 运行节点体验定向测试**

Run:

```bash
bun test packages/shared/src/utils/canvas-layout.test.ts packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts apps/electron/src/main/lib/default-canvas-production-skill.test.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 2: 运行全仓类型检查**

Run: `bun run typecheck`

Expected: 所有 workspace 退出码 0。

- [ ] **Step 3: 运行 Electron 构建**

Run: `bun run electron:build`

Expected: 主进程、Preload 和 Renderer 构建成功。

- [ ] **Step 4: 执行客户端定向手测**

启动 `bun run dev`，验证：

1. zoom 20% 和 200% 下详情浮窗屏幕尺寸一致；
2. Agent、生图、文档、桌面/手机 WebView 首次尺寸可用；
3. 运行 Agent 节点虚线流动，完成后停止；
4. 连续创建 14 个节点形成紧凑多行；
5. 整理选区不移动运行节点；
6. 单击、双击、平移、拖动、连线和缩放手柄均不回退。

- [ ] **Step 5: 提交验证修复（仅有必要差异时）**

```bash
git add <本阶段实际修复文件>
git commit -m "修复：收口画布节点体验回归"
```
