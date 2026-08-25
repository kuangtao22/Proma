# Canvas Session Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为项目建立独立于 `AgentSessionMeta` 的 Canvas 顶层会话身份、受信任多 Canvas 路径和原子索引 API，同时保持现有 Design 画布与生图链路行为不变。

**Architecture:** 新增 `CanvasSessionMeta` 与独立 `CanvasSessionStore`，将会话索引保存在项目 `.proma/design/canvases/index.json`，并把已有 `.proma/design/canvas.json` 幂等投影为 ID 固定的默认 Canvas。Canvas 会话 API 复用 Design IPC、Preload 和 Renderer adapter，但不进入 Agent 会话索引，因此托盘、搜索、Automation、LAN/mobile 和 Pi runtime 不会误把 Canvas 当作 Agent。

**Tech Stack:** Bun、TypeScript、Electron IPC、React Renderer adapter、Jotai（后续 UI 阶段）、`safe-file.ts` 原子 JSON、现有 Design 路径解析器

---

## 总体实施路线

完整规格拆成以下可独立验证的计划，避免把存储迁移、Agent 图运行和不可信 HTML 沙箱放进同一次改动：

1. **本计划：Canvas 会话基础**：共享合同、路径、原子索引、旧 Design 默认会话投影、IPC/Preload/Adapter。
2. **多 Canvas Renderer 与兼容加载**：左侧项目会话类型、新建/切换/归档入口、按 `canvasId` 隔离 Renderer 状态，现有 Design 继续只绑定默认 Canvas。
3. **稳定生图模块与数据迁移**：将 `asset/job` 一级节点按 `creativeTaskId` 聚合为 image module，并迁移旧布局、任务和版本。
4. **Agent 图与显式连线**：Agent 节点、浮动对话、typed edge、stale、结构化 Agent 交接和视觉文档节点。
5. **WebView 原型沙箱**：底层 `webview` 节点、受管 HTML/CSS/JS、快照、休眠和网络/文件/IPC 阻断。
6. **语义转交与全链路收口**：`propose_canvas_handoff`、旧入口退役、路径迁移、可见性消费者、真实 Electron 与性能验收。

本计划的停止条件：Renderer 可以通过类型安全 API 列出、新建、重命名和归档 Canvas 会话；已有 Design 项目自动出现唯一 `legacy-design` 会话；现有 `loadDesignWorkspace(projectId)`、Design Job、素材、上下文和会话可见性测试全部不回退。

## 文件职责

- `packages/shared/src/types/design.ts`：Canvas 会话公开类型、请求、事件和 IPC 通道。
- `packages/shared/src/types/design.test.ts`：共享合同的运行时样例和稳定常量回归。
- `apps/electron/src/main/lib/design/design-paths.ts`：项目级共享 Design 路径与 Canvas 专属路径解析。
- `apps/electron/src/main/lib/design/design-paths.test.ts`：路径映射、稳定 ID 和越界拒绝。
- `apps/electron/src/main/lib/design/canvas-session-store.ts`：Canvas 会话索引、旧 Design 投影、创建、重命名和归档。
- `apps/electron/src/main/lib/design/canvas-session-store.test.ts`：原子索引、损坏文件、幂等投影和项目隔离。
- `apps/electron/src/main/lib/design/canvas-session-ipc.ts`：独立 Canvas 会话 IPC 注册、sender/输入/写守卫校验。
- `apps/electron/src/main/lib/design/canvas-session-ipc.test.ts`：三个 invoke 通道和一个变化事件的授权、参数与副作用边界。
- `apps/electron/src/main/ipc.ts`：构造 store 并注册 Canvas 会话 IPC。
- `apps/electron/src/preload/design-preload.ts`：向 Renderer 暴露最小 Canvas 会话 API。
- `apps/electron/src/preload/design-preload.test.ts`：通道和结构化参数透传。
- `apps/electron/src/renderer/lib/design-adapter.ts`：Renderer 对 Canvas 会话 API 的唯一适配入口。
- `apps/electron/src/renderer/lib/design-adapter.test.ts`：参数、返回值和错误原样传播。

### Task 1: 定义 Canvas 会话共享合同

**Files:**
- Modify: `packages/shared/src/types/design.ts`
- Modify: `packages/shared/src/types/design.test.ts`

- [ ] **Step 1: 写失败的共享合同测试**

在 `packages/shared/src/types/design.test.ts` 增加以下用例和类型导入：

```ts
import {
  CANVAS_SESSION_TITLE_MAX_LENGTH,
  DESIGN_IPC_CHANNELS,
} from './design'
import type {
  CanvasSessionChangeEvent,
  CanvasSessionMeta,
  CreateCanvasSessionInput,
  ListCanvasSessionsInput,
  UpdateCanvasSessionInput,
} from './design'

test('Given Canvas 会话合同 When 构造公开值 Then 身份与通道保持稳定', () => {
  /** 固定时间用于验证公开元数据不依赖运行环境。 */
  const now = 100
  /** Canvas 顶层会话样例，不携带 Agent runtime 字段。 */
  const session: CanvasSessionMeta = {
    id: 'canvas-1',
    projectId: 'project-1',
    title: 'App 页面设计',
    archived: false,
    createdAt: now,
    updatedAt: now,
  }
  /** 四层 IPC 使用的结构化请求样例。 */
  const listInput: ListCanvasSessionsInput = { projectId: 'project-1', archived: false }
  /** 新建请求只接受项目与可选标题。 */
  const createInput: CreateCanvasSessionInput = { projectId: 'project-1', title: 'App 页面设计' }
  /** 更新请求只允许标题和归档状态。 */
  const updateInput: UpdateCanvasSessionInput = {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    title: 'App 页面视觉',
    archived: true,
  }
  /** 成功提交后的公开变化事件。 */
  const event: CanvasSessionChangeEvent = {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    cause: 'updated',
  }

  expect(session).toEqual({
    id: 'canvas-1', projectId: 'project-1', title: 'App 页面设计',
    archived: false, createdAt: now, updatedAt: now,
  })
  expect([listInput, createInput, updateInput, event]).toHaveLength(4)
  expect(CANVAS_SESSION_TITLE_MAX_LENGTH).toBe(120)
  expect(DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS).toBe('design:list-canvas-sessions')
  expect(DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION).toBe('design:create-canvas-session')
  expect(DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION).toBe('design:update-canvas-session')
  expect(DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED).toBe('design:canvas-session-changed')
})
```

