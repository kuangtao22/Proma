# Canvas 通用产物生命周期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通 Agent 和用户都能在同一 Canvas 节点上持续创建、读取、更新、查看版本、采用历史版本和导出文档、WebView 与图片产物，而不是用不断新建节点模拟修改。

**Architecture:** 保留现有 `agent | image | document | webview` 图结构，在主进程新增类型化 Artifact Registry 和不可变文本 revision store；Canvas 图只引用当前采用 revision，Markdown/HTML 历史正文保存在受管 `revisions` 目录。所有写入继续经过同 Canvas serializer、workspace write lease、现有 batch/CAS 与四层 IPC 合同；图片适配现有 Design Job、素材采用和导出事实，不复制一套图片系统。

**Tech Stack:** Bun、TypeScript、Electron、React、Jotai、Radix/shadcn、Pi Agent Runtime、现有 stable-directory native helper、JSON/JSONL 本地持久化

---

## 范围与停止条件

本计划只实现总设计的阶段 1。阶段 2 的 Plan/Run、聊天任务卡、统一审批和自动批量编排，以及阶段 4 的多 Agent 能力授权均不进入本次实现。

完成标准：

- 文档、WebView、图片三类产物都通过 Artifact Registry 暴露真实能力，不支持的能力稳定拒绝。
- 文档与 WebView 更新时保留同一个节点和内容 ID，只增加不可变 revision；可比较、采用和回退。
- 图片继续复用现有任务历史、采用素材和导出逻辑，不复制图片文件或任务记录。
- 普通 Agent 可以创建文档，并更新既有文档、WebView 或图片配置；付费图片运行仍要求用户明确意图。
- 新连线必须声明 `association | reference | depends-on | derives`；旧画布确定性迁移且旧图片输入不丢失。
- 删除再恢复不会把文档/WebView revision、WebView 设备预设或图片采用结果重置。
- 相关定向测试、`bun run typecheck`、`bun run electron:build` 和真实 Electron 关键路径通过。

## 文件职责

### 新建文件

- `apps/electron/src/main/lib/design/canvas-artifact-revision-store.ts`：文档/WebView 不可变 revision 的准备、提交、读取、列举和崩溃对账。
- `apps/electron/src/main/lib/design/canvas-artifact-revision-store.test.ts`：revision 身份、不可变性、分支更新、恢复和边界测试。
- `apps/electron/src/main/lib/design/canvas-artifact-registry.ts`：三类产物的能力注册、类型路由和稳定不支持错误。
- `apps/electron/src/main/lib/design/canvas-artifact-registry.test.ts`：能力矩阵和适配器路由测试。
- `apps/electron/src/main/lib/design/canvas-text-artifact-service.ts`：文档/WebView 更新、采用旧版本、导出与图 revision 提交事务。
- `apps/electron/src/main/lib/design/canvas-text-artifact-service.test.ts`：CAS、内容准备、图提交、补偿和恢复测试。
- `apps/electron/src/renderer/components/design/CanvasDocumentWorkbench.tsx`：Markdown 文档编辑、保存、版本列表、比较、采用和导出。
- `apps/electron/src/renderer/components/design/CanvasDocumentWorkbench.test.tsx`：文档工作台交互与 dirty 状态测试。
- `apps/electron/src/renderer/components/design/CanvasArtifactVersionPanel.tsx`：文档/WebView 共用的版本选择、比较和采用 UI。
- `apps/electron/src/renderer/components/design/CanvasArtifactVersionPanel.test.tsx`：版本面板的键盘、加载、空态和采用行为测试。

### 主要修改文件

- `packages/shared/src/types/canvas.ts`：schema v4、语义边、Trash v2、文本产物 revision 与 IPC 合同。
- `apps/electron/native/stable-directory/stable-directory-helper.cc`、`apps/electron/src/main/lib/stable-directory-native-host.ts`：只为 revision 增加受限 `revisions` 子目录和固定文件白名单。
- `apps/electron/src/main/lib/design/canvas-node-content-store.ts`：revision 0 兼容读取与 Artifact Registry 的初始内容准备。
- `apps/electron/src/main/lib/design/canvas-artifact-creation.ts`：文档创建和显式语义关系。
- `apps/electron/src/main/lib/design/canvas-document-store.ts`：v3 -> v4 迁移和语义边解析。
- `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts`：完整 Trash v2 快照和无损恢复。
- `apps/electron/src/main/lib/design/canvas-image-input-resolver.ts`：新图只消费直接 `reference`，迁移后的旧图片输入继续有效。
- `apps/electron/src/main/lib/design/canvas-tool-provider.ts`：创建文档、更新同一产物、读取版本；不在 Renderer 做关键词判断。
- `apps/electron/src/main/lib/design/canvas-document-ipc.ts`、`apps/electron/src/preload/design-preload.ts`、`apps/electron/src/renderer/lib/design-adapter.ts`：文本产物读写、版本、采用和导出的四层合同。
- `apps/electron/src/renderer/components/design/CanvasWebviewWorkbench.tsx`、`apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`：WebView 编辑与版本工作台、文档工作台接入。

## Task 1：升级 Shared schema、语义边和完整回收快照

**Files:**

- Modify: `packages/shared/src/types/canvas.ts`
- Test: `packages/shared/src/types/canvas.test.ts`
- Test: `apps/electron/src/main/lib/design/canvas-document-store.test.ts`

- [ ] **Step 1: 写 schema v4、语义边和 Trash v2 的失败测试**

```ts
test('Given v3 图包含普通边和图片输入边 When 迁移 Then 普通边为 association 且图片输入边为 reference', () => {
  const migrated = parseCanvasDocument({
    ...legacyV3Document,
    nodes: [documentNode, imageNode, webviewNode],
    edges: [
      { id: 'edge-doc-web', sourceNodeId: 'doc-1', sourcePort: 'output', targetNodeId: 'web-1', targetPort: 'input' },
      { id: 'edge-doc-image', sourceNodeId: 'doc-1', sourcePort: 'output', targetNodeId: 'image-1', targetPort: 'input' },
    ],
  })
  expect(migrated.document.edges).toEqual([
    expect.objectContaining({ id: 'edge-doc-web', relation: 'association' }),
    expect.objectContaining({ id: 'edge-doc-image', relation: 'reference' }),
  ])
})

test('Given WebView 被删除 When 解析回收条目 Then 保留内容 revision 与设备预设', () => {
  expect(parseCanvasTrashEntry({
    schemaVersion: 2,
    trashId: 'trash-1', nodeId: 'web-1', kind: 'webview', contentId: 'prototype-1',
    title: '移动首页', position: { x: 10, y: 20 }, deletedRevision: 8, deletedAt: 100,
    contentRevision: 4, devicePreset: 'mobile',
  })).toMatchObject({ kind: 'webview', contentRevision: 4, devicePreset: 'mobile' })
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts`

Expected: FAIL，提示 `relation`、schema v4 或 Trash v2 字段尚未定义/解析。

- [ ] **Step 3: 实现 v4 类型和严格判别联合**

