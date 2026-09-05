# Server Ops 可观测性、systemd 与实时日志 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Server Ops 的概览、服务和日志占位页替换为真实 Linux SSH 数据，并形成有界、可审计、可取消的排障闭环。

**Architecture:** Renderer 只调用结构化 IPC；主进程的 Overview、Systemd、Log 三个领域服务复用唯一 `ServerOpsConnectionService` 和当前 connection generation。快照与服务读取复用有界 exec，实时日志通过 utility process 新增带 ACK 背压的独立 stream channel，服务变更升级现有审计 Store 到 schema v2。

**Tech Stack:** Bun、TypeScript、Electron IPC/utility process、React、Jotai、Radix/shadcn、Tailwind CSS、ssh2。

---

## 执行前约束

- 使用 `bun test --isolate`、`bun run typecheck` 和 `bun run electron:build`，不使用 npm 或 pnpm。
- 当前工作树包含上一阶段 Server Ops Agent 实现和用户已有 Canvas 修改。每次提交前必须运行 `git diff --cached --name-only`；不得暂存 `CanvasImageWorkbench.tsx`、`CanvasImageWorkbench.test.tsx`、`.omx/` 或 `.superpowers/`。
- 若同一文件包含进入本计划前的未提交变化，先用 `git diff -- <file>` 核对并保留它们。无法安全隔离时跳过该任务的 commit，不得用 checkout/reset/stash 覆盖用户状态。
- 所有新增方法和变量使用清晰中文注释；不使用 `any`；对象类型使用 `interface`；仅类型导入使用 `import type`。
- 所有 IPC 输入和返回值在 Shared、main、preload、Renderer 四层同步；utility 双向消息继续 exact-key fail closed。
- 不连接或修改真实服务器。远程验证只使用本地 loopback SSH fixture。

## 文件结构

### Shared 与持久化合同

- Modify: `packages/shared/src/types/server-ops.ts`：新增概览、systemd、日志、导出和审计 v2 DTO/parse 函数/IPC 常量。
- Modify: `packages/shared/src/types/server-ops.test.ts`：覆盖所有严格合同、非法 unit 和未知字段。
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-audit-store.ts`：迁移 schema v1 到 v2，并支持用户服务动作。
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-audit-store.test.ts`：覆盖迁移、服务动作、坏文件和筛选。
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-agent-facade.ts`：现有记录显式写入 `actor: 'agent'`。

### 主进程领域服务

- Create: `apps/electron/src/main/lib/server-ops/server-ops-overview-parser.ts`：解析固定行协议，不执行 I/O。
- Test: `apps/electron/src/main/lib/server-ops/server-ops-overview-parser.test.ts`。
- Create: `apps/electron/src/main/lib/server-ops/server-ops-overview-command.ts`：保存带显式版本号且不接收用户输入的固定采集命令。
- Test: `apps/electron/src/main/lib/server-ops/server-ops-overview-command.test.ts`。
- Create: `apps/electron/src/main/lib/server-ops/server-ops-overview-service.ts`：执行固定采集脚本、单飞和 stale generation 拒绝。
- Test: `apps/electron/src/main/lib/server-ops/server-ops-overview-service.test.ts`。
- Create: `apps/electron/src/main/lib/server-ops/server-ops-systemd-service.ts`：能力发现、列表、详情和五种固定动作。
- Test: `apps/electron/src/main/lib/server-ops/server-ops-systemd-service.test.ts`。
- Create: `apps/electron/src/main/lib/server-ops/server-ops-log-service.ts`：日志流身份、停止、ACK 和公开事件映射。
- Test: `apps/electron/src/main/lib/server-ops/server-ops-log-service.test.ts`。
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-connection-service.ts`：增加只供主进程使用的 active identity 和日志流窄接口。
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-service-context.ts`：注册三个新领域服务。

### utility runtime

- Modify: `apps/electron/src/utility/server-ops/server-ops-runtime-protocol.ts`：增加 log start/stop/ack/chunk/exit exact-key 合同。
- Modify: `apps/electron/src/utility/server-ops/server-ops-runtime-protocol.test.ts`。
- Modify: `apps/electron/src/utility/server-ops/server-ops-runtime-core.ts`：增加日志合批、ACK 与 UTF-8 增量解码状态。
- Modify: `apps/electron/src/utility/server-ops/server-ops-runtime-core.test.ts`。
- Modify: `apps/electron/src/utility/server-ops-runtime.ts`：管理独立 journal channel 和释放路径。
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-runtime-client.ts`：映射 runtime 日志流到主进程订阅。
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-runtime-client.test.ts`。
- Modify: `apps/electron/src/utility/server-ops/server-ops-ssh.integration.test.ts`：loopback fixture 覆盖日志 chunk/ACK/stop。

### IPC 与 Preload

- Modify: `apps/electron/src/main/lib/server-ops/server-ops-ipc.ts`：注册概览、服务、日志和导出 handler/event。
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts`。
- Modify: `apps/electron/src/main/ipc.ts`：创建并注入唯一领域服务及日志导出依赖。
- Create: `apps/electron/src/preload/server-ops-observability-preload.ts`：严格解析 main 返回值与事件。
- Test: `apps/electron/src/preload/server-ops-observability-preload.test.ts`。
- Modify: `apps/electron/src/preload/index.ts`：ElectronAPI 与 bridge 接线。

公共 IPC 与 utility runtime 使用不同命名空间，接线时按下表显式映射，禁止直接透传底层消息：

| 语义 | 公开 IPC / Preload | utility runtime |
| --- | --- | --- |
| 开始日志流 | `server-ops:start-log-stream` / `invokeServerOpsLogStart` | `server-ops.log-start` |
| 日志输出 | `server-ops:log-output` / `subscribeServerOpsLogOutput` | `server-ops.log-chunk` |
| 日志确认 | `server-ops:ack-log-output` / `invokeServerOpsLogAck` | `server-ops.log-ack` |
| 停止日志流 | `server-ops:stop-log-stream` / `invokeServerOpsLogStop` | `server-ops.log-stop` |
| 日志退出 | `server-ops:log-exit` / `subscribeServerOpsLogExit` | `server-ops.log-exit` |

### Renderer

- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsOverviewPanel.tsx`。
- Test: `apps/electron/src/renderer/components/server-ops/ServerOpsOverviewPanel.test.tsx`。
- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsServicesPanel.tsx`。
- Test: `apps/electron/src/renderer/components/server-ops/ServerOpsServicesPanel.test.tsx`。
- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsLogsPanel.tsx`。
- Test: `apps/electron/src/renderer/components/server-ops/ServerOpsLogsPanel.test.tsx`。
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx`：删除三个占位分支，只保留编排和生命周期 props。
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`：覆盖切页、切主机和断线释放。

## Task 1: Shared 概览、systemd、日志与审计 v2 合同

**Files:**
- Modify: `packages/shared/src/types/server-ops.ts`
- Modify: `packages/shared/src/types/server-ops.test.ts`

- [ ] **Step 1: 写失败的 Shared BDD 测试**

在 `packages/shared/src/types/server-ops.test.ts` 增加以下合同测试：

```ts
test('Given 合法概览快照 When preload 解析 Then 返回深拷贝且拒绝内部连接字段', () => {
  /** 主进程返回的最小合法概览。 */
  const input = {
    hostId: 'host-1',
    capturedAt: 1,
    sampleWindowMs: 250,
    system: { hostname: 'edge-1', osName: 'Ubuntu', osVersion: '24.04', kernel: '6.8.0', arch: 'x86_64', uptimeSeconds: 10 },
    cpu: { cores: 4, usagePercent: 12.5, load1: 0.1, load5: 0.2, load15: 0.3 },
    memory: { totalBytes: 1024, usedBytes: 512, availableBytes: 512, cacheBytes: 128 },
    swap: { totalBytes: 0, usedBytes: 0 },
    filesystems: [],
    network: { receiveBytesPerSecond: 10, transmitBytesPerSecond: 20 },
    processes: [],
    warnings: [],
  }
  expect(parseServerOpsOverviewResult(input)).toEqual(input)
  expect(() => parseServerOpsOverviewResult({ ...input, connectionId: 'secret' })).toThrow('SERVER_OPS_OVERVIEW_RESULT_INVALID')
})

