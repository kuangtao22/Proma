# Canvas Agent Workflow Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an ordinary Proma Agent configure and run Canvas Agent nodes, then explicitly execute the bounded downstream workflow reachable through valid Canvas data edges without bypassing model, Skill, image-cost, or adoption boundaries.

**Architecture:** The ordinary Agent remains the only orchestrator. A main-process Canvas Agent execution service unifies Renderer-manual and parent-orchestrated runs, an immutable output pointer projects the accepted Agent response into the graph, and a bounded DAG scheduler runs only the requested reachable subgraph. Node-specific capability adapters preserve the existing document, WebView, image, and Agent sources of truth instead of turning Canvas into a generic JSON executor.

**Tech Stack:** Bun, TypeScript, Electron main process, Pi Agent Runtime, TypeBox, Jotai-compatible shared Canvas contracts, native stable-directory helper (macOS/Windows), Bun test.

---

## Change Boundaries

- Ordinary Agent gains `canvas_update_agent_config`, `canvas_run_agent`, and `canvas_run_workflow`.
- `canvas_run_nodes` remains the low-level explicit image runner and does not start Agent nodes.
- Canvas Agent nodes cannot recursively invoke Agent/workflow orchestration tools. Parent-orchestrated Canvas Agents also cannot invoke image generation.
- Documents and WebViews remain versioned artifacts, not model executors. Images remain candidate-first and advance downstream only after explicit adoption.
- No new Renderer keyword routing, polling loop, database, full workflow-run persistence, or application-restart resume is introduced.
- All graph work is bounded and starts only after an explicit tool call. The idle application has no new scans, timers, or listeners.

### Task 1: Add strict shared output and workflow contracts

**Files:**
- Modify: `packages/shared/src/types/canvas.ts`
- Modify: `packages/shared/src/types/canvas.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-store.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-store.test.ts`

- [ ] **Step 1: Write failing exact-key parser tests**

Cover:

- a schema-v4 Agent node with and without `outputPointer`;
- UUID, lowercase SHA-256, and non-negative `completedAt` validation;
- rejection of unknown pointer and node fields;
- strict `CanvasRunWorkflowInput` parsing, including unique start IDs and `maxImageRuns` in `0..16`;
- bounded public `CanvasRunAgentResult` and `CanvasRunWorkflowResult` shapes that do not expose session IDs, asset IDs, paths, raw exceptions, or full logs.

Use the following public contracts:

```ts
/** Canvas Agent 当前正式输出在内部消息日志中的不可变引用。 */
export interface CanvasAgentOutputPointer {
  messageUuid: string
  contentSha256: string
  completedAt: number
}

export interface CanvasAgentNode extends CanvasNodeBase {
  kind: 'agent'
  agentSessionId: string
  outputPointer?: CanvasAgentOutputPointer
  // 现有互斥 never 字段保持不变。
}

export interface CanvasRunWorkflowInput {
  canvasId: string
  expectedRevision: number
  startNodeIds: string[]
  goal: string
  maxImageRuns: number
}

export type CanvasWorkflowStatus =
  | 'completed'
  | 'partial'
  | 'waiting-review'
  | 'failed'
  | 'cancelled'

export type CanvasWorkflowNodeStatus =
  | 'satisfied'
  | 'started'
  | 'completed'
  | 'waiting-review'
  | 'waiting-approval'
  | 'blocked'
  | 'failed'
  | 'cancelled'
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts
```

Expected: FAIL because the output pointer, workflow contracts, and parsers do not exist.

- [ ] **Step 3: Implement contracts without bumping the Canvas schema**

Keep `CANVAS_DOCUMENT_VERSION = 4`. Update `parseCanvasNode()` so an Agent node accepts exactly either:

```ts
[...baseKeys, 'agentSessionId']
[...baseKeys, 'agentSessionId', 'outputPointer']
```

Rebuild the pointer through `parseCanvasAgentOutputPointer()` rather than returning the persisted object. Add exact-key parsers for all new external inputs and public results. Bound `goal`, summaries, node counts, and error text before they cross the tool boundary.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2 and expect PASS.

- [ ] **Step 5: Commit the shared contract slice**

```bash
git add packages/shared/src/types/canvas.ts packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-store.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts
git commit -m "功能：新增画布工作流与Agent输出合同"
```

### Task 2: Extend the stable-directory protocol for Agent configs

**Files:**
- Modify: `apps/electron/src/main/lib/stable-directory-native-host.ts`
- Modify: `apps/electron/src/main/lib/stable-directory-native-host.test.ts`
- Modify: `apps/electron/native/stable-directory/stable-directory-helper.cc`
- Modify: `apps/electron/scripts/build-stable-directory-native.test.ts`

- [ ] **Step 1: Write failing host and native-contract tests**

Prove that:

