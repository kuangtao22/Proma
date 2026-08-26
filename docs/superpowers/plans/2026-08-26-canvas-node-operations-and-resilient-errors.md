# Canvas 节点操作与局部故障恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为原生 Canvas 增加顶部悬浮工具栏、独立添加、节点扩展、删除和坏会话重建，同时让单节点会话异常局部降级，并彻底阻断 Electron 内部错误泄露到界面。

**Architecture:** 共享层先定义 `nodeIssues`、扩展关系、重建事务和公开错误信封；主进程继续复用 Canvas stable-directory capability、workspace write lease、revision 与 intent 对账协议，在同一权威批次提交节点和边。Renderer 只消费公开快照与错误码，Jotai 保存当前工具和权威 snapshot，XYFlow 负责选择/平移与节点侧扩展，坏节点不进入消息 API。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Jotai、XYFlow、Radix/shadcn、Vitest/Bun Test、Testing Library。

---

## 文件边界

- `packages/shared/src/types/canvas.ts`：唯一共享合同，新增节点问题、公开错误、扩展关系、重建请求/响应和 IPC 通道。
- `apps/electron/src/main/lib/design/canvas-agent-node-creation.ts`：继续拥有创建 intent、stable-directory durability 与 committed 对账；增加扩展边原子提交和独立重建 intent，不复制存储协议。
- `apps/electron/src/main/lib/design/canvas-document-ipc.ts`：公开错误分类、运行态删除守卫、LOAD/CREATE/REBUILD 串行化与广播。
- `apps/electron/src/preload/design-preload.ts`：Electron rejection 的安全截断边界，只返回 `CanvasInvokeResult<T>`。
- `apps/electron/src/renderer/lib/design-adapter.ts`：解包公开结果并抛出仅含公开码/文案的错误。
- `apps/electron/src/renderer/atoms/native-canvas-atoms.ts`：保存选择/平移工具与现有权威 snapshot，不复制 `nodeIssues`。
- `apps/electron/src/renderer/components/design/native-canvas-model.ts`：节点问题/运行态投影、右侧确定性扩展落点和删除 mutation 计算。
- `apps/electron/src/renderer/components/design/NativeCanvasToolbar.tsx`：顶部命令、节点类型菜单、问题徽标和键盘可达性。
- `apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.tsx`：删除确认、边数量和“对话保留”说明。
- `apps/electron/src/renderer/components/design/CanvasAgentRecoveryPanel.tsx`：坏节点重建/删除动作，禁止消息读取。
- `apps/electron/src/renderer/components/design/CanvasAgentNode.tsx`：坏节点状态与节点侧扩展入口。
- `apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx`：select/pan 模式、节点选择和只读连线投影。
- `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`：命令编排、迟到结果隔离、对话/恢复面板切换与公开错误显示。

本计划不修改旧 Design Job、生图路由、素材、trace、普通 Agent 列表、LAN/mobile 或默认 Skills。正常 LOAD 只增加有限 session 元数据检查，仍不读 JSONL；`nodeIssues` 仅随 IPC 留在内存。XYFlow 保持 `onlyRenderVisibleElements`，不会因问题状态关闭虚拟化。

### Task 1: 建立共享节点问题、扩展、重建与公开错误合同

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Modify: `packages/shared/src/types/canvas.test.ts`

- [ ] **Step 1: 写共享合同失败测试**

在 `packages/shared/src/types/canvas.test.ts` 增加静态合同与 reducer 场景，明确 `nodeIssues` 不进入文档、扩展关系使用稳定 edge ID、重建和公开结果能够被穷尽判别：

```ts
test('Given 节点会话不可用, When 构造工作区快照, Then 问题只存在于运行时快照', () => {
  const snapshot: CanvasWorkspaceSnapshot = {
    document: createEmptyCanvasDocument('project-1', 'canvas-1', 1),
    writable: true,
    nodeIssues: [{
      nodeId: 'node-1',
      code: 'AGENT_SESSION_UNAVAILABLE',
      allowedActions: ['rebuild-agent-session', 'remove-node'],
    }],
  }

  expect(snapshot.nodeIssues).toHaveLength(1)
  expect('nodeIssues' in snapshot.document).toBe(false)
})

test('Given 扩展创建输入, When 读取关系, Then 保留源节点和稳定边 ID', () => {
  const input: CreateCanvasAgentNodeInput = {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    operationId: '11111111-1111-4111-8111-111111111111',
    nodeId: '22222222-2222-4222-8222-222222222222',
    title: '下游 Agent',
    position: { x: 480, y: 120 },
    relationship: {
      sourceNodeId: 'source-1',
      edgeId: '33333333-3333-4333-8333-333333333333',
    },
  }

  expect(input.relationship).toEqual({
    sourceNodeId: 'source-1',
    edgeId: '33333333-3333-4333-8333-333333333333',
  })
})

test('Given 重建公开失败, When 判别结果, Then 只能读取安全错误', () => {
  const result: CanvasInvokeResult<RebuildCanvasAgentNodeResult> = {
    ok: false,
    error: { code: 'AGENT_SESSION_REBUILD_FAILED', message: '重建失败，请重试。' },
  }

  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error).toEqual({
      code: 'AGENT_SESSION_REBUILD_FAILED',
      message: '重建失败，请重试。',
    })
  }
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test packages/shared/src/types/canvas.test.ts`

Expected: FAIL，提示 `nodeIssues`、`CanvasInvokeResult`、`RebuildCanvasAgentNodeResult` 或 `relationship` 尚未定义。

- [ ] **Step 3: 实现共享类型与通道**

在 `packages/shared/src/types/canvas.ts` 增加以下完整公开合同，并把 `nodeIssues` 设为所有 snapshot 的必填字段，避免 Renderer 在新旧返回形状之间猜测：