```ts
export const CANVAS_DOCUMENT_VERSION = 4

export type CanvasEdgeRelation = 'association' | 'reference' | 'depends-on' | 'derives'

export interface CanvasEdge {
  id: string
  sourceNodeId: string
  sourcePort: string
  targetNodeId: string
  targetPort: string
  relation: CanvasEdgeRelation
}

interface CanvasTrashEntryBase {
  schemaVersion: 2
  trashId: string
  nodeId: string
  contentId: string
  title: string
  position: DesignPoint
  deletedRevision: number
  deletedAt: number
}

export type CanvasTrashEntry =
  | (CanvasTrashEntryBase & { kind: 'image'; adoptedAssetId?: string })
  | (CanvasTrashEntryBase & { kind: 'document'; contentRevision: number })
  | (CanvasTrashEntryBase & {
      kind: 'webview'
      contentRevision: number
      devicePreset: CanvasWebviewDevicePreset
    })

export type CanvasContentNode = CanvasImageNode | CanvasDocumentNode | CanvasWebviewNode
export type CanvasTextArtifactKind = 'document' | 'webview'

export type CanvasArtifactAuthor =
  | { type: 'user' }
  | { type: 'agent'; sessionId: string; toolCallId: string }

export interface CanvasTextArtifactIdentity extends CanvasTarget {
  nodeId: string
  kind: CanvasTextArtifactKind
  contentId: string
}

export interface CanvasTextArtifactTarget extends CanvasTextArtifactIdentity {
  contentRevision: number
}

export interface CanvasArtifactRevisionSummary {
  kind: CanvasTextArtifactKind
  contentId: string
  revision: number
  parentRevision: number | null
  contentHash: string
  createdBy: CanvasArtifactAuthor
  createdAt: number
}

export interface CanvasTextArtifactSnapshot {
  target: CanvasTextArtifactTarget
  revision: CanvasArtifactRevisionSummary
  content: string
}

export interface UpdateCanvasTextArtifactInput extends CanvasTextArtifactIdentity {
  operationId: string
  expectedCanvasRevision: number
  expectedContentRevision: number
  content: string
}

export interface AdoptCanvasTextArtifactRevisionInput extends CanvasTextArtifactIdentity {
  operationId: string
  expectedCanvasRevision: number
  expectedContentRevision: number
  revision: number
}

export interface ExportCanvasTextArtifactInput extends CanvasTextArtifactTarget {}

export interface ExportCanvasImageArtifactInput extends CanvasImageTarget {
  kind: 'image'
  assetId: string
}

export type ExportCanvasArtifactInput =
  | ExportCanvasTextArtifactInput
  | ExportCanvasImageArtifactInput

export interface CanvasTextArtifactMutationResult {
  snapshot: CanvasWorkspaceSnapshot
  artifact: CanvasTextArtifactSnapshot
}
```

在 `parseCanvasTrashEntry` 中按 `kind` 使用 exact-key 校验，图片仅允许可选 `adoptedAssetId`，文档/WebView 必须保留其采用 revision；新增 `parseCanvasEdgeRelation`，所有 v4 mutation 和文档输入拒绝缺失或未知关系。

- [ ] **Step 4: 实现 v3 -> v4 确定性迁移**

```ts
/** v3 中所有图片直接入边都曾被图片输入解析器消费，因此迁移为 reference。 */
function migrateV3Edge(edge: CanvasEdgeV3, nodes: CanvasNode[]): CanvasEdge {
  const target = nodes.find((node) => node.id === edge.targetNodeId)
  return {
    ...edge,
    relation: target?.kind === 'image' ? 'reference' : 'association',
  }
}
```

迁移只改变 schema 和边语义，不改变节点、坐标、可见性、revision 或自动运行状态。

- [ ] **Step 5: 运行测试并提交**

Run: `bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts`

Expected: PASS。

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts
git commit -m "画布：升级语义连线与回收快照合同"
```

## Task 2：允许 native helper 安全管理 revision 目录

**Files:**

- Modify: `apps/electron/native/stable-directory/stable-directory-helper.cc`
- Modify: `apps/electron/native/stable-directory/stable-directory-helper-path-contract.cc`
- Modify: `apps/electron/src/main/lib/stable-directory-native-host.ts`
- Test: `apps/electron/src/main/lib/stable-directory-native-host.test.ts`
- Test: `apps/electron/scripts/build-stable-directory-native.test.ts`

- [ ] **Step 1: 写 `revisions` 白名单和跨目录移动拒绝测试**

```ts
test('Given revisions 受管目录 When 读写固定正文和元数据 Then helper 接受', async () => {
  await expect(run({ mode: 'canvas-content-write', childName: 'revisions', entryId: 'revision-a', fileName: 'meta.json', content: '{}' })).resolves.toBeDefined()
  await expect(run({ mode: 'canvas-content-write', childName: 'revisions', entryId: 'revision-a', fileName: 'content.md', content: '# v1' })).resolves.toBeDefined()
})

