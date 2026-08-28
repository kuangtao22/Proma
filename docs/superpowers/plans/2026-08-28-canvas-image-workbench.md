# Canvas 生图节点工作台与节点扩展菜单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个 Canvas 生图节点拥有独立、真实可执行的生图工作台，并让节点侧 `+` 选择下游节点类型后自动连线。

**Architecture:** 保留唯一 Pi Agent、Design Job 和 Design Asset 执行链，为 Job 增加 `design-canvas` 与 `canvas-image` 两类目标。新增 Canvas 图片模块 Store/Target Adapter，以 `projectId + canvasId + nodeId + imageModuleId` 隔离配置、任务、版本和事件；Renderer 只在展开节点时加载重状态。节点侧菜单复用顶部类型定义，继续调用现有 Agent/内容创建事务。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Jotai、Radix Popover、Tailwind CSS、Pi Agent Runtime、JSON 原子持久化、BDD `bun:test`

---

## 文件结构

新增：

- `apps/electron/src/main/lib/design/canvas-image-module-store.ts`：图片配置 v2 读取、迁移、CAS 保存和素材采用。
- `apps/electron/src/main/lib/design/canvas-image-job-target.ts`：Canvas Job 目标验证、结果采用和恢复对账。
- `apps/electron/src/main/lib/design/canvas-image-input-resolver.ts`：直接入边已提交快照的有界解析与固化。
- `apps/electron/src/renderer/components/design/CanvasImageWorkbench.tsx`：完整生图工作台纯视图。
- `apps/electron/src/renderer/components/design/use-canvas-image-module.ts`：模块加载、保存、事件、媒体和异步代次。
- 每个新增文件配同目录 `.test.ts` 或 `.test.tsx`。

主要修改：

- `packages/shared/src/types/canvas.ts`、`design.ts`：共享配置、目标、任务和 IPC 类型。
- `canvas-node-content-store.ts`：新图片节点创建 v2 默认配置。
- `design-job-manager.ts`：双目标任务创建、提交、取消、重试和恢复。
- `canvas-document-ipc.ts`、`main/ipc.ts`、`design-preload.ts`、`design-adapter.ts`：IPC 四层。
- `native-canvas-atoms.ts`、`NativeCanvasWorkspace.tsx`：按完整目标隔离 Renderer 状态并挂载工作台。
- `CanvasNodeCard.tsx`、`NativeCanvasGraph.tsx`、`native-canvas-model.ts`：双击/放大详情与节点侧类型 Popover。

## Task 1: 建立共享图片模块与双目标合同

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Modify: `packages/shared/src/types/canvas.test.ts`
- Modify: `packages/shared/src/types/design.ts`
- Modify: `packages/shared/src/types/design.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('Given v2 图片配置 When 严格解析 Then 保留结构化生成选项', () => {
  expect(parseCanvasImageModuleConfig({
    schemaVersion: 2, kind: 'image', contentId: 'module-1', revision: 3,
    createdAt: 10, updatedAt: 20, prompt: '首页主视觉',
    selectedModelProfileId: 'profile-1', aspectRatio: '16:9', imageSize: '2K',
    contextMode: 'project', adoptedAssetId: 'asset-1',
  })).toMatchObject({ aspectRatio: '16:9', imageSize: '2K', contextMode: 'project' })
})

test('Given Canvas Job target When 类型检查 Then 不要求旧画布 position', () => {
  const target: DesignJobTarget = {
    kind: 'canvas-image', canvasId: 'canvas-1', nodeId: 'image-1', imageModuleId: 'module-1',
  }
  expect('position' in target).toBe(false)
})
```

- [ ] **Step 2: 运行 RED**

```bash
bun test packages/shared/src/types/canvas.test.ts packages/shared/src/types/design.test.ts
```

Expected: FAIL，解析器和 `DesignJobTarget` 尚不存在。

- [ ] **Step 3: 实现共享类型**

