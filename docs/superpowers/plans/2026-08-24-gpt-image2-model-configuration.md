# GPT Image 2 统一模型配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 Proma“模型配置”中把现有渠道模型声明为 Design 生图模型，并支持 Design 通过可信双阶段链路调用 GPT Image 2 的文生图与单参考图编辑接口。

**Architecture:** 现有渠道继续管理 Base URL、加密 API Key 和模型列表；fork 自有 `image-generation-models.json` 升级到 schema v2，只持久化 `executor/channelId/modelId` 等非敏感路由。Design Job 固化可辨识快照，主进程在图片工具执行前重新解析渠道并解密密钥，再由 executor 分派到 Nano Banana 或新的 OpenAI Images 执行器。设置 UI 从 Chat 工具迁到模型配置，但不修改 `ChannelModel`、`ChannelForm` 或渠道 JSON schema。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Jotai、Radix Select、shadcn primitives、Node.js HTTP/DNS、Pi Agent Runtime、BDD 风格 `bun:test`。

---

## 文件与职责

- `packages/shared/src/types/design.ts`：定义 schema v2 profile/snapshot 联合类型、清洗渠道选项和 Renderer 契约。
- `packages/shared/src/types/design.test.ts`：锁定 Nano Banana 兼容分支和 GPT Image 2 渠道分支的类型形状。
- `apps/electron/src/main/lib/image-generation-model-catalog.ts`：读取 v1/v2、惰性迁移、渠道引用校验、公开选项清洗和运行路由解析。
- `apps/electron/src/main/lib/image-generation-model-catalog.test.ts`：覆盖迁移、渠道失效、凭据隔离、快照复核和原子保存。
- `apps/electron/src/main/ipc.ts`：向目录注入现有渠道只读查询/解密依赖，并在渠道成功变更后广播生图可用性刷新。
- `apps/electron/src/main/lib/image-model-profile-broadcast.ts`：复用无 payload 广播，封装“先变更渠道、后通知”的顺序。
- `apps/electron/src/main/lib/image-model-profile-broadcast.test.ts`：锁定渠道变更失败不广播、成功后无敏感 payload 广播。
- `apps/electron/src/main/lib/design/design-job-manager.ts`：严格读取两类任务快照，并把运行路由解析闭包注入单次 Agent run。
- `apps/electron/src/main/lib/design/design-job-manager.test.ts`：覆盖 GPT 快照创建、重试、旧 journal 和配置失效。
- `apps/electron/src/main/lib/agent-run-extensions.ts`：把“仅校验”扩展升级为“校验并解析主进程运行路由”的闭包。
- `apps/electron/src/main/lib/image-generation-runtime.ts`：定义只在主进程内存存在的 resolved route，敏感字段不进入 shared/IPC/journal。
- `apps/electron/src/main/lib/chat-tools/openai-images-executor.ts`：构建 generations/edits 请求、解析多种响应、保存本地附件和失败回滚。
- `apps/electron/src/main/lib/chat-tools/openai-images-executor.test.ts`：覆盖 JSON、multipart、Base64、URL、取消、越界路径和错误清洗。
- `apps/electron/src/main/lib/chat-tools/safe-remote-image.ts`：使用 DNS 固定、手动重定向、MIME/大小上限下载远程图片，阻断 SSRF。
- `apps/electron/src/main/lib/chat-tools/safe-remote-image.test.ts`：覆盖公网地址、私网地址、重定向、错误 MIME 和超限响应。
- `apps/electron/src/main/lib/chat-tools/nano-banana-mcp.ts`：保持稳定工具 ID，按 resolved route 分派 Nano Banana 或 OpenAI Images。
- `apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts`：覆盖可信 executor 分派、普通 Chat 兼容、单次调用与密钥不泄露。
- `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`：把 route resolver 传给稳定图片工具。
- `apps/electron/src/main/lib/agent-orchestrator.ts`：把单次运行 resolver 传入 Pi 工具上下文。
- `apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.tsx`：编辑 Nano Banana legacy 与 channel-backed GPT Image 2 路由。
- `apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.test.tsx`：覆盖渠道/模型联动、校验、dirty 刷新和无障碍。
- `apps/electron/src/renderer/components/settings/ChannelSettings.tsx`：增加生图设置的稳定挂载点和聚焦容器。
- `apps/electron/src/renderer/components/settings/ChannelSettings.test.tsx`：锁定设置位置和现有渠道加载行为。
- `apps/electron/src/renderer/components/settings/ToolSettings.tsx`：移除重复的 Design 生图目录，保留 Nano Banana Chat 工具设置。
- `apps/electron/src/renderer/atoms/settings-tab.ts`：新增模型配置页的 `image-models` 聚焦目标。
- `apps/electron/src/renderer/components/design/DesignInspector.tsx`：把“前往配置”改为模型配置页的生图区块。
- `apps/electron/src/renderer/components/design/DesignInspector.test.tsx`、`design-accessibility.test.tsx`：覆盖入口、聚焦和视觉语义。

## Task 1: 扩展共享生图路由契约

**Files:**
- Modify: `packages/shared/src/types/design.ts`
- Modify: `packages/shared/src/types/design.test.ts`

- [ ] **Step 1: 写失败测试，锁定可辨识 profile、snapshot 和清洗渠道选项**

在 `packages/shared/src/types/design.test.ts` 增加：

```ts
test('Given GPT Image 2 渠道模型 When 构造生图契约 Then 只公开稳定路由字段', () => {
  const profile: ImageGenerationModelProfile = {
    id: 'profile-gpt-image-2',
    name: 'GPT Image 2',
    executor: 'openai-images',
    channelId: 'channel-openai-images',
    modelId: 'gpt-image-2',
    enabled: true,
    createdAt: 100,
    updatedAt: 100,
  }
  const snapshot: ImageGenerationModelSnapshot = {
    profileId: profile.id,
    name: profile.name,
    executor: profile.executor,
    channelId: profile.channelId,
    modelId: profile.modelId,
  }
  const channel: ImageGenerationChannelOption = {
    channelId: 'channel-openai-images',
    name: 'GPT Image 服务',
    available: true,
    models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
  }

  expect(snapshot.executor).toBe('openai-images')
  expect(channel.models).toEqual([{ id: 'gpt-image-2', name: 'GPT Image 2' }])
  expect(JSON.stringify(channel)).not.toContain('apiKey')
  expect(JSON.stringify(channel)).not.toContain('baseUrl')
})

test('Given 旧 Nano Banana profile When 构造共享类型 Then 不要求 channelId', () => {
  const profile: ImageGenerationModelProfile = {
    id: 'legacy-nano-banana-default',
    name: 'Nano Banana 默认模型',
    executor: 'nano-banana',
    modelId: 'gemini-3.1-flash-image-preview',
    enabled: true,
    createdAt: 100,
    updatedAt: 100,
  }
  expect(profile.executor).toBe('nano-banana')
  expect('channelId' in profile).toBe(false)
})
```

- [ ] **Step 2: 运行共享测试确认 RED**

Run: `bun test packages/shared/src/types/design.test.ts`

Expected: FAIL，提示 `'openai-images'` 不能赋给 `ImageGenerationExecutor`，且 `ImageGenerationChannelOption` 不存在。

- [ ] **Step 3: 用可辨识联合类型替换单执行器结构**

在 `packages/shared/src/types/design.ts` 用以下定义替换现有生图类型；其他 Design 类型保持不变：

