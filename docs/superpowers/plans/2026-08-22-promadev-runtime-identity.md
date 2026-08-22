# PromaDev 开发运行身份实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将直接启动的 Electron 开发客户端名称统一为 `PromaDev`，正式客户端身份保持不变。

**Architecture:** 继续复用 `resolveAppIdentity()` 作为正式/开发身份的唯一入口，只修改开发分支返回的显示名称。现有 App ID、`userData` 和单实例锁边界全部保留。

**Tech Stack:** Bun、TypeScript、Electron 43、Bun Test。

---

### Task 1：统一开发运行身份名称

**Files:**
- Modify: `apps/electron/src/main/lib/app-identity.test.ts`
- Modify: `apps/electron/src/main/lib/app-identity.ts`
- Modify: `MEMORY.md`

- [x] **Step 1: 写入失败的开发身份断言**

```typescript
expect(resolveAppIdentity(false)).toEqual({
  displayName: 'PromaDev',
  appId: 'com.bone.proma.dev',
  userDataDirectoryName: '@proma/electron-dev',
})

expect(resolveAppIdentity(false, ' feature/1 ')).toEqual({
  displayName: 'PromaDev - feature1',
  appId: 'com.bone.proma.dev',
  userDataDirectoryName: '@proma/electron-dev-feature1',
})
```

- [x] **Step 2: 运行测试确认 RED**

Run: `bun test apps/electron/src/main/lib/app-identity.test.ts`

Expected: 2 个开发身份用例失败，实际值仍为 `Proma Dev`。

- [x] **Step 3: 修改最小实现**

```typescript
return {
  displayName: instance ? `PromaDev - ${instance}` : 'PromaDev',
  appId: 'com.bone.proma.dev',
  userDataDirectoryName: instance ? `@proma/electron-dev-${instance}` : '@proma/electron-dev',
}
```

- [x] **Step 4: 记录长期身份规则并验证**

在 `MEMORY.md` 中将开发版名称更新为 `PromaDev`，然后运行：

```bash
bun test apps/electron/src/main/lib/app-identity.test.ts
bun run typecheck
bun run electron:build
git diff --check
```

Expected: 身份测试、全 workspace typecheck、Electron 构建和差异检查全部通过。

- [x] **Step 5: 提交**

```bash
git add docs/superpowers/specs/2026-08-22-promadev-runtime-identity-design.md docs/superpowers/plans/2026-08-22-promadev-runtime-identity.md apps/electron/src/main/lib/app-identity.test.ts apps/electron/src/main/lib/app-identity.ts MEMORY.md
git commit -m "功能：统一开发客户端名称为 PromaDev"
```
