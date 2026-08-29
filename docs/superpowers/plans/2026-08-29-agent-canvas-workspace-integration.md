# Agent 画布工作区集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将项目画布迁入普通 Agent 的右侧工作区，使多个 Agent 可共享画布事实、保持独立视图，并通过结构化节点引用和受控 Pi 工具完成规划、创建、连线与执行。

**Architecture:** 现有 Canvas Store、节点生命周期、媒体授权和任务引擎继续作为项目级权威事实；新增独立的 Agent-Canvas 关联索引、会话级视图状态、右侧工作区适配器和 Pi 工具提供器。消息只持久化经过主进程复核的节点引用，批量图修改通过单次 revision 事务提交；迁移期间新旧入口读取同一 Store，新链路验收后再删除左侧会话和独立主视图。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Jotai、Radix/shadcn、XYFlow、Pi Agent Runtime、JSON/JSONL 原子持久化。

---

## 实施边界与文件结构

### 新建文件

- `apps/electron/src/main/lib/design/agent-canvas-binding-store.ts`：保存普通 Agent 与项目画布的关联，不修改 `AgentSessionMeta`。
- `apps/electron/src/main/lib/design/agent-canvas-binding-store.test.ts`：覆盖项目隔离、默认画布、删除清理和损坏配置降级。
- `apps/electron/src/main/lib/design/agent-canvas-binding-ipc.ts`：注册关联列表、关联、取消关联、设默认和 Agent 删除清理 IPC。
- `apps/electron/src/main/lib/design/agent-canvas-binding-ipc.test.ts`：覆盖 sender、项目归属和事件广播边界。
- `apps/electron/src/renderer/atoms/agent-canvas-atoms.ts`：拆分共享画布图状态与按 Agent 隔离的视图状态。
- `apps/electron/src/renderer/atoms/agent-canvas-atoms.test.ts`：证明共享图不分叉、视口与选区互不影响。
- `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.tsx`：把原生 Canvas 挂入官方右侧工作区，不复制画布实现。
- `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx`：覆盖加载、失效关联、展开与后台活动。
- `apps/electron/src/main/lib/design/canvas-node-reference-resolver.ts`：发送前重新验证引用并读取精确 revision 的最小上下文。
- `apps/electron/src/main/lib/design/canvas-node-reference-resolver.test.ts`：覆盖节点更新、删除、越权和历史 revision 失效。
- `apps/electron/src/main/lib/design/canvas-agent-batch-operation.ts`：以一个基础 revision 原子提交多节点和连线，并维护恢复 intent。
- `apps/electron/src/main/lib/design/canvas-agent-batch-operation.test.ts`：覆盖全有或全无、冲突、恢复和内容准备失败清理。
- `apps/electron/src/main/lib/design/canvas-tool-provider.ts`：按单轮授权生成 `canvas_*` Pi 工具和系统提示增量。
- `apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`：覆盖工具访问集合、破坏性边界、最多一次冲突重试和付费准入。

### 重点修改文件

- `packages/shared/src/types/canvas.ts`：定义关联、节点引用、批量修改、执行与 IPC 合同。
- `packages/shared/src/types/agent.ts`：给发送、队列和 `SDKUserMessage` 增加可选结构化引用。
- `apps/electron/src/main/lib/config-paths.ts`：增加 `~/.proma/agent-canvas-bindings.json` 路径。
- `apps/electron/src/main/ipc.ts`、`apps/electron/src/preload/design-preload.ts`、`apps/electron/src/preload/index.ts`、`apps/electron/src/renderer/lib/design-adapter.ts`：完成 IPC 四层合同。
- `apps/electron/src/renderer/atoms/native-canvas-atoms.ts`：仅保留共享图快照和保存状态，移出 Agent 私有 viewport、选区和工作台尺寸。
- `apps/electron/src/renderer/atoms/agent-atoms.ts`、`apps/electron/src/renderer/components/agent/SidePanel.tsx`、`apps/electron/src/renderer/components/diff/DiffPanelTabBar.tsx`：接入 `canvas:<canvasId>` 动态标签、选择菜单和双 Pane。
- `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`、`NativeCanvasToolbar.tsx`、`CanvasNodeCard.tsx`：消费会话视图状态并提供节点引用操作。
- `apps/electron/src/renderer/components/agent/AgentView.tsx`、`apps/electron/src/renderer/lib/agent-message-queue.ts`、`apps/electron/src/renderer/components/ai-elements/rich-text-input.tsx`、`message.tsx`：发送、队列、输入区和历史消息展示节点引用。
- `apps/electron/src/main/lib/agent-service.ts`、`agent-orchestrator.ts`、`agent-run-extensions.ts`：验证引用、持久化真实 revision、注入轻量上下文和画布工具。
- `apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`、`TabBar.tsx`、`MainArea.tsx`、`AppShell.tsx`：新入口验收后删除旧独立画布导航。

## 不变量

- 画布图、节点内容、素材、连线和节点位置以 `projectId + canvasId` 唯一共享。
- viewport、主选节点、多选集合、详情尺寸和展开状态以 `sessionId + projectId + canvasId` 隔离。
- 历史引用记录实际发送时的 `nodeRevision`；失效历史不能静默读取当前节点。
- `canvas_apply_changes` 一次调用只产生一次图 revision；内容准备失败时图不可见。
- 普通分析不创建画布、不修改节点、不调用付费任务；明确规划可创建待执行结构；明确生成才执行。
- 右侧后台更新只显示活动提示，不切换当前标签或 Agent。
- 不新增运行时依赖，不建立第二份画布文档，不迁移节点 ID 或素材目录。

### Task 1: 建立共享类型与严格解析合同

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Modify: `packages/shared/src/types/canvas.test.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Create: `packages/shared/src/types/agent.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 写关联、引用和批量操作的失败测试**

在 `packages/shared/src/types/canvas.test.ts` 增加 BDD 用例，固定去重、默认画布必须已关联、引用 ID/类型/revision 严格校验以及批量请求必须使用唯一基础 revision：