```ts
export type ImageGenerationExecutor = 'nano-banana' | 'openai-images'

/** 生图 profile 的公共非敏感字段。 */
interface ImageGenerationModelProfileBase {
  id: string
  name: string
  modelId: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** 继续读取 Chat 工具凭据的 Nano Banana 兼容 profile。 */
export interface NanoBananaImageGenerationModelProfile extends ImageGenerationModelProfileBase {
  executor: 'nano-banana'
}

/** 引用现有渠道凭据的 OpenAI Images profile。 */
export interface OpenAIImagesGenerationModelProfile extends ImageGenerationModelProfileBase {
  executor: 'openai-images'
  channelId: string
}

export type ImageGenerationModelProfile =
  | NanoBananaImageGenerationModelProfile
  | OpenAIImagesGenerationModelProfile

export type ImageGenerationModelSnapshot =
  | Pick<NanoBananaImageGenerationModelProfile, 'modelId'> & {
      profileId: string
      name: string
      executor: 'nano-banana'
    }
  | Pick<OpenAIImagesGenerationModelProfile, 'channelId' | 'modelId'> & {
      profileId: string
      name: string
      executor: 'openai-images'
    }

export type ImageGenerationModelOption =
  | Extract<ImageGenerationModelSnapshot, { executor: 'nano-banana' }> & {
      available: boolean
      unavailableReason?: string
    }
  | Extract<ImageGenerationModelSnapshot, { executor: 'openai-images' }> & {
      available: boolean
      unavailableReason?: string
    }

/** Renderer 可选择的已清洗渠道模型，不包含 Base URL 或 API Key。 */
export interface ImageGenerationChannelOption {
  channelId: string
  name: string
  available: boolean
  unavailableReason?: string
  models: Array<{ id: string; name: string }>
}

export interface ImageGenerationModelCatalogResult {
  profiles: ImageGenerationModelProfile[]
  channelOptions: ImageGenerationChannelOption[]
  inheritedFromLegacyConfig: boolean
  credentialsConfigured: boolean
}
```

- [ ] **Step 4: 更新现有 shared fixture 并确认 GREEN**

所有现有 Nano Banana fixture 保持没有 `channelId`；所有 `ImageGenerationModelCatalogResult` fixture 增加 `channelOptions: []`。

Run: `bun test packages/shared/src/types/design.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交共享契约**

```bash
git add packages/shared/src/types/design.ts packages/shared/src/types/design.test.ts
git commit -m "设计：扩展生图模型渠道路由契约"
```

## Task 2: 将生图目录升级到 schema v2 并引用渠道凭据

**Files:**
- Modify: `apps/electron/src/main/lib/image-generation-model-catalog.ts`
- Modify: `apps/electron/src/main/lib/image-generation-model-catalog.test.ts`
- Create: `apps/electron/src/main/lib/image-generation-runtime.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: 写失败测试覆盖 v1 读取、v2 保存和渠道可用性**

在 `image-generation-model-catalog.test.ts` 扩展现有 fixture，使其可注入渠道和解密结果：

```ts
let channels: Channel[] = []
let decryptedKeys: Record<string, string> = {}

function createCatalog(now = 100): ImageGenerationModelCatalog {
  return new ImageGenerationModelCatalog({
    configPath,
    getNanoBananaCredentials: () => credentials,
    listChannels: () => channels,
    decryptChannelApiKey: (channelId) => decryptedKeys[channelId] ?? '',
    now: () => now,
  })
}

function createEnabledGPTImageChannel(): Channel {
  return {
    id: 'channel-gpt',
    name: 'GPT Image 服务',
    provider: 'openai',
    baseUrl: 'http://100.124.186.117:8030/v1',
    apiKey: 'encrypted',
    enabled: true,
    models: [{ id: 'gpt-image-2', name: 'GPT Image 2', enabled: true }],
    createdAt: 1,
    updatedAt: 1,
  }
}

function createOpenAIProfile(): ImageGenerationModelProfile {
  return {
    id: 'profile-gpt',
    name: 'GPT Image 2',
    executor: 'openai-images',
    channelId: 'channel-gpt',
    modelId: 'gpt-image-2',
    enabled: true,
    createdAt: 10,
    updatedAt: 20,
  }
}
```

`beforeEach` 同步重置 `channels = []` 与 `decryptedKeys = {}`。然后增加：

```ts
test('Given schema v1 Nano Banana 目录 When 读取后保存 Then 原 ID 以 schema v2 原子写回', () => {
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    profiles: [createProfile('profile-old')],
  }))
  const catalog = createCatalog()

  const loaded = catalog.listCatalog()
  expect(loaded.profiles[0]?.id).toBe('profile-old')
  expect(JSON.parse(readFileSync(configPath, 'utf8')).schemaVersion).toBe(1)

  catalog.replaceProfiles(loaded.profiles)
  expect(JSON.parse(readFileSync(configPath, 'utf8')).schemaVersion).toBe(2)
})

test('Given 可用渠道模型 When 解析 GPT Image profile Then 返回只在主进程存在的运行路由', () => {
  channels = [createEnabledGPTImageChannel()]
  decryptedKeys = { 'channel-gpt': 'secret-key' }
  const catalog = createCatalog()
  catalog.replaceProfiles([createOpenAIProfile()])

  const snapshot = catalog.resolveAvailableSnapshot('profile-gpt')
  const route = catalog.resolveExecutionRoute(snapshot)

  expect(route).toEqual({
    executor: 'openai-images',
    snapshot,
    baseUrl: 'http://100.124.186.117:8030/v1',
    apiKey: 'secret-key',
  })
  expect(JSON.stringify(catalog.listCatalog())).not.toContain('secret-key')
})

test('Given 渠道停用或模型被移除 When 列出选项 Then 保留 profile 并说明不可用', () => {
  channels = [createEnabledGPTImageChannel()]
  decryptedKeys = { 'channel-gpt': 'secret-key' }
  const catalog = createCatalog()
  catalog.replaceProfiles([createOpenAIProfile()])
  channels = []

  expect(catalog.listOptions()).toEqual([expect.objectContaining({
    profileId: 'profile-gpt',
    available: false,
    unavailableReason: '关联的模型配置已不存在',
  })])
})
```

- [ ] **Step 2: 运行目录测试确认 RED**

Run: `bun test apps/electron/src/main/lib/image-generation-model-catalog.test.ts`

Expected: FAIL，提示 schema 2、`channelId` 或 `resolveExecutionRoute` 尚不支持。

- [ ] **Step 3: 定义仅主进程可见的 resolved route**

创建 `apps/electron/src/main/lib/image-generation-runtime.ts`：

```ts
import type { ImageGenerationModelSnapshot } from '@proma/shared'

/** 已完成实时校验、只允许在主进程本轮调用内存在的生图路由。 */
export type ResolvedImageGenerationRoute =
  | {
      executor: 'nano-banana'
      snapshot: Extract<ImageGenerationModelSnapshot, { executor: 'nano-banana' }>
    }
  | {
      executor: 'openai-images'
      snapshot: Extract<ImageGenerationModelSnapshot, { executor: 'openai-images' }>
      baseUrl: string
      apiKey: string
    }

/** 单次工具执行前解析任务快照的主进程闭包。 */
export type ResolveImageGenerationRoute = (
  snapshot: ImageGenerationModelSnapshot,
) => ResolvedImageGenerationRoute
```

- [ ] **Step 4: 实现 v1/v2 严格解析与渠道依赖**

在 `image-generation-model-catalog.ts` 将磁盘结构和依赖改为：