test('Given systemd unit 含注入或非法转义 When 解析 Then fail closed', () => {
  for (const unitId of ['nginx.service;reboot', '../nginx.service', 'bad\\q.service', 'nginx.socket']) {
    expect(() => parseServerOpsServiceDetailInput({ hostId: 'host-1', unitId })).toThrow('SERVER_OPS_SYSTEMD_UNIT_INVALID')
  }
  expect(parseServerOpsServiceDetailInput({ hostId: 'host-1', unitId: String.raw`dbus-\\x2dapi.service` })).toEqual({
    hostId: 'host-1', unitId: String.raw`dbus-\\x2dapi.service`,
  })
})

test('Given 日志筛选、ACK 和导出内容 When 解析 Then 应用枚举与资源上限', () => {
  expect(parseServerOpsLogStartInput({
    hostId: 'host-1', source: { kind: 'unit', unitId: 'nginx.service' }, since: '1h', priority: 'warning', tailLines: 200,
  })).toMatchObject({ hostId: 'host-1', since: '1h', tailLines: 200 })
  expect(() => parseServerOpsLogStartInput({ hostId: 'host-1', source: { kind: 'system' }, since: 'forever', priority: 'debug', tailLines: 200 })).toThrow()
  expect(() => parseServerOpsLogExportInput({ hostId: 'host-1', content: 'x'.repeat(2_097_153) })).toThrow('SERVER_OPS_LOG_EXPORT_INPUT_INVALID')
})

test('Given Agent 与用户服务记录 When 校验审计 v2 Then actor 和 operation 必须匹配', () => {
  /** 合法用户服务动作记录。 */
  const serviceRecord: ServerOpsAuditRecord = {
    id: 'audit-1', timestamp: 1, sessionId: 'session-1', hostId: 'host-1', actor: 'user',
    operation: 'service-restart', unitId: 'nginx.service', phase: 'result', outcome: 'success', durationMs: 20,
  }
  expect(isServerOpsAuditRecord(serviceRecord)).toBe(true)
  expect(isServerOpsAuditRecord({ ...serviceRecord, command: 'systemctl restart nginx' })).toBe(false)
  expect(isServerOpsAuditRecord({ ...serviceRecord, actor: 'agent' })).toBe(false)
})
```

- [ ] **Step 2: 运行 Shared 测试并验证 RED**

Run:

```bash
bun test --isolate packages/shared/src/types/server-ops.test.ts
```

Expected: FAIL，缺少 observability 类型、parser、IPC channel 和审计 v2 字段。

- [ ] **Step 3: 实现 Shared 类型与严格 parser**

在 `server-ops.ts` 增加以下通道：

```ts
GET_OVERVIEW: 'server-ops:get-overview',
LIST_SERVICES: 'server-ops:list-services',
GET_SERVICE_DETAIL: 'server-ops:get-service-detail',
RUN_SERVICE_ACTION: 'server-ops:run-service-action',
START_LOG_STREAM: 'server-ops:start-log-stream',
STOP_LOG_STREAM: 'server-ops:stop-log-stream',
ACK_LOG_OUTPUT: 'server-ops:ack-log-output',
LOG_OUTPUT: 'server-ops:log-output',
LOG_EXIT: 'server-ops:log-exit',
EXPORT_LOG: 'server-ops:export-log',
```

新增并导出这些核心类型：

```ts
export type ServerOpsOverviewWarningCode =
  | 'SYSTEM_PARTIAL' | 'CPU_PARTIAL' | 'MEMORY_PARTIAL'
  | 'FILESYSTEM_PARTIAL' | 'NETWORK_PARTIAL' | 'PROCESS_PARTIAL' | 'OUTPUT_TRUNCATED'

export interface ServerOpsOverviewInput { hostId: string }
export interface ServerOpsOverviewSystem { hostname: string; osName: string; osVersion: string; kernel: string; arch: string; uptimeSeconds: number }
export interface ServerOpsOverviewCpu { cores: number; usagePercent: number; load1: number; load5: number; load15: number }
export interface ServerOpsOverviewMemory { totalBytes: number; usedBytes: number; availableBytes: number; cacheBytes: number }
export interface ServerOpsOverviewSwap { totalBytes: number; usedBytes: number }
export interface ServerOpsOverviewFilesystem { device: string; mountPoint: string; filesystem: string; totalBytes: number; usedBytes: number; availableBytes: number; usagePercent: number }
export interface ServerOpsOverviewNetwork { receiveBytesPerSecond: number; transmitBytesPerSecond: number }
export interface ServerOpsOverviewProcess { pid: number; name: string; cpuPercent: number; memoryPercent: number }
export interface ServerOpsOverviewResult {
  hostId: string
  capturedAt: number
  sampleWindowMs: number
  system?: ServerOpsOverviewSystem
  cpu?: ServerOpsOverviewCpu
  memory?: ServerOpsOverviewMemory
  swap?: ServerOpsOverviewSwap
  filesystems: ServerOpsOverviewFilesystem[]
  network?: ServerOpsOverviewNetwork
  processes: ServerOpsOverviewProcess[]
  warnings: ServerOpsOverviewWarningCode[]
}

export type ServerOpsSystemdCapability = 'available' | 'unsupported' | 'permission-denied'
export type ServerOpsServiceFilter = 'running' | 'failed' | 'stopped' | 'all'
export type ServerOpsServiceAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable'
export interface ServerOpsServiceSummary { unitId: string; description: string; loadState: string; activeState: string; subState: string; enabled: boolean | null; mainPid?: number; activeSince?: string }
export interface ServerOpsServiceListInput { hostId: string }
export interface ServerOpsServiceListResult { hostId: string; capability: ServerOpsSystemdCapability; services: ServerOpsServiceSummary[]; warnings: string[] }
export interface ServerOpsServiceDetailInput { hostId: string; unitId: string }
export interface ServerOpsServiceDetailResult { hostId: string; capability: ServerOpsSystemdCapability; service?: ServerOpsServiceSummary; statusLines: string[]; recentLogLines: string[]; warnings: string[] }
export interface ServerOpsServiceActionInput { sessionId: string; hostId: string; unitId: string; action: ServerOpsServiceAction }
export interface ServerOpsServiceActionResult { hostId: string; unitId: string; action: ServerOpsServiceAction; service?: ServerOpsServiceSummary; warnings: string[] }

export type ServerOpsLogSince = '15m' | '1h' | '6h' | '24h' | 'boot'
export type ServerOpsLogPriority = 'emerg' | 'alert' | 'crit' | 'err' | 'warning' | 'notice' | 'info' | 'debug'
export type ServerOpsLogSource = { kind: 'system' } | { kind: 'unit'; unitId: string }
export interface ServerOpsLogStartInput { hostId: string; source: ServerOpsLogSource; since: ServerOpsLogSince; priority: ServerOpsLogPriority; tailLines: number }
export interface ServerOpsLogStartResult { hostId: string; streamId: string }
export interface ServerOpsLogIdentity { hostId: string; streamId: string }
export interface ServerOpsLogOutputEvent extends ServerOpsLogIdentity { sequence: number; data: string }
export interface ServerOpsLogOutputAck extends ServerOpsLogIdentity { sequence: number }
export interface ServerOpsLogExitEvent extends ServerOpsLogIdentity { reason: 'stopped' | 'connection-closed' | 'remote-exit' | 'error'; errorCode?: string }
export interface ServerOpsLogExportInput { hostId: string; content: string }
export interface ServerOpsLogExportResult { saved: boolean }
```

把审计合同改为：

```ts
export type ServerOpsAuditActor = 'agent' | 'user'
export type ServerOpsAuditOperation =
  | 'connect' | 'exec' | 'disconnect'
  | 'service-start' | 'service-stop' | 'service-restart' | 'service-enable' | 'service-disable'
