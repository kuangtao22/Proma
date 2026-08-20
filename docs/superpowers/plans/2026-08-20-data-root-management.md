# Proma Data Root Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户安全迁移 Proma 业务数据根目录，并在移动盘或网络目录离线时进入可恢复状态，而不是产生第二套数据。

**Architecture:** 在固定的 `~/.proma-location.json` 中保存活动数据根和迁移状态，`config-paths.ts` 继续作为唯一业务路径入口。迁移通过独立启动模式执行流式复制、SHA-256 校验和 Proma-owned 路径重写，全部成功后才原子切换定位文件并重启正常应用。

**Tech Stack:** Bun、TypeScript、Electron 43、React、Jotai、Node `fs/promises`、Node `crypto`、现有 Radix/shadcn primitives。

**工程约束:** 所有新增方法和变量配套中文用途注释；不使用 `any`；JSON/JSONL 更新统一通过 `safe-file.ts`；每个任务保持 BDD 测试先行。

---

## 文件边界

**新增文件：**

- `packages/shared/src/types/path-management.ts`：路径状态、迁移输入、进度和 IPC 通道合同。
- `apps/electron/src/main/lib/data-root-locator.ts`：固定定位文件的读取、校验、缓存和原子更新。
- `apps/electron/src/main/lib/data-root-locator.test.ts`：定位文件 BDD 测试。
- `apps/electron/src/main/lib/verified-directory-copier.ts`：目录扫描、流式复制、断点恢复和 SHA-256 校验。
- `apps/electron/src/main/lib/verified-directory-copier.test.ts`：复制、符号链接和失败恢复测试。
- `apps/electron/src/main/lib/owned-path-rebaser.ts`：只重写 Proma schema 拥有的根内绝对路径。
- `apps/electron/src/main/lib/owned-path-rebaser.test.ts`：内部路径重写与外部路径保留测试。
- `apps/electron/src/main/lib/data-root-migration.ts`：预检、迁移状态机和最终切换。
- `apps/electron/src/main/lib/data-root-migration.test.ts`：状态机、校验失败和恢复测试。
- `apps/electron/src/main/lib/path-management-ipc.ts`：路径专用 IPC 注册，支持正常与迁移启动模式。
- `apps/electron/src/main/lib/path-management-ipc.test.ts`：路径 IPC 注册、恢复动作与进度订阅测试。
- `apps/electron/src/main/lib/agent-prompt-builder.test.ts`：提示词中的受管工作区路径解析测试。
- `apps/electron/src/renderer/components/path-management/DataRootMigrationApp.tsx`：迁移进度和离线恢复专用窗口。
- `apps/electron/src/renderer/components/path-management/DataRootMigrationApp.test.tsx`：恢复动作和状态渲染测试。
- `apps/electron/src/renderer/components/settings/PathManagementSettings.tsx`：Proma 原生风格的路径设置页。
- `apps/electron/src/renderer/components/settings/PathManagementSettings.test.tsx`：设置页状态与操作测试。
- `apps/electron/scripts/check-data-root-contract.ts`：阻止主进程重新硬编码 `~/.proma`。
- `apps/electron/scripts/check-data-root-contract.test.ts`：兼容检查脚本测试。

**修改文件：**