```ts
/** Canvas 节点可由用户执行的恢复动作。 */
export type CanvasNodeIssueAction = 'rebuild-agent-session' | 'remove-node'

/** 首批节点问题只公开用户可恢复的会话不可用状态。 */
export type CanvasNodeIssueCode = 'AGENT_SESSION_UNAVAILABLE'

/** 主进程派生的节点问题，不写入 CanvasDocument。 */
export interface CanvasNodeIssue {
  nodeId: string
  code: CanvasNodeIssueCode
  allowedActions: CanvasNodeIssueAction[]
}

/** 从源节点创建下游节点时使用的稳定关系身份。 */
export interface CreateCanvasAgentNodeRelationship {
  sourceNodeId: string
  edgeId: string
}

/** Renderer 可见的 Canvas 业务错误码。 */
export type CanvasPublicErrorCode =
  | 'CANVAS_LOAD_FAILED'
  | 'CANVAS_SAVE_FAILED'
  | 'CANVAS_CREATE_FAILED'
  | 'CANVAS_REVISION_CONFLICT'
  | 'AGENT_SESSION_BUSY'
  | 'AGENT_SESSION_REBUILD_FAILED'
  | 'CANVAS_AGENT_MESSAGES_FAILED'
  | 'CANVAS_AGENT_SEND_FAILED'
  | 'CANVAS_AGENT_STOP_FAILED'

/** 不含内部路径、UUID、通道或堆栈的公开错误。 */
export interface CanvasPublicError {
  code: CanvasPublicErrorCode
  message: string
}

/** 所有原生 Canvas invoke 共用的安全结果信封。 */
export type CanvasInvokeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CanvasPublicError }

export interface RebuildCanvasAgentNodeInput extends CanvasAgentTarget {
  operationId: string
}

export interface RebuildCanvasAgentNodeResult {
  snapshot: CanvasWorkspaceSnapshot
  session: AgentSessionMeta
}
```

同步修改现有接口：

```ts
export interface CreateCanvasAgentNodeInput extends CanvasTarget {
  operationId: string
  nodeId: string
  title: string
  position: DesignPoint
  relationship?: CreateCanvasAgentNodeRelationship
}

export interface CanvasWorkspaceSnapshot {
  document: CanvasDocument
  writable: true
  nodeIssues: CanvasNodeIssue[]
  recoveredFrom?: 'tmp' | 'backup'
}
```

在现有 `CANVAS_IPC_CHANNELS` 对象加入：

```ts
REBUILD_AGENT_NODE: 'canvas:rebuild-agent-node',
```

- [ ] **Step 4: 修正所有测试夹具并确认 GREEN**

所有既有 `CanvasWorkspaceSnapshot` 测试夹具显式加入 `nodeIssues: []`，不在生产代码设置可选回退。

Run: `bun test packages/shared/src/types/canvas.test.ts`

Expected: PASS，且共享类型测试无 TypeScript 诊断。

- [ ] **Step 5: 提交共享合同**

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts
git commit -m "功能：定义 Canvas 节点恢复与公开错误合同"
```

### Task 2: 将 committed 坏会话降级为节点问题

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-agent-node-creation.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-store.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-store.test.ts`

- [ ] **Step 1: 写 committed 局部降级与未完成事务 fail-closed 测试**

在 `canvas-agent-node-creation.test.ts` 增加 BDD 场景：

```ts
test('Given committed 节点的 session 缺失, When LOAD 对账, Then 返回完整文档并标记目标节点', async () => {
  const harness = createCreationHarness({
    document: createAgentDocument('session-missing'),
    intents: [createCommittedIntent({ sessionId: 'session-missing' })],
    sessions: [],
  })

  const result = await harness.service.reconcile({ projectId: PROJECT_ID, canvasId: CANVAS_ID })

  expect(result.error).toBeUndefined()
  expect(result.snapshot.document.nodes).toHaveLength(1)
  expect(result.snapshot.nodeIssues).toEqual([{
    nodeId: NODE_ID,
    code: 'AGENT_SESSION_UNAVAILABLE',
    allowedActions: ['rebuild-agent-session', 'remove-node'],
  }])
})

test('Given committed 节点已经删除且 session 缺失, When LOAD 对账, Then intent 转 detached 且没有节点问题', async () => {
  const harness = createCreationHarness({
    document: createEmptyCanvasDocument(PROJECT_ID, CANVAS_ID, 1),
    intents: [createCommittedIntent({ sessionId: 'session-missing' })],
    sessions: [],
  })

  const result = await harness.service.reconcile({ projectId: PROJECT_ID, canvasId: CANVAS_ID })

  expect(result.snapshot.nodeIssues).toEqual([])
  expect(harness.writtenIntents.at(-1)?.state).toBe('detached')
})

test('Given session-created 事务的 session 缺失, When LOAD 对账, Then 整体拒绝加载', async () => {
  const harness = createCreationHarness({
    document: createEmptyCanvasDocument(PROJECT_ID, CANVAS_ID, 1),
    intents: [createSessionCreatedIntent({ sessionId: 'session-missing' })],
    sessions: [],
  })

  await expect(harness.service.reconcile({ projectId: PROJECT_ID, canvasId: CANVAS_ID }))
    .rejects.toThrow('session')
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts`

Expected: FAIL；当前 committed 分支在检查节点是否存在前调用 `assertSessionMatchesIntent()`，单个坏 session 会抛出致命错误。

- [ ] **Step 3: 实现节点级问题派生**

在 `canvas-agent-node-creation.ts` 增加不抛错的匹配函数和节点问题构造函数：

```ts
/** 判断 session 是否完整匹配创建 intent，不把 committed 引用异常升级为图损坏。 */
function sessionMatchesIntent(
  session: AgentSessionMeta | undefined,
  intent: CanvasAgentNodeCreationIntent,
): session is AgentSessionMeta {
  return Boolean(session
    && hasValidCanvasAgentOwnership(session)
    && session.id === intent.sessionId
    && session.title === intent.title
    && session.channelId === intent.channelId
    && session.modelId === intent.modelId
    && session.workspaceId === intent.projectId
    && session.sourceCanvasProjectId === intent.projectId
    && session.sourceCanvasId === intent.canvasId
    && session.sourceCanvasNodeId === intent.nodeId)
}

/** 为坏会话节点生成不含内部身份的公开问题。 */
function createUnavailableSessionIssue(nodeId: string): CanvasNodeIssue {
  return {
    nodeId,
    code: 'AGENT_SESSION_UNAVAILABLE',
    allowedActions: ['rebuild-agent-session', 'remove-node'],
  }
}
```

`assertSessionMatchesIntent()` 改为复用 `sessionMatchesIntent()`；在 `reconcileWithDirectory()` 中调整 committed 顺序：

