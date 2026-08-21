import { randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AgentSessionMeta,
  AgentWorkspace,
  DataRootMigrationProgress,
  WorkspaceRelocationProgress,
  WorktreeInfo,
} from '@proma/shared'
import { inspectDataRootVolume, scanDataRootBytes, type DataRootVolumeSnapshot } from './data-root-storage'
import { ensureDirectoryDurable, removeFileAtomic, readJsonFileSafe, writeJsonFileAtomicSecure } from './safe-file'
import type { DurabilityResult } from './safe-file'
import {
  copyDirectoryVerified,
  finalizeDirectoryCopy,
  inspectDirectoryCopyOwnership,
  inspectDirectoryCopySpace,
  type CopyDirectoryInput,
  type CopyDirectoryResult,
  type DirectoryCopyOwnership,
  type DirectoryCopySpace,
  type FinalizeDirectoryCopyInput,
  type InspectDirectoryCopyOwnershipInput,
  type InspectDirectoryCopySpaceInput,
} from './verified-directory-copier'

/** journal 固定版本。 */
const JOURNAL_VERSION = 1
/** 活动数据根内保存项目迁移 journal 的稳定子目录。 */
const JOURNAL_DIRECTORY_NAME = 'workspace-relocations'
/** UUID 只作为数据字段和文件名，不允许任意路径片段。 */
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** 复制进度 journal 的最小持久化间隔，避免大量小文件放大主盘写入。 */
const PROGRESS_PERSIST_INTERVAL_MS = 250

/** 项目迁移持久化阶段。 */
type WorkspaceRelocationJournalStage = 'copying' | 'verifying' | 'committing' | 'failed'

/** 可恢复项目迁移 journal。 */
interface WorkspaceRelocationJournal {
  version: 1
  operationId: string
  workspaceId: string
  workspaceSlug: string
  sourceRoot: string
  targetRoot: string
  stage: WorkspaceRelocationJournalStage
  completedBytes: number
  totalBytes: number
  currentRelativePath?: string
  error?: string
  /** 固定提交顺序中已确认落盘的步骤数，取值 0..3。 */
  completedCommitSteps: number
}

/** 项目迁移预检结果。 */
export interface WorkspaceRelocationPreflight {
  operationId: string
  workspaceId: string
  workspaceSlug: string
  sourceRoot: string
  targetRoot: string
  totalBytes: number
  remainingBytes: number
  availableBytes: number
  kind: 'managed' | 'external'
}

/** 仅供锁前/锁内一致性比较的文件系统身份。 */
interface RelocationFileSystemIdentity {
  /** 所在设备编号。 */
  dev: number
  /** 同一设备内 inode/file index。 */
  ino: number
}

/** 不向 renderer 暴露的权威预检快照。 */
interface WorkspaceRelocationPreflightSnapshot extends WorkspaceRelocationPreflight {
  /** canonical 源目录的稳定身份。 */
  sourceIdentity: RelocationFileSystemIdentity
  /** 目标已存在时为目标身份，否则为最近现存祖先身份。 */
  targetBoundaryIdentity: RelocationFileSystemIdentity
  /** 预检时目标根是否已经存在。 */
  targetExisted: boolean
  /** 目标 sidecar 在本次预检中的归属。 */
  targetOwnership: DirectoryCopyOwnership
}

/** 项目迁移器的业务依赖与窄测试替身。 */
export interface WorkspaceProjectRelocatorOptions {
  /** 返回当前活动业务数据根。 */
  getConfigDir: () => string
  /** 按 ID 读取工作区索引记录。 */
  getWorkspace: (workspaceId: string) => AgentWorkspace | undefined
  /** 返回 Proma 托管项目的实际文件根。 */
  getManagedProjectRoot: (workspaceSlug: string) => string
  /** 获取工作区独占锁并返回幂等释放函数。 */
  acquireWorkspaceOperation: (workspaceId: string, kind: 'relocation') => () => void
  /** 查询 workspace generation-owned Agent 写。 */
  hasActiveAgentDataWritesForWorkspace: (workspaceId: string) => boolean
  /** 查询 workspace 真实运行中的 Automation。 */
  hasRunningAutomationForWorkspace: (workspaceId: string) => boolean
  /** 返回该工作区会话，用于 activeWorktree 硬阻断。 */
  listWorkspaceSessions: (workspaceId: string) => AgentSessionMeta[]
  /** 复用 Git 服务列出所有 worktree。 */
  listWorktrees: (sourceRoot: string) => Promise<WorktreeInfo[]>
  /** 固定提交第一步：会话引用重写。 */
  rebaseWorkspaceSessionPaths: (workspaceId: string, sourceRoot: string, targetRoot: string) => void
  /** 固定提交第二步：工作区配置引用重写。 */
  rebaseWorkspaceConfigPaths: (workspaceSlug: string, sourceRoot: string, targetRoot: string) => void
  /** 固定提交第三步：工作区索引根切换。 */
  updateAgentWorkspaceProjectRoot: (workspaceId: string, targetRoot: string) => void
  /** 可恢复流式复制器。 */
  copyDirectory?: (input: CopyDirectoryInput) => Promise<CopyDirectoryResult>
  /** 查询目标 sidecar 归属。 */
  inspectCopyOwnership?: (input: InspectDirectoryCopyOwnershipInput) => Promise<DirectoryCopyOwnership>
  /** 查询可信断点仍需写入的字节。 */
  inspectCopySpace?: (input: InspectDirectoryCopySpaceInput) => Promise<DirectoryCopySpace>
  /** 首次空目标使用的现有流式目录字节扫描。 */
  scanSourceBytes?: (sourceRoot: string, options?: { signal?: AbortSignal }) => Promise<number>
  /** 查询目标卷容量。 */
  inspectTargetVolume?: (existingTargetAncestor: string) => Promise<DataRootVolumeSnapshot>
  /** 三步提交成功后清理复制 sidecar。 */
  finalizeCopy?: (input: FinalizeDirectoryCopyInput) => Promise<void>
  /** 生成不可预测迁移 ID。 */
  createOperationId?: () => string
  /** 持久创建 journal 目录的窄测试边界。 */
  ensureJournalDirectory?: (directoryPath: string) => DurabilityResult
  /** 持久写入 journal 的窄测试边界。 */
  writeJournalFile?: (filePath: string, data: object) => DurabilityResult
  /** 持久删除 journal 的窄测试边界。 */
  removeJournalFile?: (filePath: string) => DurabilityResult
}