- `packages/shared/src/types/index.ts`：导出路径合同。
- `apps/electron/src/main/lib/config-paths.ts`：把 `getConfigDir()` 接入定位器。
- `apps/electron/src/main/lib/config-paths.test.ts`：覆盖自定义根和无副作用解析。
- `apps/electron/src/main/lib/agent-prompt-builder.ts`：移除直接拼接 `~/.proma`。
- `apps/electron/src/main/index.ts`：在正常服务启动前分流迁移/恢复启动模式。
- `apps/electron/src/main/ipc.ts`：正常模式注册路径 IPC，并移除旧的字符串通道。
- `apps/electron/src/preload/index.ts`：暴露类型安全路径 API 和进度订阅。
- `apps/electron/src/renderer/main.tsx`：为 `window=data-root-migration` 增加轻量渲染入口。
- `apps/electron/src/renderer/components/settings/SettingsPanel.tsx`：把“数据迁移”改为“路径与迁移”。
- `apps/electron/src/renderer/atoms/settings-tab.ts`：保持现有 `migration` tab id，更新注释，不破坏已存在导航状态。
- `apps/electron/src/renderer/components/settings/MigrationSettings.tsx`：删除后由 `PathManagementSettings.tsx` 接管原有 ZIP 迁移内容。
- `apps/electron/package.json`：增加路径合同检查命令。

### Task 1: 建立共享合同与固定数据根定位器

**Files:**
- Create: `packages/shared/src/types/path-management.ts`
- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/electron/src/main/lib/data-root-locator.test.ts`
- Create: `apps/electron/src/main/lib/data-root-locator.ts`

- [ ] **Step 1: 写定位器失败测试**

```ts
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createDataRootLocator } from './data-root-locator'

test('Given 没有定位文件 When 解析数据根 Then 使用默认 .proma', () => {
  const locator = createDataRootLocator({ homeDir: '/tmp/proma-home' })
  expect(locator.inspect()).toEqual({ kind: 'ready', activeRoot: '/tmp/proma-home/.proma' })
})