```ts
test('给定重复关联时，解析后只保留一次并要求默认画布属于关联集合', () => {
  expect(parseAgentCanvasBinding({
    projectId: 'project-1',
    sessionId: 'session-1',
    defaultCanvasId: 'canvas-1',
    linkedCanvasIds: ['canvas-1', 'canvas-1', 'canvas-2'],
    lastActiveCanvasId: 'canvas-2',
    updatedAt: 1,
  })).toEqual({
    projectId: 'project-1',
    sessionId: 'session-1',
    defaultCanvasId: 'canvas-1',
    linkedCanvasIds: ['canvas-1', 'canvas-2'],
    lastActiveCanvasId: 'canvas-2',
    updatedAt: 1,
  })
  expect(() => parseAgentCanvasBinding({
    projectId: 'project-1',
    sessionId: 'session-1',
    defaultCanvasId: 'canvas-x',
    linkedCanvasIds: ['canvas-1'],
    updatedAt: 1,
  })).toThrow('默认画布必须已关联')
})

test('给定节点引用时，只接受完整身份和非负整数 revision', () => {
  expect(parseCanvasNodeReference({
    projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
    nodeType: 'webview', nodeRevision: 3, title: '首页',
  }).nodeRevision).toBe(3)
  expect(() => parseCanvasNodeReference({
    projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
    nodeType: 'webview', nodeRevision: -1, title: '首页',
  })).toThrow('节点版本无效')
})
```

在 `packages/shared/src/types/agent.test.ts` 固定 `canvasNodeReferences` 可通过发送和两类队列合同，并且非数组输入被拒绝。

- [ ] **Step 2: 运行共享类型测试并确认失败**

Run: `bun test packages/shared/src/types/canvas.test.ts packages/shared/src/types/agent.test.ts`

Expected: FAIL，提示 `parseAgentCanvasBinding`、`parseCanvasNodeReference` 或 `canvasNodeReferences` 尚未定义。

- [ ] **Step 3: 实现共享接口、解析器和 IPC 通道**

在 `packages/shared/src/types/canvas.ts` 增加以下公开合同，并使用文件既有 `parseCanvasId`/安全字符串校验器实现解析，不接受未知结构：

```ts
export interface AgentCanvasBinding {
  projectId: string
  sessionId: string
  defaultCanvasId?: string
  linkedCanvasIds: string[]
  lastActiveCanvasId?: string
  updatedAt: number
}

export interface CanvasNodeReference {
  projectId: string
  canvasId: string
  nodeId: string
  nodeType: CanvasNode['type']
  nodeRevision: number
  title: string
}

export interface CanvasBatchOperationInput extends CanvasTarget {
  baseRevision: number
  operations: CanvasMutation[]
  sourceSessionId: string
  sourceRunStartedAt: number
  sourceToolCallId: string
}

export interface CanvasRunNodesInput extends CanvasTarget {
  nodeIds: string[]
  sourceSessionId: string
  sourceRunStartedAt: number
  sourceToolCallId: string
}
```

给 `CANVAS_IPC_CHANNELS` 增加 `LIST_AGENT_BINDINGS`、`LINK_AGENT_CANVAS`、`UNLINK_AGENT_CANVAS`、`SET_DEFAULT_AGENT_CANVAS`、`CLEAR_AGENT_BINDINGS`，并定义每个输入/输出接口。解析器必须去重且保持首现顺序；默认和最后活动画布存在时必须属于 `linkedCanvasIds`。

在 `packages/shared/src/types/agent.ts` 给 `AgentSendInput`、`AgentQueueMessageInput` 和 `SDKUserMessage` 增加：

```ts
canvasNodeReferences?: CanvasNodeReference[]
_canvasNodeReferences?: CanvasNodeReference[]
```

其中发送合同使用 `canvasNodeReferences`，持久化消息只使用 `_canvasNodeReferences`；队列输入沿用发送合同，不重复定义另一套形状。

- [ ] **Step 4: 运行共享测试并确认通过**

Run: `bun test packages/shared/src/types/canvas.test.ts packages/shared/src/types/agent.test.ts`

Expected: PASS，且现有 Canvas/Agent 类型用例无回归。

- [ ] **Step 5: 提交共享合同**

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts packages/shared/src/types/agent.ts packages/shared/src/types/agent.test.ts packages/shared/src/index.ts
git commit -m "功能：定义 Agent 画布关联与节点引用合同"
```

### Task 2: 持久化 Agent-画布关联索引

**Files:**
- Create: `apps/electron/src/main/lib/design/agent-canvas-binding-store.ts`
- Create: `apps/electron/src/main/lib/design/agent-canvas-binding-store.test.ts`
- Modify: `apps/electron/src/main/lib/config-paths.ts`
- Modify: `apps/electron/src/main/lib/config-paths.test.ts`

- [ ] **Step 1: 写关联存储失败测试**

```ts
test('给定两个 Agent 共享画布时，删除一个 Agent 只清理它的关联', () => {
  const store = createStore(tempRoot)
  store.link({ projectId: 'p1', sessionId: 's1', canvasId: 'c1', makeDefault: true })
  store.link({ projectId: 'p1', sessionId: 's2', canvasId: 'c1', makeDefault: true })
  store.clearSession('s1')
  expect(store.get('p1', 's1')).toBeNull()
  expect(store.get('p1', 's2')?.defaultCanvasId).toBe('c1')
})

test('给定损坏索引时，读取降级为空且下一次写入原子重建', () => {
  writeFileSync(bindingsPath, '{broken')
  const store = createStore(tempRoot)
  expect(store.listByProject('p1')).toEqual([])
  store.link({ projectId: 'p1', sessionId: 's1', canvasId: 'c1', makeDefault: true })
  expect(JSON.parse(readFileSync(bindingsPath, 'utf8')).bindings).toHaveLength(1)
})
```

同时覆盖：取消默认画布后按 `linkedCanvasIds[0]` 选择新默认、删除画布清理所有项目内关联、同名 ID 不跨项目污染、无变化操作不写磁盘。

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test apps/electron/src/main/lib/design/agent-canvas-binding-store.test.ts apps/electron/src/main/lib/config-paths.test.ts`

Expected: FAIL，提示 Store 和路径方法不存在。

- [ ] **Step 3: 实现路径与原子 Store**

在 `config-paths.ts` 增加：

```ts
/** 返回普通 Agent 与项目画布关联索引路径。 */
export function getAgentCanvasBindingsPath(): string {
  return join(getConfigDir(), 'agent-canvas-bindings.json')
}
```