```ts
export type CanvasImageAspectRatio = '1:1' | '16:9' | '4:3' | '9:16' | '3:4'
export type CanvasImageSize = 'auto' | '1K' | '2K' | '4K'

export interface CanvasImageTarget extends CanvasTarget {
  nodeId: string
  imageModuleId: string
}

export interface CanvasImageModuleConfig {
  schemaVersion: 2
  kind: 'image'
  contentId: string
  revision: number
  createdAt: number
  updatedAt: number
  prompt: string
  selectedModelProfileId: string | null
  aspectRatio: CanvasImageAspectRatio
  imageSize: CanvasImageSize
  contextMode: DesignContextMode
  adoptedAssetId: string | null
}

export type DesignJobTarget =
  | { kind: 'design-canvas'; nodeId: string; position: DesignPoint }
  | { kind: 'canvas-image'; canvasId: string; nodeId: string; imageModuleId: string }

export type CreateDesignJobTarget =
  | { kind: 'design-canvas'; position: DesignPoint }
  | { kind: 'canvas-image'; canvasId: string; nodeId: string; imageModuleId: string }
```

同时增加 `SaveCanvasImageModuleInput`、`CanvasImageJobControlInput`、`DesignGenerationConstraints`、`CanvasImageInputReference`、严格 exact-key 解析器和四个图片公开错误码。`CreateDesignJobInput.target` 使用创建联合，`DesignJobRecord.target` 使用包含最终 nodeId 的持久化联合。提示词上限为 100,000 字符，所有 ID 使用既有稳定 ID 规则。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
bun test packages/shared/src/types/canvas.test.ts packages/shared/src/types/design.test.ts
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts packages/shared/src/types/design.ts packages/shared/src/types/design.test.ts
git commit -m "功能：建立 Canvas 生图模块共享合同"
```

## Task 2: 实现图片配置 v2、迁移和 CAS 保存

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-image-module-store.ts`
- Create: `apps/electron/src/main/lib/design/canvas-image-module-store.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-node-content-store.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-node-content-store.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('Given v1 图片配置 When LOAD Then 原子迁移并补齐默认值', async () => {
  fixture.seedV1({ prompt: '首页', selectedModelProfileId: 'profile-1', adoptedAssetId: null })
  const config = await fixture.store.load(target)
  expect(config).toMatchObject({
    schemaVersion: 2, aspectRatio: '1:1', imageSize: 'auto', contextMode: 'auto',
  })
})

test('Given revision 已变化 When 保存旧草稿 Then 拒绝覆盖', async () => {
  await fixture.store.save({ ...input, expectedConfigRevision: 0 })
  await expect(fixture.store.save({ ...input, expectedConfigRevision: 0 }))
    .rejects.toThrow('CANVAS_IMAGE_REVISION_CONFLICT')
})
```

- [ ] **Step 2: 运行 RED**

```bash
bun test apps/electron/src/main/lib/design/canvas-image-module-store.test.ts apps/electron/src/main/lib/design/canvas-node-content-store.test.ts
```

Expected: FAIL，Store 不存在且空图片仍写 v1。

- [ ] **Step 3: 实现 Store**

```ts
export interface CanvasImageModuleStore {
  load: (target: CanvasImageTarget) => Promise<CanvasImageModuleConfig>
  save: (input: SaveCanvasImageModuleInput) => Promise<CanvasImageModuleConfig>
  adoptAsset: (
    target: CanvasImageTarget,
    expectedConfigRevision: number,
    assetId: string,
  ) => Promise<CanvasImageModuleConfig>
}
```

每次操作通过 `CanvasDocumentStore.loadWithDirectoryCapability()` 验证 `node.id + imageModuleId`，再使用 `runStableDirectoryNative` 相对 `nodes/<imageModuleId>` 读写。v1 只接受旧精确字段；保存先写 `config.json`，最后提交 `meta.json`；未知字段、非法枚举、身份漂移和 revision 冲突 fail closed。

新图片默认值固定为 `1:1 / auto / auto`。内容创建生命周期注入 `resolveDefaultImageModelProfileId(projectId)`，创建 intent 固化当时可用的项目 profile ID；没有可用模型时才写 `null`。失败重放复用 intent 内固化值，不能重新读取后来变化的偏好。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
bun test apps/electron/src/main/lib/design/canvas-image-module-store.test.ts apps/electron/src/main/lib/design/canvas-node-content-store.test.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts
git add apps/electron/src/main/lib/design/canvas-image-module-store.ts apps/electron/src/main/lib/design/canvas-image-module-store.test.ts apps/electron/src/main/lib/design/canvas-node-content-store.ts apps/electron/src/main/lib/design/canvas-node-content-store.test.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts
git commit -m "功能：实现 Canvas 生图配置持久化"
```

## Task 3: 让 Design Job journal 支持双目标

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.test.ts`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.test.tsx`

- [ ] **Step 1: 写失败测试**

```ts
test('Given 旧 journal When 列表加载 Then 规范化为 design-canvas', () => {
  fixture.writeLegacyJob({ nodeId: 'node-1', position: { x: 10, y: 20 } })
  expect(fixture.manager.list('project-1')[0]?.target).toEqual({
    kind: 'design-canvas', nodeId: 'node-1', position: { x: 10, y: 20 },
  })
})

