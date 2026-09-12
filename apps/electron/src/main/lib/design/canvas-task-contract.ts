import { createHash } from 'node:crypto'
import type { CanvasNode } from '@proma/shared'

/** 交付验证维度；配置保存、媒体采用和内容检查不能互相替代。 */
export type CanvasTaskValidation = 'response' | 'content' | 'configuration' | 'adopted' | 'inspection'

/** 模型依据用户语义登记的交付要求，开始后不能缩减。 */
export interface CanvasTaskRequirement {
  id: string
  description: string
  /** existing/updated 固定目标身份；created 可在节点创建后由证据确定身份。 */
  nodeId?: string
  nodeKind?: CanvasNode['kind']
  validation: CanvasTaskValidation
  /** 缺省保持旧调用兼容，按 existing 处理。 */
  change?: 'existing' | 'updated' | 'created'
}

/** Host 真实读取取得的版本证据，不接受模型直接提供 identity。 */
export interface CanvasTaskEvidence {
  canvasId: string
  nodeId: string
  nodeKind: CanvasNode['kind']
  validation: Exclude<CanvasTaskValidation, 'response'>
  identity: string
  /** 检查特定历史图像时保留任务身份，复验不得替换为当前默认图。 */
  jobId?: string
}

/** Host 已确认尚无正式产物的启动事实，不能提交为完成凭据。 */
export interface CanvasTaskAbsentArtifact extends Omit<CanvasTaskEvidence, 'identity'> {
  absent: true
}

/** 完成交付时引用 Host 签发的证据；纯文本响应直接提交正文。 */
export interface CanvasTaskSubmission {
  id: string
  evidenceId?: string
  text?: string
}

/** 预留证据引用的稳定长度；只有 record 后该引用才可用于完成检查。 */
export function describeCanvasTaskEvidence(evidence: CanvasTaskEvidence) {
  return { evidenceId: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
    nodeId: evidence.nodeId, validation: evidence.validation }
}

/** 可选任务结束检查的结构化决定，兼容普通 Agent 的默认结束路径。 */
export type CanvasTaskCompletionDecision =
  | { action: 'complete' }
  | { action: 'continue'; message: string }
  | { action: 'blocked'; message: string }

/** 每次运行独占的任务投影；持久工具记录与既有工作流继续负责恢复。 */
export interface CanvasTaskContractOptions {
  required: boolean
  verify: (evidence: CanvasTaskEvidence, signal: AbortSignal) => Promise<boolean>
  /** 调用方可在一个权威快照中核验全部证据，避免逐项核验混入不同图版本。 */
  verifyBatch?: (evidence: readonly CanvasTaskEvidence[], signal: AbortSignal) => Promise<boolean>
  /** 即使交付只有纯文本，完成和结束检查也必须复核原画布作用域。 */
  validateScope?: (canvasId: string, signal: AbortSignal) => Promise<void>
}

/** 任务启动时由 Host 捕获的节点与产物基线，仅更新/新建语义需要。 */
export interface CanvasTaskBaseline {
  nodeIds: string[]
  evidence: Array<CanvasTaskEvidence | CanvasTaskAbsentArtifact>
}

/** Host 在图片任务成功建立批次后登记的本轮候选身份，不接受模型自行声明。 */
export interface CanvasTaskGeneratedJob {
  nodeId: string
  jobId: string
}

/** 返回节点类别支持的交付验证维度。 */
function supportsValidation(
  nodeKind: CanvasNode['kind'],
  validation: Exclude<CanvasTaskValidation, 'response'>,
): boolean {
  switch (nodeKind) {
    case 'agent': return validation === 'content' || validation === 'configuration'
    case 'image': return validation === 'configuration' || validation === 'adopted' || validation === 'inspection'
    case 'audio':
    case 'video': return validation === 'configuration' || validation === 'adopted'
    case 'document':
    case 'webview': return validation === 'content'
  }
}