Store 使用 schema 包装并只通过 `readJsonFileSafe`、`writeJsonFileAtomic` 读写：

```ts
interface AgentCanvasBindingsFile {
  version: 1
  bindings: AgentCanvasBinding[]
}

export class AgentCanvasBindingStore {
  get(projectId: string, sessionId: string): AgentCanvasBinding | null
  listByProject(projectId: string): AgentCanvasBinding[]
  link(input: LinkAgentCanvasInput): AgentCanvasBinding
  unlink(input: UnlinkAgentCanvasInput): AgentCanvasBinding | null
  setDefault(input: SetDefaultAgentCanvasInput): AgentCanvasBinding
  clearSession(sessionId: string): void
  clearCanvas(projectId: string, canvasId: string): void
}
```

写入前调用 Task 1 的解析器；损坏文件记录中文警告并按空索引运行，不覆盖原文件，直到用户触发一次有效写操作。

- [ ] **Step 4: 运行存储测试并确认通过**

Run: `bun test apps/electron/src/main/lib/design/agent-canvas-binding-store.test.ts apps/electron/src/main/lib/config-paths.test.ts`

Expected: PASS，原子写、项目隔离和清理行为均通过。

- [ ] **Step 5: 提交关联存储**

```bash
git add apps/electron/src/main/lib/design/agent-canvas-binding-store.ts apps/electron/src/main/lib/design/agent-canvas-binding-store.test.ts apps/electron/src/main/lib/config-paths.ts apps/electron/src/main/lib/config-paths.test.ts
git commit -m "功能：持久化 Agent 与画布关联"
```

### Task 3: 打通关联 IPC 四层合同

**Files:**
- Create: `apps/electron/src/main/lib/design/agent-canvas-binding-ipc.ts`
- Create: `apps/electron/src/main/lib/design/agent-canvas-binding-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/design-preload.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写 IPC 与 Preload 失败测试**

```ts
test('关联前验证普通 Agent 与画布属于同一项目，并广播精确会话变化', async () => {
  const result = await invoke('link', {
    projectId: 'p1', sessionId: 's1', canvasId: 'c1', makeDefault: true,
  })
  expect(result.defaultCanvasId).toBe('c1')
  expect(events).toEqual([{ projectId: 'p1', sessionId: 's1', cause: 'linked' }])
})

test('Preload 只暴露安全结果，不向 Renderer 泄漏 rejection 正文', async () => {
  ipc.invoke.mockRejectedValueOnce(new Error('absolute secret path'))
  const result = await api.linkAgentCanvas({
    projectId: 'p1', sessionId: 's1', canvasId: 'c1', makeDefault: true,
  })
  expect(result).toEqual({
    ok: false,
    error: { code: 'CANVAS_BINDING_FAILED', message: '画布关联失败，请重试。' },
  })
})
```

覆盖 Renderer Adapter 的解包、事件释放幂等和 API 缺失固定中文错误。

- [ ] **Step 2: 运行 IPC 测试并确认失败**

Run: `bun test apps/electron/src/main/lib/design/agent-canvas-binding-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: FAIL，提示关联 IPC/Preload/Adapter 方法不存在。

- [ ] **Step 3: 实现主进程注册与四层桥接**

`registerAgentCanvasBindingIpcHandlers` 注入 `AgentCanvasBindingStore`、普通 Agent session 查询器、CanvasSessionStore 和 `broadcast`：

```ts
export interface RegisterAgentCanvasBindingIpcOptions {
  store: AgentCanvasBindingStore
  getAgentSession: (sessionId: string) => AgentSessionMeta | null
  getCanvasSession: (projectId: string, canvasId: string) => CanvasSession | null
  broadcast: (event: AgentCanvasBindingChangeEvent) => void
}
```

每个写 handler 先解析输入，再验证：普通顶层 Agent、Agent `projectId` 与请求一致、画布存在且项目一致。`main/ipc.ts` 复用进程级唯一 Store 注册；Canvas 删除成功后调用 `clearCanvas`，Agent 删除成功后调用 `clearSession`。

Preload 暴露 `listAgentCanvasBindings`、`linkAgentCanvas`、`unlinkAgentCanvas`、`setDefaultAgentCanvas`、`onAgentCanvasBindingChanged`；Renderer `DesignAdapter` 提供同名强类型方法。

- [ ] **Step 4: 运行 IPC 测试并确认通过**

Run: `bun test apps/electron/src/main/lib/design/agent-canvas-binding-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: PASS，跨项目、内部 Agent 和已删除画布请求均被拒绝。

- [ ] **Step 5: 提交 IPC 链路**

```bash
git add apps/electron/src/main/lib/design/agent-canvas-binding-ipc.ts apps/electron/src/main/lib/design/agent-canvas-binding-ipc.test.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/preload/index.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "功能：接通 Agent 画布关联接口"
```

### Task 4: 拆分共享画布状态与 Agent 独立视图状态

**Files:**
- Create: `apps/electron/src/renderer/atoms/agent-canvas-atoms.ts`
- Create: `apps/electron/src/renderer/atoms/agent-canvas-atoms.test.ts`
- Modify: `apps/electron/src/renderer/atoms/native-canvas-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写状态隔离失败测试**

```ts
test('两个 Agent 共享同一画布快照但拥有独立 viewport 与选区', () => {
  const graphKey = createNativeCanvasKey('p1', 'c1')
  const viewA = createAgentCanvasViewKey('s1', 'p1', 'c1')
  const viewB = createAgentCanvasViewKey('s2', 'p1', 'c1')
  store.set(updateNativeCanvasStateAtom, { key: graphKey, update: { snapshot } })
  store.set(updateAgentCanvasViewStateAtom, {
    key: viewA,
    update: { viewport: { x: 10, y: 20, zoom: 1.2 }, selectedNodeIds: ['n1'] },
  })
  expect(store.get(nativeCanvasStatesAtom).get(graphKey)?.snapshot).toBe(snapshot)
  expect(store.get(agentCanvasViewStatesAtom).get(viewB)?.selectedNodeIds ?? []).toEqual([])
})

test('移动视口不产生 CanvasMutation 或图 revision 保存', () => {
  const next = updateAgentCanvasViewport(createInitialAgentCanvasViewState(), viewport)
  expect(next.viewport).toEqual(viewport)
  expect(next).not.toHaveProperty('pendingMutations')
})
```