```ts
interface ImageGenerationModelsFileV1 {
  schemaVersion: 1
  profiles: Array<Extract<ImageGenerationModelProfile, { executor: 'nano-banana' }>>
}

interface ImageGenerationModelsFileV2 {
  schemaVersion: 2
  profiles: ImageGenerationModelProfile[]
}

type ImageGenerationModelsFile = ImageGenerationModelsFileV1 | ImageGenerationModelsFileV2

export interface ImageGenerationModelCatalogDependencies {
  configPath: string
  getNanoBananaCredentials: () => Record<string, string>
  listChannels: () => Channel[]
  decryptChannelApiKey: (channelId: string) => string
  now?: () => number
}
```

严格字段集合按 executor 分开：

```ts
const BASE_PROFILE_KEYS = ['id', 'name', 'executor', 'modelId', 'enabled', 'createdAt', 'updatedAt'] as const
const OPENAI_IMAGES_PROFILE_KEYS = [...BASE_PROFILE_KEYS, 'channelId'] as const

function expectedProfileKeys(profile: ImageGenerationModelProfile): readonly string[] {
  return profile.executor === 'openai-images'
    ? OPENAI_IMAGES_PROFILE_KEYS
    : BASE_PROFILE_KEYS
}
```

`readModelsFile()` 接受 schema 1 和 2；schema 1 只允许 `nano-banana`，内存返回统一 profiles 但携带 `sourceSchemaVersion`。`replaceProfiles()` 始终使用：

```ts
writeJsonFileAtomic(this.dependencies.configPath, {
  schemaVersion: 2,
  profiles: validatedProfiles,
})
```

新增渠道校验和清洗：

```ts
function getChannelAvailability(
  profile: Extract<ImageGenerationModelProfile, { executor: 'openai-images' }>,
  channels: readonly Channel[],
  decryptApiKey: (channelId: string) => string,
): AvailabilityResult {
  const channel = channels.find((candidate) => candidate.id === profile.channelId)
  if (!channel) return { available: false, unavailableReason: '关联的模型配置已不存在' }
  if (!channel.enabled) return { available: false, unavailableReason: '关联的模型配置已停用' }
  const model = channel.models.find((candidate) => candidate.id === profile.modelId)
  if (!model?.enabled) return { available: false, unavailableReason: '关联模型不可用' }
  try {
    if (!decryptApiKey(channel.id).trim()) {
      return { available: false, unavailableReason: '关联的模型配置缺少 API Key' }
    }
  } catch {
    return { available: false, unavailableReason: '关联的模型配置凭据不可用' }
  }
  return { available: true }
}
```

`listCatalog()` 返回 `channelOptions`，每个选项只包含启用模型的 `id/name`；`resolveAvailableSnapshot()` 为 `openai-images` 固化 `channelId`；`assertSnapshotAvailable()` 比较 executor、channelId 和 modelId；`resolveExecutionRoute()` 先调用同一快照复核，再返回 resolved route。

`replaceProfiles()` 必须在写文件前验证所有 `openai-images` profile 引用的渠道存在且启用、模型存在且启用、API Key 可解密且非空。已经保存的 profile 后续因渠道删除而失效时，`listCatalog()` 和 `listOptions()` 仍保留该行并返回不可用原因；用户删除或修复该行后才能再次保存。

- [ ] **Step 5: 注入现有 channel-manager 依赖并确认 GREEN**

在 `apps/electron/src/main/ipc.ts` 的 `getDesignImageModelServices()` 改为：

```ts
const imageModels = new ImageGenerationModelCatalog({
  configPath: getImageGenerationModelsPath(),
  getNanoBananaCredentials: () => getToolCredentials('nano-banana'),
  listChannels,
  decryptChannelApiKey: decryptApiKey,
})
```

Run: `bun test apps/electron/src/main/lib/image-generation-model-catalog.test.ts apps/electron/src/main/lib/design/design-image-model-preferences.test.ts apps/electron/src/main/lib/design/design-ipc.test.ts`

Expected: PASS；公开 catalog 的序列化结果不含测试密钥和 Base URL。

- [ ] **Step 6: 提交目录升级**

```bash
git add packages/shared/src/types/design.ts apps/electron/src/main/lib/image-generation-runtime.ts apps/electron/src/main/lib/image-generation-model-catalog.ts apps/electron/src/main/lib/image-generation-model-catalog.test.ts apps/electron/src/main/ipc.ts
git commit -m "设计：升级生图目录并复用渠道凭据"
```

## Task 3: 让渠道变更刷新生图可用性

**Files:**
- Modify: `apps/electron/src/main/lib/image-model-profile-broadcast.ts`
- Modify: `apps/electron/src/main/lib/image-model-profile-broadcast.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: 写失败测试，要求渠道变更成功后广播且失败不广播**

```ts
test('Given 渠道写入成功 When 创建更新或删除渠道 Then 生图目录收到无 payload 刷新', async () => {
  const target = createTarget(1)
  const result = await runChannelMutationWithImageModelBroadcast({
    mutate: () => ({ id: 'channel-gpt' }),
    listTargets: () => [target],
  })

  expect(result).toEqual({ id: 'channel-gpt' })
  expect(target.sent).toEqual([{
    channel: DESIGN_IPC_CHANNELS.IMAGE_MODEL_PROFILES_CHANGED,
    value: undefined,
  }])
})

test('Given 渠道写入失败 When 执行包装 Then 不广播', async () => {
  const target = createTarget(1)
  await expect(runChannelMutationWithImageModelBroadcast({
    mutate: () => { throw new Error('渠道写入失败') },
    listTargets: () => [target],
  })).rejects.toThrow('渠道写入失败')
  expect(target.sent).toEqual([])
})
```

- [ ] **Step 2: 运行广播测试确认 RED**

Run: `bun test apps/electron/src/main/lib/image-model-profile-broadcast.test.ts`

Expected: FAIL，提示 `runChannelMutationWithImageModelBroadcast` 不存在。

- [ ] **Step 3: 增加通用渠道变更包装器**

在 `image-model-profile-broadcast.ts` 增加：

```ts
interface ChannelMutationWithImageModelBroadcastInput<Result> {
  mutate: () => Result | Promise<Result>
  listTargets: () => ImageModelProfileBroadcastTarget[]
}

/** 只在渠道事务成功后通知 Renderer 重算生图 profile 可用性。 */
export async function runChannelMutationWithImageModelBroadcast<Result>(
  input: ChannelMutationWithImageModelBroadcastInput<Result>,
): Promise<Result> {
  const result = await input.mutate()
  broadcastImageModelProfilesChanged(input.listTargets())
  return result
}
```

- [ ] **Step 4: 包装 CREATE/UPDATE/DELETE 三个 IPC handler**

在 `ipc.ts` 中保持原通道和返回类型，只把主体改为：

```ts
return runChannelMutationWithImageModelBroadcast({
  mutate: () => createChannel(input),
  listTargets: () => BrowserWindow.getAllWindows().map((window) => window.webContents),
})
```

`UPDATE` 对应 `updateChannel(id, input)`，`DELETE` 对应 `deleteChannel(id)`。解密、测试和模型拉取不广播，因为它们不改变持久化渠道事实。

- [ ] **Step 5: 运行测试确认 GREEN 并提交**

Run: `bun test apps/electron/src/main/lib/image-model-profile-broadcast.test.ts apps/electron/src/main/lib/design/design-ipc.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/image-model-profile-broadcast.ts apps/electron/src/main/lib/image-model-profile-broadcast.test.ts apps/electron/src/main/ipc.ts
git commit -m "设计：同步渠道变化到生图配置"
```

## Task 4: 严格升级 Design Job 快照与运行路由

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-job-manager.ts`
- Modify: `apps/electron/src/main/lib/design/design-job-manager.test.ts`
- Modify: `apps/electron/src/main/lib/agent-run-extensions.ts`
- Modify: `apps/electron/src/main/lib/agent-service.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`

