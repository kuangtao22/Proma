# 接口工作台加密接口（P1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让接口工作台支持加密接口：公共配置统一维护变量与签名/加密方案，每个接口只选方案，发送前按顺序执行签名与加密、收到后解密，缺密钥时跳过该步且如实展示服务端返回并留痕。

**Architecture:** 方案（`ApiCryptoProfile`）与工作区变量存进现有 workspace 级 `catalog.json`（沿用 `safe-file` 原子写），密钥值继续只走 `safeStorage` 密文；加解密引擎放在主进程（需 `node:crypto`），只接收已解析的密钥明文，绝不进入记录、日志与导出快照；请求定义只保存 `selectedProfileId` 与三项覆盖；Agent 通过新增配置类工具改方案与变量结构，秘密变量的值在契约层面不可读不可写。

**Tech Stack:** Bun + TypeScript、Electron 43（主进程 `node:crypto`）、Jotai + React + Tailwind/shadcn（渲染层）、既有 IPC 四层契约（shared 常量 → main handler → preload bridge → renderer）。

**设计来源：** `docs/superpowers/specs/2026-09-26-api-workbench-encrypted-api-design.md`；界面稿 `docs/superpowers/specs/2026-09-26-api-workbench-crypto-ui.html`（v6）。

**约束（每个任务都必须满足）：**

- 用 Bun：`bun test` / `bun run typecheck`，不使用 npm/pnpm。
- 密钥值：**不进运行记录、不进日志、导出快照只导占位符**；测试/本地默认明文可见、生产默认遮蔽。
- 缺密钥**绝不阻断**；跳过的步骤必须在状态条、运行记录、（Agent 发出时）审批卡三处标注。
- 新增字段必须向后兼容：旧 `catalog.json` 缺字段时要能整份解析（B4 曾因缺字段导致全量解析失败）。
- 改动默认 Skills 时递增其 `SKILL.md` version；改文档需用户授权（本计划与设计文档已获授权）。

## 文件结构（先定边界，再拆任务）

| 文件 | 职责 |
| --- | --- |
| `packages/shared/src/types/api-workbench.ts`（改） | 新增 `ApiCryptoProfile` / `ApiCryptoStep` / 覆盖项类型；`ApiCatalog` 增加 `workspaceVariables`、`cryptoProfiles`；请求草稿增加 `selectedProfileId`；解析与默认值 |
| `apps/electron/src/main/lib/api-workbench/api-crypto.ts`（新） | 加解密与签名算法执行、模板求值、编码转换；纯函数，无 IO |
| `apps/electron/src/main/lib/api-workbench/api-crypto-plan.ts`（新） | 把方案+已解析密钥编译成「待执行步骤」，产出执行结果与跳过原因（供状态条与记录使用） |
| `apps/electron/src/main/lib/api-workbench/api-request-resolver.ts`（改） | 解析 `workspaceVariables` 作用域；暴露方案解析所需的变量查找 |
| `apps/electron/src/main/lib/api-workbench/api-workbench-store.ts`（改） | 读写 `cryptoProfiles` / `workspaceVariables`；引用检查辅助 |
| `packages/shared/src/types/api-workbench-ipc.ts`（改） | 新增 IPC 请求/响应类型 |
| `apps/electron/src/main/lib/api-workbench/api-ipc.ts`（改） | 新增 handler |
| `apps/electron/src/preload/index.ts`（改） | 新增 bridge 方法 |
| `apps/electron/src/renderer/components/api-workbench/ApiWorkbench.tsx`（改） | 请求侧「加密签名」分区、公共配置管理列表、状态条标注 |
| `apps/electron/src/renderer/components/api-workbench/*.tsx`（新） | 需要时拆出方案编辑与变量表格子组件 |
| `apps/electron/src/renderer/components/agent/api-approval-view.ts`（改） | `api-crypto-config` 配置类审批视图 + 发送侧「本次发送形态」行 |
| `apps/electron/src/main/lib/api-workbench/api-agent-tools.ts`（改） | 新增配置类工具 |
| `apps/electron/src/main/lib/api-workbench/api-agent-facade.ts`（改） | 配置类草稿、审批、秘密值不可读写 |
| `apps/electron/scripts/api-workbench-smoke.ts`（改） | 端到端：签名一致、响应解密、缺密钥明文发出、记录无密钥 |
| `apps/electron/scripts/api-workbench-ui-smoke.ts`（改） | 三个视图的界面断言 |

---

### Task 1: 共享层类型与解析（向后兼容）

