# Native Canvas Agent Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让原生 Canvas 拥有独立、可恢复的图文档，并支持创建多个真实 Pi Agent 节点，在 Canvas 内打开和继续各自对话，同时不进入普通 Agent 会话入口。

**Architecture:** 新建独立 `CanvasDocument` 合同与 `CanvasDocumentStore`，以 `projectId + canvasId` 解析 `.proma/design/canvases/<canvasId>/canvas.json`，不回退 legacy Design。Canvas 文档只保存节点、连线和 Agent 会话引用；真实消息仍由 Pi session JSONL 保存。Canvas Agent 使用完整归属元数据隐藏于普通会话消费者，通过 Canvas IPC 验证 `projectId + canvasId + nodeId + sessionId` 后复用现有 Agent runtime。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Jotai、XYFlow、Pi Agent Runtime、safe-file

---

## 范围边界

- 本阶段交付：原生 Canvas 文档加载/保存/恢复、Agent 节点创建和移动、画布内对话面板、Canvas Agent 真实流式运行。
- 本阶段不交付：生图模块执行、视觉文档编辑器、WebView 原型运行、Agent 自动编排工具、连线编辑、连线数据传播和 stale 传播。
- 节点协议会预留四种稳定 `kind`，但只有 `agent` 节点允许在本阶段创建；其余类型的持久化记录必须被 schema 接受，Renderer 仅显示“当前版本暂不支持”。
- 节点删除只移除 Canvas 引用，不删除 Pi 会话；会话清理由后续 Canvas 删除事务统一处理，避免误删仍需追溯的对话。
- 连线在本阶段只接受和显示已有持久化记录，不允许创建或删除，也不触发消息共享、任务执行或上下文传播；“连线才有关联”的执行语义在后续模块编排阶段实现。
- Canvas Agent 首版只开放 `Read`、`Glob`、`Grep` 三种只读项目理解工具；禁止写文件、Shell、浏览器、图片工具、Collaboration、AskUserQuestion 和计划审批。需要澄清时 Agent 直接输出普通文本问题，避免隐藏子会话、全局审批和“设计请求直接修改代码”。

## 文件职责

- `packages/shared/src/types/canvas.ts`：Canvas 图文档、节点、边、mutation、Agent 归属和 IPC 输入输出。
- `packages/shared/src/types/index.ts`：导出 Canvas 合同。
- `apps/electron/src/main/lib/design/canvas-document-store.ts`：native Canvas 的严格 schema、恢复链、revision 和原子写入。
- `apps/electron/src/main/lib/design/canvas-document-ipc.ts`：授权窗口、registry 归属、项目 guard、文档和 Agent 节点 IPC。
- `apps/electron/src/main/lib/design/canvas-agent-node-creation.ts`：可恢复的 Agent 节点创建 intent、两阶段提交和幂等重放。
- `apps/electron/src/main/lib/agent-session-visibility.ts`：普通会话、Design 内部会话、Canvas Agent 会话三类可见性。
- `apps/electron/src/main/lib/agent-session-manager.ts`：原子创建带 Canvas 完整归属的 Pi 会话。
- `apps/electron/src/preload/design-preload.ts`：暴露最小 Canvas 文档与 Agent API。
- `apps/electron/src/renderer/lib/design-adapter.ts`：Renderer 的 Canvas API 适配器。
- `apps/electron/src/renderer/atoms/native-canvas-atoms.ts`：按 `projectId:canvasId` 隔离快照、选区、保存和对话面板状态。
- `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`：加载、自动保存和错误恢复控制器。
- `apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx`：XYFlow 图、节点移动和选择。
- `apps/electron/src/renderer/components/design/CanvasAgentNode.tsx`：紧凑 Agent 节点。
- `apps/electron/src/renderer/components/design/CanvasAgentConversation.tsx`：画布内真实 Agent 消息与输入。
- `apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.tsx`：native 分支挂载真实工作区。

### Task 1: 定义独立 Canvas 图合同

**Files:**
- Create: `packages/shared/src/types/canvas.ts`
- Create: `packages/shared/src/types/canvas.test.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: 写失败测试**

覆盖空文档身份、四种节点 discriminated union、Agent 节点引用互斥、边端口和 mutation reducer。

```ts
test('Given 原生 Canvas When 创建空文档 Then 同时固化项目与 Canvas 身份', () => {
  expect(createEmptyCanvasDocument('project-1', 'canvas-1', 100)).toMatchObject({
    schemaVersion: 1,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    revision: 0,
    nodes: [],
    edges: [],
  })
})

