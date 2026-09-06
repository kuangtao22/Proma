# Server Ops Saved Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make server credentials configurable and securely persisted from the add/edit server dialog, with direct connect as the normal path.

**Architecture:** Keep public host assets and encrypted credentials as separate stores. Add an exact-key save request that pairs a secret-free host payload with an explicit keep/replace/clear credential mutation; let the main-process IPC registrar coordinate both stores while Renderer only holds transient form values.

**Tech Stack:** Bun, TypeScript, Electron `safeStorage`, React, Jotai, Radix/shadcn, Tailwind CSS, Bun test.

---

### Task 1: Define the save contract

**Files:**
- Modify: `packages/shared/src/types/server-ops.ts`
- Test: `packages/shared/src/types/server-ops.test.ts`

- [x] **Step 1: Write failing contract tests**

Add cases proving a save request accepts a password replacement, accepts `keep` for an existing host, rejects extra fields, rejects `keep` for a new password/private-key host, and rejects a credential kind that differs from `host.authMethod`.

```ts
expect(parseServerOpsSaveHostInput({
  host: { name: '生产 API', address: '10.0.0.8', port: 22, username: 'deploy', authMethod: 'password', tags: [] },
  credentialUpdate: { action: 'replace', credential: { kind: 'password', password: 'secret-canary' } },
})).toMatchObject({ credentialUpdate: { action: 'replace' } })
```

- [x] **Step 2: Run the test and verify RED**

Run: `bun test packages/shared/src/types/server-ops.test.ts`

Expected: FAIL because `parseServerOpsSaveHostInput` and its types do not exist.

- [x] **Step 3: Add exact-key types and parser**

Define `ServerOpsSavedCredentialInput`, `ServerOpsCredentialUpdate`, `ServerOpsSaveHostInput`, and `parseServerOpsSaveHostInput()`. Reuse the existing secret length rules without adding `remember`; preserve `parseServerOpsHostInput()` as the secret-free asset parser.

- [x] **Step 4: Run the contract test and verify GREEN**

Run: `bun test packages/shared/src/types/server-ops.test.ts`

Expected: PASS.

### Task 2: Coordinate host and credential persistence

**Files:**
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-ipc.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Test: `apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts`

- [x] **Step 1: Write failing IPC tests**

Cover these observable sequences:

```ts
expect(calls).toEqual([
  'upsert:生产 API',
  'remember:host-1:password',
  'set-ref:host-1:credential-1',
])
```

Also cover `keep`, `clear`, authentication-method changes, and rejection of a raw top-level `password` field.

- [x] **Step 2: Run the IPC test and verify RED**

Run: `bun test apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts`

Expected: FAIL because the registrar only accepts a secret-free host input and its credential contract only exposes deletion.

- [x] **Step 3: Implement the coordinator**

Extend the host contract with `setCredentialRef()` and the credential contract with `remember()` plus `forgetHost()`. Parse with `parseServerOpsSaveHostInput()`, persist replacements through `ServerOpsCredentialStore.remember()`, bind the returned reference through `ServerOpsHostStore.setCredentialRef()`, and clear obsolete credentials for `clear` or changed authentication methods.

- [x] **Step 4: Run IPC and store tests and verify GREEN**

Run: `bun test apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts apps/electron/src/main/lib/server-ops/server-ops-host-store.test.ts apps/electron/src/main/lib/server-ops/server-ops-credential-store.test.ts`

Expected: PASS with no secret in serialized public events or hosts.

### Task 3: Expose the new narrow preload contract

**Files:**
- Modify: `apps/electron/src/preload/index.ts`

- [x] **Step 1: Change the preload input type**

Replace the `ServerOpsUpsertHostInput` argument of `upsertServerOpsHost` with `ServerOpsSaveHostInput`; keep the return type `Promise<ServerOpsHost>` and the existing IPC channel.

- [x] **Step 2: Verify the four-layer contract compiles**

Run: `bun run typecheck`

Expected: Renderer call sites fail until Task 4 supplies the new request shape; no unrelated type failures are introduced.

### Task 4: Move credential editing into the server dialog

**Files:**
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsHostDialog.tsx`
- Create: `apps/electron/src/renderer/components/server-ops/ServerOpsHostDialog.test.tsx`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx`
- Test: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`

- [x] **Step 1: Write failing dialog tests**

Render the dialog for password, private-key, SSH Agent, and existing-credential hosts. Assert conditional labels and safe status text:

```ts
expect(passwordHtml).toContain('SSH 密码')
expect(privateKeyHtml).toContain('私钥文件')
expect(savedHtml).toContain('凭据已保存')
expect(savedHtml).not.toContain('password-canary')
```

- [x] **Step 2: Run the Renderer tests and verify RED**

Run: `bun test apps/electron/src/renderer/components/server-ops/ServerOpsHostDialog.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`

Expected: FAIL because credentials are still collected only by `ServerOpsConnectDialog`.

- [x] **Step 3: Implement grouped credential fields**

Use the existing `Dialog`, `Input`, `Select`, `Button`, and theme tokens. Initialize existing password/private-key hosts to `keep`, new hosts to `replace`, and SSH Agent to `clear`. Do not decrypt existing secrets; display a compact saved-status row with explicit replace and clear actions. Submit `ServerOpsSaveHostInput`.

- [x] **Step 4: Make direct connect the default**

When `selectedHost.authMethod === 'ssh-agent'` or `selectedHost.credentialRef` exists, call `connectServerOpsHost()` immediately. Open `ServerOpsConnectDialog` only when credentials are absent or the direct attempt returns a credential-related error. Keep Host Key confirmation and blocking dialogs unchanged.

- [x] **Step 5: Run Renderer tests and verify GREEN**

Run: `bun test apps/electron/src/renderer/components/server-ops/ServerOpsHostDialog.test.tsx apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`

Expected: PASS.

### Task 5: Regression and security verification

**Files:**
- Modify: `MEMORY.md`

- [x] **Step 1: Run all Server Ops tests**

Run: `bun test packages/shared/src/types/server-ops.test.ts apps/electron/src/main/lib/server-ops apps/electron/src/renderer/components/server-ops apps/electron/src/utility/server-ops`

Expected: PASS.

- [x] **Step 2: Run repository typecheck**

Run: `bun run typecheck`

Expected: PASS.

- [x] **Step 3: Build Electron**

Run: `bun run electron:build`

Expected: PASS and the SSH utility runtime remains packaged.

- [x] **Step 4: Inspect for secret leakage**

Run: `rg -n "password-canary|private-key-canary" ~/.proma/server-ops/hosts.json apps/electron/dist packages/shared/dist`

Expected: no matches in public host assets or build output fixtures.

- [x] **Step 5: Update project memory**

Record the approved decision: server credentials are configured and saved with the server entity, direct connect is normal, fallback login is exceptional, and safe storage remains fail closed. Do not record credential values.