**Files:**
- Modify: `packages/shared/src/types/api-workbench.ts`
- Test: `packages/shared/src/types/api-workbench-crypto.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'bun:test'
import { parseApiCatalog, parseApiCryptoProfile, createApiRequestDraft } from './api-workbench'

describe('加密方案与工作区变量解析', () => {
  test('合法方案可解析，步骤顺序保留', () => {
    const profile = parseApiCryptoProfile({
      id: 'profile_backend',
      name: '车本本-后台签名',
      description: '',
      scope: 'workspace',
      appliesTo: 'all',
      revision: 1,
      updatedAt: 1,
      requestSteps: [
        { id: 's1', kind: 'derive', enabled: true, algo: 'timestamp-nonce', target: { in: 'header', name: 'X-Timestamp' } },
        { id: 's2', kind: 'sign', enabled: true, algo: 'HMAC-SHA256', keyRef: 'appSecret', encoding: 'hex', target: { in: 'header', name: 'X-Sign' }, template: '{{method}}\n{{path}}' },
      ],
      responseSteps: [{ id: 'r1', kind: 'decrypt', enabled: true, algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64' }],
    })
    expect(profile.requestSteps.map((step) => step.kind)).toEqual(['derive', 'sign'])
    expect(profile.responseSteps[0]?.ivRef).toBe('aesIv')
  })

  test('旧目录（无 cryptoProfiles / workspaceVariables）仍能整份解析', () => {
    const catalog = parseApiCatalog({
      version: 1, revision: 3,
      collections: [{ id: 'default', name: '默认集合', description: '', variables: [] }],
      environments: [], requests: [],
    })
    expect(catalog.cryptoProfiles).toEqual([])
    expect(catalog.workspaceVariables).toEqual([])
  })

  test('非法算法或缺失 keyRef 的签名步骤被拒绝', () => {
    expect(() => parseApiCryptoProfile({ id: 'x', name: 'x', requestSteps: [{ id: 's', kind: 'sign', enabled: true, algo: 'MD5-ROT13' }], responseSteps: [] })).toThrow()
    expect(() => parseApiCryptoProfile({ id: 'x', name: 'x', requestSteps: [{ id: 's', kind: 'sign', enabled: true, algo: 'MD5' }], responseSteps: [] })).toThrow()
  })

  test('请求草稿默认未选方案，选中值可解析', () => {
    expect(createApiRequestDraft('default').selectedProfileId).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Users/xutaoyu/CodeSource/GPL/Proma-git && bun test packages/shared/src/types/api-workbench-crypto.test.ts`
Expected: FAIL —— `parseApiCryptoProfile is not a function`

- [ ] **Step 3: 最小实现**

在 `packages/shared/src/types/api-workbench.ts` 增加（放在 `ApiEnvironment` 之后）：

```ts
/** 加解密与签名步骤：请求前按数组顺序执行，收到响应后按数组顺序还原。 */
export interface ApiCryptoStep {
  id: string
  kind: 'derive' | 'sign' | 'encrypt' | 'decrypt'
  enabled: boolean
  algo: string
  /** 密钥/IV 只引用变量名；值永远不写进方案。 */
  keyRef?: string
  ivRef?: string
  template?: string
  source?: 'body' | 'query' | 'response-body' | 'response-field'
  target?: { in: 'header' | 'query' | 'body'; name: string }
  encoding?: 'hex' | 'base64' | 'raw'
  onFailure?: 'stop' | 'continue'
}

/** 签名与加密方案：公共资产，接口只引用它的 id。 */
export interface ApiCryptoProfile {
  id: string
  name: string
  description: string
  scope: 'workspace' | { collectionId: string }
  appliesTo: 'all' | 'test' | 'production'
  requestSteps: ApiCryptoStep[]
  responseSteps: ApiCryptoStep[]
  revision: number
  updatedAt: number
}

/** 接口级覆盖项：默认全部跟随方案。 */
export interface ApiCryptoOverrides {
  keyRefs?: Record<string, string>
  targetNames?: Record<string, string>
  onFailure?: 'stop' | 'continue'
}
```

`ApiCatalog` 增加两个**可选**字段并保证解析后必为数组：

```ts
export interface ApiCatalog {
  version: 1
  revision: number
  collections: ApiCollection[]
  environments: ApiEnvironment[]
  requests: ApiRequestDefinition[]
  scenarios?: ApiScenario[]
  /** 工作区级变量：跨集合共用；缺省为空数组。 */
  workspaceVariables?: ApiField[]
  /** 签名与加密方案：公共配置里统一维护。 */
  cryptoProfiles?: ApiCryptoProfile[]
}
```

`parseApiCatalog` 内统一补默认值（保留其余解析逻辑不动）：

```ts
  return {
    ...parsed,
    workspaceVariables: parseApiFields(record.workspaceVariables ?? []),
    cryptoProfiles: (Array.isArray(record.cryptoProfiles) ? record.cryptoProfiles : []).map((item) => parseApiCryptoProfile(item)),
  }
```

新增导出函数（含常量表，供工具与界面共用）：

```ts
/** 允许的算法白名单：写死在解析层，避免历史数据带进未实现算法。 */
export const API_CRYPTO_ALGOS = {
  derive: ['timestamp-nonce'],
  sign: ['MD5', 'SHA1', 'SHA256', 'HMAC-SHA1', 'HMAC-SHA256', 'SM3'],
  encrypt: ['AES-128-CBC', 'AES-256-CBC', 'AES-128-GCM', 'SM4-CBC'],
  decrypt: ['AES-128-CBC', 'AES-256-CBC', 'AES-128-GCM', 'SM4-CBC'],
} as const

export function parseApiCryptoStep(value: unknown): ApiCryptoStep { /* choice/校验 keyRef、encoding、target，非法即 bad('crypto.step.*') */ }
export function parseApiCryptoProfile(value: unknown): ApiCryptoProfile { /* 校验 name 非空、steps 数组、revision/updatedAt 整数 */ }
export function parseApiCryptoOverrides(value: unknown): ApiCryptoOverrides | undefined { /* 可选字段，非法即抛 */ }
```