```ts
const nodeIssues: CanvasNodeIssue[] = []

if (intent.state === 'committed') {
  const node = document.nodes.find((candidate) => candidate.id === intent.nodeId)
  if (!node) {
    intent = this.transitionIntent(intent, 'detached')
    const confirmation = await this.writeIntent(identity, intent)
    if (confirmation.durabilityError) {
      reconciliationError = confirmation.durabilityError
      intents.push(intent)
      break
    }
  } else {
    assertNodeMatchesIntent(node, intent)
    if (!sessionMatchesIntent(this.dependencies.getSession(intent.sessionId), intent)) {
      nodeIssues.push(createUnavailableSessionIssue(node.id))
    }
  }
}
```

返回快照时显式覆盖派生问题：

```ts
snapshot: { ...snapshot, document, nodeIssues },
```

`canvas-document-store.ts` 的新建/加载快照统一返回 `nodeIssues: []`；Store 不持久化此字段。

- [ ] **Step 4: 运行主进程与 Store 测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts`

Expected: PASS；committed session 缺失或归属异常只标记单节点，prepared/session-created、文档或 intent 损坏仍拒绝加载。

- [ ] **Step 5: 提交局部降级**

```bash
git add apps/electron/src/main/lib/design/canvas-agent-node-creation.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-document-store.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts
git commit -m "修复：将 Canvas 坏会话降级为节点问题"
```

### Task 3: 原子创建下游节点与连线

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-agent-node-creation.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

- [ ] **Step 1: 写扩展创建、幂等重试和坏源节点测试**

```ts
test('Given 健康源节点, When 扩展 Agent, Then 节点与边在同一 revision 提交', async () => {
  const harness = createCreationHarness({ document: createSourceAgentDocument() })
  const result = await harness.service.createReconciled({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    operationId: OPERATION_ID,
    nodeId: TARGET_NODE_ID,
    title: '下游 Agent',
    position: { x: 520, y: 80 },
    relationship: { sourceNodeId: SOURCE_NODE_ID, edgeId: EDGE_ID },
  })

  expect(result.document.revision).toBe(2)
  expect(result.document.nodes.some((node) => node.id === TARGET_NODE_ID)).toBe(true)
  expect(result.document.edges).toContainEqual({
    id: EDGE_ID,
    sourceNodeId: SOURCE_NODE_ID,
    sourcePort: 'output',
    targetNodeId: TARGET_NODE_ID,
    targetPort: 'input',
  })
  expect(harness.storeMutations.at(-1)).toEqual([
    expect.objectContaining({ type: 'upsert-nodes' }),
    expect.objectContaining({ type: 'upsert-edges' }),
  ])
})

test('Given 相同扩展 operation 已 committed, When 重试, Then 不重复节点或边', async () => {
  const harness = createCommittedExtensionHarness()
  const result = await harness.service.createReconciled(harness.input)

  expect(result.document.nodes.filter((node) => node.id === TARGET_NODE_ID)).toHaveLength(1)
  expect(result.document.edges.filter((edge) => edge.id === EDGE_ID)).toHaveLength(1)
  expect(result.documentChanged).toBe(false)
})