test('Given Agent 节点 When 应用 upsert Then 文档只保存会话引用而不保存消息', () => {
  const next = applyCanvasMutations(createEmptyCanvasDocument('p', 'c', 1), [{
    type: 'upsert-nodes',
    nodes: [createAgentNode('node-1', 'session-1')],
  }])
  expect(next.nodes[0]).toMatchObject({ kind: 'agent', agentSessionId: 'session-1' })
  expect(next.nodes[0]).not.toHaveProperty('messages')
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test packages/shared/src/types/canvas.test.ts`

Expected: FAIL，`canvas.ts` 尚不存在。

- [ ] **Step 3: 实现最小共享合同**

```ts
export const CANVAS_DOCUMENT_VERSION = 1

export type CanvasNode = CanvasAgentNode | CanvasImageNode | CanvasVisualDocumentNode | CanvasWebviewNode

export interface CanvasAgentNode extends CanvasNodeBase {
  kind: 'agent'
  agentSessionId: string
  title: string
}

export interface CanvasDocument {
  schemaVersion: typeof CANVAS_DOCUMENT_VERSION
  projectId: string
  canvasId: string
  revision: number
  viewport: DesignViewport
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  createdAt: number
  updatedAt: number
}

export type CanvasMutation =
  | { type: 'set-viewport'; viewport: DesignViewport }
  | { type: 'move-nodes'; positions: Array<{ nodeId: string; position: DesignPoint }> }
  | { type: 'upsert-nodes'; nodes: CanvasNode[] }
  | { type: 'remove-nodes'; nodeIds: string[] }
  | { type: 'upsert-edges'; edges: CanvasEdge[] }
  | { type: 'remove-edges'; edgeIds: string[] }
```

`applyCanvasMutations()` 必须：

- 保持未修改实体顺序；
- 删除节点时同步删除相连边；
- 拒绝重复 ID 留给 store schema 校验；
- 不修改 revision，revision 只由主进程 store 推进。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test packages/shared/src/types/canvas.test.ts`

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts packages/shared/src/types/index.ts
git commit -m "设计：定义原生 Canvas 图合同"
```

### Task 2: 建立 native Canvas 文档 Store

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-document-store.ts`
- Create: `apps/electron/src/main/lib/design/canvas-document-store.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-session-store.ts`

- [ ] **Step 1: 写失败测试**

覆盖：native 缺文件返回空文档；保存只写 `resolveCanvas().documentPath`；不读取 legacy；tmp/bak 恢复；revision 冲突；未知/跨项目/legacy ID 拒绝；1000 节点 mutation 只执行一次 schema 校验链和一次 safe-file 原子写。

```ts
test('Given legacy 文件存在且 native 文件缺失 When 加载 native Then 返回独立空文档', () => {
  writeFileSync(legacyPath, JSON.stringify(createEmptyDesignDocument('project-1', 1)))
  const snapshot = store.load({ projectId: 'project-1', canvasId: 'canvas-1' })
  expect(snapshot.document.canvasId).toBe('canvas-1')
  expect(snapshot.document.nodes).toEqual([])
})

test('Given Canvas 属于另一个项目 When 加载 Then 在文件访问前拒绝', () => {
  expect(() => store.load({ projectId: 'project-b', canvasId: 'canvas-a' }))
    .toThrow('Canvas 会话不存在')
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-store.test.ts`

- [ ] **Step 3: 实现 Store**

Store 接口固定为：

```ts
export interface CanvasDocumentStore {
  load: (target: CanvasTarget) => CanvasWorkspaceSnapshot
  requireStableAuthoritativeDocument: (target: CanvasTarget) => CanvasDocument
  mutate: (
    target: CanvasTarget,
    expectedRevision: number,
    mutations: CanvasMutation[],
    validateCurrent?: (document: CanvasDocument) => void,
  ) => CanvasDocument
}
```

实现要求：

- 先由 `CanvasSessionStore.requireNative(projectId, canvasId)` 验证 registry 归属且拒绝 `legacy-design`；
- 只用 `designPathResolver.resolveCanvas()` 解析路径；
- 主、`.tmp`、`.bak` 候选均使用 `O_NOFOLLOW` 和目录身份复验；
- 写入统一使用 `writeJsonFileAtomicSecure`；
- 路径父目录必须精确等于 `canvasRoot`；
- mutation 保存前重新加载权威 revision；
- 节点、边、端口和引用 schema 全量校验。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-store.test.ts apps/electron/src/main/lib/design/canvas-session-store.test.ts`

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/main/lib/design/canvas-document-store.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts apps/electron/src/main/lib/design/canvas-session-store.ts
git commit -m "设计：持久化原生 Canvas 图文档"
```

### Task 3: 接通 Canvas 文档四层 IPC

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Create: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Create: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/design-preload.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写失败测试**

验证授权 sender、exact-key 输入、只读项目、workspace guard、load/save、普通变更与恢复变更广播、dispose 和跨 Canvas 事件隔离。

```ts
await handlers.get(CANVAS_IPC_CHANNELS.SAVE_MUTATIONS)?.(authorizedEvent, {
  projectId: 'project-1',
  canvasId: 'canvas-1',
  expectedRevision: 0,
  mutations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
})
expect(sent).toContainEqual([
  CANVAS_IPC_CHANNELS.CHANGED,
  { projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'graph' },
])
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 3: 实现 IPC 与 bridge**

新增固定通道：

```ts
export const CANVAS_IPC_CHANNELS = {
  LOAD: 'canvas:load',
  SAVE_MUTATIONS: 'canvas:save-mutations',
  CHANGED: 'canvas:changed',
} as const
```

LOAD 和 SAVE 必须校验主窗口、registry 归属和项目只读状态。Renderer 只能得到结构化文档、公开会话元数据和错误，不得得到文件路径或内部 storage kind。

恢复协议必须保持现有 Design 安全语义：

- LOAD 提升 `.tmp`/`.bak` 时返回 `recoveredFrom` 并广播 `{ cause: 'recovery' }`；
- 普通 graph 事件遵守 revision 单调规则，recovery 事件无条件使旧基线失效，即使恢复 revision 更低；
- 事件始终携带 `projectId + canvasId`，禁止一个 Canvas 的恢复污染另一个 Canvas。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/types/canvas.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "设计：接通原生 Canvas 图文档"
```

### Task 4: 渲染原生 Canvas 与 Agent 节点

**Files:**
- Create: `apps/electron/src/renderer/atoms/native-canvas-atoms.ts`
- Create: `apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts`
- Create: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Create: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`
- Create: `apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx`
- Create: `apps/electron/src/renderer/components/design/native-canvas-model.ts`
- Create: `apps/electron/src/renderer/components/design/native-canvas-model.test.ts`
- Create: `apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasAgentNode.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasAgentNode.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.test.tsx`

- [ ] **Step 1: 写失败测试**

覆盖：状态按 `projectId:canvasId` 隔离；切换不复用 pending；Agent 节点转换；拖动结束只产生一次 mutation；recovery 接管低 revision；旧 LOAD/SAVE 回调无副作用；位置 mutation 可重放、结构 mutation 阻断；native 入口挂载真实工作区；1000 节点投影不读取 JSONL且启用 XYFlow 可见节点渲染。

```ts
test('Given 两个 Canvas When A 保存失败 Then B 不继承 pending 和错误', () => {
  const store = createStore()
  store.set(updateNativeCanvasStateAtom, { key: 'p:a', update: { saveState: 'failed' } })
  expect(store.get(nativeCanvasStatesAtom).get('p:b')).toBeUndefined()
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx apps/electron/src/renderer/components/design/CanvasAgentNode.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 3: 实现 Renderer**

- `NativeCanvasWorkspace` mount 后按双重身份 LOAD；400ms 压缩视口 mutation 并自动保存；LOAD 与 SAVE 使用独立 generation，Canvas 切换或 recovery 后旧回调完全无副作用，在途 batch 必须归还正确 Canvas 的 pending。
- recovery 无条件接管权威快照；位置 mutation 在新基线上重放，任何含结构 mutation 的批次进入显式冲突阻断，不得自动覆盖。
- `NativeCanvasGraph` 使用稳定 `nodeTypes`，只挂载当前 Canvas；节点拖动期间仅更新本地 Flow state，结束时提交 `move-nodes`。
- Agent 节点固定尺寸，首阶段只显示名称和本地状态；消息数量只在打开对话时按需读取，不允许为每个节点扫描 Pi JSONL。
- 已持久化连线只读渲染，不注册连接或删除交互；本阶段不得从连线推导上下文、执行顺序或 stale 状态。
- image/visual-document/webview 暂只渲染受支持但不可创建的类型标签，不触发任何执行器。
- 复用 XYFlow `onlyRenderVisibleElements`；单元性能合同验证 1000 节点只做纯内存投影、不读取 Pi JSONL，并把真实可见 DOM 数量留给 Task 8 的浏览器验收。
- 400ms 保存窗口采用 trailing debounce，连续 viewport 更新只触发一次主进程写入；Store 性能测试以“一批 mutation 只做一次安全原子写”为稳定预算，不使用易波动的绝对毫秒断言。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx apps/electron/src/renderer/components/design/CanvasAgentNode.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.test.tsx`

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/renderer/atoms/native-canvas-atoms.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx apps/electron/src/renderer/components/design/native-canvas-model.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx apps/electron/src/renderer/components/design/CanvasAgentNode.tsx apps/electron/src/renderer/components/design/CanvasAgentNode.test.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.test.tsx
git commit -m "设计：渲染原生 Canvas Agent 节点"
```

### Task 5A: 定义 Canvas Agent 归属与基础可见性

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.test.ts`
- Modify: `apps/electron/src/main/lib/agent-session-visibility.ts`
- Modify: `apps/electron/src/main/lib/agent-session-visibility.test.ts`
- Modify: `apps/electron/src/renderer/lib/agent-session-list.ts`
- Modify: `apps/electron/src/renderer/lib/agent-session-list.test.ts`

- [ ] **Step 1: 写失败测试**

Canvas Agent 元数据必须三字段齐全，Design Job 归属不可混用，任一半归属记录都 fail closed。基础可见性同时覆盖主进程 list/search/archive/count 与 Renderer fetch/upsert/merge。

```ts
expect(() => createAgentSessionWithMetadata({
  workspaceId: 'project-1',
  sourceCanvasProjectId: 'project-1',
  sourceCanvasId: 'canvas-1',
})).toThrow('Canvas Agent 来源字段必须完整提供')

expect(isAgentSessionUserVisible(canvasAgentSession)).toBe(false)
expect(hasValidCanvasAgentOwnership(canvasAgentSession)).toBe(true)
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/lib/agent-session-visibility.test.ts apps/electron/src/renderer/lib/agent-session-list.test.ts`

- [ ] **Step 3: 实现会话边界**

新增完整归属元数据：

```ts
sourceCanvasProjectId?: string
sourceCanvasId?: string
sourceCanvasNodeId?: string
```

- `isAgentSessionUserVisible()` 同时 fail closed 过滤 Design 与 Canvas 任一来源字段。
- `hasValidCanvasAgentOwnership()` 只接受三个非空字段且 `workspaceId === sourceCanvasProjectId`；Canvas 与 Design 来源同时出现时拒绝创建。
- 普通创建入口保持随机 ID 和现有行为，项目删除仍按 `workspaceId` 使用全量索引清理。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/lib/agent-session-visibility.test.ts apps/electron/src/renderer/lib/agent-session-list.test.ts`

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/types/agent.ts apps/electron/src/main/lib/agent-session-manager.ts apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/lib/agent-session-visibility.ts apps/electron/src/main/lib/agent-session-visibility.test.ts apps/electron/src/renderer/lib/agent-session-list.ts apps/electron/src/renderer/lib/agent-session-list.test.ts
git commit -m "设计：定义 Canvas Agent 会话归属"
```

### Task 5B: 封闭普通 Renderer IPC 与会话引用

**Files:**
- Create: `apps/electron/src/main/lib/agent-renderer-session-access.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/main/lib/agent-permission-service.ts`
- Modify: `apps/electron/src/main/lib/agent-permission-service.test.ts`
- Modify: `apps/electron/src/main/lib/agent-ask-user-service.ts`
- Create: `apps/electron/src/main/lib/agent-ask-user-service.test.ts`
- Modify: `apps/electron/src/main/lib/agent-exit-plan-service.ts`
- Create: `apps/electron/src/main/lib/agent-exit-plan-service.test.ts`
- Modify: `apps/electron/src/main/lib/agent-session-context-prompt.ts`
- Create: `apps/electron/src/main/lib/agent-session-context-prompt.test.ts`

- [ ] **Step 1: 写失败测试**

普通 Renderer 会话 IPC 建立访问矩阵回归：所有接收 `sessionId` 的读取、元数据更新、附件、附加目录/文件、工作台路径、队列、浏览器、fork/rewind、权限/AskUser/ExitPlan 响应入口，必须在副作用前经过 `requireUserVisibleAgentSession()`；Canvas 专用 IPC 是唯一例外。构建 `mentionedSessionIds` 上下文时必须再次验证目标会话可见，不能只信任 Renderer 候选列表。

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/agent-renderer-session-access.test.ts apps/electron/src/main/lib/agent-permission-service.test.ts apps/electron/src/main/lib/agent-ask-user-service.test.ts apps/electron/src/main/lib/agent-exit-plan-service.test.ts apps/electron/src/main/lib/agent-session-context-prompt.test.ts`

- [ ] **Step 3: 实现普通入口封口**

- 普通 `AGENT_IPC_CHANNELS` 在任何读写副作用前验证用户可见 session。
- pending permission/AskUser/ExitPlan 服务增加只读 owner 查询；普通响应 IPC 先验证 owner 可见再执行响应，GET_PENDING 只返回普通可见会话的请求。
- `buildReferencedSessionsPrompt()` 对每个目标 session 调用统一 visibility；内部 Canvas/Design session 的消息路径、摘要和内容均不得进入普通 Agent 上下文。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/agent-renderer-session-access.test.ts apps/electron/src/main/lib/agent-permission-service.test.ts apps/electron/src/main/lib/agent-ask-user-service.test.ts apps/electron/src/main/lib/agent-exit-plan-service.test.ts apps/electron/src/main/lib/agent-session-context-prompt.test.ts`

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/main/lib/agent-renderer-session-access.test.ts apps/electron/src/main/ipc.ts apps/electron/src/main/lib/agent-permission-service.ts apps/electron/src/main/lib/agent-permission-service.test.ts apps/electron/src/main/lib/agent-ask-user-service.ts apps/electron/src/main/lib/agent-ask-user-service.test.ts apps/electron/src/main/lib/agent-exit-plan-service.ts apps/electron/src/main/lib/agent-exit-plan-service.test.ts apps/electron/src/main/lib/agent-session-context-prompt.ts apps/electron/src/main/lib/agent-session-context-prompt.test.ts
git commit -m "设计：阻断普通入口访问 Canvas Agent"
```

### Task 5C: 隔离外部渠道与自动协作消费者

**Files:**
- Modify: `apps/electron/src/main/lib/bridge-command-handler.ts`
- Modify: `apps/electron/src/main/lib/feishu-bridge.ts`
- Modify: `apps/electron/src/main/lib/agent-collaboration-tools.ts`
- Modify: `apps/electron/src/main/lib/automation-scheduler.ts`
- Modify: `apps/electron/src/main/lib/automation-scheduler.test.ts`
- Create: `apps/electron/src/main/lib/agent-internal-session-boundaries.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖 Bridge/飞书用户列表与按 ID 操作、Automation 的 `lastSessionId` 复用、Canvas Agent 发起 Collaboration、LAN/mobile、托盘、状态岛、项目记忆与会话引用的排除行为。内部清理和项目删除仍允许使用全量索引。

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/agent-internal-session-boundaries.test.ts apps/electron/src/main/lib/automation-scheduler.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts apps/electron/src/main/lib/tray-menu-model.test.ts apps/electron/src/main/lib/agent-memory-refresh-service.test.ts`

- [ ] **Step 3: 实现外部边界**

- Bridge/飞书的用户会话枚举改用可见会话，按 ID 操作前再次验证可见性。
- Automation 即使持久化 `lastSessionId` 被污染也不得复用内部 session。
- Canvas Agent 调用 Collaboration 工具明确拒绝；本阶段不创建协作子会话。
- LAN/mobile、托盘、状态岛和项目记忆继续通过统一 visibility 函数排除。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/agent-internal-session-boundaries.test.ts apps/electron/src/main/lib/automation-scheduler.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts apps/electron/src/main/lib/tray-menu-model.test.ts apps/electron/src/main/lib/agent-memory-refresh-service.test.ts apps/electron/src/main/lib/agent-island-runtime-status.test.ts`

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/main/lib/bridge-command-handler.ts apps/electron/src/main/lib/feishu-bridge.ts apps/electron/src/main/lib/agent-collaboration-tools.ts apps/electron/src/main/lib/automation-scheduler.ts apps/electron/src/main/lib/automation-scheduler.test.ts apps/electron/src/main/lib/agent-internal-session-boundaries.test.ts
git commit -m "设计：隔离 Canvas Agent 外部消费者"
```

### Task 6: 可恢复地创建 Canvas Agent 节点

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Modify: `apps/electron/src/preload/design-preload.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-paths.ts`
- Modify: `apps/electron/src/main/lib/design/design-paths.test.ts`
- Create: `apps/electron/src/main/lib/design/canvas-agent-node-creation.ts`
- Create: `apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.test.ts`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写失败测试**

覆盖：创建按钮可达、单次点击只创建一个 operation、loading/error/retry、同一 operation 幂等；session 已提交但 document 未提交时重启恢复；`prepared` 后默认渠道/模型变化时仍按 intent 固化配置恢复；document 已提交但响应丢失时重试返回同一节点；文档写成功但 committed intent 写失败且进程继续运行时不得发布节点；节点已删除后旧 operation 不得重建；缺失、半归属或跨 Canvas session 显示损坏并禁止运行；损坏 intent 只阻断所属 Canvas。

```ts
test('Given session 已提交但节点未写入 When 恢复创建 intent Then 复用同一 session 并补写节点', () => {
  const recovered = creationService.recover(target)
  expect(recovered.document.nodes).toContainEqual(expect.objectContaining({
    id: 'node-1',
    agentSessionId: 'session-1',
  }))
  expect(createdSessionIds).toEqual([])
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 3: 实现两阶段创建协议**

本任务新增 `CREATE_AGENT_NODE: 'canvas:create-agent-node'` 并同步 shared、main、preload、adapter 四层。Renderer 为一次用户操作生成稳定 UUID `operationId`，重试必须复用。主进程先按安全单段 ID 规则校验字符、UUID 形态和长度，再在 `canvasRoot/transactions/agent-node-<operationId>.json` 使用 safe-file 保存 creation intent；禁止把未校验输入拼入路径：

```ts
interface CanvasAgentNodeCreationIntent {
  schemaVersion: 1
  operationId: string
  projectId: string
  canvasId: string
  nodeId: string
  sessionId: string
  title: string
  channelId: string
  modelId?: string
  position: DesignPoint
  state: 'prepared' | 'session-created' | 'committed' | 'detached'
  createdAt: number
  updatedAt: number
}
```

同一 workspace write lease 内固定执行：写 `prepared` intent -> 以主进程预分配 ID 创建完整归属 session -> 写 `session-created` -> 在当前权威 revision 上幂等 upsert node -> 写 `committed` -> 发布 graph 事件并返回 `{ document, session }`。所有 journal 和 Canvas 文档写入均使用 secure safe-file 边界。

- `createAgentSessionWithMetadata()` 增加仅供主进程受信任调用的预分配 ID 参数，严格验证格式、长度和冲突；已有同 ID session 只允许完整归属完全一致时幂等复用并补齐会话目录，普通创建入口继续随机 UUID。
- 创建服务是发布屏障：任何 LOAD、SAVE、删除、广播和创建响应都必须先在同一 workspace lease 内完成目标 Canvas 的未决 intent 对账。文档写成功但 `committed` 写失败时不广播、不返回节点；后续入口必须先把同一 intent 提交成功，持续失败则整个目标 Canvas fail closed。用户不可能在 intent committed 前看到或删除该节点。
- 恢复采用目标 Canvas 的惰性对账，不在应用启动时全量扫描所有项目；打开或操作某个 Canvas 时恢复该 Canvas，单个损坏 intent 不阻断其它项目/Canvas 或 IPC 注册。
- `prepared` 已存在 session 时必须先复核完整归属再继续；未知 session、跨项目/Canvas/node、半归属一律 fail closed。
- `committed` intent 对应节点后来缺失时转为 `detached`，永不自动重建；这使“用户删除引用”和“创建崩溃”可区分。
- intent 作为小型事务 tombstone 保留到后续 Canvas 删除事务，不能当可随意清除的 cache。
- Toolbar 增加图标化“添加 Agent”命令；节点创建在视口中心，成功后打开该节点对话，失败保留同一 operationId 供显式重试。
- 创建 operation 首次进入主进程时从当前 Agent 默认配置解析 `channelId/modelId`，先固化到 `prepared` intent，再用于创建 session；恢复禁止重新读取新默认。渠道或模型后来失效时明确 fail closed，不静默换模型；本阶段不提供节点内模型切换。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/types/canvas.ts apps/electron/src/main/lib/design/design-paths.ts apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/ipc.ts apps/electron/src/main/lib/agent-session-manager.ts apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
git commit -m "设计：可恢复地创建 Canvas Agent 节点"
```

### Task 7: 在 Canvas 内运行受控 Agent 对话

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Create: `apps/electron/src/main/lib/design/canvas-agent-run-policy.ts`
- Create: `apps/electron/src/main/lib/design/canvas-agent-run-policy.test.ts`
- Modify: `apps/electron/src/main/lib/agent-service.ts`
- Modify: `apps/electron/src/main/lib/agent-service.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/preload/design-preload.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`
- Modify: `apps/electron/src/renderer/atoms/native-canvas-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts`
- Create: `apps/electron/src/renderer/components/design/CanvasAgentConversation.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx`
- Create: `apps/electron/src/renderer/lib/canvas-agent-event-routing.ts`
- Create: `apps/electron/src/renderer/lib/canvas-agent-event-routing.test.ts`
- Modify: `apps/electron/src/renderer/lib/agent-completion-presence.ts`
- Modify: `apps/electron/src/renderer/lib/agent-completion-presence.test.ts`
- Modify: `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts`
- Create: `apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`

- [ ] **Step 1: 写失败测试**

覆盖 ownership 精确匹配、消息按需加载、发送、停止、流式状态、只读工具策略、未知/跨 Canvas session 拒绝、Canvas 完成通知返回原 Canvas/node、普通 Agent tab/未读/状态岛不出现、关闭面板和切换 Canvas 不停止运行。

```ts
await expect(sendCanvasAgentMessage({
  projectId: 'project-1',
  canvasId: 'canvas-a',
  nodeId: 'node-a',
  sessionId: 'session-owned-by-b',
  prompt: '继续设计首页',
})).rejects.toThrow('Canvas Agent 归属不匹配')

expect(CANVAS_AGENT_ALLOWED_TOOL_NAMES).toEqual(['Read', 'Glob', 'Grep'])
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/canvas-agent-run-policy.test.ts apps/electron/src/main/lib/agent-service.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx apps/electron/src/renderer/lib/canvas-agent-event-routing.test.ts apps/electron/src/renderer/lib/agent-completion-presence.test.ts apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts`

- [ ] **Step 3: 实现受控对话面板**

- 本任务新增 `GET_AGENT_MESSAGES`、`SEND_AGENT_MESSAGE`、`STOP_AGENT` 三个通道并同步 shared、main、preload、adapter 四层。
- 对话面板使用 `AgentMessages` 展示持久化和 live SDK messages；只提供文本输入、发送、停止和关闭按钮，不显示附件、模型切换、权限模式、浏览器或 Collaboration 控件。
- GET/SEND/STOP 每次都从 Canvas 权威文档确认 node -> session 引用，再复核 session 三字段归属；禁止只信任 Renderer 传入 sessionId。
- SEND 复用 `reserveAgentSessionStart()` 和 Agent runtime，但强制传入 `allowedToolNames: ['Read', 'Glob', 'Grep']`，且不创建飞书/钉钉/微信镜像；普通 Agent run 不受该白名单影响。
- 持久化消息只在用户打开节点对话时读取；流式数据明确复用现有 `liveMessagesMapAtom`、`agentStreamingStatesAtom` 和错误 map 这些按 sessionId 隔离的底层 atom，因此组件卸载不会丢运行态；Canvas session 不进入 `agentSessionsAtom`、普通未读和状态岛消费者。
- Global listener 通过纯路由 helper 识别 Canvas Agent：不 upsert 普通会话、不写普通未读/状态岛、不打开普通 Agent tab；完成通知点击后选择对应项目 Canvas 和 node。
- 对话窗关闭不终止运行；切换 Canvas 卸载 UI，但 Pi 会话继续运行。回到 Canvas 后以权威 JSONL + live state 恢复。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/canvas-agent-run-policy.test.ts apps/electron/src/main/lib/agent-service.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx apps/electron/src/renderer/lib/canvas-agent-event-routing.test.ts apps/electron/src/renderer/lib/agent-completion-presence.test.ts apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts`

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/types/canvas.ts apps/electron/src/main/lib/design/canvas-agent-run-policy.ts apps/electron/src/main/lib/design/canvas-agent-run-policy.test.ts apps/electron/src/main/lib/agent-service.ts apps/electron/src/main/lib/agent-service.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts apps/electron/src/renderer/atoms/native-canvas-atoms.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/CanvasAgentConversation.tsx apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx apps/electron/src/renderer/lib/canvas-agent-event-routing.ts apps/electron/src/renderer/lib/canvas-agent-event-routing.test.ts apps/electron/src/renderer/lib/agent-completion-presence.ts apps/electron/src/renderer/lib/agent-completion-presence.test.ts apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx
git commit -m "设计：在 Canvas 内运行受控 Agent 对话"
```

### Task 8: 回归、性能与记忆收口

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: 运行定向回归**

Run: `bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-agent-run-policy.test.ts apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/lib/agent-session-visibility.test.ts apps/electron/src/main/lib/agent-renderer-session-access.test.ts apps/electron/src/main/lib/agent-session-context-prompt.test.ts apps/electron/src/main/lib/agent-internal-session-boundaries.test.ts apps/electron/src/main/lib/automation-scheduler.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx apps/electron/src/renderer/components/design/CanvasAgentNode.test.tsx apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/CanvasWorkspaceEntry.test.tsx apps/electron/src/renderer/lib/agent-session-list.test.ts apps/electron/src/renderer/lib/canvas-agent-event-routing.test.ts apps/electron/src/renderer/lib/agent-completion-presence.test.ts apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts`

- [ ] **Step 2: 运行全仓验证**

Run: `bun run typecheck`

Run: `bun test --isolate`

Run: `CLANG_MODULE_CACHE_PATH=/private/tmp/proma-clang-cache SWIFT_MODULE_CACHE_PATH=/private/tmp/proma-swift-cache bun run electron:build`

- [ ] **Step 3: 实机验收**

验证：同一 Canvas 创建两个 Agent；各自消息隔离；Agent 可读取项目但不能修改代码或启动协作/浏览器；关闭对话不停止运行；切换 Canvas 后运行继续；普通会话列表、归档、搜索、外部 Bridge、托盘、状态岛不出现 Canvas Agent；模拟创建中断后重启恢复同一节点；重启后节点和对话可恢复；1200px 下 1000 节点的实际可见 DOM 显著少于总节点且未打开节点不读取 JSONL；连续 viewport 变更只在 400ms trailing debounce 后形成一次保存；620px 下无重叠；深浅主题可读。

- [ ] **Step 4: 更新记忆并提交**

记录 Canvas 文档与 Pi 会话双事实、creation intent 两阶段协议、Canvas Agent 三字段归属、普通入口过滤、只读运行工具策略、受控消息 IPC 和节点删除保留会话的生命周期决策。

```bash
git add MEMORY.md
git commit -m "文档：记录 Canvas Agent 会话边界"
```

## 停止条件

- 原生 Canvas 只读取和写入自己的 `<canvasId>/canvas.json`；
- 一个 Canvas 可创建多个真实 Agent 节点并独立对话；
- Canvas Agent 不进入所有普通会话消费者；
- 任何跨项目、跨 Canvas、跨节点 session 访问均在运行前拒绝；
- 创建中任一步骤崩溃后都只恢复同一 session/node，已删除节点不会被旧 operation 重建；
- Canvas Agent 可按授权项目读取代码，但不能写代码、启动浏览器、创建协作子会话或绕过 Canvas 专用 IPC；
- Canvas 切换不串 snapshot、pending mutation、选区或对话；
- 定向测试、全量测试、类型检查、Electron 构建和实机验收通过。
