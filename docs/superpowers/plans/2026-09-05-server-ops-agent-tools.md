# Server Ops Agent Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user explicitly grant the current Proma Agent temporary access to one saved SSH server and call five credential-safe Server Ops tools.

**Architecture:** IPC and Pi tools share one main-process Server Ops service context. A memory-only authorization store gates every tool call, while command execution uses a bounded `ssh2` exec channel in the existing utility process and remains subject to Proma permission approval.

**Tech Stack:** Bun, TypeScript, Electron IPC/utility process, Pi Agent Runtime, ssh2, React, Jotai, Radix/shadcn, Tailwind CSS, Bun test.

---

### Task 1: Add session-scoped authorization contracts

**Files:**
- Modify: `packages/shared/src/types/server-ops.ts`
- Test: `packages/shared/src/types/server-ops.test.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-agent-access-store.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-agent-access-store.test.ts`

- [x] **Step 1: Write failing shared parser and memory-store tests**

Cover exact-key parsing of `{ sessionId, hostId, granted }`, rejection of unknown keys and invalid IDs, global single-grant replacement, exact-combination revoke, host revoke, session revoke, and empty startup state.

- [x] **Step 2: Run the tests and verify RED**

Run: `bun test packages/shared/src/types/server-ops.test.ts apps/electron/src/main/lib/server-ops/server-ops-agent-access-store.test.ts`

Expected: FAIL because the access input parser and Store do not exist.

- [x] **Step 3: Implement the strict contract and memory Store**

Add `ServerOpsAgentAccessInput`, `ServerOpsAgentAccessState`, `parseServerOpsAgentAccessInput()`, and a Store with `get(sessionId, hostId)`, `grant(sessionId, hostId)`, `revoke(sessionId, hostId)`, `revokeSession(sessionId)`, and `revokeHost(hostId)`. The Store keeps only one active grant and must not read or write disk.

- [x] **Step 4: Run the tests and verify GREEN**

Run the command from Step 2 and expect PASS.

### Task 2: Add authorization IPC and reuse the service instance

**Files:**
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-ipc.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-service-context.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`

- [x] **Step 1: Write failing IPC tests**

Cover get/set access, unauthorized sender, hidden/internal session, missing host, a new grant atomically replacing the prior grant, disconnect revoke, delete revoke, and exact response shape without credentials.

- [x] **Step 2: Run the IPC test and verify RED**

Run: `bun test apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts`

Expected: FAIL because the channels and access dependencies are absent.

- [x] **Step 3: Implement the shared main-process context and four-layer IPC**

Create one context containing host, credential, trust, connection, authorization and runtime dependencies. Add `GET_AGENT_ACCESS` and `SET_AGENT_ACCESS` channels, preload methods, authorized sender validation, user-visible-session validation and host existence checks. Revoke access when disconnecting, deleting a host, deleting a session, or when Renderer reports a current-session switch. Register the context before the first Agent query and expose only a getter that never constructs a fallback instance.

- [x] **Step 4: Run IPC tests and typecheck the contract**

Run: `bun test apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts`

Run: `bun run typecheck`

Expected: IPC tests pass; typecheck may report only downstream Renderer call sites until Task 5.

### Task 3: Implement bounded SSH exec

**Files:**
- Modify: `apps/electron/src/utility/server-ops/server-ops-runtime-protocol.ts`
- Modify: `apps/electron/src/utility/server-ops/server-ops-runtime-protocol.test.ts`
- Modify: `apps/electron/src/utility/server-ops-runtime.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-runtime-client.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-runtime-client.test.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-connection-service.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-connection-service.test.ts`

- [x] **Step 1: Write failing protocol, client and service tests**

Cover strict exec request/result parsing, active connection validation, stdout/stderr separation, exit code, signal, timeout, 1 MiB combined output truncation, runtime exit cleanup, and stale connection rejection.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `bun test apps/electron/src/utility/server-ops/server-ops-runtime-protocol.test.ts apps/electron/src/main/lib/server-ops/server-ops-runtime-client.test.ts apps/electron/src/main/lib/server-ops/server-ops-connection-service.test.ts`

Expected: FAIL because no exec contract exists.

- [x] **Step 3: Implement request/response correlation and `Client.exec()`**

Add `server-ops.exec` and `server-ops.exec-result` messages keyed by `requestId`. Enforce 8192 command characters, 1000-120000 ms timeout and 1 MiB total output. Close the exec channel on timeout or truncation and reject all pending requests if the utility process exits.

- [x] **Step 4: Expose `exec()` through `ServerOpsConnectionService`**

Require a matching connected state and delegate using the current `hostId + connectionId`; return only bounded public result fields.

- [x] **Step 5: Run the focused tests and verify GREEN**

Run the command from Step 2 and expect PASS.

### Task 4: Register the five Pi Agent tools and permission policy

**Files:**
- Create: `apps/electron/src/main/lib/server-ops/server-ops-agent-facade.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-agent-facade.test.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-permission-service.ts`
- Modify: `apps/electron/src/main/lib/agent-permission-service.test.ts`

- [x] **Step 1: Write failing facade, tool and permission tests**

Prove tools are present only for ordinary user-visible sessions; automation, delegation and external runs cannot register or execute them; no-access calls return `SERVER_OPS_AGENT_ACCESS_REQUIRED`; list/status results omit `credentialRef`; Host Key confirmation is not exposed; and read-only commands are distinguished from high-risk commands that cannot be permanently allowed.

- [x] **Step 2: Run focused tests and verify RED**

Run: `bun test apps/electron/src/main/lib/server-ops/server-ops-agent-facade.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/agent-permission-service.test.ts`

Expected: FAIL because the facade, tools and policy do not exist.

- [x] **Step 3: Implement the credential-safe facade and tool definitions**

The facade captures the real session ID and normalized run source outside model input, checks both the memory Store and current user-visible session on every call, returns public DTOs, and delegates connect/status/exec/disconnect to the shared Connection Service. Add `buildServerOpsTools()` to `buildPiBuiltinTools()` only when the Orchestrator supplies the already initialized facade. Never expose `confirmHostKey`.

- [x] **Step 4: Implement remote command permission classification**

Auto-allow list/status/connect/disconnect and an explicit narrow read-only command grammar. Route all other `server_exec` calls to per-use approval. Set `allowAlways: false` in the request builder and independently refuse to add `server_exec` to a session whitelist; test that a forged `alwaysAllow: true` response cannot authorize the next call.

- [x] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2 and expect PASS.

### Task 5: Add the Server Ops toolbar authorization toggle

**Files:**
- Modify: `apps/electron/src/renderer/atoms/server-ops-atoms.ts`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`

