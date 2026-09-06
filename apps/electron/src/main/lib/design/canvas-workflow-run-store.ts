import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  CANVAS_WORKFLOW_RUN_DURATION_MS,
  parseCanvasWorkflowRun,
} from '@proma/shared'
import type {
  CanvasTarget,
  CanvasWorkflowRun,
  CanvasWorkflowRunListInput,
  CanvasWorkflowRunNode,
  CanvasWorkflowRunOwner,
  CanvasWorkflowRunPage,
} from '@proma/shared'
import { ensureDirectoryDurable, writeJsonFileAtomicSecure } from '../safe-file'
import type { DesignPathResolver } from './design-paths'

/** 单个 workflow run journal 的最大字节数。 */
const MAX_WORKFLOW_RUN_BYTES = 512 * 1024
/** 单页最多返回的历史数量。 */
const MAX_WORKFLOW_RUN_PAGE_SIZE = 256
/** workflow run 正式文件名白名单。 */
const WORKFLOW_RUN_FILE_PATTERN = /^workflow-run-([a-f0-9]{48})\.json$/

/** 创建 workflow run 时由首次计划固定的不可变事实。 */
export interface CreateCanvasWorkflowRunInput extends CanvasTarget {
  operationId: string
  owner: CanvasWorkflowRunOwner
  initialCanvasRevision: number
  rootNodeIds: string[]
  goal: string
  nodes: CanvasWorkflowRunNode[]
  maxMediaRuns: number
  consumedMediaRuns: number
  maxDurationMs?: number
  autoResumeAfterAdoption: boolean
}

/** workflow run store 只管理持久运行事实，不读取或改写 Canvas 文档。 */
export interface CanvasWorkflowRunStore {
  create: (input: CreateCanvasWorkflowRunInput) => CanvasWorkflowRun
  get: (target: CanvasTarget, runId: string) => CanvasWorkflowRun
  findByOperation: (
    target: CanvasTarget,
    operationId: string,
    owner: CanvasWorkflowRunOwner,
  ) => CanvasWorkflowRun | null
  listPage: (
    target: CanvasTarget,
    options?: Pick<CanvasWorkflowRunListInput, 'cursor' | 'limit'> & { ownerSessionId?: string },
  ) => CanvasWorkflowRunPage
  /** 为一次异步推进持有跨进程租约；已有活跃推进时返回 null。 */
  acquireLease: (target: CanvasTarget, runId: string) => (() => void) | null
  save: (run: CanvasWorkflowRun, expectedRevision: number) => CanvasWorkflowRun
}

/** Store 生产依赖，路径和 workspace lease 均由 Host 注入。 */
export interface CanvasWorkflowRunStoreDependencies {
  pathResolver: Pick<DesignPathResolver, 'resolveCanvas'>
  runWorkspaceWrite: <T>(projectId: string, effect: () => T) => T
  now?: () => number
}

/** 为同一 Canvas operation 派生兼容旧 journal 的稳定 run ID。 */
export function createCanvasWorkflowRunId(
  projectId: string,
  canvasId: string,
  operationId: string,
  owner?: CanvasWorkflowRunOwner,
): string {
  return createHash('sha256').update(JSON.stringify([
    owner ? 'canvas-workflow-run-owner' : 'canvas-workflow-run',
    projectId,
    canvasId,
    operationId,
    ...(owner ? [owner.sessionId, owner.runStartedAt] : []),
  ])).digest('hex').slice(0, 48)
}

/** 判断一次调用是否精确属于持久运行的原始父 Agent 代次。 */
function isSameOwner(left: CanvasWorkflowRunOwner, right: CanvasWorkflowRunOwner): boolean {
  return left.sessionId === right.sessionId && left.runStartedAt === right.runStartedAt
}

/** 从创建输入构造与持久 run 相同的不可变事实投影。 */
function immutableCreateFactsFromInput(input: CreateCanvasWorkflowRunInput): object {
  return {
    projectId: input.projectId,
    canvasId: input.canvasId,
    operationId: input.operationId,
    owner: input.owner,
    initialCanvasRevision: input.initialCanvasRevision,
    rootNodeIds: input.rootNodeIds,
    goal: input.goal,
    nodes: input.nodes.map((node) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      identityHash: node.identityHash,
      plannedArtifactHash: node.plannedArtifactHash,
      mediaConfigRevision: node.mediaConfigRevision,
      inputBindings: node.inputBindings.map((binding) => ({
        targetInputKey: binding.targetInputKey,
        requiredKind: binding.requiredKind,
        sourceNodeId: binding.sourceNodeId,
        sourceOutputKey: binding.sourceOutputKey,
      })),
      dependencyNodeIds: node.dependencyNodeIds,
    })),
    maxMediaRuns: input.maxMediaRuns,
    maxDurationMs: input.maxDurationMs ?? CANVAS_WORKFLOW_RUN_DURATION_MS,
    autoResumeAfterAdoption: input.autoResumeAfterAdoption,
  }
}