- `agent-configs` is accepted for `canvas-content-read`, `canvas-content-write`, and `canvas-content-list`;
- only `config.json` may be read or written under `agent-configs/<nodeId>/`;
- `agent-configs` cannot participate in `canvas-content-move` or trash-marker removal;
- invalid IDs, extra path segments, symlinks/reparse points, hard links, oversized content, and post-open identity changes fail closed on macOS and Windows paths;
- existing `nodes`, `trash`, and `revisions` behavior remains unchanged.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/electron/src/main/lib/stable-directory-native-host.test.ts apps/electron/scripts/build-stable-directory-native.test.ts
```

Expected: FAIL because `StableDirectoryCanvasChild` and the native allowlist do not include `agent-configs`.

- [ ] **Step 3: Add the fixed managed root**

Change the TypeScript boundary to:

```ts
/** Canvas helper 可读写和列举的固定一级目录。 */
export type StableDirectoryCanvasChild =
  | 'nodes'
  | 'trash'
  | 'revisions'
  | 'agent-configs'

/** 只有内容节点参与 nodes/trash 生命周期移动。 */
export type StableDirectoryCanvasMoveChild = 'nodes' | 'trash'
```

Mirror the same fixed allowlist in both POSIX and Windows branches of `stable-directory-helper.cc`. Do not accept a generic relative directory from the caller. Keep the existing 256 KiB helper ceiling; the Agent config Store will enforce the smaller business limits.

- [ ] **Step 4: Run tests and build the helper**

Run:

```bash
bun test apps/electron/src/main/lib/stable-directory-native-host.test.ts apps/electron/scripts/build-stable-directory-native.test.ts
bun apps/electron/scripts/build-stable-directory-native.ts
```

Expected: tests PASS and the helper compiles for the current platform.

- [ ] **Step 5: Commit the stable-directory slice**

```bash
git add apps/electron/src/main/lib/stable-directory-native-host.ts apps/electron/src/main/lib/stable-directory-native-host.test.ts apps/electron/native/stable-directory/stable-directory-helper.cc apps/electron/scripts/build-stable-directory-native.test.ts
git commit -m "功能：支持画布Agent配置受管目录"
```

### Task 3: Implement the Canvas Agent Config Store

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-agent-config-store.ts`
- Create: `apps/electron/src/main/lib/design/canvas-agent-config-store.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: Write failing Store tests**

Cover:

- missing file returns revision `0`, empty instruction/Skills, and inherited model selection without writing disk;
- exact-key parsing and identity checks for `projectId + canvasId + nodeId`;
- an 8 KiB instruction limit, at most 16 unique stable Skill names, and bounded IDs;
- partial patch preserves unspecified fields;
- `channelId: null` forces `modelId: null`;
- changing channel while retaining a model is rejected unless the patch explicitly supplies the valid model or `modelId: null`;
- graph revision and config revision conflicts both fail before write;
- installed/enabled Skills and explicit model selection are checked on save;
- native authorization revocation, corrupt JSON, uncertain durability, and read-after-write reconciliation fail safely.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-agent-config-store.test.ts
```

Expected: FAIL because the Store does not exist.

- [ ] **Step 3: Implement the bounded Store**

Use this persistent contract:

```ts
/** Canvas Agent 可重复执行的长期配置，不包含任何授权事实。 */
export interface CanvasAgentConfig {
  schemaVersion: 1
  projectId: string
  canvasId: string
  nodeId: string
  revision: number
  instruction: string
  skillNames: string[]
  channelId: string | null
  modelId: string | null
  updatedAt: number
}
```

Expose only:

```ts
export interface CanvasAgentConfigStore {
  load: (target: CanvasAgentTarget) => Promise<CanvasAgentConfig>
  update: (input: UpdateCanvasAgentConfigInput) => Promise<CanvasAgentConfig>
}
```

For every operation, call `CanvasDocumentStore.loadWithDirectoryCapability()`, open `agent-configs`, and use the native helper with fixed `entryId=nodeId` and `fileName='config.json'`. Validate the graph node is still the matching Agent before reading or writing. Inject `getWorkspaceSkills()` and model-validation functions so tests do not depend on global configuration.

- [ ] **Step 4: Wire one production instance**

Create the Store beside the existing Canvas stores in `apps/electron/src/main/ipc.ts`. Reuse the same `canvasDocumentStore`; do not create a second document store or serializer.

- [ ] **Step 5: Run the Store test and typecheck**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-agent-config-store.test.ts
bun run typecheck
```

Expected: Store test PASS. Typecheck may still expose unwired downstream dependencies that later tasks intentionally complete; record only those exact errors.

- [ ] **Step 6: Commit the Config Store slice**

```bash
git add apps/electron/src/main/lib/design/canvas-agent-config-store.ts apps/electron/src/main/lib/design/canvas-agent-config-store.test.ts apps/electron/src/main/ipc.ts
git commit -m "功能：持久化画布Agent职责与Skills配置"
```

### Task 4: Add a node capability registry and project it through `canvas_read`

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-node-capability-registry.ts`
- Create: `apps/electron/src/main/lib/design/canvas-node-capability-registry.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`