- [ ] **Step 2: 运行测试确认合同尚不存在**

Run:

```bash
bun test packages/shared/src/types/design.test.ts
```

Expected: FAIL，提示 `CANVAS_SESSION_TITLE_MAX_LENGTH`、Canvas 类型或 Canvas IPC 通道未定义。

- [ ] **Step 3: 增加最小共享类型和通道**

在 `packages/shared/src/types/design.ts` 的 Design 基础常量后增加：

```ts
/** Canvas 会话标题长度上限，阻断无界标题放大索引和侧栏布局。 */
export const CANVAS_SESSION_TITLE_MAX_LENGTH = 120

/** 项目下可见的 Canvas 顶层会话，不携带 Agent runtime 字段。 */
export interface CanvasSessionMeta {
  id: string
  projectId: string
  title: string
  archived: boolean
  createdAt: number
  updatedAt: number
}

/** 查询项目 Canvas 会话的输入；archived 缺失时返回全部。 */
export interface ListCanvasSessionsInput {
  projectId: string
  archived?: boolean
}

/** 新建 Canvas 会话的输入。 */
export interface CreateCanvasSessionInput {
  projectId: string
  title?: string
}

/** 更新 Canvas 会话可变展示字段的输入。 */
export interface UpdateCanvasSessionInput {
  projectId: string
  canvasId: string
  title?: string
  archived?: boolean
}

/** Canvas 会话索引成功提交后的变化原因。 */
export type CanvasSessionChangeCause = 'created' | 'updated'

/** 主进程广播给 Renderer 的 Canvas 会话变化。 */
export interface CanvasSessionChangeEvent {
  projectId: string
  canvasId: string
  cause: CanvasSessionChangeCause
}
```

在 `DESIGN_IPC_CHANNELS` 中增加：

```ts
  LIST_CANVAS_SESSIONS: 'design:list-canvas-sessions',
  CREATE_CANVAS_SESSION: 'design:create-canvas-session',
  UPDATE_CANVAS_SESSION: 'design:update-canvas-session',
  CANVAS_SESSION_CHANGED: 'design:canvas-session-changed',
```

- [ ] **Step 4: 运行共享合同测试**

Run:

```bash
bun test packages/shared/src/types/design.test.ts
```

Expected: PASS，现有 Design 类型测试同时保持通过。

- [ ] **Step 5: 提交共享合同**

```bash
git add packages/shared/src/types/design.ts packages/shared/src/types/design.test.ts
git commit -m "设计：增加 Canvas 会话共享合同"
```

### Task 2: 扩展受信任的多 Canvas 路径

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-paths.ts`
- Modify: `apps/electron/src/main/lib/design/design-paths.test.ts`

- [ ] **Step 1: 写失败的路径测试**

在 `design-paths.test.ts` 现有外部项目用例的完整 `toEqual` 对象中加入：

```ts
  canvasesRoot: '/projects/demo/.proma/design/canvases',
  canvasSessionsIndexPath: '/projects/demo/.proma/design/canvases/index.json',
```

随后在同一测试增加 Canvas 专属路径断言：

```ts
expect(resolver.resolveCanvas('project-1', 'canvas-1')).toEqual({
  projectId: 'project-1',
  canvasId: 'canvas-1',
  canvasRoot: '/projects/demo/.proma/design/canvases/canvas-1',
  documentPath: '/projects/demo/.proma/design/canvases/canvas-1/canvas.json',
  cacheRoot: '/home/test/.proma/design-cache/project-1/canvases/canvas-1',
  jobsDir: '/home/test/.proma/design-cache/project-1/canvases/canvas-1/jobs',
  tracesDir: '/home/test/.proma/design-cache/project-1/canvases/canvas-1/traces',
  stagingDir: '/home/test/.proma/design-cache/project-1/canvases/canvas-1/staging',
  thumbnailsDir: '/home/test/.proma/design-cache/project-1/canvases/canvas-1/thumbnails',
})

expect(() => resolver.resolveCanvas('project-1', '../escape')).toThrow('Canvas ID 非法')
expect(() => resolver.resolveCanvas('project-1', 'nested/path')).toThrow('Canvas ID 非法')
```

- [ ] **Step 2: 运行测试确认新路径 API 尚不存在**

Run:

```bash
bun test apps/electron/src/main/lib/design/design-paths.test.ts
```

Expected: FAIL，提示 `resolveCanvas`、`canvasesRoot` 或 `canvasSessionsIndexPath` 不存在。

- [ ] **Step 3: 增加 Canvas 专属路径合同**

在 `design-paths.ts` 增加：

```ts
/** 单个 Canvas 的正式文档与可重建缓存路径。 */
export interface CanvasPaths {
  projectId: string
  canvasId: string
  canvasRoot: string
  documentPath: string
  cacheRoot: string
  jobsDir: string
  tracesDir: string
  stagingDir: string
  thumbnailsDir: string
}
```

向 `DesignPaths` 增加：

```ts
  canvasesRoot: string
  canvasSessionsIndexPath: string
```

把 `DesignPathResolver` 改为：

```ts
/** Design 路径解析器，只接受已登记项目和安全稳定 ID。 */
export interface DesignPathResolver {
  /** 根据项目 ID 解析项目级共享路径。 */
  resolve: (projectId: string) => DesignPaths
  /** 根据项目和 Canvas ID 解析 Canvas 专属路径。 */
  resolveCanvas: (projectId: string, canvasId: string) => CanvasPaths
}
```

在 `createDesignPathResolver()` 内把现有项目解析主体提取为局部 `resolveProject` 函数，返回对象使用 `resolve: resolveProject`，再增加：

```ts
    resolveCanvas(projectId: string, canvasId: string): CanvasPaths {
      if (!isSafeDesignStableId(canvasId)) {
        throw new Error(`Canvas ID 非法: ${canvasId}`)
      }
      /** 项目级路径继续由同一个受信任解析入口产生。 */
      const projectPaths = resolveProject(projectId)
      /** Canvas 正式目录只由已验证稳定 ID 拼接。 */
      const canvasRoot = join(projectPaths.canvasesRoot, canvasId)
      /** Canvas 缓存继续位于当前 Proma 数据根，并按项目和 Canvas 双重隔离。 */
      const canvasCacheRoot = join(projectPaths.cacheRoot, 'canvases', canvasId)
      return {
        projectId,
        canvasId,
        canvasRoot,
        documentPath: join(canvasRoot, 'canvas.json'),
        cacheRoot: canvasCacheRoot,
        jobsDir: join(canvasCacheRoot, 'jobs'),
        tracesDir: join(canvasCacheRoot, 'traces'),
        stagingDir: join(canvasCacheRoot, 'staging'),
        thumbnailsDir: join(canvasCacheRoot, 'thumbnails'),
      }
    },