- [ ] **Step 1: 写失败测试覆盖 GPT 快照、重试和损坏 journal**

在现有 `createHarness()` 的 `state` 增加 `resolveExecutionRoute`，让 fake catalog 同时实现创建快照、运行前断言和工具执行时解析：

```ts
resolveExecutionRoute: (snapshot: ImageGenerationModelSnapshot): ResolvedImageGenerationRoute => ({
  executor: 'nano-banana',
  snapshot: snapshot as Extract<ImageGenerationModelSnapshot, { executor: 'nano-banana' }>,
}),
```

传给 Manager 的 fake catalog 增加：

```ts
resolveExecutionRoute: (snapshot) => state.resolveExecutionRoute(snapshot),
```

返回的 harness 增加与现有 setter 相同风格的 setter：

```ts
set resolveExecutionRoute(value: typeof state.resolveExecutionRoute) {
  state.resolveExecutionRoute = value
},
```

测试使用以下稳定 helper：

```ts
function createNanoSnapshot(): ImageGenerationModelSnapshot {
  return {
    profileId: 'profile-nano',
    name: 'Nano Banana',
    executor: 'nano-banana',
    modelId: 'gemini-image',
  }
}

function createOpenAISnapshot(): ImageGenerationModelSnapshot {
  return {
    profileId: 'profile-gpt',
    name: 'GPT Image 2',
    executor: 'openai-images',
    channelId: 'channel-gpt',
    modelId: 'gpt-image-2',
  }
}
```

```ts
test('Given 项目选择 GPT Image 2 When 创建任务 Then journal 固化渠道快照且运行时解析一次', async () => {
  const harness = createHarness()
  harness.resolveAvailableSnapshot = () => createOpenAISnapshot()
  let resolved: ResolvedImageGenerationRoute | undefined
  harness.resolveExecutionRoute = (snapshot) => ({
    executor: 'openai-images',
    snapshot: snapshot as Extract<ImageGenerationModelSnapshot, { executor: 'openai-images' }>,
    baseUrl: 'http://100.124.186.117:8030/v1',
    apiKey: 'secret-key',
  })
  harness.runHeadless = async (callbacks, extensions) => {
    resolved = extensions.resolveTrustedImageRoute?.(extensions.trustedImageRoute!)
    callbacks.onComplete([])
  }

  const job = harness.manager.create({
    ...createGenerateInput(),
    imageModelProfileId: 'profile-gpt',
  })
  await harness.manager.run(job.id)
  expect(job.imageModelSnapshot).toEqual(expect.objectContaining({
    executor: 'openai-images',
    channelId: 'channel-gpt',
    modelId: 'gpt-image-2',
  }))
  expect(resolved).toEqual(expect.objectContaining({
    executor: 'openai-images',
    apiKey: 'secret-key',
  }))
})

test('Given GPT Image 2 失败任务 When 重试 Then replacement 复制原渠道快照', async () => {
  const harness = createHarness()
  harness.resolveAvailableSnapshot = () => createOpenAISnapshot()
  harness.messages = []
  const failed = harness.manager.create({
    ...createGenerateInput(),
    imageModelProfileId: 'profile-gpt',
  })
  await harness.manager.run(failed.id)
  harness.resolveAvailableSnapshot = () => {
    throw new Error('重试不应重新读取当前模型目录')
  }

  const replacement = harness.manager.retry('project-1', failed.id)
  expect(replacement.imageModelSnapshot).toEqual(createOpenAISnapshot())
})

test('Given openai-images journal 缺少 channelId When 恢复 Then 拒绝损坏记录', () => {
  const harness = createHarness()
  const jobsDirectory = join(cacheRoot, 'jobs')
  mkdirSync(jobsDirectory, { recursive: true })
  writeFileSync(join(jobsDirectory, 'job-gpt.json'), JSON.stringify({
    id: 'job-gpt',
    projectId: 'project-1',
    action: 'generate',
    status: 'interrupted',
    prompt: '损坏任务',
    nodeId: 'node-gpt',
    position: { x: 0, y: 0 },
    createdAt: 1,
    updatedAt: 1,
    imageModelSnapshot: {
      profileId: 'profile-gpt',
      name: 'GPT Image 2',
      executor: 'openai-images',
      modelId: 'gpt-image-2',
    },
  }))
  expect(harness.manager.list('project-1')).toEqual([])
})
```

- [ ] **Step 2: 运行 Job 测试确认 RED**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts`

Expected: FAIL，提示快照只接受 `nano-banana` 或扩展仍只有 `assertTrustedImageRouteAvailable`。

- [ ] **Step 3: 将运行扩展改为 resolver 闭包**

在 `agent-run-extensions.ts` 增加类型导入并替换旧字段：

```ts
import type { ResolveImageGenerationRoute } from './image-generation-runtime'

export interface AgentRunExtensions {
  piCustomTools?: ToolDefinition[]
  allowedToolNames?: readonly string[]
  trustedImageRoute?: ImageGenerationModelSnapshot
  /** 工具执行前同时复核配置并解析只在内存存在的凭据。 */
  resolveTrustedImageRoute?: ResolveImageGenerationRoute
  toolCallLimits?: Readonly<Record<string, number>>
}
```

`agent-service.ts` 只需继续 re-export/use 同一接口；`agent-orchestrator.ts` 与 `pi-builtin-tools.ts` 把 `resolveTrustedImageRoute` 原样透传，不调用、不持久化、不序列化返回值。

- [ ] **Step 4: 严格解析两种 snapshot 并注入 catalog resolver**

在 `design-job-manager.ts` 把 `isImageModelSnapshot` 改为：

```ts
function isImageModelSnapshot(value: unknown): value is ImageGenerationModelSnapshot {
  if (!isRecord(value)) return false
  const baseValid = typeof value.profileId === 'string'
    && value.profileId.length > 0
    && value.profileId === value.profileId.trim()
    && typeof value.name === 'string'
    && value.name.trim().length > 0
    && value.name.length <= IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH
    && typeof value.modelId === 'string'
    && value.modelId.length > 0
    && value.modelId.length <= IMAGE_GENERATION_MODEL_ID_MAX_LENGTH
    && value.modelId === value.modelId.trim()
  if (!baseValid) return false
  if (value.executor === 'nano-banana') {
    return Object.keys(value).length === 4
  }
  return value.executor === 'openai-images'
    && typeof value.channelId === 'string'
    && value.channelId.length > 0
    && value.channelId === value.channelId.trim()
    && Object.keys(value).length === 5
}
```

把 `DesignJobManagerDependencies.imageModels` 改为选取 `resolveExecutionRoute`，单次运行扩展使用：

```ts
resolveTrustedImageRoute: (route) => {
  try {
    return this.runImageModelValidation(
      () => this.dependencies.imageModels.resolveExecutionRoute(route),
    )
  } catch (error) {
    runError ??= error instanceof Error ? error.message : DESIGN_IMAGE_MODEL_VALIDATION_ERROR
    throw error
  }
},
```

- [ ] **Step 5: 运行核心任务与透传测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/adapters/pi-utility-adapter.test.ts`

Expected: PASS；旧 Nano Banana journal 仍可读取，GPT snapshot 缺字段或多字段均被拒绝。

- [ ] **Step 6: 提交可信路由升级**

```bash
git add apps/electron/src/main/lib/design/design-job-manager.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/agent-run-extensions.ts apps/electron/src/main/lib/agent-service.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.ts
git commit -m "设计：扩展任务可信生图路由"
```

## Task 5: 实现安全远程图片下载

