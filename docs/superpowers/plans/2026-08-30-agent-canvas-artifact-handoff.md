# Agent 画布产物联动实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通项目 Agent 能基于完整语义询问或直接创建 WebView/图片画布产物，并在成功后自动打开右侧画布定位节点。

**Architecture:** 复用现有 `AskUserQuestion` 处理歧义，不再由 Renderer 正则分流。新增 `CanvasArtifactCreationService`，先在受管目录准备完整内容，再用现有 Canvas batch 提交节点和可选连线；Renderer 只消费成功工具结果进行导航。

**Tech Stack:** Bun、TypeScript、Electron、Pi Agent Runtime、React、Jotai、TypeBox、Bun Test

---

### Task 1: 让受管内容 Store 支持初始产物正文

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-node-content-store.ts`
- Test: `apps/electron/src/main/lib/design/canvas-node-content-store.test.ts`

- [ ] **Step 1: 写入 WebView 与图片初始内容的失败测试**

在测试 fixture 中调用期望的新接口：

```ts
await fixture.store.prepareArtifactContent(target, {
  kind: 'webview',
  contentId: 'prototype-1',
  content: '<!doctype html><html><body>首页</body></html>',
})

await fixture.store.prepareArtifactContent(target, {
  kind: 'image',
  contentId: 'image-1',
  content: '安静克制的桌面 Agent 首页设计稿',
})
```

断言 `index.html` 和图片 `config.json.prompt` 保存真实内容；相同身份和内容可幂等重放，不同内容返回 `CANVAS_CONTENT_IDENTITY_CONFLICT`，超限正文在写盘前拒绝。

- [ ] **Step 2: 运行测试并确认因接口缺失失败**

Run: `bun test apps/electron/src/main/lib/design/canvas-node-content-store.test.ts`

Expected: FAIL，提示 `prepareArtifactContent` 不存在。

- [ ] **Step 3: 实现最小受管写入接口**

新增本地输入类型和中文注释：

```ts
export interface PrepareCanvasArtifactContentInput {
  kind: 'webview' | 'image'
  contentId: string
  content: string
  selectedModelProfileId?: string | null
}
```

复用现有 `writeManagedFile`、`ensureExactFile`、meta-last 和大小上限。WebView 将 `content` 写入 `index.html`；图片在 revision `0` 的 `config.json` 中初始化 `prompt`，保持现有比例、尺寸、上下文和模型默认值。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/electron/src/main/lib/design/canvas-node-content-store.test.ts`

Expected: PASS，且既有空内容、迁移、回收测试不回归。

- [ ] **Step 5: 提交内容 Store 变更**

```bash
git add apps/electron/src/main/lib/design/canvas-node-content-store.ts apps/electron/src/main/lib/design/canvas-node-content-store.test.ts
git commit -m "功能：支持画布产物初始内容写入"
```

### Task 2: 增加原子产物创建服务

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-artifact-creation.ts`
- Create: `apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts`

- [ ] **Step 1: 写正常路径、补偿和 revision 重试的失败测试**

以窄依赖构造服务，覆盖：

```ts
const result = await service.create({
  context,
  canvasId: 'canvas-1',
  baseRevision: 3,
  artifactType: 'webview',
  title: '首页原型',
  content: '<!doctype html><html><body>首页</body></html>',
  sourceNodeId: 'requirements-1',
  toolCallId: 'tool-artifact-1',
})
```

断言节点/内容 ID 由原始 `toolCallId` 稳定派生，默认位置在源节点右侧，连线只在 `sourceNodeId` 合法时创建；准备失败时 batch 零调用，batch 失败且权威图未引用内容时清理，图已提交时不得误清理。

- [ ] **Step 2: 运行测试确认服务缺失**

Run: `bun test apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts`

Expected: FAIL，模块或导出不存在。

- [ ] **Step 3: 实现服务及一次 revision 冲突重试**

服务公开窄接口：

```ts
export interface CanvasArtifactCreationService {
  create: (input: CanvasArtifactCreationInput) => Promise<CanvasArtifactCreationResult>
}
```

流程为 `load/validate -> prepareArtifactContent -> batch.execute`；首次 `CANVAS_REVISION_CONFLICT` 或 `CANVAS_BATCH_INTENT_PLAN_CONFLICT` 后权威重读并使用 `-retry` source ID 重试一次。最终失败时先重读图，只有目标节点不存在且内容未被引用才调用 `discardPreparedContent`。

- [ ] **Step 4: 运行服务测试确认通过**

Run: `bun test apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交原子服务**