/** 单次预检内部允许的恢复上下文。 */
interface PreflightContext {
  operationId: string
  allowOwnedTarget: boolean
  signal?: AbortSignal
}

/** 工作区项目文件迁移与 journal 恢复协调器。 */
export class WorkspaceProjectRelocator {
  /** 当前进程内运行中的取消控制器。 */
  private readonly controllers = new Map<string, AbortController>()
  /** 从恢复预检到完成期间占用 operation，阻止并发继续或放弃。 */
  private readonly recoveryClaims = new Set<string>()
  /** 流式复制实现。 */
  private readonly copyDirectory: (input: CopyDirectoryInput) => Promise<CopyDirectoryResult>
  /** sidecar 归属检查。 */
  private readonly inspectCopyOwnership: (input: InspectDirectoryCopyOwnershipInput) => Promise<DirectoryCopyOwnership>
  /** 断点剩余空间检查。 */
  private readonly inspectCopySpace: (input: InspectDirectoryCopySpaceInput) => Promise<DirectoryCopySpace>
  /** 首次迁移源字节扫描。 */
  private readonly scanSourceBytes: (sourceRoot: string, options?: { signal?: AbortSignal }) => Promise<number>
  /** 目标卷容量检查。 */
  private readonly inspectTargetVolume: (existingTargetAncestor: string) => Promise<DataRootVolumeSnapshot>
  /** 复制 sidecar 最终清理。 */
  private readonly finalizeCopy: (input: FinalizeDirectoryCopyInput) => Promise<void>
  /** operationId 生成器。 */
  private readonly createOperationId: () => string
  /** 首次 journal 写入前持久创建目录。 */
  private readonly ensureJournalDirectory: (directoryPath: string) => DurabilityResult
  /** 每次阶段推进使用的 durable journal 写入。 */
  private readonly writeJournalFile: (filePath: string, data: object) => DurabilityResult
  /** 完成提交后使用的 durable journal 删除。 */
  private readonly removeJournalFile: (filePath: string) => DurabilityResult

  constructor(private readonly options: WorkspaceProjectRelocatorOptions) {
    this.copyDirectory = options.copyDirectory ?? copyDirectoryVerified
    this.inspectCopyOwnership = options.inspectCopyOwnership ?? inspectDirectoryCopyOwnership
    this.inspectCopySpace = options.inspectCopySpace ?? inspectDirectoryCopySpace
    this.scanSourceBytes = options.scanSourceBytes ?? (async (sourceRoot, scanOptions) => (
      await scanDataRootBytes(sourceRoot, scanOptions)
    ))
    this.inspectTargetVolume = options.inspectTargetVolume ?? inspectDataRootVolume
    this.finalizeCopy = options.finalizeCopy ?? finalizeDirectoryCopy
    this.createOperationId = options.createOperationId ?? randomUUID
    this.ensureJournalDirectory = options.ensureJournalDirectory ?? ensureDirectoryDurable
    this.writeJournalFile = options.writeJournalFile ?? writeJsonFileAtomicSecure
    this.removeJournalFile = options.removeJournalFile ?? removeFileAtomic
  }

  /** 只读执行完整迁移预检，不创建 journal 或目标数据。 */
  async preflight(input: { workspaceId: string; targetRoot: string }): Promise<WorkspaceRelocationPreflight> {
    /** 本次预检生成的候选操作 ID，正式 run 可生成自己的持久化 ID。 */
    const operationId = this.createOperationId()
    const snapshot = await this.performPreflight(input, { operationId, allowOwnedTarget: false })
    return toPublicPreflight(snapshot)
  }