```

`ServerOpsAuditRecord` 和 append input 增加 `actor` 与可选 `unitId`。parser 强制 agent 只能使用原三种操作，user 只能使用 service 操作；service 操作必须有合法 unitId 且禁止 command/exitCode/signal，exec 才允许 command。

所有 result parser 必须：只接受 exact keys、限制数组数量和字符串长度、返回新对象/新数组、不返回 `connectionId` 或 generation。systemd unit parser 使用 256 字节上限，普通字符集 `[A-Za-z0-9:_.@-]`，反斜杠只接受 `\\x[0-9A-Fa-f]{2}`，并要求 `.service` 后缀。

- [ ] **Step 4: 运行 Shared 测试并验证 GREEN**

Run:

```bash
bun test --isolate packages/shared/src/types/server-ops.test.ts
```

Expected: PASS，测试输出无失败。

- [ ] **Step 5: 提交 Shared 合同**

```bash
git add packages/shared/src/types/server-ops.ts packages/shared/src/types/server-ops.test.ts
git diff --cached --name-only
git commit -m "功能：定义运维概览服务与日志合同"
```

## Task 2: 审计 schema v2 与用户服务动作

**Files:**
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-audit-store.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-audit-store.test.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-agent-facade.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-agent-facade.test.ts`

- [ ] **Step 1: 写 v1 迁移和 v2 语义失败测试**

```ts
test('Given 合法 v1 审计文件 When 加载 Then 原子迁移到 v2 并补 actor=agent', () => {
  writeFileSync(join(configDir, 'server-ops/audit.json'), JSON.stringify({ version: 1, records: [{
    id: 'audit-1', timestamp: 1, sessionId: 'session-1', hostId: 'host-1', operation: 'connect', phase: 'result', outcome: 'success',
  }] }))
  const store = new ServerOpsAuditStore(configDir, dependencies)
  expect(store.list().records[0]).toMatchObject({ actor: 'agent', operation: 'connect' })
  expect(JSON.parse(readFileSync(join(configDir, 'server-ops/audit.json'), 'utf8')).version).toBe(2)
})

test('Given 用户重启服务 When 追加开始和结果 Then 只持久化结构化 unit 与动作', () => {
  const store = new ServerOpsAuditStore(configDir, dependencies)
  store.append({ actor: 'user', sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', operation: 'service-restart', phase: 'start', outcome: 'success' })
  const result = store.append({ actor: 'user', sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', operation: 'service-restart', phase: 'result', outcome: 'success', durationMs: 20 })
  expect(result).not.toHaveProperty('command')
})
```

在 facade 测试中断言现有 connect/exec/disconnect append 均含 `actor: 'agent'`。审计视图的 actor 与服务动作标签集中到 Task 10，避免在领域迁移任务中交叉修改 Workspace。

- [ ] **Step 2: 运行审计测试并验证 RED**

```bash
bun test --isolate apps/electron/src/main/lib/server-ops/server-ops-audit-store.test.ts apps/electron/src/main/lib/server-ops/server-ops-agent-facade.test.ts apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx
```

Expected: FAIL，当前 Store 只接受 version 1 且记录没有 actor/unitId。

- [ ] **Step 3: 实现唯一已知迁移和 v2 写入**

把磁盘类型拆为 `ServerOpsAuditFileV1` 和 `ServerOpsAuditFileV2`：

```ts
interface ServerOpsAuditFileV1 { version: 1; records: ServerOpsAuditRecordV1[] }
interface ServerOpsAuditFileV2 { version: 2; records: ServerOpsAuditRecord[] }

/** 把已严格验证的 v1 Agent 记录升级为 v2。 */
function migrateAuditRecord(record: ServerOpsAuditRecordV1): ServerOpsAuditRecord {
  return { ...record, actor: 'agent' }
}
```

构造 Store 时先直接解析主文件版本：v2 走当前严格加载；v1 必须每条通过独立 legacy parser 后映射，并用 `writeJsonFileAtomic` 写 `{ version: 2, records }`。迁移写失败时 Store 进入 unavailable，不能继续远程动作。损坏文件、未知版本、主文件损坏但备份有效仍保持 fail closed。

append 固定写 version 2；list 增加 `actor` 筛选。扩充稳定错误码只允许本阶段定义的 systemd/audit code。

在 facade 的所有 append 输入加入 `actor: 'agent'`。本任务不修改 Renderer；Task 10 再让审计 UI 为 user service 记录显示服务名和动作，不显示命令占位。

- [ ] **Step 4: 运行审计测试并验证 GREEN**

```bash
bun test --isolate packages/shared/src/types/server-ops.test.ts apps/electron/src/main/lib/server-ops/server-ops-audit-store.test.ts apps/electron/src/main/lib/server-ops/server-ops-agent-facade.test.ts
```

Expected: PASS，v1 fixture 已被原子升级且现有 Agent 审计行为不回退。

- [ ] **Step 5: 提交审计升级**

```bash
git add apps/electron/src/main/lib/server-ops/server-ops-audit-store.ts apps/electron/src/main/lib/server-ops/server-ops-audit-store.test.ts apps/electron/src/main/lib/server-ops/server-ops-agent-facade.ts apps/electron/src/main/lib/server-ops/server-ops-agent-facade.test.ts
git diff --cached --name-only
git commit -m "功能：升级服务器操作审计合同"
```

## Task 3: 版本化固定采集命令与概览行协议解析器

**Files:**
- Create: `apps/electron/src/main/lib/server-ops/server-ops-overview-command.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-overview-command.test.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-overview-parser.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-overview-parser.test.ts`

- [ ] **Step 1: 写 Ubuntu、CentOS 与 partial fixture 失败测试**

```ts
test('Given 固定采集命令 When 检查合同 Then 版本明确且不含插值入口', () => {
  expect(SERVER_OPS_OVERVIEW_COMMAND_VERSION).toBe(1)
  expect(SERVER_OPS_OVERVIEW_COMMAND).toContain('LC_ALL=C')
  expect(SERVER_OPS_OVERVIEW_COMMAND).not.toContain('${')
})

test('Given 完整 Linux 行协议 When 解析 Then 生成有界概览快照', () => {
  /** 固定采集脚本返回的行协议。 */
  const output = [
    'system\thostname\tedge-1', 'system\tosName\tUbuntu', 'system\tosVersion\t24.04',
    'system\tkernel\t6.8.0', 'system\tarch\tx86_64', 'system\tuptimeSeconds\t3600',
    'cpu\tcores\t4', 'cpu\tusagePercent\t12.5', 'cpu\tload\t0.1\t0.2\t0.3',
    'memory\t1024\t512\t512\t128', 'swap\t0\t0',
    'filesystem\t/dev/vda1\text4\t/\t1024\t512\t512\t50',
    'network\t1000\t2000', 'process\t1\tsystemd\t0.1\t0.2',
  ].join('\n')
  expect(parseServerOpsOverviewOutput('host-1', output, 1)).toMatchObject({ hostId: 'host-1', sampleWindowMs: 250, warnings: [] })
})

test('Given 单项损坏或超过上限 When 解析 Then 保留有效项并返回 warning', () => {
  const result = parseServerOpsOverviewOutput('host-1', 'system\thostname\tedge-1\nmemory\tbad\nunknown\tsecret', 1)
  expect(result.system?.hostname).toBe('edge-1')
  expect(result.memory).toBeUndefined()
  expect(result.warnings).toContain('MEMORY_PARTIAL')
})
```

- [ ] **Step 2: 运行解析器测试并验证 RED**

```bash
bun test --isolate apps/electron/src/main/lib/server-ops/server-ops-overview-parser.test.ts
```

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现版本化固定命令与纯解析器**

`server-ops-overview-command.ts` 导出 `SERVER_OPS_OVERVIEW_COMMAND_VERSION = 1` 与 `SERVER_OPS_OVERVIEW_COMMAND`。命令由仓库常量完整定义，设置 `LC_ALL=C`，读取 `/etc/os-release`、`/proc/stat`、`/proc/loadavg`、`/proc/meminfo`、`/proc/net/dev`、`df -PkT`、`ps`；两次 CPU/网络计数间隔 250ms。命令不得接收参数或拼接外部字符串。命令测试固定版本号、关键数据源、采样窗口和无模板插值入口，后续修改行协议时必须同步递增版本。

行协议 grammar 固定为 tab 分隔：`system\t<field>\t<value>`、`cpu\tcores\t<number>`、`cpu\tusagePercent\t<number>`、`cpu\tload\t<load1>\t<load5>\t<load15>`、`memory\t<total>\t<used>\t<available>\t<cache>`、`swap\t<total>\t<used>`、`filesystem\t<device>\t<filesystem>\t<mountPoint>\t<total>\t<used>\t<available>\t<usagePercent>`、`network\t<receivePerSecond>\t<transmitPerSecond>`、`process\t<pid>\t<name>\t<cpuPercent>\t<memoryPercent>`。脚本输出文本字段时必须移除 tab、CR 和 LF，解析器拒绝字段数不匹配的记录并添加对应 warning。

