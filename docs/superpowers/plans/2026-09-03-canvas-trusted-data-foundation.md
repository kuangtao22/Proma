# Canvas 可信数据底座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Canvas 的连线、真实图片输入、正式版本展示和采用传播使用同一份可验证事实，阻止 WebView 摘要或未采用图片冒充视觉参考进入付费生图。

**Architecture:** 继续复用 `CanvasEdge.sourcePort/targetPort`，以输出能力和输入槽表达执行绑定，不新增平行的 binding 对象，也不升级 Canvas 文档 schema。旧 `output/input` 等端口保持原样并被识别为“待确认”，只有 Host 验证为兼容的类型化端口才进入图片输入解析和采用传播；图片 Job journal 只保存 Asset ID 与端口，运行时再经 Asset Service 解析真实路径。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Jotai、XYFlow、Radix/shadcn、Bun Test

---

## 范围与约束

- 本阶段只处理现有 `agent | image | document | webview` 节点，不新增视频、音频、时间线、`CreativeTaskContract` 或第三方 Skill Adapter。
- 不修改 `CANVAS_DOCUMENT_VERSION = 4`。为什么：现有端口字段已经能表达新合同，强制 schema 迁移会把旧边静默改写成执行输入，违反“显式确认”。
- 旧边继续可加载、显示和编辑，但不会被付费执行器消费，也不会触发下游待更新；用户点击旧边并重新选择关系后，Renderer 写入 Host 可验证的类型化端口。
- 图片节点没有任何数据入边时仍允许纯文生图；只有存在待确认、类型错误或缺少正式素材的执行意图时才阻断。
- 候选生成不切换正式版本、不传播下游；候选采用和历史版本“设为当前”都必须走可恢复采用事务。
- 不新增依赖。绑定检查为 `O(nodes + edges)`；真实媒体路径只在用户明确运行图片节点时按最多 4 张解析。

## 文件职责

- `packages/shared/src/types/canvas.ts`：定义输出能力、输入槽、绑定判定、图片输入快照和公开错误码。
- `packages/shared/src/types/canvas.test.ts`：锁定类型化绑定、旧端口兼容和 IPC 快照解析。
- `apps/electron/src/main/lib/design/canvas-document-store.ts`：拒绝已知但不兼容的类型化端口，同时允许旧端口作为未绑定关系存在。
- `apps/electron/src/main/lib/design/canvas-agent-node-creation.ts`：为新建 Agent 扩展边生成类型化端口。
- `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts`：为 Renderer 新建内容节点的扩展边生成类型化端口。
- `apps/electron/src/main/lib/design/canvas-artifact-creation.ts`：为普通 Agent 创建的真实产物边生成类型化端口。
- `apps/electron/src/main/lib/design/canvas-image-input-resolver.ts`：只解析已绑定的直接入边，并在 Job 建立前验证真实媒体。
- `apps/electron/src/main/lib/design/design-job-manager.ts`：固化绑定快照、向隐藏执行 Agent 注入真实参考图路径，并提供无写入预检。
- `apps/electron/src/main/lib/design/canvas-document-ipc.ts`：把图片输入失败映射为稳定公开错误，批量运行先完成全量预检。
- `apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.ts`：只有已绑定边才传播待更新，并让历史版本切换复用采用事务。
- `apps/electron/src/renderer/components/design/native-canvas-model.ts`：把关系标签与绑定状态投影到边，同时让 XYFlow 结构 Handle 不再冒充执行端口。
- `apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx`：允许点击旧边并显式确认关系/输入用途。
- `apps/electron/src/renderer/components/design/CanvasNodeCard.tsx`：卡片继续展示正式缩略图，并使用“有新版本”徽标。
- `apps/electron/src/renderer/components/design/CanvasImageWorkbench.tsx`：隐藏执行 Agent 使用生成任务文案，不冒充 Canvas Agent。

### Task 1: 建立共享 Artifact 能力与输入槽合同

**Files:**
- Modify: `packages/shared/src/types/canvas.ts:359`
- Modify: `packages/shared/src/types/canvas.ts:1083`
- Modify: `packages/shared/src/types/canvas.ts:1111`
- Modify: `packages/shared/src/types/canvas.ts:1775`
- Test: `packages/shared/src/types/canvas.test.ts:160`

- [ ] **Step 1: 写失败测试，锁定绑定、旧边与图片输入快照合同**

在 `packages/shared/src/types/canvas.test.ts` 增加以下 BDD 用例：

