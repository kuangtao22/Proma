# Design 项目创作上下文 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Design 内部 Agent 能按单次任务安全读取项目代码、业务资料和长期创作标准，并向用户展示真实引用、设计摘要与最终生图提示词。

**Architecture:** 把可移植的长期资料交给 `DesignContextCatalog`，把单次任务的访问策略、预算和审计交给 `DesignContextOrchestrator`。内部 Pi Agent 只获得项目范围内的专用只读工具和唯一可信图片工具；Renderer 只管理三态选择与上下文条目，不接触绝对路径、文件授权或预算判定。

**Tech Stack:** Bun、TypeScript、Electron IPC、Pi Agent Runtime、JSON/Markdown、React、Jotai、Radix/shadcn、BDD 风格 `bun:test`。

---

## 前置与范围

- 本计划依赖 `2026-08-24-design-task-transparency.md` 已完成：`DesignJobRecord` 已有 `creativeTaskId`、`contextMode`、`contextReferences`、`designSummary`、`finalImagePrompt`、trace 与任务详情能力。
- 本阶段把新任务默认上下文模式从第一阶段临时的 `none` 切换为 `auto`；旧任务继续按兼容读取规则展示，不重写历史 journal。
- 不给内部 Agent 注入通用 `Read`、`Grep`、`Find`、`Ls`、`Bash`、`Edit` 或 `Write`；只注入本计划定义的四个只读工具和一个可信图片工具。
- 不调用真实 Agent 或图片供应商。所有执行测试使用 fake Agent 与 fake image executor。
- 不实现 AI 漫剧批处理、分镜状态机或自动写入视觉标准；角色、故事、场景、连续性只是可复用上下文类别。

## 文件与职责

- `packages/shared/src/types/design.ts`：上下文类别、条目、manifest、三态模式、审计引用和 IPC 输入输出。
- `packages/shared/src/types/design.test.ts`：共享类型、通道唯一性和兼容默认值约束。
- `apps/electron/src/main/lib/design/design-paths.ts`：解析 `.proma/design/context/` 受管路径。
- `apps/electron/src/main/lib/design/design-paths.test.ts`：验证正式目录与缓存目录边界。
- `apps/electron/src/main/lib/design/design-context-catalog.ts`：原子管理 manifest、Markdown 文档和 Design asset 引用。
- `apps/electron/src/main/lib/design/design-context-catalog.test.ts`：目录置换、相对路径、引用删除和恢复测试。
- `apps/electron/src/main/lib/design/design-project-text-index.ts`：项目文本候选索引、敏感路径排除与稳定文件身份缓存。
- `apps/electron/src/main/lib/design/design-project-text-index.test.ts`：符号链接、敏感路径、增量失效和搜索测试。
- `apps/electron/src/main/lib/design/design-context-orchestrator.ts`：三态策略、文本预算、实际读取审计和工具定义。
- `apps/electron/src/main/lib/design/design-context-orchestrator.test.ts`：auto/project/none、预算与审计测试。
- `apps/electron/src/main/lib/design/design-job-manager.ts`：把上下文工具、结构化图片工具和结果字段接入现有 Job 状态机。
- `apps/electron/src/main/lib/design/design-job-manager.test.ts`：图片调用前阻断、精确提示词、摘要与引用持久化测试。
- `apps/electron/src/main/lib/design/design-asset-service.ts`：把上下文标准引用纳入素材删除保护。
- `apps/electron/src/main/lib/design/design-asset-service.test.ts`：标准引用和子版本删除保护测试。
- `apps/electron/src/main/lib/design/design-ipc.ts`：上下文库 IPC 运行时校验与项目写锁。
- `apps/electron/src/main/lib/design/design-ipc.test.ts`：四层契约主进程行为测试。
- `apps/electron/src/preload/design-preload.ts`：暴露窄 Design 上下文 API。
- `apps/electron/src/preload/design-preload.test.ts`：通道与参数透传测试。
- `apps/electron/src/renderer/lib/design-adapter.ts`：Renderer 唯一 Design API 适配入口。
- `apps/electron/src/renderer/lib/design-adapter.test.ts`：适配器方法完整性测试。
- `apps/electron/src/renderer/atoms/design-atoms.ts`：单项目上下文模式、目录加载和编辑状态。
- `apps/electron/src/renderer/atoms/design-atoms.test.ts`：项目隔离与默认 auto 测试。
- `apps/electron/src/renderer/components/design/DesignContextLibrary.tsx`：上下文条目浏览、搜索、编辑与删除界面。
- `apps/electron/src/renderer/components/design/DesignContextLibrary.test.tsx`：空、加载、失败、键盘和确认状态。
- `apps/electron/src/renderer/components/design/DesignInspector.tsx`：三态控件、采用为视觉标准和上下文库入口。
- `apps/electron/src/renderer/components/design/DesignInspector.test.tsx`：提交输入与视觉标准确认测试。

