# Canvas 多类型节点基础层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可独立验证的 Canvas 多类型节点基础层：兼容迁移旧文档，始终通过类型菜单创建四种空节点，保持 viewport 不变，以折叠卡片和单一节点内工作台承载交互，并为非 Agent 节点提供可恢复删除与恢复。

**Architecture:** 保留现有 Agent 可恢复创建事务，不重写已验证的会话安全链；新增非 Agent 内容存储与 intent 事务，由主进程在稳定 Canvas 根内原子维护内容身份和图引用。Renderer 只持有图快照与 `expandedNodeId` 临时状态，顶部创建采用全局最右侧 O(N) 追加算法，节点侧扩展继续沿用右侧创建并自动连线的既有空间语义。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Jotai、XYFlow、Radix DropdownMenu/Dialog、Tailwind CSS、现有 stable-directory helper 与 safe-file 原子写边界。

---

## 实施边界与文件职责

执行前置：当前工作区已有前序 Canvas 与 LAN 修复的未提交改动，而且本计划会继续修改其中部分文件。正式执行前必须先对现有改动运行其定向测试、类型检查和 Electron 构建，并单独形成中文提交；本计划各 Task 的提交不得夹带 `.superpowers/` 或与该 Task 无关的既有改动。

- `packages/shared/src/types/canvas.ts`：schema v2、四类节点、通用创建/删除/回收区 IPC 合同和公开错误。
- `apps/electron/src/main/lib/design/canvas-document-store.ts`：v1 文档解析、v2 规范化和安全写回，不承载节点正文。
- `apps/electron/src/main/lib/design/design-paths.ts`：只由可信 Canvas 根派生 `nodes`、`trash` 与 `transactions` 目录。
- `apps/electron/src/main/lib/design/canvas-node-content-store.ts`：空内容、内容身份、trash entry 的严格解析与稳定目录 I/O。
- `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts`：非 Agent 创建、删除、恢复的可恢复 intent 状态机。
- `apps/electron/src/main/lib/design/canvas-document-ipc.ts`：四层合同的主进程入口、同 Canvas 串行和安全错误信封。
- `apps/electron/src/preload/design-preload.ts`：最小类型安全 bridge，不暴露路径和内部 intent。
- `apps/electron/src/renderer/lib/design-adapter.ts`：解包公开错误信封并提供 Renderer 统一节点命令。
- `apps/electron/src/renderer/components/design/native-canvas-model.ts`：全局追加、节点投影与 O(N) 性能边界。
- `apps/electron/src/renderer/components/design/CanvasNodeCard.tsx`：四类节点共享的固定尺寸折叠卡片。
- `apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.tsx`：节点锚定的单一临时工作台壳，不读重内容。
- `apps/electron/src/renderer/atoms/native-canvas-atoms.ts`：`expandedNodeId` 与草稿切换状态，和持久图状态隔离。
- `apps/electron/src/renderer/components/design/NativeCanvasToolbar.tsx`：始终打开类型菜单，视频只作为禁用预留项。
- `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`：通用创建控制器、节点选择、工作台切换、删除与恢复命令编排。

性能合同：折叠图不读取 JSONL、Markdown、HTML、图片历史；落点只扫描 `document.nodes` 一次；展开覆盖层不改变持久化尺寸、位置、边或 viewport；同一时间最多挂载一个工作台。

## Task 1: 将 Canvas schema 升级到 v2 并兼容旧视觉文档

**Files:**
- Modify: `packages/shared/src/types/canvas.ts:5-280`
- Modify: `packages/shared/src/types/canvas.test.ts:1-360`
- Modify: `apps/electron/src/main/lib/design/canvas-document-store.ts:170-360`
- Modify: `apps/electron/src/main/lib/design/canvas-document-store.test.ts`

- [ ] **Step 1: 写 v2 节点合同与 v1 迁移失败测试**

```ts
test('Given v1 视觉文档 When LOAD Then 迁移为 v2 document 且保留身份', () => {
  const migrated = parseCanvasDocument(v1Document, target)
  expect(migrated.document).toMatchObject({
    schemaVersion: 2,
    nodes: [{
      id: 'node-document',
      kind: 'document',
      documentId: 'visual-document-1',
      contentRevision: 0,
    }],
  })
  expect(migrated.migratedFrom).toBe(1)
})

test('Given v2 mutation When 节点仍使用 visual-document Then 拒绝旧类型', () => {
  expect(() => parseCanvasDocument(v2WithLegacyNode, target)).toThrow('CANVAS_DOCUMENT_INVALID')
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts`

Expected: FAIL，提示 `CANVAS_DOCUMENT_VERSION` 仍为 `1`、`document` 节点类型不存在或解析结果没有 `migratedFrom`。

- [ ] **Step 3: 定义 v2 共享类型与严格迁移结果**

```ts
/** 独立 Canvas 图文档当前写出版本。 */
export const CANVAS_DOCUMENT_VERSION = 2

/** 新写入只允许四种真实节点类型。 */
export type CanvasNodeKind = 'agent' | 'image' | 'document' | 'webview'

export interface CanvasImageNode extends CanvasNodeBase {
  kind: 'image'
  imageModuleId: string
  adoptedAssetId?: string
}

export interface CanvasDocumentNode extends CanvasNodeBase {
  kind: 'document'
  documentId: string
  contentRevision: number
}

export interface CanvasWebviewNode extends CanvasNodeBase {
  kind: 'webview'
  prototypeId: string
  contentRevision: number
}

export type CanvasNode = CanvasAgentNode | CanvasImageNode | CanvasDocumentNode | CanvasWebviewNode
```

在 Store 中把解析入口改为显式结果，只有顶层 `schemaVersion === 1` 时允许旧节点字段：