/** 只比较重放时必须保持一致的首次授权与固定计划。 */
function immutableCreateFacts(run: CanvasWorkflowRun): object {
  return {
    projectId: run.projectId,
    canvasId: run.canvasId,
    operationId: run.operationId,
    owner: run.owner,
    initialCanvasRevision: run.initialCanvasRevision,
    rootNodeIds: run.rootNodeIds,
    goal: run.goal,
    nodes: run.nodes.map((node) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      identityHash: node.identityHash,
      plannedArtifactHash: node.plannedArtifactHash,
      mediaConfigRevision: node.mediaConfigRevision,
      inputBindings: node.inputBindings.map((binding) => ({
        targetInputKey: binding.targetInputKey,
        requiredKind: binding.requiredKind,
        sourceNodeId: binding.sourceNodeId,
        sourceOutputKey: binding.sourceOutputKey,
      })),
      dependencyNodeIds: node.dependencyNodeIds,
    })),
    maxMediaRuns: run.budget.maxMediaRuns,
    maxDurationMs: run.budget.maxDurationMs,
    autoResumeAfterAdoption: run.autoResumeAfterAdoption,
  }
}

/** 将稳定排序位置编码成不含路径字符的游标。 */
function encodeCursor(run: CanvasWorkflowRun): string {
  return `${run.updatedAt}-${run.id}`
}

/** 解析历史游标并拒绝任意路径或无界内容。 */
function parseCursor(cursor: string | undefined): { updatedAt: number; id: string } | null {
  if (cursor === undefined) return null
  const match = /^(\d+)-([a-f0-9]{48})$/.exec(cursor)
  const updatedAt = match ? Number(match[1]) : Number.NaN
  if (!match || !Number.isSafeInteger(updatedAt)) throw new Error('CANVAS_WORKFLOW_RUN_CURSOR_INVALID')
  return { updatedAt, id: match[2]! }
}

/** 按历史列表合同比较运行：更新时间降序，同一时间按 ID 升序。 */
function compareWorkflowRuns(left: CanvasWorkflowRun, right: CanvasWorkflowRun): number {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
}

