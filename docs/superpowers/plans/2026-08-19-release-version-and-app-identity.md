# Proma Bone 版本与应用身份整理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Proma fork 的应用版本、Git 标签、Release 标题、安装包名称和应用内显示统一为可比较的 Bone SemVer，同时让开发版与正式版拥有不同的系统身份。

**Architecture:** `apps/electron/package.json` 的完整 Bone SemVer 是唯一版本来源；`src/shared` 中的纯函数负责解析版本和集中定义 fork Release 仓库，主进程、Renderer 与发布脚本共同复用。开发身份由主进程启动前的纯函数解析，正式安装身份继续由 Electron Builder 控制；GitHub Actions 在启动多平台构建前校验标签与版本合同。

**Tech Stack:** Bun、TypeScript、Electron 43、React、electron-builder、electron-updater、GitHub Actions、Bun Test。

---

## 文件结构

- 修改 `AGENTS.md`：先更新正式版本约束，允许官方基线加 Bone 构建号。
- 修改 `MEMORY.md`：记录长期版本策略、开发/正式身份和首次迁移限制。
- 新建 `apps/electron/src/shared/release-version.ts`：解析 Bone SemVer、校验 Git 标签、生成 Release 标题。
- 新建 `apps/electron/src/shared/release-version.test.ts`：覆盖合法版本、非法版本、标签合同和标题。
- 新建 `apps/electron/src/shared/release-config.ts`：集中定义 fork Release 仓库与页面地址。
- 新建 `apps/electron/src/shared/release-config.test.ts`：锁定 fork owner、repo 和 URL。
- 新建 `apps/electron/src/main/lib/app-identity.ts`：解析正式版、默认开发版和多实例开发版身份。
- 新建 `apps/electron/src/main/lib/app-identity.test.ts`：覆盖名称、App ID、`userData` 目录与实例名清理。
- 修改 `apps/electron/src/main/index.ts`：在申请单实例锁前应用开发身份。
- 新建 `apps/electron/src/renderer/lib/app-version-display.ts`：把完整版本转换为关于页展示模型。
- 新建 `apps/electron/src/renderer/lib/app-version-display.test.ts`：覆盖 Bone 版本和非 Bone 回退。
- 修改 `apps/electron/src/renderer/components/settings/AboutSettings.tsx`：分别显示官方版本和 Bone 构建，并统一 fork 链接。
- 修改 `apps/electron/src/main/lib/github-release-service.ts`：版本历史与指定标签查询统一读取 fork Release。
- 修改 `apps/electron/src/main/lib/updater/auto-updater.ts`：允许 Bone 预发布版本参与自动更新。
- 修改 `apps/electron/package.json` 与 `bun.lock`：升级为 `0.17.42-bone.5`。
- 修改 `apps/electron/electron-builder.yml`：固定正式身份、关闭自动频道推断并统一跨平台文件名。
- 新建 `apps/electron/scripts/validate-release-version.ts`：执行发布前标签合同并写入 GitHub Actions outputs。
- 新建 `apps/electron/scripts/validate-release-version.test.ts`：覆盖合法标签、错误标签和非法版本。
- 修改 `apps/electron/scripts/release-workflow.test.ts`：锁定版本、仓库、命名、验证任务和 Release 标题。
- 修改 `.github/workflows/release.yml`：先验证版本，再执行四平台构建与统一 Release。

### Task 1：先更新长期版本与身份规则

**Files:**
- Modify: `AGENTS.md`
- Modify: `MEMORY.md`

- [ ] **Step 1: 更新 AGENTS.md 的版本约束**

将“桌面应用版本必须与官方标签完全相同”的规则替换为：