- [ ] **Step 1: Write failing capability tests**

Prove the registry derives, rather than persists, capabilities for all current node kinds:

```ts
export type CanvasNodeCapability =
  | 'read'
  | 'update-config'
  | 'update-content'
  | 'run'
  | 'review-required'
```

Expected examples:

- Agent: `read`, `update-config`, `run`;
- image: `read`, `update-config`, `run`, `review-required`;
- document/WebView: `read`, `update-content`;
- an unavailable/corrupt node never gains a run capability.

Also prove that capability strings returned by `canvas_read` do not authorize another operation; each tool still performs its own Host-side checks.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-node-capability-registry.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts
```

Expected: FAIL because no capability projection exists.

- [ ] **Step 3: Implement and inject the registry**

Expose a small state-derived API:

```ts
export interface CanvasNodeCapabilityRegistry {
  list: (node: CanvasNode, state: CanvasNodeCapabilityState) => CanvasNodeCapability[]
  assert: (node: CanvasNode, capability: CanvasNodeCapability) => void
}
```

Add `capabilities` to each `canvas_read` node entry. Do not add it to `CanvasNode` or persist it in `canvas.json`. Keep the existing 32 KiB response budget authoritative after capability projection.

- [ ] **Step 4: Run tests and verify GREEN**

Run the command from Step 2 and expect PASS.

- [ ] **Step 5: Commit the capability slice**

```bash
git add apps/electron/src/main/lib/design/canvas-node-capability-registry.ts apps/electron/src/main/lib/design/canvas-node-capability-registry.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts
git commit -m "功能：公开画布节点受控能力"
```

### Task 5: Centralize downstream dependency-state propagation

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-dependency-state-service.ts`
- Create: `apps/electron/src/main/lib/design/canvas-dependency-state-service.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-text-artifact-service.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-text-artifact-service.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: Lock current and desired propagation behavior with failing tests**

Cover two pure operations:

```ts
interface CanvasDependencyStateService {
  consumeAndPropagate: (input: {
    document: CanvasDocument
    producerNodeIds: string[]
    changedAt: number
  }) => { nodes: CanvasNode[]; downstreamNodeIds: string[] }
}
```

Tests must prove:

- the producer's current `upstreamChange` is removed after a new formal output is committed;
- only direct `bound` `reference`, `depends-on`, and `derives` edges propagate;
- `association`, `unresolved`, `incompatible`, dangling, and reverse edges do not propagate;
- multiple changed producers merge and sort source IDs without overwriting older pending sources;
- image candidate creation does not propagate, image adoption does;
- document/WebView update and historical-revision adoption propagate only after their graph revision commits.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-dependency-state-service.test.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts apps/electron/src/main/lib/design/canvas-text-artifact-service.test.ts
```

Expected: FAIL because image propagation is private and text commits do not use the common service.

- [ ] **Step 3: Implement the pure projection and one commit boundary**

Move `isPropagatingCanvasEdge()` and downstream aggregation out of `canvas-image-candidate-batch-service.ts`. Keep projection pure; the caller must commit its producer update and downstream invalidations together through the existing Canvas serializer and workspace write lease.

Extend `CanvasTextArtifactGraphWriter.commit()` to apply the dependency projection in the same mutation/batch transaction as the adopted `contentRevision`. Preserve existing revision reconciliation and publication behavior.

- [ ] **Step 4: Wire image adoption to the common service**

Replace the duplicated candidate-batch projection with the new service while preserving:

- the adoption intent hash;
- crash reconciliation;
- no automatic candidate adoption;
- current batch publication and stable error codes.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2 and expect PASS.

- [ ] **Step 6: Commit the dependency-state slice**

```bash
git add apps/electron/src/main/lib/design/canvas-dependency-state-service.ts apps/electron/src/main/lib/design/canvas-dependency-state-service.test.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.ts apps/electron/src/main/lib/design/canvas-image-candidate-batch-service.test.ts apps/electron/src/main/lib/design/canvas-text-artifact-service.ts apps/electron/src/main/lib/design/canvas-text-artifact-service.test.ts apps/electron/src/main/ipc.ts
git commit -m "重构：统一画布正式产物依赖传播"
```

### Task 6: Resolve and commit formal Canvas Agent output

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-agent-output-service.ts`
- Create: `apps/electron/src/main/lib/design/canvas-agent-output-service.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: Write failing output-selection and integrity tests**

Cover:

