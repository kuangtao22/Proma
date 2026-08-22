# Project Design Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Proma 中交付一个以项目为归属、可从顶部切换的原生设计工作区，完成图片导入、无限画布编排、批注、版本关系、Pi 图片任务、会话传递和原图导出闭环。

**Architecture:** Renderer 使用 React、Jotai 和 XYFlow，设计入口通过独立的 `activeView='design'` 表达，不伪造会话 Tab。主进程以工作区 ID 解析 `<project>/.proma/design/` 与 `~/.proma/design-cache/<project-id>/`，通过受迁移守卫保护的 revision mutation、原子 JSON、受管素材和可见 Pi Agent 会话提供能力；所有调用遵循 shared -> main IPC -> preload -> renderer adapter 四层契约。

**Tech Stack:** Bun、TypeScript、Electron 43、React 18、Jotai、`@xyflow/react@12.11.3`、Radix/shadcn、Sharp、Pi Agent runtime、Bun Test。

---

## 实施原则与文件结构

- 新依赖只增加 `@xyflow/react@12.11.3`。选择它是因为 viewport、框选、多选、拖动和 `onlyRenderVisibleElements` 已有稳定实现；对用户的影响是大画布交互更稳定，但 Renderer 包体会增加约 1.2 MB（安装包压缩后更小）。
- 正式素材和 `canvas.json` 随项目迁移；缩略图、任务记录和 staging 可重建，不进入项目迁移。
- Renderer 永远不提交设计数据根；只提交 `projectId`、稳定实体 ID、受控 mutation 和由主进程选择器产生的导入动作。
- 原图不进入 Jotai；节点只保存元数据和缩略图 URL。主进程按项目注册目录级 `proma-file://` 授权，切项目时释放授权，避免每个节点生成 Blob/Object URL。
- 所有 Design 写入由 `workspaceOperationGuard.runWorkspaceWrite(projectId, effect)` 包裹。项目离线或迁移中时，读取返回只读状态，新增任务和保存明确失败。
- 实现采用 clean-room 方式复现已批准的交互和数据概念，不复制 codex-canvas 源文件；若执行中确需复制其 MIT 代码，必须在同一任务新增对应版权头和第三方许可文件后再提交。XYFlow 的 MIT 许可由锁定依赖和发布依赖清单保留。
- 以下文件是最终责任边界：

```text
packages/shared/src/types/design.ts
  Design document、asset、annotation、job、mutation、IPC 请求响应与通道常量。

apps/electron/src/main/lib/design/design-paths.ts
  projectId 到正式目录/缓存目录的可信解析与路径包含校验。
apps/electron/src/main/lib/design/design-store.ts
  schema 校验、备份恢复、revision mutation、冲突与原子保存。
apps/electron/src/main/lib/design/design-asset-service.ts
  选择导入、签名/尺寸校验、SHA-256、Sharp 缩略图、删除、导出和媒体 URL。
apps/electron/src/main/lib/design/design-job-manager.ts
  可见 Pi 会话、job journal、生成/编辑、取消、重试、输出收集与重启恢复。
apps/electron/src/main/lib/design/design-ipc.ts
  renderer 身份门、四层 IPC handler、事件广播和 workspace guard。

apps/electron/src/preload/design-preload.ts
  最小类型安全 Design bridge。

apps/electron/src/renderer/atoms/design-atoms.ts
  按 projectId 隔离的加载、画布、历史、选区、工具、表单和保存状态。
apps/electron/src/renderer/lib/design-adapter.ts
  Renderer 唯一 Design IPC 入口。
apps/electron/src/renderer/lib/design-editor.ts
  可测试的画布编辑 reducer、逆操作、分组、批注和发送会话流程。
apps/electron/src/renderer/components/design/DesignWorkspaceView.tsx
  项目级加载/订阅/保存容器及空、离线、错误状态。
apps/electron/src/renderer/components/design/DesignCanvas.tsx
  XYFlow viewport、selection、快捷键和可视节点渲染。
apps/electron/src/renderer/components/design/DesignAssetNode.tsx
  图片、任务占位和缺失素材节点。
apps/electron/src/renderer/components/design/DesignAnnotationLayer.tsx
  箭头与画笔蒙版交互层。
apps/electron/src/renderer/components/design/DesignToolbar.tsx
  选择、平移、批注、撤销、重做、分组和导入。
apps/electron/src/renderer/components/design/DesignInspector.tsx
  素材、AI 编辑、版本三个标签及任务状态。
apps/electron/src/renderer/components/design/DesignProjectTab.tsx
  顶部 `设计 · 项目名` 项目级入口。
```

### Task 1: 建立共享 Design 契约并锁定 XYFlow 版本

**Files:**
- Create: `packages/shared/src/types/design.ts`
- Create: `packages/shared/src/types/design.test.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/electron/package.json`
- Modify: `bun.lock`

- [ ] **Step 1: 写失败的共享契约测试**

```ts
import { describe, expect, test } from 'bun:test'
import {
  DESIGN_DOCUMENT_VERSION,
  DESIGN_IPC_CHANNELS,
  createEmptyDesignDocument,
} from './design'

describe('Design 共享契约', () => {
  test('Given 一个项目 When 创建空画布 Then 使用稳定项目 ID、版本和初始视口', () => {
    const document = createEmptyDesignDocument('project-1', 100)
    expect(document).toEqual({
      schemaVersion: DESIGN_DOCUMENT_VERSION,
      projectId: 'project-1',
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      assets: [],
      groups: [],
      annotations: [],
      createdAt: 100,
      updatedAt: 100,
    })
  })

  test('Given Design IPC When 枚举通道 Then 不复用 Agent 或文件预览通道', () => {
    expect(new Set(Object.values(DESIGN_IPC_CHANNELS)).size).toBe(Object.keys(DESIGN_IPC_CHANNELS).length)
    expect(DESIGN_IPC_CHANNELS.LOAD).toBe('design:load')
    expect(DESIGN_IPC_CHANNELS.CHANGED).toBe('design:changed')
  })
})
```

- [ ] **Step 2: 运行测试并确认因模块缺失失败**

Run: `bun test packages/shared/src/types/design.test.ts`

Expected: FAIL，包含 `Cannot find module './design'`。

- [ ] **Step 3: 写最小共享类型与运行时常量**

`packages/shared/src/types/design.ts` 必须完整定义以下公开契约；字段名在后续任务中不得改写：

```ts
export const DESIGN_DOCUMENT_VERSION = 1

export interface DesignPoint { x: number; y: number }
export interface DesignViewport extends DesignPoint { zoom: number }
export type DesignNodeKind = 'asset' | 'job'
export type DesignJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type DesignJobAction = 'generate' | 'edit'

export interface DesignCanvasNode {
  id: string
  kind: DesignNodeKind
  position: DesignPoint
  width: number
  height: number
  zIndex: number
  assetId?: string
  jobId?: string
  groupId?: string
}

export interface DesignAsset {
  id: string
  filename: string
  relativePath: string
  thumbnailRelativePath: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  width: number
  height: number
  byteSize: number
  sha256: string
  createdAt: number
  sourceSessionId?: string
  sourceJobId?: string
  prompt?: string
  parentAssetId?: string
}

export interface DesignGroup { id: string; name: string; nodeIds: string[] }

export type DesignAnnotation =
  | { id: string; kind: 'arrow'; from: DesignPoint; to: DesignPoint; color: string; width: number; createdAt: number }
  | { id: string; kind: 'mask'; points: DesignPoint[]; color: string; width: number; createdAt: number }

export interface DesignCanvasDocument {
  schemaVersion: typeof DESIGN_DOCUMENT_VERSION
  projectId: string
  revision: number
  viewport: DesignViewport
  nodes: DesignCanvasNode[]
  assets: DesignAsset[]
  groups: DesignGroup[]
  annotations: DesignAnnotation[]
  createdAt: number
  updatedAt: number
}

export type DesignMutation =
  | { type: 'set-viewport'; viewport: DesignViewport }
  | { type: 'move-nodes'; positions: Array<{ nodeId: string; position: DesignPoint }> }
  | { type: 'upsert-nodes'; nodes: DesignCanvasNode[] }
  | { type: 'remove-nodes'; nodeIds: string[] }
  | { type: 'upsert-assets'; assets: DesignAsset[] }
  | { type: 'remove-assets'; assetIds: string[] }
  | { type: 'upsert-groups'; groups: DesignGroup[] }
  | { type: 'remove-groups'; groupIds: string[] }
  | { type: 'upsert-annotations'; annotations: DesignAnnotation[] }
  | { type: 'remove-annotations'; annotationIds: string[] }

export interface DesignJobRecord {
  id: string
  projectId: string
  sessionId?: string
  action: DesignJobAction
  status: DesignJobStatus
  prompt: string
  sourceSessionId?: string
  sourceAssetId?: string
  parentAssetId?: string
  outputAssetId?: string
  error?: string
  createdAt: number
  updatedAt: number
}

export interface DesignWorkspaceSnapshot {
  document: DesignCanvasDocument
  writable: boolean
  readOnlyReason?: string
  assetBaseUrl?: string
  thumbnailBaseUrl?: string
  recoveredFrom?: 'tmp' | 'backup'
}

export interface SaveDesignMutationsInput { projectId: string; expectedRevision: number; mutations: DesignMutation[] }
export interface ImportDesignAssetsInput { projectId: string }
export interface DeleteDesignAssetInput { projectId: string; assetId: string; expectedRevision: number }
export interface ExportDesignAssetInput { projectId: string; assetId: string }
export interface RelinkDesignAssetInput { projectId: string; assetId: string; expectedRevision: number }
export interface CreateDesignJobInput {
  projectId: string
  action: DesignJobAction
  prompt: string
  sourceSessionId?: string
  sourceAssetId?: string
  maskAnnotationId?: string
  position: DesignPoint
}
export interface DesignJobControlInput { projectId: string; jobId: string }
export interface PrepareDesignAssetForSessionInput { projectId: string; assetId: string; sessionId: string }
export interface PreparedDesignAssetMention { sessionId: string; path: string; name: string; isDirectory: false; scope: 'project' }
export interface ImportAgentImageInput { projectId: string; sessionId: string; localPath: string; position: DesignPoint }
export type DesignChangeEvent = { projectId: string; revision: number; cause: 'canvas' | 'asset' | 'job' | 'recovery' }

export const DESIGN_IPC_CHANNELS = {
  LOAD: 'design:load',
  SAVE_MUTATIONS: 'design:save-mutations',
  IMPORT_ASSETS: 'design:import-assets',
  DELETE_ASSET: 'design:delete-asset',
  EXPORT_ASSET: 'design:export-asset',
  RELINK_ASSET: 'design:relink-asset',
  CREATE_JOB: 'design:create-job',
  CANCEL_JOB: 'design:cancel-job',
  RETRY_JOB: 'design:retry-job',
  LIST_JOBS: 'design:list-jobs',
  PREPARE_ASSET_FOR_SESSION: 'design:prepare-asset-for-session',
  IMPORT_AGENT_IMAGE: 'design:import-agent-image',
  RELEASE_MEDIA_ACCESS: 'design:release-media-access',
  CHANGED: 'design:changed',
} as const

export function createEmptyDesignDocument(projectId: string, now = Date.now()): DesignCanvasDocument {
  return {
    schemaVersion: DESIGN_DOCUMENT_VERSION,
    projectId,
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [], assets: [], groups: [], annotations: [],
    createdAt: now, updatedAt: now,
  }
}
```