```

在现有 `resolve()` 返回值中加入：

```ts
        canvasesRoot: join(designRoot, 'canvases'),
        canvasSessionsIndexPath: join(designRoot, 'canvases', 'index.json'),
```

注意：不要修改现有 `canvasPath`、`assetsDir`、`contextRoot` 和项目级缓存路径，当前 Design 仍使用旧路径。

- [ ] **Step 4: 运行路径与现有 Design 测试**

Run:

```bash
bun test apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/design-store.test.ts
```

Expected: PASS；旧 `canvasPath` 断言不变，新 Canvas 路径通过。

- [ ] **Step 5: 提交路径扩展**

```bash
git add apps/electron/src/main/lib/design/design-paths.ts apps/electron/src/main/lib/design/design-paths.test.ts
git commit -m "设计：增加多 Canvas 受信任路径"
```

### Task 3: 实现 Canvas 会话原子索引

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-session-store.ts`
- Create: `apps/electron/src/main/lib/design/canvas-session-store.test.ts`

- [ ] **Step 1: 写失败的正常路径和旧 Design 投影测试**

创建 `canvas-session-store.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDesignPathResolver } from './design-paths'
import { CanvasSessionStore } from './canvas-session-store'

describe('CanvasSessionStore', () => {
  /** 每个测试独占的临时项目根。 */
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proma-canvas-session-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** 创建固定时间和 ID 的测试 store。 */
  function createStore(): CanvasSessionStore {
    /** 项目路径解析器只认 project-1。 */
    const pathResolver = createDesignPathResolver({
      getWorkspace: (projectId) => projectId === 'project-1' ? {
        id: projectId,
        name: '项目',
        slug: 'project',
        projectRootPath: root,
        createdAt: 1,
        updatedAt: 1,
      } : undefined,
      getProjectFilesPath: () => root,
      getConfigDir: () => join(root, '.config'),
    })
    return new CanvasSessionStore({
      pathResolver,
      now: () => 100,
      createId: () => 'canvas-created',
    })
  }

  test('Given 旧 Design 画布 When 投影两次 Then 只产生一个默认 Canvas', () => {
    const store = createStore()
    /** 旧画布路径用于触发兼容投影。 */
    const legacyPath = join(root, '.proma', 'design', 'canvas.json')
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    writeFileSync(legacyPath, '{}', 'utf8')

    expect(store.ensureLegacySession('project-1')).toEqual({
      id: 'legacy-design',
      projectId: 'project-1',
      title: '默认设计画布',
      archived: false,
      createdAt: 100,
      updatedAt: 100,
    })
    expect(store.ensureLegacySession('project-1')?.id).toBe('legacy-design')
    expect(store.list({ projectId: 'project-1' })).toHaveLength(1)
  })

  test('Given 项目 When 新建重命名归档 Then 原子索引保存稳定公开字段', () => {
    const store = createStore()
    const created = store.create({ projectId: 'project-1', title: ' App 页面设计 ' })
    expect(created).toMatchObject({
      id: 'canvas-created', projectId: 'project-1', title: 'App 页面设计', archived: false,
    })

    const updated = store.update({
      projectId: 'project-1', canvasId: created.id, title: 'App 页面视觉', archived: true,
    })
    expect(updated).toMatchObject({ title: 'App 页面视觉', archived: true })
    expect(store.list({ projectId: 'project-1', archived: false })).toEqual([])
    expect(store.list({ projectId: 'project-1', archived: true })).toHaveLength(1)

    const indexPath = join(root, '.proma', 'design', 'canvases', 'index.json')
    expect(existsSync(indexPath)).toBe(true)
    expect(JSON.parse(readFileSync(indexPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      projectId: 'project-1',
      sessions: [{ id: 'canvas-created', storageKind: 'native' }],
    })
  })
})
```

- [ ] **Step 2: 运行测试确认 store 尚不存在**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-session-store.test.ts
```

Expected: FAIL，提示无法导入 `canvas-session-store`。

- [ ] **Step 3: 创建完整 CanvasSessionStore**

创建 `canvas-session-store.ts`，实现以下公开合同；内部解析器必须拒绝未知字段、错误 schema、项目 ID 不匹配、重复 ID、非法稳定 ID、非法时间戳和非法 `storageKind`：

```ts
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import type {
  CanvasSessionMeta,
  CreateCanvasSessionInput,
  ListCanvasSessionsInput,
  UpdateCanvasSessionInput,
} from '@proma/shared'
import { CANVAS_SESSION_TITLE_MAX_LENGTH } from '@proma/shared'
import { writeJsonFileAtomic } from '../safe-file'
import type { DesignPathResolver } from './design-paths'
import { isSafeDesignStableId } from './design-paths'

/** Canvas 会话索引当前 schema。 */
const CANVAS_SESSION_INDEX_VERSION = 1
/** 旧项目级 Design 对应的确定性 Canvas ID。 */
export const LEGACY_DESIGN_CANVAS_ID = 'legacy-design'

/** 索引内部记录额外保存实际存储形态，不向 Renderer 暴露。 */
interface CanvasSessionRecord extends CanvasSessionMeta {
  storageKind: 'legacy' | 'native'
}

/** 单项目 Canvas 会话索引。 */
interface CanvasSessionIndex {
  schemaVersion: 1
  projectId: string
  sessions: CanvasSessionRecord[]
  updatedAt: number
}

/** Canvas 会话 store 的稳定依赖。 */
export interface CanvasSessionStoreDependencies {
  pathResolver: Pick<DesignPathResolver, 'resolve'>
  now?: () => number
  createId?: () => string
}

