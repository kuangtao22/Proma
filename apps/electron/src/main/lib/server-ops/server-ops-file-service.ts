import { createHash, randomUUID } from 'node:crypto'
import {
  isServerOpsId,
  parseServerOpsFileCancelInput,
  parseServerOpsFileCandidate,
  parseServerOpsFileCommitInput,
  parseServerOpsFileListInput,
  parseServerOpsFileListResult,
  parseServerOpsFileMutationInput,
  parseServerOpsFileMutationResult,
  parseServerOpsFilePreviewInput,
  parseServerOpsFilePreviewResult,
} from '@proma/shared'
import type {
  ServerOpsAuditAppendInput,
  ServerOpsAuditOperation,
  ServerOpsFileCancelInput,
  ServerOpsFileCandidate,
  ServerOpsFileCommitInput,
  ServerOpsFileListInput,
  ServerOpsFileListResult,
  ServerOpsFileMutationInput,
  ServerOpsFileMutationResult,
  ServerOpsFilePreviewInput,
  ServerOpsFilePreviewResult,
  ServerOpsHost,
} from '@proma/shared'
import { ServerOpsSftpRuntimeError } from '../../../utility/server-ops/server-ops-sftp-runtime'
import type { ServerOpsSftpCall } from './server-ops-runtime-client'
import type { ServerOpsSftpResult, ServerOpsSftpStat } from '../../../utility/server-ops/server-ops-sftp-runtime'
import type { ServerOpsActiveConnectionIdentity } from './server-ops-connection-service'

const FILE_OPERATION_DEADLINE_MS = 15_000
const FILE_MUTATION_DEADLINE_MS = 30_000
const FILE_CANDIDATE_TTL_MS = 300_000

export interface ServerOpsFileServiceDependencies {
  hosts: { get(hostId: string): Pick<ServerOpsHost, 'id' | 'name'> | undefined }
  connections: {
    getActiveIdentity(hostId: string): ServerOpsActiveConnectionIdentity
    sftp(input: ServerOpsSftpCall): Promise<ServerOpsSftpResult>
    closeSftpOwner(ownerKey: string): void | Promise<void>
  }
  audit: {
    append(input: ServerOpsAuditAppendInput): unknown
    prepareForWrites?: () => Promise<void>
  }
  now?: () => number
  uuid?: () => string
}

interface OwnedFileCandidate {
  ownerId: number | string
  ownerKey: string
  identity: ServerOpsActiveConnectionIdentity
  mutation: ServerOpsFileMutationInput
  sourceStat?: ServerOpsSftpStat
  view: ServerOpsFileCandidate
  timer: ReturnType<typeof setTimeout>
}

/** 编排文件浏览、预览和逐次确认变更，不接收 Renderer 提供的 owner 或 connection。 */
export class ServerOpsFileService {
  private readonly candidates = new Map<string, OwnedFileCandidate>()
  /** owner 关闭时递增代次，用于拒绝 stat 返回后的迟到候选。 */
  private readonly ownerVersions = new Map<string, number>()
  private readonly now: () => number
  private readonly uuid: () => string

  constructor(private readonly dependencies: ServerOpsFileServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.uuid = dependencies.uuid ?? randomUUID
  }

  /** 在当前连接上读取一页目录并转换为严格公开 DTO。 */
  async list(ownerKey: string, input: ServerOpsFileListInput): Promise<ServerOpsFileListResult> {
    const parsed = parseServerOpsFileListInput(input)
    const identity = this.requireIdentity(parsed.hostId)
    const result = await this.call(identity, {
      type: 'list', input: { ownerKey: requireOwnerKey(ownerKey), deadlineAt: this.now() + FILE_OPERATION_DEADLINE_MS, path: parsed.path, ...(parsed.cursor ? { cursorId: parsed.cursor } : {}) },
    })
    if (result.type !== 'list') throw new Error('SERVER_OPS_FILE_RESULT_INVALID')
    return parseServerOpsFileListResult({ hostId: parsed.hostId, path: result.result.path, entries: result.result.entries.map(toPublicEntry),
      ...(result.result.cursorId ? { cursor: result.result.cursorId } : {}), ...(result.result.truncatedReason ? { truncatedReason: result.result.truncatedReason } : {}) })
  }