在 `packages/shared/src/types/index.ts` 末尾增加：

```ts
export * from './design'
```

- [ ] **Step 4: 安装锁定版本并记录依赖变更**

Run: `cd apps/electron && bun add -d @xyflow/react@12.11.3`

Expected: `apps/electron/package.json` 的 `devDependencies` 出现精确版本 `@xyflow/react: "12.11.3"`，`bun.lock` 更新；不得出现 npm/pnpm lockfile。

- [ ] **Step 5: 运行共享测试和类型检查**

Run: `bun test packages/shared/src/types/design.test.ts && bun run typecheck`

Expected: PASS，两个 Design 契约场景通过，TypeScript 无错误。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/types/design.ts packages/shared/src/types/design.test.ts packages/shared/src/types/index.ts apps/electron/package.json bun.lock
git commit -m "功能：建立设计工作区共享契约与画布依赖"
```

### Task 2: 实现可信目录解析、schema 校验与 revision 原子存储

**Files:**
- Create: `apps/electron/src/main/lib/design/design-paths.ts`
- Create: `apps/electron/src/main/lib/design/design-paths.test.ts`
- Create: `apps/electron/src/main/lib/design/design-store.ts`
- Create: `apps/electron/src/main/lib/design/design-store.test.ts`

- [ ] **Step 1: 写路径、安全恢复和冲突的失败测试**

`design-paths.test.ts` 覆盖外部项目、托管项目、未知项目和缓存稳定映射：

```ts
import { describe, expect, test } from 'bun:test'
import { createDesignPathResolver } from './design-paths'

describe('Design 路径解析', () => {
  test('Given 外部项目 When 解析 Then 正式数据随项目且缓存按稳定 ID 隔离', () => {
    const resolver = createDesignPathResolver({
      getWorkspace: () => ({ id: 'project-1', name: '项目', slug: 'stable-slug', createdAt: 1, updatedAt: 1 }),
      getProjectFilesPath: () => '/projects/demo',
      getConfigDir: () => '/home/test/.proma',
    })
    expect(resolver.resolve('project-1')).toEqual({
      projectId: 'project-1', projectRoot: '/projects/demo',
      designRoot: '/projects/demo/.proma/design',
      canvasPath: '/projects/demo/.proma/design/canvas.json',
      assetsDir: '/projects/demo/.proma/design/assets',
      annotationsDir: '/projects/demo/.proma/design/annotations',
      cacheRoot: '/home/test/.proma/design-cache/project-1',
      thumbnailsDir: '/home/test/.proma/design-cache/project-1/thumbnails',
      jobsDir: '/home/test/.proma/design-cache/project-1/jobs',
      stagingDir: '/home/test/.proma/design-cache/project-1/staging',
    })
  })

  test('Given 未知项目 When 解析 Then 明确拒绝', () => {
    const resolver = createDesignPathResolver({ getWorkspace: () => undefined, getProjectFilesPath: () => '', getConfigDir: () => '' })
    expect(() => resolver.resolve('forged')).toThrow('项目不存在: forged')
  })
})
```

`design-store.test.ts` 使用 `mkdtemp` 和真实 `safe-file`，覆盖空文档、损坏主文件从 `.bak` 恢复、旧 revision 的位置合并和结构冲突：

```ts
test('Given stale revision When 只移动节点 Then 在最新 revision 上重放', () => {
  const first = store.mutate('project-1', 0, [{ type: 'upsert-nodes', nodes: [node] }])
  const merged = store.mutate('project-1', 0, [{ type: 'move-nodes', positions: [{ nodeId: node.id, position: { x: 40, y: 50 } }] }])
  expect(first.revision).toBe(1)
  expect(merged.revision).toBe(2)
  expect(merged.nodes[0]?.position).toEqual({ x: 40, y: 50 })
})

test('Given stale revision When 删除节点 Then 拒绝覆盖新结构', () => {
  store.mutate('project-1', 0, [{ type: 'upsert-nodes', nodes: [node] }])
  expect(() => store.mutate('project-1', 0, [{ type: 'remove-nodes', nodeIds: [node.id] }]))
    .toThrow('DESIGN_REVISION_CONFLICT')
})
```

- [ ] **Step 2: 运行测试并确认导入失败**

Run: `bun test apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/design-store.test.ts`

Expected: FAIL，包含 `Cannot find module './design-paths'` 或 `Cannot find module './design-store'`。

- [ ] **Step 3: 实现路径解析和文档 validator**

`design-paths.ts` 导出 `DesignPathResolver`、`DesignPaths`、`createDesignPathResolver` 和 production `designPathResolver`。production 依赖固定为 `getAgentWorkspace`、`getProjectFilesPath`、`getConfigDir`；`projectId` 仅作 Map/key，不拼入正式项目根。缓存 key 必须先通过 `/^[A-Za-z0-9_-]+$/`，否则抛出 `项目 ID 非法`。

`design-store.ts` 使用下面的冲突规则：

```ts
const REBASEABLE_MUTATIONS = new Set<DesignMutation['type']>(['set-viewport', 'move-nodes'])

function assertCanApply(expectedRevision: number, currentRevision: number, mutations: DesignMutation[]): void {
  if (expectedRevision === currentRevision) return
  if (mutations.every((mutation) => REBASEABLE_MUTATIONS.has(mutation.type))) return
  throw new Error(`DESIGN_REVISION_CONFLICT: expected=${expectedRevision}, current=${currentRevision}`)
}
```

validator 必须检查：对象结构、`schemaVersion === 1`、projectId 相等、revision/时间/坐标为有限数、zoom 在 `0.05..8`、实体 ID 非空且唯一、asset/node/group 引用存在、asset 路径是相对路径且不含 `..`、节点尺寸为正数、mask 至少两个点。失败返回 false，让 `readJsonFileSafe` 尝试 `.tmp/.bak`。

mutation 应通过统一纯函数应用，禁止调用方直接改数组：

```ts
export function applyDesignMutations(document: DesignCanvasDocument, mutations: DesignMutation[]): DesignCanvasDocument {
  let next = structuredClone(document)
  for (const mutation of mutations) {
    switch (mutation.type) {
      case 'set-viewport': next.viewport = mutation.viewport; break
      case 'move-nodes': {
        const positions = new Map(mutation.positions.map((item) => [item.nodeId, item.position]))
        next.nodes = next.nodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node)
        break
      }
      case 'upsert-nodes': next.nodes = upsertById(next.nodes, mutation.nodes); break
      case 'remove-nodes': next.nodes = next.nodes.filter((node) => !mutation.nodeIds.includes(node.id)); break
      case 'upsert-assets': next.assets = upsertById(next.assets, mutation.assets); break
      case 'remove-assets': next.assets = next.assets.filter((asset) => !mutation.assetIds.includes(asset.id)); break
      case 'upsert-groups': next.groups = upsertById(next.groups, mutation.groups); break
      case 'remove-groups': next.groups = next.groups.filter((group) => !mutation.groupIds.includes(group.id)); break
      case 'upsert-annotations': next.annotations = upsertById(next.annotations, mutation.annotations); break
      case 'remove-annotations': next.annotations = next.annotations.filter((item) => !mutation.annotationIds.includes(item.id)); break
    }
  }
  return next
}
```

同文件在该函数前定义稳定 upsert helper，避免各实体分支各写一套合并逻辑：

```ts
function upsertById<T extends { id: string }>(current: T[], updates: T[]): T[] {
  const next = new Map(current.map((item) => [item.id, item]))
  for (const update of updates) next.set(update.id, update)
  return [...next.values()]
}
```

`DesignStore.load(projectId)` 创建所需目录后读取；没有文件时只返回内存空文档，不因“查看空画布”写项目。`mutate` 校验 mutation 结果，将 revision 加 1、更新 `updatedAt`，再调用 `writeJsonFileAtomic(canvasPath, next)`。若从 `.tmp/.bak` 恢复，snapshot 的 `recoveredFrom` 必须非空并由上层提示用户。

- [ ] **Step 4: 运行测试并确认通过**

Run: `bun test apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/design-store.test.ts`

Expected: PASS，路径、恢复、mergeable stale write 和结构冲突全部通过。

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/main/lib/design/design-paths.ts apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/design-store.ts apps/electron/src/main/lib/design/design-store.test.ts
git commit -m "功能：实现设计画布可信路径与原子版本存储"
```

