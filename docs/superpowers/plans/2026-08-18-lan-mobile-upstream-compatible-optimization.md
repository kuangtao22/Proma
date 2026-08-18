# LAN 与移动端上游兼容优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可持续合并 Proma 上游的 LAN 扩展边界，修复连接可靠性，并提供一次性二维码配对与设备撤销。

**Architecture:** LAN Bridge 通过自有协议 DTO 和 Proma Adapter 隔离官方 Agent、Chat、会话与设置接口；IPC、Preload 和应用入口只保留稳定注册点。认证在现有 PIN/HMAC 基础上加入短时单次票据与持久化设备版本，移动端通过协议能力协商兼容新旧服务。

**Tech Stack:** Bun、TypeScript、Electron、React、Jotai、WebSocket、现有 `qrcode`、JSON 原子持久化。

---

## 文件边界

**新增文件**

- `apps/electron/src/main/lib/lan-bridge/lan-bridge-protocol.test.ts`：协议版本和能力契约。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.ts`：唯一的官方服务适配边界。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts`：Adapter DTO 映射契约。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts`：LAN IPC 注册。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.test.ts`：LAN IPC 注册契约。
- `apps/electron/src/preload/lan-bridge-preload.ts`：LAN Preload API 类型与实现。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-session.test.ts`：心跳、设备连接和断开行为。
- `apps/mobile/src/lib/ws-client.test.ts`：挂起请求清理和重连状态。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.ts`：设备元数据持久化。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.test.ts`：设备注册、撤销和损坏文件降级。
- `apps/mobile/src/lib/pairing-link.ts`：二维码 fragment 解析与清理。
- `apps/mobile/src/lib/pairing-link.test.ts`：配对链接边界测试。
- `apps/electron/scripts/check-fork-compat.ts`：上游接缝与移动资源静态检查。
- `apps/electron/scripts/check-fork-compat.test.ts`：上游接缝静态检查测试。
- `.github/workflows/upstream-compat.yml`：定时和手动上游兼容验证。

**重点修改文件**

- `packages/shared/src/types/lan-bridge.ts`
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.ts`
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.test.ts`
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts`
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-session.ts`
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-types.ts`
- `apps/electron/src/main/lib/lan-bridge/lan-bridge.ts`
- `apps/electron/src/main/ipc.ts`
- `apps/electron/src/preload/index.ts`
- `apps/electron/src/renderer/components/settings/LanBridgeSettings.tsx`
- `apps/mobile/src/App.tsx`
- `apps/mobile/src/lib/ws-client.ts`
- `apps/mobile/src/components/layout/AuthPage.tsx`
- `apps/electron/package.json`

## Task 1: 建立版本化协议与稳定 DTO

**Files:**
- Modify: `packages/shared/src/types/lan-bridge.ts`
- Create: `apps/electron/src/main/lib/lan-bridge/lan-bridge-protocol.test.ts`

- [ ] **Step 1: 写入失败的协议契约测试**

```ts
import { describe, expect, test } from 'bun:test'
import {
  LAN_BRIDGE_CAPABILITIES,
  LAN_BRIDGE_PROTOCOL_VERSION,
  type LanBridgeConnectedPayload,
} from '@proma/shared'

describe('LAN Bridge 协议协商', () => {
  test('连接确认包含稳定协议版本与能力集合', () => {
    const payload: LanBridgeConnectedPayload = {
      message: 'Proma LAN Bridge',
      protocolVersion: LAN_BRIDGE_PROTOCOL_VERSION,
      serverVersion: '0.17.42',
      capabilities: [...LAN_BRIDGE_CAPABILITIES],
    }

    expect(payload.protocolVersion).toBe(2)
    expect(payload.capabilities).toContain('pairing-ticket')
    expect(payload.capabilities).toContain('device-revocation')
  })
})
```

- [ ] **Step 2: 运行测试并确认因协议常量缺失而失败**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-protocol.test.ts`

Expected: FAIL，提示 `LAN_BRIDGE_PROTOCOL_VERSION` 或 `LAN_BRIDGE_CAPABILITIES` 未导出。

- [ ] **Step 3: 添加协议版本、能力和 LAN 自有 DTO**

在 `lan-bridge.ts` 中新增：

```ts
export const LAN_BRIDGE_PROTOCOL_VERSION = 2