test('Given canvas-image 目标 When 创建 Job Then 不修改旧 Design nodes', () => {
  const before = fixture.document.nodes
  fixture.manager.createCanvasImage(canvasInput)
  expect(fixture.document.nodes).toEqual(before)
})
```

- [ ] **Step 2: 运行 RED**

```bash
bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/renderer/components/design/DesignInspector.test.tsx
```

- [ ] **Step 3: 实现 journal 兼容和创建分支**

`StoredDesignJob` 只写新 `target`。旧记录仅当合法 `nodeId + position` 同时存在且没有 `target` 时迁移；半升级记录拒绝。旧 `create()` 接受 `{ kind: 'design-canvas', position }`，由 Manager 分配 nodeId 后写完整目标并创建占位节点；新 `createCanvasImage()` 接受完整 Canvas 目标，只验证目标、模型和配置 revision 后写 queued journal。旧 Inspector helper 改为提交 Design 创建目标，不保留双写位置字段。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/renderer/components/design/DesignInspector.test.tsx
git add apps/electron/src/main/lib/design/design-job-manager.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/renderer/components/design/DesignInspector.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx
git commit -m "功能：扩展 Design Job 双目标合同"
```

## Task 4: 接通 Canvas Job 输出、重试和恢复

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-image-job-target.ts`
- Create: `apps/electron/src/main/lib/design/canvas-image-job-target.test.ts`
- Create: `apps/electron/src/main/lib/design/canvas-image-input-resolver.ts`
- Create: `apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-recovery.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('Given Canvas Job 成功 When 提交 Then 只新增 Asset 并采用到目标模块', async () => {
  await fixture.completeWithImage(jobA.id)
  expect((await fixture.imageStore.load(targetA)).adoptedAssetId).toBeDefined()
  expect(fixture.designDocument.nodes).toEqual([])
  expect(fixture.designDocument.assets).toHaveLength(1)
})

test('Given A 完成 When B 独立 Then B 配置和任务不变化', async () => {
  const before = await fixture.imageStore.load(targetB)
  await fixture.completeWithImage(jobA.id)
  expect(await fixture.imageStore.load(targetB)).toEqual(before)
})

test('Given 直接入边 Agent 和文档 When 创建 Job Then 固化有界输入快照', async () => {
  const job = await fixture.createCanvasJobWithInputs(targetA)
  expect(job.canvasInputReferences).toEqual([
    expect.objectContaining({ nodeId: 'agent-1', kind: 'agent', revision: 4 }),
    expect.objectContaining({ nodeId: 'document-1', kind: 'document', revision: 2 }),
  ])
})
```

- [ ] **Step 2: 运行 RED**

```bash
bun test apps/electron/src/main/lib/design/canvas-image-job-target.test.ts apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-recovery.test.ts
```

- [ ] **Step 3: 实现目标适配器和提交分支**

```ts
export interface CanvasImageJobTargetAdapter {
  assertTarget: (projectId: string, target: CanvasImageJobTarget) => Promise<void>
  adoptOutput: (projectId: string, target: CanvasImageJobTarget, assetId: string) => Promise<void>
  isOutputAdopted: (projectId: string, target: CanvasImageJobTarget, assetId: string) => Promise<boolean>
}
```

两类 Job 都复用 `assetService.importAuthorizedFiles()`。`design-canvas` 保持 `upsert-assets + upsert-nodes`；`canvas-image` 只 `upsert-assets`，再由 adapter 原子采用并修复 Canvas 节点投影。terminal pending 对账按目标分别检查旧节点或模块采用事实。同一模块拒绝第二个 active/terminal-pending Job，不同模块允许并行。

Canvas retry 沿用原 `creativeTaskId`、提示词、模型、比例、尺寸、上下文和上游快照，不检查旧 Design 节点；重启把 active Job 转为 interrupted，不自动付费运行。比例与尺寸由 Manager 从结构化字段编码，Renderer 不再拼隐藏 prompt。

`canvas-image-input-resolver` 只遍历目标节点的直接入边，并按节点类型读取已提交事实：Agent 使用权威 JSONL 最近明确输出的有界摘要与附件引用；图片使用当前采用 Asset；文档使用已提交 Markdown revision 的有界摘要；原型使用已提交 meta/安全摘要。每项固化 `nodeId + kind + revision + summaryHash` 及可选 `assetId`，总文本和媒体数量设硬上限。`contextMode: none` 只关闭项目代码/创作资料，不删除显式连线输入。解析结果同时进入 Job journal、Agent prompt 和任务详情。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
bun test apps/electron/src/main/lib/design/canvas-image-job-target.test.ts apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-recovery.test.ts
git add apps/electron/src/main/lib/design/canvas-image-job-target.ts apps/electron/src/main/lib/design/canvas-image-job-target.test.ts apps/electron/src/main/lib/design/canvas-image-input-resolver.ts apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts apps/electron/src/main/lib/design/design-job-manager.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-recovery.test.ts
git commit -m "功能：接通 Canvas 生图任务执行与恢复"
```