### Task 3: 实现安全素材导入、缩略图、媒体授权、删除与导出

**Files:**
- Create: `apps/electron/src/main/lib/design/design-asset-service.ts`
- Create: `apps/electron/src/main/lib/design/design-asset-service.test.ts`
- Modify: `apps/electron/src/main/lib/local-file-protocol.ts`
- Create: `apps/electron/src/main/lib/local-file-protocol.test.ts`

- [ ] **Step 1: 写失败的素材与授权测试**

测试以 1x1 PNG fixture Buffer、伪造 JPEG 扩展文本、65 MiB 文件和符号链接越界为输入，至少包含：

```ts
test('Given 有效 PNG When 导入 Then 生成校验值、正式素材和 WebP 缩略图', async () => {
  const result = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
  expect(result).toHaveLength(1)
  expect(result[0]?.mediaType).toBe('image/png')
  expect(result[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(existsSync(join(paths.assetsDir, result[0]!.relativePath.replace('assets/', '')))).toBe(true)
  expect(existsSync(join(paths.thumbnailsDir, basename(result[0]!.thumbnailRelativePath)))).toBe(true)
})

test('Given 扩展名伪装的文本 When 导入 Then 按签名拒绝且正式目录无半成品', async () => {
  await expect(service.importAuthorizedFiles('project-1', [fakePngPath], { kind: 'picker' }))
    .rejects.toThrow('不支持或损坏的图片')
  expect(readdirSync(paths.assetsDir)).toEqual([])
})

test('Given 素材仍被节点引用 When 删除 Then 拒绝删除原图', () => {
  expect(() => service.deleteAsset('project-1', 'asset-1', 1)).toThrow('素材仍被画布节点引用')
})
```

为 `local-file-protocol.ts` 增加测试：注册目录 URL 后可以释放，释放后 `handlePromaFileRequest` 返回 404；目录内文件返回 200，`../` 与 symlink escape 返回 403/404。

- [ ] **Step 2: 运行并确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-asset-service.test.ts apps/electron/src/main/lib/local-file-protocol.test.ts`

Expected: FAIL，素材服务模块缺失且 `revokePromaPathUrl` 未导出。

- [ ] **Step 3: 实现素材 staging 协议**

`DesignAssetService` 的固定限制：单文件 64 MiB、解析后最多 64,000,000 pixels、支持 PNG/JPEG/GIF/WebP。流程必须是：读取到 Buffer -> `isValidImageBytes` -> `sharp(buffer, { limitInputPixels: 64_000_000 }).metadata()` -> SHA-256 -> staging 临时文件 -> 512x512 `fit: 'inside'` WebP 缩略图 -> 原子 rename 到正式素材 -> 返回 `DesignAsset`。文件名使用 `${randomUUID()}${canonicalExtension}`，不复用用户文件名作磁盘路径。

公开 API 固定为：

```ts
export interface DesignAssetImportSource {
  kind: 'picker' | 'agent' | 'job'
  sourceSessionId?: string
  sourceJobId?: string
  parentAssetId?: string
  prompt?: string
}

export class DesignAssetService {
  constructor(private readonly dependencies: DesignAssetServiceDependencies) {}
  importAuthorizedFiles(projectId: string, sourcePaths: string[], source: DesignAssetImportSource): Promise<DesignAsset[]>
  deleteAsset(projectId: string, assetId: string, expectedRevision: number): DesignCanvasDocument
  relinkAsset(projectId: string, assetId: string, sourcePath: string, expectedRevision: number): Promise<DesignCanvasDocument>
  exportAsset(projectId: string, assetId: string, targetPath: string): Promise<void>
  createMediaAccess(projectId: string): { assetBaseUrl: string; thumbnailBaseUrl: string; release: () => void }
  resolveAssetPath(projectId: string, assetId: string): string
}
```

导入多个文件按文件逐一验证，但只在全部 staging 成功后移入正式目录；任何失败清理该批次 staging。删除先检查节点引用，再以 `remove-assets` mutation 提交元数据，最后用 `removeFileAtomic` 删除原图与缩略图；删除文件失败记录 warning，但不能恢复已提交的画布引用。重新定位由主进程重新打开单文件选择器，按同样签名/像素上限验证后保留原 asset ID、来源和版本关系，只替换文件、缩略图、尺寸、byteSize、sha256；失败时旧元数据和缺失节点不变。导出只接收主进程 save dialog 返回的目标，不接受 Renderer 任意目标路径。

- [ ] **Step 4: 给本地文件协议增加显式释放**

```ts
export function revokePromaPathUrl(url: string): void {
  let parsed: URL
  try { parsed = new URL(url) } catch { return }
  if (parsed.protocol !== 'proma-file:') return
  registeredEntries.delete(parsed.hostname)
}
```

`createMediaAccess` 只注册 `assetsDir` 和 `thumbnailsDir` 两个目录 URL，并在 release 中调用两次 `revokePromaPathUrl`。这样 1,000 个节点仍只占两个授权 entry，对用户的影响是切项目后旧页面 URL 立即失效，不泄露原始绝对路径。

- [ ] **Step 5: 运行素材测试**

Run: `bun test apps/electron/src/main/lib/design/design-asset-service.test.ts apps/electron/src/main/lib/local-file-protocol.test.ts`

Expected: PASS，有效图片生成缩略图，伪装/超限/越界文件被拒绝，媒体授权可释放。

- [ ] **Step 6: 提交**

```bash
git add apps/electron/src/main/lib/design/design-asset-service.ts apps/electron/src/main/lib/design/design-asset-service.test.ts apps/electron/src/main/lib/local-file-protocol.ts apps/electron/src/main/lib/local-file-protocol.test.ts
git commit -m "功能：增加设计素材安全导入与缩略图管理"
```

### Task 4: 接通 Design IPC、Preload 与 Renderer adapter

**Files:**
- Create: `apps/electron/src/main/lib/design/design-ipc.ts`
- Create: `apps/electron/src/main/lib/design/design-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Create: `apps/electron/src/preload/design-preload.ts`
- Create: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Create: `apps/electron/src/renderer/lib/design-adapter.ts`
- Create: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写四层契约失败测试**

主进程测试用记录型 IPC，要求：仅授权窗口可调用；SAVE/IMPORT/DELETE/RELINK 进入 workspace guard；LOAD 在离线项目返回只读 snapshot；handler 不接受 Renderer 路径参数。两个授权窗口同时加载同一项目时都收到 revision change；未授权辅助窗口被拒绝。Job 与会话桥 handler 分别在 Task 10、11 增量注册，确保本任务不引用尚未存在的服务。

Preload 测试仿照 `lan-bridge-preload.test.ts`，逐项断言 channel 和参数，并验证 CHANGED 订阅取消使用相同 listener。Renderer adapter 测试用注入 API，断言错误统一保留中文 message：