- [ ] **Step 2: 运行 atoms 和工作区测试并确认失败**

Run: `bun test apps/electron/src/renderer/atoms/agent-canvas-atoms.test.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: FAIL，尚无 Agent 视图状态且工作区仍从共享 `NativeCanvasState` 读取选区/viewport。

- [ ] **Step 3: 实现两层状态并迁移工作区消费方**

```ts
export interface AgentCanvasViewState {
  viewport: CanvasViewport
  selectedNodeId: string | null
  selectedNodeIds: string[]
  expandedNodeId: string | null
  workbenchSize: { width: number; height: number } | null
  isExpanded: boolean
  activityRevision: number | null
}

export function createAgentCanvasViewKey(
  sessionId: string,
  projectId: string,
  canvasId: string,
): string {
  return JSON.stringify([sessionId, projectId, canvasId])
}
```

`NativeCanvasState` 继续保存 `snapshot`、pending/in-flight mutations、save/recovery/error；移出 viewport、选择、工作台展开和尺寸。首次打开某 Agent/Canvas 视图时只把 `CanvasDocument.viewport` 复制为初始值，之后缩放平移不写回共享文档。节点拖动和图结构修改仍写共享 mutation。

`NativeCanvasWorkspace` 增加 `sessionId` 入参，从两类 atom 分别读取图和视图；卸载只释放当前 view key 的临时状态，不清除共享图缓存。

- [ ] **Step 4: 运行状态与工作区测试并确认通过**

Run: `bun test apps/electron/src/renderer/atoms/agent-canvas-atoms.test.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: PASS，同画布图更新同时可见，两个 Agent 的 viewport、选区、详情尺寸互不影响。

- [ ] **Step 5: 提交状态拆分**

```bash
git add apps/electron/src/renderer/atoms/agent-canvas-atoms.ts apps/electron/src/renderer/atoms/agent-canvas-atoms.test.ts apps/electron/src/renderer/atoms/native-canvas-atoms.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
git commit -m "重构：分离共享画布与 Agent 视图状态"
```

### Task 5: 将画布接入 Agent 右侧工作区

**Files:**
- Create: `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx`
- Create: `apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`
- Create: `apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx`
- Create: `apps/electron/src/renderer/lib/right-workspace-split.test.ts`
- Modify: `apps/electron/src/renderer/atoms/agent-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/agent-atoms.test.ts`
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.tsx`
- Modify: `apps/electron/src/renderer/components/diff/DiffPanelTabBar.tsx`
- Modify: `apps/electron/src/renderer/lib/right-workspace-split.ts`

- [ ] **Step 1: 写动态标签和选择菜单失败测试**

```ts
test('无关联画布时点击画布入口显示选择现有或新建菜单', async () => {
  renderSidePanel({ sessionId: 's1', projectId: 'p1', bindings: [] })
  await user.click(screen.getByRole('button', { name: '画布' }))
  expect(screen.getByRole('menuitem', { name: '新建画布' })).toBeVisible()
  expect(screen.getByRole('menuitem', { name: '首页方案' })).toBeVisible()
})

test('关联画布以 canvas:<id> 标签渲染且后台更新不抢焦点', () => {
  const tabs = buildCanvasWorkspaceTabs(binding, sessions)
  expect(tabs.map((tab) => tab.id)).toContain('canvas:c1')
  expect(markCanvasActivity('files', 'canvas:c1', 4).activeTab).toBe('files')
})
```

覆盖：关闭标签只取消当前 Agent 关联、不删除画布；设置默认；已删除画布显示失效状态并清理关联；双 Pane 的左右 pane 都可承载画布。

同一菜单必须接回此前左侧入口提供的重命名、归档、恢复和不可恢复删除；删除继续使用既有运行中 Agent/生图阻断与确认合同，`legacy-design` 只允许归档和恢复，不提供删除。

- [ ] **Step 2: 运行右侧工作区测试并确认失败**

Run: `bun test apps/electron/src/renderer/atoms/agent-atoms.test.ts apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx apps/electron/src/renderer/lib/right-workspace-split.test.ts`

Expected: FAIL，`AgentSidePanelTab` 尚不接受 `canvas:<id>`，也没有适配器和菜单。

- [ ] **Step 3: 实现动态标签、菜单和适配器**

扩展标签类型并提供严格判别器：

```ts
export type AgentSidePanelTab = AgentSidePanelBaseTab
  | `exploration:${string}`
  | `delegation:${string}`
  | `browser:${string}`
  | `preview:${string}`
  | `terminal:${string}`
  | `canvas:${string}`

export function parseCanvasWorkspaceTab(tab: AgentSidePanelTab): string | null {
  return tab.startsWith('canvas:') ? tab.slice('canvas:'.length) || null : null
}
```

`SidePanel.workspaceTabs` 将关联画布映射为动态标签；`DiffPanelTabBar` 的 `+` 菜单新增“画布”子菜单，复用既有 Radix 菜单和主题变量，不新增弹窗。`CanvasWorkspaceAdapter` 只负责关联状态、错误/空状态和传参：

```tsx
<NativeCanvasWorkspace
  sessionId={sessionId}
  projectId={projectId}
  canvasId={canvasId}
  presentation="side-panel"
/>
```

失效关联先展示“画布已删除”，再异步清理绑定；不能切换 `activeView`。后台 `CANVAS_CHANGED` 只更新标签 activity revision。

- [ ] **Step 4: 接入展开/还原并验证双 Pane 不回退**

使用 `right-workspace-split.ts` 既有 pane 分组和宽度约束；展开画布时隐藏对话主栏但不改变 Agent session、tab identity 或另一 Agent 状态。新增纯函数测试证明展开/还原不会丢失 split tabs，窄窗口只保留当前 pane 而不删除关联。

Run: `bun test apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx apps/electron/src/renderer/lib/right-workspace-split.test.ts apps/electron/src/renderer/atoms/agent-atoms.test.ts`

Expected: PASS，Files、Browser、Terminal、Preview 和双 Pane 既有测试继续通过。

- [ ] **Step 5: 提交右侧工作区入口**

```bash
git add apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx apps/electron/src/renderer/atoms/agent-atoms.ts apps/electron/src/renderer/atoms/agent-atoms.test.ts apps/electron/src/renderer/components/agent/SidePanel.tsx apps/electron/src/renderer/components/diff/DiffPanelTabBar.tsx apps/electron/src/renderer/lib/right-workspace-split.ts apps/electron/src/renderer/lib/right-workspace-split.test.ts
git commit -m "功能：将画布接入 Agent 右侧工作区"
```

### Task 6: 在对话输入区建立节点引用交互

**Files:**
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeCard.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasToolbar.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/agent/AgentView.tsx`
- Create: `apps/electron/src/renderer/components/agent/AgentView.canvas-reference.test.tsx`
- Modify: `apps/electron/src/renderer/components/ai-elements/rich-text-input.tsx`
- Modify: `apps/electron/src/renderer/components/ai-elements/message.tsx`
- Modify: `apps/electron/src/renderer/lib/agent-message-queue.ts`
- Modify: `apps/electron/src/renderer/lib/agent-message-queue.test.ts`