## Task 5: 完成图片模块主进程 IPC

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('Given 合法图片目标 When LOAD Then 返回配置、任务和媒体 URL', async () => {
  const result = await invoke(CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE, targetA)
  expect(result).toMatchObject({ ok: true, value: { config: { contentId: 'module-a' } } })
})

test('Given A job 配合 B target When CANCEL Then 拒绝且不取消', async () => {
  const result = await invoke(CANVAS_IPC_CHANNELS.CANCEL_IMAGE_JOB, { ...targetB, jobId: jobA.id })
  expect(result).toMatchObject({ ok: false, error: { code: 'CANVAS_IMAGE_JOB_FAILED' } })
})
```

- [ ] **Step 2: 运行 RED**

```bash
bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts
```

- [ ] **Step 3: 注册 handler 和媒体 lease**

增加 `LOAD_IMAGE_MODULE`、`SAVE_IMAGE_MODULE`、`CREATE_IMAGE_JOB`、`CANCEL_IMAGE_JOB`、`RETRY_IMAGE_JOB`、`ADOPT_IMAGE_ASSET`、`RELEASE_IMAGE_MEDIA`、`IMAGE_MODULE_CHANGED`。

LOAD 返回：

```ts
interface CanvasImageModuleSnapshot {
  target: CanvasImageTarget
  config: CanvasImageModuleConfig
  jobs: DesignJobRecord[]
  assets: DesignAsset[]
  assetBaseUrl: string
  thumbnailBaseUrl: string
}
```

所有操作 exact-key 解析并复核 sender、项目、Canvas、节点、模块、revision、job 和 asset 归属。媒体授权按 sender + 完整目标持有，重复 LOAD 事务替换，显式 release 和 sender destroyed 幂等释放。`main/ipc.ts` 构造顺序固定为 module store -> target adapter -> Job Manager -> Canvas IPC。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/design-ipc.test.ts
git add apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/ipc.ts
git commit -m "功能：开放 Canvas 生图模块 IPC"
```

## Task 6: 完成 Preload 与 Renderer adapter

**Files:**
- Modify: `apps/electron/src/preload/design-preload.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('Given preload 图片 API When 调用 Then 转发固定通道', async () => {
  await api.loadCanvasImageModule(targetA)
  expect(ipc.invoke).toHaveBeenCalledWith(CANVAS_IPC_CHANNELS.LOAD_IMAGE_MODULE, targetA)
})

test('Given 主进程图片错误 When adapter 解包 Then 使用中文 fallback', async () => {
  await expect(adapter.loadCanvasImageModule(targetA))
    .rejects.toThrow('生图节点暂时无法加载。')
})
```

- [ ] **Step 2: 运行 RED**

```bash
bun test apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts
```

- [ ] **Step 3: 实现窄桥接**

