# About Page Dual Release History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在关于/更新页面用 Tabs 分开展示 Bone 修改版本与官方版本历史，同时确保自动更新仍只使用 fork Release。

**Architecture:** 共享类型只暴露 `bone | official` 两个历史来源，主进程把它们映射到两个固定仓库并独立缓存；最新版本与按标签查询保持固定访问 Bone 仓库。Renderer 为两个来源分别维护加载、错误、列表与展开状态，并在首次切换时懒加载。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Radix Tabs、bun:test

---

### Task 1: 锁定双来源 Release 服务合同

**Files:**
- Modify: `packages/shared/src/types/github.ts`
- Modify: `apps/electron/src/shared/release-config.ts`
- Create: `apps/electron/src/main/lib/github-release-service.test.ts`
- Modify: `apps/electron/src/main/lib/github-release-service.ts`

- [ ] **Step 1: 编写失败测试**

在服务测试中用可注入的 `fetch` 依次返回 Bone、官方和混杂标签，验证：未传来源时访问 `kuangtao22/Proma`；`official` 访问 `ErlichLiu/Proma`；Bone 只保留 `v1.2.3-bone.4`；官方只保留 `v1.2.3`；清空缓存后两个来源不会互相复用。

```ts
test('默认查询 Bone 历史并过滤非 Bone 标签', async () => {
  const releases = await listReleases({ perPage: 3 })
  expect(requestedUrls[0]).toContain('/repos/kuangtao22/Proma/releases')
  expect(releases.map(release => release.tag_name)).toEqual(['v0.17.55-bone.1'])
})

test('官方历史使用独立仓库和缓存', async () => {
  const releases = await listReleases({ source: 'official', perPage: 3 })
  expect(requestedUrls.at(-1)).toContain('/repos/ErlichLiu/Proma/releases')
  expect(releases.map(release => release.tag_name)).toEqual(['v0.17.55'])
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test apps/electron/src/main/lib/github-release-service.test.ts`

Expected: FAIL，因为 `source` 类型、官方仓库配置和测试注入入口尚不存在。

- [ ] **Step 3: 增加受限来源类型和固定仓库配置**

```ts
export type GitHubReleaseHistorySource = 'bone' | 'official'

export interface GitHubReleaseListOptions {
  perPage?: number
  page?: number
  includePrerelease?: boolean
  /** 历史版本来源，默认使用 Bone。 */
  source?: GitHubReleaseHistorySource
}

export const PROMA_OFFICIAL_RELEASE_REPOSITORY = {
  owner: 'ErlichLiu',
  repo: 'Proma',
  webUrl: 'https://github.com/ErlichLiu/Proma',
} as const
```

- [ ] **Step 4: 实现来源映射、标签过滤和独立缓存**

服务内部使用 `Record<GitHubReleaseHistorySource, ReleaseCache | null>`；`listReleases` 默认 `source = 'bone'`，根据来源选择固定仓库并应用严格标签正则。`getLatestRelease` 与 `getReleaseByTag` 不接受来源参数，继续显式传入 `PROMA_RELEASE_REPOSITORY`。

```ts
const BONE_TAG_PATTERN = /^v\d+\.\d+\.\d+-bone\.\d+$/
const OFFICIAL_TAG_PATTERN = /^v\d+\.\d+\.\d+$/

function matchesReleaseSource(release: GitHubRelease, source: GitHubReleaseHistorySource): boolean {
  const pattern = source === 'bone' ? BONE_TAG_PATTERN : OFFICIAL_TAG_PATTERN
  return !release.draft && !release.prerelease && pattern.test(release.tag_name)
}
```

- [ ] **Step 5: 运行服务测试并提交**

Run: `bun test apps/electron/src/main/lib/github-release-service.test.ts`

Expected: PASS。

```bash
git add packages/shared/src/types/github.ts apps/electron/src/shared/release-config.ts apps/electron/src/main/lib/github-release-service.ts apps/electron/src/main/lib/github-release-service.test.ts
git commit -m "功能：支持双来源版本历史查询"
```

### Task 2: 实现版本历史 Tabs 与独立状态

