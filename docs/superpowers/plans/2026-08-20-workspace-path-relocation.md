# Proma Workspace Path Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户迁移外部本地项目，或把 Proma 托管项目迁出到独立目录，并在运行任务、Automation 或 Git worktree 存在时安全阻断。

**Architecture:** 复用数据根计划已经交付的 `VerifiedDirectoryCopier` 和 `OwnedPathRebaser`。项目迁移通过工作区独占锁和可恢复 journal 串行执行，复制校验完成后按固定顺序更新会话绝对路径与 `projectRootPath`，源目录始终保留。

**Tech Stack:** Bun、TypeScript、Electron 43、React、Jotai、现有 AgentOrchestrator、Automation scheduler、workspace watcher、Radix/shadcn primitives。

**工程约束:** 所有新增方法和变量配套中文用途注释；不使用 `any`；工作区索引和 journal 统一通过 `safe-file.ts`；每个任务保持 BDD 测试先行。

**Prerequisite:** `2026-08-20-data-root-management.md` 已全部实施并通过验证。

---

## 文件边界

**新增文件：**

- `apps/electron/src/main/lib/workspace-operation-lock.ts`：工作区独占操作锁和运行守卫。
- `apps/electron/src/main/lib/workspace-operation-lock.test.ts`：锁冲突与释放测试。
- `apps/electron/src/main/lib/workspace-project-relocator.ts`：预检、journal、复制、引用提交和恢复。
- `apps/electron/src/main/lib/workspace-project-relocator.test.ts`：托管/外部项目、失败回滚和恢复测试。
- `apps/electron/src/main/lib/agent-orchestrator.test.ts`：迁移锁早于用户消息持久化的回归测试。
- `apps/electron/src/main/lib/automation-scheduler.test.ts`：迁移期间 Automation 跳过执行的回归测试。
- `apps/electron/src/renderer/components/settings/WorkspacePathList.tsx`：项目路径列表与迁移对话框。
- `apps/electron/src/renderer/components/settings/WorkspacePathList.test.tsx`：列表状态和交互测试。

**修改文件：**

- `packages/shared/src/types/path-management.ts`：增加工作区迁移输入、状态和进度类型。
- `apps/electron/src/main/lib/agent-orchestrator.ts`：在持久化用户消息前检查工作区锁。
- `apps/electron/src/main/lib/automation-scheduler.ts`：Automation 启动前检查工作区锁，并暴露运行状态查询。
- `apps/electron/src/main/lib/agent-session-manager.ts`：增加批量重写工作区会话路径的纯更新函数。
- `apps/electron/src/main/lib/agent-workspace-manager.ts`：增加工作区路径提交和工作区配置路径重写函数。
- `apps/electron/src/main/lib/path-management-ipc.ts`：注册工作区迁移 IPC 和进度事件。
- `apps/electron/src/main/lib/path-management-ipc.test.ts`：增加工作区迁移、watcher 切换与恢复注册测试。
- `apps/electron/src/main/index.ts`：正常业务服务启动前恢复未完成的工作区迁移 journal。
- `apps/electron/src/main/ipc.ts`：复用 watcher 释放/重建逻辑。
- `apps/electron/src/preload/index.ts`：暴露工作区迁移 API。
- `apps/electron/src/renderer/components/settings/PathManagementSettings.tsx`：加入项目路径区块。

### Task 1: 扩展工作区迁移合同与独占锁

**Files:**
- Modify: `packages/shared/src/types/path-management.ts`
- Create: `apps/electron/src/main/lib/workspace-operation-lock.test.ts`
- Create: `apps/electron/src/main/lib/workspace-operation-lock.ts`

- [ ] **Step 1: 写锁行为测试**

```ts
test('Given 工作区迁移锁存在 When Agent 请求运行 Then 返回明确阻断原因', () => {
  const release = acquireWorkspaceOperation('workspace-1', 'relocation')
  expect(getWorkspaceOperationBlockReason('workspace-1')).toBe('项目正在迁移，请等待完成后重试')
  release()
  expect(getWorkspaceOperationBlockReason('workspace-1')).toBeUndefined()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/workspace-operation-lock.test.ts`