```ts
test('Given 图片到图片的类型化引用 When 判定绑定 Then 输出 image.asset 进入 image.reference', () => {
  const edge = createCanvasBoundEdge(
    { id: 'source', kind: 'image' },
    { id: 'target', kind: 'image' },
    { id: 'edge-1', sourceNodeId: 'source', targetNodeId: 'target', relation: 'reference' },
  )

  expect(edge).toMatchObject({ sourcePort: 'image.asset', targetPort: 'image.reference' })
  expect(resolveCanvasEdgeBinding(edge, 'image', 'image')).toEqual({
    state: 'bound', sourceCapability: 'image.asset', targetSlot: 'image.reference',
  })
})

test('Given WebView 到图片的引用 When 创建绑定 Then 只能进入文本上下文槽', () => {
  const edge = createCanvasBoundEdge(
    { id: 'source', kind: 'webview' },
    { id: 'target', kind: 'image' },
    { id: 'edge-1', sourceNodeId: 'source', targetNodeId: 'target', relation: 'reference' },
  )

  expect(edge).toMatchObject({ sourcePort: 'webview.html', targetPort: 'context.text' })
})

test('Given 历史 output/input 引用 When 判定绑定 Then 保留关系但要求确认', () => {
  const edge: CanvasEdge = {
    id: 'edge-legacy', sourceNodeId: 'source', sourcePort: 'output',
    targetNodeId: 'target', targetPort: 'input', relation: 'reference',
  }

  expect(resolveCanvasEdgeBinding(edge, 'image', 'image')).toEqual({ state: 'unresolved' })
})

test('Given 图片能力被写入文本槽 When 判定绑定 Then 明确标记不兼容', () => {
  const edge: CanvasEdge = {
    id: 'edge-invalid', sourceNodeId: 'source', sourcePort: 'image.asset',
    targetNodeId: 'target', targetPort: 'context.text', relation: 'reference',
  }

  expect(resolveCanvasEdgeBinding(edge, 'image', 'image')).toEqual({ state: 'incompatible' })
})
```

同时扩充图片模块快照测试：新任务引用必须保留 `sourcePort/targetPort`；缺少两字段的旧任务仍能解析，避免历史 journal 使整个节点详情加载失败。

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test packages/shared/src/types/canvas.test.ts`

Expected: FAIL，提示 `createCanvasBoundEdge`、`resolveCanvasEdgeBinding` 尚未导出，图片输入引用 parser 尚不接受新端口字段。

- [ ] **Step 3: 实现最小共享合同**

在 `packages/shared/src/types/canvas.ts` 增加以下类型与纯函数；所有新增声明保留中文注释：

```ts
export type CanvasArtifactOutputCapability =
  | 'agent.text'
  | 'image.asset'
  | 'document.markdown'
  | 'webview.html'

export type CanvasArtifactInputSlot =
  | 'context.text'
  | 'context.image'
  | 'image.reference'

export type CanvasEdgeBindingResolution =
  | { state: 'bound'; sourceCapability: CanvasArtifactOutputCapability; targetSlot: CanvasArtifactInputSlot }
  | { state: 'none' }
  | { state: 'unresolved' }
  | { state: 'incompatible' }

export const CANVAS_UNBOUND_PORT = 'unbound'

const CANVAS_NODE_OUTPUT_CAPABILITY: Readonly<Record<CanvasNodeKind, CanvasArtifactOutputCapability>> = {
  agent: 'agent.text',
  image: 'image.asset',
  document: 'document.markdown',
  webview: 'webview.html',
}

export function createCanvasBoundEdge(
  source: Pick<CanvasNode, 'id' | 'kind'>,
  target: Pick<CanvasNode, 'id' | 'kind'>,
  edge: Omit<CanvasEdge, 'sourcePort' | 'targetPort'>,
): CanvasEdge {
  if (edge.relation === 'association') {
    return { ...edge, sourcePort: CANVAS_UNBOUND_PORT, targetPort: CANVAS_UNBOUND_PORT }
  }
  const sourcePort = CANVAS_NODE_OUTPUT_CAPABILITY[source.kind]
  const targetPort: CanvasArtifactInputSlot = sourcePort === 'image.asset'
    ? target.kind === 'image' ? 'image.reference' : 'context.image'
    : 'context.text'
  return { ...edge, sourcePort, targetPort }
}

export function resolveCanvasEdgeBinding(
  edge: CanvasEdge,
  sourceKind: CanvasNodeKind,
  targetKind: CanvasNodeKind,
): CanvasEdgeBindingResolution {
  const expected = createCanvasBoundEdge(
    { id: edge.sourceNodeId, kind: sourceKind },
    { id: edge.targetNodeId, kind: targetKind },
    {
      id: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      relation: edge.relation,
    },
  )
  if (edge.relation === 'association') return { state: 'none' }
  if (edge.sourcePort === expected.sourcePort && edge.targetPort === expected.targetPort) {
    return {
      state: 'bound',
      sourceCapability: expected.sourcePort as CanvasArtifactOutputCapability,
      targetSlot: expected.targetPort as CanvasArtifactInputSlot,
    }
  }
  const knownSource = Object.values(CANVAS_NODE_OUTPUT_CAPABILITY).includes(
    edge.sourcePort as CanvasArtifactOutputCapability,
  )
  const knownTarget = ['context.text', 'context.image', 'image.reference'].includes(edge.targetPort)
  return knownSource || knownTarget ? { state: 'incompatible' } : { state: 'unresolved' }
}
```

给 `CanvasImageInputReference` 增加成对可选字段，用于兼容旧 journal：

```ts
sourcePort?: CanvasArtifactOutputCapability
targetPort?: CanvasArtifactInputSlot
```

严格 parser 只接受“两者同时缺失”或“两者同时存在且为合法枚举”。在 `CanvasPublicErrorCode` 增加：

```ts
| 'CANVAS_IMAGE_INPUT_CONFIRMATION_REQUIRED'
| 'CANVAS_IMAGE_INPUT_MISSING'
| 'CANVAS_IMAGE_INPUT_INVALID'
```

- [ ] **Step 4: 运行共享合同测试**

Run: `bun test packages/shared/src/types/canvas.test.ts`

Expected: PASS；现有 schema v4 快照继续通过，旧端口不会被改写。

- [ ] **Step 5: 提交共享合同**

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts
git commit -m "功能：建立画布产物输入绑定合同"
```