/** 项目级 Canvas 会话索引，所有写入均使用 safe-file 原子提交。 */
export class CanvasSessionStore {
  constructor(private readonly dependencies: CanvasSessionStoreDependencies) {}

  /** 列出项目 Canvas，会返回新数组并按更新时间倒序。 */
  list(input: ListCanvasSessionsInput): CanvasSessionMeta[] {
    const index = this.readIndex(input.projectId)
    return index.sessions
      .filter((session) => input.archived === undefined || session.archived === input.archived)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(toPublicSession)
  }

  /** 幂等登记旧 Design 默认 Canvas；没有旧画布时不写索引。 */
  ensureLegacySession(projectId: string): CanvasSessionMeta | undefined {
    const paths = this.dependencies.pathResolver.resolve(projectId)
    if (!existsSync(paths.canvasPath)) return undefined
    const index = this.readIndex(projectId)
    const existing = index.sessions.find((session) => session.id === LEGACY_DESIGN_CANVAS_ID)
    if (existing) return toPublicSession(existing)
    const now = this.requireNow()
    /** 旧 Design 使用固定 ID，确保重启和重复投影幂等。 */
    const record: CanvasSessionRecord = {
      id: LEGACY_DESIGN_CANVAS_ID,
      projectId,
      title: '默认设计画布',
      archived: false,
      storageKind: 'legacy',
      createdAt: now,
      updatedAt: now,
    }
    index.sessions.push(record)
    index.updatedAt = now
    this.writeIndex(index)
    return toPublicSession(record)
  }

  /** 创建原生 Canvas 会话元数据，不创建 Agent 会话或运行时。 */
  create(input: CreateCanvasSessionInput): CanvasSessionMeta {
    const index = this.readIndex(input.projectId)
    const id = (this.dependencies.createId ?? randomUUID)()
    if (!isSafeDesignStableId(id) || index.sessions.some((session) => session.id === id)) {
      throw new Error(`Canvas ID 非法或重复: ${id}`)
    }
    const now = this.requireNow()
    /** 标题在主进程统一规范化，Renderer 不能写入空白或超长索引值。 */
    const title = normalizeTitle(input.title ?? '新 Canvas')
    const record: CanvasSessionRecord = {
      id,
      projectId: input.projectId,
      title,
      archived: false,
      storageKind: 'native',
      createdAt: now,
      updatedAt: now,
    }
    index.sessions.push(record)
    index.updatedAt = now
    this.writeIndex(index)
    return toPublicSession(record)
  }

  /** 更新 Canvas 标题或归档状态；至少一个字段必须存在。 */
  update(input: UpdateCanvasSessionInput): CanvasSessionMeta {
    if (input.title === undefined && input.archived === undefined) {
      throw new Error('Canvas 会话更新至少需要一个字段')
    }
    const index = this.readIndex(input.projectId)
    const record = index.sessions.find((session) => session.id === input.canvasId)
    if (!record) throw new Error(`Canvas 会话不存在: ${input.canvasId}`)
    if (input.title !== undefined) record.title = normalizeTitle(input.title)
    if (input.archived !== undefined) record.archived = input.archived
    const now = this.requireNow()
    record.updatedAt = now
    index.updatedAt = now
    this.writeIndex(index)
    return toPublicSession(record)
  }

  /** 读取不存在的索引时返回尚未落盘的空索引。 */
  private readIndex(projectId: string): CanvasSessionIndex {
    const paths = this.dependencies.pathResolver.resolve(projectId)
    if (!existsSync(paths.canvasSessionsIndexPath)) {
      return { schemaVersion: CANVAS_SESSION_INDEX_VERSION, projectId, sessions: [], updatedAt: 0 }
    }
    /** 已存在索引损坏时必须显式失败，禁止用空索引覆盖。 */
    const raw = readFileSync(paths.canvasSessionsIndexPath, 'utf8')
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error('Canvas 会话索引 JSON 损坏', { cause: error })
    }
    return parseCanvasSessionIndex(value, projectId)
  }

  /** 创建明确目录后原子提交完整索引。 */
  private writeIndex(index: CanvasSessionIndex): void {
    const paths = this.dependencies.pathResolver.resolve(index.projectId)
    mkdirSync(paths.canvasesRoot, { recursive: true })
    writeJsonFileAtomic(paths.canvasSessionsIndexPath, index)
  }

  /** 返回有限非负时间戳。 */
  private requireNow(): number {
    const now = (this.dependencies.now ?? Date.now)()
    if (!Number.isFinite(now) || now < 0) throw new Error('Canvas 会话时间戳无效')
    return now
  }
}