**Files:**
- Create: `apps/electron/src/main/lib/chat-tools/safe-remote-image.ts`
- Create: `apps/electron/src/main/lib/chat-tools/safe-remote-image.test.ts`

- [ ] **Step 1: 写失败测试覆盖 SSRF、重定向、MIME 和大小限制**

测试通过依赖注入的 DNS 与 request transport，不访问真实网络。先定义完整响应 helper：

```ts
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex')

function createResponse(
  statusCode: number,
  headers: Record<string, string>,
  bytes: Buffer,
): RemoteImageResponse {
  return {
    statusCode,
    headers,
    body: (async function* stream(): AsyncGenerator<Uint8Array> {
      yield bytes
    })(),
  }
}

function createSafeDependencies(): SafeRemoteImageDependencies {
  return {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => createResponse(
      200,
      { 'content-type': 'image/png' },
      PNG_BYTES,
    ),
  }
}
```

然后增加：

```ts
test('Given 响应 URL 解析到私网 When 下载 Then 在请求前拒绝', async () => {
  let requested = false
  await expect(downloadSafeRemoteImage('https://images.example/result.png', {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    request: async () => {
      requested = true
      return createResponse(200, { 'content-type': 'image/png' }, PNG_BYTES)
    },
  })).rejects.toThrow('图片下载地址不允许访问本地或私有网络')
  expect(requested).toBe(false)
})

test('Given 公网图片与一次公网重定向 When 下载 Then 固定已校验地址并返回图片', async () => {
  const calls: string[] = []
  const image = await downloadSafeRemoteImage('https://images.example/start', {
    lookup: async (hostname) => [{
      address: hostname === 'images.example' ? '93.184.216.34' : '151.101.1.69',
      family: 4,
    }],
    request: async (request) => {
      calls.push(`${request.url.hostname}:${request.address}`)
      return calls.length === 1
        ? createResponse(302, { location: 'https://cdn.example/result.png' }, Buffer.alloc(0))
        : createResponse(200, { 'content-type': 'image/png' }, PNG_BYTES)
    },
  })
  expect(image.mediaType).toBe('image/png')
  expect(image.bytes).toEqual(PNG_BYTES)
  expect(calls).toEqual(['images.example:93.184.216.34', 'cdn.example:151.101.1.69'])
})

test('Given 非图片 MIME 或超过附件上限 When 下载 Then 拒绝结果', async () => {
  const base = createSafeDependencies()
  await expect(downloadSafeRemoteImage('https://images.example/result', {
    ...base,
    request: async () => createResponse(200, { 'content-type': 'text/html' }, Buffer.from('html')),
  })).rejects.toThrow('远程响应不是受支持的图片')
  await expect(downloadSafeRemoteImage('https://images.example/result', {
    ...base,
    maxBytes: 4,
    request: async () => createResponse(200, { 'content-type': 'image/png' }, Buffer.alloc(5)),
  })).rejects.toThrow('远程图片超过大小限制')
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/chat-tools/safe-remote-image.test.ts`

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现地址分类和可注入下载循环**

`safe-remote-image.ts` 导出以下窄接口：

```ts
interface ResolvedAddress {
  address: string
  family: 4 | 6
}

interface RemoteImageResponse {
  statusCode: number
  headers: Record<string, string | undefined>
  body: AsyncIterable<Uint8Array>
}

export interface SafeRemoteImageDependencies {
  lookup: (hostname: string) => Promise<ResolvedAddress[]>
  request: (input: {
    url: URL
    address: string
    family: 4 | 6
    signal?: AbortSignal
  }) => Promise<RemoteImageResponse>
  maxBytes?: number
  maxRedirects?: number
}

export interface DownloadedRemoteImage {
  bytes: Buffer
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}
```

实现约束：只接受 `https:`；每一跳解析全部 A/AAAA，任一结果为 loopback、link-local、RFC1918、CGNAT、ULA、multicast 或 unspecified 即拒绝；transport 必须连接已经校验的 address，同时保留原 hostname 作为 Host/SNI；最多 3 次重定向；读取流时累计字节并在超过 `MAX_ATTACHMENT_SIZE` 前中止；MIME 必须通过 `isImageAttachment` 且限制在 Proma 可保存的四类图片。

生产默认 transport 使用 `https.request`，自定义 `lookup` 回调固定返回本轮已校验 address，禁止请求库再次解析 hostname。错误信息不包含 URL query，以免签名参数进入日志。

- [ ] **Step 4: 运行安全下载测试确认 GREEN 并提交**

Run: `bun test apps/electron/src/main/lib/chat-tools/safe-remote-image.test.ts`

Expected: PASS，测试不访问外网。

```bash
git add apps/electron/src/main/lib/chat-tools/safe-remote-image.ts apps/electron/src/main/lib/chat-tools/safe-remote-image.test.ts
git commit -m "设计：增加安全远程图片下载"
```

## Task 6: 实现 OpenAI Images 文生图与单图编辑执行器

**Files:**
- Create: `apps/electron/src/main/lib/chat-tools/openai-images-executor.ts`
- Create: `apps/electron/src/main/lib/chat-tools/openai-images-executor.test.ts`
- Modify: `apps/electron/src/main/lib/chat-tools/nano-banana-mcp.ts`
- Modify: `apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`

- [ ] **Step 1: 写 generations 和 edits 失败测试**

测试文件定义固定输入和依赖，任何测试凭据只存在于临时对象：

```ts
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex')
const PNG_BASE64 = PNG_BYTES.toString('base64')

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: BodyInit | null | undefined
}

function createResolvedOpenAIRoute(): Extract<ResolvedImageGenerationRoute, { executor: 'openai-images' }> {
  return {
    executor: 'openai-images',
    snapshot: {
      profileId: 'profile-gpt',
      name: 'GPT Image 2',
      executor: 'openai-images',
      channelId: 'channel-gpt',
      modelId: 'gpt-image-2',
    },
    baseUrl: 'http://100.124.186.117:8030/v1',
    apiKey: 'secret-key',
  }
}

function createExecutionInput(): ExecuteOpenAIImagesInput {
  return {
    route: createResolvedOpenAIRoute(),
    sessionId: 'session-1',
    prompt: 'Create a product poster',
    aspectRatio: '1:1',
    numberOfImages: 1,
  }
}

function createReferenceImageFixture(): { root: string; imagePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'proma-openai-images-'))
  const imagePath = join(root, 'reference.png')
  writeFileSync(imagePath, PNG_BYTES)
  return { root, imagePath }
}

function createExecutorDependencies(
  requests: CapturedRequest[],
  responseBody: Record<string, unknown>,
  onFetch?: () => void,
  downloadRemoteImage = async (): Promise<DownloadedRemoteImage> => ({
    bytes: PNG_BYTES,
    mediaType: 'image/png',
  }),
): OpenAIImagesExecutorDependencies {
  return {
    fetch: async (input, init) => {
      onFetch?.()
      requests.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body,
      })
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    downloadRemoteImage,
    saveAttachment: ({ conversationId, filename, mediaType }) => ({
      attachment: {
        id: 'attachment-1',
        filename,
        mediaType,
        localPath: `${conversationId}/saved.png`,
        size: PNG_BYTES.length,
      },
    }),
    deleteAttachment: () => undefined,
    createId: () => 'fixed-id',
  }
}
```