### Task 2: 让所有新建边写入类型化端口

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-document-store.ts:588`
- Modify: `apps/electron/src/main/lib/design/canvas-agent-node-creation.ts:663`
- Modify: `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts:515`
- Modify: `apps/electron/src/main/lib/design/canvas-artifact-creation.ts:270`
- Test: `apps/electron/src/main/lib/design/canvas-document-store.test.ts:120`
- Test: `apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts:410`
- Test: `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts`
- Test: `apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts:260`

- [ ] **Step 1: 写失败测试，覆盖新边和旧边的不同处理**

新增以下断言：

```ts
test('Given v4 历史边使用 output/input When 加载 Then 保留原端口并作为未解析关系返回', () => {
  const fixture = createFixture()
  const document = createConnectedDocument()
  document.edges[0] = { ...document.edges[0]!, relation: 'reference' }
  writeDocument(fixture.documentPath, document)

  const loaded = fixture.store.load({ projectId: 'project-1', canvasId: 'canvas-1' })

  expect(loaded.document.edges[0]).toMatchObject({ sourcePort: 'output', targetPort: 'input' })
})

test('Given 已知能力写入错误输入槽 When 保存 mutation Then 在落盘前拒绝', () => {
  const fixture = createFixture()
  writeDocument(fixture.documentPath, createConnectedDocument())

  expect(() => fixture.store.mutate(
    { projectId: 'project-1', canvasId: 'canvas-1' },
    2,
    [{ type: 'upsert-edges', edges: [{
      id: 'edge-invalid', sourceNodeId: 'node-image', sourcePort: 'image.asset',
      targetNodeId: 'node-agent', targetPort: 'context.text', relation: 'reference',
    }] }],
  )).toThrow('CANVAS_MUTATION_INVALID')
})
```

把 Agent 创建、内容节点创建和 Artifact 创建测试中的新边预期改为：文档/WebView/Agent 输出进入 `context.text`，图片输出进入 `context.image` 或图片目标的 `image.reference`；`association` 使用 `unbound/unbound`。

- [ ] **Step 2: 运行四组测试并确认失败**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-store.test.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts`

Expected: FAIL，新建边仍写入 `output/input`，Store 仍接受已知但不兼容的端口组合。

- [ ] **Step 3: 在主进程创建边界统一调用共享 helper**

在三个创建服务中，先从权威文档读取来源节点，再使用同一函数构造边：

```ts
const sourceNode = document.nodes.find((node) => node.id === relationship.sourceNodeId)
if (!sourceNode) throw new Error('CANVAS_RELATIONSHIP_SOURCE_MISSING')
const edge = createCanvasBoundEdge(sourceNode, targetNode, {
  id: relationship.edgeId,
  sourceNodeId: sourceNode.id,
  targetNodeId: targetNode.id,
  relation: relationship.relation,
})
mutations.push({ type: 'upsert-edges', edges: [edge] })
```

`canvas-agent-node-creation.ts` 的目标节点固定为本次 intent 对应的 `agent` 节点；`canvas-content-node-lifecycle.ts` 和 `canvas-artifact-creation.ts` 使用本次已经构造的内容节点。不要在 Renderer 或 Agent 提示词中复制这套推导规则。

在 `validateCanvasMutations()` 和当前文档 parser 完成端点存在校验后增加：

```ts
const sourceKind = nodeKindsById.get(edge.sourceNodeId)
const targetKind = nodeKindsById.get(edge.targetNodeId)
if (!sourceKind || !targetKind) throw new Error('CANVAS_MUTATION_INVALID')
if (resolveCanvasEdgeBinding(edge, sourceKind, targetKind).state === 'incompatible') {
  throw new Error('CANVAS_MUTATION_INVALID')
}
```

旧的未知端口返回 `unresolved`，因此继续加载；`association` 返回 `none` 且永不形成执行绑定；已知但错误的组合返回 `incompatible`，因此不能成为新可信事实。

- [ ] **Step 4: 运行主进程创建与 Store 测试**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-store.test.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts`

Expected: PASS；旧 v1-v4 迁移测试继续通过，当前文档版本仍为 4。

- [ ] **Step 5: 提交创建边界**

```bash
git add apps/electron/src/main/lib/design/canvas-document-store.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.ts apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts apps/electron/src/main/lib/design/canvas-artifact-creation.ts apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts
git commit -m "功能：为画布新建关系写入类型化端口"
```

### Task 3: 图片输入只消费已确认绑定和正式素材

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-image-input-resolver.ts:24`
- Test: `apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts:1`

- [ ] **Step 1: 用 BDD 测试定义四条运行前边界**

重写测试夹具使用类型化端口，并增加：

