# 设计页生图模型选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个设计项目选择并持久化自己的生图模型，Design Job 固化模型快照，先由现有 Agent LLM 理解任务，再由主进程强制 Nano Banana 使用该快照对应的 Gemini 图片模型。

**Architecture:** 新增主进程生图模型目录与项目偏好服务，分别持久化到 `~/.proma/image-generation-models.json` 和 `~/.proma/design-cache/<project-id>/preferences.json`。Renderer 只能提交稳定 profile ID；Design Job 在创建时解析并固化完整快照，通过仅主进程可见的运行扩展传给 Pi 图片工具，并在真正调用 Gemini 前再次验证配置和凭据。Inspector 只在现有 `AI 编辑` 紧凑表单顶部增加模型选择字段，系统设置继续复用现有工具设置视觉结构。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Jotai、Radix Select、shadcn primitives、Tailwind CSS、Pi Agent Runtime、BDD 风格 `bun:test`。

---

## 文件与职责

- `packages/shared/src/types/design.ts`：定义模型 profile、清洗选项、项目选择、任务快照和 Design IPC 契约。
- `packages/shared/src/types/design.test.ts`：锁定旧任务兼容、任务输入和稳定 IPC 常量。
- `apps/electron/src/main/lib/config-paths.ts`：只负责返回模型目录配置路径。
- `apps/electron/src/main/lib/image-generation-model-catalog.ts`：模型目录唯一事实、旧配置惰性兼容、可用性校验和运行快照复核。
- `apps/electron/src/main/lib/image-generation-model-catalog.test.ts`：覆盖旧配置、损坏文件、凭据、启停和安全清洗。
- `apps/electron/src/main/lib/design/design-paths.ts`：补充项目偏好文件的可信路径。
- `apps/electron/src/main/lib/design/design-image-model-preferences.ts`：项目级模型选择的原子持久化与变更订阅。
- `apps/electron/src/main/lib/design/design-image-model-preferences.test.ts`：覆盖项目隔离、重启恢复、无效偏好和写入失败。
- `apps/electron/src/main/lib/design/design-ipc.ts`：注册模型目录与项目偏好的受控 IPC，校验创建任务只接收 profile ID。
- `apps/electron/src/main/lib/design/design-ipc.test.ts`：覆盖伪造 ID、广播和无副作用拒绝。
- `apps/electron/src/preload/design-preload.ts`、`apps/electron/src/renderer/lib/design-adapter.ts`：透传模型目录、选择和变更事件，不暴露凭据。
- `apps/electron/src/preload/design-preload.test.ts`、`apps/electron/src/renderer/lib/design-adapter.test.ts`：锁定四层 IPC 参数与返回值。
- `apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.tsx`：Nano Banana 多模型配置列表。
- `apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.test.tsx`：覆盖配置列表、空态、禁用和稳定字段。
- `apps/electron/src/renderer/components/settings/ToolSettings.tsx`：保留 API Key/Base URL/Chat 默认模型兼容，嵌入多模型配置列表。
- `apps/electron/src/main/lib/design/design-job-manager.ts`：创建任务时固化快照、旧 journal 只读兼容、重试复制原快照。
- `apps/electron/src/main/lib/design/design-job-manager.test.ts`：覆盖快照、重试、配置失效和 Agent 前置失败。
- `apps/electron/src/main/lib/agent-run-extensions.ts`：集中定义仅主进程使用的可信图片路由。
- `apps/electron/src/main/lib/agent-service.ts`、`apps/electron/src/main/lib/agent-orchestrator.ts`：把单次运行扩展传到 Pi 内置工具构建边界。
- `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`、`apps/electron/src/main/lib/chat-tools/nano-banana-mcp.ts`：把可信路由交给图片工具，并在工具执行时强制使用指定模型。
- `apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts`、`apps/electron/src/main/lib/agent-orchestrator.test.ts`：覆盖可信覆盖和普通 Agent 不受影响。
- `apps/electron/src/renderer/atoms/design-atoms.ts`：按项目缓存模型目录、选择和加载错误。
- `apps/electron/src/renderer/components/design/use-design-image-model-selection.ts`：加载项目选择、写入回滚和跨窗口刷新。
- `apps/electron/src/renderer/components/design/use-design-image-model-selection.test.ts`：覆盖项目切换、偏好写失败和广播收敛。
- `apps/electron/src/renderer/components/design/DesignInspector.tsx`：在 AI 编辑表单顶部渲染严格遵循现有视觉规范的 32px 模型选择器。
- `apps/electron/src/renderer/components/design/DesignInspector.test.tsx`：覆盖单模型、多模型、加载、无模型、失效和设置入口。
- `apps/electron/src/renderer/components/design/design-canvas-model.ts`、`apps/electron/src/renderer/components/design/DesignAssetNode.tsx`：任务节点显示固化的实际模型。

## Task 1: 锁定共享模型与任务契约

**Files:**
- Modify: `packages/shared/src/types/design.ts`
- Modify: `packages/shared/src/types/design.test.ts`

- [ ] **Step 1: 写失败测试，要求创建输入和任务记录携带不同信任级别的模型字段**