/** 去除内部 storageKind，避免 Renderer 依赖迁移实现。 */
function toPublicSession(record: CanvasSessionRecord): CanvasSessionMeta {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    archived: record.archived,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** 规范化会话标题并执行稳定长度上限。 */
function normalizeTitle(value: string): string {
  const title = value.trim()
  if (!title) throw new Error('Canvas 会话标题不能为空')
  if (title.length > CANVAS_SESSION_TITLE_MAX_LENGTH) {
    throw new Error(`Canvas 会话标题不能超过 ${CANVAS_SESSION_TITLE_MAX_LENGTH} 个字符`)
  }
  return title
}
```

同一文件增加完整严格解析器；不要把未知对象直接断言为 `CanvasSessionIndex`：

```ts
/** 判断未知值是否为可枚举普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  /** 只接受标准对象或无原型对象。 */
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** 判断对象只包含允许字段且所有必填字段存在。 */
function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  /** 允许字段与必填字段在本索引中相同。 */
  const allowed = new Set(required)
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

/** 判断持久化时间戳为有限非负数字。 */
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 严格解析单条 Canvas 会话内部记录。 */
function parseCanvasSessionRecord(
  value: unknown,
  projectId: string,
  seenIds: Set<string>,
): CanvasSessionRecord {
  const fields = ['id', 'projectId', 'title', 'archived', 'storageKind', 'createdAt', 'updatedAt'] as const
  if (!isRecord(value) || !hasExactKeys(value, fields)) {
    throw new Error('Canvas 会话索引记录字段无效')
  }
  if (!isSafeDesignStableId(value.id) || seenIds.has(value.id)) {
    throw new Error(`Canvas 会话索引包含非法或重复 ID: ${String(value.id)}`)
  }
  if (value.projectId !== projectId) throw new Error('Canvas 会话索引记录项目归属不匹配')
  if (typeof value.title !== 'string' || normalizeTitle(value.title) !== value.title) {
    throw new Error('Canvas 会话索引标题无效')
  }
  if (typeof value.archived !== 'boolean') throw new Error('Canvas 会话索引 archived 无效')
  if (value.storageKind !== 'legacy' && value.storageKind !== 'native') {
    throw new Error('Canvas 会话索引 storageKind 无效')
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.updatedAt < value.createdAt) {
    throw new Error('Canvas 会话索引时间戳无效')
  }
  seenIds.add(value.id)
  return {
    id: value.id,
    projectId,
    title: value.title,
    archived: value.archived,
    storageKind: value.storageKind,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

/** 严格解析单项目 Canvas 会话索引。 */
function parseCanvasSessionIndex(value: unknown, projectId: string): CanvasSessionIndex {
  const fields = ['schemaVersion', 'projectId', 'sessions', 'updatedAt'] as const
  if (!isRecord(value) || !hasExactKeys(value, fields)) {
    throw new Error('Canvas 会话索引根字段无效')
  }
  if (value.schemaVersion !== CANVAS_SESSION_INDEX_VERSION) {
    throw new Error(`不支持的 Canvas 会话索引版本: ${String(value.schemaVersion)}`)
  }
  if (value.projectId !== projectId) throw new Error('Canvas 会话索引项目归属不匹配')
  if (!Array.isArray(value.sessions)) throw new Error('Canvas 会话索引 sessions 无效')
  if (!isTimestamp(value.updatedAt)) throw new Error('Canvas 会话索引 updatedAt 无效')
  /** 同一项目内 Canvas ID 必须唯一。 */
  const seenIds = new Set<string>()
  /** 逐项创建新对象，禁止未知原型进入业务层。 */
  const sessions = value.sessions.map((session) => parseCanvasSessionRecord(session, projectId, seenIds))
  return {
    schemaVersion: CANVAS_SESSION_INDEX_VERSION,
    projectId,
    sessions,
    updatedAt: value.updatedAt,
  }
}
```

- [ ] **Step 4: 增加损坏、重复和项目隔离测试**

在 `canvas-session-store.test.ts` 增加：

```ts
test('Given 损坏索引 When 列表 Then 明确失败且不覆盖主文件', () => {
  const store = createStore()
  const indexPath = join(root, '.proma', 'design', 'canvases', 'index.json')
  mkdirSync(join(root, '.proma', 'design', 'canvases'), { recursive: true })
  writeFileSync(indexPath, '{broken', 'utf8')
  expect(() => store.list({ projectId: 'project-1' })).toThrow('Canvas 会话索引 JSON 损坏')
  expect(readFileSync(indexPath, 'utf8')).toBe('{broken')
})

test('Given 非法标题和空更新 When 写入 Then 在原子提交前拒绝', () => {
  const store = createStore()
  expect(() => store.create({ projectId: 'project-1', title: '   ' })).toThrow('标题不能为空')
  const created = store.create({ projectId: 'project-1', title: 'Canvas' })
  expect(() => store.update({ projectId: 'project-1', canvasId: created.id })).toThrow('至少需要一个字段')
})
```

- [ ] **Step 5: 运行 store 和 safe-file 回归**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-session-store.test.ts apps/electron/src/main/lib/safe-file.test.ts
```

Expected: PASS；索引通过 `.tmp -> rename` 原子提交，损坏主文件不被覆盖。

- [ ] **Step 6: 提交 CanvasSessionStore**

```bash
git add apps/electron/src/main/lib/design/canvas-session-store.ts apps/electron/src/main/lib/design/canvas-session-store.test.ts
git commit -m "设计：实现 Canvas 会话原子索引"
```

### Task 4: 接通 Canvas 会话 IPC 与主进程生命周期

**Files:**
- Create: `apps/electron/src/main/lib/design/canvas-session-ipc.ts`
- Create: `apps/electron/src/main/lib/design/canvas-session-ipc.test.ts`
- Modify: `apps/electron/src/main/ipc.ts`

- [ ] **Step 1: 写失败的 IPC 授权与守卫测试**

创建 `canvas-session-ipc.test.ts`，使用记录型 registrar 和固定 sender：

```ts
import { describe, expect, test } from 'bun:test'
import { DESIGN_IPC_CHANNELS } from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { registerCanvasSessionIpcHandlers } from './canvas-session-ipc'

test('Given 主窗口 When 列出和新建 Canvas Then 经过项目写守卫并广播', async () => {
  /** 记录每个通道注册的 handler。 */
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  /** 记录项目写守卫收到的项目 ID。 */
  const guardedProjects: string[] = []
  /** 记录成功广播的业务事件。 */
  const sent: unknown[] = []
  /** 伪造唯一授权主窗口。 */
  const sender = { id: 7, isDestroyed: () => false, send: (_channel: string, value: unknown) => sent.push(value) } as unknown as WebContents
  /** store 调用记录。 */
  const calls: string[] = []

  const registration = registerCanvasSessionIpcHandlers({
    ipc: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    listAuthorizedWebContents: () => [sender],
    guard: {
      runWorkspaceWrite: (projectId, effect) => {
        guardedProjects.push(projectId)
        return effect()
      },
    },
    sessions: {
      ensureLegacySession: () => { calls.push('ensure'); return undefined },
      list: () => { calls.push('list'); return [] },
      create: (input) => ({
        id: 'canvas-1', projectId: input.projectId, title: input.title ?? '新 Canvas',
        archived: false, createdAt: 1, updatedAt: 1,
      }),
      update: () => { throw new Error('本用例不调用 update') },
    },
    getProjectReadOnlyReason: () => undefined,
  })

  const event = { sender } as IpcMainInvokeEvent
  expect(await handlers.get(DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS)?.(event, { projectId: 'project-1' })).toEqual([])
  expect(await handlers.get(DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION)?.(event, { projectId: 'project-1', title: '页面设计' })).toMatchObject({ id: 'canvas-1' })
  expect(guardedProjects).toEqual(['project-1', 'project-1'])
  expect(calls).toEqual(['ensure', 'list'])
  expect(sent).toEqual([{ projectId: 'project-1', canvasId: 'canvas-1', cause: 'created' }])
  registration.dispose()
  expect(handlers.size).toBe(0)
})
```

再增加三个边界用例：未授权 sender 拒绝、额外输入字段拒绝、只读项目拒绝 create/update 且不广播。

- [ ] **Step 2: 运行测试确认注册器尚不存在**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-session-ipc.test.ts
```

Expected: FAIL，提示无法导入 `canvas-session-ipc`。

- [ ] **Step 3: 实现独立 IPC 注册器**

创建 `canvas-session-ipc.ts`，公开以下窄接口：

```ts
import { DESIGN_IPC_CHANNELS } from '@proma/shared'
import type {
  CanvasSessionChangeEvent,
  CanvasSessionMeta,
  CreateCanvasSessionInput,
  ListCanvasSessionsInput,
  UpdateCanvasSessionInput,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { WorkspaceOperationGuard } from '../workspace-operation-guard'
import type { CanvasSessionStore } from './canvas-session-store'

/** Canvas 会话 IPC handler 的最小签名。 */
type CanvasSessionIpcHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 可注入、可清理的 IPC registrar。 */
export interface CanvasSessionIpcRegistrar {
  handle: (channel: string, handler: CanvasSessionIpcHandler) => void
  removeHandler: (channel: string) => void
}

/** IPC 实际依赖的 Canvas 会话 store 窄接口。 */
type CanvasSessionStoreContract = Pick<
  CanvasSessionStore,
  'ensureLegacySession' | 'list' | 'create' | 'update'
>

/** 注册 Canvas 会话 IPC 的可信依赖。 */
export interface CanvasSessionIpcOptions {
  ipc: CanvasSessionIpcRegistrar
  listAuthorizedWebContents: () => WebContents[]
  guard: Pick<WorkspaceOperationGuard, 'runWorkspaceWrite'>
  sessions: CanvasSessionStoreContract
  getProjectReadOnlyReason: (projectId: string) => string | undefined
}

/** 注册结果用于退出和测试清理。 */
export interface CanvasSessionIpcRegistration {
  channels: string[]
  dispose: () => void
}
```

在同一文件补充完整注册实现：

```ts
import { isSafeDesignStableId } from './design-paths'

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验必填字段和允许字段。 */
function hasKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed)
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowedKeys.has(key))
}

/** 解析查询请求，拒绝路径和未知字段。 */
function parseListInput(value: unknown): ListCanvasSessionsInput {
  if (!isRecord(value) || !hasKeys(value, ['projectId'], ['projectId', 'archived'])) {
    throw new Error('Canvas 会话列表参数无效')
  }
  if (!isSafeDesignStableId(value.projectId)) throw new Error('Canvas 项目 ID 非法')
  if (value.archived !== undefined && typeof value.archived !== 'boolean') {
    throw new Error('Canvas archived 参数无效')
  }
  return {
    projectId: value.projectId,
    ...(value.archived === undefined ? {} : { archived: value.archived }),
  }
}

/** 解析新建请求，标题的内容上限由 store 统一执行。 */
function parseCreateInput(value: unknown): CreateCanvasSessionInput {
  if (!isRecord(value) || !hasKeys(value, ['projectId'], ['projectId', 'title'])) {
    throw new Error('Canvas 会话新建参数无效')
  }
  if (!isSafeDesignStableId(value.projectId)) throw new Error('Canvas 项目 ID 非法')
  if (value.title !== undefined && typeof value.title !== 'string') {
    throw new Error('Canvas title 参数无效')
  }
  return {
    projectId: value.projectId,
    ...(value.title === undefined ? {} : { title: value.title }),
  }
}

/** 解析更新请求，只允许标题和归档状态。 */
function parseUpdateInput(value: unknown): UpdateCanvasSessionInput {
  if (!isRecord(value)
    || !hasKeys(value, ['projectId', 'canvasId'], ['projectId', 'canvasId', 'title', 'archived'])) {
    throw new Error('Canvas 会话更新参数无效')
  }
  if (!isSafeDesignStableId(value.projectId) || !isSafeDesignStableId(value.canvasId)) {
    throw new Error('Canvas 项目或会话 ID 非法')
  }
  if (value.title === undefined && value.archived === undefined) {
    throw new Error('Canvas 会话更新至少需要一个字段')
  }
  if (value.title !== undefined && typeof value.title !== 'string') {
    throw new Error('Canvas title 参数无效')
  }
  if (value.archived !== undefined && typeof value.archived !== 'boolean') {
    throw new Error('Canvas archived 参数无效')
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.archived === undefined ? {} : { archived: value.archived }),
  }
}