/** 创建本地优先、带跨进程 CAS 的 workflow run store。 */
export function createCanvasWorkflowRunStore(
  dependencies: CanvasWorkflowRunStoreDependencies,
): CanvasWorkflowRunStore {
  const now = dependencies.now ?? Date.now

  /** 返回并按需创建实际 workflow run 目录，拒绝 symlink。 */
  const directory = (target: CanvasTarget, create = false): string => {
    const transactionsDir = dependencies.pathResolver.resolveCanvas(
      target.projectId, target.canvasId,
    ).transactionsDir
    if (!existsSync(transactionsDir)) {
      if (!create) return join(transactionsDir, 'workflow-runs')
      ensureDirectoryDurable(transactionsDir)
    }
    if (!lstatSync(transactionsDir).isDirectory() || lstatSync(transactionsDir).isSymbolicLink()) {
      throw new Error('CANVAS_WORKFLOW_RUN_PATH_INVALID')
    }
    const result = join(transactionsDir, 'workflow-runs')
    if (!existsSync(result)) {
      if (!create) return result
      ensureDirectoryDurable(result)
    }
    const stat = lstatSync(result)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CANVAS_WORKFLOW_RUN_PATH_INVALID')
    return result
  }

  /** 从安全普通文件读取、限长并复核目标归属。 */
  const load = (target: CanvasTarget, runId: string): CanvasWorkflowRun => {
    if (!/^[a-f0-9]{48}$/.test(runId)) throw new Error('CANVAS_WORKFLOW_RUN_ID_INVALID')
    const path = join(directory(target), `workflow-run-${runId}.json`)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_WORKFLOW_RUN_BYTES) {
      throw new Error('CANVAS_WORKFLOW_RUN_PATH_INVALID')
    }
    const run = parseCanvasWorkflowRun(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    if (run.id !== runId || run.projectId !== target.projectId || run.canvasId !== target.canvasId) {
      throw new Error('CANVAS_WORKFLOW_RUN_INVALID')
    }
    return run
  }

  /** 检查崩溃遗留锁的进程与年龄，只有可证明失效时才回收。 */
  const recoverStaleLock = (lockPath: string): void => {
    try {
      const stat = lstatSync(lockPath)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CANVAS_WORKFLOW_RUN_LOCK_INVALID')
      const ownerPath = join(lockPath, 'owner.json')
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: unknown; createdAt?: unknown }
      if (!Number.isSafeInteger(owner.pid) || !Number.isSafeInteger(owner.createdAt)) {
        throw new Error('CANVAS_WORKFLOW_RUN_LOCK_INVALID')
      }
      let alive = true
      try {
        process.kill(owner.pid as number, 0)
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === 'EPERM'
      }
      if (alive) throw new Error('CANVAS_WORKFLOW_RUN_BUSY')
      rmSync(lockPath, { recursive: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }

  /** 通过原子目录声明串行化跨进程 create/save，并返回精确释放函数。 */
  const acquireLock = (lockPath: string): (() => void) => {
    const token = randomUUID()
    const claimPath = `${lockPath}.claim-${process.pid}-${token}`
    mkdirSync(claimPath)
    writeFileSync(join(claimPath, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: now(), token }), {
      flag: 'wx', mode: 0o600,
    })
    try {
      renameSync(claimPath, lockPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') {
        rmSync(claimPath, { recursive: true, force: true })
        throw error
      }
      try {
        recoverStaleLock(lockPath)
        renameSync(claimPath, lockPath)
      } catch (recoveryError) {
        rmSync(claimPath, { recursive: true, force: true })
        throw recoveryError
      }
    }
    return () => {
      try {
        const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')) as { token?: unknown }
        if (owner.token === token) rmSync(lockPath, { recursive: true })
      } catch {
        // 锁身份变化时不删除其他进程的声明。
      }
    }
  }

  const store: CanvasWorkflowRunStore = {
    create(input) {
      return dependencies.runWorkspaceWrite(input.projectId, () => {
        /** 所有同 operation 创建者共用旧格式锁，保证 owner 分流在跨进程下仍为单一决策。 */
        const legacyRunId = createCanvasWorkflowRunId(input.projectId, input.canvasId, input.operationId)
        /** owner-qualified ID 仅在旧格式 ID 已归属其它父运行时启用。 */
        const ownerRunId = createCanvasWorkflowRunId(
          input.projectId,
          input.canvasId,
          input.operationId,
          input.owner,
        )
        const runDirectory = directory(input, true)
        const release = acquireLock(join(runDirectory, `workflow-run-${legacyRunId}.lock`))
        try {
          /** 精确 owner 优先复用历史旧格式 ID；冲突 owner 使用独立命名空间。 */
          let runId = legacyRunId
          const legacyPath = join(runDirectory, `workflow-run-${legacyRunId}.json`)
          if (existsSync(legacyPath)) {
            const legacy = load(input, legacyRunId)
            if (!isSameOwner(legacy.owner, input.owner)) runId = ownerRunId
          } else if (existsSync(join(runDirectory, `workflow-run-${ownerRunId}.json`))) {
            /** 兼容旧格式文件被外部恢复流程移走后仍可精确命中 owner journal。 */
            runId = ownerRunId
          }
          const path = join(runDirectory, `workflow-run-${runId}.json`)
          if (existsSync(path)) {
            const existing = load(input, runId)
            const proposedFacts = immutableCreateFactsFromInput(input)
            if (JSON.stringify(immutableCreateFacts(existing)) !== JSON.stringify(proposedFacts)) {
              throw new Error('CANVAS_WORKFLOW_OPERATION_CONFLICT')
            }
            return existing
          }
          const timestamp = now()
          const maxDurationMs = input.maxDurationMs ?? CANVAS_WORKFLOW_RUN_DURATION_MS
          const run = parseCanvasWorkflowRun({
            schemaVersion: 1,
            id: runId,
            revision: 0,
            projectId: input.projectId,
            canvasId: input.canvasId,
            operationId: input.operationId,
            owner: input.owner,
            status: 'running',
            initialCanvasRevision: input.initialCanvasRevision,
            observedCanvasRevision: input.initialCanvasRevision,
            rootNodeIds: input.rootNodeIds,
            goal: input.goal,
            nodes: input.nodes,
            budget: {
              maxMediaRuns: input.maxMediaRuns,
              consumedMediaRuns: input.consumedMediaRuns,
              remainingMediaRuns: input.maxMediaRuns - input.consumedMediaRuns,
              maxDurationMs,
              remainingDurationMs: maxDurationMs,
              activeStartedAt: timestamp,
            },
            autoResumeAfterAdoption: input.autoResumeAfterAdoption,
            cancelRequestedAt: null,
            cancelledAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          writeJsonFileAtomicSecure(path, run)
          return structuredClone(run)
        } finally {
          release()
        }
      })
    },

    get(target, runId) {
      try {
        return structuredClone(load(target, runId))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('CANVAS_WORKFLOW_RUN_NOT_FOUND')
        }
        throw error
      }
    },

    findByOperation(target, operationId, owner) {
      /** 先探测兼容旧格式 ID，只有原 owner 不匹配时才进入 owner-qualified 命名空间。 */
      const legacyRunId = createCanvasWorkflowRunId(target.projectId, target.canvasId, operationId)
      try {
        const legacy = store.get(target, legacyRunId)
        if (isSameOwner(legacy.owner, owner)) return legacy
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'CANVAS_WORKFLOW_RUN_NOT_FOUND') throw error
      }
      /** 新 owner 只读取由完整父运行身份派生的精确 journal。 */
      const ownerRunId = createCanvasWorkflowRunId(
        target.projectId,
        target.canvasId,
        operationId,
        owner,
      )
      try {
        const owned = store.get(target, ownerRunId)
        if (!isSameOwner(owned.owner, owner)) throw new Error('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
        return owned
      } catch (error) {
        if (error instanceof Error && error.message === 'CANVAS_WORKFLOW_RUN_NOT_FOUND') return null
        throw error
      }
    },

    listPage(target, options = {}) {
      const limit = options.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WORKFLOW_RUN_PAGE_SIZE) {
        throw new Error('CANVAS_WORKFLOW_RUN_PAGE_LIMIT_INVALID')
      }
      const cursor = parseCursor(options.cursor)
      const runDirectory = directory(target)
      if (!existsSync(runDirectory)) return { runs: [], nextCursor: null }

      /** 仍按需扫描并解析全部匹配 journal，只限制常驻的完整运行对象数量。 */
      const candidates: CanvasWorkflowRun[] = []
      const directoryHandle = opendirSync(runDirectory)
      try {
        for (;;) {
          const entry = directoryHandle.readSync()
          if (!entry) break
          if (!entry.isFile()) continue
          const match = WORKFLOW_RUN_FILE_PATTERN.exec(entry.name)
          if (!match) continue
          const run = load(target, match[1]!)
          if (options.ownerSessionId && run.owner.sessionId !== options.ownerSessionId) continue
          if (cursor && !(run.updatedAt < cursor.updatedAt
            || (run.updatedAt === cursor.updatedAt && run.id > cursor.id))) continue
          candidates.push(run)
          candidates.sort(compareWorkflowRuns)
          if (candidates.length > limit + 1) candidates.pop()
        }
      } finally {
        directoryHandle.closeSync()
      }
      const pageRuns = candidates.slice(0, limit).map((run) => structuredClone(run))
      return {
        runs: pageRuns,
        nextCursor: candidates.length > limit && pageRuns.length > 0
          ? encodeCursor(pageRuns[pageRuns.length - 1]!)
          : null,
      }
    },

    acquireLease(target, runId) {
      if (!/^[a-f0-9]{48}$/.test(runId)) throw new Error('CANVAS_WORKFLOW_RUN_ID_INVALID')
      const runDirectory = directory(target, true)
      try {
        return acquireLock(join(runDirectory, `workflow-run-${runId}.drive.lock`))
      } catch (error) {
        if (error instanceof Error && error.message === 'CANVAS_WORKFLOW_RUN_BUSY') return null
        throw error
      }
    },

    save(run, expectedRevision) {
      return dependencies.runWorkspaceWrite(run.projectId, () => {
        const target = { projectId: run.projectId, canvasId: run.canvasId }
        const runDirectory = directory(target, true)
        const release = acquireLock(join(runDirectory, `workflow-run-${run.id}.lock`))
        try {
          const current = load(target, run.id)
          if (current.revision !== expectedRevision || run.revision !== expectedRevision) {
            throw new Error('CANVAS_WORKFLOW_RUN_CONFLICT')
          }
          if (JSON.stringify(immutableCreateFacts(current)) !== JSON.stringify(immutableCreateFacts(run))) {
            throw new Error('CANVAS_WORKFLOW_RUN_IMMUTABLE')
          }
          for (const currentNode of current.nodes) {
            const nextNode = run.nodes.find((node) => node.nodeId === currentNode.nodeId)
            if (!nextNode) throw new Error('CANVAS_WORKFLOW_RUN_IMMUTABLE')
            for (const currentBinding of currentNode.inputBindings) {
              const nextBinding = nextNode.inputBindings.find((binding) => (
                binding.targetInputKey === currentBinding.targetInputKey
              ))
              if (!nextBinding
                || (currentBinding.sourceArtifactHash !== null
                  && currentBinding.sourceArtifactHash !== nextBinding.sourceArtifactHash)
                || (currentBinding.resolvedValueHash !== null
                  && currentBinding.resolvedValueHash !== nextBinding.resolvedValueHash)) {
                throw new Error('CANVAS_WORKFLOW_RUN_INPUT_IMMUTABLE')
              }
            }
          }
          const saved = parseCanvasWorkflowRun({
            ...run,
            revision: expectedRevision + 1,
            updatedAt: Math.max(now(), current.updatedAt),
          })
          writeJsonFileAtomicSecure(join(runDirectory, `workflow-run-${run.id}.json`), saved)
          return structuredClone(saved)
        } finally {
          release()
        }
      })
    },
  }
  return store
}