### Task 1: 建立共享上下文契约和受管路径

**Files:**
- Modify: `packages/shared/src/types/design.ts`
- Modify: `packages/shared/src/types/design.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-paths.ts`
- Modify: `apps/electron/src/main/lib/design/design-paths.test.ts`

- [ ] **Step 1: 写失败的共享契约与路径测试**

```ts
test('Given Design 上下文条目 When 序列化 Then 只包含稳定 ID、相对路径或 assetId', () => {
  const entry: DesignContextEntry = {
    id: 'context-brand',
    projectId: 'project-1',
    category: 'brand',
    kind: 'document',
    title: '品牌视觉规范',
    relativePath: 'documents/context-brand.md',
    tags: ['首页'],
    source: 'user',
    updatedAt: 10,
  }
  expect(entry.relativePath?.startsWith('/')).toBe(false)
  expect('absolutePath' in entry).toBe(false)
})

test('Given 已登记项目 When 解析 Design 路径 Then 上下文目录位于项目正式目录', () => {
  const paths = resolver.resolve('project-1')
  expect(paths.contextRoot).toBe(join(paths.designRoot, 'context'))
  expect(paths.contextManifestPath).toBe(join(paths.contextRoot, 'manifest.json'))
  expect(paths.contextDocumentsDir).toBe(join(paths.contextRoot, 'documents'))
  expect(paths.contextReferencesDir).toBe(join(paths.contextRoot, 'references'))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/shared/src/types/design.test.ts apps/electron/src/main/lib/design/design-paths.test.ts`

Expected: FAIL，提示上下文类型或 `contextRoot` 尚不存在。

- [ ] **Step 3: 增加完整共享类型和 IPC 通道**

```ts
export interface DesignContextEntry {
  id: string
  projectId: string
  category: DesignContextCategory
  kind: 'document' | 'asset'
  title: string
  relativePath?: string
  assetId?: string
  tags: string[]
  source: 'user' | 'design-asset'
  updatedAt: number
}

export interface DesignContextManifest {
  schemaVersion: 1
  projectId: string
  entries: DesignContextEntry[]
  updatedAt: number
}

export interface ListDesignContextInput { projectId: string; query?: string }
export interface UpsertDesignContextDocumentInput {
  projectId: string
  entryId?: string
  category: DesignContextCategory
  title: string
  tags: string[]
  markdown: string
}
export interface ImportDesignContextDocumentInput {
  projectId: string
  category: DesignContextCategory
  tags: string[]
}
export interface UpdateDesignContextEntryInput {
  projectId: string
  entryId: string
  category: DesignContextCategory
  title: string
  tags: string[]
}
export interface RegisterDesignContextAssetInput {
  projectId: string
  assetId: string
  category: DesignContextCategory
  title: string
  tags: string[]
}
export interface DeleteDesignContextInput { projectId: string; entryId: string }

export const DESIGN_IPC_CHANNELS = {
  // 既有通道保持不变
  LIST_CONTEXT: 'design:list-context',
  UPSERT_CONTEXT_DOCUMENT: 'design:upsert-context-document',
  IMPORT_CONTEXT_DOCUMENT: 'design:import-context-document',
  UPDATE_CONTEXT: 'design:update-context',
  REGISTER_CONTEXT_ASSET: 'design:register-context-asset',
  DELETE_CONTEXT: 'design:delete-context',
} as const
```

同时把 `CreateDesignJobInput.contextMode` 设为必填 `DesignContextMode`，不允许 Renderer 省略后由主进程猜测。

- [ ] **Step 4: 扩展 Design 路径解析结果**

```ts
export interface DesignPaths {
  // 既有字段保持不变
  contextRoot: string
  contextManifestPath: string
  contextDocumentsDir: string
  contextReferencesDir: string
}

const contextRoot = join(designRoot, 'context')
return {
  // 既有路径保持不变
  contextRoot,
  contextManifestPath: join(contextRoot, 'manifest.json'),
  contextDocumentsDir: join(contextRoot, 'documents'),
  contextReferencesDir: join(contextRoot, 'references'),
}
```

- [ ] **Step 5: 运行测试确认通过并提交**

Run: `bun test packages/shared/src/types/design.test.ts apps/electron/src/main/lib/design/design-paths.test.ts`

Expected: PASS。

```bash
git add packages/shared/src/types/design.ts packages/shared/src/types/design.test.ts apps/electron/src/main/lib/design/design-paths.ts apps/electron/src/main/lib/design/design-paths.test.ts
git commit -m "设计：建立项目创作上下文契约"
```

### Task 2: 原子管理项目创作上下文库

**Files:**
- Create: `apps/electron/src/main/lib/design/design-context-catalog.ts`
- Create: `apps/electron/src/main/lib/design/design-context-catalog.test.ts`

- [ ] **Step 1: 写失败的目录管理测试**