导出纯函数：

```ts
/** 把固定采集行协议解析为 Renderer 可见的有界快照。 */
export function parseServerOpsOverviewOutput(hostId: string, stdout: string, capturedAt: number): ServerOpsOverviewResult {
  /** 当前快照的结构化警告，使用 Set 防止同一分类重复。 */
  const warnings = new Set<ServerOpsOverviewWarningCode>()
  /** 逐行解析后的文件系统，最多保留 128 项。 */
  const filesystems: ServerOpsOverviewFilesystem[] = []
  /** 逐行解析后的进程，最多保留 10 项。 */
  const processes: ServerOpsOverviewProcess[] = []
  // 每个已知 record 使用独立严格分支；未知/重复/越界字段只产生对应 warning。
  return { hostId, capturedAt, sampleWindowMs: 250, filesystems, processes, warnings: [...warnings] }
}
```

实现中不得 `split(' ')` 解析可含空格的文本；只按第一个 record tag 和 tab 字段位置读取。字符串分别限制为 hostname 255、系统字段 256、挂载点 1024、进程名称 256。总 stdout 超过 512 KiB 时拒绝为 `SERVER_OPS_OVERVIEW_OUTPUT_INVALID`。

- [ ] **Step 4: 运行解析器测试并验证 GREEN**

```bash
bun test --isolate apps/electron/src/main/lib/server-ops/server-ops-overview-command.test.ts apps/electron/src/main/lib/server-ops/server-ops-overview-parser.test.ts packages/shared/src/types/server-ops.test.ts
```

Expected: PASS，完整、partial 和越界 fixture 全部通过。

- [ ] **Step 5: 提交概览解析器**

```bash
git add apps/electron/src/main/lib/server-ops/server-ops-overview-command.ts apps/electron/src/main/lib/server-ops/server-ops-overview-command.test.ts apps/electron/src/main/lib/server-ops/server-ops-overview-parser.ts apps/electron/src/main/lib/server-ops/server-ops-overview-parser.test.ts
git diff --cached --name-only
git commit -m "功能：解析服务器概览采集数据"
```

## Task 4: Active connection identity 与 Overview Service

**Files:**
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-connection-service.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-connection-service.test.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-overview-service.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-overview-service.test.ts`

- [ ] **Step 1: 写 active identity、单飞和 stale 失败测试**

```ts
test('Given 当前连接 When 读取内部 identity Then 返回 host、connection 与 generation 副本', async () => {
  await connectSuccessfully(service)
  expect(service.getActiveIdentity('host-1')).toEqual({ hostId: 'host-1', connectionId: 'connection-1', generation: 1 })
})

test('Given 同一连接两个概览请求 When 第一个仍在途 Then Overview Service 复用同一 Promise', async () => {
  const first = overviewService.getOverview({ hostId: 'host-1' })
  const second = overviewService.getOverview({ hostId: 'host-1' })
  expect(execCalls).toHaveLength(1)
  resolveExec({ stdout: validOutput, stderr: '', exitCode: 0, truncated: false })
  expect(await first).toEqual(await second)
})

test('Given 概览执行期间连接 generation 变化 When 旧结果返回 Then 拒绝发布旧数据', async () => {
  const pending = overviewService.getOverview({ hostId: 'host-1' })
  reconnectHost()
  resolveExec({ stdout: validOutput, stderr: '', exitCode: 0, truncated: false })
  await expect(pending).rejects.toThrow('SERVER_OPS_CONNECTION_CHANGED')
})
```

- [ ] **Step 2: 运行测试并验证 RED**

```bash
bun test --isolate apps/electron/src/main/lib/server-ops/server-ops-connection-service.test.ts apps/electron/src/main/lib/server-ops/server-ops-overview-service.test.ts
```

Expected: FAIL，缺少 active identity 和 Overview Service。

- [ ] **Step 3: 实现内部 identity 与单飞 Overview Service**

在 Connection Service 增加：

```ts
export interface ServerOpsActiveConnectionIdentity { hostId: string; connectionId: string; generation: number }

/** 返回当前主机仅供主进程服务使用的活跃连接身份。 */
getActiveIdentity(hostId: string): ServerOpsActiveConnectionIdentity {
  /** 当前主机生命周期必须同时存在 active ID。 */
  const lifecycle = this.lifecycles.get(hostId)
  if (!lifecycle?.activeConnectionId) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
  return { hostId, connectionId: lifecycle.activeConnectionId, generation: lifecycle.generation }
}
```

Overview Service 使用 `Map<string, { identity; promise }>` 单飞：

```ts
/** 通过当前唯一连接执行固定概览采集。 */
async getOverview(input: ServerOpsOverviewInput): Promise<ServerOpsOverviewResult> {
  /** 请求开始时捕获的权威连接身份。 */
  const identity = this.dependencies.connections.getActiveIdentity(input.hostId)
  /** 同一 identity 已有采集时直接复用。 */
  const current = this.pending.get(input.hostId)
  if (current && sameIdentity(current.identity, identity)) return current.promise
  /** 本次固定采集 Promise。 */
  const promise = this.collect(identity)
  this.pending.set(input.hostId, { identity, promise })
  return promise.finally(() => {
    if (this.pending.get(input.hostId)?.promise === promise) this.pending.delete(input.hostId)
  })
}
```

`collect()` 使用 10 秒 timeout 调用 connections.exec，要求 `exitCode === 0`、`truncated === false` 且 stderr 为空或只含已知无害 warning；解析前后都比较 active identity。任何底层 message 不直接返回 Renderer，映射稳定 code。

- [ ] **Step 4: 运行测试并验证 GREEN**

```bash
bun test --isolate apps/electron/src/main/lib/server-ops/server-ops-connection-service.test.ts apps/electron/src/main/lib/server-ops/server-ops-overview-parser.test.ts apps/electron/src/main/lib/server-ops/server-ops-overview-service.test.ts
```

Expected: PASS，旧 generation 结果无状态副作用。

- [ ] **Step 5: 提交 Overview Service**

```bash
git add apps/electron/src/main/lib/server-ops/server-ops-connection-service.ts apps/electron/src/main/lib/server-ops/server-ops-connection-service.test.ts apps/electron/src/main/lib/server-ops/server-ops-overview-service.ts apps/electron/src/main/lib/server-ops/server-ops-overview-service.test.ts
git diff --cached --name-only
git commit -m "功能：采集当前服务器真实概览"
```

## Task 5: Systemd Service 读取与受控动作

**Files:**
- Create: `apps/electron/src/main/lib/server-ops/server-ops-systemd-service.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-systemd-service.test.ts`

- [ ] **Step 1: 写能力、列表、详情、动作和注入失败测试**

```ts
test('Given PID 1 不是 systemd When 列服务 Then 返回 unsupported 且不猜测进程', async () => {
  execResults.push(result('init\n'))
  expect(await service.list({ hostId: 'host-1' })).toEqual({ hostId: 'host-1', capability: 'unsupported', services: [], warnings: [] })
})

test('Given systemd 列表 When 解析 Then 一次读取最多 1000 个服务', async () => {
  execResults.push(result('systemd\n'), result('nginx.service loaded active running NGINX\nredis.service loaded failed failed Redis'))
  const output = await service.list({ hostId: 'host-1' })
  expect(output.services).toHaveLength(2)
  expect(output.services[0]).toMatchObject({ unitId: 'nginx.service', activeState: 'active', subState: 'running' })
})

