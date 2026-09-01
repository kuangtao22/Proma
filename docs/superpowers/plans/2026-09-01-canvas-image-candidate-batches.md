# Canvas 图片候选版本与批次验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让单节点与批量图片生成统一产出可验收候选，只有用户明确采用后才一次性更新正式版本，并可在崩溃、部分失败和基线冲突后恢复到一致状态。

**Architecture:** 主进程新增 Canvas 级候选批次 Store 与采用事务 Service：Store 在受管 `transactions` 目录保存有界 JSON 事实，Service 复用进程级 Canvas serializer、workspace write lease、Canvas document mutation 与图片模块原子写完成登记、补齐、采用、放弃和恢复。Design Job 成功终态改为只登记 Asset 与候选，Renderer 初始 LOAD 只接收活跃批次摘要，详情和缩略图按需读取；所有公开数据经过 shared exact-key parser，四层 IPC 保持一致。

**Tech Stack:** TypeScript、Bun test、Electron IPC、React、Jotai、Radix/shadcn、现有 `runStableDirectoryNative` 原子文件能力。

---

## 文件职责与边界

- `packages/shared/src/types/canvas.ts`：唯一公开批次 schema、输入输出、严格解析器、深拷贝、数量上限与稳定排序合同。
- `apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.ts`：只负责受管 JSON 批次/intent 的扫描、严格读取、原子写与有界摘要，不调用 Job、不修改 Canvas。
- `apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.ts`：唯一业务编排层，负责候选登记、继续补齐、采用/部分采用、放弃、基线校验、恢复和下游失效。
- `apps/electron/src/main/lib/design/design-job-manager.ts`：图片 Job 只导入共享 Asset 并完成 Job 终态，不再自动采用；通过窄回调通知批次 Service 登记候选。
- `apps/electron/src/main/lib/design/canvas-document-ipc.ts`：在既有 serializer + workspace lease 边界内创建批次和暴露 IPC handler，不承载事务算法。
- `apps/electron/src/main/ipc.ts`、`apps/electron/src/preload/design-preload.ts`、`apps/electron/src/renderer/lib/design-adapter.ts`：生产装配与四层 IPC 契约。
- `apps/electron/src/renderer/components/design/use-canvas-image-candidate-batches.ts`：Jotai 批次摘要/详情状态、按需加载与变更后单次刷新。
- `apps/electron/src/renderer/components/design/CanvasImageCandidateBatchPanel.tsx`：批次验收 UI；`CanvasImageWorkbench.tsx` 与 `CanvasNodeCard.tsx` 仅消费状态。
- `apps/electron/default-skills/canvas-production/SKILL.md`：Agent 对候选、批次、补齐和采用授权的行为合同，版本从 `1.0.0` 升到 `1.0.1`。

### Task 1: 定义候选批次共享契约与严格解析

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Test: `packages/shared/src/types/canvas.test.ts`
- Modify: `packages/shared/src/types/design.ts`
- Test: `packages/shared/src/types/design.test.ts`

- [ ] **Step 1: 先写批次状态、条目、摘要、详情和操作输入的失败测试**

```ts
describe('Canvas 图片候选批次合同', () => {
  test('Given exact-key 批次详情 When 解析 Then 返回深拷贝并保持 nodeId 稳定排序', () => {
    const raw = createCanvasImageCandidateBatchFixture({ entryNodeIds: ['node-b', 'node-a'] })
    const parsed = parseCanvasImageCandidateBatch(raw)
    expect(parsed.entries.map((entry) => entry.nodeId)).toEqual(['node-a', 'node-b'])
    raw.entries[0]!.candidateAssetId = 'asset-mutated'
    expect(parsed.entries.find((entry) => entry.nodeId === 'node-b')?.candidateAssetId).not.toBe('asset-mutated')
  })

  test.each([
    ['unknown key', { unexpected: true }],
    ['too many entries', { entries: Array.from({ length: 1001 }, (_, index) => candidateEntry(index)) }],
    ['duplicate node', { entries: [candidateEntry(1), candidateEntry(1)] }],
    ['adopted without result', { status: 'adopted', adoption: null }],
  ])('Given %s When 解析 Then 拒绝损坏数据', (_name, override) => {
    expect(() => parseCanvasImageCandidateBatch({
      ...createCanvasImageCandidateBatchFixture(),
      ...override,
    })).toThrow('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID')
  })
})
```

- [ ] **Step 2: 运行测试，确认共享类型尚不存在**

Run: `bun test packages/shared/src/types/canvas.test.ts -t "Canvas 图片候选批次合同"`

Expected: FAIL，错误包含 `parseCanvasImageCandidateBatch is not defined` 或对应导出不存在。

- [ ] **Step 3: 添加完整公开合同和 parser**