- [x] **Step 1: Write failing Renderer tests**

Cover current session and host lookup, disconnected-but-authorizable state, grant/revoke loading state, `aria-pressed`, tooltip text, host/session switching and disconnect reset.

- [x] **Step 2: Run the Renderer test and verify RED**

Run: `bun test apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`

Expected: FAIL because no authorization control exists.

- [x] **Step 3: Implement the Jotai projection and toolbar control**

Read access from preload whenever `sessionId` or `hostId` changes. Use the existing icon button, Tooltip, theme tokens, disabled/loading patterns and Toast handling. Keep the main-process Store authoritative.

- [x] **Step 4: Run the Renderer test and verify GREEN**

Run the command from Step 2 and expect PASS.

### Task 6: Add bounded Agent audit records

**Files:**
- Create: `apps/electron/src/main/lib/server-ops/server-ops-audit-store.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-audit-store.test.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-agent-facade.ts`
- Modify: `packages/shared/src/types/server-ops.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`

- [x] **Step 1: Write failing audit tests**

Cover connect/exec/disconnect records, secret pattern redaction before 512-character truncation, omission of credentials and command output, 5000-record rotation, corrupt/unknown-version recovery, preflight fail-closed behavior, and a post-result audit warning that preserves the real remote result.

- [x] **Step 2: Run the audit test and verify RED**

Run: `bun test apps/electron/src/main/lib/server-ops/server-ops-audit-store.test.ts apps/electron/src/main/lib/server-ops/server-ops-agent-facade.test.ts`

Expected: FAIL because no audit Store exists.

- [x] **Step 3: Implement safe bounded audit persistence**

Use the repository safe-file atomic helper for a bounded versioned JSON snapshot. Record only public IDs, redacted operation metadata, result code and timing. Inject the Store into the facade and fail before a remote operation if the audit start record cannot be persisted. If result persistence fails after the remote action, preserve the actual result and attach `SERVER_OPS_AUDIT_RESULT_WRITE_FAILED`. Add a read-only list IPC/preload method and render the real records in the existing Audit tab with server and operation filters.

- [x] **Step 4: Run the audit tests and verify GREEN**

Run the command from Step 2 and expect PASS.

### Task 7: Regression, security and visual verification

**Files:**
- Modify: `MEMORY.md`

- [x] **Step 1: Run all Server Ops and Agent permission tests**

Run: `bun test packages/shared/src/types/server-ops.test.ts apps/electron/src/main/lib/server-ops apps/electron/src/utility/server-ops apps/electron/src/renderer/components/server-ops apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/agent-permission-service.test.ts`

Expected: PASS.

- [x] **Step 2: Run repository typecheck**

Run: `bun run typecheck`

Expected: PASS.

- [x] **Step 3: Build Electron**

Run: `bun run electron:build`

Expected: PASS and the utility process contains the new exec protocol.

- [x] **Step 4: Inspect for credential leakage**

Search the changed Agent tool results, audit DTOs and fixtures for passwords, private-key values and `credentialRef`; expect no secret-bearing field in public output.

- [x] **Step 5: Run the real Proma Dev visual smoke test**

Open a normal Agent session and Server Ops right pane. Verify the authorization icon in dark and light themes, keyboard focus, disconnected disabled state, host switching reset, revoke behavior and no overlap at narrow pane widths.

- [x] **Step 6: Update project memory**

Record the temporary authorization model, credential-safe main-process facade, non-PTY exec contract, approval split and resource limits without recording any credential value.

Verification record (2026-09-05): the complete Server Ops and Agent integration suite passed with 271 tests and 0 failures, including the real loopback SSH fixture for Host Key confirmation, password authentication and interactive PTY; all seven workspaces passed typecheck. The Electron build completed after directing the macOS compiler module cache to `/private/tmp`, and the generated main/utility bundles contain the exec request, exec result and session-revoke protocol identifiers. Credential-literal scanning matched only synthetic test fixtures and no production file. Proma Dev was previously inspected in dark and light themes at normal and narrow pane widths. Keyboard focus reached the authorization toggle, the audit empty/filter/refresh states rendered correctly, the Canvas-style server drawer opened and closed with `Escape`, and a temporary authorization was granted then revoked without connecting to the real server. The saved host list contained one server, so host-switch reset remained covered by the executable Renderer test instead of mutating real host assets. The latest safety-only follow-up could not repeat the GUI smoke test because macOS was locked; its UI and lifecycle behavior remains covered by executable Renderer and AppShell tests.