/** 确认调用来自当前授权主窗口。 */
function assertAuthorizedSender(event: IpcMainInvokeEvent, options: CanvasSessionIpcOptions): void {
  const authorized = options.listAuthorizedWebContents().some((contents) => (
    !contents.isDestroyed() && contents.id === event.sender.id
  ))
  if (!authorized) throw new Error('无权访问 Canvas 会话')
}

/** 写入口在进入项目 guard 前拒绝离线或迁移项目。 */
function requireWritableProject(projectId: string, options: CanvasSessionIpcOptions): void {
  const reason = options.getProjectReadOnlyReason(projectId)
  if (reason) throw new Error(reason)
}

/** 只在成功提交后向当前授权窗口广播公开业务事件。 */
function broadcastChange(options: CanvasSessionIpcOptions, event: CanvasSessionChangeEvent): void {
  for (const contents of options.listAuthorizedWebContents()) {
    if (!contents.isDestroyed()) contents.send(DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED, event)
  }
}

/** 注册 Canvas 会话 IPC，并返回可重复调用的清理函数。 */
export function registerCanvasSessionIpcHandlers(
  options: CanvasSessionIpcOptions,
): CanvasSessionIpcRegistration {
  /** 本注册器拥有的固定通道。 */
  const channels = [
    DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS,
    DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION,
    DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION,
  ]
  /** 热重载前先移除同名旧 handler。 */
  for (const channel of channels) options.ipc.removeHandler(channel)

  options.ipc.handle(DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS, (event, value): CanvasSessionMeta[] => {
    assertAuthorizedSender(event, options)
    const input = parseListInput(value)
    /** 只读项目不允许兼容投影写入，但仍可读取已有索引。 */
    if (options.getProjectReadOnlyReason(input.projectId)) return options.sessions.list(input)
    return options.guard.runWorkspaceWrite(input.projectId, () => {
      options.sessions.ensureLegacySession(input.projectId)
      return options.sessions.list(input)
    })
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION, (event, value): CanvasSessionMeta => {
    assertAuthorizedSender(event, options)
    const input = parseCreateInput(value)
    requireWritableProject(input.projectId, options)
    const session = options.guard.runWorkspaceWrite(input.projectId, () => options.sessions.create(input))
    broadcastChange(options, { projectId: input.projectId, canvasId: session.id, cause: 'created' })
    return session
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION, (event, value): CanvasSessionMeta => {
    assertAuthorizedSender(event, options)
    const input = parseUpdateInput(value)
    requireWritableProject(input.projectId, options)
    const session = options.guard.runWorkspaceWrite(input.projectId, () => options.sessions.update(input))
    broadcastChange(options, { projectId: input.projectId, canvasId: session.id, cause: 'updated' })
    return session
  })

  /** 清理函数只移除本注册器声明的通道。 */
  let disposed = false
  return {
    channels: [...channels],
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const channel of channels) options.ipc.removeHandler(channel)
    },
  }
}
```

- [ ] **Step 4: 在主进程构造和注册 store**

在 `apps/electron/src/main/ipc.ts` 增加导入：

```ts
import { CanvasSessionStore } from './lib/design/canvas-session-store'
import { registerCanvasSessionIpcHandlers } from './lib/design/canvas-session-ipc'
```

在现有 `designPathResolver` 和 `workspaceOperationGuard` 初始化完成后创建：

```ts
  /** Canvas 顶层会话使用独立索引，禁止写入 Agent 会话索引。 */
  const canvasSessionStore = new CanvasSessionStore({ pathResolver: designPathResolver })