```ts
export type CanvasImageCandidateBatchStatus = 'running' | 'partial' | 'ready' | 'adopted' | 'abandoned'
export type CanvasImageCandidateEntryStatus =
  | 'queued' | 'running' | 'candidate' | 'failed' | 'invalid' | 'adopted' | 'kept'
export type CanvasImageCandidateBatchSource = 'single' | 'canvas-tool'

export interface CanvasImageCandidateBatchEntry {
  nodeId: string
  imageModuleId: string
  initialAdoptedAssetId: string | null
  initialConfigRevision: number
  jobId: string
  candidateAssetId: string | null
  status: CanvasImageCandidateEntryStatus
  error: string | null
}

export interface CanvasImageCandidateBatchAdoption {
  mode: 'all' | 'succeeded'
  adoptedNodeIds: string[]
  keptNodeIds: string[]
  invalidatedDownstreamNodeIds: string[]
  committedAt: number
}

export interface CanvasImageCandidateBatch extends CanvasTarget {
  schemaVersion: 1
  batchId: string
  source: CanvasImageCandidateBatchSource
  sourceSessionId: string | null
  sourceToolCallId: string | null
  status: CanvasImageCandidateBatchStatus
  entries: CanvasImageCandidateBatchEntry[]
  adoption: CanvasImageCandidateBatchAdoption | null
  createdAt: number
  updatedAt: number
}

export interface CanvasImageCandidateBatchSummary extends CanvasTarget {
  batchId: string
  status: CanvasImageCandidateBatchStatus
  totalCount: number
  candidateCount: number
  failedCount: number
  runningCount: number
  updatedAt: number
}

export interface GetCanvasImageCandidateBatchInput extends CanvasTarget { batchId: string }
export interface AdoptCanvasImageCandidateBatchInput extends GetCanvasImageCandidateBatchInput {
  mode: 'all' | 'succeeded'
}
export interface ContinueCanvasImageCandidateBatchInput extends GetCanvasImageCandidateBatchInput {}
export interface AbandonCanvasImageCandidateBatchInput extends GetCanvasImageCandidateBatchInput {}

/** 正式采用后持久化在下游节点上的待更新事实，不隐含自动执行。 */
export interface CanvasNodeUpstreamChange {
  sourceNodeIds: string[]
  changedAt: number
}

export interface SetCanvasNodeUpstreamChangesMutation {
  type: 'set-node-upstream-changes'
  updates: Array<{
    nodeId: string
    change: CanvasNodeUpstreamChange | null
  }>
}
```

在同文件实现并导出 `parseCanvasImageCandidateBatch`、`parseCanvasImageCandidateBatchSummary`、`parseGetCanvasImageCandidateBatchInput`、`parseAdoptCanvasImageCandidateBatchInput`、`parseContinueCanvasImageCandidateBatchInput`、`parseAbandonCanvasImageCandidateBatchInput`。每层对象使用 `hasExactCanvasKeys`；批次最多 1000 条、公开错误最多 1000 字、ID 使用现有 `isCanvasLifecycleId`；拒绝重复 `nodeId`/`jobId`，规范化后按 `nodeId`、`jobId` 排序，数组和对象全部新建。

把 `CanvasNodeBase` 增加可选 `upstreamChange`，严格 parser 只接受 `sourceNodeIds` 非空、去重、稳定排序且最多 100 个的对象；把 `SetCanvasNodeUpstreamChangesMutation` 加入 `CanvasMutation`，在 `applyCanvasMutations()` 中只更新已存在目标节点。把 `CanvasWorkspaceSnapshot` 增加 `activeImageCandidateBatches: CanvasImageCandidateBatchSummary[]`，parser 限制最多 20 条并按 `updatedAt DESC, batchId ASC` 排序。给 `CanvasPublicErrorCode` 增加 `CANVAS_IMAGE_BATCH_CONFLICT`、`CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED`、`CANVAS_IMAGE_BATCH_INVALID`。

在 `packages/shared/src/types/design.ts` 给 Canvas 图片 Job 增加可选 `candidateBatchId`，严格 parser 只允许 `target.kind === 'canvas-image'` 时携带并使用稳定 ID 校验；非 Canvas Job 携带该字段必须失败。这样 Job 恢复可 O(1) 定位批次，不需要扫描全部历史批次。

- [ ] **Step 4: 增加 IPC 通道常量并验证 exact-key 边界**

```ts
export const CANVAS_IPC_CHANNELS = {
  // 保留现有字段
  GET_IMAGE_CANDIDATE_BATCH: 'canvas:image-candidate-batch:get',
  CONTINUE_IMAGE_CANDIDATE_BATCH: 'canvas:image-candidate-batch:continue',
  ADOPT_IMAGE_CANDIDATE_BATCH: 'canvas:image-candidate-batch:adopt',
  ABANDON_IMAGE_CANDIDATE_BATCH: 'canvas:image-candidate-batch:abandon',
} as const
```

测试额外断言未知字段、负 revision、非法状态、超长错误、重复条目、超过摘要/条目上限均抛 `CANVAS_IMAGE_CANDIDATE_BATCH_INVALID`。

- [ ] **Step 5: 运行共享类型测试并提交**

Run: `bun test packages/shared/src/types/canvas.test.ts`

Expected: PASS，且现有 Canvas parser 测试无回归。

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts packages/shared/src/types/design.ts packages/shared/src/types/design.test.ts
git commit -m "新增 Canvas 图片候选批次共享契约"
```

### Task 2: 建立有界、原子、可恢复的批次 Store

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.ts`
- Create: `apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-store.ts`