test('Given revisions 目录 When 请求 move Then helper 拒绝', async () => {
  await expect(run({
    mode: 'canvas-content-move', childName: 'revisions', entryId: 'revision-a',
    destinationChildName: 'trash', destinationEntryId: 'revision-a',
  })).rejects.toThrow('STABLE_DIRECTORY_NATIVE_FAILED')
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `bun test apps/electron/src/main/lib/stable-directory-native-host.test.ts apps/electron/scripts/build-stable-directory-native.test.ts`

Expected: FAIL，`revisions` 不在允许的 child contract 内。

- [ ] **Step 3: 最小扩展 helper 合同**

```cpp
const bool safe_child = config->child_name == "nodes"
    || config->child_name == "trash"
    || config->child_name == "revisions";
const bool move_child = config->child_name == "nodes" || config->child_name == "trash";
const bool move_destination = config->destination_child_name == "nodes"
    || config->destination_child_name == "trash";
```

`canvas-content-read/write/list` 允许 `revisions`；`canvas-content-move` 的源和目标仍只允许 `nodes <-> trash`。文件白名单仍保持 `meta.json | content.md | index.html` 等固定名称，不开放任意文件或嵌套路径。

- [ ] **Step 4: 同步 TypeScript request 类型并运行测试**

```ts
export type StableDirectoryCanvasChild = 'nodes' | 'trash' | 'revisions'

export interface StableDirectoryNativeRequest {
  childName?: StableDirectoryCanvasChild
  destinationChildName?: 'nodes' | 'trash'
}
```

Run: `bun test apps/electron/src/main/lib/stable-directory-native-host.test.ts apps/electron/scripts/build-stable-directory-native.test.ts`

Expected: PASS。

- [ ] **Step 5: 构建 helper 并提交**

Run: `bun run --cwd apps/electron build:stable-directory-native`

Expected: helper 构建成功，无协议合同失败。

```bash
git add apps/electron/native/stable-directory/stable-directory-helper.cc apps/electron/native/stable-directory/stable-directory-helper-path-contract.cc apps/electron/src/main/lib/stable-directory-native-host.ts apps/electron/src/main/lib/stable-directory-native-host.test.ts apps/electron/scripts/build-stable-directory-native.test.ts
git commit -m "画布：扩展受管产物版本目录"
```

## Task 3：建立不可变文本 Artifact Revision Store

**Files:**

- Create: `apps/electron/src/main/lib/design/canvas-artifact-revision-store.ts`
- Create: `apps/electron/src/main/lib/design/canvas-artifact-revision-store.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-node-content-store.ts`
- Test: `apps/electron/src/main/lib/design/canvas-node-content-store.test.ts`

- [ ] **Step 1: 写 revision 0、不可变 revision 和分支版本测试**

```ts
test('Given 旧节点只有 revision 0 When 读取 Then 从 nodes 内容目录返回兼容快照', async () => {
  const snapshot = await store.read(target, { kind: 'document', contentId: 'doc-1', revision: 0 })
  expect(snapshot).toMatchObject({ meta: { revision: 0, parentRevision: null }, content: '# 初稿' })
})

test('Given 当前采用 revision 1 且历史最大 revision 3 When 从旧版继续编辑 Then 创建 revision 4 且 parentRevision 为 1', async () => {
  const prepared = await store.prepare(target, {
    kind: 'webview', contentId: 'web-1', parentRevision: 1,
    content: '<!doctype html><h1>分支版本</h1>', createdBy: { type: 'user' },
  })
  expect(prepared.record).toMatchObject({ revision: 4, parentRevision: 1, state: 'prepared' })
})

test('Given 相同 revision 已有不同 hash When prepare Then 拒绝覆盖', async () => {
  await expect(store.prepareAtRevision(target, conflictingInput)).rejects.toThrow('CANVAS_ARTIFACT_REVISION_CONFLICT')
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `bun test apps/electron/src/main/lib/design/canvas-artifact-revision-store.test.ts apps/electron/src/main/lib/design/canvas-node-content-store.test.ts`

Expected: FAIL，新 Store 尚不存在。

- [ ] **Step 3: 定义 revision 元数据和 Store 窄接口**

```ts
export type CanvasArtifactRevisionState = 'prepared' | 'committed'

export interface CanvasTextArtifactRevisionIdentity {
  kind: CanvasTextArtifactKind
  contentId: string
  revision: number
}

export interface PrepareCanvasArtifactRevisionInput {
  kind: CanvasTextArtifactKind
  contentId: string
  parentRevision: number
  content: string
  createdBy: CanvasArtifactAuthor
}

export interface CanvasArtifactRevisionRecord {
  schemaVersion: 1
  kind: CanvasTextArtifactKind
  contentId: string
  revision: number
  parentRevision: number | null
  contentHash: string
  createdBy: { type: 'user' } | { type: 'agent'; sessionId: string; toolCallId: string }
  createdAt: number
  state: CanvasArtifactRevisionState
}

export interface CanvasArtifactRevisionSnapshot {
  record: CanvasArtifactRevisionRecord
  content: string
}

export interface CanvasArtifactRevisionStore {
  read: (target: CanvasTarget, identity: CanvasTextArtifactRevisionIdentity) => Promise<CanvasArtifactRevisionSnapshot>
  list: (target: CanvasTarget, identity: Omit<CanvasTextArtifactRevisionIdentity, 'revision'>) => Promise<CanvasArtifactRevisionRecord[]>
  prepare: (target: CanvasTarget, input: PrepareCanvasArtifactRevisionInput) => Promise<CanvasArtifactRevisionSnapshot>
  commit: (target: CanvasTarget, identity: CanvasTextArtifactRevisionIdentity) => Promise<CanvasArtifactRevisionRecord>
  reconcile: (target: CanvasTarget, document: CanvasDocument) => Promise<void>
}
```

- [ ] **Step 4: 实现稳定 entry ID、hash 与 revision 0 兼容读取**

```ts
/** 固定长度 entry ID 避免 contentId 与 revision 拼接超过 helper 的 128 字符上限。 */
function createRevisionEntryId(contentId: string, revision: number): string {
  return `revision-${createHash('sha256').update(`${contentId}\u0000${revision}`).digest('hex')}`
}

/** 正文 hash 同时用于不可变校验和后续摘要缓存。 */
function createContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
```

revision 0 从 `nodes/<contentId>/content.md|index.html` 读取并合成只读 meta；revision 1+ 从 `revisions/<derivedId>/meta.json` 与固定正文文件读取。`list` 扫描最多 512 个 entry，只接受 meta 中 `contentId` 和 `kind` 精确匹配的记录并按 revision 升序返回。

- [ ] **Step 5: 实现 prepared/committed 对账并运行测试**

`prepare` 先写正文，再写 `state: prepared` 的 meta；`commit` 只把同 hash、同身份 meta 原子替换为 committed。`reconcile` 发现图节点已引用 prepared revision 时补 commit；未被图引用的 prepared revision 保留为不可见恢复候选，不自动删除。

Run: `bun test apps/electron/src/main/lib/design/canvas-artifact-revision-store.test.ts apps/electron/src/main/lib/design/canvas-node-content-store.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/electron/src/main/lib/design/canvas-artifact-revision-store.ts apps/electron/src/main/lib/design/canvas-artifact-revision-store.test.ts apps/electron/src/main/lib/design/canvas-node-content-store.ts apps/electron/src/main/lib/design/canvas-node-content-store.test.ts
git commit -m "画布：建立文本产物不可变版本存储"
```

## Task 4：建立 Artifact Registry 与能力矩阵

**Files:**

- Create: `apps/electron/src/main/lib/design/canvas-artifact-registry.ts`
- Create: `apps/electron/src/main/lib/design/canvas-artifact-registry.test.ts`

- [ ] **Step 1: 写能力矩阵和稳定失败测试**

```ts
test('Given 三类适配器 When 查询能力 Then 返回阶段一真实能力', () => {
  expect(registry.describe('document').capabilities).toEqual(['create', 'read', 'update', 'version', 'adopt', 'export'])
  expect(registry.describe('webview').capabilities).toEqual(['create', 'read', 'update', 'version', 'preview', 'adopt', 'export'])
  expect(registry.describe('image').capabilities).toEqual(['create', 'read', 'update', 'version', 'run', 'adopt', 'export'])
})

test('Given 文档产物 When 请求 run Then 返回稳定不支持错误', () => {
  expect(() => registry.requireCapability('document', 'run')).toThrow('CANVAS_ARTIFACT_CAPABILITY_UNSUPPORTED')
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `bun test apps/electron/src/main/lib/design/canvas-artifact-registry.test.ts`

Expected: FAIL，新 Registry 尚不存在。

- [ ] **Step 3: 实现固定能力描述和类型化适配器联合**

```ts
export type CanvasArtifactCapability =
  | 'create' | 'read' | 'update' | 'version' | 'preview' | 'run' | 'adopt' | 'export'

export interface CanvasArtifactDescriptor {
  kind: CanvasContentKind
  capabilities: readonly CanvasArtifactCapability[]
}

export interface CanvasArtifactAdapter {
  descriptor: CanvasArtifactDescriptor
}

export interface CanvasArtifactRegistry {
  describe: (kind: CanvasContentKind) => CanvasArtifactDescriptor
  requireCapability: (kind: CanvasContentKind, capability: CanvasArtifactCapability) => CanvasArtifactAdapter
}
```

Registry 在进程初始化时接收三类适配器并拒绝重复/缺失类型；能力列表只存在代码中，不写入节点或 JSON，升级后不会出现持久化能力声明失真。

- [ ] **Step 4: 运行测试并提交**

Run: `bun test apps/electron/src/main/lib/design/canvas-artifact-registry.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/design/canvas-artifact-registry.ts apps/electron/src/main/lib/design/canvas-artifact-registry.test.ts
git commit -m "画布：增加通用产物能力注册表"
```

## Task 5：实现文档/WebView 更新、版本采用和导出事务

**Files:**

- Create: `apps/electron/src/main/lib/design/canvas-text-artifact-service.ts`
- Create: `apps/electron/src/main/lib/design/canvas-text-artifact-service.test.ts`

- [ ] **Step 1: 写同节点更新、采用旧版和 revision 冲突测试**

```ts
test('Given 文档节点采用 revision 2 When 保存正文 Then 准备 revision 3 并只更新原节点引用', async () => {
  const result = await service.update({
    ...target, nodeId: 'doc-1', kind: 'document', contentId: 'content-1',
    expectedCanvasRevision: 7, expectedContentRevision: 2, content: '# 第三版',
    operationId: '11111111-1111-4111-8111-111111111111',
    source: { type: 'user' },
  })
  expect(result.artifact.target).toMatchObject({ nodeId: 'doc-1', contentId: 'content-1', contentRevision: 3 })
  expect(result.snapshot.document.nodes).toHaveLength(1)
})

test('Given WebView 历史 revision 1 When 采用 Then 只切换 contentRevision 且不复制正文', async () => {
  const result = await service.adopt({
    ...target, nodeId: 'web-1', kind: 'webview', contentId: 'prototype-1',
    expectedCanvasRevision: 8, expectedContentRevision: 3, revision: 1,
    operationId: '22222222-2222-4222-8222-222222222222',
  })
  expect(result.artifact.target).toMatchObject({ nodeId: 'web-1', contentRevision: 1 })
  expect(revisions.prepare).not.toHaveBeenCalled()
})

test('Given 图或正文基线过期 When 更新 Then 不创建可见新版本', async () => {
  await expect(service.update(staleInput)).rejects.toThrow('CANVAS_ARTIFACT_REVISION_CONFLICT')
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `bun test apps/electron/src/main/lib/design/canvas-text-artifact-service.test.ts`

Expected: FAIL，新事务服务尚不存在。

- [ ] **Step 3: 定义严格输入、结果和节点身份校验**

```ts
export type CanvasTextArtifactChangeSource =
  | { type: 'user' }
  | { type: 'agent'; sessionId: string; runStartedAt: number; toolCallId: string }

export interface CanvasTextArtifactServiceUpdateInput extends UpdateCanvasTextArtifactInput {
  source: CanvasTextArtifactChangeSource
}

export interface CanvasTextArtifactGraphCommitInput extends CanvasTarget {
  operationId: string
  expectedCanvasRevision: number
  node: CanvasDocumentNode | CanvasWebviewNode
  source?: CanvasChangeSource
}

export interface CanvasTextArtifactGraphWriter {
  commit: (input: CanvasTextArtifactGraphCommitInput) => Promise<CanvasDocument>
}
```

服务从权威图重建节点身份；Renderer 或 Agent 自报的 `kind/contentId/contentRevision` 任一不匹配即拒绝。正文上限沿用 helper 的 256 KiB，WebView 空正文和文档非法类型拒绝。

- [ ] **Step 4: 在已有 batch 与 lease 边界内实现更新事务**

```ts
const prepared = await revisions.prepare(target, {
  kind: input.kind,
  contentId: input.contentId,
  parentRevision: input.expectedContentRevision,
  content: input.content,
  createdBy: toRevisionAuthor(input.source),
})
const nextNode = replaceNodeContentRevision(currentNode, prepared.record.revision)
const document = await graph.commit({
  ...target,
  operationId: input.operationId,
  expectedCanvasRevision: input.expectedCanvasRevision,
  node: nextNode,
  ...(input.source.type === 'agent' ? { source: toCanvasChangeSource(input.source) } : {}),
})
await revisions.commit(target, {
  kind: input.kind,
  contentId: input.contentId,
  revision: prepared.record.revision,
})
```

Graph Writer 在有 Agent source 时把单节点 upsert 交给现有 batch，在无 source 的用户编辑时调用 `CanvasDocumentStore.mutate`；两条路径都使用相同 CAS 和结果类型，不伪造 Agent 来源。该方法自身不获取第二把锁；IPC/工具外层必须通过现有 `CanvasOperationSerializer` 和 `workspaceOperations.withWriteLease` 包住 `reconcile -> update/adopt`。图已提交但 revision commit 回执失败时，重读图并调用 revision `reconcile`，不得删除图已引用的正文。

- [ ] **Step 5: 实现安全导出**

```ts
export interface ExportCanvasTextArtifactToPathInput extends CanvasTextArtifactTarget {
  targetPath: string
}

const extension = input.kind === 'document' ? '.md' : '.html'
assertExpectedExtension(input.targetPath, extension)
await writeTextFileAtomic(input.targetPath, snapshot.content)
```

导出只能由主窗口经过 Electron save dialog 得到目标路径后调用；Agent 工具不接收任意绝对路径。文档导出 `.md`，WebView 导出单文件 `.html`，不打包外部网络资源。

- [ ] **Step 6: 提供 document/webview 真实 Adapter**

```ts
export interface CanvasTextArtifactAdapter extends CanvasArtifactAdapter {
  read: (target: CanvasTextArtifactTarget) => Promise<CanvasTextArtifactSnapshot>
  update: (input: CanvasTextArtifactServiceUpdateInput) => Promise<CanvasTextArtifactMutationResult>
  listVersions: (input: CanvasTextArtifactIdentity) => Promise<CanvasArtifactRevisionSummary[]>
  adopt: (input: AdoptCanvasTextArtifactRevisionInput) => Promise<CanvasTextArtifactMutationResult>
  export: (input: ExportCanvasTextArtifactToPathInput) => Promise<void>
}

export function createCanvasTextArtifactAdapter(
  kind: CanvasTextArtifactKind,
  service: CanvasTextArtifactService,
): CanvasTextArtifactAdapter {
  return {
    descriptor: kind === 'document' ? DOCUMENT_ARTIFACT_DESCRIPTOR : WEBVIEW_ARTIFACT_DESCRIPTOR,
    read: (target) => service.read(assertTextKind(target, kind)),
    update: (input) => service.update(assertTextKind(input, kind)),
    listVersions: (input) => service.listVersions(assertTextKind(input, kind)),
    adopt: (input) => service.adopt(assertTextKind(input, kind)),
    export: (input) => service.export(assertTextKind(input, kind)),
  }
}
```

document/webview Adapter 使用相同事务服务但固定各自 kind；WebView 的 `preview` 能力继续委托现有 `canvas-webview-preview-service`，不复制预览缓存。

- [ ] **Step 7: 运行测试并提交**

Run: `bun test apps/electron/src/main/lib/design/canvas-text-artifact-service.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/design/canvas-text-artifact-service.ts apps/electron/src/main/lib/design/canvas-text-artifact-service.test.ts
git commit -m "画布：支持文本产物更新版本与导出"
```

## Task 6：扩展产物创建和普通 Agent 工具

**Files:**

- Modify: `apps/electron/src/main/lib/design/canvas-artifact-creation.ts`
- Test: `apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.ts`
- Test: `apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-access-facade.ts`
- Test: `apps/electron/src/main/lib/design/canvas-tool-access-facade.test.ts`

- [ ] **Step 1: 写创建文档、显式关系和更新同一节点的失败测试**

```ts
test('Given Agent 创建文档并引用需求节点 When 提交 Then 创建 document revision 0 和 reference 边', async () => {
  const result = await service.create({
    ...target, baseRevision: 3, artifactType: 'document', title: '产品说明', content: '# 产品说明',
    sourceNodeId: 'requirements-1', relation: 'reference',
    source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-doc-1' },
  })
  expect(result).toMatchObject({ artifactType: 'document' })
  expect(batch.operations).toContainEqual(expect.objectContaining({
    type: 'upsert-nodes', nodes: [expect.objectContaining({ kind: 'document', contentRevision: 0 })],
  }))
})

test('Given Agent 更新已有 WebView When 调用 canvas_update_artifact Then 节点 ID 不变且 revision 增加', async () => {
  const result = await executeTool(tools, 'canvas_update_artifact', {
    canvasId: 'canvas-1', nodeId: 'web-1', baseRevision: 5,
    expectedContentRevision: 1, content: '<!doctype html><h1>新版</h1>',
  })
  expect(result.details).toMatchObject({ nodeId: 'web-1', contentRevision: 2 })
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `bun test apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/design/canvas-tool-access-facade.test.ts`

Expected: FAIL，`document`、`relation` 和 `canvas_update_artifact` 尚未支持。

- [ ] **Step 3: 扩展创建服务**

```ts
export type CanvasArtifactType = 'document' | 'webview' | 'image'

export interface CanvasArtifactCreationInput extends CanvasTarget {
  baseRevision: number
  artifactType: CanvasArtifactType
  title: string
  content: string
  relation?: CanvasEdgeRelation
  sourceNodeId?: string
  source: CanvasChangeSource
}
```

`document` 节点写入 `documentId` 与 `contentRevision: 0`；有来源节点时必须同时提供 relation，没有来源时拒绝多余 relation。创建边时写入明确 relation，不再生成无语义边。

- [ ] **Step 4: 增加 `canvas_update_artifact`，图片只更新配置不自动付费运行**

```ts
export const CANVAS_TOOL_NAMES = [
  'canvas_get_context', 'canvas_manage', 'canvas_read', 'canvas_apply_changes',
  'canvas_create_artifact', 'canvas_update_artifact', 'canvas_run_nodes',
] as const

artifactType: Type.Union([
  Type.Literal('document'), Type.Literal('webview'), Type.Literal('image'),
])
```

更新工具只接收 `canvasId/nodeId/baseRevision/expectedContentRevision/content`，主进程从权威节点解析实际类型。文档/WebView 调用文本事务；图片把 `content` 作为新 prompt 保存到同一 `imageModuleId`，保留模型、比例、尺寸和上下文设置，且不调用 `run_nodes`。工具说明明确：只有用户要求立即生图时才另行调用 `canvas_run_nodes`。

- [ ] **Step 5: 扩展 `canvas_read` 返回 revision 摘要**

```ts
interface CanvasArtifactReadProjection {
  nodeId: string
  kind: CanvasContentKind
  currentRevision: number
  availableRevisions: number[]
  content?: string
}
```

读取文档/WebView 时返回当前正文与有界 revision 列表；图片返回当前配置、任务历史派生版本和采用素材 ID。单次正文仍受现有 `MAX_READ_CHARS` 和节点数量预算约束。

- [ ] **Step 6: 运行测试并提交**

Run: `bun test apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/design/canvas-tool-access-facade.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/design/canvas-artifact-creation.ts apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/design/canvas-tool-access-facade.ts apps/electron/src/main/lib/design/canvas-tool-access-facade.test.ts
git commit -m "画布：支持 Agent 创建文档并更新既有产物"
```

## Task 7：打通文本产物 IPC、Preload 和 Renderer Adapter

**Files:**

- Modify: `packages/shared/src/types/canvas.ts`
- Test: `packages/shared/src/types/canvas.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Test: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/design-preload.ts`
- Test: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Test: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写四层合同失败测试**

```ts
test('Given 完整文档目标 When load/update/list/adopt Then preload 只透传公开字段', async () => {
  await api.updateCanvasTextArtifact({
    projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'doc-1', kind: 'document',
    contentId: 'content-1', expectedCanvasRevision: 4, expectedContentRevision: 1,
    content: '# 新版', operationId: '11111111-1111-4111-8111-111111111111',
  })
  expect(ipc.invoke).toHaveBeenCalledWith('canvas:update-text-artifact', expect.not.objectContaining({ path: expect.anything() }))
})

test('Given 目标身份与权威节点不匹配 When 更新 Then 主进程拒绝且不写 revision', async () => {
  const result = await invoke(CANVAS_IPC_CHANNELS.UPDATE_TEXT_ARTIFACT, mismatchedInput)
  expect(result).toEqual({ ok: false, error: { code: 'CANVAS_ARTIFACT_REVISION_CONFLICT', message: expect.any(String) } })
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: FAIL，新通道、parser 和 adapter 方法不存在。

- [ ] **Step 3: 定义共享通道与 exact-key parser**

```ts
export const CANVAS_IPC_CHANNELS = {
  LOAD_TEXT_ARTIFACT: 'canvas:load-text-artifact',
  UPDATE_TEXT_ARTIFACT: 'canvas:update-text-artifact',
  LIST_ARTIFACT_REVISIONS: 'canvas:list-artifact-revisions',
  ADOPT_ARTIFACT_REVISION: 'canvas:adopt-artifact-revision',
  EXPORT_ARTIFACT: 'canvas:export-artifact',
} as const

export function parseCanvasTextArtifactTarget(value: unknown): CanvasTextArtifactTarget {
  const keys = ['projectId', 'canvasId', 'nodeId', 'kind', 'contentId', 'contentRevision'] as const
  if (!hasExactCanvasKeys(value, keys)
    || !isCanvasLifecycleId(value.projectId)
    || !isCanvasLifecycleId(value.canvasId)
    || !isCanvasLifecycleId(value.nodeId)
    || (value.kind !== 'document' && value.kind !== 'webview')
    || !isCanvasLifecycleId(value.contentId)
    || !isCanvasNonNegativeInteger(value.contentRevision)) {
    throw new Error('CANVAS_TEXT_ARTIFACT_TARGET_INVALID')
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    kind: value.kind,
    contentId: value.contentId,
    contentRevision: value.contentRevision,
  }
}
```

所有输入 parser 使用 exact-key、稳定 ID、非负安全整数和正文上限；公开错误新增 `CANVAS_ARTIFACT_LOAD_FAILED`、`CANVAS_ARTIFACT_SAVE_FAILED`、`CANVAS_ARTIFACT_REVISION_CONFLICT`、`CANVAS_ARTIFACT_EXPORT_FAILED`。

- [ ] **Step 4: 注册主进程 handler 并复用唯一锁边界**

```ts
options.ipc.handle(CANVAS_IPC_CHANNELS.UPDATE_TEXT_ARTIFACT, (event, value) => (
  invokeCanvasOperation('artifactSave', async () => {
    assertAuthorizedSender(event, options)
    const input = parseUpdateCanvasTextArtifactInput(value)
    return runCanvasWrite(input, async () => options.textArtifacts.update({ ...input, source: { type: 'user' } }))
  })
))
```

`runCanvasWrite` 必须复用当前 IPC 内的 Canvas serializer 和 workspace write lease；读取、列举也在同 Canvas serializer 中执行，以便 revision reconcile 与恢复提升不和写入交叉。广播在 lease 释放后发送。

在 `apps/electron/src/main/ipc.ts` 构造 document、webview、image 三个真实 Adapter 并一次性创建 Registry；Canvas IPC handler 先调用 `requireCapability`，再路由到对应 Adapter。缺失任一 Adapter 时主进程初始化失败，避免运行到用户操作才暴露半配置状态。

- [ ] **Step 5: 同步 Preload 与 Renderer Adapter**

```ts
export interface DesignAdapter {
  loadCanvasTextArtifact: (input: CanvasTextArtifactTarget) => Promise<CanvasTextArtifactSnapshot>
  updateCanvasTextArtifact: (input: UpdateCanvasTextArtifactInput) => Promise<CanvasTextArtifactMutationResult>
  listCanvasArtifactRevisions: (input: CanvasTextArtifactIdentity) => Promise<CanvasArtifactRevisionSummary[]>
  adoptCanvasArtifactRevision: (input: AdoptCanvasTextArtifactRevisionInput) => Promise<CanvasTextArtifactMutationResult>
  exportCanvasArtifact: (input: ExportCanvasArtifactInput) => Promise<void>
}
```

Adapter 合并同一完整 target 的在途 load/list 请求；写操作不合并。返回后严格验证 target 和 revision，迟到的旧目标快照由组件丢弃。

- [ ] **Step 6: 运行测试并提交**

Run: `bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: PASS。

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "画布：打通文本产物版本 IPC 合同"
```

## Task 8：实现文档工作台

**Files:**

- Create: `apps/electron/src/renderer/components/design/CanvasDocumentWorkbench.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasDocumentWorkbench.test.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasArtifactVersionPanel.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasArtifactVersionPanel.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.tsx`
- Test: `apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Test: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写加载、编辑、保存、dirty 关闭和版本采用测试**

```tsx
test('Given 文档详情已加载 When 编辑并保存 Then 使用当前图和内容 revision 更新原节点', async () => {
  render(<CanvasDocumentWorkbench {...props} />)
  await screen.findByDisplayValue('# 初稿')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '# 第二版' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(adapter.updateCanvasTextArtifact).toHaveBeenCalledWith(expect.objectContaining({
    nodeId: 'doc-1', expectedCanvasRevision: 4, expectedContentRevision: 0, content: '# 第二版',
  }))
})

test('Given 文档有未保存修改 When 收起详情 Then 由现有 dirty 关闭确认阻止静默丢失', async () => {
  expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  expect(requestClose()).toBe(false)
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `bun test apps/electron/src/renderer/components/design/CanvasDocumentWorkbench.test.tsx apps/electron/src/renderer/components/design/CanvasArtifactVersionPanel.test.tsx apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: FAIL，文档工作台尚不存在，Workspace 仍没有 document 分支。

- [ ] **Step 3: 复用 Markdown 编辑器实现受控文档工作台**

```tsx
<LiveMarkdownEditor
  value={draft}
  onChange={(value) => {
    setDraft(value)
    props.onDirtyChange(value !== snapshot.content)
  }}
  placeholder="输入文档内容"
/>
```

工作台顶部使用既有 Button、Tabs/segmented control 和主题变量，提供保存、版本、导出；加载、保存、冲突、只读和空文档均有明确状态。保存成功后以主进程返回的新 snapshot/revision 重置基线，不通过额外 LOAD 猜测结果。

- [ ] **Step 4: 实现共用版本面板**

```tsx
<CanvasArtifactVersionPanel
  revisions={state.revisions}
  currentRevision={node.contentRevision}
  selectedRevision={selectedRevision}
  onSelect={setSelectedRevision}
  onAdopt={handleAdopt}
  writable={writable}
/>
```

选择历史版本时展示当前版与历史版的只读双栏文本比较；采用按钮显示目标 revision，采用当前版时禁用。列表支持键盘焦点，加载和无历史版本不显示空白面板。

- [ ] **Step 5: 接入 Overlay 与 Workspace**

```tsx
if (node.kind === 'document') {
  return (
    <CanvasDocumentWorkbench
      node={node}
      target={target}
      canvasRevision={document.revision}
      adapter={designAdapter}
      writable={writable}
      onDirtyChange={onDirtyChange}
    />
  )
}
```

文档详情继续沿用双击和右上角放大按钮打开、现有可拖拽尺寸、`nodrag nopan nowheel` 与 dirty 关闭确认；单击卡片仍只选中。

- [ ] **Step 6: 运行测试并提交**

Run: `bun test apps/electron/src/renderer/components/design/CanvasDocumentWorkbench.test.tsx apps/electron/src/renderer/components/design/CanvasArtifactVersionPanel.test.tsx apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: PASS。

```bash
git add apps/electron/src/renderer/components/design/CanvasDocumentWorkbench.tsx apps/electron/src/renderer/components/design/CanvasDocumentWorkbench.test.tsx apps/electron/src/renderer/components/design/CanvasArtifactVersionPanel.tsx apps/electron/src/renderer/components/design/CanvasArtifactVersionPanel.test.tsx apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.tsx apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
git commit -m "画布：增加可版本化文档工作台"
```

## Task 9：把 WebView 工作台升级为预览/HTML 编辑与版本回退

**Files:**

- Modify: `apps/electron/src/renderer/components/design/CanvasWebviewWorkbench.tsx`
- Test: `apps/electron/src/renderer/components/design/CanvasWebviewWorkbench.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasWebviewPreview.tsx`
- Test: `apps/electron/src/renderer/components/design/CanvasWebviewPreview.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Test: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写预览/HTML、保存、旧版比较和 iframe 不重载测试**

```tsx
test('Given WebView 详情已加载 When 在 HTML 模式编辑保存 Then 更新同一 prototypeId 并增加 revision', async () => {
  render(<CanvasWebviewWorkbench {...props} />)
  fireEvent.click(await screen.findByRole('tab', { name: 'HTML' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '<!doctype html><h1>新版</h1>' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(adapter.updateCanvasTextArtifact).toHaveBeenCalledWith(expect.objectContaining({
    nodeId: 'web-1', contentId: 'prototype-1', expectedContentRevision: 2,
  }))
})

test('Given 只切换预览与 HTML tab When 当前 revision 未变 Then iframe 实例不重新加载', async () => {
  const iframe = await screen.findByTitle('首页原型预览')
  fireEvent.click(screen.getByRole('tab', { name: 'HTML' }))
  fireEvent.click(screen.getByRole('tab', { name: '预览' }))
  expect(screen.getByTitle('首页原型预览')).toBe(iframe)
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `bun test apps/electron/src/renderer/components/design/CanvasWebviewWorkbench.test.tsx apps/electron/src/renderer/components/design/CanvasWebviewPreview.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: FAIL，现有 WebView 工作台只有预览。

- [ ] **Step 3: 实现不卸载预览的模式切换**

```tsx
<Tabs value={mode} onValueChange={setMode}>
  <TabsList>
    <TabsTrigger value="preview">预览</TabsTrigger>
    <TabsTrigger value="html">HTML</TabsTrigger>
    <TabsTrigger value="versions">版本</TabsTrigger>
  </TabsList>
  <div hidden={mode !== 'preview'}><CanvasWebviewFrame snapshot={readySnapshot} /></div>
  <div hidden={mode !== 'html'}><Textarea value={draft} onChange={handleDraftChange} /></div>
</Tabs>
```

使用 `hidden` 保留当前 iframe DOM，只有完整 target 或 content revision 变化时重新加载；设备预设切换仍只改变节点字段和视口，不创建内容 revision。

- [ ] **Step 4: 接入保存、版本比较、采用和导出**

保存复用 Task 7 的 text artifact adapter；版本面板复用 `CanvasArtifactVersionPanel`。WebView 比较显示转义后的 HTML 文本，不把历史 HTML 在比较区域执行。导出使用主进程 save dialog 和 `.html` 合同。

```tsx
const handleSave = async (): Promise<void> => {
  const result = await adapter.updateCanvasTextArtifact(createUpdateInput(draft))
  setSnapshot(result.artifact)
  setDraft(result.artifact.content)
  onDirtyChange(false)
}
```

- [ ] **Step 5: 运行测试并提交**

Run: `bun test apps/electron/src/renderer/components/design/CanvasWebviewWorkbench.test.tsx apps/electron/src/renderer/components/design/CanvasWebviewPreview.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: PASS。

```bash
git add apps/electron/src/renderer/components/design/CanvasWebviewWorkbench.tsx apps/electron/src/renderer/components/design/CanvasWebviewWorkbench.test.tsx apps/electron/src/renderer/components/design/CanvasWebviewPreview.tsx apps/electron/src/renderer/components/design/CanvasWebviewPreview.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
git commit -m "画布：支持 WebView 编辑与版本回退"
```

## Task 10：把图片能力接入 Registry 并统一单产物导出

**Files:**

- Modify: `apps/electron/src/main/lib/design/canvas-artifact-registry.ts`
- Test: `apps/electron/src/main/lib/design/canvas-artifact-registry.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-image-module-store.ts`
- Test: `apps/electron/src/main/lib/design/canvas-image-module-store.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Test: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/renderer/components/design/CanvasImageWorkbench.tsx`
- Test: `apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx`

- [ ] **Step 1: 写图片版本派生、采用和导出复用测试**

```ts
test('Given 图片模块有三个成功任务 When 列举版本 Then 只返回仍存在输出素材的成功任务', async () => {
  const versions = await adapter.listVersions(imageTarget)
  expect(versions.map((version) => version.assetId)).toEqual(['asset-1', 'asset-3'])
})

test('Given 用户导出当前采用图片 When 执行 Then Registry 复用 DesignAssetService.exportAsset', async () => {
  await adapter.export({ ...imageTarget, assetId: 'asset-3', targetPath: '/tmp/export.png' })
  expect(designAssets.exportAsset).toHaveBeenCalledWith('project-1', 'asset-3', '/tmp/export.png')
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `bun test apps/electron/src/main/lib/design/canvas-artifact-registry.test.ts apps/electron/src/main/lib/design/canvas-image-module-store.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx`

Expected: FAIL，图片尚未通过 Registry 暴露统一版本/导出能力。

- [ ] **Step 3: 实现图片适配器，不复制任务或素材数据**

```ts
interface CanvasImageArtifactAdapter extends CanvasArtifactAdapter {
  read: (target: CanvasImageTarget) => Promise<CanvasImageModuleSnapshot>
  update: CanvasImageModuleStore['save']
  adopt: CanvasImageModuleStore['adoptAsset']
  listVersions: (target: CanvasImageTarget) => Promise<CanvasImageArtifactVersion[]>
  export: (input: ExportCanvasImageArtifactToPathInput) => Promise<void>
}

interface CanvasImageArtifactVersion {
  jobId: string
  assetId: string
  createdAt: number
}

interface ExportCanvasImageArtifactToPathInput extends CanvasImageTarget {
  assetId: string
  targetPath: string
}

const imageAdapter: CanvasImageArtifactAdapter = {
  descriptor: IMAGE_ARTIFACT_DESCRIPTOR,
  read: loadImageModuleSnapshot,
  update: imageModules.save,
  listVersions: async (target) => deriveImageVersions(await loadImageModuleSnapshot(target)),
  adopt: imageModules.adoptAsset,
  export: async (input) => designAssets.exportAsset(input.projectId, input.assetId, input.targetPath),
}
```

Registry 的 `run` 能力路由到现有 Canvas image job IPC/service，而不是塞进配置 Store 适配器。图片 revision 继续由成功 `DesignJobRecord + DesignAsset` 派生，`CanvasImageModuleConfig.adoptedAssetId` 仍是当前采用事实；不得新增第二份图片 revision JSON、复制图片文件或改变 Design Job 生命周期。

- [ ] **Step 4: 在图片工作台统一版本和导出入口**

```tsx
<Button type="button" variant="outline" onClick={() => onExportAsset(currentAsset.id)}>
  <Download className="size-4" aria-hidden="true" />
  导出
</Button>
```

导出按钮仅在当前采用素材存在时启用；历史列表继续允许预览和采用。外部导出由用户点击触发 save dialog，不新增 Agent 任意路径导出工具。

- [ ] **Step 5: 运行测试并提交**

Run: `bun test apps/electron/src/main/lib/design/canvas-artifact-registry.test.ts apps/electron/src/main/lib/design/canvas-image-module-store.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/design/canvas-artifact-registry.ts apps/electron/src/main/lib/design/canvas-artifact-registry.test.ts apps/electron/src/main/lib/design/canvas-image-module-store.ts apps/electron/src/main/lib/design/canvas-image-module-store.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/renderer/components/design/CanvasImageWorkbench.tsx apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx
git commit -m "画布：统一图片版本采用与导出能力"
```

## Task 11：应用语义连线并修复无损删除恢复

**Files:**

- Modify: `apps/electron/src/main/lib/design/canvas-document-store.ts`
- Test: `apps/electron/src/main/lib/design/canvas-document-store.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts`
- Test: `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-agent-batch-operation.ts`
- Test: `apps/electron/src/main/lib/design/canvas-agent-batch-operation.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-image-input-resolver.ts`
- Test: `apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.ts`
- Test: `apps/electron/src/renderer/components/design/native-canvas-model.test.ts`

- [ ] **Step 1: 写语义输入过滤和完整恢复测试**

```ts
test('Given 图片有 association 与 reference 两条入边 When 解析输入 Then 只消费 reference', async () => {
  const references = await resolver.resolve(imageTarget)
  expect(references.map((item) => item.nodeId)).toEqual(['reference-source'])
})

test('Given 删除并恢复采用 revision 4 的 mobile WebView When 完成 Then 节点字段不变', async () => {
  const deleted = await lifecycle.delete(deleteInput)
  expect(deleted.trashEntry).toMatchObject({ contentRevision: 4, devicePreset: 'mobile' })
  const restored = await lifecycle.restore(restoreInput)
  expect(restored.snapshot.document.nodes).toContainEqual(expect.objectContaining({
    id: 'web-1', contentRevision: 4, devicePreset: 'mobile',
  }))
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-store.test.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts apps/electron/src/main/lib/design/canvas-agent-batch-operation.test.ts apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts`

Expected: FAIL，现有解析器消费全部入边，恢复会把字段重置为初始值。

- [ ] **Step 3: 只消费 `reference` 直接上游**

```ts
const sourceIds = [...new Set(document.edges
  .filter((edge) => edge.targetNodeId === target.nodeId && edge.relation === 'reference')
  .map((edge) => edge.sourceNodeId))]
  .slice(0, CANVAS_IMAGE_INPUT_MAX_REFERENCES)
```

保持现有引用数量、文本字符和媒体数量预算；不递归多跳、不让 `depends-on` 或 `derives` 自动成为 prompt，也不因连线自动运行图片任务。

- [ ] **Step 4: 从真实节点构造 Trash v2 并原样恢复**

```ts
function createTrashEntry(node: CanvasContentNode, deletedRevision: number, deletedAt: number): CanvasTrashEntry {
  const base = createTrashBase(node, deletedRevision, deletedAt)
  if (node.kind === 'image') return { ...base, kind: 'image', ...(node.adoptedAssetId ? { adoptedAssetId: node.adoptedAssetId } : {}) }
  if (node.kind === 'document') return { ...base, kind: 'document', contentRevision: node.contentRevision }
  return { ...base, kind: 'webview', contentRevision: node.contentRevision, devicePreset: node.devicePreset }
}
```

restore 依据判别联合还原完整节点；旧 schema 1 trash 继续兼容读取并使用旧默认值，但新删除一律写 schema 2。batch intent parser 和恢复资源同时接受迁移后的规范化条目。

- [ ] **Step 5: Renderer 连线保留 relation 并显示可辨识标签**

```ts
return document.edges.map((edge): Edge => ({
  id: edge.id,
  source: edge.sourceNodeId,
  target: edge.targetNodeId,
  data: { relation: edge.relation },
  label: CANVAS_EDGE_RELATION_LABELS[edge.relation],
}))
```

连线创建菜单提供“关联、引用、依赖、衍生”；默认用户拖线为 `association`，Agent 创建必须显式传 relation。仅增加小型语义标签，不用颜色作为唯一信息，不改变框选、删除和节点位置。

- [ ] **Step 6: 运行测试并提交**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-store.test.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts apps/electron/src/main/lib/design/canvas-agent-batch-operation.test.ts apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/design/canvas-document-store.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts apps/electron/src/main/lib/design/canvas-agent-batch-operation.ts apps/electron/src/main/lib/design/canvas-agent-batch-operation.test.ts apps/electron/src/main/lib/design/canvas-image-input-resolver.ts apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts apps/electron/src/renderer/components/design/native-canvas-model.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts
git commit -m "画布：启用语义连线并保留恢复版本"
```

## Task 12：集成验证、性能检查和真实 Electron 验收

**Files:**

- Test: `packages/shared/src/types/canvas.test.ts`
- Test: `apps/electron/src/main/lib/stable-directory-native-host.test.ts`
- Test: `apps/electron/src/main/lib/design/canvas-artifact-revision-store.test.ts`
- Test: `apps/electron/src/main/lib/design/canvas-artifact-registry.test.ts`
- Test: `apps/electron/src/main/lib/design/canvas-text-artifact-service.test.ts`
- Test: `apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts`
- Test: `apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`
- Test: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Test: `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts`
- Test: `apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts`
- Test: `apps/electron/src/preload/design-preload.test.ts`
- Test: `apps/electron/src/renderer/lib/design-adapter.test.ts`
- Test: `apps/electron/src/renderer/components/design/CanvasDocumentWorkbench.test.tsx`
- Test: `apps/electron/src/renderer/components/design/CanvasArtifactVersionPanel.test.tsx`
- Test: `apps/electron/src/renderer/components/design/CanvasWebviewWorkbench.test.tsx`
- Test: `apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx`
- Test: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`
- Test: `apps/electron/src/renderer/components/design/native-canvas-model.test.ts`
- Test: `apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`
- Modify: `MEMORY.md`

验证阶段不新增功能文件。任何失败都回到拥有该行为的 Task 1-11，补写失败测试、最小修复并重跑该任务测试后，再重新进入本任务。

- [ ] **Step 1: 运行阶段 1 主进程和 Shared 定向测试**

Run:

```bash
bun test packages/shared/src/types/canvas.test.ts \
  apps/electron/src/main/lib/stable-directory-native-host.test.ts \
  apps/electron/src/main/lib/design/canvas-artifact-revision-store.test.ts \
  apps/electron/src/main/lib/design/canvas-artifact-registry.test.ts \
  apps/electron/src/main/lib/design/canvas-text-artifact-service.test.ts \
  apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts \
  apps/electron/src/main/lib/design/canvas-tool-provider.test.ts \
  apps/electron/src/main/lib/design/canvas-document-ipc.test.ts \
  apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts \
  apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts
```

Expected: 全部 PASS；无重复付费任务、跨 Canvas 写入或 revision 覆盖失败。

- [ ] **Step 2: 运行 Renderer 定向测试**

Run:

```bash
bun test apps/electron/src/preload/design-preload.test.ts \
  apps/electron/src/renderer/lib/design-adapter.test.ts \
  apps/electron/src/renderer/components/design/CanvasDocumentWorkbench.test.tsx \
  apps/electron/src/renderer/components/design/CanvasArtifactVersionPanel.test.tsx \
  apps/electron/src/renderer/components/design/CanvasWebviewWorkbench.test.tsx \
  apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx \
  apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx \
  apps/electron/src/renderer/components/design/native-canvas-model.test.ts
```

Expected: 全部 PASS；dirty 关闭、迟到响应、键盘操作和深浅主题相关断言通过。

- [ ] **Step 3: 验证 1000 节点和版本列表边界没有性能回退**

Run: `bun test apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

Expected: PASS；大画布仍只挂载可见节点。新增 revision list 单次最多扫描 512 条，工作台只在打开详情后按需加载版本，不在 1000 个卡片挂载时逐节点读取磁盘。

- [ ] **Step 4: 运行类型检查与 Electron 构建**

Run: `bun run typecheck`

Expected: PASS，无 `any`、IPC 类型漂移或未穷尽判别联合。

Run: `bun run electron:build`

Expected: PASS，stable-directory helper 和主进程依赖正确打包。

- [ ] **Step 5: 启动真实客户端完成关键路径验收**

Run: `bun run dev`

在真实 Electron 客户端按顺序验证：

1. 普通 Agent 创建一个文档、一个 mobile WebView 和一个图片节点，并建立不同语义关系。
2. 双击文档，编辑保存两次；比较 revision 0/2，采用 revision 1 后再编辑，确认生成新 revision 且节点 ID 不变。
3. 双击 WebView，在预览与 HTML 间切换，确认未修改时不重载；保存 HTML、切换设备、采用旧版，确认设备预设不被版本采用覆盖。
4. 图片修改 prompt 后保持同一节点；明确要求生成时创建新任务；采用历史素材并导出当前采用图片。
5. 删除并恢复三类节点，确认文档/WebView revision、mobile 预设和图片采用素材保持。
6. 重启客户端，确认当前采用 revision、历史版本和语义边仍可读取；无 prepared revision 造成空白节点。
7. 分别导出 `.md`、单文件 `.html` 和图片，确认内容与当前采用版本一致。

Expected: 所有路径成功；付费图片只在明确运行步骤执行一次；连线本身不触发任务。

- [ ] **Step 6: 检查影响范围并更新长期记忆**

Run: `git diff --check`

Expected: 无空白错误。

Run: `git status --short`

Expected: 只出现本计划范围内文件和进入任务前已存在的用户改动；不得暂存 `.superpowers/` 或无关文件。

在 `MEMORY.md` 追加：文本产物 revision 使用 `revisions/<sha256(contentId, revision)>` 不可变存储；图节点只保存当前采用 revision；新连线语义固定四类；旧图片入边迁移为 `reference`；图片版本继续从 Design Job/Asset 派生。

- [ ] **Step 7: 仅提交本阶段新增的长期记忆**

```bash
git diff -- MEMORY.md
git add MEMORY.md
git commit -m "文档：记录画布产物版本架构"
```

执行前先确认 `MEMORY.md` 没有进入本任务前遗留的未提交内容；如存在，保留工作区改动且不单独提交该文件，在最终交付中明确报告未提交的记忆更新，禁止夹带用户改动。

## 关联业务与性能评估

- **对普通 Agent 的影响：** 新增创建文档和更新既有产物能力，但不改变 Pi runtime 会话语义；工具仍受当前 Agent-Canvas binding、permission ceiling 和明确付费意图约束。
- **对图片业务的影响：** 只增加 Registry 适配和语义入边过滤；任务、素材、采用和导出继续使用现有事实源，避免两套图片状态漂移。
- **对删除/恢复的影响：** Trash schema 升级会触及 Renderer、batch intent 和生命周期恢复，但新条目能无损保留当前版本；旧 trash 保持兼容默认恢复。
- **对上游合并的影响：** 主要改动集中在 `packages/shared` Canvas 合同和 `apps/electron/src/main/lib/design`，普通 Agent 高频 UI 仅扩展现有工具提供器，避免侵入 Pi runtime 内部。
- **资源开销：** 每次文本保存新增一份最多 256 KiB 的不可变正文和小型 meta；打开详情时才列举版本，卡片不读取历史。更新事务增加一次 hash 和两次受管文件写，但减少重复建节点、重复生成和全画布扫描。
- **安全边界：** helper 只增加固定 `revisions` child，不开放任意路径；HTML 预览继续离线 sandbox；导出路径只来自 Electron save dialog；Renderer 和 Agent 均不能提交绝对受管存储路径。

## 自审清单

- [ ] 规格覆盖：Artifact Registry、文档完整生命周期、WebView 编辑/版本、图片能力适配、单产物导出、语义边、历史迁移、同一产物更新均有明确任务。
- [ ] 阶段边界：未加入 Plan/Run、聊天任务卡、统一审批、多 Agent 写权限、视频执行器或网络型 WebView。
- [ ] 类型一致：共享字段统一使用 `contentRevision`、`expectedCanvasRevision`、`expectedContentRevision`、`relation` 和 `devicePreset`；正文类型统一为 `document | webview`。
- [ ] 持久化一致：revision 0 读取旧 nodes 内容；revision 1+ 使用派生 entry ID；图提交后只切换采用 revision，不覆盖历史正文。
- [ ] IPC 一致：shared、main handler、preload、renderer adapter 四层全部有对应步骤和测试。
- [ ] 测试一致：每项功能先红灯再最小实现；最终包含定向测试、性能、typecheck、Electron build 和真实客户端验收。