- selecting the last non-empty completed assistant message produced by the current run;
- concatenating only text blocks in order;
- refusing partial messages, errored messages, messages without UUID, replayed old output, and empty text;
- storing SHA-256 over the exact UTF-8 content;
- reading only by `node.agentSessionId + messageUuid + contentSha256`;
- rejecting missing UUID, owner mismatch, and hash mismatch as `CANVAS_AGENT_OUTPUT_INVALID`;
- no valid completion as `CANVAS_AGENT_OUTPUT_MISSING` without replacing an old pointer;
- successful commit clears the current node's pending upstream state and marks only valid direct downstream nodes;
- a stale run generation cannot overwrite a newer pointer.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-agent-output-service.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts
```

Expected: FAIL because Agent nodes currently read as empty content and have no formal output commit path.

- [ ] **Step 3: Implement the output service**

Use `getAgentSessionSDKMessages()` through an injected dependency and keep the node pointer small:

```ts
export interface CanvasAgentOutputService {
  resolveCompletedOutput: (input: CanvasAgentCompletionInput) => CanvasResolvedAgentOutput
  commit: (input: CanvasAgentOutputCommitInput) => Promise<CanvasAgentOutputCommitResult>
  read: (target: CanvasAgentTarget) => Promise<string>
}
```

The commit must run through the shared Canvas serializer/workspace lease, fresh-read the node/session owner, compare the run generation, apply `outputPointer`, and reuse `CanvasDependencyStateService`. Broadcast only after the atomic graph fact is visible.

- [ ] **Step 4: Make `canvas_read` return verified Agent output**

Inject `agentOutputs.read()` as the authoritative Agent branch instead of treating every non-text node as empty content. Feed the result through the existing `applyCanvasReadBudget()` logic and never fall back to the latest arbitrary session message or node title.

- [ ] **Step 5: Run tests and verify GREEN**

Run the command from Step 2 and expect PASS.

- [ ] **Step 6: Commit the formal output slice**

```bash
git add apps/electron/src/main/lib/design/canvas-agent-output-service.ts apps/electron/src/main/lib/design/canvas-agent-output-service.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/ipc.ts
git commit -m "功能：固化并读取画布Agent正式输出"
```

### Task 7: Unify Renderer-manual and parent-orchestrated Agent execution

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-agent-execution-service.ts`
- Create: `apps/electron/src/main/lib/design/canvas-agent-execution-service.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-agent-run-policy.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-agent-run-policy.test.ts`
- Modify: `apps/electron/src/main/lib/agent-headless-runner-registry.ts`
- Create: `apps/electron/src/main/lib/agent-headless-runner-registry.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: Write failing shared-execution tests**

Prove both modes execute the same trusted lifecycle:

1. reconcile the Canvas and validate the Agent owner;
2. load and validate config, model, and enabled Skills;
3. inject only direct `bound` input references;
4. reserve the session before starting Pi;
5. wait for success/error/cancel terminal state;
6. commit formal output only on valid success;
7. always release reservations and listeners.

Mode-specific assertions:

- `renderer-manual` retains current visible-stream behavior, current controlled Canvas tools, approval behavior, and STOP IPC;
- `parent-orchestrated` runs without a mounted workbench, sets `source: 'design'`, reports to the parent session route, and never needs Renderer IPC;
- parent cancellation calls `stopRegisteredAgent()` only for the exact child run it owns;
- busy, stop, error, empty output, config conflict, disabled Skill/model, and late completion do not update the output pointer.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-agent-execution-service.test.ts apps/electron/src/main/lib/design/canvas-agent-run-policy.test.ts apps/electron/src/main/lib/agent-headless-runner-registry.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts
```

Expected: FAIL because SEND contains its own execution path and the registered headless runner cannot receive extensions.

- [ ] **Step 3: Extend the headless runner registry without breaking callers**

Change the optional third argument only:

```ts
export type HeadlessAgentRunner = (
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
  extensions?: AgentRunExtensions,
) => Promise<void>

export function runRegisteredHeadlessAgent(
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
  extensions?: AgentRunExtensions,
): Promise<void>
```

Existing Feishu, automation, and collaboration callers remain source-compatible. The registry still owns no Canvas imports.

- [ ] **Step 4: Implement the common execution service**

Use a discriminated request:

```ts
export type CanvasAgentExecutionRequest =
  | CanvasRendererManualAgentExecutionRequest
  | CanvasParentOrchestratedAgentExecutionRequest
```

Encode titles, instructions, goals, and upstream data as bounded JSON data blocks inside the system prompt. Resolve persistent and per-run Skills against current active workspace Skills, de-duplicate them in stable order, and pass the resulting slugs through `AgentSendInput.mentionedSkills`.

For inherited routing, fresh-read the internal session's channel/model. For explicit config, validate the full `channelId + modelId` combination again at run time. Do not let a Skill or request choose the tool allowlist.

- [ ] **Step 5: Replace only the SEND business body**

Keep `GET_AGENT_MESSAGES` and `STOP_AGENT` IPC contracts. Replace the inline SEND sequence in `canvas-document-ipc.ts` with `canvasAgentExecution.execute({ mode: 'renderer-manual', ... })`. Preserve the current safe `{ ok: false, SESSION_BUSY }` envelope and authorized sender checks.

- [ ] **Step 6: Run tests and verify GREEN**

Run the command from Step 2 and expect PASS.

- [ ] **Step 7: Commit the unified execution slice**