`DesignPreloadApi` 与 `NativeCanvasAdapter` 同步增加 load/save/create/cancel/retry/adopt/release/onChanged。事件订阅返回幂等取消函数。fallback 固定为“生图节点暂时无法加载”“生图配置保存失败，请重试”“图片任务操作失败，请重试”“配置已在其他窗口更新”。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
bun test apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git add apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "功能：接通 Canvas 生图 Renderer 桥接"
```

## Task 7: 实现 Renderer 模块状态与迟到回调隔离

**Files:**
- Create: `apps/electron/src/renderer/components/design/use-canvas-image-module.ts`
- Create: `apps/electron/src/renderer/components/design/use-canvas-image-module.test.ts`
- Modify: `apps/electron/src/renderer/atoms/native-canvas-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('Given A 与 B 已加载 When A 事件到达 Then 只刷新 A', async () => {
  harness.emit({ ...targetA, cause: 'job' })
  await harness.flush()
  expect(harness.loadCalls).toEqual([targetA, targetB, targetA])
})

test('Given A LOAD 在途 When 切换 B 后 A 返回 Then 不覆盖 B', async () => {
  harness.rerender(targetB)
  pendingA.resolve(snapshotA)
  await harness.flush()
  expect(harness.current.target).toEqual(targetB)
})
```

- [ ] **Step 2: 运行 RED**

```bash
bun test apps/electron/src/renderer/components/design/use-canvas-image-module.test.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts
```

- [ ] **Step 3: 实现状态控制器**

```ts
export function createCanvasImageModuleKey(target: CanvasImageTarget): string {
  return `${target.projectId}:${target.canvasId}:${target.nodeId}:${target.imageModuleId}`
}
```

每个 key 只保存 `snapshot/draft/phase/saveState/error/previewAssetId/taskDetails`。load/save/job/detail 回调捕获 operation generation，写 Jotai 前复核完整 key；目标切换、recovery、删除和卸载均失效旧 generation 并释放媒体。

`commitDraft()` 无 dirty 时立即返回；否则以权威 config revision 保存。成功更新快照，冲突保留本地 draft，迟到结果对新目标零副作用。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
bun test apps/electron/src/renderer/components/design/use-canvas-image-module.test.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts
git add apps/electron/src/renderer/components/design/use-canvas-image-module.ts apps/electron/src/renderer/components/design/use-canvas-image-module.test.ts apps/electron/src/renderer/atoms/native-canvas-atoms.ts apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts
git commit -m "功能：隔离 Canvas 生图节点状态"
```

## Task 8: 构建完整生图工作台

**Files:**
- Create: `apps/electron/src/renderer/components/design/CanvasImageWorkbench.tsx`
- Create: `apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignTaskDetails.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignTaskDetails.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
test('Given 图片模块已加载 When 渲染 Then 显示完整配置和当前版本', () => {
  const html = renderWorkbench(snapshot)
  for (const label of ['提示词', '生图模型', '项目上下文', '画面比例', '图片尺寸']) {
    expect(html).toContain(label)
  }
})

test('Given 运行中任务 When 渲染 Then 主操作为取消', () => {
  const html = renderWorkbench(runningSnapshot)
  expect(html).toContain('取消生成')
  expect(html).not.toContain('>生成图片<')
})
```

- [ ] **Step 2: 运行 RED**

```bash
bun test apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx apps/electron/src/renderer/components/design/DesignTaskDetails.test.tsx
```

- [ ] **Step 3: 实现纯视图**

```ts
export interface CanvasImageWorkbenchProps {
  state: CanvasImageModuleViewState
  writable: boolean
  onDraftChange: (patch: Partial<CanvasImageModuleDraft>) => void
  onGenerate: () => void
  onCancel: (jobId: string) => void
  onRetry: (jobId: string) => void
  onPreviewAsset: (assetId: string) => void
  onAdoptAsset: (assetId: string) => void
  onLoadTaskDetails: (jobId: string, includeTrace: boolean) => void
  onConfigureModels: () => void
}
```