```ts
/** Canvas 解析结果同时说明是否需要安全迁移写回。 */
export interface ParsedCanvasDocument {
  document: CanvasDocument
  migratedFrom?: 1
  legacyContentSeeds: LegacyCanvasContentSeed[]
}

/** 旧图字段只作为迁移种子，不进入 v2 CanvasDocument。 */
export interface LegacyCanvasContentSeed {
  kind: 'image' | 'document' | 'webview'
  contentId: string
  adoptedAssetId?: string
  legacySourceUrl?: string
}

/** 严格解析 v1/v2，任何 v2 文档中的旧节点类型都直接拒绝。 */
export function parseCanvasDocument(value: unknown, target: CanvasTarget): ParsedCanvasDocument {
  if (!isRecord(value)) throw new Error('CANVAS_DOCUMENT_INVALID')
  if (value.schemaVersion === 1) {
    return parseCanvasDocumentV1(value, target)
  }
  if (value.schemaVersion === CANVAS_DOCUMENT_VERSION) {
    return { document: parseCanvasDocumentV2(value, target), legacyContentSeeds: [] }
  }
  throw new Error('CANVAS_DOCUMENT_INVALID')
}
```

`parseCanvasDocumentV1()` 必须逐字段重建，执行以下确定性映射：`visual-document.visualDocumentId -> document.documentId`、`contentRevision = 0`；旧 `image.assetId -> image.imageModuleId` 且同时写入 `adoptedAssetId`；旧 `webview.url` 不再作为权威正文，把旧节点 ID 作为 `prototypeId`，并把 URL 放入 `legacyContentSeeds.legacySourceUrl`。迁移种子只能留在主进程解析结果中，不能进入 v2 图文档或 IPC。

- [ ] **Step 4: 让 Store 在内存中返回规范化结果并保留迁移种子**

```ts
interface CanvasCandidateState {
  exists: boolean
  parsed: ParsedCanvasDocument | null
  state?: AtomicFileState
}

interface CanvasDocumentReadResult {
  document: CanvasDocument | null
  migratedFrom?: 1
  legacyContentSeeds: LegacyCanvasContentSeed[]
  primaryExpectation: AtomicDestinationExpectation
  recoveredFrom?: NonNullable<CanvasWorkspaceSnapshot['recoveredFrom']>
  hasCandidate: boolean
  recoveredState?: AtomicFileState
}
```

`loadWithAuthoritativeState()` 在读取 v1 后立即向上层返回规范化 v2 文档和私有 `legacyContentSeeds`，但本任务不覆盖磁盘主文件。Task 3 会在内容存储可用后，通过可恢复 migration intent 先落内容再安全写回 v2；这样旧 webview URL 不会因任务顺序丢失。公开 `CanvasWorkspaceSnapshot` 仍只包含 v2 document，不包含迁移种子。

- [ ] **Step 5: 运行测试确认 GREEN**

Run: `bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts`

Expected: PASS；覆盖 v1 主文件、v1 tmp/backup、v2 正常加载、v2 旧类型拒绝、迁移种子不跨公开 snapshot。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-store.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts
git commit -m "功能：升级 Canvas 多类型节点文档合同"
```

## Task 2: 建立非 Agent 节点内容与回收区的稳定存储边界

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Modify: `packages/shared/src/types/canvas.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-paths.ts:28-153`
- Modify: `apps/electron/src/main/lib/design/design-paths.test.ts`
- Create: `apps/electron/src/main/lib/design/canvas-node-content-store.ts`
- Create: `apps/electron/src/main/lib/design/canvas-node-content-store.test.ts`

- [ ] **Step 1: 写路径、空内容和 trash entry 的失败测试**

```ts
test('Given 三种内容节点 When prepareEmptyContent Then 只在受管 nodes 根创建最小内容', async () => {
  await store.prepareEmptyContent(target, { kind: 'document', contentId: 'document-1' })
  expect(await readText('nodes/document-1/content.md')).toBe('')
  expect(await readJson('nodes/document-1/meta.json')).toMatchObject({
    schemaVersion: 1,
    kind: 'document',
    contentId: 'document-1',
    revision: 0,
  })
})