在 `packages/shared/src/types/design.test.ts` 增加编译期与运行期断言：

```ts
test('Given Design 模型契约 When 构建任务 Then Renderer 只提交 profile ID 且记录保存完整快照', () => {
  const input: CreateDesignJobInput = {
    projectId: 'project-1',
    action: 'generate',
    prompt: '生成海报',
    imageModelProfileId: 'profile-flash',
    position: { x: 0, y: 0 },
  }
  const snapshot: ImageGenerationModelSnapshot = {
    profileId: 'profile-flash',
    name: 'Nano Banana Flash',
    executor: 'nano-banana',
    modelId: 'gemini-3.1-flash-image-preview',
  }

  expect(input.imageModelProfileId).toBe('profile-flash')
  expect(snapshot.modelId).toBe('gemini-3.1-flash-image-preview')
  expect(DESIGN_IPC_CHANNELS.GET_IMAGE_MODEL_SELECTION).toBe('design:get-image-model-selection')
  expect(DESIGN_IPC_CHANNELS.IMAGE_MODEL_SELECTION_CHANGED).toBe('design:image-model-selection-changed')
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test packages/shared/src/types/design.test.ts`

Expected: FAIL，提示 `ImageGenerationModelSnapshot`、`imageModelProfileId` 或新 IPC 常量不存在。

- [ ] **Step 3: 增加完整共享类型和通道**

在 `packages/shared/src/types/design.ts` 增加：

```ts
export type ImageGenerationExecutor = 'nano-banana'

/** 系统设置中可持久化的非敏感生图模型配置。 */
export interface ImageGenerationModelProfile {
  id: string
  name: string
  executor: ImageGenerationExecutor
  modelId: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** Design Job 创建时固化的实际生图路由。 */
export interface ImageGenerationModelSnapshot {
  profileId: string
  name: string
  executor: ImageGenerationExecutor
  modelId: string
}

/** Renderer 可见的清洗模型选项，不包含凭据和配置路径。 */
export interface ImageGenerationModelOption extends ImageGenerationModelSnapshot {
  available: boolean
  unavailableReason?: string
}

export interface ImageGenerationModelCatalogResult {
  profiles: ImageGenerationModelProfile[]
  inheritedFromLegacyConfig: boolean
  credentialsConfigured: boolean
}

export interface SaveImageGenerationModelProfilesInput {
  profiles: ImageGenerationModelProfile[]
}

export interface DesignImageModelSelection {
  projectId: string
  options: ImageGenerationModelOption[]
  selectedProfileId?: string
  invalidSelectedProfileId?: string
}

export interface UpdateDesignImageModelSelectionInput {
  projectId: string
  imageModelProfileId: string
}

export interface DesignImageModelSelectionChangeEvent {
  projectId: string
}
```

同时向现有三个契约精确增加以下字段或通道；其余已有成员保持原顺序和行为：

```ts
// DesignJobRecord 新增
imageModelSnapshot?: ImageGenerationModelSnapshot

// CreateDesignJobInput 新增
imageModelProfileId: string

// DESIGN_IPC_CHANNELS 新增
LIST_IMAGE_MODEL_PROFILES: 'design:list-image-model-profiles',
SAVE_IMAGE_MODEL_PROFILES: 'design:save-image-model-profiles',
GET_IMAGE_MODEL_SELECTION: 'design:get-image-model-selection',
SET_IMAGE_MODEL_SELECTION: 'design:set-image-model-selection',
IMAGE_MODEL_PROFILES_CHANGED: 'design:image-model-profiles-changed',
IMAGE_MODEL_SELECTION_CHANGED: 'design:image-model-selection-changed',
```

`DesignJobRecord.imageModelSnapshot` 必须保持可选，以便旧 journal 可读；`CreateDesignJobInput.imageModelProfileId` 必须为必填，防止新任务绕过选择。

- [ ] **Step 4: 修正现有测试构造并确认 GREEN**

为所有测试中的新建任务输入补 `imageModelProfileId: 'profile-flash'`；旧 journal fixture 不补快照，用于后续兼容测试。

Run: `bun test packages/shared/src/types/design.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/components/design/DesignInspector.test.tsx`

Expected: PASS。

- [ ] **Step 5: 提交共享契约**

```bash
git add packages/shared/src/types/design.ts packages/shared/src/types/design.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/components/design/DesignInspector.test.tsx
git commit -m "设计：增加生图模型共享契约"
```

## Task 2: 实现系统生图模型目录与旧配置兼容

**Files:**
- Modify: `apps/electron/src/main/lib/config-paths.ts`
- Create: `apps/electron/src/main/lib/image-generation-model-catalog.ts`
- Create: `apps/electron/src/main/lib/image-generation-model-catalog.test.ts`

- [ ] **Step 1: 写模型目录 BDD 失败测试**

测试必须覆盖四个场景：配置文件不存在时合成 `legacy-nano-banana-default` 且不落盘；保存多个 profile 后原子恢复；API Key 缺失时选项不可用；损坏 JSON 或未知 schema 版本时明确抛错且原文件不变。