- [ ] **Step 1: 写批次扫描、原子写、提交不确定和摘要上限测试**

```ts
test('Given 千节点与历史批次 When loadActiveSummaries Then 只返回 20 个活跃摘要且不读 Asset', async () => {
  const fixture = createCandidateBatchStoreFixture({ batchCount: 40, entriesPerBatch: 1000 })
  const summaries = await fixture.store.loadActiveSummaries(fixture.target)
  expect(summaries).toHaveLength(20)
  expect(summaries.every((item) => !('entries' in item))).toBe(true)
  expect(fixture.assetReads).toBe(0)
})

test('Given commitVisible 且 durabilityUncertain When save Then 重扫确认同一内容后成功', async () => {
  const fixture = createCandidateBatchStoreFixture({ durabilityUncertain: true })
  await expect(fixture.store.save(fixture.batch)).resolves.toEqual(fixture.batch)
  expect(fixture.scanCount).toBe(1)
})
```

- [ ] **Step 2: 运行测试，确认 Store 尚不存在**

Run: `bun test apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.test.ts`

Expected: FAIL，错误包含模块不存在。

- [ ] **Step 3: 实现 Store 的窄接口与磁盘布局**

```ts
export interface CanvasImageCandidateBatchStore {
  loadActiveSummaries(target: CanvasTarget): Promise<CanvasImageCandidateBatchSummary[]>
  load(target: CanvasTarget, batchId: string): Promise<CanvasImageCandidateBatch>
  save(batch: CanvasImageCandidateBatch): Promise<CanvasImageCandidateBatch>
  scanAdoptionIntents(target: CanvasTarget): Promise<CanvasImageCandidateAdoptionIntent[]>
  writeAdoptionIntent(intent: CanvasImageCandidateAdoptionIntent): Promise<void>
}
```

批次文件固定为 `transactions/image-candidate-batch-${batchId}.json`，采用 intent 固定为 `transactions/image-candidate-adoption-${operationId}.json`。通过 `CanvasDocumentStore.loadWithDirectoryCapability()` 获取可信目录能力，使用 `runStableDirectoryNative` 的 `canvas-intent-read`/`canvas-intent-write`，每次操作前后 `assertValid()`；单文件 1 MiB、目录最多 512 个批次文件。写入必须检查 `commitVisible`，`durabilityUncertain` 时立即重扫并用规范化 JSON 精确比较，无法证明则抛 `CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED`。

在 `canvas-document-store.ts` 仅扩展现有 capability 允许上述固定文件前缀，不开放任意路径。Store 读取全部调用 Task 1 parser；活跃摘要仅保留 `running|partial|ready`，按稳定顺序截断 20 条。

- [ ] **Step 4: 覆盖损坏文件、跨 Canvas 身份和 abandon 过滤**

```ts
test.each(['unknown-key', 'wrong-canvas', 'duplicate-node', 'oversized'])(
  'Given %s 批次文件 When load Then fail closed',
  async (kind) => expect(loadCorruptBatch(kind)).rejects.toThrow('CANVAS_IMAGE_CANDIDATE_BATCH_INVALID'),
)

test('Given adopted 与 abandoned 历史批次 When loadActiveSummaries Then 不返回', async () => {
  const summaries = await fixture.store.loadActiveSummaries(fixture.target)
  expect(summaries.map((item) => item.status)).not.toContain('adopted')
  expect(summaries.map((item) => item.status)).not.toContain('abandoned')
})
```

- [ ] **Step 5: 运行 Store 测试并提交**

Run: `bun test apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.test.ts apps/electron/src/main/lib/design/canvas-document-store.ts
git commit -m "持久化 Canvas 图片候选批次与采用意图"
```

### Task 3: 实现候选登记与批次状态机

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.ts`
- Create: `apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-image-module-store.ts`

- [ ] **Step 1: 写 14 节点部分成功、单节点候选和迟到完成测试**

```ts
test('Given 14 节点批次 When 只有 2 个 Job 成功 Then 批次 partial 且全部正式版本不变', async () => {
  const fixture = createCandidateBatchServiceFixture({ nodeCount: 14 })
  await fixture.service.createBatch(fixture.createInput)
  await fixture.succeedJobs([0, 1])
  const batch = await fixture.service.load(fixture.target, fixture.batchId)
  expect(batch.status).toBe('partial')
  expect(batch.entries.filter((entry) => entry.status === 'candidate')).toHaveLength(2)
  expect(fixture.currentAdoptedAssetIds()).toEqual(fixture.initialAdoptedAssetIds)
})