```

把现有 `getProjectReadOnlyReason` 内联函数提取为同作用域常量，供 Design IPC 与 Canvas Session IPC 共用：

```ts
  /** 项目离线或迁移时返回稳定 Design/Canvas 只读原因。 */
  const getDesignProjectReadOnlyReason = (projectId: string): string | undefined => {
    const workspace = getAgentWorkspace(projectId)
    if (!workspace) return undefined
    const rootStatus = getLocalProjectRootStatus(workspace.projectRootPath)
    if (rootStatus && rootStatus !== 'available') return '项目路径不可访问，设计工作区已切换为只读'
    if (getWorkspaceOperationBlockReason(projectId)) return '项目路径不可访问，设计工作区已切换为只读'
    return undefined
  }
```

先注册 Canvas 会话 IPC，再注册现有 Design IPC：

```ts
  registerCanvasSessionIpcHandlers({
    ipc: ipcMain,
    listAuthorizedWebContents: () => {
      const contents = getStoredMainWindow()?.webContents
      return contents && !contents.isDestroyed() ? [contents] : []
    },
    guard: workspaceOperationGuard,
    sessions: canvasSessionStore,
    getProjectReadOnlyReason: getDesignProjectReadOnlyReason,
  })
```

现有 `registerDesignIpcHandlers` 改为引用 `getDesignProjectReadOnlyReason`，不要改变其其他依赖。

- [ ] **Step 5: 运行 IPC 与 Design 集成回归**

Run:

```bash
bun test apps/electron/src/main/lib/design/canvas-session-ipc.test.ts apps/electron/src/main/lib/design/design-ipc.test.ts
```

Expected: PASS；未授权、额外字段、只读和广播边界通过，现有 Design IPC 行为不变。

- [ ] **Step 6: 提交主进程接入**

```bash
git add apps/electron/src/main/lib/design/canvas-session-ipc.ts apps/electron/src/main/lib/design/canvas-session-ipc.test.ts apps/electron/src/main/ipc.ts
git commit -m "设计：接通 Canvas 会话主进程接口"
```

### Task 5: 接通 Preload 与 Renderer adapter

**Files:**
- Modify: `apps/electron/src/preload/design-preload.ts`
- Modify: `apps/electron/src/preload/design-preload.test.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.ts`
- Modify: `apps/electron/src/renderer/lib/design-adapter.test.ts`

- [ ] **Step 1: 写失败的 Preload 通道透传测试**

在 `design-preload.test.ts` 的 `calls` 数组前部加入：

```ts
      [() => api.listCanvasSessions({ projectId: 'p1', archived: false }), DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS, [{ projectId: 'p1', archived: false }]],
      [() => api.createCanvasSession({ projectId: 'p1', title: '页面设计' }), DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION, [{ projectId: 'p1', title: '页面设计' }]],
      [() => api.updateCanvasSession({ projectId: 'p1', canvasId: 'canvas-1', archived: true }), DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION, [{ projectId: 'p1', canvasId: 'canvas-1', archived: true }]],
```

在订阅测试中加入 `onCanvasSessionChanged()`，并验证业务 payload 与 listener 引用原样传递。

- [ ] **Step 2: 运行 Preload 测试确认 API 尚不存在**

Run:

```bash
bun test apps/electron/src/preload/design-preload.test.ts
```

Expected: FAIL，提示三个 Canvas 方法和变化订阅不存在。

- [ ] **Step 3: 扩展 DesignPreloadApi**

在 `design-preload.ts` 增加类型导入，并向 `DesignPreloadApi` 加入：

```ts
  listCanvasSessions: (input: ListCanvasSessionsInput) => Promise<CanvasSessionMeta[]>
  createCanvasSession: (input: CreateCanvasSessionInput) => Promise<CanvasSessionMeta>
  updateCanvasSession: (input: UpdateCanvasSessionInput) => Promise<CanvasSessionMeta>
  onCanvasSessionChanged: (listener: (event: CanvasSessionChangeEvent) => void) => () => void