```ts
test('Given WebView 绑定 context.text When 解析 Then 只提供安全文本且没有媒体身份', async () => {
  const { document, target } = createDocument()
  document.edges = [{
    id: 'edge-web', sourceNodeId: 'webview-1', sourcePort: 'webview.html',
    targetNodeId: target.nodeId, targetPort: 'context.text', relation: 'reference',
  }]

  const references = await createResolver(document).resolve(target)

  expect(references).toEqual([expect.objectContaining({
    nodeId: 'webview-1', sourcePort: 'webview.html', targetPort: 'context.text',
  })])
  expect(references[0]).not.toHaveProperty('assetId')
})

test('Given WebView 被伪装为图片参考 When 解析 Then 在任何 Job 副作用前拒绝', async () => {
  const { document, target } = createDocument()
  document.edges = [{
    id: 'edge-invalid', sourceNodeId: 'webview-1', sourcePort: 'webview.html',
    targetNodeId: target.nodeId, targetPort: 'image.reference', relation: 'reference',
  }]

  await expect(createResolver(document).resolve(target)).rejects.toThrow('CANVAS_IMAGE_INPUT_INVALID')
})

test('Given 图片参考没有正式采用素材 When 解析 Then 明确阻断缺少媒体', async () => {
  const { document, target } = createDocument()
  const source = document.nodes.find((node) => node.id === 'image-1')
  if (source?.kind === 'image') delete source.adoptedAssetId
  document.edges = [{
    id: 'edge-image', sourceNodeId: 'image-1', sourcePort: 'image.asset',
    targetNodeId: target.nodeId, targetPort: 'image.reference', relation: 'reference',
  }]

  await expect(createResolver(document).resolve(target)).rejects.toThrow('CANVAS_IMAGE_INPUT_MISSING')
})

test('Given 历史 reference 边尚未确认 When 解析 Then 不静默猜测用途', async () => {
  const { document, target } = createDocument()
  document.edges = [{
    id: 'edge-legacy', sourceNodeId: 'image-1', sourcePort: 'output',
    targetNodeId: target.nodeId, targetPort: 'input', relation: 'reference',
  }]

  await expect(createResolver(document).resolve(target))
    .rejects.toThrow('CANVAS_IMAGE_INPUT_CONFIRMATION_REQUIRED')
})
```

再增加一个计数断言：合法图片参考会调用一次 `resolveAssetPath(projectId, assetId)`；失败时不读取后续节点、不创建 Job。

- [ ] **Step 2: 运行解析器测试并确认失败**

Run: `bun test apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts`

Expected: FAIL，当前实现仍按 `relation === 'reference'` 消费所有节点，并把无 adopted 图片静默跳过。

- [ ] **Step 3: 实现绑定优先的解析流程**

给依赖增加受控素材验证入口：

```ts
resolveAssetPath: (projectId: string, assetId: string) => string
```

在遍历直接入边时按以下顺序处理：

```ts
const binding = resolveCanvasEdgeBinding(edge, sourceNode.kind, targetNode.kind)
if (edge.relation === 'association') continue
if (binding.state === 'unresolved') throw new Error('CANVAS_IMAGE_INPUT_CONFIRMATION_REQUIRED')
if (binding.state === 'incompatible') throw new Error('CANVAS_IMAGE_INPUT_INVALID')

const resolved = await resolveNode(target, sourceNode)
if (binding.targetSlot === 'image.reference' && !resolved?.assetId) {
  throw new Error('CANVAS_IMAGE_INPUT_MISSING')
}
if (!resolved) continue
references.push({
  ...resolved,
  sourcePort: binding.sourceCapability,
  targetPort: binding.targetSlot,
  summary,
  summaryHash: hashSummary(summary),
})
```

图片节点加载配置后必须同时满足：配置 `adoptedAssetId` 存在、节点投影若存在 `adoptedAssetId` 则与配置一致、`resolveAssetPath()` 成功。Agent 输出只进入 `agent.text -> context.text`，即使 JSONL 里存在图片附件也不携带 `assetId`。WebView 只进入 `webview.html -> context.text`。

- [ ] **Step 4: 运行解析器测试**

Run: `bun test apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts`

Expected: PASS；引用、文本、媒体预算仍分别不超过 8、8000 字符和 4 张图。

- [ ] **Step 5: 提交输入解析器**

```bash
git add apps/electron/src/main/lib/design/canvas-image-input-resolver.ts apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts
git commit -m "修复：阻止未确认连线进入图片生成"
```