**Files:**
- Create: `apps/electron/src/renderer/components/settings/version-history-state.ts`
- Create: `apps/electron/src/renderer/components/settings/version-history-state.test.ts`
- Modify: `apps/electron/src/renderer/components/settings/VersionHistory.tsx`

- [ ] **Step 1: 编写失败的状态测试**

为 `createVersionHistoryState` 与 reducer 覆盖默认 Bone、官方首次切换需要加载、每个来源独立保存 releases/error/expandedIds，以及刷新只把当前来源标记为 loading。

```ts
test('两个来源的列表与错误状态彼此隔离', () => {
  const state = createVersionHistoryState()
  const next = reduceVersionHistoryState(state, {
    type: 'load-success',
    source: 'bone',
    releases: [boneRelease],
  })
  expect(next.bone.releases).toEqual([boneRelease])
  expect(next.official.releases).toEqual([])
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test apps/electron/src/renderer/components/settings/version-history-state.test.ts`

Expected: FAIL，因为状态模块尚不存在。

- [ ] **Step 3: 实现小型纯状态模块**

定义来源状态 `releases/loading/loaded/error/expandedIds`，并实现 `load-start`、`load-success`、`load-error`、`toggle-expanded` 四种动作。所有更新只替换目标来源，便于组件使用 `useReducer` 且能直接单元测试。

- [ ] **Step 4: 接入现有 Tabs 和懒加载**

`VersionHistory` 默认 `bone`；首次挂载加载 Bone；切换到未加载来源时调用 `listReleases({ source, perPage: 3, includePrerelease: false })`；刷新按钮强制加载当前来源；列表、错误、loading 和展开状态均读取当前来源。复用现有 `Tabs`、`TabsList`、`TabsTrigger`、`TabsContent` 和主题变量。

```tsx
<Tabs value={activeSource} onValueChange={handleSourceChange}>
  <TabsList aria-label="版本历史来源">
    <TabsTrigger value="bone">Proma 修改</TabsTrigger>
    <TabsTrigger value="official">官方版本</TabsTrigger>
  </TabsList>
  <TabsContent value={activeSource}>{renderReleaseList()}</TabsContent>
</Tabs>
```

- [ ] **Step 5: 运行状态测试并提交**

Run: `bun test apps/electron/src/renderer/components/settings/version-history-state.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/renderer/components/settings/version-history-state.ts apps/electron/src/renderer/components/settings/version-history-state.test.ts apps/electron/src/renderer/components/settings/VersionHistory.tsx
git commit -m "界面：新增双版本历史标签页"
```

### Task 3: 锁定自动更新隔离并完成验证

**Files:**
- Modify: `apps/electron/scripts/release-workflow.test.ts`
- Modify: `MEMORY.md`

- [ ] **Step 1: 扩充发布合同测试**

读取 Release 配置、服务和更新器源码，验证 Bone 仓库仍为 `kuangtao22/Proma`、官方仓库只出现在历史列表配置、`getLatestRelease` 与 `getReleaseByTag` 不接受来源、`autoUpdater.allowPrerelease = true` 保持不变。

- [ ] **Step 2: 运行相关测试**

Run: `bun test apps/electron/src/main/lib/github-release-service.test.ts apps/electron/src/renderer/components/settings/version-history-state.test.ts apps/electron/scripts/release-workflow.test.ts`

Expected: 全部 PASS。

- [ ] **Step 3: 运行类型与构建验证**

Run: `bun run typecheck`

Expected: 退出码 0。

Run: `bun run electron:build`

Expected: 退出码 0。

- [ ] **Step 4: 运行全量测试并记录已知基线**

Run: `bun test`

Expected: 本次相关测试全部通过；若仓库既有失败仍存在，需与合并后基线 `1376 pass / 15 fail / 1 error` 对照，确认没有新增失败。

- [ ] **Step 5: 更新项目记忆并提交**

在 `MEMORY.md` 记录：关于页双版本历史按来源隔离；Bone 为默认且唯一更新源；官方历史仅懒加载展示。

```bash
git add apps/electron/scripts/release-workflow.test.ts MEMORY.md
git commit -m "测试：锁定 Bone 自动更新边界"
```

- [ ] **Step 6: 检查最终差异**

Run: `git status --short && git diff HEAD~3 --check`

Expected: 工作区干净，`git diff --check` 无输出。