  /** 运行新迁移，或复用同 workspace/源/目标的复制阶段 journal 继续复制。 */
  async run(
    input: { workspaceId: string; targetRoot: string },
    onProgress?: (progress: WorkspaceRelocationProgress) => void,
  ): Promise<WorkspaceRelocationProgress> {
    /** 已存在的复制断点只有源目标完全匹配时才允许复用。 */
    const existingJournal = this.getJournalForWorkspace(input.workspaceId)
    if (existingJournal?.stage === 'committing') {
      throw new Error('项目迁移正在提交，请通过启动恢复继续')
    }
    if (existingJournal && this.controllers.has(existingJournal.operationId)) {
      throw new Error('项目迁移正在运行，不能重复启动')
    }
    /** 新任务生成 ID；复制、校验或失败断点复用原稳定 ID 和 sidecar。 */
    const operationId = existingJournal?.operationId ?? this.createOperationId()
    /** 锁前预检尽早给出可处理错误。 */
    const initialPreflight = await this.performPreflight(input, {
      operationId,
      allowOwnedTarget: existingJournal !== null,
    })
    if (existingJournal && !journalMatchesPreflight(existingJournal, initialPreflight)) {
      throw new Error('现有项目迁移 journal 与当前源目标不一致')
    }
    /** 锁使新 Agent/Automation admission 与权威预检线性互斥。 */
    const release = this.options.acquireWorkspaceOperation(input.workspaceId, 'relocation')
    try {
      /** 锁内重跑全部安全检查，不信任锁前 preview 的可变文件系统结果。 */
      const authoritativePreflight = await this.performPreflight(input, {
        operationId,
        allowOwnedTarget: existingJournal !== null,
      })
      if (!preflightSnapshotsMatch(initialPreflight, authoritativePreflight)) {
        throw new Error('项目迁移环境在预检后发生变化，请重新预检')
      }
      if (existingJournal && !journalMatchesPreflight(existingJournal, authoritativePreflight)) {
        throw new Error('现有项目迁移 journal 与锁内权威预检不一致')
      }
      /** 异步权威预检结束后同步确认活动写仍为空。 */
      this.assertWorkspaceInactive(input.workspaceId)
      const preflight = authoritativePreflight
      /** 只有进入复制阶段后才注册可取消控制器。 */
      const controller = new AbortController()
      this.controllers.set(operationId, controller)
      /** 复制开始前持久化可恢复参数。 */
      let journal: WorkspaceRelocationJournal = existingJournal ?? {
        version: JOURNAL_VERSION,
        operationId,
        workspaceId: preflight.workspaceId,
        workspaceSlug: preflight.workspaceSlug,
        sourceRoot: preflight.sourceRoot,
        targetRoot: preflight.targetRoot,
        stage: 'copying',
        completedBytes: 0,
        totalBytes: preflight.totalBytes,
        completedCommitSteps: 0,
      }
      journal = { ...journal, stage: 'copying', error: undefined, totalBytes: preflight.totalBytes }
      this.writeJournal(journal)
      onProgress?.(toPublicProgress(journal, true))

      try {
        /** 上一次把连续字节进度写入 journal 的时刻。 */
        let lastPersistedAt = Date.now()
        /** Copier 原生进度只在此窄适配层转换为 workspace 进度。 */
        const copyResult = await this.copyDirectory({
          migrationId: operationId,
          sourceRoot: preflight.sourceRoot,
          targetRoot: preflight.targetRoot,
          signal: controller.signal,
          onProgress: (progress) => {
            journal = applyCopyProgress(journal, progress)
            /** UI 事件逐项发送，journal 仅节流持久化；失败和阶段边界仍立即写入。 */
            const currentTime = Date.now()
            if (currentTime - lastPersistedAt >= PROGRESS_PERSIST_INTERVAL_MS) {
              this.writeJournal(journal)
              lastPersistedAt = currentTime
            }
            onProgress?.(toPublicProgress(journal, true))
          },
        })
        if (copyResult.totalBytes !== preflight.totalBytes) {
          throw new Error('项目源目录容量在预检后发生变化')
        }
        journal = {
          ...journal,
          stage: 'verifying',
          completedBytes: copyResult.totalBytes,
          totalBytes: copyResult.totalBytes,
          currentRelativePath: undefined,
        }
        this.writeJournal(journal)
        onProgress?.(toPublicProgress(journal, true))
      } catch (error) {
        journal = { ...journal, stage: 'failed', error: errorMessage(error) }
        this.writeJournal(journal)
        onProgress?.(toPublicProgress(journal))
        throw error
      }

      /** 提交协议不可取消；在公开 committing 之前同步移除可取消控制器。 */
      this.controllers.delete(operationId)
      journal = { ...journal, stage: 'committing', completedCommitSteps: 0, error: undefined }
      this.writeJournal(journal)
      onProgress?.(toPublicProgress(journal))
      return await this.commitJournal(journal, onProgress)
    } finally {
      this.controllers.delete(operationId)
      release()
    }
  }

  /** 返回指定 workspace 的当前 journal 状态；完成删除后返回 null。 */
  getStatus(workspaceId: string): WorkspaceRelocationProgress | null {
    /** 当前 workspace 唯一 journal。 */
    const journal = this.getJournalForWorkspace(workspaceId)
    return journal ? toPublicProgress(journal, this.controllers.has(journal.operationId)) : null
  }

  /** 使用持久化 journal 的精确身份继续迁移，不接受 renderer 重新提供目标路径。 */
  async resume(
    input: { workspaceId: string; operationId: string },
    onProgress?: (progress: WorkspaceRelocationProgress) => void,
  ): Promise<WorkspaceRelocationProgress> {
    const journal = this.requireRecoveryJournal(input)
    if (journal.stage === 'committing') throw new Error('项目迁移正在提交，请通过启动恢复继续')
    if (this.controllers.has(journal.operationId) || this.recoveryClaims.has(journal.operationId)) {
      throw new Error('项目迁移正在运行，不能重复继续')
    }
    this.recoveryClaims.add(journal.operationId)
    try {
      return await this.run({ workspaceId: journal.workspaceId, targetRoot: journal.targetRoot }, onProgress)
    } finally {
      this.recoveryClaims.delete(journal.operationId)
    }
  }

  /** 放弃未提交迁移，只删除 Proma sidecar 与 journal，保留源目录和已复制目标文件。 */
  async abandon(input: { workspaceId: string; operationId: string }): Promise<void> {
    const journal = this.requireRecoveryJournal(input)
    if (journal.stage === 'committing') throw new Error('项目迁移正在提交，不能放弃')
    if (this.controllers.has(journal.operationId) || this.recoveryClaims.has(journal.operationId)) {
      throw new Error('项目迁移正在运行，不能放弃')
    }
    this.recoveryClaims.add(journal.operationId)
    try {
      const ownership = await this.inspectCopyOwnership({
        migrationId: journal.operationId,
        sourceRoot: journal.sourceRoot,
        targetRoot: journal.targetRoot,
      })
      if (ownership === 'foreign' || ownership === 'invalid') throw new Error('项目迁移目标副本归属无效')
      if (ownership === 'owned') {
        await this.finalizeCopy({ migrationId: journal.operationId, targetRoot: journal.targetRoot })
      }
      this.removeJournal(journal.operationId)
    } finally {
      this.recoveryClaims.delete(journal.operationId)
    }
  }