```bash
git add apps/electron/src/main/lib/design/canvas-agent-execution-service.ts apps/electron/src/main/lib/design/canvas-agent-execution-service.test.ts apps/electron/src/main/lib/design/canvas-agent-run-policy.ts apps/electron/src/main/lib/design/canvas-agent-run-policy.test.ts apps/electron/src/main/lib/agent-headless-runner-registry.ts apps/electron/src/main/lib/agent-headless-runner-registry.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/ipc.ts
git commit -m "重构：统一画布Agent手动与编排运行"
```

### Task 8: Add ordinary-Agent config and single-Agent run tools

**Files:**
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: Write failing tool-provider tests**

Cover:

- `CANVAS_TOOL_NAMES` includes `canvas_update_agent_config` and `canvas_run_agent`;
- config patch requires graph and config revisions, preserves omitted fields, and cannot change session ownership;
- Agent run requires execute mode and accepts `canvasId`, `nodeId`, `expectedRevision`, bounded `instruction`, and optional temporary Skill slugs;
- the run waits for terminal state and returns only node ID, status, pointer, affected downstream IDs, and a bounded output summary;
- `canvas_run_agent` never starts downstream nodes or image jobs;
- both new tools fresh-read the current binding before work;
- neither tool is exposed to a Canvas Agent in either execution mode;
- Renderer-manual keeps the previous Canvas tool set; parent-orchestrated also excludes `canvas_run_nodes`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts
```

Expected: FAIL because the tools and runtime dependencies do not exist.

- [ ] **Step 3: Add dedicated dependencies to the provider**

Extend `CanvasToolProviderDependencies` and `CanvasToolProviderRuntime` with narrow interfaces:

```ts
agentConfigs: Pick<CanvasAgentConfigStore, 'load' | 'update'>
agentExecution: Pick<CanvasAgentExecutionService, 'execute'>
```

Do not call Renderer IPC or recursively invoke another Pi tool. Pass the `AbortSignal` received by the custom tool directly to `agentExecution.execute()`.

- [ ] **Step 4: Implement tool schemas and trusted-mode filtering**

`canvas_update_agent_config` performs no model execution and no media work. `canvas_run_agent` uses `mode: 'parent-orchestrated'` and the parent run identity from `CanvasToolRunContext`; model-supplied parameters cannot override project ID, parent session ID, run start time, or tool-call ID.

Build the available tool list from trusted context:

```ts
const isCanvasAgent = context.canvasAgentTarget !== undefined
const isParentOrchestrated = context.canvasAgentMode === 'parent-orchestrated'
```

All Canvas Agents lose the two ordinary-Agent orchestration/config tools. Both Canvas modes continue to lose `canvas_manage` and `canvas_create_agent`; parent-orchestrated mode additionally loses `canvas_run_nodes`. Keep image-generation tools and approvals unchanged for ordinary Agents.

- [ ] **Step 5: Run tests and verify GREEN**

Run the command from Step 2 and expect PASS.

- [ ] **Step 6: Commit the ordinary-Agent tool slice**

```bash
git add apps/electron/src/main/lib/design/canvas-tool-provider.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/ipc.ts
git commit -m "功能：允许普通Agent配置并运行画布Agent"
```

### Task 9: Extract the reusable image-run service

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-image-run-service.ts`
- Create: `apps/electron/src/main/lib/design/canvas-image-run-service.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: Move current behavior into characterization tests**

Copy the existing `runCanvasNodes()` scenarios into service tests before moving code. Lock:

- all-image preflight before any journal creation;
- deterministic batch/job IDs from parent run and tool-call identity;
- rollback of newly created journals only;
- reuse of existing journals without duplicate model cost;
- candidate-batch registration before job start;
- waiting for a known batch through scoped Job Manager change events without polling;
- abort/deadline cleanup removes the temporary event listener and cancels only this call's active Job IDs;
- non-image targets return existing `idle` behavior for the low-level tool;
- result details never expose asset IDs.

- [ ] **Step 2: Run characterization tests and verify RED**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-image-run-service.test.ts
```

Expected: FAIL because the service has not been extracted.

- [ ] **Step 3: Extract, do not rewrite, the production implementation**

Expose:

```ts
export interface CanvasImageRunService {
  run: (
    context: CanvasToolRunContext,
    target: CanvasTarget,
    nodes: CanvasNode[],
    operationId: string,
  ) => Promise<CanvasRunNodesResult>
  awaitBatch: (input: CanvasImageBatchWaitInput) => Promise<CanvasRunNodesBatchSummary>
  cancelTasks: (projectId: string, taskIds: readonly string[]) => Promise<void>
}
```

Move preflight, journal creation, candidate-batch creation, rollback, and start logic from `registerCanvasDocumentIpcHandlers()` into this service. Inject the existing serializer, workspace guard, image module Store, Job Manager, candidate service, and read-only reason lookup. `awaitBatch()` installs a listener only for the active batch, reloads the bounded batch summary after relevant Job changes, and always unsubscribes on success, failure, cancellation, or deadline. `cancelTasks()` revalidates ownership and calls the existing Job Manager cancellation boundary. Do not create a second Job Manager or image candidate Store.