```bash
git add apps/electron/src/main/lib/design/canvas-artifact-creation.ts apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts
git commit -m "功能：新增画布产物原子创建服务"
```

### Task 3: 将原子产物能力接入普通 Agent

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Test: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

- [ ] **Step 1: 写工具 schema、提示和生产注入的失败测试**

断言工具列表包含 `canvas_create_artifact`，plan 权限拒绝创建，未关联 Canvas 拒绝，合法调用返回 `canvasId/nodeId/revision/artifactType`。系统提示必须包含三个稳定选择：`创建 WebView 原型`、`创建图片设计稿`、`继续普通 Agent`，并明确“用户已指定画布产物时不重复询问”。

- [ ] **Step 2: 运行测试确认新工具尚未接入**

Run: `bun test apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

Expected: FAIL，工具或 `artifacts` 依赖不存在。

- [ ] **Step 3: 接入工具与生产服务**

在 `CanvasToolProviderDependencies` 增加：

```ts
artifacts: Pick<CanvasArtifactCreationService, 'create'>
```

工具使用 TypeBox 限制类型、标题、正文、坐标和来源节点；执行前复用 `authorizeRead`、`requireLinkedCanvas` 和 `runWrite`。`canvas-document-ipc.ts` 使用主进程唯一 `canvasNodeContentStore`、`canvasAgentBatchOperation` 和 `canvasDocumentStore` 创建服务，并注入 Provider，不新增 IPC 或依赖。

- [ ] **Step 4: 将 WebView 运行结果改为稳定 idle**

WebView 已由内容提交完成预览，不进入异步执行器：

```ts
taskByNodeId.set(node.id, { nodeId: node.id, status: 'idle' })
```

图片保持原有 `canvas_run_nodes` 审批、模型校验、任务 journal 和费用路径。

- [ ] **Step 5: 运行主进程相关测试确认通过**

Run: `bun test apps/electron/src/main/lib/design/canvas-node-content-store.test.ts apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交 Agent 工具接入**

```bash
git add apps/electron/src/main/lib/design/canvas-tool-provider.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts
git commit -m "功能：接入 Agent 画布产物创建工具"
```

### Task 4: 移除 Renderer 硬编码分流并自动定位产物

**Files:**
- Delete: `apps/electron/src/renderer/lib/agent-design-intent.ts`
- Delete: `apps/electron/src/renderer/lib/agent-design-intent.test.ts`
- Modify: `apps/electron/src/renderer/components/agent/AgentView.tsx`
- Modify: `apps/electron/src/renderer/components/agent/AgentView.canvas-reference.test.tsx`
- Create: `apps/electron/src/renderer/lib/agent-canvas-artifact-result.ts`
- Create: `apps/electron/src/renderer/lib/agent-canvas-artifact-result.test.ts`
- Modify: `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts`
- Modify: `apps/electron/src/renderer/hooks/global-agent-canvas-activity.test.ts`

- [ ] **Step 1: 写工具结果严格解析与导航失败测试**

解析器只接受成功工具返回的稳定公开字段：

```ts
parseCanvasArtifactToolResult(JSON.stringify({
  canvasId: 'canvas-1', nodeId: 'artifact-1', revision: 4, artifactType: 'webview',
}))
```