  /** 取消当前进程内仍处于复制/校验阶段的操作。 */
  cancel(operationId: string): boolean {
    assertOperationId(operationId)
    /** 当前操作的 AbortController。 */
    const controller = this.controllers.get(operationId)
    if (!controller) return false
    controller.abort()
    return true
  }

  /** 启动时严格恢复全部 committing journal；损坏 journal 会明确阻断。 */
  async resumeCommittingJournals(
    onProgress?: (progress: WorkspaceRelocationProgress) => void,
  ): Promise<WorkspaceRelocationProgress[]> {
    /** journal 目录中经严格 schema 校验的全部任务。 */
    const journals = this.readAllJournals()
    /** 按目录稳定顺序收集完成状态。 */
    const completed: WorkspaceRelocationProgress[] = []
    for (const journal of journals) {
      if (journal.stage !== 'committing') continue
      /** 每个 workspace 独立持锁恢复，避免阻塞无关项目。 */
      const release = this.options.acquireWorkspaceOperation(journal.workspaceId, 'relocation')
      try {
        this.assertWorkspaceInactive(journal.workspaceId)
        completed.push(await this.commitJournal(journal, onProgress))
      } finally {
        release()
      }
    }
    return completed
  }

  /** 执行固定顺序三步提交，每步成功后原子推进 completedCommitSteps。 */
  private async commitJournal(
    initialJournal: WorkspaceRelocationJournal,
    onProgress?: (progress: WorkspaceRelocationProgress) => void,
  ): Promise<WorkspaceRelocationProgress> {
    /** 每一步都替换为最新落盘状态。 */
    let journal = initialJournal
    try {
      /** 初次提交与启动恢复共用同一完整性证明，任何 rebase 前必须确认副本完整。 */
      const ownership = await this.assertJournalRuntimeContext(journal)
      if (journal.completedCommitSteps === 3 && ownership === 'absent') {
        return this.completeJournal(journal, onProgress)
      }
      if (journal.completedCommitSteps < 1) {
        this.options.rebaseWorkspaceSessionPaths(journal.workspaceId, journal.sourceRoot, journal.targetRoot)
        journal = { ...journal, completedCommitSteps: 1, error: undefined }
        this.writeJournal(journal)
      }
      if (journal.completedCommitSteps < 2) {
        this.options.rebaseWorkspaceConfigPaths(journal.workspaceSlug, journal.sourceRoot, journal.targetRoot)
        journal = { ...journal, completedCommitSteps: 2, error: undefined }
        this.writeJournal(journal)
      }
      if (journal.completedCommitSteps < 3) {
        this.options.updateAgentWorkspaceProjectRoot(journal.workspaceId, journal.targetRoot)
        journal = { ...journal, completedCommitSteps: 3, error: undefined }
        this.writeJournal(journal)
      }
      await this.finalizeCopy({ migrationId: journal.operationId, targetRoot: journal.targetRoot })
      return this.completeJournal(journal, onProgress)
    } catch (error) {
      /** committing 保持可恢复，仅附加诊断；不得降级为不可自动恢复的 failed。 */
      journal = { ...journal, stage: 'committing', error: errorMessage(error) }
      this.writeJournal(journal)
      onProgress?.(toPublicProgress(journal))
      throw error
    }
  }