### Task 4: 在 Job 前完成预检并向执行器注入真实参考图

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts:145`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts:416`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts:1058`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts:2080`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts:431`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts:1490`
- Test: `apps/electron/src/main/lib/design/design-job-manager.test.ts:420`
- Test: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts:3550`
- Test: `apps/electron/src/main/lib/design/design-recovery.test.ts:160`

- [ ] **Step 1: 写失败测试，证明“有 Asset ID”不等于“模型收到图片”**

在 `design-job-manager.test.ts` 增加：

```ts
test('Given Canvas 图片参考已绑定 When 运行生成 Then 隐藏 Agent 收到真实参考图路径', async () => {
  harness.canvasInputReferences = [{
    nodeId: 'image-reference', kind: 'image', revision: 2,
    summary: '当前采用角色三视图', summaryHash: 'a'.repeat(64),
    assetId: 'asset-reference', sourcePort: 'image.asset', targetPort: 'image.reference',
  }]
  harness.messages = [createToolMessage('session-1/output.png')]
  const job = await harness.manager.createCanvasImage(createCanvasImageInput('a'))

  await harness.manager.run(job.id)

  expect(harness.runInputs[0]?.userMessage).toContain(
    'referenceImagePaths: ["/trusted/asset-reference.png"]',
  )
})
```

让 harness 的 `resolveAssetPath` 按 Asset ID 返回 `/trusted/${assetId}.png`。再增加：

```ts
test('Given 批量第二个节点输入待确认 When 运行 Then 不建立任何 Job journal', async () => {
  const imageNodeA: CanvasNode = {
    id: 'image-node-a', kind: 'image', title: '首图',
    position: { x: 0, y: 0 }, imageModuleId: 'image-module-a',
  }
  const imageNodeB: CanvasNode = {
    id: 'image-node-b', kind: 'image', title: '次图',
    position: { x: 100, y: 0 }, imageModuleId: 'image-module-b',
  }
  const context = createContext({
    imagePreflight: async (input) => {
      if (input.target?.kind === 'canvas-image' && input.target.nodeId === 'image-node-b') {
        throw new Error('CANVAS_IMAGE_INPUT_CONFIRMATION_REQUIRED')
      }
    },
  })
  const runtime = getCanvasToolProviderRuntime()
  if (!runtime) throw new Error('Canvas Tool Provider runtime 未注册')

  const result = await runtime.runNodes(
    {
      projectId: 'project-1', sessionId: 'agent-session-1', runStartedAt: 99,
      explicitReferences: [], permissionCeiling: 'execute',
    },
    { projectId: 'project-1', canvasId: 'canvas-1' },
    [imageNodeA, imageNodeB],
    'tool-preflight',
  )

  expect(context.imageCalls.filter((call) => call.type === 'create-once')).toHaveLength(0)
  expect(result.tasks).toContainEqual(expect.objectContaining({
    nodeId: 'image-node-b', status: 'failed', error: 'CANVAS_IMAGE_INPUT_CONFIRMATION_REQUIRED',
  }))
})
```

同步给 `createContext()` 的 overrides 增加 `imagePreflight`，并把它注入测试 runtime 的 `imageJobs.preflightCanvasImage`；默认实现返回 resolved Promise，确保其它用例不需要改写业务意图。

为手动 `CREATE_IMAGE_JOB` 增加公开信封断言：输入待确认返回 `CANVAS_IMAGE_INPUT_CONFIRMATION_REQUIRED` 和中文消息，不泄露 edge ID、Asset ID 或路径。

- [ ] **Step 2: 运行 Job、IPC 与恢复测试并确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/design-recovery.test.ts`

Expected: FAIL，当前 prompt 只有 Asset ID；批量预检仍发生在逐个 `createCanvasImageOnce()` 内。

- [ ] **Step 3: 给 Job Manager 增加无写入预检并保持创建时二次校验**

新增公开窄方法：

```ts
async preflightCanvasImage(input: CreateDesignJobInput): Promise<void> {
  if (input.target?.kind !== 'canvas-image') throw new Error('CANVAS_IMAGE_TARGET_INVALID')
  const targetAdapter = this.dependencies.canvasImageTargetAdapter
  const inputResolver = this.dependencies.canvasImageInputResolver
  if (!targetAdapter || !inputResolver) throw new Error('Canvas 图片任务执行边界未初始化')
  await targetAdapter.assertTarget(input.projectId, input.target)
  this.dependencies.imageModels.resolveAvailableSnapshot(input.imageModelProfileId)
  await inputResolver.resolve(toCanvasImageTarget(input.projectId, input.target))
}
```

`createCanvasImageInternal()` 继续执行同样校验，避免其它内部调用绕过可信边界。`canvas-document-ipc.ts` 的批量第一阶段为所有图片组装完整 `CreateDesignJobInput`，依次调用 `preflightCanvasImage()`；只有全部成功才进入现有 journal 创建循环。

- [ ] **Step 4: 将正式媒体转换为运行时真实路径**

在 `DesignJobManager` 增加：

```ts
private resolveCanvasReferenceImagePaths(job: StoredDesignJob): string[] {
  if (job.target.kind !== 'canvas-image') return []
  const assetIds = (job.canvasInputReferences ?? []).flatMap((reference) => (
    reference.targetPort === 'image.reference' && reference.assetId
      ? [reference.assetId]
      : []
  ))
  return [...new Set(assetIds)].map((assetId) => (
    this.dependencies.assetService.resolveAssetPath(job.projectId, assetId)
  ))
}
```

`buildPrompt()` 对 Canvas 图片任务始终写入结构化路径：

```ts
const connectedReferencePaths = this.resolveCanvasReferenceImagePaths(job)
const sourcePaths = job.action === 'edit'
  ? [this.dependencies.assetService.resolveAssetPath(job.projectId, job.sourceAssetId!)]
  : []
const referenceImagePaths = [...new Set([...sourcePaths, ...connectedReferencePaths])]
commonInstructions.push(`referenceImagePaths: ${JSON.stringify(referenceImagePaths)}`)
```

不要把绝对路径写入 Job journal、Canvas 文档、IPC 或 Renderer；重试继续复制 Asset ID 和绑定端口，并在每次运行时重新解析当前授权路径。

- [ ] **Step 5: 映射稳定公开错误**

在 `toCanvasPublicError()` 中为 `imageJob` 增加精确映射：