test('Given 自定义根不存在 When 解析数据根 Then 返回离线且不创建目录', () => {
  const homeDir = '/tmp/proma-custom-home'
  mkdirSync(homeDir, { recursive: true })
  writeFileSync(join(homeDir, '.proma-location.json'), JSON.stringify({
    version: 1,
    activeRoot: '/Volumes/Missing/Proma Data',
  }))
  const locator = createDataRootLocator({ homeDir })
  expect(locator.inspect()).toEqual({
    kind: 'unavailable',
    activeRoot: '/Volumes/Missing/Proma Data',
    reason: 'missing',
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/data-root-locator.test.ts`

Expected: FAIL，提示找不到 `./data-root-locator`。

- [ ] **Step 3: 定义共享类型和 IPC 通道**

```ts
export type DataRootAvailability = 'available' | 'missing' | 'unavailable' | 'invalid'
export type DataRootMigrationStage = 'pending' | 'copying' | 'verifying' | 'rebasing' | 'failed'

export interface DataRootMigrationProgress {
  migrationId: string
  stage: DataRootMigrationStage
  completedBytes: number
  totalBytes: number
  currentRelativePath?: string
  error?: string
}

export interface PathManagementState {
  activeRoot: string
  previousRoot?: string
  availability: DataRootAvailability
  deviceType: 'local' | 'removable' | 'network' | 'unknown'
  occupiedBytes?: number
  availableBytes?: number
  migration: DataRootMigrationProgress | null
}

export type DataRootRecoveryAction = 'recheck' | 'relocate' | 'restore-previous'

export interface RecoverDataRootInput {
  action: DataRootRecoveryAction
  selectedRoot?: string
}

export interface DataRootMigrationRecord {
  id: string
  sourceRoot: string
  targetRoot: string
  stage: DataRootMigrationStage
  completedBytes: number
  totalBytes: number
  startedAt: number
  updatedAt: number
  error?: string
}

export interface DataRootLocatorFile {
  version: 1
  activeRoot: string
  previousRoot?: string
  migration?: DataRootMigrationRecord
}

export const PATH_MANAGEMENT_IPC_CHANNELS = {
  GET_STATE: 'path-management:get-state',
  PICK_DATA_ROOT: 'path-management:pick-data-root',
  START_DATA_ROOT_MIGRATION: 'path-management:start-data-root-migration',
  GET_DATA_ROOT_MIGRATION_STATUS: 'path-management:get-data-root-migration-status',
  RESUME_DATA_ROOT_MIGRATION: 'path-management:resume-data-root-migration',
  CANCEL_DATA_ROOT_MIGRATION: 'path-management:cancel-data-root-migration',
  RECOVER_DATA_ROOT: 'path-management:recover-data-root',
  PROGRESS: 'path-management:progress',
} as const
```

同时在 `packages/shared/src/types/index.ts` 增加：

```ts
export * from './path-management'
```

- [ ] **Step 4: 实现定位器最小闭环**

```ts
/** 创建可注入 homeDir 的数据根定位器，便于跨平台测试。 */
export function createDataRootLocator(options: DataRootLocatorOptions): DataRootLocator {
  /** 固定定位文件必须位于可迁移数据根之外。 */
  const locatorPath = join(options.homeDir, '.proma-location.json')
  return {
    inspect: () => inspectLocatorFile(locatorPath, options.homeDir),
    write: (file) => writeJsonFileAtomic(locatorPath, file),
    getLocatorPath: () => locatorPath,
  }
}
```

其中 `DataRootLocatorOptions` 至少包含 `homeDir: string`，`DataRootLocator` 暴露 `inspect()`、`requireActiveRoot()`、`write()`、`commitMigration()` 与 `getLocatorPath()`。`inspectLocatorFile()` 必须区分：定位文件缺失、主文件损坏但 `.bak` 可恢复、自定义根缺失、自定义根不可访问、迁移记录存在。首次解析后缓存结果，正常运行期的 getter 只读缓存；默认根仅在调用 `requireActiveRoot({ createDefault: true })` 时创建。

- [ ] **Step 5: 运行定位器测试**

Run: `bun test apps/electron/src/main/lib/data-root-locator.test.ts`

Expected: PASS，且离线自定义目录没有被创建。

- [ ] **Step 6: 提交定位基础**

```bash
git add packages/shared/src/types/path-management.ts packages/shared/src/types/index.ts apps/electron/src/main/lib/data-root-locator.ts apps/electron/src/main/lib/data-root-locator.test.ts
git commit -m "功能：增加数据根定位与路径管理合同"
```

### Task 2: 保持 `config-paths` 兼容并移除硬编码

**Files:**
- Modify: `apps/electron/src/main/lib/config-paths.ts`
- Modify: `apps/electron/src/main/lib/config-paths.test.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`
- Create: `apps/electron/src/main/lib/agent-prompt-builder.test.ts`

- [ ] **Step 1: 先写自定义根解析和提示词路径测试**

在 `config-paths.test.ts` 增加可注入定位器的测试：

```ts
test('Given 自定义数据根 When 解析工作区路径 Then 不再拼接 home/.proma', () => {
  const resolver = createConfigPathResolver({ activeRoot: '/Volumes/Work/Proma Data' })
  expect(resolver.getAgentWorkspacePath('proma')).toBe('/Volumes/Work/Proma Data/agent-workspaces/proma')
})
```

在 `agent-prompt-builder.test.ts` 增加：

```ts
test('Given 自定义数据根 When 构建系统提示词 Then 工作区规则路径来自统一解析器', () => {
  const prompt = buildSystemPrompt({
    sessionId: 'session-1',
    workspaceSlug: 'proma',
    permissionMode: 'bypassPermissions',
  })
  expect(prompt).toContain('/Volumes/Work/Proma Data/agent-workspaces/proma/AGENTS.md')
  expect(prompt).not.toContain('/Users/test/.proma/agent-workspaces')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/config-paths.test.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts`

Expected: FAIL，自定义 resolver 或提示词注入尚不存在。

- [ ] **Step 3: 将根解析限制在一个入口**

```ts
/** 返回当前进程缓存的数据根；运行中不允许热切换。 */
export function getConfigDir(): string {
  return defaultDataRootLocator.requireActiveRoot({ createDefault: true })
}
```

测试通过 `data-root-locator` 的测试注入点把活动根设为 `/Volumes/Work/Proma Data`。`buildWorkspacePaths()` 改为使用 `getAgentWorkspacePath(workspaceSlug)`，不再导入 `homedir` 和 `getConfigDirName`：

```ts
/** 构建系统提示词需要展示的受管工作区路径。 */
const workspaceRoot = getAgentWorkspacePath(workspaceSlug)
```

- [ ] **Step 4: 运行相关测试**

Run: `bun test apps/electron/src/main/lib/config-paths.test.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交兼容层**

```bash
git add apps/electron/src/main/lib/config-paths.ts apps/electron/src/main/lib/config-paths.test.ts apps/electron/src/main/lib/agent-prompt-builder.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts
git commit -m "重构：统一 Proma 业务数据路径解析"
```

### Task 3: 实现可恢复的流式复制与校验

**Files:**
- Create: `apps/electron/src/main/lib/verified-directory-copier.test.ts`
- Create: `apps/electron/src/main/lib/verified-directory-copier.ts`

- [ ] **Step 1: 写复制语义测试**

```ts
test('Given 普通文件与符号链接 When 复制并校验 Then 内容一致且链接不被跟随', async () => {
  const result = await copyDirectoryVerified({ sourceRoot, targetRoot, onProgress: () => {} })
  expect(result.verifiedFiles).toBe(2)
  expect(readFileSync(join(targetRoot, 'large.bin'))).toEqual(readFileSync(join(sourceRoot, 'large.bin')))
  expect(readlinkSync(join(targetRoot, 'external-link'))).toBe(externalTarget)
})

test('Given 已存在且哈希一致的目标文件 When 恢复迁移 Then 跳过重复复制', async () => {
  const result = await copyDirectoryVerified({ sourceRoot, targetRoot, onProgress: () => {} })
  expect(result.reusedFiles).toBe(1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/verified-directory-copier.test.ts`

Expected: FAIL，提示复制函数不存在。

- [ ] **Step 3: 实现扫描、哈希、复制和一次重试**

```ts
export interface CopyDirectoryInput {
  migrationId: string
  sourceRoot: string
  targetRoot: string
  concurrency?: number
  signal?: AbortSignal
  onProgress: (progress: DataRootMigrationProgress) => void
}

export interface CopyDirectoryResult {
  verifiedFiles: number
  reusedFiles: number
  totalBytes: number
}

/** 以固定大小缓冲区计算文件 SHA-256，内存不随文件大小增长。 */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

/** 复制目录并逐文件校验；符号链接只复制链接本身。 */
export async function copyDirectoryVerified(input: CopyDirectoryInput): Promise<CopyDirectoryResult> {
  const manifest = await scanDirectory(input.sourceRoot)
  await copyManifestEntries(manifest, input)
  return verifyManifestEntries(manifest, input, { retryMismatchedFileOnce: true })
}
```

扫描遇到 socket、设备文件或根外路径时抛出明确错误。目标目录仅允许为空，或包含同迁移 ID 的断点标记。默认并发固定为 2，可通过 `concurrency` 在测试中覆盖；每个文件和数据块之间检查 `AbortSignal`。目录、文件权限和时间戳尽力保留，平台不支持的元数据只记录警告，不跳过内容哈希。

- [ ] **Step 4: 运行复制测试**

Run: `bun test apps/electron/src/main/lib/verified-directory-copier.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交复制组件**

```bash
git add apps/electron/src/main/lib/verified-directory-copier.ts apps/electron/src/main/lib/verified-directory-copier.test.ts
git commit -m "功能：增加可恢复的目录复制与完整性校验"
```

### Task 4: 重写目标副本中的 Proma-owned 绝对路径

**Files:**
- Create: `apps/electron/src/main/lib/owned-path-rebaser.test.ts`
- Create: `apps/electron/src/main/lib/owned-path-rebaser.ts`

- [ ] **Step 1: 写内部路径重写测试**

```ts
test('Given 会话同时包含根内和外部路径 When 重写目标副本 Then 只改根内路径', () => {
  const updated = rebaseSessionOwnedPaths(session, '/Users/me/.proma', '/Volumes/Work/Proma Data')
  expect(updated.piSessionFile).toBe('/Volumes/Work/Proma Data/sdk-config/sessions/a.jsonl')
  expect(updated.attachedFiles).toEqual([
    '/Volumes/Work/Proma Data/attachments/a.png',
    '/Users/me/Desktop/external.png',
  ])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/owned-path-rebaser.test.ts`

Expected: FAIL，提示重写函数不存在。

- [ ] **Step 3: 实现安全前缀判断和 schema-aware 写入**

```ts
/** 只重写严格位于旧根内部的绝对路径。 */
export function rebaseOwnedPath(value: string, sourceRoot: string, targetRoot: string): string {
  const relativePath = relative(resolve(sourceRoot), resolve(value))
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return value
  return join(targetRoot, relativePath)
}
```

`rebaseDataRootOwnedPaths()` 读取目标副本内的 `agent-sessions.json` 和各工作区 `config.json`，只更新 `piSessionFile`、`forkSourceDir`、`attachedDirectories`、`attachedFiles`、`worktreeRepos.repoPath` 与 `worktreeRepos.worktreesPath` 中实际位于旧根内的值，并使用 `writeJsonFileAtomic()` 写回。

- [ ] **Step 4: 运行重写测试**

Run: `bun test apps/electron/src/main/lib/owned-path-rebaser.test.ts`

Expected: PASS，外部路径保持原值。

- [ ] **Step 5: 提交路径重写组件**

```bash
git add apps/electron/src/main/lib/owned-path-rebaser.ts apps/electron/src/main/lib/owned-path-rebaser.test.ts
git commit -m "功能：迁移后重写 Proma 内部绝对路径"
```

### Task 5: 实现数据根迁移状态机

**Files:**
- Create: `apps/electron/src/main/lib/data-root-migration.test.ts`
- Create: `apps/electron/src/main/lib/data-root-migration.ts`

- [ ] **Step 1: 写“失败不切换”状态机测试**

```ts
test('Given 校验失败 When 执行迁移 Then activeRoot 保持源目录', async () => {
  const coordinator = createDataRootMigrationCoordinator({ locator, copier: failingCopier, rebaser })
  await expect(coordinator.runPendingMigration()).rejects.toThrow('文件校验失败')
  expect(locator.inspect()).toMatchObject({ kind: 'migration', activeRoot: sourceRoot })
})

test('Given 复制与重写成功 When 提交迁移 Then 目标成为 activeRoot 且源目录成为 previousRoot', async () => {
  await coordinator.runPendingMigration()
  expect(locator.inspect()).toEqual({ kind: 'ready', activeRoot: targetRoot, previousRoot: sourceRoot })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/data-root-migration.test.ts`

Expected: FAIL，提示协调器不存在。

- [ ] **Step 3: 实现预检与状态提交顺序**

```ts
/** 执行待处理迁移；定位文件切换必须是最后一个持久化动作。 */
async function runPendingMigration(): Promise<void> {
  const migration = locator.requireMigration()
  await preflightDataRootMigration(migration)
  await copier.copy({ ...migration, onProgress: persistProgress })
  await rebaser.rebase({ targetRoot: migration.targetRoot, sourceRoot: migration.sourceRoot })
  locator.commitMigration({ activeRoot: migration.targetRoot, previousRoot: migration.sourceRoot })
}
```

`preflightDataRootMigration()` 必须检查：目标为空或为同 ID 断点、源/目标不嵌套、目标可写、`statfs` 空间足够、没有其他活动实例。实例侧车锁使用 `openSync(lockPath, 'wx')` 和 PID/时间戳；只清理已验证 PID 不存在的陈旧锁。

- [ ] **Step 4: 运行状态机测试**

Run: `bun test apps/electron/src/main/lib/data-root-migration.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交迁移状态机**

```bash
git add apps/electron/src/main/lib/data-root-migration.ts apps/electron/src/main/lib/data-root-migration.test.ts
git commit -m "功能：增加数据根迁移状态机与失败恢复"
```

### Task 6: 在 Electron 启动前分流迁移和离线恢复模式

**Files:**
- Create: `apps/electron/src/main/lib/path-management-ipc.ts`
- Create: `apps/electron/src/main/lib/path-management-ipc.test.ts`
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/main.tsx`
- Create: `apps/electron/src/renderer/components/path-management/DataRootMigrationApp.tsx`
- Create: `apps/electron/src/renderer/components/path-management/DataRootMigrationApp.test.tsx`

- [ ] **Step 1: 写启动模式与恢复页测试**

```ts
test('Given 活动数据根离线 When 启动 Then 只进入 data-root-recovery 模式', () => {
  expect(resolveDataRootStartupMode(unavailableLocator)).toBe('data-root-recovery')
})

test('Given 迁移记录存在 When 启动 Then 进入 data-root-migration 模式', () => {
  expect(resolveDataRootStartupMode(migratingLocator)).toBe('data-root-migration')
})

test('Given 迁移模式 When 注册 IPC Then 只暴露路径恢复合同', () => {
  const channels = registerPathManagementIpcHandlers({ mode: 'data-root-migration', app })
  expect(channels).toEqual(expect.arrayContaining([
    PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_MIGRATION_STATUS,
    PATH_MANAGEMENT_IPC_CHANNELS.RESUME_DATA_ROOT_MIGRATION,
    PATH_MANAGEMENT_IPC_CHANNELS.CANCEL_DATA_ROOT_MIGRATION,
    PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT,
  ]))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/data-root-migration.test.ts apps/electron/src/main/lib/path-management-ipc.test.ts apps/electron/src/renderer/components/path-management/DataRootMigrationApp.test.tsx`

Expected: FAIL，启动模式或组件尚不存在。

- [ ] **Step 3: 在 `bootstrap()` 最前面分流**

```ts
/** 数据根未就绪时绝不启动普通业务服务。 */
const dataRootMode = resolveDataRootStartupMode(defaultDataRootLocator.inspect())
if (dataRootMode !== 'normal') {
  registerPathManagementIpcHandlers({ mode: dataRootMode, app })
  createWindow({ rendererQuery: `window=data-root-migration&mode=${dataRootMode}` })
  return
}
```

这段逻辑必须位于 `createStartupSplashWindow()`、`getSettings()`、`seedDefaultSkills()` 和所有 Agent、LAN Bridge、Automation、渠道、watcher、Planning SQLite 初始化之前。

- [ ] **Step 4: 增加轻量 renderer 分支**

```ts
/** 数据根迁移窗口不加载任何会读业务数据的全局 initializer。 */
const isDataRootMigrationWindow = new URLSearchParams(window.location.search).get('window') === 'data-root-migration'

if (isDataRootMigrationWindow) {
  ReactDOM.createRoot(document.getElementById('root')!).render(<DataRootMigrationApp />)
}
```

`DataRootMigrationApp` 仅调用路径 IPC，展示复制/校验/重写进度；离线模式提供重新检测、重新定位、验证后切回旧备份和退出。它使用现有 `Button`、主题变量和稳定尺寸进度条。

- [ ] **Step 5: 完成四层 IPC**

`path-management-ipc.ts` 注册 typed channels；`preload/index.ts` 增加：

```ts
/** 获取当前路径管理状态。 */
getPathManagementState: () => Promise<PathManagementState>
/** 创建迁移计划并请求重启。 */
startDataRootMigration: (targetRoot: string) => Promise<void>
/** 获取当前迁移或失败恢复状态。 */
getDataRootMigrationStatus: () => Promise<DataRootMigrationProgress | null>
/** 从已校验断点继续迁移。 */
resumeDataRootMigration: () => Promise<void>
/** 取消尚未切换的数据根迁移计划，不删除目标副本。 */
cancelDataRootMigration: () => Promise<void>
/** 重新检测、重新定位或显式切回已验证的旧数据根。 */
recoverDataRoot: (input: RecoverDataRootInput) => Promise<void>
/** 订阅迁移进度。 */
onDataRootMigrationProgress: (callback: (progress: DataRootMigrationProgress) => void) => () => void
```

正常模式下 `startDataRootMigration` 完成“无活跃 Agent、Automation 或其他 Proma 实例”的二次预检后写入计划，立即关闭新任务入口，再调用 `app.relaunch()` 与 `app.quit()`；不能用 `setImmediate()` 留出新的写入竞态。迁移模式完成后再次 relaunch。删除旧的 `'migration:open-data-folder'` 字符串通道，改用共享常量。

- [ ] **Step 6: 运行启动与 IPC 测试**

Run: `bun test apps/electron/src/main/lib/data-root-migration.test.ts apps/electron/src/main/lib/path-management-ipc.test.ts apps/electron/src/renderer/components/path-management/DataRootMigrationApp.test.tsx`

Expected: PASS。

- [ ] **Step 7: 提交启动恢复链路**

```bash
git add apps/electron/src/main/index.ts apps/electron/src/main/ipc.ts apps/electron/src/main/lib/path-management-ipc.ts apps/electron/src/main/lib/path-management-ipc.test.ts apps/electron/src/preload/index.ts apps/electron/src/renderer/main.tsx apps/electron/src/renderer/components/path-management/DataRootMigrationApp.tsx apps/electron/src/renderer/components/path-management/DataRootMigrationApp.test.tsx
git commit -m "功能：增加数据迁移启动模式与离线恢复"
```

### Task 7: 把路径管理接入现有设置页

**Files:**
- Create: `apps/electron/src/renderer/components/settings/PathManagementSettings.test.tsx`
- Create: `apps/electron/src/renderer/components/settings/PathManagementSettings.tsx`
- Delete: `apps/electron/src/renderer/components/settings/MigrationSettings.tsx`
- Modify: `apps/electron/src/renderer/components/settings/SettingsPanel.tsx`
- Modify: `apps/electron/src/renderer/atoms/settings-tab.ts`

- [ ] **Step 1: 写设置页状态测试**

```tsx
test('Given 当前根和旧备份 When 渲染路径设置 Then 展示两条路径且不提供删除按钮', async () => {
  render(<PathManagementSettings />)
  expect(await screen.findByText('/Users/test/.proma')).toBeInTheDocument()
  expect(screen.getByText('/Volumes/Backup/Proma Data')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /删除/ })).not.toBeInTheDocument()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/renderer/components/settings/PathManagementSettings.test.tsx`

Expected: FAIL，组件不存在。

- [ ] **Step 3: 使用现有 primitives 实现数据位置区块**

```tsx
<SettingsSection
  title="Proma 数据位置"
  description="会话、附件、Skills、配置和运行数据"
  action={<Button variant="outline" size="sm" onClick={openCurrentRoot}><FolderOpen size={14} />打开文件夹</Button>}
>
  <SettingsCard>
    <SettingsRow label="当前数据目录" description={<PathValue value={state.activeRoot} meta={`${state.deviceType} · ${formatBytes(state.occupiedBytes)}`} />}>
      <Button size="sm" onClick={openMigrationDialog}>迁移位置</Button>
    </SettingsRow>
    {state.previousRoot ? <SettingsRow label="上一次位置" description={<PathValue value={state.previousRoot} />} /> : null}
  </SettingsCard>
</SettingsSection>
```

保留原 `MigrationSettings.tsx` 的跨设备 ZIP 提示词区块，并移入新组件下方。当前目录行展示完整路径、可用状态、设备类型、占用空间和剩余空间；网络目录在确认对话框显示断连与性能风险。SettingsPanel 标签改为“路径与迁移”，tab id 继续使用 `migration`。

- [ ] **Step 4: 运行 UI 测试**

Run: `bun test apps/electron/src/renderer/components/settings/PathManagementSettings.test.tsx`

Expected: PASS。

- [ ] **Step 5: 提交设置页**

```bash
git add -A -- apps/electron/src/renderer/components/settings/PathManagementSettings.tsx apps/electron/src/renderer/components/settings/PathManagementSettings.test.tsx apps/electron/src/renderer/components/settings/SettingsPanel.tsx apps/electron/src/renderer/atoms/settings-tab.ts apps/electron/src/renderer/components/settings/MigrationSettings.tsx
git commit -m "界面：增加 Proma 数据路径管理与迁移入口"
```

### Task 8: 加入上游兼容合同并完成验证

**Files:**
- Create: `apps/electron/scripts/check-data-root-contract.test.ts`
- Create: `apps/electron/scripts/check-data-root-contract.ts`
- Modify: `apps/electron/package.json`

- [ ] **Step 1: 写合同检查失败测试**

```ts
test('Given 业务模块直接拼接 home/.proma When 检查合同 Then 报告违规文件', async () => {
  const violations = await findHardcodedDataRoots(fixtureRoot)
  expect(violations).toEqual(['src/main/lib/bad-path.ts'])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/scripts/check-data-root-contract.test.ts`

Expected: FAIL，检查器不存在。

- [ ] **Step 3: 实现 AST-free 精确合同扫描**

扫描 `apps/electron/src/main` 中 `join(homedir(), '.proma')`、模板字符串 `~/.proma` 和直接 `'.proma'` 路径拼接；白名单只允许 `data-root-locator.ts`、测试 fixture 和用户可见说明文本。命令加入：

```json
{
  "scripts": {
    "check:data-root": "bun run scripts/check-data-root-contract.ts"
  }
}
```

- [ ] **Step 4: 运行所有目标验证**

Run: `bun test apps/electron/src/main/lib/data-root-locator.test.ts apps/electron/src/main/lib/config-paths.test.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts apps/electron/src/main/lib/verified-directory-copier.test.ts apps/electron/src/main/lib/owned-path-rebaser.test.ts apps/electron/src/main/lib/data-root-migration.test.ts apps/electron/src/main/lib/path-management-ipc.test.ts apps/electron/src/renderer/components/path-management/DataRootMigrationApp.test.tsx apps/electron/src/renderer/components/settings/PathManagementSettings.test.tsx apps/electron/scripts/check-data-root-contract.test.ts`

Expected: PASS。

Run: `bun run --filter='@proma/electron' check:data-root`

Expected: 输出“数据根合同检查通过”。

Run: `bun run typecheck`

Expected: PASS，无 TypeScript 错误。

Run: `bun run electron:build`

Expected: PASS，main、preload、renderer 和 utility 构建成功。

- [ ] **Step 5: 提交合同与验证入口**

```bash
git add apps/electron/scripts/check-data-root-contract.ts apps/electron/scripts/check-data-root-contract.test.ts apps/electron/package.json
git commit -m "测试：增加数据根上游兼容合同"
```

- [ ] **Step 6: 最终人工冒烟验证**

Run: `bun run dev`

Expected:

- 设置页显示当前 `~/.proma` 和“路径与迁移”。
- 选择临时空目录后显示空间、源/目标和重启提示。
- 取消预检不会创建迁移记录。
- 使用测试目录完成迁移后应用重启，并从新根读取会话与工作区。
- 暂时重命名测试目标目录后重启，出现离线恢复页且不会新建空 `~/.proma`。
