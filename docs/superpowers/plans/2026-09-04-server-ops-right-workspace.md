# Server Ops Right Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Agent 右侧工作区中加入可运行的 Linux 服务器运维入口，并先交付主机资产 CRUD、原子持久化和 Canvas 风格服务器抽屉。

**Architecture:** 主机资产是应用级本地配置，存放在 `~/.proma/server-ops/hosts.json`，由主进程 Store 负责校验、原子写入和复制返回值；Renderer 仅通过四层 IPC 合同访问。运维 UI 注册为 `WorkspaceComponentTab`，保持当前 Agent 会话和中间对话区不变；首个纵切不建立 SSH、数据库或 Redis 连接，只为后续连接、审计和审批建立稳定的服务器身份边界。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Jotai、Radix/shadcn、Tailwind CSS、Bun Test。

---

### Task 1: 共享主机模型与 IPC 合同

**Files:**
- Create: `packages/shared/src/types/server-ops.ts`
- Modify: `packages/shared/src/types/index.ts`
- Test: `packages/shared/src/types/server-ops.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('严格解析合法主机并拒绝密码字段和越界端口', () => {
  expect(parseServerOpsHostInput({
    name: '生产 API',
    address: '10.0.0.8',
    port: 22,
    username: 'deploy',
    authMethod: 'ssh-agent',
    tags: ['生产'],
  })).toEqual({
    name: '生产 API',
    address: '10.0.0.8',
    port: 22,
    username: 'deploy',
    authMethod: 'ssh-agent',
    tags: ['生产'],
  })
  expect(() => parseServerOpsHostInput({ address: '10.0.0.8', port: 0 })).toThrow()
  expect(() => parseServerOpsHostInput({ address: '10.0.0.8', password: 'secret' })).toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/types/server-ops.test.ts`

Expected: FAIL because `./server-ops` does not exist.

- [ ] **Step 3: Write minimal implementation**

定义 `ServerOpsAuthMethod`、`ServerOpsHostInput`、`ServerOpsHost`、`ServerOpsUpsertHostInput`、`SERVER_OPS_IPC_CHANNELS` 和严格运行时 parser。输入只允许主机地址、端口、用户名、认证方式、密钥路径和标签；禁止密码进入该合同。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/types/server-ops.test.ts`

Expected: PASS.

### Task 2: 主进程主机资产 Store

**Files:**
- Create: `apps/electron/src/main/lib/server-ops/server-ops-host-store.ts`
- Test: `apps/electron/src/main/lib/server-ops/server-ops-host-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('新增、更新和删除主机都通过安全原子 JSON 文件持久化', () => {
  const store = new ServerOpsHostStore(configDir, { uuid: () => 'host-1', now: () => 1_000 })
  const created = store.upsert({ name: '生产 API', address: '10.0.0.8', port: 22, username: 'deploy', authMethod: 'ssh-agent', tags: [] })
  expect(store.list()).toEqual([created])
  expect(JSON.parse(readFileSync(join(configDir, 'server-ops', 'hosts.json'), 'utf8'))).toEqual([created])
  expect(store.upsert({ ...created, name: '生产 API 01' }).name).toBe('生产 API 01')
  expect(store.remove(created.id)).toBe(true)
  expect(store.list()).toEqual([])
})