```markdown
- `apps/electron/package.json` 使用 `<官方版本>-bone.<构建号>`，例如 `0.17.42-bone.5`；前三段必须与当前已合入的最新官方 `v*` 标签一致，Bone 构建号只追踪 fork 发布。
- 正式发布标签必须严格等于 `v${apps/electron/package.json.version}`。同一官方版本递增 Bone 构建号；合入新官方版本后将 Bone 构建号重置为 1。
- `packages/*/package.json` 继续跟随合入的官方包版本；默认 Skill 改动仍必须递增其 `SKILL.md` frontmatter 的 `version`。
```

- [ ] **Step 2: 更新 MEMORY.md**

在“长期约束”和“架构决策”中加入：

```markdown
- Electron 正式应用使用官方基线加 Bone 构建号的 SemVer；正式标签、应用版本和更新元数据必须一致。
- 正式版身份固定为 `Proma` / `com.bone.proma.app`，开发版固定为 `Proma Dev` / `com.bone.proma.dev`；两者隔离 Electron `userData`，继续共享 `~/.proma` 业务配置。
- 从纯 `0.17.42` 迁移到 `0.17.42-bone.5` 需要手动安装一次；后续 Bone 版本使用预发布 SemVer 正常递增更新，不开启全局降级。
```

- [ ] **Step 3: 检查文档差异**

Run: `git diff --check && git diff -- AGENTS.md MEMORY.md`

Expected: 无空白错误；新规则不再要求 Electron 版本严格等于纯官方版本。

- [ ] **Step 4: 提交规则变更**

```bash
git add AGENTS.md MEMORY.md
git commit -m "文档：统一 Bone 版本与应用身份规则"
```

### Task 2：建立共享 Bone 版本模型

**Files:**
- Create: `apps/electron/src/shared/release-version.test.ts`
- Create: `apps/electron/src/shared/release-version.ts`

- [ ] **Step 1: 先写失败的版本合同测试**

```typescript
import { describe, expect, test } from 'bun:test'
import {
  assertBoneReleaseTag,
  createBoneReleaseTitle,
  parseBoneReleaseVersion,
} from './release-version'

describe('Bone 发布版本', () => {
  test('Given 合法 Bone SemVer When 解析 Then 返回官方版本与构建号', () => {
    expect(parseBoneReleaseVersion('0.17.42-bone.5')).toEqual({
      fullVersion: '0.17.42-bone.5',
      upstreamVersion: '0.17.42',
      boneBuild: 5,
    })
  })

  test.each(['0.17.42', '0.17.42-bone.0', '0.17.42-bone.05', 'v0.17.42-bone.5'])(
    'Given 非法发布版本 %s When 解析 Then 返回 null',
    (version) => expect(parseBoneReleaseVersion(version)).toBeNull(),
  )

  test('Given 标签与应用版本一致 When 校验 Then 返回解析结果', () => {
    expect(assertBoneReleaseTag('0.17.42-bone.5', 'v0.17.42-bone.5').boneBuild).toBe(5)
  })

  test('Given 标签与应用版本不一致 When 校验 Then 给出明确错误', () => {
    expect(() => assertBoneReleaseTag('0.17.42-bone.5', 'v0.17.42-bone.4'))
      .toThrow('发布标签 v0.17.42-bone.4 与应用版本 0.17.42-bone.5 不一致')
  })

  test('Given Bone 版本 When 生成标题 Then 同时显示官方版本和构建号', () => {
    expect(createBoneReleaseTitle('0.17.42-bone.5')).toBe('Proma 0.17.42 · Bone 5')
  })
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/shared/release-version.test.ts`

Expected: FAIL，提示找不到 `./release-version`。

- [ ] **Step 3: 实现最小版本解析与校验**

```typescript
/** Bone 发布版本的结构化信息。 */
export interface BoneReleaseVersion {
  /** 完整应用版本。 */
  fullVersion: string
  /** 当前合入的官方版本。 */
  upstreamVersion: string
  /** fork 发布构建号。 */
  boneBuild: number
}

/** 只接受无前导零且构建号从 1 开始的 Bone SemVer。 */
const BONE_RELEASE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-bone\.([1-9]\d*)$/

/**
 * 解析完整 Bone 发布版本。
 * @param version 完整版本字符串。
 * @returns 合法版本信息；格式非法时返回 null。
 */
export function parseBoneReleaseVersion(version: string): BoneReleaseVersion | null {
  /** 正则捕获的主版本、次版本、补丁版本和 Bone 构建号。 */
  const match = BONE_RELEASE_PATTERN.exec(version)
  if (!match) return null
  /** 与当前 fork 发布对应的官方三段版本。 */
  const upstreamVersion = `${match[1]}.${match[2]}.${match[3]}`
  return { fullVersion: version, upstreamVersion, boneBuild: Number(match[4]) }
}

/**
 * 校验 Git 标签与应用版本严格一致。
 * @param version package.json 中的完整版本。
 * @param tag GitHub Actions 触发标签。
 * @returns 已解析的 Bone 发布版本。
 */