```ts
test('Given 空项目 When 新建 Markdown 上下文 Then 文档与 manifest 都写入受管目录', () => {
  const entry = catalog.upsertDocument({
    projectId: 'project-1', category: 'brand', title: '品牌规范', tags: ['官网'], markdown: '# Brand',
  })
  expect(entry.relativePath).toBe(`documents/${entry.id}.md`)
  expect(readFileSync(join(paths.contextRoot, entry.relativePath!), 'utf8')).toBe('# Brand')
  expect(catalog.list('project-1')).toEqual([entry])
})

test('Given 素材已登记为视觉标准 When 删除目录条目 Then 只删除 manifest 引用而不删除正式素材', () => {
  const entry = catalog.registerAsset({
    projectId: 'project-1', assetId: 'asset-1', category: 'reference', title: '首页色彩', tags: [],
  })
  catalog.delete('project-1', entry.id, { referencedByJobIds: [] })
  expect(assetExists('asset-1')).toBe(true)
})

test('Given 主进程选择 Markdown When 导入上下文 Then 复制到受管 documents 且不保存来源绝对路径', () => {
  const entry = catalog.importDocument({
    projectId: 'project-1', category: 'story', tags: ['第一章'], sourcePath: pickedMarkdownPath,
  })
  expect(entry.relativePath).toBe(`documents/${entry.id}.md`)
  expect(JSON.stringify(entry)).not.toContain(pickedMarkdownPath)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-context-catalog.test.ts`

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现严格 manifest 校验与空目录兼容**

```ts
const MANIFEST_VERSION = 1 as const

function createEmptyManifest(projectId: string, now: number): DesignContextManifest {
  return { schemaVersion: MANIFEST_VERSION, projectId, entries: [], updatedAt: now }
}

function isDesignContextManifest(value: unknown): value is DesignContextManifest {
  if (!isRecord(value) || value.schemaVersion !== MANIFEST_VERSION || typeof value.projectId !== 'string') return false
  return Array.isArray(value.entries) && value.entries.every(isDesignContextEntry)
    && typeof value.updatedAt === 'number'
}
```

读取使用 `readJsonFileSafe` 的 validator；创建目录使用 `ensureDirectoryDurable`；manifest、Markdown 分别使用 `writeJsonFileAtomic`、`writeTextFileAtomic`。Markdown 更新顺序固定为“先写文档，后写 manifest”，删除使用 `removeFileAtomic`，失败时不把条目从 manifest 移除。

- [ ] **Step 4: 实现受控增删改查**

```ts
export interface DesignContextCatalogContract {
  list: (projectId: string, query?: string) => DesignContextEntry[]
  readDocument: (projectId: string, entryId: string) => string
  upsertDocument: (input: UpsertDesignContextDocumentInput) => DesignContextEntry
  importDocument: (input: ImportDesignContextDocumentInput & { sourcePath: string }) => DesignContextEntry
  updateMetadata: (input: UpdateDesignContextEntryInput) => DesignContextEntry
  registerAsset: (input: RegisterDesignContextAssetInput) => DesignContextEntry
  delete: (projectId: string, entryId: string, referencedByJobIds: readonly string[]) => void
  isAssetReferenced: (projectId: string, assetId: string) => boolean
}
```

实现时必须满足：ID 只由主进程生成；标题 1-120 字符；标签去空、去重且最多 20 个；Markdown 最大 256 KiB；文档路径固定为 `documents/<entryId>.md`；asset 条目只保存 `assetId`；任何绝对路径、`..` 或符号链接都拒绝。`importDocument()` 只接收主进程文件选择器返回的 `.md` 普通文件，读取前后复验身份并把内容复制到受管目录，manifest 永不保存来源路径。`updateMetadata()` 只修改标题、类别和标签，不改变 kind、relativePath、assetId 或 source。

- [ ] **Step 5: 补齐损坏、置换和引用测试**

增加 BDD 测试覆盖：manifest 主文件损坏时读取 `.tmp/.bak`；manifest 项目 ID 不匹配时拒绝；文档被符号链接置换时拒绝；被任务审计引用的条目不能删除；同 ID 重复更新不产生第二个文件。

- [ ] **Step 6: 运行测试并提交**

Run: `bun test apps/electron/src/main/lib/design/design-context-catalog.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/design/design-context-catalog.ts apps/electron/src/main/lib/design/design-context-catalog.test.ts
git commit -m "设计：实现创作上下文库原子管理"
```

### Task 3: 建立敏感路径排除和增量文本索引

**Files:**
- Create: `apps/electron/src/main/lib/design/design-project-text-index.ts`
- Create: `apps/electron/src/main/lib/design/design-project-text-index.test.ts`

- [ ] **Step 1: 写失败的安全索引测试**