  /** 读取有界文件预览，符号链接只显示目标而不跟随。 */
  async preview(ownerKey: string, input: ServerOpsFilePreviewInput): Promise<ServerOpsFilePreviewResult> {
    const parsed = parseServerOpsFilePreviewInput(input)
    const identity = this.requireIdentity(parsed.hostId)
    const result = await this.call(identity, { type: 'preview', input: { ownerKey: requireOwnerKey(ownerKey), deadlineAt: this.now() + FILE_OPERATION_DEADLINE_MS, path: parsed.path } })
    if (result.type !== 'preview') throw new Error('SERVER_OPS_FILE_RESULT_INVALID')
    const preview = result.result
    const stat = toPublicStat(preview.stat)
    if (preview.kind === 'text') return parseServerOpsFilePreviewResult({ hostId: parsed.hostId, path: preview.path, kind: 'text', content: preview.content, bytesRead: preview.bytesRead, hash: preview.hash, stat, editToken: { ...stat, path: preview.editFacts.path, hash: preview.editFacts.hash } })
    if (preview.kind === 'binary') return parseServerOpsFilePreviewResult({ hostId: parsed.hostId, path: preview.path, kind: 'binary', bytesRead: preview.bytesRead, hash: preview.hash, stat })
    if (preview.kind === 'symlink') return parseServerOpsFilePreviewResult({ hostId: parsed.hostId, path: preview.path, kind: 'symlink', bytesRead: 0, target: preview.target, stat })
    return parseServerOpsFilePreviewResult({ hostId: parsed.hostId, path: preview.path, kind: 'too-large', bytesRead: 0, stat })
  }

  /** 签发五分钟候选；准备阶段只读 source stat，不执行远程变更。 */
  async prepare(ownerId: number | string, ownerKey: string, input: ServerOpsFileMutationInput): Promise<ServerOpsFileCandidate> {
    assertOwnerId(ownerId)
    const parsed = parseServerOpsFileMutationInput(input)
    const identity = this.requireIdentity(parsed.hostId)
    const host = this.requireHost(parsed.hostId)
    const stableOwnerKey = requireOwnerKey(ownerKey)
    const ownerVersion = this.ownerVersions.get(stableOwnerKey) ?? 0
    let sourceStat: ServerOpsSftpStat | undefined
    if (parsed.action === 'rename' || parsed.action === 'delete' || parsed.action === 'save') {
      const result = await this.call(identity, { type: 'stat', input: { ownerKey: stableOwnerKey, deadlineAt: this.now() + FILE_OPERATION_DEADLINE_MS, path: parsed.path } })
      if (result.type !== 'stat') throw new Error('SERVER_OPS_FILE_RESULT_INVALID')
      sourceStat = result.result
      if (parsed.action === 'delete' && sourceStat.kind !== parsed.targetKind) throw new Error('SERVER_OPS_FILE_TARGET_CHANGED')
      if (parsed.action === 'save' && sourceStat.kind !== 'file') throw new Error('SERVER_OPS_FILE_TARGET_CHANGED')
    }
    if ((this.ownerVersions.get(stableOwnerKey) ?? 0) !== ownerVersion) throw new Error('SERVER_OPS_FILE_OWNER_CLOSED')
    for (const candidate of [...this.candidates.values()]) {
      if (candidate.ownerId === ownerId && candidate.ownerKey === stableOwnerKey && candidate.mutation.hostId === parsed.hostId && candidate.mutation.path === parsed.path) this.removeCandidate(candidate.view.candidateId)
    }
    if (this.candidates.size >= 256) throw new Error('SERVER_OPS_FILE_BUSY')
    const candidateId = this.uuid()
    const view = parseServerOpsFileCandidate({ candidateId, hostId: host.id, hostName: host.name, action: parsed.action, path: parsed.path,
      ...(parsed.action === 'rename' ? { destinationPath: parsed.destinationPath } : {}),
      ...(parsed.action === 'delete' ? { targetKind: parsed.targetKind } : {}), expiresAt: this.now() + FILE_CANDIDATE_TTL_MS })
    const timer = setTimeout(() => this.removeCandidate(candidateId), FILE_CANDIDATE_TTL_MS)
    timer.unref?.()
    this.candidates.set(candidateId, { ownerId, ownerKey: stableOwnerKey, identity, mutation: parsed, sourceStat, view, timer })
    return parseServerOpsFileCandidate(view)
  }