- [ ] **Step 1: 写单选、多选、去重和队列失败测试**

```ts
test('引用选中节点时按画布和节点 ID 去重并保留输入正文', async () => {
  const references = addCanvasNodeReferences([referenceA], [referenceA, referenceB])
  expect(references).toEqual([referenceA, referenceB])
  expect(editor.getText()).toBe('基于这些页面继续设计')
})

test('排队消息保留结构化画布引用', () => {
  expect(buildQueuedMessageSendPayload({
    text: '继续', files: [], mentions: [], canvasNodeReferences: [referenceA],
  }).canvasNodeReferences).toEqual([referenceA])
})
```

覆盖：单节点菜单“引用到对话”、多选工具栏“引用选中节点”、发送前移除、节点类型/标题/所属画布 chip、切换 Agent 后引用不串会话、发送失败保留输入和引用。

- [ ] **Step 2: 运行 Renderer 引用测试并确认失败**

Run: `bun test apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/agent/AgentView.canvas-reference.test.tsx apps/electron/src/renderer/lib/agent-message-queue.test.ts`

Expected: FAIL，输入状态和队列尚无 `canvasNodeReferences`。

- [ ] **Step 3: 实现 Renderer 引用状态和展示**

节点引用由当前 AgentView 的 composer state 持有，不写入共享画布 atom。`CanvasNodeCard` 和 `NativeCanvasToolbar` 通过明确 callback 把引用交给当前 Agent，不模拟点击输入框：

```ts
export interface AddCanvasReferencesInput {
  sessionId: string
  references: CanvasNodeReference[]
}
```

`AgentView` 在输入框上方渲染可移除 chip，发送和 after-current 队列都携带相同数组。`message.tsx` 读取 `SDKUserMessage._canvasNodeReferences` 展示历史 chip，不把它伪装为 `file` mention；`rich-text-input.tsx` 只负责 composer 上方 accessory slot，不扩展现有文件 mention 协议。

- [ ] **Step 4: 运行引用 UI 测试并确认通过**

Run: `bun test apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/agent/AgentView.canvas-reference.test.tsx apps/electron/src/renderer/lib/agent-message-queue.test.ts`

Expected: PASS，普通无引用消息 payload 保持原样。

- [ ] **Step 5: 提交节点引用交互**

```bash
git add apps/electron/src/renderer/components/design/CanvasNodeCard.tsx apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/NativeCanvasToolbar.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/agent/AgentView.tsx apps/electron/src/renderer/components/agent/AgentView.canvas-reference.test.tsx apps/electron/src/renderer/components/ai-elements/rich-text-input.tsx apps/electron/src/renderer/components/ai-elements/message.tsx apps/electron/src/renderer/lib/agent-message-queue.ts apps/electron/src/renderer/lib/agent-message-queue.test.ts
git commit -m "功能：支持画布节点引用到 Agent 对话"
```

### Task 7: 主进程验证并持久化真实节点引用

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-node-reference-resolver.ts`
- Create: `apps/electron/src/main/lib/design/canvas-node-reference-resolver.test.ts`
- Modify: `apps/electron/src/main/lib/agent-service.ts`
- Modify: `apps/electron/src/main/lib/agent-service.test.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.test.ts`
- Modify: `apps/electron/src/main/lib/agent-session-context-prompt.ts`
- Modify: `apps/electron/src/main/lib/agent-session-context-prompt.test.ts`

- [ ] **Step 1: 写发送时复核和历史固定失败测试**

```ts
test('节点选中后更新时，发送使用最新 revision 并持久化实际版本', async () => {
  documentStore.load.mockReturnValue(snapshotAtRevision4)
  const result = await resolver.resolveForSend({
    session, references: [{ ...referenceAtRevision3, nodeRevision: 3 }],
  })
  expect(result.references[0].nodeRevision).toBe(4)
  expect(result.changedNodeIds).toEqual(['node-1'])
})

test('节点已删除时阻止发送且不丢失 Renderer 输入', async () => {
  documentStore.load.mockReturnValue(snapshotWithoutNode)
  await expect(resolver.resolveForSend({ session, references: [reference] }))
    .rejects.toMatchObject({ code: 'CANVAS_REFERENCE_INVALID' })
  expect(orchestrator.run).not.toHaveBeenCalled()
})
```

覆盖：跨项目、未关联画布、内部 Canvas Agent、类型变化、历史精确 revision 已回收、同节点重复引用和队列延迟发送复核。

- [ ] **Step 2: 运行主进程引用测试并确认失败**

Run: `bun test apps/electron/src/main/lib/design/canvas-node-reference-resolver.test.ts apps/electron/src/main/lib/agent-service.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/agent-session-context-prompt.test.ts`

Expected: FAIL，发送链路尚未解析引用或写入 `_canvasNodeReferences`。

- [ ] **Step 3: 实现解析器、消息持久化和轻量 prompt**

解析器只允许默认画布、已关联画布和本轮显式完成关联的画布；通过 CanvasDocumentStore 权威 LOAD 查节点，并返回真实版本和最小摘要：

```ts
export interface ResolvedCanvasNodeReferences {
  references: CanvasNodeReference[]
  changedNodeIds: string[]
  promptSummary: string
}

