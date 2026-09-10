import type {
  AgentSendInput,
  AgentSessionMeta,
  CanvasAgentTarget,
  CanvasWorkspaceSnapshot,
  SkillMeta,
} from '@proma/shared'
import type { WebContents } from 'electron'
import type { AgentRunExtensions } from '../agent-run-extensions'
import type {
  HeadlessAgentRunCallbacks,
} from '../agent-headless-runner-registry'
import type { CanvasAgentConfigStore } from './canvas-agent-config-store'
import type {
  CanvasAgentOutputCommitResult,
  CanvasAgentOutputService,
} from './canvas-agent-output-service'
import {
  resolveCanvasAgentBuiltinToolNames,
  buildCanvasAgentExecutionSystemPrompt,
  listCanvasAgentBoundInputReferences,
  requireCanvasAgentRunOwner,
} from './canvas-agent-run-policy'
import type { CanvasToolRun, CanvasToolRunContext } from './canvas-tool-provider'
import { filterCanvasAgentToolNamesForMode } from './canvas-agent-tool-policy'

/** Renderer 手动运行只接受 IPC 已严格解析的消息身份。 */
export interface CanvasRendererManualAgentExecutionRequest {
  mode: 'renderer-manual'
  target: CanvasAgentTarget
  sender: WebContents
  message: string
  userMessageUuid: string
  startedAt: number
}

/** 父 Agent 编排运行只接受 Host 捕获的父会话和取消信号。 */
export interface CanvasParentOrchestratedAgentExecutionRequest {
  mode: 'parent-orchestrated'
  target: CanvasAgentTarget
  parentSessionId: string
  /** Host 绑定的父持久工作流身份，子 Agent 不可从模型参数伪造。 */
  parentWorkflow?: { runId: string; parentSessionId: string }
  /** Provider 初检时的图版本，只能由 Host 从工具参数重建。 */
  expectedGraphRevision: number
  instruction: string
  skillNames?: string[]
  userMessageUuid: string
  startedAt: number
  signal?: AbortSignal
}

export type CanvasAgentExecutionRequest =
  | CanvasRendererManualAgentExecutionRequest
  | CanvasParentOrchestratedAgentExecutionRequest

/** 统一运行只在合法成功时携带正式输出提交结果。 */
export interface CanvasAgentExecutionResult {
  status: 'completed' | 'errored' | 'cancelled'
  output?: CanvasAgentOutputCommitResult
}

/** Renderer 运行由 Agent service 返回的主进程权威终态身份。 */
export interface CanvasAgentRendererTerminalObservation {
  status: CanvasAgentExecutionResult['status']
  sessionId: string
  startedAt?: number
  runGeneration?: number
}

/** 父运行只能停止仍与当前启动身份完全一致的活跃 child。 */
export interface CanvasAgentOwnedRunIdentity {
  sessionId: string
  startedAt: number
  runGeneration?: number
}

/** 统一执行服务的可替换进程内依赖。 */
export interface CanvasAgentExecutionServiceDependencies {
  reconcile: (target: CanvasAgentTarget) => Promise<Pick<CanvasWorkspaceSnapshot, 'document' | 'nodeIssues'>>
  prepareStart: <T>(
    target: CanvasAgentTarget,
    effect: (snapshot: Pick<CanvasWorkspaceSnapshot, 'document' | 'nodeIssues'>) => T,
  ) => Promise<T>
  /** 在最终启动临界区 fresh-read 父会话、项目授权与 Canvas binding。 */
  validateParentAccess: (input: {
    target: CanvasAgentTarget
    parentSessionId: string
    startedAt: number
  }) => void
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  configs: Pick<CanvasAgentConfigStore, 'load'>
  getWorkspaceSkills: (projectId: string) => readonly SkillMeta[]
  assertModelAvailable: (channelId: string, modelId: string) => void
  reserveStart: (sessionId: string, startedAt?: number) => () => void
  createCanvasRun: (context: CanvasToolRunContext) => CanvasToolRun | undefined
  runRenderer: (
    input: AgentSendInput,
    sender: WebContents,
    extensions: AgentRunExtensions,
    observer: (observation: CanvasAgentRendererTerminalObservation) => void,
  ) => Promise<void>
  runHeadless: (
    input: AgentSendInput,
    callbacks: HeadlessAgentRunCallbacks,
    extensions?: AgentRunExtensions,
  ) => Promise<void>
  subscribeStopped: (sessionId: string, startedAt: number, listener: () => void) => () => void
  outputs: Pick<CanvasAgentOutputService, 'commit' | 'releaseGeneration'>
  stopOwnedAgent: (identity: CanvasAgentOwnedRunIdentity) => boolean
  now?: () => number
}