- [ ] **Step 4: Rewire the low-level tool and runtime**

Both `canvas_run_nodes` and the future workflow service must call this same main-process service. Keep the current `CanvasToolProviderRuntime.runNodes` adapter temporarily if needed for a small diff, but make it delegate directly to `canvasImageRunService.run()`.

- [ ] **Step 5: Run focused regression tests**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-image-run-service.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts
```

Expected: PASS with unchanged low-level image behavior.

- [ ] **Step 6: Commit the extraction slice**

```bash
git add apps/electron/src/main/lib/design/canvas-image-run-service.ts apps/electron/src/main/lib/design/canvas-image-run-service.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/ipc.ts
git commit -m "重构：抽取画布图片统一运行服务"
```

### Task 10: Build a pure bounded workflow graph planner

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-workflow-graph.ts`
- Create: `apps/electron/src/main/lib/design/canvas-workflow-graph.test.ts`

- [ ] **Step 1: Write failing graph-planner tests**

Cover:

- one or multiple Agent roots and only their reachable descendants;
- `association` ignored for reachability and dependencies;
- only `bound` data edges enter adjacency and indegree;
- unresolved, incompatible, dangling, or duplicate executable edges in the reachable scope fail before side effects;
- topological layers require all direct upstream nodes;
- cycle detection;
- maximum 32 reachable nodes, 8 Agent nodes, and dependency depth 8;
- stable node/edge ordering independent of JSON input order;
- existing formal Agent output, adopted image, and committed text revisions become `satisfied` when they have no `upstreamChange`;
- roots run once, and downstream Agent/image nodes without formal output or with `upstreamChange` become executable;
- required images beyond the approved count are marked `waiting-approval`, while invalid `maxImageRuns` fails parsing.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-workflow-graph.test.ts
```

Expected: FAIL because the pure planner does not exist.

- [ ] **Step 3: Implement the O(nodes + edges) planner**

Expose a deterministic plan with no services or side effects:

```ts
export interface CanvasWorkflowGraphPlan {
  rootNodeIds: string[]
  reachableNodeIds: string[]
  executableNodeIds: string[]
  dependenciesByNodeId: ReadonlyMap<string, readonly string[]>
  downstreamByNodeId: ReadonlyMap<string, readonly string[]>
  depthByNodeId: ReadonlyMap<string, number>
  initialStates: ReadonlyMap<string, CanvasWorkflowNodeStatus>
}
```

Create the node map and both adjacency maps once. Use `resolveCanvasEdgeBinding()` as the only port compatibility authority. Keep artifact-state classification delegated to the capability registry so future node types add an adapter rather than another scheduler branch.

- [ ] **Step 4: Run tests and verify GREEN**

Run the command from Step 2 and expect PASS.

- [ ] **Step 5: Commit the graph-planner slice**

```bash
git add apps/electron/src/main/lib/design/canvas-workflow-graph.ts apps/electron/src/main/lib/design/canvas-workflow-graph.test.ts
git commit -m "功能：新增有界画布工作流图预检"
```

### Task 11: Implement the bounded workflow scheduler and tool

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-workflow-execution-service.ts`
- Create: `apps/electron/src/main/lib/design/canvas-workflow-execution-service.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-tool-provider.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- Modify: `apps/electron/src/utility/agent-runtime-request-timeout.ts`
- Modify: `apps/electron/src/utility/agent-runtime-request-timeout.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: Write failing scheduler tests**

Cover the full orchestration behavior:

- stale initial revision, invalid graph, active workflow on the same Canvas, and busy root Agent fail before starting any node;
- roots and reachable stale Agent nodes execute once;
- document/WebView artifacts satisfy dependencies but never invoke a model;
- a node waits for every direct upstream to become `satisfied` or `completed`;
- at most two Canvas Agents run concurrently and at most eight start in one workflow;
- independent ready branches continue after one branch fails; only descendants receive a stable blocked reason;
- image nodes call `CanvasImageRunService` once with no more than `maxImageRuns` targets;
- the scheduler awaits the owned image batch terminal state through `CanvasImageRunService.awaitBatch()` rather than polling;
- candidate creation returns `waiting-review`, blocks descendants with `WAITING_FOR_IMAGE_ADOPTION`, and never adopts an asset;
- `maxImageRuns=0` and dynamically added images beyond approval return `waiting-approval` without model calls;
- after each Agent batch, the graph is fresh-read and valid new reachable nodes may join;
- deleting roots, replacing completed identities, changing executed edges, introducing cycles, or widening paid scope returns `CANVAS_WORKFLOW_GRAPH_CHANGED` for affected branches;
- a 15-minute deadline returns partial/cancelled results and stops owned active child Agents;
- parent `AbortSignal` cancels owned children, pending steps, and still-active owned image Jobs, but preserves committed outputs and already-created image candidates;
- Renderer reload has no effect because all state is in the main process;
- workflow completion removes the per-Canvas active-run lock in every terminal path.