export const LAN_BRIDGE_CAPABILITIES = [
  'pin-pairing',
  'pairing-ticket',
  'device-revocation',
  'streaming',
  'connection-recovery',
] as const

export type LanBridgeCapability = typeof LAN_BRIDGE_CAPABILITIES[number]

export interface LanBridgeConnectedPayload {
  message: string
  protocolVersion: number
  serverVersion: string
  capabilities: LanBridgeCapability[]
}

export interface LanBridgeConversationDto {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface LanBridgeAgentSessionDto {
  id: string
  title: string
  workspaceId?: string
  createdAt: number
  updatedAt: number
}
```

将协议结果中的官方 `ConversationMeta`、`AgentSessionMeta` 替换为上述自有 DTO；新增 `DEVICE_REVOKED`、`PAIRING_TICKET_INVALID`、`PAIRING_TICKET_EXPIRED`、`PROTOCOL_UNSUPPORTED`、`CONNECTION_LOST` 错误码和设备/票据 IPC 类型。

- [ ] **Step 4: 验证协议测试和 shared typecheck**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-protocol.test.ts && bun run --filter='@proma/shared' typecheck`

Expected: PASS。

- [ ] **Step 5: 提交协议层**

```bash
git add packages/shared/src/types/lan-bridge.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-protocol.test.ts
git commit -m "重构：版本化局域网协议并隔离共享类型"
```

## Task 2: 建立 Proma Adapter 上游隔离层

**Files:**
- Create: `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.ts`
- Create: `apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts`

- [ ] **Step 1: 写入失败的 DTO 映射测试**

测试通过依赖注入传入最小官方对象，断言 Adapter 只返回 LAN DTO 字段，并验证搜索、工作区、设置和频道映射不泄漏额外字段。

```ts
test('将官方会话映射为稳定 LAN DTO', () => {
  const adapter = createLanBridgePromaAdapter({
    listConversations: () => [{ id: 'c1', title: '会话', createdAt: 1, updatedAt: 2, internalPath: '/secret' }],
    listAgentSessions: () => [{ id: 'a1', title: 'Agent', workspaceId: 'w1', createdAt: 3, updatedAt: 4, providerOptions: {} }],
  } as LanBridgePromaDependencies)

  expect(adapter.listConversations()).toEqual([{ id: 'c1', title: '会话', createdAt: 1, updatedAt: 2 }])
  expect(adapter.listAgentSessions()).toEqual([{ id: 'a1', title: 'Agent', workspaceId: 'w1', createdAt: 3, updatedAt: 4 }])
})
```

- [ ] **Step 2: 运行测试并确认 Adapter 缺失**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts`

Expected: FAIL，提示模块或导出不存在。

- [ ] **Step 3: 实现 Adapter 接口与默认依赖**

Adapter 暴露 `listConversations`、`getConversationMessages`、`searchConversations`、`listAgentSessions`、`getAgentMessages`、`searchAgentSessions`、`listWorkspaces`、`createAgentSession`、`sendAgent`、`stopAgent`、`sendConversation`、`stopConversation`、`getSettings`、`listChannels`。所有官方 service/manager 导入只允许出现在此文件。

```ts
export interface LanBridgeWorkspaceDto {
  id: string
  name: string
  slug: string
  createdAt: number
}

export interface LanBridgeSearchResultDto {
  id: string
  title: string
  snippet: string
  type: 'chat' | 'agent'
  matchedAt: number
}

export interface LanBridgeSettingsDto {
  agentChannelId?: string
  agentModelId?: string
  agentWorkspaceId?: string
}

export interface LanBridgeChannelDto {
  id: string
  name: string
  provider: string
  enabled: boolean
}

export interface LanBridgeAgentSendCommand {
  sessionId: string
  userMessage: string
  workspaceId?: string
  modelId?: string
  permissionMode?: 'auto' | 'bypassPermissions' | 'plan'
}

export interface LanBridgeConversationSendCommand {
  conversationId: string
  userMessage: string
  channelId?: string
  modelId?: string
}

export interface LanBridgeStreamCallbacks {
  onChunk(data: { sessionId: string; text: string }): void
  onReasoning(data: { sessionId: string; text: string }): void
  onError(data: { sessionId: string; error: string }): void
  onComplete(data: { sessionId: string }): void
  onTitleUpdated?(data: { sessionId: string; title: string }): void
}

export interface LanBridgePromaDependencies {
  listConversations(): Array<LanBridgeConversationDto & Record<string, unknown>>
  listAgentSessions(): Array<LanBridgeAgentSessionDto & Record<string, unknown>>
  getConversationMessages(conversationId: string): unknown[]
  getAgentMessages(sessionId: string): unknown[]
  searchConversations(query: string): Promise<LanBridgeSearchResultDto[]>
  searchAgentSessions(query: string): LanBridgeSearchResultDto[]
  listWorkspaces(): Array<LanBridgeWorkspaceDto & Record<string, unknown>>
  createAgentSession(title?: string, workspaceId?: string): LanBridgeAgentSessionDto & Record<string, unknown>
  sendAgent(input: LanBridgeAgentSendCommand, callbacks: LanBridgeStreamCallbacks): Promise<void>
  stopAgent(sessionId: string): void
  sendConversation(input: LanBridgeConversationSendCommand, callbacks: LanBridgeStreamCallbacks): Promise<void>
  stopConversation(conversationId: string): void
  getSettings(): LanBridgeSettingsDto & Record<string, unknown>
  listChannels(): Array<LanBridgeChannelDto & Record<string, unknown>>
}

export interface LanBridgePromaAdapter {
  listConversations(): LanBridgeConversationDto[]
  listAgentSessions(): LanBridgeAgentSessionDto[]
  getConversationMessages(conversationId: string): unknown[]
  getAgentMessages(sessionId: string): unknown[]
  searchConversations(query: string): Promise<LanBridgeSearchResultDto[]>
  searchAgentSessions(query: string): LanBridgeSearchResultDto[]
  listWorkspaces(): LanBridgeWorkspaceDto[]
  createAgentSession(title?: string, workspaceId?: string): LanBridgeAgentSessionDto
  sendAgent(input: LanBridgeAgentSendCommand, callbacks: LanBridgeStreamCallbacks): Promise<void>
  stopAgent(sessionId: string): void
  sendConversation(input: LanBridgeConversationSendCommand, callbacks: LanBridgeStreamCallbacks): Promise<void>
  stopConversation(conversationId: string): void
  getSettings(): LanBridgeSettingsDto
  listChannels(): LanBridgeChannelDto[]
}
```

上述接口与 DTO 均由 `lan-bridge-proma-adapter.ts` 自有；默认 Adapter 在同一文件内把官方对象逐字段映射为这些类型，handlers 不接收或返回官方 service 类型。

- [ ] **Step 4: handlers 改为只调用 Adapter**

删除 handlers 对 `conversation-manager`、`agent-session-manager`、`agent-workspace-manager`、`agent-service`、`settings-service`、`channel-manager`、`chat-service` 的直接导入，保留认证、路由与订阅编排。

- [ ] **Step 5: 验证 Adapter 契约与现有订阅测试**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-subscription.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交 Adapter**

```bash
git add apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts
git commit -m "重构：通过适配层隔离上游服务变更"
```

## Task 3: 收敛 IPC 与 Preload 接缝

**Files:**
- Create: `apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts`
- Create: `apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.test.ts`
- Create: `apps/electron/src/preload/lan-bridge-preload.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`

- [ ] **Step 1: 写入 IPC 注册契约测试**

在 `lan-bridge-ipc.test.ts` 使用记录型 `handle` 函数，断言所有 `LAN_BRIDGE_IPC_CHANNELS` 命令只注册一次，并覆盖获取二维码、设备列表和撤销设备。

- [ ] **Step 2: 运行测试并确认独立注册器缺失**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.test.ts`

Expected: FAIL，提示 `registerLanBridgeIpcHandlers` 不存在。

- [ ] **Step 3: 实现独立 LAN IPC 注册器**

```ts
export function registerLanBridgeIpcHandlers(ipc: Pick<typeof ipcMain, 'handle'> = ipcMain): void {
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_CONFIG, async () => getConfig())
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.UPDATE_CONFIG, async (_event, updates) => updateConfig(updates))
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_STATUS, async () => getLanBridgeStatus())
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.START, async () => startLanBridge(agentEventBus))
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.STOP, async () => stopLanBridge())
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_PIN, async () => getCurrentPin())
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.REFRESH_PIN, async () => refreshPin())
}
```

后续 Task 7 在同一模块追加二维码和设备命令。根 `ipc.ts` 删除 LAN 实现，只调用 `registerLanBridgeIpcHandlers()`。

- [ ] **Step 4: 实现独立 Preload API 并组合到根 API**

```ts
export interface LanBridgePreloadApi {
  getLanBridgeConfig: () => Promise<LanBridgeConfig>
  updateLanBridgeConfig: (updates: Partial<LanBridgeConfig>) => Promise<LanBridgeConfig>
  getLanBridgeStatus: () => Promise<LanBridgeRuntimeState>
  startLanBridge: () => Promise<void>
  stopLanBridge: () => Promise<void>
  getLanBridgePin: () => Promise<string>
  refreshLanBridgePin: () => Promise<string>
  onLanBridgeStatusChanged: (listener: (state: LanBridgeRuntimeState) => void) => () => void
}

export const lanBridgePreloadApi = createLanBridgePreloadApi(ipcRenderer)
```

根 `ElectronAPI` 使用 `extends LanBridgePreloadApi`，根 `electronAPI` 使用 `...lanBridgePreloadApi`。

- [ ] **Step 5: 验证 IPC 测试、Preload build 和 typecheck**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.test.ts && bun run --filter='@proma/electron' build:preload && bun run --filter='@proma/electron' typecheck`

Expected: PASS。

- [ ] **Step 6: 提交接缝收敛**

```bash
git add apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.test.ts apps/electron/src/preload/lan-bridge-preload.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts
git commit -m "重构：收敛局域网 IPC 与预加载接缝"
```

## Task 4: 修复服务端心跳与连接恢复

**Files:**
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-session.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-types.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge.ts`
- Create: `apps/electron/src/main/lib/lan-bridge/lan-bridge-session.test.ts`

- [ ] **Step 1: 写入正常空闲连接和超时连接测试**

通过注入 `now` 与 interval scheduler 捕获心跳 tick：正常客户端回复 `pong` 后持续 60 秒不被断开；45 秒不回复的客户端被终止。

```ts
test('空闲客户端回复心跳后保持连接', () => {
  const harness = createSessionHarness()
  const client = harness.manager.addClient(harness.ws, '192.168.1.8')!
  harness.advanceTo(15_000)
  expect(harness.ws.sent).toContainEqual({ type: '_heartbeat' })
  harness.manager.markPong(client, 15_001)
  harness.advanceTo(60_000)
  expect(harness.ws.terminated).toBe(false)
})
```

- [ ] **Step 2: 运行测试并确认旧逻辑误断或 API 缺失**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-session.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 15 秒心跳和 45 秒 pong 超时**

`ClientConnection` 使用 `lastPongAt`，`handleMessage` 遇到 `pong` 调用 `markPong`。每个 tick 先根据上次 pong 判断超时，再给存活连接发送心跳；新连接至少拥有一个完整超时窗口。

- [ ] **Step 4: LAN 注册接入 `needsRecovery` 与 `recover`**

`needsRecovery` 仅在配置启用且状态为 `error` 时返回 true；`recover` 复用当前 EventBus，执行 stop 后 start。

- [ ] **Step 5: 验证心跳与认证回归测试**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-session.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交可靠性修复**

```bash
git add apps/electron/src/main/lib/lan-bridge/lan-bridge-session.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-session.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-types.ts apps/electron/src/main/lib/lan-bridge/lan-bridge.ts
git commit -m "修复：稳定局域网心跳与 Bridge 自愈"
```

## Task 5: 修复移动端挂起请求和重连状态

**Files:**
- Modify: `apps/mobile/src/lib/ws-client.ts`
- Create: `apps/mobile/src/lib/ws-client.test.ts`
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/components/conversation/ChatView.tsx`

- [ ] **Step 1: 写入断线立即拒绝请求测试**

注入 FakeWebSocket 和 scheduler，发出请求后触发 close，断言 Promise 以 `CONNECTION_LOST` 失败、计时器被清除、请求表归零。

- [ ] **Step 2: 运行测试并确认当前实现等待超时**

Run: `bun test apps/mobile/src/lib/ws-client.test.ts`

Expected: FAIL，旧实现不会在 close 时立即 reject。

- [ ] **Step 3: 将连接器改为可注入实例并保留现有模块 facade**

每个 pending request 保存 `resolve`、`reject` 和 `timeoutId`。`onclose` 调用统一 `rejectPendingRequests('CONNECTION_LOST')`，使用 1 秒起步、15 秒上限并加入小幅随机抖动的指数退避。

- [ ] **Step 4: 重连后统一执行认证恢复**

`App.tsx` 在重连事件中先 `auth.verify`，成功后重新加载列表；`ChatView` 在列表恢复后重新订阅当前会话。验证失败时删除 Token 并回配对页。

- [ ] **Step 5: 验证移动端测试、typecheck 和 build**

Run: `bun test apps/mobile/src/lib/ws-client.test.ts && bun run --filter='@proma/mobile' typecheck && bun run --filter='@proma/mobile' build`

Expected: PASS。

- [ ] **Step 6: 提交移动端连接修复**

```bash
git add apps/mobile/src/lib/ws-client.ts apps/mobile/src/lib/ws-client.test.ts apps/mobile/src/App.tsx apps/mobile/src/components/conversation/ChatView.tsx
git commit -m "修复：清理移动端挂起请求并恢复重连状态"
```

## Task 6: 实现设备存储、一次性票据和可撤销 Token

**Files:**
- Create: `apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.ts`
- Create: `apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.test.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.test.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-types.ts`

- [ ] **Step 1: 写入设备持久化失败测试**

覆盖注册设备、更新最后访问时间节流、撤销递增 `tokenVersion`、损坏 JSON 降级为空列表。测试使用临时配置目录并验证写入走安全 JSON API。

- [ ] **Step 2: 写入票据和 Token 失败测试**

覆盖 120 秒有效、单次消费、过期、错误票据、设备撤销后旧 Token 失效、不同 IP 无法复用 Token、PIN 配对仍可签发设备 Token。

```ts
test('一次性票据只能消费一次', () => {
  auth.initAuth()
  const ticket = auth.createPairingTicket(1_000)
  expect(typeof auth.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 1_001).token).toBe('string')
  expect(() => auth.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 1_002)).toThrow()
})
```

- [ ] **Step 3: 运行测试并确认功能缺失**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.test.ts`

