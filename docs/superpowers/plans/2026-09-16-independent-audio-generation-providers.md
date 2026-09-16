# Independent Audio Generation Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在媒体设置中交付独立于 LLM Channel 和 ComfyUI 的小米/MiniMax 音频供应商配置，包含加密凭据、CAS 保存、供应商差异化字段、可取消连接测试和四个一级分区。

**Architecture:** Shared 提供严格判别联合、parser、供应商公开描述与 Media IPC 合同；Main 使用独立 JSON Store 和 safeStorage 保存密文，以单一 catalog revision 完整替换；测试服务按窗口/requestId 管理 AbortController，未取得官方 TTS 合同时返回 `unavailable`。Renderer 新增独立 `AudioGenerationSettings`，只复用现有设置页 primitives 与交互模式；生图继续使用现有目录并固定过滤 image。

**Tech Stack:** Bun、TypeScript、Electron IPC/safeStorage、React、Jotai、Radix/shadcn、Bun Test。

---

## File Map

### Create

- `packages/shared/src/types/audio-generation.ts`：音频供应商、公开/持久化边界 DTO、strict parser、provider descriptors 和测试结果。
- `packages/shared/src/types/audio-generation.test.ts`：Shared BDD 合同。
- `apps/electron/src/main/lib/media/audio-generation-config-store.ts`：独立 catalog CAS、safeStorage 加解密、公开投影和旧 Profile 引用验证。
- `apps/electron/src/main/lib/media/audio-generation-config-store.test.ts`：原子保存、冲突、密文、safeStorage 和损坏文件测试。
- `apps/electron/src/main/lib/media/audio-generation-test-service.ts`：按 owner/requestId 管理测试、取消和不可用 adapter。
- `apps/electron/src/main/lib/media/audio-generation-test-service.test.ts`：测试生命周期、取消、迟到结果与秘密边界。
- `apps/electron/src/renderer/components/settings/AudioGenerationSettings.tsx`：音频配置列表、表单、测试状态和旧配置迁移提示。
- `apps/electron/src/renderer/components/settings/AudioGenerationSettings.test.tsx`：供应商字段、Key、CRUD、测试状态与迁移 UI。
- `apps/electron/scripts/audio-generation-settings-smoke.html`：隔离 Electron Renderer 入口。
- `apps/electron/scripts/audio-generation-settings-smoke-renderer.tsx`：固定 fixture 与交互观察接口。
- `apps/electron/scripts/audio-generation-settings-smoke.ts`：真实 Electron 深浅主题和双 viewport 断言。

### Modify

- `packages/shared/src/types/index.ts`：导出音频合同。
- `packages/shared/src/types/media.ts`：扩展媒体 IPC 通道和 `MediaPreloadApi`。
- `apps/electron/src/main/lib/config-paths.ts`：固定 `audio-generation-profiles.json` 路径。
- `apps/electron/src/main/lib/media/media-ipc.ts`：注册读取、替换、测试和取消通道，绑定窗口销毁清理。
- `apps/electron/src/main/lib/media/media-ipc.test.ts`：授权、strict envelope、owner 清理和旧目录组合读取。
- `apps/electron/src/main/ipc.ts`：延迟创建唯一 Store/TestService，并向 Media IPC 注入旧模型目录投影。
- `apps/electron/src/preload/media-preload.ts`：暴露音频配置 bridge。
- `apps/electron/src/preload/media-preload.test.ts`：固定通道和 payload。
- `apps/electron/src/renderer/components/settings/MediaSettings.tsx`：四个一级分区和音频页挂载。
- `apps/electron/src/renderer/components/settings/MediaSettings.test.tsx`：四标签与旧 focus 映射。
- `apps/electron/src/renderer/components/settings/MediaApiModelSettings.tsx`：固定 image 模式，不展示旧 audio/video。
- `apps/electron/src/renderer/components/settings/MediaApiModelSettings.test.tsx`：固定过滤与保存保留其它媒体类型。
- `apps/electron/package.json`：新增真实 Electron smoke 命令。

## Task 1: Shared 音频配置合同

**Files:**
- Create: `packages/shared/src/types/audio-generation.ts`
- Create: `packages/shared/src/types/audio-generation.test.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/types/media.ts`

- [ ] **Step 1: 写供应商判别联合与 strict parser 的失败测试**

