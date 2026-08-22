# Proma Dev Safe Storage Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复开发客户端的 `Proma Dev` 显示名，同时固定使用可解密现有凭据的 `@proma/electron` Safe Storage 身份。

**Architecture:** `resolveAppIdentity()` 同时返回开发显示名和稳定 Safe Storage 名称。Electron 在 `ready` 前设置加密身份并保持独立 `userData`，在 `ready` 后恢复用户可见名称；共享业务配置和所有凭据读写代码保持不变。

**Tech Stack:** Bun、TypeScript、Electron 43、`bun:test`

---

### Task 1: 恢复开发运行时名称

**Files:**
- Modify: `apps/electron/src/main/lib/app-identity.test.ts`
- Modify: `apps/electron/src/main/lib/app-identity.ts`
- Modify: `apps/electron/src/main/index.ts`

- [x] **Step 1: 写入失败的身份回归测试**

把默认开发实例和多工作树实例的期望名称改为：

```ts
expect(resolveAppIdentity(false)).toEqual({
  displayName: 'Proma Dev',
  appId: 'com.bone.proma.dev',
  safeStorageName: '@proma/electron',
  userDataDirectoryName: '@proma/electron-dev',
})

expect(resolveAppIdentity(false, ' feature/1 ')).toEqual({
  displayName: 'Proma Dev - feature1',
  appId: 'com.bone.proma.dev',
  safeStorageName: '@proma/electron',
  userDataDirectoryName: '@proma/electron-dev-feature1',
})
```

- [x] **Step 2: 验证测试因旧实现失败**

Run: `bun test apps/electron/src/main/lib/app-identity.test.ts`

Expected: 两个开发身份用例失败，返回值缺少稳定的 `safeStorageName`。

- [x] **Step 3: 最小修改身份解析与启动顺序**

把开发环境返回值恢复为：

```ts
return {
  displayName: instance ? `Proma Dev - ${instance}` : 'Proma Dev',
  appId: 'com.bone.proma.dev',
  safeStorageName: '@proma/electron',
  userDataDirectoryName: instance ? `@proma/electron-dev-${instance}` : '@proma/electron-dev',
}
```

开发启动时先执行：

```ts
app.setName(appIdentity.safeStorageName)
app.setPath('userData', join(app.getPath('appData'), appIdentity.userDataDirectoryName))
```

并在 `ready` 后、`bootstrap()` 前恢复显示名：

```ts
app.whenReady().then(() => {
  if (!app.isPackaged) app.setName(appIdentity.displayName)
  return bootstrap()
}).catch(handleBootstrapFailure)
```

- [x] **Step 4: 验证身份测试通过**

Run: `bun test apps/electron/src/main/lib/app-identity.test.ts`

Expected: 3 个测试全部通过。

### Task 2: 验证并记录稳定身份

**Files:**
- Modify: `MEMORY.md`

- [x] **Step 1: 更新长期架构决策**

将开发版身份记录恢复为：

```md
- 正式版身份固定为 `Proma` / `com.bone.proma.app`，开发版固定显示为 `Proma Dev` / `com.bone.proma.dev`；两者隔离 Electron `userData` 和单实例锁，继续共享 `~/.proma` 业务配置。开发版在 Electron `ready` 前固定使用 `@proma/electron` Safe Storage 身份，禁止把展示名直接用于加密身份。
```

并追加本次会话记录，说明 `PromaDev` 和 `Proma Dev` 均无法解密历史密文，已恢复真实的 `@proma/electron` 加密身份并与显示名解耦。

- [x] **Step 2: 运行类型检查**

Run: `bun run typecheck`

Expected: 命令退出码为 0。

- [x] **Step 3: 检查变更范围**

Run: `git diff --check && git status --short`

Expected: 无格式错误，变更仅包含身份实现、测试、计划和项目记忆。

- [x] **Step 4: 重启开发客户端并观察日志**

Run: `bun run dev`

Expected: 开发客户端显示为 `Proma Dev`，读取共享渠道、飞书和微信配置时不再出现 Safe Storage 解密失败。