```ts
test('Given 旧 Nano Banana 单模型配置 When 首次读取目录 Then 合成默认项且不写文件', () => {
  const fixture = createCatalogFixture({ model: 'gemini-custom-image', apiKey: 'key' })
  const result = fixture.catalog.listCatalog()

  expect(result.inheritedFromLegacyConfig).toBe(true)
  expect(result.profiles).toEqual([expect.objectContaining({
    id: 'legacy-nano-banana-default',
    modelId: 'gemini-custom-image',
    executor: 'nano-banana',
    enabled: true,
  })])
  expect(existsSync(fixture.catalogPath)).toBe(false)
})

test('Given profile 已停用 When 解析任务快照 Then 在任何调用前阻断', () => {
  const fixture = createCatalogFixture({ apiKey: 'key' })
  fixture.catalog.replaceProfiles([createProfile({ enabled: false })])

  expect(() => fixture.catalog.resolveAvailableSnapshot('profile-flash'))
    .toThrow('生图模型已停用')
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/image-generation-model-catalog.test.ts`

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 增加配置路径和严格目录服务**

在 `config-paths.ts` 增加：

```ts
/** 返回系统生图模型目录文件，不创建目录或读取凭据。 */
export function getImageGenerationModelsPath(): string {
  return join(getConfigDir(), 'image-generation-models.json')
}
```

`image-generation-model-catalog.ts` 实现以下公开边界：

```ts
interface ImageGenerationModelsFile {
  schemaVersion: 1
  profiles: ImageGenerationModelProfile[]
}

export interface ImageGenerationModelCatalogDependencies {
  configPath: string
  getNanoBananaCredentials: () => Record<string, string>
  now?: () => number
}

export class ImageGenerationModelCatalog {
  constructor(private readonly dependencies: ImageGenerationModelCatalogDependencies) {}

  /** 返回系统设置需要的 profile，不返回任何凭据值。 */
  listCatalog(): ImageGenerationModelCatalogResult

  /** 返回设计页需要的清洗状态，禁用项仍保留原因供失效诊断。 */
  listOptions(): ImageGenerationModelOption[]

  /** 完整替换 profile 目录；拒绝重复 ID、空名称、空模型和未知执行器。 */
  replaceProfiles(profiles: ImageGenerationModelProfile[]): ImageGenerationModelCatalogResult

  /** 创建任务时把可信 profile 解析为不可变快照。 */
  resolveAvailableSnapshot(profileId: string): ImageGenerationModelSnapshot

  /** 工具执行前确认 profile 仍存在、启用且 executor/modelId 未变化。 */
  assertSnapshotAvailable(snapshot: ImageGenerationModelSnapshot): void
}
```

实现约束：

```ts
const LEGACY_PROFILE_ID = 'legacy-nano-banana-default'
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image-preview'

/** 首次读取只在内存合成兼容项，不触发文件写入。 */
function createLegacyProfile(credentials: Record<string, string>, now: number): ImageGenerationModelProfile {
  return {
    id: LEGACY_PROFILE_ID,
    name: 'Nano Banana 默认模型',
    executor: 'nano-banana',
    modelId: credentials.model?.trim() || DEFAULT_IMAGE_MODEL,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
}
```

写入必须使用 `writeJsonFileAtomic(configPath, { schemaVersion: 1, profiles })`；读取必须把主文件存在但损坏视为配置错误，禁止用空数组覆盖。选项 `available` 只由 profile 启用、执行器受支持和 Nano Banana API Key 完整共同决定，Renderer 永远拿不到 API Key/Base URL。

- [ ] **Step 4: 运行目录测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/image-generation-model-catalog.test.ts`

Expected: PASS，且临时目录中只有显式 `replaceProfiles` 才生成配置文件。

- [ ] **Step 5: 提交目录服务**

```bash
git add apps/electron/src/main/lib/config-paths.ts apps/electron/src/main/lib/image-generation-model-catalog.ts apps/electron/src/main/lib/image-generation-model-catalog.test.ts
git commit -m "设计：增加系统生图模型目录"
```

## Task 3: 持久化项目选择并接通四层 IPC

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-paths.ts`
- Modify: `apps/electron/src/main/lib/design/design-paths.test.ts`
- Create: `apps/electron/src/main/lib/design/design-image-model-preferences.ts`
- Create: `apps/electron/src/main/lib/design/design-image-model-preferences.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/design-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/design-preload.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写项目隔离、伪造 ID 和广播失败测试**

```ts
test('Given 项目 A 与 B When 分别选择模型 Then 偏好互不串线且重启恢复', () => {
  const fixture = createPreferenceFixture()
  fixture.preferences.setSelection({ projectId: 'project-a', imageModelProfileId: 'profile-a' })
  fixture.preferences.setSelection({ projectId: 'project-b', imageModelProfileId: 'profile-b' })

  const restarted = fixture.createRestartedStore()
  expect(restarted.getSelection('project-a').selectedProfileId).toBe('profile-a')
  expect(restarted.getSelection('project-b').selectedProfileId).toBe('profile-b')
})