```ts
test('Given preload 拒绝保存 When adapter 调用 Then 保留稳定错误供 UI 展示', async () => {
  const adapter = createDesignAdapter({
    loadDesignWorkspace: async () => { throw new Error('项目离线，只能查看缓存') },
  } as PartialDesignApi)
  await expect(adapter.load('project-1')).rejects.toThrow('项目离线，只能查看缓存')
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: FAIL，三个新模块均不存在。

- [ ] **Step 3: 实现独立 IPC 注册模块**

`registerDesignIpcHandlers` 使用可注入依赖，返回实际注册通道列表：

```ts
export interface DesignIpcOptions {
  ipc: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, input?: unknown) => unknown) => void; removeHandler: (channel: string) => void }
  listAuthorizedWebContents: () => WebContents[]
  guard: WorkspaceOperationGuard
  store: DesignStore
  assets: DesignAssetService
  pickImageFiles: (sender: WebContents) => Promise<string[]>
  pickExportPath: (sender: WebContents, filename: string) => Promise<string | null>
  sendChanged: (event: DesignChangeEvent) => void
}
```

每个 handler 第一行调用 `assertAuthorizedSender(event, options.listAuthorizedWebContents())`。本任务注册 LOAD、SAVE_MUTATIONS、IMPORT_ASSETS、DELETE_ASSET、RELINK_ASSET、EXPORT_ASSET、RELEASE_MEDIA_ACCESS；其中 SAVE_MUTATIONS、IMPORT_ASSETS、DELETE_ASSET、RELINK_ASSET 都在 `guard.runWorkspaceWrite(input.projectId, () => ...)` 内。RELEASE_MEDIA_ACCESS 只释放该 sender 已注册的 URL，不接收 URL 字符串。变更广播遍历授权 webContents，发送给包括发起者在内的所有窗口。

在 `apps/electron/src/main/ipc.ts` 的 `registerIpcHandlers` 中，创建 production store/assets 后调用：

```ts
registerDesignIpcHandlers({
  ipc: ipcMain,
  listAuthorizedWebContents: () => {
    const main = getStoredMainWindow()?.webContents
    return main ? [main] : []
  },
  guard: workspaceOperationGuard,
  store: designStore,
  assets: designAssetService,
  pickImageFiles: pickDesignImageFiles,
  pickExportPath: pickDesignExportPath,
  sendChanged: (change) => {
    const main = getStoredMainWindow()?.webContents
    if (main && !main.isDestroyed()) main.send(DESIGN_IPC_CHANNELS.CHANGED, change)
  },
})
```

- [ ] **Step 4: 实现 Preload 和 adapter**

`design-preload.ts` 导出 `DesignPreloadApi` 与 `createDesignPreloadApi(ipc)`，API 名称固定为：`loadDesignWorkspace`、`saveDesignMutations`、`importDesignAssets`、`deleteDesignAsset`、`relinkDesignAsset`、`exportDesignAsset`、`createDesignJob`、`cancelDesignJob`、`retryDesignJob`、`listDesignJobs`、`prepareDesignAssetForSession`、`importAgentImageToDesign`、`releaseDesignMediaAccess`、`onDesignChanged`。

`ElectronAPI` 继承 `DesignPreloadApi`；`electronAPI` 对象展开 `...createDesignPreloadApi(ipcRenderer)`。Renderer 的 `designAdapter` 只转发这些方法，组件不得直接访问 `window.electronAPI`。

- [ ] **Step 5: 运行四层测试**

Run: `bun test apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: PASS，窗口身份、guard、通道参数、订阅取消和错误传播全部通过。

- [ ] **Step 6: 提交**

```bash
git add apps/electron/src/main/lib/design/design-ipc.ts apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/preload/index.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "功能：接通设计工作区四层 IPC 契约"
```

### Task 5: 增加顶部项目级 Design Tab 与布局切换

**Files:**
- Modify: `apps/electron/src/renderer/atoms/active-view.ts`
- Create: `apps/electron/src/renderer/components/design/DesignProjectTab.tsx`
- Create: `apps/electron/src/renderer/components/design/DesignProjectTab.test.tsx`
- Modify: `apps/electron/src/renderer/components/tabs/TabBar.tsx`
- Modify: `apps/electron/src/renderer/components/tabs/MainArea.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/RightSidePanel.tsx`
- Create: `apps/electron/src/renderer/components/app-shell/design-layout.ts`
- Create: `apps/electron/src/renderer/components/app-shell/design-layout.test.ts`

- [ ] **Step 1: 写失败的导航和布局测试**

`DesignProjectTab.test.tsx` 使用 `renderToStaticMarkup` 验证项目名、激活态、固定 `role=tab` 与不可关闭；`design-layout.test.ts` 测纯函数，避免挂载整个 AppShell：

```ts
import { describe, expect, test } from 'bun:test'
import { getRightPanelMode, shouldShowDesignTab } from './design-layout'

describe('项目级设计布局', () => {
  test('Given 未选项目 When 渲染顶部 Then 不显示 Design Tab', () => {
    expect(shouldShowDesignTab(null)).toBe(false)
  })

  test('Given 设计视图和项目 When 计算右栏 Then 显示设计面板且不要求会话', () => {
    expect(getRightPanelMode({ activeView: 'design', appMode: 'agent', projectId: 'p1', sessionId: null, automationOpen: false }))
      .toBe('design')
  })

  test('Given 会话视图 When 计算右栏 Then 保持原文件面板规则', () => {
    expect(getRightPanelMode({ activeView: 'conversations', appMode: 'agent', projectId: 'p1', sessionId: 's1', automationOpen: false }))
      .toBe('agent')
  })
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `bun test apps/electron/src/renderer/components/design/DesignProjectTab.test.tsx apps/electron/src/renderer/components/app-shell/design-layout.test.ts`

Expected: FAIL，DesignProjectTab 与 design-layout 尚不存在。

- [ ] **Step 3: 实现独立 active view 和顶部入口**

将 `ActiveView` 扩为：

```ts
export type ActiveView = 'conversations' | 'planning' | 'agent-skills' | 'design'
```

`DesignProjectTab` 使用 Lucide `Palette`，显示 `设计 · ${workspace.name}`，active 时使用现有 tab active 主题类；只接受 `workspace`、`active`、`onActivate`，不接受 `sessionId`、关闭或拖拽回调。

`TabBar` 必须：

1. 读取 `currentAgentWorkspaceIdAtom` 和 `activeViewAtom`；
2. 点击任意现有会话/草稿 Tab 时先 `setActiveView('conversations')`；
3. 在 `tabs.map` 后渲染当前项目的 `DesignProjectTab`；
4. 点击设计入口时关闭 automation form、设置 `appMode='agent'`、设置 `activeView='design'`，但不修改 `activeTabId` 或 `currentAgentSessionId`；
5. `tabs.length === 0` 但有当前项目时仍渲染 TabBar。

这保证同一项目切换会话不换画布，设计切回会话时原 active tab 和输入仍在。

- [ ] **Step 4: 实现布局模式纯函数并接入 AppShell**

新增 `apps/electron/src/renderer/components/app-shell/design-layout.ts`：

```ts
import type { ActiveView } from '@/atoms/active-view'

export type RightPanelMode = 'hidden' | 'agent' | 'design'

export interface RightPanelModeInput {
  activeView: ActiveView
  appMode: 'chat' | 'agent' | 'scratch'
  projectId: string | null
  sessionId: string | null
  automationOpen: boolean
}

export function shouldShowDesignTab(projectId: string | null): boolean { return projectId !== null }

export function getRightPanelMode(input: RightPanelModeInput): RightPanelMode {
  if (input.automationOpen || input.activeView === 'planning' || input.activeView === 'agent-skills') return 'hidden'
  if (input.activeView === 'design') return input.projectId ? 'design' : 'hidden'
  return input.appMode === 'agent' && input.sessionId ? 'agent' : 'hidden'
}
```

`AppShell` 用该返回值决定是否挂载右栏；设计模式默认打开，且不复用 `currentSessionSidePanelOpenAtom` 的关闭值。`RightSidePanel` 接收 `mode` 和 `projectId`，agent 模式保持原 `SidePanel`，design 模式渲染下一任务的 `DesignInspector`。

- [ ] **Step 5: 在 MainArea 保持 TabBar 并切换中央页面**

`activeView==='design'` 分支必须渲染：

```tsx
<>
  <TabBar />
  <div className="flex-1 min-h-0 titlebar-no-drag">
    <DesignWorkspaceView />
  </div>
</>
```

该分支必须位于 planning/agent-skills 与 conversations 分支之间；设计模式强制关闭 Browser/Preview/Scratch 的可见条件，但不清空它们的 atoms。

- [ ] **Step 6: 运行测试**

Run: `bun test apps/electron/src/renderer/components/design/DesignProjectTab.test.tsx apps/electron/src/renderer/components/app-shell/design-layout.test.ts`

Expected: PASS，顶部入口和 agent/design/hidden 三种右栏模式稳定。

- [ ] **Step 7: 提交**

```bash
git add apps/electron/src/renderer/atoms/active-view.ts apps/electron/src/renderer/components/design/DesignProjectTab.tsx apps/electron/src/renderer/components/design/DesignProjectTab.test.tsx apps/electron/src/renderer/components/tabs/TabBar.tsx apps/electron/src/renderer/components/tabs/MainArea.tsx apps/electron/src/renderer/components/app-shell/AppShell.tsx apps/electron/src/renderer/components/app-shell/RightSidePanel.tsx apps/electron/src/renderer/components/app-shell/design-layout.ts apps/electron/src/renderer/components/app-shell/design-layout.test.ts
git commit -m "功能：增加项目级设计标签与工作区布局切换"
```

### Task 6: 建立按项目隔离的 Jotai 状态、加载和合并保存

**Files:**
- Create: `apps/electron/src/renderer/atoms/design-atoms.ts`
- Create: `apps/electron/src/renderer/atoms/design-atoms.test.ts`
- Modify: `apps/electron/src/renderer/atoms/index.ts`
- Create: `apps/electron/src/renderer/components/design/DesignWorkspaceView.tsx`
- Create: `apps/electron/src/renderer/components/design/DesignWorkspaceView.test.tsx`
- Create: `apps/electron/src/renderer/components/design/use-design-workspace.ts`

- [ ] **Step 1: 写状态隔离与页面状态失败测试**

```ts
import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { designProjectStatesAtom, updateDesignProjectStateAtom } from './design-atoms'