export interface CanvasAgentExecutionService {
  execute: (request: CanvasAgentExecutionRequest) => Promise<CanvasAgentExecutionResult>
}

/** 将长期和本轮 Skill 名称解析为当前启用 Skill 的稳定 slug。 */
function resolveSkillSlugs(
  selectedNames: readonly string[],
  activeSkills: readonly SkillMeta[],
): string[] {
  /** 名称与 slug 都可定位同一个当前安装项，但最终只传 slug。 */
  const activeByName = new Map<string, SkillMeta>()
  for (const skill of activeSkills) {
    if (!skill.enabled) continue
    activeByName.set(skill.name, skill)
    activeByName.set(skill.slug, skill)
  }
  const slugs: string[] = []
  const seen = new Set<string>()
  for (const name of selectedNames) {
    const skill = activeByName.get(name)
    if (!skill) throw new Error(`CANVAS_AGENT_SKILL_UNAVAILABLE: ${name}`)
    if (!seen.has(skill.slug)) {
      seen.add(skill.slug)
      slugs.push(skill.slug)
    }
  }
  return slugs
}

/** 只允许主进程可信 mode 缩减工具，不接受节点配置或 Skill 提升权限。 */
function buildRunExtensions(
  mode: CanvasAgentExecutionRequest['mode'],
  prompt: string,
  canvasRun: CanvasToolRun | undefined,
): AgentRunExtensions {
  /** 即使 Provider 已按模式收缩，这里仍用同一权威策略做执行前二次复核。 */
  const canvasToolNames = filterCanvasAgentToolNamesForMode(canvasRun?.allowedToolNames ?? [], mode)
  /** 三个工具入口共享同一正向集合，避免 schema、执行器和审批列表出现权限漂移。 */
  const canvasToolNameSet = new Set(canvasToolNames)
  return {
    systemPromptAppend: [prompt, canvasRun?.systemPromptAppend]
      .filter((section): section is string => Boolean(section?.trim()))
      .join('\n\n'),
    ...(canvasRun ? { piCustomTools: canvasRun.piCustomTools.filter((tool) => canvasToolNameSet.has(tool.name)) } : {}),
    allowedToolNames: [...resolveCanvasAgentBuiltinToolNames(mode), ...canvasToolNames],
    allowedToolNamesMode: 'replace',
    readOnlyToolNames: canvasRun?.readOnlyToolNames?.filter(name => canvasToolNameSet.has(name)),
    ...(canvasRun?.evaluateCompletion ? { evaluateCompletion: canvasRun.evaluateCompletion } : {}),
    ...(canvasRun ? {
      singleApprovalToolNames: canvasRun.singleApprovalToolNames.filter((name) => canvasToolNameSet.has(name)),
      /** 只对当前 Agent 仍可调用的工具透传动态生成授权，父编排白名单不扩张。 */
      ...(canvasRun.toolApprovalPolicy ? { toolApprovalPolicy: {
        getMode: (toolName: string) => canvasToolNameSet.has(toolName)
          ? canvasRun.toolApprovalPolicy!.getMode(toolName) : 'ask' as const,
        subscribe: canvasRun.toolApprovalPolicy.subscribe,
      } } : {}),
    } : {}),
  }
}