Expected: FAIL。

- [ ] **Step 4: 实现设备存储**

使用 `readJsonFileSafe` 和 `writeJsonFileAtomic` 管理 `~/.proma/lan-bridge-devices.json`。设备记录包含 `id`、`name`、`createdAt`、`lastSeenAt`、`tokenVersion`、`revokedAt`，不保存凭据。

- [ ] **Step 5: 实现票据和设备 Token**

票据由 32 字节随机数生成，内存 Map 保存过期时间并在消费时原子删除。Token payload 增加 `deviceId`、`tokenVersion`、`iat`、`ip`；验证同时检查签名、24 小时有效期、IP 和设备版本。

- [ ] **Step 6: SessionManager 记录设备并支持撤销断开**

认证成功后设置 `client.deviceId`。新增 `disconnectDevice(deviceId)`，撤销后以明确 close code 关闭该设备所有连接。

- [ ] **Step 7: 验证认证与 session 测试**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-session.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交设备认证**

```bash
git add apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-types.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-session.ts
git commit -m "功能：增加一次性配对票据与设备撤销"
```

## Task 7: 接入二维码、设备管理和自动配对 UI

**Files:**
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts`
- Modify: `apps/electron/src/preload/lan-bridge-preload.ts`
- Modify: `apps/electron/src/renderer/components/settings/LanBridgeSettings.tsx`
- Create: `apps/mobile/src/lib/pairing-link.ts`
- Create: `apps/mobile/src/lib/pairing-link.test.ts`
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/components/layout/AuthPage.tsx`