describe('Design 项目状态', () => {
  test('Given 两个项目 When 更新其中一个 Then 另一个画布状态保持引用与内容', () => {
    const store = createStore()
    store.set(updateDesignProjectStateAtom, { projectId: 'p1', update: { phase: 'ready', snapshot: snapshot1 } })
    store.set(updateDesignProjectStateAtom, { projectId: 'p2', update: { phase: 'ready', snapshot: snapshot2 } })
    const before = store.get(designProjectStatesAtom).get('p2')
    store.set(updateDesignProjectStateAtom, { projectId: 'p1', update: { selectedNodeIds: ['n1'] } })
    expect(store.get(designProjectStatesAtom).get('p2')).toBe(before)
  })
})
```

`DesignWorkspaceView.test.tsx` 静态渲染导出的纯 `DesignWorkspaceStateView`，断言 loading、空画布、只读原因、恢复提示、保存失败且仍保留内存编辑五种状态文案。

- [ ] **Step 2: 运行并确认失败**

Run: `bun test apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/DesignWorkspaceView.test.tsx`

Expected: FAIL，新模块不存在。

- [ ] **Step 3: 实现 Jotai Map 状态和 action atom**

`DesignProjectState` 固定包含：

```ts
export interface DesignProjectState {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  snapshot: DesignWorkspaceSnapshot | null
  jobs: DesignJobRecord[]
  selectedNodeIds: string[]
  activeTool: 'select' | 'pan' | 'arrow' | 'mask'
  inspectorTab: 'assets' | 'ai' | 'versions'
  history: DesignHistoryEntry[]
  future: DesignHistoryEntry[]
  pendingMutations: DesignMutation[]
  saveState: 'saved' | 'dirty' | 'saving' | 'failed'
  error: string | null
}
```

`designProjectStatesAtom` 为 `Map<string, DesignProjectState>`；write atom 每次只 clone Map 和目标项目 state。历史上限 100，项目切换不清理 state。表单 prompt、mask draft 和 viewport 也必须放在对应 project state，不能放组件全局 state。

- [ ] **Step 4: 实现加载、事件刷新与 400ms 保存 hook**

`useDesignWorkspace(projectId)` 的行为固定为：projectId 变化 -> release 旧媒体授权 -> 若无缓存显示 loading -> adapter.load -> 更新 snapshot；订阅 `onChanged`，只刷新同 project 且远端 revision 大于本地 revision 的事件。

保存 effect 只在 `pendingMutations.length > 0 && snapshot.writable` 时启动 400ms timer；timer 触发后把本批 mutations 移出队列并调用 `saveMutations(projectId, revision, batch)`。成功更新 snapshot/revision；失败把 batch 放回队首并设置 failed，不丢内存 document。组件 unmount 时清 timer，但保留 Jotai 中的 pending mutations。

- [ ] **Step 5: 实现稳定页面状态**

`DesignWorkspaceView` 从 `currentAgentWorkspaceIdAtom` 读取 projectId。无项目时返回 `请选择一个项目`；loading 使用现有 Skeleton；error 提供重试按钮；只读仍渲染画布但工具栏写操作 disabled；恢复提示用现有 Sonner toast 只展示一次。空画布中央显示导入按钮和 AI 生成入口，不做营销式说明页。

- [ ] **Step 6: 运行测试**

Run: `bun test apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/DesignWorkspaceView.test.tsx`

Expected: PASS，项目隔离、五种页面状态和未保存数据保留通过。

- [ ] **Step 7: 提交**

```bash
git add apps/electron/src/renderer/atoms/design-atoms.ts apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/atoms/index.ts apps/electron/src/renderer/components/design/DesignWorkspaceView.tsx apps/electron/src/renderer/components/design/DesignWorkspaceView.test.tsx apps/electron/src/renderer/components/design/use-design-workspace.ts
git commit -m "功能：建立按项目隔离的设计状态与自动保存"
```

### Task 7: 交付 XYFlow 无限画布、选择、多选、平移缩放和节点虚拟化

**Files:**
- Create: `apps/electron/src/renderer/components/design/design-canvas-model.ts`
- Create: `apps/electron/src/renderer/components/design/design-canvas-model.test.ts`
- Create: `apps/electron/src/renderer/components/design/DesignCanvas.tsx`
- Create: `apps/electron/src/renderer/components/design/DesignAssetNode.tsx`
- Create: `apps/electron/src/renderer/components/design/DesignAssetNode.test.tsx`
- Create: `apps/electron/src/renderer/components/design/DesignToolbar.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignWorkspaceView.tsx`
- Modify: `apps/electron/src/renderer/styles/globals.css`

- [ ] **Step 1: 写节点映射和状态节点失败测试**

```ts
test('Given 素材和任务节点 When 映射到 XYFlow Then 只使用缩略 URL并保持固定尺寸', () => {
  const nodes = toFlowNodes(document, { thumbnailBaseUrl: 'proma-file://thumbs' })
  expect(nodes[0]?.data.previewUrl).toBe('proma-file://thumbs/a.webp')
  expect(JSON.stringify(nodes)).not.toContain(document.assets[0]?.relativePath)
  expect(nodes[0]).toMatchObject({ width: 320, height: 240, selectable: true, draggable: true })
})
```

`DesignAssetNode.test.tsx` 静态渲染 success、queued、running、failed、cancelled、missing 六种 data，断言固定 `style="width:...;height:..."`、状态文本、retry 按钮只在 failed/cancelled 出现、图片带 `draggable="false"` 和 alt。

- [ ] **Step 2: 运行并确认失败**

Run: `bun test apps/electron/src/renderer/components/design/design-canvas-model.test.ts apps/electron/src/renderer/components/design/DesignAssetNode.test.tsx`

Expected: FAIL，画布模块不存在。

- [ ] **Step 3: 实现 XYFlow 映射与画布**

`toFlowNodes` 把 Design node 映射为 `type: 'designAsset'`，data 只含 asset/job 展示字段和 `previewUrl`。URL 通过 `thumbnailBaseUrl + '/' + encodeURIComponent(basename(thumbnailRelativePath))` 构造，不使用原图路径。

`DesignCanvas` 必须配置：

```tsx
<ReactFlow
  nodes={flowNodes}
  edges={[]}
  nodeTypes={nodeTypes}
  defaultViewport={document.viewport}
  minZoom={0.05}
  maxZoom={8}
  selectionOnDrag={activeTool === 'select'}
  panOnDrag={activeTool === 'pan' ? true : [1, 2]}
  multiSelectionKeyCode={['Meta', 'Control']}
  deleteKeyCode={null}
  onlyRenderVisibleElements
  nodesDraggable={writable && activeTool === 'select'}
  nodesConnectable={false}
  onNodesChange={handleNodesChange}
  onSelectionChange={handleSelectionChange}
  onMoveEnd={handleMoveEnd}
  fitView={document.nodes.length > 0 && document.revision === 0}
>
  <Background gap={24} size={1} />
  <Controls showInteractive={false} />