实现预览/配置双区、窄屏纵向滚动、当前图片、历史缩略图、只预览与显式采用、生成/取消/重试。模型和选项复用现有 primitives。抽取 `DesignTaskDetails` 可复用纯视图，让两处共享 final prompt、上下文、Thinking 和日志，但不共享旧 Inspector 状态。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
bun test apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx apps/electron/src/renderer/components/design/DesignTaskDetails.test.tsx
git add apps/electron/src/renderer/components/design/CanvasImageWorkbench.tsx apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx apps/electron/src/renderer/components/design/DesignTaskDetails.tsx apps/electron/src/renderer/components/design/DesignTaskDetails.test.tsx
git commit -m "功能：构建 Canvas 生图节点工作台"
```

## Task 9: 接入 Workspace 草稿与生成流程

**Files:**
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
test('Given 展开 image 节点 When 渲染 Then 不再显示占位文字', () => {
  const html = renderWorkspaceWithExpandedImage()
  expect(html).toContain('生成图片')
  expect(html).not.toContain('生图节点已创建')
})

test('Given dirty 草稿 When 生成 Then 先保存再创建 Job', async () => {
  await harness.generate()
  expect(harness.calls).toEqual(['save-image-config', 'create-image-job'])
})

test('Given 保存失败 When 生成 Then 不创建付费 Job', async () => {
  await failingHarness.generate()
  expect(failingHarness.createJobCalls).toBe(0)
})
```

- [ ] **Step 2: 运行 RED**

```bash
bun test apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx
```

- [ ] **Step 3: 挂载真实工作台**

`renderNodeWorkbench()` 为 image 构造完整 target 并挂载 hook + `CanvasImageWorkbench`。把单个外部 `workbenchDraftCommitter` 改为当前展开工作台动态 committer registry。生成严格 `await commitDraft()`，然后读取最新 config revision 创建 Job；保存失败或 conflict 不启动任务、不关闭工作台。

工作台关闭、切节点、Canvas recovery 和删除继续复用既有 dirty-aware coordinator。图片任务状态不复用 Agent session atom。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
bun test apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx apps/electron/src/renderer/components/design/use-canvas-image-module.test.ts
git add apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.tsx apps/electron/src/renderer/components/design/CanvasNodeWorkbenchOverlay.test.tsx
git commit -m "功能：接通 Canvas 生图工作台流程"
```

## Task 10: 修正详情触发与节点侧类型 Popover

**Files:**
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeCard.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.ts`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('Given 节点主体 When 单击 Then 只选中；双击才打开', () => {
  card.clickBody()
  expect(openCalls).toBe(0)
  card.doubleClickBody()
  expect(openCalls).toBe(1)
})

test('Given 节点加号 When 点击 Then 显示四种可用类型和禁用视频', () => {
  const menu = card.openCreateMenu()
  expect(menu.items).toEqual(['Agent', '生图', '文档', '原型', '视频 · 即将支持'])
})
```

- [ ] **Step 2: 运行 RED**

```bash
bun test apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
```

- [ ] **Step 3: 实现明确回调与 Popover**

```ts
interface CanvasNodeCardData {
  canOpenWorkbench: boolean
  onOpenWorkbench?: (nodeId: string) => void
  canCreateChild: boolean
  onCreateChild?: (sourceNodeId: string, kind: CanvasNodeKind) => void
}
```

单击只交给 XYFlow 选区；主体双击和右上角放大调用 `onOpenWorkbench`。节点侧 `+` 改用 Radix `Popover`，复用 `NATIVE_CANVAS_NODE_TYPE_OPTIONS`，选择后关闭并调用 `onCreateChild`。按钮、Popover 和菜单项阻止 pointer/click/doubleClick 穿透。

Graph 删除混合命名 `canExpand/onExpand`，改为 `canCreateChild/onCreateChild/onWorkbenchNodeChange`。创建成功只选中新节点，不展开；原有 relationship 事务继续原子创建边。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
bun test apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx
git add apps/electron/src/renderer/components/design/CanvasNodeCard.tsx apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx apps/electron/src/renderer/components/design/native-canvas-model.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts
git commit -m "优化：完善 Canvas 节点详情与扩展菜单"
```

## Task 11: 收口删除与媒体生命周期

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: 写失败测试**

```ts
test('Given 图片节点有运行任务 When 删除 Then 先取消再进入回收事务', async () => {
  await fixture.deleteImageNode(targetA)
  expect(fixture.calls).toEqual(['cancel-job', 'move-to-trash', 'remove-node'])
})

test('Given 取消失败 When 删除 Then 保留节点和任务', async () => {
  fixture.cancelRejects = true
  await expect(fixture.deleteImageNode(targetA)).rejects.toThrow()
  expect(fixture.hasNode(targetA.nodeId)).toBe(true)
})
```

- [ ] **Step 2: 运行 RED**

```bash
bun test apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
```

- [ ] **Step 3: 实现权威取消和幂等释放**