export interface CanvasNodeReferenceResolver {
  resolveForSend(input: {
    session: AgentSessionMeta
    references: CanvasNodeReference[]
  }): Promise<ResolvedCanvasNodeReferences>
}
```

`agent-service.ts` 在 send、queue-now、deferred queue 真正启动时调用解析器。`agent-orchestrator.persistUserMessage()` 接收已解析引用并写入 `_canvasNodeReferences`；`queueMessage()` 同样写实际 revision。系统 prompt 只描述已关联画布标题、活动画布和本轮引用摘要，不包含整图或节点全文，并明确“你已经在当前 Agent 的画布工作区内，不得要求用户另建或切换画布”。

- [ ] **Step 4: 运行主进程引用测试并确认通过**

Run: `bun test apps/electron/src/main/lib/design/canvas-node-reference-resolver.test.ts apps/electron/src/main/lib/agent-service.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/agent-session-context-prompt.test.ts`

Expected: PASS，失败时不启动 Agent，成功 JSONL 固定真实 revision，普通消息不增加 prompt 噪声。

- [ ] **Step 5: 提交引用解析链路**

```bash
git add apps/electron/src/main/lib/design/canvas-node-reference-resolver.ts apps/electron/src/main/lib/design/canvas-node-reference-resolver.test.ts apps/electron/src/main/lib/agent-service.ts apps/electron/src/main/lib/agent-service.test.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/agent-session-context-prompt.ts apps/electron/src/main/lib/agent-session-context-prompt.test.ts
git commit -m "功能：验证并持久化画布节点引用"
```

### Task 8: 建立多节点与连线的原子批量事务

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-agent-batch-operation.ts`
- Create: `apps/electron/src/main/lib/design/canvas-agent-batch-operation.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-store.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-store.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-agent-node-creation.ts`

- [ ] **Step 1: 写全有或全无和恢复失败测试**

```ts
test('三个节点和两条边只提交一次 revision', async () => {
  const result = await service.apply({
    ...target,
    baseRevision: 7,
    operations: [createHome, createDiscover, createProfile, edgeA, edgeB],
    sourceSessionId: 's1', sourceRunStartedAt: 10, sourceToolCallId: 'tool-1',
  })
  expect(result.document.revision).toBe(8)
  expect(result.document.nodes).toHaveLength(3)
  expect(result.document.edges).toHaveLength(2)
  expect(documentStore.mutate).toHaveBeenCalledTimes(1)
})

test('第二个内容目录准备失败时不提交节点或边', async () => {
  prepareContent.mockResolvedValueOnce(preparedA).mockRejectedValueOnce(new Error('prepare failed'))
  await expect(service.apply(batch)).rejects.toThrow('prepare failed')
  expect(documentStore.mutate).not.toHaveBeenCalled()
  expect(cleanupPrepared).toHaveBeenCalledWith(preparedA)
})
```

覆盖：基础 revision 冲突、Agent session 预分配、删除运行中节点阻断、rename 后耐久性不确定的恢复、重复 `sourceToolCallId` 幂等、提交后 Renderer 事件丢失的 LOAD 对账。

- [ ] **Step 2: 运行批量事务测试并确认失败**

Run: `bun test apps/electron/src/main/lib/design/canvas-agent-batch-operation.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts`

Expected: FAIL，当前生命周期只能逐节点提交，无法保证单 revision。

- [ ] **Step 3: 实现 prepare/commit/finalize 事务**

批量服务在目标 Canvas 的 `transactions` 中记录 `canvas-batch-<UUID>.json`：

```ts
interface CanvasBatchIntent {
  version: 1
  operationId: string
  target: CanvasTarget
  baseRevision: number
  source: { sessionId: string; runStartedAt: number; toolCallId: string }
  state: 'prepared' | 'resources-created' | 'committed'
  preparedResources: Array<{
    nodeId: string
    kind: 'agent-session' | 'content-directory'
    resourceId: string
  }>
  operations: CanvasMutation[]
}
```

流程固定为：验证完整 batch 与访问边界 -> 写 prepared intent -> 创建/复用内容目录和内部 Agent session -> 写 resources-created -> 调用 `CanvasDocumentStore.mutate` 一次提交全部 mutation -> 写 committed。提交前失败清理已准备资源；提交事实可见但 durability 不确定时不回滚，交由 LOAD 对账 intent。复用现有 stable-directory helper、workspace lease、按 Canvas 串行器和公开错误信封。

- [ ] **Step 4: 运行批量事务与现有生命周期回归**

Run: `bun test apps/electron/src/main/lib/design/canvas-agent-batch-operation.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts`

Expected: PASS，单节点既有事务语义不变，批量失败不留下半完成图。

- [ ] **Step 5: 提交批量事务**

```bash
git add apps/electron/src/main/lib/design/canvas-agent-batch-operation.ts apps/electron/src/main/lib/design/canvas-agent-batch-operation.test.ts apps/electron/src/main/lib/design/canvas-document-store.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.ts
git commit -m "功能：支持画布节点与连线原子批量提交"
```

### Task 9: 向普通 Pi Agent 注入受控画布工具

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-tool-provider.ts`
- Create: `apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`
- Modify: `apps/electron/src/main/lib/agent-run-extensions.ts`
- Modify: `apps/electron/src/main/lib/agent-service.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`

- [ ] **Step 1: 写工具授权、语义边界和冲突重试失败测试**

```ts
test('普通分析只能读取引用节点，不自动创建画布或执行任务', async () => {
  const run = await provider.createRunExtensions({
    session, userMessage: '分析一下这个首页', references: [homeReference],
  })
  expect(toolNames(run.piCustomTools)).toEqual([
    'canvas_get_context', 'canvas_manage', 'canvas_read', 'canvas_apply_changes', 'canvas_run_nodes',
  ])
  await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'c1', nodeIds: ['home'] })
  expect(bindingStore.link).not.toHaveBeenCalled()
  expect(runNodes).not.toHaveBeenCalled()
})