</ReactFlow>
```

只在 drag stop 产生 `move-nodes`，不在逐帧 `onNodesChange` 写盘；viewport 只在 `onMoveEnd` 产生 `set-viewport`。选区写 Jotai，画布切换不 unmount 其他会话 Agent。

- [ ] **Step 4: 实现工具栏和键盘入口**

工具栏用 Lucide `MousePointer2`、`Hand`、`Undo2`、`Redo2`、`Group`、`Ungroup`、`ArrowUpRight`、`Paintbrush`、`Upload` 图标；不显示键盘教学文字。每个不熟悉图标有 Tooltip，模式使用 segmented control，undo/redo disabled 状态固定宽高 `h-8 w-8`。

`globals.css` 只 import `@xyflow/react/dist/style.css` 并用现有主题变量覆盖背景、controls、selection 色；不得增加全屏渐变或单色紫蓝主题。

- [ ] **Step 5: 运行测试和 Renderer build**

Run: `bun test apps/electron/src/renderer/components/design/design-canvas-model.test.ts apps/electron/src/renderer/components/design/DesignAssetNode.test.tsx && cd apps/electron && bun run build:renderer`

Expected: PASS；Vite 成功打包 XYFlow CSS 和自定义节点，无 unresolved import。

- [ ] **Step 6: 提交**

```bash
git add apps/electron/src/renderer/components/design/design-canvas-model.ts apps/electron/src/renderer/components/design/design-canvas-model.test.ts apps/electron/src/renderer/components/design/DesignCanvas.tsx apps/electron/src/renderer/components/design/DesignAssetNode.tsx apps/electron/src/renderer/components/design/DesignAssetNode.test.tsx apps/electron/src/renderer/components/design/DesignToolbar.tsx apps/electron/src/renderer/components/design/DesignWorkspaceView.tsx apps/electron/src/renderer/styles/globals.css
git commit -m "功能：实现设计无限画布与基础节点交互"
```

### Task 8: 实现撤销重做、复制删除、分组和箭头/蒙版批注

**Files:**
- Create: `apps/electron/src/renderer/lib/design-editor.ts`
- Create: `apps/electron/src/renderer/lib/design-editor.test.ts`
- Create: `apps/electron/src/renderer/components/design/DesignAnnotationLayer.tsx`
- Create: `apps/electron/src/renderer/components/design/DesignAnnotationLayer.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignCanvas.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignToolbar.tsx`
- Modify: `apps/electron/src/renderer/atoms/design-atoms.ts`

- [ ] **Step 1: 写 BDD 编辑 reducer 失败测试**

测试必须覆盖：复制产生新 ID 并偏移 24px；删除素材节点不删除素材；两节点分组后共享 groupId；ungroup 清理空组；arrow 两点；mask rAF 批次去除相邻距离小于 1px 的点；undo 生成 inverse mutations；redo 恢复。

```ts
test('Given 两个选中节点 When 分组并撤销 Then group 和 node groupId 可完整恢复', () => {
  const grouped = reduceDesignEdit(document, { type: 'group-selection', nodeIds: ['n1', 'n2'], groupId: 'g1', name: '组 1' })
  expect(grouped.document.groups[0]?.nodeIds).toEqual(['n1', 'n2'])
  const undone = applyDesignMutations(grouped.document, grouped.inverse)
  expect(undone).toEqual(document)
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `bun test apps/electron/src/renderer/lib/design-editor.test.ts apps/electron/src/renderer/components/design/DesignAnnotationLayer.test.tsx`

Expected: FAIL，reducer 和 annotation layer 不存在。

- [ ] **Step 3: 实现纯编辑命令和历史**

`reduceDesignEdit(document, command)` 返回 `{ document, forward, inverse, selection }`。command union 固定为 `duplicate-selection`、`delete-selection`、`group-selection`、`ungroup-selection`、`add-annotation`、`remove-annotation`。新 ID 由调用方提供，纯函数内部不读时间或 UUID，确保测试和 undo 确定性。

Jotai action 在应用 forward 后压入 `{ forward, inverse }`，清空 future，history 超过 100 时丢最旧项；undo 应用 inverse 并把 entry 压入 future，redo 应用 forward。所有 forward/inverse 同时追加到 pending mutations。

- [ ] **Step 4: 实现批注交互层**

箭头工具 pointerdown 记录起点、pointerup 记录终点，长度小于 4px 不创建。蒙版工具把 pointermove 点放入 ref，每个 animation frame 最多 flush 一次到 draft；pointerup 生成单个 mask annotation。颜色使用现有 foreground/destructive/accent 可访问色，默认 width=12；只在编辑模式捕获 pointer events，select/pan 时 `pointer-events-none`。

键盘：`Cmd/Ctrl+C` 复制选择，`Cmd/Ctrl+Z` undo，`Cmd/Ctrl+Shift+Z` redo，Backspace/Delete 删除，`Cmd/Ctrl+G` 分组，`Cmd/Ctrl+Shift+G` 取消分组；输入框或 contenteditable 聚焦时不拦截。

- [ ] **Step 5: 运行测试**

Run: `bun test apps/electron/src/renderer/lib/design-editor.test.ts apps/electron/src/renderer/components/design/DesignAnnotationLayer.test.tsx`

Expected: PASS，编辑命令的 forward/inverse 和批注边界全部通过。

- [ ] **Step 6: 提交**

```bash
git add apps/electron/src/renderer/lib/design-editor.ts apps/electron/src/renderer/lib/design-editor.test.ts apps/electron/src/renderer/components/design/DesignAnnotationLayer.tsx apps/electron/src/renderer/components/design/DesignAnnotationLayer.test.tsx apps/electron/src/renderer/components/design/DesignCanvas.tsx apps/electron/src/renderer/components/design/DesignToolbar.tsx apps/electron/src/renderer/atoms/design-atoms.ts
git commit -m "功能：增加设计编辑历史分组与批注工具"
```

### Task 9: 交付素材/AI 编辑/版本右栏与导入导出流程

**Files:**
- Create: `apps/electron/src/renderer/components/design/DesignInspector.tsx`
- Create: `apps/electron/src/renderer/components/design/DesignInspector.test.tsx`
- Create: `apps/electron/src/renderer/components/design/design-version-tree.ts`
- Create: `apps/electron/src/renderer/components/design/design-version-tree.test.ts`
- Modify: `apps/electron/src/renderer/components/design/DesignToolbar.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/RightSidePanel.tsx`
- Modify: `apps/electron/src/renderer/atoms/design-atoms.ts`

- [ ] **Step 1: 写右栏状态和版本树失败测试**

`DesignInspector.test.tsx` 静态渲染并断言：空选区显示项目素材和生成表单；单选显示文件名/尺寸/来源/导出/删除；多选显示数量和分组；缺失素材显示“重新定位”按钮；只读禁用写操作但允许导出。

```ts
test('Given 父子素材 When 构建版本树 Then 保持根到子版本顺序并标识当前项', () => {
  const tree = buildDesignVersionTree([
    createAsset({ id: 'root' }),
    createAsset({ id: 'child', parentAssetId: 'root' }),
    createAsset({ id: 'grandchild', parentAssetId: 'child' }),
  ], 'child')
  expect(tree).toEqual([{ id: 'root', current: false, children: [{ id: 'child', current: true, children: [{ id: 'grandchild', current: false, children: [] }] }] }])
})

test('Given 循环 parentAssetId When 构建版本树 Then 将循环节点放入孤立根且不递归崩溃', () => {
  expect(buildDesignVersionTree([createAsset({ id: 'a', parentAssetId: 'b' }), createAsset({ id: 'b', parentAssetId: 'a' })], null))
    .toHaveLength(2)
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `bun test apps/electron/src/renderer/components/design/DesignInspector.test.tsx apps/electron/src/renderer/components/design/design-version-tree.test.ts`

Expected: FAIL，右栏和版本树模块不存在。

- [ ] **Step 3: 实现右侧三标签和选择态**

使用现有 Radix Tabs，标签固定为 `素材`、`AI 编辑`、`版本`。标题使用面板级字号，不使用 hero typography。素材列表用 48px 方形缩略图；按钮使用 Lucide `Download`、`Trash2`、`Send`、`RefreshCw`、`X`。

删除行为：有节点引用时 UI 先提示“请先从画布移除该素材的全部节点”；无引用时调用 adapter.deleteAsset。缺失素材点击“重新定位”调用主进程选择器并原位更新 asset metadata，节点位置和版本关系不变。导出不要求 writable。导入由工具栏和素材空态共同调用 `importDesignAssets({ projectId })`；返回 assets 后按从当前 viewport 中心开始的 24px 对角偏移生成节点并提交一批 `upsert-assets + upsert-nodes` mutation。

- [ ] **Step 4: 实现版本树和 AI 编辑表单**

版本树按 `parentAssetId` 构建，循环和缺失父项作为根展示；选择版本节点同步画布 selection。AI 编辑表单仅在单个 asset node 选中时可填写，字段固定为 prompt、可选 mask annotation；生成表单在空白选择时可填写，字段为 prompt、aspect ratio、image size。首版 aspect ratio 仅允许 `1:1|16:9|4:3|9:16|3:4`，image size 仅允许 `auto|1K|2K|4K`，它们序列化进 prompt 的机器可读约束，不扩展共享 job 类型。本任务通过必填 `onCreateJob` prop 测试表单输出；Task 10 接通 handler 后才在 `DesignInspector` 容器传入真实 adapter，保证提交链不存在半接通状态。

- [ ] **Step 5: 运行测试**

Run: `bun test apps/electron/src/renderer/components/design/DesignInspector.test.tsx apps/electron/src/renderer/components/design/design-version-tree.test.ts`

Expected: PASS，空/单选/多选/缺失/只读和版本循环边界通过。

- [ ] **Step 6: 提交**

```bash
git add apps/electron/src/renderer/components/design/DesignInspector.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx apps/electron/src/renderer/components/design/design-version-tree.ts apps/electron/src/renderer/components/design/design-version-tree.test.ts apps/electron/src/renderer/components/design/DesignToolbar.tsx apps/electron/src/renderer/components/app-shell/RightSidePanel.tsx apps/electron/src/renderer/atoms/design-atoms.ts
git commit -m "功能：完成设计素材面板与版本导入导出流程"
```

### Task 10: 通过可见 Pi Agent 会话实现生成、局部编辑、取消、重试和恢复

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `apps/electron/src/main/lib/agent-service.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Create: `apps/electron/src/main/lib/agent-design-tool-policy.test.ts`
- Create: `apps/electron/src/main/lib/design/design-job-manager.ts`
- Create: `apps/electron/src/main/lib/design/design-job-manager.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/design-store.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignAssetNode.tsx`

- [ ] **Step 1: 写任务状态机和输出归属失败测试**

使用注入的 createSession、runHeadless、stopAgent、readMessages、assetService、store、settings。覆盖正常成功、无模型、失败、取消、重试产生新会话、非当前任务图片拒绝、重启 running -> interrupted。`agent-design-tool-policy.test.ts` 额外证明 Design run 只允许 Nano Banana 工具，Bash、Write、Read、Browser 和其他 MCP 工具全部返回 deny：

```ts
test('Given 图片生成成功 When Pi 完成 Then 只导入当前任务 tool_result 图片并建立父子版本', async () => {
  harness.runHeadlessResult = [createToolMessage({
    toolName: 'mcp__nano_banana__generate_image',
    images: [{ localPath: '/trusted/output.png', filename: 'output.png', mediaType: 'image/png' }],
  })]
  const job = harness.manager.create({ projectId: 'p1', action: 'edit', prompt: 'remove text', sourceAssetId: 'a1', position: { x: 10, y: 20 } })
  await harness.manager.run(job.id)
  const completed = harness.manager.get(job.id)
  expect(completed?.status).toBe('succeeded')
  expect(completed?.parentAssetId).toBe('a1')
  expect(harness.importSources[0]).toMatchObject({ kind: 'job', sourceJobId: job.id, parentAssetId: 'a1' })
})

test('Given 上次进程留下 running job When 恢复 Then 标记 interrupted 且允许重试', () => {
  harness.writeJob(createJob({ status: 'running' }))
  expect(harness.manager.recover('p1')[0]?.status).toBe('interrupted')
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts`

Expected: FAIL，DesignJobManager 不存在。

- [ ] **Step 3: 扩展可追踪会话元数据，不新增第二套 runtime**

在 `AgentSessionMeta` 增加：

```ts
/** 来源设计项目 ID；仅 Design Job 可见会话设置。 */
sourceDesignProjectId?: string
/** 来源设计任务 ID；用于从会话追溯画布占位节点。 */
sourceDesignJobId?: string
```

`AgentExternalRunSource` 增加 `'design'`，供 `external_run_started` 明确展示来源；`AgentSendInput.triggeredBy` 保持现有 union，Design run 使用 `'user'`，避免把 design 扩散到 Browser/Planning/Collaboration 的执行来源协议。同步扩展 `updateAgentSessionMeta` 的 Pick；设计任务不得获得 automation/delegation 的额外工具权限。

在 `AgentRunExtensions` 增加 `allowedToolNames?: readonly string[]`，并在 `agent-orchestrator.ts` 的 `canUseTool` 完成 stale generation 检查后、任何工具参数处理前执行：

```ts
export function denyToolOutsideRunAllowlist(
  toolName: string,
  allowedToolNames: readonly string[] | undefined,
): PermissionResult | undefined {
  if (!allowedToolNames || allowedToolNames.includes(toolName)) return undefined
  return { behavior: 'deny', message: `当前任务不允许使用工具: ${toolName}` }
}
```

```ts
const runPolicyDenial = denyToolOutsideRunAllowlist(toolName, extensions.allowedToolNames)
if (runPolicyDenial) return runPolicyDenial
```

这是 Design Job 的真实权限边界，不只依赖 prompt。普通用户、Automation、Delegation 未传 allowlist 时行为不变。

- [ ] **Step 4: 实现 job journal 与模型解析**

每个 job 原子写入 `<cache>/jobs/<job-id>.json`，使用 `writeJsonFileAtomic`。模型优先级固定为：同项目且 input.sourceSessionId 的会话 channel/model -> `settings.agentChannelId/agentModelId`；两者任一缺失时 job 直接 failed，错误为 `未配置可用的 Agent 渠道和模型`，不创建空 Agent 会话。

创建可见会话：

```ts
const session = createAgentSession(`设计任务：${trimmedPrompt.slice(0, 24)}`, channelId, input.projectId, modelId)
updateAgentSessionMeta(session.id, {
  sourceDesignProjectId: input.projectId,
  sourceDesignJobId: job.id,
})
```

生成 prompt 必须要求只调用一次 `mcp__nano_banana__generate_image` 并返回图片；编辑 prompt 由主进程解析 source asset 绝对路径和可选 mask annotation，作为 `referenceImagePaths` 和明确编辑说明。Renderer 不能传绝对参考图路径。

- [ ] **Step 5: 执行 Pi 并只收集结构化图片结果**

调用：

```ts
await runAgentHeadless({
  sessionId: session.id,
  userMessage: buildDesignJobPrompt(input, sourceAssetPath, mask),
  rawUserMessage: input.prompt,
  channelId,
  modelId,
  workspaceId: input.projectId,
  triggeredBy: 'user',
  permissionModeOverride: 'bypassPermissions',
}, { ...callbacks, source: 'design' }, {
  allowedToolNames: ['mcp__nano_banana__generate_image'],
})
```

完成后只遍历本次回调 messages 中 `role==='assistant' || role==='tool'` 的 `events`，只接受 `event.type==='tool_result'`、`toolName==='mcp__nano_banana__generate_image'`、`!isError` 的 `imageAttachments`。每个路径必须再次通过 attachment ownership 检查和图片校验，再从 staging 导入。没有合格图片则 failed，错误为 `任务完成但没有产生可验证图片`。

`create(input)` 只原子记录 queued job 和占位节点并立即返回；IPC 随后执行 `void manager.run(job.id)`，避免生成期间阻塞 Renderer invoke。成功时同一个 store mutation：upsert asset、把 job 占位 node 改成 asset node、保留 `parentAssetId/sourceJobId/sourceSessionId/prompt`。失败/取消保留 job node。retry 创建新 job ID 和新可见会话，并让旧 node 的 jobId 指向新 job；旧 journal 保留审计。

本任务同时向 `design-ipc.ts` 增量注册 CREATE_JOB、CANCEL_JOB、RETRY_JOB、LIST_JOBS。create/retry/cancel 在 `guard.runWorkspaceWrite(projectId, effect)` 内；list 为只读。`useDesignWorkspace` 在 Task 10 后加载 jobs 并响应 cause=`job` 的 change event；`DesignProjectState` 的 `jobs: DesignJobRecord[]` 初始为空。

- [ ] **Step 6: 接入取消、退出与启动恢复**

cancel 只允许 queued/running，调用 `stopAgent(job.sessionId)` 后写 cancelled；竞态成功回调先重读 journal，若已经 cancelled 则删除 staging 输出且不导入。

`apps/electron/src/main/index.ts` 在正常 startup 完成 IPC 初始化后调用 `designJobManager.recoverAll()`；before-quit 先同步调用 `designJobManager.markRunningInterrupted()`，再由既有 `stopAllAgents()` 中止对应 session。terminal callback 重读 journal，发现 interrupted/cancelled 后不得导入输出。项目迁移期间 create/retry 已由 workspace guard 阻断；运行中的任务由 Agent generation-owned workspace guard 阻断迁移。

- [ ] **Step 7: 运行任务测试**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/agent-design-tool-policy.test.ts apps/electron/src/main/lib/agent-session-manager.test.ts`

Expected: PASS，成功/失败/取消/重试/恢复/图片归属和会话元数据通过。

- [ ] **Step 8: 提交**

```bash
git add packages/shared/src/types/agent.ts apps/electron/src/main/lib/agent-session-manager.ts apps/electron/src/main/lib/agent-service.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-design-tool-policy.test.ts apps/electron/src/main/lib/design/design-job-manager.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-ipc.ts apps/electron/src/main/lib/design/design-store.ts apps/electron/src/main/ipc.ts apps/electron/src/main/index.ts apps/electron/src/renderer/components/design/DesignInspector.tsx apps/electron/src/renderer/components/design/DesignAssetNode.tsx
git commit -m "功能：接入可追踪的 Pi 设计生成与编辑任务"
```

### Task 11: 打通设计素材与项目 Agent 会话的双向传递

**Files:**
- Create: `apps/electron/src/main/lib/design/design-session-bridge.ts`
- Create: `apps/electron/src/main/lib/design/design-session-bridge.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-ipc.ts`
- Create: `apps/electron/src/renderer/lib/design-session-actions.ts`
- Create: `apps/electron/src/renderer/lib/design-session-actions.test.ts`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.tsx`
- Modify: `apps/electron/src/renderer/components/agent/SDKMessageRenderer.tsx`

- [ ] **Step 1: 写归属验证和 composer 传递失败测试**

主进程测试：目标 session 必须存在且 `session.workspaceId===projectId`；Agent 图片 localPath 必须精确出现在该 session 持久化消息的 `tool_result.imageAttachments` 中；同路径字符串但来自另一 session 必须拒绝。

Renderer 测试：

```ts
test('Given 已准备好的设计素材 When 发送到会话 Then 先打开会话再填入引用且不自动发送', async () => {
  const calls: string[] = []
  await sendPreparedDesignAssetToSession(prepared, {
    openSession: async (id) => { calls.push(`open:${id}`) },
    dispatchMention: (items) => { calls.push(`mention:${items[0]?.path}`) },
  })
  expect(calls).toEqual(['open:s1', 'mention:/project/.proma/design/assets/a.png'])
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-session-bridge.test.ts apps/electron/src/renderer/lib/design-session-actions.test.ts`

Expected: FAIL，session bridge 和发送 helper 不存在。

- [ ] **Step 3: 实现主进程归属桥**

`DesignSessionBridge.prepareAssetForSession(input)`：验证项目、session 归属和 asset，返回主进程解析出的受管绝对素材路径及固定 `scope:'project'`；不修改会话、不发送消息。Inspector 的发送菜单只列出 `workspaceId===projectId` 且未归档的 Agent 会话，默认选中当前会话，用户可切换到项目内任意会话。

`importAgentImage(input)`：读取 `getAgentSessionMessages(sessionId)`，用下面的精确匹配判断所有权：

```ts
const owned = messages.some((message) => message.events?.some((event) =>
  event.type === 'tool_result'
  && event.imageAttachments?.some((image) => image.localPath === input.localPath),
))
if (!owned) throw new Error('图片不属于指定 Agent 会话')
```

随后验证 session.workspaceId、规范化真实路径和允许根，调用 asset service 导入，并在用户给定 position 创建 asset node。不得扫描 session 目录、项目目录或 `~/.codex/generated_images`。

本任务向 `design-ipc.ts` 增量注册 PREPARE_ASSET_FOR_SESSION 和 IMPORT_AGENT_IMAGE；前者只读，后者必须在 `guard.runWorkspaceWrite(projectId, effect)` 内并在成功后广播 cause=`asset`。

- [ ] **Step 4: 实现 Renderer 发送和 Agent 图片入口**

`sendPreparedDesignAssetToSession` 必须 await `openSession`，再调用现有 `dispatchInsertFileMention([prepared])`，最后 `activeView='conversations'`；禁止调用 `sendAgentMessage`。

`SDKMessageRenderer` 对有 `imageAttachments` 的 Nano Banana tool result 增加 `加入设计` 图标按钮。点击后读取消息所属 session 的 workspaceId；无项目归属时 disabled 并 tooltip `该会话不属于项目`；成功调用 `importAgentImageToDesign` 后只提示 `已加入设计`，不自动切换页面。

- [ ] **Step 5: 运行双向桥测试**

Run: `bun test apps/electron/src/main/lib/design/design-session-bridge.test.ts apps/electron/src/renderer/lib/design-session-actions.test.ts`

Expected: PASS，同项目正常路径通过，跨项目/伪造图片被拒绝，发送只填 composer。

- [ ] **Step 6: 提交**

```bash
git add apps/electron/src/main/lib/design/design-session-bridge.ts apps/electron/src/main/lib/design/design-session-bridge.test.ts apps/electron/src/main/lib/design/design-ipc.ts apps/electron/src/renderer/lib/design-session-actions.ts apps/electron/src/renderer/lib/design-session-actions.test.ts apps/electron/src/renderer/components/design/DesignInspector.tsx apps/electron/src/renderer/components/agent/SDKMessageRenderer.tsx
git commit -m "功能：打通设计素材与项目会话双向传递"
```

### Task 12: 收口恢复、迁移、性能、主题和完整构建验证

**Files:**
- Create: `apps/electron/src/main/lib/design/design-recovery.test.ts`
- Create: `apps/electron/src/renderer/components/design/design-performance.test.tsx`
- Create: `apps/electron/src/renderer/components/design/design-accessibility.test.tsx`
- Modify: `apps/electron/src/main/lib/agent-service.test.ts`
- Modify: `apps/electron/src/main/lib/workspace-project-relocator.test.ts`
- Modify: `apps/electron/src/renderer/components/design/DesignWorkspaceView.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignCanvas.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignToolbar.tsx`

- [ ] **Step 1: 写跨模块恢复和资源基线失败测试**

`design-recovery.test.ts` 覆盖：项目离线 LOAD 返回 writable=false 且不创建其他目录；canvas 主文件损坏从 bak 恢复并广播 recovery；项目迁移锁阻止 save/import/create/retry；staging 遗留不会进入 assets；running job 恢复 interrupted。

`design-performance.test.tsx` 覆盖 1,000 nodes 映射不包含 base64/original URL，所有 asset node 使用 thumbnail，ReactFlow props 包含 `onlyRenderVisibleElements`。增加纯函数预算断言：一次 move 1,000 nodes 只产生一个 mutation；viewport 高频事件经 debounce 只保存最后值。

`design-accessibility.test.tsx` 静态断言工具栏、tabs、任务状态、retry/cancel、导入按钮有 accessible name；窄面板文本允许换行；深浅主题只使用 CSS variables，不硬编码不可读前景色。

- [ ] **Step 2: 运行并确认至少一个验收场景失败**

Run: `bun test apps/electron/src/main/lib/design/design-recovery.test.ts apps/electron/src/renderer/components/design/design-performance.test.tsx apps/electron/src/renderer/components/design/design-accessibility.test.tsx`

Expected: FAIL，暴露尚未接通的 recovery broadcast、批处理或 accessible label。

- [ ] **Step 3: 修复恢复、迁移和资源边界**

只针对失败证据修改 production 文件：

- LOAD 先检查 workspace `projectRootStatus`；不可用时仅返回最后可读 snapshot 或空只读 document，reason 固定为 `项目路径不可访问，设计工作区已切换为只读`。
- 所有正式写入继续由 workspace guard 包裹；`workspace-project-relocator` 的 existing Agent generation-owned 测试增加 Design Job session case，证明无需第二套迁移锁。
- startup 清理 staging 中没有 succeeded job 引用的文件；不得删除 assets。
- 一次 pointer frame 只产生内存位置变化，drag stop 才产生一个 `move-nodes`；autosave 400ms 合并连续 viewport mutation，只保留最后一个 `set-viewport`。
- 页面卸载和项目切换调用 `releaseDesignMediaAccess(projectId)`；图片节点不创建 Blob URL，因此无需浏览器内 URL revoke。

- [ ] **Step 4: 完成窄窗口、键盘和主题收口**

在 960px 以下右栏宽度限制为 300px，素材元数据使用 `min-w-0 break-words`；画布 toolbar 允许分组换行但按钮保持 32px；右栏 Tabs 不嵌套 card。所有 icon-only button 有 Tooltip 和 `aria-label`，任务 status 使用文字与图标双重表达，不只依赖颜色。

- [ ] **Step 5: 运行全部定向 Design 测试**

Run: `bun test packages/shared/src/types/design.test.ts apps/electron/src/main/lib/design apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts apps/electron/src/renderer/lib/design-editor.test.ts apps/electron/src/renderer/lib/design-session-actions.test.ts apps/electron/src/renderer/components/design`

Expected: PASS，Design shared/main/preload/renderer 全部场景通过。

- [ ] **Step 6: 运行关联回归、类型和构建**

Run: `bun test apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/lib/agent-service.test.ts apps/electron/src/main/lib/workspace-operation-guard.test.ts apps/electron/src/main/lib/workspace-project-relocator.test.ts apps/electron/src/renderer/atoms/tab-atoms.test.ts`

Expected: PASS，Agent 会话、迁移守卫和既有 tab 行为无回归。

Run: `bun run typecheck`

Expected: PASS，无 TypeScript 错误。

Run: `bun run electron:build`

Expected: PASS。因为新增 Renderer runtime dependency，必须验证 Electron 主进程、Preload 和 Renderer 完整 bundle；无需把 XYFlow 加入 main/utility external 清单。

- [ ] **Step 7: 本地交互冒烟验证**

Run: `bun run dev`

Expected: 应用启动后完成以下验收，不出现 Renderer console error：选择项目后显示 `设计 · 项目名`；切换同项目会话不换画布；导入图片后缩略节点可拖动/多选/缩放；分组和批注可 undo/redo；创建任务出现可见 Agent 会话和状态节点；取消/失败可重试；发送到会话只填入 composer；导出得到与素材 SHA-256 一致的原图；切换项目后旧素材 URL 不再可读。

- [ ] **Step 8: 提交**

```bash
git add apps/electron/src/main/lib/design/design-recovery.test.ts apps/electron/src/renderer/components/design/design-performance.test.tsx apps/electron/src/renderer/components/design/design-accessibility.test.tsx apps/electron/src/main/lib/agent-service.test.ts apps/electron/src/main/lib/workspace-project-relocator.test.ts apps/electron/src/renderer/components/design/DesignWorkspaceView.tsx apps/electron/src/renderer/components/design/DesignCanvas.tsx apps/electron/src/renderer/components/design/DesignInspector.tsx apps/electron/src/renderer/components/design/DesignToolbar.tsx
git commit -m "测试：收口设计工作区恢复性能与完整构建验证"
```

## 最终验收矩阵

| 需求 | 实施任务 | 可证明证据 |
| --- | --- | --- |
| 每项目一个画布、顶部切换 | Task 5-6 | DesignProjectTab 与项目状态隔离测试 |
| 正式数据随项目、缓存独立 | Task 2-3 | 路径解析和素材服务测试 |
| 选择、多选、平移、缩放、虚拟化 | Task 7 | canvas model、node 与 Renderer build |
| 复制、删除、分组、撤销重做 | Task 8 | design-editor inverse mutation 测试 |
| 箭头批注与画笔蒙版 | Task 8 | annotation layer 边界测试 |
| 素材、AI 编辑、版本右栏 | Task 9 | Inspector 状态和版本树测试 |
| 生成、局部编辑、失败、取消、重试 | Task 10 | DesignJobManager 状态机测试 |
| 可见、可追踪 Pi 项目任务 | Task 10 | AgentSessionMeta 来源字段和 headless run 测试 |
| 设计与会话双向传递 | Task 11 | 归属验证和 composer-only 测试 |
| revision、多窗口和损坏恢复 | Task 2、12 | store stale conflict 与 recovery 测试 |
| 离线、迁移、退出恢复 | Task 10、12 | migration guard 与 interrupted job 测试 |
| 深浅主题、键盘、窄窗口 | Task 7-9、12 | accessibility 静态测试与本地冒烟 |
| 不引入 Codex/HTTP/MCP 服务 | 全部 | 依赖 diff、构建输出与代码审查 |

## 明确不进入本计划的内容

OCR 改字、元素分层、PSD、PPT、draw.io、多人实时协作不添加字段、依赖或空 UI 入口。它们需要在本计划的数据格式、Pi 任务和资源基线稳定后分别立项，避免首版承担无法验证的扩展成本。