Expected: FAIL，锁模块不存在。

- [ ] **Step 3: 定义共享类型**

```ts
export type WorkspaceRelocationStage = 'preflight' | 'copying' | 'verifying' | 'committing' | 'failed' | 'completed'
export type WorkspaceOperationKind = 'relocation'

export interface StartWorkspaceRelocationInput {
  workspaceId: string
  targetRoot: string
}

export interface WorkspaceRelocationProgress {
  operationId: string
  workspaceId: string
  stage: WorkspaceRelocationStage
  completedBytes: number
  totalBytes: number
  currentRelativePath?: string
  error?: string
}

export interface WorkspacePathState {
  workspaceId: string
  name: string
  sourceRoot: string
  kind: 'managed' | 'external'
  availability: 'available' | 'missing' | 'unavailable'
  relocation: WorkspaceRelocationProgress | null
}
```

在 `PATH_MANAGEMENT_IPC_CHANNELS` 增加 `START_WORKSPACE_RELOCATION`、`GET_WORKSPACE_RELOCATION_STATUS`、`CANCEL_WORKSPACE_RELOCATION` 和 `WORKSPACE_RELOCATION_PROGRESS`；同时让 `PathManagementState` 增加 `workspaces: WorkspacePathState[]`。

- [ ] **Step 4: 实现进程内工作区锁**

```ts
/** 工作区级排他操作；返回幂等释放函数。 */
export function acquireWorkspaceOperation(workspaceId: string, kind: WorkspaceOperationKind): () => void {
  if (activeOperations.has(workspaceId)) throw new Error('项目已有排他操作正在执行')
  activeOperations.set(workspaceId, kind)
  let released = false
  return () => {
    if (released) return
    released = true
    activeOperations.delete(workspaceId)
  }
}
```

- [ ] **Step 5: 运行锁测试并提交**

Run: `bun test apps/electron/src/main/lib/workspace-operation-lock.test.ts`

Expected: PASS。

```bash
git add packages/shared/src/types/path-management.ts apps/electron/src/main/lib/workspace-operation-lock.ts apps/electron/src/main/lib/workspace-operation-lock.test.ts
git commit -m "功能：增加项目迁移合同与工作区独占锁"
```

### Task 2: 在 Agent 与 Automation 入口阻止迁移期间的新任务

**Files:**
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/automation-scheduler.ts`
- Create: `apps/electron/src/main/lib/agent-orchestrator.test.ts`
- Create: `apps/electron/src/main/lib/automation-scheduler.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: 写“消息不落盘”和 Automation 跳过测试**

```ts
test('Given 项目正在迁移 When 发送 Agent 消息 Then 拒绝运行且不持久化用户消息', async () => {
  const release = acquireWorkspaceOperation('workspace-1', 'relocation')
  try {
    await orchestrator.sendMessage(input, callbacks)
    expect(callbacks.onError).toHaveBeenCalledWith('项目正在迁移，请等待完成后重试')
    expect(appendSDKMessages).not.toHaveBeenCalled()
  } finally {
    release()
  }
})

test('Given 项目正在迁移 When Automation 到期 Then 记录 skipped 且不创建会话', async () => {
  const release = acquireWorkspaceOperation('workspace-1', 'relocation')
  try {
    await runAutomation(automation)
    expect(createAgentSession).not.toHaveBeenCalled()
    expect(appendRun).toHaveBeenCalledWith(automation.id, expect.objectContaining({ status: 'skipped' }))
  } finally {
    release()
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/automation-scheduler.test.ts`

Expected: FAIL，运行入口尚未读取锁。

- [ ] **Step 3: 在消息持久化之前增加守卫**

```ts
/** 迁移锁必须在 persistInitialUserMessage() 之前检查，避免被拒绝消息落盘。 */
const effectiveWorkspaceId = requestedWorkspaceId ?? sessionMeta?.workspaceId
const workspaceBlockReason = effectiveWorkspaceId
  ? getWorkspaceOperationBlockReason(effectiveWorkspaceId)
  : undefined
if (workspaceBlockReason) {
  callbacks.onError(workspaceBlockReason)
  completeBeforeRun()
  return
}
```