```ts
test('Given 小米与 MiniMax 配置 When 严格解析 Then 清洗字段并保留供应商差异', () => {
  expect(parseAudioGenerationProfile({
    id: 'audio-1', name: ' 小米语音 ', provider: 'xiaomi', baseUrl: 'https://tts.example/v1/',
    modelId: 'mimo-tts', voiceId: 'voice-1', enabled: true, createdAt: 1, updatedAt: 2,
  })).toMatchObject({ name: '小米语音', provider: 'xiaomi' })
  expect(parseAudioGenerationProfile({
    id: 'audio-2', name: 'MiniMax', provider: 'minimax', baseUrl: 'https://api.minimax.example/',
    modelId: 'speech-02', voiceId: 'female-1', groupId: 'group-1', enabled: true, createdAt: 1, updatedAt: 2,
  })).toMatchObject({ provider: 'minimax', groupId: 'group-1' })
})

test('Given URL 内嵌凭据或供应商字段错配 When 解析 Then 拒绝', () => {
  expect(() => parseAudioGenerationProfile({ ...xiaomiProfile, baseUrl: 'https://token@example.com/v1' })).toThrow('AUDIO_GENERATION_URL_INVALID')
  expect(() => parseAudioGenerationProfile({ ...xiaomiProfile, groupId: 'forbidden' })).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
})

test('Given provider union When 读取公开描述 Then 每个 provider 恰有一个描述', () => {
  expect(AUDIO_GENERATION_PROVIDER_DESCRIPTORS.map((item) => item.provider)).toEqual(['xiaomi', 'minimax'])
})
```

- [ ] **Step 2: 运行 Shared 测试并确认因模块不存在而失败**

Run: `bun test packages/shared/src/types/audio-generation.test.ts`

Expected: FAIL，错误包含 `Cannot find module './audio-generation'`。

- [ ] **Step 3: 实现 Shared 类型、描述与 parser**

```ts
export type AudioGenerationProvider = 'xiaomi' | 'minimax'

export interface AudioGenerationProfileBase {
  id: string
  name: string
  baseUrl: string
  modelId: string
  voiceId: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  legacyMediaProfileId?: string
}

export type AudioGenerationProfile =
  | (AudioGenerationProfileBase & { provider: 'xiaomi' })
  | (AudioGenerationProfileBase & { provider: 'minimax'; groupId?: string })

export type AudioGenerationCredentialUpdate =
  | { mode: 'preserve' }
  | { mode: 'replace'; apiKey: string }

export interface ReplaceAudioGenerationCatalogRequest {
  expectedRevision: number
  profiles: Array<{ profile: AudioGenerationProfile; credentialUpdate: AudioGenerationCredentialUpdate }>
}

export interface AudioGenerationPublicProfile extends AudioGenerationProfile {
  credentialConfigured: boolean
  endpointOrigin: string
}

export interface AudioGenerationPublicCatalog {
  schemaVersion: 1
  revision: number
  profiles: AudioGenerationPublicProfile[]
}

export interface LegacyAudioProfileSummary {
  id: string
  name: string
  protocol: 'minimax-speech'
  modelId: string
  enabled: boolean
}

export interface AudioGenerationSettingsResult {
  catalog: AudioGenerationPublicCatalog
  legacyAudioProfiles: LegacyAudioProfileSummary[]
  legacyWarning?: string
}

export const AUDIO_GENERATION_PROVIDER_DESCRIPTORS = [
  { provider: 'xiaomi', label: '小米 TTS', specificFields: [] },
  { provider: 'minimax', label: 'MiniMax Speech', specificFields: ['groupId'] },
] as const satisfies readonly Array<{
  provider: AudioGenerationProvider
  label: string
  specificFields: readonly ('groupId')[]
}>
```

Parser 必须只接受声明字段；Base URL 仅允许 HTTP(S)，拒绝 username/password/search/hash，返回去掉尾部重复 `/` 后的稳定 URL；所有文本使用固定长度上限，ID 使用仓库现有安全标识规则。

- [ ] **Step 4: 扩展媒体 IPC 与 Preload 类型**