`DRAFT_KEYS` 增加 `'selectedProfileId'`、`'cryptoOverrides'`，`parseApiRequestDraft` 增加：

```ts
  ...(record.selectedProfileId === undefined ? {} : { selectedProfileId: parseApiId(record.selectedProfileId) }),
  ...(record.cryptoOverrides === undefined ? {} : { cryptoOverrides: parseApiCryptoOverrides(record.cryptoOverrides) }),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/shared/src/types/api-workbench-crypto.test.ts packages/shared/src/types/api-workbench.test.ts`
Expected: PASS（含既有解析测试不回归）

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/types/api-workbench.ts packages/shared/src/types/api-workbench-crypto.test.ts
git commit -m "feat(api-workbench): 新增加密方案与工作区变量的类型与解析"
```

---

### Task 2: 加解密引擎（主进程纯函数）

**Files:**
- Create: `apps/electron/src/main/lib/api-workbench/api-crypto.ts`
- Test: `apps/electron/src/main/lib/api-workbench/api-crypto.test.ts`

- [ ] **Step 1: 写失败测试**（固定测试向量，不依赖网络）

```ts
import { describe, expect, test } from 'bun:test'
import { digestValue, encryptValue, decryptValue, evaluateCryptoTemplate, encodeValue, decodeValue } from './api-crypto'