- [ ] **Step 1: 写入 pairing fragment 解析失败测试**

```ts
test('读取票据后返回干净地址', () => {
  expect(parsePairingLink('http://192.168.1.2:29888/#/pair?ticket=abc')).toEqual({
    ticket: 'abc',
    cleanUrl: 'http://192.168.1.2:29888/',
  })
})
```

覆盖无票据、空票据、编码异常和重复读取。

- [ ] **Step 2: 运行测试并确认解析模块缺失**

Run: `bun test apps/mobile/src/lib/pairing-link.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现二维码生成 IPC**

主进程使用现有 `qrcode` 将 `http://<ip>:<port>/#/pair?ticket=<value>` 生成 data URL；IPC 返回 `qrCodeData`、`expiresAt`。新增设备列表与撤销 IPC，撤销后调用 SessionManager 断开设备。

- [ ] **Step 4: 桌面设置显示二维码与设备列表**

服务运行时显示二维码、剩余有效时间和刷新图标；设备列表显示名称、最近访问时间和撤销按钮。PIN 区继续保留，明确标注为手工/第三方连接方式。

- [ ] **Step 5: 移动端实现自动票据配对**

应用启动读取并立即清除 fragment，连接页面 host/port 后发送 `auth.pairTicket`。成功保存 Token 并进入聊天；过期或已消费时显示错误并保留 PIN 表单。