```ts
export const MEDIA_IPC_CHANNELS = {
  // existing channels...
  GET_AUDIO_GENERATION_SETTINGS: 'media:get-audio-generation-settings',
  REPLACE_AUDIO_GENERATION_CATALOG: 'media:replace-audio-generation-catalog',
  TEST_AUDIO_GENERATION: 'media:test-audio-generation',
  CANCEL_AUDIO_GENERATION_TEST: 'media:cancel-audio-generation-test',
} as const

export interface MediaPreloadApi {
  // existing methods...
  mediaGetAudioGenerationSettings(): Promise<AudioGenerationSettingsResult>
  mediaReplaceAudioGenerationCatalog(input: ReplaceAudioGenerationCatalogRequest): Promise<AudioGenerationSettingsResult>
  mediaTestAudioGeneration(input: AudioGenerationTestInput): Promise<AudioGenerationTestResult>
  mediaCancelAudioGenerationTest(requestId: string): Promise<void>
}
```

`AudioGenerationTestInput` 使用判别联合表示 `draft` 与 `saved`，两者都包含 `requestId`；`AudioGenerationTestResult` 固定为 `success | failed | cancelled | unavailable`，只公开归一化中文 message。

- [ ] **Step 5: 运行 Shared 测试与类型检查**

Run: `bun test packages/shared/src/types/audio-generation.test.ts packages/shared/src/types/design.test.ts`

Expected: PASS，0 fail。

Run: `bun run --filter @proma/shared typecheck`

Expected: exit 0。

- [ ] **Step 6: 提交 Shared 合同**

```bash
git add packages/shared/src/types/audio-generation.ts packages/shared/src/types/audio-generation.test.ts packages/shared/src/types/index.ts packages/shared/src/types/media.ts
git commit -m "新增独立音频供应商配置合同"
```

## Task 2: 独立加密配置 Store

**Files:**
- Create: `apps/electron/src/main/lib/media/audio-generation-config-store.ts`
- Create: `apps/electron/src/main/lib/media/audio-generation-config-store.test.ts`
- Modify: `apps/electron/src/main/lib/config-paths.ts`

- [ ] **Step 1: 写空目录、加密保存、CAS 和 fail-closed 测试**

```ts
test('Given 首次读取 When 文件不存在 Then 返回 revision 0 空目录', () => {
  expect(store.readPublic()).toEqual({ schemaVersion: 1, revision: 0, profiles: [] })
})

test('Given 新配置与 API Key When 替换目录 Then 仅持久化 safeStorage 密文', () => {
  const result = store.replace({ expectedRevision: 0, profiles: [{ profile: xiaomi, credentialUpdate: { mode: 'replace', apiKey: 'secret-key' } }] })
  expect(result.profiles[0]).toMatchObject({ credentialConfigured: true, endpointOrigin: 'https://tts.example' })
  const saved = readFileSync(configPath, 'utf8')
  expect(saved).not.toContain('secret-key')
  expect(saved).toContain(Buffer.from('encrypted:secret-key').toString('base64'))
})

test('Given 旧 revision When 替换 Then 保留原文件并返回冲突', () => {
  store.replace(firstRequest)
  expect(() => store.replace(firstRequest)).toThrow('AUDIO_GENERATION_CONFIG_CONFLICT')
})

test('Given safeStorage 不可用 When 新增凭据 Then 不写文件', () => {
  const unavailable = createStore({ isEncryptionAvailable: () => false })
  expect(() => unavailable.replace(firstRequest)).toThrow('AUDIO_GENERATION_SECURE_STORAGE_UNAVAILABLE')
  expect(existsSync(configPath)).toBeFalse()
})
```

- [ ] **Step 2: 运行 Store 测试并确认失败**

Run: `bun test apps/electron/src/main/lib/media/audio-generation-config-store.test.ts`

Expected: FAIL，错误包含 `Cannot find module './audio-generation-config-store'`。

- [ ] **Step 3: 固定配置路径和 Store 依赖**

```ts
export function getAudioGenerationProfilesPath(): string {
  return join(getConfigDir(), 'audio-generation-profiles.json')
}

export interface AudioGenerationSecureStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface AudioGenerationConfigStoreOptions {
  configPath: string
  secureStorage: AudioGenerationSecureStorage
  now?: () => number
}
```

- [ ] **Step 4: 实现 strict read、完整替换 CAS 和公开投影**

Store 使用 `acquireMediaFileLock(`${configPath}.lock`)` 串行化读取 revision、密文合并与写入。`preserve` 只允许已存在的同 ID Profile；新 ID 必须 `replace`。写入使用 `writeJsonFileAtomicSecure`，文件上限 1 MiB、Profile 上限 128。`readPublic()` 不解密密文；`resolveApiKey(id)` 仅供测试服务按需解密。