```ts
test('Given 项目含源码和敏感文件 When 建立索引 Then 只返回允许的普通文本文件', () => {
  write('src/App.tsx', 'export function App() {}')
  write('.env', 'SECRET=x')
  write('node_modules/pkg/index.js', 'ignored')
  symlink(outsideSecret, 'src/secret-link')
  const entries = index.search('project-1', 'App')
  expect(entries.map((entry) => entry.relativePath)).toEqual(['src/App.tsx'])
})

test('Given 已缓存文件发生变化 When 再次搜索 Then 只失效该文件身份', () => {
  const first = index.search('project-1', 'old')
  replaceFile('src/App.tsx', 'new content')
  expect(index.search('project-1', 'new')[0]?.identity).not.toBe(first[0]?.identity)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-project-text-index.test.ts`

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现固定排除规则和文件身份**

```ts
const EXCLUDED_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo',
])
const SENSITIVE_BASENAME_PATTERNS = [
  /^\.env(?:\.|$)/i, /credential/i, /secret/i, /private[-_.]?key/i,
]

export interface DesignProjectTextEntry {
  relativePath: string
  byteSize: number
  modifiedAt: number
  identity: string
}
```

目录遍历必须 `lstat` no-follow；候选 realpath 必须仍在已授权 `projectRoot`；只接受普通文件、单链接文件和可识别文本扩展名；`.proma/design/context` 由 Catalog 工具读取，不重复进入项目代码索引。

- [ ] **Step 4: 实现按 projectId 缓存和受限搜索**

```ts
export interface DesignProjectTextIndexContract {
  list: (projectId: string, relativeDirectory?: string) => DesignProjectTextEntry[]
  search: (projectId: string, query: string, limit?: number) => DesignProjectTextEntry[]
  read: (projectId: string, relativePath: string, maxBytes: number) => string
  invalidate: (projectId: string, relativePath?: string) => void
}
```

搜索 query 限制 1-200 字符，结果最多 50 条；索引只缓存相对路径、mtime、大小与 `dev:ino` 身份，不缓存完整文件内容。读取前后复验身份和大小，变化时拒绝本次结果并失效缓存。

- [ ] **Step 5: 运行安全与增量测试并提交**

Run: `bun test apps/electron/src/main/lib/design/design-project-text-index.test.ts`

Expected: PASS，并证明 `.env`、私钥、越权符号链接、依赖目录和构建产物均不进入结果。

```bash
git add apps/electron/src/main/lib/design/design-project-text-index.ts apps/electron/src/main/lib/design/design-project-text-index.test.ts
git commit -m "设计：增加项目文本安全索引"
```

### Task 4: 把三态策略、预算和审计封装为专用 Pi 工具

**Files:**
- Create: `apps/electron/src/main/lib/design/design-context-orchestrator.ts`
- Create: `apps/electron/src/main/lib/design/design-context-orchestrator.test.ts`
- Modify: `apps/electron/src/main/lib/agent-run-extensions.ts`

- [ ] **Step 1: 写失败的三态和预算测试**

```ts
test('Given none 模式 When Agent 请求项目文件 Then 拒绝且不产生审计引用', async () => {
  const run = orchestrator.createRun({ projectId: 'project-1', mode: 'none' })
  expect(run.tools).toEqual([])
  expect(run.getReferences()).toEqual([])
})

test('Given project 模式且没有可用资料 When 预检 Then 在图片调用前失败', () => {
  expect(() => orchestrator.createRun({ projectId: 'project-empty', mode: 'project' }))
    .toThrow('当前项目没有可用的创作上下文')
})

test('Given 读取超过累计预算 When 再读文件 Then 返回截断结果并保留已读引用', async () => {
  const run = orchestrator.createRun({ projectId: 'project-1', mode: 'auto' })
  await execute(run.tools, 'design_read_project_file', { relativePath: 'a.md' })
  const result = await execute(run.tools, 'design_read_project_file', { relativePath: 'b.md' })
  expect(result.details).toMatchObject({ truncated: true, reason: 'total-bytes' })
  expect(run.getWarnings()).toContain('项目文本累计读取已达到 512 KiB 上限')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-context-orchestrator.test.ts`

Expected: FAIL，提示 orchestrator 不存在。

- [ ] **Step 3: 定义单次运行审计和预算合同**

```ts
const MAX_TEXT_FILES = 24
const MAX_FILE_BYTES = 64 * 1024
const MAX_TOTAL_TEXT_BYTES = 512 * 1024

export interface DesignContextRun {
  tools: ToolDefinition[]
  allowedToolNames: readonly string[]
  getReferences: () => DesignContextReference[]
  getWarnings: () => string[]
  assertReadyForImageCall: () => void
}
```

`AgentRunExtensions` 在本阶段新增：

```ts
export interface AgentRunExtensions {
  // 第一阶段已有字段保持不变
  beforeToolCall?: (toolName: string, input: Readonly<Record<string, unknown>>) => void
  captureDesignImageCall?: (input: { designSummary: string; prompt: string }) => void
}
```