/** 创建 Renderer 与父 Agent 共用的 Canvas Agent 可信生命周期。 */
export function createCanvasAgentExecutionService(
  dependencies: CanvasAgentExecutionServiceDependencies,
): CanvasAgentExecutionService {
  const now = dependencies.now ?? Date.now
  /** 每个节点 owner 的单调提交代次；busy 门禁保证同 owner 不并行。 */
  const generations = new Map<string, { sessionId: string; generation: number }>()
  const targetKey = (target: CanvasAgentTarget): string => `${target.projectId}\0${target.canvasId}\0${target.nodeId}`

  return {
    execute: async (request) => {
      const snapshot = await dependencies.reconcile(request.target)
      if (snapshot.nodeIssues.some((issue) => issue.nodeId === request.target.nodeId)) {
        throw new Error('CANVAS_AGENT_OWNER_INVALID')
      }
      requireCanvasAgentRunOwner({
        target: request.target,
        nodeId: request.target.nodeId,
        document: snapshot.document,
        getSession: dependencies.getSession,
      })
      const config = await dependencies.configs.load(request.target)
      const selectedSkillNames = [
        ...config.skillNames,
        ...(request.mode === 'parent-orchestrated' ? request.skillNames ?? [] : []),
      ]
      const skillSlugs = resolveSkillSlugs(selectedSkillNames, dependencies.getWorkspaceSkills(request.target.projectId))
      const key = targetKey(request.target)
      const goal = request.mode === 'renderer-manual' ? request.message : request.instruction
      /** 配置 I/O 后在图串行写边界内 fresh-read owner/输入，并把 reserve 作为最后一步同步提交。 */
      const prepared = await dependencies.prepareStart(request.target, (currentSnapshot) => {
        if (currentSnapshot.nodeIssues.some((issue) => issue.nodeId === request.target.nodeId)) {
          throw new Error('CANVAS_AGENT_OWNER_INVALID')
        }
        if (request.mode === 'parent-orchestrated') {
          if (request.parentWorkflow
            && request.parentWorkflow.parentSessionId !== request.parentSessionId) {
            throw new Error('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
          }
          if (currentSnapshot.document.revision !== request.expectedGraphRevision) {
            throw new Error('CANVAS_REVISION_CONFLICT')
          }
          dependencies.validateParentAccess({
            target: request.target,
            parentSessionId: request.parentSessionId,
            startedAt: request.startedAt,
          })
        }
        const currentOwner = requireCanvasAgentRunOwner({
          target: request.target,
          nodeId: request.target.nodeId,
          document: currentSnapshot.document,
          getSession: dependencies.getSession,
        })
        /** 显式配置必须是完整 route；继承配置每次 fresh-read 当前内部 session。 */
        const channelId = config.channelId ?? currentOwner.session.channelId
        const modelId = config.channelId === null ? currentOwner.session.modelId : config.modelId
        if (!channelId || !modelId) throw new Error('CANVAS_AGENT_MODEL_UNAVAILABLE')
        try {
          dependencies.assertModelAvailable(channelId, modelId)
        } catch (error) {
          /** 历史 session 可能绑定已停用模型；提示用户通过节点恢复面板换绑当前模型。 */
          throw new Error(
            'CANVAS_AGENT_MODEL_UNAVAILABLE: 当前 Canvas Agent 绑定的模型已失效，请打开节点并点击“重建会话”使用当前启用的模型。',
            { cause: error },
          )
        }
        const previous = generations.get(key)
        const runGeneration = previous?.sessionId === currentOwner.session.id ? previous.generation + 1 : 1
        const inputReferences = listCanvasAgentBoundInputReferences(currentSnapshot.document, currentOwner.node.id)
        const canvasRun = dependencies.createCanvasRun({
          projectId: request.target.projectId,
          sessionId: currentOwner.session.id,
          runStartedAt: request.startedAt,
          explicitReferences: inputReferences,
          permissionCeiling: currentOwner.session.permissionMode === 'plan' ? 'plan' : 'execute',
          ...(request.mode === 'renderer-manual'
            ? { dialogOwnerWebContentsId: request.sender.id }
            : {}),
          canvasAgentTarget: request.target,
          canvasAgentMode: request.mode,
          ...(request.mode === 'parent-orchestrated' && request.parentWorkflow
            ? { parentWorkflow: request.parentWorkflow }
            : {}),
        })
        const prompt = buildCanvasAgentExecutionSystemPrompt({
          mode: request.mode,
          nodeTitle: currentOwner.node.title,
          instruction: config.instruction,
          goal,
          inputReferences,
        })
        const extensions = buildRunExtensions(request.mode, prompt, canvasRun)
        const input: AgentSendInput = {
          sessionId: currentOwner.session.id,
          userMessage: goal,
          rawUserMessage: goal,
          userMessageUuid: request.userMessageUuid,
          startedAt: request.startedAt,
          channelId,
          modelId,
          workspaceId: request.target.projectId,
          mentionedSkills: skillSlugs,
          triggeredBy: request.mode === 'renderer-manual' ? 'user' : 'external',
        }
        /** reserve 与最终 owner 校验同处一个同步临界区；成功后图删除/重建由 busy 门禁阻断。 */
        const releaseStart = dependencies.reserveStart(currentOwner.session.id, request.startedAt)
        generations.set(key, { sessionId: currentOwner.session.id, generation: runGeneration })
        return { currentOwner, runGeneration, input, extensions, releaseStart }
      })
      const { currentOwner, runGeneration, input, extensions, releaseStart } = prepared
      let terminalStatus: CanvasAgentExecutionResult['status'] | undefined
      let unsubscribeStopped = (): void => undefined
      /** 终态 callback 到达即撤销父取消所有权，不能延长到正式输出提交。 */
      let ownsLiveChild = false
      const setTerminalStatus = (status: CanvasAgentExecutionResult['status']): void => {
        if (terminalStatus === undefined) terminalStatus = status
        ownsLiveChild = false
      }
      const onAbort = (): void => {
        if (request.mode !== 'parent-orchestrated' || !ownsLiveChild) return
        terminalStatus = 'cancelled'
        ownsLiveChild = false
        dependencies.stopOwnedAgent({ sessionId: currentOwner.session.id, startedAt: request.startedAt })
      }
      try {
        unsubscribeStopped = dependencies.subscribeStopped(currentOwner.session.id, request.startedAt, () => {
          setTerminalStatus('cancelled')
        })
        if (request.mode === 'parent-orchestrated') request.signal?.addEventListener('abort', onAbort, { once: true })
        if (request.mode === 'parent-orchestrated' && request.signal?.aborted) {
          terminalStatus = 'cancelled'
          return { status: 'cancelled' }
        }
        if (request.mode === 'renderer-manual') {
          await dependencies.runRenderer(input, request.sender, extensions, (observation) => {
            if (observation.sessionId !== currentOwner.session.id || observation.startedAt !== request.startedAt) return
            setTerminalStatus(observation.status)
          })
        } else {
          ownsLiveChild = true
          await dependencies.runHeadless(input, {
            source: 'design',
            originSessionId: request.parentSessionId,
            onError: () => { setTerminalStatus('errored') },
            onComplete: (_messages, terminal) => {
              /** 缺失或错代终态一律按错误处理，只有当前 run 明确成功才允许提交。 */
              if (!terminal || terminal.startedAt !== request.startedAt) {
                setTerminalStatus('errored')
                return
              }
              setTerminalStatus(terminal.status)
            },
            onTitleUpdated: () => undefined,
          }, extensions)
          ownsLiveChild = false
        }
        if (terminalStatus !== 'completed') return { status: terminalStatus ?? 'errored' }
        try {
          const output = await dependencies.outputs.commit({
            target: request.target,
            userMessageUuid: request.userMessageUuid,
            startedAt: request.startedAt,
            runGeneration,
            completedAt: now(),
            terminalStatus: 'completed',
          })
          return { status: 'completed', output }
        } catch (error) {
          if (error instanceof Error && error.message === 'CANVAS_AGENT_OUTPUT_MISSING') {
            return { status: 'errored' }
          }
          throw error
        }
      } finally {
        ownsLiveChild = false
        if (request.mode === 'parent-orchestrated') request.signal?.removeEventListener('abort', onAbort)
        unsubscribeStopped()
        releaseStart()
        dependencies.outputs.releaseGeneration({
          ...request.target,
          agentSessionId: currentOwner.session.id,
          runGeneration,
        })
        const currentGeneration = generations.get(key)
        if (currentGeneration?.sessionId === currentOwner.session.id
          && currentGeneration.generation === runGeneration) {
          generations.delete(key)
        }
      }
    },
  }
}
