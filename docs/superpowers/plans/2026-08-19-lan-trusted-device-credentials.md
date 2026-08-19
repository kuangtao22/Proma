# LAN 可信设备长期凭证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让二维码扫码直接授权当前移动浏览器，并让可信设备永久自动续签，直到用户在 Proma 桌面端手动撤销。

**Architecture:** 一次性二维码票据只负责首次授权；移动端持久化随机设备 ID、短期访问令牌和高熵长期设备凭证。主进程只持久化长期凭证哈希，访问令牌保持短期 HMAC 签名；设备撤销通过 `tokenVersion` 和 `revokedAt` 同时阻断现有连接、访问令牌与长期续签。设备身份不绑定 DHCP IP，IP 仅作为审计元数据。

**Tech Stack:** Bun、TypeScript、Electron、React、Jotai、WebSocket、Node.js crypto、现有 JSON 原子持久化。

---

## 文件边界

- `apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.ts`：签发和校验短期访问令牌、长期设备凭证。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.ts`：原子保存凭证哈希与审计元数据，对 UI 只暴露安全 DTO。
- `apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts`：兼容旧 `auth.refresh { token }`，新增 `auth.refresh { credential }`。
- `apps/mobile/src/lib/device-credentials.ts`：生成设备 ID、保存和清除移动端认证材料。
- `apps/mobile/src/lib/auth-recovery.ts`：优先验证访问令牌，失败后使用长期凭证自动续签。
- `apps/mobile/src/App.tsx`：接入扫码免 PIN、设备 ID 和自动续签。
- `packages/shared/src/types/lan-bridge.ts`、`apps/electron/src/renderer/components/settings/LanBridgeSettings.tsx`：展示设备标识、首次授权、最近访问和最近 IP。
- `apps/electron/scripts/check-fork-compat.ts`：锁定长期凭证模块和跨端协议接缝，避免上游合并静默移除。

## Task 1: 锁定可信设备认证契约

**Files:**
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.test.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.test.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.test.ts`

- [x] **Step 1: 写失败测试**

```ts
test('Given 已扫码可信设备 When IP 变化或访问令牌过期 Then 长期凭证仍可签发新访问令牌', () => {
  const paired = service.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 'device-1', 1_000)
  expect(service.verifyTokenDetails(paired.token, '192.168.1.9', 1_001).valid).toBe(true)
  expect(service.refreshDeviceCredential(paired.deviceCredential, '192.168.1.9', paired.expiresAt + 1).valid).toBe(true)
})

test('Given 可信设备已撤销 When 使用长期凭证续签 Then 返回 DEVICE_REVOKED', () => {
  store.revokeDevice('device-1', 2_000)
  expect(service.refreshDeviceCredential(deviceCredential, '192.168.1.9', 2_001))
    .toEqual({ valid: false, errorCode: 'DEVICE_REVOKED' })
})
```

- [x] **Step 2: 运行红灯**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.test.ts`

Expected: FAIL，提示长期设备凭证和设备 ID 参数尚不存在。

## Task 2: 实现服务端双凭证模型

**Files:**
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.ts`
- Modify: `apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts`
- Modify: `packages/shared/src/types/lan-bridge.ts`

- [x] **Step 1: 用高熵秘密和 SHA-256 哈希注册可信设备**

```ts
const credentialSecret = randomBytes(32).toString('base64url')
const credentialHash = createHash('sha256').update(credentialSecret).digest('base64url')
const device = this.deviceStore.registerTrustedDevice({ deviceId, name, credentialHash, ip }, now)
```

- [x] **Step 2: 将访问令牌 TTL 改为 15 分钟且取消 IP 与首次配对绝对期限绑定**

```ts
const ACCESS_TOKEN_EXPIRY_MS = 15 * 60 * 1_000
const expiresAt = now + ACCESS_TOKEN_EXPIRY_MS
```

- [x] **Step 3: 长期凭证续签只校验哈希、设备版本和撤销状态**

```ts
const verification = this.deviceStore.verifyCredential(deviceId, credentialHash)
if (!verification.valid) return verification
return { valid: true, ...this.issueAccessToken(verification.device, now) }
```

- [x] **Step 4: 运行服务端绿灯**