```ts
test('Given 无参考图 When 调用 GPT Image 2 Then 发送 Bearer JSON generations 请求', async () => {
  const requests: CapturedRequest[] = []
  const result = await executeOpenAIImages({
    route: createResolvedOpenAIRoute(),
    sessionId: 'session-1',
    prompt: 'Create a product poster',
    aspectRatio: '1:1',
    numberOfImages: 1,
  }, createExecutorDependencies(requests, {
    data: [{ b64_json: PNG_BASE64 }],
  }))

  expect(requests[0]).toMatchObject({
    url: 'http://100.124.186.117:8030/v1/images/generations',
    headers: { authorization: 'Bearer secret-key', 'content-type': 'application/json' },
  })
  expect(JSON.parse(String(requests[0]?.body))).toEqual({
    model: 'gpt-image-2',
    prompt: 'Create a product poster',
    size: '1024x1024',
    n: 1,
  })
  expect(result.imageAttachments).toHaveLength(1)
})

test('Given 一张授权参考图 When 调用 Then 发送 multipart edits 请求', async () => {
  const fixture = createReferenceImageFixture()
  try {
    const requests: CapturedRequest[] = []
    await executeOpenAIImages({
      route: createResolvedOpenAIRoute(),
      sessionId: 'session-1',
      prompt: 'Change the background',
      referenceImagePaths: [fixture.imagePath],
      cwd: fixture.root,
    }, createExecutorDependencies(requests, { data: [{ image_base64: PNG_BASE64 }] }))

    expect(requests[0]?.url).toEndWith('/images/edits')
    expect(requests[0]?.body).toBeInstanceOf(FormData)
    expect((requests[0]?.body as FormData).get('model')).toBe('gpt-image-2')
    expect((requests[0]?.body as FormData).get('image')).toBeInstanceOf(Blob)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('Given 越界参考图 When 调用 Then 在 fetch 前拒绝', async () => {
  let fetched = false
  await expect(executeOpenAIImages({
    route: createResolvedOpenAIRoute(),
    sessionId: 'session-1',
    prompt: 'Edit',
    referenceImagePaths: ['/private/outside.png'],
    cwd: '/workspace/allowed',
  }, createExecutorDependencies([], {}, () => { fetched = true })))
    .rejects.toThrow('参考图不在授权目录内')
  expect(fetched).toBe(false)
})
```

- [ ] **Step 2: 写响应兼容与失败回滚测试**

```ts
test.each(['b64_json', 'image_base64', 'base64'] as const)(
  'Given %s 响应 When 解析 Then 保存本地结构化附件',
  async (field) => {
    const result = await executeOpenAIImages(
      createExecutionInput(),
      createExecutorDependencies([], { data: [{ [field]: PNG_BASE64 }] }),
    )
    expect(result.imageAttachments[0]).toEqual(expect.objectContaining({
      filename: expect.stringMatching(/^gpt-image-2-/),
      mediaType: 'image/png',
    }))
  },
)

test.each(['url', 'image_url'] as const)(
  'Given %s 响应 When 解析 Then 通过安全下载后保存',
  async (field) => {
    const downloaded: string[] = []
    const result = await executeOpenAIImages(
      createExecutionInput(),
      createExecutorDependencies([], {
        data: [{ [field]: 'https://images.example/result.png' }],
      }, undefined, async (url) => {
        downloaded.push(url)
        return { bytes: PNG_BYTES, mediaType: 'image/png' }
      }),
    )
    expect(downloaded).toEqual(['https://images.example/result.png'])
    expect(result.imageAttachments).toHaveLength(1)
  },
)

test('Given 第二个附件保存失败 When 执行 Then 删除第一个已保存附件', async () => {
  const deleted: string[] = []
  const dependencies = createExecutorDependencies([], {
    data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }],
  })
  let saveCount = 0
  dependencies.saveAttachment = (input) => {
    saveCount += 1
    if (saveCount === 2) throw new Error('保存失败')
    return {
      attachment: {
        id: 'attachment-1',
        filename: input.filename,
        mediaType: input.mediaType,
        localPath: 'session-1/first.png',
        size: PNG_BYTES.length,
      },
    }
  }
  dependencies.deleteAttachment = (path) => { deleted.push(path) }

  await expect(executeOpenAIImages(createExecutionInput(), dependencies)).rejects.toThrow('保存失败')
  expect(deleted).toEqual(['session-1/first.png'])
})
```

- [ ] **Step 3: 运行执行器测试确认 RED**

Run: `bun test apps/electron/src/main/lib/chat-tools/openai-images-executor.test.ts`

Expected: FAIL，提示模块不存在。

- [ ] **Step 4: 实现请求、路径守卫和统一附件结果**

`openai-images-executor.ts` 导出：

```ts
export interface OpenAIImagesExecutorDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  downloadRemoteImage: (url: string, signal?: AbortSignal) => Promise<DownloadedRemoteImage>
  saveAttachment: typeof saveAttachment
  deleteAttachment: typeof deleteAttachment
  createId: () => string
}

export interface ExecuteOpenAIImagesInput {
  route: Extract<ResolvedImageGenerationRoute, { executor: 'openai-images' }>
  sessionId: string
  prompt: string
  referenceImagePaths?: string[]
  cwd?: string
  allowedRoots?: string[]
  aspectRatio?: string
  imageSize?: string
  numberOfImages?: number
  signal?: AbortSignal
}

export interface OpenAIImagesExecutionResult {
  imageAttachments: AgentToolResultImage[]
}

export async function executeOpenAIImages(
  input: ExecuteOpenAIImagesInput,
  dependencies: OpenAIImagesExecutorDependencies = defaultDependencies,
): Promise<OpenAIImagesExecutionResult>
```

尺寸映射固定为：

```ts
function resolveOpenAIImageSize(aspectRatio?: string): string {
  if (aspectRatio === '16:9' || aspectRatio === '4:3') return '1536x1024'
  if (aspectRatio === '9:16' || aspectRatio === '3:4') return '1024x1536'
  return '1024x1024'
}
```

无参考图发送 JSON 到 `${trimmedBaseUrl}/images/generations`；有参考图时必须验证全部传入路径，首版只提交第一张并在工具摘要说明“当前协议使用第一张参考图”，发送 FormData 到 `/images/edits`。`model` 只取 `route.snapshot.modelId`，`Authorization` 只取 `route.apiKey`。

响应先完整解析并验证所有条目，再保存附件；Base64 使用严格字符与解码后图片签名校验，URL 使用 `downloadSafeRemoteImage`。保存中途失败时用 `deleteAttachment(localPath)` 回滚本轮已保存项。错误摘要只包含 HTTP 状态、服务 request ID 和最多 200 字符的清洗消息，不包含请求 header、API Key、完整 prompt、Base64 或本地路径。

- [ ] **Step 5: 在稳定 Pi 图片工具内按 executor 分派**

保留工具 ID `mcp__nano_banana__generate_image`，因为它已经是 Agent JSONL 图片附件归属的授权契约。把 context 中的字段替换为 `resolveTrustedImageRoute`，execute 开头解析一次：

```ts
const resolvedRoute = ctx.trustedImageRoute
  ? ctx.resolveTrustedImageRoute?.(ctx.trustedImageRoute)
  : undefined
if (ctx.trustedImageRoute && !resolvedRoute) {
  throw new Error('设计任务缺少可信生图模型实时解析，已拒绝执行')
}

const result = resolvedRoute?.executor === 'openai-images'
  ? await executeOpenAIImages({
      route: resolvedRoute,
      sessionId: ctx.sessionId,
      prompt: String(args.prompt),
      referenceImagePaths: normalizeStringArray(args.referenceImagePaths),
      cwd: ctx.agentCwd,
      allowedRoots: ctx.allowedRoots,
      aspectRatio: normalizeOptionalString(args.aspectRatio),
      imageSize: normalizeOptionalString(args.imageSize),
      numberOfImages: normalizeOptionalNumber(args.numberOfImages),
      signal,
    })
  : await callGeminiAndBuildResult(String(args.prompt), ctx.sessionId, {
      aspectRatio: normalizeOptionalString(args.aspectRatio),
      imageSize: normalizeOptionalString(args.imageSize),
      referenceImagePaths: normalizeStringArray(args.referenceImagePaths),
      cwd: ctx.agentCwd,
      allowedRoots: ctx.allowedRoots,
      numberOfImages: normalizeOptionalNumber(args.numberOfImages),
      trustedImageRoute: ctx.trustedImageRoute,
    }, signal)
```