test('Given Renderer 伪造 profile ID When 创建任务 Then 主进程在创建 journal 前拒绝', async () => {
  const fixture = createFixture()
  registerDesignIpcHandlers(fixture.options)

  await expect(fixture.invoke(DESIGN_IPC_CHANNELS.CREATE_JOB, {
    projectId: 'project-1', action: 'generate', prompt: '海报',
    imageModelProfileId: 'forged-profile', position: { x: 0, y: 0 },
  })).rejects.toThrow('生图模型不存在')
  expect(fixture.calls.createJob).toBe(0)
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/design-image-model-preferences.test.ts apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: FAIL，提示偏好服务、路径或新 API 不存在。

- [ ] **Step 3: 增加可信偏好路径和原子存储**

在 `DesignPaths` 增加 `preferencesPath`，固定为：

```ts
preferencesPath: join(cacheRoot, 'preferences.json')
```

创建偏好服务：

```ts
interface DesignProjectPreferencesFile {
  schemaVersion: 1
  imageModelProfileId?: string
  updatedAt: number
}

export class DesignImageModelPreferences {
  getSelection(projectId: string): DesignImageModelSelection
  setSelection(input: UpdateDesignImageModelSelectionInput): DesignImageModelSelection
  onChanged(listener: (event: DesignImageModelSelectionChangeEvent) => void): () => void
}
```

`setSelection` 必须先调用目录服务的 `resolveAvailableSnapshot`，再用 `writeJsonFileAtomic` 写完整文件。`getSelection` 对不可用的持久化 ID 返回 `invalidSelectedProfileId`，但不能自动写入或选择第一个可用模型。只有偏好文件不存在且没有历史选择时，允许返回唯一可用模型或目录中的第一个可用模型作为初始 `selectedProfileId`，并保持惰性不写文件；一旦偏好文件存在且失效，必须进入未选择状态。

- [ ] **Step 4: 同步 shared/main/preload/renderer 四层 IPC**

`DesignIpcOptions` 增加目录和偏好窄接口；注册以下 handler：

```ts
LIST_IMAGE_MODEL_PROFILES -> imageModels.listCatalog()
SAVE_IMAGE_MODEL_PROFILES -> imageModels.replaceProfiles(input.profiles)
GET_IMAGE_MODEL_SELECTION -> imagePreferences.getSelection(projectId)
SET_IMAGE_MODEL_SELECTION -> imagePreferences.setSelection(input)
```

保存目录后广播 `IMAGE_MODEL_PROFILES_CHANGED`；项目选择成功后广播 `IMAGE_MODEL_SELECTION_CHANGED`，事件只包含 `projectId`。Preload API 和 Renderer adapter 增加：

```ts
listImageModelProfiles()
saveImageModelProfiles(input)
getImageModelSelection(projectId)
setImageModelSelection(input)
onImageModelProfilesChanged(listener)
onImageModelSelectionChanged(listener)
```

`parseCreateJobInput` 的字段白名单加入 `imageModelProfileId` 并要求非空字符串；`CREATE_JOB` handler 在 `jobs.create` 内由 Manager 再次解析 profile，IPC 不信任 Renderer 传入的名称、执行器或 modelId。

- [ ] **Step 5: 在应用组合根注入同一目录和偏好实例**

`apps/electron/src/main/ipc.ts` 只创建一个 `ImageGenerationModelCatalog`，同时传给 `DesignJobManager`、`DesignImageModelPreferences` 和 `registerDesignIpcHandlers`。这样设置页、项目选择和执行器共享同一事实，不在各 handler 重复读取配置。

- [ ] **Step 6: 运行四层契约测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/design-image-model-preferences.test.ts apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts`

Expected: PASS；广播测试确认两个已授权窗口收到相同项目变更，未授权 sender 仍被拒绝。

- [ ] **Step 7: 提交 IPC 与偏好**

```bash
git add packages/shared/src/types/design.ts apps/electron/src/main/lib/design apps/electron/src/main/ipc.ts apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "设计：持久化项目生图模型选择"
```

## Task 4: 将系统设置升级为多模型配置列表

**Files:**
- Create: `apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.tsx`
- Create: `apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.test.tsx`
- Modify: `apps/electron/src/renderer/components/settings/ToolSettings.tsx`

- [ ] **Step 1: 写设置页失败测试**

```ts
test('Given 两个生图 profile When 渲染设置 Then 显示名称、真实模型 ID、启停和删除命令', () => {
  const html = renderToStaticMarkup(
    <ImageGenerationModelSettingsView
      profiles={[createProfile('Flash', 'gemini-flash'), createProfile('Pro', 'gemini-pro')]}
      credentialsConfigured
      saving={false}
      onProfilesChange={() => undefined}
      onSave={() => undefined}
    />,
  )

  expect(html).toContain('Flash')
  expect(html).toContain('gemini-flash')
  expect(html).toContain('Pro')
  expect(html).toContain('aria-label="删除生图模型 Pro"')
  expect(html).toContain('保存模型配置')
})
```

再覆盖无 API Key 时的明确提示、空列表新增入口和保存期间控件禁用。

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.test.tsx`

Expected: FAIL，提示组件不存在。

- [ ] **Step 3: 实现无嵌套卡片的 profile 列表**

`ImageGenerationModelSettingsView` 使用当前 `Input`、`Switch`、`Button`、主题变量和 `SettingsCard` 内现有分隔方式。每一行只包含显示名称、真实模型 ID、启用开关和 `Trash2` 图标按钮；新增使用 `Plus`，保存使用 `Save`。不增加装饰卡片、渐变、大标题或独立页面。

连接组件通过 Design preload API 加载和保存 profiles：

```ts
const result = await window.electronAPI.listImageModelProfiles()
await window.electronAPI.saveImageModelProfiles({ profiles })
```

新增 profile 使用 `crypto.randomUUID()` 和当前时间生成稳定 ID/时间戳；保存前本地拒绝空名称、空模型 ID和重复 ID，主进程仍进行最终校验。

- [ ] **Step 4: 保留普通 Chat 的旧默认模型语义**

修改 `NanoBananaSettings` 时移除可见的单模型文本框，但加载凭据时仍保留 `credentials.model`，保存 API Key/Base URL 时原样带回该值：

```ts
const savedCredentialsRef = React.useRef({ apiKey: '', baseUrl: '', model: '' })
const current = {
  apiKey: apiKey.trim(),
  baseUrl: baseUrl.trim(),
  model: savedCredentialsRef.current.model,
}
```

原因：普通 Chat/Agent Nano Banana 继续读取历史全局模型或默认值；编辑 Design profile 不得隐式改变普通会话模型。

- [ ] **Step 5: 运行设置页测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.test.tsx`

Expected: PASS。

- [ ] **Step 6: 提交设置页**

```bash
git add apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.tsx apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.test.tsx apps/electron/src/renderer/components/settings/ToolSettings.tsx
git commit -m "设置：支持配置多个生图模型"
```

## Task 5: Design Job 固化模型快照与重试语义

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.test.ts`

- [ ] **Step 1: 写快照、失效和重试失败测试**

```ts
test('Given 项目选择模型 B When 创建任务 Then queued journal 固化模型 B 完整快照', () => {
  const fixture = createFixture()
  const job = fixture.manager.create(createGenerateInput('profile-b'))

  expect(job.imageModelSnapshot).toEqual({
    profileId: 'profile-b',
    name: '高质量模型',
    executor: 'nano-banana',
    modelId: 'gemini-pro-image',
  })
})

test('Given 失败任务使用模型 B When 项目改选模型 A 后重试 Then replacement 仍复制模型 B', () => {
  const fixture = createFixture()
  const previous = fixture.createFailedJobWithSnapshot('profile-b')
  fixture.currentSelection = 'profile-a'

  expect(fixture.manager.retry('project-1', previous.id).imageModelSnapshot?.profileId)
    .toBe('profile-b')
})

test('Given 旧 journal 没有模型快照 When 请求重试 Then 不创建付费任务', () => {
  const fixture = createFixture()
  const legacy = fixture.createLegacyFailedJob()

  expect(() => fixture.manager.retry('project-1', legacy.id))
    .toThrow('旧任务未记录生图模型，请重新提交')
  expect(fixture.createdSessions).toHaveLength(0)
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts`

Expected: FAIL，任务记录没有快照或重试重新解析当前选择。

- [ ] **Step 3: 创建任务时在任何 journal/Store 副作用前解析快照**

`DesignJobManagerDependencies` 增加窄接口：

```ts
imageModels: Pick<ImageGenerationModelCatalog, 'resolveAvailableSnapshot' | 'assertSnapshotAvailable'>
```

`createInternal` 在读取 Store、写 journal、创建节点前执行：

```ts
const imageModelSnapshot = preservedSnapshot
  ?? this.dependencies.imageModels.resolveAvailableSnapshot(input.imageModelProfileId)
```

新 journal 始终写入 `imageModelSnapshot`。`STORED_JOB_FIELDS` 接受该字段，严格校验 profileId/name/executor/modelId；字段仍可缺失以读取旧 journal。

- [ ] **Step 4: 执行和重试保持稳定语义**

`run` 在创建 Agent session 前处理：

```ts
if (!queued.imageModelSnapshot) {
  this.updateStatus(queued, 'failed', { error: '旧任务未记录生图模型，请重新提交新任务' })
  return
}
this.dependencies.imageModels.assertSnapshotAvailable(queued.imageModelSnapshot)
```

`completeRetryIntent` 把 `previous.imageModelSnapshot` 作为 `preservedSnapshot` 传给 `createInternal`，禁止读取项目当前偏好。配置被删除、停用、modelId/executor 被替换或凭据失效时，replacement 可保留原快照，但 `run` 必须明确 failed，不能回退其他 profile。

- [ ] **Step 5: 运行 Job 测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-recovery.test.ts`

Expected: PASS；旧 journal 可以 `list/recover`，但不能自动或手动触发付费重跑。

- [ ] **Step 6: 提交任务快照**

```bash
git add apps/electron/src/main/lib/design/design-job-manager.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-recovery.test.ts
git commit -m "设计：固化任务生图模型快照"
```

## Task 6: 在 Pi 运行边界强制可信模型路由

**Files:**
- Create: `apps/electron/src/main/lib/agent-run-extensions.ts`
- Modify: `apps/electron/src/main/lib/agent-service.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/chat-tools/nano-banana-mcp.ts`
- Modify: `apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.test.ts`

- [ ] **Step 1: 写可信覆盖失败测试**

扩展 Nano Banana 测试，记录 fetch URL：

```ts
test('Given Design 注入模型 B 且 Agent 参数伪造模型 A When 执行工具 Then 请求仍使用模型 B', async () => {
  const [tool] = nanoBanana.buildPiNanoBananaTools(sdk, {
    sessionId: 'session-design',
    trustedImageRoute: {
      profileId: 'profile-b', name: '模型 B', executor: 'nano-banana', modelId: 'gemini-model-b',
    },
    assertTrustedImageRouteAvailable: () => undefined,
  }) as unknown as TestToolDefinition[]

  await tool!.execute('tool-1', { prompt: 'draw', model: 'gemini-model-a' })
  expect(fetchMock.mock.calls[0]?.[0]).toContain('/models/gemini-model-b:generateContent')
})
```

再写普通 Agent 无可信路由时仍使用 `credentials.model` 的回归测试，以及工具执行前复核失败时 `fetch` 调用次数为 0 的测试。

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts`

Expected: FAIL，可信路由未贯穿或 fetch 仍使用全局模型。

- [ ] **Step 3: 集中定义仅主进程运行扩展**

创建 `agent-run-extensions.ts`：

```ts
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ImageGenerationModelSnapshot } from '@proma/shared'

/** 仅主进程内部传递，不经过 IPC 或会话 JSONL。 */
export interface AgentRunExtensions {
  piCustomTools?: ToolDefinition[]
  allowedToolNames?: readonly string[]
  trustedImageRoute?: ImageGenerationModelSnapshot
  assertTrustedImageRouteAvailable?: (route: ImageGenerationModelSnapshot) => void
}
```

`agent-service.ts` 从该文件导入并重新导出类型，保持已有 import 兼容；`agent-orchestrator.ts` 的 `sendMessage` 使用同一接口，删除重复内联类型。

- [ ] **Step 4: 贯穿 Orchestrator 和工具构建上下文**

`buildPiBuiltinTools`、`PiBuiltinToolsContext` 和 `PiNanoBananaToolsContext` 增加可信路由与复核函数。Design route 存在时允许构建 Nano Banana 工具，即使普通 Chat 工具开关关闭；无 route 时完全保持原有开关和全局模型行为。

`callGeminiAndBuildResult` 在读取 history、参考图或调用 fetch 前执行：

```ts
if (trustedImageRoute) {
  assertTrustedImageRouteAvailable?.(trustedImageRoute)
}
const model = trustedImageRoute?.modelId
  ?? credentials.model?.trim()
  ?? DEFAULT_MODEL
```

工具 schema 不增加 `model` 参数，因此 Agent 无法选择或覆盖模型。

- [ ] **Step 5: Design Job 注入快照和实时复核**

`DesignJobManager.runHeadless` 的扩展改为：

```ts
{
  allowedToolNames: [DESIGN_IMAGE_TOOL],
  trustedImageRoute: running.imageModelSnapshot,
  assertTrustedImageRouteAvailable: (route) => {
    this.dependencies.imageModels.assertSnapshotAvailable(route)
  },
}
```

这保证 Agent LLM 仍先运行，图片工具真正执行时再进行一次配置/凭据复核；不会修改 `chat-tools.json`，并发普通会话不会看到该覆盖。

- [ ] **Step 6: 运行可信路由与 Agent 回归测试**

Run: `bun test apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/agent-design-tool-policy.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/agent-service.test.ts`

Expected: PASS；Design 只允许 Nano Banana，普通 Agent 不带 route 时仍使用全局默认模型。

- [ ] **Step 7: 提交运行级路由**

```bash
git add apps/electron/src/main/lib/agent-run-extensions.ts apps/electron/src/main/lib/agent-service.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.ts apps/electron/src/main/lib/chat-tools/nano-banana-mcp.ts apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts apps/electron/src/main/lib/design/design-job-manager.ts apps/electron/src/main/lib/design/design-job-manager.test.ts
git commit -m "Agent：强制设计任务使用固化生图模型"
```

## Task 7: 接入项目级 Jotai 状态与 Inspector 选择器

**Files:**
- Modify: `apps/electron/src/renderer/atoms/design-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/design-atoms.test.ts`
- Create: `apps/electron/src/renderer/components/design/use-design-image-model-selection.ts`
- Create: `apps/electron/src/renderer/components/design/use-design-image-model-selection.test.ts`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.test.tsx`

- [ ] **Step 1: 写项目切换、写入回滚和跨窗口刷新失败测试**

```ts
test('Given 项目 A/B 选择不同模型 When 切换 Inspector Then 各自恢复自己的选择', async () => {
  const fixture = createSelectionHookFixture()
  await fixture.load('project-a', selection('profile-a'))
  await fixture.load('project-b', selection('profile-b'))

  expect(fixture.state('project-a').imageModelProfileId).toBe('profile-a')
  expect(fixture.state('project-b').imageModelProfileId).toBe('profile-b')
})

test('Given 偏好写入失败 When 用户切换 Then 恢复主进程旧选择并保留表单输入', async () => {
  const fixture = createSelectionHookFixture({ setError: new Error('偏好写入失败') })
  fixture.setGenerationPrompt('project-a', '保留这段描述')
  await fixture.select('project-a', 'profile-b')

  expect(fixture.state('project-a').imageModelProfileId).toBe('profile-a')
  expect(fixture.state('project-a').generationPrompt).toBe('保留这段描述')
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/use-design-image-model-selection.test.ts`

Expected: FAIL，状态字段和 hook 不存在。

- [ ] **Step 3: 增加按项目缓存的模型状态**

`DesignProjectState` 增加：

```ts
imageModelLoadState: 'idle' | 'loading' | 'ready' | 'failed'
imageModelOptions: ImageGenerationModelOption[]
imageModelProfileId: string | null
invalidImageModelProfileId: string | null
imageModelError: string | null
```

初始状态必须使用独立空数组，避免项目间共享引用。Hook 只在进入项目或模型/偏好广播后调用主进程，不参与画布帧、拖动和 400ms 保存循环。

- [ ] **Step 4: 实现加载、选择和广播收敛 hook**

`useDesignImageModelSelection(projectId)` 返回：

```ts
{
  selectProfile: (profileId: string) => void
  retryLoad: () => void
}
```

加载时只更新模型状态，不清空 `generationPrompt`、`editPrompt`、selection 或 pending mutations。选择先显示 loading/optimistic 值，主进程失败后调用 `getImageModelSelection(projectId)` 恢复权威选择并 toast。`onImageModelProfilesChanged` 刷新当前项目；`onImageModelSelectionChanged` 只刷新事件对应项目。

- [ ] **Step 5: 在 AI 编辑顶部实现严格视觉规范的模型字段**

把模型字段放在 `AiPanel` 最前面，任何生成/编辑分支和“仅支持素材节点”提示之前。固定结构：

```tsx
<div className="space-y-1.5">
  <Label htmlFor="design-image-model" className="text-xs">生图模型</Label>
  <Select value={selectedId} onValueChange={onImageModelChange} disabled={disabled}>
    <SelectTrigger id="design-image-model" className="h-8 rounded px-2 text-xs">
      <SelectValue placeholder="未配置生图模型" />
    </SelectTrigger>
    <SelectContent>
      {availableOptions.map((option) => (
        <SelectItem key={option.profileId} value={option.profileId}>
          {option.name} · {option.modelId}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
</div>
```

视觉硬约束：

- 复用当前 Radix/shadcn `Select`、`Label`、`Button`、`Tooltip` 和主题变量；
- Trigger 高度 32px、4px 圆角、`text-xs`、稳定宽度，不新增卡片、渐变或装饰容器；
- 加载时用 `h-8 rounded bg-muted animate-pulse` 的稳定骨架占位；
- disabled 仍保留真实模型文本和足够对比度，不用 opacity 隐藏关键信息；
- 多个同名配置必须同时显示真实 modelId；只有一个模型也继续显示 Select；
- 无模型、失效或目录错误时禁用生成/编辑，保留用户 prompt，并显示带 `Settings2` 图标的“配置生图模型”入口或带 `RefreshCw` 的重试入口；
- 配置入口设置 `settingsTabAtom='tools'`、`toolSettingsFocusAtom='nano-banana'`、`settingsOpenAtom=true`；
- 保留原生键盘操作和可见 focus ring，不自定义键盘事件截获 Radix 行为。

创建任务函数必须把当前 `imageModelProfileId` 写入 `CreateDesignJobInput`。提交 handler 在 ID 缺失时直接返回，不能创建占位节点。

- [ ] **Step 6: 运行状态和 Inspector 测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/use-design-image-model-selection.test.ts apps/electron/src/renderer/components/design/DesignInspector.test.tsx apps/electron/src/renderer/components/design/design-accessibility.test.tsx`

Expected: PASS；静态标记包含 Label/Trigger 关联、32px class、禁用按钮、设置入口和模型真实 ID。

- [ ] **Step 7: 提交 Inspector**

```bash
git add apps/electron/src/renderer/atoms/design-atoms.ts apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/design/use-design-image-model-selection.ts apps/electron/src/renderer/components/design/use-design-image-model-selection.test.ts apps/electron/src/renderer/components/design/DesignInspector.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx apps/electron/src/renderer/components/design/design-accessibility.test.tsx
git commit -m "设计：增加项目生图模型选择器"
```

## Task 8: 展示任务实际模型并完成集成验证

**Files:**
- Modify: `apps/electron/src/renderer/components/design/design-canvas-model.ts`
- Modify: `apps/electron/src/renderer/components/design/design-canvas-model.test.ts`
- Modify: `apps/electron/src/renderer/components/design/DesignAssetNode.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignAssetNode.test.tsx`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `MEMORY.md`

- [ ] **Step 1: 写任务节点模型展示失败测试**

```ts
test('Given 任务固化模型快照 When 转换画布节点 Then footer 显示实际配置名和模型 ID', () => {
  const flowNode = toDesignFlowNodes(document, [{
    id: 'job-1', projectId: 'project-1', action: 'generate', status: 'running', prompt: '海报',
    imageModelSnapshot: {
      profileId: 'profile-b', name: '高质量模型', executor: 'nano-banana', modelId: 'gemini-pro-image',
    },
    createdAt: 1, updatedAt: 1,
  }])[0]

  expect(flowNode?.data.imageModelLabel).toBe('高质量模型 · gemini-pro-image')
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/renderer/components/design/design-canvas-model.test.ts apps/electron/src/renderer/components/design/DesignAssetNode.test.tsx`

Expected: FAIL，节点数据没有模型标签。

- [ ] **Step 3: 在稳定 footer 中显示模型，不改变节点尺寸**

`DesignAssetNodeData` 增加 `imageModelLabel?: string`，`design-canvas-model.ts` 从 job 快照构建该字段。任务 footer 的第二行显示：

```tsx
<p className="truncate text-[11px] text-muted-foreground">
  {data.imageModelLabel ?? STATUS_LABELS[data.status]}
</p>
```

任务错误仍显示在固定预览区内，节点继续使用持久化 `width/height`，模型长名称只能截断，不能撑大画布节点。

- [ ] **Step 4: 运行完整自动化验证**

Run: `bun test apps/electron/src/main/lib/image-generation-model-catalog.test.ts apps/electron/src/main/lib/design/design-image-model-preferences.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts apps/electron/src/renderer/atoms/design-atoms.test.ts apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.test.tsx apps/electron/src/renderer/components/design`

Expected: PASS。

Run: `bun run typecheck`

Expected: PASS，无 `any`、无 Agent 扩展类型漂移。

Run: `bun run electron:build`

Expected: PASS，主进程、preload 和 renderer bundle 均成功。

- [ ] **Step 5: 真实 Electron 窗口视觉与交互 QA**

Run: `bun run dev`

在真实窗口完成以下验收并保存截图证据到临时 QA 目录，不提交二进制截图：

1. 宽窗口：AI 编辑顶部模型字段与现有 Label、Textarea、Select 对齐，控件 32px 高且没有新增卡片。
2. 620px 窄窗口：最长配置名和 modelId 不溢出 Inspector，不遮挡生成按钮和标签。
3. 明暗主题：背景、边框、disabled 文本、focus ring 和弹出菜单均使用主题变量，无硬编码浅色。
4. 键盘：Tab 聚焦模型字段，Space/Enter 打开，方向键切换，Esc 关闭，焦点可见。
5. 单模型：Select 仍显示实际名称和 modelId。
6. 无模型/API Key 缺失：生成和编辑均禁用，设置入口可聚焦且能打开工具设置的 Nano Banana 区域。
7. 失效选择：停用当前 profile 后项目不静默回退；prompt 保留并要求重新选择。
8. 双阶段真实链路：提交后先出现可见 Agent 任务会话，Nano Banana 请求日志中的 model 与任务快照一致。
9. 回归：普通 Chat/Agent 的 Nano Banana 仍使用全局旧模型或默认模型，不读取项目选择。

- [ ] **Step 6: 更新项目记忆**

在 `MEMORY.md` 的“架构决策”增加一条，不复制代码：

```md
- Design 生图模型按项目保存在本机 `design-cache` 偏好中；新任务在主进程固化 profile 快照，并通过单次 Pi 运行扩展强制 Nano Banana 使用该模型。重试复制原快照，配置失效明确阻断，普通 Chat/Agent 的全局 Nano Banana 模型不受影响。
```

在“会话记录”增加完成日期、验证结果和视觉 QA 结论。

- [ ] **Step 7: 提交最终集成**

```bash
git add apps/electron/src/renderer/components/design/design-canvas-model.ts apps/electron/src/renderer/components/design/design-canvas-model.test.ts apps/electron/src/renderer/components/design/DesignAssetNode.tsx apps/electron/src/renderer/components/design/DesignAssetNode.test.tsx apps/electron/src/main/ipc.ts MEMORY.md
git commit -m "设计：完成生图模型双阶段调用"
```

## 自审结果

- 规格覆盖：模型目录、旧单模型兼容、项目偏好、多窗口广播、四层 IPC、任务快照、旧 journal、重试、可信运行覆盖、无模型/失效阻断、普通会话隔离、设置页和 Inspector 视觉状态均有对应任务。
- 关联模块影响：不修改 Chat/Agent 模型解析、不修改画布 revision、SAVE/recovery、素材归属、项目迁移和媒体 lease；新增读取只发生在设计页进入、配置广播和任务执行边界。
- 性能与资源：每项目偏好和全局目录均为小型 JSON；不增加常驻进程、网络轮次或 XYFlow 帧级工作；每个任务仍是一轮 Agent LLM 加一次图片调用。
- 占位符扫描：所有代码步骤都给出具体类型、方法、字段、命令和预期结果，没有留待执行者自行补全的描述。
- 类型一致性：统一使用 `ImageGenerationModelProfile`、`ImageGenerationModelSnapshot`、`DesignImageModelSelection`、`imageModelProfileId`、`imageModelSnapshot` 和 `trustedImageRoute`；旧任务只有 `imageModelSnapshot` 可缺失。
- 文档边界：不修改 README、tutorial 或 release notes；只按项目规则更新 `MEMORY.md`。