```

在工厂返回值中增加：

```ts
    listCanvasSessions: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS, input) as Promise<CanvasSessionMeta[]>,
    createCanvasSession: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION, input) as Promise<CanvasSessionMeta>,
    updateCanvasSession: (input) => ipc.invoke(DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION, input) as Promise<CanvasSessionMeta>,
    onCanvasSessionChanged: (listener) => {
      /** Electron event 对 Renderer 隐藏，只传 Canvas 会话业务变化。 */
      const handler = (_event: IpcRendererEvent, value: unknown): void => listener(value as CanvasSessionChangeEvent)
      ipc.on(DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED, handler)
      return () => ipc.removeListener(DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED, handler)
    },
```

- [ ] **Step 4: 写失败的 Renderer adapter 透传测试**

在 `design-adapter.test.ts` 的完整 API 用例中增加：

```ts
    /** Canvas 会话 API 收到的原始参数。 */
    const canvasInputs: unknown[] = []
    /** Canvas 会话公开返回值。 */
    const canvasSession = {
      id: 'canvas-1', projectId: 'project-1', title: '页面设计',
      archived: false, createdAt: 1, updatedAt: 1,
    }
```

向替身 API 增加四个方法，并验证：

```ts
      listCanvasSessions: async (input) => { canvasInputs.push(input); return [canvasSession] },
      createCanvasSession: async (input) => { canvasInputs.push(input); return canvasSession },
      updateCanvasSession: async (input) => { canvasInputs.push(input); return canvasSession },
      onCanvasSessionChanged: () => () => undefined,
```

调用 adapter 后断言输入对象身份不变：

```ts
    const listCanvasInput = { projectId: 'project-1', archived: false }
    const createCanvasInput = { projectId: 'project-1', title: '页面设计' }
    const updateCanvasInput = { projectId: 'project-1', canvasId: 'canvas-1', archived: true }
    expect(await adapter.listCanvasSessions(listCanvasInput)).toEqual([canvasSession])
    expect(await adapter.createCanvasSession(createCanvasInput)).toBe(canvasSession)
    expect(await adapter.updateCanvasSession(updateCanvasInput)).toBe(canvasSession)
    expect(canvasInputs).toEqual([listCanvasInput, createCanvasInput, updateCanvasInput])
```

- [ ] **Step 5: 扩展 DesignAdapter**

在 `design-adapter.ts` 加入对应共享类型导入，并向 `DesignAdapter` 增加：

```ts
  listCanvasSessions: (input: ListCanvasSessionsInput) => ReturnType<DesignPreloadApi['listCanvasSessions']>
  createCanvasSession: (input: CreateCanvasSessionInput) => ReturnType<DesignPreloadApi['createCanvasSession']>
  updateCanvasSession: (input: UpdateCanvasSessionInput) => ReturnType<DesignPreloadApi['updateCanvasSession']>
  onCanvasSessionChanged: (listener: (event: CanvasSessionChangeEvent) => void) => ReturnType<DesignPreloadApi['onCanvasSessionChanged']>
```

在 `createDesignAdapter()` 返回值中增加：

```ts
    listCanvasSessions: (input) => requireMethod(api, 'listCanvasSessions')(input),
    createCanvasSession: (input) => requireMethod(api, 'createCanvasSession')(input),
    updateCanvasSession: (input) => requireMethod(api, 'updateCanvasSession')(input),
    onCanvasSessionChanged: (listener) => requireMethod(api, 'onCanvasSessionChanged')(listener),
```

- [ ] **Step 6: 运行 Preload 与 adapter 测试**

Run:

```bash
bun test apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts
```

Expected: PASS；Renderer 只得到公开元数据，不得到索引路径或 `storageKind`。

- [ ] **Step 7: 提交 Renderer 合同接入**

```bash
git add apps/electron/src/preload/design-preload.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.ts apps/electron/src/renderer/lib/design-adapter.test.ts
git commit -m "设计：暴露 Canvas 会话渲染接口"
```

### Task 6: 阶段回归与交付检查

**Files:**
- Verify only; do not modify unrelated files

- [ ] **Step 1: 运行第一阶段定向测试**

Run:

```bash
bun test packages/shared/src/types/design.test.ts apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/canvas-session-store.test.ts apps/electron/src/main/lib/design/canvas-session-ipc.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 2: 运行现有 Design 与会话可见性回归**

Run:

```bash
bun test apps/electron/src/main/lib/design/design-store.test.ts apps/electron/src/main/lib/design/design-ipc.test.ts apps/electron/src/main/lib/design/design-job-manager.test.ts apps/electron/src/main/lib/agent-session-visibility.test.ts apps/electron/src/renderer/lib/agent-session-list.test.ts
```

Expected: 全部 PASS；Canvas 会话未进入 `AgentSessionMeta`，现有 Design 内部会话过滤不变。

- [ ] **Step 3: 运行类型检查**

Run:

```bash
bun run typecheck
```

Expected: PASS，无 TypeScript 错误。

- [ ] **Step 4: 运行 Electron 构建**

Run:

```bash
bun run electron:build
```

Expected: PASS；新增主进程文件进入 bundle，Preload 类型和 CJS 构建正常。

- [ ] **Step 5: 检查提交范围和空白错误**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` 无输出；状态只包含本阶段文件和进入实施前已有的未提交改动。已有 `?? .superpowers/` 可以继续存在，但本阶段任何提交都不得暂存它。

- [ ] **Step 6: 更新项目记忆并提交阶段收口**

在 `MEMORY.md` 会话记录增加一条：Canvas 顶层会话使用独立原子索引，不写入 Agent 会话索引；旧 Design 以固定 `legacy-design` ID 幂等投影，现有 Design 执行继续使用旧路径。先检查该文件进入实施前的差异；如果已有未提交内容，只更新文件并在阶段报告中说明，不单独暂存或提交整份文件。

```bash
git diff -- MEMORY.md
```

## 第一阶段不做的事项

- 不修改左侧会话列表和顶部 Design 标签；
- 不让现有 `DesignStore` 接受 `canvasId`；
- 不移动 `.proma/design/canvas.json`、assets、jobs 或 traces；
- 不创建 image module、Agent 节点、typed edge 或 stale；
- 不创建或运行 `webview` 原型；
- 不把 Canvas 会话加入 Agent、LAN、mobile、Automation 或 Collaboration；
- 不删除旧 Design 数据和入口。

这些边界保证本阶段可以独立合入并回退，同时为下一阶段的多 Canvas Renderer 提供稳定 API。