Automation 在 `runningAutomations.add()` 和 `createAgentSession()` 之前检查同一锁，记录 `skipped`，`skipReason` 使用相同用户可见文案。

`ipc.ts` 中会修改工作区配置或会话附加路径的写 IPC，在解析出 `workspaceId` 后调用同一守卫；至少覆盖项目重定位、工作区目录/文件附加与移除、会话目录/文件附加与移除。只读列表 IPC 不受影响。

- [ ] **Step 4: 暴露当前 Automation 运行查询**

```ts
/** 判断指定工作区是否有正在执行的 Automation。 */
export function hasRunningAutomationForWorkspace(workspaceId: string): boolean {
  return [...runningAutomations].some((automationId) => getAutomation(automationId)?.workspaceId === workspaceId)
}
```

- [ ] **Step 5: 运行测试并提交**

Run: `bun test apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/automation-scheduler.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/automation-scheduler.ts apps/electron/src/main/lib/automation-scheduler.test.ts apps/electron/src/main/ipc.ts
git commit -m "修复：项目迁移期间阻止 Agent 与自动任务写入"
```

### Task 3: 实现项目迁移预检、journal 与恢复

**Files:**
- Create: `apps/electron/src/main/lib/workspace-project-relocator.test.ts`
- Create: `apps/electron/src/main/lib/workspace-project-relocator.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `apps/electron/src/main/lib/agent-workspace-manager.ts`

- [ ] **Step 1: 写托管项目迁出和失败回滚测试**

```ts
test('Given Proma 托管项目 When 迁出成功 Then projectRootPath 指向目标且源目录保留', async () => {
  const result = await relocateWorkspaceProject({ workspaceId, targetRoot })
  expect(result.projectRootPath).toBe(targetRoot)
  expect(existsSync(managedWorkspaceFilesRoot)).toBe(true)
})