```ts
replace(input: ReplaceAudioGenerationCatalogRequest): AudioGenerationPublicCatalog {
  const request = parseReplaceAudioGenerationCatalogRequest(input)
  return this.withLock(() => {
    const current = this.readPersisted()
    if (current.revision !== request.expectedRevision) throw new Error('AUDIO_GENERATION_CONFIG_CONFLICT')
    const encryptedById = new Map(current.profiles.map((item) => [item.profile.id, item.encryptedApiKey]))
    const nextProfiles = request.profiles.map(({ profile, credentialUpdate }) => ({
      profile: { ...profile, updatedAt: this.now() },
      encryptedApiKey: credentialUpdate.mode === 'preserve'
        ? this.requireExistingCiphertext(encryptedById, profile.id)
        : this.encrypt(credentialUpdate.apiKey),
    }))
    const next = { schemaVersion: 1 as const, revision: current.revision + 1, profiles: nextProfiles }
    writeJsonFileAtomicSecure(this.configPath, next)
    return toPublicCatalog(next)
  })
}
```

- [ ] **Step 5: 补齐边界测试并运行**

增加：损坏 JSON 不回退空目录、重复 ID、非法密文、`preserve` 新 ID、删除物理移除密文、非秘密字段更新在 safeStorage 不可用时仍保留原密文、列表只展示 URL origin。

Run: `bun test apps/electron/src/main/lib/media/audio-generation-config-store.test.ts`

Expected: PASS，0 fail。

- [ ] **Step 6: 提交 Store**

```bash
git add apps/electron/src/main/lib/config-paths.ts apps/electron/src/main/lib/media/audio-generation-config-store.ts apps/electron/src/main/lib/media/audio-generation-config-store.test.ts
git commit -m "实现音频供应商加密配置存储"
```

## Task 3: 可取消的供应商测试服务

**Files:**
- Create: `apps/electron/src/main/lib/media/audio-generation-test-service.ts`
- Create: `apps/electron/src/main/lib/media/audio-generation-test-service.test.ts`

- [ ] **Step 1: 写 owner/requestId、取消和 unavailable 的失败测试**

```ts
test('Given 同窗口同配置第二次测试 When 新请求开始 Then 取消旧请求且只返回新身份', async () => {
  const first = service.test(7, draftInput('request-1'))
  const second = service.test(7, draftInput('request-2'))
  expect(await first).toMatchObject({ state: 'cancelled', requestId: 'request-1' })
  expect(await second).toMatchObject({ state: 'success', requestId: 'request-2' })
})

test('Given 小米没有验证合同 When 测试 Then 不发网络请求并返回 unavailable', async () => {
  expect(await service.test(7, draftInput('request-1', 'xiaomi'))).toEqual({
    state: 'unavailable', requestId: 'request-1', message: '小米 TTS 尚缺少已验证的官方测试接口',
  })
  expect(fetchCalls).toBe(0)
})

test('Given 窗口销毁 When 释放 owner Then 所有活动测试被取消', async () => {
  const pending = service.test(7, draftInput('request-1'))
  service.releaseOwner(7)
  expect(await pending).toMatchObject({ state: 'cancelled' })
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test apps/electron/src/main/lib/media/audio-generation-test-service.test.ts`

Expected: FAIL，错误包含 `Cannot find module './audio-generation-test-service'`。

- [ ] **Step 3: 实现测试器边界和请求注册表**

```ts
export interface AudioGenerationProviderTester {
  test(input: AudioGenerationResolvedTestInput, signal: AbortSignal): Promise<Omit<AudioGenerationTestResult, 'requestId'>>
}

const unavailableTesters: Record<AudioGenerationProvider, AudioGenerationProviderTester> = {
  xiaomi: { test: async () => ({ state: 'unavailable', message: '小米 TTS 尚缺少已验证的官方测试接口' }) },
  minimax: { test: async () => ({ state: 'unavailable', message: 'MiniMax Speech 尚缺少已验证的官方测试接口' }) },
}
```

`AudioGenerationTestService` 使用 `Map<number, Map<string, ActiveTest>>` 保存 owner/requestId；相同 owner 与 profileId/draftDigest 的新请求先 abort 旧请求。`testSaved` 通过 Store 按需解密；`testDraft` 只使用 IPC 明文，不缓存。`cancel(ownerId, requestId)` 与 `releaseOwner(ownerId)` 都幂等。