- [ ] **Step 2: Run scheduler tests and verify RED**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-workflow-execution-service.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/utility/agent-runtime-request-timeout.test.ts
```

Expected: FAIL because no scheduler/tool exists and the utility timeout remains 120 seconds.

- [ ] **Step 3: Implement the in-memory bounded scheduler**

Use fixed constants:

```ts
const MAX_WORKFLOW_NODES = 32
const MAX_WORKFLOW_AGENTS = 8
const MAX_WORKFLOW_DEPTH = 8
const MAX_AGENT_CONCURRENCY = 2
const MAX_IMAGE_RUNS = 16
const WORKFLOW_TIMEOUT_MS = 15 * 60_000
```

The service owns a `Map<projectId\0canvasId, ActiveCanvasWorkflow>` only for live runs. It does not persist a plan or auto-resume after application restart. Queue readiness must be deterministic, and every external await must re-check cancellation, deadline, and graph validity before committing further side effects.

Use `Promise.allSettled()` for each ready Agent layer with a two-slot limiter. Call `CanvasAgentExecutionService` directly, not `canvas_run_agent`. Call `CanvasImageRunService.run()` and `awaitBatch()` directly, not `canvas_run_nodes`; on cancellation, call `cancelTasks()` with only this workflow's returned task IDs. This prevents recursive tool approvals, avoids timer polling, and preserves one parent cancellation chain.

- [ ] **Step 4: Add `canvas_run_workflow` to the provider**

The tool schema contains only:

```ts
{
  canvasId: string
  expectedRevision: number
  startNodeIds: string[]
  goal: string
  maxImageRuns: number
}
```

Bind project/session/run/tool identities from `CanvasToolRunContext`, require execute mode, fresh-read the linked Canvas, and pass the custom-tool `AbortSignal`. Add `canvas_run_workflow` to `singleApprovalToolNames` for ordinary Agents. The approval parameters shown to the user must include roots, goal, and image limit; there is no nested image approval inside this workflow.

Never expose `canvas_run_workflow` to either Canvas Agent mode.

- [ ] **Step 5: Extend only the two long-running tool timeouts**

Add:

```ts
export const CANVAS_EXECUTION_TOOL_TIMEOUT_MS = 15 * 60_000
const CANVAS_EXECUTION_TOOLS = new Set([
  'canvas_run_agent',
  'canvas_run_workflow',
])
```

Return that timeout only for `AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL` with one of those exact tool names. Keep ordinary tools at 120 seconds, image generation at 10 minutes, and AskUserQuestion at 15 minutes.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the command from Step 2 and expect PASS.

- [ ] **Step 7: Run cancellation and Canvas regression tests**

Run:

```bash
bun test apps/electron/src/main/lib/agent-service.test.ts apps/electron/src/main/lib/agent-headless-runner-registry.test.ts apps/electron/src/main/lib/design
```

Expected: PASS. Existing Automation, Collaboration, session visibility, and low-level Canvas tools retain their behavior.

- [ ] **Step 8: Commit the workflow execution slice**

```bash
git add apps/electron/src/main/lib/design/canvas-workflow-execution-service.ts apps/electron/src/main/lib/design/canvas-workflow-execution-service.test.ts apps/electron/src/main/lib/design/canvas-tool-provider.ts apps/electron/src/main/lib/design/canvas-tool-provider.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/utility/agent-runtime-request-timeout.ts apps/electron/src/utility/agent-runtime-request-timeout.test.ts apps/electron/src/main/ipc.ts
git commit -m "功能：支持普通Agent运行画布可达工作流"
```

### Task 12: Update the default Skill and complete regression verification

**Files:**
- Modify: `apps/electron/default-skills/canvas-production/SKILL.md`
- Modify: `apps/electron/src/main/lib/default-canvas-production-skill.test.ts`
- Modify: `MEMORY.md`

- [ ] **Step 1: Write failing Skill contract tests**

Require version `1.0.6` and explicit guidance that:

- ordinary Agent may configure Canvas Agents with professional installed Skills;
- `canvas_run_agent` runs exactly one Agent and never advances downstream;
- `canvas_run_workflow` runs only the requested reachable graph after explicit user execution intent;
- work is not triggered merely because edges exist;
- Canvas Agents cannot recursively orchestrate other Agent nodes;
- documents/WebViews do not need a run call;
- image generation stays within `maxImageRuns`, produces candidates, and stops for user adoption;
- a later workflow invocation continues from current formal outputs and pending dependency state.

- [ ] **Step 2: Run the Skill test and verify RED**

Run:

```bash
bun test apps/electron/src/main/lib/default-canvas-production-skill.test.ts
```

Expected: FAIL because the Skill is still version `1.0.5` and lacks the new tools.

- [ ] **Step 3: Update the Skill and patch version**

Add the three tools to the existing workflow sections without changing the semantic trigger into a keyword trigger. Make `canvas_run_workflow` the preferred explicit end-to-end path and keep `canvas_run_nodes` for deliberate low-level image-only runs. State that third-party Skills influence task method and output quality but cannot grant tools, write project code, bypass approval, or auto-adopt media.

- [ ] **Step 4: Run the complete focused Canvas suite**

Run:

```bash
bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/default-canvas-production-skill.test.ts apps/electron/src/main/lib/design apps/electron/src/utility/agent-runtime-request-timeout.test.ts apps/electron/src/main/lib/agent-service.test.ts apps/electron/src/main/lib/agent-session-visibility.test.ts apps/electron/src/main/lib/automation-scheduler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run repository typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS. If unrelated pre-existing worktree changes block it, capture the exact file and diagnostic, then run the narrow package checks that still prove this feature.