把 OpenAI 结果转换成现有 `McpToolResult` 形状后继续复用 `toPiToolResult`。`details.source: 'proma-nano-banana'` 暂时保留为历史授权标记，其含义是“由 Proma 内置稳定图片工具本地保存”，不是供应商名称；这样旧会话解析和图片归属安全链无需改动。

- [ ] **Step 6: 运行执行器与 Pi 工具测试确认 GREEN**

Run: `bun test apps/electron/src/main/lib/chat-tools/openai-images-executor.test.ts apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/lib/design/design-session-bridge.test.ts`

Expected: PASS；普通 Chat 在未注入可信 route 时仍只走 Nano Banana，Design GPT route 不读取 `chat-tools.json` 的 Nano Banana API Key。

- [ ] **Step 7: 提交 GPT Image 2 执行链**

```bash
git add apps/electron/src/main/lib/chat-tools/openai-images-executor.ts apps/electron/src/main/lib/chat-tools/openai-images-executor.test.ts apps/electron/src/main/lib/chat-tools/nano-banana-mcp.ts apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.ts
git commit -m "设计：接入 GPT Image 2 生图执行器"
```

## Task 7: 将生图设置迁移到模型配置页面

**Files:**
- Modify: `apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.tsx`
- Modify: `apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.test.tsx`
- Modify: `apps/electron/src/renderer/components/settings/ChannelSettings.tsx`
- Modify: `apps/electron/src/renderer/components/settings/ChannelSettings.test.tsx`
- Modify: `apps/electron/src/renderer/components/settings/ToolSettings.tsx`
- Modify: `apps/electron/src/renderer/atoms/settings-tab.ts`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.tsx`
- Modify: `apps/electron/src/renderer/components/design/DesignInspector.test.tsx`
- Modify: `apps/electron/src/renderer/components/design/design-accessibility.test.tsx`

- [ ] **Step 1: 写失败测试锁定设置归属和 Design 跳转**

```ts
test('Given 设置列表 When 渲染模型配置 Then 生图设置位于渠道区块之后', () => {
  const source = readFileSync(new URL('./ChannelSettings.tsx', import.meta.url), 'utf8')
  expect(source.indexOf('title="模型配置"'))
    .toBeLessThan(source.indexOf('<ImageGenerationModelSettings />'))
  expect(source).toContain('<ImageGenerationModelSettings />')
})

test('Given Chat 工具设置 When 渲染 Then 不再重复展示 Design 生图目录', () => {
  const source = readFileSync(new URL('./ToolSettings.tsx', import.meta.url), 'utf8')
  expect(source).not.toContain('<ImageGenerationModelSettings />')
  expect(source).toContain('<NanoBananaSettings />')
})

test('Given Design 无可用模型 When 点击前往配置 Then 打开模型配置并聚焦生图区块', () => {
  const source = readFileSync(new URL('../design/DesignInspector.tsx', import.meta.url), 'utf8')
  expect(source).toContain("setSettingsTab('channels')")
  expect(source).toContain("setChannelSettingsFocus('image-models')")
  expect(source).not.toContain("setToolSettingsFocus('nano-banana')")
})
```

- [ ] **Step 2: 写失败测试覆盖 channel-backed 表单联动**

```ts
test('Given GPT Image profile When 选择渠道 Then 模型下拉只显示该渠道启用模型', () => {
  const profile = createOpenAIProfile({ channelId: 'channel-gpt', modelId: 'gpt-image-2' })
  const models = getImageGenerationProfileModels(profile, [{
    channelId: 'channel-gpt',
    name: 'GPT Image 服务',
    available: true,
    models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
  }, {
    channelId: 'channel-other',
    name: '其它服务',
    available: true,
    models: [{ id: 'other-image', name: '其它图片模型' }],
  }])
  expect(models).toEqual([{ id: 'gpt-image-2', name: 'GPT Image 2' }])
})