- [ ] **Step 4: 增加注入 fake tester 的生命周期与脱敏测试**

覆盖 tester 抛出含 `Bearer secret-key` 的异常时只返回 `failed` 稳定文案；服务不得把原异常、Base URL path/query 或 API Key放入结果。确认测试 Promise 收口后活动 Map 为空。

Run: `bun test apps/electron/src/main/lib/media/audio-generation-test-service.test.ts`

Expected: PASS，0 fail。

- [ ] **Step 5: 提交测试服务**

```bash
git add apps/electron/src/main/lib/media/audio-generation-test-service.ts apps/electron/src/main/lib/media/audio-generation-test-service.test.ts
git commit -m "新增音频供应商连接测试生命周期"
```

## Task 4: Media IPC、Preload 与主进程装配

**Files:**
- Modify: `apps/electron/src/main/lib/media/media-ipc.ts`
- Modify: `apps/electron/src/main/lib/media/media-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/media-preload.ts`
- Modify: `apps/electron/src/preload/media-preload.test.ts`

- [ ] **Step 1: 写 Preload 通道失败测试**

```ts
test('Given 音频设置调用 When 通过 preload Then 只发送固定结构', async () => {
  await api.mediaReplaceAudioGenerationCatalog(request)
  await api.mediaTestAudioGeneration(testInput)
  await api.mediaCancelAudioGenerationTest('request-1')
  expect(calls).toEqual([
    { channel: MEDIA_IPC_CHANNELS.REPLACE_AUDIO_GENERATION_CATALOG, input: request },
    { channel: MEDIA_IPC_CHANNELS.TEST_AUDIO_GENERATION, input: testInput },
    { channel: MEDIA_IPC_CHANNELS.CANCEL_AUDIO_GENERATION_TEST, input: { requestId: 'request-1' } },
  ])
})
```

- [ ] **Step 2: 写 Media IPC 授权、组合读取和 destroyed 清理失败测试**

```ts
test('Given 已授权设置窗口 When 读取音频设置 Then 合并独立目录与只读旧音频摘要', async () => {
  const result = handlers.get(MEDIA_IPC_CHANNELS.GET_AUDIO_GENERATION_SETTINGS)!(event)
  expect(result).toEqual({ catalog, legacyAudioProfiles: [legacyMiniMax] })
})

test('Given 测试进行中 When sender destroyed Then releaseOwner 取消该窗口请求', async () => {
  await handlers.get(MEDIA_IPC_CHANNELS.TEST_AUDIO_GENERATION)!(event, input)
  sender.emit('destroyed')
  expect(releasedOwners).toEqual([sender.id])
})
```

- [ ] **Step 3: 运行 IPC/Preload 测试并确认缺少新通道**

Run: `bun test apps/electron/src/preload/media-preload.test.ts apps/electron/src/main/lib/media/media-ipc.test.ts`

Expected: FAIL，错误指向音频 Preload 方法或 IPC handler 未定义。

- [ ] **Step 4: 扩展 `createMediaPreloadApi` 与 Media IPC options**

```ts
export interface AudioGenerationIpcService {
  listSettings(): AudioGenerationSettingsResult
  replace(input: ReplaceAudioGenerationCatalogRequest): AudioGenerationSettingsResult
  test(ownerId: number, input: AudioGenerationTestInput): Promise<AudioGenerationTestResult>
  cancel(ownerId: number, requestId: string): void
  releaseOwner(ownerId: number): void
}
```

Media IPC 对所有 envelope 运行 Shared parser；首次测试时为 sender 注册一次 `destroyed` listener，dispose 时移除 listener、逐 owner 调用 `releaseOwner`。旧目录读取失败只返回 `legacyWarning`；独立目录读取失败直接抛出稳定错误。

- [ ] **Step 5: 在 `ipc.ts` 延迟创建唯一音频服务**

```ts
let audioGenerationStore: AudioGenerationConfigStore | undefined
let audioGenerationTests: AudioGenerationTestService | undefined

function getAudioGenerationStore(): AudioGenerationConfigStore {
  return audioGenerationStore ??= new AudioGenerationConfigStore({
    configPath: getAudioGenerationProfilesPath(),
    secureStorage: safeStorage,
  })
}
```