test('Given 源节点存在 node issue, When 请求扩展, Then 拒绝且文档不变', async () => {
  const harness = createUnavailableSourceHarness()

  await expect(harness.service.createReconciled(harness.input))
    .rejects.toThrow('源节点会话不可用')
  expect(harness.storeMutations).toEqual([])
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

Expected: FAIL；intent 尚未持久化 relationship，提交阶段只写 `upsert-nodes`，输入解析也会丢弃关系字段。

- [ ] **Step 3: 扩展 intent 并在一个 Store mutation batch 提交节点和边**

在 `CanvasAgentNodeCreationIntent` 加入可选关系：

```ts
relationship?: CreateCanvasAgentNodeRelationship
```

`parseIntentJson()`、`isSameIntent()`、`assertCreateCanvasAgentNodeInput()` 和幂等匹配必须校验 `sourceNodeId`、`edgeId` 均为合法稳定 ID，且源/目标不同；`canvas-document-ipc.ts` 的 `parseCreateAgentNodeInput()` 保留该结构。

在 `createAfterReconciliation()` 创建 prepared intent 之前验证源节点存在且未命中本次对账产生的 `nodeIssues`，避免先创建 session 再发现源节点不可扩展：

```ts
if (input.relationship) {
  const sourceNode = reconciled.snapshot.document.nodes.find((candidate) => (
    candidate.id === input.relationship?.sourceNodeId
  ))
  if (!sourceNode) throw new Error('Canvas 扩展源节点不存在')
  if (reconciled.snapshot.nodeIssues.some((issue) => issue.nodeId === sourceNode.id)) {
    throw new Error('Canvas 扩展源节点会话不可用')
  }
}
```

在 `advanceIntent()` 的 `session-created` 分支构造完整批次：

```ts
/** 创建节点与可选关系必须共享一次 revision。 */
const mutations: CanvasMutation[] = [{ type: 'upsert-nodes', nodes: [node] }]
if (intent.relationship) {
  const sourceNode = document.nodes.find((candidate) => candidate.id === intent.relationship?.sourceNodeId)
  if (!sourceNode) throw new Error('Canvas 扩展源节点不存在')
  mutations.push({
    type: 'upsert-edges',
    edges: [{
      id: intent.relationship.edgeId,
      sourceNodeId: sourceNode.id,
      sourcePort: 'output',
      targetNodeId: node.id,
      targetPort: 'input',
    }],
  })
}
document = this.dependencies.store.mutate(
  { projectId: intent.projectId, canvasId: intent.canvasId },
  document.revision,
  mutations,
)
```

若节点已存在，幂等校验同时验证 edge；同 ID edge 关系不同或目标节点存在但 edge 缺失时 fail closed，不能在 committed 之后猜测补边。

- [ ] **Step 4: 运行扩展事务测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

Expected: PASS；独立创建仍只增加节点，扩展创建一次增加节点和边，失败/重试不产生孤立节点、重复边或悬空边。

- [ ] **Step 5: 提交扩展事务**

```bash
git add apps/electron/src/main/lib/design/canvas-agent-node-creation.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts
git commit -m "功能：原子创建 Canvas 下游节点与连线"
```

### Task 4: 实现坏节点 Agent session 可恢复重建

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-agent-node-creation.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts`

- [ ] **Step 1: 写重建成功、幂等与崩溃恢复测试**

```ts
test('Given 坏 Agent 节点, When 重建成功, Then 只替换 session 引用并保留节点和边', async () => {
  const harness = createUnavailableNodeHarness()
  const result = await harness.service.rebuildReconciled({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    operationId: REBUILD_OPERATION_ID,
    nodeId: NODE_ID,
  })

  const rebuilt = result.snapshot.document.nodes.find((node) => node.id === NODE_ID)
  expect(rebuilt).toMatchObject({
    id: NODE_ID,
    title: '首页设计',
    position: { x: 120, y: 80 },
    agentSessionId: NEW_SESSION_ID,
  })
  expect(result.snapshot.document.edges).toEqual(harness.originalEdges)
  expect(result.snapshot.nodeIssues).toEqual([])
  expect(harness.deletedSessionIds).toEqual([])
})

test('Given 重建已 committed, When 相同 operation 重试, Then 返回同一新 session', async () => {
  const harness = createCommittedRebuildHarness()
  const first = await harness.service.rebuildReconciled(harness.input)
  const second = await harness.service.rebuildReconciled(harness.input)

  expect(second.session.id).toBe(first.session.id)
  expect(harness.createdSessionIds).toEqual([first.session.id])
})

test('Given session-created 重建 intent, When LOAD 对账, Then 完成换绑且不暴露半提交引用', async () => {
  const harness = createInterruptedRebuildHarness('session-created')
  const result = await harness.service.reconcile({ projectId: PROJECT_ID, canvasId: CANVAS_ID })

  expect(result.snapshot.document.nodes.find((node) => node.id === NODE_ID))
    .toMatchObject({ agentSessionId: NEW_SESSION_ID })
  expect(harness.writtenRebuildIntents.at(-1)?.state).toBe('committed')
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts`

Expected: FAIL，提示 `rebuildReconciled` 和 rebuild intent 尚不存在。

- [ ] **Step 3: 在同一事务服务实现独立 rebuild intent**

在 `canvas-agent-node-creation.ts` 增加独立文件名 `agent-node-rebuild-<operationId>.json` 和以下状态，继续复用同一 capability、原子写、单调时间戳和 512 intent 上限：

```ts
type CanvasAgentNodeRebuildState = 'prepared' | 'session-created' | 'committed'

interface CanvasAgentNodeRebuildIntent extends CanvasTarget {
  schemaVersion: 1
  operationId: string
  nodeId: string
  previousSessionId: string
  replacementSessionId: string
  title: string
  channelId: string
  modelId?: string
  state: CanvasAgentNodeRebuildState
  createdAt: number
  updatedAt: number
}
```

新增公开服务方法：

```ts
/** 显式把坏节点换绑到新的空白 Canvas Agent session。 */
async rebuildReconciled(
  input: RebuildCanvasAgentNodeInput,
): Promise<RebuildCanvasAgentNodeResult & { documentChanged: boolean }> {
  assertRebuildCanvasAgentNodeInput(input)
  const reconciled = await this.reconcileWithDirectory(input)
  if (reconciled.error) throw reconciled.error
  const node = reconciled.snapshot.document.nodes.find((candidate) => candidate.id === input.nodeId)
  if (!node || node.kind !== 'agent') throw new Error('Canvas Agent 节点不存在')
  const issue = reconciled.snapshot.nodeIssues.find((candidate) => candidate.nodeId === node.id)
  if (!issue) throw new Error('Canvas Agent 节点无需重建')
  return this.rebuildAfterReconciliation(input, node, reconciled)
}
```

`rebuildAfterReconciliation()` 固化旧/新 session ID、标题和当前默认模型快照；prepared 创建带完整 Canvas 三字段归属的新空 session，session-created 用一次 `upsert-nodes` 保留原节点其余字段只替换 `agentSessionId`，最后写 committed 屏障。`reconcileWithDirectory()` 必须先对账创建 intent，再对账 rebuild intent；任何无法确定的 prepared/session-created 持久性错误继续整图 fail closed。

- [ ] **Step 4: 运行重建与生命周期回归确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-agent-run-policy.test.ts`

Expected: PASS；重建保留 node ID、标题、位置和边，旧 session 不删除，新 session 继续保持 Canvas 隐藏归属。

- [ ] **Step 5: 提交重建事务**

```bash
git add apps/electron/src/main/lib/design/canvas-agent-node-creation.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts
git commit -m "功能：支持 Canvas 坏节点会话重建"
```

### Task 5: 增加主进程公开错误、重建 IPC 与运行态删除守卫

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: 写公开信封、删除忙守卫和坏节点消息隔离测试**

```ts
test('Given 运行中 Agent 节点, When SAVE 删除, Then 拒绝整个 batch 且 Store 不变', async () => {
  const harness = createIpcHarness({
    document: createRunningAgentDocument(),
    activeRunSnapshot: {
      owners: [{
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        nodeId: NODE_ID,
        title: '首页设计',
        sessionId: SESSION_ID,
        startedAt: 10,
      }],
      internalInvalidRuns: [],
    },
  })

  const result = await harness.invoke(CANVAS_IPC_CHANNELS.SAVE, {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    expectedRevision: 1,
    mutations: [{ type: 'remove-nodes', nodeIds: [NODE_ID] }],
  }) as CanvasInvokeResult<CanvasDocument>

  expect(result).toEqual({
    ok: false,
    error: { code: 'AGENT_SESSION_BUSY', message: '请先停止 Agent，再删除节点。' },
  })
  expect(harness.storeMutations).toEqual([])
})

test('Given 坏节点, When GET 消息, Then 不读取 JSONL 并返回安全失败', async () => {
  const harness = createUnavailableNodeIpcHarness()
  const result = await harness.invoke(CANVAS_IPC_CHANNELS.GET_AGENT_MESSAGES, {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    nodeId: NODE_ID,
  }) as CanvasInvokeResult<CanvasAgentMessagesResult>

  expect(result.ok).toBe(false)
  expect(harness.getMessagesCalls).toBe(0)
})

test('Given 内部 LOAD 异常含路径和 UUID, When IPC 返回, Then 只暴露公开文案', async () => {
  const harness = createIpcHarness({
    loadError: new Error('Error invoking remote method canvas:load /Users/name 11111111-1111-4111-8111-111111111111'),
  })
  const result = await harness.invoke(CANVAS_IPC_CHANNELS.LOAD, TARGET)

  expect(result).toEqual({
    ok: false,
    error: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
  })
})
```

- [ ] **Step 2: 运行 IPC 测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

Expected: FAIL；当前 handler 返回裸值/抛原始 Error，SAVE 也没有 Agent 删除运行态守卫。

- [ ] **Step 3: 实现主进程安全结果与删除守卫**

在 `canvas-document-ipc.ts` 增加集中映射，日志保留内部错误但结果不拼接异常正文：

```ts
/** 主进程内部携带公开错误码的可预期业务失败。 */
class CanvasPublicFailure extends Error {
  constructor(
    readonly code: CanvasPublicErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CanvasPublicFailure'
  }
}

/** 将 Canvas handler 结果收敛为 Renderer 可消费的公开信封。 */
async function invokeCanvasOperation<T>(
  operation: 'load' | 'save' | 'create' | 'rebuild' | 'messages' | 'send' | 'stop',
  run: () => Promise<T>,
): Promise<CanvasInvokeResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    console.error(`[Canvas] ${operation} 失败`, error)
    return { ok: false, error: toCanvasPublicError(operation, error) }
  }
}
```

删除守卫在已完成创建事务对账之后、调用 `store.mutate()` 之前执行：

```ts
/** 拒绝删除仍有权威运行事实的 Agent 节点，保证后台运行保持可见。 */
function assertRemovedAgentNodesAreIdle(
  document: CanvasDocument,
  mutations: CanvasMutation[],
  activeRuns: CanvasAgentActiveRunSnapshot,
): void {
  const removedNodeIds = new Set(
    mutations
      .filter((mutation): mutation is Extract<CanvasMutation, { type: 'remove-nodes' }> => (
        mutation.type === 'remove-nodes'
      ))
      .flatMap((mutation) => mutation.nodeIds),
  )
  const removedSessionIds = new Set(document.nodes
    .filter((node) => node.kind === 'agent' && removedNodeIds.has(node.id))
    .map((node) => node.agentSessionId))
  const busy = activeRuns.owners.some((owner) => (
    removedNodeIds.has(owner.nodeId) || removedSessionIds.has(owner.sessionId)
  )) || activeRuns.internalInvalidRuns.some((run) => removedSessionIds.has(run.sessionId))
  if (busy) throw new CanvasPublicFailure(
    'AGENT_SESSION_BUSY',
    '请先停止 Agent，再删除节点。',
  )
}
```

注册 `REBUILD_AGENT_NODE`，与 LOAD/SAVE/CREATE 使用相同 `projectId + canvasId` 串行 key 和 workspace write lease；重建成功且 `documentChanged` 时在 lease 释放后广播 `cause: graph`。GET/SEND/STOP 先读取 reconcile snapshot，命中 `nodeIssues` 立即返回固定失败，不调用消息存储或运行时。

在 `apps/electron/src/main/ipc.ts` 将现有 `listActiveRuns/getSession/createSession` 注入事务服务与 Canvas IPC，不建立第二套运行态来源。

- [ ] **Step 4: 运行 IPC、session 与创建事务测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/canvas-session-ipc.test.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts`

Expected: PASS；所有 Canvas invoke 返回信封，忙节点删除/重建被主进程拒绝，坏节点不读取 JSONL，广播仍发生在 lease 外。

- [ ] **Step 5: 提交主进程边界**

```bash
git add apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/ipc.ts
git commit -m "修复：保护 Canvas 节点操作与公开错误边界"
```

### Task 6: 在 Preload 与 Renderer Adapter 截断 Electron 原始异常

**Files:**
- Modify: `apps/electron/src/preload/design-preload.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写 invoke rejection 与公开错误解包测试**

```ts
test('Given Electron invoke rejection 含内部信息, When preload 调用 LOAD, Then 丢弃原始正文', async () => {
  invoke.mockRejectedValueOnce(new Error(
    'Error invoking remote method canvas:load /Users/name 11111111-1111-4111-8111-111111111111',
  ))

  const result = await api.loadCanvasWorkspace({ projectId: 'project-1', canvasId: 'canvas-1' })

  expect(result).toEqual({
    ok: false,
    error: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
  })
  expect(JSON.stringify(result)).not.toContain('remote method')
})

test('Given Adapter 收到公开失败, When 调用 LOAD, Then 只抛公开码和文案', async () => {
  window.designApi.loadCanvasWorkspace = mock(async () => ({
    ok: false,
    error: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
  }))

  await expect(designAdapter.loadCanvasWorkspace(TARGET)).rejects.toMatchObject({
    name: 'CanvasPublicOperationError',
    code: 'CANVAS_LOAD_FAILED',
    message: '画布暂时无法加载。',
  })
})
```

- [ ] **Step 2: 运行桥接测试确认 RED**

Run: `bun test apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: FAIL；Preload 当前直接返回 `ipc.invoke()`，Adapter 尚未解包 `CanvasInvokeResult`。

- [ ] **Step 3: 实现 Preload 安全 invoke helper**

```ts
/** 捕获 Electron 包装异常并按操作返回固定公开失败。 */
async function invokeCanvasSafely<T>(
  channel: string,
  input: unknown,
  fallback: CanvasPublicError,
): Promise<CanvasInvokeResult<T>> {
  try {
    return await ipcRenderer.invoke(channel, input) as CanvasInvokeResult<T>
  } catch {
    return { ok: false, error: fallback }
  }
}
```

所有 Canvas API 改用该 helper，LOAD/SAVE/CREATE/REBUILD 分别使用固定失败码；`DesignPreloadApi` 返回类型改成 `Promise<CanvasInvokeResult<T>>`，并加入：

```ts
rebuildCanvasAgentNode: (
  input: RebuildCanvasAgentNodeInput,
) => Promise<CanvasInvokeResult<RebuildCanvasAgentNodeResult>>
```

- [ ] **Step 4: 实现 Adapter 解包与安全错误类**

```ts
/** Renderer 内只携带共享公开错误，不接受 Electron rejection 正文。 */
export class CanvasPublicOperationError extends Error {
  constructor(
    public readonly code: CanvasPublicErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CanvasPublicOperationError'
  }
}

/** 解包 preload 安全结果，失败时抛出稳定公开错误。 */
function unwrapCanvasResult<T>(result: CanvasInvokeResult<T>): T {
  if (result.ok) return result.value
  throw new CanvasPublicOperationError(result.error.code, result.error.message)
}
```

`designAdapter` 的 Canvas 方法全部 `.then(unwrapCanvasResult)`，并增加 `rebuildCanvasAgentNode`。对 preload 自身无法调用的未知异常只映射为当前操作固定中文文案，不能读取 `String(error)` 或 `error.message`。

- [ ] **Step 5: 运行桥接与 Adapter 测试确认 GREEN**

Run: `bun test apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: PASS；测试输出和返回对象均不包含 `Error invoking remote method`、UUID、绝对路径或堆栈。

- [ ] **Step 6: 提交安全桥接**

```bash
git add apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "修复：屏蔽 Canvas Electron 内部错误正文"
```

### Task 7: 投影节点问题、运行态、选择/平移与扩展落点

**Files:**
- Modify: `apps/electron/src/renderer/atoms/native-canvas-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.ts`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.test.ts`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasAgentNode.tsx`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

- [ ] **Step 1: 写状态清理、问题投影和扩展落点测试**

```ts
test('Given 新建状态, When 切换工具, Then activeTool 只允许 select 或 pan', () => {
  const initial = createInitialNativeCanvasState()
  expect(initial.activeTool).toBe('select')
  expect({ ...initial, activeTool: 'pan' as const }.activeTool).toBe('pan')
})

test('Given Agent 节点存在问题和运行快照, When 投影, Then unavailable 优先且可扩展为 false', () => {
  const nodes = toNativeCanvasFlowNodes(createAgentDocument(), {
    nodeIssues: [{
      nodeId: 'agent-1',
      code: 'AGENT_SESSION_UNAVAILABLE',
      allowedActions: ['rebuild-agent-session', 'remove-node'],
    }],
    runningSessionIds: new Set(['session-1']),
    canExpand: true,
    onExpand: () => undefined,
  })

  expect(nodes[0]?.data).toMatchObject({ status: 'unavailable', canExpand: false })
})

test('Given 源节点右侧被占用, When 计算扩展落点, Then 确定性寻找下一处不重叠位置', () => {
  const nodes = [
    { id: 'source', position: { x: 100, y: 100 } },
    { id: 'occupied', position: { x: 420, y: 100 } },
  ]

  expect(findAvailableNativeCanvasChildPosition('source', nodes)).toEqual({ x: 420, y: 300 })
})
```

- [ ] **Step 2: 运行 Renderer 模型测试确认 RED**

Run: `bun test apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts`

Expected: FAIL；`activeTool`、unavailable 投影和 `findAvailableNativeCanvasChildPosition()` 尚不存在。

- [ ] **Step 3: 实现 Jotai 与模型投影**

在 `NativeCanvasState` 增加：

```ts
/** 当前鼠标在画布上的主交互工具。 */
activeTool: 'select' | 'pan'
```

`createInitialNativeCanvasState()` 设置 `activeTool: 'select'`；Canvas 切换、recovery 和 dispose 继续整体替换/删除 state，`nodeIssues` 只由 `snapshot` 携带。

在 `native-canvas-model.ts` 定义投影参数和扩展落点：

```ts
export interface NativeCanvasProjectionOptions {
  nodeIssues: CanvasNodeIssue[]
  runningSessionIds: ReadonlySet<string>
  canExpand: boolean
  onExpand: (nodeId: string) => void
}

/** 从源节点右侧开始按列向下寻找首个不重叠位置。 */
export function findAvailableNativeCanvasChildPosition(
  sourceNodeId: string,
  nodes: ReadonlyArray<NativeCanvasPositionedNode>,
): DesignPoint {
  const source = nodes.find((node) => node.id === sourceNodeId)
  if (!source) throw new Error('Canvas 扩展源节点不存在')
  const start = {
    x: source.position.x + NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP,
    y: source.position.y,
  }
  const overlaps = (candidate: DesignPoint): boolean => nodes.some((node) => (
    Math.abs(candidate.x - node.position.x) < NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP
    && Math.abs(candidate.y - node.position.y) < NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP
  ))
  for (let row = 0; row <= nodes.length; row += 1) {
    const candidate = {
      x: start.x,
      y: start.y + row * (NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP),
    }
    if (!overlaps(candidate)) return candidate
  }
  throw new Error('Canvas 扩展落点计算失败')
}
```

Agent data 状态改为 `idle | running | unavailable`；unavailable 禁止扩展，健康节点在 Canvas 可写时提供 `onExpand`。无边节点继续显式 `handles: []`。

- [ ] **Step 4: 接通 XYFlow select/pan 和节点侧按钮**

`NativeCanvasGraph` 增加 `activeTool` 与 `onActiveToolChange` props，并设置：

```tsx
<ReactFlow
  nodesDraggable={writable && activeTool === 'select'}
  elementsSelectable={activeTool === 'select'}
  panOnDrag={activeTool === 'pan' ? true : [1]}
  selectionOnDrag={activeTool === 'select'}
  onlyRenderVisibleElements
/>
```

`CanvasAgentNode` 在选中、hover 或 `:focus-within` 时显示固定 28px 的右侧 `+`，按钮使用 `Plus` 图标、`aria-label="从此节点扩展"` 和 Tooltip；点击时 `stopPropagation()` 后调用 `data.onExpand(data.id)`。unavailable 节点显示“会话不可用”并不渲染扩展按钮。

- [ ] **Step 5: 运行模型、图与大画布回归确认 GREEN**

Run: `bun test apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

Expected: PASS；1000 节点仍只渲染可见节点，问题投影不增加写盘或消息请求。

- [ ] **Step 6: 提交交互模型**

```bash
git add apps/electron/src/renderer/atoms/native-canvas-atoms.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/native-canvas-model.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx apps/electron/src/renderer/components/design/CanvasAgentNode.tsx apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx
git commit -m "功能：接通 Canvas 工具模式与节点扩展投影"
```

### Task 8: 完成顶部工具栏、删除确认、坏节点恢复面板与命令编排

**Files:**
- Create: `apps/electron/src/renderer/components/design/NativeCanvasToolbar.tsx`
- Create: `apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasAgentRecoveryPanel.tsx`
- Create: `apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx`
- Create: `apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.test.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasAgentRecoveryPanel.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasAgentConversation.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写工具栏、删除、恢复和错误文案失败测试**

```tsx
test('Given 可写 Canvas, When 打开添加菜单, Then 只启用 Agent 并说明未来类型不可用', async () => {
  render(<NativeCanvasToolbar {...createToolbarProps()} />)
  await user.click(screen.getByRole('button', { name: '添加节点' }))

  expect(screen.getByRole('menuitem', { name: 'Agent' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: '生图' })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('menuitem', { name: '视觉文档' })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('menuitem', { name: '原型' })).toHaveAttribute('aria-disabled', 'true')
})

test('Given 选中节点有两条关联边, When 请求删除, Then 确认框说明边和对话保留', () => {
  render(<NativeCanvasDeleteDialog
    open
    nodeTitle="首页设计"
    connectedEdgeCount={2}
    busy={false}
    onOpenChange={() => undefined}
    onConfirm={() => undefined}
  />)

  expect(screen.getByText('将同时删除 2 条关联连线。')).toBeVisible()
  expect(screen.getByText('Agent 对话记录会保留。')).toBeVisible()
})

test('Given 坏节点, When 打开面板, Then 不渲染对话并提供重建和删除', () => {
  const getMessages = mock(() => Promise.resolve(createMessagesResult()))
  render(<NativeCanvasWorkspace
    {...createWorkspaceProps({ nodeIssue: createUnavailableIssue(), getMessages })}
  />)

  expect(screen.getByText('此节点关联的 Agent 会话不可用。')).toBeVisible()
  expect(screen.getByRole('button', { name: '重建会话' })).toBeVisible()
  expect(screen.getByRole('button', { name: '删除节点' })).toBeVisible()
  expect(getMessages).not.toHaveBeenCalled()
})

test('Given API 错误含内部正文, When 对话加载失败, Then UI 只显示固定文案', async () => {
  render(<CanvasAgentConversation
    {...createConversationProps({
      getCanvasAgentMessages: () => Promise.reject(new Error(
        'Error invoking remote method /Users/name 11111111-1111-4111-8111-111111111111',
      )),
    })}
  />)

  expect(await screen.findByText('对话暂时无法加载。')).toBeVisible()
  expect(screen.queryByText(/remote method|\/Users\/|11111111/u)).toBeNull()
})
```

- [ ] **Step 2: 运行 Workspace 组件测试确认 RED**

Run: `bun test apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.test.tsx apps/electron/src/renderer/components/design/CanvasAgentRecoveryPanel.test.tsx apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: FAIL；三个新组件不存在，Workspace 仍在标题栏添加 Agent，并直接显示 `error.message`。

- [ ] **Step 3: 创建顶部悬浮工具栏**

`NativeCanvasToolbar.tsx` 定义以下明确 props：

```ts
export interface NativeCanvasToolbarProps {
  activeTool: 'select' | 'pan'
  writable: boolean
  canDelete: boolean
  issueCount: number
  onToolChange: (tool: 'select' | 'pan') => void
  onAddAgent: () => void
  onDelete: () => void
  onFocusFirstIssue: () => void
}
```

组件位于 Canvas 顶部居中、使用 32px 图标按钮和既有主题变量；选择用 `MousePointer2`，平移用 `Hand`，添加用 `Plus`，删除用 `Trash2`。添加菜单列出 Agent、生图、视觉文档、原型；后三者 `aria-disabled` 且 Tooltip 为“即将支持”。`issueCount > 0` 显示“{n} 个节点需要处理”，点击聚焦首个问题节点。窄窗口用图标与紧凑徽标，不产生横向滚动。

- [ ] **Step 4: 创建删除确认和恢复面板**

`NativeCanvasDeleteDialog.tsx` 使用既有 AlertDialog primitive；busy 时主操作显示“停止后删除”，先调用 Workspace stop 命令，收到权威终态后再提交 `remove-nodes`。普通确认直接提交：

```ts
onConfirm: (mode: 'delete' | 'stop-and-delete') => void
```

`CanvasAgentRecoveryPanel.tsx` props：

```ts
export interface CanvasAgentRecoveryPanelProps {
  title: string
  rebuilding: boolean
  error: string | null
  onRebuild: () => void
  onDelete: () => void
  onClose: () => void
}
```

面板正文明确新会话为空白、旧记录不会删除；重建进行中禁用重复提交。它不接收 session ID、消息 adapter 或 JSONL 数据。

- [ ] **Step 5: 在 Workspace 统一编排独立添加、扩展、删除和重建**

将现有创建 controller 泛化为同一命令接收可选 source node：

```ts
export interface CanvasAgentNodeCommandRequest {
  sourceNodeId?: string
}

execute(request: CanvasAgentNodeCommandRequest = {}): Promise<void>
```

独立添加使用可视中心位置且不传 relationship；扩展使用 `findAvailableNativeCanvasChildPosition()` 并预分配 edge ID：

```ts
const input: CreateCanvasAgentNodeInput = {
  ...target,
  operationId: createId(),
  nodeId: createId(),
  title: '新 Agent',
  position: request.sourceNodeId
    ? getChildPosition(request.sourceNodeId)
    : getIndependentPosition(),
  ...(request.sourceNodeId
    ? { relationship: { sourceNodeId: request.sourceNodeId, edgeId: createId() } }
    : {}),
}
```

每个创建/重建 operation 保持稳定输入用于失败重试；Canvas key 改变或 controller dispose 后，迟到 success/error 无副作用。创建成功以 `CanvasAgentNodeCreationResult.document` 替换当前 document 并保留当前 snapshot 的 `nodeIssues`；重建成功以 `RebuildCanvasAgentNodeResult.snapshot` 整体替换 document 与 `nodeIssues`。两者都选中目标节点并打开对话。

删除统一生成：

```ts
{ type: 'remove-nodes', nodeIds: [selectedNodeId] }
```

关联边数量从当前权威 document 计算；键盘 `Delete`/`Backspace` 调用同一打开确认框命令，事件目标满足 `input, textarea, [contenteditable="true"], [role="textbox"]` 时直接返回。运行中节点必须完成 STOP 并收到当前 generation 的终态后才 enqueue 删除；主进程仍保留最终守卫。

命中 `nodeIssues` 的 conversation node 改渲染 `CanvasAgentRecoveryPanel`；重建调用 `adapter.rebuildCanvasAgentNode()`，成功替换 snapshot。健康节点才渲染 `CanvasAgentConversation`。

- [ ] **Step 6: 移除所有 Renderer 原始 Error.message 展示**

删除 `getNativeCanvasErrorMessage(error)` 对 `error.message` 的读取，改成按操作固定文案；`CanvasAgentConversation` 的 GET/SEND/STOP 未知异常分别显示：

```ts
const CANVAS_AGENT_ERROR_MESSAGES = {
  load: '对话暂时无法加载。',
  send: '发送失败，请重试。',
  stop: '停止失败，请重试。',
} as const
```

若错误是 `CanvasPublicOperationError`，仅使用其共享安全 message。标题栏、Toast、恢复条和面板不得拼接捕获异常。

- [ ] **Step 7: 运行组件测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.test.tsx apps/electron/src/renderer/components/design/CanvasAgentRecoveryPanel.test.tsx apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: PASS；顶部添加为独立节点，节点侧添加自动连线，删除确认说明对话保留，坏节点不访问消息 API，编辑器焦点不误删，界面无内部异常正文。

- [ ] **Step 8: 提交完整 Renderer 操作面**

```bash
git add apps/electron/src/renderer/components/design/NativeCanvasToolbar.tsx apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.tsx apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.test.tsx apps/electron/src/renderer/components/design/CanvasAgentRecoveryPanel.tsx apps/electron/src/renderer/components/design/CanvasAgentRecoveryPanel.test.tsx apps/electron/src/renderer/components/design/CanvasAgentConversation.tsx apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
git commit -m "功能：完善 Canvas 节点工具栏与恢复交互"
```

### Task 9: 全链路回归、真实窗口验收与记忆收口

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: 运行最小全链路测试集**

Run:

```bash
bun test packages/shared/src/types/canvas.test.ts \
  apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts \
  apps/electron/src/main/lib/design/canvas-document-ipc.test.ts \
  apps/electron/src/main/lib/design/canvas-session-ipc.test.ts \
  apps/electron/src/main/lib/design/canvas-agent-run-policy.test.ts \
  apps/electron/src/preload/design-preload.test.ts \
  apps/electron/src/renderer/lib/design-adapter.test.ts \
  apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts \
  apps/electron/src/renderer/components/design/native-canvas-model.test.ts \
  apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx \
  apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx \
  apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
```

Expected: 全部 PASS；若测试发现共享 fixture 缺少必填 `nodeIssues`，只修正 fixture，不把字段重新改为可选。

- [ ] **Step 2: 运行关联生命周期回归**

Run:

```bash
bun test apps/electron/src/renderer/hooks/useGlobalAgentListeners.canvas.test.ts \
  apps/electron/src/renderer/lib/canvas-agent-event-routing.test.ts \
  apps/electron/src/renderer/components/app-shell/LeftSidebar.canvas-archive.test.ts \
  apps/electron/src/renderer/atoms/canvas-session-atoms.test.ts
```

Expected: 全部 PASS；Canvas 内部新旧 session 仍不进入普通列表、未读、通知、归档和 Agent completion Toast。

- [ ] **Step 3: 运行类型检查与 Electron 构建**

Run: `bun run typecheck`

Expected: exit 0，无 `any`、共享合同或 preload bridge 类型错误。

Run: `CLANG_MODULE_CACHE_PATH=/private/tmp/proma-clang-cache SWIFT_MODULE_CACHE_PATH=/private/tmp/proma-swift-cache bun run electron:build`

Expected: exit 0，主进程、preload 和 renderer 均成功构建。

- [ ] **Step 4: 启动开发版并完成真实窗口验收**

Run: `bun run dev`

在真实 Electron 窗口按以下顺序验收，并为 1200px 宽、620px 宽、浅色、深色各保留截图证据：

1. 顶部工具栏悬浮居中，不遮挡右侧对话或缩放控件；选择和平移切换后行为匹配图标状态。
2. 顶部“添加节点 -> Agent”生成无边独立节点并自动选中；生图、视觉文档、原型显示禁用原因且不触发任务或费用。
3. 健康节点右侧 `+ -> Agent` 在右侧确定性落点并生成一条 `source -> target` 连线；连续点击/重试不重复。
4. 删除健康闲置节点显示关联边数量与“Agent 对话记录会保留”，确认后节点和边消失。
5. 运行中节点选择删除时先停止；停止失败或仍运行时节点保留。
6. 打开现有坏节点 Canvas 时其余节点仍可拖动、缩放、添加和对话；坏节点显示“会话不可用”，不出现顶部致命红条。
7. 坏节点“重建会话”后保留位置、标题和边，右侧出现空白对话；“删除节点”走相同确认框。
8. 切换 Canvas、重载窗口、触发 recovery 后，旧 `nodeIssues`、迟到创建/重建和旧对话请求不污染当前 Canvas。
9. 全界面搜索确认不显示 `Error invoking remote method`、session UUID、绝对路径或堆栈。

- [ ] **Step 5: 检查性能与资源边界**

在开发工具验证一次 LOAD 不读取坏节点 JSONL、不启动 Agent；1000 节点场景 DOM 仍显著少于节点总量。确认 `nodeIssues` 未出现在项目 `canvas.json`，扩展一次只新增一个 session、一个节点、一条边和一次 revision，重建不复制旧消息。

- [ ] **Step 6: 回写实现结论到 MEMORY**

在 `MEMORY.md` 末尾增加一条可长期复用的架构事实：

```md
- 2026-08-26：原生 Canvas 节点命令统一由顶部工具栏与节点侧扩展入口触发；扩展节点和边共享事务 revision，删除保留底层会话并受主进程 active-run 守卫。committed 坏会话只派生内存 `nodeIssues`，重建通过独立可恢复 intent 换绑空白 session；Preload/Adapter 只允许公开错误信封进入 Renderer。
```

- [ ] **Step 7: 检查差异并提交验证收口**

Run: `git diff --check`

Expected: exit 0，无空白错误。

Run: `git status --short`

Expected: 只包含本任务相关修改与既有未跟踪 `.superpowers/`；`.superpowers/` 不加入提交。

```bash
git add MEMORY.md
git commit -m "文档：记录 Canvas 节点操作与恢复边界"
```

## 完成标准

- 顶部工具栏、独立添加、节点扩展、删除确认、停止后删除和坏节点重建均在真实 Electron 窗口可用。
- 单个 committed session 缺失或归属异常不再阻断整张 Canvas；文档、授权、schema、未完成事务和持久性不确定仍 fail closed。
- 扩展创建、重建和删除都受权威 revision、workspace lease、stable-directory capability 与运行态守卫保护。
- Renderer 不读取坏节点消息，不展示原始 `Error.message`，不泄露 IPC 前缀、UUID、绝对路径或堆栈。
- 普通 Agent 会话列表、搜索、归档、最近记录、未读、通知、状态岛、项目记忆和 LAN/mobile 行为无回归。
- 定向测试、关联生命周期回归、`bun run typecheck` 与 `bun run electron:build` 全部通过，真实窗口截图覆盖宽窄与深浅主题。