test('Given 新建 OpenAI Images profile 未选渠道 When 保存 Then 本地校验阻断', () => {
  expect(validateImageGenerationModelProfiles([
    createOpenAIProfile({ channelId: '', modelId: '' }),
  ])).toBe('请选择模型配置')
})
```

测试文件新增稳定 helper：

```ts
function createOpenAIProfile(
  overrides: Partial<Extract<ImageGenerationModelProfile, { executor: 'openai-images' }>> = {},
): Extract<ImageGenerationModelProfile, { executor: 'openai-images' }> {
  return {
    id: 'profile-gpt',
    name: 'GPT Image 2',
    executor: 'openai-images',
    channelId: 'channel-gpt',
    modelId: 'gpt-image-2',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}
```

- [ ] **Step 3: 运行设置测试确认 RED**

Run: `bun test apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.test.tsx apps/electron/src/renderer/components/settings/ChannelSettings.test.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx apps/electron/src/renderer/components/design/design-accessibility.test.tsx`

Expected: FAIL，生图设置仍在 `ToolSettings`，且 profile 表单没有渠道与协议选择器。

- [ ] **Step 4: 扩展设置状态与 profile 编辑规则**

`ImageGenerationModelSettingsState` 增加 `channelOptions`，`request-succeeded` 和 `save-succeeded` 从 catalog 同步该字段。dirty 比较和保存整理按 executor 处理：

```ts
function haveSameEditableProfile(
  left: ImageGenerationModelProfile,
  right: ImageGenerationModelProfile,
): boolean {
  if (left.executor !== right.executor) return false
  return left.id === right.id
    && left.name.trim() === right.name.trim()
    && left.modelId.trim() === right.modelId.trim()
    && left.enabled === right.enabled
    && (left.executor !== 'openai-images'
      || (right.executor === 'openai-images' && left.channelId === right.channelId))
}
```

模型下拉使用独立纯函数，避免 UI 通过全局渠道缓存拼接错误模型：

```ts
export function getImageGenerationProfileModels(
  profile: ImageGenerationModelProfile,
  channelOptions: readonly ImageGenerationChannelOption[],
): ImageGenerationChannelOption['models'] {
  if (profile.executor !== 'openai-images') return []
  return channelOptions.find((channel) => channel.channelId === profile.channelId)?.models ?? []
}
```

新增 profile 时默认创建 channel-backed GPT Image 路由：

```ts
function createImageGenerationModelProfile(id: string, now: number): ImageGenerationModelProfile {
  return {
    id,
    name: 'GPT Image 2',
    executor: 'openai-images',
    channelId: '',
    modelId: '',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
}
```

`validateImageGenerationModelProfiles` 对 `openai-images` 依次校验 executor、channelId、modelId、渠道存在和模型存在；Nano legacy 继续校验名称/modelId，并只在存在 Nano profile 时使用 `credentialsConfigured` 阻断保存。

- [ ] **Step 5: 按现有视觉规范渲染三个选择器**

每个 channel-backed profile 使用现有 `Select/SelectTrigger/SelectContent/SelectItem`，固定顺序为名称、模型配置、模型、调用协议、启用、删除。调用协议首版只有两个明确选项：`OpenAI Images` 和 legacy 行只读的 `Nano Banana`。渠道变化时执行：

```ts
const updateChannel = (profileId: string, channelId: string): void => {
  const channel = channelOptions.find((candidate) => candidate.channelId === channelId)
  const firstModelId = channel?.models[0]?.id ?? ''
  updateProfile(profileId, { channelId, modelId: firstModelId })
}
```

触发器统一 `h-8 rounded text-xs`，长名称使用 `min-w-0 truncate`，不可用 profile 行显示主进程返回的清洗原因。页面不展示 Base URL、加密 apiKey 或解密入口。

- [ ] **Step 6: 迁移挂载点和聚焦 atom**

在 `settings-tab.ts` 增加：

```ts
export type ChannelSettingsFocus = 'image-models'
export const channelSettingsFocusAtom = atom<ChannelSettingsFocus | null>(null)
```

`ChannelSettings` 读取 atom，给 `<ImageGenerationModelSettings />` 外层 `ref`；聚焦时使用与 ToolSettings 相同的 `requestAnimationFrame + scrollIntoView`，随后清空 atom。`ToolSettings` 删除 `ImageGenerationModelSettings` import 和 JSX，只保留 `NanoBananaSettings`。

`DesignInspector` 的入口改为：

```ts
const handleConfigureImageModels = React.useCallback((): void => {
  setSettingsTab('channels')
  setChannelSettingsFocus('image-models')
  setSettingsOpen(true)
}, [setChannelSettingsFocus, setSettingsOpen, setSettingsTab])
```

Tooltip 改为“打开模型配置中的生图模型设置”。

- [ ] **Step 7: 运行 Renderer 测试确认 GREEN**

Run: `bun test apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.test.tsx apps/electron/src/renderer/components/settings/ChannelSettings.test.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx apps/electron/src/renderer/components/design/design-accessibility.test.tsx`

Expected: PASS；旧渠道加载错误保留最近成功列表，dirty 生图表单收到渠道广播时不被覆盖。

- [ ] **Step 8: 提交设置入口迁移**

```bash
git add apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.tsx apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.test.tsx apps/electron/src/renderer/components/settings/ChannelSettings.tsx apps/electron/src/renderer/components/settings/ChannelSettings.test.tsx apps/electron/src/renderer/components/settings/ToolSettings.tsx apps/electron/src/renderer/atoms/settings-tab.ts apps/electron/src/renderer/components/design/DesignInspector.tsx apps/electron/src/renderer/components/design/DesignInspector.test.tsx apps/electron/src/renderer/components/design/design-accessibility.test.tsx
git commit -m "设计：将生图配置迁入模型设置"
```

## Task 8: 完成跨层回归、构建与真实交互验收

**Files:**
- Modify only when a verification failure proves a scoped defect in files already listed above.

- [ ] **Step 1: 运行 shared、目录、IPC 和任务相关测试**

Run:

```bash
bun test \
  packages/shared/src/types/design.test.ts \
  apps/electron/src/main/lib/image-generation-model-catalog.test.ts \
  apps/electron/src/main/lib/image-model-profile-broadcast.test.ts \
  apps/electron/src/main/lib/design/design-image-model-preferences.test.ts \
  apps/electron/src/main/lib/design/design-ipc.test.ts \
  apps/electron/src/main/lib/design/design-job-manager.test.ts \
  apps/electron/src/main/lib/design/design-recovery.test.ts
```

Expected: PASS，无旧 journal、项目偏好或 IPC 回归。

- [ ] **Step 2: 运行图片工具和附件安全测试**

Run:

```bash
bun test \
  apps/electron/src/main/lib/chat-tools/safe-remote-image.test.ts \
  apps/electron/src/main/lib/chat-tools/openai-images-executor.test.ts \
  apps/electron/src/main/lib/chat-tools/nano-banana-mcp.test.ts \
  apps/electron/src/main/lib/agent-session-manager.test.ts \
  apps/electron/src/main/lib/design/design-session-bridge.test.ts \
  apps/electron/src/main/lib/agent-design-tool-policy.test.ts
```

Expected: PASS；可信路由不能被 Agent 参数覆盖，URL 下载不能访问私网，附件仍需稳定工具调用证明。

- [ ] **Step 3: 运行 Renderer 相关测试**

Run:

```bash
bun test \
  apps/electron/src/renderer/components/settings/ImageGenerationModelSettings.test.tsx \
  apps/electron/src/renderer/components/settings/ChannelSettings.test.tsx \
  apps/electron/src/renderer/components/design/DesignInspector.test.tsx \
  apps/electron/src/renderer/components/design/design-accessibility.test.tsx \
  apps/electron/src/renderer/components/design/use-design-image-model-selection.test.ts
```

Expected: PASS。

- [ ] **Step 4: 运行全仓隔离测试、类型检查和 Electron 构建**

Run:

```bash
bun test --isolate
bun run typecheck
bun run electron:build
```

Expected: 全部退出码为 0；构建不新增 external、Python 或运行时依赖。

- [ ] **Step 5: 在真实 Electron 中验证设置与 Design 交互**

使用现有 `bun run dev` 开发实例，验证：

1. “模型配置”中渠道列表后显示“生图模型”，Chat 工具页只保留 Nano Banana 工具设置；
2. 新增 GPT Image 2 profile 时可选择渠道、`gpt-image-2` 和 OpenAI Images；
3. 渠道停用、删除或移除模型后 profile 保留并显示不可用，Design 不静默回退；
4. 从 Design 无模型状态进入设置时准确滚动到生图区块；
5. 设计项目 A/B 保留各自选择，创建任务节点显示固化的配置名与模型 ID；
6. 1000px 和 620px 宽度下无重叠、截断异常或布局跳动；
7. light/dark 主题、键盘导航、焦点环、加载、保存和错误状态符合当前 Proma 视觉规范。

Expected: 所有交互通过；截图记录设置页宽/窄和 Design 选择器至少各一张。

- [ ] **Step 6: 使用用户配置的测试服务验证真实 GPT Image 2 链路**

只在用户已经于 Proma 模型配置中提供 API Key 时执行，禁止把凭据复制到命令、测试 fixture 或日志。验证两条最小计费路径：

1. 文生图：1:1、1 张、短提示词，确认 Agent LLM 完成后只出现一次 Images API 调用；
2. 单参考图编辑：选择项目内一张素材，确认走 `/images/edits` 并返回本地 Design 素材。

Expected: 两个任务成功；任务 journal 只含 `profileId/name/executor/channelId/modelId`，不含 API Key、Base URL、Base64 或完整 prompt。若本机未配置凭据，明确记录该验证缺口，不制造测试密钥或外部计费。

- [ ] **Step 7: 检查最终 diff 并提交验证修正**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: 无空白错误；变更仅落在本计划文件清单。验证失败产生的修正必须回到对应 Task 的 RED/GREEN 步骤并包含在该 Task 提交中；验证全部通过时不创建空提交。

## 完成标准

- `ChannelModel`、`ChannelForm`、`Channel` 持久化 schema 没有生图能力字段；
- schema v1 Nano Banana 目录与旧 journal 继续可读，下一次保存才写 schema v2；
- GPT Image 2 profile 只引用现有渠道，API Key 只在主进程单次 resolved route 内存在；
- Design 任务固定执行 Agent LLM 后的一次可信图片工具调用，不允许模型参数覆盖或静默回退；
- `/images/generations`、`/images/edits`、Base64 和安全 URL 响应均有自动化覆盖；
- 设置入口统一为“模型配置 > 生图模型”，Chat 工具不再重复配置 Design profile；
- 定向测试、`bun test --isolate`、`bun run typecheck`、`bun run electron:build` 和真实 Electron 交互验收通过或明确记录唯一外部凭据缺口。