`listSettings()` 调用 `getDesignImageModelServices().imageModels.listMediaApiCatalog()`，只投影 protocol 为 `minimax-speech` 的旧条目；重复旧 ID 或读取异常生成脱敏 warning。`replace()` 对新引入的 `legacyMediaProfileId` 复核旧条目存在且协议正确。应用退出和 Media IPC dispose 调用测试服务 `dispose()`。

- [ ] **Step 6: 运行 IPC、Preload 与主进程类型检查**

Run: `bun test apps/electron/src/preload/media-preload.test.ts apps/electron/src/main/lib/media/media-ipc.test.ts apps/electron/src/main/lib/media/audio-generation-config-store.test.ts apps/electron/src/main/lib/media/audio-generation-test-service.test.ts`

Expected: PASS，0 fail。

Run: `bun run --filter @proma/electron typecheck`

Expected: exit 0。

- [ ] **Step 7: 提交 IPC 链路**

```bash
git add apps/electron/src/main/lib/media/media-ipc.ts apps/electron/src/main/lib/media/media-ipc.test.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/media-preload.ts apps/electron/src/preload/media-preload.test.ts
git commit -m "接入音频供应商配置 IPC"
```

## Task 5: 四分区导航与生图固定过滤

**Files:**
- Modify: `apps/electron/src/renderer/components/settings/MediaSettings.tsx`
- Modify: `apps/electron/src/renderer/components/settings/MediaSettings.test.tsx`
- Modify: `apps/electron/src/renderer/components/settings/MediaApiModelSettings.tsx`
- Modify: `apps/electron/src/renderer/components/settings/MediaApiModelSettings.test.tsx`

- [ ] **Step 1: 写四标签和固定 image 过滤的失败测试**

```ts
test('Given 媒体设置 When 渲染一级导航 Then 展示四个确认分区', () => {
  const html = renderToStaticMarkup(<MediaSettingsTabsView activeTab="image-models" onTabChange={() => undefined} />)
  for (const label of ['生图模型', '音频生成', '服务链接', '本地工作流']) expect(html).toContain(label)
  expect(html).not.toContain('媒体模型')
})

test('Given 固定生图视图含旧音频和视频 When 渲染 Then 只显示图片且保存保留隐藏条目', async () => {
  const html = renderToStaticMarkup(<MediaApiModelCatalogView fixedMediaKind="image" entries={entries} {...props} />)
  expect(html).toContain('图片模型')
  expect(html).not.toContain('旧语音')
  expect(html).not.toContain('旧视频')
})
```

- [ ] **Step 2: 运行 Renderer 定向测试并确认失败**

Run: `bun test apps/electron/src/renderer/components/settings/MediaSettings.test.tsx apps/electron/src/renderer/components/settings/MediaApiModelSettings.test.tsx`

Expected: FAIL，四标签文案和 `fixedMediaKind` 尚不存在。

- [ ] **Step 3: 实现四个稳定 tab 值**

```ts
export type MediaSettingsTab = 'image-models' | 'audio-generation' | 'connections' | 'workflows'

<TabsTrigger value="image-models">生图模型</TabsTrigger>
<TabsTrigger value="audio-generation">音频生成</TabsTrigger>
<TabsTrigger value="connections">服务链接</TabsTrigger>
<TabsTrigger value="workflows">本地工作流</TabsTrigger>
```

默认 tab 与旧 `focusedSection === 'image-models'` 都映射到 `image-models`。连接、工作流、授权策略和资源浏览状态保持原实现。

- [ ] **Step 4: 为媒体模型视图增加固定 image 模式**

`MediaApiModelSettings` 加 `fixedMediaKind="image"`；新增草稿默认 image，隐藏媒体类型下拉和“全部类型”过滤。保存时仍把当前完整 catalog 作为基线，只替换可见 image Profile，原 audio/video Profile 原样合并，不能因 UI 隐藏被删除。

- [ ] **Step 5: 运行定向测试**

Run: `bun test apps/electron/src/renderer/components/settings/MediaSettings.test.tsx apps/electron/src/renderer/components/settings/MediaApiModelSettings.test.tsx`

Expected: PASS，0 fail。

- [ ] **Step 6: 提交导航与生图过滤**

```bash
git add apps/electron/src/renderer/components/settings/MediaSettings.tsx apps/electron/src/renderer/components/settings/MediaSettings.test.tsx apps/electron/src/renderer/components/settings/MediaApiModelSettings.tsx apps/electron/src/renderer/components/settings/MediaApiModelSettings.test.tsx
git commit -m "拆分媒体设置一级分区"
```