test('批量写冲突只允许重新读取后自动重试一次', async () => {
  applyBatch.mockRejectedValueOnce(revisionConflict).mockRejectedValueOnce(revisionConflict)
  await expect(executeApplyChanges()).rejects.toMatchObject({ code: 'CANVAS_REVISION_CONFLICT' })
  expect(readContext).toHaveBeenCalledTimes(1)
  expect(applyBatch).toHaveBeenCalledTimes(2)
})
```

覆盖：禁止扫描并关联全部项目画布、模糊删除拒绝、明确删除允许、规划仅创建 idle 节点、明确生成才调用 `canvas_run_nodes`、跨项目 fail closed、工具结果携带 revision 和 task identity。

- [ ] **Step 2: 运行工具测试并确认失败**

Run: `bun test apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts`

Expected: FAIL，普通 Agent 尚无画布工具 provider。

- [ ] **Step 3: 实现五个工具与单轮扩展**

```ts
export interface CanvasToolRunContext {
  projectId: string
  sessionId: string
  runStartedAt: number
  explicitReferences: CanvasNodeReference[]
  userIntent: 'discuss' | 'plan' | 'execute'
}

export interface CanvasToolProviderResult {
  systemPromptAppend: string
  piCustomTools: ToolDefinition[]
}

export class CanvasToolProvider {
  createRunExtensions(context: CanvasToolRunContext): CanvasToolProviderResult
}
```

- `canvas_get_context`：只返回默认、已关联、活动画布和选中/引用摘要。
- `canvas_manage`：创建、关联、取消关联、设默认；扩大访问集合必须来自明确任务或用户选择。
- `canvas_read`：按 ID 读取正文和必要邻接关系，限制节点数和总字符。
- `canvas_apply_changes`：调用 Task 8 批量服务；删除/覆盖要求工具参数包含 `destructiveIntent: 'explicit'`。
- `canvas_run_nodes`：仅在 `userIntent === 'execute'` 时调用现有生图/HTML 执行器，未来视频类型返回稳定“不支持”能力结果。

Provider 由 `agent-service.ts` 在引用验证后构造，经 `AgentRunExtensions` 合并到 `systemPromptAppend` 和 `piCustomTools`；不修改 `adapters/pi-builtin-tools.ts`。系统提示明确用语义选择工具，不基于“首页”“设计”等固定关键词硬编码页面类型。

- [ ] **Step 4: 运行工具、Agent 和 Design 回归**

Run: `bun test apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/agent-service.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

Expected: PASS，Design 内部 Agent 仍使用自身工具集合，普通 Chat/无项目 Agent 不获得画布访问。

- [ ] **Step 5: 提交画布工具提供器**

```bash
git add apps/electron/src/main/lib/design/canvas-tool-provider.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/agent-run-extensions.ts apps/electron/src/main/lib/agent-service.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts
git commit -m "功能：允许普通 Agent 受控操作画布"
```

### Task 10: 完成活动提示、自动绑定和生命周期对账

**Files:**
- Modify: `apps/electron/src/main/lib/design/agent-canvas-binding-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-session-ipc.ts`
- Modify: `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts`
- Modify: `apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts`
- Modify: `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx`

- [ ] **Step 1: 写后台更新、删除清理和自动默认画布失败测试**

```ts
test('后台 Agent 修改共享画布时只标记活动，不切换前台标签', () => {
  const next = reduceCanvasActivity(stateWithFilesActive, {
    projectId: 'p1', canvasId: 'c1', revision: 9, sourceSessionId: 's2',
  })
  expect(next.activeTab).toBe('files')
  expect(next.activityByTab.get('canvas:c1')).toBe(9)
})

test('明确执行且无默认画布时创建并绑定一次', async () => {
  await runExecuteRequest()
  expect(canvasSessionStore.create).toHaveBeenCalledTimes(1)
  expect(bindingStore.link).toHaveBeenCalledWith(expect.objectContaining({ makeDefault: true }))
})
```

覆盖：普通讨论不创建、删除 Agent 保留画布、删除画布清理所有绑定、运行中 Agent/生图阻止删除、项目授权撤销后拒绝工具调用。

- [ ] **Step 2: 运行生命周期测试并确认失败**

Run: `bun test apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/main/lib/design/agent-canvas-binding-ipc.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`

Expected: FAIL，事件仍依赖全局 `activeCanvasSelectionAtom` 或未清理绑定。

- [ ] **Step 3: 实现来源事件和生命周期清理**

Canvas graph 变化事件增加可选、公开且不含 prompt 的来源：

```ts
interface CanvasChangeSource {
  sessionId: string
  runStartedAt: number
  toolCallId: string
}
```

Renderer 按所有已关联当前 `canvasId` 的 Agent 更新 activity revision，仅当前打开相同 Canvas 时对账 snapshot；不调用 `onTabChange`。`canvas_manage` 在 `execute` 且无默认画布时创建一次默认画布并立即绑定；重复 tool call 通过 `sourceToolCallId` 幂等。Canvas 删除成功后清理全部绑定并保留历史 `_canvasNodeReferences`；Agent 删除只清理当前 session binding 与 view state。

- [ ] **Step 4: 运行生命周期测试并确认通过**

Run: `bun test apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/main/lib/design/agent-canvas-binding-ipc.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`

Expected: PASS，后台更新不抢焦点、删除与自动绑定符合产品边界。

- [ ] **Step 5: 提交生命周期对账**

```bash
git add apps/electron/src/main/lib/design/agent-canvas-binding-ipc.ts apps/electron/src/main/lib/design/canvas-tool-provider.ts apps/electron/src/main/lib/design/canvas-session-ipc.ts apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx
git commit -m "功能：完善画布活动提示与关联生命周期"
```

### Task 11: 移除独立画布入口并完成迁移回归

**Files:**
- Modify: `apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`
- Modify: `apps/electron/src/renderer/components/tabs/TabBar.tsx`
- Modify: `apps/electron/src/renderer/components/tabs/MainArea.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- Modify: `apps/electron/src/renderer/hooks/useOpenSession.ts`
- Modify: `apps/electron/src/renderer/hooks/useOpenSession.test.tsx`
- Modify: `apps/electron/src/renderer/atoms/canvas-session-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/canvas-session-atoms.test.ts`
- Delete: `apps/electron/src/renderer/components/design/CanvasSessionTab.tsx`
- Delete: `apps/electron/src/renderer/components/design/CanvasSessionTab.test.tsx`
- Delete: `apps/electron/src/renderer/components/design/CanvasSessionItem.tsx`
- Delete: `apps/electron/src/renderer/components/design/CanvasSessionItem.test.tsx`
- Delete: `apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.tsx`
- Delete: `apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.test.tsx`
- Delete: `apps/electron/src/renderer/components/app-shell/design-layout.ts`
- Delete: `apps/electron/src/renderer/components/app-shell/design-layout.test.ts`

- [ ] **Step 1: 先把旧入口测试改成新迁移断言**

在删除组件前增加源码/渲染回归，固定以下结果：

```ts
test('普通导航不再切换独立 design 主视图', () => {
  const source = readFileSync(join(rendererRoot, 'components/tabs/MainArea.tsx'), 'utf8')
  expect(source).not.toContain("activeView === 'design'")
})