test('Given abandoned 批次 When Job 迟到成功 Then 只记录历史候选且批次仍 abandoned', async () => {
  await fixture.service.abandon(fixture.batchInput)
  await fixture.service.recordJobTerminal(fixture.successEvent)
  expect((await fixture.service.load(fixture.target, fixture.batchId)).status).toBe('abandoned')
  expect(fixture.currentAdoptedAssetIds()).toEqual(fixture.initialAdoptedAssetIds)
})
```

- [ ] **Step 2: 运行测试，确认 Service 尚不存在**

Run: `bun test apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts -t "14 节点|abandoned"`

Expected: FAIL，错误包含模块不存在。

- [ ] **Step 3: 实现创建、终态登记和放弃状态机**

```ts
export interface CanvasImageCandidateBatchService {
  createBatch(input: CreateCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
  recordJobTerminal(event: CanvasImageCandidateJobTerminalEvent): Promise<void>
  load(target: CanvasTarget, batchId: string): Promise<CanvasImageCandidateBatch>
  continueBatch(input: ContinueCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
  adopt(input: AdoptCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
  abandon(input: AbandonCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
  reconcile(target: CanvasTarget): Promise<void>
}
```

`createBatch` 固化每个节点的 `initialAdoptedAssetId`、`initialConfigRevision` 和预分配 `jobId`；单节点也创建 `source: 'single'` 的一条目批次。`recordJobTerminal` 只接受批次已登记 Job：成功时验证 `outputAssetId` 与 Asset `sourceJobId` 后写 `candidateAssetId`，失败/取消/中断写稳定错误；不得调用 `CanvasImageModuleStore.adoptAsset`。状态派生规则固定为：仍有 queued/running 为 `running`；无运行项且 candidate 与失败/无效并存为 `partial`；全部 candidate 为 `ready`；终态 `adopted|abandoned` 不被迟到事件逆转。

给 `CanvasImageModuleStore` 增加供事务使用的 `loadWithCapability` 与 `commitAdoptedAssetLocked` 窄接口：调用方必须传 Store 颁发的同一 Canvas capability 和 expected revision，内部仍按 config 后写、meta 最后提交的既有协议执行，Renderer 不可访问该接口。

- [ ] **Step 4: 验证候选丢失、节点删除和 Job 归属冲突只使条目失效**

```ts
test.each(['asset-missing', 'node-deleted', 'job-owner-conflict'])(
  'Given %s When reconcile Then 条目 invalid 且不重建节点',
  async (scenario) => {
    const fixture = createCandidateBatchServiceFixture({ scenario })
    await fixture.service.reconcile(fixture.target)
    expect((await fixture.loadEntry()).status).toBe('invalid')
    expect(fixture.createdNodes).toBe(0)
    expect(fixture.currentAdoptedAssetIds()).toEqual(fixture.initialAdoptedAssetIds)
  },
)
```

- [ ] **Step 5: 运行状态机测试并提交**

Run: `bun test apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts apps/electron/src/main/lib/design/canvas-image-module-store.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts apps/electron/src/main/lib/design/canvas-image-module-store.ts apps/electron/src/main/lib/design/canvas-image-module-store.test.ts
git commit -m "建立 Canvas 图片候选批次状态机"
```

### Task 4: 实现逻辑原子的整批采用与崩溃恢复

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts`
- Modify: `packages/shared/src/types/canvas.ts`
- Test: `packages/shared/src/types/canvas.test.ts`

- [ ] **Step 1: 写全量采用、部分采用、基线冲突和中断恢复测试**

```ts
test('Given 全部候选有效 When adopt all Then 模块与节点一次发布且无半批投影', async () => {
  const fixture = createReadyBatchFixture(14)
  const result = await fixture.service.adopt({ ...fixture.target, batchId: fixture.batchId, mode: 'all' })
  expect(result.status).toBe('adopted')
  expect(fixture.publications).toHaveLength(1)
  expect(fixture.publications[0]!.nodes.filter(isImageNode).map((node) => node.adoptedAssetId))
    .toEqual(fixture.candidateAssetIds)
  expect(fixture.observedRendererSnapshots).toEqual([fixture.beforeSnapshot, fixture.afterSnapshot])
})

test('Given 2 成功 12 失败 When adopt succeeded Then 明确记录 2 adopted 与 12 kept', async () => {
  const fixture = createPartialBatchFixture({ total: 14, succeeded: 2 })
  const result = await fixture.service.adopt({ ...fixture.target, batchId: fixture.batchId, mode: 'succeeded' })
  expect(result.adoption).toMatchObject({ mode: 'succeeded' })
  expect(result.adoption?.adoptedNodeIds).toHaveLength(2)
  expect(result.adoption?.keptNodeIds).toHaveLength(12)
})

test.each(['asset-changed', 'config-revision-changed', 'node-deleted', 'candidate-missing'])(
  'Given %s When adopt Then 拒绝覆盖任何正式版本',
  async (scenario) => expect(createConflictFixture(scenario).adopt()).rejects.toThrow('CANVAS_IMAGE_BATCH_CONFLICT'),
)
```

- [ ] **Step 2: 运行测试，确认当前 Service 不具备采用事务**

Run: `bun test apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts -t "adopt all|adopt succeeded|拒绝覆盖"`

Expected: FAIL，至少一个断言显示模块或 Canvas 已产生半批状态。

- [ ] **Step 3: 定义并实现可恢复采用 intent**

```ts
export type CanvasImageCandidateAdoptionState =
  | 'prepared' | 'modules-committing' | 'graph-committed' | 'batch-committed'

export interface CanvasImageCandidateAdoptionIntent extends CanvasTarget {
  schemaVersion: 1
  operationId: string
  batchId: string
  mode: 'all' | 'succeeded'
  baseCanvasRevision: number
  entries: Array<{
    nodeId: string
    imageModuleId: string
    oldAssetId: string | null
    candidateAssetId: string
    expectedConfigRevision: number
    committedConfigRevision: number | null
  }>
  expectedGraphSha256: string
  state: CanvasImageCandidateAdoptionState
  createdAt: number
  updatedAt: number
}
```

`adopt` 与 `reconcile` 必须由 `runExclusive(target, effect)` 包裹，该依赖在生产中依次取得 `CanvasOperationSerializer.run()` 和 `WorkspaceOperationGuard.runWorkspaceWrite()`。算法顺序固定：加载权威 Canvas/批次并建立 node、Job、Asset Map；O(n) 校验目标节点、初始正式 Asset、config revision、Job 成功、Asset 归属/文件存在、parent 血缘；先写 `prepared` intent；逐模块 CAS 提交并在每项后写 `committedConfigRevision`；一次 `store.mutate()` upsert 全部图片节点 adopted 投影，并用 `set-node-upstream-changes` 给 `reference|depends-on|derives` 的下游写 `upstreamChange`；写 `graph-committed`；写批次 `adopted` 与 adoption 结果；最后写 `batch-committed`。

为避免 Renderer 看到半批，模块逐项提交期间不发布 change event；Canvas 图提交完成且批次事实可证明后只发布一次。`association` 边跳过，下游只写提示状态，不调用 `imageJobs.run()`。`mode: 'all'` 要求全部条目均为 candidate；`mode: 'succeeded'` 只纳入 candidate，其余进入 `keptNodeIds`。

- [ ] **Step 4: 实现每阶段幂等恢复与提交不确定阻断**

```ts
test.each(['after-first-module', 'after-all-modules', 'after-graph', 'after-batch'])(
  'Given %s 崩溃 When reconcile Then 不重复 revision 且最终只发布完整投影',
  async (crashPoint) => {
    const fixture = createCrashRecoveryFixture(crashPoint)
    await fixture.restartAndReconcile()
    expect(fixture.hasHalfBatchProjection()).toBe(false)
    expect(fixture.duplicateConfigCommits).toBe(0)
    expect(fixture.publications).toHaveLength(1)
  },
)
```

恢复时逐项比较 config 的当前 Asset/revision 与 intent 的旧值/已提交值：已完成则跳过，仍是旧值则继续，第三种事实立即抛冲突。Canvas 当前图等于 `expectedGraphSha256` 时视为已提交；否则只允许从 `baseCanvasRevision` 提交。任何 intent 写入 durability 不可证明时返回 `CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED` 并阻断同批新采用，先由权威 LOAD 对账。

- [ ] **Step 5: 运行采用事务与 shared parser 测试并提交**

Run: `bun test apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts packages/shared/src/types/canvas.test.ts`

Expected: PASS，覆盖全量采用、明确混合状态、四个中断点和三类下游关系。

```bash
git add apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts
git commit -m "实现可恢复的图片候选整批采用事务"
```

### Task 5: 拆分 Job 输出登记与采用，并让单节点/批量运行创建批次

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-image-job-target.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-image-job-target.test.ts`

- [ ] **Step 1: 锁定“成功只登记候选”的 Job 回归测试**

```ts
test('Given Canvas 图片任务成功 When commit output Then Job succeeded 且不采用输出', async () => {
  const harness = createManagerHarness()
  await harness.completeCanvasImageJob('job-1', 'asset-output')
  expect(harness.manager.get('job-1')).toMatchObject({ status: 'succeeded', outputAssetId: 'asset-output' })
  expect(harness.adoptOutputCalls).toEqual([])
  expect(harness.recordCandidateCalls).toEqual([{ jobId: 'job-1', assetId: 'asset-output' }])
})
```

- [ ] **Step 2: 运行 Job 与 IPC 定向测试，确认现有自动采用行为使测试失败**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts -t "成功.*不采用|同一候选批次"`

Expected: FAIL，`adoptOutputCalls` 当前包含输出 Asset，且批量运行没有稳定 batchId。

- [ ] **Step 3: 修改 Design Job 终态为 Asset 提交后登记候选**

将 `DesignJobManager` 依赖从图片 `adoptOutput/isOutputAdopted` 改为窄回调：

```ts
canvasImageCandidateBatches?: {
  recordJobTerminal(event: {
    projectId: string
    jobId: string
    target: CanvasImageJobTarget
    status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
    outputAssetId: string | null
    error: string | null
  }): Promise<void>
}
```

`commitCanvasImageOutput()` 仍用既有 terminal pending 保障 Asset 导入恢复，但 Asset 已进入权威 Design Store 后立即 `batch.commit()`、将 Job 写为 `succeeded`，再幂等调用 `recordJobTerminal`；登记暂不可写时保留独立的 candidate-registration pending 标记供恢复，不把已存在 Asset 回滚。删除 `reconcileCanvasImageTerminalJob()` 中自动采用分支；`canvas-image-job-target.ts` 保留目标/Asset 归属校验，但不再作为 Job 成功采用器。

- [ ] **Step 4: 单节点与 `runCanvasNodes` 在创建 Job 前先创建稳定批次**

单节点 `RUN_IMAGE_JOB` 创建一条目 `source: 'single'` 批次。`runCanvasNodes()` 在同一 `runImageCanvasExclusive` 内完成全量预检后，用 `createAgentCanvasImageJobId(...)` 得到全部 Job ID，再创建一个 `source: 'canvas-tool'` 批次并把 `batchId` 固化进每个 Job 的候选归属；任一 journal 创建失败时，批次保留失败审计，不重复启动已成功候选。

```ts
expect(new Set(createdJobs.map((job) => job.candidateBatchId))).toEqual(new Set([expectedBatchId]))
expect(batch.entries.map((entry) => entry.jobId)).toEqual(createdJobs.map((job) => job.id).sort())
```

`continueBatch()` 只为 `failed|invalid` 且节点/基线仍有效的条目创建 replacement Job，candidate 条目原样保留；测试断言已有成功项的 `run` 调用次数仍为 1，避免重复付费。

- [ ] **Step 5: 运行 Job、目标适配器和 IPC 测试并提交**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/canvas-image-job-target.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

Expected: PASS，原 Canvas 图片任务成功测试已改为候选语义，非 Canvas 图片 Job 测试不变。

```bash
git add apps/electron/src/main/lib/design/design-job-manager.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/canvas-image-job-target.ts apps/electron/src/main/lib/design/canvas-image-job-target.test.ts
git commit -m "将 Canvas 图片任务输出改为候选登记"
```

### Task 6: 接通主进程、Preload 与 Renderer Adapter 四层 IPC

**Files:**
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/preload/design-preload.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写四个 IPC handler、授权、parser 和公开错误映射测试**

```ts
test.each([
  ['GET_IMAGE_CANDIDATE_BATCH', 'load'],
  ['CONTINUE_IMAGE_CANDIDATE_BATCH', 'continueBatch'],
  ['ADOPT_IMAGE_CANDIDATE_BATCH', 'adopt'],
  ['ABANDON_IMAGE_CANDIDATE_BATCH', 'abandon'],
])('Given authorized sender When %s Then 调用批次 Service.%s', async (channel, method) => {
  const result = await fixture.invoke(CANVAS_IPC_CHANNELS[channel], fixture.validInput(channel))
  expect(result.ok).toBe(true)
  expect(fixture.calls[method]).toHaveLength(1)
})
```

- [ ] **Step 2: 运行四层测试，确认方法尚未接通**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts -t "IMAGE_CANDIDATE_BATCH|图片候选批次"`

Expected: FAIL，通道或 adapter 方法不存在。

- [ ] **Step 3: 在主进程装配唯一 Store/Service，并注册 handler**

在 `ipc.ts` 创建进程级唯一 `canvasImageCandidateBatchStore` 和 `canvasImageCandidateBatchService`，向 Service 注入现有 `canvasOperationSerializer`、`workspaceOperationGuard.runWorkspaceWrite`、`canvasDocumentStore`、`canvasImageModuleStore`、`designJobManager` 与 Asset 查询器。向 `registerCanvasDocumentIpc` 注入 Service 窄接口。

在 `canvas-document-ipc.ts` 的四个 handler 中先 `assertAuthorizedSender`、再调用 Task 1 parser；读操作直接 load，继续/采用/放弃使用 `runImageCanvasExclusive`，统一通过 `invokeCanvasOperation('imageBatch', ...)` 返回安全信封。将冲突、恢复要求、损坏数据分别映射为 Task 1 的稳定公开错误码，不泄漏路径或堆栈。

- [ ] **Step 4: 同步 Preload API 与 Renderer Adapter**

```ts
export interface CanvasImageCandidateBatchAdapter {
  get(input: GetCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
  continueBatch(input: ContinueCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
  adopt(input: AdoptCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
  abandon(input: AbandonCanvasImageCandidateBatchInput): Promise<CanvasImageCandidateBatch>
}
```

Preload 只调用固定 `ipcRenderer.invoke(CANVAS_IPC_CHANNELS.*)`；Adapter 使用既有 `unwrapCanvasInvokeResult`，缺失方法返回固定中文集成错误。测试同时断言输入未经扩展、公开错误保留 code/message、Electron rejection 原文不进入 Renderer。

- [ ] **Step 5: 运行 IPC 契约测试并提交**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: PASS，四层方法名和输入输出完全一致。

```bash
git add apps/electron/src/main/ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "接通 Canvas 图片候选批次 IPC"
```

### Task 7: 用 Jotai 管理按需详情，并实现批次验收 UI

**Files:**
- Create: `apps/electron/src/renderer/components/design/use-canvas-image-candidate-batches.ts`
- Create: `apps/electron/src/renderer/components/design/use-canvas-image-candidate-batches.test.ts`
- Create: `apps/electron/src/renderer/components/design/CanvasImageCandidateBatchPanel.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasImageCandidateBatchPanel.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasImageWorkbench.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeCard.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx`

- [ ] **Step 1: 写摘要懒加载、卡片正式图和操作状态测试**

```tsx
test('Given 折叠图片卡片有候选 When render Then 仍显示正式缩略图且不读取批次详情', () => {
  render(<NativeCanvasWorkspace {...fixture.props({ nodeCount: 1000, activeBatch: fixture.summary })} />)
  expect(screen.getByRole('img', { name: '当前正式版本' })).toHaveAttribute('src', fixture.adoptedThumbnailUrl)
  expect(screen.getByText('新版本')).toBeInTheDocument()
  expect(fixture.batchAdapter.get).not.toHaveBeenCalled()
})

test('Given partial 批次 When 打开面板 Then 显示计数与三个明确操作', async () => {
  await fixture.openBatchPanel()
  expect(screen.getByText('2 / 14')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '继续补齐' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '采用已成功项' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '放弃本批次' })).toBeEnabled()
})
```

- [ ] **Step 2: 运行 Renderer 定向测试，确认候选 UI 尚不存在**

Run: `bun test apps/electron/src/renderer/components/design/CanvasImageCandidateBatchPanel.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx`

Expected: FAIL，批次 hook/Panel 模块不存在。

- [ ] **Step 3: 实现 Jotai 状态与按需读取**

以 `${projectId}\0${canvasId}` 为 atomFamily 键，状态包含 `summaries`、`selectedBatchId`、`detailByBatchId`、`loading`、`operation`、`error`。Workspace LOAD 只注入 summary；用户点击卡片标记或“查看批次”时才调用 adapter.get。继续/采用/放弃成功后先以返回批次更新详情和摘要，再触发一次权威 Canvas refresh；并发点击以 operation token 丢弃旧响应。

- [ ] **Step 4: 实现卡片、图片详情和批次面板**

`CanvasNodeCard` 的图片 `src` 始终来自节点 `adoptedAssetId`，候选只增加“新版本”或“部分完成”按钮标记。`CanvasImageWorkbench` 默认把最新 candidate 设为 `previewAssetId`，提供“当前版本 / 候选版本”分段控件和并排比较；历史项分别显示“当前”“候选”“历史”。单节点采用调用批次 `mode: 'all'`，不再直接循环或调用旧单节点 adopt IPC。

`CanvasImageCandidateBatchPanel` 使用现有 Dialog/Sheet、Button、ScrollArea 与主题变量：头部显示完成/失败/运行计数；条目按 nodeId 稳定排列，缩略图使用已有 `thumbnailBaseUrl`；`ready` 主按钮为“全部采用”，`partial|running` 主按钮为“继续补齐”，次按钮为“采用已成功项”，终态禁用重复操作。部分采用点击后用 AlertDialog 明确列出采用数与保留旧版数；所有按钮具备 loading、键盘焦点和可读错误态。

- [ ] **Step 5: 运行 Renderer 测试并提交**

Run: `bun test apps/electron/src/renderer/components/design/use-canvas-image-candidate-batches.test.ts apps/electron/src/renderer/components/design/CanvasImageCandidateBatchPanel.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx`

Expected: PASS；折叠卡片不读详情或原图，采用完成只触发一次权威 refresh。

```bash
git add apps/electron/src/renderer/components/design/use-canvas-image-candidate-batches.ts apps/electron/src/renderer/components/design/use-canvas-image-candidate-batches.test.ts apps/electron/src/renderer/components/design/CanvasImageCandidateBatchPanel.tsx apps/electron/src/renderer/components/design/CanvasImageCandidateBatchPanel.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/CanvasImageWorkbench.tsx apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx apps/electron/src/renderer/components/design/CanvasNodeCard.tsx apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx
git commit -m "新增 Canvas 图片候选批次验收界面"
```

### Task 8: 更新 Agent 批次语义与默认 Skill 版本

**Files:**
- Modify: `apps/electron/default-skills/canvas-production/SKILL.md`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`
- Modify: `apps/electron/src/renderer/components/design/CanvasAgentConversation.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx`

- [ ] **Step 1: 写结构化批次摘要和禁止“已替换”语义测试**

```ts
test('Given 批量图片任务已创建 When tool result Then 返回批次摘要与验收入口而非裸 Asset ID', async () => {
  const result = await fixture.runImageNodes()
  expect(result.batch).toMatchObject({ batchId: fixture.batchId, status: 'running', totalCount: 14 })
  expect(JSON.stringify(result)).not.toContain('候选已正式替换')
})
```

- [ ] **Step 2: 运行工具与对话测试，确认当前结果只有逐任务状态**

Run: `bun test apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx -t "批次摘要|画布验收"`

Expected: FAIL，结果中不存在 `batchId` 或打开画布入口。

- [ ] **Step 3: 扩展工具结果与对话摘要**

`CanvasToolRunNodesResult` 增加有界 `batch` 摘要；Agent 对话渲染“候选已生成 X/Y、失败 Y、运行中 Z”和“打开画布验收”命令，不渲染 Asset ID 列表。Agent 未调用采用能力时只允许表述“候选”；部分采用结果必须含 adopted/kept/downstream 三个计数。历史消息继续保留运行当时固化的 Asset ID，不根据当前 adopted 指针重写。

- [ ] **Step 4: 修改默认 Skill 并将 patch 版本加一**

把 frontmatter 精确改为：

```yaml
version: 1.0.1
```

在批量图片规则中明确：同一规划复用 batchId；重试只补齐失败项；不得把候选称为正式替换；只有明确授权才调用全部采用；部分采用必须再次说明会形成混合正式版本；采用后只汇报待更新下游，不自动触发付费任务。

- [ ] **Step 5: 运行 Skill 与 Agent 测试并提交**

Run: `bun test apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx`

Expected: PASS。

Run: `rg -n '^version: 1\.0\.1$|候选|全部采用|采用已成功项' apps/electron/default-skills/canvas-production/SKILL.md`

Expected: 输出包含版本行和四类候选验收规则。

```bash
git add apps/electron/default-skills/canvas-production/SKILL.md apps/electron/src/main/lib/design/canvas-tool-provider.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/renderer/components/design/CanvasAgentConversation.tsx apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx
git commit -m "更新 Canvas Agent 图片候选验收规则"
```

### Task 9: 完成性能、集成与全量验证

**Files:**
- Modify: `apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts`

- [ ] **Step 1: 增加千节点与端到端 BDD 回归**

```ts
test('Given 千节点 Canvas 与活跃候选摘要 When 初始加载 Then 不加载批次详情或候选原图', async () => {
  const fixture = createPerformanceFixture({ nodeCount: 1000, activeBatchCount: 20 })
  await fixture.render()
  expect(fixture.getBatchCalls).toBe(0)
  expect(fixture.candidateOriginalImageRequests).toBe(0)
  expect(fixture.renderedCandidateBadges).toBeLessThanOrEqual(1000)
})
```

在 IPC 集成测试串起：14 节点创建批次 -> 2 成功/12 失败 -> 所有正式版本不变 -> 继续补齐仅启动 12 个 -> 全部 ready -> adopt all -> 单次 change event -> 14 个 config 与节点投影一致。另建独立用例覆盖部分采用、候选丢失、节点删除、基线 revision 冲突、提交不确定和 abandoned 后 Job 迟到。

- [ ] **Step 2: 运行最小相关测试集合**

Run: `bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-store.test.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts apps/electron/src/renderer/components/design/use-canvas-image-candidate-batches.test.ts apps/electron/src/renderer/components/design/CanvasImageCandidateBatchPanel.test.tsx apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx`

Expected: PASS，无跳过用例。

- [ ] **Step 3: 运行类型检查**

Run: `bun run typecheck`

Expected: PASS，无 TypeScript diagnostics；新增代码不含 `any`，所有新增方法和变量有清晰中文注释。

- [ ] **Step 4: 运行 Electron 构建验证主进程/Preload/Renderer 边界**

Run: `bun run electron:build`

Expected: PASS，Vite 与 Electron 主进程构建均成功，无 unresolved IPC/type import。

- [ ] **Step 5: 检查差异、占位文本和默认 Skill 版本后提交**

Run: `git diff --check`

Expected: 无输出。

Run: `rg -n '[T]ODO|[T]BD|implement[ ]later|适当[ ]处理|类似[ ]Task|待[ ]补' packages/shared/src/types/canvas.ts apps/electron/src/main/lib/design apps/electron/src/preload apps/electron/src/renderer apps/electron/default-skills/canvas-production/SKILL.md`

Expected: 新增/修改行无匹配；若仓库既有行命中，仅记录其原有路径，不在本任务扩 scope。

Run: `git diff -- apps/electron/default-skills/canvas-production/SKILL.md | rg '^[+-]version:'`

Expected: 只显示 `-version: 1.0.0` 与 `+version: 1.0.1`。

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design apps/electron/src/main/ipc.ts apps/electron/src/preload apps/electron/src/renderer apps/electron/default-skills/canvas-production/SKILL.md
git commit -m "完善 Canvas 图片候选批次集成验证"
```

## 需求覆盖自检

- 单节点和批量生成统一候选：Task 3、Task 5。
- Job 成功不提前采用、旧 Asset 与版本血缘保留：Task 3、Task 5。
- `running | partial | ready | adopted | abandoned` 与完整条目基线：Task 1、Task 3。
- 全部采用、继续补齐、采用已成功项、放弃：Task 3、Task 4、Task 6、Task 7。
- 部分失败、候选丢失、节点删除、基线变化、提交不确定、abandoned 后迟到完成：Task 3、Task 4、Task 9。
- serializer、workspace lease、intent、模块 config 与 Canvas 投影逻辑原子：Task 4、Task 6。
- 下游仅处理 `reference`、`depends-on`、`derives`，排除 `association` 且不自动付费运行：Task 4、Task 8。
- 初始 LOAD 只带活跃摘要，详情与缩略图按需加载：Task 1、Task 2、Task 7、Task 9。
- 14 节点仅 2 成功、全部成功单次刷新、部分采用混合状态、中断恢复、千节点性能：Task 3、Task 4、Task 9。
- 四层 IPC、BDD、中文注释、无新依赖、默认 Skill patch 版本：Task 1、Task 6、Task 8、Task 9。