```ts
const canvasImageInputErrors: Readonly<Record<string, CanvasPublicError>> = {
  CANVAS_IMAGE_INPUT_CONFIRMATION_REQUIRED: {
    code: 'CANVAS_IMAGE_INPUT_CONFIRMATION_REQUIRED',
    message: '有引用连线尚未确认用途，请先在画布中确认后再生成。',
  },
  CANVAS_IMAGE_INPUT_MISSING: {
    code: 'CANVAS_IMAGE_INPUT_MISSING',
    message: '图片参考缺少已采用素材，请先导入或采用参考图。',
  },
  CANVAS_IMAGE_INPUT_INVALID: {
    code: 'CANVAS_IMAGE_INPUT_INVALID',
    message: '引用类型与图片输入不兼容，请调整连线用途。',
  },
}
```

批量 Agent 工具只返回上述稳定 code；手动 IPC 返回中文安全消息。

- [ ] **Step 6: 运行 Job、IPC 与恢复测试**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/design-recovery.test.ts`

Expected: PASS；失败预检的 `create-once/run/createSession` 调用数均为 0，合法图片参考路径只出现在运行时 prompt。

- [ ] **Step 7: 提交执行预检**

```bash
git add apps/electron/src/main/lib/design/design-job-manager.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-recovery.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts
git commit -m "修复：在生图前校验并注入真实参考素材"
```

### Task 5: 只有正式采用沿已绑定边传播

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.ts:126`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts:2081`
- Test: `apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts:330`
- Test: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts:1300`

- [ ] **Step 1: 写失败测试，区分候选、采用、旧边和历史版本切换**

把现有四类关系测试改为类型化端口，并增加旧边：

```ts
test('Given 正式采用同时存在绑定边和旧引用边 When 提交 Then 只标记绑定下游', async () => {
  const fixture = createFixture()
  fixture.canvas.nodes.push({
    id: 'downstream-bound', kind: 'document', title: '已绑定下游',
    position: { x: 0, y: 100 }, documentId: 'document-bound', contentRevision: 0,
  }, {
    id: 'downstream-legacy', kind: 'document', title: '旧边下游',
    position: { x: 100, y: 100 }, documentId: 'document-legacy', contentRevision: 0,
  })
  fixture.canvas.edges = [{
    id: 'edge-bound', sourceNodeId: 'node-0', sourcePort: 'image.asset',
    targetNodeId: 'downstream-bound', targetPort: 'context.image', relation: 'depends-on',
  }, {
    id: 'edge-legacy', sourceNodeId: 'node-0', sourcePort: 'output',
    targetNodeId: 'downstream-legacy', targetPort: 'input', relation: 'reference',
  }]
  await fixture.service.createBatch({
    ...fixture.target, batchId: 'batch-bound', source: 'single',
    sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
  })
  await fixture.service.recordJobTerminal({
    ...fixture.target, jobId: 'job-0', status: 'succeeded',
    outputAssetId: 'new-0', error: null,
  })

  const result = await fixture.service.adopt({
    ...fixture.target, batchId: 'batch-bound', mode: 'all',
  })

  expect(result.adoption?.invalidatedDownstreamNodeIds).toEqual(['downstream-bound'])
  expect(fixture.canvas.nodes.find((node) => node.id === 'downstream-legacy')?.upstreamChange)
    .toBeUndefined()
})

test('Given 候选生成成功但未采用 When 登记终态 Then 图 revision 与下游状态不变', async () => {
  const fixture = createFixture()
  const before = structuredClone(fixture.canvas)

  await fixture.service.recordJobTerminal({
    ...fixture.target, jobId: 'job-0', status: 'succeeded',
    outputAssetId: 'new-0', error: null,
  })

  expect(fixture.canvas).toEqual(before)
})
```

在 IPC 测试中覆盖“历史版本设为当前”：必须使用候选采用事务，成功后图片节点和绑定下游在同一图 revision 切换；事务不确定时返回 `CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED`，不能只改图片模块。

- [ ] **Step 2: 运行候选与 IPC 测试并确认失败**

Run: `bun test apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

Expected: FAIL，当前传播只看 relation；历史版本 `ADOPT_IMAGE_ASSET` 仍绕过候选采用 journal。

- [ ] **Step 3: 传播计算增加绑定判定**

在候选服务中单次建立节点索引，并统一使用：

```ts
function isPropagatingCanvasEdge(
  edge: CanvasEdge,
  nodesById: ReadonlyMap<string, CanvasNode>,
): boolean {
  if (edge.relation === 'association') return false
  const source = nodesById.get(edge.sourceNodeId)
  const target = nodesById.get(edge.targetNodeId)
  return Boolean(source && target
    && resolveCanvasEdgeBinding(edge, source.kind, target.kind).state === 'bound')
}
```

`getInvalidatedDownstreamNodeIds()` 和 `createAdoptionProjection()` 必须调用同一 helper，避免恢复哈希与首次提交计算出不同下游集合。

- [ ] **Step 4: 历史版本切换复用候选采用事务**

给候选服务增加一个只允许调用方已持有 Canvas serializer 的窄入口：

```ts
adoptExistingAssetLocked(input: {
  projectId: string
  canvasId: string
  nodeId: string
  imageModuleId: string
  jobId: string
  assetId: string
  currentAssetId: string | null
  currentConfigRevision: number
  batchId: string
}): Promise<CanvasImageCandidateBatch>
```

该入口依次创建单条 `source: 'single'` 批次、把已验证的历史 Asset 登记为 candidate、写 adoption intent 并调用现有 `reconcileIntentLocked()`；它不得重新执行图片 Job。`ADOPT_IMAGE_ASSET` 继续校验 Job/Asset 归属，但改为调用此入口，成功后重新加载模块配置并广播。

- [ ] **Step 5: 运行候选、IPC 与恢复测试**

Run: `bun test apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.test.ts`

Expected: PASS；候选阶段图 revision 不变，采用阶段只沿已绑定边传播，历史版本切换具备同等恢复保证。

- [ ] **Step 6: 提交采用传播**

```bash
git add apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts
git commit -m "修复：仅在正式采用后传播画布更新"
```

### Task 6: 在 Renderer 显示待确认边和一致的版本状态

**Files:**
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.ts:506`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx:121`
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeCard.tsx:202`
- Modify: `apps/electron/src/renderer/components/design/CanvasImageWorkbench.tsx:98`
- Test: `apps/electron/src/renderer/components/design/native-canvas-model.test.ts:270`
- Test: `apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx:420`
- Test: `apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx:200`
- Test: `apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx:250`