测试工具结果到达后为对应 `sessionId` 打开 `getCanvasWorkspaceTab(canvasId)`，并向 `navigateAgentCanvasViewAtom` 写入 `nodeId`；失败结果、损坏 JSON 和其它工具不导航。

- [ ] **Step 2: 运行 Renderer 测试确认失败**

Run: `bun test apps/electron/src/renderer/lib/agent-canvas-artifact-result.test.ts apps/electron/src/renderer/hooks/global-agent-canvas-activity.test.ts`

Expected: FAIL，解析器和导航处理尚不存在。

- [ ] **Step 3: 实现工具结果导航**

在全局 Agent listener 记录 `canvas_create_artifact` 的 `tool_start`，并在成功 `tool_result` 中解析公开结果。仅更新产出会话自己的右侧面板、Canvas tab 和待选节点，不切换全局 active tab，因此后台 Agent 不抢焦点。

- [ ] **Step 4: 删除旧 Design 正则弹窗链路**

从 `AgentView.tsx` 删除 `PendingDesignHandoff`、`designHandoffBypassPromptRef`、发送前 `shouldOfferDesignHandoff` 分支、旧弹窗和 `legacy-design` 预填处理；附件、引用、quoted selection 和普通发送逻辑保持原样。

- [ ] **Step 5: 运行 Renderer 回归测试**

Run: `bun test apps/electron/src/renderer/lib/agent-canvas-artifact-result.test.ts apps/electron/src/renderer/hooks/global-agent-canvas-activity.test.ts apps/electron/src/renderer/components/agent/AgentView.canvas-reference.test.tsx`

Expected: PASS。

- [ ] **Step 6: 提交 Renderer 联动**

```bash
git add apps/electron/src/renderer/components/agent/AgentView.tsx apps/electron/src/renderer/components/agent/AgentView.canvas-reference.test.tsx apps/electron/src/renderer/lib/agent-canvas-artifact-result.ts apps/electron/src/renderer/lib/agent-canvas-artifact-result.test.ts apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts apps/electron/src/renderer/hooks/global-agent-canvas-activity.test.ts
git add -u apps/electron/src/renderer/lib/agent-design-intent.ts apps/electron/src/renderer/lib/agent-design-intent.test.ts
git commit -m "优化：由 Agent 语义驱动画布产物联动"
```

### Task 5: 全链路验证与收尾

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: 运行完整相关测试**

Run: `bun test apps/electron/src/main/lib/design/canvas-node-content-store.test.ts apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/renderer/lib/agent-canvas-artifact-result.test.ts apps/electron/src/renderer/hooks/global-agent-canvas-activity.test.ts apps/electron/src/renderer/components/agent/AgentView.canvas-reference.test.tsx`

Expected: PASS，0 failures。

- [ ] **Step 2: 运行静态检查与构建**

Run: `bun run typecheck`

Expected: exit 0。

Run: `bun run build`

Expected: exit 0。

Run: `CLANG_MODULE_CACHE_PATH=/private/tmp/proma-clang-cache SWIFT_MODULE_CACHE_PATH=/private/tmp/proma-swift-cache bun run electron:build`

Expected: exit 0。

- [ ] **Step 3: 启动客户端并手动验证真实流程**

Run: `bun run dev`

验证：模糊“设计首页”出现 `AskUserQuestion`；选择 WebView 后创建含真实 HTML 的节点并自动打开画布；明确“在画布创建 WebView”不重复询问；图片节点预填 prompt 且只有点击/调用运行后才进入生图审批；普通“修改首页代码”继续走文件实现。

- [ ] **Step 4: 回写长期架构记忆并提交**

在 `MEMORY.md` 记录：普通 Agent 的画布产物意图由 Agent + `AskUserQuestion` 处理，Renderer 不做关键词路由；非空内容先准备、图后提交，工具结果只导航本会话右侧画布。

```bash
git add MEMORY.md
git commit -m "文档：记录 Agent 画布产物联动边界"
```