  /** 执行源、目标、活跃状态、worktree 和容量的完整预检。 */
  private async performPreflight(
    input: { workspaceId: string; targetRoot: string },
    context: PreflightContext,
  ): Promise<WorkspaceRelocationPreflightSnapshot> {
    assertWorkspaceId(input.workspaceId)
    assertOperationId(context.operationId)
    if (!isAbsolute(input.targetRoot)) throw new Error('项目迁移目标必须是绝对路径')
    /** 当前索引工作区。 */
    const workspace = this.options.getWorkspace(input.workspaceId)
    if (!workspace) throw new Error(`项目不存在: ${input.workspaceId}`)
    this.assertWorkspaceInactive(workspace.id)
    /** 外部项目使用索引根，托管项目使用 workspace-files 实际根。 */
    const requestedSourceRoot = workspace.projectRootPath ?? this.options.getManagedProjectRoot(workspace.slug)
    if (!isAbsolute(requestedSourceRoot)) throw new Error('项目迁移源路径必须是绝对路径')
    const sourceRoot = resolve(requestedSourceRoot)
    assertAccessibleSource(sourceRoot)
    /** canonical 源根用于物理别名和嵌套判断。 */
    const canonicalSourceRoot = realpathSync(sourceRoot)
    /** canonical 源根的稳定身份，用于锁前/锁内置换检测。 */
    const sourceIdentity = toRelocationIdentity(lstatSync(canonicalSourceRoot))
    /** linked worktree 在复制前必须由用户移除。 */
    const worktrees = await this.options.listWorktrees(canonicalSourceRoot)
    if (worktrees.some((worktree) => !worktree.isMain)) {
      throw new Error('项目存在 linked worktree，请先移除 linked worktree 后再迁移')
    }
    /** 规范化但不替用户补成绝对路径的目标。 */
    const targetRoot = resolve(input.targetRoot)
    /** 目标最近现存祖先与预计 canonical 路径。 */
    const prospectiveTarget = resolveProspectiveTarget(targetRoot)
    /** 目标是否已经存在，锁内变化必须拒绝。 */
    const targetExisted = existsSync(targetRoot)
    /** 目标或最近现存祖先的稳定身份。 */
    let targetBoundaryIdentity = toRelocationIdentity(lstatSync(prospectiveTarget.existingAncestor))
    validateRootRelationship(canonicalSourceRoot, prospectiveTarget.canonicalPath)
    /** sidecar 归属决定非空目标能否作为本次 failed journal 断点复用。 */
    const ownership = await this.inspectCopyOwnership({
      migrationId: context.operationId,
      sourceRoot: canonicalSourceRoot,
      targetRoot,
    })
    if (ownership === 'foreign' || ownership === 'invalid') throw new Error('目标副本归属无效')
    if (targetExisted) {
      /** no-follow：目标根本身不能是符号链接。 */
      const targetStat = lstatSync(targetRoot)
      if (!targetStat.isDirectory()) throw new Error('项目迁移目标必须是实际目录')
      targetBoundaryIdentity = toRelocationIdentity(targetStat)
      /** 现存目标 canonical 身份再次检查物理别名和嵌套。 */
      const canonicalTargetRoot = realpathSync(targetRoot)
      validateRootRelationship(canonicalSourceRoot, canonicalTargetRoot)
      const sourceStat = lstatSync(canonicalSourceRoot)
      const canonicalTargetStat = lstatSync(canonicalTargetRoot)
      if (sourceStat.dev === canonicalTargetStat.dev && sourceStat.ino === canonicalTargetStat.ino) {
        throw new Error('项目迁移源与目标是同一物理目录')
      }
      if (readdirSync(targetRoot).length > 0 && !(context.allowOwnedTarget && ownership === 'owned')) {
        throw new Error('项目迁移目标首次使用时必须为空')
      }
    }
    accessSync(prospectiveTarget.existingAncestor, constants.W_OK | constants.X_OK)
    throwIfAborted(context.signal)

    /** 首次空目标扫描总量；可信断点由 copier 精确报告剩余量。 */
    let totalBytes: number
    /** 当前目标卷实际仍需写入的字节。 */
    let remainingBytes: number
    if (ownership === 'owned') {
      const copySpace = await this.inspectCopySpace({
        migrationId: context.operationId,
        sourceRoot: canonicalSourceRoot,
        targetRoot,
        signal: context.signal,
      })
      assertCopySpace(copySpace)
      totalBytes = copySpace.totalBytes
      remainingBytes = copySpace.remainingBytes
    } else {
      totalBytes = await this.scanSourceBytes(canonicalSourceRoot, { signal: context.signal })
      assertSafeByteCount(totalBytes, '项目源目录字节数无效')
      remainingBytes = totalBytes
    }
    throwIfAborted(context.signal)
    /** 容量查询使用目标最近现存祖先所在卷。 */
    const volume = await this.inspectTargetVolume(prospectiveTarget.existingAncestor)
    if (volume.availableBytes === undefined) throw new Error('无法读取目标磁盘可用空间')
    assertSafeByteCount(volume.availableBytes, '目标磁盘可用空间无效')
    if (volume.availableBytes < remainingBytes) throw new Error('目标磁盘可用空间不足')
    return {
      operationId: context.operationId,
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      sourceRoot: canonicalSourceRoot,
      targetRoot,
      totalBytes,
      remainingBytes,
      availableBytes: volume.availableBytes,
      kind: workspace.projectRootPath ? 'external' : 'managed',
      sourceIdentity,
      targetBoundaryIdentity,
      targetExisted,
      targetOwnership: ownership,
    }
  }

  /** 锁前和锁后都同步检查三类工作区活动写。 */
  private assertWorkspaceInactive(workspaceId: string): void {
    if (this.options.hasActiveAgentDataWritesForWorkspace(workspaceId)) {
      throw new Error('项目仍有 Agent 正在运行，无法迁移')
    }
    if (this.options.hasRunningAutomationForWorkspace(workspaceId)) {
      throw new Error('项目仍有 Automation 正在运行，无法迁移')
    }
    if (this.options.listWorkspaceSessions(workspaceId).some((session) => session.activeWorktree?.path)) {
      throw new Error('项目仍有 activeWorktree 会话，请先结束 worktree 会话')
    }
  }