- [ ] **Step 1: 写失败测试，锁定显式确认和文案**

新增/修改断言：

```ts
test('Given 历史引用边 When 投影 Then 显示待确认且仍连接结构 Handle', () => {
  const document = createDocument()
  document.edges[0] = {
    ...document.edges[0]!, sourcePort: 'output', targetPort: 'input', relation: 'reference',
  }
  const edges = toNativeCanvasFlowEdges(document)

  expect(edges[0]).toMatchObject({
    sourceHandle: 'output', targetHandle: 'input', selectable: true,
    label: '引用 · 待确认',
  })
})

test('Given 用户重新确认图片引用 When 构造边 Then 同一 edge ID 写入图片绑定', () => {
  const document = createDocument()
  document.nodes.push({
    id: 'image-source', kind: 'image', title: '参考图', position: { x: 0, y: 0 },
    imageModuleId: 'image-source-module', adoptedAssetId: 'image-source-asset',
  })
  document.edges[0] = {
    id: 'edge-image-reference', sourceNodeId: 'image-source', sourcePort: 'output',
    targetNodeId: 'image-1', targetPort: 'input', relation: 'reference',
  }

  expect(confirmNativeCanvasEdge(document.edges[0]!, 'reference', document)).toMatchObject({
    id: document.edges[0]!.id,
    sourcePort: 'image.asset',
    targetPort: 'image.reference',
    relation: 'reference',
  })
})
```

组件测试必须断言：卡片含“有新版本”且仍只渲染 adopted URL；运行中详情含“正在整理生成上下文并生成图片”，不含“Agent 正在”；边菜单可以通过已持久化边点击再次打开。

- [ ] **Step 2: 运行 Renderer 定向测试并确认失败**

Run: `bun test apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx`

Expected: FAIL，边仍把业务端口当 XYFlow Handle、不可点击，卡片仍显示“新版本”，任务文案仍包含“Agent 正在”。

- [ ] **Step 3: 将结构 Handle 与执行端口解耦**

`toNativeCanvasFlowEdges()` 先建立 `nodesById`，再固定使用组件真实 Handle：

```ts
const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
return document.edges.map((edge): Edge => {
  const source = nodesById.get(edge.sourceNodeId)
  const target = nodesById.get(edge.targetNodeId)
  if (!source || !target) throw new Error('CANVAS_EDGE_ENDPOINT_MISSING')
  const binding = resolveCanvasEdgeBinding(edge, source.kind, target.kind)
  return {
    id: edge.id,
    source: edge.sourceNodeId,
    sourceHandle: 'output',
    target: edge.targetNodeId,
    targetHandle: 'input',
    selectable: true,
    deletable: false,
    focusable: true,
    animated: false,
    data: { relation: edge.relation, bindingState: binding.state },
    label: binding.state === 'unresolved'
      ? `${CANVAS_EDGE_RELATION_LABELS[edge.relation]} · 待确认`
      : CANVAS_EDGE_RELATION_LABELS[edge.relation],
  }
})
```

这样节点继续只渲染一个左侧 `input` 和一个右侧 `output` Handle，持久化端口只承担数据合同，不影响连线几何或虚拟化。

- [ ] **Step 4: 让新边和旧边都经过显式确认**

增加纯函数：

```ts
export function confirmNativeCanvasEdge(
  edge: CanvasEdge,
  relation: CanvasEdgeRelation,
  document: CanvasDocument,
): CanvasEdge {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]))
  const source = nodes.get(edge.sourceNodeId)
  const target = nodes.get(edge.targetNodeId)
  if (!source || !target) throw new Error('CANVAS_EDGE_ENDPOINT_MISSING')
  return createCanvasBoundEdge(source, target, {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    relation,
  })
}
```

手动拖线先写 `association + unbound/unbound`。`onEdgeClick` 和键盘选中都把边放入现有 `pendingRelationEdge`；用户点击关系按钮时调用 `confirmNativeCanvasEdge()` 并以同一 edge ID upsert。菜单标签根据来源/目标显示“仅关联”“引用 · 图片参考”或“引用 · 文字上下文”，让用户不用理解端口字符串。

- [ ] **Step 5: 修正文案且不改变卡片内容来源**

在 `CanvasNodeCard.tsx` 把候选标签改为 `有新版本`；`native-canvas-model.ts` 继续只用 `node.adoptedAssetId` 查缩略图。把 `CanvasImageWorkbench.tsx` 的运行文案改为：