Run: `bun test apps/electron/src/main/lib/lan-bridge/lan-bridge-auth.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-device-store.test.ts apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.test.ts`

Expected: PASS。

## Task 3: 实现移动端设备身份与自动恢复

**Files:**
- Create: `apps/mobile/src/lib/device-credentials.ts`
- Create: `apps/mobile/src/lib/device-credentials.test.ts`
- Create: `apps/mobile/src/lib/auth-recovery.ts`
- Create: `apps/mobile/src/lib/auth-recovery.test.ts`
- Modify: `apps/mobile/src/lib/pairing-startup-coordinator.ts`
- Modify: `apps/mobile/src/lib/pairing-startup-coordinator.test.ts`
- Modify: `apps/mobile/src/App.tsx`

- [x] **Step 1: 写失败测试，锁定稳定设备 ID、配对结果保存、令牌失效后自动续签及撤销后清理**

```ts
test('Given 访问令牌过期且存在设备凭证 When 恢复认证 Then 自动续签并返回新令牌', async () => {
  const result = await recoverTrustedDeviceAuth(saved, transport)
  expect(result).toEqual({ status: 'authenticated', token: 'new-access-token' })
})
```

- [x] **Step 2: 运行红灯**

Run: `bun test apps/mobile/src/lib/device-credentials.test.ts apps/mobile/src/lib/auth-recovery.test.ts apps/mobile/src/lib/pairing-startup-coordinator.test.ts`

Expected: FAIL，提示新模块或凭证字段缺失。

- [x] **Step 3: 实现最小凭证存储与恢复协调器并接入 App**

移动端使用 `crypto.getRandomValues()` 生成 UUID v4 设备 ID，兼容局域网 HTTP 页面；二维码响应同时保存访问令牌和长期凭证。普通连接先验证访问令牌，`TOKEN_EXPIRED`/`TOKEN_INVALID` 时调用 `auth.refresh { credential }`，只有 `DEVICE_REVOKED` 或长期凭证无效才清空授权。

- [x] **Step 4: 运行移动端绿灯**

Run: `bun test apps/mobile/src/lib/device-credentials.test.ts apps/mobile/src/lib/auth-recovery.test.ts apps/mobile/src/lib/pairing-startup-coordinator.test.ts`

Expected: PASS。

## Task 4: 完成设备管理与上游兼容保护

**Files:**
- Modify: `apps/electron/src/renderer/components/settings/LanBridgeSettings.tsx`
- Modify: `apps/electron/src/renderer/components/settings/lan-bridge-settings-logic.test.ts`
- Modify: `apps/electron/scripts/check-fork-compat.ts`
- Modify: `apps/electron/scripts/check-fork-compat.test.ts`

- [x] **Step 1: 写失败测试，要求设备 DTO 显示稳定标识、首次授权和最近 IP，并要求兼容检查保留长期凭证接缝**

- [x] **Step 2: 运行红灯**

Run: `bun test apps/electron/src/renderer/components/settings/lan-bridge-settings-logic.test.ts apps/electron/scripts/check-fork-compat.test.ts`

Expected: FAIL。

- [x] **Step 3: 更新现有设备列表和静态兼容检查，不新增 IPC 通道**

- [x] **Step 4: 运行绿灯**

Run: `bun test apps/electron/src/renderer/components/settings/lan-bridge-settings-logic.test.ts apps/electron/scripts/check-fork-compat.test.ts`

Expected: PASS。

## Task 5: 全量验证与项目记忆

**Files:**
- Modify: `MEMORY.md`

- [x] **Step 1: 运行 LAN 与移动端相关测试**

Run: `bun test apps/electron/src/main/lib/lan-bridge apps/electron/src/preload/lan-bridge-preload.test.ts apps/electron/src/renderer/components/settings/lan-bridge-settings-logic.test.ts apps/mobile/src/lib`

- [x] **Step 2: 运行类型检查、兼容检查和生产构建**

Run: `bun run typecheck && bun run check:fork-compat && bun run electron:build && bun run --filter='@proma/mobile' build`

- [x] **Step 3: 更新 MEMORY.md**

记录长期设备凭证、访问令牌 TTL、撤销语义、IP 审计用途和上游兼容接缝，不记录凭证值。