## Task 6: 音频配置列表与供应商动态表单

**Files:**
- Create: `apps/electron/src/renderer/components/settings/AudioGenerationSettings.tsx`
- Create: `apps/electron/src/renderer/components/settings/AudioGenerationSettings.test.tsx`
- Modify: `apps/electron/src/renderer/components/settings/MediaSettings.tsx`

- [ ] **Step 1: 写供应商字段、Key 与迁移提示失败测试**

```ts
test('Given 新建音频配置 When 切换供应商 Then MiniMax 显示 Group ID 且小米不显示', () => {
  expect(renderForm('xiaomi')).not.toContain('Group ID')
  expect(renderForm('minimax')).toContain('Group ID')
})

test('Given 编辑已有配置 When API Key 留空保存 Then 使用 preserve', () => {
  expect(createCredentialUpdate('', true)).toEqual({ mode: 'preserve' })
  expect(createCredentialUpdate(' new-key ', true)).toEqual({ mode: 'replace', apiKey: 'new-key' })
})

test('Given 复制配置 When 创建草稿 Then 不继承凭据和 legacy 引用', () => {
  expect(copyAudioGenerationProfile(existing)).toMatchObject({ credentialConfigured: false, legacyMediaProfileId: undefined })
})

test('Given 旧 MiniMax 条目尚未迁移 When 渲染 Then 提供非破坏迁移入口', () => {
  expect(renderCatalog({ legacyAudioProfiles: [legacy] })).toContain('旧配置，需要重新填写独立凭据')
})
```

- [ ] **Step 2: 写测试状态机失败测试**

覆盖 `loading/success/failed/cancelled/unavailable`；修改模型后清除旧状态；第二次测试先调用 cancel；旧 requestId 迟到结果不覆盖新状态；删除和复制清除状态。

Run: `bun test apps/electron/src/renderer/components/settings/AudioGenerationSettings.test.tsx`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯 helper 和草稿模型**

```ts
export interface AudioGenerationDraft extends AudioGenerationProfile {
  apiKey: string
  credentialConfigured: boolean
}

export function createCredentialUpdate(apiKey: string, configured: boolean): AudioGenerationCredentialUpdate {
  const trimmed = apiKey.trim()
  if (trimmed) return { mode: 'replace', apiKey: trimmed }
  if (configured) return { mode: 'preserve' }
  throw new Error('请输入 API Key')
}

export function changeAudioGenerationProvider(
  draft: AudioGenerationDraft,
  provider: AudioGenerationProvider,
): AudioGenerationDraft {
  return { ...draft, provider, modelId: '', voiceId: '', apiKey: '', credentialConfigured: false,
    ...(provider === 'minimax' ? { groupId: '' } : {}), legacyMediaProfileId: undefined }
}
```

- [ ] **Step 4: 实现列表、表单和 CRUD**

组件加载 `mediaGetAudioGenerationSettings()`，持有 catalog revision 与当前窗口测试 Map。保存、启停、删除都构造完整 `profiles[]`，未改变条目使用 `preserve`；复制和新增使用 `replace`。表单使用现有 `MediaSettingsPage`、`SettingsCard`、`SettingsRow`、`Input`、`Select`、`Switch`、`ConfirmDialog` 和 lucide 图标，不抽取 ChannelForm 基类。

供应商选择读取 `AUDIO_GENERATION_PROVIDER_DESCRIPTORS`；小米显示通用字段，MiniMax 额外显示 Group ID。列表只展示 `endpointOrigin`，不渲染 API Key 或完整 path。

- [ ] **Step 5: 实现测试与取消交互**

每次测试生成 `crypto.randomUUID()` requestId；新测试前取消当前 requestId；修改身份字段、返回列表、删除、复制或卸载时取消并清除。`unavailable` 使用中性提示，不显示为成功或错误。

- [ ] **Step 6: 挂载音频分区并运行组件测试**

```tsx
{activeTab === 'audio-generation' && (
  <AudioGenerationSettings navigation={navigation} headerContent={authorizationControl}>
    {notices}
  </AudioGenerationSettings>
)}
```

Run: `bun test apps/electron/src/renderer/components/settings/AudioGenerationSettings.test.tsx apps/electron/src/renderer/components/settings/MediaSettings.test.tsx`

Expected: PASS，0 fail。