```ts
running: '正在整理生成上下文并生成图片。'
```

不得把 `candidateAssetId` 传入折叠卡片，也不得在候选生成时清空 `previewAssetId` 或写入 `adoptedAssetId`。

- [ ] **Step 6: 运行 Renderer 测试**

Run: `bun test apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx`

Expected: PASS；卡片尺寸、正式缩略图、XYFlow 可见节点优化和深浅主题类名不回退。

- [ ] **Step 7: 提交 Renderer 交互**

```bash
git add apps/electron/src/renderer/components/design/native-canvas-model.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx apps/electron/src/renderer/components/design/CanvasNodeCard.tsx apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/CanvasImageWorkbench.tsx apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx
git commit -m "优化：统一画布输入确认与版本状态展示"
```

### Task 7: 全链路回归、客户端冒烟与项目记忆

**Files:**
- Modify: `MEMORY.md`
- Verify: `packages/shared/src/types/canvas.test.ts`
- Verify: `apps/electron/src/main/lib/design/*.test.ts`
- Verify: `apps/electron/src/renderer/components/design/*.test.tsx`

- [ ] **Step 1: 运行第一阶段聚合回归**

Run:

```bash
bun test packages/shared/src/types/canvas.test.ts \
  apps/electron/src/main/lib/design/canvas-document-store.test.ts \
  apps/electron/src/main/lib/design/canvas-agent-node-creation.test.ts \
  apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts \
  apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts \
  apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts \
  apps/electron/src/main/lib/design/design-job-manager.test.ts \
  apps/electron/src/main/lib/design/design-recovery.test.ts \
  apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.test.ts \
  apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts \
  apps/electron/src/main/lib/design/canvas-document-ipc.test.ts \
  apps/electron/src/renderer/components/design/native-canvas-model.test.ts \
  apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx \
  apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx \
  apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx
```

Expected: PASS；测试输出无未处理 Promise rejection。

- [ ] **Step 2: 运行全仓质量门禁**

Run:

```bash
bun run typecheck
bun test --isolate
bun run electron:build
```

Expected: 三条命令退出码均为 0；主进程构建不出现 ESM/CJS external 回归。

- [ ] **Step 3: 启动开发客户端做无计费冒烟**

Run: `bun run dev`

在 Electron 客户端验证以下路径，不点击会触发真实模型费用的最终确认：

1. 打开包含旧 `output/input` 引用边的 Canvas，边显示“待确认”，节点与画布仍可正常加载。
2. 点击旧边，重新选择“引用 · 图片参考”后保存、切换 Canvas、重新进入，确认状态保持。
3. 用 WebView 连向生图节点并选择引用，菜单显示“文字上下文”；不能选择或伪装为图片参考。
4. 构造缺少 adopted 素材的图片参考，点击生成后看到明确阻断消息，任务列表没有新增 Job。
5. 打开已有正式 A 和候选 B 的图片节点，折叠卡片继续显示 A 和“有新版本”；详情可比较 A/B。
6. 采用 B 后卡片切换为 B，只有已绑定下游显示待更新；未绑定旧边和 `association` 下游不变化。

Expected: 无 Tab 内容叠加、无“Agent 正在整理上下文”误导文案、无空白窗口或 Renderer 控制台异常。

- [ ] **Step 4: 回写项目记忆**

在 `MEMORY.md` 的架构决策末尾追加一条，内容包含：

```markdown
- 2026-09-03：Canvas 执行绑定复用 `CanvasEdge.sourcePort/targetPort` 表达 Artifact 输出能力与目标输入槽；旧通用端口只保留为待确认关系，不进入图片执行或采用传播。图片任务只消费正式采用素材，Job journal 保存 Asset ID 与绑定端口，真实路径仅在运行时经 Asset Service 解析；候选不传播，候选或历史版本正式采用后才沿已绑定边标记下游。为什么这样处理：视觉关系、真实媒体和正式版本必须由同一 Host 合同证明；对用户的影响是 WebView 不再冒充参考图，旧画布可继续打开并逐边确认，卡片展示与下游实际消费保持一致。性能上绑定判定保持 O(nodes + edges)，单次任务最多解析 4 张真实媒体，不新增轮询或数据库。
```

- [ ] **Step 5: 检查差异并提交记忆**

Run: `git diff --check`

Expected: 无尾随空格、冲突标记或格式错误。

```bash
git add MEMORY.md
git commit -m "文档：记录画布可信输入与版本传播约束"
```

## 验收结果

- WebView 只能作为文本上下文；没有受控截图能力时不能进入图片媒体槽。
- 图片参考必须绑定 `image.asset -> image.reference`，且来源图片存在正式 adopted Asset。
- 旧边不迁移、不猜测、不触发付费任务；用户可在原边上显式确认。
- 图片 Job journal 固化端口与 Asset ID，隐藏执行 Agent 实际收到受控本地图片路径。
- 卡片、详情“当前版本”和下游输入都指向 adopted Asset；候选仅显示“有新版本”。
- 候选生成不改变图 revision 或下游状态；正式采用才通过 journal 原子切换并传播。
- 普通 Agent、Canvas Agent、LAN/mobile、Automation、Collaboration 的权限和会话可见性不变化。
- 大画布仍按现有可见节点策略渲染；新增检查不扫描其它 Canvas、不读取候选原图。