- [ ] **Step 6: Build Electron**

Run:

```bash
bun run electron:build
```

Expected: PASS and the packaged main process contains the new services plus the updated native helper contract.

- [ ] **Step 7: Run a real Electron smoke test**

Start with:

```bash
bun run dev
```

In one ordinary conversation linked to a test Canvas, verify:

1. configure a Canvas Agent with an enabled professional Skill and read the config back;
2. run one Agent while the Canvas workbench is closed, then confirm `canvas_read` returns its formal output;
3. run Agent -> document and Agent -> Agent paths and confirm direct downstream pending state clears/propagates correctly;
4. run Agent -> image -> downstream with `maxImageRuns=1`, confirm the workflow stops at `waiting-review`, the card still shows the adopted version, and downstream does not run;
5. set the candidate as default in history, rerun the workflow, and confirm only stale reachable descendants continue;
6. stop the parent Agent during a child run and confirm the child stops without affecting an unrelated manual Canvas Agent run;
7. reload the Renderer during a headless workflow and confirm the main-process run completes and the Canvas reloads to authoritative state.

Also inspect light/dark mode and Windows/macOS development builds for unchanged Canvas layout; this feature should add no visible controls or platform-specific UI.

- [ ] **Step 8: Update project memory with durable architecture facts**

Record only the stable decisions: ordinary Agent is the sole Canvas orchestrator, formal Agent output uses a UUID/hash pointer, executable edges must be `bound`, image candidates require adoption, Agent configs live under `agent-configs/<nodeId>/config.json`, and workflow budgets are fixed. Do not copy implementation details already discoverable from code.

- [ ] **Step 9: Review the final diff for scope and leaks**

Run:

```bash
git diff --check
git status --short
git diff -- packages/shared/src/types/canvas.ts apps/electron/src/main/lib/design apps/electron/src/main/lib/stable-directory-native-host.ts apps/electron/native/stable-directory/stable-directory-helper.cc apps/electron/src/utility/agent-runtime-request-timeout.ts apps/electron/default-skills/canvas-production/SKILL.md MEMORY.md
```

Verify no unrelated Server Ops files, credentials, absolute user paths, session IDs, asset IDs, or generated binaries are staged.

- [ ] **Step 10: Commit the Skill and verification record**

```bash
git add apps/electron/default-skills/canvas-production/SKILL.md apps/electron/src/main/lib/default-canvas-production-skill.test.ts MEMORY.md
git commit -m "文档：更新画布Agent自动编排规范"
```

## Acceptance Checklist

- [ ] Ordinary Agent can inspect each node's supported capability and uses a node-specific tool rather than mutating internal JSON.
- [ ] Ordinary Agent can persist Agent responsibility, enabled Skills, and a valid model selection with dual-revision conflict protection.
- [ ] A single Canvas Agent runs headlessly with no open Canvas UI and returns a verified formal output.
- [ ] Renderer-manual Canvas Agent behavior, visible streaming, STOP, and existing controlled tools remain intact.
- [ ] Canvas Agent cannot recursively run Agents/workflows; parent-orchestrated Canvas Agent cannot start image generation.
- [ ] `canvas_run_workflow` touches only the `bound` reachable subgraph from the requested Agent roots.
- [ ] Invalid initial graphs cause zero execution side effects.
- [ ] Dynamic graph changes are revalidated and cannot silently expand paid scope.
- [ ] Agent concurrency, node/Agent/depth/image limits, one-workflow-per-Canvas, and 15-minute deadline are enforced by Host code.
- [ ] Image results remain candidates until the user sets a historical version as default; only adoption advances dependency state.
- [ ] Parent cancellation stops only owned child runs and leaves committed artifacts/candidates intact.
- [ ] Public tool results expose no internal sessions, assets, filesystem paths, credentials, raw exceptions, or unbounded logs.
- [ ] No idle polling, directory scan, background graph listener, or automatic edge-triggered execution is added.
- [ ] Focused tests, typecheck, Electron build, and real-client smoke tests pass with recorded evidence.