describe('加解密引擎', () => {
  test('HMAC-SHA256 与公开测试向量一致', () => {
    // RFC 4231 Test Case 2
    expect(digestValue('HMAC-SHA256', 'Jefe', 'what do ya want for nothing?', 'hex'))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  })

  test('MD5 输出与公开向量一致', () => {
    expect(digestValue('MD5', '', 'abc', 'hex')).toBe('900150983cd24fb0d6963f7d28e17f72')
  })

  test('AES-128-CBC 加解密往返一致（PKCS#7）', () => {
    const key = '9f2c8a1d4b6e7f03'
    const iv = '1029384756abcdef'
    const cipher = encryptValue('AES-128-CBC', key, iv, '{"a":1}', { encoding: 'base64' })
    expect(cipher.ciphertext).not.toContain('{"a":1}')
    expect(decryptValue('AES-128-CBC', key, iv, cipher.ciphertext, { encoding: 'base64' })).toBe('{"a":1}')
  })

  test('密钥长度不匹配时报可分类错误', () => {
    expect(() => encryptValue('AES-128-CBC', 'short', '1029384756abcdef', 'x', { encoding: 'base64' }))
      .toThrow('API_CRYPTO_KEY_MISMATCH')
  })

  test('模板求值支持换行与嵌套占位符', () => {
    expect(evaluateCryptoTemplate('{{method}}\n{{path}}\n{{body.sha256}}', {
      method: 'POST', path: '/admin/v1/x', body: { raw: 'abc', sha256: 'ba7816bf' },
    })).toBe('POST\n/admin/v1/x\nba7816bf')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test apps/electron/src/main/lib/api-workbench/api-crypto.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 最小实现**

`api-crypto.ts` 用 `node:crypto` 实现，签名如下（内部细节：`createHmac` / `createHash` / `createCipheriv` / `createDecipheriv`，CBC 用 PKCS#7 自动填充，GCM 返回 `tag`）：

```ts
export type ApiCryptoEncoding = 'hex' | 'base64' | 'raw'

/** 计算摘要或 HMAC 签名。 */
export function digestValue(algo: string, key: string, content: string, encoding: ApiCryptoEncoding): string

/** 对称加密；返回密文与可选 tag（GCM）。 */
export function encryptValue(algo: string, key: string, iv: string, plaintext: string, options: { encoding: ApiCryptoEncoding }): { ciphertext: string; tag?: string }

/** 对称解密；失败时抛 API_CRYPTO_DECRYPT_FAILED，算法/密钥不符时抛 API_CRYPTO_KEY_MISMATCH。 */
export function decryptValue(algo: string, key: string, iv: string, ciphertext: string, options: { encoding: ApiCryptoEncoding }): string

/** 求值待签/待加密模板；未知占位符保持原样，避免静默替换成空串。 */
export function evaluateCryptoTemplate(template: string, context: ApiCryptoTemplateContext): string

/** 编解码工具，供注入与响应解析复用。 */
export function encodeValue(value: string, encoding: ApiCryptoEncoding): string
export function decodeValue(value: string, encoding: ApiCryptoEncoding): string
```

错误约定（主进程统一用带码错误，界面据此分类展示）：

```ts
export class ApiCryptoError extends Error {
  constructor(public readonly code: 'API_CRYPTO_KEY_MISMATCH' | 'API_CRYPTO_DECRYPT_FAILED' | 'API_CRYPTO_UNSUPPORTED_ALGO', message: string) { super(message) }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test apps/electron/src/main/lib/api-workbench/api-crypto.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/main/lib/api-workbench/api-crypto.ts apps/electron/src/main/lib/api-workbench/api-crypto.test.ts
git commit -m "feat(api-workbench): 新增加解密与签名引擎（含公开测试向量）"
```

---

### Task 3: 步骤编排与「缺密钥跳过」决策

**Files:**
- Create: `apps/electron/src/main/lib/api-workbench/api-crypto-plan.ts`
- Test: `apps/electron/src/main/lib/api-workbench/api-crypto-plan.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'bun:test'
import { applyRequestSteps, applyResponseSteps } from './api-crypto-plan'

const profile = {
  id: 'profile_backend',
  name: '车本本-后台签名',
  description: '',
  scope: 'workspace' as const,
  appliesTo: 'all' as const,
  revision: 1,
  updatedAt: 1,
  requestSteps: [
    { id: 's1', kind: 'derive' as const, enabled: true, algo: 'timestamp-nonce', target: { in: 'header' as const, name: 'X-Timestamp' } },
    { id: 's2', kind: 'sign' as const, enabled: true, algo: 'HMAC-SHA256', keyRef: 'appSecret', encoding: 'hex' as const, target: { in: 'header' as const, name: 'X-Sign' }, template: '{{method}}\n{{path}}\n{{timestamp}}\n{{body.sha256}}' },
    { id: 's3', kind: 'encrypt' as const, enabled: true, algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64' as const, source: 'body' as const, target: { in: 'body' as const, name: 'body' } },
  ],
  responseSteps: [
    { id: 'r1', kind: 'decrypt' as const, enabled: true, algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64' as const, source: 'response-body' as const, onFailure: 'stop' as const },
  ],
}

describe('步骤编排', () => {
  test('按顺序执行签名再加密，签名对明文求值', () => {
    const result = applyRequestSteps({ profile, secrets: { appSecret: 'k', aesKey: '9f2c8a1d4b6e7f03', aesIv: '1029384756abcdef' }, request: { method: 'POST', path: '/x', headers: [], body: '{"a":1}' } })
    expect(result.headers['X-Sign']).toMatch(/^[0-9a-f]{64}$/)
    expect(result.body).not.toContain('{"a":1}')
    expect(result.executed.map((step) => step.kind)).toEqual(['derive', 'sign', 'encrypt'])
  })

  test('缺密钥时跳过该步并记录原因，不阻断', () => {
    const result = applyRequestSteps({ profile, secrets: { appSecret: 'k' }, request: { method: 'POST', path: '/x', headers: [], body: '{"a":1}' } })
    expect(result.skipped).toEqual([
      expect.objectContaining({ kind: 'encrypt', reason: 'missing-secret', keyRef: 'aesKey' }),
    ])
    expect(result.plaintextSent).toBe(true)
    expect(result.body).toBe('{"a":1}')
  })

  test('响应解密成功返回明文与事实；缺密钥时标记未解密', () => {
    const ok = applyResponseSteps({ profile, secrets: { aesKey: '9f2c8a1d4b6e7f03', aesIv: '1029384756abcdef' }, responseBody: '<在测试里用 encryptValue 现算>' })
    expect(ok.decrypted).toBe(true)
    const missing = applyResponseSteps({ profile, secrets: {}, responseBody: 'xxx' })
    expect(missing.decrypted).toBe(false)
    expect(missing.skipped[0]).toMatchObject({ kind: 'decrypt', reason: 'missing-secret' })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test apps/electron/src/main/lib/api-workbench/api-crypto-plan.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 最小实现**

```ts
/** 请求侧执行结果：既有变形后的请求，也有「哪些步骤被跳过、为什么」的事实。 */
export interface ApiCryptoRequestOutcome {
  method: string
  path: string
  headers: Array<{ name: string; value: string }>
  query: Array<{ name: string; value: string }>
  body: string
  executed: Array<{ id: string; kind: string; algo: string }>
  skipped: Array<{ id: string; kind: string; algo: string; reason: 'missing-secret' | 'disabled'; keyRef?: string }>
  /** 因缺密钥而未加密：状态条与记录必须显式标注。 */
  plaintextSent: boolean
}

export interface ApiCryptoResponseOutcome {
  body: string
  decrypted: boolean
  executed: Array<{ id: string; kind: string; algo: string }>
  skipped: Array<{ id: string; kind: string; algo: string; reason: 'missing-secret' | 'disabled'; keyRef?: string }>
  failure?: { code: string; message: string }
}

export function applyRequestSteps(input: ApplyRequestStepsInput): ApiCryptoRequestOutcome
export function applyResponseSteps(input: ApplyResponseStepsInput): ApiCryptoResponseOutcome
```

关键实现要求：

- `derive` 步骤生成 `timestamp`/`nonce` 并写入后续模板上下文，同时把实际取值留在 outcome 里（非秘密，供记录复现）。
- `sign`/`encrypt` 步骤前先查 `secrets[keyRef]`：**空值视为缺密钥 → 记 skipped，不抛错**。
- 覆盖项优先于方案：`keyRefs` / `targetNames` / `onFailure` 三项生效。
- `decrypt` 步骤按 `onFailure` 决定：默认 `stop`（跳过后续断言），并在 outcome 里给出可分类的 `failure.code`。

- [ ] **Step 4: 运行确认通过**

Run: `bun test apps/electron/src/main/lib/api-workbench/api-crypto-plan.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/main/lib/api-workbench/api-crypto-plan.ts apps/electron/src/main/lib/api-workbench/api-crypto-plan.test.ts
git commit -m "feat(api-workbench): 加密步骤编排与缺密钥跳过决策"
```

---

### Task 4: 存储与 IPC（方案 + 工作区变量）

**Files:**
- Modify: `apps/electron/src/main/lib/api-workbench/api-workbench-store.ts`
- Modify: `packages/shared/src/types/api-workbench-ipc.ts`
- Modify: `apps/electron/src/main/lib/api-workbench/api-ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Test: `apps/electron/src/main/lib/api-workbench/api-workbench-store-crypto.test.ts`

- [ ] **Step 1: 写失败测试**（存储层：原子写、revision 冲突、引用检查）

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiWorkbenchStore } from './api-workbench-store'

/** 每个用例独立临时 workspace，避免互相污染。 */
let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'proma-crypto-store-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('方案与工作区变量存储', () => {
  test('保存方案后 revision 递增，旧 revision 保存被拒绝', async () => {
    const store = new ApiWorkbenchStore({ workspaceRoot: root, safeStorage: fakeSafeStorage() })
    const saved = await store.saveCryptoProfile({ profile: backendProfile({ revision: 0 }), expectedRevision: null })
    expect(saved.revision).toBe(1)
    await expect(store.saveCryptoProfile({ profile: saved, expectedRevision: 0 })).rejects.toThrow('API_WORKBENCH_CRYPTO_REVISION_CONFLICT')
  })

  test('工作区变量按作用域写入 catalog.json，秘密值仍走 safeStorage', async () => {
    const store = new ApiWorkbenchStore({ workspaceRoot: root, safeStorage: fakeSafeStorage() })
    await store.saveWorkspaceVariables({ variables: [{ id: 'v1', name: 'appSecret', value: 'cb-app-2026-9f2c8a1d', secret: true, enabled: true }] })
    const raw = await readFile(join(root, 'catalog.json'), 'utf8')
    expect(raw).not.toContain('cb-app-2026-9f2c8a1d')
    expect(raw).toContain('appSecret')
  })

  test('删除被方案引用的变量时给出引用清单', async () => {
    const store = new ApiWorkbenchStore({ workspaceRoot: root, safeStorage: fakeSafeStorage() })
    await store.saveCryptoProfile({ profile: backendProfile({ revision: 0 }), expectedRevision: null })
    const refs = await store.inspectCryptoReferences({ kind: 'variable', name: 'aesIv' })
    expect(refs.profiles).toEqual(['车本本-后台签名'])
    expect(refs.requests).toBeGreaterThan(0)
  })
})
```

（`fakeSafeStorage()` 与 `backendProfile()` 是本测试文件内的两个小工厂：前者按 `api-workbench-store.test.ts` 里既有的假 safeStorage 写法返回明文加前缀的密文，后者返回一份含签名与加密步骤的方案对象。）

- [ ] **Step 2: 运行确认失败**

Run: `bun test apps/electron/src/main/lib/api-workbench/api-workbench-store-crypto.test.ts`
Expected: FAIL

- [ ] **Step 3: 最小实现**

存储：`ApiWorkbenchStore` 增加

```ts
  /** 保存方案（新增或更新），revision 冲突时抛 API_WORKBENCH_CRYPTO_REVISION_CONFLICT。 */
  async saveCryptoProfile(input: { profile: ApiCryptoProfile; expectedRevision: number | null }): Promise<ApiCryptoProfile>
  /** 删除方案；仍被请求引用时拒绝并返回引用清单。 */
  async deleteCryptoProfile(input: { id: string; force?: boolean }): Promise<{ removed: boolean; referencedBy: number }>
  /** 批量写工作区变量；秘密值走既有 safeStorage 路径。 */
  async saveWorkspaceVariables(input: { variables: ApiField[] }): Promise<ApiField[]>
  /** 变量/方案的引用检查：给界面与删除确认共用。 */
  async inspectCryptoReferences(input: { kind: 'variable' | 'profile'; name: string }): Promise<{ profiles: string[]; requests: number; collections: string[] }>
```

IPC（四层都要动，缺一层界面就静默失败）：`packages/shared/src/types/api-workbench-ipc.ts` 增加

```ts
export interface ApiCryptoProfileSaveRequest { profile: ApiCryptoProfile; expectedRevision: number | null }
export interface ApiWorkspaceVariablesSaveRequest { variables: ApiField[] }
export interface ApiCryptoReferenceQuery { kind: 'variable' | 'profile'; name: string }
```

并在 `api-workbench-ipc.ts` 的调用通道枚举里加 `cryptoProfileSave` / `cryptoProfileDelete` / `workspaceVariablesSave` / `cryptoReferences`；`api-ipc.ts` 落 handler，`preload/index.ts` 暴露同名方法。

- [ ] **Step 4: 运行确认通过 + 类型检查**

Run: `bun test apps/electron/src/main/lib/api-workbench/api-workbench-store-crypto.test.ts && bun run typecheck`
Expected: PASS / 7 工作区全部通过

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/types/api-workbench-ipc.ts apps/electron/src/main/lib/api-workbench/api-workbench-store.ts apps/electron/src/main/lib/api-workbench/api-ipc.ts apps/electron/src/preload/index.ts apps/electron/src/main/lib/api-workbench/api-workbench-store-crypto.test.ts
git commit -m "feat(api-workbench): 方案与工作区变量的存储、IPC 四层接通"
```

---

### Task 5: 接入发送链路（请求变形 + 响应还原 + 记录留痕）

**Files:**
- Modify: `apps/electron/src/main/lib/api-workbench/api-workbench-service.ts`
- Modify: `apps/electron/src/main/lib/api-workbench/api-request-resolver.ts`
- Modify: `apps/electron/src/main/lib/api-workbench/api-redaction.ts`（仅在需要时补字段）
- Test: `apps/electron/src/main/lib/api-workbench/api-workbench-service-crypto.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
const FAKE_AES_KEY = '9f2c8a1d4b6e7f03'
const FAKE_AES_IV = '1029384756abcdef'
const FAKE_APP_SECRET = 'cb-app-2026-9f2c8a1d'

describe('发送链路加密', () => {
  test('发送时按方案签名并加密，服务端收到的是密文', async () => {
    const server = await startCryptoFixtureServer({ key: FAKE_AES_KEY, iv: FAKE_AES_IV, secret: FAKE_APP_SECRET })
    const run = await sendPreparedRequest({ workspaceRoot, request: saveRequestWithProfile(server.url) })
    expect(server.seen.last?.signMatched).toBe(true)
    expect(server.seen.last?.decryptedField).toBe('capabilityId=1024')
    expect(run.crypto?.executed.map((step) => step.kind)).toEqual(['derive', 'sign', 'encrypt'])
  })

  test('响应按方案解密后才交给断言与提取（提取拿到明文值，不是 [REDACTED]）', async () => {
    const run = await sendPreparedRequest({ workspaceRoot, request: saveRequestWithProfile(fixtureUrl) })
    expect(run.crypto?.decrypted).toBe(true)
    expect(run.extractions?.[0]).toMatchObject({ name: 'capabilityId', matched: true })
  })

  test('缺密钥时明文发出，运行记录里带 skipped 与 plaintextSent 标记', async () => {
    await removeSecret(workspaceRoot, 'aesKey')
    const run = await sendPreparedRequest({ workspaceRoot, request: saveRequestWithProfile(fixtureUrl) })
    expect(run.crypto?.plaintextSent).toBe(true)
    expect(run.crypto?.skipped).toEqual([expect.objectContaining({ kind: 'encrypt', reason: 'missing-secret' })])
    expect(run.hops[0]?.status).toBeGreaterThan(0)
  })

  test('运行记录与日志里不出现密钥值', async () => {
    const record = await readFile(join(workspaceRoot, 'runs', run.id, 'record.json'), 'utf8')
    for (const secret of [FAKE_AES_KEY, FAKE_AES_IV, FAKE_APP_SECRET]) expect(record).not.toContain(secret)
  })
})
```

（`startCryptoFixtureServer` 是本文件内的本地 HTTP 夹具：验签、解密收到的正文并把字段回显进响应；`sendPreparedRequest` 复用既有 service 测试的准备与发送路径。）

- [ ] **Step 2: 运行确认失败**

Run: `bun test apps/electron/src/main/lib/api-workbench/api-workbench-service-crypto.test.ts`
Expected: FAIL

- [ ] **Step 3: 最小实现**

- `api-request-resolver.ts`：把 `workspaceVariables` 纳入解析链（优先级低于环境、高于集合；顺序见设计文档 §2.1），并导出 `listWorkspaceVariables(catalog)` 供编排层使用。
- `api-workbench-service.ts`：prepare 阶段解析出请求选中的方案与已解析密钥后调用 `applyRequestSteps`；发送响应后调用 `applyResponseSteps`，把结果交给既有断言/提取链路；把 `executed` / `skipped` / `plaintextSent` / `decrypted` 写进运行记录的新字段 `crypto`。
- `api-redaction.ts`：确保 `crypto` 字段随记录公开时只含算法名、变量名与布尔事实。

- [ ] **Step 4: 运行确认通过**

Run: `bun test apps/electron/src/main/lib/api-workbench/api-workbench-service-crypto.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/main/lib/api-workbench/api-workbench-service.ts apps/electron/src/main/lib/api-workbench/api-request-resolver.ts apps/electron/src/main/lib/api-workbench/api-workbench-service-crypto.test.ts
git commit -m "feat(api-workbench): 发送链路接入加密步骤与明文发出留痕"
```

---

### Task 6: 请求侧界面（选方案 + 只读步骤 + 覆盖项 + 状态条标注）

**Files:**
- Modify: `apps/electron/src/renderer/components/api-workbench/ApiWorkbench.tsx`
- Test: `apps/electron/scripts/api-workbench-ui-smoke.ts`

- [ ] **Step 1: 写界面断言（先失败）**

在既有 UI smoke 的请求窗口里追加：

```ts
await waitFor(window, "Boolean(document.querySelector('select[aria-label=\"使用签名方案\"]'))", '缺少方案选择器')
await clickText(window, '加密签名')
assert.equal(await window.webContents.executeJavaScript("document.body.textContent.includes('在公共配置里修改')"), true, '步骤预览缺少跳转入口')
await window.webContents.executeJavaScript("setSelectedProfile(window, '不使用签名/加密')") // 用夹具暴露的 setter
await waitFor(window, "document.body.textContent.includes('未启用加密')", '未选方案时缺少说明')
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/electron && PROMA_ELECTRON_PATH="$PWD/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" bun run scripts/api-workbench-ui-smoke.ts`
Expected: FAIL —— 找不到方案选择器

- [ ] **Step 3: 实现**

- 分区页签增加「加密签名」，角标显示当前方案短名；
- 方案选择用原生 `select`（`aria-label="使用签名方案"`），选项来自 `catalog.cryptoProfiles`；
- 只读步骤列表用 `.step` 结构渲染（与界面稿一致），每段右侧「在公共配置里修改 →」跳到公共配置视图；
- 覆盖项折叠区默认收起（密钥变量 / 输出名称 / 失败策略三项）；
- 状态条渲染 `crypto` 事实：`已解密 · AES-128-CBC` / `未解密 · 本地缺少 aesIv` / `⚠️ 本次未加密 · 明文发出`。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/renderer/components/api-workbench/ApiWorkbench.tsx apps/electron/scripts/api-workbench-ui-smoke.ts
git commit -m "feat(api-workbench): 请求侧选方案、只读步骤与缺密钥状态标注"
```

---

### Task 7: 公共配置管理列表（变量与密钥 / 方案）

**Files:**
- Create: `apps/electron/src/renderer/components/api-workbench/ApiCryptoConfigPanel.tsx`
- Create: `apps/electron/src/renderer/components/api-workbench/ApiVariableTable.tsx`
- Modify: `apps/electron/src/renderer/components/api-workbench/ApiWorkbench.tsx`
- Test: `apps/electron/scripts/api-workbench-ui-smoke.ts`

- [ ] **Step 1: 写界面断言（先失败）**

```ts
await clickLabel(window, '公共配置')
await waitFor(window, "Boolean(document.querySelector('[data-common-panel=\"variables\"]'))", '变量列表未渲染')
assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('[data-variable-row]').length > 3"), true, '变量表格没有行')
await clickLabel(window, '添加变量')
await waitFor(window, "Boolean(document.querySelector('[data-variable-row][data-draft=\"true\"]'))", '底部添加行没有出现')
await clickLabel(window, '明文显示')
assert.equal(await window.webContents.executeJavaScript("document.body.textContent.includes('••••')"), true, '关闭明文显示后秘密值没有遮蔽')
```

- [ ] **Step 2: 运行确认失败**

Run: 同 Task 6 Step 2
Expected: FAIL

- [ ] **Step 3: 实现**

- `ApiVariableTable.tsx`：表格（勾选 / 名称 / 类型 / 值 / 作用域 / 被引用 / 操作），内联编辑含保存与取消，底部「＋ 添加一行」，工具条含作用域筛选、搜索、**明文显示开关**（生产默认遮蔽）、批量编辑入口；行上 `data-variable-row` 供测试定位。
- `ApiCryptoConfigPanel.tsx`：方案列表 + 详情（步骤可拖拽排序、密钥下拉只能选变量、影响面提示「修改会影响 N 个接口」、按环境密钥齐备检查、保存前二次确认）。
- `ApiWorkbench.tsx`：接入公共配置视图与页签；删除变量/方案前调用 `cryptoReferences` 显示引用清单。

- [ ] **Step 4: 运行确认通过**

Run: 同 Task 6 Step 2
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/renderer/components/api-workbench/ApiCryptoConfigPanel.tsx apps/electron/src/renderer/components/api-workbench/ApiVariableTable.tsx apps/electron/src/renderer/components/api-workbench/ApiWorkbench.tsx apps/electron/scripts/api-workbench-ui-smoke.ts
git commit -m "feat(api-workbench): 公共配置管理列表（变量与密钥、方案，含四件套交互）"
```

---

### Task 8: Agent 配置类工具与审批视图

**Files:**
- Modify: `apps/electron/src/main/lib/api-workbench/api-agent-tools.ts`
- Modify: `apps/electron/src/main/lib/api-workbench/api-agent-facade.ts`
- Modify: `apps/electron/src/renderer/components/agent/api-approval-view.ts`
- Test: `apps/electron/src/main/lib/api-workbench/api-agent-facade-crypto.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('Agent 可以声明秘密变量，但值字段被强制为空且不可读', async () => {
  const draft = await facade.prepareVariables({ variables: [{ name: 'appSecret', secret: true, value: 'should-be-ignored' }] })
  expect(draft.variables[0]).toMatchObject({ name: 'appSecret', secret: true, value: '' })
  expect(JSON.stringify(draft)).not.toContain('should-be-ignored')
})
test('Agent 绑定方案后，请求定义只增加 selectedProfileId', async () => {})
test('读取现有秘密变量时只返回是否已填，不返回值', async () => { /* configured: true / value 不存在 */ })
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test apps/electron/src/main/lib/api-workbench/api-agent-facade-crypto.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

- 新工具（`api-agent-tools.ts`）：`api_save_crypto_profile`、`api_delete_crypto_profile`、`api_declare_variables`、`api_bind_crypto_profile`；全部走既有 `approval` / `authorize` / `requireGrant` 链路。
- facade：秘密变量在草稿与授权载荷里**只保留 name/secret/scope**，值固定 `''`；`inspect` 类返回 `configured: boolean`。
- 审批视图：新增 `api-crypto-config` 类型，展示方案步骤摘要、"读密钥：否 / 写密钥：否 / 可回滚 revision"；发送类视图追加「本次发送形态」行（缺密钥时高亮「明文发出」）。

- [ ] **Step 4: 运行确认通过**

Run: `bun test apps/electron/src/main/lib/api-workbench/api-agent-facade-crypto.test.ts apps/electron/src/main/lib/api-workbench/api-agent-tools.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/main/lib/api-workbench/api-agent-tools.ts apps/electron/src/main/lib/api-workbench/api-agent-facade.ts apps/electron/src/renderer/components/agent/api-approval-view.ts apps/electron/src/main/lib/api-workbench/api-agent-facade-crypto.test.ts
git commit -m "feat(api-workbench): Agent 配置类工具与审批视图（密钥值不可读写）"
```

---

### Task 9: 端到端与界面回归（上线门槛）

**Files:**
- Modify: `apps/electron/scripts/api-workbench-smoke.ts`
- Modify: `apps/electron/scripts/api-workbench-ui-smoke.ts`
- Modify: `apps/electron/scripts/api-workbench-ui-smoke-renderer.tsx`

- [ ] **Step 1: 扩展端到端夹具端点**

本地 HTTP 夹具增加三件事：① 校验 `X-Sign` 与 HMAC-SHA256 是否与约定一致；② 解密收到的 AES-128-CBC 正文并回显其中的字段；③ 返回同样加密的响应体。

- [ ] **Step 2: 写端到端断言**

```ts
assert.equal(serverSeen.signMatched, true, '服务端校验签名不一致')
assert.equal(serverSeen.decryptedField, 'capabilityId=1024', '服务端没收到正确密文')
assert.equal(run.crypto.decrypted, true, '响应没有解密')
assert.equal(JSON.stringify(record).includes(FAKE_AES_KEY), false, '运行记录泄漏了密钥')
assert.equal(record.crypto.skipped.length, 0, '完整密钥时不应跳过步骤')
```

再补一组"缺密钥"路径：删掉 `aesKey` 后重发，断言 `plaintextSent === true`、状态条文案含「明文发出」、服务端返回照样展示。

- [ ] **Step 3: 运行端到端**

Run（按既有流程先构建，再跑真实 Electron）：
```bash
cd apps/electron && bun x esbuild scripts/api-workbench-smoke.ts --bundle --platform=node --format=cjs --outfile=dist/api-workbench-smoke.cjs --external:electron
env -u ELECTRON_RUN_AS_NODE "$PWD/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" dist/api-workbench-smoke.cjs
```
Expected: PASS，日志里能看到签名一致、响应解密、明文发出标注三条证据

- [ ] **Step 4: 运行界面 smoke**

Run: `cd apps/electron && PROMA_ELECTRON_PATH="$PWD/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" bun run scripts/api-workbench-ui-smoke.ts`
Expected: PASS，并产出三个视图的截图

- [ ] **Step 5: 提交**

```bash
git add apps/electron/scripts/api-workbench-smoke.ts apps/electron/scripts/api-workbench-ui-smoke.ts apps/electron/scripts/api-workbench-ui-smoke-renderer.tsx
git commit -m "test(api-workbench): 加密接口端到端与三视图界面回归"
```

---

### Task 10: 全量验证与交付

**Files:** 无新增，仅验证与文档

- [ ] **Step 1: 全量回归**

Run: `cd /Users/xutaoyu/CodeSource/GPL/Proma-git && bun run typecheck && bun test apps/electron/src/main/lib/api-workbench apps/electron/src/renderer/components/api-workbench apps/electron/src/renderer/components/agent packages/shared/src/types`
Expected: 类型检查 7 工作区通过；定向回归 0 fail（新增用例计入）
- [ ] **Step 2: 构建产物自检**

Run: `cd apps/electron && bun run electron:build && rg -c --text "selectedProfileId" dist/main.cjs`
Expected: 构建成功且主进程产物包含新字段
- [ ] **Step 3: 打包并替换安装版**（用户确认后执行，避免打断在途会话）

Run: `cd apps/electron && bun run pack` → 替换 `/Applications/开发工具/Proma.app` → `bun install --frozen-lockfile` 恢复 dev 依赖
- [ ] **Step 4: 回写记忆并汇报**

在 `MEMORY.md` 记录：算法集最终范围、缺密钥跳过的实现口径、密钥明文/遮蔽的默认值、Agent 边界、证据位置；向用户汇报本轮的验证证据与剩余边界（未做的算法、P2/P3 范围）。

## 自检结论（对照设计文档）

| 设计文档要求 | 对应任务 |
| --- | --- |
| 公共配置统一管理（变量/方案/请求头/参数/鉴权） | Task 4、7（请求头/参数/鉴权归入 P2，方案与变量在 P1） |
| 接口只选方案 + 覆盖项 | Task 1、6 |
| 顺序即语义（签名签明文/密文） | Task 3（顺序由数组顺序决定，测试覆盖"签名在加密前"） |
| 缺密钥绝不阻断 + 三处留痕 | Task 3、5、6、8 |
| 解密失败分类 + fail closed | Task 2、3、6 |
| 断言/提取跑在解密后原始正文 | Task 5 |
| 密钥不进记录/日志/导出；明文显示与生产遮蔽 | Task 4、5、7 |
| Agent 只配置结构、密钥不可读写、两次审批 | Task 8 |
| 验证策略（算法向量、端到端、界面三视图） | Task 2、9 |

**明确不在 P1：** 公共请求头 / 公共查询参数 / 公共鉴权的列表页（P2）、受限表达式 DSL 与国密/证书类补充（P3）、运行历史按「明文发出/未解密」筛选（P2）。