  /** 校验恢复 journal 仍属于当前工作区和现存目标。 */
  private async assertJournalRuntimeContext(journal: WorkspaceRelocationJournal): Promise<DirectoryCopyOwnership> {
    /** 当前工作区必须保持相同 slug，索引根允许处于 source 或已切到 target。 */
    const workspace = this.options.getWorkspace(journal.workspaceId)
    if (!workspace || workspace.slug !== journal.workspaceSlug) throw new Error('项目迁移 journal 的工作区身份无效')
    /** 第三步可能已经执行但 journal 还没推进，故允许当前索引已指向 target。 */
    const requestedCurrentRoot = workspace.projectRootPath ?? this.options.getManagedProjectRoot(workspace.slug)
    if (!isAbsolute(requestedCurrentRoot)) throw new Error('项目迁移 journal 的当前项目根不是绝对路径')
    const currentRoot = resolve(requestedCurrentRoot)
    if (!pathsReferToSameDirectory(currentRoot, journal.sourceRoot)
      && !pathsReferToSameDirectory(currentRoot, journal.targetRoot)) {
      throw new Error('项目迁移 journal 与当前项目根不一致')
    }
    if (!existsSync(journal.sourceRoot) || !existsSync(journal.targetRoot)) {
      throw new Error('项目迁移 journal 的源或目标目录不存在')
    }
    /** journal 根在恢复时仍必须是 no-follow 实际目录。 */
    const sourceStat = lstatSync(journal.sourceRoot)
    const targetStat = lstatSync(journal.targetRoot)
    if (!sourceStat.isDirectory() || !targetStat.isDirectory()) {
      throw new Error('项目迁移 journal 的源或目标不是实际目录')
    }
    /** 重新解析物理路径，阻断崩溃后目录置换、别名或嵌套。 */
    const canonicalSourceRoot = realpathSync(journal.sourceRoot)
    const canonicalTargetRoot = realpathSync(journal.targetRoot)
    validateRootRelationship(canonicalSourceRoot, canonicalTargetRoot)
    if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) {
      throw new Error('项目迁移 journal 的源与目标是同一物理目录')
    }
    /** 第三步完成前必须仍持有可信 sidecar；第三步后允许 finalize 已成功但 journal 尚未删除。 */
    const ownership = await this.inspectCopyOwnership({
      migrationId: journal.operationId,
      sourceRoot: journal.sourceRoot,
      targetRoot: journal.targetRoot,
    })
    if (ownership === 'foreign' || ownership === 'invalid'
      || (journal.completedCommitSteps < 3 && ownership !== 'owned')) {
      throw new Error('项目迁移 journal 的目标副本归属无效')
    }
    if (ownership === 'owned') {
      /** sidecar 仍在时必须重新哈希/盘点，防止目标在崩溃窗口被删改。 */
      const copySpace = await this.inspectCopySpace({
        migrationId: journal.operationId,
        sourceRoot: journal.sourceRoot,
        targetRoot: journal.targetRoot,
      })
      assertCopySpace(copySpace)
      if (copySpace.remainingBytes !== 0 || copySpace.totalBytes !== journal.totalBytes) {
        throw new Error('项目迁移目标副本不完整，拒绝提交')
      }
    }
    return ownership
  }

  /** 删除已完成 journal 并发送仅存在于内存中的 completed 事件。 */
  private completeJournal(
    journal: WorkspaceRelocationJournal,
    onProgress?: (progress: WorkspaceRelocationProgress) => void,
  ): WorkspaceRelocationProgress {
    /** journal 主文件和 safe-file 恢复候选一并安全删除。 */
    this.removeJournal(journal.operationId)
    const completed: WorkspaceRelocationProgress = {
      operationId: journal.operationId,
      workspaceId: journal.workspaceId,
      stage: 'completed',
      completedBytes: journal.totalBytes,
      totalBytes: journal.totalBytes,
    }
    onProgress?.(completed)
    return completed
  }

  /** 返回 workspace 唯一 journal，重复 journal 明确失败。 */
  private getJournalForWorkspace(workspaceId: string): WorkspaceRelocationJournal | null {
    assertWorkspaceId(workspaceId)
    /** 属于指定 workspace 的全部严格 journal。 */
    const matches = this.readAllJournals().filter((journal) => journal.workspaceId === workspaceId)
    if (matches.length > 1) throw new Error(`workspace 存在多个项目迁移 journal: ${workspaceId}`)
    return matches[0] ?? null
  }

  /** 按 workspace 与 operation 双重匹配恢复 journal，拒绝陈旧界面操作。 */
  private requireRecoveryJournal(input: { workspaceId: string; operationId: string }): WorkspaceRelocationJournal {
    assertWorkspaceId(input.workspaceId)
    assertOperationId(input.operationId)
    const journal = this.getJournalForWorkspace(input.workspaceId)
    if (!journal || journal.operationId !== input.operationId) throw new Error('项目迁移恢复状态已失效')
    return journal
  }

  /** 严格读取 journal 目录；任一损坏或非法文件名都阻断恢复。 */
  private readAllJournals(): WorkspaceRelocationJournal[] {
    /** 活动数据根下的稳定 journal 目录。 */
    const journalDirectory = this.getJournalDirectory()
    if (!existsSync(journalDirectory)) return []
    /** 只接受主 journal 文件；safe-file 的 tmp/bak/deleted 候选不作为独立任务。 */
    const journalNames = readdirSync(journalDirectory).filter((name) => name.endsWith('.json')).sort()
    /** 完成严格校验的 journal。 */
    const journals: WorkspaceRelocationJournal[] = []
    for (const journalName of journalNames) {
      /** 文件名必须严格等于 operationId.json。 */
      const operationId = journalName.slice(0, -'.json'.length)
      if (!OPERATION_ID_PATTERN.test(operationId)) throw new Error(`项目迁移 journal 文件名无效: ${journalName}`)
      /** safe-file 可恢复读取后的严格 schema。 */
      const journal = readJsonFileSafe<WorkspaceRelocationJournal>(join(journalDirectory, journalName), {
        validate: isWorkspaceRelocationJournal,
      })
      if (!journal || journal.operationId !== operationId) throw new Error(`项目迁移 journal 损坏: ${journalName}`)
      journals.push(journal)
    }
    return journals
  }

  /** 使用 safe-file 原子写入 journal。 */
  private writeJournal(journal: WorkspaceRelocationJournal): void {
    if (!isWorkspaceRelocationJournal(journal)) throw new Error('拒绝写入无效项目迁移 journal')
    /** 首次写入前只创建稳定容器目录。 */
    const journalDirectory = this.getJournalDirectory()
    acknowledgeJournalDurability(this.ensureJournalDirectory(journalDirectory))
    acknowledgeJournalDurability(this.writeJournalFile(join(journalDirectory, `${journal.operationId}.json`), journal))
  }

  /** 安全删除 journal 主文件和原子恢复候选。 */
  private removeJournal(operationId: string): void {
    assertOperationId(operationId)
    /** journal 主路径。 */
    const journalPath = join(this.getJournalDirectory(), `${operationId}.json`)
    for (const candidatePath of [journalPath, `${journalPath}.tmp`, `${journalPath}.bak`]) {
      acknowledgeJournalDurability(this.removeJournalFile(candidatePath))
    }
  }

  /** 返回活动数据根内的稳定 journal 目录。 */
  private getJournalDirectory(): string {
    /** getConfigDir 必须返回规范绝对活动根，禁止相对路径改变 journal 所有权。 */
    const configDir = this.options.getConfigDir()
    if (!isAbsolute(configDir) || resolve(configDir) !== configDir) throw new Error('活动数据根路径无效')
    return join(configDir, JOURNAL_DIRECTORY_NAME)
  }
}