test('Given 校验失败 When 迁移项目 Then 索引仍指向旧根', async () => {
  await expect(relocator.run(input, failingCopier)).rejects.toThrow('文件校验失败')
  expect(getAgentWorkspace(workspaceId)?.projectRootPath).toBe(sourceRoot)
})
```

- [ ] **Step 2: 写 worktree 与运行状态阻断测试**

```ts
test('Given 仓库存在 linked worktree When 预检 Then 拒绝迁移', async () => {
  await expect(preflightWorkspaceRelocation({ workspaceId, targetRoot })).rejects.toThrow('请先移除 linked worktree')
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/workspace-project-relocator.test.ts`

Expected: FAIL，迁移器不存在。

- [ ] **Step 4: 实现预检和可恢复 journal**

```ts
/** 项目迁移 journal 存在于活动数据根，启动后可幂等恢复提交阶段。 */
interface WorkspaceRelocationJournal {
  version: 1
  operationId: string
  workspaceId: string
  sourceRoot: string
  targetRoot: string
  stage: 'copying' | 'verifying' | 'committing' | 'failed'
}
```

预检必须检查：项目存在、目标为空、路径不嵌套、空间足够、无活跃会话、无运行 Automation、无 `activeWorktree`。Git 状态复用 `git-diff-service.ts` 的 `listWorktrees(sourceRoot)`；返回任一非主工作树，或源目录本身是 linked worktree 时拒绝迁移，不直接猜测 `.git/worktrees` 目录内容。

- [ ] **Step 5: 实现固定提交顺序**

```ts
/** 提交阶段幂等执行；journal 只在两个索引都成功后删除。 */
async function commitWorkspaceRelocation(journal: WorkspaceRelocationJournal): Promise<AgentWorkspace> {
  rebaseWorkspaceSessionPaths(journal.workspaceId, journal.sourceRoot, journal.targetRoot)
  rebaseWorkspaceConfigPaths(journal.workspaceId, journal.sourceRoot, journal.targetRoot)
  return updateAgentWorkspaceProjectRoot(journal.workspaceId, journal.targetRoot)
}
```

三个更新函数都使用 `writeJsonFileAtomic()`。Pi 的 `sdkSessionId`、`piSessionFile` 和 `piEntryBindings` 保持不变；只重写根内 `forkSourceDir`、`attachedDirectories`、`attachedFiles` 和工作区 config 路径。

- [ ] **Step 6: 运行迁移器测试并提交**

Run: `bun test apps/electron/src/main/lib/workspace-project-relocator.test.ts`

Expected: PASS，包括 crash 后从 `committing` journal 幂等恢复。

```bash
git add apps/electron/src/main/lib/workspace-project-relocator.ts apps/electron/src/main/lib/workspace-project-relocator.test.ts apps/electron/src/main/lib/agent-session-manager.ts apps/electron/src/main/lib/agent-workspace-manager.ts
git commit -m "功能：增加项目文件迁移与中断恢复"
```

### Task 4: 接入 IPC、watcher 和进度事件

**Files:**
- Modify: `apps/electron/src/main/lib/path-management-ipc.ts`
- Modify: `apps/electron/src/main/lib/path-management-ipc.test.ts`
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`

- [ ] **Step 1: 写 IPC 合同测试**

```ts
test('Given 工作区迁移完成 When handler 返回 Then 释放旧 watcher 并监听新根', async () => {
  await handler({ workspaceId, targetRoot })
  expect(unwatchAttachedDirectory).toHaveBeenCalledWith(sourceRoot)
  expect(watchAttachedDirectory).toHaveBeenCalledWith(targetRoot)
})

test('Given 启动时存在 committing journal When 普通服务初始化 Then 先幂等完成路径提交', async () => {
  const callOrder: string[] = []
  updateAgentWorkspaceProjectRoot.mockImplementation(() => callOrder.push('workspace-root-committed'))
  startAutomationScheduler.mockImplementation(() => callOrder.push('automation-started'))
  await resumeWorkspaceRelocationJournals()
  startAutomationScheduler()
  expect(callOrder).toEqual(['workspace-root-committed', 'automation-started'])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/path-management-ipc.test.ts`

Expected: FAIL，工作区迁移通道未注册。

- [ ] **Step 3: 注册 typed handler 和 preload API**

```ts
/** 开始迁移指定工作区的实际项目文件。 */
startWorkspaceRelocation: (input: StartWorkspaceRelocationInput) => Promise<void>
/** 获取正在执行或可恢复的项目迁移状态。 */
getWorkspaceRelocationStatus: (workspaceId: string) => Promise<WorkspaceRelocationProgress | null>
/** 取消指定项目迁移；保留已经复制的目标副本。 */
cancelWorkspaceRelocation: (workspaceId: string) => Promise<void>
/** 订阅项目迁移进度。 */
onWorkspaceRelocationProgress: (callback: (progress: WorkspaceRelocationProgress) => void) => () => void
```

handler 完成后调用现有 `releaseDirectoryWatcherIfUnreferenced(sourceRoot)` 和 `watchAttachedDirectory(targetRoot)`，再向 renderer 广播工作区列表刷新。

`main/index.ts` 在数据根确认可用后、Agent/LAN/Automation/watcher 初始化前调用 `resumeWorkspaceRelocationJournals()`。`copying`、`verifying` 或 `failed` journal 恢复锁并等待用户继续；`committing` journal 自动幂等完成提交，避免正常服务看到一半更新的路径事实。

- [ ] **Step 4: 运行 IPC 测试并提交**

Run: `bun test apps/electron/src/main/lib/path-management-ipc.test.ts`

Expected: PASS。

```bash
git add apps/electron/src/main/lib/path-management-ipc.ts apps/electron/src/main/lib/path-management-ipc.test.ts apps/electron/src/main/index.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts
git commit -m "功能：接入项目迁移 IPC 与目录监听切换"
```

### Task 5: 在路径设置页增加项目列表和迁移对话框

**Files:**
- Create: `apps/electron/src/renderer/components/settings/WorkspacePathList.test.tsx`
- Create: `apps/electron/src/renderer/components/settings/WorkspacePathList.tsx`
- Modify: `apps/electron/src/renderer/components/settings/PathManagementSettings.tsx`

- [ ] **Step 1: 写三种项目状态测试**

```tsx
test('Given 外部、托管和离线项目 When 渲染列表 Then 操作分别为迁移、迁出和重定位', () => {
  render(<WorkspacePathList workspaces={workspaces} />)
  expect(screen.getByRole('button', { name: '迁移 Proma' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '迁出 个人笔记' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '重定位 旧网站' })).toBeInTheDocument()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/renderer/components/settings/WorkspacePathList.test.tsx`

Expected: FAIL，组件不存在。

- [ ] **Step 3: 复用 SettingsCard/Row 实现列表**

```tsx
<SettingsSection
  title="项目文件路径"
  description="管理项目实际文件位置；Skills、会话工作台和项目设置仍存放在 Proma 数据目录。"
>
  <SettingsCard>
    {workspaces.map((workspace) => (
      <WorkspacePathRow key={workspace.id} workspace={workspace} onRelocate={openRelocationDialog} />
    ))}
  </SettingsCard>
</SettingsSection>
```

对话框展示源、目标、空间和阻断原因；迁移开始后按钮禁用并显示稳定尺寸进度条。文件名使用 `truncate`，不能改变对话框尺寸。

- [ ] **Step 4: 运行 UI 测试并提交**

Run: `bun test apps/electron/src/renderer/components/settings/WorkspacePathList.test.tsx`

Expected: PASS。

```bash
git add apps/electron/src/renderer/components/settings/WorkspacePathList.tsx apps/electron/src/renderer/components/settings/WorkspacePathList.test.tsx apps/electron/src/renderer/components/settings/PathManagementSettings.tsx
git commit -m "界面：增加项目文件路径管理与迁移进度"
```

### Task 6: 完成项目迁移验证

**Files:**
- Test: `apps/electron/src/main/lib/workspace-operation-lock.test.ts`
- Test: `apps/electron/src/main/lib/agent-orchestrator.test.ts`
- Test: `apps/electron/src/main/lib/automation-scheduler.test.ts`
- Test: `apps/electron/src/main/lib/workspace-project-relocator.test.ts`
- Test: `apps/electron/src/main/lib/path-management-ipc.test.ts`
- Test: `apps/electron/src/renderer/components/settings/WorkspacePathList.test.tsx`

- [ ] **Step 1: 运行目标测试**

Run: `bun test apps/electron/src/main/lib/workspace-operation-lock.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/automation-scheduler.test.ts apps/electron/src/main/lib/workspace-project-relocator.test.ts apps/electron/src/main/lib/path-management-ipc.test.ts apps/electron/src/renderer/components/settings/WorkspacePathList.test.tsx`

Expected: PASS。

- [ ] **Step 2: 运行回归、类型和构建**

Run: `bun test apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/lib/workspace-watcher.test.ts apps/electron/src/main/lib/automation-scheduler.test.ts`

Expected: PASS。

Run: `bun run typecheck`

Expected: PASS。

Run: `bun run electron:build`

Expected: PASS。

- [ ] **Step 3: 人工冒烟验证**

Run: `bun run dev`

Expected:

- 外部测试项目可迁移到另一个本机目录，旧目录保留。
- Proma 托管项目可迁出，下一轮 Agent cwd 为新目录。
- 运行中的 Agent、Automation 和 linked worktree 会显示明确阻断原因。
- 迁移后历史 Pi 会话仍可继续，fork/rewind 不因 cwd 改变报错。
- 项目磁盘断开后显示离线，重定位只改引用，迁移才复制文件。
- 浅色、深色和一个自定义主题下路径文本、状态和按钮无溢出。

- [ ] **Step 4: 处理验证失败**

若任一验证失败，回到拥有该文件的 Task，先补充能复现问题的 BDD 测试，再修复并使用该 Task 已列出的精确文件范围提交；全部验证通过前不创建笼统的“收口”提交。