export function assertBoneReleaseTag(version: string, tag: string): BoneReleaseVersion {
  /** 经过格式校验的 Bone 发布信息。 */
  const release = parseBoneReleaseVersion(version)
  if (!release) throw new Error(`应用版本 ${version} 不是合法的 Bone 发布版本`)
  if (tag !== `v${version}`) throw new Error(`发布标签 ${tag} 与应用版本 ${version} 不一致`)
  return release
}

/**
 * 生成用户可读的 GitHub Release 标题。
 * @param version 完整 Bone 发布版本。
 * @returns 同时包含官方版本和 Bone 构建号的标题。
 */
export function createBoneReleaseTitle(version: string): string {
  /** 用于生成人类可读标题的 Bone 发布信息。 */
  const release = parseBoneReleaseVersion(version)
  if (!release) throw new Error(`应用版本 ${version} 不是合法的 Bone 发布版本`)
  return `Proma ${release.upstreamVersion} · Bone ${release.boneBuild}`
}
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/electron/src/shared/release-version.test.ts`

Expected: 8 tests pass，0 fail。

- [ ] **Step 5: 提交共享版本模型**

```bash
git add apps/electron/src/shared/release-version.ts apps/electron/src/shared/release-version.test.ts
git commit -m "功能：建立 Bone 发布版本合同"
```

### Task 3：区分正式版与开发版系统身份

**Files:**
- Create: `apps/electron/src/main/lib/app-identity.test.ts`
- Create: `apps/electron/src/main/lib/app-identity.ts`
- Modify: `apps/electron/src/main/index.ts:1-15`

- [ ] **Step 1: 先写失败的身份测试**

```typescript
import { describe, expect, test } from 'bun:test'
import { resolveAppIdentity } from './app-identity'