/** 显式接受平台实际达到的 journal durability，拒绝未知注入结果。 */
function acknowledgeJournalDurability(result: DurabilityResult): void {
  if (result === 'directory' || result === 'file-only') return
  throw new Error('项目迁移 journal durability 结果无效')
}

/** 将内部权威快照转换为 renderer 可见的稳定预检合同。 */
function toPublicPreflight(snapshot: WorkspaceRelocationPreflightSnapshot): WorkspaceRelocationPreflight {
  return {
    operationId: snapshot.operationId,
    workspaceId: snapshot.workspaceId,
    workspaceSlug: snapshot.workspaceSlug,
    sourceRoot: snapshot.sourceRoot,
    targetRoot: snapshot.targetRoot,
    totalBytes: snapshot.totalBytes,
    remainingBytes: snapshot.remainingBytes,
    availableBytes: snapshot.availableBytes,
    kind: snapshot.kind,
  }
}

/** 提取目录状态中用于置换检测的稳定身份。 */
function toRelocationIdentity(stat: Stats): RelocationFileSystemIdentity {
  return { dev: stat.dev, ino: stat.ino }
}

/** 比较两个文件系统身份是否指向同一对象。 */
function relocationIdentitiesMatch(
  left: RelocationFileSystemIdentity,
  right: RelocationFileSystemIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** 锁前 preview 与锁内权威快照只有安全相关状态完全一致时才可继续。 */
function preflightSnapshotsMatch(
  initial: WorkspaceRelocationPreflightSnapshot,
  authoritative: WorkspaceRelocationPreflightSnapshot,
): boolean {
  return initial.operationId === authoritative.operationId
    && initial.workspaceId === authoritative.workspaceId
    && initial.workspaceSlug === authoritative.workspaceSlug
    && initial.sourceRoot === authoritative.sourceRoot
    && initial.targetRoot === authoritative.targetRoot
    && initial.totalBytes === authoritative.totalBytes
    && initial.remainingBytes === authoritative.remainingBytes
    && initial.kind === authoritative.kind
    && initial.targetExisted === authoritative.targetExisted
    && initial.targetOwnership === authoritative.targetOwnership
    && relocationIdentitiesMatch(initial.sourceIdentity, authoritative.sourceIdentity)
    && relocationIdentitiesMatch(initial.targetBoundaryIdentity, authoritative.targetBoundaryIdentity)
}

/** 将 copier 原生进度映射到 journal。 */
function applyCopyProgress(
  journal: WorkspaceRelocationJournal,
  progress: DataRootMigrationProgress,
): WorkspaceRelocationJournal {
  if (progress.migrationId !== journal.operationId) throw new Error('复制进度 operationId 不一致')
  /** workspace 只公开 copying/verifying 两类 copier 阶段。 */
  const stage: WorkspaceRelocationJournalStage = progress.stage === 'verifying' ? 'verifying' : 'copying'
  return {
    ...journal,
    stage,
    completedBytes: progress.completedBytes,
    totalBytes: progress.totalBytes,
    currentRelativePath: progress.currentRelativePath,
  }
}

/** 将持久化 journal 转换为共享进度合同。 */
function toPublicProgress(journal: WorkspaceRelocationJournal, active = false): WorkspaceRelocationProgress {
  return {
    operationId: journal.operationId,
    workspaceId: journal.workspaceId,
    stage: journal.stage,
    completedBytes: journal.completedBytes,
    totalBytes: journal.totalBytes,
    active,
    ...(journal.currentRelativePath === undefined ? {} : { currentRelativePath: journal.currentRelativePath }),
    ...(journal.error === undefined ? {} : { error: journal.error }),
  }
}

/** 严格校验 journal 的运行时 schema 与路径边界。 */
function isWorkspaceRelocationJournal(value: unknown): value is WorkspaceRelocationJournal {
  if (!isRecord(value)) return false
  /** 只接受当前版本定义的精确字段集，避免未知状态被旧代码静默解释。 */
  const allowedFields = new Set([
    'version',
    'operationId',
    'workspaceId',
    'workspaceSlug',
    'sourceRoot',
    'targetRoot',
    'stage',
    'completedBytes',
    'totalBytes',
    'currentRelativePath',
    'error',
    'completedCommitSteps',
  ])
  if (Object.keys(value).some((field) => !allowedFields.has(field))) return false
  const requiredFields = [
    'version',
    'operationId',
    'workspaceId',
    'workspaceSlug',
    'sourceRoot',
    'targetRoot',
    'stage',
    'completedBytes',
    'totalBytes',
    'completedCommitSteps',
  ]
  if (requiredFields.some((field) => !Object.hasOwn(value, field))) return false
  if (value.version !== JOURNAL_VERSION) return false
  if (typeof value.operationId !== 'string' || !OPERATION_ID_PATTERN.test(value.operationId)) return false
  if (typeof value.workspaceId !== 'string' || value.workspaceId.length === 0 || value.workspaceId !== value.workspaceId.trim()) return false
  if (typeof value.workspaceSlug !== 'string' || value.workspaceSlug.length === 0 || value.workspaceSlug !== value.workspaceSlug.trim()) return false
  if (!isCanonicalAbsolutePath(value.sourceRoot) || !isCanonicalAbsolutePath(value.targetRoot)) return false
  if (value.sourceRoot === value.targetRoot) return false
  if (!['copying', 'verifying', 'committing', 'failed'].includes(String(value.stage))) return false
  if (!isSafeByteCount(value.completedBytes) || !isSafeByteCount(value.totalBytes)) return false
  if (value.completedBytes > value.totalBytes) return false
  if (typeof value.completedCommitSteps !== 'number'
    || !Number.isSafeInteger(value.completedCommitSteps)
    || value.completedCommitSteps < 0
    || value.completedCommitSteps > 3) return false
  if (value.currentRelativePath !== undefined && typeof value.currentRelativePath !== 'string') return false
  if (value.error !== undefined && typeof value.error !== 'string') return false
  if (value.stage === 'copying') {
    if (value.completedCommitSteps !== 0 || value.error !== undefined) return false
  } else if (value.stage === 'verifying') {
    if (value.completedCommitSteps !== 0 || value.completedBytes !== value.totalBytes || value.error !== undefined) return false
  } else if (value.stage === 'failed') {
    if (value.completedCommitSteps !== 0 || typeof value.error !== 'string' || value.error.length === 0) return false
  } else if (value.stage === 'committing') {
    if (value.completedBytes !== value.totalBytes || value.currentRelativePath !== undefined) return false
  }
  try {
    validateRootRelationship(value.sourceRoot, value.targetRoot)
  } catch {
    return false
  }
  return true
}

/** 判断 unknown 是否为普通键值对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断路径是否已是规范绝对形式。 */
function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value
}