`agent-orchestrator.ts` 在工具调用 limiter 通过后、真实工具执行前调用 `beforeToolCall`，错误转换为 deny 结果。Design 用它在图片工具入口执行 `assertReadyForImageCall()`，从而保证 `project` 模式预检失败、显式项目依赖缺失或预算后信息不足时不产生付费调用。`captureDesignImageCall` 由可信图片工具在参数 schema 验证后、executor 调用前同步执行。

- [ ] **Step 4: 实现四个只读工具**

```ts
const toolNames = [
  'design_list_project_files',
  'design_search_project_text',
  'design_read_project_file',
  'design_read_context_entry',
] as const
```

每个工具都返回简短文本和结构化 `details`；成功读取时由主进程追加唯一审计引用。目录和搜索仅返回元数据，不计文本预算；两个 read 工具按解码后 UTF-8 字节数计预算。重复读取同一文件只计一个不同文件，但每次返回的字节仍计入累计预算，防止循环调用放大上下文。

- [ ] **Step 5: 实现 auto/project/none 策略**

- `none`：不提供四个上下文工具，图片工具仍可使用本次显式附件。
- `auto`：提供四个工具；没有读取不构成错误；若原始要求明确包含当前项目、沿用、继续角色等依赖而所有相关读取失败，`assertReadyForImageCall()` 阻断。
- `project`：创建 run 时先检查索引或 Catalog 至少有一个候选；没有候选、项目离线或授权失败立即抛错；图片调用前必须至少有一个成功读取引用。

- [ ] **Step 6: 运行测试并提交**

Run: `bun test apps/electron/src/main/lib/design/design-context-orchestrator.test.ts apps/electron/src/main/lib/agent-run-tool-policy.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/design/design-context-orchestrator.ts apps/electron/src/main/lib/design/design-context-orchestrator.test.ts apps/electron/src/main/lib/agent-run-extensions.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-orchestrator.test.ts
git commit -m "设计：限制内部 Agent 上下文工具与预算"
```

### Task 5: 把上下文审计、设计摘要和精确提示词接入 Job

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.test.ts`
- Modify: `apps/electron/src/main/lib/agent-run-extensions.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.test.ts`
- Modify: `apps/electron/src/main/lib/chat-tools/nano-banana-mcp.ts`
- Modify: `apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts`

- [ ] **Step 1: 写失败的 Job 集成测试**

```ts
test('Given auto 模式生成当前项目首页 When Agent 读取源码并调用图片工具 Then journal 保存真实引用和工具入参', async () => {
  fakeAgent.execute = async (extensions) => {
    await callTool(extensions, 'design_search_project_text', { query: '首页' })
    await callTool(extensions, 'design_read_project_file', { relativePath: 'src/App.tsx' })
    await callTool(extensions, DESIGN_IMAGE_TOOL, {
      designSummary: '保留现有导航和主要业务入口，重组首屏视觉层级。',
      prompt: 'Desktop SaaS homepage showing the real Proma workspace...',
    })
  }
  await manager.run(job.id)
  expect(manager.get(job.id)).toMatchObject({
    contextReferences: [{ relativePath: 'src/App.tsx' }],
    designSummary: '保留现有导航和主要业务入口，重组首屏视觉层级。',
    finalImagePrompt: 'Desktop SaaS homepage showing the real Proma workspace...',
  })
})