test('Given 用户确认重启 When 执行动作 Then 写 start/result 审计并回读真实详情', async () => {
  const output = await service.runAction({ sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart' })
  expect(execCommands[0]).toBe("LC_ALL=C systemctl restart -- 'nginx.service'")
  expect(auditInputs).toMatchObject([
    { actor: 'user', operation: 'service-restart', phase: 'start', unitId: 'nginx.service' },
    { actor: 'user', operation: 'service-restart', phase: 'result', outcome: 'success', unitId: 'nginx.service' },
  ])
  expect(output.service?.activeState).toBe('active')
})

test('Given 动作执行后连接变化 When 返回 Then 标记结果未知且不自动重试', async () => {
  await expect(runWithGenerationChange()).rejects.toThrow('SERVER_OPS_SERVICE_ACTION_UNKNOWN')
  expect(execCommands.filter((command) => command.includes(' restart '))).toHaveLength(1)
})
```

- [ ] **Step 2: 运行 Systemd 测试并验证 RED**

```bash
bun test --isolate apps/electron/src/main/lib/server-ops/server-ops-systemd-service.test.ts
```

Expected: FAIL，Systemd Service 尚不存在。

- [ ] **Step 3: 实现固定命令映射和解析**

领域服务依赖只暴露 `getActiveIdentity`、`exec`、`audit.append`、`now`。能力检测使用固定命令读取 `/proc/1/comm` 和 `command -v systemctl`。

列表只运行一次 `systemctl list-units --type=service --all --no-legend --no-pager --plain`。详情使用 `systemctl show --no-pager --property=Id,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestamp -- '<unit>'`，并用独立有界 exec 读取最近 100 行 journal。

服务动作映射：

```ts
const SERVICE_ACTION_COMMAND = {
  start: 'start', stop: 'stop', restart: 'restart', enable: 'enable', disable: 'disable',
} as const satisfies Record<ServerOpsServiceAction, string>

/** 用 POSIX 单引号把已验证参数编码为一个 Shell word。 */
function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
```

即使 Shared 已解析，main 方法入口再次调用 parser。动作 start 审计失败时零 exec；远程动作完成后 result 审计失败时返回 `warnings: ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED']`。动作失败不自动重试，finally 中回读只用于展示，不改变原动作 outcome。

- [ ] **Step 4: 运行 Systemd 与审计测试并验证 GREEN**

```bash
bun test --isolate apps/electron/src/main/lib/server-ops/server-ops-systemd-service.test.ts apps/electron/src/main/lib/server-ops/server-ops-audit-store.test.ts packages/shared/src/types/server-ops.test.ts
```

Expected: PASS，所有动作只生成固定模板且注入输入零 exec。

- [ ] **Step 5: 提交 Systemd Service**

```bash
git add apps/electron/src/main/lib/server-ops/server-ops-systemd-service.ts apps/electron/src/main/lib/server-ops/server-ops-systemd-service.test.ts
git diff --cached --name-only
git commit -m "功能：支持 systemd 服务读取与受控操作"
```

## Task 6: utility 日志流协议与背压核心

**Files:**
- Modify: `apps/electron/src/utility/server-ops/server-ops-runtime-protocol.ts`
- Modify: `apps/electron/src/utility/server-ops/server-ops-runtime-protocol.test.ts`
- Modify: `apps/electron/src/utility/server-ops/server-ops-runtime-core.ts`
- Modify: `apps/electron/src/utility/server-ops/server-ops-runtime-core.test.ts`
- Modify: `apps/electron/src/utility/server-ops-runtime.ts`

- [ ] **Step 1: 写 exact-key、UTF-8 和 ACK 失败测试**

```ts
test('Given 合法日志 start/stop/ack When 解析 Then 重建精确请求', () => {
  expect(parseServerOpsRuntimeRequest({ type: 'server-ops.log-start', input: {
    streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', command: 'journalctl -f',
  } })).toMatchObject({ type: 'server-ops.log-start' })
  expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.log-stop', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', extra: true })).toThrow('SERVER_OPS_RUNTIME_REQUEST_INVALID')
})

test('Given 中文字符跨 Buffer When 增量解码 Then 输出不含替换字符', () => {
  const state = createRuntimeLogOutputState()
  appendRuntimeLogOutput(state, Buffer.from([0xe6, 0x9c]))
  appendRuntimeLogOutput(state, Buffer.from([0x8d, 0xe5, 0x8a, 0xa1, 0x0a]))
  expect(takeRuntimeLogOutput(state, identity)?.data).toBe('服务\n')
})

test('Given 前一批未 ACK When 新日志到达 Then 只保留一个有界 pending 批次', () => {
  const state = createRuntimeLogOutputState()
  appendRuntimeLogOutput(state, 'a'.repeat(40_000))
  const first = takeRuntimeLogOutput(state, identity)
  appendRuntimeLogOutput(state, 'b'.repeat(80_000))
  expect(takeRuntimeLogOutput(state, identity)).toBeUndefined()
  acknowledgeRuntimeLogOutput(state, first!.sequence)
  expect(takeRuntimeLogOutput(state, identity)!.data.length).toBeLessThanOrEqual(32_768)
})
```

- [ ] **Step 2: 运行 utility 测试并验证 RED**

```bash
bun test --isolate apps/electron/src/utility/server-ops/server-ops-runtime-protocol.test.ts apps/electron/src/utility/server-ops/server-ops-runtime-core.test.ts
```

Expected: FAIL，缺少 log protocol 和 core state。

- [ ] **Step 3: 实现日志 runtime union 和输出状态**

新增内部请求/消息：

```ts
export interface ServerOpsRuntimeLogStartRequest { streamId: string; hostId: string; connectionId: string; command: string }
export type ServerOpsRuntimeRequest = ExistingRequest
  | { type: 'server-ops.log-start'; input: ServerOpsRuntimeLogStartRequest }
  | { type: 'server-ops.log-stop'; streamId: string; hostId: string; connectionId: string }
  | { type: 'server-ops.log-ack'; streamId: string; hostId: string; connectionId: string; sequence: number }
export type ServerOpsRuntimeMessage = ExistingMessage
  | { type: 'server-ops.log-started'; streamId: string; hostId: string; connectionId: string }
  | { type: 'server-ops.log-chunk'; streamId: string; hostId: string; connectionId: string; sequence: number; data: string }
  | { type: 'server-ops.log-exit'; streamId: string; hostId: string; connectionId: string; reason: 'stopped' | 'connection-closed' | 'remote-exit' | 'error'; errorCode?: string }
```

command 只在 main -> utility 内部协议出现，限制 8192 字符且拒绝 NUL。chunk 最大 32 KiB。exact parser 对每个 union 分支声明完整 key set。

Core 使用 `StringDecoder('utf8')`，状态最多保留 inFlight 32 KiB 和 pending 32 KiB；额外内容增加 droppedBytes 并在下一批用固定本地标记提示，不保存原文。

在 runtime 的 `ManagedSshConnection` 增加 `logStreams: Map<string, ManagedLogStream>`。`log-start` 调用 `client.exec()` 建立独立 channel；50ms 或 32 KiB flush；ACK 后发送下一批。stop、SSH close、disconnect、shutdown 都关闭 channel、timer、decoder 并发送一次终态。

- [ ] **Step 4: 运行 utility 测试并验证 GREEN**

```bash
bun test --isolate apps/electron/src/utility/server-ops/server-ops-runtime-protocol.test.ts apps/electron/src/utility/server-ops/server-ops-runtime-core.test.ts
```

Expected: PASS，非法消息零状态副作用，未 ACK 时内存保持有界。

- [ ] **Step 5: 提交 utility 日志协议**

```bash
git add apps/electron/src/utility/server-ops/server-ops-runtime-protocol.ts apps/electron/src/utility/server-ops/server-ops-runtime-protocol.test.ts apps/electron/src/utility/server-ops/server-ops-runtime-core.ts apps/electron/src/utility/server-ops/server-ops-runtime-core.test.ts apps/electron/src/utility/server-ops-runtime.ts
git diff --cached --name-only
git commit -m "功能：增加有界 SSH 实时日志流"
```

## Task 7: Runtime Client、Connection Service 与 Log Service

**Files:**
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-runtime-client.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-runtime-client.test.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-connection-service.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-connection-service.test.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-log-service.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-log-service.test.ts`
- Modify: `apps/electron/src/utility/server-ops/server-ops-ssh.integration.test.ts`

- [ ] **Step 1: 写日志身份、stale、stop 和 fixture 失败测试**

```ts
test('Given 当前连接 When 开始日志 Then started 后才返回 streamId', async () => {
  const pending = client.startLog('host-1', 'connection-1', 'stream-1', 'journalctl -f')
  emit({ type: 'server-ops.log-started', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-1' })
  await expect(pending).resolves.toBeUndefined()
})

test('Given stale stream chunk When 新连接已接管 Then 不通知订阅者且不 ACK', () => {
  reconnectAs('connection-2')
  emit({ type: 'server-ops.log-chunk', hostId: 'host-1', connectionId: 'connection-1', streamId: 'stream-old', sequence: 1, data: 'old' })
  expect(events).toEqual([])
})

test('Given 日志来源切换 When 启动新流 Then 先停止旧流且公开事件不含 connectionId', async () => {
  const first = await service.start(systemInput)
  const second = await service.start(unitInput)
  expect(runtimeStops).toContainEqual(expect.objectContaining({ streamId: first.streamId }))
  expect(second).not.toHaveProperty('connectionId')
})
```

扩展 loopback SSH fixture：服务端 exec 遇到 journal command 时分两批写入含中文的日志；测试 ACK 后收到第二批，stop 后 channel 关闭且没有第三批。

- [ ] **Step 2: 运行相关测试并验证 RED**

```bash
bun test --isolate apps/electron/src/main/lib/server-ops/server-ops-runtime-client.test.ts apps/electron/src/main/lib/server-ops/server-ops-connection-service.test.ts apps/electron/src/main/lib/server-ops/server-ops-log-service.test.ts
```

Expected: FAIL，client/service 尚未暴露日志流。

- [ ] **Step 3: 实现 Runtime Client 和 Connection Service 窄接口**

Runtime Client 增加 pending start、active stream 和 listener Map：

```ts
startLog(hostId: string, connectionId: string, streamId: string, command: string): Promise<void>
stopLog(hostId: string, connectionId: string, streamId: string): void
acknowledgeLog(hostId: string, connectionId: string, streamId: string, sequence: number): void
onLogOutput(listener: (event: ServerOpsRuntimeLogChunk) => void): () => void
onLogExit(listener: (event: ServerOpsRuntimeLogExit) => void): () => void
```

disconnect、terminal exit、runtime failure 和 stop 必须 reject pending start，并为每条 active stream 发一次 exit 后清空。handleMessage 在通知前校验 active connection 和 stream 三重身份。

Connection Service 使用 `getActiveIdentity()` 二次校验，把 runtime log 接口收窄给 Log Service；不把 connectionId 广播给 Renderer。

- [ ] **Step 4: 实现结构化 journal command 与 Log Service**

Log Service 构造命令时只映射枚举：

```ts
const SINCE_ARGUMENT = { '15m': '-15 minutes', '1h': '-1 hour', '6h': '-6 hours', '24h': '-24 hours', boot: undefined } as const

/** 从严格日志筛选生成固定 journalctl 命令。 */
function buildJournalCommand(input: ServerOpsLogStartInput): string {
  /** 所有片段均来自枚举或已验证并安全引用的 unit。 */
  const parts = ['LC_ALL=C', 'journalctl', '--no-pager', '--output=short-iso-precise', `--priority=${input.priority}`, `--lines=${input.tailLines}`, '--follow']
  if (input.since === 'boot') parts.push('--boot')
  else parts.push(`--since=${quoteShellWord(SINCE_ARGUMENT[input.since])}`)
  if (input.source.kind === 'unit') parts.push('--unit', quoteShellWord(input.source.unitId))
  return parts.join(' ')
}
```

Log Service 以主进程内部 `ownerKey`（由 IPC 层从授权主窗口推导，绝不来自 Renderer DTO）维护 `Map<ownerKey, active stream>`。同一 owner 只保留一个 active stream，不同主窗口互不停止。`start(ownerKey, input)` 先停止同 owner 旧流，捕获 active identity，等待 runtime started 后再返回公开 `{ hostId, streamId }`；`acknowledge(ownerKey, ack)`、`stop(ownerKey, identity)` 和 `disposeOwner(ownerKey)` 只能作用于同 owner 当前流。output/exit 只映射到对应 owner 的 Shared DTO；连接变化时停止且返回 `connection-closed`。

- [ ] **Step 5: 运行单元与 SSH fixture 并验证 GREEN**

```bash
bun test --isolate apps/electron/src/main/lib/server-ops/server-ops-runtime-client.test.ts apps/electron/src/main/lib/server-ops/server-ops-connection-service.test.ts apps/electron/src/main/lib/server-ops/server-ops-log-service.test.ts
bun test --isolate apps/electron/src/utility/server-ops/server-ops-ssh.integration.test.ts
```

Expected: 全部 PASS；第二条命令只监听本机随机回环端口。

- [ ] **Step 6: 提交日志服务**

```bash
git add apps/electron/src/main/lib/server-ops/server-ops-runtime-client.ts apps/electron/src/main/lib/server-ops/server-ops-runtime-client.test.ts apps/electron/src/main/lib/server-ops/server-ops-connection-service.ts apps/electron/src/main/lib/server-ops/server-ops-connection-service.test.ts apps/electron/src/main/lib/server-ops/server-ops-log-service.ts apps/electron/src/main/lib/server-ops/server-ops-log-service.test.ts apps/electron/src/utility/server-ops/server-ops-ssh.integration.test.ts
git diff --cached --name-only
git commit -m "功能：接入服务器实时日志生命周期"
```

## Task 8: IPC、Preload、Service Context 与日志导出

**Files:**
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-service-context.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-service-context.test.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-ipc.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Create: `apps/electron/src/preload/server-ops-observability-preload.ts`
- Create: `apps/electron/src/preload/server-ops-observability-preload.test.ts`
- Modify: `apps/electron/src/preload/index.ts`

- [ ] **Step 1: 写四层合同与安全边界失败测试**

```ts
test('Given 非主窗口或污染输入 When 调用新 IPC Then 领域服务零调用', async () => {
  await expect(call(GET_OVERVIEW, unauthorizedEvent, { hostId: 'host-1' })).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
  await expect(call(RUN_SERVICE_ACTION, mainEvent, { sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service;reboot', action: 'restart' })).rejects.toThrow()
  expect(overviewCalls).toBe(0)
  expect(actionCalls).toBe(0)
})

test('Given main 返回 connectionId When preload 获取概览 Then fail closed', async () => {
  const invoke = async (): Promise<unknown> => ({ ...validOverview, connectionId: 'secret' })
  await expect(invokeServerOpsOverview(invoke, { hostId: 'host-1' })).rejects.toThrow('SERVER_OPS_OVERVIEW_RESULT_INVALID')
})

test('Given 日志事件身份匹配 When preload 订阅 Then 解析后转发并可清理监听', () => {
  const dispose = subscribeServerOpsLogOutput(on, off, callback)
  emit({ hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: 'line\n' })
  expect(callback).toHaveBeenCalledWith({ hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: 'line\n' })
  dispose()
  expect(off).toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行 IPC/Preload 测试并验证 RED**

```bash
bun test --isolate apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts apps/electron/src/main/lib/server-ops/server-ops-service-context.test.ts apps/electron/src/preload/server-ops-observability-preload.test.ts
```

Expected: FAIL，通道、依赖和 preload helper 尚不存在。

- [ ] **Step 3: 扩展唯一 Service Context 和 IPC handlers**

`ServerOpsServiceContext` 增加 `overview`、`systemd`、`logs`。`main/ipc.ts` 在连接服务和审计 Store 后创建唯一实例，并注入 `registerServerOpsIpcHandlers`。

IPC handlers 顺序固定为：assertAuthorizedSender -> Shared parse input -> 领域调用 -> Shared parse result。服务动作额外调用 `requireOrdinaryTopLevelAgentSession(options.requireUserVisibleSession(sessionId))`，但该校验只证明审计归属是普通用户可见 Agent 会话；不得读取 `ServerOpsAgentAccessStore` 或要求 Agent 临时授权，UI 操作仍由主窗口 sender allowlist 与逐次确认独立授权。

IPC 从 `BrowserWindow.fromWebContents(event.sender)?.id` 推导内部 `ownerKey`，Renderer 不得提交 owner/window ID。日志 output/exit 只发送给对应且仍存活的主窗口；窗口销毁时调用 `logs.disposeOwner(ownerKey)`。IPC registration dispose 先取消领域订阅并释放全部 owner 流，再 remove handlers。

日志导出依赖由 `main/ipc.ts` 注入：使用当前主窗口作为 `dialog.showSaveDialog` owner，默认文件名由公开 host name 和当前时间生成；只写用户选择的明确文件路径，使用 `writeTextFileAtomic`，取消返回 `{ saved: false }`。handler 不接受 Renderer 提供路径或文件名。

- [ ] **Step 4: 实现严格 Preload helper 与 ElectronAPI**

`server-ops-observability-preload.ts` 导出：

```ts
invokeServerOpsOverview
invokeServerOpsServiceList
invokeServerOpsServiceDetail
invokeServerOpsServiceAction
invokeServerOpsLogStart
invokeServerOpsLogStop
invokeServerOpsLogAck
invokeServerOpsLogExport
subscribeServerOpsLogOutput
subscribeServerOpsLogExit
```

每个 invoke result 和 event payload 都先调用 Shared parser。`preload/index.ts` 的 `ElectronAPI` 和 `electronAPI` 对象只委托这些 helper，不直接把 unknown main 数据交给 Renderer。

- [ ] **Step 5: 运行四层测试并验证 GREEN**

```bash
bun test --isolate packages/shared/src/types/server-ops.test.ts apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts apps/electron/src/main/lib/server-ops/server-ops-service-context.test.ts apps/electron/src/preload/server-ops-observability-preload.test.ts
```

Expected: PASS，非主窗口、未知字段和内部 identity 均 fail closed。

- [ ] **Step 6: 提交四层接线**

```bash
git add apps/electron/src/main/lib/server-ops/server-ops-service-context.ts apps/electron/src/main/lib/server-ops/server-ops-service-context.test.ts apps/electron/src/main/lib/server-ops/server-ops-ipc.ts apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/server-ops-observability-preload.ts apps/electron/src/preload/server-ops-observability-preload.test.ts apps/electron/src/preload/index.ts
git diff --cached --name-only
git commit -m "功能：接入运维观测四层通信合同"
```

## Task 9: Renderer 真实概览面板

**Files:**
- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsOverviewPanel.tsx`
- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsOverviewPanel.test.tsx`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`

- [ ] **Step 1: 写视图、10 秒刷新和 stale 失败测试**

```tsx
test('Given 已连接概览 When 渲染 Then 显示真实指标、文件系统与进程', () => {
  const html = renderToStaticMarkup(<ServerOpsOverviewPanelView status="ready" snapshot={snapshot} stale={false} onRefresh={() => undefined} />)
  expect(html).toContain('12.5%')
  expect(html).toContain('/dev/vda1')
  expect(html).toContain('systemd')
  expect(html).not.toContain('下一阶段')
})

test('Given 面板激活 When 10 秒经过 Then 单飞刷新；停用后不再请求', async () => {
  controller.activate('host-1')
  await flushPromises()
  expect(reads).toBe(1)
  clock.advance(10_000)
  await flushPromises()
  expect(reads).toBe(2)
  controller.deactivate()
  clock.advance(20_000)
  expect(reads).toBe(2)
})

test('Given 旧主机请求迟到 When 当前主机已切换 Then 不覆盖当前投影', async () => {
  const oldRequest = controller.activate('host-1')
  controller.activate('host-2')
  old.resolve(host1Snapshot)
  await oldRequest
  expect(projections.at(-1)?.hostId).toBe('host-2')
})
```

- [ ] **Step 2: 运行 Renderer 概览测试并验证 RED**

```bash
bun test --isolate apps/electron/src/renderer/components/server-ops/ServerOpsOverviewPanel.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx
```

Expected: FAIL，真实面板尚不存在。

- [ ] **Step 3: 实现 Overview Controller 和 View**

面板公开 props：

```ts
export interface ServerOpsOverviewPanelProps { hostId: string; active: boolean; connected: boolean }
```

内部 controller 投影含 `hostId`、`status: 'idle'|'loading'|'ready'|'error'`、snapshot、stale、error、requestRevision。激活且 connected 才启动定时器；请求失败时保留最近成功 snapshot 并设 stale；手动刷新在 in-flight 时只设置 `refreshQueued`。

View 使用现有主题变量和组件：顶部四个紧凑指标单元，中部系统/文件系统，底部进程表。无嵌套卡片；loading 使用稳定尺寸 Skeleton；partial warning 在对应区块显示；窄面板两列指标且表格可横向滚动。

Workspace 删除旧 `ServerOpsOverview` 占位实现，active overview 分支传入 selectedHost.id、connected 和 active 状态。

- [ ] **Step 4: 运行概览测试并验证 GREEN**

```bash
bun test --isolate apps/electron/src/renderer/components/server-ops/ServerOpsOverviewPanel.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx
```

Expected: PASS，未连接和失效状态不发 IPC。

- [ ] **Step 5: 提交概览 UI**

```bash
git add apps/electron/src/renderer/components/server-ops/ServerOpsOverviewPanel.tsx apps/electron/src/renderer/components/server-ops/ServerOpsOverviewPanel.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx
git diff --cached --name-only
git commit -m "功能：展示服务器实时概览"
```

## Task 10: Renderer systemd 服务面板

**Files:**
- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsServicesPanel.tsx`
- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsServicesPanel.test.tsx`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`

- [ ] **Step 1: 写筛选、详情、确认和权威回读失败测试**

```tsx
test('Given 服务列表 When 搜索并筛选失败 Then 只显示匹配服务', async () => {
  render(<ServerOpsServicesPanelView {...props} services={services} filter="failed" query="redis" />)
  expect(screen.getByText('redis.service')).toBeInTheDocument()
  expect(screen.queryByText('nginx.service')).not.toBeInTheDocument()
})

test('Given 用户点击重启 When 尚未确认 Then 不调用 IPC', async () => {
  await user.click(screen.getByRole('button', { name: '重启 nginx.service' }))
  expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  expect(runActions).toHaveLength(0)
})

test('Given 动作确认 When IPC 完成 Then 重新读取详情并禁用重复提交', async () => {
  await confirmRestart()
  expect(runActions).toEqual([{ sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart' }])
  expect(detailReads.at(-1)).toEqual({ hostId: 'host-1', unitId: 'nginx.service' })
})

test('Given 用户服务动作审计 When 渲染审计页 Then 显示 actor、unit 与动作且不显示命令占位', () => {
  const html = renderAuditRecord(userServiceRecord)
  expect(html).toContain('用户')
  expect(html).toContain('nginx.service')
  expect(html).toContain('重启')
  expect(html).not.toContain('命令：-')
})
```

- [ ] **Step 2: 运行服务面板测试并验证 RED**

```bash
bun test --isolate apps/electron/src/renderer/components/server-ops/ServerOpsServicesPanel.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx
```

Expected: FAIL，服务面板尚不存在。

- [ ] **Step 3: 实现服务列表、详情与动作控制器**

面板 props：

```ts
export interface ServerOpsServicesPanelProps { sessionId: string | null; hostId: string; active: boolean; connected: boolean }
```

进入页签或手动刷新时加载列表；搜索和状态筛选只作用于内存数据。详情使用独立 requestRevision，快速切换服务时拒绝旧结果。切主机、断线或 inactive 清空选择并使旧请求失效。Workspace 审计视图同时增加 actor 与服务动作筛选和标签，用户服务记录显示 unit，不渲染命令占位。

动作按钮打开 Radix AlertDialog，标题包含动作和 unit；确认后只调用一次 `runServerOpsServiceAction`。执行期间禁用当前服务全部动作；成功、失败或 unknown 都重新加载详情与列表。公开 warning 使用 toast，但真实服务状态只来自回读。

列表使用语义 table、稳定列宽和横向滚动；状态筛选使用 Select；启动/停止/重启/启用/禁用按钮使用 lucide 图标和 Tooltip。unsupported、permission-denied、empty、loading、error 独立展示。

- [ ] **Step 4: 运行服务 UI 测试并验证 GREEN**

```bash
bun test --isolate apps/electron/src/renderer/components/server-ops/ServerOpsServicesPanel.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx
```

Expected: PASS，确认前零副作用，迟到详情不污染当前服务。

- [ ] **Step 5: 提交服务 UI**

```bash
git add apps/electron/src/renderer/components/server-ops/ServerOpsServicesPanel.tsx apps/electron/src/renderer/components/server-ops/ServerOpsServicesPanel.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx
git diff --cached --name-only
git commit -m "功能：增加 systemd 服务控制台"
```

## Task 11: Renderer 实时日志面板与完整释放

**Files:**
- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsLogsPanel.tsx`
- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsLogsPanel.test.tsx`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`

- [ ] **Step 1: 写缓冲、ACK、暂停、切页与导出失败测试**

```tsx
test('Given 当前流日志超过双上限 When 追加 Then 淘汰最早行并标记截断', () => {
  const buffer = createServerOpsLogBuffer({ maxLines: 5_000, maxBytes: 2_097_152 })
  for (let index = 0; index < 5_100; index += 1) buffer.append(`line-${index}\n`)
  expect(buffer.lineCount()).toBe(5_000)
  expect(buffer.isTruncated()).toBe(true)
  expect(buffer.text()).not.toContain('line-0\n')
})

test('Given chunk 属于当前流 When 接收 Then 先入缓冲再 ACK；旧流不 ACK', () => {
  controller.handleOutput({ hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: 'ok\n' })
  controller.handleOutput({ hostId: 'host-1', streamId: 'stream-old', sequence: 1, data: 'old\n' })
  expect(acks).toEqual([{ hostId: 'host-1', streamId: 'stream-1', sequence: 1 }])
  expect(projection.text).toBe('ok\n')
})

test('Given 日志页切走或断线 When deactive Then 停止精确流且不自动重连', async () => {
  await controller.activate(target)
  controller.deactivate()
  expect(stops).toEqual([{ hostId: 'host-1', streamId: 'stream-1' }])
  connectionChanged('connected')
  expect(starts).toHaveLength(1)
})

test('Given 用户下载 When 选择保存 Then 只导出当前有界缓冲', async () => {
  await controller.exportCurrent()
  expect(exports).toEqual([{ hostId: 'host-1', content: 'visible\n' }])
})
```

- [ ] **Step 2: 运行日志 UI 测试并验证 RED**

```bash
bun test --isolate apps/electron/src/renderer/components/server-ops/ServerOpsLogsPanel.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx
```

Expected: FAIL，日志 buffer/controller/view 尚不存在。

- [ ] **Step 3: 实现有界 Buffer、Controller 与日志 View**

`createServerOpsLogBuffer()` 按 UTF-8 `TextEncoder` 字节数和换行边界维护 deque，不在每个 chunk 上复制完整 2 MiB 字符串；只有发布投影时合并当前可见文本。追加、淘汰和清空为可测试纯方法。

Controller 保存 target、stream、requestRevision、status、paused、query 和 truncated。activate 只在 active + connected 时显式 start；来源或远程筛选变化先 stop 再 start；本地 query 变化不重启远程流。handleOutput 必须先验证 target/stream/sequence、写入 buffer 并发布，再 ACK。deactivate/dispose/断线同步失效旧 stream 并 best-effort stop。

View 顶栏使用 Select 选择 system/unit、时间和 priority；搜索框只过滤本地行；Play/Pause、Trash2、Download 和 ArrowDown 图标按钮带 Tooltip。日志正文使用稳定高度等宽文本、允许选择；用户离开底部后不抢滚动，显示“有新日志”按钮。暂停不停止 ACK 或缓冲淘汰。

Workspace 的 logs 分支传入 selected host、active section、connected 和可见 session；切到其它页签时组件收到 active=false 并停止。删除通用 `ServerOpsDisconnectedSection` 对 services/logs 的占位，仅保留未实现 files/docker 的占位。

- [ ] **Step 4: 运行日志与 Workspace 测试并验证 GREEN**

```bash
bun test --isolate apps/electron/src/renderer/components/server-ops/ServerOpsLogsPanel.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx
```

Expected: PASS，旧流零 ACK，切页和断线只停止一次。

- [ ] **Step 5: 提交日志 UI**

```bash
git add apps/electron/src/renderer/components/server-ops/ServerOpsLogsPanel.tsx apps/electron/src/renderer/components/server-ops/ServerOpsLogsPanel.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx
git diff --cached --name-only
git commit -m "功能：增加实时服务器日志控制台"
```

## Task 12: 完整回归、安全与视觉验证

**Files:**
- Modify: `MEMORY.md`
- Modify only if required by verified defects: files from Tasks 1-11

- [ ] **Step 1: 运行全部相关测试**

```bash
bun test --isolate packages/shared/src/types/server-ops.test.ts apps/electron/src/main/lib/server-ops apps/electron/src/utility/server-ops apps/electron/src/preload/server-ops-audit-preload.test.ts apps/electron/src/preload/server-ops-observability-preload.test.ts apps/electron/src/renderer/components/server-ops apps/electron/src/renderer/components/app-shell/AppShell.server-ops-access.test.ts apps/electron/src/renderer/lib/server-ops-agent-access-session-guard.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/adapters/pi-agent-adapter-permission.test.ts apps/electron/src/main/lib/agent-permission-service.test.ts apps/electron/src/main/lib/agent-service.test.ts apps/electron/src/main/lib/agent-session-visibility.test.ts apps/electron/src/main/lib/automation-scheduler.test.ts
```

Expected: 0 fail。若 loopback SSH fixture 因沙箱无法监听 `127.0.0.1:0`，只对同一命令请求本机回环端口权限后重跑，不连接真实服务器。

- [ ] **Step 2: 运行全仓类型检查**

```bash
bun run typecheck
```

Expected: 7 个 workspace 全部退出码 0。

- [ ] **Step 3: 构建 Electron**

```bash
CLANG_MODULE_CACHE_PATH=/private/tmp SWIFT_MODULE_CACHE_PATH=/private/tmp bun run electron:build
```

Expected: exit 0；现存 EventKit availability warning 可记录但不能掩盖构建失败。

- [ ] **Step 4: 检查构建产物协议**

```bash
rg -n "server-ops\.log-start|server-ops\.log-chunk|server-ops\.log-ack|server-ops\.log-exit" apps/electron/dist/server-ops-runtime.cjs apps/electron/dist/main.cjs
```

Expected: utility 和 main bundle 均包含对应 request/result/event 标识。

- [ ] **Step 5: 做凭据与内部身份泄漏扫描**

```bash
rg -l "(password|passphrase|privateKey|credentialRef|connectionId|generation)[[:space:]]*[:=][[:space:]]*['\"][^'\"]+" apps/electron/src/main/lib/server-ops apps/electron/src/utility/server-ops apps/electron/src/preload packages/shared/src/types/server-ops.ts -g '!*.test.ts' -g '!*.test.tsx'
```

Expected: 生产公开 DTO、Preload 返回和 Renderer 事件无秘密字面量；内部 runtime/connection 文件的必要 connectionId 使用须逐项人工确认不跨 IPC。

- [ ] **Step 6: 使用本地 SSH fixture 做 Proma Dev 视觉冒烟**

验证：

1. 1000px 面板下指标、文件系统、进程、服务详情和日志工具栏无重叠；
2. 620px 面板下指标两列、表格横向滚动、服务详情堆叠；
3. light/dark 主题状态色可辨识；
4. 键盘可到达刷新、筛选、服务动作确认和日志控制；
5. 切换页签或断开 fixture 后网络/日志活动停止；
6. 页面不显示任何静态假指标。

禁止连接或修改用户真实服务器。保存桌面和窄面板截图作为验证证据。

- [ ] **Step 7: 更新项目记忆**

在 `MEMORY.md` 追加最终实现事实：概览脚本版本与采样、systemd 动作边界、日志 ACK/内存上限、审计 v2 迁移、UI 生命周期，以及对用户和性能的影响。不记录服务器地址、日志内容或凭据值。

- [ ] **Step 8: 最终差异检查**

```bash
git diff --check HEAD
git status --short
```

Expected: 无空白错误；Canvas 用户修改和未跟踪 OMX 状态保持原样；没有意外生成文件进入提交。

- [ ] **Step 9: 提交验证记录**

```bash
git add MEMORY.md
git diff --cached --name-only
git commit -m "文档：记录运维观测能力验证结果"
```

若 `MEMORY.md` 含有本计划开始前的用户改动且无法安全拆分，跳过此 commit 并在最终报告说明，禁止提交不相关内容。