- [ ] **Step 6: 验证 UI 逻辑、typecheck 和移动 build**

Run: `bun test apps/mobile/src/lib/pairing-link.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.test.ts && bun run typecheck && bun run --filter='@proma/mobile' build`

Expected: PASS。

- [ ] **Step 7: 提交扫码与设备 UI**

```bash
git add apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts apps/electron/src/preload/lan-bridge-preload.ts apps/electron/src/renderer/components/settings/LanBridgeSettings.tsx apps/mobile/src/lib/pairing-link.ts apps/mobile/src/lib/pairing-link.test.ts apps/mobile/src/App.tsx apps/mobile/src/components/layout/AuthPage.tsx
git commit -m "功能：增加扫码配对与设备管理界面"
```

## Task 8: 自动化上游兼容检查

**Files:**
- Create: `apps/electron/scripts/check-fork-compat.ts`
- Create: `apps/electron/scripts/check-fork-compat.test.ts`
- Modify: `apps/electron/package.json`
- Create: `.github/workflows/upstream-compat.yml`

- [ ] **Step 1: 写入失败的接缝静态检查测试**

测试传入内存文件内容，确认缺少 Bridge 注册、IPC 注册、Preload 组合或 `mobile-dist` 声明时返回明确失败；完整接缝返回成功。