/** 判断两份基线输入是否完全相同，保证 start 幂等重放不能替换启动事实。 */
function isSameBaseline(
  left: CanvasTaskBaseline | undefined,
  right: CanvasTaskBaseline | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** 创建有界交付合同；仅跟踪本轮证据，不读取磁盘、不执行任务、不授予权限。 */
export function createCanvasTaskContract(options: CanvasTaskContractOptions) {
  /** 待交付范围和完成状态。 */
  let canvasId: string | undefined
  let requirements: CanvasTaskRequirement[] = []
  let submissions: CanvasTaskSubmission[] = []
  let phase: 'unplanned' | 'working' | 'completed' | 'blocked' | 'needs-input' = 'unplanned'
  let blockingReason: string | undefined
  /** 更新和新建交付使用的不可变启动基线。 */
  let baseline: CanvasTaskBaseline | undefined
  /** 固定上限控制长任务的内存；旧证据被淘汰时必须重新读取。 */
  const proofs = new Map<string, CanvasTaskEvidence>()
  /** 本合同启动后由 Host 登记的候选任务，最多保留 256 个稳定身份。 */
  const generatedJobs = new Set<string>()

  /** 返回可供模型读取的任务阶段，不暴露内部证明值。 */
  const status = () => ({
    phase, canvasId: canvasId ?? null, requirements: structuredClone(requirements),
    ...(blockingReason ? { blockingReason } : {}),
  })

  /** 逐项 fresh-read，确认本轮登记的交付仍然成立。 */
  const verifySubmissions = async (values: readonly CanvasTaskSubmission[], signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    if (values.length !== requirements.length || new Set(values.map((value) => value.id)).size !== values.length) {
      throw new Error('CANVAS_TASK_DELIVERABLES_INCOMPLETE')
    }
    /** 一份 Host 证据只能证明一项非文本交付，避免单一产物被重复计数。 */
    const evidenceIds = values.flatMap((value) => value.evidenceId ? [value.evidenceId] : [])
    if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error('CANVAS_TASK_EVIDENCE_REUSED')
    /** 完成结构校验后统一交给单快照核验入口。 */
    const verifiedProofs: CanvasTaskEvidence[] = []
    for (const requirement of requirements) {
      const value = values.find((candidate) => candidate.id === requirement.id)
      if (!value) throw new Error('CANVAS_TASK_DELIVERABLES_INCOMPLETE')
      if (requirement.validation === 'response') {
        if (!value.text?.trim() || value.text.length > 16_384 || value.evidenceId) throw new Error('CANVAS_TASK_RESPONSE_REQUIRED')
        continue
      }
      const proof = value.evidenceId ? proofs.get(value.evidenceId) : undefined
      if (!proof || value.text) throw new Error('CANVAS_TASK_EVIDENCE_REQUIRED')
      if (proof.canvasId !== canvasId || proof.validation !== requirement.validation
        || proof.nodeKind !== requirement.nodeKind) throw new Error('CANVAS_TASK_EVIDENCE_MISMATCH')
      if (requirement.nodeId && proof.nodeId !== requirement.nodeId) {
        throw new Error('CANVAS_TASK_EVIDENCE_MISMATCH')
      }
      const change = requirement.change ?? 'existing'
      if (change === 'created' && baseline?.nodeIds.includes(proof.nodeId)) {
        throw new Error('CANVAS_TASK_CREATED_TARGET_EXISTS')
      }
      if (change === 'updated') {
        const original = baseline?.evidence.find((candidate) => (
          candidate.nodeId === proof.nodeId
          && candidate.nodeKind === proof.nodeKind
          && candidate.validation === proof.validation
        ))
        if (!original) throw new Error('CANVAS_TASK_BASELINE_REQUIRED')
        if (!('absent' in original) && original.identity === proof.identity) throw new Error('CANVAS_TASK_EVIDENCE_UNCHANGED')
      }
      if (change === 'updated' && proof.validation === 'inspection') {
        if (!proof.jobId) throw new Error('CANVAS_TASK_CANDIDATE_ID_REQUIRED')
        if (!generatedJobs.has(JSON.stringify([proof.nodeId, proof.jobId]))) throw new Error('CANVAS_TASK_CANDIDATE_NOT_GENERATED')
      }
      verifiedProofs.push(proof)
    }
    if (options.verifyBatch) {
      if (!await options.verifyBatch(verifiedProofs, signal)) throw new Error('CANVAS_TASK_EVIDENCE_STALE')
      signal.throwIfAborted()
      return
    }
    for (const proof of verifiedProofs) {
      if (!await options.verify(proof, signal)) throw new Error('CANVAS_TASK_EVIDENCE_STALE')
      signal.throwIfAborted()
    }
  }

  return {
    status,
    /** 登记不可缩减的交付要求；同参数重放不重复创建任务。 */
    start(
      targetCanvasId: string,
      expected: CanvasTaskRequirement[],
      initialBaseline?: CanvasTaskBaseline,
    ) {
      /** 基线由 Host 捕获并受固定上限保护，不接受跨画布或重复节点事实。 */
      const baselineValid = initialBaseline === undefined || (
        initialBaseline.evidence.length <= 256
        && new Set(initialBaseline.nodeIds).size === initialBaseline.nodeIds.length
        && initialBaseline.nodeIds.every((nodeId) => nodeId.trim().length > 0)
        && initialBaseline.evidence.every((proof) => (
          proof.canvasId === targetCanvasId && initialBaseline.nodeIds.includes(proof.nodeId)
        ))
      )
      if (!targetCanvasId || expected.length < 1 || expected.length > 32
        || new Set(expected.map((item) => item.id)).size !== expected.length
        || expected.some((item) => !item.id.trim() || !item.description.trim()
          || (item.validation === 'response'
            ? item.nodeId !== undefined || item.nodeKind !== undefined || item.change !== undefined
            : !item.nodeKind
              || !supportsValidation(item.nodeKind, item.validation)
              || ((item.change ?? 'existing') !== 'created' && !item.nodeId?.trim())))) {
        throw new Error('CANVAS_TASK_REQUIREMENTS_INVALID')
      }
      if (!baselineValid) throw new Error('CANVAS_TASK_BASELINE_INVALID')
      for (const item of expected) {
        const change = item.change ?? 'existing'
        if ((change === 'updated' || change === 'created') && !initialBaseline) {
          throw new Error('CANVAS_TASK_BASELINE_REQUIRED')
        }
        if (change === 'updated' && !initialBaseline?.evidence.some((proof) => (
          proof.nodeId === item.nodeId
          && proof.nodeKind === item.nodeKind
          && proof.validation === item.validation
        ))) throw new Error('CANVAS_TASK_BASELINE_REQUIRED')
        if (change === 'created' && item.nodeId && initialBaseline?.nodeIds.includes(item.nodeId)) {
          throw new Error('CANVAS_TASK_CREATED_TARGET_EXISTS')
        }
      }
      if (canvasId !== undefined) {
        if (canvasId !== targetCanvasId || JSON.stringify(requirements) !== JSON.stringify(expected)
          || !isSameBaseline(baseline, initialBaseline)) {
          throw new Error('CANVAS_TASK_ALREADY_STARTED')
        }
        return status()
      }
      canvasId = targetCanvasId
      requirements = structuredClone(expected)
      baseline = initialBaseline ? structuredClone(initialBaseline) : undefined
      generatedJobs.clear()
      phase = 'working'
      blockingReason = undefined
      return status()
    },
    /** 仅由 Host 生产回执调用，登记本合同启动后的目标图片任务。 */
    recordGeneratedJobs(targetCanvasId: string, jobs: readonly CanvasTaskGeneratedJob[]) {
      if (phase !== 'working' || canvasId !== targetCanvasId) throw new Error('CANVAS_TASK_NOT_STARTED')
      if (jobs.length > 256 || jobs.some(job => !job.nodeId.trim() || !job.jobId.trim())) {
        throw new Error('CANVAS_TASK_GENERATED_JOB_INVALID')
      }
      for (const job of jobs) {
        /** 全轮最多256份来源，不能通过多次小批调用无限积累。 */
        const key = JSON.stringify([job.nodeId, job.jobId])
        generatedJobs.delete(key)
        generatedJobs.add(key)
        if (generatedJobs.size > 256) generatedJobs.delete(generatedJobs.values().next().value!)
      }
    },
    /** 只有 Provider 真实读取成功后才能签发证据；token 不构成执行授权。 */
    record(evidence: CanvasTaskEvidence) {
      const reference = describeCanvasTaskEvidence(evidence)
      const evidenceId = reference.evidenceId
      proofs.delete(evidenceId)
      proofs.set(evidenceId, structuredClone(evidence))
      if (proofs.size > 256) proofs.delete(proofs.keys().next().value!)
      return reference
    },
    /** 完成要求与当前事实核验；失败时不改变原节点或生成新任务。 */
    async complete(values: CanvasTaskSubmission[], signal: AbortSignal) {
      if (!canvasId) throw new Error('CANVAS_TASK_NOT_STARTED')
      await options.validateScope?.(canvasId, signal)
      signal.throwIfAborted()
      await verifySubmissions(values, signal)
      submissions = structuredClone(values)
      phase = 'completed'
      blockingReason = undefined
      return status()
    },
    /** 将无法在当前授权/输入内解决的原因交还调用方，不谎报完成。 */
    block(state: 'blocked' | 'needs-input', reason: string) {
      if (!reason.trim() || reason.length > 2048) throw new Error('CANVAS_TASK_BLOCK_REASON_REQUIRED')
      phase = state
      blockingReason = reason
      return status()
    },
    /** 仅对明确执行或已登记任务续行，普通问答不承担额外工具与读取。 */
    async evaluate(signal: AbortSignal): Promise<CanvasTaskCompletionDecision> {
      signal.throwIfAborted()
      if (canvasId) {
        await options.validateScope?.(canvasId, signal)
        signal.throwIfAborted()
      }
      if (phase === 'blocked' || phase === 'needs-input') return { action: 'blocked', message: blockingReason! }
      if (phase === 'unplanned' && !options.required) return { action: 'complete' }
      if (phase === 'completed') {
        try {
          await verifySubmissions(submissions, signal)
          return { action: 'complete' }
        } catch (error) {
          signal.throwIfAborted()
          if (!(error instanceof Error) || !error.message.startsWith('CANVAS_TASK_')) throw error
          phase = 'working'
          blockingReason = error.message
        }
      }
      return { action: 'continue', message: `当前 Canvas 执行任务尚未交付。使用 canvas_task 查询/登记交付要求，沿原节点和原运行身份继续；读取真实结果取得证据后 complete。若缺少必要输入或能力，用 block 报告具体原因，不能把计划说明当作完成。当前状态：${JSON.stringify(status())}` }
    },
  }
}