- [ ] **Step 7: 提交音频配置 UI**

```bash
git add apps/electron/src/renderer/components/settings/AudioGenerationSettings.tsx apps/electron/src/renderer/components/settings/AudioGenerationSettings.test.tsx apps/electron/src/renderer/components/settings/MediaSettings.tsx
git commit -m "新增音频供应商独立配置界面"
```

## Task 7: 真实 Electron 验收与完整回归

**Files:**
- Create: `apps/electron/scripts/audio-generation-settings-smoke.html`
- Create: `apps/electron/scripts/audio-generation-settings-smoke-renderer.tsx`
- Create: `apps/electron/scripts/audio-generation-settings-smoke.ts`
- Modify: `apps/electron/package.json`

- [x] **Step 1: 写隔离 Renderer fixture**

fixture 注入内存 `window.electronAPI`，包含一条小米配置、一条 MiniMax 配置和一条旧 `minimax-speech` 摘要；测试调用返回可控 deferred Promise，以复现迟到 requestId。Renderer 暴露只读观察值：当前 tab、公开 DOM 是否含 secret、cancel 调用、replace payload 和当前测试状态。

- [x] **Step 2: 写真实 Electron 失败断言**

```ts
for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
  await window.setSize(viewport.width, viewport.height)
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    await assertFourTabs(window)
    await assertProviderFieldSwitch(window)
    await assertCopyDropsCredential(window)
    await assertLateTestResultIgnored(window)
    await assertNoHorizontalOverflow(window)
  }
}
```

- [x] **Step 3: 运行 smoke 并修复实际交互问题**

Run: `bun run --cwd apps/electron test:audio-generation-settings-smoke`

Expected: PASS；两个 viewport、两种主题、键盘切换、供应商字段、复制凭据、迟到结果和旧迁移提示全部通过。

- [x] **Step 4: 运行定向 BDD 回归**

Run:

```bash
bun test --isolate \
  packages/shared/src/types/audio-generation.test.ts \
  packages/shared/src/types/media-api-model.test.ts \
  apps/electron/src/main/lib/media/audio-generation-config-store.test.ts \
  apps/electron/src/main/lib/media/audio-generation-test-service.test.ts \
  apps/electron/src/main/lib/media/media-ipc.test.ts \
  apps/electron/src/preload/media-preload.test.ts \
  apps/electron/src/renderer/components/settings/MediaSettings.test.tsx \
  apps/electron/src/renderer/components/settings/MediaApiModelSettings.test.tsx \
  apps/electron/src/renderer/components/settings/AudioGenerationSettings.test.tsx
```

Expected: PASS，0 fail。

- [x] **Step 5: 运行类型检查和 Electron 构建**

Run: `bun run typecheck`

Expected: 所有 workspace exit 0。

Run: `bun run electron:build`

Expected: main、preload、renderer 构建 exit 0。

- [x] **Step 6: 检查 diff、秘密与未授权范围**

Run: `git diff --check`

Expected: 无输出。

Run: `rg -n "secret-key|Bearer should-not|apiKey.*console|console.*apiKey" packages apps/electron/src apps/electron/scripts`

Expected: 只有测试 fixture 中的明确假秘密；生产源码与日志没有凭据值。

确认未修改 Canvas 媒体执行器、Agent 工具、默认 Skills、README、release notes 或版本号。

- [x] **Step 7: 提交 Electron 验收与计划状态**

```bash
git add apps/electron/scripts/audio-generation-settings-smoke.html apps/electron/scripts/audio-generation-settings-smoke-renderer.tsx apps/electron/scripts/audio-generation-settings-smoke.ts apps/electron/package.json docs/superpowers/plans/2026-09-16-independent-audio-generation-providers.md
git commit -m "补齐音频供应商配置验收"
```

## Completion Evidence

- Shared parser 与 provider descriptor 键完全一致。
- `audio-generation-profiles.json` 只含 safeStorage 密文，公开 DTO、DOM、日志和错误不含 Key。
- 所有写操作使用 catalog revision CAS 与安全原子写。
- 测试由 requestId/owner 管理，窗口销毁和显式取消均释放请求。
- 小米/MiniMax 在缺少已验证官方 TTS 合同时明确显示 `unavailable`，不发送猜测请求。
- 四个一级分区、生图固定过滤和旧音频/视频非破坏边界通过自动化与真实 Electron 验收。