/** 校验 workspace ID。 */
function assertWorkspaceId(workspaceId: string): void {
  if (workspaceId.length === 0 || workspaceId !== workspaceId.trim()) throw new Error('工作区 ID 无效')
}

/** 校验 operation UUID。 */
function assertOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) throw new Error('项目迁移 operationId 无效')
}

/** 校验源目录存在、no-follow 为实际目录且可读取进入。 */
function assertAccessibleSource(sourceRoot: string): void {
  if (!existsSync(sourceRoot)) throw new Error('项目迁移源目录不存在')
  if (!lstatSync(sourceRoot).isDirectory()) throw new Error('项目迁移源必须是实际目录')
  accessSync(sourceRoot, constants.R_OK | constants.X_OK)
}

/** 解析缺失目标基于最近现存祖先的预计 canonical 路径。 */
function resolveProspectiveTarget(targetRoot: string): { canonicalPath: string; existingAncestor: string } {
  /** 从目标向上查找的当前候选。 */
  let current = targetRoot
  /** 最近现存祖先之后尚不存在的路径片段。 */
  const missingSegments: string[] = []
  while (!existsSync(current)) {
    /** 当前缺失叶子名称。 */
    const segment = current.slice(dirname(current).length + (dirname(current) === sep ? 0 : 1))
    if (!segment) throw new Error('无法解析项目迁移目标祖先')
    missingSegments.unshift(segment)
    /** 下一层父目录。 */
    const parent = dirname(current)
    if (parent === current) throw new Error('无法解析项目迁移目标祖先')
    current = parent
  }
  if (!lstatSync(current).isDirectory()) throw new Error('项目迁移目标祖先不是目录')
  /** 最近现存祖先的真实路径。 */
  const canonicalAncestor = realpathSync(current)
  return {
    canonicalPath: resolve(canonicalAncestor, ...missingSegments),
    existingAncestor: current,
  }
}

/** 校验两个 canonical 根不同且不互相嵌套。 */
function validateRootRelationship(sourceRoot: string, targetRoot: string): void {
  /** 目标相对源的位置。 */
  const targetRelative = relative(resolve(sourceRoot), resolve(targetRoot))
  /** 源相对目标的位置。 */
  const sourceRelative = relative(resolve(targetRoot), resolve(sourceRoot))
  if (targetRelative.length === 0) throw new Error('项目迁移源与目标相同')
  if (isDescendantRelative(targetRelative) || isDescendantRelative(sourceRelative)) {
    throw new Error('项目迁移源与目标不能互相嵌套')
  }
}

/** 判断 path.relative 结果是否表示严格后代。 */
function isDescendantRelative(relativePath: string): boolean {
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
}

/** 校验 copier 空间报告内部守恒。 */
function assertCopySpace(copySpace: DirectoryCopySpace): void {
  assertSafeByteCount(copySpace.totalBytes, '复制器总字节数无效')
  assertSafeByteCount(copySpace.reusableBytes, '复制器可复用字节数无效')
  assertSafeByteCount(copySpace.remainingBytes, '复制器剩余字节数无效')
  if (copySpace.reusableBytes + copySpace.remainingBytes !== copySpace.totalBytes) {
    throw new Error('复制器空间报告不守恒')
  }
}

/** 校验非负安全字节计数。 */
function assertSafeByteCount(value: number, message: string): void {
  if (!isSafeByteCount(value)) throw new Error(message)
}

/** 判断 unknown 是否为非负安全整数。 */
function isSafeByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 将未知异常转换为可持久化诊断。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 统一响应 AbortController 取消。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('项目迁移已取消', 'AbortError')
}

/** 判断 failed journal 是否可安全复用本次预检。 */
function journalMatchesPreflight(
  journal: WorkspaceRelocationJournal,
  preflight: WorkspaceRelocationPreflight,
): boolean {
  return journal.workspaceId === preflight.workspaceId
    && journal.workspaceSlug === preflight.workspaceSlug
    && journal.sourceRoot === preflight.sourceRoot
    && journal.targetRoot === preflight.targetRoot
    && journal.totalBytes === preflight.totalBytes
}

/** 比较两个现存目录的逻辑路径或 canonical 物理路径。 */
function pathsReferToSameDirectory(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) return true
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}