test('损坏文件降级为空列表且返回值不能修改内部状态', () => {
  writeFileSync(join(configDir, 'server-ops', 'hosts.json'), '{broken')
  const store = new ServerOpsHostStore(configDir)
  const hosts = store.list()
  hosts.push(sampleHost)
  expect(store.list()).toEqual([])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/electron/src/main/lib/server-ops/server-ops-host-store.test.ts`

Expected: FAIL because `ServerOpsHostStore` does not exist.

- [ ] **Step 3: Write minimal implementation**

Store 构造时创建 `server-ops` 目录并通过 `readJsonFileSafe` 加载；写入统一使用 `writeJsonFileAtomic`。所有更新采用 copy-on-write，写盘成功后才替换内存状态，避免磁盘失败产生幽灵主机。

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/electron/src/main/lib/server-ops/server-ops-host-store.test.ts`

Expected: PASS.

### Task 3: IPC 注册与 Preload 桥接

**Files:**
- Create: `apps/electron/src/main/lib/server-ops/server-ops-ipc.ts`
- Test: `apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`

- [ ] **Step 1: Write the failing handler contract test**

```ts
test('注册 LIST、UPSERT、DELETE 三个主机资产 handler', async () => {
  registerServerOpsIpcHandlers(ipc, store)
  expect([...handlers.keys()]).toEqual([
    SERVER_OPS_IPC_CHANNELS.LIST_HOSTS,
    SERVER_OPS_IPC_CHANNELS.UPSERT_HOST,
    SERVER_OPS_IPC_CHANNELS.DELETE_HOST,
  ])
  expect(await handlers.get(SERVER_OPS_IPC_CHANNELS.LIST_HOSTS)?.()).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts`

Expected: FAIL because the IPC registrar does not exist.

- [ ] **Step 3: Implement the registrar and bridge**

主进程使用单例 `ServerOpsHostStore(getConfigDir())` 注册 handler；Preload 暴露：

```ts
listServerOpsHosts(): Promise<ServerOpsHost[]>
upsertServerOpsHost(input: ServerOpsUpsertHostInput): Promise<ServerOpsHost>
deleteServerOpsHost(hostId: string): Promise<boolean>
```

- [ ] **Step 4: Run the contract test and typecheck**

Run: `bun test apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts && bun run typecheck`

Expected: PASS with no TypeScript errors.

### Task 4: Jotai 状态与服务器抽屉

**Files:**
- Create: `apps/electron/src/renderer/atoms/server-ops-atoms.ts`
- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsHostDrawer.tsx`
- Test: `apps/electron/src/renderer/components/server-ops/ServerOpsHostDrawer.test.tsx`

- [ ] **Step 1: Write the failing UI tests**

```tsx
test('打开后高亮当前服务器，选择服务器并自动关闭', async () => {
  render(<ServerOpsHostDrawer open hosts={hosts} selectedHostId="host-1" onSelect={onSelect} onOpenChange={onOpenChange} />)
  expect(screen.getByRole('button', { name: /生产 API/ })).toHaveAttribute('aria-current', 'true')
  await user.click(screen.getByRole('button', { name: /测试 API/ }))
  expect(onSelect).toHaveBeenCalledWith('host-2')
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('Escape 和遮罩关闭抽屉', async () => {
  render(<ServerOpsHostDrawer open hosts={hosts} selectedHostId="host-1" onSelect={onSelect} onOpenChange={onOpenChange} />)
  await user.keyboard('{Escape}')
  expect(onOpenChange).toHaveBeenCalledWith(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/renderer/components/server-ops/ServerOpsHostDrawer.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement minimal state and drawer**

使用 Jotai 保存主机列表、当前主机、加载状态和错误；抽屉复用 Canvas sidebar 的 Pane 内绝对定位、240px 宽度、遮罩、选中高亮和行尾 DropdownMenu 交互。

- [ ] **Step 4: Run the focused test**

Run: `bun test apps/electron/src/renderer/components/server-ops/ServerOpsHostDrawer.test.tsx`

Expected: PASS.

### Task 5: 主机表单与运维工作区

**Files:**
- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsHostDialog.tsx`
- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx`
- Test: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`

- [ ] **Step 1: Write failing behavior tests**

```tsx
test('空状态可新增服务器并在保存后选中', async () => {
  listServerOpsHosts.mockResolvedValue([])
  upsertServerOpsHost.mockResolvedValue(host)
  render(<ServerOpsWorkspace />)
  await user.click(await screen.findByRole('button', { name: '添加服务器' }))
  await user.type(screen.getByLabelText('名称'), '生产 API')
  await user.type(screen.getByLabelText('主机地址'), '10.0.0.8')
  await user.click(screen.getByRole('button', { name: '保存服务器' }))
  expect(await screen.findByText('生产 API')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`

Expected: FAIL because the workspace does not exist.

- [ ] **Step 3: Implement the first usable workspace**

标题栏左侧使用 `PanelLeft` 打开服务器抽屉；主体展示当前服务器身份、连接状态占位、概览、终端、服务、日志、文件、Docker、数据服务和审计页签。未实现的远程页签显示明确空状态，不伪造实时指标；添加、编辑、删除使用真实 IPC，删除前使用 AlertDialog 确认。

- [ ] **Step 4: Run the workspace test**

Run: `bun test apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`

Expected: PASS.

### Task 6: 注册为 Agent 右侧工作区 Tab

**Files:**
- Modify: `apps/electron/src/renderer/atoms/agent-atoms.ts`
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.tsx`
- Test: `apps/electron/src/renderer/components/agent/SidePanel.server-ops.test.tsx`

- [ ] **Step 1: Write the failing integration test**

```tsx
test('从添加菜单打开运维后在右侧工作区注册可关闭标签', async () => {
  render(<SidePanel {...props} />)
  await user.click(screen.getByRole('button', { name: '添加工作区标签' }))
  await user.click(screen.getByRole('menuitem', { name: '服务器运维' }))
  expect(await screen.findByRole('tab', { name: '运维' })).toBeInTheDocument()
  expect(screen.getByTestId('server-ops-workspace')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/renderer/components/agent/SidePanel.server-ops.test.tsx`

Expected: FAIL because `server-ops` is not a registered workspace component.

- [ ] **Step 3: Implement the right-workspace registration**

将 `server-ops` 加入 `WorkspaceComponentTab` 白名单和添加菜单，在 `workspaceTabs` 中使用 `ServerCog` 图标，并在 `renderWorkspaceTabContent` 中按需渲染 `ServerOpsWorkspace`。关闭逻辑继续复用现有组件 Tab 生命周期，不改变 Canvas 动态 Tab 或 split 逻辑。

- [ ] **Step 4: Run focused regression tests**

Run: `bun test apps/electron/src/renderer/components/agent/SidePanel.server-ops.test.tsx apps/electron/src/renderer/components/agent/SidePanel.canvas.test.tsx`

Expected: PASS.

### Task 7: 完整验证和记忆回写

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: Run all focused tests**

Run: `bun test packages/shared/src/types/server-ops.test.ts apps/electron/src/main/lib/server-ops/server-ops-host-store.test.ts apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts apps/electron/src/renderer/components/server-ops/ServerOpsHostDrawer.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx apps/electron/src/renderer/components/agent/SidePanel.server-ops.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run typecheck and Electron build**

Run: `bun run typecheck && bun run electron:build`

Expected: both commands complete successfully.

- [ ] **Step 3: Review the diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only the planned server-ops files plus intentional integration points and existing user changes appear.

- [ ] **Step 4: Update project memory**

在 `MEMORY.md` 记录首个纵切的资产边界、持久化路径、无凭据合同和后续 SSH 阶段约束；不修改 README 或 release notes。

## Self-Review

- Spec coverage: 右侧工作区、Canvas 风格抽屉、主机 CRUD、四层 IPC、原子 JSON、安全边界和后续数据服务入口均有对应任务。
- Scope boundary: SSH/PTTY、systemd、Docker、PostgreSQL、MySQL、Redis 的真实连接留在后续独立计划；本阶段不伪造在线状态或指标。
- Placeholder scan: 计划不包含 TBD/TODO 或未定义接口。
- Type consistency: `ServerOpsHostInput` 用于创建字段，`ServerOpsUpsertHostInput` 增加可选 `id`，Preload 与 Store 返回统一 `ServerOpsHost`。
- User impact: 用户可在任何 Agent 会话右栏维护并选择同一份服务器清单，切换/关闭不会影响中间对话和 Canvas 数据。
- Performance impact: JSON 仅在 Store 初始化和 CRUD 时读写；Renderer 仅在打开运维 Tab 时加载，不新增轮询、后台 SSH 或数据库连接。