- [ ] **Step 2: 运行测试并确认检查器缺失**

Run: `bun test apps/electron/scripts/check-fork-compat.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现兼容检查器和脚本命令**

增加 `check:fork-compat`，检查稳定注册点、协议版本、Adapter 边界、移动构建脚本和打包资源。检查器只读仓库，不修改工作区。

- [ ] **Step 4: 增加上游兼容工作流**

工作流支持 `workflow_dispatch` 和每周定时运行：拉取 fork、添加官方 upstream、获取最新正式标签，在临时分支执行无提交 merge；冲突直接失败，无冲突时运行 `bun install --frozen-lockfile`、兼容检查、LAN 测试、移动 build、根 typecheck 和 Electron build。工作流不 push、不创建 PR。

- [ ] **Step 5: 验证脚本和 YAML 基本结构**

Run: `bun test apps/electron/scripts/check-fork-compat.test.ts && bun run --filter='@proma/electron' check:fork-compat`

Expected: PASS。

- [ ] **Step 6: 提交兼容自动化**

```bash
git add apps/electron/scripts/check-fork-compat.ts apps/electron/scripts/check-fork-compat.test.ts apps/electron/package.json .github/workflows/upstream-compat.yml
git commit -m "工程：自动验证上游合并兼容性"
```

## Task 9: 全量验证与行为审查

**Files:**
- Modify only if verification exposes scoped defects.

- [ ] **Step 1: 运行全部 LAN 与移动端定向测试**

Run: `bun test apps/electron/src/main/lib/lan-bridge apps/mobile/src/lib apps/electron/scripts/check-fork-compat.test.ts`

Expected: PASS，0 failures。

- [ ] **Step 2: 运行全仓类型检查**

Run: `bun run typecheck`

Expected: PASS。

- [ ] **Step 3: 运行移动端和 Electron 构建**

Run: `bun run --filter='@proma/mobile' build && bun run electron:build`

Expected: PASS。

- [ ] **Step 4: 运行兼容检查和变更检查**

Run: `bun run --filter='@proma/electron' check:fork-compat && git diff --check`

Expected: PASS。

- [ ] **Step 5: 手工冒烟验证**

验证桌面启动 Bridge、二维码显示、扫码自动配对、PIN 回退、查询与发送、流式输出、停止、空闲 60 秒不断开、断网重连、撤销设备立即失效、端口修改重启和打包资源存在。

- [ ] **Step 6: 审查提交边界**

Run: `git log --oneline --decorate -10 && git status --short && git diff HEAD~8..HEAD --stat`

Expected: 每层独立提交；`MEMORY.md` 等用户既有改动未被误提交。
