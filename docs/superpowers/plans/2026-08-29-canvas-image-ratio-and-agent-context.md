# Canvas Image Ratio And Agent Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Canvas 生图卡片按素材比例完整展示，并让 Canvas Agent 明确知道自己已位于当前画布。

**Architecture:** 复用 `DesignAsset` 已持久化的宽高，通过现有 Canvas LOAD 快照传到 Renderer，并由统一纯函数计算节点高度和 Handle 中点。Canvas Agent 场景通过主进程单次运行扩展追加到系统提示词，保持用户消息、普通 Agent 和 Design Job 不变。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、XYFlow、BDD 风格 Bun tests

---

### Task 1: 传递图片尺寸并计算节点比例

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.ts`
- Modify: `apps/electron/src/renderer/components/design/native-canvas-model.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
expect(snapshot.imagePreviews).toEqual([{
  assetId: 'asset-a',
  previewUrl: 'proma-file://thumbnails-0/asset-a.webp',
  width: 1600,
  height: 900,
}])

expect(resolveNativeCanvasImageNodeHeight({ width: 900, height: 1600 })).toBe(368)
expect(resolveNativeCanvasImageNodeHeight({ width: 1, height: 100 })).toBe(368)
expect(resolveNativeCanvasImageNodeHeight({ width: 0, height: 100 })).toBe(144)
```

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts`

Expected: FAIL because preview dimensions and ratio height calculation do not exist.

- [ ] **Step 3: Implement the minimal metadata and projection changes**

```ts
export interface CanvasImagePreview {
  assetId: string
  previewUrl: string
  width: number
  height: number
}

export function resolveNativeCanvasImageNodeHeight(preview?: Pick<CanvasImagePreview, 'width' | 'height'>): number {
  if (!preview || !Number.isFinite(preview.width) || !Number.isFinite(preview.height)
    || preview.width <= 0 || preview.height <= 0) return NATIVE_CANVAS_NODE_HEIGHT
  const previewHeight = Math.min(320, Math.max(96, NATIVE_CANVAS_NODE_WIDTH * preview.height / preview.width))
  return 48 + previewHeight
}
```

Use the returned height for the image flow node and every connected Handle midpoint. Other node kinds remain `144`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts`

Expected: PASS.

### Task 2: 按投影高度渲染完整图片

**Files:**
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeCard.tsx`
- Modify: `apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
expect(html).toContain('height:210px')
expect(html).toContain('object-contain')
expect(imagePreviews.get('asset-a')).toEqual({
  previewUrl: 'proma-file://thumbnail/asset-a.webp', width: 1600, height: 900,
})
```

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: FAIL because the card is fixed at 144px and the workspace map drops dimensions.

- [ ] **Step 3: Implement the minimal Renderer changes**

Pass `nodeHeight` through `CanvasNodeCardData`, apply it to the wrapper and article inline style, and render previews with `h-full w-full object-contain`. Build a memoized asset-to-preview map from the snapshot without reading image files.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `bun test apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

Expected: PASS.

### Task 3: 注入 Canvas Agent 场景系统上下文

**Files:**
- Modify: `apps/electron/src/main/lib/agent-run-extensions.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
expect(run.extensions.systemPromptAppend).toContain('当前会话已经位于原生 Canvas')
expect(run.extensions.systemPromptAppend).toContain('不得要求用户创建或打开另一个')
expect(run.input.userMessage).toBe('创建五张人物动作图')
expect(run.input.rawUserMessage).toBe('创建五张人物动作图')
```

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts`

Expected: FAIL because the run extension cannot append system context yet.

- [ ] **Step 3: Implement the minimal system-context boundary**

```ts
export interface AgentRunExtensions {
  systemPromptAppend?: string
}

const canvasContext = `## 当前 Canvas 上下文\n- 当前会话已经位于原生 Canvas 的 Agent 节点。\n- 不得要求用户创建、打开或切换到另一个 Design/Canvas。`
```

Append the trusted block after the normal system prompt only for the validated Canvas run. Keep the user message unchanged and do not claim graph mutation capabilities.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts`

Expected: PASS.

### Task 4: 统一验证与记忆回写

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: Run focused regression tests**

Run: `bun test apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx packages/shared/src/types/canvas.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`

Expected: exit code 0.

- [ ] **Step 3: Run Electron smoke verification**

Open the existing development client, verify one horizontal and one portrait adopted image render without cropping, then send a visual request in a Canvas Agent and confirm it no longer asks to open Design/Canvas.

- [ ] **Step 4: Record the durable decision**

Append one concise dated bullet to `MEMORY.md`: Canvas image cards reuse persisted asset dimensions for bounded aspect-ratio layout, and Canvas Agent identity is injected as trusted per-run system context rather than user-message text.
