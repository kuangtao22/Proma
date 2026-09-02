# Canvas 图片风格核对实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通 Agent 能分页枚举关联画布的图片节点，并分批读取当前正式采用缩略图完成只读视觉一致性核对。

**Architecture:** 在现有 Canvas Tool Provider 内增加 `canvas_list_nodes` 与 `canvas_inspect_images`，所有授权、revision 和节点身份校验仍由主进程权威文档完成。Design Asset Service 提供只按项目和已登记 Asset 读取缩略图的窄接口；工具结果按文本身份块与 Pi 图片块交替返回，并施加单张 512 KiB、单批 2 MiB 的硬预算。

**Tech Stack:** Bun、TypeScript、Electron 主进程、Pi Agent custom tools、TypeBox、Sharp、Bun Test。

---

### Task 1: 安全缩略图读取合同

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-asset-service.ts`
- Test: `apps/electron/src/main/lib/design/design-asset-service.test.ts`

- [ ] **Step 1: 写失败测试**

增加 BDD 测试，使用已导入素材调用公开窄接口：合法缩略图返回 `{ bytes, mediaType }`；未知 Asset、路径越界、符号链接或签名损坏均抛出稳定错误且不返回路径。

```ts
const thumbnail = service.readStoredThumbnail(projectId, asset.id)
expect(thumbnail.mediaType).toBe('image/webp')
expect(isValidImageBytes(thumbnail.mediaType, thumbnail.bytes)).toBe(true)
expect(() => service.readStoredThumbnail(projectId, 'missing')).toThrow('DESIGN_ASSET_NOT_FOUND')
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-asset-service.test.ts`

Expected: FAIL，提示 `readStoredThumbnail` 不存在。

- [ ] **Step 3: 最小实现**

在 `DesignAssetService` 增加只读接口，从权威 Design 文档按 ID 找 Asset，使用 `resolveStoredAssetFiles()` 得到缩略图路径，再复用普通文件、受管目录和图片签名校验边界读取字节。

```ts
export interface StoredDesignThumbnail {
  bytes: Buffer
  mediaType: DesignAsset['mediaType']
}

readStoredThumbnail(projectId: string, assetId: string): StoredDesignThumbnail
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/electron/src/main/lib/design/design-asset-service.test.ts`

Expected: PASS。

### Task 2: 节点分页与图片检查工具

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.ts`
- Test: `apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`

- [ ] **Step 1: 写分页枚举失败测试**

覆盖 `kind=image`、稳定顺序、默认/最大页大小、不泄露 adopted Asset、游标绑定项目/画布/revision/kind/offset，以及旧 revision 游标冲突。

```ts
const result = await executeTool(run.piCustomTools, 'canvas_list_nodes', {
  canvasId: 'canvas-1', kind: 'image', limit: 1,
})
expect(result.details).toMatchObject({ canvasId: 'canvas-1', revision: 3, hasMore: true })
expect(JSON.stringify(result.details)).not.toContain('asset-1')
```

- [ ] **Step 2: 写图片检查失败测试**

覆盖 1-4 个节点稳定去重、文本身份块紧邻图片块、缺少正式采用资产、节点/配置 adopted 身份不一致、旧 revision、损坏图片、单张和总预算。

```ts
const result = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
  canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3,
})
expect(result.content.map((block) => block.type)).toEqual(['text', 'image'])
expect(JSON.stringify(result.details)).not.toContain('asset-1')
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`

Expected: FAIL，提示两个工具不存在或工具数量仍为七个。

- [ ] **Step 4: 实现游标和节点摘要**

增加带 SHA-256 完整性校验的不透明 base64url 游标，固定保存 `projectId/canvasId/revision/kind/offset`；`canvas_list_nodes` 每次重新授权和 LOAD，只返回节点身份、类型、标题、内容 revision 与 `hasAdoptedAsset`。

```ts
interface CanvasNodeCursorPayload {
  projectId: string
  canvasId: string
  revision: number
  kind?: CanvasNode['kind']
  offset: number
}
```

- [ ] **Step 5: 实现受限图片结果**

为 Provider 注入 `readAdoptedThumbnail`，检查权威 revision、图片节点、图片配置与 adopted 身份；使用 Sharp 在内存中压缩超出 512 KiB 的缩略图，最多四张且合计不超过 2 MiB，失败返回节点级公开状态，成功返回交替的文本与图片块。

```ts
images: {
  load: ExistingImageLoader
  save: ExistingImageSaver
  readAdoptedThumbnail: (projectId: string, assetId: string) => Promise<{
    bytes: Buffer
    mediaType: string
  }>
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`

Expected: PASS，九个工具均注入且只有 `canvas_run_nodes` 需要单次审批。

### Task 3: 主进程注入与默认 Skill

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/default-skills/canvas-production/SKILL.md`
- Test: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Test: `apps/electron/src/main/lib/default-canvas-production-skill.test.ts`

- [ ] **Step 1: 写失败测试**

锁定 Provider 通过现有 Asset Service 读取缩略图；默认 Skill 版本为 `1.0.2`，列出九个工具，并明确“核对只读、先枚举再分批看图、不能用截图或提示词冒充视觉检查”。

```ts
expect(skill).toContain('version: "1.0.2"')
expect(skill).toContain('canvas_list_nodes')
expect(skill).toContain('canvas_inspect_images')
expect(skill).toContain('不得只比较提示词')
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/default-canvas-production-skill.test.ts`

Expected: FAIL，提示缺少新读取依赖或 Skill 合同。

- [ ] **Step 3: 接入和更新 Skill**

`canvas-document-ipc.ts` 只把 Asset Service 的窄读取接口注入 Provider，不新增 Renderer IPC。Skill 版本递增 patch，并加入完整只读核对流程及明确修正后的候选/审批边界；最小系统提示同步保留该安全合同。

```ts
readAdoptedThumbnail: async (projectId, assetId) => assetService.readStoredThumbnail(projectId, assetId)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/default-canvas-production-skill.test.ts`

Expected: PASS。

### Task 4: 完整验证与记忆

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: 运行相关回归测试**

Run: `bun test apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/design/design-asset-service.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/default-canvas-production-skill.test.ts`

Expected: PASS。

- [ ] **Step 2: 运行类型检查**

Run: `bun run typecheck`

Expected: PASS。

- [ ] **Step 3: 更新项目记忆**

记录：Canvas 全量视觉核对采用分页枚举与最多四张一批的当前正式缩略图读取；核对只读，revision 改变即重枚举，工具不暴露路径/URL/Asset ID。

- [ ] **Step 4: 检查最终差异**

Run: `git diff --check`

Expected: 无输出；最终 `git diff --stat` 仅包含本功能与用户原有未提交文件。