test('Given project 模式没有可用资料 When 运行 Then 图片 executor 调用次数为零', async () => {
  await manager.run(job.id)
  expect(imageExecutorCalls).toBe(0)
  expect(manager.get(job.id)?.status).toBe('failed')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts`

Expected: FAIL，Job 尚未注入上下文工具或捕获结构化字段。

- [ ] **Step 3: 扩展 Design 专用图片工具参数**

在可信路由存在时要求以下参数：

```ts
interface TrustedDesignImageArguments {
  designSummary: string
  prompt: string
  referenceImages?: string[]
  aspectRatio?: string
  imageSize?: string
}
```

`designSummary` 限制 1-4000 字符；`prompt` 限制 1-16000 字符。`agent-orchestrator.ts` 把 extension hook 继续传入 `buildPiBuiltinTools()`，可信工具执行前调用主进程注入的 `captureDesignImageCall({ designSummary, prompt })`，journal 中的 `finalImagePrompt` 必须来自这里，禁止从 assistant 文本或原用户请求重建。

- [ ] **Step 4: 在 Job run 中组装上下文扩展**

```ts
const contextRun = this.dependencies.contextOrchestrator.createRun({
  projectId: running.projectId,
  mode: running.contextMode,
  originalRequest: running.originalRequest,
})
let imageCall: { designSummary: string; prompt: string } | undefined

const extensions: AgentRunExtensions = {
  piCustomTools: contextRun.tools,
  allowedToolNames: [...contextRun.allowedToolNames, DESIGN_IMAGE_TOOL],
  toolCallLimits: { [DESIGN_IMAGE_TOOL]: 1 },
  beforeToolCall: (toolName) => {
    if (toolName === DESIGN_IMAGE_TOOL) contextRun.assertReadyForImageCall()
  },
  captureDesignImageCall: (value) => { imageCall = value },
  trustedImageRoute: running.imageModelSnapshot,
  resolveTrustedImageRoute: existingResolver,
}
```

图片工具完成或 Agent 终止时，把 `contextRun.getReferences()` 写入 `contextReferences`，把 `getWarnings().join('\n') || undefined` 写入第一阶段的 `contextWarning`，并把 `imageCall` 写入设计摘要和最终提示词。若图片成功而后续审计写入失败，沿用第一阶段规则保持 `succeeded`，仅把 trace 标为待恢复。

- [ ] **Step 5: 更新系统提示词但不写死项目类型**

`buildPrompt()` 明确要求 Agent：先理解视觉目标；按任务选择品牌、产品、代码、角色、故事、场景、连续性或参考资料；只读取必要信息；用中文形成设计摘要；以图片模型可执行的精确提示词调用一次图片工具。禁止根据“开发/平面/漫剧”预设固定流程。

项目指令继续通过 `project-instruction-resolver.ts` 对 `DesignPaths.projectRoot` 显式调用 `resolveProjectInstructions({ projectRoot })`，将返回来源注入内部 Agent prompt。增加测试证明不会从 Agent cwd、项目祖先、attachedDirectories 或其他项目发现规则；专用 read 工具访问子路径时也不自行扫描额外 `AGENTS.md`。

- [ ] **Step 6: 运行测试并提交**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts`

Expected: PASS，fake executor 证明所有前置失败路径调用次数为 0。

```bash
git add apps/electron/src/main/lib/design/design-job-manager.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/agent-run-extensions.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/chat-tools/nano-banana-mcp.ts apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts
git commit -m "设计：接入上下文审计和精确生图提示词"
```

### Task 6: 打通上下文库 IPC 四层契约

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/design-ipc.test.ts`
- Modify: `apps/electron/src/preload/design-preload.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写失败的 IPC 与 preload 测试**

```ts
test('Given 上下文写请求 When 调用 IPC Then 校验字段并进入项目写锁', async () => {
  await invoke(handlers, DESIGN_IPC_CHANNELS.UPSERT_CONTEXT_DOCUMENT, sender, {
    projectId: 'project-1', category: 'brand', title: '品牌', tags: [], markdown: '# Brand',
  })
  expect(guardProjects).toContain('project-1')
  expect(catalogInputs[0]).toMatchObject({ category: 'brand', title: '品牌' })
})

test('Given Renderer API When 调用上下文方法 Then 只透传结构化 Design 参数', async () => {
  await api.listDesignContext({ projectId: 'p1', query: 'brand' })
  await api.importDesignContextDocument({ projectId: 'p1', category: 'brand', tags: [] })
  await api.updateDesignContext({ projectId: 'p1', entryId: 'context-1', category: 'brand', title: '品牌', tags: [] })
  await api.deleteDesignContext({ projectId: 'p1', entryId: 'context-1' })
  expect(invokes).toEqual([
    { channel: DESIGN_IPC_CHANNELS.LIST_CONTEXT, args: [{ projectId: 'p1', query: 'brand' }] },
    { channel: DESIGN_IPC_CHANNELS.IMPORT_CONTEXT_DOCUMENT, args: [{ projectId: 'p1', category: 'brand', tags: [] }] },
    { channel: DESIGN_IPC_CHANNELS.UPDATE_CONTEXT, args: [{ projectId: 'p1', entryId: 'context-1', category: 'brand', title: '品牌', tags: [] }] },
    { channel: DESIGN_IPC_CHANNELS.DELETE_CONTEXT, args: [{ projectId: 'p1', entryId: 'context-1' }] },
  ])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: FAIL，通道或方法尚未注册。

- [ ] **Step 3: 在 main handler 做严格运行时校验**

新增 `parseListDesignContextInput`、`parseUpsertDesignContextDocumentInput`、`parseImportDesignContextDocumentInput`、`parseUpdateDesignContextEntryInput`、`parseRegisterDesignContextAssetInput`、`parseDeleteDesignContextInput`。只允许共享类型声明的键；类别使用固定枚举；Renderer 不能发送 `sourcePath`、`relativePath`、绝对路径、source 或 updatedAt。IMPORT handler 先由 `pickMarkdownFile(sender)` 选择单个文件，用户取消时返回 `undefined` 且不改 manifest。

读请求直接调用 catalog；写请求统一包在 `guard.runWorkspaceWrite(projectId, effect)` 内。上下文变化通过 `DESIGN_IPC_CHANNELS.CHANGED` 广播 `{ projectId, revision, cause: 'context' }`，并把 `DesignChangeEvent.cause` 扩展为包含 `context`。

- [ ] **Step 4: 同步 preload 和 renderer adapter**

```ts
export interface DesignPreloadApi {
  // 既有方法保持不变
  listDesignContext: (input: ListDesignContextInput) => Promise<DesignContextEntry[]>
  upsertDesignContextDocument: (input: UpsertDesignContextDocumentInput) => Promise<DesignContextEntry>
  importDesignContextDocument: (input: ImportDesignContextDocumentInput) => Promise<DesignContextEntry | undefined>
  updateDesignContext: (input: UpdateDesignContextEntryInput) => Promise<DesignContextEntry>
  registerDesignContextAsset: (input: RegisterDesignContextAssetInput) => Promise<DesignContextEntry>
  deleteDesignContext: (input: DeleteDesignContextInput) => Promise<void>
}
```

`DesignAdapter` 一对一暴露同名方法，缺失时继续由 `requireMethod` 抛出稳定集成错误。

- [ ] **Step 5: 运行四层测试并提交**

Run: `bun test apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts packages/shared/src/types/design.test.ts`

Expected: PASS。

```bash
git add packages/shared/src/types/design.ts packages/shared/src/types/design.test.ts apps/electron/src/main/lib/design/design-ipc.ts apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "设计：打通创作上下文 IPC"
```

### Task 7: 增加三态控件、上下文库和视觉标准确认

**Files:**
- Modify: `apps/electron/src/renderer/atoms/design-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/design-atoms.test.ts`
- Create: `apps/electron/src/renderer/components/design/DesignContextLibrary.tsx`
- Create: `apps/electron/src/renderer/components/design/DesignContextLibrary.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.test.tsx`

- [ ] **Step 1: 写失败的 Jotai 与 UI 测试**

```ts
test('Given 新 Design 项目 When 创建状态 Then 默认上下文模式为 auto', () => {
  expect(createInitialDesignProjectState().contextMode).toBe('auto')
})

test('Given 用户选择不使用项目 When 提交任务 Then CreateDesignJobInput 携带 none', () => {
  const input = createDesignGenerationJobInput('project-1', '极简海报', '1:1', '2K', 'profile-1', { x: 0, y: 0 }, 'none')
  expect(input.contextMode).toBe('none')
})

test('Given 成功素材 When 点击采用为视觉标准 Then 先显示类别和名称确认且不立即写入', async () => {
  render(<DesignContextLibrary {...props} candidateAsset={asset} />)
  await user.click(screen.getByRole('button', { name: '采用为视觉标准' }))
  expect(api.registerDesignContextAsset).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: '采用为视觉标准' })).toBeVisible()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/DesignContextLibrary.test.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx`

Expected: FAIL，状态和组件尚不存在。

- [ ] **Step 3: 扩展每项目 Jotai 状态**

```ts
export interface DesignProjectState {
  // 既有字段保持不变
  contextMode: DesignContextMode
  contextEntries: DesignContextEntry[]
  contextLoadState: 'idle' | 'loading' | 'ready' | 'failed'
  contextError: string | null
  contextLibraryOpen: boolean
}
```

初始值固定为 `auto`、空条目和关闭面板；所有更新继续经 `updateDesignProjectStateAtom` 按 projectId 隔离。

- [ ] **Step 4: 在 AI 表单增加三态 segmented control**

使用现有 Tabs/ToggleGroup primitive 呈现 `自动`、`使用项目`、`不使用项目`，并提供短 tooltip：自动按任务读取、强制读取项目、仅用本次要求和附件。控件放在模型选择之后、描述输入之前；提交按钮布局高度保持稳定，长文案在窄 Inspector 换行而不溢出。

`createDesignGenerationJobInput` 与 `createDesignEditJobInput` 都新增 `contextMode` 参数并原样进入共享输入；不再把此字段编码进 prompt。

- [ ] **Step 5: 实现上下文库管理界面**

`DesignContextLibrary` 使用未嵌套的侧栏/Sheet 布局，包含搜索、类别筛选、条目列表、新建/导入 Markdown、元数据编辑对话框和删除确认。导入按钮只调用主进程 picker，不接收或显示绝对路径；文档和 asset 条目都可编辑标题、类别和标签。条目采用紧凑行，不使用卡片套卡片；加载、空、错误和保存中状态都有固定高度区域。删除错误直接显示主进程的“被任务引用”或“素材仍被引用”原因。

- [ ] **Step 6: 实现采用为视觉标准确认**

成功素材详情显示 `采用为视觉标准`。点击后打开 AlertDialog/Form，要求用户选择类别、填写名称和可选标签；确认才调用 `registerDesignContextAsset`。失败、取消、运行中任务和普通缺失素材不显示该动作。

- [ ] **Step 7: 运行 UI 测试并提交**

Run: `bun test apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/DesignContextLibrary.test.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx apps/electron/src/renderer/components/design/design-accessibility.test.tsx`

Expected: PASS，覆盖键盘焦点、明暗主题 class、长标题、加载、空和失败状态。

```bash
git add apps/electron/src/renderer/atoms/design-atoms.ts apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/DesignContextLibrary.tsx apps/electron/src/renderer/components/design/DesignContextLibrary.test.tsx apps/electron/src/renderer/components/design/DesignInspector.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx
git commit -m "设计：增加上下文模式和创作资料库界面"
```

### Task 8: 保护引用删除并完成第二阶段验收

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-asset-service.ts`
- Modify: `apps/electron/src/main/lib/design/design-asset-service.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts`
- Modify: `apps/electron/src/main/lib/design/design-recovery.test.ts`

- [ ] **Step 1: 写失败的素材引用保护测试**

```ts
test('Given 素材是视觉标准 When 删除素材 Then 在 revision 变更前拒绝', () => {
  contextCatalog.isAssetReferenced = () => true
  expect(() => service.deleteAsset('project-1', 'asset-1', 3)).toThrow('素材仍被视觉标准引用')
  expect(store.mutate).not.toHaveBeenCalled()
})

test('Given 素材存在子版本 When 删除父素材 Then 在 revision 变更前拒绝', () => {
  document.assets.push({ ...child, parentAssetId: 'asset-1' })
  expect(() => service.deleteAsset('project-1', 'asset-1', 3)).toThrow('素材仍被后续版本引用')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/design/design-asset-service.test.ts`

Expected: FAIL，当前删除只检查画布节点。

- [ ] **Step 3: 在权威文档和 Catalog 上统一检查引用**

`deleteAsset()` 在 `store.mutate` 前依次检查：画布节点引用、`assets[].parentAssetId` 子版本引用、Catalog asset 条目引用。任何一项存在都拒绝，不改变 revision、不删除文件、不清理来源 Job。合法删除成功后再调用第一阶段的任务/trace 清理入口。

- [ ] **Step 4: 增加恢复与兼容测试**

覆盖旧 Job 无 `contextMode` 时读取为第一阶段定义的 `none`；新 Job 默认从 Renderer 显式传 `auto`；上下文读取失败不触发恢复期自动生图；Catalog manifest 损坏不影响画布加载，但 `project` 模式生成会在图片前失败。

- [ ] **Step 5: 运行第二阶段定向测试**

Run:

```bash
bun test packages/shared/src/types/design.test.ts \
  apps/electron/src/main/lib/design/design-paths.test.ts \
  apps/electron/src/main/lib/design/design-context-catalog.test.ts \
  apps/electron/src/main/lib/design/design-project-text-index.test.ts \
  apps/electron/src/main/lib/design/design-context-orchestrator.test.ts \
  apps/electron/src/main/lib/design/design-job-manager.test.ts \
  apps/electron/src/main/lib/design/design-asset-service.test.ts \
  apps/electron/src/main/lib/design/design-recovery.test.ts \
  apps/electron/src/main/lib/design/design-ipc.test.ts \
  apps/electron/src/preload/design-preload.test.ts \
  apps/electron/src/renderer/lib/design-adapter.test.ts \
  apps/electron/src/renderer/atoms/design-atoms.test.ts \
  apps/electron/src/renderer/components/design/DesignContextLibrary.test.tsx \
  apps/electron/src/renderer/components/design/DesignInspector.test.tsx
```

Expected: PASS；测试替身记录图片 executor 调用，所有预检失败、恢复和只打开 UI 的路径均为 0 次。

- [ ] **Step 6: 运行类型检查和 Electron 构建**

Run: `bun run typecheck`

Expected: PASS，无 `any`、未处理联合类型或 preload/window 类型缺口。

Run: `bun run electron:build`

Expected: PASS，Pi custom tools、主进程 Node API 和 Renderer bundle 边界正确。

- [ ] **Step 7: 检查性能与安全不变量并提交**

用测试计数器确认：普通 Agent/Chat 初始化次数不增加；Design 画布首帧不扫描项目；只有提交任务或打开上下文库才构建索引；24 文件、64 KiB 单文件、512 KiB 总量上限均在主进程执行；trace 不包含完整项目文件或敏感配置值。

```bash
git add packages/shared/src/types/design.ts apps/electron/src/main/lib/design apps/electron/src/preload/design-preload.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/atoms/design-atoms.ts apps/electron/src/renderer/components/design
git commit -m "设计：完成项目创作上下文安全验收"
```

## 第二阶段完成条件

- Design 直接提交默认使用 `auto`，用户可明确选择 `project` 或 `none`。
- 请求“生成当前项目首页”时，fake Agent 能通过专用工具读取真实项目片段并留下审计引用。
- 平面设计、角色和场景任务按条目类别与语义读取，不依赖固定项目类型。
- `.env`、私钥、依赖目录、构建产物和越权符号链接不会被发现、读取或记录。
- 最终提示词与设计摘要来自真实图片工具调用参数；上下文引用来自真实只读工具审计。
- 用户确认前，任何结果都不会自动成为长期视觉标准。
- 视觉标准或子版本引用存在时，素材删除在画布 revision 变化前被拒绝。
- 所有定向测试、`bun run typecheck` 和 `bun run electron:build` 通过。