image 删除前调用注入的 `cancelActiveImageJob(target)`；只有确认无 active Job 后才写删除 intent。回收恢复保留原 `imageModuleId`。媒体 lease 在显式 release、目标切换、recovery、删除、卸载和 sender destroyed 路径幂等回收；StrictMode 重挂用 mount generation 区分旧 cleanup 与新所有者。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
bun test apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
git add apps/electron/src/main/lib/design/canvas-content-node-lifecycle.ts apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx
git commit -m "修复：收口 Canvas 生图删除与媒体生命周期"
```

## Task 12: 全链验证、真实客户端测试与记忆更新

**Files:**
- Modify: `MEMORY.md`
- Modify when verification exposes a defect: only the relevant implementation and test files above

- [ ] **Step 1: 运行定向测试**

```bash
bun test \
  packages/shared/src/types/canvas.test.ts \
  packages/shared/src/types/design.test.ts \
  apps/electron/src/main/lib/design/canvas-node-content-store.test.ts \
  apps/electron/src/main/lib/design/canvas-image-module-store.test.ts \
  apps/electron/src/main/lib/design/canvas-image-job-target.test.ts \
  apps/electron/src/main/lib/design/canvas-image-input-resolver.test.ts \
  apps/electron/src/main/lib/design/design-job-manager.test.ts \
  apps/electron/src/main/lib/design/design-recovery.test.ts \
  apps/electron/src/main/lib/design/canvas-document-ipc.test.ts \
  apps/electron/src/main/lib/design/canvas-content-node-lifecycle.test.ts \
  apps/electron/src/preload/design-preload.test.ts \
  apps/electron/src/renderer/lib/design-adapter.test.ts \
  apps/electron/src/renderer/atoms/native-canvas-atoms.test.ts \
  apps/electron/src/renderer/components/design/use-canvas-image-module.test.ts \
  apps/electron/src/renderer/components/design/CanvasImageWorkbench.test.tsx \
  apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx \
  apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx \
  apps/electron/src/renderer/components/design/native-canvas-model.test.ts \
  apps/electron/src/renderer/components/design/native-canvas-performance.test.tsx \
  apps/electron/src/renderer/components/design/DesignInspector.test.tsx \
  apps/electron/src/renderer/components/design/DesignTaskDetails.test.tsx
```

Expected: PASS；失败先修复并重跑，不跳过。

- [ ] **Step 2: 类型检查与 Electron 构建**

```bash
bun run typecheck
bun run electron:build
```

Expected: 两者 PASS，无 `any`、IPC 漂移或构建 external 问题。

- [ ] **Step 3: 启动并真实控制客户端**

```bash
bun run dev
```

用鼠标依次验证：

1. 两个图片节点配置不同提示词、模型、比例、尺寸和上下文，关闭重开不串值；
2. 单击只选中，双击和放大打开工作台；
3. 节点侧 `+` 创建 Agent、生图、文档和原型并自动连线，视频禁用；
4. 一个节点有上游、一个无上游，任务详情中的上下文引用不同；
5. 生成、取消、失败后重试、当前图片、历史预览和显式采用；
6. final prompt、Thinking 和日志可按需查看；
7. 旧 Design 画布没有 Canvas job 或输出布局节点；
8. 切 Canvas、重载和重启后状态正确；
9. 深浅主题和窄窗口无闪烁、重叠或文字溢出。

若模型或凭据不可用，记录真实清洗错误并验证配置、详情和重试入口，不能声称真实生图成功。

- [ ] **Step 4: 更新 MEMORY 并提交**

按真实结果追加一条稳定决策；若真实付费链未成功，明确记录该验证缺口。然后：

```bash
git diff --check
git status --short
git diff --stat
git add MEMORY.md
git commit -m "测试：完成 Canvas 生图工作台全链验收"
```

若验收修复代码，只添加对应实现和测试文件；不要添加用户原有 `.superpowers/`。

## 最终停止条件

- Tasks 1-12 全部完成；
- 定向测试、`bun run typecheck`、`bun run electron:build` 通过；
- 真实客户端完成节点交互和至少一次真实生图尝试；
- 多图片节点没有配置、任务、取消、重试、结果或事件串联；
- 旧 Design 没有新增 Canvas 布局节点；
- `MEMORY.md` 按真实验证结果更新；
- 工作区只剩用户原有且未纳入任务的变更。