  /** 提交已确认候选一次；任何终态都会消费候选，未知结果不会自动重放。 */
  async commit(ownerId: number, ownerKey: string, input: ServerOpsFileCommitInput): Promise<ServerOpsFileMutationResult> {
    return await this.commitOwned(ownerId, ownerKey, input, () => undefined)
  }

  /** 已获 Pi 逐次审批的 Agent 复用同一候选和提交内核，并记录真实会话归属。 */
  async mutateForAgent(
    sessionId: string,
    input: ServerOpsFileMutationInput,
    assertAuthorized: () => void,
  ): Promise<ServerOpsFileMutationResult> {
    if (!isServerOpsId(sessionId)) throw new Error('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
    assertAuthorized()
    const ownerId = `agent:${sessionId}`
    const ownerKey = `agent-file:${sessionId}:${this.uuid()}`
    try {
      const candidate = await this.prepare(ownerId, ownerKey, input)
      assertAuthorized()
      return await this.commitOwned(ownerId, ownerKey, {
        hostId: candidate.hostId,
        candidateId: candidate.candidateId,
        confirmationName: candidate.hostName,
      }, assertAuthorized)
    } finally {
      void this.closeOwner(ownerId, ownerKey).catch(() => undefined)
    }
  }

  /** 提交已确认候选一次；审计恢复等待后重新验证审批事实再执行远程写入。 */
  private async commitOwned(
    ownerId: number | string,
    ownerKey: string,
    input: ServerOpsFileCommitInput,
    assertAuthorized: () => void,
  ): Promise<ServerOpsFileMutationResult> {
    assertOwnerId(ownerId)
    const parsed = parseServerOpsFileCommitInput(input)
    const candidate = this.requireCandidate(ownerId, requireOwnerKey(ownerKey), parsed)
    if (parsed.confirmationName !== candidate.view.hostName) throw new Error('SERVER_OPS_FILE_CONFIRMATION_MISMATCH')
    this.assertCurrentIdentity(candidate.identity)
    await this.assertSourceUnchanged(candidate)
    assertAuthorized()
    this.requireCandidate(ownerId, candidate.ownerKey, parsed)
    this.assertCurrentIdentity(candidate.identity)
    if (this.dependencies.audit.prepareForWrites) {
      await this.dependencies.audit.prepareForWrites()
      assertAuthorized()
      this.requireCandidate(ownerId, candidate.ownerKey, parsed)
      this.assertCurrentIdentity(candidate.identity)
      await this.assertSourceUnchanged(candidate)
      assertAuthorized()
    }
    const operation = mutationOperation(candidate.mutation.action)
    const operationId = this.uuid()
    const startedAt = this.now()
    const actor = typeof ownerId === 'number'
      ? { actor: 'user' as const, windowId: ownerId }
      : { actor: 'agent' as const, sessionId: ownerId.slice(6) }
    const auditBase = { ...actor, operationId, hostId: candidate.identity.hostId,
      operation, resourceType: 'remote-file' as const, resourceId: hashRemotePath(candidate.mutation.path) }
    try { this.dependencies.audit.append({ ...auditBase, phase: 'start', outcome: 'pending' }) } catch { throw new Error('SERVER_OPS_AUDIT_WRITE_FAILED') }
    this.removeCandidate(candidate.view.candidateId)
    let outcome: 'success' | 'error' | 'unknown' = 'success'
    let publicError: Error | undefined
    try {
      assertAuthorized()
      await this.executeMutation(candidate)
      assertAuthorized()
    } catch (error) {
      outcome = error instanceof ServerOpsSftpRuntimeError && error.outcome === 'unknown'
        || error instanceof Error && error.message === 'SERVER_OPS_CONNECTION_CHANGED' ? 'unknown' : 'error'
      publicError = new Error(outcome === 'unknown' ? 'SERVER_OPS_FILE_RESULT_UNKNOWN' : stableFileError(error))
    }
    let auditWarning = false
    try { this.dependencies.audit.append({ ...auditBase, phase: 'result', outcome, durationMs: Math.max(0, Math.floor(this.now() - startedAt)), ...(publicError ? { errorCode: publicError.message } : {}) }) } catch { auditWarning = true }
    if (publicError) throw publicError
    return parseServerOpsFileMutationResult({ hostId: candidate.identity.hostId, action: candidate.mutation.action, path: candidate.mutation.path, outcome: 'success', ...(auditWarning ? { warning: 'SERVER_OPS_AUDIT_WRITE_FAILED' } : {}) })
  }

  /** 取消当前窗口拥有的精确候选。 */
  cancel(ownerId: number, ownerKey: string, input: ServerOpsFileCancelInput): void {
    const parsed = parseServerOpsFileCancelInput(input)
    const candidate = this.requireCandidate(ownerId, requireOwnerKey(ownerKey), { ...parsed, confirmationName: '' }, false)
    this.removeCandidate(candidate.view.candidateId)
  }

  /** 撤销指定窗口/页面 owner 的候选和在途请求，返回远端资源清理完成的 Promise。 */
  closeOwner(ownerId: number | string, ownerKey: string): Promise<void> {
    const stableOwnerKey = requireOwnerKey(ownerKey)
    this.ownerVersions.set(stableOwnerKey, (this.ownerVersions.get(stableOwnerKey) ?? 0) + 1)
    for (const candidate of [...this.candidates.values()]) if (candidate.ownerId === ownerId && candidate.ownerKey === stableOwnerKey) this.removeCandidate(candidate.view.candidateId)
    return Promise.resolve(this.dependencies.connections.closeSftpOwner(stableOwnerKey))
  }

  /** Agent 只读调用结束后仅释放该次 SFTP owner，不需要伪造窗口 ID。 */
  releaseReader(ownerKey: string): void {
    void Promise.resolve(this.dependencies.connections.closeSftpOwner(requireOwnerKey(ownerKey))).catch(() => undefined)
  }

  /** 停止服务时释放所有候选计时器。 */
  dispose(): void { for (const candidate of [...this.candidates.values()]) this.removeCandidate(candidate.view.candidateId) }

  private async executeMutation(candidate: OwnedFileCandidate): Promise<void> {
    const common = { ownerKey: candidate.ownerKey, deadlineAt: this.now() + FILE_MUTATION_DEADLINE_MS }
    const mutation = candidate.mutation
    let result: ServerOpsSftpResult
    if (mutation.action === 'mkdir') result = await this.call(candidate.identity, { type: 'mkdir', input: { ...common, path: mutation.path } })
    else if (mutation.action === 'rename') result = await this.call(candidate.identity, { type: 'rename', input: { ...common, sourcePath: mutation.path, destinationPath: mutation.destinationPath } })
    else if (mutation.action === 'delete') result = await this.call(candidate.identity, { type: mutation.targetKind === 'directory' ? 'rmdir' : 'unlink', input: { ...common, path: mutation.path } })
    else if (mutation.action === 'save-as') result = await this.call(candidate.identity, { type: 'save-as', input: { ...common, path: mutation.path, content: mutation.content } })
    else result = await this.call(candidate.identity, { type: 'save', input: { ...common, path: mutation.path, content: mutation.content, editFacts: mutation.editToken } })
    const expectedType = mutation.action === 'delete' ? (mutation.targetKind === 'directory' ? 'rmdir' : 'unlink') : mutation.action
    if (result.type !== expectedType) throw new Error('SERVER_OPS_FILE_RESULT_INVALID')
  }

  private async assertSourceUnchanged(candidate: OwnedFileCandidate): Promise<void> {
    if (!candidate.sourceStat) return
    const result = await this.call(candidate.identity, { type: 'stat', input: { ownerKey: candidate.ownerKey, deadlineAt: this.now() + FILE_OPERATION_DEADLINE_MS, path: candidate.mutation.path } })
    if (result.type !== 'stat' || !sameStat(result.result, candidate.sourceStat)) throw new Error('SERVER_OPS_FILE_TARGET_CHANGED')
  }

  private async call(identity: ServerOpsActiveConnectionIdentity, operation: Omit<ServerOpsSftpCall, 'hostId' | 'connectionId'>): Promise<ServerOpsSftpResult> {
    const result = await this.dependencies.connections.sftp({ ...operation, hostId: identity.hostId, connectionId: identity.connectionId } as ServerOpsSftpCall)
    this.assertCurrentIdentity(identity)
    return result
  }

  private requireIdentity(hostId: string): ServerOpsActiveConnectionIdentity { try { return this.dependencies.connections.getActiveIdentity(hostId) } catch { throw new Error('SERVER_OPS_CONNECTION_CHANGED') } }
  private assertCurrentIdentity(expected: ServerOpsActiveConnectionIdentity): void {
    let current: ServerOpsActiveConnectionIdentity
    try { current = this.dependencies.connections.getActiveIdentity(expected.hostId) } catch { throw new Error('SERVER_OPS_CONNECTION_CHANGED') }
    if (current.connectionId !== expected.connectionId || current.generation !== expected.generation) throw new Error('SERVER_OPS_CONNECTION_CHANGED')
  }
  private requireHost(hostId: string): Pick<ServerOpsHost, 'id' | 'name'> { const host = this.dependencies.hosts.get(hostId); if (!host) throw new Error('SERVER_OPS_HOST_NOT_FOUND'); return host }
  private requireCandidate(ownerId: number | string, ownerKey: string, input: ServerOpsFileCommitInput, checkExpiry = true): OwnedFileCandidate {
    const candidate = this.candidates.get(input.candidateId)
    if (!candidate) throw new Error('SERVER_OPS_FILE_CANDIDATE_NOT_FOUND')
    if (candidate.ownerId !== ownerId || candidate.ownerKey !== ownerKey) throw new Error('SERVER_OPS_FILE_CANDIDATE_OWNER_MISMATCH')
    if (candidate.identity.hostId !== input.hostId) throw new Error('SERVER_OPS_FILE_CANDIDATE_HOST_MISMATCH')
    if (checkExpiry && candidate.view.expiresAt <= this.now()) { this.removeCandidate(candidate.view.candidateId); throw new Error('SERVER_OPS_FILE_CANDIDATE_EXPIRED') }
    return candidate
  }
  private removeCandidate(candidateId: string): void { const candidate = this.candidates.get(candidateId); if (!candidate) return; clearTimeout(candidate.timer); this.candidates.delete(candidateId) }
}

function toPublicStat(stat: ServerOpsSftpStat): { size: number; mtime: number; mode: number } { return { size: stat.size, mtime: stat.mtime, mode: stat.mode } }
function toPublicEntry(entry: { name: string; path: string; kind: ServerOpsSftpStat['kind']; size: number; mtime: number; mode: number }) { return { name: entry.name, path: entry.path, kind: entry.kind, size: entry.size, mtime: entry.mtime, mode: entry.mode } }
function sameStat(left: ServerOpsSftpStat, right: ServerOpsSftpStat): boolean { return left.kind === right.kind && left.size === right.size && left.mtime === right.mtime && left.mode === right.mode }
function requireOwnerKey(ownerKey: string): string { if (!ownerKey || ownerKey.length > 256) throw new Error('SERVER_OPS_FILE_OWNER_INVALID'); return ownerKey }
function assertOwnerId(ownerId: number | string): void {
  if (typeof ownerId === 'number' ? !Number.isSafeInteger(ownerId) || ownerId < 1 : !ownerId.startsWith('agent:') || !isServerOpsId(ownerId.slice(6))) {
    throw new Error('SERVER_OPS_FILE_OWNER_INVALID')
  }
}
function hashRemotePath(path: string): string { return `sha256:${createHash('sha256').update(path).digest('hex')}` }
function mutationOperation(action: ServerOpsFileMutationInput['action']): ServerOpsAuditOperation { return `file-${action}` }
function stableFileError(error: unknown): string {
  const code = error instanceof ServerOpsSftpRuntimeError ? error.code : error instanceof Error && error.message.startsWith('SERVER_OPS_') ? error.message : 'SERVER_OPS_FILE_ACTION_FAILED'
  return code === 'SERVER_OPS_CONNECTION_CHANGED' ? 'SERVER_OPS_FILE_RESULT_UNKNOWN' : code
}