describe('Electron 应用身份', () => {
  test('Given 打包环境 When 解析身份 Then 使用正式版名称和 App ID', () => {
    expect(resolveAppIdentity(true)).toEqual({
      displayName: 'Proma',
      appId: 'com.bone.proma.app',
    })
  })

  test('Given 默认开发环境 When 解析身份 Then 使用独立开发身份', () => {
    expect(resolveAppIdentity(false)).toEqual({
      displayName: 'Proma Dev',
      appId: 'com.bone.proma.dev',
      userDataDirectoryName: '@proma/electron-dev',
    })
  })

  test('Given 多工作树实例 When 解析身份 Then 名称和 userData 都包含清理后的实例名', () => {
    expect(resolveAppIdentity(false, ' feature/1 ')).toEqual({
      displayName: 'Proma Dev - feature1',
      appId: 'com.bone.proma.dev',
      userDataDirectoryName: '@proma/electron-dev-feature1',
    })
  })
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/app-identity.test.ts`

Expected: FAIL，提示找不到 `./app-identity`。

- [ ] **Step 3: 实现纯身份解析函数**

```typescript
/** Electron 运行实例的系统身份。 */
export interface AppIdentity {
  /** Dock、任务栏和系统菜单显示名称。 */
  displayName: string
  /** 系统用于区分应用的稳定标识。 */
  appId: string
  /** 开发实例使用的 Electron userData 目录名。 */
  userDataDirectoryName?: string
}

/**
 * 解析正式版或开发版应用身份。
 * @param isPackaged 当前是否为正式打包环境。
 * @param rawInstance 可选的开发工作树实例名。
 * @returns 当前运行实例应使用的名称、App ID 和 userData 目录。
 */
export function resolveAppIdentity(isPackaged: boolean, rawInstance?: string): AppIdentity {
  if (isPackaged) return { displayName: 'Proma', appId: 'com.bone.proma.app' }
  /** 去除会污染进程名称或目录名的开发实例字符。 */
  const instance = rawInstance?.replace(/[^a-zA-Z0-9_-]/g, '') || undefined
  return {
    displayName: instance ? `Proma Dev - ${instance}` : 'Proma Dev',
    appId: 'com.bone.proma.dev',
    userDataDirectoryName: instance ? `@proma/electron-dev-${instance}` : '@proma/electron-dev',
  }
}
```

- [ ] **Step 4: 在主进程最早阶段应用开发身份**

将 `index.ts` 顶部开发目录逻辑替换为：

```typescript
import { resolveAppIdentity } from './lib/app-identity'

const appIdentity = resolveAppIdentity(app.isPackaged, process.env.PROMA_DEV_INSTANCE)
if (!app.isPackaged && appIdentity.userDataDirectoryName) {
  app.setName(appIdentity.displayName)
  app.setPath('userData', join(app.getPath('appData'), appIdentity.userDataDirectoryName))
  if (process.platform === 'win32') app.setAppUserModelId(appIdentity.appId)
}
```

- [ ] **Step 5: 运行身份测试和主进程类型检查**

Run: `bun test apps/electron/src/main/lib/app-identity.test.ts && bun run --filter='@proma/electron' typecheck`

Expected: 身份测试全部通过，TypeScript 0 errors。

- [ ] **Step 6: 提交应用身份变更**

```bash
git add apps/electron/src/main/lib/app-identity.ts apps/electron/src/main/lib/app-identity.test.ts apps/electron/src/main/index.ts
git commit -m "功能：区分开发版与正式版应用身份"
```

### Task 4：统一应用内版本显示与 fork Release 来源

**Files:**
- Create: `apps/electron/src/shared/release-config.test.ts`
- Create: `apps/electron/src/shared/release-config.ts`
- Create: `apps/electron/src/renderer/lib/app-version-display.test.ts`
- Create: `apps/electron/src/renderer/lib/app-version-display.ts`
- Modify: `apps/electron/src/renderer/components/settings/AboutSettings.tsx:20-31,486-522`
- Modify: `apps/electron/src/main/lib/github-release-service.ts:12-22`

- [ ] **Step 1: 先写失败的 Release 来源与显示模型测试**

```typescript
// apps/electron/src/shared/release-config.test.ts
import { expect, test } from 'bun:test'
import { PROMA_RELEASE_REPOSITORY } from './release-config'

test('fork Release 来源统一指向 kuangtao22/Proma', () => {
  expect(PROMA_RELEASE_REPOSITORY).toEqual({
    owner: 'kuangtao22',
    repo: 'Proma',
    webUrl: 'https://github.com/kuangtao22/Proma',
  })
})
```

```typescript
// apps/electron/src/renderer/lib/app-version-display.test.ts
import { describe, expect, test } from 'bun:test'
import { createAppVersionDisplay } from './app-version-display'

describe('关于页版本显示', () => {
  test('Given Bone 版本 When 格式化 Then 分开显示官方版本和构建号', () => {
    expect(createAppVersionDisplay('0.17.42-bone.5')).toEqual({
      fullVersion: '0.17.42-bone.5',
      upstreamVersion: '0.17.42',
      boneBuild: 5,
    })
  })

  test('Given 非 Bone 版本 When 格式化 Then 保留完整版本且不伪造构建号', () => {
    expect(createAppVersionDisplay('0.17.42')).toEqual({
      fullVersion: '0.17.42',
      upstreamVersion: '0.17.42',
      boneBuild: null,
    })
  })
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/shared/release-config.test.ts apps/electron/src/renderer/lib/app-version-display.test.ts`

Expected: FAIL，两个被测模块均不存在。

- [ ] **Step 3: 实现集中 Release 配置和显示模型**

```typescript
// apps/electron/src/shared/release-config.ts
/** Proma fork 的唯一 Release 仓库配置。 */
export const PROMA_RELEASE_REPOSITORY = {
  owner: 'kuangtao22',
  repo: 'Proma',
  webUrl: 'https://github.com/kuangtao22/Proma',
} as const
```

```typescript
// apps/electron/src/renderer/lib/app-version-display.ts
import { parseBoneReleaseVersion } from '../../shared/release-version'

/** 关于页展示使用的版本信息。 */
export interface AppVersionDisplay {
  /** 完整应用版本。 */
  fullVersion: string
  /** 当前官方基线。 */
  upstreamVersion: string
  /** Bone 构建号；非 Bone 版本不存在。 */
  boneBuild: number | null
}

/**
 * 把完整应用版本转换为关于页展示模型。
 * @param version Vite 注入的完整应用版本。
 * @returns 可分别展示官方版本与 Bone 构建号的数据。
 */
export function createAppVersionDisplay(version: string): AppVersionDisplay {
  /** 合法 Bone 版本可拆分展示；官方纯版本进入回退分支。 */
  const release = parseBoneReleaseVersion(version)
  return release ?? { fullVersion: version, upstreamVersion: version, boneBuild: null }
}
```

- [ ] **Step 4: 将关于页与 GitHub Release 服务统一到 fork**

在 `AboutSettings.tsx` 中加入：

```typescript
import { PROMA_RELEASE_REPOSITORY } from '../../../shared/release-config'
import { createAppVersionDisplay } from '@/lib/app-version-display'

/** Vite 构建时注入的完整应用版本。 */
const APP_VERSION = __APP_VERSION__
/** 关于页分别展示官方基线与 Bone 构建号。 */
const APP_VERSION_DISPLAY = createAppVersionDisplay(APP_VERSION)
/** 手动下载更新时使用的 fork Release 页面。 */
const GITHUB_RELEASES_URL = `${PROMA_RELEASE_REPOSITORY.webUrl}/releases`
```

把单个版本行替换为：

```tsx
<SettingsRow label="官方版本">
  <span className="text-sm text-muted-foreground font-mono">
    {APP_VERSION_DISPLAY.upstreamVersion}
  </span>
</SettingsRow>
{APP_VERSION_DISPLAY.boneBuild !== null && (
  <SettingsRow label="Bone 构建">
    <span className="text-sm text-muted-foreground font-mono">
      {APP_VERSION_DISPLAY.boneBuild}
    </span>
  </SettingsRow>
)}
```

把项目地址链接替换为：

```tsx
<a
  href={PROMA_RELEASE_REPOSITORY.webUrl}
  target="_blank"
  rel="noopener noreferrer"
  className="text-sm text-primary hover:underline"
>
  github.com/{PROMA_RELEASE_REPOSITORY.owner}/{PROMA_RELEASE_REPOSITORY.repo}
</a>
```

在 `github-release-service.ts` 中删除硬编码 `ErlichLiu/Proma`，使用：

```typescript
import { PROMA_RELEASE_REPOSITORY } from '../../shared/release-config'

const GITHUB_REPO = PROMA_RELEASE_REPOSITORY
```

- [ ] **Step 5: 运行定向测试与 Renderer 构建**

Run: `bun test apps/electron/src/shared/release-config.test.ts apps/electron/src/renderer/lib/app-version-display.test.ts && bun run --filter='@proma/electron' build:renderer`

Expected: 3 tests pass；Vite build 成功。

- [ ] **Step 6: 提交版本显示与 Release 来源变更**

```bash
git add apps/electron/src/shared/release-config.ts apps/electron/src/shared/release-config.test.ts apps/electron/src/renderer/lib/app-version-display.ts apps/electron/src/renderer/lib/app-version-display.test.ts apps/electron/src/renderer/components/settings/AboutSettings.tsx apps/electron/src/main/lib/github-release-service.ts
git commit -m "功能：统一 Bone 版本显示与发布来源"
```

### Task 5：启用 Bone 更新频道并升级应用版本

**Files:**
- Modify: `apps/electron/scripts/release-workflow.test.ts`
- Modify: `apps/electron/package.json`
- Modify: `bun.lock`
- Modify: `apps/electron/electron-builder.yml`
- Modify: `apps/electron/src/main/lib/updater/auto-updater.ts:154-168`

- [ ] **Step 1: 先扩展失败的配置合同测试**

在 `release-workflow.test.ts` 中把配置接口扩展为：

```typescript
interface ElectronPackageMetadata {
  /** 当前桌面应用完整版本。 */
  version?: string
  /** Debian 等 Linux 安装包需要展示的项目主页。 */
  homepage?: string
}

interface PlatformArtifactConfig {
  /** 当前平台的安装包文件名模板。 */
  artifactName?: string
}

interface ElectronBuilderConfig {
  /** 正式安装包系统标识。 */
  appId?: string
  /** 正式安装包产品名。 */
  productName?: string
  /** 是否根据预发布后缀自动改变更新频道。 */
  detectUpdateChannel?: boolean
  /** macOS 安装包配置。 */
  mac?: PlatformArtifactConfig
  /** Windows 安装包配置。 */
  win?: PlatformArtifactConfig
  /** Linux 安装包配置。 */
  linux?: PlatformArtifactConfig
}
```

然后增加：

```typescript
test('Bone 应用版本与更新频道保持一致', () => {
  /** Electron workspace 的发布元数据。 */
  const metadata = readElectronPackageMetadata()
  /** Electron Builder 的正式打包配置。 */
  const config = readElectronBuilderConfig()
  /** 自动更新初始化源码，用于锁定预发布设置。 */
  const updaterSource = readFileSync(resolve(import.meta.dir, '../src/main/lib/updater/auto-updater.ts'), 'utf8')

  expect(metadata.version).toBe('0.17.42-bone.5')
  expect(config.detectUpdateChannel).toBe(false)
  expect(updaterSource).toContain('autoUpdater.allowPrerelease = true')
})

test('正式安装包名称包含完整版本、平台和架构', () => {
  /** Electron Builder 的正式打包配置。 */
  const config = readElectronBuilderConfig()
  expect(config.appId).toBe('com.bone.proma.app')
  expect(config.productName).toBe('Proma')
  expect(config.mac?.artifactName).toBe('Proma-${version}-macos-${arch}.${ext}')
  expect(config.win?.artifactName).toBe('Proma-${version}-windows-${arch}.${ext}')
  expect(config.linux?.artifactName).toBe('Proma-${version}-linux-${arch}.${ext}')
})
```

同时删除原有只验证 Linux 旧模板 `Proma-${version}-${arch}.${ext}` 的测试；Linux 已由新的跨平台命名合同覆盖，不能保留互相冲突的断言。

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/scripts/release-workflow.test.ts`

Expected: FAIL，版本仍为 `0.17.42`，频道和跨平台文件名配置缺失。

- [ ] **Step 3: 更新版本与 Builder 配置**

将 `apps/electron/package.json` 的版本改为 `0.17.42-bone.5`，并在 Builder 配置中设置：

```yaml
detectUpdateChannel: false

mac:
  artifactName: "Proma-${version}-macos-${arch}.${ext}"

linux:
  artifactName: "Proma-${version}-linux-${arch}.${ext}"

win:
  artifactName: "Proma-${version}-windows-${arch}.${ext}"
```

在 `initAutoUpdater` 中、`autoDownload` 之前加入：

```typescript
  // Bone 使用预发布 SemVer；显式允许同一官方基线内递增更新。
  autoUpdater.allowPrerelease = true
```

- [ ] **Step 4: 同步 Bun 锁文件**

Run: `bun install --lockfile-only`

Expected: `bun.lock` 中 `apps/electron` workspace 版本更新为 `0.17.42-bone.5`，依赖版本不发生无关漂移。

- [ ] **Step 5: 运行配置合同测试确认 GREEN**

Run: `bun test apps/electron/scripts/release-workflow.test.ts`

Expected: 所有 Release 合同测试通过。

- [ ] **Step 6: 提交版本与更新频道**

```bash
git add apps/electron/package.json bun.lock apps/electron/electron-builder.yml apps/electron/src/main/lib/updater/auto-updater.ts apps/electron/scripts/release-workflow.test.ts
git commit -m "功能：启用 Bone 版本更新与跨平台命名"
```

### Task 6：在 GitHub Actions 构建前验证发布合同

**Files:**
- Create: `apps/electron/scripts/validate-release-version.test.ts`
- Create: `apps/electron/scripts/validate-release-version.ts`
- Modify: `apps/electron/scripts/release-workflow.test.ts`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: 先写失败的发布验证脚本测试**

```typescript
import { describe, expect, test } from 'bun:test'
import { validateReleaseVersion } from './validate-release-version'

describe('发布版本前置校验', () => {
  test('Given 标签与版本一致 When 校验 Then 返回 Actions outputs', () => {
    expect(validateReleaseVersion('0.17.42-bone.5', 'v0.17.42-bone.5')).toEqual({
      version: '0.17.42-bone.5',
      upstreamVersion: '0.17.42',
      boneBuild: '5',
      releaseTitle: 'Proma 0.17.42 · Bone 5',
    })
  })

  test('Given 标签错误 When 校验 Then 在构建前失败', () => {
    expect(() => validateReleaseVersion('0.17.42-bone.5', 'v0.17.42-bone.4'))
      .toThrow('发布标签 v0.17.42-bone.4 与应用版本 0.17.42-bone.5 不一致')
  })
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/scripts/validate-release-version.test.ts`

Expected: FAIL，提示找不到验证脚本。

- [ ] **Step 3: 实现可测试的验证函数和 CLI**

创建以下脚本：

```typescript
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertBoneReleaseTag, createBoneReleaseTitle } from '../src/shared/release-version'

/** GitHub Actions 后续任务需要的发布信息。 */
export interface ValidatedReleaseVersion {
  /** 完整应用版本。 */
  version: string
  /** 当前官方基线。 */
  upstreamVersion: string
  /** 字符串形式的 Bone 构建号。 */
  boneBuild: string
  /** GitHub Release 用户可读标题。 */
  releaseTitle: string
}

/**
 * 校验应用版本与 Git 标签并生成 Actions 输出数据。
 * @param version package.json 中的完整版本。
 * @param tag 触发工作流的 Git 标签。
 * @returns 后续构建和 Release 任务使用的数据。
 */
export function validateReleaseVersion(version: string, tag: string): ValidatedReleaseVersion {
  /** 经过格式和标签一致性校验的发布版本。 */
  const release = assertBoneReleaseTag(version, tag)
  return {
    version: release.fullVersion,
    upstreamVersion: release.upstreamVersion,
    boneBuild: String(release.boneBuild),
    releaseTitle: createBoneReleaseTitle(version),
  }
}

if (import.meta.main) {
  /** Electron workspace package.json 的绝对路径。 */
  const packagePath = resolve(import.meta.dir, '../package.json')
  /** package.json 中本脚本需要的最小元数据。 */
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }
  if (typeof metadata.version !== 'string') throw new Error('apps/electron/package.json 缺少有效版本')

  /** 当前工作流的触发标签。 */
  const tag = process.env.GITHUB_REF_NAME
  if (!tag) throw new Error('GitHub Actions 缺少 GITHUB_REF_NAME')

  /** GitHub Actions 跨步骤输出文件。 */
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) throw new Error('GitHub Actions 缺少 GITHUB_OUTPUT')

  /** 已完成校验的发布信息。 */
  const release = validateReleaseVersion(metadata.version, tag)
  /** 写入 GITHUB_OUTPUT 的稳定键值行。 */
  const outputLines = [
    `version=${release.version}`,
    `upstream_version=${release.upstreamVersion}`,
    `bone_build=${release.boneBuild}`,
    `release_title=${release.releaseTitle}`,
  ]
  appendFileSync(outputPath, `${outputLines.join('\n')}\n`, 'utf8')
  console.log(`[发布校验] ${release.releaseTitle} (${tag})`)
}
```

CLI 将以下键逐行追加到 Actions output 文件：

```text
version=0.17.42-bone.5
upstream_version=0.17.42
bone_build=5
release_title=Proma 0.17.42 · Bone 5
```

若缺少 `GITHUB_REF_NAME` 或 `GITHUB_OUTPUT`，CLI 抛出中文错误并以非零状态退出；纯函数测试不访问环境变量和文件系统。

- [ ] **Step 4: 增加 workflow 结构合同测试**

在 `release-workflow.test.ts` 中断言：

```typescript
expect(workflow.jobs?.['validate-release']?.steps).toEqual(expect.arrayContaining([
  expect.objectContaining({ run: 'bun run apps/electron/scripts/validate-release-version.ts' }),
]))
expect(workflow.jobs?.['build-mac-arm64']?.needs).toContain('validate-release')
expect(workflow.jobs?.['build-mac-x64']?.needs).toContain('validate-release')
expect(workflow.jobs?.['build-windows-x64']?.needs).toContain('validate-release')
expect(workflow.jobs?.['build-linux-x64']?.needs).toContain('validate-release')
expect(readReleaseWorkflow()).toContain('--title "${RELEASE_TITLE}"')
```

- [ ] **Step 5: 修改 Release workflow**

在 `jobs:` 下最先加入：

```yaml
  validate-release:
    name: validate Bone release
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.release.outputs.version }}
      upstream_version: ${{ steps.release.outputs.upstream_version }}
      bone_build: ${{ steps.release.outputs.bone_build }}
      release_title: ${{ steps.release.outputs.release_title }}
    steps:
      - name: 检出代码
        uses: actions/checkout@v4

      - name: 安装 Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: 校验 Bone 发布版本
        id: release
        run: bun run apps/electron/scripts/validate-release-version.ts
```

四个平台 build job 都加入：

```yaml
    needs: [validate-release]
```

Release job 的依赖与成功条件改为：

```yaml
    needs: [validate-release, build-mac-arm64, build-mac-x64, build-windows-x64, build-linux-x64]
    if: >-
      always() && !cancelled() &&
      needs.validate-release.result == 'success' &&
      needs.build-mac-arm64.result == 'success' &&
      needs.build-mac-x64.result == 'success' &&
      needs.build-windows-x64.result == 'success' &&
      needs.build-linux-x64.result == 'success'
```

Release job 的 `needs` 加入验证任务，并将标题传入：

```yaml
      - name: 创建 Release 并上传
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          RELEASE_TITLE: ${{ needs.validate-release.outputs.release_title }}
        run: |
          TAG="${GITHUB_REF_NAME}"
          gh release create "${TAG}" \
            --repo "${GITHUB_REPOSITORY}" \
            --title "${RELEASE_TITLE}" \
            --generate-notes \
            out/release-assets/* \
            || gh release upload "${TAG}" \
              --repo "${GITHUB_REPOSITORY}" \
              --clobber \
              out/release-assets/*
```

- [ ] **Step 6: 运行发布脚本与合同测试确认 GREEN**

Run: `bun test apps/electron/scripts/validate-release-version.test.ts apps/electron/scripts/release-workflow.test.ts`

Expected: 发布验证与 workflow 合同测试全部通过。

- [ ] **Step 7: 提交云端发布合同**

```bash
git add apps/electron/scripts/validate-release-version.ts apps/electron/scripts/validate-release-version.test.ts apps/electron/scripts/release-workflow.test.ts .github/workflows/release.yml
git commit -m "CI：在全平台打包前校验 Bone 发布版本"
```

### Task 7：执行完整回归与打包冒烟验证

**Files:**
- Verify only

- [ ] **Step 1: 运行全部本次定向测试**

Run:

```bash
bun test \
  apps/electron/src/shared/release-version.test.ts \
  apps/electron/src/shared/release-config.test.ts \
  apps/electron/src/main/lib/app-identity.test.ts \
  apps/electron/src/renderer/lib/app-version-display.test.ts \
  apps/electron/scripts/validate-release-version.test.ts \
  apps/electron/scripts/release-workflow.test.ts
```

Expected: 全部通过，0 fail。

- [ ] **Step 2: 运行 fork 兼容检查**

Run: `bun run --filter='@proma/electron' check:fork-compat`

Expected: 9/9 checks pass。

- [ ] **Step 3: 运行全 workspace 类型检查**

Run: `bun run typecheck`

Expected: 所有 workspace 0 TypeScript errors。

- [ ] **Step 4: 运行 Electron 构建**

Run: `bun run electron:build`

Expected: 主进程、utility、preload、renderer、CLI、原生辅助资源构建成功。

- [ ] **Step 5: 运行当前平台安装包冒烟验证**

Run: `bun run --filter='@proma/electron' dist:fast`

Expected: 当前 Apple Silicon 环境产物名包含 `0.17.42-bone.5-macos-arm64`；应用包内版本为 `0.17.42-bone.5`，正式名称为 `Proma`。

- [ ] **Step 6: 检查最终差异和提交状态**

Run: `git diff --check && git status --short --branch && git log -8 --oneline`

Expected: 无未提交代码；分支只领先远端本轮计划内提交。

### Task 8：推送并触发 GitHub 全平台 Release

**Files:**
- External Git/GitHub state only

- [ ] **Step 1: 推送功能分支**

Run: `git push origin codex/lan-trusted-devices`

Expected: 远端分支前进到本轮最终提交。

- [ ] **Step 2: 创建并推送发布标签**

Run:

```bash
git tag -a v0.17.42-bone.5 -m "Proma 0.17.42 · Bone 5"
git push origin v0.17.42-bone.5
```

Expected: GitHub Actions `Release` workflow 由标签触发。

- [ ] **Step 3: 等待全平台构建完成**

Run:

```bash
# 找到刚由 bone.5 标签触发的 Release 工作流。
RUN_ID="$(gh run list --repo kuangtao22/Proma --workflow Release --branch v0.17.42-bone.5 --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --repo kuangtao22/Proma --exit-status
```

Expected: 版本验证、macOS arm64、macOS x64、Windows x64、Linux x64 和 Release 汇总全部 success。

- [ ] **Step 4: 核验 GitHub Release 资产**

Run: `gh release view v0.17.42-bone.5 --repo kuangtao22/Proma --json name,tagName,url,assets`

Expected:

- Release 名称为 `Proma 0.17.42 · Bone 5`。
- 标签为 `v0.17.42-bone.5`。
- macOS、Windows、Linux 文件名都包含完整 Bone 版本、平台和架构。
- `latest-mac.yml`、`latest.yml`、`latest-linux.yml` 均存在。

- [ ] **Step 5: 单独列出可清理历史对象，不自动删除**

Run:

```bash
gh release list --repo kuangtao22/Proma --limit 20
git tag --list 'v0.17.42-bone.*' --sort=version:refname
```

Expected: 输出成功 Release、失败标签和旧草稿的精确清单；等待用户单独确认后才执行删除。