test('左侧只展示普通 Agent，会话画布通过右侧入口访问', () => {
  renderLeftSidebar({ agents, canvases: [canvas] })
  expect(screen.queryByText(canvas.title)).not.toBeInTheDocument()
  expect(screen.getByText(agents[0].title)).toBeVisible()
})
```

迁移测试必须证明：旧 `legacy-design` 与原生 Canvas 仍能通过右侧菜单选择；Canvas Store、素材和节点 ID 未被复制或改写。

- [ ] **Step 2: 运行迁移测试并确认旧入口导致失败**

Run: `bun test apps/electron/src/renderer/components/app-shell/LeftSidebar.canvas-archive.test.ts apps/electron/src/renderer/hooks/useOpenSession.test.tsx apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`

Expected: FAIL，左侧、顶部标签或 `MainArea` 仍渲染独立画布入口。

- [ ] **Step 3: 删除旧导航分支和只服务旧入口的状态**

移除：

- `LeftSidebar` 的 Canvas 列表、归档分组、创建/选择/重命名/删除 UI；对应操作已迁入右侧画布菜单。
- `TabBar` 的 `CanvasSessionTab` 和 `shouldShowCanvasTab`。
- `MainArea` 的 `activeView === 'design'` 分支。
- `AppShell` 的 Design 专用右栏模式。
- 普通 Agent 打开时对 `activeCanvasSelectionAtom` 的全局清理。

`canvas-session-atoms.ts` 只保留右侧菜单需要的项目 Canvas registry，不再保留全局 active selection。保留 Canvas session 主进程 Store、IPC、归档和 `legacy-design` 兼容数据能力。

- [ ] **Step 4: 运行全量自动验证**

Run: `bun test packages/shared/src/types/canvas.test.ts packages/shared/src/types/agent.test.ts apps/electron/src/main/lib/design/agent-canvas-binding-store.test.ts apps/electron/src/main/lib/design/agent-canvas-binding-ipc.test.ts apps/electron/src/main/lib/design/canvas-node-reference-resolver.test.ts apps/electron/src/main/lib/design/canvas-agent-batch-operation.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/atoms/agent-canvas-atoms.test.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/CanvasWorkspaceAdapter.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx apps/electron/src/renderer/components/agent/AgentView.canvas-reference.test.tsx apps/electron/src/renderer/components/diff/DiffPanelTabBar.canvas.test.tsx apps/electron/src/renderer/lib/right-workspace-split.test.ts apps/electron/src/renderer/lib/agent-message-queue.test.ts`

Expected: PASS。

Run: `bun run typecheck`

Expected: PASS，无 TypeScript 错误。

Run: `bun run build`

Expected: PASS，Renderer 与共享包构建成功。

Run: `bun run electron:build`

Expected: PASS，Electron 主进程、Preload 和 Renderer 产物均成功。

- [ ] **Step 5: 启动真实客户端并按业务链路手测**

Run: `bun run dev`

Expected: Electron 开发客户端正常启动，无主进程 IPC 注册错误。依次验证：

1. 新 Agent 右侧“画布”菜单可选择现有或新建，左侧无画布会话。
2. 两个 Agent 关联同一画布，节点和连线同步，viewport、选区和详情尺寸独立。
3. 引用首页 WebView 节点后发送“基于这个首页规划发现和我的页面”，Agent 一次批量创建两个待执行节点和两条关联线，不调用付费生成。
4. 发送“生成这两个页面”后才运行相应节点；失败保留节点、配置、错误和重试入口。
5. 后台 Agent 更新画布时当前 Files/Browser 标签不被切走，画布标签显示活动。
6. 删除 Agent 后共享画布仍存在；删除画布后所有关联清理、历史引用显示失效。
7. 宽窄窗口、深浅主题、键盘、多选引用、双 Pane、画布展开与还原均可用。

- [ ] **Step 6: 检查差异并提交迁移收口**

Run: `git diff --check`

Expected: 无空白错误。

```bash
git add apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx apps/electron/src/renderer/components/tabs/TabBar.tsx apps/electron/src/renderer/components/tabs/MainArea.tsx apps/electron/src/renderer/components/app-shell/AppShell.tsx apps/electron/src/renderer/hooks/useOpenSession.ts apps/electron/src/renderer/hooks/useOpenSession.test.tsx apps/electron/src/renderer/atoms/canvas-session-atoms.ts apps/electron/src/renderer/atoms/canvas-session-atoms.test.ts apps/electron/src/renderer/components/design/CanvasSessionTab.tsx apps/electron/src/renderer/components/design/CanvasSessionTab.test.tsx apps/electron/src/renderer/components/design/CanvasSessionItem.tsx apps/electron/src/renderer/components/design/CanvasSessionItem.test.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.test.tsx apps/electron/src/renderer/components/app-shell/design-layout.ts apps/electron/src/renderer/components/app-shell/design-layout.test.ts
git commit -m "重构：完成 Agent 画布工作区迁移"
```

## 最终验收门槛

- 自动化验证全部通过后才能删除旧入口；任何右侧 Files/Browser/Terminal/Preview 或双 Pane 回归都阻止迁移提交。
- 同一画布在两个 Agent 中只能存在一份项目图事实；测试不得通过复制 snapshot 规避共享。
- 任何批量操作失败都不能留下用户可见半成品；提交已可见但 durability 不确定时必须由 LOAD 对账，不能回滚事实。
- 任何付费执行都必须有明确 execute 意图；自动创建默认画布不等于自动生图。
- Renderer 不接触未清洗主进程错误、凭据、绝对路径或内部 Agent 会话。
- `git status --short` 仅包含本计划相关文件；不提交既有未跟踪 `.superpowers/`。