test('Given 内容目录已存在但身份不匹配 When 重放创建 Then fail closed', async () => {
  await seedContent({ kind: 'webview', contentId: 'shared-id' })
  await expect(store.prepareEmptyContent(target, {
    kind: 'image', contentId: 'shared-id',
  })).rejects.toThrow('CANVAS_CONTENT_IDENTITY_CONFLICT')
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/canvas-node-content-store.test.ts`

Expected: FAIL，提示 `nodesDir`、`trashDir` 或 `createCanvasNodeContentStore` 不存在。

- [ ] **Step 3: 扩展可信路径结果**

```ts
export interface CanvasPaths {
  projectId: string
  canvasId: string
  canvasRoot: string
  documentPath: string
  nodesDir: string
  trashDir: string
  transactionsDir: string
  cacheRoot: string
  jobsDir: string
  tracesDir: string
  stagingDir: string
  thumbnailsDir: string
}
```

`resolveCanvas()` 只通过 `join(canvasRoot, 'nodes')` 与 `join(canvasRoot, 'trash')` 产生路径。Renderer 和 IPC 输入不得包含这些字段。

- [ ] **Step 4: 实现严格内容元数据与幂等空内容**

```ts
export type CanvasContentKind = 'image' | 'document' | 'webview'

export interface CanvasNodeContentMeta {
  schemaVersion: 1
  kind: CanvasContentKind
  contentId: string
  revision: number
  createdAt: number
  updatedAt: number
}

/** Renderer 可见的回收区条目，不包含磁盘路径。 */
export interface CanvasTrashEntry {
  schemaVersion: 1
  trashId: string
  nodeId: string
  kind: CanvasContentKind
  contentId: string
  title: string
  position: DesignPoint
  deletedRevision: number
  deletedAt: number
}
```

`CanvasTrashEntry` 定义在 `packages/shared/src/types/canvas.ts`；`canvas-node-content-store.ts` 只导入并严格解析该合同，不创建主进程私有同名类型。

`CanvasNodeContentStore` 提供以下窄接口，所有实现都从 `CanvasDocumentStore.loadWithDirectoryCapability()` 获取同次授权，并使用 stable-directory helper 相对打开：

```ts
export interface CanvasNodeContentStore {
  prepareEmptyContent: (
    target: CanvasTarget,
    input: { kind: CanvasContentKind; contentId: string },
  ) => Promise<void>
  prepareMigratedContent: (
    target: CanvasTarget,
    seed: LegacyCanvasContentSeed,
  ) => Promise<void>
  assertContent: (
    target: CanvasTarget,
    input: { kind: CanvasContentKind; contentId: string },
  ) => Promise<CanvasNodeContentMeta>
  moveToTrash: (target: CanvasTarget, entry: CanvasTrashEntry) => Promise<void>
  restoreFromTrash: (target: CanvasTarget, trashId: string) => Promise<CanvasTrashEntry>
  listTrash: (target: CanvasTarget) => Promise<CanvasTrashEntry[]>
}
```

最小内容固定为：生图 `config.json` 含空提示词和 `selectedModelProfileId: null`；文档 `content.md` 为空且 `meta.json.revision = 0`；原型 `index.html` 为不含脚本与外链的最小 HTML，`meta.json.revision = 0`。`prepareMigratedContent()` 对旧 webview 只把 URL 保存为 `meta.json.legacySourceUrl`，不生成自动联网 HTML；对旧图片保存 `adoptedAssetId`；视觉文档生成空 Markdown。重复调用只有身份完全相等才成功，符号链接、reparse point、未知字段、超限文件或跨根路径一律拒绝。

- [ ] **Step 5: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/canvas-node-content-store.test.ts`

Expected: PASS；覆盖三种空内容、幂等重放、身份冲突、no-follow、trash 列表上限和损坏单项隔离。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/design-paths.ts apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/canvas-node-content-store.ts apps/electron/src/main/lib/design/canvas-node-content-store.test.ts
git commit -m "功能：建立 Canvas 节点内容与回收区存储"
```

## Task 3: 实现非 Agent 创建、删除与恢复的可恢复事务

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Modify: `packages/shared/src/types/canvas.test.ts`
- Create: `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts`
- Create: `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts`

- [ ] **Step 1: 写三类创建与删除恢复 BDD 失败测试**

```ts
test.each(['image', 'document', 'webview'] as const)(
  'Given %s 创建意图 When 内容已建但图提交前中断 Then reconcile 完成同一节点',
  async (kind) => {
    await seedIntent({ kind, state: 'content-created' })
    const result = await service.reconcile(target)
    expect(result.snapshot.document.nodes).toContainEqual(
      expect.objectContaining({ id: 'node-1', kind }),
    )
    expect(result.documentChanged).toBe(true)
  },
)

test('Given 文档节点已删除 When restore Then 内容身份不变且节点回到新 revision', async () => {
  const deleted = await service.deleteReconciled({ ...target, nodeId: 'node-document' })
  const restored = await service.restoreReconciled({
    ...target,
    trashId: deleted.trashEntry!.trashId,
    position: { x: 640, y: 80 },
  })
  expect(restored.document.nodes[0]).toMatchObject({
    id: 'node-document', documentId: 'document-1', contentRevision: 0,
  })
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts`

Expected: FAIL，提示 lifecycle service 与共享输入类型不存在。

- [ ] **Step 3: 定义通用公开命令**

```ts
export interface CreateCanvasContentNodeInput extends CanvasTarget {
  operationId: string
  nodeId: string
  kind: 'image' | 'document' | 'webview'
  contentId: string
  title: string
  position: DesignPoint
  expectedRevision: number
  relationship?: CreateCanvasAgentNodeRelationship
}

export interface DeleteCanvasNodeInput extends CanvasAgentTarget {
  operationId: string
  expectedRevision: number
}

export interface RestoreCanvasNodeInput extends CanvasTarget {
  operationId: string
  trashId: string
  expectedRevision: number
  position: DesignPoint
}

export interface CanvasNodeLifecycleResult {
  snapshot: CanvasWorkspaceSnapshot
  selectedNodeId?: string
  trashEntry?: CanvasTrashEntry
}
```

- [ ] **Step 4: 实现可恢复 intent 状态机**

```ts
export type CanvasContentNodeIntentState =
  | 'prepared'
  | 'content-created'
  | 'committed'
  | 'trashed'
  | 'restored'

export interface CanvasContentNodeIntent {
  schemaVersion: 1
  operation: 'migrate' | 'create' | 'delete' | 'restore'
  state: CanvasContentNodeIntentState
  operationId: string
  projectId: string
  canvasId: string
  node: CanvasNode
  expectedRevision: number
  trashId?: string
  createdAt: number
  updatedAt: number
}
```

v1 migration 固定为 `prepared intent -> prepareMigratedContent -> content-created -> v2 document CAS 写回 -> committed`，写回保持 graph `revision`、`createdAt`、`updatedAt` 不变；并发主文件身份变化时停止并重新 LOAD，禁止覆盖。创建顺序固定为 `prepared intent -> empty content -> content-created -> graph mutate（可选 relationship 与节点同 revision）-> committed`；删除非 Agent 固定为 `prepared -> moveToTrash -> trashed -> remove-node mutation -> committed`；恢复固定为 `prepared -> restoreFromTrash -> restored -> upsert-node mutation -> committed`。每次 LOAD/CREATE/DELETE/RESTORE 先扫描合法 intent 并完成对账；同一 operationId 只有全部输入相同才允许幂等重放。Agent 删除仍只执行 graph removal 并保留 session，不进入 trash。

图提交 durable 但 intent durability 未确认时，结果必须携带需要发布的 graph revision 并原样传播明确错误，沿用 `CanvasAgentNodePublishedError` 的发布语义，不能把已可见节点伪装成完全失败。

- [ ] **Step 5: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts`

Expected: PASS；Agent create/rebuild/detach 回归不变，v1 migration 完整写回且保留旧内容种子，三类内容节点在每个中断点可恢复，创建失败对账后没有孤立内容或图引用。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts
git commit -m "功能：接通 Canvas 内容节点可恢复生命周期"
```

## Task 4: 接通四层 IPC、Preload 与 Renderer Adapter

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Modify: `packages/shared/src/types/canvas.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts:1-780`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts:190-200,1740-1770`
- Modify: `apps/electron/src/preload/design-preload.ts:1-210`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts:1-210`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写四层调用与公开错误失败测试**

```ts
test('Given Renderer 创建文档节点 When invoke Then 四层只传稳定公开字段', async () => {
  const result = await api.createCanvasContentNode({
    projectId: 'p1', canvasId: 'canvas-1',
    operationId: OPERATION_ID, nodeId: 'node-1',
    kind: 'document', contentId: 'document-1', title: '文档',
    position: { x: 0, y: 0 }, expectedRevision: 2,
  })
  expect(invoke).toHaveBeenCalledWith('canvas:create-content-node', expect.any(Object))
  expect(result).toEqual({ ok: true, value: expect.any(Object) })
})

test('Given 内部路径错误 When 创建失败 Then Renderer 只收到公开中文错误', async () => {
  lifecycle.createReconciled.mockRejectedValue(new Error('/private/path/intent.json'))
  const result = await handler(event, validInput)
  expect(result).toEqual({
    ok: false,
    error: { code: 'CANVAS_CREATE_FAILED', message: '节点创建失败，请重试。' },
  })
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: FAIL，提示新通道、Preload 方法或 Adapter 方法不存在。

- [ ] **Step 3: 增加稳定 IPC 通道和公开错误码**

```ts
export const CANVAS_IPC_CHANNELS = {
  LOAD: 'canvas:load',
  SAVE_MUTATIONS: 'canvas:save-mutations',
  CREATE_AGENT_NODE: 'canvas:create-agent-node',
  CREATE_CONTENT_NODE: 'canvas:create-content-node',
  REBUILD_AGENT_NODE: 'canvas:rebuild-agent-node',
  DELETE_NODE: 'canvas:delete-node',
  LIST_TRASH: 'canvas:list-trash',
  RESTORE_NODE: 'canvas:restore-node',
  LIST_ACTIVE_AGENT_RUNS: 'canvas:list-active-agent-runs',
  GET_AGENT_MESSAGES: 'canvas:get-agent-messages',
  SEND_AGENT_MESSAGE: 'canvas:send-agent-message',
  STOP_AGENT: 'canvas:stop-agent',
  CHANGED: 'canvas:changed',
} as const

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
  | 'CANVAS_CONTENT_INVALID'
  | 'CANVAS_DELETE_FAILED'
  | 'CANVAS_RESTORE_FAILED'
```

- [ ] **Step 4: 在主进程注册同 Canvas 串行 handler**

在 `CanvasDocumentIpcOptions` 注入：

```ts
contentLifecycle: Pick<CanvasContentNodeLifecycleService,
  'reconcile' | 'createReconciled' | 'deleteReconciled' | 'restoreReconciled' | 'listTrash'>
```

四个写入口必须复用现有 `runCanvasExclusive(projectId, canvasId)` 与 `guard.runWorkspaceWrite()`；先发布 Agent/content 两类 reconciliation 的 recovery/graph 事实，再发布本次操作 revision。输入采用 exact-key、长度、UUID、稳定 ID、finite position 和 safe integer revision 校验。

- [ ] **Step 5: 补齐 Preload 与 Adapter**

```ts
export interface DesignPreloadApi {
  createCanvasContentNode: (
    input: CreateCanvasContentNodeInput,
  ) => Promise<CanvasInvokeResult<CanvasNodeLifecycleResult>>
  deleteCanvasNode: (
    input: DeleteCanvasNodeInput,
  ) => Promise<CanvasInvokeResult<CanvasNodeLifecycleResult>>
  listCanvasTrash: (
    input: CanvasTarget,
  ) => Promise<CanvasInvokeResult<CanvasTrashEntry[]>>
  restoreCanvasNode: (
    input: RestoreCanvasNodeInput,
  ) => Promise<CanvasInvokeResult<CanvasNodeLifecycleResult>>
}
```

Adapter 使用既有 `callCanvasApi()` 解包，不记录内部错误正文；缺失 bridge 时返回稳定中文错误。`apps/electron/src/main/ipc.ts` 创建单例 content store/lifecycle，并显式注入 Canvas document IPC。

- [ ] **Step 6: 运行测试确认 GREEN**

Run: `bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: PASS；四个新通道、授权窗口、只读项目、revision 冲突、跨 Canvas 串行和不同 Canvas 并行均有断言。

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "功能：接通 Canvas 多类型节点四层接口"
```

## Task 5: 替换顶部落点算法并保证 viewport 零变化

**Files:**
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.ts:14-205`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.test.ts`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写全局追加与 viewport 不变失败测试**

```ts
test('Given 已平移缩放且已有多列节点 When 顶部添加 Then 追加到全局最右侧且基线对齐首节点', () => {
  const position = findNativeCanvasGlobalAppendPosition(
    { x: 320, y: 180 },
    [
      { id: 'first', position: { x: -200, y: 40 } },
      { id: 'right', position: { x: 500, y: 300 } },
    ],
  )
  expect(position).toEqual({ x: 812, y: 40 })
})

test('Given 顶部创建成功 When 接管权威文档 Then 不排队 set-viewport 且不自动展开', async () => {
  await createFromToolbar('document')
  expect(state.snapshot!.document.viewport).toEqual(beforeViewport)
  expect(state.pendingMutations).not.toContainEqual(expect.objectContaining({ type: 'set-viewport' }))
  expect(state.expandedNodeId).toBeNull()
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: FAIL；当前算法仍从可视中心方形环落点，创建成功仍写 `conversationNodeId` 或 reveal viewport。

- [ ] **Step 3: 实现 O(N) 全局追加算法**

```ts
/** 顶部独立创建只按权威图顺序和全局最右边界追加。 */
export function findNativeCanvasGlobalAppendPosition(
  emptyCanvasCenter: DesignPoint,
  nodes: ReadonlyArray<NativeCanvasIdentifiedPositionedNode>,
): DesignPoint {
  if (nodes.length === 0) {
    return {
      x: emptyCanvasCenter.x - NATIVE_CANVAS_NODE_WIDTH / 2,
      y: emptyCanvasCenter.y - NATIVE_CANVAS_NODE_HEIGHT / 2,
    }
  }
  /** 首个仍存在节点提供稳定纵向基线。 */
  const baselineY = nodes[0].position.y
  /** 单次扫描得到所有持久化边界的最右侧。 */
  const maxRight = nodes.reduce(
    (right, node) => Math.max(right, node.position.x + NATIVE_CANVAS_NODE_WIDTH),
    Number.NEGATIVE_INFINITY,
  )
  const x = maxRight + NATIVE_CANVAS_NODE_GAP
  const verticalStep = NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP
  for (let row = 0; row <= nodes.length; row += 1) {
    const candidate = { x, y: baselineY + row * verticalStep }
    if (!overlapsNativeCanvasNodes(candidate, nodes)) return candidate
  }
  throw new Error('Canvas 全局追加落点计算失败')
}

/** 判断固定尺寸候选是否侵入已有节点的最小间距。 */
function overlapsNativeCanvasNodes(
  candidate: DesignPoint,
  nodes: ReadonlyArray<NativeCanvasPositionedNode>,
): boolean {
  const horizontalStep = NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP
  const verticalStep = NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP
  return nodes.some((node) => (
    Math.abs(candidate.x - node.position.x) < horizontalStep
    && Math.abs(candidate.y - node.position.y) < verticalStep
  ))
}
```

抽出模块级 `overlapsNativeCanvasNodes()` 供全局追加和节点侧扩展复用；删除 `createNativeCanvasNodeRevealViewport()` 及 Workspace 的 reveal layout effect。空 Canvas 的 `emptyCanvasCenter` 只在第一次创建时由真实 surface 和当前 viewport 换算，非空 Canvas 完全忽略当前平移缩放。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: PASS；空 Canvas 居中、非空全局最右追加、占用后向下、负坐标、平移缩放无影响、节点侧扩展算法回归均通过。

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/renderer/components/design/native-canvas-model.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
git commit -m "修复：保持 Canvas 添加节点时视口稳定"
```

## Task 6: 让顶部添加始终显示五项类型菜单

**Files:**
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasToolbar.tsx:1-230`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx`

- [ ] **Step 1: 写菜单、键盘和禁用视频失败测试**

```tsx
test('Given 工具栏可写 When 点击添加 Then 四种节点可选且视频禁用', async () => {
  const selected: CanvasNodeKind[] = []
  render(<NativeCanvasToolbar {...baseProps} onAddNode={(kind) => selected.push(kind)} />)
  await user.click(screen.getByRole('button', { name: '添加节点' }))
  expect(screen.getByRole('menuitem', { name: 'Agent' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: '生图' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: '文档' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: '原型' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: '视频，即将支持' })).toHaveAttribute('aria-disabled', 'true')
  await user.click(screen.getByRole('menuitem', { name: '文档' }))
  expect(selected).toEqual(['document'])
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx`

Expected: FAIL；当前单可用类型直接执行 Agent，且菜单没有视频项。

- [ ] **Step 3: 实现固定类型菜单**

```ts
export const NATIVE_CANVAS_NODE_TYPE_OPTIONS = [
  { kind: 'agent', label: 'Agent', enabled: true },
  { kind: 'image', label: '生图', enabled: true },
  { kind: 'document', label: '文档', enabled: true },
  { kind: 'webview', label: '原型', enabled: true },
  { kind: 'video', label: '视频', enabled: false },
] as const
```

删除 `ENABLED_NATIVE_CANVAS_NODE_TYPE_OPTIONS.length === 1` 快捷分支；`NativeCanvasToolbarProps` 改为 `onAddNode: (kind: CanvasNodeKind) => void`。视频只存在于菜单 option，不加入 `CanvasNodeKind`；禁用项可见文本显示“即将支持”，`aria-label` 为“视频，即将支持”，不绑定 `onSelect`。保留 Radix 原生 ArrowUp/ArrowDown/Enter/Escape 和焦点行为。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx`

Expected: PASS；鼠标与键盘均能选择四种类型，Escape 关闭，视频不触发回调，窄宽度标签不溢出。

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/renderer/components/design/NativeCanvasToolbar.tsx apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx
git commit -m "功能：开放 Canvas 多类型节点添加菜单"
```

## Task 7: 投影四种折叠节点并保持 1000 节点裁剪能力

**Files:**
- Create: `apps/electron/src/renderer/components/design/CanvasNodeCard.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasAgentNode.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasAgentNode.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.ts:75-300`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.test.ts`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx:20-310`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

- [ ] **Step 1: 写四类卡片与懒加载失败测试**

```tsx
test.each([
  ['agent', 'Agent'], ['image', '生图'], ['document', '文档'], ['webview', '原型'],
] as const)('Given %s 节点 When 折叠渲染 Then 显示类型和展开入口', (kind, label) => {
  render(<CanvasNodeCard {...fixture(kind)} />)
  expect(screen.getByText(label)).toBeVisible()
  expect(screen.getByRole('button', { name: `展开${label}工作台` })).toBeVisible()
  expect(loadHeavyContent).not.toHaveBeenCalled()
})

test('Given 1000 个折叠节点 When 投影 Then 无边节点仍使用空 handles', () => {
  const nodes = toNativeCanvasFlowNodes(createDocument(1000), options)
  expect(nodes).toHaveLength(1000)
  expect(nodes.every((node) => node.handles?.length === 0)).toBe(true)
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/CanvasAgentNode.test.tsx apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

Expected: FAIL；非 Agent 节点仍投影为 unsupported，且没有通用展开入口。

- [ ] **Step 3: 实现固定尺寸通用卡片**

```ts
export interface CanvasNodeCardProps {
  id: string
  kind: CanvasNodeKind
  title: string
  statusLabel: string
  summary: string
  selected: boolean
  canExpand: boolean
  onExpand?: (nodeId: string) => void
  onCreateChild?: (sourceNodeId: string) => void
}
```

`CanvasNodeCard` 固定 `288 x 144`，标题最多两行、摘要单行截断，使用 Lucide `Bot/FileImage/FileText/Monitor`。展开按钮使用 `Maximize2` 图标并有 Tooltip；节点侧 `+` 仍调用 `onCreateChild(id)`。卡片只消费图文档摘要和运行态，不接受内容加载函数。

- [ ] **Step 4: 替换 unsupported 投影**

`toNativeCanvasFlowNodes()` 分别生成 `canvasAgent`、`canvasImage`、`canvasDocument`、`canvasWebview` 节点类型；共享 `width`、`height` 和静态 `handles` 索引。`NativeCanvasGraph` 的 `NATIVE_CANVAS_NODE_TYPES` 注册四个轻量节点组件，节点双击和卡片展开按钮都调用 `onWorkbenchNodeChange(node.id)`；普通单击只选择，不展开。

- [ ] **Step 5: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/CanvasAgentNode.test.tsx apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

Expected: PASS；四类折叠节点可达、无重内容读取、1000 节点投影保持 O(N) 且 `onlyRenderVisibleElements` 不回退。

- [ ] **Step 6: 提交**

```bash
git add apps/electron/src/renderer/components/design/CanvasNodeCard.tsx apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/CanvasAgentNode.tsx apps/electron/src/renderer/components/design/CanvasAgentNode.test.tsx apps/electron/src/renderer/components/design/native-canvas-model.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx
git commit -m "功能：统一 Canvas 四类折叠节点卡片"
```

## Task 8: 增加单一节点内工作台临时状态与锚定覆盖层

**Files:**
- Modify: `apps/electron/src/renderer/atoms/native-canvas-atoms.ts:11-62`
- Modify: `apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts`
- Create: `apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx:760-1190`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写单工作台、零布局 mutation 与草稿保护失败测试**

```tsx
test('Given 文档工作台已打开 When 展开原型 Then 同时只挂载原型工作台', async () => {
  await openWorkbench('node-document')
  await openWorkbench('node-webview')
  expect(screen.queryByLabelText('文档工作台')).not.toBeInTheDocument()
  expect(screen.getByLabelText('原型工作台')).toBeVisible()
  expect(state.expandedNodeId).toBe('node-webview')
})

test('Given 工作台展开收起 When 检查 mutation Then 不修改 viewport、位置或边', async () => {
  const before = structuredClone(state.snapshot!.document)
  await openWorkbench('node-image')
  await closeWorkbench()
  expect(state.snapshot!.document).toEqual(before)
  expect(state.pendingMutations).toEqual([])
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: FAIL；当前只有 `conversationNodeId` 右侧 Agent 面板，没有 `expandedNodeId` 与节点锚定覆盖层。

- [ ] **Step 3: 将临时工作台状态加入 Jotai**

```ts
export interface NativeCanvasWorkbenchDraftState {
  nodeId: string
  dirty: boolean
}

export interface NativeCanvasState {
  // 保留现有图状态字段
  expandedNodeId: string | null
  pendingWorkbenchSwitchNodeId: string | null
  workbenchDraft: NativeCanvasWorkbenchDraftState | null
}
```

初始值全部为 `null`。Canvas 切换、recovery、节点删除或卸载时清理工作台临时状态；Agent 运行状态继续由现有全局 atoms 管理，不复制进图状态。

- [ ] **Step 4: 实现节点锚定工作台壳**

```tsx
export interface CanvasNodeWorkbenchOverlayProps {
  node: CanvasNode
  dirty: boolean
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
}

/** 返回四类节点的稳定中文名称。 */
function getCanvasNodeKindLabel(kind: CanvasNodeKind): string {
  if (kind === 'agent') return 'Agent'
  if (kind === 'image') return '生图'
  if (kind === 'document') return '文档'
  return '原型'
}

export function CanvasNodeWorkbenchOverlay(props: CanvasNodeWorkbenchOverlayProps): React.ReactElement {
  const label = getCanvasNodeKindLabel(props.node.kind)
  return (
    <section
      className="nodrag nopan absolute left-0 top-[calc(100%+8px)] z-30 h-[min(620px,calc(100vh-9rem))] w-[min(720px,calc(100vw-2rem))] overflow-hidden rounded-[8px] border bg-background shadow-xl"
      aria-label={`${label}工作台`}
    >
      <header className="flex h-11 items-center justify-between border-b px-3">
        <span className="truncate text-sm font-medium">{props.node.title}</span>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={`收起${label}工作台`} onClick={props.onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="flex h-[calc(100%-2.75rem)] items-center justify-center p-4 text-sm text-muted-foreground">
        {label}节点已创建
      </div>
    </section>
  )
}
```

基础层 body 只显示稳定空状态和下一步可用动作，不读取内容文件、不运行模型、不加载 iframe。覆盖层由对应 XYFlow 节点组件内部渲染，因此天然锚定节点；z-index 高于节点和边、低于 Radix Dialog。

- [ ] **Step 5: 实现草稿切换三选一边界**

当 `workbenchDraft.dirty === true` 且目标节点不同，Workspace 打开现有 Dialog primitives，提供“保存并切换 / 放弃并切换 / 取消”。基础层没有重内容编辑器，因此保存动作只调用工作台注册的 `commitDraft()` 窄接口；未注册提交器时按钮禁用并显示原因，禁止静默清空 dirty。

Agent 节点展开时把现有 `CanvasAgentConversation` 渲染进覆盖层；移除右侧固定面板和 `createNativeCanvasNodeRevealViewport` 链。创建成功只写 `selectedNodeId`，明确不写 `expandedNodeId`。

- [ ] **Step 6: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx`

Expected: PASS；同一时间一个工作台、Agent 对话按展开加载、创建不展开、切换 Canvas 释放状态、dirty 三选一和零 graph/viewport mutation 均通过。

- [ ] **Step 7: 提交**

```bash
git add apps/electron/src/renderer/atoms/native-canvas-atoms.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.tsx apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
git commit -m "功能：增加 Canvas 单一节点内工作台"
```

## Task 9: 接通 Renderer 通用创建、删除和恢复流程

**Files:**
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.test.tsx`
- Create: `apps/electron/src/renderer/components/design/NativeCanvasTrashDialog.tsx`
- Create: `apps/electron/src/renderer/components/design/NativeCanvasTrashDialog.test.tsx`

- [ ] **Step 1: 写四类创建与回收流程失败测试**

```tsx
test.each([
  ['agent', '新 Agent'],
  ['image', '新生图'],
  ['document', '新文档'],
  ['webview', '新原型'],
] as const)('Given 顶部选择 %s When 创建成功 Then 只选中新折叠节点', async (kind, title) => {
  await toolbarAdd(kind)
  expect(adapterCommand(kind)).toHaveBeenCalledWith(expect.objectContaining({ kind, title }))
  expect(state.selectedNodeId).toBe(createdNodeId)
  expect(state.expandedNodeId).toBeNull()
  expect(state.snapshot!.document.viewport).toEqual(beforeViewport)
})

test('Given 删除文档节点 When 打开回收区并恢复 Then 内容身份和标题保留', async () => {
  await deleteSelectedNode('node-document')
  await openTrash()
  await restoreTrashEntry('trash-1')
  expect(currentDocument.nodes).toContainEqual(expect.objectContaining({
    id: 'node-document', kind: 'document', documentId: 'document-1', title: '需求文档',
  }))
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.test.tsx apps/electron/src/renderer/components/design/NativeCanvasTrashDialog.test.tsx`

Expected: FAIL；Workspace 仍只有 Agent 创建控制器，非 Agent 删除仍直接排队 `remove-nodes`。

- [ ] **Step 3: 把创建控制器泛化为类型命令**

```ts
export interface CanvasNodeCreateCommandRequest {
  kind: CanvasNodeKind
  sourceNodeId?: string
}

export interface CanvasNodeCreateOperationDependencies {
  target: CanvasTarget
  createId: () => string
  resolveEmptyCanvasCenter: () => DesignPoint
}

/** 每个失败操作只复用完全相同的 kind 与 sourceNodeId。 */
function createCanvasNodeOperation(
  request: CanvasNodeCreateCommandRequest,
  current: CanvasDocument,
  dependencies: CanvasNodeCreateOperationDependencies,
): CreateCanvasAgentNodeInput | CreateCanvasContentNodeInput {
  const nodeId = dependencies.createId()
  const position = request.sourceNodeId
    ? findAvailableNativeCanvasChildPosition(request.sourceNodeId, current.nodes)
    : findNativeCanvasGlobalAppendPosition(dependencies.resolveEmptyCanvasCenter(), current.nodes)
  const relationship = request.sourceNodeId
    ? { sourceNodeId: request.sourceNodeId, edgeId: dependencies.createId() }
    : undefined
  if (request.kind === 'agent') {
    return {
      ...dependencies.target,
      operationId: dependencies.createId(),
      nodeId,
      title: '新 Agent',
      position,
      ...(relationship ? { relationship } : {}),
    }
  }
  const titles: Record<Exclude<CanvasNodeKind, 'agent'>, string> = {
    image: '新生图',
    document: '新文档',
    webview: '新原型',
  }
  return {
    ...dependencies.target,
    operationId: dependencies.createId(),
    nodeId,
    kind: request.kind,
    contentId: dependencies.createId(),
    title: titles[request.kind],
    position,
    expectedRevision: current.revision,
    ...(relationship ? { relationship } : {}),
  }
}
```

顶部始终调用 `{ kind }`，节点侧 `+` 打开同一类型菜单，再调用 `{ kind, sourceNodeId }`。存在 source 时，四种类型都携带 `relationship: { sourceNodeId, edgeId }`；Agent 沿用既有可恢复事务，内容 lifecycle 在同一 graph revision 中创建节点和当前稳定端口 `output -> input` 的边。端口兼容和 typed edge 语义在编排层收紧，但基础层已保证“节点侧添加必有连线”，不会创建无边的伪扩展。

- [ ] **Step 4: 将删除切换为主进程生命周期命令**

删除确认继续显示节点标题和关联边数量。Agent 运行中先 STOP 再按现有 generation 复核删除；非 Agent 不走 STOP，调用 `deleteCanvasNode()`，成功后整体接管 snapshot、清理选区和展开工作台。失败保留节点、选区、viewport 与 dirty 草稿。

`NativeCanvasTrashDialog` 只在打开时调用 `listCanvasTrash()`；列表展示类型、标题和删除时间。恢复默认使用删除前位置；若已占用则调用全局追加位置并将显式 position 传给主进程。恢复成功只选中、不展开。

- [ ] **Step 5: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.test.tsx apps/electron/src/renderer/components/design/NativeCanvasTrashDialog.test.tsx`

Expected: PASS；四类顶部创建、Agent 侧扩展、非 Agent 删除入 trash、恢复、失败不改图/选区/视口、迟到结果跨 Canvas 隔离均通过。

- [ ] **Step 6: 提交**

```bash
git add apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.tsx apps/electron/src/renderer/components/design/NativeCanvasDeleteDialog.test.tsx apps/electron/src/renderer/components/design/NativeCanvasTrashDialog.tsx apps/electron/src/renderer/components/design/NativeCanvasTrashDialog.test.tsx
git commit -m "功能：完善 Canvas 多类型节点创建与回收"
```

## Task 10: 基础层回归、性能和 Electron 构建验收

**Files:**
- Modify: `apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `MEMORY.md`

- [ ] **Step 1: 增加跨模块回归断言**

```ts
test('Given 1000 节点 When 连续计算 20 个全局追加位置 Then viewport 不参与非空画布落点', () => {
  const distantViewport = { x: -80_000, y: 25_000, zoom: 0.2 }
  const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
  document.viewport = distantViewport
  document.nodes = Array.from({ length: 1_000 }, (_, index) => ({
    id: `node-${index}`,
    kind: 'agent' as const,
    title: `Agent ${index}`,
    position: { x: index * 312, y: 0 },
    agentSessionId: `session-${index}`,
  }))
  for (let index = 0; index < 20; index += 1) {
    const first = findNativeCanvasGlobalAppendPosition({ x: 0, y: 0 }, document.nodes)
    const distant = findNativeCanvasGlobalAppendPosition({ x: 99_999, y: -99_999 }, document.nodes)
    expect(distant).toEqual(first)
  }
  expect(document.viewport).toEqual(distantViewport)
  expect(toNativeCanvasFlowNodes(document)).toHaveLength(1_000)
})
```

主进程组合测试同时覆盖：Canvas Agent creation/rebuild/detach 不回退；内容 lifecycle 不把内部会话暴露给普通 Agent、LAN/mobile；Preload 不暴露路径；schema migration 后新写入始终为 v2。

- [ ] **Step 2: 运行全部基础层定向测试**

Run:

```bash
bun test packages/shared/src/types/canvas.test.ts \
  apps/electron/src/main/lib/design/design-paths.test.ts \
  apps/electron/src/main/lib/design/canvas-document-store.test.ts \
  apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts \
  apps/electron/src/main/lib/design/canvas-node-content-store.test.ts \
  apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts \
  apps/electron/src/main/lib/design/canvas-document-ipc.test.ts \
  apps/electron/src/preload/design-preload.test.ts \
  apps/electron/src/renderer/lib/design-adapter.test.ts \
  apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts \
  apps/electron/src/renderer/components/design/NativeCanvasToolbar.test.tsx \
  apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx \
  apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx \
  apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx \
  apps/electron/src/renderer/components/design/native-canvas-model.test.ts \
  apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx
```

Expected: 全部 PASS，无未处理 Promise rejection，无测试超时。

- [ ] **Step 3: 运行全仓类型检查**

Run: `bun run typecheck`

Expected: exit 0；无 `any`、遗漏联合分支或 IPC 类型不一致。

- [ ] **Step 4: 运行 Electron 完整构建**

Run: `CLANG_MODULE_CACHE_PATH=/private/tmp/proma-clang-cache SWIFT_MODULE_CACHE_PATH=/private/tmp/proma-swift-cache bun run electron:build`

Expected: exit 0；主进程、Preload、Renderer 和 native helper 均构建成功。

- [ ] **Step 5: 真实客户端验收**

Run: `bun run dev`

Expected:

1. 顶部 `+` 每次打开 Agent/生图/文档/原型/视频菜单，视频禁用；
2. 四类节点均可创建，节点只被选中且保持折叠；
3. 连续创建向全画布最右侧追加，viewport、zoom 与已有节点位置不变；
4. 双击或展开按钮只打开一个节点内工作台，收起后释放；
5. Agent 对话在节点工作台内发送、停止和恢复，普通会话列表不出现内部会话；
6. 非 Agent 节点删除后出现在回收区，恢复后内容身份不变；
7. 深色/浅色、窄窗口、键盘菜单、焦点环和文本溢出正常；
8. 1000 节点画布仍只渲染可见节点，拖动、平移和缩放无明显卡顿。

- [ ] **Step 6: 更新项目记忆**

在 `MEMORY.md` 追加一条只记录长期合同的决策：Canvas schema v2 的 `document` 迁移规则、非 Agent 内容/回收区事务边界、顶部全局追加零 viewport mutation、单一节点内工作台与折叠懒加载约束。不要复制实现代码或测试数量。

- [ ] **Step 7: 提交**

```bash
git add apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.test.ts MEMORY.md
git commit -m "测试：收口 Canvas 多类型节点基础层验证"
```

## 实施时的关联业务与资源检查

- 普通 Agent、LAN/mobile、Automation、Collaboration：Canvas Agent 会话可见性合同保持原样，新内容节点不创建普通 session。
- legacy Design：本阶段只建立 image module 身份，不复制生图执行器；真实生图在能力层复用现有 Design Job、模型路由、资产和 trace。
- 项目迁移：`nodes`、`trash`、`transactions` 位于现有 Canvas 正式根下，自动进入 verified copier 范围，不增加外部绝对路径。
- 多窗口：所有结构写继续在 `projectId + canvasId` 串行，revision 冲突和 change 广播不允许降级。
- 性能：新增创建和恢复均为显式用户操作；折叠渲染无内容 I/O；全局追加 O(N)，不添加持续轮询、ResizeObserver 或后台模型调用。
- 资源：同一 Canvas 只挂载一个完整工作台；原型 iframe、图片对象 URL 和编辑器实例由能力层在工作台 dispose 时释放。

## 停止条件

基础层只有在 Task 10 的定向测试、`bun run typecheck`、`bun run electron:build` 和真实客户端验收全部通过后才算完成。任何 schema migration、intent durability、内部会话可见性或 viewport 稳定性失败都必须留在本计划内修复，不能转交给能力层掩盖。
